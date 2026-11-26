# Serving a piece's stored outputs while they are current

Status: In progress. Stages 1 to 5 are built, with the index kept per viewer
slice, and a toolshed runs `skip` unless `SERVER_EXECUTION_CURRENCY_INDEX`
says otherwise; stage 5 runs only under `start-upstream` and `record`
("The modes", below). Stage 3 measured a
synthetic Topics board and a counter in the browser
([the record](../history/development/performance/2026-11-19-currency-index-topics-board.md));
a deployed space and the production board are not measured, and stage 5 is
not measured at all. Stages 6 to 9 are not started; stage 9, marking by
path, is designed under "Marking by path".
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

The rule has one exception, a document the index cannot account for. A
document is either kept up to date by the recorded pieces that write it,
or written by something no record names: a computation of a piece with no
record, one that writes outside its declared surface, a setup run, a
handler. A slice that read a document of the second kind treats it as an
input. Its readers are marked when it changes, through their read rows, and
not because its writer might run again: a reader may serve what it derived
from such a document while the document's writer has not run since an
input of that writer changed, and that is accepted, in preference to
starting pieces to catch it ("Known limits"). One case of it is still held
stale, so that a reader does not pass on what a piece's setup left before
the piece ran: a cell of a piece the index holds no record of.

## The modes

`SERVER_EXECUTION_CURRENCY_INDEX` on a toolshed, or
`SpaceServerPolicy.currencyIndex`, selects what a serving loop does with the
index. The names are `CURRENCY_INDEX_MODES` in
`runtime/runner/src/executor/store-currency.ts`, and a toolshed's default is
`DEFAULT_CURRENCY_INDEX` in `runtime/toolshed/lib/server-execution.ts`.

- `off`: no index. Every demanded piece starts.
- `record`: the loop records and judges, and starts every demanded piece
  ("Checking it before relying on it").
- `skip`, a toolshed's default: the loop leaves unstarted a root the record
  proves current ("What the demand pass does with it"), does nothing else
  on a judgment, and carries no demand, into another space or its own. This
  answers the first of the two problems above and not the second.
- `start-upstream`: a root the record proves current is left unstarted, as
  under `skip`. Where a root is stale only through what is upstream of it,
  the loop leaves it unloaded and starts the pieces upstream, and it does
  the same for a running piece that is stale that way ("Starting what is
  stale upstream"). This answers the second problem too.

The two levels differ in the upstream starts and in the demand the loop
carries, so a deployment can run `skip` without either. Under `skip` a root that is stale only upstream
is treated as a root the judgment refuses: its piece starts, and derives
from what the store holds of the pieces upstream, as a loop with no index
derives it. "Known limits" says what that leaves.

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

- **The slice**: a mark, and the epoch it was recorded under. Every
  recorded piece has a `space` slice.
- **What a slice read**: one row per document instance, `(input space, input
  id, scope key)`, with the sequence number the slice saw that instance at. A
  read whose instance the run does not name is recorded against every
  instance of the document. The piece's own result document is among the
  reads of every slice, so a change of its pattern pointer is a change to an
  input of each.
- **What a slice vouches for**: one row per document instance a live, clean
  computation of the piece wrote in a run at the slice's key, with the
  sequence number the instance stood at. A run for one session that writes a
  document declared in the space writes its value at that session's key and
  a redirect at the user's and the space's, and all three rows are filed
  under the session's slice: the value as an instance it vouches for, and
  each redirect as a **slot it decides**, with the key the slot is at.
  Redirects go no broader than the document's declared scope. A run at a
  broader key that writes a narrower instance for the identity it ran under
  files that instance the same way. "An instance a run at another key
  decides", below, says why.
- **What the piece writes**, whoever it runs for: one row per document id in
  the declared write surface of every computation registered under it,
  whether or not that computation has run, and the ids of the cells it owns
  that are owed a default, each with whether an absent instance of it reads
  as that default ("What the demand pass does with it"). The enclosing
  pieces are kept beside them.

The write rows are what let a mark travel through a document no session
demands: they say which pieces a stale piece makes stale, and which absent
document a piece would write.

A record names the slices a live computation of the piece ran at when it was
taken. It replaces those slices and the piece's write rows, and leaves every
other viewer's slice of the piece as it is. A serving runtime holds the runs
of the viewers demanding the piece now, so a record taken while one viewer is
present names that viewer's slice, and the `space` slice where a computation
every viewer shares is live, and another viewer's slices keep what their last
visit recorded.

A record that names no `space` slice is one taken while no live computation
ran at the space's key. A runtime takes such a record of a piece it holds and
does not run. An enclosing piece's start instantiates every piece beneath
it, and the computations of one of those are live only while a session
demands what they write or a live computation reads it: a viewer of the
enclosing piece who demands nothing of the inner one leaves it without one,
and so does a viewer who left before the loop reached it. The record has
nothing to put in the slice's place, so:

- a `space` slice that is clean and of the recording epoch is left as it is,
  where the record is vouched for. Its rows are the ones a clean run left,
  and a change to an instance it read or vouches for marks it from then on
  as it marks the slice of a viewer who is away, so keeping it makes nothing
  servable that the rows do not prove;
- any other `space` slice is replaced by one that read nothing and vouches
  for nothing, and a piece with no record is given such a slice. A slice
  that is marked or of another epoch passes no judgment, and left in place
  it would stay so, with its piece started on each demand, for as long as no
  session demands what its computations wrote.

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

No slice of a piece is vouched for when a computation of it declares a
write in another space.

A piece whose result document is declared narrower than the space, as a
pattern instantiated at a user's or a session's scope is, is recorded like
any other. Each viewer holds an instance of that document, with the pattern
pointer the piece runs for them, and the serving runtime runs one program
for each pointer those instances hold, each viewer's computations at their
own key. Those runs are the piece's slices, and the read of the viewer's
own instance is among each slice's reads. What the record needs of the
piece itself, the cells it owns that are owed a default, is taken over the
programs it runs.

A piece that records a source origin is vouched for like any other, and its
record says that it records one. A start is where the serving runtime
follows a piece's origin, so before the loop first leaves a root unstarted
in a tenure it follows the origin of each piece the root rests on that
records one: the root's own piece and those beneath it. The follow needs
the piece's result document and not the piece, and a piece that holds an
instance of that document for each viewer has no one document to follow
through: where one of its instances records an origin, the piece is not
vouched for. Where the origin has not
moved the root stays unstarted, and where the piece adopted new source the
root is loaded, so the piece starts on that source. What the store holds
of the root is what a client reads while the follow runs.

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
- it is a derived document no recorded piece writes that no computation
  may have produced yet: the store holds no instance of it, or it is a cell
  of a piece the index holds no record of, by the `result` back-link its
  piece's setup writes. Setup writes a piece's cells before its
  computations run, a default into some, and only the piece's record,
  whose write rows name the cells its computations write, tells those from
  the rest. Any other derived document no recorded piece writes is an input
  like any other, and marks its readers when it changes. A
  document whose only writer names no piece, and which the slice answers
  for, is an input too: the slice took over what that writer read;
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
of one can pass, and a root that passes is left unstarted under `skip` and
`start-upstream` as below.

A space-scoped root that is no `computed:` document, and whose stored
document is absent or carries neither a `result` field nor a pattern
pointer, is one a load starts no piece from: the load reads that document,
finds no back-link to follow and no pattern pointer, and parks the root
watching the document. The elements and views a list renders are such
documents. The judgment tests the pattern pointer with the function the
load tests it with (`asPatternIdentityRef()`), and returns such a root as
**plain**, whatever writes it. Under `skip` and `start-upstream` the loop
parks a plain root as that load would, without the load: terminal, watching
the document, so that a commit to it, one that gives it a back-link or a
pattern pointer among them, brings the load. The pass still syncs the
document into the serving replica with the roots it loads, as the load's
first step would, since a read on the serving runtime that does not sync
finds only what the replica holds; a root whose sync fails is loaded in the
same pass. A commit admitted while the
judgment ran leaves it to be loaded at once. Under `record` it is loaded.
`currency.plainRoots` counts such roots under every mode. A root demanded
at a scope narrower than the space is not judged so and is loaded, since its
load reads the instance at that scope before the space's.

Since no load of a plain root starts a piece, whether its stored value is
current changes nothing the loop does for it, and the judgment does not
ask. A document a recorded piece maintains is brought up to date when that
piece runs. One written by something the index cannot account for, such as
a client or a lift's write through `Writable.for(...).set()`, is read as the
store holds it until its writer runs for some other reason: that staleness
is accepted in preference to the work of finding and starting a writer for
each such document.

The store can serve a root when:

- the piece's `space` slice is clean and was recorded under the current
  epoch;
- every demand row of every session whose id is written or owned by the
  piece, or by a recorded piece beneath it, passes: each slice of the owner
  the row's instance is resolved under (the slice at the row's scope key and
  each broader one) is clean and of the current epoch, and a written id is
  answered for, and an owned id is held by the store at the row's scope key
  or has a scalar default, as below.
  A written id is answered for by a vouch row in the slice at the row's
  scope key, or, where a run at another key wrote the instance, by the rows
  the slices of the demanding session's own chain hold for it ("An instance
  a run at another key decides", below).

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

