import type {
  FaceTones,
  NodeCategory,
  ObjectState,
  PartTone,
  ThemeTokens,
} from "../../src/contracts/index.js";

const tones = (base: string): FaceTones => ({
  top: `#${base}`,
  left: `#${base.split("").reverse().join("")}`,
  right: `#${base}${base}`.slice(0, 7),
  stroke: "#222222",
});

const CATEGORIES: NodeCategory[] = [
  "compute",
  "network",
  "data",
  "client",
  "observability",
  "cicd",
  "security",
  "ai",
  "dc",
];
const PARTS: PartTone[] = [
  "base",
  "accent",
  "muted",
  "glass",
  "metal",
  "led",
  "floor",
  "perforated",
];
const STATES: ObjectState[] = ["healthy", "degraded", "down", "highlighted"];

/** A complete, valid theme used by tests (not a design: values are arbitrary). */
export function fixtureTheme(id = "light", dark = false): ThemeTokens {
  const bg = dark ? "#101418" : "#f7f8fa";
  const fg = dark ? "#e8edf3" : "#1b2433";
  const c = (h: string) => h;
  const group = { fill: c("#8899aa"), stroke: c("#667788"), label: fg, opacity: 0.2 };
  return {
    id,
    name: id,
    colorScheme: dark ? "dark" : "light",
    background: bg,
    grid: { stroke: "#cccccc", opacity: 0.5 },
    text: { primary: fg, secondary: "#667788", inverse: "#ffffff" },
    font: {
      family: 'Oswald, "Arial Narrow", Arial, sans-serif',
      mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      label: 12,
      badge: 10,
      caption: 14,
      title: 20,
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
    categories: Object.fromEntries(
      CATEGORIES.map((k, i) => [k, tones(["3b82f6", "22c55e", "ef4444"][i % 3] as string)]),
    ) as ThemeTokens["categories"],
    parts: Object.fromEntries(PARTS.map((k) => [k, tones("9ca3af")])) as ThemeTokens["parts"],
    groups: { zone: group, vpc: group, cluster: group, platform: group },
    edge: {
      stroke: "#475569",
      width: 1.6,
      labelFill: bg,
      labelText: fg,
      dash: { solid: "", dashed: "6 4", dotted: "1.5 4" },
    },
    flows: {
      normal: "#3b82f6",
      heavy: "#f97316",
      health: "#22c55e",
      failed: "#ef4444",
      airflow: "#38bdf8",
      power: "#eab308",
    },
    states: Object.fromEntries(
      STATES.map((s) => [
        s,
        {
          overlay: s === "down" ? "rgba(239,68,68,0.3)" : "rgba(0,0,0,0)",
          stroke: s === "healthy" ? "rgba(0,0,0,0)" : "#ef4444",
          opacity: s === "down" ? 0.7 : 1,
        },
      ]),
    ) as ThemeTokens["states"],
    metric: { fill: "#ffffff", stroke: "#cbd5e1", label: "#64748b", value: fg },
    caption: { fill: "#0f172a", text: "#ffffff" },
    badge: { fill: "#0f172a", text: "#ffffff" },
    icon: { color: fg, plate: "#ffffff" },
    dc: {
      led: { ok: "#22c55e", warn: "#eab308", fail: "#ef4444" },
      cable: { power: "#ef4444", network: "#3b82f6", fiber: "#f59e0b", management: "#6b7280" },
      coldAisle: "#bae6fd",
      hotAisle: "#fed7aa",
      containment: "#94a3b8",
      hall: "#e2e8f0",
    },
  };
}
