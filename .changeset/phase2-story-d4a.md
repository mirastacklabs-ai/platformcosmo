---
"@platformcosmo/core": minor
"@platformcosmo/dc-pack": patch
"platformcosmo": minor
---

Phase 2 renders (schema 1.2.0, D-4a, lifting the `phase2` guard): rack programs, slot internals, close-ups (fields and `…/closeup` paths), actions on racks and slots, and build programs now validate and render in every output. Figure close-ups draw the figure in their level (each instance with its own pose, checked as a figure action), and a figure a `closeup` names is drawn only there. Levels are drawn at their own scale, a focus inside a level zooms onto that node, and frame and step outputs keep levels in the camera. Counted parts moved together share one label, a zoom widens to hold a label it would cut, and a targeted rack's devices keep their 1.1 fronts at rest. New gallery example "From the hall to the heat sink" with synthetic images, and a user guide for assemblies and close-ups.
