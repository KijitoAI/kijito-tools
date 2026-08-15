// Minimal RFC 6455 WebSocket over a unix-domain socket — zero dependencies, exactly what the
// codex app-server daemon control socket speaks (measured at source, rust-v0.147.0:
// tokio_tungstenite accept_async on the UnixStream; clients dial with handshake URL
// ws://localhost/rpc and exchange JSON-RPC as text frames; filesystem 0600 is the auth).
//
// Scope is deliberately narrow: text frames, unfragmented (our JSON-RPC messages are small),
// ping->pong, clean close. Anything outside that surface errors loudly rather than guessing.
import crypto from "node:crypto";
import net from "node:net";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const HANDSHAKE_PATH = "/rpc";

function acceptKeyFor(key) {
  return crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
}

// ---------- framing ----------

export function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = (mask ? 0x80 : 0) | 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4];
  return Buffer.concat([header, key, masked]);
}

// Incremental decoder: feed bytes, yields {opcode, payload} frames.
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) throw new Error("ws frame too large");
        len = Number(big); off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) break;
      if (!fin) throw new Error("fragmented ws frames unsupported");
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i % 4];
      }
      frames.push({ opcode, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(off + maskLen + len);
    }
    return frames;
  }
}

// ---------- shared per-connection wiring ----------

function wire(sock, { isClient, onText, onClose }) {
  const decoder = new FrameDecoder();
  const conn = {
    sendText: (text) => sock.write(encodeFrame(0x1, Buffer.from(text, "utf8"), isClient)),
    close: () => { try { sock.write(encodeFrame(0x8, Buffer.alloc(0), isClient)); } catch { /* gone */ } sock.end(); },
    destroy: () => sock.destroy(),
  };
  sock.on("data", (chunk) => {
    let frames;
    try { frames = decoder.push(chunk); } catch (error) { sock.destroy(error); return; }
    for (const frame of frames) {
      if (frame.opcode === 0x1) onText(frame.payload.toString("utf8"), conn);
      else if (frame.opcode === 0x9) sock.write(encodeFrame(0xa, frame.payload, isClient)); // ping->pong
      else if (frame.opcode === 0x8) { try { sock.write(encodeFrame(0x8, Buffer.alloc(0), isClient)); } catch { /* gone */ } sock.end(); }
      // 0xa pong and binary 0x2 ignored — nothing on this surface sends them meaningfully.
    }
  });
  sock.on("close", () => onClose?.());
  sock.on("error", () => { /* close event follows; onClose reports */ });
  return conn;
}

// ---------- client ----------

export function connectWsUds(sockPath, { path = HANDSHAKE_PATH, timeoutMs = 10_000, onText, onClose } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("ws-handshake-timeout")); }, timeoutMs);
    sock.once("error", (error) => { clearTimeout(timer); reject(error); });
    sock.once("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let head = "";
      const onHead = (chunk) => {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
          if (head.length > 16_384) { sock.destroy(); clearTimeout(timer); reject(new Error("ws-handshake-oversized")); }
          return;
        }
        sock.removeListener("data", onHead);
        const header = head.slice(0, end);
        const rest = Buffer.from(head.slice(end + 4), "latin1");
        if (!/^HTTP\/1\.1 101 /.test(header)) { sock.destroy(); clearTimeout(timer); reject(new Error(`ws-handshake-rejected: ${header.split("\r\n")[0]}`)); return; }
        const accept = /sec-websocket-accept: *([^\r\n]+)/i.exec(header)?.[1];
        if (accept !== acceptKeyFor(key)) { sock.destroy(); clearTimeout(timer); reject(new Error("ws-accept-mismatch")); return; }
        clearTimeout(timer);
        const conn = wire(sock, { isClient: true, onText, onClose });
        if (rest.length) sock.emit("data", rest);
        resolve(conn);
      };
      sock.on("data", onHead);
    });
  });
}

// ---------- server-accept (mock daemon / tests) ----------

export function acceptWsUds(sock, { onText, onClose }) {
  return new Promise((resolve, reject) => {
    let head = "";
    const onHead = (chunk) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      sock.removeListener("data", onHead);
      const key = /sec-websocket-key: *([^\r\n]+)/i.exec(head.slice(0, end))?.[1];
      if (!key) { sock.destroy(); reject(new Error("ws-server: no key")); return; }
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`);
      const rest = Buffer.from(head.slice(end + 4), "latin1");
      const conn = wire(sock, { isClient: false, onText, onClose });
      if (rest.length) sock.emit("data", rest);
      resolve(conn);
    };
    sock.on("data", onHead);
    sock.once("error", reject);
  });
}
