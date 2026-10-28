---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "One rendered lunch vote with view-scoped replication on, followed through the browser's worker, the toolshed's main thread and the serving loop's worker: three changes took out repeated proofs in the browser and two full view evaluations per vote on the main thread, the vote's remaining time split into its route to the server, its settle and its route back, and the three goal benchmarks measured per arm afterwards."
---

# One served vote across three realms

The [read-through record](2026-10-22-served-chat-burst-event-view-under-read-through.md)
left the bursts close to the serving loop off and the single interactions
well behind it. On the benchmarks it had not yet measured, a single vote,
send or reaction read up to three times slower with the flag on, while whole
flows read faster. This round followed one vote on the lunch read-scale
fixture through every realm that handles it, took out what it found
repeating there, and then measured the three benchmarks the goal is stated
in: the vote burst, the chat send burst and the Topics navigation segments.

## How it was measured

The arms are the earlier records'. `flag` is the serving loop in the worker
with the store read-through on, the overlap off, the flush deadline growing
to a 1000 ms cap, and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. `off` is
the loop off. Every browser run used a toolshed and shell built from source
in a scratch worktree, one arm at a time, on a four-core container.

A probe, `probe-read-scale.ts`, is kept out of the tree like the earlier
probes. It seeds the read-scale fixture at 296 votes and warms one viewer.
Then it diffs three realms' timing statistics around four or eight timed
votes:

- the toolshed's main thread, through `/api/health/stats`;
- the serving loop's worker, through `/api/health/serving-loop-realm`;
- the browser's runtime worker, through `rt.getLoggerCounts()`.

From the stats response it also prints each vote's row of the serving loop's
settle series: the milliseconds from the vote's notice reaching the loop to
the wave whose watermark covers it, and how many waves that took. In its
last runs a probe-only stamp put each row in epoch time, so a row lines up
with the browser's click.

## The benchmarks not yet measured, per arm

At `172ce8769`:

| Benchmark | Segment or size | Loop off | Flag arm |
| --- | --- | ---: | ---: |
| `lunch-poll-read-scale` (one rendered vote) | 74 votes | 572.5 ms | 1.3 s |
| | 296 votes | 691.5 ms | 2.5 s |
| | 1184 votes | 1.6 s | 26.3 s |
| `fabrichat-room` | load | 491 ms | 592 ms |
| | sign in | 898 ms | 729 ms |
| | messages | 15.0 s | 10.8 s |
| | send | 1.0 s | 1.7 s |
| | react | 545 ms | 838 ms |
| | thread | 5.2 s | 2.7 s |
| | journey | 15.7 s | 12.2 s |
| `fabrichat-room-scale` | 10 messages | 8.1 s | 5.6 s |
| | send at 10 | 910 ms | 1.2 s |
| | 30 messages | 14.6 s | 10.0 s |
| | send at 30 | not reached | 1.6 s |

Loads and whole flows are faster with the flag on. One interaction is not.

## One vote, realm by realm

At 296 votes, one vote with the flag on took 1.8 to 4.6 s against 0.64 to
0.76 s with the loop off. Per vote:

- **The browser's worker** spent 5.25 × 267 ms applying frames and
  6.25 × 160 ms executing. Every accepted plan, and every change of local
  coverage, revalidated every adopted computation, and each proof walked its
  whole producer ancestry on its own before resubscribing the computation.
  The plan carried 973 producers with 8,478 read fingerprints.
- **The toolshed's main thread** ran two full evaluations of the session's
  view, each a walk of the whole lunch UI from its root at 340 to 490 ms. Two
  paths led there:
  - Each vote's selection drops two delivery roots and adds two: a new
    record, and a user-scoped document that alternates between two ids. A
    selection that dropped a root forced a full resync.
  - After each committed wave the serving loop flushes its space's sessions
    before it plans. When the memory server's own refresh turn had already
    sent that space's batch, the flush found none, and the refresh loop read
    the missing batch as one that dirtied everything.
- **The serving loop's worker** spent 400 to 900 ms planning the view. A
  third of that rebuilt one trigger index over every selected producer's
  reads, about ten thousand addresses.

## Three changes

**One proof pass per wake (`3f7822bb6`).** A wake proves each producer once,
matches each basis value once and checks each source once, for every adopted
node that reaches them. A node whose proof is unchanged keeps the
dependencies it installed. In the browser, per vote, applying frames went
from 1.4 s to 263 ms and execution from 1.0 s to 284 ms. The planner's cone
selection now indexes the visible edits by the entity they write, which took
its new 1000-row benchmark from 67 ms to 9.3 ms.

