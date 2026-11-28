# 6. Branching

This section defines how branches provide isolated lines of development within a
Space. Branches enable speculative writes, feature development, and undo/redo
without affecting the main line of data.

## 6.1 Default Branch

Every Space has an implicit **default branch** with canonical branch name `""`
(empty string). It is the target for all operations that do not specify a branch
explicitly.

- The default branch is created automatically when the Space is initialized.
- It cannot be deleted.
- It has no parent branch and no fork point -- it is the root of all branch
  history.
- Clients MAY display this branch as `"main"` in UI, but protocol/storage use
  `""`.

```typescript
const DEFAULT_BRANCH = "";
```

---

## 6.2 Branch Data Model

A branch is a lightweight pointer into shared revision history. Branches do not
copy data -- they share the same commit/revision log and entity history as every
other branch in the Space. What differs between branches is their **head
table**: the mapping from entity id to the current visible revision for that
entity.

```typescript
interface Branch {
  name: BranchName; // Unique name within the space
  parentBranch: BranchName; // Branch this was forked from
  forkSeq: number; // Seq at which the fork occurred
  createdSeq: number; // First seq of the branch's own history: its forkSeq
  headSeq: number; // Latest seq at which this branch's visible state was updated
  createdAt: number; // Timestamp of branch creation
  status: "active" | "deleted"; // Soft-delete flag
}

type BranchName = string;
```

### 6.2.1 Head Table

Each branch has its own head table that maps entity ids to their current state
on that branch:

```typescript
// Shown at module scope.
// Conceptual schema for the branch-scoped head table
interface BranchHead {
  branch: BranchName;
  entityId: EntityId;
  seq: number; // Seq at which this head was set
  opIndex: number; // Operation index within that commit
}
```

At branch creation time, the new branch's head table is a logical copy of the
parent branch's head table at the fork seq. No physical copy occurs -- the
server resolves heads by checking the branch's own head table first, then
falling back to the parent branch's heads at the fork seq.

### 6.2.2 Storage Implications

Because branches share revision history:

- **Revision storage is append-only and shared.** A revision committed on branch
  A remains part of the shared history visible to point-in-time reads.
- **Branch creation is O(1).** No data is copied. Only a `Branch` metadata
  record is created.
- **Branch deletion is O(1).** The branch metadata is marked
  `status: "deleted"`. Revisions are not removed because they may be shared with
  other branches.

See `02-storage.md` for the physical table layouts that support this model.

---

## 6.3 Branch Creation

A new branch is created from an existing branch at a specific seq, by the
`branch.create` command (`04-protocol.md` section 4.3.8).

### 6.3.1 API

```typescript
// Shown at module scope.
interface BranchCreateRequest {
  name: BranchName; // No other branch of the space has had it
  parentBranch?: BranchName; // Default: default branch
  forkSeq?: number; // Default: headSeq of parentBranch
}

interface BranchCreateResult {
  serverSeq: number;
  branch: Branch; // As 6.11 reports it
}
```

### 6.3.2 Semantics

When `branch.create({ name, parentBranch, forkSeq })` is served:

1. **Resolve the parent branch.** If `parentBranch` is omitted, use the default
   branch. The parent must exist and be active.
2. **Resolve the fork seq.** If `forkSeq` is omitted, use the parent branch's
   current `headSeq`. Otherwise it must lie in the parent's history: at most
   the parent's `headSeq`, and for a parent other than the default branch at
   least the parent's `createdSeq`. It must not lie below the store's
   compaction floor (6.17.1).
3. **Check the name.** A name that holds a control character, or that begins
   with `view-demand:` or `view-support:`, is refused: the server keys a
   session's graphs and its sync cache by branch name, and such a name could
   stand for another branch's entry there. A name that begins with `history:`
   is reserved for a history fork, which a compaction run deletes when it
   finds one active (6.17.1); a branch meant to outlive a compaction is named
   otherwise. A name at most 128 characters long
   that no branch has had is taken by the new branch. A name an active branch
   has returns that branch unchanged when the request names the same parent
   and either the same fork seq or none, so a repeated request is harmless.
   Any other use of a taken name is refused, a deleted branch's name included:
   names are permanently consumed.
