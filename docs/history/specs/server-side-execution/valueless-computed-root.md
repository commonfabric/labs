---
status: historical
created: 2026-11-25
archived: 2026-11-25
reason: "Decision record, with measurements, for the serving loop starting a stopped piece from a `computed:` document a read reaches that holds no value; the live rule is in docs/specs/server-side-execution/serving-loop.md."
---

# Starting a stopped piece from a derived document it never wrote

The live rule is "A computed document a demand names" in
[`serving-loop.md`](../../../specs/server-side-execution/serving-loop.md) §1.
This records why the rule takes the shape it does, which alternatives were
rejected, and what it was measured to cost.

## The gap

A serving runtime releases the pieces a handler starts once the handler's
transaction commits (`#releaseServedHandlerResult` in `runner.ts`, #9559), which
bounds the serving worker's heap at about 1.2 MB per Topic create instead of 3.6
MB. A released piece has run none of its derivations, so each `computed:`
document its setup made holds only its `result` back-link and no value. A read
that reaches such a document through a link got nothing.

The case that showed it: a parent whose handler adds a child that derives
`upper` from its title, and a client that reads the parent's `children` with
this schema:

```json
{
  "type": "array",
  "items": { "type": "object", "properties": { "upper": { "type": "string" } } }
}
```

The read, as a view (`pullFromServer`) or as a watch, gave `{}` for
`children[0]` where `{ upper: "FIRST" }` is expected. The memory server already
marked the session's row for the child's `computed:` document as one of a
piece's values (`piece`), since the document's `result` link names the child.
But the demand pass took no `computed:` row as a root unless a watch named it,
under the 2026-11-21 ruling that a session watching a piece is sent every
document the piece derives and the piece starts from the root that reached them.
Here the root that reached the document was the parent's list, which starts the
parent, not the child.

## The rule

A `computed:` document a session was sent is a root when both of these hold:

- **It holds no value.** The memory server marks the row `valueless`
  (`trackedAndPieceKeysFromEntries()` in `runtime/memory/v2/server-sync.ts`).
  The test is whether the document the session was already sent has a `value`
  field, so it costs nothing per row.
- **No node of the serving runtime writes it.** The demand pass asks the
  scheduler (`hasWriterOf()`), whose write index a running piece's nodes are in.
  A running piece's node is made a demand root when the session's key enters the
  demanded set, and derives the document with no structure load.

The demand pass then structure-loads the key, as it loads a root a watch names:
the load follows the back-link and starts the piece, which derives the value.
Where the loop keeps a currency index, the root is judged first, as every root
awaiting its first load is. Once the value lands the row loses its mark and the
key stops being a root.

The start is a read's start (`RunnerStartOptions.forRead`), kept as the runner
keeps an event's start: a record of the running pieces whose every start was
asked for that one reason, which any other start, a run, or an enclosing pattern
taking the piece as a child clears. Once the runtime is idle after the demand
pass, each piece has derived what the read reached, and the loop releases every
piece the pass's loads started whose record still stands
(`Runner.releaseReadStart()`), all at once. The store then holds what the pieces
derived, and serves it as it serves any value of a stopped piece. A key that a
demand other than a read has made a root since keeps its piece running.

## Why the piece is released again

The first version of the rule left the piece running, as the demand pass leaves
every piece it starts running until the tenure parks. A probe on the Topics
board (`addTopic` three times, on a serving runtime in the test process) showed
what that costs. A new topic's `$NAME`, `createdBy` and `mentions` documents
hold no value once the creates settle, with or without #10204's release after
idle, because nothing on the server reads them while the topic runs unless a
client watches a board derivation that reaches them. A read of the board's
`index`, its headless survey, reaches all three, so it started every topic whose
documents nothing had written. A client watching `index` while the topics were
filed started each new topic as it was filed, and kept it running: the
per-create cost #9559 removed. A client watching the board's `[UI]`, as a
browser does, reached none of them, since the cards are strings the board
derives and a reference the card does not read through.

| Probe, 3 topics                               | main: running / author | first rule | released   |
| --------------------------------------------- | ---------------------- | ---------- | ---------- |
| `index` read, no viewer                       | 0 / `""`               | 3 / Claude | 0 / Claude |
| `index` viewer while filing                   | 0 / `""`               | 3 / Claude | 0 / Claude |
| `[UI]` viewer while filing, then `index` read | 0 / `""`               | 3 / Claude | 0 / Claude |

"running" counts the topics running on the serving runtime once it is quiescent
after the read; "author" is what the read gave each topic's `createdBy.name`. On
main every read gives the empty default, since the store holds no value for it.

## Alternatives rejected

**Every `computed:` document of a piece no root of the session starts.** The
Topics board's `topics` output is read through `TopicDemand`, which reaches
derived documents of each topic, among them `[NAME]`, `createdBy`,
`commentCount`, `lastActivityAt` and `mentions`. Under this rule a read of that
list starts every topic on the board. Kept running, that is the per-topic heap
#9559 removed and the one `CARD_LIMIT` bounds for the cards (one viewer took a
worker past 8 GB on a copy of a 3,441-topic board). Released again, as the rule
above releases a read's start, it bounds the heap but not the work: each read of
the list starts every topic, which the measurements below put at about 20 s of
CPU for 2,000 children. It also reverses the 2026-11-21 ruling that a value the
store holds is served as it stands, stale or not, without starting its piece.

**Every reached `computed:` document, left to the currency judgment.** The
judgment declines to start a piece whose stored outputs it can vouch for, but
only in the `skip` and `start-upstream` modes. Under `record`, and with no
index, as the test suites run unless `SERVER_EXECUTION_CURRENCY_INDEX` names a
mode, every root is loaded, so the board read above starts every topic there. A
root the judgment finds servable also stays awaiting its first load and is
judged again at every change of demand, which on a 2,000-topic board is
thousands of roots judged per change.

