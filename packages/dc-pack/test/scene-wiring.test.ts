/**
 * W-1 (Phase 2 wiring): core's scene draws a targeted rack as the assembly the DC pack builds,
 * through ONE planner shared with the spec assemblies and the close-up instances; slot close-ups
 * build in the scene; validation selects rack-program parts over the same tree the scene
 * resolves them over (assemblies.md 6.1, 8.1, 8.2, 8.4, 8.5).
 */
import { describe, expect, it } from "vitest";
import {
  AssemblyPrograms,
  buildScene,
  closeupDiagnostics,
  validate,
  type DcAssemblyPlanner,
  type Diagnostic,
  type PlatformCosmoSpec,
  type SceneAssembly,
  type SceneAssemblyNode,
  type SceneGraph,
} from "@platformcosmo/core";
import { dcPack, assemblyPlanner } from "../src/index.js";

type Json = Record<string, unknown>;
const spec = (extra: Json): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...extra }) as unknown as PlatformCosmoSpec;
const codes = (ds: readonly Diagnostic[], code: string): Diagnostic[] =>
  ds.filter((d) => d.code === code);
const errors = (ds: readonly Diagnostic[]): Diagnostic[] =>
  ds.filter((d) => d.severity === "error");

/** A 2U server board (mm): fits the 450 mm interior; `size` makes it oversize. */
const board = (size: number[] = [400, 500, 20]): Json => ({
  id: "board",
  template: true,
  units: "mm",
  parts: [
    { id: "pcb", at: [0, 0, 0], size: [size[0], size[1], 2] },
    { id: "cpu", type: "cpu", at: [50, 50, 2], size: [60, 60, size[2]] },
  ],
  programs: [{ id: "lift", stages: [{ parts: ["cpu"], direction: "up", distance: 40 }] }],
});

/** r1 (targeted) holds a server with internals and a ToR; r2 stays a 1.1 rack. */
const hall = (extra: Json = {}): PlatformCosmoSpec =>
  spec({
    assemblies: [board()],
    racks: [
      {
        id: "r1",
        slots: [
          { id: "srv", at: 1, type: "server-2u", assembly: "board" },
          { id: "tor", at: 10, type: "switch-tor" },
        ],
      },
      { id: "r2", slots: [{ id: "s", at: 1, type: "server-1u" }] },
    ],
    steps: [
      { duration: 4, assembly: [{ explode: "r1" }] },
      { duration: 4, assembly: [{ explode: "r1/srv" }] },
    ],
    ...extra,
  });

const scene = (s: PlatformCosmoSpec): SceneGraph => buildScene(s, { dc: dcPack });
const asmOf = (g: SceneGraph, id: string): SceneAssembly | undefined =>
  g.assemblies?.assemblies.find((a) => a.id === id);
const paths = (n: SceneAssemblyNode, out: string[] = []): string[] => {
  out.push(n.path);
  for (const c of n.children) paths(c, out);
  return out;
};
const ofRack = (ids: readonly string[], rack: string): string[] =>
  ids.filter((id) => id === rack || id === `${rack}_front` || id.startsWith(`${rack}/`));

