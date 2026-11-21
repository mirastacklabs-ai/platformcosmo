---
"@platformcosmo/core": minor
---

Explode programs and the step plan (schema 1.2.0, scene only): `SceneAssembly.programs` and `basePose` now carry resolved explode programs (selectors scoped to the program owner, direction presets, program-level automatic stacking in moved frames, order, stagger and overrides, labels and fade flags), `SceneGraph.assemblies.plan` carries the step plan for explode and implode actions (cumulative levels from one machine shared with validation, implicit access as a single move via the optional `ProgramLevel.only` and `ResolvedAction.accessLength`, one motion window and compression shared with figures, reported by validation), and `reachBounds` covers every pose the actions play. Specs without assemblies produce the same scene as before.
