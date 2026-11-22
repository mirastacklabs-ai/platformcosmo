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

/**
 * resvg-wasm panics are `unreachable` traps without unwinding: the wasm shadow stack and the
 * Resvg object stay leaked, and enough of them break every later render of the instance. After
 * the first trap the renderer is therefore refused for good, with the original panic attached.
 */
let poisoned: Error | undefined;

function renderPng(
  svg: string,
  scale: number,
  fonts: Parameters<RasterizeFn>[1]["fonts"],
): Uint8Array {
  if (poisoned) {
    throw new Error(
      "resvg renderer is unusable after an earlier panic in this process; restart it to rasterize again",
      { cause: poisoned },
    );
  }
  const family = fonts[0]?.family;
  let resvg: InstanceType<typeof Resvg> | undefined;
  try {
    resvg = new Resvg(svg, {
      fitTo: { mode: "zoom", value: scale },
      font: {
        fontBuffers: fonts.map((f) => f.sfnt),
        loadSystemFonts: false,
        ...(family
          ? { defaultFontFamily: family, sansSerifFamily: family, serifFamily: family }
          : {}),
      },
    });
    const image = resvg.render();
    let png: Uint8Array;
    try {
      png = image.asPng();
    } finally {
      try {
        image.free();
      } catch {
        /* a failed render must report its own error, not free's */
      }
    }
    resvg.free();
    return png;
  } catch (e) {
    if (resvg) {
      try {
        resvg.free();
      } catch {
        /* after a panic the object is still borrowed and free throws "recursive use" */
      }
    }
    if (e instanceof Error && e.name === "RuntimeError") {
      poisoned = new Error(`resvg render failed (renderer panic): ${e.message}`, { cause: e });
      throw poisoned;
    }
    throw e;
  }
}

const attrRe = (name: string): RegExp => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
const attr = (tag: string, name: string): string | undefined => {
  const m = attrRe(name).exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
};
const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const num = (v: string | undefined): number | undefined =>
  v !== undefined && NUM.test(v.trim()) ? Number(v) : undefined;
/** Attributes that move, clip, mask or filter an element (or restyle it); any quoting. */
const GEOMETRY_ATTRS = /\s(?:transform|filter|mask|clip-path|style|clip|overflow)\s*=/;
/** Elements whose children are not drawn in plain viewBox coordinates. */
const OPAQUE_PARENTS = new Set([
  "symbol",
  "pattern",
  "marker",
  "mask",
  "clipPath",
  "defs",
  "svg",
  "foreignObject",
]);
const MARGIN = 1; // user units a use must clear the viewBox by

/**
 * resvg-wasm 2.6.2 traps when a layer (a clipped symbol `<use>`, opacity, mask, filter) lies far
 * outside the canvas, which is what a zoomed camera does to the icons of every node it leaves
 * out. Returns the SVG without the symbol `<use>` elements that are clearly outside the root
 * viewBox (invisible, so removing them changes no pixel), or undefined when nothing is removed.
 * Conservative: anything it cannot place in plain viewBox coordinates is kept (see OPAQUE_PARENTS,
 * GEOMETRY_ATTRS, an aspect-changing root, a stylesheet that mentions geometry properties, or a
 * document that does not tokenise back to itself).
 */
export function cullOffscreenSymbolUses(svg: string): string | undefined {
  if (!svg.includes("<symbol")) return undefined;
  const tokens = svg.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>|[^<]+/g);
  if (!tokens || tokens.join("") !== svg) return undefined;
  const root = tokens.find((t) => /^<svg[\s>]/.test(t));
  if (!root) return undefined;
  const vb = attr(root, "viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0)
    return undefined;
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  // the visible area is the viewBox only when the canvas has its aspect ratio (to within the
  // rounding of emitted numbers, far under MARGIN)
  const cw = num(attr(root, "width"));
  const ch = num(attr(root, "height"));
  if (
    GEOMETRY_ATTRS.test(root) ||
    attr(root, "preserveAspectRatio") !== undefined ||
    (cw !== undefined && ch !== undefined && Math.abs(cw / ch - vw / vh) > 5e-4 * (vw / vh)) ||
    (cw === undefined) !== (ch === undefined)
  )
    return undefined;
  const symbols = new Set<string>();
  let inStyle = false;
  for (const t of tokens) {
    if (t.startsWith("<symbol")) {
      const id = attr(t, "id");
      if (id) symbols.add(id);
    } else if (t.startsWith("<style")) {
      inStyle = true;
    } else if (t.startsWith("</style")) {
      inStyle = false;
    } else if (inStyle && /transform|filter|clip|mask|overflow|display|visibility/.test(t)) {
      return undefined;
    }
  }
  if (symbols.size === 0) return undefined;
  const stack: boolean[] = []; // per open element: not drawn in plain viewBox coordinates
  let blocked = 0;
  let removed = 0;
  const out: string[] = [];
  for (const t of tokens) {
    if (!t.startsWith("<") || t.startsWith("<!") || t.startsWith("<?")) {
      out.push(t);
    } else if (t.startsWith("</")) {
      if (stack.pop()) blocked--;
      out.push(t);
    } else {
      const name = /^<([^\s/>]+)/.exec(t)?.[1] ?? "";
      const selfClosing = t.endsWith("/>");
      if (name === "use" && selfClosing && blocked === 0 && !GEOMETRY_ATTRS.test(t)) {
        const ref = (attr(t, "href") ?? attr(t, "xlink:href"))?.replace(/^#/, "");
        const [x, y, w, h] = ["x", "y", "width", "height"].map((n) => num(attr(t, n)));
        if (
          ref !== undefined &&
          symbols.has(ref) &&
          attr(t, "id") === undefined &&
          x !== undefined &&
          y !== undefined &&
          w !== undefined &&
          h !== undefined &&
          w >= 0 &&
          h >= 0 &&
          (x + w < vx - MARGIN ||
            x > vx + vw + MARGIN ||
            y + h < vy - MARGIN ||
            y > vy + vh + MARGIN)
        ) {
          removed++;
          continue;
        }
      }
      if (!selfClosing) {
        const b =
          (OPAQUE_PARENTS.has(name) && !(name === "svg" && stack.length === 0)) ||
          GEOMETRY_ATTRS.test(t);
        stack.push(b);
        if (b) blocked++;
      }
      out.push(t);
    }
  }
  return removed > 0 ? out.join("") : undefined;
}

export const rasterize: RasterizeFn = async (svg, { scale, fonts }) => {
  await init();
  return renderPng(cullOffscreenSymbolUses(svg) ?? svg, scale, fonts);
};
