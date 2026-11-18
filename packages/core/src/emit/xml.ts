import type { SvgElement, SvgNode, SvgRaw } from "../contracts/index.js";
import { fmt } from "../geometry/index.js";

/**
 * The only SVG serializer (contracts/svg.ts emitter rules): escaping, name validation,
 * reference checks and number formatting live here.
 */

const NAME_RE = /^[A-Za-z][\w:.-]*$/;

/** Strip lone surrogates and characters that are invalid in XML 1.0. */
export function sanitizeXmlText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + (s[i + 1] as string);
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xfffd)) out += s[i];
  }
  return out;
}

export function escapeText(s: string): string {
  return sanitizeXmlText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Wrap trusted markup. Only the emitter and the icon sanitizer may call this. */
export function raw(markup: string): SvgRaw {
  return { raw: markup } as unknown as SvgRaw;
}

function isRaw(n: SvgNode): n is SvgRaw {
  return typeof n === "object" && "raw" in n;
}

function checkAttr(name: string, value: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid attribute name: ${name}`);
  if (/^on/i.test(name)) throw new Error(`event handler attribute not allowed: ${name}`);
  if (name === "href" || name === "xlink:href") {
    if (!value.startsWith("#")) throw new Error(`external reference not allowed in ${name}`);
  }
  if (/url\(\s*(?!['"]?\s*#)/i.test(value))
    throw new Error(`url() must reference a fragment: ${name}`);
}

function serializeElement(el: SvgElement, out: string[]): void {
  if (!NAME_RE.test(el.tag)) throw new Error(`invalid tag name: ${el.tag}`);
  out.push("<", el.tag);
  if (el.attrs) {
    for (const [k, v] of Object.entries(el.attrs)) {
      const value = typeof v === "number" ? fmt(v) : v;
      checkAttr(k, value);
      out.push(" ", k, '="', escapeAttr(value), '"');
    }
  }
  const kids = el.children;
  if (!kids || kids.length === 0) {
    out.push("/>");
    return;
  }
  out.push(">");
  for (const kid of kids) serializeNode(kid, out);
  out.push("</", el.tag, ">");
}

function serializeNode(node: SvgNode, out: string[]): void {
  if (typeof node === "string") out.push(escapeText(node));
  else if (isRaw(node)) out.push(node.raw);
  else serializeElement(node, out);
}

export function serialize(node: SvgNode): string {
  const out: string[] = [];
  serializeNode(node, out);
  return out.join("");
}

/** Hyperscript helper: `h("rect", { x: 1 }, child, ...)`. */
export function h(
  tag: string,
  attrs?: Readonly<Record<string, string | number>> | null,
  ...children: readonly (SvgNode | null | undefined | false)[]
): SvgElement {
  const kids = children.filter((c): c is SvgNode => c !== null && c !== undefined && c !== false);
  return {
    tag,
    ...(attrs ? { attrs } : {}),
    ...(kids.length ? { children: kids } : {}),
  };
}

/** CSS text goes in a CDATA section; `]]>` would terminate it, so it is rejected. */
export function cdata(css: string): SvgRaw {
  if (css.includes("]]>")) throw new Error("CSS contains ']]>'");
  return raw(`<![CDATA[${sanitizeXmlText(css)}]]>`);
}
