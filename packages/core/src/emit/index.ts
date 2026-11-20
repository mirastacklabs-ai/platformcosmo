import type {
  AnimationLayer,
  EmitFn,
  EmitOptions,
  ImageAsset,
  Layer,
  RenderModel,
  SvgElement,
  SvgNode,
  SvgRaw,
} from "../contracts/index.js";
import { fmt } from "../geometry/index.js";
import {
  EMBED_MONO_FAMILY,
  fallbackText,
  subsetWoff2Base64,
  textToPath,
  type TextAnchor,
  type TextFamily,
} from "../text/index.js";
import {
  classRules,
  declarations,
  inlineVars,
  stateRules,
  stripAtRules,
  themeVars,
  varDiff,
} from "./styles.js";
import { boardsOf } from "../render/boards/types.js";
import { createIds } from "./ids.js";
import { cdata, escapeAttr, h, raw, serialize } from "./xml.js";

export { createIds, cssEscapeId } from "./ids.js";
export { themeVars } from "./styles.js";
export { serialize, h, raw, escapeText, escapeAttr, cdata } from "./xml.js";

/**
 * Placeholder element the model builder uses to hand an icon to the emitter (which alone may
 * create `SvgRaw`): `{ tag, attrs: { ref, viewBox }, children: [sanitizedBodyString] }`.
 * Emit hoists each one (deduplicated by ref) into `<defs>` as a `<symbol>`.
 */
export const ICON_DEF_TAG = "pc-icon-def";

/**
 * Placeholder `{ tag, attrs: { hash } }` the model builder uses for an image asset (schema
 * 1.2.0). Emit hoists each one, once per hash, into `<defs>` as an `<image>` (raster) or a
 * `<symbol>` (SVG), reading the asset from the model's boards data and base64-encoding the
 * bytes itself (§11.3).
 */
export const IMAGE_DEF_TAG = "pc-image-def";

/** The only `data:` href the emitter writes (§11.3); anything else is refused. */
export const DATA_HREF_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

/** Throws unless `href` is a PNG or JPEG data URI of standard base64 (§11.3). */
export function assertDataHref(href: string): void {
  if (!DATA_HREF_RE.test(href)) throw new Error("data: href is not a base64 PNG or JPEG data URI");
}

function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Affine matrix that turns the stored pixels of an EXIF-oriented image (stored `w`×`h`) upright
 * (§11.2): the `<image>` in `<defs>` carries it, so every use, crop and decal sees the upright
 * picture. Orientation 1 (and anything else) is the identity.
 */
export function orientationMatrix(orientation: number, w: number, h: number): string | undefined {
  switch (orientation) {
    case 2:
      return `matrix(-1 0 0 1 ${w} 0)`;
    case 3:
      return `matrix(-1 0 0 -1 ${w} ${h})`;
    case 4:
      return `matrix(1 0 0 -1 0 ${h})`;
    case 5:
      return "matrix(0 1 1 0 0 0)";
    case 6:
      return `matrix(0 1 -1 0 ${h} 0)`;
    case 7:
      return `matrix(0 -1 -1 0 ${h} ${w})`;
    case 8:
      return `matrix(0 -1 1 0 0 ${w})`;
    default:
      return undefined;
  }
}

/** Tags the emitter never embeds from an image (the sanitizer already removes them). */
const BAD_TAG_NAME = /^(?:a|set|animate\w*|script|foreignObject|iframe|object|embed)\b/i;

