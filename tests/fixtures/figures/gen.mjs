// Synthetic trap figures for the figure pipeline (ingestion §6, §12; tracks C-4).
//
// Draws line-art figures in memory: a busy board with footprints, sockets and traces, and
// isometric heat sinks (enclosed fin strips, an outer fin block the seeds miss, a clip lever in
// the same group) in an exploded and an assembled state with a known offset, plus arrows,
// leaders and callout text. Every part is drawn from its own layer, so the generator also
// returns ground truth: each part's full and visible silhouette per state and its clean sprite.
//
// Everything is deterministic (integer geometry, aliased 2 px strokes, no randomness).
// `node tests/fixtures/figures/gen.mjs <dir>` writes every preset as PNGs plus manifest.json and
// truth.json, for skill-driven end-to-end runs (D-3a). No third-party content.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const INK = [0, 0, 0, 255];
const PAPER = [255, 255, 255, 255];
const DARK = [70, 70, 70, 255];

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

/** Bresenham line between integer points, stamped with a `t` px square brush. */
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

const shift = (pts, ox, oy) => pts.map(([x, y]) => [x + ox, y + oy]);

// ---------------------------------------------------------------- part kinds (local coords)

/** Main heat sink: isometric box with top fins (enclosed strips), an outer fin block, a clip. */
const HS = {
  w: 95,
  h: 66,
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
  /**
   * Every face: the four top strips and the five fin-block strips too. Needed where the part never
   * stands alone (single-state assembled figure), because there its whole ink cannot be used.
   */
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
  /** Point on the fin block's bottom edge where motion arrows start (shaft column x, first row y). */
  tail: [5, 60],
};

function drawHs(layer, ox, oy, { clip = true, outerFins = true } = {}) {
  const hex = shift(HS.hex, ox, oy);
  fillPoly(layer, hex, PAPER);
  if (outerFins) fillPoly(layer, shift(HS.fins, ox, oy), PAPER);
  if (clip) fillPoly(layer, shift(HS.clip, ox, oy), PAPER);
  polyline(layer, hex, 2, INK, true);
  const [A, , C, , E] = hex;
  const G = [64 + ox, 14 + oy];
  line(layer, ...A, ...G, 2);
  line(layer, ...G, ...C, 2);
  line(layer, ...G, ...E, 2);
  // Top fins every 12 px: the strips between them keep 3.5 px of paper through the closing.
  for (let k = 1; k <= 3; k++) line(layer, 12 + 12 * k + ox, 14 + oy, 32 + 12 * k + ox, 2 + oy, 2);
  if (outerFins) {
    polyline(layer, shift(HS.fins, ox, oy), 2, INK, true);
    for (const fy of [32, 38, 44, 50]) line(layer, ox, fy + oy, 12 + ox, fy + oy, 2);
  }
  if (clip) polyline(layer, shift(HS.clip, ox, oy), 2, INK, true);
}

/** Twin heat sink: plain isometric box, three faces, dangling fins on the front face. */
const TW = {
  w: 58,
  h: 46,
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
    ],
  },
};

function drawTw(layer, ox, oy) {
  const hex = shift(TW.hex, ox, oy);
  fillPoly(layer, hex, PAPER);
  polyline(layer, hex, 2, INK, true);
  const [A, , C, , E] = hex;
  const G = [40 + ox, 10 + oy];
  line(layer, ...A, ...G, 2);
  line(layer, ...G, ...C, 2);
  line(layer, ...G, ...E, 2);
  for (const fx of [10, 20, 30]) line(layer, fx + ox, 44 + oy, fx + ox, 30 + oy, 2);
}

// ---------------------------------------------------------------- layers and ground truth

/**
 * A part drawn alone on a transparent layer the size of the canvas. Fill pixels that the polygon
 * rule puts outside the outline ink (on diagonal edges) are dropped and unfilled pixels the ink
 * encloses become paper: on paper neither can be told apart, so a part's silhouette is its ink
 * plus everything the ink encloses.
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

function maskMinus(a, b) {
  const data = new Uint8Array(a.data);
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const gx = x + a.x - b.x;
      const gy = y + a.y - b.y;
      if (gx >= 0 && gy >= 0 && gx < b.w && gy < b.h && b.data[gy * b.w + gx])
        data[y * a.w + x] = 0;
    }
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
  polyline(
    c,
    shift(
      [
        [0, 0],
        [b.w, 0],
        [b.w, b.h],
        [0, b.h],
      ],
      ox,
      oy,
    ),
    2,
    INK,
    true,
  );
  for (const t of b.traces) polyline(c, shift(t, ox, oy), 2);
  for (const r of b.rects) {
    const [x, y, w, h] = r;
    polyline(
      c,
      shift(
        [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ],
        ox,
        oy,
      ),
      2,
      INK,
      true,
    );
  }
  for (const s of b.seats) {
    const kind = s.kind === "tw" ? TW : HS;
    const sx = ox + s.x;
    const sy = oy + s.y;
    fillPoly(c, shift(kind.socket, sx, sy), DARK);
    if (kind === HS) fillPoly(c, shift(HS.pad, sx, sy), DARK);
    // Footprint: the part's silhouette outline (silkscreen), so a seat can be verified.
    polyline(c, shift(kind.hex, sx, sy), 2, INK, true);
    if (kind === HS) {
      polyline(c, shift(HS.fins, sx, sy), 2, INK, true);
      polyline(c, shift(HS.clip, sx, sy), 2, INK, true);
    }
  }
}

// ---------------------------------------------------------------- annotations

/** Vertical motion arrow: 2 px shaft at columns x, x+1 from y0 to y1, filled wedge at y1. */
function drawArrow(c, x, y0, y1) {
  const dir = y1 > y0 ? 1 : -1;
  const base = y1 - 8 * dir;
  line(c, x, y0, x, base, 2);
  fillPoly(
    c,
    [
      [x - 4, base],
      [x + 6, base],
      [x + 1, y1 + dir],
    ],
    INK,
  );
}

