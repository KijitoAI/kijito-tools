#!/usr/bin/env bash
# SessionStart hook → (1) ALWAYS print a passive catch-up reminder + an EXPLICIT, per-persona
# WAKE-CAPABLE inbox-arming instruction, (2) ARMED auto-send if this pane is armed.
#
# Why the explicit arming block (Jason fleet-directive, "an unmonitored mailbox is useless"):
# agents fail two ways — they forget to arm, or they arm WRONG. A bare background `tail -F` is
# CAPTURE-ONLY: it writes matching lines to a file and never exits, so the harness never
# re-invokes the agent and mail is silently missed (argus's exact failure, 2026-06-29). The
# wake-capable consumer in Claude Code is the Monitor TOOL (persistent), which streams each event
# as a live notification that interrupts the agent. This hook injects the EXACT Monitor call so
# there is one unambiguous first action.
#
# Resolve the shared lib and sibling scripts NEXT TO THIS SCRIPT so the repo copy is runnable and
# testable in place, falling back to the installed location for a stray single-file copy.
# KIJITO_LC_LIB overrides the lib path.
_kjt_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_kjt_lib="${KIJITO_LC_LIB:-$_kjt_dir/lifecycle-lib.sh}"
[ -f "$_kjt_lib" ] || _kjt_lib="$HOME/.claude/lifecycle-lib.sh"
. "$_kjt_lib" 2>/dev/null

# Read the hook stdin ONCE (both .source and .cwd come from it).
_in=$(cat 2>/dev/null)
src=$(printf '%s' "$_in" | jq -r '.source // "startup"' 2>/dev/null); [ -z "$src" ] && src=startup
hook_cwd=$(printf '%s' "$_in" | jq -r '.cwd // empty' 2>/dev/null)

case "$src" in
  clear)   pre="You just /clear'd — context was intentionally reset to a clean slate." ;;
  compact) pre="Context was just compacted — detail was summarized away; memory is now the source of truth." ;;
  *)       pre="New session." ;;
esac

