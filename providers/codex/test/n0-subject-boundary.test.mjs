import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeSpecimen() {
  const root = mkdtempSync(path.join(tmpdir(), "n0-subject-boundary-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "providers/codex/test"), { recursive: true });
  cpSync(path.join(ROOT, "providers/codex/n0-harness"), path.join(root, "providers/codex/n0-harness"), { recursive: true });
  cpSync(path.join(ROOT, "providers/codex/test/n0-subject-boundary.mjs"), path.join(root, "providers/codex/test/n0-subject-boundary.mjs"));
  cpSync(path.join(ROOT, "providers/codex/test/n0-harness.test.mjs"), path.join(root, "providers/codex/test/n0-harness.test.mjs"));
  return root;
}

function run(root) {
  return spawnSync(process.execPath, ["providers/codex/test/n0-subject-boundary.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("subject boundary accepts only the reviewed current bytes", () => {
  const result = run(makeSpecimen());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^N0_SUBJECT_BOUNDARY_GREEN /m);
});

test("subject boundary rejects production drift and new modules", () => {
  const driftRoot = makeSpecimen();
  appendFileSync(path.join(driftRoot, "providers/codex/n0-harness/oracle.mjs"), "\n// drift\n");
  const drift = run(driftRoot);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /N0_SUBJECT_DRIFT/);

  const inventoryRoot = makeSpecimen();
  writeFileSync(path.join(inventoryRoot, "providers/codex/n0-harness/extra.mjs"), "export {};\n");
  const inventory = run(inventoryRoot);
  assert.notEqual(inventory.status, 0);
  assert.match(inventory.stderr, /N0_SUBJECT_INVENTORY/);
});

test("subject boundary rejects a changed or merely base-restored CLI", () => {
  const changedRoot = makeSpecimen();
  appendFileSync(path.join(changedRoot, "providers/codex/n0-harness/cli.mjs"), "\n// drift\n");
  const changed = run(changedRoot);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /N0_SUBJECT_CLI_CURRENT/);

  const baseRoot = makeSpecimen();
  const cli = path.join(baseRoot, "providers/codex/n0-harness/cli.mjs");
  const source = readFileSync(cli, "utf8")
    .replace(`    if (!key?.startsWith("--") || value === undefined) {\n      usage();\n      return null;\n    }`, `    if (!key?.startsWith("--") || value === undefined) usage();`)
    .replace(`function main(argv) {\n  const parsed = args(argv);\n  if (!parsed) return;\n  const { command, options } = parsed;`, `try {\n  const { command, options } = args(process.argv.slice(2));`)
    .replace(`  if (!options.root || !path.isAbsolute(options.root)) {\n    usage();\n    return;\n  }`, `  if (!options.root || !path.isAbsolute(options.root)) usage();`)
    .replace(`    if (!options.specimen || !options.evidence) {\n      usage();\n      return;\n    }`, `    if (!options.specimen || !options.evidence) usage();`)
    .replace(`  } else {\n    usage();\n  }\n}\n\ntry {\n  main(process.argv.slice(2));\n} catch (error) {`, `  } else {\n    usage();\n  }\n} catch (error) {`);
  writeFileSync(cli, source);
  const base = run(baseRoot);
  assert.notEqual(base.status, 0);
  assert.match(base.stderr, /N0_SUBJECT_CLI_CURRENT/);
});
