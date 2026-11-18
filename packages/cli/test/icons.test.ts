import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchIconPackFn } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import { run } from "../src/index.js";
import { LOCKFILE_NAME } from "../src/packs.js";
import { iconPack, makeCore, makeDeps, tmp } from "./helpers.js";

async function folderPack(dir: string, id = "mine"): Promise<string> {
  const p = join(dir, "src-pack");
  await mkdir(join(p, "svg"), { recursive: true });
  await writeFile(join(p, "icons.json"), JSON.stringify(iconPack(id).manifest));
  await writeFile(join(p, "svg", "dot.svg"), "<svg viewBox='0 0 1 1'/>");
  return p;
}

describe("icons add (local)", () => {
  test("installs a folder pack, lists it, removes it", async () => {
    const dir = await tmp();
    const packs = join(dir, "packs");
    const src = await folderPack(dir);
    const deps = makeDeps(dir, { bundledPacks: [iconPack("cosmo")] });
    const add = await run(["icons", "add", src, "--packs-dir", packs], deps);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("installed mine (1 icon, MIT)");
    const lock = JSON.parse(await readFile(join(packs, LOCKFILE_NAME), "utf8"));
    expect(lock.packs.mine.source).toBe(src);
    expect(lock.packs.mine.resolved).not.toMatch(/^\//);
    expect(lock.packs.mine.integrity).toMatch(/^sha256-/);

    const list = await run(["icons", "list", "--packs-dir", packs], deps);
    expect(list.stdout).toMatch(/cosmo\s+bundled/);
    expect(list.stdout).toMatch(/mine\s+user/);

    const rm = await run(["icons", "remove", "mine", "--packs-dir", packs], deps);
    expect(rm.stdout).toContain("removed mine");
    expect((await run(["icons", "list", "--packs-dir", packs], deps)).stdout).not.toContain("user");
    expect((await run(["icons", "remove", "mine", "--packs-dir", packs], deps)).code).toBe(1);
  });

  test("--id renames; bundled ids are protected; tampering is reported by list", async () => {
    const dir = await tmp();
    const packs = join(dir, "packs");
    const src = await folderPack(dir, "cosmo");
    const deps = makeDeps(dir, { bundledPacks: [iconPack("cosmo")] });
    const clash = await run(["icons", "add", src, "--packs-dir", packs], deps);
    expect(clash.code).toBe(1);
    expect(clash.stderr).toContain("bundled pack id");
    expect((await run(["icons", "add", src, "--id", "Bad", "--packs-dir", packs], deps)).code).toBe(
      2,
    );
    expect(
      (await run(["icons", "add", src, "--id", "renamed", "--packs-dir", packs], deps)).code,
    ).toBe(0);
    expect((await run(["icons", "remove", "cosmo", "--packs-dir", packs], deps)).stderr).toContain(
      "bundled",
    );
    await writeFile(join(packs, "renamed", "svg", "dot.svg"), "<svg/>");
    const l = await run(["icons", "list", "--packs-dir", packs], deps);
    expect(l.code).toBe(1);
    expect(l.stderr).toContain("packs/integrity-mismatch");
  });

  test("a folder without icons.json is a clear error", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "empty"));
    const r = await run(["icons", "add", "empty", "--packs-dir", join(dir, "p")], makeDeps(dir));
    expect(r.stderr).toContain("icons.json not found");
  });
});

describe("icons add (remote)", () => {
  const fetchOk: FetchIconPackFn = (source, o) => {
    expect(o.http).toBeDefined();
    return Promise.resolve({
      pack: iconPack("aws"),
      lock: {
        source,
        resolved: "https://example.com/aws.zip",
        integrity: "sha256-x",
        license: "LicenseRef-AWS",
        redistributable: false,
        iconCount: 1,
      },
      terms: "AWS terms apply.",
      diagnostics: [],
    });
  };

  test("provider pack: shows terms, records a CLI-computed integrity, warns not to redistribute", async () => {
    const dir = await tmp();
    const packs = join(dir, "packs");
    const r = await run(
      ["icons", "add", "aws", "--packs-dir", packs],
      makeDeps(dir, { core: makeCore({ fetchIconPack: fetchOk }) }),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("AWS terms apply.");
    expect(r.stdout).toContain("do not commit or redistribute");
    const lock = JSON.parse(await readFile(join(packs, LOCKFILE_NAME), "utf8"));
    expect(lock.packs.aws.integrity).not.toBe("sha256-x");
    expect(lock.packs.aws.license).toBe("LicenseRef-AWS");
    expect(lock.packs.aws.redistributable).toBe(false);
  });

  test("terms not accepted: nothing installed, hint printed", async () => {
    const dir = await tmp();
    const packs = join(dir, "packs");
    const core = makeCore({
      fetchIconPack: (_s, o) =>
        Promise.resolve(
          o.acceptTerms
            ? {
                pack: iconPack("azure"),
                lock: {
                  source: "azure",
                  resolved: "https://x",
                  integrity: "",
                  license: "LicenseRef-Azure",
                  redistributable: false,
                  iconCount: 1,
                },
                diagnostics: [],
              }
            : {
                terms: "Accept the Azure terms.",
                diagnostics: [
                  {
                    severity: "error",
                    code: "icons/terms-required",
                    path: "",
                    message: "terms must be accepted",
                  },
                ],
              },
        ),
    });
    const deps = makeDeps(dir, { core });
    const r = await run(["icons", "add", "azure", "--packs-dir", packs], deps);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Accept the Azure terms.");
    expect(r.stderr).toContain("--accept-terms");
    await expect(readFile(join(packs, LOCKFILE_NAME))).rejects.toThrow();
    expect(
      (await run(["icons", "add", "azure", "--accept-terms", "--packs-dir", packs], deps)).code,
    ).toBe(0);
  });

  test("a URL source goes through fetchIconPack with the injected http client only", async () => {
    const dir = await tmp();
    let got = "";
    const core = makeCore({
      fetchIconPack: (s) => {
        got = s;
        return Promise.resolve({
          diagnostics: [{ severity: "error", code: "icons/http", path: "", message: "refused" }],
        });
      },
    });
    const r = await run(
      ["icons", "add", "https://example.com/a.zip", "--packs-dir", join(dir, "p")],
      makeDeps(dir, { core }),
    );
    expect(got).toBe("https://example.com/a.zip");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("icons/http");
  });
});

describe("icons search / usage", () => {
  test("search prints refs and scores", async () => {
    const deps = makeDeps(await tmp());
    const r = await run(["icons", "search", "load", "balancer"], deps);
    expect(r.stdout).toContain("cosmo:load balancer");
    expect((await run(["icons", "search", "nothing"], deps)).stdout).toContain("no matches");
    expect((await run(["icons", "search"], deps)).code).toBe(2);
    expect((await run(["icons"], deps)).code).toBe(2);
    expect((await run(["icons", "zap"], deps)).code).toBe(2);
  });
});
