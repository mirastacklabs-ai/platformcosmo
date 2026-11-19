# Assemblies: implementation tracks

Implementation plan for [assemblies](./assemblies.md) and
[document ingestion](./document-ingestion.md). Same rules as PLAN §17 and §18: contracts
(`packages/core/src/contracts/`, `schema/v1.json`) change only through orchestrator PRs; each
track owns only its paths; every PR has green CI on Node 22 and 24 (clean install), an Opus
review `APPROVE`, Conventional Commits with DCO sign-off; a PR that changes core rebuilds the
plugin bundle and gallery (D19). Every agent brief repeats: install nothing on the host, never
touch other worktrees or the live app, at most one background waiter that also exits on failure.

Sizes are estimates (files touched or added; lines of code including tests). S < 600, M
600–1500, L 1500–3000 LOC.

## 0. Merge order and gates

```
O-1 (this PR: design, schema 1.2.0, contracts)
 ├─ A2-1 validate + guard ─ A2-2 scene tree ─ A2-3 programs/plan ─┬─ A2-4 builder
 │                                                                ├─ A2-5 levels/views (scene)
 ├─ A1-1 primitives ───────────── A1-2 depth ── A1-3 render model ┴─ A1-4 levels/views (render)
 ├─ C-1 image assets ──────────────────────────────┘        │
 │                                                          B-1 animator ─ B-2 export/browser
 ├─ E-1 DC assembly mode (needs A2-2 types, A1-1)  E-2 hw/auto shapes  E-3 bricks
 ├─ C-2 pdf parser ─ C-3 raster ops ─ C-4 figure pipeline
 └─ D-1 CLI wiring (after A2-1, C-1) ─ D-2 assets CLI (after C-2..C-4) ─ D-3 skill ─ D-4 docs/gallery
```

