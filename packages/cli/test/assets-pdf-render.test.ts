/**
 * `assets pdf render` and the external-process safety design (src/pdftool.ts). The tools are fake
 * shell scripts in a directory handed to the code through the `Deps.pdfRender` test seam, so
 * nothing needs to be installed and production has no way to point at another directory. A real
 * pdftoppm / mutool run is optional: PCOSMO_TEST_REAL_PDF_TOOLS=1 (see the last block).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeImage, encodePng, type Raster } from "@platformcosmo/assets";
import { afterEach, describe, expect, test } from "vitest";
import * as g from "../../pdf/test/fixtures/gen.js";
import {
  limitScript,
  minimalEnv,
  renderSize,
  toolArgv,
  createUnshareProbe,
  unshareAvailable,
  type RenderSeam,
} from "../src/pdftool.js";
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
}

/** A work directory, a tool directory and a record directory. */
async function rig(): Promise<Rig> {
  const dir = await work();
  const aux = await tmp();
  const bin = join(aux, "bin");
  const rec = join(aux, "rec");
  await mkdir(bin);
  await mkdir(rec);
  await put(dir, "a.pdf", g.rasterPdf());
  return { dir, bin, rec };
}

async function tool(r: Rig, body: string, name = "pdftoppm"): Promise<void> {
  await writeFile(join(r.bin, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(r.bin, name), 0o755);
}

const seam = (r: Rig, more: RenderSeam = {}): RenderSeam => ({
  toolDirs: [r.bin],
  useUnshare: false,
  ...more,
});

const render = (r: Rig, args: string[], more?: RenderSeam) =>
  pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "p.png", "--json", ...args], {
    pdfRender: seam(r, more),
  });

const leftovers = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n !== "a.pdf" && n !== "p.png");

const reasonOf = (stdout: string): string => json(stdout).diagnostics[0].params.reason;

const pngFile = async (r: Rig, w = 8, h = 8): Promise<string> => {
  const src = join(r.rec, "src.png");
  await writeFile(src, encodePng(gradient(w, h)));
  return src;
};

