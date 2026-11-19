# Serving a piece's stored outputs while they are current

Status: In progress. Stages 1, 2 and 4 are built behind
`SERVER_EXECUTION_CURRENCY_INDEX`, off by default, and have run only against
test fixtures. Stage 3, the measurement that decides whether `skip` is turned
on anywhere, is next. Stages 5 to 8 are not started.

A serving loop starts a piece whenever a session's demand reaches one of its
documents, and a fresh serving runtime runs every demanded computation of the
piece again. The store already holds what those computations wrote. This plan
keeps a durable record of which stored outputs are current, propagates a stale
mark through the store when an input changes, and has the serving loop start a
piece only when it is marked or a demanded output of it was never vouched for.

Two problems motivate it:

- **A start that derives nothing new.** A session that opens a board of
  3,264 Topics starts every Topic to learn that its stored outputs are what it
  would compute (`served-reference-reads.md`).
- **A stale output nothing recomputes.** Piece A writes document `a`. Piece B
  reads `a` and writes `b`. Piece C reads `b`. A session demands C and nothing
  of B's. The demand pass starts only the pieces that enclose C
  (`enclosingSourcesOnly`), so when `a` changed while B was not running, C
  reads the `b` that B derived last and nothing brings B back.
  `space-server-enclosing-start.test.ts` pins that a producer a demanded piece
  takes its input from stays unstarted.

The rule throughout: a start that was not needed is acceptable, and a stored
value served as current when it is not is the failure to design out. Every
case the record cannot decide starts the piece, as today.

## The design

### What is recorded

A piece is identified by the raw id of its result document, the
`pieceRootId` every action of the piece carries
(`schedulerObservationIdentity`). A nested instance is a piece of its own, and
its record names the pieces that enclose it (its `demandRootIds`). The index
holds identifiers and sequence numbers only, overwritten in place per piece:

- **The piece**: a mark, the enclosing pieces, and the epoch of the build
  that recorded it.
- **What it read**: one row per `(input space, input id)`, with the sequence
  number the piece saw that document at. Scope keys are left out, so a change
  to any instance of the document counts. The piece's own result document is
  always among them, so a change of its pattern pointer is a change to an
  input.
- **What it writes**: one row per document id in the declared write surface
  of every computation registered under the piece, whether or not that
  computation has run, with the sequence number the document stood at. The
  ids of the cells the piece owns are recorded beside them.
- **What it vouches for**: one row per document instance `(id, scope key)` a
  live, clean computation of the piece wrote, for each fan-out instance that
  is clean.

The write rows are what let a mark travel through a document no session
demands: they say which pieces a stale piece makes stale, and which absent
document a piece would write.

### When a record is taken

The space server takes a snapshot synchronously where a cycle closes its
wave, and where a cycle with nothing to commit returns, and only when all of
these hold:

- the settle did not exhaust its flush deadline and the scheduler is idle at
  that instant;
- the outbox holds no effect that is dispatched, held, or unretired.

The snapshot covers the pieces with a computation that changed status or
dependencies since the last one, which the scheduler's node registry reports.
The record is sent once the wave's commit has landed with every contribution
committed, or at once when the cycle commits nothing. A wave that dropped,
requeued, withdrew or aborted anything sends nothing, and its pieces are
snapshotted again by a later cycle.

Its `as_of` is the visible input head the settle covered
(`#visibleInputHead()`), not the batch head and not the watermark. The
sequence numbers of the loop's own derived commits above it, the wave's
included, travel with it as seen.

A piece's record says it is **not vouched for**, and is stored marked, when
any of these hold at the snapshot:

- a live computation under it is not clean, which covers one a throttle, a
  debounce or a convergence backoff is holding;
- it read a document in another space;
- it read a document whose writer in this runtime names no piece;
- its root is not space-scoped, or it records a source origin, since a start
  is where the serving runtime follows that origin.

### How a piece becomes marked

A mark is `0` clean, `1` a piece that writes one of its inputs is marked, or
`2` one of its own rows is behind.

When a record is stored, each read and write row takes the document's head
sequence number if every revision above `as_of` is one the record names as
seen, and `as_of` otherwise. A row behind its document's head marks the piece
`2` then and there, so a commit that landed between the snapshot and the
store is never lost. The serving runtime can already hold a commit above the
settle's visible input head, so a piece stored marked this way is snapshotted
again by the loop's next cycle, whose settle covers that commit.

A cursor names the sequence number the marks are complete through. Advancing
it reads the revisions above it (`idx_revision_branch`) and marks `2` every
clean piece with a read row or a write row for the changed id that is behind
the revision. Each piece that just became marked marks `1` every clean piece
that reads an id it writes, and so on, so the walk stops wherever it reaches
a piece that is already marked. A change to a document a piece writes marks
the piece itself, which covers an authored overwrite of a derived document.
A later record does not take that back: a write row moves up only to a head
a derivation put there, since the piece's writer reads nothing it writes and
so was not woken by the overwrite.

