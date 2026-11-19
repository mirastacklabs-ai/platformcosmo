---
"@platformcosmo/core": minor
"@platformcosmo/themes": minor
"platformcosmo": minor
---

MiraStack Labs brand look as the default (D51): `light` and `dark` take the brand colours, Oswald (display text) and JetBrains Mono (badges, metrics, edge labels via the new optional `font.mono` theme token) replace Inter in all four themes, and `canvas.grid` now defaults to `true` (schema revision 1.1.3). Set `"grid": false` for the old plain background.

The exported `EMBED_FAMILY` value changes from "Inter" to "Oswald" (new `EMBED_MONO_FAMILY`: "JetBrains Mono"); `FontAsset`s now hold five faces (Oswald 400/500/600, JetBrains Mono 400/700). Display glyphs Oswald lacks (arrows) fall back to JetBrains Mono. Label, badge, metric, caption and legend sizes grow with the scene width so wide diagrams stay legible when shown small.
