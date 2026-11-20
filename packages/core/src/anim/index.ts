/**
 * Animator (Track B): particles, master loop timeline, per-step and frame modes, reduced motion,
 * interactive controls. Pure and deterministic; all id selectors come from `ids.sel()`.
 */
import type {
  AnimateOptions,
  Animator,
  AnimationLayer,
  IdScheme,
  ObjectState,
  RenderModel,
  SceneFlow,
  SceneObject,
  SvgElement,
} from "../contracts/index.js";
import { boardsOf } from "../render/boards/types.js";
import { boardsFrame, boardsLoop, boardsStepEnd, hasBoardMotion } from "./boards.js";
import { Keyframes, el, stopsFor, t4 } from "./css.js";
import { controlCss, controlIds, controlNodes, interactiveScript } from "./interactive.js";
import {
  ParticleColors,
  cssFlow,
  frozenFlow,
  particleClass,
  particlesId,
  smilFlow,
  traversalSeconds,
} from "./particles.js";
import {
  cameraStops,
  transitionSeconds,
  cameraTransform,
  inverseCameraTransform,
  metricTexts,
  stateAt,
  frameViewBox,
  stepIndexAt,
  windows,
  zoomFor,
  type Windows,
  type Zoom,
} from "./timeline.js";

export function createAnimator(): Animator {
  return { animate };
}

const LED_OF_STATE: Readonly<Record<ObjectState, "ok" | "warn" | "fail">> = {
  healthy: "ok",
  highlighted: "ok",
  degraded: "warn",
  down: "fail",
};

const EASE = "cubic-bezier(.4,0,.2,1)";

/**
 * Selector of the legend group: `ids.legend()` once the contract has it, until then the class the
 * render pipeline puts on it (`<prefix>-legend`).
 */
function legendSelector(ids: IdScheme): string {
  const withLegend = ids as IdScheme & { legend?: () => string };
  return typeof withLegend.legend === "function"
    ? ids.sel(withLegend.legend())
    : `.${ids.prefix}-legend`;
}

function animate(model: RenderModel, options: AnimateOptions): AnimationLayer {
  const speed = options.speed > 0 ? options.speed : 1;
  const timeline = model.scene.timeline;
  const win = windows(timeline, speed);
  const colors = new ParticleColors(model.ids.prefix);
  const css = options.motion === "css";

  switch (options.mode) {
    case "frame":
      return frameLayer(model, speed, win, options.time ?? 0, colors);
    case "step":
      return stepLayer(model, speed, options.step, colors, css);
    default:
      return loopLayer(model, speed, win, colors, options.mode === "interactive", css);
  }
}

// ---------------------------------------------------------------------------------------------
// Static rules for one step (shared by frame, step and the reduced-motion frame)
// ---------------------------------------------------------------------------------------------

function objectsWithLed(model: RenderModel): ReadonlySet<string> {
  const set = new Set<string>();
  for (const o of model.scene.objects) if (o.parts?.some((p) => p.tone === "led")) set.add(o.id);
  return set;
}

function stateCss(model: RenderModel, id: string, state: ObjectState, hasLed: boolean): string {
  const { ids } = model;
  const rules = [
    `${ids.sel(ids.object(id))}{opacity:var(--pc-states-${state}-opacity)}`,
    `${ids.sel(ids.overlay(id))}{fill:var(--pc-states-${state}-overlay);stroke:var(--pc-states-${state}-stroke)}`,
  ];
  if (hasLed) {
    rules.push(
      `${ids.sel(ids.object(id))} .${ids.ledClass()}{fill:var(--pc-dc-led-${LED_OF_STATE[state]})}`,
    );
  }
  return rules.join("\n");
}

/** Objects whose state differs from the initial one in at least one step. */
function overriddenObjects(model: RenderModel): SceneObject[] {
  const tl = model.scene.timeline;
  return model.scene.objects.filter((o) => tl.some((s) => stateAt(s, o.id, o.state) !== o.state));
}

/** Static rules showing step `k` (0-based) of a timeline; empty without steps. */
function staticStepCss(model: RenderModel, k: number): string {
  const tl = model.scene.timeline;
  const step = tl[k];
  if (!step) return "";
  const { ids } = model;
  const out: string[] = [];
  const leds = objectsWithLed(model);
  for (const o of overriddenObjects(model)) {
    const s = stateAt(step, o.id, o.state);
    if (s !== o.state) out.push(stateCss(model, o.id, s, leds.has(o.id)));
  }
  // Defaults from emit: caption of step 1 and metric value n = 0 are visible, all others hidden.
  tl.forEach((_, j) => {
    if ((j === k) !== (j === 0)) {
      out.push(`${ids.sel(ids.captionStep(j + 1))}{visibility:${j === k ? "visible" : "hidden"}}`);
    }
  });
  for (const m of model.scene.metrics) {
    const { ns, shown } = metricTexts(m.value, tl, m.id);
    for (const n of ns) {
      const visible = n === (shown[k] ?? 0);
      if (visible !== (n === 0)) {
        out.push(
          `${ids.sel(ids.metricValue(m.id, n))}{visibility:${visible ? "visible" : "hidden"}}`,
        );
      }
    }
  }
  return out.join("\n");
}

