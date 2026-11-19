/**
 * Exporters (Track B): static, steps, interactive, png, gif and mp4. Everything except `animated`
 * is built here from the model with the injected animator/emit/optimize/rasterize stages, so
 * `render()` only wires them up. All outputs are deterministic (mp4 depends on the system ffmpeg).
 */
import { r2, t4 } from "../anim/css.js";
import type {
  AnimationLayer,
  Diagnostic,
  VideoSink,
  ExportFn,
  OutputKind,
  RenderModel,
  RenderOutput,
} from "../contracts/index.js";
import { gifEncoder } from "./gif.js";
import { validateRenderOptions } from "./options.js";
import { pngSize } from "./png.js";
import { bufferingSink, MAX_OUTPUT_BYTES, OutputTooLargeError } from "./stream.js";

export { gifEncoder } from "./gif.js";
export { rasterize, setResvgWasm } from "./rasterize.js";
export { validateRenderOptions } from "./options.js";

/** One raster frame (width x height x 4) may not exceed this (D33: frames are streamed). */
export const MAX_FRAME_BYTES = 256 * 1024 ** 2;
/** Whole-clip cap for encoders without `open` (their frames are buffered). */
const MAX_CLIP_BYTES = 1024 ** 3;
const MAX_VIDEO_SECONDS = 120;
const MAX_GIF_FPS = 50;
const SVG_MIME = "image/svg+xml";

