#!/usr/bin/env bash
# Asserts the exports in $1 for the load-balancing example (CI export-macos job).
# PNG and static SVG must be byte-identical to the committed Linux renders in examples/gallery.
# Needs ffprobe on PATH. bash 3.2 compatible.
set -euo pipefail
out=${1:?usage: check-export.sh <dir> [--gif-only]}
gif_only=${2:-}
n=load-balancing
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

frames() { ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$1"; }

[ "$(head -c 6 "$out/$n.gif")" = "GIF89a" ] || bad "$n.gif does not start with GIF89a"
gf=$(frames "$out/$n.gif")
[ "${gf:-0}" -gt 1 ] || bad "$n.gif has $gf frame(s), expected > 1"
echo "gif: $gf frames"

[ "$(head -c 8 "$out/$n.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || bad "$n.png signature invalid"

if [ "$gif_only" != "--gif-only" ]; then
  codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$out/$n.mp4")
  [ "$codec" = "h264" ] || bad "$n.mp4 codec is '$codec', expected h264"
  mf=$(frames "$out/$n.mp4")
  [ "${mf:-0}" -ge 24 ] || bad "$n.mp4 has $mf frame(s), expected >= 24"
  echo "mp4: $codec, $mf frames"
  if cmp -s "$out/$n.static.svg" "examples/gallery/$n.static.svg"; then
    echo "static.svg: identical to Linux render"
  else
    bad "$n.static.svg differs from examples/gallery (cross-OS determinism)"
  fi
fi
if cmp -s "$out/$n.png" "examples/gallery/$n.png"; then
  echo "png: identical to Linux render"
else
  bad "$n.png differs from examples/gallery (cross-OS determinism)"
  cmp "$out/$n.png" "examples/gallery/$n.png" >&2 || true
fi
exit "$fail"