4. **Create the `Branch` record:**
   ```
   Branch {
     name: name,
     parentBranch: parentBranch,
     forkSeq: forkSeq,
     createdSeq: forkSeq,
     headSeq: forkSeq,
     createdAt: now(),
     status: "active"
   }
   ```
5. The new branch starts with the same entity heads as the parent branch at the
   fork seq. No head records are physically copied -- head resolution falls back
   to the parent (see 6.2.1).

Creating a branch takes no `seq` and records no commit-log entry: the branch
holds no state of its own until its first commit, which takes the space's next
`seq` as any commit does. A design that sequences branch creation and deletion
as write-class commands, each with a commit-log entry, a `localSeq` for replay
and a `createdSeq` of its own, is planned with the merge workflow (6.7).

### 6.3.3 Fork from a Fork

Branches can be created from other non-default branches. The `parentBranch`
field always points to the immediate parent, forming a tree of branches. Head
resolution follows the parent chain: a branch's effective head for an entity is
the first explicit head found walking from the branch up through its parent
chain to the fork points.

---

## 6.4 Writing to Branches

Commits always target a specific branch. The commit model defined in
`03-commit-model.md` applies identically to branches, with one key difference:
the head table is scoped to the target branch.

### 6.4.1 Commit Targeting

```typescript
// Shown at module scope.
type BranchCommit = ClientCommit & {
  branch?: BranchName; // Omit for default branch
};
```

### 6.4.2 Validation

Ordinary entity writes on branches use the same validation rule as any other
`ClientCommit`:

```
For each confirmed read in the commit:
  there MUST NOT exist a later visible overlapping write on
  (read.branch ?? commit.branch)
  whose seq is > read.seq
```

For normal branch writes, `read.branch` is omitted, so reads validate against
the target branch's visible state. What a branch inherits is part of that
state: a write its parent made after `read.seq` and at or before the fork seq
is a later visible write, and conflicts as one of the branch's own does. A
write the parent made after the fork seq is not visible on the branch and
conflicts with nothing there. A `patch` on a branch applies over the document
the branch holds, which for a document the branch has not yet written is the
one it inherits. Merge proposals are the special case: they
set `read.branch` explicitly for source/target/base observations. Two branches
can independently modify the same entity without conflict until a merge is
attempted.

### 6.4.3 Seq Assignment

All branches share the Space's global seq counter (Lamport clock). Every
commit advances the global seq. Branch creation takes no seq: it sets both
`createdSeq` and the initial `headSeq` to the fork seq (6.3.2). Thereafter,
entity-state writes (`/memory/transact`, including merge materialization)
advance `headSeq`, while branch deletion takes no seq and leaves `headSeq`
where it was. This ensures seqs are globally ordered across all branches,
which is essential for point-in-time queries.

```
branch.create("feature-x", forkSeq):
  branch["feature-x"].createdSeq = forkSeq
  branch["feature-x"].headSeq = forkSeq

entity-state commit on branch "feature-x":
  globalSeq++
  for each revision in commit:
    revision.seq = globalSeq
  branch["feature-x"].headSeq = globalSeq
```

---

## 6.5 Reading from Branches

Queries target a branch via the `branch` field in `QueryOptions` (see
`05-queries.md`). All query types -- simple, schema, point-in-time, and session
watch sets -- respect the branch scope.

### 6.5.1 Head Resolution

When reading an entity on a branch:

1. Check the branch's own head table for an explicit head entry.
2. If not found, check the parent branch's head table at the fork seq.
3. Recurse up the parent chain until a head is found or the default branch is
   reached.

```
resolveHead(branch, entityId):
  head = branch.heads[entityId]
  if head exists and head.seq <= branch.headSeq:
    return head
  if branch.parentBranch exists:
    // Only consider parent's state at or before the fork point
    return resolveHead(branch.parentBranch, entityId,
                       atSeq = branch.forkSeq)
  return null  // Entity does not exist
```

#### Head Resolution Caching

