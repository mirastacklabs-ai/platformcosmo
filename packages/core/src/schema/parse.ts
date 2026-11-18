import { LineCounter, parseDocument } from "yaml";
import type { Diagnostic, ParseSpecFn } from "../contracts/index.js";

const MAX_CHARS = 8 * 1024 * 1024;

function fail(
  code: string,
  message: string,
  line: number,
  column: number,
  suggestion?: string,
): { diagnostics: Diagnostic[] } {
  return {
    diagnostics: [
      {
        severity: "error",
        code,
        path: "",
        message,
        ...(suggestion === undefined ? {} : { suggestion }),
        params: { line, column },
      },
    ],
  };
}

function lineCol(text: string, pos: number): { line: number; column: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  let line = 1;
  let last = -1;
  for (let i = 0; i < p; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: p - last };
}

function parseJson(text: string) {
  try {
    return { spec: JSON.parse(text) as unknown, diagnostics: [] as Diagnostic[] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let line = 1;
    let column = 1;
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const at = /position (\d+)/.exec(msg);
    if (lc) {
      line = Number(lc[1]);
      column = Number(lc[2]);
    } else if (at) {
      ({ line, column } = lineCol(text, Number(at[1])));
    } else if (/end of JSON|Unexpected end/i.test(msg)) {
      ({ line, column } = lineCol(text, text.length));
    }
    return fail("parse/json", `Invalid JSON: ${msg}`, line, column);
  }
}

function parseYaml(text: string) {
  try {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, {
      version: "1.2",
      schema: "core",
      lineCounter,
      uniqueKeys: true,
    });
    const err = doc.errors[0];
    if (err) {
      const pos = err.linePos?.[0] ?? lineCounter.linePos(err.pos[0]);
      const nice = err.message.split("\n")[0] ?? err.message;
      return fail("parse/yaml", `Invalid YAML: ${nice}`, pos.line, pos.col);
    }
    return { spec: doc.toJS({ maxAliasCount: 50 }) as unknown, diagnostics: [] as Diagnostic[] };
  } catch (e) {
    return fail("parse/yaml", `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`, 1, 1);
  }
}

/**
 * Parses `.cosmo.json` / `.cosmo.yaml` text. YAML is read with the 1.2 core schema (`yes`/`on` stay
 * strings), duplicate keys are rejected, and parse errors carry 1-based `params.line`/`params.column`.
 */
export const parseSpec: ParseSpecFn = (text, format) => {
  if (typeof text !== "string") {
    return fail("parse/not-text", "Spec input must be text", 1, 1);
  }
  if (text.length > MAX_CHARS) {
    return fail("parse/too-large", "Spec is larger than 8M characters", 1, 1);
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (format === "json") return parseJson(src);
  if (format === "yaml") return parseYaml(src);
  return fail("parse/format", `Unknown format "${String(format)}"`, 1, 1, 'Use "json" or "yaml"');
};
