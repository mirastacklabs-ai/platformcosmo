import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "parts-auto", include: ["test/**/*.test.ts"] } });
