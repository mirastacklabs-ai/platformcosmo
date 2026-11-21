/**
 * Generic building blocks for part-shape packs (`hw:`, `brick:`, `auto:`, ...): param specs with
 * did-you-mean diagnostics, size clamping, a scaling primitive collector (`Draft`) and depth
 * ordered `PartGeometry` assembly. Nothing here knows a pack's shapes or params.
 */
import type {
  Axis,
  Box3,
  Diagnostic,
  PartGeometry,
  PartPrimitive,
  PartPrimitiveKind,
  PartShapeContext,
  PartShapeDef,
  PartTone,
  Vec3,
} from "../contracts/index.js";
import { depthOrder } from "../depth/index.js";
import { createProjection } from "../geometry/projection.js";
import { round2 } from "../geometry/num.js";
import { didYouMean } from "../schema/suggest.js";

/** Validated shape param value: integers, booleans and enum strings only. */
export type ParamValue = number | boolean | string;

export type ParamSpec =
  | { readonly kind: "int"; readonly min: number; readonly max: number; readonly def: number }
  | { readonly kind: "bool"; readonly def: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly def: string };

/** Smallest extent, so every box stays non-degenerate after rounding to 0.01. */
export const MIN_DIM = 0.01;

/** Most diagnostics one `readParamSpecs` call returns; the rest are summarised in one more. */
export const MAX_PARAM_DIAGNOSTICS = 20;

function describe(spec: ParamSpec): string {
  if (spec.kind === "int") return `an integer from ${spec.min} to ${spec.max}`;
  if (spec.kind === "bool") return "true or false";
  return `one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`;
}

/** Whether `v` is an allowed value for `spec`. */
export function isValidParam(spec: ParamSpec, v: unknown): boolean {
  if (spec.kind === "int") {
    return typeof v === "number" && Number.isInteger(v) && v >= spec.min && v <= spec.max;
  }
  if (spec.kind === "bool") return typeof v === "boolean";
  return typeof v === "string" && spec.values.includes(v);
}

/** Truncated, JSON-quoted text of an untrusted value; never throws (null-prototype objects, bad `toString`). */
export function quote(value: unknown): string {
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else if (value === null) text = "null";
    else if (typeof value === "object" || typeof value === "function") {
      text = Array.isArray(value) ? "an array" : "an object";
    } else if (typeof value === "symbol") text = "a symbol";
    else text = String(value);
  } catch {
    text = "(unprintable)";
  }
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
}

/**
 * Merge `input` over the defaults; invalid or unknown entries become `assembly/shape-params`
 * diagnostics (capped at `MAX_PARAM_DIAGNOSTICS`). `ref` is the full shape ref (`hw:dimm`).
 * With `enumHints`, an invalid enum string also gets a did-you-mean suggestion.
 */
