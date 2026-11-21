# Serving a piece's stored outputs while they are current

Status: In progress. Stages 1 to 5 are built, with the index kept per viewer
slice, and a toolshed runs `skip` unless `SERVER_EXECUTION_CURRENCY_INDEX`
says otherwise. Stage 3 measured a
synthetic Topics board and a counter in the browser
([the record](../history/development/performance/2026-11-19-currency-index-topics-board.md));
a deployed space and the production board are not measured, and stage 5 is
not measured at all. Stages 6 to 8 are not started.
[`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md)
continues this plan for a piece that reads another space or a wish, and its
steps 1 to 3 come before stage 5.

A serving loop starts a piece whenever a session's demand reaches one of its
documents, and a fresh serving runtime runs every demanded computation of the
piece again. The store already holds what those computations wrote. This plan
keeps a durable record of which stored outputs are current, propagates a stale
mark through the store when an input changes, and has the serving loop start a
piece only when it is marked or a demanded output of it was never vouched for.

Two problems motivate it:

- **A start that derives nothing new.** A session that opens a board of
  3,264 Topics starts every Topic to learn that its stored outputs are what it
  would compute (`served-reference-reads.md`, which labs #9998 adds).
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
its record names the pieces that enclose it (its `demandRootIds`).

A piece is recorded in **slices**, one for each scope key its computations
ran at. A computation that reads nothing narrower than the space runs once,
and belongs to the `space` slice. One that reads a user's or a session's
state runs once for each viewer who demands it, and each of those runs
belongs to the slice at that viewer's key (`user:<principal>` or
`session:<principal>:<session>`). The scheduler already keeps each such run's
reads and its clean bit apart (`FanOutNodeState`), so a slice is that state
written down.

The index holds identifiers and sequence numbers, and for a slice that read
a clock the time it expires at, overwritten in place. The slice leads every
key, so reading one viewer's slices reads no other viewer's rows:

- **The slice**: a mark, and the epoch of the build that recorded it. Every
  recorded piece has a `space` slice.
- **What a slice read**: one row per document instance, `(input space, input
  id, scope key)`, with the sequence number the slice saw that instance at. A
  read whose instance the run does not name is recorded against every
  instance of the document. The piece's own result document is among the
  reads of every slice, so a change of its pattern pointer is a change to an
  input of each.
- **What a slice vouches for**: one row per document instance a live, clean
  computation of the piece wrote, filed under the slice at the instance's own
  key, with the sequence number the instance stood at. A run for one session
  that writes a document declared in the space writes its value at that
  session's key and a redirect at the user's and the space's, so it files a
  row in each of those three slices. Redirects go no broader than the
  document's declared scope: a document declared for a user gets the
  session's row and the user's, and one declared for a session the session's
  alone.
- **What the piece writes**, whoever it runs for: one row per document id in
  the declared write surface of every computation registered under it,
  whether or not that computation has run, and the ids of the cells it owns.
  The enclosing pieces are kept beside them.

The write rows are what let a mark travel through a document no session
demands: they say which pieces a stale piece makes stale, and which absent
document a piece would write.

A record replaces the slices it names and the piece's write rows, and leaves
every other slice of the piece as it is. A serving runtime holds the runs of
the viewers demanding the piece now, so a record taken while one viewer is
present names the `space` slice and that viewer's, and another viewer's
slices keep what their last visit recorded.

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

A slice is **not vouched for**, and is stored marked, when any of these hold
of its runs at the snapshot:

- a live computation is not clean, which covers one a throttle, a debounce
  or a convergence backoff is holding;
- one read a document in another space at no one instance, at a seq its
  replica cannot name, at a user's or a session's own instance whose actor
  holds no READ grant on that space, or in a space whose store another
  memory server holds;
- one read a document whose writer in this runtime names no piece and
  cannot be answered for. A writer that is live, clean and runs once is
  answered for by the slice, which takes over what it read.

A slice that read a document a clock writes, which is the interval cell of
a wish for `#now/N`, is vouched for until the tick after the one that
document holds. No commit marks it when the interval passes while no
runtime holds the clock, so its record names that time, and the index marks
the slice once it has come
([`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md),
"The interval clock").

Any other read in another space is registered with that space's index when
the record is stored
([`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md)),
and the slice is stored against what that index reports. That space tells
the reading one of its next change, so the slice is a current input of
another slice while it is clean.

No slice of a piece is vouched for when its root is not space-scoped, when a
computation of it declares a write in another space, or when it records a
source origin, since a start is where the serving runtime follows that
origin.

### How a slice becomes marked

A mark is `0` clean, `1` one of its inputs is stale, or `2` one of its own
rows is behind, the slice was not vouched for, or the time its record
expires at has come. An input is stale while a slice that decides it is
marked, and in the two cases without a marked producer that "How a mark is
cleared" lists.

When a record is stored, each read row and each vouch row takes its
instance's head sequence number if every revision of that instance above
`as_of` is one the record names as seen, and `as_of` otherwise. A row behind
its instance's head marks the slice `2` then and there, so a commit that
landed between the snapshot and the store is never lost. The serving runtime
can already hold a commit above the settle's visible input head, so a piece
with a slice stored marked this way is snapshotted again by the loop's next
cycle, whose settle covers that commit.

A cursor names the sequence number the marks are complete through. Advancing
it reads the revisions above it (`idx_revision_branch`), and for each
instance that changed marks `2`:

- every slice with a read row for that instance that is behind the revision;
- the slice at the instance's own key of each piece that vouches for it,
  which covers an authored overwrite of a derived document.

A change to one viewer's instance therefore marks the slices that read that
instance, which are that viewer's, and a change to a shared instance marks
every slice that read it. The exception is a read recorded against every
instance of a document, which a change to any viewer's instance of it is
ahead of.
A later record does not take an overwrite back: a vouch row moves up only to
a head a derivation put there, since the piece's writer reads nothing it
writes and so was not woken by the overwrite. A vouch row a record no longer
names is released and kept for its sequence number, so the overwrite is
still known when the piece vouches for the instance again. A record taken
below a commit to an instance answers for it at no sequence number: its
vouch row keeps the one the piece last answered at, and is not written for
a piece that never did, so a client's first write of an instance is not
taken for an overwrite once a later record covers it.

Each slice that just became marked marks `1` every clean slice of another
piece that reads an instance it writes, at its own key or narrower beneath
it: a `space` slice reaches every reader, a user's slice that user's and
their sessions', and a session's slice that session's. The walk goes on from
each slice it marks and stops wherever it reaches one that is already
marked.

Advancing the cursor also marks `2` each slice whose record expires at a
time that has come, and what is downstream of it as above. No revision
made such a slice stale, so it is reported at a sequence number above the
store's head.

Nothing runs at admission. The serving loop advances the cursor once per
cycle that drained input and before each judgment below, so a quiet space
pays nothing and the cost follows the changes, not the size of the graph.

### How a mark is cleared

Only by storing a new record of the slice. After its rows are replaced a
slice is `2` if it is not vouched for or a row is behind, `1` if one of its
inputs is stale, and `0` otherwise. An input is stale when:

- a slice that decides it is marked, a broader slice of the same piece
  included;
- it is a derived document no recorded piece writes. A document whose only
  writer names no piece, and which the slice answers for, is not one of
  these: the slice took over what that writer read, and records the
  document as an input;
- a recorded piece computes it and no piece vouches for the instance read. A
  record taken while a computation was not running drops its vouches, and
  marks `1` each clean slice that read one of those instances. A viewer's
  retained slice that read what the `space` slice computed is the case this
  is for: the `space` slice re-recorded without that computation is clean,
  and what the viewer's slice read is no longer anyone's to vouch for.

A slice that became clean is a cleared input: each slice marked `1` that
reads an instance it writes is judged again, and so on outward. A slice
marked `2` stays marked until its own record is replaced, which for a
viewer's slice is that viewer's next visit. This is what lets a
recomputation that wrote an equal value clear the slices below it without
starting their pieces.

### What the demand pass does with it

The memory server judges, since it holds both the index and the sessions'
demand rows. For a root awaiting its first structure load whose piece is not
running, the space server asks whether the root's piece can be served from the
store. A root is not always a result document: a session that watches a
piece's argument, or a computed document the piece derives, makes a root of
it, and a load of that root starts the piece its `result` back-links lead to.
The judgment follows the same links to the piece, and reads a computed
document as the one piece the index records as writing it where there is
one. A computed document is judged at any scope, so a viewer's own instance
of one can pass, and a root that passes is left unstarted under `skip` as
below. The store can serve a root when:

- the piece's `space` slice is clean and was recorded under the current
  epoch;
- every demand row of every session whose id is written or owned by the
  piece, or by a recorded piece beneath it, passes: each slice of the owner
  the row's instance is resolved under (the slice at the row's scope key and
  each broader one) is clean and of the current epoch, and a written id is
  vouched for in the slice at the row's scope key, and an owned id is held by
  the store at the row's scope key.

