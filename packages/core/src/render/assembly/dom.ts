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
import { copySuffix } from "../../emit/ids.js";
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
const PALETTE = /^(palette|flow):([a-z]+)$/;

/** A validated `fill` value for a spec color; undefined when it is not a plain color. */
export function fillOf(color: SpecColor | undefined): string | undefined {
  if (color === undefined) return undefined;
  const c = String(color).toLowerCase();
  if (HEX.test(c)) return c;
  const m = PALETTE.exec(c);
  return m === null
    ? undefined
    : `var(--pc-${m[1] === "palette" ? "palette" : "flows"}-${m[2] as string})`;
}

const SHADE: Readonly<Record<string, number>> = { top: 0, left: 0.16, right: 0.3 };

/** FNV-1a, 6 hex digits: tells stud groups of different colors apart in ids. */
function hash6(s: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return x.toString(16).padStart(8, "0").slice(0, 6);
}

function facesOf(
  ctx: DomContext,
  leaf: WorldLeaf,
  half: "back" | "front" | undefined,
  copy: number,
): SvgNode[] {
  const { ids, prefix: P } = ctx;
  const sfx = copySuffix(copy);
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
  // Studs: a run of consecutive stud primitives becomes one compound path per (tone, color,
  // face), flushed where the run's first stud stood, so the primitives' painter order holds.
  type Run = { cls: string; fill?: string; face: string; tone: string; ds: string[] };
  let studs = new Map<string, Run>();
  let runs = 0;
  const flushStuds = (): void => {
    if (studs.size === 0) return;
    const kids: SvgNode[] = [];
    for (const k of [...studs.keys()].sort()) {
      const e = studs.get(k) as Run;
      const d = e.ds.join("");
      const id = `${ids.face(leaf.path, e.face as "top")}__studs-${e.tone}${
        e.fill === undefined ? "" : `-${hash6(e.fill)}`
      }${runs > 0 ? `-r${runs}` : ""}${sfx}`;
      kids.push(
        h("path", {
          id,
          class: e.cls,
          d,
          ...(e.fill === undefined ? {} : { style: `fill:${e.fill}` }),
        }),
      );
      const shade = SHADE[e.face] ?? 0;
      if (e.fill !== undefined && shade > 0) {
        kids.push(h("path", { d, fill: "#000000", "fill-opacity": shade, stroke: "none" }));
      }
    }
    out.push(h("g", null, ...kids));
    studs = new Map();
    runs++;
  };
  for (const g of groups) {
    if (half !== undefined && g.half !== half) continue;
    const prim: PartPrimitive = g.primitive;
    // `led` follows the state (CSS), never a spec color
    const fill = prim.tone === "led" ? undefined : fillOf(prim.color);
    if (prim.kind !== "stud") flushStuds();
    const kids: SvgNode[] = [];
    for (const f of g.faces) {
      const d = faceToPath(f);
      const cls = `${P}-face ${P}-p-${prim.tone}-${f.face}${prim.tone === "led" ? ` ${ids.ledClass()}` : ""}`;
      if (prim.kind === "stud") {
        const k = `${prim.tone}|${fill ?? ""}|${f.face}`;
        const e = studs.get(k);
        if (e === undefined) {
          studs.set(k, {
            cls,
            ...(fill === undefined ? {} : { fill }),
            face: f.face,
            tone: prim.tone,
            ds: [d],
          });
        } else e.ds.push(d);
        continue;
      }
      kids.push(
        h("path", {
          id: `${ids.face(leaf.path, f.face, prim.id)}${sfx}`,
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
  flushStuds();
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

/**
 * The object-like group of one item: state class, faces, images, `extra` (top-face labels, drawn
 * after the faces so they share the part's depth and wrappers), overlay. Every id of copy `k >= 1`
 * gets `__c<k>` (§9.4).
 */
export function partGroup(
  ctx: DomContext,
  leaf: WorldLeaf,
  half: "back" | "front" | undefined,
  opts: { readonly copy?: number; readonly extra?: readonly SvgNode[] } = {},
): SvgElement {
  const { ids, prefix: P } = ctx;
  const copy = opts.copy ?? 0;
  const suffix = `${half === "front" ? "__front" : ""}${copySuffix(copy)}`;
  const kids: SvgNode[] = facesOf(ctx, leaf, half, copy);
  if (half === undefined || half === "front") {
    (leaf.geometry.images ?? []).forEach((im, i) => {
      const n = imageNode(ctx, leaf, im, i);
      if (n !== undefined) kids.push(n);
    });
    kids.push(...(opts.extra ?? []));
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

/**
 * A depth copy of a part group (§9.4): a deep copy in which every `id` gets `suffix` (`__c<k>`).
 * References stay as they are: they point into `<defs>` (images, image clips), which every copy
 * shares.
 */
export function withIdSuffix(node: SvgElement, suffix: string, ctx: DomContext): SvgElement {
  let n = 0;
  const copy = (e: SvgElement): SvgElement => {
    n++;
    const id = e.attrs?.["id"];
    return {
      tag: e.tag,
      ...(e.attrs === undefined
        ? {}
        : { attrs: typeof id === "string" ? { ...e.attrs, id: `${id}${suffix}` } : e.attrs }),
      ...(e.children === undefined
        ? {}
        : {
            children: e.children.map((c) =>
              typeof c === "object" && "tag" in c ? copy(c as SvgElement) : c,
            ),
          }),
    };
  };
  const out = copy(node);
  ctx.count(n);
  return out;
}

/** Which wrappers exist and their t = 0 state (the DOM is the rest frame: defaults are omitted). */
export interface Wrappers {
  readonly host?: { readonly id: string; readonly transform?: string };
  readonly clip?: string;
  readonly motion?: { readonly id: string; readonly transform?: string };
  readonly visible?: { readonly id: string; readonly hidden: boolean };
  readonly fade?: { readonly id: string; readonly opacity: number };
}

/** The wrapper chain around `inner`, outermost first as in §9.4. Tracks decide what exists. */
export function wrap(inner: SvgElement, w: Wrappers, ctx: DomContext): SvgElement {
  let node: SvgElement = inner;
  if (w.fade !== undefined) {
    node = h(
      "g",
      { id: w.fade.id, ...(w.fade.opacity < 1 ? { opacity: w.fade.opacity } : {}) },
      node,
    );
  }
  if (w.visible !== undefined) {
    node = h(
      "g",
      { id: w.visible.id, ...(w.visible.hidden ? { visibility: "hidden" } : {}) },
      node,
    );
  }
  if (w.motion !== undefined) {
    node = h(
      "g",
      {
        id: w.motion.id,
        ...(w.motion.transform === undefined ? {} : { transform: w.motion.transform }),
      },
      node,
    );
  }
  if (w.clip !== undefined) node = h("g", { "clip-path": `url(#${w.clip})` }, node);
  if (w.host !== undefined) {
    node = h(
      "g",
      { id: w.host.id, ...(w.host.transform === undefined ? {} : { transform: w.host.transform }) },
      node,
    );
  }
  ctx.count([w.fade, w.visible, w.motion, w.clip, w.host].filter((x) => x !== undefined).length);
  return node;
}
