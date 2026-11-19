---
description: Save this conversation's decisions, preferences and finished work to Kijito memory, and update the current-state note for next time.
---

Save to the user's Kijito memory, following the kijito-save skill:

1. List what this conversation decided or learned that is not saved yet: decisions, preferences, facts about the user, finished work.
2. Save each one with its own `kijito_remember`, key concept first. Never save secrets, credentials or anything the user asked not to keep.
3. `kijito_correct` anything in memory that is now wrong instead of contradicting it.
4. Update the current-state note with `kijito_update` (create it if missing): what is done, what is next.
5. Reply with one short line saying how many memories were saved or corrected.
