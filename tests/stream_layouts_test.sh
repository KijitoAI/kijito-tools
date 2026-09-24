#!/usr/bin/env bash
# kijito_stream_for_persona must find a persona's event stream in EVERY layout a producer writes
# (row M313 follow-up): the fleet's systemd units (~/.kijito-monitor/<p>.jsonl), the launchd plist
# (~/.cache/kijito-inbox-monitor/events.<p>.ndjson) and the monitor's own shipped systemd template
# (~/.local/state/kijito-inbox-monitor/events.<p>.ndjson) - by BOTH routes: asking the producer for
# its filename rule, and reading the persona the stream stamps on its own first line.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../providers/claude/scripts/kijito-persona-lib.sh"
pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1  ${3:-}"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/fakebin" <<'FB'
#!/usr/bin/env bash
[ "${1:-}" = --safe-persona ] && { python3 -c 'import sys;print("".join(c if (c.isalnum() or c in "._-") else "_" for c in sys.argv[1].casefold()))' "$2"; exit 0; }
exit 2
FB
chmod +x "$T/fakebin"
for layout in fleet launchd template; do
  for route in producer content; do
    H="$T/$layout-$route"; mkdir -p "$H"
    case $layout in
      fleet)    f="$H/.kijito-monitor/loom.jsonl" ;;
      launchd)  f="$H/.cache/kijito-inbox-monitor/events.loom.ndjson" ;;
      template) f="$H/.local/state/kijito-inbox-monitor/events.loom.ndjson" ;;
    esac
    mkdir -p "$(dirname "$f")"; printf '{"event": "armed", "persona": "Loom"}\n' > "$f"
    bin="$T/fakebin"; [ "$route" = content ] && bin="$T/no-such-producer"
    got=$(HOME="$H" KIJITOMON_BIN="$bin" PATH="/usr/bin:/bin" bash -c ". '$LIB'; kijito_stream_for_persona Loom")
    [ "$got" = "$f" ] && ok "$layout layout found via $route" 1 || ok "$layout layout found via $route" 0 "got '$got'"
  done
done
echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
