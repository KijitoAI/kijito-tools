#!/usr/bin/env bash
# SessionStart hook → (1) ALWAYS print a passive catch-up reminder + an EXPLICIT, per-persona
# WAKE-CAPABLE inbox-arming instruction, (2) ARMED auto-send if this pane is armed.
#
# Why the explicit arming block (an unmonitored mailbox is useless):
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
# The marker read lives in kijito-persona-lib.sh so the status line (row M309) and anything added
# later cannot drift from it the way the filename rule did. Falling back to the inline loop keeps a
# partially-installed ~/.claude working rather than silently resolving no persona at all.
_persona=""
_lib="$(dirname -- "${BASH_SOURCE[0]:-$0}")/kijito-persona-lib.sh"
if [ -r "$_lib" ]; then
  # shellcheck source=/dev/null
  . "$_lib"
  _persona=$(kijito_persona_from_marker "${CLAUDE_PROJECT_DIR:-}" "$hook_cwd" "$PWD" || true)
fi
for d in "${CLAUDE_PROJECT_DIR:-}" "$hook_cwd" "$PWD"; do
  if [ -z "$_persona" ] && [ -n "$d" ] && [ -f "$d/.kijito_persona" ]; then
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
            os.path.join(home, ".cache", "kijito-inbox-monitor", "events.*.ndjson"),
            os.path.join(home, ".local", "state", "kijito-inbox-monitor", "events.*.ndjson")):
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
      # ⛔ A FILE EXISTING IS NOT A PRODUCER RUNNING (assay cert finding F1, 2026-09-21). The first
      # version of this route stopped here and reported "producer: UP for '<persona>'" on the
      # strength of a glob hit. A STALE stream file — a persona whose producer died, or one that
      # moved seats — then manufactured a confident UP, and because the path was found BY GLOBBING
      # EXISTING FILES it could never reach the "a producer is running but NOT for you" branch
      # below: that message was unreachable on this route by construction. The agent would arm a
      # Monitor on a dead file AND be told everything was fine, so nothing would ever contradict it.
      # That is worse than the silence this whole row is about, and it is reachable exactly in the
      # population the row exists for (seats whose producer predates --safe-persona).
      # ⇒ Require EVIDENCE THAT A LIVE PRODUCER COVERS THIS PERSONA, from a running process's own
      # argv. Any one of three suffices, because the supervisors spell it differently:
      #   · the resolved path appears verbatim   (systemd's --events-file <path>)
      #   · --persona <this persona> appears     (a per-persona unit, whatever path spelling)
      #   · --all-personas appears               (one producer covering every persona, incl. ours)
      # A launchd producer passes --events-file-template, so its argv holds the TEMPLATE and not the
      # resolved path — which is precisely why the second and third forms are needed and why
      # matching the path alone would have been a new false-negative to replace the false positive.
      if [ -n "${_found:-}" ]; then
        _live=""
        # ONE rule, shared with kijito-inbox-start.sh (river 10985), and it matches --persona as a WHOLE
        # argument: the inline grep -F below also matched "--persona riverbank" for persona "river".
        if command -v kijito_producer_covers >/dev/null 2>&1; then
          kijito_producer_covers "$_persona" "$_found" && _live=1
        elif command -v pgrep >/dev/null 2>&1; then
          # ⛔ A PROCESS THAT MERELY MENTIONS THE PRODUCER IS NOT THE PRODUCER (assay observation, 2026-09-21:
          # their verification SHELL matched this three times, because its command line contained both the
          # product name and `--persona <p>` — and it then reported UP for a persona with no producer, which
          # is F1's exact symptom arriving through the CHECKER instead of through a stale file). The
          # sibling tool producer-health.sh already guards this by requiring the match to be a PYTHON
          # process; the same rule belongs here, and a checker that can satisfy its own check is worth
          # more caution than its low reachability suggests.
          _live=$(pgrep -af "kijito[-_]inbox[-_]monitor" 2>/dev/null \
                  | grep -E "[Pp]ython|/kijito-inbox-monitor( |$)" \
                  | grep -v -e "[[:space:]]grep[[:space:]]" -e "session-catchup-hint" \
                  | grep -F -e "$_found" -e "--persona $_persona" -e "--all-personas" | head -n1)
        fi
        if [ -n "$_live" ]; then
          _rule=by-content
        else
          _rule=stale-stream
        fi
      fi
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
# The monitor repo's OWN shipped systemd template writes here (XDG state). A third layout, and until row
# M313's follow-up this script did not know it: a user who installed the unit from the monitor README got
# "nothing is collecting your mail" while their producer was writing mail into this file.
_tpl_events="$HOME/.local/state/kijito-inbox-monitor/events.${_safe}.ndjson"
if   [ "$_rule" = by-content ] || [ "$_rule" = stale-stream ]; then
  # The producer's own output named this file. It outranks every derivation below, because it is the
  # only one of them that was written by the process we are asking about.
  # ⚠️ A STALE stream still resolves to THIS path deliberately: it is genuinely this persona's file,
  # it is simply not being written any more. Falling through to the derivations below would be worse
  # than useless here — with no --safe-persona answer they would produce `~/.kijito-monitor/.jsonl`,
  # an empty component that looks like a path and names nothing. The producer line says it is stale;
  # the arming block should still point at the file that will come back when it restarts.
  _events="$_found"
  case "$_events" in *.jsonl|*/.local/state/*) _sup="systemd" ;; *) _sup="launchd" ;; esac
elif [ -n "$_safe" ] && [ -e "$_lnx_events" ]; then _events="$_lnx_events"; _sup="systemd"
elif [ -n "$_safe" ] && [ -e "$_mac_events" ]; then _events="$_mac_events"; _sup="launchd"
elif [ -n "$_safe" ] && [ -e "$_tpl_events" ]; then _events="$_tpl_events"; _sup="systemd"
elif [ -d "$HOME/.kijito-monitor" ]; then          _events="$_lnx_events"; _sup="systemd"
elif [ -d "$HOME/.local/state/kijito-inbox-monitor" ]; then _events="$_tpl_events"; _sup="systemd"
elif [ -d "$HOME/.cache/kijito-inbox-monitor" ]; then _events="$_mac_events"; _sup="launchd"
elif [ -f "$HOME/Library/LaunchAgents/com.kijito.inbox-monitor.plist" ]; then _events="$_mac_events"; _sup="launchd"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then _events="$_mac_events"; _sup="launchd"
else _events="$_lnx_events"; _sup="systemd"; fi
# NATIVE WINDOWS (Git Bash): the stream may sit in the macOS-shaped path, but nothing there is launchd.
# The supervisor is whatever the user registered - in practice a Scheduled Task (praetor, 2026-09-27).
if command -v kijito_host_is_windows >/dev/null 2>&1 && kijito_host_is_windows; then _sup="task"; fi
# The layout above chose the FILE; it must not also choose the SUPERVISOR. Ask what is actually installed
# (river 10985: "producer UP (systemd)" was printed on a box with no systemd at all).
if command -v kijito_supervisor_for >/dev/null 2>&1; then _sup=$(kijito_supervisor_for "${_persona:-}"); fi
# NO SUPERVISOR AND NO STREAM YET (row M418): the only producer this box will get is the one
# kijito-inbox-start.sh starts, and it writes the XDG-state layout (the monitor's own default is stdout).
# The layout fallbacks above would name ~/.kijito-monitor/<p>.jsonl, a systemd path nothing here writes;
# an M312 cold agent checked, found neither systemd nor that file, and refused the whole hint as injected.
if [ "$_sup" = manual ] && [ "$_rule" != by-content ] && [ "$_rule" != stale-stream ] && [ ! -e "$_events" ]; then
  _events="$_tpl_events"
fi
_hint() {
  if command -v kijito_restart_hint >/dev/null 2>&1; then kijito_restart_hint "$_sup" "${1:-<persona>}"
  elif [ "$_sup" = launchd ]; then printf 'launchctl kickstart -k gui/$(id -u)/com.kijito.inbox-monitor'
  else printf 'systemctl --user enable --now kijito-inbox-monitor@%s' "${1:-<persona>}"; fi
}
# The generic (no-marker) branch cannot name a file, so it shows the directory shape instead.
case "$_sup:$_events" in
  launchd:*)            _events_tmpl="\$HOME/.cache/kijito-inbox-monitor/events.<persona>.ndjson" ;;
  *:*/.local/state/*)   _events_tmpl="\$HOME/.local/state/kijito-inbox-monitor/events.<persona>.ndjson" ;;
  *)                    _events_tmpl="\$HOME/.kijito-monitor/<persona>.jsonl" ;;
esac

# Producer health, PER PERSONA — because "a producer is running" and "YOUR mail is being collected"
# are different facts, and on a multi-persona seat they come apart routinely. The old check asked
# the host-global question and printed a per-persona answer.
#
# ⚠️ The pgrep pattern must not match the CONSUMER. On the macOS layout the tail's own path contains
# the string "kijito-inbox-monitor", so a loose pattern reports the producer UP whenever any agent is
# merely tailing — a false green in the one direction that matters. Anchor on how the executable
# appears in a command line, never on the bare product name.
# THREE ANSWERS, NOT TWO: 0 running, 1 not running, 2 COULD NOT MEASURE (no pgrep and no PowerShell -
# e.g. Git Bash on Windows before this lib learned to ask Win32_Process). "Could not look" is never DOWN.
if command -v kijito_producer_running >/dev/null 2>&1; then
  kijito_producer_running; _prc=$?
elif ! command -v pgrep >/dev/null 2>&1; then _prc=2
elif pgrep -f "kijito_inbox_monitor\.py|bin/kijito-inbox-monitor" >/dev/null 2>&1 \
   || pgrep -f "kijito-inbox-monitor .*--persona" >/dev/null 2>&1; then _prc=0
else _prc=1; fi
if [ "$_prc" = 0 ]; then
  if [ -z "$_persona" ]; then
    _prod="inbox-monitor producer: a producer process is running (persona unknown here — no .kijito_persona marker, so this hook cannot tell whether it covers YOUR inbox)."
  elif [ "$_rule" = by-content ]; then
    _prod="inbox-monitor producer: UP for '$_persona' ($_sup; events → $_events — identified from the stream's own persona stamp and confirmed against a running producer's own arguments, because the installed producer could not be asked for the filename rule)."
  elif [ "$_rule" = stale-stream ]; then
    # The most diagnosable state of the lot, and it used to read as UP: the file is there, nothing is
    # writing it. Say that, rather than the generic "not being collected" — a stale file and a missing
    # file need different fixes and a reader cannot tell them apart from the generic wording.
    _prod="inbox-monitor producer: NOT running for '$_persona' — a stream file exists ($_found) but NO running producer names that path, this persona, or --all-personas, so it is STALE and your mail is not being collected. Anything tailing it will wait forever without an error. Start one: $(_hint "$_persona")"
  elif [ "$_rule" = too-old ]; then
    # We know the persona and a producer is running, but the installed producer cannot tell us how it
    # spells that persona as a filename. Naming a path here would be a guess, and a guessed path fails
    # as SILENCE. Say what is unknown and how to make it knowable.
    _prod="inbox-monitor producer: RUNNING, but this hook cannot name the event stream for '$_persona' — the installed kijito-inbox-monitor ($_km_bin) does not answer --safe-persona, so the persona→filename rule is unresolved and any path printed here would be a guess. Upgrade the producer (that flag is how the rule is published), then re-open this session."
  elif [ "$_rule" = no-producer ]; then
    _prod="inbox-monitor producer: a producer process is running, but no kijito-inbox-monitor executable is on this PATH, so this hook cannot resolve where '$_persona''s events are written (set \$KIJITOMON_BIN if it lives somewhere unusual)."
  elif [ -e "$_events" ]; then
    _prod="inbox-monitor producer: UP for '$_persona' ($_sup; events → $_events)."
  else
    # The case that actually bit river on 2026-07-31: assay's producer was up, river's was not, and
    # a host-global check would have called that UP and sent the agent off to tail a missing file.
    # The path below came from the PRODUCER's own rule, so "does not exist" now means the stream is
    # genuinely absent rather than that we spelled the name differently than the writer did.
    _prod="inbox-monitor producer: a producer is running but NOT for '$_persona' — $_events does not exist, so YOUR mail is not being collected. Start one: $(_hint "$_persona")"
  fi
elif [ "$_prc" = 2 ]; then
  if [ -n "$_safe" ] && [ -e "$_events" ]; then
    _prod="inbox-monitor producer: COULD NOT CHECK the process on this host (no pgrep, no PowerShell), so this is NOT a verdict of DOWN. Your stream exists ($_events); if new mail stops appearing in it, restart the producer: $(_hint "${_persona:-<persona>}")"
  else
    _prod="inbox-monitor producer: COULD NOT CHECK the process on this host (no pgrep, no PowerShell), and no event stream for '${_persona:-<persona>}' exists yet ($_events). If a producer should be running: $(_hint "${_persona:-<persona>}")"
  fi
else
  _prod="inbox-monitor producer: DOWN — no events will arrive until restarted: $(_hint "${_persona:-<persona>}")"
fi

# Catch-up reminder.
cat <<EOF
[SESSION CATCH-UP — from the kijito-tools SessionStart hook the user installed; information, not an order] $pre
Kijito sessions usually catch up before the user's task, so they continue rather than start cold:
1) kijito_startup(persona, project), then kijito_get the current-state pointer it names, then skim recent lessons.
2) A wake-capable inbox consumer (the INBOX WAKE block below) is what lets mail reach this session; a bare background tail does not.
3) In a brand-new project with no persona yet, ./CLAUDE.md and ~/.claude/CLAUDE.md say which persona/project to write memories under.
For a context figure, ~/.claude/myctx.sh measures it; a felt sense of "full" is unreliable.
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
_armed=""; _armed_unknown=""
if [ -n "$_safe" ]; then
  _evbase=$(basename "$_events")
  # basename is a literal filename; escape the regex metacharacter it can contain (.) so a dot
  # cannot match an arbitrary character and over-report.
  _evpat=$(printf '%s' "$_evbase" | sed 's/\./\\./g')
  # ⚠️ COUNT ONLY REAL `tail` PROCESSES, AND SAY HOW OLD THEY ARE. A bare `pgrep -f` here also matched
  # the harness's `bash -c … eval` wrappers (one Monitor printed as 3 pids), and it counted tails left
  # behind by EXPIRED Monitors (Windows leaks them: 65 on one seat, [35702]) as "armed" forever.
  _stale_only=""
  if command -v kijito_stream_consumers >/dev/null 2>&1; then
    _clist=$(kijito_stream_consumers "$_events"); _crc=$?
    case $_crc in
      0) _stale_only=1
         while read -r _cp _ca; do
           [ -n "$_cp" ] || continue
           _armed="$_armed$_cp (up $((_ca / 60)) min) "
           [ "$_ca" -le 1800 ] && _stale_only=""
         done <<<"$_clist" ;;
      2) _armed_unknown=1 ;;
    esac
  elif command -v pgrep >/dev/null 2>&1 && ! { command -v kijito_host_is_windows >/dev/null 2>&1 && kijito_host_is_windows; }; then
    _armed=$(pgrep -f "tail -n 0 -F.*${_evpat}" 2>/dev/null | tr '\n' ' ')
  elif command -v kijito_stream_consumed >/dev/null 2>&1; then
    # No pgrep (native Windows): ask the shared probe. It cannot list pids there, only whether one exists.
    kijito_stream_consumed "$_events"; case $? in
      0) _armed="(a native tail.exe process)" ;;
      2) _armed_unknown=1 ;;
    esac
  else _armed_unknown=1; fi
fi

# After /clear or compaction the agent cannot see its own earlier arming result, so a >30-min tail may be
# its OWN persistent Monitor (river's review of 0.2.11). Say so rather than calling every old tail an orphan.
_own_note=""
case "$src" in clear|compact) _own_note=" — and this session was just reset, so one of them may be YOUR OWN pre-reset Monitor, whose result line you can no longer see" ;; esac
# THE >30-MIN NOTE DEPENDS ON THE HOST (river's 0.2.11 release review, MEDIUM-1). Only Windows/Git Bash
# leaks a tail when its Monitor expires ([35702]), so only there is an old tail likely an orphan. On macOS and
# Linux an expired Monitor takes its tail with it: a tail older than 30 min belongs to a PERSISTENT Monitor,
# i.e. somebody's LIVE consumer - measured on the Mac, where this note named vellum's live tail and told a
# new session to kill it. Never advise stopping a tail by pid there. (Built outside the heredoc so the quoted
# "expires in 30m" / "persistent" survive - inside ${var:+...} the double quotes were eaten.)
_stale_note=""
if [ -n "${_stale_only:-}" ]; then
  if command -v kijito_host_is_windows >/dev/null 2>&1 && kijito_host_is_windows; then
    _stale_note='
⚠️ EVERY tail listed is older than 30 min. A Monitor whose arming result read "expires in 30m" cannot own
any of them — on such a session they are LEAKED ORPHANS that wake nobody (Windows/Git Bash does not kill
a tail when its Monitor expires). Only a Monitor whose result read "persistent" can outlive 30 min'"${_own_note}"'.
If you cannot confirm one of yours read "persistent", the safe move is the same either way: stop these BY
PID (kill <pid>), never by pattern, and arm one fresh — you end with exactly one consumer you KNOW wakes you.'
  else
    _stale_note='
Every tail listed is older than 30 min. On this host an expired Monitor takes its tail with it, so each of
these belongs to a "persistent" Monitor: yours, or a sibling session'"'"'s LIVE consumer'"${_own_note}"'.
Do NOT stop any of them unless it is in YOUR OWN task list - stopping a sibling'"'"'s tail silently cuts its
mail. If none is yours, arm one for yourself as above; two consumers on one stream is the lesser fault.'
  fi
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
      Monitor(command="tail -n 0 -F $_events | grep --line-buffered -E '\"event\": ?\"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added|still_unread)\"'", persistent=true)
Dedupe with TaskStop (agent-scoped), NOT \`pkill -f …events…\` (that can kill a sibling's or your own live consumer).$_stale_note $_prod
EOF
elif [ -n "$_safe" ]; then
cat <<EOF

[INBOX WAKE — how mail reaches this session] Mail wakes a session only through a wake-capable
consumer; a bare background \`tail\` is CAPTURE-ONLY (it writes to a file and never re-invokes the
agent). The Monitor TOOL (persistent) streams each event as a live notification. The persona for this
project is "$_persona", and its consumer line is:

  Monitor(command="tail -n 0 -F $_events | grep --line-buffered -E '\"event\": ?\"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added|still_unread)\"'", persistent=true)

First confirm nothing is already monitoring that stream this session (avoid double-arming).${_armed_unknown:+ ⚠️ This hook could NOT check for an existing consumer on this host (no pgrep / PowerShell), so it may be armed already: check your task list before arming.} $_prod
EOF
else
cat <<EOF

[INBOX WAKE — how mail reaches this session] Mail wakes a session only through a wake-capable
consumer; a bare background \`tail\` is CAPTURE-ONLY (it writes to a file and never re-invokes the
agent). The Monitor TOOL (persistent) streams each event as a live notification. With your persona
name in place of <persona>, the consumer line is:

  Monitor(command="tail -n 0 -F $_events_tmpl | grep --line-buffered -E '\"event\": ?\"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added|still_unread)\"'", persistent=true)

(No .kijito_persona marker found in this project — add a one-line \`.kijito_persona\` file with your
persona name in the project root so this resolves automatically next session.) $_prod
EOF
fi

# Armed auto-send (detached so it never blocks startup or pollutes the additionalContext above).
# The pane is tmux's or (native Windows) wtmux's; lc_self_pane answers for both.
_pane=""; command -v lc_self_pane >/dev/null 2>&1 && _pane=$(lc_self_pane 2>/dev/null)
case "$_pane" in wtmux-*|'') ;; *) [ -n "${TMUX:-}" ] || _pane="" ;; esac   # a tmux pane also needs $TMUX, as before
# M437: an armed pane is not enough - the claude that ran this hook must be the pane's OWN interactive
# session. A headless `claude -p` started inside the pane inherits TMUX_PANE and used to autosend the
# catch-up prompt into the live conversation (river, 2026-10-02). 2 = could not tell: behave as before.
_own=0; command -v lc_hook_owns_pane >/dev/null 2>&1 && { lc_hook_owns_pane "$_pane"; _own=$?; }
if [ -n "$_pane" ] && [ "$_own" = 1 ] && lc_is_armed "$_pane"; then
  lc_log HOOK "src=$src autosend=SKIPPED pane=$_pane reason=not-pane-owner (headless -p/--print, or a claude without the pane's tty)"
elif [ -n "$_pane" ] && lc_is_armed "$_pane"; then
  lc_log HOOK "src=$src autosend=ARMED pane=$_pane"
  _autosend="$_kjt_dir/session-autosend.sh"
  [ -f "$_autosend" ] || _autosend="$HOME/.claude/session-autosend.sh"
  nohup bash "$_autosend" "$_pane" >/dev/null 2>&1 &
else
  command -v lc_log >/dev/null 2>&1 && lc_log HOOK "src=$src autosend=skip(not-armed-or-no-tmux) tmux=${TMUX:+y} wtmux=${WTMUX_PANE:+y} pane=${_pane:-none}"
fi
