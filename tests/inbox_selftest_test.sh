#!/usr/bin/env bash
# Does the install PROVE the wake path, and does it name the hop that broke? (row M304)
#
# WHY THIS EXISTS. The installer used to print ✓ lines and exit 0 having reported only on itself.
# The first external install then failed exactly where nothing was looking: the inbox never armed,
# the first real message woke nobody, and the human had to notice the SILENCE and ask for a
# diagnosis. A wake path that is broken is indistinguishable from a wake path with no mail on it,
# so the only honest end to an install is a known message pushed through it.
#
# ⚠️ WHAT THIS TEST IS CAREFUL ABOUT: it is easy to write a test that proves the installer PRINTS
# something. What matters is the EXIT STATUS and WHICH HOP the verdict names, because those are what
# a script and a new user respectively act on. Both are asserted below against the real scripts, run
# with a synthetic HOME rather than mocked internals.
#
#   bash tests/inbox_selftest_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELFTEST="$REPO/providers/claude/scripts/inbox-selftest.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

echo "inbox self-test checks:"

# 1. the canary must be clean — it is what proves each hop is NAMED, not merely that something broke
out="$("$SELFTEST" --canary 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "CANARY CLEAN"; then
  grn "canary clean (each broken hop is named; WORKING needs all three)"
else
  red "canary did not pass: $out"
fi

# 2. no persona resolvable => COULD NOT MEASURE (2), never a pass.
#    ⛔ This is the distinction the whole row turns on: "I could not test it" must not be reported
#    with the same exit code as "I tested it and it works".
H="$(mktemp -d)"
out="$(HOME="$H" CLAUDE_PROJECT_DIR="$H" "$SELFTEST" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "could not measure"; then
  grn "no persona => exit 2 COULD NOT MEASURE (not a pass, not a failure)"
else
  red "no persona gave rc=$rc, wanted 2 with a could-not-measure line: $out"
fi
rm -rf "$H"

# 3. a persona with no producer at all => NOT WORKING naming the PRODUCER hop, exit non-zero.
H="$(mktemp -d)"
out="$(HOME="$H" "$SELFTEST" --persona nobody-here --timeout 3 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "failing hop: PRODUCER"; then
  grn "no producer => NOT WORKING naming the PRODUCER hop, non-zero"
else
  red "no producer gave rc=$rc without naming the producer hop: $out"
fi

# 4. ⭐ THE INSTALLER'S OWN BEHAVIOUR, end to end, with the real install.sh: a hard wake-path failure
#    must make the INSTALL exit non-zero. This is the regression that matters — an installer that
#    prints the bad verdict and still exits 0 has changed nothing about what automation believes.
out="$(HOME="$H" SELFTEST_PERSONA=nobody-here bash "$REPO/providers/claude/install.sh" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "THE INBOX WAKE PATH IS BROKEN"; then
  grn "install with a broken wake path exits non-zero and says so"
else
  red "install with a broken wake path gave rc=$rc: $(printf '%s' "$out" | tail -5)"
fi

# 5. and the restart line must be printed plainly — the first external install lost its skills to
#    exactly this, and the old wording buried it inside a sentence about something else.
if printf '%s' "$out" | grep -q "RESTART CLAUDE CODE NOW"; then
  grn "the installer says plainly that Claude Code must be restarted"
else
  red "the installer does not state the restart requirement plainly"
fi
rm -rf "$H"

# 6. a READ-ONLY key cannot send the test message (a hive write needs memory.write, Kijito M339). That
#    is COULD NOT MEASURE (2) with the way to finish - never "not working" (river 10985, M312 rerun).
#    M488: the text no longer offers a write key (under key pickup a memory.read+memory.write key is a REST
#    key saved to ~/.config/kijito/api_token, which the monitor never reads); the agent sends the message.
H="$(mktemp -d)"; SH="$(mktemp -d)"
mkdir -p "$H/.kijito-monitor"
printf '{"event": "armed", "persona": "rotester", "cursor": 1}\n' > "$H/.kijito-monitor/rotester.jsonl"
printf 'kjt_readonly' > "$H/.claude_token"; chmod 600 "$H/.claude_token"
cat > "$SH/curl" <<'SHIM'
#!/usr/bin/env bash
# the send is refused for scope; -w '%{http_code}' prints the code, as real curl does without -f
printf '403'; exit 0
SHIM
chmod +x "$SH/curl"
out="$(HOME="$H" KIJITOMON_TOKEN_FILE="$H/.claude_token" KIJITOMON_BIN="$(type -P false)" PATH="$SH:$PATH" \
        "$SELFTEST" --persona rotester --timeout 3 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "cannot SEND" \
   && printf '%s' "$out" | grep -q 'kijito_hive_send(persona="rotester", to="rotester"' \
   && ! printf '%s' "$out" | grep -q 'scopes=' \
   && ! printf '%s' "$out" | grep -q 'kijito_api_key(' \
   && ! printf '%s' "$out" | grep -q "VERDICT: NOT WORKING"; then
  grn "read-only key => exit 2, the agent sends the test message, no write key offered (not NOT WORKING)"
else
  red "read-only key gave rc=$rc: $out"
fi
rm -rf "$H" "$SH"

# 7. the restart line names the supervisor that is INSTALLED. On a Linux box with no kijito unit (and a
#    systemctl that knows none) it must be the one-command start, never launchctl or systemctl
#    (river 10985: this printed launchctl on Linux).
H="$(mktemp -d)"; SH="$(mktemp -d)"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SH/systemctl"; chmod +x "$SH/systemctl"   # knows no units
printf '#!/usr/bin/env bash\nexit 1\n' > "$SH/launchctl"; chmod +x "$SH/launchctl"   # no launchd job (a Mac runner has a real one)
out="$(HOME="$H" PATH="$SH:$PATH" "$SELFTEST" --persona nobody-here --timeout 3 2>&1)"; rc=$?
if printf '%s' "$out" | grep -q "Run: ~/.claude/kijito-inbox-start.sh --persona nobody-here" \
   && ! printf '%s' "$out" | grep -qE "Run: (launchctl|systemctl)"; then
  grn "no supervisor installed => the restart line is kijito-inbox-start.sh (no launchctl/systemctl)"
else
  red "restart line on a supervisor-less Linux box: $(printf '%s' "$out" | grep 'Run:')"
fi
rm -rf "$H" "$SH"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
