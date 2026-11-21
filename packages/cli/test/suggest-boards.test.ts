/**
 * `validate --suggest` on boards, owners without `at`, and mounted parts (assemblies.md 17):
 * fixtures from the D-3b skill E2E (a plan board, a 2U GPU server, an engine), programs removed.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedExplodeProgram, SceneAssemblyNode } from "@platformcosmo/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";
import { suggest, type SuggestReport, type SuggestedStage } from "../src/suggest.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcosmo-boards-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const deps = () => ({ ...defaultDeps(), env: {}, cwd: dir });
const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL(`./fixtures/suggest/${name}.cosmo.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

async function suggestOf(spec: unknown, name: string): Promise<SuggestReport> {
  const f = join(dir, `${name}.cosmo.json`);
  await writeFile(f, JSON.stringify(spec));
  const r = await run(["validate", f, "--suggest", "--json"], deps());
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { suggestions: SuggestReport }).suggestions;
}

const brief = (s: SuggestedStage[]): unknown[] =>
  s.map((x) => [x.label, x.direction, x.distance, x.labels, x.parts.join(",")]);

/** Programs and steps merged into the spec, then validated and built: diagnostics must be clean. */
async function mergedDiagnostics(spec: Record<string, unknown>, rep: SuggestReport, name: string) {
  type Node = Record<string, unknown> & { programs?: unknown[] };
  const out = structuredClone(spec) as Node & { steps?: unknown[] };
  for (const sg of rep.suggestions) {
    let node: Node = out;
    for (const seg of sg.pointer.split("/").slice(1)) node = node[seg] as Node;
    node.programs = [...(node.programs ?? []), sg.program];
    if (sg.steps) out.steps = [...(out.steps ?? []), ...sg.steps];
  }
  const f = join(dir, `${name}-merged.cosmo.json`);
  await writeFile(f, JSON.stringify(out));
  const v = await run(["validate", f, "--json"], deps());
  const b = await run(["build", f, "--out", dir, "--json"], deps());
  const codes = [...JSON.parse(v.stdout).diagnostics, ...(JSON.parse(b.stdout).diagnostics ?? [])]
    .filter((d: { severity: string }) => d.severity !== "info")
    .map((d: { code: string; message: string }) => `${d.code} ${d.message}`);
  return { codes, vCode: v.code, bCode: b.code };
}

describe("boards: parts on the body's top face", () => {
  const expected = (distance: number): unknown[] => [
    [
      "Components",
      "+z",
      distance,
      "show",
      "power,cpu-1,dimm-a,dimm-b,cpu-2,dimm-c,dimm-d,pcie-x16-1,pcie-x16-2,pcie-x8,bridge,bios,battery,jp1,sata,usb",
    ],
  ];

  test.each([
    ["board", 82.55],
    ["board-noscale", 97.5],
  ])(
    "%s: one visible +z lift, labelled, nothing sideways",
    async (name, distance) => {
      const spec = await fixture(name);
      const rep = await suggestOf(spec, name);
      const s = rep.suggestions[0]!;
      expect(s.body).toBe("mainboard");
      expect(brief(s.program.stages)).toEqual(expected(distance));
      expect(s.classes.cover).toEqual([]);
      expect(s.classes.loose).toEqual([]);
      expect(s.classes.mounted).toHaveLength(16);
      expect(s.steps!.map((x) => x.caption)).toEqual([
        "Mainboard assembled",
        "Components",
        "Mainboard reassembled",
      ]);
      const m = await mergedDiagnostics(spec, rep, name);
      expect(m).toEqual({ codes: [], vCode: 0, bCode: 0 });
    },
    120_000,
  );

  test("a part mounted on another part leaves in an earlier, higher stage", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "b",
          parts: [
            { id: "plate", role: "body", at: [0, 0, 0], size: [100, 100, 2] },
            { id: "cpu", at: [10, 10, 2], size: [20, 20, 5], label: "CPU" },
            { id: "sink", at: [10, 10, 7], size: [20, 20, 10], label: "Sink" },
            { id: "cap", at: [60, 60, 2], size: [5, 5, 5], label: "Cap" },
          ],
        },
      ],
    });
    expect(brief(rep.suggestions[0]!.program.stages)).toEqual([
      ["Components (level 1)", "+z", 50, "show", "sink"],
      ["Components (level 0)", "+z", 25, "show", "cpu,cap"],
    ]);
  });

  test("a thin cover that spans the body is still a cover (a lid, not a component)", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "box",
          parts: [
            { id: "base", role: "body", at: [0, 0, 0], size: [100, 100, 40] },
            { id: "top", at: [0, 0, 40], size: [100, 100, 4] },
            { id: "chip", at: [10, 10, 40], size: [10, 10, 4] },
          ],
        },
      ],
    });
    const s = rep.suggestions[0]!;
    expect(s.classes.cover).toEqual(["top"]);
    expect(s.classes.mounted).toEqual(["chip"]);
    expect(rep.suggestions[0]!.program.stages.map((x) => x.label)).toEqual([
      "Covers",
      "Components",
    ]);
  });
});

