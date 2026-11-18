import type { ThemeTokens } from "../contracts/index.js";

/**
 * Theme tokens to CSS (contracts/theme.ts naming rule): `--pc-` + token path joined by `-`,
 * numbers unitless. Every value is re-validated here (custom themes are untrusted).
 */

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., %]+\))$/;
const FAMILY_RE = /^[A-Za-z0-9 ,'"-]+$/;
const DASH_RE = /^([0-9.]+([ ,][0-9.]+)*)?$/;
const SKIP = new Set(["id", "name", "colorScheme"]);

function balancedQuotes(s: string): boolean {
  return (s.match(/"/g)?.length ?? 0) % 2 === 0 && (s.match(/'/g)?.length ?? 0) % 2 === 0;
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error("theme contains a non-finite number");
  return String(Number(n.toFixed(4)));
}

function checkString(path: readonly string[], v: string): string {
  const key = path.join(".");
  if (key === "font.family") {
    if (!FAMILY_RE.test(v) || !balancedQuotes(v)) throw new Error(`invalid theme value at ${key}`);
    return v;
  }
  if (path[0] === "edge" && path[1] === "dash") {
    if (!DASH_RE.test(v)) throw new Error(`invalid theme value at ${key}`);
    return v === "" ? "none" : v;
  }
  if (!COLOR_RE.test(v)) throw new Error(`invalid theme color at ${key}`);
  return v;
}

/** Flattened `--pc-*` custom properties of a theme, in sorted-key order. */
export function themeVars(theme: ThemeTokens): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (value: unknown, path: string[]): void => {
    if (typeof value === "number") out.set(`--pc-${path.join("-")}`, num(value));
    else if (typeof value === "string") out.set(`--pc-${path.join("-")}`, checkString(path, value));
    else if (value && typeof value === "object") {
      for (const k of Object.keys(value).sort()) {
        if (path.length === 0 && SKIP.has(k)) continue;
        walk((value as Record<string, unknown>)[k], [...path, k]);
      }
    } else throw new Error(`unsupported theme value at ${path.join(".")}`);
  };
  walk(theme, []);
  return out;
}

export function declarations(vars: ReadonlyMap<string, string>): string {
  return [...vars].map(([k, v]) => `${k}:${v}`).join(";");
}

/** Variables of `dark` that differ from `base`. */
export function varDiff(
  base: ReadonlyMap<string, string>,
  dark: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of dark) if (base.get(k) !== v) out.set(k, v);
  return out;
}

/**
 * Replace `var(--pc-x)` (whitespace allowed, optional fallback `var(--pc-x, fb)`) with literal
 * values (raster target). An unknown variable uses its fallback, or throws without one.
 */
export function inlineVars(css: string, vars: ReadonlyMap<string, string>): string {
  const re = /var\(\s*(--pc-[A-Za-z0-9-]+)\s*(?:,\s*([^()]*?)\s*)?\)/g;
  let out = css;
  // Repeat so a variable nested in a fallback is resolved too.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(re, (_m, name: string, fallback: string | undefined) => {
      const v = vars.get(name) ?? fallback;
      if (v === undefined) throw new Error(`unknown theme variable ${name}`);
      return v;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Remove whole at-rule blocks (`@media {…}`, `@font-face {…}`, `@keyframes x {…}`). */
export function stripAtRules(css: string, names: readonly string[]): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (
      css[i] === "@" &&
      names.some((n) => css.startsWith(`@${n}`, i) && !/[\w-]/.test(css[i + 1 + n.length] ?? " "))
    ) {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      let depth = 0;
      let j = open;
      for (; j < css.length; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}" && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

/**
 * CSS rule for one A-owned class token (suffix after `${prefix}-`), or undefined when the token
 * is not one of ours. Tokens: `face`, `overlay`, `k-<category>-<face>`, `p-<tone>-<face>`,
 * `grp-<style|cold-aisle|hot-aisle|hall|contained>`, `glabel`, `t-<role>`, `tb`, `edge`,
 * `edge-<style>`, `cable-<kind>`, `arrow`, `elabel`, `bg`, `grid`, `metric`, `capbox`, `badgebox`,
 * `plate`, `icon`.
 */
export function ruleFor(token: string): string | undefined {
  const v = (name: string) => `var(--pc-${name})`;
  let m: RegExpExecArray | null;
  if (token === "face") return "stroke-width:1;stroke-linejoin:round";
  if (token === "overlay") return "pointer-events:none;stroke-width:1.5";
  if ((m = /^k-([a-z]+)-(top|left|right)$/.exec(token)))
    return `fill:${v(`categories-${m[1]}-${m[2]}`)};stroke:${v(`categories-${m[1]}-stroke`)}`;
  if ((m = /^p-([a-z]+)-(top|left|right)$/.exec(token)))
    return `fill:${v(`parts-${m[1]}-${m[2]}`)};stroke:${v(`parts-${m[1]}-stroke`)}`;
  if ((m = /^grp-(zone|vpc|cluster|platform)$/.exec(token)))
    return `fill:${v(`groups-${m[1]}-fill`)};stroke:${v(`groups-${m[1]}-stroke`)};opacity:${v(`groups-${m[1]}-opacity`)}`;
  if (token === "grp-cold-aisle") return `fill:${v("dc-coldAisle")};stroke:none`;
  if (token === "grp-hot-aisle") return `fill:${v("dc-hotAisle")};stroke:none`;
  if (token === "grp-hall") return `fill:${v("dc-hall")};stroke:${v("groups-zone-stroke")}`;
  if (token === "grp-contained") return `stroke:${v("dc-containment")};stroke-width:2`;
  if (token === "glabel")
    return `fill:${v("groups-zone-label")};paint-order:stroke;stroke:var(--pc-background);stroke-width:3;stroke-linejoin:round`;
  if (token === "gpill")
    return `fill:${v("background")};fill-opacity:0.88;stroke:${v("groups-zone-stroke")};stroke-width:1`;
  if (token === "t-primary")
    return `fill:${v("text-primary")};paint-order:stroke;stroke:var(--pc-background);stroke-width:3;stroke-linejoin:round`;
  if (token === "t-secondary")
    return `fill:${v("text-secondary")};paint-order:stroke;stroke:var(--pc-background);stroke-width:3;stroke-linejoin:round`;
  if (token === "t-inverse") return `fill:${v("text-inverse")}`;
  if (token === "t-edge")
    return `fill:${v("edge-labelText")};paint-order:stroke;stroke:var(--pc-background);stroke-width:3;stroke-linejoin:round`;
  if (token === "t-metric-label") return `fill:${v("metric-label")}`;
  if (token === "t-metric-value") return `fill:${v("metric-value")}`;
  if (token === "t-caption") return `fill:${v("caption-text")}`;
  if (token === "t-badge") return `fill:${v("badge-text")}`;
  if (token === "tb") return `font-weight:${v("font-weightBold")}`;
  if (token === "edge")
    return `fill:none;stroke:${v("edge-stroke")};stroke-width:${v("edge-width")};stroke-linejoin:round;stroke-linecap:round`;
  if ((m = /^edge-(solid|dashed|dotted)$/.exec(token)))
    return `stroke-dasharray:${v(`edge-dash-${m[1]}`)}`;
  if ((m = /^cable-(power|network|fiber|management)$/.exec(token)))
    return `stroke:${v(`dc-cable-${m[1]}`)}`;
  if (token === "arrow") return `fill:${v("edge-stroke")};stroke:none`;
  if (token === "elabel") return `fill:${v("edge-labelFill")};stroke:none`;
  if (token === "bg") return `fill:${v("background")}`;
  if (token === "grid")
    return `fill:none;stroke:${v("grid-stroke")};stroke-opacity:${v("grid-opacity")};stroke-width:1`;
  if (token === "metric") return `fill:${v("metric-fill")};stroke:${v("metric-stroke")}`;
  if (token === "capbox") return `fill:${v("caption-fill")};stroke:none`;
  if (token === "badgebox") return `fill:${v("badge-fill")};stroke:none`;
  if (token === "plate") return `fill:${v("icon-plate")};stroke:none`;
  if (token === "icon") return `color:${v("icon-color")}`;
  return undefined;
}

/** Class rules for the tokens actually used, sorted for determinism. */
export function classRules(prefix: string, usedClasses: ReadonlySet<string>): string[] {
  const lead = `${prefix}-`;
  const tokens = [...usedClasses]
    .filter((c) => c.startsWith(lead))
    .map((c) => c.slice(lead.length));
  const out: string[] = [];
  for (const t of tokens.sort()) {
    const r = ruleFor(t);
    // Modifier tokens that must beat their base class (`edge`, `grp-<style>`) get doubled specificity.
    const sel =
      t.startsWith("cable-") || t === "grp-contained" ? `.${lead}${t}.${lead}${t}` : `.${lead}${t}`;
    if (r) out.push(`${sel}{${r}}`);
  }
  return out;
}

const LED = { healthy: "ok", highlighted: "ok", degraded: "warn", down: "fail" } as const;

/** Base state rules of contracts/render.ts, one block per theme state. */
export function stateRules(prefix: string, theme: ThemeTokens): string[] {
  const out: string[] = [];
  for (const s of Object.keys(theme.states).sort()) {
    const sc = `.${prefix}-s-${s}`;
    out.push(`${sc}{opacity:var(--pc-states-${s}-opacity)}`);
    out.push(
      `${sc}>.${prefix}-overlay{fill:var(--pc-states-${s}-overlay);stroke:var(--pc-states-${s}-stroke)}`,
    );
    const led = (LED as Record<string, string>)[s];
    if (led) out.push(`${sc} .${prefix}-led{fill:var(--pc-dc-led-${led})}`);
  }
  return out;
}
