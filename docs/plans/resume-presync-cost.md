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

**A plan's inputs document carries every schema.** `#nodeIOBinding` hands
the bound inputs to `getImmutableCell()`, which mints a `snapshot:` id from
the value's content. With each link's content-addressed schema reference
rewritten to its inline form before the mint, a document carries 10 to
30 KB of schema and is hashed whole, once per node: on a thirty-message
room's cold load, 2,073 of the profile's 6,348 hashing samples, 2.8 s of
worker CPU over about 3,000 nodes. A traversal can resolve a reference
inside such a document through the registry that minted it, since no space
stores the document and none holds the closure, so nothing requires the
inline form there.

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
      reaches the test through `Runner.accessForTestingOnly.presyncPlanRecorder`.
      The ratio is one: the root's waves plan each pair once, and a child
      whose family is whole does not name it again. What the field load pays
      is the next stage's hold, which this shape does not provoke because
      the root's own run computes the derived argument before the rows
      start.
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

### Stage 1. An immutable cell keeps its links' schemas as references

- [x] `inlineExternalSchemaRefsInValue()` keeps the inline form each
      reference recomposed to, by reference, for the registry epoch
      (`inlinedSchemaByRef`, cleared with the registry): a reference names
      one content, so the form it recomposed to once is the form it has.
      The portable boundaries still inline — a `data:` identifier, a value
      crossing the runtime boundary, the content identity two immutable
      documents compare by — and this memo is what they pay.
