// D-1b: close-up size and depth checks in `pcosmo validate` and `build` (assemblies 8.5, 18).
// Phase 2 is still gated: the real wiring is checked for `assembly/unsupported`, and the checks
// themselves run with the guard lifted by dropping that error from the core's validate (the CLI
// and the scene are the real ones; `render` is rebuilt around the lifted validate).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@platformcosmo/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcosmo-closeup-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;
const box = (id: string, size: number[], extra: Obj = {}): Obj => ({
  id,
  at: [0, 0, 0],
  size,
  ...extra,
});
const spec = (o: Obj): Obj => ({ meta: { version: "1" }, ...o });

/** A host part of 100 x 100 x 50 mm with a close-up of a template of the given size. */
const mk = (tpl: number[], host = [100, 100, 50]): Obj =>
  spec({
    assemblies: [
      { id: "tpl", template: true, units: "mm", parts: [box("b", tpl)] },
      { id: "host", units: "mm", parts: [box("p", host, { closeup: "tpl" })] },
    ],
  });

/** a0 -> t1 -> ... through parts: the 8-segment limit stops it (validation passes each edge). */
const deep = (): Obj => {
  const n = 6;
  const host = (next?: string): Obj => ({
    parts: [box("p", [10, 10, 10], next === undefined ? {} : { closeup: next })],
  });
  return spec({
    assemblies: [
      { id: "a0", units: "mm", ...host("t1") },
      ...Array.from({ length: n }, (_, i) => ({
        id: `t${i + 1}`,
        template: true,
        units: "mm",
        ...host(i + 1 < n ? `t${i + 2}` : undefined),
      })),
    ],
  });
};

/** More levels than the depth cap: a0 closes up on t1 .. t6 through the roots. */
const levelsOver = (): Obj => {
  const n = 6;
  return spec({
    assemblies: [
      { id: "a0", units: "mm", closeup: "t1", parts: [box("p", [10, 10, 10])] },
      ...Array.from({ length: n }, (_, i) => ({
        id: `t${i + 1}`,
        template: true,
        units: "mm",
        ...(i + 1 < n ? { closeup: `t${i + 2}` } : {}),
        parts: [box("p", [10, 10, 10])],
      })),
    ],
  });
};

const lifted = (): ReturnType<typeof defaultDeps> => {
  const base = defaultDeps();
  const validate: typeof core.validate = (s, c) => {
    const r = core.validate(s, c);
    // the guard, and the rack targets only phase 2 resolves (a rack is "not a figure" until then)
    const diagnostics = r.diagnostics.filter(
      (d) =>
        d.code !== "assembly/unsupported" &&
        !(d.code === "assembly/unknown-target" && d.message.includes("it is a rack")),
    );
    const valid = !diagnostics.some((d) => d.severity === "error");
    return valid && r.valid === false
      ? { valid, spec: s as never, diagnostics }
      : { ...r, valid, diagnostics };
  };
  return {
    ...base,
    env: {},
    cwd: dir,
    core: {
      ...base.core,
      validate,
      render: core.createRender({
        validate,
        buildScene: core.buildScene,
        createAnimator: core.createAnimator,
        exportOutputs: core.exportOutputs,
        rasterize: core.rasterize,
        emit: core.emit,
        optimize: core.optimize,
      }),
    },
  };
};

let n = 0;
async function file(body: Obj): Promise<string> {
  const p = join(dir, `s${n++}.cosmo.json`);
  await writeFile(p, JSON.stringify(body));
  return p;
}
interface Diag {
  severity: string;
  code: string;
  path: string;
  params?: Obj;
}
async function validateJson(body: Obj, d = lifted()): Promise<{ code: number; diags: Diag[] }> {
  const r = await run(["validate", await file(body), "--json"], d);
  return { code: r.code, diags: (JSON.parse(r.stdout) as { diagnostics: Diag[] }).diagnostics };
}
const only = (ds: Diag[], code: string): Diag[] => ds.filter((d) => d.code === code);

describe("gated by default", () => {
  test("the real wiring still rejects close-ups with assembly/unsupported and nothing else new", async () => {
    const r = await run(["validate", await file(mk([111, 100, 50])), "--json"], {
      ...defaultDeps(),
      env: {},
      cwd: dir,
    });
    const diags = (JSON.parse(r.stdout) as { diagnostics: Diag[] }).diagnostics;
    expect(r.code).toBe(1);
    expect(only(diags, "assembly/unsupported").length).toBeGreaterThan(0);
    expect(only(diags, "assembly/size-mismatch")).toEqual([]);
  });
});

