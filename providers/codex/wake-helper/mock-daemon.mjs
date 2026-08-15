// Minimal mock of the codex app-server DAEMON control socket for helper integration tests.
// Speaks the measured 0.147 transport — WEBSOCKET over the unix socket (handshake, then
// JSON-RPC as one message per text frame) — and the measured methods: initialize,
// thread/resume, turn/start; pushes thread/status/changed notifications on demand.
// Test-only — the gate-4 battery runs against the REAL daemon; this exists so the run loop's
// logic (defer-until-idle, loud exits, gasp) is proven on the same transport first.
import net from "node:net";
import fs from "node:fs";
import { acceptWsUds } from "./ws-uds.mjs";

export class MockDaemon {
  constructor(sockPath, { threadId = "T1", initialStatus = "idle", failResume = false } = {}) {
    this.sockPath = sockPath;
    this.threadId = threadId;
    this.status = initialStatus;
    this.failResume = failResume;
    this.calls = [];
    this.conns = new Set();
    this.turnSeq = 0;
  }

  listen() {
    try { fs.unlinkSync(this.sockPath); } catch { /* fresh */ }
    this.server = net.createServer(async (sock) => {
      const conn = await acceptWsUds(sock, {
        onText: (text, c) => this.handle(c, JSON.parse(text)),
        onClose: () => this.conns.delete(conn),
      }).catch(() => null);
      if (conn) this.conns.add(conn);
    });
    return new Promise((resolve) => this.server.listen(this.sockPath, resolve));
  }

  handle(conn, msg) {
    this.calls.push(msg);
    if (msg.id === undefined) return; // notification (e.g. initialized)
    const reply = (result) => conn.sendText(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    const fail = (message) => conn.sendText(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } }));
    if (msg.method === "initialize") return reply({});
    if (msg.method === "thread/resume") {
      if (this.failResume) return fail("thread not found");
      return reply({ thread: { id: this.threadId, status: { type: this.status } } });
    }
    if (msg.method === "turn/start") {
      if (this.status !== "idle") return fail("thread busy");
      this.turnSeq += 1;
      return reply({ turn: { id: `turn-${this.turnSeq}` } });
    }
    return fail(`unknown method ${msg.method}`);
  }

  setStatus(type) {
    this.status = type;
    const note = JSON.stringify({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: this.threadId, status: { type } } });
    for (const conn of this.conns) conn.sendText(note);
  }

  turnStarts() { return this.calls.filter((c) => c.method === "turn/start"); }

  close() {
    for (const conn of this.conns) conn.destroy();
    return new Promise((resolve) => this.server.close(resolve));
  }
}
