---
"@platformcosmo/core": minor
"platformcosmo": minor
---

Schema revision 1.2.0 (additive): `assemblies`, `images`, `storyboards` and `figures`, step `assembly` actions (explode, implode, build, unbuild), part paths in `steps[].focus` and `steps[].set`, rack `programs`, slot `assembly` and `closeup`; plus the assembly contract types. Not rendered yet: `validate` (and so `pcosmo validate` and `build`) rejects every 1.2.0 field with `assembly/unsupported` until the phase that renders it lands. Design: `docs/design/assemblies.md`.
