---
"@platformcosmo/core": minor
---

Assembly tree and frames (schema 1.2.0, scene only): `SceneGraph.assemblies` now carries the resolved assemblies. `count`/`pitch`/`use` expansion within the leaf and node budgets (same ids as validation), quarter-turn rotations, leaf geometry, rest boxes, per-axis frames (units, `fit`, true scale, anisotropic stud units), roles, `mates` and `inserts` inference, the below-ground lift, and rest-pose focus targets and part states for every assembly path. Specs without assemblies produce the same scene as before.
