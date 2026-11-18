# PlatformCosmo

Prompt -> spec (`*.cosmo.json`) -> deterministic engine -> animated isometric SVG.
Plan: `docs/PLAN.md`. Working rules: PLAN section 17 (milestone by milestone, deterministic
output, no runtime network in core/cli, schema is the source of truth, minimal deps,
Conventional Commits with DCO sign-off).

## Commands (containers only, never host node/pnpm)

- `scripts/pc install` install deps
- `scripts/pc run ci` full CI sequence
- `scripts/pc test` / `lint` / `typecheck` / `format` / `build`
- `scripts/pc gen:types` regenerate `packages/core/src/schema/types.gen.ts`
- `PC_NODE_IMAGE=node:20-bookworm-slim scripts/pc run ci` Node 20 check

## Layout

- `schema/v1.json` single source of truth; `*.gen.ts` files are generated, never hand-edit
- `packages/{core,cli,icons-base,themes}`; `plugin/` Claude Code plugin; `.claude-plugin/` marketplace
- `LICENSE`/`NOTICE` are copied into packages at build by `scripts/sync-legal.mjs` (gitignored there)

## Notes

- `pnpm test` builds first (the CLI test runs the built `dist/bin.js`).
- Pin TypeScript to 6.x until typescript-eslint supports 7.

## Container-only hook

- `.claude/hooks/container-only.sh` (PreToolUse on Bash) denies host `node/npm/pnpm/npx/tsc/vitest/eslint/prettier/...` and installs (`brew|pip|gem|cargo|go install`). Best-effort guardrail, not a sandbox.
- Test it: `bash scripts/test-container-hook.sh` (bash + jq only).
- Versions: `packages/cli` is the source of truth; `scripts/pc run sync:versions` updates plugin.json and marketplace.json (`check:versions` runs in ci).
