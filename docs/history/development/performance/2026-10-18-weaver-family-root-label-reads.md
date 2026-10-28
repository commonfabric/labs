---
status: historical
created: 2026-10-18
archived: 2026-10-18
reason: "Investigation findings: where a Weaver family root's 65-second label reads spend their time, measured on the installed Weaver and on the same workload in Chrome."
---

# Where a Weaver family root's label reads spend their time

The Weaver's pattern family root runs one runtime worker for the FabriChat
manager and every room it links to: on 2026-10-18 that worker held 21,500 to
27,100 documents across 93 spaces, with 1,142 cell subscriptions open from the
Weaver's link subscriptions (`fabrichat-link:<room>` with the message demand
and the authorship paths `{"author":["authorProfile"],"value":["body"]}`).
The Weaver's own diagnostics recorded `cell:getCfcLabel` round trips of 65 s
median during load bursts. This record says what those seconds are.

All figures are from one Mac (M3 Max). The Weaver figures are read from the
installed Weaver's family root through its gateway (`/debug-eval` on the root
pane, `getLoggerCounts()`), generation 2 of the family after a relaunch, and
from the Weaver's `events.jsonl` over the preceding day. The Chrome figures
are from headless Chrome 155 (V8) opening `/pattern-family` against the same
daemon with the same manager and rooms, the two heavy rooms subscribed by the
room demand, and the 29 latest messages subscribed by link with authorship
plus their 7 author profiles, scripted the way the Weaver's root does it.

## The round trip is queueing, not reading

The Weaver measures a request from the post to the worker until the reply
(`pattern.rpc.end`, `durationMs`). Over 4,951 label reads in the day's log:

| operation           | count | p50    | p90    | max     |
| ------------------- | ----- | ------ | ------ | ------- |
| `cell:getCfcLabel`  | 4,951 | 6.3 s  | 36.5 s | 301.5 s |
| `cell:get`          | 4,266 | 4.2 s  | 22.8 s | 197.8 s |
| `cell:resolveAsCell`| 3,920 | 2.8 s  | 16.5 s | 143.5 s |

4,725 of the 4,951 label reads ended within the same 100 ms as another one:
the replies come out in bursts, which is what a queue draining looks like.

The worker splits the same round trip into the time the message waited in
the worker's inbox (`delivery`, from the main thread's send stamp to the
worker's receipt) and the handler's own time (`handle`). From the live root:

| key                                | count | p50    | p95    | max    | total   |
| ---------------------------------- | ----- | ------ | ------ | ------ | ------- |
| `handle/cell:getCfcLabel`          | 1,393 | 3 ms   | 12 ms  | 814 ms | 7.4 s   |
| `delivery/cell:getCfcLabel`        | 1,163 | 666 ms | 15.6 s | 29.3 s | 3,365 s |
| `handle/cell:get`                  | 495   | 8 ms   | 31 ms  | 335 ms | 6.0 s   |
| `delivery/cell:get`                | 491   | 1.0 s  | 7.7 s  | 9.7 s  | 1,137 s |
| `handle/cell:subscribe`            | 1,319 | 4 ms   | 66 ms  | 345 ms | 16.4 s  |
| `delivery/cell:subscribe`          | 1,313 | 2.0 s  | 6.5 s  | 11.6 s | 3,304 s |
| `runtime-client.cfc-label/total`   | 1,393 | 3 ms   | 12 ms  | 814 ms | 7.2 s   |

A label read is handled in 3 ms. What a label read waits for is the inbox:
the delivery row's total is 450 times the handler's. The 65 s median was
read from an older generation of the root during a load burst, through the
Weaver's round-trip rows; the generation read here is younger and its longest
inbox wait is 29.3 s, with the loop's own lag counter
(`runner.loop/workerLag`, 1,078 samples) recording single stalls of 76.3 s,
67.5 s and 49.0 s, 267 s in all. A request posted at the start of such a
stall waits the whole of it.

## What holds the loop

The worker's timing rows name the long synchronous work only partly.
`extended-storage-transaction/prepareCfc` (3,222 transactions, p50 2 ms,
p95 78 ms) recorded 101.2 s, 79.2 s and 79.1 s for three transactions; the
two 79 s preparations ended 53 ms apart, so they ran interleaved through the
cooperative form and their time includes yields. `scheduler/execute` (108
passes) recorded 31.2 s, 26.4 s and 18.6 s. Counters at the time:
4,228 cfc-relevant transactions, 177,618 overlap queries, 116,258
dereference traces, 4,087 immutable snapshots, 82 pending and 38 in-flight
commits.

No CPU profile of the WebKit worker was taken; the attribution below is the
same workload on V8, where the same shape appears at a fraction of the
length. The Chrome worker reached 18,771 documents, 93 spaces, 12,112
scheduler nodes, 6,478 transactions, 153,029 overlap queries and 111,167
dereference traces, with a 973 MB heap; its `prepareCfc` maximum was 1.33 s
(1,811 transactions), `scheduler/execute` 5.5 s (319 passes) and `workerLag`
11.0 s (1,221 samples, 76.7 s in all).

