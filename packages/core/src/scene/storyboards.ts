/**
 * Storyboards in the scene (Track R, R-2; docs/design/assemblies.md §14): resolves
 * `storyboards[]` into `ResolvedStoryboard`s (defaults filled in), the timing of one frame and
 * the panel geometry. Pure and deterministic: no I/O and no image bytes (the panel needs the
 * first model image's size, which the caller supplies).
 *
 * A storyboard has one program, its frames (`STORYBOARD_PROGRAM`), and one level per frame:
 * level `k` shows the model image after document step `k`, level 0 an empty panel. `build`
 * plays frames forward, `unbuild` plays the same frames backward, so the renderer defines every
 * visible value as a function of the level and the time inside a frame (no second animation).
 */
import { DEFAULT_TILE_WIDTH } from "../geometry/index.js";
import type { SpecStoryboard } from "../schema/types.gen.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Program id of a storyboard's frames in `ResolvedAction.program` / `ProgramLevel.program`. */
export const STORYBOARD_PROGRAM = "frames";

export const DEFAULT_STORYBOARD_WIDTH = 8;

export interface ResolvedItem {
  readonly image: string;
  readonly count: number;
  readonly label?: string;
}

export interface ResolvedFrame {
  /** 1-based position in `frames`: the level that shows this frame's model. */
  readonly index: number;
  /** Step number printed in the document (default: the position). */
  readonly number: number;
  readonly caption?: string;
  readonly model: string;
  readonly parts: readonly ResolvedItem[];
  /** Where the step's parts land, in percent of the model image. */
  readonly attach: readonly [number, number];
  readonly sub: readonly ResolvedItem[];
}

export type StoryboardTransition = "fade" | "wipe" | "cut";

export interface ResolvedStoryboard {
  readonly id: string;
  readonly label?: string;
  readonly width: number;
  readonly transition: StoryboardTransition;
  readonly frames: readonly ResolvedFrame[];
}

const item = (i: {
  readonly image: string;
  readonly count?: number;
  readonly label?: string;
}): ResolvedItem => ({
  image: i.image,
  count: i.count ?? 1,
  ...(i.label === undefined ? {} : { label: i.label }),
});

export function resolveStoryboard(sb: SpecStoryboard): ResolvedStoryboard {
  return {
    id: sb.id,
    ...(sb.label === undefined ? {} : { label: sb.label }),
    width: sb.width ?? DEFAULT_STORYBOARD_WIDTH,
    transition: sb.transition ?? "fade",
    frames: sb.frames.map((f, i) => ({
      index: i + 1,
      number: f.number ?? i + 1,
      ...(f.caption === undefined ? {} : { caption: f.caption }),
      model: f.model,
      parts: (f.parts ?? []).map(item),
      attach: [f.attach?.[0] ?? 50, f.attach?.[1] ?? 50] as const,
      sub: (f.sub ?? []).map(item),
    })),
  };
}

