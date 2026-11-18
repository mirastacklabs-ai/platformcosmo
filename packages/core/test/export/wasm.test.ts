import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { rasterize, setResvgWasm } from "../../src/export/rasterize.js";
import { pngSize } from "../../src/export/png.js";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6"><rect width="10" height="6" fill="red"/></svg>';

// Own file: the wasm initialises once per module instance.
describe("resvg wasm injection and recovery", () => {
  test("failed init reports a clear error, clears the cache, and a retry with good bytes works", async () => {
    setResvgWasm(new Uint8Array([1, 2, 3]));
    await expect(rasterize(svg, { scale: 1, fonts: [] })).rejects.toThrow(
      /could not initialise the resvg wasm renderer/,
    );
    const bytes = readFileSync(
      createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm"),
    );
    setResvgWasm(new Uint8Array(bytes));
    const png = await rasterize(svg, { scale: 2, fonts: [] });
    expect(pngSize(png)).toEqual({ width: 20, height: 12 });
  });

  test("setResvgWasm after initialisation is refused", () => {
    expect(() => setResvgWasm(new Uint8Array([0]))).toThrow(/already initialised/);
  });
});