/** Aborting must never reject or leave the export hanging. */
async function abortSink(sink: VideoSink | undefined): Promise<void> {
  try {
    await sink?.abort();
  } catch {
    /* abort never rejects by contract; ignore a misbehaving one */
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Pins the root `<svg>` pixel size to the model's view box. A zoomed frame has a smaller
 * `viewBox`; with fixed width/height resvg renders it at the same pixel size as every other
 * frame (the zoomed view box keeps the model's aspect ratio).
 */
function withRootSize(
  svg: string,
  vb: { readonly width: number; readonly height: number },
): string {
  let replaced = false;
  const out = svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    replaced = true;
    const rest = attrs.replace(/\s(?:width|height)="[^"]*"/g, "");
    return `<svg width="${vb.width}" height="${vb.height}"${rest}>`;
  });
  if (!replaced) throw new Error("raster emit produced no root <svg> element");
  return out;
}

/**
 * Zoomed step/frame outputs shrink the viewBox, and the overlay layer (caption box, metric tiles,
 * legend) is laid out for the full view: wrap it in the inverse zoom so it stays where it would
 * be on screen. Done on the model (an attribute, which resvg honours; CSS `transform` it does not).
 */
function pinOverlay(m: RenderModel, animation: AnimationLayer): RenderModel {
  const vb = animation.viewBox;
  if (!vb || m.layers.overlay.length === 0) return m;
  const s = m.viewBox.width / vb.width;
  const transform = `translate(${r2(vb.x - m.viewBox.x / s)} ${r2(vb.y - m.viewBox.y / s)}) scale(${t4(1 / s)})`;
  return {
    ...m,
    layers: {
      ...m.layers,
      overlay: [{ tag: "g", attrs: { transform }, children: m.layers.overlay }],
    },
  };
}

export const exportOutputs: ExportFn = async (model, kinds, deps, options) => {
  const invalid = validateRenderOptions(options);
  if (invalid.some((d) => d.severity === "error")) return { outputs: [], diagnostics: invalid };
  const wanted = new Set<OutputKind>(kinds);
  if (wanted.has("mp4") && !options.video?.encoder) {
    throw new Error("mp4 output requires options.video.encoder (the CLI supplies an ffmpeg one)");
  }
  const outputs: RenderOutput[] = [];
  const diagnostics: Diagnostic[] = [];
  const name = options.name ?? "diagram";
  const speed = options.speed ?? 1;
  const font = model.font;
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
      data: finish(deps.emit(pinOverlay(m, animation), animation, { font })),
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
    const svg = withRootSize(
      deps.emit(pinOverlay(model, layer), layer, { font, target: "raster" }),
      model.viewBox,
    );
    const key = `${scale}|${svg}`;
    if (lastPng && key === lastSvg) return lastPng;
    const png = await deps.rasterize(svg, { scale, fonts: model.fontAssets });
    lastSvg = key;
    lastPng = png;
    return png;
  };
  /**
   * D33 limits: one frame (and a PNG) is at most 256 MiB of RGBA. An encoder without `open`
   * gets the whole clip buffered, so there frames x w x h x 4 is capped at 1 GiB too.
   */
  const tooLarge = (kind: OutputKind, scale: number, frames: number, buffered = false): boolean => {
    const w = Math.ceil(model.viewBox.width * scale);
    const h = Math.ceil(model.viewBox.height * scale);
    const params = { kind, frames, width: w, height: h };
    if (w * h * 4 > MAX_FRAME_BYTES) {
      diagnostics.push({
        severity: "error",
        code: "export/too-large",
        path: "",
        message: `${kind} output frames would be ${w}x${h} pixels (${Math.ceil((w * h * 4) / 1024 ** 2)} MiB each), over the 256 MiB per-frame limit.`,
        suggestion:
          kind === "png"
            ? "Use a smaller --scale."
            : "Use a smaller --scale or reduce the diagram.",
        params,
      });
      return true;
    }
    if (buffered && frames * w * h * 4 > MAX_CLIP_BYTES) {
      diagnostics.push({
        severity: "error",
        code: "export/too-large",
        path: "",
        message: `${kind} encoder buffers the whole clip: ${frames} frame(s) of ${w}x${h} pixels is over the 1 GiB cap.`,
        suggestion: "Lower --fps or --duration, or use an encoder that streams.",
        params,
      });
      return true;
    }
    return false;
  };
  const outputTooLarge = (kind: OutputKind, bytes: number): void => {
    diagnostics.push({
      severity: "error",
      code: "export/too-large",
      path: "",
      message: `${kind} output is ${bytes} bytes, over the 1 GiB encoded-output cap.`,
      suggestion: "Lower --fps or --duration, or use --scale for a smaller frame size.",
      params: { kind, bytes },
    });
  };

  if (wanted.has("png")) {
    const scale = options.png?.scale ?? 2;
    if (!tooLarge("png", scale, 1)) {
      try {
        outputs.push({
          kind: "png",
          path: `${name}.png`,
          mime: "image/png",
          data: await renderFrame(options.png?.time ?? 0, scale),
        });
      } catch (e) {
        diagnostics.push({
          severity: "error",
          code: "export/raster-failed",
          path: "",
          message: `png rasterization failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  const videoKinds = (["gif", "mp4"] as const).filter((k) => wanted.has(k));
  if (videoKinds.length > 0) {
    const fps = options.video?.fps ?? 24;
    const loop = deps.animator.animate(model, { speed, mode: "loop" }).duration;
    const wantedSeconds = options.video?.durationSec ?? loop;
    const seconds = Math.min(wantedSeconds, MAX_VIDEO_SECONDS);
    if (options.video?.durationSec === undefined && wantedSeconds > MAX_VIDEO_SECONDS) {
      diagnostics.push({
        severity: "info",
        code: "export/video-capped",
        path: "",
        message: `The timeline loop is ${Math.round(wantedSeconds)} s; the video was capped at ${MAX_VIDEO_SECONDS} s.`,
      });
    }
    // GIF delays are whole centiseconds: above 50 fps they would round to 1 cs or 0, so the GIF
    // is sampled at most 50 fps. Frames are rasterized once per rate and shared by gif and mp4.
    const gifFps = Math.min(fps, MAX_GIF_FPS);
    if (wanted.has("gif") && gifFps < fps) {
      diagnostics.push({
        severity: "warning",
        code: "export/gif-fps-lowered",
        path: "/video/fps",
        message: `GIF frame delays are whole centiseconds, so the GIF uses ${gifFps} fps instead of ${fps}.`,
      });
    }
    // Frames are streamed (D33): each is rasterized, handed to every sink wanting that rate and
    // dropped, so at most one PNG (plus the encoder's own working frame) is alive at a time.
    // gif and mp4 at the same rate share one rasterization pass.
    const byRate = new Map<number, { kind: "gif" | "mp4"; count: number }[]>();
    for (const kind of videoKinds) {
      const rate = kind === "gif" ? gifFps : fps;
      const count = seconds > 0 ? Math.max(1, Math.round(seconds * rate)) : 1;
      const enc = kind === "mp4" ? options.video?.encoder : gifEncoder;
      if (tooLarge(kind, 1, count, !enc?.open)) continue;
      byRate.set(rate, [...(byRate.get(rate) ?? []), { kind, count }]);
    }
    for (const [rate, jobs] of byRate) {
      const count = jobs[0]!.count;
      const sinks = new Map<"gif" | "mp4", VideoSink>();
      const failed = new Set<"gif" | "mp4">();
      const fail = async (kind: "gif" | "mp4", e: unknown): Promise<void> => {
        failed.add(kind);
        const sink = sinks.get(kind);
        sinks.delete(kind);
        await abortSink(sink);
        if (e instanceof OutputTooLargeError) return outputTooLarge(kind, e.bytes);
        diagnostics.push({
          severity: "error",
          code: "export/encode-failed",
          path: "",
          message: `${kind} encoding failed: ${e instanceof Error ? e.message : String(e)}`,
          params: { kind },
        });
      };
      try {
        for (let i = 0; i < count && failed.size < jobs.length; i++) {
          const frame = await renderFrame(i / rate, 1);
          if (i === 0) {
            const { width, height } = pngSize(frame);
            for (const { kind } of jobs) {
              const encoder = (kind === "mp4" ? options.video?.encoder : gifEncoder)!;
              const o = { fps: rate, width, height, format: kind } as const;
              try {
                sinks.set(kind, encoder.open ? await encoder.open(o) : bufferingSink(encoder, o));
              } catch (e) {
                await fail(kind, e);
              }
            }
          }
          for (const [kind, sink] of [...sinks]) {
            try {
              await sink.write(frame);
            } catch (e) {
              await fail(kind, e);
            }
          }
        }
        for (const [kind, sink] of [...sinks]) {
          try {
            const data = await sink.finish();
            sinks.delete(kind);
            if (data.length > MAX_OUTPUT_BYTES) {
              outputTooLarge(kind, data.length);
              continue;
            }
            outputs.push({
              kind,
              path: `${name}.${kind}`,
              mime: kind === "gif" ? "image/gif" : "video/mp4",
              data,
            });
          } catch (e) {
            await fail(kind, e);
          }
        }
      } catch (e) {
        // Rasterization itself failed: every sink of this pass is lost.
        for (const { kind } of jobs) if (!failed.has(kind)) await fail(kind, e);
      } finally {
        for (const sink of [...sinks.values()]) await abortSink(sink);
        lastPng = undefined;
        lastSvg = undefined;
      }
    }
  }

  return { outputs, diagnostics };
};
