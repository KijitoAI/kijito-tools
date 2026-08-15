import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AppServerClient,
  HiveWakeController,
  initialState,
  loadState,
  saveState,
} from "../controller.mjs";
import {
  LEGACY_POST_TERMINAL_REASON,
  migrateExactLegacyLatch,
} from "../../_shared/wake-core.mjs";
import { inspectRuntimeReadiness } from "../cli.mjs";

const mockAppServer = fileURLToPath(new URL("./mock-app-server.mjs", import.meta.url));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wake-v2."));
  fs.chmodSync(root, 0o700);
  const codexHome = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const runtime = path.join(root, "runtime");
  for (const dir of [codexHome, workspace, runtime]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "default_permissions = \"hive-read\"\n", { mode: 0o600 });
  const eventsFile = path.join(root, "events.codex.ndjson");
  fs.writeFileSync(eventsFile, "", { mode: 0o600 });
  return {
    root,
    codexHome,
    workspace,
    runtime,
    eventsFile,
    stateFile: path.join(runtime, "state.json"),
    lockFile: path.join(runtime, "consumer.lock"),
    traceFile: path.join(root, "trace.ndjson"),
  };
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

function legacyState(overrides = {}) {
  return {
    schema: 1,
    persona: "codex",
    threadId: null,
    eventFile: null,
    offset: 0,
    partialBase64: "",
    lastMailId: 0,
    recentKeys: [],
    lastAttempt: null,
    ambiguous: null,
    ...overrides,
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

function acceptedClient(batches, terminal = "completed") {
  return {
    status: "idle",
    threadId: "test-thread",
    wake: async (batch, { onAccepted }) => {
      const turnId = `turn-${batches.length + 1}`;
      batches.push(batch);
      onAccepted({ turnId, digest: `digest-${turnId}`, acceptedAt: new Date().toISOString() });
      return { turnId, digest: `digest-${turnId}`, text: "ok", terminal };
    },
  };
}

test("schema-2 migration accepts exactly one known legacy latch and refuses zero or two", () => {
  const base = legacyState();
  const latch = {
    at: "2026-08-01T11:34:00Z",
    reason: LEGACY_POST_TERMINAL_REASON,
    batch: [{ kind: "new", id: 3570, key: "new:3570", trigger: "mail" }],
  };
  assert.equal(migrateExactLegacyLatch({ ...base, ambiguous: latch }, "codex").migration.status,
    "pending-idle-proof");
  assert.throws(() => migrateExactLegacyLatch({ ...base, ambiguous: null }, "codex"),
    /count must be exactly 1 \(found 0\)/);
  assert.throws(() => migrateExactLegacyLatch({
    ...base, ambiguous: latch, recoveredAmbiguities: [latch],
  }, "codex"), /count must be exactly 1 \(found 2\)/);
});

test("schema-1 migration projects known fields and rejects schema-2 field smuggling", () => {
  const f = fixture();
  try {
    saveState(f.stateFile, legacyState({ unknownForeignField: "ignored" }));
    const migrated = loadState(f.stateFile);
    assert.equal(migrated.schema, 2);
    assert.equal(migrated.migration.status, "completed");
    assert.equal(Object.hasOwn(migrated, "unknownForeignField"), false);

    saveState(f.stateFile, legacyState({ inFlight: "NOT-AN-OBJECT" }));
    assert.throws(() => loadState(f.stateFile), /state inFlight is invalid/);
  } finally { cleanup(f); }
});

test("accepted turn is persisted as keyed inFlight before terminal completion", async () => {
  const f = fixture();
  try {
    const controller = new HiveWakeController({ ...f, output: () => {} });
    controller.client = {
      status: "idle",
      threadId: "test-thread",
      wake: async (batch, { onAccepted }) => {
        onAccepted({ turnId: "accepted-1", digest: "digest-1", acceptedAt: "2026-08-06T00:00:00Z" });
        const onDisk = loadState(f.stateFile);
        assert.equal(onDisk.inFlight.turnId, "accepted-1");
        assert.deepEqual(onDisk.inFlight.batch.map((item) => item.key), ["new:101"]);
        return { turnId: "accepted-1", terminal: "completed", text: "ok", digest: "digest-1" };
      },
    };
    controller.queue({ kind: "new", id: 101, key: "new:101", trigger: "mail" });
    await controller.flush();
    assert.equal(controller.state.inFlight, null);
    assert.deepEqual(controller.state.lastTerminal, {
      turnId: "accepted-1", status: "completed", at: controller.state.lastTerminal.at,
    });
    assert.equal(controller.state.lastMailId, 101);
  } finally { cleanup(f); }
});

test("matching completion without an idle notification permits the next wake", async () => {
  const f = fixture();
  const batches = [];
  try {
    const controller = new HiveWakeController({ ...f, output: () => {} });
    controller.client = acceptedClient(batches);
    controller.queue({ kind: "new", id: 201, key: "new:201", trigger: "mail" });
    await controller.flush();
    controller.queue({ kind: "new", id: 202, key: "new:202", trigger: "mail" });
    await controller.flush();
    assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [[201], [202]]);
    assert.equal(controller.state.lastMailId, 202);
    assert.equal(controller.state.ambiguous, null);
  } finally { cleanup(f); }
});

test("a persisted accepted-unresolved latch recovers ONLY on same-thread idle proof, audited, without stamping lastMailId", async () => {
  const f = fixture();
  const logs = [];
  try {
    const wedged = initialState("codex");
    wedged.threadId = "wedged-thread";
    wedged.lastMailId = 7496;
    wedged.pending = [{ kind: "new", id: 7519, key: "new:7519", trigger: "mail" }];
    wedged.inFlight = {
      turnId: "orphan-turn",
      digest: "0".repeat(64),
      acceptedAt: "2026-08-14T23:58:38.910Z",
      batch: [{ kind: "alert", id: null, key: "alert:x", trigger: "lifecycle" }],
      unresolvedAt: "2026-08-15T00:09:10.031Z",
      reason: "wake turn did not complete",
    };
    saveState(f.stateFile, wedged);
    const controller = new HiveWakeController({ ...f, output: (line) => logs.push(JSON.parse(line)) });

    // Evidence missing (different thread): the latch HOLDS, loudly.
    controller.client = { status: "idle", threadId: "other-thread" };
    assert.equal(controller.recoverUnresolvedInFlight({ resumedExistingThread: false }), false);
    assert.ok(controller.state.inFlight, "latch must hold without the evidence basis");
    assert.ok(logs.some((l) => l.event === "unresolved-inflight-held"));

    // Evidence present (same thread resumed, proven idle): recover, audit, keep pending intact.
    controller.client = { status: "idle", threadId: "wedged-thread" };
    assert.equal(controller.recoverUnresolvedInFlight({ resumedExistingThread: true }), true);
    assert.equal(controller.state.inFlight, null);
    const audit = controller.state.recoveredAmbiguities.at(-1);
    assert.equal(audit.turnId, "orphan-turn");
    assert.equal(audit.reason, "wake turn did not complete");
    assert.match(audit.disposition, /same thread resumed and proven idle/);
    assert.equal(controller.state.lastMailId, 7496, "delivery never proven - lastMailId must not move");
    assert.deepEqual(controller.pending.map((item) => item.key), ["new:7519"], "backlog stays queued for flush");
    assert.ok(logs.some((l) => l.event === "unresolved-inflight-recovered"));

    // Reload: the recovery is durable and flush is no longer refused by the latch.
    const reloaded = new HiveWakeController({ ...f, output: () => {} });
    assert.equal(reloaded.state.inFlight, null);
    assert.equal(reloaded.state.recoveredAmbiguities.at(-1).turnId, "orphan-turn");
  } finally { cleanup(f); }
});

test("agent output and possible mail summaries never enter controller state or logs", async () => {
  const f = fixture();
  const logs = [];
  try {
    const controller = new HiveWakeController({
      ...f, output: (line) => logs.push(JSON.parse(line)),
    });
    controller.client = {
      status: "idle",
      threadId: "test-thread",
      wake: async (batch, { onAccepted }) => {
        onAccepted({ turnId: "body-free", digest: "digest", acceptedAt: new Date().toISOString() });
        return {
          turnId: "body-free",
          terminal: "completed",
          digest: "digest",
          text: "HOSTILE_MAIL_BODY_MUST_NOT_PERSIST",
        };
      },
    };
    controller.queue({ kind: "new", id: 250, key: "new:250", trigger: "mail" });
    await controller.flush();
    assert.doesNotMatch(JSON.stringify(logs), /HOSTILE_MAIL_BODY_MUST_NOT_PERSIST/);
    assert.doesNotMatch(fs.readFileSync(f.stateFile, "utf8"), /HOSTILE_MAIL_BODY_MUST_NOT_PERSIST/);
  } finally { cleanup(f); }
});

test("accepted failed turn is terminal, never replays its body, and reconciles only when idle", async () => {
  const f = fixture();
  const batches = [];
  try {
    const controller = new HiveWakeController({ ...f, output: () => {} });
    controller.client = acceptedClient(batches, "failed");
    controller.queue({ kind: "new", id: 301, key: "new:301", trigger: "mail" });
    await controller.flush();
    assert.equal(controller.state.inFlight, null);
    assert.equal(controller.state.lastTerminal.status, "failed");
    assert.equal(controller.state.lastMailId, 0);
    assert.deepEqual(batches[0].map((item) => item.key), ["new:301"]);
    assert.deepEqual(controller.pending.map((item) => item.key), ["reconcile:accepted-turn-failed:turn-1"]);

    controller.client = acceptedClient(batches, "completed");
    await controller.flush();
    assert.deepEqual(batches[1].map((item) => item.key), ["reconcile:accepted-turn-failed:turn-1"]);
    assert.equal(batches.flat().filter((item) => item.key === "new:301").length, 1);
  } finally { cleanup(f); }
});

test("acceptance-unknown ambiguity survives reload and blocks automatic retry", async () => {
  const f = fixture();
  try {
    const first = new HiveWakeController({ ...f, output: () => {} });
    first.client = {
      status: "idle",
      wake: async () => {
        const error = new Error("turn/start timed out");
        error.acceptance = "unknown";
        throw error;
      },
    };
    first.queue({ kind: "new", id: 401, key: "new:401", trigger: "mail" });
    await first.flush();
    assert.equal(first.state.ambiguous.classification, "acceptance-unknown");

    let retries = 0;
    const second = new HiveWakeController({ ...f, output: () => {} });
    second.client = { status: "idle", wake: async () => { retries += 1; } };
    second.queue({ kind: "new", id: 402, key: "new:402", trigger: "mail" });
    await second.flush();
    assert.equal(retries, 0);
    assert.equal(second.state.ambiguous.reason, "turn/start timed out");
  } finally { cleanup(f); }
});

test("wrong terminal turn cannot resolve the waiter or clear a keyed accepted record", async () => {
  const client = new AppServerClient({
    codexBin: "unused", codexHome: "/", workspace: "/", token: "unused", onLog: () => {},
  });
  client.threadId = "thread-1";
  client.status = "active";
  const terminal = client.waitForTurn(200);
  terminal.bindTurnId("right-turn");
  let resolved = false;
  terminal.then(() => { resolved = true; });
  client.handleLine(JSON.stringify({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "wrong-turn" } },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(client.status, "active", "wrong terminal must not synthesize idle");
  client.handleLine(JSON.stringify({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "right-turn" } },
  }));
  assert.equal((await terminal).turnId, "right-turn");
  // Duplicate/out-of-order terminal notifications have no waiter left and are harmless.
  client.handleLine(JSON.stringify({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "right-turn" } },
  }));
  assert.equal(client.status, "idle");
});

