---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measurement snapshot; the durable statement is in docs/features/mergeable-collection-writes.md."
---

# What a derived reader over a collection costs

Measurements taken on 2026-09-04 with
`packages/patterns/integration/storm-driver.ts` against the five
`convergence-chat` fixtures beside it, three sessions on the in-process storage
server, one developer machine. "Refusals" counts commits the server rejected,
summed across all three sessions and read back through
`MultiRuntimeSession.rejections()`.

Two sessions post, one only observes. Each writer posts with `idle: false`, so
its sends stack into a pipeline rather than settling one at a time. A post is
`messages.push(...)`, which records a mergeable `append` and drops its own read
of the array.

## The five fixtures differ by one factor each

| Fixture | Message carries a link | Link scope | Link required | Derived reader over the list |
| --- | --- | --- | --- | --- |
| `convergence-chat-plain` | no | — | — | no |
| `convergence-chat-optlink` | yes | per-user | no | no |
| `convergence-chat-noderived` | yes | per-user | yes | no |
| `convergence-chat-spacelink` | yes | per-space | yes | no |
| `convergence-chat` | yes | per-user | no | yes |

`convergence-chat` and `convergence-chat-optlink` differ by nothing but the
derived readers, which makes that pair a single-factor comparison.

## Twenty posts each from two writers

| Fixture | Refusals |
| --- | --- |
| `convergence-chat-plain` | 0 |
| `convergence-chat-optlink` | 0 |
| `convergence-chat-noderived` | 0 |
| `convergence-chat-spacelink` | 0 |
| `convergence-chat` | 34 |

Every refusal in the last row wrote a `computed:` document and nothing else,
and every one was a root conflict — no cascades. Almost all named the messages
list as the document that had gone stale. Neither the presence of a link on
each message, nor its scope, nor whether it is required moved the count off
zero.

## The cost tracks concurrent writers, not writes

Forty posts in every row.

| Writers | Sends | Refusals |
| --- | --- | --- |
| 1 | pipelined | 0 |
| 2 | settled one at a time | 4 |
| 2 | pipelined | 34 |

Forty posts from one session cost nothing however deep the pipeline. The same
forty from two sessions cost thirty-four.

## Every session pays, including the one that never writes

Across the runs above the observer's share was within one or two of each
writer's — it posts nothing, holds the same derivation, and its commit of the
memoized result is a compare-and-set over a list two other sessions are
writing.

## Growth is linear in posts, not in list length

| Posts | Refusals |
| --- | --- |
| 20 | 18 |
| 40 | 33 |
| 80 | 64 |

Doubling the posts doubles the refusals while also doubling the list's length.
Cost proportional to posts times length would have quadrupled each step, so
the length is not what the cost tracks.

## The writer side is deterministic; the reader side is not

Five runs of each, twenty posts each from two writers:

| Fixture | Refusals per run |
| --- | --- |
| `convergence-chat-plain` | 0, 0, 0, 0, 0 |
| `convergence-chat` | 7, 39, 2, 12, 9 |

An order of magnitude of spread on identical input. A test that asserts on a
count of rolled-back writes is asserting on that spread. What is stable is
which documents a refused commit contended for, which is what a test can
usefully require.

## What this does not say

The five fixtures are one pattern shape: an append-only list of small records,
three sessions, one derivation. Nothing here measures a keyed collection, a
larger session count, or a derivation whose output is expensive to recompute
rather than merely contended.

`packages/patterns/integration/convergence-storm.test.ts` drives this fixture.
When these measurements were taken it asserted convergence and nothing else,
so nothing in continuous integration observed the refusals above.
