/**
 * Fixture RenderModel and a minimal test-only emitter (Track B builds against these until
 * Track A's render pipeline lands). Not shipped; mirrors the SVG structure documented in
 * `contracts/render.ts`.
 */
import type {
  AnimationLayer,
  EmitOptions,
  FontAsset,
  IdScheme,
  Layer,
  ObjectState,
  Rect,
  RenderModel,
  SceneEdge,
  SceneFlow,
  SceneGraph,
  SceneObject,
  SvgElement,
  SvgNode,
  ThemeTokens,
} from "../../../src/contracts/index.js";

const tones = (top: string, left: string, right: string, stroke = "#334155") => ({
  top,
  left,
  right,
  stroke,
});
const cat = tones("#93c5fd", "#60a5fa", "#3b82f6");

export const lightTheme: ThemeTokens = {
  id: "light",
  name: "Light",
  colorScheme: "light",
  background: "#ffffff",
  grid: { stroke: "#e2e8f0", opacity: 0.6 },
  text: { primary: "#0f172a", secondary: "#475569", inverse: "#ffffff" },
  font: {
    family: 'Oswald, "Arial Narrow", Arial, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
    label: 12,
    badge: 9,
    caption: 14,
    title: 18,
    weightRegular: 400,
    weightBold: 700,
  },
  palette: {
    blue: "#3b82f6",
    green: "#22c55e",
    red: "#ef4444",
    orange: "#f97316",
    yellow: "#eab308",
    purple: "#a855f7",
    teal: "#14b8a6",
    pink: "#ec4899",
    gray: "#6b7280",
  },
  categories: {
    compute: cat,
    network: cat,
    data: cat,
    client: cat,
    observability: cat,
    cicd: cat,
    security: cat,
    ai: cat,
    dc: cat,
  },
  parts: {
    base: cat,
    accent: cat,
    muted: cat,
    glass: cat,
    metal: cat,
    led: tones("#22c55e", "#16a34a", "#15803d"),
    floor: cat,
    perforated: cat,
  },
  groups: {
    zone: { fill: "#f1f5f9", stroke: "#cbd5e1", label: "#475569", opacity: 0.8 },
    vpc: { fill: "#f1f5f9", stroke: "#cbd5e1", label: "#475569", opacity: 0.8 },
    cluster: { fill: "#f1f5f9", stroke: "#cbd5e1", label: "#475569", opacity: 0.8 },
    platform: { fill: "#f1f5f9", stroke: "#cbd5e1", label: "#475569", opacity: 0.8 },
  },
  edge: {
    stroke: "#64748b",
    width: 2,
    labelFill: "#ffffff",
    labelText: "#0f172a",
    dash: { solid: "", dashed: "6 4", dotted: "2 4" },
  },
  flows: {
    normal: "#2563eb",
    heavy: "#ea580c",
    health: "#16a34a",
    failed: "#dc2626",
    airflow: "#0891b2",
    power: "#ca8a04",
  },
  states: {
    healthy: { overlay: "rgba(0,0,0,0)", stroke: "#334155", opacity: 1 },
    degraded: { overlay: "rgba(234,179,8,0.35)", stroke: "#ca8a04", opacity: 1 },
    down: { overlay: "rgba(239,68,68,0.45)", stroke: "#dc2626", opacity: 0.6 },
    highlighted: { overlay: "rgba(59,130,246,0.25)", stroke: "#2563eb", opacity: 1 },
  },
  metric: { fill: "#ffffff", stroke: "#cbd5e1", label: "#475569", value: "#0f172a" },
  caption: { fill: "#0f172a", text: "#ffffff" },
  badge: { fill: "#0f172a", text: "#ffffff" },
  icon: { color: "#0f172a", plate: "#ffffff" },
  dc: {
    led: { ok: "#22c55e", warn: "#eab308", fail: "#ef4444" },
    cable: { power: "#f97316", network: "#3b82f6", fiber: "#a855f7", management: "#6b7280" },
    coldAisle: "#bae6fd",
    hotAisle: "#fecaca",
    containment: "#94a3b8",
    hall: "#f1f5f9",
  },
};

export const darkTheme: ThemeTokens = {
  ...lightTheme,
  id: "dark",
  name: "Dark",
  colorScheme: "dark",
  background: "#0f172a",
  text: { primary: "#f1f5f9", secondary: "#94a3b8", inverse: "#0f172a" },
};

