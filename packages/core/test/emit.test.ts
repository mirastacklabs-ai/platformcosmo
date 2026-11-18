import { describe, expect, test } from "vitest";
import type {
  AnimationLayer,
  EmitOptions,
  Layer,
  RenderModel,
  SceneGraph,
  SvgNode,
} from "../src/contracts/index.js";
import { ICON_DEF_TAG, countElements, createIds, emit, h, serialize } from "../src/emit/index.js";
import { createProjection } from "../src/geometry/index.js";
import { fixtureTheme } from "./fixtures/theme.js";

const scene: SceneGraph = {
  meta: { title: 'T <&> "q"', description: "Desc" },
  canvas: { theme: "light", grid: true, padding: 2, aspect: "auto" },
  objects: [],
  groups: [],
  edges: [
    {
      id: "e_a_b",
      from: "a",
      to: "b",
      kind: "edge",
      style: "solid",
      bidirectional: false,
      hidden: true,
      path: [],
      arrow: { start: false, end: false },
    },
  ],
  flows: [],
  metrics: [],
  legend: [],
  timeline: [],
  focusTargets: {},
  bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
  diagnostics: [],
};

const noLayers = (): Record<Layer, SvgNode[]> => ({
  background: [],
  groups: [],
  edges: [],
  flows: [],
  objects: [],
  labels: [],
  overlay: [],
});

function model(layers: Partial<Record<Layer, SvgNode[]>> = {}, dark = true): RenderModel {
  return {
    scene,
    theme: fixtureTheme("light"),
    ...(dark ? { darkTheme: fixtureTheme("dark", true) } : {}),
    projection: createProjection(),
    ids: createIds("pc-test"),
    viewBox: { x: 0, y: 0, width: 100, height: 50 },
    layers: { ...noLayers(), ...layers },
    edgePaths: { e_a_b: { edgeId: "e_a_b", d: "M0 0L10 10", points: [], length: 14 } },
    anchors: {},
    focusRects: {},
    metricRects: {},
    font: "embed",
    fontAssets: [],
  };
}

const noAnim: AnimationLayer = { css: "", defs: [], layers: {}, duration: 0 };
const browser: EmitOptions = { font: "embed" };

const label = (extra: Record<string, string | number> = {}) =>
  h(
    "text",
    { id: "pc-test-lbl", x: 10, y: 20, "font-size": 12, class: "pc-test-t-primary", ...extra },
    "Load <balancer> & co",
  );

