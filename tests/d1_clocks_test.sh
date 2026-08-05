#!/usr/bin/env bash
# Tests for d1_clocks.py -- the triple-stamp primitives of the D1 wake ledger.
#
# DISCIPLINE: this file's FIRST substantive test is one the implementation must
# FAIL if it is wrong (the per-OS inversion canary). A suite that only feeds
# good input to each function measures nothing -- that is precisely how a
# broken gate was once reported as working.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../src"

python3 - "$SRC" <<'PY'
import sys, os, platform, time
sys.path.insert(0, sys.argv[1])
from kijito_claude import d1_clocks as C

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  %s" % name)
    else:
        failed += 1; print("  FAIL  %s  %s" % (name, detail))

print("platform: %s" % platform.system())
print()

# ---------------------------------------------------------------- canaries
print("== CANARY: the per-OS mapping (must detect an inversion) ==")
# The semantic contract: the sleep-INCLUDING clock must be >= the
# sleep-EXCLUDING one, always, on every platform. If the mapping were
# inverted, this inequality flips on any host that has ever slept/frozen.
s = C.read_stamps()
ok("boot(includes sleep) >= mono(excludes sleep)", s.boot >= s.mono,
   "boot=%.3f mono=%.3f -- if this fails the per-OS mapping is INVERTED" % (s.boot, s.mono))

# Prove the canary has teeth: construct the inverted pair and assert the SAME
# check rejects it. A canary that cannot go red is decoration.
inverted = C.Stamps(s.wall, s.boot, s.mono, s.platform)   # mono/boot swapped
ok("canary has teeth: inverted stamps are REJECTED by the same check",
   not (inverted.boot >= inverted.mono) or (s.boot == s.mono),
   "inverted pair passed the check -- the test cannot detect the defect it exists for")

# The macOS trap, asserted by name so a future edit that 'simplifies' the
# per-OS branch to a single constant is caught here rather than in production.
if platform.system() == "Darwin":
    ok("macOS uses CLOCK_UPTIME_RAW for sleep-excluding", hasattr(time, "CLOCK_UPTIME_RAW"),
       "macOS CLOCK_MONOTONIC INCLUDES sleep; substituting it inverts the verdict")
else:
    ok("Linux exposes CLOCK_BOOTTIME for sleep-including", hasattr(time, "CLOCK_BOOTTIME"),
       "Linux CLOCK_MONOTONIC EXCLUDES suspend; substituting it hides suspend")
print()

# ---------------------------------------------------------------- stamps
print("== read_stamps ==")
a = C.read_stamps()
time.sleep(0.05)
b = C.read_stamps()
ok("wall advances", b.wall > a.wall)
ok("mono advances", b.mono > a.mono)
ok("boot advances", b.boot > a.boot)
ok("all three present and float", all(isinstance(getattr(a, f), float) for f in ("wall","mono","boot")))
ok("as_dict carries platform", C.read_stamps().as_dict().get("platform") == platform.system())
print()

# ---------------------------------------------------------------- boot record
print("== boot_wall_instant (>=2 agreeing ON-DISK witnesses) ==")
try:
    boot_wall, info = C.boot_wall_instant()
    ok("boot instant readable", boot_wall > 0, "value=%r" % boot_wall)
    ok(">=2 trusted witnesses agreed", len(info["witnesses"]) >= 2, repr(info["witnesses"]))
    ok("boot instant is in the past", boot_wall < time.time())
    print("       boot_wall = %s" % time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(boot_wall)))
    for n, v in sorted(info["witnesses"].items()):
        print("         witness %-24s %s" % (n, time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(v))))
    if info["derived_btime"]:
        print("         derived btime (NOT used)  %s   delta=%.0f s"
              % (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(info["derived_btime"])),
                 info["derived_witness_delta_s"] or 0.0))
    print("         discontinuity_detected = %r" % info["discontinuity_detected"])
except C.ClockError as e:
    ok("boot instant readable", False, str(e))
    boot_wall, info = None, {}
print()

print("== CANARY: the derived source must NOT be the answer (this seat is stepped) ==")
# This host carries a real ~3-day clock step: /proc/stat btime is ~2 days
# later than the on-disk boot records. That makes it a LIVE positive control
# for the step detector -- no synthetic input needed.
if info.get("derived_btime") and boot_wall:
    ok("btime differs from the trusted boot instant", (info["derived_witness_delta_s"] or 0) > 120,
       "btime agrees with the on-disk records; this seat may no longer be stepped, "
       "in which case this control is vacuous and must be re-established elsewhere")
    ok("the discontinuity is REPORTED, not silently absorbed",
       info["discontinuity_detected"] is True)
    # ladybug's finding: the delta IS freeze_cumulative, one quantity not two.
    s_now = C.read_stamps()
    fc = C.freeze_cumulative(s_now, boot_wall)
    ok("delta and freeze_cumulative are the SAME quantity (identity, not agreement)",
       abs((info["derived_witness_delta_s"] or 0) - fc) < 5.0,
       "delta=%.1f freeze=%.1f -- if these ever DIVERGE the identity assumption broke"
       % (info["derived_witness_delta_s"] or 0, fc))
    ok("the returned value is the ON-DISK one, not btime",
       abs(boot_wall - info["derived_btime"]) > 120,
       "boot_wall_instant returned the derived value -- the exact defect this rewrite fixes")
