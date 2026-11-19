/**
 * Validation of `RenderOptions` bounds (contract `RenderOptions` doc). Errors, never clamps.
 * Called by `exportOutputs` and by `render()`.
 */
import type { Diagnostic, OutputKind, RenderOptions } from "../contracts/index.js";

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const KINDS: readonly OutputKind[] = [
  "animated",
  "static",
  "steps",
  "interactive",
  "png",
  "gif",
  "mp4",
];
const ID_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

function err(code: string, path: string, message: string, suggestion?: string): Diagnostic {
  return {
    severity: "error",
    code,
    path,
    message,
    ...(suggestion ? { suggestion } : {}),
  };
}

/** Code-point order (locale independent, deterministic). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `options/*` error diagnostics, sorted by (path, code); empty when the options are valid. */
export function validateRenderOptions(options: RenderOptions | undefined): Diagnostic[] {
  const o = options ?? {};
  const out: Diagnostic[] = [];
  if (o.name !== undefined && (typeof o.name !== "string" || !NAME.test(o.name))) {
    out.push(
      err(
        "options/invalid-name",
        "/name",
        "name must match ^[A-Za-z0-9._-]{1,64}$ (no path separators).",
        "Use letters, digits, '.', '_' and '-' only.",
      ),
    );
  }
  if (o.idPrefix !== undefined && (typeof o.idPrefix !== "string" || !ID_PREFIX.test(o.idPrefix))) {
    out.push(
      err("options/invalid-id-prefix", "/idPrefix", "idPrefix must match ^[a-z][a-z0-9-]{0,31}$."),
    );
  }
  if (o.speed !== undefined && !(isNum(o.speed) && o.speed > 0 && o.speed <= 10)) {
    out.push(err("options/invalid-speed", "/speed", "speed must be a number in (0, 10]."));
  }
  if (o.motion !== undefined && o.motion !== "smil" && o.motion !== "css") {
    out.push(err("options/invalid-motion", "/motion", 'motion must be "smil" or "css".'));
  }
  const scale = o.png?.scale;
  if (scale !== undefined && !(isNum(scale) && scale > 0 && scale <= 8)) {
    out.push(
      err("options/invalid-png-scale", "/png/scale", "png.scale must be a number in (0, 8]."),
    );
  }
  const time = o.png?.time;
  if (time !== undefined && !(isNum(time) && time >= 0)) {
    out.push(err("options/invalid-png-time", "/png/time", "png.time must be a number >= 0."));
  }
  const fps = o.video?.fps;
  if (fps !== undefined && !(isNum(fps) && fps >= 1 && fps <= 60)) {
    out.push(
      err("options/invalid-video-fps", "/video/fps", "video.fps must be a number in [1, 60]."),
    );
  }
  const dur = o.video?.durationSec;
  if (dur !== undefined && !(isNum(dur) && dur > 0 && dur <= 120)) {
    out.push(
      err(
        "options/invalid-video-duration",
        "/video/durationSec",
        "video.durationSec must be a number in (0, 120].",
      ),
    );
  }
  for (const k of o.outputs ?? []) {
    if (!KINDS.includes(k)) {
      out.push(err("options/invalid-output", "/outputs", `Unknown output kind "${String(k)}".`));
    }
  }
  return out.sort((a, b) => (a.path === b.path ? cmp(a.code, b.code) : cmp(a.path, b.path)));
}
