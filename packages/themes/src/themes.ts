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
      family: DISPLAY_FONT,
      mono: MONO_FONT,
      label: 12,
      badge: 10,
      caption: 14,
      title: 20,
      weightRegular: 400,
      weightBold: 600,
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
    edge: { ...s.edge, width: 2.2, dash: DASH },
    flows: s.flows,
    states: s.states,
    metric: s.metric,
    caption: s.caption,
    badge: s.badge,
    icon: s.icon,
    dc: s.dc,
  };
}

// D51: MiraStack Labs brand fonts, embedded by the engine; the rest of each list is the
// `font: system` fallback.
const DISPLAY_FONT = 'Oswald, "Arial Narrow", Arial, sans-serif';
const MONO_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const light: Seed = {
  id: "light",
  name: "Light",
  colorScheme: "light",
  // MiraStack Labs brand (D51): --bg, --line, --text, --muted, --accent, --signal.
  background: "#ffffff",
  gridStroke: "#e4e2dc",
  gridOpacity: 0.9,
  text: ["#1c1c1c", "#5e5e5e", "#ffffff"],
  shade: {
    top: 0.22,
    lift: "#ffffff",
    right: 0.2,
    sink: "#0a0a0a",
    stroke: 0.4,
    strokeTo: "#0a0a0a",
  },
  palette: {
    blue: "#3d6f8f",
    green: "#22a06b",
    red: "#dc3b3f",
    orange: "#ff671f",
    yellow: "#e6b800",
    purple: "#6b5b95",
    teal: "#00695f",
    pink: "#b5547c",
    gray: "#8a8a86",
  },
  // Neutral ink/grey solids plus teal as the primary family; orange is reserved for emphasis.
  categories: {
    compute: "#00695f",
    network: "#4fb3a8",
    data: "#3a3a3a",
    client: "#b9b7b0",
    observability: "#7a7a76",
    cicd: "#1f8f82",
    security: "#0a0a0a",
    ai: "#2f5f5a",
    dc: "#a4aaa6",
  },
  parts: {
    base: "#3a3a3a",
    accent: "#00695f",
    muted: "#b9b7b0",
    glass: "#cfe6e3",
    metal: "#dcdad3",
    led: "#22c55e",
    floor: "#ecebe6",
    perforated: "#c9c7be",
  },
  groupFill: "#007a6e",
  groupStroke: "#a9a69c",
  groupLabel: "#1c1c1c",
  groupOpacity: 0.05,
  edge: { stroke: "#4a4a4a", labelFill: "#ffffff", labelText: "#1c1c1c" },
  flows: {
    normal: "#00695f",
    heavy: "#fa5f14",
    health: "#16a34a",
    failed: "#dc2626",
    airflow: "#0f9fa8",
    power: "#a16207",
  },
  states: {
    healthy: { overlay: "#00000000", stroke: "#00000000", opacity: 1 },
    degraded: { overlay: "#ff671f40", stroke: "#ff671f", opacity: 1 },
    down: { overlay: "#ef444466", stroke: "#dc2626", opacity: 0.8 },
    highlighted: { overlay: "#ffffff59", stroke: "#0a0a0a", opacity: 1 },
  },
  metric: { fill: "#ffffff", stroke: "#cfcdc5", label: "#4a4a4a", value: "#0a0a0a" },
  caption: { fill: "#0a0a0a", text: "#ffffff" },
  badge: { fill: "#00695f", text: "#ffffff" },
  icon: { color: "#1c1c1c", plate: "#ffffff" },
  dc: {
    led: { ok: "#4ade80", warn: "#fbbf24", fail: "#ffa3a3" },
    cable: { power: "#e8590c", network: "#00695f", fiber: "#4fb3a8", management: "#8a8a86" },
    coldAisle: "#9fdcd4",
    hotAisle: "#ffb48a",
    containment: "#8f8f8f",
    hall: "#f6f5f1",
  },
};

const dark: Seed = {
  id: "dark",
  name: "Dark",
  colorScheme: "dark",
  background: "#0a0a0a",
  gridStroke: "#272727",
  gridOpacity: 0.9,
  text: ["#e6e6e6", "#a0a0a0", "#0a0a0a"],
  shade: {
    top: 0.16,
    lift: "#ffffff",
    right: 0.3,
    sink: "#000000",
    stroke: 0.5,
    strokeTo: "#000000",
  },
  palette: {
    blue: "#6aa5c7",
    green: "#3ccf8e",
    red: "#ff6b70",
    orange: "#ff671f",
    yellow: "#f5c518",
    purple: "#a592d6",
    teal: "#2bd4bf",
    pink: "#e07aa5",
    gray: "#8f8f8f",
  },
  categories: {
    compute: "#14867a",
    network: "#2bd4bf",
    data: "#555555",
    client: "#a0a0a0",
    observability: "#747474",
    cicd: "#4fa89d",
    security: "#d9d9d9",
    ai: "#2f7d74",
    dc: "#8a928e",
  },
  parts: {
    base: "#2e2e2e",
    accent: "#14867a",
    muted: "#262626",
    glass: "#1f4a46",
    metal: "#555555",
    led: "#22c55e",
    floor: "#161616",
    perforated: "#242424",
  },
  groupFill: "#2bd4bf",
  groupStroke: "#3d3d3d",
  groupLabel: "#e6e6e6",
  groupOpacity: 0.06,
  edge: { stroke: "#9a9a9a", labelFill: "#0a0a0a", labelText: "#e6e6e6" },
  flows: {
    normal: "#2bd4bf",
    heavy: "#ff671f",
    health: "#4ade80",
    failed: "#ff6b6b",
    airflow: "#5ad7e6",
    power: "#fbbf24",
  },
  states: {
    healthy: { overlay: "#00000000", stroke: "#00000000", opacity: 1 },
    degraded: { overlay: "#ff671f4d", stroke: "#ff671f", opacity: 1 },
    down: { overlay: "#ef444473", stroke: "#f87171", opacity: 0.8 },
    highlighted: { overlay: "#ffffff33", stroke: "#ffffff", opacity: 1 },
  },
  metric: { fill: "#191919", stroke: "#3a3a3a", label: "#a0a0a0", value: "#ffffff" },
  caption: { fill: "#1c1c1c", text: "#e6e6e6" },
  badge: { fill: "#2bd4bf", text: "#0a0a0a" },
  icon: { color: "#e6e6e6", plate: "#222222" },
  dc: {
    led: { ok: "#4ade80", warn: "#fbbf24", fail: "#f87171" },
    cable: { power: "#ff671f", network: "#2bd4bf", fiber: "#7fe8da", management: "#8f8f8f" },
    coldAisle: "#2bb3a3",
    hotAisle: "#ff8a4a",
    containment: "#6b6b6b",
    hall: "#141414",
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
