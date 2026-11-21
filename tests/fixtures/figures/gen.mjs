// Synthetic trap figures for the figure pipeline (ingestion §6, §12; tracks C-4).
//
// Draws line-art figures in memory: busy boards with footprints, sockets and traces, and parts in
// an exploded and an assembled state with a known offset, plus arrows, leaders and callout text.
// Kinds: an oblique heat sink (enclosed fin strips, an outer fin block the seeds miss, a clip lever
// in its group), twin boxes, a tag, a fan seated in a static cage, a screw in a static bracket, and
// a dense heat sink with 32 comb fins and 1-2 px gaps. Every part is drawn from its own layer, so
// the generator also returns ground truth: each part's full and visible silhouette per state and
// its clean sprite.
//
// Options: `scale` (integer geometry scale, default 1), `stroke` (outline brush in px, default 2),
// `aa` (draw at twice the size and box-downsample: anti-aliased edges), `pad` (blank margin).
// Everything is deterministic (integer geometry, no randomness).
// `node tests/fixtures/figures/gen.mjs <dir>` writes every preset as PNGs plus manifest.json, for
// skill-driven end-to-end runs (D-3a). No third-party content.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const INK = [0, 0, 0, 255];
const PAPER = [255, 255, 255, 255];
const DARK = [70, 70, 70, 255];

/** Current geometry scale and outline stroke (set per figure() call; single-threaded). */
let S = 1;
let T = 2;

function canvas(width, height, fill = PAPER) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}

function setPx(c, x, y, col) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  c.data.set(col, (y * c.width + x) * 4);
}

/** Square brush of `t` px with its top-left at (x, y). */
function brush(c, x, y, t, col) {
  for (let dy = 0; dy < t; dy++) for (let dx = 0; dx < t; dx++) setPx(c, x + dx, y + dy, col);
}

/** Bresenham line between integer pixel points, stamped with a `t` px square brush. */
function line(c, x0, y0, x1, y1, t, col = INK) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    brush(c, x, y, t, col);
    if (x === x1 && y === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) {
      e += dy;
      x += sx;
    }
    if (e2 <= dx) {
      e += dx;
      y += sy;
    }
  }
}

function polyline(c, pts, t, col = INK, closed = false) {
  for (let i = 0; i + 1 < pts.length; i++) line(c, ...pts[i], ...pts[i + 1], t, col);
  if (closed) line(c, ...pts[pts.length - 1], ...pts[0], t, col);
}

/** Even-odd scanline fill, pixel centres. */
function fillPoly(c, pts, col) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(c.height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
        xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) {
        setPx(c, x, y, col);
      }
    }
  }
}

/** Local geometry (base units) to pixels: scaled, then offset by (ox, oy) pixels. */
const at = (pts, ox, oy) => pts.map(([x, y]) => [Math.round(x * S) + ox, Math.round(y * S) + oy]);
const pt = (x, y, ox, oy) => [Math.round(x * S) + ox, Math.round(y * S) + oy];
/** A local line, scaled, with the outline stroke (or `t`). */
function sline(c, a, b, ox, oy, t = T) {
  line(c, ...pt(a[0], a[1], ox, oy), ...pt(b[0], b[1], ox, oy), t);
}

// ---------------------------------------------------------------- part kinds (local base units)

/** Oblique heat sink: top fins (enclosed strips), an outer fin block, a clip. */
const HS = {
  hex: [
    [12, 14],
    [32, 2],
    [84, 2],
    [84, 50],
    [64, 62],
    [12, 62],
  ],
  fins: [
    [0, 26],
    [12, 26],
    [12, 58],
    [0, 58],
  ],
  clip: [
    [84, 18],
    [92, 14],
    [92, 40],
    [84, 44],
  ],
  socket: [
    [20, 22],
    [58, 22],
    [58, 56],
    [20, 56],
  ],
  pad: [
    [3, 29],
    [11, 29],
    [11, 57],
    [3, 57],
  ],
  /** Seeds: front face, right face (heat sink), clip interior (clip part). */
  seeds: {
    body: [
      [36, 40],
      [74, 32],
    ],
    clip: [[88, 30]],
  },
  /** Every face, for figures where the part never stands alone. */
  allFaces: [
    [36, 40],
    [74, 32],
    [28, 8],
    [40, 8],
    [52, 8],
    [66, 8],
    [6, 29],
    [6, 35],
    [6, 41],
    [6, 47],
    [6, 54],
  ],
  /** Point under the front face's bottom edge where motion arrows start (shaft column). */
  tail: [30, 64],
  draw(layer, ox, oy) {
    const hex = at(HS.hex, ox, oy);
    fillPoly(layer, hex, PAPER);
    fillPoly(layer, at(HS.fins, ox, oy), PAPER);
    fillPoly(layer, at(HS.clip, ox, oy), PAPER);
    polyline(layer, hex, T, INK, true);
    const [A, , C, , E] = hex;
    const G = pt(64, 14, ox, oy);
    line(layer, ...A, ...G, T);
    line(layer, ...G, ...C, T);
    line(layer, ...G, ...E, T);
    // Top fins every 12 units: the strips between them keep paper through the closing.
    for (let k = 1; k <= 3; k++) sline(layer, [12 + 12 * k, 14], [32 + 12 * k, 2], ox, oy);
    polyline(layer, at(HS.fins, ox, oy), T, INK, true);
    for (const fy of [32, 38, 44, 50]) sline(layer, [0, fy], [12, fy], ox, oy);
    polyline(layer, at(HS.clip, ox, oy), T, INK, true);
  },
  footprint: ["hex", "fins", "clip"],
};

