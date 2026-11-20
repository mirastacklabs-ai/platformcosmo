/**
 * Render-side extensions of `AssemblyRenderModel` (contracts/assembly.ts, frozen): what B-1 and
 * the emitter need beyond the contract. All fields are additive; the object is assignable to
 * `RenderModel.assembly`.
 */
import type {
  AssemblyRenderModel,
  ImageAsset,
  OpacityKey,
  Rect,
  TrackKey,
} from "../../contracts/index.js";
import type { LabelTrack } from "./labels.js";

export type { LabelTrack };

/** A scene object outside the assemblies that takes part in the depth order (static). */
export interface StaticItem {
  /** Unique key; must not equal a leaf path. */
  readonly key: string;
  readonly box: import("../../contracts/index.js").Box3;
  readonly node: import("../../contracts/index.js").SvgNode;
}

/** Opacity track of a static object wrapped in `ids.fadeWrap(key)` (a stage fades `others`). */
export interface StaticFadeTrack {
  readonly key: string;
  readonly id: string;
  readonly opacity: readonly OpacityKey[];
}

export interface StepClock {
  /** 1-based step. */
  readonly step: number;
  readonly start: number;
  readonly duration: number;
  /** Motion window opens. */
  readonly open: number;
  /** Closing hold ends (`start + duration - tr`): the END pose of the step is shown here. */
  readonly end: number;
}

export interface AssemblyRenderModelX extends AssemblyRenderModel {
  /** Label groups: leader labels and top-face labels, with their tracks (sorted by id). */
  readonly labelTracks: readonly LabelTrack[];
  /** Statics wrapped in a fade group, with their tracks. */
  readonly staticFades: readonly StaticFadeTrack[];
  /** Image assets used by decals and billboards, by hash (the emitter encodes them). */
  readonly assets: ReadonlyMap<string, ImageAsset>;
  /** One entry per timeline step. */
  readonly clock: readonly StepClock[];
  /** Closing window of the loop closure (§7.4), when a program returns to its base level. */
  readonly closure?: { readonly t0: number; readonly t1: number };
  /** Approximate depth time ranges (`assembly/depth-approx`). */
  readonly approximate: readonly { readonly t0: number; readonly t1: number }[];
  /** The loop's moves (world space, loop seconds): the displacement of every node over time. */
  readonly moves: readonly import("../../depth/epochs.js").LoopMove[];
  /** Union of the swept screen boxes of every leaf (reach bounds, §10), user units. */
  readonly reach: Rect | undefined;
}

export type { TrackKey };
