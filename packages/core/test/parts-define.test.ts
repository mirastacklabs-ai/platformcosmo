import { describe, expect, it } from "vitest";
import {
  Draft,
  MAX_PARAM_DIAGNOSTICS,
  MIN_DIM,
  definePack,
  finishGeometry,
  isValidParam,
  normalizeParams,
  quote,
  readParamSpecs,
  sanitizeSize,
  unionBoxes,
  type ParamSpec,
} from "../src/parts/define.js";

const specs = new Map<string, ParamSpec>([
  ["count", { kind: "int", min: 1, max: 4, def: 2 }],
  ["on", { kind: "bool", def: true }],
  ["mode", { kind: "enum", values: ["fast", "slow"], def: "fast" }],
]);

describe("quote", () => {
  it("truncates, labels objects and never throws", () => {
    expect(quote("a".repeat(50))).toBe(`"${"a".repeat(40)}..."`);
    expect(quote(null)).toBe('"null"');
    expect(quote([])).toBe('"an array"');
    expect(quote(Object.create(null))).toBe('"an object"');
    expect(quote(Symbol("x"))).toBe('"a symbol"');
    expect(quote(7)).toBe('"7"');
  });
});

describe("isValidParam / normalizeParams", () => {
  it("accepts only in-range integers, booleans and listed enum values", () => {
    const [int, bool, en] = [...specs.values()] as ParamSpec[];
    expect(isValidParam(int!, 3)).toBe(true);
    expect(isValidParam(int!, 5)).toBe(false);
    expect(isValidParam(int!, 1.5)).toBe(false);
    expect(isValidParam(bool!, "true")).toBe(false);
    expect(isValidParam(en!, "slow")).toBe(true);
    expect(isValidParam(en!, "x")).toBe(false);
  });
  it("falls back to defaults and ignores inherited keys", () => {
    expect(normalizeParams(specs, { count: 9, on: false, mode: "slow" })).toEqual({
      count: 2,
      on: false,
      mode: "slow",
    });
    expect(normalizeParams(specs, Object.create({ count: 3 }))).toEqual({
      count: 2,
      on: true,
      mode: "fast",
    });
    expect(normalizeParams(specs, 5)).toEqual({ count: 2, on: true, mode: "fast" });
  });
});

describe("readParamSpecs", () => {
  it("returns defaults with no diagnostics for absent input", () => {
    expect(readParamSpecs("hw:x", specs, undefined)).toEqual({
      params: { count: 2, on: true, mode: "fast" },
      diagnostics: [],
    });
  });
  it("rejects a non-object", () => {
    const r = readParamSpecs("hw:x", specs, [1]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.message).toBe("hw:x params must be an object (got an array).");
  });
  it("suggests the closest param name for an unknown key and escapes the path", () => {
    const r = readParamSpecs("hw:x", specs, { cuont: 3, "a/b~": 1 });
    expect(r.diagnostics[0]?.suggestion).toBeDefined();
    expect(r.diagnostics[0]?.path).toBe("/params/cuont");
    expect(r.diagnostics[1]?.path).toBe("/params/a~1b~0");
    expect(r.params["count"]).toBe(2);
  });
  it("suggests enum values only when enumHints is on", () => {
    const off = readParamSpecs("brick:x", specs, { mode: "fsat" });
    const on = readParamSpecs("brick:x", specs, { mode: "fsat" }, true);
    expect(off.diagnostics[0]?.suggestion).toBeUndefined();
    expect(on.diagnostics[0]?.suggestion).toBeDefined();
    expect(on.diagnostics[0]?.message).toContain('param "mode" must be one of "fast", "slow"');
  });
  it("caps diagnostics and summarises the rest", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PARAM_DIAGNOSTICS + 5; i++) input[`k${i}`] = 1;
    const r = readParamSpecs("hw:x", specs, input);
    expect(r.diagnostics).toHaveLength(MAX_PARAM_DIAGNOSTICS + 1);
    expect(r.diagnostics.at(-1)?.message).toBe("hw:x: 5 more param problems omitted.");
  });
  it("gives a key past the cap no suggestion and skips the matcher", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PARAM_DIAGNOSTICS; i++) input[`k${i}`] = 1;
    input["cuont"] = 3;
    input["mode"] = "fsat";
    const r = readParamSpecs("hw:x", specs, input, true);
    expect(r.diagnostics).toHaveLength(MAX_PARAM_DIAGNOSTICS + 1);
    expect(r.diagnostics.some((d) => d.path === "/params/cuont")).toBe(false);
    expect(r.diagnostics.some((d) => d.path === "/params/mode")).toBe(false);
    expect(r.diagnostics.at(-1)?.message).toBe("hw:x: 2 more param problems omitted.");
  });
});

