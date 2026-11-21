/**
 * `pcosmo assets pdf info|list|extract|compose|render|text` (ingestion §3). The PDF is untrusted:
 * it is read through the same path guard as every other input (`readIn`), parsed by
 * `@platformcosmo/pdf` (bytes in, plain data and diagnostics out), and every output goes through
 * `writeFiles` (temp directory, `O_EXCL|O_NOFOLLOW`, rename). File names are built from integers
 * (`p<page>-i<index>.png|jpg`, `manifest.json`), never from anything in the PDF. Text from the
 * PDF (`text`, the producer string, font names) is data: control characters are replaced and JSON
 * output is escaped. The optional external renderer lives in `../pdftool.ts`.
 *
 * Nothing throws out of a command: every refusal is a diagnostic plus an exit code. Work is
 * bounded before it starts: pages per command, files and bytes written, canvas pixels, images
 * composed, runs printed.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic } from "@platformcosmo/core";
import {
  MAX_PIXELS,
  crop,
  decodeImage,
  encodePng,
  stableStringify,
  type Raster,
} from "@platformcosmo/assets";
import {
  DEFAULT_LIMITS,
  openPdf,
  type PdfDiagnostic,
  type PdfDocument,
  type PdfImage,
} from "@platformcosmo/pdf";
import { type Parsed, flag, parse, str } from "../args.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { stripControl } from "../format.js";
import { staleOutputs, relFromCwd } from "../outputs.js";
import {
  DPI_RANGE,
  RENDER_LIMITS,
  renderSize,
  toolDirs,
  TOOL_NAMES,
  pickTool,
  renderPage,
  type ToolName,
} from "../pdftool.js";
import {
  COMPOSE_WORK_BUDGET,
  annotateRaster,
  canvasSize,
  composeRaster,
  composeSvg,
  type Box,
  type Mat,
  type Marker,
  type RasterPlacement,
  type SvgImage,
  type SvgSource,
  type View,
} from "../pdfcompose.js";
import {
  assetsRoot,
  bad,
  finish,
  needed,
  oneInput,
  readDiag,
  readIn,
  shown,
  writeFiles,
  writeOne,
  type Written,
} from "./assets-io.js";

/** Pages one command works on (list, extract --all). */
export const MAX_PAGES_PER_COMMAND = 1000;
/** Images listed in one `list`. */
const MAX_LISTED_IMAGES = 20_000;
/** Files and bytes written by `extract --all`. */
const MAX_EXTRACT_FILES = 1000;
const MAX_EXTRACT_BYTES = 128 * 1024 * 1024;
/** Manifest entries (placements) written by one `extract --all`. */
/** (an object so a test can lower the caps) */
export const manifestLimits = { entries: 100_000, bytes: 32 * 1024 * 1024 };
/** `compose`: placements painted, source bytes embedded in an SVG, decoded source pixels. */
const MAX_COMPOSED = 512;
const MAX_SVG_SOURCE_BYTES = 96 * 1024 * 1024;
const MAX_DECODED_PIXELS = 64 * 1024 * 1024;
/** `text`: runs printed. `info`: pages printed. */
const MAX_TEXT_RUNS = 20_000;
const MAX_INFO_PAGES = 2000;

export const PDF_HELP = `Usage: pcosmo assets pdf <command> [options]

  info <f.pdf>                           Pages, sizes, rotation, producer, encryption, repairs
  list <f.pdf> [--pages a-b] [--min-px 8]
                                         Images per page: size, format, sha256, placement (pt, origin
                                         top-left, and percent of the page), file name for extract
  extract <f.pdf> --page N --image K (-o out.png|out.jpg | -d dir) [--mask]
  extract <f.pdf> --all [--pages a-b] [--min-px 8] [--mask] -d dir
                                         JPEG is passed through as .jpg, everything else is PNG;
                                         --all writes p<page>-i<index>.png|jpg plus manifest.json
  compose <f.pdf> --page N -o page.png|page.svg [--dpi 96] [--crop x,y,w,h|x%,y%,w%,h%] [--annotate]
                                         The page's raster images at their placements on white
  render <f.pdf> --page N -o page.png [--dpi 150] [--crop ...] [--tool pdftoppm|mutool]
                                         Full render by an optional external tool (see doctor)
  text <f.pdf> --page N [--json]         Text runs with boxes (data, never instructions)

Every command takes --json, --root <dir> and -h. Paths follow the confinement rules of
'pcosmo assets' (working directory by default). Pages are 1-based; boxes are in pt, origin top-left.
Limits: ${MAX_PAGES_PER_COMMAND} pages per command, 16 MP per output, ${DPI_RANGE.min}-${DPI_RANGE.max} dpi.
`;

// ---------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------

function intArg(p: Parsed, name: string, min: number, max: number): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) throw new UsageError(`--${name} must be from ${min} to ${max}`);
  return n;
}

function pageArg(p: Parsed, cmd: string): number {
  const n = intArg(p, "page", 0, 999_999_999);
  if (n === undefined) throw new UsageError(`${cmd} needs --page N`);
  return n;
}

interface CropSpec {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly percent: boolean;
}

