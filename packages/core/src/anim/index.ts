/**
 * Animator (Track B): particles, master loop timeline, per-step and frame modes, reduced motion,
 * interactive controls. Pure and deterministic; all id selectors come from `ids.sel()`.
 */
import type {
  AnimateOptions,
  Animator,
  AnimationLayer,
  ObjectState,
  RenderModel,
  SceneFlow,
  SceneObject,
  SvgElement,
} from "../contracts/index.js";
import { Keyframes, el, stopsFor, t4 } from "./css.js";
import { controlCss, controlIds, controlNodes, interactiveScript } from "./interactive.js";
import {
  ParticleColors,
  frozenFlow,
  particlesId,
  smilFlow,
  traversalSeconds,
} from "./particles.js";
import {
  IDENTITY_TRANSFORM,
  cameraTransform,
  inverseCameraTransform,
  metricTexts,
  stateAt,
  stepIndexAt,
  windows,
  zoomFor,
  type Windows,
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

function animate(model: RenderModel, options: AnimateOptions): AnimationLayer {
  const speed = options.speed > 0 ? options.speed : 1;
  const timeline = model.scene.timeline;
  const win = windows(timeline, speed);
  const colors = new ParticleColors(model.ids.prefix);

  switch (options.mode) {
    case "frame":
      return frameLayer(model, speed, win, options.time ?? 0, colors);
    case "step":
      return stepLayer(model, speed, options.step, colors);
    default:
      return loopLayer(model, speed, win, colors, options.mode === "interactive");
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

function flowsOfStep(model: RenderModel, k: number): readonly SceneFlow[] {
  const tl = model.scene.timeline;
  return tl.length === 0 ? model.scene.flows : (tl[k]?.flows ?? []);
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
  const k = stepIndexAt(win, time);
  const groups = compact(
    flowsOfStep(model, k).map((f) => frozenFlow(model, f, speed, time, colors)),
  );
  const zoom = zoomFor(model, model.scene.timeline[k]);
  return {
    css: join(colors.css(), staticStepCss(model, k)),
    defs: [],
    layers: wrap(model, groups),
    ...(zoom ? { viewBox: zoom.viewBox } : {}),
    duration: 0,
  };
}

function stepLayer(
  model: RenderModel,
  speed: number,
  step: number | undefined,
  colors: ParticleColors,
): AnimationLayer {
  const count = model.scene.timeline.length;
  const k = count === 0 ? 0 : Math.min(count, Math.max(1, step ?? 1)) - 1;
  const flows = flowsOfStep(model, k);
  const groups = compact(flows.map((f) => smilFlow(model, f, speed, colors)));
  const zoom = zoomFor(model, model.scene.timeline[k]);
  return {
    css: join(colors.css(), staticStepCss(model, k)),
    defs: [],
    layers: wrap(model, groups),
    ...(zoom ? { viewBox: zoom.viewBox } : {}),
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
    tl.forEach((s, i) => {
      for (const f of s.flows) {
        const e = flowById.get(f.id) ?? { flow: f, steps: [] };
        e.steps.push(i);
        flowById.set(f.id, e);
      }
    });
  }
  const flowGroups: SvgElement[] = [];
  for (const { flow, steps } of flowById.values()) {
    const g = smilFlow(model, flow, speed, colors);
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

    reduced.push(staticStepCss(model, 0));
  }

  // Camera zoom (and the inverse transform that keeps interactive controls on screen).
  const zooms = tl.map((s) => zoomFor(model, s));
  const transforms = zooms.map(cameraTransform);
  const inverses = zooms.map(inverseCameraTransform);
  const cam = ids.sel(ids.camera());
  const controlsSel = ids.sel(controlIds(ids.prefix, ids.root()).group);
  const zoomed = transforms.some((t) => t !== IDENTITY_TRANSFORM);
  if (zoomed) {
    const anyDiffers = transforms.some((t) => t !== transforms[0]);
    if (!anyDiffers) {
      rules.push(`${cam}{transform-origin:0 0;transform:${transforms[0]}}`);
      if (interactive) rules.push(`${controlsSel}{transform-origin:0 0;transform:${inverses[0]}}`);
    } else {
      const trs = win.durations.map((d) => Math.min(0.8, 0.25 * d));
      const stops = (list: readonly string[]): [number, string][] => {
        const out: [number, string][] = [];
        list.forEach((v, i) => {
          const prev = list[(i + n - 1) % n] ?? v;
          out.push([(win.starts[i] ?? 0) / total, `transform:${prev}`]);
          out.push([((win.starts[i] ?? 0) + (trs[i] ?? 0)) / total, `transform:${v}`]);
        });
        out.push([1, `transform:${list[n - 1] ?? IDENTITY_TRANSFORM}`]);
        return out;
      };
      const camName = kf.add(stops(transforms));
      rules.push(`${cam}{transform-origin:0 0;${loopAnim(camName, EASE)}}`);
      if (interactive) {
        const invName = kf.add(stops(inverses));
        rules.push(`${controlsSel}{transform-origin:0 0;${loopAnim(invName, EASE)}}`);
      }
    }
    reduced.push(`${cam}{transform:none}`);
    if (interactive) reduced.push(`${controlsSel}{transform:none}`);
  }

  // Reduced motion: no CSS animation (static first frame), particles hidden (SMIL cannot be paused by CSS).
  const root = ids.sel(ids.root());
  const motionOff = [`${root} *{animation:none!important}`, ...reduced];
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
    const trs = win.durations.map((d) => Math.min(0.8, 0.25 * d));
    const settled = win.starts.map((s, i) => s + (trs[i] ?? 0));
    script = interactiveScript(
      cid,
      win.starts,
      settled,
      total > 0 ? total : traversalSeconds(speed),
    );
  }

  const hasFlows = flowGroups.length > 0;
  const duration = n > 0 ? total : hasFlows ? traversalSeconds(speed) : 0;
  return {
    css: join(colors.css(), controlCssText, kf.css(), rules.join("\n"), reducedCss),
    defs: [],
    layers,
    ...(script !== undefined ? { script } : {}),
    duration,
  };
}
