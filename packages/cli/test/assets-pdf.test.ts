import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage } from "@platformcosmo/assets";
import { openPdf } from "@platformcosmo/pdf";
import { describe, expect, test } from "vitest";
import * as g from "../../pdf/test/fixtures/gen.js";
import { type Diag, expectKnownCodes, expectSorted, json, pdf, put, work } from "./pdf-helpers.js";

const FILE = /^(p[1-9][0-9]*-i[0-9]+(-mask)?\.(png|jpg)|manifest\.json)$/;

async function pixel(path: string, x: number, y: number) {
  const d = await decodeImage(await readFile(path));
  const r = d.value!.raster;
  const o = (y * r.width + x) * 4;
  return { w: r.width, h: r.height, rgba: [...r.data.slice(o, o + 4)] };
}

const near = (a: number[], b: number[], tol = 14): void => {
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));
};

describe("pdf info", () => {
  test("pages, rotation, producer; the JSON is deterministic and sorted", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const a = await pdf(dir, ["info", "a.pdf", "--json"]);
    const b = await pdf(dir, ["info", "a.pdf", "--json"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const j = json(a.stdout);
    expectSorted(j);
    expect(j.command).toBe("pdf info");
    expect(j.pdf.pageCount).toBe(2);
    expect(j.pdf.producer).toBe("Synthetic Writer 1.0");
    expect(j.pdf.pages[0]).toMatchObject({ page: 1, width: 400, height: 300, rotate: 0 });
    expect(j.pdf.pages[1]).toMatchObject({ page: 2, width: 100, height: 200, rotate: 90 });
    const t = await pdf(dir, ["info", "a.pdf"]);
    expect(t.stdout).toContain("2 pages");
    expect(t.stdout).toContain("page 2: 100 x 200 pt, rotated 90");
  });

  test("a damaged file is repaired and says so", async () => {
    const dir = await work();
    await put(dir, "d.pdf", g.damagedPdf());
    const r = await pdf(dir, ["info", "d.pdf", "--json"]);
    expect(r.code).toBe(0);
    const j = json(r.stdout);
    expect(j.pdf.repaired).toBe(true);
    expect(j.diagnostics.map((d: Diag) => d.code)).toContain("pdf/xref-repaired");
  });

  test("not a PDF is an error diagnostic, exit 1", async () => {
    const dir = await work();
    await put(dir, "x.pdf", "this is not a pdf");
    const r = await pdf(dir, ["info", "x.pdf", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics.find((d: Diag) => d.severity === "error")).toMatchObject({
      code: "pdf/malformed",
    });
  });
});

describe("pdf list", () => {
  test("matches the parser, names are built from numbers, --min-px hides small images", async () => {
    const dir = await work();
    const bytes = g.rasterPdf();
    await put(dir, "a.pdf", bytes);
    const r = await pdf(dir, ["list", "a.pdf", "--json", "--min-px", "0"]);
    expect(r.code).toBe(0);
    const j = json(r.stdout);
    expectSorted(j);
    const doc = openPdf(bytes);
    if (!doc.ok) throw new Error("fixture");
    for (const pg of j.pages) {
      const api = doc.doc.listImages(pg.page, { hash: true });
      expect(pg.images).toHaveLength(api.images.length);
      pg.images.forEach((im: Record<string, unknown>, i: number) => {
        const a = api.images[i]!;
        expect(im).toMatchObject({
          index: a.index,
          sha256: a.sha256,
          bbox: a.bbox,
          matrix: a.matrix,
        });
        if (im.file !== null) expect(String(im.file)).toMatch(FILE);
      });
    }
    const jpeg = j.pages[0].images.find((i: { format: string }) => i.format === "jpeg");
    expect(jpeg).toMatchObject({ width: 16, height: 8, bbox: { x: 20, y: 20, w: 160, h: 80 } });
    expect(jpeg.file).toBe(`p1-i${jpeg.index}.jpg`);
    expect(jpeg.bboxPercent).toMatchObject({ x: 5, y: 6.667 });

    const big = json((await pdf(dir, ["list", "a.pdf", "--json", "--min-px", "6"])).stdout);
    expect(big.pages[0].images.length).toBeLessThan(j.pages[0].images.length);
    expect(big.pages[0].hiddenSmall).toBeGreaterThan(0);
    const one = json((await pdf(dir, ["list", "a.pdf", "--json", "--pages", "2"])).stdout);
    expect(one.pages.map((p: { page: number }) => p.page)).toEqual([2]);
  });

  test("a vector-only page is a warning, not an error", async () => {
    const dir = await work();
    await put(dir, "v.pdf", g.vectorPdf());
    const r = await pdf(dir, ["list", "v.pdf", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).diagnostics.map((d: Diag) => d.code)).toContain("pdf/no-images");
  });

  test("bad ranges: usage errors and bad-page diagnostics", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    expect((await pdf(dir, ["list", "a.pdf", "--pages", "x"])).code).toBe(2);
    expect((await pdf(dir, ["list", "a.pdf", "--pages", "3-2"])).code).toBe(2);
    const r = await pdf(dir, ["list", "a.pdf", "--pages", "1-9", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics[0].code).toBe("pdf/bad-page");
  });
});

describe("pdf extract", () => {
  test("one image: a JPEG passes through as .jpg, others are PNG; the extension must match", async () => {
    const dir = await work();
    const bytes = g.rasterPdf();
    await put(dir, "a.pdf", bytes);
    const list = json((await pdf(dir, ["list", "a.pdf", "--json"])).stdout).pages[0].images;
    const jpeg = list.find((i: { format: string }) => i.format === "jpeg");
    const pngImg = list.find((i: { format: string }) => i.format === "png");

    const ok = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      String(jpeg.index),
      "-o",
      "out/j.jpg",
      "--json",
    ]);
    expect(ok.code, ok.stdout).toBe(0);
    expect(new Uint8Array(await readFile(join(dir, "out/j.jpg")))).toEqual(g.JPEG_16x8);
    expect(json(ok.stdout)).toMatchObject({
      format: "jpeg",
      width: 16,
      height: 8,
      sha256: jpeg.sha256,
    });

    const wrong = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      String(jpeg.index),
      "-o",
      "out/j2.png",
      "--json",
    ]);
    expect(wrong.code).toBe(1);
    expect(json(wrong.stdout).diagnostics[0].code).toBe("asset/bad-option");
    expect(await readdir(join(dir, "out"))).toEqual(["j.jpg"]);

    const std = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      String(pngImg.index),
      "-d",
      "std",
      "--json",
    ]);
    expect(std.code).toBe(0);
    expect(await readdir(join(dir, "std"))).toEqual([`p1-i${pngImg.index}.png`]);
    const magic = (await readFile(join(dir, "std", `p1-i${pngImg.index}.png`))).subarray(0, 4);
    expect([...magic]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("--mask extracts the soft mask; an image without one is an error", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const list = json((await pdf(dir, ["list", "a.pdf", "--json", "--min-px", "0"])).stdout)
      .pages[0].images;
    const masked = list.find((i: { hasAlpha: boolean }) => i.hasAlpha);
    const plain = list.find(
      (i: { hasAlpha: boolean; format: string }) => !i.hasAlpha && i.format === "png",
    );
    const r = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      String(masked.index),
      "--mask",
      "-d",
      "m",
      "--json",
    ]);
    expect(r.code, r.stdout).toBe(0);
    expect(await readdir(join(dir, "m"))).toEqual([`p1-i${masked.index}-mask.png`]);
    const bad = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      String(plain.index),
      "--mask",
      "-d",
      "m2",
      "--json",
    ]);
    expect(bad.code).toBe(1);
    expect(json(bad.stdout).diagnostics.map((d: Diag) => d.code)).toContain("pdf/malformed");
    await expect(readdir(join(dir, "m2"))).rejects.toThrow();
  });

  test("--all writes p<page>-i<index> files and a manifest; duplicates once; reruns are identical", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const r = await pdf(dir, ["extract", "a.pdf", "--all", "--min-px", "0", "-d", "all", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const names = (await readdir(join(dir, "all"))).sort();
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(n).toMatch(FILE);
    const manifest = JSON.parse(await readFile(join(dir, "all/manifest.json"), "utf8"));
    expectSorted(manifest);
    expect(manifest.schema).toBe("pcosmo-pdf-extract/1");
    expect(manifest.images.some((i: { duplicate: boolean }) => i.duplicate)).toBe(true);
    for (const i of manifest.images) expect(names).toContain(i.file);
    const files = new Set(manifest.images.map((i: { file: string }) => i.file));
    expect(names.filter((n: string) => n !== "manifest.json").sort()).toEqual([...files].sort());
    // identical hashes are written once
    const shas = manifest.images
      .filter((i: { duplicate: boolean }) => !i.duplicate)
      .map((i: { sha256: string }) => i.sha256);
    expect(new Set(shas).size).toBe(shas.length);

    const before = await Promise.all(names.map((n) => readFile(join(dir, "all", n))));
    const again = await pdf(dir, [
      "extract",
      "a.pdf",
      "--all",
      "--min-px",
      "0",
      "-d",
      "all",
      "--json",
    ]);
    expect(again.stdout).toBe(r.stdout);
    const after = await Promise.all(names.map((n) => readFile(join(dir, "all", n))));
    expect(after.map((b) => Buffer.compare(b, before[after.indexOf(b)]!))).toEqual(
      after.map(() => 0),
    );
  });

  test("a leftover from an earlier run is reported, never deleted", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    await put(dir, "o/p9-i9.png", "OLD");
    const r = await pdf(dir, ["extract", "a.pdf", "--all", "-d", "o", "--json"]);
    expect(r.code).toBe(0);
    const w = json(r.stdout).diagnostics.find((d: Diag) => d.code === "asset/stale-output");
    expect(w).toMatchObject({ severity: "warning", params: { files: ["p9-i9.png"] } });
    expect(await readFile(join(dir, "o/p9-i9.png"), "utf8")).toBe("OLD");
  });

  test("usage: exactly one of -o / -d, --all excludes --page", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    expect((await pdf(dir, ["extract", "a.pdf", "--page", "1", "--image", "0"])).code).toBe(2);
    expect(
      (
        await pdf(dir, [
          "extract",
          "a.pdf",
          "--page",
          "1",
          "--image",
          "0",
          "-o",
          "a.png",
          "-d",
          "x",
        ])
      ).code,
    ).toBe(2);
    expect((await pdf(dir, ["extract", "a.pdf", "--all", "--page", "1", "-d", "x"])).code).toBe(2);
    expect((await pdf(dir, ["extract", "a.pdf", "--all"])).code).toBe(2);
    const missing = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      "99",
      "-d",
      "x",
      "--json",
    ]);
    expect(missing.code).toBe(1);
    expect(json(missing.stdout).diagnostics.map((d: Diag) => d.code)).toContain("pdf/bad-page");
  });

  test("names never come from the document, even when its strings try to", async () => {
    const dir = await work();
    const evil = "../../evil";
    const doc = g.onePage(
      "q 40 0 0 40 10 10 cm /Im#2E#2E#2F#2E#2E#2Fevil Do Q q 40 0 0 40 100 10 cm /Im2 Do Q",
      `/XObject << /Im#2E#2E#2F#2E#2E#2Fevil 10 0 R /Im2 11 0 R >> `,
      [
        [10, g.imageDict(4, 5, "/DeviceRGB", 8), g.RGB_4x5],
        [
          11,
          g.imageDict(4, 5, "/DeviceRGB", 8, `/Name /${evil.replaceAll("/", "#2F")}`),
          g.RGB_4x5,
        ],
      ],
    );
    await put(dir, "e.pdf", doc);
    const r = await pdf(dir, ["extract", "e.pdf", "--all", "--min-px", "0", "-d", "o", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    for (const n of await readdir(join(dir, "o"))) expect(n).toMatch(FILE);
    expect(await readdir(dir)).toEqual(["e.pdf", "o"]);
  });
});

