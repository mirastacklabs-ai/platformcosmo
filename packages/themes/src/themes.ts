/**
 * The four built-in themes as data. Each theme is a compact `Seed` of hand-picked colors;
 * the four-tone face shading (top / left / right / stroke) is derived with fixed mixing
 * factors so every solid in a theme shades consistently. Everything is computed at module
 * load with pure arithmetic, so output is deterministic.
 */
import type {
  FaceTones,
  NodeCategory,
  PaletteName,
  PartTone,
  ThemeId,
  ThemeTokens,
} from "@platformcosmo/core";
import { mix } from "./color.js";

interface Shade {
  /** Mix of the base toward `lift` for the top face. */
  readonly top: number;
  readonly lift: string;
  /** Mix of the base toward `sink` for the right face. */
  readonly right: number;
  readonly sink: string;
  /** Mix of the base toward `strokeTo` for the outline. */
  readonly stroke: number;
  readonly strokeTo: string;
}

interface Seed {
  readonly id: ThemeId;
  readonly name: string;
  readonly colorScheme: "light" | "dark";
  readonly background: string;
  readonly gridStroke: string;
  readonly gridOpacity: number;
  readonly text: readonly [primary: string, secondary: string, inverse: string];
  readonly family: string;
  readonly shade: Shade;
  readonly palette: Readonly<Record<PaletteName, string>>;
  readonly categories: Readonly<Record<NodeCategory, string>>;
  readonly parts: Readonly<Record<PartTone, string>>;
  readonly groupFill: string;
  readonly groupStroke: string;
  readonly groupLabel: string;
  readonly groupOpacity: number;
  readonly edge: {
    readonly stroke: string;
    readonly labelFill: string;
    readonly labelText: string;
  };
  readonly flows: ThemeTokens["flows"];
  readonly states: ThemeTokens["states"];
  readonly metric: ThemeTokens["metric"];
  readonly caption: ThemeTokens["caption"];
  readonly badge: ThemeTokens["badge"];
  readonly icon: ThemeTokens["icon"];
  readonly dc: ThemeTokens["dc"];
}

function tones(base: string, s: Shade): FaceTones {
  return {
    top: mix(base, s.lift, s.top),
    left: base,
    right: mix(base, s.sink, s.right),
    stroke: mix(base, s.strokeTo, s.stroke),
  };
}

function mapTones<K extends string>(
  colors: Readonly<Record<K, string>>,
  s: Shade,
): Readonly<Record<K, FaceTones>> {
  const out = {} as Record<K, FaceTones>;
  for (const k of Object.keys(colors).sort() as K[]) out[k] = tones(colors[k], s);
  return out;
}

const DASH = Object.freeze({ solid: "", dashed: "6 4", dotted: "1.5 4" } as const);

function build(s: Seed): ThemeTokens {
  const g = {
    fill: s.groupFill,
    stroke: s.groupStroke,
    label: s.groupLabel,
    opacity: s.groupOpacity,
  };
  return {
    id: s.id,
    name: s.name,
    colorScheme: s.colorScheme,
    background: s.background,
    grid: { stroke: s.gridStroke, opacity: s.gridOpacity },
    text: { primary: s.text[0], secondary: s.text[1], inverse: s.text[2] },
    font: {
      family: s.family,
      label: 12,
      badge: 10,
      caption: 14,
      title: 20,
      weightRegular: 400,
      weightBold: 700,
    },
    palette: s.palette,
    categories: mapTones(s.categories, s.shade),
    parts: mapTones(s.parts, s.shade),
    groups: {
      zone: g,
      vpc: { ...g, opacity: Math.min(1, s.groupOpacity + 0.02) },
      cluster: { ...g, opacity: Math.min(1, s.groupOpacity + 0.04) },
      platform: { ...g, opacity: Math.min(1, s.groupOpacity + 0.06) },
    },
    edge: { ...s.edge, width: 1.6, dash: DASH },
    flows: s.flows,
    states: s.states,
    metric: s.metric,
    caption: s.caption,
    badge: s.badge,
    icon: s.icon,
    dc: s.dc,
  };
}

const FONT = "Inter, ui-sans-serif, system-ui, sans-serif";

