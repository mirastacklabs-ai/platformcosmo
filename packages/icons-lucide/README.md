# @platformcosmo/icons-lucide

A curated subset of the [Lucide](https://lucide.dev) icons as a platformcosmo icon pack (`lucide:*`).

```js
import { createIconResolver, sanitizeSvg } from "@platformcosmo/core";
import { pack } from "@platformcosmo/icons-lucide";

const icons = createIconResolver([pack], sanitizeSvg);
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Package code Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Icons: ISC (Lucide), plus MIT for Feather-derived icons (see `LICENSE-LUCIDE` and `NOTICE`). Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/icons-lucide).