/** DC flows (`dc_f_*`) belong to the DC pack: always on, in every step, frame and loop. */
const isDcFlow = (f: SceneFlow): boolean => f.id.startsWith("dc_f_");

/** Flows shown in step `k`: all DC flows plus the step's flows (the base flows without steps). */
function flowsOfStep(model: RenderModel, k: number): readonly SceneFlow[] {
  const { flows, timeline: tl } = model.scene;
  if (tl.length === 0) return flows;
  return [...(tl[k]?.flows.filter((f) => !isDcFlow(f)) ?? []), ...flows.filter(isDcFlow)];
}

/** CSS motion needs `offset-path`; without it the particles would sit at the origin, so hide them. */
function supportsGuard(model: RenderModel): string {
  const g = particlesId(model.ids.prefix);
  return `@supports not (offset-path:path("M0 0")){\n${model.ids.sel(g)},${model.ids.sel(`${g}_dc`)}{display:none}\n}`;
}

function wrap(model: RenderModel, flowGroups: SvgElement[]): AnimationLayer["layers"] {
  return flowGroups.length === 0
    ? {}
    : { flows: [el("g", { id: particlesId(model.ids.prefix) }, flowGroups)] };
}

function compact<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((x): x is T => x !== undefined);
}

function join(...parts: readonly string[]): string {
  return parts.filter((p) => p !== "").join("\n");
}

// ---------------------------------------------------------------------------------------------
// frame and step modes
// ---------------------------------------------------------------------------------------------

function frameLayer(
  model: RenderModel,
  speed: number,
  win: Windows,
  time: number,
  colors: ParticleColors,
): AnimationLayer {
  const t = Number.isFinite(time) ? time : 0;
  const k = stepIndexAt(win, t);
  const groups = compact(flowsOfStep(model, k).map((f) => frozenFlow(model, f, speed, t, colors)));
  // Same camera curve as the loop's keyframes, so GIF/MP4 frames ease between steps.
  const viewBox = frameViewBox(
    model,
    win,
    model.scene.timeline.map((s) => zoomFor(model, s)),
    t,
  );
  // Figure boards: the exact pose and fades at this time, as attributes (no CSS in frames).
  const bm = boardsOf(model);
  const attrs = bm ? boardsFrame(bm.tracks(speed), t, speed) : undefined;
  return {
    css: join(colors.css(), staticStepCss(model, k)),
    defs: [],
    layers: wrap(model, groups),
    ...(viewBox ? { viewBox } : {}),
    ...(attrs ? { attrs } : {}),
    duration: 0,
  };
}

