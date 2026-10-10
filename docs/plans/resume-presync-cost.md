# Cutting the resume pre-sync's cost

Opening a piece with nested instances — a chat room with twenty message rows,
a board with a hundred topics — spends most of its time in the pre-sync that
names what each node reads before the piece runs, and almost none of it in
the pattern's own code. Measured on a fabrichat room on Estuary, the pre-sync
was over half of 49 CPU seconds, the server under a tenth of that, and the
client starved its own socket for minutes at a time while it planned. The
record is
[`../history/development/performance/2026-10-fabrichat-room-load.md`](../history/development/performance/2026-10-fabrichat-room-load.md).

This plan removes the work that measurement showed to be repeated or
unnecessary, and keeps the pre-sync's guarantees: every document a first run
reads is local before it runs, across spaces, and a child's start names what
its parent's did not. It continues
[`presync-from-node-plans.md`](presync-from-node-plans.md), whose vocabulary
(node, node plan, name) it uses, and leaves that plan's owed stages where they
are.

## Where the cost comes from

Four things multiply, and each is a stage below.

**Every start plans its whole subtree.** `#collectResumeOwnedCells` recurses
every pattern node to the leaves, and `#syncResumeInstanceNodes` plans and
syncs every nested instance it found, level by level. That is right for the
root. But a mapped child reaches `runner.run()` on its own once its parent's
coordinator runs, and `#nameFamilyBeforeRun` plans the child's subtree again:
a node at depth _d_ is planned by every ancestor's start and then by its own.
On the wire, 31% of the roots one load asked for had been asked for earlier
in the same load.

**A plan's inputs cell inlines every schema.** `#bindNodeIO` hands the bound
inputs to `getImmutableCell()`, which rewrites each link's content-addressed
schema reference into its recomposed form before minting the `data:` id.
Recomposition builds a fresh object graph per call, so the interned-schema
cache never hits and every call deep-freezes and hashes the closure again.
The rewrite exists so that a `data:` document is self-contained, and nothing
needs that: a `data:` document never leaves the process, the process resolves
a reference through the same registry the rewrite reads, and a `data:` link
is flattened into its value before any write carries it
(`normalizeAndDiff`).

**The cross-space pass materializes to discover.** `#syncCrossSpaceReads`
does a full schema-validated `get()` of every plan's inputs, in every round,
to find a link into another space that the server's per-space walk could not
follow. Most plans hold no such link, and the ones that do are found by
walking links, not by building values.

**Planning never yields.** The planning loops run on one microtask chain.
`#syncFamilyCell` sends a watch frame as a side effect, so the loop keeps
sending while nothing reads the socket; the server answers each frame within
a second and the client reads the answer minutes later. The serving scheduler
has a cooperative macrotask yield for exactly this shape
(`scheduler/cooperative-yield.ts`); the resume path has none.

## Stages

Each stage lands on its own, with its test red first. The measurement in
stage 0 is what every later stage reports against.

### Stage 0. Count the plans

- [ ] A runner unit test that resumes a piece whose pattern maps a list of
      sub-patterns each holding a nested sub-pattern, with the storage layer
      stubbed so no network is involved, and counts `#nodePlan` calls against
      the set of `(instance, node)` pairs the tree holds. Today the ratio is
      above one; the test pins the number as it stands and stage 2 turns it
      into one. The count reaches the test through an
      `accessForTestingOnly` getter, as `DEVELOPMENT.md` § Classes requires.
- [ ] A benchmark in `packages/runner/test/` that resumes the same shape at
      sizes 10, 20, and 40 rows and reports wall time, `#nodePlan` calls,
      and watch roots requested, with the fixture outside the timed window
      (`BENCHMARKS.md`, "Time only the operation the name promises").
- [ ] The field check: `cf piece render` of the Estuary room, under
      `CF_MEMORY_FRAME_LOG`, read with
      `skills/perf-investigation/scripts/summarize-frame-log.ts`. The
      numbers to carry are CPU seconds, watch frames, roots requested, and
      bytes out; the record above has the baseline.

Exit: a number per stage that a pull request can quote.

### Stage 1. A `data:` document carries references

- [ ] `getImmutableCell()` and `dataUriFromValueWithResolvedLinks()` stop
      calling `inlineExternalSchemaRefsInValue()`; the function and its
      test go. The comments at both sites that give the self-containment
      reason go with it.
