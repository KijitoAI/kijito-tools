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

# A witness is TRUSTED only if it is a record WRITTEN AT BOOT and left alone
# afterwards. A witness is DERIVED if it is recomputed from the current wall
# clock -- those inherit every clock step and are useless as a boot instant,
# but they are excellent STEP DETECTORS, so they are read and reported rather
# than merely banned.
#
# MEASURED ON THIS SEAT 2026-08-05 (the reason this section was rewritten):
#     /proc/stat btime   2026-08-03T20:52:03Z   == now - uptime, EXACTLY
#     uptime -s          2026-08-03 14:52:03    same derived value
#     who -b             2026-07-31 14:04       agrees with wtmp
#     last -F reboot     Fri Jul 31 14:04:30    on-disk wtmp record
#     journalctl boot 0  Fri 2026-07-31 14:04:30
# The first two had absorbed a ~3-day clock step. Sourcing the boot instant
# from btime makes (wall - boot_wall) equal boottime BY CONSTRUCTION, so
# freeze_cumulative reads ~0 forever, on any host, under any pause. The first
# version of this module did exactly that -- while its own docstring refused
# "wall minus boottime" -- because btime ARRIVES UNDER A DIFFERENT NAME. The
# rename defeated the guard.


def _run(cmd):
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
        return out.decode("utf-8", "replace")
    except (OSError, subprocess.CalledProcessError):
        return None


