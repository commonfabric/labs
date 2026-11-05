---
status: historical
created: 2026-10-22
archived: 2026-10-22
reason: "What a short wave costs the served vote burst beyond its commit, read off the census capture bucketed by wave: one event per wave, cascades split over three waves, a flush pass, five walks, nine frames and five client integrations per extra wave, and no re-run; and the first measurement of the flush deadline that grows after a cut settle."
---

# What a short wave costs: the served vote's cascade, cut at the deadline

The [work census](2026-10-21-served-vote-work-census.md) counted one vote
burst on each arm and found that 25 votes became 68 waves on the main-thread
arm and 31 in the worker, almost all cut at the flush deadline. This record
reads the same capture by wave, to say what a cut costs beyond the commit it
forces, whether anything runs twice because of it, and what a longer wave
would collapse. It then measures the change the reading selects: a flush
deadline that grows after a settle it cut.

## How the waves were read

The census capture holds every logger span of the main-thread arm's realm
with its occurrence detail, and every serving-side span sits inside the
`executor/wave/cycle` span of its wave, so the containment forest buckets
the burst by wave: the handler runs, scheduler runs, action runs and
resubscriptions each wave did, and the flush pass and frames the memory
server did inside it. The scheduler's `scheduler/execute` span for an event
outlives the wave that drained it, so the cycle that follows nests inside it:
that is the cut made visible. The worker arm's serving realm reached the
census only as statistics, so the per-wave rows are the main-thread arm's,
first captured burst (10.7 s with measures emitted; the durations are
diagnostic, the counts are the data).

## One event per wave, and the cascade over three

Of 71 cycles, 25 ran a handler, one each, and 46 ran none. The loop never
took two events in one wave. The drain queues every pending event, the
serving scheduler runs them one at a time, and a vote's cascade is 19 to 30
node runs at 6.8 ms each, about 180 ms of scheduler work before any fan-out:
past the 100 ms deadline before the first settle probe, so every settle was
cut (67 of 68 exhausted), the wave committed what it had, the still-queued
copies were purged for the next drain (`lt1LeftoversPurged`), and the next
cycle continued the cascade. A vote's `scheduler/execute` span is about 400
ms, and they run back to back: 25 of them are the burst.

| waves | count | cycle ms, sum | action runs | distinct actions |
| --- | --- | --- | --- | --- |
| with a handler run | 25 | 3,852 | 313 | — |
| continuation, no new event | 46 | 6,712 | 545 | — |

Nothing ran twice because of the cut. Seven actions appeared in two
consecutive waves, three of them in a continuation wave; the rest of a
continuation wave's runs are the cascade's later nodes, which the cut
deferred rather than repeated.

## What a wave costs beyond its commit

Spans present in nearly every wave, with their mean per wave:

| span | per wave | ms per wave |
| --- | --- | --- |
| `executor/wave/settle` | 1.0 | 129 |
| `scheduler/run` (node runs) | 9.3 | 63 |
| `send/encode` (frames) | 8.8 | 49, asynchronous and overlapping |
| `memory/flush/refresh` (a flush pass) | 1.0 | 36 |
| `memory/refresh/session/touched` (session walks) | 4.6 | 32 |
| `memory/query/root` | 255 | 25 |
| `executor/wave/commit` | 1.0 | 12 |
| `scheduler/run/resubscribe` | 21 | 9 |
| `executor/wave/drain` | 1.0 | 4 |

So a wave carries about 63 ms of scheduler runs and about 100 ms of
machinery: the commit, the flush pass the commit causes with its 4.6 session
walks and 255 root evaluations, the 8.8 frames, and the drain. On this arm
the flush pass for wave N runs inside wave N+1's settle, since one thread
does both, so a continuation wave's 127 ms settle is 62 ms of runs and 48 ms
of the previous wave's fan-out. On the client side each wave's frame is an
`integrate` notification: on the worker arm, whose trigger traces were not
truncated, 5.7 notifications per wave per client re-triggered 17 client
actions, so a wave costs the five clients about 85 action runs.

Across the 46 continuation waves that is roughly 2.8 s of main-thread
fan-out, about 400 frames and about 3,900 client action runs that exist
because cascades were cut, against a scheduler-run total of 4.5 s, a flush
total of 2.6 s, commits of 0.9 s and encode of 3.5 s per burst.

## What a longer wave would collapse

| waves an action ran in | actions |
| --- | --- |
| 1 | 50 |
| 3 or 4 | 30 |
| 5 | 61 |
| 7 to 14 | 6 |
| 20 to 23 | 7 |

