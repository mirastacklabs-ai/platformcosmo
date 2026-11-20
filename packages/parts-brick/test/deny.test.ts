import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { brickPack, brickShapes, palette, paletteNames, paramSpecsOf } from "../src/index.js";

/**
 * Deny-list (assemblies section 5): pack shapes carry no trademarks and no trade dress. There
 * is no standards-body name for a stud-grid brick, so nothing at all from this list may appear
 * in ids, labels, types, params, palette names or the package's own text.
 */
// Very short names are left out when stripping punctuation would turn code such as `lo.z` into them.
const DENY = [
  "lego",
  "duplo",
  "megabloks",
  "bloks",
  "cobi",
  "kreo",
  "knex",
  "playmobil",
  "tente",
  "sluban",
  "lepin",
  "nexo",
  "minifig",
  "technic",
  "bionicle",
  "ninjago",
  "bricklink",
  "ldraw",
  "rebrickable",
  "hasbro",
  "mattel",
  "bluebrixx",
  "qman",
  "wange",
  "banbao",
  "oxford",
  "clonebrand",
];

/** Ordinary words that contain a deny-list name as a substring. */
const ALLOW = [
  "technical",
  "technically",
  "technician",
  "attention",
  "attentive",
  "legend",
  "legendary",
];

/**
 * Lowercase, strip every non-letter, then look for a deny-list name as a substring, so joined
 * ("MegaBloks"), hyphenated, camelCase and plural ("minifigs") spellings all match. Each
 * whitespace-separated word is checked alone and joined with its neighbour (when the name starts the word) ("mega bloks"),
 * after the allow-listed words are removed.
 */
function brandIn(text: string): string | undefined {
  const words = text.split(/\s+/).map((w) => {
    let letters = w.toLowerCase().replace(/[^a-z]/g, "");
    for (const ok of ALLOW) letters = letters.split(ok).join("");
    return letters;
  });
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const pair = w + (words[i + 1] ?? "");
    for (const d of DENY) {
      if (w.includes(d) || (pair.startsWith(d) && (words[i + 1] ?? "") !== "")) {
        return d;
      }
    }
  }
  return undefined;
}

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
    "LEGOs",
    "legoBrick",
    "technic-pin",
    "mega bloks",
    "MegaBloks",
    "mega_bloks",
    "minifig",
    "minifigs",
    "MiniFigures",
    "BrickLink red",
    "brick_link",
    "Duplos",
    "k'nex",
    "K-NEX",
  ]) {
    expect(brandIn(bad), bad).toBeDefined();
  }
  for (const ok of [
    "brick",
    "plate",
    "tile",
    "slope",
    "round",
    "dark-gray",
    "tan",
    "legend",
    "technical",
    "attention",
    "extent",
    "content of the plate",
  ]) {
    expect(brandIn(ok), ok).toBeUndefined();
  }
});

test("no brand names or marks in ids, labels, types, params or palette", () => {
  for (const s of strings()) expect(brandIn(s), s).toBeUndefined();
});

test("palette is plain colour words with valid hex values", () => {
  expect(paletteNames.length).toBeGreaterThanOrEqual(12);
  for (const [name, hex] of Object.entries(palette)) {
    expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(new Set(Object.values(palette)).size).toBe(paletteNames.length);
});

test("no brand names in the package sources, manifest, snapshot or changeset", () => {
  const root = new URL("../", import.meta.url);
  const files = [
    ...readdirSync(new URL("src/", root)).map((f) => `src/${f}`),
    "package.json",
    "test/__snapshots__/contact-sheet.svg",
    "../../.changeset/parts-brick-e3.md",
  ];
  for (const f of files) {
    const text = readFileSync(fileURLToPath(new URL(f, root)), "utf8");
    expect(brandIn(text), f).toBeUndefined();
  }
});