describe("focus and labels", () => {
  test("root steps carry no focus (the zoom cropped the board); nested owners focus whole", () => {
    const rep = suggest({
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
    const steps = rep.suggestions[0]!.steps!;
    expect(steps.filter((s) => s.assembly && "explode" in s.assembly[0]!)).toEqual([
      expect.not.objectContaining({ focus: expect.anything() }),
      expect.objectContaining({ focus: "a/unit" }),
      expect.objectContaining({ focus: "a/unit" }),
    ]);
    expect(steps.some((s) => "focus" in s && (s.focus ?? "").startsWith("a/frame"))).toBe(false);
  });

  test("labelled parts keep labels even in a stage of more than 12; unlabelled ones hide", () => {
    const parts = (label: boolean): unknown[] => [
      { id: "plate", role: "body", at: [0, 0, 0], size: [200, 100, 2] },
      ...Array.from({ length: 14 }, (_, i) => ({
        id: `c${i}`,
        at: [i * 10, 0, 2],
        size: [8, 8, 4],
        ...(label ? { label: `C${i}` } : {}),
      })),
    ];
    const lab = suggest({ assemblies: [{ id: "b", parts: parts(true) }] });
    const bare = suggest({ assemblies: [{ id: "b", parts: parts(false) }] });
    expect(lab.suggestions[0]!.program.stages[0]!.labels).toBe("show");
    expect(bare.suggestions[0]!.program.stages[0]!.labels).toBe("hide");
  });
});

describe("effective placement", () => {
  const tray = (withAt: boolean) => ({
    $schema: "https://platformcosmo.io/schema/v1.json",
    meta: { version: "1", title: "t" },
    assemblies: [
      {
        id: "t",
        units: "mm",
        parts: [
          { id: "lid", type: "plate", at: [0, 0, 40], size: [20, 20, 3] },
          { id: "tray", shape: "tray", ...(withAt ? { at: [0, 0, 0] } : {}), size: [200, 100, 40] },
        ],
      },
    ],
  });

  test("omitting `at` does not flip the body pick to the small lid", async () => {
    const stated = suggest(tray(false));
    expect(stated.suggestions[0]!.body).toBe("lid"); // spec-only view: the tray has no box
    const placed = await suggestOf(tray(false), "tray-no-at");
    expect(placed.suggestions[0]!.body).toBe("tray");
    const withAt = await suggestOf(tray(true), "tray-at");
    expect(withAt.suggestions[0]!.body).toBe("tray");
    expect(brief(placed.suggestions[0]!.program.stages)).toEqual(
      brief(withAt.suggestions[0]!.program.stages),
    );
  });
});

describe("mounting depth: board-mounted parts leave before the board", () => {
  test("gpu server: heat sinks, then cpus/DIMMs/gpu, then board/fans/psus; clean merged build", async () => {
    const spec = await fixture("gpu-server");
    const rep = await suggestOf(spec, "gpu-server");
    expect(brief(rep.suggestions[0]!.program.stages)).toEqual([
      ["Covers", "+x", "auto", "show", "lid"],
      ["Internals (level 2)", "+z", "auto", "show", "heatsink-*"],
      ["Internals (level 1)", "+z", "auto", "show", "cpu-*,dimm-left-*,dimm-right-*,gpu"],
      ["Internals (level 0)", "+z", "auto", "show", "board,fan-*,psu-*"],
    ]);
    const m = await mergedDiagnostics(spec, rep, "gpu-server");
    expect(m).toEqual({ codes: [], vCode: 0, bCode: 0 });
  }, 120_000);

  test("engine: pistons lift before the rods and crank, which interpenetrate and move as one; clean merged build", async () => {
    const spec = await fixture("engine");
    const rep = await suggestOf(spec, "engine");
    expect(brief(rep.suggestions[0]!.program.stages)).toEqual([
      ["Covers (+z, level 2)", "+z", "auto", "show", "valve-cover"],
      ["Covers (+z, level 1)", "+z", "auto", "show", "head"],
      ["Covers (+z, level 0)", "+z", "auto", "show", "gasket"],
      ["Internals (level 1)", "+z", "auto", "show", "piston-*"],
      ["Internals (level 0)", "+z", "auto", "show", "intake,exhaust"],
      ["Internals (level 0, moving as one)", "+z", 241.6, "show", "rod-*,crank"],
      ["Covers (-z, hidden side)", "-z", "auto", "show", "oil-pan"],
    ]);
    expect(rep.suggestions[0]!.program.stages.map((x) => x.stagger)).toEqual([
      0.08, 0.08, 0.08, 0.08, 0.08, 0, 0.08,
    ]);
    const m = await mergedDiagnostics(spec, rep, "engine");
    expect(m).toEqual({ codes: [], vCode: 0, bCode: 0 });
  }, 120_000);
});

const wrap = (assemblies: unknown[]) => ({
  $schema: "https://platformcosmo.io/schema/v1.json",
  meta: { version: "1", title: "t" },
  assemblies,
});
const stagesOf = (rep: SuggestReport, k = 0): unknown[] =>
  brief(rep.suggestions[k]!.program.stages);

describe("counted parts: one instance decides volume and thinness", () => {
  test("a counted row whose union is larger than the body does not take the body pick", async () => {
    const spec = wrap([
      {
        id: "a",
        units: "mm",
        parts: [
          { id: "base", at: [0, 0, 0], size: [100, 100, 10] },
          { id: "fan", count: 4, at: [0, 0, 10], size: [20, 20, 20], pitch: [110, 0, 0] },
        ],
      },
    ]);
    expect((await suggestOf(spec, "row-body")).suggestions[0]!.body).toBe("base");
    expect(suggest(spec).suggestions[0]!.body).toBe("base");
  });

  test("a row of flat parts is not a cover even when the row spans the body", async () => {
    const spec = wrap([
      {
        id: "a",
        units: "mm",
        parts: [
          { id: "base", role: "body", at: [0, 0, 0], size: [100, 16, 5] },
          { id: "chip", count: 8, at: [0, 3, 5], size: [10, 10, 1], pitch: [11, 0, 0] },
        ],
      },
    ]);
    const s = (await suggestOf(spec, "row-chips")).suggestions[0]!;
    expect(s.classes.cover).toEqual([]);
    expect(s.classes.mounted).toEqual(["chip"]);
  });
});

describe("effective sizes through validate", () => {
  test("a dc: part without size resolves to the DC pack's default size", async () => {
    const spec = wrap([
      {
        id: "a",
        units: "mm",
        parts: [
          { id: "box", at: [0, 0, 0], size: [100, 100, 100] },
          { id: "srv", shape: "dc:server-2u", at: [0, 0, 0] },
        ],
      },
    ]);
    expect((await suggestOf(spec, "dc-size")).suggestions[0]!.body).toBe("srv");
  });

  test("a pack shape without size takes its default size", async () => {
    const spec = wrap([
      {
        id: "a",
        units: "mm",
        parts: [
          { id: "small", at: [0, 0, 0], size: [100, 100, 50] },
          { id: "chassis", shape: "hw:chassis-2u" },
        ],
      },
    ]);
    expect(suggest(spec).suggestions[0]!.body).toBe("small");
    expect((await suggestOf(spec, "hw-size")).suggestions[0]!.body).toBe("chassis");
  });

  test("a nested owner uses the tree's placement too", async () => {
    const spec = wrap([
      {
        id: "a",
        units: "mm",
        parts: [
          { id: "frame", role: "body", at: [0, 0, 0], size: [500, 500, 10] },
          {
            id: "unit",
            parts: [
              { id: "lid", at: [0, 0, 40], size: [20, 20, 3] },
              { id: "tray", shape: "tray", size: [200, 100, 40] },
              { id: "chip", role: "internal", at: [10, 10, 5], size: [20, 20, 5] },
            ],
          },
        ],
      },
    ]);
    const rep = await suggestOf(spec, "nested-at");
    expect(rep.suggestions.map((x) => [x.owner, x.body])).toEqual([
      ["a", "frame"],
      ["a/unit", "tray"],
    ]);
  });
});

describe("rigid groups", () => {
  const shelled = (body: unknown) =>
    wrap([
      {
        id: "a",
        units: "mm",
        parts: [
          body,
          { id: "case", shape: "tray", at: [0, 0, 0], size: [200, 100, 60] },
          { id: "p", role: "internal", at: [10, 10, 10], size: [50, 50, 20] },
          { id: "q", role: "internal", at: [30, 30, 15], size: [50, 50, 20] },
          { id: "r", role: "internal", at: [150, 10, 10], size: [20, 20, 20] },
        ],
      },
    ]);

  test("only the interpenetrating parts move as one; the shell's top is cleared (no body box)", () => {
    const s = suggest(shelled({ id: "frame", role: "body" })).suggestions[0]!;
    expect(brief(s.program.stages)).toEqual([
      ["Internals", "lift", "auto", "show", "r"],
      ["Internals (moving as one)", "+z", 70, "show", "p,q"],
      ["Other parts", "out", "auto", "show", "case"],
    ]);
    expect(s.program.stages[1]!.stagger).toBe(0);
    expect(s.explanation.join("\n")).toContain("0 for parts that move as one");
  });

  test("a body whose top is lower than the shell's does not shorten the lift", () => {
    const s = suggest(shelled({ id: "frame", role: "body", at: [0, 0, 0], size: [200, 100, 10] }));
    expect(s.suggestions[0]!.program.stages[1]!.distance).toBe(70);
  });

  test("a rigid group is never split into 24-part chunks", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "base", role: "body", at: [0, 0, -10], size: [3000, 20, 10] },
            {
              id: "pin",
              role: "internal",
              count: 30,
              at: [0, 0, 0],
              size: [10, 10, 10],
              pitch: [100, 0, 0],
            },
            { id: "rail", role: "internal", at: [0, 0, 0], size: [3000, 10, 10] },
          ],
        },
      ],
    });
    const st = rep.suggestions[0]!.program.stages;
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ label: "Internals (moving as one)", parts: ["pin-*", "rail"] });
  });
});