When a head is resolved by falling back to the parent branch, the resolved head
MAY be cached in the child branch's head table to avoid repeated parent lookups.
This cache entry is written lazily on first read, not eagerly at branch creation
time. Subsequent reads for the same entity on the same branch hit the cache
directly, turning a multi-hop parent chain walk into a single local lookup.

### 6.5.2 Watch Sets on Branches

Session watch sets can target a specific branch. The server sends sync when
entities on that branch change. Commits on other branches do not trigger sync
for a branch-scoped watch.

---

## 6.6 Branch Isolation

Writes to branch A are **invisible** to branch B until a merge is performed.
This isolation guarantee is fundamental and absolute:

- A query on branch B will never return revisions committed on branch A (unless
  they were committed on a common ancestor before both branches forked).
- A watch on branch B will never receive sync caused solely by commits on branch
  A.
- The only way for branch A's changes to become visible on branch B is through
  an explicit merge operation (6.7).

### 6.6.1 Shared History

While branches are isolated going forward from the fork point, they share all
history prior to the fork. Revisions committed before `forkSeq` are visible on
both the parent and child branch.

```
Timeline:
  v1 ---- v2 ---- v3 ---- v4 ---- v5      (default branch)
                    |
                    +--- v6 ---- v7          (feature branch, forked at v3)

- Query on default branch sees: v1..v5
- Query on feature branch sees: v1..v3, v6..v7
- v4 and v5 are invisible to the feature branch
- v6 and v7 are invisible to the default branch
```

---

## 6.7 Merging

Status note: sections 6.1-6.6 describe the branch-scoped visibility model that
the current rewrite relies on, and sections 6.9, 6.11 and 6.15-6.18 the branch
lifecycle, history and restore surface that is implemented. The merge material
in 6.7 and 6.8, the depth and materialization guidance in 6.13, and the diff
API in 6.14 are target-design guidance, not the current-pass acceptance bar.
Merge proposal generation, the conflict workflow, and long-lived branches a
serving loop runs remain deferred; see `10-implementation-guidance.md` and
`implementation-plan.md` for the current implementation authority.

Merging integrates changes from a source branch into a target branch. The merge
operates at the **entity level** -- each entity is considered independently.

### 6.7.1 Merge API

```typescript
// Shown at module scope.
interface MergeRequest {
  source: BranchName; // Branch to merge from
  target: BranchName; // Branch to merge into
}

interface MergeResult {
  status: "ready" | "conflict";
  proposal?: MergeProposal; // Client adds localSeq, then transacts
  merged?: number; // Number of entities to materialize
  conflicts?: BranchConflict[]; // Conflicting entities (on conflict)
  sourceSeq: number;
  baseBranch: BranchName;
  baseSeq: number;
}
```

### 6.7.2 Merge Algorithm

The merge compares each entity's state on source and target relative to their
**merge base** (nearest common ancestor in the branch tree).

```
merge(source, target):
  base = findMergeBase(source, target)
  baseSeq = base.seq
  conflicts = []
  fastForwards = []

  // Entities changed on source since merge base
  for each entity modified on source since baseSeq:
    sourceHead = resolveHead(source, entity)
    targetHead = resolveHead(target, entity)
    baseHead = resolveHeadAtSeq(base.branch, entity, baseSeq)

    if targetHead == baseHead:
      // Target unchanged since base -> adopt source change
      fastForwards.push({ entity, newHead: sourceHead })

    else if sourceHead == baseHead:
      // Source effectively unchanged since base
      // Nothing to do

    else:
      // Both changed since base -> conflict
      conflicts.push({
        entityId: entity,
        sourceValue: sourceHead.value,
        targetValue: targetHead.value,
        ancestorValue: baseHead.value
      })

  if conflicts.length > 0:
    return {
      status: "conflict",
      conflicts,
      sourceSeq: source.headSeq,
      baseBranch: base.branch,
      baseSeq,
    }

  proposal = buildMergeProposal(target, fastForwards, source, base)
  return {
    status: "ready",
    proposal,
    merged: fastForwards.length,
    sourceSeq: source.headSeq,
    baseBranch: base.branch,
    baseSeq,
  }
```

### 6.7.3 Fast-Forward

