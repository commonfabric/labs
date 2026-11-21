---
status: historical
created: 2026-11-21
archived: 2026-11-21
reason: "Measurement of what a demand carried from another space costs the space it is carried into, against viewers who watch that space's pieces directly: a return, a change made while nobody was there, and a change while the viewers watch, and what the measurement changed."
---

# What a demand carried from another space costs the space it is carried into, November 2026

## Where this starts

A piece that reads another space's computed output is only as current as
that output. Step 5 of
[the plan for stored outputs across spaces](../../../plans/stored-output-currency-across-spaces.md)
has the reading space's serving loop carry its viewers' demand into the
space it read, so that the space runs the piece that derives the output,
for the viewer who needs it, though that viewer has no session there. This
record is that step's last item: what the carried demand costs the space
it is carried into.

## Method

`skills/perf-investigation/scripts/currency-carried-probe.ts` makes P
pieces in a source space, each with one output derived from its input once
for each viewer who demands it, and V viewers who hold READ on that space.
One `ExecutorHost` in the probe's process serves every space over a
loopback memory server, with the currency index in its `skip` mode. The
probe runs the same phases over two arrangements, each on a server and a
host of its own:

- **carried**: a reading space holds one piece for each source piece, whose
  argument is that piece's output. The viewers watch the reading pieces and
  have no session in the source space.
- **direct**: the viewers watch the source pieces themselves. This is what
  the source would do for the same viewers with nothing carried.

The phases:

- **build**: the pieces are made and every viewer views them once. Both
  spaces are then parked and the sessions removed.
- **return**: every viewer comes back in a new session, with nothing
  changed.
- **changed away**: every source piece's input changes while nobody is
  there, and every viewer comes back.
- **change**: one source piece's input changes while every viewer watches.

The loop runs on the probe's own thread, beside the clients and beside the
other space's loop, so the times say how the arrangements compare and not
what a toolshed's worker would take. Each row below is one run.

## A return with nothing changed

| Pieces | Viewers | Direct | Carried | Rows offered | Rows standing | Source pieces running | Source derived commits |
| -----: | ------: | -----: | ------: | -----------: | ------------: | --------------------: | ---------------------: |
|     10 |       2 | 0.12 s |  0.10 s |            0 |             0 |                     0 |                      0 |
|     10 |       8 | 0.42 s |  0.50 s |            0 |             0 |                     0 |                      0 |
|     40 |       4 | 1.01 s |  1.07 s |            0 |             0 |                     0 |                      0 |

Nothing is carried. The reading pieces stay unstarted, so their loop holds
no reads to offer, the memory server is handed no demand, and the source
space is not activated. What the phase costs is the reading space's own
judgment of its roots, the same as when the viewers watch the source
directly.

## A change made while nobody was there

Seconds until every viewer has read the new value from every piece:

| Pieces | Viewers | Direct | Carried | Rows offered | Rows standing, at most | Requests | Request time | Source derived commits, direct | Carried |
| -----: | ------: | -----: | ------: | -----------: | ---------------------: | -------: | -----------: | -----------------------------: | ------: |
|     10 |       2 | 2.23 s |  4.50 s |           70 |                     40 |        2 |       7.8 ms |                              7 |       3 |
|     10 |       8 | 2.49 s |  5.20 s |          192 |                    160 |        2 |       9.0 ms |                              7 |       3 |
|     40 |       4 | 4.77 s |  7.43 s |          554 |                    292 |        3 |      38.0 ms |                              7 |       6 |

The reading pieces are marked through the trigger and the pull, the loop
starts them, and it offers their reads of the source. Two rows stand in the
source for each viewer and piece: the viewer's own instance of the output,
and the piece the source's index records as writing it. The reading loop
sends its whole set two or three times in the phase, and the memory server
spends 8 to 38 ms admitting it, which is 0.05 to 0.11 ms a row offered.
That covers the access check on each row, the comparison with the source's
index, and the pull the reading space makes when it is not armed.

The source's loop starts each of its P pieces once, as it does for viewers
who watch them directly, and commits no more often.

