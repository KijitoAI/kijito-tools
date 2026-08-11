import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { replacementFor, repositorySnapshot } from "./n0-guard-mutation-runner.mjs";

function entry(source, mutation, overrides = {}) {
  return { id: "fixture:entry", source, mutation, ...overrides };
}

function rejectingCall(source, callee, operator = "suppress-thrown-rejection") {
  return entry(source, { operator }, { kind: "rejecting-helper-call", helper: callee });
}

function evaluateReplacement(source, bindings) {
  return Function(...Object.keys(bindings), `return (${source});`)(...Object.values(bindings));
}

test("suppress-thrown-rejection evaluates arguments outside try and the callee exactly once", () => {
  let argumentCalls = 0;
  let calleeCalls = 0;
  const replacement = replacementFor(rejectingCall("snapshotTree(argument())", "snapshotTree"));
  const result = evaluateReplacement(replacement, {
    argument() { argumentCalls += 1; return "root"; },
    snapshotTree(root) { calleeCalls += 1; assert.equal(root, "root"); throw new Error("callee rejection"); },
  });
  assert.equal(result, undefined);
  assert.equal(argumentCalls, 1);
  assert.equal(calleeCalls, 1);

  assert.throws(
    () => evaluateReplacement(replacement, {
      argument() { throw new Error("argument rejection"); },
      snapshotTree() { assert.fail("callee must not run when argument evaluation throws"); },
    }),
    /argument rejection/,
  );
});

test("suppress-thrown-rejection preserves success values and asynchronous rejection", async () => {
  const value = { schema: "N0_ROLLOUT_SNAPSHOT_V1" };
  const replacement = replacementFor(rejectingCall("snapshotTree(root)", "snapshotTree"));
  assert.equal(evaluateReplacement(replacement, { root: "/r", snapshotTree: () => value }), value);

  const rejected = Promise.reject(new Error("async rejection"));
  assert.equal(evaluateReplacement(replacement, { root: "/r", snapshotTree: () => rejected }), rejected);
  await assert.rejects(rejected, /async rejection/);
});

test("payload-free call operators reject wrong kinds, callees, optional/computed calls, spreads, and payloads", () => {
  for (const candidate of [
    entry("snapshotTree(root)", { operator: "suppress-thrown-rejection" }, { kind: "guard-atom", helper: "snapshotTree" }),
    rejectingCall("other(root)", "other"),
    rejectingCall("subject.snapshotTree(root)", "snapshotTree"),
    rejectingCall("subject[\"snapshotTree\"](root)", "snapshotTree"),
    rejectingCall("snapshotTree?.(root)", "snapshotTree"),
    rejectingCall("snapshotTree(...roots)", "snapshotTree"),
    rejectingCall("snapshotTree(root)", "different"),
    entry("evaluateOracle(specimen, evidence, nowMs)", { operator: "force-call-result-status", status: "N0_TEST_CAPABLE" }, { kind: "rejecting-helper-call", helper: "evaluateOracle" }),
  ]) assert.throws(() => replacementFor(candidate), /MUTATION_DIRECTION/);
});

test("suppress-thrown-rejection has an exact reviewed synchronous helper vocabulary", () => {
  const allowed = [
    "assertExactKeys",
    "main",
    "parseJsonBuffer",
    "readOwnedRegularFile",
    "renderPrompt",
    "requireNonce",
    "requireObject",
    "requirePathInside",
    "requireString",
    "snapshotTree",
    "validateEvidenceMeta",
  ];
  for (const callee of allowed) {
    assert.match(replacementFor(rejectingCall(`${callee}(value)`, callee)), new RegExp(`\\b${callee}\\(`));
  }
  assert.throws(() => replacementFor(rejectingCall("futureHelper(value)", "futureHelper")), /MUTATION_DIRECTION/);
});

