import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type {
  AnimationLayer,
  Diagnostic,
  ExportFn,
  RenderModel,
  ResolvedIcon,
  IconResolver,
  SceneObject,
  Rect,
  ThemeRegistry,
} from "../src/contracts/index.js";
import { createAnimator } from "../src/anim/index.js";
import { emit, h } from "../src/emit/index.js";
import { optimize } from "../src/optimize/index.js";
import {
  buildModelWithDiagnostics,
  nudgeLabel,
  rectsOverlap,
  splitAtTiles,
} from "../src/render/model.js";
import {
  buildModel,
  canonicalJson,
  createRender,
  defaultIdPrefix,
  specSchema,
  validateOptions,
  withVariant,
  type RenderDeps,
} from "../src/render/index.js";
import { SCHEMA_ID, SCHEMA_REVISION } from "../src/index.js";
import { loadBalancerScene } from "./fixtures/scene.js";
import { fixtureTheme } from "./fixtures/theme.js";

const noopLayer: AnimationLayer = { css: "", defs: [], layers: {}, duration: 0 };
const spec = { meta: { version: "1" }, nodes: [{ id: "a", type: "server" }] };

function deps(over: Partial<RenderDeps> = {}): RenderDeps {
  return {
    validate: (s) => ({ valid: true, spec: s as never, diagnostics: [] }),
    buildScene: () => loadBalancerScene(),
    createAnimator: () => ({ animate: () => noopLayer }),
    exportOutputs: () => Promise.resolve({ outputs: [], diagnostics: [] }),
    rasterize: () => Promise.resolve(new Uint8Array()),
    emit,
    optimize,
    ...over,
  };
}

const registry: ThemeRegistry = {
  get: (id) => (id === "light" || id === "dark" ? fixtureTheme(id, id === "dark") : undefined),
  list: () => ["dark", "light"],
};

const inputs = () => ({
  scene: loadBalancerScene(),
  theme: fixtureTheme("light"),
  font: "system" as const,
  prefix: "pc-test",
});

function allIds(svg: string): string[] {
  return [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] as string);
}

describe("buildModel", () => {
  const model = buildModel(inputs());

  test("every id is unique and carries the prefix", () => {
    const svg = emit(model, noopLayer, { font: "system" });
    const ids = allIds(svg);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i.startsWith("pc-test"))).toBe(true);
  });

  test("objects are depth ordered back to front", () => {
    const ids = model.layers.objects.map((n) =>
      typeof n === "object" && "attrs" in n ? n.attrs?.id : "",
    );
    expect(ids).toEqual(["pc-test-o_users", "pc-test-o_lb", "pc-test-o_app-1", "pc-test-o_app-2"]);
  });

  test("every object has its state class and an overlay; faces use the id scheme", () => {
    const svg = emit(model, noopLayer, { font: "system" });
    expect(svg).toContain('<g id="pc-test-o_app-1" class="pc-test-s-healthy">');
    for (const o of model.scene.objects) {
      expect(svg).toContain(`id="pc-test-ov_${o.id}"`);
      expect(svg).toContain(`id="pc-test-f_${o.id}__top"`);
    }
  });

  test("anchors, view box and focus rects", () => {
    const { viewBox, anchors, focusRects } = model;
    for (const a of Object.values(anchors)) {
      expect(a.bbox.x).toBeGreaterThanOrEqual(viewBox.x);
      expect(a.bbox.y).toBeGreaterThanOrEqual(viewBox.y);
      expect(a.bbox.x + a.bbox.width).toBeLessThanOrEqual(viewBox.x + viewBox.width);
      expect(a.bbox.y + a.bbox.height).toBeLessThanOrEqual(viewBox.y + viewBox.height);
      expect(a.top.y).toBe(a.bbox.y);
    }
    expect(Object.keys(focusRects).sort()).toEqual(["app-2", "web"]);
    expect(focusRects["app-2"]?.width).toBeGreaterThan(anchors["app-2"]?.bbox.width ?? 0);
    expect(model.captionRect).toBeDefined();
    expect(Object.keys(model.metricRects)).toEqual(["rps", "err"]);
  });

  test("edge paths for every edge, hidden ones only in defs", () => {
    expect(Object.keys(model.edgePaths).sort()).toEqual([
      "e_lb_app-1",
      "e_lb_app-2",
      "e_users_app-1",
      "e_users_lb",
    ]);
    expect(model.edgePaths["e_users_lb"]?.length).toBeGreaterThan(30);
    const svg = emit(model, noopLayer, { font: "system" });
    expect(svg).toContain('<g id="pc-test-e_e_5fusers_5flb">');
    expect(svg).not.toContain('id="pc-test-e_e_5fusers_5fapp-1"');
    expect(svg).toMatch(/<defs><path id="pc-test-ep_e_5fusers_5fapp-1" d="M/);
  });

  test("captions: step 1 visible, later steps hidden; metric values per contract", () => {
    const svg = emit(model, noopLayer, { font: "system" });
    expect(svg).toMatch(/<text id="pc-test-cap_1"[^>]*>Round robin<\/text>/);
    expect(svg).toMatch(
      /<text id="pc-test-cap_2"[^>]*visibility="hidden"[^>]*>app-2 fails<\/text>/,
    );
    // rps changes in step 2 (900), err does not change
    expect(svg).toMatch(/<text id="pc-test-mv_rps__0"(?![^>]*hidden)[^>]*>1200<\/text>/);
    expect(svg).toMatch(/<text id="pc-test-mv_rps__2"[^>]*visibility="hidden"[^>]*>900<\/text>/);
    expect(svg).toMatch(/<text id="pc-test-mv_err__0"/);
    expect(svg).not.toContain("pc-test-mv_err__2");
    expect(svg).not.toContain("pc-test-mv_rps__1");
  });

  test("objects that are siblings, never nested (rack + devices)", () => {
    const scene = loadBalancerScene();
    const rack = {
      ...scene.objects[0]!,
      id: "r1",
      box: { origin: { x: 8, y: 0, z: 0 }, size: { x: 1, y: 1, z: 2 } },
      parts: [
        {
          id: "frame",
          primitive: "cube" as const,
          box: { origin: { x: 8, y: 0, z: 0 }, size: { x: 1, y: 1, z: 2 } },
          tone: "base" as const,
        },
        {
          id: "led0",
          primitive: "cube" as const,
          box: { origin: { x: 8.1, y: 1, z: 1 }, size: { x: 0.1, y: 0.05, z: 0.1 } },
          tone: "led" as const,
        },
      ],
    };
    const dev = {
      ...scene.objects[0]!,
      id: "r1/u3",
      label: "DEV-LABEL",
      source: "dc" as const,
      box: { origin: { x: 8.1, y: 0.1, z: 0.5 }, size: { x: 0.8, y: 0.8, z: 0.1 } },
    };
    const m = buildModel({
      ...inputs(),
      scene: { ...scene, objects: [...scene.objects, rack, dev] },
    });
    const svg = emit(m, noopLayer, { font: "system" });
    expect(svg).toContain('id="pc-test-o_r1.u3"');
    expect(svg.indexOf('pc-test-o_r1"')).toBeLessThan(svg.indexOf('pc-test-o_r1.u3"'));
    // devices inside a rack are not labeled (their labels would pile up over the rack)
    expect(svg).not.toContain("DEV-LABEL");
    // LED part faces carry the led class and per-part face ids
    expect(svg).toContain(
      'id="pc-test-f_r1__led0__top" class="pc-test-face pc-test-p-led-top pc-test-led"',
    );
    // device group is not inside the rack group
    const rackGroup = /<g id="pc-test-o_r1" [^>]*>(.*?)<path id="pc-test-ov_r1"/s.exec(svg);
    expect(rackGroup?.[1]).not.toContain("pc-test-o_r1.u3");
  });
});

