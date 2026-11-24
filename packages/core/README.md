# @platformcosmo/core

The deterministic engine behind [platformcosmo](https://www.npmjs.com/package/platformcosmo): it
validates a spec (`*.cosmo.json`) and renders it as an animated isometric SVG, plus static, per-step
and interactive SVG, PNG, GIF and MP4. Layout, routing, depth sorting and animation are pure code, so
the same spec and options always give byte-identical output. No network access, no DOM.

<p align="center">
  <img src="https://raw.githubusercontent.com/mirastacklabs-ai/platformcosmo/main/examples/gallery/rag-pipeline.svg" alt="Animated RAG pipeline diagram rendered by @platformcosmo/core" width="760">
</p>

Most people want the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin; use this
package to render from your own code. Node.js >= 22.12.

```sh
npm i @platformcosmo/core @platformcosmo/themes @platformcosmo/icons-base
```

```js
import { writeFile } from "node:fs/promises";
import { render, createIconResolver, sanitizeSvg } from "@platformcosmo/core";
import { themeRegistry } from "@platformcosmo/themes";
import { pack as base } from "@platformcosmo/icons-base";

const spec = {
  meta: { version: "1", title: "Hello platformcosmo" },
  nodes: [
    { id: "users", type: "users", label: "Users" },
    { id: "api", type: "server", label: "API" },
    { id: "db", type: "sql", label: "Database" },
  ],
  edges: [
    { id: "users-api", from: "users", to: "api" },
    { id: "api-db", from: "api", to: "db" },
  ],
  flows: [{ edge: "users-api" }, { edge: "api-db" }],
};

const { outputs, diagnostics } = await render(spec, {
  themes: themeRegistry,
  icons: createIconResolver([base], sanitizeSvg),
});
for (const d of diagnostics) console.log(d.severity, d.code, d.message);
for (const o of outputs) await writeFile(o.path, o.data); // diagram.svg
```

`render` never throws on bad input: problems come back as `diagnostics` with a stable code, a JSON
pointer and, where possible, a suggestion. Ask for more outputs with
`outputs: ["animated", "static", "steps", "interactive", "png", "gif", "mp4"]`.

## Entry points

| Import                               | What                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@platformcosmo/core`                | `parseSpec`, `validate`, `render`, `createIconResolver`, `sanitizeSvg`, the TypeScript spec builder (`spec`, `assembly`, `explode`, `build`, `figure`) and the spec types |
| `@platformcosmo/core/node`           | Node-only helpers: the ffmpeg encoder for MP4                                                                                                                             |
| `@platformcosmo/core/schema/v1.json` | The JSON Schema (also served at `https://platformcosmo.io/schema/v1.json`)                                                                                                |
| `@platformcosmo/core/internal`       | First-party helpers; unstable, not public API                                                                                                                             |

Related packages: [`@platformcosmo/themes`](https://www.npmjs.com/package/@platformcosmo/themes),
the icon packs (`@platformcosmo/icons-base`, `-lucide`, `-k8s`, `-simple`),
[`@platformcosmo/dc-pack`](https://www.npmjs.com/package/@platformcosmo/dc-pack) for data-center specs
and the part-shape packs (`@platformcosmo/parts-base`, `-brick`, `-auto`) for assemblies.

Spec format and guides: [platformcosmo.io](https://platformcosmo.io).

## License

Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Built by the engineering team at
[MIRASTACK LABS](https://www.mirastacklabs.ai). Embedded fonts (Oswald, JetBrains Mono) are SIL OFL 1.1
(see `NOTICE`). Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo).
