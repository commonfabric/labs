---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Decomposition of what creating fifty topics costs off screen and on, which of the growth terms belong to the pattern rather than to the runtime, and what a live view adds, August 2026."
---

# What creating fifty topics costs, off screen and on, August 2026

Filing a topic feels slow, and it gets slower as the board fills. This is where
that time goes — first with nothing rendering the result, so the numbers
describe creation itself, and then with a browser showing the board, so the
difference between the two is what a live view adds.

On the team's own board, 105 topics deep, filing one through the CLI takes 33
seconds. The short version of where that goes: the topics pattern's own
JavaScript is 0.1% of the CPU. Two
of the growth terms are the pattern's, and removing the larger one is worth
about a third of the run. Everything left is the runtime's write path, and the
per-create floor under it is roughly 280 milliseconds of encoding, hashing,
freezing, committing, and validating a dozen documents. Putting the board on
screen roughly doubles that and the ratio widens as the board fills, but almost
none of it is the paint: the wait between the write landing and the card
appearing is five percent of the total. And the schema memo is enabled on the
wrong side — 92% dead weight where it runs, and absent from the read where a
quarter of the visits repeat, which on the real board is eighty-three thousand
schema nodes to fetch two scalars per row.

## What was measured

A scratch pattern test whose only steps are fifty `addTopic` sends, one per
step, with no assertions and no render steps between them. Each step therefore
settles one create, and the per-step scheduler and timing rows describe creation
alone.

```tsx
import { action, pattern, TESTS } from "commonfabric";
import Topics from "./main.tsx";

const COUNT = 50;
const INDICES = Array.from({ length: COUNT }, (_unused, index) => index);

export default pattern(() => {
  const board = Topics({});
  return {
    [TESTS]: INDICES.map((index) => ({
      action: action(() => {
        board.addTopic.send({
          title: `Topic ${String(index).padStart(4, "0")}`,
          agentName: "Perf",
        });
      }),
    })),
  };
});
```

Run as `deno task cf test <file> --verbose --stats-threshold 0`, with a V8 CPU
profile of the step loop taken through `node:inspector` from inside the test
runner, and a `--timing-measures-out` capture read with the aggregation scripts
under `skills/perf-investigation/scripts/`.

Machine: Apple M3 Max. The machine was carrying an unrelated benchmark for most
of the session, so every wall-clock number below is a ceiling and the A/B
comparisons are paired within a rep rather than pooled. The counts are exact and
noise-free, and the CPU shares are stable across runs; those carry the argument.
Where a comparison rests on wall clock — the on-screen pair below — both sides
were run back to back and the ratio is what is reported, never the milliseconds
on their own.

`cf test` calls `runtime.enableIdempotencyCheck()` unconditionally, which runs
every computation a second time and changes what subscription registers. That is
worth about 16% of the wall clock and 58% of the action time in this workload.
Every number below was taken with that call gated off, except where it is the
subject.

## What it costs on the real board

Every measurement below is a harness. This one is not: filing a topic on the
team's own Estuary board — 105 topics — through `cf call … addTopic` takes **33
seconds**, of which 3.6 are CPU in the client. Reading that board is worse:

| read | wall | client CPU |
| --- | --- | --- |
| `cf piece verbs` | 1 traversal of 83,133 schema nodes | — |
| `cf get index --step --select @,title` | 51s | 11.6s |
| `cf get topics --input --filter … --select` (105 rows) | 3m22s | 5.2s |
| the same, filtered to one title | 56s | 2.1s |

Two things about that table. The client is idle for most of it — 2 to 12 seconds
of CPU inside a minute or three of wall clock — so this is a round-trip and
server story as much as a traversal one. And the 51-second `index` read returns
nothing usable: on this deployed board `index` comes back as a bare `$link` and
`crossrefs --step` as `[]`, while `topics --input` holds 105 rows. The computed
surfaces do not materialize here, so the survey the Topics skill recommends
costs 51 seconds and yields no rows. The traversals below are logged during that
read either way.

Those numbers are what the rest of this is trying to account for.

## The curve

| create | settle |
| --- | --- |
| 1st | 284ms |
| 10th | 267ms |
| 25th | 374ms |
| 40th | 515ms |
| 50th | 891ms |

Two separate problems live in that table. The first create already costs 284
milliseconds with three scheduler runs in it, which is the floor. The fiftieth
costs three times that, which is the growth.

## The counts, which are exact

Per create, at board size N:

