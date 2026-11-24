# @platformcosmo/icons-base

The platformcosmo base icon glyphs (`cosmo:*`): the default icons for the semantic node types (servers, load balancers, databases, queues, LLMs, vector DBs, GPUs and more).

```js
import { createIconResolver, sanitizeSvg } from "@platformcosmo/core";
import { pack } from "@platformcosmo/icons-base";

const icons = createIconResolver([pack], sanitizeSvg);
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/icons-base).
