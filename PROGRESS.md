# Progress

Resume point for the autonomous run: read this file and `DECISIONS.md`, then continue from **Next**.

## Phase status

| Phase / track                                                  | Status      | Branch / PR              | Model                                 |
| -------------------------------------------------------------- | ----------- | ------------------------ | ------------------------------------- |
| M0 setup                                                       | merged      | #1                       | sonnet (impl), opus (review)          |
| M0 hardening                                                   | merged      | #7                       | sonnet (impl), opus (review ×2)       |
| Phase 0 contracts                                              | merged      | #6                       | opus (orchestrator), opus (review ×4) |
| Contracts doc follow-up                                        | open        | `chore/contracts-docs`   | opus                                  |
| A1 Engine core (geometry, depth, text, emit, optimize, render) | in progress | `track/a1-engine-core`   | sonnet                                |
| A2 Engine layout (parse, validate, scene, layout, routing)     | in progress | `track/a2-engine-layout` | sonnet                                |
| B Animation + Export                                           | in progress | `track/b-anim-export`    | sonnet                                |
| C Icons                                                        | in progress | `track/c-icons`          | sonnet                                |
| D CLI + Skills + Docs                                          | in progress | `track/d-cli`            | sonnet                                |
| E DC pack + Themes                                             | in progress | `track/e-dc-themes`      | sonnet                                |
| Phase 2 integration                                            | not started |                          |                                       |
| Phase 3 install without npm                                    | not started |                          |                                       |

## Open PRs / failing checks / blockers

- Dependabot PRs #2–#5 (action major bumps) are stale since actions are SHA-pinned; closing them was blocked by the permission classifier, so they stay open for a human to close.

## Model per task (done)

| Task                                         | Model               |
| -------------------------------------------- | ------------------- |
| M0 implementation, hardening                 | sonnet              |
| M0 / hardening / contracts reviews           | opus                |
| Plugin runtime + icon license research       | haiku               |
| Contracts, schema 1.1.0, PLAN §18, DECISIONS | opus (orchestrator) |

## Next

1. Merge `chore/contracts-docs` after CI + Opus review.
2. Review and merge track PRs as they open (Opus review per PR, in parallel).
3. Haiku: schema property descriptions/defaults (D16).
4. Phase 2 integration once A1/A2/B land; Phase 3 bundled plugin E2E.