| counter | with crossrefs | crossrefs unwired |
| --- | --- | --- |
| scheduler runs | N + 12 | 12, flat |
| JavaScript action invocations | 2N + 12 | 12, flat |
| `normalizeAndDiff` calls | 40N + 150 | 3N + 181 |
| `traverse` calls | 30N + 325 | 30N + 325 |

The last row is the one that matters most, because it does not move. Unwiring
the board's crossref pivot from every created topic removes 80% of the scheduler
runs and 93% of the diffing, and changes the traversal count by nothing at all.
There is a second growth term underneath the pattern's, and it is not the
pattern's to remove.

## Where the CPU goes

Sampled self time over the step loop, at two board sizes, normalized per create.
The growth column is the per-create cost at fifty divided by the per-create cost
at ten: 1.0 means a fixed cost per create, higher means it grows with the board.

| area | per create (N=50) | share | growth |
| --- | --- | --- | --- |
| wire codec — JSON encode and decode at the memory boundary | 84ms | 16% | 1.28 |
| storage engine, SQLite, query evaluation | 69ms | 13% | 2.61 |
| schema traversal and validation | 62ms | 12% | 1.80 |
| deep freeze | 54ms | 10% | 2.29 |
| GC | 40ms | 7.5% | 2.39 |
| scheduler dependency bookkeeping | 40ms | 7.5% | **6.77** |
| hashing | 34ms | 6.5% | 1.28 |
| link resolution | 27ms | 5% | 2.75 |
| the topics pattern's own JavaScript | 0.6ms | 0.1% | 5.61 |

The pattern's code accounts for a tenth of one percent of the CPU. It is 11.6%
inclusive, and the difference between those two numbers is the finding: a
pattern body is a thin shell over runtime primitives, so "make the pattern do
less" only ever means "make the pattern ask the runtime for less".

The single hottest frames:

| ms | share | frame |
| --- | --- | --- |
| 1980 | 7.5% | (garbage collector) |
| 1897 | 7.2% | `addToDeepFrozenCache` — `deep-freeze.ts` |
| 1096 | 4.1% | `comparePaths` — `reactive-dependencies.ts` |
| 1031 | 3.9% | `encodePlainObject` — `JsonEncodeAct.ts` |
| 847 | 3.2% | `op_node_hash_update` |
| 725 | 2.7% | `parseWireText` — `wire-text.ts` |
| 690 | 2.6% | `utf8SortedKeysOf` — `utf8.ts` |

`comparePaths` is 92.5% reached through `sortAndCompactPaths` from
`setSchedulerDependencies`, called by `resubscribePullSchedulerAction`. Every
action re-sorts its complete read-address set after every run. A topic's
crossref lookup carries 347 read addresses and the board's pivot carries 444, so
the sort is redone over a set that grows with the board, once per run, and the
runs themselves grow with the board.

By inclusive time the run is 13.3% `sqliteTransaction`, 12.2% the memory
server's `watchAdd`, 11.6% `validateAndTransform`, 11.6%
`invokeJavaScriptImplementation`, 11.4% decode, 10.4% encode, 10.1% hashing, and
10.0% deep freeze.

## What each action costs

From the timing-measure capture, 10.3 seconds of JavaScript action time across
1872 runs:

| action | runs | total | first tenth | last tenth |
| --- | --- | --- | --- | --- |
| `backlinksOf` | 1225 | 4258ms | 1.32ms | 5.48ms |
| the `patternIdentity` sinks | 50 | ~4500ms | ~90ms | ~90ms |
| `crossrefTable` | 99 | 1514ms | 1.26ms | **38.91ms** |
| `createdByOf` | 49 | 320ms | 1.46ms | 12.37ms |

`backlinksOf` runs once per existing topic on every create, which is where the
`N + 12` comes from. `crossrefTable` runs twice per create and each run gets
thirty-one times more expensive across the board — it rebuilds the whole pivot,
scanning every topic against every topic, and `equals()` resolves both links on
every comparison.

The `patternIdentity` sinks are one per created piece, at about ninety
milliseconds each, and they are the largest single line in the table. They are
also the most misleading one: disabling the watcher that registers them recovers
only about 7% of the run, because most of that ninety milliseconds is the first
touch of the new piece's documents. Someone pays it either way.

## The append ladder

Four harnesses, each appending fifty elements to a durable array, differing only
in what the element is. This is what separates "the array grew" from "the
element is wide" from "the pattern fans out".

