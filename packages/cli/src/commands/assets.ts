/**
 * `pcosmo assets` (ingestion §3, figure subset): doctor, crop, cutout, locate, align, figure,
 * check, shrink. Offline and deterministic. Inputs are untrusted and read through `images.ts`
 * (no symlinks, one `O_NOFOLLOW` open, bounded reads); outputs go through `writeInside` below the
 * working directory and use fixed names (`base.png`, `sprite-N.png`, `report.json`,
 * `fragment.json`, `exclusions-<state>.png`) or the `-o` path the user typed, never a name taken
 * from a file's content. Every problem is a diagnostic plus an exit code.
 */
import { access, constants as fsc, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_IMAGE_LIMITS, type Diagnostic, type ImageLimits } from "@platformcosmo/core";
import {
  MANIFEST_LIMITS,
  MAX_MULTIPLY_ADDS,
  MAX_PIXELS,
  align,
  checkFigure,
  crop,
  cutout,
  decodeImage,
  encodePng,
  exclusionOverlay,
  locate,
  outputsFromFragment,
  removeBackground,
  runFigure,
  shrinkImage,
  trim,
  type FigureSourceInfo,
  type Raster,
  type Rect,
} from "@platformcosmo/assets";
import { type Parsed, flag, num, parse, str } from "../args.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { hasErrors, plural } from "../format.js";
import { HAS_NOFOLLOW, insideAssetsRoot, readFileSafe } from "../images.js";
import { relFromCwd, staleOutputs } from "../outputs.js";
import { MAX_PAGES_PER_COMMAND, pdfCommand } from "./assets-pdf.js";
import { DEFAULT_LIMITS as DEFAULT_PDF_LIMITS } from "@platformcosmo/pdf";
import { DPI_RANGE, RENDER_LIMITS, TOOL_NAMES, findTool, toolDirs } from "../pdftool.js";
import {
  assetsRoot,
  bad,
  finish,
  outsideRoot,
  ROOT_HINT,
  isObj,
  needed,
  oneInput,
  pngExt,
  readDiag,
  readIn,
  shown,
  strs,
  writeFiles,
  writeOne,
} from "./assets-io.js";
import schema from "../../schema/figure-manifest.v1.json" with { type: "json" };

export const HELP = `Usage: pcosmo assets <command> [options]

Deterministic image operations for figure ingestion. Offline. Inputs are files you name (PNG, JPEG,
SVG; symlinks and special files are refused); outputs are written below the working directory.

Commands:
  doctor                                   Check the environment and print the limits
  schema                                   Print the figure manifest JSON Schema
  crop <img> --rect x,y,w,h -o out.png     Crop (--transparent [--tolerance 12] removes the
                                           edge-connected background, --trim drops empty margins)
  cutout <img> --seed x,y[;x,y...] -o sprite.png
                                           Silhouette-cut one part (--polygon x,y;x,y;...,
                                           --prior box|cylinder|none, --mask auto|rect, --holes)
  locate <sprite> --in <img>               Template match (--region x,y,w,h --top 3 --min-score 0.5
                                           --scales 0.8,1,1.25)
  align <imgA> <imgB>                      Translation between two drawings (--patch x,y,w,h
                                           --max-shift N --min-score 0.5)
  figure <manifest.json> -d <dir>          The whole figure pipeline: base.png, sprite-N.png,
                                           report.json, fragment.json; when the gate fails only
                                           report.json and the overlays are written (--figure-id id, --src-dir fig/,
                                           --label text, --strict, --show-exclusions, provenance:
                                           --source-document --source-page --source-figure
                                           --attribution --license --source-url,
                                           or --source-json <file> (what the skill uses))
  check <manifest.json> -d <dir>           Re-run the quality gate on the outputs in <dir>
                                           (reads <dir>/fragment.json and its PNGs; --strict)
  shrink <img> --max-px 1024 -o out.png    Downscale (PNG) or pass a JPEG through (--to-png)
  pdf <command> ...                        PDF inputs: info, list, extract, compose, render, text
                                           (pcosmo assets pdf --help; render needs pdftoppm or mutool)

Options:
  --json         Print a machine-readable result (sorted keys, same input gives the same bytes)
  -o <file>      Output file (inside the working directory)
  --root <dir>   Directory inputs and outputs may live in (default: the working directory)
  -d <dir>       Output directory (inside the working directory; created if missing)
  -h, --help     Show this help

Confinement: every input and output path must resolve inside the working directory. --root <dir>
(any command) allows another directory on purpose. When PCOSMO_ASSETS_ROOT is set (the Claude Code
plugin launcher sets it to the working directory) it is the outer bound and --root cannot leave it.

Manifest: pcosmo assets schema (also schema/figure-manifest.v1.json) (shipped with the package). Source file names in a manifest
are relative to the manifest's directory and may not contain '..'.

Exit codes: 0 ok, 1 diagnostics with errors (gate failures included), 2 usage, 3 internal error
or, for doctor, an unavailable renderer (a missing optional tool is a warning, exit 0).
`;

