# Pre-syncing from node plans

A piece's runs read through the schemas the transformer narrowed to what each
lift and handler body touches. The pre-sync that pulls documents before those
runs follows wider schemas, walks the pattern graph a second time with code of
its own, and then holds every first run on a space-wide timer rather than on
the loads it asked for. This plan makes one derivation per node serve both
instantiation and the pre-sync, on resumes and fresh starts alike, and gates
each node's first run on the loads that derivation named.

The audit this plan follows from is
[`../history/packages/runner/presync-audit-2026-09-09.md`](../history/packages/runner/presync-audit-2026-09-09.md).
Its findings are summarized below where the plan acts on them; the audit holds
the evidence.

## Vocabulary

A **node** is one entry of a pattern's graph: a JavaScript node (a lift or a
handler), a raw node (a builtin such as `map` or `fetchJson`), a passthrough
node, or a pattern node (a nested pattern instance). Each node has **input
bindings** and **output bindings**: aliases into the piece's argument
document, its result document, and its derived internal cells.

A node's **module schema** is what the node reads its inputs under at run
time. For a lift or handler it is the argument schema the transformer
narrowed to the body's reads and injected into the module. For a raw node it
is the builtin's registered input schema. For a pattern node it is the child
pattern's argument schema.

A **node plan** is the derivation this plan introduces: from a node, an
argument link, a result cell, and the pattern, the bound inputs as an
immutable cell, the module schema those inputs are read under, the bound
outputs, the resolved write targets, and, for a pattern node, the child
result cell under the child's result schema.

To **name** a document is to sync it directly, so that the replica holds it
before anything reads it. Since #7193 the store delivers a document's
`pattern`, `argument`, `result`, and `internal` metadata as data on the
document and follows none of those links, so a document a run reads is local
only if something named it or a selector reached it.

## Where the runner stands

Five places bind a node's inputs and outputs to documents. `#bindNodeIO`
serves JavaScript nodes, `#buildRawNodeInputs` serves raw nodes and was
already factored out so the resume pre-sync could derive a list
coordinator's inputs without instantiating it, the passthrough node and the
pattern node each bind inline, and the resume pre-sync's node walk binds
every node once more with a copy of the same calls. The walk syncs each
write-redirect link under the link's own schema, which is a slice of the
pattern's authored argument schema, and pushes the argument document as a
link-target root under the whole authored schema. Neither is the module
schema, so the pre-sync pulls what the authored type reaches rather than what
the bodies read.

A fresh start gets less. `runSynced` walks the caller's argument raw and skips
the node walk, because the `argument` meta link it keys on does not exist
until setup writes it. `run()` pre-syncs nothing for a fresh piece.

Pattern nodes get their child's derived internal cells named through the
owned-cell walk and nothing else: the child result document is never named,
the child's nodes are never walked, and the child's inputs are bound under the
child's whole authored argument schema.

Every action resumed from storage then holds its first run until the space's
`synced()` resolves or two seconds pass. The constant's own comment records
that this is an anti-churn optimization rather than a gate: a run whose input
had not landed reads absent, computes a different value, writes it, and
conflicts when the durable value arrives. The precise wait exists for events
only: an event parks on the specific in-flight loads its closure reads, and
since #7189 a client dispatch whose argument read cold re-runs parked on the
loads its own reads registered. Computations have no such park.

## Design

### One plan per node

`#nodePlan(tx, node, resultCell, pattern, moduleRefName?, argumentLink?)`
returns:

- `inputsCell`, the immutable cell built from the bound input bindings, which
  the node reads its argument from;
- `module`, whose argument schema is the read schema the pre-sync syncs
  `inputsCell` under for a JavaScript node, with a handler's `$event` slot
  excluded (`schemaWithoutEventSlot`), and for a raw node, where it is the
  builtin's; a passthrough node's `inputsCell` is synced schema-less, since
  its run copies the inputs whole, and a pattern node's is not synced at all,
  since the child's own plans read it;
- `outputs`, the bound output bindings, and `writes`, their write-redirect
  links, each carrying the output binding's schema;
- for a pattern node, `childResultCell` under the child's result schema and
  the bound child pattern, derived as `#instantiatePatternNode` derives them.

Instantiation consumes the plan: `#bindNodeIO`, `#buildRawNodeInputs`, the
passthrough node, and `#instantiatePatternNode` each take their bound values
from it instead of binding on their own. The pre-sync consumes the same plan.
Whatever a node reads at run time, it reads through `inputsCell` under
`readSchema`, so a pre-sync that walks exactly that pair pulls exactly the
run's read set and nothing the authored schema reaches beyond it.

