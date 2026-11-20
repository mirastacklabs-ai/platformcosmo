import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage, encodePng, type Raster } from "@platformcosmo/assets";
import { describe, expect, test } from "vitest";
import { figure, png } from "../../../tests/fixtures/figures/gen.mjs";
import { run } from "../src/index.js";
import { makeDeps, tmp } from "./helpers.js";

const cli = (dir: string, args: string[]) => run(["assets", ...args], makeDeps(dir));
type Manifest = ReturnType<typeof figure>["manifest"];
const json = (s: string) => JSON.parse(s) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const solid = (w: number, h: number, f: (x: number, y: number) => number[]): Raster => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};

/** A white 60x40 image with a red box at (20,10) 20x15 and a black frame. */
const sample = (): Raster =>
  solid(60, 40, (x, y) => {
    if (x >= 20 && x < 40 && y >= 10 && y < 25) return [200, 20, 20, 255];
    if (x === 0 || y === 0 || x === 59 || y === 39) return [0, 0, 0, 255];
    return [255, 255, 255, 255];
  });

async function fixture(dir: string, name: string, edit?: (m: Manifest) => void) {
  const f = figure(name);
  await mkdir(join(dir, "in"), { recursive: true });
  for (const [s, v] of Object.entries(f.states))
    await writeFile(join(dir, "in", `${s}.png`), png(v!.image));
  const m = structuredClone(f.manifest);
  edit?.(m);
  await writeFile(join(dir, "in", "manifest.json"), JSON.stringify(m));
  return f;
}

async function raster(path: string): Promise<Raster> {
  const d = await decodeImage(await readFile(path));
  return d.value!.raster;
}

describe("assets (usage)", () => {
  test("needs a known command", async () => {
    const dir = await tmp();
    expect((await cli(dir, [])).code).toBe(2);
    const r = await cli(dir, ["nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown assets command "nope"');
  });
  test("missing and malformed flags are usage errors (exit 2)", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "i.png"), encodePng(sample()));
    for (const args of [
      ["crop", "i.png", "-o", "o.png"],
      ["crop", "i.png", "--rect", "1,2,3", "-o", "o.png"],
      ["crop", "i.png", "--rect", "1,2,3,x", "-o", "o.png"],
      ["crop", "--rect", "1,2,3,4", "-o", "o.png"],
      ["cutout", "i.png", "-o", "o.png"],
      ["cutout", "i.png", "--seed", "1", "-o", "o.png"],
      ["cutout", "i.png", "--seed", "1,2", "--prior", "blob", "-o", "o.png"],
      ["locate", "i.png"],
      ["align", "i.png"],
      ["shrink", "i.png", "-o", "o.png"],
      ["figure", "m.json"],
      ["check", "m.json"],
      ["doctor", "extra"],
      ["figure", "m.json", "-d", "o", "--bogus"],
    ]) {
      expect((await cli(dir, args)).code, args.join(" ")).toBe(2);
    }
  });
  test("is listed in the top-level help and has its own help", async () => {
    const dir = await tmp();
    expect((await run(["--help"], makeDeps(dir))).stdout).toContain("assets <sub>");
    const h = await run(["assets", "--help"], makeDeps(dir));
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("pcosmo assets <command>");
  });
});

