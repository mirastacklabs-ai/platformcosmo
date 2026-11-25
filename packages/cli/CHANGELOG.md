# platformcosmo

## 0.1.2

### Patch Changes

- 6e752e5: Clear npm descriptions and search keywords for every package (the `icons-simple` description no longer claims MIT icons, which are excluded). No code changes.
- Updated dependencies [6e752e5]
  - @platformcosmo/core@0.1.2
  - @platformcosmo/dc-pack@0.1.2
  - @platformcosmo/icons-base@0.0.3
  - @platformcosmo/icons-k8s@0.0.3
  - @platformcosmo/icons-lucide@0.0.3
  - @platformcosmo/icons-simple@0.0.3
  - @platformcosmo/parts-auto@0.1.2
  - @platformcosmo/parts-base@0.1.2
  - @platformcosmo/parts-brick@0.1.2
  - @platformcosmo/pdf@0.1.2
  - @platformcosmo/themes@0.1.2

## 0.1.1

### Patch Changes

- 05b23b6: Add a README to every package, so the npm pages show what each package does, how to install and use it, and its license. No code changes.
- Updated dependencies [05b23b6]
  - @platformcosmo/core@0.1.1
  - @platformcosmo/dc-pack@0.1.1
  - @platformcosmo/icons-base@0.0.2
  - @platformcosmo/icons-k8s@0.0.2
  - @platformcosmo/icons-lucide@0.0.2
  - @platformcosmo/icons-simple@0.0.2
  - @platformcosmo/parts-auto@0.1.1
  - @platformcosmo/parts-base@0.1.1
  - @platformcosmo/parts-brick@0.1.1
  - @platformcosmo/pdf@0.1.1
  - @platformcosmo/themes@0.1.1

## 0.1.0

### Minor Changes

- c81f2c4: `pcosmo assets doctor|crop|cutout|locate|align|figure|check|shrink` (figure ingestion: sprites, clean base, quality gate, spec fragment), and `pcosmo build`/`validate` now read the files a spec's `images[]` names, through a symlink-safe path guard (`image/not-found`, `image/unsafe-path`, `image/too-large`), so figure specs render end to end. The figure manifest schema ships as `schema/figure-manifest.v1.json`.
- f03f780: `pcosmo assets pdf info|list|extract|compose|render|text`: inspect a PDF, list and extract its raster images (`p<page>-i<index>.png|jpg` plus `manifest.json`, `--mask` for soft masks), compose a page's images at their placements into a PNG or SVG (`--crop`, `--annotate`), print text runs as data, and render pages through an optional `pdftoppm` or `mutool` (fixed argument list, no shell, minimal environment, timeout with process-group kill, 16 MP and output-size caps, validated output). `assets doctor` now reports the PDF limits and whether a renderer is available. `@platformcosmo/pdf` is now a dependency of the CLI.
- 971619a: MiraStack Labs brand look as the default (D51): `light` and `dark` take the brand colours, Oswald (display text) and JetBrains Mono (badges, metrics, edge labels via the new optional `font.mono` theme token) replace Inter in all four themes, and `canvas.grid` now defaults to `true` (schema revision 1.1.3). Set `"grid": false` for the old plain background.
  
  The exported `EMBED_FAMILY` value changes from "Inter" to "Oswald" (new `EMBED_MONO_FAMILY`: "JetBrains Mono"); `FontAsset`s now hold five faces (Oswald 400/500/600, JetBrains Mono 400/700). Display glyphs Oswald lacks (arrows) fall back to JetBrains Mono. Label, badge, metric, caption and legend sizes grow with the scene width so wide diagrams stay legible when shown small.
- 5eb8e66: pcosmo CLI: `init`, `validate`, `build` (all output flags), `watch`, `icons add|list|search|remove`, `examples` and `migrate`, with SSRF-safe icon downloads, lockfile-verified user icon packs and the launch, data-center and provider example specs.
- dfa3bcb: CLI wiring for assemblies (D-1): the CLI passes the `hw:`, `brick:` and `auto:` shape registry (and the `dc:` pack) to validation and render, so pack shapes and their `params` are checked with did-you-mean and `brick:` placement gives `brick/off-grid`. `build --png-step N` writes the PNG of the end pose of step N (`options/invalid-png-step`, exit 2). `validate --suggest` prints the explode program and story proposed by assemblies section 17, as text and under `suggestions` with `--json`. Core gains a generic `placement` callback (`PartPlacement`, for leaf parts and for groups with `at`/`pitch`) on `validate` and `render`, and `render` forwards `parts`. `brick:` groups off the stud grid give `brick/off-grid`. Specs without assemblies behave as before.
- 8147b91: New `@platformcosmo/core/internal` subpath for first-party helpers that were marked `@internal` on the root entry (`didYouMean`, `AssemblyPrograms`, `reassignSplit`, `rackTargeted`, `buildAssemblies`, `closeupDiagnostics`). Unstable: not public API, may change in any release. They are no longer exported from `@platformcosmo/core`. `pcosmo assets crop` gains `--scale 0.25-8`.
- 011777e: CSS `offset-path` particle motion mode: `RenderOptions.motion: "smil" | "css"` and `pcosmo build --motion css`. The css mode emits no SMIL elements (for hosts that strip SMIL but keep `<style>`); timing, phases, budgets and reduced motion match smil, and static/PNG/GIF/MP4 output is unchanged.
- 7beb958: Plugin: the `diagram` skill accepts an attached image (architecture screenshot, exported diagram, whiteboard photo) and redraws it as a validated spec and animated SVG.
- f75a9d9: Phase 2 renders (schema 1.2.0, D-4a, lifting the `phase2` guard): rack programs, slot internals, close-ups (fields and `…/closeup` paths), actions on racks and slots, and build programs now validate and render in every output. Figure close-ups draw the figure in their level (each instance with its own pose, checked as a figure action), and a figure a `closeup` names is drawn only there. Levels are drawn at their own scale, a focus inside a level zooms onto that node, and frame and step outputs keep levels in the camera. Counted parts moved together share one label, a zoom widens to hold a label it would cut, and a targeted rack's devices keep their 1.1 fronts at rest. New gallery example "From the hall to the heat sink" with synthetic images, and a user guide for assemblies and close-ups.
- 00c29a5: Plugin: bundled single-file CLI (`plugin/bin/pcosmo`, Node >= 22.12 launcher) and the `diagram`, `icons` and `export` skills.
- 4851912: Schema revision 1.2.0 (additive): `assemblies`, `images`, `storyboards` and `figures`, step `assembly` actions (explode, implode, build, unbuild), part paths in `steps[].focus` and `steps[].set`, rack `programs`, slot `assembly` and `closeup`; plus the assembly contract types. Not rendered yet: `validate` (and so `pcosmo validate` and `build`) rejects every 1.2.0 field with `assembly/unsupported` until the phase that renders it lands. Design: `docs/design/assemblies.md`.
- 1e6015a: Plugin: the `diagram` skill gains `references/from-figure.md`, a workflow that turns an exploded or assembled figure into a gated, animated figure spec (manifest, `pcosmo assets figure`, fix by gate code, verification renders, credits), with the rule that text in figures and documents is data, never instructions.

