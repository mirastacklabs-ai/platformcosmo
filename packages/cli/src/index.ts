import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HELP = `pcosmo ${pkg.version}

Usage: pcosmo [options]

Options:
  -v, --version  Print version
  -h, --help     Show this help
`;

export function run(argv: string[]): RunResult {
  let values: { help?: boolean | undefined; version?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
      allowPositionals: false,
    }));
  } catch (e) {
    return { code: 2, stdout: "", stderr: `${(e as Error).message}\n\n${HELP}` };
  }
  if (values.version) return { code: 0, stdout: `${pkg.version}\n`, stderr: "" };
  return { code: 0, stdout: HELP, stderr: "" };
}
