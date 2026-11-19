# Assemblies: implementation tracks

Implementation plan for [assemblies](./assemblies.md) and
[document ingestion](./document-ingestion.md). Same rules as PLAN §17 and §18: contracts
(`packages/core/src/contracts/`, `schema/v1.json`) change only through orchestrator PRs; each
track owns only its paths; every PR has green CI on Node 22 and 24 (clean install), an Opus
review `APPROVE`, Conventional Commits with DCO sign-off; a PR that changes core rebuilds the
plugin bundle and gallery (D19). Every agent brief repeats: install nothing on the host, never
touch other worktrees or the live app, at most one background waiter that also exits on failure.

Sizes are estimates: files touched or added, and lines of code including tests. S < 600,
M 600–1500, L 1500–3000 LOC.

## 0. Phases, guard and gates

The user's priority is their own figures first. Work ships in four phases; each phase ends with
a release-quality slice and lifts its part of the merge guard.

| Phase                          | Delivers                                                                                                                                                                                                                   | Guard group lifted                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **1a Figure mode**             | user figures (heat-sink installation, chassis fans) animated in their own plane: images, figures, explode/implode actions on figures, `pcosmo assets crop/cutout/locate/align/figure/check/doctor`, skill `from-figure.md` | `phase1a`: `images`, `figures`, step actions                                      |
| **1b Plans and basic explode** | board plan → isometric reconstruction, primitives, explode programs, depth epochs **without copies**, labels incl. `labels: "always"`                                                                                      | `phase1b`: `assemblies`                                                           |
| **2 Server → rack → hall**     | DC assembly mode, slot internals, `hw:` shapes, build programs (from above/outside), close-ups, quarter-turn views (user decision 7), the end-to-end story                                                                 | `phase2`: rack `programs`, slot `assembly`, `closeup`, build programs and actions |
| **3 Documents and booklets**   | depth copies, PDF parser (incl. empty-password decryption), storyboards, callout flights and sub-builds, bricks, `auto:` shapes                                                                                            | `phase3`: `storyboards`, `from: "callout"`, `subBuild`                            |

- **Guard (this PR).** `packages/core/src/schema/unsupported.ts` rejects every 1.2.0 field
  with `assembly/unsupported` ("validates but cannot render yet", suggestion: upgrade) at its
  outermost location, per group in `UNRENDERED`. The schema accepts the fields, so editors and
  `pcosmo validate` already see them; `main` never renders them silently as nothing, and a
  release cut in between stays honest (D17). The PR that finishes a phase sets its group to
  `false` and adds the end-to-end test that renders that phase's design examples. Test:
  `packages/core/test/assembly-guard.test.ts` (field paths per group, outermost reporting, 1.1
  specs untouched, every design example passes the schema and hits only the guard).
- **Byte identity gate** (every A, B, E PR): all gallery specs and all visual goldens unchanged
  (`check:gallery`, visual regression exact match).
- **Parallelism.** The figure chain (1a) does not depend on the assembly engine: it needs only
  C-1 (images), the flat-board render PR R-1 and the `assets` tools. Phase 1b runs in
  parallel with 1a.

```
O-1 (this PR: design, schema 1.2.0, contracts, guard)
Phase 1a  A2-F ─┐
          C-1 ──┼─ R-1 figure/storyboard render ─┐
          C-1 ── C-3 raster ops ── C-4 figure pipeline + gate ─┴─ D-2a assets CLI ─ D-3a from-figure
Phase 1b  A2-1 ─ A2-2 ─ A2-3 ─┬─ A2-4 builder
          A1-1 ─ A1-2a depth (no copies) ─ A1-3 render model ─ B-1 animator ─ B-2 export ─ D-1 ─ D-3b plans
Phase 2   E-1 DC mode ─ E-2a hw: shapes ─ A2-5 / A1-4 levels + views ─ A2-6 build programs ─ D-4a story
Phase 3   A1-2b copies ─ C-2 pdf ─ R-2 storyboards ─ A2-7 callouts/sub-builds ─ E-3 bricks ─ E-2b auto: ─ D-2b/D-3c
```

## 1. Orchestrator

| PR  | Scope                                                                                                                                                                                          | Files / LOC                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| O-1 | this design: `docs/design/*`, schema 1.2.0, `types.gen.ts`, `contracts/assembly.ts` + additive fields in scene/render/dc contracts, the merge guard and its test, VitePress excludes `design/` | 13 files, ~5.6k (docs ~2.9k, schema ~1.5k, contracts ~750, guard + test ~250) |
| O-2 | after review: PLAN §5/§6/§7/§9/§13 updates, DECISIONS D52+, PROGRESS                                                                                                                           | 3 files, ~150                                                                 |

