---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Why the local reads of one transaction share one producer check under view-scoped replication, rather than each read proving its producers afresh: in a CPU profile of rendered lunch votes at 296 votes, the producer checks, made for every read and again for each validation pass, took about 620 ms of the browser's runtime worker a vote, 340 ms of it under the reads' own checks, and sharing them across a transaction's reads cut authored code's time per vote from 24 × 14.8 ms to 24.5 × 5.8 ms, while the vote's own time did not move. Measured on the served-vote branch (#9122) before the change was split out to land on its own."
---

# One producer check for a transaction's local reads

This change was made and measured on the served-vote branch
(commonfabric/labs#9122), and split out of it to land on its own, after the
[proof pass per wake](2026-10-23-view-scoped-proof-pass-per-wake.md) it builds
on. The code is the same on both.

## How it was measured

On #9122's branch, at `b21ced957` against its parent `9b43b92c3`, on the arm
the proof pass's record describes: the serving loop in a worker, the store
read-through on, the overlap off, the flush deadline growing to a 1000 ms cap,
and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. The same probe seeded the
lunch poll's read-scale fixture at 296 votes and diffed the browser runtime
worker's timing statistics around its timed votes, four on the parent and eight
on the change. A figure written `n × t` is a run's difference divided by its
votes: `n` calls of a row a vote, `t` ms each on average.

The other instrument is a CPU profile of the browser's runtime worker, sampled
every 250 µs over a run's timed votes: four votes at `3f7822bb6`, a commit
before the parent, and eight on the change. Sampling slows the worker, so a
profile's times run above those of the unprofiled runs.

## What the reads cost

Under view-scoped replication a web client checks every local read: the read's
producers must be current, by the server's proof or by a completed local run.
The check behind each read was made fresh for that read, so a transaction that
read a hundred addresses proved the same producers a hundred times, and each
validation pass of its commit proved them again. In the profile at
`3f7822bb6` the producer check took about 620 ms a vote, inclusive: about
340 ms under the reads' own checks (`assertLocalReadAvailable`) and 280 ms under
the validation passes (`validateLocalReadBasis`).

## The change

The reads of one transaction share one check, made at the first read. Each
validation pass still makes its own, so a read let through before its
producers' state changed still fails the transaction before it can seal.
Within a check, the producers writing a basis read are found once. The view
nodes the check looks producers up in are indexed by space once per change to
the scheduler's active nodes, where they were collected from every node for
each action run.

## Measured

| Per vote, in the browser's runtime worker | Before | After |
| --- | ---: | ---: |
| Scheduler execution | 6.25 × 143 ms | 6.4 × 115 ms |
| Authored code's time, which the per-read checks ran inside | 24 × 14.8 ms | 24.5 × 5.8 ms |
| A vote end to end, a run's mean | 1.37 s | 1.35 s |

The profile over eight votes on the change, which also carries `9b43b92c3`, put
the producer check at about 380 ms a vote: 70 ms under the reads' own checks,
where the earlier profile had 340, and 310 ms under the validation passes, each
of which still makes its own check.

The vote did not move with the browser's work, so that work was not what one
vote waited on at this commit. The change is kept for the browser's CPU it
returns.
