#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installRoot = path.dirname(fileURLToPath(import.meta.url));
const manifestFile = path.join(installRoot, "installed-manifest.json");
// Mirrors the repo layout (providers/codex/controller.mjs + providers/_shared/wake-core.mjs) so the
// controller's import specifier is the same in the repo and in the install.
const controllerFile = path.join(installRoot, "codex", "controller.mjs");
const wakeCoreFile = path.join(installRoot, "_shared", "wake-core.mjs");
const authBindingFile = path.join(installRoot, "codex", "auth-binding.mjs");
const paneWakeFile = path.join(installRoot, "codex", "pane-wake.mjs");
const watchdogFile = path.join(installRoot, "codex", "pane-wake-watchdog.mjs");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifiedModuleDataUrl(file, expectedSha256) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error("O_NOFOLLOW is required for executable module verification");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("verified module must be one regular file");
    const bytes = fs.readFileSync(fd);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256) throw new Error("verified module hash mismatch");
    return `data:text/javascript;base64,${bytes.toString("base64")}`;
  } finally { fs.closeSync(fd); }
}

function loadManifest() {
  const stat = fs.lstatSync(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("installed manifest is not private and user-owned");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.schema !== 1 || manifest.product !== "codex-kijito-hive" || manifest.paths.installRoot !== installRoot) throw new Error("installed manifest identity mismatch");
  if (manifest.origin?.package !== "kijito-claude" || manifest.origin?.packageVersion !== "0.1.4"
    || manifest.origin?.repository !== "https://github.com/KijitoAI/kijito-claude"
    || !/^[0-9a-f]{40}$/.test(manifest.origin?.gitSha ?? "")) {
    throw new Error("installed manifest origin is missing or invalid");
  }
  if (!Array.isArray(manifest.paths.legacyInstallRoots)
    || manifest.paths.legacyInstallRoots.length === 0
    || !manifest.paths.legacyInstallRoots.every(censusPathIsRepresentable)) {
    throw new Error("installed manifest has no valid explicit legacy census scope");
  }
  return manifest;
}

function checkRealPrivateDirectory(dir, label) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error(`${label} is not a private user-owned real directory`);
}

function checkPrivateFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error(`${label} is not one private user-owned regular file`);
}

