/**
 * `dc:` part shapes (assemblies.md 5, Track E-1): the 15 rack devices as single-leaf shapes, so
 * a server, switch or storage shelf can sit inside any assembly (`"shape": "dc:server-2u"`).
 *
 * One canonical orientation like `hw:`: x width, y depth, z height, the front at +y, in
 * millimetres. A device is one leaf of many primitives, back to front (`depthSort`); the
 * size in `PartShapeContext` scales it per axis. Vendor-neutral boxes only, no params.
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
  PartShapePack,
  PrimitiveKind,
  ScenePart,
  Vec3,
} from "@platformcosmo/core";
import { deviceDefs } from "./components/devices.js";
import { depthSort } from "./sort.js";
import { MM_PER_TILE } from "./units.js";

/** Tiles to millimetres, rounded to micrometres (removes the 4-decimal tile grid noise). */
export const tileToMm = (t: number): number => Math.round(t * MM_PER_TILE * 1e6) / 1e6 + 0;

const KIND: Readonly<Record<PrimitiveKind, PartPrimitiveKind>> = {
  cube: "box",
  slab: "plate",
  platform: "box",
  "hex-prism": "prism",
  cylinder: "cylinder",
};

/** Part primitive kind of a DC scene primitive. */
export const partKind = (p: PrimitiveKind): PartPrimitiveKind => KIND[p];

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;

/** Largest extent a `size` override may take, in millimetres (as `hw:`). */
const MAX_MM = 100_000;

export interface DeviceScale {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Geometry of component-local scene parts (tiles) in millimetres times `scale`, back to front.
 * `bounds` and `depthBox` are the union of the parts (LEDs and rails sit inside the chassis
 * box, so nothing is excluded from the depth box).
 */
export function partsGeometry(
  parts: readonly ScenePart[],
  scale: DeviceScale = { x: 1, y: 1, z: 1 },
): PartGeometry {
  const primitives: PartPrimitive[] = [];
  let x1 = 0;
  let y1 = 0;
  let z1 = 0;
  for (const p of depthSort(parts)) {
    const o = p.box.origin;
    const s = p.box.size;
    const box: Box3 = {
      origin: {
        x: r6(tileToMm(o.x) * scale.x),
        y: r6(tileToMm(o.y) * scale.y),
        z: r6(tileToMm(o.z) * scale.z),
      },
      size: {
        x: r6(tileToMm(s.x) * scale.x),
        y: r6(tileToMm(s.y) * scale.y),
        z: r6(tileToMm(s.z) * scale.z),
      },
    };
    const kind = partKind(p.primitive);
    const axis: Axis = "z";
    primitives.push({
      id: p.id,
      kind,
      box,
      ...(kind === "cylinder" || kind === "prism" ? { axis } : {}),
      tone: p.tone,
    });
    x1 = Math.max(x1, box.origin.x + box.size.x);
    y1 = Math.max(y1, box.origin.y + box.size.y);
    z1 = Math.max(z1, box.origin.z + box.size.z);
  }
  const bounds: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: x1, y: y1, z: z1 } };
  return { primitives, bounds, depthBox: bounds, solid: true };
}

function readParams(params: Readonly<Record<string, unknown>>): {
  readonly params: Record<string, unknown>;
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const keys = Object.keys(params ?? {});
  for (const key of keys.slice(0, 20)) {
    const seg = key.slice(0, 64).replace(/~/g, "~0").replace(/\//g, "~1");
    diagnostics.push({
      severity: "error",
      code: "assembly/shape-params",
      path: `/params/${seg}`,
      message: `dc shapes take no params (got "${key.slice(0, 64)}"); size the part with "size".`,
      params: { param: key.slice(0, 64) },
    });
  }
  if (keys.length > 20) {
    diagnostics.push({
      severity: "error",
      code: "assembly/shape-params",
      path: "/params",
      message: `${keys.length - 20} more param problems omitted.`,
    });
  }
  return { params: {}, diagnostics };
}

/** Default size (mm) of every device: its bounds at the type's rack height. */
function defaultSizeOf(type: string): Vec3 {
  const def = deviceDefs.find((d) => d.type === type);
  const built = def?.build({ ...def.defaults }, { id: type, state: "healthy" });
  const s = built?.bounds.size ?? { x: 1, y: 1, z: 1 };
  return { x: tileToMm(s.x), y: tileToMm(s.y), z: tileToMm(s.z) };
}

const clampSize = (v: number, d: number): number =>
  Number.isFinite(v) && v > 0 ? Math.min(v, MAX_MM) : d;

function shapeOf(type: string, label: string): PartShapeDef {
  const defaultSize = defaultSizeOf(type);
  return {
    id: type,
    label,
    type,
    role: "body",
    defaultSize,
    defaultUnits: "mm",
    defaults: {},
    readParams,
    build(_params: Record<string, unknown>, ctx: PartShapeContext): PartGeometry {
      const def = deviceDefs.find((d) => d.type === type);
      if (def === undefined) return partsGeometry([]);
      const built = def.build({ ...def.defaults }, { id: type, state: ctx.state });
      // ctx.size is in ctx.units and so is the geometry returned
      const s = {
        x: clampSize(ctx.size.x * unitMm(ctx.units).x, defaultSize.x),
        y: clampSize(ctx.size.y * unitMm(ctx.units).y, defaultSize.y),
        z: clampSize(ctx.size.z * unitMm(ctx.units).z, defaultSize.z),
      };
      const mm = partsGeometry(built.parts, {
        x: s.x / defaultSize.x,
        y: s.y / defaultSize.y,
        z: s.z / defaultSize.z,
      });
      return scaleToUnits(mm, unitMm(ctx.units));
    },
  };
}

export function unitMm(units: PartShapeContext["units"]): Vec3 {
  switch (units) {
    case "mm":
      return { x: 1, y: 1, z: 1 };
    case "cm":
      return { x: 10, y: 10, z: 10 };
    case "in":
      return { x: 25.4, y: 25.4, z: 25.4 };
    case "tile":
      return { x: MM_PER_TILE, y: MM_PER_TILE, z: MM_PER_TILE };
    case "stud":
      return { x: 8, y: 8, z: 3.2 };
  }
}

/** Divides millimetre geometry by millimetres per unit, per axis. */
function scaleToUnits(g: PartGeometry, m: Vec3): PartGeometry {
  const sb = (b: Box3): Box3 => ({
    origin: { x: r6(b.origin.x / m.x), y: r6(b.origin.y / m.y), z: r6(b.origin.z / m.z) },
    size: { x: r6(b.size.x / m.x), y: r6(b.size.y / m.y), z: r6(b.size.z / m.z) },
  });
  return {
    ...g,
    primitives: g.primitives.map((p) => ({ ...p, box: sb(p.box) })),
    bounds: sb(g.bounds),
    depthBox: sb(g.depthBox),
  };
}

const LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  deviceDefs.map((d) => [d.type, d.label]),
);

export const dcShapes: readonly PartShapeDef[] = deviceDefs.map((d) =>
  shapeOf(d.type, LABELS[d.type] ?? d.type),
);

export const dcShapePack: PartShapePack = {
  id: "dc",
  name: "Data-center devices",
  license: "Apache-2.0",
  shapes: dcShapes,
};
