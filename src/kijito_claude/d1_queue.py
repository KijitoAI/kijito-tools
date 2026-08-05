"""The D1 five-way queue state machine, transcript-side.

Implements §3's queue state machine from platform-fix-plan-20260804.md v15:

    enqueue -> dequeue   queue-exit, normally delivery
              -> remove    queue-exit: delivery as a `queued_command`
                           attachment, OR `remove -> NOTHING`, an on-disk LOSS
                           signature present at both OOMs
              -> popAll    STRANDED: payload returned to the input box
              -> NOTHING   ENQUEUED-ORPHANED, its own outcome

This module owns the OP layer only: reading queue-operation rows and pairing
each enqueue with its exit. Deciding whether an exit actually DELIVERED (the
row walk, the ordered dispatch, arbitration) is the row layer and lives
elsewhere -- the split matters because the op layer is decidable from queue
rows alone, while the row layer needs the conversation tree.

MEASURED GROUND TRUTH THIS IS BUILT ON
--------------------------------------
Two independently-written extractors (river, argus) over the same VM-local
corpus agree:

    enqueue  633-634   content-bearing 100%
    remove   391-393   content-bearing 100%
    popAll     3       content-bearing 100%
    dequeue  232-233   content-bearing   0%   <- the `content` KEY is absent
                                              entirely, not null

That asymmetry drives the whole design:

* enqueue<->remove and enqueue<->popAll pair by CONTENT IDENTITY, which is
  exact and order-independent.
* enqueue<->dequeue CANNOT pair by content -- there is no field. It pairs
  STRUCTURALLY (FIFO), and structural attribution is the known-broken one
  after a loss: three corpus files carry more removes than queued_command
  rows, so an ordinal walk silently shifts. Every ordinal pairing is therefore
  tagged, and tagged UNTRUSTED in any file showing a loss signature.

* `dequeue` is a BATCH DRAIN AT TURN END -- one row per item, co-drained items
  sharing a single timestamp to the millisecond (argus, session 58ebf332).
  So batch membership on this shape is EXACT stamp equality; the tolerance
  band is a fallback for other shapes, not the primary rule.

* The wake class travels 206/221 on `dequeue` (argus) -- i.e. overwhelmingly
  on the one shape where content attribution is structurally impossible. This
  is the dominant path for the exact class the plan exists to catch, not an
  edge case.

WHAT THIS MODULE WILL NOT DO
----------------------------
It does not guess. An enqueue whose exit cannot be established is reported as
such, with the reason, and never silently folded into a neighbouring outcome.
"""

import json
import os

__all__ = [
    "QueueOp",
    "QueueItem",
    "load_queue_ops",
    "file_has_timestamped_row_after",
    "pair_queue_ops",
    "EXIT_OPS",
]

ENQUEUE = "enqueue"
DEQUEUE = "dequeue"
REMOVE = "remove"
POPALL = "popAll"
EXIT_OPS = (DEQUEUE, REMOVE, POPALL)

# Outcomes at the OP layer. "Delivered" is deliberately absent -- the op layer
# cannot see delivery; it sees only how the item left the queue.
EXITED_VIA_DEQUEUE = "EXITED_VIA_DEQUEUE"
EXITED_VIA_REMOVE = "EXITED_VIA_REMOVE"
STRANDED = "STRANDED"
ENQUEUED_ORPHANED = "ENQUEUED_ORPHANED"
ENQUEUED_IN_FLIGHT = "ENQUEUED_IN_FLIGHT"

# Attribution strength of the enqueue->exit pairing.
ATTR_CONTENT = "content-identity"
ATTR_ORDINAL = "ordinal"
ATTR_ORDINAL_UNTRUSTED = "ordinal-untrusted-post-loss"
ATTR_NONE = "none"


class QueueOp(object):
    __slots__ = ("operation", "timestamp", "session_id", "content", "has_content_key", "line_no")

    def __init__(self, operation, timestamp, session_id, content, has_content_key, line_no):
        self.operation = operation
        self.timestamp = timestamp
        self.session_id = session_id
        self.content = content
        self.has_content_key = has_content_key
        self.line_no = line_no

    def __repr__(self):
        return "QueueOp(%s @ %s, content=%r)" % (
            self.operation, self.timestamp,
            (self.content[:30] + "...") if self.content and len(self.content) > 30 else self.content,
        )


class QueueItem(object):
    """One enqueue and whatever became of it."""

    __slots__ = ("enqueue", "exit_op", "outcome", "attribution", "note")

    def __init__(self, enqueue, exit_op, outcome, attribution, note=""):
        self.enqueue = enqueue
        self.exit_op = exit_op
        self.outcome = outcome
        self.attribution = attribution
        self.note = note

    @property
    def trusted(self):
        return self.attribution in (ATTR_CONTENT,)

    def __repr__(self):
        return "QueueItem(%s, attr=%s)" % (self.outcome, self.attribution)


