#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash): block host execution of Node/JS tooling and
# package installs; they must run in a container via scripts/pc.
# Best-effort guardrail, not a sandbox. Works on bash 3.2+ (macOS) and bash 5. Deps: bash, jq.
# Any parse problem allows the command (never wedge the session).
#
# Known bypasses (accepted, this is not a sandbox):
#   - command substitution inside double quotes: echo "$(npm i)"  (quoted text is treated as data)
#   - wrapper options that take an argument: nice -n 10 node x.js  (the "10" is taken as the command)
#   - wrappers not in the wrapper list: timeout 5 node x.js, watch node x.js
#   - a # after an escaped space (a\ #x) is treated as a comment start
#   - several heredocs on one line (cat <<A <<B): only the first terminator is honored
#   - (( ... )) arithmetic detection is heuristic and can misfire around << on odd input
#   - indirection: eval "$var", scripts that call node internally, aliases, absolute-path tricks

DENY=""

# find_heredoc <line>: returns 0 and sets HD_TERM/HD_DASH if the line opens a heredoc.
# Ignores << inside quotes, in comments, in here-strings (<<<) and in arithmetic ((a<<b)).
find_heredoc() {
  local s="$1" n=${#1} i c mode="" pre rest open close pd=0 sp=0
  local -a stk=()
  local sq="'" dq='"'
  local re='^(-?)[[:space:]]*(\\|'"$sq"'|'"$dq"')?([A-Za-z0-9_.-]+)'
  for ((i = 0; i < n; i++)); do
    c="${s:i:1}"
    case "$mode" in
    s) [ "$c" = "$sq" ] && mode="" ;;
    d)
      if [ "$c" = "\\" ]; then
        i=$((i + 1))
      elif [ "$c" = "$dq" ]; then
        mode=""
      elif [ "$c" = "$" ] && [ "${s:i+1:1}" = "(" ]; then
        # "$( ... )": command substitution, an unquoted context until the matching ")".
        stk[sp]=$pd
        sp=$((sp + 1))
        pd=0
        mode=""
        i=$((i + 1))
      fi
      ;;
    *)
      case "$c" in
      "(") pd=$((pd + 1)) ;;
      ")")
        if [ "$pd" -gt 0 ]; then
          pd=$((pd - 1))
        elif [ "$sp" -gt 0 ]; then
          sp=$((sp - 1))
          pd=${stk[sp]}
          mode=d
        fi
        ;;
      "\\") i=$((i + 1)) ;;
      "$sq") mode=s ;;
      "$dq") mode=d ;;
      "#")
        if [ "$i" -eq 0 ]; then return 1; fi
        case "${s:i-1:1}" in " " | $'\t' | ";" | "&" | "|" | "(" | ")") return 1 ;; esac
        ;;
      "<")
        if [ "${s:i+1:1}" = "<" ]; then
          if [ "${s:i+2:1}" = "<" ]; then
            i=$((i + 2))
          else
            pre="${s:0:i}"
            open="${pre//[!(]/}"
            close="${pre//[!)]/}"
            if [ "${#open}" -le "${#close}" ] || [[ $pre != *"(("* ]]; then
              rest="${s:i+2}"
              if [[ $rest =~ $re ]]; then
                HD_TERM="${BASH_REMATCH[3]}"
                HD_DASH=0
                [ -n "${BASH_REMATCH[1]}" ] && HD_DASH=1
                return 0
              fi
            fi
            i=$((i + 1))
          fi
        fi
        ;;
      esac
      ;;
    esac
  done
  return 1
}

# check_cmd <command-string> <depth>: returns 0 and sets DENY if it must be blocked.
check_cmd() {
  local s="$1" depth="$2"
  [ "$depth" -gt 3 ] && return 1
  local -a Q=()
  local sq="'" dq='"' tab=$'\t' nl=$'\n'

  # 1. Remove heredoc bodies (keep the line that opens them).
  local stripped="" line l term="" dash=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$term" ]; then
      l="$line"
      [ "$dash" = 1 ] && l="${l#"${l%%[!$tab]*}"}"
      [ "$l" = "$term" ] && term=""
      continue
    fi
    stripped="$stripped$line$nl"
    if find_heredoc "$line"; then
      term="$HD_TERM"
      dash="$HD_DASH"
    fi
  done <<<"$s"

  # 2. Replace quoted strings with placeholders __Q<n>__ (contents kept in Q).
  local res="" buf="" mode="" i n=${#stripped} c idx p
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
      "#")
        # A # that starts a word begins a comment: skip to end of line.
        if [ "$i" -eq 0 ]; then p=" "; else p="${stripped:i-1:1}"; fi
        case "$p" in
        " " | "$tab" | "$nl" | ";" | "&" | "|" | "(" | ")")
          while [ "$i" -lt "$n" ] && [ "${stripped:i:1}" != "$nl" ]; do i=$((i + 1)); done
          res+="$nl"
          ;;
        *) res+="$c" ;;
        esac
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
  local seg k nw word base wrap payload j q rest out
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
      if [ "$word" = command ] && [[ ${w[k + 1]:-} == -[vV] ]]; then
        k=$nw # presence check (command -v X): nothing is executed
        break
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
    if [[ $word =~ ^__Q([0-9]+)__$ ]]; then word="${Q[10#${BASH_REMATCH[1]}]}"; fi
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
          if [[ $payload =~ ^__Q([0-9]+)__$ ]]; then payload="${Q[10#${BASH_REMATCH[1]}]}"; fi
          if [ -n "$payload" ] && check_cmd "$payload" $((depth + 1)); then return 0; fi
          break
        fi
      done
      ;;
    eval)
      rest="${w[*]:k+1}"
      for ((j = ${#Q[@]} - 1; j >= 0; j--)); do
        q="${Q[j]}"
        # Manual replace: ${rest//pat/"$q"} is wrong on bash 3.2 (literal quotes) and
        # bash 5.2 mishandles & in an unquoted replacement, so avoid pattern substitution.
        out=""
        while [[ $rest == *"__Q${j}__"* ]]; do
          out+="${rest%%__Q${j}__*}$q"
          rest="${rest#*__Q${j}__}"
        done
        rest="$out$rest"
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
  # Fast path: no denied word (or install/upgrade verb, or eval) anywhere in the raw command.
  case "$cmd" in
  *node* | *npm* | *npx* | *yarn* | *corepack* | *bun* | *deno* | *tsc* | *tsx* | *tsup* | *esbuild* | *vitest* | *eslint* | *prettier* | *changeset* | *install* | *upgrade* | *eval*) ;;
  *) exit 0 ;;
  esac
  if check_cmd "$cmd" 0; then
    jq -n --arg t "$DENY" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:("Host execution of " + $t + " is blocked in this repo: run it in a container via scripts/pc (see CLAUDE.md).")}}'
  fi
  exit 0
}

main