**A released piece derives its outputs before the release.** This writes every
output of every handler-started piece at its creation, including a topic's
`[UI]` and its backlinks, whether anything reads them or not. It also leaves the
same gap for a piece stopped some other way before its first derivation.

## Costs and limits

- A piece the rule starts runs only until the runtime is idle after its start,
  and the start writes what the read reached, so a later read is served from the
  store and starts nothing.
- A derivation that produced `undefined` stores no value, so its document reads
  as unwritten. A read that reaches one of a stopped piece starts the piece
  again, briefly, each time the document's key is newly demanded, unless a
  currency judgment finds the piece servable. None of the documents
  `TopicDemand` reaches derives `undefined` (`createdByOf` returns a sentinel
  author, the counts are numbers, and the name and mentions are always a string
  and an array).
- A long-lived watch that reaches such a document is served what the piece
  derived when it ran for the first read, and an input change the piece's own
  events do not carry leaves that stale, as for any stored value of a stopped
  piece.
- The memory server rebuilds a session's demand share when a push gives a held
  piece's value its first value, which it did not do for a change of value. That
  happens once per such document.
- A value the store holds is served as it stands, as before: a stopped piece's
  stored output that an input change made stale stays stale for a read that
  reaches it through a link.
- An instance narrower than the space that no run has written does not exist in
  the store, so it carries no back-link and no mark, and a read reaching it
  starts nothing, as before.

## Measurements

`skills/perf-investigation/scripts/served-list-read-probe.ts` makes a parent
whose one event adds `n` children, each deriving three values from its title, on
a serving runtime in the probe's own process (`startServingMemoryServer` with
`worker: false`, no currency index), and times a client's view read of the
parent's `children`. The scenarios are the three schemas the probe names: each
child's stored title (`title`), each child's derived values before any run wrote
them (`unwritten`), and the same values after each child derived them and
stopped (`written`). Both builds are main at 690a093070, with and without this
change. CPU is the probe process's own, which the serving loop and the client
share; heap is the process heap after a forced collection, before and after the
read. Each 500-child row is the median of three runs; each 2,000-child row is
one run.

| n     | scenario  | build  | wall ms | CPU ms | heap +MB | running after | read a value |
| ----- | --------- | ------ | ------: | -----: | -------: | ------------: | -----------: |
| 500   | title     | main   |     310 |    422 |      7.3 |             0 |          500 |
| 500   | title     | change |     325 |    465 |      7.3 |             0 |          500 |
| 500   | unwritten | main   |     341 |    489 |      9.7 |             0 |            0 |
| 500   | unwritten | change |   3,025 |  4,227 |     28.3 |             0 |          500 |
| 500   | written   | main   |     524 |    764 |      0.5 |             0 |          500 |
| 500   | written   | change |     437 |    629 |     -0.8 |             0 |          500 |
| 2,000 | title     | main   |   1,417 |  1,841 |     37.1 |             0 |        2,000 |
| 2,000 | title     | change |   2,159 |  2,792 |     23.3 |             0 |        2,000 |
| 2,000 | unwritten | main   |   2,053 |  2,529 |     46.8 |             0 |            0 |
| 2,000 | unwritten | change |  35,575 | 40,518 |     96.6 |             0 |        2,000 |
| 2,000 | written   | main   |   1,948 |  2,531 |     19.4 |             0 |        2,000 |
| 2,000 | written   | change |   1,701 |  2,250 |     18.9 |             0 |        2,000 |

A read that reaches only what the children store, or what they derived before
they stopped, costs the same with the change as without it and starts nothing;
another 2,000-child `title` run of the change took 1,317 ms and 1,718 ms of CPU,
so the gap in that row is between runs. A read that reaches 2,000 unwritten
values derives all of them and leaves none running. The first version of the
rule, which left them running, took 17,825 ms and 22,443 ms of CPU for the same
2,000-child read and left 2,000 children running with 290 MB more heap; at 500
children it took about 7,000 ms of CPU and 73 MB.

Two costs scale worse than linearly in the unwritten read, and profiles of the
probe's read (the V8 profiler through the inspector, sampling every 500 µs)
attribute them:

- **One document release for each released piece.** Released one at a time, each
  piece asked for its own pass over the replica's documents, and each pass began
  before the next release, so 2,000 releases ran nearly 2,000 passes: 116 s of
  CPU at 2,000 children, 36.5 s at 1,000, with the release pass's own frames
  (`isRead`, `#removeWatchesByRelease`, `releaseUnread`, `#holds`,
  `sweepSuspects`) at 60% of the samples. Releasing a demand pass's read starts
  together joins their requests into one pass, which is what the change does:
  12.3 s at 1,000.
- **The memory server's tracked-graph staging.** Each incremental evaluation of
  a session's graph stages the tracker's attribution maps, and the first read of
  an entry copies its set (`new Set(refs)` in the `StagedMap`s for `coveredBy`
  and `tracksOf` in `runtime/memory/v2/query.ts`). The children list attributes
  every child's documents, so each evaluation that touches it copies a set of
  `n` entries, and the values arriving one child at a time make about `n`
  evaluations: 1.9 s of samples at 1,000 children and 9.3 s at 2,000, called
  from `addAttribution` through the schema-closure walk and through `#watchAdd`.
  This predates the change, which only makes `n` values arrive at once; the
  first version paid it too.

On the Topics board the unwritten case is what a read meets for each topic whose
`$NAME`, `createdBy` or `mentions` nothing has written yet, so the cost is paid
once for each such topic, by the first read that reaches it.
