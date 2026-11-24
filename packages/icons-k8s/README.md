# @platformcosmo/icons-k8s

The Kubernetes community icons as a platformcosmo icon pack (`k8s:*`).

```js
import { createIconResolver, sanitizeSvg } from "@platformcosmo/core";
import { pack } from "@platformcosmo/icons-k8s";

const icons = createIconResolver([pack], sanitizeSvg);
```

Part of [platformcosmo](https://www.npmjs.com/package/platformcosmo), prompt to animated isometric
architecture diagrams, built by the engineering team at [MIRASTACK LABS](https://www.mirastacklabs.ai).
Most people use it through the CLI (`npx platformcosmo build my.cosmo.json`) or the Claude Code plugin,
which already include it. Docs: [platformcosmo.io](https://platformcosmo.io).

## License

Apache-2.0 (package code and the Kubernetes icons, Apache-2.0 option; see `NOTICE-K8S.txt`). Kubernetes is a trademark of The Linux Foundation; use does not imply endorsement. Source: [github.com/mirastacklabs-ai/platformcosmo](https://github.com/mirastacklabs-ai/platformcosmo/tree/main/packages/icons-k8s).
