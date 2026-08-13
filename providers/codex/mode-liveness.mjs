// MODE-AWARE LIVENESS for the codex provider: given the declared delivery mode, answer "is the
// thing that SHOULD be running actually running — and is anything running that should NOT be?"
//
// This module exists so the watchdog can stay a detector with no hands and no mode logic of its
// own: it imports ONE function, `readModeLiveness`, exactly the way it already imports
// `readLiveness` from the driver. All process probing (`process.kill(pid, 0)`) lives here, keeping
// the watchdog file clean of anything its forbidden-token test would read as a hand.
//
// The vocabulary is the driver's own liveness vocabulary (alive / degraded / stale / absent /
// dead / unreadable) plus ONE new state, `unexpected-consumer`, for the attended-notify inversion:
// under attended mode NO consumer may run, so a held consumer.lock is the outage. Every result
// carries `mode` so a page can name which declaration reality diverged from.
import fs from "node:fs";

import { readLiveness } from "./pane-wake.mjs";
import { readDeclaredMode } from "./mode-register.mjs";

// The controller's own freshness contract, verbatim from the readiness gate (cli.mjs): a
// clientStatus.checkedAt older than max(5s, pollMs*4) is stale — and one from the FUTURE beyond
// pollMs*2 is stale too, because a timestamp that moved for the wrong reason (clock skew, a
// restored file, an environment-manufactured observable) must never read as health. That negative
// bound is the lesson of the seat-cert post-close anomaly: characterize the observable, and when
// it is out of character, say so instead of trusting it.
const CLIENT_FRESHNESS_FLOOR_MS = 5_000;

function readPrivateJson(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return { error: error.code === "ENOENT" ? "absent" : (error.code ?? error.message) };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { error: "not-one-regular-file" };
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return { error: "not-private" };
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: `parse: ${error.message}` };
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// app-server-seat: the supervised controller IS the seat. Liveness = the controller's own
// self-reported clientStatus freshness + its pid.
function readControllerLiveness(stateFile, now = Date.now()) {
  const read = readPrivateJson(stateFile);
  if (read.error === "absent") return { status: "absent", stateFile };
  if (read.error) return { status: "unreadable", stateFile, reason: read.error };
  const state = read.value;
  const pid = state?.controllerPid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return { status: "unreadable", stateFile, reason: "no-controller-pid" };
  const client = state.clientStatus;
  if (!client || typeof client !== "object" || Array.isArray(client)
    || typeof client.checkedAt !== "string" || !Number.isFinite(Date.parse(client.checkedAt))
    || !Number.isSafeInteger(client.pollMs) || client.pollMs < 100 || client.pollMs > 60_000) {
    return { status: "unreadable", stateFile, reason: "client-status-shape", pid };
  }
  const ageMs = now - Date.parse(client.checkedAt);
  const staleAfterMs = Math.max(CLIENT_FRESHNESS_FLOOR_MS, client.pollMs * 4);
  const base = { pid, ageMs, staleAfterMs, stateFile };
  if (!pidAlive(pid)) return { status: "dead", ...base };
  if (ageMs < -client.pollMs * 2) return { status: "stale", reason: "clock-skew-future-timestamp", ...base };
  if (ageMs > staleAfterMs) return { status: "stale", ...base };
  // Beating but the supervised child is not idle-healthy: degraded, exactly like a beating pane
  // driver with a broken input path. The controller alarms about its own child through its log;
  // paging here would double it.
  if (client.status !== "idle") return { status: "degraded", reason: `client-${client.status ?? "unknown"}`, ...base };
  return { status: "alive", ...base };
}

// attended-notify: no consumer may run. The lock's ABSENCE is health; a held lock is the outage.
function readAttendedLiveness(lockFile) {
  let stat;
  try {
    stat = fs.lstatSync(lockFile);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "alive", lockFile, consumer: null };
    return { status: "unreadable", lockFile, reason: error.code ?? error.message };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unreadable", lockFile, reason: "lock-not-a-regular-file" };
  const read = readPrivateJson(lockFile);
  if (read.error) return { status: "unexpected-consumer", lockFile, pid: null, reason: read.error };
  const pid = Number.isSafeInteger(read.value?.pid) ? read.value.pid : null;
  return { status: "unexpected-consumer", lockFile, pid, holderAlive: pid === null ? null : pidAlive(pid) };
}

// The one entry point the watchdog uses. Reads the register FRESH on every call — a declaration
// can change between checks, and a cached mode is a stale mode.
//   options: { heartbeatFile, controllerStateFile, consumerLockFile }
function readModeLiveness(registerFile, options, now = Date.now()) {
  const declared = readDeclaredMode(registerFile);
  if (declared.status === "absent") {
    return { status: "unreadable", mode: null, reason: "mode-register-absent", registerFile };
  }
  if (declared.status !== "declared") {
    return { status: "unreadable", mode: null, reason: `mode-register-${declared.status}: ${declared.reason ?? ""}`, registerFile };
  }
  if (declared.mode === "codex.tmux-pane") {
    return { mode: declared.mode, ...readLiveness(options.heartbeatFile, now) };
  }
  if (declared.mode === "codex.app-server-seat") {
    return { mode: declared.mode, ...readControllerLiveness(options.controllerStateFile, now) };
  }
  // codex.attended-notify — the only remaining recognized mode.
  return { mode: declared.mode, ...readAttendedLiveness(options.consumerLockFile) };
}

export { readModeLiveness, readControllerLiveness, readAttendedLiveness, CLIENT_FRESHNESS_FLOOR_MS };
