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
// instruction. No thread/inject_items, no thread/steer, nothing starts at login. See the amendment
// note in codex-kijito-parity-plan.md.
//
// BINDING CONSTRAINTS (assay 5696 + amendments 5703/5717), implemented below:
//   (a) pane identity verified AT SEND TIME (enumerate + foreground fingerprint), never a cached
//       pane id or host mapping.
//   (b) abort-on-mismatch: any verification failure holds read-state and retries; never inject an
//       unverified pane.
//   (c) idempotent single wake per event (wake-core dedupe + pane-level clean-slate before inject).
//   (d) delivery is confirmed BY EFFECT (the pane leaves the awaiting-input state), never by our own
//       "sent" self-report; read-state advances only after that confirmation.
//   (e) no wrong-host probe: pane discrimination is LOCAL tmux enumeration only.
//   R1  clear the input line before every injection so a retry starts from an empty prompt.
//   R1b NEVER clobber a user-authored draft: only clear/inject when the input line is empty or holds
//       solely residue of our own prior partial wake text; otherwise DEFER.
//   R2  this driver and controller.mjs share the single-consumer lock — they cannot both run; the
//       controller must be stopped (and its auto-start, if any, disabled) before this driver arms.
//   S1  after N consecutive verification/delivery failures, emit a bounded-silence alert while
//       continuing to hold read-state — a closed/moved pane must never become invisible false-quiet.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_LINE_BYTES,
  MAX_READ_BYTES,
  MAX_PENDING,
  WAKE_PREFIX,
  parseEventLine as coreParseEventLine,
  fixedWakeText as coreFixedWakeText,
  loadState as coreLoadState,
  saveState,
  acquireLock as coreAcquireLock,
  releaseLock,
  requirePrivateEventFile,
} from "../_shared/wake-core.mjs";

// This driver IS the codex provider, so it binds the persona wake-core refuses to default.
const PERSONA = "codex";
const parseEventLine = (line) => coreParseEventLine(line, PERSONA);
const fixedWakeText = (batch) => coreFixedWakeText(batch, PERSONA);
const loadState = (file) => coreLoadState(file, PERSONA);
const acquireLock = (file) => coreAcquireLock(file, PERSONA);

// The tmux paste buffer name is fixed and private to this driver, so a retry always overwrites the
// same buffer rather than leaking one buffer per attempt.
const PASTE_BUFFER = "kijito-codex-wake";

// The Codex empty-input placeholder ghost text (observed). Treated as "empty" for R1b.
const PLACEHOLDER = "Find and fix a bug in @filename";

