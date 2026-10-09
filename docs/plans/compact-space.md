# `compact-space` — shrinking one space's history after a write storm

**Status:** proposed; design only, nothing built. Written 2026-10-08 against
the shared Topics space after
[the October write storm](../history/development/performance/2026-10-07-topics-space-write-storm.md):
21 GB on disk, 2.29 million commits, 46,729 computed documents rewritten
671,434 times in one day. The runtime change that stops the loop is live; this
decides what to do with the history it left, and what the server should do so
the next storm leaves less.

Five questions, each answered with options and a recommendation:
[what compaction means](#1-what-compaction-means),
[how an operator asks for it](#2-how-the-operator-defines-the-compaction),
[what keeps it safe](#3-safety),
[where it lives and how it reaches a store](#4-where-it-lives), and
[what the server does afterward on its own](#5-what-the-server-should-do-afterward).
[What was left open](#what-is-deliberately-left-open) is at the end, and the
[stages](#stages) say what gets built in what order.

## The short version

Compaction is **materialize-and-truncate**: for each document instance in the
selection, rewrite its head revision as a `set` holding the document the
engine itself reconstructs at that head, keep the head's sequence number and
operation index exactly as they are, attribute the rewritten row to one
`system`-class compaction commit rather than to the session whose row it
replaced, and delete every revision and snapshot row behind it. Commit rows
are never deleted: outside a trailing window their payload is hollowed to a
marker, so the space's replay detection still recognizes every commit it ever
accepted and refuses a stale resubmission instead of applying it again. The
result is written out with `VACUUM INTO` as a new file; the file that was
compacted is never the one the server was serving, and the file that is
compacted is a snapshot taken after the owning instance stopped. The operator
selects documents by id prefix and bounds the cut by sequence, time, or a
per-document count; a dry run reports rows and bytes before anything is
written. Every head keeps its address — the space's ACL document excepted,
which gains one audit revision — so nothing a client or the serving loop
holds goes stale; what changes is that a read older than the cut conflicts
where it might once have been confirmed, and history below the cut is read
from the pre-compaction archive rather than the live store. The tool is `cf space compact`, built on a module in
`packages/memory/v2` beside `dump.ts`, rehearsed on a clone first, and run on
Estuary against a copy while the instance that owns the space is stopped.

The server-side change that matters most is not a cadence change and goes
first: the replay chain is already bounded at ten patches, but the engine's
search for a document's last `set` is not bounded by its newest snapshot, so
a document with a long patch-only history pays a scan over that whole history
on every cold read and on every commit that touches it. Bounding that search
is a code-only change that preserves history and helps the uncompacted store
on the day it ships, which is why it is [stage 1](#stages) and the compaction
tool comes after it.

## What exists (verified)

| Fact | Where |
| --- | --- |
| A space is one SQLite file. `commit` is the write log (`seq` primary key; `session_id` + `local_seq` unique; `original` holds the whole client commit, operations and reads; `resolution`; `class`). `revision` holds one row per operation on one document instance, keyed `(branch, id, scope_key, seq, op_index)`, with `op` in `set`, `patch`, `delete` and a foreign key to `commit`. `head` points at each instance's newest revision. `snapshot` holds a materialized document at a seq. `op_submission`, `op_integrated` and `op_checkpoint` hold collaborative operation fields with foreign keys to `commit`; `op_field_epoch` keeps a `commit_seq` column without one. `branch`, `execution_lease`, `scheduler_basis`, `execution_outbox`, `blob_store`, `invocation`, `authorization` complete the schema; patterns add their own tables through the SQLite builtin. | `packages/memory/v2/engine.ts`, the `INIT` statement |
| A read resolves the head row by joining `head` to `revision`, so a head whose revision row is missing reads as absent. A `set` decodes directly; a `patch` reconstructs from the newer of the last `set`/`delete` and the newest snapshot, replaying the patches after it. | `readStateForScopeKey`, `reconstructPatchedDocument` |
| The engine writes a snapshot when a document has accumulated `snapshotInterval` (10) patches since its base or newest snapshot, and keeps the newest `snapshotRetention` (2) per instance. So a replay chain is at most ten rows. | `maybeMaterializeSnapshot`, `DEFAULT_SNAPSHOT_INTERVAL` |
| Finding the base runs `selectLatestBase`, which walks the instance's revision index backward from the head until it finds a `set` or `delete`, no further back than the newest snapshot's seq. The index does not cover `op`, so each row the walk visits costs a table fetch; the bound keeps the walk within one snapshot interval of patches. Both reconstruction and the commit-time snapshot check run it through `latestBaseAndSnapshot`. | `SELECT_LATEST_BASE`, `latestBaseAndSnapshot` |
| A confirmed read is validated by scanning for a `set`/`delete` after its basis seq, then for an overlapping patch. A pending read whose basis the engine cannot reconstruct keeps the staleness refusal it arrived with. A pending read names the own-session layers its view included, and the conflict scan excludes rows whose commit carries that session and one of those `local_seq`s. A resubmitted commit is recognized by `(session_id, local_seq)` alone, answered from its stored result when its bytes match the stored `original`, refused as a replay mismatch when they do not, and applied as a fresh commit when no row is found. An `origin-committed` precondition looks up the origin commit by the same key. A revision's `commit_seq` is joined to `commit.seq` everywhere it is used; nothing requires it to equal the revision's own `seq`. | `findConflictSeq`, the pending-read `basisOf`, `selectExistingCommit`, `selectPendingResolution` |
| A resumed session's catch-up is a full watch evaluation diffed against the holdings the client sent, not a replay of commits since a seq. The serving loop's commit feed reads from the seq its index scan ran against, in-process. | `packages/memory/v2/server.ts` (`forceFullResync`), `selectCommitsSince` |
| The decoded-document cache keys an entry by the revision's address plus its `op` and data length, on the premise that the engine only appends revisions. The per-space bound is 128 MB and 65,536 entries; the Server bounds the total. | `documentCacheKey`, `DEFAULT_DOCUMENT_CACHE_*` |
| `VACUUM INTO` from a read-only connection is the sanctioned way to take a crash-consistent single-file copy of a live store. | `packages/memory/v2/dump.ts` |
| `cf space clone`, `verify`, `reset`, `fingerprint` and `cf inspect churn` are the rehearsal tooling; the state inspector reconstructs any entity at any seq with its own replay, independent of the engine's. | `packages/state-inspector/clone.ts`, `reconstruct.ts`; [`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md) |
| A production space is copied with `VACUUM INTO` on the host and installed by placing the file beside its neighbors while every instance is stopped; the recipe, the WAL trap and the rollback shape are written down. | [`staging-space-copy.md`](../development/staging-space-copy.md) |
| The storage spec says the revision log is append-only, is the audit trail, and is not deleted during ordinary garbage collection; retain-all is the default policy. Snapshots are the only sanctioned collection target. | [`memory-v2/02-storage.md`](../specs/memory-v2/02-storage.md) §7 |

Compaction is therefore a deliberate departure from the spec's retain-all
default, run by an operator and never by the server, and
[stage 5](#stages) amends §7 to say so.

## What the history costs today (measured on copies)

Two read-only copies of the Topics space from before the storm are on hand:
one from 2026-08-18 (3.5 GB, 326,186 commits) and one from 2026-09-23
(13 GB, 1,494,536 commits, 2,223,022 revisions, 672,073 head rows). The
storm's own file was not available to measure; the production numbers above
are from the investigation record.

**Where the bytes are.** A `set` stores its document twice — in
`commit.original` as the operation and in `revision.data` as the row — and a
patch stores its patch list twice the same way, and `original` also carries
the commit's read set. On the September copy the split is:

| Column | Bytes as stored |
| --- | ---: |
| `commit.original` | 8.09 GB |
| `revision.data`, `set` rows | 2.07 GB |
| `revision.data`, `patch` rows | 0.64 GB |
| `commit.resolution` | 39 MB |
| `snapshot.value` | 10 MB |
| `invocation`, `authorization` | empty; every commit's refs are null in this store |

Of the revision rows, 1,550,949 of 2,223,022 sit behind a head and carry
770 MB; of the commits, 1,307,316 of 1,494,536 own no head row, and their
payloads are what hollowing gives up. The history's weight is the commit log,
not the revision table, and dropping revision rows while leaving every commit
payload in place would reclaim under a tenth of the file. That is why the
design hollows unreferenced commits, and why the dry-run report prices them.

**The storm's shape is not new, and it is concentrated.** The August copy
already holds 43 instances with over 100 revisions carrying 299,165 of its
386,432 revisions, and 27 whose patch tail runs more than 1,000 rows behind
their last `set`; the longest is 48,750 patches on one `set`, from the July
generated-cell storm. By September the same copy has grown to 713 instances
over 100 revisions carrying 1,295,046 of 2,223,022, 515 tails over 1,000
rows, and a longest tail of 133,706 patches on one `set` — a `computed:`
document. The `computed:` namespace holds 1,376,705 of the September
revisions across 100,928 instances, 1,157,878 of them patches; the `of:`
namespace holds 845,073 across 210,191; `cid:` label documents 1,244. Every
commit is `authored`. The `op_*`, `scheduler_basis`, `execution_outbox` and
`blob_store` tables are empty, and the `branch` table holds only the default
branch.

**Most heads are session instances.** Of the 672,073 head rows in
September, 451,721 are `session:` scope keys and 17,813 are `user:`; the
space-scoped heads number 202,539. The storm's writers followed per-session
instances of the content redirect, and nothing sweeps a session's instances
when it ends. Compaction treats each instance alike; collecting dead
sessions' instances is [left open](#what-is-deliberately-left-open).

**What a long tail cost a reader before stage 1.** On the August copy,
against its longest-tailed document (head at seq 233251, a snapshot at the
head seq, so zero patches to replay), with the base search still unbounded:

| Query, as the engine issues it | Shell-timed, cold file |
| --- | ---: |
| process start, `SELECT 1` | 52 ms |
| `selectLatestBase`, unbounded (the engine's shape) | 91 ms, then 177 ms |
| the same bounded below by the newest snapshot's seq | 50 ms |
| head row lookup (`selectCurrentLocal`) | 100 ms |
| `selectSetDeleteConflict` from a basis at seq 1000 | 115 ms |
| the same from a recent basis | 60 ms |

Laptop numbers over a 3.5 GB file, noisy and not the server's cache state; the
finding they supported was structural rather than numeric. Every cold read of
a patch-headed document, and every commit that touched it, walked that
document's whole patch history to find a `set` the snapshot had already made
irrelevant, fetching a table row per index entry because `op` is not in the
index. Stage 1 bounded the walk by the snapshot. Measured through the engine
on the same copy, a cold read of each of the twelve longest-tailed documents
(10,042 to 48,751 rows each), after the first run had paid migrations and
warmed the file:

| Engine | Twelve cold reads | The 48,751-row document |
| --- | ---: | ---: |
| before stage 1 | 107.6 ms | 21.3 ms |
| after stage 1 | 10.2 ms | 1.6 ms |

The same twelve reads replayed 32 patch rows on both sides, which is the
reconstruction doing identical work past the lookup. Compaction still writes
the `set` that makes the history itself small; what stage 1 removed is the
reason a long history degraded every read and every commit of the document
that carried it.

The storm investigation's 180 ms per `transact` with no lock wait was
consistent with this walk running at commit time for each of the four or five
confirmed reads, on top of the conflict scans from old bases. The rehearsal in
[stage 6](#stages) measures the remainder on the real file rather than
inferring it.

## 1. What compaction means

### The invariants a compacted store must keep

Each is something a reader relies on today, with the code that relies on it.

- **I1 — every head keeps its `(seq, op_index)`.** Clients hold entity seqs in
  their holdings and confirm reads against them; the scheduler basis index
  records input seqs and decides dirtiness by comparing them with heads; the
  commit-class annotation of a frame resolves through the head's seq. Moving
  a head to a new seq would make every one of those stale at once and hand the
  serving loop a full re-derivation on activation — a storm to end a storm.
  The one exception is the space's ACL document, `of:<did>`, which the
  compaction commit rewrites with [the audit marker](#what-a-user-sees) and
  which is never itself selected for compaction; its head advances to the
  compaction commit's seq, which every client re-reads on join anyway.
- **I2 — every head has its revision row**, because the head read is a join.
- **I3 — the first surviving row of every instance is a base**, a `set` or a
  `delete`, or a snapshot at or before it exists, because reconstruction
  starts from one or the other and otherwise starts from the empty document.
- **I4 — every retained boundary row is nobody's write.** The boundary is
  the oldest row an instance keeps: a materialized `set`, a head that was
  already a `set` or `delete`, or the first row above a bounded cut. A
  materialized `set` folds in every session's writes since the base, so it
  must not be attributed to the session whose patch it replaced: a pending
  read from that session names its own layers, the conflict scan excludes
  rows carrying them, and a foreign write folded into an own-attributed row
  would vanish from the scan (Astra's review reproduced this on a store that
  kept every commit row). A boundary that was already a `set` has the other
  problem: left under its original author, nothing in the store says that
  history was deleted behind it, and a guard that infers "never compacted"
  from an ordinary author accepts a stale basis as a genuine absence (Astra's
  review reproduced that too, with a prototype of the guard). So the rule is
  uniform: whatever its op, the boundary row's `commit_seq` is rewritten to
  point at one `system`-class compaction commit the run inserts at the next
  free seq. The row's own `seq` and `op_index` stay (I1), `commitClassOfSeq`,
  which resolves by the row's `seq`, still finds the original commit's class,
  and the original commit row survives under I6. The attribution is the
  cutoff record: an instance was truncated if and only if its oldest row
  points at a compaction commit, and nothing has to infer it from the
  surviving operation. A per-instance cutoff table was the alternative; it
  would need a new table the engine reads on every basis check, where the
  attribution is a column the engine already joins. The commit's
  `(session_id, local_seq)` is unique per run — `compaction:<run id>` and
  `1`, where the run id is the run's UTC timestamp — because the `commit`
  table has a unique index on that pair and a second or resumed run inserts
  a second commit. The commit feed (`selectCommitsSince`) would list every
  compacted instance as that commit's writes if a feed read ever spanned its
  seq; none does, because the serving loop reads the feed from the seq of a
  commit it has just made, and after the restart every such commit is newer
  than the compaction commit. If one ever did, the cost is one dirtiness mark
  per compacted instance and no change of value, which the stage-4 tests
  state rather than leave implicit. The commit also carries the one revision
  of its own that [a user can see](#what-a-user-sees).
- **I5 — tombstones survive.** An `entity-absent` precondition refuses when
  any `set` or `delete` exists for the id; dropping a `delete` row would let a
  deleted entity be recreated under its old id.
- **I6 — every commit row survives; only payloads go.** Replay detection
  knows an accepted commit by its `(session_id, local_seq)` row and nothing
  else; a client that reconnects after any gap resubmits what it never saw
  acknowledged, and a resubmission whose row is gone is applied as a fresh
  commit over newer state (a doubled `increment`, an old `set` landing on top
  of a later one — Astra's review reproduced the second with a week-old row
  swept by an age window). No age window makes this safe, so no commit row is
  deleted. Outside the retained window the row's `original` is replaced by a
  marker carrying a hash of what it held; a resubmission then mismatches the
  stored bytes and is refused as a replay mismatch, which the client surfaces
  as a terminal error for a write that in fact landed, and never mutates
  state. `origin-committed` preconditions, `commitClassOfSeq` and the commit
  feed read the columns that stay. [§5](#5-what-the-server-should-do-afterward)
  turns the refusal into a faithful `replayed` answer.

  "Nothing references it" is not the same as "only history reads it". The
  genesis receipt — commit 1's `original` — is read directly by
  `readGenesisRoot` and `readSpaceKind` in `packages/memory/v2/genesis-root.ts`
  for the root reservation and the declared space kind, with no revision or
  foreign key naming it; session opening and root initialization depend on
  both (Astra's review reproduced `Invalid genesis receipt` after hollowing
  it). Commit 1 is therefore never hollowed. The eligibility rule is a list,
  not a predicate: a payload is hollowed only when no surviving `revision` or
  `op_*` row references the commit, its seq is not 1, and it is outside the
  retained window. The audit behind the list is every `FROM "commit"` outside
  the engine: `genesis-root.ts` is the one live reader of `original`; the
  state inspector's readers (`conflicts.ts`, `timetravel.ts`, `churn.ts`,
  `scopes.ts`, `grouping.ts`, `queries.ts`, `clone.ts`, `discover.ts`) are
  offline history readers that lose what the archive keeps. A reader added
  later that consumes `original` directly must add itself to the list, and
  the stage-4 test that reopens a compacted store and reads the genesis root
  and space kind is what notices if it does not.
- **I7 — everything that is not revision history is untouched**: `head`
  addresses, `op_*` tables, `scheduler_basis`, `execution_outbox`,
  `blob_store`, `branch`, `execution_lease`, and every table a pattern created
  through the SQLite builtin.
- **I8 — the default branch is the only branch.** A forked branch reads its
  parent's rows at `min(seq, forkSeq)`; a base materialized at a head past the
  fork would be invisible to it, and the parent rows it read would be gone.
  Compaction refuses a store with any non-deleted non-default branch rather
  than reasoning about forks; the Topics space has one branch row, the
  default.
- **I9 — compacted history is never mistaken for absence.** This one is an
  engine invariant, not a tool invariant, and it must ship before any store
  is compacted. The identity exemption of the commit model
  (`03-commit-model.md` §3.6.1) accepts a conflicting commit when replaying
  its operations on the reader's actual basis yields the stored document;
  the engine reads that basis with `read({seq})`, which returns absent for a
  seq below the instance's first surviving row. An absent basis is a
  fabricated one: a patch applied to nothing can equal the stored document
  while the same patch applied to the reader's real view would not (Astra's
  review reproduced this for a confirmed read at seq 1 and for a pending read
  naming an own layer, with every commit payload retained and the
  materialized row already attributed to the compaction commit). The engine
  therefore distinguishes a compacted basis from a genuine absence and
  returns `known: false` before the identity proof, for confirmed and pending
  reads alike, so the staleness refusal stands and the client retries against
  fresh state. The distinguishing fact is in the store because I4 puts it
  there for every truncated instance, not only the patch-headed ones: an
  instance whose oldest surviving row points at a compaction commit (`class
  = 'system'`, session `compaction:`) lost history, and any basis older than
  that row is unknown; an instance whose oldest row points at an ordinary
  commit lost nothing, and a basis older than it is a genuine absence as
  today. The guard reads the attribution and never the op: a boundary that
  was a `set` before compaction and a boundary that became one are the same
  case to it.
  Robin's framing — compaction is an operations event, and the restart that
  accompanies it drops every session — covers everything except this: a
  client's queued commit from before the restart carries its old basis into
  the new session, and only the engine can tell that basis is gone.

### The options

**(a) Materialize-and-truncate.** One algorithm for the default cut and the
bounded ones, in this order per selected instance. First compute the retained
boundary: the oldest row the cut keeps — the head itself under the default
cut, or the oldest row at or above the cut under `--before-seq`, `--before`
or `--keep-last`. If the instance has no row below the boundary, it loses
nothing and is left exactly as it was, attribution included. Otherwise, if
the boundary is a `patch`, reconstruct the document at exactly that row —
its `(seq, op_index)`, not its seq — and rewrite the row in place as `op =
'set'` with the encoded document, at the same `(seq, op_index)`, updating
`head.op` when the boundary is the head. Exactness matters because one
commit can carry several operations on one document and a bounded cut can
fall between them: the state at the boundary is the state after the
boundary's own operation and before the later ones the cut keeps, which the
tail then replays. The engine's reconstruction is bounded by `(seq,
op_index)` for the base row and the patches but chooses a snapshot by seq
alone, and a snapshot at a seq always holds the state after that commit's
last operation, so with a snapshot at the boundary's seq it would fold the
kept operations into the base and the tail would apply them twice (Astra's
review reproduced `["a", "b", "b"]` from a two-append commit). No caller
reaches that today — a read resolves to a commit's last operation, and the
in-commit validator runs before any snapshot at its seq exists — so the tool
needs a reconstruction the engine exports for it, taking the exact `(seq,
op_index)` and considering only snapshots at a strictly smaller seq. Under
the default cut the boundary is the head, a commit's last operation on the
document, and the two agree; a boundary that is already a `set` or `delete` keeps
its op. Then point the boundary row's `commit_seq` at the run's compaction
commit (I4), delete the revision rows ordered before it and every snapshot
row at or below it (the boundary is now the base), and leave every row above
the boundary untouched — a head above a bounded cut stays a `patch` over the
new base, under its original commit, exactly as it was. Nothing but the
boundary is ever rewritten or re-attributed. Then hollow the
`original` of every commit row that no surviving revision or `op_*` row
references and that falls outside the retained window (I6). The compaction
commit is inserted first, at `max(seq) + 1`, with the run's report as its
`original`, and `branch.head_seq` advances to it so the head read keeps using
the head statement. Keeps I1 through I8.

What it gives up: time travel below each head, and the per-revision record
of which label a document carried at each earlier state, both of which move
to the archive file the operator takes first. A confirmed read with a basis
below the head now sees a `set` after its basis and conflicts, where before
it might have found only non-overlapping patches and been confirmed; the
client retries against fresh state, which is the safe direction. A
resubmitted commit whose payload was hollowed is refused rather than
answered, until the engine learns to answer it (§5).

**(b) Collapse alternating runs.** Keep the history but remove revisions that
only cancel each other: a run A, B, A, B, …, A becomes A. This is what the
storm's history looks like, and it answers "keep the audit trail". It does
not hold up. Deciding that a run cancels means decoding every revision and
comparing values, 671,434 decodes for this space; removing a patch from the
middle of a chain is only sound if the next surviving row is rewritten as a
`set`, so the mechanism is (a) applied at every run boundary; a reader whose
basis sits inside a removed run confirms where it would have conflicted, so
the conflict semantics change in the unsafe direction unless the run's net
effect is exactly identity, which the storm's runs are not (they end on one
of the two spellings); and what it preserves is a record whose content is,
by construction, noise. Rejected.

**(c) Drop revisions older than a seq or a time, keeping every head.** The
same mechanism as (a) with a cut: rows below the cut go, and the first row
at or above it is rewritten as a `set` so I3 holds. Keeps recent history for
`cf inspect history`, `diff` and `timeline`. This is (a) with a bound rather
than a separate option, and the design folds it in as the `--before-seq`,
`--before` and `--keep-last` flags of [§2](#2-how-the-operator-defines-the-compaction).

**(d) Full rewrite into a new store** that keeps heads, scoped instances,
labels and the `op_*` state. The attraction is a fresh file: no free pages,
a current page size, no `VACUUM`. The cost is that the tool must enumerate
every table to copy, and the tables patterns create through the SQLite
builtin are not known in advance; one omitted table is silent data loss.
(a) followed by `VACUUM INTO` produces the same fresh file without
enumerating anything, so (d) is reached as the last step of (a) rather than
built as its own path.

### Recommendation

One algorithm, materialize-and-truncate, with the cut as a parameter. Default
cut is the head of every selected instance. For the Topics case, select the
`computed:` prefix and leave authored documents' history alone: it is small,
it is the history people ask `cf inspect` about, and the storm did not touch
it. Compact other prefixes only when a dry run shows they carry it.

The commit that produced the head stays in the `commit` table under its own
`(session_id, local_seq)` (I6), but the materialized row no longer points at
it (I4). A client resubmitting that exact commit within the retained window
is answered with the stored seq as before; the revisions the answer re-derives
its elision report from are now none, so every operation reads as elided and
the document as unchanged, which is true at the head and is noted here rather
than guarded against.

## 2. How the operator defines the compaction

```
cf space compact <store.sqlite> [selection] [cut] [--dry-run] [--json]
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--documents <prefix>` | Instances whose id starts with the prefix, every scope key. Repeatable. The id namespaces are `of:`, `computed:` and `cid:`, so `computed:` selects the storm's documents and nothing a person authored. | required; no implicit "everything" |
| `--scope <space\|user\|session>` | Restrict to one scope kind within the selection. | all |
| `--before-seq <n>` | Rows with `seq < n` are candidates; the first row at or above `n` becomes the base. | the head: everything behind it |
| `--before <timestamp>` | The same, with `n` taken as the newest commit created before the timestamp (`commit.created_at`, UTC). | — |
| `--keep-last <n>` | Keep the newest `n` revisions per instance, the oldest of them rewritten as the base. | 0 |
| `--keep-payloads <duration>` | Commit rows created within this window of the newest commit keep their `original` even when nothing references them; older unreferenced rows are hollowed (I6). The window bounds how far back a resubmission is answered faithfully rather than refused; it bounds no safety property. | `24h` |
| `--dry-run` | Compute and report; write nothing. | off |
| `--json` | The report as JSON, per the `cf` JSON contract. | off |

`--before-seq`, `--before` and `--keep-last` combine as the most conservative
of what they allow: a row survives if any of them keeps it.

The dry-run report, printed before any write and by `--dry-run` alone:

- the selection: prefixes, scope kinds, the number of instances matched, how
  many lose at least one row (their boundary is re-attributed), how many of
  those have a `patch` boundary (materialized), and how many of those
  boundaries are heads (the head's op changes);
- rows to delete from `revision` and `snapshot`, and their byte totals as
  stored (`length(data)`, `length(value)`);
- commit rows that become unreferenced, how many fall inside the retained
  window and keep their payload, and the bytes of `original` the rest give up;
- invocation and authorization rows that become unreferenced (empty in the
  Topics store, where every commit's refs are null);
- the ten instances contributing the most rows, with their head seq and op;
- the seq the compaction commit would take, and the preconditions checked:
  one branch, no foreign-key violations, `op_*` rows referencing no commit
  whose payload would be hollowed.

Bytes in the report are stored lengths, not the file-size reduction; the
file shrinks only when `VACUUM INTO` writes the result.

**`VACUUM`.** The deletes leave free pages inside a file that stays 21 GB. An
in-place `VACUUM` needs an exclusive lock for its whole run and scratch space
of about the file's size; `VACUUM INTO` writes a fresh file of the compacted
size and leaves the source as it is. Since the procedure installs a
replacement file anyway, the tool ends with `VACUUM INTO <out>` and never
vacuums in place; `--out <path>` names the result, and defaults to
`<store>.compacted.sqlite` beside the source. The source's `execution_outbox`
rows survive a vacuum with their ids because that table declares its id
column for exactly this reason.

**Batching and resumption.** The compaction commit is inserted first in its
own transaction; each instance is then compacted in its own transaction, and
the hollowing pass runs last in seq-ranged batches, so a run interrupted
anywhere leaves a store every reader can use and a second run picks up where
the first stopped: an instance whose boundary already points at a compaction
commit with nothing below it is a no-op, and a hollowed row is recognized by
its marker.
A second run inserts a second compaction commit under its own run id (I4);
the report names both. The run ends with `PRAGMA foreign_key_check` and `PRAGMA integrity_check` on the
result. Nothing is deleted from `commit`, so the foreign keys from the `op_*`
tables are never exercised; the pass still refuses to hollow a commit an
`op_*` row references, because those tables read `original` through their
own paths.

## 3. Safety

### The store must be offline

The engine's cache assumes revisions are only ever appended; the tool rewrites
a row in place and deletes behind it. A process serving the file while that
happens would serve from entries that no longer describe any row. So the tool
never runs against a file any server has open:

- on Estuary, the instance that owns the space is stopped first
  ([§4](#4-where-it-lives) names it); the tool runs against a copy, and the
  live file is replaced as a file;
- the tool takes an exclusive lock when it opens (`locking_mode = EXCLUSIVE`
  and an immediate write transaction) and refuses on `SQLITE_BUSY`, which is
  what a process holding the file in WAL mode produces; a `-wal` sibling of
  non-zero size is reported and refused too, because a stale log left beside
  a replaced database is recovered onto the replacement;
- the tool refuses a path inside the directories the environment says a
  local server serves, the same rail `cf space clone` applies
  (`liveStoreDirs` in `packages/cli/commands/space.ts`). This catches a
  laptop mistake, not a host one; the host rule is the first bullet.

### Backup first

`VACUUM INTO` from a read-only connection, as `dump.ts` does, **taken after
the owning instance has stopped.** A snapshot taken while the instance still
accepts writes is consistent but not complete: every commit accepted between
it and the stop is absent from whatever is compacted from it and installed in
its place, and no verification against that same snapshot can notice, because
every head compares equal. A live snapshot is fine for the rehearsal and the
dry run; the replacement is compacted from the post-stop one. The backup is
three things at once: the rollback, the archive that keeps the history the
live store loses, and the source the tool reads. It is named for what it is,
`<did>.pre-compaction-<date>.sqlite`, checksummed, and kept until the
operator decides the history has no further audit value, which is a decision
for the space's owner rather than for the runbook. Disk needed on the host:
the backup (the current size), the result (the compacted size), and WAL
headroom for the run; `df -h /data` before starting, and the staging copy
document's note that `/tmp` has no room applies here too.

### Verification, in order

Each check fails differently and the order goes from cheap to expensive:

1. `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the result.
2. **Heads unchanged, one excepted.** `SELECT branch, id, scope_key, seq,
   op_index FROM head WHERE id <> '<of:did>' ORDER BY 1, 2, 3` hashed on
   backup and result must match; the ACL document's head must be exactly the
   compaction commit's seq at `op_index` 0 with op `set`; the count of heads
   whose `op` changed from `patch` to `set` must equal the dry run's count of
   materialized boundaries that are heads; the count of boundary rows
   pointing at the compaction commit must equal the dry run's count of
   instances that lost a row; and under a bounded cut every row above a
   boundary is byte-identical to the backup's, op and `commit_seq` included.
   Every head must still join to a revision row.
3. **Every document reads back identical, one excepted.** Reconstruct every
   selected instance at its head on both files with the state inspector's
   replay (`packages/state-inspector/reconstruct.ts`), which is a second
   implementation of the engine's rule, and compare canonical encodings. All
   of them, not a sample: it is offline and runs in minutes, and "every head
   identical" is the claim the operator wants to make. For the ACL document
   the comparison is: `value` byte-identical, and the only root member that
   differs is `compaction`, holding what the dry run said it would.
   `--verify-sample <n>` exists for a quick pass during rehearsal.
4. `cf space fingerprint` on both files must agree. The fingerprint excludes
   generated cells, so it is necessary rather than sufficient, and it is
   cheap.
5. **The compaction commit is recorded**: one `system` row at the seq the dry
   run named; the rows pointing at it are exactly every boundary this run
   re-attributed — materialized or already a `set` or `delete` — plus the
   run's one ACL audit revision, and no other; `branch.head_seq` equal
   to it, the hollowed-row count equal to the dry run's, and the marker on
   the ACL document present and naming that seq.
6. **Live metadata survives.** On the reopened result, `readGenesisRoot` and
   `readSpaceKind` return what they return on the backup, and commit 1's
   `original` is byte-identical.
7. **Serve it.** Clone the result (`cf space clone --from <result>`), start a
   local toolshed on it with the workspace's port offset, open the Topics
   board cold, and read the board and a handful of topics through `cf`. The
   acceptance checks are the ones `space-clone-rehearsal.md` lists plus two
   for this tool: `/api/health/stats` for the space shows `patchReplays` not
   climbing on a cold board load, and `transact` round trips on a topic edit
   are below the storm's 180 ms.
8. On the host after install, the two checks `staging-space-copy.md` ends
   with: the space is listed, and a read through the API returns the content.

### Four protocol cases the verification must cover

Head equality passes all four; they are what Astra's two reviews showed
materialize-and-truncate gets wrong without I4, I6 and I9. The first two are
regression tests of [stage 4](#stages), run against the engine on a store the
tool compacted; the last two are tests of the engine guard in
[stage 2](#stages), run against a store transformed by hand the way the tool
will transform it, and run again in stage 4 against the tool's own output:

- **A pending read crossing compacted foreign writes stays refused.** Session
  A sets a document (localSeq 1); session B patches a path of it; session A
  patches another path (localSeq 2); compact. Session A then commits a
  pending read of B's path at basis 0 naming layers 1 and 2, with a derived
  write that records what it read. Before compaction this conflicts, naming
  B's seq; after compaction it must still be refused, not accepted with the
  derived document recording the stale value.
- **An old resubmission never becomes a fresh mutation.** Session A sets a
  document; session B patches it; compact with A's commit outside the
  payload window. Resubmitting A's original commit must not be applied: the
  document keeps B's value and the response is a refusal (or, once §5 lands,
  `replayed: true` at the original seq). Before compaction the same
  resubmission is answered `replayed: true` at seq 1.
- **A confirmed read whose basis was compacted away cannot prove identity.**
  Seed a document with `{x: 2, y: 3}` at seq 1; another session replaces it
  with `{x: 1}` and then patches `/value/x` to `1`, so the head is a patch;
  compact. Submit the same patch with a confirmed read of the document at
  seq 1 and path `[]`. Before compaction this conflicts: the patch on the
  reader's real basis yields `{x: 1, y: 3}`, not the stored `{x: 1}`. After
  compaction it must still be refused, not accepted with the operation
  elided because the patch on an absent basis happens to equal the stored
  document. The same case with the `set` as the head — no trailing patch, so
  the boundary was already a `set` and only its attribution changed — must
  also stay refused; so must the same case under a bounded cut that keeps
  rows above the boundary.
- **A pending read whose basis was compacted away cannot prove identity.**
  The same seed; session A's localSeq 1 adds `/value/x = 2`; session B does
  the replacement and the patch; compact. Session A's localSeq 2 submits the
  same final patch with a pending read at `basisSeq: 1` naming layer 1. Refused
  before compaction; it must stay refused, in the patch-headed, `set`-headed
  and bounded-cut variants alike.

### What a user sees

A space's history is a promise to the people in it: the transaction log is
persisted, and anything that happened can be audited. Compaction breaks that
promise for the compacted range, on purpose and with the owner's agreement,
and marks each hollowed commit explicitly: its envelope is replaced by the
marker, which nothing a client writes can resemble, so a reader of the log
can tell a hollowed commit from an elided write; what is lost is the
contents, which are available only in the archive. A commit whose payload
survives stays inspectable in the commit log, whether or not its revision
rows do — inside the retained window a payload outlives rows the cut
deleted — and needs no flag of its own. Robin's review asks for the space-level counterpart, the equivalent of
a browser's broken-key icon: something developers can wave past and a user
of what looked like a safe space can see.

So the compaction commit carries one revision of its own: a whole-document
`set` of the space's ACL document (`of:<did>`, the one entity named by the
space's DID, which every client reads to join) — the document as it stands,
with a `compaction` member added beside `value` at the root — at `op_index`
0 of the compaction commit's seq. A `set` and not a `patch` because INV-12
(`09-invariants.md`) admits an ACL mutation only as a whole-document `set`,
the sole operation of its commit, with a value that still satisfies `isACL`;
the tool writes rows offline and no admission runs, but it keeps the shape
so that what every reader of the ACL document may assume — its head is
always a `set`, never a replay — stays true. The ACL document is never in a
compaction's selection, whatever the prefix flags say: its history is the
membership audit, and this revision is the one change compaction makes to
it.

```json
{
  "compaction": {
    "lastCommitSeq": 1494536,
    "compactedAt": "2026-10-09T18:00:00Z",
    "runs": [{ "commitSeq": 1494537, "documents": "computed:", "hollowed": 1307316 }]
  }
}
```

`lastCommitSeq` is the newest seq any hollowed or deleted row had; a reader
that wants history older than it knows to ask for the archive. The member is
a sibling of `value` rather than inside it because `value` is the ACL, with
its own schema and its own admission, and because the state inspector
classifies an entity by its top-level paths and can learn one more. The
shell's space header is where the icon belongs; that is a change for the
shell's owners and is [left open](#what-is-deliberately-left-open) here, with
the marker as the hook it hangs on. The compaction commit itself is the
second record, with the run's report as its `original`, for `cf inspect`.

### Rollback

The procedure never deletes the original: it is moved aside with its `-wal`
and `-shm` companions, and the result is installed under its name. Rolling
back is moving the result out and the original back, then starting the
instance. The commands are written down before the instance is stopped, as
the staging copy document requires. The backup is a second copy of the same
pre-compaction state should the original be damaged in the move.

### Rehearse on a clone first

Not optional. The sequence is: snapshot the production file, clone it on a
laptop (`cf space clone`), run `cf space compact` with the intended flags on
the clone's working database, run the verification above, serve the result
and do the acceptance checks. Only a flag set that passed on the clone is run
on the host, and the host run's dry-run report is compared with the clone's
before anything is written. [`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)
is the procedure for the clone itself, including why the server must be
stopped before `cf space reset`.

## 4. Where it lives

### The command

Two homes were considered. A `deno task` under `packages/memory` keeps the
tool beside the engine whose schema it rewrites, but a task needs a checkout
and `deno` on the machine that runs it, and the host runs a built binary. A
`cf space` subcommand is the operator's existing surface for a store file:
`clone`, `verify`, `reset` and `fingerprint` already take a path, already
carry the live-store rail, already serialize under `--json`, and `cf` ships as
a single built binary that can be copied to a host. `check-command-docs` then
requires the command be described in a live document, which is the
`packages/cli/README.md` section this plan's stage 5 writes.

So: **`cf space compact`** in `packages/cli/commands/space.ts`, over a module
`packages/memory/v2/compact.ts` exported as `./v2/compact` beside `./v2/dump`.
The module owns the algorithm and the report; it opens the store through the
engine's `open` so the schema it sees is the one the server writes and so
reconstruction is an engine export that returns the document at an exact
`(seq, op_index)`, considering only snapshots at a smaller seq (§1's option
(a) says why the existing read, which returns the state after a whole
commit, is not enough), and `encodeMemoryBoundary` for the materialized
value, as `maybeMaterializeSnapshot` encodes a snapshot. The
verification in §3 deliberately uses the inspector's replay instead, so the
two spellings check each other. The command is the first `cf space` member
that rewrites a store's rows rather than copying or restoring a file, and its
help text says so.

### Reaching the file

The tool takes the file path, not the space DID. The staging copy document is
explicit about why: the server composes the store path from two functions
that each append `engine-v3`, single-file mode composes them differently, and
"list the directory and use the neighbors as the authority" is the rule that
has not gone wrong. A `--space <did> --store <MEMORY_DIR>` form that composes
`resolveMemoryEngineStoreRootUrl` with `resolveSpaceStoreUrl` is cheap to add
later and is not in the first version. The backup's DID is read from the
`of:<did>` ACL document inside the file and printed, so the operator can
confirm the file is the space they meant.

### The Estuary recipe

What is known about the host, from [`staging-space-copy.md`](../development/staging-space-copy.md)
and the storm record: twenty-one systemd instances `toolshed-binary@8001`
through `8021`, all reading the store in `/opt/cf/releases/.env` (`MEMORY_DIR`,
`/data/memory` there, so the file is
`/data/memory/engine-v3/engine-v3/<did>.sqlite`); nginx routes a space's
websocket to one instance by a consistent hash of the space DID, and the
Topics space hashed to port 8020 in October; `deploy` owns `/data/memory` and
runs the services with passwordless sudo; team members reach the host as
themselves and read the space files, which are mode 644.

The steps, each a command the operator runs on the host unless noted. Before
step 2 the space's owner has agreed to the compaction and to the archive's
retention, since the history being removed is theirs
([what a user sees](#what-a-user-sees)):

```bash
# 0. Space, disk, and which instance owns it. The hash is nginx's; the storm
#    record says 8020, and /api/health/stats on that port names the space's
#    document cache. Do not trust the record; check.
df -h /data
ls -la /data/memory/engine-v3/engine-v3/ | grep '<did>'
curl -s localhost:8020/api/health/stats | grep -c '<did>'

# 1. Dry run against a LIVE snapshot, with the instance still serving, and
#    compare with the clone rehearsal's report. This snapshot is for the
#    numbers only; it is not the one that gets compacted.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.dry-run-<date>.sqlite'"
cf space compact '/data/replaced/<did>.dry-run-<date>.sqlite' \
  --documents computed: --dry-run

# 2. Stop the owning instance. The other twenty keep serving their spaces.
#    (sudo: the operator runs this.) Nothing writes the space from here on.
sudo systemctl stop toolshed-binary@8020

# 3. The authoritative backup, AFTER the stop: read-only, into a directory
#    with room, checksummed. This is the rollback, the archive, and the source.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.pre-compaction-<date>.sqlite'"
sha256sum '/data/replaced/<did>.pre-compaction-<date>.sqlite'

# 4. Compact a COPY of the backup — the backup itself is never written to —
#    and write the result beside it. The dry-run report printed first must
#    agree with step 1's up to the commits accepted between the two snapshots.
cp '/data/replaced/<did>.pre-compaction-<date>.sqlite' /data/replaced/<did>.work.sqlite
cf space compact /data/replaced/<did>.work.sqlite --documents computed: \
  --out '/data/replaced/<did>.compacted.sqlite'
rm /data/replaced/<did>.work.sqlite

# 5. Verify (§3, steps 1–6), on the host, against the post-stop backup.
cf space compact --verify '/data/replaced/<did>.compacted.sqlite' \
  --against '/data/replaced/<did>.pre-compaction-<date>.sqlite'

# 6. Swap. Move the live file ASIDE with its companions, never delete; install
#    the result owned by deploy. (sudo.)
cd /data/memory/engine-v3/engine-v3/
ls -la '<did>.sqlite'*
sudo mv '<did>.sqlite'* /data/replaced/
sudo install -o deploy -g deploy -m 644 '/data/replaced/<did>.compacted.sqlite' '<did>.sqlite'

# 7. Start, confirm, read back (§3, step 7). (sudo.)
sudo systemctl start toolshed-binary@8020
systemctl is-active toolshed-binary@8020
```

Only the owning instance is stopped: every instance can open every file, but
the hash sends the space's clients to one of them, and the storm record shows
that one at 95% CPU while its neighbors idled. Stopping all twenty-one, as the
staging recipe does for a store it treats as shared, is the conservative
choice if the hash cannot be confirmed. The window in which the space is down
is steps 2 through 7, and the backup that becomes the replacement is taken
inside it: a snapshot from before the stop would silently drop every commit
accepted between the two, and verifying against it would not show the gap.

Steps 2, 6 and 7 carry `sudo` and are the operator's to run by hand; the
desktop tooling refuses them even when authorized, and the recipe is written
so each is one line. The rehearsal on a clone is the same sequence without
steps 2, 6 and 7, with `cf space clone` standing in for the install and a
live snapshot standing in for the post-stop one.

## 5. What the server should do afterward

**Bound the base search by the newest snapshot (stage 1, done).**
`latestBaseAndSnapshot` queries the snapshot first and passes its seq as the
lower bound of `selectLatestBase` (`AND seq >= :floor`), so the walk stops at
the snapshot instead of at the last `set`; reconstruction, the commit-time
snapshot check and the schema-reference probe all go through it. This is what
makes a future storm cost the engine ten rows per read instead of its whole
history, and it is independent of compaction: it helps the uncompacted Topics
file from the deploy that carries it. A partial index on `revision (branch,
id, scope_key, seq) WHERE op IN ('set', 'delete')` would do the same at the
index level and needs a migration; the query bound needed none, and the index
is the follow-up only if the rehearsal says the bound is not enough.

**Answer a hollowed commit's resubmission faithfully (stage 8).** After
compaction a resubmitted commit whose payload was hollowed is refused as a
replay mismatch: safe, but the client reports an error for a write that
landed. The marker the tool writes carries a hash of the original bytes, so
the engine can learn to recognize it: a resubmission whose encoded bytes hash
to the marker's value is answered `replayed: true` at the stored seq with
every operation elided, exactly as a within-window replay is answered today.
This also puts the compaction on record inside the store: the `system` commit
the tool inserts is the compaction log, with the run's report as its
`original`, and `cf inspect` can read it to say "history before this commit
was compacted on <date>; the archive is <file>" rather than showing a
document that appears from nowhere.

**Distinguish a compacted basis from absence (stage 2, prerequisite).** I9
is the engine change that has to exist before any store is compacted: a
confirmed or pending read whose basis is older than an instance's oldest
surviving row, when that row points at a compaction commit, is `known:
false` to the identity proof. It is small — one lookup of the oldest row's
commit class, consulted only on the path that already found a conflict — and
it is the difference between a compacted store that refuses a stale write
and one that accepts it with every operation elided.

**Refuse a historical read below the cut explicitly (stage 8).** A
`read({seq})` below the cut returns absent today; it should name the
compaction commit instead, so `cf inspect value-at --seq` can say where the
history went. Hygiene rather than safety, and it belongs with the faithful
replay answer.

**Snapshot cadence: leave it.** The interval of ten bounds the replay to ten
rows and the retention of two bounds the snapshot table to two documents per
instance; the storm did not defeat either. A tighter interval would cost a
document encode per few patches on every hot document for no gain on the cost
that actually scaled. Materializing a `set` from the server side instead of a
snapshot is a semantic change — a `set` is a client write and a snapshot is
derived state — and is not proposed.

**Document cache entry cap: do not scale it with the space.** The cap of
65,536 sat full with millions of evictions, but evictions count superseded
revisions aging out as much as working-set overflow: every one of 671,434
rewrites inserted a new entry under a new key. A larger cap would have held
more dead revisions. The cap is five times the measured board working set
(about 13,300 documents) and is already configurable per host. What the
health endpoint lacks is the signal that would have named the storm in its
first hour — a per-space commit rate — and that alarm, with the scheduler
backoff for remote-echo loops the storm record names, are the guardrails
tracked on the storm's Topic, not this plan.

**Amend the storage spec.** §7.1 of `02-storage.md` says revisions are not
deleted during ordinary garbage collection, and that stays true. It gains one
paragraph: an operator may compact a space's revision history offline with
`cf space compact`, which keeps every head's address but the ACL
document's, materializes a base at the cut, and the compacted range is readable only from the archive the
operator took.

## What is deliberately left open

- **Session-scoped instances of dead sessions.** The September copy has
  672,073 head rows against 64,317 in August; the storm's writers created
  per-session instances that no sweep ever removes. Compaction shrinks their
  history but keeps every instance, because a resumed session may still read
  one. Collecting instances of sessions that will never resume is a different
  tool with a different question (when is a session dead?), and is not
  designed here.
- **Label history as audit trail.** A compacted document keeps its current
  labels and loses the record of which label each earlier revision carried.
  Whether that record has value under the CFC model is for the CFC review that
  [the retention plan](retention-and-provenance.md) is gated on; this plan
  keeps it in the archive and does not decide.
- **Tombstones.** Kept, for the `entity-absent` precondition (I5). Whether a
  tombstone older than any possible recreation attempt could go is a
  question about the precondition's contract, not about compaction.
- **Running on the live file in place** after the backup verifies, to save
  one copy's worth of disk. The design copies instead because the backup is
  the rollback and the archive, and a tool that writes to the file the server
  will reopen has one more way to go wrong than one that writes a new file.
  If `/data` cannot hold two copies, this is the fallback, and the backup's
  `integrity_check` must pass before the first write.
- **A `--space <did> --store <dir>` form** composing the storage-path
  functions, for operators who would rather not list a directory.
- **The user-visible icon.** The marker on the ACL document is the hook; the
  shell's space header (and Weaver's) showing it is the shell owners' change.
- **Whether a space's owner agrees to compaction at all.** Robin's point
  stands above every mechanism here: the log is a promise to the people in
  the space. The tool refuses nothing on that ground; the runbook requires the
  owner's agreement before step 2, and the marker makes the decision visible
  afterward.
- **Automatic compaction by the server.** Not proposed. The spec's retain-all
  default stands; compaction is an operator's decision about one space, with
  the owner's agreement, after a rehearsal.

## Stages

Each stage is a pull request; none has started. Two engine changes come
first: the base search, because it preserves history, helps the uncompacted
store on the day it ships, and is the measurement the compaction decision
should be made against; and the basis guard, because no store may be
compacted until the engine can tell compacted history from absence.

1. **The snapshot-bounded base search** — done (PR_PLACEHOLDER), measured on
   the August copy as the table above shows. What remains of this stage is
   the measurement on a clone of the current Topics file: cold board load and
   `transact` round trips before and after, on the uncompacted store. That is
   where the 180 ms claim is tested rather than inferred, and where the
   question "is compaction still needed for latency, or only for disk?" gets
   its answer; it needs a fresh snapshot from the host.
2. **The basis guard (I9).** `known: false` for a confirmed or pending read
   whose basis predates an instance's oldest surviving row when that row
   points at a compaction commit. Tests: the last two protocol cases of §3
   in all three variants — patch-headed, `set`-headed, bounded cut — against
   stores transformed by hand the way the tool will transform them, red
   before and green after; an uncompacted instance's genuine absence still
   proves identity as today.
3. **Dry run and report.** `packages/memory/v2/compact.ts` with the
   selection, the cut, and the report, read-only; `cf space compact --dry-run`
   over it. Exercised against the September Topics copy, whose numbers replace
   the estimates above. Tests: a store built with the engine, patched past the
   snapshot interval, reports the rows and bytes a hand count gives. Also
   the engine export the write path needs: reconstruction at an exact
   `(seq, op_index)` that ignores snapshots at that seq, tested on a
   multi-operation commit with and without such a snapshot.
4. **The write path.** The compaction commit with its per-run identity and
   its ACL-document marker, materialize, truncate, hollow (commit 1 exempt),
   `VACUUM INTO`, `--verify --against`. Tests: every head reads back identical
   through both the engine and the inspector's replay, with the ACL document
   checked as step 3 states; a confirmed read below the cut conflicts; all
   four protocol cases of §3, in every variant, against the tool's own
   output; the rows pointing at the compaction commit are exactly the
   re-attributed boundaries plus the ACL revision; under a bounded cut the
   rows above the boundary are byte-identical to the input's, and a boundary
   that falls between two operations of one commit on one document
   materializes the state after its own operation only, with and without a
   snapshot at that seq, so the reopened head reads back identical; the ACL revision is
   a whole-document `set` whose `value` satisfies `isACL` unchanged; a resubmitted commit inside the payload window is answered from
   its stored result; the genesis root and space kind read the same on the
   reopened result; the feed's view of the compaction commit is as I4 states;
   a store with a second branch is refused; a run interrupted after the first
   instance resumes to the same result as an uninterrupted one, with two
   compaction commits.
5. **Documentation and the spec amendment.** The `cf space compact` section
   of `packages/cli/README.md` (the command-docs gate requires it), the
   §7 paragraph in `02-storage.md`, the state inspector learning the
   `compaction` member and the compaction commit, and a runbook section in
   `staging-space-copy.md` or a sibling document carrying the Estuary recipe
   of §4 once it has been run.
6. **Rehearsal on a clone of the current Topics file**, with the same
   timings as stage 1 taken after compaction.
7. **The production run**, by the operator, from the rehearsed flag set, with
   the owner's agreement, only if stage 1's measurement leaves a reason
   beyond disk, or disk is the reason.
8. **Faithful replay of hollowed commits and explicit refusal of reads
   below the cut**, the two engine changes of §5.
