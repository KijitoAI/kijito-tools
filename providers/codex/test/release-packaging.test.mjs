import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../pane-wake.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const THREAD = "019fa4c1-8c09-7282-8756-887d29b854cb";
const installer = path.join(packageRoot, "install.mjs");

// One cold-start flake was observed in this suite (unreproduced in eight runs). Every child now
// carries a generous timeout: the point of the bound is to make a HANG fail with an attributable
// assertion instead of running to the job timeout, so margin is free and the signal is what matters.
const SUBPROCESS_TIMEOUT_MS = 120_000;

function run(args, expected = 0) {
  const direct = !args[0].endsWith(".mjs");
  const options = { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS };
  const result = direct
    ? spawnSync(args[0], args.slice(1), options)
    : spawnSync(process.execPath, args, options);
  assert.equal(result.signal, null, `child killed by ${result.signal} after ${SUBPROCESS_TIMEOUT_MS} ms: ${args.join(" ")}`);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-kijito-package."));
  fs.chmodSync(root, 0o700);
  const ordinary = path.join(root, "ordinary");
  const monitor = path.join(root, "monitor");
  fs.mkdirSync(ordinary, { mode: 0o700 });
  fs.mkdirSync(monitor, { mode: 0o700 });
  const auth = path.join(ordinary, "auth.json");
  const config = path.join(ordinary, "config.toml");
  const token = path.join(root, "token");
  const events = path.join(monitor, "events.codex.ndjson");
  fs.writeFileSync(auth, '{"auth":"fixture"}\n', { mode: 0o600 });
  fs.writeFileSync(config, 'model = "fixture"\n', { mode: 0o600 });
  fs.writeFileSync(token, `kjt_${"x".repeat(32)}\n`, { mode: 0o600 });
  fs.writeFileSync(events, "", { mode: 0o600 });
  const realBin = path.join(root, "codex-real");
  const bin = path.join(root, "codex");
  fs.copyFileSync(process.execPath, realBin);
  fs.chmodSync(realBin, 0o700);
  fs.symlinkSync(realBin, bin);
  return {
    root,
    installRoot: path.join(root, "share", "codex-kijito-hive"),
    launcher: path.join(root, "bin", "codex-kijito-hive"),
    // Hermetic skills target. Without this the installer's default (~/.codex/skills) would make
    // the test suite deploy into the developer's real Codex install.
    skillsRoot: path.join(root, "codex-skills"),
    auth, config, token, events, bin,
  };
}

function installArgs(f) {
  return [installer,
    "--source-root", packageRoot,
    "--install-root", f.installRoot,
    "--launcher", f.launcher,
    "--auth-source", f.auth,
    "--ordinary-config", f.config,
    "--token-file", f.token,
    "--events-file", f.events,
    "--codex-bin", f.bin,
    "--node-bin", process.execPath,
    "--skills-root", f.skillsRoot,
  ];
}