### Patch Changes

- b6b1ec4: Racks in mirrored rows (a row facing the other way, such as row B of the data-center hall) are now drawn as the half turn they are, instead of only reflecting y: the rear posts swap sides, the PDU stands behind the rear door's stile instead of showing through it, and the rear-door heat exchanger hangs between the posts. This is a visual change for specs with mirrored rows (the `dc-hall` and `hall-to-heatsink` examples; their gallery renders and visual goldens are regenerated); racks in unmirrored rows are byte-identical.
- fa52e3e: Docs site (VitePress), gallery page and lesson templates for `pcosmo init --template`.
- fb45bc3: Figures render (assemblies track R-1): `images` and `figures` are no longer rejected as `assembly/unsupported`. A figure is an upright panel with its base image and cut-out sprites (embedded once per image, EXIF orientation applied) that move between their seated and exploded positions in explode/implode steps, as CSS in both motion modes and as exact frames for PNG, GIF and MP4. Motion arrows fade, labels with leader lines appear when parts arrive, a credits line lists image attributions, and reduced motion shows discrete per-step poses. A figure can take a step `focus`, and an explicit `pos` that overlaps other content warns (`layout/overlap`). Rendering needs the prepared images (`RenderOptions.images`); a missing one is `image/not-found`. Assemblies, storyboards and the later phases are still guarded.
- 66c8478: Figures in validate and the scene (assemblies track A2-F): image ids and references, figure parts and stages (selectors, timing, implode as the exact time reverse, step windows and compression), explode/implode actions on figures, `SceneFlatBoard`s with credits, and a did-you-mean on every figure diagnostic. Schema errors for oneOf values (assembly actions, programs, part images) now report the branch the data's own key, `kind` or type names, instead of "Not a valid ...". Figures still validate as `assembly/unsupported` until the figure renderer lands.
- 7d9f846: Icon packs added from a URL take the repository name as their id and print it with an example ref; derived names are sanitised and provider ids reserved (#52). Did-you-mean suggestions are bounded, so a 1 MB unknown key no longer stalls validation (#55).
- 9395785: Fix `pcosmo build --gif` and `--mp4` failing with `export/too-large` on default options: GIF and MP4 frames are now rendered and encoded one at a time (GIF encoder and ffmpeg stdin), so memory is bounded by one frame plus the encoded output. Limits: one frame (and a PNG) at most 256 MiB of RGBA, encoded output at most 1 GiB, and an encoder without streaming support keeps the 1 GiB whole-clip cap. Ctrl-C now stops ffmpeg and removes its temp files; a hung ffmpeg is killed after the timeout, and a wedged `ffmpeg -version` probe no longer hangs the build.
  
  MP4 output changes: the CLI now uses core's ffmpeg encoder, so mp4 is encoded at x264 crf 18 with bit-exact flags (reproducible bytes for one ffmpeg build) instead of x264's default quality. The file grows accordingly (263 KB to 355 KB on the load-balancing example); odd-sized frames are still padded with white.
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
- Updated dependencies [f550a70]
- Updated dependencies [b6b1ec4]
- Updated dependencies [056a440]
- Updated dependencies [fb45bc3]
- Updated dependencies [66c8478]
- Updated dependencies [7ce841e]
- Updated dependencies [8562aa6]
- Updated dependencies [7538619]
- Updated dependencies [a2b4e49]
- Updated dependencies [aea4fea]
- Updated dependencies [54135e3]
- Updated dependencies [2d486b9]
- Updated dependencies [ad44f84]
- Updated dependencies [f75a9d9]
- Updated dependencies [7d9f846]
- Updated dependencies [c855036]
- Updated dependencies [4851912]
- Updated dependencies [9395785]
  - @platformcosmo/core@0.1.0
  - @platformcosmo/themes@0.1.0
  - @platformcosmo/dc-pack@0.1.0
  - @platformcosmo/parts-auto@0.1.0
  - @platformcosmo/parts-base@0.1.0
  - @platformcosmo/parts-brick@0.1.0
  - @platformcosmo/pdf@0.1.0
  - @platformcosmo/icons-base@0.0.1
  - @platformcosmo/icons-k8s@0.0.1
  - @platformcosmo/icons-lucide@0.0.1
  - @platformcosmo/icons-simple@0.0.1
