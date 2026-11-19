# Contributing

Thanks for helping. Please read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Dev workflow (containers only)

Nothing is installed on the host. All commands run in Docker through `scripts/pc`
(pnpm inside `node:24.21-bookworm-slim`, with a cached pnpm store volume):

```sh
scripts/pc install
scripts/pc run ci        # format:check, lint, typecheck, check:types-gen, test, publish:dry
scripts/pc test
scripts/pc gen:types     # regenerate types from schema/v1.json
PC_NODE_IMAGE=node:22-bookworm-slim scripts/pc install --frozen-lockfile && PC_NODE_IMAGE=node:22-bookworm-slim scripts/pc run ci   # Node 22 check (after a clean install)
```

## Rules

- `schema/v1.json` is the single source of truth; types are generated from it. Commit
  regenerated `types.gen.ts` (CI runs `check:types-gen`).
- Output must be deterministic: the same spec produces byte-identical SVG.
- No runtime network access in `core` or `cli` (except `icons add`).
- Keep dependencies minimal and justify any new one in the PR.
- Every engine module ships with unit tests; update snapshots deliberately.
- A change to `core` or `cli` also commits the rebuilt plugin bundle and gallery:
  `scripts/pc run build && scripts/pc run bundle:plugin && scripts/pc run gen:gallery`
  (CI job `plugin-bundle` checks both, DECISIONS D19). Visual goldens change only with
  `VISUAL_UPDATE=1 scripts/pc run visual`, reviewed like code.

## Commits and DCO

Use [Conventional Commits](https://www.conventionalcommits.org/) and sign off every
commit under the [DCO](https://developercertificate.org/):

```sh
git commit -s -m "feat(core): add layout skeleton"
```

## Changesets

User-facing changes to a package need a changeset: `scripts/pc changeset`, then commit
the generated file in `.changeset/`.

## Docs site (GitHub Pages)

`.github/workflows/docs-pages.yml` builds the VitePress site on every relevant push to `main`
but deploys only when the repository variable `PAGES_ENABLED` is `true`. Human steps, once:

1. Settings > Pages > Source: **GitHub Actions**.
2. Settings > Secrets and variables > Actions > Variables: add `PAGES_ENABLED` = `true`.
3. DNS for `platformcosmo.io`: apex `A` records `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153` (and matching `AAAA` records `2606:50c0:8000::153`,
   `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`), and a `CNAME`
   for `www` pointing at the organization's Pages host. Then enable "Enforce HTTPS" in Pages settings.

4. Settings > Environments > `github-pages` > Deployment branches: restrict to `main`.
5. Verify `platformcosmo.io` under the organization's Settings > Pages > Verified domains, so
   nobody else can claim the domain if the Pages site is later removed (subdomain takeover).

The workflow writes the `CNAME` file into the build output. The schema is served at its
`$id`, `https://platformcosmo.io/schema/v1.json`; CI checks it is byte-identical to `schema/v1.json`.