describe("the scene draws a targeted rack as its assembly (R03)", () => {
  it("the rack's 1.1 objects leave; the other rack keeps them", () => {
    const g = scene(hall());
    expect(errors(g.diagnostics)).toEqual([]);
    const ids = g.objects.map((o) => o.id);
    expect(ofRack(ids, "r1")).toEqual([]);
    expect(ids).toContain("r2");
    expect(ids).toContain("r2/s");
    const r1 = asmOf(g, "r1");
    expect(r1?.source).toBe("dc");
    expect(asmOf(g, "r2")).toBeUndefined();
    // focus targets keep the 1.1 rack and slot boxes, and gain the assembly's paths
    expect(g.focusTargets["r1/srv"]).toBeDefined();
    expect(g.focusTargets["r1/frame/post-fl"]).toBeDefined();
  });

  it("slot internals exist in the scene: tray, lid and the template's parts", () => {
    const all = paths(asmOf(scene(hall()), "r1")!.root);
    for (const p of ["r1/frame/post-fl", "r1/srv/tray", "r1/srv/lid", "r1/srv/pcb", "r1/srv/cpu"]) {
      expect(all).toContain(p);
    }
    expect(all.some((p) => p.startsWith("r1/tor/"))).toBe(true);
  });

  it("rack actions plan in the scene's single step plan, with implicit access", () => {
    const g = scene(hall({ steps: [{ duration: 6, assembly: [{ explode: "r1/srv" }] }] }));
    const plan = g.assemblies!.plan;
    const a = plan[0]!.actions[0]!;
    expect(a).toMatchObject({ target: "r1/srv", program: "internals" });
    expect(a.implied).toEqual([{ program: "drawers", level: 2, only: ["r1/srv"] }]);
    // internals: the lid, then the template's one-stage default program
    expect(plan[0]!.poses["r1"]).toContainEqual({ program: "srv/internals", level: 2 });
    expect(codes(g.diagnostics, "assembly/implicit-access")).toHaveLength(1);
    // the scene bounds hold the drawer travel
    const r1 = asmOf(g, "r1")!;
    const y0 = (b: { origin: { y: number } }) => b.origin.y;
    expect(g.bounds.origin.y).toBeLessThanOrEqual(y0(r1.reachBounds) + 1e-9);
  });

  it("errors only the scene can find now surface: a slot moved below the floor", () => {
    const s = hall({
      racks: [
        {
          id: "r1",
          programs: [
            { id: "sink", stages: [{ parts: ["srv"], direction: "down", distance: 500 }] },
          ],
          slots: [{ id: "srv", at: 1, type: "server-2u" }],
        },
      ],
      steps: [{ assembly: [{ explode: "r1" }] }],
    });
    expect(codes(scene(s).diagnostics, "assembly/below-ground")).toHaveLength(1);
  });

  it("validate (closeupDiagnostics) reports the same below-ground for a rack without internals", () => {
    const s = spec({
      racks: [
        {
          id: "r1",
          programs: [
            { id: "sink", stages: [{ parts: ["srv"], direction: "down", distance: 500 }] },
          ],
          slots: [{ id: "srv", at: 1, type: "server-2u" }],
        },
      ],
      steps: [{ assembly: [{ explode: "r1" }] }],
    });
    const v = codes(closeupDiagnostics(s, { dc: dcPack }), "assembly/below-ground");
    expect(v.map((d) => d.path)).toEqual(["/racks/0/programs/0"]);
    expect(codes(scene(s).diagnostics, "assembly/below-ground")).toEqual(v);
  });

  it("a rack's reach growth points at the rack", () => {
    const s = spec({
      racks: [
        {
          id: "r1",
          programs: [{ id: "fly", stages: [{ parts: ["srv"], direction: "up", distance: 20000 }] }],
          slots: [{ id: "srv", at: 1, type: "server-2u" }],
        },
      ],
      steps: [{ assembly: [{ explode: "r1" }] }],
    });
    expect(codes(scene(s).diagnostics, "assembly/bounds-growth").map((d) => d.path)).toEqual([
      "/racks/0",
    ]);
  });

  it("raw input never throws: bad steps, actions and overrides", () => {
    const s = spec({
      racks: [
        {
          id: "r1",
          programs: [
            { id: "p", stages: [{ parts: ["srv"], direction: "up", overrides: null }, null] },
          ],
          slots: [{ id: "srv", at: 1, type: "server-2u" }],
        },
      ],
      steps: [null, { assembly: "x" }, { assembly: [null, 5, "explode", { explode: "r1" }] }],
    });
    // (the 1.1 hall layout reads steps for flows: it gets the clean spec)
    const frag = dcPack.buildScene({ ...s, steps: [] });
    expect(() => dcPack.buildAssembly!(s, "r1", frag, {})).not.toThrow();
    const r = dcPack.buildAssembly!(s, "r1", frag, {});
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([]);
    expect(r.assembly).toBeDefined();
  });

  it("a spec whose racks no action targets keeps every 1.1 object byte for byte", () => {
    const plain = spec({
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u" }] }],
    });
    const with12 = spec({
      assemblies: [board(), { id: "box", parts: [{ id: "b", size: [1, 1, 1] }] }],
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", assembly: "board" }] }],
      steps: [{ assembly: [{ explode: "box" }] }, { assembly: [{ explode: "r1/srv/closeup" }] }],
    });
    expect(JSON.stringify(scene(with12).objects)).toBe(JSON.stringify(scene(plain).objects));
    expect(asmOf(scene(with12), "r1")).toBeUndefined();
  });

  it("is deterministic", () => {
    expect(JSON.stringify(scene(hall()))).toBe(JSON.stringify(scene(hall())));
  });
});

