---
status: historical
created: 2026-11-21
archived: 2026-11-21
reason: "Measurement of the currency index on a space whose pieces read each viewer's home space, with the index off and leaving current pieces unstarted: what a return, a change by a watching viewer and a change by an absent one cost, and what the measurement changed."
---

# What the currency index does for pieces that read each viewer's home space, November 2026

## Where this starts

The currency index leaves a piece unstarted while its record proves every
demanded output of it current
([the plan](../../../plans/stored-output-currency.md)). Steps 1 to 4 of
[its continuation across spaces](../../../plans/stored-output-currency-across-spaces.md)
let a record rest on a read in another space, which is what a wish for the
viewer's home space is. This record is that plan's step 8: what the index
saves, and what it costs, for a space whose pieces each read something of
every viewer who looks at them.

## Method

`skills/perf-investigation/scripts/currency-profile-probe.ts` makes P
pieces in one space, each with a wish for the viewer's `#favorites` and one
output derived from it, and V viewers, each with a home space that holds
one favorite. One `ExecutorHost` in the probe's process serves every space
over a loopback memory server. The probe runs its phases twice, with no
index (`off`) and with the index leaving current pieces unstarted (`skip`),
each on a server and a host of its own:

- **build**: every viewer watches every piece once, which starts them all.
  The space is then parked and the sessions removed.
- **return**: every viewer comes back in a new session and watches every
  piece.
- **change**: one viewer renames their favorite while every viewer watches,
  timed until that viewer reads the new name from every piece.
- **away**: a viewer who is not watching renames theirs.

The loop runs on the probe's own thread, beside the clients, so the times
say how the phases compare and not what a toolshed's worker would take.
Each row below is one run.

## A return

Seconds until every viewer has read every piece, and the pieces a serving
runtime runs at the end:

| Pieces | Viewers | `off` | Running | `skip` | Running | Roots judged | Judgment calls | Judgment time | Pulls |
| -----: | ------: | ----: | ------: | -----: | ------: | -----------: | -------------: | ------------: | ----: |
|     10 |       2 |  2.28 |      10 |   0.09 |       0 |           51 |              5 |          9 ms |     3 |
|     10 |       8 |  2.94 |      10 |   0.40 |       0 |          661 |             66 |        151 ms |     9 |
|     30 |       8 |  5.57 |      30 |   1.27 |       0 |        5,894 |            198 |        744 ms |     9 |

Under `skip` no piece starts. Each viewer's slice of each piece is clean,
and the loop asks each home space once what changed. What is left is the
judgment. The loop judges again each time the demand changes, and each
judgment covers every root left unstarted, so 240 demanded outputs were
judged 5,894 times in 198 calls. That is 58% of the phase at 30 pieces and
8 viewers, on the memory server's thread.

## A change by a viewer who is watching

Seconds from the rename until the viewer who made it reads the new name
from every piece:

| Pieces | Viewers | `off` | `skip` | Pieces started | Triggers | Pulls | Store time |
| -----: | ------: | ----: | -----: | -------------: | -------: | ----: | ---------: |
|     10 |       2 |  0.10 |   2.24 |             10 |        1 |     1 |      28 ms |
|     10 |       8 |  0.23 |   2.64 |             10 |        1 |     1 |      91 ms |
|     30 |       8 |  0.51 |   3.61 |             30 |        1 |     1 |     306 ms |

With no index the pieces are running and the change is one wave. Under
`skip` the home space tells the reading space once, the loop pulls once,
and every piece the viewer watches is marked and started. A start is a
start for every viewer who demands the piece, so one viewer's change starts
the piece for all of them, and each started piece is recorded again with
every viewer's slice.

The two seconds are not the index's. Any phase in which several of these
pieces start takes about that long in either mode: `off` takes 2.28 s to
start ten pieces on a return, and `skip` takes 2.24 s to start the same ten
after a change. The start wave logs `contribution-dropped` for the wish and
arms it again after a rollback. The index moves that cost from the return
to the first change.

## A change by a viewer who is away

Under `skip`, with every piece unstarted and the viewer not watching, the
rename started nothing in all three runs: one trigger, no pull, and every
root the loop judged afterwards still servable. With no index nothing
starts either, since the pieces are running already and the absent
viewer's instance is not among their runs.

## What the measurement changed

`currency.falseClean` counts a piece the index held clean that then wrote
an instance it vouched for again with no input changed. In the change phase
it counted one for every piece, in every run. A start derives every output
of a piece afresh, in one commit, through a transient value, including the
outputs of the viewers whose slices were current. Those were written again
with the value they held. The detector now compares the value at the
vouched sequence number with the value at the head and counts only a
difference, and the count was zero in the runs above.

## What this does not show

- A toolshed's times. The loop shared a thread with eight clients.
- A space with more than one output for each viewer, or with pieces that
  read each other.
- More than one run of each row.

## What follows from it

- `skip` leaves every piece unstarted for a returning viewer whose home
  space has not changed, at any of the sizes tried.
- The judgment is repeated for every root on each change of demand, which
  grows with viewers times pieces. Judging only the roots whose demand
  changed is the next cost to take out.
- One watching viewer's change starts each piece they watch for every
  viewer. Starting a piece for one viewer's slice alone would keep the
  others served from the store.
- Starting several pieces that hold a home-space wish takes about two
  seconds with or without the index.