/** Image keys of a storyboard in first-use order: per frame the model, the parts, the sub-build. */
export function storyboardImages(sb: ResolvedStoryboard): string[] {
  const out: string[] = [];
  for (const f of sb.frames) {
    for (const k of [f.model, ...f.parts.map((p) => p.image), ...f.sub.map((s) => s.image)]) {
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Frame timing (seconds at speed 1, before the step's compression)
// ---------------------------------------------------------------------------------------------

/** The callout fades in (and the previous frame's callout out). */
export const INTRO = 0.3;
/** Each mini step of a sub-build stays this long; the next one replaces it. */
export const SUB_STEP = 0.35;
/** Cross-fade between two mini steps. */
export const SUB_FADE = 0.1;
/** Thumbnails fly (screen translate) to `attach`. */
export const FLIGHT = 0.6;
/** A flying thumbnail fades out over this last part of its flight. */
export const LAND = 0.12;
/** The model image changes (`transition`). */
export const CHANGE = 0.5;
/** A `cut` is this short, so every value stays a function of time (and reverses exactly). */
export const CUT = 0.02;

/** Local times of one frame, in seconds from the frame's start. */
export interface FrameTiming {
  /** Whether the frame has a callout (parts or a sub-build). */
  readonly callout: boolean;
  /** End of the callout's fade-in. */
  readonly intro: number;
  /** Start of each mini step. */
  readonly subAt: readonly number[];
  /** Thumbnails fly in `[flightStart, flightEnd]`; 0 and 0 without a callout. */
  readonly flightStart: number;
  readonly flightEnd: number;
  /** The model image changes in `[changeStart, changeEnd]`. */
  readonly changeStart: number;
  readonly changeEnd: number;
  /** Length of the frame: `changeEnd`. */
  readonly length: number;
}

export function frameTiming(f: ResolvedFrame): FrameTiming {
  const callout = f.parts.length > 0 || f.sub.length > 0;
  const intro = callout ? INTRO : 0;
  const subAt = f.sub.map((_, i) => r4(intro + i * SUB_STEP));
  const flightStart = r4(intro + f.sub.length * SUB_STEP);
  const flightEnd = callout ? r4(flightStart + FLIGHT) : flightStart;
  const changeEnd = r4(flightEnd + CHANGE);
  return {
    callout,
    intro,
    subAt,
    flightStart,
    flightEnd,
    changeStart: flightEnd,
    changeEnd,
    length: changeEnd,
  };
}

/** One frame played by an action. `offset` is its start inside the action, speed 1, uncompressed. */
export interface FrameRun {
  readonly frame: ResolvedFrame;
  readonly offset: number;
  /** An `unbuild` plays the frame backward. */
  readonly reversed: boolean;
}

/**
 * Frames played by an action from level `from` to level `to`: `build` plays `from + 1 … to`
 * forward, `unbuild` plays `from … to + 1` backward. Empty when the level does not change.
 */
export function storyboardRuns(
  board: ResolvedStoryboard,
  from: number,
  to: number,
): { runs: FrameRun[]; length: number } {
  const runs: FrameRun[] = [];
  let at = 0;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const order = board.frames.slice(lo, hi);
  const list = to < from ? [...order].reverse() : order;
  for (const frame of list) {
    runs.push({ frame, offset: r4(at), reversed: to < from });
    at = r4(at + frameTiming(frame).length);
  }
  return { runs, length: at };
}

/** Seconds an action from level `from` to level `to` plays at speed 1, uncompressed. */
export const storyboardLength = (board: ResolvedStoryboard, from: number, to: number): number =>
  storyboardRuns(board, from, to).length;

// ---------------------------------------------------------------------------------------------
// Panel geometry
// ---------------------------------------------------------------------------------------------

export interface StoryboardGeometry {
  readonly width: number;
  readonly height: number;
  /** Height of the callout strip above the model area (0 without any callout). */
  readonly calloutH: number;
  /** The model area: images are fitted into it, centred. */
  readonly modelH: number;
  /** Height of the caption bar under the model area. */
  readonly captionH: number;
}

/** Whether any frame has a callout (the strip is then part of the panel for every frame). */
export const hasCallouts = (board: ResolvedStoryboard): boolean =>
  board.frames.some((f) => f.parts.length > 0 || f.sub.length > 0);

/**
 * Screen size of a storyboard panel: `width` tiles along +x like a figure panel; the model area
 * takes the aspect ratio of the first frame's model image (clamped to 1:4 … 2:1 so a strip image
 * cannot make a degenerate panel), under a callout strip and above a caption bar. Undefined for
 * a degenerate image.
 */
export function storyboardGeometry(
  board: ResolvedStoryboard,
  model: { readonly width: number; readonly height: number } | undefined,
): StoryboardGeometry | undefined {
  if (model === undefined || !(model.width > 0) || !(model.height > 0) || !(board.width > 0)) {
    return undefined;
  }
  const w = r2((board.width * DEFAULT_TILE_WIDTH) / 2);
  const aspect = Math.min(2, Math.max(0.25, model.height / model.width));
  const calloutH = hasCallouts(board) ? r2(w * 0.22) : 0;
  const modelH = r2(w * aspect);
  const captionH = r2(Math.max(24, w * 0.1));
  return { width: w, height: r2(calloutH + modelH + captionH), calloutH, modelH, captionH };
}
