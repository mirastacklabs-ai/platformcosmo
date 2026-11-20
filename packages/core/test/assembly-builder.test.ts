import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  AssemblyBuilder,
  PartsBuilder,
  PlatformCosmoSpec,
  SpecAssembly,
  SpecPart,
  SpecProgram,
} from "../src/index.js";
import {
  assembly,
  build,
  canonicalJson as jcs,
  explode,
  figure,
  spec,
  validate,
  validateSpec,
} from "../src/index.js";

// A2-4: TypeScript builder (docs/design/assemblies.md §16). Equality is on RFC 8785 canonical
// JSON (the engine's own `canonicalJson`), so key order never matters and arrays keep call order.

type Example = { name: string; title: string; e: PlatformCosmoSpec };
const FENCE = "```";
const designExamples = (file: string): PlatformCosmoSpec[] => {
  const md = readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8");
  return [...md.matchAll(new RegExp(`${FENCE}json\\n([\\s\\S]*?)${FENCE}`, "g"))]
    .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
    .filter((s) => typeof s.meta === "object") as unknown as PlatformCosmoSpec[];
};
const EXAMPLES: Example[] = [
  ...designExamples("assemblies.md").map((e) => ({ file: "assemblies", e })),
  ...designExamples("document-ingestion.md").map((e) => ({ file: "document-ingestion", e })),
].map(({ file, e }) => ({
  name: `${file}: ${e.meta.title ?? "(untitled)"}`,
  title: e.meta.title ?? "",
  e,
}));
const byTitle = (title: string): PlatformCosmoSpec => {
  const hit = EXAMPLES.find((x) => x.title === title);
  if (!hit) throw new Error(`design example not found: ${title}`);
  return hit.e;
};
const ENGINE_TITLE = "Inline-4 engine teardown";

/** `$schema` is an editor hint; the builder never emits it. */
const plain = (e: PlatformCosmoSpec): PlatformCosmoSpec => {
  const { $schema: _ignored, ...rest } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest as PlatformCosmoSpec;
};

/**
 * Rebuild a plain spec by driving the typed builders from its parsed JSON. Everything is
 * destructured against the generated types, so this compiles only if the typed API can express
 * every example (no casts to `never`).
 */
const rebuildProgram = (p: SpecProgram) => {
  if (p.kind === "build") {
    const { id, kind: _kind, steps, ...fields } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
    const b = build(id, fields);
    for (const s of steps) b.step(s);
    return b;
  }
  const { id, stages, ...fields } = p;
  const x = explode(id, fields);
  for (const s of stages) x.stage(s);
  return x;
};
const fillParts = (
  b: PartsBuilder,
  parts: readonly SpecPart[] | undefined,
  programs?: readonly SpecProgram[],
): void => {
  for (const p of parts ?? []) {
    const { id, parts: kids, programs: progs, ...fields } = p;
    if (kids) b.sub(id, fields, (c) => fillParts(c, kids, progs));
    else b.part(id, { ...fields, ...(progs ? { programs: progs } : {}) });
  }
  for (const pr of programs ?? []) b.program(rebuildProgram(pr));
};
const rebuild = (e: PlatformCosmoSpec): PlatformCosmoSpec => {
  const {
    $schema: _s, // eslint-disable-line @typescript-eslint/no-unused-vars
    meta,
    images,
    figures,
    storyboards,
    assemblies,
    racks,
    steps,
    ...rest
  } = e;
  const s = spec(meta, rest);
  for (const i of images ?? []) s.image(i);
  for (const f of figures ?? []) {
    const { id, parts, stages, ...fields } = f;
    const fb = figure(id, fields);
    for (const p of parts) fb.part(p);
    for (const st of stages ?? []) fb.stage(st);
    s.figure(fb);
  }
  for (const sb of storyboards ?? []) s.storyboard(sb);
  for (const a of assemblies ?? []) {
    const { id, parts, programs, ...fields } = a;
    const ab = assembly(id, fields);
    fillParts(ab, parts, programs);
    s.assembly(ab);
  }
  for (const r of racks ?? []) s.rack(r);
  for (const st of steps ?? []) s.step(st);
  return s.toJSON();
};