| element | scheduler runs per append | `traverse` calls | 1st append | 50th append |
| --- | --- | --- | --- | --- |
| a plain string | — | 4, flat | 17ms | 11ms |
| a three-field piece | 3, flat | 17, flat | 26ms | 25ms |
| a fourteen-field piece with four verbs | 7, flat | 24N + 45 | 52ms | 67ms |
| a Topic, crossrefs unwired | 12, flat | 30N + 325 | ~410ms | ~735ms |
| a Topic | N + 12 | 30N + 325 | 284ms | 891ms |

Appending to a growing array is free. Appending a piece to a growing array is
free. Appending a piece whose declared shape is wide re-walks every element
already there, once per append, with no reactive fan-out at all — the scheduler
run count stays at seven while the traversal count climbs by twenty-four per
element. The curve bends because the write path validates the array against its
element schema, and that walk is proportional to both the array's length and the
element schema's width.

That is the second growth term, and the fourteen-field probe reproduces it with
no Topics in it.

## The three growth terms, separated

1. **`backlinksOf` fans out.** Every topic's inbound-reference lookup declares
   the whole crossref table as its input, so every create re-runs one action per
   existing topic. Unwiring it takes scheduler runs per create from `N + 12` to
   a flat 12, and the run from 52.9s to 33.7s, 40.2s to 25.7s, and 29.2s to
   26.1s across three interleaved reps. The pattern's comment says the re-run is
   fine because an unchanged row recomputes to the same links and writes
   nothing — which is true, and is not what it costs. What it costs is the
   scheduler's per-run overhead, which at this size is larger than the body.

2. **`crossrefTable` rebuilds the whole pivot per create**, scanning N against N
   with a link resolution per comparison. Its own per-run cost grows thirty-one
   fold across the board.

3. **The write path re-walks the list against the element schema**, once per
   append, independent of both of the above. This one is the runtime's, it is
   what the append ladder isolates, and it is the floor the pattern cannot get
   under.

## The floor

The first create costs 284 milliseconds with three scheduler runs in it. Nothing
in that number is the board's size. It is the cost of bringing a Topic piece into
existence: a dozen documents encoded to canonical JSON, hashed, deep-frozen,
committed through SQLite, and validated against their schemas, plus the memory
server's watch refresh over what changed. The wire codec and hashing are the two
areas whose per-create cost does not grow at all (1.28 each), which is what says
they are that floor rather than part of the curve.

## Where the wall clock goes in one off-screen create

The CPU shares above say what the machine was doing. This says what the caller
was waiting for. Each row is the elapsed time recorded against that key during
one step, so a row contains its children rather than excluding them, and rows at
the same depth are the ones to compare.

| wall, ms | 2nd create | 10th | 25th | 40th | 50th |
| --- | --- | --- | --- | --- | --- |
| the step, end to end | 300 | 270 | 377 | 520 | 898 |
| runtime idle, within the step | 270 | 245 | 348 | 485 | 861 |
| scheduler execute (7–8 turns), within idle | 219 | 202 | 292 | 419 | 747 |
| the settle loop, within execute | 133 | 132 | 202 | 309 | 569 |
| scheduler runs, within the settle loop | 85 | 83 | 146 | 234 | 455 |
| action bodies, within the runs | 67 | 65 | 114 | 178 | 343 |
| event delivery, within execute beside settle | 85 | 69 | 87 | 106 | 172 |
| within idle but outside execute | 51 | 43 | 56 | 66 | 114 |
| storage sync, after idle returns | 30 | 25 | 29 | 35 | 37 |

Read against the CPU table, the interesting row is the action bodies: 22% of the
wall clock at two topics and 38% at fifty, while the pattern's own frames are a
tenth of a percent of the CPU. Both are true and they are the same fact from two
sides — an action body's wall time is almost entirely the runtime work it asks
for, not the JavaScript it runs.

The rest divides into three roughly equal overheads that no action accounts for:
the settle loop above the runs, the per-run bookkeeping above the bodies, and
event delivery beside both. At fifty topics they are 114ms, 112ms and 172ms
against 343ms of action body.

Only 8–10% of a late step's elapsed time falls outside every instrumented span,
so this is close to a complete account of the wait rather than a sample of it.

## What UI demand costs with nothing painting it

The same harness, with the board's `[UI]` demanded so the VDOM is built, and
still no browser anywhere. Both runs carry `cf test`'s idempotency recheck, so
they are comparable to each other and about 16% above the numbers above.

| | 1st create | 50th create | whole run |
| --- | --- | --- | --- |
| no UI demand | 260ms | 1.2s | 31.8s |
| UI demanded, unpainted | 480ms | 1.3s | 43.7s |

Building the view nearly doubles the floor — 260ms to 480ms for the first create
— and adds 38% to the run. It changes nothing about the shape: scheduler runs
per create stay at `N + 12`, exactly as without it. Demanding the view is a
constant per create, not another growth term.

