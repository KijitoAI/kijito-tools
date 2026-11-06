#!/usr/bin/env bash
# ROLLOUT SAFETY: does install.sh install the bytes you MEANT to, not whatever branch is checked out?
#
# WHY THIS EXISTS. The installer COPIES the working tree into ~/.claude (a deployed hook is a copy,
# not a symlink) AND reads whatever branch the SHARED checkout has checked out. Together those two
# facts let a machine running a bare `./install.sh` bake a feature branch's in-progress bytes into
# its hooks with no error — or install STALE bytes because the shared checkout sits on a branch
# predating a fix on main, which only reading the installed CONTENT catches. The remedy is: refuse a silent off-main install (require --allow-branch to opt
# in), and offer --from-main to install the stable main bytes branch-state-immune.
#
# ⛔ AND "MAIN" MEANS ORIGIN'S MAIN. A local `main` ref is only as new as its last fast-forward,
# and cannot be fast-forwarded while it is checked out in another worktree. Measured 2026-11-05: local
# main at 0.2.17, origin/main at 0.2.23, and --from-main silently downgraded ~/.claude. So --from-main
# must fetch and install origin/main's tree, and REFUSE when the fetch fails (scenarios C2-C4).
#
# ⚠️ WHY A UNIT TEST OF THE GUARD LOGIC WOULD NOT BE ENOUGH: the property is about which BYTES land,
# across a real git checkout + worktree. So this drives the REAL install.sh end to end against
# throwaway git repos, using a STUB provider that records the marker it saw (never touching ~/.claude
# or invoking the real claude installer).
#
#   bash tests/install_rollout_test.sh              # run the checks
#   bash tests/install_rollout_test.sh --mutation   # ALSO prove the checks can fail (neuter the guard)
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MUTATION=0
[ "${1:-}" = "--mutation" ] && MUTATION=1

pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/kjt-rollout.XXXXXX")"
cleanup() { chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# Build a throwaway git repo that contains the REAL install.sh + a stub provider. main carries
# marker "MAIN"; a feature branch carries "FEATURE". $1 = install.sh to embed (real or mutated).
make_repo() {  # $1 = installer path, $2 = dest dir
  local inst="$1" dir="$2"
  mkdir -p "$dir/providers/testprov"
  cp "$inst" "$dir/install.sh"
  cat > "$dir/providers/testprov/install.sh" <<'PROV'
#!/usr/bin/env bash
# STUB provider: record the marker from the working tree this install ran against.
set -eu
out="${KJT_TEST_OUT:?KJT_TEST_OUT unset}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cat "$root/VERSION_MARKER" > "$out"
PROV
  printf 'MAIN\n' > "$dir/VERSION_MARKER"
  ( cd "$dir"
    git init -q
    git config user.email t@t; git config user.name t
    git symbolic-ref HEAD refs/heads/main
    git add -A; git commit -qm main
    git checkout -q -b feature
    printf 'FEATURE\n' > VERSION_MARKER
    git commit -qam feature
    git checkout -q main            # leave it on main; each scenario sets the branch it needs
    # An "origin" for --from-main to fetch from: a bare clone, so pushes to it never touch this checkout.
    git clone -q --bare . "$dir.origin.git"
    git remote add origin "$dir.origin.git"
    git fetch -q origin
  )
}

# Advance ORIGIN's main to a new commit carrying marker $2, WITHOUT touching the local `main` ref — the
# local repo is left exactly as stale as the 2026-11-05 machine was. $1 = repo dir.
advance_origin() {
  local dir="$1" mark="$2" tmp
  tmp="$(mktemp -d "$WORK/advance.XXXXXX")"
  ( git clone -q "$dir.origin.git" "$tmp/c" && cd "$tmp/c" \
    && git config user.email t@t && git config user.name t \
    && printf '%s\n' "$mark" > VERSION_MARKER && git commit -qam "$mark" && git push -q origin main )
  rm -rf "$tmp"
}

# Run install.sh in $1, capturing exit code + the recorded marker (or "<none>" if nothing installed).
run() {  # $1 = repo dir; rest = install args
  local dir="$1"; shift
  local out="$dir/.installed_marker"; rm -f "$out"
  local rc=0
  ( cd "$dir"; KJT_TEST_OUT="$out" bash install.sh --provider testprov "$@" >/dev/null 2>&1 ) || rc=$?
  RC=$rc
  MARKER="$( [ -f "$out" ] && cat "$out" || echo '<none>' )"
}

# ───────────────── the real guard ─────────────────
if [ "$MUTATION" -eq 0 ]; then
  echo "install_rollout_test — REAL guard"

  # A. bare install from an off-main checkout is REFUSED, and nothing is installed.
  make_repo "$REPO/install.sh" "$WORK/a"
  ( cd "$WORK/a"; git checkout -q feature )
  run "$WORK/a"
  [ "$RC" -ne 0 ] && [ "$MARKER" = "<none>" ] && grn "A off-main bare install refused (rc=$RC, nothing installed)" \
    || red "A off-main bare install should refuse without installing (rc=$RC marker=$MARKER)"

  # A message names both escape hatches.
  ( cd "$WORK/a"; KJT_TEST_OUT=/dev/null bash install.sh --provider testprov 2>&1 >/dev/null || true ) \
    | grep -q -- "--from-main" && grn "A refusal names --from-main" || red "A refusal must name --from-main"

  # B. off-main + --allow-branch INSTALLS this branch's (FEATURE) bytes.
  make_repo "$REPO/install.sh" "$WORK/b"
  ( cd "$WORK/b"; git checkout -q feature )
  run "$WORK/b" --allow-branch
  [ "$RC" -eq 0 ] && [ "$MARKER" = "FEATURE" ] && grn "B --allow-branch installs the branch bytes (FEATURE)" \
    || red "B --allow-branch should install FEATURE (rc=$RC marker=$MARKER)"

  # C. off-main + --from-main installs MAIN bytes (branch-state-immune, via a worktree).
  make_repo "$REPO/install.sh" "$WORK/c"
  ( cd "$WORK/c"; git checkout -q feature )
  run "$WORK/c" --from-main
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && grn "C --from-main installs MAIN bytes off a feature branch" \
    || red "C --from-main should install MAIN (rc=$RC marker=$MARKER)"
  # ...and it left NO dangling worktree behind.
  ( cd "$WORK/c"; [ "$(git worktree list | wc -l | tr -d ' ')" = "1" ] ) \
    && grn "C --from-main cleaned up its worktree" || red "C --from-main leaked a worktree"

  # C2. Local main is STALE: origin/main moved on and nobody fast-forwarded the local ref. Run from
  # the stale local main itself (HEAD == local main), the exact 2026-11-05 shape. --from-main must install
  # ORIGIN's bytes (MAIN2), never the local ref's (MAIN).
  make_repo "$REPO/install.sh" "$WORK/c2"
  advance_origin "$WORK/c2" MAIN2
  run "$WORK/c2" --from-main
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN2" ] && grn "C2 --from-main installs origin/main (MAIN2), not a stale local main" \
    || red "C2 --from-main should install origin/main MAIN2, not the stale local main (rc=$RC marker=$MARKER)"
  # ...the same off a feature branch, where the old code read the local main ref too.
  ( cd "$WORK/c2"; git checkout -q feature )
  run "$WORK/c2" --from-main
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN2" ] && grn "C2 off a feature branch, --from-main still installs origin/main (MAIN2)" \
    || red "C2 off a feature branch should install MAIN2 (rc=$RC marker=$MARKER)"
  # (diff against HEAD: run() itself drops an untracked .installed_marker into the repo.)
  [ "$(git -C "$WORK/c2" rev-parse --abbrev-ref HEAD)" = feature ] && git -C "$WORK/c2" diff --quiet HEAD \
    && grn "C2 the caller's branch and working tree are untouched" || red "C2 --from-main changed the caller's checkout"

  # C3. The fetch FAILS (unreachable remote): refuse, install nothing — never fall back to the last-seen main.
  make_repo "$REPO/install.sh" "$WORK/c3"
  git -C "$WORK/c3" remote set-url origin "$WORK/no-such-remote.git"
  run "$WORK/c3" --from-main
  [ "$RC" -ne 0 ] && [ "$MARKER" = "<none>" ] && grn "C3 fetch failure refuses and installs nothing (rc=$RC)" \
    || red "C3 a failed fetch must refuse without installing (rc=$RC marker=$MARKER)"
  ( cd "$WORK/c3"; KJT_TEST_OUT=/dev/null bash install.sh --provider testprov --from-main 2>&1 >/dev/null || true ) \
    | grep -q "could not fetch" && grn "C3 the refusal says the fetch failed" || red "C3 the refusal must say the fetch failed"

  # C4. HEAD is at origin/main but the working tree has UNCOMMITTED edits: --from-main installs the
  # committed origin/main tree, not this checkout's working tree.
  make_repo "$REPO/install.sh" "$WORK/c4"
  printf 'DIRTY\n' > "$WORK/c4/VERSION_MARKER"
  run "$WORK/c4" --from-main
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && grn "C4 --from-main ignores uncommitted edits (installs MAIN, not DIRTY)" \
    || red "C4 --from-main should install committed origin/main (rc=$RC marker=$MARKER)"

  # D. on main, a bare install proceeds and installs MAIN bytes.
  make_repo "$REPO/install.sh" "$WORK/d"    # already on main
  run "$WORK/d"
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && grn "D bare install on main proceeds (MAIN)" \
    || red "D bare install on main should proceed with MAIN (rc=$RC marker=$MARKER)"

  # F. A PLAIN install on a STALE local main: HEAD == local main, but origin/main moved on. "On main" must
  # not mean "current" — refuse (exit 3) and name both ways out, installing nothing.
  make_repo "$REPO/install.sh" "$WORK/f"
  advance_origin "$WORK/f" MAIN2
  run "$WORK/f"
  [ "$RC" -eq 3 ] && [ "$MARKER" = "<none>" ] && grn "F plain install on a stale local main refused (rc=3, nothing installed)" \
    || red "F plain install on a stale local main should refuse with exit 3 (rc=$RC marker=$MARKER)"
  msg="$( cd "$WORK/f"; KJT_TEST_OUT=/dev/null bash install.sh --provider testprov 2>&1 >/dev/null || true )"
  grep -q "local main is 1 commits behind origin/main" <<<"$msg" && grep -q -- "--from-main" <<<"$msg" \
    && grn "F the refusal says how far behind and names --from-main" || red "F refusal text wrong: $msg"
  # ...and once main is updated, the same plain install goes through with the new bytes.
  ( cd "$WORK/f"; git merge -q --ff-only origin/main )
  run "$WORK/f"
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN2" ] && grn "F after updating main, the plain install proceeds (MAIN2)" \
    || red "F after updating main the plain install should proceed (rc=$RC marker=$MARKER)"

  # G. OFFLINE: on main, but the remote cannot be reached. Offline installs must keep working, with a
  # one-line warning that freshness could not be checked.
  make_repo "$REPO/install.sh" "$WORK/g"
  git -C "$WORK/g" remote set-url origin "$WORK/no-such-remote.git"
  run "$WORK/g"
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && grn "G offline plain install on main still installs (MAIN)" \
    || red "G offline plain install should still install (rc=$RC marker=$MARKER)"
  msg="$( cd "$WORK/g"; KJT_TEST_OUT=/dev/null bash install.sh --provider testprov 2>&1 >/dev/null || true )"
  [ "$(grep -c "could not reach 'origin' to check that local main is current" <<<"$msg")" = 1 ] \
    && grn "G it prints one warning that freshness could not be checked" || red "G missing the offline warning: $msg"

  # G2. A HANGING remote must not hang the install: the fetch is bounded (here 2 s), then it is treated as
  # offline. The ext:: transport stands in for a network that accepts and never answers.
  make_repo "$REPO/install.sh" "$WORK/g2"
  git -C "$WORK/g2" config protocol.ext.allow always
  git -C "$WORK/g2" remote set-url origin "ext::sh -c sleep% 30"
  t0=$(date +%s)
  ( cd "$WORK/g2"; KIJITO_TOOLS_FETCH_TIMEOUT=2 KJT_TEST_OUT="$WORK/g2/.installed_marker" \
      bash install.sh --provider testprov >/dev/null 2>&1 ); RC=$?
  el=$(( $(date +%s) - t0 ))
  MARKER="$( [ -f "$WORK/g2/.installed_marker" ] && cat "$WORK/g2/.installed_marker" || echo '<none>' )"
  [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && [ "$el" -lt 15 ] \
    && grn "G2 a hanging remote is cut off by the fetch timeout (${el}s) and the install proceeds" \
    || red "G2 hanging remote: rc=$RC marker=$MARKER after ${el}s"

  # E. a NON-git checkout (packaged release) is exempt — the bytes ARE the release.
  make_repo "$REPO/install.sh" "$WORK/e"
  ( cd "$WORK/e"; git checkout -q feature )
  rm -rf "$WORK/e/.git"                      # strip git → packaged install
  run "$WORK/e"
  [ "$RC" -eq 0 ] && [ "$MARKER" = "FEATURE" ] && grn "E non-git install is exempt (installs present bytes)" \
    || red "E non-git install should proceed (rc=$RC marker=$MARKER)"

# ───────────────── mutation: prove the guard is what refused ─────────────────
else
  echo "install_rollout_test — MUTATION (guard neutered; A must now INSTALL instead of refusing)"
  # Neuter branch_guard to an immediate return, leaving everything else intact.
  mut="$WORK/install.mutated.sh"
  sed 's/^branch_guard() {$/branch_guard() { return 0;/' "$REPO/install.sh" > "$mut"
  make_repo "$mut" "$WORK/m"
  ( cd "$WORK/m"; git checkout -q feature )
  run "$WORK/m"
  # With the guard gone, the bare off-main install silently proceeds with FEATURE bytes — exactly
  # the defect. If this does NOT happen, scenario A above proves nothing.
  [ "$RC" -eq 0 ] && [ "$MARKER" = "FEATURE" ] && grn "mutation: neutered guard installs FEATURE (A discriminates)" \
    || red "mutation: neutered guard should have installed FEATURE (rc=$RC marker=$MARKER)"

  # Freshness mutant: the plain-install check on main neutered. F's stale local main must then install
  # the stale MAIN silently — proving F is what catches it.
  mut3="$WORK/install.mutated3.sh"
  sed 's/^main_freshness_guard() {$/main_freshness_guard() { return 0;/' "$REPO/install.sh" > "$mut3"
  if cmp -s "$mut3" "$REPO/install.sh"; then
    red "mutation: the freshness mutant did not apply — the sed no longer matches, so it proves nothing"
  else
    make_repo "$mut3" "$WORK/m3"
    advance_origin "$WORK/m3" MAIN2
    run "$WORK/m3"
    [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && grn "mutation: no freshness check installs the stale MAIN (F discriminates)" \
      || red "mutation: the freshness mutant should have installed stale MAIN (rc=$RC marker=$MARKER)"
  fi

  # Stale-local-main mutant: --from-main reads the LOCAL main ref again. C2's stale-local-main case must then install
  # the stale MAIN — proving C2 is what catches the downgrade.
  mut2="$WORK/install.mutated2.sh"
  sed 's|"refs/remotes/\$MAIN_REMOTE/main^{commit}"|"refs/heads/main^{commit}"|' "$REPO/install.sh" > "$mut2"
  if cmp -s "$mut2" "$REPO/install.sh"; then
    red "mutation: the local-main mutant did not apply — the sed no longer matches, so it proves nothing"
  else
    make_repo "$mut2" "$WORK/m2"
    advance_origin "$WORK/m2" MAIN2
    run "$WORK/m2" --from-main
    [ "$RC" -eq 0 ] && [ "$MARKER" = "MAIN" ] && grn "mutation: reading local main installs the stale MAIN (C2 discriminates)" \
      || red "mutation: the local-main mutant should have installed stale MAIN (rc=$RC marker=$MARKER)"
  fi
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
