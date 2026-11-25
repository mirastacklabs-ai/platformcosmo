# @platformcosmo/dc-pack

## 0.1.2

### Patch Changes

- 6e752e5: Clear npm descriptions and search keywords for every package (the `icons-simple` description no longer claims MIT icons, which are excluded). No code changes.
- Updated dependencies [6e752e5]
  - @platformcosmo/core@0.1.2

## 0.1.1

### Patch Changes

- 05b23b6: Add a README to every package, so the npm pages show what each package does, how to install and use it, and its license. No code changes.
- Updated dependencies [05b23b6]
  - @platformcosmo/core@0.1.1

## 0.1.0

### Minor Changes

- f550a70: DC assembly mode (schema 1.2.0, E-1): `dcPack.buildAssembly` builds a rack that a step action targets as an assembly (frame leaves, one sub-assembly per slot, tray + lid with internals for `slots[].assembly`, mirrored fronts, the built-in `drawers` program, the slot `internals` program and the rack's own `programs`, the below-floor error) and `dcPack.shapes` adds the `dc:` part shapes (the 15 rack devices at true scale). Racks nothing targets keep their pre-1.2 objects and output bytes.

### Patch Changes

- b6b1ec4: Racks in mirrored rows (a row facing the other way, such as row B of the data-center hall) are now drawn as the half turn they are, instead of only reflecting y: the rear posts swap sides, the PDU stands behind the rear door's stile instead of showing through it, and the rear-door heat exchanger hangs between the posts. This is a visual change for specs with mirrored rows (the `dc-hall` and `hall-to-heatsink` examples; their gallery renders and visual goldens are regenerated); racks in unmirrored rows are byte-identical.
- f75a9d9: Phase 2 renders (schema 1.2.0, D-4a, lifting the `phase2` guard): rack programs, slot internals, close-ups (fields and `…/closeup` paths), actions on racks and slots, and build programs now validate and render in every output. Figure close-ups draw the figure in their level (each instance with its own pose, checked as a figure action), and a figure a `closeup` names is drawn only there. Levels are drawn at their own scale, a focus inside a level zooms onto that node, and frame and step outputs keep levels in the camera. Counted parts moved together share one label, a zoom widens to hold a label it would cut, and a targeted rack's devices keep their 1.1 fronts at rest. New gallery example "From the hall to the heat sink" with synthetic images, and a user guide for assemblies and close-ups.
- Updated dependencies [fa0bdd7]
- Updated dependencies [c576f04]
- Updated dependencies [aed9761]
- Updated dependencies [ae2417e]
- Updated dependencies [971619a]
- Updated dependencies [a8ff00d]
- Updated dependencies [ec442dc]
- Updated dependencies [dfa3bcb]
- Updated dependencies [a532041]
- Updated dependencies [8147b91]
- Updated dependencies [011777e]
- Updated dependencies
- Updated dependencies [056a440]
- Updated dependencies [fb45bc3]
- Updated dependencies [66c8478]
- Updated dependencies [7ce841e]
- Updated dependencies [8562aa6]
- Updated dependencies [7538619]
- Updated dependencies [54135e3]
- Updated dependencies [2d486b9]
- Updated dependencies [f75a9d9]
- Updated dependencies [7d9f846]
- Updated dependencies [c855036]
- Updated dependencies [4851912]
- Updated dependencies [9395785]
  - @platformcosmo/core@0.1.0
