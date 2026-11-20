import { describe, expect, it } from "vitest";
import { buildScene } from "@platformcosmo/core";
import type {
  Box3,
  DcSceneFragment,
  PlatformCosmoSpec,
  ResolvedExplodeProgram,
  SceneAssembly,
  SceneAssemblyNode,
} from "@platformcosmo/core";
import { registry as hwRegistry } from "@platformcosmo/parts-base";
import { dcPack } from "../src/index.js";
import { MAX_LEAVES } from "../src/assembly.js";

type Json = Record<string, unknown>;

const spec = (extra: Json): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...extra }) as unknown as PlatformCosmoSpec;

const build = (
  s: PlatformCosmoSpec,
  rackId: string,
  templates: Record<string, SceneAssemblyNode> = {},
): {
  assembly?: SceneAssembly;
  diagnostics: readonly { code: string; severity: string; path: string }[];
  frag: DcSceneFragment;
} => {
  const frag = dcPack.buildScene(s);
  const r = dcPack.buildAssembly!(s, rackId, frag, templates);
  return { ...r, frag };
};

const must = (a: SceneAssembly | undefined): SceneAssembly => {
  expect(a).toBeDefined();
  return a as SceneAssembly;
};

const find = (n: SceneAssemblyNode, path: string): SceneAssemblyNode | undefined => {
  if (n.path === path) return n;
  for (const c of n.children) {
    const f = find(c, path);
    if (f !== undefined) return f;
  }
  return undefined;
};

const program = (a: SceneAssembly, owner: string, id: string): ResolvedExplodeProgram => {
  const p = a.programs.find((x) => x.owner === owner && x.id === id);
  expect(p, `${owner}:${id}`).toBeDefined();
  return p as ResolvedExplodeProgram;
};

const MM = 600;
const end = (b: Box3, k: "x" | "y" | "z"): number => b.origin[k] + b.size[k];

const act = (target: string, kind = "explode", extra: Json = {}): Json => ({
  steps: [{ assembly: [{ [kind]: target, ...extra }] }],
});

const flat = (n: SceneAssemblyNode, out: SceneAssemblyNode[] = []): SceneAssemblyNode[] => {
  out.push(n);
  for (const c of n.children) flat(c, out);
  return out;
};

/** The resolved tree of `id`, built as an ordinary (non-template) copy: what `templates` carries. */
function template(s: PlatformCosmoSpec, id: string): SceneAssemblyNode {
  const base = (s.assemblies ?? []).find((a) => a.id === id)!;
  const twin = { ...base, id: `${id}-copy`, template: undefined };
  const g = buildScene(
    { ...s, assemblies: [...(s.assemblies ?? []), twin] } as unknown as PlatformCosmoSpec,
    { dc: dcPack, parts: hwRegistry },
  );
  return g.assemblies!.assemblies.find((a) => a.id === `${id}-copy`)!.root;
}

// ---------------------------------------------------------------------------------------------
// Fixtures: assemblies.md 19.1 and 19.4
// ---------------------------------------------------------------------------------------------

const loaded = (extra: Json = {}): PlatformCosmoSpec =>
  spec({
    racks: [
      {
        id: "r1",
        label: "Rack R1",
        u: 42,
        rearDoorHeatExchanger: true,
        slots: [
          { id: "tor", at: 41, type: "switch-tor", label: "ToR switch" },
          { id: "gpu", at: 30, type: "gpu-node", size: 4, label: "8-GPU node" },
          { id: "c1", at: 20, type: "server-2u", label: "Compute 1" },
          { id: "c2", at: 18, type: "server-2u", label: "Compute 2" },
          { id: "st", at: 10, type: "storage-flash", label: "Flash array" },
          { id: "pdu", at: 1, type: "pdu-1u", label: "PDU" },
        ],
        programs: [
          {
            id: "service",
            label: "Service view",
            stages: [
              { label: "Doors", parts: ["frame/role:cover"], direction: "drawer", labels: "hide" },
              {
                label: "Network and power",
                parts: ["tor", "pdu"],
                direction: "drawer",
                order: "top-down",
              },
              {
                label: "Compute and GPU",
                parts: ["type:server-2u", "gpu"],
                direction: "drawer",
                order: "top-down",
                stagger: 0.15,
              },
              { label: "Storage", parts: ["st"], direction: "drawer", details: true },
            ],
          },
        ],
      },
    ],
    steps: [
      { caption: "Rack R1, fully loaded", duration: 2 },
      { assembly: [{ explode: "r1", program: "service", to: 2 }], focus: "r1", duration: 4 },
      { assembly: [{ explode: "r1", program: "service" }], focus: "r1", duration: 5 },
      { assembly: [{ implode: "r1" }], duration: 4 },
    ],
    ...extra,
  });

const internalsTemplate = (): Json => ({
  id: "srv-internals",
  template: true,
  units: "mm",
  parts: [
    {
      id: "board",
      shape: "hw:board",
      at: [10, 260, 0],
      size: [418, 400, 12],
      label: "Motherboard",
    },
    {
      id: "cpu",
      type: "cpu",
      shape: "hw:heatsink",
      count: 2,
      at: [70, 430, 3],
      pitch: [200, 0, 0],
      size: [90, 90, 50],
      label: "CPU and cooler",
    },
    {
      id: "dimm",
      type: "dimm",
      shape: "hw:dimm",
      count: 8,
      at: [175, 410, 3],
      pitch: [11, 0, 0],
      rotate: 90,
      size: [133, 7, 31],
      label: "DIMM",
    },
    {
      id: "fan",
      type: "fan",
      shape: "hw:fan",
      count: 5,
      at: [20, 200, 0],
      pitch: [80, 0, 0],
      size: [62, 40, 60],
      label: "Fan",
    },
    { id: "psu", type: "psu", shape: "hw:psu", at: [0, 0, 0], size: [85, 190, 40], label: "PSU" },
  ],
  programs: [
    {
      id: "internals",
      stages: [
        { label: "Fans and PSU", parts: ["type:fan", "type:psu"], direction: "up" },
        {
          label: "CPUs and memory",
          parts: ["type:cpu", "type:dimm"],
          direction: "lift",
          details: true,
        },
      ],
    },
  ],
});