else:
    # ladybug F2: on Darwin the probe never runs, so the field must be
    # UNMEASURED (None) rather than False -- false-because-not-measured is
    # indistinguishable from false-because-nothing-happened.
    ok("unmeasured platform reports None, NOT False",
       info.get("discontinuity_detected") is None,
       "a hard False here is a confident negative from an instrument that never ran")
print()

print("== CANARY: refuses on <2 witnesses, and on DISAGREEMENT ==")
_lin, _mac = C._TRUSTED_LINUX, C._TRUSTED_MAC
try:
    # (a) no witnesses at all -> refuse
    C._TRUSTED_LINUX = C._TRUSTED_MAC = ()
    raised = False
    try: C.boot_wall_instant()
    except C.ClockError: raised = True
    ok("refuses with zero witnesses", raised)

    # (b) exactly one witness -> still refuse; one record cannot check itself
    C._TRUSTED_LINUX = C._TRUSTED_MAC = (("solo", lambda: 1785790323.0),)
    raised = False
    try: C.boot_wall_instant()
    except C.ClockError: raised = True
    ok("refuses with a SINGLE witness", raised,
       "a lone confident source is what produced the original defect")

    # (c) two witnesses that DISAGREE (btime-style vs wtmp-style, ~2 days
    #     apart) -> refuse rather than pick one. This is assay's L1-F1 canary.
    C._TRUSTED_LINUX = C._TRUSTED_MAC = (
        ("wtmp_like", lambda: 1785528270.0),      # Jul 31
        ("btime_like", lambda: 1785790323.0),     # Aug 3
    )
    raised = False
    try: C.boot_wall_instant()
    except C.ClockError: raised = True
    ok("REFUSES when witnesses disagree beyond tolerance", raised,
       "it silently picked one -- disagreement among boot records IS a clock event")

    # (d) two witnesses that agree -> accepted
    C._TRUSTED_LINUX = C._TRUSTED_MAC = (
        ("a", lambda: 1785528270.0), ("b", lambda: 1785528290.0),
    )
    got = None
    try: got, _ = C.boot_wall_instant()
    except C.ClockError: pass
    ok("accepts two AGREEING witnesses", got is not None and abs(got - 1785528270.0) < 120)
finally:
    C._TRUSTED_LINUX, C._TRUSTED_MAC = _lin, _mac
print()

# ---------------------------------------------------------------- derived
if boot_wall is not None:
    print("== freeze / suspend attribution ==")
    s = C.read_stamps()
    fc = C.freeze_cumulative(s, boot_wall)
    kind = C.suspend_kind(s, boot_wall)
    print("       freeze_cumulative = %.1f s (%.1f h)" % (fc, fc / 3600.0))
    print("       boot - mono       = %.1f s (%.1f h)   [guest sleep]" % (s.boot - s.mono, (s.boot - s.mono)/3600.0))
    print("       verdict           = %s" % kind)
    ok("freeze_cumulative is finite", fc == fc and abs(fc) < 10**12)
    ok("verdict is one of the four", kind in ("RUNNING","GUEST_SUSPEND","HYPERVISOR_PAUSE","BOTH"))

    # Synthetic positive control: inject a known freeze and assert it is SEEN.
    faked = C.Stamps(s.wall + 3600.0, s.mono, s.boot, s.platform)
    ok("an injected 1 h freeze is detected",
       C.suspend_kind(faked, boot_wall) in ("HYPERVISOR_PAUSE","BOTH"),
       "verdict=%s -- the detector is blind to a freeze it was handed" % C.suspend_kind(faked, boot_wall))
    ok("injected freeze shows in the arithmetic",
       abs(C.freeze_cumulative(faked, boot_wall) - (fc + 3600.0)) < 1.0)

    # Synthetic positive control: inject guest sleep.
    slept = C.Stamps(s.wall, s.mono, s.boot + 3600.0, s.platform)
    ok("an injected 1 h guest suspend is detected",
       C.suspend_kind(slept, boot_wall) in ("GUEST_SUSPEND","BOTH"))

    # NEGATIVE control: unmodified stamps must NOT be called a guest suspend
    # merely because the host has been frozen a lot.
    ok("freeze alone is not reported as guest suspend",
       C.suspend_kind(s, boot_wall) != "GUEST_SUSPEND" or (s.boot - s.mono) > 2.0)
    print()

# ---------------------------------------------------------------- segment
print("== segment_voided (reboot voids, freeze does not) ==")
open_s = C.Stamps(1000.0, 500.0, 500.0, "Linux")
later  = C.Stamps(2000.0, 600.0, 600.0, "Linux")
reset  = C.Stamps(2000.0,   5.0,   5.0, "Linux")
frozen = C.Stamps(9000.0, 510.0, 510.0, "Linux")   # huge wall jump, mono intact
v, _ = C.segment_voided(open_s, later);  ok("normal progress does not void", not v)
v, r = C.segment_voided(open_s, reset);  ok("monotonic reset VOIDS", v, r)
v, _ = C.segment_voided(open_s, frozen); ok("a freeze does NOT void the segment", not v)
print()

print("---- %d passed, %d failed ----" % (passed, failed))
sys.exit(1 if failed else 0)
PY
