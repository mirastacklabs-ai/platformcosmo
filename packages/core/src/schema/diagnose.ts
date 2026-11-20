import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Diagnostic } from "../contracts/index.js";
import { SCHEMA_REVISION, rootDefs } from "./validate.js";
import { closest, didYouMean, q } from "./suggest.js";

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

type Resolved = Record<string, unknown>;

/** A oneOf branch with `$ref`s followed (they point into the spec's `$defs`). */
function derefBranch(b: unknown): Resolved | undefined {
  let cur: unknown = b;
  for (let i = 0; i < 4 && isObj(cur) && typeof cur.$ref === "string"; i++) {
    cur = (rootDefs as Record<string, unknown>)[cur.$ref.replace("#/$defs/", "")];
  }
  return isObj(cur) ? cur : undefined;
}

const jsonType = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/**
 * The 1.2 unions the discriminator applies to (by schema title). 1.1 unions keep their
 * existing diagnostics byte for byte (test/oneof-regression.test.ts); A2-1 extends this list.
 */
const DISCRIMINATED: ReadonlySet<string> = new Set([
  "SpecAssemblyAction",
  "SpecProgram",
  "SpecPartImage",
]);

/** What a oneOf's discriminator selected: a branch to report on, or a ready diagnostic. */
export type BranchChoice = { readonly branch: number } | { readonly diagnostic: Diagnostic };

/**
 * Picks the branch of a `oneOf` that the data's own discriminator names, so diagnostics come
 * from that branch instead of "Not a valid <Title>" (assembly actions, programs and part
 * images; written for A2-F, shared with A2-1). Rules, in order:
 *  1. `kind`: branches declaring `properties.kind.const` are matched by the data's `kind`
 *     (absent: the one branch where `kind` is optional, i.e. the default kind);
 *  2. key: every branch has a required key no other branch requires (the action keys
 *     `explode`/`implode`/`build`/`unbuild`); the branch whose key is present wins;
 *  3. type: string vs object (`$ref`s followed) when exactly one branch has the data's type.
 * Returns undefined when no rule decides (the generic union message applies).
 */
export function discriminateBranch(
  branches: readonly unknown[],
  data: unknown,
  path: string,
  title = "value",
): BranchChoice | undefined {
  const res = branches.map(derefBranch);
  if (res.some((r) => r === undefined)) return undefined;
  const rs = res as Resolved[];
  const required = rs.map((r) => (Array.isArray(r.required) ? r.required.map(String) : []));

  if (isObj(data)) {
    // 1. kind
    const consts = rs.map((r) => {
      const k = isObj(r.properties) ? r.properties.kind : undefined;
      return isObj(k) && typeof k.const === "string" ? k.const : undefined;
    });
    if (consts.some((c) => c !== undefined)) {
      const kind = data.kind;
      if (kind === undefined) {
        const open = rs.map((_, i) => i).filter((i) => !required[i]!.includes("kind"));
        return open.length === 1 ? { branch: open[0]! } : undefined;
      }
      const at = typeof kind === "string" ? consts.indexOf(kind) : -1;
      if (at >= 0) return { branch: at };
      const allowed = consts.filter((c): c is string => c !== undefined);
      const hint = typeof kind === "string" ? didYouMean(kind, allowed) : undefined;
      return {
        diagnostic: {
          severity: "error",
          code: "schema/enum",
          path: childPath(path, "kind"),
          message: `Invalid kind; expected one of: ${allowed.join(", ")}`,
          suggestion: hint ?? `Use one of: ${allowed.join(", ")}`,
          params: { allowedValues: allowed },
        },
      };
    }
    // 2. key
    const tags = required.map((req, i) =>
      req.filter((k) => required.every((other, j) => j === i || !other.includes(k))),
    );
    if (tags.every((t) => t.length > 0)) {
      const hit = tags.map((t) => t.filter((k) => k in data));
      const present = hit.map((h, i) => (h.length > 0 ? i : -1)).filter((i) => i >= 0);
      if (present.length === 1) return { branch: present[0]! };
      const all = tags.map((t) => t[0]!);
      if (present.length > 1) {
        const keys = present.map((i) => hit[i]![0]!);
        return {
          diagnostic: {
            severity: "error",
            code: "schema/one-of",
            path,
            message: `Has more than one of ${keys.map((k) => q(k)).join(", ")}; exactly one is allowed`,
            suggestion: `Keep one of: ${all.join(", ")}`,
            params: { keys, branches: all, title },
          },
        };
      }
      for (const key of Object.keys(data)) {
        const hint = closest(key, all);
        if (hint !== undefined) {
          return {
            diagnostic: {
              severity: "error",
              code: "schema/one-of",
              path,
              message: `Unknown key ${q(key)}; expected one of: ${all.join(", ")}`,
              suggestion: `Did you mean "${hint}"?`,
              params: { key, branches: all, title },
            },
          };
        }
      }
      return undefined;
    }
  }
  // 3. type
  const t = jsonType(data);
  const same = rs
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.type === t || (t === "number" && r.type === "integer"));
  return same.length === 1 ? { branch: same[0]!.i } : undefined;
}

const branchAjv = new Ajv2020({
  strict: false,
  allowUnionTypes: true,
  allErrors: true,
  verbose: true,
});
const branchCache = new Map<unknown, ValidateFunction>();

