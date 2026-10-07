#!/usr/bin/env python3
"""Every place this repo tells someone to keep a Kijito key is a place `--redeem-key` looks (row M488, plan §5.2).

WHY THIS EXISTS. Before it saves a new key, `kijito-inbox-monitor --redeem-key` sends the SHA-256 of every key
already on the machine, so the server can refuse a pickup code of a different account (defence in depth: a miss
is not a hole, but every location it misses weakens the check silently). It learns where keys live from exactly
three things: the KEY_LOCATIONS globs, the list of MCP client configs it regex-scans, and the environment (any
variable whose whole value is key-shaped, whatever its name). The scan has missed a documented location twice
before. So this test reads the repo's docs, scripts, templates and test fixtures - the vendored monitor included -
and fails when one of them documents a key location the helper would not look at:

  (i)   key-file paths (~/.config/kijito*/..., $HOME/..., ~/.claude/.kijito_api_token*, any key-named file under a
        home directory; {persona} / $PERSONA / <...> / %i normalised to *) must match a KEY_LOCATIONS glob, or an
        entry of the NON-KEY allowlist below (each with its reason);
  (ii)  environment variable names KIJITO*_*TOKEN / KIJITO*_*KEY must be covered by the environment rule (which
        is name-agnostic, so this pins that it STAYS name-agnostic); names ending _FILE hold a path, and each must
        be in PATH_VARS with a default that (i) covers;
  (iii) header and env forms that store a key in a client config must map to a row of HEADER_FORMS, and every
        row's file must be in the config-scan list. A form that is only a request header built at run time from a
        key file (curl -H, the monitor's own header) is listed in RUNTIME_FORMS, with its reason.

The lists below are a PINNED COPY of the helper. When the vendored monitor carries --redeem-key, the copy must
equal it (checked from its source, never imported); until then the check reports that it is pending.

  python3 tests/key_locations_coverage.py [--root DIR] [--monitor FILE] [--mutant NAME] [--no-min]

Exit 0 = every documented location is covered; 1 = at least one FAIL line (each names file:line and the fix).
"""
import argparse
import ast
import os
import re
import sys

