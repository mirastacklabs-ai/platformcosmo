import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThemeTokens } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import { run } from "../src/index.js";
import { type Calls, SPEC, iconPack, makeCore, makeDeps, tmp } from "./helpers.js";

async function specIn(dir: string, name = "demo.cosmo.json", text = SPEC): Promise<string> {
  await writeFile(join(dir, name), text);
  return name;
}

describe("top level", () => {
  test("help, version, unknown command, per-command help", async () => {
    const deps = makeDeps(await tmp());
    expect((await run([], deps)).stdout).toContain("Usage: pcosmo <command>");
    expect((await run(["--version"], deps)).stdout).toMatch(/^\d+\.\d+\.\d+/);
    const bad = await run(["frobnicate"], deps);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown command "frobnicate"');
    expect((await run(["build", "--help"], deps)).stdout).toContain("pcosmo build <spec>");
    expect((await run(["constructor"], deps)).code).toBe(2);
  });

  test("usage errors exit 2 with the command help", async () => {
    const deps = makeDeps(await tmp());
    const r = await run(["build"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs exactly one spec file");
    expect((await run(["build", "a.json", "--bogus"], deps)).code).toBe(2);
    expect((await run(["build", "a.json", "--font", "wingdings"], deps)).code).toBe(2);
    expect((await run(["build", "a.json", "--speed", "fast"], deps)).code).toBe(2);
  });

  test("an unexpected throw is an internal error (3)", async () => {
    const dir = await tmp();
    await specIn(dir);
    const deps = makeDeps(dir, {
      core: makeCore({
        parseSpec: () => {
          throw new Error("not implemented");
        },
      }),
    });
    const r = await run(["validate", "demo.cosmo.json"], deps);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("internal error: not implemented");
  });
});

describe("init", () => {
  test("writes the starter and refuses to overwrite", async () => {
    const dir = await tmp();
    const deps = makeDeps(dir);
    const r = await run(["init"], deps);
    expect(r.code).toBe(0);
    const spec = JSON.parse(await readFile(join(dir, "diagram.cosmo.json"), "utf8"));
    expect(spec.meta.version).toBe("1");
    const again = await run(["init"], deps);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");
    expect((await run(["init", "--force"], deps)).code).toBe(0);
  });

  test("--list, --template and bad names", async () => {
    const dir = await tmp();
    const deps = makeDeps(dir);
    expect((await run(["init", "--list"], deps)).stdout).toContain("starter");
    expect((await run(["init", "x.cosmo.json", "--template", "starter"], deps)).code).toBe(0);
    expect((await run(["init", "--template", "nope"], deps)).stderr).toContain(
      'unknown template "nope"',
    );
    expect((await run(["init", "x.json"], deps)).code).toBe(2);
  });
});

describe("examples", () => {
  test("list, show, copy", async () => {
    const dir = await tmp();
    const deps = makeDeps(dir);
    const list = (await run(["examples"], deps)).stdout;
    for (const n of [
      "load-balancing",
      "rag-pipeline",
      "kubernetes-deployment",
      "cdn-cache",
      "gpu-inference-cluster",
      "dc-hall",
    ]) {
      expect(list).toContain(n);
    }
    expect(JSON.parse((await run(["examples", "show", "cdn-cache"], deps)).stdout).meta.title).toBe(
      "CDN and cache",
    );
    expect((await run(["examples", "copy", "rag-pipeline", "-o", "out"], deps)).code).toBe(0);
    expect(await readdir(join(dir, "out"))).toEqual(["rag-pipeline.cosmo.json"]);
    expect((await run(["examples", "copy", "rag-pipeline", "-o", "out"], deps)).code).toBe(1);
    expect((await run(["examples", "copy", "all", "-o", "all"], deps)).code).toBe(0);
    expect((await readdir(join(dir, "all"))).length).toBeGreaterThanOrEqual(9);
    expect((await run(["examples", "show", "nope"], deps)).code).toBe(1);
    expect((await run(["examples", "zap"], deps)).code).toBe(2);
  });
});

describe("migrate", () => {
  test("major 1 is a no-op, others fail", async () => {
    const dir = await tmp();
    const deps = makeDeps(dir);
    await specIn(dir);
    expect((await run(["migrate", "demo.cosmo.json"], deps)).stdout).toContain(
      "nothing to migrate",
    );
    await specIn(dir, "v9.cosmo.json", '{"meta":{"version":"9"}}');
    expect((await run(["migrate", "v9.cosmo.json"], deps)).code).toBe(1);
  });
});

describe("validate", () => {
  test("valid spec with a warning", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const r = await run(["validate", f], makeDeps(dir));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("valid (1 warning)");
    expect(r.stderr).toContain("warning layout/tight");
    expect((await run(["validate", f, "--strict"], makeDeps(dir))).code).toBe(1);
  });

  test("invalid spec prints suggestion and exits 1; --json is parseable", async () => {
    const dir = await tmp();
    const f = await specIn(dir, "bad.cosmo.json", '{"bad":true}');
    const r = await run(["validate", f], makeDeps(dir));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'error semantic/unknown-node bad.cosmo.json#/edges/0/to: unknown node (did you mean "web"?)',
    );
    const j = await run(["validate", f, "--json"], makeDeps(dir));
    const out = JSON.parse(j.stdout);
    expect(out.valid).toBe(false);
    expect(out.diagnostics[0].code).toBe("semantic/unknown-node");
  });

  test("parse errors stop before validation; missing file", async () => {
    const dir = await tmp();
    const f = await specIn(dir, "broken.cosmo.json", "{nope");
    const r = await run(["validate", f], makeDeps(dir));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("parse/json");
    const missing = await run(["validate", "none.cosmo.json"], makeDeps(dir));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no such file");
  });

  test("passes the icon resolver and DC pack to validate", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    let ctx: unknown;
    const deps = makeDeps(dir, {
      dcPack: { marker: true } as never,
      core: makeCore({
        validate: (_s, c) => {
          ctx = c;
          return { valid: true, diagnostics: [] };
        },
      }),
    });
    await run(["validate", f], deps);
    expect(Object.keys(ctx as object).sort()).toEqual(["dc", "icons"]);
  });
});

