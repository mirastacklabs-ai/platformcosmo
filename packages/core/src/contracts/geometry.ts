/**
 * Geometry contract (frozen). Owned by the orchestrator; implemented by Track A
 * (`packages/core/src/geometry`).
 *
 * World space: right-handed iso grid. One world unit = one floor tile
 * (600 mm in the DC pack). `x` runs toward the lower-right of the screen,
 * `y` toward the lower-left, `z` straight up. Screen space: SVG user units,
 * `x` right, `y` down.
 */

/** A point or extent in world space (grid units). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A point in screen space (SVG user units). */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned box in world space. `origin` is the minimum corner. */
export interface Box3 {
  readonly origin: Vec3;
  readonly size: Vec3;
}

/** Axis-aligned rectangle in screen space. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 2:1 dimetric projection. A tile projects to a diamond `tileWidth` wide and
 * `tileWidth / 2` tall; one world unit of height projects to `zScale` screen
 * units. Implementations must be pure and deterministic, and must round output
 * coordinates to at most 2 decimals so SVG output is byte-stable.
 */
export interface Projection {
  readonly tileWidth: number;
  readonly zScale: number;
  project(p: Vec3): Vec2;
}

/** Solid primitive shapes, all built from top/left/right faces (PLAN §6). */
export type PrimitiveKind = "cube" | "slab" | "platform" | "hex-prism" | "cylinder";

/**
 * Visible face of a primitive. Four-tone shading maps `top`, `left`, `right`
 * to theme face tones, plus the outline stroke.
 */
export type FaceName = "top" | "left" | "right";

/** A visible face projected to screen space, in drawing order. */
export interface ProjectedFace {
  readonly face: FaceName;
  /** Closed polygon, clockwise in screen space. Curved faces are pre-flattened or given as `d`. */
  readonly points: readonly Vec2[];
  /** Optional SVG path data for curved faces (cylinder side/top); takes precedence over `points`. */
  readonly d?: string;
}
