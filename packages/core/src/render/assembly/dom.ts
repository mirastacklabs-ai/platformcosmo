/**
 * DOM of one depth item (docs/design/assemblies.md §9.4, §11.3): the object-like part group
 * (state class, faces, images, overlay) and the wrapper chain around it
 *
 *   host > clip > motion > visible > fade > part
 *
 * (`host` and `clip` only on clipped copies; a wrapper without a track is omitted). The clip sits
 * OUTSIDE the motion group: it is static in the clipping solid's frame, so it must not travel
 * with the leaf (a clip inside the motion group would carry its clip upward and lose the visible
 * section, the regression A1-2a's z-buffer test pins).
 *
 * Emit safety: no spec string reaches an attribute here. Ids come from `ids` (escaped
 * segments); colors are validated (`#rgb`/`#rrggbb` or `palette:<a-z>`) before they become a
 * style; images are `<use>` of `#`-only references to emitter-owned `<image>`s in `<defs>`.
 */
import type {
  AssemblyIdScheme,
  Box3,
  Diagnostic,
  IdScheme,
  ImageAsset,
  ImageAssetResolver,
  PartImagePlacement,
  PartPrimitive,
  Projection,
  Rect,
  SvgElement,
  SvgNode,
} from "../../contracts/index.js";
import { unsafeSvgBody } from "../../emit/index.js";
import type { SpecColor } from "../../schema/types.gen.js";
import { h } from "../../emit/xml.js";
import {
  billboardRect,
  boxCorners,
  convexHull,
  decalPlacement,
  faceToPath,
  fmt,
  partGeometryFaces,
  partPrimitiveSilhouette,
  pointsToPath,
} from "../../geometry/index.js";
import { imageDef } from "../boards/images.js";
import type { WorldLeaf } from "./world.js";