/** Element name of a tag text (`<  /name ...`), found by index so no pattern can backtrack. */
function tagName(tag: string): string {
  let k = 1;
  while (k < tag.length && /\s/.test(tag[k] as string)) k++;
  if (tag[k] === "/") k++;
  while (k < tag.length && /\s/.test(tag[k] as string)) k++;
  return tag.slice(k, k + 32);
}
/** Attribute context only (a tag's text): handlers, external references, animation targets. */
const BAD_ATTRS = [
  /\son[a-z]+\s*=/i,
  /(?:href|src)\s*=\s*["'](?!#)/i,
  /\s(?:to|from|by|values)\s*=\s*["'][^"'#]/i,
];
const BAD_ANYWHERE = /javascript:|url\(\s*["']?(?!#)|@import/i;

/**
 * Defence in depth for a sanitized SVG body, with the reason it is refused, else undefined.
 * Linear: one pass over the tags (quotes respected, text between tags is not attribute context),
 * each pattern applied to one tag only, and no nested quantifiers.
 */
export function unsafeSvgBody(body: string): string | undefined {
  if (BAD_ANYWHERE.test(body)) return "script, external or import reference";
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    if (lt < 0) break;
    if (body.startsWith("<!--", lt)) {
      const end = body.indexOf("-->", lt + 4);
      if (end < 0) return "unterminated comment";
      i = end + 3;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    for (; j < body.length; j++) {
      const c = body[j] as string;
      if (quote !== "") {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= body.length) return "unterminated tag";
    const tag = body.slice(lt, j + 1);
    if (BAD_TAG_NAME.test(tagName(tag))) return "active or animation element";
    if (BAD_ATTRS.some((re) => re.test(tag))) return "event handler or external attribute";
    i = j + 1;
  }
  return undefined;
}

/** `<image>` (raster) or `<symbol>` (SVG) of an asset, in `<defs>`, under the id of its hash. */
function imageDefOf(asset: ImageAsset, id: string): SvgNode {
  if (asset.format === "svg") {
    const svg = asset.svg;
    const bad = svg === undefined ? "no SVG body" : unsafeSvgBody(svg.body);
    if (!svg || bad !== undefined)
      throw new Error(`image: SVG body is not sanitizer output (${bad})`);
    const body = svg.body.replaceAll("__PCID__-", `${id}_`).replaceAll("__PCID__", id);
    return h("symbol", { id, viewBox: svg.viewBox }, raw(body));
  }
  if (asset.mime !== "image/png" && asset.mime !== "image/jpeg") {
    throw new Error(`image: ${asset.mime} cannot be embedded`);
  }
  const swap = asset.orientation >= 5;
  const w = swap ? asset.height : asset.width;
  const hh = swap ? asset.width : asset.height;
  if (!Number.isInteger(w) || !Number.isInteger(hh) || w <= 0 || hh <= 0) {
    throw new Error("image: invalid size");
  }
  const href = `data:${asset.mime};base64,${base64Of(asset.data)}`;
  assertDataHref(href);
  const t = orientationMatrix(asset.orientation, w, hh);
  return raw(
    `<image id="${escapeAttr(id)}" href="${href}" width="${w}" height="${hh}" preserveAspectRatio="none"${t === undefined ? "" : ` transform="${t}"`}/>`,
  );
}

/** Animation attribute overrides (`AnimationLayer.attrs`): only these, with these values. */
const TRANSLATE_RE = /^translate\(-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?\)$/;
function checkedAttr(name: string, value: string | number): string | number {
  if (name === "transform" && typeof value === "string" && TRANSLATE_RE.test(value)) return value;
  if (name === "visibility" && (value === "hidden" || value === "visible")) return value;
  if (name === "opacity" && typeof value === "number" && value >= 0 && value <= 1) return value;
  throw new Error(`animation attribute ${name} is not allowed`);
}

/** Refuses any `data:` value in an element attribute: the emitter writes its own (§11.3). */
function refuseDataUris(node: SvgNode): void {
  walk(node, (el) => {
    for (const [k, v] of Object.entries(el.attrs ?? {})) {
      if (typeof v === "string" && /data\s*:/i.test(v)) {
        throw new Error(`data: URIs are only emitted for image assets in <defs> (attribute ${k})`);
      }
    }
  });
}

const LAYERS: readonly Layer[] = [
  "background",
  "groups",
  "edges",
  "flows",
  "objects",
  "labels",
  "overlay",
];

const SVG_NS = "http://www.w3.org/2000/svg";

type Mapper = (el: SvgElement) => SvgNode | null;

/** Depth-first rewrite; the mapper sees each element after its children were rewritten. */
function mapTree(node: SvgNode, fn: Mapper): SvgNode | null {
  if (typeof node === "string" || "raw" in node) return node;
  const kids = node.children?.map((c) => mapTree(c, fn)).filter((c): c is SvgNode => c !== null);
  const el: SvgElement = kids ? { ...node, children: kids } : node;
  return fn(el);
}

function walk(node: SvgNode, fn: (el: SvgElement) => void): void {
  if (typeof node === "string" || "raw" in node) return;
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

function classesOf(el: SvgElement): string[] {
  const c = el.attrs?.class;
  return typeof c === "string" ? c.split(/\s+/).filter(Boolean) : [];
}

function without(
  attrs: Readonly<Record<string, string | number>> | undefined,
  ...names: string[]
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (!names.includes(k)) out[k] = v;
  return out;
}

/**
 * Plain text of a `<text>` element. `<text>` must contain only string children (no `tspan`):
 * emit rejects anything else in every font mode, and the animator relies on this.
 */
function textOf(el: SvgElement): string {
  let out = "";
  for (const c of el.children ?? []) {
    if (typeof c !== "string") throw new Error("text elements may only contain plain text");
    out += c;
  }
  return out;
}

function isBold(el: SvgElement, prefix: string): boolean {
  const w = Number(el.attrs?.["font-weight"]);
  return classesOf(el).includes(`${prefix}-tb`) || (Number.isFinite(w) && w >= 600);
}

function isMedium(el: SvgElement, prefix: string): boolean {
  return classesOf(el).includes(`${prefix}-tw`);
}

function isMono(el: SvgElement, prefix: string): boolean {
  return classesOf(el).includes(`${prefix}-tm`);
}

function rect(r: { x: number; y: number; width: number; height: number }): string {
  return `${fmt(r.x)} ${fmt(r.y)} ${fmt(r.width)} ${fmt(r.height)}`;
}

const UNSAFE_ICON =
  /<\s*(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|javascript:|(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i;

/**
 * Placeholder for an icon `<symbol>`: `body` must be a sanitizer-produced inner body (ids use
 * `__PCID__`). Defense in depth: bodies with scripts, handlers or non-fragment references are
 * rejected here even though the sanitizer already removes them.
 */
export function iconDef(ref: string, viewBox: string, body: string): SvgElement {
  if (UNSAFE_ICON.test(body)) throw new Error(`icon ${ref}: body is not sanitizer output`);
  return h(ICON_DEF_TAG, { ref, viewBox }, raw(body));
}

function iconSymbol(el: SvgElement, ids: RenderModel["ids"]): SvgElement {
  const ref = String(el.attrs?.ref ?? "");
  const viewBox = String(el.attrs?.viewBox ?? "0 0 24 24");
  const kid = el.children?.[0];
  if (!kid || typeof kid === "string" || !("raw" in kid) || el.children?.length !== 1) {
    throw new Error(`icon ${ref}: pc-icon-def must hold exactly one SvgRaw body (use iconDef)`);
  }
  const id = ids.icon(ref);
  const body = (kid as SvgRaw).raw;
  const resolved = body.replaceAll("__PCID__-", `${id}_`).replaceAll("__PCID__", id);
  return h("symbol", { id, viewBox }, raw(resolved));
}

export const emit: EmitFn = (
  model: RenderModel,
  animation: AnimationLayer,
  options: EmitOptions,
): string => {
  const { ids } = model;
  const prefix = ids.prefix;
  const raster = options.target === "raster";

  // 1. Layer content (model + animation), icon defs hoisted out.
  const symbols = new Map<string, SvgElement>();
  // Image assets (§11.3): one `<image>`/`<symbol>` per hash, from the bytes the model carries.
  const imageDefs = new Map<string, SvgNode>();
  const boardAssets = boardsOf(model)?.assets;
  // Assembly decals and billboards (A1-3) carry their assets on the assembly model.
  const asmAssets = (model.assembly as { assets?: ReadonlyMap<string, ImageAsset> } | undefined)
    ?.assets;
  const hoist: Mapper = (el) => {
    if (el.tag === IMAGE_DEF_TAG) {
      const hash = String(el.attrs?.hash ?? "");
      const asset = boardAssets?.get(hash) ?? asmAssets?.get(hash);
      if (asset === undefined) throw new Error("image placeholder has no asset");
      if (!imageDefs.has(hash))
        imageDefs.set(hash, imageDefOf(asset, createIds(prefix).image(hash)));
      return null;
    }
    if (el.tag !== ICON_DEF_TAG) return el;
    const ref = String(el.attrs?.ref ?? "");
    if (!symbols.has(ref)) symbols.set(ref, iconSymbol(el, ids));
    return null;
  };
  const noIcons: Mapper = (el) => {
    if (el.tag === ICON_DEF_TAG) throw new Error("animation output must not contain icon defs");
    if (el.tag === IMAGE_DEF_TAG) throw new Error("animation output must not contain image defs");
    return el;
  };
  // Attribute overrides by element id (frame and step outputs, resvg has no CSS animation).
  const overrides = animation.attrs;
  const override: Mapper = (el) => {
    const id = el.attrs?.id;
    const set = overrides !== undefined && typeof id === "string" ? overrides[id] : undefined;
    if (set === undefined) return el;
    const attrs: Record<string, string | number> = { ...el.attrs };
    for (const [k, v] of Object.entries(set)) attrs[k] = checkedAttr(k, v);
    return { ...el, attrs };
  };
  const layerNodes = new Map<Layer, SvgNode[]>();
  for (const layer of LAYERS) {
    const own = model.layers[layer]
      .map((n) => mapTree(n, hoist))
      .filter((n): n is SvgNode => n !== null);
    const extra = (animation.layers[layer] ?? [])
      .map((n) => mapTree(n, noIcons))
      .filter((n): n is SvgNode => n !== null);
    const nodes = [...own, ...extra];
    nodes.forEach(refuseDataUris);
    layerNodes.set(
      layer,
      overrides === undefined
        ? nodes
        : nodes.map((n) => mapTree(n, override)).filter((n): n is SvgNode => n !== null),
    );
  }
  const animDefs = animation.defs
    .map((n) => mapTree(n, noIcons))
    .filter((n): n is SvgNode => n !== null);
  animDefs.forEach(refuseDataUris);

  const vars = themeVars(model.theme);

  // 2. Raster: literal values instead of var(); text mode per options.
  const sub: Mapper = (el) => {
    if (!raster || !el.attrs) return el;
    let changed = false;
    const attrs: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(el.attrs)) {
      if (typeof v === "string" && v.includes("var(")) {
        attrs[k] = inlineVars(v, vars);
        changed = true;
      } else attrs[k] = v;
    }
    return changed ? { ...el, attrs } : el;
  };
  const outline: Mapper = (el) => {
    if (el.tag !== "text") return el;
    const a = el.attrs ?? {};
    const text = textOf(el);
    // Raster text with fallback glyphs (arrows) is outlined: resvg would pick one face for the
    // whole run, so per-glyph fallback only stays identical to the SVG when drawn as paths.
    if (options.font !== "outline" && !(raster && fallbackText(text) !== "")) return el;
    const bold = isBold(el, prefix);
    const { d } = textToPath(text, {
      x: Number(a.x ?? 0),
      y: Number(a.y ?? 0),
      size: Number(a["font-size"] ?? 12),
      weight: bold ? "bold" : isMedium(el, prefix) ? "medium" : "regular",
      family: isMono(el, prefix) ? "mono" : "display",
      anchor: (a["text-anchor"] as TextAnchor | undefined) ?? "start",
    });
    return h("path", { ...without(a, "x", "y", "font-size", "text-anchor", "font-weight"), d });
  };
  const finish = (n: SvgNode): SvgNode | null => {
    const a = mapTree(n, sub);
    return a === null ? null : mapTree(a, outline);
  };
  const layers = new Map<Layer, SvgNode[]>();
  for (const [layer, nodes] of layerNodes) {
    layers.set(
      layer,
      nodes.map(finish).filter((n): n is SvgNode => n !== null),
    );
  }
  const defsExtra = animDefs.map(finish).filter((n): n is SvgNode => n !== null);

  // D31: particles of DC flows (`dc_f_*`) are drawn after the objects layer so floors and
  // trays cannot cover them; every other flow stays in the contract `flows` layer. The split
  // is by flow id (`ids.flow`), so the animator's ids and selectors are untouched.
  const dcFlowPrefix = ids.flow("dc_f_");
  const dcParticles: SvgNode[] = [];
  let dcGroupId: string | undefined;
  layers.set(
    "flows",
    (layers.get("flows") ?? []).map((node) => {
      if (typeof node === "string" || "raw" in node || !node.children) return node;
      const isDc = (c: SvgNode) =>
        typeof c !== "string" &&
        !("raw" in c) &&
        typeof c.attrs?.id === "string" &&
        c.attrs.id.startsWith(dcFlowPrefix);
      const dc = node.children.filter(isDc);
      if (dc.length === 0 || typeof node.attrs?.id !== "string") return node;
      if (dcGroupId) throw new Error("expected a single particles wrapper with DC flows");
      dcGroupId = `${node.attrs.id}_dc`;
      dcParticles.push(h("g", { id: dcGroupId }, ...dc));
      return { ...node, children: node.children.filter((c) => !isDc(c)) };
    }),
  );
  // Reduced motion: in animated output the DC wrapper gets its own hide rule (CSS cannot pause
  // SMIL), next to the animator's rule for the main particles wrapper.
  let animationCss = animation.css;
  if (dcGroupId && animation.duration > 0) {
    animationCss += `\n@media (prefers-reduced-motion:reduce){${ids.sel(dcGroupId)}{display:none}}`;
  }

  // 3. Used classes and text, for rules and fonts.
  const used = new Set<string>();
  const text: Record<TextFamily, { regular: string; medium: string; bold: string }> = {
    display: { regular: "", medium: "", bold: "" },
    mono: { regular: "", medium: "", bold: "" },
  };
  const scan = (n: SvgNode): void =>
    walk(n, (el) => {
      for (const c of classesOf(el)) used.add(c);
      if (el.tag === "text") {
        const content = textOf(el);
        const mono = isMono(el, prefix);
        const bold = isBold(el, prefix);
        const t = text[mono ? "mono" : "display"];
        if (bold) t.bold += content;
        else if (!mono && isMedium(el, prefix)) t.medium += content;
        else t.regular += content;
        // Code points the display face lacks are drawn with the mono face (fallback).
        if (!mono) text.mono[bold ? "bold" : "regular"] += fallbackText(content);
      }
    });
  for (const nodes of layers.values()) nodes.forEach(scan);
  defsExtra.forEach(scan);

  // 4. CSS.
  const css: string[] = [];
  const family = vars.get("--pc-font-family") ?? "sans-serif";
  // Embedded faces are scoped to this diagram (`<prefix>-display`, `<prefix>-mono`, first in
  // their lists) so several inlined diagrams with different glyph subsets never share a global
  // family name.
  const embedFamily = { display: `${prefix}-display`, mono: `${prefix}-mono` } as const;
  const used_ = (f: TextFamily) =>
    text[f].regular !== "" || text[f].medium !== "" || text[f].bold !== "";
  const embedding = options.font === "embed";
  const embedded = {
    display: embedding && used_("display"),
    mono: embedding && used_("mono"),
  };
  const rootFamily = embedded.display
    ? `"${embedFamily.display}",${embedded.mono ? `"${embedFamily.mono}",` : ""}var(--pc-font-family)`
    : "var(--pc-font-family)";
  const rootRule = (v: ReadonlyMap<string, string>) =>
    `#${ids.root()}{${declarations(v)};font-family:${rootFamily};font-weight:var(--pc-font-weightRegular);text-rendering:geometricPrecision}`;
  if (!raster) {
    css.push(rootRule(vars));
    if (model.darkTheme) {
      const diff = varDiff(vars, themeVars(model.darkTheme));
      if (diff.size > 0) {
        css.push(`@media (prefers-color-scheme:dark){#${ids.root()}{${declarations(diff)}}}`);
      }
    }
    const face = (f: TextFamily, w: number, t: string, kind: "regular" | "medium" | "bold") =>
      `@font-face{font-family:"${embedFamily[f]}";font-style:normal;font-weight:${w};src:url(data:font/woff2;base64,${subsetWoff2Base64(t, kind, f)}) format("woff2")}`;
    for (const f of ["display", "mono"] as const) {
      if (!embedded[f]) continue;
      if (text[f].regular !== "") css.push(face(f, 400, text[f].regular, "regular"));
      if (text[f].medium !== "") css.push(face(f, 500, text[f].medium, "medium"));
      if (text[f].bold !== "") css.push(face(f, 700, text[f].bold, "bold"));
    }
  } else {
    css.push(
      `#${ids.root()}{font-family:${family},"${EMBED_MONO_FAMILY}";font-weight:${vars.get("--pc-font-weightRegular") ?? "400"}}`,
    );
  }
  const rules = [
    ...classRules(prefix, used, !raster && embedded.mono ? embedFamily.mono : undefined),
    ...stateRules(prefix, model.theme),
  ];
  if (raster) {
    css.push(...rules.map((r) => inlineVars(r, vars)));
    css.push(
      stripAtRules(inlineVars(animationCss, vars), [
        "media",
        "font-face",
        "keyframes",
        "-webkit-keyframes",
      ]),
    );
  } else {
    css.push(...rules);
    css.push(animationCss);
  }
  const cssText = css.filter((s) => s.trim() !== "").join("\n");

  // 5. Document.
  const defs: SvgNode[] = [];
  for (const ref of [...symbols.keys()].sort()) defs.push(symbols.get(ref) as SvgElement);
  for (const hash of [...imageDefs.keys()].sort()) defs.push(imageDefs.get(hash) as SvgNode);
  for (const e of model.scene.edges) {
    const p = model.edgePaths[e.id];
    if (e.hidden && p) defs.push(h("path", { id: ids.edgePath(e.id), d: p.d }));
  }
  defs.push(...defsExtra);

  const title = model.scene.meta.title ?? "PlatformCosmo diagram";
  const credits = boardsOf(model)?.desc ?? "";
  const desc =
    (model.scene.meta.description ??
      `Isometric architecture diagram with ${model.scene.objects.length} objects.`) +
    (credits === "" ? "" : ` ${credits}`);
  const camera = h(
    "g",
    { id: ids.camera() },
    ...LAYERS.flatMap((l) => {
      const group = h(
        "g",
        { id: `${prefix}-ly_${l}`, class: `${prefix}-layer` },
        ...(layers.get(l) ?? []),
      );
      // DC particles sit right after the objects layer, before labels.
      return l === "objects" && dcParticles.length > 0
        ? [group, h("g", { id: `${prefix}-ly_dcflows`, class: `${prefix}-layer` }, ...dcParticles)]
        : [group];
    }),
  );
  const root = h(
    "svg",
    {
      xmlns: SVG_NS,
      id: ids.root(),
      role: "img",
      "aria-labelledby": `${ids.title()} ${ids.desc()}`,
      viewBox: rect(animation.viewBox ?? model.viewBox),
    },
    h("title", { id: ids.title() }, title),
    h("desc", { id: ids.desc() }, desc),
    defs.length > 0 ? h("defs", null, ...defs) : null,
    h("style", null, cdata(cssText)),
    camera,
    animation.script && !raster ? h("script", null, cdata(animation.script)) : null,
  );
  if (raster) {
    if (cssText.includes("var(")) throw new Error("raster CSS still contains var()");
    const left = (n: SvgNode): void =>
      walk(n, (el) => {
        for (const [k, v] of Object.entries(el.attrs ?? {})) {
          if (typeof v === "string" && v.includes("var(")) {
            throw new Error(`raster attribute ${k} still contains var()`);
          }
        }
      });
    for (const nodes of layers.values()) nodes.forEach(left);
    defsExtra.forEach(left);
  }
  return serialize(root);
};

/** Number of SVG elements (start tags) in a serialized document. */
export function countElements(svg: string): number {
  // CDATA sections hold CSS/script text, not elements.
  return svg.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").match(/<[A-Za-z]/g)?.length ?? 0;
}
