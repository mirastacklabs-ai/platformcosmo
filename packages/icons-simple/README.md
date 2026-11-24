# @platformcosmo/icons-simple

Brand icons from [Simple Icons](https://simpleicons.org), filtered to icons whose data declares CC0-1.0 or Apache-2.0 (MIT icons are excluded because their notice cannot travel), as a platformcosmo icon pack (`simple:*`).

```js
import { createIconResolver, sanitizeSvg } from "@platformcosmo/core";
import { pack } from "@platformcosmo/icons-simple";

const icons = createIconResolver([pack], sanitizeSvg);
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Package code Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Each icon keeps its own license, recorded in `icons.json` (see `LICENSE-SIMPLE-ICONS.txt` and `NOTICE-SIMPLE-ICONS.txt`). The brands are trademarks of their owners; use does not imply endorsement. Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/icons-simple).
