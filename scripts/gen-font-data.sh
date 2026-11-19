#!/usr/bin/env bash
# Regenerate packages/core/src/text/font-data.ts from packages/core/assets/fonts/*.latin.ttf.
set -euo pipefail
cd "$(dirname "$0")/.."
D=packages/core/assets/fonts
OUT=packages/core/src/text/font-data.ts
{
  echo "// Base64 of packages/core/assets/fonts/{Oswald-Regular,Oswald-SemiBold,JetBrainsMono-Regular,JetBrainsMono-Bold}.latin.ttf"
  echo "// (Oswald and JetBrains Mono, SIL OFL 1.1; see LICENSES/ and the PROVENANCE.txt next to the fonts)."
  echo "// Regenerate with scripts/gen-font-data.sh. Do not edit by hand."
  for pair in OSWALD_REGULAR:Oswald-Regular OSWALD_SEMIBOLD:Oswald-SemiBold JETBRAINS_REGULAR:JetBrainsMono-Regular JETBRAINS_BOLD:JetBrainsMono-Bold; do
    echo "export const ${pair%%:*}_B64 ="
    echo "  \"$(base64 -i "$D/${pair##*:}.latin.ttf" | tr -d '\n')\";"
  done
} > "$OUT"