Only the slices a demand row is resolved under are read, and the rows are
those of the sessions demanding now. So a marked slice of a viewer who is
not present refuses nothing, and a viewer whose slices are clean is served
from the store. A root is loaded for every session or for none: when a
viewer who is present has a marked slice the piece starts, and it then runs
for each viewer demanding it.

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

A root that is stale only through what is upstream of it is not made current
by starting its piece, which would derive from what the store holds. The
judgment tells such a root from one whose own piece is behind, and names what
to start for it.

A slice marked `1` is stale only upstream when each read that keeps it stale
is of an instance another recorded piece is to bring up to date. That is an
instance a piece behind on its own rows decides, reached through any number of
slices marked `1` between, or an instance a recorded piece writes and none
vouches for, as a viewer's own instance is before that piece has run for the
viewer. A slice kept stale by anything else is not: a derived document no
recorded piece writes, an instance of another space, a read that names no one
instance. A root that would pass but for slices stale only upstream is
**held**, whether those are slices of its own piece or of a piece beneath it
that a demanded instance is resolved under, and the judgment names the pieces
whose slices hold it. Under `skip` it is left unloaded, as a root the store
can serve is, and is judged again when a slice's record expires as such a
root is. Under `record` it is loaded, and each of those pieces is then one
that runs and is stale upstream.

