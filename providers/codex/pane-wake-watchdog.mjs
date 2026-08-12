#!/usr/bin/env node
// M223 — the pane-wake liveness DETECTOR. It watches the wake driver's heartbeat and pages when the
// wakes have stopped. It does nothing else.
//
// ⛔ DETECTION ONLY, AND THAT IS A DESIGN DECISION RATHER THAN AN UNFINISHED FEATURE. This process
// never starts, restarts, resumes, signals or types into anything: it reads one file, and when that
// file says the driver is gone it sends a message. Auto-restart is a separate registry row on
// purpose — a supervisor that re-arms a wake driver can re-arm it into a pane whose state nobody
// verified, and the whole point of the driver's own design is that nothing touches the operator's
// session without a send-time check. A detector cannot make that mistake because it has no hands.
//
// WHY IT EXISTS. Every alarm the driver raises counts its own deferrals, so a driver that is NOT
// RUNNING raises nothing at all: measured in round 3, deleting the event stream under a live driver
// produced a perfect pulse, zero alarms and zero wakes, indefinitely. The heartbeat closed the
// observability half of that; this closes the other half, which is that a file nobody reads is not
// a signal. Somebody has to be looking.
//
// THE WINDOW, CONCRETELY (all three numbers are the measured cadence of the shipped driver):
//   the driver beats at most every       HEARTBEAT_WRITE_MS   =  5 s
//   a record is stale after              staleAfterMs         = 30 s   (max(30 s, pollMs x 6))
//   this watcher checks every            CHECK_INTERVAL_MS    = 15 s
//   ⇒ a death is DETECTED AND PAGED within roughly 30-45 s of the last beat.
// The lower bound is the staleness threshold (we must not page a driver that is merely between
// beats); the upper bound is that threshold plus one check interval.
//
// ⛔ ONE SOURCE FOR EVERYTHING SHARED. `readLiveness`, `hiveNoteBody` and `HIVE_SEND_URL` are
// IMPORTED from the driver module this watcher watches — never re-declared here. A second copy of
// the alert URL is exactly as wrong as the first was: both would be edited together, and the wire
// would go on answering 404 to a watcher that believed it had paged.

// ⛔ NO child_process IMPORT, DELIBERATELY. A detector with a way to spawn something is one commit
// away from being a restarter; its own test asserts this file contains no spawn/exec/kill at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readLiveness, hiveNoteBody, HIVE_SEND_URL } from "./pane-wake.mjs";

const PERSONA = "codex";
const CHECK_INTERVAL_MS = 15_000;
const PAGE_TIMEOUT_MS = 8000;
// A page that fails to send has not alarmed anybody, so the latch closes on SUCCESS, not on the
// attempt — the driver's own "one best-effort POST and never again" was a measured defect. The cap
// stops a permanently-unreachable hive from turning into an unbounded retry loop; exhausting it is
// itself logged loudly.
const MAX_PAGE_ATTEMPTS = 5;

// The states that mean THE WAKE PATH HAS STOPPED, and the states that mean it is running.
//   stale      the process exists but has not beaten inside its own stated bound
//   absent     no heartbeat at all
//   dead       the recorded pid is gone
//   unreadable we cannot verify liveness — a detector that cannot detect must say so, not stay quiet
const PAGE_STATES = new Set(["stale", "absent", "dead", "unreadable"]);
// `degraded` is deliberately NOT a page state: it means the driver is beating but its INPUT path is
// broken, which the driver alarms about itself through bounded silence. Paging on it would double
// every such alarm and teach the reader to skim them. It does count as "the process is alive", so
// it clears an open episode.
const HEALTHY_STATES = new Set(["alive", "degraded"]);

// The same private-file gate the driver applies to its own token file.
//
// ⚠️ DUPLICATED ON PURPOSE, AND FLAGGED: the driver does not export this helper and its bytes are
// frozen under review, so the choice was between copying twelve lines and shipping a watcher that
// reads a credential with weaker checks than the process it watches. The copy is the lesser evil;
// when the driver next unfreezes, export it there and delete this.
function readPrivateTokenFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    const token = fs.readFileSync(file, "utf8").trim();
    return token.startsWith("kjt_") && token.length >= 20 ? token : null;
  } catch { return null; }
}

