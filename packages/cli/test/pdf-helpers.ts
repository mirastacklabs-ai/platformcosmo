import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { run } from "../src/index.js";
import type { Deps } from "../src/deps.js";
import { makeDeps, tmp } from "./helpers.js";

/** `pcosmo assets pdf …` in process, with the working directory `dir`. */
export const pdf = (dir: string, args: string[], over: Partial<Deps> = {}) =>
  run(["assets", "pdf", ...args], makeDeps(dir, over));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = (s: string) => JSON.parse(s) as Record<string, any>;
export type Diag = { code: string; severity: string; message: string; params?: unknown };

/** Writes `bytes` to `<dir>/<name>` and returns the name. */
export async function put(dir: string, name: string, bytes: Uint8Array | string): Promise<string> {
  await mkdir(dirname(join(dir, name)), { recursive: true });
  await writeFile(join(dir, name), bytes);
  return name;
}

export async function work(): Promise<string> {
  return tmp();
}

/** Every diagnostic code a PDF command may emit (ingestion §13 and assemblies §18). */
export const ALLOWED_CODES = new Set([
  "pdf/encrypted",
  "pdf/xref-repaired",
  "pdf/unsupported-filter",
  "pdf/colour-approx",
  "pdf/too-complex",
  "pdf/too-large",
  "pdf/renderer-missing",
  "pdf/renderer-failed",
  "pdf/render-unsandboxed",
  "pdf/no-images",
  "pdf/bad-page",
  "pdf/malformed",
  "asset/bad-option",
  "asset/unsafe-path",
  "asset/too-large",
  "asset/too-expensive",
  "asset/stale-output",
  "asset/bad-raster",
  "asset/tool-missing",
  "image/not-found",
  "image/unsafe-path",
  "image/too-large",
  "image/format",
  "image/too-many",
  "image/icc-ignored",
  "image/cmyk",
  "image/exif-ignored",
  "image/sanitized",
  "image/unknown",
]);

export function expectKnownCodes(diags: readonly Diag[]): void {
  for (const d of diags) expect(ALLOWED_CODES.has(d.code), `unexpected code ${d.code}`).toBe(true);
}

/** Keys sorted at every level (the determinism convention of `--json`). */
export function expectSorted(v: unknown): void {
  if (Array.isArray(v)) v.forEach(expectSorted);
  else if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    expect(keys).toEqual([...keys].sort());
    Object.values(v).forEach(expectSorted);
  }
}
