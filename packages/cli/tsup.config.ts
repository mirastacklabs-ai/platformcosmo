import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  // The private raster package is a devDependency: it ships inside the CLI bundle.
  noExternal: ["@platformcosmo/assets"],
});
