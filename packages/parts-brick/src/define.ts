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
  type QuarterTurn,
  type Vec3,
} from "@platformcosmo/core";

/** Validated shape params: booleans and enum strings only. */
export type BrickParams = Record<string, boolean | string>;

export type ParamSpec =
  | { readonly kind: "bool"; readonly def: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly def: string };

/** Most studs one part draws; a larger footprint gets none (the checker reports it). */
export const MAX_STUDS = 256;
/** Largest extent per axis, in stud units (x, y) or plates (z). */
export const MAX_EXTENT = 1000;
/** Smallest extent, so every box stays non-degenerate after rounding to 0.01. */
export const MIN_DIM = 0.01;
/** Most steps an inverted slope is cut into. */
export const MAX_STEPS = 16;
/** Most diagnostics one `readParams` call returns; the rest are summarised in one more. */
export const MAX_PARAM_DIAGNOSTICS = 20;

function describe(spec: ParamSpec): string {
  if (spec.kind === "bool") return "true or false";
  return `one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`;
}

function valid(spec: ParamSpec, v: unknown): boolean {
  if (spec.kind === "bool") return typeof v === "boolean";
  return typeof v === "string" && spec.values.includes(v);
}

/** Truncated, JSON-quoted text of an untrusted value; never throws. */
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

