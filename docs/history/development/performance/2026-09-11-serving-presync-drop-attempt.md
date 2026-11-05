---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Investigation record: an attempt to drop the serving runtime's resume pre-sync under the store read-through, on the 30-topic board — why the skip stalls serving, what the pre-sync turns out to supply, and the two defects the attempt surfaced and closed."
---

# Dropping the serving runtime's pre-sync under the store read-through, attempted

Measured 2026-09-11 on the branch stacked on the read-through fixes
(`fce38a7000`), with the same rig as
[2026-09-11-serving-cold-activation.md](2026-09-11-serving-cold-activation.md):
a source-run toolshed with `EXPERIMENTAL_SERVER_EXECUTION=true` and
`SERVER_EXECUTION_STORE_READ_THROUGH=true`, the dev shell built with the same
flag, the 30-topic board seeded once and reused, and the throwaway journey
harness driving one browser per activation. The machine's load ran between 30
and 300 across runs; only counters are compared.

## What was skipped

The resume pre-sync is server-side: `runner/start/syncCellsForRunningPattern`
on the serving runtime, inside the demand pass's structure loads. The skip,
gated on `IStorageManager.hasStoreReadThrough(space)`, left out the three sync
waves — the mentioned inputs, the owned-cell wave, the argument link targets —
and kept the owned-cell collection and the list-children pass, which resolve
and start the mapped sub-pattern instances a resumed piece runs. The
`engine-read-through` suite pinned it red-first on the `start/resumeCellSync`
timing count, the executor suites with the posture forced on kept only their
two known session-specific reds, and a cold activation's store reads fell from
4,238 to 3,218.

## Why it does not serve

On the board it stalls, and three live captures at the stall agree. The board
piece and one more start and register 41 write entities: computed and
internal documents. The client's demanded closure for the board space is 104
entities — result and argument documents and schema documents, no computed
document — and none of them is written by a registered action, so no demand
root enters, no computation becomes live, and the scheduler runs one action
in total; the per-demander instances the cards need are never produced. With
the pre-sync on the same head, the same client's activation starts 36 pieces,
enters 496 demand roots, every one with a writer, and runs 554 actions.

What the pre-sync supplies is therefore not the reads. Its `pull()`s
integrate as first-load frames, and the notifications those frames raise are
what put a resumed piece's actions to work before any demand row names their
outputs. A read on access integrates as a plain refresh and notifies nothing,
and an action that has never run reads nothing. Dropping the pre-sync needs a
replacement for that first-run trigger — a resumed start under the
read-through scheduling its actions' initial run directly — and the skip
alone is a serving regression, so it did not land.

## What the attempt closed

The unhandled `SqliteError: 21: SQLite3 API misuse` first seen under the skip
predates it. The renew arm's lease-lost park runs unawaited; the host's close
sees the space already inactive and returns; the server closes the engine;
the in-flight park then releases its lease row through a prepared statement
on the closed database. A second `park()` now returns the first's completion,
pinned in `executor-space-server.test.ts`.

The read-through suite's watermark waits read the engine's head seq as the
authored seq. The loop's own derived commit can already sit above it, and the
watermark covers authored inputs only, so the wait could never resolve; they
wait on the written document's own seq now.

## Rig notes

`scripts/start-local-dev.sh` kills both servers when one of its readiness
checks exceeds `LOCAL_DEV_STARTUP_TIMEOUT` (120 s by default), which a loaded
machine trips after the probe has started; a probe stuck with the toolshed
dead is the script's kill, one stuck with a live toolshed and frozen counters
is a stall. Two runs that died that way are excluded above.