The loop demands the instances those reads name, for the pairs the reads were
made for. It does so as demand carried into its own space: the rows stand in
the space's demand set as a session's would, the memory server adds a row for
each piece the index records as writing the instance, and the demand pass
loads and starts that piece like any demanded one. So the piece runs for the
reader's demanders, and a writer narrowed to a viewer computes that viewer's
instance. In the chain A, B, C, a demand for C names A's output as read by B,
starts A, and holds C. Where A derives a new value, B's row is then behind,
the next judgment names B's output, and B starts. Where A derives the value it
held, the marks of B and C clear, and C is served from the store without B or
C starting.

A piece that runs and reads the output of one that does not is found stale the
same way. The loop advances the cursor on each cycle that drained input while
such a piece runs, and each piece a commit or a stored record marked, that
runs, is asked about in the next judgment. A change no input of the space
reports reaches such a piece through a judgment too: when another space tells
this one of a change, or a slice's record expires, the loop asks about each
piece that runs and reads the output of one that does not. A run withdrawn
for a scoped instance its writer has not produced for the run's viewer
demands that instance the same way.

While a root is held, or a running piece is stale upstream, the watermark does
not advance. The pieces upstream run, their records are stored, and the
judgment that follows either finds the root servable or finds its own piece
behind and loads it; the watermark moves once neither is left. The records of
the pieces that ran are taken as of the inputs the settle covered, and not as
of the held watermark.

The loop gives up on what is upstream of a root or a running piece when none
of the pieces named for it can change the judgment: one whose load ended
without a start, one that ran and was recorded with the reader stale still,
and one that ran in a cycle that ended where no record could be taken. Once
the loop has given up on what is upstream of each piece whose slices hold a
root, that root is loaded, as a refused one is, and is not held again while
the same pieces are named for them. `currency.upstreamAbandoned` counts the
pieces given up on.

A hold ends at a judgment, and a judgment follows a change in demand, a
stored record or a mark. So that a hold cannot outlast the work that could
clear it, the loop checks before it rests: with something stale upstream and
no judgment, load, commit, run or record under way, the first such rest has
the next cycle judge again, and the second in a row gives up on everything
stale upstream.

The demanded rows are withdrawn once nothing is stale upstream, so a piece
started this way stays running and is no longer demanded for the reader's
viewers. The next change upstream of it is found through the index again,
which takes a cycle or two in which the watermark can pass the change before
the reader is found stale.

## Checking it before relying on it

