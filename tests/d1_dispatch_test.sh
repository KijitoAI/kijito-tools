#!/usr/bin/env bash
# Tests for d1_dispatch.py -- the D1 row layer (ordered dispatch + the walk).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../src"

python3 - "$SRC" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from kijito_claude import d1_dispatch as D

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond: passed += 1; print("  PASS  %s" % name)
    else: failed += 1; print("  FAIL  %s  %s" % (name, detail))

NONCE = "aB3xY9kQ2mN"

def row(**kw):
    kw.setdefault("uuid", kw.get("u"))
    kw.pop("u", None)
    return D.Row(kw, 0)

def user(uuid, text, parent=None, **kw):
    d = dict(type="user", uuid=uuid, parentUuid=parent,
             message={"content": text}, **kw)
    return D.Row(d, 0)

def listuser(uuid, parent=None):
    return D.Row(dict(type="user", uuid=uuid, parentUuid=parent,
                      message={"content": [{"type": "tool_result"}]}), 0)

def asst(uuid, parent):
    return D.Row(dict(type="assistant", uuid=uuid, parentUuid=parent,
                      message={"content": [{"type": "text", "text": "ok"}]}), 0)

def att(uuid, parent, atype, prompt=None):
    return D.Row(dict(type="attachment", uuid=uuid, parentUuid=parent,
                      attachment={"type": atype, "prompt": prompt}), 0)

def qop(operation, ts, content=None):
    d = dict(type="queue-operation", operation=operation, timestamp=ts)
    if content is not None:
        d["content"] = content
    return D.Row(d, 0)

print("== ordered dispatch, first match wins ==")
idx = D.RowIndex([qop("enqueue", "t1", "wake %s payload" % NONCE)])
r1 = att("a1", None, "queued_command", "wake %s payload" % NONCE)
ok("(1) queued_command attachment carrying the nonce",
   D.dispatch_shape(r1, idx, NONCE)[0] == D.SHAPE_QUEUED_COMMAND)

r2 = user("u1", "wake %s payload" % NONCE)
ok("(2) user row content-identical to an enqueue -> dequeue-shape",
   D.dispatch_shape(r2, idx, NONCE)[0] == D.SHAPE_DEQUEUE)

idx_noenq = D.RowIndex([])
r3 = user("u2", "wake %s payload" % NONCE)
ok("(3) nonce present, NO enqueue contains it -> BOX-RETURN",
   D.dispatch_shape(r3, idx_noenq, NONCE)[0] == D.SHAPE_BOX_RETURN)

r4 = D.Row(dict(type="system", uuid="s1", content="carries %s" % NONCE), 0)
ok("(4) anything else nonce-bearing -> BLOCKED (never silent)",
   D.dispatch_shape(r4, idx_noenq, NONCE)[0] == D.SHAPE_BLOCKED)
print()

print("== promptSource dispatches NOTHING (standing ban) ==")
# Same row, opposite promptSource values, must classify identically.
a = user("p1", "wake %s x" % NONCE, promptSource="typed")
b = user("p2", "wake %s x" % NONCE, promptSource="system")
ok("classification is invariant under promptSource",
   D.dispatch_shape(a, idx_noenq, NONCE)[0] == D.dispatch_shape(b, idx_noenq, NONCE)[0],
   "a predicate keyed on promptSource is wrong even when it agrees")
print()

print("== the walk ==")
start = user("w1", "wake")
rows = [start, att("x1", "w1", "total_tokens_reminder"), asst("a2", "x1")]
idx = D.RowIndex(rows)
bk = lambda r: "B"
ok("walks THROUGH an attachment to the assistant -> DELIVERED",
   D.walk_delivery(start, idx, batch_key_of=bk)[0] == D.DELIVERED)

rows = [start, listuser("l1", "w1"), asst("a3", "l1")]
ok("walks THROUGH a list-content user row (tool result) -> DELIVERED",
   D.walk_delivery(start, D.RowIndex(rows), batch_key_of=bk)[0] == D.DELIVERED)

ok("a live tail with no assistant -> PENDING (not LOST)",
   D.walk_delivery(start, D.RowIndex([start]), batch_key_of=bk)[0] == D.PENDING)

other = user("o1", "a different submission", parent="w1",
             promptSource="typed", origin={"kind": "human"})
rows = [start, other, asst("a4", "o1")]
keys = {"w1": "B1", "o1": "B2"}
ok("a DIFFERENT-batch typed submission terminates -> SUPERSEDED",
   D.walk_delivery(start, D.RowIndex(rows),
                   batch_key_of=lambda r: keys.get(r.uuid, "Z"))[0] == D.SUPERSEDED)
print()

print("== CANARY: batch SIBLINGS must not terminate each other ==")
# argus's real specimen: ECHO-1 and ECHO-2 co-drained 1 ms apart. With a
# per-uuid batch key, ECHO-1 was scored SUPERSEDED by its own sibling.
e1 = user("e1", "reply with exactly: ECHO-1")
e2 = user("e2", "reply with exactly: ECHO-2", parent="e1",
          promptSource="queued", origin={"kind": "human"})
rows = [e1, e2, asst("ea", "e2")]
same = lambda r: "SAME-DRAIN"
ok("co-drained siblings share a batch -> DELIVERED, not SUPERSEDED",
   D.walk_delivery(e1, D.RowIndex(rows), batch_key_of=same)[0] == D.DELIVERED)
ok("and with a per-uuid key the SAME data goes wrong (the defect reproduced)",
   D.walk_delivery(e1, D.RowIndex(rows), batch_key_of=lambda r: r.uuid)[0] == D.SUPERSEDED,
   "if this passes as DELIVERED the canary no longer detects the defect")

raised = False
try:
    D.walk_delivery(e1, D.RowIndex(rows))
except ValueError:
    raised = True
ok("walk REFUSES without an explicit batch_key_of", raised,
   "a convenience default that disables a protective clause is worse than a required arg")
print()

print("== batch keys from ops ==")
idx = D.RowIndex([
    qop("dequeue", "2026-08-05T02:13:51.427Z"),
    e1, e2,
])
# both user rows carry no timestamp here, so they fall to singleton -- the
# point of this assertion is that singletons are DEFINED, not that they group.
k = D.batch_keys_from_ops(idx)
ok("a row with no delivering op gets a defined SINGLETON key",
   k(e1).startswith("singleton:"))

idx2 = D.RowIndex([qop("remove", "2026-08-05T02:00:00.000Z", "reply with exactly: ECHO-1"), e1])
k2 = D.batch_keys_from_ops(idx2)
ok("a content-bearing exit keys its item EXACTLY (no guessing)",
   k2(e1) == "op:2026-08-05T02:00:00.000Z")
print()

print("---- %d passed, %d failed ----" % (passed, failed))
sys.exit(1 if failed else 0)
PY
