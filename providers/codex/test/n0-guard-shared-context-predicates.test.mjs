import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeGuardGraph } from "./n0-guard-census-core.mjs";
import { expectedPositiveCases } from "./n0-guard-counterexamples.mjs";
import { applyMutations, assertPristineMatrix, replacementFor } from "./n0-guard-mutation-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ALLOWED_CONTEXTS = new Set(["reject-on-false", "reject-on-true", "non-enforcing"]);
const EXPECTED_SHARED_ATOMS = [
  "lib.mjs:22:10:predicate-atom:b579cf79ff684260",
  "lib.mjs:22:28:predicate-atom:f13c9e45b40ad616",
  "lib.mjs:82:10:predicate-atom:b7fc7b5f4fb78cb6",
  "lib.mjs:82:30:predicate-atom:d8edadc88ffeb3ca",
].sort();

function matrix(root) {
  const result = spawnSync(process.execPath, ["providers/codex/test/n0-guard-counterexamples.mjs", "--all"], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function changedPositiveIds(pristine, mutant) {
  return Object.keys(expectedPositiveCases()).filter((id) => {
    assert.equal(pristine[id]?.accepted, true, `pristine named positive ${id}`);
    return JSON.stringify(mutant[id]) !== JSON.stringify(pristine[id]);
  });
}

test("shared-context predicate membership is mechanically closed at the exact four approved atoms", () => {
  const graph = analyzeGuardGraph(path.join(ROOT, "providers/codex/n0-harness"));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "providers/codex/test/n0-guard-census.json"), "utf8"));
  const candidates = graph.sharedContextPredicates.filter((proof) => {
    assert.ok(proof.contexts.every((context) => ALLOWED_CONTEXTS.has(context)), `${proof.predicate}: unknown context`);
    return new Set(proof.contexts).size >= 2;
  });
  assert.ok(candidates.length > 0);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "n0-shared-context-"));
  try {
    fs.cpSync(path.join(ROOT, "providers"), path.join(temp, "providers"), { recursive: true });
    const pristine = matrix(temp);
    assertPristineMatrix(pristine, expectedPositiveCases());
    const tempGraph = analyzeGuardGraph(path.join(temp, "providers/codex/n0-harness"));
    const derived = [];

    for (const proof of candidates) {
      for (const id of proof.atomIds) {
        const actual = tempGraph.entries.find((entry) => entry.id === id);
        assert.ok(actual, id);
        const frozenProof = manifest.baseline.sharedContextPredicates.find((item) => item.functionKey === proof.functionKey);
        const canonicalMutation = frozenProof?.canonicalAtomMutations?.find((item) => item.id === id)?.mutation;
        assert.ok(canonicalMutation, `${id}: missing canonical mutation in frozen predicate proof`);
        const restore = applyMutations(temp, [{ ...actual, replacement: replacementFor({ ...actual, mutation: canonicalMutation }) }]);
        let regressed;
        try {
          regressed = changedPositiveIds(pristine, matrix(temp));
        } finally {
          restore();
        }
        if (regressed.length > 0) derived.push(id);
      }
    }

    assert.deepEqual(derived.sort(), EXPECTED_SHARED_ATOMS);
    assert.deepEqual(
      manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "shared-context-predicate").map((entry) => entry.id).sort(),
      EXPECTED_SHARED_ATOMS,
    );
    assert.equal(manifest.floors.sharedContextPredicateAtoms, EXPECTED_SHARED_ATOMS.length);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
