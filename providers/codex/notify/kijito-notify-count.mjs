#!/usr/bin/env node
// C-i hook-time count notification (plan §2b) — the zero-process option-C shape.
//
// Wired as Codex's outbound `notify` program. Codex invokes it on ITS OWN
// lifecycle events (turn-complete / approval), so the honest, documented
// semantics are: notification latency = codex activity, NOT mail arrival.
// On each invocation: one count-only peek at /api/notify/pending (a per-persona
// {persona, unread} table — no message content exists on this endpoint), then
// at most one OS notification built from a FIXED TEMPLATE with exactly two
// variables. Nothing from the network can enter the template except a
// charset-anchored persona echo and a digit count; anything out of character
// refuses to notify rather than notifying differently.
//
// Never breaks the user's turn: every failure path logs one stderr line and
// exits 0. A hung API cannot stall codex (hard 3s timeout).

import fs from "node:fs";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const PERSONA_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const API_TIMEOUT_MS = 3_000;

// THE template. Two variables, nothing else, ever. Tests anchor this exact shape.
export function renderTemplate(persona, count) {
  if (typeof persona !== "string" || !PERSONA_RE.test(persona)) return null;
  if (!Number.isSafeInteger(count) || count < 0) return null;
  return `Kijito: ${persona} — ${count} unread`;
}

function parseArgs(argv) {
  const opts = { api: "https://api.kijito.ai" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--persona") opts.persona = argv[++i];
    else if (argv[i] === "--token-file") opts.tokenFile = argv[++i];
    else if (argv[i] === "--api") opts.api = argv[++i];
    // Codex appends its notification JSON as the final positional argument.
    // It is deliberately unread: this shim keys on nothing inside it.
  }
  return opts;
}

export async function unreadCount(api, token, persona) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${api}/api/notify/pending`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "kijito-notify-count" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = await res.json();
    // Row-absent means zero (measured fact, below) — but a missing/unexpected
    // `result` key is contract drift and must fail LOUD, never read as count 0.
    if (!Array.isArray(body?.result)) throw new Error("unexpected /api/notify/pending shape");
    const rows = body.result;
    const row = rows.find((r) => r?.persona === persona);
    // The endpoint lists only personas with pending unread (measured live
    // 2026-08-14: zero-unread personas are simply absent) — no row means 0.
    if (row === undefined) return 0;
    const n = row.unread;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } finally {
    clearTimeout(timer);
  }
}

function postNotification(text) {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      // Text goes through argv into a quoted AppleScript literal; the charset
      // anchor upstream already excludes quotes/newlines from ever reaching here.
      execFile("/usr/bin/osascript", ["-e", `display notification "${text}" with title "Kijito"`],
        (err) => resolve(!err));
    } else {
      execFile("notify-send", ["Kijito", text], (err) => resolve(!err));
    }
  });
}

async function main() {
  const { persona, tokenFile, api } = parseArgs(process.argv.slice(2));
  if (!persona || !PERSONA_RE.test(persona)) return fail("bad or missing --persona");
  if (!tokenFile) return fail("missing --token-file");
  let token;
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch (error) {
    return fail(`token unreadable: ${error.code ?? error.message}`);
  }
  let count;
  try {
    count = await unreadCount(api, token, persona);
  } catch (error) {
    return fail(`pending peek failed: ${error.name === "AbortError" ? "timeout" : error.message}`);
  }
  if (count === null) return fail("persona row absent or count out of character");
  if (count === 0) return; // nothing unread — no notification, by design
  const text = renderTemplate(persona, count);
  if (text === null) return fail("template refused inputs");
  if (!(await postNotification(text))) return fail("os notifier unavailable");
}

function fail(reason) {
  process.stderr.write(`kijito-notify-count: ${reason}\n`);
}

// realpath both sides: on macOS /tmp (and often install prefixes) are symlinks, and a naive
// argv[1] comparison silently NO-OPS the whole program — measured 2026-08-15 on the exact
// /tmp -> /private/tmp case; the zero-unread "success" was a false green until the
// bad-token negative control stayed silent too.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (invokedDirectly) main().then(() => process.exit(0), () => process.exit(0));
