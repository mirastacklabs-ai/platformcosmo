/**
 * Regression tests for the crafted inputs of the C-2 review (fixtures/crafted.ts). Each one
 * must finish within a time bound and with bounded memory, and say what happened with a
 * diagnostic. Bounds are generous (the host is shared): the measured values are in the PR.
 */
import { describe, expect, it } from "vitest";
import { openPdf, type PdfDiagnostic } from "../src/index.js";
import { codes, findDiag, mustOpen } from "./helpers.js";
import * as c from "./fixtures/crafted.js";

const MiB = 1024 * 1024;

interface Measured<T> {
  readonly value: T;
  readonly ms: number;
  /** Heap + array buffers still held after the call (MiB). */
  readonly retainedMB: number;
  /** Growth of the process's peak RSS during the call (MiB). */
  readonly peakMB: number;
}

function measure<T>(fn: () => T): Measured<T> {
  const m0 = process.memoryUsage();
  const p0 = process.resourceUsage().maxRSS;
  const t = performance.now();
  const value = fn();
  const ms = performance.now() - t;
  const m1 = process.memoryUsage();
  return {
    value,
    ms,
    retainedMB: (m1.heapUsed + m1.arrayBuffers - m0.heapUsed - m0.arrayBuffers) / MiB,
    peakMB: (process.resourceUsage().maxRSS - p0) / 1024,
  };
}

/** Generous bounds: an order of magnitude above what the fixed parser needs. */
function bounded<T>(m: Measured<T>, ms = 10_000, retainedMB = 512, peakMB = 1536): T {
  expect(m.ms, "time (ms)").toBeLessThan(ms);
  expect(m.retainedMB, "retained memory (MiB)").toBeLessThan(retainedMB);
  expect(m.peakMB, "peak RSS growth (MiB)").toBeLessThan(peakMB);
  return m.value;
}

const T = 60_000; // vitest timeout per case; the asserted bounds are much lower

describe("crafted inputs: S-Q01 xref sections", () => {
  it(
    "a 100k-entry table whose /XRefStm points at itself",
    () => {
      const pdf = c.xrefStmSelf();
      const r = bounded(
        measure(() => openPdf(pdf)),
        5000,
        256,
      );
      expect(r.ok).toBe(true);
      findDiag(r.diagnostics, "pdf/malformed", "warning");
    },
    T,
  );

  it(
    "70 tables chained through /XRefStm",
    () => {
      const pdf = c.xrefStmChain();
      const r = bounded(
        measure(() => openPdf(pdf)),
        5000,
        256,
      );
      expect(r.ok).toBe(true);
      expect(findDiag(r.diagnostics, "pdf/too-complex", "warning").message).toMatch(/64/);
      findDiag(r.diagnostics, "pdf/xref-repaired", "info");
    },
    T,
  );
});

describe("crafted inputs: S-Q02 object bounds", () => {
  it(
    "1000 object-stream members at offset 0 over a 400k-element array",
    () => {
      const pdf = c.objStmSameOffset();
      const r = bounded(
        measure(() => openPdf(pdf)),
        5000,
        256,
      );
      expect(r.ok && r.doc.pageCount).toBe(0);
      expect(findDiag(r.diagnostics, "pdf/malformed", "warning").message).toMatch(/overlapping/);
    },
    T,
  );

  it(
    "the same with an unclosed string",
    () => {
      const pdf = c.objStmUnclosedString();
      const r = bounded(
        measure(() => openPdf(pdf)),
        5000,
        256,
      );
      findDiag(r.diagnostics, "pdf/malformed", "warning");
    },
    T,
  );

  it(
    "2000 plain `N 0 obj (` headers without an xref",
    () => {
      const pdf = c.plainUnclosed();
      const r = bounded(
        measure(() => openPdf(pdf)),
        5000,
        256,
      );
      expect(r.ok).toBe(true);
      findDiag(r.diagnostics, "pdf/xref-repaired", "info");
    },
    T,
  );
});

describe("crafted inputs: S-Q03/S-Q04 repair scan and stream ends", () => {
  it(
    "1 MiB of `trailer` repeated",
    () => {
      const pdf = c.trailerRun();
      const r = bounded(
        measure(() => openPdf(pdf)),
        3000,
        256,
      );
      expect(r.ok).toBe(true);
    },
    T,
  );

  it(
    "250k stream headers whose /Length lands in one 4 MiB whitespace run",
    () => {
      const pdf = c.streamsIntoWhitespace();
      const r = bounded(
        measure(() => openPdf(pdf)),
        5000,
        512,
      );
      expect(r.ok).toBe(true);
      findDiag(r.diagnostics, "pdf/xref-repaired", "info");
    },
    T,
  );

  it(
    "1000 inline images whose /L lands in 32 MiB of spaces",
    () => {
      const doc = mustOpen(c.inlineLongL());
      const list = bounded(
        measure(() => doc.listImages(1, { hash: false })),
        5000,
        256,
      );
      expect(list.images).toHaveLength(1000);
    },
    T,
  );
});