const nested = (rackExtra: Json = {}, tpl: Json = internalsTemplate()): PlatformCosmoSpec =>
  spec({
    assemblies: [tpl],
    racks: [
      {
        id: "r1",
        label: "Rack R1",
        slots: [
          { id: "tor", at: 41, type: "switch-tor", label: "ToR" },
          { id: "srv", at: 20, type: "server-2u", label: "App server", assembly: "srv-internals" },
          { id: "db", at: 16, type: "server-2u", label: "DB server" },
        ],
        ...rackExtra,
      },
    ],
    steps: [
      { caption: "Rack R1", duration: 2 },
      { assembly: [{ explode: "r1", to: 2 }], focus: "r1/srv", duration: 4 },
      { assembly: [{ explode: "r1/srv", to: 2 }], focus: "r1/srv", duration: 4 },
      { assembly: [{ explode: "r1/srv" }], focus: "r1/srv/cpu-1", duration: 4 },
      { assembly: [{ implode: "r1/srv" }, { implode: "r1" }], duration: 5 },
    ],
  });

const nestedBuild = (
  rackExtra: Json = {},
  tpl: Json = internalsTemplate(),
): ReturnType<typeof build> => {
  const s = nested(rackExtra, tpl);
  return build(s, "r1", { "srv-internals": template(s, "srv-internals") });
};

/** Two facing rows around a cold aisle: one row is mirrored (front toward -y). */
const hall = (): PlatformCosmoSpec =>
  spec({
    racks: [
      {
        id: "a1",
        slots: [
          { at: 1, type: "switch-tor", id: "tor" },
          { at: 2, type: "server-1u" },
        ],
      },
      {
        id: "b1",
        u: 48,
        rearDoorHeatExchanger: true,
        slots: [
          { at: 1, type: "server-2u", id: "s" },
          { at: 10, type: "gpu-node", id: "g" },
        ],
      },
    ],
    rows: [
      { id: "row-a", members: ["a1"] },
      { id: "row-b", members: ["b1"] },
    ],
    aisles: [{ id: "cold-1", kind: "cold", rows: ["row-a", "row-b"] }],
    steps: [{ assembly: [{ explode: "a1" }, { explode: "b1" }] }],
  });

// ---------------------------------------------------------------------------------------------

describe("assembly mode only for targeted racks", () => {
  it("builds nothing for a rack no step action targets", () => {
    const s = loaded();
    const r = dcPack.buildAssembly!(s, "r1", dcPack.buildScene(s), {});
    expect(r.assembly).toBeDefined();
    const idle = spec({ racks: [{ id: "r1", slots: [{ at: 1, type: "server-1u" }] }] });
    const none = dcPack.buildAssembly!(idle, "r1", dcPack.buildScene(idle), {});
    expect(none).toEqual({ diagnostics: [] });
  });

  it("builds only the targeted rack of several", () => {
    const s = spec({
      racks: [{ id: "a" }, { id: "b" }],
      steps: [{ assembly: [{ explode: "b" }] }],
    });
    expect(build(s, "a").assembly).toBeUndefined();
    expect(build(s, "b").assembly?.id).toBe("b");
  });

  it("a nested target (rack/slot/part) targets the rack; a longer id with the same prefix does not", () => {
    const base = { racks: [{ id: "r1", slots: [{ at: 1, type: "server-1u", id: "s" }] }] };
    expect(build(spec({ ...base, ...act("r1/s") }), "r1").assembly).toBeDefined();
    expect(build(spec({ ...base, ...act("r1/s/fan-1", "implode") }), "r1").assembly).toBeDefined();
    expect(build(spec({ ...base, ...act("r10") }), "r1").assembly).toBeUndefined();
    expect(build(spec({ ...base, ...act("r1x/s") }), "r1").assembly).toBeUndefined();
  });

  it("every action kind targets", () => {
    for (const kind of ["explode", "implode", "build", "unbuild"]) {
      const s = spec({ racks: [{ id: "r1" }], ...act("r1", kind) });
      expect(build(s, "r1").assembly, kind).toBeDefined();
    }
  });

  it("unknown racks and specs without racks return no assembly and no diagnostics", () => {
    const s = spec({ racks: [{ id: "r1" }], ...act("r1") });
    expect(build(s, "nope")).toMatchObject({ diagnostics: [] });
    expect(build(spec({ nodes: [] }), "r1").assembly).toBeUndefined();
  });

  it("does not change the scene fragment", () => {
    const s = loaded();
    const frag = dcPack.buildScene(s);
    const before = JSON.stringify(frag);
    dcPack.buildAssembly!(s, "r1", frag, {});
    expect(JSON.stringify(frag)).toBe(before);
    expect(JSON.stringify(dcPack.buildScene(s))).toBe(before);
  });
});

