#!/usr/bin/env bash
# Does session-catchup-hint.sh point the agent at the producer path THIS host actually uses?
#
# WHY THIS EXISTS. The hook hardcoded the macOS topology in five places: a pgrep for
# "kijito_inbox_monitor.py" (the Linux entry point is `kijito-inbox-monitor`, no .py), a `launchctl`
# restart hint (meaningless under systemd), Monitor templates naming
# ~/.cache/kijito-inbox-monitor/events.<p>.ndjson (the Linux producer writes ~/.kijito-monitor/<p>.jsonl),
# and a duplicate-consumer check keyed on the macOS filename.
#
# ⚠️ ALL FIVE FAIL TOWARD FALSE CALM, WHICH IS WHY NOBODY NOTICED FOR A RELEASE. An agent that obeys
# the hint tails a file that never appears; "no events" then reads exactly like "no mail", with no
# error, forever. Three personas hit this on one Linux seat in one evening (2026-07-31) — one was
# told "producer: DOWN" while it was up, one gave up and hand-built a REST poller.
#
# ⚠️ AND THE SUBTLER ONE THIS ALSO COVERS: the producer check asked a HOST-GLOBAL question
# ("is any producer running?") and printed a PER-PERSONA answer ("your producer is UP"). On a
# multi-persona seat those come apart routinely — a sibling's producer made the hook report green
# for a persona whose events file did not exist.
#
# HOW IT TESTS THE REAL SCRIPT. Process state is the input we must control and cannot fake with
# files, so `pgrep` is shimmed on PATH rather than the script being refactored for testability:
# the shipped script runs BYTE-FOR-BYTE as installed. The shim answers by inspecting the pattern it
# is handed, so the producer probe and the duplicate-consumer probe stay independently controllable.
#
#   bash tests/catchup_topology_test.sh              # run the checks
#   bash tests/catchup_topology_test.sh --mutation   # ALSO prove the checks can fail
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DEFAULT="$REPO/providers/claude/scripts/session-catchup-hint.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed — the hook parses its stdin with jq."; exit 0; }

SHIMDIR="$(mktemp -d)"
# ── THE PRODUCER ITSELF, ON PATH ──────────────────────────────────────────────────────────────────
# Not a stand-in: this execs the producer this repo vendors, which is where the persona->filename rule
# lives. That is the whole point of the parity checks below — if the oracle were a second copy of the
# rule written here, the test could only prove the test agrees with itself, which is exactly the
# mistake that produced row M290 (three hand-written copies, each confident).
cat > "$SHIMDIR/kijito-inbox-monitor" <<SHIM
#!/usr/bin/env bash
exec python3 "$REPO/providers/monitor/kijito_inbox_monitor.py" "\$@"
SHIM
chmod +x "$SHIMDIR/kijito-inbox-monitor"

cat > "$SHIMDIR/pgrep" <<'SHIM'
#!/usr/bin/env bash
# Fake pgrep. The hook probes twice with different patterns; answer each from the environment so a
# test can say "a producer is running but nothing is armed" and other combinations the real host
# cannot be made to reproduce on demand.
pat="$*"
case "$pat" in
  *"tail -n 0 -F"*) [ "${FAKE_ARMED:-0}" = 1 ] && { echo 4242; exit 0; }; exit 1 ;;
  *)
    [ "${FAKE_PRODUCER:-0}" = 1 ] || exit 1
    # ⛔ THE -af FORM MUST CARRY AN ARGV, NOT JUST A PID (assay cert F1). The hook now asks a running
    # producer WHICH persona it covers, and it can only ask by reading the command line. A shim that
    # answers every probe with a bare pid makes "a producer is running" and "a producer is running
    # FOR ME" indistinguishable — which is exactly the conflation that let a stale stream file report
    # UP. FAKE_PRODUCER_PERSONA says who the running producer actually covers; unset means "nobody in
    # particular", i.e. a sibling's.
    case "$pat" in
      *-af*|*-a\ *)
        _who=${FAKE_PRODUCER_PERSONA:-someone-else}
        echo "1111 /usr/bin/python3 /home/u/.local/bin/kijito-inbox-monitor --persona $_who --state-file $HOME/.kijito-monitor/$_who.state --events-file $HOME/.kijito-monitor/$_who.jsonl --heartbeat 900"
        exit 0 ;;
      *) echo 1111; exit 0 ;;
    esac ;;