export interface DomContext {
  readonly projection: Projection;
  readonly ids: IdScheme & AssemblyIdScheme;
  readonly prefix: string;
  readonly images: ImageAssetResolver | undefined;
  /** Assets used, by hash, first-use order (the emitter encodes them itself). */
  readonly assets: Map<string, ImageAsset>;
  /** Non-rendered definitions (`clipPath`, image placeholders), for the background layer. */
  readonly defs: SvgNode[];
  readonly diagnostics: Diagnostic[];
  /** Counts created elements. */
  count(n: number): void;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const PALETTE = /^palette:([a-z]+)$/;

/** A validated `fill` value for a spec color; undefined when it is not a plain color. */
export function fillOf(color: SpecColor | undefined): string | undefined {
  if (color === undefined) return undefined;
  const c = String(color).toLowerCase();
  if (HEX.test(c)) return c;
  const m = PALETTE.exec(c);
  return m === null ? undefined : `var(--pc-palette-${m[1] as string})`;
}

const SHADE: Readonly<Record<string, number>> = { top: 0, left: 0.16, right: 0.3 };

function facesOf(ctx: DomContext, leaf: WorldLeaf, half: "back" | "front" | undefined): SvgNode[] {
  const { ids, prefix: P } = ctx;
  const out: SvgNode[] = [];
  let groups;
  try {
    groups = partGeometryFaces(leaf.geometry, ctx.projection);
  } catch (e) {
    ctx.diagnostics.push({
      severity: "warning",
      code: "assembly/shape-params",
      path: "",
      message: `Part ${JSON.stringify(leaf.path)} could not be drawn: ${e instanceof Error ? e.message : String(e)}`,
      suggestion: "Check the part's shape, size and params",
      params: { part: leaf.path },
    });
    return out;
  }
  // Studs: one compound path per (tone, color, face) for the whole part, not one per stud.
  const studs = new Map<string, { cls: string; fill?: string; face: string; ds: string[] }>();
  for (const g of groups) {
    if (half !== undefined && g.half !== half) continue;
    const prim: PartPrimitive = g.primitive;
    const fill = fillOf(prim.color);
    const kids: SvgNode[] = [];
    for (const f of g.faces) {
      const d = faceToPath(f);
      const cls = `${P}-face ${P}-p-${prim.tone}-${f.face}${prim.tone === "led" ? ` ${ids.ledClass()}` : ""}`;
      if (prim.kind === "stud") {
        const k = `${prim.tone}|${fill ?? ""}|${f.face}`;
        const e = studs.get(k);
        if (e === undefined)
          studs.set(k, { cls, ...(fill === undefined ? {} : { fill }), face: f.face, ds: [d] });
        else e.ds.push(d);
        continue;
      }
      kids.push(
        h("path", {
          id: ids.face(leaf.path, f.face, prim.id),
          class: cls,
          d,
          ...(fill === undefined ? {} : { style: `fill:${fill}` }),
        }),
      );
      const shade = SHADE[f.face] ?? 0;
      if (fill !== undefined && shade > 0) {
        kids.push(h("path", { d, fill: "#000000", "fill-opacity": shade, stroke: "none" }));
      }
    }
    if (kids.length > 0) out.push(h("g", null, ...kids));
  }
  const sideKids: SvgNode[] = [];
  let n = 0;
  for (const k of [...studs.keys()].sort()) {
    const e = studs.get(k) as { cls: string; fill?: string; face: string; ds: string[] };
    const d = e.ds.join("");
    sideKids.push(
      h("path", {
        id: ids.face(leaf.path, e.face as "top", n === 0 ? "studs" : `studs-${n}`),
        class: e.cls,
        d,
        ...(e.fill === undefined ? {} : { style: `fill:${e.fill}` }),
      }),
    );
    const shade = SHADE[e.face] ?? 0;
    if (e.fill !== undefined && shade > 0) {
      sideKids.push(h("path", { d, fill: "#000000", "fill-opacity": shade, stroke: "none" }));
    }
    n++;
  }
  if (sideKids.length > 0) out.push(h("g", null, ...sideKids));
  return out;
}

function assetOf(ctx: DomContext, key: string, path: string): ImageAsset | undefined {
  const a = ctx.images?.get(key);
  if (a === undefined) {
    ctx.diagnostics.push({
      severity: "error",
      code: "image/not-found",
      path: "",
      message: `Image "${key}" of part "${path}" was not provided to the renderer`,
      suggestion:
        "Load it with the CLI (the path is relative to the spec's directory) or pass it in RenderOptions.images",
      params: { id: key },
    });
    return undefined;
  }
  if (a.format === "svg" && unsafeSvgBody(a.svg?.body ?? "") !== undefined) {
    ctx.diagnostics.push({
      severity: "error",
      code: "image/format",
      path: "",
      message: `Image "${key}" is an SVG the renderer will not embed`,
      suggestion: "Export it without scripts, links, animation or external references",
      params: { id: key },
    });
    return undefined;
  }
  if (!ctx.assets.has(a.hash)) {
    ctx.assets.set(a.hash, a);
    ctx.defs.push(imageDef(a.hash));
  }
  return a;
}

/** `<use>` of the asset at its natural size (raster) or scaled to it (SVG symbol). */
function useOf(ctx: DomContext, a: ImageAsset): SvgElement {
  const href = `#${ctx.ids.image(a.hash)}`;
  return a.format === "svg"
    ? h("use", { href, x: 0, y: 0, width: a.width, height: a.height })
    : h("use", { href });
}

const crop = (c: Rect): string => `${fmt(c.x)} ${fmt(c.y)} ${fmt(c.width)} ${fmt(c.height)}`;

function imageNode(
  ctx: DomContext,
  leaf: WorldLeaf,
  im: PartImagePlacement,
  n: number,
): SvgNode | undefined {
  const a = assetOf(ctx, im.image, leaf.path);
  if (a === undefined) return undefined;
  const bounds: Box3 = leaf.geometry.bounds;
  const clipId = `${ctx.ids.partClip(leaf.path, 0)}__im${n}`;
  try {
    ctx.count(3);
    if (im.face === "billboard") {
      const b = billboardRect(bounds, im.crop, im.fit, ctx.projection);
      const inner = h(
        "svg",
        {
          x: fmt(b.rect.x),
          y: fmt(b.rect.y),
          width: fmt(b.rect.width),
          height: fmt(b.rect.height),
          viewBox: crop(im.crop),
          preserveAspectRatio: "none",
        },
        useOf(ctx, a),
      );
      if (b.clip === undefined) return inner;
      ctx.defs.push(
        h(
          "clipPath",
          { id: clipId },
          h("rect", { x: b.clip.x, y: b.clip.y, width: b.clip.width, height: b.clip.height }),
        ),
      );
      return h("g", { "clip-path": `url(#${clipId})` }, inner);
    }
    const d = decalPlacement(bounds, im.face, im.crop, im.fit, ctx.projection);
    const u = d.unit;
    const g = h(
      "g",
      {
        transform: `matrix(${fmt(u.a)} ${fmt(u.b)} ${fmt(u.c)} ${fmt(u.d)} ${fmt(u.e)} ${fmt(u.f)})`,
      },
      h(
        "svg",
        { width: 1, height: 1, viewBox: crop(im.crop), preserveAspectRatio: "none" },
        useOf(ctx, a),
      ),
    );
    if (d.clip === undefined) return g;
    // `cover` overflows the face: clip to the face parallelogram, in screen space
    ctx.defs.push(
      h(
        "clipPath",
        { id: clipId },
        h("polygon", { points: d.clip.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ") }),
      ),
    );
    return h("g", { "clip-path": `url(#${clipId})` }, g);
  } catch (e) {
    ctx.diagnostics.push({
      severity: "warning",
      code: "assembly/shape-params",
      path: "",
      message: `Image on part ${JSON.stringify(leaf.path)} could not be placed: ${e instanceof Error ? e.message : String(e)}`,
      suggestion: "Check the part's size and image face",
      params: { part: leaf.path },
    });
    return undefined;
  }
}

/** The object-like group of one item: state class, faces, images, overlay. */
export function partGroup(
  ctx: DomContext,
  leaf: WorldLeaf,
  half: "back" | "front" | undefined,
): SvgElement {
  const { ids, prefix: P } = ctx;
  const suffix = half === "front" ? "__front" : "";
  const kids: SvgNode[] = facesOf(ctx, leaf, half);
  if (half === undefined || half === "front") {
    (leaf.geometry.images ?? []).forEach((im, i) => {
      const n = imageNode(ctx, leaf, im, i);
      if (n !== undefined) kids.push(n);
    });
  }
  const pts = leaf.geometry.primitives
    .filter((p) => half === undefined || halfOf2(leaf, p.id) === half)
    .flatMap((p) => {
      try {
        return [...partPrimitiveSilhouette(p, ctx.projection).points];
      } catch {
        return [];
      }
    });
  const hull = convexHull(pts);
  kids.push(
    h("path", {
      id: `${ids.overlay(leaf.path)}${suffix}`,
      class: `${P}-overlay`,
      d: hull.length > 0 ? pointsToPath(hull) : "M0 0",
    }),
  );
  ctx.count(2 + kids.length);
  return h(
    "g",
    { id: `${ids.object(leaf.path)}${suffix}`, class: ids.stateClass(leaf.node.state) },
    ...kids,
  );
}

function halfOf2(leaf: WorldLeaf, primId: string): "back" | "front" | undefined {
  const s = leaf.geometry.split;
  if (s?.back.includes(primId)) return "back";
  if (s?.front.includes(primId)) return "front";
  return undefined;
}

/** `clipPath` of a face-exit or insert clip: the hull of the projected prism, solid's rest frame. */
export function clipDef(ctx: DomContext, id: string, prism: Box3): SvgElement {
  const hull = convexHull(boxCorners(prism).map((c) => ctx.projection.project(c)));
  ctx.count(2);
  return h(
    "clipPath",
    { id },
    h("polygon", { points: hull.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ") }),
  );
}

/** Which wrappers exist (ids); the DOM is neutral, poses come from tracks or `frameAt`. */
export interface Wrappers {
  readonly host?: { readonly id: string };
  readonly clip?: string;
  readonly motion?: { readonly id: string };
  readonly visible?: { readonly id: string };
  readonly fade?: { readonly id: string };
}

/** The wrapper chain around `inner`, outermost first as in §9.4. Tracks decide what exists. */
export function wrap(inner: SvgElement, w: Wrappers, ctx: DomContext): SvgElement {
  let node: SvgElement = inner;
  if (w.fade !== undefined) node = h("g", { id: w.fade.id }, node);
  if (w.visible !== undefined) node = h("g", { id: w.visible.id }, node);
  if (w.motion !== undefined) node = h("g", { id: w.motion.id }, node);
  if (w.clip !== undefined) node = h("g", { "clip-path": `url(#${w.clip})` }, node);
  if (w.host !== undefined) node = h("g", { id: w.host.id }, node);
  ctx.count([w.fade, w.visible, w.motion, w.clip, w.host].filter((x) => x !== undefined).length);
  return node;
}
