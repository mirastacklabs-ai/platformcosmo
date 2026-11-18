# Progress

Resume point for the autonomous run: read this file and `DECISIONS.md`, then continue from **Next**.

## Phase status

| Phase / track                                                  | Status                                               | PRs                                         | Models                                                |
| -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| M0 setup + hardening                                           | merged                                               | #1, #7                                      | sonnet impl, opus review                              |
| Phase 0 contracts + decisions                                  | merged                                               | #6, #8, #12, #28, #30                       | opus (orchestrator), haiku (schema docs), opus review |
| A1 engine core (geometry, depth, text, emit, optimize, render) | merged                                               | #10, #17, #22, #27                          | sonnet impl, opus review                              |
| A2 parse/validate/scene/layout/routing                         | merged                                               | #14, #15, #19                               | sonnet, opus                                          |
| B animation + export                                           | #11, #21 merged; #26 (browser harness) in CI         | #11, #21, #26                               | sonnet, opus                                          |
| C icons (276 bundled: cosmo 41, lucide 182, k8s 35, simple 18) | #20, #24 merged; #29 (fetch) in CI                   | #20, #24, #29                               | sonnet, opus (security)                               |
| D CLI + plugin + docs                                          | #16, #18 merged; #25 (docs) approved, pending rebase | #16, #18, #25                               | sonnet, opus (security)                               |
| E DC pack + themes                                             | merged                                               | #9, #13, #23                                | sonnet, opus                                          |
| Phase 2 integration                                            | in progress                                          | fix/a1-, fix/a2-, fix/b-, fix/e-integration | sonnet fixes, opus visual review                      |
| Phase 3 install without npm                                    | not started                                          |                                             |                                                       |

## Open items

- Visual review of first real renders: 17 P1 (A2 routing through objects/labels; A1 group labels, halos, viewBox/overlay, text spacing; E DC scale/placement; B camera rest state) — fixes in flight on the `fix/*-integration` branches.
- M2 evidence: real Safari (macos-latest job from `tests/browser/README.md`) + harness run on real `render()` output.
- CI to add: plugin bundle drift job (D19), browser + Safari jobs, visual-regression workflow, docs build.
- Dependabot PRs #2–#5 stale (closing was blocked by the permission classifier).

## Next

1. Merge #29, #26, #25; land the four integration fix PRs (Opus review each).
2. Re-render gallery, Opus visual review until clean; commit gallery; add visual-regression + browser/Safari CI.
3. Rebuild plugin bundle; Phase 3 end-to-end install test.
