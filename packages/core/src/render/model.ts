import type {
  Box3,
  Diagnostic,
  EdgePath,
  FontMode,
  IconResolver,
  ImageAssetResolver,
  Layer,
  ObjectAnchor,
  Rect,
  RenderModel,
  SceneEdge,
  SceneGraph,
  SceneObject,
  SvgNode,
  ThemeTokens,
  Vec2,
  Vec3,
} from "../contracts/index.js";
import { depthOrder, orderGroups } from "../depth/index.js";
import type { PlatformCosmoSpec } from "../schema/types.gen.js";
import { levelOf } from "../scene/assembly/levels.js";
import { buildAssemblyRender } from "./assembly/index.js";
import { buildBoards } from "./boards/index.js";
import { createIds, iconDef } from "../emit/index.js";
import { h } from "../emit/xml.js";
import {
  boundsOfPoints,
  createProjection,
  faceToPath,
  fmt,
  primitiveFaces,
  primitiveSilhouette,
  projectBoxBounds,
  round2,
  unionRects,
} from "../geometry/index.js";
import {
  fontAssets,
  labelFontSizeFor,
  measureText,
  missingGlyphs,
  type TextAnchor,
  type TextFamily,
} from "../text/index.js";

/** Everything `buildModel` needs; kept so `withVariant` can rebuild under another id prefix. */
export interface ModelInputs {
  readonly scene: SceneGraph;
  readonly theme: ThemeTokens;
  readonly darkTheme?: ThemeTokens;
  readonly font: FontMode;
  readonly prefix: string;
  readonly icons?: IconResolver;
  /** Schema 1.2.0: the spec and prepared images, for figure panels (the scene carries ids only). */
  readonly spec?: PlatformCosmoSpec;
  readonly images?: ImageAssetResolver;
}

export interface BuiltModel {
  readonly model: RenderModel;
  readonly diagnostics: readonly Diagnostic[];
}

const MARGIN_FOCUS = 12;
/** DC floor objects drawn flat with the ground, before edges. */
const FLOOR_TYPES: ReadonlySet<string> = new Set(["floor-grid", "perforated-tiles"]);
const CABLE_PREFIX = "\u0001cable:";
const METRIC_H = 38;
const CAPTION_H = 30;
const LEGEND_H = 22;
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

function pointsAttr(pts: readonly Vec2[]): string {
  return pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
}