describe("one planner per spec (R01, R02)", () => {
  const two = (): PlatformCosmoSpec =>
    spec({
      racks: [
        { id: "a1", slots: [{ id: "s", at: 1, type: "server-1u" }] },
        { id: "b1", slots: [{ id: "s", at: 1, type: "server-1u" }] },
      ],
      steps: [{ assembly: [{ explode: "a1" }, { explode: "b1", to: 1 }] }],
    });

  it("buildAssembly resolves through the planner it is given and registers each rack once", () => {
    const s = two();
    const real = new AssemblyPrograms(s);
    const registered: string[] = [];
    const shared: DcAssemblyPlanner = {
      registerSynthetic: (id, f) => {
        registered.push(id);
        real.registerSynthetic(id, f);
      },
      attach: (b) => real.attach(b),
      reach: (p) => real.reach(p),
    };
    const frag = dcPack.buildScene(s);
    const a1 = dcPack.buildAssembly!(s, "a1", frag, {}, shared).assembly!;
    const b1 = dcPack.buildAssembly!(s, "b1", frag, {}, shared).assembly!;
    expect(registered).toEqual(["a1", "b1"]);
    // one plan over both racks from the one planner
    const { plan } = real.plan([a1, b1], new Map(), [undefined]);
    expect(plan[0]!.actions.map((x) => [x.target, x.to])).toEqual([
      ["a1", 2],
      ["b1", 1],
    ]);
    // the same rack built alone (own planner) resolves to the same programs
    const alone = dcPack.buildAssembly!(s, "a1", frag, {}).assembly!;
    expect(JSON.stringify(alone.programs)).toBe(JSON.stringify(a1.programs));
  });

  it("the shared planner's diagnostics are not copied into the call's result", () => {
    const s = spec({
      racks: [
        {
          id: "r",
          // a role selector that the scene resolves twice: an info of the planner
          programs: [
            {
              id: "p",
              stages: [{ parts: ["frame/role:cover"] }, { parts: ["frame/role:cover"] }],
            },
          ],
          rearDoorHeatExchanger: true,
          slots: [{ id: "s", at: 1, type: "server-1u" }],
        },
      ],
      steps: [{ assembly: [{ explode: "r" }] }],
    });
    const frag = dcPack.buildScene(s);
    const own = dcPack.buildAssembly!(s, "r", frag, {});
    expect(codes(own.diagnostics, "assembly/moved-twice")).toHaveLength(1);
    const real = new AssemblyPrograms(s);
    const viaShared = dcPack.buildAssembly!(s, "r", frag, {}, real);
    expect(codes(viaShared.diagnostics, "assembly/moved-twice")).toEqual([]);
    expect(codes(real.diagnostics, "assembly/moved-twice")).toHaveLength(1);
    // the scene reports it exactly once
    expect(codes(scene(s).diagnostics, "assembly/moved-twice")).toHaveLength(1);
  });

  it("assemblyPlanner is keyed by rack id: a copy of the assembly works, every rack is merged", () => {
    const s = two();
    const frag = dcPack.buildScene(s);
    const a1 = dcPack.buildAssembly!(s, "a1", frag, {}).assembly!;
    const b1 = dcPack.buildAssembly!(s, "b1", frag, {}).assembly!;
    const copy = { ...a1, loopStart: { fades: [] } } as unknown as SceneAssembly;
    const planner = assemblyPlanner(s, copy);
    expect(planner).toBeDefined();
    const { plan } = planner!.plan([copy, b1], new Map(), [undefined]);
    expect(plan[0]!.actions.map((x) => [x.target, x.to])).toEqual([
      ["a1", 2],
      ["b1", 1],
    ]);
    expect(assemblyPlanner(spec({}), a1)).toBeUndefined();
  });
});