### The pre-sync syncs each plan under its schema

Each node's pre-sync is a sync of `inputsCell` under its read schema, plus
its write targets under their output schemas and, for a handler, every hop
of the stream document its `$event` slot names. The inputs cell is a
data-URI document, and syncing one under a schema runs
the storage manager's `#collectLinkedCellSyncs`, which hands the server a
selector for each binding link under the sub-schema the link's place
selects. From there the server's query walk follows links the way a read
does, through `combineSchemaForLink`, as deep as the declaration goes,
tracking absent targets so they arrive when written. That is the read's own
rule applied by the read's own traverser, so nothing the runner walks by
hand can be more faithful to it.

This retires the runner's link walks: `#syncArgumentLinkTargets` with its hop
budget, wave loop, dedupe sets, opaque stop, and undeclared fallback;
`syncAllMentionedCells`; and the schema-less use of the same walk on the
pattern-update path, which `syncStoredPieceCells` covers once it runs the
plan syncs. `LINK_HOPS`, `ArgumentLinkRoot`, `narrowChildSchema`, and
`isReferenceOnlySchema` go with them. One walk stays, one hop wide: the
stored argument's direct link targets and the result document owning each
are named root-only (`#syncStoredArgumentLinkTargets`), because setup's
supplied-link proof reads them and that read is no node's. It runs last in
the pre-sync, after every plan sync and coordinator sync has been issued, so
a document a plan reads is asked for under that plan's schema before the
root-only naming asks for it. Among plans the requests go out together, in
pattern order, and no order among them is claimed; what the ordering
guarantees is only that the root-only naming never precedes a reader's own
request. On the setup path over a stored piece, the argument guard's
root-only naming precedes the plan syncs, because the guard's snapshot must
be taken before the family loads. The reference
graphs that motivated the
hop budget are declared `unknown` at their edges, where the traverser answers
presence and stops, so no depth constant stands in for that.

The server walk crosses `asCell` positions as it crosses any other: the
query traversal runs with `traverseCells` on, and only an `opaque` cell stops
it, so a handle's document is delivered with the rest. `presyncInputs`
therefore collapses to the same call over the inputs with the event folded
in; its handle collection goes.

Cross-space targets past the first hop are the one thing the server walk
cannot deliver, since its query is per space. A read that dead-ends on a link
into another space kicks a load there (`ensureLinkedDocLoaded`), and that
load is the subscription: the storage manager opens the space and tracks the
load. The pre-sync uses exactly that: after a wave's plan syncs land, it
reads each plan's inputs under its read schema through a read transaction,
awaits the loads pending after those reads by document (`loadsSettled` over
`pendingLoadAddresses`), and reads again until a round leaves no load
pending that an earlier round did not await (`#syncCrossSpaceReads`). The
read's own traversal decides what is missing, so no second walk exists. The
pass awaits loads, never the storage manager's settled pool: on a client that
pool holds the runtime's other work, and a resume that waited for it would
wait behind sinks and coordinators that never go quiet. Awaiting each
document once is also what ends the pass for a link whose target never
arrives or whose space denies the read, since every read kicks such a load
again. The pass is
owed rather than optional: a space the transaction only read enters no
commit's basis, so a cold cross-space read costs no conflict, but an action
that destructures the cold value throws instead of re-running, and the home
profile flow reads profile documents in their own spaces that way.

One correction on the way: `#collectLinkedCellSyncs` syncs a first-hop link
under `link.schema ?? schema`, the link's declared schema before the
reader's. The read follows reader precedence, so the sync has to combine the
two the way `combineSchemaForLink` does, or a binding link that carries the
authored slice pulls the authored slice.

Outputs are named under the output binding's schema for every node kind. For
a JavaScript or raw node that is the write target, a derived internal cell or
a result path, under the module's declared result schema. For a pattern node
it is the child result cell under the child's result schema, which the
pre-sync this plan replaced never named. A pattern node's inputs are not synced at the parent level:
the child's own nodes read through the child's argument document, and the
recursion below syncs them under their own module schemas.

The argument document itself stays named, schema-less, as #7193 made it:
setup reads it whole to write the caller's argument over the stored slots.
Naming a document schema-less pulls its bytes and follows nothing, so this
keeps the document local without widening what is pulled.

