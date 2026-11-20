/**
 * Writes the synthetic fixtures to `$PDF_FIXTURES_OUT` so other readers (poppler, qpdf, a
 * browser) can be checked against them. Skipped unless the variable is set; tests never
 * write files otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import * as g from "./fixtures/gen.js";

const out = process.env.PDF_FIXTURES_OUT;

describe.skipIf(!out)("write fixtures", () => {
  it("writes every fixture", () => {
    const dir = out as string;
    mkdirSync(dir, { recursive: true });
    const files: Record<string, Uint8Array> = {
      "1-raster.pdf": g.rasterPdf(),
      "2-vector.pdf": g.vectorPdf(),
      "3-damaged.pdf": g.damagedPdf(),
      "3-objstm.pdf": g.objStmPdf(),
      "3-incremental.pdf": g.incrementalPdf().v2,
      "4-active.pdf": g.activeContentPdf(),
      "4-selfform.pdf": g.selfFormPdf(),
      "4-userpw.pdf": g.encryptedPdf({ kind: "aes-128", userPassword: "secret" }),
      "jpeg-16x8.jpg": g.JPEG_16x8,
    };
    for (const kind of [
      "rc4-40",
      "rc4-128",
      "rc4-v4",
      "aes-128",
      "aes-256-r5",
      "aes-256-r6",
    ] as const) {
      files[`4-${kind}.pdf`] = g.encryptedPdf({ kind });
    }
    files["4-aes-128-nometa.pdf"] = g.encryptedPdf({ kind: "aes-128", encryptMetadata: false });
    for (const rot of [0, 90, 180, 270]) {
      files[`rot-${rot}.pdf`] = g.onePage(
        "q 20 0 0 10 30 20 cm /Im1 Do Q",
        "/XObject << /Im1 10 0 R >>",
        [[10, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([0])]],
        { pageExtra: `/Rotate ${rot} /CropBox [10 10 110 60]` },
      );
    }
    for (const [name, b] of Object.entries(files)) writeFileSync(join(dir, name), b);
  });
});
