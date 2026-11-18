/**
 * Allowlist-based SVG sanitizer (security-sensitive). Parses with a small strict XML
 * reader (no entity expansion, no DTD subsets), keeps only allowlisted elements and
 * attributes with strictly validated values, inlines simple `<style>` rules as
 * presentation attributes, rewrites ids to the `__PCID__-<n>` placeholder and returns an
 * inner body without the `<svg>` wrapper.
 */
import type { SanitizeResult, SvgSanitizer } from "../contracts/index.js";

const DEFAULT_MAX_BYTES = 65536;
const MAX_DEPTH = 48;
const MAX_NODES = 4000;
const MAX_ATTRS = 64;
const MAX_USE = 48;
const MAX_VALUE_LENGTH = 100_000;

class Reject extends Error {}

interface XNode {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly children: (XNode | string)[];
}

const NAME_RE = /^[A-Za-z_][\w:.-]*$/;
const ATTR_RE = /\s+([^\s=/>"'<]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6};|#[0-9]{1,7};|[A-Za-z][\w.-]*;)?/g, (_m, ref?: string) => {
    if (ref === undefined) throw new Reject("malformed entity reference");
    const body = ref.slice(0, -1);
    if (body[0] === "#") {
      const cp = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const ok =
        cp === 9 ||
        cp === 10 ||
        cp === 13 ||
        (cp >= 0x20 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff);
      if (!ok) throw new Reject("invalid character reference");
      return String.fromCodePoint(cp);
    }
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        throw new Reject(`custom entity &${body.slice(0, 20)}; is not allowed`);
    }
  });
}

function parseXml(input: string, removed: Set<string>): XNode {
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = input.length;
  const stack: XNode[] = [];
  let root: XNode | undefined;
  let count = 0;
  while (i < n) {
    if (input[i] !== "<") {
      const j = input.indexOf("<", i);
      const end = j === -1 ? n : j;
      const text = input.slice(i, end);
      const top = stack[stack.length - 1];
      if (top) top.children.push(decodeEntities(text));
      else if (text.trim() !== "") throw new Reject("text outside the root element");
      i = end;
      continue;
    }
    if (input.startsWith("<!--", i)) {
      const e = input.indexOf("-->", i + 4);
      if (e === -1) throw new Reject("unterminated comment");
      i = e + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      const e = input.indexOf("]]>", i + 9);
      if (e === -1) throw new Reject("unterminated CDATA");
      const top = stack[stack.length - 1];
      if (!top) throw new Reject("CDATA outside the root element");
      top.children.push(input.slice(i + 9, e));
      i = e + 3;
      continue;
    }
    if (input.startsWith("<?", i)) {
      const e = input.indexOf("?>", i + 2);
      if (e === -1) throw new Reject("unterminated processing instruction");
      removed.add("processing-instruction");
      i = e + 2;
      continue;
    }
    if (input.startsWith("<!", i)) {
      if (!/^<!DOCTYPE\s/i.test(input.slice(i, i + 10)))
        throw new Reject("unsupported declaration");
      const e = input.indexOf(">", i);
      if (e === -1) throw new Reject("unterminated DOCTYPE");
      const decl = input.slice(i, e);
      if (decl.includes("[") || decl.includes("<", 2) || /ENTITY/i.test(decl)) {
        throw new Reject("DTD with internal subset or entities is not allowed");
      }
      if (root || stack.length) throw new Reject("DOCTYPE inside the document");
      removed.add("doctype");
      i = e + 1;
      continue;
    }
    if (input[i + 1] === "/") {
      const e = input.indexOf(">", i);
      if (e === -1) throw new Reject("unterminated end tag");
      const name = input.slice(i + 2, e).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new Reject("mismatched end tag");
      i = e + 1;
      continue;
    }
    // Start tag.
    const m = /^<([A-Za-z_][\w:.-]*)/.exec(input.slice(i, i + 256));
    if (!m || !m[1]) throw new Reject("malformed tag");
    const name = m[1];
    let p = i + m[0].length;
    const attrs = new Map<string, string>();
    for (;;) {
      ATTR_RE.lastIndex = p;
      const am = ATTR_RE.exec(input);
      if (!am || am[1] === undefined) break;
      const aname = am[1];
      if (!NAME_RE.test(aname)) throw new Reject("malformed attribute name");
      if (attrs.has(aname)) throw new Reject("duplicate attribute");
      if (attrs.size >= MAX_ATTRS) throw new Reject("too many attributes");
      attrs.set(aname, decodeEntities(am[2] ?? am[3] ?? ""));
      p = ATTR_RE.lastIndex;
    }
    while (p < n && /\s/.test(input[p] as string)) p++;
    let selfClose = false;
    if (input[p] === "/") {
      selfClose = true;
      p++;
    }
    if (input[p] !== ">") throw new Reject("malformed start tag");
    i = p + 1;
    if (++count > MAX_NODES) throw new Reject("too many elements");
    const node: XNode = { name, attrs, children: [] };
    const top = stack[stack.length - 1];
    if (top) top.children.push(node);
    else if (root) throw new Reject("multiple root elements");
    else root = node;
    if (!selfClose) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new Reject("nesting too deep");
    }
  }
  if (stack.length) throw new Reject("unclosed element");
  if (!root) throw new Reject("no root element");
  if (root.name !== "svg") throw new Reject("root element is not <svg>");
  return root;
}

