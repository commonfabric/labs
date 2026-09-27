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
| timing workload | a scratch script: a watched map of 10,752 entries `{ person, fallbackName }` of strings, rewritten whole by `cell.withTx(tx).set(map)` under `runtime.editWithRetry()` with one entry's `fallbackName` changed, on `runtimePresets.unitTest` over an emulated server; the echo arm strips the patch replay capability from the server's `hello.ok`, so the same build declares no base |
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
it will replay over (`replayBaseSeq`), and does so only where its replica holds
that document as the server stores it, no pending layer of its own sits
beneath, and the server advertises the `PATCH_SEMANTICS_VERSION` the writer
was built with. The engine compares it with the head before writing and
reports a match on the revision; the server elides such a head from the
writer's frame, as it elides an own `set` head, while the snapshot it last sent
that session of the document is still at that base. The comparison is atomic
with the apply, and the session check reads the server's own record, so
nothing the client reports about its delivery history has to be trusted;
`09-invariants.md` INV-15 states the whole contract.

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

## What adversarial review changed before landing

Four reviews, each arguing one case against the change, ran over the branch
once it first passed CI. One found a divergence and the others found what the
change would have cost later; the branch took the following before landing.

- **A retracted base.** A document a watch change retracted from the session
  between an exact commit and its flush, and a second commit linked back in
  within that flush, was elided although the session no longer held the base,
  and nothing sent it again. Reproduced against the server. The elision now
  also requires the snapshot the server last sent the session to be at the
  declared base.
- **Patch semantics across builds.** Eliding the echo removes the correction
  every own patch commit used to carry, and a client's replay equals the
  server's only while both apply patches the same way. Clients deploy apart
  from servers, and what `applyPatch()` produces had changed at least four
  times in the preceding five months. The capability became a version,
  `PATCH_SEMANTICS_VERSION`, recorded against a corpus of every operation kind
  and the `valueEqual()` cases it decides.
- **No lever and no signal.** Nothing could switch the elision off short of
  switching off every own-write echo, and nothing counted it.
  `CF_MEMORY_PATCH_REPLAY=off` restores the echo for every session at once,
  `ct.memory.sync.own_patch_heads` counts own patch heads by outcome, and a
  replica warns when a head reported exact does not replay to the server's
  document.
- **Key order.** The flag claiming the promoted value was the server's
  document exactly was false in key order: the codec delivers keys in
  canonical order, and a replay keeps the order its own operations inserted
  them in, including inside object values a patch carries. The flag now claims
  equality as a value, which is what the elision needs.

The review also measured the value more carefully than the timing above. A
second A/B at 10,752 string entries put the gap at 220 to 314 ms per round,
larger than above, but part of that is the differential's value comparison
against the echo, which the separate whole-document-passes change removes with
no protocol change. Timed stage by stage, the echo's own share is the server's
encode and the client's decode and freeze: about 26 to 60 ms per commit for
string values and about 250 ms for link values. Its clearest beneficiary is a
writer that rewrites a large link map in sequence and awaits each commit, such
as a daemon's index; a writer whose commits are still pending when the next is
built names no base, and in a simulation of unawaited commits 50 to 200 ms apart
one patch in ten named one.

## What is left

- A patch built while an earlier own patch of the same document is still
  pending names no base, so pipelined edits to one document are echoed whole,
  which is most edits from a writer that does not await its commits.
- The first patch after an own `set` of the document names no base, because
  the set's promotion is the replica's own value rather than a delivered one.
- The transact response to an own `set` carries the whole document back in
  its revision, which the writer decodes and never reads.
- On the counting workload the process still froze about six containers per
  entry per commit: CFC canonicalization at commit (8,003 at 2,000 entries)
  and the sink's schema traversal of the map (4,000).