### Children are synced after they are local

A child's node plans need the child's `argument` meta link, which is data on
the child result document. The pre-sync therefore runs in two waves per
level: name every child result cell in the first, then plan and sync each
child's nodes in the second, recursing. Each level names its own argument
document and derived internal cells, as the top level does. List coordinators
keep `#syncResumeListChildren`, whose children are derived from the
coordinator plan rather than from a pattern node, and each child it names is
then synced the same way.

### A fresh start binds against a local stand-in

Binding needs an argument link, and a fresh piece has no argument document
until setup writes one. The pre-sync mints an immutable cell holding the
caller's argument and binds every node plan against its link. The plans then
sync as on a resume: `inputsCell` links into the stand-in, the stand-in holds
the caller's links, and the server walk crosses them under the module
schema. This gives `runSynced` the same per-node pre-sync a resume gets,
with no separate mechanism and no derived read surface over the argument. A
plain `run()` is synchronous and pre-syncs nothing. The audit's
recommendation to derive such a surface is superseded by this.

### Each first run waits on what its plan named

The pre-sync returns, per node, the promise of the loads its plan named. On
resume `#startCore` hands each node its promise, and the scheduler holds that
action's initial run until it settles, in place of the space-wide timed hold.
A load that fails settles the promise too, so the hold never waits on
something that will not arrive and needs no timeout. Sub-pieces get the same
treatment from their own level of the walk; a map's element runs get theirs
from the list-children pass. Map's own resume guards, the journaled probe
reads that defer a reconcile while its container or list is still streaming,
stay: they are re-triggered by arrival, not by time.

With the loads named exactly and the run held on exactly those loads, a
resumed lift over unchanged inputs recomputes the value the store holds and
the diff elides the write. That is the no-op the resume path is meant to
produce, and it no longer depends on a two-second race.

### The named-family gate asks the plans

`#familyAbsent` and `#swapReadsAbsent` decide whether a run or a swap over a
stored piece must name its family first. They probe presence with a raw
four-hop scan of the argument under a 256-probe budget. With plans available
the question has an exact answer: whether each node's selector is already
covered, which the storage manager's sync-request index knows without a round
trip. The gate keeps its structure and its hold, and asks that instead of
scanning.

## Stages

Each stage lands on its own and leaves the tree green. The order is the
dependency order; stages 2 and 3 can proceed in parallel once stage 1 has
landed.

### Stage 0. Prerequisite

- [x] #7193 landed (`3cdf2ab489`): the store delivers metadata as data and
      follows only `cfc`. Its runner changes (naming the argument document
      in the node walk, `syncStoredPieceCells`, the `#familyAbsent` and
      `#swapReadsAbsent` gates) are what stages 2 and 5 build on.

### Stage 1. One plan per node

- [x] Add `#nodePlan` and route `#bindNodeIO`, `#buildRawNodeInputs`, the
      passthrough node, and `#instantiatePatternNode` through it
      (`0d4a8717e0`). The pattern node's binder, `#bindPatternNode`, holds
      both binds and is what the owned-cell walk derives a child's result
      cell from, so the walk now also takes the branch where the outputs
      already name the child's result cell.
- [x] `presyncInputs` builds the same inputs document the plan does, with
      the event in its slot, and syncs it under the module schema (stage 2).
- [x] Test: `node-plan.test.ts` pins one plan per node kind and that the
      pattern node's plan derives the result cell its instantiation
      registered. The full runner suite was the regression net: 1404 files
      green.

Exit: no binding call outside `#nodePlan` except `sendValueToBinding`, which
writes rather than plans.

### Stage 2. The resume pre-sync syncs the plans

- [x] Fix `#collectLinkedCellSyncs` to combine the reader's sub-schema with
      the link's the way `combineSchemaForLink` does (`2d6a434cfd`, red
      first in `data-uri-sync.test.ts`).
- [x] Replace the node walk in `#syncCellsForRunningPatternInner` with one
      `sync()` per node plan under its read schema (`#cellsNodePlanReads`),
      and `presyncInputs` with the same call over the inputs and the event.
      A served event's identity now travels through the data-URI sync, so
      the storage manager names the actor's instances there as it does for
      a stored document.
- [x] Name each plan's outputs under the output binding's schema, the child
      result cell included. Until stage 3 recurses into children, a pattern
      node's inputs are also synced under the child's authored argument
      schema, so a child's reads through the parent's argument stay warm
      in the meantime.
