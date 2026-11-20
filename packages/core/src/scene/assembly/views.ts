/**
 * Quarter-turn view scenes (Track A2, A2-5; design docs/design/assemblies.md §7.7, §13).
 *
 * `view` on a build step (assembly-only specs) rotates the scene by -v about the assembly's rest
 * centre. Each used view is a COMPLETE scene of its own (the render projects and depth-sorts it
 * separately into its `view(v)` group and cross-fades the groups over 0.3 s at the step's
 * start), so `viewScenes` returns the placed assemblies rotated by -v: world boxes, frames,
 * bounds and the world-space offsets of every program move. Local boxes and part geometry are
 * untouched (the frame carries the turn, as for the assembly's own `rotate`). Decals on faces
 * stay in the data (their `face` is assembly-local, the renderer maps it through the frame). View 0 is the input itself (same objects), so a spec
 * without views is untouched.
 *
 * Several assemblies turn rigidly about the centre of their union (one assembly: its own rest
 * centre), so a row of assemblies keeps its layout. Pure and deterministic; the number of views
 * is at most four by construction. Nothing here throws.
 */
import type {
  Box3,
  Diagnostic,
  QuarterTurn,
  ResolvedProgram,
  SceneAssembly,
  SceneAssemblyNode,
  Vec3,
} from "../../contracts/index.js";
import type { PlatformCosmoSpec, SpecPart } from "../../schema/types.gen.js";
import { ELEMENT_WARN, assemblyElements } from "./levels.js";
import { frameMap, rnd, turnFront, unionBoxes } from "./frame.js";

/** Distinct views of a scene: the four quarter turns. */
export const MAX_VIEWS = 4;

/** One view: the base scene rotated by -`turn`. */
export interface ViewScene {
  readonly turn: QuarterTurn;
  readonly assemblies: readonly SceneAssembly[];
}

export interface ViewsBuild {
  /** Sorted by turn; the 0 view (when present) is the input scene. */
  readonly views: readonly ViewScene[];
  /** Elements of all views together (`budget/views` warns above `ELEMENT_WARN`). */
  readonly elements: number;
  readonly diagnostics: readonly Diagnostic[];
}

const VALID: ReadonlySet<number> = new Set([0, 90, 180, 270]);

/**
 * Views the build steps ask for, sorted, with the rest view 0 included, or `[]` when no build
 * step has a `view` (then the scene needs no view groups). Reads the spec only.
 */
export function usedViews(spec: PlatformCosmoSpec): QuarterTurn[] {
  const turns = new Set<number>();
  // templates are not scene assemblies (their steps never play): skipped
  const stack: { programs?: unknown; parts?: readonly SpecPart[] }[] = (
    spec.assemblies ?? []
  ).filter((a) => a.template !== true);
  while (stack.length > 0) {
    const owner = stack.pop() as { programs?: unknown; parts?: readonly SpecPart[] };
    if (Array.isArray(owner.programs)) {
      for (const p of owner.programs as { kind?: string; steps?: { view?: number }[] }[]) {
        if (p.kind !== "build" || !Array.isArray(p.steps)) continue;
        for (const s of p.steps)
          if (typeof s.view === "number" && VALID.has(s.view)) turns.add(s.view);
      }
    }
    if (Array.isArray(owner.parts)) stack.push(...owner.parts);
  }
  if (turns.size === 0) return [];
  turns.add(0);
  return [...turns].sort((a, b) => a - b) as QuarterTurn[];
}

/** Rotates the XY of `p` by -`turn` quarter turns (a vector, or a point relative to the centre). */
function rv(x: number, y: number, turn: QuarterTurn): [number, number] {
  switch (turn) {
    case 90:
      return [y, -x]; // R(-90)
    case 180:
      return [-x, -y];
    case 270:
      return [-y, x]; // R(-270) = R(+90)
    default:
      return [x, y];
  }
}

const vec = (v: Vec3, turn: QuarterTurn): Vec3 => {
  const [x, y] = rv(v.x, v.y, turn);
  return { x: rnd(x), y: rnd(y), z: v.z };
};

function rotateBox(b: Box3, turn: QuarterTurn, cx: number, cy: number): Box3 {
  const [ax, ay] = rv(b.origin.x - cx, b.origin.y - cy, turn);
  const [ex, ey] = rv(b.origin.x + b.size.x - cx, b.origin.y + b.size.y - cy, turn);
  const x0 = Math.min(ax, ex);
  const y0 = Math.min(ay, ey);
  return {
    origin: { x: rnd(cx + x0), y: rnd(cy + y0), z: b.origin.z },
    size: { x: rnd(Math.max(ax, ex) - x0), y: rnd(Math.max(ay, ey) - y0), z: b.size.z },
  };
}

