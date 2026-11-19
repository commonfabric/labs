# Serving a piece's stored outputs while they are current

Status: In progress. Stages 1 to 3 are being built behind
`SERVER_EXECUTION_SKIP_CURRENT_PIECE_STARTS`; stages 4 to 8 are not started.

A serving loop starts a piece whenever a session's demand reaches one of its
documents, and a fresh serving runtime runs every demanded computation of the
piece again. The store already holds what those computations wrote. This plan
keeps a durable record of which stored outputs are current, propagates a stale
mark through the store when an input changes, and has the serving loop start a
piece only when a demanded output is marked or was never recorded.

Two problems motivate it:

- **A start that derives nothing new.** A session that opens a board of
  3,264 Topics starts every Topic to learn that its stored outputs are what it
  would compute (`served-reference-reads.md`).
- **A stale output nothing recomputes.** Piece A writes document `a`. Piece B
  reads `a` and writes `b`. Piece C reads `b`. A session demands C and nothing
  of B's. The demand pass starts only the pieces that enclose C
  (`enclosingSourcesOnly`), so when `a` changed while B was not running, C
  reads the `b` that B derived last and nothing brings B back.
  `space-server-enclosing-start.test.ts` pins that a producer a demanded piece
  takes its input from stays unstarted.

## The design

### What is recorded

Three facts, all identifiers and sequence numbers, overwritten in place:

- **A key is settled.** A key is one document instance, `(id, scope key)`. A
  settled key is one the serving loop vouches for: at a quiescent point every
  computation that writes it was current. The row names the piece that owns
  the key, or no piece for a key nothing computes.
- **A piece read a document.** One row per `(piece, input space, input id)`,
  the union of what the piece's current computations read. Scope keys are left
  out: a change to any instance of the document counts.
- **When the piece's record was taken.** `as_of` is the highest input
  sequence number the quiescent point covered. `wave_seq` is the sequence
  number of the wave commit that carried the piece's own writes at that point,
  when there was one.

A piece is identified by the raw id of its result document, the
`pieceRootId` every action of the piece carries
(`schedulerObservationIdentity`). A nested instance is a piece of its own.

### How a key becomes marked

Each settled key carries a mark: `0` clean, `1` an input of its piece is
itself marked, `2` an input of its piece changed.

A cursor names the sequence number the marks are complete through. Advancing
it reads the documents whose revisions lie above the cursor
(`idx_revision_branch`), and for each change at sequence `m`:

1. Every piece that read the changed id, whose record has `as_of < m`, and
   whose `wave_seq` is not `m` for a derived commit, gets every clean key
   marked `2`.
2. Each key that just became marked is a changed input for the pieces that
   read its id: every clean key of those pieces is marked `1`, whatever their
   `as_of`. This repeats until no key changes, so the walk stops wherever it
   reaches a key that is already marked.

Nothing runs at admission. The cursor is advanced by the serving loop, once
per cycle that drained input and once before each decision below, so a quiet
space pays nothing and the cost follows the changes, not the size of the
graph.

### How a mark is cleared

The serving loop records at the end of a cycle that settled without
exhausting its flush deadline, whose wave committed every contribution, and
only for the pieces a run touched during the cycle. For each such piece it
replaces the piece's rows as a set:

- its reads are those of its computations that are clean;
- its keys are the demanded keys each of whose writers is clean, for every
  instance a demander needs. A key the piece settled earlier that no session
  demands now is dropped, and reads as never recorded.

After the rows are replaced the piece's keys are marked `1` if any document it
read has a marked key, and clean otherwise. A piece whose keys became clean is
a cleared input for its readers: a reader whose keys are marked `1` and that
now reads no marked key becomes clean too, and so on outward. A reader marked
`2` stays marked until its own record is replaced. This is what lets a
recomputation that produced an equal value clear the marks below it without
starting the pieces below it.

A key nothing computes is recorded with no piece when the cycle that settles
it leaves no structure load owed: a watch root that is not a piece, and an
absent document a session's selectors reach. A root whose structure load
parked because its chain holds no pattern pointer is recorded as a piece of
its own whose reads are the documents the chain walk observed, so a commit
that gives it a pattern marks it.

### What the demand pass does with it

With the policy on, the demand pass asks, for each root awaiting its first
structure load whose piece is not running, whether every session demanding it
is settled. A session is settled when each of its demand rows passes:

- a row that is a watch root or carries a piece mark must be a settled key
  with mark `0`;
- any other row must be a settled key with mark `0`, or name a document the
  store holds.

A root every demander of which is settled is not loaded and not started. It
stays among the roots awaiting a first load, so it is judged again whenever
demand changes or the cursor's advance marks a key. A root demanded by a warm
request is always loaded.

The arrival seed and the arrival re-arm run only for a started piece, so a
piece that is not started is neither seeded nor fanned out for the arriving
session. A session whose demand reaches an owed scoped default it does not
hold has an absent row, is not settled, and gets the start and the seed.

### Starting what is stale upstream

