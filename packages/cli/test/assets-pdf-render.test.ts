/**
 * `assets pdf render` and the external-process safety design (src/pdftool.ts). The tools are fake
 * shell scripts in a directory named by PCOSMO_PDF_TOOLS_DIR, so nothing needs to be installed.
 * A real pdftoppm / mutool run is optional: PCOSMO_TEST_REAL_PDF_TOOLS=1 (see the last block).
 */
import { chmod, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage, encodePng, type Raster } from "@platformcosmo/assets";
import { afterEach, describe, expect, test } from "vitest";
import * as g from "../../pdf/test/fixtures/gen.js";
import { toolArgv } from "../src/pdftool.js";
import { type Diag, expectKnownCodes, json, pdf, put, work } from "./pdf-helpers.js";
import { makeDeps, tmp } from "./helpers.js";
import { run } from "../src/index.js";

const gradient = (w: number, h: number): Raster => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set([x & 255, y & 255, 7, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
};

/** A PNG signature + IHDR claiming w x h (no pixel data): what a hostile tool might emit. */
function fakeHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

interface Rig {
  dir: string;
  bin: string;
  rec: string;
  env: Record<string, string>;
}

/** A work directory, a tool directory, a record directory and the env that points at it. */
async function rig(): Promise<Rig> {
  const dir = await work();
  const aux = await tmp();
  const bin = join(aux, "bin");
  const rec = join(aux, "rec");
  await mkdir(bin);
  await mkdir(rec);
  await put(dir, "a.pdf", g.rasterPdf());
  return { dir, bin, rec, env: { PCOSMO_PDF_TOOLS_DIR: bin } };
}

async function tool(r: Rig, body: string, name = "pdftoppm"): Promise<void> {
  await writeFile(join(r.bin, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(r.bin, name), 0o755);
}

const render = (
  r: Rig,
  args: string[],
  limits?: { timeoutMs?: number; maxOutputBytes?: number; maxStreamBytes?: number },
) =>
  pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "p.png", "--json", ...args], {
    env: r.env,
    ...(limits ? { pdfRender: limits } : {}),
  });

const leftovers = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n !== "a.pdf" && n !== "p.png");

const reasonOf = (stdout: string): string => json(stdout).diagnostics[0].params.reason;

afterEach(() => {
  delete process.env.PCOSMO_TEST_SECRET;
  delete process.env.LD_PRELOAD;
  delete process.env.DYLD_INSERT_LIBRARIES;
});

