/**
 * Seeded mutation fuzz over the fixtures: the parser never throws, stays within a time bound
 * per input, and is deterministic (two runs give identical results).
 */
import { describe, expect, it } from "vitest";
import { everything } from "./helpers.js";
import * as g from "./fixtures/gen.js";

const TOKENS = [
  "<<",
  ">>",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "/",
  "%",
  " obj ",
  "endobj",
  "stream\n",
  "\nendstream",
  " R ",
  "999999999",
  "-1",
  "4294967296",
  "1e9",
  "/Filter /FlateDecode",
  "/Length 999999",
  "xref\n0 9\n",
  "trailer",
  "startxref\n",
  "BI ",
  " ID ",
  " EI ",
  "q ",
  "Q ",
  " cm ",
  " Do ",
  "/Kids [3 0 R 3 0 R]",
  "/Width 100000",
  "/BitsPerComponent 3",
  "/ColorSpace /Indexed",
  "/Predictor 15",
  "/Rotate 45",
];

function mutate(src: Uint8Array, r: () => number): Uint8Array {
  let b = src;
  const ops = 1 + Math.floor(r() * 4);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(r() * b.length);
    switch (Math.floor(r() * 6)) {
      case 0: {
        // flip a few bytes
        b = b.slice();
        for (let i = 0; i < 1 + r() * 8; i++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
        break;
      }
      case 1: // insert a token
        b = g.cat(
          b.subarray(0, at),
          g.bytes(TOKENS[Math.floor(r() * TOKENS.length)] as string),
          b.subarray(at),
        );
        break;
      case 2: // delete a range
        b = g.cat(b.subarray(0, at), b.subarray(Math.min(b.length, at + Math.floor(r() * 64))));
        break;
      case 3: {
        // duplicate a range elsewhere
        const len = Math.floor(r() * 200);
        const to = Math.floor(r() * b.length);
        b = g.cat(b.subarray(0, to), b.subarray(at, at + len), b.subarray(to));
        break;
      }
      case 4: // truncate
        b = b.subarray(0, Math.max(0, b.length - Math.floor(r() * 400)));
        break;
      default: {
        // replace a digit run with another number
        b = b.slice();
        for (let i = at; i < Math.min(b.length, at + 200); i++) {
          if ((b[i] as number) >= 48 && (b[i] as number) <= 57) {
            b[i] = 48 + Math.floor(r() * 10);
            break;
          }
        }
      }
    }
  }
  return b;
}

const SOURCES: [string, Uint8Array][] = [
  ["raster", g.rasterPdf()],
  ["vector", g.vectorPdf()],
  ["damaged", g.damagedPdf()],
  ["objstm", g.objStmPdf()],
  ["incremental", g.incrementalPdf().v2],
  ["selfform", g.selfFormPdf()],
  ["rc4", g.encryptedPdf({ kind: "rc4-128" })],
  ["aes256", g.encryptedPdf({ kind: "aes-256-r6" })],
];

describe("fuzz", () => {
  for (const [name, src] of SOURCES) {
    it(`mutations of ${name}: no throw, bounded time, deterministic`, () => {
      const r = g.rng(0x5eed ^ (name.length * 7919) ^ src.length);
      let slowest = 0;
      let opened = 0;
      for (let i = 0; i < 40; i++) {
        const input = mutate(src, r);
        const t = performance.now();
        let a: unknown;
        expect(() => (a = everything(input))).not.toThrow();
        slowest = Math.max(slowest, performance.now() - t);
        if (!(a as { open?: unknown }).open) opened++;
        expect(JSON.stringify(everything(input))).toBe(JSON.stringify(a));
      }
      expect(slowest).toBeLessThan(2000);
      expect(opened).toBeGreaterThan(10); // mutations mostly still open (repair works)
    });
  }

  it("random bytes and PDF-looking noise never throw", () => {
    const r = g.rng(42);
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(r() * 2000);
      const noise = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      const head =
        i % 2
          ? g.cat(g.bytes("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"), noise)
          : noise;
      expect(() => everything(head)).not.toThrow();
    }
  });
});
