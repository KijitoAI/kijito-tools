import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeGuardGraph } from "./n0-guard-census-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SOURCE_ROOT = path.join(ROOT, "providers/codex/n0-harness");
const MANIFEST_PATH = path.join(HERE, "n0-guard-census.json");

const EXPECTED_SHADOWS = [
  "oracle.mjs:81:17:rejecting-helper-call:74d6da1d9a547734",
  "oracle.mjs:98:18:rejecting-helper-call:72e6f71373cc02a2",
  "oracle.mjs:106:22:rejecting-helper-call:a09692553a3b4d79",
  "oracle.mjs:177:17:rejecting-helper-call:4cfcd52300a3b9c3",
  "oracle.mjs:189:19:rejecting-helper-call:d1a33bb56cfd0cb8",
  "oracle.mjs:193:20:rejecting-helper-call:0378081cd7a677a4",
  "oracle.mjs:215:18:rejecting-helper-call:395a93f673d3332a",
  "oracle.mjs:223:3:rejecting-helper-call:8bbe25ad570a6758",
  "oracle.mjs:242:23:rejecting-helper-call:421568a92598c2d1",
  "oracle.mjs:292:3:rejecting-helper-call:2563493bf86065c7",
  "oracle.mjs:430:3:rejecting-helper-call:0e82521959067f2f",
].sort();

const EXPECTED_SUCCESS_PATHS = [
  "fixture.mjs:64:20:rejecting-helper-call:5ee8fe818d227757",
  "fixture.mjs:116:18:rejecting-helper-call:e2f8125b417f7ed0",
  "fixture.mjs:175:44:rejecting-helper-call:891243e1c000198e",
  "fixture.mjs:220:54:rejecting-helper-call:891243e1c000198e",
  "fixture.mjs:232:44:rejecting-helper-call:891243e1c000198e",
  "fixture.mjs:252:17:rejecting-helper-call:107da86911fcb8d4",
  "oracle.mjs:175:25:rejecting-helper-call:e2f8125b417f7ed0",
].sort();

const EXPECTED_DELEGATED = ["cli.mjs:28:18:rejecting-helper-call:2abc5cf6881921c3"];

const EXPECTED_DOWNSTREAM_DOMAIN_SHADOWS = new Map([
  ["oracle.mjs:230:7:predicate-atom:c501cea746d8b024", "oracle.canary.value-null"],
  ["oracle.mjs:230:17:predicate-atom:e052cf82d87a7ce7", "oracle.canary.value-primitive"],
]);

function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function allCases() {
  const result = spawnSync(process.execPath, ["providers/codex/test/n0-guard-counterexamples.mjs", "--all"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "n0-remainder-proof."));
  fs.writeFileSync(path.join(root, "fixture.mjs"), source);
  return root;
}

function independentlyOwned(entry) {
  return [
    "normal-ownership",
    "reject-preserving-ownership",
    "mixed-ownership",
    "compound-member",
    "same-code-shadow",
  ].includes(entry?.ownershipRecord?.kind)
    || entry?.disposition?.kind === "not-independently-discriminated";
}

test("R4 membership is exact-11, adjacency-derived, and every member names an active pristine invalid-domain witness", () => {
  const graph = analyzeGuardGraph(SOURCE_ROOT);
  const frozen = manifest();
  const pristine = allCases();
  const derived = [];
  for (const proof of graph.sameCodeShadows) {
    const owner = frozen.entries.find((entry) => entry.id === proof.entryId);
    const record = owner?.ownershipRecord;
    if (record?.kind !== "same-code-shadow") continue;
    assert.equal(record.downstreamEntryId, proof.downstreamEntryId, proof.entryId);
    assert.equal(record.rejectCode, proof.rejectCode, proof.entryId);
    assert.deepEqual(record.canonicalMutation, { operator: "suppress-thrown-rejection" }, proof.entryId);
    assert.equal(typeof record.witnessId, "string", proof.entryId);
    assert.deepEqual(
      { accepted: pristine[record.witnessId]?.accepted, code: pristine[record.witnessId]?.code },
      { accepted: false, code: proof.rejectCode },
      `${proof.entryId}: A-R4 witness must actively reject the invalid domain with the shared code`,
    );
    assert.ok(independentlyOwned(frozen.entries.find((entry) => entry.id === proof.downstreamEntryId)), proof.downstreamEntryId);
    derived.push(proof.entryId);
  }
  assert.deepEqual(derived.sort(), EXPECTED_SHADOWS);
  assert.equal(frozen.floors.sameCodeShadowEntries, EXPECTED_SHADOWS.length);
});

