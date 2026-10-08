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
const { spawn, spawnSync } = require('node:child_process');
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
// The value shapes the reply renders and the monitor accepts. Checked here so that a misplaced value
// (a pickup code, a key) is refused by the launcher, which never quotes it, rather than by argparse,
// which would. URLs and paths are left to the monitor.
const REDEEM_VALUE_SHAPES = {
  '--kind': [/^(?:watcher|rest)$/, 'watcher or rest'],
  '--expect-account': [/^acct_[0-9a-f]{16}$/, 'acct_ and 16 hex characters'],
  '--replace-prefix': [/^kjt_[A-Za-z0-9_-]{8}$/, 'kjt_ and the 8 characters the reply shows'],
};
// Option names that only redeem-key takes. No installer reads any of them, so an installer run that
// carries one is a mangled redeem command, never an install.
const REDEEM_ONLY_NAMES = new Set(['kind', 'expect-account', 'api-base', 'token-file', 'replace', 'replace-prefix', 'no-verify']);
const MIN_PYTHON = [3, 9]; // kijito-inbox-monitor's requires-python
const PY_CHECK = `import sys; sys.exit(0 if sys.version_info >= (${MIN_PYTHON[0]}, ${MIN_PYTHON[1]}) else 1)`;
// -I (isolated): no PYTHONPATH / PYTHON* variables, no user site-packages, no script directory on
// sys.path. -S: no site module, so no .pth file of whatever environment that python belongs to (an
// activated project venv, say) runs code in the process that holds the key. The monitor is
// stdlib-only and needs neither.
const PY_FLAGS = ['-I', '-S'];

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
      const shape = REDEEM_VALUE_SHAPES[name];
      if (shape && !shape[0].test(value)) return `${name} must be ${shape[1]} (the value is not shown)`;
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

// One argument as a near-miss check sees it: NFKC (fullwidth letters become ASCII), lower case, every
// Unicode dash and minus as '-', and no whitespace at all. The same explicit character lists as cli.py.
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const SPACES = /[\t\n\v\f\r \u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/g;
function normalizeArg(a) {
  return String(a).normalize('NFKC').toLowerCase().replace(DASHES, '-').replace(SPACES, '');
}

// An installer run that is really a mangled redeem command: an argument that mentions redeem or holds a
// pickup code, or an option only redeem-key takes. Refused rather than handed to install.sh, whose
// default provider would run the toolkit install, ignore the arguments and leave the code unread.
function redeemNearMiss(args) {
  return args.some((a) => {
    const n = normalizeArg(a);
    if (n.includes('redeem') || n.includes('kpc_')) return true;
    return n.startsWith('-') && REDEEM_ONLY_NAMES.has(n.split('=', 1)[0].replace(/^-+/, ''));
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

function defaultIsExec(full, platform) {
  try {
    // Windows: existence only (a Store app-execution alias is a reparse point that stat may refuse;
    // the version probe decides whether it runs).
    if (platform === 'win32') return fs.existsSync(full);
    if (!fs.statSync(full).isFile()) return false;
    fs.accessSync(full, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// The absolute path `name` resolves to through the ABSOLUTE entries of PATH only, or null. An empty
// or relative entry would mean the current directory (libuv's own lookup does that on POSIX, and on
// Windows it searches the current directory before PATH), and the current directory is the agent's
// workspace, so a planted python3 there must not handle a key. Windows: <name>.exe only.
function resolveOnPath(name, platform, pathVar, isExec = defaultIsExec) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (let dir of String(pathVar || '').split(platform === 'win32' ? ';' : ':')) {
    if (platform === 'win32') dir = dir.replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir)) continue;
    const full = p.join(dir, file);
    if (isExec(full, platform)) return full;
  }
  return null;
}

// [absolute path, prefix args] of the first candidate that resolves and is Python >= 3.9, or null. The
// exact path probed is the path run. Never through a shell.
function findPython(platform, spawnFn = spawnSync, resolve = (n) => resolveOnPath(n, platform, process.env.PATH)) {
  for (const [name, prefix] of pythonCandidates(platform)) {
    const full = resolve(name);
    if (!full) continue;
    const r = spawnFn(full, [...prefix, ...PY_FLAGS, '-c', PY_CHECK], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return [full, prefix];
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
      ' on PATH); install it, or use the uvx or pipx line from the same reply. Nothing was sent; the code is still live' +
      (process.platform === 'darwin'
        ? '. On macOS, a dialog offering the Command Line Tools came from /usr/bin/python3: installing them provides Python 3.9'
        : ''));
  }
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const handlers = [];
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const [s, h] of handlers) process.removeListener(s, h);
      resolve(code);
    };
    // The monitor owns the outcome of an interrupt: it prints what happened and exits 6, 7, 5 or 8. So
    // this process must neither die before it nor keep a signal from it.
    //  - SIGTERM / SIGHUP aimed at this process alone (npm forwards a TERM to its child only; a harness
    //    may signal just the top pid) are RELAYED to the monitor, as if this process had exec'd it, the
    //    way the PyPI launcher does. A process-group kill can therefore reach the monitor twice; the
    //    monitor ignores every signal after the first.
    //  - SIGINT is swallowed, not relayed: a terminal Ctrl-C already reaches the whole foreground group.
    //  - Windows: nothing is relayed (child.kill there is TerminateProcess, which would skip the
    //    monitor's interrupt path); console Ctrl-C, Ctrl-Break and close reach the monitor directly.
    // None of these handlers is inherited: the child starts with default signal dispositions.
    const win = process.platform === 'win32';
    const relay = win ? [] : ['SIGTERM', 'SIGHUP'];
    const swallow = win ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT'];
    for (const s of swallow) handlers.push([s, () => {}]);
    for (const s of relay) {
      handlers.push([s, () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill(s); } catch (_) { /* the monitor is already gone */ }
        }
      }]);
    }
    for (const [s, h] of handlers) process.on(s, h);
    // stdin is inherited untouched (this process never reads it): the pickup code goes straight to the
    // monitor.
    child = spawn(py[0], [...py[1], ...PY_FLAGS, MONITOR, '--redeem-key', ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (e) => {
      if (child.pid === undefined) {
        finish(refuse('spawn_failed', `could not start ${py[0]} (${e.code || 'error'}). Nothing was sent; ` +
          'the code is still live'));
      }
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        for (const [s, h] of handlers) process.removeListener(s, h);
        // Die the way the monitor died, so the caller sees the status a direct run would give.
        try { process.kill(process.pid, signal); } catch (_) { /* fall through */ }
        const n = os.constants.signals[signal];
        finish(n ? 128 + n : 1);
        return;
      }
      finish(code ?? 1);
    });
  });
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

// A number, or (for redeem-key) a Promise of one.
function main(argv) {
  if (argv[0] === 'redeem-key') return redeemKey(argv.slice(1));
  if (redeemNearMiss(argv)) {
    return refuse('usage', 'that looks like a redeem command. To collect a key, redeem-key must be the FIRST ' +
      "argument, spelled exactly: npx -y 'kijito-tools@>=0.2.17' redeem-key --kind watcher|rest ... (nothing was " +
      'installed)');
  }
  return runInstaller(argv);
}

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
}

module.exports = {
  checkRedeemArgs, redeemNearMiss, normalizeArg, pythonCandidates, resolveOnPath, findPython, PY_FLAGS, MONITOR,
};