/** Read limits for the files of these commands: scans are bigger than diagram images (§14). */
export const ASSET_LIMITS: ImageLimits = {
  maxBytes: 24 * 1024 * 1024,
  maxSvgBytes: DEFAULT_IMAGE_LIMITS.maxSvgBytes,
  maxDimension: 16384,
  maxPixels: MAX_PIXELS,
  maxTotalBytes: 64 * 1024 * 1024,
  maxImages: 256,
  warnTotalBytes: 64 * 1024 * 1024,
};

const MAX_MANIFEST_BYTES = 1024 * 1024;
const FIXED_OUTPUT = /^(base|sprite-[1-9][0-9]{0,2})\.png$/;

// ---------------------------------------------------------------------------------------------
// argument parsing (every problem is a UsageError: exit 2 with the help)
// ---------------------------------------------------------------------------------------------

function ints(text: string, n: number, name: string): number[] {
  const parts = text.length <= 64 ? text.split(",") : [];
  if (parts.length !== n || !parts.every((x) => /^-?\d{1,9}$/.test(x.trim()))) {
    throw new UsageError(`--${name} must be ${n} integers separated by commas`);
  }
  return parts.map(Number);
}

function rectArg(p: Parsed, name: string): Rect | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const [x, y, w, h] = ints(v, 4, name) as [number, number, number, number];
  return { x, y, w, h };
}

function pointsArg(texts: readonly string[], max: number, name: string): [number, number][] {
  const out: [number, number][] = [];
  for (const t of texts) {
    if (t.length > 16384) throw new UsageError(`--${name} is too long`);
    for (const pt of t.split(";")) {
      if (pt.trim() === "") continue;
      const [x, y] = ints(pt, 2, name) as [number, number];
      out.push([x, y]);
      if (out.length > max) throw new UsageError(`--${name} takes at most ${max} points`);
    }
  }
  return out;
}

/** An image named on the command line, decoded to RGBA. Diagnostics are appended to `diags`. */
async function loadImage(
  ctx: Ctx,
  path: string,
  diags: Diagnostic[],
  key = "image",
): Promise<Raster | undefined> {
  const r = await readIn(ctx, path, ASSET_LIMITS.maxBytes);
  if (!r.ok) {
    diags.push(readDiag(r, shown(ctx, path)));
    return undefined;
  }
  const d = await decodeImage(r.bytes, { limits: ASSET_LIMITS, key });
  diags.push(...d.diagnostics);
  return d.value?.raster;
}

async function loadJson(
  ctx: Ctx,
  path: string,
  what: string,
  diags: Diagnostic[],
): Promise<unknown | undefined> {
  const r = await readIn(ctx, path, MAX_MANIFEST_BYTES);
  if (!r.ok) {
    diags.push(readDiag(r, `${what} ${shown(ctx, path)}`));
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(r.bytes)) as unknown;
  } catch (e) {
    diags.push(bad(what, `${what} is not valid JSON: ${(e as Error).message.slice(0, 200)}`));
    return undefined;
  }
}

/**
 * The drawings a manifest names (`sources.exploded` / `sources.assembled`), read relative to the
 * manifest's directory through the path guard and keyed by the name as written. A value that is
 * not a plain relative path is refused here (`image/unsafe-path`) before anything is opened.
 */
