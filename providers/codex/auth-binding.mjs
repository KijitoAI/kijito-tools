import { createHash } from "node:crypto";
import fs from "node:fs";

export const AUTH_BINDING_VERSION = 1;

function verdict(status, code, extra = {}) {
  return { status, code, ...extra };
}

function privateRegular(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    return error.code === "ENOENT"
      ? verdict("BLOCKED", "AUTH_EVIDENCE_ABSENT")
      : verdict("BLOCKED", "AUTH_EVIDENCE_UNREADABLE");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    return verdict("BLOCKED", "AUTH_EVIDENCE_NOT_PRIVATE_REGULAR");
  }
  return verdict("PASS", "AUTH_FILE_PRIVATE");
}

function canonicalDigest(authMode, accountId) {
  // Deliberately only stable identity evidence. Tokens and refresh timestamps rotate and must never
  // enter a stored digest, a verdict, or a log line.
  const canonical = JSON.stringify({ accountId, authMode });
  return createHash("sha256").update(canonical).digest("hex");
}

export function inspectAuthBinding(file) {
  const fileVerdict = privateRegular(file);
  if (fileVerdict.status !== "PASS") return fileVerdict;

  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return verdict("BLOCKED", "AUTH_EVIDENCE_UNPARSEABLE"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return verdict("BLOCKED", "AUTH_SCHEMA_UNKNOWN");
  }

  if (typeof parsed.auth_mode !== "string" || parsed.auth_mode.length === 0) {
    return verdict("BLOCKED", "AUTH_SCHEMA_UNKNOWN");
  }
  if (parsed.auth_mode !== "chatgpt") return verdict("FAIL", "AUTH_MODE_UNSUPPORTED");
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return verdict("FAIL", "AUTH_TOKENS_MISSING");
  }
  for (const key of ["id_token", "access_token", "refresh_token", "account_id"]) {
    if (typeof tokens[key] !== "string" || tokens[key].length === 0) {
      return verdict("FAIL", "AUTH_TOKEN_INTEGRITY_FAILED");
    }
  }
  if (typeof parsed.last_refresh !== "string" || !Number.isFinite(Date.parse(parsed.last_refresh))) {
    return verdict("FAIL", "AUTH_REFRESH_EVIDENCE_INVALID");
  }

  return verdict("PASS", "AUTH_BINDING_VALID", {
    binding: {
      version: AUTH_BINDING_VERSION,
      digest: canonicalDigest(parsed.auth_mode, tokens.account_id),
    },
  });
}

export function compareAuthBinding(file, expected) {
  if (!expected || expected.version !== AUTH_BINDING_VERSION
      || typeof expected.digest !== "string" || !/^[0-9a-f]{64}$/.test(expected.digest)) {
    return verdict("BLOCKED", "AUTH_BINDING_VERSION_UNKNOWN");
  }
  const current = inspectAuthBinding(file);
  if (current.status !== "PASS") return current;
  return current.binding.digest === expected.digest
    ? verdict("PASS", "AUTH_BINDING_MATCH")
    : verdict("FAIL", "AUTH_BINDING_MISMATCH");
}

export function requireAuthBinding(file) {
  const result = inspectAuthBinding(file);
  if (result.status !== "PASS") {
    const error = new Error(`auth binding unavailable (${result.status}/${result.code})`);
    error.verdict = result;
    throw error;
  }
  return result.binding;
}
