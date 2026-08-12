import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureEvidence, fixtureSpecimen } from "../n0-harness/fixture.mjs";
import { evaluateOracle, validateSpecimen } from "../n0-harness/oracle.mjs";

const NOW = Date.parse("2026-07-30T23:10:00.000Z");
const HERE = path.dirname(fileURLToPath(import.meta.url));

function expectCode(action, code) {
  assert.throws(action, (error) => error?.name === "N0Error" && error?.code === code);
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

test("N-1: project equality is rejected without an incidental outside-path overlap", () => {
  const specimen = fixtureSpecimen();
  specimen.paths.project = specimen.paths.specimenParent;
  const outside = [
    specimen.paths.control,
    specimen.paths.reviewWorktree,
    specimen.paths.originalWorkspace,
    specimen.paths.originalCodex,
    specimen.paths.ordinaryConfig,
    specimen.paths.ordinaryAuth,
    specimen.paths.slashTmp,
    specimen.paths.tmpdir,
  ];
  assert.equal(outside.some((candidate) => overlaps(specimen.paths.project, candidate) || overlaps(candidate, specimen.paths.project)), false);
  expectCode(() => validateSpecimen(specimen), "PROJECT_PARENT");
});

test("N-2: specimen validation precedes malformed evidence attribution", () => {
  const specimen = fixtureSpecimen();
  const evidence = fixtureEvidence(specimen, NOW);
  specimen.schema = "WRONG";
  evidence.unreviewed = true;
  const result = evaluateOracle(specimen, evidence, NOW);
  assert.equal(result.status, "RED");
  assert.equal(result.code, "SPECIMEN_SCHEMA");
});

test("N-3: relative canary paths reject identically from unrelated working directories", () => {
  const specimen = fixtureSpecimen();
  specimen.canaries["control-read"].path = "relative/control-read";
  const originalCwd = process.cwd();
  const roots = [mkdtempSync(path.join(tmpdir(), "n0-cwd-a-")), mkdtempSync(path.join(tmpdir(), "n0-cwd-b-"))];
  try {
    for (const cwd of roots) {
      process.chdir(cwd);
      expectCode(() => validateSpecimen(specimen), "CANARY_MISSING");
    }
  } finally {
    process.chdir(originalCwd);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("N-7: counterexample setup has no mutation-derived fallback input", () => {
  const source = readFileSync(path.join(HERE, "n0-guard-counterexamples.mjs"), "utf8");
  assert.doesNotMatch(source, /(?:specimen|evidence)-valid\.json/);
  assert.doesNotMatch(source, /n0-guard-census\.json|n0-guard-mutation-runner/);
  assert.doesNotMatch(source, /\bmutation\b|\breplacement\b/);
});
