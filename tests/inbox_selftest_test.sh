#!/usr/bin/env bash
# Does the install PROVE the wake path, and does it name the hop that broke?
#
# WHY THIS EXISTS. An installer that prints ✓ lines and exits 0 has reported only on itself. An
# install can then fail exactly where nothing is looking: the inbox never arms, the first real
# message wakes nobody, and the human has to notice the SILENCE and ask for a diagnosis. A wake path that is broken is indistinguishable from a wake path with no mail on it,
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
#    ⛔ This is the distinction the whole check turns on: "I could not test it" must not be reported
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
#    The inbox add-on must be PRESENT for this to be a broken wake path rather than one never set up
#    (case 4b, below), so a stub monitor stands in for it: installed, but collecting nothing.
STUB="$H/stub-bin"; mkdir -p "$STUB"; printf '#!/bin/sh\nexit 1\n' > "$STUB/kijito-inbox-monitor"; chmod +x "$STUB/kijito-inbox-monitor"
out="$(HOME="$H" KIJITOMON_BIN="$STUB/kijito-inbox-monitor" SELFTEST_PERSONA=nobody-here bash "$REPO/providers/claude/install.sh" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "THE INBOX WAKE PATH IS BROKEN"; then
  grn "install with a broken wake path exits non-zero and says so"
else
  red "install with a broken wake path gave rc=$rc: $(printf '%s' "$out" | tail -5)"
fi
# 4b. the same persona with the inbox add-on NOT on the machine has no wake path to break yet.
#     That is the normal first install; it must not be called broken, and must still say mail will not
#     arrive and name the step that sets the inbox up.
H2="$(mktemp -d)"
out="$(HOME="$H2" SELFTEST_PERSONA=nobody-here bash "$REPO/providers/claude/install.sh" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -q "IS BROKEN" \
   && printf '%s' "$out" | grep -q "Inbox not set up yet for 'nobody-here'" \
   && printf '%s' "$out" | grep -q "kijito-inbox-start.sh --persona nobody-here"; then
  grn "no inbox add-on installed => 'not set up yet' with the next command, exit 0, not 'broken'"
else
  red "no-monitor install gave rc=$rc: $(printf '%s' "$out" | tail -5)"
fi
rm -rf "$H2"

# 5. and the restart line must be printed plainly — a user whose running session cannot see the new
#    skills thinks they are missing, and a restart note buried inside a sentence goes unread.
if printf '%s' "$out" | grep -q "RESTART CLAUDE CODE NOW"; then
  grn "the installer says plainly that Claude Code must be restarted"
else
  red "the installer does not state the restart requirement plainly"
fi
rm -rf "$H"

# 6. a READ-ONLY key cannot send the test message (a hive write needs memory.write). That is COULD NOT
#    MEASURE (2) with the way to finish - never "not working". The text offers no write key (under key
#    pickup a memory.read+memory.write key is a REST key saved to ~/.config/kijito/api_token, which the
#    monitor never reads); the agent sends the message.
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
#    systemctl that knows none) it must be the one-command start, never launchctl or systemctl.
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

# 8. the self-test message is a deliberate note to SELF, so it must carry force:true. Since Kijito M556
#    the service answers a self-send without it with 409 self_send_refused, and the install then reports
#    COULD NOT MEASURE for a wake path that works. The shim behaves like the service and records the body.
H="$(mktemp -d)"; SH="$(mktemp -d)"
mkdir -p "$H/.kijito-monitor"
printf '{"event": "armed", "persona": "selfsend", "cursor": 1}\n' > "$H/.kijito-monitor/selfsend.jsonl"
printf 'kjt_test' > "$H/.claude_token"; chmod 600 "$H/.claude_token"
cat > "$SH/curl" <<SHIM
#!/usr/bin/env bash
printf '%s\\n' "\$@" > "$H/curl-args"
case "\$*" in *'"force":true'*) printf '200' ;; *) printf '409' ;; esac
exit 0
SHIM
chmod +x "$SH/curl"
out="$(HOME="$H" KIJITOMON_TOKEN_FILE="$H/.claude_token" KIJITOMON_BIN="$(type -P false)" PATH="$SH:$PATH" \
        "$SELFTEST" --persona selfsend --timeout 2 2>&1)"; rc=$?
if grep -q '"to":"selfsend","persona":"selfsend","force":true' "$H/curl-args" 2>/dev/null \
   && ! printf '%s' "$out" | grep -q "HTTP 409"; then
  grn "the self-test send to self carries force:true (no 409 self_send_refused)"
else
  red "self-test send without force:true (rc=$rc): $(cat "$H/curl-args" 2>/dev/null | tr '\n' ' ') :: $out"
fi
rm -rf "$H" "$SH"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
