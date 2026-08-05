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

NOFREEZE = lambda a, b: 0.0
items, _ = Q.pair_queue_ops([op("enqueue", enq_at(0.01), "fresh")],
                            has_subsequent_row=NEVER, now_wall=now, freeze_lookup=NOFREEZE)
ok("a 36-SECOND-old exitless enqueue is IN FLIGHT, not ORPHANED",
   items[0].outcome == Q.ENQUEUED_IN_FLIGHT, items[0].note)

items, _ = Q.pair_queue_ops([op("enqueue", enq_at(200.0), "old")],
                            has_subsequent_row=NEVER, now_wall=now, freeze_lookup=NOFREEZE)
ok("a 200-HOUR-old exitless enqueue IS orphaned", items[0].outcome == Q.ENQUEUED_ORPHANED,
   items[0].note)

# liveness witness outranks any clock
items, _ = Q.pair_queue_ops([op("enqueue", enq_at(200.0), "old")],
                            has_subsequent_row=NEVER, now_wall=now,
                            freeze_lookup=NOFREEZE, session_is_live=True)
ok("a LIVE session is never orphaned, however old the enqueue",
   items[0].outcome == Q.ENQUEUED_IN_FLIGHT, items[0].note)

# unparseable clock must not manufacture a loss signature
items, _ = Q.pair_queue_ops([op("enqueue", "not-a-timestamp", "x")],
                            has_subsequent_row=NEVER, now_wall=now, freeze_lookup=NOFREEZE)
ok("an unreadable timestamp does NOT score a loss", items[0].outcome == Q.ENQUEUED_IN_FLIGHT)
print()

print("== CANARY: T is HOST-hours, and freeze changes the verdict ==")
# 120 h wall old. With no freeze that clears T=96. With 72.8 h of freeze the
# host-hours lower bound is 47.2 h and it must NOT be declared.
a, _ = Q.pair_queue_ops([op("enqueue", enq_at(120.0), "x")], has_subsequent_row=NEVER,
                        now_wall=now, freeze_lookup=NOFREEZE)
FREEZE728 = lambda t0, t1: 72.8 * 3600
b, _ = Q.pair_queue_ops([op("enqueue", enq_at(120.0), "x")], has_subsequent_row=NEVER,
                        now_wall=now, freeze_lookup=FREEZE728)
ok("120 h wall, no freeze -> ORPHANED", a[0].outcome == Q.ENQUEUED_ORPHANED)
ok("120 h wall, 72.8 h freeze -> NOT declarable", b[0].outcome == Q.ENQUEUED_IN_FLIGHT, b[0].note)
ok("the verdict states its basis", "freeze" in b[0].note and "host" in b[0].note)

# NEW canaries for the per-window fix.
none_items, _ = Q.pair_queue_ops([op("enqueue", enq_at(500.0), "x")],
                                 has_subsequent_row=NEVER, now_wall=now)
ok("with NO freeze data it REFUSES to declare, however old",
   none_items[0].outcome == Q.ENQUEUED_IN_FLIGHT and "Refusing" in none_items[0].note,
   "falling back to wall age overstates host-hours and declares a loss early")

# L2-F1: a pre-boot enqueue must be floored at this boot's executing time,
# not wall_age minus this boot's freeze (prior boots' freezes are unrecorded).
boot = now - 50 * 3600                       # booted 50 h ago
pre, _ = Q.pair_queue_ops([op("enqueue", enq_at(500.0), "ancient")],
                          has_subsequent_row=NEVER, now_wall=now,
                          freeze_lookup=NOFREEZE, boot_wall=boot)
ok("a PRE-BOOT enqueue is floored at current-boot executing time (L2-F1)",
   pre[0].outcome == Q.ENQUEUED_IN_FLIGHT and "pre-boot" in pre[0].note,
   "500 h wall would clear T, but only 50 h of THIS boot is evidenced: %s" % pre[0].note)

# A row inside the current boot is unaffected by that floor.
inb, _ = Q.pair_queue_ops([op("enqueue", enq_at(40.0), "recent")],
                          has_subsequent_row=NEVER, now_wall=now,
                          freeze_lookup=NOFREEZE, boot_wall=boot)
ok("an in-boot enqueue uses its own window, not the boot floor",
   "pre-boot" not in inb[0].note)

# The defect argus's decomposition exposed: a row POSTDATING the freeze must
# not inherit it. Window-scoped lookup returns 0 for a recent row.
def windowed(t0, t1):
    frozen_until = now - 100 * 3600          # all freeze ended 100 h ago
    return max(0.0, min(t1, frozen_until) - t0) if t0 < frozen_until else 0.0
post, _ = Q.pair_queue_ops([op("enqueue", enq_at(2.0), "after the freeze")],
                           has_subsequent_row=NEVER, now_wall=now, freeze_lookup=windowed)
ok("a row postdating the freeze is charged ZERO of it",
   "freeze-in-window 0.0 h" in post[0].note, post[0].note)
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
                            freeze_lookup=NOFREEZE)
# make the orphan old enough to be declarable
ops2 = [op("enqueue", enq_at(200), "A"), op("dequeue", enq_at(199)),
        op("enqueue", enq_at(198), "ORPHAN")]
items2, _ = Q.pair_queue_ops(ops2, has_subsequent_row=NEVER, now_wall=now,
                             freeze_lookup=NOFREEZE)
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
