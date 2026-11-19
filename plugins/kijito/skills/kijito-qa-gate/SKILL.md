---
name: kijito-qa-gate
description: Run a QA gate before calling work done. Use when the user asks to QA, review, check, or gate something: adversarial passes from new angles until two in a row find nothing.
---

# QA gate

A QA gate is how you prove work is done instead of saying it is. You attack the work in passes, fix what each pass finds, and stop only when two passes in a row find nothing.

## The rules

1. **Adversarial.** Every pass tries to BREAK the work, not to confirm it: wrong facts, contradictions, missing pieces, claims nobody checked, edge cases, steps that would fail, anything that would mislead the user. Assume there is something to find.
2. **Green means zero.** A pass is GREEN only if it finds nothing, at any severity, including small ones. Anything found makes it RED. If the user sets a different bar (for example "no blockers or should-fix items"), use theirs and say which bar you are using.
3. **Two green in a row.** The gate passes at two CONSECUTIVE green passes. Any finding resets the count to zero: fix everything it found, then start counting again.
4. **A new angle every pass.** Re-checking your own fixes is part of the red pass that found the problem, never a green pass. Each pass attacks from a different angle, for example: does every claim hold against the source; what is missing or left out; contradictions inside the work; the edge cases and failure paths; follow it end to end as the person who will use it; what the user asked for versus what was delivered; numbers and names checked one by one; what a skeptical expert would object to.
5. **Check against reality.** Read the source, run it, measure it, open the file. "It looks right" is not a check.
6. **Fresh eyes where you can.** If this host lets you start a separate reviewer (a subagent in Cowork or Claude Code), give it the work and the angle, not your conclusions. In a chat, review it yourself, and name the angle before each pass so it really is a different one.
7. **It takes as long as it takes.** Do not stop at the first green, and never call the work done before the second. Do not invent categories ("critical fixed, rest later") to finish early: anything still open is still open.

## Report as you go

One line per pass: `Pass 3 (edge cases): RED — 2 findings: …` or `Pass 4 (end to end as the user): GREEN`. At the end: `Gate passed: passes 4 and 5 green.` If you have to stop before that, say what is open.

## With Kijito

- Before the first pass, `kijito_recall` what earlier gates on this kind of work caught, and attack those first.
- For a gate that may not finish in this conversation, keep one living note with `kijito_remember`, then `kijito_update`: what is under review, the pass count, the angles used, and the open findings. The next conversation picks the gate up from there.
- When the gate passes, save each lesson a pass caught that will matter again, one per `kijito_remember` ("Checks of X miss Y unless you Z"), so the next gate starts sharper.
