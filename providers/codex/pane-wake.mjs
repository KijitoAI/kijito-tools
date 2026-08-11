#!/usr/bin/env node
// Codex EXACT-PANE wake delivery driver — the same-session-wake half of the codex provider.
//
// WHY THIS EXISTS. controller.mjs delivers the wake turn through a `codex app-server` child on a
// dedicated CODEX_HOME thread. That thread is NOT the operator's live Codex CLI tmux session, so a
// wake completes in an isolated thread the operator never sees (measured RED, kijito memories
// 26801/26802). This driver keeps the shared wake PROTOCOL (../_shared/wake-core.mjs) unchanged and
// swaps ONLY the delivery mechanism: it injects wake-core's fixed, injection-safe wake text into the
// operator's VERIFIED-LIVE Codex pane via tmux, so the wake turn starts where the operator is looking.
//
// SAFETY BOUNDARY (assay ruling 5717, superseding the parity-plan boundary NARROWLY for live-pane
// wake): the ONLY thing ever placed in the pane's input is wake-core's fixedWakeText — event
// METADATA only, never a hive message body, carrying the WAKE_PREFIX and a read-only-peek
// instruction — PLUS one fixed-template verification line whose only variable part is a 128-bit
// random token this driver mints (see the nonce section below). Both halves are closed templates:
// no event field, no pane content and no hive data can reach either. No thread/inject_items, no
// thread/steer, nothing starts at login. See the "Amendment — 2026-08-11" section of
// codex-kijito-parity-plan.md, which lands that carve-out in the plan itself and reconciles it with
// the plan's pre-implementation gate lines ~124 and ~157.
//
// BINDING CONSTRAINTS (assay 5696 + amendments 5703/5717), implemented below:
//   (a) pane identity verified AT SEND TIME (enumerate + foreground fingerprint + REQUIRED thread
//       id matched as an exact argv token), never a cached pane id or host mapping.
//   (b) abort-on-mismatch: any verification failure holds read-state and retries; never inject an
//       unverified pane.
//   (c) idempotent single wake per event: the submit keystroke is recorded BEFORE it is issued and
//       the batch enters a bounded confirmation phase; a message id is consumed on exactly one
//       positive observation — the pane rendering OUR OWN per-submission nonce above an emptied
//       composer — and an unconfirmable submission is abandoned with an alarm rather than re-typed.
//       A persisted record older than that phase's own worst case is refused rather than believed.
//   (d) delivery is confirmed BY POSITIVE EFFECT, never by our own "sent" self-report and never by
//       the ABSENCE of a signal; read-state advances only after that confirmation.
//   (e) no wrong-host probe: pane discrimination is LOCAL tmux enumeration only.
//   R1  clear the input line before every injection so a retry starts from an empty prompt.
//   R1b NEVER clobber a user-authored draft: only clear/inject when the WHOLE composer block is
//       empty or holds solely residue of our own prior wake text; otherwise DEFER.
//   R2  this driver and controller.mjs share ONE single-consumer lock BY DERIVATION — the default
//       lock path is built from the same install root the controller builds its own from, so the
//       shipped defaults are mutually exclusive rather than merely claimed to be. The controller
//       must be stopped (and its auto-start, if any, disabled) before this driver arms.
//   S1  bounded silence has TWO halves: after N consecutive deferrals the driver alerts while
//       holding read-state, and it stamps a heartbeat so that a driver which is NOT RUNNING is
//       observable from outside (a dead consumer defers nothing, so it can raise nothing).
//
// ⛔ THE ONE RULE THAT ORGANISES THIS FILE (assay review codex-pane-wake-1, findings F1/F2/F3/F4):
// TMUX EXIT 0 IS NOT APPLICATION RECEIPT, AND "I CANNOT READ THE PANE" IS NOT "MY TURN STARTED".
// The first version of this driver confirmed delivery with `!awaitingInput()`, a boolean that
// returned false for three different meanings — a live turn, unreadable chrome, and a failed
// capture — so an unreadable pane was scored as proof of delivery and the event was consumed
// without ever being sent (measured on four realistic frames). Every observation in this file is
// therefore THREE-VALUED (classifyPane -> idle | busy | unreadable), every state transition is
// verified by a fresh capture, and read-state advances on exactly one positive observation.
//
// ⛔ AND THE SECOND RULE, WHICH IS THE MIRROR OF THE FIRST AND COST US A SECOND ROUND:
// "I COULD NOT CONFIRM" IS NOT "IT DID NOT HAPPEN" EITHER.
// Holding read-state until a positive confirmation is only half a guarantee; the first version of
// that fix answered an unconfirmable submit by re-running the WHOLE delivery, so one event typed
// the same wake into the operator's live pane once per backoff interval, without bound (measured:
// 20 submissions from one event). Steps 1-5 of a delivery are reversible and may be retried freely.
// The Enter is not, so it is written down BEFORE it is issued and the batch enters a bounded
// confirmation phase that may observe, may re-issue the keystroke ONLY after positively seeing our
// text still unsubmitted, and otherwise gives up with an alarm and consumes nothing.
//
// THE CHROME IS THE ONLY IDLE/BUSY DISCRIMINATOR THERE IS. Measured independently: the pane's
// foreground process stays S+ and `pane_current_command` stays `codex` for the whole of a live
// turn, so neither ps nor tmux's own process fields can tell "accepting input" from "mid-turn".
// classifyPane's positive idle signature therefore carries that whole property by itself, which is
// why it is written to fail towards BUSY and why every ambiguity resolves to defer.
//
// CHROME SHAPES ARE A THIRD-PARTY CONTRACT WE DO NOT OWN. The prompt caret, the ·-separated status
// bar, the transcript/composer rule, and the working-indicator syntax below were measured against
// the Codex CLI TUI on darwin 25.4.0 / tmux 3.6a on 2026-08-10 (see test/pane-wake.test.mjs, which
// pins each shape as a fixture). A cosmetic change upstream must make this driver DEFER, never
// inject: that is why the busy predicate is deliberately loose inside the chrome band and why every
// structural check that fails returns `unreadable`.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_LINE_BYTES,
  MAX_READ_BYTES,
  MAX_PENDING,
  WAKE_PREFIX,
  parseEventLine as coreParseEventLine,
  fixedWakeText as coreFixedWakeText,
  initialState as coreInitialState,
  saveState,
  acquireLock as coreAcquireLock,
  releaseLock,
  requirePrivateDirectory,
  requirePrivateEventFile,
} from "../_shared/wake-core.mjs";

// This driver IS the codex provider, so it binds the persona wake-core refuses to default.
const PERSONA = "codex";
const parseEventLine = (line) => coreParseEventLine(line, PERSONA);
const fixedWakeText = (batch) => coreFixedWakeText(batch, PERSONA);
const initialState = () => coreInitialState(PERSONA);
const acquireLock = (file) => coreAcquireLock(file, PERSONA);

// The tmux paste buffer name is fixed and private to this driver, so a retry always overwrites the
// same buffer rather than leaking one buffer per attempt.
const PASTE_BUFFER = "kijito-codex-wake";

// ⛔ MEASURED ON THE WIRE, NOT INFERRED FROM THE TOOL NAME. This was `/api/hive/send` — the shape
// of the MCP tool (kijito_hive_send) rather than the REST route it twins — and every bounded-silence
// alert this driver has ever raised answered 404. The failure was invisible from inside: the POST
// completed, the transport logged its own success path, and the only thing that knew was a status
// code nobody asserted. `/api/send` is the real route (docs/API.md), and its existence is now
// probed at arm time and pinned by a test that hits the wire.
const HIVE_SEND_URL = "https://api.kijito.ai/api/send";

// ⛔ THE ALERT BODY CONTRACT: {to, content, from}. It used to send `persona`, which the route does
// not know — an unknown field is ignored and `from` then defaults to the token's own identity, so
// every bounded-silence alarm this driver raised would have been attributed to the token owner
// rather than to codex. A misattributed alarm is a worse failure than a missing one: it reaches
// someone, wearing the wrong name, about a pane they do not own.
const hiveNoteBody = (to, content) => ({ to, content, from: PERSONA });

// Deferral backoff (F11). A held batch used to re-run a full delivery attempt — tmux enumeration
// plus a whole-process-table ps — every poll, forever, with one log line per second (measured: 818
// consecutive `not-awaiting-input` lines in 13 minutes on the live driver).
const BACKOFF_CAP_MS = 60_000;
const DEFER_LOG_MIN_INTERVAL_MS = 60_000;  // identical consecutive reasons collapse to this cadence
const SEEN_CAP = 512;                      // matches the persisted recentKeys cap

// Alarm cadence, chosen rather than inherited. First alert: `alertAfter` deferrals, which with the
// backoff above is ~4 minutes at the defaults. Re-alerts then widen by doubling to a cap of 30
// deferrals ≈ 30 minutes at the 60 s backoff floor. The previous cap (480) worked out to ~8 hours
// between reminders for the only bounded-silence signal the system has, which is a number nobody
// chose — it fell out of two independent caps multiplying.
const ALERT_GAP_CAP = 30;

// Verification cadence. Each transition is re-captured until it is positively observed or the
// attempts run out; a mid-redraw frame must cost a retry, not a false verdict.
const VERIFY_TRIES = 5;
const VERIFY_WAIT_MS = 120;

// Post-submit confirmation phase. Steps 1-5 of a delivery are reversible and may be retried freely;
// the submit keystroke is not, so it gets its own bounded, persisted phase (see confirmSubmit).
// CONFIRM_CAP observations at CONFIRM_POLL_MS (floored by the poll interval) bound the phase to
// roughly ten seconds at the shipped defaults; REISSUE_CAP bounds how many times a submit may be
// re-issued, and ONLY after positively observing that our text is still sitting unsubmitted.
const CONFIRM_CAP = 8;
const REISSUE_CAP = 2;
const CONFIRM_POLL_MS = 500;
const CONFIRM_SETTLE_MS = 400;
const TMUX_TIMEOUT_MS = 5000;
// The arm-time alert-route probe is a diagnostic, so it gets a short leash: a few seconds, and its
// outcome never gates arming (see probeAlertRoute for the three-way result).
const ALERT_ROUTE_TIMEOUT_MS = 4000;
// One observation can make four subprocess calls (list-panes, ps, display-message, capture-pane),
// each with its own timeout; a delivery attempt makes several observations. Both the heartbeat's
// staleness bound and the confirm record's age bound are derived from this rather than guessed.
const attemptBudgetMs = () => TMUX_TIMEOUT_MS * 4;
// The confirmation phase's own worst-case wall-clock. A persisted record older than this cannot be
// evidence about the screen in front of us.
const submitAgeBudgetMs = (pollMs) => CONFIRM_CAP * (Math.max(CONFIRM_POLL_MS, pollMs) + attemptBudgetMs());

// How far above the composer the chrome band may reach when the TUI draws no transcript rule there.
// Measured: the live working indicator renders 3-4 lines above the prompt; the round-1 review's
// worst measured offset was 6. See readChrome for why both this bound AND the rule are needed.
const CHROME_ABOVE_PROMPT_LINES = 8;

// Liveness. The consumer stamps a heartbeat so that a driver which is NOT RUNNING becomes visible:
// the bounded-silence alarm counts deferrals, and a dead consumer produces none — fail-closed and
// silent, which is the one combination this project keeps paying for.
const HEARTBEAT_WRITE_MS = 5_000;
const HEARTBEAT_STALE_FACTOR = 6;          // stale after 6 missed heartbeats
const HEARTBEAT_STALE_FLOOR_MS = 30_000;