describe("view box and overlay layout", () => {
  const union = (rs: { x: number; y: number; width: number; height: number }[]) => {
    const x0 = Math.min(...rs.map((r) => r.x));
    const y0 = Math.min(...rs.map((r) => r.y));
    return {
      x: x0,
      y: y0,
      width: Math.max(...rs.map((r) => r.x + r.width)) - x0,
      height: Math.max(...rs.map((r) => r.y + r.height)) - y0,
    };
  };

  test("canvas.padding is in pixels and the view box hugs the drawing", () => {
    const at = (padding: number) =>
      buildModel({
        ...inputs(),
        scene: { ...loadBalancerScene(), canvas: { ...loadBalancerScene().canvas, padding } },
      }).viewBox;
    const a = at(0);
    const b = at(100);
    expect(b.width - a.width).toBeCloseTo(200, 0);
    expect(b.height - a.height).toBeCloseTo(200, 0);
    // with the default padding the view box is the drawing plus overlays plus 32px, not a huge canvas
    const m = buildModel(inputs());
    const drawing = union(Object.values(m.anchors).map((x) => x.bbox));
    expect(m.viewBox.width).toBeLessThan(drawing.width + 2 * 32 + 400);
    expect(m.viewBox.height).toBeLessThan(drawing.height + 2 * 32 + 400);
    expect(drawing.width / m.viewBox.width).toBeGreaterThan(0.4);
  });

  test("metrics, caption and legend sit inside the view box next to the drawing", () => {
    const m = buildModel(inputs());
    const vb = m.viewBox;
    const drawing = union(Object.values(m.anchors).map((x) => x.bbox));
    const inside = (r: { x: number; y: number; width: number; height: number }) => {
      expect(r.x).toBeGreaterThanOrEqual(vb.x);
      expect(r.y).toBeGreaterThanOrEqual(vb.y);
      expect(r.x + r.width).toBeLessThanOrEqual(vb.x + vb.width + 0.01);
      expect(r.y + r.height).toBeLessThanOrEqual(vb.y + vb.height + 0.01);
    };
    for (const r of Object.values(m.metricRects)) {
      inside(r);
      expect(r.y + r.height).toBeLessThanOrEqual(drawing.y); // above the drawing
    }
    const cap = m.captionRect as NonNullable<typeof m.captionRect>;
    inside(cap);
    expect(cap.y).toBeGreaterThanOrEqual(drawing.y + drawing.height); // below the drawing
    // nothing but padding sits left of / right of the content
    expect(drawing.x - vb.x).toBeLessThan(120);
  });

  test("canvas.aspect is respected", () => {
    const m = buildModel({
      ...inputs(),
      scene: {
        ...loadBalancerScene(),
        canvas: { ...loadBalancerScene().canvas, aspect: "16:9" },
      },
    });
    expect(m.viewBox.width / m.viewBox.height).toBeCloseTo(16 / 9, 1);
    const sq = buildModel({
      ...inputs(),
      scene: { ...loadBalancerScene(), canvas: { ...loadBalancerScene().canvas, aspect: "1:1" } },
    });
    expect(sq.viewBox.width / sq.viewBox.height).toBeCloseTo(1, 1);
  });
});

