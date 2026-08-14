// Mode register + mode-aware liveness + mode-aware watchdog paging.
//
// Shape discipline copied from pane-wake-watchdog.test.mjs: fixtures in a private tmpdir, the wire
// stubbed wherever a page could fire, and the M223 assertion shapes (pages exactly once per
// outage, recovery re-arms, a second outage pages again) repeated PER MODE — plus the
// environment-manufactured-observable case from the seat-cert post-close finding: a liveness
// timestamp from the FUTURE must read as an outage, never as health (assay condition c, hive 7056).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SCHEMA, MODES, readDeclaredMode, declareMode } from "../mode-register.mjs";
import { readModeLiveness, readControllerLiveness, readAttendedLiveness, CLIENT_FRESHNESS_FLOOR_MS } from "../mode-liveness.mjs";
import { PaneWakeWatchdog, parseArgs } from "../pane-wake-watchdog.mjs";

const providerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = `kjt_${"x".repeat(32)}`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mode-register."));
  fs.chmodSync(root, 0o700);
  return {
    root,
    registerFile: path.join(root, "declared-mode.json"),
    heartbeatFile: path.join(root, "heartbeat.json"),
    stateFile: path.join(root, "state.json"),
    lockFile: path.join(root, "consumer.lock"),
  };
}

function controllerState(f, { agoMs = 0, alive = true, pollMs = 500, clientStatus = "idle", inFlightAgoMs = null } = {}) {
  fs.writeFileSync(f.stateFile, `${JSON.stringify({
    schema: 2,
    persona: "codex",
    controllerPid: alive ? process.pid : 999_999_999,
    clientStatus: {
      status: clientStatus,
      childPid: process.pid,
      checkedAt: new Date(Date.now() - agoMs).toISOString(),
      pollMs,
    },
    inFlight: inFlightAgoMs === null ? null : {
      turnId: "test-turn",
      digest: "0".repeat(64),
      acceptedAt: new Date(Date.now() - inFlightAgoMs).toISOString(),
      batch: [],
    },
  })}\n`, { mode: 0o600 });
}

function paneBeat(f, { agoMs = 0 } = {}) {
  fs.writeFileSync(f.heartbeatFile, `${JSON.stringify({
    schema: 1,
    driver: "pane-wake",
    persona: "codex",
    pid: process.pid,
    ts: new Date(Date.now() - agoMs).toISOString(),
    pollMs: 1000,
    staleAfterMs: 30_000,
    eventsFile: path.join(f.root, "events.ndjson"),
    eventsOkAt: new Date().toISOString(),
    eventsError: null,
    awaitingConfirm: false,
    pending: 0,
  })}\n`, { mode: 0o600 });
}

function holdLock(f, { alive = true } = {}) {
  fs.writeFileSync(f.lockFile, `${JSON.stringify({ pid: alive ? process.pid : 999_999_999, token: "t".repeat(32), persona: "codex" })}`, { mode: 0o600 });
}

function modeWatchdog(f, overrides = {}) {
  const logs = [];
  const watchdog = new PaneWakeWatchdog({
    heartbeatFile: f.heartbeatFile,
    modeRegisterFile: f.registerFile,
    controllerStateFile: f.stateFile,
    consumerLockFile: f.lockFile,
    tokenFile: path.join(f.root, "token"),
    checkMs: 15_000,
    once: true,
    token: TOKEN,
    output: (text) => logs.push(JSON.parse(text)),
    ...overrides,
  });
  return { watchdog, logs };
}

