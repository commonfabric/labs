# Upgrading pieces at scale

_A release is published once, checked once per piece that starts, and written to
a piece only when that piece starts. Nothing a release does is a write per
piece, and nothing in it depends on who published the release._

**Status:** proposed and exploratory · **Updated:** 2026-11-19

Every piece pins the exact executable it runs, and moving that pin is a guarded
transaction on that piece. That is the right model for user-owned data and this
plan keeps it. What does not work, today, at the scale the deployment already
has, is doing that transaction per piece per release, by hand, in order.
Upgrading one Topics board and its topics is an eight-step procedure
([topics-computation-cost.md](topics-computation-cost.md), "Stored-state and
deployment procedure"): inventory every target, rehearse on a clone, choose an
order from an old/new compatibility matrix, apply serially and inspect each
result before the next, verify authored content by hand, coordinate legacy
writers and client refresh, and obtain live authorization for the manifest.
Merging the source changes nothing a user holds, because those pieces follow no
origin: they were put on their source by `setsrc` and `retarget`, both of which
detach ([piece-bulk-operations.md](../features/piece-bulk-operations.md), "The
origin a retarget detaches"), so the only thing that can move them is an
operator moving each one. The most recent such update needed a decision record
to force every deployed Topic past a refusal that guarded nothing
([topics-profile-picture-forced-update.md](../history/topics-profile-picture-forced-update.md)),
and an earlier one left two versions writing the same space at 96% of commits.
That is the cost at thousands of pieces in one space, and it is the procedure
every in-place update against real data follows today
([space-clone-rehearsal.md](../development/space-clone-rehearsal.md)).

Topics is a pattern this team maintains. It is not a system pattern, and the
fact that the patterns route happens to serve its source does not make it one.
So the mechanism that carries a Topics release has to be the one any pattern
provider can use from outside this deployment: publish the pattern in a space,
and let pieces anywhere follow it. This plan puts Topics on that mechanism,
which is specified and partly built, and uses Topics to finish it. The `system:`
origin stays what it is: the tier the deployment's own CI vouches for, which the
Home and default-app roots follow.

The same design holds at the scale this repository is written toward, millions
of users each holding ten to a hundred thousand pieces, because nothing in it is
a write per piece. That is a check on the design rather than its motivation: a
mechanism that is tractable at 10^11 pieces is one that is routine at 10^4. It
is the design for mechanisms 3 and 4 of
[the longer arc in verb evolution](verb-evolution.md#the-longer-arc): per-piece
upgrade policy, and upgrades that run code.

## The short version

- **Where the cost is.** Source and compiled modules are content-addressed cells
  per space ([module-loading.md](../specs/module-loading.md)), so a hundred
  thousand pieces on one pattern in one space share one copy of their code. What
  is per piece is the pointer and the guarded transaction that moves it. Storage
  is not the problem. Writes per release are, and a release that writes only to
  pieces that start costs O(pieces opened), not O(pieces).
- **Two things called "upgrade" cost differently.** A code change under the same
  argument and result contract is a pointer move. A change to the stored shape
  of data has to touch or reinterpret every document in that shape. Most
  releases are the first kind; pricing them like the second is the mistake this
  plan is organized to avoid.
- **A piece can only follow a release if it follows an origin.** Topics' pieces
  follow none, which is the whole of today's procedure. The origin they should
  follow is a published pattern in a space this team owns, through the same
  fabric-origin follow any provider would use. Who published the release decides
  only what adopts unattended, never how following works.
- **Mixed stored shapes are normal, and a scan is not a touch.** Data in two
  shapes is safe under four rules stated below. An index backfill reads storage
  through a schema and starts no piece, or building one index writes every
  piece.

## What this rests on

Checked against the tree as of `b38ab3d9b4` (2026-11-03).

- **Following is one mechanism, on one trigger, with two origin kinds.** A piece
  follows its origin when it starts: a client follows when it opens, and the
  serving runtime follows before its first start of a piece in a tenure. Nothing
  reconciles a piece nobody started. The two things it follows are a `system:`
  ref and a fabric URL. A `system:` candidate is adopted as it stands because
  the release was gated; a candidate from any other origin has to prove itself,
  today by leaving the piece's argument and result schemas exactly as they are,
  and is otherwise offered to the owner
  ([piece-source-lifecycle.md](../specs/piece-source-lifecycle.md), Status and
  invariant 7;
  [serving-loop.md §3e](../specs/server-side-execution/serving-loop.md)).
- **Resolution is already cheap.** A `system:` ref resolves through the
  toolshed's `?identity` route, so an unchanged pattern costs one conditional
  request and no compile. Opens for the same destination and identity share one
  compile, later opens in the same registry epoch are served from the pattern
  the space already holds, and compiled modules persist as content-addressed
  cells per space (lifecycle, "Automatically refresh a mutable URL-origin
  piece"; `runtime/runner/src/source-reconciler.ts`, `#resolveSupplied`). A
  follow spends its time in the transition when the pointer has to move, not in
  finding out whether it does.
- **The fabric-origin follow is built in part.** The reconciler follows a
  mutable fabric entity: it syncs the source piece, watches its
  `patternIdentity`, copies the program from the source space to the follower's,
  and adopts through the same guarded transition (`#followFabric`).
  `cf piece follow --cell <piece> <origin>` accepts a `cf:` URL
  (`runtime/piece/src/ops/piece-origin.ts`). What the lifecycle lists as
  missing: creation from a fabric URL, the export selector (a follower today
  takes the source piece's export), cross-space source replication under CFC
  policy, the acceptable-replacement relation, and the live subscription to a
  mutable entity's revision head. A child of a `system:` follower records the
  `system:` ref of its module; a child of a fabric follower records no origin
  (lifecycle, "Instantiate a piece from pattern code").
- **No piece-start policy under server execution (RULED 2026-08-02).**
  Activation loads what demanded values and queued events need and never
  instantiates pieces as a step of its own
  ([serving-loop.md](../specs/server-side-execution/serving-loop.md), "What
  activation LOADS"). View-scoped replication already separates execution demand
  from delivery
  ([view-scoped-client-replication.md](../features/view-scoped-client-replication.md)).
- **Two gates, and what each sees.** Tier 1 proves a pattern's current argument
  and result contract applies over every contract recorded for it, with
  append-only baselines; a new required field needs a `Default<>`. It does not
  see a pattern's internal stored shape: moving where a field is stored changes
  the contract "not by a byte". Tier 2 proves a real document written by an
  older version is still readable, and is the gate that does see stored shape
  ([pattern-update-testing.md](../specs/pattern-update-testing.md)). Separate
  from both, a transition runs an admission proof over the piece's retained
  links and stored envelopes; that proof, not either gate, is what refused the
  last Topics update (the forced-update record above).
- **Topics already migrates its own state on touch, and writes when it runs.**
  [`patterns/apps/topics/state-upgrades.md`](../../patterns/apps/topics/state-upgrades.md):
  an ordered list of step identifiers, a runner the lift runs when the topic
  runs and every durable verb runs before its first write, each step reading
  everything before writing anything, deterministic, tolerant of an
  already-upgraded target. Running a topic is enough for the lift to write. Its
  second step stores `commentCount` and `lastActivityAt` so the board index is
  right without the topic running after each write, and required every topic to
  run once.
- **A result document carries a content-addressed `schema` stamp**
  ([content-addressed-schemas.md](../specs/content-addressed-schemas.md)), so a
  stored result already says which contract wrote it.
- **Coexistence without management has a measured failure.** Two running
  versions once rewrote each other's output at 96% of commits
  ([verb-evolution.md](verb-evolution.md#the-longer-arc), mechanism 3). That
  came from two running versions, not from two stored shapes at rest.

## The design

### 1. The piece adopts when it next starts

A piece's pointer is the record of what it runs, and the lifecycle already moves
it at one moment: when the piece starts, by following its origin. This plan
keeps that moment and adds no other. A release therefore writes nothing to a
piece nobody starts, and the per-piece write it does make is the one the
lifecycle makes today. A space nobody activates never pays, and when it wakes
several releases late its pieces jump straight to the current release, which
Tier 1's append-only baselines already prove safe for the contract and Tier 2's
fixtures for the stored shape.

**What the per-piece write costs, and what it does not.** The write a start
makes on the same-contract path (§2) is three small metadata fields, the pattern
pointer, an append to the revision log of content-addressed links, and the
reconciliation record, guarded by a compare of the revision head. It reads the
piece's meta and nothing of its data, runs no pattern code, and is reversible:
the log is append-only and restore is a revision. A state migration (§6) reads
the piece's stored data, runs the pattern's code, writes data cells under a
conflict surface that includes every cell a person might be editing, and is not
reversible. The two differ by one to three orders of magnitude per piece, and in
kind. The one cost a pointer write carries that is easy to miss is fan-out: each
commit invalidates the watches of every connected session on that piece, which
is why, when many pointers move at once, they move in few commits rather than
many.

**The eager sweep is an option.** Moving every follower's pointer when the space
activates, in batched transactions carrying the invariant-4 guards per row, buys
a first start without a deferred follow and a revision log consistent at one
moment. It costs O(followers) metadata writes per space plus the fan-out, and
neither thing it buys is needed for a release to be correct. It is an operator's
or a deployment's choice under a budget, never a step a release depends on.

**A piece can only follow what it follows.** None of this reaches a piece
without an origin, and Topics' pieces have none. §8 says which origin they take
and why.

### 2. A same-contract adoption is a pointer move

The follow transition restages the piece's stored argument against the
candidate's schema and proves the candidate over the piece's retained links and
stored envelopes. When the candidate's argument and result contracts hash equal
to the ones the piece is on, there is nothing to restage and nothing a retained
link held to the prior contract can fail, so the transition is the pointer write
and the revision append.

"Same contract" means argument and result schemas, which is what Tier 1
compares. A pattern's internal stored shape is not in it. A release that changes
only how a pattern stores its own state is a same-contract release here, adopts
as a pointer move, and relies on the pattern's migrate step (§6) when the piece
runs. That is the case Topics' own runner already handles, and it is why putting
Topics on an origin does not wait for anything in §3 through §6.

### 3. A data change is classified before it ships

Every change to a pattern's stored shape is one of three classes, decided by the
author and checked by a test, and the class decides every later cost.

| Class                    | Example                                                                                         | Who reinterprets old data                                               | Who sees two shapes                               |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| **Schema-expressible**   | A new field with a `Default<>`; a rename the schema can alias                                   | The runtime, for every reader, through the reader's schema              | Nobody above the storage layer                    |
| **Pure function**        | Splitting a name into parts; deriving a search text                                             | The owning pattern's migrate step, on touch; a scan's reader, in memory | Reactive observers for one update; storage tools  |
| **Needs the write path** | Minting a new identity or link; anything needing external data, a model, or a person's decision | Nobody can; the data does not exist until written                       | Every reader, until the piece is touched or swept |

The lazily readable classes are the first two, and the line between the second
and third is exact: a pure, total, deterministic function of the stored
document. A migration that mints a collection occurrence identity cannot be
applied at read time, because the identity must be stable across reads; one that
consults a model or asks a person cannot be applied at all without a write.
Knowing a change is in the third class before it ships is what keeps a release
from discovering, at scale, that it needs the one sweep this plan rules out.

Today the schema-expressible class is defaults alone. A read-time alias (read
`title`, and where it is absent read `name`) is a runtime addition that moves
every rename from the second class to the first, and is staged below.

### 4. Two stored shapes are the normal state

Stored data in an older shape beside data in the current one is how a corpus
with dormant members looks at every moment. It is safe under four rules, each of
which has a test.

1. **A document says which shape it is in; nothing sniffs.** The
   content-addressed `schema` stamp a result document carries is the shape
   marker, and a pattern-level migration records the identifier of its last
   completed step. "If `title` exists it is the new shape" works once and is
   ambiguous by the third change. A reader applies the chain of
   reinterpretations from the recorded shape to the current one, each step
   covered by a Tier 2 fixture of the shape before it.
2. **A reinterpretation is a pure, total, deterministic function of the stored
   document.** Class 3 of the table above is excluded by construction.
3. **The stored shape is part of what a pattern promises.** State in this system
   is observable: any principal the space's ACL admits can link to a stored
   cell, query it, or mount it, so "storage is private" is not available. What
   is available is a discipline: the stored shape changes only by the classes in
   the table, every shape ever written has a Tier 2 fixture, and a change ships
   with the reinterpretation that reads the shape before it. Foreign readers
   read a piece's results where they can, because a result is computed from
   either shape by current code; where they read a stored cell, the
   reinterpretation must be schema-expressible or shipped with the pattern for
   the reader to import. Storage-level tools (`cf` reads, FUSE, `cf inspect`)
   read the stored shape and should: they are inspecting storage, and the stamp
   says what they are looking at.
4. **A write transitions the whole document, atomically.** The hazard is a
   document half in each shape. The owning pattern's migrate step runs when the
   piece starts and before a verb's first durable write, and rewrites an
   old-shape document to the current shape in one transaction under the hash
   precondition `repair` uses, so a concurrent edit is not clobbered. Where the
   document is a collection, this fights concurrent mergeable appends
   ([migrating-collection-writes.md](../features/migrating-collection-writes.md)),
   so a collection migrates per element where its shape allows. A foreign writer
   that knows nothing of shapes is what rule 1's marker plus "exactly one shape
   per document" lets the owning pattern detect and refuse or repair.

So a demanded piece is migrated at its start, as Topics' lift does today, and
read-time reinterpretation serves the readers that are not the owning piece: a
scan (§5), a foreign reader of a stored cell, and the one-update window in which
a reactive observer sees the old shape before the start that migrates it.

What this buys: convergence driven by use. A touched piece migrates; a cold one
never pays. Rollback stays cheap for untouched pieces, because nothing was
rewritten; touched pieces are forward-only unless a downcaster ships too, which
is the argument for holding a risky migrate step one release behind its
reinterpretation. What it costs: a reinterpretation lives as long as any reader
might see its shape, which with dormant spaces is indefinitely unless a sweep
retires it. Budget for a growing chain, and for a large collection reshape on a
hot path, which is the case where a one-time write is wanted.

### 5. Observation is a touch; a scan is not

Two kinds of read, and the machinery must keep them apart.

- **Demand.** A reader wants the piece live. Under server execution this starts
  the piece, which follows its origin, which runs the migrate step. One piece,
  one transaction, triggered by someone using it. "Two shapes across the corpus"
  becomes "two shapes among pieces nobody has observed since the release", which
  is a set nobody is looking at.
- **Scan.** A reader wants the stored documents: a query, an index backfill, a
  survey, a search. A scan reads storage through a schema and **never starts a
  piece**: no follow, no migrate step, no revision, no per-piece transaction.
  For the schema-expressible class the runtime reinterprets on read. For the
  pure-function class the pattern ships the function and the scanning reader
  applies it in memory to each document. For the third class there is nothing to
  read until the write path has run, which is a cost of the change, not of the
  model.

The same separation applies to derived fields. An index over a per-piece
_output_, a search text or an embedding, would have to run the piece to read it,
which is demand. Instead the pattern ships the derivation as a pure function and
the indexer computes it from stored data. No piece runs. And no piggybacking:
"we are reading every document anyway, write the new shape while we are there"
turns the affordable scan back into the sweep this plan rules out. Migration
stays touch-driven; indexing stays read-only.

The index itself keeps a per-space record of the definition it was last built
against, an O(1) skip when it matches, one backfill scan per space per
definition change on activation, and reactive maintenance from writes after. A
dormant space is never indexed because nobody searches it.

### 6. The write path, when it is needed

For the pure-function class the migrate step is the generalization of Topics'
`upgradeTopicState`: run when the piece starts and by every durable verb before
its first write; each step reads everything it needs before its first write,
returns completion only after its writes, tolerates an already-migrated target,
reads no clock, and states which mutations remain valid while it is incomplete.
The runtime supplies the runner and the place in the follow transition, so a
pattern declares its steps and nothing else.

The step writes what the predecessor's handlers protected, which under CFC takes
the writer delegation SC-22 describes. A successor from a gated origin carries
it unattended; one from any other origin carries none today, so the step waits
on the owner's acceptance of the release (invariant 7). §8 says what this plan
asks to change there.

For the third class, and for retiring a reinterpretation, the write path is a
**per-space background sweep**: rate-limited, resumable, with the plan-row
guards bulk operations already carry, performed by the pattern's migrate step
over the space's pieces while the space is active. Millions of users become
millions of small independent jobs, each triggered by activity, each skipped
when current, and none on the critical path of opening the space. The
composition across releases is the standard online schema migration: release N
ships the reinterpretation and the migrate step together; touch and the sweep
converge the data; release N+k drops the reinterpretation once the surveyed
shape distribution says the remaining old-shape spaces are ones the owner is
content to leave. The `repair` bulk operation stays the operator's tool for
one-off damage.

### 7. The rollout window

The one measured failure on this path is two running versions writing the same
space. Server-side, following before the first start of a piece in a tenure, and
a deployment restarting the process so a release's tenures begin after it, mean
no old server code runs after the release. A client running the piece itself is
the gap: a tab that has not reloaded keeps its old code until the next open, and
it writes. Topics' procedure, retire legacy writers before applying the update,
is the mitigation available today, and
[the remote-echo breaker](scheduler-remote-echo-breaker.md) bounds the storm
when it is not followed. A migrate step that rewrites whole documents widens the
window's blast radius, which is a further reason to hold it one release behind
its reinterpretation on anything with many concurrent writers.

### 8. One mechanism, and the publisher decides only what adopts unattended

Following an origin is how a piece receives a release, and nothing in §1 through
§7 depends on who published it. The lifecycle already states the one thing that
does depend on the publisher as a trust question (invariant 7): a candidate from
an origin whose releases this deployment gates is adopted as it stands; a
candidate from any other origin has to prove itself. This plan keeps that line
and puts Topics on the second side of it, because that is the side any provider
stands on.

**The `system:` tier** is a pattern this deployment's toolshed serves, gated by
this deployment's CI. Its candidate adopts as it stands and carries the writer
delegation. The Home and default-app roots follow it, and nothing here changes
how they do.

**The provider tier** is a pattern published in a space: a piece, in a space the
provider owns, running the pattern's current source. Pieces in other spaces
record its fabric URL as their origin, by their owners' explicit consent
(invariant 10), and follow it when they start. The provider releases by moving
that one piece's source, which is one `setsrc`, not one per follower; a provider
inside this deployment may instead have the publishing piece follow a `system:`
ref, so that deploying publishes. Adoption is proved by the adopting runtime,
over the piece's own recorded contract, so nothing the provider says about its
history is consulted:

- a same-contract candidate adopts as a pointer move (§2), which is the rule
  today;
- a contract-moving candidate adopts unattended when the adopting runtime proves
  the candidate's contract applies over the piece's recorded contract (the Tier
  1 relation, run at adoption) and the change is schema-expressible (§3's first
  class), which is the class whose safety a contract relation can prove;
- anything else is offered to the owner, which the piece menu already does.

**The migrate step from a provider.** Invariant 7 gives an unattended update
from a non-gated origin no writer delegation, so a provider's migrate step (§6)
cannot run until the owner accepts the release. That is the right default for an
origin an owner has not chosen. For one they have, this plan asks the lifecycle
for one amendment: the owner's explicit consent to follow a mutable origin
(invariant 10) is also consent to the migrate steps its releases declare, and
confers the delegation, as the
[creator-owns plan](piece-creator-owns-update-added-fields.md) already reads
that consent ("the piece's creator chose the origin, and with it delegated every
later release"). Until that is ruled, a provider's data migration is an offer
each owner accepts once, and every same-contract and schema-expressible release
reaches its followers with no one in the loop. A candidate in the third class is
refused from every origin unless the release names its sweep.

**What a child follows.** A child a following piece instantiates records its
parent's origin, with its own export: a board that follows a publication makes
topics that follow it. Today only a child of a `system:` follower records an
origin, and a fabric follower takes the source piece's export, so a topic
following a board's publication would be moved onto the board. Both are
amendments to the lifecycle's origin resolution and are Stage 1 work: a fabric
origin names a program, and the follower keeps the export it runs, which is what
a `system:` follow does already.

**Pinned origins** never report an update (invariant 14), and source that moves
between spaces is an information flow CFC checks before anything is copied
(invariant 13). Neither changes.

## Strategy by scale

The first two rows are today's deployment. The rest is the same mechanism with
nothing added; the table is here to show that, not to schedule for it.

| Situation                                                   | What runs                                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| One piece, one developer                                    | `setsrc`, detach, repoint, revert, as today                                                                                                   |
| Thousands of pieces in one space (Topics)                   | Pieces follow a published pattern; each adopts on its next start (§1); same-contract releases are pointer moves (§2)                          |
| Millions of users × 10^4–10^5 pieces, same-contract release | Publish once; each piece adopts on its next start after one conditional request; nothing per piece until it is opened                         |
| Same, with a stored-shape change                            | Classify (§3); reinterpret on read and migrate on touch (§4, §6); per-space background sweep for the third class and for retirement           |
| A feature needing every piece's state (search)              | A per-space backfill scan with the reinterpretation or derivation in the reader (§5); O(pieces) reads once per index definition, never writes |

## What this plan does not change

- Per-piece pinning, detach, revert, repoint, and the append-only revision log
  stay as the lifecycle specifies them. Every piece's start compares its own
  pointer; no record stands in for that.
- Nothing runs for, and nothing is written to, a piece nobody starts. The moment
  a piece's pointer moves is the moment the lifecycle already moves it.
- No sweep, global or per space, is a step of any release. The eager pointer
  sweep in §1 and the migration sweep in §6 are options taken under a budget.
- The `system:` tier and the roots that follow it.
- Static `cf:` imports keep their snapshot semantics (invariant 8).

## Formats without version numbers

[DEVELOPMENT.md](../development/DEVELOPMENT.md#general-principles) asks that a
format be built so a reader handles older and newer writers alike, rather than
marking each change with a version. This plan's markers are identities, not
counters: a document's shape marker is the content-addressed schema that wrote
it, which the runtime already stamps, and a pattern's migration progress names
the identifier of the last completed step, which is what Topics' ordered
identifier list already encodes behind its integer. The half of the principle
that asks a reader to handle every writer is exactly rule 1's reinterpretation
chain.

## What needs a ruling

1. **Does consent to follow confer the writer delegation?** §8 asks that an
   owner's explicit consent to a mutable origin also delegate to the migrate
   steps its releases declare, so a provider's step runs unattended for
   followers that chose the origin. That amends invariant 7 and is a CFC
   question before it is a trust one. Without it, a provider's data migration is
   an offer each owner accepts once, and everything else in the plan works.
2. **May a space-level sweep run pattern code for a piece nobody demanded?**
   Moving a pointer does not start a piece: `setsrc` moves one in a setup
   transaction under the writing principal, and the swap is the server's
   reaction when the piece is next demanded
   ([serving-loop.md §3e](../specs/server-side-execution/serving-loop.md)). A
   sweep the runtime starts on activation has no such principal, so even §1's
   pointer sweep is a question for the ruling rather than settled by it. A
   migrate step is pattern code, and running it for an undemanded piece is a
   start, so §6's background sweep needs the ruling
   [scheduled work in the server](scheduled-work-in-the-server.md) waits on, a
   second issuer of demand where the specification pins the count at one, or it
   stays touch-driven, which is still correct, only slower to converge.
3. **Does a cross-piece read of a stored cell on a client runtime start the
   owning piece?** On the serving runtime, demand starts the piece either way.
   On a client that runs pieces itself, if the target does not start, that is
   the one real leak of an old shape past §4 rule 3, and the fix is either
   confining the stored cells foreign pieces link to the schema-expressible
   class, or giving the client the same demand-starts rule.
4. **Where the shape marker lives for a pattern's internal state.** The `schema`
   stamp marks a result document; Topics marks its internal state with
   `topicStateVersion`. The general runner needs one place for internal
   documents, and the identifier-of-last-step form above is the proposal.
5. **Who owns a field the migrate step adds.** Follows the ruling the
   [creator-owns plan](piece-creator-owns-update-added-fields.md) is waiting on.

## The owner's decision

Putting Topics' pieces on a published origin means a merged release reaches
every deployed topic once an operator moves the publishing piece's source, and
each topic's adoption is proved by the runtime over that topic's own contract:
same-contract releases, including every stored-shape change Topics' own runner
carries, adopt with nobody else in the loop; a contract-moving release is an
offer until Stage 3's classification test lets the schema-expressible ones adopt
too. Today an operator stands at every topic. The decision is whether Tier 1,
Tier 2, Topics' runner, and the per-piece admission proof are enough once the
publishing piece moves, and if not, which finding should keep that one piece's
source from moving.

## Stages

Each stage lands on its own and leaves the system better than it found it.

### Stage 0 — Measure and rehearse

- [ ] On a clone of the live Topics space, publish Topics' current source as a
      piece in a team-owned space, `cf piece follow` the cloned board and a
      sample of topics onto its `cf:` URL, then move the publication to the
      kept-activity release and start them. This settles whether the retained-
      link admission proof that refused the forced update refuses a follow too,
      and whether the export and child-origin gaps in §8 bite.
- [ ] Cost of one follow transition by phase (resolve, compile or cache hit,
      verify, restage, revision append, commit) on a following piece in a
      populated space, with the perf-investigation recipe. This decides whether
      any per-space caching beyond what exists is worth building.
- [ ] How many of the last twenty Topics and system-pattern releases changed an
      argument or result contract, and how many changed a stored shape. This is
      the evidence for §2 and §3 and decides how much of Stages 3 to 5 is worth
      building first.

Success: the numbers are in a history document and the stage order below is
confirmed or reordered by them.

### Stage 1 — Topics follows a published pattern

- [ ] A fabric origin names a program; the follower keeps the export it runs. A
      child a following piece instantiates records its parent's origin with its
      own export, for fabric origins as for `system:` ones.
- [ ] Cross-space source replication under CFC policy on the fabric follow,
      failing closed before copying (lifecycle invariant 13), where the
      rehearsal shows it is not already enforced.
- [ ] A publication piece for Topics in a team-owned space. Whether it follows a
      `system:` ref, so that deploying publishes, or is moved by hand, so that
      publishing is a deliberate act, is the owner's decision above.
- [ ] Put the deployed board and topics on the publication's `cf:` URL, once,
      with `cf piece follow`, rehearsed per
      [space-clone-rehearsal.md](../development/space-clone-rehearsal.md). This
      is the last operator retarget of those pieces.
- [ ] An index of pieces by origin within a space, for the survey in Stage 5 and
      the optional sweep, so neither walks the registry.

Success: a same-contract Topics release reaches the board on its next open and
each topic on its next start once the publication moves, with no operator step
at any topic; a contract-moving release is an offer, not an eight-step
procedure; no piece is written until it starts.

### Stage 2 — Same contract, pointer move

- [ ] The follow transition compares the candidate's contract hashes with the
      piece's and skips the argument restage and the retained-link proof when
      they match, with a test that a same-contract adoption writes nothing but
      the pointer and the revision.

Success: a same-contract release's per-piece cost is the pointer write and the
revision append.

### Stage 3 — Migrate on touch, generalized; what adopts unattended

- [ ] A runtime-supplied runner in the follow transition and before a verb's
      first durable write, taking a pattern's ordered step identifiers and their
      implementations under the step contract Topics states; Topics'
      `upgradeTopicState` becomes a declaration to it.
- [ ] The whole-document-per-write rule (§4 rule 4) enforced by the runner under
      a hash precondition, per element for collections.
- [ ] A Tier 2 fixture per recorded shape, and a check that a pattern declaring
      a step has one for the shape before it.
- [ ] A classification test: a step's implementation is a pure function of the
      document (no clock, no identity minting, no fetch), or it is declared as
      write-path-only and is excluded from read-time reinterpretation.
- [ ] The acceptable-replacement relation for a contract-moving candidate from a
      non-gated origin: the adopting runtime proves the candidate's contract
      over the piece's own, and adopts unattended only when the change is
      schema-expressible.
- [ ] The delegation ruling (question 1) applied, or the per-release offer kept.

Success: a pattern with a declared step migrates on start and on first write
with no code of its own beyond the steps, and a schema-expressible Topics
release adopts with no one in the loop.

### Stage 4 — Scans do not demand

- [ ] A scan API that reads a space's documents through a schema, applying
      schema-expressible reinterpretation, and provably starts no piece: a test
      that a scan over a space of followers of a moved origin leaves every
      pointer and revision log unchanged.
- [ ] An index definition names the pattern-shipped pure function it applies to
      each document, and a per-space record of the definition it was last built
      against; backfill on activation when the record does not match, resumable,
      then reactive maintenance from writes.
- [ ] A read-time alias in the schema vocabulary, so a rename needs no step, and
      Tier 1 recognizes the alias as compatible with the baseline that has the
      former name.

Success: building a search index over a space of old-shape pieces writes nothing
to any piece and is correct for both shapes; a field rename ships as a schema
change with no migrate step.

### Stage 5 — Retirement and the optional sweeps

- [ ] A survey of shape distribution per space (`cf` read-only, from the
      markers), feeding the decision to drop a reinterpretation.
- [ ] The optional eager pointer sweep (§1) and, if ruled in (question 2), the
      per-space background migration sweep, both per space, budgeted, resumable,
      and carrying the invariant-4 guards per row.

Success: a reinterpretation can be retired on evidence, and neither sweep ever
blocks a space's open or is a step a release depends on.

### Beyond Topics

The rest of the fabric-origin work the lifecycle lists, which a provider outside
this deployment needs and Topics does not: creation from a fabric URL in
`cf piece new` and the piece menu, the live subscription to a publication's
revision head while a follower runs, and the stored export selector for pinned
origins. Each is independent of the stages above.

## Relationship to other documents

- [piece-source-lifecycle.md](../specs/piece-source-lifecycle.md) is the design
  of record for what a piece records and how following works. This plan asks it
  for three amendments: a fabric origin names a program and the follower keeps
  its export; a child of any follower records its parent's origin; and consent
  to follow confers the migrate step's delegation (question 1). Stage 1 and
  Stage 3 are part of its "Work required" for fabric origins.
- [pattern-updates.md](../specs/pattern-imports/pattern-updates.md) is the
  design of record for the `system:` origin, which this plan leaves as it is.
- [piece-bulk-operations.md](../features/piece-bulk-operations.md) and
  [its plan](piece-bulk-operations.md) stay the operator's tool; the optional
  sweeps reuse their plan-row guards, and Stage 1's follow is the last retarget
  Topics' pieces take.
- [verb-evolution.md](verb-evolution.md) names the problem and the four
  mechanisms; this plan is mechanisms 3 and 4.
- [topics-computation-cost.md](topics-computation-cost.md) and
  [`patterns/apps/topics/state-upgrades.md`](../../patterns/apps/topics/state-upgrades.md)
  are the first customer and the mechanism Stage 3 generalizes.
- [scheduled-work-in-the-server.md](scheduled-work-in-the-server.md) waits on
  the same demand ruling as the migration sweep.
- [piece-creator-owns-update-added-fields.md](piece-creator-owns-update-added-fields.md)
  decides who owns what a migrate step adds, and reads consent to follow the way
  question 1 asks.
