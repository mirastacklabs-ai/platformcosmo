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
import { assembly, build, explode, figure, spec, validate, validateSpec } from "../src/index.js";

// A2-4: TypeScript builder (docs/design/assemblies.md §16). Equality is on RFC 8785 canonical
// JSON, so key order never matters and arrays keep call order.

/** RFC 8785 (JCS): sorted keys (UTF-16 code units), ES number and string serialization. */
const jcs = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
    .join(",")}}`;
};

const FENCE = "```";
const designExamples = (file: string): Record<string, unknown>[] => {
  const md = readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8");
  return [...md.matchAll(new RegExp(`${FENCE}json\\n([\\s\\S]*?)${FENCE}`, "g"))]
    .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
    .filter((s) => typeof s.meta === "object");
};
// Top-level keys the builder has a method for (`SpecBuilder`). An example that also uses other
// keys (the hall's `aisles`/`rows`) has no builder form and is excluded from the comparison.
const BUILDABLE = new Set([
  "$schema",
  "meta",
  "images",
  "figures",
  "storyboards",
  "assemblies",
  "racks",
  "steps",
]);
const ALL = [
  ...designExamples("assemblies.md").map((e, i) => ({ name: `assemblies #${i + 1}`, e })),
  ...designExamples("document-ingestion.md").map((e, i) => ({
    name: `document-ingestion #${i + 1}`,
    e,
  })),
];
const EXAMPLES = ALL.filter((x) => Object.keys(x.e).every((k) => BUILDABLE.has(k)));

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const without = (o: Obj, ...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Rebuild a plain spec by driving the builders from its parsed JSON (the call-for-call form). */
const rebuildProgram = (
  p: Obj,
): SpecProgram | ReturnType<typeof build> | ReturnType<typeof explode> => {
  if (p.kind === "build") {
    const b = build(p.id, without(p, "id", "kind", "steps") as never);
    for (const s of p.steps) b.step(s);
    return b;
  }
  if (p.kind !== undefined) return p as SpecProgram; // explicit kind: pass the plain object
  const x = explode(p.id, without(p, "id", "stages") as never);
  for (const s of p.stages) x.stage(s);
  return x;
};
const fillParts = (b: PartsBuilder, parts: Obj[] | undefined, programs?: Obj[]): void => {
  for (const p of parts ?? []) {
    if (p.parts) {
      b.sub(p.id, without(p, "id", "parts", "programs") as never, (c) =>
        fillParts(c, p.parts, p.programs),
      );
    } else b.part(p.id, without(p, "id") as never);
  }
  for (const pr of programs ?? []) b.program(rebuildProgram(pr));
};
const rebuild = (e: Obj): PlatformCosmoSpec => {
  const s = spec(without(e.meta, "version") as never);
  for (const i of e.images ?? []) s.image(i);
  for (const f of e.figures ?? []) {
    const fb = figure(f.id, without(f, "id", "parts", "stages") as never);
    for (const p of f.parts) fb.part(p);
    for (const st of f.stages ?? []) fb.stage(st);
    s.figure(fb);
  }
  for (const sb of e.storyboards ?? []) s.storyboard(sb);
  for (const a of e.assemblies ?? []) {
    const ab = assembly(a.id, without(a, "id", "parts", "programs") as never);
    fillParts(ab, a.parts, a.programs);
    s.assembly(ab);
  }
  for (const r of e.racks ?? []) s.rack(r);
  for (const st of e.steps ?? []) s.step(st);
  return s.toJSON();
};

describe("design examples", () => {
  test("the doc yields the expected examples", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(6);
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(ALL.length - 1);
  });

  test.each(EXAMPLES)("$name: builder output equals the example (JCS)", ({ e }) => {
    // `$schema` is an editor hint; the builder never emits it.
    expect(jcs(rebuild(e))).toBe(jcs(without(e, "$schema")));
  });

  test.each(EXAMPLES)("$name: builder output validates (only the guard objects)", ({ e }) => {
    const out = rebuild(e);
    expect(validateSpec(out).valid).toBe(true);
    const errors = validate(out).diagnostics.filter((d) => d.severity === "error");
    for (const d of errors) expect(d.code).toBe("assembly/unsupported");
    // identical to what the plain example gets
    expect(validate(out).diagnostics).toEqual(validate(without(e, "$schema")).diagnostics);
  });

  test("the comparison detects differences", () => {
    const e = EXAMPLES.find((x) => x.name === "assemblies #3")?.e as Obj; // 19.3 engine
    const out = rebuild(e) as unknown as Obj;
    out.assemblies[0].parts[0].size = [1, 2, 3];
    expect(jcs(out)).not.toBe(jcs(without(e, "$schema")));
    const out2 = rebuild(e) as unknown as Obj;
    out2.assemblies[0].parts.reverse();
    expect(jcs(out2)).not.toBe(jcs(without(e, "$schema")));
  });
});

describe("builder forms", () => {
  const engineExample = () =>
    EXAMPLES.map((x) => x.e).find(
      (x) => (x.assemblies as Obj[] | undefined)?.[0]?.id === "engine" && x.steps,
    ) as Obj;

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
    expect(jcs(doc)).toBe(jcs(without(engineExample(), "$schema")));
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

  test("never throws on bad input; validate reports it", () => {
    expect(() => assembly("a").part("x").part("x").toJSON()).not.toThrow();
    const doc = spec({}).assembly(assembly("a")).toJSON();
    expect(validate(doc).diagnostics.length).toBeGreaterThan(0);
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
