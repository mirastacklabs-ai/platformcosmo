# Progress

Resume point for the autonomous run: read this file and `DECISIONS.md`, then continue from **Next**.

## Phase status

| Phase / track                                                  | Status                                                                                        | PRs                                              | Models                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| M0 setup + hardening                                           | merged                                                                                        | #1, #7                                           | sonnet impl, opus review                              |
| Phase 0 contracts, decisions, schema                           | merged                                                                                        | #6, #8, #12, #28, #30, #31                       | opus (orchestrator), haiku (schema docs), opus review |
| A1 engine core (geometry, depth, text, emit, optimize, render) | merged                                                                                        | #10, #17, #22, #27, #35, #40, #49                | sonnet, opus                                          |
| A2 parse/validate/scene/layout/routing                         | merged                                                                                        | #14, #15, #19, #36, #43, #47, #50                | sonnet, opus                                          |
| B animation + export + browser matrix                          | merged; real-output + VR in flight                                                            | #11, #21, #26, #32, #37 (+ #42, #46)             | sonnet, opus                                          |
| C icons (276 bundled; remote fetch + provider packs)           | merged                                                                                        | #20, #24, #29                                    | sonnet, opus (security)                               |
| D CLI, plugin, skills, docs, gallery                           | merged; full gallery in flight                                                                | #16, #18, #25, #38, #39, #44                     | sonnet, opus (security)                               |
| E DC pack + themes                                             | merged                                                                                        | #9, #13, #23, #34, #41, #45, #48                 | sonnet, opus                                          |
| Orchestrator CI/infra                                          | merged                                                                                        | #30 (CI on all PR bases), #33 (browser + Safari) | opus                                                  |
| Phase 2 visual review                                          | done: 4 rounds, final round all 6 READY                                                       | —                                                | opus                                                  |
| Phase 3 install without npm                                    | install-from-GitHub + bundled CLI verified in a clean container; LLM prompt E2E needs a token | —                                                | —                                                     |

## Evidence

- Real Safari 27.2: 12/12 pass (animates in `<img>`, inline, `<object>`), Browser run 44392489732.
- Playwright Chromium/Firefox/WebKit harness: 66 pass, 1 allowlisted, 3 limited, 0 FAIL (fixtures).
- Clean container: `claude plugin marketplace add mirastacklabs-ai/platformcosmo` + `install`, bundled `pcosmo` renders the 5 launch examples incl. PNG; `icons add` of a 287-icon GitHub folder and a single SVG URL work.

## Human-only items

- Accept Azure icon terms (D29) and confirm Google Cloud icon terms (D30) to render those examples.
- `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) for the headless prompt → diagram E2E in a container.
- npm: `npm-publish` environment, `RELEASE_ENABLED`, trusted publishing (or `NPM_TOKEN`), `RELEASE_BOT_TOKEN`.
- Branch protection, DCO app, trademark search, conduct contact, close stale Dependabot PRs #2–#5.

## Next

1. Merge the full gallery (D) and VR goldens + real-output browser run (B).
2. Final orchestrator PR: rebuild plugin bundle, make plugin-bundle + gallery checks strict, README Quick start, this file.
3. Final report.