describe("pdf compose", () => {
  test("PNG: images land at their placements on white; deterministic", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const r = await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "c.png", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const j = json(r.stdout);
    expect(j).toMatchObject({ page: 1, dpi: 96, format: "png", width: 534, height: 400 });
    // the JPEG occupies x 20..180, y 20..100 pt (top-left origin): its centre is red-ish
    const k = 96 / 72;
    near(
      (await pixel(join(dir, "c.png"), Math.round(100 * k), Math.round(60 * k))).rgba,
      [200, 30, 40, 255],
    );
    // page corner far from every image stays white
    near((await pixel(join(dir, "c.png"), 520, 390)).rgba, [255, 255, 255, 255], 0);
    const first = await readFile(join(dir, "c.png"));
    await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "c2.png"]);
    expect(Buffer.compare(first, await readFile(join(dir, "c2.png")))).toBe(0);
  });

  test("rotated page: the canvas is the displayed size", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const r = await pdf(dir, [
      "compose",
      "a.pdf",
      "--page",
      "2",
      "-o",
      "r.png",
      "--dpi",
      "72",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ width: 100, height: 200 });
  });

  test("SVG: one <use> per placement, sources once, viewBox is the page, deterministic", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const r = await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "c.svg", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const svg = await readFile(join(dir, "c.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain("data:image/jpeg;base64,");
    expect(svg).not.toMatch(/<script|onload|xlink:href="http/);
    const uses = (svg.match(/<use /g) ?? []).length;
    const defs = (svg.match(/<image /g) ?? []).length;
    expect(uses).toBeGreaterThan(defs);
    await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "d.svg"]);
    expect(await readFile(join(dir, "d.svg"), "utf8")).toBe(svg);
  });

  test("--crop (pt and percent) and --annotate", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const half = json(
      (
        await pdf(dir, [
          "compose",
          "a.pdf",
          "--page",
          "1",
          "-o",
          "h.png",
          "--dpi",
          "72",
          "--crop",
          "0%,0%,50%,50%",
          "--json",
        ])
      ).stdout,
    );
    expect(half).toMatchObject({ width: 200, height: 150 });
    const pt = json(
      (
        await pdf(dir, [
          "compose",
          "a.pdf",
          "--page",
          "1",
          "-o",
          "p.png",
          "--dpi",
          "72",
          "--crop",
          "20,20,160,80",
          "--json",
        ])
      ).stdout,
    );
    expect(pt).toMatchObject({ width: 160, height: 80 });
    near((await pixel(join(dir, "p.png"), 80, 40)).rgba, [200, 30, 40, 255]);
    const plain = await pixel(join(dir, "p.png"), 0, 0);
    await pdf(dir, [
      "compose",
      "a.pdf",
      "--page",
      "1",
      "-o",
      "n.png",
      "--dpi",
      "72",
      "--crop",
      "20,20,160,80",
      "--annotate",
    ]);
    const marked = await pixel(join(dir, "n.png"), 0, 0);
    expect(marked.rgba).not.toEqual(plain.rgba);
    expect(marked.rgba[0]).toBeGreaterThan(200); // annotation red
    const svg = await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "n.svg", "--annotate"]);
    expect(svg.code).toBe(0);
    expect(await readFile(join(dir, "n.svg"), "utf8")).toMatch(/<text [^>]*>\d+<\/text>/);
    const out = await pdf(dir, [
      "compose",
      "a.pdf",
      "--page",
      "1",
      "-o",
      "o.png",
      "--crop",
      "500,500,10,10",
      "--json",
    ]);
    expect(out.code).toBe(1);
    expect((await readdir(dir)).includes("o.png")).toBe(false);
    expect(
      (await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "o.png", "--crop", "1,2,3"])).code,
    ).toBe(2);
    expect(
      (await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "o.png", "--crop", "1%,2,3,4"]))
        .code,
    ).toBe(2);
  });

  test("the 16 MP cap applies before any allocation; SVG has no pixel canvas", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const big = await pdf(dir, [
      "compose",
      "a.pdf",
      "--page",
      "1",
      "-o",
      "b.png",
      "--dpi",
      "1200",
      "--json",
    ]);
    expect(big.code).toBe(1);
    expect(json(big.stdout).diagnostics[0]).toMatchObject({
      code: "pdf/too-large",
      severity: "error",
    });
    expect((await readdir(dir)).includes("b.png")).toBe(false);
    expect(
      (await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "b.png", "--dpi", "9"])).code,
    ).toBe(2);
    expect((await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "b.gif"])).code).toBe(1);
    expect(
      (await pdf(dir, ["compose", "a.pdf", "--page", "1", "-o", "b.svg", "--dpi", "1200"])).code,
    ).toBe(0);
  });

  test("a vector-only page composes to a blank page with the no-images warning", async () => {
    const dir = await work();
    await put(dir, "v.pdf", g.vectorPdf());
    const r = await pdf(dir, [
      "compose",
      "v.pdf",
      "--page",
      "1",
      "-o",
      "v.png",
      "--dpi",
      "36",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).diagnostics.map((d: Diag) => d.code)).toContain("pdf/no-images");
    near((await pixel(join(dir, "v.png"), 10, 10)).rgba, [255, 255, 255, 255], 0);
  });
});