# ── THE PINNED COPY ────────────────────────────────────────────────────────────────────────────────────────────
# Mirrors kijito-inbox-monitor main 4b2b7c8 (M488 P2a, to be released as 0.6.0): KEY_LOCATIONS, MCP_CONFIGS_HOME,
# MCP_CONFIGS_CWD and _KEY_WHOLE in kijito_inbox_monitor.py. Change these only together with the helper.
PINNED_FROM = "kijito-inbox-monitor main 4b2b7c8 (0.6.0)"
KEY_LOCATIONS = (
    ".config/kijito-inbox-monitor/token",
    ".config/kijito/api_token",
    ".config/kijito-inbox-monitor/token.*",
    ".config/kijito/api_token*",
    ".claude/.kijito_api_token",
    ".claude/.kijito_api_token.*",
)
MCP_CONFIGS_HOME = (".claude.json", ".claude/settings.json", ".codex/config.toml",
                    ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc")
MCP_CONFIGS_CWD = (".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml")
# The environment rule: every variable of the helper's own process whose whole value (stripped) matches this,
# whatever its name. ENV_NAMES = None is that "whatever its name"; a tuple would be a name filter.
ENV_VALUE_RE = r"kjt_[A-Za-z0-9_-]{43}"
ENV_NAMES = None

# ── (i) NON-KEY files under the scanned directories, each with the reason it holds no key ──────────────────────
NON_KEY = (
    (".config/kijito-inbox-monitor/api_base", "a base URL the human writes for a non-default server (plan §3.3 "
     "step 1); no secret"),
    ("**/*.state", "monitor state (cursor, seen ids); no secret"),
    ("**/events.*.ndjson", "the monitor's event stream; message metadata, no secret"),
    (".config/kijito-inbox-monitor/*.lock", "lock files; empty or a pid"),
)
# Key files the helper deliberately does NOT read, with the reason (plan §3.3 step 4).
UNSCANNED_BY_DESIGN = (
    (".config/kijito-inbox-monitor/.*.tmp", "the helper's own install temp (a dot-file no KEY_LOCATIONS pattern "
     "matches); it holds a key only after KEY_PARKED, which prints its path"),
    (".config/kijito/.*.tmp", "the same temp, for the REST key file"),
)
# Directories named on their own (a mkdir, a "lives in" sentence): a directory is not a key file.
KEY_DIRS = (".config/kijito-inbox-monitor", ".config/kijito", ".claude")
# Key-named strings that are not a path anyone keeps a key at, by file, with the reason.
NOT_A_LOCATION = (
    ("tests/inbox_selftest_test.sh", "$H/.claude_token",
     "a fixture key handed to the self-test through KIJITOMON_TOKEN_FILE in a throwaway HOME"),
    # The vendored monitor's --redeem-key tests (from 0.6.0): --token-file targets they assert are REFUSED.
    ("providers/monitor/test_kijito_monitor.py", "./token", "a --token-file target the tests assert is refused"),
    ("providers/monitor/test_kijito_monitor.py", "~/token", "a --token-file target the tests assert is refused"),
)

# ── (ii) variables that hold a PATH to a key, with the default path they fall back to ──────────────────────────
PATH_VARS = {
    "KIJITO_API_TOKEN_FILE": (".claude/.kijito_api_token", "claude-armed.sh reads the key from it"),
    "KIJITOMON_TOKEN_FILE": (".config/kijito-inbox-monitor/token", "the monitor's key file; with it unset the "
                             "start script and the self-test try the legacy Claude files, then this one"),
}

# ── (iii) THE HEADER-FORM -> CONFIG-FILE TABLE ─────────────────────────────────────────────────────────────────
# Each row: (name, regex on the line, regex on the line with the four before it and the one after - or None -,
# files). "~/x" is under the home directory (must be in MCP_CONFIGS_HOME), "./x" under the working directory (must
# be in MCP_CONFIGS_CWD). The first row that matches a line claims it, so the specific rows come first.
HEADER_FORMS = (
    ("claude mcp add --header", r"\bclaude\s+mcp\s+add\b.*(?:--header|\s-H)\b", None, ("~/.claude.json",)),
    ("Claude Code \"env\" block", r"""["']env["']\s*:\s*\{|`env`\s+block""", None,
     ("~/.claude/settings.json", "./.claude/settings.json", "./.claude/settings.local.json")),
    ("Codex http_headers / env_http_headers", r"\b(?:env_)?http_headers\b|\bbearer_token_env_var\b", None,
     ("~/.codex/config.toml", "./.codex/config.toml")),
    ("OpenCode \"headers\"", r"""["']headers["']\s*:|Authorization""", r"(?i)opencode",
     ("~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc")),
    ("MCP server \"headers\" (.mcp.json, ~/.claude.json)", r"""["']headers["']\s*:|Authorization""",
     r"""["']headers["']\s*:|`headers`|\.mcp\.json""", ("./.mcp.json", "~/.claude.json")),
)
# Forms that put a key in a request at run time and store it nowhere; the key comes from a file or variable that
# (i) and (ii) already cover.
RUNTIME_FORMS = (
    (r"""\bcurl\b.*-H\s+["']Authorization:\s*Bearer\s+\$""", "a request header a script builds from a key file it "
     "read"),
    (r"""\bheaders\s*\[\s*["']Authorization["']\s*\]\s*=""", "the monitor sets its own request header"),
    (r"""["']Authorization["']\s*:\s*["']Bearer ["']\s*\+""", "a request header built in code from a key held in "
     "memory (the helper's verify call)"),
    (r"""headers\s*:\s*\{\s*Authorization\s*:\s*`Bearer \$\{""", "the notify shim's request header, from --token-file"),
    (r"""\w\[\s*["']Authorization["']\s*\]|headers\.get\(\s*["']Authorization["']|assertNotIn\(\s*["']Authorization""",
     "a test of the monitor's outgoing request header"),
    (r"--auth-header|default `?Authorization: Bearer|injected as `Authorization: Bearer",
     "the monitor's own request header; the key comes from --token-file or $KIJITOMON_TOKEN"),
)
# What counts as evidence of a header or env form at all. Anything matching one of these must be claimed by a
# HEADER_FORMS row or a RUNTIME_FORMS entry.
EVIDENCE = re.compile(r"""Authorization["'`]?\s*[:=]\s*["'`]?\s*Bearer|["']Authorization["']|"""
                      r"""\b(?:env_)?http_headers\b|\bbearer_token_env_var\b|--header\b|"""
                      r"""["']env["']\s*:\s*\{|`env`\s+block|["']headers["']\s*:""")

# ── the scan ───────────────────────────────────────────────────────────────────────────────────────────────────
SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist", "build", ".venv", ".lifecycle",   # .gitignore'd
             "legacy"}   # legacy/: retired code kept for history, never shipped or installed
