---
status: historical
created: 2026-09-26
archived: 2026-09-26
reason: "Investigation findings: what the memory server's echo of a writer's own patch cost, what eliding it measured, and the two designs ruled out."
---

# Eliding the echo of a writer's own patch

The memory server sent a session the whole post-apply document for every
patch that session committed to a document it watched. A commit that changed
one entry of a large map therefore made the server encode the map and the
writer decode and deep-freeze it, in proportion to the map rather than the
edit. This pass measured that cost, elided the echo where the writer provably
reproduces the document, and recorded the designs that do not work.

## What was measured, against what

| | |
| --- | --- |
| labs | `a2476d9e35` (main) and this change |
| counting workload | `packages/runner/test/own-write-echo-cost.test.ts` as first written: a watched map of `N` records `{ label, nested: { id } }` on a shared in-process server, one entry's `label` changed through a transaction, every message the server sent the writer captured before the loopback encoded it, and `Object.freeze` counted across the process |
| timing workload | a scratch script: a watched map of 10,752 entries `{ person, fallbackName }` of strings, rewritten whole by `cell.withTx(tx).set(map)` under `runtime.editWithRetry()` with one entry's `fallbackName` changed, on `runtimePresets.unitTest` over an emulated server; the echo arm strips `patchBaseSeq` from the server's `hello.ok`, so the same build declares no base |
| timing | process CPU per commit (`process.cpuUsage()`), which includes the in-process server; arms interleaved over three rounds, first commit of each run dropped, eleven commits per arm per round |
| machine | an M-series laptop at a load average of 76 to 160 from other work, including this change's own type check and test runs; wall-clock is not reported |

## Where the echo's cost was

At 2,000 entries, one entry changed:

| | documents sent to the writer | bytes of them | containers frozen in the process |
| --- | ---: | ---: | ---: |
| echo, 20 entries | 1 | 1,006 | 363 |
| echo, 2,000 entries | 1 | 110,686 | 24,123 |
| echo switched off, 2,000 entries | 0 | 0 | 12,113 |
| this change, 2,000 entries | 0 | 0 | 12,113 |

Attributing the echo arm's freezes by call stack put 12,005 of the 12,010
that the echo added in three places, each linear in the map: the JSON decode
of the frame (4,000), the deep freeze of the decoded document (4,000), and
hashing it (4,005). The echo-off arm is the server's kill switch, which elides
every own patch head whether or not the writer can reproduce it; this change
matches it exactly on this workload, and still delivers every head it cannot
prove the writer reproduces.

CPU per commit at 10,752 entries:

| arm | median | minimum | document bytes sent to the writer |
| --- | ---: | ---: | ---: |
| echo | 726 ms | 552 ms | 644,067 |
| this change | 618 ms | 490 ms | 0 |

The change measured lower in each of the three rounds (577 against 739,
627 against 654, 599 against 722 ms). The byte count is exact; the timing
difference is inside the noise of a machine this loaded and is recorded as
direction, not size.

## Why eliding it is sound where it is elided

The writer's accept promotes its pending layer by replaying that layer's
operations over the confirmed document it holds, with the same
`applyPatchToDocument()` the engine applies a stored patch with. The echo
exists for the case where the engine applied the patch over a head the writer
did not hold. So the writer now names, on the patch, the seq of the document
it will replay over, and does so only where its replica holds that document
exactly as the server stores it and no pending layer of its own sits beneath.
The engine compares it with the head before writing and reports a match on the
revision; the server elides such a head from the writer's frame as it elides
an own `set` head. The comparison is atomic with the apply, so nothing about
the session's delivery history has to be trusted.

## Ruled out

**The server inferring the base from its own delivery record.** Comparing the
pre-apply head with the seq the server last sent the session needs no wire
change, and is unsound. Three writers commit own patch heads through a bare
`session.transact` with no pending layer to promote: the runner's event-append
queue, delegated outbox delivery, and `applyOperation`. And the server's record
is of what it sent, not what the replica absorbed: schema-doc quarantine drops
an upsert the server recorded as delivered, a frame that fails to apply is
dropped with its documents, and a suppressed send commits the record anyway.
Today each of those gaps heals at the document's next delivery, and the echo
is one of those deliveries.

**An acknowledgement entry in the frame.** A doc-less upsert naming the
writer's commit would let the replica run the whole upsert bookkeeping for
the elided head. A doc-less upsert already means an absent document, so it
needs a new, explicitly marked variant that every consumer of frames learns,
where elision needs none.

**Declaring an exact promotion in the reconnect holdings.** The replica holds
the server's document at the promoted seq, so claiming it is sound, and it
saves one redundant re-delivery per document per reconnect. It also breaks the
rule that holdings come from delivered state alone, which is what lets a
reconnect heal a promotion that went wrong. The change keeps the rule.

## What is left

- A patch built while an earlier own patch of the same document is still
  pending names no base, so pipelined edits to one document are echoed whole.
- The first patch after an own `set` of the document names no base, because
  the set's promotion is the replica's own value rather than a delivered one.
- The transact response to an own `set` carries the whole document back in
  its revision, which the writer decodes and never reads.
- On the counting workload the process still froze about six containers per
  entry per commit: CFC canonicalization at commit (8,003 at 2,000 entries)
  and the sink's schema traversal of the map (4,000).
