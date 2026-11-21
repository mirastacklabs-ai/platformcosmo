---
"@platformcosmo/core": minor
---

Assembly animator (schema 1.2.0, B-1): the animator plays the assembly render model. CSS keyframes per wrapper property (transform, visibility, opacity; identical tracks share one `@keyframes`, elements with the same animations share one rule) in both motion modes with zero SMIL, retimed to the camera at any `--speed`; frame, step and static outputs write the full wrapper state as attributes; reduced motion shows discrete per-step poses for specs with assembly actions; interactive Step pauses at the settled pose. Specs without assemblies, and assemblies without actions, produce the same bytes as before. The `phase1b` guard stays until B-2.