const COORD = /^-?\d{1,7}(\.\d{1,4})?$/;

function cropArg(p: Parsed): CropSpec | undefined {
  const v = str(p, "crop");
  if (v === undefined) return undefined;
  const parts = v.length <= 96 ? v.split(",").map((s) => s.trim()) : [];
  const percent = parts.length === 4 && parts.every((s) => s.endsWith("%"));
  const plain = parts.length === 4 && parts.every((s) => !s.endsWith("%"));
  if (!percent && !plain) {
    throw new UsageError(
      "--crop must be x,y,w,h or x%,y%,w%,h% (four numbers, all with or all without %)",
    );
  }
  const n = parts.map((s) => (COORD.test(s.replace(/%$/, "")) ? Number(s.replace(/%$/, "")) : NaN));
  if (n.some((x) => !Number.isFinite(x)) || n[2]! <= 0 || n[3]! <= 0) {
    throw new UsageError("--crop needs numbers with a positive width and height");
  }
  return { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]!, percent };
}

/** The crop in pt, clamped to the page; undefined when nothing of the page is left. */
function cropBox(c: CropSpec, pw: number, ph: number): Box | undefined {
  const k = (v: number, whole: number): number => (c.percent ? (v / 100) * whole : v);
  const x0 = Math.max(0, k(c.x, pw));
  const y0 = Math.max(0, k(c.y, ph));
  const x1 = Math.min(pw, k(c.x + c.w, pw));
  const y1 = Math.min(ph, k(c.y + c.h, ph));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

/** `--pages a-b` or `N`: a validated range (inclusive), at most MAX_PAGES_PER_COMMAND pages. */
function pagesRange(
  p: Parsed,
  pageCount: number,
  diags: Diagnostic[],
): { from: number; to: number } | undefined {
  const v = str(p, "pages");
  if (pageCount === 0) return { from: 1, to: 0 };
  if (v === undefined) {
    if (pageCount > MAX_PAGES_PER_COMMAND) {
      diags.push({
        severity: "warning",
        code: "pdf/too-large",
        path: "",
        message: `the document has ${pageCount} pages; only the first ${MAX_PAGES_PER_COMMAND} are processed`,
        suggestion: "pass --pages a-b for other pages",
        params: { page: null, image: null, bbox: null, pageCount, limit: MAX_PAGES_PER_COMMAND },
      });
    }
    return { from: 1, to: Math.min(pageCount, MAX_PAGES_PER_COMMAND) };
  }
  const m = /^(\d{1,9})(?:-(\d{1,9}))?$/.exec(v);
  if (!m) throw new UsageError("--pages must be N or a-b (whole numbers)");
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw new UsageError("--pages a-b needs a <= b");
  if (from < 1 || to > pageCount) {
    diags.push({
      severity: "error",
      code: "pdf/bad-page",
      path: "",
      message: `pages ${from}-${to} are not all in the document (it has ${pageCount} pages)`,
      params: { page: null, image: null, bbox: null, pageCount },
    });
    return undefined;
  }
  if (to - from + 1 > MAX_PAGES_PER_COMMAND) {
    diags.push({
      ...bad("pages", `at most ${MAX_PAGES_PER_COMMAND} pages per command`),
      suggestion: "split the range",
    });
    return undefined;
  }
  return { from, to };
}

// ---------------------------------------------------------------------------------------------
// reading and reporting
// ---------------------------------------------------------------------------------------------

/** Text that came from the PDF, as data: no control or bidi characters, bounded. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Variation_Selector}]/gu;
/** NFC-normalised, unsafe characters replaced, cut to `max` code points (never inside a pair). */
export const clean = (s: string, max = 400): string => {
  const t = s.normalize("NFC").replace(UNSAFE, "\ufffd");
  return t.length <= max ? t : [...t].slice(0, max).join("");
};

/** `clean` over every string in a parsed value (arrays and objects, depth-limited). */
export function cleanDeep<T>(v: T, depth = 0): T {
  if (typeof v === "string") return clean(v, 600) as T;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => cleanDeep(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v).slice(0, 200)) out[clean(k, 80)] = cleanDeep(x, depth + 1);
  return out as T;
}

/** A parser diagnostic as a CLI diagnostic (message and params cleaned). */
function pdfDiag(d: PdfDiagnostic): Diagnostic {
  return {
    severity: d.severity,
    code: d.code,
    path: d.path,
    message: clean(stripControl(d.message), 600),
    ...(d.suggestion === undefined ? {} : { suggestion: d.suggestion }),
    params: cleanDeep(d.params as Record<string, unknown>),
  };
}

const manifestBytes = (entries: readonly Record<string, unknown>[]): number =>
  entries.reduce((n, e) => n + JSON.stringify(e).length + 2, 0);

/** One dedupe set per command (keyed by its diagnostics array). */
const seenByCommand = new WeakMap<Diagnostic[], Set<string>>();