export function readParamSpecs(
  ref: string,
  specs: ReadonlyMap<string, ParamSpec>,
  input: unknown,
  enumHints = false,
): { params: Record<string, ParamValue>; diagnostics: Diagnostic[] } {
  const params: Record<string, ParamValue> = {};
  for (const [k, s] of specs) params[k] = s.def;
  const diagnostics: Diagnostic[] = [];
  if (input === undefined || input === null) return { params, diagnostics };
  if (typeof input !== "object" || Array.isArray(input)) {
    diagnostics.push({
      severity: "error",
      code: "assembly/shape-params",
      path: "/params",
      message: `${ref} params must be an object (got ${Array.isArray(input) ? "an array" : typeof input}).`,
      params: { shape: ref },
    });
    return { params, diagnostics };
  }
  const src = input as Record<string, unknown>;
  const names = [...specs.keys()];
  let omitted = 0;
  const report = (d: Diagnostic): void => {
    if (diagnostics.length < MAX_PARAM_DIAGNOSTICS) diagnostics.push(d);
    else omitted++;
  };
  for (const key of Object.keys(src)) {
    const spec = specs.get(key);
    if (spec === undefined) {
      const hint = didYouMean(key, names);
      const seg = key.slice(0, 64).replace(/~/g, "~0").replace(/\//g, "~1");
      report({
        severity: "error",
        code: "assembly/shape-params",
        path: `/params/${seg}`,
        message: `${ref} has no param ${quote(key)}; known params: ${names.join(", ") || "(none)"}.`,
        ...(hint !== undefined ? { suggestion: hint } : {}),
        params: { shape: ref, param: key.slice(0, 64) },
      });
      continue;
    }
    const v = src[key];
    if (!isValidParam(spec, v)) {
      const hint =
        enumHints && spec.kind === "enum" && typeof v === "string"
          ? didYouMean(v, spec.values)
          : undefined;
      report({
        severity: "error",
        code: "assembly/shape-params",
        path: `/params/${key}`,
        message: `${ref} param "${key}" must be ${describe(spec)} (got ${quote(v)}).`,
        ...(hint !== undefined ? { suggestion: hint } : {}),
        params: { shape: ref, param: key },
      });
      continue;
    }
    params[key] = v as ParamValue;
  }
  if (omitted > 0) {
    diagnostics.push({
      severity: "error",
      code: "assembly/shape-params",
      path: "/params",
      message: `${ref}: ${omitted} more param problems omitted.`,
      params: { shape: ref, omitted },
    });
  }
  return { params, diagnostics };
}

/** Params for `build`: anything missing or invalid falls back to the default. */
export function normalizeParams(
  specs: ReadonlyMap<string, ParamSpec>,
  input: unknown,
): Record<string, ParamValue> {
  const src = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const out: Record<string, ParamValue> = {};
  for (const [k, s] of specs) {
    const v = Object.hasOwn(src, k) ? src[k] : undefined;
    out[k] = isValidParam(s, v) ? (v as ParamValue) : s.def;
  }
  return out;
}

/**
 * Per-axis size from a spec: non-positive, non-finite or missing entries fall back to `def`;
 * the rest is clamped to [MIN_DIM, max] (and rounded to 0.01 when `round`), so every origin is
 * non-negative and finite.
 */
export function sanitizeSize(size: Vec3 | undefined, def: Vec3, max: number, round = false): Vec3 {
  const f = (v: unknown, d: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) return d;
    const c = Math.min(Math.max(v, MIN_DIM), max);
    return round ? round2(c) : c;
  };
  return { x: f(size?.x, def.x), y: f(size?.y, def.y), z: f(size?.z, def.z) };
}

/**
 * Collects primitives authored at the shape's DEFAULT size and scales them to the requested
 * size, so a shape stretches with spec `size` and always fills it exactly.
 * With `swapXZ` the shape is authored in its canonical frame and mapped x <-> z (upright
 * orientation); `def` is then the swapped default.
 */
export class Draft {
  readonly prims: PartPrimitive[] = [];
  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  private readonly excluded = new Set<string>();
  constructor(
    readonly def: Vec3,
    readonly size: Vec3,
    private readonly color: PartShapeContext["color"],
    private readonly swapXZ = false,
  ) {
    this.sx = size.x / def.x;
    this.sy = size.y / def.y;
    this.sz = size.z / def.z;
  }

