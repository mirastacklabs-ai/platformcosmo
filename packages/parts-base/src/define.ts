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
export type HwParams = Record<string, number | boolean | string>;

export type ParamSpec =
  | { readonly kind: "int"; readonly min: number; readonly max: number; readonly def: number }
  | { readonly kind: "bool"; readonly def: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly def: string };

/** Largest accepted extent per axis (mm). Keeps every coordinate finite and exact enough. */
export const MAX_EXTENT_MM = 100_000;
const MIN_DIM = 0.01;

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

/** Truncated JSON-quoted user text, never raw-interpolated. */
function quote(value: unknown): string {
  const s = typeof value === "string" ? value : String(value);
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s);
}

/** Merge `input` over the defaults; invalid or unknown entries become diagnostics. */
export function readParamSpecs(
  shapeId: string,
  specs: ReadonlyMap<string, ParamSpec>,
  input: Readonly<Record<string, unknown>>,
): { params: HwParams; diagnostics: Diagnostic[] } {
  const params: HwParams = {};
  for (const [k, s] of specs) params[k] = s.def;
  const diagnostics: Diagnostic[] = [];
  const names = [...specs.keys()];
  for (const key of Object.keys(input)) {
    const spec = specs.get(key);
    if (spec === undefined) {
      const hint = didYouMean(key, names);
      diagnostics.push({
        severity: "error",
        code: "assembly/shape-params",
        path: `/params/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        message: `hw:${shapeId} has no param ${quote(key)}; known params: ${names.join(", ") || "(none)"}.`,
        ...(hint !== undefined ? { suggestion: hint } : {}),
        params: { shape: `hw:${shapeId}`, param: key.slice(0, 64) },
      });
      continue;
    }
    const v = input[key];
    if (!valid(spec, v)) {
      diagnostics.push({
        severity: "error",
        code: "assembly/shape-params",
        path: `/params/${key}`,
        message: `hw:${shapeId} param "${key}" must be ${describe(spec)} (got ${quote(v)}).`,
        params: { shape: `hw:${shapeId}`, param: key },
      });
      continue;
    }
    params[key] = v as number | boolean | string;
  }
  return { params, diagnostics };
}

/** Params for `build`: anything missing or out of range falls back to the default. */
function normalize(specs: ReadonlyMap<string, ParamSpec>, input: object): HwParams {
  const src = input as Record<string, unknown>;
  const out: HwParams = {};
  for (const [k, s] of specs) {
    const v = Object.hasOwn(src, k) ? src[k] : undefined;
    out[k] = valid(s, v) ? (v as number | boolean | string) : s.def;
  }
  return out;
}

function sanitizeSize(size: Vec3 | undefined, def: Vec3): Vec3 {
  const f = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_EXTENT_MM) : d;
  return { x: f(size?.x, def.x), y: f(size?.y, def.y), z: f(size?.z, def.z) };
}

/**
 * Collects primitives authored in millimetres at the shape's DEFAULT size and scales them to
 * the requested size, so a shape stretches with spec `size` and always fills it exactly.
 */
export class Draft {
  readonly prims: PartPrimitive[] = [];
  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  constructor(
    readonly def: Vec3,
    readonly size: Vec3,
    private readonly color: PartShapeContext["color"],
  ) {
    this.sx = size.x / def.x;
    this.sy = size.y / def.y;
    this.sz = size.z / def.z;
  }

  /** Add a primitive with its min corner at (x, y, z) and extent (w, d, h), default-size mm. */
  add(
    id: string,
    kind: PartPrimitiveKind,
    [x, y, z]: readonly [number, number, number],
    [w, d, h]: readonly [number, number, number],
    tone: PartTone,
    opts: { axis?: Axis; paint?: boolean } = {},
  ): void {
    const fit = (o: number, e: number, s: number, max: number): [number, number] => {
      const ro = Math.min(Math.max(0, round2(o * s)), max - MIN_DIM);
      const re = Math.max(MIN_DIM, Math.min(round2(e * s), round2(max - ro)));
      return [ro, re];
    };
    const [ox, ex] = fit(x, w, this.sx, this.size.x);
    const [oy, ey] = fit(y, d, this.sy, this.size.y);
    const [oz, ez] = fit(z, h, this.sz, this.size.z);
    this.prims.push({
      id,
      kind,
      box: { origin: { x: ox, y: oy, z: oz }, size: { x: ex, y: ey, z: ez } },
      ...(opts.axis !== undefined ? { axis: opts.axis } : {}),
      tone,
      ...(opts.paint && this.color !== undefined ? { color: this.color } : {}),
    });
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

/** Back-to-front order and bounds; `split` marks an open-top enclosure (not `solid`). */
export function finish(
  draft: Draft,
  split?: { back: readonly string[]; front: readonly string[] },
): PartGeometry {
  const prims = draft.prims;
  const byId = new Map(prims.map((p) => [p.id, p]));
  const order = depthOrder(
    prims.map((p) => ({ id: p.id, box: p.box })),
    projection,
  );
  const sorted = order.map((id) => byId.get(id) as PartPrimitive);
  const box = union(sorted);
  return {
    primitives: sorted,
    bounds: box,
    depthBox: box,
    solid: split === undefined,
    ...(split !== undefined ? { split } : {}),
  };
}

export interface ShapeInit {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly role?: PartShapeDef["role"];
  /** x = width, y = depth (front to back), z = height; millimetres. */
  readonly size: readonly [number, number, number];
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** Author the shape at its default size; `p` is already validated. */
  readonly draw: (
    g: Draft,
    p: HwParams,
    tone: PartTone,
  ) => { back: string[]; front: string[] } | undefined;
}

const specsById = new Map<string, ReadonlyMap<string, ParamSpec>>();

/** Declared params of an `hw:` shape id (`dimm`), for docs and tests. */
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
      const r = readParamSpecs(init.id, specs, input ?? {});
      return { params: r.params, diagnostics: r.diagnostics };
    },
    build(params, ctx) {
      const size = sanitizeSize(ctx?.size, def);
      const draft = new Draft(def, size, ctx?.color);
      const split = init.draw(draft, normalize(specs, params ?? {}), ctx?.tone ?? "base");
      return finish(draft, split);
    },
  };
}
