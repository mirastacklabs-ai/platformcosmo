#!/usr/bin/env bash
# Rebuild docs/public/fonts/*.woff2 (self-hosted web fonts for platformcosmo.io) from the SAME upstream
# static TTFs as the engine fonts (packages/core/assets/fonts/PROVENANCE.txt).
# Usage: scripts/subset-docs-fonts.sh <dir with Oswald-{Regular,Medium,SemiBold}.ttf and JetBrainsMono-{Regular,Bold}.ttf>
# fonttools + brotli are pinned by version and wheel hash (scripts/docs-fonts-requirements.txt) in an image pinned by
# digest, run in a container; nothing is installed on the host. The input dir must be under the repo (Colima does not mount /private/tmp).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?input directory}"
OUT=docs/public/fonts
mkdir -p "$OUT"
# Latin + Latin-1 + a little Latin Extended-A, typographic punctuation, arrows (JetBrains Mono only has them), minus, math.
UNI='U+0020-007E,U+00A0-00FF,U+0100-017F,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+20AC,U+2190-2193,U+2212,U+2248,U+2260,U+2264-2265'
docker run --rm -v "$PWD":/work -w /work python@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b sh -c "
pip install -q --require-hashes -r scripts/docs-fonts-requirements.txt >/dev/null
sub() { pyftsubset \"$SRC/\$1.ttf\" --unicodes='$UNI' --flavor=woff2 --layout-features=\"\$3\" --no-hinting \
  --notdef-outline --name-IDs='*' --name-legacy --name-languages='*' --drop-tables+=DSIG,gasp,STAT --output-file=$OUT/\$2.woff2; }
sub Oswald-Regular oswald-400 kern
sub Oswald-Medium oswald-500 kern
sub Oswald-SemiBold oswald-600 kern
sub JetBrainsMono-Regular jetbrains-mono-400 kern
sub JetBrainsMono-Bold jetbrains-mono-700 kern
ls -l $OUT
"
(cd "$OUT" && shasum -a 256 *.woff2)
