// Deterministic generator for the from-image test inputs (flat diagrams + a whiteboard-style sketch).
// Run in a container: scripts/pc exec node tests/from-image/make-inputs.mjs
// Renders SVG -> PNG with the repo's resvg-wasm and Inter. No network, no randomness beyond a seeded PRNG.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const coreReq = createRequire(join(root, "packages", "core", "package.json"));
const wasmPath = coreReq.resolve("@resvg/resvg-wasm/index_bg.wasm");
const { Resvg, initWasm } = await import(pathToFileURL(join(dirname(wasmPath), "index.mjs")).href);
await initWasm(await readFile(wasmPath));
const font = await readFile(join(root, "packages/core/assets/fonts/Inter-Regular.latin.ttf"));
const fontBold = await readFile(join(root, "packages/core/assets/fonts/Inter-Bold.latin.ttf"));

const W = 1000;
const H = 600;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Point where the segment from the box centre towards (tx,ty) leaves the box (plus a gap). */
function edgePoint(b, tx, ty, gap = 4) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const s = Math.min(
    dx === 0 ? Infinity : b.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : b.h / 2 / Math.abs(dy),
  );
  const len = Math.hypot(dx, dy);
  return [cx + dx * s + (dx / len) * gap, cy + dy * s + (dy / len) * gap];
}

function link(a, b) {
  const ac = [a.x + a.w / 2, a.y + a.h / 2];
  const bc = [b.x + b.w / 2, b.y + b.h / 2];
  return [edgePoint(a, bc[0], bc[1]), edgePoint(b, ac[0], ac[1])];
}

// ---------- flat style ----------
function flat({ title, boxes, edges, groups = [] }) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">`,
    `<defs><marker id="ah" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#475569"/></marker></defs>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="24" y="38" font-size="22" font-weight="700" fill="#0f172a">${esc(title)}</text>`,
  ];
  for (const g of groups) {
    out.push(
      `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="10" fill="#eff6ff" stroke="#3b82f6" stroke-width="2" stroke-dasharray="8 5"/>`,
      `<text x="${g.x + 14}" y="${g.y + 26}" font-size="16" font-weight="700" fill="#1d4ed8">${esc(g.label)}</text>`,
    );
  }
  for (const e of edges) {
    const [p, q] = link(boxes[e.from], boxes[e.to]);
    const dash = e.dashed ? ` stroke-dasharray="6 4"` : "";
    out.push(
      `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="#475569" stroke-width="2.5"${dash} marker-end="url(#ah)"/>`,
    );
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    if (e.n) {
      out.push(
        `<circle cx="${mx}" cy="${my}" r="14" fill="#f59e0b"/>`,
        `<text x="${mx}" y="${my + 5}" font-size="15" font-weight="700" text-anchor="middle" fill="#ffffff">${e.n}</text>`,
      );
    }
    if (e.label) {
      out.push(
        `<text x="${mx}" y="${my - 8}" font-size="13" text-anchor="middle" fill="#334155">${esc(e.label)}</text>`,
      );
    }
  }
  for (const b of Object.values(boxes)) {
    out.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${b.fill ?? "#e2e8f0"}" stroke="#334155" stroke-width="2"/>`,
      `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 5}" font-size="16" font-weight="700" text-anchor="middle" fill="#0f172a">${esc(b.label)}</text>`,
    );
  }
  out.push("</svg>");
  return out.join("\n");
}

const box = (label, x, y, w = 140, h = 56, fill) => ({ label, x, y, w, h, fill });

// (a) web app
const webBoxes = {
  users: box("Users", 30, 272, 110, 56, "#fde68a"),
  cdn: box("CDN", 190, 272, 110, 56, "#bfdbfe"),
  lb: box("Load Balancer", 350, 272, 150, 56, "#bfdbfe"),
  app1: box("App Server 1", 580, 150, 150, 56, "#bbf7d0"),
  app2: box("App Server 2", 580, 394, 150, 56, "#bbf7d0"),
  db: box("PostgreSQL", 820, 150, 150, 56, "#fecaca"),
  cache: box("Redis Cache", 820, 394, 150, 56, "#fed7aa"),
};
const webSvg = flat({
  title: "Web app architecture",
  boxes: webBoxes,
  edges: [
    { from: "users", to: "cdn", label: "HTTPS" },
    { from: "cdn", to: "lb" },
    { from: "lb", to: "app1" },
    { from: "lb", to: "app2" },
    { from: "app1", to: "db" },
    { from: "app2", to: "db" },
    { from: "app1", to: "cache", dashed: true },
    { from: "app2", to: "cache", dashed: true },
  ],
});

