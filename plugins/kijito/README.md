# Kijito

Persistent memory for your AI across chats, Cowork and Claude Code. With this plugin, Claude catches
up on what earlier conversations learned before it starts on your task, and saves decisions,
preferences and finished work as they come up, so the next conversation continues instead of
starting from zero. It works the same way in claude.ai chat, in Cowork and in Claude Code.

## What it contains

- **Kijito connector** (`.mcp.json`): the Kijito MCP server at `https://api.kijito.ai/mcp`. Installing
  the plugin signs you in to nothing; you connect it yourself (below).
- **`kijito-catch-up` skill**: at the start of a conversation Claude calls `kijito_startup`, reads your
  current-state note, and recalls from memory before answering anything you may have covered before.
- **`kijito-save` skill**: Claude saves one insight per memory, corrects what is now wrong instead of
  contradicting it, keeps a current-state note up to date, and never saves secrets.
- **`kijito-qa-gate` skill**: before calling work done, Claude attacks it in adversarial passes, each
  from a new angle, fixes every finding, and stops only after two passes in a row find nothing. It
  recalls what earlier gates caught, keeps the gate's state in memory so it can continue next time,
  and saves the lessons each pass caught.
- **Commands** `/kijito:catch-up`, `/kijito:save` and `/kijito:qa-gate` (Cowork and Claude Code; in
  chat they load as skills).
- **A SessionStart hook** (Cowork and Claude Code; chat ignores hooks) that reminds Claude to catch up.
  It stays silent when the kijito-tools Claude Code hook is already installed, so you never get two
  reminders.

## Use it

1. Install the plugin: in claude.ai or the desktop app go to **Customize > Plugins > Add > Add
   marketplace**, enter `KijitoAI/kijito-tools`, then install **Kijito**. In Claude Code:
   `claude plugin marketplace add KijitoAI/kijito-tools` and `claude plugin install kijito@kijito-tools`.
2. Connect the Kijito connector on the plugin's **Connectors** tab and sign in with your Kijito account
   ([kijito.ai](https://kijito.ai)). If you already added Kijito as a custom connector, it
   uses the same URL, so you see one set of tools.
3. Start a conversation. Claude catches up on its own; you can also ask it to "catch up from Kijito" or
   to "save this to memory", ask it to "QA gate this", or type `/kijito:catch-up`, `/kijito:save` and `/kijito:qa-gate` in Cowork
   and Claude Code.

## What data it sends

The plugin itself stores and sends nothing. Through the Kijito connector, Claude sends the
conversation content it chooses to save (decisions, preferences, facts and work summaries), and the
questions it recalls with, to your own Kijito account at `api.kijito.ai`. The skills tell Claude never
to save passwords, keys or other secrets, or anything you ask it not to keep. To change what is kept,
ask Claude to correct or fade a memory; it uses the same Kijito tools. Privacy policy:
[kijito.ai/privacy](https://kijito.ai/privacy). Terms: [kijito.ai/terms](https://kijito.ai/terms).

## License

Apache 2.0. Copyright 2026 Arcada Labs.