esac
SHIM
chmod 0755 "$SHIMDIR/pgrep"
trap 'rm -rf "$SHIMDIR"' EXIT

# Run the hook with a synthetic HOME + project. Echoes its combined output.
# $1=hook  $2=HOME  $3=project dir  (FAKE_PRODUCER / FAKE_ARMED come from the caller's env)
run_hook() {
  printf '{"source":"startup","cwd":"%s"}' "$3" \
    | PATH="$SHIMDIR:$PATH" HOME="$2" CLAUDE_PROJECT_DIR="$3" bash "$1" 2>/dev/null
}

# Build a synthetic seat. $1=layout (linux|mac|none), $2=persona, $3=create events file? (yes|no)
# Echoes the HOME path.
make_home() {
  local layout="$1" persona="$2" mkev="$3" h
  h="$(mktemp -d)"
  case "$layout" in
    linux) mkdir -p "$h/.kijito-monitor"
           [ "$mkev" = yes ] && : > "$h/.kijito-monitor/$persona.jsonl" ;;
    mac)   mkdir -p "$h/.cache/kijito-inbox-monitor"
           [ "$mkev" = yes ] && : > "$h/.cache/kijito-inbox-monitor/events.$persona.ndjson" ;;
  esac
  echo "$h"
}
make_proj() { local p; p="$(mktemp -d)"; echo "$1" > "$p/.kijito_persona"; echo "$p"; }