- [ ] Test, red first: a `data:` cell built from inputs whose links carry
      `cid:` schema references keeps the references in its id, and a read
      through it under a schema resolves the link's schema from the registry.
- [ ] Test: a value holding a link to such a `data:` cell, written to a
      stored document, is flattened on write and the write installs the
      closure of every reference the flattened value holds.
- [ ] Settle the one residual: the schema registry's retention lease can
      clear between a plan's construction and its read. Either show that a
      plan's lifetime is inside one lease epoch, or have the plan hold the
      interned closure it was built with. Record which in the pull request.

Exit: no call in the runner rewrites a schema reference for a `data:` id.

### Stage 2. A child's start skips what its parent named

- [ ] When `#syncResumeInstanceNodes` has planned and synced a nested
      instance's nodes, the runner records that instance in `#namedFamilies`
      as landed for its pattern, the entry `#familyToName` consults, so the
      child's own `run()` through `#nameFamilyBeforeRun` finds it named and
      skips the pre-sync. The record carries `defaultsPrepared: false`,
      since the parent's pre-sync seeds no defaults: a child start that
      initializes defaults still seeds them, through the path that today
      handles `seedInRun`.
- [ ] A nested instance the parent left unplanned — its result document
      never arrived, or its argument link was unreadable in every round — is
      not recorded, so its own start names what it needs, as today.
- [ ] Stage 0's count test goes green at a ratio of one.
- [ ] Test: a child whose pattern pointer moved between the parent's
      pre-sync and its own start is planned again under the new pattern,
      which the `landed` identity check already provides.

Exit: one node plan per `(instance, node)` pair per load.

### Stage 3. The cross-space pass walks links

- [ ] Before the pass reads anything, it checks each plan's bound inputs
      for a link whose space differs from the piece's, following links
      through documents already local. A plan with none is skipped. This is
      a walk over links under the plan's read schema, with no
      `validateAndTransform`, no freeze, and no hash.
- [ ] A plan that does reach another space keeps today's read, which is
      what kicks the load and awaits it by document.
- [ ] The pass runs once per family, after the last instance round, rather
      than once per round: a round's new plans are the only ones it has to
      walk, so each round contributes its plans to one set the final pass
      reads.
- [ ] Decide, with stage 0's benchmark, whether the walk is enough or the
      server should report the links its walk stopped at in the sync
      response. The server evaluates selectors with the runner's own
      traversal over a one-space `EngineObjectManager` (`memory/v2/query.ts`),
      so the stop is observable there. Take the server route only if the
      client walk still shows in the profile.
- [ ] Test, red first: a resumed pattern with ten plans of which one links
      into a second space reads the far document local before its first
      run, and `validateAndTransform` is reached by that one plan only,
      observed through the timing statistics.

Exit: the cross-space pass costs in proportion to the links that cross.

### Stage 4. Planning yields to the socket

- [ ] The instance rounds in `#syncResumeInstanceNodes`, the list-children
      pass, and the per-family planning in `#syncCellsForRunningPatternInner`
      yield one macrotask turn between instances once a slice of continuous
      planning has run longer than the serving yield's slice, through
      `CooperativeYield` constructed for the resume path on every posture,
      not only the serving one. A yield point is never inside a loop that
      holds a transaction open.
- [ ] Test, red first: a resume with many instances against a storage
      manager stub that answers every watch on a macrotask receives its
      first answer before it has sent its last request, observed as the
      order of the stub's send and receive events.
- [ ] The frame log on the field check shows no receive silence longer than
      the longest server operation.

Exit: a load's watch responses are read as they arrive.

### Stage 5. Documents

- [ ] `docs/development/debugging/profiling.md` names the
      `runner/start/*` rows; add the plan count and the yield count, and
      drop any row a stage retires.
- [ ] `presync-from-node-plans.md` describes the cross-space pass as a read
      of each plan's inputs; restate it as the walk, and point here.
- [ ] `docs/specs/memory-v2/04-protocol.md` says nothing about `data:`
      documents carrying schemas inline, and stays silent; the comment at
      `link-utils.ts` that did is gone with stage 1.

## Out of scope, noted

The 3.2 MB watch frame is mostly two 5 KB selectors repeated 296 times. A
selector table per frame — each distinct selector once, roots naming it by
hash, as the frame log already records them — would cut the bytes out by an
order of magnitude. It is a protocol change under
`docs/specs/memory-v2/04-protocol.md` and a separate plan.
