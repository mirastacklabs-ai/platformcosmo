import type { AssemblyIdScheme, FaceName, IdScheme } from "../contracts/index.js";

/**
 * Deterministic id scheme (contracts/render.ts `IdScheme`).
 *
 * Every id starts with `prefix`, which must match `^[a-z][a-z0-9-]*$`. The kind marker
 * (`o_`, `f_`, ...) comes right after `prefix-`. Id segments (spec, generated and part ids)
 * are encoded so that `_` only ever appears as the escape `_5f`; the structural separator of
 * multi-part ids is `__`, which therefore cannot occur inside a segment, so no two ids collide
 * (e.g. object `r_front` face `top` vs object `r` part `front` face `top`).
 * `/` (slot refs) becomes `.`.
 * Icon refs (`pack:id`) are encoded bijectively: every character outside `[A-Za-z0-9-]`
 * becomes `_` + two hex digits of its code unit (`_u` + four for the rest of the BMP, `_U` + six for astral code points).
 */

const PREFIX_RE = /^[a-z][a-z0-9-]*$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function seg(id: string): string {
  const s = id.replaceAll("/", ".");
  if (!SAFE_SEGMENT_RE.test(s)) throw new Error(`id contains unsupported characters: ${id}`);
  return s.replaceAll("_", "_5f");
}

function encodeRef(ref: string): string {
  let out = "";
  for (const ch of ref) {
    if (/[A-Za-z0-9-]/.test(ch)) {
      out += ch;
      continue;
    }
    const code = ch.codePointAt(0) as number;
    out +=
      code < 0x100
        ? `_${code.toString(16).padStart(2, "0")}`
        : code < 0x10000
          ? `_u${code.toString(16).padStart(4, "0")}`
          : `_U${code.toString(16).padStart(6, "0")}`;
  }
  return out;
}

/** CSS-escape an id for use after `#`: backslash-escapes everything outside `[A-Za-z0-9_-]`. */
export function cssEscapeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

/**
 * The image and board part of `AssemblyIdScheme` (contracts/assembly.ts), implemented here for
 * figure rendering (R-1); the other assembly ids are A1's.
 */
export type BoardIdScheme = Pick<AssemblyIdScheme, "image" | "board" | "boardItem" | "credits">;

export function createIds(prefix: string): IdScheme & BoardIdScheme {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid id prefix: ${prefix}`);
  const p = prefix;
  return {
    image: (hash) => `${p}-im_${encodeRef(hash)}`,
    board: (id) => `${p}-bd_${seg(id)}`,
    boardItem: (id, item) => `${p}-bi_${seg(id)}__${seg(item)}`,
    credits: () => `${p}-credits`,
    prefix: p,
    root: () => p,
    title: () => `${p}-title`,
    desc: () => `${p}-desc`,
    camera: () => `${p}-cam`,
    object: (id) => `${p}-o_${seg(id)}`,
    face: (id: string, face: FaceName, part?: string) =>
      part === undefined
        ? `${p}-f_${seg(id)}__${face}`
        : `${p}-f_${seg(id)}__${seg(part)}__${face}`,
    overlay: (id) => `${p}-ov_${seg(id)}`,
    group: (id) => `${p}-g_${seg(id)}`,
    edge: (id) => `${p}-e_${seg(id)}`,
    edgePath: (id) => `${p}-ep_${seg(id)}`,
    flow: (id) => `${p}-fl_${seg(id)}`,
    icon: (ref) => `${p}-i_${encodeRef(ref)}`,
    caption: () => `${p}-cap`,
    legend: () => `${p}-legend`,
    captionStep: (step) => `${p}-cap_${step}`,
    metric: (id) => `${p}-m_${seg(id)}`,
    metricValue: (id, step) => `${p}-mv_${seg(id)}__${step}`,
    stateClass: (state) => `${p}-s-${state}`,
    ledClass: () => `${p}-led`,
    sel: (id) => `#${cssEscapeId(id)}`,
  };
}