describe("carried parts never leave after their carrier", () => {
  test("a component on a lid joins the covers, above it", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "plate", role: "body", at: [0, 0, 0], size: [100, 100, 2] },
            { id: "lid", type: "lid", at: [0, 0, 2], size: [100, 100, 2] },
            { id: "sensor", at: [10, 10, 4], size: [10, 10, 5] },
          ],
        },
      ],
    });
    expect(rep.suggestions[0]!.classes.cover).toEqual(["lid", "sensor"]);
    expect(stagesOf(rep)).toEqual([
      ["Covers (level 1)", "+z", "auto", "show", "sensor"],
      ["Covers (level 0)", "+z", "auto", "show", "lid"],
    ]);
  });

  test("a part on a component that overhangs the body joins the components", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "plate", role: "body", at: [0, 0, 0], size: [100, 100, 2] },
            { id: "deck", at: [50, 50, 2], size: [100, 100, 5] },
            { id: "tower", at: [120, 120, 7], size: [10, 10, 5] },
          ],
        },
      ],
    });
    expect(rep.suggestions[0]!.classes.loose).toEqual([]);
    expect(stagesOf(rep)).toEqual([
      ["Components (level 1)", "+z", 50, "show", "tower"],
      ["Components (level 0)", "+z", 25, "show", "deck"],
    ]);
  });

  test("a zero-height part carries nothing", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "plate", role: "body", at: [0, 0, 0], size: [100, 100, 2] },
            { id: "film", at: [0, 0, 2], size: [100, 100, 0] },
            { id: "chip", at: [10, 10, 2], size: [5, 5, 5] },
          ],
        },
      ],
    });
    expect(stagesOf(rep).map((x) => (x as unknown[])[0])).toEqual(["Covers", "Components"]);
  });
});

