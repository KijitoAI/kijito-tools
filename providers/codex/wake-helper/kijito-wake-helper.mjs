#!/usr/bin/env node
// Option-A native live wake for a RUNNING codex session (plan §6; doctrine: the codex "last
// inch"). Session-scoped: spawned by /kijito-start FOR one session's thread, dies with it.
//
// Shape (plan §3): everything platform-agnostic comes from providers/_shared/wake-core.mjs —
// event validation (parseEventLine = the certified doorbell filter) and the injection-safe wake
// turn text (fixedWakeText). This file is only the last inch: attach to the user's own codex
// app-server DAEMON over its control socket and, when hive mail fires, start a read-only wake
// turn on THIS session's thread — deferring until the thread is idle so nothing stomps the
// user's in-flight work.
//
// LOUD BY DESIGN (plan §4a: "silently degraded" is unrepresentable):
//   - daemon socket absent / connect refused      -> exit 3  "daemon-unavailable"
//   - events stream absent                        -> exit 4  "producer-stream-absent"
//   - thread gone (deleted / daemon restarted)    -> exit 5  "thread-gone"  (+ dying gasp)
//   - another live helper on a DIFFERENT thread   -> exit 6  "arm-refused-other-thread"
// kijito-start reads these and reports catch-up-only with the reason, per the §4a ladder.
//
// §4b ARM PRIMITIVE (spec'd by argus 7446, in the certified plan): an owner pidfile bound to
// the thread id. stale -> reap+arm; live+same-thread -> "already-armed" (exit 0, idempotent —
// the DOUBLE-ARM battery probe); live+other-thread -> loud refuse, never kill the other helper.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseEventLine, fixedWakeText } from "../../_shared/wake-core.mjs";
import { connectWsUds } from "./ws-uds.mjs";

const POLL_MS = 500;              // events file poll (tail-by-offset; inode-change aware)
const IDLE_RECHECK_MS = 1_000;    // defer-until-idle recheck cadence (belt for missed notify)
const RPC_TIMEOUT_MS = 10_000;
const MAX_BATCH = 20;

// ---------- pidfile arm primitive (§4b) ----------

