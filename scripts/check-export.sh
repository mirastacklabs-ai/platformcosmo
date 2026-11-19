#!/usr/bin/env bash
# Asserts the exports in $1 for the load-balancing example (CI export-macos workflow).
# usage: check-export.sh <dir> [--gif-only] --frames N --fps F
# PNG and static SVG must be byte-identical to the committed Linux renders in examples/gallery.
# Needs ffprobe on PATH. bash 3.2 compatible.
set -euo pipefail
out=${1:?usage: check-export.sh <dir> [--gif-only] --frames N --fps F}
shift
gif_only=0
want=""
fps=""
while [ $# -gt 0 ]; do
  case $1 in
    --gif-only) gif_only=1 ;;
    --frames) want=$2; shift ;;
    --fps) fps=$2; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
: "${want:?--frames required}" "${fps:?--fps required}"
n=load-balancing
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

frames() { ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$1"; }
duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
# true when |a - b| <= tol (awk handles floats)
near() { awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= t) }'; }
expected=$(awk -v n="$want" -v f="$fps" 'BEGIN { printf "%.4f", n / f }')

[ "$(head -c 6 "$out/$n.gif")" = "GIF89a" ] || bad "$n.gif does not start with GIF89a"
gf=$(frames "$out/$n.gif")
gd=$(duration "$out/$n.gif")
echo "gif: $gf frames, ${gd}s (expected $want frames, ${expected}s)"
# The encoder may merge identical frames; then the summed delays must still cover the duration.
if [ "${gf:-0}" -ne "$want" ]; then
  [ "${gf:-0}" -gt 1 ] || bad "$n.gif has $gf frame(s), expected > 1"
  near "$gd" "$expected" 0.1 || bad "$n.gif duration ${gd}s != ${expected}s and frame count $gf != $want"
fi

[ "$(head -c 8 "$out/$n.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || bad "$n.png signature invalid"

if [ "$gif_only" -eq 0 ]; then
  codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$out/$n.mp4")
  [ "$codec" = "h264" ] || bad "$n.mp4 codec is '$codec', expected h264"
  mf=$(frames "$out/$n.mp4")
  md=$(duration "$out/$n.mp4")
  echo "mp4: $codec, $mf frames, ${md}s"
  [ "${mf:-0}" -eq "$want" ] || bad "$n.mp4 has $mf frame(s), expected $want"
  near "$md" "$expected" 0.1 || bad "$n.mp4 duration ${md}s != ${expected}s (+-0.1)"
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