// --- allowlists ---------------------------------------------------------------

const ELEMENTS = new Set([
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "use",
  "image",
]);

/** Presentation properties: valid as attributes and as CSS declarations. */
const PRESENTATION = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "stop-color",
  "stop-opacity",
  "display",
  "visibility",
  "color",
  "vector-effect",
]);

const GEOMETRY = new Set([
  "d",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "transform",
  "fx",
  "fy",
  "fr",
  "offset",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "preserveAspectRatio",
  "pathLength",
]);

const ROOT_IGNORED = new Set(["viewBox", "width", "height", "version", "preserveAspectRatio"]);
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]*$/;
const GENERIC_RE = /^[#\w(),.%\s\-+/:]*$/;
const URL_REF_RE = /url\(\s*(['"]?)#([\w.:/-]+)\1\s*\)/gi;
const DATA_IMG_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]*$/;
const ID_RE = /^[A-Za-z0-9_][\w.:/-]*$/;
const FORBIDDEN_RE = /javascript:|vbscript:|data:|expression\s*\(|@import|<|\\/i;

/** True when `value` is a safe attribute value (references are checked/mapped later). */
function valueOk(name: string, value: string): boolean {
  if (value.length > MAX_VALUE_LENGTH) return false;
  if (FORBIDDEN_RE.test(value)) return false;
  // Every `url(` must be a local `#id` reference.
  const stripped = value.replace(URL_REF_RE, "");
  if (/url\s*\(/i.test(stripped)) return false;
  return (name === "d" ? PATH_RE : GENERIC_RE).test(stripped);
}

// --- CSS inlining ---------------------------------------------------------------

const MAX_RULES = 512;
const MAX_SELECTORS_PER_RULE = 16;
const MAX_CLASSES_PER_NODE = 64;

interface CssRule {
  readonly tag: string | undefined;
  readonly classes: readonly string[];
  readonly specificity: number;
  readonly order: number;
  readonly decls: readonly (readonly [string, string])[];
}

/** Report-safe label: only `[\w-]` characters survive in the name part. */
function label(kind: string, name: string): string {
  return `${kind}:${name.replace(/[^\w-]/g, "_").slice(0, 40)}`;
}

function parseDecls(text: string, removed: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  for (const part of text.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    let val = part.slice(idx + 1).trim();
    if (val.toLowerCase().endsWith("!important")) val = val.slice(0, -10).trim();
    if (!PRESENTATION.has(prop)) {
      removed.add(label("css-property", prop));
      continue;
    }
    out.push([prop, val]);
  }
  return out;
}

/** Linear comment stripper (an unterminated comment swallows the rest, as in CSS). */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const s = css.indexOf("/*", i);
    if (s < 0) return out + css.slice(i);
    out += `${css.slice(i, s)} `;
    const e = css.indexOf("*/", s + 2);
    if (e < 0) return out;
    i = e + 2;
  }
}

const SELECTOR_RE = /^([A-Za-z][\w-]*|\*)?((?:\.[A-Za-z_][\w-]*)*)$/;

function parseStyleSheet(css: string, removed: Set<string>, startOrder: number): CssRule[] {
  const text = stripComments(css);
  if (text.includes("@") || /url\s*\(/i.test(text.replace(URL_REF_RE, "")) || text.includes("\\")) {
    removed.add("style:unsafe-css");
    return [];
  }
  const rules: CssRule[] = [];
  let order = startOrder;
  let i = 0;
  for (;;) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const close = text.indexOf("}", open + 1);
    if (close < 0) break;
    const nested = text.indexOf("{", open + 1);
    if (nested >= 0 && nested < close) {
      removed.add("style:nested-block");
      break;
    }
    if (order >= MAX_RULES) {
      removed.add("style:rule-limit");
      break;
    }
    const decls = parseDecls(text.slice(open + 1, close), removed);
    const selectors = text.slice(i, open).split(",");
    if (selectors.length > MAX_SELECTORS_PER_RULE) removed.add("style:selector-limit");
    for (const sel of selectors.slice(0, MAX_SELECTORS_PER_RULE)) {
      const s = sel.trim();
      const sm = SELECTOR_RE.exec(s);
      if (!s || !sm) {
        removed.add("css-selector");
        continue;
      }
      const tag = sm[1] && sm[1] !== "*" ? sm[1] : undefined;
      const classes = (sm[2] ?? "").split(".").filter(Boolean);
      rules.push({
        tag,
        classes,
        specificity: (tag ? 1 : 0) + classes.length * 10,
        order: order++,
        decls,
      });
    }
    i = close + 1;
  }
  return rules;
}

/** Rules pre-indexed by first class, tag and a universal bucket. */
interface RuleIndex {
  readonly byTag: Map<string, CssRule[]>;
  readonly byClass: Map<string, CssRule[]>;
  readonly universal: CssRule[];
}

function indexRules(rules: readonly CssRule[]): RuleIndex {
  const idx: RuleIndex = { byTag: new Map(), byClass: new Map(), universal: [] };
  const push = (m: Map<string, CssRule[]>, k: string, r: CssRule): void => {
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  };
  for (const r of rules) {
    if (r.classes[0] !== undefined) push(idx.byClass, r.classes[0], r);
    else if (r.tag !== undefined) push(idx.byTag, r.tag, r);
    else idx.universal.push(r);
  }
  return idx;
}

function collectStyleText(node: XNode, out: string[]): void {
  for (const c of node.children) {
    if (typeof c === "string") continue;
    if (c.name === "style")
      out.push(c.children.filter((x): x is string => typeof x === "string").join(""));
    else collectStyleText(c, out);
  }
}

// --- sanitized tree ---------------------------------------------------------------

interface KNode {
  readonly name: string;
  readonly attrs: [string, string][];
  readonly children: KNode[];
}

interface Ctx {
  readonly removed: Set<string>;
  readonly rules: RuleIndex;
  readonly monochrome: boolean;
  uses: number;
  readonly seenIds: Set<string>;
}

function effectiveAttrs(node: XNode, ctx: Ctx): Map<string, string> {
  const attrs = new Map(node.attrs);
  const classes = new Set(
    (attrs.get("class") ?? "").split(/\s+/).filter(Boolean).slice(0, MAX_CLASSES_PER_NODE),
  );
  const candidates = new Set<CssRule>(ctx.rules.universal);
  for (const r of ctx.rules.byTag.get(node.name) ?? []) candidates.add(r);
  for (const c of classes) for (const r of ctx.rules.byClass.get(c) ?? []) candidates.add(r);
  const matching = [...candidates]
    .filter(
      (r) => (r.tag === undefined || r.tag === node.name) && r.classes.every((c) => classes.has(c)),
    )
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const r of matching) for (const [k, v] of r.decls) attrs.set(k, v);
  const style = attrs.get("style");
  if (style !== undefined) {
    for (const [k, v] of parseDecls(style, ctx.removed)) attrs.set(k, v);
  }
  return attrs;
}

/**
 * Monochrome mode: fills and strokes become `currentColor` (`none`, `inherit`, `transparent`
 * and `currentColor` are kept; gradient paint servers keep their url but their `stop-color`s
 * are rewritten to `currentColor` so the result stays single-colored).
 */
function monoValue(name: string, value: string): string {
  if (name === "stop-color") return "currentColor";
  if (
    (name === "fill" || name === "stroke") &&
    value !== "none" &&
    value !== "inherit" &&
    value !== "transparent" &&
    value !== "currentColor" &&
    !/url\(/i.test(value)
  ) {
    return "currentColor";
  }
  return value;
}

function keepAttrs(
  node: XNode,
  attrs: Map<string, string>,
  ctx: Ctx,
  isRoot: boolean,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, rawValue] of attrs) {
    if (name === "class" || name === "style") continue;
    // Root bookkeeping attributes are consumed separately (viewBox) or intentionally dropped.
    if (isRoot && (name.startsWith("xmlns") || ROOT_IGNORED.has(name))) continue;
    const value = rawValue.trim();
    if (name === "id") {
      if (isRoot) continue;
      if (ID_RE.test(value) && !ctx.seenIds.has(value)) {
        ctx.seenIds.add(value);
        out.push(["id", value]);
      } else ctx.removed.add("attr:id");
      continue;
    }
    if (name === "href" || name === "xlink:href") {
      const isImage = node.name === "image";
      const takesHref =
        node.name === "use" ||
        isImage ||
        node.name === "linearGradient" ||
        node.name === "radialGradient" ||
        node.name === "pattern";
      const ok = takesHref && (isImage ? DATA_IMG_RE.test(value) : /^#[^\s#]+$/.test(value));
      if (ok && !out.some(([k]) => k === "href")) out.push(["href", value]);
      else ctx.removed.add(label("attr", name));
      continue;
    }
    if (!PRESENTATION.has(name) && !GEOMETRY.has(name)) {
      ctx.removed.add(label("attr", name));
      continue;
    }
    if (!valueOk(name, value)) {
      ctx.removed.add(label("attr", name));
      continue;
    }
    out.push([name, ctx.monochrome ? monoValue(name, value) : value]);
  }
  return out;
}

function sanitizeNode(node: XNode, ctx: Ctx): KNode | undefined {
  if (!ELEMENTS.has(node.name)) {
    ctx.removed.add(label("element", node.name));
    return undefined;
  }
  if (node.name === "use" && ++ctx.uses > MAX_USE) {
    ctx.removed.add("element:use-limit");
    return undefined;
  }
  const attrs = keepAttrs(node, effectiveAttrs(node, ctx), ctx, false);
  const children: KNode[] = [];
  for (const c of node.children) {
    if (typeof c === "string") continue;
    const k = sanitizeNode(c, ctx);
    if (k) children.push(k);
  }
  return { name: node.name, attrs, children };
}

/** Expanded element count per sanitized icon (local; no contract change). */
const costs = new WeakMap<object, number>();

/** Elements one placement of this sanitized icon renders (with `<use>` expanded). */
export function sanitizedCost(svg: object): number | undefined {
  return costs.get(svg);
}

const REF_CONTAINERS = new Set(["mask", "clipPath", "pattern"]);

/**
 * Reference depth 1: inside a mask, clipPath or pattern, `url(#x)` / `href` references that point
 * at another mask, clipPath or pattern are dropped, so those cannot chain or nest.
 */
function limitRefDepth(kept: KNode[], removed: Set<string>): void {
  const byId = new Map<string, KNode>();
  const index = (ns: readonly KNode[]): void => {
    for (const n of ns) {
      for (const [k, v] of n.attrs) if (k === "id") byId.set(v, n);
      index(n.children);
    }
  };
  index(kept);
  const visit = (ns: readonly KNode[], inside: boolean): void => {
    for (const n of ns) {
      const here = inside || REF_CONTAINERS.has(n.name);
      if (here) {
        for (let i = n.attrs.length - 1; i >= 0; i--) {
          const [k, v] = n.attrs[i] as [string, string];
          let targets: string[] = [];
          if (k === "href") targets = [v.slice(1)];
          else for (const m of v.matchAll(URL_REF_RE)) targets.push(m[2] as string);
          if (targets.some((t) => REF_CONTAINERS.has(byId.get(t)?.name ?? ""))) {
            n.attrs.splice(i, 1);
            removed.add("ref-depth");
          }
        }
      }
      if (here) {
        // `<use>` is not allowed anywhere inside a mask, clipPath or pattern.
        for (let i = n.children.length - 1; i >= 0; i--) {
          if ((n.children[i] as KNode).name === "use") {
            n.children.splice(i, 1);
            removed.add("element:use-in-ref");
          }
        }
      }
      visit(n.children, here);
    }
  };
  visit(kept, false);
}

/** Upper bound on rendered instances once every `<use>` is expanded. */
const MAX_EXPANDED = 2000;

/**
 * Defeats `<use>` amplification: a `<use>` whose target is (or contains) another `<use>` or a
 * `<pattern>` is dropped, so nesting cannot multiply; the expanded node count is then capped by
 * dropping the last remaining `<use>` elements.
 */
function pruneUses(kept: KNode[], removed: Set<string>): { kept: KNode[]; total: number } {
  const byId = new Map<string, KNode>();
  const uses: KNode[] = [];
  const walk = (ns: readonly KNode[]): void => {
    for (const n of ns) {
      for (const [k, v] of n.attrs) if (k === "id") byId.set(v, n);
      if (n.name === "use") uses.push(n);
      walk(n.children);
    }
  };
  walk(kept);
  const risky = new Map<KNode, boolean>();
  const isRisky = (n: KNode): boolean => {
    const c = risky.get(n);
    if (c !== undefined) return c;
    // Risky: another <use>, a <pattern>, or any url()/href reference to a mask, clipPath or
    // pattern (such references multiply rendering work when the target is instantiated per <use>).
    const refsContainer = n.attrs.some(([k, v]) => {
      if (k === "id") return false;
      const ids =
        k === "href" ? [v.slice(1)] : [...v.matchAll(URL_REF_RE)].map((m) => m[2] as string);
      return ids.some((id) => REF_CONTAINERS.has(byId.get(id)?.name ?? ""));
    });
    const r = n.name === "use" || n.name === "pattern" || refsContainer || n.children.some(isRisky);
    risky.set(n, r);
    return r;
  };
  const size = new Map<KNode, number>();
  const sizeOf = (n: KNode): number => {
    const c = size.get(n);
    if (c !== undefined) return c;
    let s = 1;
    for (const ch of n.children) s += sizeOf(ch);
    size.set(n, s);
    return s;
  };
  const targetOf = (u: KNode): KNode | undefined => {
    const href = u.attrs.find(([k]) => k === "href")?.[1];
    return href === undefined ? undefined : byId.get(href.slice(1));
  };
  const drop = new Set<KNode>();
  for (const u of uses) {
    const t = targetOf(u);
    if (t && isRisky(t)) drop.add(u);
  }
  let total = kept.reduce((s, n) => s + sizeOf(n), 0);
  const live = uses.filter((u) => !drop.has(u));
  const cost = (u: KNode): number => {
    const t = targetOf(u);
    return t ? sizeOf(t) : 0;
  };
  total += live.reduce((s, u) => s + cost(u), 0);
  while (total > MAX_EXPANDED && live.length) {
    const u = live.pop() as KNode;
    total -= cost(u);
    drop.add(u);
  }
  if (drop.size === 0) return { kept, total };
  removed.add("element:use-limit");
  const filter = (ns: readonly KNode[]): KNode[] =>
    ns.filter((n) => !drop.has(n)).map((n) => ({ ...n, children: filter(n.children) }));
  return { kept: filter(kept), total };
}

// --- serialization ---------------------------------------------------------------

function esc(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) continue; // XML-invalid control chars
    if (c === 0xfffe || c === 0xffff) continue;
    out +=
      ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch;
  }
  return out;
}