export function makeIds(prefix: string): IdScheme {
  const enc = (s: string) => s.replaceAll("/", ".");
  return {
    prefix,
    root: () => `${prefix}-root`,
    title: () => `${prefix}-title`,
    desc: () => `${prefix}-desc`,
    camera: () => `${prefix}-camera`,
    object: (id) => `${prefix}-o-${enc(id)}`,
    face: (id, face, part) => `${prefix}-f-${enc(id)}-${face}${part ? `-${part}` : ""}`,
    overlay: (id) => `${prefix}-ov-${enc(id)}`,
    group: (id) => `${prefix}-g-${enc(id)}`,
    edge: (id) => `${prefix}-e-${enc(id)}`,
    edgePath: (id) => `${prefix}-ep-${enc(id)}`,
    flow: (id) => `${prefix}-fl-${enc(id)}`,
    icon: (ref) => `${prefix}-i-${ref.replace(":", "-")}`,
    caption: () => `${prefix}-cap`,
    legend: () => `${prefix}-legend`,
    captionStep: (n) => `${prefix}-cap-${n}`,
    metric: (id) => `${prefix}-m-${enc(id)}`,
    metricValue: (id, n) => `${prefix}-mv-${enc(id)}-${n}`,
    stateClass: (s) => `${prefix}-s-${s}`,
    ledClass: () => `${prefix}-led`,
    sel: (id) => `#${id.replace(/([^A-Za-z0-9_-])/g, "\\$1")}`,
  };
}

const el = (
  tag: string,
  attrs: Record<string, string | number> = {},
  children: readonly SvgNode[] = [],
): SvgElement => ({ tag, attrs, children });

interface Fx {
  id: string;
  x: number;
  y: number;
  led?: boolean;
  state?: ObjectState;
}
const FX: Fx[] = [
  { id: "a", x: 60, y: 120, led: true },
  { id: "b", x: 260, y: 180 },
  { id: "c", x: 460, y: 120 },
];

export const FIXTURE_VIEWBOX: Rect = { x: 0, y: 0, width: 560, height: 320 };

function objectNode(ids: IdScheme, o: Fx): SvgElement {
  const { x, y } = o;
  const top = `M${x} ${y} l40 -20 l40 20 l-40 20 Z`;
  const left = `M${x} ${y} l40 20 v40 l-40 -20 Z`;
  const right = `M${x + 80} ${y} l-40 20 v40 l40 -20 Z`;
  const led = `M${x + 8} ${y + 14} h8 v4 h-8 Z`;
  return el("g", { id: ids.object(o.id), class: ids.stateClass(o.state ?? "healthy") }, [
    el("path", { id: ids.face(o.id, "top"), d: top, fill: "#93c5fd", stroke: "#334155" }),
    el("path", { id: ids.face(o.id, "left"), d: left, fill: "#60a5fa", stroke: "#334155" }),
    el("path", { id: ids.face(o.id, "right"), d: right, fill: "#3b82f6", stroke: "#334155" }),
    ...(o.led
      ? [el("path", { id: ids.face(o.id, "top", "led"), class: ids.ledClass(), d: led })]
      : []),
    el("path", {
      id: ids.overlay(o.id),
      class: `${ids.prefix}-overlay`,
      d: `${top} ${left} ${right}`,
    }),
  ]);
}

