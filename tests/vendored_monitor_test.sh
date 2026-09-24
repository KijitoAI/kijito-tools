#!/usr/bin/env bash
# Row M314 — the vendored monitor must be EXACTLY the upstream release it claims to be.
#
# providers/monitor/ is a vendored copy of KijitoAI/kijito-inbox-monitor. Before this test it had
# silently drifted from upstream (hand edits landed here and not there, and upstream fixes never came
# back), so what users installed from this package was neither release. The fix is to make the claim
# checkable: providers/monitor/UPSTREAM records the upstream commit, its git TREE id and the file
# listing, and this test recomputes the git tree id of the vendored directory FROM THE FILES ON DISK
# and requires it to be byte-identical. A git tree id covers every path, mode and byte, so there is
# no "close enough": one changed byte, one extra file, one missing file or one flipped executable bit
# fails it. It needs no network and no upstream checkout — only git.
#
# Files that belong to THIS repo, not upstream, and are therefore excluded from the comparison:
EXTRAS="UPSTREAM IMPORT-PROVENANCE.md OPAQUE-OUTPUT-ENFORCEMENT.md"
#
# To move the vendored copy to a new upstream release, never edit it by hand: run
#   scripts/import-monitor.sh <upstream-sha>
# which replaces the tree, rewrites UPSTREAM and re-runs this test.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR=providers/monitor
UP="$ROOT/$DIR/UPSTREAM"

pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1  ${3:-}"; fi; }

command -v git >/dev/null 2>&1 || { echo "FAIL: git is required to verify the vendored monitor"; exit 1; }
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || { echo "FAIL: $ROOT is not a git checkout; the vendored-monitor check needs one"; exit 1; }
[ -f "$UP" ] || { echo "FAIL: $DIR/UPSTREAM is missing — the vendored copy does not say which upstream release it is"; exit 1; }

want_sha=$(sed -n 's/^sha=//p' "$UP"); want_tree=$(sed -n 's/^tree=//p' "$UP")
[ -n "$want_sha" ] && [ -n "$want_tree" ] || { echo "FAIL: $DIR/UPSTREAM lacks sha= or tree="; exit 1; }

# vendored_tree [perturb-path] -> prints the git tree id of the vendored files (EXTRAS excluded); with
# a path, that one file's content is altered first (used only by the canary below). Writes nothing to
# the object store: blobs are hashed without -w and the tree is written with --missing-ok into a
# throwaway index.
vendored_tree() {
  local idx rel mode blob f
  idx=$(mktemp); rm -f "$idx"
  while IFS= read -r f; do
    rel=${f#"$DIR"/}
    case " $EXTRAS " in *" $rel "*) continue ;; esac
    [ -f "$ROOT/$f" ] || continue                  # a tracked file deleted from disk is drift: leave it out
    mode=100644; [ -x "$ROOT/$f" ] && mode=100755
    if [ "$rel" = "${1:-}" ]; then
      blob=$( { cat "$ROOT/$f"; printf 'drift'; } | git -C "$ROOT" hash-object --stdin)
    else
      blob=$(git -C "$ROOT" hash-object --no-filters -- "$ROOT/$f")
    fi
    GIT_INDEX_FILE=$idx git -C "$ROOT" update-index --add --cacheinfo "$mode,$blob,$rel"
  done < <(git -C "$ROOT" ls-files --cached --others --exclude-standard -- "$DIR")
  GIT_INDEX_FILE=$idx git -C "$ROOT" write-tree --missing-ok
  [ -n "${KEEP_LISTING:-}" ] && GIT_INDEX_FILE=$idx git -C "$ROOT" ls-files -s > "$KEEP_LISTING"
  rm -f "$idx"
}

echo "== vendored monitor == upstream $want_sha =="
listing=$(mktemp)
got=$(KEEP_LISTING=$listing vendored_tree)
if [ "$got" = "$want_tree" ]; then
  ok "providers/monitor is byte-identical to upstream tree $want_tree" 1
else
  ok "providers/monitor is byte-identical to upstream tree $want_tree" 0 "got $got"
  echo "  differences (vendored vs recorded upstream listing; mode blob path):"
  diff <(sed -n 's/^file=//p' "$UP" | sort -k3) <(awk '{print $1, $2, $4}' "$listing" | sort -k3) | sed 's/^/    /' | head -40
  echo "  Do not hand-edit providers/monitor. Fix upstream, then: scripts/import-monitor.sh <sha>"
fi
rm -f "$listing"

echo "== CANARY: the check can fail =="
first=$(sed -n 's/^file=[0-9]* [0-9a-f]* //p' "$UP" | head -1)
[ -n "$first" ] && [ "$(vendored_tree "$first")" != "$want_tree" ] \
  && ok "a one-file change is detected ($first)" 1 || ok "a one-file change is detected" 0 "the tree did not move"
[ "$(sed -n 's/^file=//p' "$UP" | grep -c .)" -gt 0 ] && ok "UPSTREAM records the file listing" 1 || ok "UPSTREAM records the file listing" 0

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
