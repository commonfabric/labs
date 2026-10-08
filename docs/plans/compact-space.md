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
operation index exactly as they are, and delete every revision and snapshot
row behind it. Then delete the commit rows nothing references any more, except
a trailing window the server's replay detection still needs, and the
invocation and authorization rows those commits carried. The result is written
out with `VACUUM INTO` as a new file; the file that was compacted is never the
one the server was serving. The operator selects documents by id prefix and
bounds the cut by sequence, time, or a per-document count; a dry run reports
rows and bytes before anything is written. Every head keeps its address, so
nothing a client or the serving loop holds goes stale; what changes is that a
read older than the cut conflicts where it might once have been confirmed, and
history below the cut is read from the pre-compaction archive rather than the
live store. The tool is `cf space compact`, built on a module in
`packages/memory/v2` beside `dump.ts`, rehearsed on a clone first, and run on
Estuary against a copy while the instance that owns the space is stopped.

The server-side follow-up that matters most is not a cadence change: the
replay chain is already bounded at ten patches, but the engine's search for a
document's last `set` is not bounded by its newest snapshot, so a document
with a long patch-only history pays a scan over that whole history on every
cold read and on every commit that touches it. Bounding that search is a
code-only change and is what keeps a future storm from degrading the space it
hits, whether or not anyone compacts afterward.

## What exists (verified)

| Fact | Where |
| --- | --- |
| A space is one SQLite file. `commit` is the write log (`seq` primary key; `session_id` + `local_seq` unique; `original` holds the whole client commit, operations and reads; `resolution`; `class`). `revision` holds one row per operation on one document instance, keyed `(branch, id, scope_key, seq, op_index)`, with `op` in `set`, `patch`, `delete` and a foreign key to `commit`. `head` points at each instance's newest revision. `snapshot` holds a materialized document at a seq. `op_*` tables hold collaborative operation fields, with foreign keys to `commit`. `branch`, `execution_lease`, `scheduler_basis`, `execution_outbox`, `blob_store`, `invocation`, `authorization` complete the schema; patterns add their own tables through the SQLite builtin. | `packages/memory/v2/engine.ts`, the `INIT` statement |
| A read resolves the head row by joining `head` to `revision`, so a head whose revision row is missing reads as absent. A `set` decodes directly; a `patch` reconstructs from the newer of the last `set`/`delete` and the newest snapshot, replaying the patches after it. | `readStateForScopeKey`, `reconstructPatchedDocument` |
| The engine writes a snapshot when a document has accumulated `snapshotInterval` (10) patches since its base or newest snapshot, and keeps the newest `snapshotRetention` (2) per instance. So a replay chain is at most ten rows. | `maybeMaterializeSnapshot`, `DEFAULT_SNAPSHOT_INTERVAL` |
| Finding the base runs `selectLatestBase`, which walks the instance's revision index backward from the head until it finds a `set` or `delete`. The index does not cover `op`, and the query is not bounded below by the newest snapshot, so the walk visits every patch row since the last `set`. Both reconstruction and the commit-time snapshot check run it. | `SELECT_LATEST_BASE`, `latestMaterializationSeq` |
| A confirmed read is validated by scanning for a `set`/`delete` after its basis seq, then for an overlapping patch. A pending read whose basis the engine cannot reconstruct keeps the staleness refusal it arrived with. A resubmitted commit is recognized by `(session_id, local_seq)` and answered from its stored result. An `origin-committed` precondition looks up the origin commit by the same key. | `findConflictSeq`, the pending-read `basisOf`, `selectExistingCommit`, `selectPendingResolution` |
| A resumed session's catch-up is a full watch evaluation diffed against the holdings the client sent, not a replay of commits since a seq. The serving loop's commit feed reads from the seq its index scan ran against, in-process. | `server.ts` (`forceFullResync`), `selectCommitsSince` |
| The decoded-document cache keys an entry by the revision's address plus its `op` and data length, on the premise that the engine only appends revisions. The per-space bound is 128 MB and 65,536 entries; the Server bounds the total. | `documentCacheKey`, `DEFAULT_DOCUMENT_CACHE_*` |
| `VACUUM INTO` from a read-only connection is the sanctioned way to take a crash-consistent single-file copy of a live store. | `packages/memory/v2/dump.ts` |
| `cf space clone`, `verify`, `reset`, `fingerprint` and `cf inspect churn` are the rehearsal tooling; the state inspector reconstructs any entity at any seq with its own replay, independent of the engine's. | `packages/state-inspector/clone.ts`, `reconstruct.ts`; [`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md) |
| A production space is copied with `VACUUM INTO` on the host and installed by placing the file beside its neighbors while every instance is stopped; the recipe, the WAL trap and the rollback shape are written down. | [`staging-space-copy.md`](../development/staging-space-copy.md) |
| The storage spec says the revision log is append-only, is the audit trail, and is not deleted during ordinary garbage collection; retain-all is the default policy. Snapshots are the only sanctioned collection target. | [`memory-v2/02-storage.md`](../specs/memory-v2/02-storage.md) §7 |

