import { describe, expect, test } from "vitest";
import type { LoadedIconPack } from "../src/index.js";
import { createIconResolver, iconCost, sanitizeSvg } from "../src/icons/index.js";
import { sanitizedCost } from "../src/icons/sanitize.js";
import { expectLinear } from "./timing.js";

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

describe("url( floods scale linearly", () => {
  test("in a style, in an attribute, and with a huge id", { timeout: 60_000 }, () => {
    expectLinear(
      "style flood",
      (n) => wrap(`<style>.a{fill:${"url(#".repeat(n)}}</style><path class="a" d="M0 0"/>`),
      6000,
    );
    expectLinear(
      "attribute flood",
      (n) => wrap(`<path d="M0 0" fill="${"url(#".repeat(n)}"/>`),
      6000,
    );
    expectLinear("huge id", (n) => wrap(`<path d="M0 0" fill="url(#${"a".repeat(n)}"/>`), 25000);
  });
});

describe("<use> inside mask/clipPath/pattern", () => {
  test("is dropped and reported", () => {
    const r = ok(
      wrap(
        '<g id="t"><rect width="1" height="1"/></g><mask id="m"><use href="#t"/><rect width="1" height="1"/></mask><clipPath id="c"><use href="#t"/></clipPath><pattern id="p" width="1" height="1"><g><use href="#t"/></g></pattern><use href="#t"/>',
      ),
    );
    expect(r.removed).toContain("element:use-in-ref");
    expect(r.svg.body).not.toMatch(
      /<(mask|clipPath|pattern)[^>]*>(?:(?!<\/(mask|clipPath|pattern)>).)*<use/,
    );
    expect(r.svg.body.match(/<use /g)?.length).toBe(1); // the plain one outside survives
  });

  test("a use target carrying mask/clip-path/pattern references is treated as risky", () => {
    const r = ok(
      wrap(
        '<mask id="m"><rect width="1" height="1"/></mask><g id="t" mask="url(#m)"><rect width="1" height="1"/></g><use href="#t"/><use href="#t"/>',
      ),
    );
    expect(r.svg.body).not.toContain("<use");
  });

  test("chained m1 -> k x use -> r1(mask=m2) -> k x use -> r2(mask=m3) ... stays bounded", () => {
    const depth = 10;
    const k = 8;
    let inner = "";
    for (let i = 1; i <= depth; i++) {
      inner += `<mask id="m${i}">${`<use href="#r${i}"/>`.repeat(k)}</mask>`;
      inner += `<rect id="r${i}" width="1" height="1" mask="url(#m${i + 1})"/>`;
    }
    inner += `<mask id="m${depth + 1}"><rect width="1" height="1"/></mask>`;
    inner += `<rect width="2" height="2" mask="url(#m1)"/>`;
    const r = ok(wrap(inner), { maxBytes: 100_000 });
    expect(sanitizedCost(r.svg)).toBeLessThanOrEqual(2000);
    expect(r.svg.body).not.toContain("<use");
    expect(r.svg.body.length).toBeLessThan(5000);
  });

  test("the same chain built from <use> in the page body is bounded too", () => {
    const depth = 10;
    const k = 8;
    let inner = '<g id="r0"><rect width="1" height="1"/></g>';
    for (let i = 1; i <= depth; i++) {
      inner += `<g id="r${i}" mask="url(#m${i})">${`<use href="#r${i - 1}"/>`.repeat(k)}</g>`;
      inner += `<mask id="m${i}"><rect width="1" height="1"/></mask>`;
    }
    inner += `<use href="#r${depth}"/>`;
    const r = ok(wrap(inner), { maxBytes: 100_000 });
    expect(sanitizedCost(r.svg)).toBeLessThanOrEqual(2000);
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