const light: Seed = {
  id: "light",
  name: "Light",
  colorScheme: "light",
  background: "#f7f8fa",
  gridStroke: "#d5dae3",
  gridOpacity: 0.6,
  text: ["#1b2433", "#4a5568", "#ffffff"],
  family: FONT,
  shade: {
    top: 0.28,
    lift: "#ffffff",
    right: 0.22,
    sink: "#0f172a",
    stroke: 0.45,
    strokeTo: "#0f172a",
  },
  palette: {
    blue: "#3b82f6",
    green: "#22a06b",
    red: "#e5484d",
    orange: "#f08a24",
    yellow: "#e6b800",
    purple: "#8b5cf6",
    teal: "#14a3a3",
    pink: "#e2559c",
    gray: "#8793a6",
  },
  categories: {
    compute: "#5b8def",
    network: "#2bb3b3",
    data: "#3fae7a",
    client: "#9aa6b8",
    observability: "#e9a23b",
    cicd: "#7c6ff0",
    security: "#e2585f",
    ai: "#c067d8",
    dc: "#7d8ba1",
  },
  parts: {
    base: "#47505f",
    accent: "#5b8def",
    muted: "#a3adbd",
    glass: "#bfe3f5",
    metal: "#dfe4ec",
    led: "#22c55e",
    floor: "#e3e7ee",
    perforated: "#b9c2d0",
  },
  groupFill: "#3b82f6",
  groupStroke: "#7a92b8",
  groupLabel: "#2d3a52",
  groupOpacity: 0.06,
  edge: { stroke: "#64748b", labelFill: "#ffffff", labelText: "#334155" },
  flows: {
    normal: "#2f6fe4",
    heavy: "#7c3aed",
    health: "#16a34a",
    failed: "#dc2626",
    airflow: "#0891b2",
    power: "#ea580c",
  },
  states: {
    healthy: { overlay: "#00000000", stroke: "#00000000", opacity: 1 },
    degraded: { overlay: "#f59e0b59", stroke: "#d97706", opacity: 1 },
    down: { overlay: "#ef444466", stroke: "#dc2626", opacity: 0.8 },
    highlighted: { overlay: "#3b82f633", stroke: "#2563eb", opacity: 1 },
  },
  metric: { fill: "#ffffff", stroke: "#cbd5e1", label: "#475569", value: "#0f172a" },
  caption: { fill: "#1f2937", text: "#f9fafb" },
  badge: { fill: "#1f2937", text: "#ffffff" },
  icon: { color: "#1f2937", plate: "#ffffff" },
  dc: {
    led: { ok: "#4ade80", warn: "#fbbf24", fail: "#ffa3a3" },
    cable: { power: "#e5484d", network: "#3b82f6", fiber: "#e6b800", management: "#8793a6" },
    coldAisle: "#7dd3fc",
    hotAisle: "#fdba74",
    containment: "#94a3b8",
    hall: "#e2e8f0",
  },
};