describe("rack tree (loaded rack, assemblies.md 19.1)", () => {
  const { assembly, diagnostics, frag } = build(loaded(), "r1");
  const a = must(assembly);

  it("is a dc assembly at true scale", () => {
    expect(diagnostics).toEqual([]);
    expect(a.id).toBe("r1");
    expect(a.source).toBe("dc");
    expect(a.label).toBe("Rack R1");
    expect(a.root.path).toBe("r1");
    expect(a.frame.units).toBe("mm");
    expect(a.frame.rotate).toBe(0);
    expect(a.frame.scale.x).toBeCloseTo(1 / 600, 12);
    expect(a.frame.front).toBe("+y");
  });

  it("has frame leaves and one sub-assembly per slot, no _front shell", () => {
    expect(a.root.children.map((c) => c.id)).toEqual([
      "frame",
      "tor",
      "gpu",
      "c1",
      "c2",
      "st",
      "pdu",
    ]);
    const frame = a.root.children[0]!;
    expect(frame.kind).toBe("sub");
    expect(frame.children.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "base",
        "post-bl",
        "post-br",
        "post-fl",
        "post-fr",
        "top",
        "top-b",
        "pdu-a",
        "pdu-b",
      ]),
    );
    expect(flat(a.root).some((n) => n.id.includes("_front"))).toBe(false);
    for (const id of ["tor", "gpu", "c1", "c2", "st", "pdu"]) {
      const slot = a.root.children.find((c) => c.id === id)!;
      expect(slot.kind).toBe("sub");
      expect(slot.path).toBe(`r1/${id}`);
      expect(slot.children.length).toBeGreaterThan(3);
    }
    expect(a.root.children.find((c) => c.id === "gpu")!.type).toBe("gpu-node");
    expect(a.root.children.find((c) => c.id === "gpu")!.label).toBe("8-GPU node");
  });

  it("roles: posts and rails are shell, the rear door is cover, chassis is shell", () => {
    const n = (p: string): SceneAssemblyNode => find(a.root, p)!;
    expect(n("r1/frame/post-fl").role).toBe("shell");
    expect(n("r1/frame/top").role).toBe("shell");
    expect(n("r1/frame/rear-door").role).toBe("cover");
    expect(n("r1/frame/rear-door/left").role).toBe("cover");
    expect(n("r1/c1/chassis").role).toBe("shell");
    expect(n("r1/c1/front").role).toBe("body");
  });

  it("leaves lists every leaf, depth first, each a real leaf with geometry", () => {
    const leaves = flat(a.root).filter((n) => n.kind === "leaf");
    expect(a.leaves).toEqual(leaves.map((n) => n.path));
    expect(new Set(a.leaves).size).toBe(a.leaves.length);
    for (const l of leaves) {
      expect(l.geometry?.primitives.length).toBeGreaterThan(0);
      expect(l.children).toEqual([]);
    }
  });

  it("slot sub-assemblies sit where the 1.1 slot objects are", () => {
    for (const id of ["tor", "gpu", "c1", "c2", "st", "pdu"]) {
      const obj = frag.objects.find((o) => o.id === `r1/${id}`)!;
      const sub = find(a.root, `r1/${id}`)!;
      for (const k of ["x", "y", "z"] as const) {
        expect(sub.world.origin[k]).toBeCloseTo(obj.box.origin[k], 3);
        expect(sub.world.size[k]).toBeCloseTo(obj.box.size[k], 3);
      }
    }
    const rack = frag.objects.find((o) => o.id === "r1")!;
    for (const k of ["x", "y", "z"] as const) {
      expect(a.restBounds.origin[k]).toBeCloseTo(rack.box.origin[k], 3);
      expect(a.restBounds.size[k]).toBeCloseTo(rack.box.size[k], 3);
    }
  });

  it("true scale: a 2U server is 540 x 780 x 87 mm", () => {
    const c1 = find(a.root, "r1/c1")!;
    expect(c1.world.size.x * MM).toBeCloseTo(540, 1);
    expect(c1.world.size.y * MM).toBeCloseTo(780, 1);
    expect(c1.world.size.z * MM).toBeCloseTo(2 * 44.45 - 1.5, 1);
  });

  it("slots keep their rack-unit order and the 1U slot of the PDU is at the bottom", () => {
    const z = (id: string): number => find(a.root, `r1/${id}`)!.world.origin.z;
    expect(z("tor")).toBeGreaterThan(z("gpu"));
    expect(z("gpu")).toBeGreaterThan(z("c1"));
    expect(z("c1")).toBeGreaterThan(z("c2"));
    expect(z("c2")).toBeGreaterThan(z("st"));
    expect(z("st")).toBeGreaterThan(z("pdu"));
  });

  it("is deterministic (byte-identical JSON)", () => {
    const again = build(loaded(), "r1");
    expect(JSON.stringify(again.assembly)).toBe(JSON.stringify(assembly));
    expect(JSON.stringify(again.diagnostics)).toBe(JSON.stringify(diagnostics));
  });
});

describe("mirrored fronts", () => {
  const s = hall();
  const frag = dcPack.buildScene(s);
  const a1 = must(dcPack.buildAssembly!(s, "a1", frag, {}).assembly);
  const b1 = must(dcPack.buildAssembly!(s, "b1", frag, {}).assembly);
  const mirrored = [a1, b1].filter((a) => a.frame.front === "-y");
  const upright = [a1, b1].filter((a) => a.frame.front === "+y");

  it("one row of two facing rows is mirrored", () => {
    expect(mirrored).toHaveLength(1);
    expect(upright).toHaveLength(1);
  });

  it("every slot and the rack frame match the 1.1 objects in both orientations", () => {
    for (const a of [a1, b1]) {
      for (const slot of a.root.children.filter((c) => c.id !== "frame")) {
        const obj = frag.objects.find((o) => o.id === slot.path)!;
        for (const k of ["x", "y", "z"] as const) {
          expect(slot.world.origin[k]).toBeCloseTo(obj.box.origin[k], 3);
          expect(slot.world.size[k]).toBeCloseTo(obj.box.size[k], 3);
        }
      }
      const rack = frag.objects.find((o) => o.id === a.id)!;
      expect(a.restBounds.origin.y).toBeCloseTo(rack.box.origin.y, 3);
      expect(a.restBounds.size.y).toBeCloseTo(rack.box.size.y, 3);
    }
  });

  it("the device front is toward the rack front in both orientations", () => {
    for (const a of [a1, b1]) {
      const slot = a.root.children.find((c) => c.id !== "frame")!;
      const front = slot.children.find((c) => c.id === "front")!;
      const chassis = slot.children.find((c) => c.id === "chassis")!;
      const f = front.world.origin.y + front.world.size.y / 2;
      const c = chassis.world.origin.y + chassis.world.size.y / 2;
      // front plate lies on the front side of the chassis centre
      expect(a.frame.front === "+y" ? f > c : f < c).toBe(true);
    }
  });

  it("the drawer slides toward the world front (-y when mirrored) and clears the front plane", () => {
    for (const a of [a1, b1]) {
      const sign = a.frame.front === "+y" ? 1 : -1;
      const drawers = program(a, a.id, "drawers");
      for (const m of drawers.stages[1]!.moves) {
        expect(Math.sign(m.offset.y)).toBe(sign);
        expect(m.offset.x).toBe(0);
        expect(m.offset.z).toBe(0);
        const slot = find(a.root, m.path)!;
        if (sign === 1)
          expect(slot.world.origin.y + m.offset.y).toBeGreaterThanOrEqual(end(a.restBounds, "y"));
        else expect(end(slot.world, "y") + m.offset.y).toBeLessThanOrEqual(a.restBounds.origin.y);
      }
    }
  });
});

