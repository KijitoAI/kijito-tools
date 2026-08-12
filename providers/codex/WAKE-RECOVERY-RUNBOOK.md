# Codex wake recovery runbook

This is the production gate for replacing the pre-fold Codex wake controller. It does not
authorize a swap by itself. The frozen source must first pass two identical test runs and Assay's
review of those exact bytes.

## Preconditions

- Record the frozen commit SHA. The installer must receive that exact 40-hex value through
  \`--origin-git-sha\`; a branch name, dirty artifact, abbreviation, guessed SHA, or source tree
  whose gated bytes differ from that Git commit is refused.
- Name every pre-existing controller install through one or more explicit \`--legacy-root\`
  arguments. The installer canonicalizes and records those scopes; an omitted, missing, or
  controller-less legacy scope is refused rather than treated as an empty population.
- Re-run the full process census immediately before action. It must name every matching legacy
  controller PID, including an unlocked orphan. Do not rely on the lock alone.
- Obtain Assay's byte verdict and announce the intended stop/start to both Assay and Ladybug before
  sending any signal. Wait for the announcement to be durably recorded.

## A1 — archive evidence before touching either controller

Create a private, timestamped evidence directory outside the install root. Copy—never move or
delete—the legacy \`runtime/state.json\`, \`runtime/controller.ndjson\`,
\`runtime/consumer.lock\`, and \`installed-manifest.json\` when present. Record each source
path, device/inode, byte count, mode, SHA-256, capture timestamp, the exact pre-stop census, and the
lock's named PID. Fsync the copied files and evidence directory. A missing artifact is a named
finding, not an empty substitute.

Re-read and hash the copies before proceeding. If any source changes during capture, archive both
observations and stop for review; do not manufacture a single coherent specimen from changing
bytes. The evidence archive is permanent incident evidence and is distinct from the rollback copy.

## Announced stop and replacement

After A1 and A2, re-run the census. Its exact PID set must equal the announced set. Stop every
enumerated legacy controller cleanly and prove every PID vanished; an unenumerated, unverifiable, or
new matching process aborts the swap. Preserve the old install as the rollback artifact.

Install only from the reviewed source through \`install.mjs\`, passing its exact commit SHA and
every announced legacy install root, for example:

```sh
node providers/codex/install.mjs \
  --origin-git-sha <exact-reviewed-40-hex-sha> \
  --legacy-root /absolute/path/to/preserved-old-install
```

The installer verifies each gated source artifact against the named Git commit before executing
or copying it. It canonicalizes all census-bound paths before applying the representability gate.
Never hand-edit installed bytes, state, lock, or manifest. The installed manifest must report:

- package \`kijito-claude\`;
- package version \`0.1.4\`;
- repository \`https://github.com/KijitoAI/kijito-claude\`;
- the exact reviewed 40-hex source commit.

Start exactly one controller. Post-start census must find exactly one manifest-bound instance and
the lock PID must equal it.

## Evidence-by-effect

The successor must resume the exact dedicated thread. The schema-1 legacy migration may clear only
one exact \`thread did not become idle\` latch after that thread proves idle; zero, two, or any
other reason is a refusal. Keep the archived latch forever.

Do not call recovery complete until all are true:

- doctor is GREEN with schema 2, no ambiguity, no unresolved \`inFlight\`, an empty durable pending
  queue, a clear independently rechecked stream, a fresh idle app-server heartbeat whose live child
  process is parented by the exact controller PID, no child-exit record newer than the arm record,
  current PID/run-stamped lifecycle evidence, and one successful surface;
- startup drains any existing event backlog from byte zero rather than seeking to EOF;
- exactly one startup reconciliation is recorded;
- two new, real urgent hive messages each become a matching completed turn by effect, without body
  text entering controller state or logs;
- exact-one process and lock ownership still hold after both wakes.

Any failure leaves the rollback and A1 archive intact, is reported to Assay, and does not authorize
manual state repair or a second consumer.
