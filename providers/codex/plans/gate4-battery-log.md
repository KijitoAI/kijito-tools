# Gate-4 option-A sandbox battery — execution log

**Protocol:** `gate4-battery-protocol-20260815.md` (v1, §10 order — gate-2 shipped @ 0a440e7,
gate-3 folded). Scoring is BY-EFFECT; every row carries the exact command + timestamped log
excerpt. 2/2 consecutive full green passes required; any finding resets the count.

**Started:** 2026-08-15 ~05:0xZ · **Operator:** codex[vm] · **Main at battery time:** d6f73b6

## Environment as-built

- Sandbox: `/Users/jason/Code/SideProjects/Codex/.qa-tmp/native-wake-probe-20260814/`
  (CODEX_HOME=`codex-home/` — auth staged, workspace trusted; untouched since 08-14 staging)
- Helper under test: `gate4-staging/wake-helper/` (kijito-wake-helper.mjs + ws-uds.mjs,
  `_shared/wake-core.mjs`)
- Producer: session-scoped `kijito-inbox-monitor` child via `--producer-cmd` (gate-3 A shape),
  real persona inbox `codex`
- Pre-battery helper suite: **17/17 green on the Mac AND on Linux** (05:2xZ), after one
  portability fix — see finding E2.

### Environment findings (pre-scoring adaptations, both documented for review)

- **E1 — macOS UDS `sun_path` limit forced a sandbox relocation.** The staged sandbox's
  control-socket path is 125 bytes; macOS caps `sun_path` at ~104, so
  `codex app-server daemon start` never became ready there (measured; a CODEX_HOME symlink
  does not help — codex canonicalizes the home before composing the socket path). Battery
  runs from a byte-identical `cp -a` copy at `/Users/jason/g4-20260815/` (socket path
  78 bytes, daemon starts clean). The staged original is UNTOUCHED and remains the archive
  source of record. Two orphaned startup locks from the failed long-path attempts were
  removed; the stray half-started app-server (pid 2198) was killed before the clean start.
- **E2 — `ps --ppid` is GNU-only; the child-census helper in `integration.test.mjs` died on
  macOS** (its "17/17 pre-battery greens" had been measured on the Linux seat). Fixed to the
  portable `pgrep -P` (exit-1-on-no-match handled as "no children"). Suite re-run: 17/17 on
  BOTH platforms. One-line test-code fix, flagged for argus at gate-4/5 PR time.

## Precondition P0