describe("emit structure", () => {
  const svg = emit(model(), noAnim, browser);

  test("root element, a11y, viewBox only", () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" id="pc-test" role="img"')).toBe(
      true,
    );
    expect(svg).toContain('viewBox="0 0 100 50"');
    expect(svg).toContain('aria-labelledby="pc-test-title pc-test-desc"');
    expect(svg).not.toMatch(/<svg[^>]* (width|height)=/);
    expect(svg).toContain('<title id="pc-test-title">T &lt;&amp;&gt; "q"</title>');
    expect(svg).toContain('<desc id="pc-test-desc">Desc</desc>');
  });

  test("one CDATA style, camera wraps all layers in order", () => {
    expect(svg.match(/<style>/g)).toHaveLength(1);
    expect(svg).toContain("<style><![CDATA[");
    const cam = svg.indexOf('<g id="pc-test-cam">');
    expect(cam).toBeGreaterThan(0);
    const order = ["background", "groups", "edges", "flows", "objects", "labels", "overlay"].map(
      (l) => svg.indexOf(`id="pc-test-ly_${l}"`),
    );
    expect(order.every((p, i) => p > cam && (i === 0 || p > (order[i - 1] as number)))).toBe(true);
  });

  test("theme variables scoped to the root, dark overrides in a media query", () => {
    expect(svg).toContain("#pc-test{--pc-background:#f7f8fa;");
    expect(svg).toContain("--pc-categories-compute-top:#3b82f6");
    expect(svg).toContain("--pc-edge-dash-solid:none");
    expect(svg).toContain("--pc-font-weightBold:700");
    const media = /@media \(prefers-color-scheme:dark\)\{#pc-test\{([^}]*)\}\}/.exec(svg);
    expect(media?.[1]).toContain("--pc-background:#101418");
    expect(media?.[1]).not.toContain("--pc-font-");
    expect(svg).not.toContain(":root");
  });

  test("base state rules per contract", () => {
    expect(svg).toContain(".pc-test-s-down{opacity:var(--pc-states-down-opacity)}");
    expect(svg).toContain(
      ".pc-test-s-down>.pc-test-overlay{fill:var(--pc-states-down-overlay);stroke:var(--pc-states-down-stroke)}",
    );
    expect(svg).toContain(".pc-test-s-degraded .pc-test-led{fill:var(--pc-dc-led-warn)}");
    expect(svg).toContain(".pc-test-s-highlighted .pc-test-led{fill:var(--pc-dc-led-ok)}");
  });

  test("hidden edges become paths in defs", () => {
    expect(svg).toContain('<defs><path id="pc-test-ep_e_a_b" d="M0 0L10 10"/></defs>');
  });

  test("no darkTheme means no media query", () => {
    expect(emit(model({}, false), noAnim, browser)).not.toContain("@media");
  });

  test("deterministic and counted", () => {
    expect(emit(model(), noAnim, browser)).toBe(svg);
    expect(countElements(svg)).toBeGreaterThan(10);
  });

  test("animation css, defs, layers and script are appended", () => {
    const anim: AnimationLayer = {
      css: "#pc-test-x{opacity:1}",
      defs: [h("g", { id: "pc-test-d" })],
      layers: { flows: [h("g", { id: "pc-test-particles" })] },
      script: "var a=1;",
      duration: 4,
      viewBox: { x: 1, y: 2, width: 30, height: 40 },
    };
    const out = emit(model(), anim, browser);
    expect(out).toContain('viewBox="1 2 30 40"');
    expect(out).toContain("#pc-test-x{opacity:1}");
    expect(out).toContain('<g id="pc-test-d"/>');
    expect(out).toContain(
      '<g id="pc-test-ly_flows" class="pc-test-layer"><g id="pc-test-particles"/>',
    );
    expect(out).toContain("<script><![CDATA[var a=1;]]></script>");
  });
});

describe("rules for used classes only", () => {
  test("class rules are generated from tokens in the tree", () => {
    const out = emit(
      model({
        objects: [h("path", { class: "pc-test-face pc-test-k-compute-top", d: "M0 0Z" })],
        labels: [label()],
      }),
      noAnim,
      browser,
    );
    expect(out).toContain(
      ".pc-test-k-compute-top{fill:var(--pc-categories-compute-top);stroke:var(--pc-categories-compute-stroke)}",
    );
    expect(out).toContain(".pc-test-t-primary{fill:var(--pc-text-primary)}");
    expect(out).not.toContain(".pc-test-k-network-top");
  });
});

describe("fonts", () => {
  test("embed adds a WOFF2 @font-face named Inter only when text is present", () => {
    const withText = emit(model({ labels: [label()] }), noAnim, browser);
    expect(withText).toMatch(/@font-face\{font-family:"Inter";[^}]*data:font\/woff2;base64,/);
    expect(withText).not.toContain("font-weight:700;src");
    const bold = emit(
      model({ labels: [label({ class: "pc-test-t-primary pc-test-tb" })] }),
      noAnim,
      browser,
    );
    expect(bold).toContain("font-weight:700;src");
    expect(emit(model(), noAnim, browser)).not.toContain("@font-face");
  });

  test("system mode embeds nothing; text content is escaped", () => {
    const out = emit(model({ labels: [label()] }), noAnim, { font: "system" });
    expect(out).not.toContain("@font-face");
    expect(out).toContain("Load &lt;balancer&gt; &amp; co</text>");
  });

  test("outline mode turns text into paths and keeps id, class and visibility", () => {
    const out = emit(
      model({ labels: [label({ visibility: "hidden", "text-anchor": "middle" })] }),
      noAnim,
      { font: "outline" },
    );
    expect(out).not.toContain("<text");
    expect(out).not.toContain("@font-face");
    expect(out).toMatch(
      /<path id="pc-test-lbl" class="pc-test-t-primary" visibility="hidden" d="M/,
    );
  });
});

