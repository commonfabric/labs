---
status: historical
created: 2026-10-12
archived: 2026-10-12
reason: "Counts from a fabrichat room's reload before and after the scheduler's topological sort began breaking a cycle at one of the cycle's own members, with the one-time re-derivation a room's first load after a runtime change does, October 2026."
---

# A fabrichat room's reload with cycles broken inside the cycle, October 2026

The scheduler's topological sort places one action ahead of an input it
reads when a read/write cycle leaves none ready. It had chosen that action
among every unplaced action, lowest in-degree first, and the change measured
here restricts the choice to the members of a cycle that no unplaced action
outside it feeds (`docs/specs/scheduler-v2/README.md` §7.4). This records
what the change did to a room's reload, and one thing the measurement ran
into that is not about ordering.

## Setup

- The server: a local toolshed at a port offset, `serverExecution` off, its
  store holding rooms seeded the day before.
- Two rooms of thirty messages and twelve members, here A and B. A had been
  opened many times. B had been opened once, by the first run that created
  its rows.
- The client: a Deno `cf piece render` of the room through
  `skills/perf-investigation/scripts/profile-cf.ts`, with the logger's
  counts and timing statistics written at exit.
- The code: main at `d5922572ea` for the old order, and that commit with the
  change for the new. Four earlier renders of A are from main at
  `e10ccc6e47`, nineteen commits before, with and without the heap the sort
  then kept its candidates in; that heap did not change the order.
- The machine ran at a one-minute load of 200 to 500 throughout, with other
  sessions rendering against the same toolshed. A render took between five
  and twenty-one minutes. So nothing here is a wall time: every number is a
  count, or a duration compared within one process.

A break was counted with a temporary counter in the sort. An action started
before its input had produced a value is counted by the runner's own report
of it, the `runner/action` log count: the runner reports an action whose
argument reads as undefined, and reports it again when the argument becomes
valid.

## Room A, nine renders

| | old order, 5 renders | new order, 4 renders |
| --- | --- | --- |
| breaks in the settle of about 3,900 actions | 1,991 | 179 |
| breaks in the settle of 34 actions | 8 | 1 |
| action runs | 2,237 each | 2,177 three times, and 2,463 |
| reports of an undefined argument | 60 each | 0 each |
| commits | 435 or 436 | 435 or 436 three times, and 499 |

Room A's large settle holds one cycle: 180 computations that each read the
room's `messages` list and are each declared a writer of it, so each has an
edge to every other. Under the old order 1,812 of the 1,991 breaks placed an
action outside that cycle, a reader of one of its members with a single
unmet input, ahead of the member it reads. Under the new order every break
is one of the cycle's own: 179, one per member but the last.

The sixty runs a reload no longer makes are the ones the runner reported:
actions the old order started before the computation they read had run.

## Room B, four renders in order

| render | order | action runs | undefined-argument reports | writes outside a declared surface | commits |
| --- | --- | --- | --- | --- | --- |
| 1 | old | 4,409 | 143 | 429 | 1,655 |
| 2 | new | 2,109 | 0 | 1 | 406 |
| 3 | new | 2,114 | 0 | 1 | 406 |
| 4 | old | 2,139 | 25 | 1 | 406 |

Renders 2 to 4 are reloads, and show the same thing room A does on a
smaller scale: twenty-five reports and about twenty-five more runs under the
old order, none under the new.

## The first load after the runtime changes re-derives the room

Render 1 of room B is not a reload. It ran the old order, and did twice the
runs and four times the commits of the reloads after it, with 429 writes
outside a declared surface where a reload has one. Room B had last been
opened by main at `575c896d26`, twenty-two commits earlier. Its first load
at the newer main derived and committed much of the room again, and the
loads after it found that work done.

Room A shows the same event split in two. Its first render at the newer
main was an old-order one that was stopped at a fifteen-minute limit, part
of the way through. The render after it, the first under the new order,
made 63 commits more than a reload makes, 206 more writes outside a
declared surface, and 286 more action runs, and its CPU profile shows the
phases of an ordinary reload, each larger, with none repeated. The renders
after that one are ordinary reloads under either order.

