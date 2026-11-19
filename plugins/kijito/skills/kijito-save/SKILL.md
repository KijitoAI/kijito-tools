---
name: kijito-save
description: Save to the user's Kijito memory. Use when a decision, a preference, a fact about the user, or a finished piece of work comes up, and before the conversation ends, so the next one can continue.
---

# Save to Kijito

Kijito keeps what matters across conversations. Save as things happen, not only at the end: a conversation can stop at any moment.

## What to save

- A decision and the reason for it; a preference or fact about the user; a finished piece of work and where it stands; a lesson learned the hard way.
- Skip small talk, anything only true for this conversation, and anything already in memory (`kijito_recall` first if you are unsure).

## Never save

- Passwords, API keys, tokens, card or account numbers, or any other credential or secret, even if the user pastes one.
- Anything the user asked you not to keep.

## How

1. One `kijito_remember` per insight. Five things are five calls, never one digest. Put the key concept first, in the words a later search would use: "The user prefers metric units in recipes", not "Noted a preference". Pass the same `persona=` and `project=` the conversation started with, or none if it used none. Importance: about 0.5 for useful context, 0.7 to 0.8 for a significant decision. Keep ordinary memories below 0.85, since those never fade.
2. When something in memory is now wrong, `kijito_correct` it (`original_id` = the old memory) instead of adding a new memory that contradicts it. When it simply no longer matters, `kijito_fade` it.
3. Keep one living current-state note for each ongoing piece of work: what is done, what is next, what to do first. Edit it in place with `kijito_update`; create it with `kijito_remember` if there is none.
4. Write the rule, not just today's examples: "the user wants every report in British English" is more useful later than "report 3 was in British English".

## Before the conversation ends

When the work wraps up or the user is leaving, ask yourself: "What did we decide or learn here that is not saved yet?" Expect to find something, and save it. Then update the current-state note so the next conversation can pick up from it.

## Quietly

Do not narrate each save. Mention one only when it helps the user to know, in a short line ("Saved: you prefer metric units."). Do tell the user when a save failed.
