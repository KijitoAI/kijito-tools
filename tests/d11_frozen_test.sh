#!/usr/bin/env bash
# Tests for d11_frozen.py -- the D11 frozen-tool-call detector.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../src"

python3 - "$SRC" <<'PY'
import sys, time, datetime
sys.path.insert(0, sys.argv[1])
from kijito_claude import d11_frozen as F

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond: passed += 1; print("  PASS  %s" % name)
    else: failed += 1; print("  FAIL  %s  %s" % (name, detail))

now = time.time()
def ago(hours):
    t = datetime.datetime.fromtimestamp(now - hours * 3600, datetime.timezone.utc)
    return t.isoformat().replace("+00:00", "Z")

def asst_tool(cid, name, ts, **inp):
    return dict(type="assistant", timestamp=ts,
                message={"content": [{"type": "tool_use", "id": cid, "name": name, "input": inp}]})

def user_result(cid):
    return dict(type="user", message={"content": [{"type": "tool_result", "tool_use_id": cid}]})

NOFREEZE = lambda a, b: 0.0

print("== the classifier ==")
for cmd, want in [
    ("ls -la", F.LIGHT),
    ("pytest -q", F.HEAVY),
    ("cd /repo && pytest -q", F.HEAVY),
    ("cd /repo && ls", F.LIGHT),
    ("git bundle create x.bundle --all", F.HEAVY),
    ("bash -c 'hidden'", F.CLASSIFIER_UNKNOWN),
    ("./mystery.sh", F.CLASSIFIER_UNKNOWN),
    ("cat x | xargs foo", F.CLASSIFIER_UNKNOWN),
    # D11-F1: a command that MENTIONS a heavy word is not a heavy command.
    ("grep pytest test.log", F.LIGHT),
    ("cat Makefile", F.LIGHT),
    ("ls docker-compose.yml", F.LIGHT),
]:
    got, why = F.classify_command("Bash", cmd)
    ok("%-34r -> %s" % (cmd[:32], want), got == want, "got %s (%s)" % (got, why))

ok("a non-Bash tool is its own class", F.classify_command("Read")[0] == F.LIGHT)
ok("Bash with NO command fails closed",
   F.classify_command("Bash", None)[0] == F.CLASSIFIER_UNKNOWN)
print()

print("== CANARY: quote-aware splitting (a separator INSIDE quotes is not one) ==")
# Real corpus command: a light grep whose pattern contains '|'. A naive
# splitter breaks it, produces nonsense segments, and reports UNKNOWN --
# filling the unknown bucket with decidable traffic. An operator who learns
# to ignore CLASSIFIER-UNKNOWN has no detector.
q = """grep -oE '"(defaultMode|permissionMode)"' ~/.claude/settings.json"""
ok("a quoted | does not split the command", F.classify_command("Bash", q)[0] == F.LIGHT,
   "segments=%r" % (F._split_compound(q),))
ok("a quoted | leaves ONE segment", len(F._split_compound(q)) == 1)
ok('echo "a|b" stays light', F.classify_command("Bash", 'echo "a|b"')[0] == F.LIGHT)
ok("an UNquoted | still splits", len(F._split_compound("cat x | wc -l")) == 2)
print()

print("== CANARY: D11-F1 heavy matching is COMMAND POSITION, not substring ==")
ok("grep pytest -> LIGHT (15 min), not HEAVY (4 h)",
   F.classify_command("Bash", "grep pytest test.log")[0] == F.LIGHT,
   "substring matching inflates detection latency 16x in the QUIET direction")
ok("a REAL pytest is still HEAVY", F.classify_command("Bash", "pytest -q")[0] == F.HEAVY)
ok("multi-word heavy tokens still match at command position",
   F.classify_command("Bash", "git bundle create x --all")[0] == F.HEAVY)
ok("...but not when merely mentioned",
   F.classify_command("Bash", "echo git bundle")[0] == F.LIGHT)
rows_a = [asst_tool("q1", "Bash", ago(1.0), command="grep pytest test.log")]
f_a = F.evaluate_open_calls(rows_a, now, freeze_lookup=NOFREEZE)[0]
ok("and it changes the VERDICT: a 1 h stuck grep now PAGES", f_a["verdict"] == "PAGE",
   "under the old substring rule this waited 4 h: %s" % f_a["reason"])