## On screen

[`topic-create-onscreen.test.ts`](../../../../patterns/integration/topic-create-onscreen.test.ts)
fills two boards in one space in lockstep — the browser routed at the first and
never at the second — and splits each create on the rendered board where the
work changes hands: the write and the authoring runtime's settle, then the
additional wait until the new card's title is in the DOM. `CF_TOPICS_ONSCREEN_RENDER=0`
is the control: the browser sits on the space root and renders neither, which is
what the rendered run is read against.

This is a different stack from everything above — a real toolshed over HTTP with
on-disk SQLite — so its milliseconds are not the `cf test` milliseconds.

What the authoring client holds live while it files decides the measurement more
than anything else here, so it is a knob rather than a constant, and the default
is the narrow one: a sink on the board's `index`, the bounded discovery surface
the board publishes for exactly this. Twenty-five topics per board, the two runs
back to back, medians of both creates in an iteration:

| board size | nothing rendered | rendered | on screen costs |
| --- | --- | --- | --- |
| 1–5 | 507 | 509 | 1.00× |
| 6–10 | 636 | 1039 | 1.63× |
| 11–15 | 686 | 1371 | 2.00× |
| 16–20 | 767 | 1300 | 1.70× |
| 21–25 | 864 | 1857 | 2.15× |

Being on screen roughly doubles what one more topic costs, and the ratio widens
as the board fills. Nothing rendered, the curve grows 1.70× across this range;
rendered, 3.65×.

The render tail — everything between the write landing and the card being in the
DOM — is 41ms over the first ten creates and 60ms over the rest. Five percent.
So the answer to "is it the rendering" is no: the visible latency after the
write is small and grows slowly. What being on screen costs is a second runtime
running the same pattern over the same space, and one storage server serving
both.

The shape of the contention says so more clearly than its size. In the rendered
run the first create of each iteration — the one on the board nobody is
watching — is consistently the slower of the two, at 1.37× to 1.67× the second;
in the control the two are indistinguishable, at 0.93× to 1.02×. The browser
wakes on the first write of the pair and is still busy while it settles, and by
the second it is warm. Nothing about that is a property of the board being
written.

### What the harness was measuring before

The first version of this harness held each board live the way
[`topic-board-fixture.ts`](../../../../patterns/integration/topic-board-fixture.ts)
does — `getResult(piece).sink(() => {})`, which is a sink on the piece cell with
no schema at all, so every change re-materializes the whole result and every
topic in it. That is the widest demand available, and it was the harness's
choice rather than the product's.

Narrowing it to `index` is worth measuring twice over. The unrendered curve
across the same range goes from 3.70× to 1.70×, so the wide demand was roughly
doubling the growth rate of an off-screen create. And over a fifty-topic run the
traversals slow enough to report drop from 101 to 9.

Two lessons, and the second is the one that generalizes: a harness that holds
more live than its subject does measures itself, and the widest demand is the
one you get by default — a sink on a piece cell carries no schema, so nothing
about the spelling warns you.

## A row that sums to nothing

The browser worker reports `runner/start/resumeCellSync` at 111 seconds across
326 calls, in a run whose entire wall clock is twenty minutes, at a suspiciously
uniform 368ms each. It is not 111 seconds of anything. Those spans are
concurrent — one per cell a resume pre-syncs, all in flight together — and the
code that emits them says exactly that. The enclosing
`runner/start/syncCellsForRunningPattern` is four calls totalling 1.97 seconds,
and that is the wall cost.

Every row in these summaries is a sum of elapsed spans, so concurrent spans
count the same interval once each and a nested span counts it again inside its
parent. A uniform per-call duration across hundreds of calls is the tell: work
varies, waiting on one shared thing does not.

## Ruled out

- **The growing array is not the problem.** Appending to a fifty-element array
  costs the same as appending to a one-element array, for both plain values and
  piece links.
- **Passing the board's own list into each topic as `mentionable` is not the
  problem.** Unwiring it leaves the traversal counts identical.
- **The settle loop is not waiting on anything.** The measure-coverage view puts
  the uninstrumented gap inside a late step at 8–10%; the time is spent, not
  waited.
- **GC is not the spikes.** Three major pauses across the run (220ms, 155ms,
  126ms) sum to 501ms of the 1980ms GC total; the rest is scattered minor
  collections. The outlier steps are bigger than the pauses that could explain
  them.
- **Rendering is not what makes a create slow.** The wait between the write
  landing and the card appearing is five or six percent of the create.
