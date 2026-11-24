# Serving a stored output that depends on another space or on a wish

Status: In progress. Steps 1 to 4, 7 and 8 are done and step 5 is partly
built; the rest is a design, with the steps to build it. It
continues [`stored-output-currency.md`](stored-output-currency.md), whose
stages 1 to 4 are built, and its steps 1 to 3 come before that plan's
stage 5.

The currency index leaves a piece unstarted while its record proves every
demanded output of it current. An index that stops at its own space cannot
vouch for a slice that read a document in another space, so a piece that
reads one would start on every demand, for each viewer whose slice holds
such a read. The commonest way a pattern reads another space is a wish: 75
of the 507 pattern sources in this repository call `wish()`, and half of
the 133 calls with a literal target name the viewer's home space, most of
them `#profile` or a field of it. A social space whose pieces show who is
looking at them would get nothing from such an index.

Three things keep such a piece from being served from the store, and this
plan takes each:

- **A read in another space.** The index holds one space's sequence numbers
  and marks, and nothing tells it that a document elsewhere changed.
- **A computation that names no piece.** No record covers what such a
  computation wrote, and some of what a wish registers with the scheduler
  is one. A slice that read its output takes over what it read.
- **A clock.** A wish for `#now/N` reads a cell a timer writes. No commit
  marks the slice that read it when the interval passes while no runtime
  holds the timer, so its record has to say when it stops being current.

A fourth matter comes with leaving more pieces unstarted, and with marks
that travel between spaces: a computation the scheduler runs whether or not
anything reads it, because it cannot list who does. "Computations that run
without demand" below says when such a computation has to run.

The rule of the first plan holds here too: a start that was not needed is
acceptable, and a stored value served as current when it is not is the
failure to design out.

## What a wish reads

Each row is measured under a serving loop, in
`runtime/runner/test/executor/space-server-currency-wish.test.ts`, for the
targets that file names: `#favorites`, `#profileName`, a hashtag among the
favorites, both headless and not, `#default`, `/`, `#now` and `#now/60`.
The other targets of a row are placed in it from reading
`runtime/runner/src/builtins/wish.ts` and not from a run. `#profile` is one
of those, and the home space the fixture reads holds no profile.

| Target | What the wish reads | What keeps its slice from being served |
| --- | --- | --- |
| `#profile`, `#profileName`, `#profileBio`, `#profileSpace`, `#favorites`, `#journal`, `#learned`, `#learnedSummary`, `#agent_queue`, `#chatManager` | The home space of the principal the run is for. A serving runtime runs such a wish once for each viewer (`homeSpacePrincipalFor()` narrows the run to the user), so the reads sit in that viewer's `user:` slice. | The read is in another space. |
| Any other hashtag, such as `#note` | The favorites of the home space and what the space's own root lists. Headless wishes for one query over the space's own root share one resolver, which the wish registers with the scheduler under no piece. | The read in another space, for a search of the home space. Nothing for a search of the space's own root: the slice takes over the shared resolver's reads. |
| `/`, `#default`, `#mentionable`, `#summaryIndex`, `#knowledgeGraph`, `#pieceRegistry` | The root of the piece's own space, or of the home space or a named space where the wish's `scope` says so. | Nothing known for the piece's own space; the read in another space otherwise. |
| `#now` | A capture of the piece's first load time, written once to a document of the piece's space and read from then on. | Nothing: the value does not move. |
| `#now/N` | A cell one timer per runtime writes at each interval, for every wish of that interval in the space. | Nothing until the tick after the one the cell holds, which the slice's record names as the time it expires at. |

For the home-space targets measured, the read in another space is the only
thing in the way, and the index follows it where one memory server holds
both spaces ("Across spaces"). The wish declares no write in the home
space, so the piece can be vouched for, and its `space` slice and the
viewer's session slice are: the reads in the home space are all in the
viewer's `user:` slice.

The timer of `#now/N` runs in every runtime that holds the wish, a
browser's included, so a browser session ticks the cell and a session with
no runtime of its own does not. That second kind of session is why the
slice's record expires: left unstarted past the next tick, its piece would
show such a session a clock that had stopped.

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
  (`runtime/runner/src/storage/v2.ts`), and the snapshot takes it from
  there. The replica tells the scheduler of a frame in the turn it applies
  one, so a run that is clean with the scheduler idle read, at the paths it
  read, the version the replica holds.
- **What the source last said of an instance** some slice here reads: its
  head sequence number there, and whether it is current, stale upstream, or
  refused. One row per `(source space, id, scope key)`, whichever slices
  read it.
- **How far the reading space has followed each source**: one position per
  source space, in the source's own counter.

A slice with a read row behind what the source last said is marked `2`, as
it is for a row behind a local head, and so is one with a read the source
refused, at registration or once its grant was revoked. One whose rows are
current and whose source said "stale upstream" is marked `1`. A fourth case joins the three
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
is a derived document no recorded piece writes that no computation may
have produced yet, as the first plan's list says. An instance no recorded piece writes is otherwise
plain data, and only a commit moves it. The source takes an instance for a
derived document where its id has the form of one, or a serving loop's
commit wrote it.