describe("label and overlay polish", () => {
  const svgOf = (scene = loadBalancerScene()) =>
    emit(buildModel({ ...inputs(), scene }), noopLayer, { font: "system" });

  test("caption, metric and legend groups carry ids but no transform", () => {
    const svg = svgOf();
    for (const id of ["pc-test-cap", "pc-test-m_rps", "pc-test-m_err", "pc-test-legend"]) {
      const tag = new RegExp(`<g [^>]*id="${id}"[^>]*>`).exec(svg)?.[0];
      expect(tag, id).toBeDefined();
      expect(tag).not.toContain("transform");
    }
    expect(svg).toMatch(/<g id="pc-test-legend" class="pc-test-legend">/);
  });

  test("background rect is the view box plus half its size on each side", () => {
    const m = buildModel(inputs());
    const svg = emit(m, noopLayer, { font: "system" });
    const bg =
      /<rect class="pc-test-bg" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
        svg,
      ) as RegExpExecArray;
    const [x, y, w, h] = bg.slice(1).map(Number) as [number, number, number, number];
    const vb = m.viewBox;
    expect(x).toBeCloseTo(vb.x - vb.width / 2, 1);
    expect(y).toBeCloseTo(vb.y - vb.height / 2, 1);
    expect(w).toBeCloseTo(vb.width * 2, 1);
    expect(h).toBeCloseTo(vb.height * 2, 1);
  });

  test("group labels sit outside the slab on a pill", () => {
    const m = buildModel(inputs());
    const g = m.scene.groups[0]!;
    const left = m.projection.project({
      x: g.box.origin.x,
      y: g.box.origin.y + g.box.size.y,
      z: g.box.origin.z + g.box.size.z,
    });
    const svg = emit(m, noopLayer, { font: "system" });
    const pill = /<rect class="pc-test-gpill" x="([-\d.]+)" y="[-\d.]+" width="([-\d.]+)"/.exec(
      svg,
    ) as RegExpExecArray;
    expect(Number(pill[1]) + Number(pill[2])).toBeLessThan(left.x);
    expect(svg).toMatch(/class="pc-test-glabel pc-test-tb"/);
  });

  test("arrowheads live in the labels layer, above the objects", () => {
    const svg = svgOf();
    const labels = svg.indexOf('id="pc-test-ly_labels"');
    expect(svg.indexOf('<polygon class="pc-test-arrow ')).toBeGreaterThan(labels);
    expect(svg.slice(0, labels)).not.toContain("<polygon");
  });

  test("edge labels step aside from other labels and keep a leader line", () => {
    const base = loadBalancerScene();
    const m0 = buildModel({ ...inputs(), scene: base });
    // aim the "50%" edge label exactly at the lb node label (centered under its bbox)
    const lb = m0.anchors["lb"] as { bbox: Rect; center: { x: number; y: number } };
    const target = { x: lb.center.x, y: lb.bbox.y + lb.bbox.height + 12 };
    const z = 0.05;
    const sum = (target.y + z * m0.projection.zScale) / (m0.projection.tileWidth / 4); // x + y
    const diff = target.x / (m0.projection.tileWidth / 2); // x - y
    const labelAnchor = { x: (sum + diff) / 2, y: (sum - diff) / 2, z };
    const scene = {
      ...base,
      edges: base.edges.map((e) => (e.id === "e_lb_app-1" ? { ...e, labelAnchor } : e)),
    };
    const svg = emit(buildModel({ ...inputs(), scene }), noopLayer, { font: "system" });
    const rect =
      /<rect class="pc-test-elabel" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
        svg,
      ) as RegExpExecArray;
    const [x, y, w, hh] = rect.slice(1).map(Number) as [number, number, number, number];
    const lbLabel = { x: lb.center.x - 30, y: lb.bbox.y + lb.bbox.height, width: 60, height: 16 };
    expect(rectsOverlap({ x, y, width: w, height: hh }, lbLabel)).toBe(false);
    // it moved (the unshifted box would have overlapped) and is tied back to the edge
    expect(Math.abs(y + hh / 2 - target.y)).toBeGreaterThan(8);
    expect(svg).toContain('<path class="pc-test-leader"');
  });

  test("nudgeLabel: no shift when free, a shift when blocked, stays put when boxed in", () => {
    const box = { x: 0, y: 0, width: 40, height: 16 };
    expect(nudgeLabel(box, [])).toEqual({ dy: 0, collided: false });
    const blocked = nudgeLabel(box, [{ x: 0, y: 0, width: 40, height: 16 }]);
    expect(blocked.collided).toBe(false);
    expect(blocked.dy).not.toBe(0);
    expect(rectsOverlap({ ...box, y: blocked.dy }, { x: 0, y: 0, width: 40, height: 16 })).toBe(
      false,
    );
    // everything within +-3 steps is taken: fall back to the original place
    const wall = { x: -10, y: -200, width: 80, height: 400 };
    expect(nudgeLabel(box, [wall])).toEqual({ dy: 0, collided: true });
  });

  test("arrowhead tip is the projected path end and points along the last segment", () => {
    const scene = loadBalancerScene();
    const m = buildModel({ ...inputs(), scene });
    const svg = emit(m, noopLayer, { font: "system" });
    for (const e of scene.edges.filter((x) => !x.hidden && x.arrow.end)) {
      const cls = `pc-test-e_${e.id.replaceAll("_", "_5f")}-arrow`;
      const poly = new RegExp(`<polygon class="pc-test-arrow ${cls}" points="([^"]+)"`).exec(svg);
      expect(poly, e.id).not.toBeNull();
      const [tip, b1, b2] = (poly![1] as string)
        .split(" ")
        .map((p) => p.split(",").map(Number) as [number, number]);
      const pts = e.path.map((p) => m.projection.project(p));
      const end = pts[pts.length - 1]!;
      const prev = pts[pts.length - 2]!;
      expect(tip![0]).toBeCloseTo(end.x, 1);
      expect(tip![1]).toBeCloseTo(end.y, 1);
      // direction: from the base midpoint to the tip == the last segment's direction
      const mid = [(b1![0] + b2![0]) / 2, (b1![1] + b2![1]) / 2];
      const d = [tip![0] - mid[0]!, tip![1] - mid[1]!];
      const seg = [end.x - prev.x, end.y - prev.y];
      const cross = d[0]! * seg[1]! - d[1]! * seg[0]!;
      const dot = d[0]! * seg[0]! + d[1]! * seg[1]!;
      expect(Math.abs(cross)).toBeLessThan(0.5);
      expect(dot).toBeGreaterThan(0);
      expect(Math.hypot(d[0]!, d[1]!)).toBeGreaterThanOrEqual(8);
      expect(Math.hypot(d[0]!, d[1]!)).toBeLessThanOrEqual(10);
    }
  });

  test("a zero-length last segment still gets an arrowhead along the previous one", () => {
    const base = loadBalancerScene();
    const e = base.edges[0]!;
    const last = e.path[e.path.length - 1]!;
    const scene = {
      ...base,
      edges: base.edges.map((x) => (x.id === e.id ? { ...x, path: [...e.path, last] } : x)),
    };
    const svg = emit(buildModel({ ...inputs(), scene }), noopLayer, { font: "system" });
    const poly =
      /<polygon class="pc-test-arrow pc-test-e_e_5fusers_5flb-arrow" points="([^"]+)"/.exec(
        svg,
      ) as RegExpExecArray;
    const [tip, b1, b2] = poly[1]!
      .split(" ")
      .map((q) => q.split(",").map(Number) as [number, number]);
    const proj = buildModel({ ...inputs(), scene }).projection;
    const pts = e.path.map((q) => proj.project(q));
    const end = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!; // previous distinct point (original path)
    const mid = [(b1![0] + b2![0]) / 2, (b1![1] + b2![1]) / 2];
    const d = [tip![0] - mid[0]!, tip![1] - mid[1]!];
    const seg = [end.x - prev.x, end.y - prev.y];
    expect(tip![0]).toBeCloseTo(end.x, 1);
    expect(Math.abs(d[0]! * seg[1]! - d[1]! * seg[0]!)).toBeLessThan(0.5); // parallel
    expect(d[0]! * seg[0]! + d[1]! * seg[1]!).toBeGreaterThan(0); // same direction
  });

  test("arrowheads carry a class derived from their edge id", () => {
    const svg = svgOf();
    expect(svg).toContain('<polygon class="pc-test-arrow pc-test-e_e_5fusers_5flb-arrow"');
  });

  test("group pills are part of the collision set", () => {
    const scene = loadBalancerScene();
    const m = buildModel({ ...inputs(), scene });
    const svg = emit(m, noopLayer, { font: "system" });
    const pill =
      /<rect class="pc-test-gpill" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
        svg,
      ) as RegExpExecArray;
    const [x, y, w, hh] = pill.slice(1).map(Number) as [number, number, number, number];
    const tight = { x, y, width: w, height: hh };
    for (const r of svg.matchAll(
      /<rect class="pc-test-elabel" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    )) {
      const [ex, ey, ew, eh] = r.slice(1).map(Number) as [number, number, number, number];
      expect(rectsOverlap({ x: ex, y: ey, width: ew, height: eh }, tight)).toBe(false);
    }
  });

  const iconBox = (z: number, size = 28) => {
    const scene = loadBalancerScene();
    const o = {
      ...scene.objects[0]!,
      id: "x",
      box: { origin: { x: 9, y: 0, z: 0 }, size: { x: 1, y: 1, z } },
      icon: { ref: "cosmo:lb", anchor: { x: 9.5, y: 1, z: z / 2 }, size },
    };
    const icons: IconResolver = {
      resolve: () => ({
        ref: "cosmo:lb",
        svg: { viewBox: "0 0 24 24", body: "<path d='M0 0h1'/>", monochrome: true },
        license: "x",
      }),
      defaultFor: () => undefined,
      search: () => [],
      packs: () => [],
    };
    const m = buildModel({
      ...inputs(),
      scene: { ...scene, objects: [...scene.objects, o] },
      icons,
    });
    const svg = emit(m, noopLayer, { font: "system" });
    const plate =
      /<rect class="pc-test-plate" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
        svg,
      );
    const [x, y, w, hh] = (plate?.slice(1) ?? []).map(Number) as [number, number, number, number];
    const top = m.projection.project({ x: 9.5, y: 0.5, z });
    return { m, svg, plate: { x, y, w, h: hh }, top };
  };

  test("a tall enough front face carries the icon plate, inside the face", () => {
    const { m, svg, plate } = iconBox(1.5);
    expect(svg).not.toContain("pc-test-shadow");
    const frontH = 1.5 * m.projection.zScale;
    expect(plate.h).toBeLessThanOrEqual(frontH);
    expect(plate.w - 4).toBe(28);
  });

  test("the default sm cube (height 1, icon 28) keeps its icon on the face, shrunk to fit", () => {
    const { svg, plate, m } = iconBox(1, 28);
    expect(svg).not.toContain("pc-test-shadow");
    expect(plate.w - 4).toBe(1 * m.projection.zScale - 8); // 24, >= 0.75 * 28
    expect(plate.w - 4).toBeGreaterThanOrEqual(0.75 * 28);
    // md (height 1.5, icon 36) fits at the standard size
    const md = iconBox(1.5, 36);
    expect(md.plate.w - 4).toBe(36);
    expect(md.svg).not.toContain("pc-test-shadow");
    // just below 0.75x floats at the standard size
    const short = iconBox(0.8, 28); // avail 17.6 < 21
    expect(short.svg).toContain("pc-test-shadow");
    expect(short.plate.w - 4).toBe(28);
  });

  test("a front face that is too short floats the plate over the top face at standard size", () => {
    for (const z of [0.2, 0.5]) {
      const { svg, plate, top } = iconBox(z);
      expect(plate.w - 4).toBe(28); // standard size, not shrunk
      expect(plate.x + plate.w / 2).toBeCloseTo(top.x, 1); // centred over the top face
      expect(plate.y + plate.h).toBeLessThan(top.y); // above the face centre
      expect(svg).toMatch(/<ellipse class="pc-test-shadow" cx="[-\d.]+" cy="[-\d.]+"/);
      expect(svg).not.toMatch(/<use[^>]*transform/);
    }
  });
});

