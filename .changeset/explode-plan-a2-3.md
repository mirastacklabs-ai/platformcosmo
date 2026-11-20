---
"@platformcosmo/core": minor
---

Explode programs and the step plan (schema 1.2.0, scene only): `SceneAssembly.programs` and `basePose` now carry resolved explode programs (selectors scoped to the program owner, direction presets, program-level automatic stacking, order, stagger and overrides, labels and fade flags), `SceneGraph.assemblies.plan` carries the step plan for explode and implode actions (cumulative levels, implicit access for nested targets, one motion window, compression and loop-closure rule shared with figures), and `reachBounds` covers every pose the actions play. Specs without assemblies produce the same scene as before.
