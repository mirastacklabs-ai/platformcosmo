---
"platformcosmo": minor
---

`pcosmo assets pdf info|list|extract|compose|render|text`: inspect a PDF, list and extract its raster images (`p<page>-i<index>.png|jpg` plus `manifest.json`, `--mask` for soft masks), compose a page's images at their placements into a PNG or SVG (`--crop`, `--annotate`), print text runs as data, and render pages through an optional `pdftoppm` or `mutool` (fixed argument list, no shell, minimal environment, timeout with process-group kill, 16 MP and output-size caps, validated output). `assets doctor` now reports the PDF limits and whether a renderer is available. `@platformcosmo/pdf` is now a dependency of the CLI.