describe("the drawers program", () => {
  const a = must(build(hall(), "b1").assembly);
  const p = program(a, "b1", "drawers");
  const front = a.frame.front === "+y" ? 1 : -1;
  const ownerExtent = Math.max(...[a.root.local.size.x, a.root.local.size.y, a.root.local.size.z]);

  it("is the default program with two stages, doors then every slot", () => {
    expect(a.defaultProgram).toBe("drawers");
    expect(a.programs.filter((x) => x.owner === "b1").map((x) => x.id)).toEqual(["drawers"]);
    expect(p.kind).toBe("explode");
    expect(p.stages).toHaveLength(2);
    expect(p.stages[0]!.label).toBe("Doors");
    expect(p.stages[0]!.labels).toBe("hide");
    expect(p.stages[1]!.moves.map((m) => m.path).sort()).toEqual(["b1/g", "b1/s"]);
  });

  it("stage 1 moves the rear-door heat exchanger as one unit toward the rear, clear of the rack", () => {
    const moves = p.stages[0]!.moves;
    expect(moves.map((m) => m.path)).toEqual(["b1/frame/rear-door"]);
    const m = moves[0]!;
    expect(Math.sign(m.offset.y)).toBe(-front);
    const door = find(a.root, "b1/frame/rear-door")!;
    if (front === 1)
      expect(end(door.world, "y") + m.offset.y).toBeLessThanOrEqual(a.restBounds.origin.y);
    else expect(door.world.origin.y + m.offset.y).toBeGreaterThanOrEqual(end(a.restBounds, "y"));
  });

  it("a rack without a heat exchanger has an empty doors stage and no diagnostics", () => {
    const r = build(hall(), "a1");
    const d = program(r.assembly!, "a1", "drawers");
    expect(d.stages[0]!.moves).toEqual([]);
    expect(d.stages[0]!.start).toBe(0);
    expect(d.stages[0]!.end).toBe(0);
    expect(r.diagnostics).toEqual([]);
  });

  it("each slot leaves the rack completely: owner front - slot back + 10% of the rack's extent", () => {
    const gap = ownerExtent * 0.1;
    for (const m of p.stages[1]!.moves) {
      const slot = find(a.root, m.path)!;
      const lo = front === 1 ? slot.local.origin.y : -(slot.local.origin.y + slot.local.size.y);
      const ownerHi =
        front === 1 ? a.root.local.origin.y + a.root.local.size.y : -a.root.local.origin.y;
      expect(Math.abs(m.offset.y) * MM).toBeCloseTo(ownerHi - lo + gap, 3);
    }
  });

  it("slots start top-down, 0.1 s apart, after the doors", () => {
    const moves = [...p.stages[1]!.moves].sort((x, y) => x.start - y.start);
    const z = (path: string): number =>
      find(a.root, path)!.world.origin.z + find(a.root, path)!.world.size.z;
    expect(z(moves[0]!.path)).toBeGreaterThan(z(moves[1]!.path));
    expect(moves[1]!.start - moves[0]!.start).toBeCloseTo(0.1, 6);
    expect(moves[0]!.start).toBeCloseTo(p.stages[0]!.end, 6);
    expect(p.stages[1]!.start).toBeCloseTo(p.stages[0]!.end, 6);
    expect(p.stages[1]!.end).toBeCloseTo(moves[1]!.start + moves[1]!.duration, 6);
    expect(moves[0]!.easing).toBe("ease-in-out");
  });

  it("a slot's move is its own: moving one slot never moves another (implicit access)", () => {
    const n = nestedBuild();
    const d = program(n.assembly!, "r1", "drawers");
    const own = d.stages[1]!.moves.filter((m) => m.path === "r1/srv");
    expect(own).toHaveLength(1);
    expect(d.stages[1]!.moves.map((m) => m.path).sort()).toEqual(["r1/db", "r1/srv", "r1/tor"]);
    expect(new Set(d.stages[1]!.moves.map((m) => m.path)).size).toBe(3);
    // the access move is the slot's drawer alone; the internals program moves nothing of the rack
    const inner = program(n.assembly!, "r1/srv", "internals");
    const paths = new Set(inner.stages.flatMap((s) => s.moves.map((m) => m.path)));
    expect([...paths].every((p) => p.startsWith("r1/srv/"))).toBe(true);
  });

  it("the doors and drawer moves are in world tiles", () => {
    for (const m of p.stages[1]!.moves) {
      const slot = find(a.root, m.path)!;
      // world and local boxes agree up to the 1/600 scale: a move of n tiles is n * 600 mm
      expect(Math.abs(m.offset.y)).toBeGreaterThan(slot.world.size.y);
    }
  });
});

