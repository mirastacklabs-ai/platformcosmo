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
 * The image and board part of `AssemblyIdScheme` (contracts/assembly.ts), implemented for
 * figure rendering (R-1). `createIds` returns the whole `AssemblyIdScheme` (A1-3).
 */
export type BoardIdScheme = Pick<AssemblyIdScheme, "image" | "board" | "boardItem" | "credits">;

/** `__c<k>` suffix of copy `k` of an element id (copy 0 has none, §9.4). */
export const copySuffix = (copy?: number): string =>
  copy === undefined || copy <= 0 ? "" : `__c${Math.floor(copy)}`;

/** Item key (`path`, `path__back`, `path__front`) as an id segment: the half marker stays `__`. */
function itemSeg(item: string): string {
  const m = /^(.*)__(back|front)$/.exec(item);
  return m ? `${seg(m[1] as string)}__${m[2] as string}` : seg(item);
}

export interface CreateIdsOptions {
  /**
   * Number of DOM copies by copy-0 element id (default 1 each); `copyIds` lists `id`, `id__c1`
   * ... for ids with more than one. The assembly render model (A1-2b) returns a scheme whose
   * `copyIds` knows every element of every copied item; this option is for callers that know
   * their counts up front.
   */
  readonly copies?: ReadonlyMap<string, number>;
}

export function createIds(
  prefix: string,
  options: CreateIdsOptions = {},
): IdScheme & AssemblyIdScheme {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid id prefix: ${prefix}`);
  const p = prefix;
  const copies = options.copies;
  return {
    partHost: (item, copy) => `${p}-ph_${itemSeg(item)}${copySuffix(copy)}`,
    partMotion: (item, copy) => `${p}-pm_${itemSeg(item)}${copySuffix(copy)}`,
    partVisible: (item, copy) => `${p}-pv_${itemSeg(item)}${copySuffix(copy)}`,
    partFade: (item, copy) => `${p}-pf_${itemSeg(item)}${copySuffix(copy)}`,
    copyIds: (id) => {
      const n = Math.max(1, copies?.get(id) ?? 1);
      return Array.from({ length: n }, (_, k) => `${id}${copySuffix(k)}`);
    },
    partLabel: (path) => `${p}-pl_${seg(path)}`,
    partClip: (item, copy) => `${p}-pc_${itemSeg(item)}${copySuffix(copy)}`,
    callout: (owner, program, step) => `${p}-co_${seg(owner)}__${seg(program)}__${step}`,
    flight: (path) => `${p}-fy_${seg(path)}`,
    view: (turn) => `${p}-vw_${turn}`,
    fadeWrap: (id) => `${p}-fw_${seg(id)}`,
    level: (id) => `${p}-lv_${seg(id)}`,
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
