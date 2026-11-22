---
"@platformcosmo/core": minor
"platformcosmo": minor
---

New `@platformcosmo/core/internal` subpath for first-party helpers that were marked `@internal` on the root entry (`didYouMean`, `AssemblyPrograms`, `reassignSplit`, `rackTargeted`, `buildAssemblies`, `closeupDiagnostics`). Unstable: not public API, may change in any release. They are no longer exported from `@platformcosmo/core`. `pcosmo assets crop` gains `--scale 0.25-8`.
