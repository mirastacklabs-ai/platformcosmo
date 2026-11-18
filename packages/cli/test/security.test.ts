import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { run } from "../src/index.js";
import { loadUserPacks, removePack, savePack } from "../src/packs.js";
import { SPEC, iconPack, makeCore, makeDeps, tmp } from "./helpers.js";

const ENTRY = { source: "./x", resolved: "x", license: "MIT", redistributable: true };

async function spec(dir: string): Promise<string> {
  await writeFile(join(dir, "demo.cosmo.json"), SPEC);
  return "demo.cosmo.json";
}

function renderTo(path: string) {
  return makeCore({
    render: () =>
      Promise.resolve({
        outputs: [{ kind: "animated", path, mime: "image/svg+xml", data: "NEW" }],
        diagnostics: [],
        stats: { elements: 1, bytes: {} },
      }),
  });
}

describe("output writes never follow symlinks", () => {
  test("a symlinked target file is refused and the victim is untouched", async () => {
    const dir = await tmp();
    const f = await spec(dir);
    const out = join(dir, "out");
    await mkdir(out);
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "SECRET");
    await symlink(victim, join(out, "demo.svg"));
    const r = await run(["build", f, "-o", "out"], makeDeps(dir, { core: renderTo("demo.svg") }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cli/unsafe-output-path");
    expect(await readFile(victim, "utf8")).toBe("SECRET");
  });

  test("a symlinked subdirectory (steps output) is refused", async () => {
    const dir = await tmp();
    const f = await spec(dir);
    const out = join(dir, "out");
    const elsewhere = join(dir, "elsewhere");
    await mkdir(out);
    await mkdir(elsewhere);
    await symlink(elsewhere, join(out, "demo.steps"));
    const r = await run(
      ["build", f, "-o", "out"],
      makeDeps(dir, { core: renderTo("demo.steps/step-01.svg") }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cli/unsafe-output-path");
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("a plain nested output still works", async () => {
    const dir = await tmp();
    const f = await spec(dir);
    const r = await run(
      ["build", f, "-o", "out"],
      makeDeps(dir, { core: renderTo("demo.steps/step-01.svg") }),
    );
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "out", "demo.steps", "step-01.svg"), "utf8")).toBe("NEW");
  });
});

describe("--packs-dir reaches the resolver", () => {
  test("a locked user pack in --packs-dir is loaded by build, validate and icons search", async () => {
    const dir = await tmp();
    const f = await spec(dir);
    const packs = join(dir, "packs");
    await savePack(packs, iconPack("mine"), ENTRY);
    const seen: string[][] = [];
    const core = makeCore({
      createIconResolver: (p) => {
        seen.push(p.map((x) => x.manifest.pack.id));
        return {
          resolve: () => undefined,
          defaultFor: () => undefined,
          search: () => [],
          packs: () => [],
        };
      },
    });
    const deps = makeDeps(dir, { core, bundledPacks: [iconPack("cosmo")] });
    expect((await run(["build", f, "--packs-dir", packs], deps)).code).toBe(0);
    expect((await run(["validate", f, "--packs-dir", packs], deps)).code).toBe(0);
    expect((await run(["icons", "search", "x", `--packs-dir=${packs}`], deps)).code).toBe(0);
    expect(seen).toEqual([
      ["cosmo", "mine"],
      ["cosmo", "mine"],
      ["cosmo", "mine"],
    ]);
  });
});

describe("pack integrity and installation", () => {
  test("a pack saved with an extra file and an undefined field loads back with a matching hash", async () => {
    const dir = await tmp();
    const base = iconPack();
    const odd = {
      manifest: { ...base.manifest, pack: { ...base.manifest.pack, licenseUrl: undefined } },
      files: { ...base.files, "svg/unused.svg": "<svg/>" },
    };
    await savePack(dir, odd, ENTRY);
    const r = await loadUserPacks(dir);
    expect(r.diagnostics).toEqual([]);
    expect(r.packs).toHaveLength(1);
    expect(Object.keys(r.packs[0]!.files)).toEqual(["svg/dot.svg"]);
  });

  test("an existing pack id is refused without --force and replaced with it; no temp dirs remain", async () => {
    const dir = await tmp();
    const src = join(dir, "src");
    await mkdir(join(src, "svg"), { recursive: true });
    await writeFile(join(src, "icons.json"), JSON.stringify(iconPack("mine").manifest));
    await writeFile(join(src, "svg", "dot.svg"), "<svg viewBox='0 0 1 1'/>");
    const packs = join(dir, "packs");
    const deps = makeDeps(dir);
    expect((await run(["icons", "add", src, "--packs-dir", packs], deps)).code).toBe(0);
    const again = await run(["icons", "add", src, "--packs-dir", packs], deps);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already installed");
    await writeFile(join(src, "svg", "dot.svg"), "<svg viewBox='0 0 2 2'/>");
    expect((await run(["icons", "add", src, "--force", "--packs-dir", packs], deps)).code).toBe(0);
    expect(await readFile(join(packs, "mine", "svg", "dot.svg"), "utf8")).toContain("0 0 2 2");
    expect((await loadUserPacks(packs)).diagnostics).toEqual([]);
    expect((await readdir(packs)).sort()).toEqual(["mine", "platformcosmo-icons.lock.json"]);
  });

  test("a symlink inside a pack is rejected on load", async () => {
    const dir = await tmp();
    await savePack(dir, iconPack(), ENTRY);
    const secret = join(dir, "secret.svg");
    await writeFile(secret, "<svg/>");
    const f = join(dir, "mine", "svg", "dot.svg");
    const { rm } = await import("node:fs/promises");
    await rm(f);
    await symlink(secret, f);
    const r = await loadUserPacks(dir);
    expect(r.packs).toEqual([]);
    expect(r.diagnostics[0]!.message).toContain("symbolic link");
  });

  test("lockfile lookups use own properties only", async () => {
    const dir = await tmp();
    expect(await removePack(dir, "constructor")).toBe(false);
  });
});

describe("terminal safety, limits and migrate", () => {
  test("control characters in untrusted text are stripped from output", async () => {
    const dir = await tmp();
    const f = await spec(dir);
    const core = makeCore({
      validate: () => ({
        valid: false,
        diagnostics: [
          {
            severity: "error",
            code: "x/y",
            path: "",
            message: "bad \u001b[31mred\u0007 \u009b0m text",
          },
        ],
      }),
    });
    const r = await run(["validate", f], makeDeps(dir, { core }));
    expect(r.stderr).toContain("bad [31mred 0m text");
    // eslint-disable-next-line no-control-regex
    expect(r.stderr).not.toMatch(/[\u001b\u0007\u009b]/);
  });

  test("--limit must be an integer from 1 to 500", async () => {
    const deps = makeDeps(await tmp());
    for (const v of ["0", "501", "1.5", "abc"]) {
      expect((await run(["icons", "search", "x", "--limit", v], deps)).code, v).toBe(2);
    }
    expect((await run(["icons", "search", "x", "--limit", "5"], deps)).code).toBe(0);
  });

  test("migrate reads meta.version from the parsed spec, not the text", async () => {
    const dir = await tmp();
    // Text mentions version 1 in a description, but the real version is 9.
    await writeFile(
      join(dir, "tricky.cosmo.json"),
      JSON.stringify({ meta: { version: "9", description: 'version: "1"' } }),
    );
    const deps = makeDeps(dir);
    expect((await run(["migrate", "tricky.cosmo.json"], deps)).code).toBe(1);
    await writeFile(join(dir, "ok.cosmo.json"), JSON.stringify({ meta: { version: "1" } }));
    expect((await run(["migrate", "ok.cosmo.json"], deps)).stdout).toContain("nothing to migrate");
    await writeFile(join(dir, "broken.cosmo.json"), "{nope");
    expect((await run(["migrate", "broken.cosmo.json"], deps)).code).toBe(1);
  });

  test("user errors in icons commands are exit 1, not internal errors", async () => {
    const dir = await tmp();
    const deps = makeDeps(dir);
    const r = await run(["icons", "add", "missing-dir", "--packs-dir", join(dir, "p")], deps);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a directory");
    expect((await run(["icons", "remove", "../x", "--packs-dir", join(dir, "p")], deps)).code).toBe(
      2,
    );
  });
});
