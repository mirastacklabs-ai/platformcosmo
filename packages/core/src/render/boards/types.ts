/**
 * Render-side model of flat boards (figure panels, R-1; storyboard frames join in R-2). The
 * contract types live in `contracts/render.ts` (`RenderModel.boards`); these are short names.
 */
import type {
  BoardFadeKey,
  BoardFadeTrack,
  BoardKeyEasing,
  BoardPoseKey,
  BoardPoseTrack,
  BoardsRenderModel,
  BoardsTracks,
  RenderModel,
} from "../../contracts/index.js";

export type KeyEasing = BoardKeyEasing;
export type PoseKey = BoardPoseKey;
export type FadeKey = BoardFadeKey;
export type PoseTrack = BoardPoseTrack;
export type FadeTrack = BoardFadeTrack;
export type BoardsModel = BoardsRenderModel;
export type { BoardsTracks };

export const boardsOf = (model: RenderModel): BoardsRenderModel | undefined => model.boards;
