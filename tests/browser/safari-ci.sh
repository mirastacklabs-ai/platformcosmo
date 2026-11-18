#!/usr/bin/env bash
# Real-Safari passes for CI on macOS (never run this on a machine you use: it changes the
# Accessibility setting and takes over Safari). Input layout, from the browser-check artifact
# downloaded to tests/browser: out/fixtures (generated) and real (CLI renders of the examples).
#   pass 1: Reduce Motion OFF, animation checks, fixtures and real output
#   pass 2: Reduce Motion ON,  static rest-frame checks, fixtures and real output
# Results: tests/browser/out-safari/<pass>/<input>/results-safari.json. Exit 1 if any pass failed.
set -uo pipefail
cd "$(dirname "$0")/../.."

set_reduce_motion() { # on|off: write, then assert the stored value
  local bool expect got
  if [ "$1" = on ]; then bool=true; expect=1; else bool=false; expect=0; fi
  echo "reduceMotion before: $(defaults read com.apple.universalaccess reduceMotion 2>&1 || true)"
  defaults write com.apple.universalaccess reduceMotion -bool "$bool"
  got="$(defaults read com.apple.universalaccess reduceMotion 2>&1 || true)"
  echo "reduceMotion after: $got (expected $expect)"
  [ "$got" = "$expect" ] || { echo "Reduce Motion is not $1" >&2; exit 1; }
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

rc=0
run_pass() { # pass-name reduced(0|1)
  local pass="$1" reduced="$2" input name
  for input in out/fixtures real; do
    name="${input##*/}"
    [ -d "tests/browser/$input" ] || { echo "missing tests/browser/$input" >&2; rc=1; continue; }
    echo "=== Safari $pass: $input"
    SAFARI_REDUCED="$reduced" INPUT_DIR="tests/browser/$input" \
      OUT_DIR="tests/browser/out-safari/$pass/$name" GIT_SHA="$(git describe --always --dirty)" \
      node tests/browser/safari.mjs || rc=1
  done
}

(caffeinate -disu -t 1800 &) # keep the display awake so Safari renders

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
