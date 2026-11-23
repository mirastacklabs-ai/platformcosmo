// Fixture 5 (ingestion §12; tracks D-4b): a synthetic instruction booklet for a generic brick
// rover (assemblies §19.5), written byte by byte. No real product, brand, mark or trade dress;
// the rover is the 33-leaf model of §19.5, drawn here as flat-shaded isometric boxes by a tiny
// polygon rasteriser. Everything is integer or fixed-formula arithmetic: no Date, no randomness,
// so the same Node build gives the same bytes.
//
//   node tests/fixtures/booklet/gen.mjs --check            regenerate twice, compare, and compare
//                                                          examples/rover-booklet.cosmo.json
//   node tests/fixtures/booklet/gen.mjs --write            rewrite that spec (then run prettier)
//   node tests/fixtures/booklet/gen.mjs --pdf <file.pdf>   write the booklet PDF
//
// The PDF has 10 pages: cover, parts list, then one page per build step 1-8 (step 6 carries the
// cab sub-build and its three mini steps). Every picture is a Flate RGB image XObject; part
// thumbnails are shared between the parts list and the step callouts. Text is Helvetica.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { fileURLToPath, URL } from "node:url";

// ---- the rover (assemblies §19.5), in studs (x, y) and plates (z) ------------------------------

const C = {
  gray: [154, 163, 173],
  blue: [47, 111, 208],
  red: [210, 59, 59],
  orange: [240, 138, 36],
  yellow: [242, 194, 48],
  wheel: [70, 72, 80],
  glass: [159, 211, 238],
  white: [238, 238, 238],
};

/** Expands `count`/`pitch`; `kind` is box (studs on top), tile (flat top) or slope (descends to +y). */
function leaf(list, id, group, step, at, size, color, o = {}) {
  const n = o.count ?? 1;
  const pitch = o.pitch ?? [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [0, 1, 2].map((k) => at[k] + pitch[k] * i);
    list.push({
      id: n > 1 ? `${id}-${i + 1}` : id,
      group,
      step,
      sub: o.sub ?? 0,
      kind: o.kind ?? "box",
      color,
      box: [x, y, z, x + size[0], y + size[1], z + size[2]],
    });
  }
}

function rover() {
  const p = [];
  leaf(p, "plate", "plate", 1, [0, 0, 2], [6, 10, 1], C.gray);
  leaf(p, "side", "side", 2, [0, 2, 3], [1, 6, 3], C.blue, { count: 2, pitch: [5, 0, 0] });
  leaf(p, "rear-wall", "rear", 2, [1, 0, 3], [4, 1, 3], C.blue);
  leaf(p, "wheel-l", "wheel", 3, [-1, 1, 0], [1, 2, 5], C.wheel, { count: 2, pitch: [0, 6, 0] });
  leaf(p, "wheel-r", "wheel", 3, [6, 1, 0], [1, 2, 5], C.wheel, { count: 2, pitch: [0, 6, 0] });
  leaf(p, "tile", "tile", 4, [1, 2, 3], [4, 2, 1], C.gray, {
    count: 3,
    pitch: [0, 2, 0],
    kind: "tile",
  });
  leaf(p, "lamp", "lamp", 4, [0, 9, 3], [1, 1, 1], C.yellow, { count: 2, pitch: [5, 0, 0] });
  leaf(p, "nose", "nose", 5, [1, 8, 3], [4, 2, 3], C.red, { kind: "slope" });
  // the cab (sub-build), origin [1, 2, 4]
  const cab = (id, group, sub, at, size, color, o = {}) =>
    leaf(p, id, group, 6, [1 + at[0], 2 + at[1], 4 + at[2]], size, color, { ...o, sub });
  cab("cab-base", "cab-base", 1, [0, 0, 0], [4, 4, 1], C.gray);
  cab("cab-wall", "cab-wall", 2, [0, 0, 1], [1, 4, 3], C.red, { count: 2, pitch: [3, 0, 0] });
  cab("cab-back", "cab-back", 2, [1, 0, 1], [2, 1, 3], C.red);
  cab("windshield", "glass", 2, [1, 3, 1], [2, 1, 3], C.glass, { kind: "tile" });
  cab("cab-roof", "cab-roof", 3, [0, 0, 4], [4, 4, 1], C.red);
  cab("roof-a", "cab-tile", 3, [0, 0, 5], [2, 2, 1], C.white, {
    count: 2,
    pitch: [2, 0, 0],
    kind: "tile",
  });
  cab("roof-b", "cab-tile", 3, [0, 2, 5], [2, 2, 1], C.white, {
    count: 2,
    pitch: [2, 0, 0],
    kind: "tile",
  });
  leaf(p, "cargo", "cargo", 7, [1, 6, 4], [2, 2, 3], C.orange, { count: 2, pitch: [2, 0, 0] });
  leaf(p, "rail", "rail", 7, [0, 2, 6], [1, 6, 1], C.gray, {
    count: 2,
    pitch: [5, 0, 0],
    kind: "tile",
  });
  leaf(p, "lid", "lid", 8, [1, 6, 7], [2, 2, 1], C.orange, {
    count: 2,
    pitch: [2, 0, 0],
    kind: "tile",
  });
  leaf(p, "antenna", "antenna", 8, [4, 7, 8], [1, 1, 3], C.white, { count: 3, pitch: [0, 0, 3] });
  return p;
}