Nothing runs at admission. The serving loop advances the cursor once per
cycle that drained input and before each judgment below, so a quiet space
pays nothing and the cost follows the changes, not the size of the graph.

### How a mark is cleared

Only by storing a new record for the piece. After the rows are replaced the
piece is `2` if it is not vouched for or a row is behind, `1` if a piece that
writes one of its inputs is marked or has no record, and `0` otherwise. A
piece that became clean is a cleared input: each piece marked `1` that reads
an id it writes is judged again, and so on outward. A piece marked `2` stays
marked until its own record is replaced. This is what lets a recomputation
that wrote an equal value clear the pieces below it without starting them.

### What the demand pass does with it

The memory server judges, since it holds both the index and the sessions'
demand rows. For a root awaiting its first structure load whose piece is not
running, the space server asks whether the root's piece can be served from the
store. A root is not always a result document: a session that watches a
piece's argument makes a root of it, and a load of that root starts the piece
its `result` back-links lead to. The judgment follows the same links to the
piece. The store can serve a root when:

- the piece has a record, is clean, and was recorded under the current
  epoch;
- every demand row of every session whose id is written or owned by the
  piece, or by a recorded piece beneath it, passes: the owner is clean, and a
  written id is vouched for at the row's scope key, and an owned id is held
  by the store at the row's scope key.

A root that passes is not loaded and not started, and stays among the roots
awaiting a first load. It is judged again when demand changes and when it is
found running, which an event's auto-start can cause. When an advance marks
its piece, the root is re-armed at the marking sequence number through the
path a parked structure load takes (`#noteRearmed()`), so the watermark stays
below that input until the piece has started and derived. The marking
sequence number is the lowest one that reaches the piece, through whichever
marked piece it reads. An advance runs when the loop is told of a commit, so
this holds for the commits its own memory server admits. A root demanded by
a warm request is always loaded.

Two cases are decided on the cautious side and are worth revisiting with
measurements. A root is re-armed when a piece beneath it is marked, although
the judgment that follows passes it again when that piece owns no demanded
instance. And a root is judged on its own piece and the pieces beneath it,
not on the pieces that enclose it: a nested piece that reads what an
enclosing piece writes is marked through that read, and one that reads
nothing of it is unaffected.

The arrival seed and the arrival re-arm run only for a started piece. A
session whose demand reaches an owned scoped cell it holds no instance of
fails the second condition, so the piece starts and seeds it.

### Starting what is stale upstream

A marked piece that is not running, and that writes a document a running
demanded piece reads, is demanded by the loop itself. Its root joins the
structure load, indexed under the reading piece's demand keys the way an
enclosing piece is, so its runs carry the reader's demanders and a narrowed
writer computes their instances. The document enters the demanded entities so
its writers run. The loop asks the store for those producers after each
advance that marked something, following marked pieces upstream until it
reaches clean ones.

## Checking it before relying on it

`SERVER_EXECUTION_CURRENCY_INDEX=record` records and judges and still starts
everything. Each root the judgment would have served from the store is
counted (`currency.servable`), and when a piece the index held clean writes
an instance it vouched for again with no input of it changed, the judgment
was wrong: the count of those is `currency.falseClean`, logged with the
piece. Whether a piece had been clean is kept with its record, so a mark that
lands before the next record is stored does not hide it. `skip` acts on the
judgment, and only with `SERVER_EXECUTION_CURRENCY_EPOCH` set: a record is
trusted across builds only by the epoch it names, so a serving loop asked to
skip with no epoch named runs as `record` and logs a warning. `record` runs
on a real space until `falseClean` stays at zero before `skip` is turned on
there.

## What changes in the specifications

- `serving-loop.md` §3b and §6: the persisted scheduler state gains the
  currency index beside W, `eventWatermark` and the basis index; the index
  records write links, which §3b calls evidence when kept per run, and here
  are overwritten in place per piece; its rows are written by the memory
  server on a serving host's request, outside the wave's transaction.
- §1: a demand for a recorded, clean piece loads nothing, which is a rule for
  which pieces start.
- §3e: a piece that records a source origin is always started, so the origin
  is followed as it is today.
- §6 step 3: an effect whose result never landed is re-fired by a start, so a
  piece is not recorded while any effect is outstanding.
- §8: the exception that names the basis tables names these too.

## Known limits

- **A piece is recorded only after a cycle that ran it settled.** A piece
  served before the index was on starts on its first demand.
- **A piece is marked whole.** A computation that is not live when a record
  is taken contributes no reads and no vouch, so an undemanded part of a
  piece does not keep it marked. A computation that was live then, and that
  no session demands since, still has its reads in the record: a change to
  one of them marks the piece, which starts once on its next cold demand,
  and the record that start leaves no longer holds them.
- **A space with effects always in flight records nothing.** Attributing an
  outbox entry to its piece lifts this.
- **A piece with a source origin, a foreign read, or a root narrower than the
  space always starts.**
- **A write a computation makes outside its declared surface is not in the
  write rows.** A document written that way reads as an input nothing
  computes.