So the 2,463 in room A's table is the remainder of a one-time re-derivation
and not an effect of the order. Which of the commits changes what a room
stores was not determined. Among the nineteen that room A's renders span
are a named instance stamping the child it sets up, a `data:` snapshot
keeping its links' schemas as references, and a wish state holding its view
as an opaque handle.

## The sort's own cost

Counted first, with temporary counters in the sort, so that the machine's
load does not enter. A queue entry is a candidate put into the break's
heap. The two kinds of step are an edge examined while confirming that a
cycle a break fell in is still whole, and an edge examined while searching
for components.

| shape | actions | edges | breaks | queue entries | confirming steps | searching steps |
| --- | --- | --- | --- | --- | --- | --- |
| ring with edges both ways | 2,000 | 4,000 | 1,999 | 5,998 | 7,992 | 4,000 |
| | 8,000 | 16,000 | 7,999 | 23,998 | 31,992 | 16,000 |
| | 32,000 | 64,000 | 31,999 | 95,998 | 127,992 | 64,000 |
| fully connected cycle | 100 | 9,900 | 99 | 9,998 | 19,404 | 9,900 |
| | 200 | 39,800 | 199 | 39,998 | 78,804 | 39,800 |
| | 400 | 159,600 | 399 | 159,998 | 317,604 | 159,600 |
| | 800 | 639,200 | 799 | 639,998 | 1,275,204 | 639,200 |
| pairs feeding each other | 2,000 | 2,000 | 1,000 | 2,000 | 0 | 2,000 |
| | 16,000 | 16,000 | 8,000 | 16,000 | 0 | 16,000 |

Within each shape every count stays close to one multiple of the edge
count at every size: one and a half, two and one for the ring, and one, two
and one for the fully connected cycle. So over these shapes the break's
work grows with the edges of the graph it is given.

Timed, the sort alone over two of the shapes, the fully connected one with
readers added, the two versions run alternately on the loaded machine,
minimum of five:

| shape | old order | new order |
| --- | --- | --- |
| fully connected cycle of 400, with 8,000 readers | 986 and 656 ms | 923 and 1,277 ms |
| fully connected cycle of 800, with 16,000 readers | 3,549 and 4,608 ms | 1,789 and 4,520 ms |
| ring of 10,000 with edges both ways | 279 and 618 ms | 55 and 355 ms |
| ring of 40,000 with edges both ways | 1,413 and 2,290 ms | 717 and 1,659 ms |

The same script on the same code varied by a factor of five between runs.
The timings therefore support no ratio between the two orders, and no
comparison of how their costs grow. They are recorded as observed.

The change went through three versions, all placing the same actions in the
same order. The first searched the cycle for its components again after
every break, which is cubic in the size of a fully connected cycle: 1.5 s
at 400 members and 10 s at 800 on a quieter machine. The second recognized
a cycle that stayed whole by traversals that had to reach all of its
members, and queued them all again, which is quadratic for a sparse cycle
that stays whole. The third checks only that the neighbors of the placed
action still reach one another, and queues again only the members whose
key changed.

The counts and the timings above are of the third version. Of the
new-order renders, the last of room A ran the third version and the others
the second. Within room A's renders, the large settle's sort took 2.5 s
under the old order, 1.3 to 1.6 s in the three renders of the second
version, and 0.9 s in the render of the third.

## What this leaves

- Room A's cycle exists because three of a message row's computations pass
  the captured `messages` cell to a helper, which marks each a writer of
  the list. A change to the pattern removes it.
- A room's first load after a runtime change re-derives and commits much of
  the room. Which change does it, and whether every deploy costs each room
  one such load, is open.
- The `runner/action` count is a direct instrument for an action started
  before its inputs: sixty per reload in room A under the old order, none
  under the new.
