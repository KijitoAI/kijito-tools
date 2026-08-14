# Codex × Kijito hive support — implementation plan (v2 draft)

**Status: DRAFT UNDER CO-AUTHOR REVIEW. No work is authorized by this document until it passes
two consecutive clean adversarial passes (argus + assay) per goal [28506] item (1).**
Co-authored from the first line with argus (skeleton approved + reshaped in hive 7446; codex
skeleton 7445). v2 folds argus's co-author revision 7450: §2b option-C trigger honesty
(C-i/C-ii split), §5 third measured dimension, §6 named double-arm control. v1 sha
`c3f1352c…` superseded. Destination after P0-freeze close + handover, steward's ruling (7446 b):
`providers/codex/plans/hive-user-first-plan.md` in kijito-tools, branch `codex/hive-plan-v1`,
PR-only, sole-author commit discipline (Jason author, no trailers/footers — ruling record
[28588]/[28566]). Until then this draft lives beside the evaluation it derives from.

**Sources of authority:** evaluation v3 `codex-hive-user-first-evaluation-20260814.md`
(sha `9d9f5076…`, two consecutive clean passes: argus 7417, assay 7418) · Jason's sign-off
[28718] ("with those refinements, I believe we're good") · arming ruling [28714] ·
fleet doctrine [28680] · session-is-the-subscriber ruling [28675].

---

## 1. Scope and non-goals

**In scope:** ship the signed-off recommendation — B+C as the default experience, option A as
per-session opt-in native live wake — and retire the old codex coordination stack from the
default path under the §7 teardown protocol.

**Non-goals, binding (doctrine [28680] §4/§6, eval §6):**
- No coordination machinery: no controllers, seat threads, mode registers, consumer locks,
  exclusivity. Same-persona-in-two-terminals is explicitly not solved; two sessions of one
  persona both fire.
- No reinvention of the producer. Kijito-monitor is the one client-agnostic producer, unchanged.
- No fleet-operator (P3) machinery in the default shape. P3 layers are a separate, later,
  opt-in evaluation.
- No ambient subscription. A bare codex session is isolated; nothing arms it without
  /kijito-start (arming model, §4 below).

## 2. B+C — the default experience

### 2a. B: prompt-time catch-up (works today; the floor everything degrades to)

- The codex `kijito-start` skill performs the same catch-up as the Claude Code shape:
  `kijito_startup` → full read of the current-state pointer → recent lessons → one durable
  inbox read. Zero new moving parts; latency = next prompt.
- Ship: skill text updated to the [28714] arming model (§4), including the loud degradation
  wording. Docs: the Codex CLI page gets a config example (closing the "In testing" one-liner
  docs gap, eval finding — see §8 sharp edges).

### 2b. C: count-only OS notification (opt-in config)

**Trigger honesty (argus 7450, blocking finding folded):** Codex's outbound `notify` hook
fires on CODEX'S OWN lifecycle events (turn-complete / approval — [28502]: notify is
outbound-only), NOT on mail arrival. A hook-wired notification therefore cannot deliver
mail-arrival latency, and this plan does not claim it. Two honest shapes, both spec'd:

- **C-i — hook-time check (ships with B as the true zero-ops default):** when codex fires the
  notify hook anyway, the thin kijito-tools shim does a cheap unread-count peek and appends
  the count to the notification. Honest semantics, stated in docs: notification latency =
  codex activity, not mail arrival; zero new processes.
- **C-ii — watcher-driven (measured, not pre-decided):** a tiny OS notifier consuming the
  SAME `_shared` doorbell seam (§3) and posting count-only notifications on mail events.
  Honest cost: it IS a persistent consumer with the same lifecycle/quarantine obligations as
  A minus injection — §4b pidfile idempotence, death visibility — and it is a second
  always-on part, so it belongs in the §5 measurement scope (third measured dimension; it
  pairs naturally with the supervised producer — a user running a supervised producer can run
  a supervised notifier the same way). C-ii ships only if §5's measurements favor it.

Common requirements for both shapes:
- **Fixed template, exactly two variables** (argus 7446 reshape ii): `persona` and `count` —
  charset-anchored in tests, the same fixed-template discipline the pane-wake nonce line
  earned. No message content, no previews, ever, on any lock screen.
- **Dependency, named by freeze identity:** the producer-side body-free capability is the
  monitor-foundation-v1 opaque-output row (**P0-F29/A29**, `--no-content`). C ships only
  behind that capability or an equivalent proven body-free path; sequencing is ledger-visible
  under that identity.
- Opt-in config only; ntfy remains entirely optional ([28479]). Default install: B alone.

## 3. The shared seam — written once in `providers/_shared`, inherited by every platform