function sceneFor(): SceneGraph {
  const obj = (o: Fx): SceneObject => ({
    id: o.id,
    source: "node",
    type: "server",
    category: "compute",
    primitive: "cube",
    box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
    label: o.id.toUpperCase(),
    state: "healthy",
    ...(o.led
      ? {
          parts: [
            {
              id: "led",
              primitive: "cube" as const,
              box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 0.1, y: 0.1, z: 0.1 } },
              tone: "led" as const,
            },
          ],
        }
      : {}),
  });
  const edge = (id: string, from: string, to: string, hidden = false): SceneEdge => ({
    id,
    from,
    to,
    kind: "edge",
    style: "solid",
    bidirectional: false,
    hidden,
    path: [],
    arrow: { start: false, end: true },
  });
  const flow = (id: string, edgeId: string, rate: number, reverse = false): SceneFlow => ({
    id,
    edge: edgeId,
    kind: "normal",
    rate,
    reverse,
  });
  const f1 = flow("f_1", "e1", 1.5);
  const f2 = flow("s2_f_2", "e2", 1, true);
  const step = (index: number, extra: Partial<SceneGraph["timeline"][number]>) => ({
    index,
    duration: 3,
    states: {},
    flows: [],
    metrics: {},
    ...extra,
  });
  return {
    meta: { title: "Fixture", description: "Fixture diagram" },
    canvas: { theme: "light", grid: false, padding: 2, aspect: "auto" },
    objects: FX.map(obj),
    groups: [],
    edges: [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("h1", "a", "c", true)],
    flows: [f1],
    metrics: [{ id: "rps", label: "RPS", value: 100 }],
    legend: [],
    timeline: [
      step(1, { caption: "Traffic flows", flows: [f1], focus: "b" }),
      step(2, {
        caption: "B goes down",
        flows: [f1, f2],
        states: { b: "down" },
        metrics: { rps: 40 },
      }),
      step(3, {
        caption: "Recovered",
        duration: 2,
        flows: [f2],
        states: { b: "healthy" },
        metrics: { rps: 40 },
      }),
    ],
    focusTargets: {},
    bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
    diagnostics: [],
  };
}

export interface FixtureOptions {
  readonly prefix?: string;
  /** Drop the timeline (and step flows): a plain diagram with base flows. */
  readonly noSteps?: boolean;
  /** Drop every flow and the timeline: nothing animates. */
  readonly noFlows?: boolean;
  readonly theme?: ThemeTokens;
}

export function buildFixture(opts: FixtureOptions = {}): RenderModel {
  const prefix = opts.prefix ?? "pc-test";
  const ids = makeIds(prefix);
  let scene = sceneFor();
  if (opts.noSteps) scene = { ...scene, timeline: [] };
  if (opts.noFlows) scene = { ...scene, timeline: [], flows: [] };
  const edgeEnds: Record<string, [number, number, number, number]> = {
    e1: [100, 140, 300, 200],
    e2: [300, 200, 500, 140],
    h1: [100, 140, 500, 140],
  };
  const edgePaths: Record<string, RenderModel["edgePaths"][string]> = {};
  for (const [id, [x1, y1, x2, y2]] of Object.entries(edgeEnds)) {
    edgePaths[id] = {
      edgeId: id,
      d: `M${x1} ${y1} L${x2} ${y2}`,
      points: [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
      length: Math.hypot(x2 - x1, y2 - y1),
    };
  }
  const captions = scene.timeline.map((s, i) =>
    el(
      "text",
      {
        id: ids.captionStep(i + 1),
        x: 20,
        y: 24,
        ...(i === 0 ? {} : { visibility: "hidden" }),
      },
      [s.caption ?? ""],
    ),
  );
  const metricTexts = [
    el("text", { id: ids.metricValue("rps", 0), x: 20, y: 300 }, ["100"]),
    ...(scene.timeline.length > 0
      ? [el("text", { id: ids.metricValue("rps", 2), x: 20, y: 300, visibility: "hidden" }, ["40"])]
      : []),
  ];
  const layers: Record<Layer, SvgNode[]> = {
    background: [el("rect", { class: `${prefix}-bg`, width: 560, height: 320 })],
    groups: [],
    edges: ["e1", "e2"].map((id) =>
      el("g", { id: ids.edge(id) }, [
        el("path", {
          id: ids.edgePath(id),
          d: edgePaths[id]!.d,
          fill: "none",
          stroke: "#64748b",
          "stroke-width": 2,
        }),
      ]),
    ),
    flows: [],
    objects: FX.map((o) => objectNode(ids, o)),
    labels: [...captions, ...metricTexts],
    overlay: [],
  };
  return {
    scene,
    theme: opts.theme ?? lightTheme,
    darkTheme,
    projection: { tileWidth: 64, zScale: 32, project: (p) => ({ x: p.x, y: p.y }) },
    ids,
    viewBox: FIXTURE_VIEWBOX,
    layers,
    edgePaths,
    anchors: {},
    focusRects: { b: { x: 250, y: 160, width: 100, height: 80 } },
    metricRects: {},
    font: "system",
    fontAssets: [],
  };
}

/** Test-only variant: re-prefix ids by rebuilding the fixture. */
export function withVariant(model: RenderModel, variant: string): RenderModel {
  const next = buildFixture({
    prefix: model.ids.prefix + variant,
    theme: model.theme,
    ...(model.scene.timeline.length === 0 ? { noSteps: true } : {}),
  });
  return { ...next, scene: model.scene };
}

// ---------------------------------------------------------------------------------------------
// Minimal emitter (test-only)
// ---------------------------------------------------------------------------------------------

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function serialize(node: SvgNode): string {
  if (typeof node === "string") return esc(node);
  if ("raw" in node) return node.raw;
  const attrs = Object.entries(node.attrs ?? {})
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");
  const kids = (node.children ?? []).map(serialize).join("");
  return kids ? `<${node.tag}${attrs}>${kids}</${node.tag}>` : `<${node.tag}${attrs}/>`;
}

function flatten(prefix: string, v: unknown, out: Map<string, string>): void {
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      flatten(`${prefix}-${k}`, x, out);
    }
  } else if (typeof v === "string" || typeof v === "number") out.set(prefix, String(v));
}

