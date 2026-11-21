import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only used by tests/browser/run.sh to generate fixtures; not part of the normal test run.
export default defineConfig({
  // parts-base imports @platformcosmo/core: use the sources, so no build is needed first
  resolve: {
    alias: {
      "@platformcosmo/core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { name: "browser-fixtures", include: ["tests/browser/generate.test.ts"] },
});
