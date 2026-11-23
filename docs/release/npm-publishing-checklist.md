# npm publishing checklist

Release flow for the owner's app + browser session; never publish from a coding session. The first
release (0.1.0) went out on 2026-11-23; see "First release" for what happened and what is still open.

## What the workflow does

`release.yml` runs on every push to `main`. The job is skipped unless the repository is
`mirastacklabs-ai/platformcosmo` and the repo variable `RELEASE_ENABLED` is `true`. It uses the
`npm-publish` environment (owner approval, `main` only), Node 24, `pnpm install --frozen-lockfile`,
`scripts/ci-gate.sh` (full `pnpm run ci` only if code changed since the newest main commit green in CI,
Browser and Visual regression; otherwise `pnpm build`), a stub guard, then `changesets/action`:

- With pending changesets (`.changeset/*.md`) it pushes `changeset-release/main` and tries to open a
  "chore: version packages" PR (`pnpm run version-packages` = `changeset version`, `sync:versions`,
  `bundle:plugin`).
- When that PR is merged and no changesets remain, it runs `pnpm changeset publish`, with
  `NPM_CONFIG_PROVENANCE=true`, <span v-pre>`NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}`</span> and `id-token: write`.

## First release (2026-11-23)

- Published: `platformcosmo` 0.1.0 (plugin and marketplace 0.1.0);
  `@platformcosmo/{core,dc-pack,parts-auto,parts-base,parts-brick,pdf,themes}` 0.1.0;
  `@platformcosmo/icons-{base,k8s,lucide,simple}` 0.0.1. All with SLSA provenance. Checked in a clean `node:24` container: `npm i platformcosmo@0.1.0`, `pcosmo --version`,
  `init` + `build` of the starter and `dc-hall`.
- Setup: npm org `@platformcosmo` (owner `aarvee`, 2FA); environment `npm-publish` (reviewer `aarvee11`,
  `main` only); variable `RELEASE_ENABLED=true`; environment secret `NPM_TOKEN` (granular, read and write on
  all packages, **Bypass 2FA**, expires 2026-11-30). A token without Bypass 2FA fails with `EOTP`.
- New packages go through npm's automated review: a public `0.0.0-stage` placeholder first, the real
  version shows as "Validating" and goes live by itself (about 4 minutes). No manual approval needed.
- Approve a waiting release run:
  `gh api -X POST repos/<repo>/actions/runs/<id>/pending_deployments -F "environment_ids[]=<env id>" -f state=approved`.

Open gaps (fix before or during the next release):

1. **Actions may not create PRs** in this repo, so changesets pushes `changeset-release/main` but fails to
   open the PR. Open it by hand (`gh pr create --head changeset-release/main`), or allow it in Settings,
   Actions, General.
2. **Tags:** `changeset publish` tags only locally (checkout uses `persist-credentials: false`), and the
   action creates no releases (`createGithubReleases: false`). The workflow's last step creates the one
   GitHub release, `platformcosmo@<version>` with its CHANGELOG section, once that version is on npm. The
   per-package 0.1.0 releases and tags were deleted on 2026-11-23; only `platformcosmo@0.1.0` remains.
3. **Trusted publishing (OIDC) not set up.** The packages exist now, so it can be. A trusted publisher
   expires if no publish uses it within 2 days: add it for all 12 packages right before the next release,
   then remove `NODE_AUTH_TOKEN` from `release.yml` and delete `NPM_TOKEN`. Check that
   `pnpm changeset publish` authenticates through OIDC (npm CLI >= 11.5.1).
4. `scripts/pc changeset status` fails locally: the container has no `git`.

## Packages (`publishConfig: access public, provenance true`)

`platformcosmo` (CLI, `bin: pcosmo`, unscoped), `@platformcosmo/core`, `dc-pack`, `icons-base`,
`icons-k8s`, `icons-lucide`, `icons-simple`, `parts-auto`, `parts-base`, `parts-brick`, `pdf`, `themes`.
`@platformcosmo/assets` is `private: true` and is not published. `@platformcosmo/core/internal` is an
unstable subpath (D85).

## Steps

1. **npm account and org.** Create the npm org `@platformcosmo` (PLAN.md §Launch lists this); enable 2FA.
   Check that the unscoped name `platformcosmo` is free or claim it. **(unconfirmed: name availability)**
2. **Auth for the first publish.** The workflow authenticates with `NPM_TOKEN`, not OIDC, so for the
   workflow as written: create a granular, automation-capable npm token scoped to `@platformcosmo/*` and
   `platformcosmo` with publish rights, and store it as the secret `NPM_TOKEN` in the `npm-publish`
   environment (not repo-wide).
3. **Trusted publishing (OIDC), per package.** In npm, for each of the 12 packages: Settings, Trusted
   Publisher, GitHub Actions; repository `mirastacklabs-ai/platformcosmo`, workflow `release.yml`,
   environment `npm-publish`. **(unconfirmed: npm may require the package to exist before a trusted
   publisher can be added, so the first publish may need `NPM_TOKEN`; and it needs an npm CLI new enough
   for OIDC, which Node 24's bundled npm is expected to be, not verified.)** Once OIDC works, remove
   `NODE_AUTH_TOKEN`/`NPM_TOKEN` from `release.yml` in a PR and delete the secret. `id-token: write` and
   provenance are already set.
4. **GitHub environment.** Settings, Environments, New: `npm-publish`. Add required reviewer(s) (the
   owner) and restrict deployment branches to `main`. Put `NPM_TOKEN` here (step 2).
5. **Version-PR CI.** Optionally create `RELEASE_BOT_TOKEN` (GitHub App token or fine-grained PAT with
   contents + pull-requests write) so CI runs on the version PR; otherwise run CI manually on it. The bot
   commit has no DCO sign-off, so the DCO check must exempt it (see the comment in `release.yml`).
   **(unconfirmed: how the DCO app is configured)**
6. **Dry run (safe, local, containers only).** `scripts/pc run ci` already ends with
   `pnpm -r publish --dry-run --no-git-checks`; also `scripts/pc run publish:dry`. Inspect the file list
   per package (`files`: `dist`, `schema`, `LICENSE`, `NOTICE`; the CLI ships the bundled plugin via
   `bundle:plugin`). To preview versions without writing: `scripts/pc changeset status`.
7. **Enable.** Set the repo variable `RELEASE_ENABLED=true` (Settings, Variables). The next push to `main`
   opens the "chore: version packages" PR. Review the bumps and changelogs.
8. **Release.** Merge the version PR (checks green; `npm-publish` approval if required). The following run
   publishes. To stop at any point set `RELEASE_ENABLED` back to `false`.
9. **Verify after publish.** `npm view platformcosmo version` and each `@platformcosmo/*`; the npm page
   shows the provenance badge and the source commit; the `platformcosmo@<version>` GitHub release exists; in a clean
   container: `npx platformcosmo --version` and render one example
   (`npx platformcosmo build examples/<spec>.cosmo.json`); the plugin's `plugin.json` and marketplace
   versions match (`scripts/pc run check:versions`).
10. **After.** Update `PROGRESS.md` and the README install instructions if they still mention GitHub-only
    install; tick the Launch checklist items in `docs/PLAN.md`.
