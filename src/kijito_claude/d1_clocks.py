"""Triple-stamp clock primitives for the D1 wake ledger.

Implements assay's binding Clause-0 schema ruling (hive 3902, Kijito [[24453]],
which replaced the dual-stamp ruling [[24438]]): every wake-ledger row carries
CLOCK_REALTIME + CLOCK_MONOTONIC + CLOCK_BOOTTIME, and the true boot wall
instant is captured from the on-disk boot record at window/soak OPEN.

WHY THREE AND NOT TWO
---------------------
The dual-stamp design (wall + monotonic) was refuted by ladybug/argus
measurement: under a hypervisor pause the guest's wall clock and its monotonic
clock CO-FREEZE, so the "assert the wall-monotonic delta is constant" check
cannot see the pause at all. This seat executes a measured ~39.7% of wall time
under Parallels pauses that no in-guest instrument records. Two co-freezing
quantities are ONE instrument, not two.

The third clock breaks the tie, because BOOTTIME and MONOTONIC freeze
differently:

    freeze_cumulative = (wall - boot_wall) - boottime

Differencing freeze_cumulative across two rows attributes frozen time to the
interval BETWEEN them -- pure ledger arithmetic, no live probe. And:

    boottime - monotonic   nonzero -> guest suspend (guest knew it slept)
                           ~zero with freeze -> hypervisor pause (guest did not)

Unchanged from the earlier ruling: a monotonic RESET (reboot) voids the
in-flight window or soak segment; a freeze does NOT void it.

THE PER-OS TRAP -- READ BEFORE EDITING
--------------------------------------
The POSIX clock names do NOT mean the same thing on Linux and macOS, and the
mapping is INVERTED between them. Getting this wrong does not raise; it
silently swaps "guest suspend" and "hypervisor pause" in every verdict.

    semantic wanted        Linux                  macOS
    ---------------------  ---------------------  -----------------------
    excludes sleep/suspend CLOCK_MONOTONIC        CLOCK_UPTIME_RAW
    includes sleep/suspend CLOCK_BOOTTIME         CLOCK_MONOTONIC

So macOS CLOCK_MONOTONIC is Linux CLOCK_BOOTTIME's semantic, and macOS has no
CLOCK_BOOTTIME at all. Mac compatibility is a hard constraint (kijito-claude is
a published public package; per-OS paths are permitted, breaking either OS is
not), so this module resolves the SEMANTIC it wants per platform rather than
naming a constant and hoping.

FAIL CLOSED
-----------
Every function here returns an explicit "unmeasurable" rather than a plausible
number. A meter that cannot distinguish "zero" from "cannot measure" is worse
than no meter -- that defect shipped in myctx.sh and printed a confident
0.0%/free-100% to the caller deciding whether to recycle.
"""

import os
import platform
import re
import subprocess
import time

__all__ = [
    "ClockError",
    "Stamps",
    "read_stamps",
    "boot_wall_instant",
    "freeze_cumulative",
    "suspend_kind",
    "segment_voided",
]


class ClockError(Exception):
    """A clock could not be READ. Never raised to mean 'the value is zero'."""


_IS_MAC = platform.system() == "Darwin"


def _clock_excluding_sleep():
    """Seconds on a clock that does NOT advance while the machine sleeps."""
    if _IS_MAC:
        cid = getattr(time, "CLOCK_UPTIME_RAW", None)
        if cid is None:
            raise ClockError(
                "macOS without CLOCK_UPTIME_RAW: cannot obtain a sleep-excluding "
                "clock. Refusing to substitute CLOCK_MONOTONIC, which on macOS "
                "INCLUDES sleep and would invert the suspend verdict."
            )
        return time.clock_gettime(cid)
    cid = getattr(time, "CLOCK_MONOTONIC", None)
    if cid is None:
        raise ClockError("Linux without CLOCK_MONOTONIC")
    return time.clock_gettime(cid)


def _clock_including_sleep():
    """Seconds on a clock that DOES advance while the machine sleeps."""
    if _IS_MAC:
        cid = getattr(time, "CLOCK_MONOTONIC", None)
        if cid is None:
            raise ClockError("macOS without CLOCK_MONOTONIC")
        return time.clock_gettime(cid)
    cid = getattr(time, "CLOCK_BOOTTIME", None)
    if cid is None:
        raise ClockError(
            "Linux without CLOCK_BOOTTIME: cannot obtain a sleep-including "
            "clock. Refusing to substitute CLOCK_MONOTONIC, which on Linux "
            "EXCLUDES suspend and would hide guest-suspend entirely."
        )
    return time.clock_gettime(cid)


class Stamps(object):
    """One row's three clocks. Immutable by convention.

    `wall` is CLOCK_REALTIME (seconds, float). `mono` excludes sleep.
    `boot` includes sleep. The semantic -- not the constant name -- is what is
    guaranteed across platforms; see the module docstring.
    """

    __slots__ = ("wall", "mono", "boot", "platform")

    def __init__(self, wall, mono, boot, platform_name):
        self.wall = wall
        self.mono = mono
        self.boot = boot
        self.platform = platform_name

    def as_dict(self):
        return {
            "wall": self.wall,
            "mono": self.mono,
            "boot": self.boot,
            "platform": self.platform,
        }

    def __repr__(self):
        return "Stamps(wall=%.6f, mono=%.6f, boot=%.6f, platform=%r)" % (
            self.wall,
            self.mono,
            self.boot,
            self.platform,
        )


