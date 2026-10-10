# Cutting the resume pre-sync's cost

Opening a piece with nested instances — a chat room with twenty message rows,
a board with a hundred topics — spends most of its time in the pre-sync that
names what each node reads before the piece runs, and almost none of it in
the pattern's own code. Measured on a fabrichat room on Estuary, the pre-sync
was over half of 49 CPU seconds, the server at most 14 s of its own, and the
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

**Every child start names its family again, for a document no store holds.**
The root's start plans and syncs every nested instance, level by level, and
that is right. Each child then reaches `runner.run()` on its own once its
parent's coordinator runs, and `#patternToNameBeforeRun` decides whether to
name the child's family — a full pre-sync of its subtree — by probing
whether anything its run reads is absent from the replica. A derived cell
the parent hands down as an argument and nothing has computed, a per-session
display flag say, has no document anywhere; the root's waves asked the store
for it and were told so. The probe reads value presence alone, so the
document counts as absent, the child holds, and its name-sync delivers
nothing. Instrumented on the room: 79 holds, every one at that stage, none
for the probe budget, every absent document a `computed:` cell, the same
few recurring across the rows that received them.

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
(`packages/runner/src/scheduler/cooperative-yield.ts`); the resume path has none.

## Stages

Each stage lands on its own, with its test red first. The measurement in
stage 0 is what every later stage reports against.

### Stage 0. Count the plans

- [x] A runner unit test that resumes a three-level tree — a list of rows
      each holding a nested badge — against an in-process memory server,
      demands every row, and counts the pre-sync's node plans against the
      `(instance, node)` pairs the tree holds
      (`packages/runner/test/resume-presync-plan-count.test.ts`). The count
      reaches the test
      through `Runner.accessForTestingOnly.presyncPlanRecorder`. The ratio
      is one: the root's waves plan each pair once, and a child whose family
      is whole does not name it again. What the field load pays is the
      next stage's hold, which this shape does not provoke because the
      root's own run computes the derived argument before the rows start.
- [ ] A benchmark in `packages/runner/test/` that resumes the same shape at
      sizes 10, 20, and 40 rows and reports wall time, `#nodePlan` calls,
      and watch roots requested, with the fixture outside the timed window
      (`docs/development/BENCHMARKS.md`, "Time only the operation the name promises").
- [x] The field check: `cf piece render` of the Estuary room, under
      `CF_MEMORY_FRAME_LOG`, read with
      `skills/perf-investigation/scripts/summarize-frame-log.ts`. The
      numbers to carry are CPU seconds, `start/syncCellsForRunningPattern`
      count, watch frames, roots requested, and bytes out; the record above
      has the baseline (80 name-syncs, 49 CPU seconds).

Exit: a number per stage that a pull request can quote.

### Stage 1. A `data:` document's inline schemas come from a memo

- [x] `inlineExternalSchemaRefsInValue()` keeps the inline form each
      reference recomposed to, by reference, for the registry epoch
      (`inlinedSchemaByRef`, cleared with the registry). Recomposition
      built a fresh closure per link per plan, so every call deep-froze and
      hashed the same few schemas again; a reference names one content, so
      the form it recomposed to once is the form it has.
- [x] Tried and reverted: not inlining at all. The traversal admits a
      reference-form link schema only where its closure is persisted in
      the space (`schemaForSpaceCrossing`), and a `data:` document has no
      carrying write to persist one, so a reference inside it selects
      nothing where the inline form selected its schema. The traverse
      replay goldens moved under it, and the self-containment comment at
      both sites, which says exactly this, stays with its reason sharpened.
- [x] Tests: the inline form is the same object on a second call for the
      same reference (`packages/runner/test/link-utils.test.ts`); a `data:`
      cell carries each
      link's schema inline and a read through it resolves the linked value
      (`packages/runner/test/runtime.test.ts`,
      `packages/runner/test/data-uri-inlining.test.ts`).

Exit: a schema is recomposed once per reference per registry epoch.

### Stage 2. The gate probes what a name-sync could deliver

- [x] `#familyAbsent`'s argument walks probe the documents the argument
      links to and continue only through a redirect's hop, as its contract
      says, rather than into the content of every linked document four
      deep. The content of a value document is what the piece's nodes read
      through it under their plans' schemas, and the pre-sync names it that
      way; a link inside it is not one the argument holds, and the hold's
      name-sync names nothing for it. The field holds were all of this
      shape — 79 of 79, one to three hops below the row's argument, never
      delivered, never requested as a root: the room's derived cells first,
      then its handler streams, then fields of profiles in other spaces,
      each surfacing as the previous one was excluded.
