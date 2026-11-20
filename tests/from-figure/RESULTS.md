# From-figure E2E results

Manual run (no LLM in CI). Fresh Sonnet subagents, one per batch of figures, followed only
`plugin/skills/diagram/SKILL.md` and `references/from-figure.md`, with the bundled CLI
(`plugin/bin/pcosmo.mjs`) run through `scripts/pc exec node ...` in `node:24.21-bookworm-slim`. They were told not
to read `tests/`, `docs/`, `packages/` or the generator. Inputs: the PNGs of every preset in
`tests/fixtures/figures/gen.mjs`, written to a temp folder (not committed), **no manifests given**: each agent read
coordinates from the images, wrote the manifest, ran `assets figure`, fixed by error code, wrote a spec, built both
poses to PNG and reviewed them. Generated images, manifests and specs are not committed.

Two rounds. Round 1 found gaps in the skill (listed below, fixed). Round 2 used fresh agents and folders on the
revised skill; the table is round 2. A "run" is a gate run (an input error before the gate does not count).

| Figure            | Final gate    | Runs | Codes seen (round 2)                                                               | Unfixable reported honestly | Defect found by render review, missed by the gate                                           |
| ----------------- | ------------- | ---- | ---------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `main`            | pass, full    | 2    | `asset/not-found` (input), `asset/annotation-invalid`                              | n.a.                        | none                                                                                        |
| `arrows`          | pass, full    | 1    | none                                                                               | n.a.                        | none                                                                                        |
| `leaders`         | pass, full    | 1    | none                                                                               | n.a.                        | none                                                                                        |
| `callout-text`    | pass, full    | 1    | none                                                                               | n.a.                        | none                                                                                        |
| `busy-callout`    | pass, full    | 1    | none                                                                               | n.a.                        | none                                                                                        |
| `exploded-only`   | pass, reduced | 3    | info `base-unrecovered`                                                            | yes (inferred seats)        | opaque sprites hide board sockets when seated; a 1 px stray tick (reported)                 |
| `assembled-only`  | pass, reduced | 2    | `hull-uncertain` (warning), info `base-unrecovered`                                | yes (inferred lift)         | top-face stripes left in the base (fixed with more seeds); a few tiny remnants (reported)   |
| `twins`           | pass, reduced | 1    | `hull-uncertain` (warning)                                                         | yes (instance mapping)      | none                                                                                        |
| `occluded`        | pass, reduced | 2    | `assembled-residual`, `exploded-residual`, `foreign-pixels`, then `hull-uncertain` | yes (part identity guessed) | none                                                                                        |
| `cage`            | pass, full    | 1    | none                                                                               | n.a.                        | none                                                                                        |
| `screw`           | pass, full    | 1    | none                                                                               | n.a.                        | none                                                                                        |
| `dense`           | pass, full    | 1    | `ambiguous` (warning)                                                              | yes (limit)                 | none                                                                                        |
| `dense-exploded`  | pass, reduced | 1    | `seat-unverified` (warning), info `base-unrecovered`                               | yes                         | inferred seat floats above the board (reported as wrong; not fixable from one state)        |
| `dense-assembled` | pass, reduced | 1    | `hull-uncertain` (warning), info `base-unrecovered`                                | yes                         | a board line behind the part is missing from the base; the inferred lift overlaps the frame |

All 14 reached a passing gate with no failing figure to hand back. The two single-state `dense-*` figures pass
only at `confidence: reduced`, and the agents reported the implausible inferred poses and the missing line instead
of calling them done. Round 1 (older skill text) had one real failure: `assembled-only` stayed red after 6 runs
(an arrow whose head touches the box failed either `no arrowhead` or the hull rule) and was reported as FAIL with
no spec. The skill now says to run the polyline through the head to the tip on the part's outline.

## Skill gaps found and fixed

`--src-dir` and `-d` need a trailing `/` and what `src` paths mean; the `polygon` JSON shape; a figure-only spec
(no `nodes`) with an example; the `explode`/`implode` no-op info; fine ribs (seed the bar, add a polygon);
single-state poses must be checked for plausibility; sub-parts make instances non-identical; fixed-versus-moving
parts in one-state figures; arrow tips touching parts; leader tracing to 1 px; mirrored annotations in the exclusion
overlay are expected; gate runs versus input errors; info codes; image size via `file`.

## Limits

- Same model family wrote the skill, the figures and ran the test, so results are likely optimistic. The figures are
  clean synthetic line art; real scans and screenshots are untested.
- Agents cannot zoom (`Read` shows small images at native size, `assets crop` does not upscale), so 1 px leaders
  were found partly by trial. An upscale option in `assets crop` would help.
- The run used the CLI bundle at commit `10a418b` (D-2a before its gate-failure change): a failed gate still wrote
  base, sprites and fragment there. The skill follows the revised rule (a failed run writes only `report.json` and
  the overlays; use nothing else), so the E2E did not exercise that behaviour.
