/**
 * Crafted specs that need depth copies (assemblies §9.4, track A1-2b). Shared by the core tests
 * and the browser fixture generator (tests/browser/generate.test.ts).
 */
import type { PlatformCosmoSpec } from "../src/index.js";

/**
 * Exactly one copy: `blk` sits behind `base` on x (blk before base), lifts clear of it, then
 * slides over it (base before blk) and comes back the same way. `base` never moves (static, never
 * copied), so `blk` gets copy 1 for the slide and returns to copy 0.
 */
export function copySwapSpec(opts: { readonly label?: boolean } = {}): PlatformCosmoSpec {
  return {
    meta: { version: "1", title: "Depth copy swap" },
    assemblies: [
      {
        id: "kit",
        units: "mm",
        ...(opts.label ? { labels: "always" } : {}),
        parts: [
          { id: "base", size: [100, 100, 100], color: "#64748b" },
          {
            id: "arm",
            at: [-100, 0, 0],
            parts: [
              {
                id: "blk",
                size: [100, 100, 100],
                color: "#f59e0b",
                ...(opts.label ? { label: "Block" } : {}),
              },
            ],
          },
        ],
        programs: [
          {
            id: "swap",
            stages: [
              { parts: ["arm"], direction: "up", distance: 150 },
              { parts: ["arm/blk"], direction: "+x", distance: 200 },
            ],
          },
        ],
      },
    ],
    steps: [
      { caption: "Rest", duration: 2 },
      { caption: "Over", assembly: [{ explode: "kit" }], duration: 4 },
      { caption: "Back", assembly: [{ implode: "kit" }], duration: 4 },
    ],
  } as unknown as PlatformCosmoSpec;
}

/**
 * A CLIPPED item with a copy: the piston rises out of the static block through its top face
 * (static clip, §9.5); `c/a` stands on the block beside it (a before piston), rises above it and
 * slides over it (piston before a). The tie between the two moving items keeps the smaller key
 * (`kit/c/a`) in place, so the piston gets copy 1, clipped like copy 0.
 */
export function clippedCopySpec(): PlatformCosmoSpec {
  return {
    meta: { version: "1", title: "Clipped depth copy" },
    assemblies: [
      {
        id: "kit",
        units: "mm",
        parts: [
          { id: "block", size: [400, 400, 200] },
          { id: "piston", at: [100, 100, 50], size: [200, 200, 130] },
          { id: "c", at: [0, 100, 200], parts: [{ id: "a", size: [100, 200, 100] }] },
        ],
        programs: [
          {
            id: "p",
            stages: [
              { parts: ["piston"], direction: "up", distance: 180 },
              { parts: ["c"], direction: "up", distance: 200 },
              { parts: ["c/a"], direction: "+x", distance: 200 },
            ],
          },
        ],
      },
    ],
    steps: [
      { caption: "Rest", duration: 2 },
      { caption: "Out", assembly: [{ explode: "kit" }], duration: 6 },
      { caption: "Back", assembly: [{ implode: "kit" }], duration: 6 },
    ],
  } as unknown as PlatformCosmoSpec;
}

/**
 * The one-copy swap with the arm BUILT first (B-3 build appearance): step 1 rests with the base
 * alone, step 2 builds the arm, steps 3 and 4 swap and return. The arm's copies must stay hidden
 * until its build move starts (outside the loop-start fade).
 */
export function builtCopySpec(): PlatformCosmoSpec {
  const spec = copySwapSpec() as unknown as {
    assemblies: { programs: unknown[] }[];
    steps: unknown[];
  };
  spec.assemblies[0]!.programs.push({ id: "b", kind: "build", steps: [{ add: ["arm"] }] });
  spec.steps = [
    { caption: "Rest", duration: 3 },
    { caption: "Build", duration: 3, assembly: [{ build: "kit", program: "b" }] },
    { caption: "Over", duration: 4, assembly: [{ explode: "kit", program: "swap" }] },
    { caption: "Back", duration: 4, assembly: [{ implode: "kit", program: "swap" }] },
  ];
  return spec as unknown as PlatformCosmoSpec;
}

/** The one-copy swap with a quarter-turn view (A1-4/B-3): the 270° view's swap needs a copy too. */
export function viewCopySpec(): PlatformCosmoSpec {
  const spec = copySwapSpec() as unknown as { assemblies: { programs: unknown[] }[] };
  spec.assemblies[0]!.programs.push({
    id: "b",
    kind: "build",
    steps: [{ add: ["base"], view: 270 }, { add: ["arm"] }],
  });
  return spec as unknown as PlatformCosmoSpec;
}

/**
 * A piston clipped only while it crosses (§9.5, A1-2c): it rises out of the static block through
 * its top face, then slides sideways once clear. Its motion relative to the block has two axes,
 * so no single static clip is valid for the loop: copy 0 is clipped and drawn while it crosses,
 * copy 1 is unclipped and drawn for the slide. With `shape: "cylinder"` the piston does not fill
 * its box, so it is not split: it keeps the named fallback (`assembly/clip-fallback`).
 */
export function crossingClipSpec(
  opts: { readonly shape?: "cylinder" } = {},
): PlatformCosmoSpec {
  return {
    meta: { version: "1", title: "Clipped while crossing" },
    assemblies: [
      {
        id: "kit",
        units: "mm",
        parts: [
          { id: "block", size: [400, 400, 200], color: "#64748b" },
          {
            id: "arm",
            at: [100, 100, 50],
            parts: [
              {
                id: "piston",
                size: [200, 200, 130],
                color: "#f59e0b",
                ...(opts.shape ? { shape: opts.shape } : {}),
              },
            ],
          },
        ],
        programs: [
          {
            id: "p",
            stages: [
              { parts: ["arm"], direction: "up", distance: 300 },
              { parts: ["arm/piston"], direction: "+x", distance: 400 },
            ],
          },
        ],
      },
    ],
    steps: [
      { caption: "Rest", duration: 2 },
      { caption: "Out", assembly: [{ explode: "kit" }], duration: 6 },
      { caption: "Back", assembly: [{ implode: "kit" }], duration: 6 },
    ],
  } as unknown as PlatformCosmoSpec;
}