SELF = {"tests/key_locations_coverage.py", "tests/key_locations_coverage_test.sh"}   # they plant violations
ENV_NAME_RE = re.compile(r"\bKIJITO[A-Z]*_[A-Z0-9_]*?(?:TOKEN|KEY)(?:_FILE)?\b")
KEYISH = re.compile(r"(?i)token|api[_-]?key|secret|credential")
PATH_CHARS = re.compile(r"[A-Za-z0-9_.~$%{}()@*+/:-]+")
PLACEHOLDER_ANGLE = re.compile(r"<[A-Za-z0-9_ .-]*>")
HOME_ANCHOR = re.compile(r"(?:~|\$\{HOME\}|\$HOME|%h|__HOME__|/(?:Users|home)/[A-Za-z0-9._-]+|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/")


def glob_match(path, pattern):
    """fnmatch with glob's rule that * does not cross /; ** crosses."""
    rx = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            rx += "(?:.*/)?"
            i += 3
        elif pattern[i] == "*":
            rx += "[^/]*"
            i += 1
        else:
            rx += re.escape(pattern[i])
            i += 1
    return re.fullmatch(rx, path) is not None


def normalise(rel):
    rel = re.sub(r"\$\([^/]*$", "*", rel)                 # $(kijito-inbox-monitor --safe-persona X) to the end
    rel = re.sub(r"\$\{[^}/]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\{[^}/]*\}|%[iI]", "*", rel)
    rel = re.sub(r"YOUR_?PERSONA", "*", rel)
    while True:
        new = rel.rstrip(".,:;")
        if new.endswith(")") and new.count("(") < new.count(")"):
            new = new[:-1]
        if new.endswith("}") and new.count("{") < new.count("}"):
            new = new[:-1]
        if new == rel:
            break
        rel = new
    return re.sub(r"\*+", "*", rel)


def home_relative(token):
    """The part of a path token below a home directory, or None. A real home ($HOME, ~, %h, /Users/x), a test's
    fake home ($H/, $T/home/) and `HOME + "/.config/...` all count."""
    last = None
    for m in HOME_ANCHOR.finditer(token):
        last = m
    if last is not None:
        return token[last.end():]
    for lead in ("/.config/", "/.claude/"):
        if token.startswith(lead):
            return token[1:]
    if token.startswith((".config/", ".claude/")):      # the helper's own home-relative spelling
        return token
    return None