/** Twin box: three faces, dangling fins on the front face. */
const TW = {
  hex: [
    [0, 10],
    [16, 0],
    [56, 0],
    [56, 34],
    [40, 44],
    [0, 44],
  ],
  socket: [
    [8, 18],
    [34, 18],
    [34, 38],
    [8, 38],
  ],
  seeds: {
    body: [
      [28, 5],
      [24, 30],
      [50, 12],
      [14, 30],
      [48, 30],
    ],
  },
  draw(layer, ox, oy) {
    const hex = at(TW.hex, ox, oy);
    fillPoly(layer, hex, PAPER);
    polyline(layer, hex, T, INK, true);
    const [A, , C, , E] = hex;
    const G = pt(40, 10, ox, oy);
    line(layer, ...A, ...G, T);
    line(layer, ...G, ...C, T);
    line(layer, ...G, ...E, T);
    for (const fx of [10, 20, 30]) sline(layer, [fx, 44], [fx, 30], ox, oy);
  },
  footprint: ["hex"],
};

/** A tag: pentagon with an inner bar (texture for the matcher). */
const TAG = {
  hex: [
    [0, 0],
    [30, 0],
    [38, 18],
    [30, 36],
    [0, 36],
  ],
  seeds: { body: [[14, 9]] },
  draw(layer, ox, oy) {
    const hex = at(TAG.hex, ox, oy);
    fillPoly(layer, hex, PAPER);
    polyline(layer, hex, T, INK, true);
    sline(layer, [6, 18], [24, 18], ox, oy);
    sline(layer, [10, 26], [18, 30], ox, oy);
  },
  footprint: ["hex"],
};

/** Fan: rim, hub and four blades; seated in a static cage about 1.5x its size. */
const FAN = (() => {
  const rim = [];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * 2 * Math.PI;
    rim.push([Math.round(26 + 25 * Math.cos(a)), Math.round(26 + 25 * Math.sin(a))]);
  }
  const hub = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI;
    hub.push([Math.round(26 + 6 * Math.cos(a)), Math.round(26 + 6 * Math.sin(a))]);
  }
  return {
    hex: rim,
    hub,
    seeds: {
      body: [
        [26, 26],
        [26, 8],
        [44, 26],
        [26, 44],
        [8, 26],
      ],
    },
    draw(layer, ox, oy) {
      fillPoly(layer, at(rim, ox, oy), PAPER);
      polyline(layer, at(rim, ox, oy), T, INK, true);
      polyline(layer, at(hub, ox, oy), T, INK, true);
      for (const k of [1, 3, 5, 7]) {
        const a = (k / 8) * 2 * Math.PI;
        sline(
          layer,
          [Math.round(26 + 6 * Math.cos(a)), Math.round(26 + 6 * Math.sin(a))],
          [Math.round(26 + 24 * Math.cos(a)), Math.round(26 + 24 * Math.sin(a))],
          ox,
          oy,
        );
      }
    },
    /** The static cage, drawn on the board around the seat (local fan coordinates). */
    cage(c, ox, oy) {
      polyline(
        c,
        at(
          [
            [-13, -13],
            [65, -13],
            [65, 65],
            [-13, 65],
          ],
          ox,
          oy,
        ),
        T,
        INK,
        true,
      );
      sline(c, [26, -13], [26, 0], ox, oy);
      sline(c, [26, 65], [26, 52], ox, oy);
      sline(c, [-13, 26], [0, 26], ox, oy);
      sline(c, [65, 26], [52, 26], ox, oy);
    },
    footprint: [],
  };
})();