The arrival seed and the arrival re-arm run only for a started piece. An
owned cell scoped narrower than its piece's result is owed a default, which
the seed writes into the instance of each viewer who demands the piece, and
a reader of an instance the store does not hold reads the cell's schema
default. Where that default is a scalar the two are the same value, and a
write to the cell replaces the whole value, so an absent instance of such a
cell reads as current and refuses nothing: a new session of a board that
owns a per-session text field is served from the store. Where the default
is an object or an array they can differ: a viewer's first write into a
part of an absent instance creates the instance holding that part alone,
where a seed would have written the rest of the default beside it. A
session whose demand reaches such a cell it holds no instance of fails the
second condition, so the piece starts and seeds it. An owned cell that a
computation of the piece also writes is a written id, and is judged as
one. A cell's initial value is its schema default and can only be static
data, so no argument of the piece decides what the seed writes.

The record says which owned cells have a scalar default
(`CurrencyRecord.absentAsDefault`), stored as `owned = 2` in
`currency_write` beside `1` for any other owned cell and `0` for a written
id. A piece that owns an id under two programs keeps the lower value, and
so does one that owns and writes it. A row stored as `1` keeps refusing
until the piece's next record, which the start it causes takes, so a store
whose records name no such cells needs no new epoch.

### Starting what is stale upstream

A root that is stale only through what is upstream of it is not made current
by starting its piece, which would derive from what the store holds. The
judgment tells such a root from one whose own piece is behind, and names what
to start for it. The judgment is the same in every mode. What this section
says the loop does with it holds under `start-upstream`, and under `record`
for a piece that runs; "Under `skip`", at the end of the section, says what
a `skip` loop does instead.

A slice marked `1` is stale only upstream when each read that keeps it stale
is of an instance another recorded piece is to bring up to date. That is an
instance a piece behind on its own rows decides, reached through any number of
slices marked `1` between, or an instance a recorded piece writes and none
vouches for, as a viewer's own instance is before that piece has run for the
viewer. A slice kept stale by anything else is not: a derived document no
recorded piece writes and no computation may have produced, an instance of
another space, a read that names no one
instance, or an instance of a piece whose record was stored not vouched for.
That last piece has run and been recorded, and a further run is recorded the
same way, so starting it clears nothing; the index keeps, for each slice,
whether its record was stored not vouched for. A root that would pass but for slices stale only upstream is
**held**, whether those are slices of its own piece or of a piece beneath it
that a demanded instance is resolved under, and the judgment names the pieces
whose slices hold it. Under `start-upstream` it is left unloaded, as a root
the store can serve is, and is judged again when a slice's record expires as
such a root is, as is a piece that runs and is stale upstream. Under `record`
it is loaded, and each of those pieces is then one that runs and is stale
upstream.

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
reports, from another space or from a record that expires, reaches such a
piece at the space's next input and no sooner: asking about every such piece
at each change from outside was measured at some 18,000 wakes of the loop in
one FabriChat benchmark run, against 77 without it, and was left out. A run
withdrawn for a scoped instance its writer has not produced for the run's
viewer demands that instance the same way.

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

A piece that runs and that each stored record leaves stale, with nothing
upstream to start, is asked about once: a further record that leaves it stale
asks nothing, and a slice of it newly marked asks again.

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

