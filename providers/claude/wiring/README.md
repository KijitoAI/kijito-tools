# Wiring the backup heartbeat

## Why it matters: a usage limit silently ends your inbox loop

When a Claude session hits its **usage limit**, its turn loop stops — and the wake-capable inbox
consumer it had armed (the Monitor that tails your event stream) stops or expires with it. **Nothing
tells you.** When the limit clears, nothing re-arms the consumer either: the producer keeps collecting
your mail into the stream, nobody reads it, and the session stays deaf indefinitely while every health
signal still reads green (producer up, heartbeat fresh, mail landing).

The backup heartbeat is what recovers it:

1. **It notices.** Every poll it checks whether your persona's event stream has a consumer. If new
   mail events land and no consumer has been attached for 10 minutes (`HEARTBEAT_UNCONSUMED_SECS`),
   it raises an **UNCONSUMED-STREAM** alert: a `HEARTBEAT_UNCONSUMED_STREAM` line in
   `~/.claude/.lifecycle/lifecycle.log`, and a red **`⚠ inbox deaf`** in that pane's status line.
   This is a different alarm from the producer's "dormant inbox" notice (mail nobody has *read* on the
   server); this one is about a local stream nobody is *consuming*, and its fix is to re-arm.
2. **It nudges.** Once the pane has been idle for a full quiet window (default 20 min), it types a
   prompt into the session telling it to re-arm its inbox consumer first, then resume its work. While
   the limit still holds, the nudge just gets the limit message back and costs nothing; the first nudge
   after the limit clears restarts the agent, which re-arms.
3. **It clears.** As soon as a consumer is attached again the alert and the status-line flag go away
   (`HEARTBEAT_STREAM_CONSUMED` in the log).

⛔ **It never types into a menu.** Claude Code's folder-trust dialog has "No, exit" as an option, so an
Enter sent there could end the session. If the pane shows the trust dialog, or any numbered selection
menu, the heartbeat logs `HEARTBEAT_SKIP … shows an interactive menu` and sends nothing. Answer that
dialog yourself.

## Started for you by `claude-armed.sh`

Since row M291, launching an armed session with `claude-armed.sh` inside tmux **starts the heartbeat
for that pane automatically** and stops it when the session exits. It is idempotent: if a watchdog is
already watching the pane (for example one of the supervised units below), it is left alone and not
stopped on exit. Opt out with `KIJITO_HEARTBEAT=0`.

The supervised forms below are still useful if you want the heartbeat to outlive the session's launcher
(for example across a crash of the `claude-armed.sh` process itself). ⚠️ Known limit: a watchdog is
identified by its pane id only, so a seat running **two** tmux servers can mistake another server's
`%2` watchdog for yours and skip starting one. One tmux server per seat (the normal setup) is fine.

## Linux (systemd user unit)

```sh
cp kijito-heartbeat@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kijito-heartbeat@1     # for pane %1
```

⚠️ **Instantiate with the pane number WITHOUT its leading `%`.** systemd treats `%` as its own
specifier prefix, so `kijito-heartbeat@%1` is mangled to `\x251` and the watchdog then polls a pane
that cannot exist — it logs `HEARTBEAT_START pane=\x251`, finds nothing, and restart-loops forever.
Measured 2026-08-01. The unit rebuilds the real id as `%%%i` (a literal `%`, then the instance name).

Find your pane id with `echo $TMUX_PANE` inside the session.

## macOS (launchd)

Same script, same argument. A minimal LaunchAgent:

```xml
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>/Users/YOU/.claude/heartbeat-watchdog.sh</string>
  <string>%1</string>
</array>
<key>KeepAlive</key><true/>
```

launchd has no `%`-specifier problem, so the pane id goes in verbatim.

## Or just run it

```sh
nohup ~/.claude/heartbeat-watchdog.sh "$TMUX_PANE" >/dev/null 2>&1 &
```

Fine for a single session; it dies with the shell that started it, which is why the supervised forms
above exist.

## Checking it

`grep HEARTBEAT ~/.claude/.lifecycle/lifecycle.log`. You should see `HEARTBEAT_START` once, then
`HEARTBEAT_SKIP` lines if the pane is unarmed, and `HEARTBEAT_NUDGE` only after a full quiet window
(default 4 × 300s = 20 min of byte-identical pane output).
`HEARTBEAT_UNCONSUMED_STREAM` means mail is arriving and nothing is reading it; it should be followed by
a `HEARTBEAT_NUDGE` and then `HEARTBEAT_STREAM_CONSUMED` once the session has re-armed.

The behaviour above is pinned end to end, against a real tmux server, by
`tests/heartbeat_m291_test.sh` (a session killed mid-loop by a usage limit is flagged, stays deaf while
the limit holds, and is re-armed after it clears; the trust dialog is never typed into).