function stubFetch(responder = async () => ({ ok: true, status: 200, text: async () => "" })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return responder(url, init); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const pages = (logs) => logs.filter((l) => l.event === "page");
const cleanup = (f) => fs.rmSync(f.root, { recursive: true, force: true });

// ─── the register ────────────────────────────────────────────────────────────

test("declare/read round-trip carries every schema field and stays provisional", () => {
  const f = fixture();
  try {
    const record = declareMode(f.registerFile, "codex.app-server-seat", "codex");
    assert.equal(record.schema, SCHEMA);
    assert.equal(record.provisional, true);
    const read = readDeclaredMode(f.registerFile);
    assert.equal(read.status, "declared");
    assert.equal(read.mode, "codex.app-server-seat");
    assert.equal(read.declaredBy, "codex");
    assert.equal(read.provisional, true);
    assert.ok(Number.isFinite(Date.parse(read.declaredAt)));
    // 0600 or the register fails its own read gate.
    assert.equal(fs.statSync(f.registerFile).mode & 0o077, 0);
  } finally { cleanup(f); }
});

test("only the three frozen cell IDs are declarable — a typo is a refusal, not a declaration", () => {
  const f = fixture();
  try {
    assert.deepEqual([...MODES].sort(), ["codex.app-server-seat", "codex.attended-notify", "codex.tmux-pane"]);
    assert.throws(() => declareMode(f.registerFile, "codex.tmux_pane", "codex"), /unknown mode/);
    assert.throws(() => declareMode(f.registerFile, "codex.app-server-seat", ""), /declaredBy/);
    assert.equal(readDeclaredMode(f.registerFile).status, "absent");
  } finally { cleanup(f); }
});

test("re-declaration atomically replaces the previous mode", () => {
  const f = fixture();
  try {
    declareMode(f.registerFile, "codex.tmux-pane", "codex");
    declareMode(f.registerFile, "codex.attended-notify", "operator");
    const read = readDeclaredMode(f.registerFile);
    assert.equal(read.mode, "codex.attended-notify");
    assert.equal(read.declaredBy, "operator");
    // No temp-file debris left behind by the atomic write.
    assert.deepEqual(fs.readdirSync(f.root).filter((n) => n.includes("modetmp")), []);
  } finally { cleanup(f); }
});

test("a malformed, wrong-schema, non-provisional, or world-readable register never reads as declared", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.registerFile, "not json", { mode: 0o600 });
    assert.equal(readDeclaredMode(f.registerFile).status, "invalid");
    fs.writeFileSync(f.registerFile, JSON.stringify({ schema: 99, mode: "codex.tmux-pane", provisional: true, declaredAt: new Date().toISOString(), declaredBy: "x" }), { mode: 0o600 });
    assert.equal(readDeclaredMode(f.registerFile).status, "invalid");
    fs.writeFileSync(f.registerFile, JSON.stringify({ schema: SCHEMA, mode: "codex.tmux-pane", declaredAt: new Date().toISOString(), declaredBy: "x" }), { mode: 0o600 });
    assert.equal(readDeclaredMode(f.registerFile).reason, "provisional flag missing");
    declareMode(f.registerFile, "codex.tmux-pane", "codex");
    fs.chmodSync(f.registerFile, 0o644);
    assert.equal(readDeclaredMode(f.registerFile).status, "unreadable");
  } finally { cleanup(f); }
});

// ─── controller (app-server-seat) liveness ───────────────────────────────────

test("a fresh idle controller is alive; a beating non-idle one is degraded, never a page", () => {
  const f = fixture();
  try {
    controllerState(f);
    assert.equal(readControllerLiveness(f.stateFile).status, "alive");
    controllerState(f, { clientStatus: "busy" });
    const degraded = readControllerLiveness(f.stateFile);
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.reason, "client-busy");
  } finally { cleanup(f); }
});

test("a mid-turn beat stall is not an outage: monitoring bound is max(30s, pollMs*6), not the readiness gate's 5s", () => {
  const f = fixture();
  try {
    // The 2026-08-14 false-page storm, as a regression: 5-13s stalls during real turns paged
    // "wakes have stopped" while wakes were completing. Under monitoring semantics they are alive.
    controllerState(f, { agoMs: 6_000, pollMs: 500 });
    assert.equal(readControllerLiveness(f.stateFile).status, "alive", "6s stall (page 7243's shape)");
    controllerState(f, { agoMs: 13_000, pollMs: 500 });
    assert.equal(readControllerLiveness(f.stateFile).status, "alive", "13s stall (page 7279's shape)");
    // Past the monitoring bound with no turn in flight: a real stall, and it pages.
    controllerState(f, { agoMs: 31_000, pollMs: 500 });
    const stale = readControllerLiveness(f.stateFile);
    assert.equal(stale.status, "stale");
    assert.equal(stale.staleAfterMs, CLIENT_FRESHNESS_FLOOR_MS);
    // Exercise the pollMs*6 arm where it DOMINATES the 30s floor (argus review note: with
    // pollMs=500 everywhere, a *6→*4 mutation would survive). pollMs=10s ⇒ bound 60s.
    controllerState(f, { agoMs: 50_000, pollMs: 10_000 });
    assert.equal(readControllerLiveness(f.stateFile).status, "alive", "50s stall under a 60s bound");
    controllerState(f, { agoMs: 61_000, pollMs: 10_000 });
    assert.equal(readControllerLiveness(f.stateFile).status, "stale", "61s stall past the 60s bound");
  } finally { cleanup(f); }
});