test("force-call-result-status evaluates once and changes only status", () => {
  let calls = 0;
  const replacement = replacementFor(rejectingCall(
    "evaluateOracle(specimen, evidence, nowMs)",
    "evaluateOracle",
    "force-call-result-status",
  ));
  const result = evaluateReplacement(replacement, {
    specimen: {}, evidence: {}, nowMs: 1,
    evaluateOracle() { calls += 1; return { status: "RED", code: "X", detail: { retained: true } }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "N0_TEST_CAPABLE", code: "X", detail: { retained: true } });
});

test("bypass-rejection preserves verdict structure and changes only an owned negative status", () => {
  assert.equal(
    replacementFor(entry('verdict("RED", "CODE", detail)', { operator: "bypass-rejection" })),
    'verdict("N0_TEST_CAPABLE", "CODE", detail)',
  );
  assert.equal(
    replacementFor(entry('verdict("BLOCKED", code, detail)', { operator: "bypass-rejection" })),
    'verdict("N0_TEST_CAPABLE", code, detail)',
  );
  assert.equal(replacementFor(entry('fail("CODE", detail)', { operator: "bypass-rejection" })), "void 0");
});

test("verdict bypass rejects non-negative, computed, or different callees", () => {
  for (const source of [
    'verdict("N0_TEST_CAPABLE", "CODE", detail)',
    'verdict(status, "CODE", detail)',
  ]) {
    assert.throws(
      () => replacementFor(entry(source, { operator: "bypass-rejection" })),
      /MUTATION_DIRECTION/,
    );
  }
});

test("condition forcing emits only boolean literals", () => {
  assert.equal(replacementFor(entry("subject", { operator: "force-owned-condition", value: true })), "true");
  assert.equal(replacementFor(entry("subject", { operator: "force-owned-condition", value: false })), "false");
  assert.throws(
    () => replacementFor(entry("subject", { operator: "force-owned-condition", value: "false" })),
    /MUTATION_DIRECTION/,
  );
});

test("first-binding sanitizer requires the exact assignable first call argument", () => {
  assert.equal(
    replacementFor(entry("requireString(subject.value, code)", {
      operator: "sanitize-first-binding",
      binding: "subject.value",
      value: '"safe"',
    })),
    'subject.value = "safe"',
  );
  assert.throws(
    () => replacementFor(entry("requireString(subject.value, code)", {
      operator: "sanitize-first-binding",
      binding: "other.value",
      value: '"safe"',
    })),
    /MUTATION_DIRECTION/,
  );
  assert.throws(
    () => replacementFor(entry('requireString("literal", code)', {
      operator: "sanitize-first-binding",
      binding: '"literal"',
      value: '"safe"',
    })),
    /MUTATION_DIRECTION/,
  );
});

test("first-argument sanitizer preserves the callee and remaining arguments", () => {
  assert.equal(
    replacementFor(entry("parseValue(subject.text, options)", {
      operator: "sanitize-first-argument",
      value: 'subject.text.toString("utf8")',
    })),
    'parseValue(subject.text.toString("utf8"), options)',
  );
  assert.throws(
    () => replacementFor(entry("parseValue(subject.text, options)", {
      operator: "sanitize-first-argument",
      value: "(subject.text, options)",
    })),
    /MUTATION_DIRECTION/,
  );
  assert.throws(
    () => replacementFor(entry("parseValue(...values)", {
      operator: "sanitize-first-argument",
      value: '"safe"',
    })),
    /MUTATION_DIRECTION/,
  );
});

test("arbitrary and sequence-expression operators remain unrepresentable", () => {
  assert.throws(
    () => replacementFor(entry("subject", { operator: "replace-expression", expression: "true" })),
    /MUTATION_DIRECTION/,
  );
  assert.throws(
    () => replacementFor(entry("subject", { operator: "substitute-reviewed-expression", expression: "({})" })),
    /MUTATION_DIRECTION/,
  );
  assert.throws(
    () => replacementFor(entry("subject", { operator: "substitute-reviewed-expression", expression: "(void 0, true)" })),
    /MUTATION_DIRECTION/,
  );
});

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("primary invariance snapshot detects byte changes hidden behind unchanged dirty status", () => {
  const root = mkdtempSync(path.join(tmpdir(), "n0-primary-invariance-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "n0@example.invalid");
    git(root, "config", "user.name", "N0 Test");
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-qm", "base");

    writeFileSync(path.join(root, "tracked.txt"), "dirty-a\n");
    writeFileSync(path.join(root, "untracked.txt"), "untracked-a\n");
    const before = repositorySnapshot(root);
    writeFileSync(path.join(root, "tracked.txt"), "dirty-b\n");
    writeFileSync(path.join(root, "untracked.txt"), "untracked-b\n");
    const after = repositorySnapshot(root);

    assert.notEqual(after.worktreeDiffSha256, before.worktreeDiffSha256);
    assert.notEqual(after.untrackedSha256, before.untrackedSha256);
    assert.equal(after.statusSha256, before.statusSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("primary invariance snapshot captures dirty diffs larger than spawnSync's default buffer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "n0-primary-buffer-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "n0@example.invalid");
    git(root, "config", "user.name", "N0 Test");
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-qm", "base");
    writeFileSync(path.join(root, "tracked.txt"), `${"x".repeat(2 * 1024 * 1024)}\n`);
    const snapshot = repositorySnapshot(root);
    assert.match(snapshot.worktreeDiffSha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
