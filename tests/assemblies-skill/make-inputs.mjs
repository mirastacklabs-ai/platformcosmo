// Deterministic generator for the assemblies-skill E2E inputs (D-3b): a synthetic board plan
// (labelled rectangles and a dimension line), the same plan without a dimension line ("not drawn
// to scale"), and a synthetic GPU-card side view. No third-party content, no randomness.
// Run in a container: scripts/pc exec node tests/assemblies-skill/make-inputs.mjs [--check]
// Renders SVG -> PNG with the repo's resvg-wasm and Oswald. `--check` writes nothing and exits 1 when
// a committed PNG or truth file differs.
// The truth file lives in truth/, apart from inputs/, so the E2E agents' input folder holds no ground truth.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const coreReq = createRequire(join(root, "packages", "core", "package.json"));
const wasmPath = coreReq.resolve("@resvg/resvg-wasm/index_bg.wasm");
const { Resvg, initWasm } = await import(pathToFileURL(join(dirname(wasmPath), "index.mjs")).href);
await initWasm(await readFile(wasmPath));
const font = await readFile(join(root, "packages/core/assets/fonts/Oswald-Regular.latin.ttf"));
const fontBold = await readFile(join(root, "packages/core/assets/fonts/Oswald-SemiBold.latin.ttf"));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------- board plan ----------
// Scale: 60 px per inch. The board is 13 in x 9 in (780 x 540 px) with its top-left at (110, 90).
const PX_PER_IN = 60;
const BOARD = { x: 110, y: 90, w: 780, h: 540 };
/** Plan rectangles in image pixels (the labels are the parts' names). */
const RECTS = [
  { label: "CPU 1", x: 230, y: 150, w: 120, h: 120, kind: "cpu" },
  { label: "CPU 2", x: 230, y: 420, w: 120, h: 120, kind: "cpu" },
  { label: "DIMM A", x: 380, y: 150, w: 30, h: 150, kind: "dimm" },
  { label: "DIMM B", x: 420, y: 150, w: 30, h: 150, kind: "dimm" },
  { label: "DIMM C", x: 380, y: 390, w: 30, h: 150, kind: "dimm" },
  { label: "DIMM D", x: 420, y: 390, w: 30, h: 150, kind: "dimm" },
  { label: "Bridge", x: 520, y: 270, w: 100, h: 100, kind: "chip" },
  { label: "PCIe x16 1", x: 520, y: 130, w: 340, h: 24, kind: "slot" },
  { label: "PCIe x16 2", x: 520, y: 180, w: 340, h: 24, kind: "slot" },
  { label: "PCIe x8", x: 520, y: 230, w: 340, h: 24, kind: "slot" },
  { label: "BIOS", x: 660, y: 300, w: 70, h: 50, kind: "chip" },
  { label: "Battery", x: 760, y: 300, w: 60, h: 60, kind: "battery" },
  { label: "Power", x: 140, y: 120, w: 60, h: 90, kind: "connector" },
  { label: "SATA", x: 540, y: 520, w: 150, h: 40, kind: "connector" },
  { label: "USB", x: 740, y: 520, w: 110, h: 40, kind: "connector" },
  { label: "JP1", x: 700, y: 440, w: 30, h: 30, kind: "jumper" },
];