/** Waits (bounded) until `pid` is gone; a zombie nobody has reaped counts as gone. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    if (/^\d+ \(.*\) Z/.test(stat)) return true;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return false;
}

async function waitFor(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const t = await readFile(path, "utf8").catch(() => "");
    if (t.trim() !== "") return t.trim();
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`${path} never appeared`);
}

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

  test("the call is pinned: fixed argv with the pixel bound, limits, minimal env, read-only fd 3, private cwd", async () => {
    const r = await rig();
    process.env.PCOSMO_TEST_SECRET = "s3cret";
    process.env.LD_PRELOAD = "/nonexistent/x.so";
    process.env.DYLD_INSERT_LIBRARIES = "/nonexistent/x.dylib";
    const src = await pngFile(r);
    await tool(
      r,
      `printf '%s\\n' "$@" > '${r.rec}/argv'; env | sort > '${r.rec}/env'; pwd > '${r.rec}/pwd'; ` +
        `ulimit -f > '${r.rec}/fsize'; (echo x >&3) 2>/dev/null; echo $? > '${r.rec}/fd3write'; ` +
        `cat <&3 > '${r.rec}/input.pdf'; cp '${src}' out.png`,
    );
    // a file name that would be dangerous if it ever reached a shell or the argument list
    const evil = "x;touch PWNED;$(id) `id`.pdf";
    await put(r.dir, evil, g.rasterPdf());
    const bytes = g.rasterPdf();
    const res = await pdf(
      r.dir,
      ["render", evil, "--page", "2", "-o", "p.png", "--dpi", "100", "--json"],
      { pdfRender: seam(r) },
    );
    expect(res.code, res.stdout).toBe(0);

    // page 2 is 100 x 200 pt displayed (/Rotate 90): 139 x 278 px at 100 dpi. pdftoppm scales before
    // rotating, so it gets the swapped pair; the bound is the same either way
    const argv = (await readFile(join(r.rec, "argv"), "utf8")).trimEnd().split("\n");
    expect(argv).toEqual(toolArgv("pdftoppm", 2, 278, 139));
    expect(argv).toEqual([
      "-png",
      "-singlefile",
      "-cropbox",
      "-scale-to-x",
      "278",
      "-scale-to-y",
      "139",
      "-f",
      "2",
      "-l",
      "2",
      "/dev/fd/3",
      "out",
    ]);
    expect(argv.join(" ")).not.toContain("PWNED");
    // the wrapper set RLIMIT_FSIZE from the 64 MiB output cap (512-byte blocks)
    expect(Number((await readFile(join(r.rec, "fsize"), "utf8")).trim())).toBe(131072);
    // fd 3 is read-only: the write failed, the content is the PDF
    expect(Number((await readFile(join(r.rec, "fd3write"), "utf8")).trim())).not.toBe(0);
    expect(new Uint8Array(await readFile(join(r.rec, "input.pdf")))).toEqual(bytes);

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
      "XDG_CACHE_HOME",
      "FONTCONFIG_CACHE",
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
    expect(await readdir(r.dir)).not.toContain("PWNED");
    expect((await readdir(r.dir)).filter((n) => n.startsWith(".pcosmo-"))).toEqual([]);
  });

  test("mutool gets its own fixed argv", async () => {
    const r = await rig();
    const src = await pngFile(r);
    await tool(r, `printf '%s\\n' "$@" > '${r.rec}/argv'; cp '${src}' out.png`, "mutool");
    const res = await render(r, ["--tool", "mutool"]);
    expect(res.code, res.stdout).toBe(0);
    // page 1 is 400 x 300 pt: 834 x 625 px at 150 dpi
    expect((await readFile(join(r.rec, "argv"), "utf8")).trimEnd().split("\n")).toEqual([
      "draw",
      "-q",
      "-F",
      "png",
      "-w",
      "834",
      "-h",
      "625",
      "-o",
      "out.png",
      "/dev/fd/3",
      "1",
    ]);
    expect(json(res.stdout).tool).toBe("mutool");
  });
});

describe("render: the pixel bound is passed to the tool", () => {
  test("renderSize clamps to 16 MP and 16384 px per side for any page size", () => {
    expect(renderSize(400, 300, 72)).toEqual({ px: 400, py: 300 });
    for (const [w, h, dpi] of [
      [1e6, 1e6, 1200],
      [14400, 14400, 1200],
      [1e9, 1, 1200],
      [Number.NaN, 5, 100],
      [0, 0, 100],
      [Infinity, Infinity, 10],
      [1e306, 1e306, 1200],
    ] as const) {
      const { px, py } = renderSize(w, h, dpi);
      expect(px * py, `${w}x${h}@${dpi}`).toBeLessThanOrEqual(16_777_216);
      expect(Math.max(px, py)).toBeLessThanOrEqual(16_384);
      expect(px).toBeGreaterThanOrEqual(1);
      expect(py).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(px) && Number.isFinite(py)).toBe(true);
    }
  });

  test("toolArgv is a constant template over integers", () => {
    expect(toolArgv("pdftoppm", 3, 200, 100).slice(3, 7)).toEqual([
      "-scale-to-x",
      "200",
      "-scale-to-y",
      "100",
    ]);
    expect(toolArgv("mutool", 3, 200.9, 100.2)).toEqual([
      "draw",
      "-q",
      "-F",
      "png",
      "-w",
      "200",
      "-h",
      "100",
      "-o",
      "out.png",
      "/dev/fd/3",
      "3",
    ]);
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
      pdfRender: seam(r),
    });
    expect(text.stderr).toContain("error pdf/renderer-missing");

    const doctor = async () =>
      json(
        (
          await run(
            ["assets", "doctor", "--json"],
            makeDeps(r.dir, { env: { PATH: r.bin }, pdfRender: seam(r) }),
          )
        ).stdout,
      );
    const doc = await doctor();
    expect(doc.pdf.render).toMatchObject({ available: false, tool: null, searchedDirs: [r.bin] });
    expect(doc.optionalTools.mutool).toEqual({ found: false });
    expect(doc.pdf.limits.maxFileBytes).toBe(256 * 1024 * 1024);
    expect(doc.pdf.commands.maxPagesPerCommand).toBe(1000);
    await tool(r, "exit 0", "mutool");
    const doc2 = await doctor();
    expect(doc2.pdf.render).toMatchObject({ available: true, tool: "mutool" });
    expect(doc2.optionalTools.mutool).toEqual({ found: true, path: join(r.bin, "mutool") });
  });

  test("the environment cannot point at another tool directory", async () => {
    const r = await rig();
    await tool(r, `touch '${r.rec}/ran'`);
    await pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "p.png", "--json"], {
      env: { PCOSMO_PDF_TOOLS_DIR: r.bin, PATH: r.bin },
    });
    // (a machine with a real pdftoppm in a fixed directory may render; the fake was not used)
    expect(await readdir(r.rec)).toEqual([]);
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
    expect(await gone(child), "the grandchild is still running").toBe(true);
    expect(await leftovers(r.dir)).toEqual([]);
  }, 20_000);

  test("RLIMIT_FSIZE stops a 200 MB write: the file stays within the limit and the render fails", async () => {
    const r = await rig();
    // the tool survives the signal (as a tool that handles write errors would) and reports size
    await tool(
      r,
      `trap '' XFSZ; dd if=/dev/zero of=out.png bs=1048576 count=200 2>/dev/null; ` +
        `wc -c < out.png > '${r.rec}/size'; exit 0`,
    );
    const res = await render(r, [], { maxOutputBytes: 1_000_000, timeoutMs: 20_000 });
    expect(res.code).toBe(1);
    const size = Number(await waitFor(join(r.rec, "size")));
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(1_000_000);
    expect(await leftovers(r.dir)).toEqual([]);
  }, 30_000);

  test("a tool killed by the file size limit is reported as output-too-large", async () => {
    const r = await rig();
    await tool(r, `exec dd if=/dev/zero of=out.png bs=1048576 count=200 2>/dev/null`);
    const res = await render(r, [], { maxOutputBytes: 1_000_000, timeoutMs: 20_000 });
    expect(res.code).toBe(1);
    expect(reasonOf(res.stdout)).toBe("output-too-large");
    expect(await leftovers(r.dir)).toEqual([]);
  }, 30_000);

  test("a finished but oversize file is refused by the size cap", async () => {
    const r = await rig();
    await tool(r, `exec head -c 400000 /dev/zero > out.png`);
    const res = await render(r, [], { maxOutputBytes: 100_000 });
    expect(res.code).toBe(1);
    expect(reasonOf(res.stdout)).toBe("output-too-large");
  });

  test("writes outside the private directory are not prevented, only bounded by RLIMIT_FSIZE", async () => {
    const r = await rig();
    const src = await pngFile(r);
    await tool(
      r,
      `exec_dd() { dd if=/dev/zero of=../stray bs=1048576 count=50 2>/dev/null; }; trap '' XFSZ; exec_dd; cp '${src}' out.png`,
    );
    const res = await render(r, [], { maxOutputBytes: 200_000 });
    expect(res.code, res.stdout).toBe(0);
    // the documented residual: the stray file exists, but it cannot exceed the limit
    const stray = await readFile(join(r.dir, "stray"));
    expect(stray.length).toBeGreaterThan(0);
    expect(stray.length).toBeLessThanOrEqual(200_000);
  }, 30_000);

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

  test("a subdirectory in the private directory fails the render", async () => {
    const r = await rig();
    const src = await pngFile(r);
    await tool(r, `mkdir sub; cp '${src}' out.png`);
    const res = await render(r, []);
    expect(res.code).toBe(1);
    expect(reasonOf(res.stdout)).toBe("bad-output");
    expect((await readdir(r.dir)).includes("p.png")).toBe(false);
    expect(await leftovers(r.dir)).toEqual([]);
  });

  test("a symlink at the output name is refused and the file it points at is never read", async () => {
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

  test("a FIFO at the output name is refused without blocking", async () => {
    const r = await rig();
    await tool(r, `mkfifo out.png`);
    const t0 = Date.now();
    const res = await render(r, [], { timeoutMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.code).toBe(1);
    expect(reasonOf(res.stdout)).toBe("bad-output");
    expect(await leftovers(r.dir)).toEqual([]);
  }, 30_000);

  test("a tool that writes other files, or nothing at all, produces no output", async () => {
    const r = await rig();
    await tool(r, `echo hi > other.png`);
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
      pdfRender: seam(r),
    });
    expect(a.code).toBe(1);
    const b = await pdf(r.dir, ["render", "a.pdf", "--page", "9", "-o", "p.png", "--json"], {
      pdfRender: seam(r),
    });
    expect(json(b.stdout).diagnostics[0].code).toBe("pdf/bad-page");
    expect(await readdir(r.rec)).toEqual([]);
  });

  test("a root writable by other users (not sticky) is refused", async () => {
    const r = await rig();
    await tool(r, `touch '${r.rec}/ran'`);
    await chmod(r.dir, 0o777);
    const res = await render(r, []);
    expect(res.code).toBe(1);
    expect(json(res.stdout).diagnostics[0]).toMatchObject({
      code: "pdf/renderer-failed",
      params: { reason: "setup" },
    });
    expect(await readdir(r.rec)).toEqual([]);
  });

  test("the output goes through the confined writer: a symlinked output directory is refused", async () => {
    const r = await rig();
    const outside = await tmp();
    const src = await pngFile(r);
    await tool(r, `cp '${src}' out.png`);
    await symlink(outside, join(r.dir, "link"));
    const res = await pdf(r.dir, ["render", "a.pdf", "--page", "1", "-o", "link/p.png", "--json"], {
      pdfRender: seam(r),
    });
    expect(res.code).toBe(1);
    expect(json(res.stdout).diagnostics.map((d: Diag) => d.code)).toContain("asset/unsafe-path");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("render: wrapper, process group, sandbox reporting", () => {
  test("limitScript refuses non-integers and exits 125 when ulimit -f cannot be set", () => {
    expect(() => limitScript(1e21, 1024)).toThrow();
    expect(() => limitScript(Number.NaN, 1024)).toThrow();
    expect(() => limitScript(10, 0)).toThrow();
    const script = limitScript(1_000_000, 1024);
    expect(script).toContain("ulimit -f 1000000 || exit 125;");
    // `ulimit -f` failing (a tighter hard limit, a rejected value): the shell must not exec the tool
    const res = spawnSync(
      "/bin/sh",
      ["-c", `ulimit() { return 1; }; ${script}`, "/bin/echo", "ran"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(125);
    expect(res.stdout).not.toContain("ran");
  });

  test("the environment points the caches at a path that does not exist", () => {
    const env = minimalEnv(["/x"], "/w");
    expect(env.XDG_CACHE_HOME).toBe("/w/no-cache/x");
    expect(env.FONTCONFIG_CACHE).toBe("/w/no-cache/x");
  });

  test("a background descendant that closed its stdio is killed after a normal exit", async () => {
    const r = await rig();
    const src = await pngFile(r);
    await tool(
      r,
      `sleep 60 >/dev/null 2>&1 &
echo $! > '${r.rec}/child'
cp '${src}' out.png`,
    );
    const res = await render(r, []);
    expect(res.code, res.stdout).toBe(0);
    const child = Number(await waitFor(join(r.rec, "child")));
    expect(await gone(child), "the background sleeper survived the render").toBe(true);
  }, 30_000);

  test("without unshare a successful render says so (info); doctor reports the sandbox", async () => {
    const r = await rig();
    await tool(r, `cp '${await pngFile(r)}' out.png`);
    const res = await render(r, []);
    expect(res.code).toBe(0);
    expect(json(res.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: "pdf/render-unsandboxed", severity: "info" }),
    );
    const doc = json(
      (
        await run(
          ["assets", "doctor", "--json"],
          makeDeps(r.dir, { env: { PATH: r.bin }, pdfRender: seam(r) }),
        )
      ).stdout,
    );
    expect(doc.pdf.render.sandbox).toBe("none");
  });

  test("the seam's maxPixels applies before the tool runs", async () => {
    const r = await rig();
    await tool(r, `touch '${r.rec}/ran'`);
    const res = await render(r, ["--dpi", "72"], { maxPixels: 100, maxSide: 50 });
    expect(res.code).toBe(1);
    expect(await readFile(join(r.rec, "ran")).catch(() => null)).toBeNull();
  });
});

describe("render: signals and escapes", () => {
  test("SIGINT during a hanging render kills the tool, removes the private directory and re-raises", async () => {
    const r = await rig();
    await tool(r, `echo $$ > '${r.rec}/pid'; sleep 60 & echo $! > '${r.rec}/child'; wait`);
    const harness = join(r.rec, "harness.mjs");
    const dist = pathToFileURL(fileURLToPath(new URL("../dist/index.js", import.meta.url))).href;
    await writeFile(
      harness,
      `import { run, defaultDeps } from ${JSON.stringify(dist)};\n` +
        `const r = await run(["assets","pdf","render","a.pdf","--page","1","-o","p.png"],\n` +
        `  { ...defaultDeps(), pdfRender: { toolDirs: [${JSON.stringify(r.bin)}], useUnshare: false } });\n` +
        `console.log("finished", r.code);\n`,
    );
    const child = spawn(process.execPath, [harness], { cwd: r.dir, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: string | null }>((ok) =>
      child.on("close", (code, signal) => ok({ code, signal })),
    );
    const pid = Number(await waitFor(join(r.rec, "pid")));
    const sleeper = Number(await waitFor(join(r.rec, "child")));
    expect((await readdir(r.dir)).some((n) => n.startsWith(".pcosmo-render-"))).toBe(true);
    child.kill("SIGINT");
    const end = await exited;
    expect(end.signal).toBe("SIGINT");
    expect(await gone(pid), "the tool is still running").toBe(true);
    expect(await gone(sleeper), "the tool's child is still running").toBe(true);
    expect((await readdir(r.dir)).filter((n) => n.startsWith(".pcosmo-"))).toEqual([]);
  }, 60_000);

  test("under unshare the tool has no network interface but loopback", async () => {
    const ns = await unshareAvailable();
    if (ns === undefined) return; // degrades to a plain run; nothing to observe here
    const r = await rig();
    const src = await pngFile(r);
    await tool(
      r,
      `sed -n '3,$p' /proc/net/dev | cut -d: -f1 | tr -d ' ' > '${r.rec}/ifs'; cp '${src}' out.png`,
    );
    const res = await render(r, [], { useUnshare: true });
    expect(json(res.stdout).ok).toBe(true);
    expect((await readFile(join(r.rec, "ifs"), "utf8")).trim()).toBe("lo");
  }, 30_000);

  test("a descendant that calls setsid: recorded behaviour (killed only inside a PID namespace)", async () => {
    const r = await rig();
    // a background `setsid` becomes a session leader itself (no fork), so $! is the sleeper's pid
    await tool(
      r,
      `command -v setsid >/dev/null || { echo none > '${r.rec}/pid'; sleep 60; }\n` +
        `setsid sleep 60 &\necho $! > '${r.rec}/pid'\nsleep 60`,
    );
    const hasSetsid = await new Promise<boolean>((ok) => {
      const c = spawn("/bin/sh", ["-c", "command -v setsid"], { stdio: "ignore" });
      c.on("close", (code) => ok(code === 0));
    });
    const ns = await unshareAvailable();
    const res = await render(r, [], { timeoutMs: 1500, useUnshare: ns !== undefined });
    expect(reasonOf(res.stdout)).toBe("timeout");
    const rec = await waitFor(join(r.rec, "pid"));
    if (!hasSetsid || !/^\d+$/.test(rec)) return; // nothing to observe on this machine
    const pid = Number(rec);
    const survived = !(await gone(pid));
    // without a PID namespace the session leader escapes the group kill (the documented residual)
    expect(survived).toBe(ns === undefined);
    if (survived) process.kill(pid, "SIGKILL"); // do not leak the test's sleeper
  }, 30_000);
});

describe("unshare probe", () => {
  const fake = async (body: string): Promise<string> => {
    const dir = await tmp();
    await writeFile(join(dir, "unshare"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return dir;
  };
  const probe = (dir: string, timeoutMs = 5000) =>
    createUnshareProbe({ dirs: [dir], timeoutMs, platform: "linux" });

  test("a probe that times out is not remembered: the next call probes again", async () => {
    const dir = await fake("exec sleep 5");
    const p = probe(dir, 300);
    expect(await p()).toBeUndefined();
    await writeFile(join(dir, "unshare"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await p()).toBe(join(dir, "unshare"));
  });
  test("a probe that fails outright is remembered", async () => {
    const dir = await fake("exit 1");
    const p = probe(dir);
    expect(await p()).toBeUndefined();
    await writeFile(join(dir, "unshare"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await p()).toBeUndefined();
  });
  test("a success is remembered, and other platforms never probe", async () => {
    const dir = await fake("exit 0");
    const p = probe(dir);
    expect(await p()).toBe(join(dir, "unshare"));
    await writeFile(join(dir, "unshare"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await p()).toBe(join(dir, "unshare"));
    expect(await createUnshareProbe({ dirs: [dir], timeoutMs: 5000, platform: "darwin" })()).toBe(
      undefined,
    );
  });
});

// Real poppler / MuPDF: run in a throwaway container image that has them (not part of the normal run).
describe.skipIf(process.env.PCOSMO_TEST_REAL_PDF_TOOLS !== "1")(
  "render with the real tools",
  () => {
    test.each(["pdftoppm", "mutool"])("%s renders pages, rotated pages and crops", async (name) => {
      const dir = await work();
      await put(dir, "a.pdf", g.rasterPdf());
      const base = ["--dpi", "72", "--tool", name, "--json"];
      const r1 = json(
        (await pdf(dir, ["render", "a.pdf", "--page", "1", "-o", "p1.png", ...base])).stdout,
      );
      expect(r1).toMatchObject({ ok: true, tool: name, width: 400, height: 300 });
      const r2 = json(
        (await pdf(dir, ["render", "a.pdf", "--page", "2", "-o", "p2.png", ...base])).stdout,
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
            "--crop",
            "20,20,160,80",
            ...base,
          ])
        ).stdout,
      );
      expect(c).toMatchObject({ ok: true, width: 160, height: 80 });
      const px = (await decodeImage(await readFile(join(dir, "c.png")))).value!.raster;
      const o = (40 * 160 + 80) * 4;
      expect(Math.abs(px.data[o]! - 200)).toBeLessThan(20); // the red JPEG
      expect((await readdir(dir)).filter((n) => n.startsWith(".pcosmo-"))).toEqual([]);
    });

    test.each(["pdftoppm", "mutool"])(
      "%s with a hostile /UserUnit is held to the requested pixel size",
      async (name) => {
        const dir = await work();
        // /UserUnit 50 makes MuPDF render a 200 x 200 pt page at 10000 x 10000 px at 72 dpi
        await put(
          dir,
          "h.pdf",
          g.onePage("0 0 1 rg 10 10 80 80 re f", "", [], { pageExtra: "/UserUnit 50" }),
        );
        const r = await pdf(dir, [
          "render",
          "h.pdf",
          "--page",
          "1",
          "-o",
          "h.png",
          "--dpi",
          "72",
          "--tool",
          name,
          "--json",
        ]);
        expect(r.code, r.stdout).toBe(0);
        expect(json(r.stdout)).toMatchObject({ width: 200, height: 200 });
      },
    );
  },
);
