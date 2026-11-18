#!/usr/bin/env bash
# Browser check (PLAN M2 exit). Nothing is installed on the host:
#   1. fixtures are generated in the pnpm container (scripts/pc)
#   2. the check runs in the official Playwright image (chromium, firefox, webkit)
# Usage: tests/browser/run.sh      Output: tests/browser/out/results.{json,md}
set -euo pipefail
cd "$(dirname "$0")/../.."

PW_VERSION="${PW_VERSION:-1.64.0}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v${PW_VERSION}-noble}"

rm -rf tests/browser/out
scripts/pc exec vitest run -c tests/browser/vitest.config.ts

# The playwright npm package lives in the container only; browsers come with the image.
docker run --rm --ipc=host \
  -v "$PWD/tests/browser":/t \
  -e OUT_DIR=/t/out \
  "$PW_IMAGE" sh -c "
    set -e
    mkdir -p /tmp/pw && cd /tmp/pw
    npm init -y >/dev/null
    npm install --silent --no-audit --no-fund playwright@${PW_VERSION}
    cp /t/check.mjs .
    node check.mjs
  "
