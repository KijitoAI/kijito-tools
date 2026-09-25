#!/usr/bin/env bash
# Is the README's picture of the status line what the status line actually prints? (row M309)
#
# docs/statusline.svg is RENDERED from statusline-context.sh's real output by
# scripts/render-statusline-svg.py, never drawn by hand. A picture that has drifted from the script
# shows users a line they will not get, so this re-renders it and compares byte for byte.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed"; exit 0; }

echo "statusline render checks:"
fresh="$(python3 "$REPO/scripts/render-statusline-svg.py")"
if [ "$fresh" == "$(cat "$REPO/docs/statusline.svg")" ]; then
  grn "docs/statusline.svg is exactly what the status line renders today"
else
  red "docs/statusline.svg has drifted from the script — run: python3 scripts/render-statusline-svg.py --write"
fi
if [[ "$fresh" == *">argus<"* && "$fresh" == *"✉ 3"* && "$fresh" == *"ctx 420k/1m (42%)"* ]]; then
  grn "the rendered line carries the persona, the unread count and the context figure"
else
  red "the rendered line is missing persona, count or context figure"
fi
if grep -q '](docs/statusline.svg)' "$REPO/README.md"; then
  grn "the README shows the picture"
else
  red "the README does not reference docs/statusline.svg"
fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