test("terminal notification for another thread is ignored", async () => {
  const logs = [];
  const client = new AppServerClient({
    codexBin: "unused", codexHome: "/", workspace: "/", token: "unused",
    onLog: (row) => logs.push(row),
  });
  client.threadId = "thread-right";
  client.status = "active";
  const terminal = client.waitForTurn(200);
  terminal.bindTurnId("turn-right");
  client.handleLine(JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-wrong", turn: { id: "turn-right" } },
  }));
  assert.equal(client.status, "active");
  assert.equal(logs.at(-1).reason, "terminal-for-wrong-thread");
  client.handleLine(JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-right", turn: { id: "turn-right" } },
  }));
  assert.equal((await terminal).turnId, "turn-right");
});

test("exact legacy latch cold-starts on the same idle thread, owns its batch, and reconciles once", async () => {
  const f = fixture();
  const logs = [];
  const legacy = legacyState({
    threadId: "mock-thread-1",
    ambiguous: {
      at: "2026-08-01T11:34:00Z",
      reason: LEGACY_POST_TERMINAL_REASON,
      batch: [{ kind: "new", id: 501, key: "new:501", trigger: "mail" }],
    },
  });
  saveState(f.stateFile, legacy);
  const controller = new HiveWakeController({
    ...f,
    token: "test-token",
    codexBin: process.execPath,
    codexArgs: [mockAppServer],
    childEnv: { MOCK_TRACE_FILE: f.traceFile },
    pollMs: 100,
    output: (line) => logs.push(JSON.parse(line)),
  });
  try {
    await controller.start();
    assert.equal(controller.state.migration.status, "completed");
    assert.equal(controller.state.ambiguous, null);
    assert.equal(controller.state.lastMailId, 501);
    assert.equal(controller.state.recoveredAmbiguities.length, 1);
    assert.equal(logs.filter((row) => row.event === "legacy-latch-recovered").length, 1);
    assert.equal(logs.filter((row) => row.event === "surfaced").length, 1);
    const starts = fs.readFileSync(f.traceFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).filter((row) => row.method === "turn/start");
    assert.equal(starts.length, 1);
    assert.match(starts[0].params.input[0].text, /Message IDs: none/);
  } finally {
    await controller.stop();
    cleanup(f);
  }
});

