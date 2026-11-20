/**
 * `@platformcosmo/pdf`: a minimal hardened PDF parser (ingestion §4). Bytes in, plain data
 * out: no I/O, no network, no child processes, no globals. Every method returns diagnostics
 * instead of throwing on bad input, and all text and pixels it returns are data.
 */
import { createHash } from "node:crypto";
import { scanPage, type Placement, type ScanResult, type TextRun } from "./content.js";
import type { PdfEncryptionInfo } from "./crypt.js";
import { PdfFile } from "./file.js";
import { decodeImage, decodeMask, encodePng, imageMeta, type ImageMeta } from "./images.js";
import {
  PdfError,
  SUGGEST_RENDER,
  diag,
  errorToDiag,
  resolveLimits,
  type PdfBox,
  type PdfDiagnostic,
  type PdfLimits,
  type Where,
} from "./limits.js";
import type { PdfStream } from "./objects.js";
import { bboxOf, mul, r3, walkPages, type Matrix, type PageRec } from "./pages.js";

export { DEFAULT_LIMITS } from "./limits.js";
export { PNG_ZLIB_LEVEL } from "./images.js";
export type { PdfBox, PdfCode, PdfDiagnostic, PdfLimits, PdfSeverity } from "./limits.js";
export type { PdfEncryptionInfo } from "./crypt.js";
export type { TextRun as PdfTextRun } from "./content.js";
export type { Matrix as PdfMatrix } from "./pages.js";

export interface PdfOptions {
  /** Overrides of the ingestion §4.6 limits (tests, or a CLI that wants tighter caps). */
  readonly limits?: Partial<PdfLimits>;
}

export interface PdfPageInfo {
  /** 1-based. */
  readonly page: number;
  /** Displayed size in pt, after `/Rotate` and the CropBox. */
  readonly width: number;
  readonly height: number;
  readonly rotate: 0 | 90 | 180 | 270;
  readonly mediaBox: readonly [number, number, number, number];
  readonly cropBox: readonly [number, number, number, number];
}

export interface PdfInfo {
  /** Header version, e.g. "1.7". */
  readonly version: string | null;
  readonly pageCount: number;
  readonly pages: readonly PdfPageInfo[];
  /** `/Info` `/Producer` (the only `/Info` entry read), as data. */
  readonly producer: string | null;
  readonly encryption: PdfEncryptionInfo | null;
  /** The cross-reference table or a stream length was repaired. */
  readonly repaired: boolean;
  readonly diagnostics: readonly PdfDiagnostic[];
}

export interface PdfImage {
  readonly page: number;
  /** 0-based placement index on the page, in content order (forms included). */
  readonly index: number;
  readonly inline: boolean;
  /** Object number of the image XObject (`null` for inline images); equal → same image. */
  readonly object: number | null;
  readonly width: number;
  readonly height: number;
  readonly bitsPerComponent: number;
  readonly colourSpace: string | null;
  readonly components: number;
  readonly filters: readonly string[];
  /** Extracted file type: "jpeg" (DCT passthrough), "png", or "unsupported". */
  readonly format: "jpeg" | "png" | "unsupported";
  readonly imageMask: boolean;
  readonly hasAlpha: boolean;
  /** Within the output caps (16 384 px per side, 16 MP); larger images are listed only. */
  readonly withinCaps: boolean;
  /** Placement in page units (pt, origin top-left) and in percent of the page. */
  readonly bbox: PdfBox;
  readonly bboxPercent: PdfBox;
  /**
   * Maps image coordinates (u right, v down, both 0..1 across the image) to page units:
   * `x = a·u + c·v + e`, `y = b·u + d·v + f`. Use it to composite (`pdf compose`).
   */
  readonly matrix: Matrix;
  /** SHA-256 (hex) of the file `extractImage` returns; `null` when it cannot be extracted. */
  readonly sha256: string | null;
}

export interface PdfImageList {
  readonly page: number;
  readonly images: readonly PdfImage[];
  readonly diagnostics: readonly PdfDiagnostic[];
}