class PaneWakeWatchdog {
  constructor(options) {
    this.options = options;
    this.token = options.token ?? null;
    this.episode = 0;          // how many distinct outages we have seen
    this.paged = false;        // latched for the CURRENT episode
    this.attempts = 0;         // page attempts within the current episode
    this.condition = null;     // the state that opened the current episode
    this.everSeenBeat = false; // has this watcher ever observed a live heartbeat?
    this.timer = null;
  }

  log(value) {
    this.options.output(`${JSON.stringify({ ts: new Date().toISOString(), driver: "pane-wake-watchdog", ...value })}\n`);
  }

  logQuiet(value) {
    try { this.log(value); } catch { /* a detached stdout must never take the watcher down */ }
  }

  // One observation. Returns the liveness record so tests can assert on the same value the decision
  // was made from.
  async check(now = Date.now()) {
    let liveness;
    try {
      liveness = readLiveness(this.options.heartbeatFile, now);
    } catch (error) {
      liveness = { status: "unreadable", reason: "read-threw", message: error.message };
    }
    if (HEALTHY_STATES.has(liveness.status)) {
      this.everSeenBeat = true;
      if (this.paged || this.condition) {
        // RECOVERY re-arms the latch, so a second outage pages again. A latch that never re-opens
        // is a one-shot alarm, which is the failure mode the driver's own S1 had in round 1.
        this.logQuiet({ event: "recovered", from: this.condition, status: liveness.status, episode: this.episode, pid: liveness.pid ?? null });
        this.paged = false;
        this.attempts = 0;
        this.condition = null;
      }
      return liveness;
    }
    if (!PAGE_STATES.has(liveness.status)) {
      this.logQuiet({ event: "unclassified", status: liveness.status, heartbeatFile: this.options.heartbeatFile });
      return liveness;
    }
    if (this.condition === null) {
      this.episode += 1;
      this.condition = liveness.status;
      this.logQuiet({ event: "outage", status: liveness.status, episode: this.episode, ageMs: liveness.ageMs ?? null, pid: liveness.pid ?? null });
    }
    if (this.paged) return liveness;                       // latched: one page per episode
    if (this.attempts >= MAX_PAGE_ATTEMPTS) return liveness;
    await this.page(liveness);
    return liveness;
  }

  // The message names the condition AND the remedy, because a page that only says "something is
  // wrong" costs the reader the same investigation every time.
  pageContent(liveness) {
    const where = this.options.heartbeatFile;
    const window = "beat 5s / stale 30s / check 15s";
    if (liveness.status === "absent" && !this.everSeenBeat) {
      // ⛔ THIS WORDING IS LOAD-BEARING. A heartbeat that has never appeared since the watcher
      // started is at least as likely to be a MISCONFIGURATION as a death — a driver armed without
      // `--heartbeat`, or a watcher pointed at the wrong path. Calling that "the driver is dead"
      // is how an alarm channel earns a reputation for crying wolf.
      return `codex pane-wake heartbeat ABSENT at ${where} since this watchdog started — either the wake driver is not armed, or it is armed WITHOUT --heartbeat ${where}. Wakes are NOT being delivered. Check the launch argv and the pid, then re-arm. (${window})`;
    }
    const detail = {
      stale: `heartbeat STALE (last beat ${Math.round((liveness.ageMs ?? 0) / 1000)}s ago, bound ${Math.round((liveness.staleAfterMs ?? 30_000) / 1000)}s)`,
      absent: "heartbeat ABSENT (the file is gone)",
      dead: `heartbeat pid ${liveness.pid} is NOT RUNNING`,
      unreadable: `heartbeat UNREADABLE (${liveness.reason ?? "unknown"}) — liveness cannot be verified`,
    }[liveness.status];
    return `codex pane-wake ${detail} at ${where} — wakes have stopped. Check the pid and re-arm the driver; nothing is auto-restarted by design. (${window})`;
  }