class Scan:
    def __init__(self, root, key_locations, cfg_home, cfg_cwd, env_names, non_key=NON_KEY):
        self.root, self.non_key = root, non_key
        self.key_locations, self.cfg_home, self.cfg_cwd, self.env_names = key_locations, cfg_home, cfg_cwd, env_names
        self.fails, self.paths, self.envs, self.forms = [], [], [], []

    def fail(self, where, msg):
        self.fails.append("%s: %s" % (where, msg))

    def files(self):
        for d, dirs, names in os.walk(self.root):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.endswith(".egg-info"))
            for n in sorted(names):
                p = os.path.join(d, n)
                rel = os.path.relpath(p, self.root).replace(os.sep, "/")
                if rel in SELF or n.endswith((".tgz", ".whl", ".pyc")):
                    continue
                try:
                    with open(p, encoding="utf-8") as fh:
                        yield rel, fh.read().splitlines()
                except (UnicodeDecodeError, OSError):
                    continue

    def run(self):
        for rel, lines in self.files():
            for i, line in enumerate(lines):
                where = "%s:%d" % (rel, i + 1)
                self.check_paths(rel, where, line)
                self.check_envs(where, line)
                self.check_forms(where, line, lines, i)
        self.check_table()
        return self

    # (i)
    def check_paths(self, rel, where, line):
        for tok in PATH_CHARS.findall(PLACEHOLDER_ANGLE.sub("*", line)):
            if "/" not in tok:
                continue
            sub = home_relative(tok)
            if sub is None:
                # Not under a home directory. Only an absolute or ./-relative path is a place to keep a file (a
                # bare a/b fragment, a //host URL or a sed expression of --flags is not).
                if not re.match(r"/[^/]|\.\.?/", tok) or "--" in tok:
                    continue
                last = normalise(tok).rstrip("/").rsplit("/", 1)[-1]
                if KEYISH.search(last) and not any(f == rel and s == tok for f, s, _ in NOT_A_LOCATION):
                    self.fail(where, "%r names a key file outside any home directory, so --redeem-key cannot find "
                                     "it. Point it at %s instead, or add it to NOT_A_LOCATION with the reason it "
                                     "is not a key location" % (tok, "~/" + KEY_LOCATIONS[0]))
                continue
            path = normalise(sub)
            if not (path.startswith(".config/kijito") or path.startswith(".claude/.kijito")
                    or KEYISH.search(path.rsplit("/", 1)[-1])):
                continue
            if path.endswith("/") or path.rstrip("/") in KEY_DIRS:
                continue
            if any(f == rel and s == tok for f, s, _ in NOT_A_LOCATION):
                continue
            self.paths.append((where, path))
            if any(glob_match(path, p) for p in self.key_locations):
                continue
            if any(glob_match(path, p) for p, _ in self.non_key):
                continue
            if any(glob_match(path, p) for p, _ in UNSCANNED_BY_DESIGN):
                continue
            self.fail(where, "~/%s is documented here but no KEY_LOCATIONS pattern covers it, so --redeem-key "
                             "would never hash a key kept there. Add a pattern in kijito-inbox-monitor (and to the "
                             "pinned copy in this test), or add it to NON_KEY with the reason it holds no key"
                      % path)

    # (ii)
    def check_envs(self, where, line):
        for name in ENV_NAME_RE.findall(line):
            self.envs.append((where, name))
            if name.endswith("_FILE"):
                if name not in PATH_VARS:
                    self.fail(where, "$%s holds the path of a key file but is not in PATH_VARS; add it with the "
                                     "default path it falls back to" % name)
                continue
            if self.env_names is not None and name not in self.env_names:
                self.fail(where, "$%s is documented as holding a key, but the helper's environment rule only "
                                 "reads %s; the rule must stay name-agnostic" % (name, ", ".join(self.env_names)))

    # (iii)
    def check_forms(self, where, line, lines, i):
        if not EVIDENCE.search(line):
            return
        context = "\n".join(lines[max(0, i - 4):i + 2])
        for name, line_rx, ctx_rx, files in HEADER_FORMS:
            if re.search(line_rx, line) and (ctx_rx is None or re.search(ctx_rx, context)):
                self.forms.append((where, name))
                return
        for rx, _ in RUNTIME_FORMS:
            if re.search(rx, line):
                return
        self.fail(where, "a header or env form that matches no HEADER_FORMS row: %r. Add a row naming the client "
                         "config file it lives in (and make sure the helper scans that file), or a RUNTIME_FORMS "
                         "entry if it stores the key nowhere" % line.strip()[:160])

    def check_table(self):
        for name, _, _, files in HEADER_FORMS:
            for f in files:
                scope, rel = ("home", f[2:]) if f.startswith("~/") else ("cwd", f[2:])
                listed = self.cfg_home if scope == "home" else self.cfg_cwd
                if rel not in listed:
                    self.fail("HEADER_FORMS[%s]" % name, "%s is not in the helper's %s config-scan list, so a key "
                              "stored in that form is never hashed" % (f, "home" if scope == "home" else
                                                                    "working-directory"))
        for name, (default, _) in PATH_VARS.items():
            if not any(glob_match(default, p) for p in self.key_locations):
                self.fail("PATH_VARS[%s]" % name, "its default ~/%s is not covered by KEY_LOCATIONS" % default)


# ── the vendored monitor, read as source ───────────────────────────────────────────────────────────────────────
def check_monitor(path):
    """Returns (status, messages). status: 'match', 'pending' (no --redeem-key yet) or 'differs'."""
    try:
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
    except OSError as e:
        return "differs", ["cannot read %s: %s" % (path, e)]
    tree = ast.parse(src)
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in ("KEY_LOCATIONS", "MCP_CONFIGS_HOME", "MCP_CONFIGS_CWD"):
                found[name] = ast.literal_eval(node.value)
            elif name == "_KEY_WHOLE" and isinstance(node.value, ast.Call) and node.value.args:
                found[name] = ast.literal_eval(node.value.args[0])
    if not found:
        if "--redeem-key" in src:
            return "differs", ["%s has --redeem-key but no KEY_LOCATIONS this test can read; update the test"
                               % path]
        return "pending", []
    want = {"KEY_LOCATIONS": KEY_LOCATIONS, "MCP_CONFIGS_HOME": MCP_CONFIGS_HOME,
            "MCP_CONFIGS_CWD": MCP_CONFIGS_CWD, "_KEY_WHOLE": ENV_VALUE_RE}
    msgs = ["%s in %s is %r; the pinned copy here is %r" % (k, path, found.get(k), v)
            for k, v in want.items() if found.get(k) != v]
    # The environment loop must not look at the variable's name (beyond labelling the source).
    env_loops = [n for n in ast.walk(tree) if isinstance(n, ast.For) and "environ" in ast.dump(n.iter)
                 and isinstance(n.target, ast.Name) and "_KEY_WHOLE" in ast.dump(n)]
    if not env_loops:
        msgs.append("no environment loop using _KEY_WHOLE found in %s" % path)
    for loop in env_loops:
        var = loop.target.id
        for n in ast.walk(loop):
            if isinstance(n, ast.If) and any(isinstance(x, ast.Name) and x.id == var for x in ast.walk(n.test)):
                msgs.append("the environment loop in %s tests the variable NAME (line %d); the rule must stay "
                            "name-agnostic" % (path, n.lineno))
    return ("differs" if msgs else "match"), msgs


