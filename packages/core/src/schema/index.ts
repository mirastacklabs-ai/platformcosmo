/** Schema stage (Track A2): parse, validate (JSON Schema + semantic + suggestions). */
import type { ValidateFn } from "../contracts/index.js";
import { schemaDiagnostics, sortDiagnostics } from "./diagnose.js";
import { semanticDiagnostics } from "./semantic.js";
import type { PlatformCosmoSpec } from "./types.gen.js";
import { runSchema } from "./validate.js";

export { parseSpec } from "./parse.js";
export { validateSpec, SCHEMA_ID, SCHEMA_REVISION } from "./validate.js";
export type { SpecError, ValidationResult } from "./validate.js";
export { PARTICLE_LIMIT, particleCount } from "./semantic.js";
export { editDistance, closestMatches } from "./suggest.js";

/**
 * Full validation: JSON Schema (oneOf/anyOf collapsed to one diagnostic per location), then
 * semantic checks (ids, references, DC refs, icons, overlaps, particle budget), each with a
 * "did you mean" hint where one exists. Semantic checks run only on schema-valid specs.
 * Diagnostics are sorted by (path, code).
 */
export const validate: ValidateFn = (spec, context = {}) => {
  const schemaErrors = runSchema(spec);
  if (schemaErrors.length > 0) {
    return { valid: false, diagnostics: schemaDiagnostics(schemaErrors) };
  }
  const typed = spec as PlatformCosmoSpec;
  const diagnostics = sortDiagnostics(semanticDiagnostics(typed, context));
  const valid = !diagnostics.some((d) => d.severity === "error");
  return valid ? { valid, spec: typed, diagnostics } : { valid, diagnostics };
};
