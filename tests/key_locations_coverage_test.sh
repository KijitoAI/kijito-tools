#!/usr/bin/env bash
# Every key location this repo documents is one `kijito-inbox-monitor --redeem-key` scans (row M488, plan §5.2).
#
# The scanner is tests/key_locations_coverage.py (its docstring says what it checks and why). This runner proves it
# both ways, because a coverage check that passes everything reports green forever:
#   1. the real repo is clean, and the scan found evidence of every kind (paths, variable names, header forms);
#   2. each mutant of the pinned helper lists (a glob dropped, a name filter on the environment rule, a config file
#      dropped from the scan list) turns the real-repo scan red;
#   3. a control fixture of covered and allowlisted locations passes, and each PLANTED undocumented location -
#      a new key path, a key-named file elsewhere in the home directory or in the workspace, a path variable with
#      no known default, a header form with no config row - fails, naming the file;
#   4. the pinned copy is compared with a monitor's source both ways (equal passes; a changed list or a
#      name-filtering environment loop fails), and a monitor without --redeem-key is reported as pending.
# Set M488_MONITOR=<path to a kijito_inbox_monitor.py with --redeem-key> to also compare against that file.
#
#   bash tests/key_locations_coverage_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="$REPO/tests/key_locations_coverage.py"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
scan() { python3 "$SCAN" "$@" 2>&1; echo "rc=$?"; }

echo "key-location coverage checks:"

