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
PC_NODE_IMAGE=node:20-bookworm-slim scripts/pc run ci   # Node 20 check
```

## Rules

- `schema/v1.json` is the single source of truth; types are generated from it. Commit
  regenerated `types.gen.ts` (CI runs `check:types-gen`).
- Output must be deterministic: the same spec produces byte-identical SVG.
- No runtime network access in `core` or `cli` (except `icons add`).
- Keep dependencies minimal and justify any new one in the PR.
- Every engine module ships with unit tests; update snapshots deliberately.

## Commits and DCO

Use [Conventional Commits](https://www.conventionalcommits.org/) and sign off every
commit under the [DCO](https://developercertificate.org/):

```sh
git commit -s -m "feat(core): add layout skeleton"
```

## Changesets

User-facing changes to a package need a changeset: `scripts/pc changeset`, then commit
the generated file in `.changeset/`.
