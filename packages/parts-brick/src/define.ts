import {
  MAX_PARAM_DIAGNOSTICS,
  MIN_DIM,
  definePack,
  finishGeometry,
  round2,
  sanitizeSize as clampSize,
  type Axis,
  type Box3,
  type ParamSpec as CoreParamSpec,
  type PartPrimitiveKind,
  type PartGeometry,
  type PartPrimitive,
  type PartShapeContext,
  type PartShapeDef,
  type PartTone,
  type QuarterTurn,
  type Vec3,
} from "@platformcosmo/core";

export { MAX_PARAM_DIAGNOSTICS, MIN_DIM };
/** Brick params are booleans and enums only. */
export type ParamSpec = Exclude<CoreParamSpec, { kind: "int" }>;

/** Validated shape params: booleans and enum strings only. */
export type BrickParams = Record<string, boolean | string>;

/** Most studs one part draws; a larger footprint gets none (the checker reports it). */
export const MAX_STUDS = 256;
/** Largest extent per axis, in stud units (x, y) or plates (z). */
export const MAX_EXTENT = 1000;
/** Most steps an inverted slope is cut into. */
export const MAX_STEPS = 16;

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

/** Millimetres per unit on x, y and z. `stud`: 8 mm studs, 3.2 mm plates (assemblies section 4). */
const UNIT_MM: Readonly<Record<string, readonly [number, number, number]>> = {
  stud: [8, 8, 3.2],
  mm: [1, 1, 1],
  cm: [10, 10, 10],
  in: [25.4, 25.4, 25.4],
  tile: [600, 600, 600],
};
const STUD_MM = UNIT_MM["stud"] as readonly [number, number, number];

/** Factors from `units` to stud units per axis, or undefined for unknown units. */
export function toStudFactors(units: unknown): readonly [number, number, number] | undefined {
  const mm =
    typeof units === "string" && Object.hasOwn(UNIT_MM, units) ? UNIT_MM[units] : undefined;
  return mm === undefined
    ? undefined
    : [mm[0] / STUD_MM[0], mm[1] / STUD_MM[1], mm[2] / STUD_MM[2]];
}

/** Scale a part authored in stud units to `f` (units per stud unit), rounding corners. */
function rescale(
  prims: readonly PartPrimitive[],
  f: readonly [number, number, number],
): PartPrimitive[] {
  return prims.map((p) => {
    const o = p.box.origin;
    const e = p.box.size;
    const lo = { x: round2(o.x * f[0]), y: round2(o.y * f[1]), z: round2(o.z * f[2]) };
    const hi = {
      x: round2((o.x + e.x) * f[0]),
      y: round2((o.y + e.y) * f[1]),
      z: round2((o.z + e.z) * f[2]),
    };
    return {
      ...p,
      box: {
        origin: lo,
        size: {
          x: Math.max(MIN_DIM, round2(hi.x - lo.x)),
          y: Math.max(MIN_DIM, round2(hi.y - lo.y)),
          z: Math.max(MIN_DIM, round2(hi.z - lo.z)),
        },
      },
    };
  });
}

/** Back-to-front order; `bounds` is everything drawn, `depthBox` the body without studs. */
export function finish(solid: Solid, scale?: readonly [number, number, number]): PartGeometry {
  const all = solid.all();
  const prims = scale === undefined ? all : rescale(all, scale);
  const body = all.filter((p) => p.kind !== "stud").map((p) => p.id);
  return finishGeometry(prims, undefined, body);
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

const pack = definePack<BrickParams>({ prefix: "brick", enumHints: true });

/** Declared params of a `brick:` shape id (`slope`), for docs and tests. */
export const paramSpecsOf = pack.paramSpecsOf as (
  shapeId: string,
) => ReadonlyMap<string, ParamSpec> | undefined;

/** Clamp a size in stud units to [MIN_DIM, MAX_EXTENT], rounded to 0.01. */
export function sanitizeSize(size: Vec3 | undefined, def: Vec3): Vec3 {
  return clampSize(size, def, MAX_EXTENT, true);
}

export function defineShape(init: ShapeInit, paint: (name: string) => string): PartShapeDef {
  const handle = pack.defineParams(init.id, init.params);
  const def: Vec3 = { x: init.size[0], y: init.size[1], z: init.size[2] };
  return {
    id: init.id,
    label: init.label,
    type: init.type,
    role: "body",
    defaultSize: def,
    defaultUnits: "stud",
    defaults: handle.defaults,
    readParams: (input) => handle.readParams(input),
    build(params, ctx) {
      const p = handle.normalize(params);
      // `ctx.size` is in the assembly's units; the shape is authored in stud units and the
      // result is scaled back, so the body fills the spec size in the assembly's units.
      const toStud = toStudFactors(ctx?.units) ?? [1, 1, 1];
      const raw = ctx?.size;
      const inStud =
        raw === undefined
          ? undefined
          : {
              x: typeof raw.x === "number" ? raw.x * toStud[0] : NaN,
              y: typeof raw.y === "number" ? raw.y * toStud[1] : NaN,
              z: typeof raw.z === "number" ? raw.z * toStud[2] : NaN,
            };
      const size = sanitizeSize(inStud, def);
      const named = p["paint"];
      // The spec color wins; the `paint` param only applies when the spec gives none.
      const color =
        ctx?.color ??
        (typeof named === "string" && named !== "default" ? (paint(named) as never) : undefined);
      const axis = ctx?.axis === "x" || ctx?.axis === "y" ? ctx.axis : "z";
      const solid = new Solid(size, ctx?.tone ?? "base", color);
      init.draw(solid, p, axis);
      const same = toStud[0] === 1 && toStud[1] === 1 && toStud[2] === 1;
      return finish(solid, same ? undefined : [1 / toStud[0], 1 / toStud[1], 1 / toStud[2]]);
    },
  };
}
