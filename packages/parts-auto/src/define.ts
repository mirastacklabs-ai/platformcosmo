import {
  createProjection,
  depthOrder,
  didYouMean,
  round2,
  type Axis,
  type Box3,
  type Diagnostic,
  type PartGeometry,
  type PartPrimitive,
  type PartPrimitiveKind,
  type PartShapeContext,
  type PartShapeDef,
  type PartTone,
  type Vec3,
} from "@platformcosmo/core";

/** Validated shape params: integers, booleans and enum strings only. */
export type AutoParams = Record<string, number | boolean | string>;

export type ParamSpec =
  | { readonly kind: "int"; readonly min: number; readonly max: number; readonly def: number }
  | { readonly kind: "bool"; readonly def: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly def: string };

/**
 * Extent limits per axis. Pack shapes expect real length units (mm, cm or in): coordinates are
 * rounded to 2 decimals of the unit, so a part a few hundredths of a unit across degenerates.
 * Sizes are clamped to [MIN_DIM, MAX_EXTENT_MM] so every origin is non-negative and finite.
 */
export const MAX_EXTENT_MM = 100_000;
export const MIN_DIM = 0.01;

function describe(spec: ParamSpec): string {
  if (spec.kind === "int") return `an integer from ${spec.min} to ${spec.max}`;
  if (spec.kind === "bool") return "true or false";
  return `one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`;
}

function valid(spec: ParamSpec, v: unknown): boolean {
  if (spec.kind === "int") {
    return typeof v === "number" && Number.isInteger(v) && v >= spec.min && v <= spec.max;
  }
  if (spec.kind === "bool") return typeof v === "boolean";
  return typeof v === "string" && spec.values.includes(v);
}

/** Truncated, JSON-quoted text of an untrusted value; never throws (null-prototype objects, bad `toString`). */
function quote(value: unknown): string {
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

/** Most diagnostics one `readParams` call returns; the rest are summarised in one more. */
export const MAX_PARAM_DIAGNOSTICS = 20;

/** Merge `input` over the defaults; invalid or unknown entries become diagnostics. */
export function readParamSpecs(
  shapeId: string,
  specs: ReadonlyMap<string, ParamSpec>,
  input: unknown,
): { params: AutoParams; diagnostics: Diagnostic[] } {
  const params: AutoParams = {};
  for (const [k, s] of specs) params[k] = s.def;
  const diagnostics: Diagnostic[] = [];
  if (input === undefined || input === null) return { params, diagnostics };
  if (typeof input !== "object" || Array.isArray(input)) {
    diagnostics.push({
      severity: "error",
      code: "assembly/shape-params",
      path: "/params",
      message: `auto:${shapeId} params must be an object (got ${Array.isArray(input) ? "an array" : typeof input}).`,
      params: { shape: `auto:${shapeId}` },
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
        message: `auto:${shapeId} has no param ${quote(key)}; known params: ${names.join(", ") || "(none)"}.`,
        ...(hint !== undefined ? { suggestion: hint } : {}),
        params: { shape: `auto:${shapeId}`, param: key.slice(0, 64) },
      });
      continue;
    }
    const v = src[key];
    if (!valid(spec, v)) {
      report({
        severity: "error",
        code: "assembly/shape-params",
        path: `/params/${key}`,
        message: `auto:${shapeId} param "${key}" must be ${describe(spec)} (got ${quote(v)}).`,
        params: { shape: `auto:${shapeId}`, param: key },
      });
      continue;
    }
    params[key] = v as number | boolean | string;
  }
  if (omitted > 0) {
    diagnostics.push({
      severity: "error",
      code: "assembly/shape-params",
      path: "/params",
      message: `auto:${shapeId}: ${omitted} more param problems omitted.`,
      params: { shape: `auto:${shapeId}`, omitted },
    });
  }
  return { params, diagnostics };
}

/** Params for `build`: anything missing or out of range falls back to the default. */
function normalize(specs: ReadonlyMap<string, ParamSpec>, input: unknown): AutoParams {
  const src = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const out: AutoParams = {};
  for (const [k, s] of specs) {
    const v = Object.hasOwn(src, k) ? src[k] : undefined;
    out[k] = valid(s, v) ? (v as number | boolean | string) : s.def;
  }
  return out;
}

