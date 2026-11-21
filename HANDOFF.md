# Handoff

Start here in a new session. Read this file, then `PROGRESS.md`, `DECISIONS.md` (D1–D68),
`CLAUDE.md` (commands) and `docs/design/assemblies-tracks.md` (the track plan).
Last updated 2026-11-20 ~02:00 UTC.

## Where things stand

- **v1 is delivered** (PLAN M0–M5, v1.1, v1.2). The docs site is live at <https://platformcosmo.io>.
- **Owner's scope (2026-11-20):** finish **every** assemblies track (Phases 1a → 3) first. npm
  publishing comes after that, in a separate session the owner runs from the Claude Code app with a
  browser. Never publish from a coding session.
- **The owner OK'd merging PRs** ("go ahead, merge"). If the auto-mode classifier blocks
  `gh pr merge`, ask again.
- **Merged 2026-11-20:** #63, #64, #66, #68–#70, #72–#83, #85–#88.
  - Done: image assets (C-1), figure validation (C-2), raster tools (C-3), figure render (R-1, lifts
    `phase1a`), figure gate (C-4), assets CLI (D-2a), PDF parser (E-2a), the bricks/auto/hw shape
    packs (E-3/E-4/A2-F), the assembly tree (A2-2), explode programs (A2-3), depth epochs (A1-2a),
    the builder (A2-4), and the render model and emit (A1-3).
- **Speed-ups agreed with the owner:** at most 4 implementers in parallel, stacked PRs, a reviewer
  checklist in every brief, Opus for hard tracks, targeted local tests plus one full CI run.

## Open PRs (all stopped cleanly; state as of handoff)

Worktrees are under `.claude/worktrees/agent-<id>/`. Agents are gone, so new agents work in those
worktrees or in fresh ones.

| PR  | Track / branch                                                  | Worktree id       | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Merge after |
| --- | --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| #91 | D-3a from-figure skill `feat/skill-from-figure-d3a`             | a6a3428a004194350 | **APPROVED.** Merge next. Completes Phase 1a with #97.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —           |
| #90 | B-1 animator `feat/animator-b1`                                 | a428b214f5fd8dddb | **APPROVED.** Merge next.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —           |
| #84 | E-1 DC assembly mode `feat/dc-assembly-e1`                      | a95c062e819c3152f | **APPROVED** on re-review at 6cc0597. Follow-ups listed below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —           |
| #89 | A2-5 levels and views `feat/levels-views-a2-5`                  | ac440ef7b16c8f27c | **APPROVED**, but the **merge of origin/main was interrupted mid-way** (MERGE_HEAD set, about 99 paths, uncommitted). Real conflicts: `scene/boards.ts`, `scene/index.ts`, `assemblies.md` §18, and the bundle. Inspect the worktree and either finish the merge or `git merge --abort` and redo it. Keep A2-3's final behaviour (shared level machine, `opts.closeLoop` + R-1 `closesLoop`) and A2-5's gated levels/views wiring. Merge §18 row by row and regenerate the bundle.                                              | #87 ✓       |
| #95 | A2-6 build programs `feat/build-programs-a2-6`                  | aa6dde5dba7e34c93 | **APPROVED** at 15dcaa1 (CI 3060 passed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | #89         |
| #92 | A1-4 level groups and per-view render `feat/levels-render-a1-4` | a60c99891bf708110 | **APPROVED.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #89         |
| #97 | C-4 follow-up `fix/figure-gate-leftovers`                       | aa1451b4d83572876 | Just opened; local CI passed (3136). **Needs an Opus review.** It fixes the 1 px leftovers the gate missed: an arrow stub under a lifted sprite, and a board-line gap. The owner is strict about ghosts, so check the D-3a trap figures visually (resvg in a container).                                                                                                                                                                                                                                                        | —           |
| #93 | B-2 export, browser matrix, lift `phase1b` `feat/export-b2`     | a188d01bdbe873154 | **Fix round interrupted, about 9 files uncommitted.** Items: Q01 add assembly images to `imageUses` with real pointers; revert the tolerance to 0.1% and fix the decode wait; return early on model errors; make an unresolved pack ref an error; fix the rest-frame test; png.step at `ends[k]`; add the §18 `options/invalid-png-step` row. Check `git diff` and finish.                                                                                                                                                      | #90         |
| #94 | D-2b `assets pdf` CLI `feat/assets-pdf-d2b`                     | a9847107ae2348572 | **Security fix round interrupted, about 11 files uncommitted.** It was last updating a pinned test (page 2 is rotated 90°). Items: Q01 (P1) pixel bound in argv plus a `ulimit -f/-v` wrapper; drop the `PCOSMO_PDF_TOOLS_DIR` override; signal handlers; fd3 read-only; `unshare` on Linux; compose caching; Unicode `clean()`; manifest cap; the P3s. Re-review after.                                                                                                                                                        | —           |
| #96 | D-1 CLI wiring `feat/cli-wiring-d1`                             | aa28b80ef5a8bebe9 | **Fix round interrupted. The tree is clean but 19 local commits are unpushed**; check them before pushing. Items: Q01 (P1) `--suggest` loses parts whose pack default role is `body` (pick the body only from an explicit or single-largest part, classify the rest as `loose`); Q02 (P1) placement check for sub-assembly `at`/`pitch` in stud units (`PartPlacement.kind: "group"`); Q03 step duration from the real leaf count; Q04 paste-and-validate test; Q05/Q06 stronger tests; Q07–Q12 P3s (skip Q13). Stacked on #93. | #93         |