When only the source branch has modified an entity, the target branch
fast-forwards by materializing the source branch's visible state as an ordinary
write on the target branch at the merge seq. In the baseline implementation:

- If the source branch currently shows a live value, the merge transaction emits
  a `set` on the target branch with that value.
- If the source branch currently shows a tombstone, the merge transaction emits
  a `delete` on the target branch.

This keeps merge as a regular signed transaction, keeps point-in-time reads
simple, and avoids a separate "adopt existing fact" mutation path. Reusing
source facts directly can be added later as an optimization if needed.

### 6.7.4 CRDT Merge (Future Extension)

For entities that carry commutative, convergent data structures (CRDTs), the
merge algorithm could apply type-specific merge functions instead of reporting
conflicts. This would require schema annotations declaring an entity's merge
strategy (e.g., `"x-merge-strategy": "counter"` or
`"x-merge-strategy":
"lww-register"`). This extension is not part of the current
specification but is noted as a natural evolution of the merge system.

### 6.7.5 Merge Transaction

A successful merge is finalized by submitting a **normal transaction** on the
target branch. The merge API prepares a `MergeProposal`; the client adds its
next `localSeq` and submits the resulting `ClientCommit` via `/memory/transact`.

The prepared `MergeProposal` carries:

- `branch = target`
- `merge = { sourceBranch, sourceSeq, baseBranch, baseSeq }`
- Confirmed reads for the source/target/base heads used to compute the merge,
  with each read's optional `branch` field set explicitly to the branch where
  that observation was made
- `pending = []` because the proposal is computed against confirmed branch state
- One ordinary `set`/`delete` operation per merged entity

There are no special non-transaction commits for merge. The resulting commit is
signed, hashed, sequenced, stored, and replayed through the same path as any
other client transaction.

At apply time, the server re-validates those branch-scoped confirmed reads on
their original branches. This means the proposal becomes stale if the source
branch, target branch, or merge-base branch observation it depended on has
changed since the proposal was prepared.

Clients SHOULD request merge when they do not have outstanding local pending
writes on the source or target branch. If a caller needs to stack a merge on top
of local pending work, it must rebuild the proposal against that local state
before submission.

---

## 6.8 Conflict Resolution

When a merge detects conflicts (both branches modified the same entity), the
server returns the conflicts to the client for resolution.

### 6.8.1 Conflict Structure

```typescript
// Shown at module scope.
interface BranchConflict {
  entityId: EntityId;
  sourceValue: JSONValue | null; // Value on source branch (null = deleted)
  targetValue: JSONValue | null; // Value on target branch (null = deleted)
  ancestorValue: JSONValue | null; // Value at fork point (null = didn't exist)
  sourceSeq: number; // Seq of source's head revision
  targetSeq: number; // Seq of target's head revision
}
```

### 6.8.2 Resolution Protocol

To resolve conflicts, the client:

1. Inspects each `BranchConflict` to understand the divergence.
2. Decides on a resolution value for each conflicting entity.
3. Re-runs the merge with inline `resolutions`, or constructs the merge
   transaction directly.
4. Adds the next `localSeq` and submits the resulting `ClientCommit` on the
   **target branch**.

The resulting merge transaction materializes the remaining non-conflicting
source changes plus the explicit resolution values chosen for the conflicting
entities, all on the target branch.

Alternatively, the client can resolve all conflicts in a single step by
committing the resolutions and immediately retrying the merge with a flag:

```typescript
// Shown at module scope.
interface MergeRequest {
  source: BranchName;
  target: BranchName;
  resolutions?: Record<EntityId, JSONValue | null>; // Inline resolutions
}
```

When `resolutions` is provided, the merge folds those values into the generated
merge transaction so the final `/memory/transact` can resolve all conflicts
atomically.

### 6.8.3 Conflict Granularity

Conflicts are detected at the **entity level**, not at the field or line level.
If both branches modify the same entity, even if they modify different fields,
it is reported as a conflict. This is a deliberate simplicity trade-off:

- Entity-level conflicts are simple to reason about and implement.
- Field-level merge would require understanding the schema and patch semantics.
- Clients that want field-level merge can implement it in their resolution logic
  by diffing the ancestor, source, and target values.