A V8 CPU profile over the message-and-authorship burst (187 s wall, 62.2 s
busy, 7.6 s garbage collection, 506 synchronous tasks of which 14 ran over
one second, 35.9 s between them) has these as its longest tasks:

| task   | what it was                                                                                  |
| ------ | -------------------------------------------------------------------------------------------- |
| 5.93 s | the render reconciler's sink reads (`subscribeToReferencedDocs`), one transaction per sink    |
| 5.14 s | a scheduler settle running pattern actions                                                   |
| 4.30 s | sink reads again                                                                             |
| 3.51 s | a session-sync frame validating arrived schema documents (`internSchema`, 1.41 s of hashing)  |
| 2.65 s | loading and evaluating a room's module graph                                                 |
| 2.43 s | the source reconciler's commit, `prepareCfc` 1.26 s of it                                    |

Self time, by function, over the whole profile:

| self    | share of busy | function                                                        |
| ------- | ------------- | --------------------------------------------------------------- |
| 7.55 s  | 12.1%         | garbage collector                                               |
| 4.41 s  | 7.1%          | `Runtime.#moduleDelegationSnapshot` (one deep copy per transaction) |
| 1.35 s  | 2.2%          | `setCfcModuleDelegations`                                       |
| 1.46 s  | 2.3%          | `Scheduler.#clearBackoffForCleanNodes` (every node, every pass) |
| 1.13 s  | 1.8%          | `resolveLinkTracingDereferences`                                |
| 0.89 s  | 1.4%          | `V2Transaction.read`                                            |
| 0.85 s  | 1.4%          | `label-view-core` view building                                 |
| 0.71 s  | 1.1%          | `parseWireText`                                                 |
| 0.66 s  | 1.1%          | `sortAndCompactPaths`                                           |
| ~6 s    | ~10%          | SHA-256 (the `@noble/hashes` chunk), across digests, schema interning and trace keys |

Inclusive: opening a transaction (`Runtime.edit`) is 6.14 s of the 62.2 s
busy, and 4.15 s of that is `readTx`, the throwaway read transactions a read
of a cell bound to no transaction opens. The sink's own child transaction is
1.28 s of it; the label view's three transactions (`storedMetadataForCell`
0.46 s, `followedLabelViewsForCell` 0.40 s, `resolvedMetadataForCell` 0.08 s)
are 0.94 s. `prepareBoundaryCommitSteps` is 6.30 s inclusive, `internSchema`
4.93 s, `validateAndTransform` 5.10 s, `createViewProxy` 4.88 s.

## What a transaction keeps while it lives

A sampling heap profile of the idle Chrome worker after the burst (868.7 MB
live) attributes the largest live allocations to: SHA-256 state 92.7 MB and
67.5 MB (the latter under `recordCfcDereferenceTrace`), `setCfcModuleDelegations`
83.6 MB (the per-transaction delegation copies of transactions still alive),
`parseWireText` 80.9 MB and `#decodePlainObject` 73.9 MB (documents),
`consumed-label-index` 62.7 MB (the prepare pass's read index), the
`ExtendedStorageTransaction` constructor 28.8 MB, `applyActionReadDeltaToMap`
21.6 MB, `#buildPreparedDigestInput` 13.6 MB. So a transaction that is alive,
whether running or awaiting its commit, holds its delegation copy, its
consumed-label index, its digest input and its traces; the throwaway read
transactions a label read opens hold theirs only until the read returns.

## What this changed

A label read of a cell bound to no transaction (every IPC label read, every
outbound cell ref's view, the display-fit reads) opened a transaction for
each read it joins: one for the cell's own stored labels and one for the
labels along the links the path follows, two for the plain read
(`cfcLabelViewForCell`), and a third for the labels of the document the path
resolves to in the resolved read (`cfcLabelViewForResolvedCell`), each with
its own delegation copy and an empty resolution memo, so the resolved read
resolved the link twice. `label-view.ts` now resolves the transaction
once per read and the three reads share it; a cell bound to a live
transaction already read through that one and still opens none
(`cfc-label-view-transactions.test.ts`).

Timed on V8 against a runtime with one space and 300 linked, labeled rows,
reading all 300 per round, median of seven rounds:

| read                          | before            | after            |
| ----------------------------- | ----------------- | ---------------- |
| resolved label read, no tx    | 14.0 ms, 900 tx   | 8.6 ms, 300 tx   |
| label read, no tx             | 7.0 ms, 600 tx    | 6.2 ms, 300 tx   |

With one space the delegation copy is small; on the family root's 93 spaces
each transaction's copy is the largest allocation a label read makes, so the
saving there is two copies per read.

## Left as found

- The per-transaction delegation copy (`#moduleDelegationSnapshot`) is the
  largest single self-time entry and live-bytes entry attributable to one
  function; it is being memoized separately.
- `#clearBackoffForCleanNodes` walks every scheduler node at the end of
  every execute pass (12,112 nodes, 319 passes here); a set of nodes that
  hold a backoff would make it proportional to those.
- Schema interning hashes every arrived schema document per session-sync
  frame (`#validateArrivedSchemaDocuments`), 4.93 s inclusive here.
- `prepareCfc`'s digest and the dereference-trace keys account for most of
  the SHA-256 time.
