/**
 * Schema fuzz tests (PLAN section 13). Seeded and deterministic: every case derives from a fixed
 * seed, and work is bounded by case count and value size (never by wall clock).
 * Local deep runs: FUZZ_SEED=<n> FUZZ_RUNS=<cases per category> (see `scripts/pc test`).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, test } from "vitest";
import type { Diagnostic, PartShapeRegistry, ThemeRegistry } from "../src/contracts/index.js";
import { parseSpec, render, validate } from "../src/index.js";
import { assemblyDiagnostics } from "../src/schema/assembly-semantic.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";
import { fixtureTheme } from "./fixtures/theme.js";

const SEED = Number(process.env["FUZZ_SEED"] ?? 20240607) >>> 0;
const RUNS = Math.max(1, Number(process.env["FUZZ_RUNS"] ?? 300) | 0);
const RENDER_RUNS = Math.max(1, Math.min(RUNS, 12));
// Explicit per-describe timeouts that scale with RUNS (a deep local run must not trip the 5 s default).
const TIMEOUT = { timeout: 30_000 + RUNS * 100 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const int = (r: Rand, n: number) => Math.floor(r() * n);
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[int(r, xs.length)]!;

const root = fileURLToPath(new URL("../../../examples/", import.meta.url));
const exampleFiles = [
  ...readdirSync(root)
    .filter((f) => f.endsWith(".cosmo.json"))
    .map((f) => root + f),
  ...readdirSync(root + "templates")
    .filter((f) => f.endsWith(".cosmo.json"))
    .map((f) => `${root}templates/${f}`),
].sort();
const examples = exampleFiles.map((f) => ({
  name: f.slice(root.length),
  json: readFileSync(f, "utf8"),
}));

const registry: ThemeRegistry = {
  get: (id) => (id === "light" || id === "dark" ? fixtureTheme(id, id === "dark") : undefined),
  list: () => ["dark", "light"],
};

// Own-property snapshot of the globals a pollution bug would touch.
const protoNames = () => Object.getOwnPropertyNames(Object.prototype).sort().join(",");
const PROTO_BEFORE = protoNames();
const assertClean = () => {
  expect(protoNames()).toBe(PROTO_BEFORE);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  expect(({} as Record<string, unknown>)["isAdmin"]).toBeUndefined();
  expect(([] as unknown as Record<string, unknown>)["polluted"]).toBeUndefined();
};

const POINTER = /^(\/([^~/]|~[01])*)*$/;

/** Shape contract every validate() result must satisfy, valid or not. */
function checkResult(res: unknown, label: string): { valid: boolean; diagnostics: Diagnostic[] } {
  const r = res as { valid: boolean; diagnostics: Diagnostic[] };
  expect(typeof r.valid, label).toBe("boolean");
  expect(Array.isArray(r.diagnostics), label).toBe(true);
  for (const d of r.diagnostics) {
    expect(typeof d.code, label).toBe("string");
    expect(d.code.length, label).toBeGreaterThan(0);
    expect(typeof d.message, label).toBe("string");
    expect(d.message.length, label).toBeGreaterThan(0);
    expect(typeof d.path, label).toBe("string");
    expect(POINTER.test(d.path), `${label}: bad pointer ${JSON.stringify(d.path)}`).toBe(true);
    expect(["error", "warning", "info"], label).toContain(d.severity);
  }
  const hasError = r.diagnostics.some((d) => d.severity === "error");
  if (!r.valid) expect(hasError, `${label}: invalid without an error`).toBe(true);
  else expect(hasError, label).toBe(false);
  return r;
}

// ---------------------------------------------------------------- random JSON values

const WEIRD_STRINGS = [
  "",
  "\u0000",
  "\u202e\u2066abc",
  "\ud83d\ude00",
  "\ud800", // lone surrogate
  "e\u0301\u200b\u200d",
  "__proto__",
  "constructor",
  "prototype",
  "NaN",
  "Infinity",
  "-Infinity",
  "1e999",
  "<script>alert(1)</script>",
  "../../etc/passwd",
  "a".repeat(5000),
  "\n\r\t",
  "${jndi:ldap://x}",
];

const own = (o: object, k: string, value: unknown) =>
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });

function randomValue(r: Rand, depth: number, budget: { n: number }): unknown {
  budget.n--;
  const kind = budget.n <= 0 || depth <= 0 ? int(r, 5) : int(r, 8);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return pick(r, [0, -0, 1, -1, 0.5, 1e308, -1e308, 2 ** 53, Number.MIN_VALUE, int(r, 1000)]);
    case 3:
    case 4:
      return r() < 0.5
        ? pick(r, WEIRD_STRINGS)
        : String.fromCharCode(...Array.from({ length: int(r, 12) }, () => int(r, 0x2fff)));
    case 5:
    case 6:
      return Array.from({ length: int(r, 6) }, () => randomValue(r, depth - 1, budget));
    default: {
      const o: Record<string, unknown> = {};
      const keys = [
        "meta",
        "nodes",
        "edges",
        "groups",
        "flows",
        "steps",
        "id",
        "type",
        "from",
        "to",
        "version",
        "canvas",
        "racks",
        "$schema",
        "__proto__",
        "constructor",
      ];
      for (let i = int(r, 6); i > 0; i--) {
        const k =
          r() < 0.6 ? pick(r, keys) : String.fromCharCode(97 + int(r, 26)).repeat(1 + int(r, 4));
        own(o, k, randomValue(r, depth - 1, budget));
      }
      return o;
    }
  }
}

/** A spec-shaped object whose fields are random: reaches deeper than pure noise. */
function specShaped(r: Rand): unknown {
  const b = { n: 40 };
  const rv = () => randomValue(r, 3, b);
  const nodes = Array.from({ length: int(r, 5) }, (_, i) => ({
    id: r() < 0.8 ? `n${i}` : rv(),
    type: r() < 0.7 ? pick(r, ["server", "database", "cache", "queue", "client"]) : rv(),
    ...(r() < 0.3 ? { label: rv() } : {}),
    ...(r() < 0.2 ? { pos: rv() } : {}),
    ...(r() < 0.2 ? { group: rv() } : {}),
  }));
  const spec: Record<string, unknown> = { meta: r() < 0.8 ? { version: "1" } : rv(), nodes };
  if (r() < 0.6)
    spec["edges"] = Array.from({ length: int(r, 4) }, () => ({
      from: r() < 0.7 ? "n0" : rv(),
      to: r() < 0.7 ? "n1" : rv(),
    }));
  if (r() < 0.4) spec["flows"] = rv();
  if (r() < 0.4) spec["steps"] = rv();
  if (r() < 0.3) spec["canvas"] = rv();
  if (r() < 0.3) spec[pick(r, ["extra", "racks", "metrics", "legend"])] = rv();
  return spec;
}

function deepNest(depth: number, leaf: unknown, as: "array" | "object"): unknown {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = as === "array" ? [v] : { a: v };
  return v;
}

