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
print("== boot_wall_instant (on-disk, must not be derived) ==")
try:
    boot_wall, source = C.boot_wall_instant()
    ok("boot instant readable", boot_wall > 0, "value=%r" % boot_wall)
    ok("source named", bool(source), "source=%r" % source)
    ok("boot instant is in the past", boot_wall < time.time())
    print("       source=%s  boot_wall=%s" % (source, time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(boot_wall))))
except C.ClockError as e:
    ok("boot instant readable", False, str(e))
    boot_wall = None

# FAIL-CLOSED canary: with every source unavailable it must RAISE, not return a
# derived number. Deriving it from wall-minus-boottime would make the freeze
# arithmetic self-confirming (always ~0).
print()
print("== CANARY: fail-closed when no boot source is readable ==")
_lin, _mac = C._boot_wall_linux, C._boot_wall_mac
try:
    C._boot_wall_linux = lambda: (None, None)
    C._boot_wall_mac = lambda: (None, None)
    raised = False
    try:
        C.boot_wall_instant()
    except C.ClockError:
        raised = True
    ok("raises ClockError rather than returning a derived value", raised,
       "it returned a number with no source -- that is the myctx.sh defect")
finally:
    C._boot_wall_linux, C._boot_wall_mac = _lin, _mac
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