/** Screw: head with a slot and a threaded shank; seated in a static bracket about 3x its size. */
const SCREW = {
  hex: [
    [0, 0],
    [36, 0],
    [36, 14],
    [24, 14],
    [24, 52],
    [12, 52],
    [12, 14],
    [0, 14],
  ],
  seeds: {
    body: [
      [6, 9],
      [18, 28],
    ],
  },
  /** Every face (head and the four shaft faces between the threads), for one-drawing figures. */
  allFaces: [
    [6, 9],
    [18, 18],
    [18, 28],
    [18, 38],
    [18, 48],
  ],
  draw(layer, ox, oy) {
    const hex = at(SCREW.hex, ox, oy);
    fillPoly(layer, hex, PAPER);
    polyline(layer, hex, T, INK, true);
    sline(layer, [10, 6], [26, 6], ox, oy);
    for (const y of [24, 34, 44]) sline(layer, [12, y], [24, y - 4], ox, oy);
  },
  bracket(c, ox, oy) {
    polyline(
      c,
      at(
        [
          [-16, 20],
          [52, 20],
          [52, 56],
          [-16, 56],
        ],
        ox,
        oy,
      ),
      T,
      INK,
      true,
    );
    sline(c, [-12, 38], [8, 38], ox, oy);
    sline(c, [28, 38], [48, 38], ox, oy);
  },
  footprint: [],
};

/** Dense heat sink: a base plate with 32 comb fins of 1 px, gaps of 1 and 2 px (stroke 2 only). */
const DENSE = {
  hex: [
    [0, 26],
    [82, 26],
    [82, 40],
    [0, 40],
  ],
  seeds: { body: [[41, 33]] },
  fins: Array.from({ length: 32 }, (_, k) => 2 + Math.floor(2.5 * k)),
  draw(layer, ox, oy) {
    const plate = at(DENSE.hex, ox, oy);
    fillPoly(layer, plate, PAPER);
    polyline(layer, plate, T, INK, true);
    for (const x of DENSE.fins) sline(layer, [x, 4], [x, 26], ox, oy, 1);
    sline(layer, [10, 33], [72, 33], ox, oy, 1);
  },
  footprint: [],
};

const KINDS = { hs: HS, tw: TW, tag: TAG, fan: FAN, screw: SCREW, dense: DENSE };

// ---------------------------------------------------------------- layers and ground truth

/**
 * A part drawn alone on a transparent layer the size of the canvas. Fill pixels that the polygon
 * rule puts outside the outline ink are dropped and unfilled pixels the ink encloses become
 * paper: on paper neither can be told apart, so a part's silhouette is its ink plus everything
 * the ink encloses (4-connected).
 */
function partLayer(width, height, draw) {
  const layer = canvas(width, height, [0, 0, 0, 0]);
  draw(layer);
  const isInk = (i) => layer.data[i * 4 + 3] !== 0 && layer.data[i * 4] < 128;
  const outside = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length > 0) {
    const p = stack.pop();
    if (outside[p] || isInk(p)) continue;
    outside[p] = 1;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) stack.push(p - 1);
    if (x < width - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - width);
    if (y < height - 1) stack.push(p + width);
  }
  for (let i = 0; i < width * height; i++) {
    if (outside[i]) layer.data.set([0, 0, 0, 0], i * 4);
    else if (layer.data[i * 4 + 3] === 0) layer.data.set(PAPER, i * 4);
  }
  return layer;
}

/** Tight mask { x, y, w, h, data } of the layer's opaque pixels (global coordinates). */
function layerMask(layer) {
  let x0 = layer.width;
  let y0 = layer.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      if (layer.data[(y * layer.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: 0, h: 0, data: new Uint8Array(0) };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data[y * w + x] = layer.data[((y + y0) * layer.width + x + x0) * 4 + 3] ? 1 : 0;
    }
  }
  return { x: x0, y: y0, w, h, data };
}

function maskHas(m, x, y) {
  const i = x - m.x;
  const j = y - m.y;
  return i >= 0 && j >= 0 && i < m.w && j < m.h && m.data[j * m.w + i] !== 0;
}

function maskMinus(a, b) {
  const data = new Uint8Array(a.data);
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) if (maskHas(b, x + a.x, y + a.y)) data[y * a.w + x] = 0;
  }
  return { ...a, data };
}

function paste(dst, layer) {
  for (let i = 0; i < dst.width * dst.height; i++) {
    if (layer.data[i * 4 + 3]) dst.data.set(layer.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
}

/** Crops a layer to its mask bbox: the clean sprite (alpha 255 inside, 0 outside). */
function spriteOf(layer, m) {
  const out = canvas(m.w, m.h, [0, 0, 0, 0]);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!m.data[y * m.w + x]) continue;
      const s = ((y + m.y) * layer.width + x + m.x) * 4;
      out.data.set(layer.data.subarray(s, s + 4), (y * m.w + x) * 4);
    }
  }
  return out;
}

