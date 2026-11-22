/**
 * D-1: shape packs, --png-step and validate --suggest through the real wiring and the built
 * bin (assemblies.md sections 5, 12, 17, 18).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { encodePng } from "@platformcosmo/assets";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";
import { combineRegistries } from "../src/parts.js";
import { fitStep, formatSuggestions, suggest, type SuggestReport } from "../src/suggest.js";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcosmo-parts-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

type Spec = { assemblies: Record<string, unknown>[] } & Record<string, unknown>;
const spec = (over: Record<string, unknown>): Spec =>
  ({
    $schema: "https://platformcosmo.io/schema/v1.json",
    meta: { version: "1", title: "t" },
    ...over,
  }) as unknown as Spec;

const engine = spec({
  assemblies: [
    {
      id: "engine",
      units: "mm",
      parts: [
        { id: "block", shape: "box", at: [0, 0, 0], size: [200, 100, 100], role: "body" },
        {
          id: "piston",
          shape: "auto:piston",
          count: 2,
          at: [20, 30, 100],
          pitch: [80, 0, 0],
        },
        { id: "spark", shape: "auto:valve", at: [10, 10, 100] },
      ],
    },
  ],
});

const gpu = spec({
  assemblies: [
    {
      id: "srv",
      units: "mm",
      parts: [
        { id: "tray", shape: "box", at: [0, 0, 0], size: [400, 300, 40], role: "body" },
        { id: "dimm", shape: "hw:dimm", count: 2, at: [20, 20, 40], pitch: [20, 0, 0] },
        { id: "sink", shape: "hw:heatsink", at: [200, 100, 40] },
      ],
    },
  ],
});

async function file(name: string, body: unknown): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(body));
  return p;
}
const deps = () => ({ ...defaultDeps(), env: {}, cwd: dir });

describe("registry", () => {
  test("combines packs: first wins, list is sorted and deduplicated", () => {
    const d = defaultDeps();
    const refs = d.parts!.list();
    expect(refs).toEqual([...refs].sort());
    expect(new Set(refs).size).toBe(refs.length);
    for (const pack of ["hw:", "brick:", "auto:"]) {
      expect(refs.some((r) => r.startsWith(pack))).toBe(true);
    }
    const empty = combineRegistries([]);
    expect(empty.get("hw:dimm")).toBeUndefined();
    expect(empty.list()).toEqual([]);
  });
});

describe("validate and build with packs (source)", () => {
  test.each([
    ["auto engine", engine, "engine.cosmo.json"],
    ["hw gpu", gpu, "gpu.cosmo.json"],
  ])("%s validates and builds", async (_n, body, name) => {
    const f = await file(name, body);
    const v = await run(["validate", f, "--json"], deps());
    expect(
      JSON.parse(v.stdout).diagnostics.filter((d: { severity: string }) => d.severity === "error"),
    ).toEqual([]);
    expect(v.code).toBe(0);
    const b = await run(["build", f, "--out", dir, "--no-optimize"], deps());
    expect(b.stderr).not.toContain("assembly/unknown-shape");
    expect(b.code).toBe(0);
    const svg = await readFile(join(dir, name.replace(".cosmo.json", ".svg")), "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  test("unknown shape gives did-you-mean, in validate and in build", async () => {
    const bad = spec({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "x", shape: "hw:dimn" },
            { id: "y", shape: "box" },
          ],
        },
      ],
    });
    const f = await file("bad-shape.cosmo.json", bad);
    const v = await run(["validate", f, "--json"], deps());
    expect(v.code).toBe(1);
    const d = JSON.parse(v.stdout).diagnostics.find(
      (x: { code: string }) => x.code === "assembly/unknown-shape",
    );
    expect(d.path).toBe("/assemblies/0/parts/0/shape");
    expect(d.suggestion).toContain("hw:dimm");
    const b = await run(["build", f, "--out", dir], deps());
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("assembly/unknown-shape");
  });

  test("an unknown pack is reported, not ignored", async () => {
    const f = await file(
      "nopack.cosmo.json",
      spec({
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "x", shape: "zzz:thing" },
              { id: "y", shape: "box" },
            ],
          },
        ],
      }),
    );
    const v = await run(["validate", f], deps());
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("assembly/unknown-shape");
  });

  test("bad shape params are checked against the pack", async () => {
    const f = await file(
      "params.cosmo.json",
      spec({
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "x", shape: "hw:dimm", params: { nope: 1 } },
              { id: "y", shape: "box" },
            ],
          },
        ],
      }),
    );
    const v = await run(["validate", f, "--json"], deps());
    expect(
      JSON.parse(v.stdout).diagnostics.some(
        (d: { code: string }) => d.code === "assembly/shape-params",
      ),
    ).toBe(true);
  });

  test("a group off the stud grid warns only when it holds bricks (Q02)", async () => {
    const wing = (shape: string) =>
      spec({
        assemblies: [
          {
            id: "b",
            units: "stud",
            parts: [
              { id: "base", shape: "brick:plate", at: [0, 0, 0], size: [4, 4, 1] },
              {
                id: "wing",
                at: [0.5, 0, 1],
                parts: [{ id: "leaf", shape, at: [0, 0, 0], size: [2, 2, 3] }],
              },
            ],
          },
        ],
      });
    const bricks = await run(
      ["validate", await file("wing-b.cosmo.json", wing("brick:brick")), "--json"],
      deps(),
    );
    const w = JSON.parse(bricks.stdout).diagnostics.filter(
      (d: { code: string }) => d.code === "brick/off-grid",
    );
    expect(w).toHaveLength(1);
    expect(w[0].path).toBe("/assemblies/0/parts/1/at");
    const plain = await run(
      ["validate", await file("wing-p.cosmo.json", wing("box")), "--json"],
      deps(),
    );
    expect(
      JSON.parse(plain.stdout).diagnostics.some(
        (d: { code: string }) => d.code === "brick/off-grid",
      ),
    ).toBe(false);
  });

  test("brick off-grid placement warns through validate and build; on-grid is silent", async () => {
    const mk = (at: number[]) =>
      spec({
        assemblies: [
          {
            id: "b",
            units: "stud",
            parts: [
              { id: "base", shape: "brick:plate", at: [0, 0, 0], size: [4, 4, 1] },
              { id: "brick", shape: "brick:brick", at, size: [2, 2, 3] },
            ],
          },
        ],
      });
    const off = await file("off.cosmo.json", mk([0.5, 0, 1]));
    const v = await run(["validate", off, "--json"], deps());
    const w = JSON.parse(v.stdout).diagnostics.filter(
      (d: { code: string }) => d.code === "brick/off-grid",
    );
    expect(w).toHaveLength(1);
    expect(w[0].path).toBe("/assemblies/0/parts/1/at");
    expect(v.code).toBe(0);
    expect((await run(["validate", off, "--strict"], deps())).code).toBe(1);
    const b = await run(["build", off, "--out", dir], deps());
    expect(b.stderr).toContain("brick/off-grid");
    expect(b.code).toBe(0);
    const on = await file("on.cosmo.json", mk([1, 0, 1]));
    const q = await run(["validate", on, "--json"], deps());
    expect(
      JSON.parse(q.stdout).diagnostics.some((d: { code: string }) => d.code === "brick/off-grid"),
    ).toBe(false);
  });
});

describe("built bin", () => {
  test("auto: and hw: specs validate and build from dist/bin.js", async () => {
    for (const [name, body] of [
      ["bin-engine", engine],
      ["bin-gpu", gpu],
    ] as const) {
      const f = await file(`${name}.cosmo.json`, body);
      expect(
        execFileSync(process.execPath, [bin, "validate", f], { encoding: "utf8", cwd: dir }),
      ).toContain("valid");
      execFileSync(process.execPath, [bin, "build", f, "--out", dir], { cwd: dir });
      expect((await readFile(join(dir, `${name}.svg`), "utf8")).length).toBeGreaterThan(1000);
    }
  }, 120_000);
  test("unknown shape from the bin exits 1 with did-you-mean", async () => {
    const f = await file(
      "bin-bad.cosmo.json",
      spec({
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "x", shape: "auto:pistn" },
              { id: "y", shape: "box" },
            ],
          },
        ],
      }),
    );
    const r = spawnSync(process.execPath, [bin, "validate", f], { encoding: "utf8", cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("auto:piston");
  });
});

const car = spec({
  assemblies: [
    {
      id: "car",
      label: "Car",
      units: "mm",
      parts: [
        { id: "block", at: [0, 0, 100], size: [200, 100, 100], role: "body" },
        { id: "pan", type: "oil-pan", at: [0, 0, 0], size: [200, 100, 100], role: "cover" },
        { id: "lid", type: "valve-cover", at: [0, 0, 200], size: [200, 100, 20] },
        { id: "bolt", type: "bolt", count: 4, at: [0, 0, 220], size: [5, 5, 10] },
        { id: "crank", role: "internal", at: [10, 10, 110], size: [180, 20, 20] },
        { id: "hose", at: [300, 0, 0], size: [10, 10, 10] },
      ],
    },
  ],
});

/** Merges every suggestion into the spec: programs into their owner, steps appended at the root. */
function applySuggestions(base: Spec, report: SuggestReport): Spec {
  const out = structuredClone(base) as Record<string, unknown>;
  for (const sg of report.suggestions) {
    let node = out as Record<string, unknown>;
    for (const seg of sg.pointer.split("/").slice(1)) node = node[seg] as Record<string, unknown>;
    node.programs = [...((node.programs as unknown[]) ?? []), sg.program];
    if (sg.steps) out.steps = [...((out.steps as unknown[]) ?? []), ...sg.steps];
  }
  return out as Spec;
}

