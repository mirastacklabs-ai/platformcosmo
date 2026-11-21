/**
 * `validate --suggest` on boards, owners without `at`, and mounted parts (assemblies.md 17):
 * fixtures from the D-3b skill E2E (a plan board, a 2U GPU server, an engine), programs removed.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      ["Covers", "+z", "auto", "show", "lid"],
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
      ["Covers (+z)", "+z", "auto", "show", "gasket,head,valve-cover"],
      ["Internals (level 1)", "+z", "auto", "show", "piston-*"],
      ["Internals (level 0)", "+z", 241.6, "show", "intake,exhaust,rod-*,crank"],
      ["Covers (-z, hidden side)", "-z", "auto", "show", "oil-pan"],
    ]);
    expect(rep.suggestions[0]!.program.stages.map((x) => x.stagger)).toEqual([0.08, 0.08, 0, 0.08]);
    const m = await mergedDiagnostics(spec, rep, "engine");
    expect(m).toEqual({ codes: [], vCode: 0, bCode: 0 });
  }, 120_000);
});