describe("crafted inputs: S-Q05 per-document budgets", () => {
  it(
    "100k pages sharing one 10 MB content stream are refused quickly",
    () => {
      const pdf = c.pagesSharedContent();
      const doc = mustOpen(pdf);
      expect(doc.pageCount).toBe(100_000);
      const seen: PdfDiagnostic[] = [];
      const n = bounded(
        measure(() => {
          let pages = 0;
          for (let p = 1; p <= doc.pageCount; p++) {
            const l = doc.listImages(p, { hash: false });
            if (l.diagnostics.some((d) => d.severity === "error"))
              seen.push(...l.diagnostics.slice(0, 1));
            pages++;
          }
          return pages;
        }),
        15_000,
        512,
      );
      expect(n).toBe(100_000);
      const d = findDiag(seen, "pdf/too-complex", "error");
      expect(d.params.scope).toBe("document");
      // the budget allowed about 25 pages of 10 MB, then refused before decoding
      expect(doc.file.budget.content).toBeLessThanOrEqual(256 * MiB);
    },
    T,
  );
});

describe("crafted inputs: C-Q01 images without data", () => {
  it(
    "200 inline 4096×4096 images with one byte each",
    () => {
      const doc = mustOpen(c.inlineHugeImages());
      const list = bounded(
        measure(() => doc.listImages(1)),
        5000,
        256,
      );
      expect(list.images).toHaveLength(200);
      expect(list.images.every((i) => i.sha256 === null)).toBe(true);
      expect(findDiag(list.diagnostics, "pdf/malformed", "warning").message).toMatch(
        /1 of 16777216/,
      );
    },
    T,
  );

  it(
    "200 distinct empty 4096×4096 image XObjects",
    () => {
      const doc = mustOpen(c.emptyImageXObjects());
      const list = bounded(
        measure(() => doc.listImages(1)),
        5000,
        256,
      );
      expect(list.images).toHaveLength(200);
      expect(list.images.every((i) => i.sha256 === null)).toBe(true);
      const e = doc.extractImage(1, 0);
      expect(e.ok).toBe(false);
      findDiag(e.diagnostics, "pdf/malformed", "error");
    },
    T,
  );
});

describe("crafted inputs: C-Q02 text", () => {
  it(
    "one Tj of 60 MB is truncated to 64K characters",
    () => {
      const doc = mustOpen(c.tjHuge());
      const t = bounded(
        measure(() => doc.text(1)),
        10_000,
        512,
      );
      expect(t.runs).toHaveLength(1);
      expect(t.runs[0]?.text.length).toBe(65_536);
      expect(findDiag(t.diagnostics, "pdf/too-complex", "warning").message).toMatch(/65536/);
    },
    T,
  );

  it(
    "`(a) Tj` five million times stops at 200K runs",
    () => {
      const doc = mustOpen(c.tjMany());
      const t = bounded(
        measure(() => doc.text(1)),
        15_000,
        512,
      );
      expect(t.runs).toHaveLength(200_000);
      expect(codes(t.diagnostics)).toContain("pdf/too-complex");
      expect(t.diagnostics.find((d) => /200000 text runs/.test(d.message))).toBeDefined();
    },
    T,
  );
});

describe("crafted inputs: second review round", () => {
  it(
    "R-N1: 25M names in /Kids arrays stop at the parsed-value cap with bounded heap",
    () => {
      const pdf = c.namesInKids();
      const r = bounded(
        measure(() => openPdf(pdf)),
        15_000,
        512,
        1536,
      );
      expect(r.ok).toBe(false);
      expect(findDiag(r.diagnostics, "pdf/too-complex", "error").params.scope).toBe("values");
    },
    T,
  );

  it(
    "N01: a 256-character ToUnicode mapping shown 51M times keeps at most 4M characters",
    () => {
      const doc = mustOpen(c.toUnicodeExpansion());
      const t = bounded(
        measure(() => doc.text(1)),
        15_000,
        512,
      );
      const chars = t.runs.reduce((n, r) => n + r.text.length, 0);
      expect(chars).toBeLessThanOrEqual(4_000_000);
      expect(t.runs[0]?.text.length).toBe(256 * 32); // each mapping capped at 32 characters
      expect(t.diagnostics.filter((d) => /4000000 characters/.test(d.message))).toHaveLength(1);
    },
    T,
  );

  it(
    "R-N3: 60 tables of 40k entries chained by /XRefStm hold nothing per entry",
    () => {
      const pdf = c.chainedTables();
      const r = bounded(
        measure(() => openPdf(pdf)),
        10_000,
        128,
      );
      expect(r.ok).toBe(true);
      expect(r.ok && r.doc.pageCount).toBe(0);
    },
    T,
  );
});