function sleepMs(ms) {
  // Synchronous wait without a busy loop (Atomics.wait on a throwaway buffer).
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pane delivery — the Codex-specific half. Every method fails CLOSED: an unreadable or ambiguous
// observation returns "not ready", never a guess, because the cost of a wrong guess is injecting into
// the operator's live session at the wrong moment.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
class PaneDelivery {
  constructor(options) {
    this.tmux = options.tmux;                 // tmux binary path
    this.sessionName = options.paneSession;   // durable session identity (e.g. "codex")
    this.expectThread = options.expectThread; // optional thread-id cross-check in the pane's argv
    this.log = options.log;
  }

  tmuxOut(args, input = undefined) {
    // Returns stdout as string, or null if tmux itself failed (server gone, pane gone, etc.).
    try {
      return execFileSync(this.tmux, args, {
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
    } catch {
      return null;
    }
  }

  tmuxOk(args, input = undefined) {
    return this.tmuxOut(args, input) !== null;
  }

  // (a)+(e): enumerate LOCAL panes and return the single pane whose session name and foreground
  // process fingerprint identify the operator's Codex CLI. Returns { paneId, panePid } or a
  // { defer } reason (0 matches, >1 matches, or tmux unavailable) — never a cached id.
  resolvePane() {
    const raw = this.tmuxOut([
      "list-panes", "-a", "-F",
      "#{pane_id}\t#{pane_pid}\t#{session_name}\t#{pane_current_command}",
    ]);
    if (raw === null) return { defer: "tmux-unavailable" };
    const ps = this.psTree();
    if (ps === null) return { defer: "ps-unavailable" };
    const candidates = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const [paneId, panePid, session, cmd] = line.split("\t");
      if (session !== this.sessionName) continue;
      if (cmd !== "codex") continue;
      if (!this.fingerprintOk(panePid, ps)) continue;
      candidates.push({ paneId, panePid });
    }
    if (candidates.length === 0) return { defer: "no-codex-pane" };
    if (candidates.length > 1) return { defer: "ambiguous-codex-pane" };
    return candidates[0];
  }

  // Foreground fingerprint: the pane's process subtree must contain a `codex` process, and — if an
  // expected thread id is configured — an argv resuming exactly that thread. This is what makes the
  // identity a live measurement rather than a remembered pane number.
  fingerprintOk(panePid, ps) {
    const subtree = descendants(ps, panePid);
    const codexRows = subtree.filter((r) => / codex(\s|$)/.test(` ${r.args}`) || r.args.includes("/codex "));
    if (codexRows.length === 0 && !ps.some((r) => r.pid === panePid && r.args.includes("codex"))) return false;
    if (this.expectThread) {
      return subtree.some((r) => r.args.includes(`resume ${this.expectThread}`))
        || ps.some((r) => r.pid === panePid && r.args.includes(`resume ${this.expectThread}`));
    }
    return true;
  }

  psTree() {
    // Read-only process inspection (no host probe — local ps only).
    try {
      const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 5000 });
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

  // (d): the awaiting-input signature, read ONLY from the bottom UI CHROME — never the transcript.
  // Findings 1-3 were one class: reading UI state from free-text transcript content (bare words like
  // "running" or "do you trust" appear in ordinary chat prose and false-triggered vocabulary
  // regexes). The chrome is structural: the LAST › line is the input prompt; the chat STATUS BAR
  // (the ·-separated model/cwd line) must sit BELOW it — dialogs REPLACE the chrome, so its absence
  // is the dialog signal, with no vocabulary involved. The live-turn indicator renders within a few
  // lines above the prompt and is matched by its SHAPE ("• Working (3s • esc to interrupt)"), not by
  // bare words. Anything not positively readable as idle chrome defers (fail closed).
  awaitingInput(captured) {
    if (captured === null) return false;
    const vis = captured.split("\n").map((l) => visible(l).replace(/\s+$/g, ""));
    let promptIdx = -1;
    for (let i = vis.length - 1; i >= 0; i -= 1) {
      if (vis[i].trimStart().startsWith("›")) { promptIdx = i; break; }
    }
    if (promptIdx < 0) return false;                        // no input caret at all
    let statusIdx = -1;
    for (let i = promptIdx + 1; i < vis.length; i += 1) {
      if (/\s·\s/.test(vis[i])) { statusIdx = i; break; }
    }
    if (statusIdx < 0) return false;                        // no status bar below the prompt ⇒ dialog/unknown chrome
    // The indicator line sits just above the prompt block (observed offset ≤2 lines + blanks; use a
    // 4-line margin). Transcript bleed into this window can only DEFER, never inject.
    const region = vis.slice(Math.max(0, promptIdx - 4), statusIdx + 1);
    // Fully structural indicator arms — both require the TIMER DIGITS ("• Working (1s",
    // "(1s • esc to interrupt)"), because a short model reply sits inside this window and can
    // contain "esc to interrupt" or "working" as PROSE (measured in the seeded de-risk). Prose
    // can only false-match by quoting the exact indicator syntax, and that direction defers.
    const working = /(•\s*(Working|Thinking|Running|Generating)\s*\(\s*\d+|\(\s*\d+\s*[smh][^)]*esc to interrupt[^)]*\))/i;
    if (region.some((l) => working.test(l))) return false;  // a live turn is running
    return true;
  }

  // R1b: read the input line. Return "empty" (ghost/blank), "own-residue" (only our wake text
  // fragments), or "user-draft" (anything else — do not touch). Stage-1 de-risk finding: the ghost
  // placeholder STRING rotates ("Summarize recent commits" observed), so ghost is discriminated by
  // its DIM (SGR faint) rendering, never by a placeholder allowlist.
  inputState(captured) {
    if (captured === null) return "unreadable";
    const lines = captured.replace(/\s+$/g, "").split("\n");
    const rawLine = [...lines].reverse().find((l) => visible(l).trimStart().startsWith("›"));
    if (rawLine === undefined) return "unreadable";
    const body = visible(rawLine).replace(/^\s*›\s?/, "").trim();
    if (body === "") return "empty";
    if (body.startsWith(WAKE_PREFIX) || WAKE_PREFIX.startsWith(body)) return "own-residue";
    if (isDimBody(rawLine)) return "empty";        // dim ⇒ ghost placeholder, not a user draft
    return "user-draft";
  }

  // Deliver the wake text into the verified pane. Returns { delivered: true } only after confirming
  // BY EFFECT that the pane left the awaiting-input state; otherwise { defer: reason } with read-state
  // held. Never throws for an expected condition.
  deliver(text) {
    const pane = this.resolvePane();
    if (pane.defer) return { defer: pane.defer };
    const before = this.capture(pane.paneId);
    if (!this.awaitingInput(before)) return { defer: "not-awaiting-input" };

    const input = this.inputState(before);
    if (input === "user-draft") return { defer: "user-draft-present" };
    if (input === "unreadable") return { defer: "input-unreadable" };

    // R1: start from a clean prompt. Safe now — input is empty or our own residue.
    if (!this.tmuxOk(["send-keys", "-t", pane.paneId, "C-u"])) return { defer: "clear-failed" };

    // Multi-line wake text must arrive as ONE block: bracketed paste, not per-line send-keys.
    if (!this.tmuxOk(["load-buffer", "-b", PASTE_BUFFER, "-"], text)) return { defer: "load-buffer-failed" };
    if (!this.tmuxOk(["paste-buffer", "-p", "-b", PASTE_BUFFER, "-t", pane.paneId, "-d"])) {
      return { defer: "paste-failed" };
    }
    // Submit.
    if (!this.tmuxOk(["send-keys", "-t", pane.paneId, "Enter"])) {
      // Text is in the input line but not submitted: UNDELIVERED and pane DIRTY. The next attempt's
      // R1b will see own-residue and clear it. Hold read-state.
      return { defer: "submit-failed-dirty" };
    }

    // (d) confirm BY EFFECT: the pane must leave awaiting-input (a turn started). Poll briefly.
    const started = this.confirmTurnStarted(pane.paneId);
    if (!started) return { defer: "no-turn-effect" };
    return { delivered: true, paneId: pane.paneId };
  }

  confirmTurnStarted(paneId, tries = 10, waitMs = 300) {
    for (let i = 0; i < tries; i += 1) {
      const now = this.capture(paneId);
      if (now !== null && !this.awaitingInput(now)) return true; // turn is running → left idle state
      sleepMs(waitMs);
    }
    return false;
  }
}

// SGR helpers (Stage-1 de-risk findings): capture-pane -e preserves escape codes so ghost
// placeholder text — rendered FAINT — is distinguishable from a user draft by intensity.
const SGR_RE = /\x1b\[[0-9;]*m/g;
function visible(s) { return s.replace(SGR_RE, ""); }
function isDimBody(rawPromptLine) {
  const idx = rawPromptLine.indexOf("›");            // the › caret
  if (idx < 0) return false;
  const after = rawPromptLine.slice(idx + 1);
  const prefix = (after.match(/^(?:\x1b\[[0-9;]*m|\s)*/) || [""])[0];
  const codes = [...prefix.matchAll(/\x1b\[([0-9;]*)m/g)]
    .flatMap((m) => m[1].split(";").filter((x) => x !== "").map(Number));
  let faint = false;
  for (const c of codes) { if (c === 2) faint = true; else if (c === 0 || c === 22) faint = false; }
  return faint;
}

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
// Consumer loop — mirrors controller.mjs's HiveWakeController (proven file-tail + dedupe + reconcile
// mechanics), swapping delivery for PaneDelivery and using HOLD-AND-RETRY instead of go-ambiguous.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
class PaneWakeConsumer {
  constructor(options) {
    this.options = options;
    this.state = loadState(options.stateFile);
    this.pending = [];
    this.pendingKeys = new Set();
    this.seen = new Set(this.state.recentKeys);
    this.partial = Buffer.from(this.state.partialBase64 || "", "base64");
    this.timer = null;
    this.busy = false;
    this.stopping = false;
    this.lock = null;
    this.failStreak = 0;
    this.alerted = false;
    this.delivery = new PaneDelivery({
      tmux: options.tmux,
      paneSession: options.paneSession,
      expectThread: options.expectThread,
      log: (v) => this.log(v),
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
      this.pending = [{ kind: "reconcile", id: null, key: "reconcile:overflow", trigger: "reconcile" }];
      this.pendingKeys = new Set(["reconcile:overflow"]);
    }
  }

  reconcile(reason) {
    this.queue({ kind: "reconcile", id: null, key: `reconcile:${reason}`, trigger: "reconcile" });
  }

  initializeEventCursor() {
    try {
      const stat = requirePrivateEventFile(this.options.eventsFile);
      this.state.eventFile = { dev: stat.dev, ino: stat.ino };
      this.state.offset = stat.size;
      this.partial = Buffer.alloc(0);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state.eventFile = null;
      this.state.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    this.persist();
  }

  persist() {
    this.state.partialBase64 = this.partial.toString("base64");
    this.state.recentKeys = [...this.seen].slice(-512);
    saveState(this.options.stateFile, this.state);
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

  poll() {
    if (this.stopping || this.busy) return;
    try {
      const stat = requirePrivateEventFile(this.options.eventsFile);
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
      this.persist();
      this.flush();
    } catch (error) {
      if (error.code !== "ENOENT") this.reconcile("read-error");
    }
  }

  // HOLD-AND-RETRY delivery (assay amendments): a batch stays PENDING until it is delivered by
  // effect. A deferral increments the fail streak (S1); a delivery clears it.
  flush() {
    if (this.busy || this.stopping || this.pending.length === 0) return;
    this.busy = true;
    try {
      // Deliver the whole pending set as one wake (matches controller batching): the wake text names
      // all pending message ids, and a single turn drains them. Keep the batch pending until confirmed.
      const batch = this.pending.map(({ kind, id, key, trigger }) => ({ kind, id, key, trigger }));
      const text = fixedWakeText(batch);
      const result = this.delivery.deliver(text);
      if (result.delivered) {
        const mailIds = batch.filter((i) => i.trigger === "mail").map((i) => i.id);
        if (mailIds.length) this.state.lastMailId = Math.max(this.state.lastMailId, ...mailIds);
        for (const i of batch) if (i.trigger !== "reconcile") this.seen.add(i.key);
        this.pending = [];
        this.pendingKeys = new Set();
        this.failStreak = 0;
        this.alerted = false;
        this.persist();
        this.log({ event: "delivered", paneId: result.paneId, batch });
      } else {
        this.failStreak += 1;
        this.log({ event: "deferred", reason: result.defer, failStreak: this.failStreak, pending: this.pending.length });
        this.maybeAlert(result.defer);
      }
    } finally {
      this.busy = false;
    }
  }

  // S1: bounded silence. After a threshold of consecutive deferrals, surface an alert ONCE (log line
  // + best-effort hive note) while continuing to hold read-state; re-arm when delivery resumes.
  maybeAlert(reason) {
    if (this.alerted || this.failStreak < this.options.alertAfter) return;
    this.alerted = true;
    this.log({ event: "alert", kind: "bounded-silence", reason, failStreak: this.failStreak, pending: this.pending.length });
    this.hiveNote(
      `codex pane-wake bounded-silence: ${this.failStreak} consecutive deferrals (${reason}); ` +
      `${this.pending.length} event(s) held for codex. Pane closed/moved/busy? Read-state is held; ` +
      `wake resumes automatically when the live Codex pane is reachable again.`,
    );
  }

  hiveNote(content) {
    if (!this.options.token) return;
    for (const to of ["assay", "codex"]) {
      try {
        execFileSync("curl", [
          "-s", "-A", "Mozilla/5.0", "-X", "POST",
          "-H", `Authorization: Bearer ${this.options.token}`,
          "-H", "Content-Type: application/json",
          "--data", JSON.stringify({ persona: PERSONA, to, content }),
          "https://api.kijito.ai/api/hive/send",
        ], { timeout: 8000, stdio: ["ignore", "ignore", "ignore"] });
      } catch { /* best-effort; the log line is the durable record */ }
    }
  }

  start() {
    this.lock = acquireLock(this.options.lockFile); // R2: shared with controller — cannot both run.
    try {
      this.initializeEventCursor();
      this.reconcile("startup"); // restart durability: peek the inbox on every arm.
      this.flush();
      this.timer = setInterval(() => this.poll(), this.options.pollMs);
      this.log({ event: "armed", paneSession: this.options.paneSession, expectThread: this.options.expectThread ?? null });
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
  }
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

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument ${argv[index] ?? ""}`);
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  const runtime = path.resolve(values.runtime ?? path.join(os.homedir(), ".local", "share", "codex-kijito-hive", "runtime-pane"));
  const tokenFile = path.resolve(values["token-file"] ?? path.join(os.homedir(), ".claude", ".kijito_api_token"));
  return {
    eventsFile: path.resolve(values.events ?? path.join(os.homedir(), ".cache", "kijito-inbox-monitor", "events.codex.ndjson")),
    stateFile: path.resolve(values.state ?? path.join(runtime, "state.json")),
    lockFile: path.resolve(values.lock ?? path.join(runtime, "consumer.lock")),
    tmux: values.tmux ?? "tmux",
    paneSession: values["pane-session"] ?? "codex",
    expectThread: values["expect-thread"] ?? null,
    pollMs: Number(values["poll-ms"] ?? 1000),
    alertAfter: Number(values["alert-after"] ?? 10),
    token: readPrivateTokenFile(tokenFile),
    output: (text) => process.stdout.write(text),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 200 || options.pollMs > 60_000) {
    throw new Error("--poll-ms must be an integer from 200 to 60000");
  }
  const consumer = new PaneWakeConsumer(options);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

export { PaneDelivery, PaneWakeConsumer, PLACEHOLDER, descendants };
