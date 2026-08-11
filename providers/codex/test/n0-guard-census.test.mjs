import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeGuardGraph, mergeManifest, validateManifest } from "./n0-guard-census-core.mjs";
import { assertDiscriminatingPair } from "./n0-guard-mutation-runner.mjs";

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "n0-census-self."));
  fs.writeFileSync(path.join(root, "fixture.mjs"), source);
  return root;
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function ownNormal(entry) {
  entry.mutation = entry.kind.includes("atom")
    ? { operator: "force-owned-condition", value: false }
    : { operator: "bypass-rejection" };
  entry.witness = { partition: "acceptFlipSet", id: "named", rejectCode: "BAD", acceptCode: "GREEN" };
  entry.acceptFlipSet = [{ id: "named", rejectCode: "BAD", acceptCode: "GREEN" }];
  entry.rejectDeltaSet = [];
  entry.positiveRegressionSet = [];
  entry.ownershipRecord = { kind: "normal-ownership" };
}

function fullyOwn(manifest) {
  for (const entry of manifest.entries) {
    if (entry.kind === "success-constructor") {
      entry.ownershipRecord = { kind: "owned-success", reason: "test" };
    } else if (["unresolved-call", "outcome-candidate"].includes(entry.kind)) {
      entry.classification = { kind: entry.kind === "unresolved-call" ? "non-predicate" : "non-outcome", reason: "test" };
    } else {
      ownNormal(entry);
    }
  }
  manifest.floors.ownershipCounts = { rejectPreservingOwnership: 0, mixedOwnership: 0 };
  manifest.floors.ownershipGrowthReasons = {};
  manifest.floors.sharedContextPredicateAtoms = 0;
  manifest.floors.sameCodeShadowEntries = 0;
  manifest.floors.successPathCalls = 0;
  manifest.floors.delegatedOutcomeCalls = 0;
  manifest.floors.compoundDispositionMembers = 0;
  manifest.compounds = [];
  return manifest;
}

