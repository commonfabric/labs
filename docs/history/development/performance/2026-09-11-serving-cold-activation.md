---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Investigation record: where a serving toolshed under the store read-through spends its time on a 30-topic board, measured with the serving loop's counters and a CPU profile of the process — two defects in the read-through's own reads closed on the way, and the remaining cost named."
---

# Where a serving toolshed spends its time under the store read-through

Measured 2026-09-11 at `d924215bbf` (main with #7286, the store read-through)
plus the two fixes this record describes, on the same Apple-silicon laptop as
the earlier board records, loopback only. The toolshed ran from source with
`EXPERIMENTAL_SERVER_EXECUTION=true` and
`SERVER_EXECUTION_STORE_READ_THROUGH=true`; the shell was the dev shell built
with the same flag, and the seeding process and the harness declared the ON
arm too. `/api/meta` published `serverExecution: true` and the health route
carried `servingLoop` for every run. The board was seeded once with the
navigation bench's fixture at 30 topics and reused.

The machine carried other sessions' work throughout: the load average ran
between 18 and 110 across runs. Wall-clock figures below are therefore only
comparable within a run, and the counters — store reads, demand-pass
milliseconds, terminal loads, derived commits — are what the conclusions rest
on.

## Instrument

A throwaway harness (not committed) ran one browser journey per iteration —
load, sign in, board, open topic, crossref — timing each step, differencing
`/api/health/stats` around it on the two additive fields, and printing the
serving-loop counter deltas and the browser's own load summary. The toolshed
was profiled over its inspector port for the harness's lifetime at a 2 ms
sampling interval (`skills/perf-investigation/scripts/profile-toolshed.ts`).
The harness's own gaps between journeys ran past the loop's 30 s idle park, so
every journey without a keeper session measured a cold activation; a second
mode held the board open in one browser for the whole run, so later journeys
measured a serving space.

## What a cold activation cost, and why

Before any change, the board step of a cold journey took 14 to 20 s at a load
of about 100. The serving loop reported 43,000 to 44,000 store reads and 10 to
16 s of demand-pass time per activation, and the toolshed's log carried 3,644
`schema-doc-quarantine` errors, 3,517 of them naming one content hash across
30 documents: the topic documents, each dropped over a hundred times.

Every one of those hashes was stored, and every one verified. What failed was
the read-through's schema chase: it followed the `cid:` references in a
document's link positions and in a schema document's own refs, but not the
document's `schema` metadata member, which the frame validator holds to the
same delivery guarantee. A topic document names its result schema there. The
validator quarantined the document, the replica held nothing for it, and the
next access read it from the store again, to be quarantined again. The client
worker's own pattern-start syncs stalled for up to ten seconds behind that
work, because the memory server shares the process with the serving loop and
the demand pass is synchronous.

With the chase following the metadata member (the first fix), a cold
activation at a load of about 20 took 5.8 s in the board step, with 44,900
store reads and a 4.1 s demand pass. Tagging the four read sites for one
journey gave the distribution:

| read site                              | reads  |
| -------------------------------------- | ------ |
| `pull`, document already held          | 33,516 |
| `pull`, first load                     | 11,555 |
| schema chase                           | 212    |
| on-access miss                         | 191    |

Three quarters of the reads were re-syncs of documents the replica already
held, issued by the resume pre-sync of every started piece: 3,772 distinct
documents, the busiest re-read about 280 times each. The on-access misses,
the reads the posture exists to serve, were under two hundred.

The second fix answers a sync of a held document from the replica, as a
session answers a re-sync of a covered selector from its watch: the feed's
refresh at every cycle is what moves a held record. A read that lands at the
seq the replica already confirmed is also dropped before the chase. Reads per
cold activation fell from 39,600 to 4,238.

The wall time did not follow. At a load of 30 to 50 the board step stayed at
4.5 to 4.9 s with a 4.3 s demand pass, and the activation produced exactly one
derived commit: the store already held every derived value from the seed, so
the whole pass was 68 pattern structure loads with their resume pre-sync
(`runner/start/syncCellsForRunningPattern`, 68 calls at about 112 ms each,
overlapping; 10,986 `resumeCellSync` and 5,490 `resumeArgumentLinkTargetSync`
spans) deciding that nothing needed to run. The CPU profile of that window is
flat — deep-freezing, traversal, value hashing, link resolution, schema
interning, each under 3% of samples — and about a second of it is the
loopback session serving the cross-space reads into the seeding user's home
space, which the read-through does not cover.

Skipping the pre-sync outright on the serving runtime, tried behind an
environment variable as a bound on the win, did not serve the board at all:
the client waited five minutes for its first card. The pre-sync does more than
keep cold targets out of a first run's commit basis, and a narrower cut is its
own investigation.

## What a warm journey costs

With a keeper session holding the board, the board step took 0.9 to 1.9 s and
the server was 93% idle over the run: 35 store reads and a demand pass of 25
to 150 ms per journey, 18 watch adds at about 30 ms each. The time is in the
browser worker: `runner/start/syncCellsForRunningPattern` over 38 pattern
starts at a 291 ms median, 1,493 `resumeCellSync` spans, and 32 serialized
`watchRefresh/watchAddSync` round trips totalling 2.3 s — the client's own
cold-cache resume of the pieces it renders. Open-topic and crossref ran in 0.3
to 0.6 s each on both server and client.

## Where this leaves the posture

The navigation bench's earlier gain (a served journey in roughly a third of
the time) was measured on a space that stayed active across iterations, so it
never paid the activation cost; the two fixes here make that cost about a
tenth of what it was in reads and a quarter to a third in time. Three costs
remain, in the order they are worth attacking:

1. **The browser's resume pre-sync** decides a warm board's time and is
   independent of the server's posture. The pre-sync rework in #7287 is the
   open work on it.
2. **The serving runtime's structure loads** decide a cold activation: 68
   starts whose pre-sync walks and syncs everything the pieces own for one
   derived commit. A pre-sync that knows the space is read from the engine
   could do less, but not nothing, as the outright skip showed.
3. **Cross-space reads** stay on the loopback session and cost about a second
   per activation on this board; they are outside the read-through by design.

The harness's finding about itself also stands for production: a space parks
30 s after its last client leaves, and the first client back pays the
activation.
