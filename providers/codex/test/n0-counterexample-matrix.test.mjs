import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { counterexampleUniverse, expectedPositiveCases, runCounterexampleMatrix } from "./n0-guard-counterexamples.mjs";
import { assertPristineMatrix } from "./n0-guard-mutation-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

function runOne(root, id) {
  const source = `
    import { runCounterexample } from "./providers/codex/test/n0-guard-counterexamples.mjs";
    try { process.stdout.write(JSON.stringify(await runCounterexample(${JSON.stringify(id)}))); }
    catch (error) { process.stdout.write(JSON.stringify({ crashed: true, code: error?.code ?? error?.name, message: error?.message })); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function replaceOnce(root, relative, before, after) {
  const target = path.join(root, relative);
  const source = fs.readFileSync(target, "utf8");
  assert.equal(source.split(before).length, 2, `${relative} probe anchor must be unique`);
  fs.writeFileSync(target, source.replace(before, after));
  return () => fs.writeFileSync(target, source);
}

test("counterexample matrix has only its exact named positive corpus and no crashes", async () => {
  assertPristineMatrix(await runCounterexampleMatrix(), expectedPositiveCases());
});

test("CLI counterexamples bind exact refusal channels instead of only exit status", async () => {
  const matrix = await runCounterexampleMatrix();
  const expected = {
    "cli.args.dangling": "CLI_EXIT_64:USAGE",
    "cli.args.key": "CLI_EXIT_64:USAGE",
    "cli.args.missing-evidence": "CLI_EXIT_64:USAGE",
    "cli.args.missing-inputs": "CLI_EXIT_64:USAGE",
    "cli.args.missing-specimen": "CLI_EXIT_64:USAGE",
    "cli.evidence.parse": "CLI_EXIT_1:INVALID_JSON",
    "cli.evidence.read": "CLI_EXIT_1:PATH_ESCAPE",
    "cli.oracle.red": "CLI_EXIT_1:PROBE_ID_MISMATCH",
    "cli.root.missing": "CLI_EXIT_64:USAGE",
    "cli.root.relative": "CLI_EXIT_64:USAGE",
    "cli.snapshot.symlink": "CLI_EXIT_1:SYMLINK_REJECTED",
    "cli.specimen.parse": "CLI_EXIT_1:INVALID_JSON",
    "cli.specimen.read": "CLI_EXIT_1:PATH_ESCAPE",
    "cli.usage.unknown": "CLI_EXIT_64:USAGE",
  };
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((id) => [id, matrix[id]?.code])), expected);
});

test("manifest binds the exact current counterexample and positive-case universe", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "n0-guard-census.json"), "utf8"));
  assert.deepEqual(manifest.baseline.counterexampleUniverse, counterexampleUniverse());
});

test("positive cases reject empty or structurally invalid success outputs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "n0-positive-contract."));
  try {
    fs.cpSync(path.join(REPO, "providers"), path.join(temp, "providers"), { recursive: true });
    const probes = [
      {
        file: "providers/codex/n0-harness/cli.mjs",
        before: "main(process.argv.slice(2));",
        after: "void 0;",
        cases: ["positive.cli.oracle", "positive.cli.snapshot"],
        expected: { accepted: false, code: "CLI_EXIT_0:EMPTY_OUTPUT" },
      },
      {
        file: "providers/codex/n0-harness/lib.mjs",
        before: "return { data, stat: after, path: realTarget };",
        after: "return undefined;",
        cases: ["positive.lib.read"],
        expected: { crashed: true, code: "POSITIVE_CONTRACT" },
      },
      {
        file: "providers/codex/n0-harness/parser.mjs",
        before: "return { sessionId: first.payload.id, records };",
        after: "return undefined;",
        cases: ["positive.parser.rollout"],
        expected: { crashed: true, code: "POSITIVE_CONTRACT" },
      },
      {
        file: "providers/codex/n0-harness/snapshot.mjs",
        before: "return { schema: \"N0_ROLLOUT_SNAPSHOT_V1\", root: realRoot, totalBytes, entries };",
        after: "return undefined;",
        cases: ["positive.snapshot.tree"],
        expected: { crashed: true, code: "POSITIVE_CONTRACT" },
      },
      {
        file: "providers/codex/n0-harness/oracle.mjs",
        before: "return specimen;",
        after: "return undefined;",
        cases: ["positive.specimen.validate"],
        expected: { crashed: true, code: "POSITIVE_CONTRACT" },
      },
    ];
    for (const probe of probes) {
      const restore = replaceOnce(temp, probe.file, probe.before, probe.after);
      try {
        for (const id of probe.cases) {
          const actual = runOne(temp, id);
          for (const [key, value] of Object.entries(probe.expected)) assert.equal(actual[key], value, `${id} ${key}`);
        }
      } finally {
        restore();
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