describe("design examples", () => {
  test("every design example is built (none excluded)", () => {
    const total =
      designExamples("assemblies.md").length + designExamples("document-ingestion.md").length;
    expect(EXAMPLES.length).toBe(total);
    expect(total).toBeGreaterThanOrEqual(6);
    // the hall example (aisles, rows) goes through the `rest` argument of spec()
    expect(EXAMPLES.some((x) => "rows" in x.e && "aisles" in x.e)).toBe(true);
  });

  test.each(EXAMPLES)("$name: builder output equals the example (JCS)", ({ e }) => {
    expect(jcs(rebuild(e))).toBe(jcs(plain(e)));
  });

  test.each(EXAMPLES)("$name: builder output validates (only the guard objects)", ({ e }) => {
    const out = rebuild(e);
    expect(validateSpec(out).valid).toBe(true);
    const errors = validate(out).diagnostics.filter((d) => d.severity === "error");
    for (const d of errors) expect(d.code).toBe("assembly/unsupported");
    // identical to what the plain example gets
    expect(validate(out).diagnostics).toEqual(validate(plain(e)).diagnostics);
  });

  test("the comparison detects differences", () => {
    const e = byTitle(ENGINE_TITLE);
    const out = rebuild(e) as unknown as { assemblies: { parts: { size?: unknown }[] }[] };
    out.assemblies[0]!.parts[0]!.size = [1, 2, 3];
    expect(jcs(out)).not.toBe(jcs(plain(e)));
    const out2 = rebuild(e) as unknown as { assemblies: { parts: unknown[] }[] };
    out2.assemblies[0]!.parts.reverse();
    expect(jcs(out2)).not.toBe(jcs(plain(e)));
  });
});

