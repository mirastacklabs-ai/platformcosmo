import { describe, expect, test, vi } from "vitest";
import type {
  AnimationLayer,
  Diagnostic,
  ExportFn,
  RenderModel,
  ResolvedIcon,
  IconResolver,
  SceneObject,
  ThemeRegistry,
} from "../src/contracts/index.js";
import { emit } from "../src/emit/index.js";
import { optimize } from "../src/optimize/index.js";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import {
  buildTrackedModel,
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
      expect(svg).toContain(`id="pc-test-f_${o.id}_top"`);
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
    expect(svg).toContain('<g id="pc-test-e_e_users_lb">');
    expect(svg).not.toContain('id="pc-test-e_e_users_app-1"');
    expect(svg).toMatch(/<defs><path id="pc-test-ep_e_users_app-1" d="M/);
  });

  test("captions: step 1 visible, later steps hidden; metric values per contract", () => {
    const svg = emit(model, noopLayer, { font: "system" });
    expect(svg).toMatch(/<text id="pc-test-cap_1"[^>]*>Round robin<\/text>/);
    expect(svg).toMatch(
      /<text id="pc-test-cap_2"[^>]*visibility="hidden"[^>]*>app-2 fails<\/text>/,
    );
    // rps changes in step 2 (900), err does not change
    expect(svg).toMatch(/<text id="pc-test-mv_rps_0"(?![^>]*hidden)[^>]*>1200<\/text>/);
    expect(svg).toMatch(/<text id="pc-test-mv_rps_2"[^>]*visibility="hidden"[^>]*>900<\/text>/);
    expect(svg).toMatch(/<text id="pc-test-mv_err_0"/);
    expect(svg).not.toContain("pc-test-mv_err_2");
    expect(svg).not.toContain("pc-test-mv_rps_1");
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
    // LED part faces carry the led class and per-part face ids
    expect(svg).toContain(
      'id="pc-test-f_r1_led0_top" class="pc-test-face pc-test-p-led-top pc-test-led"',
    );
    // device group is not inside the rack group
    const rackGroup = /<g id="pc-test-o_r1" [^>]*>(.*?)<path id="pc-test-ov_r1"/s.exec(svg);
    expect(rackGroup?.[1]).not.toContain("pc-test-o_r1.u3");
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
    expect(() => withVariant(buildModel(inputs()), "-x")).toThrow(/not built/);
  });
});

function buildTracked(): RenderModel {
  return buildTrackedModel(inputs()).model;
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
