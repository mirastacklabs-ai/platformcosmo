import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "pdf", include: ["test/**/*.test.ts"] } });
