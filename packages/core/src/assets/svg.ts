/**
 * SVG images (§11.2): UTF-8 text with an `<svg` root, run through the icon sanitizer
 * (allowlist; scripts, handlers, foreignObject, external references removed).
 */
import type { SanitizedSvg } from "../contracts/index.js";
import { sanitizeSvgWith } from "../icons/sanitize.js";

export interface SvgOk {
  readonly ok: true;
  readonly svg: SanitizedSvg;
  readonly removed: readonly string[];
  readonly width: number;
  readonly height: number;
}
export interface SvgFail {
  readonly ok: false;
  readonly message: string;
}

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Sniffs an SVG document: optional BOM and whitespace, then any mix of processing instructions
 * (`<?xml … ?>`), comments and at most one DOCTYPE without internal subset, then `<svg`. A linear
 * scan (no backtracking) over at most `maxBytes` bytes. `"truncated"` means the scan window ended
 * inside the prolog of a larger file (the size cap then reports it).
 */
export function sniffSvg(bytes: Uint8Array, maxBytes = 262_144): "svg" | "truncated" | "no" {
  const t = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
  const more = bytes.length > maxBytes;
  const out = (): "truncated" | "no" => (more ? "truncated" : "no");
  let i = 0;
  let doctype = false;
  for (;;) {
    while (i < t.length && (isWs(t.charCodeAt(i)) || t.charCodeAt(i) === 0xfeff)) i++;
    if (t.startsWith("<?", i)) {
      const e = t.indexOf("?>", i + 2);
      if (e < 0) return out();
      i = e + 2;
    } else if (t.startsWith("<!--", i)) {
      const e = t.indexOf("-->", i + 4);
      if (e < 0) return out();
      i = e + 3;
    } else if (!doctype && t.slice(i, i + 9).toUpperCase() === "<!DOCTYPE") {
      const e = t.indexOf(">", i);
      if (e < 0) return out();
      const sub = t.indexOf("[", i);
      if (sub >= 0 && sub < e) return "no"; // internal subset (entities)
      doctype = true;
      i = e + 1;
    } else break;
  }
  if (i >= t.length) return out();
  if (!t.startsWith("<svg", i)) return "no";
  if (i + 4 >= t.length) return out();
  const c = t.charCodeAt(i + 4);
  return isWs(c) || c === 0x3e || c === 0x2f ? "svg" : "no";
}

/** Labels (from the sanitizer) that mean active content was present, not just cosmetics. */
export function isActiveRemoval(label: string): boolean {
  return (
    /^element:(?:\w+_)?(?:script|foreignObject|iframe|object|embed|set|animate\w*|a)$/i.test(
      label,
    ) ||
    /^attr:on/i.test(label) ||
    /^attr:(?:xlink_)?href$/i.test(label) // an href the sanitizer refused (javascript:, external)
  );
}

export function cleanSvg(bytes: Uint8Array, maxBytes: number): SvgOk | SvgFail {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: "SVG is not valid UTF-8 text" };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const res = sanitizeSvgWith(text, { maxBytes, dropElements: ["image"] });
  if (!res.ok) return { ok: false, message: `SVG rejected by the sanitizer: ${res.reason}` };
  const nums = res.svg.viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const w = nums[2];
  const h = nums[3];
  if (nums.length !== 4 || !(w !== undefined && w > 0) || !(h !== undefined && h > 0)) {
    return { ok: false, message: "SVG viewBox must have a positive width and height" };
  }
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    return { ok: false, message: "SVG viewBox must be finite" };
  }
  // Fail closed: an image asset never embeds another image or a data: reference.
  if (/<image[\s/>]/.test(res.svg.body) || /(?:=["']|url\(["']?)\s*data:/i.test(res.svg.body)) {
    return { ok: false, message: "SVG still embeds an image or data: reference after sanitizing" };
  }
  return { ok: true, svg: res.svg, removed: res.removed, width: w, height: h };
}
