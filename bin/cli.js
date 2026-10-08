#!/usr/bin/env node
'use strict';
// kijito-tools — thin launcher that runs the bundled bash installer (install.sh).
// The package ships the scripts/skills as data; this resolves them relative to the
// package root (never process.cwd()) and shells out to bash. Run with: npx kijito-tools
//
// ONE EXCEPTION, `redeem-key` (row M488): `npx -y 'kijito-tools@>=0.2.17' redeem-key --kind ...`
// collects an API key minted with delivery="pickup". It is intercepted HERE, before the bash probe,
// and runs the vendored kijito-inbox-monitor's `--redeem-key` with Python. It never runs install.sh
// or bash, writes nothing itself and makes no request itself: the monitor does the whole redeem.
// install.sh is a --provider dispatcher whose default provider ignores unknown arguments, so without
// this intercept `redeem-key` would run the whole toolkit install and drop the pickup code on the floor
// (what kijito-tools 0.2.16 does). src/kijito_tools/cli.py is the PyPI twin and must behave the same;
// tests/redeem_key_test.sh runs both side by side.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const installScript = path.join(pkgRoot, 'install.sh');
const MONITOR = path.join(pkgRoot, 'providers', 'monitor', 'kijito_inbox_monitor.py');

// The flags the monitor's --redeem-key reads (its argparse: --kind, --api-base, --token-file, --replace,
// --replace-prefix, --expect-account, --no-verify), plus help. Exact names only: argparse would also
// take an abbreviation such as --tok, which this launcher refuses so that what runs is what was written.
const REDEEM_VALUE_FLAGS = new Set(['--kind', '--expect-account', '--api-base', '--token-file', '--replace-prefix']);
const REDEEM_BOOL_FLAGS = new Set(['--replace', '--no-verify', '--help', '-h']);
const MIN_PYTHON = [3, 9]; // kijito-inbox-monitor's requires-python
const PY_CHECK = `import sys; sys.exit(0 if sys.version_info >= (${MIN_PYTHON[0]}, ${MIN_PYTHON[1]}) else 1)`;

// An option NAME may be quoted back in an error; nothing else from argv ever is (a misplaced pickup
// code or key must not be echoed into a transcript).
function quotableFlag(arg) {
  const name = arg.split('=', 1)[0];
  return /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/.test(name) ? name : null;
}

// null when `args` (everything after `redeem-key`) may be handed to the monitor verbatim, else why not.
// Same rules, same order, same messages as check_redeem_args() in src/kijito_tools/cli.py.
function checkRedeemArgs(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let name = arg;
    let value = null;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    if (REDEEM_VALUE_FLAGS.has(name)) {
      if (value === null) {
        if (i + 1 >= args.length) return `${name} needs a value`;
        value = args[++i];
      }
      // A value never starts with '-' (a kind, an acct_ fingerprint, a kjt_ prefix, a URL, a path), so a
      // dash there means a flag was swallowed as a value; argparse would read it differently.
      if (value === '' || value.startsWith('-')) return `${name} needs a value`;
    } else if (REDEEM_BOOL_FLAGS.has(name)) {
      if (value !== null) return `${name} takes no value`;
      if (name === '-h') name = '--help';
    } else if (!arg.startsWith('-')) {
      return `unexpected argument ${i + 1} (not shown): redeem-key takes no positional argument; the pickup ` +
        'code goes on stdin, never on the command line';
    } else {
      const q = quotableFlag(arg);
      return `${q ? `unknown option ${q}` : `unknown option at argument ${i + 1}`}; redeem-key accepts only ` +
        '--kind, --expect-account, --api-base, --token-file, --replace, --replace-prefix, --no-verify';
    }
    if (seen.has(name)) return `${name} given more than once`;
    seen.add(name);
  }
  return null;
}

// Arguments that look like an attempt to redeem but are not `redeem-key` in first position. They are
// never installer arguments, so they are refused rather than handed to install.sh (whose default
// provider would run the toolkit install and ignore them).
function redeemNearMiss(args) {
  return args.some((a) => {
    const n = String(a).toLowerCase().replace(/^-+/, '').replace(/_/g, '-');
    return n === 'redeem-key' || n === 'redeemkey' || n === 'redeem';
  });
}

// Interpreters to try, in order. Windows: the py launcher first (`py -3`), because `python3` there is
// often the Microsoft Store alias, which opens the Store instead of running anything (the version probe
// rejects it), and `python` may be missing or Python 2. Elsewhere python3, then python.
function pythonCandidates(platform) {
  return platform === 'win32'
    ? [['py', ['-3']], ['python3', []], ['python', []]]
    : [['python3', []], ['python', []]];
}