**Under `skip`.** The loop takes none of the reads a judgment names. A held
root is loaded and its piece started, as a root the judgment refuses is, and
`currency.refused` counts it under `stale-upstream`, a reason of the loop's
own that the memory server's judgment does not return. No instance is
demanded for it, so no piece upstream starts on its account, the watermark
is not held, and nothing is waited on or given up on:
`currency.heldUpstream` and `currency.upstreamAbandoned` stay zero. A piece
that runs and is found stale upstream is left as it is, and the loop does
not advance the cursor on its account. In the chain A, B, C, a demand for C after a
change to A's input starts C alone, and C's session reads what C derives
from the `b` the store holds. The record of C that follows is stored marked
`1`, since its input is still stale, so the store serves no root that rests
on it, and the next cold demand for C starts it again. A root is left
unstarted on the same judgment in both modes: `skip` changes only what the
loop does with a root the judgment does not pass.

### An instance a run at another key decides

*(RULED 2026-11-22.)* A run writes more than the instance at its own key. A
run for one session that writes a document declared in the space writes its
value at the session's key and a redirect at the user's and the space's, and
a run can as well write a link into a shared document whose content depends
on what that run resolved, as the result of a conditional does. The slot at
the broader key is shared, and what it holds was decided by the narrower
run: by that run's reads, which are in the run's slice. A later run for
another viewer, or the node's run at the space once no viewer narrows it,
may write the slot again, broader or narrower than it stood. Either
direction is allowed.

A row for such a slot filed under the slice at the slot's own key would have
the `space` slice vouch for a document none of its reads decide. The
FabriChat room benchmark showed that as a count of false clean pieces: six
message pieces whose shared link to a conditional's result flips between the
session's and the space's scope on each visit, with no read of the `space`
slice changed. So:

- **A row is filed under the slice of the run that wrote the instance**, and
  names the key the instance is at. A slice answers for what its own runs
  wrote, at its key or at another, and for nothing another slice's run
  wrote. The reads that decided a slot and the row that answers for it are
  then in one slice.
- **A slot can have several such rows**, one for each slice whose runs wrote
  it. Each stands at the sequence number the slot was at when its slice was
  recorded. A later write of the slot by another slice's run leaves the
  earlier rows behind, and a row behind the slot's head answers for
  nothing. It marks no slice: what else the slice answers for is as current
  as it was.
- **A snapshot names a slot for a slice only while the slot holds what the
  slice's run left there.** A run's declared writes reach the slot whichever
  run wrote it last, so the scheduler keeps, for each node that runs once
  for each viewer, the latest change to each instance of a document the node
  writes, and the run that made it, as its replica reports changes. The
  slot holds a run's write where that run made the latest change, or where
  nothing has changed the slot since that run handed its writes over: a run
  that writes what the slot already held changes nothing, and the slot is
  then as much its own as the earlier run's. Two viewers whose runs write
  the slot alike both answer for it, and two whose runs write it differently
  answer for it one at a time: the earlier slice's record names the slot as
  one that holds a later write, and its row is stored behind the slot's
  head until the slice's computation runs again. The row stays so that the
  slot is not taken for one the slice's runs never wrote, which the slice at
  the slot's own key could answer for. A change that is no run's, one the
  store pushed or a write taken back, leaves the slot answered for by none
  of them.
- **A demander's view of a slot is decided by the slices of the demander's
  own chain that hold a row for it**: the session's, the user's, the
  space's. A root passes for a session that demands the slot when each such
  row stands at the slot's head and each such slice, with each slice above
  it in the chain, is clean and of the epoch. A slot that only another
  viewer's slice holds a row for, or that another run wrote since this
  viewer's row, is not vouched for this session, and refuses the root, so
  its piece starts and writes the slot as this session's run decides it.
  Each demand row carries the key of the session that demands it for this,
  since the scope key of a row at the space names no pair.
- **A reading slice of another piece** is stale through such a slot where a
  slice that holds it, with its row at the slot's head, is marked: for a
  reader at a viewer's key, a holder in that viewer's chain, and for a
  reader at the slot's own key, any holder. A reader with no such holder
  reads a slot nothing answers for, and is stored marked.

One thing this leaves as it is. A slot that is rewritten each time the set
of viewers changes costs the returning viewer a start, because a start is
what writes the slot for them: the index is then right about such a piece
and no faster for it.

## Checking it before relying on it

`SERVER_EXECUTION_CURRENCY_INDEX=record` records and judges and still starts
everything. Each root the judgment would have served from the store is
counted (`currency.servable`), and when a piece the index held clean writes
an instance it vouched for again, to a value other than the one it held,
with no input of it changed, the judgment was wrong: the count of those is
`currency.falseClean`, logged with the piece. A start derives every output
of a piece afresh, those of a current slice among them, so an instance
written again as it stood is not counted. A piece does not run for a viewer
who holds no instance of its result document, so the write that makes one,
by whoever instantiates the piece for them, counts as a changed input.
Whether a piece had been clean is
kept with its record, so a mark that lands before the next record is stored
does not hide it.

The instances a slice answers for are the ones it vouches for at its own key
and the slots it decides at another. A slot is shared with the runs of other
slices, any of which may write it as it decides, so a slot written again
counts against a slice only where that slice's own run wrote it. Two things
say so, and both are required:

- **The store says who made each write.** Every write of a derivation is
  stored with the identity its run acted as (protocol.md §1): nobody for a
  run at the space, the user for a run at a user's key, the user and the
  session for a run at a session's. Each revision of the slot above the
  slice's row is to be attributed to a run at the slice's own key. A run
  that writes what the slot already holds leaves no revision, so only a
  write that changed the slot is asked about, and the store can name the
  run of each of those.
- **The record says the slot holds what the slice's run left.** The record
  being stored is to name the slot as one the slice decides. One it names
  as holding a later write, or does not name, is not counted.

A row the last record stored as superseded answered for nothing, and is
not checked; a row that answered for the slot and has the slot's head above
it since is the one the check asks about. Where a revision of the slot above the slice's row is another
slice's run's, or names no run, the slot is not counted either, whatever the
slice's own run wrote after it: a piece's reads of its own outputs are not
among the inputs the check compares, so the record cannot say whether that
other write prompted the slice's. Two more cases the record cannot decide
are not counted. A run acts as the narrowest scope it read, and is filed
under the narrowest scope its node has read for that viewer in any run, so a
run filed under a session's key that read nothing narrower than the user's
this time is attributed to the user, and a slot it rewrote is not counted
against the session's slice. And a slot rewritten by a run for a viewer the
recording runtime holds no run for is checked against no slice, since a
record names only the slices of the runs the runtime holds.

