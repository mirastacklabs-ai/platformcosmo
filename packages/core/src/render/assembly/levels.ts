/**
 * Close-up level groups (Track A1, A1-4; docs/design/assemblies.md §8.4, §10, §13).
 *
 * A level is one `SceneLevel` (A2-5): an assembly instance in its OWN world, a figure or a
 * storyboard. Here each becomes a group `<g id=ids.level(path)>` of the overlay layer (pinned
 * against the camera like the captions, so a sibling of it) that holds the level's objects and
 * labels, plus the geometry B-3 animates:
 *
 *  - `overview`: the level's own camera at rest, local -> viewport: its reach contained in the
 *    main overview area (`target`);
 *  - `hostLocal` / `hostRect` / `hostFocus`: the host box in the parent level and in the viewport,
 *    and the camera rect that frames it (the parent zooms to it, at most 3x, B-3's call);
 *  - `enter` / `fromHost(zoomed)`: the cross-fade's start, the level's rest bounds contained in the
 *    host's (zoomed) rect, so the swap has no jump; the group eases to `overview` from there.
 *
 * Focus targets inside a level live in that level's own world: `levelFocusRect` resolves them
 * through `levelOf` and the level's overview, never the main camera. Pure and deterministic;
 * nothing throws on odd input (degenerate rects map with scale 1).
 */
import type {
  AssemblyAffine,
  AssemblyLevelRender,
  AssemblyRenderModel,
  Projection,
  Rect,
  SceneLevel,
  SvgNode,
} from "../../contracts/index.js";
import { h } from "../../emit/xml.js";
import { fmt, projectBoxBounds, round2, unionRects } from "../../geometry/index.js";
import { levelOf } from "../../scene/assembly/levels.js";
import type { GroupBuild } from "./index.js";

const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;
const finite = (r: Rect): boolean =>
  Number.isFinite(r.x + r.y + r.width + r.height) && r.width > 0 && r.height > 0;

export const roundRect = (r: Rect): Rect => ({
  x: round2(r.x),
  y: round2(r.y),
  width: round2(r.width),
  height: round2(r.height),
});

/** The affine map that fits `src` inside `dst` (uniform scale, centred); scale 1 if degenerate. */
export function containAffine(src: Rect, dst: Rect): AssemblyAffine {
  const cx = (r: Rect): number => r.x + r.width / 2;
  const cy = (r: Rect): number => r.y + r.height / 2;
  const scale =
    finite(src) && finite(dst) ? Math.min(dst.width / src.width, dst.height / src.height) : 1;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const dx = Number.isFinite(cx(dst)) ? cx(dst) : 0;
  const dy = Number.isFinite(cy(dst)) ? cy(dst) : 0;
  const sx = Number.isFinite(cx(src)) ? cx(src) : 0;
  const sy = Number.isFinite(cy(src)) ? cy(src) : 0;
  return { scale: r4(s), tx: round2(dx - s * sx), ty: round2(dy - s * sy) };
}

/** `a` applied to a rect. */
export const applyAffine = (a: AssemblyAffine, r: Rect): Rect =>
  roundRect({
    x: a.scale * r.x + a.tx,
    y: a.scale * r.y + a.ty,
    width: a.scale * r.width,
    height: a.scale * r.height,
  });

/** The `transform` attribute of an affine. */
export const matrixAttr = (a: AssemblyAffine): string =>
  `matrix(${fmt(a.scale)} 0 0 ${fmt(a.scale)} ${fmt(a.tx)} ${fmt(a.ty)})`;

export interface LevelsDeps {
  readonly projection: Projection;
  /** `ids.level`. */
  readonly levelId: (path: string) => string;
  /** Focus margins, as `RenderModel.focusRects` (default none). */
  readonly margin: { readonly side: number; readonly bottom: number };
  /** The main overview area: where a level at rest is drawn (its reach contained in it). */
  readonly target: Rect;
  /** The main scene's node rects, for hosts living in it. */
  readonly main: Pick<GroupBuild, "nodeRect">;
  /** Builds the group of an assembly level (its own world, shared loop clock). */
  readonly build: (level: SceneLevel) => GroupBuild;
}

export interface LevelsBuild {
  /** Sorted by path. */
  readonly levels: readonly AssemblyLevelRender[];
  /** The level groups, in `levels` order, for the overlay layer. */
  readonly nodes: SvgNode[];
  readonly defs: SvgNode[];
  readonly diagnostics: GroupBuild["diagnostics"];
  /** Group builds by level path (assembly levels). */
  readonly groups: ReadonlyMap<string, GroupBuild>;
}