describe("render: the happy path through a fake tool", () => {
  test("the PNG is validated, re-encoded and written; a crop is taken from the render", async () => {
    const r = await rig();
    const src = join(r.rec, "src.png");
    await writeFile(src, encodePng(gradient(400, 300)));
    await tool(r, `cp '${src}' out.png`);
    const ok = await render(r, ["--dpi", "72"]);
    expect(ok.code, ok.stdout).toBe(0);
    expect(json(ok.stdout)).toMatchObject({
      page: 1,
      dpi: 72,
      tool: "pdftoppm",
      width: 400,
      height: 300,
    });
    const again = await render(r, ["--dpi", "72"]);
    expect(again.stdout).toBe(ok.stdout);

    const cropped = await render(r, ["--dpi", "72", "--crop", "100,100,100,50"]);
    expect(cropped.code).toBe(0);
    const img = (await decodeImage(await readFile(join(r.dir, "p.png")))).value!.raster;
    expect([img.width, img.height]).toEqual([100, 50]);
    expect([...img.data.slice(0, 4)]).toEqual([100, 100, 7, 255]);
    expect(await leftovers(r.dir)).toEqual([]);
  });

  test("the call is pinned: fixed argv, minimal environment, the PDF on fd 3, a private cwd", async () => {
    const r = await rig();
    process.env.PCOSMO_TEST_SECRET = "s3cret";
    process.env.LD_PRELOAD = "/nonexistent/x.so";
    process.env.DYLD_INSERT_LIBRARIES = "/nonexistent/x.dylib";
    const src = join(r.rec, "src.png");
    await writeFile(src, encodePng(gradient(8, 8)));
    await tool(
      r,
      `printf '%s\\n' "$@" > '${r.rec}/argv'; env | sort > '${r.rec}/env'; pwd > '${r.rec}/pwd'; cat <&3 > '${r.rec}/input.pdf'; ls -a > '${r.rec}/ls'; cp '${src}' out.png`,
    );
    // a file name that would be dangerous if it ever reached a shell or the argument list
    const evil = "x;touch PWNED;$(id) `id`.pdf";
    await put(r.dir, evil, g.rasterPdf());
    const bytes = g.rasterPdf();
    const res = await pdf(
      r.dir,
      ["render", evil, "--page", "2", "-o", "p.png", "--dpi", "100", "--json"],
      { env: r.env },
    );
    expect(res.code, res.stdout).toBe(0);

    const argv = (await readFile(join(r.rec, "argv"), "utf8")).trimEnd().split("\n");
    expect(argv).toEqual(toolArgv("pdftoppm", 2, 100));
    expect(argv).toEqual([
      "-png",
      "-singlefile",
      "-cropbox",
      "-r",
      "100",
      "-f",
      "2",
      "-l",
      "2",
      "/dev/fd/3",
      "out",
    ]);
    expect(argv.join(" ")).not.toContain("PWNED");

    const env = Object.fromEntries(
      (await readFile(join(r.rec, "env"), "utf8"))
        .trimEnd()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const allowed = new Set([
      "PATH",
      "LANG",
      "LC_ALL",
      "HOME",
      "TMPDIR",
      "PWD",
      "_",
      "SHLVL",
      "OLDPWD",
    ]);
    expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([]);
    expect(env.PATH).toBe(
      [r.bin, "/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"].join(":"),
    );
    expect(JSON.stringify(env)).not.toMatch(/s3cret|LD_PRELOAD|DYLD_/);
    const cwd = (await readFile(join(r.rec, "pwd"), "utf8")).trim();
    expect(cwd).toMatch(/\.pcosmo-render-[0-9a-f]{16}$/);
    expect(cwd.startsWith(await realpath(r.dir))).toBe(true);
    expect(env.HOME).toBe(cwd);
    expect(new Uint8Array(await readFile(join(r.rec, "input.pdf")))).toEqual(bytes);
    expect(await readdir(r.dir)).not.toContain("PWNED");
    expect((await readdir(r.dir)).filter((n) => n.startsWith(".pcosmo-"))).toEqual([]);
  });

  test("mutool gets its own fixed argv", async () => {
    const r = await rig();
    const src = join(r.rec, "src.png");
    await writeFile(src, encodePng(gradient(8, 8)));
    await tool(r, `printf '%s\\n' "$@" > '${r.rec}/argv'; cp '${src}' out.png`, "mutool");
    const res = await render(r, ["--tool", "mutool"]);
    expect(res.code, res.stdout).toBe(0);
    expect((await readFile(join(r.rec, "argv"), "utf8")).trimEnd().split("\n")).toEqual([
      "draw",
      "-q",
      "-F",
      "png",
      "-r",
      "150",
      "-o",
      "out.png",
      "/dev/fd/3",
      "1",
    ]);
    expect(json(res.stdout).tool).toBe("mutool");
  });
});

describe("render: the tool is missing", () => {
  test("pdf/renderer-missing with a clear message; nothing is written; doctor agrees", async () => {
    const r = await rig();
    const res = await render(r, []);
    expect(res.code).toBe(1);
    const d = json(res.stdout).diagnostics[0];
    expect(d).toMatchObject({ code: "pdf/renderer-missing", severity: "error" });
    expect(d.message).toContain("pdftoppm or mutool");
    expect(d.suggestion).toContain("poppler-utils");
    expect(await leftovers(r.dir)).toEqual([]);
    const text = await pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "p.png"], {
      env: r.env,
    });
    expect(text.stderr).toContain("error pdf/renderer-missing");

    const doc = json(
      (await run(["assets", "doctor", "--json"], makeDeps(r.dir, { env: r.env }))).stdout,
    );
    expect(doc.pdf.render).toMatchObject({ available: false, tool: null, searchedDirs: [r.bin] });
    expect(doc.pdf.limits.maxFileBytes).toBe(256 * 1024 * 1024);
    expect(doc.pdf.commands.maxPagesPerCommand).toBe(1000);
    await tool(r, "exit 0", "mutool");
    const doc2 = json(
      (await run(["assets", "doctor", "--json"], makeDeps(r.dir, { env: r.env }))).stdout,
    );
    expect(doc2.pdf.render).toMatchObject({ available: true, tool: "mutool" });
  });

  test("asking for the other tool is also renderer-missing; a bad --tool is a usage error", async () => {
    const r = await rig();
    await tool(r, "exit 0", "pdftoppm");
    const res = await render(r, ["--tool", "mutool"]);
    expect(json(res.stdout).diagnostics[0].code).toBe("pdf/renderer-missing");
    expect((await render(r, ["--tool", "convert"])).code).toBe(2);
  });

  test("a tool that is not executable, or a directory, is not used", async () => {
    const r = await rig();
    await writeFile(join(r.bin, "pdftoppm"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await mkdir(join(r.bin, "mutool"));
    const res = await render(r, []);
    expect(json(res.stdout).diagnostics[0].code).toBe("pdf/renderer-missing");
  });
});

describe("render: hostile and broken tools are refused or bounded", () => {
  test("a tool that fails: exit status and a sanitised message, nothing written", async () => {
    const r = await rig();
    await tool(r, `printf '\\033[31mboom\\033]0;title\\007 ../../etc\\n' >&2; exit 3`);
    const res = await render(r, []);
    expect(res.code).toBe(1);
    const d = json(res.stdout).diagnostics[0];
    expect(d).toMatchObject({
      code: "pdf/renderer-failed",
      params: { reason: "exit", tool: "pdftoppm" },
    });
    // eslint-disable-next-line no-control-regex
    expect(d.message).not.toMatch(/[\u0000-\u001f]/);
    expect(d.message).toContain("exit 3");
    expect(await leftovers(r.dir)).toEqual([]);
  });

  test("a tool that hangs is killed with its whole process group", async () => {
    const r = await rig();
    await tool(r, `sleep 60 &\necho $! > '${r.rec}/child'\nsleep 60`);
    const t0 = Date.now();
    const res = await render(r, [], { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.code).toBe(1);
    expect(reasonOf(res.stdout)).toBe("timeout");
    const child = Number((await readFile(join(r.rec, "child"), "utf8")).trim());
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(child, 0);
        // a killed process nobody has reaped yet (no init in a container) is a zombie: dead
        const stat = await readFile(`/proc/${child}/stat`, "utf8").catch(() => "");
        if (/^\d+ \(.*\) Z/.test(stat)) alive = false;
        else await new Promise((ok) => setTimeout(ok, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive, "the grandchild is still running").toBe(false);
    expect(await leftovers(r.dir)).toEqual([]);
  }, 20_000);

  test("oversize output is cut off while it is being written", async () => {
    const r = await rig();
    await tool(r, `while :; do head -c 65536 /dev/zero >> out.png; done`);
    const t0 = Date.now();
    const res = await render(r, [], { maxOutputBytes: 300_000, timeoutMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(reasonOf(res.stdout)).toBe("output-too-large");
    expect(await leftovers(r.dir)).toEqual([]);
  }, 30_000);

  test("a finished but oversize file is refused by the size cap", async () => {
    const r = await rig();
    await tool(r, `head -c 400000 /dev/zero > out.png`);
    const res = await render(r, [], { maxOutputBytes: 100_000 });
    expect(reasonOf(res.stdout)).toBe("output-too-large");
  });

  test("a flood on stdout is cut off", async () => {
    const r = await rig();
    await tool(r, `yes`);
    const res = await render(r, [], { maxStreamBytes: 1024, timeoutMs: 20_000 });
    expect(reasonOf(res.stdout)).toBe("output-too-large");
  }, 30_000);

  test("too many files created is cut off", async () => {
    const r = await rig();
    await tool(r, `i=0; while [ $i -lt 200 ]; do : > f$i; i=$((i+1)); done; sleep 30`);
    const res = await render(r, [], { timeoutMs: 20_000 });
    expect(reasonOf(res.stdout)).toBe("output-too-large");
  }, 30_000);

  test("a symlink at the output name is not followed: the file it points at is never read", async () => {
    const r = await rig();
    const outside = await tmp();
    await writeFile(join(outside, "secret.png"), encodePng(gradient(4, 4)));
    await tool(r, `ln -s '${outside}/secret.png' out.png`);
    const res = await render(r, []);
    expect(res.code).toBe(1);
    expect(json(res.stdout).diagnostics[0]).toMatchObject({
      code: "pdf/renderer-failed",
      params: { reason: "bad-output" },
    });
    expect(await leftovers(r.dir)).toEqual([]);
    expect((await readdir(r.dir)).includes("p.png")).toBe(false);
    expect(await readdir(outside)).toEqual(["secret.png"]);
  });

  test("a tool that writes elsewhere in its directory, or nothing at all, produces no output", async () => {
    const r = await rig();
    await tool(r, `mkdir sub; cp /dev/null sub/out.png; echo hi > other.png`);
    const res = await render(r, []);
    expect(res.code).toBe(1);
    expect(reasonOf(res.stdout)).toBe("no-output");
    expect(await leftovers(r.dir)).toEqual([]);
  });

  test("a file that is not a PNG, or claims more than 16 MP, is refused before decoding", async () => {
    const r = await rig();
    await tool(r, `echo not a png > out.png`);
    expect(reasonOf((await render(r, [])).stdout)).toBe("bad-output");
    for (const [w, h] of [
      [20000, 10],
      [5000, 5000],
      [0, 5],
      [4097, 4097],
    ]) {
      const bad = join(r.rec, `bad-${w}x${h}.png`);
      await writeFile(bad, fakeHeader(w!, h!));
      await tool(r, `cp '${bad}' out.png`);
      const res = await render(r, []);
      expect(res.code).toBe(1);
      expect(reasonOf(res.stdout), `${w}x${h}`).toBe("bad-output");
    }
    expect(await leftovers(r.dir)).toEqual([]);
  });

  test("a valid header over a truncated body is a decode error, not a crash", async () => {
    const r = await rig();
    const bad = join(r.rec, "trunc.png");
    await writeFile(bad, fakeHeader(100, 100));
    await tool(r, `cp '${bad}' out.png`);
    const res = await render(r, []);
    expect(res.code).toBe(1);
    expectKnownCodes(json(res.stdout).diagnostics);
    expect((await readdir(r.dir)).includes("p.png")).toBe(false);
  });

  test("the page is checked against the 16 MP cap before the tool starts", async () => {
    const r = await rig();
    await tool(r, `touch '${r.rec}/ran'`);
    const res = await render(r, ["--dpi", "1200"]);
    expect(res.code).toBe(1);
    expect(json(res.stdout).diagnostics[0]).toMatchObject({ code: "pdf/too-large" });
    expect(await readdir(r.rec)).toEqual([]);
    expect((await render(r, ["--dpi", "5"])).code).toBe(2);
    expect((await render(r, ["--dpi", "1201"])).code).toBe(2);
  });

  test("bad input never starts the tool: -o must be .png, the page must exist", async () => {
    const r = await rig();
    await tool(r, `touch '${r.rec}/ran'`);
    const a = await pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "p.jpg", "--json"], {
      env: r.env,
    });
    expect(a.code).toBe(1);
    const b = await pdf(r.dir, ["render", "a.pdf", "--page", "9", "-o", "p.png", "--json"], {
      env: r.env,
    });
    expect(json(b.stdout).diagnostics[0].code).toBe("pdf/bad-page");
    expect(await readdir(r.rec)).toEqual([]);
  });

  test("the output goes through the confined writer: a symlinked output directory is refused", async () => {
    const r = await rig();
    const outside = await tmp();
    const src = join(r.rec, "src.png");
    await writeFile(src, encodePng(gradient(8, 8)));
    await tool(r, `cp '${src}' out.png`);
    await symlink(outside, join(r.dir, "link"));
    const res = await pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "link/p.png", "--json"], {
      env: r.env,
    });
    expect(res.code).toBe(1);
    expect(json(res.stdout).diagnostics.map((d: Diag) => d.code)).toContain("asset/unsafe-path");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("render: argument list", () => {
  test("toolArgv is a constant template over two integers", () => {
    expect(toolArgv("pdftoppm", 3, 150)).toEqual([
      "-png",
      "-singlefile",
      "-cropbox",
      "-r",
      "150",
      "-f",
      "3",
      "-l",
      "3",
      "/dev/fd/3",
      "out",
    ]);
    expect(toolArgv("mutool", 3, 96.7)).toEqual([
      "draw",
      "-q",
      "-F",
      "png",
      "-r",
      "96",
      "-o",
      "out.png",
      "/dev/fd/3",
      "3",
    ]);
  });
});

// Real poppler / MuPDF: run in a throwaway container image that has them (not part of the normal run).
describe.skipIf(process.env.PCOSMO_TEST_REAL_PDF_TOOLS !== "1")(
  "render with the real tools",
  () => {
    test.each(["pdftoppm", "mutool"])("%s renders pages, rotated pages and crops", async (name) => {
      const dir = await work();
      await put(dir, "a.pdf", g.rasterPdf());
      const r1 = json(
        (
          await pdf(dir, [
            "render",
            "a.pdf",
            "--page",
            "1",
            "-o",
            "p1.png",
            "--dpi",
            "72",
            "--tool",
            name,
            "--json",
          ])
        ).stdout,
      );
      expect(r1).toMatchObject({ ok: true, tool: name, width: 400, height: 300 });
      const r2 = json(
        (
          await pdf(dir, [
            "render",
            "a.pdf",
            "--page",
            "2",
            "-o",
            "p2.png",
            "--dpi",
            "72",
            "--tool",
            name,
            "--json",
          ])
        ).stdout,
      );
      expect(r2).toMatchObject({ ok: true, width: 100, height: 200 });
      const c = json(
        (
          await pdf(dir, [
            "render",
            "a.pdf",
            "--page",
            "1",
            "-o",
            "c.png",
            "--dpi",
            "72",
            "--crop",
            "20,20,160,80",
            "--tool",
            name,
            "--json",
          ])
        ).stdout,
      );
      expect(c).toMatchObject({ ok: true, width: 160, height: 80 });
      const px = (await decodeImage(await readFile(join(dir, "c.png")))).value!.raster;
      const o = (40 * 160 + 80) * 4;
      expect(Math.abs(px.data[o]! - 200)).toBeLessThan(20); // the red JPEG
      expect((await readdir(dir)).filter((n) => n.startsWith(".pcosmo-"))).toEqual([]);
    });
  },
);