# 1. the real repo
out=$(scan); rc=${out##*rc=}
if [ "$rc" = 0 ] && ! grep -q '  FAIL ' <<<"$out" \
   && grep -Eq 'scanned: [1-9][0-9]* key-file path mentions, [1-9][0-9]* variable names, [1-9][0-9]* header/env forms' <<<"$out"; then
  grn "the repo's docs, scripts, templates and fixtures document no key location the helper misses ($(grep -o 'scanned: [^;]*' <<<"$out"))"
else red "real repo: rc=$rc
$out"; fi

# 2. mutants of the pinned helper lists, each against the real repo
for m in drop-persona-glob drop-legacy-glob env-name-filter drop-codex-config drop-settings-local; do
  out=$(scan --mutant "$m"); rc=${out##*rc=}
  if [ "$rc" = 1 ] && grep -q '  FAIL ' <<<"$out"; then grn "mutant $m: the real-repo scan goes red ($(grep -c '  FAIL ' <<<"$out") FAIL)"
  else red "mutant $m survived: rc=$rc
$out"; fi
done

# 3. fixtures
mkdir -p "$T/ok"
cat > "$T/ok/README.md" <<'EOF'
Save the key to ~/.config/kijito-inbox-monitor/token (chmod 600), or per persona to
$HOME/.config/kijito-inbox-monitor/token.<persona>; the wider key goes to ~/.config/kijito/api_token.
Legacy: "$HOME/.claude/.kijito_api_token.$PERSONA" and %h/.claude/.kijito_api_token.
Not keys: ~/.config/kijito-inbox-monitor/api_base, ~/.config/kijito-inbox-monitor/hive.x.state,
~/.config/kijito-inbox-monitor/events.x.ndjson and ~/.config/kijito-inbox-monitor/run.lock.
export KIJITO_API_TOKEN=... ; KIJITOMON_TOKEN works too; KIJITO_SERVICE_KEY is read the same way.
claude mcp add kijito --transport http https://api.kijito.ai/mcp/ --header "Authorization: Bearer kjt_x"
In the project's .mcp.json: "headers": { "Authorization": "Bearer ${KIJITO_API_TOKEN}" }
In ~/.claude/settings.json: {"env": {"KIJITO_API_TOKEN": "kjt_x"}}
Codex: http_headers = { "Authorization" = "Bearer kjt_x" }
OpenCode, in opencode.json:
  "headers": { "Authorization": "Bearer kjt_x" }
EOF
out=$(scan --root "$T/ok" --no-min); rc=${out##*rc=}
rows=$(grep 'header-form rows hit:' <<<"$out")
[ "$rc" = 0 ] && [ -n "$rows" ] && ! grep -q '=0' <<<"$rows" \
  && grn "control: covered paths, allowlisted non-key files, any variable name and every table row's form pass" \
  || red "control fixture: rc=$rc (each HEADER_FORMS row must be hit once)
$out"
out=$(scan --root "$T/ok" --no-min --mutant drop-non-key); rc=${out##*rc=}
[ "$rc" = 1 ] && grep -q 'api_base' <<<"$out" && grep -q 'run.lock' <<<"$out" && grep -q 'hive.x.state' <<<"$out" \
  && grn "mutant drop-non-key: without the allowlist the api_base, state and lock files fail (the allowlist is what passes them)" \
  || red "mutant drop-non-key: rc=$rc
$out"
out=$(scan --root "$T/ok" --no-min --mutant env-name-filter); rc=${out##*rc=}
[ "$rc" = 1 ] && grep -q 'KIJITO_SERVICE_KEY' <<<"$out" \
  && grn "mutant env-name-filter: a documented KIJITO_SERVICE_KEY fails once the rule filters by name" \
  || red "mutant env-name-filter on the fixture: rc=$rc
$out"

plant() {  # plant <label> <expected text in the FAIL line> <file content>
  rm -rf "$T/p"; mkdir -p "$T/p/providers/x"; printf '%s\n' "$3" > "$T/p/providers/x/SETUP.md"
  out=$(scan --root "$T/p" --no-min); rc=${out##*rc=}
  if [ "$rc" = 1 ] && grep '  FAIL ' <<<"$out" | grep -q "providers/x/SETUP.md:1" && grep -qF -- "$2" <<<"$out"; then
    grn "planted $1: fails, naming the file"
  else red "planted $1 was NOT caught: rc=$rc
$out"; fi
}
plant "key path under the monitor's config dir" '~/.config/kijito-inbox-monitor/keys/watcher' \
  'Save it to ~/.config/kijito-inbox-monitor/keys/watcher and chmod 600 it.'
plant "key-named file elsewhere in the home dir" '~/.kijito/api_key' 'Put your key in $HOME/.kijito/api_key.'
plant "legacy-looking file the globs miss" '~/.claude/.kijito_token' 'cat ~/.claude/.kijito_token'
plant "key file in the workspace" './kijito_api_token' 'Write the key to ./kijito_api_token in the project.'
plant "path variable with no known default" 'KIJITO_RELAY_TOKEN_FILE' 'Set KIJITO_RELAY_TOKEN_FILE to the key file.'
plant "header form with no config row" 'matches no HEADER_FORMS row' \
  'gemini mcp add kijito https://api.kijito.ai/mcp/ --header "Authorization: Bearer kjt_x"'
plant "key header in an unscanned client config" 'matches no HEADER_FORMS row' \
  'In Zed, add "Authorization": "Bearer kjt_x" under context_servers.'

# 4. the pinned copy against a monitor's source
mk_monitor() {  # mk_monitor <file> <variant>
  python3 - "$SCAN" "$1" "$2" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("klc", sys.argv[1]); k = importlib.util.module_from_spec(spec)
spec.loader.exec_module(k)
out, variant = sys.argv[2], sys.argv[3]
kl = k.KEY_LOCATIONS if variant != "list" else k.KEY_LOCATIONS[:-1]
test = "_KEY_WHOLE.fullmatch(value)" if variant != "name" else 'name.startswith("KIJITO") and _KEY_WHOLE.fullmatch(value)'
src = "" if variant in ("pending", "renamed") else (
    "import re\nKEY_LOCATIONS = %r\nMCP_CONFIGS_HOME = %r\nMCP_CONFIGS_CWD = %r\n_KEY_WHOLE = re.compile(r%r)\n"
    "def scan(environ, add):\n    for name in sorted(environ):\n        value = (environ.get(name) or '').strip()\n"
    "        if %s:\n            add(value, '$' + name)\n"
    % (kl, k.MCP_CONFIGS_HOME, k.MCP_CONFIGS_CWD, k.ENV_VALUE_RE, test))
if variant == "renamed":
    src = "KEY_PLACES = ('.config/kijito-inbox-monitor/token',)\nHELP = '--redeem-key'\n"
open(out, "w").write(src or "x = 1\n")
PY
}
for v in same list name pending renamed; do mk_monitor "$T/mon-$v.py" "$v"; done
out=$(scan --monitor "$T/mon-same.py"); rc=${out##*rc=}
[ "$rc" = 0 ] && grep -q ': match' <<<"$out" && grn "pinned copy vs an equal monitor: match" || red "equal monitor: rc=$rc
$out"
out=$(scan --monitor "$T/mon-list.py"); rc=${out##*rc=}
[ "$rc" = 1 ] && grep -q 'KEY_LOCATIONS in' <<<"$out" && grn "pinned copy vs a monitor with a different KEY_LOCATIONS: FAIL" \
  || red "different KEY_LOCATIONS: rc=$rc
$out"
out=$(scan --monitor "$T/mon-name.py"); rc=${out##*rc=}
[ "$rc" = 1 ] && grep -q 'tests the variable NAME' <<<"$out" \
  && grn "a monitor whose environment loop filters by variable name: FAIL" || red "name-filtering env loop: rc=$rc
$out"
out=$(scan --monitor "$T/mon-pending.py"); rc=${out##*rc=}
[ "$rc" = 0 ] && grep -q ': pending' <<<"$out" && grn "a monitor without --redeem-key: reported pending, not compared" \
  || red "pending monitor: rc=$rc
$out"
out=$(scan --monitor "$T/mon-renamed.py"); rc=${out##*rc=}
[ "$rc" = 1 ] && grn "a monitor with --redeem-key but no readable KEY_LOCATIONS: FAIL (never silently pending)" \
  || red "renamed constant: rc=$rc
$out"
if [ -n "${M488_MONITOR:-}" ]; then
  out=$(scan --monitor "$M488_MONITOR"); rc=${out##*rc=}
  [ "$rc" = 0 ] && grep -q ': match' <<<"$out" && grn "pinned copy matches $M488_MONITOR" || red "vs $M488_MONITOR: rc=$rc
$out"
fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
