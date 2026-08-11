#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { analyzeGuardGraph, validateManifest } from "./n0-guard-census-core.mjs";
import { counterexampleUniverse, expectedPositiveCases } from "./n0-guard-counterexamples.mjs";
import { independentProjection } from "./n0-guard-independent-projection.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const manifestPath = path.join(here, "n0-guard-census.json");
const node = process.execPath;

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function run(args, cwd, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, N0_CENSUS_MUTATION_CHILD: "1" },
    timeout: options.timeout ?? 300_000,
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireGit(result) {
  if (result.status !== 0) fail("MUTATION_PRIMARY_GIT", result.stderr || result.stdout);
  return result.stdout;
}

export function repositorySnapshot(root) {
  const head = requireGit(run(["git", "rev-parse", "HEAD"], root));
  const status = requireGit(run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root));
  const indexDiff = requireGit(run(["git", "diff", "--cached", "--binary", "--no-ext-diff", "HEAD"], root));
  const worktreeDiff = requireGit(run(["git", "diff", "--binary", "--no-ext-diff"], root));
  const untracked = requireGit(run(["git", "ls-files", "--others", "--exclude-standard", "-z"], root))
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedHash = crypto.createHash("sha256");
  for (const relative of untracked) {
    const target = path.join(root, relative);
    const stat = fs.lstatSync(target);
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
    const content = kind === "symlink" ? fs.readlinkSync(target) : kind === "file" ? fs.readFileSync(target) : "";
    untrackedHash.update(`${Buffer.byteLength(relative)}:${relative}:${kind}:`);
    untrackedHash.update(content);
    untrackedHash.update("\0");
  }
  return {
    head,
    statusSha256: sha256(status),
    indexDiffSha256: sha256(indexDiff),
    worktreeDiffSha256: sha256(worktreeDiff),
    untrackedSha256: untrackedHash.digest("hex"),
  };
}

function primarySnapshot() {
  return repositorySnapshot(repo);
}

function assertPrimary(snapshot) {
  const after = primarySnapshot();
  if (JSON.stringify(after) !== JSON.stringify(snapshot)) fail("MUTATION_PRIMARY_CHANGED", "primary HEAD/index/worktree changed");
}

function copyTree(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const relative of ["package.json", "package-lock.json", "providers"]) {
    fs.cpSync(path.join(repo, relative), path.join(target, relative), { recursive: true, errorOnExist: false });
  }
  const acorn = path.join(repo, "node_modules/acorn");
  if (!fs.existsSync(acorn)) fail("MUTATION_DEPENDENCY", "node_modules/acorn is missing; run npm ci");
  fs.mkdirSync(path.join(target, "node_modules"), { recursive: true });
  fs.cpSync(acorn, path.join(target, "node_modules/acorn"), { recursive: true });
}

function aggregate(cwd) {
  const result = run([node, "providers/codex/n0-harness/manifest.mjs", "--json"], cwd);
  if (result.status !== 0) fail("MUTATION_AGGREGATE", result.stderr);
  return JSON.parse(result.stdout).aggregate;
}