- [x] daemon started: pid 5912, socket `/Users/jason/g4-20260815/codex-home/app-server-control/app-server-control.sock`, v0.147.0 (packages symlinked per TRANSPORT-NOTES)
- [x] battery thread created via sandbox TUI (tmux session `g4battery`, trust accepted for the copied workspace path); ONE real turn ran to completion (prompt "Reply with exactly the word ready and nothing else." → "• ready" rendered)
- **Thread id: `01a003c2-c99f-7593-8eb0-6c91a25847cf`** (rollout `rollout-2026-08-14T22-51-32-01a003c2-….jsonl` under the sandbox home's sessions/)
- Producer cmd (gate-3 A shape, pinned Mac install): `/opt/homebrew/bin/python3 -u /Users/jason/.local/share/kijito-inbox-monitor/versions/bc91108/kijito_inbox_monitor.py --persona codex --token-file /Users/jason/.claude/.kijito_api_token.codex --poll-seconds 5 --wait 30 --state-file /Users/jason/g4-20260815/rt/producer.state --events-file /Users/jason/g4-20260815/events.jsonl --heartbeat 60`

## Pass 1

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | Happy-path live wake | **GREEN** 05:02Z | probe 7699 (`row1-pass1-scored-heron-3317`): producer `new:7699` → helper `doorbell` 05:02:11.265 → `wake-delivered` 05:02:11.272 (turn 01a003cc). TUI rendered the fixed template (metadata only), woken turn called `kijito_hive_inbox` with the EXACT instructed args (`before_id:7700, limit:1, mark_read:false` peek), returned row id == 7699 verified, operator summary rendered, no other tools invoked. Census 1/1/1. Evidence: `evidence/row1-pass1-pane.txt` + `row1-pass1-helper.ndjson`. (Tool approval prompt answered "allow for session" — TUI policy, outside helper scope.) |
| 2 | Non-attachment detection | **GREEN** 05:04Z | second codex launched with `-c model_reasoning_effort="low"` (own turn run, thread 01a003cd…); helper `arm` against that thread via the daemon sock (separate runtime rt2): stderr `arm-unverified: failed: thread-gone`, **exit 7**, log records the daemon's refusal verbatim (`thread … already has an active writer`). No silent no-op; census unchanged (the one live row-1 helper only). |
| 3a | Producer absent pre-arm | **GREEN** 05:04Z | arm with nonexistent events file + no producer: run child refused PRE-ARM via `fail(4, "producer-stream-absent")` (source line 181), arm wrapper surfaced it loudly (`arm-unverified: failed: producer-stream-absent`, exit 7). |
| 3b | Events file vanish mid-armed | **GREEN** 05:05Z | `rm events.jsonl` under the live arm: helper logged `producer-stream-vanished` (fail(4) path, source line 236), helper-run census → 0, and the IN-SESSION GASP rendered in the TUI: "[KIJITO WAKE HELPER NOTICE] … producer events stream vanished — this session is now catch-up-only". Producer child reaped after its long-poll drain (census 0 at +25s — see census note below). |
| 3c | Producer child SIGKILL, file remains | **GREEN** 05:06Z | fresh arm (pid 9765, child 9766); `kill -9` the child, file left in place: helper logged `producer-child-died {signal:SIGKILL}` within 2s (fail(4), source line 171), exited (census 0), events file still present, TUI gasp: "session producer died (SIGKILL) — this session is now catch-up-only". The silent-tail trap made loud — binding control (assay 7548). |

**Census timing note (measured, 3b):** a SIGTERM'd producer drains its in-flight long-poll
(`--wait 30`) before exiting (gate-3 B-3 behavior) — a post-stop census inside that window
reads a live "orphan" that is actually mid-drain. Count leaks only after the wait window.
| 4 | Shared-filter contract | **GREEN** 05:08Z | non-covered kind: BOTH a synthetic `heartbeat` and the producer's real heartbeat (05:07:49) produced NO nudge. Covered kind: valid synthetic `alert` → `doorbell alert:…` + `wake-delivered` (turn 01a003d2) within 300ms; the woken turn ran the lifecycle/reconcile shape (read-only unread peek, summarized rows 7698/7699 — still unread because row-1's fetch was a mark_read=false peek, as instructed). Filter decisions all from `_shared` `parseEventLine` (helper source: `if (!parsed.event) continue` — no local filter). Incidental validator check: an alert with an INVALID ts (harness's own BSD `date %N` bug) was dropped without wake via `invalid-lifecycle-timestamp` — malformed lines cannot wake. |
| 5 | Lifecycle + double-arm + thread-gone | **GREEN** 05:09Z | 5a second `arm` (same runtime, same thread): stdout `already-armed pid=9856`, exit 0, pgrep census exactly ONE helper — no second helper ever spawned. 5b staged control: TUI quit alone → helper correctly STAYS armed (the thread lives in the daemon, not the TUI client); daemon kill → helper exit `thread-gone {detail: daemon-connection-closed}` (fail(5) path) within seconds, census 0, **pidfile reaped**. No orphan left to fire into dead/reused threads. |
| 6a | Helper SIGTERM gasp | **GREEN** 05:12Z | SIGTERM helper 10926: in-session gasp rendered ("[KIJITO WAKE HELPER NOTICE] stopping on SIGTERM — this session is now catch-up-only"), `helper-exit signal-SIGTERM` logged, **pidfile reaped**. |
| 6b | Helper SIGKILL residue (documented degradation) | **GREEN (residue measured + recorded per [28733] measured-infeasibility clause)** 05:13Z | SIGKILL helper 11053: NO gasp (impossible by construction), no exit log line. Residue measured: (i) stale pidfile REMAINS; (ii) `status` reports `alive:false`, exit 1 — death visible at next status ✓; (iii) next `arm` did NOT false-arm off the stale pidfile — it proceeded, and failed LOUDLY (`producer-child-died` code 2) because the SIGKILL-orphaned producer (11054, ppid 1) still held the state-file lock — producer-stderr captured verbatim ("state-file in use (another watcher holds the lock)"). (iv) After orphan cleanup (SIGTERM + long-poll drain), clean re-arm succeeded (helper 11220, census 1/1). Documented degradation-to-B for SIGKILL only; at no point did the residue present as armed-and-healthy. |
| 7a | Defer-until-idle: composer draft | **GREEN** 05:17Z | draft "DRAFT-SENTINEL row7a…" typed, not submitted (thread idle — a draft is not a turn); probe 7703 delivered promptly; wake turn ran to completion (id verified + summary); pane capture proves the DRAFT SURVIVED UNTOUCHED in the composer after the whole wake turn. No stomp. |
| 7b | Defer-until-idle: mid-turn | **GREEN by-effect, with mechanism note Q1** 05:19Z | probe 7704 sent mid-way through a ~200-line counting turn. Session-visible ordering (scrollback evidence): counting ran to completion ("two hundred / finished", lines 204–407) and ONLY THEN the wake turn rendered (line 410) and completed. No interruption, no stomp, no mid-turn delivery to the user. **Q1 (mechanism, for argus):** the helper's log shows it SUBMITTED the wake 2ms after the doorbell, while the turn was active — its `threadIdle` never went false (no observed `thread/status/changed` for another client's turn at the helper's connection). The user-visible deferral was provided by the daemon's per-thread TURN QUEUE (v0.147 serializes), not by the helper's own defer machinery. By-effect contract met; whether the helper must also defer at its own layer (belt-and-braces against future daemon semantics) is flagged for steward ruling. |
| 8 | Wake-turn contract (by-effect) | **GREEN** (compiled from rows 1/4/7a/7b turns) | every wake turn across the pass used the byte-fixed `_shared` template (prefix `[KIJITO AUTOMATED WAKE V1 - NOT USER AUTHORED]`, metadata only, NO message bodies in the turn text); every woken turn called ONLY `kijito_hive_inbox` with the exact instructed args (`mark_read:false` peek, `before_id`/`limit:1` exact-row for mail kinds; unread peek for the lifecycle/reconcile kind), verified returned id == requested id, summarized for the operator, and invoked no shell/file/web/send/mutation tool. Message bodies rendered only inside UNTRUSTED fences via the tool result, never in the wake text. |

## Pass bookkeeping ruling (argus 7711, 05:23Z)

Pass 1 is **VOIDED as a counting green** — row-7b as scored misattributed its green to a
mechanism that never ran (the helper defer layer). Its by-effect results stay on record as
real. The instrument is fixed by protocol amendment (row-7b v2, leg (a) of the ruling: the
existing synthetic forcing test `busy thread defers; idle notification releases the queued
wake` certifies the defer layer; the battery row now attributes each leg separately and adds
a real-path defer measurement). Pass 2 below runs the FIXED battery (row-7b v2 — the only
amended row — had not yet executed in pass 2 at fix time) and is green-#1 CANDIDATE of the
reset count; one further full green (pass 3) is required after it.

## Pass 2 (fresh sandbox re-arm; fixed battery) — green-#1 candidate

Fresh daemon (pid 11907), fresh TUI session, P0 turn run, thread
`01a003de-115c-7002-bafa-0a7d68c1b339`, fresh runtime+events under `p2/`.

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | Happy-path live wake | **GREEN** 05:21Z | probe 7708 (`row1-pass2-gannet-6614`): doorbell 05:21:59.925 → wake-delivered .934 (9ms), turn 01a003de-ac7d…; TUI render verified (id verified + summary + marker). Fresh-session tool approval granted (session scope) as part of the row. |
| 3a | Producer absent pre-arm | **GREEN** 05:22Z | fresh runtime p2rt3, nonexistent events file: `producer-stream-absent` refusal pre-arm, arm exit 7 (run child fail(4) path). |

(row 2 first attempt at 05:22Z was a PROCEDURAL MISFIRE on the operator's side, recorded
honestly: the pass-1 embedded thread was reused after its session had been killed, so the
arm legitimately SUCCEEDED against an idle rollout-backed thread — not the row-2 scenario.
The stray helper was stopped within seconds, before any mail event, and a LIVE embedded
session was relaunched for the real row-2 run below.)

| 2 | Non-attachment detection | **GREEN** 05:25Z | LIVE embedded session relaunched (`-c` override, own turn, thread 01a003df…); arm against it: `thread-gone` / "already has an active writer", exit 7, census unchanged. |
| 3b | Events vanish mid-armed | **GREEN** 05:25Z | `producer-stream-vanished` + TUI gasp rendered + helper census 0. |
| 3c | Producer SIGKILL, file remains | **GREEN** 05:26Z | `producer-child-died {SIGKILL}` in 2s + TUI gasp + file remains + census 0. |
| 4 | Shared-filter contract | **GREEN** 05:27Z | heartbeat: doorbells 2→2 (no nudge); valid alert → doorbell + wake-delivered 4ms (turn 01a003e3…). |
| 5 | Lifecycle + double-arm + thread-gone | **GREEN** 05:27-28Z | `already-armed pid=13914` exit 0, census 1; daemon kill (exact pid — NOTE the pgrep pattern `g4.*app-server` self-matches the helper's `--sock` argv; killed by known pid) → `thread-gone daemon-connection-closed`, pidfile reaped, census 0. |
| 6a | SIGTERM gasp | **GREEN** 05:33Z (re-run) | first run 05:29Z was invisible-by-operator-error: after row-5's daemon kill the TUI was a ZOMBIE CLIENT of the dead daemon, so the gasp turn ran unseen — recorded, TUI relaunched (new thread 01a003e7, P0 re-run), 6a re-run: gasp RENDERED ("stopping on SIGTERM — catch-up-only") + pidfile reaped. |
| 6b | SIGKILL residue | **GREEN** 05:34-35Z (re-run on live thread) | stale pidfile remains; `status` `alive:false` exit 1; TWO consecutive loud held-lock re-arm refusals while the orphan drained (richer than pass 1 — the residue cannot false-arm even across the drain window); clean re-arm after drain (census 1/1). Operator note: a piped `arm \| tail` hid the real exit code once — evidence taken from the printed refusal text, not `$?` (never read `$?` after a pipe). |
| 7a | Draft no-stomp | **GREEN** 05:36Z | probe 7716 delivered with draft present; draft survived the wake BYTE-INTACT (its later submission was operator keystrokes hitting the composer after the approval dialog — the submitted text matches the original draft exactly, which is itself integrity evidence). |
| 7b | Defer-until-idle (v2, three legs) | **GREEN — defer layer MEASURED on the REAL daemon** 05:38-41Z | **(i) ordering:** counting turn 01a003ed-d15e ran 05:38:32.420 → 05:38:51.025 (rollout `task_complete`); helper doorbell for probe 7723 at 05:38:48.973 (MID-TURN); wake turn 01a003ee-1a16 started 05:38:51.034 — **9ms AFTER task_complete**: the helper DEFERRED mid-turn and the idle transition released it. Scrollback confirms full count render before the wake. **(ii) real-path instrument** (`status-probe.mjs`, one-shot second client): `thread/resume` mid-turn returned `{type:"active"}`, and the daemon delivered `thread/status/changed → idle` to the second client's connection at turn end (05:41:11.484) — the real daemon supplies BOTH inputs the defer layer needs. **(iii) synthetic forcing test** `busy thread defers; idle notification releases the queued wake` green in the same battery's pre-suite (both platforms). Residual variance on record: pass-1's run submitted mid-turn (daemon queue serialized, by-effect still correct) — defer depends on the helper observing the active transition; both layers plus the daemon queue are now measured facts, no cross-attribution. |
| 8 | Wake-turn contract | **GREEN** | all pass-2 wake turns (7708, alert-reconcile, 7716, 7721, 7723) used the fixed template, exact-args read-only peeks, id verification, operator summaries; no shell/file/web/send/mutation tool in any woken turn. |

**Producer version note:** battery producer pinned at `versions/bc91108` throughout; argus
released v0.5.0 fleet-wide mid-pass (his 7721) — battery unaffected (pinned path), recorded
for comparability.

## Pass 3 (second consecutive green of the fixed battery) — 05:44-05:54Z

Fresh daemon (pid 17316), fresh TUI session, P0 turn, thread
`01a003f3-4b05-7460-9fd0-2a93ed8dfad3`, fresh runtime+events under `p3/`. Row 5 executed
LAST (its daemon-kill doubles as teardown; order deviation noted — each row is independent
and census-bracketed). Producer still pinned `bc91108` (argus's v0.5.0 deploy repointed the
supervised producers only; battery instrument unchanged across all passes).

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | Happy path | **GREEN** 05:46Z | probe 7728: doorbell→delivered 5ms (turn 01a003f5…), id verified + summary rendered (curlew-7742). Fresh-session approval granted in-row. |
| 2 | Non-attachment | **GREEN** 05:47Z | live embedded session relaunched (thread 01a003f5-e8c0…): `thread-gone` / "already has an active writer", exit 7. |
| 3a | Absent pre-arm | **GREEN** 05:47Z | `producer-stream-absent` pre-arm refusal, exit 7 (fail(4) run path). |
| 3b | Vanish mid-armed | **GREEN** 05:47Z | `producer-stream-vanished` + TUI gasp + census 0. |
| 3c | Child SIGKILL | **GREEN** 05:48Z | `producer-child-died {SIGKILL}` + TUI gasp + file remains + census 0. |
| 4 | Shared filter | **GREEN** 05:49Z | heartbeat: doorbells 2→2; valid alert → doorbell + delivered 4ms (turn 01a003f7…). |
| 6a | SIGTERM gasp | **GREEN** 05:50Z | gasp rendered + `helper-exit signal-SIGTERM` + pidfile reaped. |
| 6b | SIGKILL residue | **GREEN** 05:50-51Z | stale pidfile remains; `status alive:false` exit 1; held-lock re-arm refused LOUD (`producer-child-died`); orphan 19185 cleaned; clean re-arm census 1/1. |
| 7a | Draft no-stomp | **GREEN** 05:51Z | cleanest specimen of the three passes: wake turn (7734) completed its summary with the draft "DRAFT-SENTINEL pass3 row7a vexed zebras" STILL VISIBLE and untouched in the composer afterward. |
| 7b | Defer v2 | **GREEN** 05:52Z | (i) ordering: count turn completed (scrollback 307-308) before the wake turn (311). NOTE: the doorbell itself arrived 33s after the mail event — inside argus's pre-flagged v0.5.0 deploy window ("delivery may lag ~1 min... mark the window"), recorded as attributable upstream lag, NOT a finding; once the doorbell landed (thread already idle) delivery was 5ms, so the defer path had no occasion this pass. (ii) instrument: `thread/resume` mid-turn `{type:"active"}`; TWO full active→idle notification cycles observed on the second client's connection (count turn end 05:52:10.5; wake turn 05:52:37→45). (iii) synthetic forcing test green in the same battery's pre-suite. Real-path defer FIRING specimen remains pass-2's 9ms-post-task_complete timeline. |
| 8 | Wake-turn contract | **GREEN** | all pass-3 wake turns (7728, alert, 7734, 7735): fixed template, exact-args read-only peeks, id verified, summaries, no other tools. |
| 5 | Double-arm + thread-gone (run last) | **GREEN** 05:53Z | `already-armed pid=19290` exit 0, census 1; daemon kill (known pid 17316) → `thread-gone daemon-connection-closed`, pidfile reaped, census 0. |

**Evidence gap, recorded honestly:** the pass-3 full pane scrollback was not captured before
the tmux session was killed at teardown (operator sequencing). The pass-3 record rests on the
helper logs (`evidence/pass3-helper-full.ndjson`), the thread rollout
(`evidence/pass3-thread-rollout.jsonl` — the authoritative turn-by-turn record), the
status-probe outputs, and the row-by-row pane excerpts quoted in the session transcript.

## Result

**PASS 2 + PASS 3 = TWO CONSECUTIVE FULL GREENS of the fixed battery** (pass 1 voided per
argus 7711; leg (a) taken and steward-accepted 7732). Teardown clean: final census 0/0/0
(helper/producer/daemon), TUI session closed, battery sandbox archived in place at
`/Users/jason/g4-20260815/` (12-file evidence bundle in `evidence/`), staged original
`.qa-tmp/native-wake-probe-20260814/` untouched throughout. Certification request to assay
follows per protocol (gate-5 ship only after assay's 2/2 read).

## Census ledger

(inline per row above: bracketed pgrep censuses; the two standing traps are documented — the
helper's argv self-matches both the producer pattern and `app-server` patterns, so counts
used binary-anchored patterns / `ps -o comm`; and a SIGTERM'd producer drains its long-poll
(≤ ~35s) before exiting, so post-stop censuses waited out the drain window.)
