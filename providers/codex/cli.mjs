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
const paneWakeFile = path.join(installRoot, "codex", "pane-wake.mjs");
const watchdogFile = path.join(installRoot, "codex", "pane-wake-watchdog.mjs");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadManifest() {
  const stat = fs.lstatSync(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("installed manifest is not private and user-owned");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.schema !== 1 || manifest.product !== "codex-kijito-hive" || manifest.paths.installRoot !== installRoot) throw new Error("installed manifest identity mismatch");
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

// ⛔ ONE LOCK, TWO POSSIBLE HOLDERS. The controller and the same-session pane driver share this
// file by construction (that is what makes them mutually exclusive), so a status tool that only
// recognises the controller reports `pid-mismatch` — a hard error — for the perfectly correct state
// "the pane driver is armed". The holder is now named instead of assumed.
function lockStatus(manifest) {
  const lockFile = path.join(manifest.paths.runtime, "consumer.lock");
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { state: "stopped", lockFile }; throw error; }
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 1 || typeof lock.token !== "string" || lock.persona !== "codex") return { state: "invalid-lock", lockFile };
  let alive = true;
  try { process.kill(lock.pid, 0); } catch { alive = false; }
  if (!alive) return { state: "stale-lock", pid: lock.pid, lockFile };
  const command = processCommand(lock.pid);
  if (command.includes(controllerFile)) return { state: "running", holder: "controller", pid: lock.pid, command, lockFile };
  // The pane driver may legitimately run from the repo checkout as well as from the install root,
  // so it is recognised by module name rather than by absolute path.
  if (command.includes(paneWakeFile) || /pane-wake\.mjs(\s|$)/.test(command)) {
    return { state: "running", holder: "pane-wake", pid: lock.pid, command, lockFile };
  }
  return { state: "pid-mismatch", pid: lock.pid, command, lockFile };
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
    cli: path.join(installRoot, "cli.mjs"),
    config: path.join(manifest.paths.codexHome, "config.toml"),
    auth: path.join(manifest.paths.codexHome, "auth.json"),
    launcher: manifest.paths.launcher,
    token: manifest.paths.tokenFile,
  };
  for (const [label, file] of Object.entries(files)) checkPrivateFile(file, label);
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
    ["config", manifest.hashes.configSha256],
    ["auth", manifest.hashes.authSha256],
    ["launcher", manifest.hashes.launcherSha256],
    ...(paneWakeInstalled ? [["paneWake", manifest.hashes.paneWakeSha256]] : []),
    ...(watchdogInstalled ? [["watchdog", manifest.hashes.watchdogSha256]] : []),
  ]) if (sha256(files[label]) !== expected) throw new Error(`${label} hash mismatch`);
  const config = fs.readFileSync(files.config, "utf8");
  if (!config.includes("hooks = false") || config.includes("[hooks") || config.includes("LaunchAgent") || config.includes("KeepAlive")) throw new Error("dedicated config violates the no-hooks boundary");
  const token = fs.readFileSync(files.token, "utf8").trim();
  if (!token.startsWith("kjt_") || token.length < 20) throw new Error("token file is not a Kijito token");
  const eventExists = fs.existsSync(manifest.paths.eventsFile);
  if (eventExists) checkPrivateFile(manifest.paths.eventsFile, "monitor event stream");
  const ordinaryNow = {
    configSha256: optionalHash(manifest.paths.ordinaryConfig),
    authSha256: optionalHash(manifest.paths.ordinaryAuth),
  };
  const ordinaryStateMatchesInstallSnapshot = ordinaryNow.configSha256 === manifest.hashes.ordinaryConfigBeforeSha256
    && ordinaryNow.authSha256 === manifest.hashes.ordinaryAuthBeforeSha256;
  const status = lockStatus(manifest);
  const paneWake = await paneWakeLiveness(manifest);
  return {
    status: "GREEN",
    product: manifest.product,
    version: manifest.version,
    controllerSha256: manifest.hashes.controllerSha256,
    wakeCoreSha256: manifest.hashes.wakeCoreSha256,
    hooksDisabled: true,
    launchAgentInstalled: false,
    workspaceEmpty: true,
    eventStreamReady: eventExists,
    ordinaryStateMatchesInstallSnapshot,
    paneWakeSha256: manifest.hashes.paneWakeSha256 ?? null,
    paneWakeGated: paneWakeInstalled,
    watchdogGated: watchdogInstalled,
    watchdogSha256: manifest.hashes.watchdogSha256 ?? null,
    consumer: status,
    controller: status,
    paneWake,
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

async function start(manifest) {
  const before = lockStatus(manifest);
  if (before.state !== "stopped") {
    throw new Error(`controller cannot start from state ${before.state}${before.holder ? ` (lock held by ${before.holder}, pid ${before.pid})` : ""}`);
  }
  const logFile = path.join(manifest.paths.runtime, "controller.ndjson");
  const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const fd = fs.openSync(logFile, "a", 0o600);
  fs.chmodSync(logFile, 0o600);
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
    if (["invalid-lock", "stale-lock", "pid-mismatch"].includes(current.state)) throw new Error(`controller entered ${current.state}`);
    return current.state === "running" && current.holder === "controller" ? current : null;
  }, 10_000, "controller ownership");
  return { status: "STARTED", ...running, logFile, logOffset };
}

async function stop(manifest) {
  const current = lockStatus(manifest);
  if (current.state === "stopped") return { status: "ALREADY_STOPPED" };
  if (current.state !== "running") throw new Error(`refusing to signal controller in state ${current.state}`);
  // The lock is shared, so "running" is not enough — signalling the pane driver from a controller
  // command would stop the wrong consumer.
  if (current.holder !== "controller") throw new Error(`refusing to signal ${current.holder} (pid ${current.pid}); stop it with its own supervisor`);
  process.kill(current.pid, "SIGTERM");
  await waitFor(() => lockStatus(manifest).state === "stopped", 30_000, "controller shutdown");
  return { status: "STOPPED", pid: current.pid };
}

async function waitArmed(manifest, timeoutMs = 180_000, logOffset = 0) {
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
  else if (command === "smoke") {
    const started = await start(manifest);
    try { result = { status: "GREEN", started, armed: await waitArmed(manifest, 180_000, started.logOffset) }; }
    finally { await stop(manifest); }
  } else if (command === "wait-armed") result = { status: "ARMED", event: await waitArmed(manifest) };
  else if (command === "uninstall") result = await uninstall(manifest, rest.includes("--confirm-dedicated-home"));
  else throw new Error(`unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
