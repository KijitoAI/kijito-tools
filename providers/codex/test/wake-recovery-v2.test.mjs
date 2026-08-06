import assert from "node:assert/strict";
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
  const base = { ...initialState(), schema: 1 };
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
  const legacy = { ...initialState(), schema: 1 };
  legacy.threadId = "mock-thread-1";
  legacy.ambiguous = {
    at: "2026-08-01T11:34:00Z",
    reason: LEGACY_POST_TERMINAL_REASON,
    batch: [{ kind: "new", id: 501, key: "new:501", trigger: "mail" }],
  };
  saveState(f.stateFile, legacy);
  const controller = new HiveWakeController({
    ...f,
    token: "test-token",
    codexBin: process.execPath,
    codexArgs: [mockAppServer],
    childEnv: { MOCK_TRACE_FILE: f.traceFile },
    pollMs: 10,
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

test("startup drains a pre-existing backlog instead of seeking to EOF", async () => {
  const f = fixture();
  const logs = [];
  fs.appendFileSync(f.eventsFile, `${JSON.stringify({
    source: "kijito-inbox", persona: "codex", event: "new", id: 601,
  })}\n`);
  const controller = new HiveWakeController({
    ...f,
    token: "test-token",
    codexBin: process.execPath,
    codexArgs: [mockAppServer],
    childEnv: { MOCK_TRACE_FILE: f.traceFile },
    pollMs: 10,
    output: (line) => logs.push(JSON.parse(line)),
  });
  try {
    await controller.start();
    assert.equal(controller.state.lastMailId, 601);
    assert.equal(controller.state.offset, fs.statSync(f.eventsFile).size);
    assert.equal(controller.state.streamStatus.status, "clear");
    assert.ok(logs.some((row) => row.event === "surfaced"
      && row.batch.some((item) => item.id === 601)));
    assert.ok(logs.some((row) => row.event === "armed"));
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

test("doctor readiness requires one exact process, schema-2 state, clear stream, and wake effect", () => {
  const f = fixture();
  try {
    const eventStat = fs.statSync(f.eventsFile);
    const state = initialState();
    Object.assign(state, {
      threadId: "thread-ready",
      eventFile: { dev: eventStat.dev, ino: eventStat.ino },
      offset: eventStat.size,
      controllerPid: 12345,
      controllerRunId: "a".repeat(32),
      startedAt: "2026-08-06T00:00:00Z",
      armedAt: "2026-08-06T00:00:02Z",
      streamStatus: { status: "clear", unreadBytes: 0, checkedAt: "2026-08-06T00:00:01Z" },
      lastTerminal: { turnId: "turn-ready", status: "completed", at: "2026-08-06T00:00:02Z" },
    });
    saveState(f.stateFile, state);
    fs.writeFileSync(path.join(f.runtime, "controller.ndjson"), [
      JSON.stringify({ ts: "2026-08-06T00:00:01Z", pid: 12345, runId: "a".repeat(32),
        threadId: "thread-ready", event: "surfaced", terminal: "completed" }),
      JSON.stringify({ ts: "2026-08-06T00:00:02Z", pid: 12345, runId: "a".repeat(32),
        threadId: "thread-ready", event: "armed" }),
      "",
    ].join("\n"), { mode: 0o600 });
    const manifest = { paths: { runtime: f.runtime, eventsFile: f.eventsFile } };
    const running = { state: "running", pid: 12345 };
    assert.equal(inspectRuntimeReadiness(manifest, running).code, "WAKE_READY");

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
  } finally { cleanup(f); }
});
