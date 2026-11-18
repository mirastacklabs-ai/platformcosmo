/**
 * Exporters (Track B): static, steps, interactive, png, gif and mp4. Everything except `animated`
 * is built here from the model with the injected animator/emit/optimize/rasterize stages, so
 * `render()` only wires them up. All outputs are deterministic (mp4 depends on the system ffmpeg).
 */
import { r2, t4 } from "../anim/css.js";
import type {
  AnimationLayer,
  Diagnostic,
  ExportFn,
  OutputKind,
  RenderModel,
  RenderOutput,
} from "../contracts/index.js";
import { gifEncoder } from "./gif.js";
import { validateRenderOptions } from "./options.js";
import { pngSize } from "./png.js";

export { gifEncoder } from "./gif.js";
export { rasterize, setResvgWasm } from "./rasterize.js";
export { validateRenderOptions } from "./options.js";

/** frames x width x height x 4 may not exceed this (PLAN: memory cap). */
export const MAX_RASTER_BYTES = 1024 ** 3;
const MAX_VIDEO_SECONDS = 120;
const SVG_MIME = "image/svg+xml";

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
  return svg.replace(/^(\s*)<svg\b([^>]*)>/, (_m, ws: string, attrs: string) => {
    const rest = attrs.replace(/\s(?:width|height)="[^"]*"/g, "");
    return `${ws}<svg width="${vb.width}" height="${vb.height}"${rest}>`;
  });
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
    const seconds = Math.min(options.video?.durationSec ?? loop, MAX_VIDEO_SECONDS);
    const count = seconds > 0 ? Math.max(1, Math.round(seconds * fps)) : 1;
    // Frames are rasterized once and shared by gif and mp4.
    let frames: Promise<Uint8Array[]> | undefined;
    const getFrames = (): Promise<Uint8Array[]> =>
      (frames ??= (async () => {
        const list: Uint8Array[] = [];
        for (let i = 0; i < count; i++) list.push(await renderFrame(i / fps, 1));
        return list;
      })());
    for (const kind of videoKinds) {
      if (tooLarge(kind, 1, count)) continue;
      try {
        const list = await getFrames();
        const first = list[0];
        if (!first) continue;
        const { width, height } = pngSize(first);
        const encoder = kind === "mp4" ? options.video?.encoder : gifEncoder;
        const data = await encoder!.encode(list, { fps, width, height, format: kind });
        outputs.push({
          kind,
          path: `${name}.${kind}`,
          mime: kind === "gif" ? "image/gif" : "video/mp4",
          data,
        });
      } catch (e) {
        diagnostics.push({
          severity: "error",
          code: "export/encode-failed",
          path: "",
          message: `${kind} encoding failed: ${e instanceof Error ? e.message : String(e)}`,
          params: { kind },
        });
      }
    }
  }

  return { outputs, diagnostics };
};