describe("custom rack programs (assemblies.md 19.1)", () => {
  const { assembly, diagnostics } = build(loaded(), "r1");
  const a = must(assembly);

  it("replace the built-in program", () => {
    expect(a.programs.map((p) => `${p.owner}:${p.id}`)).toEqual(["r1:service"]);
    expect(a.defaultProgram).toBe("service");
    expect(diagnostics).toEqual([]);
  });

  it("resolve slot ids, type: and frame/role:cover selectors", () => {
    const p = program(a, "r1", "service");
    expect(p.stages).toHaveLength(4);
    expect(p.stages[0]!.moves.map((m) => m.path)).toEqual(["r1/frame/rear-door"]);
    expect(p.stages[1]!.moves.map((m) => m.path).sort()).toEqual(["r1/pdu", "r1/tor"]);
    expect(p.stages[2]!.moves.map((m) => m.path).sort()).toEqual(["r1/c1", "r1/c2", "r1/gpu"]);
    expect(p.stages[3]!.moves.map((m) => m.path)).toEqual(["r1/st"]);
    expect(p.stages[3]!.details).toBe(true);
  });

  it("stages follow one another and stagger by their own settings", () => {
    const p = program(a, "r1", "service");
    for (let i = 1; i < p.stages.length; i++) {
      expect(p.stages[i]!.start).toBeCloseTo(p.stages[i - 1]!.end, 6);
    }
    const s3 = [...p.stages[2]!.moves].sort((x, y) => x.start - y.start);
    expect(s3[1]!.start - s3[0]!.start).toBeCloseTo(0.15, 6);
    expect(s3[2]!.start - s3[1]!.start).toBeCloseTo(0.15, 6);
  });

  it("selector-empty, moved-twice and ignored malformed selectors", () => {
    const s = loaded({});
    (s.racks![0] as unknown as Json)["programs"] = [
      {
        id: "p",
        stages: [
          { parts: ["nope"], direction: "drawer" },
          { parts: ["c1"], direction: "drawer" },
          { parts: ["c1", "c1//x", ""], direction: "up", distance: 10 },
        ],
      },
    ];
    const r = build(s, "r1");
    const codes = r.diagnostics.map((d) => `${d.severity}:${d.code}:${d.path}`);
    expect(codes).toContain("warning:assembly/selector-empty:/racks/0/programs/0/stages/0/parts");
    expect(codes).toContain("error:assembly/moved-twice:/racks/0/programs/0/stages/2/parts");
  });

  it("direction, number distances, except and overrides", () => {
    const s = spec({
      racks: [
        {
          id: "r",
          slots: [
            { id: "a", at: 5, type: "server-1u" },
            { id: "b", at: 7, type: "server-1u" },
            { id: "c", at: 9, type: "server-1u" },
          ],
          programs: [
            {
              id: "p",
              stages: [
                {
                  parts: ["type:server-1u"],
                  except: ["c"],
                  direction: "up",
                  distance: 100,
                  order: "bottom-up",
                  stagger: 0.5,
                  overrides: { b: { distance: 250, delay: 1 }, a: { order: 5 } },
                },
                { parts: ["c"], direction: [1, 0, 0], distance: 60, with: "previous", delay: 0.25 },
              ],
            },
          ],
        },
      ],
      ...act("r"),
    });
    const r = build(s, "r");
    expect(r.diagnostics).toEqual([]);
    const p = program(r.assembly!, "r", "p");
    const m = (path: string) => p.stages.flatMap((st) => st.moves).find((x) => x.path === path)!;
    expect(m("r/a").offset.z * MM).toBeCloseTo(100, 6);
    expect(m("r/b").offset.z * MM).toBeCloseTo(250, 6);
    expect(m("r/c").offset.x * MM).toBeCloseTo(60, 6);
    // a has override order 5, so b ranks first: b starts at its delay, a half a second later
    expect(m("r/b").start).toBeCloseTo(1, 6);
    expect(m("r/a").start).toBeCloseTo(0.5, 6);
    // `with: previous` starts together with stage 1, plus its own delay
    expect(m("r/c").start).toBeCloseTo(0.25, 6);
    expect(p.stages[1]!.start).toBeCloseTo(0.25, 6);
  });

  it("auto distances stack so that two movers over each other end a gap apart", () => {
    const s = spec({
      racks: [
        {
          id: "r",
          slots: [
            { id: "lo", at: 5, type: "server-1u" },
            { id: "hi", at: 6, type: "server-1u" },
          ],
          programs: [{ id: "p", gap: 20, stages: [{ parts: ["lo", "hi"], direction: "up" }] }],
        },
      ],
      ...act("r"),
    });
    const r = build(s, "r");
    const p = program(r.assembly!, "r", "p");
    const lo = find(r.assembly!.root, "r/lo")!;
    const hi = find(r.assembly!.root, "r/hi")!;
    const dz = (path: string): number =>
      p.stages[0]!.moves.find((x) => x.path === path)!.offset.z * MM;
    const hiBottom = hi.local.origin.z + dz("r/hi");
    const loTop = lo.local.origin.z + lo.local.size.z + dz("r/lo");
    const rackTop = find(r.assembly!.root, "r/frame/top")!.local;
    // the lower slot is inner and clears the rack's top rails; the upper one ends a gap above it
    expect(lo.local.origin.z + dz("r/lo")).toBeGreaterThanOrEqual(end(rackTop, "z") + 20 - 1e-6);
    expect(hiBottom).toBeGreaterThanOrEqual(loTop + 20 - 1e-6);
    expect(hiBottom).toBeLessThanOrEqual(loTop + 20 + 1e-6);
  });
});

describe("a drawer clears the front plane even with no gap", () => {
  it("a shallow device (450 mm deep, 720 mm from the rack front) still leaves the rack", () => {
    for (const rows of [false, true]) {
      const s = spec({
        racks: [
          {
            id: "r",
            slots: [{ id: "tor", at: 20, type: "switch-tor" }],
            programs: [{ id: "p", gap: 0, stages: [{ parts: ["tor"], direction: "drawer" }] }],
          },
          { id: "other" },
        ],
        ...(rows
          ? {
              rows: [
                { id: "ra", members: ["r"] },
                { id: "rb", members: ["other"] },
              ],
              aisles: [{ id: "c", kind: "cold", rows: ["ra", "rb"] }],
            }
          : {}),
        ...act("r"),
      });
      const a = build(s, "r").assembly!;
      const tor = find(a.root, "r/tor")!;
      const m = program(a, "r", "p").stages[0]!.moves[0]!;
      if (a.frame.front === "+y") {
        expect(tor.world.origin.y + m.offset.y).toBeGreaterThanOrEqual(
          end(a.restBounds, "y") - 1e-6,
        );
      } else {
        expect(end(tor.world, "y") + m.offset.y).toBeLessThanOrEqual(a.restBounds.origin.y + 1e-6);
      }
    }
  });
});

describe("below-floor error", () => {
  const down = (distance: number, at = 1): PlatformCosmoSpec =>
    spec({
      racks: [
        {
          id: "r",
          slots: [{ id: "a", at, type: "server-1u" }],
          programs: [{ id: "p", stages: [{ parts: ["a"], direction: "down", distance }] }],
        },
      ],
      ...act("r"),
    });

  it("a slot moved below the floor is an error and builds no assembly", () => {
    const r = build(down(80), "r");
    expect(r.assembly).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "assembly/below-ground",
      path: "/racks/0/programs/0",
    });
  });

  it("the boundary: U1 sits 50 mm above the floor", () => {
    expect(build(down(49.9), "r").assembly).toBeDefined();
    expect(build(down(50.1), "r").assembly).toBeUndefined();
    expect(build(down(50.1, 20), "r").assembly).toBeDefined();
  });

  it("covers moves of a part inside a moved sub-assembly and the lid of internals", () => {
    const s = nested({
      programs: [{ id: "p", stages: [{ parts: ["db"], direction: "down", distance: 40 }] }],
    });
    const r = build(s, "r1", { "srv-internals": template(s, "srv-internals") });
    expect(r.assembly).toBeDefined(); // db at U16 is far above the floor
    const s2 = nested({
      programs: [{ id: "p", stages: [{ parts: ["db"], direction: "down", distance: 1e5 }] }],
    });
    const r2 = build(s2, "r1", { "srv-internals": template(s2, "srv-internals") });
    expect(r2.assembly).toBeUndefined();
    expect(r2.diagnostics.map((d) => d.code)).toContain("assembly/below-ground");
  });
});