  async page(liveness) {
    this.attempts += 1;
    const content = this.pageContent(liveness);
    if (!this.token) {
      // No credential ⇒ no remote page is possible. Say so every time rather than latching, so the
      // log itself cannot be mistaken for evidence that somebody was told.
      this.logQuiet({ event: "page", channel: "log-only", status: liveness.status, episode: this.episode, attempt: this.attempts, content });
      return;
    }
    let delivered = 0;
    for (const to of ["assay", PERSONA]) {
      try {
        const response = await fetch(HIVE_SEND_URL, {
          method: "POST",
          headers: {
            // The credential lives only in this header. Never argv, never a log line.
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0",
          },
          body: JSON.stringify(hiveNoteBody(to, content)),
          redirect: "error",
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
        await response.text().catch(() => "");
        if (response.ok) delivered += 1;
        this.logQuiet({ event: "page-transport", to, status: response.ok ? "sent" : "rejected", httpStatus: response.status, episode: this.episode, attempt: this.attempts });
      } catch (error) {
        this.logQuiet({ event: "page-transport", to, status: "failed", message: error.message, episode: this.episode, attempt: this.attempts });
      }
    }
    if (delivered > 0) {
      this.paged = true;
      this.logQuiet({ event: "page", channel: "hive", status: liveness.status, episode: this.episode, attempt: this.attempts, recipients: delivered, content });
      return;
    }
    if (this.attempts >= MAX_PAGE_ATTEMPTS) {
      this.logQuiet({
        event: "page-unsendable",
        status: liveness.status,
        episode: this.episode,
        attempts: this.attempts,
        detail: "the outage is real and NOBODY HAS BEEN TOLD: every page attempt failed to reach the hive",
      });
    }
  }

  async start() {
    this.logQuiet({
      event: "armed",
      heartbeatFile: this.options.heartbeatFile,
      checkMs: this.options.checkMs,
      pageChannel: this.token ? "hive" : "log-only",
      detectionOnly: true,
      window: "beat 5s / stale 30s / check 15s ⇒ detection within ~30-45s",
    });
    await this.check();
    if (this.options.once) return;
    this.timer = setInterval(() => {
      this.check().catch((error) => this.logQuiet({ event: "error", message: error.message }));
    }, this.options.checkMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// Argument parsing with the driver's F10 discipline: an allowlist, no silent typos, no duplicates,
// integers validated by shape and range. A watchdog whose `--heartbeat` typo left it watching a
// default path would be a detector that detects nothing while reporting itself armed.
const ALLOWED_OPTIONS = new Set(["heartbeat", "token-file", "check-ms"]);
const FLAGS = new Set(["--once"]);

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

function parseArgs(argv) {
  const flags = new Set(argv.filter((token) => FLAGS.has(token)));
  const pairs = argv.filter((token) => !FLAGS.has(token));
  const values = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index];
    if (!flag?.startsWith("--") || pairs[index + 1] === undefined) throw new Error(`invalid argument ${flag ?? ""}`);
    const key = flag.slice(2);
    if (!ALLOWED_OPTIONS.has(key)) throw new Error(`unknown option --${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate option --${key}`);
    values[key] = pairs[index + 1];
  }
  const heartbeat = values.heartbeat;
  if (typeof heartbeat !== "string" || heartbeat.length === 0) {
    throw new Error("--heartbeat is required and must be the driver's heartbeat file");
  }
  return {
    heartbeatFile: path.resolve(heartbeat),
    tokenFile: path.resolve(values["token-file"] ?? path.join(os.homedir(), ".claude", ".kijito_api_token")),
    checkMs: integerOption(values, "check-ms", CHECK_INTERVAL_MS, 1000, 600_000),
    once: flags.has("--once"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const watchdog = new PaneWakeWatchdog({
    ...options,
    token: readPrivateTokenFile(options.tokenFile),
    output: (text) => process.stdout.write(text),
  });
  const stop = () => { watchdog.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await watchdog.start();
}

function invokedAsMain(entry) {
  if (entry === undefined) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { return false; }
}

if (invokedAsMain(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export { PaneWakeWatchdog, parseArgs, readPrivateTokenFile, CHECK_INTERVAL_MS, MAX_PAGE_ATTEMPTS, PAGE_STATES, HEALTHY_STATES };
