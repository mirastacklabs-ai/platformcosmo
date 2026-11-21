---
"@platformcosmo/core": minor
---

Assembly render model and emit (schema 1.2.0, not reachable from `validate` until Phase 1b is lifted): `RenderModel.assembly` carries the depth epochs, the one DOM order, per-copy tracks, labels and leaders, reach-bounds extents, per-step END-pose focus rects and `frameAt`/`stepEnd`. The wrapper chain is `host > clip > motion > visible > fade > part`. `createIds` now returns the whole `AssemblyIdScheme`. Specs without assemblies render byte-identically.
