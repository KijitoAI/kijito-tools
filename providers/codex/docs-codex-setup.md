# Codex CLI × Kijito — setup (gate-2 docs block)

Staged replacement for the docs' current one-sentence "In testing" entry (plan §8 item 3;
Cursor-parity config example). Target: kijito.ai docs Codex section + kijito-tools codex README.

## Memory (the product — one config block)

Either run:

```bash
codex mcp add kijito --url https://api.kijito.ai/mcp
```

(auto-detects OAuth: opens the authorize URL with a localhost callback), or add to
`~/.codex/config.toml` directly:

```toml
[mcp_servers.kijito]
url = "https://api.kijito.ai/mcp"
# Bearer alternative to OAuth, if you have an API token:
# http_headers = { "Authorization" = "Bearer YOUR_KIJITO_API_TOKEN" }
```

That is the whole install. Your agent now has persistent memory across sessions.

**Headless / scripted use — two sharp edges (plan §8):**
- `codex exec` silently cancels MCP tool calls that need approval ("user cancelled MCP
  tool call"). Pass `--approve-for-me` (see `codex exec --help`; `--full-auto` is not an
  exec flag as of 0.147).
- `codex mcp add` OAuth waits forever if no browser can open — on a headless box, use the
  Bearer-token config block instead.

## Skills (recommended)

Install the Codex skills (`kijito-start`, `kijito-qa-memory`) from kijito-tools
(`providers/codex/skills/`). `kijito-start` catches your session up at start — and, once
the live-wake feature is installed, joining the hive for a session is the same one command.

## Hive mail for a session (how the producer runs — gate-3 measured default)

When a session joins the hive, `kijito-start` runs **one producer child owned by that
session** (zero install steps; measured 2.9s to armed). It watches your inbox while the
session lives and dies with it; if it ever dies early, that is loud inside your session,
never silent. When no session is running, mail simply waits in your durable inbox — the
next session catches up at start. Users who want **always-on capture** (events recorded
even with no session open) can instead do the one-line supervised install (systemd user
unit / launchd) documented in the monitor README — optional, and unnecessary for the
default experience.

## Hive mail notifications (optional, count-only)

If you use hive mail and want a desktop notification with your unread count, wire Codex's
`notify` hook to the count shim:

```toml
notify = ["node", "/path/to/kijito-tools/providers/codex/notify/kijito-notify-count.mjs",
          "--persona", "YOUR_PERSONA", "--token-file", "/path/to/your/kijito_api_token"]
```

Honest semantics: Codex fires `notify` on its own turn lifecycle, so this tells you your
unread count when Codex finishes work — it is not a mail-arrival alert. The notification
is always count-only ("Kijito: persona — N unread"); message content never appears in a
notification. Live mail-arrival wake for a running session is the separate opt-in
live-wake feature (plan gate 5).