/** Adds parser diagnostics without repeating one that is already there. */
function addPdf(diags: Diagnostic[], list: readonly PdfDiagnostic[]): void {
  let seen = seenByCommand.get(diags);
  if (!seen) seenByCommand.set(diags, (seen = new Set()));
  for (const d of list) {
    const x = pdfDiag(d);
    const key = `${x.code}|${x.message}|${JSON.stringify(x.params ?? null)}`;
    if (!seen.has(key)) {
      seen.add(key);
      diags.push(x);
    }
  }
}

/** Diagnostics printed by one command (a thousand-page listing can produce thousands). */
export const MAX_DIAGNOSTICS = 200;

/** `finish` with the diagnostics capped: errors first, then warnings, then info, in order. */
function fin(
  ctx: Ctx,
  json: boolean,
  command: string,
  diags: readonly Diagnostic[],
  payload: Record<string, unknown>,
  written: readonly Written[],
  summary: string[],
): number {
  let list = diags;
  if (diags.length > MAX_DIAGNOSTICS) {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const kept = diags
      .map((d, i) => ({ d, i }))
      .sort((a, b) => rank[a.d.severity] - rank[b.d.severity] || a.i - b.i)
      .slice(0, MAX_DIAGNOSTICS)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.d);
    list = [
      ...kept,
      {
        severity: "warning",
        code: "pdf/too-large",
        path: "",
        message: `${diags.length - kept.length} further diagnostics are not shown`,
        suggestion: "narrow --pages",
        params: { page: null, image: null, bbox: null, omitted: diags.length - kept.length },
      },
    ];
  }
  return finish(ctx, json, command, list, payload, written, summary);
}

interface Opened {
  readonly doc: PdfDocument;
  readonly bytes: Uint8Array;
}

/** Reads the PDF through the path guard and opens it. Problems become diagnostics. */
async function openInput(ctx: Ctx, path: string, diags: Diagnostic[]): Promise<Opened | undefined> {
  const r = await readIn(ctx, path, DEFAULT_LIMITS.maxFileBytes);
  if (!r.ok) {
    diags.push(readDiag(r, shown(ctx, path)));
    return undefined;
  }
  const o = openPdf(r.bytes);
  addPdf(diags, o.diagnostics);
  if (!o.ok) return undefined;
  return { doc: o.doc, bytes: r.bytes };
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const extOf = (format: PdfImage["format"]): "png" | "jpg" | undefined =>
  format === "jpeg" ? "jpg" : format === "png" ? "png" : undefined;
/** The file name for an image: built from integers and a fixed extension only. */
const fileName = (page: number, index: number, ext: string, mask = false): string =>
  `p${Math.trunc(page)}-i${Math.trunc(index)}${mask ? "-mask" : ""}.${ext}`;
const NAME_PATTERN = /^p[1-9][0-9]{0,8}-i[0-9]{1,9}(-mask)?\.(png|jpg)$|^manifest\.json$/;

const boxText = (b: { x: number; y: number; w: number; h: number }): string =>
  `${b.x},${b.y} ${b.w}x${b.h}`;

// ---------------------------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------------------------

async function infoCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { json: { type: "boolean" } });
  const [file] = oneInput(p, "assets pdf info", 1, "one PDF");
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  const o = await openInput(ctx, file!, diags);
  if (!o) return fin(ctx, json, "pdf info", diags, {}, [], []);
  const info = o.doc.info();
  addPdf(diags, info.diagnostics);
  const pages = info.pages.slice(0, MAX_INFO_PAGES);
  const payload = {
    pdf: {
      version: info.version,
      pageCount: info.pageCount,
      pages,
      pagesTruncated: info.pages.length > pages.length,
      producer: info.producer === null ? null : clean(info.producer),
      encryption: cleanDeep(info.encryption),
      repaired: info.repaired,
    },
  };
  const summary = [
    `PDF ${info.version ?? "?"}, ${info.pageCount} page${info.pageCount === 1 ? "" : "s"}${info.repaired ? " (repaired)" : ""}`,
    `producer: ${info.producer === null ? "-" : JSON.stringify(clean(info.producer))}`,
    ...(info.encryption === null
      ? []
      : [`encryption: ${JSON.stringify(cleanDeep(info.encryption))}`]),
    ...pages.map(
      (g) =>
        `page ${g.page}: ${g.width} x ${g.height} pt${g.rotate ? `, rotated ${g.rotate}` : ""}`,
    ),
    ...(payload.pdf.pagesTruncated ? [`(first ${MAX_INFO_PAGES} pages shown)`] : []),
  ];
  return fin(ctx, json, "pdf info", diags, payload, [], summary);
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

function imageRecord(img: PdfImage): Record<string, unknown> {
  const ext = extOf(img.format);
  return {
    page: img.page,
    index: img.index,
    file: ext === undefined ? null : fileName(img.page, img.index, ext),
    width: img.width,
    height: img.height,
    format: img.format,
    filters: img.filters.map((f) => clean(f, 40)),
    colourSpace: img.colourSpace === null ? null : clean(img.colourSpace, 80),
    bitsPerComponent: img.bitsPerComponent,
    components: img.components,
    hasAlpha: img.hasAlpha,
    imageMask: img.imageMask,
    inline: img.inline,
    object: img.object,
    withinCaps: img.withinCaps,
    sha256: img.sha256,
    bbox: img.bbox,
    bboxPercent: img.bboxPercent,
    matrix: img.matrix,
  };
}

