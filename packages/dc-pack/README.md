# @platformcosmo/dc-pack

Data-center content for platformcosmo specs: parametric racks with devices in U positions, rows, aisles, power, cooling, cables and floor equipment (UPS, busway, floor PDU, CRAH, in-row cooler, CDU, tape library), plus rack and server close-ups in assembly mode.

```js
import { render } from "@platformcosmo/core";
import { dcPack } from "@platformcosmo/dc-pack";

await render(spec, { themes, dc: dcPack }); // required when the spec has racks or equipment
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/dc-pack).