describe("--png-step", () => {
  const stepped = spec({
    assemblies: [engine.assemblies[0]],
    steps: [{ caption: "one" }, { caption: "two" }],
  });

  test("builds the png of a step; it differs from the rest pose (--time 0)", async () => {
    const withProgram = applySuggestions(car, suggest(car));
    const f = await file("ps.cosmo.json", withProgram);
    const r = await run(
      ["build", f, "--png-step", "2", "--no-animated", "--out", dir, "--name", "ps2"],
      deps(),
    );
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);
    const t0 = await run(
      ["build", f, "--png", "--time", "0", "--no-animated", "--out", dir, "--name", "ps0"],
      deps(),
    );
    expect(t0.code).toBe(0);
    const step2 = await readFile(join(dir, "ps2.png"));
    const rest = await readFile(join(dir, "ps0.png"));
    expect([...step2.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(Buffer.compare(step2, rest)).not.toBe(0);
  });

  test("schema errors are shown before the step range", async () => {
    const f = await file("ps-schema.cosmo.json", { ...stepped, assemblies: [{ id: "a" }] });
    const r = await run(["build", f, "--png-step=9", "--out", dir], deps());
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("beyond");
  });

  test.each([["0"], ["-1"], ["1.5"], ["abc"], [""]])("rejects %j with exit 2", async (n) => {
    const f = await file("ps-bad.cosmo.json", stepped);
    const r = await run(["build", f, `--png-step=${n}`, "--out", dir], deps());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("options/invalid-png-step");
  });

  test("beyond the step count: diagnostic and exit 2; the range is 1..steps", async () => {
    const f = await file("ps-range.cosmo.json", stepped);
    const r = await run(["build", f, "--png-step", "3", "--out", dir, "--json"], deps());
    expect(r.code).toBe(2);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.diagnostics[0].code).toBe("options/invalid-png-step");
    expect(j.diagnostics[0].suggestion).toContain("1 to 2");
  });

  test("a spec without steps, and --time together, are errors", async () => {
    const f = await file("ps-none.cosmo.json", engine);
    const a = await run(["build", f, "--png-step", "1", "--out", dir], deps());
    expect(a.code).toBe(2);
    expect(a.stderr).toContain("has none");
    const b = await run(["build", f, "--png-step", "1", "--time", "1", "--out", dir], deps());
    expect(b.code).toBe(2);
    expect(b.stderr).toContain("exclusive");
  });

  test("help documents the flag", async () => {
    expect((await run(["build", "--help"], deps())).stdout).toContain("--png-step");
    expect((await run(["validate", "--help"], deps())).stdout).toContain("--suggest");
  });
});

