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

export const rasterize: RasterizeFn = async (svg, { scale, fonts }) => {
  await init();
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
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
};
