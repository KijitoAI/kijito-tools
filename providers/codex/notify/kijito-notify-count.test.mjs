// Charset-anchored template tests for the C-i shim (plan §2b): the notification
// is a FIXED template with exactly two variables, and out-of-character input
// refuses (returns null) rather than rendering differently.
import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, unreadCount } from "./kijito-notify-count.mjs";
import { createServer } from "node:http";

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

test("malformed /api/notify/pending body takes the loud fail path, never silent zero", async () => {
  // Contract drift (200 with an unexpected shape) must THROW to the stderr
  // fail path — a silent count-0 would suppress notifications forever.
  // Row-absent-means-zero stays separately true and is pinned here too.
  const bodies = [
    { body: { wrong: [] }, rejects: true },   // result key absent
    { body: { result: "x" }, rejects: true }, // result not an array
    { body: [], rejects: true },              // top-level not an object envelope
    { body: { result: [] }, rejects: false }, // valid: no rows -> measured 0
  ];
  for (const { body, rejects } of bodies) {
    const srv = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const api = `http://127.0.0.1:${srv.address().port}`;
    try {
      if (rejects) {
        await assert.rejects(unreadCount(api, "t", "codex"),
          /unexpected \/api\/notify\/pending shape/, JSON.stringify(body));
      } else {
        assert.equal(await unreadCount(api, "t", "codex"), 0, "row-absent means zero");
      }
    } finally {
      srv.close();
    }
  }
});

test("template carries no content channel — output length is bounded by anchor maxima", () => {
  const out = renderTemplate("x".repeat(32), Number.MAX_SAFE_INTEGER);
  assert.notEqual(out, null);
  assert.ok(out.length <= "Kijito: ".length + 32 + " — ".length + String(Number.MAX_SAFE_INTEGER).length + " unread".length);
});