async function listCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    pages: { type: "string" },
    "min-px": { type: "string" },
  });
  const [file] = oneInput(p, "assets pdf list", 1, "one PDF");
  const minPx = intArg(p, "min-px", 0, 16384) ?? 8;
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  const o = await openInput(ctx, file!, diags);
  if (!o) return fin(ctx, json, "pdf list", diags, {}, [], []);
  const range = pagesRange(p, o.doc.pageCount, diags);
  if (!range) return fin(ctx, json, "pdf list", diags, {}, [], []);
  const pages: { page: number; images: Record<string, unknown>[]; hiddenSmall: number }[] = [];
  const lines: string[] = [];
  let total = 0;
  let stopped = false;
  for (let pg = range.from; pg <= range.to && !stopped; pg++) {
    const l = o.doc.listImages(pg, { hash: true });
    addPdf(diags, l.diagnostics);
    const images: Record<string, unknown>[] = [];
    let hiddenSmall = 0;
    for (const img of l.images) {
      if (Math.min(img.width, img.height) < minPx) {
        hiddenSmall++;
        continue;
      }
      if (total >= MAX_LISTED_IMAGES) {
        stopped = true;
        diags.push({
          severity: "warning",
          code: "pdf/too-large",
          path: "",
          message: `listing stopped after ${MAX_LISTED_IMAGES} images`,
          suggestion: "narrow --pages or raise --min-px",
          params: { page: pg, image: null, bbox: null, limit: MAX_LISTED_IMAGES },
        });
        break;
      }
      total++;
      images.push(imageRecord(img));
      lines.push(
        `p${img.page} i${img.index}  ${img.width}x${img.height}  ${img.format}  ${img.colourSpace === null ? "-" : clean(img.colourSpace, 40)} ${img.bitsPerComponent}bpc${img.hasAlpha ? " alpha" : ""}  at ${boxText(img.bbox)} pt  ${img.sha256 === null ? "no-hash" : img.sha256.slice(0, 12)}${extOf(img.format) ? `  ${fileName(img.page, img.index, extOf(img.format)!)}` : ""}`,
      );
    }
    pages.push({ page: pg, images, hiddenSmall });
  }
  const summary = [
    ...lines,
    `${total} image${total === 1 ? "" : "s"} on ${pages.length} page${pages.length === 1 ? "" : "s"}`,
  ];
  return fin(ctx, json, "pdf list", diags, { minPx, pages }, [], summary);
}

// ---------------------------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------------------------