describe("validate", () => {
  test("a fitting template reports nothing", async () => {
    const { code, diags } = await validateJson(mk([100, 100, 50]));
    expect(code).toBe(0);
    expect(diags).toEqual([]);
  });

  test("more than 10% oversize: one warning with its pointer, exit 0, exit 1 with --strict", async () => {
    const f = await file(mk([111, 100, 50]));
    const j = JSON.parse((await run(["validate", f, "--json"], lifted())).stdout) as {
      valid: boolean;
      diagnostics: Diag[];
    };
    const w = only(j.diagnostics, "assembly/size-mismatch");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      severity: "warning",
      path: "/assemblies/1",
      params: { host: "host/p", closeup: "tpl", axis: "x" },
    });
    expect(j.valid).toBe(true);
    const human = await run(["validate", f], lifted());
    expect(human.code).toBe(0);
    expect(human.stderr.match(/assembly\/size-mismatch/g)).toHaveLength(1);
    expect(human.stdout).toContain("valid (1 warning)");
    expect((await run(["validate", f, "--strict"], lifted())).code).toBe(1);
  });

  test("under 50% in x: an info", async () => {
    const { code, diags } = await validateJson(mk([40, 100, 50]));
    const d = only(diags, "assembly/size-mismatch");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("info");
    expect(code).toBe(0);
  });

  test("a footprint that fits better turned: closeup-turned info, plus the mismatch warning", async () => {
    const { diags } = await validateJson(mk([120, 100, 50], [100, 120, 50]));
    const t = only(diags, "assembly/closeup-turned");
    expect(t).toHaveLength(1);
    expect(t[0]!.severity).toBe("info");
    expect(only(diags, "assembly/size-mismatch")).toHaveLength(1);
  });

  test("too deep through parts: error at the host pointer, exit 1", async () => {
    const { code, diags } = await validateJson(deep());
    const d = only(diags, "assembly/too-deep");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", path: "/assemblies/3" });
    expect(code).toBe(1);
  });

  test("past the level depth cap: budget/levels, once", async () => {
    const { diags } = await validateJson(levelsOver());
    expect(only(diags, "budget/levels")).toHaveLength(1);
  });

  test("a spec without close-ups or slot internals is untouched", async () => {
    const plain = spec({ assemblies: [{ id: "a", units: "mm", parts: [box("p", [10, 10, 10])] }] });
    const { diags } = await validateJson(plain);
    expect(diags.filter((d) => d.code.startsWith("assembly/size"))).toEqual([]);
  });
});

describe("build", () => {
  test("reports the size warning exactly once and still builds", async () => {
    const f = await file(mk([111, 100, 50]));
    const r = await run(["build", f, "--out", dir, "--no-optimize", "--json"], lifted());
    const j = JSON.parse(r.stdout) as { ok: boolean; diagnostics: Diag[] };
    expect(r.code).toBe(0);
    expect(j.ok).toBe(true);
    expect(only(j.diagnostics, "assembly/size-mismatch")).toHaveLength(1);
  });

  test("too-deep stops no build on its own once; levels over the cap report once", async () => {
    const f = await file(levelsOver());
    const r = await run(["build", f, "--out", dir, "--no-optimize", "--json"], lifted());
    const j = JSON.parse(r.stdout) as { diagnostics: Diag[] };
    expect(only(j.diagnostics, "budget/levels")).toHaveLength(1);
  });
});

describe("slots[].assembly through the CLI (DC pack wired)", () => {
  const rack = (tplSize: number[]): Obj =>
    spec({
      assemblies: [{ id: "board", template: true, units: "mm", parts: [box("b", tplSize)] }],
      racks: [
        {
          id: "r1",
          slots: [{ id: "srv", type: "server-2u", at: 1, assembly: "board" }],
        },
      ],
      steps: [{ assembly: [{ explode: "r1" }] }],
    });

  test("an oversize template warns once in validate and once in build", async () => {
    const f = await file(rack([700, 700, 40]));
    const v = JSON.parse((await run(["validate", f, "--json"], lifted())).stdout) as {
      diagnostics: Diag[];
    };
    const w = only(v.diagnostics, "assembly/size-mismatch");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", path: "/racks/0/slots/0/assembly" });
    const b = JSON.parse(
      (await run(["build", f, "--out", dir, "--no-optimize", "--json"], lifted())).stdout,
    ) as { diagnostics: Diag[] };
    expect(only(b.diagnostics, "assembly/size-mismatch")).toHaveLength(1);
  });

  test("a fitting template reports nothing; the gate rejects it by default", async () => {
    const ok = await validateJson(rack([300, 300, 20]));
    expect(only(ok.diags, "assembly/size-mismatch")).toEqual([]);
    const f = await file(rack([300, 300, 20]));
    const gated = await run(["validate", f, "--json"], { ...defaultDeps(), env: {}, cwd: dir });
    expect(gated.code).toBe(1);
    expect(gated.stdout).toContain("assembly/unsupported");
  });
});
