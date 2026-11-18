import { describe, expect, test } from "vitest";
import type { LoadedIconPack } from "../src/index.js";
import { createIconResolver, iconCost, sanitizeSvg } from "../src/icons/index.js";
import { sanitizedCost } from "../src/icons/sanitize.js";

const wrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;

function ok(input: string, opts?: Parameters<typeof sanitizeSvg>[1]) {
  const r = sanitizeSvg(input, opts);
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r;
}

const mk = (id: string, files: Record<string, string>): LoadedIconPack => ({
  manifest: {
    manifestVersion: 1,
    pack: { id, name: id, version: "1", license: "MIT", source: "x", redistributable: true },
    icons: Object.keys(files).map((i) => ({
      id: i,
      aliases: [],
      category: "general" as const,
      file: i,
      monochrome: false,
    })),
  },
  files,
});

const timeBest = (s: string): number => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    sanitizeSvg(s, { maxBytes: 70_000 });
    best = Math.min(best, performance.now() - t);
  }
  return best;
};

describe("url( floods stay linear", () => {
  const flood = "url(#".repeat(12000);

  test("in a style rule", { timeout: 30_000 }, () => {
    expect(
      timeBest(wrap(`<style>.a{fill:${flood}}</style><path class="a" d="M0 0"/>`)),
    ).toBeLessThan(200);
  });

  test("in an attribute, and with a huge id", { timeout: 30_000 }, () => {
    expect(timeBest(wrap(`<path d="M0 0" fill="${flood}"/>`))).toBeLessThan(200);
    expect(timeBest(wrap(`<path d="M0 0" fill="url(#${"a".repeat(50000)}"/>`))).toBeLessThan(200);
  });
});

describe("reference depth", () => {
  test("mask/clipPath/pattern references to other such elements are dropped", () => {
    const r = ok(
      wrap(
        '<clipPath id="c2"><rect width="1" height="1"/></clipPath><clipPath id="c1" clip-path="url(#c2)"><rect width="2" height="2" clip-path="url(#c2)"/></clipPath><linearGradient id="g"/><mask id="m"><rect width="1" height="1" fill="url(#g)"/></mask><path d="M0 0" clip-path="url(#c1)" mask="url(#m)"/>',
      ),
    );
    expect(r.removed).toContain("ref-depth");
    expect(r.svg.body).not.toMatch(/<clipPath[^>]*clip-path=/);
    expect(r.svg.body).not.toMatch(/<rect[^>]*clip-path=/);
    // Depth-1 references survive: a gradient inside a mask, clip/mask on a plain shape.
    expect(r.svg.body).toContain('fill="url(#__PCID__-2)"');
    expect(r.svg.body).toContain('clip-path="url(#__PCID__-1)" mask="url(#__PCID__-3)"');
  });
});

describe("expanded size", () => {
  test("is exposed per icon and capped at 2000", () => {
    const small = createIconResolver(
      [
        mk("p", {
          a: wrap('<g id="t"><rect width="1" height="1"/></g><use href="#t"/><use href="#t"/>'),
        }),
      ],
      sanitizeSvg,
    );
    // g + rect, plus two uses (1 + 2 each).
    expect(iconCost(small, "p:a")).toBe(8);
    expect(iconCost(small, "p:nope")).toBeUndefined();

    const heavy = `<g id="t">${'<rect width="1" height="1"/>'.repeat(400)}</g>${'<use href="#t"/>'.repeat(40)}`;
    const r = ok(wrap(heavy), { maxBytes: 100_000 });
    expect((r.svg.body.match(/<use /g) ?? []).length).toBeLessThan(6);
    expect(sanitizedCost(r.svg)).toBeLessThanOrEqual(2000);
  });
});