async function extractCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    out: { type: "string", short: "o" },
    dir: { type: "string", short: "d" },
    page: { type: "string" },
    image: { type: "string" },
    all: { type: "boolean" },
    pages: { type: "string" },
    "min-px": { type: "string" },
    mask: { type: "boolean" },
  });
  const [file] = oneInput(p, "assets pdf extract", 1, "one PDF");
  const json = flag(p, "json");
  const mask = flag(p, "mask");
  const all = flag(p, "all");
  const out = str(p, "out");
  const dir = str(p, "dir");
  if (all) {
    if (str(p, "page") !== undefined || str(p, "image") !== undefined || out !== undefined) {
      throw new UsageError("--all takes --pages and -d, not --page, --image or -o");
    }
    if (dir === undefined || dir === "")
      throw new UsageError("assets pdf extract --all needs -d <dir>");
  } else {
    if (str(p, "pages") !== undefined || str(p, "min-px") !== undefined) {
      throw new UsageError("--pages and --min-px belong to --all");
    }
    if ((out === undefined) === (dir === undefined)) {
      throw new UsageError("assets pdf extract needs exactly one of -o <file> or -d <dir>");
    }
  }
  const page = all ? 0 : pageArg(p, "assets pdf extract");
  const image = all ? 0 : (intArg(p, "image", 0, 999_999_999) ?? -1);
  if (!all && image < 0) throw new UsageError("assets pdf extract needs --image K (or --all)");
  const minPx = intArg(p, "min-px", 0, 16384) ?? 8;

  const diags: Diagnostic[] = [];
  const o = await openInput(ctx, file!, diags);
  if (!o) return fin(ctx, json, "pdf extract", diags, {}, [], []);

  if (!all) {
    const r = o.doc.extractImage(page, image, { mask });
    addPdf(diags, r.diagnostics);
    if (!r.ok || r.image === null) return fin(ctx, json, "pdf extract", diags, {}, [], []);
    const ext = mask ? "png" : r.image.format === "jpeg" ? "jpg" : "png";
    let written: Written[];
    if (out !== undefined) {
      const want = /\.(png|jpe?g)$/i.exec(out)?.[1]?.toLowerCase();
      const have = ext === "jpg" ? "jpg" : "png";
      if (want === undefined || (want === "png" ? "png" : "jpg") !== have) {
        diags.push({
          ...bad(
            "output",
            `the image is ${ext === "jpg" ? "a JPEG" : "a PNG"}; -o must end in .${have}`,
          ),
          suggestion: `use -o name.${have}, or -d <dir> for the standard name ${fileName(page, image, ext, mask)}`,
        });
        return fin(ctx, json, "pdf extract", diags, {}, [], []);
      }
      written = await writeOne(ctx, out, r.image.bytes, diags);
    } else {
      written = await writeFiles(
        ctx,
        dir!,
        [{ name: fileName(page, image, ext, mask), data: r.image.bytes }],
        diags,
      );
    }
    const info = {
      page,
      image,
      mask,
      format: r.image.format,
      width: r.image.width,
      height: r.image.height,
      sha256: r.image.sha256,
    };
    return fin(ctx, json, "pdf extract", diags, info, written, [
      `${r.image.format} ${r.image.width}x${r.image.height} sha256 ${r.image.sha256.slice(0, 12)}`,
    ]);
  }

  // --all
  const range = pagesRange(p, o.doc.pageCount, diags);
  if (!range) return fin(ctx, json, "pdf extract", diags, {}, [], []);
  const files: { name: string; data: Uint8Array }[] = [];
  const entries: Record<string, unknown>[] = [];
  const byHash = new Map<string, string>();
  const byObject = new Map<number, { name: string; sha: string }>();
  let bytes = 0;
  let stop = false;
  const limitDiag = (pg: number, what: string): void => {
    stop = true;
    diags.push({
      severity: "warning",
      code: "pdf/too-large",
      path: "",
      message: `extraction stopped at page ${pg}: ${what}`,
      suggestion: "use --pages a-b to extract the rest in another directory",
      params: { page: pg, image: null, bbox: null },
    });
  };
  for (let pg = range.from; pg <= range.to && !stop; pg++) {
    const l = o.doc.listImages(pg, { hash: false });
    addPdf(diags, l.diagnostics);
    for (const img of l.images) {
      if (stop) break;
      if (entries.length >= manifestLimits.entries) {
        limitDiag(pg, `more than ${manifestLimits.entries} manifest entries`);
        break;
      }
      const ext = mask ? "png" : extOf(img.format);
      if (ext === undefined || !img.withinCaps || img.format === "unsupported") continue;
      if (Math.min(img.width, img.height) < minPx) continue;
      if (mask && !img.hasAlpha && !img.imageMask) continue;
      const known = img.object === null ? undefined : byObject.get(img.object);
      let name: string;
      let digest: string;
      let duplicate = false;
      if (known) {
        ({ name, digest } = { name: known.name, digest: known.sha });
        duplicate = true;
      } else {
        const r = o.doc.extractImage(pg, img.index, { mask });
        addPdf(diags, r.diagnostics);
        if (!r.ok || r.image === null) continue;
        digest = r.image.sha256;
        const same = byHash.get(digest);
        if (same !== undefined) {
          name = same;
          duplicate = true;
        } else {
          if (files.length >= MAX_EXTRACT_FILES) {
            limitDiag(pg, `more than ${MAX_EXTRACT_FILES} images`);
            break;
          }
          if (bytes + r.image.bytes.length > MAX_EXTRACT_BYTES) {
            limitDiag(pg, `more than ${MAX_EXTRACT_BYTES} bytes of images`);
            break;
          }
          name = fileName(pg, img.index, ext, mask);
          files.push({ name, data: r.image.bytes });
          bytes += r.image.bytes.length;
          byHash.set(digest, name);
        }
        if (img.object !== null) byObject.set(img.object, { name, sha: digest });
      }
      entries.push({
        page: pg,
        index: img.index,
        file: name,
        duplicate,
        width: img.width,
        height: img.height,
        sha256: digest,
        bbox: img.bbox,
        bboxPercent: img.bboxPercent,
      });
    }
  }
  if (!stop && manifestBytes(entries) > manifestLimits.bytes) {
    // entries are small and bounded in number; this is the byte backstop
    entries.length = 0;
    files.length = 0;
    diags.push({
      severity: "error",
      code: "pdf/too-large",
      path: "",
      message: `manifest.json would be over ${manifestLimits.bytes} bytes`,
      suggestion: "use --pages a-b to extract in smaller parts",
      params: { page: null, image: null, bbox: null },
    });
  }
  const manifest = {
    schema: "pcosmo-pdf-extract/1",
    pdfSha256: sha(o.bytes),
    pages: [range.from, range.to],
    mask,
    images: entries,
  };
  files.push({ name: "manifest.json", data: new TextEncoder().encode(stableStringify(manifest)) });
  let written: Written[] = [];
  if (!diags.some((d) => d.severity === "error")) {
    written = await writeFiles(ctx, dir!, files, diags);
    if (written.length > 0) {
      const stale = await staleOutputs(
        resolve(ctx.deps.cwd, dir!),
        new Set(files.map((f) => f.name)),
        NAME_PATTERN,
      );
      if (stale.length > 0) {
        diags.push({
          severity: "warning",
          code: "asset/stale-output",
          path: "",
          message: `${relFromCwd(resolve(ctx.deps.cwd), resolve(ctx.deps.cwd, dir!))} still has files from an earlier run that this run did not write: ${stale.slice(0, 20).join(", ")}`,
          suggestion: "delete them or use a fresh directory; they are not listed in manifest.json",
          params: { files: stale.slice(0, 100) },
        });
      }
    }
  }
  return fin(
    ctx,
    json,
    "pdf extract",
    diags,
    { extracted: files.length - 1, placements: entries.length, bytes },
    written,
    [
      `${entries.length} placement${entries.length === 1 ? "" : "s"}, ${files.length - 1} file${files.length === 2 ? "" : "s"}, manifest.json`,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------------------------

/** The view (page region and scale) for compose and render, or a diagnostic. */
function viewFor(
  doc: PdfDocument,
  page: number,
  dpi: number,
  c: CropSpec | undefined,
  diags: Diagnostic[],
): View | undefined {
  const pg = doc.info().pages[page - 1];
  if (!pg) {
    diags.push({
      severity: "error",
      code: "pdf/bad-page",
      path: "",
      message: `page ${page} does not exist (the document has ${doc.pageCount} pages)`,
      params: { page, image: null, bbox: null },
    });
    return undefined;
  }
  const box =
    c === undefined ? { x: 0, y: 0, w: pg.width, h: pg.height } : cropBox(c, pg.width, pg.height);
  if (!box) {
    diags.push({
      ...bad("crop", `--crop lies outside the page (${pg.width} x ${pg.height} pt)`),
      params: { option: "crop", page, image: null, bbox: null },
    });
    return undefined;
  }
  return { ...box, scale: dpi / 72 };
}

const tooBig = (page: number, w: number, h: number, dpi: number): Diagnostic => ({
  severity: "error",
  code: "pdf/too-large",
  path: "",
  message: `the output would be about ${w}x${h} px at ${dpi} dpi, over the ${MAX_PIXELS} pixel (16 MP) limit`,
  suggestion: "lower --dpi or use --crop",
  params: { page, image: null, bbox: null, dpi },
});

async function composeCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    out: { type: "string", short: "o" },
    page: { type: "string" },
    dpi: { type: "string" },
    crop: { type: "string" },
    annotate: { type: "boolean" },
  });
  const [file] = oneInput(p, "assets pdf compose", 1, "one PDF");
  const page = pageArg(p, "assets pdf compose");
  const out = needed(p, "out", "assets pdf compose");
  const dpi = intArg(p, "dpi", DPI_RANGE.min, DPI_RANGE.max) ?? 96;
  const c = cropArg(p);
  const annotate = flag(p, "annotate");
  const json = flag(p, "json");
  const kind = /\.png$/i.test(out) ? "png" : /\.svg$/i.test(out) ? "svg" : undefined;
  const diags: Diagnostic[] = [];
  if (kind === undefined) diags.push(bad("output", "-o must end in .png or .svg"));
  const o = diags.length === 0 ? await openInput(ctx, file!, diags) : undefined;
  if (!o) return fin(ctx, json, "pdf compose", diags, {}, [], []);
  const view = viewFor(o.doc, page, dpi, c, diags);
  if (!view) return fin(ctx, json, "pdf compose", diags, {}, [], []);
  const size = canvasSize(view);
  if (kind === "png" && !size) {
    diags.push(tooBig(page, Math.ceil(view.w * view.scale), Math.ceil(view.h * view.scale), dpi));
    return fin(ctx, json, "pdf compose", diags, {}, [], []);
  }

  const list = o.doc.listImages(page, { hash: false });
  addPdf(diags, list.diagnostics);
  const markers: Marker[] = annotate
    ? list.images.slice(0, MAX_COMPOSED).map((i) => ({ index: i.index, bbox: i.bbox }))
    : [];
  // Sources: one entry per distinct XObject (inline images are their own).
  const keyOf = (i: PdfImage): string => (i.object === null ? `i${i.index}` : `o${i.object}`);
  const rasters = new Map<string, Raster | null>();
  const sources = new Map<string, number>();
  const svgSources: SvgSource[] = [];
  const rasterPlacements: RasterPlacement[] = [];
  const svgImages: SvgImage[] = [];
  let svgBytes = 0;
  let decoded = 0;
  let composed = 0;
  let stopped = false;
  const stopDiag = (img: PdfImage, why: string): void => {
    stopped = true;
    diags.push({
      severity: "warning",
      code: "pdf/too-large",
      path: "",
      message: `compose stopped before image ${img.index}: ${why}`,
      suggestion: "use --crop, a lower --dpi or extract the images separately",
      params: { page, image: img.index, bbox: img.bbox },
    });
  };
  for (const img of list.images) {
    if (stopped) break;
    if (img.format === "unsupported" || !img.withinCaps) continue; // list already warned
    if (composed >= MAX_COMPOSED) {
      stopDiag(img, `more than ${MAX_COMPOSED} placements`);
      break;
    }
    const key = keyOf(img);
    if (kind === "png") {
      if (!rasters.has(key)) {
        if (decoded + img.width * img.height > MAX_DECODED_PIXELS) {
          stopDiag(img, "the decoded source images are too large together");
          break;
        }
        decoded += img.width * img.height;
        const r = o.doc.extractImage(page, img.index, {});
        addPdf(diags, r.diagnostics);
        let raster: Raster | null = null;
        if (r.ok && r.image) {
          const d = await decodeImage(r.image.bytes, { key: `image ${img.index}` });
          diags.push(
            ...d.diagnostics.map((x) => ({
              ...x,
              severity: x.severity === "error" ? ("warning" as const) : x.severity,
            })),
          );
          raster = d.value?.raster ?? null;
        }
        rasters.set(key, raster);
      }
      const raster = rasters.get(key);
      if (raster) {
        rasterPlacements.push({ raster, matrix: img.matrix as Mat });
        composed++;
      }
    } else {
      let idx = sources.get(key);
      if (idx === undefined) {
        const r = o.doc.extractImage(page, img.index, {});
        addPdf(diags, r.diagnostics);
        if (!r.ok || !r.image) continue;
        if (svgBytes + r.image.bytes.length > MAX_SVG_SOURCE_BYTES) {
          stopDiag(img, "the embedded images are too large together");
          break;
        }
        svgBytes += r.image.bytes.length;
        idx = svgSources.length;
        svgSources.push({
          mime: r.image.format === "jpeg" ? "image/jpeg" : "image/png",
          bytes: r.image.bytes,
        });
        sources.set(key, idx);
      }
      svgImages.push({ source: idx, matrix: img.matrix as Mat });
      composed++;
    }
  }
  let data: Uint8Array;
  if (kind === "png") {
    const res = composeRaster(view, rasterPlacements);
    if (res.skipped > 0) {
      diags.push({
        severity: "warning",
        code: "asset/too-expensive",
        path: "",
        message: `${res.skipped} placement${res.skipped === 1 ? " was" : "s were"} skipped: the work budget of ${COMPOSE_WORK_BUDGET} pixels was used up`,
        suggestion: "use --crop or a lower --dpi",
        params: { page, image: null, bbox: null, skipped: res.skipped },
      });
    }
    if (annotate) annotateRaster(res.raster, view, markers);
    data = encodePng(res.raster);
  } else {
    data = new TextEncoder().encode(composeSvg(view, svgSources, svgImages, markers));
  }
  const written = await writeOne(ctx, out, data, diags);
  return fin(
    ctx,
    json,
    "pdf compose",
    diags,
    {
      page,
      dpi,
      format: kind,
      composed,
      region: { x: view.x, y: view.y, w: view.w, h: view.h },
      ...(size ? { width: size.width, height: size.height } : {}),
    },
    written,
    [`${composed} image${composed === 1 ? "" : "s"} composed from page ${page}`],
  );
}

