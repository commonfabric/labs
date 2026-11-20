# Serving a stored output that depends on another space or on a wish

Status: Not started. This is a design, with the steps to build it. It
continues [`stored-output-currency.md`](stored-output-currency.md), whose
stages 1 to 4 are built, and its steps 1 to 3 come before that plan's
stage 5.

The currency index leaves a piece unstarted while its record proves every
demanded output of it current. A slice that read a document in another space
is never vouched for, so a piece that reads one starts on every demand, for
each viewer whose slice holds such a read. The commonest way a pattern reads
another space is a wish: 75 of the 507 pattern sources in this repository
call `wish()`, and half of the 133 calls with a literal target name the
viewer's home space, most of them `#profile` or a field of it. A social
space whose pieces show who is looking at them therefore gets nothing from
the index today.

Three things keep such a piece from being served from the store, and this
plan takes each:

- **A read in another space.** The index holds one space's sequence numbers
  and marks, and nothing tells it that a document elsewhere changed.
- **A computation that names no piece.** A slice that read a document whose
  writer the record cannot attribute is not vouched for, and some of what a
  wish registers with the scheduler is such a writer.
- **A clock.** A wish for `#now/N` reads a cell a timer writes. The slice
  that read it is vouched for, and that is the defect: nothing marks it when
  the interval passes while no runtime holds the timer.

The rule of the first plan holds here too: a start that was not needed is
acceptable, and a stored value served as current when it is not is the
failure to design out.

## What a wish reads

This table is from reading `runtime/runner/src/builtins/wish.ts`, and step 1
checks it against a run.

| Target | What the wish reads | What keeps its slice from being served |
| --- | --- | --- |
| `#profile`, `#profileName`, `#profileBio`, `#profileSpace`, `#favorites`, `#journal`, `#learned`, `#learnedSummary`, `#agent_queue`, `#chatManager` | The home space of the principal the run is for. A serving runtime runs such a wish once for each viewer (`homeSpacePrincipalFor()` narrows the run to the user), so the reads sit in that viewer's `user:` slice. | The read is in another space. |
| Any other hashtag, such as `#note` | The favorites of the home space and what the space's own root lists. Headless wishes for one query in one space share one resolver, which the wish registers with the scheduler under no piece. | The read is in another space, and the resolver's output is a document whose writer names no piece. |
| `/`, `#default`, `#mentionable`, `#summaryIndex`, `#knowledgeGraph`, `#pieceRegistry` | The root of the piece's own space, or of the home space or a named space where the wish's `scope` says so. | Nothing known for the piece's own space; the read in another space otherwise. |
| `#now` | A capture of the piece's first load time, written once to a document of the piece's space and read from then on. | Nothing: the value does not move. |
| `#now/N` | A cell one timer per runtime writes at each interval, for every wish of that interval in the space. | Nothing, which is the defect described above. |

Two things in it are not established. A wish for a home-space target can
write into the home space, and a piece with a computation that declares a
write in another space has no slice vouched for; whether the wish's declared
write surface includes such a write decides whether these steps are enough
for it. And the timer of `#now/N` runs in every runtime that holds the wish,
a browser's included, so a browser session ticks the cell for a piece its
server left unstarted, and a session with no runtime of its own does not.

## Across spaces

### What crosses a space boundary

A reading space R holds a slice that read an instance in a source space S.
Two things in S make that slice stale, and only the first is a commit:

1. the instance changed;
2. the instance is computed in S, and the slice of the piece that computes
   it became marked, or stopped vouching for it. The value R read is then
   not what S would compute, although no commit has touched it yet.

The second is the case the first plan's "stale output nothing recomputes"
describes, with a space boundary between the producer and its reader. It is
also what the specification lists as owed for a read across spaces under a
carried actor (`verification-coverage.md` OW35 (b)): the read registers no
demand in the source space, so a derivation there that nothing of the
actor's own demands goes stale.

Each space has its own store, its own sequence numbers, its own index and
its own owner, which another process can hold (`serving-loop.md` §2, owner
routing). So what crosses is a small exchange between two memory servers,
in-process where one server holds both spaces and over the deployment's
route otherwise.

