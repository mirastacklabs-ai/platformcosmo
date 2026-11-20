/**
 * Render-side model of flat boards (figure panels, R-1; storyboard frames join in R-2): the
 * tracks the animator plays and the side data the emitter needs. Times are loop seconds at
 * speed 1 (the animator divides by `--speed`); lengths are screen user units.
 */
import type { ImageAsset } from "../../contracts/index.js";
import type { Bezier } from "../../scene/boards.js";

/** Easing of the segment that STARTS at a key: a cubic-bezier, or `step` = hold to the next key. */
export type KeyEasing = Bezier | "step";

/** Screen translation of one sprite relative to its seated position. */
export interface PoseKey {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly easing: KeyEasing;
}

/** Opacity of a label or arrow group, 0..1. */
export interface FadeKey {
  readonly t: number;
  readonly v: number;
  readonly easing: KeyEasing;
}

export interface PoseTrack {
  /** Element id of the sprite's motion group. */
  readonly id: string;
  /** Sorted by t, strictly increasing; first key at 0, last at the loop end. */
  readonly keys: readonly PoseKey[];
}

export interface FadeTrack {
  readonly id: string;
  readonly keys: readonly FadeKey[];
}

/** What `render/boards` hands to the animator (`anim/boards.ts`) and the emitter. */
export interface BoardsModel {
  /** Loop length at speed 1: the sum of the step durations (0 without steps). */
  readonly loop: number;
  /** Sprites that move at some time of the loop, sorted by id. */
  readonly poses: readonly PoseTrack[];
  /** Labels and arrows whose opacity changes, sorted by id. */
  readonly fades: readonly FadeTrack[];
  /** Per step: start time on the master loop. */
  readonly stepStarts: readonly number[];
  /** Per step: time the closing hold ends (`T + d − tr`), where per-step outputs read the pose. */
  readonly stepEnds: readonly number[];
  /** Per step: time its actions have settled (§7.5); undefined for steps without actions. */
  readonly settled: readonly (number | undefined)[];
  /** The credits line group (pinned like the legend), when any source carries a credit. */
  readonly creditsId?: string;
  /** Every asset embedded, by hash, in first-use order (the emitter encodes the bytes itself). */
  readonly assets: ReadonlyMap<string, ImageAsset>;
  /** Text appended to the SVG `<desc>`: every credit entry (§11.6). Empty without credits. */
  readonly desc: string;
}

const BOARDS = Symbol.for("platformcosmo.boards");

/**
 * The boards model rides on the render model under a symbol key (an own enumerable property, so
 * the `{ ...model }` copies of the exporter keep it). `RenderModel` itself has no slot for it.
 */
export function attachBoards<T extends object>(model: T, boards: BoardsModel): T {
  Object.defineProperty(model, BOARDS, {
    value: boards,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return model;
}

export function boardsOf(model: object): BoardsModel | undefined {
  return (model as Record<symbol, BoardsModel | undefined>)[BOARDS];
}
