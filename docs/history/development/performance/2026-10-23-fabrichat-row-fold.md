---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Why a FabriChat message row derives what it shows in four computeds rather than sixteen: under server execution a computed that reads the viewer runs once per viewer, and one that reads the session once per session, so each flag that reads the viewer cost a run per viewer per row, and each that reads the session a run per session. Folding them took the send burst's mean from 3.5 and 3.6 s to 2.8 and 2.9 s with the serving loop on in a worker; with it off, one pair showed no clear change. Measured on the served-vote branch (#9122) before the change was split out to land on its own."
---

# A FabriChat row's derivations, one per reader

This change was made and measured on the served-vote branch
(commonfabric/labs#9122), and split out of it to land on its own. The room's
pattern files on that branch were the same as `main`'s before it.

## How it was measured

On #9122's branch, `cbd29a21a` against its parent `271086444`, each from a
scratch worktree. `fabrichat-send-burst.bench.ts` ran in process, four members
sending two messages each, on two arms:

- the serving loop in a worker, with the store read-through on, the overlap
  off, the flush deadline growing to a 1000 ms cap, and
  `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on;
- `EXPERIMENTAL_SERVER_EXECUTION=false`, the loop off.

The worker arm alternated before and after, two pairs; the loop-off arm ran
one pair. Every run was on a four-core container.

## What a row derived

A message row derived each flag it shows in a computed of its own, sixteen in
all. The viewer's rights, tallies and button displays read the viewer; the
editor and picker state read the session. A runtime serving the room runs a
computed that reads the viewer once for every viewer, and one that reads the
session once for every session, so each flag that reads the viewer cost a run
per viewer per row, and each that reads the session a run per session per row.
A client runtime runs its own viewer's instance of each.

## The change

The row derives in four computeds, and binds the UI to their fields:

- what reads the message alone;
- what reads the viewer;
- what the session has open;
- the thread link.

The room's contract changes only in its writers' module identity, recorded as
a new pattern baseline. The row's output still carries `tallies`, now a field
of the viewer's computed, so whatever reads it depends on that whole computed: a
change to the viewer's rights runs it again as well.

## Measured

| `send burst 4x2` | Mean | Range | 75th percentile |
| --- | ---: | ---: | ---: |
| Worker arm, first pair, before | 3.5 s | 2.6 to 5.1 s | 3.7 s |
| Worker arm, first pair, after | 2.8 s | 2.4 to 3.2 s | 2.9 s |
| Worker arm, second pair, before | 3.6 s | 2.7 to 4.6 s | 4.3 s |
| Worker arm, second pair, after | 2.9 s | 2.3 to 3.5 s | 3.3 s |
| Loop off, before | 2.4 s | 1.6 to 4.6 s | 2.0 s |
| Loop off, after | 2.0 s | 1.6 to 2.3 s | 2.1 s |

On the worker arm both pairs moved, by mean and by 75th percentile. The
loop-off pair's means differ by one 4.6 s iteration in the before arm, and its
75th percentiles read 2.0 and 2.1 s, so it shows no clear change. A client
runtime runs one instance of each computed, for its own viewer, where a serving
runtime runs one for every viewer, so the fold saves a client fewer runs.
