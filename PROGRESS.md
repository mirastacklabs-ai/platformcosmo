# Progress

Resume point for the autonomous run: read this file and `DECISIONS.md`, then continue from **Next**.

## Phase status

| Phase / track                                                  | Status                                                                                                                                                            | PRs                                                                                                                                                                            | Models                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| M0 setup + hardening                                           | merged                                                                                                                                                            | #1, #7                                                                                                                                                                         | sonnet impl, opus review                              |
| Phase 0 contracts, decisions, schema                           | merged                                                                                                                                                            | #6, #8, #12, #28, #30, #31                                                                                                                                                     | opus (orchestrator), haiku (schema docs), opus review |
| A1 engine core (geometry, depth, text, emit, optimize, render) | merged                                                                                                                                                            | #10, #17, #22, #27, #35, #40, #49                                                                                                                                              | sonnet, opus                                          |
| A2 parse/validate/scene/layout/routing                         | merged                                                                                                                                                            | #14, #15, #19, #36, #43, #47, #50                                                                                                                                              | sonnet, opus                                          |
| B animation + export + browser matrix + visual regression      | merged                                                                                                                                                            | #11, #21, #26, #32, #37, #42, #46                                                                                                                                              | sonnet, opus                                          |
| C icons (276 bundled; remote fetch + provider packs)           | merged                                                                                                                                                            | #20, #24, #29, #52                                                                                                                                                             | sonnet, opus (security)                               |
| D CLI, plugin, skills, docs, gallery                           | merged                                                                                                                                                            | #16, #18, #25, #38, #39, #44, #51                                                                                                                                              | sonnet, opus (security)                               |
| E DC pack + themes                                             | merged                                                                                                                                                            | #9, #13, #23, #34, #41, #45, #48                                                                                                                                               | sonnet, opus                                          |
| Orchestrator CI/infra, final integration                       | merged                                                                                                                                                            | #30, #33, #53                                                                                                                                                                  | opus                                                  |
| Verification gaps (Opus final check)                           | merged                                                                                                                                                            | #54 macOS GIF/MP4 + docs schema check + gated Pages, #55 fuzz + budgets (+ bounded did-you-mean bug fix), #56 streaming video export (D33), #57 CSS `offset-path` motion (D32) | sonnet impl, opus review + contracts                  |
| Diagram from an attached image                                 | merged                                                                                                                                                            | #58                                                                                                                                                                            | sonnet, opus review                                   |
| Phase 2 visual review                                          | done: 4 rounds, final round all 6 READY                                                                                                                           | —                                                                                                                                                                              | opus                                                  |
| Phase 3 install without npm                                    | install from GitHub + bundled CLI verified in a clean container; skill-driven E2E simulated (Sonnet, 6/6 prompts; 3/3 images); real Claude Code run needs a token | —                                                                                                                                                                              | —                                                     |
| Brand look (D51), docs site on Cloudflare, legal entity        | merged                                                                                                                                                            | #61, #64, #65                                                                                                                                                                  | sonnet impl, opus review                              |
| Assemblies + programmable explode/implode (new scope)          | design merged; Phase 1a next                                                                                                                                      | #60                                                                                                                                                                            | opus design                                           |

## Evidence

- main CI, Browser (Playwright + real Safari 27.2) and Visual regression green after each merge batch.
- Real Safari: motion and Reduce-Motion passes on fixtures and real CLI output (incl. CSS motion variants), with a negative fixture proving the content check (#42, #57).
- Playwright Chromium/Firefox/WebKit × img/inline/object on real output incl. CSS motion: 0 FAIL.
- Visual regression: 13 goldens, exact match, Node 22 + 24 (#46).
- macOS export job: default GIF + MP4 (336 frames) and PNG/static byte-identical to Linux (#54, #56).
- Fuzz: random JSON, example mutations, YAML; size budgets: launch examples 38.8–46.4 KB (< 150 KB), dc-hall 262 KB (< 300 KB accepted) (#55).
- Clean container: `claude plugin marketplace add mirastacklabs-ai/platformcosmo` + `install`; bundled `pcosmo` renders all examples; icons by URL (`feather`).

## Human-only items

See HANDOFF.md ("Human-only items"). Repo security and branch protection are done; the docs site is
live on Cloudflare (no GitHub Pages deploy).

## Follow-ups (logged, not blocking)

- #56 R02: one Ctrl-C does not stop an in-process GIF when `--gif --mp4` (needs an abort signal in `exportOutputs`).
- #58 R01/R02: assert non-empty truth files; dedupe spec edges in precision.
- Review P3s across #54–#57 (comments, extra tests) as listed in each PR.

## Next

See HANDOFF.md ("Next work"): merge #66, handle #63, confirm analytics, then assemblies Phase 1a
(figure mode) per docs/design/assemblies-tracks.md.