describe("build", () => {
  test("default output is <name>.svg next to the spec, options reach render", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const calls: Calls = { render: [] };
    const deps = makeDeps(dir, { core: makeCore({}, calls) });
    const r = await run(["build", f], deps);
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "demo.svg"), "utf8")).toBe("<svg/>");
    expect(r.stdout).toContain(`wrote ${join(dir, "demo.svg")}`);
    const o = calls.render[0]!.options!;
    expect(o).toMatchObject({ outputs: ["animated"], name: "demo", optimize: true });
  });

  test("flags map to outputs and options; --out creates the directory", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const calls: Calls = { render: [] };
    const themes = { get: (id: string) => ({ id }) as unknown as ThemeTokens, list: () => [] };
    const deps = makeDeps(dir, { core: makeCore({}, calls), themes });
    const r = await run(
      [
        "build",
        f,
        "--static",
        "--steps",
        "--interactive",
        "--png",
        "--no-animated",
        "--theme",
        "dark",
        "--font",
        "outline",
        "--speed",
        "2",
        "--scale",
        "3",
        "--time",
        "1.5",
        "--no-optimize",
        "--id-prefix",
        "x1",
        "--name",
        "my-name",
        "-o",
        "out/deep",
      ],
      deps,
    );
    expect(r.code).toBe(0);
    const o = calls.render[0]!.options!;
    expect(o.outputs).toEqual(["static", "steps", "interactive", "png"]);
    expect(o).toMatchObject({
      font: "outline",
      speed: 2,
      png: { scale: 3, time: 1.5 },
      optimize: false,
      idPrefix: "x1",
      name: "my-name",
    });
    expect((o.theme as unknown as { id: string }).id).toBe("dark");
    expect(await readdir(join(dir, "out", "deep"))).toEqual(["my-name.svg"]);
  });

  test("--no-animated alone is a usage error", async () => {
    const dir = await tmp();
    expect((await run(["build", "x.cosmo.json", "--no-animated"], makeDeps(dir))).code).toBe(2);
  });

  test("custom theme file goes through validateTheme", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    await writeFile(join(dir, "t.json"), '{"id":"mine"}');
    const calls: Calls = { render: [] };
    const deps = makeDeps(dir, {
      core: makeCore({}, calls),
      validateTheme: (x) => ({ theme: x as ThemeTokens, diagnostics: [] }),
    });
    expect((await run(["build", f, "--theme", "t.json"], deps)).code).toBe(0);
    expect((calls.render[0]!.options!.theme as unknown as { id: string }).id).toBe("mine");
    const bad = makeDeps(dir, {
      validateTheme: () => ({
        diagnostics: [{ severity: "error", code: "theme/color", path: "/x", message: "bad color" }],
      }),
    });
    const r = await run(["build", f, "--theme", "t.json"], bad);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("theme/color");
    expect((await run(["build", f, "--theme", "missing.json"], deps)).stderr).toContain(
      "theme/unreadable",
    );
  });

  test("render error diagnostics fail the build and write nothing", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const deps = makeDeps(dir, {
      core: makeCore({
        render: () =>
          Promise.resolve({
            outputs: [],
            diagnostics: [
              { severity: "error", code: "semantic/unknown-node", path: "/a", message: "m" },
            ],
            stats: { elements: 0, bytes: {} },
          }),
      }),
    });
    const r = await run(["build", f], deps);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("build failed: 1 error");
    expect(await readdir(dir)).toEqual(["demo.cosmo.json"]);
  });

  test("outputs that escape the output directory are refused", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    for (const path of ["../evil.svg", "/tmp/evil.svg", "a/../../evil.svg"]) {
      const deps = makeDeps(dir, {
        core: makeCore({
          render: () =>
            Promise.resolve({
              outputs: [{ kind: "animated", path, mime: "image/svg+xml", data: "x" }],
              diagnostics: [],
              stats: { elements: 1, bytes: {} },
            }),
        }),
      });
      const r = await run(["build", f, "-o", "out"], deps);
      expect(r.code, path).toBe(1);
      expect(r.stderr).toContain("cli/unsafe-output-path");
    }
    expect(await readdir(dir)).toEqual(["demo.cosmo.json"]);
  });

  test("--mp4 needs ffmpeg; --gif passes the built-in encoder; --json output", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const r = await run(["build", f, "--mp4"], makeDeps(dir));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("export/ffmpeg-missing");

    const calls: Calls = { render: [] };
    const gif = { encode: () => Promise.resolve(new Uint8Array()) };
    const deps = makeDeps(dir, { core: makeCore({ gifEncoder: gif }, calls) });
    const j = await run(["build", f, "--gif", "--fps", "12", "--duration", "3", "--json"], deps);
    expect(JSON.parse(j.stdout).ok).toBe(true);
    expect(calls.render[0]!.options!.video).toEqual({ fps: 12, durationSec: 3, encoder: gif });

    const mp4: Calls = { render: [] };
    const enc = { encode: () => Promise.resolve(new Uint8Array()) };
    await run(
      ["build", f, "--mp4"],
      makeDeps(dir, { core: makeCore({}, mp4), createMp4Encoder: () => Promise.resolve(enc) }),
    );
    expect(mp4.render[0]!.options!.video!.encoder).toBe(enc);
  });

  test("bundled and user packs are handed to the resolver, bundled first", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const user = join(dir, "packs");
    await mkdir(join(user, "mine", "svg"), { recursive: true });
    let seen: string[] = [];
    const deps = makeDeps(dir, {
      bundledPacks: [iconPack("cosmo")],
      core: makeCore({
        createIconResolver: (packs) => {
          seen = packs.map((p) => p.manifest.pack.id);
          return {
            resolve: () => undefined,
            defaultFor: () => undefined,
            search: () => [],
            packs: () => seen,
          };
        },
      }),
    });
    expect((await run(["build", f, "--packs-dir", user], deps)).code).toBe(0);
    expect(seen).toEqual(["cosmo"]);
  });
});