**Two full evaluations gone (`9b43b92c3`).** A selection that drops a
delivery root rebuilds only the view's support graphs, over the demand graphs
the session holds. A flush naming a space nothing dirtied returns without a
pass, since every write and every owed frame marks its space dirty. Per vote,
against a worktree with neither:

| Row | Before | After |
| --- | ---: | ---: |
| Main thread's refresh | 5 × 177 ms | 5.5 × 32 ms |
| Main thread's schema traversals | 2,128 | 331 |
| Serving loop's wave cycle | 4.75 × 355 ms | 4.25 × 247 ms |
| Timed votes | 1.2, 1.9, 1.7, 1.7 s | 1.4, 1.2, 1.6, 1.2 s |

**One producer check per transaction's reads (`b21ced957`).** Under
view-scoped replication every local read checks that the read's producers are
current. The check was made fresh for each read, so a transaction proved the
same producers once per address it read. The reads of a transaction now share
one check. Each validation pass still makes its own, so what a read let
through before its producers' state changed fails the transaction before it
seals. The browser's execution went from 6.25 × 143 ms to 6.4 × 115 ms per
vote, and the time authored code ran, which the checks ran inside, from
24 × 14.8 ms to 24.5 × 5.8 ms. The vote's end-to-end time did not move with
it: 1.37 s against 1.35 s over eight votes.

## Where one vote's time goes after them

With the three changes and an uncommitted change to the planner's selection
index, eight votes read 1.13 to 1.28 s. On the browser's clock, from the
click:

| Span | Time |
| --- | ---: |
| Click to the vote's notice reaching the serving loop | 240 to 480 ms |
| Notice to the wave whose watermark covers it, over 2 to 3 waves | 320 to 550 ms |
| Coverage to the voted button turning bold | about 430 ms |

Taking a fifth of the browser's execution out did not move a vote, so the
browser's CPU is not on its path. The first span holds the browser's dispatch, the append's
transaction on the main thread and the notice's crossing to the worker, and
nothing measures inside it yet. In the second, the deadline cut 1.1 settles
per vote; its base is 100 ms. The last span holds the flush, the frames and
the render, and the view plan runs after the flush, at 500 ms a vote.

## The goal benchmarks on `b21ced957`

Interleaved per arm, from a worktree at `b21ced957`:

| Benchmark | Loop off | Flag arm |
| --- | --- | --- |
| Vote burst, 5x5 | 2.9 s (2.6 to 3.5), 3.4 s (2.8 to 5.1) | 2.4 s (1.6 to 3.2), 2.5 s (1.9 to 3.0) |
| Chat send burst, 4x2 | 2.2 s (1.9 to 2.5), 2.0 s (1.6 to 2.3) | 3.1 s (2.6 to 4.2), 3.0 s (1.4 to 4.3) |
| Topics navigation, load | 443 ms | 439 ms |
| sign in | 694 ms | 583 ms |
| board | 1.7 s (1.5 to 2.1) | 2.6 s (2.4 to 2.7) |
| open topic | 1.0 s | 812 ms |
| crossref | 855 ms | 440 ms |
| comment | 447 ms | 513 ms |
| backlink | 819 ms | 739 ms |
| journey | 4.6 s (4.4 to 4.8) | 4.9 s (4.6 to 5.4) |

The vote burst is faster with the flag on. The chat send burst is slower by
about a second, and its iterations spread from 1.4 to 4.3 s. In Topics the
flag arm wins four segments and ties on load. It loses the comment by 66 ms
and the board by 0.9 s, more than the journey's whole 0.3 s gap. Each Topics
row is one run of the benchmark on its arm.

## What remains

- **The route to the server.** Nothing measures inside the 240 to 480 ms
  from the click to the vote's notice reaching the serving loop.
- **The plan after the flush.** The view plan takes about 500 ms a vote in
  the serving worker. A selection index per producer and the render walk's
  keyed aggregation are built in a scratch worktree, not yet committed or
  measured on a vote's end-to-end time.
- **The settle's cuts.** The flush deadline cut 1.1 settles per vote, from
  its 100 ms base.
- **The chat burst and the Topics board.** Both read slower with the flag
  on. The [chat record](2026-10-23-served-chat-burst-per-session-rows.md)
  follows the first.
