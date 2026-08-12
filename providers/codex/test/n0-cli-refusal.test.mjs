import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../n0-harness/cli.mjs");
const usage = "N0_TEST_ORACLE — non-installable, read-only\n"
  + "usage: cli.mjs snapshot --root DIR | oracle --root DIR --specimen FILE --evidence FILE [--now-ms N]\n";

function expectUsage(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, usage);
}

test("CLI refusals return through control flow and flush the complete piped usage text", () => {
  expectUsage(["snapshot", "--root", "relative/dir"]);
  expectUsage(["oracle", "--root", os.tmpdir()]);
  expectUsage(["snapshot", "--root"]);
  expectUsage(["bogus", "--root", os.tmpdir()]);
});
