import type { Diagnostic } from "@platformcosmo/core";

const ORDER = { error: 0, warning: 1, info: 2 } as const;

/** One line per diagnostic: `error semantic/unknown-node /edges/0/to: message (did you mean "x"?)`. */
export function formatDiagnostic(d: Diagnostic, file?: string): string {
  const where = `${file ?? ""}${d.path ? `#${d.path}` : ""}`;
  const loc = where ? ` ${where}:` : "";
  const hint = d.suggestion ? ` (${d.suggestion})` : "";
  return `${d.severity} ${d.code}${loc} ${d.message}${hint}`;
}

export function formatDiagnostics(list: readonly Diagnostic[], file?: string): string {
  return [...list]
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
    .map((d) => formatDiagnostic(d, file) + "\n")
    .join("");
}

export function hasErrors(list: readonly Diagnostic[]): boolean {
  return list.some((d) => d.severity === "error");
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function errorDiagnostic(code: string, message: string, suggestion?: string): Diagnostic {
  return {
    severity: "error",
    code,
    path: "",
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}
