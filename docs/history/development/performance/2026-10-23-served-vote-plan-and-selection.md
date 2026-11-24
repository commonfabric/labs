---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "One rendered lunch vote at 296 votes after the planner's per-producer index and the selection's incremental resolve: the serving worker's plan fell from 531 to 307 ms a vote and its render from 130 to 21 ms, the main thread's selection handling from 147 to 41 ms, the vote's time did not move, every vote's selection swaps two of its 3,269 roots and so rebuilds the support graphs whole, and the browser's runtime worker, busy about a second a vote re-proving producers it proved on the last wake, is the vote's critical path."
---

# A served vote's plan and selection, and where the vote waits now

The [three-realm record](2026-10-23-one-served-vote-across-three-realms.md)
left a rendered lunch vote at 1.13 to 1.28 s with view-scoped replication on,
against 0.69 s with the serving loop off at 296 votes. Of the serving
worker's per-vote work it named the view plan, about 500 ms, and of the
main thread's the view's support evaluation. This round committed two
changes to those costs and followed the vote again to see what they bought.

## How it was measured

The arms are the earlier records'. `flag` is the serving loop in the worker
with the store read-through on, the overlap off, the flush deadline growing
to a 1000 ms cap, and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. Every
run used a toolshed and shell built from source in a scratch worktree, on a
four-core container.

The probe is the earlier record's `probe-read-scale.ts`, kept out of the
tree: the read-scale fixture at 296 votes, one warmed viewer, eight timed
votes, and each realm's timing statistics diffed around them. Its CPU runs
profile the serving worker, the toolshed's main thread and the browser's
runtime worker over the same eight votes. `after6` is the scratch tree
before either change, `after7` carries the first, and `after8` both.

## Two changes, and the vote's time

**The planner's read index, by producer** (`5c5158656`). A view selection's
read index was rebuilt whole on every plan. It is now held in parts, one per
selected producer, and a part whose lists recur keeps its place; each
producer's sorted write surface and basis reads are kept by the observation
they came from. The render walk keys its reads by string rather than through
a path map built per walk.

**The selection's resolve, over what it adds** (`1e79296c3`). The memory
server resolved every root of a new selection before accepting it. It now
resolves only the roots the view's installed selection does not deliver.

| Per vote | `after6` | `after7` | `after8` |
| --- | ---: | ---: | ---: |
| Serving worker's plan | 531 ms | 428 ms | 307 ms |
| Serving worker's render | 130 ms | 22 ms | 21 ms |
| Serving worker's publish, all waves | 550 ms | 441 ms | 320 ms |
| Serving worker's wait on `setViewSelection` | 170 ms | 174 ms | 66 ms |
| Main thread's `setViewSelection` | 147 ms | 146 ms | 41 ms |
| Timed votes | 1.13 to 1.28 s | 1.11 to 1.51 s | 0.96 to 1.69 s |

In the CPU runs over the same eight votes, the main thread's resolve inside
`setViewSelection` fell from 1,068 ms to 6 ms, and its support
re-evaluation rose from 544 ms to 1,056 ms: the re-evaluation now resolves
cold what the selection's resolve used to warm. The main thread did about
0.5 s less over the eight votes.

Both changes did what they were for, and neither moved the vote.

## Every vote swaps two of the selection's roots

A probe-only log in `setViewSelection` printed what each replacing selection
dropped and added. At 296 votes the view's delivery holds about 3,269 roots,
and every vote swaps two of them: the space-scoped document the previous vote
added gives way to a new one, and one user-scoped document gives way to
another, the two alternating from vote to vote. A selection that drops a
root has the next pass refresh the session's demand graphs by its dirty
batch, as any pass does, and then rebuild its support graphs from every root
the selection holds, so each vote pays a support evaluation over all 3,269.

## The browser is the vote's critical path

From the click, the serving loop admits the vote in 180 to 390 ms and the
watermark covers it at 615 to 760 ms; the button turns bold at 1,069 to
1,249 ms. That last stretch, about 450 to 500 ms, did not shrink when the
plan and render lost about 210 ms between them.

The browser's runtime worker was busy about 8.6 s of the 14.9 s profiled,
about a second a vote. Per vote it ran 83 scheduler runs, 42 of them
committing, at about 8 ms each. Its largest self times were the proofs of
producers whose server results it adopts:

| Frame | Self time, eight votes |
| --- | ---: |
| `observeViewInput` | 724 ms |
| `hasLocalDocumentCoverage` | 562 ms |
| `ViewInputBasisCache.matches` | 433 ms |
| `forEachOverlappingWriter` | 364 ms |
| The producer check (`check`) | 297 ms |
| `#visibleVersion` | 281 ms |

Most of it comes from one chain: each local transaction's read validation
(`validateLocalReadBasis`) proves every producer of what it read, through
every entry of that producer's basis, with a memo that lasts only as long as
the transaction. So each of a vote's 42 committing runs re-observes the
basis documents the last one observed, though few of them changed.

## What remains

- **The browser's repeated proofs.** A basis entry whose document is the
  same deep-frozen version it was last observed in cannot observe anything
  different, and the replica hands back one such object per version. A
  check that answered from that alone would leave each run's proofs the
  coverage and document lookups.
- **The support rebuild on a swapped root.** Two dropped roots of 3,269
  rebuild every support graph. Extending the graphs for the added roots and
  leaving the dropped roots' documents delivered until a fuller change would
  make a vote's support work its own size, at the cost of delivering the
  documents only a dropped root reached for a while longer.
- **The route to the server.** Nothing measures inside the 180 to 390 ms
  from the click to the vote reaching the serving loop.