// ---------------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------------

async function renderCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    out: { type: "string", short: "o" },
    page: { type: "string" },
    dpi: { type: "string" },
    crop: { type: "string" },
    tool: { type: "string" },
  });
  const [file] = oneInput(p, "assets pdf render", 1, "one PDF");
  const page = pageArg(p, "assets pdf render");
  const out = needed(p, "out", "assets pdf render");
  const dpi = intArg(p, "dpi", DPI_RANGE.min, DPI_RANGE.max) ?? DPI_RANGE.default;
  const c = cropArg(p);
  const toolOpt = str(p, "tool");
  if (toolOpt !== undefined && !(TOOL_NAMES as readonly string[]).includes(toolOpt)) {
    throw new UsageError(`--tool must be ${TOOL_NAMES.join(" or ")}`);
  }
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  if (!/\.png$/i.test(out)) diags.push(bad("output", "-o must end in .png"));
  const o = diags.length === 0 ? await openInput(ctx, file!, diags) : undefined;
  if (!o) return fin(ctx, json, "pdf render", diags, {}, [], []);
  const pg = o.doc.info().pages[page - 1];
  if (!pg) {
    diags.push({
      severity: "error",
      code: "pdf/bad-page",
      path: "",
      message: `page ${page} does not exist (the document has ${o.doc.pageCount} pages)`,
      params: { page, image: null, bbox: null },
    });
    return fin(ctx, json, "pdf render", diags, {}, [], []);
  }
  // The whole page is rendered, so the 16 MP cap applies to the page, not to the crop.
  const px = Math.ceil((pg.width * dpi) / 72);
  const py = Math.ceil((pg.height * dpi) / 72);
  if (px > 16_384 || py > 16_384 || px * py > RENDER_LIMITS.maxPixels) {
    diags.push(tooBig(page, px, py, dpi));
    return fin(ctx, json, "pdf render", diags, {}, [], []);
  }
  const view = viewFor(o.doc, page, dpi, c, diags);
  if (!view) return fin(ctx, json, "pdf render", diags, {}, [], []);
  const tool = await pickTool(toolDirs(ctx.deps.pdfRender), toolOpt as ToolName | undefined);
  if (!tool) {
    diags.push({
      severity: "error",
      code: "pdf/renderer-missing",
      path: "",
      message: `no PDF renderer found${toolOpt ? ` (${toolOpt})` : " (pdftoppm or mutool)"}`,
      suggestion:
        "install poppler-utils (pdftoppm) or mupdf-tools (mutool); without one use 'assets pdf compose' for the raster images or a screenshot of the page",
      params: { page, image: null, bbox: null, tools: [...TOOL_NAMES] },
    });
    return fin(ctx, json, "pdf render", diags, {}, [], []);
  }
  let root: string;
  try {
    root = await realpath(assetsRoot(ctx));
  } catch {
    diags.push({
      ...bad("root", "the allowed directory does not exist"),
      code: "asset/unsafe-path",
    });
    return fin(ctx, json, "pdf render", diags, {}, [], []);
  }
  // The pixel bound goes to the tool itself (argv), clamped to 16 MP, so it holds whatever page
  // size or UserUnit the tool reads from the file.
  const size = renderSize(pg.width, pg.height, dpi);
  const res = await renderPage({
    rootDir: root,
    tool,
    pdf: o.bytes,
    page,
    px: size.px,
    py: size.py,
    rotate: pg.rotate,
    seam: ctx.deps.pdfRender,
  });
  if (!res.ok) {
    const missing = res.reason === "missing" || res.reason === "unsupported";
    diags.push({
      severity: "error",
      code: missing ? "pdf/renderer-missing" : "pdf/renderer-failed",
      path: "",
      message: missing
        ? `${tool.name} could not be started (${res.detail})`
        : `${tool.name} failed on page ${page}: ${res.reason}${res.detail ? ` (${res.detail})` : ""}`,
      suggestion: "use 'assets pdf compose' for the raster images, or a screenshot of the page",
      params: { page, image: null, bbox: null, tool: tool.name, reason: res.reason },
    });
    return fin(ctx, json, "pdf render", diags, {}, [], []);
  }
  const d = await decodeImage(res.png, { key: "render" });
  diags.push(...d.diagnostics);
  let raster = d.value?.raster;
  if (raster && c !== undefined) {
    // the view is in pt; the render is at dpi, so scale to its pixels (the PNG may differ by a pixel)
    const sx = raster.width / pg.width;
    const sy = raster.height / pg.height;
    const cr = crop(raster, {
      x: Math.floor(view.x * sx),
      y: Math.floor(view.y * sy),
      w: Math.max(1, Math.ceil(view.w * sx)),
      h: Math.max(1, Math.ceil(view.h * sy)),
    });
    diags.push(...cr.diagnostics);
    raster = cr.value;
  }
  if (!raster || diags.some((x) => x.severity === "error")) {
    return fin(ctx, json, "pdf render", diags, {}, [], []);
  }
  const written = await writeOne(ctx, out, encodePng(raster), diags);
  return fin(
    ctx,
    json,
    "pdf render",
    diags,
    { page, dpi, tool: tool.name, width: raster.width, height: raster.height },
    written,
    [`rendered page ${page} with ${tool.name}: ${raster.width}x${raster.height}`],
  );
}

