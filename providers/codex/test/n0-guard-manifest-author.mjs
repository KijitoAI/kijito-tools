#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "n0-guard-census.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const PAYLOAD_FREE_OPERATORS = new Map(Object.entries({
  "cli.mjs:36:44:rejecting-helper-call:674bf493f8036d66": "suppress-thrown-rejection",
  "cli.mjs:42:22:rejecting-helper-call:3168111b49061320": "suppress-thrown-rejection",
  "cli.mjs:42:38:rejecting-helper-call:76622647f598b656": "suppress-thrown-rejection",
  "cli.mjs:43:22:rejecting-helper-call:ae44c6cc219d62f9": "suppress-thrown-rejection",
  "cli.mjs:43:38:rejecting-helper-call:c2fc2cee0a0f64b5": "suppress-thrown-rejection",
  "cli.mjs:45:20:rejecting-helper-call:ebdff9a32fcc066b": "force-call-result-status",
  "evidence-manifest.mjs:31:28:rejecting-helper-call:423e405b2da9b7fd": "suppress-thrown-rejection",
  "lib.mjs:97:20:rejecting-helper-call:b3bed58f42c6ee8c": "suppress-thrown-rejection",
  "lib.mjs:105:3:rejecting-helper-call:7f37de2cf456b629": "bypass-rejection",
  "oracle.mjs:362:27:rejecting-helper-call:ccf1ae04a417cc27": "suppress-thrown-rejection",
  "lib.mjs:55:3:rejecting-helper-call:9431c6ae92b05bf5": "suppress-thrown-rejection",
  "oracle.mjs:81:17:rejecting-helper-call:74d6da1d9a547734": "suppress-thrown-rejection",
  "oracle.mjs:98:18:rejecting-helper-call:72e6f71373cc02a2": "suppress-thrown-rejection",
  "oracle.mjs:106:22:rejecting-helper-call:a09692553a3b4d79": "suppress-thrown-rejection",
  "oracle.mjs:120:20:rejecting-helper-call:ff6a25b01f60ae5b": "suppress-thrown-rejection",
  "oracle.mjs:128:17:rejecting-helper-call:19670ead0eddfacf": "suppress-thrown-rejection",
  "oracle.mjs:165:19:rejecting-helper-call:47055976d70dcbe6": "suppress-thrown-rejection",
  "oracle.mjs:177:17:rejecting-helper-call:4cfcd52300a3b9c3": "suppress-thrown-rejection",
  "oracle.mjs:189:19:rejecting-helper-call:d1a33bb56cfd0cb8": "suppress-thrown-rejection",
  "oracle.mjs:193:20:rejecting-helper-call:0378081cd7a677a4": "suppress-thrown-rejection",
  "oracle.mjs:215:18:rejecting-helper-call:395a93f673d3332a": "suppress-thrown-rejection",
  "oracle.mjs:223:3:rejecting-helper-call:8bbe25ad570a6758": "suppress-thrown-rejection",
  "oracle.mjs:242:23:rejecting-helper-call:421568a92598c2d1": "suppress-thrown-rejection",
  "oracle.mjs:292:3:rejecting-helper-call:2563493bf86065c7": "suppress-thrown-rejection",
  "oracle.mjs:299:19:rejecting-helper-call:d2913eb550ea3c08": "suppress-thrown-rejection",
  "oracle.mjs:304:5:rejecting-helper-call:47fc1e277b4ab20d": "suppress-thrown-rejection",
  "oracle.mjs:430:3:rejecting-helper-call:0e82521959067f2f": "suppress-thrown-rejection",
  "oracle.mjs:442:3:rejecting-helper-call:2a68a40248bfc7d8": "suppress-thrown-rejection",
  "prompt.mjs:8:17:rejecting-helper-call:5311a80d2d36ba75": "suppress-thrown-rejection",
  "cli.mjs:54:3:rejecting-helper-call:25482116c496f993": "suppress-thrown-rejection",
  "parser.mjs:109:52:rejecting-helper-call:24633b97fa21810f": "suppress-thrown-rejection",
  "specimen.mjs:9:18:rejecting-helper-call:e2f8125b417f7ed0": "suppress-thrown-rejection",
}));

