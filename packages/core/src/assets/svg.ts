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

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * True when the bytes look like an SVG document: optional BOM and whitespace, one XML
 * declaration, comments and a DOCTYPE without internal subset, then `<svg`. A linear scan (no
 * backtracking) over at most `maxBytes` bytes.
 */
export function looksLikeSvg(bytes: Uint8Array, maxBytes = 262_144): boolean {
  const t = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
  let i = 0;
  const skipWs = (): void => {
    while (i < t.length && (isWs(t.charCodeAt(i)) || t.charCodeAt(i) === 0xfeff)) i++;
  };
  skipWs();
  if (t.startsWith("<?xml", i)) {
    const e = t.indexOf("?>", i);
    if (e < 0) return false;
    i = e + 2;
  }
  for (;;) {
    skipWs();
    if (t.startsWith("<!--", i)) {
      const e = t.indexOf("-->", i + 4);
      if (e < 0) return false;
      i = e + 3;
    } else if (t.startsWith("<!DOCTYPE", i)) {
      const e = t.indexOf(">", i);
      if (e < 0) return false;
      const sub = t.indexOf("[", i);
      if (sub >= 0 && sub < e) return false; // internal subset (entities)
      i = e + 1;
    } else break;
  }
  if (!t.startsWith("<svg", i)) return false;
  const c = t.charCodeAt(i + 4);
  return isWs(c) || c === 0x3e || c === 0x2f;
}

/** Labels (from the sanitizer) that mean active content was present, not just cosmetics. */
export function isActiveRemoval(label: string): boolean {
  return (
    /^element:(script|foreignObject|iframe|object|embed)$/i.test(label) || /^attr:on/i.test(label)
  );
}

/**
 * Image SVGs embed no rasters or nested images: removes every `<image>` element and any
 * `href`/`xlink:href` with a `data:` value from sanitizer output (which is well formed, with
 * `<`, `>` and `"` escaped in attribute values). Linear scan.
 */
function stripNested(body: string, removed: string[]): string {
  let out = body;
  let at = 0;
  let hit = false;
  for (;;) {
    const s = out.indexOf("<image", at);
    if (s < 0) break;
    const c = out.charCodeAt(s + 6);
    if (!(isWs(c) || c === 0x3e || c === 0x2f)) {
      at = s + 6;
      continue;
    }
    const gt = out.indexOf(">", s);
    if (gt < 0) {
      out = out.slice(0, s);
      hit = true;
      break;
    }
    let end = gt + 1;
    if (out.charCodeAt(gt - 1) !== 0x2f) {
      let depth = 1;
      let p = end;
      while (depth > 0) {
        const o = out.indexOf("<image", p);
        const cl = out.indexOf("</image>", p);
        if (cl < 0) {
          p = out.length;
          break;
        }
        if (o >= 0 && o < cl) {
          depth++;
          p = o + 6;
        } else {
          depth--;
          p = cl + 8;
        }
      }
      end = p;
    }
    out = out.slice(0, s) + out.slice(end);
    hit = true;
    at = s;
  }
  if (hit) removed.push("element:image");
  const cleaned = out.replace(/ (?:xlink:)?href="data:[^"]*"/gi, "");
  if (cleaned !== out) removed.push("attr:href-data");
  return cleaned;
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
  const removed = [...res.removed];
  const body = stripNested(res.svg.body, removed);
  const svg = body === res.svg.body ? res.svg : { ...res.svg, body };
  return { ok: true, svg, removed, width: w, height: h };
}
