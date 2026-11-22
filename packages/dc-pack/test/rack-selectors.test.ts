/**
 * W-1: rack-program selectors are validated over the rack the DC pack builds, the tree the scene
 * resolves them over (assemblies.md 6.1, 8.1).
 */
import { describe, expect, it } from "vitest";
import {
  buildScene,
  validate,
  type Diagnostic,
  type PlatformCosmoSpec,
  type SceneAssembly,
} from "@platformcosmo/core";
import { dcPack } from "../src/index.js";

type Json = Record<string, unknown>;
const spec = (extra: Json): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...extra }) as unknown as PlatformCosmoSpec;
const codes = (ds: readonly Diagnostic[], code: string): Diagnostic[] =>
  ds.filter((d) => d.code === code);
const board: Json = {
  id: "board",
  template: true,
  units: "mm",
  parts: [{ id: "pcb", at: [0, 0, 0], size: [400, 500, 2] }],
};
const hall = (extra: Json): PlatformCosmoSpec => spec({ assemblies: [board], ...extra });
const asmOf = (s: PlatformCosmoSpec, id: string): SceneAssembly | undefined =>
  buildScene(s, { dc: dcPack }).assemblies?.assemblies.find((a) => a.id === id);

describe("rack-program selectors: validated over the tree the scene resolves (6.1)", () => {
  const withProgram = (parts: string[]): PlatformCosmoSpec =>
    hall({
      racks: [
        {
          id: "r1",
          programs: [{ id: "open", stages: [{ parts, direction: "up", distance: 100 }] }],
          slots: [{ id: "srv", at: 1, type: "server-2u", assembly: "board" }],
        },
      ],
      steps: [{ assembly: [{ explode: "r1" }] }],
    });
  const empties = (s: PlatformCosmoSpec, dc = true): Diagnostic[] =>
    codes(validate(s, dc ? { dc: dcPack } : {}).diagnostics, "assembly/selector-empty");
  const moved = (s: PlatformCosmoSpec): string[] => {
    const a = asmOf(s, "r1")!;
    const p = a.programs.find((x) => x.id === "open")!;
    return p.kind === "explode" ? p.stages.flatMap((st) => st.moves.map((m) => m.path)) : [];
  };

  it("a part the DC pack adds (the lid around a template) is found by both", () => {
    const s = withProgram(["srv/lid", "frame/post-fl"]);
    expect(empties(s)).toEqual([]);
    expect(moved(s)).toEqual(["r1/frame/post-fl", "r1/srv/lid"]);
    // without the pack the frame is opaque (silent) but the lid is not in the template
    expect(empties(s, false).map((d) => d.path)).toEqual(["/racks/0/programs/0/stages/0/parts/0"]);
  });

  it("a selector the scene finds empty is reported, with a did-you-mean", () => {
    const s = withProgram(["frame/post-zz"]);
    expect(moved(s)).toEqual([]);
    const d = empties(s);
    expect(d.map((x) => x.path)).toEqual(["/racks/0/programs/0/stages/0/parts/0"]);
    expect(d[0]!.suggestion).toContain("frame/post-");
    // the pack cannot see frame parts without the pack: nothing was reported before
    expect(empties(s, false)).toEqual([]);
  });

  it("an untargeted rack's programs keep the opaque tree (they never play)", () => {
    const s = withProgram(["frame/post-zz"]);
    const idle = { ...s, steps: [] } as unknown as PlatformCosmoSpec;
    expect(empties(idle)).toEqual([]);
  });
});