---

## 6.9 Branch Deletion

Branches are soft-deleted. The branch metadata is marked as `status: "deleted"`,
but the branch record and its revision history remain.

A branch is deleted by the `branch.delete` command (`04-protocol.md` section
4.3.8). Like creation, deletion takes no `seq` and records no commit-log entry.

### 6.9.1 API

```typescript
// Shown at module scope.
interface BranchDeleteRequest {
  name: BranchName;
}

interface BranchDeleteResult {
  serverSeq: number;
}
```

### 6.9.2 Semantics

- The default branch cannot be deleted.
- A deleted branch cannot be written to or used as a merge target.
- Ordinary reads and point-in-time reads against a deleted branch remain valid
  for historical inspection and lineage traversal.
- A deleted branch MAY still be used as a merge source, because that is a
  read-only operation over preserved history.
- a watch set that references a deleted branch returns the current historical
  result as a finite snapshot and then produces no future sync for that branch,
  because the branch can no longer advance.
- Deleting a branch leaves its `headSeq` where it was.
- A session cannot be opened on a deleted branch (6.16).
- The branch name is permanently consumed -- a new branch with the same name
  cannot be created.
- Revisions committed on the branch remain in the shared revision history. They
  may be referenced by other branches or by point-in-time queries that target a
  seq before the deletion.
- Child branches (branches forked from the deleted branch) remain functional.
  Their `parentBranch` reference still points to the deleted branch, and head
  resolution still works because the deleted branch's head table is preserved.

---

## 6.10 Point-in-Time Reads on Branches

Point-in-time queries (see `05-queries.md` section 5.5) compose naturally with
branches:

```typescript
// Shown at module scope.
interface BranchPointInTimeQuery extends QueryOptions {
  branch: BranchName;
  atSeq: number;
}
```

### 6.10.1 Semantics

`queryGraph({ branch: "feature-x", atSeq: 42, subscribe: false })` reads the
state of the `feature-x` branch as it was at seq 42:

1. **Seq bounds**: `atSeq` must be within the branch's seq range.
   - For the default branch, any seq from 0 to `headSeq` is valid.
   - For a non-default branch, valid seqs are those in the range
     `[createdSeq, headSeq]`. A branch's `createdSeq` is its fork seq, and a
     query before it is invalid because the branch holds no state of its own
     there: that history is the parent's.
2. **Reconstruction**: the reconstruction algorithm from `05-queries.md` section
   5.5 applies, scoped to the branch. Only facts committed on the branch (or
   inherited from ancestors before fork) with seq <= `atSeq` are considered.
   Inherited parent facts are capped at `forkSeq` when reconstructing the
   branch's visible state, whatever the parent has committed since. Because
   merge results are materialized as ordinary target-branch writes, no extra
   merge-only read path is required.

### 6.10.2 Interaction with Merge Commits

After a merge, the target branch exposes the merged state starting at the merge
seq because the merge transaction wrote ordinary facts on the target branch at
that seq. A point-in-time query at a seq before the merge will not see those
facts; a query at or after the merge seq will.

---

## 6.11 Branch Listing

Clients can list all branches in a Space to discover available branches and
their metadata.

### 6.11.1 API

`branch.list` (`04-protocol.md` section 4.3.8) returns every branch of the
space, deleted ones included, since a deleted branch's name stays taken and its
history stays readable.

```typescript
// Shown at module scope.
interface BranchListResult {
  serverSeq: number;
  branches: BranchInfo[];
}

interface BranchInfo {
  name: BranchName;
  parentBranch: BranchName | null; // null for the default branch
  forkSeq: number | null; // null for the default branch
  createdSeq: number;
  headSeq: number;
  status: "active" | "deleted";
}
```

---

## 6.12 Use Cases

### 6.12.1 Feature Branches for Patterns

A pattern can create a branch to develop a new feature without affecting the
live data:

```
1. branch.create({ name: "draft-v2" })
2. commit({ branch: "draft-v2", operations: [...] })  // iterate on design
3. commit({ branch: "draft-v2", operations: [...] })  // more changes
4. proposal = merge({ source: "draft-v2", target: "main" })
5. commit({ localSeq: nextLocalSeq(), ...proposal })   // ship it
6. branch.delete({ name: "draft-v2" }) // clean up
```

