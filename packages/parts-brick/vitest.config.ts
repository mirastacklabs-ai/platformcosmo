import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "parts-brick", include: ["test/**/*.test.ts"] } });
