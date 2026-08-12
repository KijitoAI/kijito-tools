"""D11 -- frozen-tool-call detector.

Implements §3's D11 from platform-fix-plan-20260804.md v15.

THE PREDICATE IS AN ABSENCE, AND THAT IS THE WHOLE DESIGN
---------------------------------------------------------
v10 keyed on the `tool_result` row -- which DOES NOT EXIST DURING THE FREEZE.
That detector was retrospective by construction: it could only page at the
instant the problem resolved. The plan's own recurring shape, in its newest
item: a predicate anchored on evidence that the failure itself suppresses.

So: an OPEN `tool_use` with no matching `tool_result`, whose age exceeds the
bound, pages. Evaluable at every instant from the transcript alone, during the
freeze, and it fires AT the bound rather than at resolution.

WHAT THIS DOES **NOT** DETECT, stated because a detector's scope is part of
its verdict:
  * Async dispatches. Agent/Monitor launches close their tool_result in
    seconds while the work runs on -- measured, all 3 Agent launches paired in
    2.2-3.4 s including a review still running 17 minutes later.
  * Pane-level gaps. 49 of 58 measured >1 h inter-row gaps have ZERO open
    tool_use: idle or async, not frozen. Absence-of-ROWS is D5's signal, not
    this one. Absence of a RESULT for an OPEN call is this one.

THE AGED SPAN IS tool_use ROW -> tool_result ROW. It includes harness dwell
and is NOT execution duration (measured: a `timeout 25 curl` spanned 32.2 min;
a "timed out after 2m 0s" result row landed 8.40 h after its tool_use). Valid
for DETECTION -- the agent is stuck either way -- and FORBIDDEN as an
execution-duration reading in classification.

THE AGE IS MONOTONIC, AND A SUSPENDED VERDICT DEFERS RATHER THAN PAGES.
A 15-minute WALL bound on a seat that freezes for hours would page on every
call spanning a suspension, with a wrong subtype. This seat was measured at
72.8 h frozen out of 121.1 h wall.
"""

import json
import os

__all__ = [
    "CLASSIFIER_UNKNOWN", "HEAVY", "LIGHT",
    "classify_command", "open_calls", "evaluate_open_calls",
    "OUT_OF_SCOPE_TOOLS", "BOUND_S_PROVISIONAL", "HEAVY_BOUND_S_PROVISIONAL",
]

CLASSIFIER_UNKNOWN = "CLASSIFIER-UNKNOWN"
HEAVY = "heavy"
LIGHT = "light"

# PROVISIONAL, per Clause 0 -- final derivation is ladybug's calibration.
# 15 min sits ~2.3x above the highest healthy call observed (397.3 s) and ~8x
# p99 (112.77 s) over a NAMED no-incident window of n=1,374 pairs. The earlier
# 171 s figure was withdrawn by its own author: it was the Aug-1 OOM night's
# p99, from a pooled corpus that was 65% incident traffic.
BOUND_S_PROVISIONAL = 15 * 60.0
# Heavy children (pytest/pip/npm/cargo/make/cmake/docker, and git/archive over
# the shared mount) routinely exceed that legitimately -- a 179-minute
# `git bundle` exists in the corpus and is NOT on D9's child list. Calibrating
# on review-only traffic would confirm a bound that breaks the first time a
# build runs.
HEAVY_BOUND_S_PROVISIONAL = 4 * 3600.0

# Scoped OUT with a stated reason, recorded in Clause 5's uncovered-class list.
# Both were measured and positive-controlled: Monitor children produce no
# agent-*.jsonl and no durable on-disk witness (21 calls, zero files); a
# Bash-backgrounded child has no file in this set and none anywhere on disk.
# "Age the child's file" was therefore UNIMPLEMENTABLE for these and failed
# OPEN. A hung backgrounded command is lost background WORK, not a frozen
# seat -- the synchronous class that motivated D11 stays fully covered.
#
# ⚠️ NOTE HOW EACH IS ACTUALLY EXCLUDED, because the two mechanisms differ and
# only one is enforced here. Monitor is excluded BY NAME, below. Bash's
# "moved to background" is excluded BY RELIANCE: a backgrounded call closes
# its tool_result promptly, so it never appears OPEN and never reaches the
# bound. That is true of the harness versions measured (2.1.220 / 2.1.222) and
# it is a VERSION-SCOPED ASSUMPTION, not an invariant -- if a future binary
# leaves background pairs open, this scope-out silently stops working and the
# class starts paging. Disclosed here so it is a stated dependency rather than
# an implicit one; re-check it when the binary version changes, which Clause 0
# already requires for the D1/D2 predicates.
OUT_OF_SCOPE_TOOLS = ("Monitor",)