describe("validate --suggest (assemblies section 17)", () => {
  test("order, directions and timing follow the heuristics", async () => {
    const f = await file("car.cosmo.json", car);
    const r = await run(["validate", f, "--suggest", "--json"], deps());
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout).suggestions.suggestions[0];
    expect(s.body).toBe("block");
    expect(s.classes.fastener).toEqual(["bolt"]);
    expect(s.classes.cover).toEqual(["pan", "lid"]);
    const st = s.program.stages as {
      label: string;
      parts: string[];
      direction: string;
      fade?: string;
      stagger: number;
      duration: number;
      labels: string;
    }[];
    expect(st.map((x) => x.label)).toEqual([
      "Fasteners",
      "Covers (+z)",
      "Internals",
      "Other parts",
      "Covers (-z, hidden side)",
    ]);
    expect(st[0]).toMatchObject({ parts: ["bolt-*"], direction: "+z", labels: "show" });
    expect(st[1]).toMatchObject({ parts: ["lid"], direction: "+z" });
    expect(st[4]).toMatchObject({ parts: ["pan"], direction: "-z", fade: "unselected" });
    for (const x of st) {
      expect(x.stagger).toBeGreaterThanOrEqual(0.06);
      expect(x.stagger).toBeLessThanOrEqual(0.12);
      expect(x.duration).toBeGreaterThanOrEqual(0.6);
      expect(x.duration).toBeLessThanOrEqual(1.0);
    }
    const steps = s.steps as {
      caption: string;
      assembly?: { explode?: string; implode?: string; to?: number }[];
    }[];
    expect(steps[0]!.caption).toBe("Car assembled");
    expect(steps[1]!.assembly![0]).toMatchObject({ explode: "car", to: 1 });
    expect(steps.at(-1)!.assembly![0]).toEqual({ implode: "car" });
    expect(steps).toHaveLength(st.length + 2);
  });

  test("deterministic text; skipped assemblies are named; no assemblies is said", async () => {
    const f = await file("car2.cosmo.json", car);
    const a = await run(["validate", f, "--suggest"], deps());
    const b = await run(["validate", f, "--suggest"], deps());
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("suggested program for car");
    expect(a.stdout).toContain("body: block (role body)");
    expect(a.stdout).toContain("stage 5: Covers (-z, hidden side) -> -z");
    const has = spec({
      assemblies: [
        {
          ...car.assemblies[0],
          program: "p",
          programs: [{ id: "p", stages: [{ parts: ["bolt-*"] }] }],
        },
      ],
    });
    const h = await run(["validate", await file("has.cosmo.json", has), "--suggest"], deps());
    expect(h.stdout).toContain("no suggestion for car: already has a program");
    const lb = fileURLToPath(
      new URL("../../../examples/load-balancing.cosmo.json", import.meta.url),
    );
    const n = await run(["validate", lb, "--suggest"], deps());
    expect(n.stdout).toContain("no assemblies to suggest");
  });

  test("body falls back to mates, then to the largest volume; stages of more than 24 are split", () => {
    const mates = suggest({
      assemblies: [
        { id: "a", parts: [{ id: "p", mates: "q" }, { id: "q" }, { id: "r", mates: "q" }] },
      ],
    });
    expect(mates.suggestions[0]!.body).toBe("q");
    const big = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "x", size: [9, 9, 9], at: [0, 0, 0] },
            { id: "y", size: [1, 1, 1], at: [20, 0, 0] },
          ],
        },
      ],
    });
    expect(big.suggestions[0]!.body).toBe("x");
    const many = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "body", role: "body" },
            ...Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, type: "screw" })),
          ],
        },
      ],
    });
    const stages = many.suggestions[0]!.program.stages;
    expect(stages.map((s) => s.parts.length)).toEqual([24, 6]);
    expect(stages[0]!.labels).toBe("hide");
    expect(stages[1]!.labels).toBe("show");
    expect(formatSuggestions("f", many)).toContain("Fasteners 1/2");
  });

  test("nested sub-assemblies get their own program and story steps", () => {
    const r = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "frame", role: "body" },
            {
              id: "unit",
              parts: [
                { id: "shell", role: "body" },
                { id: "chip", role: "internal" },
                { id: "plate", role: "cover" },
              ],
            },
          ],
        },
      ],
    });
    expect(r.suggestions.map((s) => s.owner)).toEqual(["a", "a/unit"]);
    const caps = r.suggestions[0]!.steps!.map((s) => s.caption);
    expect(caps.some((c) => c.startsWith("unit: "))).toBe(true);
  });
});