# All assertions for one hook build. Return 0 if every one held.
check_hook() {
  local hook="$1" label="$2" bad=0 out h proj
  proj="$(make_proj river)"

  # ---- A: Linux seat, this persona's producer running and its events file present ----
  h="$(make_home linux river yes)"
  out="$(FAKE_PRODUCER=1 FAKE_ARMED=0 run_hook "$hook" "$h" "$proj")"
  if grep -q "$h/.kijito-monitor/river.jsonl" <<<"$out"; then
    grn "$label: linux seat → Monitor template names the .kijito-monitor/<p>.jsonl path"
  else red "$label: linux seat → template does not name the Linux events path"; bad=1; fi
  if grep -q "producer: UP for 'river'" <<<"$out"; then
    grn "$label: linux seat → producer reported UP for the persona"
  else red "$label: linux seat → producer not reported UP"; bad=1; fi
  # A Mac path leaking into a Linux seat's instructions is the original defect verbatim.
  if grep -q ".cache/kijito-inbox-monitor" <<<"$out"; then
    red "$label: linux seat → macOS events path still present in the agent-facing output"; bad=1
  else grn "$label: linux seat → no macOS path in the agent-facing output"; fi
  if grep -q "launchctl" <<<"$out"; then
    red "$label: linux seat → launchctl hint offered on a systemd host"; bad=1
  else grn "$label: linux seat → no launchctl hint"; fi
  rm -rf "$h"

  # ---- B: a producer runs, but NOT for this persona (no events file) ----
  # The multi-persona case. A host-global check calls this UP and sends the agent to tail a file
  # that will never exist — the exact false-calm failure, and the one hardest to notice.
  h="$(make_home linux river no)"
  out="$(FAKE_PRODUCER=1 FAKE_ARMED=0 run_hook "$hook" "$h" "$proj")"
  if grep -q "NOT for 'river'" <<<"$out"; then
    grn "$label: sibling-only producer → reported as NOT covering this persona"
  else red "$label: sibling-only producer → wrongly reported as covering this persona"; bad=1; fi
  rm -rf "$h"

  # ---- C: no producer at all, Linux seat → systemd restart hint ----
  h="$(make_home linux river no)"
  out="$(FAKE_PRODUCER=0 FAKE_ARMED=0 run_hook "$hook" "$h" "$proj")"
  if grep -q "producer: DOWN" <<<"$out" && grep -q "systemctl --user enable --now kijito-inbox-monitor@river" <<<"$out"; then
    grn "$label: no producer on linux → DOWN with a systemd restart hint"
  else red "$label: no producer on linux → missing DOWN or systemd hint"; bad=1; fi
  rm -rf "$h"

  # ---- S: A STALE STREAM FILE IS NOT A RUNNING PRODUCER (assay cert F1) ----------------------
  # The by-content route resolves the stream by reading the persona each file stamps into its own
  # events. That answers WHICH file, and says nothing about whether anyone is still WRITING it. The
  # first version stopped there and reported UP, and because the path had been found by globbing
  # files that exist, the "a producer is running but NOT for you" branch was unreachable on that
  # route — so a dead inbox reported healthy and nothing could contradict it. Worse than silence.
  #
  # ⚠️ REACHABLE EXACTLY WHERE IT HURTS: the by-content route is what runs on a seat whose producer
  # predates --safe-persona, i.e. every beta seat until kijito-tools ships.
  local ghost_home
  ghost_home="$(mktemp -d)"; mkdir -p "$ghost_home/.kijito-monitor"
  printf '{"event": "heartbeat", "persona": "ghost", "ts": "2026-08-01T00:00:00+00:00"}\n' \
    > "$ghost_home/.kijito-monitor/ghost.jsonl"
  proj2="$(make_proj ghost)"
  # KIJITOMON_BIN points at something that cannot answer --safe-persona, forcing the by-content route.
  out="$(printf '{"source":"startup","cwd":"%s"}' "$proj2" \
        | PATH="$SHIMDIR:$PATH" HOME="$ghost_home" CLAUDE_PROJECT_DIR="$proj2" \
          KIJITOMON_BIN=/bin/false FAKE_PRODUCER=1 FAKE_ARMED=0 \
          bash "$hook" 2>/dev/null)"
  if grep -q "UP for 'ghost'" <<<"$out"; then
    red "$label: stale stream → reported UP with no producer writing it (F1 regression)"; bad=1
  else grn "$label: stale stream → not reported UP"; fi
  if grep -qE "STALE|NOT running for 'ghost'" <<<"$out"; then
    grn "$label: stale stream → named as stale, not as a generic absence"
  else red "$label: stale stream → the verdict does not say the file is stale"; bad=1; fi

  # ...and the CONTROL, without which the check above is satisfied by a script that never says UP:
  # same fixture, but the running producer's argv names THIS persona.
  out="$(printf '{"source":"startup","cwd":"%s"}' "$proj2" \
        | PATH="$SHIMDIR:$PATH" HOME="$ghost_home" CLAUDE_PROJECT_DIR="$proj2" \
          KIJITOMON_BIN=/bin/false FAKE_PRODUCER=1 FAKE_PRODUCER_PERSONA=ghost FAKE_ARMED=0 \
          bash "$hook" 2>/dev/null)"
  if grep -q "UP for 'ghost'" <<<"$out"; then
    grn "$label: live producer for this persona → by-content route still reports UP"
  else red "$label: live producer for this persona → by-content route no longer reports UP"; bad=1; fi
  rm -rf "$ghost_home" "$proj2"

  # ---- P: PERSONA-NAME PARITY (row M290) ----------------------------------------------------
  # The defect: the hook derived the events filename with its own `sed 's/[^A-Za-z0-9._-]/_/g'` while
  # the producer's rule CASEFOLDS and accepts any Unicode alphanumeric. A persona named `Loom` was
  # therefore sent to tail Loom.jsonl while its mail went to loom.jsonl — "not being collected",
  # forever, with no error.
  # ⚠️ WHY THE ASSERTION IS SHAPED AS "== WHAT THE PRODUCER SAYS" AND NOT "== <expected string>":
  # a literal expectation here would be a FOURTH copy of the rule, and would pass happily on the day
  # the producer's rule changes. The producer is asked, every time, for every name.
  # ⚠️ AND WHY THE EVENTS FILE IS CREATED FROM THE PRODUCER'S ANSWER: on macOS the filesystem is
  # case-INSENSITIVE, so a test that merely asked "did the hook find a file?" would pass on a Mac
  # even with the bug present. These check the STRING the agent is told to tail.
  local name safe evf
  for name in "river" "Loom" "UPPER" "Claude-Chat" "name (purpose)" "spaced name" "a/b" "café" "Ωmega"; do
    safe="$(PATH="$SHIMDIR:$PATH" kijito-inbox-monitor --safe-persona "$name" 2>/dev/null)"
    if [ -z "$safe" ]; then
      red "$label: parity → the producer would not answer --safe-persona for '$name'"; bad=1; continue
    fi
    h="$(mktemp -d)"; mkdir -p "$h/.kijito-monitor"
    evf="$h/.kijito-monitor/$safe.jsonl"
    : > "$evf"
    proj2="$(make_proj "$name")"
    out="$(FAKE_PRODUCER=1 FAKE_ARMED=0 run_hook "$hook" "$h" "$proj2")"
    if grep -qF "$evf" <<<"$out"; then
      grn "$label: parity → '$name' → the hook names the producer's own path ($safe)"
    else
      red "$label: parity → '$name' → hook does NOT name $evf (the producer's path)"; bad=1
    fi
    rm -rf "$h" "$proj2"
  done

  # ---- D: macOS seat still works — this is a portability fix, not a platform swap ----
  # ⚠️ Without this direction, deleting the Mac branch entirely would pass every other check while
  # breaking every existing user. The fix must be additive.
  h="$(make_home mac river yes)"
  out="$(FAKE_PRODUCER=1 FAKE_ARMED=0 run_hook "$hook" "$h" "$proj")"
  if grep -q "$h/.cache/kijito-inbox-monitor/events.river.ndjson" <<<"$out"; then
    grn "$label: mac seat → Monitor template still names the events.<p>.ndjson path"
  else red "$label: mac seat → macOS layout regressed"; bad=1; fi
  if grep -q "launchctl kickstart" <<<"$out" || grep -q "producer: UP" <<<"$out"; then
    grn "$label: mac seat → launchd vocabulary retained"
  else red "$label: mac seat → launchd hint lost"; bad=1; fi
  rm -rf "$h"

  # ---- E: duplicate-consumer detection fires on a Linux seat ----
  # This branch was DEAD on Linux: its pattern could only match the macOS filename, so a returning
  # session was always told to arm again — re-creating the duplicate-monitor bug the branch exists
  # to prevent, on exactly the hosts where nobody was watching for it.
  h="$(make_home linux river yes)"
  out="$(FAKE_PRODUCER=1 FAKE_ARMED=1 run_hook "$hook" "$h" "$proj")"
  if grep -q "do NOT blindly add another" <<<"$out"; then
    grn "$label: linux seat → existing consumer detected (no duplicate-arm advice)"
  else red "$label: linux seat → duplicate-consumer detection did not fire"; bad=1; fi
  rm -rf "$h" "$proj"

  return $bad
}