describe("cover wording", () => {
  test("a bare `cap` is a capacitor, `dust-cap` a cover; a thin sheet floating above is not a cover", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "base", role: "body", at: [0, 0, 0], size: [100, 100, 10] },
            { id: "c1", type: "cap", at: [0, 0, 10], size: [10, 10, 2] },
            { id: "dc", type: "dust-cap", at: [50, 50, 10], size: [10, 10, 2] },
            { id: "sheet", at: [0, 0, 30], size: [100, 100, 1] },
          ],
        },
      ],
    });
    const s = rep.suggestions[0]!;
    expect(s.classes.cover).toEqual(["dc"]);
    expect(s.classes.mounted).toEqual(["c1", "sheet"]);
  });
});

describe("carrying tolerance", () => {
  test("a part sunk 0.5% into its carrier, and one with a 0.5% gap, are both carried", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "plate", role: "body", at: [0, 0, 0], size: [100, 100, 2] },
            { id: "deck", at: [0, 0, 2], size: [50, 50, 10] },
            { id: "sunk", label: "S", at: [5, 5, 11.95], size: [5, 5, 5] },
            { id: "gap", label: "G", at: [30, 30, 12.05], size: [5, 5, 5] },
          ],
        },
      ],
    });
    expect(stagesOf(rep)).toEqual([
      ["Components (level 1)", "+z", 50, "show", "sunk,gap"],
      ["Components (level 0)", "+z", 25, "show", "deck"],
    ]);
  });

  test("a folded part is explained", () => {
    const rep = suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "plate", role: "body", at: [0, 0, 0], size: [100, 100, 2] },
            { id: "lid", type: "lid", at: [0, 0, 2], size: [100, 100, 2] },
            { id: "sensor", at: [10, 10, 4], size: [10, 10, 5] },
          ],
        },
      ],
    });
    expect(rep.suggestions[0]!.explanation).toContain("sensor joins covers (carried by lid)");
  });
});

