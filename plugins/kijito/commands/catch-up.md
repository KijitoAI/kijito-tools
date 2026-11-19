---
description: Catch up from Kijito memory - load what earlier conversations learned, read the current-state note, and recall before answering.
---

Catch up from the user's Kijito memory, following the kijito-catch-up skill:

1. Call `kijito_startup` once. Pass `persona=` or `project=` only if the user or their memory names one; never invent one.
2. Read the current-state note it names in full with `kijito_get`. Treat a retired record (Status `retired`, or importance near 0.1) as history, never as next steps.
3. Recall with `kijito_recall` before answering anything that may already be in memory.
4. Tell the user in two or three sentences where things stand and what is next. If the Kijito tools are not connected, say so once and point to the plugin's Connectors tab.