async function loadSources(
  ctx: Ctx,
  manifest: unknown,
  manifestPath: string,
  diags: Diagnostic[],
): Promise<Record<string, Raster> | undefined> {
  if (!isObj(manifest) || !isObj(manifest.sources)) return {}; // the pipeline reports the manifest
  const dir = resolve(ctx.deps.cwd, manifestPath, "..");
  const loaded = new Map<string, Raster>();
  let ok = true;
  for (const state of ["exploded", "assembled"] as const) {
    const name = manifest.sources[state];
    if (typeof name !== "string" || loaded.has(name)) continue;
    const r = await readFileSafe(dir, name, ASSET_LIMITS.maxBytes);
    if (!r.ok) {
      diags.push({ ...readDiag(r, `sources.${state}`), path: `/sources/${state}` });
      ok = false;
      continue;
    }
    const d = await decodeImage(r.bytes, { limits: ASSET_LIMITS, key: state });
    diags.push(...d.diagnostics);
    if (d.value) loaded.set(name, d.value.raster);
    else ok = false;
  }
  return ok ? Object.fromEntries(loaded) : undefined;
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

async function toolPath(env: Readonly<Record<string, string | undefined>>, name: string) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const e of exts) {
      const p = join(dir, name + e);
      try {
        if ((await stat(p)).isFile()) {
          await access(p, fsc.X_OK);
          return p;
        }
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

async function doctor(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { json: { type: "boolean" } });
  oneInput(p, "assets doctor", 0, "no arguments");
  const diags: Diagnostic[] = [];
  // The renderer decodes every image: a 1x1 PNG round trip proves resvg starts.
  const probe = await decodeImage(encodePng({ width: 1, height: 1, data: new Uint8Array(4) }));
  const renderer = probe.value !== undefined;
  if (!renderer) diags.push(...probe.diagnostics);
  // The PDF tools are looked up once, in the fixed directories `assets pdf render` uses; ffmpeg is
  // informational only and is still found through PATH.
  const pdfTools: Record<string, { found: boolean; path?: string }> = {};
  for (const t of TOOL_NAMES) {
    const path = await findTool(toolDirs(ctx.deps.pdfRender), t);
    pdfTools[t] = path === undefined ? { found: false } : { found: true, path };
  }
  const ff = await toolPath(ctx.deps.env, "ffmpeg");
  const tools: Record<string, { found: boolean; path?: string }> = {
    ffmpeg: ff === undefined ? { found: false } : { found: true, path: ff },
    mutool: pdfTools.mutool!,
    pdftoppm: pdfTools.pdftoppm!,
  };
  for (const [name, t] of Object.entries(tools)) {
    if (!t.found) {
      diags.push({
        severity: "warning",
        code: "asset/tool-missing",
        path: "",
        message: `optional tool ${name} was not found ${name === "ffmpeg" ? "on PATH" : `in ${toolDirs(ctx.deps.pdfRender).join(":")}`}`,
        suggestion: "only needed for PDF and video work; image and figure commands run without it",
        params: { tool: name },
      });
    }
  }
  const pdfChosen = TOOL_NAMES.find((t) => pdfTools[t]!.found);
  const payload = {
    assetsRoot: assetsRoot(ctx),
    assetsRootEnv: ctx.deps.env.PCOSMO_ASSETS_ROOT ?? null,
    node: process.version,
    platform: process.platform,
    noFollow: HAS_NOFOLLOW,
    readGuard: process.platform === "linux" ? "proc-fd" : "writable-directory-refusal",
    renderer: renderer ? "ok" : "failed",
    optionalTools: tools,
    pdf: {
      limits: { ...DEFAULT_PDF_LIMITS },
      commands: {
        maxPagesPerCommand: MAX_PAGES_PER_COMMAND,
        maxPdfBytes: DEFAULT_PDF_LIMITS.maxFileBytes,
        maxOutputPixels: RENDER_LIMITS.maxPixels,
      },
      render: {
        available: pdfChosen !== undefined,
        tool: pdfChosen ?? null,
        tools: pdfTools,
        searchedDirs: [...toolDirs(ctx.deps.pdfRender)],
        timeoutMs: RENDER_LIMITS.timeoutMs,
        maxOutputBytes: RENDER_LIMITS.maxOutputBytes,
        dpi: { ...DPI_RANGE },
      },
    },
    limits: {
      figure: {
        maxMultiplyAdds: MAX_MULTIPLY_ADDS,
        maxPixelsPerSource: MAX_PIXELS,
        maxAnnotations: MANIFEST_LIMITS.annotations,
        maxParts: MANIFEST_LIMITS.parts,
      },
      imagesInSpecs: { ...DEFAULT_IMAGE_LIMITS },
      imagesInAssetsCommands: { ...ASSET_LIMITS },
      manifestBytes: MAX_MANIFEST_BYTES,
    },
  };
  const summary = [
    `node ${payload.node} on ${payload.platform}`,
    `renderer (resvg): ${payload.renderer}`,
    `symlink refusal at open (O_NOFOLLOW): ${HAS_NOFOLLOW ? "yes" : "no (checked after open instead)"}`,
    `swap detection after open: ${payload.readGuard === "proc-fd" ? "/proc/self/fd path comparison (Linux)" : "directories writable by other users are refused (no /proc here); a rename race by the directory's owner stays possible"}`,
    `allowed directory for inputs and outputs: ${payload.assetsRoot}${payload.assetsRootEnv === null ? "" : ` (bounded by PCOSMO_ASSETS_ROOT=${payload.assetsRootEnv})`}`,
    ...Object.entries(tools).map(([n, t]) => `${n}: ${t.found ? t.path : "not found (optional)"}`),
    `pdf renderer (pdftoppm or mutool, for assets pdf render): ${pdfChosen === undefined ? "not found in " + toolDirs(ctx.deps.pdfRender).join(":") + " (optional; compose and extract work without it)" : (pdfTools[pdfChosen]!.path ?? pdfChosen)}`,
    `pdf limits: ${DEFAULT_PDF_LIMITS.maxFileBytes} bytes per file, ${MAX_PAGES_PER_COMMAND} pages per command, ${DEFAULT_PDF_LIMITS.maxImagePixels} px per extracted image, ${RENDER_LIMITS.timeoutMs} ms per render`,
    `limits: ${MAX_PIXELS} px per source, ${MANIFEST_LIMITS.parts} parts, ${MAX_MULTIPLY_ADDS} multiply-adds, ${ASSET_LIMITS.maxBytes} bytes per file`,
  ];
  const code = finish(ctx, flag(p, "json"), "doctor", diags, payload, [], summary);
  return code === EXIT.failed ? EXIT.internal : code;
}

const OUT = { out: { type: "string", short: "o" }, json: { type: "boolean" } } as const;

async function cropCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    ...OUT,
    rect: { type: "string" },
    transparent: { type: "boolean" },
    tolerance: { type: "string" },
    trim: { type: "boolean" },
  });
  const [file] = oneInput(p, "assets crop", 1, "one image");
  const rect = rectArg(p, "rect");
  if (!rect) throw new UsageError("assets crop needs --rect x,y,w,h");
  const out = needed(p, "out", "assets crop");
  const tolerance = num(p, "tolerance");
  const diags: Diagnostic[] = [];
  const json = flag(p, "json");
  if (!pngExt(out)) diags.push(bad("output", "-o must end in .png"));
  const img = diags.length === 0 ? await loadImage(ctx, file!, diags) : undefined;
  let cur: Raster | undefined;
  if (img) {
    const c = crop(img, rect);
    diags.push(...c.diagnostics);
    cur = c.value;
  }
  if (cur && flag(p, "transparent")) {
    const r = removeBackground(cur, tolerance === undefined ? {} : { tolerance });
    diags.push(...r.diagnostics);
    cur = r.value?.raster;
  }
  if (cur && flag(p, "trim")) {
    const t = trim(cur);
    diags.push(...t.diagnostics);
    cur = t.value;
  }
  if (!cur || hasErrors(diags)) return finish(ctx, json, "crop", diags, {}, [], []);
  const w = await writeOne(ctx, out, encodePng(cur), diags);
  return finish(ctx, json, "crop", diags, { width: cur.width, height: cur.height }, w, [
    `${cur.width}x${cur.height}`,
  ]);
}

