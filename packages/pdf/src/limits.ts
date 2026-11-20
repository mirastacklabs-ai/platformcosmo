/**
 * Diagnostics, hostile-input limits (ingestion §4.6, §14) and the per-document budget.
 * Internally the parser throws `PdfError`; every public entry point catches it and returns a
 * diagnostic, so nothing throws out of the API on bad input.
 */

export type PdfSeverity = "error" | "warning" | "info";

/** Codes of ingestion §13 used by the parser (`pdf/renderer-*` belong to the CLI, D-2b). */
export type PdfCode =
  | "pdf/encrypted"
  | "pdf/xref-repaired"
  | "pdf/unsupported-filter"
  | "pdf/colour-approx"
  | "pdf/too-complex"
  | "pdf/too-large"
  | "pdf/no-images"
  | "pdf/bad-page"
  | "pdf/malformed";

/** Placement box in page units (pt, origin top-left, after `/Rotate` and the CropBox). */
export interface PdfBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Structurally compatible with core's `Diagnostic`. `params` always carries `page` (1-based),
 * `image` (0-based index on the page) and `bbox`, each `null` when not applicable.
 */
export interface PdfDiagnostic {
  readonly severity: PdfSeverity;
  readonly code: PdfCode;
  /** Always "" (a PDF has no JSON pointer); the location is in `params`. */
  readonly path: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly params: Readonly<{
    page: number | null;
    image: number | null;
    bbox: PdfBox | null;
    [key: string]: unknown;
  }>;
}

export interface PdfLimits {
  /** Input file size in bytes (256 MiB). */
  readonly maxFileBytes: number;
  /** Objects in the cross-reference table, and elements of one array or dictionary (500 000). */
  readonly maxObjects: number;
  /** Decoded bytes of one stream (64 MiB). */
  readonly maxStreamBytes: number;
  /** Decompression-bomb guard: decoded/encoded ratio (1024), checked above `bombFloorBytes`. */
  readonly bombRatio: number;
  readonly bombFloorBytes: number;
  /** Decoded bytes across every stream of one document handle, i.e. one command (1 GiB). */
  readonly maxTotalDecoded: number;
  /** Output image size: px per side (16 384) and pixels (16 MP). */
  readonly maxImageSide: number;
  readonly maxImagePixels: number;
  /** Array/dictionary nesting (64), Form XObject depth (16), q/Q stack (256). */
  readonly maxNesting: number;
  readonly maxFormDepth: number;
  readonly maxQStack: number;
  /** Cross-reference sections in the `/Prev` chain (64). */
  readonly maxXrefSections: number;
  /** Pages (100 000). */
  readonly maxPages: number;
  /** Content-stream operators per page, forms included (5 000 000). */
  readonly maxOpsPerPage: number;
  /** Filters in one chain (4). */
  readonly maxFilters: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: PdfLimits = Object.freeze({
  maxFileBytes: 256 * MiB,
  maxObjects: 500_000,
  maxStreamBytes: 64 * MiB,
  bombRatio: 1024,
  bombFloorBytes: 1 * MiB,
  maxTotalDecoded: 1024 * MiB,
  maxImageSide: 16_384,
  maxImagePixels: 16_777_216,
  maxNesting: 64,
  maxFormDepth: 16,
  maxQStack: 256,
  maxXrefSections: 64,
  maxPages: 100_000,
  maxOpsPerPage: 5_000_000,
  maxFilters: 4,
});

/** Merges overrides; non-finite or negative overrides are ignored (the default stays). */
export function resolveLimits(over?: Partial<PdfLimits>): PdfLimits {
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  if (over) {
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const v = (over as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
  }
  return out as unknown as PdfLimits;
}

export interface Where {
  readonly page?: number | null;
  readonly image?: number | null;
  readonly bbox?: PdfBox | null;
  readonly [key: string]: unknown;
}

export class PdfError extends Error {
  constructor(
    readonly code: PdfCode,
    message: string,
    readonly where: Where = {},
    readonly suggestion?: string,
  ) {
    super(message);
  }
}

export function diag(
  severity: PdfSeverity,
  code: PdfCode,
  message: string,
  where: Where = {},
  suggestion?: string,
): PdfDiagnostic {
  const { page = null, image = null, bbox = null, ...rest } = where;
  const params = { page, image, bbox, ...rest };
  return suggestion === undefined
    ? { severity, code, path: "", message, params }
    : { severity, code, path: "", message, suggestion, params };
}

export const SUGGEST_RENDER = "use `pcosmo assets pdf render` or attach a screenshot";

/** Converts anything caught at an API boundary into a diagnostic. */
export function errorToDiag(e: unknown, where: Where = {}): PdfDiagnostic {
  if (e instanceof PdfError) {
    return diag(
      e.code === "pdf/xref-repaired" ? "info" : "error",
      e.code,
      e.message,
      {
        ...where,
        ...e.where,
      },
      e.suggestion,
    );
  }
  // RangeError (allocation, call stack) or a parser bug: still a diagnostic, never a throw.
  return diag("error", "pdf/too-complex", "the file exceeded an internal processing limit", where);
}

/** Decoded-bytes accounting for one document handle (one CLI command). */
export class Budget {
  decoded = 0;
  constructor(readonly limits: PdfLimits) {}
  charge(n: number, where: Where = {}): void {
    this.decoded += n;
    if (this.decoded > this.limits.maxTotalDecoded) {
      throw new PdfError(
        "pdf/too-large",
        `decoded data exceeds the ${this.limits.maxTotalDecoded}-byte total per command`,
        { ...where, scope: "total" },
      );
    }
  }
}