# ── Resolve THIS project's persona from a .kijito_persona marker (self-describing, travels with
# the project, survives a rename — preferred over parsing CLAUDE.md prose or a central dir->persona
# map that rots). Search order: $CLAUDE_PROJECT_DIR, the hook-reported cwd, $PWD.
#
# ── ASK THE PRODUCER FOR THE FILENAME RULE; NEVER RE-IMPLEMENT IT (row M290) ──────────────────────
# This line used to read `sed 's/[^A-Za-z0-9._-]/_/g'`, described as matching the producer's rule. It
# did not, in two ways that matter: the producer CASEFOLDS (the local filesystem is case-insensitive,
# so it must) and it accepts any UNICODE alphanumeric. So a persona named `Loom` got `Loom.jsonl` here
# and `loom.jsonl` from the producer; `Ωmega` got `_mega` here and `ωmega` there. The hook then told
# the user their mail was "not being collected" and pointed a Monitor at a file that will never exist
# — silence forever, no error (beta feedback #14/#16).
# ⚠️ AND IT WAS INVISIBLE TO EVERYONE WHO TESTED IT ON A MAC: APFS is case-INSENSITIVE, so the `-e`
# probe below SUCCEEDS on the producer's differently-cased file. The bug only exists on Linux, which
# is why it reached a user rather than a reviewer.
# ⇒ The producer publishes the rule as `--safe-persona NAME` (a pure string transform: no token, no
# network, no state file). We ask it. If we CANNOT ask it — no producer installed, or one too old to
# answer — we do NOT fall back to guessing, because a guess is what produced this defect; we say so
# and name the fix. A wrong path here is unfalsifiable by construction: it fails as silence.
_persona=""
for d in "${CLAUDE_PROJECT_DIR:-}" "$hook_cwd" "$PWD"; do
  if [ -n "$d" ] && [ -f "$d/.kijito_persona" ]; then
    # ⛔ TRIM THE ENDS, NEVER THE MIDDLE (row M290). This read was `tr -d '[:space:]'`, which deletes
    # EVERY space in the name: a persona written `name (purpose)` in the marker became `name(purpose)`
    # here and `name_purpose_` as a filename, while the producer — which receives the name with its
    # space intact from the API — wrote `name__purpose_`. THAT is the exact pair of filenames beta
    # feedback #14/#16 reported, and it is a different defect from the sanitizer mismatch beside it:
    # the name was already corrupted BEFORE any sanitizer ran, so fixing only the sanitizer would have
    # left this case broken while looking fixed. A marker file's payload is its first line with the
    # ends trimmed; anything stricter silently renames the user's persona.
    _persona=$(head -n1 "$d/.kijito_persona" | tr -d '\r\n')
    _persona="${_persona#"${_persona%%[![:space:]]*}"}"   # strip leading blanks
    _persona="${_persona%"${_persona##*[![:space:]]}"}"   # strip trailing blanks
    [ -n "$_persona" ] && break
  fi
done
_km_bin=""
for _c in "${KIJITOMON_BIN:-}" "$(command -v kijito-inbox-monitor 2>/dev/null)" \
          "$HOME/.local/bin/kijito-inbox-monitor" "/usr/local/bin/kijito-inbox-monitor"; do
  if [ -n "$_c" ] && [ -x "$_c" ]; then _km_bin=$_c; break; fi
done
_safe=""; _rule=no-producer
if [ -n "$_persona" ]; then
  if [ -n "$_km_bin" ] && _safe=$("$_km_bin" --safe-persona "$_persona" 2>/dev/null) && [ -n "$_safe" ]; then
    _rule=ok
  else
    # ── SECOND NON-GUESSING ROUTE: ASK THE STREAM WHO IT BELONGS TO ─────────────────────────────────
    # No producer on PATH, or one from before --safe-persona existed. The tempting fallback is to
    # re-implement the rule "just for this case" — that is precisely how the three drifted copies got
    # written, so it is the one thing we will not do. Instead we read the producer's OWN OUTPUT: every
    # event line it writes carries the persona it was written for, so the file itself can say whose
    # mail it collects. That is evidence, not inference, and it stays correct no matter how the rule
    # changes. (A brand-new persona with no stream yet simply has no answer here — correctly so: the
    # honest report is then "nothing is collecting your mail", which is the truth.)
    _safe=""; _rule=too-old
    [ -z "$_km_bin" ] && _rule=no-producer
    if command -v python3 >/dev/null 2>&1; then
      _found=$(KJ_PERSONA="$_persona" python3 - <<'PYSCAN' 2>/dev/null
import glob, json, os, sys
want = os.environ["KJ_PERSONA"].casefold()
home = os.path.expanduser("~")
hits = []
for pat in (os.path.join(home, ".kijito-monitor", "*.jsonl"),
            os.path.join(home, ".cache", "kijito-inbox-monitor", "events.*.ndjson")):
    for path in glob.glob(pat):
        try:
            with open(path, "rb") as fh:
                # the FIRST line is enough and is O(1): the producer stamps every event with its
                # persona, and a stream never mixes personas (one owned sink per persona).
                line = fh.readline(65536)
            who = json.loads(line).get("persona")
        except Exception:
            continue
        if isinstance(who, str) and who.casefold() == want:
            hits.append(path)
if len(hits) == 1:
    sys.stdout.write(hits[0])
PYSCAN
)
      if [ -n "${_found:-}" ]; then _rule=by-content; fi
    fi
  fi
fi

# ── Producer topology. THE PRODUCER WRITES A DIFFERENT PATH ON EACH SUPERVISOR, and this script
# used to hardcode the macOS one in all five places it appears. On a Linux seat that meant: a pgrep
# for "kijito_inbox_monitor.py" that can never match the `kijito-inbox-monitor` console script, a
# `launchctl` restart hint that means nothing under systemd, and Monitor templates pointing at
# ~/.cache/kijito-inbox-monitor/events.<p>.ndjson while the producer writes ~/.kijito-monitor/<p>.jsonl.
#
# ⚠️ EVERY ONE OF THOSE FAILS TOWARD FALSE CALM. An agent that obeys the hint tails a file that will
# never exist, and "no events" is indistinguishable from "no mail" — forever, with no error. Measured
# 2026-07-31: three personas hit this on one Linux seat in one evening; one hand-built a REST poller
# instead, and one was told "producer: DOWN" while the producer was up.
#
# DETECT, DON'T FORK ON `uname`. The question is not "what OS is this" but "where does the producer
# on THIS box actually write", so ask the filesystem: an events file that exists is proof, and a
# supervisor definition is the next-best evidence. uname is the last resort, not the first test.
_mac_events="$HOME/.cache/kijito-inbox-monitor/events.${_safe}.ndjson"
_lnx_events="$HOME/.kijito-monitor/${_safe}.jsonl"
if   [ "$_rule" = by-content ]; then
  # The producer's own output named this file. It outranks every derivation below, because it is the
  # only one of them that was written by the process we are asking about.
  _events="$_found"
  case "$_events" in *.jsonl) _sup="systemd" ;; *) _sup="launchd" ;; esac