const BYPASS_ENTRIES = new Set([
  "cli.mjs:9:3:exit-status-site:1fc28e7745de9012",
  "cli.mjs:47:46:exit-status-site:7e283b07214cfa3b",
  "cli.mjs:57:3:exit-status-site:7e283b07214cfa3b",
  "evidence-manifest.mjs:27:97:rejection-site:740028662f63c4e4",
  "snapshot.mjs:64:9:rejecting-helper-call:37287c78f93753ad",
]);

const FORCE_OWNED_CONDITIONS = new Map(Object.entries({
  "cli.mjs:31:7:guard-atom:26c91edf4fd94e26": false,
  "cli.mjs:31:24:guard-atom:63045e284c19263b": false,
  "evidence-manifest.mjs:27:38:guard-atom:69fa47ef158a2145": false,
  "evidence-manifest.mjs:27:59:guard-atom:aeef6579f5981cc3": false,
  "lib.mjs:95:7:guard-atom:703d241562495f56": false,
  "lib.mjs:99:7:guard-atom:b8c975ed7df43f77": false,
  "lib.mjs:100:7:guard-atom:879684b9778da4d6": false,
  "oracle.mjs:93:7:guard-atom:2aca57d142ee35bb": false,
  "oracle.mjs:175:9:guard-atom:a30803d547c6841d": false,
  "oracle.mjs:313:7:guard-atom:e3c481736ae16a55": false,
  "oracle.mjs:329:9:guard-atom:1a9495640d1fc0ed": false,
  "parser.mjs:19:7:guard-atom:d958fd86ec515ca0": false,
  "snapshot.mjs:49:7:guard-atom:703d241562495f56": false,
  "snapshot.mjs:59:11:guard-atom:b8c975ed7df43f77": false,
  "lib.mjs:82:92:predicate-atom:4542f69c79c1c3b7": true,
  "oracle.mjs:230:7:predicate-atom:c501cea746d8b024": false,
  "oracle.mjs:230:17:predicate-atom:e052cf82d87a7ce7": false,
  "oracle.mjs:237:10:predicate-atom:9fc1043699bdb5fa": true,
  "oracle.mjs:237:44:predicate-atom:a9035cd3a7d97ea6": true,
}));

const SHARED_CONTEXT_PREDICATE_ATOMS = new Set([
  "lib.mjs:22:10:predicate-atom:b579cf79ff684260",
  "lib.mjs:22:28:predicate-atom:f13c9e45b40ad616",
  "lib.mjs:82:10:predicate-atom:b7fc7b5f4fb78cb6",
  "lib.mjs:82:30:predicate-atom:d8edadc88ffeb3ca",
]);

const SAME_CODE_SHADOW_WITNESSES = new Map(Object.entries({
  "oracle.mjs:81:17:rejecting-helper-call:74d6da1d9a547734": "oracle.specimen.paths-object",
  "oracle.mjs:98:18:rejecting-helper-call:72e6f71373cc02a2": "oracle.specimen.target-object",
  "oracle.mjs:106:22:rejecting-helper-call:a09692553a3b4d79": "oracle.specimen.permission-object",
  "oracle.mjs:177:17:rejecting-helper-call:4cfcd52300a3b9c3": "oracle.specimen.clock-object",
  "oracle.mjs:189:19:rejecting-helper-call:d1a33bb56cfd0cb8": "oracle.rollout.object",
  "oracle.mjs:193:20:rejecting-helper-call:0378081cd7a677a4": "oracle.rollout.snapshot-object",
  "oracle.mjs:215:18:rejecting-helper-call:395a93f673d3332a": "oracle.rollout.parser-object",
  "oracle.mjs:223:3:rejecting-helper-call:8bbe25ad570a6758": "oracle.versions.object",
  "oracle.mjs:242:23:rejecting-helper-call:421568a92598c2d1": "oracle.environment.object",
  "oracle.mjs:292:3:rejecting-helper-call:2563493bf86065c7": "oracle.permission.object",
  "oracle.mjs:430:3:rejecting-helper-call:0e82521959067f2f": "oracle.meta.object",
}));

const DOWNSTREAM_DOMAIN_SHADOW_WITNESSES = new Map(Object.entries({
  "oracle.mjs:230:7:predicate-atom:c501cea746d8b024": "oracle.canary.value-null",
  "oracle.mjs:230:17:predicate-atom:e052cf82d87a7ce7": "oracle.canary.value-primitive",
}));