describe("sanitizeSize", () => {
  const def = { x: 1, y: 2, z: 3 };
  it("falls back to the default for bad entries and clamps the rest", () => {
    expect(sanitizeSize({ x: NaN, y: -1, z: 1e9 }, def, 100)).toEqual({ x: 1, y: 2, z: 100 });
    expect(sanitizeSize({ x: 0.001, y: 5, z: 6 }, def, 100)).toEqual({ x: MIN_DIM, y: 5, z: 6 });
    expect(sanitizeSize(undefined, def, 100)).toEqual(def);
  });
  it("rounds only when asked", () => {
    expect(sanitizeSize({ x: 1.23456, y: 1, z: 1 }, def, 100).x).toBe(1.23456);
    expect(sanitizeSize({ x: 1.23456, y: 1, z: 1 }, def, 100, true).x).toBe(1.23);
  });
});

describe("Draft / finishGeometry", () => {
  it("scales to the size, rounds corners and tracks non-core ids", () => {
    const d = new Draft({ x: 10, y: 10, z: 10 }, { x: 20, y: 10, z: 10 }, undefined);
    d.add("a", "box", [0, 0, 0], [5, 10, 10], "base");
    d.add("b", "box", [5, 0, 0], [5, 10, 10], "base", { core: false });
    expect(d.prims[0]?.box.size.x).toBe(10);
    expect(d.prims[1]?.box.origin.x).toBe(10);
    expect(d.coreIds()).toEqual(["a"]);
    const g = finishGeometry(d.prims, undefined, d.coreIds());
    expect(g.bounds.size.x).toBe(20);
    expect(g.depthBox.size.x).toBe(10);
    expect(g.solid).toBe(true);
  });
  it("maps x <-> z with swapXZ", () => {
    const d = new Draft({ x: 1, y: 1, z: 2 }, { x: 1, y: 1, z: 2 }, undefined, true);
    d.add("a", "cylinder", [0, 0, 0], [2, 1, 1], "base", { axis: "x" });
    expect(d.prims[0]?.box.size).toEqual({ x: 1, y: 1, z: 2 });
    expect(d.prims[0]?.axis).toBe("z");
  });
  it("marks a split as not solid and unions boxes", () => {
    const d = new Draft({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, undefined);
    d.add("a", "box", [0, 0, 0], [1, 1, 1], "base");
    const g = finishGeometry(d.prims, { back: ["a"], front: [] });
    expect(g.solid).toBe(false);
    expect(g.split).toEqual({ back: ["a"], front: [] });
    expect(unionBoxes(d.prims).size).toEqual({ x: 1, y: 1, z: 1 });
  });
});

describe("definePack", () => {
  const pack = definePack({ prefix: "t", maxExtent: 50 });
  const shape = pack.defineShape({
    id: "slab",
    label: "Slab",
    type: "slab",
    size: [10, 10, 2],
    params: { thick: { kind: "bool", def: false } },
    check: (p, input) =>
      input["thick"] === true
        ? [{ severity: "warning", code: "t/x", path: "/params/thick", message: String(p["thick"]) }]
        : [],
    draw(g, _p, tone) {
      g.add("body", "box", [0, 0, 0], [10, 10, 2], tone);
      return undefined;
    },
  });
  it("registers specs and namespaces diagnostics by prefix", () => {
    expect(pack.paramSpecsOf("slab")?.has("thick")).toBe(true);
    expect(pack.paramSpecsOf("nope")).toBeUndefined();
    const r = shape.readParams({ bogus: 1 });
    expect(r.diagnostics[0]?.message).toContain("t:slab has no param");
  });
  it("appends check diagnostics only for given params", () => {
    expect(shape.readParams({ thick: true }).diagnostics).toHaveLength(1);
    expect(shape.readParams({}).diagnostics).toHaveLength(0);
  });
  it("does not call check for non-object or array input", () => {
    let calls = 0;
    const p2 = definePack({ prefix: "t" });
    const s2 = p2.defineShape({
      id: "c",
      label: "C",
      type: "c",
      size: [1, 1, 1],
      params: {},
      check: () => {
        calls++;
        return [];
      },
      draw: () => undefined,
    });
    for (const bad of [[1], "x", 3, null, undefined]) s2.readParams(bad as never);
    expect(calls).toBe(0);
    s2.readParams({});
    expect(calls).toBe(1);
  });
  it("freezes defaults", () => {
    expect(Object.isFrozen(shape.defaults)).toBe(true);
  });
  it("builds at the clamped spec size", () => {
    const g = shape.build({}, { size: { x: 1000, y: 10, z: 2 } } as never);
    expect(g.bounds.size.x).toBe(50);
    expect(shape.build({}, undefined as never).bounds.size.x).toBe(10);
  });
});