function sleepMs(ms) {
  // Synchronous wait without a busy loop (Atomics.wait on a throwaway buffer).
  //
  // ⛔ KNOWN AND DELIBERATELY NOT FIXED — SHUTDOWN LATENCY, STATED RATHER THAN LEFT SILENT.
  // This blocks the event loop, so the SIGINT/SIGTERM handlers cannot run until the in-flight
  // attempt returns. The bound is the attempt itself: two verify loops of VERIFY_TRIES × 120 ms
  // plus the subprocess calls, each capped at TMUX_TIMEOUT_MS — i.e. seconds normally and
  // `attemptBudgetMs()` in the pathological case. Removing it means making the whole delivery path
  // async, which is a redesign of the one component whose synchronous, single-in-flight shape is
  // what makes "exactly one submission" auditable. The cost is a slow stop; the benefit of the
  // rewrite is a faster stop. That trade does not pay, so it is recorded, not taken.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Terminal-escape helpers.
//
// capture-pane -e preserves escape codes, which is what lets ghost placeholder text (rendered DIM)
// be told apart from a user draft. Two things are stripped before any structural test: SGR, and OSC
// 8 hyperlink framing (F15 — modern tmux can emit it, and residue would break the caret test).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const CARET = "›";                                // › — the Codex input prompt caret
const SGR_RE = /\x1b\[[0-9;:]*m/g;
const OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
function visible(s) { return s.replace(OSC8_RE, "").replace(SGR_RE, ""); }

// Parse ONE SGR parameter list into attributes, CONSUMING the extended-colour forms (38/48 followed
// by 5;n or 2;r;g;b, and their colon-separated spellings) so their parameters are never scored as
// standalone attributes.
//
// ⛔ THIS IS NOT PEDANTRY, IT IS AN R1b FIX. The live Codex composer paints its background with
// `48;2;49;52;57`. A flat scan of the numbers in that sequence finds a `2`, reads FAINT, and
// concludes the operator's real draft is ghost placeholder text — at which point R1b's guarantee
// inverts and the very next step sends C-u over the draft. The parser below cannot make that
// mistake because a colour's parameters never reach the attribute list.
function sgrAttributes(paramText) {
  const out = [];
  const tokens = paramText.split(";");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.includes(":")) {                       // 38:5:n / 38:2::r:g:b (ITU T.416 spelling)
      pushColour(out, token.split(":").map((x) => (x === "" ? 0 : Number(x))));
      continue;
    }
    const code = token === "" ? 0 : Number(token);
    if (code === 38 || code === 48) {
      const kind = Number(tokens[index + 1] ?? NaN);
      if (kind === 5) { pushColour(out, [code, 5, Number(tokens[index + 2])]); index += 2; }
      else if (kind === 2) { pushColour(out, [code, 2, Number(tokens[index + 2]), Number(tokens[index + 3]), Number(tokens[index + 4])]); index += 4; }
      else { index += 1; }                           // unknown colour form: consume the selector
      continue;
    }
    out.push({ role: "attr", code });
  }
  return out;
}

function pushColour(out, sub) {
  const role = sub[0] === 38 ? "fg" : sub[0] === 48 ? "bg" : null;
  if (role === null) return;
  if (sub[1] === 5) { out.push({ role, mode: "indexed", index: sub[2] }); return; }
  if (sub[1] === 2) {
    const rest = sub.slice(2).filter((n) => Number.isFinite(n));
    const rgb = rest.length >= 4 ? rest.slice(1) : rest;   // colon form carries a colour-space id
    out.push({ role, mode: "rgb", rgb });
  }
}

// "Dim" is a CLASS, not a single code (F9): SGR 2 faint, 90/30 bright-black/black, the 256-colour
// grey ramp, and low-contrast greys in truecolour. Discriminating ghost text by ONE code meant a
// restyle upstream would turn every ghost placeholder into a permanent `user-draft` and the driver
// would defer forever.
function isDimColour(attribute) {
  if (attribute.mode === "indexed") {
    // 232-243 is the DARK half of the xterm greyscale ramp. The band used to run to 250, i.e.
    // #bcbcbc — a perfectly ordinary foreground in a themed terminal, which meant a real draft
    // rendered in a mid grey scored as ghost text and the next step cleared it. Widening the dim
    // class to close a fail-CLOSED drift is only correct while the class cannot swallow real text.
    const n = attribute.index;
    return n === 0 || n === 8 || (n >= 232 && n <= 243);
  }
  if (attribute.mode === "rgb") {
    const [r, g, b] = attribute.rgb;
    if (![r, g, b].every((v) => Number.isFinite(v))) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max <= 128 && max - min <= 24;      // was 170: #a8a8a8 is not "dim", it is grey text
  }
  return false;
}

// Dim-ness of ONE rendered line. Scans the run of SGR sequences that opens the body: after the
// caret when the line carries one, from the start of the line when it does not (a ghost placeholder
// that wraps has no caret on its continuation lines, and treating those as a user draft was a
// permanent-defer path).
// Approximate luminance of a parsed colour, or null when we cannot say. Only used RELATIONALLY.
function colourLuminance(attribute) {
  if (attribute.mode === "indexed") {
    const n = attribute.index;
    if (n >= 232 && n <= 255) return (n - 232) * 10 + 8;        // the xterm greyscale ramp
    if (n === 0 || n === 8) return n === 0 ? 0 : 128;
    if (n === 7) return 192;
    if (n === 15) return 255;
    return null;
  }
  if (attribute.mode === "rgb") {
    const [r, g, b] = attribute.rgb;
    return [r, g, b].every((v) => Number.isFinite(v)) ? Math.max(r, g, b) : null;
  }
  return null;
}
const LIGHT_BACKGROUND = 128;

