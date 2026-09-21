#!/usr/bin/env bash
# ── THE WARNING WHERE THE READER ACTUALLY IS ─────────────────────────────────────────────────────
# This check's EXIT STATUS is its answer. Pipe it to `tail`/`head`/`grep` and `$?` becomes the
# PIPE's status, not this script's — a NOT WORKING then reads as a pass. Emitted at RUN time on
# STDERR (which does not travel down the pipe) so it still reaches a terminal.
if [ ! -t 1 ]; then
  printf '%s\n' "note: stdout is not a terminal. If you piped this, \$? is the LAST pipeline stage's status, NOT this check's answer. Run it unpiped." >&2
fi

# PROVE THE WAKE PATH, END TO END, BEFORE ANYONE BELIEVES THE INSTALL (row M304).
#
# WHY THIS EXISTS. From Jason's onboarding call with the first external operator: "Inbox didn't arm
# properly on initial install." The installer had printed its ✓ lines and exited 0; the first real
# message did not wake the agent; the HUMAN had to notice the silence, ask for a diagnosis, ask for
# a repair, and only then did the agent think to mail itself as a test. Everything the installer
# measured was true. None of it was the thing that mattered.
#
# ⚠️ THE FAILURE MODE IS SILENCE, WHICH IS WHY "IT INSTALLED FINE" IS NOT EVIDENCE. A wake path that
# is broken looks exactly like a wake path with no mail on it: no error, no log line, nothing to
# notice. The only way to tell them apart is to PUT A KNOWN MESSAGE THROUGH IT and watch each hop.
# That is this script. It is not a status report; it is an experiment with a control.
#
# THE THREE HOPS, each independently observable, each named in the verdict when it is the one that
# broke — because "your inbox isn't working" sends a new user to read all three, and two of them are
# fine:
#   1. PRODUCER   a producer process is running AND it covers THIS persona (not a sibling's).
#   2. STREAM     a message sent to this persona actually LANDS in this persona's event stream.
#   3. CONSUMER   something wake-capable is attached to that stream and would be re-invoked by it.
#
# ⛔ HOP 3 IS THE SESSION'S JOB, NOT THE INSTALLER'S, AND IT IS STILL PART OF THE VERDICT. A fresh
# install legitimately has no consumer yet — no session has armed one. Reporting WORKING at that
# point would be the exact lie this row exists to remove ("the install declared success with a dead
# inbox"), so the verdict says PARTIAL, names the consumer hop, and prints what to run. The install
# is then honestly described: proven as far as your stream file, not yet proven to wake you.
#
# EXIT: 0 WORKING · 1 NOT WORKING or PARTIAL (a hop failed — the verdict names it) · 2 COULD NOT
# MEASURE (no token, no resolvable persona/stream: the check could not be run at all, which is not
# the same as a failure and must never be reported as one).
# ⚠️ RUN IT UNPIPED.
set -eu

PERSONA=""
TIMEOUT=90
DO_SEND=1
CANARY=0
# TWO CALLERS, TWO CONTRACTS, ONE VERDICT FUNCTION (river ruling, 2026-09-21).
# The INSTALL-TIME run legitimately has no consumer — no agent session exists yet — so a missing
# consumer there is PARTIAL with the next step, not a failed install. The AGENT-DRIVEN ONBOARDING
# flow runs this same check AFTER the agent has armed its consumer and must report a machine-readable
# verdict to the server; that caller needs "WORKING means all three hops" with no PARTIAL wording to
# misread. --require-consumer selects the second contract. The HOPS are measured identically either
# way — only what counts as passing changes, which is the only difference that should ever be
# configurable in a check.
REQUIRE_CONSUMER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --persona)  PERSONA="${2:-}"; [ -n "$PERSONA" ] || { echo "ABORT: --persona needs a value" >&2; exit 2; }; shift 2 ;;
    --timeout)  TIMEOUT="${2:-}"; shift 2 ;;
    --no-send)  DO_SEND=0; shift ;;      # observe the hops without putting a message through
    --require-consumer) REQUIRE_CONSUMER=1; shift ;;
    --canary)   CANARY=1; shift ;;
    -h|--help)  sed -n '1,40p' "$0"; exit 0 ;;
    *)          echo "ABORT: unknown option $1" >&2; exit 2 ;;
  esac
done

