# @platformcosmo/pdf

A minimal, hardened PDF parser for `pcosmo assets pdf`: pages, image placements (bounding box and matrix), image extraction (JPEG passthrough, everything else as PNG) and text runs. It opens Standard-handler files with an empty user password, repairs damaged cross-reference tables, and bounds every hostile input with a diagnostic instead of throwing.

```js
import { openPdf } from "@platformcosmo/pdf";

const pdf = openPdf(bytes); // Uint8Array; problems come back as diagnostics
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Apache-2.0, Copyright 2026 MIRASTACK LABS PRIVATE LIMITED. Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/pdf).
