#!/usr/bin/env bash
# CI gate: decide whether the engine (tests) must run. Writes engine=true|false to $GITHUB_OUTPUT
# (stdout when unset). Tests run only when code changed since the last green run (or none exists).
#
# Usage: EVENT=.. BASE_SHA=.. HEAD_SHA=.. REPO=.. GH_TOKEN=.. scripts/ci-gate.sh <workflow.yml>...
#   pull_request       diff BASE_SHA...HEAD_SHA
#   workflow_dispatch  always true (manual = run everything)
#   other (push)       diff <newest first-parent commit that is green in EVERY listed workflow>..HEAD_SHA
# Non-code paths (docs, changesets, .github, licences) and version-only bumps never count as code.
# Any error while deciding fails safe to engine=true.
set -euo pipefail

EVENT="${EVENT:-push}"
BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-$(git rev-parse HEAD)}"
REPO="${REPO:-}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"
SCAN_LIMIT=200

emit() {
  echo "gate: engine=$1 ($2)"
  echo "engine=$1" >>"$OUT"
  exit 0
}

# Fail safe: any unexpected error runs the tests.
trap 'echo "gate: error at line $LINENO" >&2; echo "engine=true" >>"$OUT"; exit 0' ERR

# 0 when the path never needs tests by itself.
noncode() {
  case "$1" in
    docs/design/*) return 1 ;;
    docs/* | *.md | .changeset/* | .github/* | LICENSE* | NOTICE | scripts/deploy-docs.sh | scripts/ci-gate.sh) return 0 ;;
  esac
  return 1
}

# Version fields removed, keys sorted. Prints nothing and fails when the file is absent at SHA.
norm_json() { # sha path filter
  git show "$1:$2" | jq -S "$3"
}

# 0 when a path differs only by version fields (or the embedded CLI version string).
version_only() { # from to path
  local from="$1" to="$2" p="$3" filter fv tv
  case "$p" in
    package.json) filter='del(.version)' ;;
    packages/*/package.json)
      case "${p#packages/}" in */*/*) return 1 ;; esac
      filter='del(.version)'
      ;;
    plugin/.claude-plugin/plugin.json) filter='del(.version)' ;;
    .claude-plugin/marketplace.json) filter='del(.plugins[].version)' ;;
    plugin/bin/pcosmo.mjs)
      fv=$(git show "$from:packages/cli/package.json" | jq -r .version)
      tv=$(git show "$to:packages/cli/package.json" | jq -r .version)
      [ -n "$fv" ] && [ -n "$tv" ] || return 1
      # The bundle embeds the CLI package.json as version:"X"; mask exactly that on each side.
      local a b
      a=$(git show "$from:$p" | sed "s/version:\"$(printf %s "$fv" | sed 's/[.]/\\./g')\"/version:\"__PCV__\"/g" | git hash-object --stdin) || return 1
      b=$(git show "$to:$p" | sed "s/version:\"$(printf %s "$tv" | sed 's/[.]/\\./g')\"/version:\"__PCV__\"/g" | git hash-object --stdin) || return 1
      [ "$a" = "$b" ]
      return
      ;;
    *) return 1 ;;
  esac
  fv=$(norm_json "$from" "$p" "$filter" 2>/dev/null) || return 1
  tv=$(norm_json "$to" "$p" "$filter" 2>/dev/null) || return 1
  [ "$fv" = "$tv" ]
}

# Print verdicts; echo engine=true/false via the return code (0 = a code path changed).
diff_has_code() { # from to files
  local from="$1" to="$2" files="$3" f found=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if noncode "$f"; then
      echo "gate:   $f -> non-code"
    elif version_only "$from" "$to" "$f"; then
      echo "gate:   $f -> version-only"
    else
      echo "gate:   $f -> CODE"
      found=0
    fi
  done <<<"$files"
  return $found
}

# Compare from..to; $3 labels the reason.
decide_diff() { # from to why
  local from="$1" to="$2" why="$3" files
  echo "gate: diffing $from -> $to"
  files=$(git diff --name-only --no-renames "$from" "$to") || emit true "git diff failed"
  if diff_has_code "$from" "$to" "$files"; then
    emit true "code changed $why"
  fi
  emit false "no code changed $why"
}

case "$EVENT" in
  workflow_dispatch) emit true "manual run" ;;
  pull_request)
    [ -n "$BASE_SHA" ] || emit true "no base sha"
    base=$(git merge-base "$BASE_SHA" "$HEAD_SHA") || emit true "no merge-base"
    echo "gate: PR base $BASE_SHA merge-base $base head $HEAD_SHA"
    decide_diff "$base" "$HEAD_SHA" "since the PR base"
    ;;
esac

# push / anything else: find the newest first-parent commit green in every listed workflow.
[ "$#" -gt 0 ] || emit true "no workflows given"
[ -n "$REPO" ] || emit true "no REPO"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'echo "gate: error at line $LINENO" >&2; echo "engine=true" >>"$OUT"; rm -rf "$tmp"; exit 0' ERR
for wf in "$@"; do
  gh api "repos/$REPO/actions/workflows/$wf/runs?branch=main&status=success&per_page=100" \
    --jq '.workflow_runs[].head_sha' >"$tmp/$wf.shas" || emit true "API failure for $wf"
  echo "gate: $wf has $(wc -l <"$tmp/$wf.shas" | tr -d ' ') green main runs"
done

green=""
while IFS= read -r c; do
  ok=1
  for wf in "$@"; do
    grep -qx "$c" "$tmp/$wf.shas" || {
      ok=0
      break
    }
  done
  if [ "$ok" = 1 ]; then
    green="$c"
    break
  fi
done < <(git rev-list --first-parent -n "$SCAN_LIMIT" "$HEAD_SHA")

[ -n "$green" ] || emit true "no green commit for this code in the last $SCAN_LIMIT commits"
echo "gate: last green commit $green"
if [ "$green" = "$HEAD_SHA" ]; then
  emit false "head is already green"
fi
decide_diff "$green" "$HEAD_SHA" "since the last green commit"
