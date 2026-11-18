#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash): block host execution of Node/JS tooling and
# package installs; they must run in a container via scripts/pc.
# Best-effort guardrail, not a sandbox. Works on bash 3.2+ (macOS) and bash 5. Deps: bash, jq.
# Any parse problem allows the command (never wedge the session).

DENY=""

# check_cmd <command-string> <depth>: returns 0 and sets DENY if it must be blocked.
check_cmd() {
  local s="$1" depth="$2"
  [ "$depth" -gt 3 ] && return 1
  local -a Q=()
  local sq="'" dq='"' tab=$'\t' nl=$'\n'

  # 1. Remove heredoc bodies (keep the line that opens them).
  local stripped="" line l term="" dash=0
  local re="(^|[^<])<<(-?)[[:space:]]*[${sq}${dq}]?([A-Za-z_][A-Za-z0-9_]*)"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$term" ]; then
      l="$line"
      [ "$dash" = 1 ] && l="${l#"${l%%[!$tab]*}"}"
      [ "$l" = "$term" ] && term=""
      continue
    fi
    stripped="$stripped$line$nl"
    if [[ $line =~ $re ]]; then
      term="${BASH_REMATCH[3]}"
      dash=0
      [ -n "${BASH_REMATCH[2]}" ] && dash=1
    fi
  done <<<"$s"

  # 2. Replace quoted strings with placeholders __Q<n>__ (contents kept in Q).
  local res="" buf="" mode="" i n=${#stripped} c idx
  for ((i = 0; i < n; i++)); do
    c="${stripped:i:1}"
    case "$mode" in
    "")
      case "$c" in
      "\\")
        i=$((i + 1))
        if [ "${stripped:i:1}" = "$nl" ]; then res+=" "; else res+="_"; fi
        ;;
      "$sq")
        mode=s
        buf=""
        ;;
      "$dq")
        mode=d
        buf=""
        ;;
      *) res+="$c" ;;
      esac
      ;;
    s)
      if [ "$c" = "$sq" ]; then
        idx=${#Q[@]}
        Q[idx]="$buf"
        res+="__Q${idx}__"
        mode=""
      else buf+="$c"; fi
      ;;
    d)
      if [ "$c" = "\\" ]; then
        buf+="$c${stripped:i+1:1}"
        i=$((i + 1))
      elif [ "$c" = "$dq" ]; then
        idx=${#Q[@]}
        Q[idx]="$buf"
        res+="__Q${idx}__"
        mode=""
      else buf+="$c"; fi
      ;;
    esac
  done
  if [ -n "$mode" ]; then
    idx=${#Q[@]}
    Q[idx]="$buf"
    res+="__Q${idx}__"
  fi

  # 3. Split into segments.
  local ch
  for ch in '&' ';' '|' '(' ')' '`' '{' '}'; do
    res="${res//"$ch"/$nl}"
  done

  # 4. Inspect each segment.
  local seg k nw word base wrap payload j q rest
  local -a w
  set -f
  while IFS= read -r seg; do
    w=($seg)
    nw=${#w[@]}
    k=0
    wrap=0
    while [ "$k" -lt "$nw" ]; do
      word="${w[k]}"
      if [[ $word =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        k=$((k + 1))
        continue
      fi
      case "$word" in
      sudo | env | command | exec | time | nice | nohup | xargs | '!' | if | then | else | elif | do | while | until)
        wrap=1
        k=$((k + 1))
        continue
        ;;
      -*)
        if [ "$wrap" = 1 ]; then
          k=$((k + 1))
          continue
        fi
        ;;
      esac
      break
    done
    [ "$k" -ge "$nw" ] && continue
    word="${w[k]}"
    if [[ $word =~ ^__Q([0-9]+)__$ ]]; then word="${Q[BASH_REMATCH[1]]}"; fi
    base="${word##*/}"
    case "$base" in
    docker | git | gh | claude | pc) continue ;;
    node | npm | npx | pnpm | pnpx | yarn | corepack | bun | bunx | deno | tsc | tsx | ts-node | tsup | esbuild | vitest | eslint | prettier | changeset)
      DENY="$base"
      return 0
      ;;
    brew)
      case "${w[k + 1]:-}" in install | reinstall | upgrade)
        DENY="brew ${w[k + 1]}"
        return 0
        ;;
      esac
      ;;
    pip | pip3)
      if [ "${w[k + 1]:-}" = install ]; then
        DENY="$base install"
        return 0
      fi
      ;;
    python | python3 | python3.*)
      if [ "${w[k + 1]:-}" = -m ] && [ "${w[k + 2]:-}" = pip ] && [ "${w[k + 3]:-}" = install ]; then
        DENY="pip install"
        return 0
      fi
      ;;
    gem | cargo | go)
      if [ "${w[k + 1]:-}" = install ]; then
        DENY="$base install"
        return 0
      fi
      ;;
    sh | bash | zsh)
      for ((j = k + 1; j < nw; j++)); do
        if [[ ${w[j]} =~ ^-[A-Za-z]*c[A-Za-z]*$ ]]; then
          payload="${w[j + 1]:-}"
          if [[ $payload =~ ^__Q([0-9]+)__$ ]]; then payload="${Q[BASH_REMATCH[1]]}"; fi
          if [ -n "$payload" ] && check_cmd "$payload" $((depth + 1)); then return 0; fi
          break
        fi
      done
      ;;
    eval)
      rest="${w[*]:k+1}"
      for ((j = ${#Q[@]} - 1; j >= 0; j--)); do
        q="${Q[j]}"
        rest="${rest//__Q${j}__/$q}"
      done
      if [ -n "$rest" ] && check_cmd "$rest" $((depth + 1)); then return 0; fi
      ;;
    esac
  done <<<"$res"
  return 1
}

main() {
  command -v jq >/dev/null 2>&1 || exit 0
  local input cmd
  input="$(cat)" || exit 0
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
  [ -z "$cmd" ] && exit 0
  if check_cmd "$cmd" 0; then
    jq -n --arg t "$DENY" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:("Host execution of " + $t + " is blocked in this repo: run it in a container via scripts/pc (see CLAUDE.md).")}}'
  fi
  exit 0
}

main
