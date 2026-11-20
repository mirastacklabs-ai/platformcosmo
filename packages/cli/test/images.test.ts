import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "@platformcosmo/assets";
import { DEFAULT_IMAGE_LIMITS } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import { run } from "../src/index.js";
import {
  HAS_NOFOLLOW,
  foreignWritableDir,
  insideAssetsRoot,
  loadSpecImages,
  readExplicitFile,
  readFileSafe,
} from "../src/images.js";
import { type Calls, makeCore, makeDeps, tmp } from "./helpers.js";

const png = (w = 4, h = 3): Uint8Array => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([200, 30, 30, 255], i * 4);
  return encodePng({ width: w, height: h, data });
};

const refused = (r: Awaited<ReturnType<typeof readFileSafe>>, code: string): void => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
};

/** A directory with a good image, a secret outside it, and helpers to attack it. */
async function setup() {
  const base = await tmp();
  const dir = join(base, "spec");
  const outside = join(base, "outside");
  await mkdir(join(dir, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(dir, "a.png"), png());
  await writeFile(join(dir, "sub", "b.png"), png(5, 5));
  await writeFile(join(outside, "secret.png"), "SECRET-OUTSIDE");
  await writeFile(join(outside, "b.png"), "SECRET-OUTSIDE");
  return { base, dir, outside };
}

describe("readFileSafe: the happy path", () => {
  test("reads a file, also through subdirectories and './'", async () => {
    const { dir } = await setup();
    for (const rel of ["a.png", "./a.png", "sub/b.png", "sub/./b.png"]) {
      const r = await readFileSafe(dir, rel, 1 << 20);
      expect(r.ok, rel).toBe(true);
    }
    const r = await readFileSafe(dir, "a.png", 1 << 20);
    expect(r.ok && Array.from(r.bytes.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
  });
  test("a missing file is image/not-found with a did-you-mean", async () => {
    const { dir } = await setup();
    const r = await readFileSafe(dir, "a.pgn", 1 << 20);
    refused(r, "image/not-found");
    if (!r.ok) expect(r.suggestion).toBe('Did you mean "a.png"?');
    refused(await readFileSafe(dir, "nope/a.png", 1 << 20), "image/not-found");
    refused(await readFileSafe(join(dir, "missing-dir"), "a.png", 1 << 20), "image/not-found");
  });
});

describe("readFileSafe: traversal is refused with image/unsafe-path", () => {
  test.each([
    ["../outside/secret.png"],
    ["sub/../../outside/secret.png"],
    ["sub/../a.png"],
    ["/etc/passwd"],
    ["//etc/passwd"],
    ["a.png/"],
    ["sub//b.png"],
    ["..\\outside\\secret.png"],
    ["C:\\x.png"],
    ["file:a.png"],
    ["a\0.png"],
    [""],
    ["."],
    ["x/".repeat(300) + "a.png"],
    ["CON"],
    ["sub/nul.png"],
    ["COM1.txt"],
    ["lpt9"],
    ["a.png."],
    ["a.png "],
    ["sub /b.png"],
  ])("%j", async (rel) => {
    const { dir, outside } = await setup();
    refused(await readFileSafe(dir, rel, 1 << 20), "image/unsafe-path");
    // an absolute path to a real file outside is refused as well
    refused(await readFileSafe(dir, join(outside, "secret.png"), 1 << 20), "image/unsafe-path");
  });
});

describe("readFileSafe: links and special files", () => {
  test("a symlink to a file outside is refused and never read", async () => {
    const { dir, outside } = await setup();
    await symlink(join(outside, "secret.png"), join(dir, "link.png"));
    refused(await readFileSafe(dir, "link.png", 1 << 20), "image/unsafe-path");
  });
  test("a symlink to a file inside the directory is refused too", async () => {
    const { dir } = await setup();
    await symlink(join(dir, "a.png"), join(dir, "link.png"));
    refused(await readFileSafe(dir, "link.png", 1 << 20), "image/unsafe-path");
  });
  test("a dangling symlink is refused, not 'not found'", async () => {
    const { dir } = await setup();
    await symlink(join(dir, "gone.png"), join(dir, "link.png"));
    refused(await readFileSafe(dir, "link.png", 1 << 20), "image/unsafe-path");
  });
  test("a symlink as a directory component is refused", async () => {
    const { dir, outside } = await setup();
    await symlink(outside, join(dir, "linkdir"));
    refused(await readFileSafe(dir, "linkdir/b.png", 1 << 20), "image/unsafe-path");
    refused(await readFileSafe(dir, "linkdir/secret.png", 1 << 20), "image/unsafe-path");
  });
  test("a FIFO is refused without blocking", async () => {
    const { dir } = await setup();
    execFileSync("mkfifo", [join(dir, "pipe.png")]);
    refused(await readFileSafe(dir, "pipe.png", 1 << 20), "image/unsafe-path");
  });
  test("a directory is refused", async () => {
    const { dir } = await setup();
    refused(await readFileSafe(dir, "sub", 1 << 20), "image/unsafe-path");
    refused(await readFileSafe(dir, "a.png/x", 1 << 20), "image/unsafe-path");
  });
  test("a device is refused", async () => {
    // character devices (/dev/zero would never end) fail the regular-file check
    refused(await readFileSafe("/dev", "null", 1 << 20), "image/unsafe-path");
    refused(await readFileSafe("/dev", "zero", 1 << 20), "image/unsafe-path");
  });
});

describe("readFileSafe: size caps", () => {
  test("exactly the cap is read, one byte more is image/too-large", async () => {
    const { dir } = await setup();
    await writeFile(join(dir, "ten.bin"), new Uint8Array(10));
    const ok = await readFileSafe(dir, "ten.bin", 10);
    expect(ok.ok && ok.bytes.length).toBe(10);
    refused(await readFileSafe(dir, "ten.bin", 9), "image/too-large");
  });
  test("a huge sparse file is refused from fstat, not read", async () => {
    const { dir } = await setup();
    const big = join(dir, "huge.png");
    await writeFile(big, "");
    execFileSync("truncate", ["-s", String(8 * 1024 ** 3), big]);
    const t0 = Date.now();
    refused(await readFileSafe(dir, "huge.png", 1 << 20), "image/too-large");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("readFileSafe: a path swapped between the checks and the open", () => {
  test("file replaced by a symlink to a secret", async () => {
    const { dir, outside } = await setup();
    const r = await readFileSafe(dir, "a.png", 1 << 20, {
      afterChecks: async () => {
        await unlink(join(dir, "a.png"));
        await symlink(join(outside, "secret.png"), join(dir, "a.png"));
      },
    });
    refused(r, "image/unsafe-path");
  });
  test("a directory component replaced by a symlink to a directory with the same file name", async () => {
    const { dir, outside } = await setup();
    const r = await readFileSafe(dir, "sub/b.png", 1 << 20, {
      afterChecks: async () => {
        await rename(join(dir, "sub"), join(dir, "sub-moved"));
        await symlink(outside, join(dir, "sub"));
      },
    });
    refused(r, "image/unsafe-path");
  });
  test("file replaced by a FIFO: the open does not block", async () => {
    const { dir } = await setup();
    const r = await readFileSafe(dir, "a.png", 1 << 20, {
      afterChecks: async () => {
        await unlink(join(dir, "a.png"));
        execFileSync("mkfifo", [join(dir, "a.png")]);
      },
    });
    refused(r, "image/unsafe-path");
  });
  test("file removed after the checks is image/not-found", async () => {
    const { dir } = await setup();
    const r = await readFileSafe(dir, "a.png", 1 << 20, {
      afterChecks: () => rm(join(dir, "a.png")),
    });
    refused(r, "image/not-found");
  });
  test("file grown after fstat is refused as changed, never read past cap + 1 bytes", async () => {
    const { dir } = await setup();
    await writeFile(join(dir, "g.bin"), new Uint8Array(8));
    const r = await readFileSafe(dir, "g.bin", 16, {
      afterStat: () => writeFile(join(dir, "g.bin"), new Uint8Array(1 << 20)),
    });
    refused(r, "image/unsafe-path");
    if (!r.ok) expect(r.message).toContain("changed while it was being read");
  });
  test("file truncated after fstat is refused as changed", async () => {
    const { dir } = await setup();
    await writeFile(join(dir, "g.bin"), new Uint8Array(8));
    const r = await readFileSafe(dir, "g.bin", 16, {
      afterStat: () => writeFile(join(dir, "g.bin"), new Uint8Array(3)),
    });
    refused(r, "image/unsafe-path");
  });
  // O_NOFOLLOW itself: on Linux, the identity checks (lstat dev/ino, realpath, /proc/self/fd)
  // refuse every case O_NOFOLLOW would, so no input exists that only the flag catches there; the
  // flag is what makes the open itself refuse (ELOOP) instead of reading and discarding. The test
  // above ("file replaced by a symlink to a secret") passes through ELOOP when the flag exists.
  test.runIf(process.platform === "linux")(
    "a parent swapped after the open, with a hard link inside, is caught by /proc/self/fd only",
    async () => {
      const { dir } = await setup();
      await mkdir(join(dir, "other"));
      await writeFile(join(dir, "sub", "c.png"), "SAME-INODE");
      const r = await readFileSafe(dir, "sub/c.png", 1 << 20, {
        afterOpen: async () => {
          // other/c.png is a hard link to the file we hold: dev/ino and realpath still agree
          await link(join(dir, "sub", "c.png"), join(dir, "other", "c.png"));
          await rename(join(dir, "sub"), join(dir, "sub-moved"));
          await rename(join(dir, "other"), join(dir, "sub"));
        },
      });
      refused(r, "image/unsafe-path");
    },
  );
  test("without /proc the read is refused under a directory others can rename in", async () => {
    const { dir } = await setup();
    await chmod(dir, 0o777); // world-writable, not sticky
    refused(await readFileSafe(dir, "a.png", 1 << 20, { platform: "darwin" }), "image/unsafe-path");
    await chmod(dir, 0o755);
    const ok = await readFileSafe(dir, "a.png", 1 << 20, { platform: "darwin" });
    expect(ok.ok).toBe(true);
    await chmod(dir, 0o1777); // sticky: others cannot rename our entries
    expect((await readFileSafe(dir, "a.png", 1 << 20, { platform: "darwin" })).ok).toBe(true);
  });
  test("foreignWritableDir", () => {
    expect(foreignWritableDir(0o40755, 1000, 1000)).toBe(false);
    expect(foreignWritableDir(0o40775, 1000, 1000)).toBe(true);
    expect(foreignWritableDir(0o41777, 0, 1000)).toBe(false);
    expect(foreignWritableDir(0o40755, 0, 1000)).toBe(false);
    expect(foreignWritableDir(0o40755, 2000, 1000)).toBe(true);
    expect(foreignWritableDir(0o40700, 1000, undefined)).toBe(false);
  });
});

describe("readExplicitFile (a path typed on the command line)", () => {
  test("relative and absolute paths work; the final component is never followed", async () => {
    const { base, dir, outside } = await setup();
    expect((await readExplicitFile(base, "spec/a.png", 1 << 20)).ok).toBe(true);
    expect((await readExplicitFile(base, join(dir, "a.png"), 1 << 20)).ok).toBe(true);
    await symlink(join(outside, "secret.png"), join(dir, "l.png"));
    refused(await readExplicitFile(base, "spec/l.png", 1 << 20), "image/unsafe-path");
    refused(await readExplicitFile(base, "spec/", 1 << 20), "image/unsafe-path");
    refused(await readExplicitFile(base, "spec/a\0.png", 1 << 20), "image/unsafe-path");
  });
});

test("insideAssetsRoot resolves symlinks and missing tails", async () => {
  const { base, dir, outside } = await setup();
  await symlink(outside, join(dir, "out-link"));
  expect(await insideAssetsRoot(undefined, "/anywhere")).toBe(true);
  expect(await insideAssetsRoot(dir, join(dir, "sub", "b.png"))).toBe(true);
  expect(await insideAssetsRoot(dir, join(dir, "new", "deeper", "x.png"))).toBe(true);
  expect(await insideAssetsRoot(dir, dir)).toBe(true);
  expect(await insideAssetsRoot(dir, join(base, "spec-evil"))).toBe(false);
  expect(await insideAssetsRoot(dir, join(outside, "secret.png"))).toBe(false);
  expect(await insideAssetsRoot(dir, join(dir, "out-link", "x.png"))).toBe(false);
  expect(await insideAssetsRoot(join(base, "missing"), dir)).toBe(false);
});

test("the platform reports whether O_NOFOLLOW exists", () => {
  expect(typeof HAS_NOFOLLOW).toBe("boolean");
});

describe("loadSpecImages", () => {
  const spec = (images: unknown[]) => ({ meta: { version: "1" }, images });

  test("no images: no resolver (renders stay byte-identical)", async () => {
    const { dir } = await setup();
    expect(await loadSpecImages({ meta: { version: "1" } }, dir)).toEqual({ diagnostics: [] });
    expect(await loadSpecImages(spec([]), dir)).toEqual({ diagnostics: [] });
    expect(await loadSpecImages("nonsense", dir)).toEqual({ diagnostics: [] });
  });

  test("files and inline data URIs become prepared assets; keys are sorted", async () => {
    const { dir } = await setup();
    const uri = `data:image/png;base64,${Buffer.from(png(2, 2)).toString("base64")}`;
    const r = await loadSpecImages(
      spec([
        { id: "zeta", src: "a.png" },
        { id: "alpha", src: "sub/b.png" },
        { id: "inline", src: uri },
      ]),
      dir,
    );
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.resolver?.keys()).toEqual(["alpha", "inline", "zeta"]);
    expect(r.resolver?.get("zeta")).toMatchObject({ format: "png", width: 4, height: 3 });
    expect(r.resolver?.get("alpha")).toMatchObject({ width: 5, height: 5 });
    expect(r.resolver?.get("inline")).toMatchObject({ width: 2, height: 2 });
  });

  test("unsafe, missing, oversize and non-image files are diagnostics with the spec path", async () => {
    const { dir, outside } = await setup();
    await symlink(join(outside, "secret.png"), join(dir, "link.png"));
    await writeFile(join(dir, "big.png"), new Uint8Array(DEFAULT_IMAGE_LIMITS.maxBytes + 1));
    await writeFile(join(dir, "text.png"), "just text");
    const r = await loadSpecImages(
      spec([
        { id: "a", src: "../outside/secret.png" },
        { id: "b", src: "link.png" },
        { id: "c", src: "missing.png" },
        { id: "d", src: "big.png" },
        { id: "e", src: "text.png" },
        { id: "f", src: "a.png" },
      ]),
      dir,
    );
    const by = (p: string) => r.diagnostics.find((d) => d.path === p);
    expect(by("/images/0/src")).toMatchObject({ code: "image/unsafe-path", severity: "error" });
    expect(by("/images/1/src")).toMatchObject({ code: "image/unsafe-path" });
    expect(by("/images/2/src")).toMatchObject({ code: "image/not-found" });
    expect(by("/images/3/src")).toMatchObject({ code: "image/too-large" });
    expect(r.diagnostics.find((d) => d.code === "image/format")).toBeDefined();
    expect(r.resolver?.keys()).toEqual(["f"]);
    // nothing of the secret leaked into any message
    expect(JSON.stringify(r.diagnostics)).not.toContain("SECRET");
  });

  test("more than 256 images is image/too-many and nothing is read", async () => {
    const { dir } = await setup();
    const list = Array.from({ length: 257 }, (_, i) => ({ id: `i${i}`, src: "a.png" }));
    const r = await loadSpecImages(spec(list), dir);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["image/too-many"]);
    expect(r.resolver).toBeUndefined();
  });

  test("the same file under many ids is read once", async () => {
    const { dir } = await setup();
    const list = Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, src: "a.png" }));
    const r = await loadSpecImages(spec(list), dir);
    expect(r.diagnostics).toEqual([]);
    expect(r.resolver?.keys()).toHaveLength(200);
    const hashes = new Set(r.resolver?.keys().map((k) => r.resolver?.get(k)?.hash));
    expect(hashes.size).toBe(1);
  });

  test("a total read budget stops the loading of distinct big files", async () => {
    const { dir } = await setup();
    const limits = { ...DEFAULT_IMAGE_LIMITS, maxBytes: 600, maxTotalBytes: 1000 };
    for (let i = 0; i < 6; i++) await writeFile(join(dir, `f${i}.png`), new Uint8Array(500));
    const r = await loadSpecImages(
      spec(Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, src: `f${i}.png` }))),
      dir,
      limits,
    );
    // 2000 bytes of budget: four 500-byte files fit (not images: image/format each), the fifth
    // exceeds what is left and the sixth is skipped; both are a "total" too-large, none other is
    const total = r.diagnostics.filter((d) => d.code === "image/too-large");
    expect(total.map((d) => d.path)).toEqual(["/images/4/src", "/images/5/src"]);
    expect(total.every((d) => (d.params as { reason?: string }).reason === "total")).toBe(true);
    expect(total.every((d) => d.message.includes("total limit"))).toBe(true);
    expect(r.diagnostics.filter((d) => d.code === "image/format")).toHaveLength(4);
    expect(r.diagnostics).toHaveLength(6);
  });
});

