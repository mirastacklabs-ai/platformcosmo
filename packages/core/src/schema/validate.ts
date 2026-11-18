import { Ajv2020 } from "ajv/dist/2020.js";
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

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
const validate = ajv.compile<PlatformCosmoSpec>(schema);

/** JSON Schema validation only. Semantic checks arrive in M1. */
export function validateSpec(input: unknown): ValidationResult {
  if (validate(input)) return { valid: true, spec: input, errors: [] };
  const errors = (validate.errors ?? []).map((e): SpecError => {
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