def read_stamps():
    """Sample all three clocks as close together as the runtime allows.

    Read order is deliberate: the two derived clocks are sampled adjacently so
    that `boot - mono` -- the suspend discriminator -- carries the least
    sampling skew of the three pairs.
    """
    mono = _clock_excluding_sleep()
    boot = _clock_including_sleep()
    wall = time.time()
    return Stamps(wall, mono, boot, platform.system())


# --------------------------------------------------------------------------
# Boot wall instant. Captured at window/soak OPEN, from an ON-DISK record --
# it must survive a freeze, so it may not be derived from an in-process clock.
# --------------------------------------------------------------------------

def _boot_wall_linux():
    # /proc/stat's btime is the kernel's own boot epoch and needs no parsing of
    # locale-formatted dates, so it is tried first.
    try:
        with open("/proc/stat", "r") as fh:
            for line in fh:
                if line.startswith("btime "):
                    return float(line.split()[1]), "/proc/stat:btime"
    except (IOError, OSError, ValueError, IndexError):
        pass
    # `who -b` reads the on-disk wtmp/utmp boot record.
    try:
        out = subprocess.check_output(["who", "-b"], stderr=subprocess.DEVNULL)
        out = out.decode("utf-8", "replace").strip()
        m = re.search(r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})", out)
        if m:
            struct = time.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M")
            return time.mktime(struct), "who -b"
    except (OSError, subprocess.CalledProcessError, ValueError):
        pass
    return None, None


def _boot_wall_mac():
    # macOS has no /proc; kern.boottime is the kernel's own record.
    try:
        out = subprocess.check_output(
            ["sysctl", "-n", "kern.boottime"], stderr=subprocess.DEVNULL
        )
        out = out.decode("utf-8", "replace")
        m = re.search(r"sec\s*=\s*(\d+)", out)
        if m:
            return float(m.group(1)), "sysctl kern.boottime"
    except (OSError, subprocess.CalledProcessError, ValueError):
        pass
    return None, None


def boot_wall_instant():
    """The wall-clock instant this host booted, from an on-disk kernel record.

    Returns (epoch_seconds, source). Raises ClockError if no source could be
    read -- it does NOT fall back to `time.time() - boottime`, because that
    expression is exactly what a clock step corrupts, and silently returning it
    would make the freeze arithmetic self-confirming.
    """
    value, source = (_boot_wall_mac() if _IS_MAC else _boot_wall_linux())
    if value is None:
        raise ClockError(
            "no on-disk boot record readable (%s). Refusing to derive boot time "
            "from wall-minus-boottime: that is the quantity the freeze "
            "arithmetic exists to check, and deriving it would make the check "
            "always pass." % ("macOS" if _IS_MAC else "Linux")
        )
    return value, source


# --------------------------------------------------------------------------
# Derived quantities
# --------------------------------------------------------------------------

def freeze_cumulative(stamps, boot_wall):
    """Total wall time this host has not been executing, since boot.

    (wall - boot_wall) is elapsed wall since boot; `boot` is elapsed EXECUTING
    time since boot including guest sleep. The difference is time the host was
    frozen out from under itself -- i.e. hypervisor pauses.

    Difference this across two rows to attribute freeze to the interval BETWEEN
    them. The absolute value is not meaningful on its own: it accumulates every
    pause since boot and includes any clock-step error.
    """
    return (stamps.wall - boot_wall) - stamps.boot


def suspend_kind(stamps, boot_wall, freeze_tolerance=2.0):
    """Classify what has happened to this host's time, from one row's stamps.

    Returns one of:
      "RUNNING"          nothing detected beyond sampling noise
      "GUEST_SUSPEND"    the guest slept and knows it (boot - mono grew)
      "HYPERVISOR_PAUSE" the guest was frozen and cannot see it
      "BOTH"             both signatures present

    `freeze_tolerance` is in seconds and exists because the three clocks are
    sampled microseconds apart and the boot record has 1-second granularity.
    It is a NOISE floor, not a policy threshold -- do not widen it to silence a
    real signal; a widened bound is how D5(ii)'s ceiling came to sit above the
    pathology it existed to catch.
    """
    slept = stamps.boot - stamps.mono
    frozen = freeze_cumulative(stamps, boot_wall)
    has_sleep = slept > freeze_tolerance
    has_freeze = frozen > freeze_tolerance
    if has_sleep and has_freeze:
        return "BOTH"
    if has_sleep:
        return "GUEST_SUSPEND"
    if has_freeze:
        return "HYPERVISOR_PAUSE"
    return "RUNNING"


def segment_voided(open_stamps, now_stamps):
    """Does a monotonic RESET void the in-flight window/soak segment?

    True iff the sleep-excluding clock went BACKWARDS, which on a live host can
    only mean the host rebooted under the segment. A freeze does not void a
    segment; only a reset does.

    Returns (voided: bool, reason: str).
    """
    if now_stamps.mono < open_stamps.mono:
        return True, (
            "monotonic reset: %.3f -> %.3f (host rebooted under the segment)"
            % (open_stamps.mono, now_stamps.mono)
        )
    return False, ""
