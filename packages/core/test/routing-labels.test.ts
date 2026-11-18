import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Rect, ThemeRegistry, Vec3 } from "../src/index.js";
import { render } from "../src/index.js";
import { createProjection } from "../src/geometry/projection.js";
import { measureText } from "../src/text/index.js";
import { fixtureTheme } from "./fixtures/theme.js";

const registry: ThemeRegistry = {
  get: (id) => (id === "light" || id === "dark" ? fixtureTheme(id, id === "dark") : undefined),
  list: () => ["dark", "light"],
};

const dir = fileURLToPath(new URL("../../../examples/", import.meta.url));

/** Label text boxes exactly as emitted (object labels, group labels, badges, edge-label pills). */
function labelBoxes(svg: string): { text: string; box: Rect }[] {
  const out: { text: string; box: Rect }[] = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1]!;
    if (/visibility="hidden"/.test(attrs)) continue;
    // Object labels only; group labels and edge-label pills are placed by A1 around the routes.
    if (!/class="[^"]*-t-primary/.test(attrs)) continue;
    const num = (k: string): number | undefined => {
      const v = new RegExp(`\\b${k}="([-0-9.]+)"`).exec(attrs);
      return v ? Number(v[1]) : undefined;
    };
    const x = num("x");
    const y = num("y");
    const size = num("font-size");
    if (x === undefined || y === undefined || size === undefined) continue;
    const text = m[2]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const w = measureText(text, size);
    const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? "start";
    const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
    out.push({ text, box: { x: x0, y: y - size, width: w, height: size + 4 } });
  }
  return out;
}

function segmentHitsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: Rect,
): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  // Edges are axis-aligned in world space, hence diagonal on screen: test by sampling.
  if (x1 < r.x || x0 > r.x + r.width || y1 < r.y || y0 > r.y + r.height) return false;
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    if (px > r.x && px < r.x + r.width && py > r.y && py < r.y + r.height) return true;
  }
  return false;
}

describe("no visible edge segment crosses an emitted label box (real render pipeline)", () => {
  const proj = createProjection();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".cosmo.json"))) {
    test(f, async () => {
      const raw = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as Record<string, unknown>;
      if (raw.racks || raw.equipment) return; // DC examples need the DC pack
      const res = await render(raw, { themes: registry, optimize: false, font: "system" });
      const svg = String(res.outputs[0]?.data ?? "");
      expect(res.scene, JSON.stringify(res.diagnostics)).toBeDefined();
      const labels = labelBoxes(svg);
      expect(labels.length).toBeGreaterThan(0);
      const bad: string[] = [];
      for (const e of res.scene!.edges) {
        if (e.hidden) continue;
        const pts = e.path.map((p: Vec3) => proj.project(p));
        for (const l of labels) {
          if (e.label !== undefined && l.text === e.label) continue; // the pill sits on its own edge
          for (let i = 0; i + 1 < pts.length; i++) {
            if (segmentHitsRect(pts[i]!, pts[i + 1]!, l.box)) {
              bad.push(`${e.id} over "${l.text}"`);
              break;
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});