describe("assets doctor", () => {
  test("reports the environment and limits, deterministically", async () => {
    const dir = await tmp();
    const a = await cli(dir, ["doctor", "--json"]);
    const b = await cli(dir, ["doctor", "--json"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const j = json(a.stdout);
    expect(j.renderer).toBe("ok");
    expect(typeof j.noFollow).toBe("boolean");
    expect(j.limits.figure).toMatchObject({ maxParts: 64, maxPixelsPerSource: 16777216 });
    expect(j.limits.imagesInSpecs.maxBytes).toBe(2 * 1024 * 1024);
    expect(Object.keys(j.optionalTools)).toEqual(["ffmpeg", "mutool", "pdftoppm"]);
    // sorted keys at every level
    expect(Object.keys(j)).toEqual([...Object.keys(j)].sort());
  });
  test("finds an optional tool on PATH, and says when it is missing", async () => {
    const dir = await tmp();
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "mutool"), "#!/bin/sh\n", { mode: 0o755 });
    const r = await run(["assets", "doctor", "--json"], makeDeps(dir, { env: { PATH: bin } }));
    const j = json(r.stdout);
    expect(j.optionalTools.mutool).toEqual({ found: true, path: join(bin, "mutool") });
    expect(j.optionalTools.ffmpeg).toEqual({ found: false });
    expect(r.code).toBe(0); // optional tools never fail the check
  });
  test("text output", async () => {
    const dir = await tmp();
    const r = await cli(dir, ["doctor"]);
    expect(r.stdout).toContain("renderer (resvg-wasm): ok");
    expect(r.stdout).toContain("O_NOFOLLOW");
  });
});

describe("assets crop", () => {
  test("crops, removes the edge-connected background and trims", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "i.png"), encodePng(sample()));
    const r = await cli(dir, ["crop", "i.png", "--rect", "10,5,40,30", "-o", "o/c.png", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({
      ok: true,
      width: 40,
      height: 30,
      files: [{ name: "o/c.png" }],
    });
    const c = await raster(join(dir, "o/c.png"));
    expect([c.width, c.height]).toEqual([40, 30]);
    expect(
      Array.from(c.data.subarray(((10 - 5) * 40 + (20 - 10)) * 4, ((10 - 5) * 40 + 11) * 4)),
    ).toEqual([200, 20, 20, 255]);

    const t = await cli(dir, [
      "crop",
      "i.png",
      "--rect",
      "5,2,50,35",
      "--transparent",
      "--trim",
      "-o",
      "t.png",
    ]);
    expect(t.code).toBe(0);
    const tr = await raster(join(dir, "t.png"));
    expect([tr.width, tr.height]).toEqual([20, 15]); // only the red box is left
  });
  test("a rectangle outside the image is a diagnostic, exit 1, nothing written", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "i.png"), encodePng(sample()));
    const r = await cli(dir, ["crop", "i.png", "--rect", "100,100,5,5", "-o", "o.png"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("asset/bad-option");
    expect(await readdir(dir)).toEqual(["i.png"]);
  });
  test("output must be .png", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "i.png"), encodePng(sample()));
    const r = await cli(dir, ["crop", "i.png", "--rect", "0,0,5,5", "-o", "o.txt"]);
    expect(r.code).toBe(1);
    expect(await readdir(dir)).toEqual(["i.png"]);
  });
  test("inputs: traversal-free by symlink, FIFO and non-image refusal", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, "secret.png"), encodePng(sample()));
    await symlink(join(outside, "secret.png"), join(dir, "link.png"));
    execFileSync("mkfifo", [join(dir, "pipe.png")]);
    await writeFile(join(dir, "text.png"), "SECRET");
    for (const f of ["link.png", "pipe.png"]) {
      const r = await cli(dir, ["crop", f, "--rect", "0,0,5,5", "-o", "o.png"]);
      expect(r.code, f).toBe(1);
      expect(r.stderr).toContain("image/unsafe-path");
    }
    const t = await cli(dir, ["crop", "text.png", "--rect", "0,0,5,5", "-o", "o.png"]);
    expect(t.code).toBe(1);
    expect(t.stderr).toContain("image/format");
    const m = await cli(dir, ["crop", "gone.png", "--rect", "0,0,5,5", "-o", "o.png"]);
    expect(m.stderr).toContain("image/not-found");
    expect(await readdir(dir)).not.toContain("o.png");
  });
});