describe("covers move aside; counted sub-assemblies", () => {
  type Rect = { x: number; y: number; width: number; height: number };
  /** Final pose screen rectangles of every leaf of assembly `id` after the suggested program. */
  async function finalRects(spec: Record<string, unknown>, rep: SuggestReport, id: string) {
    const core = await import("@platformcosmo/core");
    const parts = defaultDeps().parts;
    type Node = Record<string, unknown> & { programs?: unknown[] };
    const out = structuredClone(spec) as Node;
    for (const sg of rep.suggestions) {
      let node: Node = out;
      for (const seg of sg.pointer.split("/").slice(1)) node = node[seg] as Node;
      node.programs = [...(node.programs ?? []), sg.program];
    }
    const g = core.buildScene(out as never, { ...(parts ? { parts } : {}) } as never);
    const a = g.assemblies!.assemblies.find((x) => x.id === id)!;
    const prog = a.programs.find((p) => p.owner === id)! as ResolvedExplodeProgram;
    const proj = core.createProjection();
    const rects = new Map<string, Rect>();
    const walk = (n: SceneAssemblyNode): void => {
      if (n.kind === "leaf") {
        const o = { x: 0, y: 0, z: 0 };
        for (const m of prog.stages.flatMap((s) => s.moves))
          if (n.path === m.path || n.path.startsWith(`${m.path}/`)) {
            o.x += m.offset.x;
            o.y += m.offset.y;
            o.z += m.offset.z;
          }
        const w = n.world;
        rects.set(
          n.path,
          core.projectBoxBounds(proj, {
            origin: { x: w.origin.x + o.x, y: w.origin.y + o.y, z: w.origin.z + o.z },
            size: w.size,
          }) as Rect,
        );
      }
      for (const c of (n as { children?: readonly SceneAssemblyNode[] }).children ?? []) walk(c);
    };
    walk(a.root);
    return rects;
  }
  /** Share of `b`'s screen rectangle that `a` covers. */
  const share = (a: Rect, b: Rect): number => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / (b.width * b.height) : 0;
  };

  test("gpu lid slides off the visible side; no part's final projected box is covered by it", async () => {
    const spec = await fixture("gpu-server-r2");
    const rep = await suggestOf(spec, "gpu-r2");
    expect(brief(rep.suggestions[0]!.program.stages).slice(0, 2)).toEqual([
      ["Covers", "+x", "auto", "show", "lid"],
      ["Internals (level 2)", "+z", "auto", "show", "sink-*"],
    ]);
    const rects = await finalRects(spec, rep, "srv");
    const lid = rects.get("srv/lid")!;
    // the lid stands beside the stack: its rectangle may touch the resting chassis and the board
    // corner, but covers no moved part (lifted straight up it covered all of them)
    const covered = [...rects].filter(
      ([p, r]) => p !== "srv/lid" && p !== "srv/chassis" && share(lid, r) > 0.2,
    );
    expect(covered.map(([p]) => p)).toEqual([]);
    expect(share(lid, rects.get("srv/chassis")!)).toBeLessThan(0.5);
  }, 120_000);

  test("gpu r2: merged program builds clean (no compression, no transit collision)", async () => {
    const spec = await fixture("gpu-server-r2");
    const rep = await suggestOf(spec, "gpu-r2-clean");
    expect(await mergedDiagnostics(spec, rep, "gpu-r2")).toEqual({ codes: [], vCode: 0, bCode: 0 });
  }, 120_000);

  test("engine r2: no one-stage nested programs for the piston and rod pairs", async () => {
    const spec = await fixture("engine-r2");
    const rep = await suggestOf(spec, "engine-r2");
    expect(rep.suggestions.map((x) => x.owner)).toEqual(["engine"]);
    expect(rep.suggestions[0]!.steps!.some((s) => (s.focus ?? "").includes("pr-"))).toBe(false);
    // the root program's transit collisions (pistons out through the block) are not this change's
    const m = await mergedDiagnostics(spec, rep, "engine-r2");
    expect(m).toMatchObject({ vCode: 0, bCode: 0 });
    expect(m.codes.filter((c) => !c.startsWith("assembly/transit-collision"))).toEqual([]);
  }, 120_000);

  const unit = (parts: unknown[]) =>
    suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "frame", role: "body", at: [0, 0, 0], size: [200, 200, 10] },
            { id: "unit", parts },
          ],
        },
      ],
    });

  test("a sub-assembly with two stages keeps its nested program and focused steps", () => {
    const rep = unit([
      { id: "shell", role: "body", at: [0, 0, 20], size: [100, 100, 40] },
      { id: "lid", at: [0, 0, 60], size: [100, 100, 3] },
      { id: "chip", role: "internal", at: [10, 10, 30], size: [20, 20, 10] },
    ]);
    expect(rep.suggestions.map((x) => x.owner)).toEqual(["a", "a/unit"]);
    expect(rep.suggestions[1]!.program.stages.length).toBeGreaterThanOrEqual(2);
    expect(rep.suggestions[0]!.steps!.some((s) => s.focus === "a/unit")).toBe(true);
  });

  test("a sub-assembly with a single stage gets no nested program", () => {
    const rep = unit([
      { id: "shell", role: "body", at: [0, 0, 20], size: [100, 100, 40] },
      { id: "chip", role: "internal", at: [10, 10, 30], size: [20, 20, 10] },
    ]);
    expect(rep.suggestions.map((x) => x.owner)).toEqual(["a"]);
    expect(rep.suggestions[0]!.steps!.some((s) => s.focus !== undefined)).toBe(false);
  });

  const lidded = (extra: unknown[]) =>
    suggest({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "base", role: "body", at: [0, 0, 0], size: [100, 100, 40] },
            { id: "top", role: "cover", at: [0, 0, 40], size: [100, 100, 3] },
            ...extra,
          ],
        },
      ],
    }).suggestions[0]!.program.stages.map((x) => [x.label, x.direction]);

  test("a top cover keeps +z when nothing below it leaves later", () => {
    expect(lidded([{ id: "knob", at: [10, 10, 43], size: [10, 10, 10] }]).map((x) => x[1])).toEqual(
      ["+z", "+z"],
    );
    expect(lidded([])).toEqual([["Covers", "+z"]]);
  });

  test("a top cover over parts that leave later moves aside along its shorter side", () => {
    const st = lidded([{ id: "board", role: "internal", at: [10, 10, 10], size: [50, 50, 5] }]);
    expect(st).toEqual([
      ["Covers", "+x"],
      ["Internals", "away"],
    ]);
  });

  test("the cover keeps +z when something stands in the way beside it", () => {
    const st = lidded([
      { id: "board", role: "internal", at: [10, 10, 10], size: [50, 50, 5] },
      { id: "rail", at: [100, 0, 20], size: [10, 100, 40] },
      { id: "rail2", at: [0, 100, 20], size: [100, 10, 40] },
    ]);
    expect(st[0]![1]).toBe("+z");
  });
});
