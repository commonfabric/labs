# Upgrading pieces at scale

_A release costs a check per active space, a write per piece someone opens, and
a read per piece only when an index's definition changes. Nothing a release does
is a write per piece._

**Status:** proposed and exploratory · **Updated:** 2026-11-03

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
to force every deployed Topic past a compatibility refusal that guarded nothing
([topics-profile-picture-forced-update.md](../history/topics-profile-picture-forced-update.md)),
and an earlier one left two versions writing the same space at 96% of commits.
That is the cost at thousands of pieces in one space, and it is the procedure
every in-place update against real data follows today
([space-clone-rehearsal.md](../development/space-clone-rehearsal.md)).

This plan puts every piece that should follow a release on an origin it can
follow, makes the space the place a release is checked and the piece's next
start the moment it is adopted, makes a same-contract adoption a pointer move,
treats data in two stored shapes as the normal state rather than a transient
one, and keeps the reads a search index needs apart from the writes a migration
makes. Each of those removes a step from today's procedure. The same design
holds at the scale this repository is written toward — millions of users, each
holding ten to a hundred thousand pieces — because nothing in it is a write per
piece, and that is a check on the design rather than its motivation: a mechanism
that is tractable at 10^11 pieces is one that is routine at 10^4. It is the
design for mechanisms 3 and 4 of
[the longer arc in verb evolution](verb-evolution.md#the-longer-arc): per-piece
upgrade policy, and upgrades that run code.

## The short version

- **Where the cost is.** Source and compiled modules are content-addressed cells
  per space ([module-loading.md](../specs/module-loading.md)), so a hundred
  thousand pieces on one pattern in one space share one copy of their code, and
  storing it is not what a release pays for. What is per piece is the pointer —
  `patternIdentity` plus export symbol, an origin, and an append-only revision
  log ([piece-source-lifecycle.md](../specs/piece-source-lifecycle.md), core
  invariants 1–4) — and the transaction that moves it: compile and verify the
  candidate, restage the stored argument against the new schema, append a
  revision, and compare revision head, pattern, origin, and argument before
  commit. Storage is not the problem. Writes per release are.
- **Two things called "upgrade" cost differently.** A code change under the same
  contract is, in principle, a pointer move. A change to the stored shape of
  data has to touch or reinterpret every document in that shape. Most releases
  are the first kind; pricing them like the second is the mistake this plan is
  organized to avoid.
- **The budget.** A release may cost O(active spaces) to check, O(pieces
  actually opened) in writes, and O(pieces) in _reads_ only when an index's
  definition changes. Reads are the one of the three that can be afforded at any
  scale: a scan over stored documents is batched and streamed, with no commit,
  no revision, and no per-piece authorization step. At today's scale the budget
  turns a serial, hand-ordered procedure into one activation of the space; at
  the target scale it is what makes a release possible at all.
- **The space resolves a release once; each piece adopts it when it next
  starts.** One cell per space records what each followed origin last resolved
  to and holds its compiled candidate, so a start in that space resolves and
  compiles nothing. Each start still compares the piece's own pointer to that
  resolution — a cold piece is still on the old identity, and the record cannot
  say otherwise — and moves it when they differ, which is what following already
  does, so a release writes nothing to a piece nobody starts. The per-piece
  write, when it comes, is a metadata write — pointer, revision, reconciliation
  record — not a data write, and the two differ by orders of magnitude (§1). An
  eager sweep that moves every follower's pointer at once is an option, not a
  step of a release.
- **A piece can only follow a release if it follows an origin.** Topics' pieces
  follow none, which is the whole of today's procedure. Putting them on one is
  the first stage.
- **Mixed stored shapes are normal.** Every schema-on-read system lives in this
  state. It is safe under four rules stated below, and it is the same choice
  this repository already made for code — the corpus runs many versions at once
  and compatibility is proved rather than enforced by sweep — applied one level
  down.
- **Observation is a touch; a scan is not.** Under server execution, demanding a
  piece's document starts the piece, which follows its origin, which can migrate
  it. An index backfill must not go through that path, or building one index
  writes every piece. A scan reads storage through a schema and applies any
  reinterpretation in the reader.

## What this rests on

Everything below is checked against the tree as of `b38ab3d9b4` (2026-11-03).

- **Following is one mechanism on one trigger: starting the piece.** A client
  follows when it opens; the serving runtime follows before its first start of a
  piece in a tenure, "whether a demanded document or a served event brought the
  piece up"; nothing reconciles a piece nobody started
  ([piece-source-lifecycle.md](../specs/piece-source-lifecycle.md), Status;
  [serving-loop.md §3e](../specs/server-side-execution/serving-loop.md)). A
  `system:` origin's candidate is adopted as it stands because the release that
  produced it was gated; any other origin's candidate must prove itself.
- **No piece-start policy under server execution (RULED 2026-08-02).** The space
  is one lazy reactive graph; activation loads structure sufficient to resolve
  demanded values and queued events and never instantiates pieces as a step of
  its own. Demand is value-granular client pull
  ([serving-loop.md](../specs/server-side-execution/serving-loop.md), "What
  activation LOADS"). View-scoped replication already separates execution demand
  from delivery: visible roots demand execution; supporting documents are
  delivery-only
  ([view-scoped-client-replication.md](../features/view-scoped-client-replication.md)).
- **Two gates prove compatibility across every version ever shipped.** Tier 1
  proves the current contract applies over every contract recorded for the
  pattern, with append-only baselines, so a dormant piece that wakes several
  releases late is the case the gate already measures; a new required field must
  carry a `Default<>`. Tier 2 proves a real document written by an older version
  is still readable
  ([pattern-update-testing.md](../specs/pattern-update-testing.md)).
- **A result document carries a content-addressed `schema` stamp**
  ([content-addressed-schemas.md](../specs/content-addressed-schemas.md)), so a
  stored document already says which contract wrote it.
- **Bulk operations exist, serially, one transaction per piece.** Survey → plan
  → preflight → apply → survey diff, with hash-preconditioned `repair` writes
  verified by re-asking the fixer and no derivable reverse
  ([piece-bulk-operations.md](../features/piece-bulk-operations.md)). Right for
  an operator's targeted repair; at 10^11 pieces, a millisecond each is years.
- **Origin-following is built, and Topics is not on it.** Any piece that records
  a `system:` origin follows it when it starts — the Home and default-app roots
  do — and `cf piece follow --cell <piece> <origin>` puts a piece on one
  ([pattern-updates.md](../specs/pattern-imports/pattern-updates.md) is the
  design of record; `runtime/cli/README.md` has the command). The patterns route
  serves the whole `patterns/` directory, subdirectories included
  (`createPatternsRoute` in
  `runtime/toolshed/routes/patterns/patterns-server.ts`), so a `system:` ref to
  Topics' source resolves today. A child a following piece instantiates claims
  the `system:` ref of its own module, so a board that follows makes topics that
  follow. Topics' deployed pieces follow nothing because `setsrc` and `retarget`
  both detach (invariant 5;
  [piece-bulk-operations.md](../features/piece-bulk-operations.md), "The origin
  a retarget detaches").
- **Fabric origins are specified and partly built.** The reconciler dispatches
  the `fabric-pattern` and `fabric-entity` origin kinds to a follow of their own
  (`runtime/runner/src/source-reconciler.ts`). The lifecycle lists what is
  missing: creation from a fabric URL, the live subscription to a mutable
  entity's revision head, cross-space source replication under CFC policy, and
  the acceptable-replacement relation — today a candidate from any origin the
  deployment does not gate is adopted only when it does not move the piece's
  contract at all, and is otherwise offered to the owner
  ([piece-source-lifecycle.md](../specs/piece-source-lifecycle.md), Status and
  invariant 7).
- **Topics already migrates its own state on touch.**
  [`patterns/apps/topics/state-upgrades.md`](../../patterns/apps/topics/state-upgrades.md)
  is a built, tested instance of the mechanism this plan generalizes: an ordered
  list of step identifiers, a shared runner the lift runs when the topic runs
  and every durable verb runs before its first write, each step reading
  everything before writing anything, deterministic, tolerant of an
  already-upgraded target, and a per-step rule for which mutations stay valid
  while the step is incomplete. Its second step is also the clearest example of
  an index needing per-piece state: it stores `commentCount` and
  `lastActivityAt` "so that the index is right without the topic running after
  each write" — and required every topic to run once.
- **Coexistence without management has a measured failure.** A board update once
  left old and new pattern versions writing to the same space at 96% of commits
  ([verb-evolution.md](verb-evolution.md#the-longer-arc), mechanism 3). That
  storm came from two _running_ versions rewriting each other's output, not from
  two stored shapes at rest; the distinction matters below.
- **Reactive indexes are runtime-maintained.** `groupBy` and `keyBy` build an
  index whose membership the runtime keeps current from writes
  ([collection-indexes.md](../features/collection-indexes.md)); a search index
  is the same shape with a backfill in front of it.

## The design

### 1. The space is checked; the piece adopts when it next starts

A piece's pointer is the record of what it runs, and the lifecycle already moves
it at one moment: when the piece starts, by following its origin. This plan
keeps that moment. A release therefore writes nothing to a piece nobody starts,
and the per-piece write it does make, when the piece starts, is the one the
lifecycle makes today.

What the space adds is one resolution and one compile per release instead of one
per piece. Each space records, in one cell, the identity each followed `system:`
origin last resolved to (not a counter — see "Formats without version numbers"
below) and holds that identity's compiled candidate. On tenure activation, or on
a client's open of the space, the runtime asks the origin once and updates the
record if the answer moved. A piece's start then compares its own pointer to the
recorded resolution — a local hash compare, with no fetch and no compile — and
runs its follow transition only when they differ. The record cannot stand in for
that compare: a cold piece is still on the identity it last ran, and a record
that matched the deployment would say nothing about it. What the record removes
is the per-start resolution and compile, which is where a follow spends its time
when the pointer does have to move. A space nobody activates never pays, and
when it wakes several releases late its pieces jump straight to the current one,
which Tier 1's append-only baselines already prove safe.

**What the per-piece write costs, and what it does not.** The write a start
makes on the same-contract path (§2) is three small metadata fields — the
pattern pointer in the meta seam, an append to the revision log of
content-addressed links, and the reconciliation record — guarded by a compare of
the revision head. It reads the piece's meta and nothing of its data, runs no
pattern code, is reversible (the log is append-only; restore is a revision), and
needs no ruling, because `setsrc` already moves a pointer without starting a
piece. A state migration (§6) reads the piece's stored data, following links
that can suspend on an unresolved one; runs the pattern's code, so the piece
must be started; writes arbitrary data cells under a conflict surface that
includes every cell a person might be editing; is not reversible; and, for a
piece nobody demanded, needs a ruling. The two differ by one to three orders of
magnitude per piece, and in kind. The one cost a pointer write carries that is
easy to miss is fan-out: each commit invalidates the watches of every connected
session on that piece, which is why, when many pointers move at once, they move
in few commits rather than many.

**The eager sweep is an option.** Moving every follower's pointer when the space
activates, in batched transactions carrying the invariant-4 guards per row, is
possible, and buys three things: a demanded piece under server execution starts
without waiting a cycle for its follow; the revision log across the space is
consistent at one moment; and the compile is shared by construction rather than
by cache. It costs O(followers) metadata writes per affected space, plus the
fan-out. None of the three is needed for a release to be correct, the host-level
compile cache (Stage 2) shares the compile without touching any piece, and a
scan (§5) reads storage without the pointer moved. So the sweep is an operator's
or a deployment's choice, taken under a budget, and never a step a release
depends on. Adoption is recorded when the piece next runs; the revision log says
what the piece ran, which is what a record of adoption means once following is
the only way a pointer moves.

For Topics — thousands of pieces in one space — the release reaches the board on
the next open and each topic on its next start, with one compile. For a user
with a hundred thousand pieces across tens of spaces, it is tens of O(1) checks
and no writes until something is used.

**A piece can only follow what it follows.** None of this reaches a piece
without an origin, and Topics' pieces have none: `setsrc` and `retarget` both
detach. The mechanism they would follow exists and reaches their source — the
patterns route serves all of `patterns/` — so the question Stage 1 settles is
not which origin but whether the owner trusts the gate: a `system:` candidate is
adopted as it stands because Tier 1 and Tier 2 gated the release, and Topics'
updates have needed what that rule skips — a migration, a compatibility matrix,
a rehearsal. §3 through §6 are what make unconditional adoption of a Topics
release safe: a declared migrate step, fixtures per shape, and a classification
that refuses a change the lazy path cannot carry. Until a piece follows an
origin, the bulk retarget is the only thing that moves it, and the eight-step
procedure is what moving it costs.

### 2. A same-contract adoption is a pointer move

The follow transition restages the piece's stored argument against the
candidate's schema. When the candidate's argument and result contracts hash
equal to the ones the piece is on, that restaging does nothing and is skipped:
the transition is the pointer write and the revision append, with the retained
closure a content-addressed link. Tier 1 computes exactly this comparison in CI;
the same comparison runs at adoption time.

This is the fast path for most releases. It is what makes the per-piece write a
start makes a metadata write rather than a schema walk, and it is what the
optional eager sweep in §1 would batch.

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

Today the schema-expressible class is defaults alone. A read-time alias — read
`title`, and where it is absent read `name` — is a runtime addition that moves
every rename from the second class to the first, and is staged below.

### 4. Two stored shapes are the normal state

Stored data in an older shape beside data in the current one is not a transient
to be hurried through; it is how a corpus with dormant members looks at every
moment. It is safe under four rules, each of which has a test.

1. **A document says which shape it is in; nothing sniffs.** The
   content-addressed `schema` stamp a result document carries is the shape
   marker, and a pattern-level migration records the identifier of its last
   completed step. "If `title` exists it is the new shape" works once and is
   ambiguous by the third change. A reader applies the chain of
   reinterpretations from the recorded shape to the current one, each step
   covered by a Tier 2 fixture of the shape before it.
2. **A reinterpretation is a pure, total, deterministic function of the stored
   document.** Class 3 of the table above is excluded by construction.
3. **The stored shape is part of the contract.** State in this system is
   observable: any principal the space's ACL admits can link to a stored cell,
   query it, or mount it, so "storage is private" is not available. What is
   available is the discipline already applied to arguments — the stored shape
   evolves only under Tier 1 (append-only, every historical shape still
   readable) and only by the classes in the table. Foreign readers read a
   piece's results where they can, because a result is computed from either
   shape by current code; where they read a stored cell, the reinterpretation
   must be schema-expressible or shipped with the pattern for the reader to
   import. Storage-level tools — `cf` reads, FUSE, `cf inspect` — read the
   stored shape and should: they are inspecting storage, and the stamp tells
   them what they are looking at.
4. **A write transitions the whole document, atomically.** The hazard is a
   document half in each shape: a current-code handler writes one field into an
   old-shape document and leaves "old shape with one new field". The first write
   to an old-shape document rewrites it to the current shape in the same
   transaction, under the hash precondition `repair` uses so a concurrent edit
   is not clobbered. Where the document is a collection, this fights concurrent
   mergeable appends
   ([migrating-collection-writes.md](../features/migrating-collection-writes.md)),
   so a collection migrates per element where its shape allows. A foreign writer
   that knows nothing of shapes — another piece, a client under its own view —
   is what rule 1's marker plus "exactly one shape per document" lets the owning
   pattern detect and refuse or repair.

What this buys: convergence driven by use. A touched piece migrates; a cold one
never pays; the read-time cost lands only on old-shape documents that are
actually read, and on the hot ones only until their first write. Rollback stays
cheap for untouched pieces, because nothing was rewritten; touched pieces are
forward-only unless a downcaster ships too, which is the argument for holding a
risky migrate step one release behind its reinterpretation. And the sweep that
retires a reinterpretation becomes hygiene run when the form distribution says
it is worth it, not a prerequisite for shipping.

What it costs: a reinterpretation lives as long as any reader might see its
shape — with dormant spaces, indefinitely, unless a sweep retires it. Budget for
a growing chain, or for occasional per-space compaction. A read-time
reinterpretation is a reactive computation on every old-shape read: trivial for
a field rename, not trivial for a large collection reshape on a hot path, which
is the case where a one-time write is wanted.

### 5. Observation is a touch; a scan is not

Two kinds of read, and the machinery must keep them apart.

- **Demand.** A reader wants the piece live — its computations run, its events
  served. Under server execution this starts the piece, which follows its
  origin, which runs the migrate step. One piece, one transaction, triggered by
  someone using it. Readers are reactive, so an observer sees the old shape for
  one update and then converges — a window reactive readers already handle. "Two
  shapes across the corpus" becomes "two shapes among pieces nobody has observed
  since the release", which is a set nobody is looking at.
- **Scan.** A reader wants the stored documents: a query, an index backfill, a
  survey, a search. A scan reads storage through a schema and **never starts a
  piece** — no follow, no migrate step, no revision, no per-piece transaction.
  For the schema-expressible class the runtime reinterprets on read. For the
  pure-function class the pattern ships the function and the scanning reader
  imports it and applies it in memory to each document; the stored document
  stays as it was. For the third class there is nothing to read until the write
  path has run, which is a cost of the change, not of the model.

The same separation applies to derived fields. An index over a per-piece
_output_ — a search text, an embedding — runs the piece to read the output,
which is demand. The pattern ships the derivation as a pure function and the
indexer computes it from stored data. No piece runs.

And no piggybacking: "we are reading every document anyway, write the new shape
while we are there" turns the affordable sweep back into the one this plan rules
out and couples an index rollout to a destructive migration. Migration stays
touch-driven; indexing stays read-only; the two converge independently.

The index itself follows the space-level pattern: a per-space record of the
definition it was last built against, an O(1) skip when it matches, one backfill
scan per space per definition change, run on activation, and reactive
maintenance from writes thereafter. A dormant space is never indexed because
nobody searches it.

### 6. The write path, when it is needed

For the pure-function class the migrate step is the generalization of Topics'
`upgradeTopicState`: run by the lift when the piece runs, and by every durable
verb before its first write; each step reads everything it needs before its
first write, returns completion only after its writes, tolerates an
already-migrated target, reads no clock, and states which mutations remain valid
while it is incomplete. Here the runtime supplies the runner and the place in
the follow transition, so a pattern declares its steps and nothing else. The
step runs under the writer delegation a `system:`-origin successor already
carries — the successor may write what the predecessor's handlers protected
(invariant 7, SC-22) — which is why it is the pattern's own code rather than an
operator's fixer with space-wide write authority.

For the third class, and for retiring a reinterpretation, the write path is a
**per-space background sweep**: rate-limited, resumable, with the plan-row
guards bulk operations already carry, performed by the pattern's migrate step
over the space's pieces when the space is active. Millions of users become
millions of small independent jobs, each triggered by activity, each skipped
when current, and none on the critical path of opening the space, because the
reinterpretation keeps readers correct while the sweep runs behind them. This is
what makes O(pieces) writes tractable: not avoiding them, but never doing them
globally or synchronously.

The composition across releases is the standard online schema migration. Release
N ships the reinterpretation and the migrate step together; touch and the
background sweep converge the data; release N+k drops the reinterpretation once
the surveyed form distribution says the remaining old-shape spaces are ones the
owner is content to leave — or never, since a space that never wakes never needs
reading. The `repair` bulk operation stays what it is: the operator's tool for
one-off damage.

### 7. The rollout window

The one measured failure on this path is two running versions writing the same
space. Server-side, following before the first start of a piece in a tenure, and
a deployment restarting the process so a release's tenures begin after it, mean
no old server code runs after the release. A client running the piece itself is
the gap: a tab that has not reloaded keeps its old code until the next open, and
it writes. Topics' procedure — retire legacy writers before applying the update
— is the mitigation available today, and
[the remote-echo breaker](scheduler-remote-echo-breaker.md) bounds the storm
when it is not followed. A migrate step that rewrites whole documents widens the
window's blast radius, which is a further reason to hold it one release behind
its reinterpretation on anything with many concurrent writers.

### 8. Origins are the upgrade path for every provider

Following an origin is how a piece receives a release, and nothing in §1 through
§7 depends on who published the release. What depends on the publisher is the
adoption rule, and the lifecycle already states it as a trust question: a
candidate from an origin whose releases this deployment gates is adopted as it
stands; a candidate from any other origin has to prove itself (invariant 7).
This plan keeps that line and names the tiers on each side of it, so that
`system:` is the tier the deployment vouches for rather than a mechanism of its
own.

| Origin            | Who gated the release     | What adoption does unattended                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system:` ref     | this deployment's CI      | adopts the candidate as it stands, with the writer delegation of invariant 7                                                                                                                                                                                                                                                               |
| Fabric origin     | nobody the runtime trusts | adopts a candidate the runtime itself proves an acceptable replacement for what the piece runs — the Tier 1 relation, applied by the adopting runtime to the candidate's contract over the piece's own recorded contract — and only within the first class of §3; anything else is offered to the owner, which the piece menu already does |
| Pinned fabric URL | —                         | never reports an update (invariant 14)                                                                                                                                                                                                                                                                                                     |

The second row is the acceptable-replacement relation invariant 7 asks for and
the lifecycle lists as required, and it is what opens the mechanism to a
provider the deployment does not vouch for. Its trust anchor is on the adopting
side: the proof runs over the piece's _own_ recorded contract, which the
provider does not control, so nothing the provider publishes about its history
is consulted or needed. What the proof establishes is bounded, and the bound is
stated rather than papered over: Tier 1 is a statement about contracts, and only
Tier 2 — a fixture of real data — speaks to stored state. So an unattended
adoption from a fabric origin carries only a change the schema itself
reinterprets (§3's first class), which is the class whose safety the contract
relation does prove. A pure-function migrate step (§6) from such an origin runs
only with the owner's consent, for a reason that is CFC's before it is trust's:
an unattended update from an origin the deployment does not gate carries no
writer delegation (invariant 7), so the successor cannot write what the
predecessor's handlers protected until the owner's acceptance confers it. A
candidate in the third class is refused from every origin but the first, and
from the first unless the release names its sweep.

A provider with many pieces in other people's spaces therefore ships
same-contract and schema-expressible releases with no one in the loop, and a
data migration as an offer each owner accepts once — which is a better position
than this repository's own patterns are in today.

What the tiers do not change: an origin becomes active only by the owner's
explicit consent (invariant 10); a piece can detach, revert, or repoint at any
time; a content-addressed or pinned fabric URL never reports an update
(invariant 14); and source that moves between spaces is an information flow CFC
checks before anything is copied (invariant 13). What they wait on is the
fabric-origin work the lifecycle already lists, staged below.

## Strategy by scale

The first two rows are today's deployment. The rest is the same mechanism with
nothing added; the table is here to show that, not to schedule for it.

| Situation                                                   | What runs                                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| One piece, one developer                                    | `setsrc`, detach, repoint, revert — as today                                                                                                  |
| Thousands of pieces in one space (Topics)                   | Pieces on an origin they follow; each adopts on its next start with one compile per space (§1), pointer-move fast path (§2)                   |
| Millions of users × 10^4–10^5 pieces, same-contract release | Publish once at the toolshed; each space adopts on activation with an O(1) skip; nothing per piece until it is opened                         |
| Same, with a stored-shape change                            | Classify (§3); reinterpret on read and migrate on touch (§4, §6); per-space background sweep for the third class and for retirement           |
| A feature needing every piece's state (search)              | A per-space backfill scan with the reinterpretation or derivation in the reader (§5); O(pieces) reads once per index definition, never writes |

## What this plan does not change

- Per-piece pinning, detach, revert, repoint, and the append-only revision log
  stay as the lifecycle specifies them. The space record caches what an origin
  resolved to and its compile; it is not an authority over any piece's pointer,
  and every start still compares its own.
- Nothing runs for, and nothing is written to, a piece nobody starts. The moment
  a piece's pointer moves is the moment the lifecycle already moves it.
- No sweep, global or per space, synchronous or otherwise, is a step of any
  release. The eager pointer sweep in §1 and the migration sweep in §6 are
  options taken under a budget.
- Static `cf:` imports keep their snapshot semantics (invariant 8).

## Formats without version numbers

[DEVELOPMENT.md](../development/DEVELOPMENT.md#general-principles) asks that a
format be built so a reader handles older and newer writers alike, rather than
marking each change with a version. This plan's markers are identities, not
counters: the per-space record names the identity an origin last resolved to; a
document's shape marker is the content-addressed schema that wrote it, which the
runtime already stamps; a pattern's migration progress names the identifier of
the last completed step, which is what Topics' ordered identifier list already
encodes behind its integer. The reader-handles-every- writer half of the
principle is exactly rule 4's reinterpretation chain.

## What needs a ruling

1. **May a space-level sweep run pattern code for a piece nobody demanded?**
   Moving a pointer does not start a piece: `setsrc` moves it in a setup
   transaction, and the swap is the server's reaction when the piece is next
   demanded
   ([serving-loop.md §3e](../specs/server-side-execution/serving-loop.md)). So
   §1's optional pointer sweep and §2's fast path sit inside the
   no-piece-start-policy ruling. A migrate step is pattern code, and running it
   for an undemanded piece is a start. §6's background sweep therefore needs the
   same kind of ruling
   [scheduled work in the server](scheduled-work-in-the-server.md) waits on — a
   second issuer of demand where the specification pins the count at one — or it
   stays touch-driven only, which is still correct, only slower to converge. The
   plan is written so that everything but the migration sweep works without this
   ruling.
2. **Does a cross-piece read of a stored cell on a client runtime start the
   owning piece?** Reading a result demands the computation, so the owning
   pattern runs and follows. Reading a stored writable cell of a dormant piece
   returns bytes, and on the serving runtime the demand starts the piece either
   way. On a client that runs pieces itself, if the target does not start, that
   is the one real leak of an old shape past §4 rule 3, and the fix is either
   confining stored cells foreign pieces link to to the schema-expressible
   class, or giving the client the same demand-starts rule.
3. **Where the shape marker lives for a pattern's internal state.** The `schema`
   stamp marks a result document; Topics marks its internal state with
   `topicStateVersion`. The general runner needs one answer for internal
   documents, and the identifier-of-last-step form above is the proposal.
4. **CFC for the migrate step.** The step writes under SC-22 delegation. Whether
   a field the step _adds_ binds to the piece's recorded creator, as the plan
   above proposes for update-added fields, or to no one, follows that plan's
   ruling.
5. **Is the release gate the gate for Topics?** An owner's decision rather than
   a specification ruling. Putting Topics' pieces on a `system:` origin means a
   merged release is adopted as it stands, with Tier 1, Tier 2, and the
   classification test of Stage 3 as the only things between a change and every
   deployed topic. Today an operator stands there too. The decision is whether
   the gates, once Stage 3 is built, are enough on their own — and if not, which
   finding should keep a release from being served rather than keep an operator
   in the loop.

## Stages

Each stage lands on its own and leaves the system better than it found it. One
dependency runs forward: Stage 1 puts Topics on an origin under an interim rule
that Stage 3 lifts, so the operator leaves the loop for a contract-moving
release only once the classification test exists.

### Stage 0 — Measure

- [ ] Cost of one follow transition by phase (compile or cache hit, verify,
      restage, revision append, commit) on a `system:` piece in a populated
      space, with the perf-investigation recipe.
- [ ] Distribution of pieces per space and spaces per principal in the Estuary
      deployment, and the share of pieces following a `system:` origin.
- [ ] How many of the last twenty system-pattern releases changed a contract
      hash at all, and how many changed a stored shape. This is the evidence for
      §2 and §3 and decides how much of the rest is worth building first.

Success: the numbers are in a history document and the stage order below is
confirmed or reordered by them.

### Stage 1 — Topics follows an origin; the space is checked once

- [ ] The interim adoption rule: a `system:` follow for a piece whose pattern
      declares no migration steps (Stage 3) adopts a candidate only when its
      contract hashes equal the piece's, and otherwise records a refusal and
      offers the candidate to the owner — the path a non-gated origin takes
      today. Topics' own `upgradeTopicState` keeps carrying its stored-shape
      changes meanwhile, as it does now. Stage 3 replaces this rule with the
      classification test.
- [ ] Put the deployed board and topics on a `system:` ref to Topics' source
      under the patterns route, once, with `cf piece follow`, rehearsed on a
      clone per
      [space-clone-rehearsal.md](../development/space-clone-rehearsal.md). The
      route serves that source today, and a board that follows makes topics that
      follow. This is the last operator retarget of those pieces.
- [ ] A per-space record of the identity each followed origin last resolved to,
      holding its compiled candidate, written by the reconciler when it asks the
      origin on tenure activation or a client's open of the space. A piece's
      start compares its own pointer to the record and runs its follow only when
      they differ; the record replaces the per-start resolution and compile, not
      the compare.
- [ ] An index of pieces by origin within a space, for the survey in Stage 6 and
      the optional sweep, so neither walks the registry.
- [ ] Decision 5, taken when Stage 3 lands: the owner accepts the release gate
      and the classification test as the gate for Topics, or names the finding
      that should stop a release from being served. Until then the interim rule
      holds, and a contract-moving Topics release is an offer the operator
      accepts, not a procedure the operator runs.

Success: a same-contract Topics release reaches the board on its next open and
each topic on its next start, with no operator step after the merge; a
contract-moving release is an offer, not an eight-step procedure; a space whose
record matches resolves and compiles nothing, and no piece in it is written
until it starts.

### Stage 2 — Same contract, pointer move

- [ ] The follow transition compares the candidate's contract hashes with the
      piece's and skips the argument restage when they match, with a test that a
      same-contract adoption writes nothing but the pointer and the revision.
- [ ] A host-level compiled-module cache keyed by executable identity, so the
      compile is a cache hit across spaces for the same identity.

Success: a same-contract release's per-piece cost is the pointer write and the
revision append.

### Stage 3 — Migrate on touch, generalized

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

Success: a pattern with a declared step migrates on open, on first write, and on
demand under server execution, with no code of its own beyond the steps.

### Stage 4 — Scans do not demand

- [ ] A scan API that reads a space's documents through a schema, applying
      schema-expressible reinterpretation, and provably starts no piece — a test
      that a scan over a space of followers of a moved origin leaves every
      pointer and revision log unchanged.
- [ ] An index definition names the pattern-shipped pure function it applies to
      each document — a reinterpretation, a derivation, or both — and a
      per-space record of the definition it was last built against.
- [ ] Backfill on activation when the record does not match, resumable, followed
      by reactive maintenance from writes.

Success: building a search index over a space of old-shape pieces writes nothing
to any piece and the index is correct for both shapes.

### Stage 5 — Widen the schema-expressible class

- [ ] A read-time alias in the schema vocabulary: a property read falls back to
      a named former property when absent, so a rename needs no step.
- [ ] Tier 1 recognizes the alias as compatible with the baseline that has the
      former name.

Success: a field rename ships as a schema change with no migrate step and no
reader change.

### Stage 6 — Retirement

- [ ] A survey of shape distribution per space (`cf` read-only, from the
      markers), feeding the decision to drop a reinterpretation.
- [ ] The optional eager pointer sweep (§1): a per-space, budgeted move of every
      follower's pointer in batched transactions carrying the invariant-4 guards
      per row, for a deployment that wants the revision log consistent at one
      moment or first starts without a deferred follow.
- [ ] The per-space background migration sweep, if ruled in (question 1),
      rate-limited and resumable, running the migrate step over a space's
      remaining old-shape pieces while the space is active.

Success: a reinterpretation can be retired on evidence, and neither sweep ever
blocks a space's open or is a step a release depends on.

### Stage 7 — Origins for every provider

The fabric-origin work the lifecycle lists, in the order a provider needs it.

- [ ] Creation from a fabric URL: `cf piece new` and the piece menu accept a
      `cf:` URL to a published pattern, and the piece records it as its origin
      with a create revision.
- [ ] The acceptable-replacement relation: the adopting runtime proves a
      candidate's contract applies over the piece's own recorded contract — the
      Tier 1 relation, run at adoption — and adopts unattended only a candidate
      that passes and whose change is schema-expressible; anything else is
      offered to the owner. The second row of §8's table.
- [ ] The live subscription to a mutable entity's revision head while a
      following piece runs, through the same guarded transition.
- [ ] Cross-space source replication under CFC policy, failing closed before
      copying.
- [ ] The migrate step (Stage 3) from a fabric origin runs only after the
      owner's acceptance, which is what confers the writer delegation an
      unattended non-gated update does not carry (invariant 7).

Success: a provider with no access to this deployment publishes a pattern in a
space, pieces in other spaces follow it by the owner's consent, a same-contract
or schema-expressible release reaches them on their next start with no one in
the loop, and a data migration reaches them as an offer each owner accepts once.

## Relationship to other documents

- [piece-source-lifecycle.md](../specs/piece-source-lifecycle.md) is the design
  of record for what a piece records and how following works; this plan changes
  nothing it specifies and adds the space-level record beside it. Stage 7 is its
  "Work required" for fabric origins, ordered for a provider.
- [pattern-updates.md](../specs/pattern-imports/pattern-updates.md) is the
  design of record for the `system:` origin, and the
  [archived implementation plan](../history/specs/pattern-imports/system-pattern-updates-implementation-plan.md)
  records how the mechanism Stage 1 puts Topics on was built.
- [piece-bulk-operations.md](../features/piece-bulk-operations.md) and
  [its plan](piece-bulk-operations.md) stay the operator's tool; the optional
  sweeps in §1 and §6 reuse their plan-row guards, and Stage 1's repoint is the
  last retarget Topics' pieces take.
- [verb-evolution.md](verb-evolution.md) names the problem and the four
  mechanisms; this plan is mechanisms 3 and 4.
- [topics-computation-cost.md](topics-computation-cost.md) and
  [`patterns/apps/topics/state-upgrades.md`](../../patterns/apps/topics/state-upgrades.md)
  are the first customer and the mechanism Stage 3 generalizes.
- [scheduled-work-in-the-server.md](scheduled-work-in-the-server.md) waits on
  the same demand ruling as Stage 6.
- [piece-creator-owns-update-added-fields.md](piece-creator-owns-update-added-fields.md)
  decides who owns what a migrate step adds.