print()

print("== CANARY: D11-F2 pre-boot open call is floored, not overstated ==")
boot = now - 10 * 3600
rows_b = [asst_tool("p1", "Bash", ago(500.0), command="ls")]
f_b = F.evaluate_open_calls(rows_b, now, freeze_lookup=NOFREEZE, boot_wall=boot)[0]
ok("pre-boot call uses current-boot executing time as the floor",
   abs(f_b["mono_age_s"] - 10 * 3600) < 60,
   "mono_age=%.1fh -- 500 h wall must not be charged across a reboot" % (f_b["mono_age_s"] / 3600))
rows_c = [asst_tool("p2", "Bash", ago(5.0), command="ls")]
f_c = F.evaluate_open_calls(rows_c, now, freeze_lookup=NOFREEZE, boot_wall=boot)[0]
ok("an in-boot call is unaffected by the floor",
   abs(f_c["mono_age_s"] - 5 * 3600) < 60)
print()

print("== open-call detection (the ABSENCE is the predicate) ==")
rows = [asst_tool("t1", "Bash", ago(1), command="ls"), user_result("t1"),
        asst_tool("t2", "Bash", ago(2), command="ls")]
oc = F.open_calls(rows)
ok("a resolved call is not open", all(c["id"] != "t1" for c in oc))
ok("an unresolved call IS open", any(c["id"] == "t2" for c in oc))

rows = [asst_tool("m1", "Monitor", ago(50))]
ok("Monitor is SCOPED OUT (no durable child witness, Clause 5)",
   F.open_calls(rows) == [], "it must not page a class the plan records as uncovered")
print()

print("== bounds, and the heavy exemption ==")
rows = [asst_tool("h1", "Bash", ago(1.0), command="pytest -q")]
f = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE)[0]
ok("a 1 h pytest is OK under the heavy bound", f["verdict"] == "OK", f["reason"])

rows = [asst_tool("h2", "Bash", ago(5.0), command="pytest -q")]
f = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE)[0]
ok("a 5 h pytest PAGES (over even the heavy bound)", f["verdict"] == "PAGE", f["reason"])

rows = [asst_tool("l1", "Bash", ago(1.0), command="ls -la")]
f = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE)[0]
ok("a 1 h `ls` PAGES (light bound is 15 min)", f["verdict"] == "PAGE", f["reason"])
print()

print("== CANARY: fail-closed, defer, and refuse-to-guess ==")
rows = [asst_tool("u1", "Bash", ago(1.0), command="./mystery.sh")]
f = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE)[0]
ok("an undecidable command PAGES with CLASSIFIER-UNKNOWN",
   f["verdict"] == "PAGE" and f["subtype"] == F.CLASSIFIER_UNKNOWN,
   "a silent exemption here is the whole hazard: %r" % f)

rows = [asst_tool("s1", "Bash", ago(50.0), command="ls")]
f = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE, suspend_verdict="SUSPENDED")[0]
ok("SUSPENDED DEFERS rather than paging", f["verdict"] == "DEFERRED", f["reason"])
ok("the deferral is VISIBLE, not an absence of output", "verdict" in f and f["verdict"] != "OK")

f = F.evaluate_open_calls(rows, now)[0]
ok("with no freeze data it is UNDECIDABLE, not a page", f["verdict"] == "UNDECIDABLE",
   "wall age overstates executing time; paging on it is the wrong direction")

# The freeze must actually change the verdict, or the monotonic age is decorative.
rows = [asst_tool("z1", "Bash", ago(3.0), command="ls")]
hot = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE)[0]
cold = F.evaluate_open_calls(rows, now, freeze_lookup=lambda a, b: 2.9 * 3600)[0]
ok("freeze inside the call's window suppresses a would-be page",
   hot["verdict"] == "PAGE" and cold["verdict"] == "OK",
   "hot=%s cold=%s" % (hot["verdict"], cold["verdict"]))

rows = [asst_tool("b1", "Bash", "not-a-timestamp", command="ls")]
f = F.evaluate_open_calls(rows, now, freeze_lookup=NOFREEZE)[0]
ok("an unparseable timestamp is UNDECIDABLE, never a page", f["verdict"] == "UNDECIDABLE")
print()

print("---- %d passed, %d failed ----" % (passed, failed))
sys.exit(1 if failed else 0)
PY