function plan({ scale }) {
  const W = 1000;
  const H = 720;
  const o = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Oswald">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="24" y="38" font-size="22" font-weight="700" fill="#0f172a">Mainboard layout${scale ? "" : " (not drawn to scale)"}</text>`,
    `<rect x="${BOARD.x}" y="${BOARD.y}" width="${BOARD.w}" height="${BOARD.h}" fill="#e8efe8" stroke="#334155" stroke-width="3"/>`,
  ];
  for (const r of RECTS) {
    o.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#ffffff" stroke="#0f172a" stroke-width="2"/>`,
    );
    const vertical = r.h > r.w * 2;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const fs = r.h <= 30 && !vertical ? 15 : 17;
    o.push(
      vertical
        ? `<text x="${cx}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#0f172a" transform="rotate(-90 ${cx} ${cy})">${esc(r.label)}</text>`
        : `<text x="${cx}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#0f172a">${esc(r.label)}</text>`,
    );
  }
  if (scale) {
    const y = BOARD.y + BOARD.h + 40;
    const x1 = BOARD.x;
    const x2 = BOARD.x + BOARD.w;
    o.push(
      `<g stroke="#b91c1c" stroke-width="2" fill="none">`,
      `<path d="M${x1},${BOARD.y + BOARD.h + 8} V${y + 10} M${x2},${BOARD.y + BOARD.h + 8} V${y + 10}"/>`,
      `<path d="M${x1},${y} H${x2}"/>`,
      `<path d="M${x1 + 12},${y - 6} L${x1},${y} L${x1 + 12},${y + 6} M${x2 - 12},${y - 6} L${x2},${y} L${x2 - 12},${y + 6}"/>`,
      `</g>`,
      `<rect x="${(x1 + x2) / 2 - 36}" y="${y - 14}" width="72" height="28" fill="#ffffff"/>`,
      `<text x="${(x1 + x2) / 2}" y="${y}" font-size="20" text-anchor="middle" dominant-baseline="central" fill="#b91c1c">13 in</text>`,
    );
  }
  o.push("</svg>");
  return o.join("\n");
}

// ---------- GPU card side view ----------
function gpuCard() {
  const W = 640;
  const H = 240;
  const o = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Oswald">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<rect x="20" y="30" width="590" height="150" rx="10" fill="#2b3340" stroke="#0f172a" stroke-width="3"/>`,
    `<rect x="20" y="30" width="590" height="14" fill="#3f4a5c"/>`,
  ];
  for (const cx of [140, 320, 500]) {
    o.push(
      `<circle cx="${cx}" cy="108" r="62" fill="#1a202b" stroke="#6b7a90" stroke-width="3"/>`,
      `<circle cx="${cx}" cy="108" r="14" fill="#6b7a90"/>`,
    );
    for (let k = 0; k < 9; k++) {
      const a = (k * 40 * Math.PI) / 180;
      o.push(
        `<path d="M${cx},108 L${(cx + 54 * Math.cos(a)).toFixed(1)},${(108 + 54 * Math.sin(a)).toFixed(1)}" stroke="#6b7a90" stroke-width="7" stroke-linecap="round"/>`,
      );
    }
  }
  o.push(
    `<rect x="40" y="180" width="360" height="22" fill="#d4a017" stroke="#0f172a" stroke-width="2"/>`,
    `<text x="570" y="165" font-size="20" font-weight="700" text-anchor="end" fill="#d9dee7">SYNTHETIC GPU</text>`,
    `</svg>`,
  );
  return o.join("\n");
}

const truth = {
  note: "Ground truth for the synthetic board plan; the E2E agents must not read it.",
  image: "board-plan.png",
  pixelsPerInch: PX_PER_IN,
  board: { ...BOARD, widthIn: 13, depthIn: 9 },
  dimensionLine: { label: "13 in", spans: "board width" },
  rects: RECTS,
};

const svgs = {
  "board-plan": plan({ scale: true }),
  "board-plan-noscale": plan({ scale: false }),
  "gpu-card": gpuCard(),
};
const dir = join(here, "inputs");
const check = process.argv.includes("--check");
if (!check) {
  await mkdir(dir, { recursive: true });
  await mkdir(join(here, "truth"), { recursive: true });
}
let stale = 0;

async function emit(name, bytes, base = dir) {
  const target = join(base, name);
  if (check) {
    const onDisk = await readFile(target).catch(() => null);
    const same = onDisk !== null && Buffer.compare(onDisk, Buffer.from(bytes)) === 0;
    console.log(`${same ? "ok   " : "STALE"} ${name}`);
    if (!same) stale++;
  } else {
    await writeFile(target, bytes);
    console.log(`wrote ${name} (${bytes.length} bytes)`);
  }
}

for (const [name, svg] of Object.entries(svgs)) {
  const r = new Resvg(svg, {
    font: {
      fontBuffers: [font, fontBold],
      loadSystemFonts: false,
      defaultFontFamily: "Oswald",
      sansSerifFamily: "Oswald",
    },
  });
  const img = r.render();
  const png = img.asPng();
  img.free();
  r.free();
  await emit(`inputs/${name}.png`, png, here);
}
await emit("truth/board-plan.truth.json", Buffer.from(`${JSON.stringify(truth, null, 2)}\n`), here);
if (stale) process.exitCode = 1;