const SUCCESS_PATH_CALLS = new Set([
  "fixture.mjs:64:20:rejecting-helper-call:5ee8fe818d227757",
  "fixture.mjs:116:18:rejecting-helper-call:e2f8125b417f7ed0",
  "fixture.mjs:175:44:rejecting-helper-call:891243e1c000198e",
  "fixture.mjs:220:54:rejecting-helper-call:891243e1c000198e",
  "fixture.mjs:232:44:rejecting-helper-call:891243e1c000198e",
  "fixture.mjs:252:17:rejecting-helper-call:107da86911fcb8d4",
  "oracle.mjs:175:25:rejecting-helper-call:e2f8125b417f7ed0",
]);

const DELEGATED_OUTCOME_CALLS = new Set([
  "cli.mjs:28:18:rejecting-helper-call:2abc5cf6881921c3",
]);

const COMPOUNDS = [
  {
    id: "snapshot-catch-triad",
    witness: { id: "snapshot.stable.error", rejectCode: "SNAPSHOT_SCHEMA", acceptCode: "SNAPSHOT_STABLE_ACCEPTED" },
    memberIds: [
      "snapshot.mjs:116:9:guard-atom:b1e4b91352b7dd37",
      "snapshot.mjs:116:35:rejection-site:8c468a57ba68bc74",
      "snapshot.mjs:117:5:rejection-site:8c468a57ba68bc74",
    ],
    edits: [
      { entryId: "snapshot.mjs:116:9:guard-atom:b1e4b91352b7dd37", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "snapshot.mjs:116:35:rejection-site:8c468a57ba68bc74", mutation: { operator: "bypass-rejection" } },
      { entryId: "snapshot.mjs:117:5:rejection-site:8c468a57ba68bc74", mutation: { operator: "bypass-rejection" } },
    ],
  },
  {
    id: "run-binding-triad",
    witness: { id: "oracle.case.run-binding-type", rejectCode: "RUN_BINDING", acceptCode: "ALL_SYNTHETIC_EVIDENCE_GREEN" },
    memberIds: [
      "oracle.mjs:336:9:guard-atom:427adbe36f06b655",
      "oracle.mjs:336:52:guard-atom:affdb92192535a0b",
      "oracle.mjs:337:73:guard-atom:78af6b5e91c052a0",
    ],
    edits: [
      { entryId: "oracle.mjs:336:9:guard-atom:427adbe36f06b655", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "oracle.mjs:336:52:guard-atom:affdb92192535a0b", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "oracle.mjs:337:73:guard-atom:78af6b5e91c052a0", mutation: { operator: "force-owned-condition", value: false } },
    ],
  },
  {
    id: "receipt-binding-triad",
    witness: { id: "oracle.case.receipt-binding-type", rejectCode: "RECEIPT_BINDING", acceptCode: "ALL_SYNTHETIC_EVIDENCE_GREEN" },
    memberIds: [
      "oracle.mjs:341:9:guard-atom:eadf0ac86ffaaedb",
      "oracle.mjs:341:49:guard-atom:7c1048938de29511",
      "oracle.mjs:342:70:guard-atom:b20ab6539939ae8b",
    ],
    edits: [
      { entryId: "oracle.mjs:341:9:guard-atom:eadf0ac86ffaaedb", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "oracle.mjs:341:49:guard-atom:7c1048938de29511", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "oracle.mjs:342:70:guard-atom:b20ab6539939ae8b", mutation: { operator: "force-owned-condition", value: false } },
    ],
  },
  {
    id: "nonce-cardinality-pair",
    witness: { id: "parser.nonce.multiple-turns", rejectCode: "NONCE_USER_SPAN", acceptCode: "NONCE_ACCEPTED" },
    memberIds: ["parser.mjs:64:22:guard-atom:4606e22e0103c3b5"],
    edits: [
      { entryId: "parser.mjs:64:7:guard-atom:fd65b3c7d7d3dee5", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "parser.mjs:64:22:guard-atom:4606e22e0103c3b5", mutation: { operator: "force-owned-condition", value: false } },
    ],
  },
  {
    id: "lib-root-kind-pair",
    witness: { id: "lib.read.root-symlink", rejectCode: "ROOT_INVALID", acceptCode: "READ_FILE_ACCEPTED" },
    memberIds: ["lib.mjs:95:7:guard-atom:703d241562495f56"],
    edits: [
      { entryId: "lib.mjs:95:7:guard-atom:703d241562495f56", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "lib.mjs:95:36:guard-atom:ce1efc18573feb2c", mutation: { operator: "force-owned-condition", value: false } },
    ],
  },
  {
    id: "snapshot-root-kind-pair",
    witness: { id: "snapshot.root.symlink", rejectCode: "SNAPSHOT_ROOT_INVALID", acceptCode: "SNAPSHOT_ACCEPTED" },
    memberIds: ["snapshot.mjs:49:7:guard-atom:703d241562495f56"],
    edits: [
      { entryId: "snapshot.mjs:49:7:guard-atom:703d241562495f56", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "snapshot.mjs:49:36:guard-atom:ce1efc18573feb2c", mutation: { operator: "force-owned-condition", value: false } },
    ],
  },
  {
    id: "case-status-null-pair",
    witness: { id: "oracle.case.status-null", rejectCode: "CASE_EVIDENCE_INVALID", acceptCode: "ALL_SYNTHETIC_EVIDENCE_GREEN" },
    memberIds: ["oracle.mjs:329:9:guard-atom:1a9495640d1fc0ed"],
    edits: [
      { entryId: "oracle.mjs:329:9:guard-atom:1a9495640d1fc0ed", mutation: { operator: "force-owned-condition", value: false } },
      { entryId: "oracle.mjs:329:19:guard-atom:9c88b773e2a1b75a", mutation: { operator: "force-owned-condition", value: false } },
    ],
  },
];