## 2. Phase 1a: figure mode (~8.1k LOC)

### A2-F Figures in validate and scene (M, ~900 LOC, 4 files)

Owns `schema/assembly-semantic.ts` (figure part), `scene/boards.ts`. Image ids, figure parts,
stages (selectors over figure part ids), explode/implode actions on figures and close-up paths,
timing (stage times, implode as time reverse, windows and compression), `SceneFlatBoard`,
credits. **oneOf diagnostics** for actions, programs and part images pick the branch by
discriminator (the action key `explode`/`implode`/`build`/`unbuild`; `kind`; string vs
object) and report that branch's errors instead of "not a valid SpecAssemblyAction" (shared
helper in `schema/diagnose.ts`, also used by A2-1).
Tests: every figure diagnostic with path and did-you-mean; timing tables; discriminator
messages.

### C-1 Image assets (M, ~1300 LOC, 6 files)

Owns `packages/core/src/assets/{prepare,png,jpeg,svg}.ts`; reuses `icons/sanitize.ts`.
`PrepareImageFn`: magic bytes (PNG, JPEG, SVG; WebP and everything else rejected with the
PNG/JPEG hint), header dimensions, metadata stripping without re-encode, EXIF orientation read
before stripping (`ImageAsset.orientation`), APNG rejection, SVG at 256 KiB through the
sanitizer, data-URI decode, caps, hashing.
Tests: per format good/bad/truncated/oversized fixtures generated in the test; EXIF, XMP, ICC,
tEXt, COM removed (byte-level); orientation 1–8 read correctly, malformed EXIF ignored;
polyglots (PNG with trailing HTML, SVG with script, JPEG with a `.png` name) rejected; WebP
rejected with the hint; fuzz (never throws, bounded time).

### R-1 Figure and storyboard render (L, ~2000 LOC, 7 files)

Owner A1, with B's agreement for the new `anim/boards.ts` (B reviews). Owns
`render/boards/*.ts`, `anim/boards.ts`, the image parts of `emit/index.ts` and `emit/ids.ts`.
Figure panels (upright, one depth item), base and sprite placement (`<image>`/`<symbol>` in
`<defs>` once per hash, EXIF transform, data-URI emitter rule), draw order by seat bottom edge
and `z`, motion tracks between seat and exploded positions (2D translate, CSS in both motion
modes, attributes in frame mode), fading motion arrows, labels with leaders, credits line,
reduced motion (discrete per-step poses), interactive settled targets, frame mode for PNG/GIF/MP4.
Phase 3 adds storyboard frames to the same module (R-2). Lifts `phase1a`.
Tests: emitter rejects `data:` hrefs outside `<image>` in `<defs>`, spec-supplied strings and
non-base64; each asset once per hash; frame mode equals the CSS pose at sampled times; zero SMIL
in `css` mode; the design's figure example renders (static, steps, animated, GIF).

### C-3 Raster operations (M, ~1300 LOC, 6 files) — depends on C-1 only

New package `packages/assets` (`@platformcosmo/assets`, CLI-only, pure functions over RGBA;
Track C). resvg-based decode, crop, edge-connected background removal, shrink (PNG only; JPEG
passed through), locate (multi-scale NCC with mask), align.
Tests: enclosed whites stay opaque; locate finds known offsets incl. twin instances in a
deterministic order; align recovers a known shift; CPU cap diagnostic; determinism.

### C-4 Figure pipeline and quality gate (L, ~2600 LOC, 9 files)

Owns `packages/assets/src/figure/*`, `tests/fixtures/figures/gen.mjs`. Manifest (strict schema
committed with D-2a), silhouette segmentation, groups, instances and template sprites,
occlusion recovery, clean base with recovery, arrow removal, positions, spec fragment, the gate
of ingestion §6.5 and its report.

**Acceptance criteria (normative).** On every synthetic trap figure the correct pipeline passes
the gate. Each deliberately broken variant fails, with at least the listed codes (all at
error severity):

| Broken variant                            | Must fail with                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| rectangle mask                            | `asset/rect-mask`, `asset/foreign-pixels`, `asset/exploded-residual`         |
| base not erased (ghost fins)              | `asset/leftover-fragment`, `asset/exploded-residual`                         |
| enclosed interior left transparent        | `asset/mask-hole`, `asset/assembled-residual`                                |
| twin instances assigned crosswise         | `asset/instance-swap`                                                        |
| board under a moved part not recovered    | `asset/base-unrecovered`, `asset/exploded-residual`                          |
| arrows left in the base                   | `asset/arrow-residual`                                                       |
| clip lever not grouped with its heat sink | `asset/exploded-residual` (the lever stays seated in the exploded re-render) |
| sprite carrying a neighbour's sliver      | `asset/foreign-pixels`                                                       |

