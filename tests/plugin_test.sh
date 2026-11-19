#!/usr/bin/env bash
# The Kijito plugin for the Claude app (plugins/kijito) still installs on claude.ai and Cowork, and its
# SessionStart hook never doubles the kijito-tools reminder.
#
# WHY THIS EXISTS. Each check below is a way the plugin breaks on a surface nobody tests by hand:
#   • claude.ai caps a skill description at 200 characters. A longer one is a skill that does not
#     load in chat, and Claude Code accepts it without a word.
#   • A top-level bin/ inside the plugin folder makes claude.ai and Cowork refuse the whole plugin.
#     The REPO root has a bin/ (the npm CLI), which is fine only because the marketplace points at the
#     plugin subfolder, so that pointer is checked too.
#   • The plugin's .mcp.json reaches every person who installs it, so it must carry no header or key.
#   • The hook must stay silent where the kijito-tools hook is installed, and speak everywhere else.
#     Both directions are tested: a hook that never prints passes a "silent" check forever.
#
#   bash tests/plugin_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/plugins/kijito"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

echo "== descriptions: every skill and command has one, on one line, at most 200 characters =="
# Python counts characters, not bytes, which is what the cap is about.
desc_report="$(python3 -I - "$PLUGIN" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
files = sorted(root.glob("skills/*/SKILL.md")) + sorted(root.glob("commands/*.md"))
if not files:
    print("FAIL|no skills or commands found under " + str(root))
for f in files:
    rel = f.relative_to(root)
    lines = f.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        print(f"FAIL|{rel}: no frontmatter"); continue
    try:
        end = lines.index("---", 1)
    except ValueError:
        print(f"FAIL|{rel}: frontmatter is not closed"); continue
    front = lines[1:end]
    desc = [l for l in front if l.startswith("description:")]
    if len(desc) != 1:
        print(f"FAIL|{rel}: expected one description line, found {len(desc)}"); continue
    value = desc[0][len("description:"):].strip()
    # A block scalar (> or |) continues on later lines, so the one-line value would undercount.
    if value[:1] in (">", "|"):
        print(f"FAIL|{rel}: description is a YAML block scalar; keep it on one line"); continue
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    if not value:
        print(f"FAIL|{rel}: description is empty"); continue
    verdict = "ok" if len(value) <= 200 else "FAIL"
    print(f"{verdict}|{rel}: description is {len(value)} characters (cap 200)")
    if f.name == "SKILL.md":
        names = [l[len("name:"):].strip() for l in front if l.startswith("name:")]
        if names and names[0] != f.parent.name:
            print(f"FAIL|{rel}: name '{names[0]}' does not match its folder '{f.parent.name}'")
PY
)"
while IFS='|' read -r verdict msg; do
  [ -n "$verdict" ] || continue
  if [ "$verdict" = ok ]; then grn "$msg"; else red "$msg"; fi
done <<EOF
$desc_report
EOF

echo "== the plugin folder installs on claude.ai and Cowork =="
if [ -e "$PLUGIN/bin" ]; then
  red "plugins/kijito/bin exists: claude.ai and Cowork refuse a plugin with a top-level bin/"
else
  grn "plugins/kijito has no top-level bin/"
fi
python3 -I - "$REPO" <<'PY' && grn "marketplace lists plugin 'kijito' at ./plugins/kijito, and the names agree" \
                                || red "marketplace entry and plugins/kijito/.claude-plugin/plugin.json disagree"
import json, pathlib, sys
repo = pathlib.Path(sys.argv[1])
market = json.loads((repo / ".claude-plugin/marketplace.json").read_text())
manifest = json.loads((repo / "plugins/kijito/.claude-plugin/plugin.json").read_text())
entries = [p for p in market["plugins"] if p["name"] == "kijito"]
assert len(entries) == 1, entries
assert entries[0]["source"] == "./plugins/kijito", entries[0]["source"]
assert manifest["name"] == "kijito", manifest["name"]
PY
python3 -I - "$PLUGIN/.mcp.json" <<'PY' && grn ".mcp.json is one remote http server with no headers or credentials" \
                                         || red ".mcp.json must be a plain http URL with no headers, token or key"