const FIRST_ARGUMENT_SANITIZERS = new Map(Object.entries({
  "oracle.mjs:189:19:rejecting-helper-call:d1a33bb56cfd0cb8": "JSON.parse(specimen.rollout)",
  "oracle.mjs:193:20:rejecting-helper-call:0378081cd7a677a4": "JSON.parse(rollout.preActionSnapshot)",
  "oracle.mjs:215:18:rejecting-helper-call:395a93f673d3332a": "JSON.parse(rollout.parser)",
  "oracle.mjs:299:19:rejecting-helper-call:d2913eb550ea3c08": "JSON.parse(evidence.canaryResults)",
  "parser.mjs:41:19:rejecting-helper-call:d3df82140ecfc7d0": JSON.stringify('{"type":"session_meta","payload":{"id":"sanitized"}}\n'),
  "parser.mjs:77:22:rejecting-helper-call:4559b1577e5654c7": 'candidate.text.toString("utf8")',
  "parser.mjs:107:18:rejecting-helper-call:04f6cdc8d3d1a5f8": 'rolloutText.toString("utf8")',
  "parser.mjs:119:19:rejecting-helper-call:e792f84ed71527f6": '[{ type: "turn_context", payload: { turn_id: expected.turnId, ...expected.environment } }]',
  "prompt.mjs:42:29:rejecting-helper-call:0f93f1bf1d83d8ce": '({ ...specimen, cases: { ...specimen.cases, [caseName]: { ...specimen.cases[caseName], nonce: "a".repeat(32) } } })',
  "snapshot.mjs:113:21:rejecting-helper-call:7613fc44bd316ea4": "current",
  "specimen.mjs:12:10:rejecting-helper-call:d808855d1bc13c94": "({ ...specimen, target: { ...specimen.target, clean: true } })",
}));

function expression(source) {
  const program = parse(source, { ecmaVersion: "latest" });
  if (program.body.length !== 1 || program.body[0].type !== "ExpressionStatement") throw new Error(`not one expression: ${source}`);
  return program.body[0].expression;
}

function convertMutation(entry) {
  const prior = entry.mutation;
  if (!prior || prior.operator) return;
  if (prior.kind === "structural-only") {
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.ownershipRecord = { kind: "owned-success", reason: "the sole N0_TEST_CAPABLE return constructor" };
    return;
  }
  if (prior.kind === "replace-node") {
    if (prior.replacement === "void 0") entry.mutation = { operator: "bypass-rejection" };
    else if (["false", "true"].includes(prior.replacement)) entry.mutation = { operator: "force-owned-condition", value: prior.replacement === "true" };
    else throw new Error(`unsupported node mutation ${entry.id}: ${prior.replacement}`);
    return;
  }
  if (prior.kind !== "replace-expression") throw new Error(`unsupported mutation kind ${entry.id}: ${prior.kind}`);
  const parsed = expression(prior.replacement);
  if (parsed.type === "AssignmentExpression" && parsed.operator === "=") {
    entry.mutation = {
      operator: "sanitize-first-binding",
      binding: prior.replacement.slice(parsed.left.start, parsed.left.end),
      value: prior.replacement.slice(parsed.right.start, parsed.right.end),
    };
  } else if (parsed.type === "UnaryExpression" && parsed.operator === "delete") {
    entry.mutation = { operator: "drop-reviewed-property", target: prior.replacement.slice(parsed.argument.start, parsed.argument.end) };
  } else {
    entry.mutation = { operator: "substitute-reviewed-expression", expression: prior.replacement };
  }
}