`SERVER_EXECUTION_CURRENCY_INDEX=record` records and judges and still starts
everything. Each root the judgment would have served from the store is
counted (`currency.servable`), and when a piece the index held clean writes
an instance it vouched for again, to a value other than the one it held,
with no input of it changed, the judgment was wrong: the count of those is
`currency.falseClean`, logged with the piece. A start derives every output
of a piece afresh, those of a current slice among them, so an instance
written again as it stood is not counted. Whether a piece had been clean is
kept with its record, so a mark that lands before the next record is stored
does not hide it. `skip` acts on the
judgment, and only under an epoch: a record is trusted across builds only by
the epoch it names, so a serving loop asked to skip with no epoch named runs
as `record` and logs a warning. A toolshed's epoch is
`SERVER_EXECUTION_CURRENCY_EPOCH`, or else the commit baked into a compiled
binary, or else one made up for the process, since a source run's checkout
can change under the commit it names.

A toolshed runs `skip` by default. `falseClean` is still counted there, for
each piece that does start, and `SERVER_EXECUTION_CURRENCY_INDEX=record` on a
deployment starts every piece and counts every judgment that would have been
wrong.

## What changes in the specifications

- `serving-loop.md` §3b and §6: the persisted scheduler state gains the
  currency index beside W, `eventWatermark` and the basis index; the index
  records write links, which §3b calls evidence when kept per run, and here
  are overwritten in place per slice of a piece; its rows are written by the memory
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
- **A slice is marked whole.** A computation that is not live when a record
  is taken contributes no reads and no vouch, so an undemanded part of a
  piece does not keep it marked. A computation that was live then, and that
  no session demands since, still has its reads in its slice: a change to
  one of them marks the slice, whose viewers start the piece once on their
  next cold demand, and the record that start leaves no longer holds them.
- **A slice outlives its session.** Nothing removes the slices of a session
  that ended. No judgment reads them, since no demand row is resolved under
  them, and an advance that finds a shared document changed reads the rows
  of each of them that read it. Removing them belongs with removing the
  session's documents.
- **A space with effects always in flight records nothing.** Attributing an
  outbox entry to its piece lifts this.
- **A piece with a source origin, or a root narrower than the space, always
  starts.**
- **A write a computation makes outside its declared surface is not in the
  write rows.** A document written that way reads as an input nothing
  computes.
  [`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md),
  under "Computations that run without demand", is the plan for it and for
  a materializer's envelope.
- **A view plan names no producers for a piece that is not started**
  (`viewExecutionNodes`). A browser client renders such a piece from the
  store, checked on a counter in the shell; a pattern whose view depends on
  a producer's proof has not been checked.
- **A judgment reads every demand row of the space's sessions**, at about
  15 µs each on the memory server's thread.
- **A piece whose output depends on something that is not a read** is held
  clean while what it would compute moves. The interval clock of a wish is
  the one such input the index knows, and a slice that read it expires at
  the tick after the one it read.
- **A crash loses what the last cycles would have recorded.** The affected
  pieces are marked by their own later commits and start again.

## Stages

1. **The index.** `runtime/memory/v2/currency-index.ts` and its tables
   (`currency_slice`, `currency_read`, `currency_write`, `currency_vouch`,
   `currency_under`, `currency_cursor`, and `currency_expiry` for the time a
   slice that read a clock expires at): store a batch of records, advance
   the cursor, judge roots against demand rows. The tables join the SQL
   guard's core names and the engine's table list.
2. **Recording, and judging without acting.** The scheduler reports the
   pieces whose computations changed and snapshots one piece. The space server
   takes snapshots and sends records through the memory server
   (`HostMemoryServer`, the worker port protocol). `record` mode judges each
   root it loads and counts `currency.servable` and `currency.falseClean`.
3. **Measure.** Done on a synthetic board of 50 and of 200 Topics under a
   serving worker, and on a counter in the browser
   ([the record](../history/development/performance/2026-11-19-currency-index-topics-board.md)).
   A new viewer of 200 recorded Topics has every Topic judged servable; with
   `skip` the view takes 1.9 seconds where it took 70, writes no document
   where it wrote 3,602, and leaves the worker at 51 MB where it held 471.
   `falseClean` stayed at zero. A browser client renders a piece the server
   left unstarted, and an event starts it. Two things are still owed. A
   judgment costs about 15 µs for each demand row the space's sessions hold,
   on the memory server's thread, which is about 0.7 seconds for a session
   demanding every instance of a 3,264-Topic board; judging only the rows
   that changed removes that. And neither a copy of the production board nor
   a deployed space has been measured.
4. **Not starting a current piece.** `skip` mode: the demand pass leaves a
   servable root unloaded, re-judges it, and re-arms it when it is marked.
5. **Starting stale producers.** Built, as "Starting what is stale upstream"
   says: a judgment holds a root that is stale only upstream and names the
   instances to demand, and the loop demands them in its own space the way
   it carries demand into another
   ([`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md),
   step 5). What it costs is not measured.