/** Callout of each step: [group, label] (the count is the number of leaves in the group). */
const CALLOUT = {
  1: [["plate", "Base plate"]],
  2: [
    ["side", "Side wall"],
    ["rear", "Rear wall"],
  ],
  3: [["wheel", "Wheel"]],
  4: [
    ["tile", "Floor tile"],
    ["lamp", "Lamp"],
  ],
  5: [["nose", "Nose"]],
  6: [
    ["cab-base", "Cab base"],
    ["cab-wall", "Cab wall"],
    ["cab-back", "Cab back"],
    ["glass", "Windshield"],
    ["cab-roof", "Cab roof"],
    ["cab-tile", "Roof tile"],
  ],
  7: [
    ["cargo", "Cargo block"],
    ["rail", "Rail"],
  ],
  8: [
    ["lid", "Lid"],
    ["antenna", "Antenna"],
  ],
};
const CAPTION = [
  "",
  "Base plate",
  "Sides and rear wall",
  "Wheels",
  "Floor tiles and lamps",
  "Nose",
  "Cab (sub-build)",
  "Cargo and rails",
  "Lids and antenna",
];
const GROUPS = Object.values(CALLOUT).flat();

// ---- rasteriser: supersampled flat polygons ----------------------------------------------------

const SS = 2;
const shade = (c, f) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));

function fillPoly(img, pts, rgb) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const ax = Math.max(0, Math.floor(x0));
  const bx = Math.min(img.w - 1, Math.ceil(x1));
  const ay = Math.max(0, Math.floor(y0));
  const by = Math.min(img.h - 1, Math.ceil(y1));
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let pos = 0;
      let neg = 0;
      for (let i = 0; i < pts.length; i++) {
        const [ux, uy] = pts[i];
        const [vx, vy] = pts[(i + 1) % pts.length];
        const cr = (vx - ux) * (py - uy) - (vy - uy) * (px - ux);
        if (cr > 0) pos++;
        else if (cr < 0) neg++;
      }
      if (pos === 0 || neg === 0) {
        img.data.set(rgb, (y * img.w + x) * 3);
        img.cov[y * img.w + x] = 1;
      }
    }
  }
}

function seg(img, a, b, half, rgb) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * half;
  const ny = (dx / l) * half;
  fillPoly(
    img,
    [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ],
    rgb,
  );
}

/** Painter order for axis-aligned boxes seen from +x, +y, +z: behind first (cycle-free here). */
function paintOrder(parts) {
  const behind = (a, b) => a.box[3] <= b.box[0] || a.box[4] <= b.box[1] || a.box[5] <= b.box[2];
  const out = [];
  const state = new Map();
  const visit = (p) => {
    if (state.get(p) === 2) return;
    if (state.get(p) === 1) throw new Error(`draw-order cycle at ${p.id}`);
    state.set(p, 1);
    for (const q of parts) if (q !== p && behind(q, p) && !behind(p, q)) visit(q);
    state.set(p, 2);
    out.push(p);
  };
  [...parts].sort((a, b) => a.box[2] - b.box[2] || a.id.localeCompare(b.id)).forEach(visit);
  return out;
}

