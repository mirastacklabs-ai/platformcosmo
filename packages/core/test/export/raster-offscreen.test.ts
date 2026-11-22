import { describe, expect, test } from "vitest";
import { decodePng, pngSize } from "../../src/export/png.js";
import { cullOffscreenSymbolUses, rasterize } from "../../src/export/rasterize.js";

// resvg-wasm 2.6.2 panics on a clipped symbol `<use>` far outside the canvas (a zoomed camera
// leaves most node icons there); the panic surfaced as gif/png "recursive use of an object".
const sym =
  '<symbol id="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></symbol>';
const doc = (body: string, vb = "0 0 100 100") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="${vb}"><defs>${sym}</defs><rect width="100" height="100" fill="#fff"/>${body}</svg>`;
const near = '<use href="#i" x="10" y="10" width="24" height="24"/>';
const far = '<use href="#i" x="1000" y="10" width="24" height="24"/>';

describe("offscreen symbol uses", () => {
  test("a far-offscreen symbol use renders (fails without the cull)", async () => {
    const svg = doc(near + far);
    const png = await rasterize(svg, { scale: 1, fonts: [] });
    expect(pngSize(png)).toEqual({ width: 100, height: 100 });
    // pixels are exactly those of the same document without the invisible use
    const plain = await rasterize(doc(near), { scale: 1, fonts: [] });
    expect(Buffer.compare(decodePng(png).data, decodePng(plain).data)).toBe(0);
    // and the output is deterministic
    expect(Buffer.compare(png, await rasterize(svg, { scale: 1, fonts: [] }))).toBe(0);
  });

  test("cull removes only wholly-outside, untransformed symbol uses", () => {
    expect(cullOffscreenSymbolUses(doc(near))).toBeUndefined();
    expect(cullOffscreenSymbolUses(doc(near + far))).toBe(doc(near));
    const moved = `<g transform="translate(-1000 0)">${far}</g>`;
    expect(cullOffscreenSymbolUses(doc(moved))).toBeUndefined();
    const own = '<use href="#i" x="1000" y="0" width="24" height="24" transform="scale(1)"/>';
    expect(cullOffscreenSymbolUses(doc(own))).toBeUndefined();
    const notSym = '<use href="#other" x="1000" y="0" width="24" height="24"/>';
    expect(cullOffscreenSymbolUses(doc(notSym))).toBeUndefined();
  });
});