### What the reading space records

- **A read row for an instance in another space** holds the source's
  sequence number of the version the run read. The serving replica keeps the
  confirmed sequence number of each document it holds
  (`runtime/runner/src/storage/v2.ts`); the snapshot does not reach it
  today, and carrying it into the record is the first thing step 2 builds.
- **What the source last said of an instance** some slice here reads: its
  head sequence number there, and whether it is current, stale upstream, or
  refused. One row per `(source space, id, scope key)`, whichever slices
  read it.
- **How far the reading space has followed each source**: one position per
  source space, in the source's own counter.

A slice with a read row behind what the source last said is marked `2`, as
it is for a row behind a local head. One whose rows are current and whose
source said "stale upstream" is marked `1`. A fourth case joins the three
under "How a mark is cleared" in the first plan: an input in another space
is stale while the source last said so, and while the source has said
nothing of it yet.

### What the source space records

- **Who reads what**: one row per `(reader space, id, scope key)`. A read
  the run could not name the instance of is registered against every
  instance of the document, as it is locally.
- **What it has told its readers**: one row per registered instance, with
  the state last reported and the position at which that last changed. The
  position is a counter of the source's own, and moves whenever one of
  these rows changes.

The source decides "stale upstream" with the predicate it already applies
to a local reader's input: a recorded piece computes the instance, and a
slice that decides it is marked or no piece vouches for it, or the instance
is a derived document no recorded piece writes. An instance nothing
computes is plain data, and only a commit moves it.

Those rows change in two places the index already has. An advance that
finds a registered instance changed records its new head. And wherever a
slice becomes marked or becomes clean, the registered instances its piece
writes are judged again. A space with no registered reader pays one cached
check and nothing more.

### Registering

A read is registered when its record is stored. The serving host that read
the instance holds a session on the source's owner, and registers over that
session, so the source admits a registration on the decision that admitted
the read (`protocol.md` §2 and §2b): the free read of space-scoped state,
or the actor's own grant for a scoped instance. The source returns the head
and the state of each instance in the same step that writes the reader row,
so a change that lands afterward is always one its readers are told of. The
record carries those to the reading space's memory server, which stores the
slice marked when a row is behind or an input is stale.

A reading space that no longer holds a row for an instance names it in its
next request, and the source drops the registration.

### How a change reaches a reader

The trigger and the transfer are separate.

- **The transfer is a pull from a position.** The reading space's memory
  server asks the source for the registered instances whose rows changed
  since the position it holds, applies them, and moves its position. The
  source brings its own marks up to its head before it returns, so what a
  pull returns is complete as of that request. A lost trigger, a restarted
  owner or a space nobody has opened in a month all recover the same way.
- **The trigger is a push to each reader space whose rows changed.** It
  carries no data. The reader's memory server pulls when it arrives, marks
  its slices, and runs nothing.

Marking in the reading space then goes on as it does for a local change:
each slice that became marked marks the clean slices that read what it
writes, and if any of those writes is registered by a third space, that
space is triggered in turn. Propagation stops at a slice that is already
marked, across spaces as within one.

One thing changes where a commit is admitted. Today only a serving loop
advances the cursor. A commit into a space with a registered reader queues
an advance on the memory server when none is queued, in a transaction of
its own after the commit has landed. This is the second half of the first
plan's stage 6, needed here for a space no loop serves.

### What a judgment does

Before it judges a root whose demand rows are resolved under a slice with a
read in another space, the memory server pulls from each such source. A
source it cannot reach refuses the root. The judgment then reads the slices
as it does today, so a viewer whose slice read their own home space is
judged on that source alone, and another viewer's home space is never
asked.

When a pull marks a slice of a piece whose root a loop holds unstarted, the
loop is told as it is for an advance that marked one, and loads the root.
No watermark floor holds for it: a commit in another space is never input
of the home space (`serving-loop.md` §3b), so the watermark makes no claim
about it, with the piece running or not.

### A chain of spaces

Piece A in space S writes `a`. Piece B in space T reads `a` and writes `b`.
Piece C in space U reads `b`. None is running.