describe("DC layering (D31): floors flat, cables depth-sorted, particles on top", () => {
  const dcScene = () => {
    const scene = loadBalancerScene();
    const base = scene.objects[0]!;
    const mk = (
      id: string,
      type: string,
      x: number,
      y: number,
      z: number,
      w: number,
      d: number,
      hh: number,
    ) => ({
      ...base,
      id,
      type,
      source: "dc" as const,
      label: undefined,
      icon: undefined,
      box: { origin: { x, y, z }, size: { x: w, y: d, z: hh } },
    });
    const objects = [
      mk("floor", "floor-grid", 0, 0, 0, 8, 6, 0.05),
      mk("tiles", "perforated-tiles", 1, 4, 0.05, 2, 1, 0.02),
      mk("tray", "cable-tray", 1, 2, 0.5, 5, 0.4, 0.1),
      mk("back", "rack", 3, 0, 0, 1, 1, 2),
      mk("front", "rack", 3, 3.5, 0, 1, 1, 2),
    ];
    const cable = {
      id: "c1",
      from: "back",
      to: "front",
      kind: "cable" as const,
      cableKind: "power" as const,
      style: "solid" as const,
      bidirectional: false,
      hidden: false,
      path: [
        { x: 1, y: 2.2, z: 0.62 },
        { x: 6, y: 2.2, z: 0.62 },
      ],
      arrow: { start: false, end: false },
    };
    const air = { ...cable, id: "a1", kind: "edge" as const, cableKind: undefined, hidden: true };
    return {
      ...scene,
      objects,
      groups: [
        {
          id: "dc_hall",
          kind: "hall" as const,
          style: "zone" as const,
          box: { origin: { x: -1, y: -1, z: 0 }, size: { x: 10, y: 8, z: 0.05 } },
          level: 0,
        },
        {
          id: "cold-1",
          kind: "cold-aisle" as const,
          style: "zone" as const,
          box: { origin: { x: 1, y: 3.5, z: 0.05 }, size: { x: 4, y: 2, z: 0.02 } },
          level: 1,
        },
      ],
      edges: [cable, air],
      flows: [{ id: "dc_f_1", edge: "a1", kind: "airflow" as const, rate: 2, reverse: false }],
      timeline: [],
      metrics: [],
      legend: [],
      focusTargets: {},
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 8, y: 6, z: 2 } },
    } as ReturnType<typeof loadBalancerScene>;
  };
  const particles: AnimationLayer = {
    css: "",
    defs: [],
    layers: {
      flows: [h("g", { id: "pc-test-particles" }, h("g", { id: "pc-test-fl_dc_5ff_5f1" }))],
    },
    duration: 1,
  };

  test("cable segments come after floors, trays and tiles and before objects in front", () => {
    const svg = emit(buildModel({ ...inputs(), scene: dcScene() }), particles, { font: "system" });
    const at = (needle: string) => {
      const i = svg.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const edgesLayer = at('id="pc-test-ly_edges"');
    // floor objects are flat ground: inside the groups layer, before the edges layer
    expect(at('id="pc-test-o_floor"')).toBeLessThan(edgesLayer);
    // ...and after the opaque hall and aisle slabs that would otherwise paint over them
    expect(at('id="pc-test-g_dc_5fhall"')).toBeLessThan(at('id="pc-test-o_floor"'));
    expect(at('id="pc-test-g_cold-1"')).toBeLessThan(at('id="pc-test-o_tiles"'));
    expect(at('id="pc-test-g_cold-1"')).toBeLessThan(at('id="pc-test-o_floor"'));
    expect(at('id="pc-test-o_tiles"')).toBeLessThan(edgesLayer);
    expect(at('id="pc-test-ly_groups"')).toBeLessThan(at('id="pc-test-o_floor"'));
    // trays and racks stay in the objects layer; the cable segment is sorted among them
    const seg = at('id="pc-test-e_c1__s0"');
    expect(at('id="pc-test-ly_objects"')).toBeLessThan(seg);
    expect(at('id="pc-test-o_tray"')).toBeLessThan(seg);
    expect(seg).toBeLessThan(at('id="pc-test-o_front"'));
    expect(at('id="pc-test-o_floor"')).toBeLessThan(seg);
    expect(at('id="pc-test-o_tiles"')).toBeLessThan(seg);
    // the segment is a painted cable path; the single particle path is not painted
    expect(svg).toMatch(
      /<path id="pc-test-e_c1__s0" class="pc-test-edge pc-test-edge-solid pc-test-cable-power pc-test-e_c1-seg" d="M/,
    );
    expect(svg).toMatch(/<path id="pc-test-ep_c1" fill="none" stroke="none" d="M/);
    // the objects layer holds the segment, not the edges layer
    const edgesBlock = svg.slice(edgesLayer, at('id="pc-test-ly_objects"'));
    expect(edgesBlock).not.toContain("pc-test-cable-power");
  });

  test("DC particles are drawn after the objects layer, other particles stay below it (D31)", () => {
    const both: AnimationLayer = {
      css: "@media (prefers-reduced-motion:reduce){\n#pc-test_particles{display:none}\n}",
      defs: [],
      layers: {
        flows: [
          h(
            "g",
            { id: "pc-test_particles" },
            h("g", { id: "pc-test-fl_f_5f1" }),
            h("g", { id: "pc-test-fl_dc_5ff_5f1" }),
            h("g", { id: "pc-test-fl_dc_5ff_5f2" }),
          ),
        ],
      },
      duration: 1,
    };
    const svg = emit(buildModel({ ...inputs(), scene: dcScene() }), both, { font: "system" });
    const at = (needle: string) => {
      const i = svg.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    // contract layer ids stay in contract order; the DC group is inserted after objects
    const order = [
      "background",
      "groups",
      "edges",
      "flows",
      "objects",
      "dcflows",
      "labels",
      "overlay",
    ].map((l) => at(`id="pc-test-ly_${l}"`));
    expect(order.every((i, k) => k === 0 || i > (order[k - 1] as number))).toBe(true);
    // non-DC particles are inside the flows layer (before objects), DC ones after objects
    expect(at('id="pc-test-fl_f_5f1"')).toBeLessThan(at('id="pc-test-ly_objects"'));
    expect(at('id="pc-test-fl_dc_5ff_5f1"')).toBeGreaterThan(at('id="pc-test-ly_dcflows"'));
    expect(at('id="pc-test-fl_dc_5ff_5f2"')).toBeLessThan(at('id="pc-test-ly_labels"'));
    expect(at('id="pc-test_particles_dc"')).toBeGreaterThan(at('id="pc-test-ly_objects"'));
    // reduced motion: the DC wrapper gets its own rule (animated output: duration > 0)
    expect(svg).toContain(
      "@media (prefers-reduced-motion:reduce){#pc-test_particles_dc{display:none}}",
    );
    // no duplicate ids
    const found = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] as string);
    expect(new Set(found).size).toBe(found.length);
  });

  test("frame output (no animation) adds no reduced-motion rule for the DC wrapper", () => {
    const frame: AnimationLayer = {
      css: "",
      defs: [],
      layers: {
        flows: [h("g", { id: "pc-test_particles" }, h("g", { id: "pc-test-fl_dc_5ff_5f1" }))],
      },
      duration: 0,
    };
    const svg = emit(buildModel({ ...inputs(), scene: dcScene() }), frame, { font: "system" });
    expect(svg).toContain('id="pc-test_particles_dc"');
    expect(svg).not.toContain("prefers-reduced-motion");
  });

  test("a second wrapper with DC flows is rejected", () => {
    const two: AnimationLayer = {
      css: "",
      defs: [],
      layers: {
        flows: [
          h("g", { id: "pc-test_particles" }, h("g", { id: "pc-test-fl_dc_5ff_5f1" })),
          h("g", { id: "pc-test_other" }, h("g", { id: "pc-test-fl_dc_5ff_5f2" })),
        ],
      },
      duration: 1,
    };
    expect(() =>
      emit(buildModel({ ...inputs(), scene: dcScene() }), two, { font: "system" }),
    ).toThrow(/single particles wrapper/);
  });

  test("with the real animator (loop), reduced motion hides both particle wrappers", () => {
    const m = buildModel({
      ...inputs(),
      scene: {
        ...dcScene(),
        flows: [
          ...dcScene().flows,
          { id: "f_1", edge: "a1", kind: "normal" as const, rate: 1, reverse: false },
        ],
      },
    });
    const layer = createAnimator().animate(m, { speed: 1, mode: "loop" });
    const svg = emit(m, layer, { font: "system" });
    const media = svg.slice(svg.indexOf("@media (prefers-reduced-motion:reduce)"));
    expect(svg).toContain('id="pc-test_particles_dc"');
    expect(svg).toContain('id="pc-test_particles"');
    expect(media).toContain("#pc-test_particles{display:none}");
    expect(media).toContain("#pc-test_particles_dc{display:none}");
    // the DC wrapper holds only the dc_f_ flow, the main one the other flow
    const dcBlock = /<g id="pc-test_particles_dc">([^]*?)<\/g><\/g>/.exec(svg)?.[1] ?? "";
    expect(dcBlock).toContain("pc-test-fl_dc_5ff_5f1");
    expect(dcBlock).not.toContain("pc-test-fl_f_5f1");
  });

  test("a cable that stays adjacent after sorting is one merged path", () => {
    const scene = dcScene();
    const only = {
      ...scene,
      objects: scene.objects.filter((o) => o.id === "floor"),
    };
    const svg = emit(buildModel({ ...inputs(), scene: only }), particles, { font: "system" });
    const segs = [...svg.matchAll(/<path id="pc-test-e_c1__s\d+"/g)];
    expect(segs).toHaveLength(1);
    // the merged path still runs the whole way (5 tiles = 6 points)
    expect(/<path id="pc-test-e_c1__s0"[^>]* d="([^"]+)"/.exec(svg)?.[1]?.match(/L/g)?.length).toBe(
      5,
    );
  });

  test("scenes without DC flows keep the plain contract layer order", () => {
    const plainParticles: AnimationLayer = {
      ...particles,
      layers: { flows: [h("g", { id: "pc-test_particles" }, h("g", { id: "pc-test-fl_f_5f1" }))] },
    };
    const svg = emit(buildModel(inputs()), plainParticles, { font: "system" });
    expect(svg).not.toContain("ly_dcflows");
    const order = ["background", "groups", "edges", "flows", "objects", "labels", "overlay"].map(
      (l) => svg.indexOf(`id="pc-test-ly_${l}"`),
    );
    expect(order.every((i, k) => i > 0 && (k === 0 || i > (order[k - 1] as number)))).toBe(true);
  });

  test("painted cable segments share a per-edge class", () => {
    const svg = emit(buildModel({ ...inputs(), scene: dcScene() }), particles, { font: "system" });
    const segs = [...svg.matchAll(/<path id="pc-test-e_c1__s(\d+)" class="([^"]*)"/g)];
    expect(segs.length).toBeGreaterThanOrEqual(1);
    for (const m of segs) expect(m[2]).toContain("pc-test-e_c1-seg");
  });

  test("long cable runs are split at tile boundaries before depth sorting", () => {
    expect(splitAtTiles({ x: 1, y: 2.2, z: 0.6 }, { x: 6, y: 2.2, z: 0.6 })).toHaveLength(5);
    const parts = splitAtTiles({ x: 0.5, y: 0.5, z: 0 }, { x: 2.5, y: 3.5, z: 0 });
    expect(parts[0]![0]).toEqual({ x: 0.5, y: 0.5, z: 0 });
    expect(parts[parts.length - 1]![1]).toEqual({ x: 2.5, y: 3.5, z: 0 });
    for (let i = 1; i < parts.length; i++) expect(parts[i]![0]).toEqual(parts[i - 1]![1]);
    expect(splitAtTiles({ x: 1.2, y: 1.2, z: 0 }, { x: 1.2, y: 1.2, z: 2 })).toHaveLength(1);
  });

  test("cable segment ids cannot collide with other ids", () => {
    const svg = emit(buildModel({ ...inputs(), scene: dcScene() }), particles, { font: "system" });
    const found = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] as string);
    expect(new Set(found).size).toBe(found.length);
  });
});

