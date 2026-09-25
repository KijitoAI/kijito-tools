#!/usr/bin/env python3
"""Render docs/statusline.svg from the REAL status line's output (row M309).

The README picture of the status line is not drawn by hand: this runs
providers/claude/scripts/statusline-context.sh against a fixed specimen (a pane whose persona marker says
`argus`, whose producer state file holds 3 unread, at 42% context) under a scratch HOME, and turns the ANSI
colours it prints into SVG. tests/statusline_render_test.sh re-runs it and fails if the committed SVG differs,
so the picture cannot drift from what the script shows.

    python3 scripts/render-statusline-svg.py            # print the SVG
    python3 scripts/render-statusline-svg.py --write    # rewrite docs/statusline.svg
"""
import html
import json
import os
import re
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "providers", "claude", "scripts", "statusline-context.sh")
OUT = os.path.join(REPO, "docs", "statusline.svg")
PERSONA, UNREAD = "argus", 3
COLOURS = {"0": "#d4d4d4", "31": "#f14c4c", "32": "#23d18b", "33": "#e5e510", "36": "#29b8db"}
CHAR_W, PAD, H = 8.4, 14, 34


def status_line():
    with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as proj:
        with open(os.path.join(proj, ".kijito_persona"), "w") as f:
            f.write(PERSONA + "\n")
        os.makedirs(os.path.join(home, ".kijito-monitor"))
        with open(os.path.join(home, ".kijito-monitor", PERSONA + ".state"), "w") as f:
            json.dump({"identity": ["https", "api.kijito.ai", 443, "/api/inbox", [["persona", PERSONA]]],
                       "cursor": 1, "state": "UP", "consecutive_failures": 0, "unread": UNREAD}, f)
        payload = {"model": {"display_name": "Opus 5"}, "workspace": {"current_dir": proj},
                   "context_window": {"used_tokens": 420000, "total_tokens": 1000000}}
        env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "CLAUDE_PROJECT_DIR")}
        env["HOME"] = home
        return subprocess.run(["bash", SCRIPT], input=json.dumps(payload), capture_output=True, text=True,
                              env=env, cwd=proj, check=True).stdout


def svg(line):
    spans, colour, x = [], COLOURS["0"], PAD
    for part in re.split(r"(\x1b\[[0-9;]*m)", line):
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", part)
        if m:
            colour = COLOURS.get(m.group(1) or "0", COLOURS["0"])
        elif part:
            spans.append('<tspan x="%.1f" fill="%s">%s</tspan>' % (x, colour, html.escape(part)))
            x += CHAR_W * len(part)
    width = int(x + PAD)
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" '
            'aria-label="%s">\n'
            '<rect width="100%%" height="100%%" rx="6" fill="#1e1e1e"/>\n'
            '<text y="22" font-family="Menlo, Consolas, monospace" font-size="14" xml:space="preserve">%s</text>\n'
            '</svg>\n' % (width, H, width, H, html.escape(re.sub(r"\x1b\[[0-9;]*m", "", line)), "".join(spans)))


if __name__ == "__main__":
    out = svg(status_line())
    if "--write" in sys.argv:
        with open(OUT, "w") as f:
            f.write(out)
    else:
        sys.stdout.write(out)
