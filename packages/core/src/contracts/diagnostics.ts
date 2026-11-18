/**
 * Diagnostics contract (frozen). Every stage reports problems as `Diagnostic`s;
 * nothing in the pipeline throws for bad user input.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /**
   * Stable machine code, kebab-case, namespaced by stage, e.g. `schema/additional-property`,
   * `semantic/unknown-node`, `semantic/icon-not-installed`, `layout/overlap`, `budget/elements`.
   */
  readonly code: string;
  /** JSON pointer into the spec ("" = root). */
  readonly path: string;
  /** One sentence, human readable. */
  readonly message: string;
  /** "Did you mean" or fix hint, when one exists (PLAN §5 validation layer 3). */
  readonly suggestion?: string;
  /** Extra machine-readable data (e.g. Ajv params, candidate ids). */
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Result of full validation: JSON Schema + semantic checks + suggestions. */
export interface ValidationReport<TSpec> {
  /** True when there are no `error` diagnostics. */
  readonly valid: boolean;
  /** The typed spec, present when `valid`. */
  readonly spec?: TSpec;
  readonly diagnostics: readonly Diagnostic[];
}