test("legacy latch recovery refuses a newly-created thread when no prior thread id exists", async () => {
  const f = fixture();
  saveState(f.stateFile, legacyState({
    ambiguous: {
      at: "2026-08-01T11:34:00Z",
      reason: LEGACY_POST_TERMINAL_REASON,
      batch: [{ kind: "new", id: 502, key: "new:502", trigger: "mail" }],
    },
  }));
  const controller = new HiveWakeController({
    ...f,
    token: "test-token",
    codexBin: process.execPath,
    codexArgs: [mockAppServer],
    childEnv: { MOCK_TRACE_FILE: f.traceFile },
    pollMs: 100,
    output: () => {},
  });
  try {
    await assert.rejects(() => controller.start(), /exact resumed thread proven idle/);
    assert.equal(fs.existsSync(f.lockFile), false);
    const onDisk = loadState(f.stateFile);
    assert.notEqual(onDisk.ambiguous, null);
    assert.equal(onDisk.lastMailId, 0);
  } finally {
    await controller.stop();
    cleanup(f);
  }
});

test("events read while delivery is unavailable persist and resume from the durable pending queue", async () => {
  const f = fixture();
  try {
    const first = new HiveWakeController({ ...f, pollMs: 100, output: () => {} });
    first.client = { status: "unavailable", proc: null };
    first.initializeEventCursor();
    fs.appendFileSync(f.eventsFile, `${JSON.stringify({
      source: "kijito-inbox", persona: "codex", event: "new", id: 550,
    })}\n`);
    first.poll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.state.offset, fs.statSync(f.eventsFile).size);
    assert.deepEqual(loadState(f.stateFile).pending.map((item) => item.key), ["new:550"]);

    const batches = [];
    const second = new HiveWakeController({ ...f, pollMs: 100, output: () => {} });
    second.client = acceptedClient(batches);
    await second.flush();
    assert.deepEqual(batches.map((batch) => batch.map((item) => item.key)), [["new:550"]]);
    assert.deepEqual(loadState(f.stateFile).pending, []);
    assert.equal(second.state.lastMailId, 550);
  } finally { cleanup(f); }
});

