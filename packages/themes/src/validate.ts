/**
 * `validateTheme`: strict structural + trust validation of an untrusted theme object
 * (custom `--theme <file>`). Every string token is checked against the whitelist rules in
 * the theme contract, unknown keys are rejected, and the result is a fresh deep copy so
 * nothing from the input object (prototype, getters, extra keys) leaks through.
 */
import type { Diagnostic, ThemeTokens, ValidateThemeFn } from "@platformcosmo/core";

type Kind =
  "color" | "font-family" | "dash" | "id" | "text" | "scheme" | "opacity" | "size" | "weight";

interface ObjShape {
  readonly [key: string]: Kind | ObjShape;
}

const keys = <T extends string>(ks: readonly T[], v: Kind | ObjShape): ObjShape =>
  Object.fromEntries(ks.map((k) => [k, v]));

const faceTones: ObjShape = { top: "color", left: "color", right: "color", stroke: "color" };

const SHAPE: ObjShape = {
  id: "id",
  name: "text",
  colorScheme: "scheme",
  background: "color",
  grid: { stroke: "color", opacity: "opacity" },
  text: { primary: "color", secondary: "color", inverse: "color" },
  font: {
    family: "font-family",
    label: "size",
    badge: "size",
    caption: "size",
    title: "size",
    weightRegular: "weight",
    weightBold: "weight",
  },
  palette: keys(
    ["blue", "green", "red", "orange", "yellow", "purple", "teal", "pink", "gray"],
    "color",
  ),
  categories: keys(
    ["compute", "network", "data", "client", "observability", "cicd", "security", "ai", "dc"],
    faceTones,
  ),
  parts: keys(
    ["base", "accent", "muted", "glass", "metal", "led", "floor", "perforated"],
    faceTones,
  ),
  groups: keys(["zone", "vpc", "cluster", "platform"], {
    fill: "color",
    stroke: "color",
    label: "color",
    opacity: "opacity",
  }),
  edge: {
    stroke: "color",
    width: "size",
    labelFill: "color",
    labelText: "color",
    dash: keys(["solid", "dashed", "dotted"], "dash"),
  },
  flows: keys(["normal", "heavy", "health", "failed", "airflow", "power"], "color"),
  states: keys(["healthy", "degraded", "down", "highlighted"], {
    overlay: "color",
    stroke: "color",
    opacity: "opacity",
  }),
  metric: { fill: "color", stroke: "color", label: "color", value: "color" },
  caption: { fill: "color", text: "color" },
  badge: { fill: "color", text: "color" },
  icon: { color: "color", plate: "color" },
  dc: {
    led: { ok: "color", warn: "color", fail: "color" },
    cable: keys(["power", "network", "fiber", "management"], "color"),
    coldAisle: "color",
    hotAisle: "color",
    containment: "color",
    hall: "color",
  },
};

const COLOR_HEX = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_FN = /^rgba?\([0-9., %]+\)$/;
const FONT_CHARS = /^[A-Za-z0-9 ,'"-]+$/;
const DASH = /^([0-9.]+([ ,][0-9.]+)*)?$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Control characters, DEL, C1 controls and Unicode line/paragraph separators. */
const hasControl = (s: string): boolean =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0)!;
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
  });

const MAX_STRING = 200;

/**
 * True when every quote opened is closed by the same kind. A quote of the other kind inside
 * an open string is rejected (no nesting, no escapes), so quoted names are always simple.
 */
function balancedQuotes(s: string): boolean {
  let open: string | undefined;
  for (const ch of s) {
    if (ch !== "'" && ch !== '"') continue;
    if (open === undefined) open = ch;
    else if (open === ch) open = undefined;
    else return false;
  }
  return open === undefined;
}

/** Untrusted keys never reach diagnostics verbatim: printable-safe characters only, truncated. */
const safeKey = (k: string): string => {
  const t = k.length > 40 ? `${k.slice(0, 40)}...` : k;
  return t.replace(/[^A-Za-z0-9_$.-]/g, "?");
};

