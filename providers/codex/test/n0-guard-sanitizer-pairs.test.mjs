import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeGuardGraph } from "./n0-guard-census-core.mjs";
import { applyMutations, replacementFor } from "./n0-guard-mutation-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

function runCase(root, id) {
  const result = spawnSync(process.execPath, ["providers/codex/test/n0-guard-counterexamples.mjs", id], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const EXPECTED_OWNERSHIP = new Map([
  ["parser.mjs:41:19:rejecting-helper-call:d3df82140ecfc7d0", "mixed-ownership"],
  ["parser.mjs:77:22:rejecting-helper-call:4559b1577e5654c7", "normal-ownership"],
  ["parser.mjs:107:18:rejecting-helper-call:04f6cdc8d3d1a5f8", "normal-ownership"],
  ["parser.mjs:119:19:rejecting-helper-call:e792f84ed71527f6", "normal-ownership"],
  ["prompt.mjs:42:29:rejecting-helper-call:0f93f1bf1d83d8ce", "normal-ownership"],
  ["snapshot.mjs:113:21:rejecting-helper-call:7613fc44bd316ea4", "normal-ownership"],
  ["specimen.mjs:12:10:rejecting-helper-call:d808855d1bc13c94", "normal-ownership"],
]);

test("every remaining reviewed first-argument sanitizer keeps its exact measured ownership and accepting witness", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "n0-sanitizer-pairs-"));
  try {
    fs.cpSync(path.join(ROOT, "providers"), path.join(root, "providers"), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "providers/codex/test/n0-guard-census.json"), "utf8"));
    const entries = manifest.entries.filter((entry) => entry.mutation?.operator === "sanitize-first-argument");
    assert.equal(entries.length, EXPECTED_OWNERSHIP.size);
    assert.deepEqual(entries.map((entry) => entry.id).sort(), [...EXPECTED_OWNERSHIP.keys()].sort());
    const graph = analyzeGuardGraph(path.join(root, "providers/codex/n0-harness"));
    for (const entry of entries) {
      assert.equal(entry.ownershipRecord?.kind, EXPECTED_OWNERSHIP.get(entry.id), entry.id);
      assert.equal(entry.witness?.partition, "acceptFlipSet", entry.id);
      const actual = graph.entries.find((candidate) => candidate.id === entry.id);
      assert.ok(actual, entry.id);
      const pristine = runCase(root, entry.witness.id);
      assert.deepEqual(
        { accepted: pristine.accepted, code: pristine.code },
        { accepted: false, code: entry.witness.rejectCode },
        entry.id,
      );
      const restore = applyMutations(root, [{ ...actual, replacement: replacementFor(entry) }]);
      try {
        const mutant = runCase(root, entry.witness.id);
        assert.deepEqual(
          { accepted: mutant.accepted, code: mutant.code },
          { accepted: true, code: entry.witness.acceptCode },
          entry.id,
        );
      } finally {
        restore();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
