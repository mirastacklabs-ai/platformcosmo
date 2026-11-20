/**
 * Leaves in WORLD space (docs/design/assemblies.md §4, §5, §9.1): the geometry the tree resolved
 * is in the part's frame (local units, origin at the part's minimum corner, part `rotate`
 * already applied); here it gets the node's offset, the frame's scale and quarter turn, and
 * becomes depth items. Pure; a leaf whose geometry cannot be mapped is skipped (nothing throws).
 */
import type {
  Box3,
  PartGeometry,
  PartImagePlacement,
  PartPrimitive,
  QuarterTurn,
  SceneAssembly,
  SceneAssemblyNode,
  Vec3,
} from "../../contracts/index.js";
import type { DepthItemInput } from "../../depth/epochs.js";
import { CIRCULAR_KINDS, halfOf, reassignSplit } from "../../geometry/parts.js";
import { frameMap } from "../../scene/assembly/frame.js";
import { assemblyNodes } from "../../scene/assembly/tree.js";

/** A leaf with its geometry in world space (rest pose, frame applied). */
export interface WorldLeaf {
  readonly assembly: string;
  readonly node: SceneAssemblyNode;
  readonly path: string;
  readonly geometry: PartGeometry;
  /** World `depthBox` at rest (the node's `world`). */
  readonly depthBox: Box3;
}

const FACE_CYCLE = ["+x", "+y", "-x", "-y"] as const;

function turnImages(
  images: readonly PartImagePlacement[] | undefined,
  q: number,
): PartImagePlacement[] | undefined {
  if (images === undefined) return undefined;
  const out: PartImagePlacement[] = [];
  for (const im of images) {
    if (q % 4 === 0 || (im.face !== "left" && im.face !== "right")) {
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

const swap = (a: "x" | "y" | "z"): "x" | "y" | "z" => (a === "x" ? "y" : a === "y" ? "x" : a);

const turnRotate = (r: QuarterTurn | undefined, q: number): QuarterTurn =>
  ((((r ?? 0) / 90 + q) % 4) * 90) as QuarterTurn;

/** Leaves of every assembly in world space, assembly order then tree order. */
export function worldLeaves(assemblies: readonly SceneAssembly[]): WorldLeaf[] {
  const out: WorldLeaf[] = [];
  for (const asm of assemblies) {
    const map = frameMap(asm.frame, asm.root.local);
    const q = (asm.frame.rotate / 90) % 4;
    for (const node of assemblyNodes(asm)) {
      if (node.kind !== "leaf" || node.geometry === undefined) continue;
      const g = node.geometry;
      const o = node.local.origin;
      const lift = (b: Box3): Box3 =>
        map.box({
          origin: { x: o.x + b.origin.x, y: o.y + b.origin.y, z: o.z + b.origin.z },
          size: b.size,
        });
      const primitives: PartPrimitive[] = g.primitives.map((p) => ({
        ...p,
        box: lift(p.box),
        ...(p.axis === undefined || !CIRCULAR_KINDS.has(p.kind) || q % 2 === 0
          ? {}
          : { axis: swap(p.axis) }),
        ...(p.kind === "wedge" ? { rotate: turnRotate(p.rotate, q) } : {}),
      }));
      const images = turnImages(g.images, q);
      const geometry: PartGeometry = reassignSplit({
        ...g,
        primitives,
        bounds: lift(g.bounds),
        depthBox: node.world,
        ...(images === undefined ? {} : { images }),
      });
      out.push({ assembly: asm.id, node, path: node.path, geometry, depthBox: node.world });
    }
  }
  return out;
}

const bounds3 = (boxes: readonly Box3[]): Box3 => {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.origin.x);
    y0 = Math.min(y0, b.origin.y);
    z0 = Math.min(z0, b.origin.z);
    x1 = Math.max(x1, b.origin.x + b.size.x);
    y1 = Math.max(y1, b.origin.y + b.size.y);
    z1 = Math.max(z1, b.origin.z + b.size.z);
  }
  return { origin: { x: x0, y: y0, z: z0 }, size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 } };
};

const sameBox = (a: Box3, b: Box3): boolean => {
  const e = 1e-6;
  return (
    Math.abs(a.origin.x - b.origin.x) < e &&
    Math.abs(a.origin.y - b.origin.y) < e &&
    Math.abs(a.origin.z - b.origin.z) < e &&
    Math.abs(a.size.x - b.size.x) < e &&
    Math.abs(a.size.y - b.size.y) < e &&
    Math.abs(a.size.z - b.size.z) < e
  );
};

/** Item key of a half of a split leaf. */
export const halfKey = (path: string, half: "back" | "front"): string => `${path}__${half}`;

/**
 * Depth items (§9.1) of the leaves: one per leaf, two for a split leaf (`tray`, `ring`). `fills`:
 * the solid is one `box`, `plate` or `card` primitive whose box is the depth box (§9.5).
 */
export function depthItems(leaves: readonly WorldLeaf[]): DepthItemInput[] {
  const out: DepthItemInput[] = [];
  for (const l of leaves) {
    const g = l.geometry;
    const base = { path: l.path, leaf: l.path } as const;
    if (g.split !== undefined) {
      for (const half of ["back", "front"] as const) {
        const prims = g.primitives.filter((p) => halfOf(g, p.id) === half);
        if (prims.length === 0) continue;
        const ring = prims.every((p) => p.kind === "ring");
        out.push({
          key: halfKey(l.path, half),
          ...base,
          box: bounds3(prims.map((p) => p.box)),
          ...(ring ? { ring: half } : { boxes: prims.map((p) => p.box) }),
        });
      }
      continue;
    }
    // Studs standing entirely above the top face do not stop a brick from filling its box (§5.1).
    const top = l.depthBox.origin.z + l.depthBox.size.z;
    const body = g.primitives.filter((p) => !(p.kind === "stud" && p.box.origin.z >= top - 1e-6));
    const only = body.length === 1 ? body[0] : undefined;
    const fills =
      only !== undefined &&
      (only.kind === "box" || only.kind === "plate" || only.kind === "card") &&
      sameBox(only.box, l.depthBox);
    out.push({
      key: l.path,
      ...base,
      box: l.depthBox,
      solid: g.solid,
      ...(fills ? { fills: true } : {}),
      ...(l.node.inserts === undefined ? {} : { inserts: l.node.inserts }),
    });
  }
  return out;
}

export const addVec = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
