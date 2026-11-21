/**
 * Render-side extensions of `AssemblyRenderModel` (contracts/assembly.ts, frozen): what B-1 and
 * the emitter need beyond the contract. All fields are additive; the object is assignable to
 * `RenderModel.assembly`.
 */
import type {
  AssemblyRenderModel,
  AssemblyStaticFade,
  AssemblyStepClock,
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

export type { AssemblyStaticFade as StaticFadeTrack, AssemblyStepClock as StepClock };

/** The contract model plus the loop's moves (kept internal: not part of the contract). */
export interface AssemblyRenderModelX extends AssemblyRenderModel {
  readonly moves: readonly import("./tracks.js").BezierMove[];
}
