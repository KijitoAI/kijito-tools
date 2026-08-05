#!/usr/bin/env bash
# Tests for d1_queue.py -- the D1 five-way queue state machine.
#
# Fixtures, not the live corpus: the corpus changes under you (five agents are
# writing to it right now), and a test that reads it is flaky by construction.
# The corpus run is EVIDENCE and lives in the landing report, not in here.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../src"

python3 - "$SRC" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from kijito_claude import d1_queue as Q

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond: passed += 1; print("  PASS  %s" % name)
    else: failed += 1; print("  FAIL  %s  %s" % (name, detail))

def op(operation, ts, content=None, has_key=None, line=0):
    return Q.QueueOp(operation, ts, "sid", content,
                     has_key if has_key is not None else (content is not None), line)

T = "2026-08-01T00:00:%02d.000Z"
NEVER = lambda ts: False
ALWAYS = lambda ts: True

print("== the five exits ==")
items, unm = Q.pair_queue_ops([op("enqueue", T % 1, "A"), op("dequeue", T % 2)],
                              has_subsequent_row=ALWAYS)
ok("enqueue -> dequeue", len(items) == 1 and items[0].outcome == Q.EXITED_VIA_DEQUEUE)
ok("dequeue pairs ORDINALLY (it has no content field)",
   items[0].attribution == Q.ATTR_ORDINAL)

items, _ = Q.pair_queue_ops([op("enqueue", T % 1, "A"), op("remove", T % 2, "A")],
                            has_subsequent_row=ALWAYS)
ok("enqueue -> remove", items[0].outcome == Q.EXITED_VIA_REMOVE)
ok("remove pairs by CONTENT IDENTITY", items[0].attribution == Q.ATTR_CONTENT)
ok("content pairing is the trusted one", items[0].trusted)

items, _ = Q.pair_queue_ops([op("enqueue", T % 1, "A"), op("popAll", T % 2, "A")],
                            has_subsequent_row=ALWAYS)
ok("enqueue -> popAll = STRANDED", items[0].outcome == Q.STRANDED)

items, _ = Q.pair_queue_ops([op("enqueue", T % 1, "A")], has_subsequent_row=ALWAYS)
ok("enqueue with a later row = IN FLIGHT", items[0].outcome == Q.ENQUEUED_IN_FLIGHT)
print()

print("== CANARY: ENQUEUED-ORPHANED must NOT fire on a live in-flight enqueue ==")
# The defect this canary exists for: the first implementation declared ORPHANED
# the instant nothing followed, with no threshold. Scanning the real corpus
# twice minutes apart gave 8 orphans then 7 -- the extra was a LIVE session
# whose next row had not been written yet. An in-flight wake scored as loss.
import time, calendar, datetime
now = time.time()
def enq_at(hours_ago):
    t = datetime.datetime.fromtimestamp(now - hours_ago * 3600, datetime.timezone.utc)
    return t.isoformat().replace("+00:00", "Z")

items, _ = Q.pair_queue_ops([op("enqueue", enq_at(0.01), "fresh")],
                            has_subsequent_row=NEVER, now_wall=now)
ok("a 36-SECOND-old exitless enqueue is IN FLIGHT, not ORPHANED",
   items[0].outcome == Q.ENQUEUED_IN_FLIGHT, items[0].note)

items, _ = Q.pair_queue_ops([op("enqueue", enq_at(200.0), "old")],
                            has_subsequent_row=NEVER, now_wall=now)
ok("a 200-HOUR-old exitless enqueue IS orphaned", items[0].outcome == Q.ENQUEUED_ORPHANED,
   items[0].note)

# liveness witness outranks any clock
items, _ = Q.pair_queue_ops([op("enqueue", enq_at(200.0), "old")],
                            has_subsequent_row=NEVER, now_wall=now, session_is_live=True)
ok("a LIVE session is never orphaned, however old the enqueue",
   items[0].outcome == Q.ENQUEUED_IN_FLIGHT, items[0].note)

# unparseable clock must not manufacture a loss signature
items, _ = Q.pair_queue_ops([op("enqueue", "not-a-timestamp", "x")],
                            has_subsequent_row=NEVER, now_wall=now)
ok("an unreadable timestamp does NOT score a loss", items[0].outcome == Q.ENQUEUED_IN_FLIGHT)
print()

print("== CANARY: T is HOST-hours, and freeze changes the verdict ==")
# 120 h wall old. With no freeze that clears T=96. With 72.8 h of freeze the
# host-hours lower bound is 47.2 h and it must NOT be declared.
a, _ = Q.pair_queue_ops([op("enqueue", enq_at(120.0), "x")], has_subsequent_row=NEVER,
                        now_wall=now, freeze_since_boot_s=0.0)
b, _ = Q.pair_queue_ops([op("enqueue", enq_at(120.0), "x")], has_subsequent_row=NEVER,
                        now_wall=now, freeze_since_boot_s=72.8 * 3600)
ok("120 h wall, no freeze -> ORPHANED", a[0].outcome == Q.ENQUEUED_ORPHANED)
ok("120 h wall, 72.8 h freeze -> NOT declarable", b[0].outcome == Q.ENQUEUED_IN_FLIGHT, b[0].note)
ok("the verdict states its basis", "freeze" in b[0].note and "host-hours" in b[0].note)
print()

print("== content identity beats FIFO; unmatched exits are not forced ==")
ops = [op("enqueue", T % 1, "FIRST"), op("enqueue", T % 2, "SECOND"),
       op("remove", T % 3, "SECOND")]
items, unm = Q.pair_queue_ops(ops, has_subsequent_row=ALWAYS)
paired = [i for i in items if i.exit_op is not None]
ok("remove matched SECOND, not the older FIRST",
   len(paired) == 1 and paired[0].enqueue.content == "SECOND")
ok("FIRST left unpaired rather than absorbed", any(i.exit_op is None for i in items))

ops = [op("enqueue", T % 1, "A"), op("remove", T % 2, "NOMATCH")]
items, unm = Q.pair_queue_ops(ops, has_subsequent_row=ALWAYS)
ok("a content-bearing exit matching nothing is REPORTED, not forced onto FIFO",
   len(unm) == 1 and unm[0].content == "NOMATCH",
   "forcing it is how an ordinal walk manufactures a confident wrong attribution")
print()

print("== post-loss ordinal downgrade ==")
ops = [op("enqueue", T % 1, "A"), op("dequeue", T % 2),
       op("enqueue", T % 3, "ORPHAN")]
items, _ = Q.pair_queue_ops(ops, has_subsequent_row=NEVER, now_wall=now,
                            freeze_since_boot_s=0.0)
# make the orphan old enough to be declarable
ops2 = [op("enqueue", enq_at(200), "A"), op("dequeue", enq_at(199)),
        op("enqueue", enq_at(198), "ORPHAN")]
items2, _ = Q.pair_queue_ops(ops2, has_subsequent_row=NEVER, now_wall=now)
has_orphan = any(i.outcome == Q.ENQUEUED_ORPHANED for i in items2)
downgraded = any(i.attribution == Q.ATTR_ORDINAL_UNTRUSTED for i in items2)
ok("a file with a loss signature downgrades its ordinal pairings",
   has_orphan and downgraded,
   "orphan=%s downgraded=%s" % (has_orphan, downgraded))
ok("downgraded pairings are not 'trusted'",
   all(not i.trusted for i in items2 if i.attribution == Q.ATTR_ORDINAL_UNTRUSTED))
print()

print("---- %d passed, %d failed ----" % (passed, failed))
sys.exit(1 if failed else 0)
PY
