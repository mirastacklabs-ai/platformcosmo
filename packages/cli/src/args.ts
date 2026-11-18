import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "./deps.js";

type OptDef = { type: "boolean" | "string"; short?: string; multiple?: boolean };
export type Options = Record<string, OptDef>;

export interface Parsed {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
}

/** Parses a command's arguments; `--help` and `--packs-dir` are accepted by every command. */
export function parse(args: string[], options: Options, allowNegative = false): Parsed {
  try {
    const r = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        "packs-dir": { type: "string" },
        ...options,
      } as NonNullable<ParseArgsConfig["options"]>,
      allowPositionals: true,
      allowNegative,
      strict: true,
    });
    return { values: r.values, positionals: r.positionals };
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.values[name];
  return typeof v === "string" ? v : undefined;
}

export function flag(p: Parsed, name: string): boolean {
  return p.values[name] === true;
}

/** Parses a finite number option, or undefined when absent. */
export function num(p: Parsed, name: string): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}
