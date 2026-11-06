#!/usr/bin/env python3
"""kijito-inbox-wait: block until the next wake-worthy inbox event, print it, exit.

Run it from Claude Code with Bash run_in_background=true. A background Bash command wakes the
session exactly once, when it exits, and it has no 30-minute limit. The Monitor tool caps every
watch at 30 minutes, so a persistent inbox watch built on it either goes deaf or wakes the
session every half hour for nothing. This waiter is the long-lived replacement: arm it, and
re-arm it each time it wakes you.

    python3 -I ~/.claude/kijito-inbox-wait.py --persona <P> --events <stream file>

ON WAKE: re-arm FIRST (the same command), THEN read the inbox with
kijito_hive_inbox(persona=<P>, unread_only=true, mark_read=false). Mail that lands between the wake
and the re-arm is in that read, so nothing falls in the gap.

WHY NOT A BARE `tail -F` IN THE BACKGROUND. It is CAPTURE-ONLY: it never exits, so the harness never
re-invokes the agent and mail sits unseen. A consumer wakes a session only by exiting (background
Bash) or by printing into a Monitor. Arm at most ONE consumer per stream: a second one double-fires
every event (this waiter refuses to start a second copy; see exit 4).

NO BACKGROUND BASH? Use the Monitor tool with `tail -n 0 -F <stream> | grep --line-buffered -E
'"event": ?"(new|alert|...)"'` (the SessionStart hook prints the exact line). It stops after 30
minutes, so re-arm it each time it ends.

It follows the stream with a real `tail -n 0 -F <stream>` child, so every existing consumer
probe (the SessionStart hook, the heartbeat watchdog, inbox-selftest, the skills' pgrep) sees
this waiter as the stream's consumer.

EXIT CODES (each one prints a single first line that says what happened):
  0  a wake-worthy event arrived; the first line is the event (truncated)
  1  the waiter could not keep watching (tail missing or exited, bad arguments)
  2  NO STREAM: nothing is writing this persona's events, so nothing could ever wake you. The
     line names the command that starts a producer. (tail -F on a missing file waits forever,
     and that silence would look exactly like "no mail".)
  3  --max-wait elapsed with nothing to wake on
  4  another kijito-inbox-wait already waits on this stream: the inbox is watched, arm nothing
  5  the process that started this waiter went away (its session ended, or it was run with a
     detached '&'), so there is no one left to wake

NETWORK-BLIP DEBOUNCE. On a flaky network the producer emits a source-DOWN `alert` and, soon
after, `recovered`. Each used to wake the agent for nothing. By default a source-DOWN alert that
is followed by `recovered` within --grace seconds (600) wakes nobody; one still unrecovered when
the window ends wakes you with the alert. A `recovered` with no pending alert does not wake.
--grace 0 turns the debounce off: every alert and every `recovered` wakes at once, as before.
ONLY the source-DOWN alert (the one carrying `consecutive_failures`) is debounced: every other
alert, `new`, `still_unread` and every other diagnostic wakes immediately.

stdlib only; safe under `python3 -I`.
"""
import argparse
import hashlib
import json
import os
import queue
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

EXIT_EVENT, EXIT_ERROR, EXIT_NO_STREAM, EXIT_TIMEOUT, EXIT_ALREADY, EXIT_ORPHANED = 0, 1, 2, 3, 4, 5
MAX_LINE = 400

# The same name list every documented consumer filter uses. It is the fallback only: a producer that
# stamps `wake_class` is matched structurally (everything except `liveness` wakes), so a new kind is
# covered the day the producer adds it.
WAKE_KINDS = ("new", "alert", "recovered", "state_corrupt", "baseline_skipped", "seed_ahead",
              "replay_capped", "persona_added", "still_unread")
_WAKE_RE = re.compile(r'"event": ?"(%s)"' % "|".join(WAKE_KINDS))

HERE = os.path.dirname(os.path.abspath(__file__))