### 6.12.2 Undo/Redo via Branching

Branches provide a natural undo mechanism. Before a risky operation, create a
branch:

```
1. branch.create({ name: "before-migration" }) // save point
2. commit({ operations: [... migration ...] })   // run migration on main
3. // If migration was wrong:
   merge({ source: "before-migration", target: "main" })  // revert
```

Or more precisely, read the pre-migration state from the branch and write it
back to main.

### 6.12.3 Speculative Execution

An LLM-driven pattern can use branches for speculative exploration:

```
1. branch.create({ name: "speculation-1" })
2. branch.create({ name: "speculation-2" })
3. // Run different strategies in parallel on each branch
4. // Evaluate results
5. // Merge the winning branch
6. merge({ source: "speculation-1", target: "main" })
7. branch.delete({ name: "speculation-1" })
8. branch.delete({ name: "speculation-2" })
```

### 6.12.4 Collaborative Editing

Multiple users can work on separate branches and merge their changes:

```
1. branch.create({ name: "alice-edits" })
2. branch.create({ name: "bob-edits" })
3. // Alice and Bob work independently
4. merge({ source: "alice-edits", target: "main" })    // Alice merges first
5. merge({ source: "bob-edits", target: "main" })      // Bob may hit conflicts
6. // Bob resolves conflicts, re-merges
```

---

## 6.13 Branch Depth and Performance

Head resolution walks the parent chain (see 6.5.1). When branches are created
from other branches (fork from a fork), the parent chain grows deeper. Deep
chains degrade read performance because each head lookup may require traversing
multiple parent branches before finding an explicit head entry.

### 6.13.1 Depth Limits

The server SHOULD limit branch depth to **8 levels**. The server MAY reject
branch creation requests that would exceed this depth with an error indicating
that the maximum branch depth has been reached.

### 6.13.2 Materialization (Rebasing)

As an alternative to hard depth limits, the server can periodically
**materialize** (snapshot) a branch's heads. Materialization copies all resolved
heads from parent branches into the branch's own head table, effectively
"rebasing" the branch and eliminating the need to walk the parent chain. After
materialization, head resolution for the branch is O(1) regardless of the
original chain depth.

Materialization is transparent to clients -- it does not change the logical
state of the branch, only its physical storage.

---

## 6.14 Branch Diff

The branch diff operation compares entity state between two branches, useful for
code-review-style workflows and pre-merge inspection.

### 6.14.1 API

```typescript
// Shown at module scope.
interface DiffRequest {
  source: BranchName;
  target: BranchName;
}

interface DiffResult {
  added: EntityId[]; // Entities on source but not target
  removed: EntityId[]; // Entities on target but not source
  modified: EntityId[]; // Entities changed on both
}
```

### 6.14.2 Semantics

The diff is computed relative to the common ancestor (fork point) of the two
branches. An entity is **added** if it exists on the source but not at the
common ancestor or on the target. An entity is **removed** if it exists on the
target but was deleted on the source. An entity is **modified** if both branches
have a different head for it compared to the ancestor.

---

## 6.15 Restoring a Branch

`branch.restore` (`04-protocol.md` section 4.3.8) sets the default branch back
to a state its own history holds. It is the restricted merge in which the
source wins every document: no three-way comparison and no conflicts.

The server serves a restore whose source is the default branch, at a
`sourceSeq` of its own history, and refuses one whose source is another
branch. The engine's `restoreBranch()` can compute a restore from any branch,
which is what the semantics below describe, but the server does not expose
it: a fork is computed by the client that opened it (6.16), so its documents
and their labels are that client's word, and copying them onto the default
branch would take a client's computation and labels at face value. Restoring
with the changes made in a fork is planned as a replay (6.15.5).

### 6.15.1 API

```typescript
// Shown at module scope.
interface BranchRestoreRequest {
  source?: BranchName; // Default: default branch
  sourceSeq?: number; // Default: headSeq of source
}

interface BranchRestoreResult {
  serverSeq: number;
  seq?: number; // The restoring commit, absent when nothing differed
}
```

