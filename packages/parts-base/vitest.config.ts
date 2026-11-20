import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "parts-base", include: ["test/**/*.test.ts"] } });