The 61 actions that ran in exactly five waves are the per-option tally chain,
once per vote on their option; the seven that ran in 20 to 23 are the global
vote-list and ranking lifts, once per vote; `formatRank` ran 10 to 14 times.
With every queued vote drained into one wave before it settles, those chains
run once per batch: the 658 node runs of a burst would fall toward about 350,
since the eight handler-adjacent lifts legitimately run 25 times, and the
commits, passes, frames and client integrations would fall from 68 toward a
handful. The worker arm already shows the direction: 31 waves for the same 25
votes, its cascades not interleaved with the memory server's passes.

## The change: a deadline that grows after a cut

The deadline bounds how long a consequence waits to become visible, and
clients already show their own vote locally, so what a short wave buys in a
burst is only the earlier arrival of partial results on other machines, at
the cost above. The change keeps the bound for the first consequence and
relaxes it for the cascade behind it: a settle the deadline cut hands the
next cycle a deadline twice as long, up to a cap
(`SpaceServerPolicy.flushDeadlineMaxMs`,
`SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS`), and a settle that reaches
quiescence, or a loop that finds no work, hands it the base again. A settle
drains events once, as its wave opens (the re-drain inside a settle runs only
after an in-flight predecessor commit finishes, which only the overlap arm
has), so an event arriving while a longer settle runs waits for the next
cycle; what a longer wave buys is that the next drain then finds several
events waiting and one wave carries them all. With no cap set nothing
changes. `executor-sustained-input.test.ts` pins the shape: twice
the one before, never past the cap, the base again after quiescence.

## The measurement: one burst with a 1000 ms cap

The census probe and the browser benchmark ran again with
`SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS=1000` over the base 100 ms deadline,
on both served arms, in the same container and on the same commit as the
census's captures, so each row below compares against the census's own
count. The probe carries the timing measures and so runs slower than the
benchmark, which carries none.

| Count, one burst of 25 votes | main | main, cap 1000 | worker | worker, cap 1000 |
| --- | ---: | ---: | ---: | ---: |
| Probe burst | 10.7 s | 4.8 s | 8.1 s | 4.7 s |
| Waves (cut at the deadline) | 68 (67) | 8 (6) | 31 (28) | 7 (4) |
| Flush passes | 76 | 17 | 39 | 15 |
| Session walks | 330 | 75 | 185 | 60 |
| Root evaluations | 18,124 | 10,206 | — | — |
| Frames encoded | 660 | 202 | 439 | 186 |
| Serving scheduler runs | 858 | 888 | — | — |
| Client scheduler runs, each of five clients | 643 | 315 | 581 | 357 |
| Client traversals, each client | 405 | 216 | 373 | 238 |

The worker arm's scheduler runs in the worker, outside the probe's
main-thread trace, which is why its two rows are blank.

The counts move the way the reading predicted. Twenty-five votes become eight
waves on the main thread rather than 68, about three votes to a wave: the
votes that arrive while a longer settle runs are drained together when the
next wave opens. Everything priced per wave falls
with the wave count — flush passes 76 to 17, walks 330 to 75, frames 660 to
202 — and each client runs half as many actions and traverses half as often,
because it integrates eight commits rather than 68. The one count that does
not move is the serving scheduler's own runs, 858 to 888: a wave carries the
several events its drain found, but the scheduler still derives from each
one as it is dispatched, so a handler-adjacent lift that three votes reach
runs three times within the same wave. Longer waves collapse the fan-out machinery around a
run and leave the runs themselves to the next removal.

The browser benchmark's headline follows the counts:

| `vote burst 5x5`, median of its rounds | without cap | cap 1000 |
| --- | ---: | ---: |
| Main thread, first pair | 5.8 s | 4.7 s |
| Main thread, second pair | 6.0 s | 4.8 s |
| Worker | 4.6 s | 4.1 s |

Its serving-side row reports the same wave counts the probe does without the
measures on: 46 and 41 waves on the main thread without the cap against 8
with it, 22 against 7 in the worker, with the settle lengthening from
113 ms × 47 to 432 ms × 9 on the main thread. The two arms end within a few
tenths of a second of each other with the cap on, where without it the worker
led by over a second: the main thread's deficit was mostly the waves the
memory server's passes interleaved into its cascades, and the cap removes
most of them.

What the cap does not do is make a vote appear sooner on another machine. A
burst's first consequence still ships within the base deadline; every later
one waits up to a second for its wave. That is the trade the reading
accepted, and the one a default cap has to be chosen against: the registry
entry for the knob names the seed as the second workload to count before
picking one.