test("restart after a network-attempt checkpoint preserves pending work but blocks uncertain replay", () => {
  const f = fixture();
  try {
    const state = initialState();
    const item = { kind: "new", id: 551, key: "new:551", trigger: "mail" };
    state.pending = [item];
    state.lastAttempt = {
      batch: [item], at: new Date().toISOString(), networkAttempted: true, accepted: false,
    };
    saveState(f.stateFile, state);
    const controller = new HiveWakeController({ ...f, pollMs: 100, output: () => {} });
    assert.equal(controller.state.ambiguous.classification, "acceptance-unknown");
    assert.deepEqual(controller.pending.map((pending) => pending.key), ["new:551"]);
  } finally { cleanup(f); }
});

test("startup drains a pre-existing backlog instead of seeking to EOF", async () => {
  const f = fixture();
  const logs = [];
  const logFile = path.join(f.runtime, "controller.ndjson");
  fs.appendFileSync(f.eventsFile, `${JSON.stringify({
    source: "kijito-inbox", persona: "codex", event: "new", id: 601,
  })}\n`);
  const controller = new HiveWakeController({
    ...f,
    token: "test-token",
    codexBin: process.execPath,
    codexArgs: [mockAppServer],
    childEnv: { MOCK_TRACE_FILE: f.traceFile },
    pollMs: 100,
    output: (line) => {
      fs.appendFileSync(logFile, line, { mode: 0o600 });
      logs.push(JSON.parse(line));
    },
  });
  try {
    await controller.start();
    assert.equal(controller.state.lastMailId, 601);
    assert.equal(controller.state.offset, fs.statSync(f.eventsFile).size);
    assert.equal(controller.state.streamStatus.status, "clear");
    assert.ok(logs.some((row) => row.event === "surfaced"
      && row.batch.some((item) => item.id === 601)));
    assert.ok(logs.some((row) => row.event === "armed"));
    const readiness = inspectRuntimeReadiness(
      { paths: { runtime: f.runtime, eventsFile: f.eventsFile } },
      { state: "running", pid: process.pid },
    );
    assert.equal(readiness.code, "WAKE_READY", JSON.stringify(readiness));

    const child = controller.client.proc;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const dead = inspectRuntimeReadiness(
      { paths: { runtime: f.runtime, eventsFile: f.eventsFile } },
      { state: "running", pid: process.pid },
    );
    assert.notEqual(dead.code, "WAKE_READY");
    assert.ok(["APP_SERVER_LIVENESS_UNPROVEN", "APP_SERVER_EXITED_AFTER_ARM"].includes(dead.code),
      JSON.stringify(dead));
  } finally {
    await controller.stop();
    cleanup(f);
  }
});

