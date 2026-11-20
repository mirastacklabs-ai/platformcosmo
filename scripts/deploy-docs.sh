#!/usr/bin/env bash
# Builds the docs site in a container and deploys it to Cloudflare (platformcosmo.io) with the
# maintainer's own wrangler login. Manual by design: run it from a clean, up-to-date main.
#
#   scripts/deploy-docs.sh            build + deploy
#   scripts/deploy-docs.sh --dry-run  build + validate the upload without deploying
#
# Needs: Docker (builds run via scripts/pc), a logged-in wrangler on PATH (`wrangler login`) or
# WRANGLER pointing at one, and CLOUDFLARE_ACCOUNT_ID (the MiraStack Labs account).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

wrangler="${WRANGLER:-wrangler}"
if ! command -v "${wrangler%% *}" >/dev/null 2>&1; then
  echo "wrangler not found; install it or set WRANGLER=/path/to/wrangler" >&2
  exit 2
fi
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID to the MiraStack Labs account id}"

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy from a dirty tree; commit or discard changes first" >&2
  exit 2
fi
echo "deploying docs from $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"

scripts/pc install --frozen-lockfile
scripts/pc run build
scripts/pc run docs:build

cmp -s docs/.vitepress/dist/schema/v1.json schema/v1.json || {
  echo "built docs do not serve schema/v1.json byte-identical; aborting" >&2
  exit 1
}

if [ "${1:-}" = "--dry-run" ]; then
  $wrangler deploy --config docs/wrangler.jsonc --dry-run
else
  $wrangler deploy --config docs/wrangler.jsonc
fi
