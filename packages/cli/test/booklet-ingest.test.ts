/**
 * Fixture 5 (ingestion §12): the synthetic brick rover booklet goes through the documented
 * ingestion path (`assets pdf info|list|extract|text|render`), and the committed storyboard
 * example is made of exactly the images that come out.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeImage } from "@platformcosmo/assets";
import { describe, expect, test } from "vitest";
import { booklet, check, pngPixels, spec } from "../../../tests/fixtures/booklet/gen.mjs";
import { type Diag, json, pdf, put, work } from "./pdf-helpers.js";

const exec = promisify(execFile);
const bin = new URL("../dist/bin.js", import.meta.url).pathname;
const exampleDir = new URL("../../../examples/", import.meta.url).pathname;

/** Images per page: cover (the finished model), parts list, then steps 1-8 (step 6: cab kit + 3 mini steps). */
const PER_PAGE = [1, 17, 2, 3, 2, 3, 2, 10, 3, 3];
const DENY = [
  "lego",
  "duplo",
  "megabloks",
  "technic",
  "ninjago",
  "playmobil",
  "knex",
  "hasbro",
  "mattel",
];

/**
 * Same RGBA: alpha exactly, colour within the premultiplied round trip's error (nothing for an
 * opaque pixel, one alpha step of colour otherwise), and any colour under zero alpha.
 */
function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 4) {
    const al = a[i + 3]!;
    if (al !== b[i + 3]) return false;
    if (al === 0) continue;
    const tol = al === 255 ? 0 : Math.ceil(255 / al) + 1;
    for (let c = 0; c < 3; c++) if (Math.abs(a[i + c]! - b[i + c]!) > tol) return false;
  }
  return true;
}

type PageImage = {
  index: number;
  sha256: string;
  width: number;
  height: number;
  hasAlpha: boolean;
};

describe("fixture 5: synthetic brick rover booklet", () => {
  test("the generator is deterministic and the committed example matches it (--check)", () => {
    expect(Buffer.from(booklet()).equals(Buffer.from(booklet()))).toBe(true);
    expect(check()).toEqual([]);
    // the check is not vacuous: a changed picture is reported
    const bad = JSON.parse(JSON.stringify(spec()));
    bad.images[0].src = bad.images[1].src;
    expect(check(() => JSON.stringify(bad))).toContain(`image ${bad.images[0].id} differs`);
  });

  test("info, list and extract: pages, per-page images, and pixels equal the example's images", async () => {
    const dir = await work();
    await put(dir, "rover.pdf", booklet());

    const info = json((await pdf(dir, ["info", "rover.pdf", "--json"])).stdout);
    expect(info.pdf.pageCount).toBe(10);
    expect(info.pdf.pages[0]).toMatchObject({ width: 400, height: 560, rotate: 0 });
    expect(info.diagnostics).toEqual([]);

    const list = json((await pdf(dir, ["list", "rover.pdf", "--json", "--min-px", "0"])).stdout);
    expect(list.diagnostics).toEqual([]);
    expect(list.pages.map((p: { images: unknown[] }) => p.images.length)).toEqual(PER_PAGE);
    const step6: PageImage[] = list.pages[7].images;
    expect(step6.filter((i) => i.width === 72 && i.height === 58)).toHaveLength(9); // kit + mini steps
    expect(step6.every((i) => i.hasAlpha)).toBe(true);

    const out = await pdf(dir, [
      "extract",
      "rover.pdf",
      "--all",
      "--min-px",
      "0",
      "-d",
      "x",
      "--json",
    ]);
    expect(out.code, out.stdout).toBe(0);
    expect(json(out.stdout).diagnostics ?? []).toEqual([]);
    const files = (await readdir(join(dir, "x"))).filter((f) => f.endsWith(".png"));
    expect(files.every((f) => /^p[1-9][0-9]*-i[0-9]+\.png$/.test(f))).toBe(true);

    // every image of the committed example is among the extracted images, pixel for pixel
    const extracted = await Promise.all(
      files.map(async (f) => {
        const d = await decodeImage(await readFile(join(dir, "x", f)));
        return d.value!.raster;
      }),
    );
    const example = JSON.parse(
      await readFile(join(exampleDir, "rover-booklet.cosmo.json"), "utf8"),
    );
    expect(example.images).toHaveLength(28);
    for (const im of example.images as { id: string; src: string }[]) {
      const want = pngPixels(Buffer.from(im.src.split(",")[1]!, "base64"));
      const hit = extracted.find(
        (r) => r.width === want.w && r.height === want.h && samePixels(r.data, want.rgba),
      );
      expect(hit, `image ${im.id} was not extracted`).toBeDefined();
    }
  });

  test("text: step numbers, captions and counts are data from the document", async () => {
    const dir = await work();
    await put(dir, "rover.pdf", booklet());
    const runs = async (page: number) =>
      (
        json((await pdf(dir, ["text", "rover.pdf", "--page", String(page), "--json"])).stdout)
          .runs as { text: string }[]
      ).map((r) => r.text);
    expect(await runs(1)).toContain("Brick Rover");
    expect(await runs(2)).toEqual(expect.arrayContaining(["Parts", "4x", "Wheel"]));
    expect(await runs(3)).toEqual(expect.arrayContaining(["1", "Base plate", "1x"]));
    expect(await runs(8)).toEqual(
      expect.arrayContaining(["6", "Cab (sub-build)", "Sub-build", "4x"]),
    );
    // no brand or mark anywhere: the document text, the example, the generator
    const all = (await Promise.all([1, 2, 3, 8, 10].map(runs))).flat().join(" ").toLowerCase();
    const gen = await readFile(
      new URL("../../../tests/fixtures/booklet/gen.mjs", import.meta.url),
      "utf8",
    );
    const exampleText = await readFile(join(exampleDir, "rover-booklet.cosmo.json"), "utf8");
    for (const word of DENY)
      for (const t of [all, gen.toLowerCase(), exampleText.slice(0, 2000).toLowerCase()])
        expect(t).not.toContain(word);
  });

  test("render: a page rasterises through the external tool, or says the tool is missing", async () => {
    const dir = await work();
    await put(dir, "rover.pdf", booklet());
    const r = await pdf(dir, [
      "render",
      "rover.pdf",
      "--page",
      "3",
      "-o",
      "p3.png",
      "--dpi",
      "72",
      "--json",
    ]);
    const j = json(r.stdout);
    if (r.code === 0) {
      const d = await decodeImage(await readFile(join(dir, "p3.png")));
      expect(d.value!.raster).toMatchObject({ width: 400, height: 560 });
    } else {
      expect(j.diagnostics.map((d: Diag) => d.code)).toContain("pdf/renderer-missing");
    }
  });

  test("the storyboard example validates and builds (one frame per booklet step)", async () => {
    const dir = await work();
    await writeFile(
      join(dir, "rover.cosmo.json"),
      await readFile(join(exampleDir, "rover-booklet.cosmo.json")),
    );
    const v = await exec(process.execPath, [bin, "validate", "rover.cosmo.json", "--json"], {
      cwd: dir,
    });
    expect(JSON.parse(v.stdout).diagnostics ?? []).toEqual([]);
    await exec(process.execPath, [bin, "build", "rover.cosmo.json", "-o", "out", "--static"], {
      cwd: dir,
    });
    const svg = await readFile(join(dir, "out", "rover.static.svg"), "utf8");
    expect(svg).toContain("Brick rover");
    expect((svg.match(/<image\b/g) ?? []).length).toBeGreaterThan(8);
    expect(spec().storyboards).toHaveLength(1);
  });
});
