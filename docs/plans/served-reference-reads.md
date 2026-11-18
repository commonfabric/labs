# What a served view's references cost

Under server execution, a browser that only shows a reference to a piece can
make the serving loop start that piece and seed a set of session documents for
every viewer. This plan sets out where that happens, what the specifications
say about it, the questions it leaves for the owner of the serving loop, the
memory protocol and scoped instances, and the order in which to change it.

It comes out of putting the Topics board (3,264 topics) under server execution.
The measurements below were taken on a copy of that space's store, with labs
`36698c95c0` and an 8 GB worker limit, unless a line says otherwise.

## What was measured

Opening the board in one browser, before any change:

- **Starts and seeds are separate events.** A structure load starts each Topic
  once, whoever demands it: the demand pass runs it per key
  (`runtime/runner/src/executor/space-server.ts`, around line 6097). The
  demand loop separately seeds each demanding session's owned defaults.
  `space-server-structure-load-arms.test.ts` checks the shape: a second viewer
  gets seeds of its own, and there is still one start.
- **What was counted is the seeds.** Each demanding session got every Topic's
  nine `PerSession` cells written as documents holding their declared
  defaults: 29,386 for the viewer, and about 29,400 under the serving worker's
  own session. The viewer's set came in one 11.7 MB derived commit.
- **Not counted separately:** structure starts, and per-node instances for a
  session (fan-out). A reload raised the heap by about 1.7 GB, so a further
  session costs more than its documents, but this measurement does not say
  how that splits.
- **Heap.** The board's worker holds 7,104 MB after a full collection, and
  8,808 MB after a reload. The open takes about four minutes of waves.

Only one thing on the board's page reaches the Topics: each card's
`<cf-cell-link $cell={card.topic} label="Open" static />`. A bisect inside the
component found that its `resolveAsCell()` alone starts every Topic. Skipping
only its `[NAME]` subscription changed nothing.

labs #9993 makes a labelled `cf-cell-link` resolve only when it is pressed or
clicked. With it, the same open writes 3 session documents for the viewer and
2 for the worker. The worker holds 2,802 MB and the open settles in about 70
seconds. That covers labelled links only (4 of the 37 `cf-cell-link` uses under
`patterns/`). An unlabelled link, and any other component that resolves a
reference, still starts the piece behind it.

## Where it happens

Read from the code at `c15a766611`; the browser end is verified by the bisect.

1. **The client resolves the reference.**
   - `cf-cell-link` calls `CellHandle.resolveAsCell()`, and the browser's
     runtime worker runs `resolveLink`.
   - When the walk reaches a document the replica does not hold, it calls
     `kickDocPull` (`runtime/runner/src/link-resolution.ts:344`). That is a
     plain `getCellFromLink(link).sync()`: a graph watch rooted at the target
     piece's result document.
2. **The memory server counts the watch as demand.**
   - `#buildSessionDemand` (`runtime/memory/v2/server.ts`, around line 10165)
     makes every root of every watch except an `operation` watch a demand row
     with `root: true`.
   - It also flags a row `piece` when the document delivered for it is one of
     a piece's values (design §2.8, flag 4).
3. **The serving loop starts the piece.**
   - The demand pass (`runtime/runner/src/executor/space-server.ts`, around
     lines 5990–6080) treats such a key as a structure-load root.
   - `#attemptStructureLoad` (around line 6822) calls
     `ensurePieceRunningVerdict`, which starts the piece: its whole graph,
     every node, its UI and its handlers, once per key.
4. **Each demanding session's owned defaults are seeded.**
   - `#materializeDerivedInternalCells` (`runtime/runner/src/runner.ts`,
     around line 4535) writes two things into each owned cell narrower than
     the piece's result: the cell's `result` backlink (`setResultCell`) and
     its schema default.
   - The start does this for the session it runs in. For a later actor it is
     done "in transactions of their own, before setup consumes the piece's
     other values". The serving loop's arrival seed (`ownedDefaultSeeds`) does
     it for each demanding pair, including one that arrives after the start.
   - That is the stored `{ result: <link to the piece>, value: "" }` shape the
     Topics documents have.

## What the specifications say

- **`docs/specs/server-side-execution/serving-loop.md` §1** (line 262, ruled
  2026-08-02): "there is NO piece-start policy in v2 … activation loads graph
  structure sufficient to resolve the demanded values". The amendment of
  2026-09-09 (lines 282–289) adds that "a schema-less root watch demands the
  root document alone". A watch that only resolves a link reads the result
  document's own shape, not the piece's computed values.
  - Starting the piece is a defensible reading of "structure sufficient to
    resolve" that document, since its writer is the piece's setup.
  - The cost comes from what follows: the piece's whole graph, started once,
    and a seed of each demanding session's owned defaults. Nothing the watch
    reads needs either.
- **`docs/specs/scoped-cell-instances.md`** (around lines 392–412): "A
  pattern-owned cell narrower than its result starts from its declared
  default for each actor instance", filled before execution. One exception
  exists: "A cold start by a non-serving client with a confirmed READ-only
  space membership can resume persisted output without writing the viewer's
  absent scoped defaults. Their schema defaults remain readable; an explicit
  write still requires write access."
- **`docs/specs/server-side-execution/scopes.md` §2** (around line 190): the
  arrival seed exists because "the start that would have seeded them runs on
  no viewer's runtime under served views".

## Questions for the owner

### 1. Is resolving a link demand?

The watch `kickDocPull` registers exists so the replica can see where a link
lands. Three ways to stop it starting the piece:

- **(a) A resolution watch that is not demand.** The protocol already has a
  watch the server delivers but does not count: `operation` watches, which
  `#buildSessionDemand` skips.
  - `kickDocPull`'s sync would register the same graph query marked as
    resolution only.
  - The server would leave its roots and its delivered entries out of the
    session's demand rows, while still delivering updates.
  - A document another watch demands stays demanded.
  - **Shared coverage is the hard part.** `kickDocPull` also serves ordinary
    value reads, and the replica skips a new watch when a cached selector
    already covers a read. A passive watch could therefore warm the cache and
    stop a later computed-value read from ever registering demand. So:
    - the caller's intent has to travel through watch acquisition;
    - coverage a passive watch holds is promoted to demand when a demanding
      owner arrives;
    - the promotion survives a reconnect.

    The delivery-only view watches are the reference, including how they
    handle traversal misses.
  - **Only reference-only consumers gain**, such as a drag source, or a
    labelled link (handled now by #9993). An unlabelled `cf-cell-link` also
    subscribes to the target's `[NAME]`, and `cf-profile-badge` subscribes to
    profile fields such as the name and image. Those subscriptions stay
    ordinary demand under (a), so neither component stops starting the
    target. Measure the saving with a reference-only consumer, and test name
    and profile freshness separately.
  - A component that renders the target (`cf-render`) still demands it, as it
    should.
- **(b) Structure load by what the demand reads.** A key whose only rows come
  from schema-less root watches would make its root document current without
  instantiating the piece. Demand rows do not carry the selector today, so
  this needs the same protocol change as (a), from the other end.
- **(c) Currency without running.** The loop would serve a piece's stored
  outputs without starting it while they are current. §1 names the
  per-instance clean bit and "the basis index is the same predicate at
  activation" (`serving-loop.md:292`). labs #9911 reports that no production
  code reads that index, and asks whether it stays a commitment. A durable
  read index is what (c) would rest on, so that ruling decides whether (c) is
  open. (c) would also cover a name an unlabelled link shows.

### 2. Must every start seed every actor's session defaults?

The seeds are load-bearing today, in three places:
- `ownedCellOwesSeed` and `#familyAbsent` hold a run until its owed instances
  are filled, which is how an absent instance is told apart from one not yet
  synced.
- The CFC initialization record the seed carries.
- The `result` backlink write authority relies on.

Options:

- **(a) Extend the read-only exception to served views.**
  - An absent session instance with a declared default reads as that default.
  - The first explicit write fills the instance, with its backlink, under the
    ordinary write-authority and label checks.
  - The owed-seed gate would accept a confirmed-absent instance with a
    declared default as satisfied.
- **(b) Seed only for the actor who acts.** Keep seeding for an event's actor
  (the transient demander of `scopes.md` §2) and stop seeding for view demand.

**Either option has to cover a first direct field write.** A bound input can
write one field, `draft.title`, without a handler running. Today the arrival
seed makes that write land beside the other defaults: in
`runtime/runner/test/executor-fan-out.test.ts` case (n), the late viewer's
draft reads `{ title: "B", members: "" }`.
- Under (a), that first descendant write has to materialize the declared
  defaults and the backlink in the same transaction.
- A read of a default not yet written has to carry the owner's initialization
  label.
- Under (b), a viewer who types into a bound input without ever sending an
  event hits exactly this case: the partial document can no longer supply the
  full draft.

### 3. What should view demand cause, counted part by part?

Three things follow a session's demand on a piece today, and they should be
counted apart:
- the structure start, once per piece;
- the seed of each demanding session's owned defaults;
- per-node instances for the session, once a run discovers a narrower scope
  (fan-out, `scopes.md` §2).

The question is which of the last two a demand that reads nothing scoped
should cause.

## Suggested order

1. **Done as a mitigation:** labs #9993, labelled links.
2. **1(a), the narrowest general change.** It is one watch marking, client
   and server, with shared coverage handled as above. A consumer that reads
   nothing behind a reference stops starting pieces; one that reads the
   target's name or fields still demands them.
3. **2(a), defence in depth** for the pieces that do start, as when a viewer
   opens a Topic: today that writes 9 session documents for the viewer and 9
   for the worker.
4. **1(c), the long arc,** sequenced with the #9911 ruling.

## Acceptance tests

Whatever the design, these should hold. They belong in
`runtime/runner/test/executor/`, with real client `Runtime`s over
`EmulatedStorageManager` as in `space-server-root-preload.test.ts`. Stubbed
`demandForSpace()` rows will not do: the rows cannot yet express a watch that
only resolves.

1. **Resolution.** Under server execution, a client that resolves a link to a
   piece's result document (`resolveAsCell()` on a cell that holds the link),
   and reads nothing else, causes no structure load of that piece and writes
   none of its session-scoped documents. A client that then reads one of the
   piece's computed values, under a schema that reaches it, gets it computed
   and current.
2. **Shared selectors.** Read the same selector passive then active, and
   active then passive. In both orders the computed value becomes current,
   and the passive read alone causes nothing.
3. **Two viewers.** Structure starts, seeds and per-node instances are each
   counted, and each comes out as the design intends.
4. **A first blind field write**, as in `executor-fan-out.test.ts` case (n).
   The late viewer's draft still reads the full set of defaults beside the
   field it wrote.
5. **Name and profile freshness.** An unlabelled link's name and a profile
   badge's fields stay current, separately from the saving measured with a
   reference-only consumer.

## Related

- labs #9911, `scheduler_basis` and the durable read index.
- labs #9633, step 2 (a demanded computation keeps its basis rows) and step 3
  (release a piece when its last demand leaves).
- labs #9140: a read-only viewer holds derived state locally.
- labs #9907: bounding what one slow action costs its serving worker.
- labs #9993: the labelled-link mitigation.