function baseline(cwd, expectedAggregate) {
  if (aggregate(cwd) !== expectedAggregate) fail("MUTATION_COPY_DIGEST", "temp-copy aggregate differs from pinned origin");
  const result = run([node, "--test", "providers/codex/test/n0-harness.test.mjs", "providers/codex/test/n0-cli-refusal.test.mjs"], cwd);
  if (result.status !== 0 || !/^(?:#|ℹ) pass 28$/m.test(result.stdout) || !/^(?:#|ℹ) fail 0$/m.test(result.stdout)) {
    fail("MUTATION_BASELINE", `${result.stdout}\n${result.stderr}`);
  }
}

function matrix(cwd) {
  const result = run([node, "providers/codex/test/n0-guard-counterexamples.mjs", "--all"], cwd);
  if (result.status !== 0) fail("MUTATION_COUNTEREXAMPLE_MATRIX", result.stderr);
  return JSON.parse(result.stdout);
}

export function assertPristineMatrix(pristine, expectedPositive) {
  const actualPositive = {};
  for (const [id, result] of Object.entries(pristine)) {
    if (result?.crashed) fail("MUTATION_PRISTINE_CRASH", `${id}: ${JSON.stringify(result)}`);
    if (result?.accepted === true) actualPositive[id] = result.code;
    else if (result?.accepted !== false || typeof result.code !== "string" || result.code.length === 0) {
      fail("MUTATION_PRISTINE_RESULT", `${id}: ${JSON.stringify(result)}`);
    }
  }
  const orderedActual = Object.fromEntries(Object.entries(actualPositive).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const orderedExpected = Object.fromEntries(Object.entries(expectedPositive).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  if (JSON.stringify(orderedActual) !== JSON.stringify(orderedExpected)) {
    fail("MUTATION_POSITIVE_CORPUS", `expected=${JSON.stringify(expectedPositive)} actual=${JSON.stringify(actualPositive)}`);
  }
}

function oneExpression(source, label) {
  let expression;
  try {
    const program = parse(source, { ecmaVersion: "latest" });
    if (program.body.length !== 1 || program.body[0].type !== "ExpressionStatement") throw new Error("not one expression");
    expression = program.body[0].expression;
  } catch {
    fail("MUTATION_DIRECTION", `${label}: not one expression`);
  }
  return expression;
}

function originalCall(entry) {
  const expression = oneExpression(entry.source, entry.id);
  if (expression.type !== "CallExpression") fail("MUTATION_DIRECTION", `${entry.id}: sanitizer target is not a call`);
  return expression;
}

const SYNCHRONOUS_REJECTING_CALLEES = new Set([
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
]);

function payloadFreeStaticCall(entry, allowedCallees) {
  if (entry.kind !== "rejecting-helper-call") {
    fail("MUTATION_DIRECTION", `${entry.id}: payload-free call operator requires rejecting-helper-call`);
  }
  const call = originalCall(entry);
  if (call.optional === true || call.callee.type !== "Identifier" || !allowedCallees.has(call.callee.name)) {
    fail("MUTATION_DIRECTION", `${entry.id}: payload-free call operator requires an approved static callee`);
  }
  if (entry.helper !== call.callee.name) {
    fail("MUTATION_DIRECTION", `${entry.id}: analyzed callee does not match source`);
  }
  if (call.arguments.some((argument) => argument.type === "SpreadElement")) {
    fail("MUTATION_DIRECTION", `${entry.id}: payload-free call operator forbids spread arguments`);
  }
  return call;
}

function suppressThrownRejection(entry) {
  const call = payloadFreeStaticCall(entry, SYNCHRONOUS_REJECTING_CALLEES);
  const parameters = call.arguments.map((_, index) => `__n0_arg_${index}`);
  const argumentsSource = call.arguments.map((argument) => entry.source.slice(argument.start, argument.end));
  const invoke = `${call.callee.name}(${parameters.join(", ")})`;
  return `((${parameters.join(", ")}) => { try { return ${invoke}; } catch { return void 0; } })(${argumentsSource.join(", ")})`;
}

function forceCallResultStatus(entry) {
  const call = payloadFreeStaticCall(entry, new Set(["evaluateOracle"]));
  return `((__n0_result) => ({ ...__n0_result, status: "N0_TEST_CAPABLE" }))(${entry.source.slice(call.start, call.end)})`;
}

function boundedExpression(source, label) {
  let expression;
  try {
    const program = parse(`(${source})`, { ecmaVersion: "latest" });
    expression = program.body[0]?.expression;
    if (!expression) throw new Error("missing expression");
  } catch {
    fail("MUTATION_DIRECTION", `${label}: not one bounded expression`);
  }
  const forbidden = new Set(["AssignmentExpression", "UpdateExpression", "SequenceExpression", "ImportExpression", "AwaitExpression", "YieldExpression", "FunctionExpression", "ArrowFunctionExpression", "NewExpression"]);
  const stack = [expression];
  while (stack.length) {
    const current = stack.pop();
    if (forbidden.has(current.type)) fail("MUTATION_DIRECTION", `${label}: contains ${current.type}`);
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) stack.push(...value.filter((item) => item && typeof item.type === "string"));
      else if (value && typeof value.type === "string") stack.push(value);
    }
  }
  return expression;
}

export function replacementFor(entry) {
  const mutation = entry.mutation;
  if (["suppress-thrown-rejection", "force-call-result-status"].includes(mutation?.operator)) {
    if (Object.keys(mutation).sort().join(",") !== "operator") {
      fail("MUTATION_DIRECTION", `${entry.id}: payload-free operator contains manifest payload`);
    }
    if (mutation.operator === "suppress-thrown-rejection") return suppressThrownRejection(entry);
    return forceCallResultStatus(entry);
  }
  if (mutation?.operator === "bypass-rejection") {
    if (/^verdict\s*\(/.test(entry.source)) {
      const call = originalCall(entry);
      if (call.callee.type !== "Identifier" || call.callee.name !== "verdict") {
        fail("MUTATION_DIRECTION", `${entry.id}: verdict bypass has a different callee`);
      }
      const status = call.arguments[0];
      if (status?.type !== "Literal" || !["RED", "BLOCKED"].includes(status.value)) {
        fail("MUTATION_DIRECTION", `${entry.id}: verdict bypass does not own a negative status literal`);
      }
      return `${entry.source.slice(0, status.start)}"N0_TEST_CAPABLE"${entry.source.slice(status.end)}`;
    }
    return "void 0";
  }
  if (mutation?.operator === "force-owned-condition" && typeof mutation.value === "boolean") return String(mutation.value);
  if (mutation?.operator === "sanitize-first-binding") {
    const call = originalCall(entry);
    const first = call.arguments[0];
    if (!first) fail("MUTATION_DIRECTION", `${entry.id}: sanitizer call has no first argument`);
    const firstSource = entry.source.slice(first.start, first.end);
    if (mutation.binding !== firstSource) fail("MUTATION_DIRECTION", `${entry.id}: sanitizer binding is not the first argument`);
    if (!["Identifier", "MemberExpression"].includes(first.type) || first.optional === true) {
      fail("MUTATION_DIRECTION", `${entry.id}: sanitizer first argument is not an assignable static binding`);
    }
    boundedExpression(mutation.value, entry.id);
    const replacement = `${mutation.binding} = ${mutation.value}`;
    const assignment = oneExpression(replacement, entry.id);
    if (assignment.type !== "AssignmentExpression" || assignment.operator !== "=") {
      fail("MUTATION_DIRECTION", `${entry.id}: sanitizer did not produce one assignment`);
    }
    return replacement;
  }
  if (mutation?.operator === "sanitize-first-argument") {
    const call = originalCall(entry);
    const first = call.arguments[0];
    if (!first || first.type === "SpreadElement") {
      fail("MUTATION_DIRECTION", `${entry.id}: sanitizer call has no ordinary first argument`);
    }
    boundedExpression(mutation.value, entry.id);
    const replacement = `${entry.source.slice(0, first.start)}${mutation.value}${entry.source.slice(first.end)}`;
    const mutated = originalCall({ ...entry, source: replacement });
    if (mutated.arguments.length !== call.arguments.length
      || replacement.slice(mutated.callee.start, mutated.callee.end) !== entry.source.slice(call.callee.start, call.callee.end)) {
      fail("MUTATION_DIRECTION", `${entry.id}: first-argument sanitizer changed call structure`);
    }
    return replacement;
  }
  if (mutation?.operator === "drop-reviewed-property") {
    const call = originalCall(entry);
    const first = call.arguments[0];
    if (!first) fail("MUTATION_DIRECTION", `${entry.id}: delete call has no first argument`);
    const firstSource = entry.source.slice(first.start, first.end);
    if (!(mutation.target.startsWith(`${firstSource}.`) || mutation.target.startsWith(`${firstSource}[`))) {
      fail("MUTATION_DIRECTION", `${entry.id}: deleted property is not rooted at the first argument`);
    }
    oneExpression(`delete ${mutation.target}`, entry.id);
    return `delete ${mutation.target}`;
  }
  fail("MUTATION_DIRECTION", `${entry.id}: unknown declarative operator`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function changedCases(pristine, mutant) {
  const acceptFlipSet = [];
  const rejectDeltaSet = [];
  const positiveRegressionSet = [];
  for (const id of Object.keys(pristine).sort()) {
    const before = canonical(pristine[id]);
    const after = canonical(mutant[id]);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before?.accepted === false && !before?.crashed && after?.accepted === true && !after?.crashed) {
      acceptFlipSet.push({ id, rejectCode: before.code, acceptCode: after.code });
      continue;
    }
    const delta = { id, before, after };
    if (before?.accepted === true) positiveRegressionSet.push(delta);
    else rejectDeltaSet.push(delta);
  }
  return { acceptFlipSet, rejectDeltaSet, positiveRegressionSet };
}

function mutationKey(entry, actual) {
  return JSON.stringify({ file: actual.file, start: actual.start, end: actual.end, replacement: replacementFor(entry) });
}

export function applyMutations(root, edits) {
  const byFile = new Map();
  for (const edit of edits) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push(edit);
  }
  const originals = new Map();
  for (const [relative, fileEdits] of byFile) {
    const file = path.join(root, "providers/codex/n0-harness", relative);
    let source = fs.readFileSync(file, "utf8");
    originals.set(file, source);
    for (const edit of fileEdits.sort((a, b) => b.start - a.start)) {
      source = `${source.slice(0, edit.start)}${edit.replacement}${source.slice(edit.end)}`;
    }
    fs.writeFileSync(file, source);
  }
  return () => { for (const [file, source] of originals) fs.writeFileSync(file, source); };
}

function graphEntry(graph, id) {
  const entry = graph.entries.find((candidate) => candidate.id === id);
  if (!entry) fail("MUTATION_ANCHOR", id);
  return entry;
}

function ownershipKind(partitions) {
  if (partitions.acceptFlipSet.length > 0 && partitions.rejectDeltaSet.length > 0) return "mixed-ownership";
  if (partitions.acceptFlipSet.length > 0) return "normal-ownership";
  if (partitions.rejectDeltaSet.length > 0) return "reject-preserving-ownership";
  return null;
}

function witnessFor(partitions) {
  if (partitions.acceptFlipSet.length > 0) {
    return { partition: "acceptFlipSet", ...partitions.acceptFlipSet[0] };
  }
  if (partitions.rejectDeltaSet.length > 0) {
    const first = partitions.rejectDeltaSet[0];
    return {
      partition: "rejectDeltaSet",
      id: first.id,
      beforeCode: first.before.code,
      afterCode: first.after.code,
    };
  }
  return null;
}

function exactOwnership(entry, actual) {
  for (const partition of ["acceptFlipSet", "rejectDeltaSet", "positiveRegressionSet"]) {
    if (JSON.stringify(entry[partition]) !== JSON.stringify(actual[partition])) {
      fail("MUTATION_PARTITION_MISMATCH", `${entry.id} ${partition}: declared=${JSON.stringify(entry[partition])} actual=${JSON.stringify(actual[partition])}`);
    }
  }
  if (actual.positiveRegressionSet.length > 0) {
    fail("MUTATION_POSITIVE_REGRESSION", `${entry.id}: ${JSON.stringify(actual.positiveRegressionSet)}`);
  }
  const kind = ownershipKind(actual);
  if (entry.ownershipRecord?.kind !== kind || JSON.stringify(entry.witness) !== JSON.stringify(witnessFor(actual))) {
    fail("MUTATION_ATTRIBUTION", `${entry.id}: ownership mode or witness differs from measured partitions`);
  }
}

export function assertDiscriminatingPair(entry, pristine, mutant) {
  const witness = entry.witness;
  if (witness?.partition !== "acceptFlipSet" || pristine.accepted || pristine.code !== witness.rejectCode) {
    fail("MUTATION_PRISTINE_PAIR", `${entry.id}: ${JSON.stringify(pristine)}`);
  }
  if (!mutant.accepted || mutant.code !== witness.acceptCode) {
    fail("MUTATION_NOT_DISCRIMINATED", `${entry.id}: ${JSON.stringify(mutant)}`);
  }
}

function runBattery() {
  if (process.env.N0_CENSUS_MUTATION_CHILD === "1") fail("MUTATION_RECURSION", "runner cannot run inside a mutation child");
  const derive = process.argv.includes("--derive-flipsets");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sourceRoot = path.join(repo, "providers/codex/n0-harness");
  const originGraph = analyzeGuardGraph(sourceRoot);
  const projection = independentProjection(sourceRoot);
  validateManifest(originGraph, manifest, { requirePairs: !derive, projection, counterexamples: counterexampleUniverse() });
  const primary = primarySnapshot();
  const expectedAggregate = aggregate(repo);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "n0-guard-mutation."));
  const derived = new Map();
  let uniqueMutationsExecuted = 0;
  let redundancyDispositionsVerified = 0;
  let compoundUnitsVerified = 0;
  let compoundMembersVerified = 0;
  let sameCodeShadowsVerified = 0;
  let downstreamDomainShadowsVerified = 0;
  try {
    copyTree(temp);
    baseline(temp, expectedAggregate);
    const pristine = matrix(temp);
    assertPristineMatrix(pristine, expectedPositiveCases());
    const cleanGraph = analyzeGuardGraph(path.join(temp, "providers/codex/n0-harness"));
    const mutable = manifest.entries.filter((entry) => entry.mutation);
    const groups = new Map();
    for (const entry of mutable) {
      const actual = graphEntry(cleanGraph, entry.id);
      const key = mutationKey(entry, actual);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ entry, actual });
    }
    for (const group of groups.values()) {
      const edits = [{ ...group[0].actual, replacement: replacementFor(group[0].entry) }];
      const restore = applyMutations(temp, edits);
      const mutant = matrix(temp);
      const partitions = changedCases(pristine, mutant);
      uniqueMutationsExecuted += 1;
      for (const { entry } of group) {
        if (derive) derived.set(entry.id, partitions);
        else exactOwnership(entry, partitions);
      }
      restore();
      if (aggregate(temp) !== expectedAggregate) fail("MUTATION_RESTORE", group[0].entry.id);
    }
    if (!derive) {
      for (const entry of manifest.entries.filter((candidate) => candidate.ownershipRecord?.kind === "same-code-shadow")) {
        const actual = graphEntry(cleanGraph, entry.id);
        const witness = pristine[entry.ownershipRecord.witnessId];
        if (!witness || witness.accepted || witness.code !== entry.ownershipRecord.rejectCode) {
          fail("MUTATION_SHADOW_PRISTINE", `${entry.id}:${JSON.stringify(witness)}`);
        }
        const restore = applyMutations(temp, [{
          ...actual,
          replacement: replacementFor({ ...entry, mutation: entry.ownershipRecord.canonicalMutation }),
        }]);
        const mutant = matrix(temp);
        restore();
        if (JSON.stringify(mutant) !== JSON.stringify(pristine)) {
          fail("MUTATION_SHADOW_DELTA", entry.id);
        }
        sameCodeShadowsVerified += 1;
      }
      for (const entry of manifest.entries.filter((candidate) => candidate.ownershipRecord?.kind === "downstream-domain-shadow")) {
        const actual = graphEntry(cleanGraph, entry.id);
        const record = entry.ownershipRecord;
        const witness = pristine[record.witnessId];
        if (!witness || witness.accepted || witness.code !== "CANARY_MISSING") {
          fail("MUTATION_DOWNSTREAM_DOMAIN_PRISTINE", `${entry.id}:${JSON.stringify(witness)}`);
        }
        const canonicalRestore = applyMutations(temp, [{
          ...actual,
          replacement: replacementFor({ ...entry, mutation: record.canonicalMutation }),
        }]);
        const canonical = matrix(temp);
        canonicalRestore();
        if (JSON.stringify(canonical) !== JSON.stringify(pristine)) {
          fail("MUTATION_DOWNSTREAM_DOMAIN_DELTA", entry.id);
        }
        const activeRestore = applyMutations(temp, [
          {
            ...actual,
            replacement: replacementFor({ ...entry, mutation: record.canonicalMutation }),
          },
          {
            file: record.catchReturn.file,
            start: record.catchReturn.start,
            end: record.catchReturn.end,
            replacement: 'throw new Error("N0_DOWNSTREAM_DOMAIN_SHADOW_ACTIVE");',
          },
        ]);
        const active = matrix(temp)[record.witnessId];
        activeRestore();
        if (!active?.crashed || active.code !== "Error" || active.message !== "N0_DOWNSTREAM_DOMAIN_SHADOW_ACTIVE") {
          fail("MUTATION_DOWNSTREAM_DOMAIN_INACTIVE", `${entry.id}:${JSON.stringify(active)}`);
        }
        downstreamDomainShadowsVerified += 1;
      }
      for (const compound of manifest.compounds) {
        const pristineWitness = pristine[compound.witness.id];
        if (!pristineWitness || pristineWitness.accepted || pristineWitness.code !== compound.witness.rejectCode) {
          fail("MUTATION_COMPOUND_PRISTINE", `${compound.id}:${JSON.stringify(pristineWitness)}`);
        }
        for (const edit of compound.edits) {
          const target = manifest.entries.find((entry) => entry.id === edit.entryId);
          const actual = graphEntry(cleanGraph, edit.entryId);
          const restore = applyMutations(temp, [{
            ...actual,
            replacement: replacementFor({ ...target, mutation: edit.mutation }),
          }]);
          const single = matrix(temp)[compound.witness.id];
          restore();
          if (JSON.stringify(single) !== JSON.stringify(pristineWitness)) {
            fail("MUTATION_COMPOUND_SINGLE", `${compound.id}:${edit.entryId}:${JSON.stringify(single)}`);
          }
        }
        const edits = compound.edits.map((edit) => {
          const target = manifest.entries.find((entry) => entry.id === edit.entryId);
          const actual = graphEntry(cleanGraph, edit.entryId);
          return { ...actual, replacement: replacementFor({ ...target, mutation: edit.mutation }) };
        });
        const restore = applyMutations(temp, edits);
        const combined = matrix(temp)[compound.witness.id];
        restore();
        if (!combined.accepted || combined.code !== compound.witness.acceptCode) {
          fail("MUTATION_COMPOUND_PAIR", `${compound.id}:${JSON.stringify(combined)}`);
        }
        compoundUnitsVerified += 1;
        compoundMembersVerified += compound.memberIds.length;
      }
      for (const entry of manifest.entries.filter((candidate) => candidate.disposition?.kind === "not-independently-discriminated")) {
        const actual = graphEntry(cleanGraph, entry.id);
        const singleRestore = applyMutations(temp, [{ ...actual, replacement: replacementFor({ ...entry, mutation: entry.disposition.mutation }) }]);
        const single = matrix(temp)[entry.disposition.witness.id];
        singleRestore();
        const pristineWitness = pristine[entry.disposition.witness.id];
        if (JSON.stringify(single) !== JSON.stringify(pristineWitness)
          || pristineWitness.accepted || pristineWitness.code !== entry.disposition.witness.rejectCode) {
          fail("MUTATION_DISPOSITION_SINGLE", entry.id);
        }
        const compoundEntries = [entry, ...entry.disposition.coveredBy.map((id) => manifest.entries.find((candidate) => candidate.id === id))];
        const edits = compoundEntries.map((candidate) => {
          if (!candidate) fail("MUTATION_DISPOSITION_COVER", entry.id);
          const candidateActual = graphEntry(cleanGraph, candidate.id);
          const mutation = candidate.id === entry.id ? entry.disposition.mutation : candidate.mutation;
          return { ...candidateActual, replacement: replacementFor({ ...candidate, mutation }) };
        });
        const restore = applyMutations(temp, edits);
        const compound = matrix(temp)[entry.disposition.witness.id];
        restore();
        if (!compound.accepted || compound.code !== entry.disposition.witness.acceptCode) fail("MUTATION_DISPOSITION_COMPOUND", entry.id);
        redundancyDispositionsVerified += 1;
      }
    }
    baseline(temp, expectedAggregate);
    assertPrimary(primary);
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } finally {
      assertPrimary(primary);
    }
  }
  if (derive) {
    const positiveRegressionEntries = [...derived.entries()]
      .filter(([, partitions]) => partitions.positiveRegressionSet.length > 0)
      .map(([id, partitions]) => ({ id, positiveRegressionSet: partitions.positiveRegressionSet }));
    if (positiveRegressionEntries.length > 0) {
      fail("MUTATION_POSITIVE_REGRESSION", JSON.stringify(positiveRegressionEntries));
    }
    for (const entry of manifest.entries) {
      if (!derived.has(entry.id)) continue;
      const partitions = derived.get(entry.id);
      entry.acceptFlipSet = partitions.acceptFlipSet;
      entry.rejectDeltaSet = partitions.rejectDeltaSet;
      entry.positiveRegressionSet = partitions.positiveRegressionSet;
      entry.witness = witnessFor(partitions);
      const kind = ownershipKind(partitions);
      entry.ownershipRecord = kind ? { kind } : null;
    }
    const derivedCounts = {
      rejectPreservingOwnership: manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "reject-preserving-ownership").length,
      mixedOwnership: manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "mixed-ownership").length,
    };
    manifest.floors.ownershipCounts ??= derivedCounts;
    manifest.floors.ownershipGrowthReasons ??= {};
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const normalOwnership = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "normal-ownership").length;
    const rejectPreservingOwnership = derivedCounts.rejectPreservingOwnership;
    const mixedOwnership = derivedCounts.mixedOwnership;
    const zeroDeltaEntries = [...derived.values()].filter((result) => ownershipKind(result) === null).length;
    const successOwnershipRecords = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "owned-success").length;
    process.stdout.write(`N0_GUARD_PARTITION_AUTHOR_GREEN normalOwnership=${normalOwnership} rejectPreservingOwnership=${rejectPreservingOwnership} mixedOwnership=${mixedOwnership} successOwnershipRecords=${successOwnershipRecords} zeroDeltaEntries=${zeroDeltaEntries} uniqueMutationsExecuted=${uniqueMutationsExecuted}\n`);
    return;
  }
  const normalOwnership = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "normal-ownership").length;
  const rejectPreservingOwnership = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "reject-preserving-ownership").length;
  const mixedOwnership = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "mixed-ownership").length;
  const successOwnershipRecords = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "owned-success").length;
  process.stdout.write(`N0_GUARD_MUTATION_GREEN normalOwnership=${normalOwnership} rejectPreservingOwnership=${rejectPreservingOwnership} mixedOwnership=${mixedOwnership} successOwnershipRecords=${successOwnershipRecords} sameCodeShadowsVerified=${sameCodeShadowsVerified} downstreamDomainShadowsVerified=${downstreamDomainShadowsVerified} compoundUnitsVerified=${compoundUnitsVerified} compoundMembersVerified=${compoundMembersVerified} uniqueMutationsExecuted=${uniqueMutationsExecuted} redundancyDispositionsVerified=${redundancyDispositionsVerified} aggregate=${expectedAggregate}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { runBattery(); }
  catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
