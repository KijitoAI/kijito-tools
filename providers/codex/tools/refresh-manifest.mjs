#!/usr/bin/env node
// Recompute the gated hashes in providers/codex/release-manifest.json from the files on disk.
//
// WHY THIS IS A SCRIPT AND NOT A HAND EDIT. release-manifest.json records the sha256 of every
// live executable artifact, and install.mjs (the verify path) refuses to pass when a hash
// disagrees. That gate is the point — but it means ANY edit to a gated file leaves the manifest
// stale, and the symptom is a verify-time error that reads like corruption rather than "you
// forgot to refresh". Regenerating by hand also invites the failure mode where you refresh, then
// make one more edit, and ship the stale hash.
//
//   node providers/codex/tools/refresh-manifest.mjs          # rewrite the manifest
//   node providers/codex/tools/refresh-manifest.mjs --check   # verify only; non-zero if stale
//
// --check is what the conformance test runs, so a stale manifest fails the suite instead of
// surfacing later as a mysterious verify failure.
//
// GATE-6 (2026-08-15): the controller-era entries were retired to the manifest's
// `legacyArtifacts` block (files under legacy/codex-controller-era-2026-08/); this map now covers
// only the LIVE set, and it deliberately does NOT touch legacyArtifacts — those hashes are frozen
// provenance of what was retired, and re-stamping them would erase the record.
//
// The plan hash is likewise NOT recomputed: it is RECORDED provenance, not a gate (the fold
// demoted it), and silently re-stamping it would erase the record of which plan revision the
// release was actually reviewed against.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const providerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestFile = path.join(providerRoot, "release-manifest.json");

const GATED = {
  // The shared wake core: executable code the wake helper imports at runtime (parseEventLine and
  // fixedWakeText — the event validator and the injection fence). Gated since the fold; stays
  // gated because splitting a gated import chain into gated + ungated halves would leave the
  // fence editable while verify still reports GREEN.
  wakeCoreSha256: path.join(providerRoot, "..", "_shared", "wake-core.mjs"),
  // The CI workflow is the thing that RUNS all of the above. It was a modified companion of every
  // recent round and declared nowhere, so a change to what CI executes left no trace in the
  // manifest that records what the release is.
  workflowSha256: path.join(providerRoot, "..", "..", ".github", "workflows", "test.yml"),
  // Gate-5 native live wake (argus's PR#19 gating ruling, stated as a property: every executable
  // artifact a skill/install path causes a user session to run belongs in the manifest).
  // kijito-start's arm step names the helper, so the helper and its runtime import are gated;
  // the tests + mock join per the gated-tests precedent (they are the helper's safety argument).
  // status-probe.mjs and TRANSPORT-NOTES.md stay ungated: instrument + doc, not on the user path.
  wakeHelperSha256: path.join(providerRoot, "wake-helper", "kijito-wake-helper.mjs"),
  wsUdsSha256: path.join(providerRoot, "wake-helper", "ws-uds.mjs"),
  wakeHelperTestsSha256: path.join(providerRoot, "wake-helper", "kijito-wake-helper.test.mjs"),
  wakeHelperIntegrationTestsSha256: path.join(providerRoot, "wake-helper", "integration.test.mjs"),
  wakeHelperMockDaemonSha256: path.join(providerRoot, "wake-helper", "mock-daemon.mjs"),
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