function garble(r: Rand, text: string): string {
  let t = text;
  for (let i = 1 + int(r, 4); i > 0; i--) {
    const at = int(r, t.length + 1);
    switch (int(r, 6)) {
      case 0:
        t = t.slice(0, at); // truncate
        break;
      case 1:
        t = t.slice(0, at) + t.slice(at + 1 + int(r, 5)); // delete
        break;
      case 2:
        t =
          t.slice(0, at) +
          pick(r, [
            '"',
            "{",
            "}",
            "[",
            "]",
            ",",
            ":",
            "\t",
            "\n",
            "- ",
            "&a ",
            "*a",
            "#",
            "\u0000",
            "\ud800",
          ]) +
          t.slice(at);
        break;
      case 3: {
        const s = int(r, t.length + 1);
        t = t + t.slice(s, s + 30);
        break;
      }
      case 4:
        t = t.replace(/ {2}/g, r() < 0.5 ? "\t" : "   ");
        break;
      default:
        t = t.slice(0, at) + t.slice(at).replace(/"/, "'");
    }
  }
  return t;
}

describe("fuzz: random JSON values", TIMEOUT, () => {
  test("validate never throws and always explains itself", () => {
    const r = mulberry32(SEED);
    for (let i = 0; i < RUNS; i++) {
      const v = i % 2 === 0 ? randomValue(r, 4, { n: 60 }) : specShaped(r);
      const res = checkResult(validate(v), `case ${i}`);
      if (res.valid) expect((res as { spec?: unknown }).spec).toBeDefined();
    }
    assertClean();
  });

  test("non-object roots and primitives", () => {
    const prims = [
      undefined,
      null,
      true,
      0,
      NaN,
      Infinity,
      "",
      "x",
      [],
      [[]],
      () => 1,
      Symbol.iterator,
      1n,
    ];
    for (const v of prims) checkResult(validate(v), typeof v);
  });

  test("deep nesting and very long strings", () => {
    for (const depth of [10, 100, 1000, 3000]) {
      for (const as of ["array", "object"] as const) {
        const leaf = deepNest(depth, "x", as);
        checkResult(validate(leaf), `root ${as} ${depth}`);
        checkResult(
          validate({
            meta: { version: "1", title: leaf },
            nodes: [{ id: "a", type: "server", label: leaf }],
          }),
          `nested ${as} ${depth}`,
        );
      }
    }
    for (const len of [1e4, 1e5, 1e6]) {
      const s = "x".repeat(len);
      const res = checkResult(
        validate({
          meta: { version: "1", title: s, description: s },
          nodes: [{ id: s, type: "server", label: s }],
        }),
        `long ${len}`,
      );
      expect(res.valid).toBe(false); // lengths are capped by the schema
    }
    assertClean();
  });

  test("1 MB unknown keys and enum-ish values stay cheap (suggestion search is bounded)", () => {
    const big = "q".repeat(1_000_000);
    const mk = (): Obj => ({
      meta: { version: "1" },
      nodes: [
        { id: "a", type: "server" },
        { id: "b", type: "server" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const cases: [string, (s: Obj) => void][] = [
      ["root key", (s) => (s[big] = 1)],
      ["nodes[0].type", (s) => ((s["nodes"] as Obj[])[0]!["type"] = big)],
      ["edges[0].style", (s) => ((s["edges"] as Obj[])[0]!["style"] = big)],
      ["nodes[0] key", (s) => ((s["nodes"] as Obj[])[0]![big] = 1)],
    ];
    validate(mk()); // warm up
    for (const [label, apply] of cases) {
      const s = mk();
      apply(s);
      const t0 = performance.now();
      const res = checkResult(validate(s), label);
      const ms = performance.now() - t0;
      expect(res.valid, label).toBe(false);
      // unbounded edit-distance tables took many seconds and hundreds of MB; generous ceiling
      expect(ms, `${label} took ${ms.toFixed(0)} ms`).toBeLessThan(3000);
    }
  });

  test("parseSpec on random text never throws (json and yaml)", () => {
    const r = mulberry32(SEED + 1);
    for (let i = 0; i < RUNS; i++) {
      const v = i % 3 === 0 ? randomValue(r, 4, { n: 50 }) : specShaped(r);
      let text = JSON.stringify(v) ?? "null";
      if (r() < 0.5) text = garble(r, text);
      for (const format of ["json", "yaml"] as const) {
        const p = parseSpec(text, format);
        expect(Array.isArray(p.diagnostics)).toBe(true);
        if (p.spec === undefined) {
          expect(p.diagnostics.some((d) => d.severity === "error")).toBe(true);
          for (const d of p.diagnostics) expect(d.message.length).toBeGreaterThan(0);
        } else {
          checkResult(validate(p.spec), `parsed case ${i} ${format}`);
        }
      }
    }
    const nasty = [
      "",
      "\ufeff",
      "[".repeat(100000),
      "{".repeat(100000),
      "&a [*a, *a]",
      "a: &a [x, x]\nb: &b [*a, *a, *a, *a]\nc: &c [*b, *b, *b, *b]\nd: &d [*c, *c, *c, *c]\ne: [*d, *d, *d, *d, *d, *d]",
      "- ".repeat(50000),
      "a:\n".repeat(20000),
      "!!binary x",
      "? [a]\n: b",
      "\t\t\t",
      "a: 1\na: 2",
      "<<: *x",
      '"' + "\\u".repeat(1000),
    ];
    for (const t of nasty) {
      for (const format of ["json", "yaml"] as const) {
        const p = parseSpec(t, format);
        expect(Array.isArray(p.diagnostics)).toBe(true);
        if (p.spec !== undefined) checkResult(validate(p.spec), "nasty");
      }
    }
    expect(parseSpec(1 as never, "json").diagnostics[0]?.code).toBe("parse/not-text");
    expect(parseSpec("{}", "toml" as never).diagnostics[0]?.code).toBe("parse/format");
    assertClean();
  });
});

// ---------------------------------------------------------------- mutation fuzzing

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Slot = { parent: Json[] | { [k: string]: Json }; key: string | number; value: Json };
type Obj = { [k: string]: Json };

function collect(v: Json, out: Slot[] = []): Slot[] {
  if (Array.isArray(v)) {
    v.forEach((c, i) => {
      out.push({ parent: v, key: i, value: c });
      collect(c, out);
    });
  } else if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      out.push({ parent: v, key: k, value: v[k]! });
      collect(v[k]!, out);
    }
  }
  return out;
}

const clone = (v: Json): Json => JSON.parse(JSON.stringify(v)) as Json;
// Values are cloned on the way in so shared constants can never become cycles.
const setSlot = (s: Slot, value: Json) => {
  const v = clone(value);
  if (Array.isArray(s.parent)) s.parent[s.key as number] = v;
  else own(s.parent, s.key as string, v);
};

const REF_KEYS = new Set([
  "from",
  "to",
  "edge",
  "group",
  "parent",
  "node",
  "target",
  "ref",
  "focus",
  "members",
  "rack",
  "rows",
  "cables",
  "pdu",
]);
const RETYPES: Json[] = [null, true, 0, -1, 1.5, "", "x", [], {}, [[]], { a: 1 }, ["a", "b"]];
const BAD_NUMBERS: Json[] = [
  -1,
  0,
  1e308,
  -1e308,
  2 ** 53,
  1e-320,
  0.1,
  "NaN",
  "Infinity",
  "-Infinity",
  "1e999",
  "0x10",
  99999,
  1001,
];

function mutate(r: Rand, spec: Json): Json {
  const slots = collect(spec);
  if (slots.length === 0) return spec;
  const s = pick(r, slots);
  switch (int(r, 12)) {
    case 0: // delete
      if (Array.isArray(s.parent)) s.parent.splice(s.key as number, 1);
      else delete s.parent[s.key as string];
      break;
    case 1: // duplicate
      if (Array.isArray(s.parent)) s.parent.push(clone(s.value));
      else own(s.parent, s.key + "2", clone(s.value));
      break;
    case 2:
    case 3: // retype
      setSlot(s, pick(r, RETYPES));
      break;
    case 4: {
      // copy one id over another (duplicate ids)
      const ids = slots.filter((x) => x.key === "id" && typeof x.value === "string");
      if (ids.length >= 2) setSlot(pick(r, ids), pick(r, ids).value);
      break;
    }
    case 5: {
      // dangling ref
      const refs = slots.filter((x) => typeof x.key === "string" && REF_KEYS.has(x.key));
      const t = refs.length > 0 ? pick(r, refs) : s;
      setSlot(t, Array.isArray(t.value) ? ["ghost-" + int(r, 99)] : "ghost-" + int(r, 99));
      break;
    }
    case 6: {
      // out-of-range / odd numbers
      const nums = slots.filter((x) => typeof x.value === "number");
      setSlot(nums.length > 0 ? pick(r, nums) : s, pick(r, BAD_NUMBERS));
      break;
    }
    case 7: {
      // huge arrays near limits
      const arrs = slots.filter((x) => Array.isArray(x.value) && (x.value as Json[]).length > 0);
      if (arrs.length > 0) {
        const a = pick(r, arrs).value as Json[];
        const target = pick(r, [50, 99, 100, 101, 200, 201, 500, 501, 1001]);
        const proto = a[0]!;
        while (a.length < target) {
          const c = clone(proto);
          if (
            c !== null &&
            typeof c === "object" &&
            !Array.isArray(c) &&
            typeof c["id"] === "string"
          )
            c["id"] = `${c["id"]}-${a.length}`;
          a.push(c);
        }
      }
      break;
    }
    case 8: {
      // prototype-pollution keys
      const objs = slots.filter(
        (x) => x.value !== null && typeof x.value === "object" && !Array.isArray(x.value),
      );
      const target = (objs.length > 0 ? pick(r, objs).value : spec) as Obj;
      const payload = pick<Json>(r, [
        { polluted: 1 },
        { isAdmin: true },
        { prototype: { polluted: 1 } },
        "x",
        null,
        [],
      ]);
      own(target, pick(r, ["__proto__", "constructor", "prototype"]), clone(payload));
      break;
    }
    case 9: // weird string
      setSlot(s, pick(r, WEIRD_STRINGS));
      break;
    case 10: {
      // swap two siblings
      if (Array.isArray(s.parent) && s.parent.length > 1) {
        const j = int(r, s.parent.length);
        const tmp = s.parent[j]!;
        s.parent[j] = s.parent[s.key as number]!;
        s.parent[s.key as number] = tmp;
      }
      break;
    }
    default: // replace a subtree with a copy of another
      setSlot(s, clone(pick(r, slots).value));
  }
  return spec;
}

describe("fuzz: mutated example specs", TIMEOUT, () => {
  test("examples and templates are the seed corpus", () => {
    expect(examples.length).toBeGreaterThanOrEqual(15);
  });

  test("validate survives mutations, every error has a pointer and message", () => {
    const r = mulberry32(SEED + 2);
    let invalid = 0;
    let deep = 0; // runs that got past the JSON Schema layer into semantic/layout checks
    for (let i = 0; i < RUNS * 2; i++) {
      const ex = pick(r, examples);
      let spec = JSON.parse(ex.json) as Json;
      for (let m = 1 + int(r, 3); m > 0; m--) spec = mutate(r, spec);
      // through text, so __proto__ keys become what a real file would give
      const parsed = parseSpec(JSON.stringify(spec), "json");
      expect(parsed.spec, ex.name).toBeDefined();
      const res = checkResult(validate(parsed.spec), `${ex.name} case ${i}`);
      if (!res.valid) invalid++;
      if (res.diagnostics.some((d) => /^(semantic|layout)\//.test(d.code))) deep++;
      checkResult(validate(spec), `${ex.name} raw case ${i}`);
    }
    expect(invalid).toBeGreaterThan(RUNS / 4); // the mutators actually break things
    expect(deep, "mutants reaching semantic/layout diagnostics").toBeGreaterThanOrEqual(RUNS * 0.2);
    assertClean();
  });

  test("duplicate-id and dangling-ref mutations produce their specific codes", () => {
    const codes = new Set<string>();
    for (const ex of examples) {
      const dup = JSON.parse(ex.json) as Obj;
      const nodes = dup["nodes"];
      if (Array.isArray(nodes) && nodes.length >= 2) {
        (nodes[1] as Obj)["id"] = (nodes[0] as Obj)["id"]!;
        for (const d of validate(dup).diagnostics) codes.add(d.code);
      }
      const dangling = JSON.parse(ex.json) as Obj;
      const edges = dangling["edges"];
      if (Array.isArray(edges) && edges.length > 0) {
        (edges[0] as Obj)["from"] = "ghost-node";
        for (const d of validate(dangling).diagnostics) codes.add(d.code);
      }
    }
    expect(codes.has("semantic/duplicate-id")).toBe(true);
    expect(codes.has("semantic/unknown-node")).toBe(true);
  });

  test("prototype pollution keys at the root are rejected and never pollute", () => {
    for (const ex of examples) {
      for (const key of ["__proto__", "constructor", "prototype"]) {
        const text = ex.json.replace(/^\s*\{/, `{"${key}":{"polluted":1,"isAdmin":true},`);
        const p = parseSpec(text, "json");
        const res = checkResult(validate(p.spec), `${ex.name} ${key}`);
        expect(res.valid, `${ex.name}: ${key}`).toBe(false);
      }
    }
    assertClean();
  });

  test("YAML text with random mutations", () => {
    const r = mulberry32(SEED + 3);
    const yamls = examples.map((e) => ({
      name: e.name,
      json: e.json,
      text: yamlStringify(JSON.parse(e.json)),
    }));
    for (const y of yamls) {
      const p = parseSpec(y.text, "yaml");
      expect(p.diagnostics, y.name).toEqual([]);
      expect(p.spec, y.name).toEqual(JSON.parse(y.json));
    }
    for (let i = 0; i < RUNS; i++) {
      const y = pick(r, yamls);
      const p = parseSpec(garble(r, y.text), "yaml");
      expect(Array.isArray(p.diagnostics)).toBe(true);
      if (p.spec === undefined) {
        const errs = p.diagnostics.filter((d) => d.severity === "error");
        expect(errs.length, `${y.name} case ${i}`).toBeGreaterThan(0);
        for (const d of errs) {
          expect(d.path).toBe("");
          expect(d.message.length).toBeGreaterThan(0);
        }
      } else {
        checkResult(validate(p.spec), `${y.name} yaml case ${i}`);
      }
    }
    assertClean();
  });
});

// ---------------------------------------------------------------- validity-preserving mutations

function shuffleKeys(r: Rand, v: Json): Json {
  if (Array.isArray(v)) return v.map((c) => shuffleKeys(r, c));
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = int(r, i + 1);
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
    const o: Obj = {};
    for (const k of keys) o[k] = shuffleKeys(r, v[k]!);
    return o;
  }
  return v;
}

const sig = (ds: Diagnostic[]) =>
  ds
    .map((d) => `${d.severity}|${d.code}|${d.path}`)
    .sort()
    .join("\n");

describe("fuzz: validity-preserving mutations", TIMEOUT, () => {
  test("every example validates; key order and an added optional field keep it valid", () => {
    const r = mulberry32(SEED + 4);
    for (const ex of examples) {
      const base = JSON.parse(ex.json) as Obj;
      const ref = checkResult(validate(base), ex.name);
      expect(ref.valid, `${ex.name}: ${JSON.stringify(ref.diagnostics)}`).toBe(true);
      for (let i = 0; i < Math.max(2, Math.floor(RUNS / examples.length)); i++) {
        const shuffled = shuffleKeys(r, base) as Obj;
        const a = checkResult(validate(shuffled), `${ex.name} shuffled`);
        expect(a.valid, ex.name).toBe(true);
        expect(sig(a.diagnostics), ex.name).toBe(sig(ref.diagnostics));
        const added = clone(shuffled) as Obj;
        added["meta"] = { ...(added["meta"] as Obj), description: "fuzz " + int(r, 1e6) };
        const first = Array.isArray(added["nodes"]) ? added["nodes"][0] : undefined;
        if (first && typeof first === "object" && !Array.isArray(first))
          first["label"] = "Fuzz " + int(r, 1e6);
        expect(checkResult(validate(added), `${ex.name} +optional`).valid, ex.name).toBe(true);
      }
    }
  });

  test("a spec missing a required field stays invalid whatever the key order", () => {
    const r = mulberry32(SEED + 5);
    for (let i = 0; i < Math.min(RUNS, 100); i++) {
      const base = JSON.parse(pick(r, examples).json) as Obj;
      delete base["meta"];
      expect(checkResult(validate(shuffleKeys(r, base)), "no meta").valid).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- render of anything valid

describe("fuzz: valid specs render", TIMEOUT, () => {
  const opts = { themes: registry, font: "system" as const };

  test("mutated specs that validate render without throwing", async () => {
    const r = mulberry32(SEED + 6);
    let rendered = 0;
    for (let i = 0; i < RUNS * 4 && rendered < RENDER_RUNS; i++) {
      const ex = pick(r, examples);
      let spec = JSON.parse(ex.json) as Json;
      for (let m = 1 + int(r, 3); m > 0; m--) spec = mutate(r, spec);
      const parsed = parseSpec(JSON.stringify(spec), "json").spec;
      if (JSON.stringify(parsed).length > 60_000) continue; // cost bound: skip huge specs
      if (!(validate(parsed) as { valid: boolean }).valid) continue;
      rendered++;
      const out = await render(parsed, opts);
      expect(Array.isArray(out.diagnostics), ex.name).toBe(true);
      for (const d of out.diagnostics) {
        expect(d.message.length).toBeGreaterThan(0);
        expect(typeof d.path).toBe("string");
      }
      const errs = out.diagnostics.filter((d) => d.severity === "error");
      for (const e of errs) {
        if (e.code === "semantic/dc-pack-required") continue; // the DC pack is not wired in core tests
        expect(e.code, `${ex.name}: ${e.message}`).not.toMatch(/^semantic\//);
      }
      if (errs.length === 0) expect(out.outputs.length, ex.name).toBeGreaterThan(0);
    }
    expect(rendered).toBeGreaterThan(0);
    assertClean();
  });

  test("a sample of examples renders deterministically", async () => {
    const r = mulberry32(SEED + 7);
    const sample = [...examples];
    for (let i = sample.length - 1; i > 0; i--) {
      const j = int(r, i + 1);
      [sample[i], sample[j]] = [sample[j]!, sample[i]!];
    }
    sample.length = 6;
    for (const ex of sample) {
      const a = await render(JSON.parse(ex.json) as unknown, opts);
      const b = await render(JSON.parse(ex.json) as unknown, opts);
      expect(
        a.outputs.map((o) => o.data),
        ex.name,
      ).toEqual(b.outputs.map((o) => o.data));
      expect(a.diagnostics, ex.name).toEqual(b.diagnostics);
    }
  });
});

// ---------------------------------------------------------------- schema 1.2.0 shapes (A2-1)

const designSpecs: { name: string; json: string }[] = ["assemblies.md", "document-ingestion.md"]
  .flatMap((file) => {
    const md = readFileSync(
      fileURLToPath(new URL(`../../../docs/design/${file}`, import.meta.url)),
      "utf8",
    );
    return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m, i) => ({ name: `${file}#${i}`, json: m[1] as string }))
      .filter((e) => (JSON.parse(e.json) as Obj)["meta"] !== undefined);
  })
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const LIFTED = { phase1a: false, phase1b: false, phase2: false, phase3: false };
const REF12 = new Set([
  "explode",
  "implode",
  "build",
  "unbuild",
  "use",
  "closeup",
  "mates",
  "inserts",
  "assembly",
  "focus",
  "program",
  "subBuild",
  "model",
  "image",
  "ref",
  "base",
  "parts",
]);

/** Dangling or retargeted references on 1.2.0 keys, on top of the generic mutators. */
function mutate12(r: Rand, spec: Json): Json {
  if (r() < 0.5) return mutate(r, spec);
  const slots = collect(spec).filter(
    (x) => typeof x.key === "string" && REF12.has(x.key) && typeof x.value === "string",
  );
  if (slots.length === 0) return mutate(r, spec);
  const t = pick(r, slots);
  const names = collect(spec)
    .filter((x) => x.key === "id" && typeof x.value === "string")
    .map((x) => x.value as string);
  setSlot(
    t,
    pick(r, [
      "ghost-" + int(r, 9),
      (t.value as string) + "x",
      (t.value as string).split("/").slice(0, 2).join("/") + "/deep/er",
      names.length > 0 ? pick(r, names) : "a",
      "a/".repeat(9) + "b",
      "closeup",
      "x/closeup/y",
    ]),
  );
  return spec;
}

/** Schema-valid-shaped assemblies with colliding ids, cycles, counts and odd selectors. */
function genAssemblySpec(r: Rand): Obj {
  const IDS = ["pa", "pb", "pc", "pd", "pe"];
  const tmpl = ["t0", "t1", "t2"];
  const refs = [...tmpl, "top", "ghost"];
  const SELS = [
    "pa",
    "*",
    "**",
    "p?",
    "type:cpu",
    "**/pb",
    "pa/pb",
    "role:cover",
    "pa*",
    "tag:x",
    "pa/**",
  ];
  const parts = (depth: number): Json[] =>
    Array.from({ length: 1 + int(r, depth < 2 ? 3 : 2) }, () => {
      const p: Obj = { id: pick(r, IDS) };
      if (r() < 0.3) p["count"] = pick(r, [1, 2, 3, 8, 64]);
      if (r() < 0.2) p["use"] = pick(r, refs);
      else if (depth < 9 && r() < 0.35) p["parts"] = parts(depth + 1);
      if (r() < 0.15) p["mates"] = pick(r, IDS);
      if (r() < 0.1) p["inserts"] = pick(r, IDS);
      if (r() < 0.1) p["closeup"] = pick(r, refs);
      if (r() < 0.25) p["type"] = pick(r, ["cpu", "dimm"]);
      if (r() < 0.1) p["role"] = "cover";
      if (r() < 0.1) p["shape"] = pick(r, ["box", "hw:dimm", "cylindr", "brick:brick"]);
      if (r() < 0.05) p["params"] = { studs: true };
      if (r() < 0.1) p["image"] = pick(r, ["im", "ghost"]);
      if (r() < 0.1 && p["parts"] !== undefined) p["programs"] = programs();
      return p as unknown as Json;
    });
  const sel = (): string[] => Array.from({ length: 1 + int(r, 3) }, () => pick(r, SELS));
  const programs = (): Json[] =>
    Array.from({ length: 1 + int(r, 3) }, (_, i) =>
      r() < 0.7
        ? {
            id: `pr${i}`,
            stages: Array.from({ length: 1 + int(r, 4) }, () => ({
              parts: sel(),
              ...(r() < 0.3 ? { except: sel() } : {}),
              ...(r() < 0.2
                ? { overrides: { [pick(r, ["pa", "pa/pb", "ghost"])]: { delay: 1 } } }
                : {}),
            })),
          }
        : {
            id: `pr${i}`,
            kind: "build",
            steps: Array.from({ length: 1 + int(r, 4) }, () => ({
              add: sel(),
              ...(r() < 0.2 ? { view: 90 } : {}),
              ...(r() < 0.2 ? { subBuild: pick(r, IDS), program: "pr0" } : {}),
            })),
          },
    ) as unknown as Json[];
  const assemblies: Obj[] = tmpl.map((id) => ({
    id,
    template: true,
    parts: parts(0),
    programs: programs(),
  }));
  assemblies.push({
    id: "top",
    parts: parts(0),
    programs: programs(),
    ...(r() < 0.2 ? { closeup: pick(r, refs) } : {}),
  });
  const targets = [
    "top",
    "t0",
    "top/pa",
    "top/pa/pb",
    "top/pa-2",
    "top/closeup",
    "r1",
    "r1/s",
    "r1/s/pa",
    "ghost",
    "sb",
  ];
  const steps = Array.from({ length: 1 + int(r, 4) }, () => ({
    assembly: Array.from({ length: 1 + int(r, 3) }, () => {
      const kind = pick(r, ["explode", "implode", "build", "unbuild"]);
      return {
        [kind]: pick(r, targets),
        ...(r() < 0.3 ? { to: int(r, 6) } : {}),
        ...(r() < 0.2 && (kind === "build" || kind === "unbuild")
          ? { advance: 1 + int(r, 3) }
          : {}),
        ...(r() < 0.2 ? { program: pick(r, ["pr0", "pr1", "zz"]) } : {}),
      };
    }),
    ...(r() < 0.5 ? { focus: pick(r, targets) } : {}),
    ...(r() < 0.3 ? { set: { [pick(r, targets)]: "down" } } : {}),
  }));
  return {
    meta: { version: "1" },
    images: [{ id: "im", src: "a.png" }],
    assemblies,
    racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-2u", assembly: pick(r, refs) }] }],
    storyboards: [{ id: "sb", frames: [{ model: "im" }, { model: "im" }] }],
    steps,
  };
}

describe("fuzz: schema 1.2.0 assemblies", TIMEOUT, () => {
  const checkDiagnostics = (ds: readonly Diagnostic[], label: string): void => {
    for (const d of ds) {
      expect(d.code.length, label).toBeGreaterThan(0);
      expect(d.message.length, label).toBeGreaterThan(0);
      expect(POINTER.test(d.path), `${label}: bad pointer ${JSON.stringify(d.path)}`).toBe(true);
      expect(["error", "warning", "info"], label).toContain(d.severity);
    }
  };
  // One installed pack shape (`hw:dimm`, which rejects every param): other pack refs are unknown.
  const parts = {
    get: (ref: string) =>
      ref === "hw:dimm"
        ? {
            id: "dimm",
            type: "dimm",
            readParams: (p: Record<string, unknown>) => ({
              params: p,
              diagnostics: Object.keys(p).map((k) => ({
                severity: "error" as const,
                code: "x",
                path: `/${k}`,
                message: `Unknown param ${k}`,
              })),
            }),
          }
        : undefined,
    list: () => ["hw:dimm"],
  } as unknown as PartShapeRegistry;
  const lifted = (spec: unknown): Diagnostic[] =>
    assemblyDiagnostics(spec as PlatformCosmoSpec, LIFTED, { parts });

  test("the design examples are the seed corpus", () => {
    expect(designSpecs.length).toBeGreaterThanOrEqual(10);
  });

  test("mutated design examples: validate and the lifted checks never throw, deterministically", () => {
    const r = mulberry32(SEED + 11);
    let schemaValid = 0;
    let withAssemblyDiags = 0;
    for (let i = 0; i < RUNS * 2; i++) {
      const ex = pick(r, designSpecs);
      let spec = JSON.parse(ex.json) as Json;
      for (let m = 1 + int(r, 3); m > 0; m--) spec = mutate12(r, spec);
      const parsed = parseSpec(JSON.stringify(spec), "json").spec;
      const res = checkResult(validate(parsed), `${ex.name} case ${i}`);
      if (res.diagnostics.some((d) => d.code.startsWith("schema/"))) continue;
      schemaValid++;
      const a = lifted(parsed);
      checkDiagnostics(a, `${ex.name} case ${i}`);
      expect(JSON.stringify(lifted(parsed)), `${ex.name} case ${i}`).toBe(JSON.stringify(a));
      if (a.some((d) => d.code.startsWith("assembly/"))) withAssemblyDiags++;
    }
    expect(schemaValid, "mutants that stay schema-valid").toBeGreaterThan(RUNS / 10);
    expect(withAssemblyDiags, "mutants reporting assembly diagnostics").toBeGreaterThan(RUNS / 20);
    assertClean();
  });

  test("generated assemblies with collisions, cycles, counts and odd selectors", () => {
    const r = mulberry32(SEED + 12);
    const codes = new Set<string>();
    let valid = 0;
    for (let i = 0; i < RUNS; i++) {
      const spec = genAssemblySpec(r);
      const res = checkResult(validate(spec), `generated case ${i}`);
      if (res.diagnostics.some((d) => d.code.startsWith("schema/"))) continue;
      valid++;
      const a = lifted(spec);
      checkDiagnostics(a, `generated case ${i}`);
      expect(JSON.stringify(lifted(spec)), `generated case ${i}`).toBe(JSON.stringify(a));
      for (const d of a) codes.add(d.code);
    }
    expect(valid, "generated specs that pass the schema").toBeGreaterThan(RUNS / 2);
    // the generator reaches the main checks, not just the schema
    for (const c of [
      "assembly/duplicate-part",
      "assembly/unknown-target",
      "assembly/selector-empty",
      "assembly/template-cycle",
      "assembly/moved-twice",
      "assembly/unknown-shape",
    ]) {
      expect(codes.has(c), `generated specs reach ${c}`).toBe(true);
    }
    assertClean();
  });

  test("count 64 chains, wide templates and thousands of selectors stay bounded", () => {
    const wide = Array.from({ length: 500 }, (_, i) => ({
      id: `w${i}`,
      count: 64,
      use: i === 0 ? "t0" : "t1",
    }));
    const spec = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "t0",
          template: true,
          parts: [
            {
              id: "x",
              count: 64,
              parts: [{ id: "y", count: 64, parts: [{ id: "z", count: 64 }] }],
            },
          ],
        },
        { id: "t1", template: true, parts: [{ id: "u", use: "t0", count: 64 }] },
        {
          id: "top",
          parts: wide,
          programs: [
            {
              id: "p",
              stages: Array.from({ length: 32 }, () => ({
                parts: Array.from({ length: 64 }, (_, i) => `q-${i}-*`),
              })),
            },
          ],
        },
      ],
      steps: [{ assembly: [{ explode: "top/w0/x-1/y-2/z-3" }] }],
    };
    expect(validate(spec).diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
    const a = lifted(spec);
    expect(a.some((d) => d.code === "budget/assembly-parts" && d.severity === "error")).toBe(true);
    expect(JSON.stringify(lifted(spec))).toBe(JSON.stringify(a));
  });
});
