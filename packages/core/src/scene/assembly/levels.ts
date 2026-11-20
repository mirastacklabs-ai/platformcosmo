/**
 * Levels of detail (Track A2, A2-5; design docs/design/assemblies.md §8.4, §13).
 *
 * A level is one close-up instance: an assembly built at the reserved path
 * `<host>/closeup` (`closeup.ts`), or a figure or storyboard shown for its host. Each level is a
 * sibling group of the main camera in the render model (`ids.level(path)`, A1-4); the scene side
 * is this data plus the addressing helpers below. Everything here is pure and total: nothing
 * throws, nothing is sized by input before a cap check.
 */
import type { Box3, Diagnostic, SceneAssembly, SceneLevel } from "../../contracts/index.js";
import { assemblyNodes } from "./tree.js";

/** Levels nest at most this deep (the main scene is level 0), §8.4, §13. */
export const MAX_LEVEL_DEPTH = 4;
/** Close-up instances per spec, all depths together, §8.4, §13. */
export const MAX_LEVELS = 8;
/** Existing `budget/elements` warning threshold; views multiply it, levels add to it (§13). */
export const ELEMENT_WARN = 5000;

/** What a close-up shows. */
export type LevelKind = SceneLevel["kind"];

/** One close-up instance (a level of detail): `SceneLevel` of the contract. */
export type Level = SceneLevel;

/** Deepest level whose path is `path` or a prefix of it; undefined: the main scene. */
export function levelOf(levels: readonly Level[], path: string): Level | undefined {
  let best: Level | undefined;
  for (const l of levels) {
    if (path !== l.path && !path.startsWith(`${l.path}/`)) continue;
    if (best === undefined || l.path.length > best.path.length) best = l;
  }
  return best;
}

/** Why a close-up at `depth`, as instance number `count + 1`, is over the limits. */
export function levelLimit(depth: number, count: number): "depth" | "count" | undefined {
  if (depth > MAX_LEVEL_DEPTH) return "depth";
  if (count >= MAX_LEVELS) return "count";
  return undefined;
}

/** `budget/levels` for a close-up that was not built (§13). */
export function levelOverflow(
  why: "depth" | "count",
  host: string,
  depth: number,
  built: number,
  path = "",
): Diagnostic {
  return {
    severity: "error",
    code: "budget/levels",
    path,
    message:
      why === "depth"
        ? `Close-up of ${JSON.stringify(host)} would be level ${depth}; levels nest at most ${MAX_LEVEL_DEPTH} deep`
        : `Close-up of ${JSON.stringify(host)} would be instance ${built + 1}; a spec has at most ${MAX_LEVELS}`,
    suggestion: "Drop some close-ups, or point several parts at one shallower close-up",
    params: { host, depth, count: built, maxDepth: MAX_LEVEL_DEPTH, max: MAX_LEVELS },
  };
}

/**
 * Focus targets inside the levels, in the LEVEL's own world (not the main scene's): the instance
 * root, every part path of an assembly close-up, and the host box (in its parent level) for a
 * figure or storyboard close-up, which are fitted to the host's zoomed screen rect. Sorted keys.
 */
export function levelFocusTargets(levels: readonly Level[]): Map<string, Box3> {
  const out = new Map<string, Box3>();
  for (const l of levels) {
    if (l.assembly === undefined) out.set(l.path, l.hostBox);
    else for (const n of assemblyNodes(l.assembly)) out.set(n.path, n.world);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** DOM elements an assembly needs at least: one per primitive of every leaf (1 without geometry). */
export function assemblyElements(a: SceneAssembly): number {
  let n = 0;
  for (const node of assemblyNodes(a)) {
    if (node.kind === "leaf") n += Math.max(1, node.geometry?.primitives.length ?? 1);
  }
  return n;
}

/**
 * Pre-render lower bound of the elements (one per primitive of every leaf): the main assemblies,
 * `views` copies of them, and every level (§13). A1-4 computes the real count (copies, labels,
 * leaders, callouts) in `AssemblyRenderModel.elements` and uses this as its floor.
 */
export function sceneElements(
  base: readonly SceneAssembly[],
  levels: readonly Level[],
  views = 1,
): number {
  const main = base.reduce((n, a) => n + assemblyElements(a), 0) * Math.max(1, views);
  return levels.reduce(
    (n, l) => n + (l.assembly === undefined ? 0 : assemblyElements(l.assembly)),
    main,
  );
}
