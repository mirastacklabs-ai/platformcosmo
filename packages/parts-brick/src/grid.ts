import type { Diagnostic } from "@platformcosmo/core";
import { MAX_STUDS, paramSpecsOf, sanitizeSize, toStudFactors } from "./define.js";
import { brickShapes } from "./shapes.js";

/**
 * Placement checks for `brick:` parts (assemblies section 5.1, section 18). Pure and
 * non-throwing: bad input yields no diagnostics for that field. The semantic validator calls
 * `checkBrickPlacement` once per leaf part and once per group, with the part's own spec fields and the assembly's
 * resolved units.
 *
 * Values are converted from the assembly's units to stud units first (section 4: x and y in
 * 8 mm studs, z in 3.2 mm plates; `mm`, `cm`, `in` and `tile` convert by length), then checked:
 * - `brick/off-grid` (warning): a position (`at`, or `pitch` when `count` > 1) or a `size` that
 *   is not a whole number of studs (x, y) or plates (z). Positions of every `count` instance
 *   follow from `at` and `pitch`, so those two are checked once, not per instance.
 * - `assembly/shape-params` (error): the footprint would carry more than `MAX_STUDS` studs, so
 *   the shape draws none; use `studs: false` or a smaller footprint.
 * Unknown or missing `units` skip every check.
 */

export interface BrickPlacement {
  /** JSON pointer of the part in the spec, e.g. `/assemblies/0/parts/2`. */
  readonly path: string;
  /** `group`: a sub-assembly; its `at`/`pitch` are checked only when it holds `brick:` leaves. */
  readonly kind?: "part" | "group";
  /** Full shape ref, e.g. `brick:brick`; anything outside `brick:` yields no diagnostics. */
  readonly shape?: string;
  /** Group only: pack shape refs of the leaves below it. */
  readonly shapes?: readonly string[];
  /** The assembly's resolved units: `stud`, `mm`, `cm`, `in` or `tile`. */
  readonly units?: string;
  /** Spec `at`, `pitch` and `size`, in `units`. */
  readonly at?: readonly unknown[];
  readonly pitch?: readonly unknown[];
  readonly count?: number;
  readonly size?: readonly unknown[];
  /** Spec `axis` of a round part (default `z`; only an upright round carries studs). */
  readonly axis?: string;
  /** Spec `params`, as given. */
  readonly params?: unknown;
}

const TOL = 1e-6;
const AXES = ["x", "y", "z"] as const;
const UNIT = ["studs", "studs", "plates"] as const;
const STUD_MM = [8, 8, 3.2] as const;
const PREFIX = "brick:";

const isWhole = (v: number): boolean => Math.abs(v - Math.round(v)) <= TOL;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fmtNum = (v: unknown): string => (num(v) ? String(Math.round(v * 1e4) / 1e4) : "?");

function offGrid(
  p: BrickPlacement,
  field: "at" | "pitch" | "size",
  values: readonly unknown[] | undefined,
  f: readonly [number, number, number],
): Diagnostic[] {
  if (!Array.isArray(values)) return [];
  const axes: string[] = [];
  const nearest: unknown[] = [];
  for (let k = 0; k < 3; k++) {
    const v = values[k];
    if (!num(v)) {
      nearest.push(v);
      continue;
    }
    const studs = v * (f[k] as number);
    if (isWhole(studs)) nearest.push(v);
    else {
      axes.push(AXES[k] as string);
      nearest.push(Math.round(studs) / (f[k] as number));
    }
  }
  if (axes.length === 0) return [];
  const what = field === "size" ? "size" : field === "pitch" ? "pitch" : "position";
  const per = axes.map((a) => `${a} (${UNIT[AXES.indexOf(a as "x")]})`).join(", ");
  const unit = p.units === "stud" ? "" : ` in ${String(p.units)}`;
  return [
    {
      severity: "warning",
      code: "brick/off-grid",
      path: `${p.path}/${field}`,
      message: `${p.shape} ${what} [${values.slice(0, 3).map(fmtNum).join(", ")}]${unit} is off the stud grid on ${per}; bricks snap to whole studs and plates (${STUD_MM[0]} mm and ${STUD_MM[2]} mm).`,
      suggestion: `Use [${nearest.map(fmtNum).join(", ")}]`,
      params: { shape: p.shape, field, axes },
    },
  ];
}

/** Studs a part draws on a `w` x `d` (stud units) footprint, as an upper bound; 0 when none. */
function studsFor(p: BrickPlacement, shapeId: string, w: number, d: number): number {
  const shape = brickShapes.find((s) => s.id === shapeId);
  if (shape === undefined || !paramSpecsOf(shapeId)?.has("studs")) return 0;
  let params: Record<string, unknown> = shape.defaults;
  try {
    params = shape.readParams(
      typeof p.params === "object" && p.params !== null
        ? (p.params as Record<string, unknown>)
        : {},
    ).params;
  } catch {
    // keep the defaults
  }
  if (params["studs"] !== true) return 0;
  const cols = Math.floor(w + TOL);
  const rows = Math.floor(d + TOL);
  if (shapeId === "round" && (p.axis ?? "z") !== "z") return 0;
  if (shapeId === "slope") {
    if (w < 2 - TOL) return 0; // no flat run (also an inverted slope this narrow)
    return params["inverted"] === true ? cols * rows : rows; // else one stud column
  }
  return cols * rows;
}

/** A group's offset (`at`, and `pitch` when repeated) must be on the grid if it holds bricks. */
function checkGroup(p: BrickPlacement): Diagnostic[] {
  if (
    !Array.isArray(p.shapes) ||
    !p.shapes.some((s) => typeof s === "string" && s.startsWith(PREFIX))
  ) {
    return [];
  }
  const f = toStudFactors(p.units);
  if (f === undefined) return [];
  const g: BrickPlacement = { ...p, shape: "group" };
  return [
    ...offGrid(g, "at", p.at, f),
    ...(num(p.count) && p.count > 1 ? offGrid(g, "pitch", p.pitch, f) : []),
  ];
}

/** `brick/off-grid` and stud-count diagnostics for one leaf part. Never throws. */
export function checkBrickPlacement(p: BrickPlacement): Diagnostic[] {
  if (p.kind === "group") return checkGroup(p);
  if (typeof p.shape !== "string" || !p.shape.startsWith(PREFIX)) return [];
  const f = toStudFactors(p.units);
  if (f === undefined) return [];
  const out: Diagnostic[] = [];
  out.push(...offGrid(p, "at", p.at, f));
  if (num(p.count) && p.count > 1) out.push(...offGrid(p, "pitch", p.pitch, f));
  out.push(...offGrid(p, "size", p.size, f));
  const raw = p.size;
  if (Array.isArray(raw) && num(raw[0]) && num(raw[1])) {
    // The same clamp and rounding as `build`, so the count matches what is drawn.
    const s = sanitizeSize({ x: raw[0] * f[0], y: raw[1] * f[1], z: 1 }, { x: 1, y: 1, z: 1 });
    const n = studsFor(p, p.shape.slice(PREFIX.length), s.x, s.y);
    if (n > MAX_STUDS) {
      out.push({
        severity: "error",
        code: "assembly/shape-params",
        path: `${p.path}/size`,
        message: `${p.shape} size [${fmtNum(raw[0])}, ${fmtNum(raw[1])}] would carry ${n} studs; the limit is ${MAX_STUDS}, so none are drawn.`,
        suggestion: 'Set "studs": false in params, or use a smaller footprint',
        params: { shape: p.shape, studs: n, limit: MAX_STUDS },
      });
    }
  }
  return out;
}
