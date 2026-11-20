/**
 * SVG images (§11.2): UTF-8 text with an `<svg` root, run through the icon sanitizer
 * (allowlist; scripts, handlers, foreignObject, external references removed).
 */
import type { SanitizedSvg } from "../contracts/index.js";
import { sanitizeSvg } from "../icons/sanitize.js";

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

/** True when the bytes look like an SVG document: optional BOM, XML declaration, comments, `<svg`. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i.test(head);
}

export function cleanSvg(bytes: Uint8Array, maxBytes: number): SvgOk | SvgFail {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: "SVG is not valid UTF-8 text" };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const res = sanitizeSvg(text, { maxBytes });
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
  return { ok: true, svg: res.svg, removed: res.removed, width: w, height: h };
}
