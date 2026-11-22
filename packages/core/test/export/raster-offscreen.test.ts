import { describe, expect, test } from "vitest";
import { decodePng, pngSize } from "../../src/export/png.js";
import { cullOffscreenSymbolUses, rasterize } from "../../src/export/rasterize.js";

// resvg-wasm 2.6.2 traps (no unwinding) on a clipped symbol `<use>` far outside the canvas, which
// a zoomed camera produces for every node icon it leaves out. It surfaced as gif/png "recursive
// use of an object". Our own output must never trap: such uses are culled before rendering.
const sym =
  '<symbol id="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></symbol>';
const doc = (body: string, vb = "0 0 100 100", root = "", extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="${vb}"${root}>${extra}<defs>${sym}</defs><rect x="-500" y="-500" width="1000" height="1000" fill="#fff"/>${body}</svg>`;
const use = (x: number, y: number, extra = "") =>
  `<use href="#i" x="${x}" y="${y}" width="24" height="24"${extra}/>`;
const near = use(10, 10);
const far = use(1000, 10);

describe("offscreen symbol uses", () => {
  test("a far-offscreen symbol use renders, with the pixels of the doc without it", async () => {
    const png = await rasterize(doc(near + far), { scale: 1, fonts: [] });
    expect(pngSize(png)).toEqual({ width: 100, height: 100 });
    const plain = await rasterize(doc(near), { scale: 1, fonts: [] });
    expect(Buffer.compare(decodePng(png).data, decodePng(plain).data)).toBe(0);
    expect(Buffer.compare(png, await rasterize(doc(near + far), { scale: 1, fonts: [] }))).toBe(0);
  });

  test("300 zoomed-camera frames in one process: no trap, no leak-driven failure", async () => {
    const d = doc(near + far);
    for (let i = 0; i < 300; i++) await rasterize(d, { scale: 1, fonts: [] });
  }, 120_000);

  test("culls only clearly-outside uses, on both axes, with a non-zero viewBox origin", () => {
    const vb = "50 60 100 100"; // x 50..150, y 60..160
    const c = (body: string) => cullOffscreenSymbolUses(doc(body, vb));
    expect(c(near)).toBe(doc("", vb)); // x 10..34 is left of 50-1
    expect(c(use(100, 100))).toBeUndefined(); // inside
    expect(c(use(200, 100))).toBe(doc("", vb)); // right
    expect(c(use(100, 0))).toBe(doc("", vb)); // above: y 0..24 < 59
    expect(c(use(100, 300))).toBe(doc("", vb)); // below
  });

  test("exact edges: touching or within the 1-unit margin is kept", () => {
    const c = (body: string) => cullOffscreenSymbolUses(doc(body));
    expect(c(use(100, 10))).toBeUndefined(); // abuts the right edge
    expect(c(use(101, 10))).toBeUndefined(); // exactly margin away
    expect(c(use(101.5, 10))).toBe(doc(""));
    expect(c(use(-25, 10))).toBeUndefined(); // right edge at -1
    expect(c(use(-25.5, 10))).toBe(doc(""));
    expect(c(use(10, 101))).toBeUndefined();
    expect(c(use(10, -25))).toBeUndefined();
    expect(c(use(10, -26))).toBe(doc(""));
  });

  test("a sibling after a closing transformed group is culled again", () => {
    const body = `<g transform="translate(5 5)">${far}</g>${far}`;
    expect(cullOffscreenSymbolUses(doc(body))).toBe(
      doc(`<g transform="translate(5 5)">${far}</g>`),
    );
  });

  test.each([
    ["transformed group", `<g transform="translate(-1000 0)">${far}</g>`],
    ["single-quoted transform", `<g transform='translate(-1000 0)'>${far}</g>`],
    ["spaced single-quoted transform", `<g transform = 'translate(-1000 0)'>${far}</g>`],
    ["filter group", `<g filter="url(#f)">${far}</g>`],
    ["mask group", `<g mask="url(#m)">${far}</g>`],
    ["clip-path group", `<g clip-path="url(#c)">${far}</g>`],
    ["style group", `<g style="transform:translate(-1000px)">${far}</g>`],
    ["pattern", `<pattern id="p" width="10" height="10">${far}</pattern>`],
    ["marker", `<marker id="m2">${far}</marker>`],
    ["mask element", `<mask id="m3">${far}</mask>`],
    ["clipPath", `<clipPath id="c3">${far}</clipPath>`],
    ["nested svg", `<svg x="-1000" y="0" width="2000" height="100">${far}</svg>`],
    ["symbol content", `<symbol id="s2">${far}</symbol>`],
    ["own transform", use(1000, 10, ' transform="translate(-1000 0)"')],
    ["own single-quoted transform", use(1000, 10, " transform='translate(-1000 0)'")],
    ["own id (use of use)", use(1000, 10, ' id="u"')],
    ["use of a non-symbol", '<use href="#nope" x="1000" y="10" width="24" height="24"/>'],
    ["no size", '<use href="#i" x="1000" y="10"/>'],
  ])("not culled: %s", (_n, body) => {
    expect(cullOffscreenSymbolUses(doc(body))).toBeUndefined();
  });

  test("not culled: aspect-changing root, stylesheet transforms, non-round-tripping input", () => {
    expect(cullOffscreenSymbolUses(doc(far, "0 0 100 100", ' preserveAspectRatio="none"'))).toBe(
      undefined,
    );
    const wide = doc(far).replace('width="100" height="100"', 'width="300" height="100"');
    expect(cullOffscreenSymbolUses(wide)).toBeUndefined();
    const css = "<style>.a{transform:translate(-1000px)}</style>";
    expect(cullOffscreenSymbolUses(doc(far, "0 0 100 100", "", css))).toBeUndefined();
    expect(cullOffscreenSymbolUses(doc(far).slice(0, -"</svg>".length) + "<")).toBeUndefined();
  });

  test("a trap poisons the renderer: later renders fail fast and name the cause", async () => {
    // an opacity group far off-canvas is not culled, so resvg traps
    const bad = doc('<g opacity="0.5"><circle cx="5000" cy="10" r="3" fill="#000"/></g>');
    const e1 = await rasterize(bad, { scale: 1, fonts: [] }).catch((e: unknown) => e as Error);
    expect(e1).toBeInstanceOf(Error);
    expect((e1 as Error).message).toMatch(/^resvg render failed \(renderer panic\): /);
    expect(((e1 as Error).cause as Error).name).toBe("RuntimeError");
    const e2 = await rasterize(doc(near), { scale: 1, fonts: [] }).catch(
      (e: unknown) => e as Error,
    );
    expect((e2 as Error).message).toMatch(/unusable after an earlier panic/);
    expect(((e2 as Error).cause as Error).message).toMatch(/renderer panic/);
  });
});
