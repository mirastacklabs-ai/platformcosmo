import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "from-image", include: ["*.test.mjs"], testTimeout: 30000 },
});