function polylinePath(pts: readonly Vec2[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x)} ${fmt(p.y)}`).join("");
}

function lengthOf(pts: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec2;
    const b = pts[i] as Vec2;
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return round2(len);
}

function midpoint(pts: readonly Vec2[]): Vec2 {
  const total = lengthOf(pts);
  let walk = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec2;
    const b = pts[i] as Vec2;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (walk <= seg && seg > 0) {
      const t = walk / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    walk -= seg;
  }
  return pts[0] ?? { x: 0, y: 0 };
}

/**
 * Triangle with its tip exactly at `tip`, pointing along the last non-degenerate segment of
 * `pts` (walking back from the tip). Undefined when the whole path has no length.
 */
function arrowHead(
  tipIndex: "end" | "start",
  pts: readonly Vec2[],
  size: number,
): Vec2[] | undefined {
  const order = tipIndex === "end" ? [...pts].reverse() : [...pts];
  const tip = order[0] as Vec2;
  const from = order.slice(1).find((q) => Math.hypot(tip.x - q.x, tip.y - q.y) > 1e-6);
  if (!from) return undefined;
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const px = -uy * (size / 2);
  const py = ux * (size / 2);
  return [tip, { x: bx + px, y: by + py }, { x: bx - px, y: by - py }];
}

/** Shorten `text` with an ellipsis so it fits `maxWidth` at `size`. */
function fit(
  text: string,
  size: number,
  bold: boolean | "medium",
  maxWidth: number,
  family: TextFamily = "display",
): string {
  const weight = bold === true ? "bold" : bold === "medium" ? "medium" : "regular";
  const w = (s: string) => measureText(s, size, weight, family);
  if (w(text) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && w(`${chars.join("")}…`) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

function legendColor(color: string): { attr?: string; style?: string } {
  if (HEX_RE.test(color)) return { attr: color };
  const m = /^(palette|flow):([a-z]+)$/.exec(color);
  if (m) return { style: `fill:var(--pc-${m[1] === "palette" ? "palette" : "flows"}-${m[2]})` };
  return { attr: "#808080" };
}

/** Parses `w:h` aspect strings; undefined for `auto` or garbage. */
function aspectRatio(aspect: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  if (!m) return undefined;
  const w = Number(m[1]);
  const hh = Number(m[2]);
  return w > 0 && hh > 0 ? w / hh : undefined;
}

// Inputs of every model built here, so `withVariant` can rebuild ids and layers.
const registry = new WeakMap<RenderModel, ModelInputs>();

/** The inputs a model was built from (undefined for models built elsewhere). */
export function inputsOf(model: RenderModel): ModelInputs | undefined {
  return registry.get(model);
}

/**
 * Splits a segment where it crosses integer x or y coordinates (floor tile boundaries), so a
 * long run is depth-sorted piece by piece against the tiles, trays and racks it passes.
 */
export function splitAtTiles(a: Vec3, b: Vec3): [Vec3, Vec3][] {
  const ts = new Set<number>([0, 1]);
  for (const axis of ["x", "y"] as const) {
    const lo = Math.min(a[axis], b[axis]);
    const hi = Math.max(a[axis], b[axis]);
    if (hi - lo < 1e-9) continue;
    for (let v = Math.floor(lo) + 1; v < hi - 1e-9; v++) {
      const t = (v - a[axis]) / (b[axis] - a[axis]);
      if (t > 1e-9 && t < 1 - 1e-9) ts.add(Number(t.toFixed(9)));
    }
  }
  const sorted = [...ts].sort((p, q) => p - q);
  const at = (t: number): Vec3 => ({
    x: round2(a.x + (b.x - a.x) * t),
    y: round2(a.y + (b.y - a.y) * t),
    z: round2(a.z + (b.z - a.z) * t),
  });
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    out.push([
      i === 0 ? a : at(sorted[i] as number),
      i + 2 === sorted.length ? b : at(sorted[i + 1] as number),
    ]);
  }
  return out;
}

/** Do two rectangles overlap (touching edges do not count)? */
export function rectsOverlap(r: Rect, q: Rect): boolean {
  return r.x < q.x + q.width && q.x < r.x + r.width && r.y < q.y + q.height && q.y < r.y + r.height;
}

/**
 * Vertical nudge for a label box so it does not cover `placed` boxes: tries 0, -1, +1, -2, +2,
 * -3, +3 label heights (+2px gap). When every position collides the label stays put
 * (`collided: true`) rather than flying off its edge.
 */
export function nudgeLabel(box: Rect, placed: readonly Rect[]): { dy: number; collided: boolean } {
  const step = box.height + 2;
  for (const k of [0, -1, 1, -2, 2, -3, 3]) {
    const cand = { ...box, y: box.y + k * step };
    if (!placed.some((q) => rectsOverlap(cand, q))) return { dy: k * step, collided: false };
  }
  return { dy: 0, collided: true };
}

export function buildModelWithDiagnostics(inputs: ModelInputs): BuiltModel {
  const { scene, theme, prefix } = inputs;
  const projection = createProjection();
  const ids = createIds(prefix);
  const P = prefix;
  const diagnostics: Diagnostic[] = [];
  // Text scales with the drawing (D51 follow-up): wide scenes are shown small, so label sizes
  // grow with the projected scene width (about width / 100, at most 2.2x the theme size).
  const labelSize = labelFontSizeFor(
    [...scene.objects.map((o) => o.box), ...scene.groups.map((g) => g.box)],
    theme.font.label,
  );
  const fs = labelSize / theme.font.label;
  // An omitted `font.mono` means technical text is measured and embedded with the display face.
  const hasMono = theme.font.mono !== undefined;
  const MONO: TextFamily = hasMono ? "mono" : "display";
  const metricH = round2(METRIC_H * fs);
  const captionH = round2(CAPTION_H * fs);
  const legendH = round2(LEGEND_H * fs);
  const displayText: string[] = [];
  const monoText: string[] = [];

  const textEl = (o: {
    id?: string;
    x: number;
    y: number;
    size: number;
    anchor?: TextAnchor;
    cls: string;
    bold?: boolean;
    /** Technical text (D51): JetBrains Mono role. */
    mono?: boolean;
    /** Oswald Medium (node labels). */
    medium?: boolean;
    hidden?: boolean;
    content: string;
  }) => {
    const mono = o.mono === true && hasMono;
    (mono ? monoText : displayText).push(o.content);
    return h(
      "text",
      {
        ...(o.id ? { id: o.id } : {}),
        x: o.x,
        y: o.y,
        "font-size": o.size,
        ...(o.anchor && o.anchor !== "start" ? { "text-anchor": o.anchor } : {}),
        class: `${P}-${o.cls}${o.bold ? ` ${P}-tb` : ""}${mono ? ` ${P}-tm` : ""}${o.medium ? ` ${P}-tw` : ""}`,
        ...(o.hidden ? { visibility: "hidden" } : {}),
      },
      o.content,
    );
  };

  const layers: Record<Layer, SvgNode[]> = {
    background: [],
    groups: [],
    edges: [],
    flows: [],
    objects: [],
    labels: [],
    overlay: [],
  };
  const extents: Rect[] = [];

  // ---- Objects -------------------------------------------------------------------------
  const objectById = new Map<string, SceneObject>(scene.objects.map((o) => [o.id, o]));
  // Flat DC floor objects are drawn with the ground (groups layer), before every edge.
  const floorIds = scene.objects
    .filter((o) => FLOOR_TYPES.has(o.type))
    .map((o) => o.id)
    .sort();
  // Cables are elevated (PLAN §6 exception to D6): each segment is a thin world-space item
  // depth-sorted together with the objects, so trays, racks and floors occlude them correctly.
  const cableSegments = new Map<string, { edge: SceneEdge; a: Vec3; b: Vec3 }>();
  for (const e of scene.edges) {
    if (e.kind !== "cable" || e.hidden) continue;
    let n = 0;
    for (let i = 0; i + 1 < e.path.length; i++) {
      for (const [a, b] of splitAtTiles(e.path[i] as Vec3, e.path[i + 1] as Vec3)) {
        cableSegments.set(`${CABLE_PREFIX}${e.id}#${n++}`, { edge: e, a, b });
      }
    }
  }
  const segBox = (a: Vec3, b: Vec3) => {
    const t = 0.04; // thickness so zero-extent axes still take part in overlap tests
    const lo = {
      x: Math.min(a.x, b.x) - t / 2,
      y: Math.min(a.y, b.y) - t / 2,
      z: Math.min(a.z, b.z) - t / 2,
    };
    const hi = {
      x: Math.max(a.x, b.x) + t / 2,
      y: Math.max(a.y, b.y) + t / 2,
      z: Math.max(a.z, b.z) + t / 2,
    };
    return { origin: lo, size: { x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z } };
  };
  const order = depthOrder(
    [
      ...scene.objects
        .filter((o) => !FLOOR_TYPES.has(o.type))
        .map((o) => ({ id: o.id, box: o.box })),
      ...[...cableSegments].map(([id, seg]) => ({ id, box: segBox(seg.a, seg.b) })),
    ],
    projection,
  );
  const anchors: Record<string, ObjectAnchor> = {};
  const iconRefs = new Set<string>();
  const labelNodes: SvgNode[] = [];
  const floorNodes: SvgNode[] = []; // appended after the group slabs, so slabs never cover them
  const arrowNodes: SvgNode[] = [];
  const placed: Rect[] = []; // label boxes, so edge labels can step aside

  let openSeg: { edgeId: string; id: string; cls: string; pts: Vec2[] } | undefined;
  const flushSeg = () => {
    if (!openSeg) return;
    layers.objects.push(
      h("path", { id: openSeg.id, class: openSeg.cls, d: polylinePath(openSeg.pts) }),
    );
    openSeg = undefined;
  };
  for (const id of [...floorIds, ...order]) {
    const seg = cableSegments.get(id);
    if (seg) {
      const [i] = id.split("#").slice(-1);
      const pa = projection.project(seg.a);
      const pb = projection.project(seg.b);
      // Pieces of one cable that stay adjacent after sorting merge back into one path.
      if (openSeg && openSeg.edgeId === seg.edge.id) {
        const last = openSeg.pts[openSeg.pts.length - 1] as Vec2;
        if (last.x === pa.x && last.y === pa.y) {
          openSeg.pts.push(pb);
          continue;
        }
      }
      flushSeg();
      const cls = [`${P}-edge`, `${P}-edge-${seg.edge.style}`];
      if (seg.edge.cableKind) cls.push(`${P}-cable-${seg.edge.cableKind}`);
      cls.push(`${ids.edge(seg.edge.id)}-seg`);
      openSeg = {
        edgeId: seg.edge.id,
        id: `${ids.edge(seg.edge.id)}__s${i}`,
        cls: cls.join(" "),
        pts: [pa, pb],
      };
      continue;
    }
    flushSeg();
    const o = objectById.get(id) as SceneObject;
    const target = FLOOR_TYPES.has(o.type) ? floorNodes : layers.objects;
    const faceNodes: SvgNode[] = [];
    if (o.parts && o.parts.length > 0) {
      for (const part of o.parts) {
        const kids = primitiveFaces(part.primitive, part.box, projection).map((f) =>
          h("path", {
            id: ids.face(o.id, f.face, part.id),
            class: `${P}-face ${P}-p-${part.tone}-${f.face}${part.tone === "led" ? ` ${ids.ledClass()}` : ""}`,
            d: faceToPath(f),
          }),
        );
        faceNodes.push(
          part.state && part.state !== o.state
            ? h("g", { class: ids.stateClass(part.state) }, ...kids)
            : h("g", null, ...kids),
        );
      }
    } else {
      for (const f of primitiveFaces(o.primitive, o.box, projection)) {
        faceNodes.push(
          h("path", {
            id: ids.face(o.id, f.face),
            class: `${P}-face ${P}-k-${o.category}-${f.face}`,
            d: faceToPath(f),
          }),
        );
      }
    }
    const sil = primitiveSilhouette(o.primitive, o.box, projection);
    const bbox = boundsOfPoints(sil.points);
    const center = { x: round2(bbox.x + bbox.width / 2), y: round2(bbox.y + bbox.height / 2) };
    anchors[o.id] = { id: o.id, bbox, center, top: { x: center.x, y: bbox.y } };
    extents.push(bbox);

    // Icon: upright, flat, centered at the projected anchor (never skewed onto a face).
    const iconNodes: SvgNode[] = [];
    let aboveTop = bbox.y; // top of the solid or of its floating icon plate
    if (o.icon) {
      const resolved = inputs.icons?.resolve(o.icon.ref);
      let def: SvgNode | undefined;
      if (resolved && !iconRefs.has(resolved.ref)) {
        try {
          def = iconDef(resolved.ref, resolved.svg.viewBox, resolved.svg.body);
        } catch {
          def = undefined; // body failed the emitter's trust check
        }
      }
      if (!resolved || (!def && !iconRefs.has(resolved.ref))) {
        diagnostics.push({
          severity: "warning",
          code: "render/icon-unavailable",
          path: "",
          message: `Icon "${o.icon.ref}" for "${o.id}" could not be used; drawn without an icon.`,
        });
      } else {
        const iid = ids.icon(resolved.ref);
        if (def) {
          iconRefs.add(resolved.ref);
          layers.background.push(def);
        }
        const frontH = o.box.size.z * projection.zScale;
        const std = Math.min(o.icon.size, bbox.width * 0.6); // standard size
        // Shrink on the face down to 0.75x the standard size; below that the plate floats.
        const floating = frontH - 8 < std * 0.75;
        let s = std;
        let c: { x: number; y: number };
        if (floating) {
          // Front face too short: the upright plate floats over the top face centre, at the
          // standard size, with a small shadow on the face (never skewed, never shrunk).
          const top = projection.project({
            x: o.box.origin.x + o.box.size.x / 2,
            y: o.box.origin.y + o.box.size.y / 2,
            z: o.box.origin.z + o.box.size.z,
          });
          c = { x: top.x, y: top.y - s / 2 - 6 };
          iconNodes.push(
            h("ellipse", {
              class: `${P}-shadow`,
              cx: top.x,
              cy: top.y,
              rx: round2(s * 0.42),
              ry: round2(s * 0.17),
            }),
          );
          extents.push({ x: c.x - s / 2 - 2, y: c.y - s / 2 - 2, width: s + 4, height: s + 4 });
          aboveTop = Math.min(aboveTop, c.y - s / 2 - 2);
        } else {
          // Plate (icon + 2px each side) stays inside the visible front face / silhouette.
          s = Math.min(std, frontH - 8);
          const a = projection.project(o.icon.anchor);
          const half = s / 2 + 2;
          c = {
            x: Math.min(Math.max(a.x, bbox.x + half), bbox.x + bbox.width - half),
            y: Math.min(Math.max(a.y, bbox.y + half), bbox.y + bbox.height - half),
          };
        }
        iconNodes.push(
          h("rect", {
            class: `${P}-plate`,
            x: c.x - s / 2 - 2,
            y: c.y - s / 2 - 2,
            width: s + 4,
            height: s + 4,
            rx: 3,
          }),
          h("use", {
            class: `${P}-icon`,
            href: `#${iid}`,
            x: c.x - s / 2,
            y: c.y - s / 2,
            width: s,
            height: s,
          }),
        );
      }
    }

    target.push(
      h(
        "g",
        { id: ids.object(o.id), class: ids.stateClass(o.state) },
        ...faceNodes,
        ...iconNodes,
        h("path", { id: ids.overlay(o.id), class: `${P}-overlay`, d: sil.d }),
      ),
    );

    // Devices inside a rack (`rack/slot`) stay unlabeled: their labels pile up over the rack.
    const insideRack = o.source === "dc" && o.id.includes("/");
    if (o.label && !insideRack) {
      const text = fit(o.label, labelSize, "medium", 150 * fs);
      const y = bbox.y + bbox.height + labelSize + 3;
      labelNodes.push(
        textEl({
          x: center.x,
          y,
          size: labelSize,
          anchor: "middle",
          cls: o.source === "dc" ? "t-dc" : "t-primary",
          medium: true,
          content: text,
        }),
      );
      const w = measureText(text, labelSize, "medium");
      const r = { x: center.x - w / 2, y: y - labelSize, width: w, height: labelSize + 4 };
      extents.push(r);
      placed.push(r);
    }
    if (o.badge) {
      const bs = theme.font.badge * fs;
      const text = fit(o.badge, bs, true, 96 * fs, MONO);
      const w = measureText(text, bs, "bold", MONO) + 10 * fs;
      const bh = bs + 6 * fs;
      const by = aboveTop - bh - 2;
      labelNodes.push(
        h(
          "g",
          null,
          h("rect", {
            class: `${P}-badgebox`,
            x: center.x - w / 2,
            y: by,
            width: w,
            height: bh,
            rx: 3,
          }),
          textEl({
            x: center.x,
            y: by + bh - 5 * fs,
            size: bs,
            anchor: "middle",
            cls: "t-badge",
            bold: true,
            mono: true,
            content: text,
          }),
        ),
      );
      const r = { x: center.x - w / 2, y: by, width: w, height: bh };
      extents.push(r);
      placed.push(r);
    }
  }

  flushSeg();

  // ---- Groups --------------------------------------------------------------------------
  for (const g of orderGroups(scene.groups)) {
    const kindClass =
      g.kind === "cold-aisle" || g.kind === "hot-aisle" || g.kind === "hall"
        ? `${P}-grp-${g.kind}`
        : `${P}-grp-${g.style}`;
    const cls = g.contained ? `${kindClass} ${P}-grp-contained` : kindClass;
    const faces = primitiveFaces("slab", g.box, projection).map((f) =>
      h("path", { d: faceToPath(f) }),
    );
    layers.groups.push(h("g", { id: ids.group(g.id), class: cls }, ...faces));
    const rect = projectBoxBounds(projection, g.box);
    extents.push(rect);
    if (g.label) {
      // Outside the slab, left of its left corner, on a pill: members and the outline can't cover it.
      const corner = projection.project({
        x: g.box.origin.x,
        y: g.box.origin.y + g.box.size.y,
        z: g.box.origin.z + g.box.size.z,
      });
      const text = fit(g.label, labelSize, true, 160 * fs);
      const w = measureText(text, labelSize, "bold");
      const ph = labelSize + 8 * fs;
      const pill = {
        x: corner.x - 10 * fs - w - 12 * fs,
        y: corner.y - ph / 2,
        width: w + 12 * fs,
        height: ph,
      };
      labelNodes.unshift(
        h(
          "g",
          null,
          h("rect", {
            class: `${P}-gpill`,
            x: pill.x,
            y: pill.y,
            width: pill.width,
            height: pill.height,
            rx: 4,
          }),
          textEl({
            x: pill.x + pill.width - 6 * fs,
            y: corner.y + labelSize / 2 - 1,
            size: labelSize,
            anchor: "end",
            cls: "glabel",
            bold: true,
            content: text,
          }),
        ),
      );
      extents.push(pill);
      placed.push(pill);
    }
  }

  layers.groups.push(...floorNodes);

  // ---- Edges ---------------------------------------------------------------------------
  const edgePaths: Record<string, EdgePath> = {};
  for (const e of scene.edges) {
    const pts = e.path.map((p) => projection.project(p));
    edgePaths[e.id] = { edgeId: e.id, d: polylinePath(pts), points: pts, length: lengthOf(pts) };
    if (e.hidden || pts.length < 2) continue;
    layers.edges.push(edgeNode(e, pts));
    extents.push(boundsOfPoints(pts));
    if (e.label) {
      const anchor = e.labelAnchor ? projection.project(e.labelAnchor) : midpoint(pts);
      const text = fit(e.label, labelSize - 1, false, 120 * fs, MONO);
      const w = measureText(text, labelSize - 1, "regular", MONO) + 8 * fs;
      const lh = labelSize + 4;
      const { dy } = nudgeLabel(
        { x: anchor.x - w / 2, y: anchor.y - lh / 2, width: w, height: lh },
        placed,
      );
      const box = { x: anchor.x - w / 2, y: anchor.y - lh / 2 + dy, width: w, height: lh };
      placed.push(box);
      extents.push(box);
      if (dy !== 0) {
        // keep a shifted label tied to its edge
        const edgeY = dy < 0 ? box.y + box.height : box.y;
        labelNodes.push(
          h("path", {
            class: `${P}-leader`,
            d: `M${fmt(anchor.x)} ${fmt(anchor.y)}L${fmt(anchor.x)} ${fmt(edgeY)}`,
          }),
        );
      }
      labelNodes.push(
        h(
          "g",
          null,
          h("rect", {
            class: `${P}-elabel`,
            x: box.x,
            y: box.y,
            width: w,
            height: lh,
            rx: 3,
          }),
          textEl({
            x: anchor.x,
            y: anchor.y + dy + (labelSize - 1) / 2 - 1,
            size: labelSize - 1,
            anchor: "middle",
            cls: "t-edge",
            mono: true,
            content: text,
          }),
        ),
      );
    }
  }

  function edgeNode(e: SceneEdge, pts: readonly Vec2[]): SvgNode {
    const cls = [`${P}-edge`, `${P}-edge-${e.style}`];
    if (e.kind === "cable" && e.cableKind) cls.push(`${P}-cable-${e.cableKind}`);
    // Cables are drawn as depth-sorted segments in the objects layer; this path only carries
    // particles (`<mpath>`), so it is not painted.
    const kids: SvgNode[] = [
      e.kind === "cable"
        ? h("path", { id: ids.edgePath(e.id), fill: "none", stroke: "none", d: polylinePath(pts) })
        : h("path", { id: ids.edgePath(e.id), class: cls.join(" "), d: polylinePath(pts) }),
    ];
    // Arrowheads are drawn in the labels layer so objects never cover them.
    if (e.arrow.end) {
      const a = arrowHead("end", pts, 9);
      if (a)
        arrowNodes.push(
          h("polygon", { class: `${P}-arrow ${ids.edge(e.id)}-arrow`, points: pointsAttr(a) }),
        );
    }
    if (e.arrow.start) {
      const a = arrowHead("start", pts, 9);
      if (a)
        arrowNodes.push(
          h("polygon", { class: `${P}-arrow ${ids.edge(e.id)}-arrow`, points: pointsAttr(a) }),
        );
    }
    return h("g", { id: ids.edge(e.id) }, ...kids);
  }

  // ---- Figure boards (schema 1.2.0) ------------------------------------------------------
  // Absent for every 1.1 scene (no `assemblies`), so their layers and view box are untouched.
  const boardsBuild = buildBoards({
    scene,
    spec: inputs.spec,
    images: inputs.images,
    projection,
    ids,
    prefix: P,
    labelSize,
    fs,
    text: (o) =>
      textEl({
        ...(o.id === undefined ? {} : { id: o.id }),
        x: o.x,
        y: o.y,
        size: o.size,
        ...(o.anchor === undefined ? {} : { anchor: o.anchor }),
        cls: o.cls,
        ...(o.bold === true ? { bold: true } : {}),
        content: o.content,
      }),
    fit: (text, size, bold, maxWidth) => fit(text, size, bold, maxWidth),
  });
  if (boardsBuild) {
    layers.background.push(...boardsBuild.defs);
    layers.objects.push(...boardsBuild.objects);
    extents.push(...boardsBuild.extents);
  }

  // ---- Assemblies (schema 1.2.0) -----------------------------------------------------------
  // Absent for every 1.1 scene (no `assemblies`), so their layers and view box are untouched.
  const asmResult = buildAssemblyRender({
    scene,
    spec: inputs.spec,
    images: inputs.images,
    projection,
    ids,
    prefix: P,
    labelSize,
    fs,
    text: (o) =>
      textEl({
        x: o.x,
        y: o.y,
        size: o.size,
        ...(o.anchor === undefined ? {} : { anchor: o.anchor }),
        cls: o.cls,
        ...(o.bold === true ? { bold: true } : {}),
        content: o.content,
      }),
    fit: (text, size, bold, maxWidth) => fit(text, size, bold, maxWidth),
    focusMargin: { side: MARGIN_FOCUS, bottom: labelSize + 6 },
  });
  if (asmResult) diagnostics.push(...asmResult.diagnostics);
  const asmBuild = asmResult !== undefined && "model" in asmResult ? asmResult : undefined;
  if (asmBuild) {
    layers.background.push(...asmBuild.defs);
    layers.objects.push(...asmBuild.objects);
    extents.push(...asmBuild.extents);
    // Close-up levels (§8.4): first in the overlay layer, so captions and tiles draw above them.
    if (asmBuild.levelNodes !== undefined) layers.overlay.push(...asmBuild.levelNodes);
  }

  // ---- Viewbox, overlays ---------------------------------------------------------------
  const pad = Math.max(0, scene.canvas.padding); // pixels (schema: canvas.padding)
  let vb: Rect =
    extents.length > 0 ? unionRects(extents) : projectBoxBounds(projection, scene.bounds);
  vb = { x: vb.x - pad, y: vb.y - pad, width: vb.width + 2 * pad, height: vb.height + 2 * pad };

  const metrics = scene.metrics;
  const tl = scene.timeline;
  const captionSteps = tl.filter((s) => s.caption !== undefined && s.caption !== "");
  const legend = scene.legend;

  // Metric tiles: width from label and every value the metric takes.
  interface Tile {
    id: string;
    label: string;
    texts: { n: number; text: string }[];
    width: number;
  }
  const tiles: Tile[] = metrics.map((m) => {
    const texts = [{ n: 0, text: String(m.value) }];
    let prev = String(m.value);
    for (const s of tl) {
      const raw = s.metrics[m.id];
      const v = raw === undefined ? prev : String(raw);
      if (v !== prev) {
        texts.push({ n: s.index, text: v });
        prev = v;
      }
    }
    const lab = fit(m.label, 10 * fs, false, 140 * fs, MONO);
    const vw = Math.max(...texts.map((t) => measureText(t.text, 15 * fs, "bold", MONO)));
    return {
      id: m.id,
      label: lab,
      texts,
      width: Math.max(measureText(lab, 10 * fs, "regular", MONO), vw) + 20 * fs,
    };
  });
  const tilesW = tiles.reduce((s, t) => s + t.width + 8, 8);

  const creditsH = boardsBuild && boardsBuild.creditsLine !== "" ? round2(16 * fs) : 0;
  const topExtra = tiles.length > 0 ? metricH + 14 : 0;
  const bottomExtra =
    (captionSteps.length > 0 ? captionH + 12 : 0) +
    (legend.length > 0 ? legendH + 8 : 0) +
    creditsH;
  vb = { x: vb.x, y: vb.y - topExtra, width: vb.width, height: vb.height + topExtra + bottomExtra };
  if (tilesW > vb.width) vb = { ...vb, x: vb.x - (tilesW - vb.width) / 2, width: tilesW };
  const ratio = aspectRatio(scene.canvas.aspect);
  if (ratio) {
    if (vb.width / vb.height < ratio) {
      const w = vb.height * ratio;
      vb = { ...vb, x: vb.x - (w - vb.width) / 2, width: w };
    } else {
      const hh = vb.width / ratio;
      vb = { ...vb, y: vb.y - (hh - vb.height) / 2, height: hh };
    }
  }
  vb = { x: round2(vb.x), y: round2(vb.y), width: round2(vb.width), height: round2(vb.height) };

  const metricRects: Record<string, Rect> = {};
  let tx = vb.x + 8;
  for (const t of tiles) {
    const r: Rect = {
      x: round2(tx),
      y: round2(vb.y + 10),
      width: round2(t.width),
      height: metricH,
    };
    metricRects[t.id] = r;
    layers.overlay.push(
      h(
        "g",
        { id: ids.metric(t.id) },
        h("rect", {
          class: `${P}-metric`,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          rx: 4,
        }),
        textEl({
          x: r.x + 10 * fs,
          y: r.y + 13 * fs,
          size: 10 * fs,
          cls: "t-metric-label",
          mono: true,
          content: t.label,
        }),
        ...t.texts.map((tx2) =>
          textEl({
            id: ids.metricValue(t.id, tx2.n),
            x: r.x + 10 * fs,
            y: r.y + metricH - 8 * fs,
            size: 15 * fs,
            cls: "t-metric-value",
            bold: true,
            mono: true,
            hidden: tx2.n !== 0,
            content: tx2.text,
          }),
        ),
      ),
    );
    tx += t.width + 8;
  }

  let captionRect: Rect | undefined;
  let bottom = vb.y + vb.height - 8;
  // Credits line (§11.6): pinned like the legend, at the very bottom.
  if (boardsBuild && creditsH > 0) {
    const size = round2(10 * fs);
    const text = fit(boardsBuild.creditsLine, size, false, vb.width - 24, MONO);
    layers.overlay.push(
      h(
        "g",
        { id: boardsBuild.model.creditsId as string },
        textEl({
          x: round2(vb.x + 12),
          y: round2(bottom - 3 * fs),
          size,
          cls: "t-secondary",
          mono: true,
          content: text,
        }),
      ),
    );
    bottom -= creditsH;
  }
  if (captionSteps.length > 0) {
    const maxW = vb.width - 24;
    const texts = captionSteps.map((s) =>
      fit(s.caption as string, theme.font.caption * fs, false, maxW - 32 * fs),
    );
    const w = Math.min(
      maxW,
      Math.max(...texts.map((t) => measureText(t, theme.font.caption * fs))) + 32 * fs,
    );
    captionRect = {
      x: round2(vb.x + (vb.width - w) / 2),
      y: round2(bottom - captionH),
      width: round2(w),
      height: captionH,
    };
    const cx = captionRect.x + captionRect.width / 2;
    layers.overlay.push(
      h(
        "g",
        { id: ids.caption() },
        h("rect", {
          class: `${P}-capbox`,
          x: captionRect.x,
          y: captionRect.y,
          width: captionRect.width,
          height: captionRect.height,
          rx: 4,
        }),
        ...captionSteps.map((s, i) =>
          textEl({
            id: ids.captionStep(s.index),
            x: cx,
            y: captionRect!.y + captionH / 2 + (theme.font.caption * fs) / 2 - 2 * fs,
            size: theme.font.caption * fs,
            anchor: "middle",
            cls: "t-caption",
            hidden: s.index !== 1,
            content: texts[i] as string,
          }),
        ),
      ),
    );
    bottom -= captionH + 12;
  }
  if (legend.length > 0) {
    const items: SvgNode[] = [];
    let lx = vb.x + 12;
    const ly = bottom - legendH / 2;
    for (const entry of legend) {
      const text = fit(entry.label, labelSize, false, 120 * fs);
      const c = legendColor(entry.color);
      items.push(
        h("rect", {
          x: lx,
          y: ly - 5 * fs,
          width: 10 * fs,
          height: 10 * fs,
          rx: 2,
          ...(c.attr ? { fill: c.attr } : {}),
          ...(c.style ? { style: c.style } : {}),
        }),
        textEl({
          x: lx + 15 * fs,
          y: ly + labelSize / 2 - 1,
          size: labelSize,
          cls: "t-secondary",
          content: text,
        }),
      );
      lx += 15 * fs + measureText(text, labelSize) + 16 * fs;
    }
    layers.overlay.push(h("g", { id: ids.legend(), class: `${P}-legend` }, ...items));
  }

  // ---- Background and grid -------------------------------------------------------------
  // viewBox plus half its size on each side: the camera may briefly show beyond a zoomed view.
  layers.background.unshift(
    h("rect", {
      class: `${P}-bg`,
      x: vb.x - vb.width / 2,
      y: vb.y - vb.height / 2,
      width: 2 * vb.width,
      height: 2 * vb.height,
    }),
  );
  // A scene of figure panels only has no floor to draw a grid on.
  const boardsOnly =
    boardsBuild !== undefined && scene.objects.length === 0 && scene.groups.length === 0;
  if (scene.canvas.grid && !boardsOnly) {
    const b = scene.bounds;
    const gx0 = Math.floor(b.origin.x - 1);
    const gx1 = Math.ceil(b.origin.x + b.size.x + 1);
    const gy0 = Math.floor(b.origin.y - 1);
    const gy1 = Math.ceil(b.origin.y + b.size.y + 1);
    if (gx1 - gx0 + 1 + (gy1 - gy0 + 1) <= 400) {
      let d = "";
      const z = b.origin.z;
      for (let x = gx0; x <= gx1; x++) {
        const a = projection.project({ x, y: gy0, z });
        const c = projection.project({ x, y: gy1, z });
        d += `M${fmt(a.x)} ${fmt(a.y)}L${fmt(c.x)} ${fmt(c.y)}`;
      }
      for (let y = gy0; y <= gy1; y++) {
        const a = projection.project({ x: gx0, y, z });
        const c = projection.project({ x: gx1, y, z });
        d += `M${fmt(a.x)} ${fmt(a.y)}L${fmt(c.x)} ${fmt(c.y)}`;
      }
      layers.background.push(h("path", { class: `${P}-grid`, d }));
    }
  }

  layers.labels.push(...arrowNodes, ...labelNodes);
  if (boardsBuild) layers.labels.push(...boardsBuild.labels);
  if (asmBuild) layers.labels.push(...asmBuild.labels);

  // ---- Focus rects, glyph coverage -----------------------------------------------------
  const focusRects: Record<string, Rect> = {};
  // Close-up targets live in their level's own coordinates: `assembly.levelFocusRect` has them.
  const levelList = scene.assemblies?.levels ?? [];
  for (const id of Object.keys(scene.focusTargets).sort()) {
    if (levelList.length > 0 && levelOf(levelList, id) !== undefined) continue;
    const r = projectBoxBounds(projection, scene.focusTargets[id] as Box3);
    focusRects[id] = {
      x: round2(r.x - MARGIN_FOCUS),
      y: round2(r.y - MARGIN_FOCUS),
      width: round2(r.width + 2 * MARGIN_FOCUS),
      height: round2(r.height + 2 * MARGIN_FOCUS + labelSize + 6),
    };
  }
  // A figure's focus rect covers its panel, moving sprites and labels, not just the world box.
  if (boardsBuild) {
    for (const [id, r] of Object.entries(boardsBuild.focus)) focusRects[id] = r;
  }
  const missing = [
    ...new Set([
      ...missingGlyphs(displayText.join(""), "display"),
      ...missingGlyphs(monoText.join(""), MONO),
    ]),
  ].sort((a, b) => a - b);
  if (missing.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "render/missing-glyph",
      path: "",
      message: `${missing.length} character(s) are outside the bundled font and may render as blanks.`,
      params: { codePoints: missing.slice(0, 20) },
    });
  }

  const model: RenderModel = {
    scene,
    theme,
    ...(inputs.darkTheme ? { darkTheme: inputs.darkTheme } : {}),
    projection,
    ids,
    viewBox: vb,
    layers,
    edgePaths,
    anchors,
    focusRects,
    ...(captionRect ? { captionRect } : {}),
    metricRects,
    font: inputs.font,
    fontAssets: fontAssets(),
    ...(boardsBuild ? { boards: boardsBuild.model } : {}),
    ...(asmBuild ? { assembly: asmBuild.model } : {}),
  };
  registry.set(model, inputs);
  return { model, diagnostics };
}

export function buildModel(inputs: ModelInputs): RenderModel {
  return buildModelWithDiagnostics(inputs).model;
}