export interface PdfExtracted {
  readonly format: "png" | "jpeg";
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export interface PdfExtractResult {
  readonly ok: boolean;
  readonly image: PdfExtracted | null;
  readonly diagnostics: readonly PdfDiagnostic[];
}

export interface PdfTextResult {
  readonly page: number;
  /** One run per text-showing operator, in content order. */
  readonly runs: readonly TextRun[];
  readonly diagnostics: readonly PdfDiagnostic[];
}

export type PdfOpenResult =
  | { readonly ok: true; readonly doc: PdfDocument; readonly diagnostics: readonly PdfDiagnostic[] }
  | { readonly ok: false; readonly doc: null; readonly diagnostics: readonly PdfDiagnostic[] };

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Image space (u right, v down) → PDF unit square (y up). */
const IMAGE_SPACE: Matrix = [1, 0, 0, -1, 0, 1];

export class PdfDocument {
  private cached: { page: number; scan: ScanResult } | null = null;
  private readonly metas = new WeakMap<PdfStream, ImageMeta>();
  private readonly hashes = new WeakMap<PdfStream, string | null>();

  /** @internal use `openPdf`. */
  constructor(
    /** @internal */ readonly file: PdfFile,
    private readonly pages: readonly PageRec[],
    private readonly openDiagnostics: readonly PdfDiagnostic[],
  ) {}

  get pageCount(): number {
    return this.pages.length;
  }

  info(): PdfInfo {
    let producer: string | null = null;
    const diagnostics = [...this.openDiagnostics];
    try {
      producer = this.file.producer();
    } catch (e) {
      diagnostics.push(errorToDiag(e));
    }
    for (const d of this.file.diagnostics) if (!diagnostics.includes(d)) diagnostics.push(d);
    return {
      version: this.file.version,
      pageCount: this.pages.length,
      pages: this.pages.map((p) => ({
        page: p.page,
        width: p.width,
        height: p.height,
        rotate: p.rotate,
        mediaBox: p.mediaBox.map(r3) as unknown as PdfPageInfo["mediaBox"],
        cropBox: p.cropBox.map(r3) as unknown as PdfPageInfo["cropBox"],
      })),
      producer,
      encryption: this.file.encryption,
      repaired: this.file.repaired,
      diagnostics,
    };
  }

  /** Every image placement on `page` (1-based), with bbox and hash (`hash: false` skips decoding). */
  listImages(page: number, opts: { hash?: boolean } = {}): PdfImageList {
    return this.guard({ page }, { page, images: [], diagnostics: [] }, (diags) => {
      const p = this.page(page);
      const scan = this.scan(p);
      diags.push(...scan.diagnostics);
      const images: PdfImage[] = [];
      for (const pl of scan.placements) {
        const img = this.describe(p, pl, opts.hash !== false, diags);
        images.push(img);
      }
      if (images.length === 0) {
        diags.push(
          diag(
            "warning",
            "pdf/no-images",
            `page ${page} has no raster images (vector-only)`,
            { page },
            SUGGEST_RENDER,
          ),
        );
      }
      return { page, images, diagnostics: diags };
    });
  }

  /**
   * One image as a file: DCTDecode passed through as JPEG, everything else decoded to PNG.
   * `mask: true` returns the image's mask (SMask, stencil Mask or ImageMask) as a gray PNG.
   */
  extractImage(page: number, index: number, opts: { mask?: boolean } = {}): PdfExtractResult {
    return this.guard(
      { page, image: index },
      { ok: false, image: null, diagnostics: [] },
      (diags) => {
        const p = this.page(page);
        const pl = this.placement(p, index, diags);
        const where = this.where(p, pl);
        try {
          const out = this.extract(pl, where, diags, opts.mask === true);
          if (!out) {
            diags.push(
              diag("error", "pdf/bad-page", `image ${index} on page ${page} has no mask`, where),
            );
            return { ok: false, image: null, diagnostics: diags };
          }
          return { ok: true, image: out, diagnostics: diags };
        } catch (e) {
          diags.push(errorToDiag(e, where));
          return { ok: false, image: null, diagnostics: diags };
        }
      },
    );
  }

