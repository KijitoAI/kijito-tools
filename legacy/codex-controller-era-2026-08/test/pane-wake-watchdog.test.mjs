// M223 — the liveness DETECTOR's own tests.
//
// ⛔ WHAT THIS SUITE CAN AND CANNOT PROVE, SAID UP FRONT. It proves the decision logic: which
// liveness states page, that a page happens ONCE per outage, that recovery re-arms the latch, that
// a second outage pages again, and that the page goes to the imported URL with the imported body
// shape. It does NOT prove that killing the driver produces a message in somebody's inbox — that is
// an operational, by-effect acceptance (kill the pid, watch for the page) and it is the row's
// done-when, not a unit test's. Saying so here is the point: a suite that quietly implies it
// covered the end-to-end case is how "tested" and "works" drift apart.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PaneWakeWatchdog, parseArgs, readPrivateTokenFile, CHECK_INTERVAL_MS, MAX_PAGE_ATTEMPTS } from "../pane-wake-watchdog.mjs";
import { HIVE_SEND_URL, hiveNoteBody } from "../pane-wake.mjs";

const providerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watchdogFile = path.join(providerRoot, "pane-wake-watchdog.mjs");
const TOKEN = `kjt_${"x".repeat(32)}`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pane-wake-watchdog."));
  fs.chmodSync(root, 0o700);
  return { root, heartbeatFile: path.join(root, "heartbeat.json") };
}

// A heartbeat in the shape the driver writes. `agoMs` moves the beat into the past; `alive` decides
// whether the recorded pid is a running process.
function beat(f, { agoMs = 0, alive = true, eventsAgoMs = 0, eventsError = null } = {}) {
  const now = Date.now();
  fs.writeFileSync(f.heartbeatFile, `${JSON.stringify({
    schema: 1,
    driver: "pane-wake",
    persona: "codex",
    pid: alive ? process.pid : 999_999_999,
    ts: new Date(now - agoMs).toISOString(),
    pollMs: 1000,
    staleAfterMs: 30_000,
    eventsFile: path.join(f.root, "events.ndjson"),
    eventsOkAt: new Date(now - eventsAgoMs).toISOString(),
    eventsError,
    awaitingConfirm: false,
    pending: 0,
  })}\n`, { mode: 0o600 });
}

function watchdogFor(f, overrides = {}) {
  const logs = [];
  const watchdog = new PaneWakeWatchdog({
    heartbeatFile: f.heartbeatFile,
    tokenFile: path.join(f.root, "token"),
    checkMs: 15_000,
    once: true,
    token: TOKEN,
    output: (text) => logs.push(JSON.parse(text)),
    ...overrides,
  });
  return { watchdog, logs };
}

