---
status: historical
created: 2026-11-05
archived: 2026-11-05
reason: "Profile record: why a Topic create costs a serving worker more as its board grows, from the worker's own CPU profiles at 100, 400 and 800 Topics, on a demanded board and on one nothing demands."
---

# Why a Topic create costs more as the board grows

Measured 2026-11-05 at commit `f5d289c97b` with
`skills/perf-investigation/scripts/create-worker-probe.ts`, which this work
added. The probe serves a fresh Topics board from a `ServingWorker` over a
loopback memory server, creates Topics through the board's `addTopic` verb
until the board holds a given number, and then has the worker profile its own
CPU over 20 more creates, sent four at a time. The worker profiles itself
through `node:inspector`, since the inspector port reaches only the main
thread. Every Topic has a one-line body and mentions nothing.

The machine ran other sessions at a load average between 30 and 320. The
profiler samples elapsed time, so a profile's total rises with the load while a
function's share of it does not; shares are the measure below, and the
process's CPU time per create is the absolute figure where a run recorded it.

## The numbers

| Board | Demanded | CPU per create | Wall per create | Load | Waves for 20 creates | Worker heap |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | yes | 0.72 s | 0.74 s | 61 | 9 | 225 MB |
| 400 | yes | 1.71 s | 2.36 s | 96 | 8 | 397 MB |
| 800 | yes | 3.47 s | 10.36 s | 314 | 11 | 600 MB |
| 800, another run | yes | not recorded | 2.14 s | 30 | 8 | 601 MB |
| 100 | no | 0.63 s | 2.52 s | 321 | 10 | 185 MB |
| 400 | no | 0.47 s | 0.47 s | 136 | 7 | 263 MB |

CPU is the whole process's: the client, the memory server and the worker. A
native sample of a run at 1,060 Topics showed the worker thread executing in
98% of samples and the main thread waiting in 77%, so the worker is what a
create waits for.

"Demanded" is how `cf piece new` leaves a board: its root is the serving loop's
demand, so the loop keeps everything the board publishes current. On a board
nothing demands, a create costs the same at 400 Topics as at 100.

## Where the worker's time goes

Share of the worker's busy time over the 20 creates, from one run that
profiled all three sizes. Indented rows are part of the row above them. A
second run gave the same picture at 800 Topics: `crossrefTable` 21%, `equals`
13%, `cardRowsByActivity` 14%, each action's commit 13%.

| Cost | 100 Topics | 400 | 800 |
| --- | --- | --- | --- |
| Reactive actions, all | 28% | 46% | 48% |
|   `crossrefTable` | 4.9% | 12.1% | 18.0% |
|     `equals` in `distinctByIdentity` | 1.4% | 5.3% | 13.7% |
|   `cardRowsByActivity` | 10.1% | 15.0% | 14.0% |
|   `mentionableIndex` | 4.4% | 8.3% | 5.1% |
|   `namesTable` | 2.8% | 5.2% | 6.2% |
| Each action's commit | 5.1% | 10.5% | 13.7% |
|   flow-label probe (`flowLabelWorkExists`) | 3.5% | 7.3% | 10.1% |
| Sealing the wave's commits | 9.1% | 8.8% | 9.1% |
| The `addTopic` handler | 24.4% | 11.2% | 7.9% |
| Garbage collection | 8.5% | 8.8% | 6.1% |

Across all of these, `validateAndTransform` is 18%, 26% and 22% of the busy
time and `resolveLinkTracingDereferences` 10%, 17% and 18%: reading a value
through its schema, and resolving a link while recording the dereference for
Contextual Flow Control.

## The handler does not cause it

On a board nothing demands, the profile of 20 creates holds no reactive action
at all: the handler, its commit, and the wave. `addTopic` passes the board's
`mentionable` and `boardCrossrefs` outputs to each Topic it creates without
reading them, so it does not wait on their writers.

On a demanded board the four lifts above run because the loop owes the board's
result. Each takes the whole `topics` list as its input, a create appends to
that list, and the next wave re-derives them. They run about once per wave and
not once per create: 20 creates sent four at a time landed in 7 to 9 waves, and
the worker ran 37 to 47 JavaScript actions over them.

## What grows

**One computation is quadratic in the board.** `crossrefTable` first reduces
its sources to distinct Topics with `distinctByIdentity`, which compares each
entry with `equals` against every entry kept before it, `n(n - 1) / 2`
comparisons for `n` Topics. At 800 Topics that is 320,000 comparisons per run,
and `equals` resolves both cells' links before comparing them, tracing each
dereference. Its share of the worker's time goes from 1.4% at 100 Topics to
13.7% at 800, and it is the one cost here whose share keeps rising. The
pattern's own comment gives the reason for the pairwise scan: nothing in the
pattern API turns a `ReadonlyCell` into a resolved key that a set could hold.

**Three computations are linear in the board, and all four re-run whole.**
`cardRowsByActivity`, `mentionableIndex` and `namesTable` each read one or a
few fields of every Topic on every run. A read of one field costs a link
resolution and a schema validation, so a run costs a few of those per Topic,
and an append of one Topic recomputes every row.

**An action's commit grows with what the action read.** Preparing each
reactive action's commit asks whether its transaction observed any labeled
document (`flowLabelWorkExists`). On this board the answer is no, and reaching
it visits every read the transaction made and indexes every dereference trace
it recorded, of which a lift over the whole board leaves several per Topic.
Sealing the wave's commits builds each commit's read list (`#buildReads`,
`compactCommitReads`) on the same terms.

## What would reduce it

Not done here; in order of how much each removes.

- A board nothing demands pays none of this. Which demand a deployed board
  holds while no browser shows it was not measured, and
  `docs/plans/serving-worker-heap.md` plans for a computation that has run to
  keep only its basis rows.
- An identity key a pattern can put in a set would make `distinctByIdentity`
  one pass. Without one, `equals` could compare two cells that are already
  resolved without resolving them again.
- A per-Topic row computed by `map` instead of a lift over the whole list
  would recompute one row per create. The card rows are ordered by activity,
  which a map does not give, so that one needs the order kept apart from the
  rows.
- The flow-label probe answers no only after visiting every read. Noting, as
  a transaction reads a document, whether it carries a label would answer it
  without the walk; that is a change to Contextual Flow Control's runtime, so
  `docs/development/cfc-spec-correspondence.md` governs it.
