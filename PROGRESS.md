# Progress

Resume point for the autonomous run: read this file and `DECISIONS.md`, then continue from **Next**.

## Phase status

| Phase / track               | Status      | Branch / PR          | Notes                            |
| --------------------------- | ----------- | -------------------- | -------------------------------- |
| M0 setup                    | merged      | #1                   | Opus APPROVE, CI green           |
| M0 hardening (review P2/P3) | in progress | `chore/m0-hardening` | Sonnet                           |
| Phase 0 contracts           | in progress | `feat/contracts`     | orchestrator (Opus)              |
| A Engine                    | not started | `track/a-engine`     | starts after contracts merge     |
| B Animation + Export        | not started | `track/b-anim`       |                                  |
| C Icons                     | not started | `track/c-icons`      |                                  |
| D CLI + Skills + Docs       | not started | `track/d-cli`        |                                  |
| E DC pack + Themes          | not started | `track/e-dc`         | stubs geometry against contracts |
| Phase 2 integration         | not started |                      |                                  |
| Phase 3 install without npm | not started |                      |                                  |

## Open PRs / failing checks / blockers

- none yet

## Model per task

| Task                             | Model               |
| -------------------------------- | ------------------- |
| M0 implementation                | sonnet              |
| M0 reviews (×2)                  | opus                |
| Plugin syntax + runtime research | haiku               |
| Icon license research            | haiku               |
| M0 hardening                     | sonnet              |
| Contracts, PLAN §18, DECISIONS   | opus (orchestrator) |

## Next

1. Merge `feat/contracts` (green CI + Opus APPROVE).
2. Launch tracks A–E in worktrees.
