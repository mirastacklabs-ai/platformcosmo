import { describe, expect, test } from "vitest";
import type { Box3, ThemeRegistry } from "../src/index.js";
import { render } from "../src/index.js";
import { labelFontSize, labelFontSizeFor, measureText } from "../src/text/index.js";
import { fixtureTheme } from "./fixtures/theme.js";

describe("labelFontSize", () => {
  test("is the base size up to 1x and clamps at 2.2x", () => {
    expect(labelFontSize(0, 12)).toBe(12);
    expect(labelFontSize(1000, 12)).toBe(12);
    expect(labelFontSize(1200, 12)).toBe(12);
    expect(labelFontSize(100_000, 12)).toBeCloseTo(26.4, 6);
    expect(labelFontSize(100_000, 14)).toBeCloseTo(30.8, 6);
  });

  test("rounds width / 100 to whole pixels", () => {
    expect(labelFontSize(1349, 12)).toBe(13);
    expect(labelFontSize(1350, 12)).toBe(14);
    expect(labelFontSize(1649, 12)).toBe(16);
    expect(labelFontSize(1650, 12)).toBe(17);
  });

  test("depends on geometry only: boxes in, same size out; no boxes gives the base", () => {
    const box = (x: number, y: number): Box3 => ({
      origin: { x, y, z: 0 },
      size: { x: 1, y: 1, z: 1 },
    });
    expect(labelFontSizeFor([], 14)).toBe(14);
    const wide = [box(0, 0), box(60, 0)];
    expect(labelFontSizeFor(wide, 12)).toBe(labelFontSizeFor([...wide].reverse(), 12));
    expect(labelFontSizeFor(wide, 12)).toBeGreaterThan(12);
    // Same boxes, bigger base: never smaller than the base, never above 2.2x.
    expect(labelFontSizeFor(wide, 20)).toBeGreaterThanOrEqual(20);
    expect(labelFontSizeFor(wide, 12)).toBeLessThanOrEqual(26.4);
  });
});

const theme14 = (id: string, dark: boolean) => {
  const t = fixtureTheme(id, dark);
  return { ...t, font: { ...t.font, label: 14 } };
};
const registry: ThemeRegistry = {
  get: (id) => (id === "light" || id === "dark" ? theme14(id, id === "dark") : undefined),
  list: () => ["dark", "light"],
};

/** A dense row of nodes, four tiles apart: labels must not collide even at a large scale. */
const wideSpec = (n: number) => ({
  meta: { version: "1" },
  nodes: Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    type: "server",
    label: `Server ${String(i + 1).padStart(2, "0")}`,
    pos: { x: i * 4, y: 0 },
  })),
});

const attrs = (s: string): Record<string, string> =>
  Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

describe("wide scenes", () => {
  test("keep-out and render share one scale; text grows; labels stay inside the viewBox", async () => {
    const res = await render(wideSpec(24), {
      themes: registry,
      optimize: false,
      font: "system",
      idPrefix: "pc-w",
    });
    expect(res.scene, JSON.stringify(res.diagnostics)).toBeDefined();
    const scene = res.scene!;
    const expected = labelFontSizeFor(
      [...scene.objects.map((o) => o.box), ...scene.groups.map((g) => g.box)],
      14,
    );
    expect(expected / 14).toBeGreaterThanOrEqual(1.8);

    const svg = String(res.outputs[0]?.data ?? "");
    const vb = /viewBox="([^"]+)"/.exec(svg)![1]!.split(/\s+/).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const boxes: { x0: number; x1: number; y0: number; y1: number; text: string }[] = [];
    for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
      const a = attrs(m[1]!);
      if (!/-t-primary/.test(a.class ?? "")) continue;
      const size = Number(a["font-size"]);
      expect(size).toBeCloseTo(expected, 1);
      const w = measureText(m[2]!, size, "medium");
      const x = Number(a.x);
      const x0 = a["text-anchor"] === "middle" ? x - w / 2 : x;
      boxes.push({ x0, x1: x0 + w, y0: Number(a.y) - size, y1: Number(a.y), text: m[2]! });
    }
    expect(boxes.length).toBe(24);
    for (const b of boxes) {
      expect(b.x0, b.text).toBeGreaterThanOrEqual(vb[0]);
      expect(b.x1, b.text).toBeLessThanOrEqual(vb[0] + vb[2]);
      expect(b.y0, b.text).toBeGreaterThanOrEqual(vb[1]);
      expect(b.y1, b.text).toBeLessThanOrEqual(vb[1] + vb[3]);
    }
    const hits: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        if (overlap) hits.push(`${a.text} / ${b.text}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