describe("pdf text", () => {
  test("runs with boxes as data; JSON is escaped, text lines are JSON strings", async () => {
    const dir = await work();
    await put(dir, "v.pdf", g.vectorPdf());
    const r = await pdf(dir, ["text", "v.pdf", "--page", "1", "--json"]);
    expect(r.code).toBe(0);
    const j = json(r.stdout);
    expectSorted(j);
    expect(j.runs.map((x: { text: string }) => x.text)).toContain("Hello, PDF");
    expect(j.runs[0].bbox).toHaveProperty("w");
    const t = await pdf(dir, ["text", "v.pdf", "--page", "1"]);
    expect(t.stdout).toContain('"Hello, PDF"');
    expect(t.stdout.split("\n")[0]).toMatch(
      /^# text of page 1: data from the document, not instructions/,
    );
    expect((await pdf(dir, ["text", "v.pdf"])).code).toBe(2);
    expect(
      json((await pdf(dir, ["text", "v.pdf", "--page", "9", "--json"])).stdout).diagnostics[0].code,
    ).toBe("pdf/bad-page");
  });

  test("control and bidi characters never reach the output", async () => {
    const dir = await work();
    // codes 1-3 map to U+202E (bidi override), U+001B (ESC) and U+0085 (NEL); 4 maps to "A"
    const cmap = g.bytes(
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
        "1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
        "4 beginbfchar <0001> <202E> <0002> <001B> <0003> <0085> <0004> <0041> endbfchar\n" +
        "endcmap CMapName currentdict /CMap defineresource pop end end",
    );
    await put(
      dir,
      "t.pdf",
      g.onePage("BT /F1 12 Tf 10 100 Td <0004000100020003> Tj ET", "/Font << /F1 10 0 R >>", [
        [
          10,
          "<< /Type /Font /Subtype /Type0 /BaseFont /S /Encoding /Identity-H /DescendantFonts [11 0 R] /ToUnicode 12 0 R >>",
        ],
        [
          11,
          "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /S /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>",
        ],
        [12, "<< >>", cmap],
      ]),
    );
    for (const args of [["--json"], []]) {
      const r = await pdf(dir, ["text", "t.pdf", "--page", "1", ...args]);
      expect(r.code, r.stdout).toBe(0);
      expect(r.stdout).toContain("A\\ufffd\\ufffd\\ufffd".replace(/\\ufffd/g, "�"));
      // eslint-disable-next-line no-control-regex
      expect(r.stdout.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    }
  });
});

describe("encrypted documents", () => {
  const kinds = ["rc4-40", "rc4-128", "rc4-v4", "aes-128", "aes-256-r5", "aes-256-r6"] as const;
  test.each(kinds)(
    "%s with the empty user password opens and gives the same images",
    async (kind) => {
      const dir = await work();
      await put(dir, "plain.pdf", g.rasterPdf());
      await put(dir, "enc.pdf", g.encryptedPdf({ kind }));
      const a = json((await pdf(dir, ["list", "plain.pdf", "--json"])).stdout);
      const b = await pdf(dir, ["list", "enc.pdf", "--json"]);
      expect(b.code, b.stdout.slice(0, 300)).toBe(0);
      const j = json(b.stdout);
      expect(j.diagnostics.map((d: Diag) => d.code)).toContain("pdf/encrypted");
      const shas = (x: typeof a) => x.pages[0].images.map((i: { sha256: string }) => i.sha256);
      expect(shas(j)).toEqual(shas(a));
      const info = json((await pdf(dir, ["info", "enc.pdf", "--json"])).stdout);
      expect(info.pdf.encryption).not.toBeNull();
      const ex = await pdf(dir, ["extract", "enc.pdf", "--all", "-d", "out", "--json"]);
      expect(ex.code).toBe(0);
    },
  );

  test.each(["info", "list", "text", "extract", "compose", "render"])(
    "a user password is refused by %s: pdf/encrypted, exit 1, nothing written",
    async (sub) => {
      const dir = await work();
      await put(dir, "u.pdf", g.encryptedPdf({ kind: "aes-128", userPassword: "secret" }));
      const args = {
        info: [],
        list: [],
        text: ["--page", "1"],
        extract: ["--all", "-d", "o"],
        compose: ["--page", "1", "-o", "o.png"],
        render: ["--page", "1", "-o", "o.png"],
      }[sub]!;
      const r = await pdf(dir, [sub, "u.pdf", ...args, "--json"], {
        env: { PCOSMO_PDF_TOOLS_DIR: dir },
      });
      expect(r.code).toBe(1);
      const j = json(r.stdout);
      expect(j.diagnostics[0]).toMatchObject({ code: "pdf/encrypted", severity: "error" });
      expect(await readdir(dir)).toEqual(["u.pdf"]);
    },
  );
});

describe("diagnostics", () => {
  test("every command emits only documented codes", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    await put(dir, "d.pdf", g.damagedPdf());
    await put(dir, "x.pdf", "nope");
    for (const f of ["a.pdf", "d.pdf", "x.pdf"]) {
      for (const args of [
        ["info"],
        ["list"],
        ["text", "--page", "1"],
        ["compose", "--page", "1", "-o", `${f}.png`],
      ]) {
        const [sub, ...rest] = args;
        const r = await pdf(dir, [sub!, f, ...rest, "--json"]);
        expectKnownCodes(json(r.stdout).diagnostics);
      }
    }
  });
});