// Every test that pages stubs the wire; the wire itself is the driver suite's business (it has a
// live route test), and this suite is about WHEN we page and WHAT we send.
function stubFetch(responder = async () => ({ ok: true, status: 200, text: async () => "" })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return responder(url, init); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const pages = (logs) => logs.filter((l) => l.event === "page");

test("the detection window is the driver's measured cadence, not a guess", () => {
  // beat 5s · stale 30s · check 15s ⇒ a death is detected and paged within ~30-45s. If any of these
  // move, the window in the plan amendment and the page text move with them.
  assert.equal(CHECK_INTERVAL_MS, 15_000);
  const f = fixture();
  try {
    beat(f);
    const { watchdog } = watchdogFor(f);
    // The staleness bound is the DRIVER's, carried in its own record — the watchdog does not get to
    // have an opinion about it, which is what keeps the two from drifting apart.
    const record = JSON.parse(fs.readFileSync(f.heartbeatFile, "utf8"));
    assert.equal(record.staleAfterMs, 30_000);
    assert.ok(CHECK_INTERVAL_MS < record.staleAfterMs, "a check must be more frequent than the bound it tests");
    assert.ok(watchdog);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a fresh heartbeat pages nobody", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    beat(f);
    const { watchdog, logs } = watchdogFor(f);
    await watchdog.check();
    assert.equal(pages(logs).length, 0);
    assert.equal(wire.calls.length, 0);
    assert.equal(watchdog.episode, 0);
    assert.equal(watchdog.paged, false);
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("stale pages exactly ONCE per outage, and recovery re-arms the latch", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    beat(f, { agoMs: 45_000 });                       // past the 30 s bound
    const { watchdog, logs } = watchdogFor(f);
    for (let i = 0; i < 5; i += 1) await watchdog.check();
    assert.equal(pages(logs).length, 1, "latched: five observations, one page");
    assert.equal(wire.calls.length, 2, "one page, two recipients");
    assert.equal(watchdog.episode, 1);
    assert.match(pages(logs)[0].content, /STALE/);
    assert.match(pages(logs)[0].content, /re-arm/, "the page names the remedy");

    // RECOVERY: a fresh beat clears the episode and re-arms the latch.
    beat(f);
    await watchdog.check();
    assert.equal(watchdog.paged, false);
    assert.equal(watchdog.condition, null);
    assert.ok(logs.some((l) => l.event === "recovered" && l.from === "stale"));

    // A SECOND outage pages again — a latch that never re-opens is a one-shot alarm.
    beat(f, { agoMs: 45_000 });
    await watchdog.check();
    await watchdog.check();
    assert.equal(pages(logs).length, 2);
    assert.equal(watchdog.episode, 2);
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("absent, dead and unreadable all page; degraded does not", async () => {
  for (const [name, prepare, expectPage, matcher] of [
    ["absent (the file is gone)", (f) => { beat(f); fs.rmSync(f.heartbeatFile); }, true, /ABSENT/],
    ["dead (the recorded pid is gone)", (f) => beat(f, { alive: false }), true, /NOT RUNNING/],
    ["unreadable (liveness cannot be verified)", (f) => fs.writeFileSync(f.heartbeatFile, "not json", { mode: 0o600 }), true, /UNREADABLE/],
    // Beating, but the driver's INPUT path is broken. The driver alarms about that itself through
    // bounded silence; paging here as well would double every such alarm and teach the reader to
    // skim them. It still proves the process is alive, so it clears an open episode.
    ["degraded (beating, input path broken)", (f) => beat(f, { eventsError: "events-file-missing" }), false, null],
  ]) {
    const f = fixture();
    const wire = stubFetch();
    try {
      prepare(f);
      const { watchdog, logs } = watchdogFor(f);
      await watchdog.check();
      assert.equal(pages(logs).length, expectPage ? 1 : 0, name);
      if (expectPage) assert.match(pages(logs)[0].content, matcher, name);
    } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("an absent heartbeat that was NEVER seen names the misconfiguration, not a death", async () => {
  // ⛔ CRYING WOLF IS A REAL FAILURE MODE, so the two causes get different words. A heartbeat that
  // has never appeared since the watchdog started is at least as likely to be a driver armed
  // WITHOUT --heartbeat, or a watchdog pointed at the wrong path, as it is a dead driver.
  const f = fixture();
  const wire = stubFetch();
  try {
    const { watchdog, logs } = watchdogFor(f);          // no beat has ever been written
    await watchdog.check();
    const content = pages(logs)[0].content;
    assert.match(content, /ABSENT/);
    assert.match(content, /armed WITHOUT --heartbeat/);
    assert.match(content, /Check the launch argv/);
    // Once a beat HAS been seen, the same state reads as a death instead.
    beat(f);
    await watchdog.check();
    fs.rmSync(f.heartbeatFile);
    await watchdog.check();
    const second = pages(logs).at(-1).content;
    assert.match(second, /the file is gone/);
    assert.equal(second.includes("armed WITHOUT"), false);
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("the page uses the IMPORTED url and body composition, and never logs the credential", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    beat(f, { agoMs: 60_000 });
    const { watchdog, logs } = watchdogFor(f);
    await watchdog.check();
    assert.equal(wire.calls.length, 2);
    const recipients = [];
    for (const { url, init } of wire.calls) {
      assert.equal(url, HIVE_SEND_URL, "the transport URL is the driver's own constant, never a copy");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.deepEqual(body, hiveNoteBody(body.to, body.content), "the body is the driver's own composition");
      assert.equal(body.from, "codex", "alarms are attributed to codex, not to the token owner");
      recipients.push(body.to);
    }
    assert.deepEqual(recipients.sort(), ["assay", "codex"]);
    const serialised = JSON.stringify(logs);
    assert.equal(serialised.includes(TOKEN), false);
    assert.equal(serialised.includes("kjt_"), false);
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a page that fails to SEND does not latch, retries, and finally says nobody was told", async () => {
  // ⛔ THE LATCH CLOSES ON SUCCESS, NOT ON THE ATTEMPT. The driver's round-1 alarm latched on the
  // attempt, so one failed POST was the entire bounded-silence guarantee.
  const f = fixture();
  const wire = stubFetch(async () => { throw new Error("network down"); });
  try {
    beat(f, { agoMs: 60_000 });
    const { watchdog, logs } = watchdogFor(f);
    for (let i = 0; i < MAX_PAGE_ATTEMPTS + 3; i += 1) await watchdog.check();
    assert.equal(watchdog.paged, false, "never latched, because nobody was ever told");
    assert.equal(watchdog.attempts, MAX_PAGE_ATTEMPTS, "and the retries are capped");
    assert.equal(pages(logs).length, 0);
    const unsendable = logs.filter((l) => l.event === "page-unsendable");
    assert.equal(unsendable.length, 1);
    assert.match(unsendable[0].detail, /NOBODY HAS BEEN TOLD/);
    assert.ok(logs.filter((l) => l.event === "page-transport" && l.status === "failed").length >= 2);
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a rejected page (non-2xx) is not a delivered page", async () => {
  const f = fixture();
  const wire = stubFetch(async () => ({ ok: false, status: 404, text: async () => "" }));
  try {
    beat(f, { agoMs: 60_000 });
    const { watchdog, logs } = watchdogFor(f);
    await watchdog.check();
    assert.equal(watchdog.paged, false, "a 404 from the alert route is not an alarm anybody received");
    assert.ok(logs.some((l) => l.event === "page-transport" && l.status === "rejected" && l.httpStatus === 404));
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("with no credential the watchdog says LOG ONLY every time rather than latching", async () => {
  const f = fixture();
  const wire = stubFetch();
  try {
    beat(f, { agoMs: 60_000 });
    const { watchdog, logs } = watchdogFor(f, { token: null });
    await watchdog.check();
    await watchdog.check();
    assert.equal(wire.calls.length, 0);
    const logged = pages(logs);
    assert.equal(logged.length, 2, "no silent latch: a log line is not somebody being told");
    assert.equal(logged[0].channel, "log-only");
  } finally { wire.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("argv discipline: required, allowlisted, no duplicates, ranges enforced", () => {
  const base = ["--heartbeat", "/tmp/hb.json"];
  const options = parseArgs(base);
  assert.equal(options.heartbeatFile, path.resolve("/tmp/hb.json"));
  assert.equal(options.checkMs, CHECK_INTERVAL_MS);
  assert.equal(options.once, false);
  assert.ok(path.isAbsolute(options.tokenFile));
  assert.equal(Object.prototype.hasOwnProperty.call(options, "token"), false, "parseArgs must not read the credential");
  assert.equal(parseArgs([...base, "--once"]).once, true);
  assert.throws(() => parseArgs([]), /--heartbeat is required/);
  assert.throws(() => parseArgs(["--heartbeat", ""]), /--heartbeat is required/);
  // The measured typo class: a plausible misspelling must refuse, not silently watch a default.
  assert.throws(() => parseArgs(["--heartbeat-file", "/tmp/hb.json"]), /unknown option/);
  assert.throws(() => parseArgs([...base, "--heartbeat", "/tmp/other.json"]), /duplicate option/);
  for (const bad of ["ten", "", "-5", "999", "600001", "1.5"]) {
    assert.throws(() => parseArgs([...base, "--check-ms", bad]), /check-ms/, `--check-ms ${bad}`);
  }
  assert.equal(parseArgs([...base, "--check-ms", "1000"]).checkMs, 1000);
});

test("the credential file is gated exactly as the driver gates its own", () => {
  const f = fixture();
  try {
    const tokenFile = path.join(f.root, "token");
    fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    assert.equal(readPrivateTokenFile(tokenFile), TOKEN);
    fs.chmodSync(tokenFile, 0o644);
    assert.equal(readPrivateTokenFile(tokenFile), null, "world-readable is not private");
    fs.chmodSync(tokenFile, 0o600);
    const link = path.join(f.root, "linked-token");
    fs.symlinkSync(tokenFile, link);
    assert.equal(readPrivateTokenFile(link), null, "a symlink is not one regular file");
    fs.writeFileSync(path.join(f.root, "wrong"), "not-a-kijito-token\n", { mode: 0o600 });
    assert.equal(readPrivateTokenFile(path.join(f.root, "wrong")), null);
    assert.equal(readPrivateTokenFile(path.join(f.root, "missing")), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("the watchdog refuses to start without a heartbeat path, loudly", () => {
  const result = spawnSync(process.execPath, [watchdogFile], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.match(result.stderr, /--heartbeat is required/);
});

test("it is a DETECTOR: nothing in it can start, restart or signal anything", () => {
  // ⛔ SCOPE, ENFORCED RATHER THAN PROMISED. Auto-restart is a separate registry row, and the
  // reason is not tidiness: a supervisor that re-arms a wake driver can re-arm it into a pane whose
  // state nobody verified, which is precisely what the driver's send-time checks exist to prevent.
  const source = fs.readFileSync(watchdogFile, "utf8");
  for (const forbidden of ["spawn(", "spawnSync(", "exec(", "execSync(", "execFile", "process.kill", "launchctl", "send-keys", "tmux"]) {
    assert.equal(source.includes(forbidden), false, `a detector must not contain ${forbidden}`);
  }
  const watchdog = new PaneWakeWatchdog({ heartbeatFile: "/tmp/x", checkMs: 15_000, once: true, token: null, output: () => {} });
  for (const method of ["start", "stop", "check", "page", "pageContent", "log", "logQuiet"]) {
    assert.equal(typeof watchdog[method], "function", method);
  }
  // The whole public surface: observation and paging. No restart, no supervise, no arm.
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(watchdog)).sort();
  assert.deepEqual(surface, ["check", "constructor", "log", "logQuiet", "page", "pageContent", "start", "stop"]);
});