A marked key whose piece is not running, and that a running demanded piece
reads, is demanded by the loop itself: the piece's root joins the structure
load as an identity-less root, as a warm request's staged documents do, and
the key enters the demanded entities so its writers run. The loop asks the
store for those keys after each advance that marked something, following
marked keys upstream until it reaches clean ones. This closes the A, B, C case
above for every piece that has been recorded.

## What it leaves alone

- `scheduler_basis` keeps being written and scanned as it is. The currency
  index replaces what it was meant for, and labs #9911 removes it.
- A reaped store loses the index, and every piece reads as never recorded.
- Compaction keeps the head revision of every document, which is what the
  cursor's advance reads.
- A space with the policy off records nothing and starts pieces as it does
  today.

## Known limits

- **A piece is recorded only after a session demanded it and a cycle
  settled.** A piece a handler made, and a piece served before the policy was
  on, starts on its first demand.
- **A piece is marked whole.** The reads are per piece, so a change to a
  document only an undemanded computation reads marks the demanded keys too,
  and the piece starts once on its next cold demand.
- **A producer the loop starts stays for the tenure.** Stage 7 releases it.
- **A crash loses what the last cycles would have recorded.** The affected
  pieces are marked by their own later commits and start again, as every piece
  does today.
- **Reads in another space are recorded and not followed.** A change there
  marks nothing here until stage 8.

## Stages

1. **The index.** `runtime/memory/v2/currency-index.ts` and its tables
   (`currency_piece`, `currency_read`, `currency_key`, `currency_cursor`):
   replace a piece's record, advance the cursor, judge a session's rows, list
   the marked keys upstream of a set of pieces. The tables join the SQL
   guard's core names and the engine's table list.
2. **Recording.** The memory server takes records and questions on behalf of
   a serving host (`HostMemoryServer`, the worker port protocol). The space
   server collects the pieces each cycle touched at `#stampRun`, snapshots
   their clean computations' reads and write entities from the scheduler at
   the settle, and sends the records once the wave's commit has landed.
3. **Not starting a current piece.** `SpaceServerPolicy.skipCurrentPieceStarts`
   and `SERVER_EXECUTION_SKIP_CURRENT_PIECE_STARTS`, off by default; the
   demand pass's settled question; the re-judgment after an advance.
   `serving-loop.md` §1 and §3b, and the experimental options registry, change
   with it.
4. **Starting stale producers.** The upstream question and the identity-less
   roots.
5. **Measure the Topics board.** Open a recorded board from a fresh worker
   with the policy on: structure starts, session documents written, worker
   heap, and the cost of the settled question at 3,264 Topics. Decide from
   that whether `served-reference-reads.md` question 1(a) and a narrower
   arrival seed are still worth building.
6. **Judging before activation.** The host asks the settled question when a
   session opens a parked space and activates only when it fails or events are
   pending. A commit into a space with live sessions and no serving loop
   advances the cursor from the admission-side notice and activates when a
   demanded key is marked.
7. **Releasing a piece when its last demand leaves**, the loop's own demand
   included (`serving-worker-heap.md`, step 3).
8. **Reads across spaces.** Mark from another space's changes through the
   owner route.

## Acceptance tests

For the index, in `runtime/memory/test/`:

1. A change above a piece's `as_of` marks its keys `2`, and a change at or
   below it marks nothing.
2. A derived change at a piece's own `wave_seq` marks nothing of that piece.
3. A marked key marks the keys of the pieces that read it `1`, through any
   number of pieces, and a walk that reaches a marked key goes no further.
4. Replacing a marked piece's record with clean inputs clears it, and clears
   each reader marked `1` that reads no other marked key; a reader marked `2`
   stays marked.
5. The cursor advances to the head, and a second advance with no commit reads
   nothing.

For the serving loop, in `runtime/runner/test/executor/`, with real client
runtimes over `EmulatedStorageManager`:

6. With the policy off, nothing is recorded and every start happens as today.
7. A piece demanded, settled, and parked is not started by the next tenure's
   demand for the same keys, and the session reads the stored values.
8. A change to an input of that piece, made while nothing served the space,
   starts it on the next demand and the session reads the recomputed value.
9. A session whose demand reaches a scoped default it does not hold starts the
   piece and is seeded.
10. A demand for a key of a recorded piece that no session demanded before
    starts the piece.
11. The A, B, C case: with all three recorded and none running, a change to
    `a` followed by a demand for C alone starts B, and C's session reads the
    value derived from the new `a`.
12. In that case, when B's recomputation leaves `b` equal, C is not started.

## Related

- `served-reference-reads.md`: the cost this removes for a recorded board, and
  the two questions stage 5 revisits.
- `serving-worker-heap.md`: step 2 (a demanded computation keeps its record and
  not its inputs) and step 3 (release on the last demand) build on the same
  record.
- labs #9911: removing `scheduler_basis`.
- labs #9788: the compiled pattern language keys the same kind of record by
  compiled instance and cone.
