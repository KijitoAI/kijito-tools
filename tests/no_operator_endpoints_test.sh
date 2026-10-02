#!/usr/bin/env bash
# Nothing we SHIP may carry an operator-private endpoint.
#
# WHY THIS EXISTS (river 10985, from the 2026-09-30 M312 cold reruns). kijito-start/SKILL.md shipped
# river's PROD-PAGER ntfy topic URL, and a `while true; curl` Monitor for it, to every user: anyone who
# installed kijito-tools could read the fleet's pages or publish fake ones. It also scared a stranger
# agent off the catch-up entirely. An ntfy topic is a bearer capability — its name IS the secret — so
# the rule is: no concrete ntfy topic URL anywhere in the shipped payload. Generic mentions of ntfy
# ("ntfy remains optional") are fine; a URL that names a topic is not.
#
#   bash tests/no_operator_endpoints_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

# A concrete topic: ntfy.sh/<name>, with or without a scheme. Topic names are [-_A-Za-z0-9].
PAT='ntfy\.sh/[-_A-Za-z0-9]{3,}'
# What the packages ship (npm files[] / wheel include): the installer, bin, src and every provider.
SHIPPED=(install.sh bin src providers)

scan() {  # $1 = root; prints offending file:line matches
  (cd "$1" && grep -rnEI "$PAT" "${SHIPPED[@]}" 2>/dev/null)
}

echo "shipped payload carries no operator-private endpoint:"
hits=$(scan "$REPO")
if [ -z "$hits" ]; then grn "no concrete ntfy topic URL in: ${SHIPPED[*]}"
else red "operator endpoint shipped:"; printf '        %s\n' "$hits"; fi

# Positive control: the scanner must catch the exact line that shipped before this fix.
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/providers/claude/skills/kijito-start"
printf '%s\n' '     `Monitor(command="while true; do curl -N -s --max-time 86400 https://ntfy.sh/kijito-prod-000000000000/json 2>/dev/null")`' \
  > "$T/providers/claude/skills/kijito-start/SKILL.md"
if [ -n "$(scan "$T")" ]; then grn "control: the scanner catches the pre-fix skill line"
else red "control: the scanner MISSED a planted ntfy topic URL - it cannot be trusted"; fi
printf '%s\n' 'Opt-in config only; ntfy remains entirely optional.' > "$T/providers/claude/skills/kijito-start/SKILL.md"
if [ -z "$(scan "$T")" ]; then grn "control: a generic mention of ntfy is allowed"
else red "control: a generic ntfy mention was flagged"; fi

# ── M440: the AGENT-FACING text we ship carries no operator-specific rules or claimed authority ─────
# The M312 Sonnet cold run (2026-10-02, river 11324) read the kijito-qa-memory skill's "Jason's standing
# rule" lines and its "pre-authorized - Jason's standing ruling" subagent note as PROMPT INJECTION, and
# saved a memory distrusting the skill. To a stranger, a named person's "standing ruling" inside a
# downloaded skill is exactly what an injection looks like, so the skills and the doctrine snippet may name
# no operator or fleet persona and claim no pre-authorization; anything account-specific comes from the
# user's own memory at run time. (Scripts' code COMMENTS are history for maintainers and are not scanned.)
# The codex provider's skills are the codex lane's surface (and "Codex" is a product name there): scoped out
# here and raised with their owner, not silently exempted by a pattern.
AGENT_TEXT=(providers/claude/skills providers/claude/CLAUDE.md.snippet)
OPAT='\b(jason|river|ladybug|cadence|assay|argus|vellum|crucible|praetor|sterling|herald|mason|loom)\b|pre-authori[sz]ed|standing rul(e|ing)|\bfleet\b'
oscan() {  # $1 = root; prints offending file:line matches
  (cd "$1" && grep -rniEI "$OPAT" "${AGENT_TEXT[@]}" 2>/dev/null | grep -vE '^[^:]*:[0-9]+:.*on a cadence')
}
echo "agent-facing text names no operator and claims no authority (M440):"
hits=$(oscan "$REPO")
if [ -z "$hits" ]; then grn "skills + doctrine snippet: no operator names, no standing rules, no pre-authorization"
else red "operator-specific text shipped to strangers:"; printf '        %s\n' "$hits" | cut -c1-220; fi
mkdir -p "$T/providers/claude/skills/kijito-qa-memory"
printf '%s\n' "spawning the cold-boot verifier is **pre-authorized and user-requested** — Jason's standing ruling" \
  > "$T/providers/claude/skills/kijito-qa-memory/SKILL.md"
if [ -n "$(oscan "$T")" ]; then grn "control: the scanner catches the pre-fix pre-authorization line"
else red "control: the scanner MISSED a planted pre-authorization line - it cannot be trusted"; fi
printf '%s\n' 'poll kijito_hive_inbox on a cadence until the producer is back' > "$T/providers/claude/skills/kijito-qa-memory/SKILL.md"
if [ -z "$(oscan "$T")" ]; then grn "control: the ordinary word 'cadence' is allowed"
else red "control: the ordinary word 'cadence' was flagged"; fi

echo; echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
