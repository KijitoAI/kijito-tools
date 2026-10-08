#!/usr/bin/env bash
# Row M488 P2b — `kijito-tools redeem-key ...` runs the vendored monitor's --redeem-key, and NOTHING else.
#
# WHY THIS EXISTS. install.sh is a --provider dispatcher whose default provider ignores arguments it does not
# know, so kijito-tools 0.2.16 answers `npx kijito-tools redeem-key --kind watcher` by running the whole toolkit
# install (settings.json merge, a SessionStart hook) and dropping the piped pickup code. 0.2.17 intercepts
# `redeem-key` in BOTH launchers (bin/cli.js for npm, src/kijito_tools/cli.py for PyPI) before anything
# touches bash. This test runs the two shipped launchers, byte for byte, inside package layouts that mirror the
# real npm and wheel payloads, with:
#   * a stub monitor that records its argv, its stdin, the interpreter's isolated / no-site flags and any
#     signal it received, then exits with the code it is told to;
#   * a stub install.sh, and a `bash` on PATH, that both record the call and fail loudly.
#
# PROPERTIES UNDER TEST
#   (a) `redeem-key ARGS` runs `python -I -S <monitor> --redeem-key ARGS` with ARGS verbatim, stdin passed
#       through byte for byte, and the monitor's exit code (0 2 3 4 5 6 7 8) and death-by-signal propagated;
#   (b) install.sh and bash are never invoked on any redeem-key path, refusals and near misses included;
#   (c) anything outside the allow-list (names, value shapes) is refused with exit 2 and runs nothing, and a
#       refusal never echoes an argument value (a misplaced pickup code or key stays out of the transcript);
#   (d) the node and the python launcher behave identically (exit code, stdout, stderr, what the monitor
#       received), including which signals reach the monitor: a SIGTERM or SIGHUP aimed at the launcher alone
#       reaches the MONITOR (node relays it, python has exec'd), and a process-group kill ends in exactly one
#       outcome line;
#   plus: Python lookup (node) uses absolute PATH entries only, so a python3 planted in the working directory
#   never runs; no Python / a broken python3 / no monitor file are refused cleanly; the Windows interpreter
#   order; non-redeem arguments still reach the installer; and the real monitor (the vendored copy, or
#   REDEEM_REAL_MONITOR=<path to a kijito_inbox_monitor.py>) accepts exactly what the launchers pass, with no
#   network, and survives a group kill through both launchers.
# PUBLISH GATE (prepublishOnly runs this): once package.json or pyproject.toml says 0.2.17 or later (or
#   REDEEM_REQUIRE_REAL=1), the BUNDLED monitor must support --redeem-key, or this test fails.
#
#   bash tests/redeem_key_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; [ -n "${2:-}" ] && printf "        %s\n" "$2"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
check() { if [ "$2" = 1 ]; then grn "$1"; else red "$1" "${3:-}"; fi; }