Compaction is therefore a deliberate departure from the spec's retain-all
default, run by an operator and never by the server, and
[stage 3](#stages) amends §7 to say so.

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
770 MB; of the commits, 1,307,316 of 1,494,536 own no head row and would be
swept but for the retained tail. The history's weight is the commit log, not
the revision table, and dropping revision rows without their commits would
reclaim under a tenth of the file. That is why the design sweeps orphaned
commits, and why the dry-run report prices them.

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

**What a long tail costs a reader.** On the August copy, against its
longest-tailed document (head at seq 233251, a snapshot at the head seq, so
zero patches to replay):

| Query, as the engine issues it | Shell-timed, cold file |
| --- | ---: |
| process start, `SELECT 1` | 52 ms |
| `selectLatestBase`, unbounded (the engine's shape) | 91 ms, then 177 ms |
| the same bounded below by the newest snapshot's seq | 50 ms |
| head row lookup (`selectCurrentLocal`) | 100 ms |
| `selectSetDeleteConflict` from a basis at seq 1000 | 115 ms |
| the same from a recent basis | 60 ms |

Laptop numbers over a 3.5 GB file, noisy and not the server's cache state; the
finding they support is structural rather than numeric. Every cold read of a
patch-headed document, and every commit that touches it, walks that document's
whole patch history to find a `set` the snapshot has already made irrelevant,
and the walk fetches a table row per index entry because `op` is not in the
index. A document rewritten ten thousand times costs ten thousand row fetches
per read until something writes a `set` to it. Compaction writes that `set`;
[§5](#5-what-the-server-should-do-afterward) stops the walk at the snapshot
so the next storm never reaches this state.

The storm investigation's 180 ms per `transact` with no lock wait is
consistent with this walk running at commit time for each of the four or five
confirmed reads, on top of the conflict scans from old bases. The rehearsal in
[stage 4](#stages) measures it on the real file rather than inferring it.

## 1. What compaction means

### The invariants a compacted store must keep

Each is something a reader relies on today, with the code that relies on it.

- **I1 — every head keeps its `(seq, op_index)`.** Clients hold entity seqs in
  their holdings and confirm reads against them; the scheduler basis index
  records input seqs and decides dirtiness by comparing them with heads; the
  commit-class annotation of a frame resolves through the head's seq. Moving
  a head to a new seq would make every one of those stale at once and hand the
  serving loop a full re-derivation on activation — a storm to end a storm.
- **I2 — every head has its revision row**, because the head read is a join.
- **I3 — the first surviving row of every instance is a base**, a `set` or a
  `delete`, or a snapshot at or before it exists, because reconstruction
  starts from one or the other and otherwise starts from the empty document.
- **I4 — every surviving revision's commit row survives**, for the foreign key
  and for `commitClassOfSeq`, which the frame annotation reads.
- **I5 — tombstones survive.** An `entity-absent` precondition refuses when
  any `set` or `delete` exists for the id; dropping a `delete` row would let a
  deleted entity be recreated under its old id.
- **I6 — the recent commit tail survives**, so a session that resubmits a
  commit accepted just before the instance stopped is answered from the
  stored result rather than applied a second time (a doubled `increment` or
  `append`), and an `origin-committed` precondition still finds its origin.
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

### The options

**(a) Materialize-and-truncate.** For each instance in the selection whose
head is a `patch`, reconstruct the document at the head with the engine's own
replay and rewrite that row in place as `op = 'set'` with the encoded
document, at the same `(seq, op_index)`; update `head.op` to match. For every
selected instance, delete the revision rows ordered before the head and every
snapshot row (the `set` is now the base; a `set` head needs none). Then sweep
commit rows that no surviving revision or `op_*` row references and that fall
outside the retained tail, and the invocation and authorization rows no commit
references. Keeps I1 through I8.

What it gives up: time travel below each head, and the per-revision record
of which label a document carried at each earlier state, both of which move
to the archive file the operator takes first. A confirmed read with a basis
below the head now sees a `set` after its basis and conflicts, where before
it might have found only non-overlapping patches and been confirmed; the
client retries against fresh state, which is the safe direction. A
resubmitted compacted commit outside the retained tail is unknown to the
server and would be applied as new, which is what the tail (I6) is for.

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

The materialized `set` keeps the head's own commit row (I4), whose `original`
still describes the patch the row used to be. A client resubmitting that exact
commit within the tail is answered with the stored seq as before; the elision
report it would re-derive from the rows now sees a `set` where it wrote a
patch, which only affects the dirty-document classification of a replay and
is noted here rather than guarded against.

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
| `--keep-commits <duration>` | Commit rows created within this window of the newest commit are never swept, referenced or not (I6). | `24h` |
| `--dry-run` | Compute and report; write nothing. | off |
| `--json` | The report as JSON, per the `cf` JSON contract. | off |

`--before-seq`, `--before` and `--keep-last` combine as the most conservative
of what they allow: a row survives if any of them keeps it.

The dry-run report, printed before any write and by `--dry-run` alone:

- the selection: prefixes, scope kinds, the number of instances matched and
  how many have a `patch` head (those get rewritten);
- rows to delete from `revision` and `snapshot`, and their byte totals as
  stored (`length(data)`, `length(value)`);
- commit rows that become unreferenced, how many fall inside the retained
  tail and stay, and the bytes of `original` and `resolution` the rest carry;
- invocation and authorization rows that become unreferenced;
- the ten instances contributing the most rows, with their head seq and op;
- the compaction floor the run would record (the newest seq below which no
  deleted row remains), and the preconditions checked: one branch, no
  foreign-key violations, `op_*` rows referencing nothing swept.

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

**Batching and resumption.** Each instance is compacted in its own
transaction, and the commit sweep runs last in seq-ranged batches, so a run
interrupted anywhere leaves a store every reader can use and a second run
picks up where the first stopped: an instance whose head is already a `set`
with nothing behind it is a no-op. The sweep runs with foreign keys off, since
it deletes only rows nothing references, and the run ends with
`PRAGMA foreign_key_check` and `PRAGMA integrity_check` on the result. The
`op_integrated` and `op_checkpoint` tables index nothing on `commit_seq`, so
with foreign keys on, each deleted commit would scan them whole; on the Topics
store they are empty, and the tool checks that before choosing the fast path.

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

`VACUUM INTO` from a read-only connection, as `dump.ts` does, taken before
the instance is stopped or after, either is consistent. The backup is three
things at once: the rollback, the archive that keeps the history the live
store loses, and the source the tool reads. It is named for what it is,
`<did>.pre-compaction-<date>.sqlite`, checksummed, and kept until the
operator decides the history has no further audit value, which is a decision
for the space's owner rather than for the runbook. Disk needed on the host:
the backup (the current size), the result (the compacted size), and WAL
headroom for the run; `df -h /data` before starting, and the staging copy
document's note that `/tmp` has no room applies here too.

### Verification, in order

Each check fails differently and the order goes from cheap to expensive:

1. `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the result.
2. **Heads unchanged.** `SELECT branch, id, scope_key, seq, op_index FROM
   head ORDER BY 1, 2, 3` hashed on backup and result must match; the count
   of heads whose `op` changed from `patch` to `set` must equal the dry run's
   rewritten count. Every head must still join to a revision row.
3. **Every document reads back identical.** Reconstruct every selected
   instance at its head on both files with the state inspector's replay
   (`packages/state-inspector/reconstruct.ts`), which is a second
   implementation of the engine's rule, and compare canonical encodings. All
   of them, not a sample: it is offline and runs in minutes, and "every head
   identical" is the claim the operator wants to make. `--verify-sample <n>`
   exists for a quick pass during rehearsal.
4. `cf space fingerprint` on both files must agree. The fingerprint excludes
   generated cells, so it is necessary rather than sufficient, and it is
   cheap.
5. **The compaction floor is recorded** in the result and matches the dry run.
6. **Serve it.** Clone the result (`cf space clone --from <result>`), start a
   local toolshed on it with the workspace's port offset, open the Topics
   board cold, and read the board and a handful of topics through `cf`. The
   acceptance checks are the ones `space-clone-rehearsal.md` lists plus two
   for this tool: `/api/health/stats` for the space shows `patchReplays` not
   climbing on a cold board load, and `transact` round trips on a topic edit
   are below the storm's 180 ms.
7. On the host after install, the two checks `staging-space-copy.md` ends
   with: the space is listed, and a read through the API returns the content.

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
`packages/cli/README.md` section this plan's stage 3 writes.

So: **`cf space compact`** in `packages/cli/commands/space.ts`, over a module
`packages/memory/v2/compact.ts` exported as `./v2/compact` beside `./v2/dump`.
The module owns the algorithm and the report; it opens the store through the
engine's `open` so the schema it sees is the one the server writes and so
reconstruction is the engine's own `read` at head and `encodeMemoryBoundary`
for the materialized value, the same pair `maybeMaterializeSnapshot` uses. The
verification in §3 deliberately uses the inspector's replay instead, so the
two spellings check each other. The command is the first `cf space` member
that writes to a store, and its help text says so.

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

The steps, each a command the operator runs on the host unless noted:

```bash
# 0. Space, disk, and which instance owns it. The hash is nginx's; the storm
#    record says 8020, and /api/health/stats on that port names the space's
#    document cache. Do not trust the record; check.
df -h /data
ls -la /data/memory/engine-v3/engine-v3/ | grep '<did>'
curl -s localhost:8020/api/health/stats | grep -c '<did>'

# 1. Backup, read-only, into a directory with room. Checksum it.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.pre-compaction-<date>.sqlite'"
sha256sum '/data/replaced/<did>.pre-compaction-<date>.sqlite'

# 2. Dry run against the BACKUP, and compare with the clone rehearsal's report.
cf space compact '/data/replaced/<did>.pre-compaction-<date>.sqlite' \
  --documents computed: --dry-run

# 3. Stop the owning instance. The other twenty keep serving their spaces.
#    (sudo: the operator runs this.)
sudo systemctl stop toolshed-binary@8020

# 4. Compact a COPY of the backup — the backup itself is never written to —
#    and write the result beside it.
cp '/data/replaced/<did>.pre-compaction-<date>.sqlite' /data/replaced/<did>.work.sqlite
cf space compact /data/replaced/<did>.work.sqlite --documents computed: \
  --out '/data/replaced/<did>.compacted.sqlite'
rm /data/replaced/<did>.work.sqlite

# 5. Verify (§3, steps 1–5), on the host, against the backup.
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
choice if the hash cannot be confirmed; the dry run in step 2 does not need
the instance stopped, and step 4 can run while it is stopped or not, since it
reads the backup. The window in which the space is down is steps 3 through 7.

Steps 3, 6 and 7 carry `sudo` and are the operator's to run by hand; the
desktop tooling refuses them even when authorized, and the recipe is written
so each is one line. The rehearsal on a clone is the same sequence without
steps 3, 6 and 7, with `cf space clone` standing in for the install.

## 5. What the server should do afterward

**Bound the base search by the newest snapshot (recommended, code only).**
`reconstructPatchedDocument` and `latestMaterializationSeq` each query the
newest snapshot and the latest base independently and take the newer. Query
the snapshot first and pass its seq as a lower bound to `selectLatestBase`
(`AND seq >= :floor`), and the walk stops at the snapshot instead of at the
last `set`. The patch count check already runs from that newer seq. This is
the change that makes a future storm cost the engine ten rows per read
instead of its whole history, and it is independent of compaction: it helps
the uncompacted Topics file on the day it ships. A partial index on
`revision (branch, id, scope_key, seq) WHERE op IN ('set', 'delete')` would
do the same at the index level and needs a migration; the query bound needs
none, so it goes first, and the index is the follow-up if measurement on the
clone says the bound is not enough.

**Record the compaction floor; refuse historical reads below it
explicitly.** The tool writes a `compaction` table (floor seq, timestamp, the
flags, the counts) that the engine ignores today. A later engine change reads
it at open and treats a pending read's basis below the floor as `known:
false` and a `read({seq})` below it as an error naming the floor, rather than
returning "absent". Today both fail safe by accident — an unreconstructable
basis keeps its refusal, and nothing in production reads at an arbitrary
historical seq — so this is hygiene, and `cf inspect` is the reader that
benefits: it can say "history before seq N was compacted on <date>; the
archive is <file>" instead of showing an entity that appears from nowhere.

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
`cf space compact`, which keeps every head's address and materializes a base
at the cut, and the compacted range is readable only from the archive the
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
- **Automatic compaction by the server.** Not proposed. The spec's retain-all
  default stands; compaction is an operator's decision about one space, with
  the owner's agreement, after a rehearsal.

## Stages

Each stage is a pull request; none has started.

1. **Dry run and report.** `packages/memory/v2/compact.ts` with the
   selection, the cut, and the report, read-only; `cf space compact --dry-run`
   over it. Exercised against the September Topics copy, whose numbers replace
   the estimates above. Tests: a store built with the engine, patched past the
   snapshot interval, reports the rows and bytes a hand count gives.
2. **The write path.** Materialize, truncate, sweep, `VACUUM INTO`, the
   `compaction` table, `--verify --against`. Tests: every head reads back
   identical through both the engine and the inspector's replay; a confirmed
   read below the cut conflicts; a resubmitted commit inside the tail is
   answered from its stored result and one outside it is not found; a store
   with a second branch is refused; a run interrupted after the first
   instance resumes to the same result as an uninterrupted one.
3. **Documentation and the spec amendment.** The `cf space compact` section
   of `packages/cli/README.md` (the command-docs gate requires it), the
   §7 paragraph in `02-storage.md`, and a runbook section in
   `staging-space-copy.md` or a sibling document carrying the Estuary recipe
   of §4 once it has been run.
4. **Rehearsal on a clone of the current Topics file**, including the
   timing of a cold board load and of `transact` before and after, which is
   where the 180 ms claim is tested rather than inferred.
5. **The production run**, by the operator, from the rehearsed flag set.
6. **Server follow-ups**: the snapshot-bounded base search, measured on the
   clone from stage 4 before and after compaction; then the floor-aware
   pending-read and historical-read refusals.
