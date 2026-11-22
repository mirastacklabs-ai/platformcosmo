import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { IconResolver, Rect, ThemeRegistry } from "../src/index.js";
import { render } from "../src/index.js";
import { createIds } from "../src/emit/ids.js";
import { measureText } from "../src/text/index.js";
import { fixtureTheme } from "./fixtures/theme.js";

const registry: ThemeRegistry = {
  get: (id) => (id === "light" || id === "dark" ? fixtureTheme(id, id === "dark") : undefined),
  list: () => ["dark", "light"],
};

/** Every node gets a simple icon, so plates (floating or on the face) are emitted and checked. */
const icons: IconResolver = {
  resolve: (ref) => ({
    ref,
    svg: { viewBox: "0 0 24 24", body: '<path d="M2 2h20v20H2z"/>', monochrome: true },
    license: "test",
  }),
  defaultFor: () => "t:icon",
  search: () => [],
  packs: () => ["t"],
};

const dir = fileURLToPath(new URL("../../../examples/", import.meta.url));
const PREFIX = "pc-t";

interface P {
  x: number;
  y: number;
}
interface Box {
  what: string;
  box: Rect;
}

const attrsOf = (s: string): Record<string, string> =>
  Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

/**
 * Everything an edge must not run under, as emitted: object labels, badge pills, floating icon
 * plates and group pills. Edge-label pills are skipped (they sit on their own edge).
 */
function emittedBoxes(svg: string): Box[] {
  const out: Box[] = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const a = attrsOf(m[1]!);
    if (a.visibility === "hidden" || !/-t-primary(?: |$)/.test(a.class ?? "")) continue;
    const x = Number(a.x);
    const y = Number(a.y);
    const size = Number(a["font-size"]);
    if (![x, y, size].every(Number.isFinite)) continue;
    const text = m[2]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const cls = a.class ?? "";
    const weight = /-tb(?: |$)/.test(cls) ? "bold" : /-tw(?: |$)/.test(cls) ? "medium" : "regular";
    const family = /-tm(?: |$)/.test(cls) ? "mono" : "display";
    const w = measureText(text, size, weight, family);
    const x0 = a["text-anchor"] === "middle" ? x - w / 2 : a["text-anchor"] === "end" ? x - w : x;
    out.push({ what: `label "${text}"`, box: { x: x0, y: y - size, width: w, height: size + 4 } });
  }
  for (const m of svg.matchAll(/<rect\b([^>]*)\/?>/g)) {
    const a = attrsOf(m[1]!);
    const kind = /-(plate|badgebox|gpill)$/.exec(a.class ?? "")?.[1];
    if (!kind) continue;
    const box = {
      x: Number(a.x),
      y: Number(a.y),
      width: Number(a.width),
      height: Number(a.height),
    };
    if (Object.values(box).every(Number.isFinite)) out.push({ what: kind, box });
  }
  return out;
}

