---
status: historical
created: 2026-11-12
archived: 2026-11-12
reason: "Why a FabriChat send became three times slower after the memory server began retracting what nothing reaches, and the per-record attribution that recovered most of it"
---

# A FabriChat send and the server's retirement walks, November 2026

## The regression

The browser benchmarks' FabriChat send ("fabrichat room/send" and "fabrichat
room scale/send 30") became about three times slower on 2026-10-23 and stayed
there. The raw per-run values in the Benchmarks artifacts step between the run
at `0c8db28459` (04:13 UTC) and the first run at `f66202d71c` (08:15 UTC),
which holds one commit: labs #9155, which made the memory server attribute
each tracked document to what reached it and retract what nothing reaches. A
window computed by intersecting each processor model's own before-and-after
runs had put the step one commit range later, after it had already happened.
The browser's own work per send was unchanged across the step (36 scheduler
runs and 323 cell accesses in each run's `diagnostics.log`), so the added time
was spent waiting.

## Method

Each build's toolshed binary was built as the Benchmarks workflow builds it and
run on a fresh data directory, and that build's own benchmark file drove a
browser against it. Builds were interleaved round by round. The benchmark was
patched locally, outside its timed interval, to read the toolshed's
`/api/health/stats` before and after each timed send, which gives the server's
own counters for that send. The machine was shared with other work, so wall
times are noisy; the counters are not. The installed Chrome was mid-update and
would not start, so these runs used Brave (Chromium 156) for every build.

## Mechanism

The server attributed what a walk reached to the document holding the link,
not to the record (one document under one selector) whose walk followed it.
When one record of a document retired while another remained, the server could
not tell what only the retired record had reached, so it walked the document
again under the records it kept, and those walks retired more records, which
were walked again in turn. Every FabriChat send moves message rows out of a
list while other records keep them, so each send set off hundreds of these
walks. A two-member room of ten messages showed it plainly: before #9155 the
server's refreshes took 56 ms per send; after it, 916 ms, 834 ms of them in
the retirement phase, across 1,711 root walks per send.

Two smaller costs added to it. A referrer that found a record under exactly the
selector it needed was counted as covering that record rather than walking it,
so when the record's only walker let go, every other referrer was walked again.
And the walks' memo is per evaluation, so each of these walks traversed what it
reached afresh.

## The change

What a walk reaches is attributed to the record whose walk reached it. The walk
tracks the record it is walking each document under: the root's for a visit,
and for a document a followed link entered, that record, for as long as the
position that followed the link is being traversed. The traversal reports its
positions (`TraversalContext.records`) and keys its memos by record. Misses and
crossings are attributed by record in the same way. A retiring record releases
what its own walk reached by lookup, so the walks that reconciled a surviving
document are gone, and the search for unreachable cycles runs over records. A
referrer covered by a record under the very selector it needs is counted as a
walker of it.

## Measurements

The benchmark as CI runs it, twelve members and thirty messages, three
interleaved rounds of five sends each:

| Build                   | Mean   | 75th percentile per round |
| ----------------------- | ------ | ------------------------- |
| Before #9155            | 0.56 s | 0.60, 0.52, 0.60 s        |
| `main` at `31b1d04166`  | 2.05 s | 2.35, 3.67, 2.05 s        |
| The change              | 0.87 s | 1.26, 0.91, 0.67 s        |

The server's counters per send, from the round with the instrument in place:

| Counter                      | Before #9155 | `main`   | The change |
| ---------------------------- | ------------ | -------- | ---------- |
| Refreshes                    | 59 ms        | 1,493 ms | 132 ms     |
| Retirement                   | none         | 1,424 ms | 12 ms      |
| Re-walk of changed documents | 48 ms        | 60 ms    | 102 ms     |
| Watch additions              | 9            | 12.5     | 12         |
| Frames                       | 73           | 90       | 89         |

The scaling benchmark's "send 30", twelve members, one round: 0.62 s before
#9155, 2.14 s on `main`, 0.78 s with the change.

## What remains

The change is not faster than before #9155. The remaining time is what #9155
does on purpose. A write now re-walks each changed document, so that a link
edited away is noticed and what it reached retracted; before #9155 a refresh
skipped a changed document its tracker already held. And retracting documents
leads the browser to add and remove watches it did not before: a send cost 9
watch additions and 73 frames before #9155 and 12 and 89 after.

## Ruled out

- labs #9188 (awaiting seals before quiescence) and labs #9197 (retracting
  only what a pass leaves untracked) fall in the window first given for the
  regression, but after the step.
- Re-attributing a schema document's closure to every later referrer (#9197)
  costs the same before and after it in a probe of thirty documents sharing
  one closure of forty schema documents.
- Letting the server's walk skip a covered link that declares no scope changes
  nothing: the server's storage names every document with its scope, so every
  link it walks already declares one.
- The bookkeeping of which record a document is walked under costs nothing
  measurable in an in-process probe of a hundred linked documents.