/** Standalone validator for one oneOf/anyOf branch (`$ref`s resolve against the spec's `$defs`). */
function branchValidator(branch: unknown): ValidateFunction {
  let v = branchCache.get(branch);
  if (!v) {
    v = branchAjv.compile({ $defs: rootDefs, ...(branch as object) });
    branchCache.set(branch, v);
  }
  return v;
}

/**
 * Ajv emits a union's branch errors as one contiguous run right before the union error, but
 * errors from `$ref`'d subschemas carry no branch prefix. So the run is found by position and
 * every branch is re-validated on its own to pick the best one; the result is exactly one
 * diagnostic set per location.
 */
function process(errors: ErrorObject[]): Diagnostic[] {
  const removed = new Set<number>();
  const unionDiags = new Map<number, Diagnostic[]>();
  errors.forEach((u, ui) => {
    if ((u.keyword !== "oneOf" && u.keyword !== "anyOf") || removed.has(ui)) return;
    const root = u.instancePath === "";
    const ptitle = isObj(u.parentSchema) ? u.parentSchema.title : undefined;
    const refRoot =
      u.schemaPath === `#/${u.keyword}` &&
      !root &&
      typeof ptitle === "string" &&
      DISCRIMINATED.has(ptitle);
    const inSub = (e: ErrorObject): boolean =>
      e.instancePath === u.instancePath || e.instancePath.startsWith(`${u.instancePath}/`);
    const run: number[] = [];
    for (let j = ui - 1; j >= 0; j--) {
      const e = errors[j]!;
      if (!inSub(e)) break;
      if (removed.has(j) || unionDiags.has(j)) {
        run.push(j);
        continue;
      }
      // A union that is the root of a `$ref`'d definition (schema path `#/oneOf`) has nothing
      // before it but its branches, whose errors carry paths relative to their own `$ref`s.
      const prefixed = refRoot || e.schemaPath.startsWith(`${u.schemaPath}/`);
      const leaf =
        !root && e.instancePath !== u.instancePath && e.schemaPath.startsWith("#/$defs/");
      if (!prefixed && !leaf) break;
      run.push(j);
    }
    for (const j of run) {
      removed.add(j);
      unionDiags.delete(j);
    }
    removed.add(ui);

    const branches = Array.isArray(u.schema) ? (u.schema as unknown[]) : [];
    const results = branches.map((b) => {
      const v = branchValidator(b);
      v(u.data);
      return (v.errors ?? []).map((e) => ({ ...e, instancePath: u.instancePath + e.instancePath }));
    });
    let best: number | undefined;
    let bestScore = Infinity;
    let tie = false;
    results.forEach((list, idx) => {
      if (list.length === 0) return;
      const shallow = list.filter((e) => e.instancePath === u.instancePath).length;
      const score = shallow * 10 + list.length;
      if (score < bestScore) {
        bestScore = score;
        best = idx;
        tie = false;
      } else if (score === bestScore) tie = true;
    });
    const parent = isObj(u.parentSchema) ? u.parentSchema : undefined;
    const title = parent && typeof parent.title === "string" ? parent.title : undefined;
    // The data's own discriminator (kind, action key, string vs object) names the branch:
    // report that branch's errors, ahead of the closest-branch heuristic.
    const pick =
      u.keyword === "oneOf" && title !== undefined && DISCRIMINATED.has(title)
        ? discriminateBranch(branches, u.data, u.instancePath, title)
        : undefined;
    if (pick !== undefined) {
      if ("diagnostic" in pick) {
        unionDiags.set(ui, [pick.diagnostic]);
        return;
      }
      if (results[pick.branch]!.length > 0) {
        unionDiags.set(ui, process(results[pick.branch]!));
        return;
      }
    }
    if (best !== undefined && !tie && bestScore < 10) {
      unionDiags.set(ui, process(results[best]!));
      return;
    }
    const desc = branches.map(describeBranch);
    const allRequired =
      branches.length > 0 &&
      branches.every((b) => isObj(b) && Array.isArray(b.required) && !("type" in b));
    const rootNeeds = allRequired
      ? branches.map((b) => String(((b as Record<string, unknown>).required as unknown[])[0]))
      : [];
    const matchedMany = u.keyword === "oneOf" && results.filter((l) => l.length === 0).length > 1;
    unionDiags.set(ui, [
      {
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
      },
    ]);
  });
  const out: Diagnostic[] = [];
  errors.forEach((e, i) => {
    if (unionDiags.has(i)) out.push(...unionDiags.get(i)!);
    else if (!removed.has(i)) out.push(convert(e));
  });
  return out;
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
        message: `Unknown field ${q(prop)}`,
        suggestion:
          hint ??
          (e.instancePath === ""
            ? `If ${q(prop)} is a newer field, upgrade platformcosmo (this engine implements schema revision ${SCHEMA_REVISION})`
            : `Remove ${q(prop)}; allowed fields: ${props.join(", ")}`),
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
          message: `Unknown color ${q(e.data)}`,
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

/** Ajv errors to diagnostics, with oneOf/anyOf collapsed to one diagnostic per location. */
export function schemaDiagnostics(errors: ErrorObject[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of process(errors)) {
    const key = `${d.path}\u0000${d.code}\u0000${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return sortDiagnostics(out);
}