describe("icons", () => {
  const resolved: ResolvedIcon = {
    ref: "cosmo:lb",
    svg: { viewBox: "0 0 24 24", body: '<path id="__PCID__-0" d="M0 0h24"/>', monochrome: true },
    license: "Apache-2.0",
  };
  const icons: IconResolver = {
    resolve: (r) => (r === "cosmo:lb" ? resolved : undefined),
    defaultFor: () => undefined,
    search: () => [],
    packs: () => ["cosmo"],
  };

  test("placed upright at the anchor, symbol defined once; unknown icons warn", () => {
    const scene = loadBalancerScene();
    const objects = scene.objects.map((o) =>
      o.id === "lb"
        ? { ...o, icon: { ref: "cosmo:lb", anchor: { x: 2.5, y: 2, z: 0.4 }, size: 20 } }
        : o.id === "app-1"
          ? { ...o, icon: { ref: "nope:x", anchor: { x: 4.5, y: 1, z: 0.4 }, size: 20 } }
          : o,
    );
    const { model } = buildModel_with(objects, icons);
    const svg = emit(model.model, noopLayer, { font: "system" });
    expect(svg.match(/<symbol /g)).toHaveLength(1);
    expect(svg).toContain('<use class="pc-test-icon" href="#pc-test-i_cosmo_3alb"');
    expect(svg).not.toMatch(/<use[^>]*transform/);
    expect(model.model.scene.objects).toHaveLength(4);
    // an icon body that fails the emitter's trust check is dropped with a warning, not thrown
    const evil: IconResolver = {
      ...icons,
      resolve: () => ({ ...resolved, svg: { ...resolved.svg, body: "<script>x()</script>" } }),
    };
    const unsafe = buildModel_with(objects, evil).model;
    expect(unsafe.diagnostics.map((d) => d.code)).toContain("render/icon-unavailable");
    expect(emit(unsafe.model, noopLayer, { font: "system" })).not.toContain("<symbol");
    expect(model.diagnostics.map((d) => d.code)).toContain("render/icon-unavailable");
  });

  function buildModel_with(objects: SceneObject[], resolver: IconResolver) {
    const scene = { ...loadBalancerScene(), objects };
    return { model: buildModelWithDiagnostics({ ...inputs(), scene, icons: resolver }) };
  }
});

