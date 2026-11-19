import { brotliDecompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  fontAssets,
  getFont,
  lineMetrics,
  measureText,
  missingGlyphs,
  subsetTtf,
  subsetWoff2Base64,
  textToPath,
  weightFace,
} from "../src/text/index.js";
import { parseFont } from "../src/text/sfnt.js";
import { decodeWoff2 } from "./fixtures/woff2.js";

describe("measurement", () => {
  test("widths scale linearly with size and bold is wider", () => {
    const w12 = measureText("Load balancer", 12);
    expect(w12).toBeGreaterThan(50);
    expect(measureText("Load balancer", 24)).toBeCloseTo(w12 * 2, 5);
    expect(measureText("Load balancer", 12, "bold")).toBeGreaterThan(w12);
    expect(measureText("", 12)).toBe(0);
  });

  test("weight mapping", () => {
    expect(weightFace(400)).toBe("regular");
    expect(weightFace(500)).toBe("regular");
    expect(weightFace(600)).toBe("bold");
    expect(weightFace(700)).toBe("bold");
  });

  test("display text falls back to the mono face for glyphs Oswald lacks", () => {
    const arrow = measureText("→", 20);
    expect(arrow).toBeCloseTo(measureText("→", 20, "regular", "mono"), 6);
    expect(arrow).toBeGreaterThan(5);
    expect(textToPath("a→b", { x: 0, y: 0, size: 20 }).width).toBeCloseTo(
      measureText("a→b", 20),
      6,
    );
    // The medium and bold display faces fall back too (bold uses the mono Bold).
    expect(measureText("→", 20, "bold")).toBeCloseTo(measureText("→", 20, "bold", "mono"), 6);
  });

  test("line metrics are positive", () => {
    const m = lineMetrics(12);
    expect(m.ascent).toBeGreaterThan(8);
    expect(m.descent).toBeGreaterThan(1);
    expect(m.height).toBeGreaterThan(m.ascent);
  });

  test("reports glyphs outside the vendored subset", () => {
    expect(missingGlyphs("Café 5×…")).toEqual([]);
    expect(missingGlyphs("→")).toEqual([]); // Oswald has no arrows: the mono face covers it
    expect(missingGlyphs("→", "mono")).toEqual([]);
    expect(missingGlyphs("日→")).toEqual([0x65e5]);
    expect(missingGlyphs("日本")).toEqual([0x65e5, 0x672c]);
  });
});

describe("outlines", () => {
  test("textToPath is deterministic, 2-decimal, and anchors", () => {
    const a = textToPath("Hi", { x: 10, y: 20, size: 14 });
    const b = textToPath("Hi", { x: 10, y: 20, size: 14 });
    expect(a).toEqual(b);
    expect(a.d.startsWith("M")).toBe(true);
    expect(a.d).not.toMatch(/\d\.\d{3}/);
    expect(a.d).not.toMatch(/NaN|undefined/);
    const mid = textToPath("Hi", { x: 10, y: 20, size: 14, anchor: "middle" });
    const start = textToPath("Hi", { x: 10, y: 20, size: 14, anchor: "start" });
    expect(mid.d).not.toBe(start.d);
    expect(mid.width).toBeCloseTo(start.width, 5);
  });

  test("space has no contours; accented glyph (composite) draws", () => {
    expect(textToPath(" ", { x: 0, y: 0, size: 12 }).d).toBe("");
    expect(textToPath("é", { x: 0, y: 0, size: 12 }).d.split("M").length - 1).toBeGreaterThan(1);
  });
});

describe("subsetting", () => {
  test("subset TTF keeps requested glyph metrics and outlines", () => {
    const full = getFont("regular").parsed;
    const sub = parseFont(subsetTtf("Héllo, World"));
    for (const ch of "Héllo, World") {
      const cp = ch.codePointAt(0) as number;
      const fg = full.cmap.get(cp) as number;
      const sg = sub.cmap.get(cp);
      if (cp === 0x20) continue;
      expect(sg).toBeDefined();
      expect(sub.advance(sg as number)).toBe(full.advance(fg));
      expect(sub.contours(sg as number)).toEqual(full.contours(fg));
    }
    expect(sub.cmap.has("z".codePointAt(0) as number)).toBe(false);
    expect(sub.numGlyphs).toBeLessThan(40);
  });

  test("WOFF2 container is well-formed and small", () => {
    const b64 = subsetWoff2Base64("Load balancer 99.9%");
    const bytes = Buffer.from(b64, "base64");
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(bytes.readUInt32BE(8)).toBe(bytes.length);
    expect(bytes.length).toBeLessThan(4000);
    const numTables = bytes.readUInt16BE(12);
    expect(numTables).toBe(10);
    const compressedSize = bytes.readUInt32BE(20);
    // table directory: 1 flag byte + base128 length per known table
    let p = 48;
    const lens: number[] = [];
    for (let i = 0; i < numTables; i++) {
      p++; // flags (all tags are in the known-tag list)
      let v = 0;
      for (;;) {
        const byte = bytes[p++] as number;
        v = v * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) break;
      }
      lens.push(v);
    }
    const raw = brotliDecompressSync(bytes.subarray(p, p + compressedSize));
    expect(raw.length).toBe(lens.reduce((a, b) => a + b, 0));
  });

  test("same input gives identical bytes", () => {
    expect(subsetWoff2Base64("abc")).toBe(subsetWoff2Base64("abc"));
    expect(Buffer.from(subsetTtf("abc")).equals(Buffer.from(subsetTtf("abc")))).toBe(true);
  });

  test("raster font assets are TTF faces", () => {
    const assets = fontAssets();
    expect(assets.map((a) => a.weight)).toEqual([400, 500, 600, 400, 700]);
    expect(assets.map((a) => a.family)).toEqual([
      "Oswald",
      "Oswald",
      "Oswald",
      "JetBrains Mono",
      "JetBrains Mono",
    ]);
    for (const a of assets) {
      expect(Buffer.from(a.sfnt.subarray(0, 4)).readUInt32BE(0)).toBe(0x00010000);
    }
  });
});

describe("glyph advances vs the font's hmtx", () => {
  const sample = "Users Database 1200 roundrobin App pool Load balancer 3 / 3";

  test("measureText is the sum of hmtx advances (no kerning, no rounding)", () => {
    const full = getFont("regular").parsed;
    for (const ch of new Set(sample)) {
      const adv = full.advance(full.cmap.get(ch.codePointAt(0) as number) ?? 0);
      expect(measureText(ch, 1000)).toBeCloseTo((adv * 1000) / full.unitsPerEm, 6);
    }
    let units = 0;
    for (const ch of sample) units += full.advance(full.cmap.get(ch.codePointAt(0) as number) ?? 0);
    expect(measureText(sample, 12)).toBeCloseTo((units * 12) / full.unitsPerEm, 6);
  });

  test("the embedded WOFF2 subset keeps every advance of the full face (regular and bold)", () => {
    for (const face of ["regular", "bold"] as const) {
      const full = getFont(face).parsed;
      const sub = decodeWoff2(subsetWoff2Base64(sample, face));
      expect(sub.unitsPerEm).toBe(full.unitsPerEm);
      for (const ch of new Set(sample)) {
        const cp = ch.codePointAt(0) as number;
        const g = sub.cmap.get(cp);
        expect(g, `glyph for ${ch}`).toBeDefined();
        expect(sub.advance(g as number)).toBe(full.advance(full.cmap.get(cp) as number));
      }
    }
  });
});