KIJITO_BASE=${KIJITO_BASE:-https://api.kijito.ai}
# Cloudflare 403s the default python-urllib UA; a named UA is cheap insurance for any client here.
UA=${KIJITOMON_UA:-kijito-inbox-selftest/1.0}

# ── THE VERDICT IS A PURE FUNCTION OF THE THREE HOPS ─────────────────────────────────────────────
# Kept pure so the canary can drive every combination offline, including the ones that are hard to
# stage on a real host. A verdict that could only be produced by the live path would be a verdict
# nobody had ever seen fail.
verdict() {   # $1=producer_ok $2=stream_ok $3=consumer_ok (each 1/0) -> prints, returns 0/1
  _p=$1; _s=$2; _c=$3
  if [ "$_p" = 0 ]; then
    printf '%s\n' "VERDICT: NOT WORKING — failing hop: PRODUCER"
    printf '%s\n' "  Nothing is collecting ${PERSONA:-this persona}'s mail, so no message can reach you."
    printf '%s\n' "  Run: $(restart_hint)"
    return 1
  fi
  if [ "$_s" = 0 ]; then
    printf '%s\n' "VERDICT: NOT WORKING — failing hop: STREAM FILE"
    printf '%s\n' "  A producer is running, but the test message did not appear in this persona's"
    printf '%s\n' "  event stream within ${TIMEOUT}s. The producer may be covering a DIFFERENT persona,"
    printf '%s\n' "  or writing somewhere other than where this check is looking."
    printf '%s\n' "  Run: producer-health.sh --persona ${PERSONA:-<persona>}   (unpiped)"
    return 1
  fi
  if [ "$_c" = 0 ] && [ "$REQUIRE_CONSUMER" = 1 ]; then
    printf '%s\n' "VERDICT: NOT WORKING — failing hop: CONSUMER"
    printf '%s\n' "  Mail reaches the stream, but nothing is READING it, so nothing will wake this"
    printf '%s\n' "  session. --require-consumer was passed, so a missing consumer is a FAILURE here"
    printf '%s\n' "  rather than the expected state of a fresh install."
    printf '%s\n' "  Arm a wake-capable consumer on: ${EVENTS:-<your events file>}"
    return 1
  fi
  if [ "$_c" = 0 ]; then
    printf '%s\n' "VERDICT: PARTIAL — failing hop: CONSUMER"
    printf '%s\n' "  Mail reaches your event stream, but nothing is READING it, so nothing will wake"
    printf '%s\n' "  you. This is the normal state immediately after an install: a session arms the"
    printf '%s\n' "  consumer, the installer cannot. The install is proven as far as your stream file"
    printf '%s\n' "  and NOT yet proven to wake you."
    printf '%s\n' "  In your agent session, arm a wake-capable consumer on:"
    printf '%s\n' "    ${EVENTS:-<your events file>}"
    printf '%s\n' "  then re-run this check. A background \`tail\` that only writes to a file is NOT a"
    printf '%s\n' "  consumer: it captures without re-invoking you, which is indistinguishable from"
    printf '%s\n' "  silence for as long as it lasts."
    return 1
  fi
  printf '%s\n' "VERDICT: WORKING — a message sent to ${PERSONA} reached the stream and a consumer is attached."
  return 0
}

restart_hint() {
  if [ -d "$HOME/.kijito-monitor" ] || command -v systemctl >/dev/null 2>&1; then
    printf 'systemctl --user enable --now kijito-inbox-monitor@%s' "${PERSONA:-<persona>}"
  else
    printf 'launchctl kickstart -k gui/$(id -u)/com.kijito.inbox-monitor'
  fi
}

# ── CANARY: prove each hop is NAMED when it is the one that broke ────────────────────────────────
# ⛔ The point is not that a broken pipe produces SOME error — it is that the verdict points at the
# right hop. A check that said "not working" for all three would pass a naive test and send every
# new user to read all three sections of the docs.
if [ "$CANARY" = 1 ]; then
  fail=0
  PERSONA="canary"; EVENTS="/tmp/canary-events"
  expect() {   # $1=label $2=expected-substring $3..=hop states
    _lbl=$1; _want=$2; shift 2
    out=$(verdict "$@" || true)
    if printf '%s' "$out" | grep -q "$_want"; then
      printf '  ok    %s\n' "$_lbl"
    else
      printf '  FAIL  %s: verdict did not name it\n%s\n' "$_lbl" "$out"; fail=1
    fi
  }
  expect "producer down names PRODUCER"            "failing hop: PRODUCER"     0 0 0
  expect "producer down outranks the later hops"   "failing hop: PRODUCER"     0 1 1
  expect "stream silent names STREAM FILE"         "failing hop: STREAM FILE"  1 0 0
  expect "stream silent outranks the consumer hop" "failing hop: STREAM FILE"  1 0 1
  expect "no consumer names CONSUMER"              "failing hop: CONSUMER"     1 1 0
  expect "no consumer is PARTIAL by default"       "VERDICT: PARTIAL"          1 1 0
  # ...and the SECOND CONTRACT: the same missing hop must read as a flat failure for the caller that
  # has already armed a consumer. Both are asserted, because a mode that silently behaved like the
  # default would be worse than no mode at all — the onboarding flow would report verified=true on a
  # session that cannot be woken.
  REQUIRE_CONSUMER=1
  expect "with --require-consumer it is NOT WORKING" "VERDICT: NOT WORKING"     1 1 0
  expect "and it still names the CONSUMER hop"       "failing hop: CONSUMER"    1 1 0
  if verdict 1 1 1 | grep -q "VERDICT: WORKING"; then
    printf '  ok    --require-consumer still says WORKING when all three are green\n'
  else
    printf '  FAIL  --require-consumer broke the all-green verdict\n'; fail=1
  fi
  REQUIRE_CONSUMER=0
  expect "all three green says WORKING"            "VERDICT: WORKING"          1 1 1
  # ⛔ AND THE DIRECTION THAT MATTERS MOST: WORKING must require ALL THREE. A verdict that said
  # WORKING with a dead hop is the defect this row was opened for, stated exactly.
  for combo in "0 0 0" "0 0 1" "0 1 0" "0 1 1" "1 0 0" "1 0 1" "1 1 0"; do
    # shellcheck disable=SC2086
    if verdict $combo 2>/dev/null | grep -q "VERDICT: WORKING"; then
      printf '  FAIL  a dead hop (%s) still reported WORKING\n' "$combo"; fail=1
    fi
  done
  [ "$fail" = 0 ] && printf '  ok    WORKING is never reported with a dead hop\n'
  # exit codes are part of the contract: a failing verdict must be non-zero, or a caller that tests
  # $? (the installer does) treats a dead inbox as a success.
  if verdict 1 1 0 >/dev/null 2>&1; then printf '  FAIL  a PARTIAL verdict exited 0\n'; fail=1
  else printf '  ok    a failing verdict exits non-zero\n'; fi
  [ "$fail" = 0 ] && { printf '%s\n' "CANARY CLEAN - each broken hop is named, and WORKING needs all three."; exit 0; }
  printf '%s\n' "CANARY FAILED"; exit 2
fi

# ── LIVE PATH ────────────────────────────────────────────────────────────────────────────────────
# Resolve the persona from the same marker the SessionStart hook uses, so the check and the hook can
# never disagree about WHO this seat is.
if [ -z "$PERSONA" ]; then
  for d in "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
    if [ -n "$d" ] && [ -f "$d/.kijito_persona" ]; then
      PERSONA=$(head -n1 "$d/.kijito_persona" | tr -d '\r\n')
      # trim the ENDS only — deleting interior spaces renames the user's persona (row M290).
      PERSONA="${PERSONA#"${PERSONA%%[![:space:]]*}"}"
      PERSONA="${PERSONA%"${PERSONA##*[![:space:]]}"}"
      [ -n "$PERSONA" ] && break
    fi
  done
fi
[ -n "$PERSONA" ] || { echo "COULD NOT MEASURE: no persona (pass --persona, or add a .kijito_persona marker)."; exit 2; }

# The producer publishes the persona->filename rule; asking it is the only way to be sure this check
# looks where the producer writes (row M290 — three hand-written copies had already drifted).
KM_BIN=""
for c in "${KIJITOMON_BIN:-}" "$(command -v kijito-inbox-monitor 2>/dev/null)" \
         "$HOME/.local/bin/kijito-inbox-monitor" "/usr/local/bin/kijito-inbox-monitor"; do
  if [ -n "$c" ] && [ -x "$c" ]; then KM_BIN=$c; break; fi
done
SAFE=""
[ -n "$KM_BIN" ] && SAFE=$("$KM_BIN" --safe-persona "$PERSONA" 2>/dev/null) || true

EVENTS=""
if [ -n "$SAFE" ]; then
  for cand in "$HOME/.kijito-monitor/$SAFE.jsonl" "$HOME/.cache/kijito-inbox-monitor/events.$SAFE.ndjson"; do
    [ -e "$cand" ] && { EVENTS=$cand; break; }
  done
fi
if [ -z "$EVENTS" ] && command -v python3 >/dev/null 2>&1; then
  # Second non-guessing route: the producer stamps every event with the persona it was written for,
  # so the stream itself says whose mail it holds. Evidence, not inference — and it works on a seat
  # whose producer predates --safe-persona.
  EVENTS=$(KJ_WANT="$PERSONA" python3 - <<'PYSCAN' 2>/dev/null || true
import glob, json, os, sys
want = os.environ["KJ_WANT"].casefold(); home = os.path.expanduser("~"); hits = []
for pat in (os.path.join(home, ".kijito-monitor", "*.jsonl"),
            os.path.join(home, ".cache", "kijito-inbox-monitor", "events.*.ndjson")):
    for path in glob.glob(pat):
        try:
            with open(path, "rb") as fh:
                who = json.loads(fh.readline(65536)).get("persona")
        except Exception:
            continue
        if isinstance(who, str) and who.casefold() == want:
            hits.append(path)
if len(hits) == 1:
    sys.stdout.write(hits[0])
PYSCAN
)
fi

printf '%s\n' "kijito inbox self-test [persona=$PERSONA]"

# ── HOP 1: PRODUCER ──────────────────────────────────────────────────────────────────────────────
# ⚠️ "A producer is running" is a HOST-GLOBAL fact; "a producer covers ME" is a per-persona one, and
# on a multi-persona seat they come apart routinely. The second is the one that matters here.
producer_ok=0
if [ -n "$EVENTS" ] && [ -e "$EVENTS" ]; then
  producer_ok=1
  printf '  ok    producer: covers %s (stream: %s)\n' "$PERSONA" "$EVENTS"
elif pgrep -f "kijito_inbox_monitor\.py|bin/kijito-inbox-monitor" >/dev/null 2>&1; then
  printf '  FAIL  producer: a producer is running, but none of it is writing a stream for %s\n' "$PERSONA"
else
  printf '  FAIL  producer: no producer process is running on this host\n'
fi

# ── HOP 2: STREAM ────────────────────────────────────────────────────────────────────────────────
stream_ok=0
if [ "$producer_ok" = 1 ]; then
  if [ "$DO_SEND" = 0 ]; then
    stream_ok=1
    printf '  --    stream: not exercised (--no-send); the verdict below is about the OTHER hops only\n'
  else
    TOKEN=""
    for tf in "${KIJITOMON_TOKEN_FILE:-}" "$HOME/.claude/.kijito_api_token.$PERSONA" \
              "$HOME/.claude/.kijito_api_token" "$HOME/.config/kijito-inbox-monitor/token"; do
      [ -n "$tf" ] && [ -r "$tf" ] && { TOKEN=$(tr -d ' \t\r\n' < "$tf"); break; }
    done
    if [ -z "$TOKEN" ]; then
      printf '  ????  stream: COULD NOT MEASURE - no API token found, so no test message can be sent\n'
      printf '%s\n' "COULD NOT MEASURE: the wake path was not exercised. This is not a pass."
      exit 2
    fi
    before=$(wc -c < "$EVENTS" 2>/dev/null || echo 0)
    stamp="kijito-inbox-selftest $(date -u +%FT%TZ) $$"
    # Send to SELF. A self-addressed message is the only test message that cannot bother anyone else,
    # and it exercises exactly the path a real sender uses.
    if ! curl -fsS -m 20 -A "$UA" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
         -X POST "$KIJITO_BASE/api/send" \
         -d "{\"to\":\"$PERSONA\",\"persona\":\"$PERSONA\",\"content\":\"$stamp — automated install self-test; safe to ignore and to delete.\"}" \
         >/dev/null 2>&1; then
      printf '  ????  stream: COULD NOT MEASURE - the test message could not be SENT (API unreachable or token rejected)\n'
      printf '%s\n' "COULD NOT MEASURE: the wake path was not exercised. This is not a pass."
      exit 2
    fi
    printf '  ..    stream: test message sent; waiting up to %ss for it to appear in the stream\n' "$TIMEOUT"
    waited=0
    while [ "$waited" -lt "$TIMEOUT" ]; do
      now=$(wc -c < "$EVENTS" 2>/dev/null || echo 0)
      if [ "$now" -gt "$before" ] && tail -c $((now - before + 1)) "$EVENTS" 2>/dev/null \
           | grep -q '"event": *"new"'; then
        stream_ok=1; break
      fi
      sleep 3; waited=$((waited + 3))
    done
    if [ "$stream_ok" = 1 ]; then
      printf '  ok    stream: the message reached %s after ~%ss\n' "$EVENTS" "$waited"
    else
      printf '  FAIL  stream: nothing new arrived in %s within %ss\n' "$EVENTS" "$TIMEOUT"
    fi
  fi
fi

# ── HOP 3: CONSUMER ──────────────────────────────────────────────────────────────────────────────
# ⚠️ ANCHOR THE PATTERN. An unanchored pgrep on the events path SELF-MATCHES the producer (its own
# argv contains that path) and reports a consumer where there is none — armed-looking and deaf.
consumer_ok=0
if [ -n "$EVENTS" ]; then
  for p in $(pgrep -f "tail -n 0 -F.*$(basename "$EVENTS")" 2>/dev/null || true); do
    if [ "$(ps -o comm= -p "$p" 2>/dev/null)" = tail ]; then consumer_ok=1; break; fi
  done
fi
if [ "$consumer_ok" = 1 ]; then
  printf '  ok    consumer: a wake-capable consumer is attached to the stream\n'
else
  printf '  FAIL  consumer: nothing is reading the stream\n'
fi

printf '\n'
verdict "$producer_ok" "$stream_ok" "$consumer_ok"
