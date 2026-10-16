#!/usr/bin/env bash
# claude-armed.sh must hand claude the token FILE's key, not a stale inherited KIJITO_API_TOKEN.
#
# WHY THIS EXISTS. The launcher set KIJITO_API_TOKEN from ~/.claude/.kijito_api_token only when the var was
# EMPTY. A pane launched from a long-lived tmux server inherits the server's global env, so after a key
# renewal (which lands in the file) new panes still got the OLD key. Measured on the fleet Mac 2026-10-16:
# the file was renewed 10-13, a pane launched 10-16 carried the old key, due to expire 10-19.
#
# Runs the REAL launcher with a stand-in `claude` that records the token it was given.
#
#   bash tests/armed_token_precedence_test.sh              # run the checks
#   bash tests/armed_token_precedence_test.sh --mutation   # ALSO prove the checks can fail
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARMED_DEFAULT="$REPO/providers/claude/scripts/claude-armed.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/bin" "$T/home/.claude" "$T/proj"
printf '#!/usr/bin/env bash\nprintf "%%s" "${KIJITO_API_TOKEN:-<unset>}" > "%s/got"\n' "$T" > "$T/bin/claude"; chmod +x "$T/bin/claude"
FILE_TOK="kjt_FILEaaaa_0123456789abcdefghijklmnopqrstu"
ENV_TOK="kjt_ENVbbbbb_0123456789abcdefghijklmnopqrstu"
launch() {  # $1 = launcher; rest = extra env. Prints the launcher's stderr; the token claude saw lands in $T/got
  local armed=$1; shift
  : > "$T/got"
  ( cd "$T/proj" && env -u TMUX -u TMUX_PANE -u WTMUX_PANE -u WTMUX_PID -u KIJITO_API_TOKEN -u KIJITO_API_TOKEN_FILE \
      -u KIJITO_API_TOKEN_PREFER_ENV -u KIJITO_REMOTE_CONTROL HOME="$T/home" PATH="$T/bin:$PATH" KIJITO_LC_DIR="$T/lc" \
      KIJITO_HEARTBEAT=0 CLAUDE_PROJECT_DIR="$T/proj" "$@" bash "$armed" 2>&1 >/dev/null )
}

