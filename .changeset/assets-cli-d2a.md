---
"platformcosmo": minor
---

`pcosmo assets doctor|crop|cutout|locate|align|figure|check|shrink` (figure ingestion: sprites, clean base, quality gate, spec fragment), and `pcosmo build`/`validate` now read the files a spec's `images[]` names, through a symlink-safe path guard (`image/not-found`, `image/unsafe-path`, `image/too-large`), so figure specs render end to end. The figure manifest schema ships as `schema/figure-manifest.v1.json`.
