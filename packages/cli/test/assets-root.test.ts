import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { encodePng } from "@platformcosmo/assets";
import { describe, expect, test } from "vitest";
import { figure, png } from "../../../tests/fixtures/figures/gen.mjs";
import { run } from "../src/index.js";
import { makeDeps, tmp } from "./helpers.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (s: string) => JSON.parse(s) as Record<string, any>;

const node = async (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const clean = { ...process.env, ...env };
  if (!("PCOSMO_ASSETS_ROOT" in env)) delete clean.PCOSMO_ASSETS_ROOT;
  try {
    const r = await exec(process.execPath, [bin, "assets", ...args], { cwd, env: clean });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
};

async function layout() {
  const top = await tmp();
  const work = join(top, "work");
  await mkdir(work);
  const data = new Uint8Array(10 * 10 * 4).fill(255);
  await writeFile(join(top, "x.png"), encodePng({ width: 10, height: 10, data }));
  return { top, work };
}

describe("confinement by default (the built bin, no launcher)", () => {
  test("a bare run refuses ../x.png and suggests --root; --root .. allows it", async () => {
    const { top, work } = await layout();
    const refused = await node(work, ["crop", "../x.png", "--rect", "0,0,4,4", "-o", "o.png"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("image/unsafe-path");
    expect(refused.stderr).toContain("--root");
    expect(await readdir(work)).toEqual([]);

    const abs = await node(work, ["crop", join(top, "x.png"), "--rect", "0,0,4,4", "-o", "o.png"]);
    expect(abs.code).toBe(1);

    const ok = await node(work, [
      "crop",
      "../x.png",
      "--rect",
      "0,0,4,4",
      "-o",
      "o.png",
      "--root",
      "..",
    ]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(await readdir(work)).toEqual(["o.png"]);
    // --root=<dir> works too, and outputs may leave the working directory under it
    const out = await node(work, [
      "crop",
      "o.png",
      "--rect",
      "0,0,2,2",
      "-o",
      "../up.png",
      "--root=..",
    ]);
    expect(out.code, out.stderr).toBe(0);
    expect(await readdir(top)).toContain("up.png");
    const noOut = await node(work, ["crop", "o.png", "--rect", "0,0,2,2", "-o", "../up2.png"]);
    expect(noOut.code).toBe(1);
    expect(noOut.stderr).toContain("asset/unsafe-path");
  });

  test("under PCOSMO_ASSETS_ROOT, --root cannot leave it", async () => {
    const { top, work } = await layout();
    const env = { PCOSMO_ASSETS_ROOT: work };
    const args = ["crop", "../x.png", "--rect", "0,0,4,4", "-o", "o.png"];
    for (const root of ["/", "..", top]) {
      const r = await node(work, [...args, "--root", root, "--json"], env);
      expect(r.code, root).toBe(1);
      expect(json(r.stdout).diagnostics[0]).toMatchObject({ code: "asset/unsafe-path" });
    }
    expect(await readdir(work)).toEqual([]);
    // a --root inside the bound is fine
    await mkdir(join(work, "sub"));
    const inside = await node(work, ["doctor", "--json", "--root", "sub"], env);
    expect(json(inside.stdout).assetsRoot).toBe(join(work, "sub"));
  });

  test("doctor prints the effective root", async () => {
    const { work } = await layout();
    const plain = await node(work, ["doctor", "--json"]);
    expect(json(plain.stdout)).toMatchObject({ assetsRoot: work, assetsRootEnv: null });
    const text = await node(work, ["doctor"], { PCOSMO_ASSETS_ROOT: work });
    expect(text.stdout).toContain(`allowed directory for inputs and outputs: ${work}`);
    expect(text.stdout).toContain("bounded by PCOSMO_ASSETS_ROOT");
  });

  test("--root needs a value", async () => {
    const { work } = await layout();
    expect((await node(work, ["doctor", "--root"])).code).toBe(2);
  });
});

describe("assets figure --source-json", () => {
  async function project() {
    const dir = await tmp();
    const f = figure("twins");
    await mkdir(join(dir, "in"));
    for (const [s, v] of Object.entries(f.states)) {
      await writeFile(join(dir, "in", `${s}.png`), png(v!.image));
    }
    await writeFile(join(dir, "in", "manifest.json"), JSON.stringify(f.manifest));
    return dir;
  }
  const cli = (dir: string, extra: string[]) =>
    run(["assets", "figure", "in/manifest.json", "-d", "out", "--json", ...extra], makeDeps(dir));

  test("provenance and label from the file reach the fragment; flags win", async () => {
    const dir = await project();
    const hostile = 'Doc"; rm -rf / #\n$(x)'.replace("\n", " ");
    await writeFile(
      join(dir, "src.json"),
      JSON.stringify({
        document: hostile,
        page: 7,
        figure: "Fig. 3",
        label: "A label",
        attribution: "Someone",
        license: "CC0",
        url: "https://example.com/a?b=c",
      }),
    );
    const r = await cli(dir, ["--source-json", "src.json", "--license", "MIT"]);
    expect(r.code, r.stdout.slice(0, 400)).toBe(0);
    const frag = JSON.parse(await readFile(join(dir, "out/fragment.json"), "utf8"));
    expect(frag.figures[0]).toMatchObject({
      label: "A label",
      source: {
        document: hostile,
        page: 7,
        figure: "Fig. 3",
        attribution: "Someone",
        license: "MIT",
        url: "https://example.com/a?b=c",
      },
    });
    expect(frag.images[0].source.document).toBe(hostile);
  });

  const bad: [string, unknown][] = [
    ["control character in a string", { document: "a\u0007b" }],
    ["newline", { license: "a\nb" }],
    ["escape", { attribution: "x\u001b[31m" }],
    ["C1 control", { figure: "x\u0085y" }],
    ["line separator", { label: "x y" }],
    ["over-long document", { document: "x".repeat(501) }],
    ["over-long label", { label: "x".repeat(201) }],
    ["over-long url", { url: "x".repeat(2049) }],
    ["number for a string", { license: 5 }],
    ["string for the page", { page: "3" }],
    ["page 0", { page: 0 }],
    ["fractional page", { page: 1.5 }],
    ["unknown key", { evil: "x" }],
    ["array", ["x"]],
    ["null", null],
  ];
  test.each(bad)("refuses %s", async (_n, value) => {
    const dir = await project();
    await writeFile(join(dir, "src.json"), JSON.stringify(value));
    const r = await cli(dir, ["--source-json", "src.json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics[0]).toMatchObject({
      code: "asset/bad-option",
      params: { option: "source-json" },
    });
    expect(await readdir(dir)).not.toContain("out");
  });

  test("accepts values exactly at the caps", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "src.json"),
      JSON.stringify({ document: "x".repeat(500), label: "y".repeat(200), url: "u".repeat(2048) }),
    );
    expect((await cli(dir, ["--source-json", "src.json"])).code).toBe(0);
  });

  test("the file is read through the path guard and the root", async () => {
    const dir = await project();
    const r = await cli(dir, ["--source-json", "missing.json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).diagnostics[0].code).toBe("image/not-found");
    const outside = await tmp();
    await writeFile(join(outside, "s.json"), "{}");
    const o = await cli(dir, ["--source-json", join(outside, "s.json")]);
    expect(o.code).toBe(1);
    expect(json(o.stdout).diagnostics[0].code).toBe("image/unsafe-path");
    await writeFile(join(dir, "bad.json"), "{nope");
    expect((await cli(dir, ["--source-json", "bad.json"])).code).toBe(1);
  });
});
