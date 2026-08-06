"""D1 row layer: ordered dispatch + the delivery walk.

Implements §3's ORDERED, EXHAUSTIVE dispatch and the walk with the corrected
terminal set, from platform-fix-plan-20260804.md v15.

The op layer (d1_queue) answers "how did this item leave the queue". This
layer answers "did a wake actually reach the model", which needs the
conversation tree and cannot be decided from queue rows alone.

THE DISPATCH IS ORDERED AND EXHAUSTIVE. Evaluated per nonce-bearing row, in
order, first match wins:

  (1) attachment row, attachment.type == "queued_command", nonce in
      attachment.prompt                                 -> queued_command-shape
  (2) string-content user row whose content matches an `enqueue` row in the
      same file by CONTENT IDENTITY                      -> dequeue-shape
  (3) string-content user row carrying a nonce with NO enqueue row in this
      file containing it                                 -> BOX-RETURN
  (4) anything else nonce-bearing                        -> BLOCKED + page

Why (3)'s criterion is enqueue-ABSENCE and not dequeue-absence: enqueues are
content-bearing (measured 633/633), so their absence is DECIDABLE. Dequeues
carry no content field at all (232/232 -- the key is absent, not null), so
dequeue-absence is not decidable and is never used as a predicate.

`promptSource` is recorded as origin metadata on EVERY branch and dispatches
NONE of them. It encodes ORIGIN, not ROUTE: "typed" appears on
machine-injected box submissions, and 15/221 dequeues are not "system". The
nonce is the only route discriminator. This is a standing ban, not a
preference -- a predicate keying on promptSource is wrong even when it
happens to agree.

VALIDATION STATUS -- UPDATED 2026-08-06; the previous text is now FALSE.
It said the producer nonce was undeployed and that shape classification was
"exercised only by fixtures". The nonce SHIPPED at 22:11Z and there are now
REAL-CORPUS WITNESSES: a live `attachment` row carrying producer nonce
`UPiOOkYlddY` classifies `queued_command-shape` off real data (ladybug), and
river's own first wake `vMYAuAui13J` classified `dequeue-shape` -> DELIVERED.
⚠️ Still bounded: single-digit specimens, HAPPY paths only. BOX-RETURN,
STACK-FLUSH, ATTRIBUTION-UNCERTAIN and BLOCKED remain fixture-only. Do not
read "has real witnesses" as "validated".

🔴 CONSTRAINT ON WHOEVER WRITES THE DRIVER -- READ BEFORE SELECTING ROWS.
`dispatch_shape` classifies ONE row you have ALREADY decided is a wake
candidate. There is no production caller yet, so this is a design input
arriving before the mistake rather than a bug report.

  SELECT CANDIDATE ROWS BY *TYPE* FIRST -- attachment, or string-content
  user -- AND ONLY THEN TEST FOR THE NONCE.
  NEVER select by "any row whose JSON contains the nonce".

Measured on one live transcript: 5 rows carried a real nonce and only ONE
was the wake. The other four -- two `queue-operation`, one `user`, one
`assistant` -- all fall through to branch (4) and PAGE: ~4 false pages per
genuine wake, with 12 distinct real nonces already sitting on
`queue-operation` rows in that single file.

⛔ DO NOT "fix" this by widening branch (4) to swallow `queue-operation`.
Branch (4) exists so an unanticipated shape PAGES instead of vanishing;
widening it trades a false-page problem for a SILENT-ALARM one, which is
strictly worse and is the direction this whole plan exists to prevent.

★ WHY THE CONTAMINATION IS STRUCTURAL, NOT ONE SEAT'S UNTIDINESS: those
`queue-operation` rows are the inbox Monitor's own `<task-notification>`
text, which embeds the raw producer event JSON -- nonce included -- into the
very transcript D1 reads. Every persona is instructed to tail its own event
stream, so THE BEST-INSTRUMENTED SEATS ARE THE MOST CONTAMINATED: the
observer's instrument writes into the record the observer is measuring.
(The `user`/`assistant` hits are a different, non-structural class -- an
agent quoting a nonce in prose. A quieter seat carries fewer.)
"""

import json
import os