async function cutoutCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    ...OUT,
    seed: { type: "string", multiple: true },
    polygon: { type: "string" },
    prior: { type: "string" },
    mask: { type: "string" },
    holes: { type: "boolean" },
  });
  const [file] = oneInput(p, "assets cutout", 1, "one image");
  const seeds = pointsArg(strs(p, "seed"), 32, "seed");
  if (seeds.length === 0) throw new UsageError("assets cutout needs --seed x,y[;x,y...]");
  const polygon = pointsArg(strs(p, "polygon"), 256, "polygon");
  const prior = str(p, "prior");
  if (prior !== undefined && prior !== "box" && prior !== "cylinder" && prior !== "none") {
    throw new UsageError("--prior must be box, cylinder or none");
  }
  const mask = str(p, "mask");
  if (mask !== undefined && mask !== "auto" && mask !== "rect") {
    throw new UsageError("--mask must be auto or rect");
  }
  const out = needed(p, "out", "assets cutout");
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  if (!pngExt(out)) diags.push(bad("output", "-o must end in .png"));
  const img = diags.length === 0 ? await loadImage(ctx, file!, diags) : undefined;
  if (!img) return finish(ctx, json, "cutout", diags, {}, [], []);
  const r = cutout(img, {
    seeds,
    ...(polygon.length > 0 ? { polygon } : {}),
    ...(prior ? { prior: prior as "box" | "cylinder" | "none" } : {}),
    ...(flag(p, "holes") ? { holes: true } : {}),
    ...(mask ? { mask: mask as "auto" | "rect" } : {}),
  });
  diags.push(...r.diagnostics);
  if (!r.value || hasErrors(diags)) return finish(ctx, json, "cutout", diags, {}, [], []);
  const { sprite, x, y } = r.value;
  const w = await writeOne(ctx, out, encodePng(sprite), diags);
  return finish(
    ctx,
    json,
    "cutout",
    diags,
    { x, y, width: sprite.width, height: sprite.height },
    w,
    [`sprite ${sprite.width}x${sprite.height} at ${x},${y}`],
  );
}

