# @platformcosmo/parts-auto

## 0.1.1

### Patch Changes

- 05b23b6: Add a README to every package, so the npm pages show what each package does, how to install and use it, and its license. No code changes.
- Updated dependencies [05b23b6]
  - @platformcosmo/core@0.1.1

## 0.1.0

### Minor Changes

- a2b4e49: `auto:` engine defaults now compose at documented anchors (`engineLayout`, assemblies 5.2): rod 156 mm (centres 117 mm apart), crankshaft with a 40 mm nose and output stub (500 mm long), open-top `oil-pan`, 420 mm intake, exhaust and valve cover aligned to the 105 mm bore pitch; the rod's big end is outside its core so lifting rods out of the crank no longer reports `assembly/transit-collision`.
  
  Behaviour changes: the crankshaft's origin is now 40 mm before the block (500 mm long, nose and stub outside the core); the oil pan is no longer solid (open tray); the rod is 156 mm with a smaller core (big end and lower beam excluded); intake, exhaust and valve cover are 420 mm.
- aea4fea: New `@platformcosmo/parts-auto`: the 12 `auto:` engine part shapes (block-i4, head, valve-cover, crankshaft, camshaft, piston, rod, valve, oil-pan, intake, exhaust, timing-belt) in true millimetres, with bounded params (`cylinders` 2..8, `bore`, `valves` per cylinder), a solid-core `depthBox` that excludes protrusions, and `readParams` with did-you-mean.

### Patch Changes

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