- **An ordering bias does not explain the on-screen pair.** With nothing
  rendered, the two creates of an iteration are within 7% of each other in
  either direction; with the board rendered, the first is 1.37× to 1.67× the
  second.

## The schema memo is enabled on the wrong side

The traversal reports that named a schema memo of size zero, and the ones that
named a memo of tens of thousands of entries with almost no hits, turned out to
be the same finding from two sides. Neither is in the browser: both come from
Deno processes, and the second is the memory server's, which `cf test` runs in
process.

`traverseWithSchema` consults its memo only when `traverseCells` is set, which
is `TraversalContext.includeMeta`, which is true on the memory server's query
path and false on the runtime's own read path. So `schemaMemo=0 schemaMemoHits=0`
does not report a memo that missed. It reports a memo that was never consulted.
The reason it is not consulted is real: the query path's key is address plus
schema, which is sound there because `StandardObjectCreator` ignores the `link`
argument, and unsound on the read path, where `TransformObjectCreator` builds
cells out of it.

Both halves were measured by instrumenting `traverseWithSchema` to count, per
traversal, how many visits repeated a key already seen — once keyed as the query
path keys it, and once with the link folded in — and to count lookups, hits and
inserts across a whole run on the side where the memo is live.

### Where it is enabled, it is 92% dead weight

Over the fifty-create `cf test` run, the query-path memo took **82,733 lookups,
returned 6,492 hits, and inserted 76,241 entries**. The hit rate reaches 7.8%
within the first few creates and does not move after that. Seventy thousand of
those entries were written and never read. One query's memo was observed at
35,267 entries; it is per query rather than retained, so this is a transient
peak rather than a leak, and it is a peak on the side where memory is what binds
a large board.

Building the keys is not what costs: 38 milliseconds across the whole run,
because the schemas there are deep-frozen and `hashSchema` is an identity
lookup.

### Where it is disabled, a quarter of the work is redundant

The traversal that has this problem is a `Cell.get()` at `path: []` with a
piece's whole result schema. That is what a client holding a result live gets by
default, and narrowing the harness's demand is what took its count from 101 to 9
over a fifty-topic run — so it would be easy to file this as a harness artifact
and stop.

It is not one. The `cf` CLI does exactly this read against the real deployed
board, through the documented commands. `cf piece verbs` produces one traversal
of **83,133 schema nodes, 55,708 `anyOf` branches, 36,184 document lookups, at
depth 36**, and reports `schemaMemo=0 schemaMemoHits=0`. The narrow read the
Topics skill recommends —
`cf get --url "$BOARD" index --step --select @,title`, which asks for two
scalars per row — takes 51 seconds wall clock and contains **six** such
traversals, 337 to 618ms each, every one of them at `path: []` against the full
result schema and every one of them unmemoized. See the table above for what
each of those reads costs, and for the fact that the 51-second one returns no
rows at all.

In the harness's smaller version of the same traversal — about five thousand
schema nodes at depth 33 with six thousand `anyOf` branches — **25.3% to 25.6%
of visits repeat an address-plus-schema-plus-link triple already visited in the
same traversal**, and the fraction is flat across board sizes.

The link is not what stands in the way. Of 1,199 repeats in one traversal, 1,105
— 92% — survive folding the link into the key. Keying the read path soundly
costs almost nothing in hit rate.

What the repeats track is `anyOf`. Across every sampled traversal there are
about 0.77 repeats per surviving `anyOf` branch (branches minus fast rejects),
steady to within a few percent as the board grows. The traverser walks the same
child document under several branches of the same union and gets the same answer
each time.

An ordinary read has nothing to gain from this: the read-path traversals in the
`cf test` run visit 2,300 schema nodes at depth 7 with 188 `anyOf` branches and
zero fast rejects, and repeat **nothing**. The redundancy belongs to deep,
union-heavy reads, not to reads in general.

### What that adds up to

The memo is on the side that barely uses it and off the side where a quarter of
the visits are provably repeats — and the design reason it is off accounts for
8% of those repeats. The two changes are independent: bounding or dropping the
query-path memo, and keying the read path so it can have one.

There is a third, upstream of both: a caller that asked for two scalars per row
should not be traversing eighty-three thousand schema nodes six times. The memo
would make that cheaper; not doing it would make it unnecessary.

## Left open

A handful of query-path traversals take 210 to 680 milliseconds while reporting
twelve schema visits, ten `getDocAtPath` calls, and a maximum depth of five.
Whatever that is, it is not proportional to the work the traversal describes,
and the memo is not the explanation — those traversals can hit at most twelve
times.