elif [ -n "$_safe" ] && [ -e "$_lnx_events" ]; then _events="$_lnx_events"; _sup="systemd"
elif [ -n "$_safe" ] && [ -e "$_mac_events" ]; then _events="$_mac_events"; _sup="launchd"
elif [ -d "$HOME/.kijito-monitor" ]; then          _events="$_lnx_events"; _sup="systemd"
elif [ -d "$HOME/.cache/kijito-inbox-monitor" ]; then _events="$_mac_events"; _sup="launchd"
elif [ -f "$HOME/Library/LaunchAgents/com.kijito.inbox-monitor.plist" ]; then _events="$_mac_events"; _sup="launchd"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then _events="$_mac_events"; _sup="launchd"
else _events="$_lnx_events"; _sup="systemd"; fi
# The generic (no-marker) branch cannot name a file, so it shows the directory shape instead.
case "$_sup" in
  launchd) _events_tmpl="\$HOME/.cache/kijito-inbox-monitor/events.<persona>.ndjson" ;;
  *)       _events_tmpl="\$HOME/.kijito-monitor/<persona>.jsonl" ;;
esac

# Producer health, PER PERSONA — because "a producer is running" and "YOUR mail is being collected"
# are different facts, and on a multi-persona seat they come apart routinely. The old check asked
# the host-global question and printed a per-persona answer.
#
# ⚠️ The pgrep pattern must not match the CONSUMER. On the macOS layout the tail's own path contains
# the string "kijito-inbox-monitor", so a loose pattern reports the producer UP whenever any agent is
# merely tailing — a false green in the one direction that matters. Anchor on how the executable
# appears in a command line, never on the bare product name.
if pgrep -f "kijito_inbox_monitor\.py|bin/kijito-inbox-monitor" >/dev/null 2>&1 \
   || pgrep -f "kijito-inbox-monitor .*--persona" >/dev/null 2>&1; then
  if [ -z "$_persona" ]; then
    _prod="inbox-monitor producer: a producer process is running (persona unknown here — no .kijito_persona marker, so this hook cannot tell whether it covers YOUR inbox)."
  elif [ "$_rule" = by-content ]; then
    _prod="inbox-monitor producer: UP for '$_persona' ($_sup; events → $_events — identified from the stream's own persona stamp, because the installed producer could not be asked for the filename rule)."
  elif [ "$_rule" = too-old ]; then
    # We know the persona and a producer is running, but the installed producer cannot tell us how it
    # spells that persona as a filename. Naming a path here would be a guess, and a guessed path fails
    # as SILENCE. Say what is unknown and how to make it knowable.
    _prod="inbox-monitor producer: RUNNING, but this hook cannot name YOUR event stream — the installed kijito-inbox-monitor ($_km_bin) does not answer --safe-persona, so the persona→filename rule is unresolved and any path printed here would be a guess. Upgrade the producer (that flag is how the rule is published), then re-open this session."
  elif [ "$_rule" = no-producer ]; then
    _prod="inbox-monitor producer: a producer process is running, but no kijito-inbox-monitor executable is on this PATH, so this hook cannot resolve where YOUR events are written (set \$KIJITOMON_BIN if it lives somewhere unusual)."
  elif [ -e "$_events" ]; then
    _prod="inbox-monitor producer: UP for '$_persona' ($_sup; events → $_events)."
  else
    # The case that actually bit river on 2026-07-31: assay's producer was up, river's was not, and
    # a host-global check would have called that UP and sent the agent off to tail a missing file.
    # The path below came from the PRODUCER's own rule, so "does not exist" now means the stream is
    # genuinely absent rather than that we spelled the name differently than the writer did.
    _prod="inbox-monitor producer: a producer is running but NOT for '$_persona' — $_events does not exist, so YOUR mail is not being collected. Start one: $(
      [ "$_sup" = launchd ] \
        && printf 'launchctl kickstart -k gui/$(id -u)/com.kijito.inbox-monitor' \
        || printf 'systemctl --user enable --now kijito-inbox-monitor@%s' "$_persona" )"
  fi
else
  _prod="inbox-monitor producer: DOWN — no events will arrive until restarted: $(
    [ "$_sup" = launchd ] \
      && printf 'launchctl kickstart -k gui/$(id -u)/com.kijito.inbox-monitor' \
      || printf 'systemctl --user enable --now kijito-inbox-monitor@%s' "${_persona:-<persona>}" )"
fi

# Catch-up reminder.
cat <<EOF
[SESSION CATCH-UP — do this BEFORE the user's task] $pre Start continuous, not cold:
1) kijito_startup(persona, project) → read the current-state pointer it names (kijito_get) → skim recent lessons.
2) ARM A WAKE-CAPABLE INBOX CONSUMER as your first action (see the INBOX WAKE block below) — do NOT skip it, do NOT use a bare tail.
3) If this is a BRAND-NEW project with NO persona yet: read ./CLAUDE.md + ~/.claude/CLAUDE.md and set your persona/project before writing any memory.
Never pause on a *feeling* of full context — run ~/.claude/myctx.sh for hard data.
EOF