`skip` and `start-upstream` act on the
judgment, under the loop's epoch: a record of another epoch refuses its
root, so its piece starts. A toolshed's epoch is
`SERVER_EXECUTION_CURRENCY_EPOCH`, or else the default epoch
(`DEFAULT_CURRENCY_EPOCH` in `runtime/runner/src/executor/space-server.ts`),
which a serving loop whose policy names no epoch takes too. The default is
one fixed value that no build and no process decides, so a deployment trusts
the records its earlier builds stored, and a toolshed run from source trusts
those of its earlier runs. Setting the variable to a value no record carries
is how an operator stops trusting every record stored so far: each piece
then starts on its next demand and is recorded under the new epoch.

A toolshed runs `skip` by default. `falseClean` is still counted there, for
each piece that does start, and `SERVER_EXECUTION_CURRENCY_INDEX=record` on a
deployment starts every piece and counts every judgment that would have been
wrong. `record` starts what is upstream of a running piece that is stale, as
`start-upstream` does, so its counts are of that level and not of `skip`.
Under `skip`, `currency.refused["stale-upstream"]` counts the roots
`start-upstream` would have held.

## Marking by path

Not started. This section is the design, and stage 9 and acceptance tests
30 to 41 are how it is built.

A mark is decided per document instance: any revision of an instance a
slice read marks the slice, whichever part of the document the revision
wrote. One write that changes nothing a computation read therefore marks in
three places. A follow that finds the same source at a later release time
moves `confirmed.releasedAt` in the `pieceReconciliation` field of the
piece's result document (`piece-source-lifecycle.md`), and every deploy
states a later release time, so each followed piece gets one such revision
per deploy. That revision:

1. marks every slice of the followed piece, through the read of its own
   result document that every slice holds;
2. marks every slice in the same space that read any part of that result
   document;
3. moves the head the space reports of the result document to each space
   that registered it, which marks each slice there that read it, and
   through the first mark reports every registered instance the followed
   piece writes as stale upstream.

So a deploy starts each followed piece and each piece that reads a followed
piece's result, in any space. A Topics board whose slice for each viewer
reads that viewer's profile through the Home piece's result document is
started once per deploy for each viewer. Such a piece stays unstarted only
once all three marks are removed: removing the second and third alone
leaves the reader marked `1` through the first.

The rule this section adds: a revision is ahead of a row only where it
wrote a path the row's slice read, or a path its computations write for a
vouch row. Where the index cannot tell, the revision is ahead of the row,
as every revision is today.

### What a row holds

A read row gains the paths its slice read in the instance, in one nullable
column of the row it already is. A row that holds none is a read of the
whole document, which is what every row means today.

The paths are the ones the scheduler holds for the computation: the
addresses of its read log after the scheduler's own compaction
(`setSchedulerDependencies()`), with the two kinds it keeps apart. A
**deep** path was read with everything beneath it. A **shallow** path was
read for its own value and its keys, which is how a key enumeration and a
test for presence are logged. The index adds no mapping of its own from a
schema to paths, because that set is what a running scheduler runs the
computation again for:

- a read that traverses under a schema is logged at each path it visits,
  and compaction drops a path that a deep path above it covers;
- a read that follows a link is logged as a read of the slot that holds
  the link, in the document that holds it, and as reads in the target
  document, which are rows for the target;
- a read of an array's length or of one element is a path beneath the
  array;
- a read of a path the document does not hold is logged at that path.

A path starts at the document's root, so a read of a cell's content starts
with `value`, and a read of a meta field with the field's name.
`CurrencyReadPaths` in `runtime/memory/v2/currency-index.ts` is the type,
and `CurrencyRead.paths` carries it from the snapshot to the index.

A row holds at most 8 paths and 256 bytes of them encoded. A slice whose
reads of one instance exceed either bound has its longest paths shortened
by one component, compacted again, and so on until they fit. A shortened
path is deep, whichever kind it was: a deep read of a path above covers
every write a shallow or a deep read beneath it is sensitive to. A read of
the document's root is stored as no paths. So the bound costs precision and
never a mark. Both numbers are to be set from what stage 9c measures.

Rejected:

- **One row per path.** The index would hold several times the rows, the
  table's key would change, which drops every stored record, and nothing
  looks a row up by path: an advance finds rows by the instance that
  changed.
- **Exact paths with no bound.** A computation that visits each element of
  a list of 3,000 logs thousands of paths in one document.
- **A digest of the paths.** Overlap is a prefix test, which a digest
  cannot decide.

A vouch row gains the paths the slice's clean computations declare they
write in the document, from the scheduling write surface the snapshot
already reads. A vouch row that holds none covers the whole document.

### What a revision touched

The index reads what a revision wrote from the revision itself, when it
advances, and stores nothing new for it:

- a `patch` revision touched the paths its operations name, as
  `touchedPointerPaths()` reads them, with the parent of a path whose key
  the operation adds or removes for a shallow read
  (`docs/specs/memory-v2/08-conflict-granularity.md`);
- a `set` and a `delete` touched every path;
- the first revision of an instance touched every path, so a row that read
  an instance the store did not hold is behind whatever creates it;
- a revision whose operations the index cannot read paths from touched
  every path;
- more than 64 revisions of one instance above the cursor, or more than
  256 KiB of their patch data, touched every path.

A `set` is not diffed against the document it replaced. A document is
written whole when a transaction creates it, writes its root, or commits an
effect's result (`getNativeCommit()` in
`runtime/runner/src/storage/v2-transaction.ts`). The first is covered by
the rule for a first revision. A diff for the other two costs reading and
comparing two whole documents on the memory server's thread for each such
revision, to spare the readers of a builtin's result document that read a
part of it the completion left as it was. `currency.pathWhole` counts the
revisions that touched every path, by reason, and a diff is added if `set`
is the most frequent reason on a measured space.

Storing each revision's touched paths when the commit is admitted is
rejected: every commit of every space would pay for it, the spaces with no
index among them, and the revision already holds its operations.

Two rules decide a write outside `value`:

- **A write to a root field that is neither `value` nor a record-only
  field touches every path.** The pattern pointer, the argument and result
  links, the stored schema, the label field `cfc` and a root field no build
  has classified all decide how a document is read or what its piece runs.
  Such a write marks as it does today.
- **A write inside a record-only field touches only a row that names a
  path in that field.** A record-only field holds a record about the piece
  that no start and no computation reads to decide what the piece computes
  or writes. `pieceReconciliation` is one: the follow reads it to order
  releases, and a follow that changes what the piece runs writes the
  pattern pointer. The list is to live beside `META_FIELDS` in
  `runtime/runner/src/meta-seam.ts`, as a classification of every meta
  field, so that a field added later does not compile until it is
  classified:

