#!/usr/bin/env bash
# Row M488 P2b — `kijito-tools redeem-key ...` runs the vendored monitor's --redeem-key, and NOTHING else.
#
# WHY THIS EXISTS. install.sh is a --provider dispatcher whose default provider ignores arguments it does not
# know, so kijito-tools 0.2.16 answers `npx kijito-tools redeem-key --kind watcher` by running the whole toolkit
# install (settings.json merge, a SessionStart hook) and dropping the piped pickup code. 0.2.17 intercepts
# `redeem-key` in BOTH launchers (bin/cli.js for npm, src/kijito_tools/cli.py for PyPI) before anything
# touches bash. This test runs the two shipped launchers, byte for byte, inside package layouts that mirror the
# real npm and wheel payloads, with:
#   * a stub monitor that records its argv, its stdin and the interpreter's isolated flag, then exits with
#     the code it is told to;
#   * a stub install.sh, and a `bash` on PATH, that both record the call and fail loudly.
#
# PROPERTIES UNDER TEST
#   (a) `redeem-key ARGS` runs `python -I <monitor> --redeem-key ARGS` with ARGS verbatim, stdin passed
#       through byte for byte, and the monitor's exit code (0 2 3 4 5 6 7 8) and death-by-signal propagated;
#   (b) install.sh and bash are never invoked on any redeem-key path, refusals included;
#   (c) anything outside the allow-list is refused with exit 2 and runs nothing, and a refusal never echoes
#       an argument value (a misplaced pickup code or key stays out of the transcript);
#   (d) the node and the python launcher behave identically (exit code, stdout, what the monitor received);
#   plus: no Python / a broken python3 / no monitor file are refused cleanly (node), the Windows interpreter
#   order, the launcher outliving a SIGTERM aimed at it alone, non-redeem arguments still reaching the
#   installer, and the real monitor's argparse (the vendored copy, or REDEEM_REAL_MONITOR=<path to a
#   kijito_inbox_monitor.py>) accepting exactly what the launchers pass, with no network.
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
INSTALL_MARK="$T/install.mark"; BASH_MARK="$T/bash.mark"; PY3_MARK="$T/badpy3.mark"

# ---------------------------------------------------------------- fixtures
cat > "$T/stub_monitor.py" <<'PY'
import json, os, signal, sys, time
rec = {"argv": sys.argv[1:], "isolated": sys.flags.isolated, "script": os.path.realpath(sys.argv[0])}
if os.environ.get("STUB_STARTED"):
    open(os.environ["STUB_STARTED"], "w").close()
mode = os.environ.get("STUB_MODE", "")
code = int(os.environ.get("STUB_EXIT", "0"))
if mode == "sleep":
    def on_term(signum, frame):
        rec["got_sigterm"] = True
        json.dump(rec, open(os.environ["STUB_OUT"], "w"))
        os._exit(code)
    signal.signal(signal.SIGTERM, on_term)
    rec["stdin"] = ""
    time.sleep(2.0)
else:
    rec["stdin"] = sys.stdin.buffer.read().decode("latin-1")
json.dump(rec, open(os.environ["STUB_OUT"], "w"))
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

# launch L PKG STDIN_FILE ARGS... -> runs launcher L (node|py) of package PKG with PATH=$SHIM;
# sets RC, and leaves $T/out $T/err $T/rec (the stub's record, absent when the monitor did not run).
launch() {
  local L="$1" pkg="$2" in="$3"; shift 3
  rm -f "$T/rec" "$T/out" "$T/err"
  if [ "$L" = node ]; then
    STUB_OUT="$T/rec" PATH="${LPATH:-$SHIM}" "$NODE" "$T/$pkg/npm/bin/cli.js" "$@" <"$in" >"$T/out" 2>"$T/err"
  else
    STUB_OUT="$T/rec" PATH="${LPATH:-$SHIM}" "$PY" "$T/$pkg/py/run.py" "$@" <"$in" >"$T/out" 2>"$T/err"
  fi
  RC=$?
}

# rec_is ARGS... -> 1 when the stub ran as `-I <stub> --redeem-key ARGS...` and read exactly $T/stdin_expected
rec_is() {
  [ -f "$T/rec" ] || { echo 0; return; }
  "$PY" - "$T/rec" "$T/stdin_expected" "$@" <<'PY'
import json, sys
rec = json.load(open(sys.argv[1]))
want_stdin = open(sys.argv[2], "rb").read().decode("latin-1")
ok = (rec["argv"] == ["--redeem-key"] + sys.argv[3:] and rec["isolated"] == 1
      and rec["script"].endswith("kijito_inbox_monitor.py") and rec["stdin"] == want_stdin)
if not ok:
    sys.stderr.write("record: %r\n" % rec)
print(1 if ok else 0)
PY
}

# What the monitor received, minus its own path (the npm and wheel layouts differ there by design).
rec_norm() {
  [ -f "$T/rec" ] || { echo "NOT RUN"; return; }
  "$PY" -c 'import json,sys; r=json.load(open(sys.argv[1])); r.pop("script"); print(json.dumps(r, sort_keys=True))' "$T/rec"
}