test("R4 proof fails closed on intervening operations and unequal rejection codes", () => {
  const variants = [
    ["adjacent", "const value = requireObject(input, \"BAD\"); assertExactKeys(value, [], \"BAD\");", 1],
    ["intervening", "const value = requireObject(input, \"BAD\"); consume(value); assertExactKeys(value, [], \"BAD\");", 0],
    ["unequal", "const value = requireObject(input, \"BAD\"); assertExactKeys(value, [], \"OTHER\");", 0],
  ];
  for (const [name, body, expected] of variants) {
    const root = fixture(`
      function fail(code){ throw new Error(code); }
      function requireObject(value, code){ if(!value) fail(code); return value; }
      function assertExactKeys(value, keys, code){ if(Object.keys(value).length !== keys.length) fail(code); }
      function consume(){}
      export function probe(input){ ${body} return {status:"N0_TEST_CAPABLE"}; }
    `);
    try {
      assert.equal(analyzeGuardGraph(root).sameCodeShadows.length, expected, name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("R7 downstream-domain shadows are exact-two, hash-bound, actively witnessed, and downstream-owned", () => {
  const graph = analyzeGuardGraph(SOURCE_ROOT);
  const frozen = manifest();
  const pristine = allCases();
  assert.deepEqual(
    graph.downstreamDomainShadows.map((proof) => proof.entryId).sort(),
    [...EXPECTED_DOWNSTREAM_DOMAIN_SHADOWS.keys()].sort(),
  );
  assert.equal(frozen.floors.downstreamDomainShadowEntries, 2);
  for (const proof of graph.downstreamDomainShadows) {
    const owner = frozen.entries.find((entry) => entry.id === proof.entryId)?.ownershipRecord;
    assert.equal(owner?.kind, "downstream-domain-shadow", proof.entryId);
    assert.equal(owner.downstreamEntryId, proof.downstreamEntryId, proof.entryId);
    assert.deepEqual(owner.enforcingEntryIds, proof.enforcingEntryIds, proof.entryId);
    assert.deepEqual(owner.canonicalMutation, { operator: "force-owned-condition", value: false }, proof.entryId);
    assert.deepEqual(owner.catchReturn, proof.catchReturn, proof.entryId);
    assert.equal(owner.pathHash, proof.pathHash, proof.entryId);
    assert.equal(owner.witnessId, EXPECTED_DOWNSTREAM_DOMAIN_SHADOWS.get(proof.entryId), proof.entryId);
    assert.deepEqual(
      { accepted: pristine[owner.witnessId]?.accepted, code: pristine[owner.witnessId]?.code },
      { accepted: false, code: "CANARY_MISSING" },
      proof.entryId,
    );
    assert.ok(independentlyOwned(frozen.entries.find((entry) => entry.id === proof.downstreamEntryId)), proof.downstreamEntryId);
  }
});

test("R7 downstream-domain proof fails closed on changed catch, absent/outside/intervening/dynamic/optional helpers", () => {
  const probe = (body) => `
    function fail(){ throw new Error("BAD"); }
    function assertExactKeys(value){ if(!value) fail(); }
    function isCanary(value){ ${body} return true; }
    export function probe(value){ if(!isCanary(value)) fail(); return {status:"N0_TEST_CAPABLE"}; }
  `;
  const variants = [
    ["closed", "if(!value || typeof value !== \"object\") return false; try { assertExactKeys(value); } catch { return false; }", 2],
    ["different-catch", "if(!value || typeof value !== \"object\") return false; try { assertExactKeys(value); } catch { return true; }", 0],
    ["no-helper", "if(!value || typeof value !== \"object\") return false; try { void value; } catch { return false; }", 0],
    ["outside-try", "if(!value || typeof value !== \"object\") return false; assertExactKeys(value); try {} catch { return false; }", 0],
    ["intervening", "if(!value || typeof value !== \"object\") return false; try { value = {}; assertExactKeys(value); } catch { return false; }", 0],
    ["dynamic", "if(!value || typeof value !== \"object\") return false; try { (0, assertExactKeys)(value); } catch { return false; }", 0],
    ["optional", "if(!value || typeof value !== \"object\") return false; try { assertExactKeys?.(value); } catch { return false; }", 0],
  ];
  for (const [name, body, expected] of variants) {
    const root = fixture(probe(body));
    try {
      assert.equal(analyzeGuardGraph(root).downstreamDomainShadows.length, expected, name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("R7 direct witnesses retain their exact ordinary measured partitions", () => {
  const frozen = manifest();
  const expected = new Map([
    ["lib.mjs:82:92:predicate-atom:4542f69c79c1c3b7", {
      kind: "normal-ownership",
      witness: { partition: "acceptFlipSet", id: "lib.path.relative-absolute-injection", rejectCode: "X", acceptCode: "HELPER_ACCEPTED" },
    }],
    ["oracle.mjs:237:44:predicate-atom:a9035cd3a7d97ea6", {
      kind: "reject-preserving-ownership",
      witness: { partition: "rejectDeltaSet", id: "oracle.canary.path-relative", beforeCode: "CANARY_MISSING", afterCode: "CANARY_PATH_CLASS" },
    }],
    ["oracle.mjs:313:7:guard-atom:e3c481736ae16a55", {
      kind: "reject-preserving-ownership",
      witness: { partition: "rejectDeltaSet", id: "oracle.case.cases-null", beforeCode: "CASE_EVIDENCE_INVALID", afterCode: "ORACLE_EXCEPTION" },
    }],
  ]);
  for (const [id, proof] of expected) {
    const entry = frozen.entries.find((candidate) => candidate.id === id);
    assert.equal(entry?.ownershipRecord?.kind, proof.kind, id);
    assert.deepEqual(entry?.witness, proof.witness, id);
    assert.deepEqual(entry?.positiveRegressionSet, [], id);
  }
});

test("R3 compounds are seven closed units with exactly thirteen owned members", () => {
  const frozen = manifest();
  assert.equal(frozen.compounds.length, 7);
  const members = frozen.compounds.flatMap((compound) => compound.memberIds);
  assert.equal(members.length, 13);
  assert.equal(new Set(members).size, 13);
  assert.equal(frozen.floors.compoundDispositionUnits, 7);
  assert.equal(frozen.floors.compoundDispositionMembers, 13);
  for (const compound of frozen.compounds) {
    assert.ok(compound.edits.length >= 2, compound.id);
    assert.ok(compound.memberIds.every((id) => compound.edits.some((edit) => edit.entryId === id)), compound.id);
    for (const memberId of compound.memberIds) {
      const owner = frozen.entries.find((entry) => entry.id === memberId);
      assert.deepEqual(owner?.ownershipRecord, { kind: "compound-member", compoundId: compound.id }, memberId);
    }
  }
});

test("R5 membership is the exact analyzer-derived seven and the oracle guard proof names owned dischargers", () => {
  const graph = analyzeGuardGraph(SOURCE_ROOT);
  const frozen = manifest();
  assert.deepEqual(graph.successPathCalls.map((proof) => proof.entryId).sort(), EXPECTED_SUCCESS_PATHS);
  assert.equal(frozen.floors.successPathCalls, EXPECTED_SUCCESS_PATHS.length);
  assert.ok(!graph.successPathCalls.some((proof) => proof.entryId.startsWith("specimen.mjs:9:")));
  for (const proof of graph.successPathCalls) {
    const owner = frozen.entries.find((entry) => entry.id === proof.entryId);
    assert.equal(owner?.ownershipRecord?.kind, "success-path-call", proof.entryId);
    assert.equal(owner.ownershipRecord.proofKind, proof.proofKind, proof.entryId);
    assert.deepEqual(owner.ownershipRecord.dischargerEntryIds, proof.dischargerEntryIds, proof.entryId);
    if (proof.proofKind !== "guard-call-dominated-by-owned-dischargers") continue;
    assert.ok(proof.dischargerEntryIds.length > 0, proof.entryId);
    assert.equal(typeof proof.conditionalOwnerId, "string", proof.entryId);
    for (const id of [...proof.dischargerEntryIds, proof.conditionalOwnerId]) {
      assert.ok(independentlyOwned(frozen.entries.find((entry) => entry.id === id)), `${proof.entryId}->${id}`);
    }
  }
});

test("R5 success-path proof rejects caller arguments, guard-test calls, and optional calls unless a closed proof applies", () => {
  const variants = [
    ["closed", "function render(value){ if(!value) fail(); return value; } export function probe(){ return render({}); }", 1],
    ["caller-argument", "function render(value){ if(!value) fail(); return value; } export function probe(value){ return render(value); }", 0],
    ["guard-test", "function render(value){ if(!value) fail(); return value; } export function probe(value){ if(render(value)) return {status:\"N0_TEST_CAPABLE\"}; }", 0],
    ["optional", "function render(value){ if(!value) fail(); return value; } export function probe(){ return render?.({}); }", 0],
  ];
  for (const [name, body, expected] of variants) {
    const root = fixture(`function fail(){ throw new Error("BAD"); } ${body}`);
    try {
      assert.equal(analyzeGuardGraph(root).successPathCalls.length, expected, name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("R6 membership is exact-one with separately hash-bound caller anchors and independently owned internal outcomes", () => {
  const graph = analyzeGuardGraph(SOURCE_ROOT);
  const frozen = manifest();
  assert.deepEqual(graph.delegatedOutcomeCalls.map((proof) => proof.entryId), EXPECTED_DELEGATED);
  assert.equal(frozen.floors.delegatedOutcomeCalls, 1);
  const proof = graph.delegatedOutcomeCalls[0];
  const owner = frozen.entries.find((entry) => entry.id === proof.entryId)?.ownershipRecord;
  assert.equal(owner?.kind, "delegated-outcome-call");
  assert.deepEqual(owner.internalCallEntryIds, proof.internalCallEntryIds);
  assert.deepEqual(owner.internalOutcomeEntryIds, proof.internalOutcomeEntryIds);
  assert.deepEqual(owner.callerNullGuardOwnership, proof.callerNullGuard);
  assert.deepEqual(owner.callerControlFlowOwnership, proof.callerControlFlow);
  assert.notEqual(proof.callerNullGuard.id, proof.callerControlFlow.id);
  for (const id of [...proof.internalCallEntryIds, ...proof.internalOutcomeEntryIds]) {
    assert.ok(independentlyOwned(frozen.entries.find((entry) => entry.id === id)), `${proof.entryId}->${id}`);
  }
});

test("R6 delegated-outcome proof fails closed on missing null control flow, throwing, dynamic, and aliased delegation", () => {
  const sources = [
    ["good", `
      function usage(){ process.exitCode = 64; }
      function args(argv){ if(!argv){ usage(); return null; } return {}; }
      export function main(argv){ const parsed = args(argv); if(!parsed) return; return {status:"N0_TEST_CAPABLE"}; }
    `, 1, null],
    ["no-null-guard", `
      function usage(){ process.exitCode = 64; }
      function args(argv){ if(!argv){ usage(); return null; } return {}; }
      export function main(argv){ return args(argv); }
    `, 0, null],
    ["throwing", `
      function usage(){ throw new Error("BAD"); }
      function args(argv){ if(!argv){ usage(); return null; } return {}; }
      export function main(argv){ const parsed = args(argv); if(!parsed) return; return {status:"N0_TEST_CAPABLE"}; }
    `, 0, null],
    ["dynamic", `
      function usage(){ process.exitCode = 64; }
      function other(){}
      function args(argv){ if(!argv){ (argv ? other : usage)(); return null; } return {}; }
      export function main(argv){ const parsed = args(argv); if(!parsed) return; return {status:"N0_TEST_CAPABLE"}; }
    `, 0, null],
    ["alias", `
      function usage(){ process.exitCode = 64; }
      const emit = usage;
      function args(argv){ if(!argv){ emit(); return null; } return {}; }
      export function main(argv){ const parsed = args(argv); if(!parsed) return; return {status:"N0_TEST_CAPABLE"}; }
    `, 0, "CENSUS_REJECT_ALIAS"],
  ];
  for (const [name, source, expected, errorCode] of sources) {
    const root = fixture(source);
    try {
      if (errorCode) assert.throws(() => analyzeGuardGraph(root), (error) => error?.code === errorCode, name);
      else assert.equal(analyzeGuardGraph(root).delegatedOutcomeCalls.length, expected, name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