describe("raster target", () => {
  const anim: AnimationLayer = {
    css: "#pc-test-a{fill:var(--pc-flows-normal)}@keyframes k{0%{opacity:0}100%{opacity:1}}@media (prefers-reduced-motion:reduce){#pc-test-a{display:none}}",
    defs: [],
    layers: {},
    duration: 1,
  };
  const out = emit(
    model({
      objects: [h("rect", { style: "fill:var(--pc-palette-blue)", id: "r" })],
      labels: [label()],
    }),
    anim,
    { font: "embed", target: "raster" },
  );

  test("literal values only: no var(), media, keyframes or font-face", () => {
    expect(out).not.toContain("var(");
    expect(out).not.toContain("@media");
    expect(out).not.toContain("@keyframes");
    expect(out).not.toContain("@font-face");
    expect(out).not.toContain("--pc-");
    expect(out).toContain("#pc-test-a{fill:#3b82f6}");
    expect(out).toContain("fill:#3b82f6");
    expect(out).toContain(".pc-test-s-down{opacity:0.7}");
  });
});

describe("icons", () => {
  const def = (ref: string, body: string) => h(ICON_DEF_TAG, { ref, viewBox: "0 0 24 24" }, body);
  const body =
    '<defs><linearGradient id="__PCID__-0"/></defs><path fill="url(#__PCID__-0)" d="M0 0h1"/><use href="#__PCID__"/>';

  test("symbols are hoisted into defs, ids replaced, duplicates dropped", () => {
    const out = emit(
      model({
        background: [
          def("cosmo:lb", body),
          def("cosmo:lb", body),
          def("lucide:server", '<path d="M0 0"/>'),
        ],
      }),
      noAnim,
      browser,
    );
    const id = createIds("pc-test").icon("cosmo:lb");
    expect(id).toBe("pc-test-i_cosmo_3alb");
    expect(out.match(new RegExp(`<symbol id="${id}"`, "g"))).toHaveLength(1);
    expect(out).toContain(`<linearGradient id="${id}_0"/>`);
    expect(out).toContain(`fill="url(#${id}_0)"`);
    expect(out).toContain(`<use href="#${id}"/>`);
    expect(out).not.toContain("__PCID__");
    expect(out).not.toContain(ICON_DEF_TAG);
    expect(out.indexOf("<symbol")).toBeLessThan(out.indexOf("<style>"));
  });
});

describe("security", () => {
  test("serializer rejects external refs, handlers, bad names, url()", () => {
    expect(() => serialize(h("use", { href: "https://x/y.svg" }))).toThrow();
    expect(() => serialize(h("use", { "xlink:href": "data:text/plain,1" }))).toThrow();
    expect(() => serialize(h("rect", { onclick: "x()" }))).toThrow();
    expect(() => serialize(h("rect", { "bad name": "1" }))).toThrow();
    expect(() => serialize(h("1bad"))).toThrow();
    expect(() => serialize(h("rect", { fill: "url(http://x/y)" }))).toThrow();
    expect(serialize(h("rect", { fill: "url(#g)", href: "#a" }))).toBe(
      '<rect fill="url(#g)" href="#a"/>',
    );
  });

  test("escapes text and attributes, strips invalid XML characters and lone surrogates", () => {
    const s = serialize(h("text", { title: "a\"<&'" }, `x<y>&\u0000\ud800z\u{1F600}`));
    expect(s).toBe('<text title="a&quot;&lt;&amp;&apos;">x&lt;y&gt;&amp;z\u{1F600}</text>');
  });

  test("numbers are rounded to two decimals", () => {
    expect(serialize(h("rect", { x: 1.23456, y: -0.001, width: 3 }))).toBe(
      '<rect x="1.23" y="0" width="3"/>',
    );
  });

  test("CSS that would close the CDATA section is rejected", () => {
    expect(() => emit(model(), { ...noAnim, css: "a{}]]>b" }, browser)).toThrow();
  });

  test("invalid theme values are rejected", () => {
    const bad = model();
    const theme = { ...bad.theme, background: "url(https://evil)" };
    expect(() => emit({ ...bad, theme }, noAnim, browser)).toThrow();
    const fam = { ...bad.theme, font: { ...bad.theme.font, family: "Inter;}body{x:y" } };
    expect(() => emit({ ...bad, theme: fam }, noAnim, browser)).toThrow();
    const dash = {
      ...bad.theme,
      edge: { ...bad.theme.edge, dash: { ...bad.theme.edge.dash, dashed: "1;2" } },
    };
    expect(() => emit({ ...bad, theme: dash }, noAnim, browser)).toThrow();
  });
});
