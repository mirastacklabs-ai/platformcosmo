# @platformcosmo/themes

The four built-in themes: `light` and `dark` (the MIRASTACK LABS brand look: Oswald and JetBrains Mono, teal accents), `blueprint` (blue drafting) and `mono` (greyscale), plus `validateTheme` for custom theme files.

```js
import { render } from "@platformcosmo/core";
import { themeRegistry, themeNames, validateTheme } from "@platformcosmo/themes";

await render(spec, { themes: themeRegistry }); // spec.canvas.theme picks one of themeNames
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Fonts are SIL OFL 1.1 (see `NOTICE`). Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/themes).
