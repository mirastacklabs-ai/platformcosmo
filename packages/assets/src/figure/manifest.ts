/**
 * Figure manifest (ingestion §6.1): strict TypeScript type and a hand-written validator that
 * mirrors `packages/cli/schema/figure-manifest.v1.json` (D-2a compiles that schema with Ajv; this
 * validator lets the pipeline accept `unknown` without Ajv and never throws). Every structural
 * rule of the schema is checked here; a test runs both on the same corpus.
 *
 * Bounded work: arrays are length-checked before they are walked, strings before regex tests,
 * and the regexes have no nested quantifiers.
 */
import type { Diagnostic } from "@platformcosmo/core";

export type FigureState = "exploded" | "assembled";
export const STATES: readonly FigureState[] = ["exploded", "assembled"];

export type Point = readonly [number, number];
/** [x, y, w, h] in source pixels. */
export type RectTuple = readonly [number, number, number, number];

export interface PerState<T> {
  readonly exploded?: T;
  readonly assembled?: T;
}

export interface ManifestPart {
  readonly id: string;
  readonly group?: string;
  readonly instanceOf?: string;
  readonly seeds: PerState<readonly Point[]>;
  readonly polygon?: PerState<readonly Point[]>;
  readonly prior?: "box" | "cylinder" | "none";
  readonly nearest?: PerState<Point>;
  readonly holes?: boolean;
  readonly allowDisjoint?: boolean;
  readonly z?: number;
}

export interface PolylineAnnotation {
  readonly kind: "arrow" | "leader";
  readonly state: FigureState;
  readonly polyline: readonly Point[];
  readonly width?: number;
}

export interface TextAnnotation {
  readonly kind: "text";
  readonly state: FigureState;
  readonly rect: RectTuple;
}

export type Annotation = PolylineAnnotation | TextAnnotation;

export interface FigureManifest {
  readonly sources: PerState<string>;
  readonly regions?: PerState<RectTuple>;
  readonly background?: string;
  readonly base?: FigureState;
  readonly erase?: "recover" | "fill";
  readonly parts: readonly ManifestPart[];
  readonly annotations?: readonly Annotation[];
}

/** Limits of the schema (and ingestion §14: at most 64 parts per manifest). */
export const MANIFEST_LIMITS = {
  parts: 64,
  annotations: 128,
  seeds: 32,
  points: 256,
  coordinate: 16384,
  idLength: 64,
  fileLength: 512,
} as const;

const ID = /^[a-z][a-z0-9-]*$/;
const FILE_CHARS = /^[A-Za-z0-9._ /-]+$/;
const FILE_EXT = /\.(png|jpg|jpeg|PNG|JPG|JPEG)$/;
const BACKGROUND = /^(auto|#[0-9a-fA-F]{6})$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Collector {
  readonly diagnostics: Diagnostic[] = [];
  /** Stops collecting after this many problems (a hostile manifest cannot flood the report). */
  private static readonly MAX = 50;
  fail(path: string, message: string): void {
    if (this.diagnostics.length >= Collector.MAX) return;
    this.diagnostics.push({
      severity: "error",
      code: "asset/bad-option",
      path,
      message,
      params: { option: "manifest" },
    });
  }
}

function only(c: Collector, o: Record<string, unknown>, keys: readonly string[], path: string) {
  for (const k of Object.keys(o).slice(0, 64)) {
    if (!keys.includes(k)) c.fail(`${path}/${k}`, `unknown property "${k.slice(0, 64)}"`);
  }
}

function id(c: Collector, v: unknown, path: string): boolean {
  if (typeof v !== "string" || v.length > MANIFEST_LIMITS.idLength || !ID.test(v)) {
    c.fail(
      path,
      "must be an id: lowercase letters, digits and '-', starting with a letter, at most 64 characters",
    );
    return false;
  }
  return true;
}

function file(c: Collector, v: unknown, path: string): boolean {
  if (typeof v !== "string" || v.length > MANIFEST_LIMITS.fileLength) {
    c.fail(path, "must be a relative .png or .jpg path of at most 512 characters");
    return false;
  }
  const segs = v.split("/");
  if (
    !FILE_CHARS.test(v) ||
    !FILE_EXT.test(v) ||
    v.startsWith("/") ||
    v.startsWith("\\") ||
    segs.includes("..")
  ) {
    c.fail(path, "must be a relative .png or .jpg path without '..'");
    return false;
  }
  return true;
}

const intIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function point(c: Collector, v: unknown, path: string): boolean {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !v.every((n) => intIn(n, 0, MANIFEST_LIMITS.coordinate))
  ) {
    c.fail(path, "must be a point [x, y] of integers from 0 to 16384");
    return false;
  }
  return true;
}