function collectIds(nodes: readonly KNode[], order: string[]): void {
  for (const n of nodes) {
    for (const [k, v] of n.attrs) if (k === "id") order.push(v);
    collectIds(n.children, order);
  }
}

/** Rewrites internal references; returns undefined when a reference dangles. */
function mapRefs(
  name: string,
  value: string,
  ids: ReadonlyMap<string, string>,
): string | undefined {
  if (name === "href") {
    if (!value.startsWith("#")) return value; // data: image, already validated
    const t = ids.get(value.slice(1));
    return t === undefined ? undefined : `#${t}`;
  }
  let dangling = false;
  const out = value.replace(URL_REF_RE, (_m, _q: string, id: string) => {
    const t = ids.get(id);
    if (t === undefined) {
      dangling = true;
      return "";
    }
    return `url(#${t})`;
  });
  return dangling ? undefined : out;
}

function serialize(
  nodes: readonly KNode[],
  ids: ReadonlyMap<string, string>,
  removed: Set<string>,
): string {
  let out = "";
  for (const n of nodes) {
    let attrs = "";
    let drop = false;
    for (const [k, v] of n.attrs) {
      const mv = k === "id" ? ids.get(v) : mapRefs(k, v, ids);
      if (mv === undefined) {
        removed.add(label("dangling", k));
        if (k === "href" && n.name === "use") drop = true; // a <use> without target is meaningless
        continue;
      }
      attrs += ` ${k}="${esc(mv)}"`;
    }
    if (drop) continue;
    if (n.name === "use" && !attrs.includes(" href=")) continue;
    const inner = serialize(n.children, ids, removed);
    out += inner ? `<${n.name}${attrs}>${inner}</${n.name}>` : `<${n.name}${attrs}/>`;
  }
  return out;
}

