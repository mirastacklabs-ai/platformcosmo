# npm publishing checklist

For the owner's separate app + browser session. Nothing here has been run; never publish from a coding
session. Derived from `.github/workflows/release.yml`, `.changeset/config.json`, the root and package
`package.json` files. **(unconfirmed)** marks anything not verifiable from the repo.

## What the workflow does

`release.yml` runs on every push to `main`. The job is skipped unless the repository is
`mirastacklabs-ai/platformcosmo` and the repo variable `RELEASE_ENABLED` is `true`. It uses the
`npm-publish` environment, Node 24, `pnpm install --frozen-lockfile`, `pnpm run ci`, a stub guard
(`! grep -rl 'not implemented: owned by Track' packages/*/src`), then `changesets/action`:

- With pending changesets (`.changeset/*.md`, 39 today) it opens or updates a "chore: version packages" PR
  (`pnpm run version-packages` = `changeset version`, `sync:versions`, `bundle:plugin`).
- When that PR is merged and no changesets remain, it runs `pnpm changeset publish`, with
  `NPM_CONFIG_PROVENANCE=true`, `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}` and `id-token: write`.

## State (publishing session, 2026-11-23)

- npm: org `@platformcosmo` exists, owner `aarvee` with 2FA. All 12 names (and unscoped `platformcosmo`)
  were unclaimed on the registry (HTTP 404) before the first publish.
- Environment `npm-publish` created: required reviewer `aarvee11`, deployments limited to `main`.
- Variable `RELEASE_ENABLED=true`. `release.yml` also runs on `workflow_dispatch`.
- `NPM_TOKEN` is an environment secret on `npm-publish` (owner-created, short-lived, bootstrap only).
  No `RELEASE_BOT_TOKEN`: the owner closes and reopens the version PR once to start CI on it.
- DCO is not a required check, so the unsigned bot commit on the version PR does not block a merge.
- Local `scripts/pc changeset status` fails in the container (no `git` in the image); count the bumps
  from `.changeset/*.md` instead, or read the version PR.
- `publish:dry` passed for all 12 packages after a clean `scripts/pc install --frozen-lockfile` (a
  stale `node_modules` fails the CLI build on the private `@platformcosmo/assets`, which tsup bundles).

## Packages (all `0.0.0`, `publishConfig: access public, provenance true`)

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
   shows the provenance badge and the source commit; the GitHub tags and releases exist; in a clean
   container: `npx platformcosmo --version` and render one example
   (`npx platformcosmo build examples/<spec>.cosmo.json`); the plugin's `plugin.json` and marketplace
   versions match (`scripts/pc run check:versions`).
10. **After.** Update `PROGRESS.md` and the README install instructions if they still mention GitHub-only
    install; tick the Launch checklist items in `docs/PLAN.md`.