def _say(msg):
    try:
        sys.stdout.write(msg.rstrip("\n") + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        pass        # nobody is reading (the session went away); the exit code still says what happened


def _clip(line):
    line = line.rstrip("\r\n")
    if len(line) <= MAX_LINE:
        return line
    return "%s...[+%d chars]" % (line[:MAX_LINE], len(line) - MAX_LINE)


def _lib():
    for cand in (os.path.join(HERE, "kijito-persona-lib.sh"),
                 os.path.join(os.path.expanduser("~"), ".claude", "kijito-persona-lib.sh")):
        if os.path.isfile(cand):
            return cand
    return None


def _lib_call(func, *args):
    """Run one function from kijito-persona-lib.sh and return its stdout, or None.

    The persona->stream rule and the restart hint live in that lib so the hook, the watchdog and the
    self-test cannot drift apart. Calling it rather than re-implementing it keeps this waiter on the
    same rule.
    """
    lib = _lib()
    if lib is None:
        return None
    try:
        r = subprocess.run(["bash", "-c", '. "$1" 2>/dev/null; shift; "$@"', "kijito-inbox-wait", lib, func] + list(args),
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    out = r.stdout.decode("utf-8", "replace").strip()
    return out if (r.returncode == 0 and out) else None


def _persona_from_marker():
    dirs = [os.environ.get("CLAUDE_PROJECT_DIR", ""), os.getcwd()]
    return _lib_call("kijito_persona_from_marker", *[d for d in dirs if d])


def _start_hint(persona):
    p = persona or "<persona>"
    hint = None
    sup = _lib_call("kijito_supervisor_for", p)
    if sup:
        hint = _lib_call("kijito_restart_hint", sup, p)
    return hint or "~/.claude/kijito-inbox-start.sh --persona %s" % shlex.quote(p)


def _is_wake(line):
    try:
        ev = json.loads(line)
    except ValueError:
        ev = None
    if isinstance(ev, dict):
        wc = ev.get("wake_class")
        if isinstance(wc, str):
            return wc != "liveness", ev
        return ev.get("event") in WAKE_KINDS, ev
    return bool(_WAKE_RE.search(line)), None


def _is_down_alert(ev):
    # The source-DOWN alert is the only alert that carries consecutive_failures, and the only one a
    # `recovered` closes. Gap, unread-hidden, pin, stranded and urgent alerts are not network noise.
    return isinstance(ev, dict) and ev.get("event") == "alert" and "consecutive_failures" in ev


def _take_lock(stream):
    """Hold a per-stream lock for this waiter's life. Returns (fh, None), or (None, holder_pid).

    One waiter per stream: a second one would wake the session twice for every event. The kernel
    drops the lock when the holder dies, so a crashed waiter never blocks the next one. Hosts without
    fcntl (native Windows) skip the lock; the documented pgrep check still applies there.
    """
    try:
        import fcntl
    except ImportError:
        return None, None
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    d = os.path.join(base, "kijito-inbox-wait")
    try:
        os.makedirs(d, exist_ok=True)
        key = hashlib.sha256(os.path.realpath(stream).encode("utf-8", "surrogateescape")).hexdigest()[:16]
        path = os.path.join(d, "%s.%s.lock" % (re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(stream)), key))
        fh = open(path, "a+")
    except OSError:
        return None, None
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            fh.seek(0)
            holder = fh.read().split()[0]
        except (OSError, IndexError):
            holder = "?"
        fh.close()
        return None, holder
    fh.seek(0)
    fh.truncate()
    fh.write("%d %s\n" % (os.getpid(), stream))
    fh.flush()
    return fh, None


class _Args(argparse.ArgumentParser):
    def error(self, message):
        # argparse exits 2 on a usage error; 2 means NO STREAM here, so a typo must not read as that.
        self.print_usage(sys.stderr)
        _say("kijito-inbox-wait: bad arguments: %s" % message)
        sys.exit(EXIT_ERROR)


def main(argv=None):
    # --help prints the module docstring: it is the one full account of the exit codes, the debounce and
    # why a bare tail cannot wake anyone. The SessionStart hook stays short and points here instead.
    ap = _Args(
        prog="kijito-inbox-wait",
        # (`python3 -OO` strips docstrings; fall back to the one-line summary rather than crash.)
        description=(__doc__ or "Wait for the next wake-worthy Kijito inbox event, print it and exit. "
                     "Run with Bash run_in_background=true; re-arm after each wake.").split("\nstdlib only")[0].strip(),
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--persona", help="persona whose stream to watch (default: the .kijito_persona marker)")
    ap.add_argument("--events", help="the event stream file (default: resolved from the persona)")
    ap.add_argument("--grace", type=float, default=600.0, metavar="SECONDS",
                    help="hold a source-DOWN alert this long for a 'recovered' before waking (default 600; 0 = wake at once)")
    ap.add_argument("--max-wait", type=float, default=None, metavar="SECONDS",
                    help="give up after this long with exit 3 (default: wait indefinitely)")
    args = ap.parse_args(argv)
    if args.grace < 0:
        ap.error("--grace must be >= 0")
    if args.max_wait is not None and args.max_wait <= 0:
        ap.error("--max-wait must be > 0")

    persona = args.persona or None
    stream = args.events or None
    if not stream:
        if not persona:
            persona = _persona_from_marker()
        if not persona:
            _say("kijito-inbox-wait: NO PERSONA - pass --persona <name> (or --events <stream file>), or add a "
                 ".kijito_persona marker to the project. Nothing is being watched.")
            return EXIT_NO_STREAM
        stream = _lib_call("kijito_stream_for_persona", persona)
    if not stream or not os.path.exists(stream):
        where = stream or ("no event stream for persona %r on this machine" % persona)
        _say("kijito-inbox-wait: NO STREAM (%s) - the inbox producer is not running for %s, so nothing could "
             "ever wake you. Start it: %s - then arm this waiter again."
             % (where, repr(persona) if persona else "this persona", _start_hint(persona)))
        return EXIT_NO_STREAM

    lock, holder = _take_lock(stream)
    if holder is not None:
        _say("kijito-inbox-wait: ALREADY WAITING - pid %s already waits on %s. Your inbox is watched; "
             "arm nothing." % (holder, stream))
        return EXIT_ALREADY

    try:
        tail = subprocess.Popen(["tail", "-n", "0", "-F", stream], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    except OSError as e:
        _say("kijito-inbox-wait: cannot start tail (%s); nothing is watching %s." % (e, stream))
        return EXIT_ERROR

    def stop_tail():
        if tail.poll() is None:
            try:
                tail.terminate()
                tail.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                try:
                    tail.kill()
                except OSError:
                    pass

    def on_signal(signum, _frame):
        stop_tail()
        os._exit(128 + signum)

    for name in ("SIGTERM", "SIGHUP", "SIGINT"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, on_signal)
            except (OSError, ValueError):
                pass

    lines = queue.Queue()

    def reader():
        for raw in iter(tail.stdout.readline, b""):
            lines.put(raw.decode("utf-8", "replace"))
        lines.put(None)

    threading.Thread(target=reader, daemon=True).start()

    start = time.monotonic()
    deadline = start + args.max_wait if args.max_wait else None
    ppid = os.getppid() if os.name == "posix" else None
    pending = None          # (line, monotonic time it arrived) for a source-DOWN alert on hold
    try:
        while True:
            now = time.monotonic()
            if pending is not None and now - pending[1] >= args.grace:
                _say(_clip(pending[0]))
                _say("kijito-inbox-wait: the source has been DOWN for over %ds with no 'recovered' (debounce window %ds). "
                     "Re-arm this waiter; a later 'recovered' will not wake you." % (int(now - pending[1]), int(args.grace)))
                return EXIT_EVENT
            if deadline is not None and now >= deadline:
                _say("kijito-inbox-wait: TIMEOUT - no wake-worthy event on %s in %ds (--max-wait). Re-arm to keep waiting."
                     % (stream, int(args.max_wait)))
                if pending is not None:
                    _say("note: a source-DOWN alert has been held for %ds and has not recovered yet: %s"
                         % (int(now - pending[1]), _clip(pending[0])))
                return EXIT_TIMEOUT
            if ppid is not None and os.getppid() != ppid:
                _say("kijito-inbox-wait: the process that started this waiter is gone, so no session would be woken; "
                     "exiting. Arm it with Bash run_in_background=true, not a detached '&'.")
                return EXIT_ORPHANED
            waits = [1.0]
            if pending is not None:
                waits.append(pending[1] + args.grace - now)
            if deadline is not None:
                waits.append(deadline - now)
            try:
                line = lines.get(timeout=max(0.01, min(waits)))
            except queue.Empty:
                continue
            if line is None:
                rc = tail.wait()
                _say("kijito-inbox-wait: the tail on %s exited (rc=%s); nothing is watching it now. Re-arm." % (stream, rc))
                return EXIT_ERROR
            if not line.strip():
                continue
            wake, ev = _is_wake(line)
            if not wake:
                continue
            if _is_down_alert(ev) and args.grace > 0:
                if pending is None:
                    pending = (line, time.monotonic())
                continue
            if isinstance(ev, dict) and ev.get("event") == "recovered" and args.grace > 0:
                pending = None          # a blip, or a recovery from an outage already reported: no wake
                continue
            _say(_clip(line))
            if pending is not None:
                _say("note: a source-DOWN alert arrived %ds ago and has not recovered yet: %s"
                     % (int(time.monotonic() - pending[1]), _clip(pending[0])))
            return EXIT_EVENT
    finally:
        stop_tail()
        if lock is not None:
            try:
                lock.close()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