function numberOf(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)(?:px)?\s*$/i.exec(v);
  return m && m[1] ? Number(m[1]) : undefined;
}

function viewBoxOf(root: Map<string, string>): string | undefined {
  const vb = root.get("viewBox");
  if (vb !== undefined) {
    const parts = vb
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x))) return undefined;
    const [x, y, w, h] = parts as [number, number, number, number];
    if (w <= 0 || h <= 0 || w > 1e5 || h > 1e5) return undefined;
    return `${x} ${y} ${w} ${h}`;
  }
  const w = numberOf(root.get("width"));
  const h = numberOf(root.get("height"));
  if (w && h && w <= 1e5 && h <= 1e5) return `0 0 ${w} ${h}`;
  return undefined;
}

export const sanitizeSvg: SvgSanitizer = (input, options): SanitizeResult => {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (typeof input !== "string") return { ok: false, reason: "input is not a string" };
  if (input.length > maxBytes || new TextEncoder().encode(input).length > maxBytes) {
    return { ok: false, reason: `input exceeds ${maxBytes} bytes` };
  }
  const removed = new Set<string>();
  try {
    const root = parseXml(input, removed);
    const styleTexts: string[] = [];
    collectStyleText(root, styleTexts);
    const rules: CssRule[] = [];
    for (const t of styleTexts) rules.push(...parseStyleSheet(t, removed, rules.length));
    const ctx: Ctx = {
      removed,
      rules: indexRules(rules),
      monochrome: options?.monochrome === true,
      uses: 0,
      seenIds: new Set(),
    };
    const rootAttrs = effectiveAttrs(root, ctx);
    const viewBox = viewBoxOf(rootAttrs);
    if (viewBox === undefined) return { ok: false, reason: "missing or invalid viewBox" };
    const wrapper = keepAttrs(root, rootAttrs, ctx, true).filter(([k]) => PRESENTATION.has(k));
    if (ctx.monochrome && !wrapper.some(([k]) => k === "fill"))
      wrapper.unshift(["fill", "currentColor"]);
    const built: KNode[] = [];
    for (const c of root.children) {
      if (typeof c === "string") continue;
      const k = sanitizeNode(c, ctx);
      if (k) built.push(k);
    }
    limitRefDepth(built, removed);
    const pruned = pruneUses(built, removed);
    const kept = pruned.kept;
    const order: string[] = [];
    collectIds(kept, order);
    const ids = new Map<string, string>();
    order.forEach((id, idx) => ids.set(id, `__PCID__-${idx}`));
    let body = serialize(kept, ids, removed);
    if (wrapper.length) {
      let wa = "";
      for (const [k, v] of wrapper) {
        const mv = mapRefs(k, v, ids);
        if (mv !== undefined) wa += ` ${k}="${esc(mv)}"`;
      }
      body = `<g${wa}>${body}</g>`;
    }
    const svg = { viewBox, body, monochrome: ctx.monochrome };
    costs.set(svg, pruned.total);
    return { ok: true, svg, removed: [...removed] };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.message };
    return { ok: false, reason: "unparseable SVG" };
  }
};