The carried arrangement takes 2.3 to 2.7 s longer to deliver. It holds
twice the pieces: the reading space's P pieces start too, in a serving
tenure of their own. The direct arrangement shows what one fresh tenure
that starts ten pieces takes, 2.2 to 2.5 s, so the difference is the size
of a second tenure. The probe does not separate the second tenure from the
carrying.

Two counters grow with the carried arrangement:

| Pieces | Viewers | Records stored, direct | Carried | Store time, direct | Carried | Demand pass time, direct | Carried |
| -----: | ------: | ---------------------: | ------: | -----------------: | ------: | -----------------------: | ------: |
|     10 |       2 |                     20 |      45 |              19 ms |   74 ms |                   131 ms |  339 ms |
|     10 |       8 |                     21 |      60 |              46 ms |  234 ms |                   168 ms |  833 ms |
|     40 |       4 |                     53 |     268 |              68 ms |  778 ms |                   489 ms | 3092 ms |

A reading piece is recorded with one slice for each viewer, each holding a
read of that viewer's instance in the source, and storing a record
registers those reads with the source's index. The demand pass time is the
serving loop's counter summed over both spaces. It includes the starts of
the pieces, and a load in one space waits while the other space's loop
runs on the same thread, so it does not say which space spent it.

## A change while the viewers watch

Seconds from the change until every viewer reads the new value from the
piece whose input changed:

| Pieces | Viewers | Direct | Carried | Rows offered | Rows standing, at most | Triggers | Pulls |
| -----: | ------: | -----: | ------: | -----------: | ---------------------: | -------: | ----: |
|     10 |       2 | 0.04 s |  0.04 s |            0 |                      4 |        2 |     2 |
|     10 |       8 | 0.05 s |  0.10 s |            0 |                     16 |        2 |     2 |
|     40 |       4 | 0.03 s |  0.09 s |            0 |                      8 |        2 |     2 |

The reading loop sends nothing. The memory server holds the rows it was
offered, and when the source's index marks the changed piece, the rows for
that piece stand again on their own: two for each viewer. The source's
pieces are still running, so the change is one wave there, and the reading
space hears of it by a trigger.

## What the measurement changed

The timing of the structure loads showed that a carried row for a viewer's
own instance of a computed output did not lead the source's loop to the
piece. The loop read the instance under the serving identity, which holds
no instance of an output derived once for each viewer, found no back-link,
and parked the row as one that leads to no piece. In the changed-away
phase at 10 pieces and 8 viewers, all 80 such rows ended that way. The
viewers were served all the same, because the memory server hands the loop
the piece with each row.
A viewer of the source space itself who names only their own instance of
such an output has no such row, and their piece did not start.

The loop now reads the instance as a pair that demands it
(`#ownerOfComputedInstance()` in
`runtime/runner/src/executor/space-server.ts`), and
`space-server-computed-root.test.ts` holds the case.

A shorter path for a row whose piece already runs was tried, recording the
demander without the structure load. Two runs each way at 40 pieces and 4
viewers differed by less than the runs of one kind differed from each
other, and it was left out.

## What this does not show

- A toolshed's times, or the two spaces on workers of their own.
- How the serving loop's time divides between the two spaces. Both loops
  shared one thread, so a wall-clock time taken in one includes work of the
  other, and only the memory server's request times and the counts are
  attributed.
- A source whose pieces have more than one output for each viewer, or a
  shared output.
- A chain of more than two spaces.
- More than one run of each row.

## What follows from it

- A return with nothing changed costs the source nothing. It is not
  activated and is handed no demand.
- What the source pays for a carried demand is the memory server's
  admission of the rows, about a tenth of a millisecond a row, and the
  start of its pieces, which is what it pays for viewers of its own.
- The whole set of rows is sent again whenever it changes, two or three
  times in a phase that starts every piece. Sending what changed would cut
  the rows admitted by about that factor.
- The larger cost on the memory server's thread is the reading pieces'
  records: one for each reading piece, with a slice and a registered read
  for every viewer, stored again at each start.
