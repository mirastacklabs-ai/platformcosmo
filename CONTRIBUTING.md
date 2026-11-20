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

## CI on docs-only PRs

Each workflow with a required check starts with a `changes` job that diffs the PR against its base.
If every changed file is documentation (`docs/**`, any `*.md` including `.changeset/*.md`, `LICENSE*`,
`NOTICE`, `scripts/deploy-docs.sh`, `.github/ISSUE_TEMPLATE/**`), the engine, plugin, hook, visual and
browser jobs are skipped (a skipped job satisfies a required check) and `plugin-bundle` runs only the
docs build and the schema identity check. Any other changed file, any push and any manual run executes
everything, so `main` is always fully tested. We use job-level `if:` and not workflow-level `paths:`
filters, which would leave required checks pending forever.

## Docs site

`.github/workflows/docs-pages.yml` ("Docs build") only builds the VitePress site on pushes to `main`
that touch the docs inputs, so a broken docs build is caught in CI. The site at
`https://platformcosmo.io` is deployed manually to Cloudflare with `scripts/deploy-docs.sh`, using the
maintainer's wrangler login (see `docs/wrangler.jsonc`). GitHub Pages stays enabled only as a
domain-claim guard: do not deploy from it. The schema is served at its `$id`,
`https://platformcosmo.io/schema/v1.json`; CI checks it is byte-identical to `schema/v1.json`.