// (b) kubernetes with numbered arrows
const k8sBoxes = {
  client: box("Client", 30, 272, 110, 56, "#fde68a"),
  ingress: box("Ingress", 230, 272, 120, 56, "#bfdbfe"),
  svc: box("Web Service", 430, 272, 140, 56, "#bfdbfe"),
  pod1: box("Web Pod 1", 640, 170, 120, 56, "#bbf7d0"),
  pod2: box("Web Pod 2", 640, 374, 120, 56, "#bbf7d0"),
  db: box("Database", 850, 170, 120, 56, "#fecaca"),
};
const k8sSvg = flat({
  title: "Kubernetes request path",
  boxes: k8sBoxes,
  groups: [{ label: "Kubernetes Cluster", x: 190, y: 90, w: 600, h: 420 }],
  edges: [
    { from: "client", to: "ingress", n: 1 },
    { from: "ingress", to: "svc", n: 2 },
    { from: "svc", to: "pod1", n: 3 },
    { from: "pod1", to: "db", n: 4 },
    { from: "svc", to: "pod2" },
  ],
});

// ---------- whiteboard style ----------
function whiteboard() {
  const rnd = mulberry32(20240607);
  const j = (n) => (rnd() - 0.5) * 2 * n;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fafaf7"/><stop offset="1" stop-color="#eceae2"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    `<rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="none" stroke="#b8b8b0" stroke-width="6" rx="6"/>`,
  ];
  const stroke = (d, c, w = 4) =>
    out.push(
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`,
    );
  const wobblyLine = (p, q, c) => {
    const n = 5;
    let d = `M${(p[0] + j(2)).toFixed(1)},${(p[1] + j(2)).toFixed(1)}`;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      d += ` L${(p[0] + (q[0] - p[0]) * t + j(3)).toFixed(1)},${(p[1] + (q[1] - p[1]) * t + j(3)).toFixed(1)}`;
    }
    stroke(d, c);
  };
  const wobblyRect = (b, c) => {
    for (let pass = 0; pass < 2; pass++) {
      const pts = [
        [b.x, b.y],
        [b.x + b.w, b.y],
        [b.x + b.w, b.y + b.h],
        [b.x, b.y + b.h],
        [b.x, b.y],
      ];
      for (let i = 0; i < 4; i++) {
        wobblyLine(
          [pts[i][0] + j(4), pts[i][1] + j(4)],
          [pts[i + 1][0] + j(4), pts[i + 1][1] + j(4)],
          c,
        );
      }
    }
  };
  const boxes = {
    docs: box("Documents", 40, 120, 190, 80),
    chunk: box("Chunker", 330, 120, 170, 80),
    embed: box("Embedding Model", 600, 250, 230, 90),
    vdb: box("Vector DB", 600, 440, 200, 80),
    q: box("Question", 40, 270, 190, 80),
    llm: box("LLM", 330, 440, 150, 80),
    ans: box("Answer", 40, 440, 160, 80),
  };
  const edges = [
    ["docs", "chunk"],
    ["chunk", "embed"],
    ["q", "embed"],
    ["embed", "vdb"],
    ["vdb", "llm"],
    ["llm", "ans"],
  ];
  for (const b of Object.values(boxes)) wobblyRect(b, "#1e3a8a");
  for (const [a, b] of edges) {
    const [p, q] = link(boxes[a], boxes[b]);
    wobblyLine(p, q, "#b91c1c");
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    for (const s of [-0.5, 0.5]) {
      wobblyLine(
        q,
        [q[0] - 22 * Math.cos(ang + s) + j(2), q[1] - 22 * Math.sin(ang + s) + j(2)],
        "#b91c1c",
      );
    }
  }
  for (const b of Object.values(boxes)) {
    const rot = j(2.5);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    out.push(
      `<text x="${cx}" y="${cy + 8}" font-size="26" font-style="italic" text-anchor="middle" fill="#1e3a8a" transform="rotate(${rot.toFixed(2)} ${cx} ${cy})">${esc(b.label)}</text>`,
    );
  }
  out.push(
    `<text x="620" y="90" font-size="30" font-style="italic" fill="#111827" transform="rotate(-3 620 90)">RAG pipeline</text>`,
  );
  stroke("M620,104 L790,100", "#b91c1c", 3);
  out.push("</svg>");
  return out.join("\n");
}

const files = {
  "web-app": webSvg,
  "k8s-sequence": k8sSvg,
  "whiteboard-rag": whiteboard(),
};
const dir = join(here, "inputs");
await mkdir(dir, { recursive: true });
for (const [name, svg] of Object.entries(files)) {
  const r = new Resvg(svg, {
    font: {
      fontBuffers: [font, fontBold],
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
      sansSerifFamily: "Inter",
    },
  });
  const img = r.render();
  const png = img.asPng();
  img.free();
  r.free();
  await writeFile(join(dir, `${name}.png`), png);
  console.log(`wrote inputs/${name}.png (${png.length} bytes)`);
}
