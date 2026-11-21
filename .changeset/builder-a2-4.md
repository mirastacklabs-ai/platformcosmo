---
"@platformcosmo/core": minor
---

TypeScript builder for assemblies (design §16): new exports `spec`, `assembly`, `explode`, `build` and `figure`. They produce plain spec JSON (typed by the generated spec types, no defaults, no I/O, nothing throws) that still goes through `validate`; racks, storyboards, images and steps are added through `spec()`.
