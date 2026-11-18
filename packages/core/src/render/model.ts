import type {
  Box3,
  Diagnostic,
  EdgePath,
  FontMode,
  IconResolver,
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
} from "../contracts/index.js";
import { depthOrder, orderGroups } from "../depth/index.js";
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
import { fontAssets, measureText, missingGlyphs, type TextAnchor } from "../text/index.js";

/** Everything `buildModel` needs; kept so `withVariant` can rebuild under another id prefix. */
export interface ModelInputs {
  readonly scene: SceneGraph;
  readonly theme: ThemeTokens;
  readonly darkTheme?: ThemeTokens;
  readonly font: FontMode;
  readonly prefix: string;
  readonly icons?: IconResolver;
}

export interface BuiltModel {
  readonly model: RenderModel;
  readonly diagnostics: readonly Diagnostic[];
}

const MARGIN_FOCUS = 12;
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

function arrowHead(tip: Vec2, from: Vec2, size: number): Vec2[] | undefined {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return undefined;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const px = -uy * (size / 2);
  const py = ux * (size / 2);
  return [tip, { x: bx + px, y: by + py }, { x: bx - px, y: by - py }];
}

/** Shorten `text` with an ellipsis so it fits `maxWidth` at `size`. */
function fit(text: string, size: number, bold: boolean, maxWidth: number): string {
  const w = (s: string) => measureText(s, size, bold ? "bold" : "regular");
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

export function buildModelWithDiagnostics(inputs: ModelInputs): BuiltModel {
  const { scene, theme, prefix } = inputs;
  const projection = createProjection();
  const ids = createIds(prefix);
  const P = prefix;
  const diagnostics: Diagnostic[] = [];
  const labelSize = theme.font.label;
  const allText: string[] = [];

  const textEl = (o: {
    id?: string;
    x: number;
    y: number;
    size: number;
    anchor?: TextAnchor;
    cls: string;
    bold?: boolean;
    hidden?: boolean;
    content: string;
  }) => {
    allText.push(o.content);
    return h(
      "text",
      {
        ...(o.id ? { id: o.id } : {}),
        x: o.x,
        y: o.y,
        "font-size": o.size,
        ...(o.anchor && o.anchor !== "start" ? { "text-anchor": o.anchor } : {}),
        class: `${P}-${o.cls}${o.bold ? ` ${P}-tb` : ""}`,
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
  const order = depthOrder(
    scene.objects.map((o) => ({ id: o.id, box: o.box })),
    projection,
  );
  const anchors: Record<string, ObjectAnchor> = {};
  const iconRefs = new Set<string>();
  const labelNodes: SvgNode[] = [];

  for (const id of order) {
    const o = objectById.get(id) as SceneObject;
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
        const c = projection.project(o.icon.anchor);
        const s = o.icon.size;
        const iid = ids.icon(resolved.ref);
        if (def) {
          iconRefs.add(resolved.ref);
          layers.background.push(def);
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

    layers.objects.push(
      h(
        "g",
        { id: ids.object(o.id), class: ids.stateClass(o.state) },
        ...faceNodes,
        ...iconNodes,
        h("path", { id: ids.overlay(o.id), class: `${P}-overlay`, d: sil.d }),
      ),
    );

    if (o.label) {
      const text = fit(o.label, labelSize, false, 150);
      const y = bbox.y + bbox.height + labelSize + 3;
      labelNodes.push(
        textEl({
          x: center.x,
          y,
          size: labelSize,
          anchor: "middle",
          cls: "t-primary",
          content: text,
        }),
      );
      const w = measureText(text, labelSize);
      extents.push({ x: center.x - w / 2, y: y - labelSize, width: w, height: labelSize + 4 });
    }
    if (o.badge) {
      const bs = theme.font.badge;
      const text = fit(o.badge, bs, true, 60);
      const w = measureText(text, bs, "bold") + 10;
      const bh = bs + 6;
      const by = bbox.y - bh - 2;
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
            rx: bh / 2,
          }),
          textEl({
            x: center.x,
            y: by + bh - 5,
            size: bs,
            anchor: "middle",
            cls: "t-badge",
            bold: true,
            content: text,
          }),
        ),
      );
      extents.push({ x: center.x - w / 2, y: by, width: w, height: bh });
    }
  }

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
      const corner = projection.project({
        x: g.box.origin.x + 0.2,
        y: g.box.origin.y + g.box.size.y - 0.2,
        z: g.box.origin.z + g.box.size.z,
      });
      const text = fit(g.label, labelSize, true, 160);
      labelNodes.unshift(
        textEl({
          x: corner.x + 4,
          y: corner.y - 4,
          size: labelSize,
          cls: "glabel",
          bold: true,
          content: text,
        }),
      );
    }
  }

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
      const text = fit(e.label, labelSize - 1, false, 90);
      const w = measureText(text, labelSize - 1) + 8;
      const lh = labelSize + 4;
      labelNodes.push(
        h(
          "g",
          null,
          h("rect", {
            class: `${P}-elabel`,
            x: anchor.x - w / 2,
            y: anchor.y - lh / 2,
            width: w,
            height: lh,
            rx: 3,
          }),
          textEl({
            x: anchor.x,
            y: anchor.y + (labelSize - 1) / 2 - 1,
            size: labelSize - 1,
            anchor: "middle",
            cls: "t-edge",
            content: text,
          }),
        ),
      );
    }
  }

  function edgeNode(e: SceneEdge, pts: readonly Vec2[]): SvgNode {
    const cls = [`${P}-edge`, `${P}-edge-${e.style}`];
    if (e.kind === "cable" && e.cableKind) cls.push(`${P}-cable-${e.cableKind}`);
    const kids: SvgNode[] = [
      h("path", { id: ids.edgePath(e.id), class: cls.join(" "), d: polylinePath(pts) }),
    ];
    const last = pts[pts.length - 1] as Vec2;
    const prev = pts[pts.length - 2] as Vec2;
    const first = pts[0] as Vec2;
    const second = pts[1] as Vec2;
    if (e.arrow.end) {
      const a = arrowHead(last, prev, 8);
      if (a) kids.push(h("polygon", { class: `${P}-arrow`, points: pointsAttr(a) }));
    }
    if (e.arrow.start) {
      const a = arrowHead(first, second, 8);
      if (a) kids.push(h("polygon", { class: `${P}-arrow`, points: pointsAttr(a) }));
    }
    return h("g", { id: ids.edge(e.id) }, ...kids);
  }

  // ---- Viewbox, overlays ---------------------------------------------------------------
  const tile = projection.tileWidth;
  const pad = Math.max(0.5, scene.canvas.padding) * (tile / 2);
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
    const lab = fit(m.label, 10, false, 140);
    const vw = Math.max(...texts.map((t) => measureText(t.text, 15, "bold")));
    return { id: m.id, label: lab, texts, width: Math.max(measureText(lab, 10), vw) + 20 };
  });
  const tilesW = tiles.reduce((s, t) => s + t.width + 8, 8);

  const topExtra = tiles.length > 0 ? METRIC_H + 14 : 0;
  const bottomExtra =
    (captionSteps.length > 0 ? CAPTION_H + 12 : 0) + (legend.length > 0 ? LEGEND_H + 8 : 0);
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
      height: METRIC_H,
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
          rx: 5,
        }),
        textEl({ x: r.x + 10, y: r.y + 13, size: 10, cls: "t-metric-label", content: t.label }),
        ...t.texts.map((tx2) =>
          textEl({
            id: ids.metricValue(t.id, tx2.n),
            x: r.x + 10,
            y: r.y + METRIC_H - 8,
            size: 15,
            cls: "t-metric-value",
            bold: true,
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
  if (captionSteps.length > 0) {
    const maxW = vb.width - 24;
    const texts = captionSteps.map((s) =>
      fit(s.caption as string, theme.font.caption, false, maxW - 32),
    );
    const w = Math.min(
      maxW,
      Math.max(...texts.map((t) => measureText(t, theme.font.caption))) + 32,
    );
    captionRect = {
      x: round2(vb.x + (vb.width - w) / 2),
      y: round2(bottom - CAPTION_H),
      width: round2(w),
      height: CAPTION_H,
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
          rx: 6,
        }),
        ...captionSteps.map((s, i) =>
          textEl({
            id: ids.captionStep(s.index),
            x: cx,
            y: captionRect!.y + CAPTION_H / 2 + theme.font.caption / 2 - 2,
            size: theme.font.caption,
            anchor: "middle",
            cls: "t-caption",
            hidden: s.index !== 1,
            content: texts[i] as string,
          }),
        ),
      ),
    );
    bottom -= CAPTION_H + 12;
  }
  if (legend.length > 0) {
    const items: SvgNode[] = [];
    let lx = vb.x + 12;
    const ly = bottom - LEGEND_H / 2;
    for (const entry of legend) {
      const text = fit(entry.label, labelSize, false, 120);
      const c = legendColor(entry.color);
      items.push(
        h("rect", {
          x: lx,
          y: ly - 5,
          width: 10,
          height: 10,
          rx: 2,
          ...(c.attr ? { fill: c.attr } : {}),
          ...(c.style ? { style: c.style } : {}),
        }),
        textEl({
          x: lx + 15,
          y: ly + labelSize / 2 - 1,
          size: labelSize,
          cls: "t-secondary",
          content: text,
        }),
      );
      lx += 15 + measureText(text, labelSize) + 16;
    }
    layers.overlay.push(h("g", { class: `${P}-legend` }, ...items));
  }

  // ---- Background and grid -------------------------------------------------------------
  const big = 4;
  layers.background.unshift(
    h("rect", {
      class: `${P}-bg`,
      x: vb.x - big * vb.width,
      y: vb.y - big * vb.height,
      width: (2 * big + 1) * vb.width,
      height: (2 * big + 1) * vb.height,
    }),
  );
  if (scene.canvas.grid) {
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

  layers.labels.push(...labelNodes);

  // ---- Focus rects, glyph coverage -----------------------------------------------------
  const focusRects: Record<string, Rect> = {};
  for (const id of Object.keys(scene.focusTargets).sort()) {
    const r = projectBoxBounds(projection, scene.focusTargets[id] as Box3);
    focusRects[id] = {
      x: round2(r.x - MARGIN_FOCUS),
      y: round2(r.y - MARGIN_FOCUS),
      width: round2(r.width + 2 * MARGIN_FOCUS),
      height: round2(r.height + 2 * MARGIN_FOCUS + labelSize + 6),
    };
  }
  const missing = missingGlyphs(allText.join(""));
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
  };
  registry.set(model, inputs);
  return { model, diagnostics };
}

export function buildModel(inputs: ModelInputs): RenderModel {
  return buildModelWithDiagnostics(inputs).model;
}