function drawCallout(c, cx, cy) {
  const r = 8;
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
  line(c, cx, cy - 5, cx, cy + 5, 1);
  line(c, cx - 2, cy - 3, cx, cy - 5, 1);
}

function drawHsText(c, x, y) {
  line(c, x + 3, y + 3, x + 3, y + 13, 1);
  line(c, x + 9, y + 3, x + 9, y + 13, 1);
  line(c, x + 3, y + 8, x + 9, y + 8, 1);
  polyline(
    c,
    [
      [x + 21, y + 3],
      [x + 15, y + 3],
      [x + 15, y + 8],
      [x + 21, y + 8],
      [x + 21, y + 13],
      [x + 15, y + 13],
    ],
    1,
  );
}

// ---------------------------------------------------------------- figures

const MAIN_BOARD = {
  w: 340,
  h: 170,
  traces: [
    [
      [10, 20],
      [330, 20],
    ],
    [
      [10, 130],
      [330, 130],
    ],
    [
      [10, 150],
      [200, 150],
    ],
    [
      [20, 10],
      [20, 160],
    ],
    [
      [160, 10],
      [160, 160],
    ],
    [
      [310, 10],
      [310, 160],
    ],
    [
      [160, 60],
      [300, 60],
    ],
    [
      [120, 110],
      [120, 160],
    ],
    [
      [104, 112],
      [150, 112],
    ],
    [
      [10, 46],
      [80, 46],
    ],
  ],
  rects: [
    [250, 136, 20, 10],
    [60, 140, 14, 8],
  ],
};

const TWIN_BOARD = {
  w: 300,
  h: 150,
  traces: [
    [
      [10, 20],
      [290, 20],
    ],
    [
      [10, 120],
      [290, 120],
    ],
    [
      [130, 10],
      [130, 140],
    ],
    [
      [20, 30],
      [20, 140],
    ],
    [
      [100, 60],
      [240, 60],
    ],
  ],
  rects: [[230, 100, 20, 10]],
};

/**
 * Presets. Every coordinate here is in the state image's pixels. `annotations` selects which of
 * the main figure's annotations are drawn and declared.
 */
const PRESETS = {
  main: {
    kind: "hs",
    states: ["exploded", "assembled"],
    ann: ["arrows", "press", "label", "labelLeader", "callout", "calloutLeader"],
  },
  arrows: { kind: "hs", states: ["exploded", "assembled"], ann: ["arrows", "press"] },
  leaders: { kind: "hs", states: ["exploded", "assembled"], ann: ["label", "labelLeader"] },
  "callout-text": { kind: "hs", states: ["exploded", "assembled"], ann: ["label", "callout"] },
  "busy-callout": {
    kind: "hs",
    states: ["exploded", "assembled"],
    ann: ["callout", "calloutLeader"],
  },
  "exploded-only": { kind: "hs", states: ["exploded"], ann: ["arrows", "label", "labelLeader"] },
  "assembled-only": {
    kind: "hs",
    states: ["assembled"],
    ann: ["press", "callout", "calloutLeader"],
  },
  twins: { kind: "tw", states: ["exploded", "assembled"], ann: [] },
};

export const PRESET_NAMES = Object.keys(PRESETS);

function hsUnits() {
  // Board coordinates of seats; exploded = seat + (0, -160) in board coordinates.
  return [
    { id: "hs-1", clip: "clip-1", seat: [40, 40], lift: [0, -160] },
    { id: "hs-2", clip: "clip-2", seat: [190, 52], lift: [0, -160] },
  ];
}

function twUnits() {
  return [
    { id: "tw-1", seat: [40, 40], exploded: [40, -120] },
    { id: "tw-2", seat: [150, 50], exploded: [70, -100] },
  ];
}

/**
 * Builds one preset. Options: `pad` (px of blank margin on every side, default 0).
 * Returns { name, states: { [state]: { image, truth, board } }, manifest, sprites, offset, base }.
 * `board` is the drawing without parts and annotations (the ideal clean base).
 * `truth.units[id] = { full, visible, pos }` (masks in that state's image coordinates).
 */