__all__ = [
    "Row", "load_rows", "RowIndex",
    "dispatch_shape", "walk_delivery",
    "SHAPE_QUEUED_COMMAND", "SHAPE_DEQUEUE", "SHAPE_BOX_RETURN", "SHAPE_BLOCKED",
    "DELIVERED", "PENDING", "SUPERSEDED",
]

ATTRIBUTION_UNCERTAIN = "ATTRIBUTION-UNCERTAIN"

SHAPE_QUEUED_COMMAND = "queued_command-shape"
SHAPE_DEQUEUE = "dequeue-shape"
SHAPE_BOX_RETURN = "BOX-RETURN"
SHAPE_BLOCKED = "BLOCKED"

DELIVERED = "DELIVERED"
PENDING = "PENDING"
SUPERSEDED = "SUPERSEDED"

# Row types the walk may traverse THROUGH without deciding anything.
_TRANSPARENT_TYPES = ("attachment", "system")


class Row(object):
    __slots__ = ("type", "uuid", "parent", "timestamp", "raw", "line_no")

    def __init__(self, d, line_no):
        self.type = d.get("type")
        self.uuid = d.get("uuid")
        self.parent = d.get("parentUuid")
        self.timestamp = d.get("timestamp")
        self.raw = d
        self.line_no = line_no

    # -- content helpers -------------------------------------------------
    def message_content(self):
        m = self.raw.get("message")
        if not isinstance(m, dict):
            return None
        return m.get("content")

    def is_string_content_user(self):
        """A `user` row whose message content is a STRING, not a list.

        The distinction is load-bearing in the spec: list-content user rows
        are tool results and injected material -- the walk passes THROUGH
        them, while a string-content user row is a real submission and can
        terminate the walk.
        """
        return self.type == "user" and isinstance(self.message_content(), str)

    def text(self):
        c = self.message_content()
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return " ".join(
                p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text"
            )
        return ""

    def attachment_type(self):
        a = self.raw.get("attachment")
        return a.get("type") if isinstance(a, dict) else None

    def attachment_prompt(self):
        a = self.raw.get("attachment")
        return a.get("prompt") if isinstance(a, dict) else None

    def prompt_source(self):
        return self.raw.get("promptSource")

    def origin_kind(self):
        o = self.raw.get("origin")
        return o.get("kind") if isinstance(o, dict) else None

    def __repr__(self):
        return "Row(%s %s @ %s)" % (self.type, (self.uuid or "")[:8], self.timestamp)


def load_rows(path):
    rows = []
    with open(path, "r", errors="replace") as fh:
        for i, line in enumerate(fh, 1):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                rows.append(Row(d, i))
    return rows


class RowIndex(object):
    """uuid -> row, and parentUuid -> children, in file order."""

    def __init__(self, rows):
        self.rows = rows
        self.by_uuid = {}
        self.children = {}
        for r in rows:
            if r.uuid:
                self.by_uuid[r.uuid] = r
            if r.parent:
                self.children.setdefault(r.parent, []).append(r)

    def enqueue_contents(self):
        """Every `enqueue` op content in this file (content-bearing, 633/633)."""
        out = []
        for r in self.rows:
            if r.type == "queue-operation" and r.raw.get("operation") == "enqueue":
                c = r.raw.get("content")
                if c is not None:
                    out.append(c)
        return out


