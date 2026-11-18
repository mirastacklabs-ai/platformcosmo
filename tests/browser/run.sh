#!/usr/bin/env bash
# Browser check (PLAN M2 exit). Nothing is installed on the host:
#   1. the fixture generator (and its typecheck) run in the pnpm container (scripts/pc)
#   2. the check runs in the official Playwright image, pinned by digest, with the playwright npm
#      package installed from the committed lockfile (npm ci) inside the container only
# Usage:  tests/browser/run.sh [DIR_OF_SVGS]
#   no argument: generated fixtures; with DIR_OF_SVGS: any *.svg there (e.g. real render() output)
# Env:    PW_VERSION (default 1.64.0), PW_IMAGE, UPDATE_RESULTS=1 (copy RESULTS.md next to this file)
# Output: tests/browser/out/results.json and RESULTS.md
set -euo pipefail
cd "$(dirname "$0")/../.."

PW_VERSION="${PW_VERSION:-1.64.0}"
PW_DIGEST="sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v${PW_VERSION}-noble@${PW_DIGEST}}"
OUT="tests/browser/out"

rm -rf "$OUT"
mkdir -p "$OUT/fixtures"

if [ $# -ge 1 ]; then
  INPUT_DIR="$1"
else
  scripts/pc exec tsc --noEmit -p tests/browser/tsconfig.json
  scripts/pc exec vitest run -c tests/browser/vitest.config.ts
  INPUT_DIR="$OUT/fixtures"
fi
[ -d "$INPUT_DIR" ] || { echo "not a directory: $INPUT_DIR" >&2; exit 2; }

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
rc=0
docker run --rm --ipc=host --user "$(id -u):$(id -g)" \
  -v "$PWD/tests/browser":/t:ro \
  -v "$(cd "$INPUT_DIR" && pwd)":/in:ro \
  -v "$PWD/$OUT":/out \
  -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  -e PW_VERSION="$PW_VERSION" -e PW_IMAGE="$PW_IMAGE" -e GIT_SHA="$GIT_SHA" \
  -e INPUT_DIR=/in -e OUT_DIR=/out \
  "$PW_IMAGE" sh -c '
    set -e
    mkdir -p /tmp/pw && cd /tmp/pw
    cp /t/package.json /t/package-lock.json /t/*.mjs .
    npm ci --silent --no-audit --no-fund
    node check.mjs
  ' || rc=$?

if [ "${UPDATE_RESULTS:-}" = 1 ] && [ -f "$OUT/RESULTS.md" ]; then
  cp "$OUT/RESULTS.md" tests/browser/RESULTS.md
fi
exit "$rc"