function isDimLine(rawLine) {
  const idx = rawLine.indexOf(CARET);
  const after = idx < 0 ? rawLine : rawLine.slice(idx + 1);
  const prefix = (after.match(/^(?:\x1b\[[0-9;:]*m|\s)*/) || [""])[0];
  let faint = false;
  let dimColour = false;
  let backgroundLuminance = null;
  for (const match of prefix.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    for (const attribute of sgrAttributes(match[1])) {
      if (attribute.role === "bg") { backgroundLuminance = colourLuminance(attribute); continue; }
      if (attribute.role === "fg") { dimColour = isDimColour(attribute); continue; }
      const code = attribute.code;
      if (code === 2) faint = true;
      else if (code === 22) faint = false;
      else if (code === 39) dimColour = false;
      else if (code === 49) backgroundLuminance = null;
      else if (code === 0) { faint = false; dimColour = false; backgroundLuminance = null; }
      else if (code === 90 || code === 30) dimColour = true;
      else if ((code >= 31 && code <= 37) || (code >= 91 && code <= 97)) dimColour = false;
    }
  }
  // ⛔ RELATIONAL, NOT ABSOLUTE — and the fixtures for this only covered the safe half.
  // "Ghost" means LOW CONTRAST AGAINST THIS LINE'S OWN BACKGROUND. An absolute dark-foreground test
  // is correct on the measured build, whose composer background is #313439, and inverts on a LIGHT
  // theme: there, #333333 is ordinary body text, and scoring it as ghost authorises `C-u` over the
  // operator's real draft. That is R1b inverted by nothing worse than a colour scheme, in a file
  // whose contract says a cosmetic upstream change must make the driver DEFER, never act.
  // SGR 2 is exempt from the relational test on purpose: it is an explicit intensity reduction, not
  // a colour, and it is what the measured ghost placeholder actually uses.
  if (faint) return true;
  if (!dimColour) return false;
  return backgroundLuminance === null || backgroundLuminance <= LIGHT_BACKGROUND;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Chrome parsing. The bottom UI CHROME is the only thing read — never the transcript's free text.
// Findings 1-3 of the original de-risk were one class: reading UI state from chat prose. The chrome
// is structural: the LAST › line is the input prompt, the ·-separated status bar must sit BELOW it
// (dialogs REPLACE the chrome, so its absence is the dialog signal), and the composer block is
// everything between the transcript boundary and that status bar.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The status bar is matched by SHAPE, not by the mere presence of a separator: at least two
// ·-separated non-empty fields (model · cwd · …). It is one of the POSITIVE clauses of the idle
// signature below, so "there is a dot somewhere on the line" is not good enough.
const STATUS_FIELD_SEPARATOR = " · ";
function isStatusBar(line) {
  if (!line.includes(STATUS_FIELD_SEPARATOR)) return false;
  const fields = line.split(STATUS_FIELD_SEPARATOR).map((field) => field.trim());
  return fields.length >= 2 && fields.every((field) => field.length > 0);
}

// The transcript/composer separator the TUI draws above the input box (box-drawing runs, dashes,
// or underscores). It is the only non-magic anchor available for "where does the transcript end".
const RULE_RE = /^[\u2500-\u257f\u2010-\u2015_-]{8,}$/;

// A framed overlay drawn ACROSS the composer band: corners and verticals belong to a dialog box,
// never to the measured input composer. Their presence in the band is not an idle signature.
const FRAME_RE = /[\u250c-\u256c\u2502\u2503\u2506\u2507\u250a\u250b\u254e\u254f\u2551]/;

// ⛔ INDICATOR SHAPES — AND THE REGION THEY MAY BE READ FROM, WHICH IS THE HALF THAT BIT US.
//
// Round 1 honoured the STRICT arms across the WHOLE visible capture on the theory that "transcript
// prose has to quote the indicator syntax to match, and that direction DEFERS". Measured, that
// theory was wrong twice over: `• Running the migration now`, `· Generating a report` and a bare
// U+2800 BRAILLE PATTERN BLANK (a spacer glyph, not a spinner) each pinned an idle pane as BUSY,
// and a bulleted gerund is ordinary output in this fleet. A Codex pane shows its last message until
// something changes, so one such line parks on screen and defers every wake until a human clears
// it — third-party CONTENT reaching a control decision, in a file whose own invariant says the
// transcript is never read. Both arms are now confined to the chrome band (see readChrome), `·` is
// out of the spinner class, and the bare-spinner arm excludes the blank braille cell.
const SPINNER = "[\\u2022\\u25cf\\u25cb\\u25d0-\\u25d3\\u25f0-\\u25f3\\u2801-\\u28ff\\u2596-\\u259f]";
const WORK_WORD = "(?:Working|Thinking|Running|Generating|Reasoning|Waiting)";
const STRICT_BUSY = [
  new RegExp(`^\\s*${SPINNER}\\s*${WORK_WORD}\\b`, "i"),                 // • Working …  /  ⠴ Thinking …
  /^\s*[\u2801-\u28ff]/,                                                // a bare braille spinner frame
  /\(\s*\d+\s*[smh][^)]*esc to interrupt/i,                              // (3s • Esc to interrupt)
  /\b\d+\s*[smh]\s*\(\s*esc to interrupt/i,                              // 4s (Esc to interrupt)
  new RegExp(`^\\s*${WORK_WORD}[…\\.]*\\s*\\(?\\s*\\d+\\s*[smh]\\b`, "i"), // Working… 4s
];
const LOOSE_BUSY = [
  /esc to interrupt/i,
  new RegExp(`${WORK_WORD}[…\\.]*\\s*\\(?\\s*\\d+\\s*[smh]\\b`, "i"),
  /[\u2801-\u28ff]/,                                                   // a braille spinner glyph
];
// One region, both arms. Keeping two scan widths was what let the transcript in.
const BUSY_ARMS = [...STRICT_BUSY, ...LOOSE_BUSY];

const CARET_RE = new RegExp(`^\\s*${CARET}\\s?`);
const stripCaret = (line) => line.replace(CARET_RE, "").trim();

// ⛔ CHROME LANDMARKS — POSITION-ANCHORED, AND CONTENT MAY NEVER NARROW THE SCAN REGION.
//
// This function used to locate the chrome by CONTENT SEARCH: the last caret line anywhere, the first
// dotted line below it, the nearest rule-shaped line above it. Every one of those is a shape that
// ordinary rendered output can supply, and rendered output here includes hive message text — the
// wake instruction itself tells the agent to summarise returned messages into this pane. Two
// measured breaks followed:
//
//   * a rule-shaped line (markdown `--------`, a table border, this fleet's own ──── style) landing
//     BETWEEN the working indicator and the composer raised the band floor above the indicator, and
//     a live turn classified `idle` — keystrokes, including Enter, into a running turn;
//   * with an approval dialog owning the pane, a caret-leading line plus a dotted line ABOVE it
//     supplied a substitute composer+status pair, so "the chrome is absent" — the design's entire
//     dialog defence — was satisfied by content, and Enter went into a modal prompt.
//
// The rules that replace it, in order of application:
//   1. The status bar must be the LAST NON-BLANK LINE OF THE CAPTURE. The TUI draws it at the pane
//      floor; transcript content cannot be below the floor. This is a POSITION anchor, not a shape
//      match, and it is what makes the dialog case unreadable again.
//   2. The composer is the last caret run above that anchored status bar.
//   3. The band's upper bound is FIXED GEOMETRY — `promptStart - CHROME_ABOVE_PROMPT_LINES` — and a
//      transcript rule may only WIDEN it (move it further up when a real boundary lies beyond the
//      fixed window). A rule INSIDE the window is ignored entirely, so no content can shrink the
//      region the busy predicate scans. Content can now only ever make us look at MORE.
//   4. AMBIGUITY IS UNREADABLE, NOT FIRST-MATCH: if the band holds a second status-bar-shaped line,
//      or a second candidate composer (a caret run separated from the real one by blank lines only —
//      i.e. one that could plausibly BE the composer), the capture is refused.
function readChrome(captured) {
  if (typeof captured !== "string") return null;
  const raw = captured.split("\n");
  const vis = raw.map((line) => visible(line).replace(/\s+$/g, ""));

  // 1. the pane floor
  let statusIdx = -1;
  for (let i = vis.length - 1; i >= 0; i -= 1) {
    if (vis[i].trim() !== "") { statusIdx = i; break; }
  }
  if (statusIdx < 0) return null;                                    // empty capture
  if (!isStatusBar(vis[statusIdx])) return null;                     // the floor is not our chrome

  // 2. the composer, positionally: the last caret run above the floor
  let promptIdx = -1;
  for (let i = statusIdx - 1; i >= 0; i -= 1) {
    if (vis[i].trimStart().startsWith(CARET)) { promptIdx = i; break; }
  }
  if (promptIdx < 0) return null;                                    // no input caret at all
  let promptStart = promptIdx;
  while (promptStart > 0 && vis[promptStart - 1].trimStart().startsWith(CARET)) promptStart -= 1;

  // 3. fixed floor first; the rule may only widen it
  const fixedTop = Math.max(0, promptStart - CHROME_ABOVE_PROMPT_LINES);
  let ruleIdx = -1;
  for (let i = fixedTop - 1; i >= 0; i -= 1) {
    if (RULE_RE.test(vis[i].trim())) { ruleIdx = i; break; }
  }
  const chromeStart = ruleIdx >= 0 ? Math.min(fixedTop, ruleIdx + 1) : fixedTop;

  // 4. ambiguity ⇒ unreadable.
  // The floor anchor already makes the STATUS BAR unique by construction — there is exactly one
  // last-non-blank line — so what is left to be ambiguous is the composer. Two things can make it
  // so, and both refuse rather than guess:
  //   * a second caret run separated from the real one by blank lines only (either could be the
  //     composer; nothing in the geometry says which);
  //   * a floor-shaped line INSIDE the composer block, which makes the block's extent unclear.
  // ⚠️ A COUNT OF STATUS-BAR-SHAPED LINES IN THE WHOLE BAND WOULD BE WRONG, and was measured wrong:
  // the live working indicator is itself ·-separated ("• Working (2m 31s • esc to interrupt) · 1
  // background terminal running · /ps to view"), so counting shapes across the band turns every
  // real live turn into `unreadable` and the confirmation phase can then never confirm anything.
  if (secondComposerCandidate(vis, promptStart)) return null;
  for (let i = promptStart; i < statusIdx; i += 1) if (isStatusBar(vis[i])) return null;

  return {
    raw,
    vis,
    promptStart,
    promptIdx,
    statusIdx,
    ruleIdx,
    chromeStart,
    // Everything above the composer. Read ONLY to look for our own per-submission nonce after a
    // submit (see nonceSeen) — never for idle/busy.
    transcriptEnd: promptStart,
  };
}

// Is there a SECOND thing in this capture that could plausibly be the composer? A caret run
// separated from the real one by blank lines only is exactly that: nothing in the geometry says
// which of the two the TUI is typing into. A caret run separated by a rule or by any other content
// is transcript (an echo of a previous wake renders that way) and is not a competing candidate —
// the composer is positionally defined as the last run above the anchored floor.
function secondComposerCandidate(vis, promptStart) {
  let index = promptStart - 1;
  while (index >= 0 && vis[index].trim() === "") index -= 1;
  return index >= 0 && vis[index].trimStart().startsWith(CARET);
}

// The composer block is EVERY line between the transcript boundary and the status bar (F9): the
// recovery path depends on recognising our own multi-line residue, and examining only the last
// caret line deadlocked it when the TUI drew a caret on every wrapped line.
function composerBodies(chrome) {
  const out = [];
  for (let i = chrome.promptStart; i < chrome.statusIdx; i += 1) {
    out.push({ index: i, raw: chrome.raw[i], body: stripCaret(chrome.vis[i]) });
  }
  return out;
}

const squash = (text) => text.replace(/\s+/g, "");

// Is everything in the composer a leading fragment of OUR wake text? Compared with whitespace
// squashed out, so a wrapped line is still recognised.
//
// ⛔ THE COMPARISON IS ONE-DIRECTIONAL ON PURPOSE. The original test was symmetric
// (`body.startsWith(WAKE_PREFIX) || WAKE_PREFIX.startsWith(body)`), which classified a user who had
// typed `[` as OUR residue and cleared it — a literal R1b violation. Ours must contain the WHOLE
// prefix before anything is cleared.
// ⛔ AND IT IS COMPARED AGAINST EVERY TEXT WE MIGHT HAVE ISSUED, NOT JUST THE CURRENT ONE.
// The wake text names the pending message ids, so it CHANGES the moment a new event joins the held
// batch. Comparing residue only against the current attempt's text meant our own leftovers stopped
// being recognised as ours exactly when a second message arrived — reclassified `user-draft`, which
// R1b (correctly) refuses to clear, so the wake stream stayed dead until a human emptied the
// composer by hand. Round 1 closed "cannot self-heal" and this reopened it through another door,
// which is why the last-issued text is now PERSISTED and passed back in here.
function composerIsOurs(bodies, wakeTexts) {
  const composed = squash(bodies.map((entry) => entry.body).join(""));
  if (composed.length === 0) return false;
  if (!composed.startsWith(squash(WAKE_PREFIX))) return false;
  const candidates = (Array.isArray(wakeTexts) ? wakeTexts : [wakeTexts]).filter((t) => typeof t === "string" && t.length > 0);
  if (candidates.length === 0) return false;          // nothing to compare against ⇒ not provably ours
  return candidates.some((text) => squash(text).startsWith(composed));
}

// Did the WHOLE block land? Equality, not prefix (see the note on composerHoldsWake).
function composerIsExactly(bodies, wakeText) {
  if (typeof wakeText !== "string" || wakeText.length === 0) return false;
  return squash(bodies.map((entry) => entry.body).join("")) === squash(wakeText);
}

// ⛔ THE PER-SUBMISSION NONCE — the only thing on that screen we can prove we put there.
//
// The previous attribution signal counted occurrences of the fixed WAKE_PREFIX above the composer
// and called the delta "uniquely attributable to our own action: nobody else types the prefix".
// Measured false: the prefix is a CONSTANT, so any rendered text quoting it — including a hive
// message body the wake itself instructs the agent to summarise — moves the count, and a resize or
// redraw moves it without anyone typing anything.
//
// A nonce fixes exactly that and nothing else: 128 bits from the CSPRNG, minted fresh for every
// submission, never reused, never persisted past the confirmation phase, and appended as the last
// line of the pasted text in a FIXED TEMPLATE whose only variable part is the token itself. An
// attacker composing a hive body cannot know a token that does not exist yet, and cannot brute
// force 2^128 inside a phase measured in seconds.
const NONCE_BYTES = 16;                                   // 128 bits, per the round-3 addendum
const NONCE_LABEL = "Wake-verification:";
const NONCE_TOKEN_RE = /^[0-9a-f]{32}$/;                  // the ONLY shape that may reach that line
const mintNonce = () => randomBytes(NONCE_BYTES).toString("hex");

function nonceLine(nonce) {
  if (!NONCE_TOKEN_RE.test(nonce)) throw new Error("wake nonce must be 32 lowercase hex characters");
  return `${NONCE_LABEL} ${nonce}`;
}

// The wake text handed to the pane: wake-core's closed template plus that one line. No other
// composition path exists, and no caller may pass text through.
function wakeTextWithNonce(batch, nonce) {
  return `${fixedWakeText(batch)}\n${nonceLine(nonce)}`;
}

// Is our fresh nonce rendered ABOVE the composer — i.e. did the text we typed become a turn? The
// composer itself is excluded, so "still sitting unsubmitted" can never read as confirmation.
function nonceSeen(chrome, nonce) {
  if (typeof nonce !== "string" || !NONCE_TOKEN_RE.test(nonce)) return false;
  return squash(chrome.vis.slice(0, chrome.transcriptEnd).join("\n")).includes(nonce);
}

// ⛔ THE POSITIVE IDLE SIGNATURE — READ THE POLARITY BEFORE CHANGING ANYTHING HERE.
//
// The process table CANNOT answer "is a turn running": measured independently, the pane's
// foreground process stays S+ and `pane_current_command` stays `codex` right through a live turn.
// So this handful of chrome clauses is the ONLY load-bearing discriminator between "the composer is
// accepting input" and "the model is mid-turn", and a miss injects text into a running turn.
//
// It is therefore written as a signature that must be POSITIVELY SATISFIED, clause by clause, and
// the fall-through is BUSY — not idle. The predecessor did the opposite: it asked whether a
// two-alternative regex matched a working indicator inside a four-line window and returned "idle"
// whenever it did not, so every unknown rendering, every layout that pushed the indicator one line
// further up, and every cosmetic change upstream resolved to INJECT. Four of the six renderings the
// reviewer measured, all of them a live turn, came back idle.
//
// Each clause below is something we must SEE. If you add a clause, add it as another thing that
// must be true for idle — never as another thing that must be false for busy.
function idleSignature(chrome) {
  // The caret and the status bar are NOT clauses here, deliberately, and this line exists because
  // the previous version asserted them and a reviewer proved both tautological: `promptStart` is
  // DEFINED by a caret walk-up and `statusIdx` by `isStatusBar`, so re-testing them could not fail.
  // A clause that cannot fail reads as protection and is not; the same reasoning deleted a
  // decorative walk-up bound in round 2. Those two landmarks are now enforced where they are
  // actually load-bearing — positionally, in readChrome, which returns null (⇒ unreadable) rather
  // than letting an unanchored or ambiguous capture reach this function at all.
  const clauses = {
    // Nothing is framed across the chrome band. Scoped to the WHOLE band, not just the composer
    // rows: a dialog drawn above the composer with the real chrome still intact below is the same
    // hazard as one drawn across it, and the narrower scope missed it.
    unframed: !chrome.vis.slice(chrome.chromeStart, chrome.statusIdx).some((line) => FRAME_RE.test(line)),
    // No live-turn indicator anywhere in the band, both arms, one region — deliberately the widest
    // reading of "something is running" that the chrome affords.
    quiet: !chrome.vis.slice(chrome.chromeStart).some((line) => BUSY_ARMS.some((re) => re.test(line))),
  };
  const unmet = Object.entries(clauses).filter(([, held]) => !held).map(([name]) => name);
  return { ok: unmet.length === 0, unmet };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pane delivery — the Codex-specific half. Every method fails CLOSED: an unreadable or ambiguous
// observation returns "not ready", never a guess, because the cost of a wrong guess is injecting
// into the operator's live session at the wrong moment.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
class PaneDelivery {
  constructor(options) {
    this.tmux = options.tmux;                 // tmux binary path
    this.sessionName = options.paneSession;   // durable session identity (e.g. "codex")
    this.expectThread = options.expectThread; // REQUIRED thread-id cross-check in the pane's argv
    this.verifyTries = options.verifyTries ?? VERIFY_TRIES;
    this.verifyWaitMs = options.verifyWaitMs ?? VERIFY_WAIT_MS;
  }

  tmuxOut(args, input = undefined) {
    // Returns stdout as string, or null if tmux itself failed (server gone, pane gone, etc.).
    try {
      return execFileSync(this.tmux, args, {
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: TMUX_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  }

  tmuxOk(args, input = undefined) {
    return this.tmuxOut(args, input) !== null;
  }

  // (a)+(e): enumerate LOCAL panes and return the single pane whose session name, foreground process
  // fingerprint and thread id identify the operator's Codex CLI. Returns { paneId, panePid,
  // paneInMode } or a { defer } reason — never a cached id.
  //
  // #{pane_in_mode} is enumerated because copy-mode is an UNDETECTED PANE STATE otherwise (F2):
  // tmux accepts send-keys and paste-buffer with exit 0 while its copy-mode key table eats the
  // send-keys, so the clear never happens, the wake text sits unsubmitted, and every step reports
  // success. A pane in ANY mode is unreadable by construction, so it defers here.
  resolvePane() {
    const raw = this.tmuxOut([
      "list-panes", "-a", "-F",
      "#{pane_id}\t#{pane_pid}\t#{session_name}\t#{pane_current_command}\t#{pane_in_mode}",
    ]);
    if (raw === null) return { defer: "tmux-unavailable" };
    const ps = this.psTree();
    if (ps === null) return { defer: "ps-unavailable" };
    const candidates = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const [paneId, panePid, session, cmd, inMode] = line.split("\t");
      if (session !== this.sessionName) continue;
      if (cmd !== "codex") continue;
      if (!this.fingerprintOk(panePid, ps)) continue;
      candidates.push({ paneId, panePid, paneInMode: /^\d+$/.test(inMode ?? "") ? Number(inMode) : null });
    }
    if (candidates.length === 0) return { defer: "no-codex-pane" };
    if (candidates.length > 1) return { defer: "ambiguous-codex-pane" };
    if (candidates[0].paneInMode !== 0) return { defer: "pane-in-mode" };
    return candidates[0];
  }

  // Foreground fingerprint: the pane's process subtree must contain a `codex` process whose argv
  // carries the expected thread id AS AN EXACT TOKEN. The original test was an unanchored
  // `args.includes()` over the joined argv, which accepted a TRUNCATED id and accepted the phrase
  // appearing inside an unrelated argument (F10). This is what makes the identity a live
  // measurement rather than a remembered pane number.
  fingerprintOk(panePid, ps) {
    const subtree = descendants(ps, panePid);
    const codexRows = subtree.filter((row) => isCodexRow(row.args));
    if (codexRows.length === 0) return false;
    if (typeof this.expectThread !== "string" || this.expectThread.length === 0) return false;
    return codexRows.some((row) => argvTokens(row.args)
      .some((token) => token === this.expectThread || token === `--resume=${this.expectThread}`));
  }

  psTree() {
    // Read-only process inspection (no host probe — local ps only).
    try {
      const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: TMUX_TIMEOUT_MS });
      return out.split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: m[1], ppid: m[2], args: m[3] } : { pid: "", ppid: "", args: line };
      });
    } catch {
      return null;
    }
  }

  capture(paneId) {
    return this.tmuxOut(["capture-pane", "-t", paneId, "-e", "-p"]);
  }

  paneMode(paneId) {
    const out = this.tmuxOut(["display-message", "-p", "-t", paneId, "#{pane_in_mode}"]);
    if (out === null) return null;                       // cannot ask ⇒ cannot claim mode 0
    const value = out.trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  }

  // One observation = the pane's mode AND its screen, taken together. The mode is re-read on every
  // observation because the operator can enter copy-mode between two steps of a delivery.
  observe(paneId) {
    const mode = this.paneMode(paneId);
    return { mode, captured: mode === 0 ? this.capture(paneId) : null };
  }

  // (d): THREE-VALUED pane state. `unreadable` is a first-class outcome so that no caller can
  // collapse "I could not read the pane" into either "idle" or "busy" by accident — that collapse
  // was F1, the blocking finding.
  //
  // ⛔ THE FALL-THROUGH IS BUSY. `idle` is returned ONLY for a pane whose chrome parses AND whose
  // positive idle signature holds in full; readable-but-unrecognised chrome is busy, and chrome
  // that does not parse (or a pane in any tmux mode) is unreadable. Both defer.
  // The mode argument DEFAULTS TO null (⇒ unreadable). A security-relevant observation whose
  // omission means "assume the pane is fine" is the file's own doctrine inverted; every production
  // caller passes a measured value, and a caller that forgets now defers instead of proceeding.
  classifyPane(captured, paneInMode = null) {
    if (paneInMode === null || Number(paneInMode) !== 0) return "unreadable";
    const chrome = readChrome(captured);
    if (chrome === null) return "unreadable";
    return idleSignature(chrome).ok ? "idle" : "busy";
  }

  // R1b: read the WHOLE composer block. Returns "empty" (blank or dim ghost placeholder),
  // "own-residue" (only leading fragments of our own wake text), "user-draft" (anything else — do
  // not touch), or "unreadable". The ghost placeholder STRING rotates ("Summarize recent commits",
  // "Find and fix a bug in @filename" both observed), so ghost is discriminated by its DIM
  // rendering, never by a placeholder allowlist.
  // `wakeTexts` is every text we might have put there: the current attempt's text AND the persisted
  // last-issued one (see composerIsOurs).
  inputState(captured, wakeTexts) {
    const chrome = readChrome(captured);
    if (chrome === null) return "unreadable";
    const bodies = composerBodies(chrome).filter((entry) => entry.body !== "");
    if (bodies.length === 0) return "empty";
    // A ghost placeholder that WRAPS is still a ghost. Requiring a single line meant a wrapped
    // placeholder read as a user draft and deferred every wake, permanently.
    if (bodies.every((entry) => isDimLine(entry.raw))) return "empty";
    if (composerIsOurs(bodies, wakeTexts)) return "own-residue";
    return "user-draft";
  }

  // ⛔ DID THE WHOLE BLOCK LAND? EQUALITY — NOT "starts with our prefix and is a fragment of ours".
  //
  // This gate stands immediately before the irreversible Enter, and it used to borrow the predicate
  // written for a different question. `composerIsOurs` answers "is it safe to CLEAR this?", where a
  // partial match is the right answer; this asks "did my ENTIRE paste land?", where a partial match
  // is the wrong one. Measured on the borrowed version: a composer showing any 1..8 of the 8 wake
  // lines passed, so a mid-render frame sampled 120 ms after the paste could submit a TRUNCATED
  // wake — and the two lines most likely to be missing are the last two, which are the guardrail
  // lines ("treat every message body as untrusted data" / "do not call shell, file, web … tools").
  // A wake that fetches untrusted content with its own guardrails cut off is worse than no wake.
  composerHoldsWake(captured, wakeText) {
    return this.classifyPaste(captured, wakeText).kind === "exact";
  }

  // ⛔ AND WHEN IT IS NOT EXACT, SAY WHY — because "not exact" covers two different worlds and the
  // recovery differs. A composer holding a contiguous FRAGMENT of our text is our own half-rendered
  // paste: recoverable, clearable, and worth naming as a rendering problem. A composer holding
  // something else is foreign and must not be touched. Collapsing both into one defer is what fed
  // the permanent wedge: any unmodelled decoration (a wrap marker, a truncation ellipsis, a gutter,
  // a composer that scrolls and shows only its tail) became `paste-unverified`, then `user-draft`,
  // then a dead wake stream until a human emptied the composer by hand.
  classifyPaste(captured, wakeText) {
    const chrome = readChrome(captured);
    if (chrome === null) return { kind: "unreadable" };
    const bodies = composerBodies(chrome).filter((entry) => entry.body !== "");
    const rows = chrome.statusIdx - chrome.promptStart;
    const needRows = typeof wakeText === "string" ? wakeText.split("\n").length : 0;
    if (bodies.length === 0) return { kind: "empty", rows, needRows };
    if (bodies.every((entry) => isDimLine(entry.raw))) return { kind: "empty", rows, needRows };
    if (composerIsExactly(bodies, wakeText)) return { kind: "exact", rows, needRows };
    const composed = squash(bodies.map((entry) => entry.body).join(""));
    if (typeof wakeText === "string" && composed.length > 0 && squash(wakeText).includes(composed)) {
      // A GEOMETRY PRECONDITION, with its own reason: if the composer cannot physically show as many
      // rows as the block has lines, "not exact" is a rendering fact about the pane, not a delivery
      // fact about the paste, and the two must not wear the same label.
      return { kind: rows < needRows ? "clipped" : "partial", rows, needRows };
    }
    return { kind: "foreign", rows, needRows };
  }

  // Is our fresh per-submission nonce rendered above the composer?
  nonceSeen(captured, nonce) {
    const chrome = readChrome(captured);
    return chrome === null ? false : nonceSeen(chrome, nonce);
  }

  // Sleep FIRST, then look. The original confirm loop captured before its first sleep — sampling
  // the pane at the single instant a partial/mid-redraw frame is most likely, and that sample could
  // end the loop.
  awaitObservation(paneId, predicate, tries, waitMs) {
    let last = { mode: null, captured: null };
    for (let attempt = 0; attempt < tries; attempt += 1) {
      sleepMs(waitMs);
      last = this.observe(paneId);
      if (predicate(last)) return { ...last, satisfied: true };
    }
    return { ...last, satisfied: false };
  }

  // ⛔ THE REVERSIBLE HALF. Steps 1-5 put text in the composer and can be abandoned at any point
  // with nothing submitted, so they may be retried freely. Step 6 is the irreversible one, and it
  // does NOT conclude anything: it records that a submit was ISSUED and hands the outcome to the
  // bounded confirmation phase (see PaneWakeConsumer.confirmSubmit). A driver that concludes
  // "unconfirmed ⇒ try the whole thing again" re-types the same id-bearing wake into the operator's
  // live session on every retry — measured at 20 submissions from one event before this split.
  //
  // Returns:
  //   { defer: reason }                 nothing was submitted; free to retry
  //   { submitted: true, paneId, … }    Enter was issued and recorded; confirmation is now owed
  //
  // The sequence — and the reason each step re-captures instead of trusting the previous one:
  //   1 resolve the pane                       (unique, right session, right thread, not in a mode)
  //   2 OBSERVE -> classifyPane MUST be idle    (busy/unreadable both defer; no boolean in between)
  //   3 composer empty or our own residue       (R1b: never clobber an operator draft)
  //   4 C-u, then RE-OBSERVE: composer EMPTY    (tmux exit 0 is not application receipt)
  //   5 paste, then RE-OBSERVE: the composer holds the wake text EXACTLY. THIS RUNS BEFORE ENTER,
  //     so an unframed paste whose newlines became carriage returns, keys eaten by a pane mode, or
  //     a half-rendered paste is caught while nothing has been submitted
  //   6 record the submission (write-ahead, via beforeSubmit), THEN Enter
  // ⛔ THE TEXT IS COMPOSED HERE AND NOWHERE ELSE: wake-core's closed template plus one fixed
  // template line carrying a freshly minted nonce. No caller passes text in, so there is no path by
  // which pane content or hive data can reach the pasted block.
  // Overridable ONLY so a test can prove the charset guard below actually refuses a bad token;
  // production has exactly one implementation and it is the CSPRNG.
  mintNonce() { return mintNonce(); }

  composeWake(batch) {
    const nonce = this.mintNonce();
    // The guard is inside nonceLine: a token that is not 32 lowercase hex characters cannot be
    // composed into the line at all, so there is no shape by which anything else could get there.
    return { text: wakeTextWithNonce(batch, nonce), nonce };
  }

  deliver(batch, options = {}) {
    const { text, nonce } = this.composeWake(batch);
    const priorText = options.priorText ?? null;
    const texts = [text, priorText];
    const pane = this.resolvePane();
    if (pane.defer) return { defer: pane.defer };
    const paneId = pane.paneId;

    // One paired observation: the mode and the screen from the same instant. Reusing the mode read
    // during enumeration left a window in which the operator could enter copy-mode unnoticed.
    const before = this.observe(paneId);
    const state = this.classifyPane(before.captured, before.mode);
    if (state === "busy") return { defer: "pane-busy" };
    if (state !== "idle") return { defer: "pane-unreadable" };

    const input = this.inputState(before.captured, texts);
    if (input === "user-draft") return { defer: "user-draft-present" };
    // Defensive: `idle` already implies parseable chrome, so `unreadable` cannot be reached here.
    // Kept so the switch is total rather than relying on that inference staying true.
    if (input !== "empty" && input !== "own-residue") return { defer: "input-unreadable" };

    // R1: start from a clean prompt. Safe now — the composer is empty or our own residue.
    if (!this.tmuxOk(["send-keys", "-t", paneId, "C-u"])) return { defer: "clear-failed" };
    const cleared = this.awaitObservation(
      paneId,
      (observation) => this.inputState(observation.captured, texts) === "empty",
      this.verifyTries,
      this.verifyWaitMs,
    );
    if (!cleared.satisfied) return { defer: "clear-unverified" };

    // ⛔ RECORD THE INTENT TO PASTE *BEFORE* PASTING. The residue ledger used to be written at the
    // submit step, one step too late: every path where the paste LANDS but does not verify left our
    // text in the operator's composer with nothing recorded, and the next attempt — comparing only
    // against a text it no longer had — read its own leftovers as a user draft, which R1b correctly
    // refuses to clear. Permanent wedge, polluted input line, human-only recovery.
    try {
      options.beforePaste?.({ issuedText: text });
    } catch (error) {
      return { defer: "paste-record-failed", detail: error.message };
    }

    // Multi-line wake text must arrive as ONE block: bracketed paste, not per-line send-keys. The
    // bracketing is conditional on the application having requested it, which we cannot query — so
    // the RESULT is verified instead of the mode.
    if (!this.tmuxOk(["load-buffer", "-b", PASTE_BUFFER, "-"], text)) return { defer: "load-buffer-failed" };
    if (!this.tmuxOk(["paste-buffer", "-p", "-b", PASTE_BUFFER, "-t", paneId, "-d"])) {
      this.dropPasteBuffer();
      return { defer: "paste-failed" };
    }
    let verdict = { kind: "unreadable" };
    const pasted = this.awaitObservation(
      paneId,
      (observation) => {
        verdict = this.classifyPaste(observation.captured, text);
        return verdict.kind === "exact";
      },
      this.verifyTries,
      this.verifyWaitMs,
    );
    if (!pasted.satisfied) {
      // Bounded cleanup while the composer is still PROVABLY ours: one C-u, then re-observe. This
      // is the only thing that keeps a half-rendered paste from becoming an operator-visible wedge.
      const cleanup = this.clearOurResidue(paneId, texts, verdict.kind);
      return {
        defer: verdict.kind === "clipped" ? "composer-clipped"
          : verdict.kind === "partial" ? "paste-incomplete"
          : "paste-unverified",
        rows: verdict.rows ?? null,
        needRows: verdict.needRows ?? null,
        cleaned: cleanup,
      };
    }

    // WRITE-AHEAD. The record of "a submit was issued" is persisted BEFORE the keystroke, so a
    // crash between the two cannot lose it — the recovering driver finds the record, sees its own
    // text still in the composer, and re-issues Enter under the bounded cap instead of re-pasting.
    try {
      options.beforeSubmit?.({ issuedText: text, nonce, paneId });
    } catch (error) {
      return { defer: "submit-record-failed", detail: error.message };
    }
    if (!this.tmuxOk(["send-keys", "-t", paneId, "Enter"])) {
      // The record stands: the keystroke may or may not have reached the app, and that is exactly
      // the question the confirmation phase answers. It is NOT a free retry.
      return { submitted: true, paneId, issued: false };
    }
    return { submitted: true, paneId, issued: true };
  }

  // Re-issue ONLY the submit keystroke. Called by the confirmation phase after it has positively
  // observed that our text is still sitting in the composer, unsubmitted — never blind.
  reissueSubmit(paneId) {
    return this.tmuxOk(["send-keys", "-t", paneId, "Enter"]);
  }

  // A defer between load-buffer and paste leaves the wake text in a named tmux buffer. Non-secret
  // event metadata, but hygiene: the success path already consumes it with `paste-buffer -d`.
  dropPasteBuffer() {
    this.tmuxOk(["delete-buffer", "-b", PASTE_BUFFER]);
  }

  // One bounded C-u, and only while what is in the composer is provably ours. Returns what happened
  // so the defer line can say whether the operator's input line was left dirty.
  clearOurResidue(paneId, texts, verdictKind) {
    if (verdictKind === "foreign" || verdictKind === "unreadable") return "skipped-not-ours";
    if (!this.tmuxOk(["send-keys", "-t", paneId, "C-u"])) return "clear-failed";
    const cleared = this.awaitObservation(
      paneId,
      (observation) => this.inputState(observation.captured, texts) === "empty",
      this.verifyTries,
      this.verifyWaitMs,
    );
    return cleared.satisfied ? "cleared" : "still-dirty";
  }

  // ⛔ THE CONFIRMATION OBSERVATION — AND EXACTLY ONE ARM MAY ADVANCE READ-STATE.
  //
  //   { outcome: "confirmed" }     composer EMPTY *and* our fresh nonce is rendered above it
  //   { outcome: "unsubmitted" }   pane idle *and* the composer still holds our text exactly
  //   { outcome: "ambiguous", … }  everything else — NEVER a reason to re-type anything
  //
  // The live-turn indicator is now CORROBORATING ONLY. It was a sufficient condition, and the file
  // documented in the same breath that it is not correlated to our action — so a turn the operator
  // started while our Enter was being eaten confirmed our delivery, consumed the message id, reset
  // the streak and raised no alarm: a silently lost wake, the exact class round 1 existed to kill,
  // re-entered through the confirmation machinery round 2 added. It is still reported, because it
  // is useful evidence in the log and it is what a human reads when diagnosing; it can no longer
  // decide anything.
  observeSubmit(pendingSubmit) {
    const pane = this.resolvePane();
    if (pane.defer) return { outcome: "ambiguous", reason: pane.defer };
    const paneId = pane.paneId;
    const observation = this.observe(paneId);
    const state = this.classifyPane(observation.captured, observation.mode);
    if (state === "unreadable") return { outcome: "ambiguous", reason: "confirm-unreadable", paneId };
    const composer = this.inputState(observation.captured, [pendingSubmit.issuedText]);
    const nonce = this.nonceSeen(observation.captured, pendingSubmit.nonce);
    const corroborating = state === "busy";
    if (composer === "empty" && nonce) {
      return { outcome: "confirmed", via: "nonce", paneId, nonce, corroborating };
    }
    if (state === "idle" && this.composerHoldsWake(observation.captured, pendingSubmit.issuedText)) {
      return { outcome: "unsubmitted", paneId, nonce, corroborating };
    }
    return {
      outcome: "ambiguous",
      reason: composer === "empty" && corroborating ? "turn-without-nonce" : state === "busy" ? "busy-unattributed" : "no-turn",
      paneId,
      nonce,
      corroborating,
      composer,
    };
  }
}

const isCodexRow = (args) => /(^|\/|\s)codex(\s|$)/.test(args);
const argvTokens = (args) => args.split(/\s+/).filter(Boolean);

// Return the process rows that are `pid` or descend from it (bounded walk over the ps snapshot).
function descendants(ps, rootPid) {
  const byParent = new Map();
  for (const r of ps) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = ps.find((r) => r.pid === pid);
    if (self) out.push(self);
    for (const child of byParent.get(pid) ?? []) stack.push(child.pid);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Runtime-path and credential hygiene.
//
// The sibling controller validates its runtime directory at start(); this driver did not, so a
// pre-existing group/world-accessible runtime directory was accepted silently and state.json was
// read with a plain readFileSync — a symlink there is followed, and a state file that merely parses
// can set lastMailId arbitrarily high, which silently suppresses every future wake with no alarm
// (nothing becomes pending, so the bounded-silence counter never moves). Both are closed here (F8).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function ensurePrivateRuntimeDirectory(dir, label) {
  try {
    requirePrivateDirectory(dir, label);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    requirePrivateDirectory(dir, label);
  }
}

// wake-core's state shape plus two fields this driver owns. The SCHEMA NUMBER IS DELIBERATELY
// UNCHANGED: schema 1 is a seam shared with the controller and with an in-flight branch that bumps
// it for its own reasons, and additive fields on a `{...defaults, ...parsed}` load need no bump.
//   lastIssuedText — what we last put in the composer, so residue is recognisable across attempts
//   pendingSubmit  — a submit was ISSUED and is awaiting confirmation (the irreversible-step ledger)
function paneState() {
  return { ...initialState(), lastIssuedText: null, pendingSubmit: null };
}

function loadPrivateState(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("state file must be one regular file");
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("state file must be private");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("state file changed during open");
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (parsed.schema !== 1 || parsed.persona !== PERSONA) throw new Error("state identity mismatch");
    return { ...paneState(), ...parsed };
  } catch (error) {
    if (error.code === "ENOENT") return paneState();
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Liveness, readable from OUTSIDE the process (cli.mjs `status` / `doctor` consume this shape).
//
// Bounded silence had one blind spot big enough to drive through: every alarm in this driver is
// raised BY the driver, counting its own deferrals. A driver that is not running defers nothing and
// alarms nothing — the wake stream is simply gone, quietly. The heartbeat file turns that into an
// observable: `absent` = cleanly stopped, `dead` = the recorded pid is gone, `stale` = the process
// exists but has not ticked within its own stated bound.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Read a small private JSON file the way this file reads every other one it trusts: lstat, regular,
// not a symlink, single link, owner, no group/other bits — then O_NOFOLLOW with a dev/ino re-check.
// The heartbeat and the lock used to be read with a bare readFileSync while the state file next to
// them was fully hardened, and a JSON parse error was reported VERBATIM into operator-facing output,
// which embeds the first bytes of whatever the path actually pointed at.
function readPrivateJson(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { error: "not-one-regular-file" };
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return { error: "not-private" };
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return { error: "changed-during-open" };
    return { value: JSON.parse(fs.readFileSync(fd, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { error: "absent" };
    // A FIXED STRING. The parser's message quotes the file's first bytes.
    return { error: error instanceof SyntaxError ? "malformed-json" : (error.code ?? "unreadable") };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readLiveness(heartbeatFile, now = Date.now()) {
  const read = readPrivateJson(heartbeatFile);
  if (read.error === "absent") return { status: "absent", heartbeatFile };
  if (read.error) return { status: "unreadable", heartbeatFile, reason: read.error };
  const parsed = read.value;
  if (parsed?.driver !== "pane-wake" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 1) {
    return { status: "unreadable", heartbeatFile, reason: "identity-mismatch" };
  }
  const staleAfterMs = Number.isSafeInteger(parsed.staleAfterMs) ? parsed.staleAfterMs : HEARTBEAT_STALE_FLOOR_MS;
  const ageMs = now - Date.parse(parsed.ts);
  const eventsOkAt = Date.parse(parsed.eventsOkAt ?? "");
  const eventsAgeMs = Number.isFinite(eventsOkAt) ? now - eventsOkAt : null;
  let alive = true;
  try { process.kill(parsed.pid, 0); } catch (error) { alive = error.code === "EPERM"; }
  const base = {
    pid: parsed.pid,
    ageMs,
    staleAfterMs,
    heartbeatFile,
    awaitingConfirm: Boolean(parsed.awaitingConfirm),
    pending: parsed.pending ?? null,
    eventsFile: parsed.eventsFile ?? null,
    eventsAgeMs,
    eventsError: parsed.eventsError ?? null,
  };
  if (!alive) return { status: "dead", ...base };
  if (!Number.isFinite(ageMs) || ageMs > staleAfterMs) return { status: "stale", ...base };
  // ⛔ BEATING IS NOT HEALTH. A driver whose input stream is missing or has not been readable inside
  // its own bound is NOT alive for any purpose the operator cares about — it will wake nothing, for
  // ever, while reporting a perfect pulse.
  if (parsed.eventsError) return { status: "degraded", reason: parsed.eventsError, ...base };
  if (eventsAgeMs === null || eventsAgeMs > staleAfterMs) return { status: "degraded", reason: "events-path-stale", ...base };
  return { status: "alive", ...base };
}

// Who holds the single-consumer lock, and is that holder still alive? Used only to turn an EEXIST
// into a sentence an operator can act on.
function describeLockHolder(lockFile) {
  const read = readPrivateJson(lockFile);
  if (read.error) return `lock at ${lockFile} is ${read.error}`;
  const holder = read.value;
  if (!Number.isSafeInteger(holder?.pid)) return `lock at ${lockFile} has no usable holder record`;
  let alive = true;
  try { process.kill(holder.pid, 0); } catch (error) { alive = error.code === "EPERM"; }
  return `pid ${holder.pid} (persona ${typeof holder.persona === "string" ? holder.persona : "unknown"}, ${alive ? "RUNNING" : "NOT RUNNING — stale lock"})`;
}

function readPrivateTokenFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    const token = fs.readFileSync(file, "utf8").trim();
    return token.startsWith("kjt_") && token.length >= 20 ? token : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Consumer loop — mirrors controller.mjs's HiveWakeController (proven file-tail + dedupe + reconcile
// mechanics), swapping delivery for PaneDelivery and using HOLD-AND-RETRY instead of go-ambiguous.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
class PaneWakeConsumer {
  constructor(options) {
    this.options = options;
    ensurePrivateRuntimeDirectory(path.dirname(options.stateFile), "state directory");
    ensurePrivateRuntimeDirectory(path.dirname(options.lockFile), "lock directory");
    this.state = loadPrivateState(options.stateFile);
    this.pending = [];
    this.pendingKeys = new Set();
    this.seen = new Set(this.state.recentKeys);
    this.partial = Buffer.from(this.state.partialBase64 || "", "base64");
    this.timer = null;
    this.busy = false;
    this.stopping = false;
    this.lock = null;
    this.failStreak = 0;
    this.nextAttemptAt = 0;
    this.deferReason = null;
    this.deferRepeats = 0;
    this.deferLoggedAt = 0;
    this.alertGap = options.alertAfter;
    this.alertAtStreak = options.alertAfter;
    this.persistedSnapshot = null;
    this.lastHeartbeatAt = 0;
    this.eventsOkAt = null;
    this.eventsError = "events-path-unchecked";
    this.alertRoute = { status: "unchecked" };
    this.delivery = new PaneDelivery({
      tmux: options.tmux,
      paneSession: options.paneSession,
      expectThread: options.expectThread,
      verifyTries: options.verifyTries,
      verifyWaitMs: options.verifyWaitMs,
    });
  }

  log(value) {
    this.options.output(`${JSON.stringify({ ts: new Date().toISOString(), driver: "pane-wake", ...value })}\n`);
  }

  queue(item) {
    if (item.trigger === "mail" && (!Number.isSafeInteger(item.id) || item.id <= this.state.lastMailId)) return;
    const durableDedupe = item.trigger !== "reconcile";
    if ((durableDedupe && this.seen.has(item.key)) || this.pendingKeys.has(item.key)) return;
    this.pending.push(item);
    this.pendingKeys.add(item.key);
    if (this.pending.length > MAX_PENDING) {
      const dropped = this.pending.length;
      this.pending = [{ kind: "reconcile", id: null, key: "reconcile:overflow", trigger: "reconcile" }];
      this.pendingKeys = new Set(["reconcile:overflow"]);
      // Safe by design — read-state is not advanced and the reconcile wake tells the agent to peek
      // the inbox, which is the source of truth — but it was entirely unlogged, so a burst-induced
      // degradation left no trace to find afterwards.
      this.log({ event: "overflow", dropped, cap: MAX_PENDING });
    }
  }

  reconcile(reason) {
    this.queue({ kind: "reconcile", id: null, key: `reconcile:${reason}`, trigger: "reconcile" });
  }

  // The in-memory set is capped at the same 512 as the persisted one (F11): an unbounded Set was
  // materialised into an array on every poll.
  remember(key) {
    this.seen.add(key);
    while (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value;
      this.seen.delete(oldest);
    }
  }

  initializeEventCursor() {
    try {
      const stat = requirePrivateEventFile(this.options.eventsFile);
      this.state.eventFile = { dev: stat.dev, ino: stat.ino };
      this.state.offset = stat.size;
      this.partial = Buffer.alloc(0);
      this.eventsOkAt = Date.now();
      this.eventsError = null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Arming with no event stream is legitimate (the monitor may start later) but it is NOT
      // health: the heartbeat says so from the first beat rather than reporting a clean pulse over
      // an input path that does not exist.
      this.eventsError = "events-file-missing";
      this.state.eventFile = null;
      this.state.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    this.persist();
  }

  // The durable write is fsync + rename + directory fsync. Running it unconditionally once per poll
  // meant that cost every second forever with nothing changed, so it is gated on the serialised
  // state actually differing. `persist()` still throws (callers label the stage); `persistQuiet()`
  // logs and continues, for the paths where losing a write is recoverable but crashing is not.
  persist(patch = {}) {
    // ⛔ COMMIT, THEN PUBLISH. The durable write happens against a CANDIDATE object and the
    // in-memory state is updated only after it returns. The previous order — mutate, then write —
    // inverted the guarantee on its own failure branch: a write that threw left the driver holding
    // a `pendingSubmit` that existed nowhere on disk, the flush precedence handed control to the
    // confirmation phase on the strength of it, and the irreversible keystroke went out with no
    // durable record at all — the precise thing the write-ahead comment said could not happen.
    const candidate = {
      ...this.state,
      ...patch,
      partialBase64: this.partial.toString("base64"),
      recentKeys: [...this.seen].slice(-SEEN_CAP),
    };
    const serialised = JSON.stringify(candidate);
    if (serialised !== this.persistedSnapshot) {
      saveState(this.options.stateFile, candidate);
      this.persistedSnapshot = serialised;
      Object.assign(this.state, candidate);
      return true;
    }
    Object.assign(this.state, candidate);
    return false;
  }

  persistQuiet(patch = {}) {
    try { return this.persist(patch); }
    catch (error) { this.log({ event: "error", stage: "persist", message: error.message }); return false; }
  }

  // Liveness (S1's blind spot). The bounded-silence alarm counts DEFERRALS, so a driver that is not
  // running at all raises nothing: fail-closed and silent. The heartbeat is what makes "the consumer
  // is dead" observable from outside the process — `kijito-codex status`/`doctor` read it.
  // ⛔ A HEARTBEAT THAT ONLY PROVES THE PROCESS IS ALIVE IS THE SAME BLIND SPOT ONE LAYER UP.
  // Measured: delete the monitor's event stream under a running driver and it reported perfect
  // health forever — heartbeat alive, zero alarms, zero deferrals, zero wakes. The read error was
  // swallowed, and with nothing pending the delivery path never runs, so the bounded-silence
  // counter never moves. The record therefore carries the INPUT PATH's own last-good timestamp and
  // its last error, and `readLiveness` treats a stale path as not-alive.
  heartbeat(now, options = {}) {
    if (!options.force && now - this.lastHeartbeatAt < HEARTBEAT_WRITE_MS) return;
    // The bound has to cover a slow attempt, or a single wedged tmux call produces a false `stale`:
    // one delivery attempt can make ~14 subprocess calls, each with its own timeout.
    const staleAfterMs = Math.max(
      HEARTBEAT_STALE_FLOOR_MS,
      this.options.pollMs * HEARTBEAT_STALE_FACTOR,
      attemptBudgetMs() * 2,
    );
    try {
      const temp = `${this.options.heartbeatFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({
        schema: 1,
        driver: "pane-wake",
        persona: PERSONA,
        pid: process.pid,
        ts: new Date(now).toISOString(),
        pollMs: this.options.pollMs,
        staleAfterMs,
        // INPUT-PATH HEALTH. `eventsOkAt` is the last time the event stream was successfully
        // stat-ed; `eventsError` names the current fault. A consumer whose input is gone is not
        // healthy, however briskly it is beating.
        eventsFile: this.options.eventsFile,
        eventsOkAt: this.eventsOkAt ? new Date(this.eventsOkAt).toISOString() : null,
        eventsError: this.eventsError,
        eventsStaleAfterMs: staleAfterMs,
        awaitingConfirm: Boolean(this.state.pendingSubmit),
        pending: this.pending.length,
        failStreak: this.failStreak,
      })}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.options.heartbeatFile);
      this.lastHeartbeatAt = now;
    } catch (error) {
      this.log({ event: "error", stage: "heartbeat", message: error.message });
      this.lastHeartbeatAt = now;                 // do not spin on a broken heartbeat path
    }
  }

  consume(bytes) {
    let combined = Buffer.concat([this.partial, bytes]);
    if (combined.length > MAX_LINE_BYTES && combined.indexOf(0x0a) < 0) {
      combined = Buffer.alloc(0);
      this.reconcile("unterminated-line");
    }
    let start = 0;
    while (true) {
      const newline = combined.indexOf(0x0a, start);
      if (newline < 0) break;
      let line = combined.subarray(start, newline);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      const parsed = parseEventLine(line);
      if (parsed.event) this.queue(parsed.event);
      else if (parsed.reconcile) this.reconcile(parsed.reconcile);
      start = newline + 1;
    }
    this.partial = Buffer.from(combined.subarray(start));
  }

  // Read the event stream. Kept separate from delivery so the two failure kinds cannot wear each
  // other's label (F12): a delivery or persist fault used to be reported as `read-error`, a claim
  // about a stream it had nothing to do with.
  readEvents(now = Date.now()) {
    const stat = requirePrivateEventFile(this.options.eventsFile);
    this.eventsOkAt = now;
    if (this.eventsError !== null) {
      this.log({ event: "events-path-recovered", eventsFile: this.options.eventsFile, wasError: this.eventsError });
      this.eventsError = null;
    }
    const prior = this.state.eventFile;
    if (!prior || prior.dev !== stat.dev || prior.ino !== stat.ino) {
      this.reconcile("rotation-gap");
      this.state.eventFile = { dev: stat.dev, ino: stat.ino };
      this.state.offset = 0;
      this.partial = Buffer.alloc(0);
    } else if (stat.size < this.state.offset) {
      this.reconcile("truncation");
      this.state.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    const available = stat.size - this.state.offset;
    if (available > 0) {
      const length = Math.min(available, MAX_READ_BYTES);
      const fd = fs.openSync(this.options.eventsFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("events file changed during open");
        const buffer = Buffer.alloc(length);
        const count = fs.readSync(fd, buffer, 0, length, this.state.offset);
        this.consume(buffer.subarray(0, count));
        this.state.offset += count;
      } finally { fs.closeSync(fd); }
    }
  }

  poll(now = Date.now()) {
    if (this.stopping || this.busy) return;
    // The heartbeat is written AFTER the read stage, so the record describes the poll that just
    // happened rather than the one before it — a recovery that is not visible until the next tick
    // is a liveness signal that lags the thing it reports on.
    try {
      this.readEvents(now);
    } catch (error) {
      // ⛔ ENOENT USED TO BE SWALLOWED ENTIRELY — no log, no reconcile, no alarm. "The monitor is
      // not writing an event stream" is indistinguishable from "there is no mail", and the second
      // reading was the one the driver took, indefinitely. It is now a NAMED fault that counts
      // toward bounded silence like any other, so the alarm ladder reaches it.
      this.eventsError = error.code === "ENOENT" ? "events-file-missing" : (error.code ?? "events-file-unreadable");
      if (error.code !== "ENOENT") this.reconcile("read-error");
      this.noteDeferral(error.code === "ENOENT" ? "events-path-missing" : "events-path-unreadable", now);
    }
    this.heartbeat(now);
    try {
      this.persist();
    } catch (error) {
      this.log({ event: "error", stage: "persist", message: error.message });
    }
    // Each stage carries its own label and its own guard. An exception escaping here would reach a
    // setInterval callback and take the whole driver down — silently, from the operator's side.
    try {
      this.flush(now);
    } catch (error) {
      this.log({ event: "error", stage: "delivery", message: error.message });
    }
  }

  // ⛔ FLUSH PRECEDENCE. A submit that has been ISSUED but not CONFIRMED owns the driver: while
  // `state.pendingSubmit` is set, the confirmation phase runs and NO new delivery may start. That
  // ordering is the whole fix for the resubmission defect — the old loop treated "I could not
  // confirm" as "try the entire sequence again", and re-typed the same id-bearing wake into the
  // operator's live pane once per backoff interval, forever.
  flush(now = Date.now()) {
    if (this.busy || this.stopping) return;
    if (now < this.nextAttemptAt) return;
    if (this.state.pendingSubmit) {
      this.busy = true;
      try { this.confirmSubmit(now); }
      catch (error) {
        this.log({ event: "error", stage: "confirm", message: error.message });
        this.nextAttemptAt = now + Math.max(CONFIRM_POLL_MS, this.options.pollMs);
      }
      finally { this.busy = false; }
      return;
    }
    if (this.pending.length === 0) return;
    this.busy = true;
    try {
      // Deliver the whole pending set as one wake (matches controller batching): the wake text names
      // all pending message ids, and a single turn drains them. Keep the batch pending until confirmed.
      const batch = this.pending.map(({ kind, id, key, trigger }) => ({ kind, id, key, trigger }));
      const priorText = this.state.lastIssuedText;
      let result;
      try {
        result = this.delivery.deliver(batch, {
          priorText,
          // Ledger BEFORE the mutating step: what we are about to put in the composer, recorded so
          // that any residue left by a failed paste is still recognisably ours.
          beforePaste: ({ issuedText }) => this.persist({ lastIssuedText: issuedText }),
          // Write-ahead record of the irreversible step, persisted before the keystroke.
          beforeSubmit: ({ issuedText, nonce }) => this.persist({
            lastIssuedText: issuedText,
            pendingSubmit: {
              keys: batch.map((item) => item.key),
              mailIds: batch.filter((item) => item.trigger === "mail").map((item) => item.id),
              issuedText,
              nonce,
              issuedAt: new Date(now).toISOString(),
              attempts: 0,
              reissues: 0,
            },
          }),
        });
      } catch (error) {
        this.log({ event: "error", stage: "delivery", message: error.message });
        result = { defer: "delivery-error" };
      }
      if (result.submitted) {
        this.log({
          event: "submitted",
          paneId: result.paneId,
          keystrokeAccepted: result.issued === true,
          batch,
        });
        this.heartbeat(now, { force: true });          // a long attempt must not read as stale
        // Give the TUI a moment, then confirm on the next flush. Nothing is consumed yet.
        this.nextAttemptAt = now + CONFIRM_SETTLE_MS;
      } else {
        this.noteDeferral(result.defer, now, {
          rows: result.rows ?? null,
          needRows: result.needRows ?? null,
          cleaned: result.cleaned ?? null,
        });
      }
    } finally {
      this.busy = false;
    }
  }

  // ⛔ THE BOUNDED CONFIRMATION PHASE. Exactly one branch consumes a message id, and no branch
  // re-types the wake text. See PaneDelivery.observeSubmit for the three outcomes.
  confirmSubmit(now) {
    const pendingSubmit = this.state.pendingSubmit;
    // ⛔ AGE BOUND — A PERSISTED RECORD IS EVIDENCE ABOUT A SCREEN, AND SCREENS EXPIRE.
    // `issuedAt` was written and never read. A record recovered from disk was confirmed against
    // whatever the pane happened to show at the time — measured: a nine-day-old record consumed a
    // message id on a cold start, logged `delivered` with an empty batch, and raised no alarm. A
    // record older than the phase's own worst-case duration cannot be about the current screen.
    const issuedAt = Date.parse(pendingSubmit.issuedAt ?? "");
    const budget = submitAgeBudgetMs(this.options.pollMs);
    if (!Number.isFinite(issuedAt) || now - issuedAt > budget) {
      this.abandonSubmit(pendingSubmit, "stale-record", now, { ageMs: Number.isFinite(issuedAt) ? now - issuedAt : null, budgetMs: budget });
      return;
    }
    let observation;
    try {
      observation = this.delivery.observeSubmit(pendingSubmit);
    } catch (error) {
      this.log({ event: "error", stage: "confirm", message: error.message });
      observation = { outcome: "ambiguous", reason: "confirm-error" };
    }
    pendingSubmit.attempts += 1;
    this.nextAttemptAt = now + Math.max(CONFIRM_POLL_MS, this.options.pollMs);
    this.heartbeat(now, { force: true });

    if (observation.outcome === "confirmed") {
      this.consumeSubmitted(pendingSubmit, observation);
      return;
    }

    if (observation.outcome === "unsubmitted") {
      // POSITIVELY not submitted: our text is still in the composer and the pane is idle, so the
      // keystroke never reached the app (a pane mode eats send-keys while tmux still exits 0).
      // Re-issue the KEYSTROKE ONLY — never the paste, never the text — and only under the cap.
      if (pendingSubmit.reissues >= REISSUE_CAP) {
        this.abandonSubmit(pendingSubmit, "reissue-cap", now);
        return;
      }
      pendingSubmit.reissues += 1;
      this.persistQuiet();
      const issued = this.delivery.reissueSubmit(observation.paneId);
      this.log({
        event: "submit-reissued",
        paneId: observation.paneId,
        reissues: pendingSubmit.reissues,
        attempts: pendingSubmit.attempts,
        keystrokeAccepted: issued,
      });
      return;
    }

    // AMBIGUOUS. We cannot tell, so we do NOTHING to the pane and keep observing under a cap.
    if (pendingSubmit.attempts >= CONFIRM_CAP) {
      this.abandonSubmit(pendingSubmit, observation.reason ?? "unconfirmed", now);
      return;
    }
    this.persistQuiet();
    this.log({
      event: "awaiting-confirm",
      reason: observation.reason ?? null,
      attempts: pendingSubmit.attempts,
      cap: CONFIRM_CAP,
      composer: observation.composer ?? null,
      // The evidence, every time, so the first live probe answers "is the nonce renderable?" from
      // the log alone rather than from a second experiment.
      nonceSeen: observation.nonce ?? false,
      corroborating: observation.corroborating ?? false,
    });
  }

  // The ONE place a message id is consumed.
  consumeSubmitted(pendingSubmit, observation) {
    const keys = new Set(pendingSubmit.keys);
    const delivered = this.pending.filter((item) => keys.has(item.key));
    if (pendingSubmit.mailIds.length) {
      this.state.lastMailId = Math.max(this.state.lastMailId, ...pendingSubmit.mailIds);
    }
    // Dedupe keys come from the SUBMITTED record, not from what happens to be pending now: the two
    // are normally the same set, and when they are not it is the record that says what was sent.
    for (const key of pendingSubmit.keys) if (!key.startsWith("reconcile:")) this.remember(key);
    this.pending = this.pending.filter((item) => !keys.has(item.key));
    this.pendingKeys = new Set(this.pending.map((item) => item.key));
    // ⛔ ONLY HERE. Resetting the streak anywhere else disarms the bounded-silence alarm with the
    // very failure it exists to catch.
    this.failStreak = 0;
    this.nextAttemptAt = 0;
    this.deferReason = null;
    this.deferRepeats = 0;
    this.alertGap = this.options.alertAfter;
    this.alertAtStreak = this.options.alertAfter;
    this.persistQuiet({ pendingSubmit: null, lastIssuedText: null });
    this.log({
      event: "delivered",
      paneId: observation.paneId,
      via: observation.via,
      attempts: pendingSubmit.attempts,
      // The consuming line carries the evidence that promoted it, not just the label: a log reader
      // must be able to audit a read-state advance from one line.
      nonceSeen: observation.nonce ?? false,
      corroborating: observation.corroborating ?? false,
      keys: pendingSubmit.keys,
      mailIds: pendingSubmit.mailIds,
      batch: delivered.map(({ kind, id, key, trigger }) => ({ kind, id, key, trigger })),
    });
  }

  // Give up on a submission we can neither confirm nor disprove. NOTHING is consumed: the ids stay
  // unread, so the inbox — which is the source of truth — still holds them, and the next wake (a new
  // event, or the reconcile every arm performs) surfaces them. The batch is dropped from `pending`
  // so the driver cannot immediately re-enter the same submit/confirm cycle, and the abandonment
  // ALARMS: an unresolvable submission must never be quiet.
  abandonSubmit(pendingSubmit, reason, now, detail = {}) {
    const keys = new Set(pendingSubmit.keys);
    const dropped = this.pending.filter((item) => keys.has(item.key));
    this.pending = this.pending.filter((item) => !keys.has(item.key));
    this.pendingKeys = new Set(this.pending.map((item) => item.key));
    this.persistQuiet({ pendingSubmit: null });
    this.failStreak += 1;
    this.nextAttemptAt = now + BACKOFF_CAP_MS;
    // Route through the same escalation accounting as any other failure: a run made only of
    // abandonments used to leave `alertAtStreak` behind the streak, so the re-alert ladder never
    // advanced even though the pipeline was failing repeatedly.
    if (this.failStreak >= this.alertAtStreak) {
      this.alertGap = Math.min(this.alertGap * 2, ALERT_GAP_CAP);
      this.alertAtStreak = this.failStreak + this.alertGap;
    }
    this.log({
      event: "alert",
      kind: "submit-abandoned",
      reason,
      ...detail,
      attempts: pendingSubmit.attempts,
      reissues: pendingSubmit.reissues,
      consumed: false,
      failStreak: this.failStreak,
      dropped: dropped.map((item) => item.key),
      channel: this.options.token ? "hive" : "log-only",
      alertRoute: this.alertRoute.status,
    });
    this.hiveNote(
      `codex pane-wake abandoned an unconfirmed submission (${reason}) after ${pendingSubmit.attempts} ` +
      `observation(s) and ${pendingSubmit.reissues} re-issue(s). NO message id was consumed, so the ` +
      `inbox still holds ${dropped.length} event(s) for codex; the next wake surfaces them. Check the ` +
      `live Codex pane — the wake text may be sitting unsubmitted in the composer.`,
    );
  }

  noteDeferral(reason, now, detail = {}) {
    this.failStreak += 1;
    this.deferRepeats = reason === this.deferReason ? this.deferRepeats + 1 : 1;
    const changed = reason !== this.deferReason;
    this.deferReason = reason;
    const backoffMs = Math.min(BACKOFF_CAP_MS, this.options.pollMs * 2 ** Math.min(this.failStreak - 1, 20));
    this.nextAttemptAt = now + backoffMs;
    const alerting = this.failStreak >= this.alertAtStreak;
    if (changed || alerting || now - this.deferLoggedAt >= DEFER_LOG_MIN_INTERVAL_MS) {
      this.deferLoggedAt = now;
      this.log({
        event: "deferred",
        reason,
        ...detail,
        repeats: this.deferRepeats,
        failStreak: this.failStreak,
        pending: this.pending.length,
        backoffMs,
      });
    }
    this.maybeAlert(reason);
  }

  // S1: bounded silence. After a threshold of consecutive deferrals, surface an alert (log line +
  // hive note) while continuing to hold read-state, then RE-ALERT on a widening schedule while the
  // streak persists — a single latched alert meant one failed POST was the whole guarantee.
  maybeAlert(reason) {
    if (this.failStreak < this.alertAtStreak) return;
    const channel = this.options.token ? "hive" : "log-only";
    this.log({
      event: "alert",
      kind: "bounded-silence",
      reason,
      failStreak: this.failStreak,
      pending: this.pending.length,
      channel,
      alertRoute: this.alertRoute.status,
    });
    this.alertGap = Math.min(this.alertGap * 2, ALERT_GAP_CAP);
    this.alertAtStreak = this.failStreak + this.alertGap;
    this.hiveNote(
      `codex pane-wake bounded-silence: ${this.failStreak} consecutive deferrals (${reason}); ` +
      `${this.pending.length} event(s) held for codex. Pane closed/moved/busy? Read-state is held; ` +
      `wake resumes automatically when the live Codex pane is reachable again.`,
    );
  }

  // ⛔ PRESENCE ≠ FIRES, APPLIED TO THE TRANSPORT — AND THREE OUTCOMES, NOT TWO.
  //
  // A configured alert channel is not a working one: the URL was wrong for this driver's entire
  // life and nothing said so, because "we sent it" was the only thing ever checked. At arm time the
  // route is now PROBED with a GET — no body, so nothing can be sent — and the result is one of:
  //
  //   NON-404 (405 / 401 / 2xx)  → the route EXISTS          → arm normally, "verified present"
  //   404                        → the route is ABSENT       → arm and announce DEAD
  //   timeout / network / throw  → we DO NOT KNOW            → arm and announce UNVERIFIED
  //
  // The third case is the one worth being pedantic about. Collapsing "I could not reach the server"
  // into "the route is dead" is the crying-wolf failure: the operator learns that the DEAD line
  // sometimes means nothing, and then it means nothing when it is true. It is the same mistake as
  // scoring an unreadable pane as a delivered wake, one layer out — a failed OBSERVATION is not an
  // observed FAILURE. So the two get distinct strings and a reader never has to guess which.
  //
  // The probe carries the same bearer the transport uses, and it has to: measured, this API
  // authenticates BEFORE it routes, so an unauthenticated probe answers 401 for every path,
  // including paths that do not exist. An unauthenticated "not 404" check would therefore have
  // passed for the very URL that was broken — the exact blindness this probe exists to end.
  //
  // It is bounded at ALERT_ROUTE_TIMEOUT_MS and NEVER blocks arming: fired and forgotten, every
  // throw inside it resolves to UNVERIFIED, and its own logging cannot throw outward. A driver that
  // refused to arm because a health probe timed out would have turned a diagnostic into an outage.
  probeAlertRoute() {
    if (!this.options.token) return;              // the dead-channel announcement already covers it
    try {
      this.checkAlertRoute().catch(() => this.recordAlertRoute("unverified", null, "probe-rejected"));
    } catch (error) {
      this.recordAlertRoute("unverified", null, error?.message ?? "probe-threw");
    }
  }

  async checkAlertRoute() {
    let httpStatus = null;
    try {
      // GET carries no body and cannot send a message. The bearer is required because this API
      // authenticates BEFORE it routes: unauthenticated, every path answers 401 — including paths
      // that do not exist — so an unauthenticated probe could not tell present from absent at all.
      const response = await fetch(HIVE_SEND_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${this.options.token}`, "user-agent": "Mozilla/5.0" },
        redirect: "error",
        signal: AbortSignal.timeout(ALERT_ROUTE_TIMEOUT_MS),
      });
      await response.text().catch(() => "");
      httpStatus = response.status;
    } catch (error) {
      this.recordAlertRoute("unverified", null, error?.message ?? String(error));
      return;
    }
    if (!Number.isFinite(httpStatus)) { this.recordAlertRoute("unverified", null, "no status"); return; }
    this.recordAlertRoute(httpStatus === 404 ? "dead" : "present", httpStatus, null);
  }

  recordAlertRoute(status, httpStatus, detail) {
    this.alertRoute = { status, httpStatus };
    const line = {
      present: "alert channel verified present",
      dead: `alert channel DEAD (404 ${HIVE_SEND_URL}): every bounded-silence alert will 404 and no human will be told`,
      unverified: `alert channel UNVERIFIED at arm (timeout/network): ${HIVE_SEND_URL} could not be reached, so it is neither confirmed live nor confirmed dead`,
    }[status];
    this.logQuiet({
      event: "alert-route",
      status: status === "present" ? "present" : status.toUpperCase(),
      httpStatus,
      url: HIVE_SEND_URL,
      timeoutMs: ALERT_ROUTE_TIMEOUT_MS,
      detail: detail === null ? line : `${line} [${detail}]`,
    });
  }

  logQuiet(value) {
    try { this.log(value); } catch { /* a detached stdout must not take the driver down */ }
  }

  // The alert POST is issued IN PROCESS. It used to shell out to curl with the credential as a
  // command-line argument, which publishes it to the process table for the life of the child — in a
  // driver that reads that same process table once per delivery attempt (F5).
  hiveNote(content) {
    if (!this.options.token) return;
    for (const to of ["assay", "codex"]) {
      // ⛔ THE HANDLER ITSELF MUST NOT THROW. `this.log` writes to stdout, which for a detached
      // driver can EPIPE; a throw inside a .catch becomes an unhandled rejection and node kills the
      // process by default — turning a transient logging failure into the outage the alarm exists
      // to prevent, and killing the only thing that could report it.
      this.postHiveNote(to, content).catch((error) => {
        try { this.log({ event: "alert-transport", to, status: "failed", message: error.message }); }
        catch { /* the transport failure is already unreportable; do not compound it */ }
      });
    }
  }

  async postHiveNote(to, content) {
    // The body is composed by hiveNoteBody so a test can assert the exact contract without a
    // network call, and so there is one place where the field names live.
    const response = await fetch(HIVE_SEND_URL, {
      method: "POST",
      headers: {
        // The credential lives only in this header, in this process's memory. It is never logged,
        // never persisted, never placed in an argument vector, and never in the injected text.
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
      },
      body: JSON.stringify(hiveNoteBody(to, content)),
      // Defence in depth: undici already strips `authorization` across an origin change, and this
      // endpoint is a constant, so a redirect here would be an anomaly rather than a route.
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    await response.text().catch(() => "");            // drain; the body is never logged
    this.log({ event: "alert-transport", to, status: response.ok ? "sent" : "rejected", httpStatus: response.status });
  }

  start() {
    ensurePrivateRuntimeDirectory(path.dirname(this.options.stateFile), "state directory");
    ensurePrivateRuntimeDirectory(path.dirname(this.options.lockFile), "lock directory");
    // R2: ONE lock file, shared with controller.mjs by construction (see parseArgs) — they cannot
    // both run. A held lock is reported with its holder and whether that holder is still alive,
    // because "EEXIST" alone cannot tell a running sibling from a lock left behind by a SIGKILL.
    try {
      this.lock = acquireLock(this.options.lockFile);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = describeLockHolder(this.options.lockFile);
      throw new Error(`single-consumer lock is held: ${holder}. Stop that consumer (or remove the stale lock file ${this.options.lockFile}) before arming.`);
    }
    try {
      // Recorded, not gated: state.threadId was declared by wake-core and never written, so the
      // state file could not say which thread an arm was bound to. It is written before the first
      // persist. It is deliberately NOT used as a refusal condition — a legitimately new Codex
      // thread must be able to arm without a human editing the state file.
      this.state.threadId = this.options.expectThread;
      this.initializeEventCursor();
      // Restart durability. A submission that was in flight when the driver died is NOT re-sent:
      // the confirmation phase resumes on the persisted record, and the startup reconcile means the
      // inbox gets peeked either way.
      if (this.state.pendingSubmit) {
        this.log({
          event: "resuming-confirm",
          issuedAt: this.state.pendingSubmit.issuedAt,
          attempts: this.state.pendingSubmit.attempts,
          keys: this.state.pendingSubmit.keys,
        });
      }
      this.reconcile("startup");
      this.heartbeat(Date.now());
      this.flush();
      this.timer = setInterval(() => this.poll(), this.options.pollMs);
      // An alert channel that is dead must SAY SO at arm time. Returning null from the token read
      // and carrying on meant the only bounded-silence guarantee was off with no log line naming it,
      // while later `alert` lines still asserted an alert had gone out.
      if (!this.options.token) {
        this.log({
          event: "alert-channel-unavailable",
          detail: "bounded-silence alerts will be LOG ONLY; no hive note can be sent",
          tokenFile: this.options.tokenFile ?? null,
        });
      }
      this.probeAlertRoute();
      this.log({
        event: "armed",
        paneSession: this.options.paneSession,
        expectThread: this.options.expectThread,
        pollMs: this.options.pollMs,
        alertAfter: this.options.alertAfter,
        alertChannel: this.options.token ? "hive" : "log-only",
        lockFile: this.options.lockFile,
        heartbeatFile: this.options.heartbeatFile,
      });
    } catch (error) {
      releaseLock(this.lock);
      this.lock = null;
      throw error;
    }
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    releaseLock(this.lock);
    this.lock = null;
    // The heartbeat is removed on a CLEAN exit, so "absent" means stopped and "stale" means died.
    try { fs.unlinkSync(this.options.heartbeatFile); } catch { /* never block shutdown on this */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Argument parsing. Every option is validated HERE, so a typo cannot silently disable a control:
// `--expect-thread-id` used to parse fine, leave the thread check unset, and arm anyway; an
// `--alert-after` of 1e9 used to turn the bounded-silence alarm off with no error (`--poll-ms`, one
// line above it, was range-checked).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const ALLOWED_OPTIONS = new Set([
  "events", "state", "lock", "runtime", "install-root", "heartbeat", "tmux", "pane-session",
  "expect-thread", "poll-ms", "alert-after", "token-file",
]);
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PANE_SESSION_RE = /^[^\t\n]{1,64}$/;

function integerOption(values, key, fallback, min, max) {
  const raw = values[key];
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

// The runtime directory an install committed to, or null when there is no install. Read through the
// same private-file gate as everything else; a manifest that fails it is treated as absent.
function installedRuntimeDirectory(installRoot) {
  const read = readPrivateJson(path.join(installRoot, "installed-manifest.json"));
  if (read.error) return null;
  const runtime = read.value?.paths?.runtime;
  return typeof runtime === "string" && path.isAbsolute(runtime) ? runtime : null;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument ${flag ?? ""}`);
    }
    const key = flag.slice(2);
    if (!ALLOWED_OPTIONS.has(key)) throw new Error(`unknown option --${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate option --${key}`);
    values[key] = argv[index + 1];
  }
  // REQUIRED (F10): with no thread id the guarantee degrades to "the single pane in this session
  // whose foreground command is codex", which is not a thread check at all.
  const expectThread = values["expect-thread"] ?? "";
  if (!THREAD_ID_RE.test(expectThread)) {
    throw new Error("--expect-thread is required and must be a whitespace-free thread id token");
  }
  const paneSession = values["pane-session"] ?? "codex";
  if (!PANE_SESSION_RE.test(paneSession)) throw new Error("--pane-session must be a single-line name");
  const tmux = values.tmux ?? "tmux";
  if (tmux.length === 0) throw new Error("--tmux must not be empty");
  // ⛔ R2 IS A PATH FACT, NOT A CLAIM. The header says this driver and controller.mjs share ONE
  // single-consumer lock and therefore cannot both run. That was FALSE under the shipped defaults:
  // the controller derives its lock from <installRoot>/runtime/consumer.lock while this driver
  // defaulted to its own <installRoot>/runtime-pane/consumer.lock — two locks, one event stream,
  // both consumers armable at once, every event waking twice. The live arm papered over it by
  // passing --lock explicitly, which is an operator convention, not a guarantee.
  //
  // So the default lock is now DERIVED FROM THE SAME SOURCE the controller derives its own from —
  // the install root — and the driver's own state lives beside it under runtime-pane.
  //
  // KNOWN INTERACTION, stated rather than fixed: arming this driver BEFORE running the codex
  // installer creates <installRoot>/runtime, and install.mjs refuses to install over an existing
  // install root. That ordering cost is the price of the shared lock path, and the two cannot both
  // be had — a lock outside the install root is a lock the controller does not use, which is the
  // defect this block exists to close. Install first, or remove the directory.
  const installRoot = path.resolve(values["install-root"] ?? path.join(os.homedir(), ".local", "share", "codex-kijito-hive"));
  const runtime = path.resolve(values.runtime ?? path.join(installRoot, "runtime-pane"));
  // ONE DERIVATION, not two agreeing strings. When an install exists, its manifest already records
  // the runtime directory the controller was installed to use, so the lock is read from THERE
  // rather than recomputed from a rule that has to be kept in sync by hand. The computed path stays
  // as the fallback for a repo-run driver with no install.
  const installedRuntime = installedRuntimeDirectory(installRoot);
  const lockFile = path.resolve(values.lock ?? path.join(installedRuntime ?? path.join(installRoot, "runtime"), "consumer.lock"));
  return {
    installRoot,
    eventsFile: path.resolve(values.events ?? path.join(os.homedir(), ".cache", "kijito-inbox-monitor", "events.codex.ndjson")),
    stateFile: path.resolve(values.state ?? path.join(runtime, "state.json")),
    lockFile,
    // Next to the LOCK, not next to the state: the lock directory is the one both consumers and the
    // status tool already know how to find.
    heartbeatFile: path.resolve(values.heartbeat ?? path.join(path.dirname(lockFile), "pane-wake.heartbeat")),
    tokenFile: path.resolve(values["token-file"] ?? path.join(os.homedir(), ".claude", ".kijito_api_token")),
    tmux,
    paneSession,
    expectThread,
    pollMs: integerOption(values, "poll-ms", 1000, 200, 60_000),
    alertAfter: integerOption(values, "alert-after", 10, 1, 1000),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const consumer = new PaneWakeConsumer({
    ...options,
    token: readPrivateTokenFile(options.tokenFile),
    output: (text) => process.stdout.write(text),
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    consumer.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  consumer.start();
}

// `file://${process.argv[1]}` compared a raw path against a URL: under an install path containing a
// space (or anything else URL-encodable) it is false, and the driver starts, runs nothing, exits 0,
// and arms nothing — with no wake and no alarm (F13). The entry path is ALSO resolved before the
// comparison, because import.meta.url is already realpath-resolved: an install reached through a
// symlinked parent (/var -> /private/var on darwin, or any versioned install symlink) is the same
// silent no-op arm by a different route, measured here.
function invokedAsMain(entry) {
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsMain(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

export { PaneDelivery, PaneWakeConsumer, descendants, parseArgs, readLiveness, HIVE_SEND_URL, hiveNoteBody };