const dark: Seed = {
  id: "dark",
  name: "Dark",
  colorScheme: "dark",
  background: "#0f1420",
  gridStroke: "#2a3345",
  gridOpacity: 0.7,
  text: ["#e6ebf4", "#a3aec2", "#0b0f17"],
  family: FONT,
  shade: {
    top: 0.18,
    lift: "#ffffff",
    right: 0.3,
    sink: "#000000",
    stroke: 0.55,
    strokeTo: "#000000",
  },
  palette: {
    blue: "#5b9dff",
    green: "#3ccf8e",
    red: "#ff6b70",
    orange: "#ff9f47",
    yellow: "#f5c518",
    purple: "#a78bfa",
    teal: "#2dd4d4",
    pink: "#f472b6",
    gray: "#94a3b8",
  },
  categories: {
    compute: "#3f6fd0",
    network: "#1f9a9a",
    data: "#2f9468",
    client: "#6b788d",
    observability: "#c98a2c",
    cicd: "#6a5de0",
    security: "#c9484f",
    ai: "#a455c0",
    dc: "#5d6b82",
  },
  parts: {
    base: "#3a4558",
    accent: "#3f6fd0",
    muted: "#2c3547",
    glass: "#2d5870",
    metal: "#556075",
    led: "#22c55e",
    floor: "#1d2535",
    perforated: "#2f3a4f",
  },
  groupFill: "#5b9dff",
  groupStroke: "#4a5d80",
  groupLabel: "#c3cee2",
  groupOpacity: 0.08,
  edge: { stroke: "#8fa0bb", labelFill: "#1a2233", labelText: "#d3dbea" },
  flows: {
    normal: "#6aa8ff",
    heavy: "#b79cff",
    health: "#4ade80",
    failed: "#ff6b6b",
    airflow: "#22d3ee",
    power: "#fb923c",
  },
  states: {
    healthy: { overlay: "#00000000", stroke: "#00000000", opacity: 1 },
    degraded: { overlay: "#f59e0b59", stroke: "#fbbf24", opacity: 1 },
    down: { overlay: "#ef444473", stroke: "#f87171", opacity: 0.8 },
    highlighted: { overlay: "#5b9dff40", stroke: "#93c5fd", opacity: 1 },
  },
  metric: { fill: "#182033", stroke: "#334158", label: "#a3aec2", value: "#f1f5f9" },
  caption: { fill: "#e6ebf4", text: "#0f1420" },
  badge: { fill: "#e6ebf4", text: "#0b0f17" },
  icon: { color: "#e6ebf4", plate: "#222c40" },
  dc: {
    led: { ok: "#4ade80", warn: "#fbbf24", fail: "#f87171" },
    cable: { power: "#ff6b70", network: "#5b9dff", fiber: "#f5c518", management: "#94a3b8" },
    coldAisle: "#38bdf8",
    hotAisle: "#fb923c",
    containment: "#64748b",
    hall: "#1a2132",
  },
};

const blueprint: Seed = {
  id: "blueprint",
  name: "Blueprint",
  colorScheme: "dark",
  background: "#0b3a6b",
  gridStroke: "#6aa5dc",
  gridOpacity: 0.3,
  text: ["#eaf4ff", "#bcd8f3", "#08294d"],
  family: FONT,
  shade: {
    top: 0.16,
    lift: "#ffffff",
    right: 0.28,
    sink: "#000000",
    stroke: 0.75,
    strokeTo: "#ffffff",
  },
  palette: {
    blue: "#7fb8ff",
    green: "#7fe0b5",
    red: "#ff9a9a",
    orange: "#ffc183",
    yellow: "#ffe27a",
    purple: "#c4b0ff",
    teal: "#73e0e6",
    pink: "#ffa8d2",
    gray: "#b8c9dc",
  },
  categories: {
    compute: "#1f66ad",
    network: "#17798f",
    data: "#1b7a78",
    client: "#3a6d9c",
    observability: "#2f6fa8",
    cicd: "#3a62b5",
    security: "#2a5f9e",
    ai: "#4a5db0",
    dc: "#2b5f93",
  },
  parts: {
    base: "#1d5d9b",
    accent: "#2f86d6",
    muted: "#164e84",
    glass: "#2c7fb3",
    metal: "#3c78ad",
    led: "#22c55e",
    floor: "#0f4579",
    perforated: "#195a92",
  },
  groupFill: "#9cc8f5",
  groupStroke: "#8fbbe8",
  groupLabel: "#d6e8fb",
  groupOpacity: 0.05,
  edge: { stroke: "#cfe4fa", labelFill: "#08294d", labelText: "#eaf4ff" },
  flows: {
    normal: "#9fd0ff",
    heavy: "#d3c4ff",
    health: "#8ff0c0",
    failed: "#ffa6a6",
    airflow: "#8aeaf0",
    power: "#ffc98f",
  },
  states: {
    healthy: { overlay: "#00000000", stroke: "#00000000", opacity: 1 },
    degraded: { overlay: "#ffd36659", stroke: "#ffd366", opacity: 1 },
    down: { overlay: "#ff7a7a66", stroke: "#ff9a9a", opacity: 0.8 },
    highlighted: { overlay: "#ffffff33", stroke: "#ffffff", opacity: 1 },
  },
  metric: { fill: "#0a3262", stroke: "#6aa5dc", label: "#bcd8f3", value: "#ffffff" },
  caption: { fill: "#eaf4ff", text: "#08294d" },
  badge: { fill: "#eaf4ff", text: "#08294d" },
  icon: { color: "#eaf4ff", plate: "#12497f" },
  dc: {
    led: { ok: "#6ee7a8", warn: "#ffd366", fail: "#ffa3a3" },
    cable: { power: "#ff9a9a", network: "#9fd0ff", fiber: "#ffe27a", management: "#b8c9dc" },
    coldAisle: "#7fd8ff",
    hotAisle: "#ffb27a",
    containment: "#9cc8f5",
    hall: "#0d4175",
  },
};