# Inbox-wake arming block — exact, per-persona when the marker resolves, generic otherwise.
# ── Idempotency (fixes the duplicate-monitor bug, river+argus 2026-07-02). The wake consumer is a
# real `tail -n 0 -F …events.<persona>.ndjson` process that SURVIVES /clear + /compact (the session
# continues), so a naive re-arm stacks duplicates that each fire every event. Detect an existing
# consumer and INFORM — the hook can't know ownership (own-pre-clear vs a concurrent same-persona
# sibling vs a leaked orphan; the stream is shared per-persona), so it defers the keep-vs-arm
# decision to the agent's own task list and NEVER recommends a pattern-kill (a broad pkill on the
# stream can kill a live sibling's or your own consumer — proven during argus's testing).
#
# ⚠️ The duplicate-detection pattern has to follow the LAYOUT too. Hardcoding `events\.<p>\.ndjson`
# made this branch dead on every Linux seat: it could never match, so the hook always took the
# "nothing is armed" path and told a returning session to arm again — re-introducing the very
# duplicate-monitor bug this block was written to fix, on exactly the hosts where nobody was
# looking for it. Match on the resolved events file's basename instead.
_armed=""
if [ -n "$_safe" ]; then
  _evbase=$(basename "$_events")
  # basename is a literal filename; escape the regex metacharacter it can contain (.) so a dot
  # cannot match an arbitrary character and over-report.
  _evpat=$(printf '%s' "$_evbase" | sed 's/\./\\./g')
  _armed=$(pgrep -f "tail -n 0 -F.*${_evpat}" 2>/dev/null | tr '\n' ' ')
fi

if [ -n "$_safe" ] && [ -n "$_armed" ]; then
cat <<EOF

[INBOX WAKE — a consumer already tails your stream; do NOT blindly add another] One or more processes
are already tailing $_events (pid(s): $_armed). This is EXPECTED after a /clear or /compact
(your own persistent Monitor survives the reset). The hook can't tell whose it is, so decide from YOUR
task list:
  • You ALREADY have a live persistent inbox Monitor in your task list → keep it, do NOT arm another (a
    2nd double-fires every event — the duplicate bug). If your task list shows MORE than one, TaskStop
    all but one.
  • You have NO inbox Monitor (brand-new session; the tail is a sibling's or a leaked orphan that will
    NOT wake YOU) → arm exactly one for yourself:
      Monitor(command="tail -n 0 -F $_events | grep --line-buffered -E '\"event\": ?\"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added)\"'", persistent=true)
Dedupe with TaskStop (agent-scoped), NOT \`pkill -f …events…\` (that can kill a sibling's or your own live consumer). $_prod
EOF
elif [ -n "$_safe" ]; then
cat <<EOF

[INBOX WAKE — ARM AS YOUR FIRST ACTION, do not skip] An unmonitored mailbox is useless, and a bare
background \`tail\` is CAPTURE-ONLY (it writes to a file and never re-invokes you, so you are NOT
woken). Arm the wake-capable consumer with the Monitor TOOL (persistent) — it streams each event
as a live notification. Your persona for this project is "$_persona":

  Monitor(command="tail -n 0 -F $_events | grep --line-buffered -E '\"event\": ?\"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added)\"'", persistent=true)

First confirm nothing is already monitoring that stream this session (avoid double-arming). $_prod
EOF
else
cat <<EOF

[INBOX WAKE — ARM AS YOUR FIRST ACTION, do not skip] An unmonitored mailbox is useless, and a bare
background \`tail\` is CAPTURE-ONLY (it writes to a file and never re-invokes you, so you are NOT
woken). Arm the wake-capable consumer for YOUR persona with the Monitor TOOL (persistent) — it
streams each event as a live notification. Substitute your persona name for <persona>:

  Monitor(command="tail -n 0 -F $_events_tmpl | grep --line-buffered -E '\"event\": ?\"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added)\"'", persistent=true)

(No .kijito_persona marker found in this project — add a one-line \`.kijito_persona\` file with your
persona name in the project root so this resolves automatically next session.) $_prod
EOF
fi

# Armed auto-send (detached so it never blocks startup or pollutes the additionalContext above).
if command -v lc_is_armed >/dev/null 2>&1 && [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] && lc_is_armed "$TMUX_PANE"; then
  lc_log HOOK "src=$src autosend=ARMED pane=$TMUX_PANE"
  _autosend="$_kjt_dir/session-autosend.sh"
  [ -f "$_autosend" ] || _autosend="$HOME/.claude/session-autosend.sh"
  nohup bash "$_autosend" "$TMUX_PANE" >/dev/null 2>&1 &
else
  command -v lc_log >/dev/null 2>&1 && lc_log HOOK "src=$src autosend=skip(not-armed-or-no-tmux) tmux=${TMUX:+y} pane=${TMUX_PANE:-none}"
fi
