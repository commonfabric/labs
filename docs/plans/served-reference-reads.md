# What a served view's references cost

Under server execution, a browser that only shows a reference to a piece can
make the serving loop start that piece, with a set of session documents, for
every viewer. This plan sets out where that happens, what the specifications
say about it, the questions it leaves for the owner of the serving loop, the
memory protocol and scoped instances, and the order in which to change it.

It comes out of putting the Topics board (3,264 topics) under server execution.
The measurements below were taken on a copy of that space's store, with labs
`36698c95c0` and an 8 GB worker limit, unless a line says otherwise.

## What was measured

Opening the board in one browser, before any change:

- Every Topic program on the board is started for the viewer's session, and
  again for the serving worker's own session.
- **Session documents.** Each start writes the Topic's nine `PerSession` cells
  as documents holding their declared defaults: 29,386 for the viewer, about
  29,400 for the worker. The viewer's set came in one 11.7 MB derived commit.
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
     `ensurePieceRunningVerdict`, which instantiates the whole piece for the
     demanding (principal, session) pair: every node, its UI, its handlers.
4. **The start seeds that viewer's session cells.**
   - `#materializeDerivedInternalCells` (`runtime/runner/src/runner.ts`,
     around line 4535) writes two things into each owned cell narrower than
     the piece's result: the cell's `result` backlink (`setResultCell`) and
     its schema default.
   - For a later actor it does this "in transactions of their own, before
     setup consumes the piece's other values". The serving loop's arrival
     seed (`ownedDefaultSeeds`) does the same for a demander who arrives after
     the start.
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
  - The cost comes from what a start includes: the piece's whole graph, and
    session instances for the demander. Nothing the watch reads needs either.
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
  - This covers unlabelled `cf-cell-link`s, profile badges and drag sources:
    every component that resolves a reference and reads nothing behind it.
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

### 3. What should a start for view demand instantiate?

A piece started because a session watches its result document gets that
session's instances of every node beneath it, before any session-scoped read
reaches them. Fan-out (`scopes.md` §2) says a node runs per demander once a
run discovers a narrower scope. Should a view-demand start create session
instances at all before such a discovery?

## Suggested order

1. **Done as a mitigation:** labs #9993, labelled links.
2. **1(a), the narrowest general change.** It is one watch marking, client
   and server, and every reference-resolving component stops starting pieces.
3. **2(a), defence in depth** for the pieces that do start, as when a viewer
   opens a Topic: today that writes 9 session documents for the viewer and 9
   for the worker.
4. **1(c), the long arc,** sequenced with the #9911 ruling.

## The test to add first

Whatever the design, this property should hold:

- Under server execution, a client runtime that resolves a link to a piece's
  result document (`resolveAsCell()` on a cell that holds the link), and
  reads nothing else, causes no structure load of that piece. It writes none
  of the piece's session-scoped documents.
- A client that then reads one of the piece's computed values, under a schema
  that reaches it, gets it computed and current.

It belongs in `runtime/runner/test/executor/`. The client has to be a real
`Runtime` over `EmulatedStorageManager`, as in
`space-server-root-preload.test.ts`, not stubbed `demandForSpace()` rows: the
rows cannot yet express a watch that only resolves.

## Related

- labs #9911, `scheduler_basis` and the durable read index.
- labs #9633, step 2 (a demanded computation keeps its basis rows) and step 3
  (release a piece when its last demand leaves).
- labs #9140: a read-only viewer holds derived state locally.
- labs #9907: bounding what one slow action costs its serving worker.
- labs #9993: the labelled-link mitigation.