test("release install, doctor, duplicate refusal, and manifest-bound uninstall", () => {
  const f = fixture();
  try {
    const ordinaryBefore = fs.readFileSync(f.config, "utf8");
    const authBefore = fs.readFileSync(f.auth, "utf8");
    const installed = JSON.parse(run(installArgs(f)).stdout);
    assert.equal(installed.status, "INSTALLED");
    assert.equal(installed.ordinaryStateUnchanged, true);
    // A full install also deploys the skills, into the fixture's own root -- never the real one.
    assert.deepEqual(installed.skills.map((s) => s.skill).sort(), ["kijito-qa-memory", "kijito-start"]);
    assert.ok(installed.skills.every((s) => s.target.startsWith(f.skillsRoot)));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.installRoot, "installed-manifest.json"), "utf8"));
    assert.equal(manifest.paths.codexBin, fs.realpathSync(f.bin));
    // ⛔ THE LIVE DELIVERY PATH IS INSTALLED AND HASHED. The release manifest advertised
    // `installedLayout.paneWake` while the installer copied only the controller, so the file that
    // types into the operator's real Codex session was gated in the REPO and ungated ON THE MACHINE
    // — and `doctor` reported GREEN over modified bytes.
    const release = JSON.parse(fs.readFileSync(path.join(packageRoot, "release-manifest.json"), "utf8"));
    const installedPaneWake = path.join(f.installRoot, release.production.installedLayout.paneWake);
    assert.equal(fs.existsSync(installedPaneWake), true, "installedLayout.paneWake must name a file the installer produces");
    assert.equal(createHash("sha256").update(fs.readFileSync(installedPaneWake)).digest("hex"), release.artifacts.paneWakeSha256);
    assert.equal(manifest.hashes.paneWakeSha256, release.artifacts.paneWakeSha256);
    assert.equal(manifest.hashes.paneWakeTestsSha256, release.artifacts.paneWakeTestsSha256);
    // M223: the detector is installed beside the driver (so its import resolves) and hash-recorded.
    const installedWatchdog = path.join(manifest.paths.installRoot, release.production.installedLayout.watchdog);
    const installedPlist = path.join(manifest.paths.installRoot, release.production.installedLayout.watchdogPlistTemplate);
    for (const [file, key] of [[installedWatchdog, "watchdogSha256"], [installedPlist, "watchdogPlistSha256"]]) {
      assert.equal(fs.existsSync(file), true, key);
      assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), release.artifacts[key], key);
      assert.equal(manifest.hashes[key], release.artifacts[key], key);
    }
    // The installer realpath-resolves its root, so the recorded paths are compared against the
    // manifest's own resolved value rather than the fixture's unresolved one.
    assert.equal(manifest.paths.paneHeartbeat, path.join(manifest.paths.installRoot, "runtime-pane", "heartbeat.json"));
    assert.equal(manifest.paths.watchdog, installedWatchdog);
    const doctor = JSON.parse(run([f.launcher, "doctor"]).stdout);
    assert.equal(doctor.status, "GREEN");
    assert.equal(doctor.hooksDisabled, true);
    assert.equal(doctor.launchAgentInstalled, false);
    assert.equal(doctor.workspaceEmpty, true);
    assert.equal(doctor.paneWakeGated, true);
    assert.equal(doctor.watchdogGated, true, "the detector is covered by the install integrity table");
    assert.equal(doctor.paneWake.status, "absent", "no pane driver armed against a fresh install");
    assert.equal(doctor.ordinaryStateMatchesInstallSnapshot, true);
    run(installArgs(f), 1);
    assert.equal(fs.readFileSync(f.config, "utf8"), ordinaryBefore);
    assert.equal(fs.readFileSync(f.auth, "utf8"), authBefore);
    run([f.launcher, "uninstall"], 1);
    const removed = JSON.parse(run([f.launcher, "uninstall", "--confirm-dedicated-home"]).stdout);
    assert.equal(removed.status, "UNINSTALLED");
    assert.equal(fs.existsSync(f.installRoot), false);
    assert.equal(fs.existsSync(f.launcher), false);
    assert.equal(fs.readFileSync(f.config, "utf8"), ordinaryBefore);
    assert.equal(fs.readFileSync(f.auth, "utf8"), authBefore);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("skills deploy with their agents sidecar, idempotently, without an install root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-kijito-skills."));
  fs.chmodSync(root, 0o700);
  try {
    const skillsRoot = path.join(root, "skills");
    const first = JSON.parse(run([installer, "--skills-only", "--skills-root", skillsRoot]).stdout);
    assert.equal(first.status, "SKILLS_INSTALLED");
    assert.deepEqual(first.skills.map((s) => s.skill).sort(), ["kijito-qa-memory", "kijito-start"]);
    for (const s of first.skills) {
      assert.ok(fs.existsSync(path.join(s.target, "SKILL.md")), `${s.skill} SKILL.md`);
      // The sidecar carries the Codex-surface interface metadata; a skill without it loses its
      // display name and default prompt, so it must travel with the skill.
      assert.ok(fs.existsSync(path.join(s.target, "agents", "openai.yaml")), `${s.skill} sidecar`);
    }
    // Skills are versioned prose meant to be UPDATED in place, unlike the install root, which
    // refuses to overwrite. A second run must succeed rather than throw.
    fs.appendFileSync(path.join(skillsRoot, "kijito-start", "SKILL.md"), "\nlocal edit\n");
    const second = JSON.parse(run([installer, "--skills-only", "--skills-root", skillsRoot]).stdout);
    assert.equal(second.skills.length, 2);
    const repoSkill = fs.readFileSync(path.join(packageRoot, "skills", "kijito-start", "SKILL.md"), "utf8");
    assert.equal(fs.readFileSync(path.join(skillsRoot, "kijito-start", "SKILL.md"), "utf8"), repoSkill);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("doctor and uninstall fail closed on installed-byte tampering", () => {
  const f = fixture();
  try {
    run(installArgs(f));
    // Every executable file the install places must fail doctor closed when edited. The controller
    // and the shared wake core are BOTH checked: the wake core holds parseEventLine (the event
    // validator) and fixedWakeText (the prompt-injection fence), so an ungated copy of it would be
    // the most valuable thing in the install to tamper with.
    for (const target of [path.join(f.installRoot, "codex", "controller.mjs"),
                          path.join(f.installRoot, "_shared", "wake-core.mjs"),
                          path.join(f.installRoot, "codex", "pane-wake.mjs"),
                          path.join(f.installRoot, "codex", "pane-wake-watchdog.mjs"),
                          // ⛔ AND THE CLI, which IS `doctor`/`status`/`lockStatus`/liveness — the
                          // only external observer of everything else. It was outside this loop for
                          // the same reason it was outside the gate.
                          path.join(f.installRoot, "cli.mjs")]) {
      const bytes = fs.readFileSync(target);
      fs.appendFileSync(target, "\n// tamper\n");
      run([f.launcher, "doctor"], 1);
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      run([f.launcher, "doctor"]);
    }
    const launcherBytes = fs.readFileSync(f.launcher);
    fs.appendFileSync(f.launcher, "\n# tamper\n");
    run([f.launcher, "uninstall", "--confirm-dedicated-home"], 1);
    fs.writeFileSync(f.launcher, launcherBytes, { mode: 0o700 });
    run([f.launcher, "uninstall", "--confirm-dedicated-home"]);
    assert.equal(fs.existsSync(f.installRoot), false);
    assert.equal(fs.existsSync(f.launcher), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// ⛔ DEFERRED WITH A REASON, rather than silently left: this test pins cli.mjs SOURCE TEXT via
// regex, so a semantically identical rewrite fails it and a behaviourally broken but textually
// identical rewrite passes it. Converting it to behaviour means running a controller start/stop
// cycle against a live app-server, which is what the live gate does and what a unit suite cannot.
// It is kept because the property it guards is real, and it is now backed by something stronger:
// cli.mjs is hash-gated at the source as of this round, so its bytes cannot drift unnoticed.
test("smoke command fences armed evidence to bytes written after its own start", () => {
  const cli = fs.readFileSync(path.join(packageRoot, "cli.mjs"), "utf8");
  assert.match(cli, /const logOffset = fs\.existsSync\(logFile\) \? fs\.statSync\(logFile\)\.size : 0/);
  assert.match(cli, /waitArmed\(manifest, 180_000, started\.logOffset\)/);
  assert.match(cli, /bytes\.subarray\(logOffset\)/);
});

test("the health-reporting binary is gated at the SOURCE, not against a hash derived from itself", () => {
  // ⛔ THE SELF-REFERENTIAL CHAIN. `cli.mjs` was copied unverified and its installed hash was then
  // computed FROM THE COPY, so `doctor` checked the installed bytes against a hash derived from
  // whatever bytes the installer was handed: a modified SOURCE installed cleanly and reported GREEN
  // for ever — from the one file whose job is to tell you everything else is fine.
  const release = JSON.parse(fs.readFileSync(path.join(packageRoot, "release-manifest.json"), "utf8"));
  const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  for (const [key, file] of [
    ["cliSha256", path.join(packageRoot, "cli.mjs")],
    ["watchdogSha256", path.join(packageRoot, "pane-wake-watchdog.mjs")],
    ["watchdogTestsSha256", path.join(packageRoot, "test", "pane-wake-watchdog.test.mjs")],
    ["watchdogPlistSha256", path.join(packageRoot, "com.kijito.pane-wake-watchdog.plist")],
    ["postSubmitCaptureSha256", path.join(packageRoot, "test", "fixtures", "post-submit-capture-e.txt")],
    ["postSubmitCapturePlainSha256", path.join(packageRoot, "test", "fixtures", "post-submit-capture-plain.txt")],
    ["workflowSha256", path.join(packageRoot, "..", "..", ".github", "workflows", "test.yml")],
    ["paneWakeSha256", path.join(packageRoot, "pane-wake.mjs")],
    ["paneWakeTestsSha256", path.join(packageRoot, "test", "pane-wake.test.mjs")],
    ["controllerSha256", path.join(packageRoot, "controller.mjs")],
  ]) {
    assert.equal(release.artifacts[key], sha(file), key);
  }
  // Every gated SOURCE file must be refused when it differs from its pinned hash — the fixture file
  // included, which carries the safety argument for the classifier.
  for (const relative of [
    "cli.mjs",
    "pane-wake.mjs",
    path.join("test", "pane-wake.test.mjs"),
    // The captured post-submit frame: it is the evidence the read-state-advancing gate is validated
    // against, so an edited capture is an edited safety argument.
    "pane-wake-watchdog.mjs",
    "com.kijito.pane-wake-watchdog.plist",
    path.join("test", "pane-wake-watchdog.test.mjs"),
    path.join("test", "fixtures", "post-submit-capture-e.txt"),
    path.join("test", "fixtures", "post-submit-capture-plain.txt"),
  ]) {
    const staged = fs.mkdtempSync(path.join(os.tmpdir(), "codex-kijito-source."));
    try {
      fs.cpSync(path.dirname(packageRoot), path.join(staged, "providers"), { recursive: true });
      const target = path.join(staged, "providers", "codex", relative);
      fs.appendFileSync(target, "\n// tamper\n");
      const f = fixture();
      try {
        const args = installArgs(f);
        args[args.indexOf("--source-root") + 1] = path.join(staged, "providers", "codex");
        const result = run(args, 1);
        assert.match(result.stderr, /differs? from gated hash/, relative);
        assert.equal(fs.existsSync(f.installRoot), false, `${relative}: nothing may be installed`);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    } finally { fs.rmSync(staged, { recursive: true, force: true }); }
  }
});

test("doctor fails closed when the pane driver is installed-but-ungated or gated-but-missing", () => {
  const f = fixture();
  try {
    run(installArgs(f));
    const manifestFile = path.join(f.installRoot, "installed-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    // gated but missing
    const installedDriver = path.join(f.installRoot, "codex", "pane-wake.mjs");
    const bytes = fs.readFileSync(installedDriver);
    fs.rmSync(installedDriver);
    run([f.launcher, "doctor"], 1);
    fs.writeFileSync(installedDriver, bytes, { mode: 0o600 });
    run([f.launcher, "doctor"]);
    // installed but ungated — the arm that has no fixture until now
    const without = { ...manifest, hashes: { ...manifest.hashes } };
    delete without.hashes.paneWakeSha256;
    fs.writeFileSync(manifestFile, `${JSON.stringify(without, null, 2)}\n`, { mode: 0o600 });
    run([f.launcher, "doctor"], 1);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    run([f.launcher, "doctor"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("status names the pane driver as a lock holder, and the supervisor decides from liveness", () => {
  const f = fixture();
  const sleeper = path.join(f.root, "pane-wake.mjs");
  let child;
  try {
    run(installArgs(f));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.installRoot, "installed-manifest.json"), "utf8"));
    // ⛔ THE SHARED LOCK, FROM THE INSTALL'S OWN MANIFEST. The driver derives its default lock from
    // exactly this path, so "one derivation" is a fact about one file rather than two rules that
    // agree today.
    const lockFile = path.join(manifest.paths.runtime, "consumer.lock");
    const driverDefaults = parseArgs(["--expect-thread", THREAD, "--install-root", f.installRoot]);
    assert.equal(driverDefaults.lockFile, lockFile);
    assert.equal(driverDefaults.heartbeatFile, path.join(manifest.paths.runtime, "pane-wake.heartbeat"));

    // A REAL process whose command names the pane driver takes the shared lock. Before this, the
    // status tool reported that as `pid-mismatch` — a hard error for a perfectly correct state.
    fs.writeFileSync(sleeper, "setTimeout(() => {}, 60000);\n", { mode: 0o700 });
    child = spawn(process.execPath, [sleeper], { stdio: "ignore" });
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: child.pid, token: "t".repeat(32), persona: "codex" })}\n`, { mode: 0o600 });
    const status = JSON.parse(run([f.launcher, "status"]).stdout);
    assert.equal(status.status.state, "running");
    assert.equal(status.status.holder, "pane-wake");
    assert.equal(status.paneWake.status, "absent", "no heartbeat yet");
    // The controller must refuse to start or signal across the shared lock, naming the holder.
    assert.match(run([f.launcher, "start"], 1).stderr, /lock held by pane-wake/);
    assert.match(run([f.launcher, "stop"], 1).stderr, /refusing to signal pane-wake/);

    // The supervisor: an entry point that decides from the SAME liveness signal and refuses rather
    // than guessing. "Nothing restarts a dead pane driver" had no owner before this.
    const supervise = JSON.parse(run([f.launcher, "pane-supervise", "--expect-thread", THREAD, "--dry-run"]).stdout);
    assert.equal(supervise.status, "REFUSED");
    assert.match(supervise.reason, /held by a running pane-wake/);
    child.kill("SIGKILL");
    child = null;
    fs.rmSync(lockFile);
    const wouldStart = JSON.parse(run([f.launcher, "pane-supervise", "--expect-thread", THREAD, "--dry-run"]).stdout);
    assert.equal(wouldStart.status, "WOULD_START");
    assert.ok(wouldStart.command.includes("--expect-thread"));
    // ⛔ EVERY FUTURE ARM IS WATCHABLE BY CONSTRUCTION. `--heartbeat` is part of the standard launch
    // argv rather than something an operator must remember, and it points at the one canonical path
    // the status tool and the watchdog also use.
    const heartbeatIndex = wouldStart.command.indexOf("--heartbeat");
    assert.notEqual(heartbeatIndex, -1, "the launch argv must carry --heartbeat");
    assert.equal(wouldStart.command[heartbeatIndex + 1], path.join(manifest.paths.installRoot, "runtime-pane", "heartbeat.json"));
    assert.ok(wouldStart.command.some((part) => part.endsWith("codex/pane-wake.mjs")));
    assert.ok(wouldStart.command.includes(manifest.paths.eventsFile));
    // Without a thread identity there is nothing safe to start.
    const noThread = JSON.parse(run([f.launcher, "pane-supervise", "--dry-run"]).stdout);
    assert.equal(noThread.status, "REFUSED");
    assert.match(noThread.reason, /no --expect-thread/);
  } finally {
    if (child) child.kill("SIGKILL");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
