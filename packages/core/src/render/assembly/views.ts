/**
 * Quarter-turn view groups (Track A1, A1-4; docs/design/assemblies.md §7.7, §9, §10).
 *
 * Each view is a complete scene of its own (A2-5 `SceneView`: the assemblies turned by -`turn`),
 * so it gets its own projection, depth epochs, tracks and DOM: `buildGroup` runs once per view
 * on the view's assemblies and the master loop clock. A view's ids carry the suffix `__v<turn>`
 * (`scopeIds`), so the DOM of the views never collides; images (shared `<defs>`) keep theirs.
 *
 * Decals: a part's decal `face` is assembly-local data in every view; `worldLeaves` maps it
 * through the view's `frame.rotate` (turned away: omitted), so nothing is mapped here.
 * Pure and deterministic.
 */
import type {
  AssemblyIdScheme,
  AssemblyViewRender,
  IdScheme,
  Projection,
  QuarterTurn,
  Rect,
  SceneAssembly,
  SvgNode,
} from "../../contracts/index.js";
import { h } from "../../emit/xml.js";
import { projectBoxBounds, unionRects } from "../../geometry/index.js";
import type { GroupBuild } from "./index.js";
import { roundRect } from "./levels.js";

/** Duration of the cross-fade between views at a build step's start, seconds (§7.7). */
export const VIEW_FADE = 0.3;

/** Suffix of every DOM id of a view other than 0. */
export const viewSuffix = (turn: QuarterTurn): string => (turn === 0 ? "" : `__v${turn}`);

/** The ids of a view: part, label, clip, fade and face ids get the view's suffix. */
export function scopeIds(
  ids: IdScheme & AssemblyIdScheme,
  turn: QuarterTurn,
): IdScheme & AssemblyIdScheme {
  const sfx = viewSuffix(turn);
  if (sfx === "") return ids;
  return {
    ...ids,
    partHost: (item, copy) => `${ids.partHost(item, copy)}${sfx}`,
    partMotion: (item, copy) => `${ids.partMotion(item, copy)}${sfx}`,
    partVisible: (item, copy) => `${ids.partVisible(item, copy)}${sfx}`,
    partFade: (item, copy) => `${ids.partFade(item, copy)}${sfx}`,
    partLabel: (path) => `${ids.partLabel(path)}${sfx}`,
    partClip: (item, copy) => `${ids.partClip(item, copy)}${sfx}`,
    callout: (owner, program, step) => `${ids.callout(owner, program, step)}${sfx}`,
    fadeWrap: (id) => `${ids.fadeWrap(id)}${sfx}`,
    object: (id) => `${ids.object(id)}${sfx}`,
    face: (id, face, part) => `${ids.face(id, face, part)}${sfx}`,
    overlay: (id) => `${ids.overlay(id)}${sfx}`,
  };
}

/** The view group: objects, then labels; views other than 0 rest hidden. */
export function viewNode(
  ids: IdScheme & AssemblyIdScheme,
  turn: QuarterTurn,
  group: Pick<GroupBuild, "objects" | "labels">,
): SvgNode {
  return h(
    "g",
    { id: ids.view(turn), ...(turn === 0 ? {} : { opacity: 0 }) },
    ...group.objects,
    ...group.labels,
  );
}

/** The viewBox of a view: its rotated `reachBounds` projected, plus labels and swept boxes. */
export function viewBoxOf(
  projection: Projection,
  assemblies: readonly SceneAssembly[],
  group: Pick<GroupBuild, "extents">,
): Rect {
  const rects: Rect[] = assemblies.map((a) => projectBoxBounds(projection, a.reachBounds));
  return roundRect(unionRects([...rects, ...group.extents]));
}

export function viewRender(
  ids: IdScheme & AssemblyIdScheme,
  projection: Projection,
  turn: QuarterTurn,
  assemblies: readonly SceneAssembly[],
  group: GroupBuild,
): AssemblyViewRender {
  return {
    turn,
    group: ids.view(turn),
    model: group.model,
    viewBox: viewBoxOf(projection, assemblies, group),
    elements: group.model.elements + 1,
  };
}
