import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { independentProjection } from "./n0-guard-independent-projection.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source) {
  const root = mkdtempSync(path.join(tmpdir(), "n0-independent-projection-"));
  temporaryRoots.push(root);
  writeFileSync(path.join(root, "subject.mjs"), source);
  return root;
}

test("independent projection is intentionally crude enough to disagree on data-like spellings", () => {
  const root = fixture(`
function fail() {}
function verdict() {}
export function subject() { fail("X"); return verdict("RED", "Y"); }
const text = 'fail("data") verdict("RED", "data")';
// fail("comment") verdict("RED", "comment")
`);
  const result = independentProjection(root);
  assert.equal(result.mechanism, "plain-regex-line-scan-v1-no-parser");
  assert.deepEqual(result.counts, { fail: 3, "verdict:RED": 3 });
  assert.equal(result.sites.length, 6);
});

test("independent projection has no parser or analyzer dependency", () => {
  const source = readFileSync(path.join(HERE, "n0-guard-independent-projection.mjs"), "utf8");
  assert.doesNotMatch(source, /from\s+["']acorn["']/);
  assert.doesNotMatch(source, /n0-guard-census-core/);
  assert.doesNotMatch(source, /\bparse\s*\(/);
});

test("source aggregate binds non-site edits while the exact site aggregate stays stable", () => {
  const root = fixture(`export function subject() { fail("X"); }\n`);
  const before = independentProjection(root);
  mkdirSync(path.join(root, "nested"));
  writeFileSync(path.join(root, "nested/metadata.mjs"), "export const value = 1;\n");
  const after = independentProjection(root);
  assert.notEqual(after.sourceAggregate, before.sourceAggregate);
  assert.equal(after.aggregate, before.aggregate);
  assert.deepEqual(after.sites, before.sites);
});