test("AST census ignores sink-like data while owning multiline executable sinks", () => {
  const root = fixture(`
    const a = "fail( data";
    const b = \`verdict("RED" data\`;
    const c = /fail\\(/;
    function fail() { throw new Error("x"); }
    function verdict(status) { return status; }
    export function probe(value) {
      if (!value) fail(
        "MULTILINE",
        "real"
      );
      return verdict("N0_TEST_CAPABLE");
    }
  `);
  try {
    const graph = analyzeGuardGraph(root);
    assert.equal(graph.entries.filter((entry) => entry.kind === "rejection-site" && entry.spelling === "fail").length, 1);
    assert.equal(graph.counts["success-constructor"], 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("manifest ownership fails closed for missing, duplicate, stale, and unmatched nodes", () => {
  const root = fixture(`function fail() { throw new Error("x"); } function verdict(s){return s;} export function p(x){if(!x) fail("X"); return verdict("N0_TEST_CAPABLE");}`);
  try {
    const graph = analyzeGuardGraph(root);
    const base = mergeManifest(graph);
    assert.equal(validateManifest(graph, base, { requirePairs: false, requireBaseline: false }), true);
    const missing = structuredClone(base); missing.entries.pop();
    errorCode(() => validateManifest(graph, missing, { requirePairs: false, requireBaseline: false }), "CENSUS_UNOWNED_NODE");
    const duplicate = structuredClone(base); duplicate.entries.push(structuredClone(duplicate.entries[0]));
    errorCode(() => validateManifest(graph, duplicate, { requirePairs: false, requireBaseline: false }), "CENSUS_DUPLICATE_OWNER");
    const stale = structuredClone(base); stale.entries[0].sourceHash = "0".repeat(64);
    errorCode(() => validateManifest(graph, stale, { requirePairs: false, requireBaseline: false }), "CENSUS_STALE_ANCHOR");
    const unmatched = structuredClone(base); unmatched.entries.push({ ...structuredClone(unmatched.entries[0]), id: "ghost" });
    errorCode(() => validateManifest(graph, unmatched, { requirePairs: false, requireBaseline: false }), "CENSUS_UNMATCHED_OWNER");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("predicate helpers and every rejecting-helper call site are separate nodes", () => {
  const root = fixture(`
    function fail() { throw new Error("x"); }
    function verdict(s){ return s; }
    function valid(x) { return typeof x === "string" && x.length > 2 && /^[a-z]+$/.test(x); }
    function requireValid(x) { if (!valid(x)) fail("BAD"); }
    export function p(a,b) { requireValid(a); requireValid(b); return verdict("N0_TEST_CAPABLE"); }
    export function q(a,b) { if (a && b) requireValid(a); return verdict("N0_TEST_CAPABLE"); }
  `);
  try {
    const graph = analyzeGuardGraph(root);
    assert.equal(graph.entries.filter((entry) => entry.kind === "predicate-atom" && entry.predicate === "valid").length, 3);
    assert.equal(graph.entries.filter((entry) => entry.kind === "rejecting-helper-call" && entry.helper === "requireValid").length, 3);
    assert.equal(graph.entries.filter((entry) => entry.kind === "guard-atom" && entry.ownerSinkLine === 7).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("N-term guard requires every atomic owner and exactly one success constructor", () => {
  const root = fixture(`function fail(){throw new Error("x");} function verdict(s){return s;} export function p(a,b,c){if(a||b||c) fail("BAD"); return verdict("N0_TEST_CAPABLE");}`);
  try {
    const graph = analyzeGuardGraph(root);
    assert.equal(graph.entries.filter((entry) => entry.kind === "guard-atom").length, 3);
    const nMinusOne = mergeManifest(graph);
    const atom = nMinusOne.entries.find((entry) => entry.kind === "guard-atom");
    nMinusOne.entries = nMinusOne.entries.filter((entry) => entry.id !== atom.id);
    errorCode(() => validateManifest(graph, nMinusOne, { requirePairs: false, requireBaseline: false }), "CENSUS_UNOWNED_NODE");
    const nMinusOnePairs = fullyOwn(mergeManifest(graph));
    const missingPair = nMinusOnePairs.entries.find((entry) => entry.kind === "guard-atom");
    missingPair.mutation = null;
    missingPair.witness = null;
    missingPair.acceptFlipSet = null;
    missingPair.rejectDeltaSet = null;
    missingPair.positiveRegressionSet = null;
    missingPair.ownershipRecord = null;
    errorCode(() => validateManifest(graph, nMinusOnePairs, { requirePairs: true, requireBaseline: false }), "CENSUS_PAIR_MISSING");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("named two-sided pairs reject unrelated attribution and strengthening mutants", () => {
  const entry = {
    id: "fixture:guard",
    witness: { partition: "acceptFlipSet", id: "named-counterexample", rejectCode: "EXACT_RED", acceptCode: "EXACT_GREEN" },
  };
  errorCode(() => assertDiscriminatingPair(entry,
    { accepted: false, code: "UNRELATED_TEST_FAILURE" },
    { accepted: true, code: "EXACT_GREEN" }), "MUTATION_PRISTINE_PAIR");
  errorCode(() => assertDiscriminatingPair(entry,
    { accepted: false, code: "EXACT_RED" },
    { accepted: false, code: "EXACT_RED" }), "MUTATION_NOT_DISCRIMINATED");
});

test("bare throw, process termination, dynamic negative verdicts, and second success are visible", () => {
  const root = fixture(`
    function verdict(s){return s;}
    export function p(x){
      if(x===1) throw new Error("x");
      if(x===2) process.exit(1);
      if(x===3) process.exitCode=1;
      if(x===4) return verdict("RED");
      if(x===5) return verdict("N0_TEST_CAPABLE");
      return verdict("N0_TEST_CAPABLE");
    }
  `);
  try {
    const graph = analyzeGuardGraph(root);
    assert.equal(graph.counts["termination-site"], 1);
    assert.equal(graph.counts["exit-status-site"], 1);
    assert.equal(graph.counts["success-constructor"], 2);
    const manifest = mergeManifest(graph);
    errorCode(() => validateManifest(graph, manifest, { requirePairs: false, requireBaseline: false }), "CENSUS_SUCCESS_COUNT");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("relative import escape, missing imports, and dynamic imports fail closed", () => {
  for (const [source, code] of [
    ['import "../outside.mjs"; export const x = 1;', "CENSUS_IMPORT_ESCAPE"],
    ['import "./missing.mjs"; export const x = 1;', "CENSUS_IMPORT_MISSING"],
    ['export async function x(){ return import("node:fs"); }', "CENSUS_DYNAMIC_IMPORT"],
  ]) {
    const root = fixture(source);
    try { errorCode(() => analyzeGuardGraph(root), code); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("rejecting function aliases fail closed before a manifest can be generated", () => {
  const root = fixture(`
    function fail(){ throw new Error("x"); }
    const alias = fail;
    export function p(x){ if(!x) alias("BAD"); return { status: "N0_TEST_CAPABLE" }; }
  `);
  try { errorCode(() => analyzeGuardGraph(root), "CENSUS_REJECT_ALIAS"); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("predicate aliases and optional calls fail closed before proof enumeration", () => {
  for (const [source, code] of [
    [`
      function fail(){ throw new Error("x"); }
      function valid(x){ return typeof x === "string"; }
      const alias = valid;
      export function p(x){ if(!valid(x)) fail("BAD"); if(!alias(x)) fail("BAD_ALIAS"); return {status:"N0_TEST_CAPABLE"}; }
    `, "CENSUS_PREDICATE_ALIAS"],
    [`
      function fail(){ throw new Error("x"); }
      function valid(x){ return typeof x === "string"; }
      export function p(x){ if(!valid?.(x)) fail("BAD"); return {status:"N0_TEST_CAPABLE"}; }
    `, "CENSUS_PREDICATE_DYNAMIC_CALL"],
  ]) {
    const root = fixture(source);
    try { errorCode(() => analyzeGuardGraph(root), code); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("hoisted conjuncts preserve atomic granularity and delegated predicates resolve transitively", () => {
  const inline = fixture(`
    function fail(){throw new Error("x");}
    function leaf(x){return x > 0;}
    function delegated(x){return leaf(x);}
    export function p(a,b){if(a && delegated(b)) fail("BAD"); return {status:"N0_TEST_CAPABLE"};}
  `);
  const hoisted = fixture(`
    function fail(){throw new Error("x");}
    function leaf(x){return x > 0;}
    function delegated(x){return leaf(x);}
    export function p(a,b){const bad = a && delegated(b); if(bad) fail("BAD"); return {status:"N0_TEST_CAPABLE"};}
  `);
  try {
    const a = analyzeGuardGraph(inline);
    const b = analyzeGuardGraph(hoisted);
    assert.equal(a.counts["guard-atom"], 2);
    assert.equal(b.counts["guard-atom"], 2);
    assert.ok(b.entries.some((entry) => entry.kind === "predicate-atom" && entry.predicate === "delegated"));
    assert.ok(b.entries.some((entry) => entry.kind === "predicate-atom" && entry.predicate === "leaf"));
  } finally {
    fs.rmSync(inline, { recursive: true, force: true });
    fs.rmSync(hoisted, { recursive: true, force: true });
  }
});

test("computed exits, sink-like calls, and variable-held verdict objects cannot disappear", () => {
  const root = fixture(`
    import assert from "node:assert";
    export function p(x){
      if(x===1) process["exit"](1);
      if(x===2) process.kill(process.pid, "SIGTERM");
      if(x===3) Promise.reject(new Error("x"));
      if(x===4) assert(false);
      const red = {status:"RED"};
      if(x===5) return red;
      const green = {status:"N0_TEST_CAPABLE"};
      return green;
    }
  `);
  try {
    const graph = analyzeGuardGraph(root);
    assert.equal(graph.counts["termination-site"], 1);
    assert.ok(graph.entries.some((entry) => entry.kind === "rejection-site" && entry.spelling === "process.kill"));
    assert.ok(graph.entries.some((entry) => entry.kind === "rejection-site" && entry.spelling === "Promise.reject"));
    assert.ok(graph.entries.some((entry) => entry.kind === "rejection-site" && entry.spelling === "assert"));
    assert.ok(graph.entries.some((entry) => entry.kind === "rejection-site" && entry.spelling === "object:RED"));
    assert.equal(graph.counts["success-constructor"], 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a second variable-held success and new closed-world calls fail the owning gates", () => {
  const root = fixture(`
    function fail(){throw new Error("x");}
    const object = { dynamic(){ return false; } };
    export function p(x){
      if(object["dynamic"]()) fail("BAD");
      const one = {status:"N0_TEST_CAPABLE"};
      if(x) return one;
      const two = {status:"N0_TEST_CAPABLE"};
      return two;
    }
  `);
  try {
    const graph = analyzeGuardGraph(root);
    assert.equal(graph.counts["success-constructor"], 2);
    assert.ok(graph.entries.some((entry) => entry.kind === "unresolved-call" && entry.callee === "object.dynamic"));
    const manifest = mergeManifest(graph);
    errorCode(() => validateManifest(graph, manifest, { requirePairs: false, requireBaseline: false }), "CENSUS_SUCCESS_COUNT");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("count and redundancy-disposition ratchets fail in the dangerous direction", () => {
  const root = fixture(`function fail(){throw new Error("x");} export function p(x){if(!x) fail("BAD"); return {status:"N0_TEST_CAPABLE"};}`);
  try {
    const graph = analyzeGuardGraph(root);
    const count = mergeManifest(graph);
    count.floors.counts["guard-atom"] += 1;
    errorCode(() => validateManifest(graph, count, { requirePairs: false, requireBaseline: false }), "CENSUS_COUNT_REGRESSION");
    const disposition = mergeManifest(graph);
    const target = disposition.entries.find((entry) => entry.kind === "guard-atom");
    const cover = disposition.entries.find((entry) => entry.kind === "rejection-site");
    target.disposition = {
      kind: "not-independently-discriminated",
      witness: { id: "named", rejectCode: "BAD", acceptCode: "GREEN" },
      coveredBy: [cover.id],
    };
    errorCode(() => validateManifest(graph, disposition, { requirePairs: false, requireBaseline: false }), "CENSUS_DISPOSITION_GROWTH");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("manifest rejects arbitrary mutation operators before execution", () => {
  const root = fixture(`function fail(){throw new Error("x");} export function p(x){if(!x) fail("BAD"); return {status:"N0_TEST_CAPABLE"};}`);
  try {
    const graph = analyzeGuardGraph(root);
    const manifest = mergeManifest(graph);
    const target = manifest.entries.find((entry) => entry.kind === "guard-atom");
    target.mutation = { operator: "substitute-reviewed-expression", expression: "({})" };
    errorCode(() => validateManifest(graph, manifest, { requirePairs: false, requireBaseline: false }), "CENSUS_MUTATION_OPERATOR");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("manifest rejects empty, mismatched, and positive-regressing ownership partitions", () => {
  const root = fixture(`function fail(){throw new Error("x");} export function p(x){if(!x) fail("BAD"); return {status:"N0_TEST_CAPABLE"};}`);
  try {
    const graph = analyzeGuardGraph(root);
    const complete = fullyOwn(mergeManifest(graph));
    assert.equal(validateManifest(graph, complete, { requirePairs: true, requireBaseline: false }), true);
    const target = complete.entries.find((entry) => entry.kind === "guard-atom");

    const empty = structuredClone(complete);
    empty.entries.find((entry) => entry.id === target.id).acceptFlipSet = [];
    errorCode(() => validateManifest(graph, empty, { requirePairs: true, requireBaseline: false }), "CENSUS_MUTATION_OWNERSHIP");

    const wrongWitness = structuredClone(complete);
    wrongWitness.entries.find((entry) => entry.id === target.id).witness.acceptCode = "OTHER_GREEN";
    errorCode(() => validateManifest(graph, wrongWitness, { requirePairs: true, requireBaseline: false }), "CENSUS_MUTATION_WITNESS");

    const mixed = structuredClone(complete);
    mixed.entries.find((entry) => entry.id === target.id).rejectDeltaSet = [{
      id: "other",
      before: { accepted: false, code: "BEFORE" },
      after: { accepted: false, code: "AFTER" },
    }];
    errorCode(() => validateManifest(graph, mixed, { requirePairs: true, requireBaseline: false }), "CENSUS_MUTATION_OWNERSHIP");

    const regressing = structuredClone(complete);
    regressing.entries.find((entry) => entry.id === target.id).positiveRegressionSet = [{
      id: "positive",
      before: { accepted: true, code: "GREEN" },
      after: { accepted: false, code: "RED" },
    }];
    errorCode(() => validateManifest(graph, regressing, { requirePairs: true, requireBaseline: false }), "CENSUS_MUTATION_OWNERSHIP");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
