import type { Diagnostic } from "@platformcosmo/core";
import { MAX_STUDS, paramSpecsOf } from "./define.js";
import { brickShapes } from "./shapes.js";

/**
 * Placement checks for `brick:` parts (assemblies section 5.1, section 18). Pure and
 * non-throwing: bad input yields no diagnostics for that field. The semantic validator calls
 * `checkBrickPlacement` once per leaf part, with the part's own spec fields.
 *
 * - `brick/off-grid` (warning): a position (`at`, or `pitch` when `count` > 1) or a `size` that
 *   is not a whole number of studs (x, y) or plates (z). Positions of every `count` instance
 *   follow from `at` and `pitch`, so those two are checked once, not per instance.
 * - `assembly/shape-params` (error): the footprint would carry more than `MAX_STUDS` studs, so
 *   the shape draws none; use `studs: false` or a smaller footprint.
 */

export interface BrickPlacement {
  /** JSON pointer of the part in the spec, e.g. `/assemblies/0/parts/2`. */
  readonly path: string;
  /** Full shape ref, e.g. `brick:brick`; anything outside `brick:` yields no diagnostics. */
  readonly shape: string;
  /** Assembly units; only `stud` is checked. */
  readonly units?: string;
  /** Spec `at`, `pitch` and `size` (x, y in studs; z in plates). */
  readonly at?: readonly unknown[];
  readonly pitch?: readonly unknown[];
  readonly count?: number;
  readonly size?: readonly unknown[];
  /** Spec `params`, as given. */
  readonly params?: unknown;
}

const TOL = 1e-6;
const AXES = ["x", "y", "z"] as const;
const UNIT = ["stud", "stud", "plate"] as const;

const isWhole = (v: number): boolean => Math.abs(v - Math.round(v)) <= TOL;

/** Axes (x, y, z) of `values` that are finite numbers off the integer grid. */
function offAxes(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const v = values[k];
    if (typeof v === "number" && Number.isFinite(v) && !isWhole(v)) out.push(AXES[k] as string);
  }
  return out;
}

const fmtNum = (v: unknown): string => (typeof v === "number" ? String(v) : "?");

function offGrid(
  p: BrickPlacement,
  field: "at" | "pitch" | "size",
  values: readonly unknown[],
): Diagnostic[] {
  const axes = offAxes(values);
  if (axes.length === 0) return [];
  const nearest = [0, 1, 2].map((k) => {
    const v = values[k];
    return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : v;
  });
  const what = field === "size" ? "size" : field === "pitch" ? "pitch" : "position";
  const per = axes.map((a) => `${a} (${UNIT[AXES.indexOf(a as "x")]}s)`).join(", ");
  return [
    {
      severity: "warning",
      code: "brick/off-grid",
      path: `${p.path}/${field}`,
      message: `${p.shape} ${what} [${values
        .slice(0, 3)
        .map(fmtNum)
        .join(", ")}] is off the stud grid on ${per}; bricks snap to whole studs and plates.`,
      suggestion: `Use [${nearest.map(fmtNum).join(", ")}]`,
      params: { shape: p.shape, field, axes },
    },
  ];
}

/** Studs a shape draws on a `w` x `d` footprint, as an upper bound (0 when it has none). */
function studsFor(shapeId: string, params: unknown, w: number, d: number): number {
  const shape = brickShapes.find((s) => s.id === shapeId);
  if (shape === undefined || !paramSpecsOf(shapeId)?.has("studs")) return 0;
  let studs = shape.defaults["studs"];
  try {
    studs = shape.readParams(
      typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {},
    ).params["studs"];
  } catch {
    // keep the default
  }
  return studs === true ? Math.floor(w + TOL) * Math.floor(d + TOL) : 0;
}

/** `brick/off-grid` and stud-count diagnostics for one leaf part. Never throws. */
export function checkBrickPlacement(p: BrickPlacement): Diagnostic[] {
  if (typeof p.shape !== "string" || !p.shape.startsWith("brick:")) return [];
  const out: Diagnostic[] = [];
  const stud = p.units === "stud";
  if (stud) {
    out.push(...offGrid(p, "at", p.at ?? []));
    if (typeof p.count === "number" && p.count > 1) out.push(...offGrid(p, "pitch", p.pitch ?? []));
    out.push(...offGrid(p, "size", p.size ?? []));
  }
  const w = p.size?.[0];
  const d = p.size?.[1];
  if (typeof w === "number" && typeof d === "number" && Number.isFinite(w) && Number.isFinite(d)) {
    const n = studsFor(p.shape.slice("brick:".length), p.params, w, d);
    if (n > MAX_STUDS) {
      out.push({
        severity: "error",
        code: "assembly/shape-params",
        path: `${p.path}/size`,
        message: `${p.shape} size [${fmtNum(w)}, ${fmtNum(d)}] would carry ${n} studs; the limit is ${MAX_STUDS}, so none are drawn.`,
        suggestion: 'Set "studs": false in params, or use a smaller footprint',
        params: { shape: p.shape, studs: n, limit: MAX_STUDS },
      });
    }
  }
  return out;
}
