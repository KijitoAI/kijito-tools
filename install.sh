#!/usr/bin/env bash
# kijito-tools — provider dispatcher.
#
# This repo installs the Kijito session toolkit for more than one agent host. Each host is a
# PROVIDER under providers/, owns its own installer, and installs to its own location:
#
#   claude  (default)  providers/claude/install.sh    → ~/.claude          — bash scripts + skills
#   codex              providers/codex/install.mjs    → release verify (default) / --skills-only
#
#   ./install.sh                      # claude, unchanged from before the providers/ split
#   ./install.sh --provider codex     # verify the codex release gate; add --skills-only to deploy
#   ./install.sh --list-providers
#   ./install.sh --from-main          # fetch origin/main and install exactly that tree
#   ./install.sh --allow-branch       # deliberately install THIS branch's bytes (off-main opt-in)
#
# ⚠️ THE DEFAULT IS LOAD-BEARING AND MUST STAY `claude`. `npx kijito-tools` and
# `pipx run kijito-tools` both land here with no arguments, and they have been installing the
# Claude toolkit since 0.1.0. Changing the default would silently retarget every existing user.
#
# ⚠️ ROLLOUT SAFETY — WHY --from-main EXISTS (two independent wrongs):
#   (1) the installer COPIES files into ~/.claude — a deployed hook/skill is a COPY, not a symlink,
#       so it NEVER tracks the repo after install; and
#   (2) the install reads the CURRENT WORKING TREE, whose bytes follow whatever branch is checked
#       out — so a machine that runs a bare `./install.sh` while this SHARED checkout sits on
#       someone's feature branch silently bakes that branch's in-progress bytes into its hooks.
#   Either wrong alone is survivable; together they let a machine converge on stale/unreleased bytes
#   with no error (only reading the installed CONTENT catches it). So main is the documented
#   path (--from-main: fetch origin/main and install exactly that commit's tree, extracted with
#   `git archive` into a temp dir, so the caller's branch and working tree are untouched), and
#   installing from any OTHER branch is made OPT-IN (--allow-branch) — a mere warning still installs
#   the wrong bytes for anyone who does not read it, so the unsafe path must be opt-in, not opt-out.
#   (A non-git checkout — npm/pipx packaged release — has no branch to be wrong about, so it is
#   exempt: the bytes ARE the release.)
#
# ⛔ --from-main MEANS ORIGIN'S MAIN, NEVER THE LOCAL `main` REF. A local `main` is only as new as
#   the last time someone fast-forwarded it, and it cannot be fast-forwarded at all while it is checked
#   out in another worktree. Measured 2026-11-05: local main sat at 0.2.17 while origin/main was 0.2.23,
#   and --from-main silently DOWNGRADED ~/.claude by six releases (the second time; the first was
#   2026-09-11). So --from-main fetches origin/main first and installs that commit's tree; if the fetch
#   fails it REFUSES, because "install whatever main we last saw" is exactly the stale install it exists
#   to prevent.
#
# Unrecognized arguments are passed through to the provider's own installer untouched, so a
# provider can add flags without this file needing to know about them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PROVIDERS_DIR="$ROOT/providers"