```ts
// Shown at module scope.

/** The meta fields, as `META_FIELDS` lists them. */
type MetaField = "patternIdentity" | "pieceReconciliation" | "schema";

/**
 * Whether a write inside each meta field alone leaves what a start of the
 * piece derives, and what a reader of the document reads, as it was.
 */
const META_FIELD_IS_RECORD_ONLY: Record<MetaField, boolean> = {
  patternIdentity: false,
  pieceReconciliation: true,
  schema: false,
};
```

Only `pieceReconciliation` is proposed as record-only.
`pieceSourceHistory`, `patternRepository` and `displacedPattern` are
candidates, each to be argued before it joins.

### When a revision is ahead of a row

A revision above a row's sequence number is ahead of the row where it
touched every path, where the row holds no paths, or where a path it
touched matches a path of the row. The match is the one that decides
whether a commit's read conflicts with a stored patch
(`docs/specs/memory-v2/08-conflict-granularity.md`), from the same code:

- a deep path matches a touched path that is the same path, a path above
  it, or a path beneath it, and no sibling;
- a shallow path matches a touched path that is the same path or above it,
  and the path itself where an operation adds or removes one of its keys;
- an insertion into an array, a removal from one and a move within one
  reach the store as a `splice` or a `replace` at the array's own path, so
  a read of any element, or of the length, is matched by the array's path
  above it. The index adds one guard of its own: an `add`, a `remove` or a
  `move` whose last component is a non-negative integer is taken to touch
  its parent, in case a writer other than the runner sends one for an
  array;
- a removal of a key touches the key's path, and a `delete` of the document
  touches every path;
- a write that replaces a link is a write at the slot that holds it, which
  the read that followed the link logged, so it matches that read's row
  for the document that holds the slot.

The engine exports what the commit check builds, for one instance:

```ts
// Shown at module scope.

type Engine = { readonly database: unknown };

/** What the revisions of one instance above a seq wrote. */
type RevisionsTouched =
  /** One of them touched every path. `seq` is the newest such revision. */
  | { whole: true; seq: number }
  | {
    whole: false;

    /** The first component of each path touched. */
    roots: ReadonlySet<string>;

    /**
     * Returns the seq of the newest revision that touched a path matching
     * `path`, read deep or `shallow`, or `undefined` when none did.
     */
    newestMatching(
      path: readonly string[],
      shallow: boolean,
    ): number | undefined;
  };

/**
 * Returns what the revisions of the instance `(id, scopeKey)` above
 * `afterSeq` wrote, or `undefined` when there are none. `limit` bounds the
 * revisions and the bytes of patch data read, past which it returns that
 * every path was touched.
 */
declare function revisionsTouchedSince(
  engine: Engine,
  options: {
    id: string;
    scopeKey: string;
    afterSeq: number;
    limit: { revisions: number; bytes: number };
  },
): RevisionsTouched | undefined;
```

An advance asks once for each instance that changed above the cursor and
has a row behind it, from the cursor: every row stands at or below the
cursor, and each revision at or below the cursor was decided by the advance
that passed it. A row that no revision is ahead of keeps its sequence
number and is not written. Asking from each row's own sequence number
instead would read, at every advance, every revision since the oldest
untouched row was stored, and moving each untouched row up would write
every reader of a document at each commit to it.

Two more places compare a row with its instance's head, and use the same
result. The store of a record does not move a vouch row up to a head that
no derivation put there: the head it tests is the newest revision that is
ahead of the vouch row, so a write inside a record-only field of a document
the piece vouches for is no overwrite of it. And the check behind
`currency.falseClean` asks it, as "Checking it" below says. The store of a
record still leaves a read row behind any commit above `as_of` that the
record does not name as seen, whatever that commit wrote, which costs one
further record and no start.

### A slice's read of its own result document

Every slice of a piece reads the piece's result document, so that a change
to what the piece runs marks each of them. That read becomes a deep read of
`value`. With the rule for root fields above, such a row is behind a write
to the pattern pointer, to the argument and result links, to the setup
records, to the stored schema, to `cfc`, to any root field not classified,
and to anything under `value`, and is not behind a write inside a
record-only field. So the reconcile write marks no slice of its piece, and
every write that can change what a start derives marks them all.

The same holds for a read row the log supplies for an instance of the
piece's own result document, as it does for a piece whose result each
viewer holds an instance of: the row is widened to a deep read of `value`,
whatever paths the log named, since a start reads that instance's pattern
pointer by a read the log does not hold.

The pieces a slice reads the result of need no such widening. A change to
another piece's pattern pointer is a write to a root field that touches
every path, so it marks the reader as it does today.

### Checking it

`currency.falseClean` is what checks this rule, and its check changes with
it. The check counts a slice that was clean and wrote an instance it
answered for again, to another value, with no input changed, and today any
revision of a document the slice read is a changed input. Under that test
every revision that marking by path leaves a slice clean across would
count as a changed input, and the check would count none of the judgments
the new rule can get wrong. So an input is changed where a revision above
its row is ahead of the row by the rule above, asked from the row's own
sequence number. Where the bound on revisions is passed the check cannot
decide, and counts the slice in `currency.falseCleanUndecided` and not in
`falseClean`.

`SERVER_EXECUTION_CURRENCY_INDEX=record` on a space whose documents take
writes beside what its pieces read is then the check: a path the snapshot
left out of a row shows as a piece counted false clean.

### What stays per document

- **A mark that travels from a producer.** A marked slice marks `1` every
  slice that reads a document it writes, whichever paths either names. A
  write row holds no paths.
- **A slot a run at another key decides.** A decide row is behind any
  revision of its slot.
- **A `set`, a `delete`, a first revision, a write to a root field that is
  not `value` or record-only, a row past its bound and a run of revisions
  past theirs**, as above.
- **A plain root.** A parked plain root is loaded by any commit to its
  document, since the load is what tests the document for a back-link and
  a pattern pointer.
- **A read row behind an unseen commit when its record is stored.**
- **A document no record accounts for.** It marks its readers by path when
  it changes, as an input. A reader of the result of a piece that is not
  started still reads what that piece's setup last left there after the
  piece's pattern pointer moved: the write to the pointer marks the reader,
  and the start it causes derives from the same stored result.

### The rules it leaves as they are

- **A plain root** is judged on its stored document and not on any row, so
  nothing here reaches it.