export function figure(name, options = {}) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown preset ${name}`);
  const pad = options.pad ?? 0;
  const isHs = preset.kind === "hs";
  const board = isHs ? MAIN_BOARD : TWIN_BOARD;
  const kind = isHs ? HS : TW;
  const units = isHs ? hsUnits() : twUnits();
  const origin = isHs
    ? { exploded: [20 + pad, 220 + pad], assembled: [16 + pad, 40 + pad] }
    : { exploded: [20 + pad, 160 + pad], assembled: [16 + pad, 40 + pad] };
  const size = isHs
    ? { exploded: [380 + 2 * pad, 400 + 2 * pad], assembled: [380 + 2 * pad, 220 + 2 * pad] }
    : { exploded: [340 + 2 * pad, 320 + 2 * pad], assembled: [340 + 2 * pad, 200 + 2 * pad] };
  const ann = new Set(preset.ann);
  const seats = units.map((u) => ({ x: u.seat[0], y: u.seat[1], kind: preset.kind }));

  const unitPos = (u, state) => {
    const [bx, by] = origin[state];
    if (state === "assembled") return [bx + u.seat[0], by + u.seat[1]];
    if (u.exploded) return [bx + u.exploded[0], by + u.exploded[1]];
    return [bx + u.seat[0] + u.lift[0], by + u.seat[1] + u.lift[1]];
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
    // Draw order: by seat bottom edge (all presets agree with the drawing).
    const order = units
      .map((u, i) => ({ u, i }))
      .sort((a, b) => a.u.seat[1] - b.u.seat[1] || a.i - b.i);
    for (const { u } of order) {
      const [px, py] = unitPos(u, state);
      const layer = partLayer(W, H, (l) => (isHs ? drawHs(l, px, py) : drawTw(l, px, py)));
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

    // Annotations, drawn on top.
    if (isHs && state === "exploded" && ann.has("arrows")) {
      for (const u of units) {
        const [px, py] = unitPos(u, state);
        const x = px + HS.tail[0];
        const y0 = py + HS.tail[1];
        const y1 = origin.exploded[1] - 14;
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
    if (isHs && state === "exploded" && (ann.has("label") || ann.has("labelLeader"))) {
      const [px, py] = unitPos(units[1], state);
      const rect = [px + 106, py + 16, 26, 16];
      if (ann.has("label")) {
        drawHsText(img, rect[0], rect[1]);
        annotations.push({ kind: "text", state, rect });
      }
      if (ann.has("labelLeader")) {
        const pts = [
          [rect[0] - 2, py + 24],
          [px + 94, py + 24],
        ];
        polyline(img, pts, 1);
        annotations.push({ kind: "leader", state, polyline: pts, for: units[1].id });
      }
    }
    if (isHs && state === "assembled" && ann.has("press")) {
      const [px, py] = unitPos(units[1], state);
      const x = px + 56;
      drawArrow(img, x, py - 28, py + 1);
      annotations.push({
        kind: "arrow",
        state,
        polyline: [
          [x, py - 28],
          [x, py + 1],
        ],
        for: units[1].id,
      });
    }
    if (isHs && state === "assembled" && (ann.has("callout") || ann.has("calloutLeader"))) {
      const [bx, by] = origin.assembled;
      const cx = bx + 140;
      const cy = by + 140;
      if (ann.has("callout")) {
        drawCallout(img, cx, cy);
        annotations.push({ kind: "text", state, rect: [cx - 10, cy - 10, 21, 21] });
      }
      if (ann.has("calloutLeader")) {
        const [px, py] = unitPos(units[0], state);
        const pts = [
          [cx - 6, cy - 6],
          [px + 56, py + 64],
        ];
        polyline(img, pts, 1);
        annotations.push({ kind: "leader", state, polyline: pts, for: units[0].id });
      }
    }
    states[state] = { image: img, truth, board: cleanBoard };
  }

  // Manifest: seeds in every drawn state (main heat sink: front + right face only, so the top
  // strips and the outer fin block are missed by the seeds; the clip is its own grouped part).
  const parts = [];
  for (const u of units) {
    const seedsFor = (local) => {
      const out = {};
      for (const state of preset.states) {
        const [px, py] = unitPos(u, state);
        out[state] = local.map(([x, y]) => [x + px, y + py]);
      }
      return out;
    };
    const body = isHs && name === "assembled-only" ? HS.allFaces : kind.seeds.body;
    parts.push({
      id: u.id,
      group: u.id,
      instanceOf: isHs ? "heatsink" : "twin",
      seeds: seedsFor(body),
      prior: "box",
    });
    if (isHs)
      parts.push({ id: u.clip, group: u.id, seeds: seedsFor(HS.seeds.clip), prior: "none" });
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
    for (const [state, s] of Object.entries(f.states)) {
      writeFileSync(join(out, `${state}.png`), png(s.image));
    }
    writeFileSync(join(out, "manifest.json"), JSON.stringify(f.manifest, null, 2) + "\n");
    console.log(`${name}: ${Object.keys(f.states).join(", ")}`);
  }
}
