#!/usr/bin/env node
// Codex provider installer — post-gate-6 (2026-08-15) shape.
//
// The controller-era full install (headless app-server seat: controller, cli, pane-wake driver,
// mode-aware watchdog) was RETIRED at gate 6 of the hive-user-first plan §7 teardown protocol.
// Its installer is archived at legacy/codex-controller-era-2026-08/install-controller-era.mjs and
// its machinery teardown evidence lives on the operator seat at
// ~/.local/share/codex-kijito-hive/legacy/gate6-20260815T0643Z/. Nothing here installs a runtime,
// copies credentials, or touches ordinary Codex state.
//
// What remains is exactly the live surface:
//
//   verify         (default) the release gate. Every artifact release-manifest.json gates must
//                  exist with matching bytes, and every executable on the live user path must be
//                  gated. Both failure directions are LOUD: a gated-but-absent file and an
//                  ungated-but-shipped executable each fail the run with a named cause — a
//                  manifest gating absent files is a gate over nothing, and an ungated executable
//                  is code a user session runs with no integrity story (the gate-5 gating ruling,
//                  stated as a property).
//   --skills-only  deploy the provider's skills to ~/.codex/skills (idempotent, update-in-place —
//                  versioned prose, meant to be overwritten). Runs verify FIRST, so a checkout
//                  that fails its release gate never deploys skills from those bytes.
//
// The wake-helper itself is NOT installed anywhere: kijito-start's arm step runs it from the
// checkout, which is why its bytes (and its runtime import, the shared wake core) are gated here.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set(["skills-only", "verify"]);
  const bare = new Set();
  argv = argv.filter((token) => {
    const isFlag = token.startsWith("--") && flags.has(token.slice(2));
    if (isFlag) bare.add(token.slice(2));
    return !isFlag;
  });
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) {
      // The controller-era installer took a dozen paired options (--install-root, --launcher,
      // --auth-source, …). Naming the retirement beats a bare "invalid argument" for anyone
      // holding an old command line.
      throw new Error(`invalid or retired argument ${key ?? ""} — the controller-era full install was retired at gate 6 (2026-08-15); see legacy/codex-controller-era-2026-08/`);
    }
    if (!["skills-root", "source-root"].includes(key.slice(2))) {
      throw new Error(`invalid or retired argument ${key} — the controller-era full install was retired at gate 6 (2026-08-15); see legacy/codex-controller-era-2026-08/`);
    }
    values[key.slice(2)] = argv[index + 1];
  }
  const home = os.homedir();
  const expand = (value) => path.resolve(value.replace(/^~(?=\/|$)/, home));
  return {
    sourceRoot: expand(values["source-root"] ?? here),
    skillsRoot: expand(values["skills-root"] ?? path.join(home, ".codex", "skills")),
    skillsOnly: bare.has("skills-only"),
    verifyOnly: bare.has("verify"),
  };
}

// The live gated set. Keys are the manifest's artifact names; paths are relative to the provider
// root. This map, refresh-manifest.mjs's GATED map, and the manifest's `artifacts` block must
// agree — verify() fails loud on any drift among the three.
function liveArtifacts(sourceRoot) {
  return {
    wakeCoreSha256: path.join(sourceRoot, "..", "_shared", "wake-core.mjs"),
    // workflowSha256 is deliberately NOT here: the CI workflow is a repo-side gate (what CI
    // executes), checked by refresh-manifest.mjs --check via the conformance test. Built payloads
    // do not ship .github/, so gating it here would fail every packaged install on a file that is
    // correct to be absent.
    wakeHelperSha256: path.join(sourceRoot, "wake-helper", "kijito-wake-helper.mjs"),
    wsUdsSha256: path.join(sourceRoot, "wake-helper", "ws-uds.mjs"),
    wakeHelperTestsSha256: path.join(sourceRoot, "wake-helper", "kijito-wake-helper.test.mjs"),
    wakeHelperIntegrationTestsSha256: path.join(sourceRoot, "wake-helper", "integration.test.mjs"),
    wakeHelperMockDaemonSha256: path.join(sourceRoot, "wake-helper", "mock-daemon.mjs"),
  };
}

