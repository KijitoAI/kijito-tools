"""Console entry point: run the bundled bash installer (install.sh).

The bash scripts and skills are shipped as package data under ``_assets/``. We locate
them through ``importlib.resources`` (works whether the package is installed normally or
run via ``pipx run``) and shell out to ``bash``. ``install.sh`` resolves its siblings
relative to its own directory, so we run it with ``cwd`` set to the assets directory.

ONE EXCEPTION, ``redeem-key`` (row M488): ``pipx run kijito-tools redeem-key --kind ...`` (or
``uvx kijito-tools redeem-key ...``) collects an API key minted with delivery="pickup". It is
intercepted here, before the bash lookup, and runs the vendored kijito-inbox-monitor's
``--redeem-key`` with this same Python. It never runs install.sh or bash, writes nothing itself and
makes no request itself: the monitor does the whole redeem. install.sh is a ``--provider``
dispatcher whose default provider ignores unknown arguments, so without this intercept
``redeem-key`` would run the whole toolkit install and drop the pickup code on the floor (what
kijito-tools 0.2.16 does). ``bin/cli.js`` is the npm twin and must behave the same;
``tests/redeem_key_test.sh`` runs both side by side.
"""

from __future__ import annotations

import importlib.resources as resources
import os
import re
import shutil
import signal
import subprocess
import sys

# The flags the monitor's --redeem-key reads (its argparse: --kind, --api-base, --token-file, --replace,
# --replace-prefix, --expect-account, --no-verify), plus help. Exact names only: argparse would also take an
# abbreviation such as --tok, which this launcher refuses so that what runs is what was written.
REDEEM_VALUE_FLAGS = frozenset({"--kind", "--expect-account", "--api-base", "--token-file", "--replace-prefix"})
REDEEM_BOOL_FLAGS = frozenset({"--replace", "--no-verify", "--help", "-h"})
_QUOTABLE_FLAG = re.compile(r"--?[A-Za-z][A-Za-z0-9-]{0,40}")


def _quotable_flag(arg: str):
    """An option NAME may be quoted back in an error; nothing else from argv ever is (a misplaced pickup
    code or key must not be echoed into a transcript)."""
    name = arg.split("=", 1)[0]
    return name if _QUOTABLE_FLAG.fullmatch(name) else None


def check_redeem_args(args):
    """None when ``args`` (everything after ``redeem-key``) may be handed to the monitor verbatim, else why
    not. Same rules, same order, same messages as checkRedeemArgs() in bin/cli.js."""
    seen = set()
    i = 0
    while i < len(args):
        arg = args[i]
        name, value = arg, None
        eq = arg.find("=") if arg.startswith("--") else -1
        if eq > 0:
            name, value = arg[:eq], arg[eq + 1:]
        if name in REDEEM_VALUE_FLAGS:
            if value is None:
                if i + 1 >= len(args):
                    return "%s needs a value" % name
                i += 1
                value = args[i]
            # A value never starts with '-' (a kind, an acct_ fingerprint, a kjt_ prefix, a URL, a path), so a
            # dash there means a flag was swallowed as a value; argparse would read it differently.
            if value == "" or value.startswith("-"):
                return "%s needs a value" % name
        elif name in REDEEM_BOOL_FLAGS:
            if value is not None:
                return "%s takes no value" % name
            if name == "-h":
                name = "--help"
        elif not arg.startswith("-"):
            return ("unexpected argument %d (not shown): redeem-key takes no positional argument; the pickup "
                    "code goes on stdin, never on the command line" % (i + 1))
        else:
            q = _quotable_flag(arg)
            return ("%s; redeem-key accepts only --kind, --expect-account, --api-base, --token-file, --replace, "
                    "--replace-prefix, --no-verify"
                    % ("unknown option %s" % q if q else "unknown option at argument %d" % (i + 1)))
        if name in seen:
            return "%s given more than once" % name
        seen.add(name)
        i += 1
    return None


def redeem_near_miss(args) -> bool:
    """Arguments that look like an attempt to redeem but are not ``redeem-key`` in first position. They are
    never installer arguments, so they are refused rather than handed to install.sh (whose default provider
    would run the toolkit install and ignore them)."""
    for a in args:
        n = re.sub(r"^-+", "", str(a).lower()).replace("_", "-")
        if n in ("redeem-key", "redeemkey", "redeem"):
            return True
    return False


