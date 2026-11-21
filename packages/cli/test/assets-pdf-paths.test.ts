/**
 * The path-safety cases of D-2a applied to PDF inputs and outputs: symlinks, FIFOs, directories,
 * files outside the working directory, --root, PCOSMO_ASSETS_ROOT, hard links, oversize files.
 */
import { execFile, execFileSync } from "node:child_process";
import { link, mkdir, readFile, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import * as g from "../../pdf/test/fixtures/gen.js";
import { type Diag, json, pdf, put, work } from "./pdf-helpers.js";
import { tmp } from "./helpers.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** The built bin, as the plugin launcher runs it. */
async function node(cwd: string, args: string[], env: Record<string, string> = {}) {
  const clean: Record<string, string | undefined> = { ...process.env, ...env };
  if (!("PCOSMO_ASSETS_ROOT" in env)) delete clean.PCOSMO_ASSETS_ROOT;
  try {
    const r = await exec(process.execPath, [bin, "assets", "pdf", ...args], { cwd, env: clean });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

const codes = (stdout: string): string[] => json(stdout).diagnostics.map((d: Diag) => d.code);

describe("inputs", () => {
  test("a symlink, a symlinked directory, a FIFO and a directory are refused; nothing is read through them", async () => {
    const dir = await work();
    const outside = await tmp();
    await writeFile(join(outside, "secret.pdf"), g.rasterPdf());
    await symlink(join(outside, "secret.pdf"), join(dir, "link.pdf"));
    await symlink(outside, join(dir, "linkdir"));
    execFileSync("mkfifo", [join(dir, "pipe.pdf")]);
    await mkdir(join(dir, "adir.pdf"));
    for (const sub of [
      ["info"],
      ["list"],
      ["text", "--page", "1"],
      ["extract", "--all", "-d", "o"],
      ["compose", "--page", "1", "-o", "o.png"],
      ["render", "--page", "1", "-o", "o.png"],
    ]) {
      for (const f of ["link.pdf", "linkdir/secret.pdf", "pipe.pdf", "adir.pdf"]) {
        const [s, ...rest] = sub;
        const r = await pdf(dir, [s!, f, ...rest, "--json"]);
        expect(r.code, `${s} ${f}`).toBe(1);
        expect(codes(r.stdout)[0], `${s} ${f}`).toBe("image/unsafe-path");
      }
    }
    expect((await readdir(dir)).sort()).toEqual(["adir.pdf", "link.pdf", "linkdir", "pipe.pdf"]);
  });

  test("a missing file suggests the nearest name; a hostile path is not a path", async () => {
    const dir = await work();
    await put(dir, "booklet.pdf", g.rasterPdf());
    const r = await pdf(dir, ["info", "bookelt.pdf", "--json"]);
    expect(json(r.stdout).diagnostics[0]).toMatchObject({
      code: "image/not-found",
      suggestion: expect.stringContaining("booklet.pdf"),
    });
    const nul = await pdf(dir, ["info", "a\0b.pdf", "--json"]);
    expect(codes(nul.stdout)[0]).toBe("image/unsafe-path");
  });

  test("a PDF over the 256 MiB cap is refused before it is read", async () => {
    const dir = await work();
    await writeFile(join(dir, "big.pdf"), "%PDF-1.4\n");
    await truncate(join(dir, "big.pdf"), 256 * 1024 * 1024 + 1);
    const r = await pdf(dir, ["info", "big.pdf", "--json"]);
    expect(r.code).toBe(1);
    expect(codes(r.stdout)[0]).toBe("image/too-large");
  });

  test("../ and absolute paths outside the working directory: refused with the --root hint; --root allows", async () => {
    const top = await work();
    const cwd = join(top, "cwd");
    await mkdir(cwd);
    await put(top, "x.pdf", g.rasterPdf());
    for (const f of ["../x.pdf", join(top, "x.pdf")]) {
      const r = await pdf(cwd, ["info", f, "--json"]);
      expect(r.code).toBe(1);
      expect(json(r.stdout).diagnostics[0]).toMatchObject({
        code: "image/unsafe-path",
        suggestion: expect.stringContaining("--root"),
      });
    }
    const ok = await pdf(cwd, ["info", "../x.pdf", "--root", "..", "--json"]);
    expect(ok.code, ok.stdout).toBe(0);
  });

  test("PCOSMO_ASSETS_ROOT is the outer bound and --root cannot leave it (the built bin)", async () => {
    const top = await work();
    const cwd = join(top, "cwd");
    await mkdir(cwd);
    await put(top, "x.pdf", g.rasterPdf());
    await put(cwd, "in.pdf", g.rasterPdf());
    const env = { PCOSMO_ASSETS_ROOT: cwd };
    expect((await node(cwd, ["info", "in.pdf", "--json"], env)).code).toBe(0);
    const cases: [string[], string][] = [
      [["info", "../x.pdf"], "image/unsafe-path"],
      [["info", "../x.pdf", "--root", ".."], "asset/unsafe-path"],
      [["info", "in.pdf", "--root", "/"], "asset/unsafe-path"],
    ];
    for (const [args, code] of cases) {
      const r = await node(cwd, [...args, "--json"], env);
      expect(r.code, args.join(" ")).toBe(1);
      expect(codes(r.stdout)[0]).toBe(code);
    }
  }, 120_000);
});

describe("outputs", () => {
  test("../, absolute paths outside and a symlinked directory write nothing", async () => {
    const top = await work();
    const cwd = join(top, "cwd");
    await mkdir(cwd);
    const outside = await tmp();
    await put(cwd, "a.pdf", g.rasterPdf());
    await symlink(outside, join(cwd, "linkdir"));
    const cases: string[][] = [
      ["compose", "a.pdf", "--page", "1", "-o", "../up.png"],
      ["compose", "a.pdf", "--page", "1", "-o", join(outside, "abs.svg")],
      ["compose", "a.pdf", "--page", "1", "-o", "linkdir/c.png"],
      ["extract", "a.pdf", "--all", "-d", "../up"],
      ["extract", "a.pdf", "--all", "-d", "linkdir/x"],
      ["extract", "a.pdf", "--page", "1", "--image", "0", "-o", "linkdir/j.jpg"],
      ["extract", "a.pdf", "--page", "1", "--image", "0", "-d", outside],
    ];
    for (const c of cases) {
      const r = await pdf(cwd, [...c, "--json"]);
      expect(r.code, c.join(" ")).toBe(1);
      expect(codes(r.stdout), c.join(" ")).toContain("asset/unsafe-path");
    }
    expect(await readdir(outside)).toEqual([]);
    expect((await readdir(top)).sort()).toEqual(["cwd"]);
    expect((await readdir(cwd)).sort()).toEqual(["a.pdf", "linkdir"]);
  });

  test("a symlink, hard link or FIFO at an output name is replaced; its target is untouched", async () => {
    const dir = await work();
    const outside = await tmp();
    await put(dir, "a.pdf", g.rasterPdf());
    await writeFile(join(outside, "victim"), "VICTIM");
    await symlink(join(outside, "victim"), join(dir, "sym.png"));
    await link(join(outside, "victim"), join(dir, "hard.png"));
    execFileSync("mkfifo", [join(dir, "fifo.png")]);
    for (const n of ["sym.png", "hard.png", "fifo.png"]) {
      const r = await pdf(dir, [
        "compose",
        "a.pdf",
        "--page",
        "1",
        "-o",
        n,
        "--dpi",
        "36",
        "--json",
      ]);
      expect(r.code, `${n}: ${r.stdout}`).toBe(0);
      expect([...(await readFile(join(dir, n))).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    }
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("VICTIM");
  });

  test("extract --all into a directory whose files are links: replaced, targets untouched; a file as -d is refused", async () => {
    const dir = await work();
    const outside = await tmp();
    await put(dir, "a.pdf", g.rasterPdf());
    await writeFile(join(outside, "victim"), "VICTIM");
    await mkdir(join(dir, "o"));
    await symlink(join(outside, "victim"), join(dir, "o/manifest.json"));
    const r = await pdf(dir, ["extract", "a.pdf", "--all", "-d", "o", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(await readFile(join(dir, "o/manifest.json"), "utf8")).schema).toBe(
      "pcosmo-pdf-extract/1",
    );
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("VICTIM");
    await writeFile(join(dir, "afile"), "x");
    const bad = await pdf(dir, ["extract", "a.pdf", "--all", "-d", "afile", "--json"]);
    expect(bad.code).toBe(1);
    expect(codes(bad.stdout)).toContain("asset/unsafe-path");
    expect(await readFile(join(dir, "afile"), "utf8")).toBe("x");
  });

  test("a failed extraction leaves no partial set", async () => {
    const dir = await work();
    await put(dir, "a.pdf", g.rasterPdf());
    const r = await pdf(dir, [
      "extract",
      "a.pdf",
      "--page",
      "1",
      "--image",
      "99",
      "-d",
      "o",
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(await readdir(dir)).toEqual(["a.pdf"]);
  });
});