- **A derived document no recorded piece writes** is still an input: its
  readers are marked through their read rows when it changes, now only
  where the change wrote a path they read. That is the direction the
  exception at the head of this plan accepts, a reader that serves what it
  derived from such a document in preference to a start. Whether such a
  document may be one no computation has produced yet is still asked of
  the whole document.
- **An absent instance of an owned cell with a scalar default** is judged
  from the demand rows and the write rows. The write that creates the
  instance is its first revision, which touches every path, so a slice
  that read the absent instance is marked by it.
- **A piece created from its origin is recorded as following it**, so its
  first follow writes nothing where the origin still offers that source.
  That saves the revision; this section is what keeps a later follow's
  revision, which each deploy causes, from marking.
- **A vouch row** is behind an overwrite of a path its piece writes, and
  not behind a write beside those paths.
- **`markDownstream()` and `clearDownstream()`** walk from a slice to the
  readers of the documents it writes, by document. Fewer slices are
  marked `2`, so fewer walks start, and each walk reaches what it reaches
  today.

### Rows that earlier builds stored

No row changes meaning, so the epoch stays and no record is dropped. A row
stored before this holds no paths, which reads as the whole document: more
marks, and no stored value served that today's rule would refuse. The new
columns are added to the tables where they stand. A build from before this
that serves the same store ignores the columns: it marks on every revision,
and the rows it stores hold no paths.

A row keeps the paths it was stored with until its slice is recorded
again. So the first deploy after this is built still marks each slice
through the rows the build before it stored, and starts its piece once.

### What it costs

Stored. The row counts do not change. A read row is about 0.5 KB with its
index entry, by the widths of its columns. A board of 3,281 Topics holds
some 59,000 to 79,000 read rows in its `space` slices, by the 9 to 12 rows
for each piece and two pieces for each Topic that the synthetic board
measured, and a viewer's slice of the board is taken here as 26,000 rows,
the number of roots such a viewer watches; no count of either is measured
on the production board. That is 30 to 40 MB of read rows and 13 MB for
each viewer today. Stage 9a stores one path of one component in nearly
every row, about 20 bytes, which adds 1.2 to 1.6 MB and 0.5 MB for each
viewer, about 4%. Stage 9c is bounded by 256 bytes a row, which is 15 to
20 MB and 6.7 MB for each viewer, about half as much again, and is
expected at two to four paths of about 25 bytes, 10 to 20%.

At a commit. Admission does nothing new. An advance does nothing new for
an instance with no row behind it. For one with rows behind it, it reads
the patch data of the revisions above the cursor once, about 10 to 30 µs
for a patch under 1 KB, and decides each row from its paths, about 2 to
5 µs a row. A document 3,281 slices read costs some 10 ms an advance,
where today the same advance marks 3,281 slices and their pieces start.
These are estimates from the sizes involved, and
`currency.advancePathMicros` is to replace them.

### Measuring it

Counters, among the `currency` counters (`serving-loop.md` §7):

- `pathSpared`: the rows a revision was above that it was not ahead of.
- `pathWhole`: the revisions that touched every path, by reason: `set`,
  `delete`, `first`, `root-field`, `unreadable`, `revisions`.
- `pathRowsWhole`: the read rows stored with no paths, by reason: `root`
  for a read of the document's root and `none` for a read the snapshot
  named no paths for.
- `pathRowsShortened`: the read rows stored with a path shortened to fit.
- `pathBytes`: the bytes of paths stored.
- `advancePathMicros`: the time advances spent reading revisions and
  deciding rows.
- `falseCleanUndecided`, as above.

The experiment, on a clone of a board's space and of a viewer's home space
served on loopback (`docs/development/space-clone-rehearsal.md`):

1. Serve the clones under `skip` with `TOOLSHED_RELEASED_AT` set to a time
   T1, open the board as the viewer until it is recorded, and stop the
   server.
2. Serve them again with `TOOLSHED_RELEASED_AT` set to a later T2 and open
   the board again.
3. After that open, the Home piece's result document holds T2 in its
   reconciliation record, `currency.servedFromStore` counts the board's
   root and the Home piece's, `currency.rearmed` and `currency.refused`
   count neither, and `pathSpared` counts the rows for the Home piece's
   result document.
4. Repeat under `record`: `falseClean` and `falseCleanUndecided` stay at
   zero.
5. Change the viewer's profile name in the home space and open the board:
   it starts, and shows the new name.

### The order to build it in

Stage 9 has four parts.

- **9a. Paths of one component, in one space.** The columns, the snapshot's
  paths shortened to their first component, what a revision touched, the
  two rules for a write outside `value`, the read of a piece's own result
  document, vouch rows, the check behind `falseClean`, and the counters.
  A path of one component names a field of the document's root, which is
  an object, so this part needs no rule for arrays and none for shallow
  reads. This removes the
  start of a followed piece at each deploy, and of each piece in its space
  that reads its result. Tests 30 to 36, 39 and 40.