function points(c: Collector, v: unknown, path: string, min: number, max: number): boolean {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    c.fail(path, `must be an array of ${min} to ${max} points`);
    return false;
  }
  let ok = true;
  v.forEach((p, i) => {
    ok = point(c, p, `${path}/${i}`) && ok;
  });
  return ok;
}

function rect(c: Collector, v: unknown, path: string): boolean {
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    !v.every((n) => intIn(n, 0, MANIFEST_LIMITS.coordinate))
  ) {
    c.fail(path, "must be a rectangle [x, y, w, h] of integers from 0 to 16384");
    return false;
  }
  return true;
}

function perState(
  c: Collector,
  v: unknown,
  path: string,
  each: (value: unknown, path: string) => boolean,
): boolean {
  if (!isObj(v)) {
    c.fail(path, "must be an object with exploded and/or assembled");
    return false;
  }
  only(c, v, STATES, path);
  const present = STATES.filter((s) => v[s] !== undefined);
  if (present.length === 0) c.fail(path, "must have exploded and/or assembled");
  let ok = present.length > 0;
  for (const s of present) ok = each(v[s], `${path}/${s}`) && ok;
  return ok;
}

const PART_KEYS = [
  "id",
  "group",
  "instanceOf",
  "seeds",
  "polygon",
  "prior",
  "nearest",
  "holes",
  "allowDisjoint",
  "z",
];

function part(c: Collector, v: unknown, path: string): void {
  if (!isObj(v)) return c.fail(path, "must be an object");
  only(c, v, PART_KEYS, path);
  if (v.id === undefined) c.fail(path, 'missing required property "id"');
  else id(c, v.id, `${path}/id`);
  if (v.group !== undefined) id(c, v.group, `${path}/group`);
  if (v.instanceOf !== undefined) id(c, v.instanceOf, `${path}/instanceOf`);
  if (v.seeds === undefined) c.fail(path, 'missing required property "seeds"');
  else perState(c, v.seeds, `${path}/seeds`, (s, p) => points(c, s, p, 1, MANIFEST_LIMITS.seeds));
  if (v.polygon !== undefined) {
    perState(c, v.polygon, `${path}/polygon`, (s, p) => points(c, s, p, 2, MANIFEST_LIMITS.points));
  }
  if (v.prior !== undefined && !["box", "cylinder", "none"].includes(v.prior as string)) {
    c.fail(`${path}/prior`, 'must be "box", "cylinder" or "none"');
  }
  if (v.nearest !== undefined) perState(c, v.nearest, `${path}/nearest`, (s, p) => point(c, s, p));
  for (const k of ["holes", "allowDisjoint"] as const) {
    if (v[k] !== undefined && typeof v[k] !== "boolean")
      c.fail(`${path}/${k}`, "must be a boolean");
  }
  if (v.z !== undefined && !intIn(v.z, -1000, 1000)) {
    c.fail(`${path}/z`, "must be an integer from -1000 to 1000");
  }
}

function annotation(c: Collector, v: unknown, path: string): void {
  if (!isObj(v)) return c.fail(path, "must be an object");
  if (v.kind === "text") {
    only(c, v, ["kind", "state", "rect"], path);
    if (v.rect === undefined) c.fail(path, 'missing required property "rect"');
    else rect(c, v.rect, `${path}/rect`);
  } else if (v.kind === "arrow" || v.kind === "leader") {
    only(c, v, ["kind", "state", "polyline", "width"], path);
    if (v.polyline === undefined) c.fail(path, 'missing required property "polyline"');
    else points(c, v.polyline, `${path}/polyline`, 2, MANIFEST_LIMITS.points);
    if (v.width !== undefined && !intIn(v.width, 1, 32)) {
      c.fail(`${path}/width`, "must be an integer from 1 to 32");
    }
  } else {
    c.fail(`${path}/kind`, 'must be "arrow", "leader" or "text"');
  }
  if (!STATES.includes(v.state as FigureState)) {
    c.fail(`${path}/state`, 'must be "exploded" or "assembled"');
  }
}

/**
 * Structural validation (the JSON Schema) plus the semantic rules the pipeline needs: unique part
 * ids, a group's parts agree on `instanceOf`, every state used by seeds, polygons, hints and
 * annotations is drawn, and `base` names a drawn state. Errors are `asset/bad-option` with
 * `params.option: "manifest"` and a JSON pointer `path`; more than 64 parts is `asset/too-large`.
 */