// ---------------------------------------------------------------- board

function drawBoard(c, ox, oy, b) {
  const rect = (x, y, w, h) => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  polyline(c, at(rect(0, 0, b.w, b.h), ox, oy), T, INK, true);
  for (const t of b.traces) polyline(c, at(t, ox, oy), T);
  for (const r of b.rects) polyline(c, at(rect(...r), ox, oy), T, INK, true);
  for (const s of b.seats) {
    const kind = KINDS[s.kind];
    const sx = ox + Math.round(s.x * S);
    const sy = oy + Math.round(s.y * S);
    if (kind.socket) fillPoly(c, at(kind.socket, sx, sy), DARK);
    if (kind === HS) fillPoly(c, at(HS.pad, sx, sy), DARK);
    // Footprint: the part's silhouette outline (silkscreen), so a seat can be verified.
    for (const f of kind.footprint) polyline(c, at(kind[f], sx, sy), T, INK, true);
    if (kind.cage) kind.cage(c, sx, sy);
    if (kind.bracket) kind.bracket(c, sx, sy);
  }
}

// ---------------------------------------------------------------- annotations

/** Vertical motion arrow from y0 to y1 (pixels): a shaft of the outline stroke, filled wedge at y1. */
function drawArrow(c, x, y0, y1) {
  const dir = y1 > y0 ? 1 : -1;
  const base = y1 - 8 * S * dir;
  line(c, x, y0, x, base, T);
  const half = 4 * S;
  fillPoly(
    c,
    [
      [x - half, base],
      [x + T + half, base],
      [x + T / 2, y1 + dir],
    ],
    INK,
  );
}

function drawCallout(c, cx, cy) {
  const r = 8 * S;
  let px = cx + r;
  let py = cy;
  for (let k = 1; k <= 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    const nx = Math.round(cx + r * Math.cos(a));
    const ny = Math.round(cy + r * Math.sin(a));
    line(c, px, py, nx, ny, 1);
    px = nx;
    py = ny;
  }
  line(c, cx, cy - 5 * S, cx, cy + 5 * S, 1);
  line(c, cx - 2 * S, cy - 3 * S, cx, cy - 5 * S, 1);
}

function drawHsText(c, x, y) {
  const L = (a, b, d, e) => line(c, x + a * S, y + b * S, x + d * S, y + e * S, 1);
  L(3, 3, 3, 13);
  L(9, 3, 9, 13);
  L(3, 8, 9, 8);
  L(21, 3, 15, 3);
  L(15, 3, 15, 8);
  L(15, 8, 21, 8);
  L(21, 8, 21, 13);
  L(21, 13, 15, 13);
}

// ---------------------------------------------------------------- figures

const seg = (a, b, c, d) => [
  [a, b],
  [c, d],
];

const MAIN_BOARD = {
  w: 340,
  h: 170,
  traces: [
    seg(10, 20, 330, 20),
    seg(10, 130, 330, 130),
    seg(10, 150, 200, 150),
    seg(20, 10, 20, 160),
    seg(160, 10, 160, 160),
    seg(310, 10, 310, 160),
    seg(160, 60, 300, 60),
    seg(120, 110, 120, 160),
    seg(104, 112, 150, 112),
    seg(10, 46, 80, 46),
  ],
  rects: [
    [250, 136, 20, 10],
    [60, 140, 14, 8],
  ],
};

const SMALL_BOARD = {
  w: 300,
  h: 150,
  traces: [
    seg(10, 20, 290, 20),
    seg(10, 120, 290, 120),
    seg(130, 10, 130, 140),
    seg(20, 30, 20, 140),
    seg(100, 60, 240, 60),
  ],
  rects: [[230, 100, 20, 10]],
};

/** The small board plus a component touching the first twin's seat on its left. */
const TWIN_BOARD = { ...SMALL_BOARD, rects: [...SMALL_BOARD.rects, [26, 52, 14, 14]] };

/** A board with nothing near the seat (a static cage or bracket there touches only its part). */
const QUIET_BOARD = {
  w: 300,
  h: 150,
  traces: [seg(10, 10, 290, 10), seg(10, 140, 290, 140), seg(250, 30, 250, 130)],
  rects: [[230, 100, 20, 10]],
};

