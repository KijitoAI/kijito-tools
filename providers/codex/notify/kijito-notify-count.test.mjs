// Charset-anchored template tests for the C-i shim (plan §2b): the notification
// is a FIXED template with exactly two variables, and out-of-character input
// refuses (returns null) rather than rendering differently.
import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "./kijito-notify-count.mjs";

const SHAPE = /^Kijito: [a-z0-9][a-z0-9-]{0,31} — \d+ unread$/u;

test("valid inputs render the exact anchored shape", () => {
  for (const [p, c] of [["codex", 1], ["a", 0], ["river-2", 314], ["x".repeat(32), 7]]) {
    const out = renderTemplate(p, c);
    assert.notEqual(out, null, `${p}/${c} should render`);
    assert.match(out, SHAPE);
    assert.equal(out, `Kijito: ${p} — ${c} unread`);
  }
});

test("out-of-character personas refuse — nothing but the anchor charset enters the template", () => {
  const bad = [
    "Codex",                 // case outside anchor
    "co dex",                // whitespace
    "codex\nmail: hi",       // newline injection
    'codex" with title "x',  // quote injection toward osascript
    "we🙂ird",               // non-ascii
    "-codex",                // bad leading char
    "x".repeat(33),          // overlong
    "",                      // empty
  ];
  for (const p of bad) assert.equal(renderTemplate(p, 1), null, JSON.stringify(p));
  assert.equal(renderTemplate(undefined, 1), null);
  assert.equal(renderTemplate(42, 1), null);
});

test("out-of-character counts refuse", () => {
  for (const c of [-1, 1.5, NaN, Infinity, "3", null, undefined, 2 ** 53]) {
    assert.equal(renderTemplate("codex", c), null, String(c));
  }
});

test("template carries no content channel — output length is bounded by anchor maxima", () => {
  const out = renderTemplate("x".repeat(32), Number.MAX_SAFE_INTEGER);
  assert.notEqual(out, null);
  assert.ok(out.length <= "Kijito: ".length + 32 + " — ".length + String(Number.MAX_SAFE_INTEGER).length + " unread".length);
});