- [x] Delete `#syncArgumentLinkTargets`, `LINK_HOPS`, `ArgumentLinkRoot`,
      `narrowChildSchema`, `isReferenceOnlySchema`, and the whole-argument
      root, and `sync-argument-link-targets.test.ts` with them. The
      argument document is named root-only: the `argument` meta link
      carries the pattern's authored schema, so a cell built from the link
      as it stands pulls everything the authored type reaches.
      `syncStoredSetupArgument` keeps its root-only argument sync and drops
      its raw scan. `syncAllMentionedCells` stays until stage 3's stand-in
      replaces it, since it is what a fresh `runSynced` has.
- [x] Test, red first: a pattern whose authored argument type declares a link
      no lift body reads stays cold after the resume, and the first runs
      commit without conflict (`resume-node-plan-presync.test.ts`).
- [x] Test: a lift body that reads through three stored documents finds the
      third local. This one was green before the change too: the input
      link's direct sync already handed the server the declared chain, and
      only the client-side walk was capped.
- [x] Test: the `defaultProfile` shape, a container in the piece's space
      linking to a document in another space, is named by the cross-space
      pass before the first run (stage 3's cross-space case).
- [x] Test: a handler whose argument holds a cell handle finds the handle's
      document local at dispatch without the handle collection
      (`resume-node-plan-presync.test.ts`).
- [x] Two serving-loop races the leaner pre-sync exposed, fixed on the way
      (`executor-space-server.test.ts`'s argument-doc demand case went from
      one failure in four to none in twenty). A demand naming an argument or
      derived document resolves to its owning piece root before the piece
      starts (`ensurePieceRunningVerdict`'s `onOwningRoot`), since the start
      releases the actions' first runs. And the arrival re-arm now re-arms a
      node that ran with no demander reachable, the wave-level fallback:
      such a node has no fan-out record and no known scope, so its next run
      is the probe for the arriving principal. Both are pinned in
      `ensure-piece-running.test.ts` and `executor-run-supply.test.ts`.
- [ ] Measure on the topics board and the default app: `resumeCellSync`
      count and the link-target sync total from the runner timing stats,
      before and after, and the count of `piece-start-commit-recovering`
      warnings on a cold resume. `docs/development/debugging/profiling.md`
      names the rows.

Exit, not yet met: the runner holds no link walk of its own for pre-syncing
beyond the one-hop stored-argument naming, and the measurements are recorded
in the pull request.

### Stage 3. Children and fresh starts

- [x] Recurse into pattern nodes. The first wave names each child result
      cell; a third wave (`#syncResumeInstanceNodes`) plans and syncs the
      nodes of every nested instance whose argument link has become
      readable, round by round, naming each instance's argument document
      root-only as well. `#collectResumeOwnedCells` still derives the
      instances and their derived internal cells; `#syncResumeListChildren`
      returns the instances it names so a list child's nodes join the
      rounds. A pattern node's inputs are no longer synced under the child's
      authored argument schema.
- [x] Give `runSynced` the plan walk against an immutable stand-in for the
      caller's argument. A plain `run()` still reaches setup and start with
      no pre-sync of its own, which stays owed: the pre-sync is asynchronous
      and `run()` is not. The storage manager's data-URI
      walk crosses a link into a data-URI document locally, following a
      link it meets mid-path with the rest of the path appended, since the
      transformer captures paths (`def.next`), not only roots. A module's
      inputs are synced under its argument schema the same way;
      `syncAllMentionedCells` is gone.
- [x] `findAllWriteRedirectCells` probes a redirect chain against the
      replica as it stands, kicking no sync of its own. A read of the target
      under the binding link's schema pulled the whole authored slice, which
      is what pulled a child's unread `friend` even after the plan syncs
      stopped asking for it.
- [x] The stored argument's direct link targets, and the result document
      owning each, are named root-only last in the pre-sync
      (`#syncStoredArgumentLinkTargets`), for both a resume and a setup
      staged over a stored piece: setup's supplied-link proof reads a
      linked document's metadata and its owner's, and neither is a node
      read. `packages/cli`'s `piece-link-input-visibility` case over a
      legacy link on a fresh replica is the pin.
- [x] Test, red first: a child pattern whose authored argument type declares
      a link no child body reads leaves it cold; a grandchild reads through
      a link the level between holds as `unknown` and finds it local
      (`resume-node-plan-presync.test.ts`).
- [x] Test, red first: a body reading through a link into another space
      finds the far document local the moment the pre-sync step resolves;
      the flag-on home profile reload test was the field report.
- [x] Test, red first: a fresh `runSynced` finds what its lift reads two
      documents deep local the moment the pre-sync step resolves, observed
      through the dependency-syncer seam, and the lift runs once. Measured
      on the way: the fresh path already committed without conflict and
      landed the right value before this stage, so what the stand-in buys
      is naming before the run rather than after its first cold read.

Exit: a resume and a fresh start name the same set for the same pattern and
argument, the stand-in aside.

### Stage 4. First runs wait on named loads

- [ ] Have the pre-sync return per-node load promises and thread them through
      `#startCore` to the scheduler as the initial-run hold, for the top
      level, for sub-pieces from their own wave, and for list children from
      the list-children pass.
- [ ] Decide, from stage 2's `defaultProfile` measurement, whether a first
      run parks on the cross-space loads its own reads kicked, the way a
      dispatch does since #7189, or takes the one re-run.
- [ ] Retire `awaitSyncBeforeInitialRun`'s space-wide `synced()` wait and
      `INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS`. The option name can stay as the
      carrier of the per-node promise, or be renamed; the plan does not care
      which. `defersInitialRunUntilSynced` and map's `resumeBatchAwaitSync`
      keep their meaning as "this run is a resume".
- [ ] Test, red first: a resumed lift whose named load is deliberately
      delayed past two seconds does not run cold. Under the timed hold it
      runs and writes a conflicting value; under the load-gated hold it waits
      and its write is elided.
- [ ] Test: a named load that fails releases the hold rather than leaving the
      action parked.

Exit: no resumed action's first run is released by a timer.

### Stage 5. The gates ask the plans

- [ ] Replace the raw four-hop scan in `#familyAbsent` with a coverage
      check of each node plan's selector against the storage manager's
      sync-request index, and `#swapReadsAbsent` likewise. The probe budget
      goes with the scan.
- [ ] Test: the existing `piece-named-before-start.test.ts` cases pass
      unchanged, and a case where the raw scan over-held (a link in the
      argument no body reads) no longer holds.

Exit: `NAMING_PROBE_BUDGET` is either gone or justified by a measurement in
the pull request.

### Stage 6. Documents

- [ ] `docs/common/concepts/pattern.md` describes the resume pre-sync of
      `[UI]`; restate it in plan terms.
- [ ] `docs/development/debugging/profiling.md` names the `runner/start/*`
      timing rows; rename or add rows as the waves change.
- [ ] `docs/specs/server-side-execution/serving-loop.md` §3b says
      computations self-heal through the change channel and so need no
      pending-load park; stage 4 changes that for first runs on resume, and
      the section says so.
- [ ] Archive this plan to `docs/history/plans/` when stage 5 lands.

## What this plan does not do

- It does not add an argument pointer or an input hash to derived internal
  cells. The plan derives a node's read set from the graph, which is the
  information such a pointer would carry, without a new durable field. An
  input-hash memo that skips a lift body is a separate optimization for lifts
  whose bodies are expensive, and is not needed for the no-op this plan is
  after.
- It does not change what the store delivers. #7193 settles that: metadata
  is data, and the runner names what it reads.
- It does not remove the `FabricInstance` stops in the walks. They are
  recorded gaps with their own TODOs; the storage manager's data-URI walk
  inherits them.

## Risks

- **A plan that binds differently from instantiation.** Stage 1's equality
  test is the guard, and stage 1 lands before any pre-sync change so a
  binding regression shows up on its own.
- **A cold target the module schema does not declare.** A body that reads
  more than the transformer saw is a body the transformer should have
  reported (`validateShrinkCoverage`); a `true` schema is followed by the
  server as far as the links go. Stage 2's measurement watches the
  `piece-start-commit-recovering` count for a rise.
- **A selector the server walk cannot bound.** A `true` schema over a wide
  reference graph asks the server for the whole graph, where the old walk
  stopped at two hops. Such a schema is a body reading everything, and the
  graphs that used to trip this are declared `unknown` at their edges. The
  measurement above is where an unbounded pull would show.
- **A hold that never releases.** Stage 4's promise settles on failure as
  well as success, and the test for a failed load is what pins that.
- **Wider pull requests than the stages suggest.** `runner.ts` is where all
  of this lives, and the binding sites are scattered through it. Each stage
  is one pull request; a stage that grows past that splits by node kind.