/**
 * Builds the level groups. `levels` must be sorted by path (parents first, as A2-5 delivers);
 * a level whose parent is unknown is treated as a child of the main scene.
 */
export function buildLevelGroups(levels: readonly SceneLevel[], deps: LevelsDeps): LevelsBuild {
  const out: AssemblyLevelRender[] = [];
  const nodes: SvgNode[] = [];
  const defs: SvgNode[] = [];
  const diagnostics: GroupBuild["diagnostics"] = [];
  const groups = new Map<string, GroupBuild>();
  const byPath = new Map<string, AssemblyLevelRender>();
  const { projection, margin: m } = deps;

  for (const l of levels) {
    const parent = l.parent === undefined ? undefined : byPath.get(l.parent);
    const hostLocal = roundRect(projectBoxBounds(projection, l.hostBox));
    const toViewport = (r: Rect): Rect =>
      parent === undefined ? r : applyAffine(parent.overview, r);
    const hostRect = toViewport(hostLocal);
    const hostFocus = roundRect({
      x: hostRect.x - m.side,
      y: hostRect.y - m.side,
      width: hostRect.width + 2 * m.side,
      height: hostRect.height + 2 * m.side + m.bottom,
    });

    let group: GroupBuild | undefined;
    let model: AssemblyRenderModel | undefined;
    let rest = hostLocal;
    let reach = hostLocal;
    if (l.assembly !== undefined) {
      group = deps.build(l);
      groups.set(l.path, group);
      model = group.model;
      rest = roundRect(projectBoxBounds(projection, l.assembly.restBounds));
      reach = roundRect(unionRects([rest, ...group.extents]));
      defs.push(...group.defs);
      diagnostics.push(...group.diagnostics);
    }
    const overview = containAffine(reach, deps.target);
    const enter = containAffine(rest, hostRect);
    const hostAt = (step: number): Rect => {
      const r =
        parent === undefined
          ? deps.main.nodeRect(step, l.host)
          : groups.get(parent.path)?.nodeRect(step, l.host);
      return r === undefined ? hostRect : toViewport(roundRect(r));
    };
    const rec: AssemblyLevelRender = {
      path: l.path,
      host: l.host,
      kind: l.kind,
      depth: l.depth,
      ...(l.parent === undefined ? {} : { parent: l.parent }),
      group: deps.levelId(l.path),
      ...(model === undefined ? {} : { model }),
      rest,
      reach,
      hostLocal,
      hostRect,
      hostFocus,
      overview,
      focus: applyAffine(overview, reach),
      enter,
      fromHost: (zoomed) => containAffine(rest, zoomed),
      hostAt,
      elements: (model?.elements ?? 0) + 1,
    };
    out.push(rec);
    byPath.set(l.path, rec);
    // The group rests hidden at its overview placement (B-3 animates opacity and transform).
    nodes.push(
      h(
        "g",
        { id: rec.group, transform: matrixAttr(overview), opacity: 0 },
        ...(group === undefined ? [] : [...group.objects, ...group.labels]),
      ),
    );
  }
  return { levels: out, nodes, defs, diagnostics, groups };
}

/**
 * Focus rect (viewport, with the margins) of a target inside a close-up: resolved through
 * `levelOf` in the level's OWN world and placed by the level's overview. `found: false` for a
 * main scene id (the caller falls back to the main model); `rect` is undefined for an id the
 * level does not have.
 */
export function levelFocusRect(
  scene: readonly SceneLevel[],
  built: LevelsBuild,
  step: number,
  id: string,
  margin: { readonly side: number; readonly bottom: number },
): { readonly found: boolean; readonly rect: Rect | undefined } {
  const l = levelOf(scene, id);
  if (l === undefined) return { found: false, rect: undefined };
  const rec = built.levels.find((x) => x.path === l.path);
  if (rec === undefined) return { found: true, rect: undefined };
  const g = built.groups.get(l.path);
  const own = g === undefined ? undefined : g.nodeRect(step, id);
  if (own === undefined) {
    // figure or storyboard level: only the instance itself, fitted to the host's rect
    return { found: true, rect: g === undefined && id === l.path ? rec.focus : undefined };
  }
  // the level's rect (its own world) placed by its overview; the margins are viewport pixels
  const r = applyAffine(rec.overview, own);
  return {
    found: true,
    rect: roundRect({
      x: r.x - margin.side,
      y: r.y - margin.side,
      width: r.width + 2 * margin.side,
      height: r.height + 2 * margin.side + margin.bottom,
    }),
  };
}