_HEAVY_TOKENS = (
    "pytest", "pip ", "pip3", "npm ", "yarn ", "pnpm ", "cargo ", "make",
    "cmake", "docker", "uv run", "uv sync", "gradle", "mvn ", "go build",
    "go test", "git bundle", "git clone", "git archive", "tar ", "rsync ",
)
# GENUINELY opaque constructs: the payload is not in the command string at
# all, so no amount of parsing recovers it. These are the classifier's stated
# failure modes -- a wrapper that hides its payload, or a Makefile that runs
# pytest.
#
# NOTE what is NOT here: `&&`, `||`, `;`, `|`. A COMPOUND is not opaque -- it
# is several commands whose text you can read. Treating it as opaque made the
# plan's own named specimen (`cd ~/work/... && cat >> tests/...`, session
# 0af81116) page as CLASSIFIER-UNKNOWN, when it is plainly a light command.
# Fail-closed must mean "refuse what cannot be read", not "refuse what I did
# not bother to parse" -- otherwise the unknown bucket fills with decidable
# traffic and operators learn to ignore the subtype.
_OPAQUE_TOKENS = (
    "bash -c", "sh -c", "zsh -c", "eval ", "xargs", "nohup", "exec ",
    "$(", "`",
)
_COMPOUND_SEPARATORS = ("&&", "||", ";", "|")
# Deliberately conservative. Anything not here is UNKNOWN, and unknown pages.
# The list exists so that decidable traffic does not fill the unknown bucket
# (an operator who learns to ignore CLASSIFIER-UNKNOWN has no detector), NOT
# to be exhaustive -- a command whose cost is arguable belongs in UNKNOWN.
# `cd` earns its place because a compound is classified by its heaviest
# segment: without it, `cd /repo && pytest` reads UNDECIDABLE rather than
# HEAVY, which is the wrong answer in the noisy direction.
_LIGHT_TOKENS = (
    "ls", "cat", "head", "tail", "echo", "pwd", "wc", "stat", "grep", "rg",
    "find", "which", "date", "cd", "mkdir", "touch", "chmod", "printf",
    "sed", "awk", "cut", "sort", "uniq", "tr", "basename", "dirname",
    "realpath", "readlink", "diff", "true", "false", "sha256sum", "md5sum",
    "git status", "git log", "git diff", "git rev-parse", "git show",
    "git branch", "git remote", "systemctl", "journalctl", "pgrep", "ps",
)


def classify_command(tool_name, command=None):
    """Return (class, reason). The exemption key is tool name PLUS this.

    "Per-tool-class" alone is NOT a class: 11 of the 12 over-bound calls in the
    corpus are the single tool string `Bash`. So Bash is classified by a
    DECLARED classifier over `tool_use.input.command`.

    FAILS CLOSED. An undecidable command returns CLASSIFIER_UNKNOWN, which
    PAGES with that subtype -- never a silent exemption. A classifier that
    guesses on opaque input would hand back exactly the quiet pass an operator
    would read as "checked and fine".
    """
    if tool_name != "Bash":
        return LIGHT, "non-Bash tool %r is its own class" % tool_name
    if command is None:
        return CLASSIFIER_UNKNOWN, "Bash call with no command string to classify"

    segments = _split_compound(command)
    if len(segments) > 1:
        # Classify EACH segment and take the heaviest. Any undecidable segment
        # makes the whole call undecidable -- that is the fail-closed part,
        # and it survives decomposition.
        classes = [_classify_one(s) for s in segments]
        for cls, why in classes:
            if cls == CLASSIFIER_UNKNOWN:
                return CLASSIFIER_UNKNOWN, "compound with an undecidable segment: %s" % why
        if any(cls == HEAVY for cls, _ in classes):
            return HEAVY, "compound containing a heavy segment (%d segments)" % len(segments)
        return LIGHT, "compound, all %d segments light" % len(segments)
    return _classify_one(command)