test("a stalled beat during a FRESH in-flight turn is busy (degraded), not an outage; the suppression is bounded", () => {
  const f = fixture();
  try {
    // 46s was the largest legitimate turn observed (the 70-item backlog drain). A beat stalled
    // past the bound while that turn is in flight must read busy, never "wakes have stopped".
    controllerState(f, { agoMs: 46_000, pollMs: 500, inFlightAgoMs: 46_000 });
    const busy = readControllerLiveness(f.stateFile);
    assert.equal(busy.status, "degraded");
    assert.equal(busy.reason, "client-busy-turn-inflight");
    // A wedged turn does not hide behind the suppression: grace exhausted ⇒ stale ⇒ pages.
    controllerState(f, { agoMs: 46_000, pollMs: 500, inFlightAgoMs: 16 * 60_000 });
    assert.equal(readControllerLiveness(f.stateFile).status, "stale", "grace exhausted");
    // An acceptedAt from the future is out of character and never suppresses.
    controllerState(f, { agoMs: 46_000, pollMs: 500, inFlightAgoMs: -60_000 });
    assert.equal(readControllerLiveness(f.stateFile).status, "stale", "future acceptedAt");
  } finally { cleanup(f); }
});

test("an observable from the FUTURE is an outage, not health (environment-manufactured case)", () => {
  const f = fixture();
  try {
    // checkedAt 10s in the future, pollMs 500 ⇒ skew beyond -pollMs*2. This is the seat-cert
    // post-close lesson productized: a timestamp that moved for the wrong reason must page.
    controllerState(f, { agoMs: -10_000, pollMs: 500 });
    const skewed = readControllerLiveness(f.stateFile);
    assert.equal(skewed.status, "stale");
    assert.equal(skewed.reason, "clock-skew-future-timestamp");
  } finally { cleanup(f); }
});

test("a dead controller pid is dead even under a fresh timestamp; a missing state file is absent", () => {
  const f = fixture();
  try {
    controllerState(f, { alive: false });
    assert.equal(readControllerLiveness(f.stateFile).status, "dead");
    fs.rmSync(f.stateFile);
    assert.equal(readControllerLiveness(f.stateFile).status, "absent");
  } finally { cleanup(f); }
});

// ─── attended-notify liveness (the inversion) ────────────────────────────────

test("attended mode: no lock is health, a held lock is the violation", () => {
  const f = fixture();
  try {
    assert.equal(readAttendedLiveness(f.lockFile).status, "alive");
    holdLock(f);
    const violation = readAttendedLiveness(f.lockFile);
    assert.equal(violation.status, "unexpected-consumer");
    assert.equal(violation.pid, process.pid);
    assert.equal(violation.holderAlive, true);
    holdLock(f, { alive: false });
    assert.equal(readAttendedLiveness(f.lockFile).holderAlive, false, "a dead holder is still a violation — a stale lock blocks the next consumer");
  } finally { cleanup(f); }
});

// ─── dispatch ────────────────────────────────────────────────────────────────

test("no register, no answer: an opted-in watcher with a missing/invalid register reads unreadable", () => {
  const f = fixture();
  try {
    const opts = { heartbeatFile: f.heartbeatFile, controllerStateFile: f.stateFile, consumerLockFile: f.lockFile };
    assert.equal(readModeLiveness(f.registerFile, opts).reason, "mode-register-absent");
    fs.writeFileSync(f.registerFile, "{", { mode: 0o600 });
    assert.match(readModeLiveness(f.registerFile, opts).reason, /^mode-register-invalid/);
  } finally { cleanup(f); }
});

test("tmux-pane dispatch delegates to the driver's own readLiveness and tags the mode", () => {
  const f = fixture();
  try {
    declareMode(f.registerFile, "codex.tmux-pane", "codex");
    paneBeat(f);
    const liveness = readModeLiveness(f.registerFile, { heartbeatFile: f.heartbeatFile, controllerStateFile: f.stateFile, consumerLockFile: f.lockFile });
    assert.equal(liveness.status, "alive");
    assert.equal(liveness.mode, "codex.tmux-pane");
  } finally { cleanup(f); }
});

// ─── the watchdog, per mode: pages once, names the declaration, recovers, re-pages ──