6. **Judging before activation.** The host judges when a session opens a
   parked space and activates only when a root fails or events are pending. A
   commit into a space with live sessions and no serving loop advances the
   cursor from the admission-side notice and activates when a demanded piece
   is marked.
7. **Releasing a piece when its last demand leaves**, the loop's own demand
   included (`serving-worker-heap.md`, step 3).
8. **Narrowing what always starts**: effects attributed to their piece, and
   an origin followed without a start. Reads across spaces have a plan of
   their own
   ([`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md)).

## Acceptance tests

For the index, in `runtime/memory/test/`:

1. A revision of an instance above a slice's read row for it marks the slice
   `2`; one at or below it marks nothing.
2. A revision of an instance a piece vouches for, above its vouch row, marks
   the slice at the instance's key; a revision of a document the piece
   writes and does not vouch for marks nothing.
3. A marked slice marks `1` each clean slice that reads an instance it
   writes, through any number of pieces, and a walk that reaches a marked
   slice goes no further.
4. A record stored after a commit that landed above its `as_of`, and that it
   does not name as seen, is stored marked `2`.
5. Storing a clean record of a marked slice clears each reader marked `1`
   that is left with no stale input; a reader marked `2` stays marked.
6. A slice that reads an instance another recorded piece writes is `1` while
   a slice that decides it is marked, and while no piece vouches for it; a
   record that is not vouched for is stored `2`.
7. The cursor advances to the head, and a second advance with no commit reads
   nothing.
8. A root is judged servable only when its piece's `space` slice is clean,
   and every slice a demand row beneath it is resolved under is clean and
   the row's instance is vouched for; an absent instance of an owned cell, a
   written id with no vouch row, a marked nested piece that owns a demanded
   row, and a record from another epoch each fail it.

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

For stage 5, all of which exist in
`runtime/runner/test/executor/space-server-currency-upstream.test.ts`, over
a chain in which A derives `a` from an input, B derives `b` from `a`, and C
derives `c` from `b`:

17. With all three recorded and none running, a change to A's input
    followed by a demand for C alone starts A and B, and C's session reads
    the value derived from the new input, including where B's writer is
    narrowed to the demanding user.
18. In that case, when A's recomputation leaves `a` equal, neither B nor C
    is started, and all three are left clean.

The same file holds three cases beside them. The watermark does not reach
a change to A's input before the store holds what C derives from it. A C
that runs already, under `record`, is brought the new value. And a viewer B
never ran for, who demands C alone with nothing changed, has B started for
them.

For slices, in the index tests and in `space-server-currency.test.ts`, all
of which exist:

19. A change to one viewer's instance marks the slices that read it and no
    other viewer's, and a change to a shared instance marks every slice that
    read it.
20. A record leaves a slice it does not name with its rows and its mark.
21. A root is judged servable for a viewer whose slices are clean while
    another viewer's slice is marked, and refused for that other viewer.
22. A piece recorded for one viewer, then started and recorded for a second,
    is not started when the first returns.
23. A viewer's slice that read what the `space` slice computed is marked `1`
    once a record of the `space` slice no longer vouches for it, and cleared
    once one vouches for it again with the instance unchanged.
24. An output that was overwritten, that one record stops vouching for and a
    later one vouches for again, is stored marked.
25. A piece whose first record was taken below a client's write of an
    instance it vouches for is stored clean once a record covers that
    write.
26. A slice that read the interval clock of a wish is stored with the time
    of the tick after the one the clock's cell holds. Under `skip` its
    piece is left unstarted within the interval and started once it has
    passed, for a session that runs nothing itself
    (`space-server-currency-wish.test.ts`).

## Related

- [`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md):
  the index for a slice that read another space, a wish's own computations,
  and the interval clock.
- `served-reference-reads.md` (labs #9998): the cost this removes for a
  recorded board. Its question 1(a), a resolution watch that is not demand,
  and its question 2, a narrower arrival seed, save a start only for a piece
  the index cannot vouch for.
- `serving-worker-heap.md`: step 2 (a demanded computation keeps its record and
  not its inputs) and step 3 (release on the last demand) build on the same
  record.
- labs #9911: removing `scheduler_basis`, which this index replaces the
  purpose of and does not read.
- labs #9788: the compiled pattern language keys the same kind of record by
  compiled instance and cone.