  /** Text runs with bboxes (simple fonts, ToUnicode CMaps; unknown glyphs as U+FFFD). */
  text(page: number): PdfTextResult {
    return this.guard({ page }, { page, runs: [], diagnostics: [] }, (diags) => {
      const p = this.page(page);
      const scan = scanPage(this.file, p, { images: false, text: true });
      diags.push(...scan.diagnostics);
      return { page, runs: scan.runs, diagnostics: diags };
    });
  }

  // ---- internals ---------------------------------------------------------------------------

  private guard<T extends { diagnostics: readonly PdfDiagnostic[] }>(
    where: Where,
    fallback: T,
    fn: (diags: PdfDiagnostic[]) => T,
  ): T {
    const before = this.file.diagnostics.length;
    const diags: PdfDiagnostic[] = [];
    let out: T;
    try {
      out = fn(diags);
    } catch (e) {
      diags.push(errorToDiag(e, where));
      out = { ...fallback, diagnostics: diags };
    }
    const fresh = this.file.diagnostics.slice(before);
    return fresh.length ? { ...out, diagnostics: [...fresh, ...out.diagnostics] } : out;
  }

  private page(page: number): PageRec {
    const p = Number.isSafeInteger(page) ? this.pages[page - 1] : undefined;
    if (!p) {
      throw new PdfError(
        "pdf/bad-page",
        `page ${page} does not exist (the document has ${this.pages.length} pages)`,
        { page },
      );
    }
    return p;
  }

  private scan(p: PageRec): ScanResult {
    if (this.cached?.page === p.page) return this.cached.scan;
    const scan = scanPage(this.file, p, { images: true, text: false });
    this.cached = { page: p.page, scan };
    return scan;
  }

  private placement(p: PageRec, index: number, diags: PdfDiagnostic[]): Placement {
    const scan = this.scan(p);
    const pl = Number.isSafeInteger(index) ? scan.placements[index] : undefined;
    if (!pl) {
      diags.push(...scan.diagnostics); // why the page has fewer images, if it does
      throw new PdfError(
        "pdf/bad-page",
        `page ${p.page} has no image ${index} (it has ${scan.placements.length})`,
        { page: p.page, image: index },
      );
    }
    return pl;
  }

  private geometry(p: PageRec, pl: Placement): { bbox: PdfBox; matrix: Matrix } {
    const m = mul(pl.ctm, p.toPage);
    const full = mul(IMAGE_SPACE, m);
    return { bbox: bboxOf(m, 0, 0, 1, 1), matrix: full.map(r3) as unknown as Matrix };
  }

  private where(p: PageRec, pl: Placement): Where {
    return { page: p.page, image: pl.index, bbox: this.geometry(p, pl).bbox };
  }

  private extract(
    pl: Placement,
    where: Where,
    diags: PdfDiagnostic[],
    mask: boolean,
  ): PdfExtracted | null {
    const d = mask
      ? decodeMask(this.file, pl.stream, where, diags)
      : decodeImage(this.file, pl.stream, pl.resources, where, diags);
    if (!d) return null;
    if (d.kind === "jpeg") {
      const bytes = d.bytes.slice();
      return { format: "jpeg", bytes, width: d.width, height: d.height, sha256: sha256(bytes) };
    }
    const bytes = encodePng(d.width, d.height, d.pixels, d.alpha);
    return { format: "png", bytes, width: d.width, height: d.height, sha256: sha256(bytes) };
  }