const MAX_UNKNOWN_KEYS = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const ptr = (path: string, key: string): string =>
  `${path}/${safeKey(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function checkLeaf(
  kind: Kind,
  v: unknown,
): { ok: true; value: string | number } | { ok: false; code: string; message: string } {
  const bad = (code: string, message: string) => ({ ok: false as const, code, message });
  const str = (): string | undefined =>
    typeof v === "string" && v.length <= MAX_STRING ? v : undefined;
  switch (kind) {
    case "color": {
      const s = str();
      if (s === undefined || !(COLOR_HEX.test(s) || COLOR_FN.test(s))) {
        return bad(
          "theme/invalid-color",
          "Expected a hex color (#rgb to #rrggbbaa) or rgb()/rgba().",
        );
      }
      return { ok: true, value: s };
    }
    case "font-family": {
      const s = str();
      if (s === undefined || !FONT_CHARS.test(s) || !balancedQuotes(s)) {
        return bad(
          "theme/invalid-font",
          "Font family may only contain letters, digits, spaces, commas, hyphens and balanced quotes.",
        );
      }
      return { ok: true, value: s };
    }
    case "dash": {
      const s = str();
      if (s === undefined || !DASH.test(s)) {
        return bad(
          "theme/invalid-dash",
          "Dash must be space/comma separated non-negative numbers or empty.",
        );
      }
      return { ok: true, value: s };
    }
    case "id": {
      if (typeof v !== "string" || !ID.test(v)) {
        return bad("theme/invalid-id", "Theme id must match ^[a-z][a-z0-9-]{0,63}$.");
      }
      return { ok: true, value: v };
    }
    case "text": {
      if (typeof v !== "string" || v.length === 0 || v.length > 100 || hasControl(v)) {
        return bad(
          "theme/invalid-name",
          "Name must be 1 to 100 characters without control characters.",
        );
      }
      return { ok: true, value: v };
    }
    case "scheme": {
      if (v !== "light" && v !== "dark") {
        return bad("theme/invalid-scheme", 'colorScheme must be "light" or "dark".');
      }
      return { ok: true, value: v };
    }
    case "opacity": {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        return bad("theme/invalid-number", "Opacity must be a finite number between 0 and 1.");
      }
      return { ok: true, value: v };
    }
    case "size": {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 200) {
        return bad(
          "theme/invalid-number",
          "Size must be a finite number greater than 0 and at most 200.",
        );
      }
      return { ok: true, value: v };
    }
    case "weight": {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 100 || v > 900) {
        return bad(
          "theme/invalid-number",
          "Font weight must be a finite number between 100 and 900.",
        );
      }
      return { ok: true, value: v };
    }
  }
}

interface Ctx {
  readonly diags: Diagnostic[];
  unknown: number;
}

function walk(shape: ObjShape, input: unknown, path: string, ctx: Ctx): unknown {
  const diags = ctx.diags;
  if (!isPlainObject(input)) {
    diags.push({
      severity: "error",
      code: "theme/invalid-type",
      path,
      message: "Expected an object.",
    });
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input).sort()) {
    if (!Object.hasOwn(shape, k)) {
      ctx.unknown++;
      if (ctx.unknown <= MAX_UNKNOWN_KEYS) {
        diags.push({
          severity: "error",
          code: "theme/unknown-key",
          path: ptr(path, k),
          message: `Unknown theme key "${safeKey(k)}".`,
        });
      }
    }
  }
  for (const k of Object.keys(shape)) {
    const sub = shape[k]!;
    const p = ptr(path, k);
    if (!Object.hasOwn(input, k)) {
      diags.push({
        severity: "error",
        code: "theme/missing-key",
        path: p,
        message: `Missing required token "${k}".`,
      });
      continue;
    }
    const v = input[k];
    if (typeof sub === "string") {
      const r = checkLeaf(sub, v);
      if (r.ok) out[k] = r.value;
      else diags.push({ severity: "error", code: r.code, path: p, message: r.message });
    } else {
      out[k] = walk(sub, v, p, ctx);
    }
  }
  return out;
}

export const validateTheme: ValidateThemeFn = (input) => {
  const diagnostics: Diagnostic[] = [];
  const ctx: Ctx = { diags: diagnostics, unknown: 0 };
  let copy: unknown;
  try {
    copy = walk(SHAPE, input, "", ctx);
  } catch {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "theme/invalid-type",
          path: "",
          message: "Theme object could not be read safely.",
        },
      ],
    };
  }
  if (ctx.unknown > MAX_UNKNOWN_KEYS) {
    diagnostics.push({
      severity: "error",
      code: "theme/unknown-key-overflow",
      path: "",
      message: `${ctx.unknown - MAX_UNKNOWN_KEYS} more unknown keys were not listed.`,
    });
  }
  diagnostics.sort((a, b) =>
    a.path === b.path ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.path < b.path ? -1 : 1,
  );
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  return { theme: copy as ThemeTokens, diagnostics };
};
