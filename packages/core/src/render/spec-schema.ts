import schema from "../../../../schema/v1.json" with { type: "json" };

/**
 * The spec JSON Schema (PLAN §5 schema export). The raw file is also copied to
 * `dist/schema/v1.json` at build time and exported as `@platformcosmo/core/schema/v1.json`.
 */
export const specSchema: typeof schema = schema;
