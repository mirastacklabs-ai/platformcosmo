import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { run } from "../src/index.js";

describe("run", () => {
  test("--version", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: "" });
  });
  test("--help", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: pcosmo");
  });
  test("unknown option fails", () => {
    expect(run(["--nope"]).code).toBe(2);
  });
});

describe("built bin (requires pnpm build)", () => {
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  test("keeps shebang and prints version", () => {
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" })).toBe(
      `${pkg.version}\n`,
    );
  });
});
