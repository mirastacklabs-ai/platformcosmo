// Synthetic figure images for the gallery example "From the hall to the heat sink"
// (examples/hall-to-heatsink.cosmo.json; document-ingestion §7.3, §12). No third-party content:
// the corner of a line-art board around ONE CPU socket, drawn in a near-isometric plane (the
// figure's base, heat sink erased), and the heat-sink sprite (transparent outside its silhouette):
// the close-up of one socket shows that socket and its heat sink, so sizes reconcile.
//
// Everything is integer geometry drawn at twice the size and box-downsampled, so the pixels are
// the same on every machine. The PNG bytes depend on the zlib build, so `--check` compares the
// decoded pixels of the committed data URIs with a fresh drawing, never the compressed bytes.
//
//   scripts/pc exec node scripts/gen-example-figures.mjs           rewrite the data URIs in the spec
//   scripts/pc exec node scripts/gen-example-figures.mjs --check   fail when they differ
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** Supersampling factor: shapes are drawn at SS times the output size, then box-filtered. */
const SS = 2;

/** Figure plane: board x runs right and slightly down, board y runs back up-right, z is up. */
const AX = [1, 0.0632];
const AY = [0.5, -0.5];
const AZ = [0, -1];

/** Heat-sink footprint and height in figure pixels (x, y, z). */
const HS = { w: 120, d: 92, h: 64, base: 8 };

/** Top-left of the seated heat-sink sprite, as the spec states it (`figures[0].parts[].seat`). */
export const SEATS = [[180, 280]];
/** Where the exploded sprite hovers (the figure is drawn exploded). */
export const EXPLODED = [[180, 80]];

const BASE_SIZE = [520, 480];

const PAPER = [255, 255, 255, 255];
const INK = [38, 44, 52, 255];
const BOARD = [214, 233, 214, 255];
const BOARD_EDGE = [168, 196, 170, 255];
const TRACE = [150, 186, 156, 255];
const SOCKET = [196, 200, 206, 255];
const SOCKET_IN = [226, 228, 232, 255];
const PIN = [150, 156, 166, 255];
const SLOT = [70, 78, 92, 255];
const CHIP = [92, 100, 112, 255];
const TOP = [232, 236, 241, 255];
const FRONT = [186, 194, 204, 255];
const SIDE = [150, 160, 173, 255];
const PLATE = [122, 132, 146, 255];
const LEVER = [205, 120, 60, 255];

const proj = (o, x, y, z = 0) => [
  o[0] + x * AX[0] + y * AY[0] + z * AZ[0],
  o[1] + x * AX[1] + y * AY[1] + z * AZ[1],
];

function canvas(w, h, fill) {
  const data = new Uint8Array(w * SS * h * SS * 4);
  for (let i = 0; i < w * SS * h * SS; i++) data.set(fill, i * 4);
  return { w: w * SS, h: h * SS, data };
}

/** Scanline fill of a polygon given in output pixels (sampled at the supersampled pixel centres). */
function fill(c, pts, col) {
  const p = pts.map(([x, y]) => [x * SS, y * SS]);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [, y] of p) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(c.h - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[(i + 1) % p.length];
      if (ay <= cy !== by <= cy) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(c.w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) c.data.set(col, (y * c.w + x) * 4);
    }
  }
}

/** A line of width `t` output pixels, drawn as a filled quad. */
function line(c, a, b, t, col) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (t / 2);
  const ny = (dx / len) * (t / 2);
  const ex = (dx / len) * (t / 2);
  const ey = (dy / len) * (t / 2);
  fill(
    c,
    [
      [a[0] - ex + nx, a[1] - ey + ny],
      [b[0] + ex + nx, b[1] + ey + ny],
      [b[0] + ex - nx, b[1] + ey - ny],
      [a[0] - ex - nx, a[1] - ey - ny],
    ],
    col,
  );
}

const outline = (c, pts, t, col = INK) =>
  pts.forEach((p, i) => line(c, p, pts[(i + 1) % pts.length], t, col));

/** A board-plane quad from (x, y) with size (w, d) at height z, filled and outlined. */
function quad(c, o, x, y, w, d, col, t = 1.5, z = 0, edge = INK) {
  const pts = [
    proj(o, x, y, z),
    proj(o, x + w, y, z),
    proj(o, x + w, y + d, z),
    proj(o, x, y + d, z),
  ];
  fill(c, pts, col);
  if (t > 0) outline(c, pts, t, edge);
}

