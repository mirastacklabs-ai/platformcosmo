import type {
  AnimationLayer,
  EmitFn,
  EmitOptions,
  Layer,
  RenderModel,
  SvgElement,
  SvgNode,
} from "../contracts/index.js";
import { fmt } from "../geometry/index.js";
import { fullWoff2Base64, textToPath, type TextAnchor } from "../text/index.js";
import {
  classRules,
  declarations,
  inlineVars,
  stateRules,
  stripAtRules,
  themeVars,
  varDiff,
} from "./styles.js";
import { cdata, h, raw, serialize } from "./xml.js";

export { createIds, cssEscapeId } from "./ids.js";
export { serialize, h, raw, escapeText, escapeAttr, cdata } from "./xml.js";

/**
 * Placeholder element the model builder uses to hand an icon to the emitter (which alone may
 * create `SvgRaw`): `{ tag, attrs: { ref, viewBox }, children: [sanitizedBodyString] }`.
 * Emit hoists each one (deduplicated by ref) into `<defs>` as a `<symbol>`.
 */
export const ICON_DEF_TAG = "pc-icon-def";

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

function rect(r: { x: number; y: number; width: number; height: number }): string {
  return `${fmt(r.x)} ${fmt(r.y)} ${fmt(r.width)} ${fmt(r.height)}`;
}

function iconSymbol(el: SvgElement, ids: RenderModel["ids"]): SvgElement {
  const ref = String(el.attrs?.ref ?? "");
  const viewBox = String(el.attrs?.viewBox ?? "0 0 24 24");
  const body = (el.children ?? []).filter((c): c is string => typeof c === "string").join("");
  const id = ids.icon(ref);
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
  const hoist: Mapper = (el) => {
    if (el.tag !== ICON_DEF_TAG) return el;
    const ref = String(el.attrs?.ref ?? "");
    if (!symbols.has(ref)) symbols.set(ref, iconSymbol(el, ids));
    return null;
  };
  const layerNodes = new Map<Layer, SvgNode[]>();
  for (const layer of LAYERS) {
    const nodes = [...model.layers[layer], ...(animation.layers[layer] ?? [])];
    layerNodes.set(
      layer,
      nodes.map((n) => mapTree(n, hoist)).filter((n): n is SvgNode => n !== null),
    );
  }
  const animDefs = animation.defs
    .map((n) => mapTree(n, hoist))
    .filter((n): n is SvgNode => n !== null);

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
    if (options.font !== "outline" || el.tag !== "text") return el;
    const a = el.attrs ?? {};
    const text = (el.children ?? []).filter((c): c is string => typeof c === "string").join("");
    const bold = classesOf(el).includes(`${prefix}-tb`);
    const { d } = textToPath(text, {
      x: Number(a.x ?? 0),
      y: Number(a.y ?? 0),
      size: Number(a["font-size"] ?? 12),
      weight: bold ? "bold" : "regular",
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

  // 3. Used classes and text, for rules and fonts.
  const used = new Set<string>();
  let usesText = false;
  let usesBold = false;
  const scan = (n: SvgNode): void =>
    walk(n, (el) => {
      for (const c of classesOf(el)) used.add(c);
      if (el.tag === "text") {
        usesText = true;
        if (classesOf(el).includes(`${prefix}-tb`)) usesBold = true;
      }
    });
  for (const nodes of layers.values()) nodes.forEach(scan);
  defsExtra.forEach(scan);

  // 4. CSS.
  const css: string[] = [];
  const family = vars.get("--pc-font-family") ?? "sans-serif";
  const rootRule = (v: ReadonlyMap<string, string>) =>
    `#${ids.root()}{${declarations(v)};font-family:var(--pc-font-family);font-weight:var(--pc-font-weightRegular)}`;
  if (!raster) {
    css.push(rootRule(vars));
    if (model.darkTheme) {
      const diff = varDiff(vars, themeVars(model.darkTheme));
      if (diff.size > 0) {
        css.push(`@media (prefers-color-scheme:dark){#${ids.root()}{${declarations(diff)}}}`);
      }
    }
    if (options.font === "embed" && usesText) {
      const face = (w: number, kind: "regular" | "bold") =>
        `@font-face{font-family:"Inter";font-style:normal;font-weight:${w};src:url(data:font/woff2;base64,${fullWoff2Base64(kind)}) format("woff2")}`;
      css.push(face(400, "regular"));
      if (usesBold) css.push(face(700, "bold"));
    }
  } else {
    css.push(
      `#${ids.root()}{font-family:${family};font-weight:${vars.get("--pc-font-weightRegular") ?? "400"}}`,
    );
  }
  const rules = [...classRules(prefix, used), ...stateRules(prefix, model.theme)];
  if (raster) {
    css.push(...rules.map((r) => inlineVars(r, vars)));
    css.push(
      stripAtRules(inlineVars(animation.css, vars), [
        "media",
        "font-face",
        "keyframes",
        "-webkit-keyframes",
      ]),
    );
  } else {
    css.push(...rules);
    css.push(animation.css);
  }
  const cssText = css.filter((s) => s.trim() !== "").join("\n");

  // 5. Document.
  const defs: SvgNode[] = [];
  for (const ref of [...symbols.keys()].sort()) defs.push(symbols.get(ref) as SvgElement);
  for (const e of model.scene.edges) {
    const p = model.edgePaths[e.id];
    if (e.hidden && p) defs.push(h("path", { id: ids.edgePath(e.id), d: p.d }));
  }
  defs.push(...defsExtra);

  const title = model.scene.meta.title ?? "PlatformCosmo diagram";
  const desc =
    model.scene.meta.description ??
    `Isometric architecture diagram with ${model.scene.objects.length} objects.`;
  const camera = h(
    "g",
    { id: ids.camera() },
    ...LAYERS.map((l) =>
      h("g", { id: `${prefix}-ly_${l}`, class: `${prefix}-layer` }, ...(layers.get(l) ?? [])),
    ),
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
  return serialize(root);
};

/** Number of SVG elements (start tags) in a serialized document. */
export function countElements(svg: string): number {
  return svg.match(/<[A-Za-z]/g)?.length ?? 0;
}