Those rows change in two places the index already has. An advance that
finds a registered instance changed records its new head. And wherever a
slice becomes marked or becomes clean, the registered instances its piece
writes are judged again. A space with no registered reader pays one cached
check and nothing more.

### Registering

A read is registered when its record is stored. The source returns the head
and the state of each instance in the same step that writes the reader row,
so a change that lands afterward is always one its readers are told of, and
the slice is stored marked when a row is behind or an input is stale.

As built, the reading space's memory server registers, and only with a
source whose store it holds itself: the record names the instances a
serving runtime read under a session the source admitted, and a slice that
read a space another owner holds is stored marked `2`, as before. A
registration that travels to another owner is to go over the session the
serving host holds on it, so that the source admits it on the decision that
admitted the read (`protocol.md` §2 and §2b): the free read of space-scoped
state, or the actor's own grant for a scoped instance.

A read of a user's or a session's own instance is registered as a shared
one is, at that instance's key, where the actor the key names holds READ
on the source: the grant the read itself was admitted under
(`protocol.md` §2). Where the actor holds none, the instance is not
registered and its slice is stored marked `2`. The grant is checked each
time a record is stored and each time the reading space pulls. An instance
whose actor holds none any longer is forgotten: the reading space's
registration of it is dropped, and each slice that read it is marked `2`.
A change to the source's access list disarms every space armed with it, so
each pulls again before it rests on, and a grant that was withdrawn ends
the rest of the slices that depended on it.

Two reads are left out, and a slice with either is not vouched for: one
that names no one instance of a document, and one whose seq the serving
replica cannot name.

A reading space that no longer holds a row for an instance names it in its
next request, and the source drops the registration.

### How a change reaches a reader

The trigger and the transfer are separate.

- **The transfer is a pull from a position.** The reading space's memory
  server asks the source for the registered instances whose rows changed
  since the position it holds, applies them, and moves its position. The
  source brings its own marks up to its head before it returns, so what a
  pull returns is complete as of that request. A pull also arms the reader:
  in the step that reads the rows, the source notes that this reader is to
  be told of the next change. A lost trigger, a restarted owner or a space
  nobody has opened in a month all recover the same way.
- **The trigger is one bit, sent once.** When a row that an armed reader
  registered changes, the source tells that reader's memory server that
  something moved, and disarms it. That reader hears nothing more from the
  source until its next pull. The trigger carries no position and no data,
  so nothing in it has to be trusted, and a late or repeated one changes
  nothing.
