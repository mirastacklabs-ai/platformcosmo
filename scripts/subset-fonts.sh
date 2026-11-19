#!/usr/bin/env bash
# Rebuild packages/core/assets/fonts/*.latin.ttf from the upstream static TTFs (see PROVENANCE.txt).
# Usage: scripts/subset-fonts.sh <dir with Oswald-{Regular,SemiBold}.ttf and JetBrainsMono-{Regular,Bold}.ttf>
# Runs fonttools (pinned) inside a container; nothing is installed on the host. The input dir must
# be under the repo (Colima does not mount /private/tmp).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?input directory}"
OUT=packages/core/assets/fonts
UNI='U+0020-007E,U+00A0-00AC,U+00AE-00FF,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+20AC,U+2190-2193,U+2212,U+2248,U+2260,U+2264-2265'
docker run --rm -v "$PWD":/work -w /work python:3.12-slim sh -c "
pip install -q fonttools==4.55.3 >/dev/null 2>&1
for f in Oswald-Regular Oswald-SemiBold JetBrainsMono-Regular JetBrainsMono-Bold; do
  pyftsubset \"$SRC/\$f.ttf\" --unicodes='$UNI' --no-hinting --layout-features= --glyph-names=false \
    --notdef-outline --name-IDs='*' --name-legacy --name-languages='*' \
    --drop-tables+=DSIG,GDEF,GPOS,GSUB,kern,gasp,STAT,prep,fpgm,cvt \
    --output-file=$OUT/\$f.latin.ttf
done
python - <<'PY'
from fontTools.ttLib import TTFont
for f in ['Oswald-Regular','Oswald-SemiBold','JetBrainsMono-Regular','JetBrainsMono-Bold']:
    t = TTFont('$OUT/' + f + '.latin.ttf')
    c = t.getBestCmap()
    want = [0x2190, 0x2192, 0x2212, 0x2026, 0xB7, 0xD7, 0x2022, 0x2248]
    print(f, sorted(t.keys()), 'glyphs', len(t.getGlyphOrder()), 'missing',
          [hex(w) for w in want if w not in c], t['name'].getDebugName(1),
          t['name'].getDebugName(2), t['OS/2'].usWeightClass)
PY
"