for (const entry of manifest.entries) {
  convertMutation(entry);
  if (BYPASS_ENTRIES.has(entry.id)) {
    entry.mutation = { operator: "bypass-rejection" };
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.ownershipRecord = null;
  }
  if (FORCE_OWNED_CONDITIONS.has(entry.id)) {
    entry.mutation = { operator: "force-owned-condition", value: FORCE_OWNED_CONDITIONS.get(entry.id) };
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.ownershipRecord = null;
  }
  if (FIRST_ARGUMENT_SANITIZERS.has(entry.id)) {
    entry.mutation = { operator: "sanitize-first-argument", value: FIRST_ARGUMENT_SANITIZERS.get(entry.id) };
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.ownershipRecord = null;
  }
  if (PAYLOAD_FREE_OPERATORS.has(entry.id)) {
    entry.mutation = { operator: PAYLOAD_FREE_OPERATORS.get(entry.id) };
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.ownershipRecord = null;
  }
  if (SHARED_CONTEXT_PREDICATE_ATOMS.has(entry.id)) {
    const proof = manifest.baseline?.sharedContextPredicates?.find((item) => item.predicate === entry.predicate);
    if (!proof?.atomIds?.includes(entry.id)) throw new Error(`missing shared-context proof for ${entry.id}`);
    const canonicalMutation = proof.canonicalAtomMutations?.find((item) => item.id === entry.id)?.mutation;
    if (!canonicalMutation) throw new Error(`missing canonical shared-context mutation for ${entry.id}`);
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.disposition = null;
    entry.ownershipRecord = {
      kind: "shared-context-predicate",
      predicate: entry.predicate,
      canonicalMutation,
    };
  }
  if (SAME_CODE_SHADOW_WITNESSES.has(entry.id)) {
    const proof = manifest.baseline?.sameCodeShadows?.find((item) => item.entryId === entry.id);
    if (!proof || entry.mutation?.operator !== "suppress-thrown-rejection") {
      throw new Error(`missing same-code shadow proof or canonical suppression for ${entry.id}`);
    }
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.disposition = null;
    entry.ownershipRecord = {
      kind: "same-code-shadow",
      downstreamEntryId: proof.downstreamEntryId,
      rejectCode: proof.rejectCode,
      witnessId: SAME_CODE_SHADOW_WITNESSES.get(entry.id),
      canonicalMutation: { operator: "suppress-thrown-rejection" },
    };
  }
  if (DOWNSTREAM_DOMAIN_SHADOW_WITNESSES.has(entry.id)) {
    const proof = manifest.baseline?.downstreamDomainShadows?.find((item) => item.entryId === entry.id);
    if (!proof) throw new Error(`missing downstream-domain shadow proof for ${entry.id}`);
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.disposition = null;
    entry.ownershipRecord = {
      kind: "downstream-domain-shadow",
      downstreamEntryId: proof.downstreamEntryId,
      enforcingEntryIds: proof.enforcingEntryIds,
      canonicalMutation: proof.canonicalMutation,
      catchReturn: proof.catchReturn,
      pathHash: proof.pathHash,
      witnessId: DOWNSTREAM_DOMAIN_SHADOW_WITNESSES.get(entry.id),
    };
  }
  if (SUCCESS_PATH_CALLS.has(entry.id)) {
    const proof = manifest.baseline?.successPathCalls?.find((item) => item.entryId === entry.id);
    if (!proof) throw new Error(`missing success-path proof for ${entry.id}`);
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.disposition = null;
    entry.ownershipRecord = {
      kind: "success-path-call",
      proofKind: proof.proofKind,
      dischargerEntryIds: proof.dischargerEntryIds,
    };
  }
  if (DELEGATED_OUTCOME_CALLS.has(entry.id)) {
    const proof = manifest.baseline?.delegatedOutcomeCalls?.find((item) => item.entryId === entry.id);
    if (!proof) throw new Error(`missing delegated-outcome proof for ${entry.id}`);
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.disposition = null;
    entry.ownershipRecord = {
      kind: "delegated-outcome-call",
      internalCallEntryIds: proof.internalCallEntryIds,
      internalOutcomeEntryIds: proof.internalOutcomeEntryIds,
      callerNullGuardOwnership: proof.callerNullGuard,
      callerControlFlowOwnership: proof.callerControlFlow,
    };
  }
  if (entry.kind === "unresolved-call") {
    entry.classification = {
      kind: ["process.kill", "Promise.reject", "assert", "assert.ok"].includes(entry.callee) ? "sink-candidate" : "non-predicate",
      reason: `closed-world review of exact source ${entry.sourceHash}; any changed call spelling creates an unowned entry`,
    };
  } else if (entry.kind === "outcome-candidate") {
    entry.classification = {
      kind: "non-outcome",
      reason: `immutable returned binding is not a RED/BLOCKED/N0_TEST_CAPABLE constructor at exact source ${entry.sourceHash}`,
    };
  } else if (entry.kind === "success-constructor") {
    entry.mutation = null;
    entry.witness = null;
    entry.acceptFlipSet = null;
    entry.rejectDeltaSet = null;
    entry.positiveRegressionSet = null;
    entry.ownershipRecord = { kind: "owned-success", reason: "the sole N0_TEST_CAPABLE return constructor" };
  }
}