def dispatch_shape(row, index, nonce, enqueue_contents=None):
    """Classify ONE nonce-bearing row. Ordered, exhaustive, first match wins.

    Returns (shape, reason). Never returns None: an unrecognised nonce-bearing
    row is BLOCKED, which pages -- silence is not an option here, because a
    shape nobody anticipated is exactly what an unnoticed regression looks
    like.
    """
    if enqueue_contents is None:
        enqueue_contents = index.enqueue_contents()

    # (1) queued_command attachment
    if row.type == "attachment" and row.attachment_type() == "queued_command":
        p = row.attachment_prompt() or ""
        if nonce in p:
            return SHAPE_QUEUED_COMMAND, "attachment.prompt carries the nonce"

    # (2) string-content user row content-identical to an enqueue
    if row.is_string_content_user():
        content = row.message_content()
        if any(content == c for c in enqueue_contents):
            return SHAPE_DEQUEUE, "content-identical to an enqueue row in this file"

        if nonce in (content or ""):
            # (2-fallback) L3-F1: content identity is PRIMARY, but the spec
            # keeps a residue -- rows whose content is NOT byte-identical to
            # any enqueue while an enqueue for that nonce plainly exists. A
            # box-edited or truncated payload is exactly that, and a box edit
            # is a HUMAN action we know occurs (popAll returns payloads to an
            # editable box). The spec scores this dequeue-shape and tags it
            # ATTRIBUTION-UNCERTAIN with a published rate, NOT in N.
            #
            # Without this branch the row fell through (2), failed (3)'s
            # no-enqueue-contains-it criterion, and landed in (4) -> BLOCKED
            # + page. That converts a class the plan HONESTLY DISCLOSES into
            # a false page. Measured 0/181 today, so there is no corpus
            # witness -- the branch rests on the spec and on fixtures, and
            # that is stated rather than implied.
            if any(nonce in (c or "") for c in enqueue_contents):
                return (SHAPE_DEQUEUE + "|" + ATTRIBUTION_UNCERTAIN,
                        "nonce-bearing enqueue exists but content is not "
                        "byte-identical (box-edited or truncated) -- "
                        "ATTRIBUTION-UNCERTAIN, rate published, never in N")

            # (3) nonce present and NO enqueue in this file contains it.
            # Enqueue-ABSENCE is decidable because enqueues are content-bearing.
            return (SHAPE_BOX_RETURN,
                    "nonce present, no enqueue row in this file contains it "
                    "-- reached the box without transiting this session's queue")

    # (4) anything else nonce-bearing
    return (SHAPE_BLOCKED,
            "nonce-bearing row matched no dispatch branch (type=%r, attachment=%r)"
            % (row.type, row.attachment_type()))


def _is_terminal(row, batch_key_of, my_batch_key):
    """The corrected terminal set (v9's 'independently validated' tag struck).

    A string-content user row terminates the walk iff it is a genuine, DIFFERENT
    submission: origin.kind == "human", or promptSource in {typed, system},
    AND it belongs to a DIFFERENT batch. Batch siblings are NOT terminal --
    co-delivered items share a turn and must not cut each other's walk short.
    """
    if not row.is_string_content_user():
        return False
    if row.origin_kind() == "human" or row.prompt_source() in ("typed", "system"):
        return batch_key_of(row) != my_batch_key
    # A promptSource-ABSENT injected row is explicitly NON-terminal.
    return False


def walk_delivery(start, index, batch_key_of=None, my_batch_key=None):
    """Walk parentUuid descendants of `start` for an assistant row.

    Returns (verdict, evidence_row):
      DELIVERED  an assistant row is reachable  -> the model saw it
      SUPERSEDED a terminal from a DIFFERENT batch was reached first
      PENDING    the walk reached a live tail with neither

    Structural bound, no hop count: the tree is finite and each row is visited
    once. PENDING is NOT a loss -- LOST is declarable only by the arbitration
    rule (monotonic deadline expiry AND a failed content-identity search over
    subsequent rows), which lives with the caller.
    """
    if batch_key_of is None:
        raise ValueError(
            "walk_delivery requires batch_key_of. There is deliberately NO "
            "default: keying each row by its own uuid makes every sibling a "
            "DIFFERENT batch, which silently disables the batch-sibling "
            "protection in the terminal set. Measured consequence -- co-drained "
            "ECHO-1/ECHO-2, one millisecond apart, had ECHO-1 scored SUPERSEDED "
            "by its own batch sibling. A convenience default that disables a "
            "protective clause is worse than a required argument. Use "
            "batch_keys_from_ops(index)."
        )
    if my_batch_key is None:
        my_batch_key = batch_key_of(start)

    seen = set()
    stack = list(index.children.get(start.uuid, []))
    while stack:
        row = stack.pop(0)
        if row.uuid in seen:
            continue
        seen.add(row.uuid)

        if row.type == "assistant":
            return DELIVERED, row
        if _is_terminal(row, batch_key_of, my_batch_key):
            return SUPERSEDED, row

        # Traverse THROUGH transparent rows, list-content user rows (tool
        # results / injected material) and batch siblings.
        if row.type in _TRANSPARENT_TYPES or row.type == "user":
            stack.extend(index.children.get(row.uuid, []))
            continue
        # Unknown row types are traversed rather than treated as terminal:
        # a new harness row type must not silently convert DELIVERED into
        # PENDING. If it should terminate, the terminal set is what changes.
        stack.extend(index.children.get(row.uuid, []))

    return PENDING, None


