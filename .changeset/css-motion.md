---
"@platformcosmo/core": minor
"platformcosmo": minor
---

CSS `offset-path` particle motion mode: `RenderOptions.motion: "smil" | "css"` and `pcosmo build --motion css`. The css mode emits no SMIL elements (for hosts that strip SMIL but keep `<style>`); timing, phases, budgets and reduced motion match smil, and static/PNG/GIF/MP4 output is unchanged.
