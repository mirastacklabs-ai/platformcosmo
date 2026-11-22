import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only used by tests/browser/run.sh to generate fixtures; not part of the normal test run.
export default defineConfig({
  // parts-base imports @platformcosmo/core: use the sources, so no build is needed first
  resolve: {
    alias: [
      {
        find: "@platformcosmo/core/internal",
        replacement: fileURLToPath(new URL("../../packages/core/src/internal.ts", import.meta.url)),
      },
      {
        find: "@platformcosmo/core",
        replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: { name: "browser-fixtures", include: ["tests/browser/generate.test.ts"] },
});