manifest.floors.sharedContextPredicateAtoms ??= SHARED_CONTEXT_PREDICATE_ATOMS.size;
manifest.floors.sameCodeShadowEntries ??= SAME_CODE_SHADOW_WITNESSES.size;
manifest.floors.downstreamDomainShadowEntries = DOWNSTREAM_DOMAIN_SHADOW_WITNESSES.size;
manifest.floors.successPathCalls ??= SUCCESS_PATH_CALLS.size;
manifest.floors.delegatedOutcomeCalls ??= DELEGATED_OUTCOME_CALLS.size;
manifest.floors.ownershipGrowthReasons ??= {};
manifest.floors.ownershipGrowthReasons.rejectPreservingOwnership = "Reviewed exact-remainder growth: PR6-N0-REMAINDER-AMENDMENT with Assay rulings 4247/4249/4263, extended by PR6-N0-R7-ZERO-AMENDMENT and Assay ruling 4286";
manifest.floors.ownershipGrowthReasons.mixedOwnership = "Reviewed exact-remainder growth: PR6-N0-REMAINDER-AMENDMENT with Assay rulings 4247/4249/4263, extended by PR6-N0-R7-ZERO-AMENDMENT and Assay ruling 4286";
manifest.compounds = structuredClone(COMPOUNDS);
const compoundMembers = new Map(COMPOUNDS.flatMap((compound) => compound.memberIds.map((id) => [id, compound.id])));
for (const entry of manifest.entries) {
  const compoundId = compoundMembers.get(entry.id);
  if (!compoundId) continue;
  entry.mutation = null;
  entry.witness = null;
  entry.acceptFlipSet = null;
  entry.rejectDeltaSet = null;
  entry.positiveRegressionSet = null;
  entry.disposition = null;
  entry.ownershipRecord = { kind: "compound-member", compoundId };
}
manifest.floors.compoundDispositionUnits = COMPOUNDS.length;
manifest.floors.compoundDispositionMembers = compoundMembers.size;

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const unsafeOperators = manifest.entries.filter((entry) => entry.mutation?.operator === "substitute-reviewed-expression").length;
const unpairedEntries = manifest.entries.filter((entry) => !entry.mutation && !entry.disposition && !entry.ownershipRecord
  && !["unresolved-call", "outcome-candidate"].includes(entry.kind)).length;
if (unsafeOperators > 0 || unpairedEntries > 0) {
  process.stderr.write(`N0_GUARD_MANIFEST_AUTHOR_INCOMPLETE unsafeOperators=${unsafeOperators} unpairedEntries=${unpairedEntries}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("N0_GUARD_MANIFEST_AUTHOR_GREEN operators safe and every executable entry owned\n");
}