function turnProgram(p: ResolvedProgram, turn: QuarterTurn): ResolvedProgram {
  const mv = <T extends { offset: Vec3 }>(m: T): T => ({ ...m, offset: vec(m.offset, turn) });
  if (p.kind === "explode") {
    return {
      ...p,
      stages: p.stages.map((s) => ({ ...s, moves: s.moves.map(mv) })),
    };
  }
  return {
    ...p,
    steps: p.steps.map((s) => ({
      ...s,
      moves: s.moves.map(mv),
      ...(s.subBuild === undefined
        ? {}
        : { subBuild: { ...s.subBuild, staging: vec(s.subBuild.staging, turn) } }),
    })),
  };
}

function rotateAssembly(
  a: SceneAssembly,
  turn: QuarterTurn,
  cx: number,
  cy: number,
): SceneAssembly {
  const back = ((360 - turn) % 360) as QuarterTurn;
  const rotate = ((a.frame.rotate + back) % 360) as QuarterTurn;
  // the rotated bounds' minimum corner is the new frame origin (`AssemblyFrame`)
  const whole = frameMap(a.frame, a.root.local).box(a.root.local);
  const turned = rotateBox(whole, turn, cx, cy);
  const frame = {
    ...a.frame,
    rotate,
    front: turnFront(a.frame.front, back),
    origin: { x: turned.origin.x, y: turned.origin.y, z: a.frame.origin.z },
  };
  // ONE source for every world box of the node tree and the rest bounds: the new frame, mapped
  // exactly as `place` in tree.ts does (a part's decal faces stay assembly-local, see contract)
  const map = frameMap(frame, a.root.local);
  const node = (x: SceneAssemblyNode): SceneAssemblyNode => {
    const children = x.children.map(node);
    const g = x.geometry;
    const world =
      x.kind === "leaf"
        ? map.box(
            g === undefined
              ? x.local
              : {
                  origin: {
                    x: x.local.origin.x + g.depthBox.origin.x,
                    y: x.local.origin.y + g.depthBox.origin.y,
                    z: x.local.origin.z + g.depthBox.origin.z,
                  },
                  size: g.depthBox.size,
                },
          )
        : (unionBoxes(children.map((k) => k.world)) ?? map.box(x.local));
    return { ...x, world, children };
  };
  const root = node(a.root);
  const bounds: Box3[] = [];
  const leaves = (n: SceneAssemblyNode): void => {
    for (const c of n.children) {
      if (c.kind !== "leaf") leaves(c);
      else {
        const g = c.geometry;
        bounds.push(
          map.box(
            g === undefined
              ? c.local
              : {
                  origin: {
                    x: c.local.origin.x + g.bounds.origin.x,
                    y: c.local.origin.y + g.bounds.origin.y,
                    z: c.local.origin.z + g.bounds.origin.z,
                  },
                  size: g.bounds.size,
                },
          ),
        );
      }
    }
  };
  leaves(root);
  return {
    ...a,
    frame,
    root,
    programs: a.programs.map((p) => turnProgram(p, turn)),
    restBounds: unionBoxes(bounds) ?? rotateBox(a.restBounds, turn, cx, cy),
    reachBounds: rotateBox(a.reachBounds, turn, cx, cy),
  };
}

/** The scene turned by -`turn` about the centre of its rest bounds; `turn` 0 returns `base`. */
export function rotateScene(
  base: readonly SceneAssembly[],
  turn: QuarterTurn,
): readonly SceneAssembly[] {
  if (turn === 0 || !VALID.has(turn)) return base;
  const rest = unionBoxes(base.map((a) => a.restBounds));
  if (rest === undefined) return base;
  const cx = rest.origin.x + rest.size.x / 2;
  const cy = rest.origin.y + rest.size.y / 2;
  return base.map((a) => rotateAssembly(a, turn, cx, cy));
}

/**
 * The scenes of the requested views (duplicates and invalid turns dropped, at most four), with
 * `budget/views` when all views together exceed `ELEMENT_WARN` elements (§7.7, §13). The count
 * is a PRE-RENDER LOWER BOUND (one element per primitive of every leaf); A1-4 computes the real
 * one (copies, labels, leaders) and applies the same threshold.
 */
export function viewScenes(base: readonly SceneAssembly[], turns: readonly number[]): ViewsBuild {
  const wanted = [...new Set(turns.filter((t) => VALID.has(t)))].sort(
    (a, b) => a - b,
  ) as QuarterTurn[];
  const views = wanted.map((turn): ViewScene => ({ turn, assemblies: rotateScene(base, turn) }));
  const perView = base.reduce((n, a) => n + assemblyElements(a), 0);
  const elements = perView * views.length;
  const diagnostics: Diagnostic[] = [];
  if (elements > ELEMENT_WARN) {
    diagnostics.push({
      severity: "warning",
      code: "budget/views",
      path: "/assemblies",
      message: `${views.length} views of ${perView} elements each need about ${elements} elements (warning above ${ELEMENT_WARN})`,
      suggestion: "Use fewer view changes, or fewer parts",
      params: { views: views.length, perView, elements, limit: ELEMENT_WARN },
    });
  }
  return { views, elements, diagnostics };
}