/** Visible edge polylines exactly as emitted (`<path id=edgePath(id) d=...>`), by spec edge id. */
function emittedEdges(svg: string, ids: string[]): Map<string, P[]> {
  const scheme = createIds(PREFIX);
  const out = new Map<string, P[]>();
  for (const id of ids) {
    const m = new RegExp(
      `<path\\b[^>]*\\bid="${scheme.edgePath(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
    ).exec(svg);
    const d = m ? attrsOf(m[0]).d : undefined;
    if (!d) continue;
    // A1's absolute, compact path format: "M<x> <y>L<x> <y>L...".
    expect(d, `edge ${id} path data`).toMatch(
      /^M-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?(?:L-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?)+$/,
    );
    const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)].map((q) => ({
      x: Number(q[1]),
      y: Number(q[2]),
    }));
    out.set(id, pts);
  }
  return out;
}

function segmentHitsRect(a: P, b: P, r: Rect): boolean {
  if (
    Math.max(a.x, b.x) < r.x ||
    Math.min(a.x, b.x) > r.x + r.width ||
    Math.max(a.y, b.y) < r.y ||
    Math.min(a.y, b.y) > r.y + r.height
  )
    return false;
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    if (px > r.x && px < r.x + r.width && py > r.y && py < r.y + r.height) return true;
  }
  return false;
}

const inside = (p: P, r: Rect): boolean =>
  p.x >= r.x - 1 && p.x <= r.x + r.width + 1 && p.y >= r.y - 1 && p.y <= r.y + r.height + 1;

function crossings(edges: Map<string, P[]>, boxes: Box[]): string[] {
  const bad: string[] = [];
  for (const [id, pts] of edges) {
    const ends = [pts[0]!, pts[pts.length - 1]!];
    for (const l of boxes) {
      // A plate that holds the path's own end point belongs to the connected object.
      if (l.what === "plate" && ends.some((e) => inside(e, l.box))) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        if (segmentHitsRect(pts[i]!, pts[i + 1]!, l.box)) {
          bad.push(`${id} over ${l.what}`);
          break;
        }
      }
    }
  }
  return bad;
}

async function renderExample(raw: Record<string, unknown>) {
  const res = await render(raw, {
    themes: registry,
    icons,
    optimize: false,
    font: "system",
    idPrefix: PREFIX,
  });
  const svg = String(res.outputs[0]?.data ?? "");
  expect(res.scene, JSON.stringify(res.diagnostics)).toBeDefined();
  const visible = res.scene!.edges.filter((e) => !e.hidden).map((e) => e.id);
  return { res, svg, edges: emittedEdges(svg, visible), visible };
}

describe("no visible edge runs under a label, badge, icon plate or group pill (real render)", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".cosmo.json"))) {
    test(f, async () => {
      const raw = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as Record<string, unknown>;
      if (raw.racks || raw.equipment) return; // DC examples need the DC pack
      if (raw.assemblies || raw.storyboards) return; // 1.2.0 stories: images and shape packs come from the CLI
      const { res, svg, edges, visible } = await renderExample(raw);
      expect(edges.size, "edge paths parsed from the SVG").toBe(visible.length);
      expect(emittedBoxes(svg).length).toBeGreaterThan(0);
      expect(res.scene!.diagnostics.filter((d) => d.code === "routing/hidden-side")).toEqual([]);
      expect(res.scene!.diagnostics.filter((d) => d.code === "routing/blocked")).toEqual([]);
      // Edge-label pills sit on their own edge: drop texts equal to an edge label.
      const own = new Set(res.scene!.edges.flatMap((e) => (e.label ? [e.label] : [])));
      const boxes = emittedBoxes(svg).filter(
        (b) => ![...own].some((l) => b.what === `label "${l}"`),
      );
      expect(crossings(edges, boxes)).toEqual([]);
    });
  }

  test("positive control: a manual-pos layout forcing an edge under a label is reported", async () => {
    // C is walled in on all four sides, so no route reaches it and the fallback goes straight
    // along y = 11, right under the label of A (which sits on that line's path).
    const raw = {
      meta: { version: "1" },
      nodes: [
        { id: "a", type: "server", label: "Obstacle label long", pos: { x: 8, y: 8 } },
        { id: "b", type: "server", label: "B", pos: { x: 0, y: 10 } },
        { id: "c", type: "server", label: "C", pos: { x: 20, y: 10 } },
        { id: "w", type: "server", size: "lg", pos: { x: 17, y: 10 } },
        { id: "n", type: "server", pos: { x: 20, y: 8 } },
        { id: "s", type: "server", pos: { x: 20, y: 12 } },
        { id: "e", type: "server", pos: { x: 22, y: 10 } },
      ],
      edges: [{ id: "forced", from: "b", to: "c" }],
    };
    const { res, svg, edges } = await renderExample(raw);
    expect(res.scene!.diagnostics.map((d) => d.code)).toContain("routing/blocked");
    const bad = crossings(edges, emittedBoxes(svg));
    expect(bad.some((x) => x.startsWith("forced over label"))).toBe(true);
  });

  test("kubernetes example draws floating icon plates and badges that are checked", async () => {
    const raw = JSON.parse(
      readFileSync(`${dir}kubernetes-deployment.cosmo.json`, "utf8"),
    ) as Record<string, unknown>;
    const { svg } = await renderExample(raw);
    const kinds = new Set(emittedBoxes(svg).map((b) => b.what.split(" ")[0]));
    expect(kinds.has("plate")).toBe(true);
  });
});
