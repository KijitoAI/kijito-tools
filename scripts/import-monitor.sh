#!/usr/bin/env bash
# Re-import providers/monitor from KijitoAI/kijito-inbox-monitor at ONE named commit.
#   scripts/import-monitor.sh <upstream-sha-or-tag> [upstream-repo-url]
# Replaces providers/monitor with the exact tree at that commit, records the sha, tree id and file
# listing in providers/monitor/UPSTREAM (the one file this repo owns there, rewritten on every import),
# then runs tests/vendored_monitor_test.sh. Any other file not in the upstream tree is removed.
set -eu
REF=${1:?usage: scripts/import-monitor.sh <upstream-sha-or-tag> [repo-url]}
URL=${2:-https://github.com/KijitoAI/kijito-inbox-monitor.git}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/providers/monitor"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

git clone -q "$URL" "$tmp/up"
sha=$(git -C "$tmp/up" rev-parse --verify "$REF^{commit}")
tree=$(git -C "$tmp/up" rev-parse "$sha^{tree}")
tag=$(git -C "$tmp/up" describe --tags --exact-match "$sha" 2>/dev/null || true)

git -C "$ROOT" rm -rqf --ignore-unmatch -- providers/monitor >/dev/null
rm -rf "$DIR"; mkdir -p "$DIR"
git -C "$tmp/up" archive "$sha" | tar -x -C "$DIR"
{
  echo "# providers/monitor is a byte-exact copy of this upstream release."
  echo "# Written by scripts/import-monitor.sh; verified by tests/vendored_monitor_test.sh. Never hand-edit."
  echo "repo=KijitoAI/kijito-inbox-monitor"
  echo "sha=$sha"
  echo "tree=$tree"
  [ -n "$tag" ] && echo "tag=$tag"
  git -C "$tmp/up" ls-tree -r "$sha" | awk -F'\t' '{split($1,a," "); print "file=" a[1], a[3], $2}'
} > "$DIR/UPSTREAM"
git -C "$ROOT" add -A -- providers/monitor
echo "imported $sha${tag:+ ($tag)} tree $tree"
bash "$ROOT/tests/vendored_monitor_test.sh"