function themeVars(theme: ThemeTokens): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(theme)) flatten(`--pc-${k}`, v, out);
  return out;
}

/** Removes `@media`/`@keyframes`/`@font-face` blocks (balanced braces), as raster emit does. */
export function stripAtRules(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "@") {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      let depth = 1;
      let j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      i = j;
    } else {
      out += css[i];
      i++;
    }
  }
  return out;
}

export function emit(model: RenderModel, anim: AnimationLayer, options: EmitOptions): string {
  const { ids, theme } = model;
  const vars = themeVars(theme);
  const raster = options.target === "raster";
  const varBlock = `${ids.sel(ids.root())}{${[...vars].map(([k, v]) => `${k}:${v}`).join(";")}}`;
  const dark = model.darkTheme
    ? `@media (prefers-color-scheme:dark){${ids.sel(ids.root())}{${[...themeVars(model.darkTheme)]
        .map(([k, v]) => `${k}:${v}`)
        .join(";")}}}`
    : "";
  const base = Object.keys(theme.states)
    .map(
      (s) =>
        `.${ids.stateClass(s)}{opacity:var(--pc-states-${s}-opacity)}` +
        `.${ids.stateClass(s)}>.${ids.prefix}-overlay{fill:var(--pc-states-${s}-overlay);stroke:var(--pc-states-${s}-stroke)}` +
        `.${ids.stateClass(s)} .${ids.ledClass()}{fill:var(--pc-dc-led-${s === "degraded" ? "warn" : s === "down" ? "fail" : "ok"})}`,
    )
    .join("\n");
  const bg = `.${ids.prefix}-bg{fill:var(--pc-background)}`;
  let css = [varBlock, dark, base, bg, anim.css].filter(Boolean).join("\n");
  if (raster) {
    css = stripAtRules(css);
    css = css.replace(/^#[^{]*\{--pc-[^}]*\}/m, "");
    css = css.replace(/var\((--pc-[a-z0-9-]+)\)/gi, (_, name: string) => vars.get(name) ?? "#000");
  }
  const layerOrder: Layer[] = [
    "background",
    "groups",
    "edges",
    "flows",
    "objects",
    "labels",
    "overlay",
  ];
  const hidden = model.scene.edges.filter((e) => e.hidden);
  const body = layerOrder.map((l) =>
    el("g", { class: `${ids.prefix}-layer-${l}` }, [...model.layers[l], ...(anim.layers[l] ?? [])]),
  );
  const vb = anim.viewBox ?? model.viewBox;
  const defs = [
    ...hidden.map((e) => el("path", { id: ids.edgePath(e.id), d: model.edgePaths[e.id]?.d ?? "" })),
    ...anim.defs,
  ];
  const svg = el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      id: ids.root(),
      role: "img",
      viewBox: `${vb.x} ${vb.y} ${vb.width} ${vb.height}`,
    },
    [
      el("title", { id: ids.title() }, [model.scene.meta.title ?? ""]),
      el("desc", { id: ids.desc() }, [model.scene.meta.description ?? ""]),
      el("defs", {}, defs),
      { tag: "style", children: [{ raw: `<![CDATA[${css}]]>` } as unknown as SvgNode] },
      el("g", { id: ids.camera() }, body),
      ...(anim.script
        ? [
            {
              tag: "script",
              children: [{ raw: `<![CDATA[${anim.script}]]>` } as unknown as SvgNode],
            },
          ]
        : []),
    ],
  );
  return serialize(svg);
}

export const noFonts: readonly FontAsset[] = [];