  /**
   * Add a primitive with its min corner at (x, y, z) and extent (w, d, h) in default-size units.
   * Corners are rounded (not extents), so faces that touch at the default size still touch at
   * any size. `core: false` keeps it out of `depthBox` (connectors, ears, handles: §9.6).
   */
  add(
    id: string,
    kind: PartPrimitiveKind,
    pos: readonly [number, number, number],
    ext: readonly [number, number, number],
    tone: PartTone,
    opts: { axis?: Axis; paint?: boolean; core?: boolean } = {},
  ): void {
    const [x, y, z] = this.swapXZ ? [pos[2], pos[1], pos[0]] : pos;
    const [w, d, h] = this.swapXZ ? [ext[2], ext[1], ext[0]] : ext;
    const axis =
      opts.axis !== undefined && this.swapXZ
        ? opts.axis === "x"
          ? "z"
          : opts.axis === "z"
            ? "x"
            : "y"
        : opts.axis;
    const fit = (o: number, e: number, s: number, max: number): [number, number] => {
      const lo = Math.min(Math.max(0, round2(o * s)), max - MIN_DIM);
      const hi = Math.min(round2((o + e) * s), max);
      return [lo, Math.max(MIN_DIM, round2(hi - lo))];
    };
    const [ox, ex] = fit(x, w, this.sx, this.size.x);
    const [oy, ey] = fit(y, d, this.sy, this.size.y);
    const [oz, ez] = fit(z, h, this.sz, this.size.z);
    if (opts.core === false) this.excluded.add(id);
    this.prims.push({
      id,
      kind,
      box: { origin: { x: ox, y: oy, z: oz }, size: { x: ex, y: ey, z: ez } },
      ...(axis !== undefined ? { axis } : {}),
      tone,
      ...(opts.paint && this.color !== undefined ? { color: this.color } : {}),
    });
  }

  /** Ids of the solid-core primitives, or undefined when every primitive is core. */
  coreIds(): string[] | undefined {
    if (this.excluded.size === 0) return undefined;
    return this.prims.filter((p) => !this.excluded.has(p.id)).map((p) => p.id);
  }
}

/** Bounding box of `prims` (infinite when empty). */
export function unionBoxes(prims: readonly PartPrimitive[]): Box3 {
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of prims) {
    for (const k of ["x", "y", "z"] as const) {
      lo[k] = Math.min(lo[k], p.box.origin[k]);
      hi[k] = Math.max(hi[k], p.box.origin[k] + p.box.size[k]);
    }
  }
  return {
    origin: lo,
    size: { x: round2(hi.x - lo.x), y: round2(hi.y - lo.y), z: round2(hi.z - lo.z) },
  };
}

const projection = createProjection();

/**
 * Back-to-front order and bounds. `bounds` is everything drawn; `depthBox` is the union of the
 * primitives whose ids are in `core` (default: all), which excludes fingers, ears, handles,
 * studs and similar features so a part seated on or against this one is not "enclosed" by it
 * (§9.6). `split` marks an open-top enclosure (not `solid`).
 */
export function finishGeometry(
  prims: readonly PartPrimitive[],
  split?: { back: readonly string[]; front: readonly string[] },
  core?: readonly string[],
): PartGeometry {
  const byId = new Map(prims.map((p) => [p.id, p]));
  const order = depthOrder(
    prims.map((p) => ({ id: p.id, box: p.box })),
    projection,
  );
  const sorted = order.map((id) => byId.get(id) as PartPrimitive);
  const coreSet = core === undefined ? undefined : new Set(core);
  const coreBox =
    coreSet === undefined ? undefined : unionBoxes(sorted.filter((p) => coreSet.has(p.id)));
  const bounds = unionBoxes(sorted);
  return {
    primitives: sorted,
    bounds,
    depthBox: coreBox ?? bounds,
    solid: split === undefined,
    ...(split !== undefined ? { split } : {}),
  };
}

export interface ShapeInit<P extends Record<string, ParamValue> = Record<string, ParamValue>> {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly role?: PartShapeDef["role"];
  /**
   * x = width, y = depth, z = height, in the pack's default units. One canonical orientation
   * per shape; use the part's `rotate` to turn it. Devices with a front put it at +y (the side
   * the iso viewer sees, as DC racks and `"front": "+y"`).
   */
  readonly size: readonly [number, number, number];
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** Map x <-> z when true (an `orientation` param); the default size is swapped with it. */
  readonly swapXZ?: (p: P) => boolean;
  /**
   * Extra advisory diagnostics for valid params (warnings, e.g. a value that will be clamped).
   * `input` is what the spec gave, so a default is never reported.
   */
  readonly check?: (p: P, input: Readonly<Record<string, unknown>>) => Diagnostic[];
  /** Author the shape at its default size; `p` is already validated. */
  readonly draw: (
    g: Draft,
    p: P,
    tone: PartTone,
  ) => { back: string[]; front: string[] } | undefined;
}