MUTANTS = {
    # Each one must turn a scan red - the real repo, or for drop-non-key the allowlist control fixture;
    # tests/key_locations_coverage_test.sh asserts that it does.
    "drop-persona-glob": "KEY_LOCATIONS without .config/kijito-inbox-monitor/token.*",
    "drop-legacy-glob": "KEY_LOCATIONS without .claude/.kijito_api_token.*",
    "env-name-filter": "an environment rule that reads KIJITO_API_TOKEN only",
    "drop-codex-config": "a config-scan list without .codex/config.toml",
    "drop-settings-local": "a working-directory config list without .claude/settings.local.json",
    "drop-non-key": "an empty NON_KEY allowlist (proves the allowlist is what passes api_base, state and lock files)",
}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--root", default=here)
    ap.add_argument("--monitor", default=None, help="monitor source to compare (default: the vendored copy)")
    ap.add_argument("--mutant", choices=sorted(MUTANTS))
    ap.add_argument("--no-min", action="store_true", help="fixture runs: do not require evidence of each kind")
    a = ap.parse_args(argv)
    kl, ch, cc, en = KEY_LOCATIONS, MCP_CONFIGS_HOME, MCP_CONFIGS_CWD, ENV_NAMES
    if a.mutant == "drop-persona-glob":
        kl = tuple(p for p in kl if p != ".config/kijito-inbox-monitor/token.*")
    elif a.mutant == "drop-legacy-glob":
        kl = tuple(p for p in kl if p != ".claude/.kijito_api_token.*")
    elif a.mutant == "env-name-filter":
        en = ("KIJITO_API_TOKEN",)
    elif a.mutant == "drop-codex-config":
        ch = tuple(p for p in ch if p != ".codex/config.toml")
        cc = tuple(p for p in cc if p != ".codex/config.toml")
    elif a.mutant == "drop-settings-local":
        cc = tuple(p for p in cc if p != ".claude/settings.local.json")
    nk = () if a.mutant == "drop-non-key" else NON_KEY

    s = Scan(a.root, kl, ch, cc, en, nk).run()
    if not a.no_min:
        # Non-vacuity: a scanner that finds nothing passes forever.
        for what, got in (("key-file paths", s.paths), ("key variable names", s.envs), ("header forms", s.forms)):
            if not got:
                s.fail("scan", "found no %s at all in %s; the scanner is not reading the repo" % (what, a.root))
    monitor = a.monitor or os.path.join(a.root, "providers/monitor/kijito_inbox_monitor.py")
    status = None
    if os.path.exists(monitor) or a.monitor:
        status, msgs = check_monitor(monitor)
        for m in msgs:
            s.fail("pinned copy", m)
    for f in s.fails:
        print("  FAIL  " + f)
    print("  scanned: %d key-file path mentions, %d variable names, %d header/env forms; pinned copy of %s vs %s: %s"
          % (len(s.paths), len(s.envs), len(s.forms), PINNED_FROM, os.path.relpath(monitor, a.root)
             if not a.monitor else monitor, status or "no monitor"))
    hit = {}
    for _, name in s.forms:
        hit[name] = hit.get(name, 0) + 1
    print("  header-form rows hit: " + "; ".join("%s=%d" % (name, hit.get(name, 0)) for name, _, _, _ in HEADER_FORMS))
    if status == "pending":
        print("  NOTE  the vendored monitor predates --redeem-key, so the pinned copy is not compared yet; it is "
              "once the monitor is re-vendored")
    return 1 if s.fails else 0


if __name__ == "__main__":
    sys.exit(main())
