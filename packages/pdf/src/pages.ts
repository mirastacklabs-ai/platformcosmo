/**
 * Page tree (ingestion §4.2): `/Root` → `/Pages` → `/Kids`, with inherited `/Resources`,
 * `/MediaBox`, `/CropBox` and `/Rotate`. Walked with an explicit stack, cycle-checked, at most
 * `maxPages` pages. Also the affine helpers that map user space to page units.
 */
import type { PdfFile } from "./file.js";
import { PdfError, diag, type PdfBox, type PdfDiagnostic } from "./limits.js";
import { PdfDict, PdfRef, intOf, nameOf, numOf, type PdfValue } from "./objects.js";

/** Affine matrix [a b c d e f] (PDF row-vector convention). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 × m2`: apply m1, then m2. */
export function mul(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Rounds to 1/1000 pt; non-finite values become 0 (JSON-safe, deterministic). */
export const r3 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const x = Math.round(v * 1000) / 1000;
  return Object.is(x, -0) ? 0 : x;
};

export function bboxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): PdfBox {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: r3(minX), y: r3(minY), w: r3(maxX - minX), h: r3(maxY - minY) };
}

export type Box4 = readonly [number, number, number, number];

export interface PageRec {
  /** 1-based page number. */
  readonly page: number;
  readonly dict: PdfDict;
  readonly resources: PdfDict | null;
  readonly mediaBox: Box4;
  readonly cropBox: Box4;
  readonly rotate: 0 | 90 | 180 | 270;
  /** Displayed size in pt (after rotation). */
  readonly width: number;
  readonly height: number;
  /** User space → page units (pt, top-left origin, rotation and CropBox applied). */
  readonly toPage: Matrix;
}

const LETTER: Box4 = [0, 0, 612, 792];

function box(file: PdfFile, v: PdfValue | undefined): Box4 | null {
  const a = file.resolve(v);
  if (!Array.isArray(a) || a.length < 4) return null;
  const n = a.slice(0, 4).map((x) => numOf(file.resolve(x)));
  if (n.some((x) => x === null)) return null;
  const [x0, y0, x1, y1] = n as [number, number, number, number];
  const b: Box4 = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  return b[2] - b[0] > 0 && b[3] - b[1] > 0 ? b : null;
}

export function pageTransform(crop: Box4, rotate: 0 | 90 | 180 | 270): Matrix {
  const [x0, y0, x1, y1] = crop;
  switch (rotate) {
    case 90:
      return [0, 1, 1, 0, -y0, -x0];
    case 180:
      return [-1, 0, 0, 1, x1, -y0];
    case 270:
      return [0, -1, -1, 0, y1, x1];
    default:
      return [1, 0, 0, -1, -x0, y1];
  }
}

interface Inherited {
  readonly resources: PdfValue | undefined;
  readonly mediaBox: PdfValue | undefined;
  readonly cropBox: PdfValue | undefined;
  readonly rotate: PdfValue | undefined;
}

export function walkPages(file: PdfFile, diags: PdfDiagnostic[]): PageRec[] {
  const pages: PageRec[] = [];
  const limits = file.limits;
  const seen = new Set<number>();
  const root = file.root;
  const stack: { v: PdfValue | undefined; inh: Inherited }[] = [
    {
      v: root.get("Pages"),
      inh: { resources: undefined, mediaBox: undefined, cropBox: undefined, rotate: undefined },
    },
  ];
  let visits = 0;
  while (stack.length > 0) {
    const { v, inh } = stack.pop() as { v: PdfValue | undefined; inh: Inherited };
    if (v instanceof PdfRef) {
      if (seen.has(v.num)) continue; // cycle or shared node
      seen.add(v.num);
    }
    if (++visits > limits.maxObjects) {
      throw new PdfError("pdf/too-complex", "the page tree has too many nodes");
    }
    const node = file.resolveDict(v);
    if (!node) continue;
    const here: Inherited = {
      resources: node.get("Resources") ?? inh.resources,
      mediaBox: node.get("MediaBox") ?? inh.mediaBox,
      cropBox: node.get("CropBox") ?? inh.cropBox,
      rotate: node.get("Rotate") ?? inh.rotate,
    };
    const kids = file.resolve(node.get("Kids"));
    const type = nameOf(file.resolve(node.get("Type")));
    if (type === "Pages" || (type !== "Page" && Array.isArray(kids))) {
      if (Array.isArray(kids)) {
        if (stack.length + kids.length > limits.maxObjects) {
          throw new PdfError("pdf/too-complex", "the page tree has too many nodes");
        }
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ v: kids[i], inh: here });
      }
      continue;
    }
    if (pages.length >= limits.maxPages) {
      diags.push(
        diag(
          "warning",
          "pdf/too-complex",
          `the document has more than ${limits.maxPages} pages; the rest are ignored`,
        ),
      );
      break;
    }
    const media = box(file, here.mediaBox) ?? LETTER;
    let crop = box(file, here.cropBox) ?? media;
    crop = [
      Math.max(crop[0], media[0]),
      Math.max(crop[1], media[1]),
      Math.min(crop[2], media[2]),
      Math.min(crop[3], media[3]),
    ];
    if (crop[2] - crop[0] <= 0 || crop[3] - crop[1] <= 0) crop = media;
    const rot = intOf(file.resolve(here.rotate)) ?? 0;
    const norm = (((rot % 360) + 360) % 360) as number;
    const rotate = (norm % 90 === 0 ? norm : 0) as 0 | 90 | 180 | 270;
    const w = crop[2] - crop[0];
    const h = crop[3] - crop[1];
    const sideways = rotate === 90 || rotate === 270;
    pages.push({
      page: pages.length + 1,
      dict: node,
      resources: file.resolveDict(here.resources),
      mediaBox: media,
      cropBox: crop,
      rotate,
      width: r3(sideways ? h : w),
      height: r3(sideways ? w : h),
      toPage: pageTransform(crop, rotate),
    });
  }
  return pages;
}