/** Box filter SS x SS down to the output size (straight alpha, colour weighted by coverage). */
function downsample(c) {
  const w = c.w / SS;
  const h = c.h / SS;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < SS; j++)
        for (let i = 0; i < SS; i++) {
          const k = ((y * SS + j) * c.w + x * SS + i) * 4;
          const al = c.data[k + 3];
          r += c.data[k] * al;
          g += c.data[k + 1] * al;
          b += c.data[k + 2] * al;
          a += al;
        }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (SS * SS));
    }
  return { width: w, height: h, data: out };
}

/** The heat sink's front-left-bottom corner inside its sprite (sprite pixels). */
function spriteAnchor() {
  const xs = [];
  const ys = [];
  for (const x of [0, HS.w])
    for (const y of [0, HS.d])
      for (const z of [0, HS.h]) {
        const [px, py] = proj([0, 0], x, y, z);
        xs.push(px);
        ys.push(py);
      }
  const pad = 3;
  return {
    anchor: [pad - Math.min(...xs), pad - Math.min(...ys)],
    size: [
      Math.ceil(Math.max(...xs) - Math.min(...xs)) + 2 * pad,
      Math.ceil(Math.max(...ys) - Math.min(...ys)) + 2 * pad,
    ],
  };
}

/** The shared heat-sink sprite: base plate, fin block (fins on top and front), clip lever. */
export function heatsink() {
  const { anchor, size } = spriteAnchor();
  const c = canvas(size[0], size[1], [0, 0, 0, 0]);
  const o = anchor;
  const box = (x, y, z, w, d, h, top, front, side) => {
    const p = (a, b, e) => proj(o, x + a, y + b, z + e);
    const right = [p(w, 0, 0), p(w, d, 0), p(w, d, h), p(w, 0, h)];
    const fr = [p(0, 0, 0), p(w, 0, 0), p(w, 0, h), p(0, 0, h)];
    const tp = [p(0, 0, h), p(w, 0, h), p(w, d, h), p(0, d, h)];
    fill(c, right, side);
    fill(c, fr, front);
    fill(c, tp, top);
    for (const f of [right, fr, tp]) outline(c, f, 1.5);
  };
  box(0, 0, 0, HS.w, HS.d, HS.base, PLATE, PLATE, SLOT);
  const inset = 6;
  box(inset, inset, HS.base, HS.w - 2 * inset, HS.d - 2 * inset, HS.h - HS.base, TOP, FRONT, SIDE);
  // fins: grooves across the top face (along y) and down the front face
  const fins = 9;
  const fw = (HS.w - 2 * inset) / fins;
  for (let i = 1; i < fins; i++) {
    const x = inset + i * fw;
    line(c, proj(o, x, inset, HS.h), proj(o, x, HS.d - inset, HS.h), 1, SIDE);
    line(c, proj(o, x, inset, HS.base + 2), proj(o, x, inset, HS.h), 1, SIDE);
  }
  // retention clip lever on the right side, grouped with its heat sink
  const lx = HS.w;
  const lever = [
    proj(o, lx, HS.d * 0.3, 2),
    proj(o, lx + 4, HS.d * 0.3, 2),
    proj(o, lx + 4, HS.d * 0.7, HS.h * 0.6),
    proj(o, lx, HS.d * 0.7, HS.h * 0.6),
  ];
  fill(c, lever, LEVER);
  outline(c, lever, 1.2);
  return downsample(c);
}