// Executables on the live user path that are deliberately NOT gated, by ruling: instruments and
// docs a user session is never caused to run. Anything else executable found beside the gated
// files fails verify.
const UNGATED_ALLOWLIST = new Set(["status-probe.mjs"]);

function verify({ sourceRoot }) {
  const manifestFile = path.join(sourceRoot, "release-manifest.json");
  const release = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (release.schema !== 1 || release.product !== "codex-kijito-hive") {
    throw new Error("invalid source release manifest");
  }
  const gated = liveArtifacts(sourceRoot);
  const checked = [];
  // Direction one: everything the manifest gates must exist and match. A missing file surfaces as
  // its own named error, not a generic ENOENT — a manifest gating absent files is the exact
  // intermediate state the gate-6 one-commit rule forbids.
  for (const [key, file] of Object.entries(gated)) {
    const expected = release.artifacts?.[key];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`manifest does not gate ${key} — live artifact with no gate entry`);
    }
    let actual;
    try {
      actual = sha256(file);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`manifest gates an ABSENT file: ${key} -> ${path.relative(sourceRoot, file)}`);
      throw error;
    }
    if (actual !== expected) {
      throw new Error(`${key} differs from gated hash (${path.relative(sourceRoot, file)})`);
    }
    checked.push(key);
  }
  // The manifest must not gate entries this verifier does not check — a stale extra entry would
  // read as covered while nothing verifies it.
  for (const key of Object.keys(release.artifacts ?? {})) {
    if (key === "planSha256") continue; // recorded provenance, deliberately not a gate
    if (key === "workflowSha256") continue; // repo-side gate: refresh-manifest --check owns it
    if (!(key in gated)) {
      throw new Error(`manifest gates ${key} but the live verifier has no such artifact — retired entries belong in legacyArtifacts`);
    }
  }
  // Direction two: no executable ships ungated from the live directories.
  const wakeHelperDir = path.join(sourceRoot, "wake-helper");
  const gatedFiles = new Set(Object.values(gated).map((f) => fs.realpathSync(f)));
  for (const entry of fs.readdirSync(wakeHelperDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    if (UNGATED_ALLOWLIST.has(entry.name)) continue;
    const file = fs.realpathSync(path.join(wakeHelperDir, entry.name));
    if (!gatedFiles.has(file)) {
      throw new Error(`ungated executable on the live path: wake-helper/${entry.name}`);
    }
  }
  return { status: "VERIFIED", artifacts: checked.sort() };
}

// Deploy the provider's skills to the Codex skills directory. Idempotent and update-in-place on
// purpose: skills are versioned prose meant to be overwritten. (Carried unchanged from the
// controller-era installer — this path was always the live one.)
function installSkills({ sourceRoot, skillsRoot }) {
  const source = path.join(sourceRoot, "skills");
  const deployed = [];
  let names = [];
  try { names = fs.readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch (error) { if (error.code === "ENOENT") return deployed; throw error; }
  for (const name of names) {
    const skillFile = path.join(source, name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const target = path.join(skillsRoot, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), fs.readFileSync(skillFile), { mode: 0o644 });
    const files = ["SKILL.md"];
    // The agents/ sidecar carries the Codex-surface interface metadata (display name, default
    // prompt). A skill deployed without it loses its presentation, so it travels with the skill.
    const sidecar = path.join(source, name, "agents", "openai.yaml");
    if (fs.existsSync(sidecar)) {
      fs.mkdirSync(path.join(target, "agents"), { recursive: true });
      fs.writeFileSync(path.join(target, "agents", "openai.yaml"), fs.readFileSync(sidecar), { mode: 0o644 });
      files.push("agents/openai.yaml");
    }
    deployed.push({ skill: name, target, files });
  }
  return deployed;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const verified = verify(options);
  const result = options.skillsOnly
    ? { status: "SKILLS_INSTALLED", verified: verified.artifacts, skillsRoot: options.skillsRoot, skills: installSkills(options) }
    : verified;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