- [x] `Runtime.getImmutableCell()` mints the value as the caller held it,
      references included. A link inside a snapshot minted from a value no
      space has stored (`mintedFromUnstoredValue`,
      `packages/runner/src/immutable-cell.ts`) names a closure the realm
      registry holds, since the registry minted the reference, and the
      traversal's loader takes a document the registry holds from there for
      such a document rather than reading the space the snapshot is
      addressed in (`loadSchemaDocClosure`, `packages/runner/src/traverse.ts`);
      a document the registry lacks is read from the space, as for a stored
      document (`docs/specs/content-addressed-schemas.md`, "Space
      boundaries").
- [x] Tests: the inline form is the same object on a second call for the
      same reference (`packages/runner/test/link-utils.test.ts`); an
      immutable cell keeps each link's schema as the reference the caller
      held, and a read through it resolves the linked value
      (`packages/runner/test/runtime.test.ts`).
- [x] The field check, three interleaved pairs on the thirty-message room's
      reload: `getImmutableCell` from 3.5–6.2% of the worker's busy samples
      to 1.1–2.6%, the hashing under it (`#findSnapshot`) from 2.1–3.6% to
      0.9–1.3%, and the pre-sync frame from 7.5–11.3% to 3.8–7.3%, the
      rendering unchanged. The record is
      [`../history/development/performance/2026-10-16-fabrichat-room-inputs-documents.md`](../history/development/performance/2026-10-16-fabrichat-room-inputs-documents.md).

Exit: a plan's inputs document is hashed over its links, not its schemas.

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
- [x] Tests, red first, in
      `packages/runner/test/piece-named-before-start.test.ts`: a piece
      whose family is local runs without holding when its caller's argument
      links to a derived cell nothing has computed, to another piece's
      stream, or to a local document whose content links to an absent one.
- [x] The field check: `start/syncCellsForRunningPattern` on the room from
      80 to 32, `resumeCellSync` spans from 4,877 to 502, the rendering
      unchanged.
- [x] The holds left after that were on per-user instances (`scope: user`)
      of documents — a viewer's per-user cells the chips receive — which no
      store holds for a viewer who has not written one, and which a
      name-sync could not deliver. The gate no longer walks the argument of
      an instance the resume pre-sync planned under the same pattern
      (`Runner.#presyncNamedInstances`, the first part of
      `docs/plans/presync-from-node-plans.md` stage 5): the pre-sync's
      plans are the plans a name-sync would build. A tree whose rows
      receive a link to a document nothing has written resumes with one
      name-sync (`packages/runner/test/resume-presync-plan-count.test.ts`).
- [x] The field check again: `start/syncCellsForRunningPattern` on the
      room from 32 to 2, `resumeCellSync` spans from 502 to 204,
      `resumeCrossSpaceRead` spans from 2,586 to 101, and the render's user
      CPU from 37–45 s to 17 s on the same machine at the same load, the
      rendering unchanged. The pre-sync no longer appears among the
      profile's top inclusive frames; pattern compilation and the render's
      sinks do.
- [x] For an instance the pre-sync named, a derived cell it owns reads
      present once its record has arrived. The cell's document can hold the
      `result` back-link setup wrote and no value, in the store as on the
      replica that loaded it: nothing has demanded its computation, the
      computation yields `undefined`, or the client that set the instance
      up closed before the commits of its values were applied. The gate
      read value presence for every owned cell but a stream, so an instance
      owning such a cell was held on every load for a name-sync with no
      value to deliver, and a list's rows were held twice each: the element
      piece, then the row it instantiates. `#familyAbsent` takes the record
      for the cell, unless the cell is owed a default at a scope narrower
      than the result of the instance that owns it, which a start's
      preparation seeds (`ownedCellRecordSuffices`). A tree whose rows each
      own a derived cell that yields `undefined` resumes with one
      name-sync, as does one whose rows run a per-user sub-instance owning
      a per-user cell with a default; a tree named by a synced run in a
      caller's transaction, which seeds nothing, has each row's per-user
      default seeded by the row's own start
      (`packages/runner/test/resume-presync-plan-count.test.ts`).
- [x] The field check, on a thirty-message room of sixty row instances
      whose rows each own one derived cell nothing demands, five reloads
      each way from copies of one store: `start/syncCellsForRunningPattern`
      from 124 to 4 on every reload, `resumeCellSync` spans from 13,285 to
      295, and all sixty rows instantiated inside their list's own run
      where none had been. The record is
      [`../history/development/performance/2026-10-13-fabrichat-row-name-syncs.md`](../history/development/performance/2026-10-13-fabrichat-row-name-syncs.md).
- [x] A named family's start is held on an owned cell that is absent
      only while the replica has not examined its document
      (`IStorageProvider.unexaminedAbsences`): the pre-sync asked the store
      for every cell the family owns, so an absence it was told of is what
      the store holds, and the session's own instance of a session-scoped
      cell, which no store holds before the session writes it, counts as
      examined without asking. A cell owed a default at a narrower scope
      still holds the run, since the hold's preparation is what seeds it
      (`ownedCellOwesSeed`), and so does a family whose probes spent the
      gate's budget (`NAMING_PROBE_BUDGET`), since a cell the budget left
      unprobed was never read, and a store-confirmed absence a serving
      runtime's store read-through remembers (`#storeAbsences`), which
      the replica reports unexamined for commit to reconcile. Before this, a thirty-message room's load
      paid eleven name-syncs, nine of them holds of named families on such
      cells: the room core, the add-member surface and the manager core on
      session-scoped cells, four nested instances on the valueless cell a
      `wish` writes to; the room core's name-sync planned the whole room a
      second time before the room could render, and half of the 3,976
      list-child syncs a load paid were repeats. After: two name-syncs,
      1,983 list-child syncs, 299 cell syncs where there were 776, and the
      pre-sync's share of the worker's CPU from 17.6% to under 4% (a tree
      whose rows own a session-scoped cell resumes with one name-sync,
      `packages/runner/test/resume-presync-plan-count.test.ts`). The
      record is
      [`../history/development/performance/2026-10-16-fabrichat-room-cold-load-phases.md`](../history/development/performance/2026-10-16-fabrichat-room-cold-load-phases.md).
- [ ] An instance the pre-sync did not name is still held on a derived
      cell that holds no value: one a caller's `run()` reaches, or one
      whose pre-sync round had a sync that failed. Taking the record there
      too changes what a start does when a policy manifest cannot be
      loaded. In `packages/runner/test/cfc-policy-manifest-shared-install.test.ts`,
      "starts it again for the participant who set it up when the manifest
      cannot be loaded", the piece's per-user part is held on its derived
      cell `known`, which nothing has computed, so the part starts in a
      transaction of its own and its refused commit leaves the piece
      running. A part that is not held starts inside the piece's
      instantiation, and the refusal takes the piece's start with it. That
      already happens once any reader has demanded `known`. Decide first
      whether a part's start belongs in its parent's instantiation when a
      manifest it needs is unreachable.

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
- [x] The server reports the links its walk follows out of the space in
      the frame that answers the watch (`crossings` on the session sync
      payload, `docs/specs/memory-v2/04-protocol.md`, advertised as
      `syncCrossingsV1`), each as the target-rooted path and schema the
      read needed, the way the walk already shapes a same-space miss. The
      storage manager kicks a load for each from the target space and lists
      it while in flight, and the pre-sync awaits those loads by document,
      through their own frames' crossings in turn, instead of reading its
      plans to find them (`followsCrossings`); against an older server it
      reads as before. The first round had materialized every plan under
      its read schema to find the crossings: on the room, 101
      `resumeCrossSpaceRead` spans after stage 2's second part, 2,586
      before it, and `validateAndTransform` under `#syncCrossSpaceReads`
      a quarter of the profile then.
- [ ] The field check: `resumeCrossSpaceRead` absent from the room's
      profile, the far documents local, the rendering unchanged. The
      deployed server has to advertise the capability first.

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

### Stage 6. The first run and the render

Measured on rooms of thirty and of a hundred and twenty message rows seeded
on a local toolshed
([`../history/development/performance/2026-10-11-fabrichat-room-load-local.md`](../history/development/performance/2026-10-11-fabrichat-room-load-local.md)),
where the pre-sync was no longer the whole cost.

- [x] The scheduler's topological sort indexes the work set's readers by
      the document they read, so a writer's ordering edges cost the readers
      of what it writes rather than the whole set
      (`packages/runner/src/scheduler/topology.ts`).
- [x] The sort's cycle break chooses from a heap of candidates kept under
      the break's preference, so a break does not rank the unplaced actions
      again (`packages/runner/src/scheduler/topology.ts`).
- [x] No computation of the room or of a message row is a declared writer
      of the room's `messages`, so none orders against another through the
      list. The room derives what a row shows of the list as a whole once,
      each row reads its own message's part, and the helpers a computation
      hands the list take it as a `Cell`, which declares no write
      (`packages/patterns/fabrichat/room.tsx`, `message-row.tsx`,
      `room-records.tsx`).
- [x] The sort breaks a cycle at one of its own members: a member of a
      strongly connected component of the unplaced actions that no unplaced
      action outside it feeds, so an action that only reads from a cycle is
      placed after what it reads (`../specs/scheduler-v2/README.md` §7.4,
      `packages/runner/src/scheduler/topology.ts`). The thirty-row room's
      counts are in
      [`../history/development/performance/2026-10-12-cycle-break-room-counts.md`](../history/development/performance/2026-10-12-cycle-break-room-counts.md).
- [x] CFC commit preparation indexes a transaction's write-policy inputs by
      the document they name, once per transaction, so every check a
      written path makes reads the inputs about its document
      (`packages/runner/src/cfc/prepare.ts`).
- [x] A boundary pass holds one view of the transaction's reads, the
      stored envelope behind each and the labeled set a protected entry
      quantifies over, built once and reused across the pass's targets
      while the transaction's input records, and the metadata object each
      carries, are the ones it was copied from and the resolved envelopes
      stand; the reactivity log stands across a read under the sealed
      verifier metadata, which it never lists; and a deep-frozen document's
      schema entries are kept by the document, unless the walk lacked a
      schema document a reference names. On the thirty-row room's reload,
      preparation fell from 15.5% of the load to 4.4%, and its mean from 52
      to 12 ms per commit, on a pair of runs at the same machine load.
- [x] A pattern holds its argument and result schemas deep-frozen from the
      time the builder makes it, and so does each copy of its graph that the
      builder puts into a pattern nesting it. `schemaAtPath` keeps a
      narrowing only for a deep-frozen schema, and binding a pattern's nodes
      narrows the pattern's argument schema for every argument alias it
      binds, so every such narrowing is one `schemaAtPath` keeps.
      `factoryFromPattern` takes the two schemas deep-frozen from the
      sanitizer (`sanitizeAndFreezeSchemaForLinks`,
      `packages/runner/src/link-utils.ts`), and the builder's binding walk
      freezes the schemas of each pattern graph it rebuilds
      (`packages/runner/src/builder/to-encodable-form.ts`). Each schema
      stays an object of its own and is not the interned instance:
      `createRef()` hashes an object it reaches twice in one cause as
      `null`, so two positions of a graph sharing one schema object derive
      other ids than two positions holding equal ones. The thirty-row
      room's counts and profile shares are in
      [`../history/development/performance/2026-10-13-pattern-schema-narrowing.md`](../history/development/performance/2026-10-13-pattern-schema-narrowing.md),
      and the shares once the pre-sync held a node's bindings, when the
      binding walk fell from 2.1–3.6% of the samples to 0.9–1.2%, are in
      [`../history/development/performance/2026-10-13-pattern-schema-narrowing-remeasured.md`](../history/development/performance/2026-10-13-pattern-schema-narrowing-remeasured.md).
- [x] A schema derived for a sync or a binding is derived once per schema
      it is derived from, and interned, so `internSchema()` is given an
      object it has seen: it hashes the whole of any other, whether or not
      the content is already interned. The read schema a handler plan's
      inputs are synced under is kept per handler schema, which is frozen in
      place when first read (`schemaWithEventSlotAsStream`,
      `packages/runner/src/runner.ts`); the selector schema a link's target
      is asked for, per deep-frozen reader schema (`selectorSchemaForLink`,
      `packages/runner/src/storage/v2.ts`); the reference and the inline
      form a selector goes to the wire in, per decomposition
      (`externalizeSyncSelector`, `packages/runner/src/storage/v2-watch.ts`);
      and a binding's schema with its slot's declared scope folded in, per
      emitted schema (`packages/runner/src/pattern-binding.ts`). Two results
      are keyed by content, because each document holding a link carries
      the link's schema as an object of its own: a shaped reader crossing a
      link that declares a default keys the schema it continues with by its
      own schema and that default (`combineSchemaForLink`,
      `packages/runner/src/traverse.ts`), and `schemaHasIfc` judges a
      deep-frozen schema as the interned instance of its content
      (`packages/runner/src/schema-ifc.ts`). No two positions of a pattern
      graph share a schema object for it. On the thirty-row room's reload,
      86,407 of 1.25 million `internSchema()` calls had missed the identity
      cache and hashed 150 million characters of schema JSON; 35,101 miss
      and hash 45 million, and interning is 2.8 to 4.8% of the profile's
      samples where it was 5.7 to 9.1% in the render paired with each. The
      counts per caller are in
      [`../history/development/performance/2026-10-13-schema-interning-on-reload.md`](../history/development/performance/2026-10-13-schema-interning-on-reload.md).
- [ ] Of the 35,101 schemas a reload still interns as new objects, 13,749
      arrive deep-frozen, most of them a link schema read out of a document:
      a true reader's crossing (`mergeSchemaFlags`), the link-target
      selector and the crossing's `schemaHasIfc` each intern such a schema
      once per object. A plan's inputs document is decoded apart from the
      value it was minted from, once for its sync and again for its reads,
      so each decoding holds new objects; the last item of this stage is
      where that ends. Link serialization interns the stripped schema it
      builds and a reference it builds per call, 5,839 times a reload
      (`externalizeLinkSchema`, `packages/runner/src/link-utils.ts`).
- [x] A preparation seals a frozen snapshot of the transaction's activity
      and computes its digest only when something reads it. A commit whose
      activity epoch stands where the preparation left it accepts the
      snapshot by identity; one whose epoch moved snapshots again, hashes
      both and compares (`docs/specs/cfc-commit-preparation.md`, "The
      prepared digest and the commit-time recheck"). The snapshot's records
      are frozen without entering the deep-frozen cache. On the thirty-row
      room's reload each of the 1,223 prepared commits had hashed a digest
      and none does; the digest fell from 3.2–4.2% of the load's profiler
      samples to 0.5–0.6%, and preparation from 6.1–7.8% to 3.5–4.4%, over
      three base and two changed runs interleaved on one machine at a load
      average between 250 and 500. The shares count samples: at that load
      most of the time between two samples is time descheduled.
- [ ] Of a reload's 1,223 prepared commits, 746 attempt only writes the
      transaction elides as equal to what is stored, and read 345 documents
      each on average. An elided write is still an attempt the gates answer
      to (the Contextual Flow Control specification's §8.10.2.1), so such a
      commit cannot skip preparation without changing what is refused. What
      it still pays toward a digest is the snapshot, one record per read,
      which is taken where the preparation ends: taken any later, it would
      rest on every activity site reporting itself before the journal
      changes. The flow join is the next cut.
- [x] The storage manager keeps each data URI's hash and decoded value in a
      weight-bounded memo, and does not sync a link that declares a stream:
      its document holds no value a read uses, and the sync had sent one
      root carrying the stream's event schema per stream to receive an
      absence record (`packages/runner/src/storage/v2.ts`).
- [x] An inline array element's snapshot id is kept by the value's identity
      and the link it was read through, so resolving the element as a cell
      encodes it once per document version rather than once per resolve
      (`packages/runner/src/cell.ts`).
- [x] Measured: the thirty-row room's first load from 71 to 30 s to the
      messages and its second load from 42 to 16 s, on the same machine
      within the hour.
- [x] A handler plan's `$event` slot is read as a stream, the inputs walk
      skips a position the reader declares a stream, and the owned-cells
      wave syncs a stream cell whole: three paths had loaded each handler's
      stream under its event schema, one root carrying that schema per
      stream, for an absence record. A reload of the thirty-row room sends
      6.1 MB of watch frames instead of 10 MB.
- [x] A fourth path had survived those three: setup writes each derived
      internal cell's `result` pointer, and that meta write starts a load of
      the cell's document under the cell's link schema, which for a
      handler's stream is its event schema. One root carrying that schema
      per stream, 4.5 KB each, about 25 per message row and 848 per load of
      the thirty-row room, at the resume wave and again after the settle,
      each answered with an absence record. The storage manager now loads
      every cell declared a stream as the whole document
      (`StorageManager.syncCell`), the rule the owned-cells wave had
      applied for itself; the roots stay, at 26 bytes each. On a
      three-row room the watch frames of a reload went from 1.5 MB to
      1.1 MB, and the stream-event selector is gone from the frame log.
- [x] A link schema written into an ordinary document is stored as a
      reference when the reference is the shorter wire form; a trivial
      schema, one decomposition refuses, and a bare handle stamp stay
      inline (`docs/specs/content-addressed-schemas.md`). A nested
      instance's argument document had carried one inline closure per
      captured input, 27 KB of a 64 KB operation per message row in the
      first-run commit, which is now 40 KB.
- [x] The server's oversized-message refusal is a terminal rejection, so a
      commit refused for its size is not sent again unchanged.
- [x] A message row's argument document carried two label entries per
      message in the room, 60 of its 85: the row received a link to the
      whole list at `array`, which its callback never declared, because the
      list built-ins read an unnamed key of an object schema as declared,
      and the link write persisted the list's label view under the slot.
      The built-ins now pass a row only the arguments its schema names and
      drop a stored slot the schema leaves unused on replay, so the label
      maps grow with the message count once, not twice.
- [ ] The remaining label map of a row is its 25 fixed entries, about
      9 KB, of which the `LinkReference` atoms are the largest share: each
      spells its source and its target in full, and on an in-place link
      entry both restate the link stored beside it.
      `cfc-independent-reference-labels.md` stops minting the atom, so a
      slot written after it carries none, and a slot written before keeps
      its atom until its pointer is replaced; this item closes on a
      measurement of a freshly written row.
- [ ] A load of a materialized room still commits for a fifth of its time,
      writing a reader's own instance of every session-scoped derivation
      in a commit of its own: 429 commits of about 400 bytes on the
      thirty-row room.
- [ ] The first-run commit of a hundred-row room is one transaction, and
      at 24.7 MB it stood for more slots than the server admits.
- [x] A node's bindings, and the inputs document minted from them, are
      computed by the pre-sync and taken by the node's instantiation
      (`NodeBindingMemo`, `packages/runner/src/node-binding-memo.ts`).
      Binding reads nothing through a transaction, so the held part is keyed
      by what it is computed from: the node, its pattern, the result cell's
      link, the argument link, and the kind of module the node resolved to
      with, for a pattern node, the pattern that module holds. What the
      bound outputs redirect to is still read through the planning
      transaction on every plan, so an action's transaction records the
      reads it did before and an instantiation writes what it did before.
      Measured at `1384591508`, when the room built two rows a message, a
      reload of the thirty-message room made 9,528 plans and computed 9,528
      bindings; it now computes 3,111, none of them at instantiation, and
      holds 69 MB of bindings at its peak and none once the tree is
      running. The 1,823 further calls the planner made to itself for nodes
      whose module is a registry reference bound nothing, and are gone with
      the loop that resolves the reference first.
- [x] A binding is held from the first plan of its node for every later
      plan of it, across the load, rather than given up to the node's
      instantiation; and a pattern is named in the memo's key by its
      content identity, a node by its position among its nodes, so the
      pattern embedded in a parent's graph and the one loaded by identity
      for the instance's own start share their bindings
      (`Runner.#bindingSubjectMembers`). On the thirty-message room's
      reload, 1,711 bindings were computed for about 1,614 `(instance,
      node)` pairs: 79 nodes were planned again after their instantiation
      had taken the binding, and 18 missed on the pattern object. A node
      planned after its instantiation, and a node planned under two
      pattern objects of one identity, each bind once
      (`packages/runner/test/resume-presync-plan-count.test.ts`). The
      reload now computes 1,618 bindings and mints 1,618 documents: the
      1,614 pairs, and the four stand-in instances bound once more at their
      instantiation, which the memo never holds (the record above).
- [x] A runtime keeps the ids of the derived internal cells it has hashed
      most recently, 65,536 of them (`DerivedInternalCellIds`,
      `packages/runner/src/derived-internal-cell-ids.ts`). Every action
      whose scheduler summary is complete lists its pattern's derived cells,
      so a row of 49 nodes hashed each of its cells' ids once per such
      action: the reload hashed 114,694 ids for 3,167 cells.
- [x] The scheduler holds event handlers by the address of their stream
      (`EventHandlerRegistry`, `packages/runner/src/scheduler/events.ts`),
      where a registration and a dispatch each compared the link of every
      handler registered. The reload registers 1,154.
- [x] Measured as process CPU time on a Deno reload of that room, main at
      `1384591508` against the three changes above, two runs of each side
      by side:
      the two `messages.map` actions from 8.4 to 5.0 s, node plans at
      instantiation from 3.1 to 0.4 s and in the pre-sync from 13.8 to
      6.2 s, derived cell ids from 2.1 to 0.4 s, handler registration from
      0.18 to 0.01 s, and the whole render from 75.8 to 66.8 s.
- [ ] Every plan still resolves its outputs' redirect chains: 9,528
      resolutions on the reload for 3,100 nodes. The 3,100 an instantiation
      makes belong in the action's transaction. The pre-sync makes the other
      6,428 in read-only transactions it discards, across three passes over
      the same nodes, and could make each once.
- [ ] Past the bound on held bindings the earliest bindings are dropped
      before a later plan asks for them. The bound is 256 MB of inputs
      documents. While a document carried the schema of every link it holds
      inline, averaging 22 KB, the thirty-row room held 69 MB and a room of
      about a hundred rows was at the bound; a document now carries each
      link's schema as a reference, a few hundred characters a link, and
      the room that reaches the bound is to be measured again.
- [ ] A plan's inputs document is decoded apart from the value it was
      minted from: once for its sync (`valueFromDataUri` under
      `#syncDataURICell`, `packages/runner/src/storage/v2.ts`) and again for
      its reads. The sync's decode was 4.1 to 7.5% of the profile's samples
      on the thirty-row room's reload, measured before the pre-sync held a
      node's bindings. A document decoded there is one this process minted,
      so keeping the minted value by its URI would spare the decode, and
      with it the link schemas a decode makes new objects of.

Exit: a room of a hundred rows opens in the browser.

## Out of scope, noted

The 3.2 MB watch frame is mostly two 5 KB selectors repeated 296 times. A
selector table per frame — each distinct selector once, roots naming it by
hash, as the frame log already records them — would cut the bytes out by an
order of magnitude. It is a protocol change under
`docs/specs/memory-v2/04-protocol.md` and a separate plan.

The compiled program is 1.7 MB per cold worker and evaluates in 0.9 s, with
no cache in the browser; shrinking the compiled output and caching compiled
closures in the browser are each their own work.