const mono: Seed = {
  id: "mono",
  name: "Monochrome",
  colorScheme: "light",
  background: "#ffffff",
  gridStroke: "#d4d4d4",
  gridOpacity: 0.6,
  text: ["#111111", "#454545", "#ffffff"],
  family: FONT,
  shade: {
    top: 0.35,
    lift: "#ffffff",
    right: 0.25,
    sink: "#000000",
    stroke: 0.6,
    strokeTo: "#000000",
  },
  palette: {
    blue: "#4d4d4d",
    green: "#737373",
    red: "#1a1a1a",
    orange: "#595959",
    yellow: "#a6a6a6",
    purple: "#666666",
    teal: "#808080",
    pink: "#8c8c8c",
    gray: "#bdbdbd",
  },
  categories: {
    compute: "#9a9a9a",
    network: "#b4b4b4",
    data: "#808080",
    client: "#c8c8c8",
    observability: "#a6a6a6",
    cicd: "#8c8c8c",
    security: "#6e6e6e",
    ai: "#7a7a7a",
    dc: "#bababa",
  },
  parts: {
    base: "#e8e8e8",
    accent: "#7a7a7a",
    muted: "#e0e0e0",
    glass: "#ececec",
    metal: "#dadada",
    led: "#4d4d4d",
    floor: "#efefef",
    perforated: "#d0d0d0",
  },
  groupFill: "#000000",
  groupStroke: "#6b6b6b",
  groupLabel: "#222222",
  groupOpacity: 0.04,
  edge: { stroke: "#4d4d4d", labelFill: "#ffffff", labelText: "#222222" },
  flows: {
    normal: "#333333",
    heavy: "#000000",
    health: "#6e6e6e",
    failed: "#7f7f7f",
    airflow: "#919191",
    power: "#555555",
  },
  states: {
    healthy: { overlay: "#00000000", stroke: "#00000000", opacity: 1 },
    degraded: { overlay: "#00000040", stroke: "#555555", opacity: 1 },
    down: { overlay: "#00000073", stroke: "#000000", opacity: 0.6 },
    highlighted: { overlay: "#ffffff66", stroke: "#000000", opacity: 1 },
  },
  metric: { fill: "#ffffff", stroke: "#8c8c8c", label: "#454545", value: "#000000" },
  caption: { fill: "#111111", text: "#ffffff" },
  badge: { fill: "#111111", text: "#ffffff" },
  icon: { color: "#111111", plate: "#ffffff" },
  dc: {
    led: { ok: "#595959", warn: "#333333", fail: "#000000" },
    cable: { power: "#1a1a1a", network: "#5c5c5c", fiber: "#999999", management: "#c2c2c2" },
    coldAisle: "#d9d9d9",
    hotAisle: "#a8a8a8",
    containment: "#808080",
    hall: "#ededed",
  },
};

/** Recursively freezes plain data so shared themes cannot be mutated by consumers. */
export function deepFreeze<T>(v: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof v === "object" && v !== null && !seen.has(v)) {
    seen.add(v);
    Object.freeze(v);
    // Recurse even into already-frozen objects: a shallow freeze may hide mutable children.
    for (const x of Object.values(v)) deepFreeze(x, seen);
  }
  return v;
}

export const builtinThemes: Readonly<Record<ThemeId, ThemeTokens>> = deepFreeze({
  light: build(light),
  dark: build(dark),
  blueprint: build(blueprint),
  mono: build(mono),
});