const SIN = 0.5;
const COS = Math.sqrt(3) / 2;
const PLATE = 0.4; // one plate in studs

/** Scale and offset that fit `parts` into w x h px with a margin (at most `maxU` px per stud). */
function frameFor(parts, w, h, margin, maxU = 100) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const { box: b } of parts) {
    for (const x of [b[0], b[3]])
      for (const y of [b[1], b[4]])
        for (const z of [b[2], b[5] + 0.3]) {
          const sx = (x - y) * COS;
          const sy = (x + y) * SIN - z * PLATE;
          x0 = Math.min(x0, sx);
          x1 = Math.max(x1, sx);
          y0 = Math.min(y0, sy);
          y1 = Math.max(y1, sy);
        }
  }
  const U = Math.min(maxU, (w - 2 * margin) / (x1 - x0), (h - 2 * margin) / (y1 - y0));
  return { U, ox: (w - U * (x0 + x1)) / 2, oy: (h - U * (y0 + y1)) / 2 };
}

/** The raster (RGB, w x h) of `parts` in `frame`: white paper, flat faces, dark outlines. */
function render(parts, w, h, frame) {
  const img = {
    w: w * SS,
    h: h * SS,
    data: new Uint8Array(w * SS * h * SS * 3).fill(255),
    cov: new Uint8Array(w * SS * h * SS),
  };
  const k = frame.U * SS;
  const P = (x, y, z) => [
    (x - y) * COS * k + frame.ox * SS,
    (x + y) * SIN * k - z * PLATE * k + frame.oy * SS,
  ];
  const face = (pts, col) => {
    const q = pts.map((t) => P(...t));
    fillPoly(img, q, col);
    for (let i = 0; i < q.length; i++)
      seg(img, q[i], q[(i + 1) % q.length], 0.45 * SS, shade(col, 0.5));
  };
  for (const { box: b, color, kind } of paintOrder(parts)) {
    const [x0, y0, z0, x1, y1, z1] = b;
    const zl = kind === "slope" ? Math.min(z0 + 1, z1) : z1;
    face(
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, zl],
        [x1, y0, z1],
      ],
      shade(color, 0.62),
    );
    face(
      [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, zl],
        [x0, y1, zl],
      ],
      shade(color, 0.8),
    );
    face(
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, zl],
        [x0, y1, zl],
      ],
      color,
    );
    if (kind !== "box") continue;
    for (let i = x0; i < x1; i++) {
      for (let j = y0; j < y1; j++) {
        const ring = (r, z) =>
          Array.from({ length: 10 }, (_, a) => [
            i + 0.5 + r * Math.cos((a * Math.PI) / 5),
            j + 0.5 + r * Math.sin((a * Math.PI) / 5),
            z,
          ]).map((t) => P(...t));
        fillPoly(img, ring(0.3, z1 + 0.5 * PLATE), shade(color, 0.7));
        fillPoly(img, ring(0.3, z1 + 0.9 * PLATE), shade(color, 1.12));
      }
    }
  }
  // box-filter down to w x h; alpha is the coverage, colour is averaged over covered samples
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0];
      let cov = 0;
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) {
          const at = (y * SS + dy) * img.w + x * SS + dx;
          if (!img.cov[at]) continue;
          cov++;
          for (let c = 0; c < 3; c++) sum[c] += img.data[at * 3 + c];
        }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = cov ? Math.round(sum[c] / cov) : 255;
      out[o + 3] = Math.round((cov * 255) / (SS * SS));
    }
  return { w, h, rgba: out };
}

// ---- PNG and the pictures ------------------------------------------------------------------------

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

