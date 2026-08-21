---
name: kijito-recall
description: Recall patterns that make Kijito answer hard questions well — decompose multi-part questions into per-hop sub-queries, merge under a fixed context budget, chain entities between hops, and keep abstention discipline. Use when a question needs several distinct facts from memory (a "multi-hop" question), when a single recall came back with a compromise neighborhood that misses the point, or when deciding how deeply to retrieve before answering.
---

# Kijito Recall — aiming retrieval, not widening it

`kijito_recall` embeds ONE query vector per call. A question that bundles several facts — *"where
did X move after the job Y mentioned, and who introduced them?"* — retrieves a single compromise
neighborhood that can miss every one of its parts. The fix is not a deeper recall; it is more,
better-aimed recalls.

## The decomposition pattern (multi-part questions)

1. **Split** the question into at most ~3 self-contained sub-queries, each phrased in the words
   its answer was likely *stored* under (recall matches wording — front-loaded concrete terms beat
   abstractions).
2. **Recall each sub-query separately**, with a smaller `limit` per call (e.g. 3 recalls × limit 8
   instead of 1 × 24).
3. **Merge and dedup** the results yourself — and keep the TOTAL context you carry no larger than
   what one deep recall would have given you. Decomposition is for aiming, not for smuggling a
   bigger context load.
4. **Chain the hops.** When an early hop's answer names the entity the next hop needs, rewrite the
   next sub-query around that entity before recalling it.

## When NOT to decompose

Leave single-part questions alone. A decomposition step on a simple lookup adds latency and
near-miss context and helps nothing. Decompose only when the question genuinely needs several
distinct facts joined together.

## Abstention discipline

Abstain as readily as you would with a single recall. Decomposed retrieval surfaces more
adjacent-but-wrong material, and near-miss context is exactly what tempts a confident answer to a
question whose true answer is "that isn't in memory". If the merged results don't actually contain
a hop, say so — don't bridge the gap with plausibility.

## Related

- `kijito_guide(topic="recall")` — how recall scoring works (semantic + graph traversal + keyword
  boost) and why wording decides findability; this pattern is documented there too.
- `kijito_guide(topic="writing")` — writing memories so future sub-queries can find them.
