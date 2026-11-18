#!/usr/bin/env bash
# Real-Safari passes for CI on macOS (never run this on a machine you use: it changes the
# Accessibility setting and takes over Safari). Input layout, from the browser-check artifact
# downloaded to tests/browser: out/fixtures (generated) and real (CLI renders of the examples),
# plus a generated negative fixture (a diagram whose reduced-motion CSS hides everything).
#   pass 1 (motion):  Reduce Motion OFF, animation checks; also saves each diagram's t=0 frame
#   pass 2 (reduced): Reduce Motion ON, static rest-frame checks (content present, equal to the
#                     pass-1 t=0 frame); the negative fixture must FAIL here, proving the checks bite
# Results: tests/browser/out-safari/<pass>/<input>/results-safari.json. Exit 1 if anything failed.
set -uo pipefail
cd "$(dirname "$0")/../.."

set_reduce_motion() { # on|off: write, then assert the stored value
  local bool expect got
  if [ "$1" = on ]; then bool=true; expect=1; else bool=false; expect=0; fi
  echo "reduceMotion before: $(defaults read com.apple.universalaccess reduceMotion 2>&1 || true)"
  defaults write com.apple.universalaccess reduceMotion -bool "$bool"
  got="$(defaults read com.apple.universalaccess reduceMotion 2>&1 || true)"
  echo "reduceMotion after: $got (expected $expect)"
  [ "$got" = "$expect" ] || { echo "Reduce Motion is not $1" >&2; return 1; }
}

start_driver() {
  safaridriver -p 4444 &
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:4444/status >/dev/null && return 0
    sleep 1
  done
  echo "safaridriver did not start" >&2
  return 1
}

stop_driver() {
  pkill -x safaridriver || true
  pkill -x Safari || true
  sleep 2
}

# Negative fixture: animated and visible normally, completely hidden under reduced motion.
mkdir -p tests/browser/negative
cat > tests/browser/negative/hide.svg <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><style>@media (prefers-reduced-motion:reduce){svg *{display:none}}</style><rect width="200" height="100" fill="#ffffff"/><rect x="20" y="20" width="60" height="40" fill="#2563eb"/><circle r="8" fill="#ef4444"><animateMotion dur="2s" repeatCount="indefinite" path="M20 50 L180 50"/></circle></svg>
EOF

rc=0
run_pass() { # pass-name reduced(0|1)
  local pass="$1" reduced="$2" input name dir code attempt expect_fail shot_pid
  for input in ${SAFARI_INPUTS:-out/fixtures real} negative; do
    name="${input##*/}"
    dir="tests/browser/out-safari/$pass/$name"
    [ -d "tests/browser/$input" ] || { echo "missing tests/browser/$input" >&2; rc=1; continue; }
    expect_fail=0
    [ "$input" = negative ] && [ "$pass" = reduced ] && expect_fail=1
    echo "=== Safari $pass: $input (expect_fail=$expect_fail)"
    mkdir -p "$dir"
    # evidence: what the display itself shows while the session runs (kept only on failure)
    (sleep 12; screencapture -x "$dir/screen.png" || true) &
    shot_pid=$!
    # Exit 3 = blank WebDriver screenshots (an unpainted window): up to 3 attempts in total,
    # each retry with a fresh Safari session; blank attempts are kept in the output directory.
    code=0
    for attempt in 1 2 3; do
      SAFARI_REDUCED="$reduced" INPUT_DIR="tests/browser/$input" \
        SAFARI_T0_DIR="tests/browser/out-safari/motion/$name" \
        OUT_DIR="$dir" GIT_SHA="$(git describe --always --dirty)" \
        node tests/browser/safari.mjs && { code=0; break; } || code=$?
      echo "Safari $pass/$input attempt $attempt exited $code"
      [ "$code" = 3 ] || break
      mkdir -p "$dir/blank-attempt-$attempt"
      cp "$dir"/*.png "$dir/blank-attempt-$attempt/" 2>/dev/null || true
      stop_driver
      start_driver || break
    done
    if [ "$expect_fail" = 1 ]; then
      # The negative fixture must fail, and on the content check (not on something incidental).
      if [ "$code" = 1 ] && tr -d '\n' < "$dir/results-safari.json" |
        grep -Eq '"check": "has content[^}]*"status": "fail"'; then
        echo "negative fixture failed as expected"
        code=0
      else
        echo "negative fixture did NOT fail on the content check (exit $code)" >&2
        code=1
      fi
    fi
    [ "$code" = 0 ] || rc=1
    # Desktop screenshots only matter when something failed.
    wait "$shot_pid" 2>/dev/null
    [ "$code" = 0 ] && rm -f "$dir/screen.png"
  done
}

(caffeinate -disu -t 1800 &) # keep the display awake so Safari renders
# Touch the display stack first: without it the Safari window stayed unpainted (blank
# screenshots) on the runner; with it (as in the passing PR #37 run) it rendered.
sw_vers
system_profiler SPDisplaysDataType | head -15 || true
screencapture -x /tmp/screen.png && ls -l /tmp/screen.png || echo "screencapture failed"

set_reduce_motion off || exit 1
start_driver || exit 1
run_pass motion 0
stop_driver

set_reduce_motion on || exit 1
start_driver || exit 1
run_pass reduced 1
stop_driver

set_reduce_motion off || true
exit "$rc"
