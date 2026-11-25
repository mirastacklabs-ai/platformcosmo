# @platformcosmo/themes

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

- 971619a: MiraStack Labs brand look as the default (D51): `light` and `dark` take the brand colours, Oswald (display text) and JetBrains Mono (badges, metrics, edge labels via the new optional `font.mono` theme token) replace Inter in all four themes, and `canvas.grid` now defaults to `true` (schema revision 1.1.3). Set `"grid": false` for the old plain background.
  
  The exported `EMBED_FAMILY` value changes from "Inter" to "Oswald" (new `EMBED_MONO_FAMILY`: "JetBrains Mono"); `FontAsset`s now hold five faces (Oswald 400/500/600, JetBrains Mono 400/700). Display glyphs Oswald lacks (arrows) fall back to JetBrains Mono. Label, badge, metric, caption and legend sizes grow with the scene width so wide diagrams stay legible when shown small.

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
