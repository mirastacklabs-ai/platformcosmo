/** Types for the synthetic trap-figure generator (gen.mjs). */
export interface GenRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
export interface GenMask {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
}
export interface GenUnitTruth {
  readonly full: GenMask;
  readonly visible: GenMask;
  readonly pos: readonly [number, number];
}
export type GenState = "exploded" | "assembled";
export interface GenFigure {
  readonly name: string;
  readonly states: Partial<
    Record<
      GenState,
      {
        readonly image: GenRaster;
        readonly board: GenRaster;
        readonly truth: { readonly units: Readonly<Record<string, GenUnitTruth>> };
      }
    >
  >;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly manifest: any;
  readonly sprites: Readonly<Record<string, { readonly raster: GenRaster }>>;
  readonly annotations: readonly {
    readonly kind: string;
    readonly state: GenState;
    readonly polyline?: readonly (readonly [number, number])[];
    readonly rect?: readonly [number, number, number, number];
    readonly for?: string;
  }[];
  readonly offset: readonly [number, number];
  readonly base: GenState;
  readonly units: readonly string[];
  readonly scale: number;
  readonly stroke: number;
  readonly aa?: boolean;
}
export declare const PRESET_NAMES: readonly string[];
/** Presets drawn at stroke 2 only (1 px comb fins). */
export declare const STROKE2_ONLY: readonly string[];
export interface GenOptions {
  /** Integer geometry scale (default 1). */
  scale?: number;
  /** Outline brush in px (default 2). */
  stroke?: number;
  /** Draw at twice the size and box-downsample (anti-aliased edges). */
  aa?: boolean;
  /** Blank margin in px on every side. */
  pad?: number;
}
export declare function figure(name: string, options?: GenOptions): GenFigure;
export declare function png(r: GenRaster): Uint8Array;