async function locateCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    in: { type: "string" },
    region: { type: "string" },
    top: { type: "string" },
    "min-score": { type: "string" },
    scales: { type: "string" },
  });
  const [spriteFile] = oneInput(p, "assets locate", 1, "one sprite image");
  const imageFile = needed(p, "in", "assets locate");
  const region = rectArg(p, "region");
  const top = num(p, "top");
  const minScore = num(p, "min-score");
  const scalesText = str(p, "scales");
  const scales =
    scalesText === undefined
      ? undefined
      : scalesText
          .split(",")
          .slice(0, 16)
          .map((x) => {
            const n = Number(x);
            if (x.trim() === "" || !Number.isFinite(n)) {
              throw new UsageError("--scales must be numbers separated by commas");
            }
            return n;
          });
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  const sprite = await loadImage(ctx, spriteFile!, diags, "sprite");
  const image = sprite ? await loadImage(ctx, imageFile, diags, "image") : undefined;
  if (!sprite || !image) return finish(ctx, json, "locate", diags, {}, [], []);
  const r = locate(image, sprite, {
    ...(region ? { region } : {}),
    ...(top === undefined ? {} : { top }),
    ...(minScore === undefined ? {} : { minScore }),
    ...(scales ? { scales } : {}),
  });
  diags.push(...r.diagnostics);
  if (!r.value) return finish(ctx, json, "locate", diags, {}, [], []);
  const matches = r.value.matches;
  return finish(
    ctx,
    json,
    "locate",
    diags,
    { matches, multiplyAdds: r.value.multiplyAdds },
    [],
    matches.length === 0
      ? ["no match"]
      : matches.map((m) => `x=${m.x} y=${m.y} scale=${m.scale} score=${m.score}`),
  );
}

async function alignCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    patch: { type: "string" },
    "max-shift": { type: "string" },
    "min-score": { type: "string" },
  });
  const [a, b] = oneInput(p, "assets align", 2, "two images");
  const patch = rectArg(p, "patch");
  const maxShift = num(p, "max-shift");
  const minScore = num(p, "min-score");
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  const ra = await loadImage(ctx, a!, diags, "first");
  const rb = ra ? await loadImage(ctx, b!, diags, "second") : undefined;
  if (!ra || !rb) return finish(ctx, json, "align", diags, {}, [], []);
  const r = align(ra, rb, {
    ...(patch ? { patch } : {}),
    ...(maxShift === undefined ? {} : { maxShift }),
    ...(minScore === undefined ? {} : { minScore }),
  });
  diags.push(...r.diagnostics);
  if (!r.value) return finish(ctx, json, "align", diags, {}, [], []);
  const v = r.value;
  return finish(
    ctx,
    json,
    "align",
    diags,
    { alignment: v },
    [],
    [`dx=${v.dx} dy=${v.dy} score=${v.score} support=${v.support}/${v.tried}`],
  );
}

async function shrinkCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { ...OUT, "max-px": { type: "string" }, "to-png": { type: "boolean" } });
  const [file] = oneInput(p, "assets shrink", 1, "one image");
  const maxPx = num(p, "max-px");
  if (maxPx === undefined) throw new UsageError("assets shrink needs --max-px");
  const out = needed(p, "out", "assets shrink");
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  const r = await readIn(ctx, file!, ASSET_LIMITS.maxBytes);
  if (!r.ok) {
    diags.push(readDiag(r, shown(ctx, file!)));
    return finish(ctx, json, "shrink", diags, {}, [], []);
  }
  const s = await shrinkImage(r.bytes, maxPx, { toPng: flag(p, "to-png"), limits: ASSET_LIMITS });
  diags.push(...s.diagnostics);
  if (!s.value || hasErrors(diags)) return finish(ctx, json, "shrink", diags, {}, [], []);
  const v = s.value;
  const okExt = v.format === "png" ? pngExt(out) : /\.jpe?g$/i.test(out);
  if (!okExt) {
    diags.push(
      bad("output", `the result is a ${v.format.toUpperCase()}; -o must end in its extension`),
    );
    return finish(ctx, json, "shrink", diags, {}, [], []);
  }
  const w = await writeOne(ctx, out, v.bytes, diags);
  return finish(
    ctx,
    json,
    "shrink",
    diags,
    { format: v.format, width: v.width, height: v.height, resized: v.resized },
    w,
    [`${v.width}x${v.height} ${v.format}${v.resized ? " (resized)" : ""}`],
  );
}