function sanitizeSize(size: Vec3 | undefined, def: Vec3): Vec3 {
  const f = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? Math.min(Math.max(v, MIN_DIM), MAX_EXTENT_MM)
      : d;
  return { x: f(size?.x, def.x), y: f(size?.y, def.y), z: f(size?.z, def.z) };
}

/**
 * Collects primitives authored in millimetres at the shape's DEFAULT size and scales them to
 * the requested size, so a shape stretches with spec `size` and always fills it exactly.
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
   * Add a primitive with its min corner at (x, y, z) and extent (w, d, h) in default-size mm.
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

function union(prims: readonly PartPrimitive[]): Box3 {
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
 * `core` primitives (default: all), which excludes fingers, ears, handles and similar features
 * so a part seated on or against this one is not "enclosed" by it (§9.6, like brick studs).
 * `split` marks an open-top enclosure (not `solid`).
 */
export function finish(
  draft: Draft,
  split?: { back: readonly string[]; front: readonly string[] },
  core?: readonly string[],
): PartGeometry {
  const prims = draft.prims;
  const byId = new Map(prims.map((p) => [p.id, p]));
  const order = depthOrder(
    prims.map((p) => ({ id: p.id, box: p.box })),
    projection,
  );
  const sorted = order.map((id) => byId.get(id) as PartPrimitive);
  const coreSet = core === undefined ? undefined : new Set(core);
  const coreBox =
    coreSet === undefined ? undefined : union(sorted.filter((p) => coreSet.has(p.id)));
  const bounds = union(sorted);
  return {
    primitives: sorted,
    bounds,
    depthBox: coreBox ?? bounds,
    solid: split === undefined,
    ...(split !== undefined ? { split } : {}),
  };
}

export interface ShapeInit {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly role?: PartShapeDef["role"];
  /**
   * x = width, y = depth, z = height; millimetres. One canonical orientation per shape; use
   * the part's `rotate` to turn it. Devices with a front put it at +y (the side the iso viewer
   * sees, as DC racks and `"front": "+y"`).
   */
  readonly size: readonly [number, number, number];
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** Map x <-> z when true (an `orientation` param); the default size is swapped with it. */
  readonly swapXZ?: (p: AutoParams) => boolean;
  /** Author the shape at its default size; `p` is already validated. */
  readonly draw: (
    g: Draft,
    p: AutoParams,
    tone: PartTone,
  ) => { back: string[]; front: string[] } | undefined;
}

const specsById = new Map<string, ReadonlyMap<string, ParamSpec>>();

/** Declared params of an `auto:` shape id (`piston`), for docs and tests. */
export function paramSpecsOf(shapeId: string): ReadonlyMap<string, ParamSpec> | undefined {
  return specsById.get(shapeId);
}

export function defineShape(init: ShapeInit): PartShapeDef {
  const specs = new Map(Object.entries(init.params));
  specsById.set(init.id, specs);
  const def: Vec3 = { x: init.size[0], y: init.size[1], z: init.size[2] };
  const defaults = Object.freeze(normalize(specs, {}));
  return {
    id: init.id,
    label: init.label,
    type: init.type,
    ...(init.role !== undefined ? { role: init.role } : {}),
    defaultSize: def,
    defaultUnits: "mm",
    defaults,
    readParams: (input) => {
      const r = readParamSpecs(init.id, specs, input);
      return { params: r.params, diagnostics: r.diagnostics };
    },
    build(params, ctx) {
      const p = normalize(specs, params);
      const swap = init.swapXZ?.(p) ?? false;
      const base: Vec3 = swap ? { x: def.z, y: def.y, z: def.x } : def;
      const raw = ctx?.size;
      // No spec size (the default size is passed through): use the oriented default.
      const unsized = raw?.x === def.x && raw?.y === def.y && raw?.z === def.z;
      const size = sanitizeSize(unsized ? base : raw, base);
      const draft = new Draft(base, size, ctx?.color, swap);
      const split = init.draw(draft, p, ctx?.tone ?? "base");
      return finish(draft, split, draft.coreIds());
    },
  };
}
