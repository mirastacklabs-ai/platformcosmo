/* global URL */
/**
 * Local http server shared by the Playwright check and the Safari check. Serves SVGs with the
 * right Content-Type and builds the three embedding pages (img, inline, object) on request.
 * Dependency-free (node:http only).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export const MODES = ["img", "inline", "object"];

/** Removes `@media (prefers-reduced-motion: reduce) { ... }` blocks (balanced braces). */
export function stripReducedMotion(svg) {
  let out = svg;
  for (;;) {
    const at = out.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    if (at < 0) return out;
    const open = out.indexOf("{", at);
    if (open < 0) return out;
    let depth = 1;
    let i = open + 1;
    while (i < out.length && depth > 0) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      i++;
    }
    out = out.slice(0, at) + out.slice(i);
  }
}

/** Pixel size of the diagram: viewBox width/height, capped. */
export function sizeOf(svg) {
  const m = /viewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*"/.exec(svg);
  const w = m ? Number(m[1]) : 560;
  const h = m ? Number(m[2]) : 320;
  const k = Math.min(1, 1200 / w);
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

const css =
  "html,body{margin:0;background:#fff}#host{display:block}" +
  "#host>svg,#host>img,#host>object{display:block;width:100%;height:100%}";

export function pageHtml(mode, file, svg, strip) {
  const { width, height } = sizeOf(svg);
  const src = `/svg/${encodeURIComponent(file)}${strip ? "?strip=1" : ""}`;
  const inner =
    mode === "img"
      ? `<img id="el" src="${src}" alt="">`
      : mode === "object"
        ? `<object id="el" data="${src}" type="image/svg+xml"></object>`
        : strip
          ? stripReducedMotion(svg)
          : svg;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>check</title><style>${css}</style></head>` +
    `<body><div id="host" style="width:${width}px;height:${height}px">${inner}</div></body></html>`
  );
}

const probe = (q) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style>rect{fill:#0a0}` +
  `@media (${q}){rect{fill:#f00}}</style><rect width="40" height="40"/></svg>`;

export const PROBES = {
  reduce: "prefers-reduced-motion: reduce",
  "no-preference": "prefers-reduced-motion: no-preference",
  dark: "prefers-color-scheme: dark",
};

/** Starts the server on 127.0.0.1 (free port). `dir` holds the SVGs (and optional *.expected.png). */
export function startServer(dir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, type, body) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    try {
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "svg" && parts[1]) {
        const file = basename(parts[1]);
        const text = readFileSync(join(dir, file), "utf8");
        return send(
          200,
          "image/svg+xml",
          url.searchParams.has("strip") ? stripReducedMotion(text) : text,
        );
      }
      if (parts[0] === "expected" && parts[1]) {
        return send(200, "image/png", readFileSync(join(dir, basename(parts[1]))));
      }
      if (parts[0] === "page" && parts[1] && parts[2]) {
        const file = basename(parts[2]);
        return send(
          200,
          "text/html",
          pageHtml(
            parts[1],
            file,
            readFileSync(join(dir, file), "utf8"),
            url.searchParams.has("strip"),
          ),
        );
      }
      if (parts[0] === "probe" && parts[1]) {
        const key = basename(parts[1], ".svg");
        if (PROBES[key]) return send(200, "image/svg+xml", probe(PROBES[key]));
      }
      if (parts[0] === "probe-page" && PROBES[parts[1] ?? ""]) {
        return send(
          200,
          "text/html",
          `<body style="margin:0"><div id="box" style="width:200px;height:120px"><img src="/probe/${parts[1]}.svg" width="40" height="40"></div></body>`,
        );
      }
      if (parts[0] === "ref" && ["green", "red"].includes(parts[1] ?? "")) {
        const c = parts[1] === "green" ? "#0a0" : "#f00";
        return send(
          200,
          "text/html",
          `<body style="margin:0"><div id="box" style="width:200px;height:120px"><div style="width:40px;height:40px;background:${c}"></div></div></body>`,
        );
      }
      if (parts[0] === "blank")
        return send(
          200,
          "text/html",
          `<body style="margin:0"><div id="box" style="width:200px;height:120px"></div></body>`,
        );
      return send(404, "text/plain", "not found");
    } catch (e) {
      return send(500, "text/plain", String(e));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** SVG files of an input directory, sorted. */
export function listSvgs(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".svg"))
    .sort();
}

export function readFixtureInfo(dir) {
  const p = join(dir, "fixture.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}