function optionalHash(file) {
  try { return sha256(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function processCommand(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function splitProcessCommand(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ""; }
    } else token += char;
  }
  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function censusPathIsRepresentable(value) {
  return typeof value === "string" && path.isAbsolute(value) && !/[\s'"\\]/.test(value);
}

function pathIdentity(value) {
  const realpath = fs.realpathSync(value);
  const stat = fs.statSync(realpath, { bigint: true });
  return { realpath, dev: String(stat.dev), ino: String(stat.ino) };
}

function samePathIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function controllerCandidatePaths(root) {
  return [path.join(root, "codex", "controller.mjs"), path.join(root, "controller.mjs")];
}

function censusBinding(manifest) {
  const legacyRoots = manifest.paths.legacyInstallRoots;
  if (!Array.isArray(legacyRoots) || legacyRoots.length === 0) {
    return { status: "BLOCKED", code: "PROCESS_CENSUS_LEGACY_SCOPE_REQUIRED", matches: [] };
  }
  const roots = [...new Set([installRoot, ...legacyRoots])];
  const expectedPaths = {
    "--codex-home": manifest.paths.codexHome,
    "--workspace": manifest.paths.workspace,
    "--runtime": manifest.paths.runtime,
    "--events": manifest.paths.eventsFile,
  };
  const boundPaths = [...roots, manifest.paths.nodeBin, ...Object.values(expectedPaths)];
  if (!boundPaths.every(censusPathIsRepresentable)) {
    return { status: "BLOCKED", code: "PROCESS_CENSUS_PATH_UNREPRESENTABLE", matches: [] };
  }
  const controllers = [];
  for (const root of roots) {
    const identities = [];
    for (const candidate of controllerCandidatePaths(root)) {
      try { identities.push({ path: candidate, identity: pathIdentity(candidate) }); }
      catch (error) { if (error.code !== "ENOENT") {
        return { status: "BLOCKED", code: "PROCESS_CENSUS_CONTROLLER_SCOPE_UNRESOLVABLE",
          reason: error.code ?? error.message, matches: [] };
      } }
    }
    if (identities.length === 0) {
      return { status: "BLOCKED", code: "PROCESS_CENSUS_CONTROLLER_SCOPE_UNRESOLVABLE",
        root, matches: [] };
    }
    controllers.push(...identities);
  }
  let nodeIdentity;
  const expectedIdentities = {};
  try {
    nodeIdentity = pathIdentity(manifest.paths.nodeBin);
    for (const [flag, value] of Object.entries(expectedPaths)) {
      expectedIdentities[flag] = pathIdentity(value);
    }
  } catch (error) {
    return { status: "BLOCKED", code: "PROCESS_CENSUS_BOUND_PATH_UNRESOLVABLE",
      reason: error.code ?? error.message, matches: [] };
  }
  return { status: "PASS", controllers, nodeIdentity, expectedIdentities };
}

function isNodeInvocation(token, expectedNodeIdentity) {
  if (!token || !path.isAbsolute(token)) return false;
  try {
    const identity = pathIdentity(token);
    return samePathIdentity(identity, expectedNodeIdentity)
      || /^(?:node|nodejs|cua_node)$/.test(path.basename(identity.realpath));
  } catch {
    return /^(?:node|nodejs|cua_node)$/.test(path.basename(token));
  }
}

function controllerTokenDisposition(token, controllers) {
  if (!token || !path.isAbsolute(token)) return "none";
  try {
    const identity = pathIdentity(token);
    return controllers.some((item) => samePathIdentity(identity, item.identity)) ? "match" : "none";
  } catch {
    // A row that presents as a Node controller invocation but whose script cannot be resolved is
    // unknown, never evidence that no controller exists.
    return path.basename(token) === "controller.mjs" ? "unresolvable" : "none";
  }
}

export function processPopulation(manifest) {
  const binding = censusBinding(manifest);
  if (binding.status !== "PASS") return binding;
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    return { status: "BLOCKED", code: "PROCESS_CENSUS_UNAVAILABLE", matches: [] };
  }
  const rows = [];
  const unparseable = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const command = match[3];
    const tokens = splitProcessCommand(command);
    // The launcher always invokes: <node> <controller.mjs> <bound flags>. A path merely mentioned
    // later by tail/editor/node -e is a bystander, not a controller candidate. Conversely, once the
    // executable-argument position presents as our controller, any parse/resolve failure is UNKNOWN.
    const prefix = command.match(/^\s*(\S+)\s+(\S+)/);
    const nodeToken = tokens?.[0] ?? prefix?.[1];
    const controllerToken = tokens?.[1] ?? prefix?.[2];
    if (!isNodeInvocation(nodeToken, binding.nodeIdentity)) continue;
    const disposition = controllerTokenDisposition(controllerToken, binding.controllers);
    if (disposition === "none") continue;
    if (!tokens || disposition === "unresolvable") {
      unparseable.push(Number(match[1]));
      continue;
    }
    const args = {};
    let valid = true;
    for (const flag of ["--codex-home", "--workspace", "--runtime", "--events"]) {
      const index = tokens.indexOf(flag);
      if (index < 0 || index !== tokens.lastIndexOf(flag) || tokens[index + 1] === undefined) {
        valid = false;
        break;
      }
      args[flag] = tokens[index + 1];
    }
    if (!valid) {
      unparseable.push(Number(match[1]));
      continue;
    }
    const argIdentities = {};
    try {
      for (const [flag, value] of Object.entries(args)) argIdentities[flag] = pathIdentity(value);
    } catch {
      unparseable.push(Number(match[1]));
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command,
      tokens,
      controllerPath: controllerToken,
      args,
      argIdentities,
    });
  }
  if (unparseable.length) {
    return {
      status: "BLOCKED",
      code: "PROCESS_CENSUS_CANDIDATE_UNPARSEABLE",
      matches: rows,
      unparseablePids: unparseable,
    };
  }
  return { status: "PASS", code: "PROCESS_CENSUS_COMPLETE", matches: rows,
    expectedIdentities: binding.expectedIdentities };
}

export function enumerateControllerInstances(manifest, probe = processPopulation) {
  const census = probe(manifest);
  if (census.status !== "PASS") return census;
  // A narrowly injected test/proof probe may already return its exact population. The real census
  // always supplies expectedIdentities and therefore always takes the identity comparison below.
  if (!census.expectedIdentities) return census;
  return { ...census, matches: census.matches.filter((row) =>
    Object.entries(census.expectedIdentities).every(([flag, identity]) =>
      samePathIdentity(row.argIdentities[flag], identity))) };
}

export function lockStatus(manifest, probes = {
  kill: process.kill.bind(process),
  command: processCommand,
  population: processPopulation,
}) {
  const lockFile = path.join(manifest.paths.runtime, "consumer.lock");
  let bytes;
  try { bytes = fs.readFileSync(lockFile, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { state: "stopped", lockFile };
    return { state: "unreadable-lock", reason: error.code ?? "lock-read-failed", lockFile };
  }
  let lock;
  try { lock = JSON.parse(bytes); }
  catch { return { state: "invalid-lock", reason: "lock-json-unparseable", lockFile }; }
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 1 || typeof lock.token !== "string" || lock.persona !== "codex") return { state: "invalid-lock", lockFile };
  try { probes.kill(lock.pid, 0); }
  catch (error) {
    if (error.code !== "ESRCH") {
      return { state: "unverifiable-lock", pid: lock.pid, reason: error.code ?? "signal-probe-failed", lockFile };
    }
    const population = enumerateControllerInstances(manifest, probes.population);
    if (population.status !== "PASS") {
      return { state: "unverifiable-lock", pid: lock.pid, reason: population.code, lockFile };
    }
    return population.matches.length === 0
      ? { state: "stale-lock", pid: lock.pid, population: [], lockFile }
      : { state: "population-mismatch", pid: lock.pid, population: population.matches, lockFile };
  }
  const command = probes.command(lock.pid);
  // The lock is shared with the pane-wake driver, which may legitimately run from the repo
  // checkout as well as from the install root, so it is recognised by module name rather than
  // by absolute path (main-parent semantics; the controller census below does not apply to it).
  if (command.includes(paneWakeFile) || /pane-wake\.mjs(\s|$)/.test(command)) {
    return { state: "running", holder: "pane-wake", pid: lock.pid, command, lockFile };
  }
  const population = enumerateControllerInstances(manifest, probes.population);
  if (population.status !== "PASS") {
    return { state: "unverifiable-lock", pid: lock.pid, reason: population.code, lockFile };
  }
  if (population.matches.length !== 1 || population.matches[0].pid !== lock.pid) {
    return { state: "population-mismatch", pid: lock.pid, population: population.matches, lockFile };
  }
  return { state: "running", holder: "controller", pid: lock.pid, command, population: population.matches, lockFile };
}

