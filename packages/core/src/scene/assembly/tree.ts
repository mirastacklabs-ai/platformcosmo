/**
 * Assembly scene tree (Track A2, A2-2; design docs/design/assemblies.md §4, §5, §9.5, §10, §13).
 *
 * Resolves `spec.assemblies` into `SceneAssembly` values: `count`/`pitch`/`use` expansion (ids
 * as the validation tree of A2-1, `schema/assembly-tree.ts`, so a path validates exactly when it
 * exists here), quarter-turn rotations, leaf geometry, rest boxes, roles, `mates` and `inserts`,
 * the frame (units, `fit`, true scale) and the below-ground lift.
 *
 * Budgets first: `AssemblyModel.metrics` sizes every assembly from the spec (saturating, cycle
 * safe, memoized) before anything is expanded, and an assembly is built only when it fits the
 * §13 leaf and node budgets, so `count: 64` seven deep or a `use` cycle allocates nothing.
 * Validation owns the diagnostics for over-budget and malformed specs; here an unusable
 * assembly is skipped and nothing throws. Pure and deterministic: spec order everywhere,
 * numbers rounded to 9 decimals (`rnd`).
 *
 * Interpretations (see the PR): children are relative to their parent's `at` (not re-anchored);
 * a `use` instance re-anchors the template's bounds at `at` and scales them to `size`; a
 * sub-assembly with `parts` ignores `size`; a rotated part swaps the axis of x/y circular
 * primitives; a pack shape is built unrotated and its geometry then turned.
 */
import type {
  AssemblyFrame,
  AssemblyUnits,
  AssetSource,
  Axis,
  Box3,
  Diagnostic,
  FrontSide,
  ImageAssetResolver,
  PartGeometry,
  PartImagePlacement,
  PartPrimitive,
  PartPrimitiveKind,
  PartRole,
  PartShapeDef,
  PartShapeRegistry,
  PartShapePack,
  QuarterTurn,
  Rect,
  SceneAssemblies,
  SceneAssembly,
  SceneAssemblyNode,
  Vec3,
} from "../../contracts/index.js";
import { CIRCULAR_KINDS, partGeometry, reassignSplit } from "../../geometry/parts.js";
import { AssemblyModel, LEAF_ERROR, MAX_DEPTH } from "../../schema/assembly-tree.js";
import type { PlatformCosmoSpec, SpecPart, SpecState } from "../../schema/types.gen.js";
import { TILE_MM, belowGroundLift, frameMap, makeFrame, rnd, unionBoxes, unitMm } from "./frame.js";
import { toSource } from "./source.js";
import { classifySiblings, type LBox, type RoleItem } from "./roles.js";

/** Gap between assemblies placed in a row, in tiles (as `DC_GAP` in `scene/index.ts`). */
export const ASSEMBLY_GAP = 2;

export interface AssemblyBuildOptions {
  /** Installed pack shapes (`hw:`, `auto:`, `brick:`); absent: pack refs fall back to a box. */
  readonly parts?: PartShapeRegistry;
  /** DC pack shapes, for `dc:` refs the registry does not name. */
  readonly dcShapes?: PartShapePack;
  /** Prepared images, for the whole-image crop of a part image without a crop. */
  readonly images?: ImageAssetResolver;
  /** Spec color to scene color (`palette:<name>` / `flow:<name>` / hex); default: see `plainColor`. */
  readonly color?: (c: string) => string | undefined;
  /** Where the row of assemblies starts: x, y of the first reach footprint (default 0, 0). */
  readonly origin?: { readonly x: number; readonly y: number };
  /** True scale (DC slot or close-up context): `fit` is ignored. */
  readonly trueScale?: boolean;
  /** Lift the frame so reach bounds start at z = 0 (default true; DC racks are not lifted). */
  readonly lift?: boolean;
  /**
   * Reach bounds of an assembly placed at the origin and not yet lifted (A2-3 supplies the swept
   * boxes of its programs); the rest bounds when absent. The result is unioned with the rest
   * bounds.
   */
  readonly reach?: (assembly: SceneAssembly) => Box3 | undefined;
}

