#!/usr/bin/env node
// The machine-readable DELIVERY-MODE REGISTER for the codex provider.
//
// Until this file existed, the declared mode lived only as prose in the persona's current-state
// pointer (skills/kijito-start/SKILL.md reads it) — nothing on the machine could answer "which of
// the three delivery cells is this seat supposed to be running?" The register answers exactly that
// one question, and nothing else: it does not start, stop, or select anything. Enforcement stays
// where it already lives (consumer.lock for mutual exclusion); this is the DECLARATION the
// mode-aware watchdog compares reality against.
//
// PROVISIONAL BY CONTRACT (assay ruling, hive 7056 condition a): `provisional: true` is part of the
// schema. The measured-v1 program's P1 shared core must adopt or convert this register; a P1
// migration note is filed in the program record so that conversion is a tracked obligation, not a
// discovery. If the SPI lands a competing register first, the SPI wins and this file is deleted.
//
// The recognized modes are the three FROZEN cell IDs from the measured-v1 P0 topology freeze —
// they are spelled here exactly and nothing else is accepted, because a register that accepts a
// typo declares a mode no watchdog knows how to watch.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = 1;
const MODES = Object.freeze([
  "codex.tmux-pane",
  "codex.app-server-seat",
  "codex.attended-notify",
]);

// The same private-file discipline as every other load-bearing file in this provider: one regular
// user-owned file, no symlink, no group/other access. A register anyone else can rewrite is not a
// declaration, it is an attack surface.
function assertPrivateParent(file) {
  const dir = path.dirname(file);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`register parent is not a real directory: ${dir}`);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`register parent must be private to this user: ${dir}`);
  }
}

// Read the declaration. Never throws: a watchdog consulting the register must get a classifiable
// answer, not an exception — "invalid" and "unreadable" are answers.
//   { status: "declared", mode, declaredAt, declaredBy, provisional }
//   { status: "absent" }
//   { status: "invalid", reason }      the file exists but does not parse/validate
//   { status: "unreadable", reason }   the file exists but fails the private-file gate or IO
function readDeclaredMode(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", reason: error.code ?? error.message };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return { status: "unreadable", reason: "not-one-regular-file" };
  }
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    return { status: "unreadable", reason: "not-private" };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { status: "invalid", reason: `parse: ${error.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", reason: "not-an-object" };
  }
  if (parsed.schema !== SCHEMA) return { status: "invalid", reason: `schema ${parsed.schema} != ${SCHEMA}` };
  if (!MODES.includes(parsed.mode)) return { status: "invalid", reason: `unknown mode ${JSON.stringify(parsed.mode)}` };
  if (parsed.provisional !== true) return { status: "invalid", reason: "provisional flag missing" };
  if (typeof parsed.declaredAt !== "string" || !Number.isFinite(Date.parse(parsed.declaredAt))) {
    return { status: "invalid", reason: "declaredAt not an ISO timestamp" };
  }
  if (typeof parsed.declaredBy !== "string" || parsed.declaredBy.length === 0 || parsed.declaredBy.length > 128) {
    return { status: "invalid", reason: "declaredBy missing" };
  }
  return {
    status: "declared",
    mode: parsed.mode,
    declaredAt: parsed.declaredAt,
    declaredBy: parsed.declaredBy,
    provisional: true,
  };
}

// Declare a mode. Atomic (private temp sibling, fsync, rename) so a reader never sees a torn
// declaration, and 0600 so the register passes its own read gate.
function declareMode(file, mode, declaredBy) {
  if (!MODES.includes(mode)) {
    throw new Error(`unknown mode ${JSON.stringify(mode)} — recognized: ${MODES.join(", ")}`);
  }
  if (typeof declaredBy !== "string" || declaredBy.length === 0 || declaredBy.length > 128) {
    throw new Error("declaredBy is required (who is declaring, e.g. a persona or operator name)");
  }
  assertPrivateParent(file);
  const record = {
    schema: SCHEMA,
    mode,
    declaredAt: new Date().toISOString(),
    declaredBy,
    provisional: true,
  };
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.modetmp`;
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return record;
}

function usage() {
  return [
    "usage:",
    "  mode-register.mjs show    --register <declared-mode.json>",
    "  mode-register.mjs declare --register <declared-mode.json> --mode <id> --by <who>",
    `recognized modes: ${MODES.join(", ")}`,
  ].join("\n");
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith("--") || rest[index + 1] === undefined) throw new Error(`invalid argument ${flag ?? ""}`);
    const key = flag.slice(2);
    if (!["register", "mode", "by"].includes(key)) throw new Error(`unknown option --${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate option --${key}`);
    values[key] = rest[index + 1];
  }
  if (typeof values.register !== "string" || values.register.length === 0) {
    throw new Error("--register is required");
  }
  return { command, register: path.resolve(values.register), mode: values.mode, by: values.by };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "show") {
    process.stdout.write(`${JSON.stringify(readDeclaredMode(args.register))}\n`);
    return;
  }
  if (args.command === "declare") {
    const record = declareMode(args.register, args.mode, args.by);
    process.stdout.write(`${JSON.stringify({ status: "declared", ...record })}\n`);
    return;
  }
  throw new Error(usage());
}

function invokedAsMain(entry) {
  if (entry === undefined) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href; } catch { return false; }
}

if (invokedAsMain(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { SCHEMA, MODES, readDeclaredMode, declareMode };
