/**
 * Exporters (Track B): static, steps, interactive, png, gif and mp4. Everything except `animated`
 * is built here from the model with the injected animator/emit/optimize/rasterize stages, so
 * `render()` only wires them up. All outputs are deterministic (mp4 depends on the system ffmpeg).
 */
import type {
  Diagnostic,
  ExportFn,
  OutputKind,
  RenderModel,
  RenderOutput,
} from "../contracts/index.js";
import { gifEncoder } from "./gif.js";
import { pngSize } from "./png.js";

export { gifEncoder } from "./gif.js";
export { rasterize, setResvgWasm } from "./rasterize.js";
export { buildFfmpegArgs, createFfmpegEncoder, ffmpegAvailable } from "./ffmpeg.js";
export type { FfmpegEncoderOptions } from "./ffmpeg.js";

/** frames x width x height x 4 may not exceed this (PLAN: memory cap). */
export const MAX_RASTER_BYTES = 1024 ** 3;
const MAX_VIDEO_SECONDS = 120;
const SVG_MIME = "image/svg+xml";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** True when the root `<svg>` carries its own width/height (then resvg sizes from those). */
function hasSizeAttrs(svg: string): boolean {
  const root = /^<svg\b[^>]*>/.exec(svg.trimStart())?.[0] ?? "";
  return /\swidth="/.test(root) && /\sheight="/.test(root);
}

export const exportOutputs: ExportFn = async (model, kinds, deps, options) => {
  const wanted = new Set<OutputKind>(kinds);
  const outputs: RenderOutput[] = [];
  const diagnostics: Diagnostic[] = [];
  const name = options.name ?? "diagram";
  const speed = options.speed ?? 1;
  const font = options.font ?? "embed";
  const finish = (svg: string): string => (options.optimize === false ? svg : deps.optimize(svg));

  const svgOutput = (
    kind: OutputKind,
    path: string,
    m: RenderModel,
    animation: Parameters<typeof deps.emit>[1],
    step?: number,
  ): void => {
    outputs.push({
      kind,
      path,
      mime: SVG_MIME,
      data: finish(deps.emit(m, animation, { font })),
      ...(step !== undefined ? { step } : {}),
    });
  };

  if (wanted.has("static")) {
    const m = deps.withVariant(model, "-st");
    svgOutput(
      "static",
      `${name}.static.svg`,
      m,
      deps.animator.animate(m, { speed, mode: "frame", time: 0 }),
    );
  }

  if (wanted.has("steps")) {
    const count = model.scene.timeline.length;
    if (count === 0) {
      diagnostics.push({
        severity: "info",
        code: "export/no-steps",
        path: "/steps",
        message: "The spec has no steps, so no per-step output was written.",
      });
    }
    for (let i = 1; i <= count; i++) {
      const m = deps.withVariant(model, `-s${pad2(i)}`);
      svgOutput(
        "steps",
        `${name}.steps/step-${pad2(i)}.svg`,
        m,
        deps.animator.animate(m, { speed, mode: "step", step: i }),
        i,
      );
    }
  }

  if (wanted.has("interactive")) {
    const m = deps.withVariant(model, "-x");
    svgOutput(
      "interactive",
      `${name}.interactive.svg`,
      m,
      deps.animator.animate(m, { speed, mode: "interactive" }),
    );
  }

  // Raster outputs ----------------------------------------------------------------------------
  let lastSvg: string | undefined;
  let lastPng: Uint8Array | undefined;
  const renderFrame = async (time: number, scale: number): Promise<Uint8Array> => {
    const layer = deps.animator.animate(model, { speed, mode: "frame", time });
    const svg = deps.emit(model, layer, { font, target: "raster" });
    const key = `${scale}|${svg}`;
    if (lastPng && key === lastSvg) return lastPng;
    const vb = layer.viewBox ?? model.viewBox;
    // A zoomed frame has a smaller viewBox: scale up so every frame has the same pixel size.
    const zoomed = vb.width !== model.viewBox.width && !hasSizeAttrs(svg);
    const eff = zoomed ? scale * (model.viewBox.width / vb.width) * (1 - 1e-9) : scale;
    const png = await deps.rasterize(svg, { scale: eff, fonts: model.fontAssets });
    lastSvg = key;
    lastPng = png;
    return png;
  };
  const tooLarge = (kind: OutputKind, scale: number, frames: number): boolean => {
    const w = Math.ceil(model.viewBox.width * scale);
    const h = Math.ceil(model.viewBox.height * scale);
    if (frames * w * h * 4 <= MAX_RASTER_BYTES) return false;
    diagnostics.push({
      severity: "error",
      code: "export/too-large",
      path: "",
      message: `${kind} output would need ${frames} frame(s) of ${w}x${h} pixels, over the 1 GiB memory cap.`,
      suggestion: "Lower png.scale, video.fps or video.durationSec, or reduce the diagram size.",
      params: { kind, frames, width: w, height: h },
    });
    return true;
  };

  if (wanted.has("png")) {
    const scale = options.png?.scale ?? 2;
    if (!tooLarge("png", scale, 1)) {
      outputs.push({
        kind: "png",
        path: `${name}.png`,
        mime: "image/png",
        data: await renderFrame(options.png?.time ?? 0, scale),
      });
    }
  }

  const videoKinds = (["gif", "mp4"] as const).filter((k) => wanted.has(k));
  if (videoKinds.length > 0) {
    const fps = options.video?.fps ?? 24;
    const loop = deps.animator.animate(model, { speed, mode: "loop" }).duration;
    const seconds = Math.min(options.video?.durationSec ?? loop, MAX_VIDEO_SECONDS);
    const count = seconds > 0 ? Math.max(1, Math.round(seconds * fps)) : 1;
    for (const kind of videoKinds) {
      if (kind === "mp4" && !options.video?.encoder) {
        throw new Error(
          "mp4 output requires options.video.encoder (the CLI supplies an ffmpeg one)",
        );
      }
      if (tooLarge(kind, 1, count)) continue;
      const frames: Uint8Array[] = [];
      for (let i = 0; i < count; i++) frames.push(await renderFrame(i / fps, 1));
      const first = frames[0];
      if (!first) continue;
      const { width, height } = pngSize(first);
      const encoder = kind === "mp4" ? options.video?.encoder : gifEncoder;
      const data = await encoder!.encode(frames, { fps, width, height, format: kind });
      outputs.push({
        kind,
        path: `${name}.${kind}`,
        mime: kind === "gif" ? "image/gif" : "video/mp4",
        data,
      });
    }
  }

  return { outputs, diagnostics };
};