- [x] Two direct links the walk still reaches are excluded by kind: a
      derived cell (`computed:` scheme), whose document its computation
      produces and whose absence the store's walk cannot report, and a
      stream, whose document holds no value and whose sends are events; a
      piece's own streams are still probed with its owned cells.
- [x] Tried and dropped: counting a document the replica had asked the
      store for and found absent as present. An owned per-user cell a
      visitor has never written is exactly such a document, and its hold is
      what seeds that actor's defaults
      (`packages/runner/test/scoped-internal-cell-seed.test.ts`
      pins it); on the room the rule changed one hold in eighty.
- [x] Tests, red first, in
      `packages/runner/test/piece-named-before-start.test.ts`: a piece
      whose family is local runs without holding when its caller's argument
      links to a derived cell nothing has computed, to another piece's
      stream, or to a local document whose content links to an absent one.
- [x] Tried and dropped: naming each nested instance's argument link
      targets root-only in the parent's rounds. On the room it issued no
      request the plans had not already made — the frame counts were
      identical — and cost 43 waves.
- [x] The field check: `start/syncCellsForRunningPattern` on the room from
      80 to 32, `resumeCellSync` spans from 4,877 to 502, the rendering
      unchanged.
- [ ] The 31 holds left are all on per-user instances (`scope: user`) of
      documents the replica holds as space instances — the viewer's
      per-user cells the chips receive — which no store holds for a viewer
      who has not written one, and which nothing in the pre-sync requests.
      They are the same defect in a fourth shape, and the general fix is
      the one `docs/plans/presync-from-node-plans.md` stage 5 owes: the gate
      asks the
      plans what a name-sync would deliver and probes that, instead of
      walking the argument.

Exit: a child's start names its family only when something a name-sync
could deliver is missing.

### Stage 3. The cross-space pass reads a plan again only when it must

- [x] Each plan reads in a transaction of its own, so the loads a read
      kicks are attributable to that plan; a round reads again only the
      plans whose previous read left a load pending, and a plan whose read
      completed is done. The pass had read every plan in every round, so a
      family with one crossing plan among _n_ paid 2*n* reads where it
      needs *n*+1. Each read is a `start/resumeCrossSpaceRead` span.
- [x] Test, red first: four lifts of which one reads through a link into a
      second space cost five reads
      (`packages/runner/test/resume-node-plan-presync.test.ts`).
- [ ] The first round still materializes every plan under its read schema
      to find the crossings: on the room, 2,586 `resumeCrossSpaceRead`
      spans over 32 families and 28 settles, nearly all of them the first
      round, and `validateAndTransform` under `#syncCrossSpaceReads` is
      still about a quarter of the profile. A walk over links under the
      schema, with no `validateAndTransform`, no freeze and no hash, would
      replace that read for the plans that cross nothing; the server could
      also report the links its walk stopped at. Either is the next step
      here.

Exit: the cross-space pass costs in proportion to the links that cross.

### Stage 4. Planning yields to the socket

- [x] The root wave and the instance waves issue their syncs through
      `#kickResumeWave`, which yields one macrotask turn between cells once
      a slice of continuous issuing is spent (`CooperativeYield`, held by
      the runner on every posture). Issuing a sync is where the synchronous
      work sits — each walks its data-URI links before sending — and no
      transaction is open there: a wave is kicked only after its planning
      transaction is aborted. The list-children pass kicks inside its
      planning transaction and keeps its shape.
- [x] Test, red first: with a zero slice, a timer due before the resume
      starts fires before the wave's last sync is issued
      (`packages/runner/test/resume-presync-plan-count.test.ts`).
- [ ] The frame log on the field check shows no receive silence longer than
      the longest server operation.

Exit: a load's watch responses are read as they arrive.

### Stage 5. Documents

- [x] `docs/development/debugging/profiling.md` names the
      `runner/start/*` rows; it now says what `resumeCrossSpaceRead` and
      `syncCellsForRunningPattern` count.
- [x] `docs/plans/presync-from-node-plans.md` describes the cross-space
      pass; it now
      says a round reads only the plans whose reads left a load pending.
- [x] `docs/specs/memory-v2/04-protocol.md` says nothing about `data:`
      documents carrying schemas inline, and stays silent; the comment at
      `packages/runner/src/link-utils.ts` that did is gone with stage 1.

## Out of scope, noted

The 3.2 MB watch frame is mostly two 5 KB selectors repeated 296 times. A
selector table per frame — each distinct selector once, roots naming it by
hash, as the frame log already records them — would cut the bytes out by an
order of magnitude. It is a protocol change under
`docs/specs/memory-v2/04-protocol.md` and a separate plan.