describe("reserved ids", () => {
  it("a slot named frame is an error at its id and is left out of the tree", () => {
    const s = spec({
      racks: [
        {
          id: "r",
          slots: [
            { id: "frame", at: 1, type: "server-1u" },
            { id: "ok", at: 3, type: "server-1u" },
          ],
        },
      ],
      ...act("r"),
    });
    const r = build(s, "r");
    expect(r.diagnostics).toMatchObject([
      { severity: "error", code: "assembly/reserved-id", path: "/racks/0/slots/0/id" },
    ]);
    const a = must(r.assembly);
    expect(a.root.children.map((c) => c.id)).toEqual(["frame", "ok"]);
    // the frame is the pack's, not the slot's
    expect(find(a.root, "r/frame/post-fl")).toBeDefined();
    expect(find(a.root, "r/frame/chassis")).toBeUndefined();
  });

  it("has no effect on a rack that is not in assembly mode", () => {
    const s = spec({ racks: [{ id: "r", slots: [{ id: "frame", at: 1, type: "server-1u" }] }] });
    const f = dcPack.buildScene(s);
    expect(f.diagnostics).toEqual([]);
    expect(f.objects.some((o) => o.id === "r/frame")).toBe(true);
    expect(dcPack.buildAssembly!(s, "r", f, {})).toEqual({ diagnostics: [] });
  });

  it("template parts named like the pack's parts of a slot (tray, lid, faceplate, rear) are rejected", () => {
    for (const id of ["tray", "lid", "faceplate", "rear"]) {
      const tpl = {
        id: "t",
        template: true,
        parts: [{ id, at: [0, 0, 0], size: [10, 10, 10] }],
      };
      const s = spec({
        assemblies: [tpl],
        racks: [{ id: "r", slots: [{ id: "s", at: 1, type: "server-2u", assembly: "t" }] }],
        ...act("r"),
      });
      const r = build(s, "r", { t: template(s, "t") });
      expect(r.diagnostics.map((d) => d.code)).toEqual(["assembly/duplicate-part"]);
      expect(r.diagnostics[0]!.path).toBe("/racks/0/slots/0/assembly");
      // the slot is still a plain device
      expect(find(r.assembly!.root, "r/s/chassis")).toBeDefined();
      expect(find(r.assembly!.root, "r/s/lid")).toBeUndefined();
    }
  });
});