list_providers() {
  # _shared holds provider-neutral code, not a provider. Anything else with an installer counts.
  for d in "$PROVIDERS_DIR"/*/; do
    name="$(basename "$d")"
    [ "$name" = "_shared" ] && continue
    if [ -f "$d/install.sh" ] || [ -f "$d/install.mjs" ]; then echo "$name"; fi
  done
}

usage() {
  echo "usage: install.sh [--provider <name>] [--from-main | --allow-branch] [provider args...]"
  echo
  echo "providers:"
  list_providers | sed 's/^/  /'
  echo
  echo "default provider: claude"
  echo "  claude provider args:  --persona <name>   name this folder's persona (writes .kijito_persona)"
  echo
  echo "rollout safety (git checkouts only):"
  echo "  --from-main       fetch origin/main and install exactly its tree (recommended)"
  echo "  --allow-branch    deliberately install the current (off-main) branch's bytes"
}

# ROLLOUT SAFETY (see the header). git checkouts only; a packaged (non-git) install is exempt.
# branch_guard refuses a bare install from an off-main checkout; from_main_install fetches origin/main
# and installs that commit's tree. Neither applies outside a git checkout.
_on_main_commit() {
  # True iff HEAD sits at main's COMMIT (so a detached HEAD at main counts, not just the branch name).
  local head_sha main_sha
  head_sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  main_sha="$(git -C "$ROOT" rev-parse main 2>/dev/null || true)"
  [ -n "$head_sha" ] && [ "$head_sha" = "$main_sha" ]
}

branch_guard() {
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0   # not a git checkout → exempt
  _on_main_commit && return 0                                       # already main → nothing to guard
  local cur
  cur="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(unknown)')"
  if [ "$ALLOW_BRANCH" -eq 1 ]; then
    echo "kijito-tools: installing from '$cur' (off main) — --allow-branch given, proceeding." >&2
    return 0
  fi
  cat >&2 <<EOF
ERROR: kijito-tools is checked out on '$cur', not main.
The installer COPIES the current working tree into ~/.claude, so a bare install here would bake
'$cur' bytes into your hooks and skills — and they will NOT update afterward. Choose one:
  ./install.sh --from-main       # fetch origin/main and install exactly that (recommended)
  ./install.sh --allow-branch    # deliberately install THIS branch's bytes
EOF
  exit 3
}

from_main_install() {
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || {
    echo "ERROR: --from-main needs a git checkout of kijito-tools (this is a packaged install)." >&2
    exit 3; }
  # Fetch into the remote-tracking ref explicitly, so the ref we read below is the one we just fetched
  # whatever fetch refspec this clone happens to have configured.
  if ! git -C "$ROOT" fetch --quiet "$MAIN_REMOTE" "+refs/heads/main:refs/remotes/$MAIN_REMOTE/main" 2>/dev/null; then
    cat >&2 <<EOF
ERROR: --from-main could not fetch '$MAIN_REMOTE/main' in $ROOT, so it cannot know what main is now.
Nothing was installed: installing the last-seen main could silently downgrade ~/.claude.
Fix the network or the '$MAIN_REMOTE' remote and run it again (or, deliberately, ./install.sh --allow-branch).
EOF
    exit 3
  fi
  local main_sha
  main_sha="$(git -C "$ROOT" rev-parse --verify --quiet "refs/remotes/$MAIN_REMOTE/main^{commit}" || true)"
  [ -n "$main_sha" ] || { echo "ERROR: --from-main: '$MAIN_REMOTE/main' did not resolve after the fetch. Nothing was installed." >&2; exit 3; }
  # ⛔ ALWAYS FROM THE FETCHED COMMIT, EVEN WHEN HEAD IS ALREADY THERE: the working tree may hold
  # uncommitted edits, and --from-main promises origin/main's bytes, not this checkout's.
  # `git archive` gives exactly that commit's tree in a plain directory: no worktree to register or
  # remove, the caller's checkout is untouched, and the copy has no .git, so the installer re-invoked
  # from it treats it as a release (no branch guard, and no way to recurse back here).
  local tree
  tree="$(mktemp -d "${TMPDIR:-/tmp}/kjt-from-main.XXXXXX")"
  if ! git -C "$ROOT" archive --format=tar "$main_sha" | tar -xf - -C "$tree"; then
    echo "ERROR: --from-main: could not extract $MAIN_REMOTE/main ($main_sha). Nothing was installed." >&2
    rm -rf "$tree"; exit 3
  fi
  echo "kijito-tools: installing $MAIN_REMOTE/main @ ${main_sha:0:12} (fetched just now)." >&2
  local rc=0
  # Run from the caller's directory (the provider writes --persona's marker into $PWD). Do NOT pass
  # --from-main again. Preserve provider + any passthrough args. The ceiling stops git in the child
  # from discovering an ENCLOSING repository (a TMPDIR inside some checkout), which would make the
  # extract look like a git checkout and put it back under the branch guard.
  GIT_CEILING_DIRECTORIES="$(dirname "$tree")" \
    bash "$tree/install.sh" --provider "$PROVIDER" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} || rc=$?
  rm -rf "$tree"    # our own throwaway extract of a commit that is still in git; nothing else lives there
  exit "$rc"
}

PROVIDER="claude"
FROM_MAIN=0
# The remote whose main --from-main installs. `origin` in every normal clone; overridable for a clone
# whose upstream is named differently.
MAIN_REMOTE="${KIJITO_TOOLS_MAIN_REMOTE:-origin}"
ALLOW_BRANCH=0
# bash 3.2 (the macOS default) errors on "${arr[@]}" when arr is empty under `set -u`, so this
# array is always expanded through the ${arr[@]+...} guard below.
PASSTHROUGH=()
while [ $# -gt 0 ]; do
  case "$1" in
    --provider)
      [ $# -ge 2 ] || { echo "ERROR: --provider needs a value" >&2; exit 2; }
      PROVIDER="$2"; shift 2 ;;
    --provider=*) PROVIDER="${1#*=}"; shift ;;
    --from-main) FROM_MAIN=1; shift ;;
    --allow-branch) ALLOW_BRANCH=1; shift ;;
    --list-providers) list_providers; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

PROVIDER_DIR="$PROVIDERS_DIR/$PROVIDER"
if [ "$PROVIDER" = "_shared" ] || [ ! -d "$PROVIDER_DIR" ]; then
  echo "ERROR: unknown provider '$PROVIDER'. Known providers:" >&2
  list_providers | sed 's/^/  /' >&2
  exit 2
fi

# ROLLOUT SAFETY gate — runs after provider validation, before any install.
# --from-main fetches and installs origin/main's tree (and exits, never falling through to the
# working tree); otherwise branch_guard refuses a silent off-main install unless --allow-branch opts in.
if [ "$FROM_MAIN" -eq 1 ]; then
  from_main_install
fi
branch_guard

if [ -f "$PROVIDER_DIR/install.sh" ]; then
  exec bash "$PROVIDER_DIR/install.sh" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
elif [ -f "$PROVIDER_DIR/install.mjs" ]; then
  command -v node >/dev/null 2>&1 || {
    echo "ERROR: provider '$PROVIDER' needs Node.js 20+ on PATH." >&2; exit 1; }
  exec node "$PROVIDER_DIR/install.mjs" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
else
  echo "ERROR: provider '$PROVIDER' has no install.sh or install.mjs." >&2
  exit 2
fi