describe("withVariant", () => {
  test("re-prefixes every id and layer", () => {
    const tracked = buildTracked();
    const v = withVariant(tracked, "-s01");
    expect(v.ids.prefix).toBe("pc-test-s01");
    const svg = emit(v, noopLayer, { font: "system" });
    expect(svg).toContain('id="pc-test-s01-cam"');
    expect(svg).not.toContain('id="pc-test-o_');
    expect(withVariant(v, "-x").ids.prefix).toBe("pc-test-s01-x");
  });

  test("rejects bad variants and foreign models", () => {
    const tracked = buildTracked();
    expect(() => withVariant(tracked, "s01")).toThrow(/invalid id variant/);
    expect(() => withVariant(tracked, "-TOOLONG99")).toThrow();
    // models from buildModel work directly
    expect(withVariant(buildModel(inputs()), "-x").ids.prefix).toBe("pc-test-x");
    // a hand-made model that did not come from buildModel has no inputs to rebuild from
    expect(() => withVariant({ ...buildModel(inputs()) }, "-x")).toThrow(/not built/);
  });
});

function buildTracked(): RenderModel {
  return buildModel(inputs());
}

describe("render pipeline (stage fakes)", () => {
  const opts = { themes: registry, font: "system" as const };

  test("default output: one animated svg, deterministic, stats", async () => {
    const render = createRender(deps());
    const a = await render(spec, opts);
    const b = await render(spec, opts);
    expect(a.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(a.outputs).toHaveLength(1);
    const out = a.outputs[0]!;
    expect(out.kind).toBe("animated");
    expect(out.path).toBe("diagram.svg");
    expect(out.mime).toBe("image/svg+xml");
    expect(out.data).toBe(b.outputs[0]!.data);
    expect(a.stats.elements).toBeGreaterThan(50);
    expect(a.stats.bytes["diagram.svg"]).toBe(Buffer.byteLength(out.data as string));
    expect(a.scene).toBeDefined();
    expect(out.data as string).toMatch(
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" id="pc-[0-9a-f]{8}"/,
    );
    expect(out.data as string).toContain("prefers-color-scheme:dark");
  });

  test("id prefix is derived from spec + options and overridable", async () => {
    const render = createRender(deps());
    const a = await render(spec, opts);
    const b = await render({ ...spec, meta: { version: "1", title: "x" } }, opts);
    const c = await render(spec, { ...opts, idPrefix: "mine" });
    expect(/id="(pc-[0-9a-f]{8})"/.exec(a.outputs[0]!.data as string)?.[1]).not.toBe(
      /id="(pc-[0-9a-f]{8})"/.exec(b.outputs[0]!.data as string)?.[1],
    );
    expect(c.outputs[0]!.data as string).toContain('id="mine"');
    const t = fixtureTheme();
    const base = { theme: t, font: "embed", speed: 1, optimize: true };
    expect(defaultIdPrefix(spec, base)).toBe(defaultIdPrefix(spec, base));
    expect(defaultIdPrefix(spec, base)).toMatch(/^pc-[0-9a-f]{8}$/);
    expect(defaultIdPrefix(spec, { ...base, speed: 2 })).not.toBe(defaultIdPrefix(spec, base));
  });

  test("optimize:false skips svgo", async () => {
    const opt = vi.fn((s: string) => s);
    const render = createRender(deps({ optimize: opt }));
    await render(spec, { ...opts, optimize: false });
    expect(opt).not.toHaveBeenCalled();
    await render(spec, opts);
    expect(opt).toHaveBeenCalledTimes(1);
  });

  test("invalid options give diagnostics and no outputs", async () => {
    const render = createRender(deps());
    const r = await render(spec, {
      ...opts,
      idPrefix: "Bad",
      name: "a/b",
      speed: 11,
      png: { scale: 9 },
      video: { fps: 0, durationSec: 500 },
    });
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "options/invalid-id-prefix",
      "options/invalid-name",
      "options/invalid-png-scale",
      "options/invalid-speed",
      "options/invalid-video-duration",
      "options/invalid-video-fps",
    ]);
    expect(
      validateOptions({ speed: 10, png: { scale: 8 }, video: { fps: 60, durationSec: 120 } }),
    ).toEqual([]);
  });

  test("mp4 without an encoder is a programmer error", async () => {
    const render = createRender(deps());
    await expect(render(spec, { ...opts, outputs: ["mp4"] })).rejects.toThrow(/encoder/);
  });

  test("validation errors stop the pipeline; diagnostics sorted by path then code", async () => {
    const d: Diagnostic[] = [
      { severity: "error", code: "semantic/unknown-node", path: "/edges/0/to", message: "x" },
      { severity: "error", code: "schema/additional-property", path: "/a", message: "y" },
      { severity: "warning", code: "semantic/aaa", path: "/a", message: "z" },
    ];
    const render = createRender(deps({ validate: () => ({ valid: false, diagnostics: d }) }));
    const r = await render(spec, opts);
    expect(r.outputs).toEqual([]);
    expect(r.scene).toBeUndefined();
    expect(r.diagnostics.map((x) => x.code)).toEqual([
      "schema/additional-property",
      "semantic/aaa",
      "semantic/unknown-node",
    ]);
  });

  test("an invalid custom theme is a diagnostic, not an exception", async () => {
    const render = createRender(deps());
    const bad = { ...fixtureTheme(), background: "url(https://evil)" };
    const r = await render(spec, { font: "system", theme: bad });
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["render/invalid-theme"]);
  });

  test("option warnings are kept; DC gate runs after validate and reports both", async () => {
    const warn: Diagnostic = {
      severity: "warning",
      code: "options/note",
      path: "/x",
      message: "w",
    };
    const bad: Diagnostic = { severity: "error", code: "schema/x", path: "/y", message: "e" };
    const render = createRender(
      deps({
        validateOptions: () => [warn],
        validate: () => ({ valid: false, diagnostics: [bad] }),
      }),
    );
    const r = await render({ ...spec, racks: [{ id: "r" }] }, opts);
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "render/dc-pack-required",
      "options/note",
      "schema/x",
    ]);
    const ok = await createRender(deps({ validateOptions: () => [warn] }))(spec, opts);
    expect(ok.outputs).toHaveLength(1);
    expect(ok.diagnostics.map((d) => d.code)).toContain("options/note");
  });

  test("theme diagnostics point at the option that supplied the theme", async () => {
    const render = createRender(deps());
    const bad = { ...fixtureTheme(), background: "url(https://evil)" };
    const a = await render(spec, { font: "system", theme: bad });
    expect(a.diagnostics[0]?.path).toBe("/theme");
    const b = await render(spec, { font: "system", theme: fixtureTheme(), darkTheme: bad });
    expect(b.diagnostics[0]?.path).toBe("/darkTheme");
    const c = await render(spec, {
      font: "system",
      themes: { get: () => bad, list: () => ["light"] },
    });
    expect(c.diagnostics[0]?.path).toBe("/canvas/theme");
  });

  test("unexpected stage failures become render/internal-error", async () => {
    const render = createRender(
      deps({
        buildScene: () => {
          throw new Error("boom");
        },
      }),
    );
    const r = await render(spec, opts);
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["render/internal-error"]);
    expect(r.diagnostics[0]?.message).toContain("boom");
  });

  test("unknown theme and missing DC pack are diagnostics", async () => {
    const render = createRender(deps());
    const r = await render(spec, {
      font: "system",
      themes: { get: () => undefined, list: () => ["a"] },
    });
    expect(r.diagnostics.map((x) => x.code)).toContain("render/theme-unavailable");
    const dc = await render({ ...spec, racks: [{ id: "r" }] }, opts);
    expect(dc.diagnostics.map((x) => x.code)).toEqual(["render/dc-pack-required"]);
  });

  test("other outputs go through exportOutputs with a working withVariant", async () => {
    const exportOutputs: ExportFn = vi.fn((model, kinds, d, options) => {
      const variant = d.withVariant(model, "-st");
      expect(kinds).toEqual(["static", "png"]);
      expect(options.idPrefix).toBe(model.ids.prefix);
      expect(variant.ids.prefix).toBe(`${model.ids.prefix}-st`);
      const svg = d.emit(variant, noopLayer, { font: "system" });
      return Promise.resolve({
        outputs: [
          { kind: "static" as const, path: "diagram.static.svg", mime: "image/svg+xml", data: svg },
        ],
        diagnostics: [{ severity: "info" as const, code: "export/x", path: "", message: "m" }],
      });
    });
    const render = createRender(deps({ exportOutputs }));
    const r = await render(spec, { ...opts, outputs: ["animated", "static", "png"] });
    expect(exportOutputs).toHaveBeenCalledTimes(1);
    expect(r.outputs.map((o) => o.path)).toEqual(["diagram.svg", "diagram.static.svg"]);
    expect(r.diagnostics.map((d) => d.code)).toContain("export/x");
    expect(r.stats.bytes["diagram.static.svg"]).toBeGreaterThan(1000);
  });

  test("more than 5000 elements warns but still renders", async () => {
    const big = vi.fn(() => `<svg>${"<g/>".repeat(5001)}</svg>`);
    const render = createRender(deps({ emit: big, optimize: (s) => s }));
    const r = await render(spec, opts);
    expect(r.outputs).toHaveLength(1);
    expect(r.diagnostics.map((d) => d.code)).toContain("budget/elements");
  });

  test("error diagnostics from the scene or export drop all outputs", async () => {
    const scene = {
      ...loadBalancerScene(),
      diagnostics: [
        { severity: "error" as const, code: "layout/overlap", path: "/nodes/0", message: "o" },
      ],
    };
    const render = createRender(deps({ buildScene: () => scene }));
    const r = await render(spec, opts);
    expect(r.outputs).toEqual([]);
    expect(r.scene).toBeDefined();
  });
});