Dirtying is eager and runs nothing:

1. A commit changes an input of A. S's advance marks A's slice. `a` is
   registered by T, so its row moves to "stale upstream" and S triggers T.
2. T's memory server pulls, marks `1` the slice of B that read `a`, finds
   `b` registered by U, moves its row and triggers U.
3. U's memory server pulls and marks `1` the slice of C that read `b`. A
   root of C that a loop holds unstarted is loaded.

Updating is lazy and starts at the demanded end:

1. A session demands C. The judgment refuses its root, and U's loop starts
   C.
2. C's slice is stale through `b`, which T computes. U's loop registers
   demand for `b` in T, for the actors demanding C.
3. T's loop starts B. B's slice is stale through `a`, so T's loop registers
   demand for `a` in S, and S's loop starts A.
4. A runs. If `a` changes, T's replica receives the commit, B runs again
   and so does C after it. If `a` comes out equal, S stores a clean record
   of A, the row for `a` returns to current, T is triggered, and B's mark
   clears with nothing more run in T or in U.

Demand travels upstream only along stale edges and stops at the first
producer whose slice is clean, so its cost follows what is stale and not
the depth of the graph.

### Demand across spaces

Step 2 of the update above needs a rule the specification does not have: a
read across spaces under a carried actor counts as that actor's demand in
the source space (OW35 (b)), which touches the demand model and the memory
server's demand rows, and takes a ruling of its own.