export function validateManifest(input: unknown): {
  value?: FigureManifest;
  diagnostics: Diagnostic[];
} {
  const c = new Collector();
  if (!isObj(input)) {
    c.fail("", "the manifest must be a JSON object");
    return { diagnostics: c.diagnostics };
  }
  only(c, input, ["sources", "regions", "background", "base", "erase", "parts", "annotations"], "");
  if (input.sources === undefined) c.fail("", 'missing required property "sources"');
  else perState(c, input.sources, "/sources", (s, p) => file(c, s, p));
  if (input.regions !== undefined) perState(c, input.regions, "/regions", (s, p) => rect(c, s, p));
  if (
    input.background !== undefined &&
    (typeof input.background !== "string" ||
      input.background.length > 7 ||
      !BACKGROUND.test(input.background))
  ) {
    c.fail("/background", 'must be "auto" or a #rrggbb colour');
  }
  if (input.base !== undefined && !STATES.includes(input.base as FigureState)) {
    c.fail("/base", 'must be "assembled" or "exploded"');
  }
  if (input.erase !== undefined && !["recover", "fill"].includes(input.erase as string)) {
    c.fail("/erase", 'must be "recover" or "fill"');
  }
  if (input.parts === undefined) c.fail("", 'missing required property "parts"');
  else if (!Array.isArray(input.parts) || input.parts.length < 1) {
    c.fail("/parts", "must be an array of at least one part");
  } else if (input.parts.length > MANIFEST_LIMITS.parts) {
    c.diagnostics.push({
      severity: "error",
      code: "asset/too-large",
      path: "/parts",
      message: `the manifest has ${input.parts.length} parts, above the limit of ${MANIFEST_LIMITS.parts}`,
      params: { parts: input.parts.length, limit: MANIFEST_LIMITS.parts },
    });
  } else {
    input.parts.forEach((p, i) => part(c, p, `/parts/${i}`));
  }
  if (input.annotations !== undefined) {
    if (
      !Array.isArray(input.annotations) ||
      input.annotations.length > MANIFEST_LIMITS.annotations
    ) {
      c.fail("/annotations", "must be an array of at most 128 annotations");
    } else {
      input.annotations.forEach((a, i) => annotation(c, a, `/annotations/${i}`));
    }
  }
  if (c.diagnostics.length > 0) return { diagnostics: c.diagnostics };

  // Semantic rules (structure is valid from here on).
  const m = input as unknown as FigureManifest;
  const drawn = STATES.filter((s) => m.sources[s] !== undefined || m.regions?.[s] !== undefined);
  const files = STATES.filter((s) => m.sources[s] !== undefined);
  if (files.length === 1 && m.regions) {
    // One image with a region per state: every region state is drawn from that file.
  } else if (m.regions) {
    for (const s of STATES) {
      if (m.regions[s] && !m.sources[s]) c.fail(`/regions/${s}`, `no source image for "${s}"`);
    }
  }
  const has = (s: FigureState): boolean => drawn.includes(s);
  const ids = new Set<string>();
  const groupClass = new Map<string, string | undefined>();
  m.parts.forEach((p, i) => {
    if (ids.has(p.id)) c.fail(`/parts/${i}/id`, `duplicate part id "${p.id}"`);
    ids.add(p.id);
    for (const [k, v] of [
      ["seeds", p.seeds],
      ["polygon", p.polygon],
      ["nearest", p.nearest],
    ] as const) {
      for (const s of STATES) {
        if (v?.[s] !== undefined && !has(s))
          c.fail(`/parts/${i}/${k}/${s}`, `the figure has no ${s} drawing`);
      }
    }
    const g = p.group ?? p.id;
    if (groupClass.has(g)) {
      const prev = groupClass.get(g);
      if (p.instanceOf !== undefined && prev !== undefined && prev !== p.instanceOf) {
        c.fail(
          `/parts/${i}/instanceOf`,
          `group "${g}" mixes instanceOf "${prev}" and "${p.instanceOf}"`,
        );
      } else if (prev === undefined && p.instanceOf !== undefined) groupClass.set(g, p.instanceOf);
    } else groupClass.set(g, p.instanceOf);
  });
  for (const g of groupClass.keys()) {
    if (ids.has(g) && !m.parts.some((p) => p.id === g && (p.group ?? p.id) === g)) {
      c.fail("/parts", `group id "${g}" is also the id of a part in another group`);
    }
  }
  (m.annotations ?? []).forEach((a, i) => {
    if (!has(a.state)) c.fail(`/annotations/${i}/state`, `the figure has no ${a.state} drawing`);
  });
  if (m.base !== undefined && !has(m.base)) c.fail("/base", `the figure has no ${m.base} drawing`);
  if (c.diagnostics.length > 0) return { diagnostics: c.diagnostics };
  return { value: m, diagnostics: [] };
}
