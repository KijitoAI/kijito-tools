// One-shot leg-(ii) instrument: what does a SECOND client see when it resumes a thread
// mid-turn? Prints the status thread/resume returns, plus any thread/status/changed
// notifications observed in a short listen window. Read-only.
import { connectWsUds } from "./ws-uds.mjs";

const [sock, threadId, listenMsArg] = process.argv.slice(2);
if (!sock || !threadId) { process.stderr.write("usage: status-probe.mjs <sock> <threadId> [listenMs]\n"); process.exit(2); }
const listenMs = Number(listenMsArg ?? 0);

const pending = new Map();
let nextId = 1;
let conn;
const notes = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    conn.sendText(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout:${method}`)); } }, 10_000);
  });
}

conn = await connectWsUds(sock, {
  onText: (text) => {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "rpc-error")); else p.resolve(msg.result);
    } else if (msg.method === "thread/status/changed") {
      notes.push({ at: new Date().toISOString(), params: msg.params });
    }
  },
  onClose: () => {},
});

await send("initialize", { clientInfo: { name: "g4-status-probe", title: "g4 status probe", version: "1" }, capabilities: { experimentalApi: true } });
conn.sendText(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
const opened = await send("thread/resume", { threadId });
process.stdout.write(JSON.stringify({ at: new Date().toISOString(), resumeStatus: opened?.thread?.status ?? null }) + "\n");
if (listenMs > 0) {
  await new Promise((r) => setTimeout(r, listenMs));
  process.stdout.write(JSON.stringify({ notificationsObserved: notes }) + "\n");
}
process.exit(0);
