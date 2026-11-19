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
| Assemblies + programmable explode/implode (new scope)          | design in progress                                                                                                                                                | design PR pending                                                                                                                                                              | opus design                                           |

## Evidence

- main CI, Browser (Playwright + real Safari 27.2) and Visual regression green after each merge batch.
- Real Safari: motion and Reduce-Motion passes on fixtures and real CLI output (incl. CSS motion variants), with a negative fixture proving the content check (#42, #57).
- Playwright Chromium/Firefox/WebKit × img/inline/object on real output incl. CSS motion: 0 FAIL.
- Visual regression: 13 goldens, exact match, Node 22 + 24 (#46).
- macOS export job: default GIF + MP4 (336 frames) and PNG/static byte-identical to Linux (#54, #56).
- Fuzz: random JSON, example mutations, YAML; size budgets: launch examples 38.8–46.4 KB (< 150 KB), dc-hall 262 KB (< 300 KB accepted) (#55).
- Clean container: `claude plugin marketplace add mirastacklabs-ai/platformcosmo` + `install`; bundled `pcosmo` renders all examples; icons by URL (`feather`).

## Human-only items

- Repo settings: enable secret scanning, push protection, private vulnerability reporting (SECURITY.md points to it), Dependabot security updates; branch protection with required checks; DCO app.
- Docs site: enable GitHub Pages (source: GitHub Actions), restrict the `github-pages` environment to `main`, verify `platformcosmo.io`, DNS records, then set `PAGES_ENABLED=true` (CONTRIBUTING).
- npm: org and package names, `npm-publish` environment, `RELEASE_ENABLED`, trusted publishing (or `NPM_TOKEN`).
- Icon terms: accept Azure (D29) and confirm Google Cloud (D30) terms to render those examples.
- `CLAUDE_CODE_OAUTH_TOKEN` for a real Claude Code prompt → diagram run in a container.
- Renew the `platformbuilds.*` domains; add the redirect README in the `platformcosmo` GitHub org (PLAN §16).
- Trademark search, conduct contact, close stale Dependabot PRs #2–#5.

## Follow-ups (logged, not blocking)

- #56 R02: one Ctrl-C does not stop an in-process GIF when `--gif --mp4` (needs an abort signal in `exportOutputs`).
- #58 R01/R02: assert non-empty truth files; dedupe spec edges in precision.
- Review P3s across #54–#57 (comments, extra tests) as listed in each PR.

## Next

1. Merge the docs-polish PR (this file, PLAN/NOTICE/SECURITY wording).
2. Re-run the independent final verification on main.
3. Assemblies design PR → user review → implementation phases 1–3.