export interface AssemblyBuild extends SceneAssemblies {
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------------------------
// Draft tree (local units, mutable until placed)
// ---------------------------------------------------------------------------------------------

interface MBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

interface Draft {
  readonly id: string;
  readonly path: string;
  /** JSON pointer of the defining spec part. */
  readonly ptr: string;
  readonly kind: "leaf" | "sub";
  readonly part: SpecPart;
  readonly b: MBox;
  /** Quarter turns applied to this node and its ancestors, mod 4. */
  turns: number;
  readonly children: Draft[];
  readonly state: SpecState;
  readonly def?: PartShapeDef;
  geometry?: PartGeometry;
  role: PartRole;
  mates?: string;
  inserts?: string;
}

const copyBox = (b: MBox): MBox => ({ ...b });
const toBox3 = (b: LBox): Box3 => ({
  origin: { x: rnd(b.x0), y: rnd(b.y0), z: rnd(b.z0) },
  size: { x: rnd(b.x1 - b.x0), y: rnd(b.y1 - b.y0), z: rnd(b.z1 - b.z0) },
});

function unionOf(boxes: readonly LBox[]): MBox | undefined {
  if (boxes.length === 0) return undefined;
  const u = copyBox(boxes[0] as LBox);
  for (const b of boxes) {
    u.x0 = Math.min(u.x0, b.x0);
    u.y0 = Math.min(u.y0, b.y0);
    u.z0 = Math.min(u.z0, b.z0);
    u.x1 = Math.max(u.x1, b.x1);
    u.y1 = Math.max(u.y1, b.y1);
    u.z1 = Math.max(u.z1, b.z1);
  }
  return u;
}

function translate(d: Draft, dx: number, dy: number, dz: number): void {
  d.b.x0 += dx;
  d.b.x1 += dx;
  d.b.y0 += dy;
  d.b.y1 += dy;
  d.b.z0 += dz;
  d.b.z1 += dz;
  for (const c of d.children) translate(c, dx, dy, dz);
}

/** Rotates a box about (cx, cy) by `q` quarter turns, counter-clockwise seen from +z. */
function rotateBox(b: MBox, q: number, cx: number, cy: number): void {
  const { x0, y0, x1, y1 } = b;
  switch (q % 4) {
    case 1:
      b.x0 = cx - (y1 - cy);
      b.x1 = cx - (y0 - cy);
      b.y0 = cy + (x0 - cx);
      b.y1 = cy + (x1 - cx);
      break;
    case 2:
      b.x0 = 2 * cx - x1;
      b.x1 = 2 * cx - x0;
      b.y0 = 2 * cy - y1;
      b.y1 = 2 * cy - y0;
      break;
    case 3:
      b.x0 = cx + (y0 - cy);
      b.x1 = cx + (y1 - cy);
      b.y0 = cy - (x1 - cx);
      b.y1 = cy - (x0 - cx);
      break;
    default:
  }
}

function rotateTree(d: Draft, q: number, cx: number, cy: number): void {
  rotateBox(d.b, q, cx, cy);
  d.turns = (d.turns + q) % 4;
  for (const c of d.children) rotateTree(c, q, cx, cy);
}

/** Turns a part about its own box centre; the rotated box keeps the original min corner. */
function turnPart(d: Draft, q: number): void {
  if (q % 4 === 0) return;
  const { x0, y0 } = d.b;
  rotateTree(d, q, (d.b.x0 + d.b.x1) / 2, (d.b.y0 + d.b.y1) / 2);
  translate(d, x0 - d.b.x0, y0 - d.b.y0, 0);
}

function scaleTree(d: Draft, tmin: Vec3, off: readonly [number, number, number], f: Vec3): void {
  d.b.x0 = off[0] + (d.b.x0 - tmin.x) * f.x;
  d.b.x1 = off[0] + (d.b.x1 - tmin.x) * f.x;
  d.b.y0 = off[1] + (d.b.y0 - tmin.y) * f.y;
  d.b.y1 = off[1] + (d.b.y1 - tmin.y) * f.y;
  d.b.z0 = off[2] + (d.b.z0 - tmin.z) * f.z;
  d.b.z1 = off[2] + (d.b.z1 - tmin.z) * f.z;
  for (const c of d.children) scaleTree(c, tmin, off, f);
}

// ---------------------------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------------------------

const PRIMITIVES: ReadonlySet<string> = new Set<PartPrimitiveKind>([
  "box",
  "plate",
  "prism",
  "wedge",
  "card",
  "cylinder",
  "shaft",
  "stud",
  "ring",
  "tray",
  "sprite",
]);

interface Ctx {
  readonly spec: PlatformCosmoSpec;
  readonly model: AssemblyModel;
  readonly opts: AssemblyBuildOptions;
  /** Assemblies being expanded (the host and the templates above this point): cycle guard. */
  readonly stack: number[];
  readonly diagnostics: Diagnostic[];
  readonly units: AssemblyUnits;
}

const vec = (v: readonly number[] | undefined, d: number): [number, number, number] => [
  v?.[0] ?? d,
  v?.[1] ?? d,
  v?.[2] ?? d,
];

function lookupShape(ctx: Ctx, ref: string): PartShapeDef | undefined {
  const reg = ctx.opts.parts?.get(ref);
  if (reg !== undefined) return reg;
  const dc = ctx.opts.dcShapes;
  return dc === undefined ? undefined : dc.shapes.find((s) => `${dc.id}:${s.id}` === ref);
}

/** `defaultSize` of a pack shape in the host assembly's units (per-axis mm conversion). */
function defaultSizeIn(def: PartShapeDef, host: AssemblyUnits): [number, number, number] {
  const from = unitMm(def.defaultUnits);
  const to = unitMm(host);
  return [
    (def.defaultSize.x * from.x) / to.x,
    (def.defaultSize.y * from.y) / to.y,
    (def.defaultSize.z * from.z) / to.z,
  ];
}

/** Does expanding `use` of template `t` from path level `level` stay inside the path limit? */
function usable(ctx: Ctx, t: number | undefined, level: number): t is number {
  return (
    t !== undefined &&
    !ctx.stack.includes(t) &&
    ctx.model.fits(t) &&
    level + ctx.model.metrics(t).height <= MAX_DEPTH - 1
  );
}

function expandList(
  ctx: Ctx,
  parts: readonly SpecPart[],
  base: string,
  parentPath: string,
  level: number,
  origin: readonly [number, number, number],
  inherited: SpecState,
  out: Draft[],
): void {
  const seen = new Set<string>();
  parts.forEach((p, k) => {
    const ptr = `${base}/${k}`;
    const n = p.count ?? 1;
    const at = vec(p.at, 0);
    const pitch = vec(p.pitch, 0);
    for (let c = 1; c <= n; c++) {
      const id = n > 1 ? `${p.id}-${c}` : p.id;
      if (seen.has(id)) continue; // duplicate sibling: reported by validation, first wins
      seen.add(id);
      const off: [number, number, number] = [
        origin[0] + at[0] + (c - 1) * pitch[0],
        origin[1] + at[1] + (c - 1) * pitch[1],
        origin[2] + at[2] + (c - 1) * pitch[2],
      ];
      out.push(partDraft(ctx, p, id, ptr, parentPath, level, off, inherited));
    }
  });
}

function partDraft(
  ctx: Ctx,
  p: SpecPart,
  id: string,
  ptr: string,
  parentPath: string,
  level: number,
  off: readonly [number, number, number],
  inherited: SpecState,
): Draft {
  const path = `${parentPath}/${id}`;
  const state = p.state ?? inherited;
  const q = ((p.rotate ?? 0) / 90) % 4;
  const children: Draft[] = [];
  const own = (b: MBox): Draft => ({
    id,
    path,
    ptr,
    kind: "sub",
    part: p,
    b,
    turns: 0,
    children,
    state,
    role: "internal",
  });

  // `size` on a sub-assembly with `parts` is ignored: its box is the union of its children
  if (p.parts !== undefined) {
    if (level < MAX_DEPTH - 1) {
      expandList(ctx, p.parts, `${ptr}/parts`, path, level + 1, off, state, children);
    }
    const b = unionOf(children.map((c) => c.b)) ?? zeroBox(off);
    const d = own(b);
    turnPart(d, q);
    return d;
  }

  if (p.use !== undefined) {
    const t = ctx.model.byId.get(p.use);
    if (usable(ctx, t, level)) {
      const tpl = ctx.model.assemblies[t];
      if (tpl !== undefined) {
        // the template is expanded in ITS units (inner `use` ratios and default sizes are
        // relative to them); only the template-to-host ratio is applied below
        const tctx: Ctx = { ...ctx, units: (tpl.units ?? "mm") as AssemblyUnits };
        ctx.stack.push(t);
        expandList(
          tctx,
          tpl.parts,
          `/assemblies/${t}/parts`,
          path,
          level + 1,
          [0, 0, 0],
          state,
          children,
        );
        ctx.stack.pop();
        const tb = unionOf(children.map((c) => c.b)) ?? zeroBox([0, 0, 0]);
        const tm = unitMm(tpl.units ?? "mm");
        const hm = unitMm(ctx.units);
        const ratio = { x: tm.x / hm.x, y: tm.y / hm.y, z: tm.z / hm.z };
        const ts = { x: tb.x1 - tb.x0, y: tb.y1 - tb.y0, z: tb.z1 - tb.z0 };
        const f =
          p.size === undefined
            ? ratio
            : {
                x: ts.x > 0 ? p.size[0] / ts.x : ratio.x,
                y: ts.y > 0 ? p.size[1] / ts.y : ratio.y,
                z: ts.z > 0 ? p.size[2] / ts.z : ratio.z,
              };
        const d = own(zeroBox(off));
        for (const c of children) scaleTree(c, { x: tb.x0, y: tb.y0, z: tb.z0 }, off, f);
        const b = unionOf(children.map((c) => c.b)) ?? zeroBox(off);
        Object.assign(d.b, b);
        turnPart(d, q);
        return d;
      }
    }
    // unresolved, cyclic, over budget or too deep: an opaque group (validation reports it)
    const sz = vec(p.size, 0);
    const d = own({
      x0: off[0],
      y0: off[1],
      z0: off[2],
      x1: off[0] + sz[0],
      y1: off[1] + sz[1],
      z1: off[2] + sz[2],
    });
    turnPart(d, q);
    return d;
  }

  // leaf
  const ref = p.shape ?? "box";
  const def = ref.includes(":") ? lookupShape(ctx, ref) : undefined;
  const sz =
    p.size !== undefined
      ? vec(p.size, 1)
      : def !== undefined
        ? defaultSizeIn(def, ctx.units)
        : ([1, 1, 1] as [number, number, number]);
  const leaf: Draft = {
    id,
    path,
    ptr,
    kind: "leaf",
    part: p,
    b: {
      x0: off[0],
      y0: off[1],
      z0: off[2],
      x1: off[0] + sz[0],
      y1: off[1] + sz[1],
      z1: off[2] + sz[2],
    },
    turns: 0,
    children,
    state,
    ...(def === undefined ? {} : { def }),
    role: "internal",
  };
  turnPart(leaf, q);
  return leaf;
}

const zeroBox = (o: readonly [number, number, number]): MBox => ({
  x0: o[0],
  y0: o[1],
  z0: o[2],
  x1: o[0],
  y1: o[1],
  z1: o[2],
});

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

const swapAxis = (a: Axis): Axis => (a === "x" ? "y" : a === "y" ? "x" : "z");

function orientBox(b: Box3, q: number, size: Vec3): Box3 {
  const m: MBox = {
    x0: b.origin.x,
    y0: b.origin.y,
    z0: b.origin.z,
    x1: b.origin.x + b.size.x,
    y1: b.origin.y + b.size.y,
    z1: b.origin.z + b.size.z,
  };
  const cx = size.x / 2;
  const cy = size.y / 2;
  rotateBox(m, q, cx, cy);
  const odd = q % 2 === 1;
  const sx = (odd ? size.y : size.x) / 2 - cx;
  const sy = (odd ? size.x : size.y) / 2 - cy;
  return toBox3({ x0: m.x0 + sx, y0: m.y0 + sy, z0: m.z0, x1: m.x1 + sx, y1: m.y1 + sy, z1: m.z1 });
}

/** Turns a pack shape's geometry (built unrotated, size `unrot`) by `q` quarter turns. */
function orientGeometry(g: PartGeometry, q: number, unrot: Vec3): PartGeometry {
  if (q % 4 === 0) return g;
  const primitives: PartPrimitive[] = g.primitives.map((p) => ({
    ...p,
    box: orientBox(p.box, q, unrot),
    ...(p.axis === undefined || !CIRCULAR_KINDS.has(p.kind) || q % 2 === 0
      ? {}
      : { axis: swapAxis(p.axis) }),
    ...(p.kind === "wedge"
      ? { rotate: ((((p.rotate ?? 0) / 90 + q) % 4) * 90) as QuarterTurn }
      : {}),
  }));
  const images = turnImages(g.images, q);
  return reassignSplit({
    ...g,
    primitives,
    bounds: orientBox(g.bounds, q, unrot),
    depthBox: orientBox(g.depthBox, q, unrot),
    ...(images === undefined ? {} : { images }),
  });
}

/** +x, +y, -x, -y in turn order: a quarter turn moves a face one step. */
const FACE_CYCLE = ["+x", "+y", "-x", "-y"] as const;

/**
 * Decal faces follow a turn: `right` (+x) and `left` (+y) move round the cycle; a decal whose
 * face turns away from the viewer (-x, -y) cannot be drawn and is dropped. Billboards and
 * `top` are unaffected.
 */
function turnImages(images: PartGeometry["images"], q: number): PartGeometry["images"] | undefined {
  if (images === undefined) return undefined;
  const out: PartImagePlacement[] = [];
  for (const im of images) {
    if (im.face !== "left" && im.face !== "right") {
      out.push(im);
      continue;
    }
    const at = FACE_CYCLE.indexOf(im.face === "right" ? "+x" : "+y");
    const to = FACE_CYCLE[(at + q) % 4];
    if (to === "+x") out.push({ ...im, face: "right" });
    else if (to === "+y") out.push({ ...im, face: "left" });
  }
  return out;
}

interface Used {
  readonly images: Set<string>;
  readonly credits: AssetSource[];
  readonly creditKeys: Set<string>;
}

function credit(used: Used, s: AssetSource | undefined): void {
  if (s === undefined) return;
  const key = JSON.stringify(s);
  if (used.creditKeys.has(key)) return;
  used.creditKeys.add(key);
  used.credits.push(s);
}

function placement(ctx: Ctx, p: SpecPart, used: Used): PartImagePlacement | undefined {
  const img = p.image;
  if (img === undefined) return undefined;
  const ref = typeof img === "string" ? img : img.ref;
  const spec = (ctx.spec.images ?? []).find((i) => i.id === ref);
  if (spec === undefined) return undefined; // `image/unknown` is reported by validation
  used.images.add(ref);
  credit(used, toSource(spec.source));
  const own = typeof img === "string" ? undefined : img;
  const c = own?.crop ?? spec.crop;
  const asset = ctx.opts.images?.get(ref);
  const crop: Rect | undefined =
    c !== undefined
      ? { x: c[0], y: c[1], width: c[2], height: c[3] }
      : asset !== undefined
        ? { x: 0, y: 0, width: asset.width, height: asset.height }
        : undefined;
  if (crop === undefined) return undefined; // whole-image crop needs the asset's size
  return { image: ref, face: own?.face ?? "billboard", crop, fit: own?.fit ?? "contain" };
}

const plainColor = (c: string): string => (c.startsWith("#") ? c.toLowerCase() : `palette:${c}`);

function leafGeometry(ctx: Ctx, d: Draft, used: Used): PartGeometry | undefined {
  const p = d.part;
  const rot = {
    x: d.b.x1 - d.b.x0,
    y: d.b.y1 - d.b.y0,
    z: d.b.z1 - d.b.z0,
  };
  const odd = d.turns % 2 === 1;
  const unrot = odd ? { x: rot.y, y: rot.x, z: rot.z } : rot;
  const tone = p.tone ?? "base";
  const color = p.color === undefined ? undefined : (ctx.opts.color ?? plainColor)(p.color);
  const image = placement(ctx, p, used);
  const images = image === undefined ? undefined : [image];
  const axis = p.axis ?? "z";
  try {
    if (d.def !== undefined) {
      const params = d.def.readParams(p.params ?? {}).params;
      const g = d.def.build(params, {
        size: unrot,
        units: ctx.units,
        axis,
        tone,
        ...(color === undefined ? {} : { color }),
        state: d.state,
      });
      const o = orientGeometry(g, d.turns, unrot);
      return images !== undefined && o.images === undefined ? { ...o, images } : o;
    }
    const ref = p.shape ?? "box";
    const kind = (PRIMITIVES.has(ref) ? ref : "box") as PartPrimitiveKind;
    return partGeometry({
      kind,
      size: rot,
      ...(CIRCULAR_KINDS.has(kind) ? { axis: odd ? swapAxis(axis) : axis } : {}),
      ...(kind === "wedge" ? { rotate: (d.turns * 90) as QuarterTurn } : {}),
      tone,
      ...(color === undefined ? {} : { color }),
      ...(images === undefined ? {} : { images }),
    });
  } catch (e) {
    ctx.diagnostics.push({
      severity: "warning",
      code: "assembly/shape-params",
      path: d.ptr,
      message: `Part ${JSON.stringify(d.path)} has no usable geometry: ${e instanceof Error ? e.message : String(e)}`,
      suggestion: "Check the part's shape, size and params",
      params: { part: d.path },
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Roles, mates, inserts per sibling group
// ---------------------------------------------------------------------------------------------

/** Scene path of the node `rel` names below `parent` (spec `mates`/`inserts`), if it exists. */
function resolveRel(parent: Draft, rel: string | undefined): string | undefined {
  if (rel === undefined) return undefined;
  let node = parent;
  for (const seg of rel.split("/")) {
    const next = node.children.find((c) => c.id === seg);
    if (next === undefined) return undefined;
    node = next;
  }
  return node === parent ? undefined : node.path;
}

function infer(parent: Draft): void {
  if (parent.children.length === 0) return;
  const items: RoleItem[] = parent.children.map((c) => {
    const role = c.part.role ?? c.def?.role;
    const type = c.part.type ?? c.def?.type;
    const mates = resolveRel(parent, c.part.mates);
    const inserts = resolveRel(parent, c.part.inserts);
    return {
      path: c.path,
      kind: c.kind,
      box: c.b,
      ...(type === undefined ? {} : { type }),
      ...(c.part.shape === undefined ? {} : { shape: c.part.shape }),
      ...(role === undefined ? {} : { role }),
      solid: c.geometry?.solid === true,
      ...(mates === undefined ? {} : { mates }),
      ...(inserts === undefined ? {} : { inserts }),
    };
  });
  const result = classifySiblings(items);
  for (const c of parent.children) {
    const r = result.get(c.path);
    if (r === undefined) continue;
    c.role = r.role;
    if (r.mates !== undefined && r.mates !== c.path) c.mates = r.mates;
    if (r.inserts !== undefined && r.inserts !== c.path) c.inserts = r.inserts;
    infer(c);
  }
}

// ---------------------------------------------------------------------------------------------
// Preparation and placement
// ---------------------------------------------------------------------------------------------

interface Prepared {
  readonly index: number;
  readonly root: Draft;
  readonly units: AssemblyUnits;
  readonly localBounds: Box3;
  readonly leaves: Draft[];
}

function collectLeaves(d: Draft, out: Draft[]): void {
  for (const c of d.children) {
    if (c.kind === "leaf") out.push(c);
    else collectLeaves(c, out);
  }
}

function prepare(ctx: Ctx, index: number, used: Used, rootPath?: string): Prepared | undefined {
  const a = ctx.model.assemblies[index];
  if (a === undefined) return undefined;
  const children: Draft[] = [];
  const state = a.state ?? "healthy";
  // a close-up instance is rooted at its own path (`<host>/closeup`, A2-5); depth counts it
  const path = rootPath ?? a.id;
  const depth = path.split("/").length;
  ctx.stack.push(index);
  expandList(ctx, a.parts, `/assemblies/${index}/parts`, path, depth, [0, 0, 0], state, children);
  ctx.stack.pop();
  const root: Draft = {
    id: path.slice(path.lastIndexOf("/") + 1),
    path,
    ptr: `/assemblies/${index}`,
    kind: "sub",
    part: { id: a.id },
    b: zeroBox([0, 0, 0]),
    turns: 0,
    children,
    state,
    role: "body",
  };
  const leaves: Draft[] = [];
  collectLeaves(root, leaves);
  for (const l of leaves) l.geometry = leafGeometry(ctx, l, used);
  infer(root);
  const lb =
    unionOf(leaves.length > 0 ? leaves.map((l) => l.b) : children.map((c) => c.b)) ??
    zeroBox([0, 0, 0]);
  Object.assign(root.b, lb);
  return { index, root, units: ctx.units, localBounds: toBox3(lb), leaves };
}

const rd = (d: SpecPart["detail"]): readonly string[] => (d === undefined ? [] : [...d]);

function place(
  prep: Prepared,
  frame: AssemblyFrame,
  a: { label?: string; closeup?: string; source?: SpecPart["source"] },
): SceneAssembly {
  const map = frameMap(frame, prep.localBounds);
  const mk = (d: Draft, isRoot: boolean): SceneAssemblyNode => {
    const kids = d.children.map((c) => mk(c, false));
    const local = toBox3(d.b);
    let world: Box3;
    if (d.kind === "leaf") {
      const g = d.geometry;
      world =
        g === undefined
          ? map.box(local)
          : map.box({
              origin: {
                x: d.b.x0 + g.depthBox.origin.x,
                y: d.b.y0 + g.depthBox.origin.y,
                z: d.b.z0 + g.depthBox.origin.z,
              },
              size: g.depthBox.size,
            });
    } else {
      world = unionBoxes(kids.map((k) => k.world)) ?? map.box(local);
    }
    const p = d.part;
    const type = p.type ?? d.def?.type;
    const label = isRoot ? a.label : p.label;
    const closeup = isRoot ? a.closeup : p.closeup;
    const source = isRoot ? a.source : p.source;
    const src = toSource(source);
    return {
      path: d.path,
      id: d.id,
      kind: d.kind,
      ...(type === undefined ? {} : { type }),
      tags: [...new Set(p.tags ?? [])].sort(),
      role: d.role,
      ...(label === undefined ? {} : { label }),
      detail: rd(p.detail),
      ...(p.badge === undefined ? {} : { badge: p.badge }),
      state: d.state,
      local,
      world,
      ...(d.geometry === undefined ? {} : { geometry: d.geometry }),
      ...(d.mates === undefined ? {} : { mates: d.mates }),
      ...(d.inserts === undefined ? {} : { inserts: d.inserts }),
      ...(closeup === undefined ? {} : { closeup }),
      ...(src === undefined ? {} : { source: src }),
      children: kids,
    };
  };
  const root = mk(prep.root, true);
  const leafPaths: string[] = [];
  const walk = (n: SceneAssemblyNode): void => {
    for (const c of n.children) {
      if (c.kind === "leaf") leafPaths.push(c.path);
      else walk(c);
    }
  };
  walk(root);
  const bounds: Box3[] = [];
  for (const l of prep.leaves) {
    const g = l.geometry;
    bounds.push(
      map.box(
        g === undefined
          ? toBox3(l.b)
          : {
              origin: {
                x: l.b.x0 + g.bounds.origin.x,
                y: l.b.y0 + g.bounds.origin.y,
                z: l.b.z0 + g.bounds.origin.z,
              },
              size: g.bounds.size,
            },
      ),
    );
  }
  const restBounds = unionBoxes(bounds) ?? map.box(prep.localBounds);
  return {
    id: prep.root.path,
    source: "spec",
    ...(a.label === undefined ? {} : { label: a.label }),
    frame,
    root,
    leaves: leafPaths,
    programs: [],
    basePose: [],
    restBounds,
    reachBounds: restBounds,
  };
}

const shift = (b: Box3, dx: number, dy: number, dz: number): Box3 => ({
  origin: { x: rnd(b.origin.x + dx), y: rnd(b.origin.y + dy), z: rnd(b.origin.z + dz) },
  size: b.size,
});

export interface TemplateInstanceOptions extends AssemblyBuildOptions {
  /** Extra quarter turn of the instance, added to the template's own `rotate`. */
  readonly turn?: QuarterTurn;
  /**
   * Decides the instance's turn and uniform fit from the template's size in millimetres (local
   * bounds x unit, the template's own `rotate` applied) once it is expanded: close-ups reconcile
   * sizes with it (`closeup.ts`). `fit` is a factor on the true-scale frame (1 = true scale).
   */
  readonly adapt?: (
    sizeMm: Vec3,
    units: AssemblyUnits,
  ) => { readonly turn?: QuarterTurn; readonly fit?: number };
  /** Leaves the expansion may add (the caller's remaining budget); over it, nothing is built. */
  readonly leafBudget?: number;
}

export interface TemplateInstance {
  readonly assembly: SceneAssembly;
  /** Index of the template in `spec.assemblies`. */
  readonly index: number;
  readonly leafCount: number;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * One instance of the assembly `templateId` rooted at the scene path `path` (a close-up,
 * assemblies §8.4): paths are `<path>/<part>/…`, units are true scale unless `adapt` fits it,
 * and it stands at the origin (rest and reach bounds start at x = y = 0, z lifted). Nothing is
 * built (undefined) for an unknown, over-budget or cyclic template, or beyond `leafBudget`.
 */
export function buildTemplateInstance(
  spec: PlatformCosmoSpec,
  model: AssemblyModel,
  templateId: string,
  path: string,
  opts: TemplateInstanceOptions = {},
): TemplateInstance | undefined {
  const i = model.byId.get(templateId);
  const a = i === undefined ? undefined : (spec.assemblies ?? [])[i];
  if (i === undefined || a === undefined || !model.fits(i)) return undefined;
  const leaves = model.metrics(i).leaves;
  if (leaves > (opts.leafBudget ?? LEAF_ERROR)) return undefined;
  const diagnostics: Diagnostic[] = [];
  const used: Used = { images: new Set(), credits: [], creditKeys: new Set() };
  const units = (a.units ?? "mm") as AssemblyUnits;
  const ctx: Ctx = { spec, model, opts, stack: [], diagnostics, units };
  const prep = prepare(ctx, i, used, path);
  if (prep === undefined) return undefined;
  const base = (a.rotate ?? 0) as QuarterTurn;
  const lb = prep.localBounds.size;
  const mm = unitMm(units);
  const odd = base === 90 || base === 270;
  const sizeMm = {
    x: odd ? lb.y * mm.y : lb.x * mm.x,
    y: odd ? lb.x * mm.x : lb.y * mm.y,
    z: lb.z * mm.z,
  };
  const asked = opts.adapt?.(sizeMm, units);
  const turn = ((((base + (asked?.turn ?? opts.turn ?? 0)) % 360) + 360) % 360) as QuarterTurn;
  const k = asked?.fit;
  // a uniform factor on true scale: `fit` (tiles of the largest horizontal extent) = k x its true size
  const extentMm = Math.max(lb.x * mm.x, lb.y * mm.y);
  const fit =
    k !== undefined && k !== 1 && k > 0 && Number.isFinite(k) && extentMm > 0
      ? (k * extentMm) / TILE_MM
      : undefined;
  const frameOf = (origin: Vec3): AssemblyFrame =>
    makeFrame({
      units,
      ...(fit === undefined ? {} : { fit }),
      front: (a.front ?? "+y") as FrontSide,
      rotate: turn,
      localBounds: prep.localBounds,
      ...(fit === undefined ? { trueScale: true } : {}),
      origin,
    });
  const meta = {
    ...(a.label === undefined ? {} : { label: a.label }),
    ...(a.closeup === undefined ? {} : { closeup: a.closeup }),
    ...(a.source === undefined ? {} : { source: a.source }),
  };
  const probe = place(prep, frameOf({ x: 0, y: 0, z: 0 }), meta);
  const extra = opts.reach?.(probe);
  const reach0 = unionBoxes(
    extra === undefined ? [probe.restBounds] : [probe.restBounds, extra],
  ) as Box3;
  const lift = opts.lift === false ? 0 : belowGroundLift(reach0);
  const ox = -reach0.origin.x;
  const oy = -reach0.origin.y;
  const placed = place(prep, frameOf({ x: ox, y: oy, z: lift }), meta);
  const assembly: SceneAssembly = {
    ...placed,
    ...(a.program === undefined ? {} : { defaultProgram: a.program }),
    reachBounds: shift(reach0, ox, oy, lift),
  };
  return { assembly, index: i, leafCount: prep.leaves.length, diagnostics };
}

/**
 * Resolves every non-template spec assembly. Assemblies without `pos` stand in a row along +x
 * starting at `opts.origin`, spaced by their reach footprint (so an exploded unit never lands on
 * a neighbour); `pos` places the rest bounds' minimum corner (x, y; the drawn extent including
 * overhangs such as studs, not the frame origin).
 */
export function buildAssemblies(
  spec: PlatformCosmoSpec,
  opts: AssemblyBuildOptions = {},
): AssemblyBuild {
  const list = spec.assemblies ?? [];
  const diagnostics: Diagnostic[] = [];
  const used: Used = { images: new Set(), credits: [], creditKeys: new Set() };
  const out: SceneAssembly[] = [];
  if (list.length === 0) {
    return { assemblies: [], boards: [], plan: [], images: [], credits: [], diagnostics };
  }
  const model = new AssemblyModel(spec);
  let budget = LEAF_ERROR;
  let cx = opts.origin?.x ?? 0;
  const cy = opts.origin?.y ?? 0;

  list.forEach((a, i) => {
    if (a.template === true || model.byId.get(a.id) !== i) return;
    const leaves = model.metrics(i).leaves;
    if (!model.fits(i) || leaves > budget) return; // reported by validation (budget/assembly-parts)
    budget -= leaves;
    const units = (a.units ?? "mm") as AssemblyUnits;
    const ctx: Ctx = { spec, model, opts, stack: [], diagnostics, units };
    const prep = prepare(ctx, i, used);
    if (prep === undefined) return;

    const frameOf = (origin: Vec3): AssemblyFrame =>
      makeFrame({
        units,
        ...(a.fit === undefined ? {} : { fit: a.fit }),
        front: (a.front ?? "+y") as FrontSide,
        rotate: (a.rotate ?? 0) as QuarterTurn,
        localBounds: prep.localBounds,
        ...(opts.trueScale === true ? { trueScale: true } : {}),
        origin,
      });
    const meta = {
      ...(a.label === undefined ? {} : { label: a.label }),
      ...(a.closeup === undefined ? {} : { closeup: a.closeup }),
      ...(a.source === undefined ? {} : { source: a.source }),
    };

    // measure at the origin, unlifted: rest bounds start at (0, 0, 0)
    const probe = place(prep, frameOf({ x: 0, y: 0, z: 0 }), meta);
    const asked = opts.reach?.(probe);
    const reach0 = unionBoxes(
      asked === undefined ? [probe.restBounds] : [probe.restBounds, asked],
    ) as Box3;
    const lift = opts.lift === false ? 0 : belowGroundLift(reach0);
    // the probe frame sits at the origin, so a frame origin of (ox, oy) moves everything by it:
    // a row places the reach footprint's min corner at the cursor, `pos` the REST bounds' one
    // (which can differ from the frame origin when a pack shape's bounds start below its box)
    const ox = a.pos === undefined ? cx - reach0.origin.x : a.pos.x - probe.restBounds.origin.x;
    const oy = a.pos === undefined ? cy - reach0.origin.y : a.pos.y - probe.restBounds.origin.y;

    const placed = place(prep, frameOf({ x: ox, y: oy, z: lift }), meta);
    const reach = shift(reach0, ox, oy, lift);
    out.push({
      ...placed,
      ...(a.program === undefined ? {} : { defaultProgram: a.program }),
      reachBounds: reach,
    });
    if (a.pos === undefined) cx = rnd(reach.origin.x + reach.size.x + ASSEMBLY_GAP);

    for (const l of prep.leaves) credit(used, toSource(l.part.source));
    credit(used, toSource(a.source));
  });

  out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return {
    assemblies: out,
    boards: [],
    plan: [],
    images: [...used.images].sort(),
    credits: used.credits,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------------------------
// Scene integration helpers
// ---------------------------------------------------------------------------------------------

/** Every node of an assembly, depth first in spec order, root first. */
export function assemblyNodes(a: SceneAssembly): SceneAssemblyNode[] {
  const out: SceneAssemblyNode[] = [];
  const walk = (n: SceneAssemblyNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(a.root);
  return out;
}

/** Rest-pose world boxes of every assembly, sub-assembly and part path (`SceneGraph.focusTargets`). */
export function assemblyFocusTargets(list: readonly SceneAssembly[]): Map<string, Box3> {
  const out = new Map<string, Box3>();
  for (const a of list) for (const n of assemblyNodes(a)) out.set(n.path, n.world);
  return out;
}

/** Initial states of every assembly node by path (`SceneStep.states` may key them). */
export function assemblyStates(list: readonly SceneAssembly[]): Map<string, SpecState> {
  const out = new Map<string, SpecState>();
  for (const a of list) for (const n of assemblyNodes(a)) out.set(n.path, n.state);
  return out;
}

/** Merges assembly content into another `SceneAssemblies` (figures), keeping every order. */
export function mergeSceneAssemblies(
  asm: SceneAssemblies,
  other: SceneAssemblies | undefined,
): SceneAssemblies {
  if (other === undefined) {
    // a plain `SceneAssemblies`: an `AssemblyBuild` also carries its diagnostics
    const { assemblies, boards, plan, images, credits } = asm;
    return { assemblies, boards, plan, images, credits };
  }
  const keys = new Set(asm.credits.map((c) => JSON.stringify(c)));
  return {
    assemblies: [...asm.assemblies, ...other.assemblies].sort((p, q) =>
      p.id < q.id ? -1 : p.id > q.id ? 1 : 0,
    ),
    boards: [...asm.boards, ...other.boards].sort((p, q) =>
      p.id < q.id ? -1 : p.id > q.id ? 1 : 0,
    ),
    plan: other.plan.length > 0 ? other.plan : asm.plan,
    images: [...new Set([...asm.images, ...other.images])].sort(),
    credits: [...asm.credits, ...other.credits.filter((c) => !keys.has(JSON.stringify(c)))],
  };
}