def _parse_wtmp_reboot(text):
    # "reboot   system boot  7.0.0-28  Fri Jul 31 14:04:30 2026   still running"
    m = re.search(r"([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})", text or "")
    if not m:
        return None
    try:
        return time.mktime(time.strptime(m.group(1), "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        return None


def _witness_wtmp():
    return _parse_wtmp_reboot(_run(["last", "-F", "reboot"]))


def _witness_journal():
    text = _run(["journalctl", "--list-boots", "--no-pager"])
    if not text:
        return None
    for line in text.splitlines():
        # the current boot is index 0
        if re.match(r"\s*0\s+[0-9a-f]{8,}", line):
            m = re.search(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})", line)
            if m:
                try:
                    return time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
                except ValueError:
                    return None
    return None


def _witness_utmp():
    # `who -b` reads utmp's BOOT_TIME record, written at boot. Measured to
    # agree with wtmp and to DISagree with btime on a stepped host, which is
    # what places it on the trusted side. Minute resolution -- hence the
    # 120 s agreement tolerance.
    text = _run(["who", "-b"])
    m = re.search(r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})", text or "")
    if not m:
        return None
    try:
        return time.mktime(time.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M"))
    except ValueError:
        return None


def _witness_mac_utmpx():
    return _parse_wtmp_reboot(_run(["last", "reboot"]))


def _witness_mac_sysctl():
    text = _run(["sysctl", "-n", "kern.boottime"])
    m = re.search(r"sec\s*=\s*(\d+)", text or "")
    return float(m.group(1)) if m else None


def _derived_btime():
    try:
        with open("/proc/stat", "r") as fh:
            for line in fh:
                if line.startswith("btime "):
                    return float(line.split()[1])
    except (IOError, OSError, ValueError, IndexError):
        pass
    return None


# (name, callable). macOS note: kern.boottime's INDEPENDENCE FROM CLOCK STEPS
# IS UNVERIFIED -- no one has yet measured a stepped Mac. It is listed as a
# trusted witness so the Mac path works, and this comment is the standing
# marker that the measurement is owed. If it turns out to be step-inheriting,
# it moves to the derived list and macOS needs a second real witness.
_TRUSTED_LINUX = (("wtmp", _witness_wtmp), ("journal", _witness_journal), ("utmp", _witness_utmp))
_TRUSTED_MAC = (("utmpx", _witness_mac_utmpx), ("kern.boottime[UNVERIFIED]", _witness_mac_sysctl))

BOOT_AGREEMENT_TOLERANCE = 120.0


def boot_wall_instant(tolerance=BOOT_AGREEMENT_TOLERANCE):
    """The wall instant this host booted, from >=2 AGREEING on-disk witnesses.

    Returns (epoch_seconds, info) where info carries every witness read, the
    derived btime probe, and whether a clock step was detected.

    Requires at least TWO trusted witnesses agreeing within `tolerance`.
    One witness alone is not accepted: a single record cannot reveal that it
    is wrong, and this module exists because a single confident source was.

    Raises ClockError rather than returning a best guess. It never falls back
    to `time.time() - boottime` NOR to any restatement of it (/proc/stat
    btime, uptime -s): that expression is the quantity the freeze arithmetic
    checks, so returning it would make the check pass unconditionally.
    """
    witnesses = _TRUSTED_MAC if _IS_MAC else _TRUSTED_LINUX
    readings = {}
    for name, fn in witnesses:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            readings[name] = v

    info = {"witnesses": dict(readings), "derived_btime": None,
            "clock_step_detected": False, "step_delta_s": None}

    if not _IS_MAC:
        bt = _derived_btime()
        info["derived_btime"] = bt

    if len(readings) < 2:
        raise ClockError(
            "need >=2 agreeing on-disk boot witnesses, got %d (%s). Refusing to "
            "fall back to /proc/stat btime or uptime -s: both are the current "
            "wall clock minus uptime under another name, which makes the freeze "
            "arithmetic self-confirming."
            % (len(readings), ", ".join(sorted(readings)) or "none")
        )

    values = sorted(readings.values())
    spread = values[-1] - values[0]
    if spread > tolerance:
        raise ClockError(
            "trusted boot witnesses DISAGREE by %.1f s (> %.1f s tolerance): %s. "
            "Refusing to pick one -- disagreement among boot records is itself "
            "a clock event and must be attributed before any freeze arithmetic "
            "is trusted." % (spread, tolerance, readings)
        )

    # Median-ish: the middle reading, which for 2 witnesses is the earlier.
    value = values[len(values) // 2] if len(values) % 2 else values[0]

    if info["derived_btime"]:
        delta = abs(info["derived_btime"] - value)
        info["step_delta_s"] = delta
        if delta > tolerance:
            info["clock_step_detected"] = True

    return value, info


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


def freeze_intervals_from_journal(min_paired_entries=100, threshold_s=60.0):
    """Recover PER-INTERVAL host freeze from the systemd journal, historically.

    Every journal entry carries BOTH `__REALTIME_TIMESTAMP` and
    `__MONOTONIC_TIMESTAMP`. For consecutive entries, `dt_real - dt_mono` is
    the time the host did not execute between them. So the freeze ledger was
    already on disk and needed no new instrumentation (argus, 2026-08-05).

    Returns a list of (start_epoch, end_epoch, seconds), each >= threshold_s.

    WHY PER-INTERVAL AND NOT A SINCE-BOOT TOTAL -- this replaces the
    aggregate that produced two separate defects:
      * A row that POSTDATES the freeze inherited the whole since-boot
        penalty, so its host-hours were understated without bound and it
        could never age out. (Safe direction, but detection never fires.)
      * A row PREDATING the current boot had prior boots' freezes uncounted,
        so the "lower bound" overstated and could declare a loss EARLY --
        the unsafe direction, on exactly the old-dormant-file class the
        threshold exists to protect (assay, L2-F1).
    Both dissolve once freeze is attributed to the row's OWN window.

    LIMITS, inherited from the method: the journal bounds a freeze between
    ADJACENT entries, so each interval is an upper bound on the start and a
    lower bound on the end -- it localises, it does not timestamp to the
    second, and on an idle box adjacent entries can be minutes apart. Covers
    the CURRENT BOOT ONLY; there is no monotonic continuity across a reboot.

    FAILS CLOSED: raises rather than returning [] when too few entries were
    read. An empty list is indistinguishable from "no freezes" and this
    module's whole history is confident zeroes -- three of them in one day,
    from three different mechanisms.
    """
    if _IS_MAC:
        raise ClockError(
            "no systemd journal on macOS; per-interval freeze recovery needs a "
            "Mac-specific witness that has not been established yet"
        )
    text = _run(["journalctl", "-b", "-o", "export", "--no-pager"])
    if text is None:
        raise ClockError("journalctl unreadable")

    pairs = []
    real = mono = None
    for line in text.splitlines():
        if line.startswith("__REALTIME_TIMESTAMP="):
            try:
                real = int(line.split("=", 1)[1])
            except ValueError:
                real = None
        elif line.startswith("__MONOTONIC_TIMESTAMP="):
            try:
                mono = int(line.split("=", 1)[1])
            except ValueError:
                mono = None
            if real is not None and mono is not None:
                pairs.append((real, mono))
                real = mono = None

    if len(pairs) < min_paired_entries:
        raise ClockError(
            "only %d paired journal entries (< %d): refusing to report freeze "
            "intervals. An empty result here is indistinguishable from 'no "
            "freezes', which is the exact false absence this guard exists for."
            % (len(pairs), min_paired_entries)
        )

    pairs.sort()
    intervals = []
    for (r0, m0), (r1, m1) in zip(pairs, pairs[1:]):
        gap = ((r1 - r0) - (m1 - m0)) / 1e6
        if gap >= threshold_s:
            intervals.append((r0 / 1e6, r1 / 1e6, gap))
    return intervals


def freeze_in_window(intervals, t0, t1):
    """Seconds of host freeze overlapping [t0, t1], from per-interval data.

    Overlap is apportioned by the fraction of each interval's WALL span that
    falls inside the window. Because the journal localises rather than
    timestamps a freeze, an interval straddling a window edge is approximate;
    that approximation is bounded by the interval's own wall span, which is
    reported by the caller when it matters.
    """
    total = 0.0
    for start, end, seconds in intervals:
        lo, hi = max(start, t0), min(end, t1)
        if hi <= lo:
            continue
        span = end - start
        total += seconds if span <= 0 else seconds * ((hi - lo) / span)
    return total


def freeze_window_provider(intervals=None):
    """Return a per-host `freeze_lookup(t0, t1) -> seconds` callable.

    THE INTERFACE IS THE POINT, NOT THE JOURNAL. Consumers take a lookup
    callable and must not assume how it was derived -- the derivation is
    per-host and the shapes genuinely differ:

      Linux : the guest CANNOT FEEL a hypervisor pause, so freeze must be
              INFERRED by differencing realtime against monotonic across
              adjacent journal entries.
      macOS : sleep is guest-VISIBLE, so the OS records its own sleep
              intervals directly (`pmset -g log`). That provider is expected
              to be STRONGER than this one -- observed rather than inferred,
              with real interval boundaries instead of adjacent-entry
              localisation. It is ladybug's Darwin lane; this module must not
              pre-empt its shape.

    So: no caller of this may reach for `freeze_intervals_from_journal`
    directly. Pass `intervals` to inject any provider's output, including in
    tests.
    """
    if intervals is None:
        intervals = freeze_intervals_from_journal()
    return lambda t0, t1: freeze_in_window(intervals, t0, t1)


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
