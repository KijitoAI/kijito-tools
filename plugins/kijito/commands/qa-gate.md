---
description: Run a QA gate on the current work - adversarial passes from new angles, fix every finding, done only after two passes in a row find nothing.
---

Run a QA gate on the work in front of you, following the kijito-qa-gate skill:

1. `kijito_recall` what earlier gates on this kind of work caught, and attack that first.
2. Run adversarial passes, each from a new angle. A pass is GREEN only with zero findings; any finding makes it RED, so fix everything and the count goes back to zero.
3. Report one line per pass, and stop only after two consecutive GREEN passes.
4. Save each lesson the gate caught with `kijito_remember`, one per memory. If the gate cannot finish now, record its state (passes, angles, open findings) so the next conversation can continue it.