test("backlog check distinguishes empty from an unreadable/missing stream", () => {
  const f = fixture();
  try {
    const controller = new HiveWakeController({ ...f, output: () => {} });
    controller.initializeEventCursor();
    assert.equal(controller.state.streamStatus.status, "clear");
    fs.unlinkSync(f.eventsFile);
    const blocked = controller.measureBacklog();
    assert.equal(blocked.status, "blocked");
    assert.notEqual(blocked.reason, undefined);
  } finally { cleanup(f); }
});

test("doctor readiness requires a fresh supervised child, clear durable queue, and wake effect", async () => {
  const f = fixture();
  let child;
  try {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const eventStat = fs.statSync(f.eventsFile);
    const state = initialState();
    const now = new Date().toISOString();
    Object.assign(state, {
      threadId: "thread-ready",
      eventFile: { dev: eventStat.dev, ino: eventStat.ino },
      offset: eventStat.size,
      controllerPid: process.pid,
      controllerRunId: "a".repeat(32),
      startedAt: now,
      armedAt: now,
      streamStatus: { status: "clear", unreadBytes: 0, pendingCount: 0, checkedAt: now },
      clientStatus: { status: "idle", childPid: child.pid, checkedAt: now, pollMs: 500, reason: null },
      lastTerminal: { turnId: "turn-ready", status: "completed", at: now },
    });
    saveState(f.stateFile, state);
    fs.writeFileSync(path.join(f.runtime, "controller.ndjson"), [
      JSON.stringify({ ts: now, pid: process.pid, runId: "a".repeat(32),
        threadId: "thread-ready", event: "surfaced", terminal: "completed" }),
      JSON.stringify({ ts: now, pid: process.pid, runId: "a".repeat(32),
        threadId: "thread-ready", event: "armed" }),
      "",
    ].join("\n"), { mode: 0o600 });
    const manifest = { paths: { runtime: f.runtime, eventsFile: f.eventsFile } };
    const running = { state: "running", pid: process.pid };
    const ready = inspectRuntimeReadiness(manifest, running);
    assert.equal(ready.code, "WAKE_READY", JSON.stringify(ready));

    fs.appendFileSync(path.join(f.runtime, "controller.ndjson"), `${JSON.stringify({
      ts: new Date().toISOString(), pid: process.pid, runId: "a".repeat(32), event: "app-server-exit",
    })}\n`);
    assert.equal(inspectRuntimeReadiness(manifest, running).code, "APP_SERVER_EXITED_AFTER_ARM");
    fs.writeFileSync(path.join(f.runtime, "controller.ndjson"), [
      JSON.stringify({ ts: now, pid: process.pid, runId: "a".repeat(32),
        threadId: "thread-ready", event: "surfaced", terminal: "completed" }),
      JSON.stringify({ ts: now, pid: process.pid, runId: "a".repeat(32),
        threadId: "thread-ready", event: "armed" }),
      "",
    ].join("\n"), { mode: 0o600 });

    state.ambiguous = { classification: "acceptance-unknown" };
    saveState(f.stateFile, state);
    assert.equal(inspectRuntimeReadiness(manifest, running).code, "ACCEPTANCE_AMBIGUOUS");

    state.ambiguous = null;
    state.streamStatus = { status: "backlog", unreadBytes: 1, checkedAt: "2026-08-06T00:00:03Z" };
    saveState(f.stateFile, state);
    assert.equal(inspectRuntimeReadiness(manifest, running).code, "STREAM_BACKLOG");

    state.streamStatus = { status: "clear", unreadBytes: 0, checkedAt: "2026-08-06T00:00:04Z" };
    delete state.inFlight;
    saveState(f.stateFile, state);
    assert.equal(inspectRuntimeReadiness(manifest, running).code, "STATE_SHAPE_UNKNOWN");

    state.inFlight = null;
    saveState(f.stateFile, state);
    fs.unlinkSync(f.eventsFile);
    assert.equal(inspectRuntimeReadiness(manifest, running).code, "STREAM_UNAVAILABLE");
  } finally {
    await stopChild(child);
    cleanup(f);
  }
});