describe("slot internals (rack -> server -> internals, assemblies.md 19.4)", () => {
  const { assembly, diagnostics } = nestedBuild();
  const a = must(assembly);
  const srv = find(a.root, "r1/srv")!;

  it("builds without diagnostics", () => {
    expect(diagnostics).toEqual([]);
  });

  it("the device is tray + lid + faceplate + rear plus the template's parts, no chassis", () => {
    expect(srv.children.map((c) => c.id)).toEqual([
      "rear",
      "tray",
      "board",
      "cpu-1",
      "cpu-2",
      "dimm-1",
      "dimm-2",
      "dimm-3",
      "dimm-4",
      "dimm-5",
      "dimm-6",
      "dimm-7",
      "dimm-8",
      "fan-1",
      "fan-2",
      "fan-3",
      "fan-4",
      "fan-5",
      "psu",
      "lid",
      "faceplate",
    ]);
    expect(find(a.root, "r1/srv/chassis")).toBeUndefined();
    expect(find(a.root, "r1/srv/lid")!.role).toBe("cover");
    expect(find(a.root, "r1/srv/lid")!.mates).toBe("r1/srv/tray");
    expect(find(a.root, "r1/srv/tray")!.geometry!.solid).toBe(false);
    expect(find(a.root, "r1/srv/faceplate/front")).toBeDefined();
    expect(srv.type).toBe("server-2u");
    expect(srv.label).toBe("App server");
    // a slot without `assembly` is a plain device
    expect(find(a.root, "r1/db/chassis")).toBeDefined();
  });

  it("template paths are rebased under the slot and keep their types, labels and geometry", () => {
    const cpu = find(a.root, "r1/srv/cpu-1")!;
    expect(cpu.type).toBe("cpu");
    expect(cpu.label).toBe("CPU and cooler");
    expect(cpu.geometry!.primitives.length).toBeGreaterThan(1);
    for (const n of flat(srv)) expect(n.path.startsWith("r1/srv")).toBe(true);
    expect(a.leaves.filter((l) => l.startsWith("r1/srv/")).length).toBe(
      flat(srv).filter((n) => n.kind === "leaf").length,
    );
  });

  it("the template is at true scale and sits inside the tray", () => {
    const tray = find(a.root, "r1/srv/tray")!;
    const board = find(a.root, "r1/srv/board")!;
    expect(board.local.size.x).toBeCloseTo(418, 3);
    expect(board.local.size.y).toBeCloseTo(400, 3);
    expect(board.world.size.x * MM).toBeCloseTo(418, 2);
    for (const l of flat(srv).filter(
      (n) =>
        n.kind === "leaf" &&
        !["tray", "lid"].includes(n.id) &&
        !n.path.includes("/faceplate/") &&
        !n.path.includes("/rear/"),
    )) {
      for (const k of ["x", "y", "z"] as const) {
        expect(l.world.origin[k]).toBeGreaterThanOrEqual(tray.world.origin[k] - 1e-6);
        expect(end(l.world, k)).toBeLessThanOrEqual(end(tray.world, k) + 1e-6);
      }
    }
    // the lid is on top of the tray
    const lid = find(a.root, "r1/srv/lid")!;
    expect(lid.world.origin.z).toBeCloseTo(end(tray.world, "z"), 6);
  });

  it("the slot's own program is internals: lid up, then the template's two stages", () => {
    const p = program(a, "r1/srv", "internals");
    expect(p.stages).toHaveLength(3);
    expect(p.stages.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(p.stages[0]!.moves.map((m) => m.path)).toEqual(["r1/srv/lid"]);
    const up = p.stages[0]!.moves[0]!.offset;
    expect(up.x).toBe(0);
    expect(up.y).toBe(0);
    expect(up.z).toBeGreaterThan(0);
    const names = (i: number): string[] =>
      p.stages[i]!.moves.map((m) => m.path.slice("r1/srv/".length)).sort();
    expect(names(1)).toEqual(["fan-1", "fan-2", "fan-3", "fan-4", "fan-5", "psu"]);
    expect(names(2)).toEqual([
      "cpu-1",
      "cpu-2",
      "dimm-1",
      "dimm-2",
      "dimm-3",
      "dimm-4",
      "dimm-5",
      "dimm-6",
      "dimm-7",
      "dimm-8",
    ]);
    expect(p.stages[2]!.details).toBe(true);
    for (let i = 1; i < 3; i++)
      expect(p.stages[i]!.start).toBeGreaterThanOrEqual(p.stages[i - 1]!.end - 1e-9);
  });

  it("the lid clears every pose of the internals", () => {
    const p = program(a, "r1/srv", "internals");
    const lid = find(a.root, "r1/srv/lid")!;
    const lidTop = lid.world.origin.z + p.stages[0]!.moves[0]!.offset.z;
    let top = 0;
    for (const st of p.stages.slice(1)) {
      for (const m of st.moves) {
        const n = find(a.root, m.path)!;
        top = Math.max(top, end(n.world, "z") + m.offset.z);
      }
    }
    expect(top).toBeGreaterThan(0);
    expect(lidTop).toBeGreaterThanOrEqual(top);
  });

  it("the rack has its drawers program; r1/srv has exactly its own internals program", () => {
    expect(a.programs.map((p) => `${p.owner}:${p.id}`)).toEqual(["r1:drawers", "r1/srv:internals"]);
    expect(a.defaultProgram).toBe("drawers");
  });

  it("reach covers the pulled drawer with the lid and internals raised", () => {
    const d = program(a, "r1", "drawers").stages[1]!.moves.find((m) => m.path === "r1/srv")!;
    const p = program(a, "r1/srv", "internals");
    const lid = find(a.root, "r1/srv/lid")!;
    const lidTop = end(lid.world, "z") + p.stages[0]!.moves[0]!.offset.z;
    expect(a.reachBounds.origin.y).toBeLessThanOrEqual(a.restBounds.origin.y);
    expect(end(a.reachBounds, "y")).toBeGreaterThanOrEqual(end(lid.world, "y") + d.offset.y - 1e-6);
    expect(end(a.reachBounds, "z")).toBeGreaterThanOrEqual(lidTop - 1e-6);
    expect(a.reachBounds.size.y).toBeGreaterThan(a.restBounds.size.y);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(nestedBuild().assembly)).toBe(JSON.stringify(assembly));
  });

  it("a template that does not fit is scaled down uniformly with a size-mismatch warning", () => {
    const big = internalsTemplate();
    (big["parts"] as Json[]) = [
      { id: "board", shape: "hw:board", at: [0, 0, 0], size: [2000, 1000, 200] },
      { id: "psu", type: "psu", shape: "hw:psu", at: [0, 0, 0], size: [200, 200, 100] },
    ];
    (big["programs"] as unknown) = [];
    const r = nestedBuild({}, big);
    expect(r.diagnostics).toMatchObject([
      { severity: "warning", code: "assembly/size-mismatch", path: "/racks/0/slots/1/assembly" },
    ]);
    const tray = find(r.assembly!.root, "r1/srv/tray")!;
    const board = find(r.assembly!.root, "r1/srv/board")!;
    // 2000 x 1000 x 200 into ~536 x ~762 x ~83: the x axis (and uniform scale) limits
    const f = board.local.size.x / 2000;
    expect(f).toBeLessThan(0.3);
    expect(board.local.size.y / 1000).toBeCloseTo(f, 6);
    expect(board.local.size.z / 200).toBeCloseTo(f, 6);
    expect(end(board.world, "x")).toBeLessThanOrEqual(end(tray.world, "x") + 1e-6);
    // no default program in the template: internals is just the lid
    expect(program(r.assembly!, "r1/srv", "internals").stages).toHaveLength(1);
  });

  it("template units are converted to millimetres (cm and in)", () => {
    for (const [units, k] of [
      ["cm", 10],
      ["in", 25.4],
    ] as const) {
      const tpl = {
        id: "t",
        template: true,
        units,
        parts: [{ id: "blk", at: [0, 0, 0], size: [1, 2, 0.5] }],
      };
      const s = spec({
        assemblies: [tpl],
        racks: [{ id: "r", slots: [{ id: "s", at: 5, type: "server-2u", assembly: "t" }] }],
        ...act("r"),
      });
      const r = build(s, "r", { t: template(s, "t") });
      const blk = find(r.assembly!.root, "r/s/blk")!;
      expect(blk.local.size.x).toBeCloseTo(k, 4);
      expect(blk.local.size.y).toBeCloseTo(2 * k, 4);
      expect(blk.local.size.z).toBeCloseTo(0.5 * k, 4);
    }
  });

  it("a missing template is an unknown-target error and the slot stays a plain device", () => {
    const s = nested();
    const r = build(s, "r1", {});
    expect(r.diagnostics).toMatchObject([
      { severity: "error", code: "assembly/unknown-target", path: "/racks/0/slots/1/assembly" },
    ]);
    expect(find(r.assembly!.root, "r1/srv/chassis")).toBeDefined();
  });

  it("a build program as the template default has 1 + steps stages with no template moves", () => {
    const tpl = internalsTemplate();
    (tpl["program"] as unknown) = "b";
    (tpl["programs"] as unknown) = [
      {
        id: "b",
        kind: "build",
        steps: [
          { add: ["board"] },
          { add: ["fan-1", "fan-2", "fan-3", "fan-4", "fan-5"] },
          { add: ["psu"] },
        ],
      },
    ];
    const r = nestedBuild({}, tpl);
    const p = program(r.assembly!, "r1/srv", "internals");
    expect(p.stages).toHaveLength(4);
    expect(p.stages.slice(1).every((s) => s.moves.length === 0)).toBe(true);
    expect(p.stages[0]!.moves).toHaveLength(1);
  });

  it("mirrored rows: tray halves follow the turn (+x/+y walls draw in front) and fronts face -y", () => {
    const tpl = internalsTemplate();
    const s = spec({
      assemblies: [tpl],
      racks: [
        { id: "a", slots: [{ id: "s", at: 1, type: "server-2u", assembly: "srv-internals" }] },
        { id: "b", slots: [{ id: "s", at: 1, type: "server-2u", assembly: "srv-internals" }] },
      ],
      rows: [
        { id: "ra", members: ["a"] },
        { id: "rb", members: ["b"] },
      ],
      aisles: [{ id: "c", kind: "cold", rows: ["ra", "rb"] }],
      steps: [{ assembly: [{ explode: "a" }, { explode: "b" }] }],
    });
    const frag = dcPack.buildScene(s);
    const t = { "srv-internals": template(s, "srv-internals") };
    const seen = new Set<string>();
    for (const id of ["a", "b"]) {
      const r = must(dcPack.buildAssembly!(s, id, frag, t).assembly);
      seen.add(r.frame.front);
      const tray = find(r.root, `${id}/s/tray`)!;
      const g = tray.geometry!;
      const cx = g.bounds.origin.x + g.bounds.size.x / 2;
      const cy = g.bounds.origin.y + g.bounds.size.y / 2;
      const byId = new Map(g.primitives.map((p) => [p.id, p]));
      for (const pid of g.split!.front) {
        const p = byId.get(pid)!;
        expect(
          p.box.origin.x + p.box.size.x / 2 > cx + 1e-9 ||
            p.box.origin.y + p.box.size.y / 2 > cy + 1e-9,
        ).toBe(true);
      }
      for (const pid of g.split!.back) {
        const p = byId.get(pid)!;
        expect(
          p.box.origin.x + p.box.size.x / 2 > cx + 1e-9 ||
            p.box.origin.y + p.box.size.y / 2 > cy + 1e-9,
        ).toBe(false);
      }
      expect(g.split!.front.length + g.split!.back.length).toBe(5);
      // the PSU is at the back of the server: farther from the front than the board
      const psu = find(r.root, `${id}/s/psu`)!;
      const board = find(r.root, `${id}/s/board`)!;
      const frontward = r.frame.front === "+y" ? 1 : -1;
      expect(frontward * (board.world.origin.y - psu.world.origin.y)).toBeGreaterThan(0);
    }
    expect([...seen].sort()).toEqual(["+y", "-y"]);
  });
});