echo "catch-up hook topology checks:"
check_hook "$HOOK_DEFAULT" "hook"

# --- mutation: prove the checks can fail --------------------------------------------------------
# Restore the ORIGINAL hardcoded macOS topology in a copy and require the checks to fail. This
# mutates toward the real shipped defect rather than toward an invented one, so a green mutation
# line means "these checks would have caught 0.1.2", not merely "these checks can fail somehow".
if [ "${1:-}" = "--mutation" ]; then
  echo
  echo "mutation (hook with the hardcoded macOS topology MUST fail the checks above):"
  mut="$(mktemp -d)/session-catchup-hint.sh"
  mkdir -p "$(dirname "$mut")"
  sed -e 's|_events="\$_lnx_events"; _sup="systemd"|_events="$_mac_events"; _sup="launchd"|g' \
      "$HOOK_DEFAULT" > "$mut"
  if ! grep -q '_events="\$_mac_events"; _sup="launchd"' "$mut"; then
    red "mutation did not apply — the sed no longer matches, so this direction proves nothing"
  else
    # The mutant's deliberate failures must not reach the suite tally; take the verdict from the
    # return code and restore the counters. (The first draft of the sibling install-mode test got
    # this wrong and reported "failed: 3" on a fully-green run.)
    _p=$pass; _f=$fail
    check_hook "$mut" "MUTANT" >/dev/null 2>&1; mrc=$?
    pass=$_p; fail=$_f
    if [ "$mrc" -eq 0 ]; then
      red "mutation SURVIVED — the checks pass with the macOS topology forced, so they test nothing"
    else
      grn "mutation killed — the checks fail when the topology is hardcoded to macOS"
    fi
  fi
  rm -rf "$(dirname "$mut")"

  # ── The two row-M290 defects, each restored on its own ─────────────────────────────────────────
  # Restoring them SEPARATELY matters: they produced the same user-visible symptom ("your mail is not
  # being collected") from different causes, and a single combined mutant could be killed by either
  # check while the other silently tested nothing.
  #
  # ⛔ THE MUTATOR VERIFIES ITS OWN MUTANT BEFORE BELIEVING THE KILL. The first version of this block
  # built mutants with `sed` expressions that ERRORED on their own quoting: sed wrote nothing, the
  # empty file differed from the original, every check failed, and all three mutations reported
  # "killed". A mutation harness whose mutant-builder can fail reports a FALSE GREEN in the one
  # direction that matters — it says the checks work when they were never exercised. So a mutant is
  # only accepted if it (a) changed exactly the intended text, (b) still PARSES as a shell script,
  # and (c) actually contains the restored defect.
  mutate_and_expect_red() {   # $1=label  $2=anchor  $3=replacement
    local label="$1" anchor="$2" repl="$3"
    local m; m="$(mktemp -d)/session-catchup-hint.sh"
    mkdir -p "$(dirname "$m")"
    if ! MUT_SRC="$HOOK_DEFAULT" MUT_DST="$m" MUT_A="$anchor" MUT_B="$repl" python3 - <<'PYMUT'
import os, sys
src = open(os.environ["MUT_SRC"], encoding="utf-8").read()
a, b = os.environ["MUT_A"], os.environ["MUT_B"]
if src.count(a) != 1:
    sys.stderr.write("anchor matched %d times\n" % src.count(a)); sys.exit(1)
open(os.environ["MUT_DST"], "w", encoding="utf-8").write(src.replace(a, b, 1))
PYMUT
    then
      red "mutation '$label': the mutant could not be BUILT (anchor missing?) — proves nothing"
      rm -rf "$(dirname "$m")"; return
    fi
    if ! bash -n "$m" 2>/dev/null; then
      red "mutation '$label': the mutant does not PARSE — a broken file fails every check for the wrong reason"
      rm -rf "$(dirname "$m")"; return
    fi
    if ! grep -qF "$repl" "$m"; then
      red "mutation '$label': the restored defect is not present in the mutant"
      rm -rf "$(dirname "$m")"; return
    fi
    local _p=$pass _f=$fail mrc
    check_hook "$m" "MUTANT" >/dev/null 2>&1; mrc=$?
    pass=$_p; fail=$_f
    if [ "$mrc" -eq 0 ]; then
      red "mutation SURVIVED — '$label' passes every check, so the parity checks test nothing"
    else
      grn "mutation killed — '$label'"
    fi
    rm -rf "$(dirname "$m")"
  }

  # (1) the marker read that deleted EVERY space, so `name (purpose)` became `name(purpose)` before
  #     any sanitizer ran — the literal filenames in beta feedback #14/#16.
  mutate_and_expect_red "marker read strips interior spaces" \
    "tr -d '\\r\\n')" \
    "tr -d '[:space:]')"

  # (2) the hand-written sanitizer that neither casefolded nor understood Unicode.
  mutate_and_expect_red "hook re-implements the filename rule (the old sed)" \
    'if [ -n "$_km_bin" ] && _safe=$("$_km_bin" --safe-persona "$_persona" 2>/dev/null) && [ -n "$_safe" ]; then' \
    'if _safe=$(printf "%s" "$_persona" | sed "s/[^A-Za-z0-9._-]/_/g") && [ -n "$_safe" ]; then'
fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