def load_queue_ops(path):
    """Read the queue-operation rows of one transcript, in file order.

    Malformed lines are skipped but COUNTED by the caller's own reckoning --
    this returns only what it could parse, so a caller that needs to know about
    unparseable lines must ask for them separately rather than inferring
    completeness from a count that looks plausible.
    """
    ops = []
    with open(path, "r", errors="replace") as fh:
        for i, line in enumerate(fh, 1):
            if '"queue-operation"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "queue-operation":
                continue
            ops.append(
                QueueOp(
                    operation=d.get("operation"),
                    timestamp=d.get("timestamp"),
                    session_id=d.get("sessionId"),
                    content=d.get("content"),
                    has_content_key=("content" in d),
                    line_no=i,
                )
            )
    return ops


def file_has_timestamped_row_after(path, timestamp):
    """Is there any timestamped CONVERSATION row after `timestamp` in this file?

    This is the second half of the corrected ENQUEUED-ORPHANED predicate
    (pass-11 Opus m4). v12's wording was "the last row ever", which missed 3 of
    its own 7 specimens, because those files end in untimestamped file-history
    rows -- so "nothing follows it" was false by the letter while true in
    substance. The corrected test asks for a subsequent TIMESTAMPED row and
    ignores untimestamped trailers.
    """
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            if '"timestamp"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            ts = d.get("timestamp")
            if not ts or not isinstance(ts, str):
                continue
            if d.get("type") == "queue-operation":
                continue          # queue ops are not conversation rows
            if ts > timestamp:
                return True
    return False


def _file_shows_loss(items):
    """Does this file carry a loss signature that invalidates ordinal pairing?

    The plan states the ordinal fallback is known-broken AFTER losses (three
    files carry more removes than queued_command rows), so an ordinal pairing
    downstream of a loss in the same file cannot be trusted. Conservative by
    design: any orphan at all taints the file's ordinal pairings, because a
    single unaccounted enqueue is exactly what shifts a FIFO walk.
    """
    return any(i.outcome == ENQUEUED_ORPHANED for i in items)


T_HOST_HOURS_PROVISIONAL = 96.0


def classify_exitless(enqueue_ts, now_wall, freeze_since_boot_s=0.0,
                      session_is_live=None, t_host_hours=T_HOST_HOURS_PROVISIONAL):
    """An enqueue with no exit and nothing after it: ORPHANED, or still in flight?

    The plan's file-level test is TWO-VALUED -- ACTIVE / INACTIVE-SINCE-T --
    because a dead file has no monotonic clock, so SUSPENDED is not decidable
    post-mortem. T is 96 h **monotonic host-hours** (PROVISIONAL), NOT wall
    hours, and on a frozen host those differ enormously.

    WHY THIS FUNCTION EXISTS -- a defect this module shipped and this call
    caught: the first version declared ENQUEUED-ORPHANED the instant no
    conversation row followed, with no threshold at all. Scanning the same
    corpus twice minutes apart returned 8 orphans and then 7: the extra one was
    a LIVE session whose next row simply had not been written yet. An
    in-flight wake was being scored as an on-disk loss.

    LIVENESS TAKES PRECEDENCE over any clock: the plan's faster witness is
    "a live pane whose session-map entry points at the file", which collapses
    T entirely. `session_is_live=True` therefore short-circuits to in-flight.

    THE HOST-HOURS BOUND, and why it is conservative by construction:
    host_hours <= wall_hours always, so `wall_age >= T` is NECESSARY but NOT
    SUFFICIENT -- using wall age alone declares orphans EARLY, which is the
    unsafe direction (a false loss signature pages). Lacking per-row historical
    stamps, the defensible LOWER bound on host-hours for a row inside the
    current boot is `wall_age - freeze_since_boot`. Only when that lower bound
    clears T is ORPHANED asserted. Passing freeze_since_boot_s=0 recovers the
    naive wall-clock behaviour and is NOT recommended on a virtualised host.
    """
    if session_is_live:
        return ENQUEUED_IN_FLIGHT, "session is live (pane witness collapses T)"
    try:
        import calendar, datetime
        ts = enqueue_ts.replace("Z", "+00:00")
        enq_epoch = datetime.datetime.fromisoformat(ts).timestamp()
    except Exception:
        return (ENQUEUED_IN_FLIGHT,
                "enqueue timestamp unparseable (%r) -- refusing to score a loss "
                "signature off an unreadable clock" % (enqueue_ts,))

    wall_age_h = (now_wall - enq_epoch) / 3600.0
    host_lower_h = wall_age_h - (freeze_since_boot_s or 0.0) / 3600.0
    if host_lower_h >= t_host_hours:
        return (ENQUEUED_ORPHANED,
                "no exit, no subsequent row, and host-hours lower bound %.1f h "
                ">= T %.1f h (wall %.1f h, freeze %.1f h)"
                % (host_lower_h, t_host_hours, wall_age_h, (freeze_since_boot_s or 0) / 3600.0))
    return (ENQUEUED_IN_FLIGHT,
            "no exit and no subsequent row, but host-hours lower bound %.1f h "
            "< T %.1f h (wall %.1f h, freeze %.1f h) -- NOT yet declarable"
            % (host_lower_h, t_host_hours, wall_age_h, (freeze_since_boot_s or 0) / 3600.0))


