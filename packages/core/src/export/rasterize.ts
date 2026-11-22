/**
 * PNG rasterizer on `@resvg/resvg-wasm` (no native addon, no browser; DECISIONS D7). The wasm
 * binary is read from the package on first use; bundlers inline it and inject it with
 * `setResvgWasm` (call it before the first rasterize).
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import type { RasterizeFn } from "../contracts/index.js";

type WasmSource = Parameters<typeof initWasm>[0];

let source: WasmSource | undefined;
let ready: Promise<void> | undefined;

/** Supplies the resvg wasm (bytes, module or response) instead of reading it from node_modules. */
export function setResvgWasm(wasm: WasmSource): void {
  if (ready) throw new Error("resvg is already initialised; call setResvgWasm before rasterizing");
  source = wasm;
}

async function init(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        const wasm =
          (await source) ??
          (await readFile(
            createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm"),
          ));
        await initWasm(wasm);
      } catch (e) {
        ready = undefined; // allow a retry, e.g. after setResvgWasm with good bytes
        throw Object.assign(
          new Error(
            `could not initialise the resvg wasm renderer: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          ),
          { code: "RENDERER_INIT" },
        );
      }
    })();
  }
  return ready;
}

function renderPng(
  svg: string,
  scale: number,
  fonts: Parameters<RasterizeFn>[1]["fonts"],
): Uint8Array {
  const family = fonts[0]?.family;
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      fontBuffers: fonts.map((f) => f.sfnt),
      loadSystemFonts: false,
      ...(family
        ? { defaultFontFamily: family, sansSerifFamily: family, serifFamily: family }
        : {}),
    },
  });
  let png: Uint8Array;
  try {
    const image = resvg.render();
    try {
      png = image.asPng();
    } finally {
      image.free();
    }
  } catch (e) {
    // After a render panic the object is still borrowed and `free` throws "recursive use of an
    // object": that must not replace the real error.
    try {
      resvg.free();
    } catch {
      /* the render error is the one to report */
    }
    throw e;
  }
  resvg.free();
  return png;
}

const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const num = (v: string | undefined): number | undefined =>
  v !== undefined && new RegExp(`^${NUM}$`).test(v.trim()) ? Number(v) : undefined;

/**
 * resvg-wasm 2.6.2 panics ("unreachable") when a layer (a clipped symbol `<use>`, or opacity,
 * mask or filter) lies entirely beyond roughly one canvas size outside the canvas, which is what
 * a zoomed camera does to the icons of every node it leaves out. Returns the SVG without the
 * symbol `<use>` elements that are wholly outside the root viewBox (invisible, so removing them
 * changes no pixel), or undefined when none can be removed. A `<use>` under a transform, or with
 * one of its own, is kept: its box is not in viewBox coordinates.
 */
export function cullOffscreenSymbolUses(svg: string): string | undefined {
  const tokens = svg.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  const root = tokens.find((t) => /^<svg[\s>]/.test(t));
  const vb = (root ? attr(root, "viewBox") : undefined)
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return undefined;
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  const symbols = new Set<string>();
  for (const t of tokens) {
    if (t.startsWith("<symbol")) {
      const id = attr(t, "id");
      if (id) symbols.add(id);
    }
  }
  if (symbols.size === 0) return undefined;
  const open: boolean[] = []; // per open element: has a transform
  let transformed = 0;
  let removed = 0;
  const out: string[] = [];
  for (const t of tokens) {
    if (!t.startsWith("<") || t.startsWith("<!") || t.startsWith("<?")) {
      out.push(t);
    } else if (t.startsWith("</")) {
      if (open.pop()) transformed--;
      out.push(t);
    } else {
      const selfClosing = t.endsWith("/>");
      const hasTransform = attr(t, "transform") !== undefined;
      if (t.startsWith("<use") && selfClosing && !hasTransform && transformed === 0) {
        const ref = (attr(t, "href") ?? attr(t, "xlink:href"))?.replace(/^#/, "");
        const [x, y, w, h] = ["x", "y", "width", "height"].map((n) => num(attr(t, n)));
        if (
          ref !== undefined &&
          symbols.has(ref) &&
          x !== undefined &&
          y !== undefined &&
          w !== undefined &&
          h !== undefined &&
          (x + w <= vx || x >= vx + vw || y + h <= vy || y >= vy + vh)
        ) {
          removed++;
          continue;
        }
      }
      if (!selfClosing) {
        open.push(hasTransform);
        if (hasTransform) transformed++;
      }
      out.push(t);
    }
  }
  return removed > 0 ? out.join("") : undefined;
}

export const rasterize: RasterizeFn = async (svg, { scale, fonts }) => {
  await init();
  try {
    return renderPng(svg, scale, fonts);
  } catch (e) {
    const culled = cullOffscreenSymbolUses(svg);
    if (culled === undefined) throw e;
    try {
      return renderPng(culled, scale, fonts);
    } catch {
      throw e;
    }
  }
};