/** Merge `input` over the defaults; invalid or unknown entries become diagnostics. */
export function readParamSpecs(
  shapeId: string,
  specs: ReadonlyMap<string, ParamSpec>,
  input: unknown,
): { params: BrickParams; diagnostics: Diagnostic[] } {
  const ref = `brick:${shapeId}`;
  const params: BrickParams = {};
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
    if (!valid(spec, v)) {
      const hint =
        spec.kind === "enum" && typeof v === "string" ? didYouMean(v, spec.values) : undefined;
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
    params[key] = v as boolean | string;
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
function normalize(specs: ReadonlyMap<string, ParamSpec>, input: unknown): BrickParams {
  const src = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const out: BrickParams = {};
  for (const [k, s] of specs) {
    const v = Object.hasOwn(src, k) ? src[k] : undefined;
    out[k] = valid(s, v) ? (v as boolean | string) : s.def;
  }
  return out;
}

function sanitizeSize(size: Vec3 | undefined, def: Vec3): Vec3 {
  const f = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? round2(Math.min(Math.max(v, MIN_DIM), MAX_EXTENT))
      : d;
  return { x: f(size?.x, def.x), y: f(size?.y, def.y), z: f(size?.z, def.z) };
}

export interface PrimOpts {
  readonly axis?: Axis;
  readonly rotate?: QuarterTurn;
}

/**
 * Collects the primitives of one part, authored directly in stud units (x, y studs; z plates)
 * at the requested size. Corners are rounded to 0.01 (not extents), so faces that touch stay
 * touching at any size. Studs are kept apart: they extend `bounds` but not `depthBox`.
 */
export class Solid {
  private readonly core: PartPrimitive[] = [];
  private readonly studs: PartPrimitive[] = [];
  constructor(
    readonly size: Vec3,
    private readonly tone: PartTone,
    private readonly color: PartShapeContext["color"],
  ) {}

  private box(
    pos: readonly [number, number, number],
    ext: readonly [number, number, number],
  ): Box3 {
    const fit = (o: number, e: number, max: number): [number, number] => {
      const lo = Math.min(Math.max(0, round2(o)), max - MIN_DIM);
      const hi = Math.min(round2(o + e), max);
      return [lo, Math.max(MIN_DIM, round2(hi - lo))];
    };
    const [ox, ex] = fit(pos[0], ext[0], this.size.x);
    const [oy, ey] = fit(pos[1], ext[1], this.size.y);
    const [oz, ez] = fit(pos[2], ext[2], this.size.z);
    return { origin: { x: ox, y: oy, z: oz }, size: { x: ex, y: ey, z: ez } };
  }

  /** Add a body primitive with its min corner at `pos` and extent `ext` (stud units, plates). */
  add(
    id: string,
    kind: PartPrimitiveKind,
    pos: readonly [number, number, number],
    ext: readonly [number, number, number],
    opts: PrimOpts = {},
  ): Box3 {
    const box = this.box(pos, ext);
    this.core.push({
      id,
      kind,
      box,
      ...(opts.axis !== undefined ? { axis: opts.axis } : {}),
      ...(opts.rotate !== undefined ? { rotate: opts.rotate } : {}),
      tone: this.tone,
      ...(this.color !== undefined ? { color: this.color } : {}),
    });
    return box;
  }

  /** Add already-built studs, corners rounded; they are not part of `depthBox`. */
  addStuds(studs: readonly PartPrimitive[]): void {
    for (const s of studs) {
      const { origin: o, size: e } = s.box;
      const lo = { x: round2(o.x), y: round2(o.y), z: round2(o.z) };
      const hi = { x: round2(o.x + e.x), y: round2(o.y + e.y), z: round2(o.z + e.z) };
      this.studs.push({
        ...s,
        box: {
          origin: lo,
          size: {
            x: Math.max(MIN_DIM, round2(hi.x - lo.x)),
            y: Math.max(MIN_DIM, round2(hi.y - lo.y)),
            z: Math.max(MIN_DIM, round2(hi.z - lo.z)),
          },
        },
      });
    }
  }

  /** Body primitives (everything except studs). */
  get body(): readonly PartPrimitive[] {
    return this.core;
  }

  /** Tone and colour for `studGrid`, so studs match the body. */
  get style(): { tone: PartTone; color?: NonNullable<PartShapeContext["color"]> } {
    return { tone: this.tone, ...(this.color !== undefined ? { color: this.color } : {}) };
  }

  all(): PartPrimitive[] {
    return [...this.core, ...this.studs];
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

/** Back-to-front order; `bounds` is everything drawn, `depthBox` the body without studs. */
export function finish(solid: Solid): PartGeometry {
  const prims = solid.all();
  const byId = new Map(prims.map((p) => [p.id, p]));
  const order = depthOrder(
    prims.map((p) => ({ id: p.id, box: p.box })),
    projection,
  );
  return {
    primitives: order.map((id) => byId.get(id) as PartPrimitive),
    bounds: union(prims),
    depthBox: union(solid.body),
    solid: true,
  };
}

export interface ShapeInit {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  /** [width, depth, plates] in stud units. */
  readonly size: readonly [number, number, number];
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** Author the shape at `solid.size`; `p` is already validated. */
  readonly draw: (solid: Solid, p: BrickParams, axis: Axis) => void;
}

const specsById = new Map<string, ReadonlyMap<string, ParamSpec>>();

/** Declared params of a `brick:` shape id (`slope`), for docs and tests. */
export function paramSpecsOf(shapeId: string): ReadonlyMap<string, ParamSpec> | undefined {
  return specsById.get(shapeId);
}

export function defineShape(init: ShapeInit, paint: (name: string) => string): PartShapeDef {
  const specs = new Map(Object.entries(init.params));
  specsById.set(init.id, specs);
  const def: Vec3 = { x: init.size[0], y: init.size[1], z: init.size[2] };
  const defaults = Object.freeze(normalize(specs, {}));
  return {
    id: init.id,
    label: init.label,
    type: init.type,
    role: "body",
    defaultSize: def,
    defaultUnits: "stud",
    defaults,
    readParams: (input) => {
      const r = readParamSpecs(init.id, specs, input);
      return { params: r.params, diagnostics: r.diagnostics };
    },
    build(params, ctx) {
      const p = normalize(specs, params);
      const size = sanitizeSize(ctx?.size, def);
      const named = p["paint"];
      // The spec color wins; the `paint` param only applies when the spec gives none.
      const color =
        ctx?.color ??
        (typeof named === "string" && named !== "default" ? (paint(named) as never) : undefined);
      const axis = ctx?.axis === "x" || ctx?.axis === "y" ? ctx.axis : "z";
      const solid = new Solid(size, ctx?.tone ?? "base", color);
      init.draw(solid, p, axis);
      return finish(solid);
    },
  };
}