/** The figure's base: the board with both sockets empty (heat sinks erased, no arrows). */
export function base() {
  const c = canvas(BASE_SIZE[0], BASE_SIZE[1], PAPER);
  const { anchor } = spriteAnchor();
  // board origin so that the heat sink seated at SEATS[0] stands on the socket at board `sock`
  const s1 = [SEATS[0][0] + anchor[0], SEATS[0][1] + anchor[1]];
  const sock = { x: 70, y: 70 };
  const o = [s1[0] - sock.x * AX[0] - sock.y * AY[0], s1[1] - sock.x * AX[1] - sock.y * AY[1]];

  // the corner of the board around one CPU socket
  quad(c, o, 0, 0, 300, 240, BOARD, 2);
  quad(c, o, 8, 8, 284, 224, BOARD, 1, 0, BOARD_EDGE);
  const trace = (pts) => {
    for (let i = 0; i + 1 < pts.length; i++)
      line(c, proj(o, ...pts[i]), proj(o, ...pts[i + 1]), 1.2, TRACE);
  };
  // traces from the socket to the memory slots and to the voltage regulators in front
  for (let k = 0; k < 5; k++)
    trace([
      [sock.x + HS.w + 6, sock.y + 14 + k * 14],
      [214, sock.y + 14 + k * 14],
    ]);
  for (let k = 0; k < 5; k++)
    trace([
      [sock.x + 16 + k * 12, sock.y - 6],
      [sock.x + 16 + k * 12, 36],
    ]);
  // mounting hole
  quad(c, o, 17, 213, 10, 10, PAPER, 1.2);
  // the socket (frame, inner area, pin grid) where the heat sink seats
  quad(c, o, sock.x - 4, sock.y - 4, HS.w + 8, HS.d + 8, SOCKET, 1.5);
  quad(c, o, sock.x + 12, sock.y + 12, HS.w - 24, HS.d - 24, SOCKET_IN, 1);
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 6; j++)
      quad(c, o, sock.x + 18 + i * 11, sock.y + 18 + j * 10, 3, 3, PIN, 0);
  // memory slots beside the socket, voltage regulators in front of it
  for (let k = 0; k < 4; k++) quad(c, o, 220 + k * 16, 40, 6, 170, SLOT, 1);
  for (let k = 0; k < 4; k++) quad(c, o, sock.x + 4 + k * 28, 14, 18, 16, CHIP, 1.2);
  return downsample(c);
}

// ---------------------------------------------------------------- PNG in and out

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Raw filter-0 scanlines of an RGBA raster. */
function scanlines(r) {
  const raw = Buffer.alloc((r.width * 4 + 1) * r.height);
  for (let y = 0; y < r.height; y++)
    Buffer.from(r.data.buffer, r.data.byteOffset + y * r.width * 4, r.width * 4).copy(
      raw,
      y * (r.width * 4 + 1) + 1,
    );
  return raw;
}

export function png(r) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines(r), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Width, height and raw scanlines of a PNG this script wrote (8-bit RGBA, filter 0). */
export function decode(bytes) {
  const b = Buffer.from(bytes);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const idat = [];
  for (let p = 8; p < b.length;) {
    const len = b.readUInt32BE(p);
    if (b.toString("latin1", p + 4, p + 8) === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  return { width, height, raw: inflateSync(Buffer.concat(idat)) };
}

/** The example's images by id, freshly drawn. */
export function images() {
  return { "hs-base": base(), "hs-sprite": heatsink() };
}

const PREFIX = "data:image/png;base64,";
export const SPEC = fileURLToPath(
  new URL("../examples/hall-to-heatsink.cosmo.json", import.meta.url),
);

/** Ids whose committed data URI does not decode to the fresh drawing. */
export function stale(specText) {
  const spec = JSON.parse(specText);
  const fresh = images();
  return Object.keys(fresh).filter((id) => {
    const src = spec.images?.find((i) => i.id === id)?.src ?? "";
    if (!src.startsWith(PREFIX)) return true;
    const got = decode(Buffer.from(src.slice(PREFIX.length), "base64"));
    const r = fresh[id];
    return got.width !== r.width || got.height !== r.height || !got.raw.equals(scanlines(r));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = readFileSync(SPEC, "utf8");
  if (process.argv.includes("--check")) {
    const bad = stale(text);
    if (bad.length > 0) {
      console.error(
        `stale images in ${SPEC}: ${bad.join(", ")}; run: scripts/pc exec node scripts/gen-example-figures.mjs`,
      );
      process.exit(1);
    }
    console.log("example figures are up to date");
  } else {
    const fresh = images();
    let out = text;
    for (const [id, r] of Object.entries(fresh)) {
      const uri = PREFIX + png(r).toString("base64");
      const re = new RegExp(`("id": "${id}",\\s*"src": ")[^"]*(")`);
      if (!re.test(out)) throw new Error(`image ${id} not found in ${SPEC}`);
      out = out.replace(re, `$1${uri}$2`);
    }
    writeFileSync(SPEC, out);
    console.log(`wrote ${Object.keys(fresh).join(", ")} into ${SPEC}`);
  }
}