(Structural section per argus 7446 a. Doctrine [28680]: the per-platform delta is ONLY the
last inch. Without this split the plan would quietly reimplement shared mechanics
codex-locally — the drift class loom's conformance gates exist to catch.)

**`providers/_shared` (platform-agnostic, OpenCode/VSCode/Cursor inherit):**
1. Doorbell stream consumption — locating and tailing the producer's per-persona events file
   (systemd and launchd layouts both resolved by asking the filesystem, never assumed).
2. The certified event-kind filter constant — the `_shared` doorbell seam contract; never
   re-derived per client (eval §3, F6-argus).
3. Idempotent-arm check logic — the check-then-arm discipline itself (the state machine;
   §4b instantiates it for codex).
4. Producer-health delegation — "absent events file / silent producer is indistinguishable
   from no mail" detection and loud-fail semantics (F2-argus).

**`providers/codex` (the last inch only):**
1. The `turn/start` self-nudge over the app-server daemon socket
   (`$CODEX_HOME/app-server-control/app-server-control.sock`), incl. attachment detection.
2. The `notify`-hook wiring for option C (§2b).

## 4. Arming model — [28714] implemented

### 4a. The opt-in surface and the degradation ladder

Running `/kijito-start` IS joining the hive for that session. The arm is performed by the
agent following the skill — never a hardcoded hook — so conversational overrides ("start but
don't arm") work with no flags; the user's ad-hoc instruction outranks the skill default.

**Explicit states, each visible in-session (argus 7446: "silently degraded" must be
unrepresentable):**

| State | How entered | What the user is told |
|---|---|---|
| **armed-live** | /kijito-start, daemon present, helper armed + verified | "armed: live wake on this session" |
| **catch-up-only** | /kijito-start, daemon absent or helper precondition failed | stated plainly at arm time: what failed, that mail waits for next prompt |
| **isolated** | no /kijito-start this session | nothing — isolation is the default and a feature |

Transitions downward (helper death → catch-up-only) must surface in-session per the §6
battery (F4-assay); there is no silent state.

### 4b. The idempotent-arm check primitive (argus 7446 reshape i — spec'd, not just required)

The codex equivalent of the anchored-pgrep discipline:
- The helper writes an **owner pidfile bound to (session thread id)** in the codex runtime
  dir, mode 0600.
- Arm-time check: read pidfile → is that pid alive AND is its bound thread id == this
  session's thread id?
  - **stale pidfile** (pid dead) → reap the pidfile, arm.
  - **live + same thread** → skip (already armed; the idempotent case).
  - **live + different thread** → **loud refuse** — surface to the user; never kill the other
    helper (it may be another live session's arm; same-persona-twice is unsolved by ruling).
- Exactly-one per session lifecycle; consumers must not accumulate across session restarts
  (the measured six-stacked-monitors class, eval §3).

## 5. Producer-install decision — by measurements, in the open

(Eval §2 P2 note + D1-argus: pre-deciding is forbidden. Criteria per argus 7446 reshape iii.)

**Candidates:** (A) session-scoped producer spawned by kijito-start, dies with the session,
catch-up covers gaps; (B) documented one-line supervised install (systemd user unit /
launchd), the current fleet shape. **Third measured dimension (argus 7450):** the C-ii
watcher-driven OS notifier (§2b) — measured alongside, since it is a second always-on part
that pairs naturally with the supervised-producer option; the same four criteria apply to it.

**Criteria, measured per candidate on a clean environment:**
1. Fresh-user wall-clock from docs to armed.
2. Count of user-visible moving parts (things that can be observed, need explaining, or can
   break in view of the user).
3. Reboot / laptop-sleep survival semantics AND the measured cost of the gap — mail latency
   to next catch-up when no producer runs.
4. Failure visibility — how the user learns the producer died (loud vs silent; time-to-notice).

**Decision rule:** whichever candidate wins on 1/2/4 without an unacceptable 3. No vibes; the
measurement log lands beside this plan. Supervised install remains the P3 opt-in either way.

## 6. Option A — native live wake, gated on the sandbox battery

Design (eval §5A): session-scoped helper, spawned by kijito-start, consumes the shared
doorbell seam (§3) and calls `turn/start` on this session's own thread over the local socket.
Daemon is experimental and off by default — `codex app-server daemon bootstrap` is a one-time
user opt-in step, stated in docs.

**Acceptance battery — 2/2 consecutive green passes in the sandbox
(`SideProjects/Codex/.qa-tmp/native-wake-probe-20260814/`, staged, untouched), every negative
control first-class:**
1. **Non-attachment detection**: a `-c`-overridden / --strict-config launch runs embedded
   (no daemon attach, [28502] trap); the helper must detect and say so in-session — silent
   no-op is a false green.
2. **Producer-silence loud-fail** (F2-argus, via the §3 shared delegation): absent events file
   and down-producer negative controls; the helper pages/degrades loudly, never tails a file
   that will never exist.
3. **Shared filter constant in use** (F6-argus, per argus 7446 c: in the battery, not only as
   an eval citation): the helper consumes the certified event-kind constant from the `_shared`
   seam; a probe event of a non-covered kind must NOT nudge; a covered diagnostic kind must.
4. **Helper lifecycle** (F3-argus): pre-nudge thread-liveness check, exit-on-thread-gone,
   idempotent arm per §4b; kill-the-session negative control — no orphaned helpers firing into
   dead or reused threads, no accumulation across crashes. **Named probe — the DOUBLE-ARM
   control** (argus 7450): run /kijito-start twice in one session → exactly one helper, and
   the second arm reports already-armed in-session (the six-stacked-monitors class gets its
   own probe, not an implicit ride on §4b).
5. **Helper-death visibility** (F4-assay): helper death surfaces inside the session experience
   (state transition to catch-up-only per §4a) or degradation-to-B is explicitly documented as
   the accepted semantics — decided in this plan's QA, not left open.
6. **Defer-until-idle** (F5-assay, F4-argus): an alert landing mid-typing or mid-own-turn does
   not stomp the user's work; defer-until-idle defined and proven as a first-class acceptance.
7. **Wake-turn contract**: probes are scored **by-effect** ([28458]): the woken turn's template
   forbids send/mutation tools, so acceptance evidence = driver log + session capture showing
   exact-row fetch/verify/summary — never a demanded reply-by-mail.

Ship shape after 2/2: per-session opt-in via kijito-start where the daemon exists (goal item
4); Jason's live-demo acceptance comes only after sandbox 2/2 (goal item 6).

## 7. Teardown of the old stack — §4 protocol, binding

Inventory being retired from the default path: headless controller / app-server seat
(controller pid at teardown time), mode register + consumer locks, mode-aware watchdog,
tmux pane-wake driver (already stopped), declared mode `codex.app-server-seat` (provisional).

Protocol (eval §4, F8-argus, F3-assay):
1. **Ledger discipline**: artifacts that are frozen ledger rows get disposition amendments
   post-P0-close in assay-coordinated windows — never mid-freeze deletions.
2. **The alarm dies last**: the mode-aware watchdog outlives the machinery it monitors until
   the replacement (B+C default, and A where opted-in) has two greens; nothing is orphaned
   mid-swap.
3. **Archive-don't-delete**: retired components move to `legacy/` per fleet data-safety;
   certifications archived, never deleted.
4. **Steward-held PRs**: every teardown change lands via PR under argus's steward review,
   sole-author commit discipline.
5. Sequencing note: PR #14 (false-pager fix) merges FIRST (it fixes the alarm we keep running
   until last) — it awaits only loom's freeze-evidence confirm; the deployed-artifact swap
   runs under census discipline ([28440] class: verify by a page-relevant event, not process
   liveness).

## 8. Carried sharp edges (fix-or-document, from the P1 walkthrough [28699])

1. **`codex exec` headless silently cancels approval-needing MCP tool calls** ("user cancelled
   MCP tool call"); the fix flag `--approve-for-me` is discoverable only in `--help`
   (0.147; `--full-auto` is not an exec flag). Plan: docs note in the kijito-tools codex
   README + upstream issue candidate; evaluate defaulting the skill's exec examples to include
   the flag.
2. **Headless OAuth has no timeout** — a headless `codex mcp add` that cannot open a browser
   waits forever; docs note + guard suggestion.
3. **Docs stub**: kijito.ai docs list Codex CLI as "In testing" with one sentence and no
   config example (Cursor gets one). Plan: ship the config block + skills example with §2.

## 9. Wrong-regime bounds sweep — run, clean (plan input closed)

Read-only sweep of kijito-tools main `c04d143` (method: comment-marker grep; full named
time-constant enumeration; raw-literal/setTimeout pass over controller, mode-register, cli,
wake-core; every consumer of `clientStatus.checkedAt` / `pollMs*4`). Result: the
`max(5s, pollMs*4)` readiness formula has exactly two consumers — `cli.mjs:454` (home regime,
arm-time readiness gate: correct) and `mode-liveness.mjs:62` (the PR #14 wrong-regime copy,
fix pending merge). No third copy. pane-wake heartbeat (5s beat / factor 6 / 30s floor) and
the claude heartbeat-watchdog (300s poll / 4 quiet checks) are original continuous-regime
calibrations. The [28720] class is contained to what PR #14 already fixes. (Record: codex
memory [28729]; argus notified 7447.)

## 10. Execution order and done-when (maps 1:1 to goal [28506])

| # | Step | Gate |
|---|---|---|
| 1 | THIS PLAN passes argus + assay adversarial QA | two consecutive clean passes; any finding resets |
| 2 | B+C default shipped (§2), incl. docs | assay-verifiable on a clean environment |
| 3 | Producer-install measurement (§5) executed, decision recorded | measurement log, no vibes |
| 4 | Option A sandbox battery (§6) | 2/2 greens, all negative controls |
| 5 | A shipped as per-session opt-in via kijito-start where daemon exists | after (4) only |
| 6 | Old-stack teardown (§7) | protocol order; alarm dies last |
| 7 | Assay certification of shipped mode 2/2; Jason live-demo acceptance | after sandbox 2/2 only |

Related gate [28485] (packaged-re-arm re-run) re-scopes in the open at whichever fires first —
packaging or this plan's teardown — coordinated with argus as steward at execution time.