function lockFingerprint(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  const bytes = fs.readFileSync(file);
  return { bytes, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
}

function lockFingerprintFd(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n
    || stat.nlink !== 1n || stat.size > 65_536n) {
    throw new Error("stale consumer lock descriptor is not one small private user-owned file");
  }
  const bytes = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("stale consumer lock changed size while reading");
    offset += count;
  }
  return { bytes, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
}

function sameFingerprint(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.bytes.equals(right.bytes);
}

function fsyncDirectory(dirPath) {
  const dir = fs.openSync(dirPath, "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function repairStaleLock(manifest, probes) {
  const before = lockStatus(manifest, probes);
  if (before.state !== "stale-lock") {
    throw new Error(`refusing stale-lock repair in state ${before.state}`);
  }
  checkPrivateFile(before.lockFile, "stale consumer lock");
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is required for stale-lock repair");
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(before.lockFile, flags);
  try {
    // Keep the verified inode open across both the repeated evidence check and the rename. The
    // path fingerprint catches a pre-rename swap; the descriptor fingerprint proves the evidence
    // inode itself did not change underneath us.
    const first = lockFingerprintFd(fd);
    probes?.afterFirstFingerprint?.({ lockFile: before.lockFile });
    const confirmed = lockStatus(manifest, probes);
    if (confirmed.state !== "stale-lock" || confirmed.pid !== before.pid) {
      throw new Error(`stale-lock evidence changed during repair (${confirmed.state})`);
    }
    const secondPath = lockFingerprint(before.lockFile);
    const secondFd = lockFingerprintFd(fd);
    if (!sameFingerprint(first, secondPath) || !sameFingerprint(first, secondFd)) {
      throw new Error("stale consumer lock changed during repair");
    }
    probes?.beforeQuarantineRename?.({ lockFile: before.lockFile });
    const quarantine = `${before.lockFile}.stale.${new Date().toISOString().replaceAll(":", "-")}.${first.ino}`;
    fs.renameSync(before.lockFile, quarantine);
    probes?.afterQuarantineRename?.({ lockFile: before.lockFile, quarantine });
    const moved = lockFingerprint(quarantine);
    const held = lockFingerprintFd(fd);
    if (!sameFingerprint(first, moved) || !sameFingerprint(first, held)) {
      let rollback = "not-attempted";
      try {
        if (fs.existsSync(before.lockFile)) {
          rollback = "blocked-original-path-reappeared";
        } else {
          fs.renameSync(quarantine, before.lockFile);
          const restored = lockFingerprint(before.lockFile);
          rollback = sameFingerprint(restored, moved) ? "restored-displaced-entry" : "restored-entry-mismatch";
          fsyncDirectory(path.dirname(before.lockFile));
        }
      } catch (error) {
        rollback = `failed:${error.code ?? error.message}`;
      }
      throw new Error(`quarantined stale lock is not the verified inode; rollback=${rollback}`);
    }
    fsyncDirectory(path.dirname(before.lockFile));
    // Quarantines are retained as recoverable evidence by design; cleanup is never automatic.
    return { status: "STALE_LOCK_QUARANTINED", pid: before.pid, lockFile: before.lockFile,
      quarantine, recoverable: true };
  } finally {
    fs.closeSync(fd);
  }
}

function readLogRows(file) {
  checkPrivateFile(file, "controller log");
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("controller log contains a non-object row");
    }
    return value;
  });
}

