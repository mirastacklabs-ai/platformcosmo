#!/usr/bin/env bash
# Table-driven test for .claude/hooks/container-only.sh. Needs bash + jq.
# Run: bash scripts/test-container-hook.sh   (HOOK_BASH=/bin/bash to pick the interpreter)
HOOK_BASH="${HOOK_BASH:-bash}"
HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.claude/hooks/container-only.sh"
pass=0
fail=0

run_hook() { # stdin payload -> prints decision (allow|deny)
  local out rc
  out="$("$HOOK_BASH" "$HOOK")"
  rc=$?
  [ "$rc" -ne 0 ] && { echo "exit$rc"; return; }
  if [ -z "$out" ]; then echo allow; else printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision'; fi
}

t() { # expected command
  local want="$1" cmd="$2" got
  got="$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' | run_hook)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL want=%s got=%s: %s\n' "$want" "$got" "$cmd"
  fi
}

nl=$'\n'
for c in 'npm install' 'pnpm i' 'npx tsc' 'node -e 1' 'FOO=1 pnpm test' 'cd x && npm test' \
  'ls | xargs prettier' 'sudo npm i -g x' "bash -c 'npm i'" 'brew install node' 'pip install x' \
  '/usr/local/bin/node x.js' 'echo $(node -v)' 'echo hi; yarn' 'echo `node -v`' \
  "eval 'pnpm i'" 'python3 -m pip install x' 'cargo install x' 'env A=b vitest run' \
  "cat <<EOF${nl}x${nl}EOF${nl}npm i" 'true && (eslint .)' 'time tsc --noEmit' \
  "eval no''de" 'eval "n""pm" i' "eval 'a && npm i'" "echo 'it''s' && npm i" "# don't${nl}npm i" "echo a#b; npm i" \
  "cat <<'PR-BODY'${nl}x${nl}PR-BODY${nl}npm i" "cat <<\\EOF${nl}x${nl}EOF${nl}npm i" \
  "echo '<<EOF'${nl}npm i" 'echo $((1<<2)); npm i' "cat <<< hi; npm i"; do
  t deny "$c"
done

for c in 'scripts/pc run ci' './scripts/pc install' \
  "docker run --rm node:24 sh -c 'corepack enable && pnpm i'" 'git commit -m "fix npm script"' \
  "git commit -F - <<'EOF'${nl}fix: drop npm install${nl}uses node and pnpm${nl}EOF" \
  "git commit -F - <<-EOF${nl}npm install${nl}EOF" \
  'gh pr create --title "chore: pnpm"' 'claude plugin validate . --strict' 'echo node' \
  'grep -r pnpm .' 'jq . package.json' '' 'ls -la' 'bash scripts/test-container-hook.sh' \
  "bash -c 'ls'" 'cat package.json | jq .name' \
  "git commit -m \"\$(cat <<'EOF'${nl}docs: say \"cd x && npm i\" is blocked${nl}EOF${nl})\"" \
  "gh pr create --body \"\$(cat <<'EOF'${nl}odd \" quote, see #12, a \`tick\`${nl}node is great${nl}EOF${nl})\"" \
  '__Q08__ x; echo node' \
  'command -v node' 'command -V pnpm' 'command -v npm >/dev/null || echo missing' \
  "# don't run node${nl}ls" "echo a # node ${nl}ls" \
  "cat <<'PR-BODY'${nl}npm i${nl}PR-BODY" "cat <<\\EOF${nl}npm i${nl}EOF" \
  "cat <<'a.b-c'${nl}node${nl}a.b-c"; do
  t allow "$c"
done

# Malformed / empty input must allow.
for p in '' 'not json' '{}' '{"tool_input":{}}'; do
  got="$(printf '%s' "$p" | run_hook)"
  if [ "$got" = allow ]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL malformed input not allowed: $p ($got)"
  fi
done

echo "container-only hook: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