- **Guard**: A2-1 makes `validate` reject 1.2.0 content (`assemblies`, `storyboards`, `figures`,
  `images`, step `assembly`, slot `assembly`/`closeup`) with `assembly/unsupported` ("not
  implemented in this build") until A1-3 and B-1 have merged; the PR that completes B-1 removes
  the guard. So `main` never renders new fields silently as nothing, and a release cut in
  between stays honest (D17: release refuses while stage stubs remain).
- **Byte identity gate** (every A, B, E PR): all gallery specs and all visual goldens unchanged
  (`check:gallery`, visual regression exact match).

## 1. Orchestrator

| PR  | Scope                                                                                                                                                            | Files / LOC                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| O-1 | this design: `docs/design/*`, schema 1.2.0, `types.gen.ts`, `contracts/assembly.ts` + additive fields in scene/render/dc contracts, VitePress excludes `design/` | 9 files, ~4.5k (docs ~2.4k, schema ~1.4k, contracts ~700) |
| O-2 | after review: PLAN §5/§6/§7/§9/§13 updates, DECISIONS D34+, PROGRESS                                                                                             | 3 files, ~150                                             |

## 2. Track A2: schema, validate, scene (`packages/core/src/{schema,scene,layout}`)

### A2-1 Semantic validation and guard (M)

Owns `schema/semantic.ts`, new `schema/assembly-semantic.ts`, `schema/suggest.ts` (reuse).
~4 files, ~1300 LOC.

- Id namespace: assemblies, storyboards, figures and images join the global namespace;
  sibling uniqueness after `count` expansion; reserved `frame` slot id in assembly mode;
  path depth ≤ 8; `assembly/edge-to-part`.
- References with did-you-mean: actions, focus and `set` paths (expanded tree), programs,
  selectors (`selector-empty` warning), `overrides` keys, `mates`, `use`, `closeup`,
  `subBuild`, image ids, shape refs (with `parts` registry), template cycles (`use` chains).
- Program checks: `moved-twice`, `to` ranges, `build-backwards`, `view-needs-assembly-only`,
  `storyboard-no-explode`, unknown `params` (via `PartShapeDef.readParams`).
- Budgets: leaf count after expansion (`budget/assembly-parts`), images count.
- The guard (§0).

Tests: one valid spec per design example (all 10 JSON examples in the design docs become
fixtures); one negative fixture per diagnostic code with the expected path and suggestion;
fuzz: extend the schema fuzz test with 1.2.0 shapes (no throw, bounded time).

### A2-2 Assembly tree and frames (M)

Owns new `scene/assembly/{tree,frame,roles}.ts`. ~5 files, ~1400 LOC.

- `SceneAssemblyNode` tree: `count`/`pitch` expansion, `use` instancing, rotations (quarter
  turns), `AssemblyFrame` (units, `fit`, true scale in DC context and close-ups), rest boxes
  local and world, roles and `mates` inference (contact faces, largest area), enclosure facts.
- Leaf geometry via A1-1's `partGeometry()` and the `parts` registry.
- `SceneGraph.assemblies` populated; `focusTargets` include parts (rest) and assemblies.

Tests: unit tests for expansion ids, rotation of boxes, `fit`, stud anisotropy, true scale
(2U = 88.9 mm, 19-inch rack), mates inference cases (lid on tray, pan under block, enclosed
piston), deterministic ordering.

### A2-3 Programs, timing and the step plan (L)

Owns `scene/assembly/{selectors,directions,distances,timing,plan}.ts`, layout hook in
`layout/index.ts` (reach-bounds footprint). ~7 files, ~2200 LOC.

- Selector grammar and matcher (§6.1), direction presets (§6.2), program-level auto stacking
  (§6.3), order/stagger/overrides (§6.4), build programs incl. origins, callouts, sub-build
  staging, `view` (§6.5), labels/fade flags (§6.6).
- Timing (§7): stage times, actions, implode as exact time reverse with mirrored easings,
  windows and compression with the duration suggestion, timeline start level, loop closure plan,
  implicit access moves, `AssemblyStepPlan`, credits list.
- Layout of assemblies, storyboards and figures as blocks with reach bounds; DC placement rule.

Tests: selector table tests (globs, `**`, kinds, `except`); direction math per preset incl.
ties; stacking proofs as tests (engine: sorted by `max_z` gives cover above cams above head
above pistons; drawer clears the rack front plane); compression factor and suggestion;
implode = reversed explode (property test: for random programs, every move of the implode is
the mirrored move); build level bookkeeping (`advance`, `to`, base, fade-out at loop start).

### A2-4 Builder API (S)

Owns `scene/assembly/builder.ts`, export in `index.ts`. ~3 files, ~450 LOC.
Tests: builders reproduce the engine example JSON byte for byte (`JSON.stringify`); key order
follows the schema; no defaults injected; output validates.

### A2-5 Levels and views in the scene (M)

Owns `scene/assembly/levels.ts`. ~3 files, ~800 LOC. Close-up level tree (§8.4), path
resolution into close-ups, size reconciliation diagnostics, per-view rotated scenes (§7.7).
Tests: path resolution through two levels; `size-mismatch` thresholds; view rotation of boxes
about the rest centre.

## 3. Track A1: geometry, depth, render model, emit (`packages/core/src/{geometry,depth,render,emit}`)

### A1-1 Part primitives (M)

Owns new `geometry/parts.ts`, `geometry/decals.ts`. ~4 files, ~1200 LOC.
Cylinders/shafts/studs along x and y (ellipse caps, side faces), ring and tray splits, wedge
faces, card and sprite silhouettes, decal affine matrices and billboard rects; `partGeometry()`
for primitives; existing `primitiveFaces` untouched.
Tests: face polygons and drawing order per primitive and axis; stud non-overlap property (§5.1)
as a test; decal matrix maps crop corners onto face corners; snapshot SVG per primitive.

### A1-2 Depth epochs and copies (L)

Owns new `depth/epochs.ts`, `depth/copies.ts`, `depth/enclosure.ts`; `depth/index.ts`
unchanged for the static path. ~5 files, ~2000 LOC.
Phases, swept-box certification, bisection, epochs (§9.3); LIS copy construction (§9.4);
enclosure hiding and face-exit clips (§9.5); split items (§9.6); budgets (`depth-copies`,
`depth-approx`, time).
Tests: the four proofs of §9.7 as tests asserting one epoch and zero copies (rack drawer with
split shell, server internals on a pulled drawer, engine lift, build drop); a crafted case that
needs copies (a part passing behind then in front of another) asserting exactly one copy and
correct visibility per epoch; the 1.1 `_front` union reproduced to show the wrong order it
would give (regression guard for §8.1); clip correctness by rasterizing (resvg) a piston leaving
a block at several times and comparing with a brute-force per-pixel z-buffer reference;
randomized property test: for random small scenes and moves, the painter's order of every
sampled frame matches a z-buffer rendering within 0.5% pixels, except epochs marked
approximate; determinism (two runs byte-equal); performance (300 leaves × 20 transitions < 2 s).

### A1-3 Assembly render model and emit (L)

Owns `render/assembly/*.ts`, `emit/ids.ts`, `emit/index.ts` (image defs, data-URI rule,
`attrs` overrides). ~8 files, ~2400 LOC.
`AssemblyRenderModel` (items, epochs, tracks, `frameAt`, `stepEnd`, `focusRect`, `settled`),
label and leader placement (§6.6), callouts, credits line, reach-bounds viewBox (§10), top-face
labels (`labels: always`), fade wrappers only when used, `AssemblyIdScheme`.
Tests: emitter rejects `data:` hrefs anywhere except `<image>` in `<defs>`, non-base64,
spec-supplied strings; each asset embedded once per hash; viewBox covers every step-end pose
and the hull of moves; label placement deterministic and non-overlapping on the examples;
byte-identity gate; SVG snapshot of each design example (static and step outputs).

### A1-4 Levels and views (M)

Owns `render/assembly/levels.ts`. ~3 files, ~900 LOC. Level groups with their own camera,
cross-fade geometry (rest bounds mapped to the zoomed rect), per-view projections and depth.
Tests: level transition rects; view groups' depth orders; element budget accounting.

## 4. Track B: animation and export (`packages/core/src/{anim,export}`, `tests/browser/`)

### B-1 Assembly animator (L)

Owns new `anim/assembly.ts`, edits `anim/index.ts`, `anim/interactive.ts`. ~5 files, ~1800 LOC.
CSS keyframes for motion and opacity tracks (shared keyframes for identical tracks), mirrored
easings, both motion modes (zero SMIL in `css`), reduced-motion discrete variant (§12, only for
specs with actions), step and frame modes through `AnimationLayer.attrs`, interactive Step at
`settled` times, loop-start fade and loop closure, close-up and view cross-fades, step focus
via `focusRect`. Removes the A2-1 guard.
Tests: keyframe text snapshots; `css` mode output has no SMIL element; reduced-motion CSS for a
spec with actions vs one without (the latter byte-identical to 1.1); frame mode at sampled
times equals `frameAt` (attributes, no CSS animation); interactive targets; speed scaling.

### B-2 Export and browsers (M)

Owns `export/*`, `tests/browser/*`. ~6 files, ~900 LOC.
PNG at `png.time`, GIF/MP4 frames of assembly motion (streaming, D33), WebP-in-raster check and
fallback (§11.5), `--png-step` support in `exportOutputs`.
Tests: GIF of the engine example decodes, frame count, frame k equals `frameAt`; browser matrix
(Chrome, Firefox, Safari × `img`, inline, `object`) for the engine and rack examples: parts move,
copies swap without flicker (pixel diff between consecutive frames bounded), reduced motion
discrete, `css` mode.

## 5. Track C: images, PDF, raster ops, figures

### C-1 Image assets (M)

Owns new `packages/core/src/assets/{prepare,png,jpeg,webp,svg}.ts`; reuses
`icons/sanitize.ts`. ~6 files, ~1300 LOC.
`PrepareImageFn`: magic bytes, header dimensions, chunk/segment metadata stripping without
re-encode, APNG/animated WebP rejection, SVG through the sanitizer at 256 KiB, data-URI decode,
caps (§11.4), hashing.
Tests: per format good/bad/truncated/oversized fixtures (generated in the test); EXIF, XMP,
ICC, tEXt, COM removed (byte-level assertions); polyglot files (PNG with trailing HTML, SVG with
script, JPEG with extension mismatch) rejected; fuzz (random mutations never throw, bounded
time).

### C-2 `@platformcosmo/pdf` (L)

New package `packages/pdf/` (track C owns it). ~10 files, ~2800 LOC.
§4 of the ingestion design: lexer, objects, xref/streams/`Prev`, repair, object streams,
filters, colour spaces, SMask/Mask/ImageMask, content-stream CTM, forms, inline images, text
runs, limits, allowlisted traversal; `tests/fixtures/pdf/gen.mjs` (fixtures 1–4 of §12).
Tests: list/extract on fixtures (bboxes exact, decoded pixels exact), repair path, every
hostile fixture produces its diagnostic within time and memory caps, ignored keys never
resolved (spy), fuzz.

### C-3 Raster operations (M)

Owns `packages/pdf/src/raster/` or `packages/core/src/assets/raster/` (decided in the PR; pure
functions over RGBA). ~6 files, ~1300 LOC.
resvg-based decode, compose (CTM placement), crop, edge-connected background removal, shrink,
locate (multi-scale NCC with mask), align.
Tests: compose of fixture 1 equals a reference PNG; enclosed whites stay opaque; locate finds
known offsets (incl. twin instances, ordered deterministically); align recovers a known shift;
CPU cap diagnostic.

### C-4 Figure pipeline and quality gate (L)

Owns `.../raster/figure/*`, `tests/fixtures/figures/gen.mjs`. ~8 files, ~2400 LOC.
Manifest, silhouette segmentation, groups, instances and template sprites, occlusion recovery,
clean base with recovery, arrow removal, positions, spec fragment, the gate (§6.5) and its
report.
**Acceptance criteria (normative):** on every synthetic trap figure the correct pipeline passes
the gate, and each deliberately broken variant fails with the matching code:
rectangle mask → `asset/foreign-pixels` / `asset/rect-mask`; base not erased →
`asset/leftover-fragment`; enclosed interior left transparent → `asset/mask-hole`; overlapping
twin instances assigned crosswise → `asset/instance-swap`; board under a moved part not
recovered → `asset/base-unrecovered` and visible in the residual check; arrows left →
`asset/arrow-residual`; clip lever not grouped → `asset/group-disconnected` or a gate failure
on the assembled re-render (`asset/seat-misaligned`). Sprites never contain pixels of another
part (asserted pixel-wise against the generator's ground-truth masks).

## 6. Track E: packs (`packages/dc-pack`, new `packages/parts-base`, `packages/parts-brick`)

### E-1 DC assembly mode (M)

Owns `packages/dc-pack/src/{assembly,shapes}.ts`. ~4 files, ~1200 LOC.
`DcPack.buildAssembly` (rack leaves under `frame/`, slot sub-assemblies, tray + lid when
`slots[].assembly`, built-in `drawers`, front per mirrored row), `DcPack.shapes` (`dc:`).
Tests: **every existing DC spec and gallery render byte-identical**; assembly mode only for
targeted racks; reserved id; drawer distance clears the rack front plane; mirrored rows slide
toward their own front.

### E-2 `@platformcosmo/parts-base`: `hw:` and `auto:` (M)

New package. ~6 files, ~1400 LOC. Vendor-neutral shapes listed in assemblies §5 with sensible
default sizes (mm) and roles; `readParams` with did-you-mean.
Tests: every shape builds within its bounds, `depthBox` ⊆ `bounds`, deterministic; snapshot
contact sheet SVG (visual review case).

### E-3 `@platformcosmo/parts-brick` (M)

New package. ~5 files, ~1100 LOC. `brick:brick|plate|tile|round|slope`, stud geometry, palette,
`brick/off-grid`. No brand names or marks anywhere (package text checked by a test against a
deny list).
Tests: stud non-overlap; stacked bricks sort correctly (upper covers lower studs); slope faces;
rover example renders.

Themes: no new tokens; callouts reuse metric tokens, leaders the edge stroke, credits the legend
text (so `ThemeTokens` stays unchanged).

## 7. Track D: CLI, assets CLI, skill, docs (`packages/cli`, `plugin/`, `docs/`, `examples/`)

### D-1 CLI wiring (M)

Owns `packages/cli/src/{commands/build.ts,commands/validate.ts,wire.ts,images.ts}`. ~5 files,
~900 LOC. Image loading with the path guard (§11.1: realpath inside the spec directory, no
symlink components, regular files, size before read), `RenderOptions.images` and `parts`
(parts-base, parts-brick, dc shapes), `--png-step N`, `validate --suggest` (prints the §17
program), watch re-reads images.
Tests: traversal attempts (`../`, absolute, symlink out, symlink component, FIFO, oversize)
refused with `image/unsafe-path`; did-you-mean over directory files; end-to-end build of each
example.

### D-2 `pcosmo assets` (M)

Owns `packages/cli/src/commands/assets.ts`, `packages/cli/src/renderer.ts`. ~4 files, ~1000 LOC.
Every command of ingestion §3, JSON output, exit codes, optional `pdftoppm`/`mutool` runner
(argument arrays, timeout, temp dir), `doctor`.
Tests: each command on fixtures; renderer absent → `pdf/renderer-missing`; renderer present is
tested in the macOS export workflow only (optional tool).

### D-3 Skill (M)

Owns `plugin/skills/diagram/SKILL.md`, `references/{assemblies,from-document,from-instructions,from-figure}.md`.
~5 files, ~900 lines of text. Tier choice and explanation, suggestion heuristics (§17),
prompt-injection rule, provenance and legal notes, budgets and summarization, verification
loops, out-of-scope approximations.
Acceptance: skill-driven E2E (as in PROGRESS: Sonnet following SKILL.md, bundled CLI in a
container) builds the engine, rack, GPU server and rover from prompts with no manual edits, and
the figure flow passes the gate on the synthetic trap figures.

### D-4 Docs and gallery (M)

Owns `docs/guide/assemblies.md`, `docs/guide/documents.md`, `examples/*.cosmo.json`,
gallery entries. ~10 files, ~900 LOC. Gallery: engine teardown, loaded rack, GPU server (with a
generated synthetic GPU card image), brick rover, synthetic heat-sink figure; trademark note.

## 8. Visual review cases (Phase 2 style, every round all READY)

1. Rack drawer: every frame of the drawer slide (no post drawn over the pulled device).
2. Server internals on a pulled drawer, lid lifting, memory lifting.
3. Engine: pistons leaving the bores (clip edge clean at the deck), crankshaft dropping, head and
   cams layered with gaps, manifolds out.
4. Brick rover: studs, stacking, build drops, cab sub-build docking, quarter-turn view.
5. Image-fed GPU decal and billboard sprite at several zooms; credits line.
6. Copies case: no flicker at swaps in Chrome, Firefox, Safari.
7. Reduced motion: discrete step poses; `css` motion mode.
8. Close-up transitions hall → rack → server → board → figure and back.
9. Figure mode on each synthetic trap figure (no ghost fragments, no slivers, no blanked areas).
10. Dark theme and mono theme for 1, 3, 4.

## 9. Totals

About 25 PRs, ~33k LOC including tests (A2 ~6.1k, A1 ~6.5k, B ~2.7k, C ~7.8k, E ~3.7k, D ~3.6k,
O ~4.6k). Critical path: O-1 → A2-1 → A2-2 → A2-3 → A1-2 → A1-3 → B-1 (guard removed) → D-3.
Document ingestion (C-2..C-4, D-2) runs in parallel and is not on the engine's critical path.