### 6.15.2 Semantics

1. `sourceSeq` must lie in the source's history, as a point-in-time read's
   `atSeq` must (6.10.1), and not below the store's compaction floor
   (6.17.1). The source may be deleted.
2. The server finds the point where the two histories part: the common
   ancestor branch, at the lower of the seqs the two lineages reach on it.
   Only documents written on either side above that point can differ.
3. For each such document, in each scope instance it was written in, the
   server compares what the default branch holds now with what the source
   held at `sourceSeq`. Where they differ it emits a `set` of the source's
   document, or a `delete` where the source holds none. On a store whose
   stored bare-DID principals have been respelled as `User{subject}`
   (`MEMORY_RETIRE_BARE_DID_LABELS` in
   `docs/development/EXPERIMENTAL_OPTIONS.md`), the `set` carries the
   source's labels respelled the same way.
4. Those operations land as **one `system`-class commit** on the default
   branch, at the space's next `seq`. Its stored payload carries `merge`
   metadata naming the source branch and seq and the common base, which is how
   a history listing reports it as a restore (6.17).
5. When nothing differs the server writes nothing and returns no `seq`.

A restore adds to the default branch's history and removes nothing from it:
the state it replaced stays readable at its seq, and a later restore to that
seq brings it back.

### 6.15.3 What a Restore Leaves Alone

- **The access list.** Who may read and write a space is not part of the state
  a point of its history restores.