CODE='kpc_7QK3ABCDEFGHJKMNPQRSTVWXYZ012345@api.kijito.ai'
printf '%s\n' "$CODE" > "$T/in_code"
: > "$T/in_empty"

# Every redeem-key case is run through both launchers; the results must match each other as well as the
# expectation. parity_case NAME EXIT STDIN_FILE ARGS...  (EXIT=refuse means: refused, nothing runs)
parity_case() {
  local name="$1" want="$2" in="$3"; shift 3
  local nrc nout nrec prc pout prec
  cp "$in" "$T/stdin_expected"
  for L in node py; do
    launch "$L" stub "$in" redeem-key "$@"
    if [ "$want" = refuse ]; then
      local refused=0
      [ "$RC" = 2 ] && [ ! -f "$T/rec" ] && grep -qx 'REDEEM_REFUSED reason=usage' "$T/out" && refused=1
      check "[$L] $name -> refused, exit 2, monitor not run" "$refused" "rc=$RC out=$(head -c 300 "$T/out") err=$(head -c 300 "$T/err")"
      # A refusal names the option at most, never a value that might be a code or a key.
      if grep -q 'kpc_\|kjt_\|SECRET' "$T/out" "$T/err"; then
        red "[$L] $name -> the refusal echoes an argument value" "$(cat "$T/err")"
      fi
    else
      check "[$L] $name -> exit $want" "$([ "$RC" = "$want" ] && echo 1 || echo 0)" "rc=$RC err=$(head -c 300 "$T/err")"
      check "[$L] $name -> monitor got --redeem-key + exact args, stdin byte-exact, -I" "$(rec_is "$@")"
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
parity_case "a key as a positional after a flag (and it is not echoed)" refuse "$T/in_code" --replace kjt_SECRETSECRETSECRETSECRETSECRETSECRET1234567
parity_case "a code smuggled in an unknown --opt=value (value not echoed)" refuse "$T/in_code" --kind watcher "--code=$CODE"
parity_case "a bare --" refuse "$T/in_code" --kind watcher --
parity_case "short option -k" refuse "$T/in_code" -k watcher
parity_case "--kind twice" refuse "$T/in_code" --kind watcher --kind rest
parity_case "-h and --help together" refuse "$T/in_code" -h --help
parity_case "--redeem-key again" refuse "$T/in_code" --redeem-key --kind watcher
for f in --self-test --print-api-base --check-activity --safe-persona --token-file-template --all-personas --exec --emit; do
  parity_case "watcher option $f" refuse "$T/in_code" --kind watcher "$f" x
done

echo "== near misses never reach the installer =="
cp "$T/in_code" "$T/stdin_expected"
for args in "--redeem-key --kind watcher" "redeem_key --kind watcher" "REDEEM-KEY --kind watcher" \
            "redeem --kind watcher" "--provider claude redeem-key --kind watcher"; do
  for L in node py; do
    # shellcheck disable=SC2086
    launch "$L" stub "$T/in_code" $args
    check "[$L] '$args' -> refused (exit 2), no install" \
      "$([ "$RC" = 2 ] && [ ! -f "$T/rec" ] && grep -qx 'REDEEM_REFUSED reason=usage' "$T/out" && echo 1 || echo 0)" "rc=$RC err=$(cat "$T/err")"
  done
done

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
# A python3 that exists but does not run Python 3.9+ (the Windows Store alias exits 9009; an old python fails
# the version check): skipped for the next candidate, and never handed the monitor.
BADPY="$T/badpy"; mkdir -p "$BADPY"; cp "$SHIM/bash" "$BADPY/bash"
printf '#!/bin/sh\necho "$*" >> "%s"\nexit 9009\n' "$PY3_MARK" > "$BADPY/python3"; chmod +x "$BADPY/python3"
ln -s "$PY" "$BADPY/python"
cp "$T/in_code" "$T/stdin_expected"
LPATH="$BADPY" launch node stub "$T/in_code" redeem-key --kind watcher
check "a broken python3 is skipped and python runs the monitor (exit 0, exact args, stdin)" \
  "$([ "$RC" = 0 ] && [ "$(rec_is --kind watcher)" = 1 ] && echo 1 || echo 0)" "rc=$RC err=$(cat "$T/err")"
check "the broken python3 was only probed (-I -c ...), never given the monitor" \
  "$(grep -q -- '-I -c' "$PY3_MARK" && ! grep -q 'kijito_inbox_monitor' "$PY3_MARK" && echo 1 || echo 0)" "$(cat "$PY3_MARK" 2>/dev/null)"

echo "== node: interpreter order, including Windows (no Windows here, so the functions are called directly) =="
"$NODE" - "$T/stub/npm/bin/cli.js" <<'JS' > "$T/order.out" 2>&1
const m = require(process.argv[2]);
const assert = require('node:assert');
assert.deepStrictEqual(m.pythonCandidates('win32'), [['py', ['-3']], ['python3', []], ['python', []]]);
assert.deepStrictEqual(m.pythonCandidates('linux'), [['python3', []], ['python', []]]);
assert.deepStrictEqual(m.pythonCandidates('darwin'), [['python3', []], ['python', []]]);
const calls = [];
const fake = (cmd, args, opts) => {
  calls.push([cmd, args, opts.stdio]);
  if (cmd === 'py') return { error: Object.assign(new Error('x'), { code: 'ENOENT' }) };
  if (cmd === 'python3') return { status: 9009 };    // the Store alias
  return { status: 0 };
};
assert.deepStrictEqual(m.findPython('win32', fake), ['python', []]);
assert.deepStrictEqual(calls.map((c) => c[0]), ['py', 'python3', 'python']);
assert.deepStrictEqual(calls[0][1].slice(0, 3), ['-3', '-I', '-c']);
assert.ok(calls.every((c) => c[2] === 'ignore'));
assert.deepStrictEqual(m.findPython('win32', (cmd) => (cmd === 'py' ? { status: 0 } : assert.fail('probed past py'))), ['py', ['-3']]);
assert.strictEqual(m.findPython('linux', () => ({ status: 1 })), null);
// Requiring the module runs nothing (no installer, no redeem).
console.log('ORDER_OK');
JS
check "Windows tries py -3, then python3, then python; each probed for 3.9+ without a shell" \
  "$(grep -qx ORDER_OK "$T/order.out" && echo 1 || echo 0)" "$(cat "$T/order.out")"

echo "== the launcher outlives a SIGTERM aimed at it alone; the monitor decides the outcome =="
for L in node py; do
  rm -f "$T/started" "$T/rec"
  if [ "$L" = node ]; then
    STUB_MODE=sleep STUB_EXIT=6 STUB_STARTED="$T/started" STUB_OUT="$T/rec" PATH="$SHIM" \
      "$NODE" "$T/stub/npm/bin/cli.js" redeem-key --kind watcher </dev/null >"$T/out" 2>"$T/err" &
  else
    STUB_MODE=sleep STUB_EXIT=6 STUB_STARTED="$T/started" STUB_OUT="$T/rec" PATH="$SHIM" \
      "$PY" "$T/stub/py/run.py" redeem-key --kind watcher </dev/null >"$T/out" 2>"$T/err" &
  fi
  pid=$!
  for _ in $(seq 1 100); do [ -e "$T/started" ] && break; sleep 0.05; done
  kill -TERM "$pid" 2>/dev/null
  wait "$pid"; RC=$?
  # node: the signal hit the launcher only; it waits and returns the monitor's 6. python on POSIX execs the
  # monitor, so the signal reaches the monitor itself, which (like the real helper) turns it into its exit.
  check "[$L] SIGTERM to the launcher pid -> the monitor's exit 6, not the launcher's 143" "$([ "$RC" = 6 ] && echo 1 || echo 0)" "rc=$RC err=$(cat "$T/err")"
done

echo "== everything else still goes to the installer (unchanged) =="
for L in node py; do
  rm -f "$INSTALL_MARK"
  LPATH="$PATH" launch "$L" stub "$T/in_empty" --provider codex --skills-only
  check "[$L] '--provider codex --skills-only' -> install.sh with those args" \
    "$([ "$RC" = 97 ] && grep -qx 'install.sh --provider codex --skills-only' "$INSTALL_MARK" && echo 1 || echo 0)" "rc=$RC mark=$(cat "$INSTALL_MARK" 2>/dev/null)"
done

rm -f "$INSTALL_MARK"
echo "== the real monitor's argparse accepts what the launchers pass (no network: bad code / --help) =="
REAL="${REDEEM_REAL_MONITOR:-$REPO/providers/monitor/kijito_inbox_monitor.py}"
mkpkgs real "$REAL"
ver=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$REAL" | head -1)
if grep -q -- '"--redeem-key"' "$REAL"; then
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
  done
else
  # Before the 0.6.0 re-vendor: the redeem still never reaches the installer; the monitor says it is too
  # old in the words the reply's "unrecognized arguments: --redeem-key" line matches.
  for L in node py; do
    launch "$L" real "$T/in_code" redeem-key --kind watcher
    check "[$L] vendored monitor $ver has no --redeem-key -> its own 'unrecognized arguments: --redeem-key', exit 2" \
      "$([ "$RC" = 2 ] && grep -q 'unrecognized arguments: --redeem-key' "$T/err" && echo 1 || echo 0)" "rc=$RC err=$(head -c 400 "$T/err")"
  done
  echo "  note  the real-helper argparse leg needs a monitor with --redeem-key: REDEEM_REAL_MONITOR=<path> (0.6.0+)"
fi
check "install.sh and bash never ran on a real-monitor redeem" "$([ ! -e "$INSTALL_MARK" ] && [ ! -e "$BASH_MARK" ] && echo 1 || echo 0)"

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
