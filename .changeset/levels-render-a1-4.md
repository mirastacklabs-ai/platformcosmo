---
"@platformcosmo/core": minor
---

Levels and views in the assembly render model (schema 1.2.0, Phase 2 stays gated): one level group per close-up (`ids.level`, in the overlay layer) with its own overview, host rect, host focus and cross-fade geometry (`AssemblyLevelRender`), one view group per quarter turn (`ids.view`) with its own projection, depth epochs, tracks, ids (`__v<turn>` suffix) and viewBox (`AssemblyViewRender`), focus targets inside a close-up resolved in the level's own world, merged frame states, and real element counts across levels and views with `budget/views`. Existing output is byte-identical.