export interface PackOptions {
  /** Ref prefix, e.g. `hw` for `hw:dimm`. */
  readonly prefix: string;
  /** Suggest the closest value for a misspelt enum param. */
  readonly enumHints?: boolean;
  /** Largest extent per axis, in the pack's units (default 100000). */
  readonly maxExtent?: number;
  /** Units of `size` and `defaultSize` (default `mm`). */
  readonly units?: PartShapeDef["defaultUnits"];
}

/** The validated side of one shape's params. */
export interface ParamHandle<P extends Record<string, ParamValue>> {
  readonly specs: ReadonlyMap<string, ParamSpec>;
  /** Frozen defaults. */
  readonly defaults: Readonly<P>;
  readParams(input: unknown): { params: P; diagnostics: Diagnostic[] };
  /** Params for `build`: missing or invalid entries fall back to the default. */
  normalize(input: unknown): P;
}

export interface Pack<P extends Record<string, ParamValue>> {
  /** Register a shape's param specs under its (unprefixed) id. */
  defineParams(id: string, params: Readonly<Record<string, ParamSpec>>): ParamHandle<P>;
  /** Declared params of a shape id (`dimm`), for docs and tests. */
  paramSpecsOf(shapeId: string): ReadonlyMap<string, ParamSpec> | undefined;
  /** A `Draft`-based shape: authored at its default size and scaled to the spec size. */
  defineShape(init: ShapeInit<P>): PartShapeDef;
}

/** Shared machinery of a shape pack; `P` is the pack's params type. */
export function definePack<P extends Record<string, ParamValue> = Record<string, ParamValue>>(
  opts: PackOptions,
): Pack<P> {
  const maxExtent = opts.maxExtent ?? 100_000;
  const units = opts.units ?? "mm";
  const specsById = new Map<string, ReadonlyMap<string, ParamSpec>>();

  function defineParams(id: string, params: Readonly<Record<string, ParamSpec>>): ParamHandle<P> {
    const specs = new Map(Object.entries(params));
    specsById.set(id, specs);
    const ref = `${opts.prefix}:${id}`;
    return {
      specs,
      defaults: Object.freeze(normalizeParams(specs, {})) as Readonly<P>,
      readParams: (input) => {
        const r = readParamSpecs(ref, specs, input, opts.enumHints === true);
        return { params: r.params as P, diagnostics: r.diagnostics };
      },
      normalize: (input) => normalizeParams(specs, input) as P,
    };
  }

  function defineShape(init: ShapeInit<P>): PartShapeDef {
    const handle = defineParams(init.id, init.params);
    const def: Vec3 = { x: init.size[0], y: init.size[1], z: init.size[2] };
    return {
      id: init.id,
      label: init.label,
      type: init.type,
      ...(init.role !== undefined ? { role: init.role } : {}),
      defaultSize: def,
      defaultUnits: units,
      defaults: handle.defaults,
      readParams: (input) => {
        const r = handle.readParams(input);
        const given = typeof input === "object" && input !== null && !Array.isArray(input);
        const extra =
          given && init.check !== undefined
            ? init.check(r.params, input as Record<string, unknown>)
            : [];
        return { params: r.params, diagnostics: [...r.diagnostics, ...extra] };
      },
      build(params, ctx) {
        const p = handle.normalize(params);
        const swap = init.swapXZ?.(p) ?? false;
        const base: Vec3 = swap ? { x: def.z, y: def.y, z: def.x } : def;
        const raw = ctx?.size;
        // No spec size (the default size is passed through): use the oriented default.
        const unsized = raw?.x === def.x && raw?.y === def.y && raw?.z === def.z;
        const size = sanitizeSize(unsized ? base : raw, base, maxExtent);
        const draft = new Draft(base, size, ctx?.color, swap);
        const split = init.draw(draft, p, ctx?.tone ?? "base");
        return finishGeometry(draft.prims, split, draft.coreIds());
      },
    };
  }

  return { defineParams, paramSpecsOf: (id) => specsById.get(id), defineShape };
}