Sprites never contain pixels of another part (asserted pixel-wise against the generator's
ground-truth masks); all residual metrics are local (largest connected component), so the
traps fail on figures of any size.

### D-2a Assets CLI, figure subset (M, ~800 LOC, 4 files)

Owns `packages/cli/src/commands/assets.ts`, `packages/cli/schema/figure-manifest.v1.json`,
`packages/cli/src/images.ts`. `assets doctor`, `crop`, `cutout`, `locate`, `align`, `figure`,
`check`, `shrink`; image loading for `build`/`validate` (realpath directory, `lstat` per
component, a single `open(O_RDONLY | O_NOFOLLOW)` + `fstat` on that descriptor + bounded read,
assemblies §11.1); output names never derived from input content.
Tests: traversal attempts (`../`, absolute, symlink out, symlink component, FIFO, oversize,
file swapped for a symlink between checks) refused with `image/unsafe-path`; manifest schema
compiled with Ajv `strict: true`; JSON outputs deterministic.

### D-3a Skill: `from-figure.md` (S, ~400 lines, 2 files)

Manifest writing, gate loop, verification renders, injection rule (ingestion §10), provenance.
Acceptance: skill-driven E2E (Sonnet following the skill, bundled CLI in a container) passes the
gate on every synthetic trap figure and reports failures it cannot fix.

## 3. Phase 1b: plans and basic explode (~10.5k LOC)

### A2-1 Assembly validation (M, ~1300 LOC, 4 files)

Owns `schema/assembly-semantic.ts`, `schema/suggest.ts` (reuse). Namespace (assemblies join the
global id namespace; sibling uniqueness after `count`; reserved ids `frame` and `closeup`; path
depth ≤ 8; `assembly/edge-to-part`); references with did-you-mean (actions, focus and `set`
paths over the expanded tree, programs, selectors with deeper `**/…` suggestions, `overrides`
relative to the owner, `mates`, `inserts`, `use`, `closeup`, image ids, shape refs, template
cycles); program checks (`moved-twice`, `to` ranges incl. rack programs, `build-backwards`,
`no-op-action`, `view-needs-assembly-only`, `storyboard-no-explode`, shape `params`); leaf
budget; discriminator diagnostics (A2-F helper).
Tests: every design example as a fixture; one negative fixture per code; schema fuzz extended to
1.2.0 shapes.

### A2-2 Assembly tree and frames (M, ~1400 LOC, 5 files)

Owns `scene/assembly/{tree,frame,roles}.ts`. Expansion of `count`/`pitch`/`use`, quarter-turn
rotations, `AssemblyFrame` (units, `fit`, true scale in DC context), rest boxes, roles and
`mates` inference, `inserts` inference (one face plane of one solid block), the below-ground
lift (reach bounds start at `z = 0`), `SceneGraph.assemblies`, focus targets.
Tests: expansion ids, rotations, `fit`, stud anisotropy, true scale (2U = 88.9 mm, 19-inch
rack), mates/inserts inference (lid on tray, pan under block, valve through head), below-ground
lift of the engine example.

### A2-3 Explode programs and the step plan (L, ~1900 LOC, 6 files)

Owns `scene/assembly/{selectors,directions,distances,timing,plan}.ts`, the layout hook in
`layout/index.ts`. Selector grammar scoped to the owner's children (assemblies §6.1),
directions, program-level stacking, order/stagger/overrides, labels/fade flags, timing,
compression, loop closure, implicit access, `AssemblyStepPlan`, credits; layout with reach
bounds.
Tests: selector tables (scope, `**/`, kinds, `except`); direction math incl. ties; stacking
(engine order cover > cams > head > pistons); compression and its suggestion; implode = mirrored
explode (property test).

### A2-4 Builder (S, ~500 LOC, 3 files)

Owns `scene/assembly/builder.ts`, export in `index.ts`. `spec`, `assembly`, `explode`, `build`,
`figure`, plus racks and storyboards through `spec()`. Tests compare RFC 8785 (JCS) canonical
JSON of the builder output with the design examples (key order irrelevant); outputs validate
(schema; the guard is expected).

### A1-1 Part primitives (M, ~1200 LOC, 4 files)