describe("canonical JSON and schema export", () => {
  test("dist/schema/v1.json is byte-identical to schema/v1.json (after build)", () => {
    const dist = new URL("../dist/schema/v1.json", import.meta.url);
    if (!existsSync(dist)) return; // `pnpm test` / ci build first; skipped on a bare checkout
    const src = new URL("../../../schema/v1.json", import.meta.url);
    expect(readFileSync(dist).equals(readFileSync(src))).toBe(true);
  });

  test("JCS: sorted keys, no whitespace, undefined dropped", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x\n"], c: undefined })).toBe(
      '{"a":[true,null,"x\\n"],"b":1}',
    );
    expect(() => canonicalJson(NaN)).toThrow();
  });

  test("specSchema is the bundled v1 schema", () => {
    expect(specSchema.$id).toBe(SCHEMA_ID);
    expect(specSchema["x-revision"]).toBe(SCHEMA_REVISION);
  });
});

describe("load-balancer snapshot (M1)", () => {
  test("static render with system font matches the snapshot", async () => {
    const render = createRender(deps());
    const r = await render(spec, {
      themes: registry,
      font: "system",
      idPrefix: "pc-lb",
      optimize: false,
    });
    expect(r.outputs[0]?.data).toMatchSnapshot();
    const o = await render(spec, { themes: registry, font: "system", idPrefix: "pc-lb" });
    expect((o.outputs[0]?.data as string).length).toBeLessThan(
      (r.outputs[0]?.data as string).length,
    );
  });
});