/** A board whose traces pass behind the dense comb's seat (seen through its gaps when seated). */
const DENSE_BOARD = {
  w: 300,
  h: 150,
  traces: [
    seg(10, 20, 290, 20),
    seg(10, 50, 290, 50),
    seg(10, 58, 200, 58),
    seg(250, 30, 250, 140),
  ],
  rects: [[230, 100, 20, 10]],
};

/** A board with nothing behind the comb (single-state assembled: nothing there to recover). */
const DENSE_PLAIN_BOARD = {
  w: 300,
  h: 150,
  traces: [seg(10, 20, 290, 20), seg(10, 82, 290, 82), seg(250, 30, 250, 140)],
  rects: [[230, 100, 20, 10]],
};

const HS_UNITS = [
  { id: "hs-1", kind: "hs", clip: "clip-1", seat: [40, 40], exploded: [40, -120], cls: "heatsink" },
  {
    id: "hs-2",
    kind: "hs",
    clip: "clip-2",
    seat: [190, 52],
    exploded: [190, -108],
    cls: "heatsink",
  },
];
const TW_UNITS = [
  { id: "tw-1", kind: "tw", seat: [40, 40], exploded: [40, -120], cls: "twin" },
  { id: "tw-2", kind: "tw", seat: [150, 50], exploded: [70, -100], cls: "twin" },
];

/**
 * Presets. `ann` selects which of the heat-sink annotations are drawn and declared.
 * `layout` is "hs" (380x400 / 380x220) or "small" (340x320 / 340x200).
 */