NODE="$(command -v node || true)"
PY="$(python3 -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
[ -n "$NODE" ] || { echo "FAIL: node is required (it runs bin/cli.js)"; exit 1; }
[ -n "$PY" ] || { echo "FAIL: python3 is required (it runs src/kijito_tools/cli.py)"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT INT TERM
INSTALL_MARK="$T/install.mark"; BASH_MARK="$T/bash.mark"; PY3_MARK="$T/badpy3.mark"; PLANT_MARK="$T/planted.mark"

# ---------------------------------------------------------------- fixtures
cat > "$T/stub_monitor.py" <<'PY'
import json, os, signal, sys, time
rec = {"argv": sys.argv[1:], "isolated": sys.flags.isolated, "no_site": sys.flags.no_site,
       "script": os.path.realpath(sys.argv[0]), "signals": []}
code = int(os.environ.get("STUB_EXIT", "0"))
mode = os.environ.get("STUB_MODE", "")
def save():
    json.dump(rec, open(os.environ["STUB_OUT"], "w"))
if mode == "sleep":
    # Like the real monitor's interrupt path: the first signal ignores every later one, then ONE outcome line.
    def on_signal(signum, frame):
        for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(s, signal.SIG_IGN)
        rec["signals"].append(signum)
        save()
        sys.stdout.write("STUB_OUTCOME signal=%d\n" % signum); sys.stdout.flush()
        os._exit(code)
    for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(s, on_signal)
    rec["stdin"] = ""
    save()
    if os.environ.get("STUB_STARTED"):
        open(os.environ["STUB_STARTED"], "w").close()
    time.sleep(3.0)
    save()
    sys.stdout.write("STUB_OUTCOME signal=none\n"); sys.stdout.flush()
    sys.exit(code)
rec["stdin"] = sys.stdin.buffer.read().decode("latin-1")
save()
sys.stdout.write("STUB_MONITOR_RAN\n"); sys.stdout.flush()
if mode == "sigkill":
    os.kill(os.getpid(), signal.SIGKILL)
if mode == "sigterm":
    os.kill(os.getpid(), signal.SIGTERM)
sys.exit(code)
PY
cat > "$T/stub_install.sh" <<EOF
#!/usr/bin/env bash
echo "install.sh \$*" >> "$INSTALL_MARK"
echo "STUB INSTALLER RAN -- redeem-key must never get here" >&2
exit 97
EOF
chmod +x "$T/stub_install.sh"

# mkpkgs NAME MONITOR_SOURCE -> $T/NAME/npm (the npm payload: bin/cli.js, install.sh, providers/monitor/)
# and $T/NAME/py (the wheel: kijito_tools/ with _assets/install.sh and _assets/providers/monitor/). The
# launchers are copied from the repo unchanged. An empty MONITOR_SOURCE leaves the monitor out.
mkpkgs() {
  local d="$T/$1" src="$2"
  mkdir -p "$d/npm/bin" "$d/npm/providers/monitor" "$d/py/kijito_tools/_assets/providers/monitor"
  cp "$REPO/bin/cli.js" "$d/npm/bin/cli.js"
  cp "$REPO/src/kijito_tools/__init__.py" "$REPO/src/kijito_tools/cli.py" "$d/py/kijito_tools/"
  cp "$T/stub_install.sh" "$d/npm/install.sh"
  cp "$T/stub_install.sh" "$d/py/kijito_tools/_assets/install.sh"
  if [ -n "$src" ]; then
    cp "$src" "$d/npm/providers/monitor/kijito_inbox_monitor.py"
    cp "$src" "$d/py/kijito_tools/_assets/providers/monitor/kijito_inbox_monitor.py"
  fi
  # The console-script entry point, as pip/pipx generate it: import main, exit with its return value.
  printf 'import sys\nsys.path.insert(0, %s)\nfrom kijito_tools.cli import main\nraise SystemExit(main())\n' \
    "'$d/py'" > "$d/py/run.py"
}
mkpkgs stub "$T/stub_monitor.py"
mkpkgs nomon ""

# PATH for the runs: python3 and a `bash` that records and fails. No real bash, no installer route.
SHIM="$T/shim"; mkdir -p "$SHIM"
ln -s "$PY" "$SHIM/python3"
printf '#!/bin/sh\necho "bash $*" >> "%s"\necho "SHIM BASH RAN" >&2\nexit 98\n' "$BASH_MARK" > "$SHIM/bash"
chmod +x "$SHIM/bash"

# set_cmd L PKG -> CMD=(the argv that starts launcher L (node|py) of package PKG). (No mapfile: bash 3.2.)
set_cmd() {
  if [ "$1" = node ]; then CMD=("$NODE" "$T/$2/npm/bin/cli.js"); else CMD=("$PY" "$T/$2/py/run.py"); fi
}

# launch L PKG STDIN_FILE ARGS... -> runs launcher L of package PKG with PATH=${LPATH:-$SHIM}, in ${LCWD:-.};
# sets RC, and leaves $T/out $T/err $T/rec (the stub's record, absent when the monitor did not run).
launch() {
  local L="$1" pkg="$2" in="$3"; shift 3
  set_cmd "$L" "$pkg"
  rm -f "$T/rec" "$T/out" "$T/err"
  ( cd "${LCWD:-.}" && STUB_OUT="$T/rec" PATH="${LPATH:-$SHIM}" "${CMD[@]}" "$@" <"$in" >"$T/out" 2>"$T/err" )
  RC=$?
}

# rec_is ARGS... -> 1 when the stub ran as `-I -S <stub> --redeem-key ARGS...` and read exactly $T/stdin_expected
rec_is() {
  [ -f "$T/rec" ] || { echo 0; return; }
  "$PY" - "$T/rec" "$T/stdin_expected" "$@" <<'PY'
import json, sys
rec = json.load(open(sys.argv[1]))
want_stdin = open(sys.argv[2], "rb").read().decode("latin-1")
ok = (rec["argv"] == ["--redeem-key"] + sys.argv[3:] and rec["isolated"] == 1 and rec["no_site"] == 1
      and rec["script"].endswith("kijito_inbox_monitor.py") and rec["stdin"] == want_stdin)
if not ok:
    sys.stderr.write("record: %r\n" % rec)
print(1 if ok else 0)
PY
}
# rec_signals -> the signals the stub recorded, comma-separated ("" for none, NOT RUN without a record)
rec_signals() {
  [ -f "$T/rec" ] || { echo "NOT RUN"; return; }
  "$PY" -c 'import json,sys; print(",".join(str(s) for s in json.load(open(sys.argv[1]))["signals"]))' "$T/rec"
}

# What the monitor received, minus its own path (the npm and wheel layouts differ there by design).
rec_norm() {
  [ -f "$T/rec" ] || { echo "NOT RUN"; return; }
  "$PY" -c 'import json,sys; r=json.load(open(sys.argv[1])); r.pop("script"); print(json.dumps(r, sort_keys=True))' "$T/rec"
}

CODE='kpc_7QK3ABCDEFGHJKMNPQRSTVWXYZ012345@api.kijito.ai'
KEY='kjt_SECRETSECRETSECRETSECRETSECRETSECRET1234567'
printf '%s\n' "$CODE" > "$T/in_code"
: > "$T/in_empty"
SIGTERM_N=$("$PY" -c 'import signal; print(int(signal.SIGTERM))')
SIGHUP_N=$("$PY" -c 'import signal; print(int(signal.SIGHUP))')
SIGINT_N=$("$PY" -c 'import signal; print(int(signal.SIGINT))')

# Every redeem-key case is run through both launchers; the results must match each other as well as the
# expectation. parity_case NAME EXIT STDIN_FILE ARGS...  (EXIT=refuse means: refused, nothing runs)
parity_case() {
  local name="$1" want="$2" in="$3"; shift 3
  local nrc nout nrec nerr prc pout prec perr
  cp "$in" "$T/stdin_expected"
  for L in node py; do
    launch "$L" stub "$in" redeem-key "$@"
    if [ "$want" = refuse ]; then
      local refused=0
      [ "$RC" = 2 ] && [ ! -f "$T/rec" ] && grep -qx 'REDEEM_REFUSED reason=usage' "$T/out" && refused=1
      check "[$L] $name -> refused, exit 2, monitor not run" "$refused" "rc=$RC out=$(head -c 300 "$T/out") err=$(head -c 300 "$T/err")"
      # A refusal names the option at most, never a value that might be a code or a key.
      if grep -q 'kpc_\|kjt_SECRET\|SECRET\|kjt_AbCd12345' "$T/out" "$T/err"; then
        red "[$L] $name -> the refusal echoes an argument value" "$(cat "$T/err")"
      fi
    else
      check "[$L] $name -> exit $want" "$([ "$RC" = "$want" ] && echo 1 || echo 0)" "rc=$RC err=$(head -c 300 "$T/err")"
      check "[$L] $name -> monitor got --redeem-key + exact args, stdin byte-exact, -I -S" "$(rec_is "$@")"
    fi
    if [ "$L" = node ]; then nrc=$RC; nout=$(cat "$T/out"); nrec=$(rec_norm); nerr=$(cat "$T/err")
    else prc=$RC; pout=$(cat "$T/out"); prec=$(rec_norm); perr=$(cat "$T/err"); fi
  done
  check "[parity] $name -> node and python identical (exit, stdout, stderr, what the monitor received)" \
    "$([ "$nrc" = "$prc" ] && [ "$nout" = "$pout" ] && [ "$nrec" = "$prec" ] && [ "$nerr" = "$perr" ] && echo 1 || echo 0)" \
    "node rc=$nrc py rc=$prc; node out=[$nout] py out=[$pout]; node err=[$nerr] py err=[$perr]"
}

echo "== (a) redeem-key reaches the monitor: exact args, stdin, exit codes =="
parity_case "the command a reply renders (watcher, per-persona file, renew prefix)" 0 "$T/in_code" \
  --kind watcher --api-base 'https://api.kijito.ai' --token-file '~/.config/kijito-inbox-monitor/token.argus' \
  --replace-prefix kjt_AbCd1234 --expect-account acct_0123456789abcdef
parity_case "--opt=value forms, --replace, --no-verify" 0 "$T/in_code" \
  --kind=rest --api-base=http://127.0.0.1:7490 --token-file='~/.config/kijito/api_token' --replace --no-verify
parity_case "--replace-prefix=, --expect-account= forms" 0 "$T/in_code" \
  --kind=watcher --replace-prefix=kjt_-_Zz0099 --expect-account=acct_ffffffffffffffff
parity_case "no options at all (the monitor itself asks for --kind)" 0 "$T/in_code"
parity_case "--help" 0 "$T/in_empty" --help
parity_case "-h" 0 "$T/in_empty" -h
parity_case "empty stdin is passed as empty" 0 "$T/in_empty" --kind watcher
printf 'kpc_first\r\nsecond line\n\001\377tail-without-newline' > "$T/in_odd"
parity_case "stdin with CRLF, a second line, high bytes and no final newline, byte for byte" 0 "$T/in_odd" --kind watcher
for code in 2 3 4 5 6 7 8; do
  STUB_EXIT=$code parity_case "monitor exit $code is the launcher's exit" "$code" "$T/in_code" --kind watcher
done

echo "== (a) death by signal propagates =="
cp "$T/in_code" "$T/stdin_expected"
for mode in sigkill:137 sigterm:143; do
  m=${mode%%:*}; want=${mode##*:}
  for L in node py; do
    STUB_MODE=$m launch "$L" stub "$T/in_code" redeem-key --kind watcher
    check "[$L] monitor killed by ${m#sig} -> launcher status $want (as a direct run)" "$([ "$RC" = "$want" ] && echo 1 || echo 0)" "rc=$RC"
  done
done

# Seen by a parent that reads the wait status (not just $?, where 137 and a SIGKILL death look the same): the
# launcher itself dies by the monitor's signal.
for mode in sigkill:-9 sigterm:-15; do
  m=${mode%%:*}; want=${mode##*:}
  for L in node py; do
    set_cmd "$L" stub
    got=$(STUB_MODE=$m STUB_OUT="$T/rec" PATH="$SHIM" "$PY" -c 'import subprocess, sys; print(subprocess.run(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode)' "${CMD[@]}" redeem-key --kind watcher)
    check "[$L] monitor killed by ${m#sig} -> the launcher's own wait status is that signal ($want)" "$([ "$got" = "$want" ] && echo 1 || echo 0)" "got $got"
  done
done

echo "== (c) everything outside the allow-list is refused, nothing runs =="
parity_case "unknown option --persona" refuse "$T/in_code" --kind watcher --persona river
parity_case "abbreviation --kin (argparse would accept it)" refuse "$T/in_code" --kin watcher
parity_case "abbreviation --token (argparse would accept it)" refuse "$T/in_code" --kind watcher --token x
parity_case "--kind with no value" refuse "$T/in_code" --kind
parity_case "--kind swallowing a flag" refuse "$T/in_code" --kind --replace
parity_case "--kind= (empty)" refuse "$T/in_code" --kind=
parity_case "--api-base with a dash value" refuse "$T/in_code" --kind watcher --api-base -x
parity_case "--expect-account=--persona" refuse "$T/in_code" --kind watcher --expect-account=--persona
parity_case "--replace=yes" refuse "$T/in_code" --kind watcher --replace=yes
parity_case "a pickup code as a positional (and it is not echoed)" refuse "$T/in_code" --kind watcher "$CODE"
parity_case "a key as a positional after a flag (and it is not echoed)" refuse "$T/in_code" --replace "$KEY"
parity_case "a code smuggled in an unknown --opt=value (value not echoed)" refuse "$T/in_code" --kind watcher "--code=$CODE"
parity_case "a bare --" refuse "$T/in_code" --kind watcher --
parity_case "short option -k" refuse "$T/in_code" -k watcher
parity_case "short option with = (-k=watcher)" refuse "$T/in_code" -k=watcher
parity_case "-h=x" refuse "$T/in_code" -h=x
parity_case "--kind twice" refuse "$T/in_code" --kind watcher --kind rest
parity_case "-h and --help together" refuse "$T/in_code" -h --help
parity_case "--redeem-key again" refuse "$T/in_code" --redeem-key --kind watcher
echo "-- value shapes (refused by the launcher, so argparse never quotes the value) --"
parity_case "--kind other than watcher/rest" refuse "$T/in_code" --kind admin
parity_case "--kind holding a pickup code (not echoed)" refuse "$T/in_code" --kind "$CODE"
parity_case "--kind=WATCHER (case matters)" refuse "$T/in_code" --kind=WATCHER
parity_case "--expect-account not acct_<16 hex>" refuse "$T/in_code" --kind watcher --expect-account acct_0123
parity_case "--expect-account with upper-case hex" refuse "$T/in_code" --kind watcher --expect-account acct_0123456789ABCDEF
parity_case "--expect-account holding a key (not echoed)" refuse "$T/in_code" --kind watcher --expect-account "$KEY"
parity_case "--replace-prefix of 9 characters" refuse "$T/in_code" --kind watcher --replace-prefix kjt_AbCd12345
parity_case "--replace-prefix of 7 characters" refuse "$T/in_code" --kind watcher --replace-prefix kjt_AbCd123
parity_case "--replace-prefix holding a whole key (not echoed)" refuse "$T/in_code" --kind watcher --replace-prefix "$KEY"
parity_case "--replace-prefix=<whole key> (not echoed)" refuse "$T/in_code" --kind watcher "--replace-prefix=$KEY"
echo "-- watcher options, each in its own shape (a boolean alone, a valued one with a value) --"
for f in --self-test --print-api-base --all-personas --no-content --no-fast-path --no-stranded-alerts --no-urgent-alerts; do
  parity_case "watcher boolean $f (no trailing value)" refuse "$T/in_code" --kind watcher "$f"
done
for f in --safe-persona --check-activity --token-file-template --exec --emit --persona --personas --auth-header --state-file --events-file; do
  parity_case "watcher option $f with a value" refuse "$T/in_code" --kind watcher "$f" x
done

echo "== near misses never reach the installer =="
# Built with chr() so the file stays ASCII: U+2010 hyphen, U+2013 en dash, U+2212 minus, U+2014 em dash,
# U+FF52 fullwidth r, U+00A0 no-break space.
NEAR=(); NEAR_DESC=()
while IFS=$'\t' read -r line desc; do NEAR+=("$line"); NEAR_DESC+=("$desc"); done < <("$PY" - <<'PY'
spellings = [
    "--redeem-key", "redeem_key", "REDEEM-KEY", "redeem", "redeemkey", "redeem-keys", "--redeem-key=1",
    "redeem" + chr(0x2010) + "key", "redeem" + chr(0x2013) + "key", "redeem" + chr(0x2212) + "key",
    chr(0xFF52) + "edeem-key", "redeem-key ", " redeem-key", "redeem" + chr(0xA0) + "-key",
]
for s in spellings:
    print(s + "\t" + ascii(s))   # the description is ASCII, so the test output stays valid text
PY
)
check "the near-miss list was built (${#NEAR[@]} spellings)" "$([ "${#NEAR[@]}" -ge 14 ] && echo 1 || echo 0)"
near_refused() {  # $1 label; rest = args
  local label="$1"; shift
  for L in node py; do
    launch "$L" stub "$T/in_code" "$@"
    check "[$L] $label -> refused (exit 2), no install, no monitor" \
      "$([ "$RC" = 2 ] && [ ! -f "$T/rec" ] && grep -qx 'REDEEM_REFUSED reason=usage' "$T/out" && echo 1 || echo 0)" "rc=$RC err=$(cat "$T/err")"
    if grep -q 'kpc_' "$T/out" "$T/err"; then red "[$L] $label -> the refusal echoes the code"; fi
  done
}
# Each spelling ALONE (with no redeem-only option beside it, which would be refused on its own account).
for i in "${!NEAR[@]}"; do near_refused "near miss ${NEAR_DESC[$i]} alone" "${NEAR[$i]}"; done
near_refused "two words: redeem key" redeem key
near_refused "redeem-key not first (--provider claude redeem-key)" --provider claude redeem-key
near_refused "an installer run with a redeem-only option (--kind watcher alone)" --kind watcher
near_refused "an installer run with an em-dash option (<U+2014>kind watcher)" "$("$PY" -c 'print(chr(0x2014) + "kind")')" watcher
for f in --expect-account=acct_0123456789abcdef --api-base=https://api.kijito.ai --token-file=x --replace \
         --replace-prefix=kjt_AbCd1234 --no-verify; do
  near_refused "an installer run carrying $f" --provider codex --skills-only "$f"
done
near_refused "an installer run with a pickup code as an argument (not echoed)" "$CODE"
near_refused "a redeem-only option with a stray leading space (' --kind')" " --kind" watcher
near_refused "a redeem-only option with a stray trailing space ('--no-verify ')" "--no-verify "
# The refusal names the right, version-floored spelling for each runner (never a bare name that a cache could
# resolve to an older kijito-tools, which would run the installer).
launch node stub "$T/in_code" --redeem-key
check "[node] the near-miss refusal names npx -y 'kijito-tools@>=0.2.17' redeem-key" \
  "$(grep -qF "npx -y 'kijito-tools@>=0.2.17' redeem-key" "$T/err" && echo 1 || echo 0)" "$(cat "$T/err")"
launch py stub "$T/in_code" --redeem-key
check "[py] the near-miss refusal names pipx run --spec 'kijito-tools>=0.2.17' kijito-tools redeem-key" \
  "$(grep -qF "pipx run --spec 'kijito-tools>=0.2.17' kijito-tools redeem-key" "$T/err" && echo 1 || echo 0)" "$(cat "$T/err")"

echo "== missing monitor file =="
for L in node py; do
  launch "$L" nomon "$T/in_code" redeem-key --kind watcher
  check "[$L] no vendored monitor -> exit 2 REDEEM_REFUSED reason=no_helper" \
    "$([ "$RC" = 2 ] && grep -qx 'REDEEM_REFUSED reason=no_helper' "$T/out" && echo 1 || echo 0)" "rc=$RC out=$(cat "$T/out")"
done

echo "== (b) install.sh and bash were never invoked on any redeem-key path =="
check "install.sh never ran" "$([ ! -e "$INSTALL_MARK" ] && echo 1 || echo 0)" "$(cat "$INSTALL_MARK" 2>/dev/null)"
check "bash never ran" "$([ ! -e "$BASH_MARK" ] && echo 1 || echo 0)" "$(cat "$BASH_MARK" 2>/dev/null)"

echo "== node: finding Python =="
NOPY="$T/nopy"; mkdir -p "$NOPY"; cp "$SHIM/bash" "$NOPY/bash"
LPATH="$NOPY" launch node stub "$T/in_code" redeem-key --kind watcher
check "no python3/python on PATH -> exit 2 REDEEM_REFUSED reason=no_python, nothing ran" \
  "$([ "$RC" = 2 ] && [ ! -f "$T/rec" ] && grep -qx 'REDEEM_REFUSED reason=no_python' "$T/out" && [ ! -e "$INSTALL_MARK" ] && [ ! -e "$BASH_MARK" ] && echo 1 || echo 0)" \
  "rc=$RC out=$(cat "$T/out") err=$(cat "$T/err")"
if [ "$(uname -s)" = Darwin ]; then
  check "on macOS the no_python message names the Command Line Tools dialog" "$(grep -q 'Command Line Tools' "$T/err" && echo 1 || echo 0)" "$(cat "$T/err")"
fi
# A python3 that exists but does not run Python 3.9+ (the Windows Store alias exits 9009; an old python fails
# the version check): skipped for the next candidate, and never handed the monitor.
BADPY="$T/badpy"; mkdir -p "$BADPY"; cp "$SHIM/bash" "$BADPY/bash"
printf '#!/bin/sh\necho "$*" >> "%s"\nexit 9009\n' "$PY3_MARK" > "$BADPY/python3"; chmod +x "$BADPY/python3"
ln -s "$PY" "$BADPY/python"
cp "$T/in_code" "$T/stdin_expected"
LPATH="$BADPY" launch node stub "$T/in_code" redeem-key --kind watcher
check "a broken python3 is skipped and python runs the monitor (exit 0, exact args, stdin)" \
  "$([ "$RC" = 0 ] && [ "$(rec_is --kind watcher)" = 1 ] && echo 1 || echo 0)" "rc=$RC err=$(cat "$T/err")"
check "the broken python3 was only probed (-I -S -c ...), never given the monitor" \
  "$(grep -q -- '-I -S -c' "$PY3_MARK" && ! grep -q 'kijito_inbox_monitor' "$PY3_MARK" && echo 1 || echo 0)" "$(cat "$PY3_MARK" 2>/dev/null)"
# A python3 that is not executable, in an earlier absolute PATH entry, is passed over for the next python3 on
# PATH (as a shell's lookup would), not taken and then failed.
NOEXEC="$T/noexec"; mkdir -p "$NOEXEC"; printf '#!/bin/sh\nexit 0\n' > "$NOEXEC/python3"; chmod 644 "$NOEXEC/python3"
ONLY3="$T/only3"; mkdir -p "$ONLY3"; ln -s "$PY" "$ONLY3/python3"
LPATH="$NOEXEC:$ONLY3" launch node stub "$T/in_code" redeem-key --kind watcher
check "a non-executable python3 earlier on PATH is skipped for the next python3" \
  "$([ "$RC" = 0 ] && [ "$(rec_is --kind watcher)" = 1 ] && echo 1 || echo 0)" "rc=$RC out=$(cat "$T/out") err=$(head -c 300 "$T/err")"
# A python3 planted in the working directory (an agent's workspace) must never run, whatever PATH says about
# the current directory: an empty entry, '.', or a relative one.
PLANT="$T/workspace"; mkdir -p "$PLANT/rel"
for f in "$PLANT/python3" "$PLANT/python" "$PLANT/rel/python3"; do
  printf '#!/bin/sh\necho "PLANTED $0 $*" >> "%s"\nexit 0\n' "$PLANT_MARK" > "$f"; chmod +x "$f"
done
for p in ":$SHIM" "$SHIM:" ".:$SHIM" "rel:$SHIM" "$SHIM::."; do
  LCWD="$PLANT" LPATH="$p" launch node stub "$T/in_code" redeem-key --kind watcher
  check "PATH='${p//$T/\$T}' with a python3 planted in the working directory -> the absolute one runs, the planted never" \
    "$([ "$RC" = 0 ] && [ "$(rec_is --kind watcher)" = 1 ] && [ ! -e "$PLANT_MARK" ] && echo 1 || echo 0)" \
    "rc=$RC planted=$(cat "$PLANT_MARK" 2>/dev/null) err=$(head -c 300 "$T/err")"
done
LCWD="$PLANT" LPATH=":.:rel" launch node stub "$T/in_code" redeem-key --kind watcher
check "only relative/empty PATH entries -> no_python, and the planted python3 never ran" \
  "$([ "$RC" = 2 ] && grep -qx 'REDEEM_REFUSED reason=no_python' "$T/out" && [ ! -e "$PLANT_MARK" ] && echo 1 || echo 0)" "rc=$RC planted=$(cat "$PLANT_MARK" 2>/dev/null)"

echo "== node: lookup functions, including Windows (no Windows here, so the functions are called directly) =="
"$NODE" - "$T/stub/npm/bin/cli.js" <<'JS' > "$T/order.out" 2>&1
const m = require(process.argv[2]);
const assert = require('node:assert');
assert.deepStrictEqual(m.pythonCandidates('win32'), [['py', ['-3']], ['python3', []], ['python', []]]);
assert.deepStrictEqual(m.pythonCandidates('linux'), [['python3', []], ['python', []]]);
assert.deepStrictEqual(m.pythonCandidates('darwin'), [['python3', []], ['python', []]]);
assert.deepStrictEqual(m.PY_FLAGS, ['-I', '-S']);
// resolveOnPath: absolute entries only; Windows <name>.exe, quoted entries unwrapped.
const seen = [];
const has = (set) => (full) => { seen.push(full); return set.has(full); };
assert.strictEqual(m.resolveOnPath('py', 'win32', 'relative;;.;C:\\Windows', has(new Set(['C:\\Windows\\py.exe']))), 'C:\\Windows\\py.exe');
assert.deepStrictEqual(seen, ['C:\\Windows\\py.exe']);   // relative, empty and '.' never even looked at
assert.strictEqual(m.resolveOnPath('python3', 'win32', '"C:\\Py 3"', has(new Set(['C:\\Py 3\\python3.exe']))), 'C:\\Py 3\\python3.exe');
assert.strictEqual(m.resolveOnPath('python3', 'win32', 'C:\\Py', has(new Set(['C:\\Py\\python3']))), null); // .exe only
assert.strictEqual(m.resolveOnPath('python3', 'linux', ':.:bin:/usr/bin', has(new Set(['python3', './python3', 'bin/python3', '/usr/bin/python3']))), '/usr/bin/python3');
assert.strictEqual(m.resolveOnPath('python3', 'linux', ':.:bin', () => true), null);
assert.strictEqual(m.resolveOnPath('python3', 'linux', undefined, () => true), null);
// findPython: probes the RESOLVED absolute path with -I -S, and returns that same path.
const calls = [];
const fake = (cmd, args, opts) => {
  calls.push([cmd, args, opts.stdio]);
  if (cmd === 'C:\\W\\python3.exe') return { status: 9009 };   // the Store alias
  return { status: 0 };
};
const where = { py: null, python3: 'C:\\W\\python3.exe', python: 'C:\\P\\python.exe' };
assert.deepStrictEqual(m.findPython('win32', fake, (n) => where[n]), ['C:\\P\\python.exe', []]);
assert.deepStrictEqual(calls.map((c) => c[0]), ['C:\\W\\python3.exe', 'C:\\P\\python.exe']);
assert.deepStrictEqual(calls[0][1].slice(0, 3), ['-I', '-S', '-c']);
assert.ok(calls.every((c) => c[2] === 'ignore'));
const c2 = [];
assert.deepStrictEqual(m.findPython('win32', (cmd, args) => { c2.push(args); return { status: 0 }; }, (n) => (n === 'py' ? 'C:\\Windows\\py.exe' : assert.fail('looked past py'))), ['C:\\Windows\\py.exe', ['-3']]);
assert.deepStrictEqual(c2[0].slice(0, 4), ['-3', '-I', '-S', '-c']);
assert.strictEqual(m.findPython('linux', () => ({ status: 1 }), () => '/usr/bin/python3'), null);
assert.strictEqual(m.findPython('linux', () => assert.fail('probed a name that did not resolve'), () => null), null);
console.log('LOOKUP_OK');
JS
check "Windows tries py -3, python3, python as absolute <name>.exe paths; probe and run the same path, -I -S, no shell" \
  "$(grep -qx LOOKUP_OK "$T/order.out" && echo 1 || echo 0)" "$(cat "$T/order.out")"

echo "== signals: the monitor decides the outcome, through either launcher =="
# start_bg L PKG [pgid] ARGS... -> starts the launcher in the background with the sleeping stub, waits until
# the stub is running, sets BGPID. With pgid=1 it runs in a new process group (its pid is the group id) with
# SIGINT at its default, as a terminal's foreground job would.
start_bg() {
  local L="$1" pkg="$2" grp="$3"; shift 3
  set_cmd "$L" "$pkg"
  rm -f "$T/started" "$T/rec" "$T/out" "$T/err"
  if [ "$grp" = 1 ]; then
    STUB_MODE=sleep STUB_EXIT=6 STUB_STARTED="$T/started" STUB_OUT="$T/rec" PATH="$SHIM" \
      "$PY" -c 'import os, signal, sys; os.setpgid(0, 0); signal.signal(signal.SIGINT, signal.SIG_DFL); os.execv(sys.argv[1], sys.argv[1:])' \
      "${CMD[@]}" "$@" </dev/null >"$T/out" 2>"$T/err" &
  else
    STUB_MODE=sleep STUB_EXIT=6 STUB_STARTED="$T/started" STUB_OUT="$T/rec" PATH="$SHIM" \
      "${CMD[@]}" "$@" </dev/null >"$T/out" 2>"$T/err" &
  fi
  BGPID=$!
  for _ in $(seq 1 100); do [ -e "$T/started" ] && break; sleep 0.05; done
}
for L in node py; do
  for sig in TERM HUP; do
    start_bg "$L" stub 0 redeem-key --kind watcher
    kill -"$sig" "$BGPID" 2>/dev/null; wait "$BGPID"; RC=$?
    want=$([ "$sig" = TERM ] && echo "$SIGTERM_N" || echo "$SIGHUP_N")
    check "[$L] SIG$sig to the launcher pid alone -> the MONITOR received it (relayed / exec'd) and its exit 6 is the result" \
      "$([ "$RC" = 6 ] && [ "$(rec_signals)" = "$want" ] && [ "$(grep -c '^STUB_OUTCOME' "$T/out")" = 1 ] && echo 1 || echo 0)" \
      "rc=$RC signals=[$(rec_signals)] out=$(cat "$T/out") err=$(head -c 300 "$T/err")"
  done
  for sig in TERM INT; do
    start_bg "$L" stub 1 redeem-key --kind watcher
    kill -"$sig" -- "-$BGPID" 2>/dev/null; wait "$BGPID"; RC=$?
    want=$([ "$sig" = TERM ] && echo "$SIGTERM_N" || echo "$SIGINT_N")
    check "[$L] SIG$sig to the whole process group -> exactly one outcome line, the monitor's exit 6" \
      "$([ "$RC" = 6 ] && [ "$(rec_signals)" = "$want" ] && [ "$(grep -c '^STUB_OUTCOME' "$T/out")" = 1 ] && echo 1 || echo 0)" \
      "rc=$RC signals=[$(rec_signals)] out=$(cat "$T/out") err=$(head -c 300 "$T/err")"
  done
done
# SIGINT is deliberately NOT relayed by node: a terminal Ctrl-C reaches the whole foreground group already.
start_bg node stub 0 redeem-key --kind watcher
kill -INT "$BGPID" 2>/dev/null; wait "$BGPID"; RC=$?
check "[node] SIGINT to the launcher pid alone is swallowed, not relayed (the monitor finishes on its own)" \
  "$([ "$RC" = 6 ] && [ "$(rec_signals)" = "" ] && grep -qx 'STUB_OUTCOME signal=none' "$T/out" && echo 1 || echo 0)" \
  "rc=$RC signals=[$(rec_signals)] out=$(cat "$T/out")"

echo "== everything else still goes to the installer (unchanged) =="
for L in node py; do
  rm -f "$INSTALL_MARK"
  LPATH="$PATH" launch "$L" stub "$T/in_empty" --provider codex --skills-only
  check "[$L] '--provider codex --skills-only' -> install.sh with those args" \
    "$([ "$RC" = 97 ] && grep -qx 'install.sh --provider codex --skills-only' "$INSTALL_MARK" && echo 1 || echo 0)" "rc=$RC mark=$(cat "$INSTALL_MARK" 2>/dev/null)"
done
rm -f "$INSTALL_MARK"

echo "== publish gate: a release that promises redeem-key must bundle a monitor that has it =="
# ver_ge A B -> success when version A >= B (numeric dotted compare).
ver_ge() { "$PY" -c 'import sys; t=lambda v: tuple(int(x) for x in v.split(".")[:3]); sys.exit(0 if t(sys.argv[1]) >= t(sys.argv[2]) else 1)' "$1" "$2"; }
# has_redeem MONITOR -> success when that monitor's own --help lists --redeem-key (the feature, not a version
# string: the P2a source still said 0.5.15 when it gained --redeem-key).
has_redeem() { "$PY" -I -S "$1" --help 2>/dev/null | grep -q -- '--redeem-key'; }
# gate_verdict VERSION MONITOR -> PASS or FAIL
gate_verdict() {
  if (ver_ge "$1" 0.2.17 || [ "${REDEEM_REQUIRE_REAL:-0}" = 1 ]) && ! has_redeem "$2"; then echo FAIL; else echo PASS; fi
}
printf 'import sys\nprint("usage: kijito-inbox-monitor [--persona PERSONA] [--self-test]")\n' > "$T/old_monitor.py"
printf 'import sys\nprint("usage: kijito-inbox-monitor [--persona PERSONA] [--redeem-key]")\n' > "$T/new_monitor.py"
check "gate canary: 0.2.17 with a monitor lacking --redeem-key -> FAIL" "$([ "$(gate_verdict 0.2.17 "$T/old_monitor.py")" = FAIL ] && echo 1 || echo 0)"
check "gate canary: 0.3.0 with a monitor lacking --redeem-key -> FAIL" "$([ "$(gate_verdict 0.3.0 "$T/old_monitor.py")" = FAIL ] && echo 1 || echo 0)"
check "gate canary: 0.2.17 with a monitor that has --redeem-key -> PASS" "$([ "$(gate_verdict 0.2.17 "$T/new_monitor.py")" = PASS ] && echo 1 || echo 0)"
check "gate canary: 0.2.16 with a monitor lacking --redeem-key -> PASS (nothing promised yet)" "$([ "$(REDEEM_REQUIRE_REAL=0 gate_verdict 0.2.16 "$T/old_monitor.py")" = PASS ] && echo 1 || echo 0)"
check "gate canary: REDEEM_REQUIRE_REAL=1 forces it at any version" "$([ "$(REDEEM_REQUIRE_REAL=1 gate_verdict 0.2.16 "$T/old_monitor.py")" = FAIL ] && echo 1 || echo 0)"
BUNDLED="$REPO/providers/monitor/kijito_inbox_monitor.py"
npm_ver=$("$NODE" -p "require('$REPO/package.json').version")
py_ver=$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO/pyproject.toml" | head -1)
for v in "$npm_ver" "$py_ver"; do
  check "this package ($v): the bundled monitor supports what the version promises" \
    "$([ "$(gate_verdict "$v" "$BUNDLED")" = PASS ] && echo 1 || echo 0)" \
    "version $v >= 0.2.17 (or REDEEM_REQUIRE_REAL=1) but providers/monitor has no --redeem-key: re-vendor kijito-inbox-monitor 0.6.0 first"
done

echo "== the real monitor accepts what the launchers pass (no network: bad code / --help / an interrupt) =="
REAL="${REDEEM_REAL_MONITOR:-$BUNDLED}"
mkpkgs real "$REAL"
ver=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$REAL" | head -1)
if has_redeem "$REAL"; then
  printf 'kpc_not_a_real_code\n' > "$T/in_bad"
  for L in node py; do
    launch "$L" real "$T/in_empty" redeem-key --help
    check "[$L] real monitor $ver: redeem-key --help -> exit 0 and documents --redeem-key" \
      "$([ "$RC" = 0 ] && grep -q -- '--redeem-key' "$T/out" && echo 1 || echo 0)" "rc=$RC err=$(head -c 400 "$T/err")"
    launch "$L" real "$T/in_bad" redeem-key --kind watcher --api-base 'https://api.kijito.ai' \
      --token-file '~/.config/kijito-inbox-monitor/token' --replace-prefix kjt_AbCd1234 \
      --expect-account acct_0123456789abcdef --no-verify
    check "[$L] real monitor $ver: every value flag + --no-verify parsed; a bad code exits 2 (bad_code) before any request" \
      "$([ "$RC" = 2 ] && grep -q '^REDEEM_REFUSED .*reason=bad_code' "$T/out" && ! grep -q 'unrecognized arguments' "$T/err" && echo 1 || echo 0)" \
      "rc=$RC out=$(cat "$T/out") err=$(head -c 400 "$T/err")"
    launch "$L" real "$T/in_bad" redeem-key --kind=rest --replace
    check "[$L] real monitor $ver: --kind=rest --replace parsed; bad code -> exit 2 before any request" \
      "$([ "$RC" = 2 ] && grep -q '^REDEEM_REFUSED .*reason=bad_code' "$T/out" && ! grep -q 'unrecognized arguments' "$T/err" && echo 1 || echo 0)" \
      "rc=$RC out=$(cat "$T/out") err=$(head -c 400 "$T/err")"
    # An interrupt while the monitor waits for the code on stdin (nothing sent yet): a group SIGTERM reaches
    # it directly AND (node) through the relay. Exactly one outcome line, the not-consumed exit 6, no traceback.
    rm -f "$T/fifo"; mkfifo "$T/fifo"; exec 9<>"$T/fifo"
    set_cmd "$L" real
    PATH="$SHIM" "$PY" -c 'import os, signal, sys; os.setpgid(0, 0); signal.signal(signal.SIGINT, signal.SIG_DFL); os.execv(sys.argv[1], sys.argv[1:])' \
      "${CMD[@]}" redeem-key --kind watcher <"$T/fifo" >"$T/out" 2>"$T/err" &
    pid=$!
    sleep 1.5
    kill -TERM -- "-$pid" 2>/dev/null; wait "$pid"; RC=$?
    exec 9>&-
    check "[$L] real monitor $ver: group SIGTERM while waiting for the code -> exit 6, exactly one outcome line, no traceback" \
      "$([ "$RC" = 6 ] && [ "$(grep -c . "$T/out")" = 1 ] && ! grep -q Traceback "$T/err" && echo 1 || echo 0)" \
      "rc=$RC out=$(cat "$T/out") err=$(head -c 600 "$T/err")"
  done
else
  # Before the 0.6.0 re-vendor: the redeem still never reaches the installer; the monitor says it is too
  # old in the words the reply's "unrecognized arguments: --redeem-key" line matches.
  for L in node py; do
    launch "$L" real "$T/in_code" redeem-key --kind watcher
    check "[$L] vendored monitor $ver has no --redeem-key -> its own 'unrecognized arguments: --redeem-key', exit 2" \
      "$([ "$RC" = 2 ] && grep -q 'unrecognized arguments: --redeem-key' "$T/err" && echo 1 || echo 0)" "rc=$RC err=$(head -c 400 "$T/err")"
  done
  echo "  note  the real-helper leg needs a monitor with --redeem-key: REDEEM_REAL_MONITOR=<path> (0.6.0+)"
fi
check "install.sh and bash never ran on a real-monitor redeem" "$([ ! -e "$INSTALL_MARK" ] && [ ! -e "$BASH_MARK" ] && echo 1 || echo 0)"

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