describe("budgets and bad input", () => {
  it("only the first 48 slots are read and the result stays fast", () => {
    const slots = Array.from({ length: 5000 }, (_, i) => ({
      at: (i % 40) + 1,
      type: "server-1u",
      id: `s${i}`,
    }));
    const s = spec({ racks: [{ id: "r", slots }], ...act("r") });
    const t0 = Date.now();
    const r = build(s, "r");
    expect(Date.now() - t0).toBeLessThan(5000);
    const a = r.assembly;
    if (a !== undefined) expect(a.root.children.length).toBeLessThanOrEqual(49);
    expect(JSON.stringify(r.diagnostics)).not.toContain("NaN");
  });

  it("a template over the leaf budget is budget/assembly-parts and builds no assembly", () => {
    const tpl = {
      id: "t",
      template: true,
      parts: [
        { id: "a", count: 40, at: [0, 0, 0], size: [1, 1, 1], pitch: [2, 0, 0] },
        { id: "b", at: [0, 0, 0], size: [1, 1, 1] },
      ],
    };
    const s = spec({
      assemblies: [tpl],
      racks: [{ id: "r", slots: [{ id: "s", at: 1, type: "server-2u", assembly: "t" }] }],
      ...act("r"),
    });
    const tree = template(s, "t");
    const grown: SceneAssemblyNode = {
      ...tree,
      children: Array.from({ length: MAX_LEAVES }, (_, i) => ({
        ...tree.children[0]!,
        id: `x${i}`,
        path: `${tree.path}/x${i}`,
      })),
    };
    const r = build(s, "r", { t: grown });
    expect(r.assembly).toBeUndefined();
    expect(r.diagnostics).toMatchObject([
      { severity: "error", code: "budget/assembly-parts", path: "/racks/0" },
    ]);
  });

  it("never throws on garbage", () => {
    const junk = [
      spec({
        racks: [{ id: "r", slots: [null, 5, { at: "x" }, { at: 1, type: "nope" }] }],
        ...act("r"),
      }),
      spec({
        racks: [
          {
            id: "r",
            programs: [
              {
                id: "p",
                stages: [
                  {
                    parts: [5, null, "**/**/**/**/**/**/**/**/**/x"],
                    direction: [0, 0, 0],
                    distance: "huge",
                  },
                ],
              },
            ],
          },
        ],
        ...act("r"),
      }),
      spec({
        racks: [{ id: "r", slots: [{ at: 1, type: "server-1u", id: "s", assembly: 7 }] }],
        ...act("r"),
      }),
      spec({ racks: [{ id: "r" }], steps: [{ assembly: [null, 1, {}] }] }),
    ];
    // the fragment comes from a clean spec: scene building is not what is tested here
    const clean = spec({ racks: [{ id: "r" }] });
    const frag = dcPack.buildScene(clean);
    for (const s of junk) {
      expect(() => dcPack.buildAssembly!(s, "r", frag, {})).not.toThrow();
    }
  });

  it("glob selectors are linear, not exponential, on adversarial patterns", () => {
    const s = spec({
      racks: [
        {
          id: "r",
          slots: [{ id: "a".repeat(60), at: 1, type: "server-1u" }],
          programs: [{ id: "p", stages: [{ parts: [`${"*a".repeat(30)}b`], direction: "up" }] }],
        },
      ],
      ...act("r"),
    });
    const t0 = Date.now();
    build(s, "r");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