export function armCheck(pidfilePath, threadId, isAlive = defaultIsAlive) {
  let raw;
  try {
    raw = fs.readFileSync(pidfilePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { action: "arm" };
    return { action: "refuse", reason: `pidfile-unreadable:${error.code}` };
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { action: "reap-then-arm", reason: "pidfile-corrupt" };
  }
  if (!Number.isSafeInteger(rec?.pid) || rec.pid <= 1 || typeof rec?.threadId !== "string") {
    return { action: "reap-then-arm", reason: "pidfile-malformed" };
  }
  if (!isAlive(rec.pid)) return { action: "reap-then-arm", reason: "stale-pid" };
  if (rec.threadId === threadId) return { action: "already-armed", pid: rec.pid };
  return { action: "refuse", reason: "live-helper-other-thread", pid: rec.pid, otherThread: rec.threadId };
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function writePidfile(pidfilePath, threadId) {
  fs.mkdirSync(path.dirname(pidfilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidfilePath, JSON.stringify({
    pid: process.pid, threadId, startedAt: new Date().toISOString(),
  }) + "\n", { mode: 0o600 });
}

// ---------- daemon socket client ----------
// Transport measured at source (openai/codex rust-v0.147.0): the daemon control socket is a
// WEBSOCKET server over the unix socket (tungstenite accept_async; clients dial with
// handshake URL ws://localhost/rpc) carrying JSON-RPC as one message per text frame. Raw
// JSONL on the socket is silently ignored at the handshake layer — measured 2026-08-15.

class DaemonClient {
  constructor(sockPath, onNotify, onClose) {
    this.sockPath = sockPath;
    this.onNotify = onNotify;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    this.conn = await connectWsUds(this.sockPath, {
      onText: (text) => this.onMessage(text),
      onClose: () => { this.failAll(new Error("daemon-connection-closed")); this.onClose?.(); },
    });
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) { const e = new Error(msg.error.message ?? "rpc error"); e.rpcRejected = true; p.reject(e); }
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.onNotify?.(msg);
    }
  }

  send(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc-timeout:${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.conn.sendText(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method, params = {}) {
    this.conn.sendText(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  failAll(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
}

// ---------- the helper run loop ----------

export class WakeHelper {
  constructor(opts) {
    this.persona = opts.persona;
    this.threadId = opts.threadId;
    this.eventsFile = opts.eventsFile;
    this.sockPath = opts.sockPath;
    this.pidfilePath = opts.pidfilePath;
    this.producerCmd = opts.producerCmd ?? null;
    this.log = opts.log ?? ((obj) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"));
    this.offset = 0;
    this.eventIno = null;
    this.pendingBatch = [];
    this.recentKeys = new Set();
    this.threadIdle = false;
    this.delivering = false;
    this.stopped = false;
  }

  fail(code, reason, extra = {}) {
    this.log({ event: "helper-exit", reason, ...extra });
    if (this.producer && this.producer.exitCode === null) this.producer.kill("SIGTERM");
    this.cleanup();
    process.exit(code);
  }

  cleanup() {
    try {
      const raw = fs.readFileSync(this.pidfilePath, "utf8");
      if (JSON.parse(raw)?.pid === process.pid) fs.unlinkSync(this.pidfilePath);
    } catch { /* pidfile already gone or not ours */ }
  }

  async start() {
    // Session-scoped producer mode (gate-3 measured default): the helper OWNS the producer
    // child, so producer death is a loud in-session event — the silent-tail trap (file
    // remains, stream quiet) is structurally impossible when the owner holds the pid.
    if (this.producerCmd) {
      const [cmd, ...args] = this.producerCmd;
      this.producer = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      this.producer.stderr.on("data", (d) => this.log({ event: "producer-stderr", text: String(d).slice(0, 300) }));
      this.producer.once("exit", (code, signal) => {
        if (this.stopped) return;
        void this.gasp(`wake helper: session producer died (${signal ?? code}) — this session is now catch-up-only`)
          .then(() => this.fail(4, "producer-child-died", { code, signal }));
      });
      // Wait for the producer to create its events file (bounded), so the tail below starts
      // on a real stream instead of failing the race.
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(this.eventsFile) && Date.now() < deadline && this.producer.exitCode === null) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // Preconditions, loudest first (plan §6 rows 1-2).
    if (!fs.existsSync(this.eventsFile)) this.fail(4, "producer-stream-absent", { eventsFile: this.eventsFile });
    this.client = new DaemonClient(
      this.sockPath,
      (msg) => this.onNotify(msg),
      () => { if (!this.stopped) this.dieThreadGone("daemon-connection-closed"); },
    );
    try {
      await this.client.connect();
    } catch (error) {
      this.fail(3, "daemon-unavailable", { sockPath: this.sockPath, error: error.code ?? error.message });
    }
    await this.client.send("initialize", {
      clientInfo: { name: "kijito_wake_helper", title: "Kijito Wake Helper", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.client.notify("initialized");
    // Attach to the SESSION'S OWN thread as an additional subscriber — minimal params on
    // purpose: this is the user's thread and we mutate nothing about it.
    let opened;
    try {
      opened = await this.client.send("thread/resume", { threadId: this.threadId });
    } catch (error) {
      this.fail(5, "thread-gone", { threadId: this.threadId, error: error.message });
    }
    if (opened?.thread?.id !== this.threadId) this.fail(5, "thread-gone", { reason: "resume-returned-wrong-thread" });
    this.threadIdle = (opened.thread.status?.type ?? "unknown") === "idle";

    writePidfile(this.pidfilePath, this.threadId);
    process.on("SIGTERM", () => this.gracefulStop("SIGTERM"));
    process.on("SIGINT", () => this.gracefulStop("SIGINT"));

    const st = fs.statSync(this.eventsFile);
    this.eventIno = st.ino;
    this.offset = st.size; // arm from NOW; catch-up owns the past (plan §2a)
    this.log({ event: "armed", threadId: this.threadId, eventsFile: this.eventsFile, offset: this.offset });
    this.pollTimer = setInterval(() => this.pollEvents().catch((e) => this.log({ event: "poll-error", error: e.message })), POLL_MS);
    this.idleTimer = setInterval(() => this.deliverIfReady().catch(() => {}), IDLE_RECHECK_MS);
  }

  onNotify(msg) {
    if (msg.method === "thread/status/changed" && msg.params?.threadId === this.threadId) {
      const type = msg.params.status?.type ?? "unknown";
      this.threadIdle = type === "idle";
      if (type === "deleted" || type === "closed") this.dieThreadGone(`thread-status-${type}`);
      if (this.threadIdle) void this.deliverIfReady();
    }
  }

  async pollEvents() {
    let st;
    try {
      st = fs.statSync(this.eventsFile);
    } catch {
      // Producer stream vanished mid-run: loud (plan §6 row 2), with a dying gasp in-session.
      await this.gasp("wake helper: producer events stream vanished — this session is now catch-up-only");
      this.fail(4, "producer-stream-vanished");
      return;
    }
    if (st.ino !== this.eventIno) { this.eventIno = st.ino; this.offset = 0; } // rotated
    if (st.size <= this.offset) return;
    const fd = fs.openSync(this.eventsFile, "r");
    let text;
    try {
      const len = Math.min(st.size - this.offset, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseEventLine(line, this.persona);   // the certified _shared filter
      if (!parsed.event) continue;
      if (this.recentKeys.has(parsed.event.key)) continue;
      this.recentKeys.add(parsed.event.key);
      if (this.recentKeys.size > 200) this.recentKeys.delete(this.recentKeys.values().next().value);
      if (this.pendingBatch.length < MAX_BATCH) this.pendingBatch.push(parsed.event);
      this.log({ event: "doorbell", key: parsed.event.key });
    }
    await this.deliverIfReady();
  }

  // Defer-until-idle IS the user-facing property (plan §6 row 6): deliver only on an idle
  // thread; a busy/typing session keeps its turn untouched and the batch waits.
  async deliverIfReady() {
    if (this.delivering || this.pendingBatch.length === 0 || !this.threadIdle) return;
    this.delivering = true;
    try {
      const batch = this.pendingBatch.splice(0, MAX_BATCH);
      const text = fixedWakeText(batch, this.persona);      // injection-safe, from _shared
      let started;
      try {
        started = await this.client.send("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text }],
        });
      } catch (error) {
        if (error.rpcRejected) {
          // Busy race (turn began between our idle check and the call): requeue, retry on idle.
          this.pendingBatch.unshift(...batch);
          this.log({ event: "deliver-deferred", reason: error.message });
          return;
        }
        this.pendingBatch.unshift(...batch);
        this.dieThreadGone(`turn-start-failed:${error.message}`);
        return;
      }
      this.log({ event: "wake-delivered", turnId: started?.turn?.id ?? null, batch: batch.map((b) => b.key) });
    } finally {
      this.delivering = false;
    }
  }

  // Helper-death visibility (plan §6 row 5, assay ruling): every path that CAN speak, does —
  // a final in-session line so the state transition to catch-up-only is visible where the user
  // is. SIGKILL cannot gasp; that residue is measured and documented in the battery log.
  async gasp(message) {
    try {
      if (this.threadIdle) {
        await this.client.send("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text: `[KIJITO WAKE HELPER NOTICE] ${message}` }],
        }, 3_000);
      }
    } catch { /* gasp is best-effort by definition */ }
  }

  dieThreadGone(reason) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.pollTimer); clearInterval(this.idleTimer);
    this.fail(5, "thread-gone", { detail: reason });
  }

  async gracefulStop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.pollTimer); clearInterval(this.idleTimer);
    if (this.producer && this.producer.exitCode === null) this.producer.kill("SIGTERM");
    await this.gasp(`stopping on ${signal} — this session is now catch-up-only`);
    this.log({ event: "helper-exit", reason: `signal-${signal}` });
    this.cleanup();
    process.exit(0);
  }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { cmd: pos[0], opts };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const codexHome = opts["codex-home"] ?? path.join(process.env.HOME ?? "", ".codex");
  const sockPath = opts.sock ?? path.join(codexHome, "app-server-control", "app-server-control.sock");
  const runtimeDir = opts.runtime ?? path.join(codexHome, "kijito-wake");
  const persona = opts.persona;
  const threadId = opts["thread-id"];
  if (cmd === "run") {
    if (!persona || !threadId || !opts.events) {
      process.stderr.write("run requires --persona --thread-id --events\n");
      process.exit(2);
    }
    const pidfilePath = path.join(runtimeDir, `helper-${persona}.pid`);
    const check = armCheck(pidfilePath, threadId);
    if (check.action === "already-armed") { process.stdout.write(`already-armed pid=${check.pid}\n`); process.exit(0); }
    if (check.action === "refuse") {
      process.stderr.write(`arm-refused: ${check.reason}${check.otherThread ? ` thread=${check.otherThread} pid=${check.pid}` : ""}\n`);
      process.exit(6);
    }
    if (check.action === "reap-then-arm") { try { fs.unlinkSync(pidfilePath); } catch { /* raced */ } }
    const helper = new WakeHelper({
      persona, threadId, eventsFile: opts.events, sockPath, pidfilePath,
      // --producer-cmd "prog arg arg": session-scoped producer OWNED by the helper (gate-3
      // default shape). Space-split; producer invocations have no spaced arguments.
      producerCmd: opts["producer-cmd"] ? opts["producer-cmd"].split(/\s+/) : null,
    });
    await helper.start();
    return;
  }
  if (cmd === "arm") {
    // Idempotent front door for kijito-start: same checks, then detach a `run`.
    if (!persona || !threadId || !opts.events) {
      process.stderr.write("arm requires --persona --thread-id --events\n");
      process.exit(2);
    }
    const pidfilePath = path.join(runtimeDir, `helper-${persona}.pid`);
    const check = armCheck(pidfilePath, threadId);
    if (check.action === "already-armed") { process.stdout.write(`already-armed pid=${check.pid}\n`); process.exit(0); }
    if (check.action === "refuse") {
      process.stderr.write(`arm-refused: ${check.reason}${check.otherThread ? ` thread=${check.otherThread} pid=${check.pid}` : ""}\n`);
      process.exit(6);
    }
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(runtimeDir, `helper-${persona}.ndjson`);
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "run",
      "--persona", persona, "--thread-id", threadId, "--events", opts.events,
      "--codex-home", codexHome, "--runtime", runtimeDir,
      ...(opts.sock ? ["--sock", opts.sock] : []),
      ...(opts["producer-cmd"] ? ["--producer-cmd", opts["producer-cmd"]] : [])],
    { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    // Verify the arm by its OWN evidence (running-is-not-armed): wait for the armed line or a
    // loud exit, then say which.
    const deadline = Date.now() + 10_000;
    let verdict = null;
    while (Date.now() < deadline && verdict === null) {
      await new Promise((r) => setTimeout(r, 300));
      const tailText = fs.readFileSync(logFile, "utf8");
      const lines = tailText.trim().split("\n").slice(-10);
      for (const line of lines.reverse()) {
        try {
          const rec = JSON.parse(line);
          if (rec.event === "armed" && rec.threadId === threadId) { verdict = `armed pid=${child.pid}`; break; }
          if (rec.event === "helper-exit") { verdict = `failed: ${rec.reason}`; break; }
        } catch { /* partial line */ }
      }
    }
    if (verdict?.startsWith("armed")) { process.stdout.write(verdict + "\n"); process.exit(0); }
    process.stderr.write(`arm-unverified: ${verdict ?? "no armed event within 10s"} (see ${logFile})\n`);
    process.exit(7);
  }
  if (cmd === "status") {
    const pidfilePath = path.join(runtimeDir, `helper-${persona ?? "codex"}.pid`);
    try {
      const rec = JSON.parse(fs.readFileSync(pidfilePath, "utf8"));
      const alive = defaultIsAlive(rec.pid);
      process.stdout.write(JSON.stringify({ ...rec, alive }) + "\n");
      process.exit(alive ? 0 : 1);
    } catch {
      process.stdout.write("not-armed\n");
      process.exit(1);
    }
  }
  if (cmd === "stop") {
    const pidfilePath = path.join(runtimeDir, `helper-${persona ?? "codex"}.pid`);
    try {
      const rec = JSON.parse(fs.readFileSync(pidfilePath, "utf8"));
      process.kill(rec.pid, "SIGTERM");
      process.stdout.write(`stopping pid=${rec.pid}\n`);
      process.exit(0);
    } catch {
      process.stdout.write("not-armed\n");
      process.exit(1);
    }
  }
  process.stderr.write("usage: kijito-wake-helper <arm|run|status|stop> --persona P --thread-id T --events FILE [--codex-home DIR] [--sock PATH] [--runtime DIR]\n");
  process.exit(2);
}

// realpath both sides — a symlinked invocation path (macOS /tmp, ~/.local/bin) otherwise
// silently no-ops the CLI (measured on the notify shim, same date; same guard, same fix).
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (invokedDirectly) main().catch((error) => { process.stderr.write(`kijito-wake-helper: ${error.message}\n`); process.exit(1); });