describe("build and validate load the images", () => {
  async function project() {
    const dir = await tmp();
    await writeFile(join(dir, "a.png"), png());
    const body = {
      meta: { version: "1" },
      images: [{ id: "base", src: "a.png" }],
      nodes: [{ id: "a", type: "server" }],
    };
    await writeFile(join(dir, "s.cosmo.json"), JSON.stringify(body));
    return dir;
  }

  test("build passes the prepared images to render", async () => {
    const dir = await project();
    const calls: Calls = { render: [] };
    const r = await run(["build", "s.cosmo.json"], makeDeps(dir, { core: makeCore({}, calls) }));
    expect(r.code).toBe(0);
    const images = calls.render[0]!.options!.images!;
    expect(images.keys()).toEqual(["base"]);
    expect(images.get("base")).toMatchObject({ format: "png", width: 4, height: 3 });
  });

  test("a spec without images gets no images option (1.1 behaviour unchanged)", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "s.cosmo.json"), JSON.stringify({ meta: { version: "1" } }));
    const calls: Calls = { render: [] };
    await run(["build", "s.cosmo.json"], makeDeps(dir, { core: makeCore({}, calls) }));
    expect("images" in calls.render[0]!.options!).toBe(false);
  });

  test("build and validate refuse a traversal image: exit 1, render never called", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "bad.cosmo.json"),
      JSON.stringify({ meta: { version: "1" }, images: [{ id: "x", src: "../s.cosmo.json" }] }),
    );
    const calls: Calls = { render: [] };
    const deps = makeDeps(dir, { core: makeCore({}, calls) });
    const b = await run(["build", "bad.cosmo.json"], deps);
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("image/unsafe-path");
    expect(calls.render).toHaveLength(0);
    const v = await run(["validate", "bad.cosmo.json", "--json"], deps);
    expect(v.code).toBe(1);
    expect(JSON.parse(v.stdout).diagnostics[0]).toMatchObject({
      code: "image/unsafe-path",
      path: "/images/0/src",
    });
  });

  test("validate passes the resolver to core.validate", async () => {
    const dir = await project();
    let seen: unknown;
    const core = makeCore({
      validate: (_s, ctx) => {
        seen = ctx?.images?.keys();
        return { valid: true, diagnostics: [] };
      },
    });
    const r = await run(["validate", "s.cosmo.json"], makeDeps(dir, { core }));
    expect(r.code).toBe(0);
    expect(seen).toEqual(["base"]);
  });
});