describe("slot close-ups build in the scene (8.4, 8.5)", () => {
  const withCloseup = (size: number[], extra: Json = {}): PlatformCosmoSpec =>
    spec({
      assemblies: [board(size)],
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", closeup: "board" }] }],
      steps: [{ focus: "r1/srv/closeup" }],
      ...extra,
    });

  it("an untargeted rack's slot hosts a level; a fitting template reports nothing", () => {
    const g = scene(withCloseup([400, 500, 20]));
    expect(g.assemblies?.levels?.map((l) => [l.path, l.host, l.turn, l.fit])).toEqual([
      ["r1/srv/closeup", "r1/srv", 0, 1],
    ]);
    expect(g.objects.some((o) => o.id === "r1/srv")).toBe(true);
    expect(codes(g.diagnostics, "assembly/size-mismatch")).toEqual([]);
  });

  it("an oversize template warns at the slot's closeup, in the scene and in validate", () => {
    const s = withCloseup([600, 500, 20]);
    const g = codes(scene(s).diagnostics, "assembly/size-mismatch");
    expect(g.map((d) => [d.severity, d.path])).toEqual([["warning", "/racks/0/slots/0/closeup"]]);
    const v = codes(closeupDiagnostics(s, { dc: dcPack }), "assembly/size-mismatch");
    expect(v).toEqual(g);
    // the interior is 450 mm wide, not the 540 mm device box
    expect(g[0]!.params).toMatchObject({ axis: "x" });
  });

  it("a slot in a mirrored row is turned to face -y", () => {
    const s = withCloseup([400, 500, 20], {
      racks: [
        { id: "r0" },
        { id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", closeup: "board" }] },
      ],
      rows: [
        { id: "ra", members: ["r0"] },
        { id: "rb", members: ["r1"] },
      ],
      aisles: [{ id: "c", kind: "cold", rows: ["ra", "rb"] }],
    });
    const levels = scene(s).assemblies?.levels ?? [];
    const turns = new Set(levels.map((l) => l.turn));
    // the row behind the cold aisle faces it: its front is -y, a half turn from the template's
    expect(levels.map((l) => l.path)).toEqual(["r1/srv/closeup"]);
    expect([...turns]).toEqual([180]);
  });

  it("a targeted rack's slot host follows the drawn device", () => {
    const s = withCloseup([400, 500, 20], {
      steps: [{ assembly: [{ explode: "r1" }] }, { focus: "r1/srv/closeup" }],
    });
    const g = scene(s);
    const level = g.assemblies!.levels!.find((l) => l.path === "r1/srv/closeup")!;
    const node = (function find(n: SceneAssemblyNode): SceneAssemblyNode | undefined {
      if (n.path === "r1/srv") return n;
      for (const c of n.children) {
        const f = find(c);
        if (f) return f;
      }
      return undefined;
    })(asmOf(g, "r1")!.root)!;
    expect(level.hostBox).toEqual(node.world);
  });
});

describe("slot internals exist only for a targeted rack (8.1, 8.2)", () => {
  const oversize = (targeted: boolean): PlatformCosmoSpec =>
    spec({
      assemblies: [board([700, 700, 40])],
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", assembly: "board" }] }],
      steps: [{ assembly: targeted ? [{ explode: "r1" }] : [] }],
    });

  it("an untargeted rack's oversize slot template is never built, so nothing is reported", () => {
    expect(codes(scene(oversize(false)).diagnostics, "assembly/size-mismatch")).toEqual([]);
    expect(closeupDiagnostics(oversize(false), { dc: dcPack })).toEqual([]);
  });

  it("targeted: the scene reports it once, as validate does", () => {
    const g = codes(scene(oversize(true)).diagnostics, "assembly/size-mismatch");
    expect(g.map((d) => d.path)).toEqual(["/racks/0/slots/0/assembly"]);
    expect(
      codes(closeupDiagnostics(oversize(true), { dc: dcPack }), "assembly/size-mismatch"),
    ).toEqual(g);
  });
});

describe("validate plans the racks with the assemblies (7.3 compression)", () => {
  it("a rack action compressed into a short step is reported by validate, not the scene", () => {
    const s = spec({
      racks: [{ id: "r1", slots: [1, 3, 5, 7, 9].map((at) => ({ at, type: "server-1u" })) }],
      steps: [{ duration: 1, assembly: [{ explode: "r1" }] }],
    });
    const v = codes(validate(s, { dc: dcPack }).diagnostics, "assembly/compressed");
    expect(v.map((d) => d.path)).toEqual(["/steps/0/assembly"]);
    expect(codes(scene(s).diagnostics, "assembly/compressed")).toEqual([]);
  });
});
