import type { ErrorObject } from "ajv";
import type { Diagnostic } from "../contracts/index.js";
import { SCHEMA_REVISION } from "./validate.js";
import { closest, didYouMean } from "./suggest.js";

const PALETTE = [
  "blue",
  "green",
  "red",
  "orange",
  "yellow",
  "purple",
  "teal",
  "pink",
  "gray",
  "normal",
  "heavy",
  "health",
  "failed",
  "airflow",
  "power",
];

type Schema = Record<string, unknown> | undefined;

const kebab = (k: string): string => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const childPath = (p: string, k: string): string =>
  `${p}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;

function describeBranch(s: unknown): string {
  if (!isObj(s)) return "a valid value";
  const title = typeof s.title === "string" ? s.title : undefined;
  const req = Array.isArray(s.required) ? s.required.map((r) => `"${String(r)}"`).join(" + ") : "";
  if (title !== undefined) return req ? `${title} (needs ${req})` : title;
  if ("const" in s) return JSON.stringify(s.const);
  if (typeof s.type === "string") return `a ${s.type}`;
  if (req) return `an object with ${req}`;
  return "a valid value";
}

function collapseUnions(errors: ErrorObject[]): { kept: ErrorObject[]; generic: Diagnostic[] } {
  const generic: Diagnostic[] = [];
  const removed = new Set<ErrorObject>();
  // Outermost unions first (shorter schemaPath / instancePath), deterministic.
  const unions = errors
    .filter((e) => e.keyword === "oneOf" || e.keyword === "anyOf")
    .sort(
      (a, b) =>
        a.instancePath.length - b.instancePath.length ||
        (a.schemaPath < b.schemaPath ? -1 : a.schemaPath > b.schemaPath ? 1 : 0),
    );
  for (const u of unions) {
    if (removed.has(u)) continue;
    removed.add(u);
    const prefix = `${u.schemaPath}/`;
    const kids = errors.filter(
      (c) =>
        c !== u &&
        !removed.has(c) &&
        c.schemaPath.startsWith(prefix) &&
        (c.instancePath === u.instancePath || c.instancePath.startsWith(`${u.instancePath}/`)),
    );
    const byBranch = new Map<number, ErrorObject[]>();
    for (const k of kids) {
      const idx = Number(k.schemaPath.slice(prefix.length).split("/")[0]);
      const list = byBranch.get(idx) ?? [];
      list.push(k);
      byBranch.set(idx, list);
    }
    let best: number | undefined;
    let bestScore = Infinity;
    let tie = false;
    for (const [idx, list] of [...byBranch.entries()].sort((a, b) => a[0] - b[0])) {
      const shallow = list.filter((e) => e.instancePath === u.instancePath).length;
      const score = shallow * 10 + list.length;
      if (score < bestScore) {
        bestScore = score;
        best = idx;
        tie = false;
      } else if (score === bestScore) tie = true;
    }
    const branches = Array.isArray(u.schema) ? (u.schema as unknown[]) : [];
    if (best !== undefined && !tie && bestScore < 10) {
      // One branch clearly fits the shape: keep only its errors.
      for (const k of kids) if (!(byBranch.get(best) ?? []).includes(k)) removed.add(k);
    } else {
      for (const k of kids) removed.add(k);
      const desc = branches.map(describeBranch);
      const parent = isObj(u.parentSchema) ? u.parentSchema : undefined;
      const title = parent && typeof parent.title === "string" ? parent.title : undefined;
      const allRequired =
        branches.length > 0 &&
        branches.every((b) => isObj(b) && Array.isArray(b.required) && !("type" in b));
      const rootNeeds = allRequired
        ? branches.map((b) => String(((b as Record<string, unknown>).required as unknown[])[0]))
        : [];
      const matchedMany =
        u.keyword === "oneOf" &&
        kids.length === 0 &&
        Array.isArray((u.params as { passingSchemas?: unknown }).passingSchemas);
      generic.push({
        severity: "error",
        code: `schema/${u.keyword === "oneOf" ? "one-of" : "any-of"}`,
        path: u.instancePath,
        message: matchedMany
          ? `Matches more than one form${title ? ` of ${title}` : ""}`
          : allRequired
            ? `Must include at least one of: ${rootNeeds.join(", ")}`
            : `Not a valid ${title ?? "value"}`,
        ...(desc.length > 0 && !allRequired
          ? { suggestion: `Use one of: ${desc.join("; ")}` }
          : {}),
        params: { branches: desc },
      });
    }
  }
  return { kept: errors.filter((e) => !removed.has(e)), generic };
}

function convert(e: ErrorObject): Diagnostic {
  const parent = e.parentSchema as Schema;
  const props = isObj(parent?.properties) ? Object.keys(parent.properties) : [];
  const base = { severity: "error" as const, params: { ...e.params } as Record<string, unknown> };
  switch (e.keyword) {
    case "additionalProperties": {
      const prop = String((e.params as { additionalProperty: unknown }).additionalProperty);
      const hint = didYouMean(prop, props);
      return {
        ...base,
        code: "schema/additional-property",
        path: childPath(e.instancePath, prop),
        message: `Unknown field "${prop}"`,
        suggestion:
          hint ??
          (e.instancePath === ""
            ? `If "${prop}" is a newer field, upgrade platformcosmo (this engine implements schema revision ${SCHEMA_REVISION})`
            : `Remove "${prop}"; allowed fields: ${props.join(", ")}`),
      };
    }
    case "required": {
      const miss = String((e.params as { missingProperty: unknown }).missingProperty);
      const present = isObj(e.data) ? Object.keys(e.data).filter((k) => !props.includes(k)) : [];
      const typo = present.find((k) => closest(k, [miss]) !== undefined);
      return {
        ...base,
        code: "schema/required",
        path: e.instancePath,
        message: `Missing required field "${miss}"`,
        ...(typo ? { suggestion: `Found "${typo}"; did you mean "${miss}"?` } : {}),
      };
    }
    case "enum": {
      const allowed = (e.params as { allowedValues: unknown[] }).allowedValues.map(String);
      const hint = typeof e.data === "string" ? didYouMean(e.data, allowed) : undefined;
      const shown =
        allowed.length > 12 ? `${allowed.slice(0, 12).join(", ")}, ...` : allowed.join(", ");
      return {
        ...base,
        code: "schema/enum",
        path: e.instancePath,
        message: `Invalid value; expected one of: ${shown}`,
        ...(hint ? { suggestion: hint } : {}),
      };
    }
    case "const": {
      const want = JSON.stringify((e.params as { allowedValue: unknown }).allowedValue);
      return {
        ...base,
        code: "schema/const",
        path: e.instancePath,
        message: `Must be ${want}`,
        suggestion: `Use ${want}`,
      };
    }
    case "type":
      return {
        ...base,
        code: "schema/type",
        path: e.instancePath,
        message: `Expected ${String((e.params as { type: unknown }).type)}`,
      };
    case "pattern": {
      const title = typeof parent?.title === "string" ? parent.title : "";
      if (title === "SpecColor") {
        const hint = typeof e.data === "string" ? didYouMean(e.data, PALETTE) : undefined;
        return {
          ...base,
          code: "semantic/unknown-color",
          path: e.instancePath,
          message: `Unknown color ${JSON.stringify(e.data)}`,
          suggestion: hint ?? `Use #rgb, #rrggbb or one of: ${PALETTE.join(", ")}`,
        };
      }
      const msg =
        title === "SpecId" || title === "SpecEndpoint"
          ? "Ids start with a lowercase letter and use only a-z, 0-9 and '-' (endpoints may be rack/slot)"
          : title === "SpecText"
            ? "Text must not contain control characters"
            : typeof parent?.pattern === "string" && parent.pattern.includes(":")
              ? "Icon refs look like pack:name (lowercase letters, digits, '-')"
              : "Does not match the required pattern";
      return { ...base, code: "schema/pattern", path: e.instancePath, message: msg };
    }
    default:
      return {
        ...base,
        code: `schema/${kebab(e.keyword)}`,
        path: e.instancePath,
        message: e.message ?? "Invalid value",
      };
  }
}

export function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return list.sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

/** Ajv errors → diagnostics, with oneOf/anyOf collapsed to one diagnostic per location. */
export function schemaDiagnostics(errors: ErrorObject[]): Diagnostic[] {
  const { kept, generic } = collapseUnions(errors);
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of [...kept.map(convert), ...generic]) {
    const key = `${d.path}\u0000${d.code}\u0000${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return sortDiagnostics(out);
}