const PRESETS = {
  main: {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["exploded", "assembled"],
    ann: ["arrows", "press", "label", "labelLeader", "callout", "calloutLeader"],
  },
  arrows: {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["exploded", "assembled"],
    ann: ["arrows", "press"],
  },
  leaders: {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["exploded", "assembled"],
    ann: ["label", "labelLeader"],
  },
  "callout-text": {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["exploded", "assembled"],
    ann: ["label", "callout"],
  },
  "busy-callout": {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["exploded", "assembled"],
    ann: ["callout", "calloutLeader"],
  },
  "exploded-only": {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["exploded"],
    ann: ["arrows", "label", "labelLeader"],
    // One drawing: a part stands alone only where a polygon (or a declared prior) bounds it.
    polygon: true,
  },
  "assembled-only": {
    units: HS_UNITS,
    board: MAIN_BOARD,
    layout: "hs",
    states: ["assembled"],
    ann: ["press", "callout", "calloutLeader"],
    allFaces: true,
  },
  twins: {
    units: TW_UNITS,
    board: TWIN_BOARD,
    layout: "small",
    states: ["exploded", "assembled"],
    ann: [],
  },
  /** A box occluded on its right by a tag in the exploded drawing and on its left when seated. */
  occluded: {
    units: [
      { id: "tw-1", kind: "tw", seat: [40, 40], exploded: [40, -120] },
      { id: "tag-1", kind: "tag", seat: [14, 52], exploded: [84, -114] },
    ],
    board: SMALL_BOARD,
    layout: "small",
    states: ["exploded", "assembled"],
    ann: [],
  },
  /** A fan seated in a static cage 1.5x its size (the cage must not be swallowed). */
  cage: {
    units: [{ id: "fan-1", kind: "fan", seat: [60, 40], exploded: [60, -120], prior: "cylinder" }],
    board: QUIET_BOARD,
    layout: "small",
    states: ["exploded", "assembled"],
    ann: [],
  },
  /** The cage figure with the assembled drawing only: nothing tells the cage is static. */
  "cage-assembled": {
    units: [{ id: "fan-1", kind: "fan", seat: [60, 40], exploded: [60, -120], prior: "cylinder" }],
    board: QUIET_BOARD,
    layout: "small",
    states: ["assembled"],
    ann: [],
  },
  /** The screw figure with the assembled drawing only (every face seeded: nothing else tells). */
  "screw-assembled": {
    units: [{ id: "screw-1", kind: "screw", seat: [70, 40], exploded: [70, -100], prior: "none" }],
    board: QUIET_BOARD,
    layout: "small",
    states: ["assembled"],
    ann: [],
    allFaces: true,
  },
  /** A screw seated in a static bracket about 3x its size. */
  screw: {
    units: [{ id: "screw-1", kind: "screw", seat: [70, 40], exploded: [70, -100], prior: "none" }],
    board: QUIET_BOARD,
    layout: "small",
    states: ["exploded", "assembled"],
    ann: [],
  },
  /** 32 comb fins with 1-2 px gaps; board traces seen through the gaps when seated. */
  dense: {
    units: [{ id: "sink-1", kind: "dense", seat: [40, 40], exploded: [40, -120] }],
    board: DENSE_BOARD,
    layout: "small",
    states: ["exploded", "assembled"],
    ann: [],
    stroke2: true,
  },
  "dense-exploded": {
    units: [{ id: "sink-1", kind: "dense", seat: [40, 40], exploded: [40, -120] }],
    board: DENSE_BOARD,
    layout: "small",
    states: ["exploded"],
    ann: [],
    stroke2: true,
    polygon: true,
  },
  "dense-assembled": {
    units: [{ id: "sink-1", kind: "dense", seat: [40, 40], exploded: [40, -120], polygon: true }],
    board: DENSE_PLAIN_BOARD,
    layout: "small",
    states: ["assembled"],
    ann: [],
    stroke2: true,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);
/** Presets drawn at stroke 2 only (1 px comb fins). */
export const STROKE2_ONLY = PRESET_NAMES.filter((n) => PRESETS[n].stroke2);

/**
 * Builds one preset. Returns { name, states: { [state]: { image, truth, board } }, manifest,
 * sprites, annotations, offset, base, units, scale, stroke }. `board` is the drawing without
 * parts and annotations (the ideal clean base). `truth.units[id] = { full, visible, pos }` (masks
 * in that state's image coordinates; with `aa`, a pixel belongs to a mask when at least half of
 * it is covered).
 */
export function figure(name, options = {}) {
  if (!PRESETS[name]) throw new Error(`unknown preset ${name}`);
  if (options.aa)
    return downsample(
      build(name, {
        ...options,
        aa: false,
        scale: 2 * (options.scale ?? 1),
        stroke: 2 * (options.stroke ?? 2),
        pad: 2 * (options.pad ?? 0),
      }),
      name,
      options,
    );
  return build(name, options);
}

function build(name, options) {
  const preset = PRESETS[name];
  S = options.scale ?? 1;
  T = options.stroke ?? 2;
  const pad = options.pad ?? 0;
  const P = (v) => Math.round(v * S);
  const board = preset.board;
  const units = preset.units;
  const hs = preset.layout === "hs";
  const origin = hs
    ? { exploded: [P(20) + pad, P(220) + pad], assembled: [P(16) + pad, P(40) + pad] }
    : { exploded: [P(20) + pad, P(160) + pad], assembled: [P(16) + pad, P(40) + pad] };
  const size = hs
    ? {
        exploded: [P(380) + 2 * pad, P(400) + 2 * pad],
        assembled: [P(380) + 2 * pad, P(220) + 2 * pad],
      }
    : {
        exploded: [P(340) + 2 * pad, P(320) + 2 * pad],
        assembled: [P(340) + 2 * pad, P(200) + 2 * pad],
      };
  const ann = new Set(preset.ann);
  const seats = units.map((u) => ({ x: u.seat[0], y: u.seat[1], kind: u.kind }));
  const unitPos = (u, state) => {
    const [bx, by] = origin[state];
    const p = state === "assembled" ? u.seat : u.exploded;
    return [bx + P(p[0]), by + P(p[1])];
  };

  const states = {};
  const sprites = {};
  const annotations = [];
  for (const state of preset.states) {
    const [W, H] = size[state];
    const img = canvas(W, H);
    drawBoard(img, origin[state][0], origin[state][1], { ...board, seats });
    const cleanBoard = { width: W, height: H, data: new Uint8Array(img.data) };
    const truth = { units: {} };
    const layers = [];
    // Draw order: by seat bottom edge (every preset agrees with its drawing).
    const order = units
      .map((u, i) => ({ u, i }))
      .sort((a, b) => a.u.seat[1] + bottom(a.u) - (b.u.seat[1] + bottom(b.u)) || a.i - b.i);
    for (const { u } of order) {
      const [px, py] = unitPos(u, state);
      const layer = partLayer(W, H, (l) => KINDS[u.kind].draw(l, px, py));
      const full = layerMask(layer);
      layers.push({ u, layer, full, pos: [px, py] });
      if (!sprites[u.id]) sprites[u.id] = { raster: spriteOf(layer, full) };
    }
    for (let k = 0; k < layers.length; k++) {
      const { u, full, pos } = layers[k];
      let visible = full;
      for (let j = k + 1; j < layers.length; j++) visible = maskMinus(visible, layers[j].full);
      truth.units[u.id] = { full, visible, pos };
    }
    for (const { layer } of layers) paste(img, layer);

    // Annotations (heat-sink presets), drawn on top.
    const hsUnits = units.filter((u) => u.kind === "hs");
    if (state === "exploded" && ann.has("arrows")) {
      for (const u of hsUnits) {
        const [px, py] = unitPos(u, state);
        const x = px + P(HS.tail[0]);
        const y0 = py + P(62) + T;
        const y1 = origin.exploded[1] - P(14);
        drawArrow(img, x, y0, y1);
        annotations.push({
          kind: "arrow",
          state,
          polyline: [
            [x, y0],
            [x, y1],
          ],
          for: u.id,
        });
      }
    }
    if (state === "exploded" && (ann.has("label") || ann.has("labelLeader"))) {
      const [px, py] = unitPos(hsUnits[1], state);
      const rect = [px + P(106), py + P(16), P(26), P(16)];
      if (ann.has("label")) {
        drawHsText(img, rect[0], rect[1]);
        annotations.push({ kind: "text", state, rect });
      }
      if (ann.has("labelLeader")) {
        const pts = [
          [rect[0] - P(2), py + P(24)],
          [px + P(92) + T, py + P(24)],
        ];
        polyline(img, pts, 1);
        annotations.push({ kind: "leader", state, polyline: pts, for: hsUnits[1].id });
      }
    }
    if (state === "assembled" && ann.has("press")) {
      const [px, py] = unitPos(hsUnits[1], state);
      const x = px + P(56);
      drawArrow(img, x, py - P(28), py + P(2) - 1);
      annotations.push({
        kind: "arrow",
        state,
        polyline: [
          [x, py - P(28)],
          [x, py + P(2) - 1],
        ],
        for: hsUnits[1].id,
      });
    }
    if (state === "assembled" && (ann.has("callout") || ann.has("calloutLeader"))) {
      const [bx, by] = origin.assembled;
      const cx = bx + P(140);
      const cy = by + P(140);
      if (ann.has("callout")) {
        drawCallout(img, cx, cy);
        annotations.push({ kind: "text", state, rect: [cx - P(10), cy - P(10), P(21), P(21)] });
      }
      if (ann.has("calloutLeader")) {
        const [px, py] = unitPos(hsUnits[0], state);
        const pts = [
          [cx - P(6), cy - P(6)],
          [px + P(56), py + P(62) + T],
        ];
        polyline(img, pts, 1);
        annotations.push({ kind: "leader", state, polyline: pts, for: hsUnits[0].id });
      }
    }
    states[state] = { image: img, truth, board: cleanBoard };
  }

  // Manifest: seeds in every drawn state, only where the part is visible there (the heat sink:
  // front + right face, so the top strips and the outer fin block are missed by the seeds; the
  // clip is its own grouped part).
  const parts = [];
  for (const u of units) {
    const kind = KINDS[u.kind];
    const seedsFor = (local) => {
      const out = {};
      for (const state of preset.states) {
        const [px, py] = unitPos(u, state);
        const vis = states[state].truth.units[u.id].visible;
        const pts = local
          .map(([x, y]) => [px + P(x), py + P(y)])
          .filter(([x, y]) => maskHas(vis, x, y));
        if (pts.length) out[state] = pts;
      }
      return out;
    };
    const body = preset.allFaces && kind.allFaces ? kind.allFaces : kind.seeds.body;
    const part = {
      id: u.id,
      group: u.id,
      ...(u.cls ? { instanceOf: u.cls } : {}),
      seeds: seedsFor(body),
      prior: u.prior ?? "box",
    };
    if (u.polygon || preset.polygon) {
      const poly = {};
      for (const state of preset.states) {
        const t = states[state].truth.units[u.id].full;
        poly[state] = [
          [t.x - 2, t.y - 2],
          [t.x + t.w + 1, t.y - 2],
          [t.x + t.w + 1, t.y + t.h + 1],
          [t.x - 2, t.y + t.h + 1],
        ];
      }
      part.polygon = poly;
    }
    parts.push(part);
    if (u.clip)
      parts.push({
        id: u.clip,
        group: u.id,
        seeds: seedsFor(HS.seeds.clip),
        prior: "none",
        ...(part.polygon ? { polygon: part.polygon } : {}),
      });
  }
  const sources = {};
  for (const state of preset.states) sources[state] = `${state}.png`;
  const manifest = {
    sources,
    background: "auto",
    parts,
    ...(annotations.length
      ? {
          annotations: annotations.map((a) =>
            a.kind === "text"
              ? { kind: a.kind, state: a.state, rect: a.rect }
              : { kind: a.kind, state: a.state, polyline: a.polyline },
          ),
        }
      : {}),
    ...(preset.states.length === 2 ? { base: "assembled", erase: "recover" } : {}),
  };
  const offset =
    preset.states.length === 2
      ? [origin.exploded[0] - origin.assembled[0], origin.exploded[1] - origin.assembled[1]]
      : [0, 0];
  return {
    name,
    states,
    manifest,
    sprites,
    annotations,
    /** Alignment: a base-frame (assembled) point (x, y) is at (x + dx, y + dy) in the exploded drawing. */
    offset,
    base: preset.states.length === 2 ? "assembled" : preset.states[0],
    units: units.map((u) => u.id),
    scale: S,
    stroke: T,
  };
}

/** Bottom edge of a kind's outline (base units), for the draw order. */
function bottom(u) {
  return Math.max(...KINDS[u.kind].hex.map((p) => p[1]));
}

// ---------------------------------------------------------------- anti-aliasing (2x2 box filter)

function downRaster(r) {
  const w = Math.floor(r.width / 2);
  const h = Math.floor(r.height / 2);
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      const sum = [0, 0, 0];
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const s = ((2 * y + dy) * r.width + 2 * x + dx) * 4;
        const al = r.data[s + 3];
        a += al;
        for (let c = 0; c < 3; c++) sum[c] += r.data[s + c] * al;
      }
      const o = (y * w + x) * 4;
      if (a > 0) for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(sum[c] / a);
      out.data[o + 3] = Math.round(a / 4);
    }
  }
  return out;
}