- **9b. Across spaces**, as
  [`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md)
  says under "A read registered with its paths", also with paths of one
  component. This is the part that removes the start of a piece that reads
  a followed piece's result in another space, the board among them, and it
  needs 9a in the space that is read.
- **9c. Paths at their full depth**, to the bound, with the match for deep
  and shallow paths and the guard for arrays. Tests 37 and 38. It is built
  if `pathSpared` and the starts that remain on a measured space show
  slices marked by writes beside what they read under `value`.
- **9d. Measure**, as above. Test 41.

9a and 9b together are the smallest change that removes the start at each
deploy, and they are the mechanism itself with the bound on a path's
length set to one component: the columns, the rule for what a revision
touched, the registration and the check are the ones 9c uses, and 9c
changes the bound and adds the match beneath `value`.

A smaller change is rejected: leaving a revision that wrote only inside a
record-only field out of every comparison, with no paths stored. It is
sound only while no recorded computation reads a record-only field or a
document's root, which nothing enforces. With paths in the rows the index decides it for
each row.

## What changes in the specifications

- `serving-loop.md` §3b and §6: the persisted scheduler state gains the
  currency index beside W, `eventWatermark` and the basis index; the index
  records write links, which §3b calls evidence when kept per run, and here
  are overwritten in place per slice of a piece; its rows are written by the memory
  server on a serving host's request, outside the wave's transaction.
- §1: a demand for a recorded, clean piece loads nothing, which is a rule for
  which pieces start.
- §3e: the serving runtime follows a piece's origin before its first start
  of the piece in a tenure, and before it first leaves a root that rests on
  the piece unstarted.
- §6 step 3: an effect whose result never landed is re-fired by a start, so a
  piece is not recorded while any effect is outstanding.
- §8: the exception that names the basis tables names these too.
- For marking by path: §3b says the index's rows hold ids and sequence
  numbers, and they come to hold the paths read and written as well, which
  are addresses and no payload; its account of the reader, "a commit to an
  instance marks `2` each slice with a read row for that instance", becomes
  the rule under "When a revision is ahead of a row"; and §7 gains the
  counters.
  `docs/specs/memory-v2/08-conflict-granularity.md` names the index as a
  further user of its match, with the guard for arrays.
  `piece-source-lifecycle.md` says of the reconciliation record that a
  write to it marks no stored output. `runtime/runner/src/cfc/` is not
  expected to change: a write to a document's `cfc` field touches every
  path, so a change to a label marks each reader of the document as it
  does today. That classification is settled through
  `docs/development/cfc-spec-correspondence.md` before 9a is built.

## Known limits

- **A document no record accounts for is read as an input.** A derived
  document no recorded piece writes is current for its readers until it
  changes, unless the store holds no instance of it or it is a cell of a
  piece the index holds no record of, both of which stay stale ("How a mark
  is cleared"). Where its writer, a computation writing outside its
  declared surface or a handler, would write another value after inputs
  changed while it did not run, its readers serve what they derived from
  the value the store holds, until that writer runs for another reason and
  writes.
- **`skip` starts nothing upstream of a stale piece.** Under the default
  mode a piece that is stale only through a piece upstream of it, in its own
  space, derives from what the store holds of that piece, and its session
  reads the result with the watermark past the change: the second problem
  this plan opens with stands as it does with no index. A stored value is
  not served as current on that account, since the piece starts and its
  record stays marked. `start-upstream` lifts the limit. `skip` carries no
  demand either, so two more things stand as they do with no index. A
  started piece's reads in another space demand nothing there
  ([`stored-output-currency-across-spaces.md`](stored-output-currency-across-spaces.md)):
  the piece that writes what was read starts only for a demand of its own,
  and the reading piece derives from what that store holds, which the
  reading space's judgment then holds stale. And a run withdrawn for a
  scoped instance its writer has not produced for the run's viewer demands
  nothing: the writer produces the instance only for a demand of its own,
  and until it does, the run stays withdrawn and the viewer reads what the
  store holds of the run's output.
- **Under `start-upstream`, a running piece that is refused for good is
  judged and given up on repeatedly.** When every record of a running piece
  leaves it stale and no piece upstream can clear it, the loop judges it and
  gives up on what is upstream of it, and does so again at each later
  round. Nothing in the tree is known to cause it. `skip` arms none of that.
- **A record outlives the build that stored it.** The default epoch is the
  same for every build, and nothing else in the index says which build
  stored a record. Three things a build can change therefore do not reach a
  recorded piece until one of its inputs changes or the operator names a
  new epoch. The first is what an unchanged pattern computes from unchanged
  inputs, as a fix to the runtime, to a builtin or to the compiler changes
  it: the stored outputs stay judged current, and they are what a client
  reads. The second is what a record holds, as a fix to the recording
  changes it: a record stored with a read or a vouch row wrong stays
  trusted as it is. The third is what a row means. The index carries no
  version, and a store's records are dropped when it is opened only where
  the tables' shapes show an earlier layout
  (`dropUnslicedCurrencyTables()` and `dropCurrencyRecordsBeforeDecides()`
  in `runtime/memory/v2/engine.ts`). A build that changes what a row means
  and keeps the tables' shapes would read the rows of earlier builds under
  the new meaning, so such a change drops the records at open or changes
  the value of the default epoch. Two builds that serve one store, as
  during a deployment, trust each other's records in the same way, and so
  does a toolshed run from source across an edit to the runtime. Under
  `record`, a piece whose stored output the running build computes
  otherwise is counted in `currency.falseClean` when the record of the
  cycle that started it is stored.
- **A piece is recorded only after a cycle that ran it settled.** A piece
  served before the index was on starts on its first demand. A cycle does
  not settle while the pass that loads the demanded roots is under way, so a
  space whose every root is loaded at once has nothing recorded until that
  pass ends, and a tenure that parks before then, as one does when its last
  session leaves, has recorded nothing.
- **A piece beneath a started one runs, whether or not its own root is left
  unstarted.** An enclosing piece's start instantiates the pieces beneath
  it, and the writer of an instance a session demands is live from the
  moment it is registered, so it runs. Leaving such a root unloaded saves
  its structure load alone: where a board's own piece starts, every demanded
  computation of the pieces it lists runs again, and `servedFromStore`
  counts the roots that were not loaded, not the pieces that did not run.
- **A slice is marked by any revision of a document it read**, whichever
  part of the document the revision wrote, so a deploy starts each followed
  piece and each piece that reads a followed piece's result. "Marking by
  path" is the plan for it, and lists what stays per document once it is
  built.
- **A slice is marked whole.** A computation that is not live when a record
  is taken contributes no reads and no vouch, so an undemanded part of a
  piece does not keep it marked. Where that leaves a live computation at the
  slice's key, the record drops what the other one vouched for, and a later
  demand for it starts the piece. A computation that was live then, and that
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
- **A piece whose result document each viewer holds an instance of, one of
  which records a source origin, always starts.** An origin is followed
  through one result document.
- **A document a load starts no piece from is brought up to date only by
  a start of its writer or of a piece that encloses its writer.** Its root
  is plain and parked, and nothing starts the writer for it. Where the
  writer's own result is demanded, or the writer is beneath a demanded
  root, as each row of a board is beneath the board, a change to the
  writer's inputs refuses that root and its start runs the writer. Where
  neither is demanded, a client reads what the store holds of the document,
  with the index or without it.
- **A piece with no computation of its own has no record.** A pattern that
  only instantiates others registers no computation under its own result
  document, so no snapshot is taken of it, and a root that leads to it is
  loaded.
- **A write a computation makes outside its declared surface is not in the
  write rows.** A document written that way reads as an input nothing
  computes. The documents a lift writes through `Writable.for(...).set()`,
  one for each element of the list it returns, are written that way, and a
  root that names one is plain. The run's own writes cannot supply the rows, since a run that computes
  what a document already holds writes nothing to it.
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
- **An owned scoped cell with an object or an array default starts its
  piece for each new viewer.** A session that holds no instance of it is
  refused as `absent-owned` until a start has seeded it ("What the demand
  pass does with it"). Serving it would need the seed without a start, or a
  first write that fills the rest of the default.
- **A crash loses what the last cycles would have recorded.** The affected
  pieces are marked by their own later commits and start again.

## Stages

1. **The index.** `runtime/memory/v2/currency-index.ts` and its tables
   (`currency_slice`, `currency_read`, `currency_write`, `currency_vouch`,
   `currency_decide`, `currency_origin`, `currency_under`,
   `currency_cursor`, and
   `currency_expiry` for the time a
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
   says, and run under `start-upstream`, which no deployment runs by
   default: a judgment holds a root that is stale only upstream and names the
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
9. **Marking by path.** Not started. In four parts, as "Marking by path"
   says under "The order to build it in": 9a, paths of one component in
   one space; 9b, the same across spaces; 9c, paths at their full depth;
   9d, the measurement.

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
   the row's instance is vouched for; an absent instance of an owned cell
   whose default is not a scalar, a written id with no vouch row, a marked nested piece that owns a demanded
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
14. A session whose demand reaches an owned scoped cell with an object
    default that it holds no instance of starts the piece and is seeded. A
    session whose demand reaches one with a scalar default that it holds no
    instance of leaves the piece unstarted, and a client in a session that
    holds no instance of it reads the default; one a computation of the
    piece writes starts the piece.
15. A demand for an output of a recorded piece that no computation had
    written starts the piece.
16. A piece with a debounced computation still invalid at the settle is
    recorded marked.

For stage 5, all of which exist in
`runtime/runner/test/executor/space-server-currency-upstream.test.ts`, over
a chain in which A derives `a` from an input, B derives `b` from `a`, and C
derives `c` from `b`. Tests 17 and 18 run under `start-upstream`:

17. With all three recorded and none running, a change to A's input
    followed by a demand for C alone starts A and B, and C's session reads
    the value derived from the new input, including where B's writer is
    narrowed to the demanding user.
18. In that case, when A's recomputation leaves `a` equal, neither B nor C
    is started, and all three are left clean.

The same file holds three cases beside them under `start-upstream` or
`record`. The watermark does not reach
a change to A's input before the store holds what C derives from it. A C
that runs already, under `record`, is brought the new value. And a viewer B
never ran for, who demands C alone with nothing changed, has B started for
them.

It holds two cases under `skip`. A change to A's input followed by a demand
for C alone starts C and neither A nor B: C's session reads the value
derived from the `b` the store holds, the watermark passes the change, the
root is counted under `stale-upstream`, C is recorded marked `1`, and
`heldUpstream`, `upstreamAbandoned` and the carried rows stay zero. And a
further change to A's input while C runs starts neither A nor B.

For slices, in the index tests and in `space-server-currency.test.ts`, all
of which exist:

19. A change to one viewer's instance marks the slices that read it and no
    other viewer's, and a change to a shared instance marks every slice that
    read it.
20. A record leaves a viewer's slice it does not name with its rows and its
    mark. One that names no `space` slice leaves a clean `space` slice of its
    epoch with its rows, and replaces a marked one, or one of another epoch,
    with a slice that read nothing.
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
27. A snapshot names the slices a live computation ran at, and none for a
    piece whose computations are registered and not live
    (`runtime/runner/test/scheduler/piece-currency.test.ts`).
28. A piece that an enclosing piece's start instantiates for a viewer who
    demands nothing of it keeps its record, and the store can still serve
    its root to the viewer it was recorded for.
29. A root that is no `computed:` document and whose stored document is
    absent or carries neither a `result` field nor a pattern pointer is
    returned as plain, whether nothing derives it, a serving loop's
    derivation wrote it, or one recorded piece writes it, marked or not; a
    `computed:` root never is (`runtime/memory/test/v2-server-currency.test.ts`).
    Under `skip` the loop parks a plain root unloaded, including an element
    a lift writes whose recorded writer is marked and a document the space
    holds no instance of; loads it once a client commits to it, and at once
    where that commit was admitted while the judgment ran; and loads a root
    demanded at a narrower scope (`space-server-currency.test.ts`).

For marking by path, none of which exist. In the index tests:

30. A patch revision that writes only inside a record-only field of an
    instance marks no slice whose read row for the instance names paths
    outside that field, and marks a slice whose row names none.
31. A patch revision that writes a root field other than `value` and the
    record-only fields, the pattern pointer, the stored schema and `cfc`
    each, marks every slice with a read row for the instance.
32. A `set`, a `delete`, the first revision of an instance a row saw
    absent, and a run of revisions past the bound each mark every slice
    with a read row for the instance.
33. Every slice of a piece is marked by a change to its result document's
    pattern pointer and by a write under that document's `value`, and none
    by a write of its reconciliation record, for a result document in the
    space and for one each viewer holds an instance of.
34. A slice that vouches for a document is marked by a client's write at a
    path its computations declare, and not by a write inside a record-only
    field of it; a record stored after the second is clean.
35. An advance after a revision that is ahead of no row writes no read row,
    and a later revision that touches a row's path marks its slice.
36. A slice held clean across a revision that touched none of its paths,
    which then writes an instance it vouches for to another value, is
    counted in `falseClean`; one whose revisions pass the bound is counted
    in `falseCleanUndecided`.
37. With paths at their full depth: a write to a sibling of a deep path
    marks nothing, and a write above it, at it or beneath it marks. A
    `splice` at an array marks a slice that read one element of it and one
    that read its length. A key added to an object marks a slice that read
    the object shallow, and a write to the value of a key it holds does
    not. A write that replaces a link marks a slice that followed it.
38. A row whose paths pass the bound is stored with paths shortened until
    they fit, each of which covers the paths it stands for, and a read of
    the document's root is stored with none.

For the snapshot, in `runtime/runner/test/scheduler/piece-currency.test.ts`:

39. A snapshot names, for each instance a slice read, the paths read, deep
    and shallow apart, those taken over from a writer that names no piece
    among them.

For the serving loop, in `space-server-currency.test.ts`:

40. Under `skip`, a recorded piece that follows an origin, and a second
    piece of its space that reads its result, are both left unstarted by
    the next tenure when the origin offers the same source at a later
    release time, and the first piece's reconciliation record holds that
    time. Both start when the first piece's pattern pointer moves.
41. The experiment under "Measuring it", run on a clone of a board's space
    and of a viewer's home space, with its counts recorded.

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
