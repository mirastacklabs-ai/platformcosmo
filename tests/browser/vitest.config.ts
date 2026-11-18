import { defineConfig } from "vitest/config";

// Only used by tests/browser/run.sh to generate fixtures; not part of the normal test run.
export default defineConfig({
  test: { name: "browser-fixtures", include: ["tests/browser/generate.test.ts"] },
});