import json, re, sys
raw = open(sys.argv[1]).read()
servers = json.loads(raw)["mcpServers"]
assert list(servers) == ["kijito"], list(servers)
s = servers["kijito"]
assert s == {"type": "http", "url": "https://api.kijito.ai/mcp"}, s
assert not re.search(r"bearer|token|api[_-]?key|authorization|secret", raw, re.I)
PY

echo "== SessionStart hook: silent beside the kijito-tools hook, a reminder everywhere else =="
HOOK="$PLUGIN/hooks/session-start.sh"
grep -q 'hooks/session-start.sh' "$PLUGIN/hooks/hooks.json" \
  && grn "hooks.json runs hooks/session-start.sh" || red "hooks.json does not run hooks/session-start.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
run_hook() {  # $1 = HOME to use; prints stdout, records the exit code in $T/rc
  env -i PATH="$PATH" HOME="$1" sh "$HOOK" > "$T/out" 2> "$T/err"; echo $? > "$T/rc"
}
expect() {  # $1 = label, $2 = silent|speaks
  local rc out; rc=$(cat "$T/rc"); out=$(cat "$T/out")
  [ "$rc" = 0 ] || { red "$1: exit $rc (must always be 0)"; return; }
  [ -s "$T/err" ] && { red "$1: wrote to stderr: $(head -c 200 "$T/err")"; return; }
  if [ "$2" = silent ]; then
    [ -z "$out" ] && grn "$1: silent" || red "$1: printed a second reminder"
  else
    case "$out" in *kijito_startup*kijito-save*) grn "$1: prints the catch-up reminder" ;;
                   *) red "$1: did not print the reminder (got: $(printf '%s' "$out" | head -c 120))" ;; esac
  fi
}
# kijito-tools installed exactly the way providers/claude/install.sh installs it.
mkdir -p "$T/both/.claude"
: > "$T/both/.claude/session-catchup-hint.sh"
printf '{"hooks":{"SessionStart":[{"matcher":"startup|clear|compact","hooks":[{"type":"command","command":"bash %s/.claude/session-catchup-hint.sh"}]}]}}\n' "$T/both" \
  > "$T/both/.claude/settings.json"
run_hook "$T/both";  expect "kijito-tools hook installed" silent
mkdir -p "$T/none";  run_hook "$T/none"; expect "no ~/.claude at all" speaks
mkdir -p "$T/script/.claude"; : > "$T/script/.claude/session-catchup-hint.sh"; echo '{}' > "$T/script/.claude/settings.json"
run_hook "$T/script"; expect "script present but no settings entry (it never runs)" speaks
mkdir -p "$T/entry/.claude"; cp "$T/both/.claude/settings.json" "$T/entry/.claude/settings.json"
run_hook "$T/entry"; expect "settings entry present but the script is missing" speaks
env -i PATH="$PATH" sh "$HOOK" > "$T/out" 2> "$T/err"; echo $? > "$T/rc"
expect "HOME unset" speaks
# The real installer, into a throwaway HOME: the hook must recognise what install.sh actually writes,
# not only this test's picture of it. Skipped (not failed) where jq is missing, since install.sh needs it.
if command -v jq >/dev/null 2>&1; then
  mkdir -p "$T/real"
  if (cd "$T/real" && HOME="$T/real" bash "$REPO/providers/claude/install.sh" >/dev/null 2>&1); then
    run_hook "$T/real"; expect "after the real providers/claude/install.sh" silent
  else
    red "providers/claude/install.sh failed in a throwaway HOME, so the real-install case was not checked"
  fi
else
  echo "  skip  real-installer case: jq is not installed"
fi

echo
echo "plugin_test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