def batch_keys_from_ops(index, tolerance_s=0.5):
    """Build a `batch_key_of(row)` from this file's queue ops, per §3.

    Membership is the DELIVERING-OP INSTANT, not the row's own stamp.

    · Content-bearing exits (`remove`, `popAll`) map to their item EXACTLY, so
      those rows get their delivering op's stamp as the key with no guessing.
    · `dequeue` carries no content, but co-drained items share ONE stamp to
      the millisecond (argus, 58ebf332), so exact stamp equality groups them.
      Attributing WHICH user rows belong to a given dequeue batch is the
      ordinal problem again, so rows are grouped to the nearest dequeue
      instant within `tolerance_s` and the grouping is APPROXIMATE -- this is
      the seam, and it is labelled rather than hidden.
    · Anything with no delivering op gets a SINGLETON key (its own uuid), per
      the pass-11 rule that BOX-RETURN and the attribution-uncertain residue
      must still have a defined batch.
    """
    import datetime

    def _epoch(ts):
        try:
            return datetime.datetime.fromisoformat((ts or "").replace("Z", "+00:00")).timestamp()
        except Exception:
            return None

    # L3-F2: keys are assigned PER OCCURRENCE, not via a content dict.
    # A content dict collapses duplicates: pre-nonce, recurring heartbeats are
    # byte-identical BY CONSTRUCTION, so two wakes removed days apart would
    # share the FIRST remove's stamp, become "batch siblings", and go
    # non-terminal to each other in the walk -- masking genuine supersession
    # across days. Post-nonce contents are unique and this dissolves, but the
    # corpus validated here is pre-nonce, so it was live.
    exits = []          # content-bearing exits in file order, consumed once each
    dequeue_stamps = []
    for r in index.rows:
        if r.type != "queue-operation":
            continue
        op = r.raw.get("operation")
        if op in ("remove", "popAll"):
            c = r.raw.get("content")
            if c is not None:
                exits.append([c, r.timestamp, False])      # [content, stamp, used]
        elif op == "dequeue":
            e = _epoch(r.timestamp)
            if e is not None:
                dequeue_stamps.append((e, r.timestamp))
    dequeue_stamps.sort()

    # Precompute row -> key in FILE ORDER so assignment is deterministic and
    # each exit is claimed at most once. key_of must stay a pure lookup:
    # consuming state inside it would make the answer depend on call order.
    keys = {}
    for row in index.rows:
        if not row.is_string_content_user():
            continue
        c = row.message_content()
        chosen = None
        for slot in exits:
            if not slot[2] and slot[0] == c:
                slot[2] = True
                chosen = "op:%s" % slot[1]
                break
        if chosen is None:
            e = _epoch(row.timestamp)
            if e is not None:
                for stamp_e, stamp_s in dequeue_stamps:
                    if abs(stamp_e - e) <= tolerance_s:
                        chosen = "deq~:%s" % stamp_s
                        break
        keys[row.uuid] = chosen or ("singleton:%s" % row.uuid)

    def key_of(row):
        return keys.get(row.uuid, "singleton:%s" % row.uuid)

    return key_of


def batch_key_by_delivering_op(row, delivering_op_stamp=None):
    """Batch membership key.

    Co-drained items share a delivering-op instant EXACTLY: `dequeue` is a
    batch drain fired at turn end, one row per item, and co-drained rows carry
    ONE timestamp to the millisecond (argus, session 58ebf332). So exact stamp
    equality is the PRIMARY rule on that shape, and the tolerance band is a
    fallback for other shapes -- not the other way round.

    Rows with NO delivering op (BOX-RETURN, and the attribution-uncertain
    residue) form a SINGLETON batch keyed by the row's own uuid. Without this
    the walk's DIFFERENT-batch terminal test and the uniqueness clause are
    undefined on exactly the classes those outcomes create.
    """
    return delivering_op_stamp if delivering_op_stamp else ("singleton:%s" % row.uuid)
