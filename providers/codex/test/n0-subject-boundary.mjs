#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SUBJECT_DIR = "providers/codex/n0-harness";
const BASE_COMMIT = "afe5afef156e45523d129525360dfff05a11045c";

const BASE_HASHES = new Map(Object.entries({
  "providers/codex/n0-harness/cli.mjs": "0662c199ce81ac8adb315293db59903d2dab16a61c0a51a0985ce722a9013cef",
  "providers/codex/n0-harness/evidence-manifest.mjs": "7d1f9f4a578e532f9e80f9c045f1f9508258c7d68258aa5146fced30f5c70008",
  "providers/codex/n0-harness/fixture.mjs": "ce9f8f709e9673b074e6a9f2322fa6d1718a7551c37ecb7af2966466d11c2725",
  "providers/codex/n0-harness/lib.mjs": "f32cb7f7347f11c2a4ec61194919bca30cb535f167a4e08f0ad6ac1ac276c8bf",
  "providers/codex/n0-harness/manifest.mjs": "4d9531d40efa9bb7455a121630195114cadb0517a0f525c3d0a009131bb7b55a",
  "providers/codex/n0-harness/oracle.mjs": "4ecd55183def821b2f67ec9517d4aa4c042450a852d404a3abfdb9537ff42a5e",
  "providers/codex/n0-harness/parser.mjs": "4844fadf2fc8d62421dff9d7474e837d48d1ab13da9947ee1559d7063c768146",
  "providers/codex/n0-harness/prompt.mjs": "1a84084a9f061656c6059c15ff53c508ca5e14fd3831849b90213705bb31c8bb",
  "providers/codex/n0-harness/snapshot.mjs": "1067a4ebe71e027fc1dc6aa5df397efd2abb30f1a52723f12ba2f62813996cbd",
  "providers/codex/n0-harness/specimen.mjs": "6adace1ba6ab571624533aa72c4f0c7dfe474b6a797ad247488c62e0dd23dc25",
  "providers/codex/test/n0-harness.test.mjs": "fb0778e2f1d0ae95dab1cf19f13cbac25bc9786ea63167cdf3707d3c0fd04bce",
}));

const CLI_CURRENT_HASH = "f5e20e51391985124ff2ddd53e100e5461ca517e0253480adb3e413be1979001";
const CLI_REVERSE_PATCHES = [
  [
    `    if (!key?.startsWith("--") || value === undefined) {\n      usage();\n      return null;\n    }`,
    `    if (!key?.startsWith("--") || value === undefined) usage();`,
  ],
  [
    `function main(argv) {\n  const parsed = args(argv);\n  if (!parsed) return;\n  const { command, options } = parsed;`,
    `try {\n  const { command, options } = args(process.argv.slice(2));`,
  ],
  [
    `  if (!options.root || !path.isAbsolute(options.root)) {\n    usage();\n    return;\n  }`,
    `  if (!options.root || !path.isAbsolute(options.root)) usage();`,
  ],
  [
    `    if (!options.specimen || !options.evidence) {\n      usage();\n      return;\n    }`,
    `    if (!options.specimen || !options.evidence) usage();`,
  ],
  [
    `  } else {\n    usage();\n  }\n}\n\ntry {\n  main(process.argv.slice(2));\n} catch (error) {`,
    `  } else {\n    usage();\n  }\n} catch (error) {`,
  ],
];

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceExactlyOnce(source, from, to, index) {
  const first = source.indexOf(from);
  if (first === -1 || source.indexOf(from, first + 1) !== -1) {
    fail("N0_SUBJECT_CLI_PATCH", `reverse patch ${index + 1} must match exactly once`);
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

const expectedProduction = [...BASE_HASHES.keys()]
  .filter((file) => file.startsWith(`${SUBJECT_DIR}/`))
  .sort();
const actualProduction = readdirSync(path.join(ROOT, SUBJECT_DIR), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
  .map((entry) => `${SUBJECT_DIR}/${entry.name}`)
  .sort();

if (JSON.stringify(actualProduction) !== JSON.stringify(expectedProduction)) {
  fail("N0_SUBJECT_INVENTORY", `expected=${JSON.stringify(expectedProduction)} actual=${JSON.stringify(actualProduction)}`);
}

for (const [file, expectedBaseHash] of BASE_HASHES) {
  const source = readFileSync(path.join(ROOT, file));
  const currentHash = sha256(source);
  if (file.endsWith("/cli.mjs")) {
    if (currentHash !== CLI_CURRENT_HASH) {
      fail("N0_SUBJECT_CLI_CURRENT", `expected=${CLI_CURRENT_HASH} actual=${currentHash}`);
    }
    let reconstructedBase = source.toString("utf8");
    for (const [index, [from, to]] of CLI_REVERSE_PATCHES.entries()) {
      reconstructedBase = replaceExactlyOnce(reconstructedBase, from, to, index);
    }
    const reconstructedHash = sha256(reconstructedBase);
    if (reconstructedHash !== expectedBaseHash) {
      fail("N0_SUBJECT_CLI_BASE", `base=${BASE_COMMIT} expected=${expectedBaseHash} actual=${reconstructedHash}`);
    }
  } else if (currentHash !== expectedBaseHash) {
    fail("N0_SUBJECT_DRIFT", `${file} base=${BASE_COMMIT} expected=${expectedBaseHash} actual=${currentHash}`);
  }
}

process.stdout.write(`N0_SUBJECT_BOUNDARY_GREEN base=${BASE_COMMIT} productionFiles=${actualProduction.length} allowedDelta=cli-control-flow\n`);