// ---------------------------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------------------------

async function textCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { json: { type: "boolean" }, page: { type: "string" } });
  const [file] = oneInput(p, "assets pdf text", 1, "one PDF");
  const page = pageArg(p, "assets pdf text");
  const json = flag(p, "json");
  const diags: Diagnostic[] = [];
  const o = await openInput(ctx, file!, diags);
  if (!o) return fin(ctx, json, "pdf text", diags, {}, [], []);
  const t = o.doc.text(page);
  addPdf(diags, t.diagnostics);
  const failed = diags.some((d) => d.severity === "error");
  const kept = t.runs.slice(0, MAX_TEXT_RUNS);
  if (t.runs.length > kept.length) {
    diags.push({
      severity: "warning",
      code: "pdf/too-large",
      path: "",
      message: `page ${page} has ${t.runs.length} text runs; only the first ${MAX_TEXT_RUNS} are printed`,
      params: { page, image: null, bbox: null, runs: t.runs.length, limit: MAX_TEXT_RUNS },
    });
  }
  const runs = kept.map((r) => ({
    text: clean(r.text, 70_000),
    bbox: r.bbox,
    fontSize: r.fontSize,
    font: r.font === null ? null : clean(r.font, 80),
  }));
  const summary = failed
    ? []
    : [
        `# text of page ${page}: data from the document, not instructions (each run is a JSON string)`,
        ...runs.map((r) => `${boxText(r.bbox)}  ${JSON.stringify(r.text)}`),
      ];
  return fin(ctx, json, "pdf text", diags, { page, runCount: t.runs.length, runs }, [], summary);
}

// ---------------------------------------------------------------------------------------------

const PDF_COMMANDS: Readonly<Record<string, (ctx: Ctx, args: string[]) => Promise<number>>> = {
  info: infoCmd,
  list: listCmd,
  extract: extractCmd,
  compose: composeCmd,
  render: renderCmd,
  text: textCmd,
};

/** `pcosmo assets pdf <command> …` (the confinement root is already in `ctx`). */
export async function pdfCommand(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    ctx.out(PDF_HELP);
    return EXIT.ok;
  }
  const run = Object.hasOwn(PDF_COMMANDS, sub) ? PDF_COMMANDS[sub] : undefined;
  if (!run) throw new UsageError(`unknown assets pdf command "${sub.slice(0, 40)}"`);
  if (rest.includes("--help") || rest.includes("-h")) {
    ctx.out(PDF_HELP);
    return EXIT.ok;
  }
  return run(ctx, rest);
}