function downMask(m) {
  const x0 = Math.floor(m.x / 2);
  const y0 = Math.floor(m.y / 2);
  const x1 = Math.floor((m.x + m.w - 1) / 2);
  const y1 = Math.floor((m.y + m.h - 1) / 2);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let n = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        if (maskHas(m, 2 * x + dx, 2 * y + dy)) n++;
      if (n >= 2) data[(y - y0) * w + x - x0] = 1;
    }
  }
  return { x: x0, y: y0, w, h, data };
}

function downsample(f, name, options) {
  const half = ([x, y]) => [Math.floor(x / 2), Math.floor(y / 2)];
  const states = {};
  for (const [s, st] of Object.entries(f.states)) {
    const units = {};
    for (const [id, t] of Object.entries(st.truth.units)) {
      units[id] = { full: downMask(t.full), visible: downMask(t.visible), pos: half(t.pos) };
    }
    states[s] = { image: downRaster(st.image), board: downRaster(st.board), truth: { units } };
  }
  const sprites = {};
  for (const [id, sp] of Object.entries(f.sprites)) sprites[id] = { raster: downRaster(sp.raster) };
  const m = f.manifest;
  const manifest = {
    ...m,
    parts: m.parts.map((p) => ({
      ...p,
      seeds: Object.fromEntries(Object.entries(p.seeds).map(([s, pts]) => [s, pts.map(half)])),
      ...(p.polygon
        ? {
            polygon: Object.fromEntries(
              Object.entries(p.polygon).map(([s, pts]) => [s, pts.map(half)]),
            ),
          }
        : {}),
    })),
    ...(m.annotations
      ? {
          annotations: m.annotations.map((a) =>
            a.rect
              ? {
                  ...a,
                  rect: [
                    Math.floor(a.rect[0] / 2),
                    Math.floor(a.rect[1] / 2),
                    Math.ceil(a.rect[2] / 2),
                    Math.ceil(a.rect[3] / 2),
                  ],
                }
              : { ...a, polyline: a.polyline.map(half) },
          ),
        }
      : {}),
  };
  return {
    ...f,
    name,
    states,
    sprites,
    manifest,
    annotations: f.annotations,
    offset: [f.offset[0] / 2, f.offset[1] / 2],
    scale: options.scale ?? 1,
    stroke: options.stroke ?? 2,
    aa: true,
  };
}

// ---------------------------------------------------------------- PNG writer (CLI only)

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function png(r) {
  const raw = Buffer.alloc((r.width * 4 + 1) * r.height);
  for (let y = 0; y < r.height; y++) {
    raw[y * (r.width * 4 + 1)] = 0;
    Buffer.from(r.data.buffer, r.data.byteOffset + y * r.width * 4, r.width * 4).copy(
      raw,
      y * (r.width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain && process.argv[2]) {
  const dir = process.argv[2];
  for (const name of PRESET_NAMES) {
    const f = figure(name);
    const out = join(dir, name);
    mkdirSync(out, { recursive: true });
    for (const [state, s] of Object.entries(f.states))
      writeFileSync(join(out, `${state}.png`), png(s.image));
    writeFileSync(join(out, "manifest.json"), JSON.stringify(f.manifest, null, 2) + "\n");
    console.log(`${name}: ${Object.keys(f.states).join(", ")}`);
  }
}