- **Session-scoped instances.** The sessions they belonged to are gone.
- **The invitation ledger's revision document** (`of:space-invites-revision`).
  It follows the invitation service's ledger, which belongs to no branch and
  which a restore does not touch
  ([invitation service contract](../../../runtime/toolshed/README.md#space-invitations)).
- **A serving loop's records** of its own progress through the branch's
  commits: the event logs (`of:stream-events:` documents), the watermark, and
  the effect and attention indexes. Those describe what has happened on the
  branch, which a restore adds to and does not undo. An event the loop has
  delivered stays delivered, though the restore sets back what its handler
  wrote.
- **SQLite databases** a pattern keeps beside its documents. They are not
  stored as revisions, so no point of history holds an earlier state of one.

### 6.15.4 Collaborative Fields

A document the restore sets may hold a collaborative field some session is
editing. The restore ends the field's epoch, as a `delete` of the document
would, and writes the restored value. An editor finds the field inactive on
its next query and starts a new epoch from the restored value.

### 6.15.5 Restoring from a Fork (Planned)

This section is a pending plan, not current behavior.

A restore that keeps what was done in a fork is done by **replay**. The
default branch is restored to the fork's fork point, and the events sent in
the fork are then played back on top of it, so that the space's own
computation (its serving loop, under server execution) produces the resulting
state. Nothing a client computed or labeled in the fork is copied.

A web component's direct commit becomes an event as part of this work, so
that everything a fork holds back is an event and a replay has one kind of
thing to play.

A fork can then stay in the client's speculative execution phase. Under
server execution a client then sends only events, so a fork holds those back
instead of sending them, and a restore replays them.

A replay is held to what the fork showed in three ways:

- **Effects reuse the fork's results.** An effect that reaches outside the
  space, such as a fetch or a language-model call, stores its result keyed by
  its request. A replay finds the result the fork stored for the same request
  and sends nothing; a request the fork never made is sent.
- **The clock and random seeds are the event's.** A replayed event runs with
  the clock reading and the seeds its first run had, so a handler that reads
  either computes what it computed in the fork.
- **The replayed result is what is shown.** Where a replay still computes
  something other than the fork did, the space holds the replay's result,
  and the shell shows that result rather than the fork's.

Branches a serving loop runs are then needed only for long-lived branches and
merging, which stay as planned in 6.7.

---

## 6.16 Sessions of a Branch

A session is opened on one branch: `SessionDescriptor.branch`
(`04-protocol.md` section 4.1.2), absent for the default branch. Every
`transact`, `graph.query`, `op.query`, watch spec and `history.list` the
session sends without naming a branch reads and writes the session's branch,
so a client that knows nothing of branches runs a space as the branch holds
it. A view interest (`views` on `session.watch.set`) names no branch on the
wire, and is of the session's branch as well. A message that names a branch,
the default branch's empty name included, is served on the branch it names.

- The branch must exist and be active when the session opens; an open on any
  other is refused, except as the next rule says.
- An open carrying `SessionDescriptor.forkBranch` asks the server to make the
  branch where the space has no branch of that name. When the opening
  principal may write to the space (WRITE), the server forks the branch from
  the default branch's head, as a `branch.create` naming no parent and no
  `forkSeq` does (6.3.2), and opens the session on it. When the principal may
  not write, the server makes no branch and opens the session on the default
  branch, where that principal can change nothing. A session resumed after
  the server opened it on the default branch stays there, whatever its
  principal may do by then. The name is held to the rules a `branch.create`
  holds one to (6.3.2), and an open naming a branch those rules refuse is
  refused. A branch
  that exists and is active is used as it is, whoever opens it. A deleted
  branch is not made again: its name is consumed (6.9), and the open is
  refused. This is how a runtime showing a fork of one space keeps what it
  writes to every other space on a branch of that space.
- A commit on a branch other than the default cannot carry a `sqlite`
  operation. A pattern's SQLite database is one file per space and scope, no
  branch holding a copy of it, so the write would land in the space itself.
  A `sqlite.query` from a session of a branch is served, and reads the
  database as it stands.
- The server serves `entity-id.list`, `entity-id.exists`, `pattern.lifecycle`,
  `event.attention.resolve` and `served` on the default branch alone, and
  refuses each from a session of another branch with a `ProtocolError`.
- A session keeps its branch for life. A resume declaring another is refused,
  since the session's replica holds one branch's documents.
- A session of a branch other than the default is never client demand
  (`docs/specs/server-side-execution/serving-loop.md` section 1), and a
  commit on such a branch is not reported to the space's serving loop. No
  serving loop runs a branch: the runtime that opens one computes what the
  branch stores itself, and commits it as `authored`-class writes.

---

## 6.17 History Listing

`history.list` (`04-protocol.md` section 4.3.8) returns the commits of a
branch's history without the documents they wrote, newest first: the branch's
own commits, then those it inherits from each ancestor up to the fork point.

```typescript
// Shown at module scope.
interface HistoryListRequest {
  branch?: BranchName; // Default: the session's branch
  before?: number; // Only commits below this seq
  limit?: number; // At most 500, which is also the default
}

interface CommitSummary {
  seq: number;
  branch: BranchName; // The branch the commit landed on
  class: "authored" | "derived" | "system";
  createdAt: string; // ISO 8601, UTC
  actingPrincipal?: string;
  principal?: string; // Who made the commit: actingPrincipal, else its session's
  events: number; // Events the commit appended to streams
  consequenceOf?: string[]; // Event ids, on a derived commit
  derivedThrough?: number; // The watermark, on a derived commit
  restored?: { branch: BranchName; seq: number }; // On a restore
  writes: number; // Documents the commit wrote
}
```

A commit is reported as a restore only when it is a `system` commit whose
payload carries `merge` metadata (6.15.2); the same metadata on a commit of
another class reports none. A commit whose payload compaction emptied
(`docs/plans/compact-space.md`) reports no events and no restore.

### 6.17.1 The Compaction Floor

Compaction deletes revisions below a cut it chooses per document, and leaves
the commit rows. A point of history below a compaction can therefore hold a
document as absent that the space held then. The seq of the newest commit a
compaction inserted is the store's **compaction floor**, and history below it
is closed: `history.list` leaves its commits out, and `branch.create` and
`branch.restore` refuse a fork point or a source seq below it. A store never
compacted has a floor of 0.

---

## 6.18 Collaborative Fields on Branches

A collaborative field's epoch, cursor and operation log
(`docs/features/collaborative-fields.md`) are a branch's own. A fork inherits
a field's **value**, which the document holds, and none of its epoch: on the
fork the field is inactive until an editor there starts an epoch from the
inherited value. Edits on the fork and on its parent then proceed
independently, each under its own cursors.
