/**
 * Images and credits of figure boards (docs/design/assemblies.md §11.3 to §11.6): the pre-render
 * check of the images a spec uses (presence and the embedding caps, before anything is encoded),
 * the placement node of an asset, and the credits line.
 */
import { DEFAULT_IMAGE_LIMITS } from "../../assets/prepare.js";
import type {
  AssetSource,
  Diagnostic,
  ImageAsset,
  ImageAssetResolver,
  ImageLimits,
  SvgElement,
} from "../../contracts/index.js";
import { IMAGE_DEF_TAG, unsafeSvgBody } from "../../emit/index.js";
import { h } from "../../emit/xml.js";
import { fmt } from "../../geometry/index.js";
import type { PlatformCosmoSpec, SpecPart } from "../../schema/types.gen.js";

/** Bytes of an asset's SVG body in UTF-8 (the text is embedded as is). */
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Bytes an asset adds to the document: raster as base64 text (`4 * ceil(n / 3)`), SVG as its
 * sanitized body in UTF-8. This, not the raw size, is what the §11.4 total counts.
 */
export const assetBytes = (a: ImageAsset): number =>
  a.format === "svg" ? utf8Bytes(a.svg?.body ?? "") : 4 * Math.ceil(a.data.byteLength / 3);

/** The per-file caps again, from the asset's own sizes (callers can build `ImageAsset`s by hand). */
function overCap(a: ImageAsset, limits: ImageLimits): string | undefined {
  if (a.format === "svg") {
    const n = utf8Bytes(a.svg?.body ?? "");
    return n > limits.maxSvgBytes ? `${n} bytes (SVG limit ${limits.maxSvgBytes})` : undefined;
  }
  if (a.data.byteLength > limits.maxBytes) {
    return `${a.data.byteLength} bytes (limit ${limits.maxBytes})`;
  }
  if (a.width > limits.maxDimension || a.height > limits.maxDimension) {
    return `${a.width} x ${a.height} px (limit ${limits.maxDimension} per side)`;
  }
  if (a.width * a.height > limits.maxPixels) {
    return `${a.width * a.height} pixels (limit ${limits.maxPixels})`;
  }
  return undefined;
}

/**
 * Image ids a spec uses, in first-use order: figures (base, then parts), then assembly parts
 * (billboards and decals, recursively through `parts`; a `use` template is an assembly of its
 * own, so its parts are walked there). `index` is the declaration in `images` and `at` the
 * pointer diagnostics should name: the declaration for a figure use, the first part that uses it
 * for an assembly. Ids that are not declared are left out (`validate` reports `image/unknown`).
 */
export function imageUses(spec: PlatformCosmoSpec): { id: string; index: number; at: string }[] {
  const declared = new Map<string, number>();
  (spec.images ?? []).forEach((img, i) => {
    if (!declared.has(img.id)) declared.set(img.id, i);
  });
  const out: { id: string; index: number; at: string }[] = [];
  const seen = new Set<string>();
  const add = (id: string, at: (index: number) => string): void => {
    const index = declared.get(id);
    if (index === undefined || seen.has(id)) return;
    seen.add(id);
    out.push({ id, index, at: at(index) });
  };
  for (const f of spec.figures ?? []) {
    for (const id of [f.base, ...f.parts.map((p) => p.image)]) add(id, (i) => `/images/${i}/src`);
  }
  const walk = (parts: readonly SpecPart[] | undefined, base: string): void => {
    (parts ?? []).forEach((part, j) => {
      const at = `${base}/parts/${j}`;
      const im = part.image;
      if (im !== undefined) {
        if (typeof im === "string") add(im, () => `${at}/image`);
        else add(im.ref, () => `${at}/image/ref`);
      }
      walk(part.parts, at);
    });
  };
  (spec.assemblies ?? []).forEach((a, i) => walk(a.parts, `/assemblies/${i}`));
  return out;
}

/**
 * Checks the images the figures and assemblies use against the resolver, before any asset is read, hashed or
 * encoded: every used image must be present (`image/not-found`), at most `maxImages` distinct
 * ones (`image/too-many`), and the embedded total stays under the cap (`image/too-large`, error)
 * and the warning level (`budget/images`). Cheap: sizes only, no bytes are touched.
 */
