// Integration tests: the helper `run` loop against the mock daemon — every §6-relevant
// behavior the battery will later prove on the REAL daemon, proven first in isolation:
// doorbell→wake with the fixed _shared text, defer-until-idle, double-arm idempotence,
// and the loud exits (daemon absent 3, producer absent/vanished 4, thread gone 5).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { MockDaemon } from "./mock-daemon.mjs";
import { WAKE_PREFIX } from "../../_shared/wake-core.mjs";

const HELPER = new URL("./kijito-wake-helper.mjs", import.meta.url).pathname;

function mkEnv(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wake-int-${name}-`));
  const events = path.join(dir, "events.ndjson");
  fs.writeFileSync(events, "");
  return { dir, events, sock: path.join(dir, "d.sock"), runtime: path.join(dir, "rt") };
}

function startHelper(env, threadId = "T1", extra = []) {
  const child = spawn(process.execPath, [HELPER, "run",
    "--persona", "codex", "--thread-id", threadId, "--events", env.events,
    "--sock", env.sock, "--runtime", env.runtime, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdoutText = ""; child.stderrText = "";
  child.stdout.on("data", (d) => { child.stdoutText += d; });
  child.stderr.on("data", (d) => { child.stderrText += d; });
  return child;
}

const waitFor = async (fn, ms = 5_000, step = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};

const mailLine = (id) => JSON.stringify({ source: "kijito-inbox", persona: "codex", event: "new", id }) + "\n";

test("doorbell on idle thread -> one turn/start with the fixed wake text", async () => {
  const env = mkEnv("happy");
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  const child = startHelper(env);
  assert.ok(await waitFor(() => child.stdoutText.includes('"event":"armed"')), `no armed: ${child.stderrText}`);
  fs.appendFileSync(env.events, mailLine(101));
  assert.ok(await waitFor(() => daemon.turnStarts().length === 1), "wake not delivered");
  const turn = daemon.turnStarts()[0];
  assert.equal(turn.params.threadId, "T1");
  const text = turn.params.input[0].text;
  assert.ok(text.startsWith(WAKE_PREFIX));
  assert.match(text, /Message IDs: 101/);
  child.kill("SIGKILL");
  await daemon.close();
});

test("busy thread defers; idle notification releases the queued wake", async () => {
  const env = mkEnv("defer");
  const daemon = new MockDaemon(env.sock, { initialStatus: "active" });
  await daemon.listen();
  const child = startHelper(env);
  assert.ok(await waitFor(() => child.stdoutText.includes('"event":"armed"')));
  fs.appendFileSync(env.events, mailLine(202));
  assert.ok(await waitFor(() => child.stdoutText.includes('"event":"doorbell"')));
  await new Promise((r) => setTimeout(r, 1200)); // longer than a poll+recheck cycle
  assert.equal(daemon.turnStarts().length, 0, "must not stomp a busy thread");
  daemon.setStatus("idle");
  assert.ok(await waitFor(() => daemon.turnStarts().length === 1), "deferred wake never delivered");
  assert.match(daemon.turnStarts()[0].params.input[0].text, /Message IDs: 202/);
  child.kill("SIGKILL");
  await daemon.close();
});

test("daemon socket absent -> loud exit 3", async () => {
  const env = mkEnv("nosock");
  const child = startHelper(env);
  const [code] = await once(child, "exit");
  assert.equal(code, 3);
  assert.match(child.stdoutText, /daemon-unavailable/);
});

test("events stream absent -> loud exit 4", async () => {
  const env = mkEnv("noevents");
  fs.unlinkSync(env.events);
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  const child = startHelper(env);
  const [code] = await once(child, "exit");
  assert.equal(code, 4);
  assert.match(child.stdoutText, /producer-stream-absent/);
  await daemon.close();
});

test("thread rejected on resume -> loud exit 5", async () => {
  const env = mkEnv("badthread");
  const daemon = new MockDaemon(env.sock, { failResume: true });
  await daemon.listen();
  const child = startHelper(env);
  const [code] = await once(child, "exit");
  assert.equal(code, 5);
  assert.match(child.stdoutText, /thread-gone/);
  await daemon.close();
});

test("producer stream vanishing mid-run -> gasp turn + loud exit 4", async () => {
  const env = mkEnv("vanish");
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  const child = startHelper(env);
  assert.ok(await waitFor(() => child.stdoutText.includes('"event":"armed"')));
  fs.unlinkSync(env.events);
  const [code] = await once(child, "exit");
  assert.equal(code, 4);
  assert.match(child.stdoutText, /producer-stream-vanished/);
  const gasps = daemon.turnStarts().filter((t) => t.params.input[0].text.includes("KIJITO WAKE HELPER NOTICE"));
  assert.equal(gasps.length, 1, "death must be visible in-session (assay §6-row-5 ruling)");
  assert.match(gasps[0].params.input[0].text, /catch-up-only/);
  await daemon.close();
});

test("second run on the same thread -> already-armed, exit 0 (double-arm probe shape)", async () => {
  const env = mkEnv("double");
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  const first = startHelper(env);
  assert.ok(await waitFor(() => first.stdoutText.includes('"event":"armed"')));
  const second = startHelper(env);
  const [code] = await once(second, "exit");
  assert.equal(code, 0);
  assert.match(second.stdoutText, /already-armed/);
  first.kill("SIGKILL");
  await daemon.close();
});

test("live helper on a DIFFERENT thread -> refuse exit 6, first helper untouched", async () => {
  const env = mkEnv("otherthread");
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  const first = startHelper(env, "T1");
  assert.ok(await waitFor(() => first.stdoutText.includes('"event":"armed"')));
  const second = startHelper(env, "T2");
  const [code] = await once(second, "exit");
  assert.equal(code, 6);
  assert.match(second.stderrText, /live-helper-other-thread/);
  assert.equal(first.exitCode, null, "first helper must stay alive");
  first.kill("SIGKILL");
  await daemon.close();
});

test("owned producer child dies (file remains) -> gasp + loud exit 4 (gate-3 A-4 binding control)", async () => {
  const env = mkEnv("proddeath");
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  // A stand-in producer that appends nothing and sleeps; the events file already exists, so
  // its death leaves the classic silent-tail scenario — which must now be LOUD.
  const child = startHelper(env, "T1", ["--producer-cmd", `${process.execPath} -e setTimeout(()=>{},60000)`]);
  assert.ok(await waitFor(() => child.stdoutText.includes('"event":"armed"')), child.stdoutText);
  // Find and kill the producer child (the helper's only node child with the sleep script).
  const rec = JSON.parse(fs.readFileSync(path.join(env.runtime, "helper-codex.pid"), "utf8"));
  assert.equal(rec.pid, child.pid);
  fs.appendFileSync(env.events, ""); // file remains — the trap shape
  // Kill the producer: it is the helper's child; find it via ps parentage.
  const { execSync } = await import("node:child_process");
  // pgrep -P is portable (BSD + GNU); `ps --ppid` is GNU-only and dies on macOS.
  // pgrep exits 1 on no-match, which for "list the children" simply means none.
  let kidsOut = "";
  try { kidsOut = execSync(`pgrep -P ${child.pid}`).toString(); } catch { kidsOut = ""; }
  const kids = kidsOut.trim().split("\n").map((s) => Number(s.trim())).filter(Boolean);
  assert.ok(kids.length >= 1, "helper should own a producer child");
  process.kill(kids[0], "SIGKILL");
  const [code] = await once(child, "exit");
  assert.equal(code, 4);
  assert.match(child.stdoutText, /producer-child-died/);
  const gasps = daemon.turnStarts().filter((t) => t.params.input[0].text.includes("KIJITO WAKE HELPER NOTICE"));
  assert.equal(gasps.length, 1, "producer death must be visible in-session");
  await daemon.close();
});

test("SIGTERM -> gasp + pidfile cleanup (graceful path of §6 row 5)", async () => {
  const env = mkEnv("sigterm");
  const daemon = new MockDaemon(env.sock);
  await daemon.listen();
  const child = startHelper(env);
  assert.ok(await waitFor(() => child.stdoutText.includes('"event":"armed"')));
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const gasps = daemon.turnStarts().filter((t) => t.params.input[0].text.includes("KIJITO WAKE HELPER NOTICE"));
  assert.equal(gasps.length, 1);
  assert.equal(fs.existsSync(path.join(env.runtime, "helper-codex.pid")), false, "pidfile must be reaped");
  await daemon.close();
});
