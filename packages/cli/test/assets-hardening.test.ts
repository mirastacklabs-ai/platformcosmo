import { execFileSync } from "node:child_process";
import { link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage, encodePng, type Raster } from "@platformcosmo/assets";
import { describe, expect, test } from "vitest";
import { figure, png } from "../../../tests/fixtures/figures/gen.mjs";
import { run } from "../src/index.js";
import { makeDeps, tmp } from "./helpers.js";

const cli = (dir: string, args: string[]) => run(["assets", ...args], makeDeps(dir));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (s: string) => JSON.parse(s) as Record<string, any>;
type Diag = { code: string; severity: string };

const sample = (): Raster => {
  const data = new Uint8Array(20 * 20 * 4).fill(255);
  return { width: 20, height: 20, data };
};

async function fixture(dir: string, name: string) {
  const f = figure(name);
  await mkdir(join(dir, "in"), { recursive: true });
  for (const [s, v] of Object.entries(f.states)) {
    await writeFile(join(dir, "in", `${s}.png`), png(v!.image));
  }
  await writeFile(join(dir, "in", "manifest.json"), JSON.stringify(f.manifest));
}

describe("assets outputs: hard links, FIFOs, stale files", () => {
  test("a hard link or FIFO at an output name is replaced; the link target is untouched", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await fixture(dir, "twins");
    await mkdir(join(dir, "out"));
    await writeFile(join(outside, "victim"), "VICTIM");
    await link(join(outside, "victim"), join(dir, "out/base.png"));
    execFileSync("mkfifo", [join(dir, "out/report.json")]);
    const r = await cli(dir, ["figure", "in/manifest.json", "-d", "out", "--json"]);
    expect(r.code, r.stdout.slice(0, 400)).toBe(0);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("VICTIM");
    const base = await decodeImage(await readFile(join(dir, "out/base.png")));
    expect(base.value?.raster.width).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(dir, "out/report.json"), "utf8")).ok).toBe(true);
  });

  test("stale sprites from a larger earlier run are a warning, never deleted", async () => {
    const dir = await tmp();
    await fixture(dir, "twins");
    await mkdir(join(dir, "out"));
    await writeFile(join(dir, "out/sprite-9.png"), "OLD");
    const r = await cli(dir, ["figure", "in/manifest.json", "-d", "out", "--json"]);
    expect(r.code).toBe(0);
    const w = json(r.stdout).diagnostics.find((d: Diag) => d.code === "asset/stale-output");
    expect(w).toMatchObject({ severity: "warning", params: { files: ["sprite-9.png"] } });
    expect(await readFile(join(dir, "out/sprite-9.png"), "utf8")).toBe("OLD");
  });

  test("messages name paths relative to the working directory", async () => {
    const dir = await tmp();
    const r = await cli(dir, [
      "crop",
      join(dir, "sub/none.png"),
      "--rect",
      "0,0,1,1",
      "-o",
      "o.png",
    ]);
    expect(r.stderr).toContain("sub/none.png");
    expect(r.stderr).not.toContain(dir);
  });
});

describe("PCOSMO_ASSETS_ROOT", () => {
  const withRoot = (cwd: string, root: string) =>
    makeDeps(cwd, { env: { PCOSMO_ASSETS_ROOT: root } });

  test("inputs and outputs must resolve inside it", async () => {
    const dir = await tmp();
    const other = await tmp();
    await mkdir(join(dir, "w"));
    await writeFile(join(dir, "w/i.png"), encodePng(sample()));
    await writeFile(join(other, "o.png"), encodePng(sample()));
    await symlink(other, join(dir, "w/link"));
    const root = join(dir, "w");
    const go = (args: string[], cwd = root) =>
      run(["assets", ...args, "--json"], withRoot(cwd, root));

    expect((await go(["crop", "i.png", "--rect", "0,0,4,4", "-o", "c.png"])).code).toBe(0);
    for (const input of [join(other, "o.png"), "../../x/o.png", "link/o.png"]) {
      const r = await go(["crop", input, "--rect", "0,0,4,4", "-o", "c2.png"]);
      expect(r.code, input).toBe(1);
      expect(json(r.stdout).diagnostics[0].code, input).toBe("image/unsafe-path");
    }
    // cwd outside the root: a plain relative output is refused
    const r = await go(["crop", join(root, "i.png"), "--rect", "0,0,4,4", "-o", "c3.png"], dir);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics[0].code).toBe("asset/unsafe-path");
    expect(await readdir(dir)).toEqual(["w"]);
    // a missing root confines everything
    const gone = await run(
      ["assets", "crop", "i.png", "--rect", "0,0,4,4", "-o", "c4.png"],
      withRoot(root, join(dir, "nope")),
    );
    expect(gone.code).toBe(1);
  });

  test("figure and check honour it for manifests and directories", async () => {
    const dir = await tmp();
    const other = await tmp();
    await fixture(other, "twins");
    const bad = await run(
      ["assets", "figure", join(other, "in/manifest.json"), "-d", "out", "--json"],
      withRoot(dir, dir),
    );
    expect(bad.code).toBe(1);
    expect(json(bad.stdout).diagnostics[0].code).toBe("image/unsafe-path");
    await fixture(dir, "twins");
    const ok = await run(
      ["assets", "figure", "in/manifest.json", "-d", "out", "--json"],
      withRoot(dir, dir),
    );
    expect(ok.code).toBe(0);
    const c = await run(
      ["assets", "check", "in/manifest.json", "-d", other, "--json"],
      withRoot(dir, dir),
    );
    expect(c.code).toBe(1);
    expect(json(c.stdout).diagnostics[0].code).toBe("image/unsafe-path");
  });

  test("doctor shows it", async () => {
    const dir = await tmp();
    const r = await run(["assets", "doctor", "--json"], withRoot(dir, dir));
    expect(json(r.stdout).assetsRoot).toBe(dir);
  });
});

describe("assets schema and doctor warnings", () => {
  test("schema prints the shipped manifest schema", async () => {
    const dir = await tmp();
    const r = await cli(dir, ["schema"]);
    expect(r.code).toBe(0);
    const shipped = JSON.parse(
      await readFile(new URL("../schema/figure-manifest.v1.json", import.meta.url), "utf8"),
    );
    expect(JSON.parse(r.stdout)).toEqual(shipped);
    expect((await cli(dir, ["schema", "extra"])).code).toBe(2);
  });

  test("a missing optional tool is a warning with exit 0", async () => {
    const dir = await tmp();
    const r = await run(
      ["assets", "doctor", "--json"],
      makeDeps(dir, { env: { PATH: dir }, pdfRender: { toolDirs: [dir] } }),
    );
    expect(r.code).toBe(0);
    const w = json(r.stdout).diagnostics.filter((d: Diag) => d.code === "asset/tool-missing");
    expect(w).toHaveLength(3);
    expect(w.every((d: Diag) => d.severity === "warning")).toBe(true);
  });
});