export function checkSpecImages(
  spec: PlatformCosmoSpec,
  images: ImageAssetResolver | undefined,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): Diagnostic[] {
  const uses = imageUses(spec);
  if (uses.length === 0) return [];
  const out: Diagnostic[] = [];
  let total = 0;
  const present = new Set<string>();
  for (const { id, at } of uses) {
    const a = images?.get(id);
    if (a === undefined) {
      out.push({
        severity: "error",
        code: "image/not-found",
        path: at,
        message: `Image "${id}" was not provided to the renderer`,
        suggestion:
          "Load it with the CLI (the path is relative to the spec's directory) or pass it in RenderOptions.images",
        params: { id },
      });
      continue;
    }
    const big = overCap(a, limits);
    if (big !== undefined) {
      out.push({
        severity: "error",
        code: "image/too-large",
        path: at,
        message: `Image "${id}" is too large: ${big}`,
        suggestion: "Shrink or crop the image (pcosmo assets shrink)",
        params: { id },
      });
      continue;
    }
    // User SVG: the emitter refuses unsafe bodies, so say so here, before anything renders.
    const unsafe = a.format === "svg" ? unsafeSvgBody(a.svg?.body ?? "") : undefined;
    if (unsafe !== undefined) {
      out.push({
        severity: "error",
        code: "image/format",
        path: at,
        message: `Image "${id}" is an SVG the renderer will not embed (${unsafe})`,
        suggestion:
          "Export it without scripts, links, animation or external references, or convert it to PNG",
        params: { id },
      });
      continue;
    }
    if (present.has(a.hash)) continue; // the same bytes under two ids are embedded once
    present.add(a.hash);
    total += assetBytes(a);
  }
  if (present.size > limits.maxImages) {
    out.push({
      severity: "error",
      code: "image/too-many",
      path: "/images",
      message: `The spec uses ${present.size} distinct images (limit ${limits.maxImages})`,
      suggestion: "Share sprites between parts or split the figures over several specs",
      params: { count: present.size, limit: limits.maxImages },
    });
  }
  if (total > limits.maxTotalBytes) {
    out.push({
      severity: "error",
      code: "image/too-large",
      path: "/images",
      message: `The embedded images total ${total} bytes (limit ${limits.maxTotalBytes})`,
      suggestion: "Shrink or crop the images (pcosmo assets shrink), or drop unused ones",
      params: { bytes: total, limit: limits.maxTotalBytes },
    });
  } else if (total > limits.warnTotalBytes) {
    out.push({
      severity: "warning",
      code: "budget/images",
      path: "/images",
      message: `The embedded images total ${total} bytes (budget ${limits.warnTotalBytes})`,
      suggestion: "Shrink the images to keep the SVG small",
      params: { bytes: total, budget: limits.warnTotalBytes },
    });
  }
  return out;
}

/** Number as a CSS-safe scale factor: up to 5 decimals, no exponent. */
export const scale5 = (n: number): string => String(Number(n.toFixed(5)));

/** Placeholder the emitter turns into the one `<image>`/`<symbol>` of this asset in `<defs>`. */
export const imageDef = (hash: string): SvgElement => h(IMAGE_DEF_TAG, { hash });

/**
 * `<use>` of an asset fitted to the screen rect: raster images scale from their display size
 * (the `<image>` in `<defs>` carries the EXIF transform), SVG symbols fill the rect.
 */
export function imageUse(
  href: string,
  asset: ImageAsset,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): SvgElement {
  if (asset.format === "svg") {
    return h("use", {
      href: `#${href}`,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }
  return h("use", {
    href: `#${href}`,
    transform: `translate(${fmt(rect.x)} ${fmt(rect.y)}) scale(${scale5(rect.width / asset.width)} ${scale5(rect.height / asset.height)})`,
  });
}

// ---------------------------------------------------------------------------------------------
// Credits (§11.6)
// ---------------------------------------------------------------------------------------------

const hasCredit = (s: AssetSource): boolean =>
  (s.attribution ?? "") !== "" || (s.license ?? "") !== "";

function entry(s: AssetSource, full: boolean): string {
  const head: string[] = [];
  if ((s.attribution ?? "") !== "") head.push(s.attribution as string);
  const doc = [s.document, s.page === undefined ? undefined : `p. ${s.page}`]
    .filter((x): x is string => x !== undefined && x !== "")
    .join(" ");
  if (doc !== "") head.push(doc);
  if (full && (s.figure ?? "") !== "") head.push(s.figure as string);
  let text = head.join(", ");
  if ((s.license ?? "") !== "") text += `${text === "" ? "" : " "}(${s.license})`;
  if (full && (s.url ?? "") !== "") text += `${text === "" ? "" : " "}<${s.url}>`;
  return text;
}

/**
 * The credits line: up to 3 entries that carry an attribution or a license ("Images:
 * <attribution>, <document> p. <page> (<license>)"), then "and N more". Empty when no used
 * source credits anyone.
 */
export function creditsLine(credits: readonly AssetSource[]): string {
  const credited = credits.filter(hasCredit);
  if (credited.length === 0) return "";
  const shown = credited.slice(0, 3).map((s) => entry(s, false));
  const more = credited.length - shown.length;
  return `Images: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** Every credit entry, for the SVG `<desc>` (empty without credits). */
export function creditsDesc(credits: readonly AssetSource[]): string {
  if (!credits.some(hasCredit)) return "";
  return `Images: ${credits.map((s) => entry(s, true)).join("; ")}`;
}