def pair_queue_ops(ops, path=None, has_subsequent_row=None, now_wall=None,
                   freeze_since_boot_s=0.0, session_is_live=None,
                   t_host_hours=T_HOST_HOURS_PROVISIONAL):
    """Pair each enqueue with its exit and assign an op-layer outcome.

    `has_subsequent_row` is injected so the predicate is testable without a
    real file; when omitted and `path` is given, it is read from disk.

    Pairing order is deliberate:
      1. CONTENT IDENTITY for the content-bearing exits (remove, popAll),
         earliest unmatched enqueue with byte-identical content. Exact and
         order-independent.
      2. ORDINAL (FIFO) for `dequeue` only, because that shape carries no
         content field at all. Tagged, and downgraded to UNTRUSTED if the file
         shows a loss signature.
    A content-bearing exit that matches NO enqueue is reported rather than
    forced onto the oldest pending item -- forcing it is precisely how an
    ordinal walk manufactures a confident wrong attribution.
    """
    pending = []          # enqueues awaiting an exit, in file order
    items = []
    unmatched_exits = []

    for op in ops:
        if op.operation == ENQUEUE:
            pending.append(op)
            continue
        if op.operation not in EXIT_OPS:
            continue

        matched = None
        attribution = ATTR_NONE

        if op.operation in (REMOVE, POPALL):
            for idx, enq in enumerate(pending):
                if enq.content is not None and enq.content == op.content:
                    matched = pending.pop(idx)
                    attribution = ATTR_CONTENT
                    break
        elif op.operation == DEQUEUE:
            if pending:
                matched = pending.pop(0)
                attribution = ATTR_ORDINAL

        if matched is None:
            unmatched_exits.append(op)
            continue

        outcome = {
            DEQUEUE: EXITED_VIA_DEQUEUE,
            REMOVE: EXITED_VIA_REMOVE,
            POPALL: STRANDED,
        }[op.operation]
        items.append(QueueItem(matched, op, outcome, attribution))

    # Enqueues with no exit: orphaned vs still in flight.
    for enq in pending:
        if has_subsequent_row is not None:
            subsequent = has_subsequent_row(enq.timestamp)
        elif path is not None:
            subsequent = file_has_timestamped_row_after(path, enq.timestamp)
        else:
            raise ValueError("pair_queue_ops needs `path` or `has_subsequent_row`")
        if subsequent:
            items.append(
                QueueItem(enq, None, ENQUEUED_IN_FLIGHT, ATTR_NONE,
                          "no queue exit, but the file continues past it")
            )
            continue
        outcome, note = classify_exitless(enq.timestamp, now_wall=now_wall,
                                          freeze_since_boot_s=freeze_since_boot_s,
                                          session_is_live=session_is_live,
                                          t_host_hours=t_host_hours)
        items.append(QueueItem(enq, None, outcome, ATTR_NONE, note))

    # Post-loss ordinal downgrade. Done in a second pass because it depends on
    # the whole file's outcome set, which is not known while walking.
    if _file_shows_loss(items):
        for it in items:
            if it.attribution == ATTR_ORDINAL:
                it.attribution = ATTR_ORDINAL_UNTRUSTED

    items.sort(key=lambda i: (i.enqueue.timestamp or "", i.enqueue.line_no))
    return items, unmatched_exits


def scan_corpus(root, now_wall=None, freeze_since_boot_s=0.0,
                t_host_hours=T_HOST_HOURS_PROVISIONAL):
    """Walk a projects root, returning {path: (items, unmatched_exits)}.

    Absolute paths only: the session directories under ~/.claude/projects
    literally begin with '-', and a relative glob there expands to argv
    entries that grep and friends parse as OPTIONS -- which manufactures a
    confident ZERO in the exact shape of a real result (argus, 2026-08-05).
    """
    import time as _time
    root = os.path.abspath(root)
    if now_wall is None:
        now_wall = _time.time()
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if not fn.endswith(".jsonl"):
                continue
            p = os.path.join(dirpath, fn)
            ops = load_queue_ops(p)
            if not ops:
                continue
            out[p] = pair_queue_ops(
                ops, path=p, now_wall=now_wall,
                freeze_since_boot_s=freeze_since_boot_s,
                t_host_hours=t_host_hours,
            )
    return out