def _refuse(reason: str, message: str) -> int:
    """The monitor's own refusal shape: one machine line on stdout, the reason on stderr, exit 2 (refused
    before anything was sent; the pickup code is still live)."""
    sys.stdout.write("REDEEM_REFUSED reason=%s\n" % reason)
    sys.stdout.flush()
    sys.stderr.write("kijito-tools: REDEEM_REFUSED: %s\n" % message)
    sys.stderr.flush()
    return 2


def _monitor_path():
    # One joinpath per component: a multi-argument Traversable.joinpath needs Python 3.11.
    p = resources.files("kijito_tools")
    for part in ("_assets", "providers", "monitor", "kijito_inbox_monitor.py"):
        p = p.joinpath(part)
    return p


def redeem_key(args) -> int:
    why = check_redeem_args(args)
    if why:
        return _refuse("usage", why)
    monitor = _monitor_path()
    if not monitor.is_file():
        return _refuse("no_helper", "this kijito-tools package has no providers/monitor/kijito_inbox_monitor.py; "
                       "reinstall it, or use the uvx or pipx line from the same reply. Nothing was sent; the code "
                       "is still live")
    # This interpreter (the package requires Python >= 3.9) runs the monitor: no PATH lookup, so no other
    # python3 can stand in for it.
    exe = sys.executable
    if not exe or not os.path.isfile(exe):
        return _refuse("no_python", "this Python does not know its own executable, so redeem-key cannot start the "
                       "helper; use the uvx or npx line from the same reply. Nothing was sent; the code is still "
                       "live")
    # -I (isolated): no PYTHONPATH / PYTHON* variables, no user site-packages, no script directory on sys.path.
    # The monitor is stdlib-only, so nothing in a project's environment can shadow a module it imports while it
    # handles a key. stdin is inherited untouched (this process never reads it): the code goes straight to it.
    cmd = [exe, "-I", str(monitor), "--redeem-key", *args]
    sys.stdout.flush()
    sys.stderr.flush()
    if os.name == "posix":
        # Become the monitor: its exit status, its signals and its stdin are the caller's directly.
        try:
            os.execv(exe, cmd)
        except OSError as e:
            return _refuse("spawn_failed", "could not start %s (%s). Nothing was sent; the code is still live"
                           % (exe, type(e).__name__))
    # Windows: os.exec* is emulated there (spawn, then exit), so run it as a child and pass its exit code on.
    # A console Ctrl-C reaches every process on the console; the monitor owns the outcome of an interrupt (it
    # prints what happened and exits 6, 7, 5 or 8), so this process ignores it until the monitor returns.
    restore = []
    for name in ("SIGINT", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                restore.append((sig, signal.signal(sig, lambda *_: None)))
            except (ValueError, OSError):
                pass
    try:
        return subprocess.call(cmd)
    except OSError as e:
        return _refuse("spawn_failed", "could not start %s (%s). Nothing was sent; the code is still live"
                       % (exe, type(e).__name__))
    finally:
        for sig, handler in restore:
            signal.signal(sig, handler)


def run_installer(argv) -> int:
    bash = shutil.which("bash")
    if bash is None:
        sys.stderr.write(
            "kijito-tools needs bash to run its installer.\n"
            "On Windows, run it inside WSL (recommended) or Git Bash.\n"
            "See https://github.com/KijitoAI/kijito-tools#platform-support\n"
        )
        return 1

    # For a normally installed wheel (pip/pipx unpack to disk) this is a real path and its
    # siblings (scripts/, skills/) are present next to install.sh.
    assets = resources.files("kijito_tools").joinpath("_assets")
    install_sh = assets.joinpath("install.sh")
    return subprocess.call(
        [bash, str(install_sh), *argv],
        cwd=str(assets),
    )


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["redeem-key"]:
        return redeem_key(argv[1:])
    if redeem_near_miss(argv):
        return _refuse("usage", "to collect a key, redeem-key must be the FIRST argument, spelled exactly: "
                       "pipx run kijito-tools redeem-key --kind watcher|rest ... (nothing was installed)")
    return run_installer(argv)


if __name__ == "__main__":
    raise SystemExit(main())