Merge order: #91, #90, #84, (#89 → #95, #92), #97, #93 → #96, #94.

## Next work (in order)

1. Land the PRs above.
2. **B-3** (anim for levels, views and builds). Needs #90, #92 and #95. #95 put `loopStart.fades` and
   `ResolvedAction.views` on the contract for it; consume them, don't recompute.
3. **D-3b** plans skill (needs #96 and #93). It must mirror `pcosmo validate --suggest` (§17).
   **Phase 1b is done** when D-3b lands.
4. **Phase 2:** D-4a (story and docs, lifts `phase2`), D-1b (`slots[].assembly`, close-up size-mismatch).
   Wiring PR from the #84 review:
   - R01: one planner per spec with a merged dc `synthetic` and a shared budget (today it's O(racks²));
   - R02: `assemblyPlanner` uses a WeakMap on the exact object, so key it by rack id instead;
   - R03: core's scene must build one planner over spec assemblies **and** racks.
5. **Phase 3:**
   - A1-2b copies; R-2 storyboards;
   - A2-7 callouts and sub-builds (sub-builds change step windows, so re-record the hashes);
   - D-3c documents skill; D-4b gallery and booklet.
6. Small PRs:
   - §8.1 targeted-only rack assembly mode in validation (#84 Q09) plus the cumulative close-up
     `too-deep` walk;
   - rack-program selectors are validated against `rackTree` but resolved over the scene tree (#84
     re-review);
   - extract the shared `define.ts` into a core `definePack`;
   - `assets crop --scale`;
   - add `check:plugin` to the `ci` script;
   - `@internal` core exports (`AssemblyPrograms`, `reassignSplit`) ship as public API: consider an
     `/internal` subpath.
7. **At the end:**
   - update `PROGRESS.md` and add D69+ to `DECISIONS.md`. Rulings to record:
     - block-level clips (§9.5);
     - implicit access is its own move only (`only`/`accessLength`/`opened`);
     - rule 4 both placements; arrowheads at either end; shape prior;
     - hw: +y fronts, canonical orientation, core depthBox;
     - standards-name carve-out; door outward normals; template front alignment; 450 mm interior;
     - closing window when the last step ends away from base;
     - explode/implode forwards/backwards codes; part-not-staged info; use-ignored;
     - pdf package public;
     - ancestor/descendant overlap = add the remaining leaves plus `moved-twice`;
     - bottom-up order within a build step;
   - then the publishing checklist for the owner's npm session.
   - VitePress now runs on vite 6, so check the docs site visually before the next deploy.

## Orchestration tools (local, not committed)

`.worktrees/orchestrator/` holds:

- `merge-queue.sh pr:worktree:branch ...`: update each branch from main (it auto-resolves only bundle
  and lockfile conflicts), then merge when all 9 required checks are green.
- `merge-when-green.sh`, `update-branch.sh`, `wait-for-load.sh 8 40`, `required.txt`, `followups.md`.

Rules: run one `merge-queue.sh` at a time, never chain waiters with `pgrep -f` (it matches itself),
and never edit a script while it runs.

## Performance (why agents took 1h+)

The Mac's load average sat at 30–40: the Colima VM plus Spotlight (`mds_stores`) indexing about 36
worktrees, each with its own `node_modules`. Full CI went from about 10 to 30+ minutes, and the
timing tests (icons-sanitize, routing-keepouts, budgets, video-e2e, assets-fuzz, built-bin) flake;
re-run those alone. Fixes:

- **Owner:** exclude `.claude/worktrees` and `.worktrees` in Spotlight Privacy.
- **Orchestrator:** remove merged worktrees (`git worktree remove`), and run at most 3 agents with
  CI at once.

## Website (platformcosmo.io)

- **Hosting**: Cloudflare Worker `platformcosmo` on the MIRASTACK LABS Cloudflare account, static
  assets from the VitePress build plus `docs/worker/index.js` (cookie-less page-view analytics to the
  Workers Analytics Engine dataset `platformcosmo`). Config: `docs/wrangler.jsonc`. Custom domains
  `platformcosmo.io` and `www.platformcosmo.io`; SSL by Cloudflare; Always Use HTTPS on; TLS ≥ 1.2.
- **Deploy is manual, from the maintainer's Mac** (owner's decision; no CI deploy):
  ```sh
  git switch main && git pull
  WRANGLER=<path to a logged-in wrangler> CLOUDFLARE_ACCOUNT_ID=<MIRASTACK account id> scripts/deploy-docs.sh
  ```
  On the owner's Mac wrangler 4.165.0 is at `~/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler`
  (OAuth login, not on PATH). The account id is the repo variable `CLOUDFLARE_ACCOUNT_ID`. The script
  builds in containers, refuses a dirty tree and checks the served schema copy.
- **CI does not deploy.** The "Docs" workflow only builds. GitHub Pages stays enabled solely as a
  claim on the domain (`PAGES_ENABLED=false`).
- **DNS**: zone `platformcosmo.io` on Cloudflare (registrar Namecheap, nameservers
  `camilo/karsyn.ns.cloudflare.com`). Zoho Mail records (3 MX, SPF, DKIM `zmail._domainkey`,
  verification TXT) must be kept. Apex/`www` records are managed by the Worker custom domains.
- **To verify analytics** (not yet confirmed): query the Analytics Engine SQL API for dataset
  `platformcosmo` after visiting the site.
- **Unused**: an empty legacy Cloudflare Pages project `platformcosmo` (`platformcosmo.pages.dev`),
  created by mistake. Delete only with the owner's OK.

## Brand standard (owner is strict about this)

Copy mirastacklabs.ai / infinitetokens.ai exactly; never re-typeset the logo.

- Lockup: mark SVG 32×26 (polygons in `docs/.vitepress/theme/MiraLogo.vue`), gap 12 px, wordmark
  JetBrains Mono 16 px, **MIRASTACK** 700 +0.08em ink, **LABS** 400 muted, teal bar follows the theme.
- Site header: `PLATFORMCOSMO by` + the lockup, one link to `/`. Phones: product name + mark only.
- Product name lowercase `platformcosmo` in eyebrows and titles; titles `platformcosmo: … | MIRASTACK LABS`.
- Company name in visible text: **MIRASTACK LABS**; legal: **MIRASTACK LABS PRIVATE LIMITED**.
- Footer: lockup, credit line, `© 2026 MIRASTACK LABS PRIVATE LIMITED · Hyderabad, India`, privacy line.
- Verify visually against the real sites (light + dark, 1440 + 390) before deploying.

## Working agreements

- Answer the question that was asked, briefly, and check facts before stating them.
- Containers only (`scripts/pc`); install nothing on the host. A hook blocks host node/npm/npx.
- Orchestrator (Opus) writes contracts, specs and reviews; Sonnet implements; Opus reviews every PR
  before merge; merge on green CI. Branch protection requires 9 checks (see `CONTRIBUTING.md`).
- Ask before destructive or outward-facing actions outside what the owner asked for (other repos,
  deleting resources, publishing). Never publish to npm. Never create credentials; the permission
  system blocks it and the owner does it.
- Repo security (secret scanning, push protection, private vulnerability reporting, Dependabot
  security updates, branch protection) is enabled.

## Gotchas

- Colima does not mount `/private/tmp`: stream files into containers via `tar … | docker run -i`.
- Host shell is bash 3.2: no arrays, keep `$(…)` simple, use script files for anything complex.
- `cf` (Cloudflare CLI): deletes need `--force` (without it they abort but exit 0); `cf pages deploy`
  and token creation are not usable here; deploys go through wrangler.
- Prettier re-pads the whole `DECISIONS.md` table on any edit; conflicts there are expected.
- Generated files (`plugin/bin/pcosmo.mjs`, `types.gen.ts`) conflict on merges: take one side, then
  `scripts/pc run bundle:plugin` / `scripts/pc gen:types`.
- Matrix job names (`build (22)`, `visual (node:…)`) only appear when the job starts: gate steps, not
  the job, or required checks stay pending.

## Human-only items

npm org/names, `npm-publish` environment, `RELEASE_ENABLED`, trusted publishing; DCO app; Azure and
Google Cloud icon terms (D29/D30); `CLAUDE_CODE_OAUTH_TOKEN` for a real prompt → diagram run;
org-level Pages domain verification (`gh` needs `admin:org`); trademark search; conduct contact;
renew `platformbuilds.*` domains; redirect README in the `platformcosmo` GitHub org.