describe("outputs stay inside the working directory", () => {
  test("../, absolute paths outside, and a symlinked directory are refused", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await writeFile(join(dir, "i.png"), encodePng(sample()));
    await writeFile(join(outside, "victim.png"), "VICTIM");
    await symlink(outside, join(dir, "linkdir"));
    await symlink(join(outside, "victim.png"), join(dir, "linkfile.png"));
    for (const o of ["../escape.png", join(outside, "x.png"), "linkdir/x.png", "a/../../e.png"]) {
      const r = await cli(dir, ["crop", "i.png", "--rect", "0,0,5,5", "-o", o, "--json"]);
      expect(r.code, o).toBe(1);
      expect(json(r.stdout).diagnostics[0].code, o).toBe("asset/unsafe-path");
    }
    // a symlink AT the output name is replaced by a new file; what it pointed to is untouched
    const r2 = await cli(dir, ["crop", "i.png", "--rect", "0,0,5,5", "-o", "linkfile.png"]);
    expect(r2.code).toBe(0);
    expect((await lstat(join(dir, "linkfile.png"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(outside, "victim.png"), "utf8")).toBe("VICTIM");
    expect(await readdir(outside)).toEqual(["victim.png"]);
  });
});

describe("assets cutout, locate, align, shrink", () => {
  test("cutout writes a transparent sprite and reports where it was", async () => {
    const dir = await tmp();
    const f = await fixture(dir, "twins");
    const part = f.manifest.parts[0];
    const [sx, sy] = part.seeds.exploded[0];
    const r = await cli(dir, [
      "cutout",
      "in/exploded.png",
      "--seed",
      `${sx},${sy}`,
      "--prior",
      "box",
      "-o",
      "s.png",
      "--json",
    ]);
    expect(r.code, r.stdout.slice(0, 600)).toBe(0);
    const j = json(r.stdout);
    expect(j.width).toBeGreaterThan(4);
    const s = await raster(join(dir, "s.png"));
    expect([s.width, s.height]).toEqual([j.width, j.height]);
    expect(s.data.some((v, i) => i % 4 === 3 && v === 0)).toBe(true); // silhouette, not a rectangle of paper
    // a seed on the paper is not a part
    const bad = await cli(dir, ["cutout", "in/exploded.png", "--seed", "1,1", "-o", "s2.png"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("asset/not-found");
  });

  test("locate finds a cropped sprite where it was cut; align finds no shift", async () => {
    const dir = await tmp();
    const f = await fixture(dir, "main");
    await cli(dir, ["crop", "in/assembled.png", "--rect", "40,60,90,70", "-o", "sprite.png"]);
    const a = await cli(dir, [
      "locate",
      "sprite.png",
      "--in",
      "in/assembled.png",
      "--top",
      "1",
      "--scales",
      "1",
      "--json",
    ]);
    expect(a.code, a.stdout).toBe(0);
    const m = json(a.stdout).matches[0];
    expect([m.x, m.y]).toEqual([40, 60]);
    expect(m.score).toBeGreaterThan(0.99);
    const b = await cli(dir, [
      "locate",
      "sprite.png",
      "--in",
      "in/assembled.png",
      "--top",
      "1",
      "--scales",
      "1",
      "--json",
    ]);
    expect(b.stdout).toBe(a.stdout); // deterministic
    const text = await cli(dir, [
      "locate",
      "sprite.png",
      "--in",
      "in/assembled.png",
      "--top",
      "1",
      "--scales",
      "1",
    ]);
    expect(text.stdout).toMatch(/^x=40 y=60 scale=1 score=/);
    const al = await cli(dir, ["align", "in/assembled.png", "in/assembled.png", "--json"]);
    expect(al.code, al.stdout).toBe(0);
    expect(json(al.stdout).alignment).toMatchObject({ dx: 0, dy: 0 });
    expect(f.name).toBe("main");
  });

  test("shrink downscales a PNG and checks the output extension", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "i.png"), encodePng(sample()));
    const r = await cli(dir, ["shrink", "i.png", "--max-px", "30", "-o", "s.png", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ width: 30, height: 20, resized: true, format: "png" });
    expect((await raster(join(dir, "s.png"))).width).toBe(30);
    const keep = await cli(dir, ["shrink", "i.png", "--max-px", "500", "-o", "k.png"]);
    expect(keep.code).toBe(0);
    const wrong = await cli(dir, ["shrink", "i.png", "--max-px", "30", "-o", "s.jpg"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("asset/bad-option");
    expect((await cli(dir, ["shrink", "i.png", "--max-px", "0", "-o", "z.png"])).code).toBe(1);
  });

  test("a file above the 2 MiB diagram cap can still be shrunk (scans are big)", async () => {
    const dir = await tmp();
    // noise does not compress: a 1000x700 RGBA noise image is about 2.8 MB of PNG
    let s = 12345;
    const noise = solid(1200, 900, () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return [s & 255, (s >> 8) & 255, (s >> 16) & 255, 255];
    });
    const bytes = encodePng(noise);
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    await writeFile(join(dir, "big.png"), bytes);
    const r = await cli(dir, ["shrink", "big.png", "--max-px", "100", "-o", "small.png", "--json"]);
    expect(r.code, r.stdout.slice(0, 400)).toBe(0);
    expect(json(r.stdout)).toMatchObject({ width: 100, height: 75 });
  });
});

describe("assets figure", () => {
  const args = (dir: string, extra: string[] = []) => [
    "figure",
    "in/manifest.json",
    "-d",
    "out",
    "--json",
    ...extra,
  ];

  test("writes the fixed files; --show-exclusions adds the overlays; JSON is deterministic", async () => {
    const dir = await tmp();
    await fixture(dir, "twins");
    const a = await cli(dir, args(dir, ["--show-exclusions"]));
    expect(a.code, a.stdout.slice(0, 800)).toBe(0);
    const names = (await readdir(join(dir, "out"))).sort();
    const sprites = names.filter((n) => /^sprite-\d+\.png$/.test(n));
    expect(sprites.length).toBeGreaterThan(0);
    const fixed = ["base.png", "exclusions-assembled.png", "exclusions-exploded.png"];
    fixed.push("fragment.json", "report.json");
    expect(names).toEqual([...fixed, ...sprites].sort());
    const b = await cli(dir, args(dir, ["--show-exclusions"]));
    expect(b.stdout).toBe(a.stdout);
    const j = json(a.stdout);
    const written = j.files.map((f: { name: string }) => f.name).sort();
    expect(written).toEqual(names.map((n) => `out/${n}`).sort());
    expect(j.report.ok).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "out/report.json"), "utf8")).ok).toBe(true);
    // provenance and ids reach the fragment
    const p = await cli(dir, [
      "figure",
      "in/manifest.json",
      "-d",
      "out2",
      "--figure-id",
      "my-fig",
      "--src-dir",
      "out2/",
      "--label",
      "A figure",
      "--source-document",
      "Doc",
      "--source-page",
      "3",
      "--license",
      "CC0",
      "--json",
    ]);
    const frag = JSON.parse(await readFile(join(dir, "out2/fragment.json"), "utf8"));
    expect(frag.figures[0]).toMatchObject({
      id: "my-fig",
      label: "A figure",
      source: { document: "Doc", page: 3, license: "CC0" },
    });
    expect(frag.images[0].src).toBe("out2/base.png");
    expect(p.code).toBe(0);
  });

  test("output names never come from the input: odd file and part names change nothing", async () => {
    const dir = await tmp();
    await fixture(dir, "twins", (m) => {
      m.sources.exploded = "sub dir/ex ploded.png";
    });
    await mkdir(join(dir, "in/sub dir"));
    await writeFile(
      join(dir, "in/sub dir/ex ploded.png"),
      await readFile(join(dir, "in/exploded.png")),
    );
    const r = await cli(dir, args(dir));
    expect(r.code, r.stdout.slice(0, 500)).toBe(0);
    expect(
      (await readdir(join(dir, "out"))).every((n) =>
        /^(base|sprite-\d+)\.png$|^(fragment|report)\.json$/.test(n),
      ),
    ).toBe(true);
  });

  test("a failing gate exits 1 and writes only report.json and the overlays", async () => {
    const dir = await tmp();
    await fixture(dir, "twins", (m) => {
      m.parts = m.parts.slice(0, 1); // the second twin stays in the base: a ghost
    });
    const r = await cli(dir, args(dir));
    expect(r.code).toBe(1);
    const j = json(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.diagnostics.some((d: { severity: string }) => d.severity === "error")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "out/report.json"), "utf8")).ok).toBe(false);
    expect(await readdir(join(dir, "out"))).toEqual(["report.json"]);
    expect(j.fragment).toBeUndefined();
    expect(j.files.map((f: { name: string }) => f.name)).toEqual(["out/report.json"]);
    const withOverlay = await cli(dir, args(dir, ["--show-exclusions"]));
    expect(withOverlay.code).toBe(1);
    expect((await readdir(join(dir, "out"))).sort()).toEqual([
      "exclusions-assembled.png",
      "exclusions-exploded.png",
      "report.json",
    ]);
    const text = await cli(dir, ["figure", "in/manifest.json", "-d", "out3"]);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("gate: FAIL");
    expect(text.stderr).toMatch(/^error asset\//m);
  });

  test("manifest problems are diagnostics: bad JSON, unknown key, missing source", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "in"));
    await writeFile(join(dir, "in/manifest.json"), "{nope");
    const a = await cli(dir, args(dir));
    expect(a.code).toBe(1);
    expect(json(a.stdout).diagnostics[0]).toMatchObject({
      code: "asset/bad-option",
      params: { option: "manifest" },
    });
    await writeFile(
      join(dir, "in/manifest.json"),
      JSON.stringify({ sources: { exploded: "e.png" }, parts: [], extra: 1 }),
    );
    await writeFile(join(dir, "in/e.png"), encodePng(sample()));
    expect((await cli(dir, args(dir))).code).toBe(1);
    await writeFile(
      join(dir, "in/manifest.json"),
      JSON.stringify({ sources: { exploded: "nope.png" }, parts: [] }),
    );
    const m = await cli(dir, args(dir));
    expect(m.code).toBe(1);
    expect(m.stdout).toContain("image/not-found");
    expect(await readdir(dir)).toEqual(["in"]);
  });

  test("source paths: ../, absolute, symlink, symlinked directory and FIFO are image/unsafe-path", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await fixture(dir, "twins");
    await writeFile(join(outside, "e.png"), await readFile(join(dir, "in/exploded.png")));
    await symlink(join(outside, "e.png"), join(dir, "in/link.png"));
    await symlink(outside, join(dir, "in/linkdir"));
    execFileSync("mkfifo", [join(dir, "in/pipe.png")]);
    for (const src of [
      "../../" + outside.split("/").slice(-1)[0] + "/e.png",
      join(outside, "e.png"),
      "link.png",
      "linkdir/e.png",
      "pipe.png",
      "a\\b.png",
      "C:x.png",
    ]) {
      await writeFile(
        join(dir, "in/manifest.json"),
        JSON.stringify({
          sources: { exploded: src },
          parts: [{ id: "a", seeds: { exploded: [[5, 5]] } }],
        }),
      );
      const r = await cli(dir, args(dir));
      expect(r.code, src).toBe(1);
      expect(json(r.stdout).diagnostics[0].code, src).toBe("image/unsafe-path");
    }
    expect(await readdir(dir)).toEqual(["in"]);
  });

  test("-d outside the working directory or through a symlink writes nothing", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await fixture(dir, "twins");
    await symlink(outside, join(dir, "linkdir"));
    for (const d of ["../elsewhere", outside, "linkdir/sub", "linkdir"]) {
      const r = await cli(dir, ["figure", "in/manifest.json", "-d", d, "--json"]);
      expect(r.code, d).toBe(1);
      expect(
        json(r.stdout).diagnostics.some((x: { code: string }) => x.code === "asset/unsafe-path"),
        d,
      ).toBe(true);
    }
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("assets check", () => {
  test("passes on figure's outputs, fails when a sprite is tampered with", async () => {
    const dir = await tmp();
    await fixture(dir, "twins");
    expect((await cli(dir, ["figure", "in/manifest.json", "-d", "out"])).code).toBe(0);
    const ok = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
    expect(ok.code, ok.stdout.slice(0, 600)).toBe(0);
    expect(json(ok.stdout).report.ok).toBe(true);
    const again = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
    expect(again.stdout).toBe(ok.stdout);
    expect(await readdir(join(dir, "out"))).not.toContain("check.json");

    const sprite = await raster(join(dir, "out/sprite-1.png"));
    const blank = { ...sprite, data: new Uint8Array(sprite.data.length) }; // fully transparent
    await writeFile(join(dir, "out/sprite-1.png"), encodePng(blank));
    const bad = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
    expect(bad.code).toBe(1);
    expect(json(bad.stdout).ok).toBe(false);
  });

  test("only the fixed output names are read, whatever the fragment says", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await fixture(dir, "twins");
    await cli(dir, ["figure", "in/manifest.json", "-d", "out"]);
    await writeFile(join(outside, "secret.png"), "SECRET");
    const frag = JSON.parse(await readFile(join(dir, "out/fragment.json"), "utf8"));
    for (const src of [
      "../../secret.png",
      join(outside, "secret.png"),
      "secret.png",
      "out/../x.png",
    ]) {
      frag.images[0].src = src;
      await writeFile(join(dir, "out/fragment.json"), JSON.stringify(frag));
      const r = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
      expect(r.code, src).toBe(1);
      expect(json(r.stdout).diagnostics[0].code, src).toBe("image/unsafe-path");
      expect(r.stdout).not.toContain("SECRET");
    }
    frag.images = Array.from({ length: 66 }, () => ({ id: "a", src: "base.png" }));
    await writeFile(join(dir, "out/fragment.json"), JSON.stringify(frag));
    expect((await cli(dir, ["check", "in/manifest.json", "-d", "out"])).code).toBe(1);
  });

  test("a symlinked fragment.json is refused (it is the file that is read)", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await fixture(dir, "twins");
    await cli(dir, ["figure", "in/manifest.json", "-d", "out"]);
    await writeFile(join(outside, "f.json"), await readFile(join(dir, "out/fragment.json")));
    await rm(join(dir, "out/fragment.json"));
    await symlink(join(outside, "f.json"), join(dir, "out/fragment.json"));
    const r = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics[0]).toMatchObject({ code: "image/unsafe-path" });
    expect(json(r.stdout).diagnostics[0].message).toContain("out/fragment.json");
  });

  test("a symlinked sprite in the output directory is refused", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await fixture(dir, "twins");
    await cli(dir, ["figure", "in/manifest.json", "-d", "out"]);
    await writeFile(join(outside, "sprite-1.png"), await readFile(join(dir, "out/sprite-1.png")));
    await rm(join(dir, "out/sprite-1.png"));
    await symlink(join(outside, "sprite-1.png"), join(dir, "out/sprite-1.png"));
    const r = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics[0].code).toBe("image/unsafe-path");
  });

  test("src must be one shared plain directory plus a fixed name, each name once", async () => {
    const dir = await tmp();
    await fixture(dir, "twins");
    await cli(dir, ["figure", "in/manifest.json", "-d", "out", "--src-dir", "figs/"]);
    const good = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
    expect(good.code, good.stdout.slice(0, 500)).toBe(0);
    const frag = JSON.parse(await readFile(join(dir, "out/fragment.json"), "utf8"));
    const bad: [string, (f: typeof frag) => void][] = [
      ["dotdot prefix", (f) => (f.images[1].src = "../../x/sprite-1.png")],
      ["different prefix", (f) => (f.images[1].src = "other/sprite-1.png")],
      ["no prefix on one", (f) => (f.images[1].src = "sprite-1.png")],
      ["duplicate name", (f) => (f.images[1].src = f.images[0].src)],
      ["absolute", (f) => (f.images[0].src = "/figs/base.png")],
    ];
    for (const [name, edit] of bad) {
      const f = structuredClone(frag);
      edit(f);
      await writeFile(join(dir, "out/fragment.json"), JSON.stringify(f));
      const r = await cli(dir, ["check", "in/manifest.json", "-d", "out", "--json"]);
      expect(r.code, name).toBe(1);
      expect(json(r.stdout).diagnostics[0].code, name).toBe("image/unsafe-path");
    }
  });
});