describe("builder forms", () => {
  test("19.3 written as builder calls equals the example", () => {
    const engine = assembly("engine", { label: "Inline-4 engine", units: "mm" })
      .part("oil-pan", {
        type: "oil-pan",
        at: [20, 20, 0],
        size: [440, 180, 80],
        role: "cover",
        mates: "block",
        label: "Oil pan",
      })
      .part("block", {
        type: "block",
        at: [0, 0, 80],
        size: [480, 220, 260],
        role: "body",
        tone: "metal",
        label: "Cylinder block",
      })
      .part("crankshaft", {
        type: "crankshaft",
        shape: "shaft",
        axis: "x",
        at: [10, 85, 100],
        size: [460, 50, 50],
        role: "internal",
        label: "Crankshaft",
      })
      .sub("pr", { count: 4, pitch: [110, 0, 0], label: "Piston and rod" }, (b) =>
        b
          .part("piston", {
            type: "piston",
            shape: "cylinder",
            at: [45, 70, 250],
            size: [80, 80, 70],
            tone: "metal",
            label: "Piston",
          })
          .part("rod", {
            type: "rod",
            shape: "shaft",
            at: [75, 100, 140],
            size: [20, 20, 110],
            label: "Connecting rod",
          }),
      )
      .sub("head", { type: "head", at: [0, 0, 340], label: "Cylinder head" }, (b) =>
        b.part("casting", { size: [480, 220, 90], tone: "metal" }).part("valve", {
          type: "valve",
          shape: "shaft",
          count: 8,
          at: [50, 95, 40],
          pitch: [55, 0, 0],
          size: [12, 12, 70],
          inserts: "casting",
          label: "Valve",
        }),
      )
      .part("cam-intake", {
        type: "camshaft",
        shape: "shaft",
        axis: "x",
        at: [10, 60, 450],
        size: [460, 30, 30],
        label: "Intake camshaft",
      })
      .part("cam-exhaust", {
        type: "camshaft",
        shape: "shaft",
        axis: "x",
        at: [10, 130, 450],
        size: [460, 30, 30],
        label: "Exhaust camshaft",
      })
      .part("valve-cover", {
        type: "valve-cover",
        at: [10, 10, 430],
        size: [460, 200, 90],
        role: "cover",
        tone: "accent",
        label: "Valve cover",
      })
      .part("intake", {
        type: "intake",
        at: [40, 220, 300],
        size: [400, 80, 100],
        label: "Intake manifold",
      })
      .part("exhaust", {
        type: "exhaust",
        at: [40, -70, 300],
        size: [400, 70, 80],
        tone: "muted",
        label: "Exhaust manifold",
      })
      .part("timing-belt", {
        type: "timing-belt",
        shape: "plate",
        at: [-20, 30, 120],
        size: [20, 160, 330],
        role: "cover",
        label: "Timing belt",
      })
      .program(
        explode("teardown")
          .stage({
            label: "Covers and belt",
            parts: ["role:cover"],
            direction: "away",
            order: "top-down",
          })
          .stage({
            label: "Top end",
            parts: ["type:camshaft", "head"],
            direction: "lift",
            details: true,
          })
          .stage({
            label: "Bottom end",
            parts: ["pr-*", "crankshaft", "intake", "exhaust"],
            direction: "lift",
            stagger: 0.1,
            overrides: {
              crankshaft: { direction: "down" },
              intake: { direction: "+y", order: 0 },
              exhaust: { direction: "-y", order: 0 },
            },
          }),
      );
    const doc = spec({ title: "Inline-4 engine teardown" })
      .assembly(engine)
      .step({ caption: "Assembled inline-4", duration: 2 })
      .step({
        caption: "Valve cover, timing belt and oil pan off",
        assembly: [{ explode: "engine", to: 1 }],
        focus: "engine",
      })
      .step({
        caption: "Camshafts and cylinder head lift",
        assembly: [{ explode: "engine", to: 2 }],
        focus: "engine",
        duration: 4,
      })
      .step({
        caption: "Pistons up, crankshaft down, manifolds out",
        assembly: [{ explode: "engine" }],
        set: { "engine/pr-3/piston": "highlighted" },
        focus: "engine",
        duration: 4,
      })
      .step({ caption: "Back together", assembly: [{ implode: "engine" }], duration: 5 })
      .toJSON();
    expect(jcs(doc)).toBe(jcs(plain(byTitle(ENGINE_TITLE))));
  });

  test("§16 example: nested sub, program, spec and validate", () => {
    const engine = assembly("engine", { label: "Inline-4", units: "mm" })
      .part("block", { size: [480, 220, 260], at: [0, 0, 80], role: "body" })
      .sub("pr", { count: 4, pitch: [110, 0, 0] }, (b) =>
        b.part("piston", { shape: "cylinder", at: [45, 70, 170], size: [80, 80, 70] }),
      )
      .part("valve-cover", { at: [10, 10, 430], size: [460, 200, 90], role: "cover" })
      .program(
        explode("service")
          .stage({ label: "Covers", parts: ["role:cover"] })
          .stage({ label: "Pistons", parts: ["pr-*"], direction: "lift" }),
      );
    const doc = spec({ title: "Engine" })
      .assembly(engine)
      .step({ caption: "Assembled", duration: 2 })
      .step({ caption: "Exploded", assembly: [{ explode: "engine" }], focus: "engine" })
      .toJSON();
    expect(jcs(doc)).toBe(
      jcs({
        meta: { version: "1", title: "Engine" },
        assemblies: [
          {
            id: "engine",
            label: "Inline-4",
            units: "mm",
            parts: [
              { id: "block", size: [480, 220, 260], at: [0, 0, 80], role: "body" },
              {
                id: "pr",
                count: 4,
                pitch: [110, 0, 0],
                parts: [{ id: "piston", shape: "cylinder", at: [45, 70, 170], size: [80, 80, 70] }],
              },
              { id: "valve-cover", at: [10, 10, 430], size: [460, 200, 90], role: "cover" },
            ],
            programs: [
              {
                id: "service",
                stages: [
                  { label: "Covers", parts: ["role:cover"] },
                  { label: "Pistons", parts: ["pr-*"], direction: "lift" },
                ],
              },
            ],
          },
        ],
        steps: [
          { caption: "Assembled", duration: 2 },
          { caption: "Exploded", assembly: [{ explode: "engine" }], focus: "engine" },
        ],
      }),
    );
    expect(validateSpec(doc).valid).toBe(true);
    for (const d of validate(doc).diagnostics.filter((x) => x.severity === "error"))
      expect(d.code).toBe("assembly/unsupported");
  });

  test("no defaults: empty builders emit only what was given", () => {
    expect(spec({}).toJSON()).toEqual({ meta: { version: "1" } });
    expect(assembly("a").toJSON()).toEqual({ id: "a", parts: [] });
    expect(explode("e").toJSON()).toEqual({ id: "e", stages: [] });
    expect(build("b").toJSON()).toEqual({ id: "b", kind: "build", steps: [] });
    expect(figure("f", { base: "i" }).toJSON()).toEqual({ id: "f", base: "i", parts: [] });
  });

  test("build program and figure builders", () => {
    const b = build("assemble", { label: "Assemble" })
      .step({ add: ["x"] })
      .step({ add: ["y"] });
    expect(b.toJSON()).toEqual({
      id: "assemble",
      kind: "build",
      label: "Assemble",
      steps: [{ add: ["x"] }, { add: ["y"] }],
    });
    const a = assembly("a")
      .part("x", { size: [1, 1, 1] })
      .program(b);
    expect((a.toJSON().programs?.[0] as { kind?: string }).kind).toBe("build");
    const fig = figure("hs", { base: "hs-base" })
      .part({ id: "p", image: "i", seat: [0, 0] })
      .stage({ parts: ["p"] })
      .toJSON();
    expect(fig.stages).toEqual([{ parts: ["p"] }]);
  });

  test("sub-assembly can carry programs relative to it", () => {
    const a = assembly("a").sub("s", { at: [0, 0, 0] }, (c) =>
      c.part("p", { size: [1, 1, 1] }).program(explode("x").stage({ parts: ["p"] })),
    );
    const json = a.toJSON() as SpecAssembly;
    const s = json.parts[0] as SpecPart;
    expect(s.programs?.[0]).toEqual({ id: "x", stages: [{ parts: ["p"] }] });
  });

  test("never throws on bad input; validate reports the specific diagnostic", () => {
    const codes = (doc: unknown) =>
      validate(doc)
        .diagnostics.filter((d) => d.code !== "assembly/unsupported")
        .map((d) => [d.code, d.path]);
    const one: Omit<SpecPart, "id"> = { size: [1, 1, 1] };
    expect(() => assembly("a").part("x").part("x").toJSON()).not.toThrow();
    // empty parts / stages / steps are emitted as [] and reported by the schema
    expect(codes(spec({}).assembly(assembly("a")).toJSON())).toEqual([
      ["schema/min-items", "/assemblies/0/parts"],
    ]);
    const sub = assembly("a").sub("s", {}, () => undefined);
    expect(codes(spec({}).assembly(sub).toJSON())).toEqual([
      ["schema/min-items", "/assemblies/0/parts/0/parts"],
    ]);
    const noStages = assembly("a").part("x", one).program(explode("e"));
    expect(codes(spec({}).assembly(noStages).toJSON())).toEqual([
      ["schema/min-items", "/assemblies/0/programs/0/stages"],
    ]);
    const noSteps = assembly("a").part("x", one).program(build("b"));
    expect(codes(spec({}).assembly(noSteps).toJSON())).toEqual([
      ["schema/min-items", "/assemblies/0/programs/0/steps"],
    ]);
    expect(
      codes(
        spec({})
          .figure(figure("f", { base: "i" }))
          .toJSON(),
      ),
    ).toEqual([["schema/min-items", "/figures/0/parts"]]);
    const dup = assembly("a").part("x", one).part("x", one);
    expect(codes(spec({}).assembly(dup).toJSON())).toEqual([
      ["assembly/duplicate-part", "/assemblies/0/parts/1/id"],
    ]);
  });

  test("sub() always emits parts, even when the callback adds none", () => {
    const json = assembly("a")
      .sub("s", { label: "S" }, () => undefined)
      .toJSON();
    expect(json.parts[0]).toEqual({ id: "s", label: "S", parts: [] });
  });

  test("a proto key is kept as data, not a prototype", () => {
    const key = "__proto__";
    const fields = JSON.parse(`{"label":"L","${key}":{"polluted":true}}`);
    const part = assembly("a").part("x", fields).toJSON().parts[0] as object;
    expect(Object.keys(part)).toContain(key);
    expect(Object.getPrototypeOf(part)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(jcs(part)).toContain(`"${key}":{"polluted":true}`);
  });

  test("undefined-valued keys are skipped", () => {
    const out = assembly("a", { label: undefined })
      .part("x", { label: undefined, size: [1, 1, 1] })
      .toJSON();
    expect("label" in out).toBe(false);
    expect("label" in (out.parts[0] as object)).toBe(false);
  });

  test("spec(meta, rest) passes other top-level fields", () => {
    const out = spec({ title: "t" }, { canvas: { theme: "dark" }, rows: [] }).toJSON();
    expect(out).toEqual({
      meta: { version: "1", title: "t" },
      canvas: { theme: "dark" },
      rows: [],
    });
  });

  test("program() snapshots a builder when called", () => {
    const e = explode("e").stage({ parts: ["x"] });
    const a = assembly("a")
      .part("x", { size: [1, 1, 1] })
      .program(e);
    e.stage({ parts: ["late"] });
    expect((a.toJSON().programs?.[0] as { stages: unknown[] }).stages).toHaveLength(1);
  });
});

describe("determinism and isolation", () => {
  const make = (): AssemblyBuilder =>
    assembly("a", { units: "mm" })
      .part("x", { size: [1, 2, 3], at: [0, 0, 0] })
      .program(explode("e").stage({ parts: ["x"] }));

  test("same calls give identical JSON, repeated toJSON is stable", () => {
    expect(JSON.stringify(make().toJSON())).toBe(JSON.stringify(make().toJSON()));
    const b = make();
    expect(JSON.stringify(b.toJSON())).toBe(JSON.stringify(b.toJSON()));
  });

  test("inputs are copied; outputs are detached from the builder", () => {
    const fields = { size: [1, 2, 3] as [number, number, number] };
    const stage = { parts: ["x"] as [string, ...string[]] };
    const b = assembly("a").part("x", fields).program(explode("e").stage(stage));
    fields.size[0] = 99;
    stage.parts.push("y");
    const out = b.toJSON() as SpecAssembly;
    expect((out.parts[0] as SpecPart).size).toEqual([1, 2, 3]);
    (out.parts[0] as SpecPart).size = [9, 9, 9];
    expect(((b.toJSON() as SpecAssembly).parts[0] as SpecPart).size).toEqual([1, 2, 3]);
    expect((b.toJSON().programs?.[0] as { stages: unknown[] }).stages).toEqual([{ parts: ["x"] }]);
  });

  test("passing a builder to spec() snapshots it at that moment", () => {
    const b = make();
    const s = spec({}).assembly(b);
    b.part("late", { size: [1, 1, 1] });
    expect((s.toJSON().assemblies?.[0]?.parts ?? []).length).toBe(1);
  });
});

describe("type-level misuse", () => {
  test("misuse fails to compile (checked by `typecheck`)", () => {
    // Never called: these lines are for the compiler, not for runtime.
    const misuse = () => {
      const noop = (...args: unknown[]) => args.length;
      // @ts-expect-error size must be a Vec3
      noop(assembly("a").part("x", { size: "big" }));
      // @ts-expect-error unknown field
      noop(assembly("a").part("x", { colour: "red" }));
      // @ts-expect-error units is a closed union
      noop(assembly("a", { units: "parsecs" }));
      // @ts-expect-error id is the first argument
      noop(assembly("a", { id: "b" }));
      // @ts-expect-error parts come from .part()
      noop(assembly("a", { parts: [] }));
      // @ts-expect-error a part's id is the first argument
      noop(assembly("a").part("x", { id: "y" }));
      // @ts-expect-error a sub-assembly takes children through the callback
      noop(assembly("a").sub("s", { parts: [] }, () => undefined));
      // @ts-expect-error a sub-assembly takes programs through the callback
      noop(assembly("a").sub("s", { programs: [] }, () => undefined));
      // @ts-expect-error sub needs its build callback
      noop(assembly("a").sub("s", {}));
      // @ts-expect-error build steps are not explode stages
      noop(explode("e").step({ add: ["x"] }));
      // @ts-expect-error explode stages are not build steps
      noop(build("b").stage({ parts: ["x"] }));
      // @ts-expect-error kind is chosen by explode()/build()
      noop(explode("e", { kind: "build" }));
      // @ts-expect-error a stage needs parts
      noop(explode("e").stage({ label: "x" }));
      // @ts-expect-error direction is a closed set of strings or vectors, not a number
      noop(explode("e").stage({ parts: ["x"], direction: 3 }));
      // @ts-expect-error not a program
      noop(assembly("a").program({ id: "x" }));
      // @ts-expect-error not a program (an assembly builder)
      noop(assembly("a").program(assembly("b")));
      // @ts-expect-error figure fields are required
      noop(figure("f"));
      // @ts-expect-error a figure part is an object with id, image and seat
      noop(figure("f", { base: "i" }).part("p"));
      // @ts-expect-error version is set by spec()
      noop(spec({ version: "1" }));
      // @ts-expect-error spec needs the meta argument
      noop(spec());
      // @ts-expect-error a step is an object
      noop(spec({}).step("caption"));
      // @ts-expect-error assembly() takes a builder or a spec assembly, not a string
      noop(spec({}).assembly("a"));
      // @ts-expect-error a rack is a plain spec object
      noop(spec({}).rack(explode("e")));
    };
    expect(typeof misuse).toBe("function");
  });

  test("valid forms compile", () => {
    const doc: PlatformCosmoSpec = spec({ title: "t" })
      .assembly({ id: "a", parts: [{ id: "p", size: [1, 1, 1] }] })
      .toJSON();
    expect(doc.meta.version).toBe("1");
  });
});