// The first candidate that actually runs and is Python >= 3.9, or null. Never through a shell.
function findPython(platform, spawn = spawnSync) {
  for (const [cmd, prefix] of pythonCandidates(platform)) {
    const r = spawn(cmd, [...prefix, '-I', '-c', PY_CHECK], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return [cmd, prefix];
  }
  return null;
}

function writeFd(fd, text) {
  try { fs.writeSync(fd, text); } catch (_) { /* nothing more to do */ }
}

// The monitor's own refusal shape: one machine line on stdout, the reason on stderr, exit 2 (refused
// before anything was sent; the pickup code is still live).
function refuse(reason, message) {
  writeFd(1, `REDEEM_REFUSED reason=${reason}\n`);
  writeFd(2, `kijito-tools: REDEEM_REFUSED: ${message}\n`);
  return 2;
}

function redeemKey(args) {
  const why = checkRedeemArgs(args);
  if (why) return refuse('usage', why);
  if (!fs.existsSync(MONITOR)) {
    return refuse('no_helper', 'this kijito-tools package has no providers/monitor/kijito_inbox_monitor.py; ' +
      'reinstall it, or use the uvx or pipx line from the same reply. Nothing was sent; the code is still live');
  }
  const py = findPython(process.platform);
  if (!py) {
    return refuse('no_python', `redeem-key needs Python ${MIN_PYTHON.join('.')} or later (` +
      (process.platform === 'win32' ? 'tried py -3, python3, python' : 'tried python3, python') +
      '); install it, or use the uvx or pipx line from the same reply. Nothing was sent; the code is still live');
  }
  // While the monitor runs, this process must not die first: the monitor owns the outcome of an
  // interrupt (it prints what happened and exits 6, 7, 5 or 8), and a launcher killed ahead of it would
  // hand the caller its own status instead. A terminal Ctrl-C or a process-group kill reaches the
  // monitor directly; these no-op handlers only keep the launcher alive until the monitor returns. The
  // child does not inherit them: it starts with default signal dispositions.
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'].concat(process.platform === 'win32' ? ['SIGBREAK'] : []);
  const noop = () => {};
  for (const s of sigs) process.on(s, noop);
  // -I (isolated): no PYTHONPATH / PYTHON* variables, no user site-packages, no script directory on
  // sys.path. The monitor is stdlib-only, so nothing in a project's environment can shadow a module it
  // imports while it handles a key. stdin is inherited untouched (this process never reads it): the
  // pickup code goes straight to the monitor.
  const r = spawnSync(py[0], [...py[1], '-I', MONITOR, '--redeem-key', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  for (const s of sigs) process.removeListener(s, noop);
  if (r.error) {
    return refuse('spawn_failed', `could not start ${py[0]} (${r.error.code || 'error'}). Nothing was sent; ` +
      'the code is still live');
  }
  if (r.signal) {
    // Die the way the monitor died, so the caller sees the status a direct run would give.
    try { process.kill(process.pid, r.signal); } catch (_) { /* fall through */ }
    const n = os.constants.signals[r.signal];
    return n ? 128 + n : 1;
  }
  return r.status ?? 1;
}

function runInstaller(argv) {
  // install.sh is POSIX bash. Native Windows has no bash; point users at WSL/Git Bash
  // rather than letting them hit a cryptic ENOENT.
  const probe = spawnSync('bash', ['--version'], { stdio: 'ignore' });
  if (probe.error) {
    console.error(
      'kijito-tools needs bash to run its installer.\n' +
      (process.platform === 'win32'
        ? 'On Windows, run it inside WSL (recommended) or Git Bash.\n'
        : 'Install bash and try again.\n') +
      'See https://github.com/KijitoAI/kijito-tools#platform-support'
    );
    return 1;
  }

  const result = spawnSync('bash', [installScript, ...argv], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error('Failed to launch the installer:', result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function main(argv) {
  if (argv[0] === 'redeem-key') return redeemKey(argv.slice(1));
  if (redeemNearMiss(argv)) {
    return refuse('usage', 'to collect a key, redeem-key must be the FIRST argument, spelled exactly: ' +
      "npx -y 'kijito-tools@>=0.2.17' redeem-key --kind watcher|rest ... (nothing was installed)");
  }
  return runInstaller(argv);
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { checkRedeemArgs, redeemNearMiss, pythonCandidates, findPython, MONITOR };