  private describe(p: PageRec, pl: Placement, hash: boolean, diags: PdfDiagnostic[]): PdfImage {
    const { bbox, matrix } = this.geometry(p, pl);
    const where: Where = { page: p.page, image: pl.index, bbox };
    let meta = this.metas.get(pl.stream);
    if (!meta) {
      meta = imageMeta(this.file, pl.stream, pl.resources, this.file.limits);
      this.metas.set(pl.stream, meta);
    }
    let digest: string | null = null;
    if (hash && meta.format !== "unsupported" && meta.withinCaps) {
      if (this.hashes.has(pl.stream)) digest = this.hashes.get(pl.stream) as string | null;
      else {
        const local: PdfDiagnostic[] = [];
        try {
          digest = this.extract(pl, where, local, false)?.sha256 ?? null;
        } catch (e) {
          if (e instanceof PdfError && e.where.scope === "total") throw e; // command budget
          local.push(errorToDiag(e, where));
        }
        this.hashes.set(pl.stream, digest);
        // listing still succeeds: image-level problems are warnings here
        for (const x of local)
          diags.push(x.severity === "error" ? { ...x, severity: "warning" } : x);
      }
    } else if (meta.format === "unsupported") {
      diags.push(
        diag(
          "warning",
          "pdf/unsupported-filter",
          `image ${pl.index} uses ${meta.filters.join(", ")}, which cannot be decoded`,
          where,
          SUGGEST_RENDER,
        ),
      );
    } else if (!meta.withinCaps) {
      diags.push(
        diag(
          "warning",
          "pdf/too-large",
          `image ${pl.index} (${meta.width}×${meta.height}) exceeds the output cap; listed only`,
          where,
          "use `pcosmo assets pdf render --crop` at a lower DPI",
        ),
      );
    }
    const pw = p.width || 1;
    const ph = p.height || 1;
    return {
      page: p.page,
      index: pl.index,
      inline: pl.inline,
      object: pl.ref,
      width: meta.width,
      height: meta.height,
      bitsPerComponent: meta.bitsPerComponent,
      colourSpace: meta.colourSpace,
      components: meta.components,
      filters: meta.filters,
      format: meta.format,
      imageMask: meta.imageMask,
      hasAlpha: meta.hasAlpha,
      withinCaps: meta.withinCaps,
      bbox,
      bboxPercent: {
        x: r3((bbox.x / pw) * 100),
        y: r3((bbox.y / ph) * 100),
        w: r3((bbox.w / pw) * 100),
        h: r3((bbox.h / ph) * 100),
      },
      matrix,
      sha256: digest,
    };
  }
}

/** Opens a PDF. Never throws: failures (not a PDF, refused encryption, caps) are diagnostics. */
export function openPdf(bytes: Uint8Array, options: PdfOptions = {}): PdfOpenResult {
  const limits = resolveLimits(options.limits);
  if (!(bytes instanceof Uint8Array)) {
    return {
      ok: false,
      doc: null,
      diagnostics: [diag("error", "pdf/malformed", "input is not a byte array")],
    };
  }
  if (bytes.length > limits.maxFileBytes) {
    return {
      ok: false,
      doc: null,
      diagnostics: [
        diag("error", "pdf/too-large", `the file is larger than ${limits.maxFileBytes} bytes`, {
          size: bytes.length,
        }),
      ],
    };
  }
  const file = new PdfFile(bytes, limits);
  const diags: PdfDiagnostic[] = [];
  try {
    file.open();
    const pages = walkPages(file, diags);
    if (file.encryption) {
      diags.push(
        diag(
          "info",
          "pdf/encrypted",
          `the document is encrypted (${file.encryption.streams}); opened with the empty user password`,
          {
            permissions: file.encryption.permissions,
          },
        ),
      );
    }
    if (pages.length === 0) {
      diags.push(diag("warning", "pdf/bad-page", "the document has no pages"));
    }
    const all = [...file.diagnostics, ...diags];
    return { ok: true, doc: new PdfDocument(file, pages, all), diagnostics: all };
  } catch (e) {
    return { ok: false, doc: null, diagnostics: [...file.diagnostics, ...diags, errorToDiag(e)] };
  }
}