- **A view plan names no producers for a piece that is not started**
  (`viewExecutionNodes`). What a client with view-scoped replication does
  with that has to be checked in stage 3.
- **A crash loses what the last cycles would have recorded.** The affected
  pieces are marked by their own later commits and start again.

## Stages

1. **The index.** `runtime/memory/v2/currency-index.ts` and its tables
   (`currency_piece`, `currency_read`, `currency_write`, `currency_vouch`,
   `currency_under`, `currency_cursor`): store a batch of records, advance
   the cursor, judge roots against demand rows. The tables join the SQL
   guard's core names and the engine's table list.
2. **Recording, and judging without acting.** The scheduler reports the
   pieces whose computations changed and snapshots one piece. The space server
   takes snapshots and sends records through the memory server
   (`HostMemoryServer`, the worker port protocol). `record` mode judges each
   root it loads and counts `currency.servable` and `currency.falseClean`.
3. **Measure.** Run `record` on a copy of the Topics board: the share of
   roots judged servable for a new viewer and a returning one, `falseClean`,
   the cost of a judgment at 3,264 Topics, and what a client under
   view-scoped replication does with a piece that has no producers in its
   view plan. This decides whether stage 4 is turned on, and whether
   `served-reference-reads.md` question 1(a) and a narrower arrival seed are
   still worth building.
4. **Not starting a current piece.** `skip` mode: the demand pass leaves a
   servable root unloaded, re-judges it, and re-arms it when it is marked.
5. **Starting stale producers.** The index lists the marked producers of a
   set of pieces, and the loop demands them itself.
6. **Judging before activation.** The host judges when a session opens a
   parked space and activates only when a root fails or events are pending. A
   commit into a space with live sessions and no serving loop advances the
   cursor from the admission-side notice and activates when a demanded piece
   is marked.
7. **Releasing a piece when its last demand leaves**, the loop's own demand
   included (`serving-worker-heap.md`, step 3).
8. **Narrowing what always starts**: reads across spaces through the owner
   route, effects attributed to their piece, and an origin followed without a
   start.

## Acceptance tests

For the index, in `runtime/memory/test/`:

1. A revision above a read row marks the piece `2`; one at or below it marks
   nothing.
2. A revision on an id a piece writes, above its write row, marks the piece.
3. A marked piece marks `1` each clean piece that reads an id it writes,
   through any number of pieces, and a walk that reaches a marked piece goes
   no further.
4. A record stored after a commit that landed above its `as_of`, and that it
   does not name as seen, is stored marked `2`.
5. Storing a clean record for a marked piece clears each reader marked `1`
   that has no other marked producer; a reader marked `2` stays marked.
6. A piece that reads an id another recorded piece writes is `1` while that
   piece is marked, and a record that is not vouched for is stored `2`.
7. The cursor advances to the head, and a second advance with no commit reads
   nothing.
8. A root is judged servable only when its piece and every owner of a demand
   row beneath it is clean and vouches for the row's instance; an absent
   instance of an owned cell, a written id with no vouch row, a marked nested
   piece that owns a demanded row, and a record from another epoch each fail
   it.

For the serving loop, in `runtime/runner/test/executor/`, with real client
runtimes over `EmulatedStorageManager`. Tests 9 to 15 exist in
`space-server-currency.test.ts`, 10 and 11 with a client's own watches as
the demand as well. Test 16 exists at the snapshot alone, in
`runtime/runner/test/scheduler/piece-currency.test.ts`, with the store's half
in test 6; a serving-loop test with a real debounced computation is still to
write:

9. With the index off, nothing is recorded and every start happens as today.
10. In `record` mode a piece that settles is recorded clean, the next
    tenure's start of it is counted as servable, and `falseClean` stays zero.
11. In `skip` mode that piece is not started by the next tenure's demand for
    the same keys, and the session reads the stored values.
12. A change to an input of that piece, made while nothing served the space,
    starts it on the next demand, and the session reads the recomputed value.
13. A change to an input of a skipped piece while its session is live starts
    it, and the watermark does not pass the change before the piece derived.
14. A session whose demand reaches an owned scoped cell it holds no instance
    of starts the piece and is seeded.
15. A demand for an output of a recorded piece that no computation had
    written starts the piece.
16. A piece with a debounced computation still invalid at the settle is
    recorded marked.

For stage 5:

17. The A, B, C case: with all three recorded and none running, a change to
    `a` followed by a demand for C alone starts B, and C's session reads the
    value derived from the new `a`, including where B's writer is narrowed to
    the demanding user.
18. In that case, when B's recomputation leaves `b` equal, C is not started.

## Related

- `served-reference-reads.md`: the cost this removes for a recorded board, and
  the two questions stage 3 revisits.
- `serving-worker-heap.md`: step 2 (a demanded computation keeps its record and
  not its inputs) and step 3 (release on the last demand) build on the same
  record.
- labs #9911: removing `scheduler_basis`, which this index replaces the
  purpose of and does not read.
- labs #9788: the compiled pattern language keys the same kind of record by
  compiled instance and cone.