function stepLayer(
  model: RenderModel,
  speed: number,
  step: number | undefined,
  colors: ParticleColors,
  css: boolean,
): AnimationLayer {
  const count = model.scene.timeline.length;
  const wanted = Number.isFinite(step) ? Math.floor(step as number) : 1;
  const k = count === 0 ? 0 : Math.min(count, Math.max(1, wanted)) - 1;
  const flows = flowsOfStep(model, k);
  const kf = new Keyframes(model.ids.prefix);
  const flowCss: string[] = [];
  const groups = compact(
    flows.map((f) => {
      if (!css) return smilFlow(model, f, speed, colors);
      const c = cssFlow(model, f, speed, colors, kf);
      if (c) flowCss.push(c.css);
      return c?.node;
    }),
  );
  const zoom = zoomFor(model, model.scene.timeline[k]);
  // Particles are hidden under reduced motion (SMIL cannot be paused by CSS; CSS ones match it).
  const reduced =
    groups.length > 0
      ? `@media (prefers-reduced-motion:reduce){\n${model.ids.sel(particlesId(model.ids.prefix))}{display:none}\n}`
      : "";
  // Figure boards: the pose at the end of the step (its closing hold), as attributes.
  const bm = boardsOf(model);
  const attrs = bm && count > 0 ? boardsStepEnd(bm.tracks(speed), k + 1) : undefined;
  return {
    css: join(
      colors.css(),
      kf.css(),
      ...flowCss,
      css && groups.length > 0 ? supportsGuard(model) : "",
      staticStepCss(model, k),
      reduced,
    ),
    defs: [],
    layers: wrap(model, groups),
    ...(zoom ? { viewBox: zoom.viewBox } : {}),
    ...(attrs ? { attrs } : {}),
    duration: groups.length > 0 ? traversalSeconds(speed) : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// loop and interactive modes
// ---------------------------------------------------------------------------------------------

function loopLayer(
  model: RenderModel,
  speed: number,
  win: Windows,
  colors: ParticleColors,
  interactive: boolean,
  css: boolean,
): AnimationLayer {
  const { ids } = model;
  const tl = model.scene.timeline;
  const n = tl.length;
  const total = win.total;
  const kf = new Keyframes(ids.prefix);
  const rules: string[] = [];
  const reduced: string[] = [];
  const loopAnim = (name: string, timing = "step-end") =>
    `animation:${name} ${t4(total)}s ${timing} infinite`;

  // Particles: one group per distinct flow; visibility follows the steps that show it.
  const flowById = new Map<string, { flow: SceneFlow; steps: number[] }>();
  if (n === 0) {
    for (const f of model.scene.flows) flowById.set(f.id, { flow: f, steps: [] });
  } else {
    tl.forEach((_, i) => {
      for (const f of flowsOfStep(model, i)) {
        const e = flowById.get(f.id) ?? { flow: f, steps: [] };
        e.steps.push(i);
        flowById.set(f.id, e);
      }
    });
  }
  // Figure boards: sprite and fade tracks (CSS in both motion modes, D32). Specs without
  // figure actions have none, and keep the 1.1 reduced-motion rule.
  const bm = boardsOf(model);
  const bt = bm?.tracks(speed);
  const boardCss = hasBoardMotion(bt) ? boardsLoop(bt, ids, kf, total) : undefined;
  const poseMotion = boardCss !== undefined && boardCss.rules.length > 0;
  const flowGroups: SvgElement[] = [];
  const particleRules: string[] = [];
  for (const { flow, steps } of flowById.values()) {
    let g: SvgElement | undefined;
    if (css) {
      const c = cssFlow(model, flow, speed, colors, kf);
      g = c?.node;
      if (c) particleRules.push(c.css);
    } else {
      g = smilFlow(model, flow, speed, colors);
    }
    if (!g) continue;
    flowGroups.push(g);
    if (n > 0 && steps.length < n) {
      const values = tl.map((_, i) => `visibility:${steps.includes(i) ? "visible" : "hidden"}`);
      const name = kf.add(stopsFor(values, win.starts, total));
      rules.push(`${ids.sel(ids.flow(flow.id))}{${loopAnim(name)}}`);
    }
  }

  if (n > 0) {
    // Object states.
    const leds = objectsWithLed(model);
    for (const o of overriddenObjects(model)) {
      const seq = tl.map((s) => stateAt(s, o.id, o.state));
      const op = kf.add(
        stopsFor(
          seq.map((s) => `opacity:var(--pc-states-${s}-opacity)`),
          win.starts,
          total,
        ),
      );
      const ov = kf.add(
        stopsFor(
          seq.map((s) => `fill:var(--pc-states-${s}-overlay);stroke:var(--pc-states-${s}-stroke)`),
          win.starts,
          total,
        ),
      );
      rules.push(`${ids.sel(ids.object(o.id))}{${loopAnim(op)}}`);
      rules.push(`${ids.sel(ids.overlay(o.id))}{${loopAnim(ov)}}`);
      if (leds.has(o.id)) {
        const led = kf.add(
          stopsFor(
            seq.map((s) => `fill:var(--pc-dc-led-${LED_OF_STATE[s]})`),
            win.starts,
            total,
          ),
        );
        rules.push(`${ids.sel(ids.object(o.id))} .${ids.ledClass()}{${loopAnim(led)}}`);
      }
    }

    // Captions and metric values: visibility toggled per step.
    const toggle = (selector: string, visibleAt: (i: number) => boolean) => {
      const values = tl.map((_, i) => `visibility:${visibleAt(i) ? "visible" : "hidden"}`);
      const name = kf.add(stopsFor(values, win.starts, total));
      rules.push(`${selector}{${loopAnim(name)}}`);
    };
    tl.forEach((_, j) => {
      // Step 1's caption is visible by default; constant patterns equal to the default are skipped.
      if (n > 1 || j > 0) toggle(ids.sel(ids.captionStep(j + 1)), (i) => i === j);
    });
    for (const m of model.scene.metrics) {
      const { ns, shown } = metricTexts(m.value, tl, m.id);
      if (ns.length === 1) continue;
      for (const k of ns) toggle(ids.sel(ids.metricValue(m.id, k)), (i) => shown[i] === k);
    }

    // With figure motion the reduced rule keeps the step-end state animations (below).
    if (!poseMotion) reduced.push(staticStepCss(model, 0));
  }

  // Camera zoom (D27): the loop rests on the full overview (0% = overview), eases into step 1's
  // focus at the start of step 1, and each later transition fills the END of the previous step so
  // every step starts at its own view; the loop ends by easing back out to the overview.
  // Everything in the overlay layer (caption box, metric tiles, legend, interactive controls) sits
  // inside the camera group, so it gets the inverse transform on the same curve to stay put.
  if (boardCss) rules.push(...boardCss.rules);
  const zooms = tl.map((s) => zoomFor(model, s));
  const cam = ids.sel(ids.camera());
  const pinned = [
    ids.sel(ids.caption()),
    ...model.scene.metrics.map((m) => ids.sel(ids.metric(m.id))),
    legendSelector(ids),
    ...(bm?.creditsId !== undefined ? [ids.sel(bm.creditsId)] : []),
    ...(interactive ? [ids.sel(controlIds(ids.prefix, ids.root()).group)] : []),
  ];
  const pinSel = pinned.join(",");
  if (zooms.some((z) => z !== undefined) && total > 0) {
    const stops = cameraStops(zooms, win);
    const keyframes = (fmt: (z: Zoom | undefined) => string): [number, string][] =>
      stops.map((s) => [s.t / total, `transform:${fmt(s.z)}`]);
    rules.push(
      `${cam}{transform-origin:0 0;${loopAnim(kf.add(keyframes(cameraTransform)), EASE)}}`,
      `${pinSel}{transform-origin:0 0;${loopAnim(kf.add(keyframes(inverseCameraTransform)), EASE)}}`,
    );
    // Reduced motion rests on the overview (with figure motion the camera animation must be
    // switched off explicitly: an animation beats a plain `transform`).
    const off = poseMotion ? "animation:none;" : "";
    reduced.push(`${cam}{${off}transform:none}`, `${pinSel}{${off}transform:none}`);
  }

  // Reduced motion: no CSS animation (static first frame), particles hidden (SMIL cannot be paused by CSS).
  // Specs with figure motion instead show discrete per-step poses (each step its end pose, no
  // tween) and keep their step-end captions, states and metrics (§12).
  const root = ids.sel(ids.root());
  const motionOff = poseMotion
    ? [...(boardCss as { reduced: readonly string[] }).reduced, ...reduced]
    : [`${root} *{animation:none!important}`, ...reduced];
  if (flowGroups.length > 0) {
    motionOff.push(`${ids.sel(particlesId(ids.prefix))}{display:none}`);
  }
  const reducedCss =
    rules.length > 0 || flowGroups.length > 0
      ? `@media (prefers-reduced-motion:reduce){\n${motionOff.join("\n")}\n}`
      : "";

  const layers: Partial<Record<"flows" | "overlay", readonly SvgElement[]>> = {};
  if (flowGroups.length > 0) layers.flows = [el("g", { id: particlesId(ids.prefix) }, flowGroups)];

  let script: string | undefined;
  let controlCssText = "";
  if (interactive) {
    const cid = controlIds(ids.prefix, ids.root());
    layers.overlay = [controlNodes(ids.prefix, cid, model.viewBox)];
    controlCssText = controlCss(ids.prefix);
    // Step pauses at the settled time of steps that have actions (§7.5), else at the start.
    const targets = win.starts.map((s, i) => {
      const settled = bt?.settled[i];
      if (settled !== undefined) return settled / speed;
      return i === 0 && zooms[0] ? transitionSeconds(win.durations[0] ?? 0) : s;
    });
    script = interactiveScript(
      cid,
      win.starts,
      targets,
      total > 0 ? total : traversalSeconds(speed),
      particleClass(ids.prefix),
    );
  }

  // The loop length is the master timeline only if something on it changes value.
  const hasFlows = flowGroups.length > 0;
  const duration = rules.length > 0 ? total : hasFlows ? traversalSeconds(speed) : 0;
  return {
    css: join(
      colors.css(),
      controlCssText,
      kf.css(),
      particleRules.join("\n"),
      css && flowGroups.length > 0 ? supportsGuard(model) : "",
      rules.join("\n"),
      reducedCss,
    ),
    defs: [],
    layers,
    ...(script !== undefined ? { script } : {}),
    duration,
  };
}
