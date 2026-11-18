# Visual regression

`scripts/pc run visual` renders the gallery examples, lesson templates and harness fixtures to PNG
and compares them exactly with the goldens in `golden/<group>/<name>.png` (group: `examples`,
`templates`, `fixtures`). See the header of `run.mjs` for the environment switches.

- Update goldens locally only: `VISUAL_UPDATE=1 scripts/pc run visual`, then commit them.
  CI and `VISUAL_REQUIRE_GOLDENS=1` refuse updates and ignore `VISUAL_ONLY` and threshold overrides.
- Goldens must not be PNG-optimised (oxipng, pngcrush, ImageOptim and the like). Keep the bytes the
  renderer wrote; the decoder only accepts 8-bit RGBA, non-interlaced, and checks the pixel data length.