const FIGURE_OPTIONS = {
  json: { type: "boolean" },
  "out-dir": { type: "string", short: "d" },
  strict: { type: "boolean" },
  "figure-id": { type: "string" },
  "src-dir": { type: "string" },
  label: { type: "string" },
  "show-exclusions": { type: "boolean" },
  "source-document": { type: "string" },
  "source-page": { type: "string" },
  "source-figure": { type: "string" },
  attribution: { type: "string" },
  license: { type: "string" },
  "source-url": { type: "string" },
  "source-json": { type: "string" },
} as const;

function sourceInfo(p: Parsed): FigureSourceInfo | undefined {
  const page = num(p, "source-page");
  const info: { -readonly [K in keyof FigureSourceInfo]: FigureSourceInfo[K] } = {};
  const set = <K extends "document" | "figure" | "attribution" | "license" | "url">(
    k: K,
    opt: string,
  ): void => {
    const v = str(p, opt);
    if (v !== undefined) info[k] = v;
  };
  set("document", "source-document");
  set("figure", "source-figure");
  set("attribution", "attribution");
  set("license", "license");
  set("url", "source-url");
  if (page !== undefined) {
    if (!Number.isInteger(page) || page < 1)
      throw new UsageError("--source-page must be 1 or more");
    info.page = page;
  }
  return Object.keys(info).length === 0 ? undefined : info;
}

const SOURCE_JSON_CAPS = {
  document: 500,
  figure: 200,
  label: 200,
  attribution: 500,
  license: 200,
  url: 2048,
} as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * `--source-json <file>`: provenance read from a JSON file inside the root, so text taken from a
 * document never has to appear on a command line. Strings only (page: a positive integer), with
 * length caps and no control characters.
 */
function parseSourceJson(
  v: unknown,
  diags: Diagnostic[],
): { source: FigureSourceInfo; label?: string } | undefined {
  const fail = (m: string): undefined => {
    diags.push(bad("source-json", m));
    return undefined;
  };
  if (!isObj(v)) return fail("the source file must be a JSON object");
  const out: { -readonly [K in keyof FigureSourceInfo]: FigureSourceInfo[K] } = {};
  let label: string | undefined;
  for (const [k, val] of Object.entries(v)) {
    if (k === "page") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 100000) {
        return fail("page must be an integer from 1 to 100000");
      }
      out.page = val;
      continue;
    }
    if (!Object.hasOwn(SOURCE_JSON_CAPS, k)) {
      return fail(
        `unknown key "${k.slice(0, 40)}" (allowed: document, page, figure, label, attribution, license, url)`,
      );
    }
    const cap = SOURCE_JSON_CAPS[k as keyof typeof SOURCE_JSON_CAPS];
    if (typeof val !== "string") return fail(`${k} must be a string`);
    if (val.length > cap) return fail(`${k} is longer than ${cap} characters`);
    if (CONTROL.test(val)) return fail(`${k} contains control characters`);
    if (k === "label") label = val;
    else (out as Record<string, unknown>)[k] = val;
  }
  return { source: out, ...(label === undefined ? {} : { label }) };
}