def _split_compound(command):
    """Split on shell separators that are OUTSIDE quotes.

    Naive splitting is wrong in the noisy direction, and the corpus proves it:
    `grep -oE '"(defaultMode|permissionMode)"' …` is one light command, but a
    splitter that does not track quoting breaks it on the `|` INSIDE the
    pattern, produces nonsense segments, and reports CLASSIFIER-UNKNOWN. That
    fills the unknown bucket with decidable traffic -- and an operator who
    learns to ignore CLASSIFIER-UNKNOWN has no detector at all.

    This is a scanner, not a shell parser, and it does not pretend otherwise:
    it tracks single quotes, double quotes and backslash escapes. Constructs
    it cannot see through (`$(...)`, backticks) are handled upstream by the
    OPAQUE list, which is the correct answer for them anyway.
    """
    parts, buf = [], []
    quote = None
    i = 0
    while i < len(command):
        ch = command[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < len(command):
                buf.append(command[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < len(command):
            buf.append(ch)
            buf.append(command[i + 1])
            i += 2
            continue
        matched = None
        for sep in _COMPOUND_SEPARATORS:
            if command.startswith(sep, i):
                matched = sep
                break
        if matched:
            parts.append("".join(buf))
            buf = []
            i += len(matched)
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def _classify_one(command):
    low = " " + command.strip().lower()

    # Opaque outranks a heavy match: a heavy token appearing INSIDE a wrapper
    # does not make the wrapper's payload decidable.
    for tok in _OPAQUE_TOKENS:
        if tok in low:
            return (CLASSIFIER_UNKNOWN,
                    "opaque construct %r -- payload not decidable from the "
                    "command string" % tok)
    # D11-F1: heavy tokens match at COMMAND POSITION, not as a substring
    # anywhere in the line -- symmetric with the discipline the light list
    # already used. Substring matching classified `grep pytest test.log` as
    # HEAVY (4 h bound) and `cat Makefile` as HEAVY, inflating detection
    # latency 16x in the QUIET direction on exactly the commands a
    # review-heavy fleet runs all day. A command that MENTIONS pytest is not
    # a command that RUNS pytest.
    norm = " ".join(low.split())
    for tok in _HEAVY_TOKENS:
        t = tok.strip()
        if norm == t or norm.startswith(t + " "):
            return HEAVY, "heavy-child command %r" % t
    for tok in _LIGHT_TOKENS:
        if norm == tok or norm.startswith(tok + " "):
            return LIGHT, "known-light command %r" % tok
    return (CLASSIFIER_UNKNOWN,
            "command %r matches no declared class" % (command.strip()[:40],))


def _iter_parts(row):
    m = row.get("message")
    if not isinstance(m, dict):
        return []
    c = m.get("content")
    return c if isinstance(c, list) else []


def open_calls(rows):
    """tool_use rows with no matching tool_result, in file order.

    Returns a list of dicts: id, name, input, timestamp, row_index.
    Out-of-scope tools are excluded HERE rather than filtered later, so a
    caller cannot accidentally page on a class the plan records as uncovered.
    """
    started = {}
    finished = set()
    for i, row in enumerate(rows):
        rtype = row.get("type")
        for p in _iter_parts(row):
            if not isinstance(p, dict):
                continue
            if rtype == "assistant" and p.get("type") == "tool_use":
                started[p.get("id")] = {
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "input": p.get("input") or {},
                    "timestamp": row.get("timestamp"),
                    "row_index": i,
                }
            elif rtype == "user" and p.get("type") == "tool_result":
                finished.add(p.get("tool_use_id"))
    out = []
    for cid, rec in started.items():
        if cid in finished:
            continue
        if rec["name"] in OUT_OF_SCOPE_TOOLS:
            continue
        out.append(rec)
    out.sort(key=lambda r: r["row_index"])
    return out


def evaluate_open_calls(rows, now_wall, freeze_lookup=None, suspend_verdict=None,
                        boot_wall=None,
                        bound_s=BOUND_S_PROVISIONAL,
                        heavy_bound_s=HEAVY_BOUND_S_PROVISIONAL):
    """Assess every open call. Returns a list of findings.

    `suspend_verdict` is §5b(b)'s three-way HEALTHY / STALE / SUSPENDED. On
    SUSPENDED the evaluator DEFERS -- it does not page, and it does not
    silently drop the call either; it returns a DEFERRED finding so the
    deferral is visible rather than being an absence of output.

    `freeze_lookup(t0, t1) -> seconds` supplies host freeze inside the call's
    own window, so the age is monotonic (executing) time. Without it the age
    cannot be established and the call is reported UNDECIDABLE rather than
    aged by wall clock -- wall age OVERSTATES executing time and would page
    on every call spanning a freeze.
    """
    import datetime

    findings = []
    for call in open_calls(rows):
        cls, reason = classify_command(call["name"], (call["input"] or {}).get("command"))
        limit = heavy_bound_s if cls == HEAVY else bound_s

        try:
            ts = (call["timestamp"] or "").replace("Z", "+00:00")
            started = datetime.datetime.fromisoformat(ts).timestamp()
        except Exception:
            findings.append(dict(call=call, verdict="UNDECIDABLE", cls=cls,
                                 reason="unparseable tool_use timestamp %r" % call["timestamp"]))
            continue

        wall_age = now_wall - started
        if suspend_verdict == "SUSPENDED":
            findings.append(dict(call=call, verdict="DEFERRED", cls=cls, wall_age_s=wall_age,
                                 reason="host verdict SUSPENDED -- deferring, never paging; "
                                        "a wall bound would page on every call spanning a freeze"))
            continue

        if freeze_lookup is None:
            findings.append(dict(call=call, verdict="UNDECIDABLE", cls=cls, wall_age_s=wall_age,
                                 reason="no freeze data: monotonic age cannot be established, and "
                                        "wall age overstates executing time. Refusing to page on it."))
            continue

        # D11-F2: THE freeze_lookup CONTRACT. A journal-backed provider can
        # only see the CURRENT boot, so for a call whose tool_use predates it
        # the prior boots' freezes are invisible, `mono_age` OVERSTATES, and
        # the call pages EARLY -- the same aggregate hazard fixed in d1_queue
        # (L2-F1). Stated here rather than left to the provider, so a future
        # provider that merely satisfies the signature cannot reintroduce it.
        if boot_wall is not None and started < boot_wall:
            frozen = freeze_lookup(boot_wall, now_wall)
            mono_age = (now_wall - boot_wall) - frozen
        else:
            frozen = freeze_lookup(started, now_wall)
            mono_age = wall_age - frozen

        if cls == CLASSIFIER_UNKNOWN and mono_age > bound_s:
            findings.append(dict(call=call, verdict="PAGE", subtype=CLASSIFIER_UNKNOWN, cls=cls,
                                 mono_age_s=mono_age, wall_age_s=wall_age,
                                 reason="undecidable classification, over base bound -- fails "
                                        "CLOSED: %s" % reason))
            continue

        if mono_age > limit:
            findings.append(dict(call=call, verdict="PAGE", subtype="FROZEN-CALL", cls=cls,
                                 mono_age_s=mono_age, wall_age_s=wall_age,
                                 reason="open %.1f min monotonic (wall %.1f min) > bound %.1f min [%s]"
                                        % (mono_age / 60, wall_age / 60, limit / 60, reason)))
        else:
            findings.append(dict(call=call, verdict="OK", cls=cls, mono_age_s=mono_age,
                                 wall_age_s=wall_age, reason=reason))
    return findings


def subagent_files(session_path):
    """`<session>/subagents/agent-*.jsonl` for a pane transcript path.

    Scope is the armed pane's transcript AND every subagent file under that
    session: all 1,043 sidechain tool_use rows in the corpus live in subagent
    files, none in a pane transcript, and a subagent's Bash call is exactly
    D11's synchronous class.

    Parent-side rule for handle-returning dispatch is Agent ONLY -- age the
    CHILD's file, not the parent's pair (measured 59 Agent calls <-> 59 child
    files exactly). Monitor and Bash-background have no child file at all and
    are scoped out rather than failed open.
    """
    base = session_path[:-6] if session_path.endswith(".jsonl") else session_path
    d = os.path.join(base, "subagents")
    if not os.path.isdir(d):
        return []
    return sorted(os.path.join(d, f) for f in os.listdir(d)
                  if f.startswith("agent-") and f.endswith(".jsonl"))


def load_rows(path):
    rows = []
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                rows.append(d)
    return rows