/** 8-bit RGBA PNG, filter 0, from `{ w, h, rgba }`. */
export function png(r) {
  const raw = Buffer.alloc((r.w * 4 + 1) * r.h);
  for (let y = 0; y < r.h; y++)
    Buffer.from(r.rgba.buffer, r.rgba.byteOffset + y * r.w * 4, r.w * 4).copy(
      raw,
      y * (r.w * 4 + 1) + 1,
    );
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.w, 0);
  ihdr.writeUInt32BE(r.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The pixels of an RGBA PNG made by `png` (for the spec check; no other PNG is accepted). */
export function pngPixels(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT")
      idat.push(buf.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    rgba.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  return { w, h, rgba };
}

const MODEL = [176, 140];
const THUMB = [72, 58];
const SUB = [72, 58];

/** Every picture of the booklet: model after steps 1-8, part thumbnails, cab mini steps 1-3. */
export function pictures() {
  const parts = rover();
  const frame = frameFor(parts, MODEL[0], MODEL[1], 6);
  const pics = {};
  for (let s = 1; s <= 8; s++)
    pics[`m${s}`] = render(
      parts.filter((p) => p.step <= s),
      MODEL[0],
      MODEL[1],
      frame,
    );
  for (const [group] of GROUPS) {
    const one = parts.filter((p) => p.group === group).slice(0, 1);
    pics[`t-${group}`] = render(one, THUMB[0], THUMB[1], frameFor(one, THUMB[0], THUMB[1], 6, 12));
  }
  const cab = parts.filter((p) => p.step === 6);
  const cf = frameFor(cab, SUB[0], SUB[1], 5);
  for (let s = 1; s <= 3; s++)
    pics[`s${s}`] = render(
      cab.filter((p) => p.sub <= s),
      SUB[0],
      SUB[1],
      cf,
    );
  return pics;
}

export const counts = () => {
  const n = {};
  for (const p of rover()) n[p.group] = (n[p.group] ?? 0) + 1;
  return n;
};

// ---- the PDF ------------------------------------------------------------------------------------

class Pdf {
  constructor() {
    this.parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    this.size = this.parts[0].length;
    this.offsets = [];
  }
  obj(num, dict, data) {
    this.offsets[num] = this.size;
    const head = data
      ? `${num} 0 obj\n${dict.replace("<<", `<< /Length ${data.length}`)}\nstream\n`
      : `${num} 0 obj\n${dict}\nendobj\n`;
    const chunks = [Buffer.from(head, "latin1")];
    if (data) chunks.push(Buffer.from(data), Buffer.from("\nendstream\nendobj\n", "latin1"));
    for (const c of chunks) {
      this.parts.push(c);
      this.size += c.length;
    }
  }
  finish(trailer) {
    const n = this.offsets.length;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) x += `${String(this.offsets[i]).padStart(10, "0")} 00000 n \n`;
    x += `trailer\n<< /Size ${n} ${trailer} >>\nstartxref\n${this.size}\n%%EOF\n`;
    return Buffer.concat([...this.parts, Buffer.from(x, "latin1")]);
  }
}

const esc = (s) => s.replace(/[\\()]/g, "\\$&");

/** The booklet as PDF bytes. */
export function booklet() {
  const pics = pictures();
  const names = Object.keys(pics);
  const n = counts();
  const W = 400;
  const H = 560;
  const w = new Pdf();
  const FIRST_IMG = 5;
  const imgObj = Object.fromEntries(names.map((k, i) => [k, FIRST_IMG + i]));
  const FIRST_PAGE = FIRST_IMG + 2 * names.length;

  // page content builders (PDF user space: origin bottom left)
  const text = (x, y, size, s, bold = false) =>
    `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET\n`;
  const pic = (id, x, y, wd, ht) => `q ${wd} 0 0 ${ht} ${x} ${y} cm /${id} Do Q\n`;
  const rect = (x, y, wd, ht) => `${x} ${y} ${wd} ${ht} re S\n`;
  const line = (x0, y0, x1, y1) => `${x0} ${y0} m ${x1} ${y1} l S\n`;
  const pages = [];
  const ar = MODEL[1] / MODEL[0];

  pages.push({
    ids: ["m8"],
    body:
      text(40, 490, 34, "Brick Rover", true) +
      text(40, 462, 14, "Build instructions") +
      text(40, 444, 9, "A synthetic example booklet for PlatformCosmo tests.") +
      pic("m8", 40, 150, 320, Math.round(320 * ar * 10) / 10) +
      text(40, 60, 9, "Generic brick toy, 33 pieces. Not a real product.") +
      text(40, 46, 9, "Generated by tests/fixtures/booklet/gen.mjs."),
  });

  let body = text(40, 505, 24, "Parts", true);
  const ids = [];
  GROUPS.forEach(([g, label], i) => {
    const x = 28 + (i % 4) * 92;
    const y = 400 - Math.floor(i / 4) * 92;
    body +=
      pic(`t-${g}`, x, y, 72, 58) +
      text(x, y - 12, 12, `${n[g]}x`, true) +
      text(x + 26, y - 12, 8, label);
    ids.push(`t-${g}`);
  });
  pages.push({ ids, body });

  for (let s = 1; s <= 8; s++) {
    const items = CALLOUT[s];
    const sixth = s === 6;
    let b = text(36, 490, 40, String(s), true) + text(90, 498, 14, CAPTION[s]);
    const used = [`m${s}`];
    b += rect(30, 336, 340, 110);
    const step = sixth ? 54 : 84;
    items.forEach(([g, label], i) => {
      const x = 38 + i * step;
      const wd = sixth ? 44 : 72;
      const ht = sixth ? 36 : 58;
      b += pic(`t-${g}`, x, 384, wd, ht) + text(x, 370, 12, `${n[g]}x`, true);
      if (!sixth) b += text(x + 24, 370, 8, label);
      used.push(`t-${g}`);
    });
    if (sixth) {
      b += pic("m6", 40, 70, 240, Math.round(240 * ar * 10) / 10);
      b += rect(292, 60, 84, 266) + text(298, 312, 8, "Sub-build");
      [1, 2, 3].forEach((k) => {
        b +=
          pic(`s${k}`, 298, 232 - (k - 1) * 84, 72, 58) +
          text(298, 292 - (k - 1) * 84, 9, String(k), true);
        used.push(`s${k}`);
      });
      b += line(292, 190, 262, 170);
    } else b += pic(`m${s}`, 50, 70, 300, Math.round(300 * ar * 10) / 10);
    pages.push({ ids: used, body: b });
  }

  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${FIRST_PAGE + 2 * i} 0 R`).join(" ")}] >>`,
  );
  w.obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  w.obj(
    4,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  for (const k of names) {
    const { w: wd, h: ht, rgba } = pics[k];
    const rgb = new Uint8Array(wd * ht * 3);
    const alpha = new Uint8Array(wd * ht);
    for (let i = 0; i < wd * ht; i++) {
      rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
      alpha[i] = rgba[i * 4 + 3];
    }
    w.obj(
      imgObj[k],
      `<< /Type /XObject /Subtype /Image /Width ${wd} /Height ${ht} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${imgObj[k] + names.length} 0 R /Filter /FlateDecode >>`,
      deflateSync(rgb, { level: 9 }),
    );
    w.obj(
      imgObj[k] + names.length,
      `<< /Type /XObject /Subtype /Image /Width ${wd} /Height ${ht} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`,
      deflateSync(alpha, { level: 9 }),
    );
  }
  pages.forEach((pg, i) => {
    const num = FIRST_PAGE + 2 * i;
    const xo = [...new Set(pg.ids)].map((k) => `/${k} ${imgObj[k]} 0 R`).join(" ");
    w.obj(
      num,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${num + 1} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xo} >> >> >>`,
    );
    w.obj(num + 1, "<< >>", Buffer.from(`0.2 w\n${pg.body}`, "latin1"));
  });
  const info = FIRST_PAGE + 2 * pages.length;
  w.obj(info, "<< /Producer (PlatformCosmo synthetic booklet generator) /Title (Brick Rover) >>");
  return new Uint8Array(w.finish(`/Root 1 0 R /Info ${info} 0 R`));
}

// ---- the example spec ----------------------------------------------------------------------------

const SOURCE = { document: "Synthetic brick rover booklet (generated, no real product)" };

/** The storyboard example: the booklet's pictures as images, one frame per step. */
export function spec() {
  const pics = pictures();
  const n = counts();
  const page = (id) => (id.startsWith("m") ? Number(id.slice(1)) + 2 : id.startsWith("s") ? 8 : 2);
  const used = new Set();
  const frames = [];
  for (let s = 1; s <= 8; s++) {
    const f = {
      number: s,
      caption: CAPTION[s],
      model: `m${s}`,
      parts: CALLOUT[s].map(([g, label]) => ({ image: `t-${g}`, count: n[g], label })),
    };
    used.add(`m${s}`);
    CALLOUT[s].forEach(([g]) => used.add(`t-${g}`));
    if (s === 6) {
      f.attach = [58, 52];
      f.sub = [1, 2, 3].map((k) => ({ image: `s${k}` }));
      [1, 2, 3].forEach((k) => used.add(`s${k}`));
    }
    frames.push(f);
  }
  const images = Object.keys(pics)
    .filter((k) => used.has(k))
    .map((k) => ({
      id: k,
      src: `data:image/png;base64,${png(pics[k]).toString("base64")}`,
      alt:
        k[0] === "m"
          ? `Rover after step ${k.slice(1)}`
          : k[0] === "s"
            ? `Cab mini step ${k.slice(1)}`
            : `Part: ${k.slice(2)}`,
      source: { ...SOURCE, page: page(k) },
    }));
  return {
    $schema: "https://platformcosmo.io/schema/v1.json",
    meta: {
      version: "1",
      title: "Rover booklet storyboard",
      description:
        "A brick rover instruction booklet replayed step by step: parts callouts fly to the model, and the cab sub-build docks before the model changes.",
    },
    images,
    storyboards: [
      {
        id: "rover-booklet",
        label: "Brick rover",
        width: 14,
        transition: "fade",
        source: SOURCE,
        frames,
      },
    ],
    steps: [
      { caption: "Steps 1-3", duration: 6, assembly: [{ build: "rover-booklet", to: 3 }] },
      { caption: "Steps 4-5", duration: 5, assembly: [{ build: "rover-booklet", to: 5 }] },
      {
        caption: "Step 6: the cab sub-build",
        duration: 4,
        assembly: [{ build: "rover-booklet", to: 6 }],
      },
      { caption: "Steps 7-8", duration: 5, assembly: [{ build: "rover-booklet", to: 8 }] },
    ],
  };
}

const specPath = fileURLToPath(
  new URL("../../../examples/rover-booklet.cosmo.json", import.meta.url),
);

/** Problems found by `--check`: determinism, and the committed spec's pictures against ours. */
export function check(read = () => readFileSync(specPath, "utf8")) {
  const bad = [];
  const a = booklet();
  if (Buffer.compare(Buffer.from(a), Buffer.from(booklet())) !== 0)
    bad.push("booklet() differs between runs");
  const want = spec();
  let have;
  try {
    have = JSON.parse(read());
  } catch (e) {
    return [...bad, `committed spec unreadable: ${e.message}`];
  }
  // PNG bytes depend on the zlib build, so pictures are compared by pixels, the rest as JSON
  const px = (s) => {
    const m = /^data:image\/png;base64,(.*)$/.exec(s);
    return m ? pngPixels(Buffer.from(m[1], "base64")) : null;
  };
  const strip = (d) => ({
    ...d,
    images: d.images.map(({ id, alt, source }) => ({ id, alt, source })),
  });
  if (JSON.stringify(strip(have)) !== JSON.stringify(strip(want)))
    bad.push("spec differs from the generator");
  want.images.forEach((im, i) => {
    const h = have.images?.[i];
    const p = h && px(h.src);
    const q = px(im.src);
    if (
      !p ||
      p.w !== q.w ||
      p.h !== q.h ||
      Buffer.compare(Buffer.from(p.rgba), Buffer.from(q.rgba)) !== 0
    )
      bad.push(`image ${im.id} differs`);
  });
  return bad;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = process.argv[2];
  if (arg === "--write") {
    writeFileSync(specPath, `${JSON.stringify(spec(), null, 2)}\n`);
    console.log(`wrote ${specPath}; run: scripts/pc format`);
  } else if (arg === "--pdf" && process.argv[3]) {
    writeFileSync(process.argv[3], booklet());
  } else if (arg === "--check") {
    const bad = check();
    if (bad.length > 0) {
      console.error(
        `booklet check failed:\n  ${bad.join("\n  ")}\n  run: node tests/fixtures/booklet/gen.mjs --write`,
      );
      process.exit(1);
    }
    console.log("booklet check ok");
  } else {
    console.error("usage: gen.mjs --check | --write | --pdf <file>");
    process.exit(2);
  }
}