async function figureCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, FIGURE_OPTIONS);
  const [file] = oneInput(p, "assets figure", 1, "one manifest file");
  const dir = needed(p, "out-dir", "assets figure");
  const json = flag(p, "json");
  const flagSource = sourceInfo(p);
  const figureId = str(p, "figure-id");
  const srcDir = str(p, "src-dir");
  const strict = flag(p, "strict");
  const diags: Diagnostic[] = [];
  let source = flagSource;
  let label = str(p, "label");
  const sourceFile = str(p, "source-json");
  if (sourceFile !== undefined) {
    const sj = await loadJson(ctx, sourceFile, "source-json", diags);
    const parsed = sj === undefined ? undefined : parseSourceJson(sj, diags);
    if (!parsed) return finish(ctx, json, "figure", diags, {}, [], []);
    // flags given explicitly win over the file
    source = { ...parsed.source, ...flagSource };
    label ??= parsed.label;
  }

  const manifest = await loadJson(ctx, file!, "manifest", diags);
  const sources =
    manifest === undefined ? undefined : await loadSources(ctx, manifest, file!, diags);
  if (manifest === undefined || sources === undefined) {
    return finish(ctx, json, "figure", diags, {}, [], []);
  }
  const r = runFigure(manifest, sources, {
    ...(strict ? { strict } : {}),
    ...(figureId === undefined ? {} : { figureId }),
    ...(srcDir === undefined ? {} : { dir: srcDir }),
    ...(label === undefined ? {} : { label }),
    ...(source ? { source } : {}),
  });
  diags.push(...r.diagnostics);
  if (!r.value) return finish(ctx, json, "figure", diags, {}, [], []);

  // A figure that fails the gate is never shipped (ingestion §10): then only the report and the
  // exclusion overlays are written, not base.png, sprites or fragment.json.
  const pass = r.value.report.ok && !hasErrors(diags);
  const files: { name: string; data: Uint8Array }[] = r.value.files
    .filter((f) => pass || f.name === "report.json")
    .map((f) => ({ name: f.name, data: f.bytes }));
  if (flag(p, "show-exclusions")) {
    const o = exclusionOverlay(manifest, sources, strict ? { strict } : {});
    if (!o.value) diags.push(...o.diagnostics);
    for (const state of ["exploded", "assembled"] as const) {
      const img = o.value?.[state];
      if (img) files.push({ name: `exclusions-${state}.png`, data: encodePng(img) });
    }
  }
  const written = await writeFiles(ctx, dir, files, diags);
  if (written.length > 0) {
    const abs = resolve(ctx.deps.cwd, dir);
    const stale = await staleOutputs(abs, new Set(files.map((f) => f.name)));
    if (stale.length > 0) {
      diags.push({
        severity: "warning",
        code: "asset/stale-output",
        path: "",
        message: `${relFromCwd(resolve(ctx.deps.cwd), abs)} still has files from an earlier run that this run did not write: ${stale.join(", ")}`,
        suggestion: "delete them or use a fresh directory; they are not part of this result",
        params: { files: stale },
      });
    }
  }
  const rep = r.value.report;
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.filter((d) => d.severity === "warning").length;
  return finish(
    ctx,
    json,
    "figure",
    diags,
    pass ? { report: rep, fragment: r.value.fragment } : { report: rep },
    written,
    [
      `gate: ${pass ? "pass" : "FAIL (only report.json and the overlays were written)"} (${plural(errors, "error")}, ${plural(warnings, "warning")}), confidence ${rep.confidence}`,
    ],
    pass,
  );
}

