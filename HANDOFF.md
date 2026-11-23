# Handoff

Start here. Read this file, `PROGRESS.md`, `DECISIONS.md` (D1–D86), `CLAUDE.md` (commands) and
`docs/design/assemblies-tracks.md`. Last updated 2026-11-23 (after #126, end of session 3).

## State of main

- v1 is delivered; the assemblies tracks (Phases 1a → 3) are all merged. Session 3 merged #108–#126
  (batch #118 carried #108–#113, #115, #116). Phase 2 is lifted (D-4a, #121). #126 draws racks in
  mirrored rows as a true half turn (D86; changed only the dc-hall and hall-to-heatsink bytes).
- Published to npm 2026-11-23: `platformcosmo` 0.1.0 (plugin and marketplace 0.1.0) and the 11
  `@platformcosmo/*` packages (icons-* 0.0.1, the rest 0.1.0), with provenance; GitHub releases per
  package. Release record and pipeline gaps: `docs/release/npm-publishing-checklist.md` ("First release").
- CI gate (#129, D87): `scripts/ci-gate.sh` skips tests when no code changed since the last green
  main commit (docs, Markdown, `.changeset/`, `.github/`, version-only bumps are not code). Owner rule:
  never rerun tests on code that already passed. The owner OK'd merging PRs.
- Workspace is clean: 0 open PRs, branches `main` only (local and remote, `delete_branch_on_merge` on),
  no extra worktrees, no containers.

## Next session (Claude desktop app, with browser)

1. Before the next release (the `NPM_TOKEN` expires 2026-11-30): add trusted publishers for the 12
   packages (they expire if unused for 2 days, so do it right before releasing), then remove
   `NODE_AUTH_TOKEN` from `release.yml` and delete the secret. Fix the two pipeline gaps in the checklist
   (Actions may not open PRs; changesets does not push tags).
2. Then, only if the owner asks, the backlog below. Nothing in it blocks a release.

## Open PRs

None.

## Backlog (from the orchestrator's `followups.md`, not blocking)

- Round parts (engine pistons, cylinders, rover, 2OU server) use clip-fallback: clip with the part's own
  outline, not the footprint box (`render/assembly/dom.ts`). A generic WIP patch is parked locally at
  `.worktrees/orchestrator/archive/outline-clip-wip.patch`; out of scope until an example needs it
  (clip-fallback works as designed: parts hide only while crossing, with a named diagnostic).
- Slot devices in mirrored rows are still only y-reflected in 1.1 (LED side differs from assembly mode).
- Targeted rack vs its 1.1 look at rest: A1 GPU node loses its front grille via clip-fallback; ToR
  LED/port detail. Leader router has no 1.1-object obstacles.
- Visuals: §19.4 t=12 label pile-up and "Rack R1" touching the edge; §19.4 t=4 crops "ToR"; fading "OCP NIC"
  label cut during §19.2 move 6.6–6.8 s; wall focus `w/wall` callout copies fly out of the zoom window;
  close-up levels draw no callout box; quarter-turn view groups use the main groups' windows.
- Focus-label guard matches exact paths only (counted instances such as `dimm-a-3`).
- CSS vs PNG differ during camera transitions (caption box; dc-hall 2.3%).
- Cleanup: `unsupported.ts` can shrink to the storyboard-closeup refusal; unused `cpu-2/closeup` instances
  still cost elements; `validate` builds racks 3x via `planScene`; `slotCloseupWalk` typo hint false positive.
- Core: valve cover hidden while the head lifts; pistons tuck under the lifted gasket in final steps.
- Validation: close-up chains with cumulative prefix for `assembly/too-deep` (Q04); align rack assembly
  mode to §8.1 targeted-only (Q09); unknown storyboard id reads `assembly/unsupported` (R-2 Q06).
- Brick/A2: wire `checkBrickPlacement` through an `AssemblyContext.placement` callback; extract a shared
  `definePack` helper for parts-base/brick/auto.
- Tooling:
  `update-branch.sh` does not push when already ancestor but local is ahead; bundle size guard is in
  `packages/cli/scripts/bundle-plugin.mjs` (raise with a PR note).
- Flake dead end: `asset/bad-raster` in `packages/assets/test/figure.test.ts` (not reproduced in ~1150
  runs; likely a 0x0 mask). If it recurs, log mask/sprite dims at the rejection.
- C-4 gate may miss 1 px leftovers (thin arrow stubs, board-line gaps).
- #56 R02: one Ctrl-C does not stop an in-process GIF with `--gif --mp4`.
- VitePress runs on vite 6: check the docs site visually before the next deploy.

## How to run

Containers only: see `CLAUDE.md` (`scripts/pc install|test|lint|typecheck|format|build`, `scripts/pc run ci`).
Full CI is slow under load; run targeted tests first (`scripts/pc build`, then `scripts/pc exec vitest run <path>`).

## Publishing

`docs/release/npm-publishing-checklist.md`: the release flow, the first-release record and the open gaps.

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
- Owner wants fast turnaround and a clean workspace: only P0/P1 review findings block a merge (P2/P3 go
  to followups), no out-of-scope work, batch approved PRs into one integration PR, and after every merge
  remove its worktree and local branch in the same turn. At most 3 implementers + 1 reviewer; track
  every agent in a ledger and stop finished ones.
- Orchestrator scratch lives outside git in `.worktrees/orchestrator/` (local to the owner's Mac):
  `brief-common.md` (rules pasted into every agent brief), `ci-lock.sh` (one full CI at a time:
  `ci-lock.sh scripts/pc run ci > ci.log 2>&1`), `cleanup.sh` (removes merged worktrees/branches),
  `ledger.md`, `followups.md`, `archive/`.
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

npm tokens and npm 2FA approvals. DCO app; Azure and Google Cloud icon terms (D29/D30);
`CLAUDE_CODE_OAUTH_TOKEN` for a real prompt → diagram run; org-level Pages domain verification (`gh` needs
`admin:org`); trademark search; conduct contact; renew `platformbuilds.*` domains; redirect README in the
`platformcosmo` GitHub org; exclude `.claude/worktrees` and `.worktrees` from Spotlight.
