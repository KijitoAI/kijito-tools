# Daemon transport — measured facts (build verification, 2026-08-15 00:3x-00:5xZ)

Source: openai/codex tag rust-v0.147.0 (sparse clone, /tmp/codex-src on the Mac) + live smoke
against a real daemon in a THROWAWAY CODEX_HOME (/tmp/kijito-smoke-*; the staged gate-4
sandbox untouched).

1. **The control socket is a WebSocket server over the UDS** (`app-server-transport/src/
   transport/unix_socket.rs`: tungstenite `accept_async` on the UnixStream). Raw JSONL
   written to the socket is silently ignored at the handshake layer — measured: initialize
   timed out over both raw socket and `codex app-server proxy` (which proxies bytes, not
   framing).
2. **Client dial**: UnixStream connect → RFC6455 client handshake with URL `ws://localhost/rpc`
   (`app-server-client/src/remote.rs`, `UDS_WEBSOCKET_HANDSHAKE_URL`) → JSON-RPC, one message
   per text frame. No auth on UDS (0600 socket mode is the auth; bearer/JWT applies to
   non-loopback websocket listeners only).
3. **Daemon needs the managed standalone install** under `$CODEX_HOME/packages/standalone/
   current/codex` — a throwaway home works by symlinking the real `~/.codex/packages`.
4. **Live smoke results** (real daemon, 0.147.0): initialize OK (server echoes a composed
   userAgent), `thread/start {cwd, ephemeral:false}` OK (id + status=idle returned),
   `thread/resume {threadId}` on a FRESH thread fails `-32600 no rollout found` — a rollout
   exists only once a thread has recorded turns. The helper's real target (the user's live
   session thread) always has turns; the BATTERY must create its session thread with one real
   turn before attaching the helper (added to battery preconditions).
5. Helper + mock + tests all speak the measured transport (`ws-uds.mjs`, zero-dep RFC6455
   client+server-accept; 16/16 tests green on it).