async function checkCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    "out-dir": { type: "string", short: "d" },
    strict: { type: "boolean" },
  });
  const [file] = oneInput(p, "assets check", 1, "one manifest file");
  const dir = needed(p, "out-dir", "assets check");
  const json = flag(p, "json");
  const strict = flag(p, "strict");
  const diags: Diagnostic[] = [];

  const manifest = await loadJson(ctx, file!, "manifest", diags);
  const sources =
    manifest === undefined ? undefined : await loadSources(ctx, manifest, file!, diags);
  if (manifest === undefined || sources === undefined) {
    return finish(ctx, json, "check", diags, {}, [], []);
  }
  const root = resolve(ctx.deps.cwd, dir);
  if (!(await insideAssetsRoot(assetsRoot(ctx), root))) {
    diags.push(
      readDiag(
        { ok: false, code: "image/unsafe-path", message: outsideRoot(ctx), suggestion: ROOT_HINT },
        shown(ctx, dir),
      ),
    );
    return finish(ctx, json, "check", diags, {}, [], []);
  }
  const fr = await readFileSafe(root, "fragment.json", MAX_MANIFEST_BYTES);
  if (!fr.ok) {
    diags.push(readDiag(fr, `${shown(ctx, dir)}/fragment.json`));
    return finish(ctx, json, "check", diags, {}, [], []);
  }
  let fragment: unknown;
  try {
    fragment = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fr.bytes));
  } catch {
    diags.push(bad("outputs", "fragment.json is not valid JSON"));
    return finish(ctx, json, "check", diags, {}, [], []);
  }
  // Only the fixed names `assets figure` writes are read; a `src` in the fragment selects among
  // them by its last path segment and can never point elsewhere.
  const images: Record<string, Raster> = {};
  const list =
    isObj(fragment) && Array.isArray(fragment.images) ? (fragment.images as unknown[]) : [];
  if (list.length > 65) {
    diags.push(bad("outputs", "the fragment has too many images"));
    return finish(ctx, json, "check", diags, {}, [], []);
  }
  const byName = new Map<string, Raster>();
  // `src` must be exactly "<figure dir>/<fixed name>": one shared, plain directory prefix (what
  // `--src-dir` wrote) and a fixed name, each name once.
  let prefix: string | undefined;
  const seen = new Set<string>();
  for (const im of list) {
    if (!isObj(im) || typeof im.src !== "string") continue;
    const cut = im.src.lastIndexOf("/") + 1;
    const name = im.src.slice(cut);
    const here = im.src.slice(0, cut);
    prefix ??= here;
    const plainPrefix =
      here === "" ||
      (here.length <= 256 &&
        here
          .slice(0, -1)
          .split("/")
          .every((x) => /^[A-Za-z0-9._-]+$/.test(x) && x !== "." && x !== ".."));
    if (!FIXED_OUTPUT.test(name) || !plainPrefix || here !== prefix || seen.has(name)) {
      diags.push({
        severity: "error",
        code: "image/unsafe-path",
        path: "",
        message: `fragment image "${im.src.slice(0, 80)}" is not "<figure dir>/base.png" or "<figure dir>/sprite-N.png" (one shared plain directory, each name once)`,
      });
      continue;
    }
    seen.add(name);
    let raster = byName.get(name);
    if (!raster) {
      const r = await readFileSafe(root, name, ASSET_LIMITS.maxBytes);
      if (!r.ok) {
        diags.push(readDiag(r, `${shown(ctx, dir)}/${name}`));
        continue;
      }
      const d = await decodeImage(r.bytes, { limits: ASSET_LIMITS, key: name });
      diags.push(...d.diagnostics);
      if (!d.value) continue;
      raster = d.value.raster;
      byName.set(name, raster);
    }
    Object.defineProperty(images, im.src, { value: raster, enumerable: true });
  }
  if (hasErrors(diags)) return finish(ctx, json, "check", diags, {}, [], []);
  const outputs = outputsFromFragment(fragment, images);
  diags.push(...outputs.diagnostics);
  if (!outputs.value) return finish(ctx, json, "check", diags, {}, [], []);
  const r = checkFigure(manifest, sources, outputs.value, strict ? { strict } : {});
  diags.push(...r.diagnostics);
  if (!r.value) return finish(ctx, json, "check", diags, {}, [], []);
  const errors = diags.filter((d) => d.severity === "error").length;
  return finish(
    ctx,
    json,
    "check",
    diags,
    { report: r.value },
    [],
    [`gate: ${r.value.ok && errors === 0 ? "pass" : "FAIL"} (confidence ${r.value.confidence})`],
    r.value.ok,
  );
}

/** Prints the figure manifest schema (the plugin skill reads it from here). */
function schemaCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {});
  oneInput(p, "assets schema", 0, "no arguments");
  ctx.out(`${JSON.stringify(schema, null, 2)}\n`);
  return Promise.resolve(EXIT.ok);
}

const SUBCOMMANDS: Readonly<Record<string, (ctx: Ctx, args: string[]) => Promise<number>>> = {
  doctor,
  schema: schemaCmd,
  crop: cropCmd,
  cutout: cutoutCmd,
  locate: locateCmd,
  align: alignCmd,
  figure: figureCmd,
  check: checkCmd,
  shrink: shrinkCmd,
  pdf: pdfCommand,
};

export async function assetsCommand(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) throw new UsageError("assets needs a command");
  const run = Object.hasOwn(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined;
  if (!run) throw new UsageError(`unknown assets command "${sub}"`);
  // --root <dir> (any command): where inputs and outputs may live. Default: the working directory.
  const args2: string[] = [];
  let rootArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--root") {
      rootArg = rest[++i];
      if (rootArg === undefined || rootArg === "") throw new UsageError("--root needs a directory");
    } else if (a.startsWith("--root=")) {
      rootArg = a.slice(7);
      if (rootArg === "") throw new UsageError("--root needs a directory");
    } else args2.push(a);
  }
  const cwd = resolve(ctx.deps.cwd);
  const eff = rootArg === undefined ? cwd : resolve(cwd, rootArg);
  const outer = ctx.deps.env.PCOSMO_ASSETS_ROOT;
  if (outer !== undefined && outer !== "" && !(await insideAssetsRoot(outer, eff))) {
    const diag: Diagnostic = {
      severity: "error",
      code: "asset/unsafe-path",
      path: "",
      message: `the allowed directory ${relFromCwd(cwd, eff)} is outside PCOSMO_ASSETS_ROOT`,
      suggestion: "PCOSMO_ASSETS_ROOT is the outer bound; --root cannot leave it",
    };
    return finish(ctx, rest.includes("--json"), sub, [diag], {}, [], []);
  }
  return run({ ...ctx, assetsRoot: eff }, args2);
}