test("app-server-seat outage pages exactly once, names the declared mode, recovers, and a second outage pages again", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    declareMode(f.registerFile, "codex.app-server-seat", "codex");
    controllerState(f, { agoMs: 60_000 });
    const { watchdog, logs } = modeWatchdog(f);
    await watchdog.check();
    await watchdog.check();
    assert.equal(pages(logs).length, 1, "latched: one page per episode");
    assert.match(pages(logs)[0].content, /\[declared mode codex\.app-server-seat\]/);
    assert.match(pages(logs)[0].content, /controller clientStatus STALE/);
    controllerState(f);
    await watchdog.check();
    assert.equal(logs.filter((l) => l.event === "recovered").length, 1);
    controllerState(f, { alive: false });
    await watchdog.check();
    assert.equal(pages(logs).length, 2, "recovery re-arms the latch");
    assert.match(pages(logs)[1].content, /pid \d+ is NOT RUNNING/);
  } finally { wire.restore(); cleanup(f); }
});

test("the future-timestamp outage pages with the wrong-reason wording", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    declareMode(f.registerFile, "codex.app-server-seat", "codex");
    controllerState(f, { agoMs: -10_000 });
    const { watchdog, logs } = modeWatchdog(f);
    await watchdog.check();
    assert.equal(pages(logs).length, 1);
    assert.match(pages(logs)[0].content, /FROM THE FUTURE/);
    assert.match(pages(logs)[0].content, /moved for the wrong reason/);
  } finally { wire.restore(); cleanup(f); }
});

test("attended-notify pages on lock PRESENCE and recovers on its release", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    declareMode(f.registerFile, "codex.attended-notify", "codex");
    const { watchdog, logs } = modeWatchdog(f);
    await watchdog.check();
    assert.equal(pages(logs).length, 0, "no consumer, no page — absence IS health here");
    holdLock(f);
    await watchdog.check();
    await watchdog.check();
    assert.equal(pages(logs).length, 1);
    assert.match(pages(logs)[0].content, /VIOLATION/);
    assert.match(pages(logs)[0].content, /attended-notify declares NO consumer/);
    assert.match(pages(logs)[0].content, /nothing is auto-stopped by design/);
    fs.rmSync(f.lockFile);
    await watchdog.check();
    assert.equal(logs.filter((l) => l.event === "recovered").length, 1);
  } finally { wire.restore(); cleanup(f); }
});

test("an opted-in watchdog whose register vanishes pages rather than staying quiet", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    declareMode(f.registerFile, "codex.tmux-pane", "codex");
    paneBeat(f);
    const { watchdog, logs } = modeWatchdog(f);
    await watchdog.check();
    assert.equal(pages(logs).length, 0);
    fs.rmSync(f.registerFile);
    await watchdog.check();
    assert.equal(pages(logs).length, 1);
    assert.match(pages(logs)[0].content, /\[declared mode UNKNOWN\]/);
    assert.match(pages(logs)[0].content, /mode-register-absent/);
  } finally { wire.restore(); cleanup(f); }
});

// ─── argv discipline + byte-compat default path ──────────────────────────────

test("mode flags follow the no-silent-defaults rule and stay rejected without opt-in", () => {
  const base = ["--heartbeat", "/tmp/hb.json"];
  const parsed = parseArgs(base);
  assert.equal(parsed.modeRegisterFile, null, "flag absent ⇒ legacy pane-only path");
  assert.throws(() => parseArgs([...base, "--mode-register", "/tmp/mode.json"]), /--controller-state is required/);
  assert.throws(() => parseArgs([...base, "--controller-state", "/tmp/s.json"]), /only apply with --mode-register/);
  const full = parseArgs([...base, "--mode-register", "/tmp/mode.json", "--controller-state", "/tmp/s.json", "--consumer-lock", "/tmp/l.lock"]);
  assert.equal(full.modeRegisterFile, path.resolve("/tmp/mode.json"));
  assert.equal(full.controllerStateFile, path.resolve("/tmp/s.json"));
  assert.equal(full.consumerLockFile, path.resolve("/tmp/l.lock"));
});

test("the new modules keep the detector handless: no child_process anywhere in the mode layer", () => {
  for (const file of ["mode-register.mjs", "mode-liveness.mjs"]) {
    const source = fs.readFileSync(path.join(providerRoot, file), "utf8");
    assert.ok(!source.includes("child_process"), `${file} must not import child_process`);
    assert.ok(!/\bspawn|\bexecFile|\bexecSync/.test(source), `${file} must not spawn`);
  }
});