- **A shortened arming is told the same way, and stays armed.** Where the
  time the source may be rested on until comes earlier ("The interval
  clock"), the source shortens the arming of each reader armed for longer
  to that time and tells it as it would of a change, but does not disarm
  it: nothing moved. The telling carries no time either. The reader's loop
  judges again, and the judgment returns the time from the arming, which
  the memory server holds. A shortened reader shortens its own readers in
  turn, and a reader whose arming was already that short or shorter passes
  nothing on, so round a circle of spaces the shortening ends after one
  round.

What a reader does with a trigger depends on what is waiting on it:

- It is no longer armed with that source, which is all the note it keeps
  that the source moved.
- Where a loop holds a root unstarted, the loop judges it again, which
  pulls from each source it is not armed with, marks its slices, and loads
  the root if a slice it rests on was marked.
- It triggers every armed reader of its own in turn, without pulling:
  something those readers registered may have moved with what it read.
- Where a slice reading that source holds a computation whose writes are
  not bounded ("Computations that run without demand"), it pulls at once if
  a session is watching the space.
- Otherwise it does nothing more, and pulls at its next judgment.

So a source that changes often tells each dormant reader once and then
stays silent toward it, and a dormant space in the middle of a chain passes
one bit on and marks nothing. A reader that is live pulls on each trigger,
and what changed while it was pulling arrives in one further trigger.

A space rests on hearing nothing from a source only while that source
hears of every change upstream of it. So a space is armed with a source
only once that source has pulled from each space it reads itself, a space
that is told passes the trigger to all of its own readers, and a space
whose new record reads a space it has not pulled from tells its readers
too. Passing the trigger to all of a space's readers, and not only to those
that registered an instance computed from the source that moved, costs a
live reader of an unrelated instance one judgment and one pull that returns
nothing. Narrowing it needs the rule above kept for each instance.

Marking after a pull goes on as it does for a local change: each slice that
became marked marks the clean slices that read what it writes. Propagation
stops at a slice that is already marked, and a trigger stops at a reader
that was already told.

One thing changes where a commit is admitted. A commit into a space with
an armed reader queues an advance on the memory server when none is queued,
in a transaction of its own after the commit has landed, since the advance
is what finds whether a registered instance changed. A space whose readers
have all been told pays one check of a map for each commit. A slice of the
space's own that such an advance marks is kept for the space's serving
loop, which re-arms a root it left unstarted from the seq the slice was
marked at.

As built, the memory server holds which readers are armed, and the
position each pulled at, in memory. After a restart no reader is armed, so
each pulls before it rests on a source. Every call that changes an index
ends by bringing what the store reports of its registered instances up to
date, for the documents a commit wrote and the pieces whose slices changed,
so finding the readers to tell is one read of the rows that moved. A row
takes a position when it changes, and none when its instance is first
registered, since the space registering it is handed the row. An index
that starts over with its records dropped keeps these rows, and the first
call that changes it brings every one of them up to date. An instance a
piece here computed is then one no recorded piece writes, plain data while
it holds a value, and its row stays as it was.

### A circle of triggers

Spaces whose pieces read each other pass a change around: a commit in one
changes an input of a piece in the other, whose commit changes an input of
a piece in the first. Within one space the scheduler bounds how often a
computation runs again in one settle. Across spaces each loop sees only its
own half, and the trigger adds a second way round, since each change tells
the other space, whose loop judges and pulls.

One trigger cannot circle: a space is told at most once between two pulls,
so the trigger stops at the first space already told. What circles is a
change that keeps being made, and what tells it apart from a pipeline is
that the same change comes back to a space it already passed.

So each change with no trigger behind it is given a number, and a trigger
carries that number and how many triggers lead to it from that change. A
space keeps the number and the count of the latest trigger it was sent,
and sends both on, the count one higher. A change of a space that no
trigger has reached since a client's commit landed there is one with no
trigger behind it, and takes a new number.

A trigger that reaches a space says one of three things:

- **A change the space has not been sent.** The space takes its number and
  count. This is every trigger of a pipeline, however long: a new email is
  a new change in each space it passes down to.
- **The same change through no more triggers than before.** A space
  upstream changed again for a reason of its own, such as a clock or an
  import, and sent the number it still holds. Nothing is counted.
- **The same change through more triggers than before.** It has come round
  a circle of spaces. That is a lap.

At eight laps the space is held: no other space rests on it. A judgment
that would pull from it marks `2` each slice that read it and does not arm,
and a record that reads it is stored marked `2`. Its readers then start
their pieces, as they would with no index kept, and no trigger passes along
that edge. The hold ends by itself. The first lasts a second, and each
further hold of a space lasts twice as long as its last one, up to five
minutes, unless the space was left alone for as long again as that one
lasted. So a circle that never settles is slowed to one round of eight laps
in each hold, a circle that settles costs nothing once it has, and no space
is left held for want of a visit. A change the space has not been sent ends
a hold at once, and a held space goes on pulling from the spaces it reads
so that one can reach it.

A trigger also carries the spaces it passed, cut to one circle, so a hold
is logged with the circle the change came round. `currencyDelivery` on
`/api/health/stats` publishes the counts and lists each space a change came
back to, with its laps, its circle and its holds
([profiling.md](../development/debugging/profiling.md)). Which pieces and
documents make the circle is in the stores: `cf inspect currency-cycles`
reads each space's records and prints every cycle of pieces that crosses a
space boundary, whether or not a change is going round it, which is what a
pattern's author needs to break one.

Several paths of different lengths from one space to another count as laps
too, one for each longer path a trigger arrives by, so the limit has to
stay above the number of such paths.

This bounds what the index adds, and detects the circle. It does not stop
the recomputation itself, which runs through each loop's own replica once
the pieces are started, as it does with no index kept ("Not worked out").

### What a judgment does

Before it judges a root whose demand rows are resolved under a slice with a
read in another space, the memory server pulls from each such source that
moved since its last pull, and from each it cannot tell about, as after a
restart. A source it is armed with and has heard nothing from needs no
request, so a profile that has not changed costs a judgment nothing. A
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

Dirtying is one bit along each edge, and runs nothing:

1. A commit changes an input of A. S's advance marks A's slice. `a` is
   registered by T, so its row moves to "stale upstream" and S triggers T.
2. T is no longer armed with S. U is armed with T, so T triggers U. T
   pulls nothing and marks nothing.
3. U is no longer armed with T, and stops there unless a loop holds a root
   of C unstarted. If one does, the loop judges it again, and U pulls from
   T. T pulls from S before it returns, marks the slice of B that read `a`
   and moves the row of `b` to "stale upstream". U marks `1` the slice of C
   that read `b`, and the root is loaded.

A further change in S reaches nobody until T pulls again.

Updating is lazy and starts at the demanded end:

1. A session demands C. The judgment pulls from T, which pulls from S, as
   in step 3 above, then refuses the root, and U's loop starts C.
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

Step 2 of the update above needs a rule the specification did not have,
and it is ruled (2026-11-21, `verification-coverage.md` OW35 (b)), in
full: **a read of an instance in another space by a run under a carried
actor is that actor's demand in that space.** The demand names the actor,
and is not the reading space's own, because a `PerUser` cell of the source
space read from another space is computed for the actor who reads it: the
source's loop has to run it for that actor, and only a demand that names
the actor does that.

**What a carried demand is.** A row in the source space's demand set, of
the shape a client session's watch gives: the instance that was read, as a
root, and a demanding pair, which is the actor's principal and session. It
differs from a client's row in where it comes from, which the row names as
its origin: the space where that session is a client's, and the session.
The source's loop treats it as it treats any row. It loads the piece that
computes the instance, runs it for that pair, and under `skip` or
`start-upstream` judges it first and leaves it unstarted while its record
proves it current.

**Which pair a read carries.** The slice of the run that read says whose
it is. A read in a `session` slice carries that slice's pair. A read in a
`user` slice carries each pair of that user that demands in the reading
space. A read in the `space` slice was made for everyone, and carries each
pair that demands in the reading space; a broad demand by a pair is then
demand for that pair's instance of whatever narrows beneath it in the
source, as it is for a client (`scopes.md` §2). A pair that reached the
reading space as a carried demand is carried on with the origin it came
with, so a chain of spaces passes one actor's demand along it. A demand
that reached it with no pair, because its actor may not read the space, is
carried on with its origin too, for the reads made in the `space` slice.

**Which reads are carried.** Those of a started piece, for an instance the
source's index does not prove current. The reading loop offers every read
its records hold, and the memory server leaves out the ones that are
proven: an instance the reader registered, shared or an actor's own, read
by a space that is armed with the source for no limited time, which the
source's index holds as one no piece there is behind on. A read the reader
has not registered always stands, and so does every read of a space the
reader is not armed with. With a row that stands, stands a row for each
piece the source's index records as writing its document, for the same
pair. A serving loop finds the piece of a computed document it is asked for
through the document's back-link, and an instance that is an actor's own
may not exist yet for it to find the piece from, so the piece is what it is
given to load. What stands is worked out
again whenever the source's index or the arming changes, and a reading
space that offers rows pulls from the source when it is not armed with it
and when the source tells it of a change, so that it is armed whenever a
row could be proven. So a source whose
instance is current is not asked to run anything, and a reading space
whose piece is not started carries nothing: demand travels along stale
edges, and along the edges no index can vouch for.

**Who may be carried.** A pair is admitted into the source only where its
actor holds READ there, by the check a named scoped read passes
(`protocol.md` §2, the grant-scoped read). Where the actor does not, a row
for the actor's own instance is dropped and counted, as the read of it is
refused. A row for a shared instance still stands, with no pair: a serving
loop reads a shared instance of another space whoever it runs for
(`protocol.md` §2b), so the source loads the piece that computes it and
runs nothing for the actor, as it does for an anonymous session.

**How long it stands.** The reading loop sends its whole set for a source
whenever the set changes, and the set is replaced. It changes when a piece
starts or is released, when a run's reads change, when a pair arrives or
leaves, and when the reading index is told an instance went stale or
current. A park of the reading space withdraws everything it carried. The
memory server drops a carried row when the session it names as its origin
ends, wherever the row is, so two spaces that read each other do not keep
each other's demand standing once the client that started it has gone.

**What it does to the source space.** A carried demand counts with client
sessions for whether the source is served: the host activates a parked
source that receives one and does not park it idle while one stands. It
does not count as a connected session for an intent that needs a channel
to its actor (`builtins.md` §4), since there is none.

A reading piece is started when its slice is stale, as today, and the
demand it carries upstream brings the new value to it as an ordinary
commit. Leaving the reader unstarted while its producers recompute, and
serving it from the store when they come out equal, is a later refinement:
it needs a decision on what a session is shown in the meantime, since no
watermark spans spaces.

**Not in this step.** A source whose store another memory server holds
receives no carried demand, as it receives no registration. A loop that
keeps no index carries nothing, since its records are where it finds what
a run read, and a loop in the `skip` mode carries nothing either: a piece
that runs there derives from what the source holds, and the judgment holds
the reading slice stale until the source's index proves the instance
current. A piece that only a warm request or an anonymous session
demands carries nothing, since neither names an actor to carry.

## Wish

### Computations that name no piece

The shared hashtag resolver belongs to every piece whose wish uses it, so
it names none, and no record covers what it wrote. A slice that read its
output answers for it instead: the snapshot adds what the resolver read to
the slice's own reads, and records the resolver's output as an input, so a
change to anything the resolver read marks the slice and starts its piece,
which runs the resolver again. This holds for any computation that names no
piece, through any number of them, on three conditions: the computation is
live, it is clean, and it runs once and not once for each viewer. Where one
fails, the slice is not vouched for (`unattributed-writer`). A piece that
answers for such a computation is recorded again whenever that computation
runs, since what it read can change with nothing of the piece's own
changing.

The resolver is shared only for a search that does not depend on the home
space. One whose `scope` names another space reads that space, and a slice
that takes over such a read is not vouched for, as for any read in another
space. One scoped to the piece's own space reads only that space.

### The interval clock

A slice that read the cell of `#now/N` is current until the tick after the
one the cell holds. The wish tells the scheduler which document its clock
writes, at what interval, and how to read the tick it holds, and the
snapshot gives a slice that read one the time of the following tick as the
time it expires at, the earliest where it read several. The time is counted
from the tick the cell holds and not from the time of the snapshot, so a
slice computed from a tick that is late is stored as expired already, and a
cell that holds no tick gives a time that has passed. The index keeps that
time beside the slice (`currency_expiry`). Each call that brings the marks
up to date marks `2` every slice whose time has come, with what is
downstream of it, and reports it at a seq above the store's head, since no
input the store holds made it stale. So a judgment refuses a root that
rests on a slice past its time, and starts the piece, which runs the wish
and holds the timer from then on.

While no runtime holds the clock, no commit lands at that time, so a loop
that left a root unstarted has to ask. A judgment returns the time to judge
again at, and the loop sets one timer for it while any root is left
unstarted. When it fires the loop judges again, which marks the slice and
loads the root.

No commit tells another space when a slice here expires either, so a pull
arms the reading space only until then. The time a space may be rested on
until is the earliest time a slice of it expires at, or the earliest time
its own arming with a space it reads runs out, so the time holds along a
chain of spaces. A judgment in the reading space that falls after it pulls
again, which marks the expired slice in the source and returns what is
downstream of it as stale. The time a judgment returns is the same one for
its own space, so the loop of a space that reads an expiring slice two
spaces along sets its timer for that slice. A record stored in a space that
makes that time earlier, or gives it one where it had none, shortens the
arming of each space armed with it for longer to that time, and tells it,
so that its loop judges again and sets its timer for the earlier time.
Nothing in the space moved, so the reading space stays armed and pulls
nothing, and the spaces armed with it are shortened in turn, which ends at
the first space whose readers are armed until then or sooner. Disarming it
would not do: where the two read each other, round a circle of spaces, the
trigger would disarm the space the time came from, the pulls that followed
could arm the reading space for longer again, and the circle would go round
with nothing moving in it.

## Computations that run without demand

The scheduler keeps two kinds of computation live whether or not anything
reads what they write: a materializer, which declares an envelope it may
write anywhere within, and an effect
(`docs/specs/scheduler-v2/README.md` §4.3). A materializer runs whenever an
input of it changes because the scheduler cannot list who reads inside its
envelope. That holds while its piece is started. A piece that is not
started runs none of its computations, so a change to a materializer's
input while its piece is unstarted leaves what it would have written as it
was, for a reader in another piece to read. The index does not make that
worse, and it is the place to close it.

Running each such computation on every change of its inputs would close it
at the cost this plan is built to avoid: a dormant space would pull from a
source that changes often on every trigger. The rule here is narrower:

**A computation that runs without demand may be left unrun for as long as
nothing can observe what it would write.**

Everything read out of a space passes that space's memory server: a
session's watch, a judgment, and another space's pull. So for a computation
that writes only into its own space, the space is the demand cone the
scheduler could not draw. What has to happen before one of those three
returns depends on how well the computation's destinations are known.

- **A declared envelope in its own space.** The envelope's documents are
  among the piece's write rows. A marked slice then marks `1` each slice
  that reads one of them, moves the rows of those another space registered
  to "stale upstream", and the piece is started when something in the
  envelope is demanded, by the first plan's stage 5. Nothing coarser is
  needed. The snapshot takes write rows from the scheduling write surface,
  which the scheduler keeps apart from envelopes, and a document a
  computation writes through a cell it was handed is not among them today
  (`space-server-currency-wish.test.ts`).
- **Writes that are not bounded, in its own space.** A marked slice with
  such a computation leaves the space **unsettled**. Before a judgment in
  the space or a pull from it returns, the loop starts that piece and lets
  it settle. Until one of those happens nothing runs. A session watching
  the space observes it all the time, so there the computation runs on each
  change, as it does today in a started piece.
- **A declared destination in another space.** The registration of a read
  has a mirror: the writing space registers, with the destination's owner,
  that a piece of its writes that instance. The destination then holds a
  write row whose producer is in another space, marks its readers `1` while
  the writing space reports that producer stale, and sends demand for it
  back the way a reading space does.
- **A destination in another space that is not declared.** Open, below.

The index tells a bounded computation from an unbounded one by what it
did, not by what it declared: when a record is taken, what each run wrote
is compared with the piece's declared write surface and envelopes, and a
computation that wrote outside them is recorded as unbounded.

An effect is left as it is. It runs while its piece is started, and a mark
on a demanded piece's slice starts the piece.

### The first step: a materializer runs while its space is served

*(RULED 2026-11-21.)* A materializer runs eagerly, and not on demand,
because what it will write cannot be predicted: that is why the scheduler
keeps it live, at low priority. The first step keeps that, and bounds it
by the space instead of by the destinations. While a serving loop serves a
space for any demand, a piece of that space that holds a materializer and
is marked is started, whether or not the demand has anything to do with
it, and its materializers run at low priority. A space nothing demands
runs none of them. Such a piece may be marked often, by inputs that change
often, so starting it may need a throttle or a debounce beyond this.

For this the index needs to know which pieces hold a materializer, which a
record can say, and the loop needs the marked ones among them after each
advance. It needs nothing about where a materializer writes. The cases
above are the finer rule, for a space that is served and should still not
run every materializer it holds, and for a space another space reads while
nothing serves it.

### What the rows for an envelope need

Three facts about the scheduler and the index decide how the first two cases
above are built, once the first step is not enough. The first two are not
settled.

- **An envelope names where a link is held, not what is written.** For a
  computation handed a writable cell, the envelope is the slot that holds
  the link to the cell, and the document the write lands in is the link's
  target (`space-server-currency-wish.test.ts`). So the documents an
  envelope leads to are known from what a run wrote or by following the
  envelope's links, and not from the envelope's own addresses. The scheduler
  keeps a run's reads and replaces its writes with the declared write
  surface (`setSchedulerDependencies()`), so what a run wrote beyond that
  surface is not kept today for a computation that runs once.
- **A document a materializer writes into can have other writers.** A cell
  handed to a computation is one a client may write too, and the index of a
  collection is written by a materializer for each element in it
  (`collection-index-member.ts`). A vouch row says a clean run stands behind
  the whole instance, and a revision above it marks the slice that vouched.
  Vouching for such a document would have each of its writers marked by
  every other, and none of them would rest. The rows for an envelope need a
  relation of their own: one that marks the readers of the document when the
  materializer's slice is marked, asks for no vouch, and is not marked by
  another writer's revision.
- **A stale producer is started from what its record says it writes.**
  Within one space as across spaces, a reader's stale read starts the piece
  the index records as writing the instance (the first plan's stage 5, and
  step 5 here). A document a materializer wrote within its envelope is in
  no record's write rows, so a reader of it starts nothing.

### A write into another space at an undeclared destination

No rule above covers it, because what could observe the write is behind a
memory server that knows nothing of the writer. It is not refused. Today a
piece with a computation that declares a write in another space has no
slice vouched for, so it starts whenever it is demanded, and runs for
nobody while it is not; that stays as it is until this is decided.

What to weigh, once there are numbers:

- waking such a piece on each change of its inputs, with a throttle;
- counts of how often a run that only this rule caused wrote anything, and
  how much work that write started elsewhere, to say whether the wake pays
  for itself;
- requiring the destination to be declared.

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
- `docs/specs/scheduler-v2/README.md` §4.3: a materializer's standing
  demand holds within a started piece, and outside one is carried by the
  index as above.
- `runtime/runner/src/cfc/` is not expected to change. A producer's
  staleness and a trigger both pass from one space to the spaces that read
  it, and a space passes a trigger on to readers that may not read the
  space it came from. What such a reader gains is whether a piece of its
  own starts, and no value. Whether that is a flow Contextual Flow Control
  must rule on is settled through
  `docs/development/cfc-spec-correspondence.md` before either leaves the
  process, and before step 5.

## Decisions

Two are taken:

1. **The source's store keeps a durable list of the spaces that read each
   of its documents.** A source otherwise sees a reader only while a
   session is open, and without the list a reading space could pull at each
   judgment, which is exact for one hop on a cold demand, and would have
   neither the trigger for a live session nor any chain.
2. **Memory servers exchange triggers and pulls for spaces no loop
   serves**, under the service identity. Keeping a loop for every space
   with a registered reader is the cost this index exists to remove.

Three roles are kept apart in the code so that the second decision can be
revisited. What is true of an instance stays with its source, whose store
alone knows its sequence numbers and whether a producer is stale. What a
reading space knows of its sources stays in its own store, where a judgment
reads it with the slices and the demand rows. Delivery, which is the list
of who reads what, the trigger's fan-out and its retries, sits behind an
interface of its own, so a service between spaces can take it over without
a change to the other two.

A third is ruled:

3. **The demand rule of OW35 (b), in full**: a read across spaces under a
   carried actor is that actor's demand in the source space ("Demand
   across spaces").

## Not worked out

- **A dependency cycle that spans spaces.** Marking stops at a marked
  slice and a trigger at a space already told, so both end, and a space a
  change keeps coming back to is held for a while ("A circle of triggers").
  Recomputation around the cycle is not
  stopped: once the pieces run, each loop's replica delivers the other's
  commit and the piece runs again, with no trigger involved, and no loop's
  convergence guard sees the whole cycle. Stopping it needs the same trail
  on what a serving loop derives: a derived commit that carries the change
  behind it and how far it has come, and a loop that holds a piece back
  once the change has come round too often, as the scheduler holds a
  computation back within one space. That would also tell a lap from a
  space's own further change exactly, where the memory server can only
  compare counts.
- **Which of a space's readers a trigger is passed to.** All of them, as
  built. Passing it only to the readers of an instance computed from the
  source that moved needs the walk a pull's marking makes, made without
  marking, and the arming rule kept for each instance.
- **A reader space that is deleted or abandoned** leaves its rows in every
  source it registered with.
- **How long an armed reader trusts silence.** In one process a trigger
  cannot be lost. Between hosts it can, so the promise an armed reader
  rests on needs a bound: a connection known to be live, or a lease the
  reader renews.
- **A write into another space at an undeclared destination**, as above.
- **The first change after many readers armed.** A reader that was told is
  not told again until it pulls, so a space that changes often pays for
  each dormant reader once. A profile edited after its owner visited many
  spaces still triggers each of them, once, and what that costs is to be
  measured.

## Steps

1. **Measure what blocks each kind of wish.** Done, with a serving-loop
   fixture for each row of the table above, read through the reasons a
   slice was not vouched for (`currency.unvouched`). A slice that read the
   interval clock was vouched for with no end and left a session with no
   runtime of its own a stopped clock under `skip`; step 7 gives its record
   a time it expires at.
2. **Rows for a read in another space.** Done, for two spaces one memory
   server holds. The snapshot carries the source's sequence number; a
   record's reads are registered with their source; both sides keep their
   rows; and a judgment pulls from the sources of the slices its demand
   rows are resolved under. A refused registration is not built: nothing
   refuses one where one server holds both stores.
3. **Computations that name no piece.** Done, as above.
4. **The trigger.** Done, for spaces one memory server holds: the position
   counter, arming on a pull, the one-bit push and what a reader does with
   it, marking from a pull, the load of a root a loop holds, the advance a
   commit queues in a space with an armed reader, and the hold that slows
   a circle of triggers. `skip` acts on a slice that read
   another space. Which readers are armed is held in memory, and a trigger
   that leaves the process is not built.
5. **Demand across spaces**, as ruled, built together with the first
   plan's stage 5, which is the same mechanism within one space. Built:
   carried rows in the memory server's demand set, with their origin, their
   access check, their end and the rows the source's index proves current
   left out; the reading loop's set, sent when it changes and withdrawn at
   a park; and activation and parking of the source, which follow from the
   rows being held among the source's sessions. A loop carries demand in
   the `record` and `start-upstream` modes and not in `skip`. Measured:
   [the record](../history/development/performance/2026-11-21-carried-demand-cost.md).
   A return with nothing changed hands the source no demand. A carried
   demand costs the source the admission of its rows and the start of its
   pieces, which it pays for viewers of its own too. The reading loop sends
   its whole set whenever it changes, and each reading piece is recorded
   again with every viewer's slice at each start; both are costs still to
   take out.
6. **Computations that run without demand.** Not started. First, as ruled:
   a record says whether its piece holds a materializer, and a loop that
   serves a space for any demand starts the marked pieces that do, at low
   priority, with a throttle if measurement asks for one. Then the finer
   rule: envelopes among the write rows; a computation recorded as
   unbounded from what it wrote; the unsettled space, settled before a
   judgment in it or a pull from it returns; the writer's registration for
   a declared destination in another space; and the counts the open
   question needs. The finer rule is built on step 5, which starts a
   producer in another space, and on the first plan's stage 5, which starts
   one in the same space, and "What the rows for an envelope need" lists
   what is to be settled before it.
7. **The interval clock's expiry.** Done. A space is armed with one it
   reads only until the earliest slice there expires.
8. **Measure** a social space whose pieces read each viewer's profile, with
   two viewers and with many, for the starts saved and for what a change to
   one profile costs its readers. Done:
   [the record](../history/development/performance/2026-11-21-currency-index-across-spaces.md).
   A return starts nothing. A judgment is repeated for every unstarted root
   on each change of demand, and one watching viewer's change starts each
   piece they watch for every viewer; both are costs still to take out.

## Acceptance tests

For the index, in `runtime/memory/test/`, with two stores. Tests 1 to 4
exist in `v2-currency-index.test.ts`, with the readers a source finds to
tell after each kind of change. Tests 5, 7 and 8 exist in
`v2-server-currency-across-spaces.test.ts`, which has the memory server
register, pull, arm and tell, with a source it holds and one another owner
holds. It also has a chain of ten spaces that is never held, and two spaces
that read each other held after eight laps, for longer each time, and
released by a change with no trigger behind it:

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
5. With three stores in a chain, a commit to the first triggers the second
   and the third once each and marks nothing in them, and a pull by the
   third marks the reading slice in it.
6. A registration the source refuses, and one whose grant is revoked later,
   leave the reader's slice marked `2`.
7. A second change before a reader pulls sends it no second trigger, and a
   change after its pull sends one.
8. A judgment of a root on a slice whose source is armed and has sent no
   trigger makes no request of that source, and one after a trigger pulls
   before it judges.

For the serving loop, in `runtime/runner/test/executor/`:

9. A piece whose wish reads the viewer's home space is recorded with the
   read in that viewer's slice, and under `skip` is not started when the
   viewer returns and their home space has not changed. This exists in
   `space-server-currency-wish.test.ts`, with the root refused, and under
   `skip` the piece started, once the home space changed while nothing
   served the piece. The same file holds the case of a home space whose
   own serving loop made its root, whose documents no recorded piece
   writes: the viewer's slice is stored clean, and a change to the list of
   favorites the root's setup wrote starts the piece.
10. A change to that viewer's home space while the piece is unstarted and
    their session is live starts the piece, and the viewer reads the new
    value. A change to the home space of a viewer who is no longer watching
    does not. Both exist there.
11. The chain above, with all three recorded and none running: a demand for
    C alone starts B and A, and C's session reads the value derived from the
    new input.
12. In that chain, when A's recomputation leaves `a` equal, the marks of B
    and C clear and C's session reads the value it held. Both exist in
    `space-server-currency-chain.test.ts`, with a viewer who holds no grant
    on the first two spaces, and with a demand for C that starts nothing
    while no input changed. That B, once the demand for `b` has started it,
    derives nothing further is not checked.
13. A piece that reads `#now/N` is served from the store within the
    interval and started after it, and a root a loop holds unstarted is
    loaded when the interval passes. Both exist in
    `space-server-currency-wish.test.ts`, and the index's side in
    `v2-currency-index.test.ts`. A root in another space that read what a
    piece computes from the expiring slice's output is refused once the
    time has come, one space along and two, in
    `v2-server-currency-across-spaces.test.ts`.
14. A piece whose headless wish shares a hashtag resolver is recorded
    clean, with the resolver's read of the space's root among its slice's
    reads. This exists in `space-server-currency-wish.test.ts`; two pieces
    on one resolver, and the mark a change to that root leaves on both, are
    still to write.

For computations that run without demand, in both places:

15. A slice that reads a document inside another piece's declared envelope
    is marked `1` when that piece's slice is marked, and cleared when the
    piece ran and wrote nothing the slice read.
16. A change to an input of an unstarted piece with a materializer,
    followed by a demand for a reader of its envelope in another piece,
    starts the materializer's piece, and the session reads what it wrote.
17. A computation that wrote outside its declared surface is recorded as
    unbounded. A change to its input while its piece is unstarted and no
    session watches the space starts nothing, and the next judgment in the
    space starts the piece before it returns.
18. A pull from an unsettled space returns after that space has settled,
    and a trigger that reaches it while it is dormant is passed to each of
    its armed readers without a pull.
19. A reader of an instance that a piece in another space declares it
    writes is marked `1` while that piece's slice is marked there.

For demand across spaces. All four exist: 20 in
`runtime/memory/test/v2-server-carried-demand.test.ts`, 21 in
`runtime/runner/test/executor/carried-demand.test.ts`, and 22 in
`runtime/runner/test/executor/space-server-carried-demand.test.ts`, with a
change to a shared input of the other space, which reaches both viewers:

20. A row carried into a space stands in its demand set with the origin
    session's pair, tells the serving host as an opened session does, is
    left out while the space's index proves its instance current and stands
    again once a piece there is behind on it, is refused for an actor's own
    instance without that actor's READ grant, and is dropped when its
    origin session ends.
21. A read made in the `space` slice is carried for every demanding pair,
    one made in a user's slice for that user's pairs, one made in a
    session's slice for that pair, and each user's own instance of a
    document for that user's pairs and no other's.
22. A piece in one space whose runs read a `PerUser` instance of another
    space, watched by two viewers who have no session in that other space:
    its loop computes each viewer's instance, each viewer reads their own
    through the piece, and a change to an input there reaches them.
23. A slice that read its actor's own instance in another space, a user's
    or a session's, is stored clean where the actor holds READ there and
    marked `2` where the actor holds none, and nothing is registered for
    the second. A grant withdrawn afterward marks the slice `2` and drops
    its registration, at the next record and at the judgment that follows
    the change to the access list
    (`v2-server-currency-across-spaces.test.ts`). Under `start-upstream`
    the piece of test 22 is left unstarted, and carries nothing, while
    each viewer's instance is unchanged, and is started when an input of
    the other space's piece changes, which brings each viewer the new
    value. Under `skip` the loop carries nothing into the other space,
    which computes no instance for a viewer with no session there
    (`space-server-carried-demand.test.ts`).

## Related

- [`stored-output-currency.md`](stored-output-currency.md): the index this
  extends. Its stage 5 starts a stale producer within one space, and its
  stage 6 advances a space no loop serves.
- `docs/specs/server-side-execution/verification-coverage.md`, OW35: the
  two gaps of a read across spaces under a carried actor.
- `docs/specs/server-side-execution/builtins.md` §5: a wish resolved for
  each demanding identity.