Owns `geometry/parts.ts`, `geometry/decals.ts`. Cylinders, shafts and studs along x and y, ring
and tray splits, wedge, card and sprite silhouettes, decal matrices, billboard rects,
`partGeometry()`; `primitiveFaces` untouched.
Tests: faces and order per primitive and axis; stud non-overlap property; decal corners;
snapshots.

### A1-2a Depth epochs without copies (L, ~1900 LOC, 5 files)

Owns `depth/epochs.ts`, `depth/enclosure.ts`; `depth/index.ts` unchanged for the static path.
Phases, **swept boxes as rest box ⊕ the Minkowski sum of the active moves' offset intervals**,
certification, bisection, epochs; closed containment with ε, union of touching solids,
`inserts` with entry-face clips, face-exit clips; edge strengths and the deterministic cycle
rule (`assembly/depth-cycle`); `transit-collision` sampling. An epoch boundary that would need
a copy is merged and marked approximate (copies land in A1-2b).
Tests: the proofs of assemblies §9.7 as one-epoch tests (rack drawer, server internals on a
pulled drawer, engine lift, build drop); **concurrent composed moves**: a drawer sliding while
its lid lifts and a child lifts with `with: previous`, asserting the swept box contains every
sampled pose and that the endpoint hull would not (regression for the unsound bound); the
engine example as a regression fixture (valves inserted and enclosed by casting ∪ cover, flush
camshafts inside the cover, pistons crossing the deck); clip correctness against a per-pixel
z-buffer reference rendered with resvg; randomized property test (painter's order of sampled
frames matches a z-buffer within 0.5% of pixels except approximate epochs); determinism;
performance (300 leaves × 20 transitions < 2 s).

### A1-3 Assembly render model and emit (L, ~2200 LOC, 7 files)

Owns `render/assembly/*.ts`, `emit/ids.ts` (assembly ids, `__c<k>` suffix scheme ready for
copies), emit `attrs` overrides. `AssemblyRenderModel`, the wrapper chain (motion > visible >
fade > clip > part), label and leader placement, top-face labels, fade wrappers only when used,
reach-bounds viewBox, per-step focus rects.
Tests: viewBox covers every swept box; wrapper chain structure; label placement deterministic;
byte-identity gate; snapshots of the Phase 1b examples.

### B-1 Assembly animator (L, ~1600 LOC, 4 files)

Owns `anim/assembly.ts`, edits `anim/index.ts`, `anim/interactive.ts`. Keyframes per wrapper
property (shared for equal tracks), mirrored easings, both motion modes, reduced motion
(discrete per-step poses for specs with actions only), step/frame modes via `attrs`,
interactive settled targets, loop start fade and closure. Lifts `phase1b` together with B-2.
Tests: keyframe snapshots; zero SMIL in `css`; reduced motion with and without actions (the
latter byte-identical to 1.1); frame mode equals `frameAt`.

### B-2 Export and browsers (M, ~800 LOC, 5 files)

Owns `export/*`, `tests/browser/*`. PNG at `png.time`, GIF/MP4 frames (D33 streaming),
`--png-step`. Browser matrix for the engine and board examples.

### D-1 CLI wiring (S, ~500 LOC, 3 files)

`RenderOptions.parts` wiring, `--png-step N`, `validate --suggest` (assemblies §17).

### D-3b Skill: plans and reconstruction (S, ~400 lines, 2 files)

`references/assemblies.md` (spec reference, heuristics), plan-to-isometric (ingestion §9).
Acceptance: skill E2E builds the engine, GPU server (with a synthetic image) and a synthetic
board plan with no manual edits.

## 4. Phase 2: server → rack → hall (~8.5k LOC)

| PR                                              | Scope                                                                                                                                                                                                                                                                                                                                         | Size                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| E-1 DC assembly mode                            | `packages/dc-pack/src/{assembly,shapes}.ts`: `buildAssembly` (frame leaves, slot sub-assemblies, tray + lid with internals, `drawers`, mirrored fronts, below-floor error), `dc:` shapes. Tests: every existing DC spec and gallery render byte-identical; assembly mode only for targeted racks; reserved ids; drawer clears the front plane | M, ~1300 LOC, 4 files |
| E-2a `hw:` shapes                               | new `packages/parts-base` (`hw:` set of assemblies §5), defaults in mm, `readParams` with did-you-mean. Tests: bounds, `depthBox ⊆ bounds`, determinism, contact-sheet snapshot                                                                                                                                                               | M, ~1000 LOC, 5 files |
| A2-5 Levels and views (scene)                   | close-up instances and the reserved `closeup` segment, size reconciliation, quarter-turn view scenes                                                                                                                                                                                                                                          | M, ~900 LOC, 3 files  |
| A1-4 Levels and views (render)                  | level groups and cameras, cross-fade geometry, per-view projection and depth                                                                                                                                                                                                                                                                  | M, ~1000 LOC, 3 files |
| A2-6 Build programs                             | build steps from `above`/`outside`/axes, base, callout grouping (static callouts), `view`, build/unbuild actions, loop-start fade                                                                                                                                                                                                             | M, ~1200 LOC, 4 files |
| B-3 Levels, views and builds (anim)             | cross-fades, view swaps, build appearance tracks                                                                                                                                                                                                                                                                                              | M, ~800 LOC, 3 files  |
| D-4a Story and docs                             | the end-to-end story (ingestion §7.3) as a gallery example with synthetic images; `docs/guide/assemblies.md`; lifts `phase2` with an E2E test                                                                                                                                                                                                 | M, ~1000 LOC, 6 files |
| D-1b `slots[].assembly` and close-up CLI checks | size-mismatch reporting in `validate` output                                                                                                                                                                                                                                                                                                  | S, ~300 LOC           |

