---
"@platformcosmo/core": patch
"platformcosmo": patch
---

Figures render (assemblies track R-1): `images` and `figures` are no longer rejected as `assembly/unsupported`. A figure is an upright panel with its base image and cut-out sprites (embedded once per image, EXIF orientation applied) that move between their seated and exploded positions in explode/implode steps, as CSS in both motion modes and as exact frames for PNG, GIF and MP4. Motion arrows fade, labels with leader lines appear when parts arrive, a credits line lists image attributions, and reduced motion shows discrete per-step poses. A figure can take a step `focus`, and an explicit `pos` that overlaps other content warns (`layout/overlap`). Rendering needs the prepared images (`RenderOptions.images`); a missing one is `image/not-found`. Assemblies, storyboards and the later phases are still guarded.