check() {
  local armed=$1 bad=0 err
  printf '%s\n' "$FILE_TOK" > "$T/home/.claude/.kijito_api_token"

  err=$(launch "$armed")
  [ "$(cat "$T/got")" = "$FILE_TOK" ] && grn "no inherited value → the file's key" \
    || { red "no inherited value → got '$(cat "$T/got")'"; bad=1; }

  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK")
  if [ "$(cat "$T/got")" = "$FILE_TOK" ]; then grn "a stale inherited value → the file's key wins"
  else red "a stale inherited value was passed to claude: '$(cat "$T/got" | cut -c1-12)…'"; bad=1; fi
  if grep -q "kjt_ENVbbbbb" <<<"$err" && grep -q "kjt_FILEaaaa" <<<"$err" \
     && ! grep -q "$ENV_TOK" <<<"$err" && ! grep -q "$FILE_TOK" <<<"$err"; then
    grn "the mismatch is announced by prefix, and neither full key is printed"
  else red "mismatch announcement missing, or a full key leaked to stderr: ${err:-<nothing>}"; bad=1; fi

  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK" KIJITO_API_TOKEN_PREFER_ENV=1)
  if [ "$(cat "$T/got")" = "$ENV_TOK" ] && grep -q "PREFER_ENV=1" <<<"$err" \
     && ! grep -q "$ENV_TOK" <<<"$err" && ! grep -q "$FILE_TOK" <<<"$err"; then
    grn "KIJITO_API_TOKEN_PREFER_ENV=1 keeps the inherited value, says so, and prints no full key"
  else red "PREFER_ENV=1 did not keep the inherited value, was silent, or printed a full key"; bad=1; fi

  # The review's gaps (m528-armed-token-review-1): a short non-kjt secret, a Windows-line-ending file,
  # a file that is not one key, an empty file.
  err=$(launch "$armed" KIJITO_API_TOKEN="s3cr3t")
  if [ "$(cat "$T/got")" = "$FILE_TOK" ] && ! grep -q "s3cr3t" <<<"$err" && grep -q "non-kjt value, 6 chars" <<<"$err"; then
    grn "a short non-kjt inherited value is described by length, never printed"
  else red "a short non-kjt value was printed or mishandled: $err"; bad=1; fi
  printf '%s\r\n' "$FILE_TOK" > "$T/home/.claude/.kijito_api_token"
  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK")
  [ "$(cat "$T/got")" = "$FILE_TOK" ] && grn "a CRLF token file yields the bare key" \
    || { red "a CRLF token file passed a stray character: $(od -c "$T/got" | tail -2 | head -1)"; bad=1; }
  printf 'line one\nline two\n' > "$T/home/.claude/.kijito_api_token"
  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK")
  if [ "$(cat "$T/got")" = "$ENV_TOK" ] && grep -q "does not hold a single kjt_ key" <<<"$err"; then
    grn "a file that is not one kjt_ key never displaces a set value"
  else red "a malformed file displaced a working inherited key"; bad=1; fi
  : > "$T/home/.claude/.kijito_api_token"
  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK")
  if [ "$(cat "$T/got")" = "$ENV_TOK" ] && [ -z "$err" ]; then grn "an empty file leaves a set value alone, silently"
  else red "an empty file disturbed a set value: got '$(cut -c1-12 "$T/got")' err '$err'"; bad=1; fi
  printf '%s\n' "$FILE_TOK" > "$T/home/.claude/.kijito_api_token"

  err=$(launch "$armed" KIJITO_API_TOKEN="$FILE_TOK")
  if [ "$(cat "$T/got")" = "$FILE_TOK" ] && ! grep -q "differs" <<<"$err"; then grn "matching values → no warning"
  else red "matching values produced a warning or the wrong key: $err"; bad=1; fi

  rm -f "$T/home/.claude/.kijito_api_token"
  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK")
  if [ "$(cat "$T/got")" = "$ENV_TOK" ] && ! grep -q "differs" <<<"$err"; then grn "no token file → the inherited value is kept, silently"
  else red "no token file → the inherited value was not kept"; bad=1; fi

  printf '%s\n' "$FILE_TOK" > "$T/alt_token"
  err=$(launch "$armed" KIJITO_API_TOKEN="$ENV_TOK" KIJITO_API_TOKEN_FILE="$T/alt_token")
  [ "$(cat "$T/got")" = "$FILE_TOK" ] && grn "KIJITO_API_TOKEN_FILE names the file that wins" \
    || { red "KIJITO_API_TOKEN_FILE was ignored"; bad=1; }
  return $bad
}

echo "claude-armed.sh token precedence (file over a stale inherited value):"
check "$ARMED_DEFAULT"

if [ "${1:-}" = "--mutation" ]; then
  echo
  echo "mutation (the 0.2.18 'only when empty' rule MUST fail the checks above):"
  python3 - "$ARMED_DEFAULT" "$T/armed-old.sh" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
old = ('if [ -z "${KIJITO_API_TOKEN:-}" ] && [ -r "${KIJITO_API_TOKEN_FILE:-$HOME/.claude/.kijito_api_token}" ]; then\n'
       '  export KIJITO_API_TOKEN="$(cat "${KIJITO_API_TOKEN_FILE:-$HOME/.claude/.kijito_api_token}" 2>/dev/null)"\nfi\n')
s2 = re.sub(r'_kjt_shape\(\) \{.*?\nunset _kjt_file; unset -f _kjt_shape _kjt_show\n', lambda m: old, s, flags=re.S)
assert s2 != s, "mutation anchor not found"
open(sys.argv[2], "w").write(s2)
EOF
  cp "$(dirname "$ARMED_DEFAULT")/lifecycle-lib.sh" "$T/" 2>/dev/null
  p0=$pass f0=$fail
  # A mutant that was never written must not read as killed: a missing launcher fails every check.
  if [ ! -s "$T/armed-old.sh" ]; then red "mutation NOT BUILT — its anchor no longer matches claude-armed.sh"
  elif check "$T/armed-old.sh" >/dev/null; then red "mutation SURVIVED — the checks pass on the old rule"
  else pass=$p0; fail=$f0; grn "mutation killed — the old rule fails the checks"; fi
fi

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