describe("1.1 output is unchanged", () => {
  test("a 1.1 example's validate output has no suggestion text and no suggestions key", async () => {
    const f = fileURLToPath(
      new URL("../../../examples/load-balancing.cosmo.json", import.meta.url),
    );
    const r = await run(["validate", f], deps());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${f}: valid\n`);
    const s = await run(["validate", f, "--suggest"], deps());
    expect(s.stdout).toBe(`${f}: valid\n${f}: no assemblies to suggest a program for\n`);
    const j = JSON.parse((await run(["validate", f, "--json"], deps())).stdout);
    expect(Object.keys(j)).toEqual(["file", "valid", "diagnostics"]);
  });
});

const docSpec = (title: string): Spec => {
  const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
  for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
    const o = JSON.parse(m[1] as string) as { meta?: { title?: string } };
    if (o.meta?.title === title) return o as unknown as Spec;
  }
  throw new Error(`no example titled ${title}`);
};
/** The example with its programs and steps removed: the "user gave no program" case. */
const bare = (title: string): Spec => {
  type BarePart = { programs?: unknown; parts?: BarePart[] };
  type BareSpec = {
    steps?: unknown;
    assemblies: (BarePart & { program?: unknown; pose?: unknown; parts: BarePart[] })[];
  };
  const o = structuredClone(docSpec(title)) as unknown as BareSpec;
  delete o.steps;
  const strip = (parts: BarePart[]): void => {
    for (const p of parts) {
      delete p.programs;
      if (p.parts) strip(p.parts);
    }
  };
  for (const a of o.assemblies) {
    delete a.program;
    delete a.programs;
    delete a.pose;
    strip(a.parts);
  }
  return o as unknown as Spec;
};
const selects = (stages: { parts: string[] }[], id: string): boolean =>
  stages.some((st) => st.parts.includes(id) || st.parts.includes(`${id}-*`));

describe("suggest on pack-shaped models (pack default role body is not THE body)", () => {
  test("flat brick rover: every leaf but the base moves, none is dropped", () => {
    const rover = bare("Brick rover");
    const rep = suggest(rover, defaultDeps().parts);
    const root = rep.suggestions[0]!;
    const ids = (rover.assemblies[0]!.parts as { id: string }[]).map((p) => p.id);
    expect(root.body).toBe("plate"); // largest volume, not the first brick with a body default
    const moved = new Set(root.program.stages.flatMap((st) => st.parts));
    for (const id of ids.filter((i) => i !== "plate")) {
      expect(selects(root.program.stages, id), `${id} is staged`).toBe(true);
    }
    expect(moved.has("plate")).toBe(false);
    expect(rep.skipped).toEqual([]);
  });

  test("auto: engine: pack-default body parts are staged", () => {
    const engineDoc = bare("Inline-4 engine teardown");
    // Take the explicit roles away: only pack defaults (and types) remain.
    for (const p of engineDoc.assemblies[0]!.parts as { role?: string; shape?: string }[]) {
      if (p.role !== "body") delete p.role;
    }
    const rep = suggest(engineDoc, defaultDeps().parts);
    const root = rep.suggestions[0]!;
    expect(root.body).toBe("block");
    const ids = (engineDoc.assemblies[0]!.parts as { id: string }[]).map((p) => p.id);
    for (const id of ids.filter((i) => i !== "block")) {
      expect(selects(root.program.stages, id), `${id} is staged`).toBe(true);
    }
  });

  test("a pack-default body is never taken for the body when another part is explicit", () => {
    const rep = suggest(
      {
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "b1", shape: "brick:brick", at: [0, 0, 0], size: [4, 4, 3] },
              { id: "frame", role: "body" },
              { id: "b2", shape: "brick:brick", at: [0, 0, 3], size: [2, 2, 3] },
            ],
          },
        ],
      },
      defaultDeps().parts,
    );
    expect(rep.suggestions[0]!.body).toBe("frame");
    expect(rep.suggestions[0]!.classes.loose).toEqual(["b1", "b2"]);
  });
});

describe("suggestions are valid specs (merge, validate, no compression)", () => {
  const cases: [string, () => Spec][] = [
    ["car", () => car],
    ["engine (auto:)", () => bare("Inline-4 engine teardown")],
    ["brick rover", () => bare("Brick rover")],
    [
      "nested sub-assembly",
      () =>
        spec({
          assemblies: [
            {
              id: "a",
              units: "mm",
              parts: [
                { id: "frame", role: "body", at: [0, 0, 0], size: [100, 100, 20] },
                {
                  id: "unit",
                  at: [10, 10, 20],
                  parts: [
                    { id: "shell", role: "body", at: [0, 0, 0], size: [50, 50, 10] },
                    { id: "chip", role: "internal", at: [5, 5, 10], size: [10, 10, 5] },
                    { id: "lid", role: "cover", at: [0, 0, 20], size: [50, 50, 2] },
                  ],
                },
              ],
            },
          ],
        }),
    ],
  ];
  test.each(cases)(
    "%s",
    async (name, mk) => {
      const base = mk();
      const rep = suggest(base, defaultDeps().parts);
      expect(rep.suggestions.length).toBeGreaterThan(0);
      const merged = applySuggestions(base, rep);
      const f = await file(`merge-${name.replace(/\W+/g, "-")}.cosmo.json`, merged);
      const v = await run(["validate", f, "--json"], deps());
      const diags = JSON.parse(v.stdout).diagnostics as {
        severity: string;
        code: string;
        path: string;
        message: string;
      }[];
      expect(diags.filter((d) => d.severity === "error")).toEqual([]);
      expect(diags.filter((d) => d.code === "assembly/compressed")).toEqual([]);
      expect(v.code).toBe(0);
    },
    60_000,
  );

  test("the story's last frame is the rest pose, nested owners included", async () => {
    const base = cases.find(([n]) => n === "nested sub-assembly")![1]();
    const rep = suggest(base, defaultDeps().parts);
    const steps = rep.suggestions[0]!.steps!;
    expect(steps.at(-1)!.assembly).toEqual([{ implode: "a/unit" }, { implode: "a" }]);
    const merged = applySuggestions(base, rep);
    // Same caption on both, so only the scene can differ between the two frames.
    const all = merged.steps as { caption: string }[];
    all[0]!.caption = all.at(-1)!.caption = "frame";
    const f = await file("rest-pose.cosmo.json", merged);
    const last = String(steps.length);
    for (const [step, name] of [
      ["1", "rp1"],
      [last, "rpn"],
    ] as const) {
      const r = await run(
        ["build", f, "--png-step", step, "--no-animated", "--out", dir, "--name", name],
        deps(),
      );
      expect(r.code).toBe(0);
    }
    const first = await readFile(join(dir, "rp1.png"));
    const end = await readFile(join(dir, "rpn.png"));
    expect(Buffer.compare(first, end)).toBe(0);
  }, 120_000);

  test("the text says where each part of the fragment goes", () => {
    const text = formatSuggestions("f", suggest(car));
    expect(text).toContain('add to "programs" at /assemblies/0/programs');
    expect(text).toContain('append to the top-level "steps"');
  });

  test("step durations follow each stage's leaf count; the implode step plays the whole program", () => {
    const root = suggest(car).suggestions[0]!;
    const steps = root.steps!;
    root.program.stages.forEach((st, k) => {
      const n = root.stageLeaves[k]!;
      const expected = fitStep(st.duration + st.stagger * (n - 1));
      expect(steps[k + 1]!.duration).toBe(expected);
    });
    expect(root.stageLeaves[0]).toBe(4); // the bolt-* stage holds four leaves
    expect(steps.at(-1)!.duration).toBe(root.stepDuration);
  });
});

describe("validate --suggest with errors, and owner limits", () => {
  test("errors skip suggestions with a visible reason, in text and JSON", async () => {
    const f = await file(
      "sk.cosmo.json",
      spec({
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "x", shape: "hw:dimn" },
              { id: "y", shape: "box" },
            ],
          },
        ],
      }),
    );
    const t = await run(["validate", f, "--suggest"], deps());
    expect(t.code).toBe(1);
    expect(t.stdout).toContain("suggestions skipped: fix errors first");
    const j = JSON.parse((await run(["validate", f, "--suggest", "--json"], deps())).stdout);
    expect(j.suggestions).toBeNull();
    expect(j.suggestionsSkipped).toContain("fix errors first");
  });

  test("the root owner counts toward the limit", () => {
    const groups = Array.from({ length: 100 }, (_, i) => ({
      id: `g${i}`,
      parts: [{ id: "a", role: "body" }, { id: "b" }, { id: "c", role: "internal" }],
    }));
    const rep = suggest({
      assemblies: [{ id: "root", parts: [{ id: "body", role: "body" }, ...groups] }],
    });
    expect(rep.suggestions.length).toBe(64);
  });
});

describe("packs wired vs not: unchanged output for specs that use no packs (Q06)", () => {
  const unwired = () => ({
    ...defaultDeps(),
    env: {},
    cwd: dir,
    parts: undefined,
    placement: undefined,
  });
  async function bytes(name: string, body: unknown, d: ReturnType<typeof deps>): Promise<string[]> {
    const f = await file(`${name}.cosmo.json`, body);
    const out = join(dir, `out-${name}-${d === wiredDeps ? "w" : "u"}`);
    const r = await run(["build", f, "--static", "--steps", "--out", out, "--name", "o"], d);
    expect(r.code, r.stderr).toBe(0);
    const files = (await readdir(out, { recursive: true })).sort();
    const all: string[] = [];
    for (const rel of files) {
      const full = join(out, rel);
      if ((await stat(full)).isFile())
        all.push(`${rel}\n${(await readFile(full)).toString("latin1")}`);
    }
    return all;
  }
  let wiredDeps: ReturnType<typeof deps>;
  const same = async (name: string, body: unknown): Promise<void> => {
    wiredDeps = deps();
    const a = await bytes(name, body, wiredDeps);
    const b = await bytes(name, body, unwired());
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  };

  test("a 1.1 example", async () => {
    const f = fileURLToPath(
      new URL("../../../examples/load-balancing.cosmo.json", import.meta.url),
    );
    await same("lb", JSON.parse(readFileSync(f, "utf8")));
  }, 120_000);

  test("a figure spec", async () => {
    await writeFile(
      join(dir, "base.png"),
      encodePng({ width: 8, height: 6, data: new Uint8Array(8 * 6 * 4).fill(200) }),
    );
    await writeFile(
      join(dir, "spr.png"),
      encodePng({ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(90) }),
    );
    await same(
      "fig",
      spec({
        images: [
          { id: "base", src: "base.png" },
          { id: "spr", src: "spr.png" },
        ],
        figures: [{ id: "f", base: "base", parts: [{ id: "p1", image: "spr", seat: [0, 2] }] }],
      }),
    );
  }, 120_000);

  test("a Phase 1b assembly spec without packs", async () => {
    await same("p1b", applySuggestions(car, suggest(car)));
  }, 120_000);
});
