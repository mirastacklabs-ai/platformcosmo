/**
 * End to end on the BUILT bin (`pnpm test` builds first): a storyboard spec with its images as
 * files next to it validates and builds through the CLI, with the images embedded once per hash
 * (R-2, docs/design/assemblies.md §14).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { png } from "../../../tests/fixtures/figures/gen.mjs";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pcosmo-storyboards-"));
  const solid = (w: number, h: number, r: number, g: number, b: number) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
    return png({ width: w, height: h, data });
  };
  await writeFile(join(root, "m1.png"), solid(320, 240, 200, 210, 230));
  await writeFile(join(root, "m2.png"), solid(320, 240, 180, 200, 170));
  await writeFile(join(root, "t1.png"), solid(30, 20, 60, 90, 160));
  await writeFile(join(root, "s1.png"), solid(25, 25, 90, 160, 90));
  await writeFile(
    join(root, "book.cosmo.json"),
    JSON.stringify({
      meta: { version: "1", title: "CLI storyboard" },
      images: ["m1", "m2", "t1", "s1"].map((id) => ({ id, src: `${id}.png` })),
      storyboards: [
        {
          id: "book",
          label: "Booklet",
          transition: "wipe",
          frames: [
            { number: 1, caption: "First", model: "m1", parts: [{ image: "t1", count: 2 }] },
            {
              number: 2,
              caption: "Second",
              model: "m2",
              parts: [{ image: "t1" }],
              sub: [{ image: "s1" }],
            },
          ],
        },
      ],
      steps: [
        { caption: "Build", duration: 6, assembly: [{ build: "book", to: 2 }] },
        { caption: "Back", duration: 6, assembly: [{ unbuild: "book", to: 0 }] },
        { caption: "Again", duration: 6, assembly: [{ build: "book", to: 2 }] },
      ],
    }),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const pcosmo = async (args: string[]) => {
  try {
    const r = await exec(process.execPath, [bin, ...args], { cwd: root, maxBuffer: 1 << 26 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
};

describe("storyboards through the CLI", () => {
  test("validate accepts the spec: no merge-guard error, no diagnostics", async () => {
    const r = await pcosmo(["validate", "book.cosmo.json", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("assembly/unsupported");
  });

  test("build renders every output with the images embedded once per hash", async () => {
    const r = await pcosmo(["build", "book.cosmo.json", "-o", "out", "--json"]);
    expect(r.code, r.stdout.slice(0, 2000)).toBe(0);
    const svg = await readFile(join(root, "out", "book.svg"), "utf8");
    const embedded = [
      ...svg.matchAll(/<image\b[^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g),
    ];
    expect(embedded.length).toBe(4);
    expect(new Set(embedded.map((m) => m[1])).size).toBe(4);
    expect(svg).toContain("<clipPath"); // wipe
    expect(svg).toMatch(/>2x</);
    expect(svg).toContain("Booklet");
  });

  test("a missing storyboard image is image/not-found at its declaration, with a did-you-mean", async () => {
    await writeFile(
      join(root, "missing.cosmo.json"),
      JSON.stringify({
        meta: { version: "1" },
        images: [{ id: "a", src: "m3.png" }],
        storyboards: [{ id: "b", frames: [{ model: "a" }] }],
      }),
    );
    for (const cmd of ["validate", "build"]) {
      const r = await pcosmo([cmd, "missing.cosmo.json"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("image/not-found");
      expect(r.stderr).toContain('Did you mean "m1.png"?');
    }
  });

  test("explode on a storyboard is assembly/storyboard-no-explode", async () => {
    await writeFile(
      join(root, "explode.cosmo.json"),
      JSON.stringify({
        meta: { version: "1" },
        images: [{ id: "a", src: "m1.png" }],
        storyboards: [{ id: "b", frames: [{ model: "a" }] }],
        steps: [{ assembly: [{ explode: "b" }] }],
      }),
    );
    const r = await pcosmo(["validate", "explode.cosmo.json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("assembly/storyboard-no-explode");
  });
});
