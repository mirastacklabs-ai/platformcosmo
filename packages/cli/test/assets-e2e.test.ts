/**
 * End to end on the BUILT bin (`pnpm test` builds first): the synthetic trap figures are written
 * as PNGs, `pcosmo assets figure` runs the pipeline and the gate, and `pcosmo build` renders the
 * fragment it wrote, with the sprites embedded once per hash. Nothing is mocked.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { figure, png } from "../../../tests/fixtures/figures/gen.mjs";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pcosmo-assets-e2e-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}
const pcosmo = async (args: string[]): Promise<Out> => {
  try {
    const r = await exec(process.execPath, [bin, ...args], { cwd: root, maxBuffer: 1 << 26 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
};

const figureArgs = (name: string, outDir: string): string[] => [
  "assets",
  "figure",
  `in-${name}/manifest.json`,
  "-d",
  outDir,
  "--src-dir",
  `out-${name}/`,
  "--figure-id",
  "fig",
  "--show-exclusions",
  "--json",
];

for (const name of ["main", "busy-callout"]) {
  describe(`trap figure "${name}"`, () => {
    const outDir = `out-${name}`;
    let figureOut: Out;
    let json: {
      ok: boolean;
      diagnostics: { severity: string; code: string }[];
      files: { name: string }[];
      report: { ok: boolean };
    };

    beforeAll(async () => {
      const f = figure(name);
      await mkdir(join(root, `in-${name}`), { recursive: true });
      for (const [state, s] of Object.entries(f.states)) {
        await writeFile(join(root, `in-${name}`, `${state}.png`), png(s!.image));
      }
      await writeFile(
        join(root, `in-${name}`, "manifest.json"),
        JSON.stringify(f.manifest, null, 2),
      );
      figureOut = await pcosmo(figureArgs(name, outDir));
      json = JSON.parse(figureOut.stdout);
    });

    test("the gate has zero errors and the exit code is 0", () => {
      expect(figureOut.code, figureOut.stdout.slice(0, 2000)).toBe(0);
      expect(json.ok).toBe(true);
      expect(json.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(json.report.ok).toBe(true);
    });

    test("writes only the fixed names", async () => {
      const names = (await readdir(join(root, outDir))).sort();
      const fixed = ["base.png", "exclusions-assembled.png", "exclusions-exploded.png"];
      fixed.push("fragment.json", "report.json");
      const sprites = names.filter((n) => /^sprite-\d+\.png$/.test(n));
      expect(sprites.length).toBeGreaterThan(0);
      expect(names).toEqual([...fixed, ...sprites].sort());
      expect(json.files.map((x) => x.name).sort()).toEqual(
        names.map((n) => `${outDir}/${n}`).sort(),
      );
    });

    test("is deterministic: a second run writes identical bytes", async () => {
      const again = await pcosmo(figureArgs(name, `${outDir}-2`));
      expect(again.code).toBe(0);
      for (const n of await readdir(join(root, outDir))) {
        const a = await readFile(join(root, `${outDir}-2`, n));
        expect(a.equals(await readFile(join(root, outDir, n))), n).toBe(true);
      }
      // the JSON summary differs only in the output directory it names
      expect(again.stdout.replaceAll(`${outDir}-2/`, `${outDir}/`)).toBe(figureOut.stdout);
    });

    test("assets check passes on the written outputs", async () => {
      const r = await pcosmo([
        "assets",
        "check",
        `in-${name}/manifest.json`,
        "-d",
        outDir,
        "--json",
      ]);
      expect(r.code, r.stdout.slice(0, 2000)).toBe(0);
      expect(JSON.parse(r.stdout).report.ok).toBe(true);
    });

    test("pcosmo build renders the fragment, sprites embedded once per hash", async () => {
      const fragment = JSON.parse(await readFile(join(root, outDir, "fragment.json"), "utf8"));
      const spec = { meta: { version: "1", title: `E2E ${name}` }, ...fragment };
      await writeFile(join(root, `${name}.cosmo.json`), JSON.stringify(spec));
      const v = await pcosmo(["validate", `${name}.cosmo.json`]);
      expect(v.code, v.stderr).toBe(0);
      const b = await pcosmo(["build", `${name}.cosmo.json`, "-o", `svg-${name}`, "--json"]);
      expect(b.code, b.stdout.slice(0, 2000)).toBe(0);
      const svg = await readFile(join(root, `svg-${name}`, `${name}.svg`), "utf8");
      const embedded = [
        ...svg.matchAll(/<image\b[^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g),
      ];
      // one <image> per distinct picture (base + sprites), never one per use of a sprite
      expect(embedded.length).toBe(fragment.images.length);
      expect(new Set(embedded.map((m) => m[1])).size).toBe(embedded.length);
      const parts = fragment.figures[0].parts.length;
      // the twin heat sinks of "main" share one sprite: more parts than sprites
      if (name === "main") expect(parts).toBeGreaterThan(fragment.images.length - 1);
      const uses = [...svg.matchAll(/<use\b[^>]*href="#[^"]*"/g)].length;
      expect(uses).toBeGreaterThanOrEqual(parts);
    });
  });
}

describe("image loading from the CLI", () => {
  test("a missing image is reported by validate and build (image/not-found, did you mean)", async () => {
    await writeFile(join(root, "real.png"), png(figure("main").states.assembled!.image));
    await writeFile(
      join(root, "missing.cosmo.json"),
      JSON.stringify({
        meta: { version: "1" },
        images: [{ id: "b", src: "rael.png" }],
        figures: [{ id: "f", base: "b", parts: [] }],
      }),
    );
    for (const cmd of ["validate", "build"]) {
      const r = await pcosmo([cmd, "missing.cosmo.json"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("image/not-found");
      expect(r.stderr).toContain('Did you mean "real.png"?');
    }
  });
});
