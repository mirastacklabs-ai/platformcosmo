import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import schema from "../../../../schema/v1.json" with { type: "json" };
import type { PlatformCosmoSpec } from "./types.gen.js";

export interface SpecError {
  /** JSON pointer to the offending value ("" is the document root). */
  path: string;
  message: string;
  keyword: string;
  /** Raw Ajv params (e.g. { additionalProperty } or { allowedValues }). */
  params: Record<string, unknown>;
}

export type ValidationResult =
  { valid: true; spec: PlatformCosmoSpec; errors: [] } | { valid: false; errors: SpecError[] };

/** Schema $id; per spec major version, never moves (PLAN §5). */
export const SCHEMA_ID: string = schema.$id;
/** Additive schema revision within the major (PLAN §5 version policy). */
export const SCHEMA_REVISION: string = schema["x-revision"];

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true, verbose: true });
ajv.addKeyword({ keyword: "x-revision", schemaType: "string" });
const compiled = ajv.compile<PlatformCosmoSpec>(schema);

/** Raw Ajv run (verbose errors); used by `validate` to build diagnostics. */
export function runSchema(input: unknown): ErrorObject[] {
  return compiled(input) ? [] : [...(compiled.errors ?? [])];
}

/**
 * JSON Schema validation only.
 *
 * @deprecated Use `validate` (schema + semantic checks + suggestions, as `Diagnostic`s).
 */
export function validateSpec(input: unknown): ValidationResult {
  if (compiled(input)) return { valid: true, spec: input, errors: [] };
  const errors = (compiled.errors ?? []).map((e): SpecError => {
    const extra =
      e.keyword === "additionalProperties" ? `/${String(e.params.additionalProperty)}` : "";
    return {
      path: e.instancePath + extra,
      message: e.message ?? "invalid",
      keyword: e.keyword,
      params: e.params,
    };
  });
  return { valid: false, errors };
}
