# Handoff

Start here in a new session. Read this file, then `PROGRESS.md` (status), `DECISIONS.md` (D1–D68),
`CLAUDE.md` (commands) and, for the next feature, `docs/design/assemblies-tracks.md`.
Last updated 2026-11-20.

## Where things stand

- **v1 is delivered** (PLAN M0–M5, v1.1, v1.2): engine, CLI, Claude Code plugin (3 skills, bundled
  `pcosmo`), 276 bundled icons, DC pack, themes, GIF/MP4, CSS-motion mode, image input, gallery,
  visual regression, browser matrix incl. real Safari. Independent Opus verification on main: every
  exit criterion met or human-only. Install: `/plugin marketplace add mirastacklabs-ai/platformcosmo`.
- **Brand look (D51)**: MIRASTACK LABS brand is the default for diagrams (Oswald + JetBrains Mono,
  brand colours, grid on) and for the docs site.
- **Docs site is live**: <https://platformcosmo.io> (+ `www`), see "Website" below.
- **Legal**: copyright holder and publisher are **MIRASTACK LABS PRIVATE LIMITED** (#65).
- **Next feature**: assemblies + programmable explode/implode. Design merged (#60, schema 1.2.0,
  D52–D68). All 1.2.0 fields are rejected by a guard (`assembly/unsupported`) until each phase lands.

## Open PRs

| PR                                                      | What                                                                                            | Action                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #66 `ci/fast-docs-prs`                                  | Docs-only PRs skip engine/visual/browser jobs (finish in ~1 min); `main` always runs everything | Re-running full CI after a merge from main. Merge when green (author: Sonnet; verified with a throwaway docs PR; give it a quick Opus read first)                                  |
| #63 Dependabot: fonttools 4.55.3 → 4.60.2 in `scripts/` | Font subsetting tool, installed with `--require-hashes`                                         | Update the hashes in `scripts/fonts-requirements.txt` / `scripts/docs-fonts-requirements.txt` and re-run the subset scripts; committed font bytes must stay identical, or close it |

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

## Next work (in order)

1. Merge #66; handle #63.
2. Confirm analytics data arrives.
3. **Assemblies Phase 1a — figure mode** (owner's priority: heat-sink install and chassis-fan
   figures from service manuals). Plan: `docs/design/assemblies-tracks.md` (O-1 done; then C-1 →
   C-3 → C-4 → D-2a → D-3a, with R-1 and A2-F in parallel). Normative quality rules (true
   silhouettes, clean base, no foreign pixels, grouping, annotation validation, two-state residuals):
   `docs/design/document-ingestion.md` §6. These exist because a hand prototype left ghost heat-sink
   fins and slivers; the owner treats them as the spec.
4. Phases 1b → 2 (server → rack → hall story) → 3 (PDF parser, booklets, bricks) per the tracks doc.
5. Follow-ups in `PROGRESS.md`.

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