export function inspectRuntimeReadiness(manifest, controllerStatus) {
  if (controllerStatus.state !== "running") {
    return { status: "INACTIVE", code: "CONTROLLER_NOT_RUNNING" };
  }
  const stateFile = path.join(manifest.paths.runtime, "state.json");
  const logFile = path.join(manifest.paths.runtime, "controller.ndjson");
  let state;
  try {
    checkPrivateFile(stateFile, "runtime state");
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    return { status: "BLOCKED", code: "STATE_UNAVAILABLE", reason: error.code ?? error.message };
  }
  if (state.schema !== 2 || state.persona !== "codex" || typeof state.threadId !== "string"
    || !state.threadId || !Number.isSafeInteger(state.offset) || state.offset < 0) {
    return { status: "BLOCKED", code: "STATE_IDENTITY_UNKNOWN" };
  }
  if (!Object.hasOwn(state, "ambiguous") || (state.ambiguous !== null
      && (typeof state.ambiguous !== "object" || Array.isArray(state.ambiguous)))
    || !Object.hasOwn(state, "inFlight") || (state.inFlight !== null
      && (typeof state.inFlight !== "object" || Array.isArray(state.inFlight)))
    || !Array.isArray(state.pending)
    || !state.streamStatus || typeof state.streamStatus !== "object"
    || Array.isArray(state.streamStatus)) {
    return { status: "BLOCKED", code: "STATE_SHAPE_UNKNOWN" };
  }
  if (state.controllerPid !== controllerStatus.pid || typeof state.controllerRunId !== "string"
    || !/^[0-9a-f]{32}$/.test(state.controllerRunId)) {
    return { status: "FAIL", code: "STATE_PROCESS_MISMATCH" };
  }
  if (state.ambiguous !== null) return { status: "FAIL", code: "ACCEPTANCE_AMBIGUOUS" };
  if (state.inFlight !== null) return { status: "FAIL", code: "TURN_UNRESOLVED" };
  if (state.pending.length !== 0) {
    return { status: "FAIL", code: "DELIVERY_BACKLOG", pendingCount: state.pending.length };
  }
  const client = state.clientStatus;
  if (!client || typeof client !== "object" || Array.isArray(client)
    || client.status !== "idle" || !Number.isSafeInteger(client.childPid) || client.childPid <= 1
    || !Number.isSafeInteger(client.pollMs) || client.pollMs < 100 || client.pollMs > 60_000
    || typeof client.checkedAt !== "string" || !Number.isFinite(Date.parse(client.checkedAt))) {
    return { status: "FAIL", code: "APP_SERVER_LIVENESS_UNPROVEN" };
  }
  const clientAgeMs = Date.now() - Date.parse(client.checkedAt);
  const freshnessMs = Math.max(5_000, client.pollMs * 4);
  if (clientAgeMs < -client.pollMs * 2 || clientAgeMs > freshnessMs) {
    return { status: "FAIL", code: "APP_SERVER_HEARTBEAT_STALE", ageMs: clientAgeMs, freshnessMs };
  }
  const parent = spawnSync("/bin/ps", ["-p", String(client.childPid), "-o", "ppid="], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (parent.error) {
    return { status: "BLOCKED", code: "APP_SERVER_PROCESS_UNVERIFIABLE", reason: parent.error.code ?? parent.error.message };
  }
  const parentPid = Number(parent.stdout.trim());
  if (parent.status !== 0 || !Number.isSafeInteger(parentPid) || parentPid !== controllerStatus.pid) {
    return { status: "FAIL", code: "APP_SERVER_PROCESS_MISMATCH", childPid: client.childPid };
  }
  if (state.streamStatus?.status === "blocked") {
    return { status: "BLOCKED", code: "STREAM_CHECK_BLOCKED", reason: state.streamStatus.reason };
  }
  if (state.streamStatus?.status !== "clear" || state.streamStatus.unreadBytes !== 0) {
    return { status: "FAIL", code: "STREAM_BACKLOG", unreadBytes: state.streamStatus?.unreadBytes ?? null };
  }

  // A4 bounded recheck, independently repeated by doctor. Any stat/read failure is UNKNOWN/BLOCKED,
  // never the same verdict as an empty stream.
  let first;
  let second;
  try {
    checkPrivateFile(manifest.paths.eventsFile, "monitor event stream");
    first = fs.lstatSync(manifest.paths.eventsFile);
    second = fs.lstatSync(manifest.paths.eventsFile);
  } catch (error) {
    return { status: "BLOCKED", code: "STREAM_UNAVAILABLE", reason: error.code ?? error.message };
  }
  if (!state.eventFile || first.dev !== state.eventFile.dev || first.ino !== state.eventFile.ino
    || second.dev !== first.dev || second.ino !== first.ino) {
    return { status: "FAIL", code: "STREAM_IDENTITY_MISMATCH" };
  }
  if (first.size !== state.offset || second.size !== first.size) {
    return { status: "FAIL", code: "STREAM_BACKLOG", unreadBytes: Math.max(0, second.size - state.offset) };
  }

  let rows;
  try { rows = readLogRows(logFile); }
  catch (error) {
    return { status: "BLOCKED", code: "LIFECYCLE_EVIDENCE_UNAVAILABLE", reason: error.code ?? error.message };
  }
  const currentRun = rows.filter((row) => row.pid === state.controllerPid
    && row.runId === state.controllerRunId);
  const current = currentRun.filter((row) => row.threadId === state.threadId);
  const armed = current.findLast((row) => row.event === "armed" || row.event === "rearmed-after-codex-restart");
  const surfaced = current.findLast((row) => row.event === "surfaced"
    && row.terminal === "completed");
  if (!armed || !surfaced || !state.armedAt || !state.lastTerminal
    || state.lastTerminal.status !== "completed") {
    return { status: "FAIL", code: "WAKE_EFFECT_UNPROVEN",
      armedSeen: Boolean(armed), surfaceSeen: Boolean(surfaced) };
  }
  const armedIndex = currentRun.findLastIndex((row) => row.threadId === state.threadId
    && (row.event === "armed" || row.event === "rearmed-after-codex-restart"));
  const exitIndex = currentRun.findLastIndex((row) => row.event === "app-server-exit");
  if (exitIndex > armedIndex) {
    return { status: "FAIL", code: "APP_SERVER_EXITED_AFTER_ARM" };
  }
  return {
    status: "PASS",
    code: "WAKE_READY",
    pid: state.controllerPid,
    runId: state.controllerRunId,
    threadId: state.threadId,
    childPid: client.childPid,
    stream: { dev: first.dev, ino: first.ino, offset: state.offset, unreadBytes: 0 },
    armedAt: armed.ts,
    surfacedAt: surfaced.ts,
  };
}

export function rollupRequiredStatuses(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return "BLOCKED";
  if (verdicts.every((item) => item?.status === "PASS")) return "PASS";
  if (verdicts.some((item) => item?.status === "BLOCKED")) return "BLOCKED";
  if (verdicts.some((item) => item?.status === "FAIL")) return "RED";
  // Unknown future states are not members of the required-good set.
  return "BLOCKED";
}

// ⛔ ONE IMPLEMENTATION OF LIVENESS, IMPORTED — NOT A SECOND COPY.
// This used to be a hand-copy of the driver's `readLiveness` with two small divergences already
// (a hard-coded staleness floor, a dropped field), which is a drift surface on the one signal an
// operator uses to decide whether the wake pipeline is alive — and the copy in this file is the one
// they actually run. It now calls the installed driver's own function, and says so plainly when
// there is no installed driver to ask.
// ⛔ ONE DEFINITION OF WHERE THE HEARTBEAT LIVES. The launcher passes `--heartbeat`, `status` and
// `doctor` read it, and the watchdog is pointed at it: three consumers, and if any of them derives
// the path independently the failure is silent in the worst direction — a watchdog watching a file
// nobody writes reports a healthy driver as dead, or worse, a dead one as absent-and-therefore-
// somebody-else's-problem. The path is <installRoot>/runtime-pane/heartbeat.json.
function paneHeartbeatFile(manifest) {
  const paneRuntime = manifest.paths.paneRuntime ?? path.join(manifest.paths.installRoot, "runtime-pane");
  return path.join(paneRuntime, "heartbeat.json");
}

// An arm made BEFORE `--heartbeat` joined the launch argv writes to the driver's own default, next
// to the lock. Reporting that as "absent" would be a false death, so the legacy location is read as
// a fallback and named when it is what answered.
function legacyPaneHeartbeatFile(manifest) {
  return path.join(manifest.paths.runtime, "pane-wake.heartbeat");
}

async function paneWakeLiveness(manifest, now = Date.now()) {
  const canonical = paneHeartbeatFile(manifest);
  const legacy = legacyPaneHeartbeatFile(manifest);
  const heartbeatFile = fs.existsSync(canonical) || !fs.existsSync(legacy) ? canonical : legacy;
  if (!fs.existsSync(paneWakeFile)) return { status: "not-installed", heartbeatFile };
  try {
    const { readLiveness } = await import(pathToFileURL(paneWakeFile).href);
    const liveness = readLiveness(heartbeatFile, now);
    return heartbeatFile === legacy ? { ...liveness, legacyHeartbeatPath: true } : liveness;
  } catch (error) {
    return { status: "unreadable", heartbeatFile, reason: "driver-module-unloadable" };
  }
}

// The supervisor entry point. "Who watches the watcher" had no answer: the heartbeat was pull-only,
// nothing restarted a dead pane driver, and `stop` explicitly refuses to signal it. This gives the
// dead state an owner — a command an operator or a periodic job can call, which decides from the
// SAME liveness signal and refuses rather than guesses.
async function paneSupervise(manifest, options) {
  const liveness = await paneWakeLiveness(manifest);
  if (liveness.status === "not-installed") return { status: "UNAVAILABLE", reason: "pane driver is not installed", liveness };
  if (liveness.status === "alive") return { status: "ALIVE", liveness };
  const lock = lockStatus(manifest);
  if (lock.state === "running" && lock.holder === "controller") {
    return { status: "REFUSED", reason: "the single-consumer lock is held by the controller", lock, liveness };
  }
  if (lock.state === "running" && lock.holder === "pane-wake" && liveness.status !== "dead") {
    return { status: "REFUSED", reason: `the lock is held by a running pane-wake (pid ${lock.pid}) whose heartbeat is ${liveness.status}`, lock, liveness };
  }
  const threadId = options.expectThread ?? persistedThreadId(manifest);
  if (!threadId) return { status: "REFUSED", reason: "no --expect-thread and no persisted thread id", liveness };
  const args = paneWakeArgs(manifest, threadId, options);
  if (options.dryRun) return { status: "WOULD_START", reason: liveness.status, command: [options.nodeBin ?? manifest.paths.nodeBin, ...args], liveness };
  if (lock.state === "stale-lock") return { status: "REFUSED", reason: `a stale lock from pid ${lock.pid} must be removed by a human`, lock, liveness };
  const logFile = path.join(manifest.paths.runtime, "pane-wake.ndjson");
  const fd = fs.openSync(logFile, "a", 0o600);
  fs.chmodSync(logFile, 0o600);
  let child;
  try {
    child = spawn(manifest.paths.nodeBin, args, { detached: true, env: safeEnv(), stdio: ["ignore", fd, fd] });
    child.unref();
  } finally { fs.closeSync(fd); }
  const started = await waitFor(async () => {
    const current = await paneWakeLiveness(manifest);
    return ["alive", "degraded"].includes(current.status) ? current : null;
  }, 15_000, "pane-wake heartbeat");
  return { status: "STARTED", pid: started.pid, logFile, liveness: started };
}

function paneWakeArgs(manifest, threadId, options = {}) {
  return [
    paneWakeFile,
    "--install-root", manifest.paths.installRoot,
    "--events", manifest.paths.eventsFile,
    "--token-file", manifest.paths.tokenFile,
    // Part of the STANDARD launch argv, so every future arm is watchable by construction rather
    // than by somebody remembering to add a flag.
    "--heartbeat", paneHeartbeatFile(manifest),
    "--expect-thread", threadId,
    ...(options.paneSession ? ["--pane-session", options.paneSession] : []),
    ...(options.tmux ? ["--tmux", options.tmux] : []),
  ];
}

function persistedThreadId(manifest) {
  const stateFile = path.join(manifest.paths.paneRuntime ?? path.join(manifest.paths.installRoot, "runtime-pane"), "state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return typeof parsed.threadId === "string" && parsed.threadId.length > 0 ? parsed.threadId : null;
  } catch { return null; }
}

async function doctor(manifest) {
  checkRealPrivateDirectory(installRoot, "install root");
  checkRealPrivateDirectory(manifest.paths.codexHome, "dedicated Codex home");
  checkRealPrivateDirectory(manifest.paths.workspace, "dedicated workspace");
  checkRealPrivateDirectory(manifest.paths.runtime, "runtime directory");
  checkRealPrivateDirectory(path.dirname(controllerFile), "controller directory");
  checkRealPrivateDirectory(path.dirname(wakeCoreFile), "shared wake-core directory");
  if (fs.readdirSync(manifest.paths.workspace).length !== 0) throw new Error("dedicated workspace is not empty");
  const files = {
    controller: controllerFile,
    wakeCore: wakeCoreFile,
    authBindingModule: authBindingFile,
    cli: path.join(installRoot, "cli.mjs"),
    config: path.join(manifest.paths.codexHome, "config.toml"),
    auth: path.join(manifest.paths.codexHome, "auth.json"),
    launcher: manifest.paths.launcher,
    token: manifest.paths.tokenFile,
  };
  // Auth evidence is classified by the one shared parser below so absence/unparseability becomes a
  // structured BLOCKED/UNKNOWN verdict instead of an uncaught doctor abort. Every other artifact
  // keeps the ordinary integrity gate here.
  for (const [label, file] of Object.entries(files)) {
    if (label !== "auth") checkPrivateFile(file, label);
  }
  // ⛔ FAIL-CLOSED IN BOTH DIRECTIONS, because this file is present on installs made before it was
  // gated. If the manifest declares a hash, the file MUST exist and match; if the file exists, the
  // manifest MUST declare a hash. Only "neither" is legal, and it is reported rather than assumed.
  const paneWakeInstalled = fs.existsSync(paneWakeFile);
  const paneWakeDeclared = typeof manifest.hashes.paneWakeSha256 === "string";
  if (paneWakeDeclared !== paneWakeInstalled) {
    throw new Error(paneWakeDeclared ? "pane wake driver is gated but missing" : "pane wake driver is installed but ungated");
  }
  if (paneWakeInstalled) {
    files.paneWake = paneWakeFile;
    checkPrivateFile(paneWakeFile, "paneWake");
  }
  // M223: the detector gets the same declared-XOR-installed treatment as the driver. An installed
  // watchdog whose bytes nobody checks is an unguarded guard — it is the only thing that will
  // notice the driver dying, so `doctor` reporting GREEN over a modified one is the worst shape of
  // false reassurance available in this install.
  const watchdogInstalled = fs.existsSync(watchdogFile);
  const watchdogDeclared = typeof manifest.hashes.watchdogSha256 === "string";
  if (watchdogDeclared !== watchdogInstalled) {
    throw new Error(watchdogDeclared ? "watchdog is gated but missing" : "watchdog is installed but ungated");
  }
  if (watchdogInstalled) {
    files.watchdog = watchdogFile;
    checkPrivateFile(watchdogFile, "watchdog");
  }
  for (const [label, expected] of [
    ["controller", manifest.hashes.controllerSha256],
    ["wakeCore", manifest.hashes.wakeCoreSha256],
    ["cli", manifest.hashes.cliSha256],
    ["authBindingModule", manifest.hashes.authBindingModuleSha256],
    ["config", manifest.hashes.configSha256],
    ["launcher", manifest.hashes.launcherSha256],
    ...(paneWakeInstalled ? [["paneWake", manifest.hashes.paneWakeSha256]] : []),
    ...(watchdogInstalled ? [["watchdog", manifest.hashes.watchdogSha256]] : []),
  ]) if (sha256(files[label]) !== expected) throw new Error(`${label} hash mismatch`);
  // Execute the parser only after its installed bytes pass the manifest hash gate. Importing first
  // would let a tampered parser run arbitrary code before doctor had a chance to reject it.
  const { compareAuthBinding } = await import(
    verifiedModuleDataUrl(authBindingFile, manifest.hashes.authBindingModuleSha256));
  const config = fs.readFileSync(files.config, "utf8");
  if (!config.includes("hooks = false") || config.includes("[hooks") || config.includes("LaunchAgent") || config.includes("KeepAlive")) throw new Error("dedicated config violates the no-hooks boundary");
  const token = fs.readFileSync(files.token, "utf8").trim();
  if (!token.startsWith("kjt_") || token.length < 20) throw new Error("token file is not a Kijito token");
  const eventExists = fs.existsSync(manifest.paths.eventsFile);
  if (eventExists) checkPrivateFile(manifest.paths.eventsFile, "monitor event stream");
  const ordinaryNow = {
    configSha256: optionalHash(manifest.paths.ordinaryConfig),
  };
  const dedicatedAuth = compareAuthBinding(files.auth, manifest.authBinding);
  const ordinaryAuth = compareAuthBinding(
    manifest.paths.ordinaryAuth, manifest.hashes.ordinaryAuthBindingAtInstall);
  const ordinaryBindingMatchesInstallSnapshot = ordinaryNow.configSha256 === manifest.hashes.ordinaryConfigBeforeSha256
    && ordinaryAuth.status === "PASS";
  const status = lockStatus(manifest);
  const paneWake = await paneWakeLiveness(manifest);
  const runtimeReadiness = inspectRuntimeReadiness(manifest, status);
  // Only the dedicated install is a required health input. The user's ordinary Codex auth is
  // intentionally outside this runtime: logout, removal, or a mode change remains visible as an
  // advisory and in ordinaryBindingMatchesInstallSnapshot (plus its compatibility alias), but cannot make the dedicated wake path
  // RED/BLOCKED.
  const authStatus = rollupRequiredStatuses([dedicatedAuth]);
  const doctorStatus = authStatus !== "PASS"
    ? authStatus
    : (status.state === "running"
      ? (runtimeReadiness.status === "PASS" ? "GREEN"
        : (runtimeReadiness.status === "BLOCKED" ? "BLOCKED" : "RED"))
      : (status.state === "stopped" ? "INACTIVE"
        : (status.state === "unverifiable-lock" ? "BLOCKED" : "RED")));
  return {
    status: doctorStatus,
    product: manifest.product,
    version: manifest.version,
    origin: manifest.origin,
    controllerSha256: manifest.hashes.controllerSha256,
    wakeCoreSha256: manifest.hashes.wakeCoreSha256,
    hooksDisabled: true,
    launchAgentInstalled: false,
    workspaceEmpty: true,
    eventStreamReady: runtimeReadiness.status === "PASS",
    ordinaryBindingMatchesInstallSnapshot,
    // Backward-compatible alias retained for existing operators; this proves config + stable auth
    // binding identity, not byte identity of rotating token state.
    ordinaryStateMatchesInstallSnapshot: ordinaryBindingMatchesInstallSnapshot,
    paneWakeSha256: manifest.hashes.paneWakeSha256 ?? null,
    paneWakeGated: paneWakeInstalled,
    watchdogGated: watchdogInstalled,
    watchdogSha256: manifest.hashes.watchdogSha256 ?? null,
    auth: { dedicated: dedicatedAuth, ordinary: ordinaryAuth },
    ordinaryAdvisory: ordinaryAuth.status === "PASS"
      ? null
      : { status: ordinaryAuth.status, code: ordinaryAuth.code },
    consumer: status,
    controller: status,
    paneWake,
    runtimeReadiness,
  };
}

function controllerArgs(manifest) {
  return [
    controllerFile,
    "--codex-home", manifest.paths.codexHome,
    "--workspace", manifest.paths.workspace,
    "--runtime", manifest.paths.runtime,
    "--events", manifest.paths.eventsFile,
    "--token-file", manifest.paths.tokenFile,
    "--codex", manifest.paths.codexBin,
    "--poll-ms", "500",
  ];
}

function safeEnv() {
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}

export function controllerStartObservation(current) {
  if (current.state === "stopped") return null;
  if (current.state === "running") return current;
  throw new Error(`controller entered ${current.state}`);
}

async function start(manifest) {
  const before = lockStatus(manifest);
  if (before.state !== "stopped") {
    throw new Error(`controller cannot start from state ${before.state}${before.holder ? ` (lock held by ${before.holder}, pid ${before.pid})` : ""}`);
  }
  checkRealPrivateDirectory(manifest.paths.runtime, "runtime directory");
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error("O_NOFOLLOW is required for controller logging");
  const logFile = path.join(manifest.paths.runtime, "controller.ndjson");
  const fd = fs.openSync(logFile,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600);
  const logStat = fs.fstatSync(fd);
  if (!logStat.isFile() || logStat.nlink !== 1 || logStat.uid !== process.getuid()
    || (logStat.mode & 0o077) !== 0) {
    fs.closeSync(fd);
    throw new Error("controller log is not one private user-owned regular file");
  }
  fs.fchmodSync(fd, 0o600);
  const logOffset = logStat.size;
  let child;
  try {
    child = spawn(process.execPath, controllerArgs(manifest), {
      cwd: manifest.paths.workspace,
      detached: true,
      env: safeEnv(),
      stdio: ["ignore", fd, fd],
    });
    child.unref();
  } finally { fs.closeSync(fd); }
  const running = await waitFor(() => {
    const current = lockStatus(manifest);
    if (current.state === "running" && current.holder !== "controller") {
      throw new Error(`refusing to adopt ${current.holder ?? "unknown"} (pid ${current.pid}) as controller start evidence`);
    }
    return controllerStartObservation(current);
  }, 10_000, "controller ownership");
  return { status: "STARTED", ...running, logFile, logOffset };
}

async function stop(manifest) {
  const current = lockStatus(manifest);
  if (current.state === "stopped") return { status: "ALREADY_STOPPED" };
  if (current.state !== "running") throw new Error(`refusing to signal controller in state ${current.state}`);
  // The lock is shared, so "running" is not enough — signalling the pane driver from a controller
  // command would stop the wrong consumer.
  if (current.holder !== "controller") throw new Error(`refusing to signal ${current.holder ?? "unknown"} (pid ${current.pid}); stop it with its own supervisor`);
  const confirmed = lockStatus(manifest);
  if (confirmed.state !== "running" || confirmed.pid !== current.pid || confirmed.holder !== "controller") {
    throw new Error("refusing to signal controller after ownership changed during confirmation");
  }
  process.kill(confirmed.pid, "SIGTERM");
  await waitFor(() => lockStatus(manifest).state === "stopped", 30_000, "controller shutdown");
  return { status: "STOPPED", pid: current.pid };
}

export async function waitArmed(manifest, timeoutMs = 180_000, logOffset = 0) {
  const logFile = path.join(manifest.paths.runtime, "controller.ndjson");
  return waitFor(() => {
    let bytes;
    try { bytes = fs.readFileSync(logFile); } catch { return null; }
    if (bytes.length < logOffset) throw new Error("controller log truncated after start");
    const text = bytes.subarray(logOffset).toString("utf8");
    const rows = text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const armed = rows.findLast((row) => row.event === "armed");
    const ambiguous = rows.findLast((row) => row.event === "ambiguous");
    if (ambiguous && (!armed || ambiguous.ts > armed.ts)) throw new Error(`startup became ambiguous: ${ambiguous.reason}`);
    return armed ?? null;
  }, timeoutMs, "controller armed state");
}

async function uninstall(manifest, confirmed) {
  if (!confirmed) throw new Error("uninstall requires --confirm-dedicated-home");
  await stop(manifest);
  if (sha256(manifest.paths.launcher) !== manifest.hashes.launcherSha256) throw new Error("refusing to remove modified launcher");
  const root = path.resolve(manifest.paths.installRoot);
  if (root !== installRoot || root === path.parse(root).root || path.basename(root) !== "codex-kijito-hive") throw new Error("refusing unsafe install root");
  fs.unlinkSync(manifest.paths.launcher);
  fs.rmSync(root, { recursive: true, force: false });
  return { status: "UNINSTALLED", removed: [root, manifest.paths.launcher], recoverable: false };
}

async function main() {
  const manifest = loadManifest();
  const [command = "status", ...rest] = process.argv.slice(2);
  let result;
  if (command === "doctor") result = await doctor(manifest);
  else if (command === "status") result = { status: lockStatus(manifest), paneWake: await paneWakeLiveness(manifest) };
  else if (command === "pane-supervise") {
    const flags = new Map();
    for (let index = 0; index < rest.length; index += 2) flags.set(rest[index], rest[index + 1]);
    result = await paneSupervise(manifest, {
      expectThread: flags.get("--expect-thread"),
      paneSession: flags.get("--pane-session"),
      tmux: flags.get("--tmux"),
      dryRun: rest.includes("--dry-run"),
    });
  }
  else if (command === "run") {
    const child = spawn(process.execPath, controllerArgs(manifest), { cwd: manifest.paths.workspace, env: safeEnv(), stdio: "inherit" });
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    const [code, signal] = await new Promise((resolve) => child.once("exit", (c, s) => resolve([c, s])));
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
    return;
  } else if (command === "start") result = await start(manifest);
  else if (command === "stop") result = await stop(manifest);
  else if (command === "repair-stale-lock") result = repairStaleLock(manifest);
  else if (command === "smoke") {
    const started = await start(manifest);
    try { result = { status: "GREEN", started, armed: await waitArmed(manifest, 180_000, started.logOffset) }; }
    finally { await stop(manifest); }
  } else if (command === "wait-armed") result = { status: "ARMED", event: await waitArmed(manifest) };
  else if (command === "uninstall") result = await uninstall(manifest, rest.includes("--confirm-dedicated-home"));
  else throw new Error(`unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === "doctor" && ["RED", "BLOCKED"].includes(result.status)) process.exitCode = 1;
  if (command === "status" && !["running", "stopped"].includes(result.status.state)) process.exitCode = 1;
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMainEntry()) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
} else {
  // Explicit library-import branch. CLI execution through a symlink still reaches main because
  // isMainEntry compares filesystem identity; importing for doctor/test probes has no side effect.
}
