#!/usr/bin/env node
// Recompute the gated hashes in providers/codex/release-manifest.json from the files on disk.
//
// WHY THIS IS A SCRIPT AND NOT A HAND EDIT. release-manifest.json records the sha256 of every
// executable file the installer will place, and install.mjs refuses to install when a hash
// disagrees. That gate is the point — but it means ANY edit to the controller, the shared wake
// core, or the controller tests leaves the manifest stale, and the symptom is an install-time
// error that reads like corruption rather than "you forgot to refresh". Regenerating by hand also
// invites the failure mode where you refresh, then make one more edit, and ship the stale hash.
//
//   node providers/codex/tools/refresh-manifest.mjs          # rewrite the manifest
//   node providers/codex/tools/refresh-manifest.mjs --check   # verify only; non-zero if stale
//
// --check is what the conformance test runs, so a stale manifest fails the suite instead of
// surfacing later as a mysterious install failure.
//
// The plan hash is deliberately NOT recomputed: it is RECORDED provenance, not a gate (the fold
// demoted it), and silently re-stamping it would erase the record of which plan revision the
// release was actually reviewed against.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const providerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestFile = path.join(providerRoot, "release-manifest.json");

const GATED = {
  controllerSha256: path.join(providerRoot, "controller.mjs"),
  cliSha256: path.join(providerRoot, "cli.mjs"),
  authBindingSha256: path.join(providerRoot, "auth-binding.mjs"),
  wakeCoreSha256: path.join(providerRoot, "..", "_shared", "wake-core.mjs"),
  controllerTestsSha256: path.join(providerRoot, "test", "codex-hive-watch.test.mjs"),
  wakeRecoveryTestsSha256: path.join(providerRoot, "test", "wake-recovery-v2.test.mjs"),
  releasePackagingTestsSha256: path.join(providerRoot, "test", "release-packaging.test.mjs"),
  recoveryRunbookSha256: path.join(providerRoot, "WAKE-RECOVERY-RUNBOOK.md"),
  // The same-session pane wake adapter. It was the LIVE delivery path while the manifest pinned
  // only the controller — i.e. the file that talks to the operator's real session was the one file
  // no integrity gate covered.
  paneWakeSha256: path.join(providerRoot, "pane-wake.mjs"),
  // The pane-wake fixtures ARE the safety argument for the idle/busy classifier — they pin a
  // third-party TUI contract nobody else records. An ungated fixture file is an editable safety
  // argument, so it is gated exactly like the controller tests beside it.
  paneWakeTestsSha256: path.join(providerRoot, "test", "pane-wake.test.mjs"),
  // The health-reporting surface. Gating everything it reports on while leaving it ungated made the
  // integrity story self-referential.
  cliSha256: path.join(providerRoot, "cli.mjs"),
  // A REAL captured post-submit frame, taken the way the driver itself captures (`capture-pane -e`,
  // escapes intact). It is the fixture the sole read-state-advancing gate is validated against, so
  // it is evidence, not scenery: ungated, a future edit could quietly make the gate pass against a
  // frame the TUI never produces.
  postSubmitCaptureSha256: path.join(providerRoot, "test", "fixtures", "post-submit-capture-e.txt"),
  // The same flow captured WITHOUT -e. Retained because the difference between the two is itself a
  // property: with no intensity attribute the gate must fail CLOSED rather than confirm.
  postSubmitCapturePlainSha256: path.join(providerRoot, "test", "fixtures", "post-submit-capture-plain.txt"),
  // M227: a REAL idle-pane capture whose transcript carries full-width rules and framed tool-output.
  // It is the positive control that the classifier no longer mis-reads transcript as chrome and
  // livelocks wake delivery; ungated, a future edit could make the classifier "pass" against a frame
  // the TUI never produces.
  idleTranscriptRulesCaptureSha256: path.join(providerRoot, "test", "fixtures", "idle-with-transcript-rules-M227.txt"),
  // M223: the liveness DETECTOR, its fixtures and its launchd template. The watchdog is the only
  // thing that will notice the wake driver dying, so an ungated watchdog is an unguarded guard —
  // and the plist is gated too, because a supervisor definition is executable intent.
  watchdogSha256: path.join(providerRoot, "pane-wake-watchdog.mjs"),
  watchdogTestsSha256: path.join(providerRoot, "test", "pane-wake-watchdog.test.mjs"),
  watchdogPlistSha256: path.join(providerRoot, "com.kijito.pane-wake-watchdog.plist"),
  // The CI workflow is the thing that RUNS all of the above. It was a modified companion of every
  // recent round and declared nowhere, so a change to what CI executes left no trace in the
  // manifest that records what the release is.
  workflowSha256: path.join(providerRoot, "..", "..", ".github", "workflows", "test.yml"),
};

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const drift = [];
for (const [key, file] of Object.entries(GATED)) {
  const actual = sha256(file);
  if (manifest.artifacts[key] !== actual) {
    drift.push({ key, file: path.relative(providerRoot, file), was: manifest.artifacts[key], now: actual });
    manifest.artifacts[key] = actual;
  }
}

if (process.argv.includes("--check")) {
  if (drift.length === 0) {
    process.stdout.write("release-manifest.json: all gated hashes current\n");
  } else {
    for (const d of drift) process.stderr.write(`STALE ${d.key} (${d.file})\n  manifest: ${d.was}\n  on disk:  ${d.now}\n`);
    process.stderr.write("Run: node providers/codex/tools/refresh-manifest.mjs\n");
    process.exitCode = 1;
  }
} else if (drift.length === 0) {
  process.stdout.write("release-manifest.json: already current, nothing written\n");
} else {
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const d of drift) process.stdout.write(`refreshed ${d.key} (${d.file}) -> ${d.now}\n`);
}
