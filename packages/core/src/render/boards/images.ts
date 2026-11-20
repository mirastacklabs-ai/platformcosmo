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
import { IMAGE_DEF_TAG } from "../../emit/index.js";
import { h } from "../../emit/xml.js";
import { fmt } from "../../geometry/index.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";

/** Bytes an asset adds to the document before base64 (SVG: its sanitized body). */
export const assetBytes = (a: ImageAsset): number =>
  a.format === "svg" ? (a.svg?.body.length ?? 0) : a.data.byteLength;

/**
 * Image ids the figures of a spec use, in first-use order (base, then parts), with the index of
 * their declaration in `images` (for diagnostics). Ids that are not declared are left out
 * (`validate` reports them as `image/unknown`).
 */
export function figureImageUses(spec: PlatformCosmoSpec): { id: string; index: number }[] {
  const declared = new Map<string, number>();
  (spec.images ?? []).forEach((img, i) => {
    if (!declared.has(img.id)) declared.set(img.id, i);
  });
  const out: { id: string; index: number }[] = [];
  const seen = new Set<string>();
  for (const f of spec.figures ?? []) {
    for (const id of [f.base, ...f.parts.map((p) => p.image)]) {
      const index = declared.get(id);
      if (index === undefined || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, index });
    }
  }
  return out;
}

/**
 * Checks the images the figures use against the resolver, before any asset is read, hashed or
 * encoded: every used image must be present (`image/not-found`), at most `maxImages` distinct
 * ones (`image/too-many`), and the embedded total stays under the cap (`image/too-large`, error)
 * and the warning level (`budget/images`). Cheap: sizes only, no bytes are touched.
 */
export function checkFigureImages(
  spec: PlatformCosmoSpec,
  images: ImageAssetResolver | undefined,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): Diagnostic[] {
  const uses = figureImageUses(spec);
  if (uses.length === 0) return [];
  const out: Diagnostic[] = [];
  let total = 0;
  const present = new Set<string>();
  for (const { id, index } of uses) {
    const a = images?.get(id);
    if (a === undefined) {
      out.push({
        severity: "error",
        code: "image/not-found",
        path: `/images/${index}/src`,
        message: `Image "${id}" was not provided to the renderer`,
        suggestion:
          "Load it with the CLI (the path is relative to the spec's directory) or pass it in RenderOptions.images",
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
      message: `The figures use ${present.size} distinct images (limit ${limits.maxImages})`,
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
