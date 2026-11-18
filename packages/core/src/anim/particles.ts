/**
 * Particles. Per flow: `ceil(rate * 2)` particles, each looping over a fixed traversal time of
 * `2 / speed` seconds whatever the path length, evenly staggered with negative `begin` offsets.
 */
import type { RenderModel, SceneFlow, SvgElement, Vec2 } from "../contracts/index.js";
import { el, r2, t4 } from "./css.js";

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const NAME = /^[a-z][a-z-]*$/;
const R = 3.2;

export function particleCount(flow: SceneFlow): number {
  return Math.ceil(flow.rate * 2);
}

export function traversalSeconds(speed: number): number {
  return 2 / speed;
}

/** Registry mapping a flow's color to a CSS class (colors reach CSS, never attributes). */
export class ParticleColors {
  private readonly byValue = new Map<string, string>();
  private readonly rules: string[] = [];

  constructor(private readonly prefix: string) {}

  classFor(flow: SceneFlow): string {
    const value = cssColor(flow);
    let cls = this.byValue.get(value);
    if (cls === undefined) {
      cls = `${this.prefix}_pc${this.byValue.size + 1}`;
      this.byValue.set(value, cls);
      this.rules.push(`.${cls}{fill:${value}}`);
    }
    return cls;
  }

  css(): string {
    return this.rules.join("\n");
  }
}

function cssColor(flow: SceneFlow): string {
  const c = flow.color;
  if (c !== undefined) {
    if (HEX.test(c)) return c;
    const m = /^(palette|flow):(.+)$/.exec(c);
    if (m && NAME.test(m[2] ?? "")) {
      return `var(--pc-${m[1] === "palette" ? "palette" : "flows"}-${m[2]})`;
    }
  }
  return `var(--pc-flows-${NAME.test(flow.kind) ? flow.kind : "normal"})`;
}

/** Wrapper id for all particles (contains `_`, which spec ids cannot). */
export function particlesId(prefix: string): string {
  return `${prefix}_particles`;
}

/** SMIL particles for one flow: a `<g id=flow()>` holding the staggered circles. */
export function smilFlow(
  model: RenderModel,
  flow: SceneFlow,
  speed: number,
  colors: ParticleColors,
): SvgElement | undefined {
  const path = model.edgePaths[flow.edge];
  if (!path || path.points.length < 2) return undefined;
  const n = particleCount(flow);
  const period = traversalSeconds(speed);
  const cls = colors.classFor(flow);
  const href = `#${model.ids.edgePath(flow.edge)}`;
  const circles: SvgElement[] = [];
  for (let k = 0; k < n; k++) {
    const offset = (k * period) / n;
    const motion = el(
      "animateMotion",
      {
        dur: `${t4(period)}s`,
        begin: offset === 0 ? "0s" : `-${t4(offset)}s`,
        repeatCount: "indefinite",
        ...(flow.reverse ? { keyPoints: "1;0", keyTimes: "0;1", calcMode: "linear" } : {}),
      },
      [el("mpath", { href })],
    );
    circles.push(el("circle", { r: R, class: cls }, [motion]));
  }
  return el("g", { id: model.ids.flow(flow.id) }, circles);
}

/** Frozen particles for one flow at `time` (frame mode): plain circles at computed positions. */
export function frozenFlow(
  model: RenderModel,
  flow: SceneFlow,
  speed: number,
  time: number,
  colors: ParticleColors,
): SvgElement | undefined {
  const path = model.edgePaths[flow.edge];
  if (!path || path.points.length < 2) return undefined;
  const n = particleCount(flow);
  const period = traversalSeconds(speed);
  const cls = colors.classFor(flow);
  const circles: SvgElement[] = [];
  for (let k = 0; k < n; k++) {
    const phase = ((((time + (k * period) / n) % period) + period) % period) / period;
    const p = pointAt(path.points, flow.reverse ? 1 - phase : phase);
    circles.push(el("circle", { cx: r2(p.x), cy: r2(p.y), r: R, class: cls }));
  }
  return el("g", { id: model.ids.flow(flow.id) }, circles);
}

/** Point at `fraction` (0..1) of the polyline's length. */
export function pointAt(points: readonly Vec2[], fraction: number): Vec2 {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  let remaining = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = dist(a, b);
    if (remaining <= d && d > 0) {
      const f = remaining / d;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= d;
  }
  return points[points.length - 1]!;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
