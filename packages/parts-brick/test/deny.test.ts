import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { brickPack, brickShapes, palette, paletteNames, paramSpecsOf } from "../src/index.js";

/**
 * Deny-list (assemblies section 5): pack shapes carry no trademarks and no trade dress. There
 * is no standards-body name for a stud-grid brick, so nothing at all from this list may appear
 * in ids, labels, types, params, palette names or the package's own text.
 */
const DENY = [
  "lego",
  "duplo",
  "mega ?bloks?",
  "bloks",
  "cobi",
  "kre-?o",
  "k'?nex",
  "playmobil",
  "tente",
  "sluban",
  "lepin",
  "nexo",
  "minifig(ure)?s?",
  "technic",
  "bionicle",
  "ninjago",
  "brick ?link",
  "ldraw",
  "rebrickable",
  "hasbro",
  "mattel",
  "bluebrixx",
  "qman",
  "wange",
  "loz",
  "banbao",
  "oxford",
  "clone ?brands?",
];
const RE = new RegExp(`(^|[^a-z])(${DENY.join("|")})([^a-z]|$)`, "i");

function strings(): string[] {
  const out: string[] = [brickPack.id, brickPack.name, brickPack.license];
  for (const s of brickShapes) {
    out.push(s.id, s.label, s.type, ...(s.role ? [s.role] : []));
    for (const [k, sp] of paramSpecsOf(s.id) ?? []) {
      out.push(k);
      if (sp.kind === "enum") out.push(...sp.values);
    }
    out.push(...Object.keys(s.defaults), ...Object.values(s.defaults).map(String));
  }
  out.push(...paletteNames, ...Object.keys(palette));
  return out;
}

test("the matcher itself catches brands (the test can fail)", () => {
  for (const bad of [
    "lego-brick",
    "Lego",
    "technic-pin",
    "mega bloks",
    "minifig",
    "BrickLink red",
  ]) {
    expect(RE.test(bad), bad).toBe(true);
  }
  for (const ok of ["brick", "plate", "tile", "slope", "round", "dark-gray", "tan", "legend"]) {
    expect(RE.test(ok), ok).toBe(false);
  }
});

test("no brand names or marks in ids, labels, types, params or palette", () => {
  for (const s of strings()) expect(s, s).not.toMatch(RE);
});

test("palette is plain colour words with valid hex values", () => {
  expect(paletteNames.length).toBeGreaterThanOrEqual(12);
  for (const [name, hex] of Object.entries(palette)) {
    expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(new Set(Object.values(palette)).size).toBe(paletteNames.length);
});

test("no brand names in the package sources or manifest", () => {
  const root = new URL("../", import.meta.url);
  const files = [...readdirSync(new URL("src/", root)).map((f) => `src/${f}`), "package.json"];
  for (const f of files) {
    const text = readFileSync(fileURLToPath(new URL(f, root)), "utf8");
    expect(text, f).not.toMatch(RE);
  }
});