describe("watch", () => {
  test("builds, rebuilds on change of the spec only, stops on abort", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    const calls: Calls = { render: [] };
    const ac = new AbortController();
    let fire: (name: string | null) => void = () => undefined;
    let closed = false;
    const lines: string[] = [];
    const deps = makeDeps(dir, {
      core: makeCore({}, calls),
      signal: ac.signal,
      watch: (_d, cb) => {
        fire = cb;
        return { close: () => void (closed = true) };
      },
      io: { out: (t) => void lines.push(t), err: (t) => void lines.push(t) },
    });
    const p = run(["watch", f], deps);
    await until(() => calls.render.length === 1);
    fire("other.txt");
    fire("demo.cosmo.json");
    fire("demo.cosmo.json"); // debounced into one rebuild
    await until(() => calls.render.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.render).toHaveLength(2);
    ac.abort();
    const r = await p;
    expect(r.code).toBe(0);
    expect(closed).toBe(true);
    expect(lines.join("")).toContain("watching demo.cosmo.json");
  });

  test("keeps watching after a failed build", async () => {
    const dir = await tmp();
    const f = await specIn(dir);
    let n = 0;
    const ac = new AbortController();
    let fire: (name: string | null) => void = () => undefined;
    const errs: string[] = [];
    const deps = makeDeps(dir, {
      signal: ac.signal,
      core: makeCore({
        render: () =>
          ++n === 1
            ? Promise.reject(new Error("boom"))
            : Promise.resolve({ outputs: [], diagnostics: [], stats: { elements: 0, bytes: {} } }),
      }),
      watch: (_d, cb) => {
        fire = cb;
        return { close: () => undefined };
      },
      io: { out: () => undefined, err: (t) => void errs.push(t) },
    });
    const p = run(["watch", f], deps);
    await until(() => n === 1);
    fire(null);
    await until(() => n === 2);
    ac.abort();
    expect((await p).code).toBe(0);
    expect(errs.join("")).toContain("boom");
  });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}
