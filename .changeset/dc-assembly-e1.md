---
"@platformcosmo/dc-pack": minor
---

DC assembly mode (schema 1.2.0, E-1): `dcPack.buildAssembly` builds a rack that a step action targets as an assembly (frame leaves, one sub-assembly per slot, tray + lid with internals for `slots[].assembly`, mirrored fronts, the built-in `drawers` program, the slot `internals` program and the rack's own `programs`, the below-floor error) and `dcPack.shapes` adds the `dc:` part shapes (the 15 rack devices at true scale). Racks nothing targets keep their pre-1.2 objects and output bytes.