The demand this plan needs is narrower than that rule in one way and equal
to it in another. It is registered only for an instance the source reported
stale. It then stands for as long as the reading space holds a demanded
piece that reads the instance, so that the producer stays running and
current while its reader is watched, and it is withdrawn when the last such
piece is released (the first plan's stage 7).

A reading piece is started when its slice is stale, as today, and the
demand it sends upstream brings the new value to it as an ordinary commit.
Leaving the reader unstarted while its producers recompute, and serving it
from the store when they come out equal, is a later refinement: it needs a
decision on what a session is shown in the meantime, since no watermark
spans spaces.

## Wish

### Computations that name no piece

Every action a builtin registers with the scheduler carries an identity the
index can record it under. For an action that belongs to one piece, that is
the piece. The shared hashtag resolver belongs to every piece whose wish
uses it, so it is recorded as a unit of its own, identified by the document
it writes, beneath each of those pieces. Step 3 decides whether that shape
holds once the resolver's reads in the home space are counted, or whether
the resolver stops being shared under a serving runtime.

### The interval clock

A slice that read the cell of `#now/N` is current until the cell's next
tick. Its record names that time, a judgment refuses a slice past it, and a
loop that holds a root unstarted on such a slice loads the root when the
time comes. The start runs the wish, which holds the timer from then on.

## What changes in the specifications

- `serving-loop.md` §3b: the currency index gains rows about instances in
  other spaces, on both sides, and the two exchanges between memory servers
  that keep them. §1: a demand for a piece whose slice read another space
  can load nothing.
- `protocol.md` §2 and §2b: a registration is admitted with the read it is
  for, and a pull returns sequence numbers and states of registered
  instances only.
- `verification-coverage.md` OW35 (b): the demand rule, ruled, and (a): a
  registration under a grant that was revoked is reported as refused, which
  marks the reader's slice.
- `builtins.md` §5: what identity a wish's own computations carry, and the
  expiry of a slice that read the interval clock.
- `runtime/runner/src/cfc/` is not expected to change. Whether a producer's
  staleness, crossing from one space's memory server to another's, is a
  flow Contextual Flow Control must rule on is settled through
  `docs/development/cfc-spec-correspondence.md` before step 5.

## Decisions owed

1. **The source's store keeps a durable list of the spaces that read each
   of its documents.** Today a source sees a reader only while a session is
   open. Without the list, a reading space can still pull at each judgment,
   which is exact for one hop on a cold demand, and loses both the trigger
   for a live session and every chain.
2. **Memory servers exchange triggers and pulls for spaces no loop
   serves.** That is a new surface between owners, under the service
   identity. The alternative is to keep a loop for every space with a
   registered reader, which is the cost this index exists to remove.
3. **The demand rule of OW35 (b)**, as above.

## Not worked out

- **A dependency cycle that spans spaces.** Marking stops at a marked
  slice, so it ends. Recomputation around such a cycle wakes each loop from
  the other's commit, and no loop's convergence guard sees the whole cycle.
  The running system has the same exposure today.
- **A reader space that is deleted or abandoned** leaves its rows in every
  source it registered with.
- **The cost of a trigger's fan-out.** A change to a profile triggers every
  space that registered it, and each opens its store to mark. Correctness
  never rests on the trigger, since a judgment pulls first, so which
  readers are triggered at once and which are left to their next judgment
  can be chosen from a measurement.

## Steps

1. **Measure what blocks each kind of wish.** A serving-loop fixture for
   each row of the table above, under `record`, read through the reasons a
   slice was not vouched for (`currency.unvouched`). This settles the two
   things the table leaves open.
2. **Rows for a read in another space, judged and not acted on.** The
   snapshot carries the source's sequence number; registration; the rows on
   both sides; the pull before a judgment. Under `record` each root that
   would have been served is counted as today. `skip` goes on starting a
   root that rests on such a slice, since nothing would yet wake a live
   session whose root was left unstarted.
3. **Computations that name no piece**, as above. Independent of step 2,
   and small.
4. **The trigger.** The position counter, the push, marking from a pull,
   the load of a root a loop holds, and the advance a commit queues in a
   space with a registered reader. From here `skip` acts on a slice that
   read another space.
5. **Demand across spaces**, with its ruling, built together with the first
   plan's stage 5, which is the same mechanism within one space.
6. **The interval clock's expiry.**
7. **Measure** a social space whose pieces read each viewer's profile, with
   two viewers and with many, for the starts saved and for what a change to
   one profile costs its readers.

## Acceptance tests

For the index, in `runtime/memory/test/`, with two stores:

1. A slice that read an instance in another space is stored clean when the
   source's head is the sequence number it read at and the source reports
   the instance current, `2` when the head is above it, and `1` when the
   source reports it stale upstream.
2. A commit to a registered instance, followed by an advance in the source
   and a pull in the reader, marks `2` each slice that read it and no slice
   that read another instance of the document.
3. A pull from a position returns each registered instance whose row
   changed since, and a second pull from the new position returns nothing.
4. A slice in the source becoming marked moves the rows of the registered
   instances its piece writes to stale upstream, and a clean record of it
   moves them back; the reader's slice goes to `1` and back to `0` with no
   record of its own stored.
5. With three stores in a chain, a commit to the first marks the reading
   slice in the third, and a walk that reaches a marked slice triggers
   nobody.
6. A registration the source refuses, and one whose grant is revoked later,
   leave the reader's slice marked `2`.

For the serving loop, in `runtime/runner/test/executor/`:

7. A piece whose wish reads the viewer's home space is recorded with the
   read in that viewer's slice, and under `skip` is not started when the
   viewer returns and their home space has not changed.
8. A change to that viewer's home space while the piece is unstarted and
   their session is live starts the piece, and a change to another viewer's
   home space does not.
9. The chain above, with all three recorded and none running: a demand for
   C alone starts B and A, and C's session reads the value derived from the
   new input.
10. In that chain, when A's recomputation leaves `a` equal, B's mark clears
    and B is not started again.
11. A piece that reads `#now/N` is served from the store within the
    interval and started after it, and a root a loop holds unstarted is
    loaded when the interval passes.
12. Two pieces whose wishes share a hashtag resolver are each recorded
    clean, and a change to what the resolver read marks both.

## Related

- [`stored-output-currency.md`](stored-output-currency.md): the index this
  extends. Its stage 5 starts a stale producer within one space, and its
  stage 6 advances a space no loop serves.
- `docs/specs/server-side-execution/verification-coverage.md`, OW35: the
  two gaps of a read across spaces under a carried actor.
- `docs/specs/server-side-execution/builtins.md` §5: a wish resolved for
  each demanding identity.