Acceptance for the phase: the hall → row → rack → server → board → heat-sink story renders in
every output, close-ups cross-fade without a jump, sizes reconcile (warnings only where the
template is off by more than 10%), and every 1.1 DC example is byte-identical.

## 5. Phase 3: documents and booklets (~13k LOC)

| PR                                  | Scope                                                                                                                                                                             | Size                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A1-2b Depth copies                  | LIS copy construction, `__c<k>` subtrees, `copyIds`, copy budget. Tests: a crafted case needing exactly one copy; no flicker at swaps (browser frame diffs)                       | M, ~1200 LOC           |
| C-2 `@platformcosmo/pdf`            | parser of ingestion §4 incl. empty-user-password RC4/AES via `node:crypto`, streaming inflate with output caps, 16 MP output cap, repair, fixtures 1–4 incl. encrypted ones; fuzz | L, ~3000 LOC, 10 files |
| D-2b `assets pdf …`                 | `info`, `list`, `extract` (`p<page>-i<index>` names), `compose`, `render` (pinned `pdftoppm`/`mutool` arguments, minimal environment, 16 MP cap), `text`                          | M, ~900 LOC            |
| R-2 Storyboards                     | storyboard frames, callouts, sub-build docking, transitions in `render/boards` and `anim/boards.ts`; lifts storyboards                                                            | M, ~1200 LOC           |
| A2-7 Callout flights and sub-builds | `from: "callout"` overlay flights, sub-build staging and docking; lifts `phase3`                                                                                                  | M, ~1000 LOC           |
| E-3 `@platformcosmo/parts-brick`    | `brick:` shapes, studs, palette, `brick/off-grid`; deny-list test (no brand names or marks)                                                                                       | M, ~1100 LOC           |
| E-2b `auto:` shapes                 | engine starter set                                                                                                                                                                | M, ~900 LOC            |
| D-3c Skill: documents and booklets  | `from-document.md`, `from-instructions.md`, tier choice, legal notes                                                                                                              | M, ~600 lines          |
| D-4b Gallery and synthetic booklet  | synthetic PDFs and the brick rover booklet fixture (5), gallery entries                                                                                                           | M, ~900 LOC            |

## 6. Visual review cases (Phase 2 style, every round all READY)

1. Figure mode on each synthetic trap figure: no ghost fragments, no slivers, no blanked areas
   (Phase 1a).
2. Board plan with top-face labels; GPU server explode with decal and billboard (Phase 1b).
3. Engine: pistons leaving the bores (clean clip edge at the deck), valves clipped at the head
   top, crankshaft dropping, layers with gaps, manifolds out (Phase 1b).
4. Rack drawer: no post drawn over the pulled device; server internals on a pulled drawer
   (Phase 2).
5. Close-up transitions hall → rack → server → board → figure and back; quarter-turn views
   (Phase 2).
6. Brick rover: studs, stacking, drops, cab sub-build docking (Phase 3).
7. Copies: no flicker at swaps in Chrome, Firefox, Safari (Phase 3).
8. Reduced motion (discrete poses), `css` motion mode, dark and mono themes for 2, 3, 4.

## 7. Totals

About 32 PRs and ~45k LOC including tests: O ~5.8k, Phase 1a ~8.1k, Phase 1b ~10.5k,
Phase 2 ~8.5k, Phase 3 ~13k. Critical path to the user's first result (Phase 1a): O-1 → C-1 →
C-3 → C-4 → D-2a → D-3a, with R-1 and A2-F in parallel. Phase 1b's critical path: A2-1 → A2-2 →
A2-3 → A1-2a → A1-3 → B-1.
