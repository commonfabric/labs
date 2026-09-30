# Mergeable collection writes (operation-based append, add-unique, increment, remove-by-value)

> For how a patch operation is put together across the codebase — the registries
> that define each op once and how to add a new one — see
> [patch-operations.md](./patch-operations.md). This note covers *why* the
> mergeable ops exist. For how to change an existing handler over to them, and
> the mistakes that make a migration look finished while it is not, see
> [migrating-collection-writes.md](./migrating-collection-writes.md).

## The problem

The runtime is local-first and optimistic. A handler write applies to local
state immediately, commits to the server in the background, and is rolled back
("reverted") if the server rejects it. The server rejects a commit when one of
the commit's recorded reads is stale: a revision newer than the read's basis
sequence has touched the same entity (and, for `patch` revisions, an overlapping
path).

`Cell.push` was implemented as a read-modify-write of the whole array. It read
the entire array value, appended the new elements, and handed the whole combined
array to the diff machinery. The commit op was then reconstructed by diffing the
working array against the transaction's base snapshot. This has three
consequences that block scaling under write contention:

1. **Disjoint appends conflict.** Two sessions appending to the same list each
   record a read of the whole array. Whichever commits second has a read whose
   basis predates the first append, so the server rejects it even though the two
   appends touch different tail slots.

2. **Append is O(N).** The commit carries (a reconstruction of) the whole array
   rather than just the appended elements.

3. **Stale-base appends are silently lost or clobber.** During space
   rehydration a handler can run before the list's durable value has
   materialized in that session's replica. `push` then reads the list as empty
   (or shorter than it durably is) and computes its write against that empty
   base. The reconstructed op is either a whole-array `set` (clobbering the
   durable tail) or a positional splice computed against the wrong base; and
   because the recorded read basis can equal the current head, the optimistic
   "retry on conflict" safety net does not always fire. The append is lost
   durably. This is the symptom that motivated the work: with three profiles
   created while the home space is still rehydrating, the durable count of the
   home `profiles` list ends at one. Making the append mergeable is necessary but
   not sufficient to close that particular bug — the *Residual* section at the
   end of this note describes what this change does and does not fix, and the
   evidence for it.

The root cause is that the append's *intent* ("add these elements at the tail,
wherever the durable tail is") is discarded and then reconstructed from a
value diff against a base that may be wrong.

## The approach

Carry the append intent through the transaction so the commit emits a
tail-relative, mergeable operation instead of a reconstructed whole-array diff.

An append commits as a dedicated `append` patch op (`{ op: "append", path,
values }`), except from a transaction that emits whole documents (below). On
the server this op inserts its elements at the array's *live* tail, creating
the array (and the path to it) if it is absent. Because the
position is resolved on the server against durable state, the op is correct
regardless of what the committing session had loaded locally — empty, short, or
up to date.

An append does not record a conflicting read of the array. The push reads the
array only to build the optimistic local value and to anchor entity ids on new
elements; it does not depend on the existing contents. So the array read is
excluded from the commit's conflict read set. Two appends therefore never
conflict with each other, and an append never conflicts with a concurrent edit
to existing elements. The optimistic write still reverts as a unit if the commit
fails for an unrelated reason.

### Why a dedicated `append` op rather than a positional splice or a `set`

The diff machinery already emits a tail `splice` when the working array is
longer than the base (`buildArrayPatchCandidates`). That positional splice is
not enough on its own: its index is computed against the (possibly stale) base,
so against a stale-short base it inserts in the wrong place, and against an
absent base the op falls back to a whole-array `set` that clobbers. A
tail-relative `append` carries no index — the server appends at the durable tail
— and folds the absent-base case into the same op (create then append) instead
of a clobbering `set`.

A dedicated op kind (rather than a flag on `splice`) cannot represent an invalid
state: it has no vestigial index or remove count that must be ignored or
constrained. It also forces every `switch (op.op)` site — op application and the
conflict-touched-path and scheduler-dirty-path maps — to handle `append`
explicitly rather than silently inheriting `splice`'s behavior, which the type
checker enforces. Its touched path is exactly the array
path, the same as `splice`, so reader-invalidation and scheduler-dirty semantics
are unchanged. The set-add and counter-increment ops noted under Scope will be
new op kinds in the same family.

### Why excluding the read is safe

An unconditional append commutes with any other change to the array: with
appends from other writers (each lands at its own tail slot) and with edits to
existing elements (those slots are untouched by an append). So a pure append has
no read dependency on the array, and dropping the array read from the conflict
set loses no necessary safety.

The limitation: an append whose decision depends on the current contents — for
example "append only if the list has fewer than N elements" — cannot both merge
and stay correct. Its read is *kept* in the conflict set (the narrowing below
drops only the op's own incidental reads, and the array's `length` child is
explicitly kept), so a concurrent append makes the commit conflict and retry
rather than merge — correct, but at the cost of the mergeability the op exists
for. See the *Read-set builder* and *Conditional pushes stay protected* sections
for exactly which reads are kept. `Cell.push` is unconditional, so it merges.

## Mechanics

The same machinery carries three mergeable ops. `append` is described below;
`add-unique` and `increment` follow the same shape (see *The op family*).

- **`PatchOp` (`packages/memory/v2.ts`)** — a new `{ op: "append"; path; values }`
  variant. It carries only the array path and the elements to append.

- **`appendAtPath` (`packages/memory/v2/patch.ts`)** — thaws (and creates, if
  missing) the array at `path` and pushes `values` at the tail; `applyPatch`'s
  `append` case calls it. This one place covers the server's commit-time
  materialization, a peer client replaying the revision, and the writer's own
  optimistic pending replay. The two engine touched-path maps each gain an
  `append` case that returns the array path, the same as `splice`.

- **Transaction (`packages/runner/src/storage/v2-transaction.ts`)** —
  `recordMergeableOp(address, { op: "append", count })` records, per document and
  path, a mergeable intent (`mergeableOps` on the writable entry). At commit:
  - The op builder emits an `append` op for each recorded array path whose
    recorded tail still describes the local value (see "Mixed ops on one path
    fall back to the whole-array diff" below for when it does not). With a
    base present, only `count` tail elements are the append; with the array
    absent from the base (a fresh or not-yet-loaded entity) the whole working
    array is the append, so a stale-empty base does not drop locally created
    prefix elements such as schema defaults.
  - It suppresses only the diff candidates the append replaces: the whole-array
    op at the append path, and element candidates in the appended tail (index at
    or past the append start). Edits to existing (pre-append) elements and
    unrelated sibling/ancestor candidates are kept, so a transaction that both
    edits an element and pushes keeps both changes.
  - When the base is absent — where the diff would otherwise fall back to a
    clobbering `set` — the append op is emitted instead.
  - `getMergeableOpAddresses()` exposes the recorded addresses so the commit's
    read-set builder can drop the op's incidental reads.

- **Read-set builder (`packages/runner/src/storage/v2.ts`)** — `buildReads`
  drops, on a mergeable-op entity, only the reads the op issues *as part of
  itself*: the read the op's `Cell` method marks as its own (`mergeableOpRead`),
  a read marked as an attempted write, the `["cfc"]` write-policy label, and any
  strict descendant of an op path (the link-resolution sub-reads the write makes
  beneath the value). The one strict descendant that is *not* dropped is the
  array's own `length` child (`[...opPath, "length"]`): a read of it is the
  handler depending on the element count, which a mergeable append / add-unique /
  remove-by-value changes, and the op itself never reads `length`. So a push
  whose new element's index, id, or position came from the length conflicts
  against a concurrent append instead of merging with a stale index. This is
  precise: the `length` read conflicts with a change to the element count, not
  with an edit to an existing element (whose path is a different descendant and
  leaves the length unchanged). The carve-out rescues the length reads recorded
  *only* at this child path — a `for...of`/spread over the array (the proxy
  iterator reads `[...opPath, "length"]`) and a `key("length")` read. The other
  ways to observe the count read the whole array and are already kept: a bare
  `.length` on the query-result proxy, `.get()`, and the read-only array methods
  (`.map`/`.filter`/`.some`/…) all record a *recursive* read AT the op path,
  which is the handler's explicit read (below).

  Key enumeration and index probing are a stronger case than the length: an array
  here can be **sparse** (holes below `length`), and filling or punching a hole
  changes the present-key set with no `length` write (a write at `[...opPath, i]`
  only). `Object.keys`/`values`/`entries`/spread/`for...in` (the `ownKeys` trap)
  and `n in arr` (the `has` trap) observe that present-key set, so a length read
  — or a nonRecursive shape read at the array path, which the engine does not
  conflict against a same-length element-slot write — would miss a concurrent
  hole edit and let an enumeration-derived push merge on a stale key set. Those
  two traps instead record a **recursive** read of the array, the one kept read a
  hole edit invalidates, marked `ignoreReadForScheduling` so it adds only the
  conflict dependency (reactivity stays on the nonRecursive shape read). It is
  gated to arrays, so object enumeration keeps the shape-only conflict granularity
  of the conflict-granularity work. The carve-out applies to every
  mergeable op: a length read before an `addUnique` or `removeByValue` likewise
  conflicts with a concurrent count-changing op, so a transaction that
  gratuitously reads the length forfeits that op's distinct-element merge — the
  same tradeoff as any explicit read kept in the conflict set. A handler's *own*
  explicit `.get()` of the list is not
  marked, so it is kept — which is what makes a conditional push or keyed write
  still conflict-and-retry (see "Danger" below). This is narrower than the
  earlier path-level exclusion, which dropped any read overlapping the array path
  including the handler's. This drop sits alongside the conflict-granularity work
  (`docs/specs/memory-v2/08-conflict-granularity.md`), which separately keeps a
  read marked `excludeReadFromConflict` (an `asCell` reference resolution) and a
  runtime-internal read of a document's `["cfc"]` envelope out of the conflict
  set; the three exclusions are independent `continue`s in the same loop. The
  `["cfc"]` one is not scoped to a mergeable-op entity, which is what lets a
  label derivation consult a collection another session is appending to.

- **Engine touched paths (`packages/memory/v2/engine.ts`)** — each op reports its
  array path (like `splice`) in both `touchedPathsForPatch` (which the
  nonRecursive/shape matcher uses, retaining the parent injection) and
  `touchedLeafPathsForPatch` (the leaf-only matcher the conflict check and the
  scheduler reader-dirty index use). Because the ops act on the whole array path,
  not on an element index, they are compatible with the leaf-only matcher's
  invariant — array element insert/remove must reach the engine as an array-path
  op, never an indexed `add`/`remove`/`move` (`assertNoIndexedArrayStructuralOps`
  guards this). So a reader of the list is invalidated by an op, while the op's
  own (dropped) read keeps two ops from conflicting with each other — the
  array-membership analog of the conflict-granularity fix for distinct-key
  writers to a container.

  That invalidation is where a collection's contention goes once its writes
  merge. A reader that recomputes and stores a value derived from the whole
  list commits a compare-and-set over the list, so concurrent appends refuse
  it. Measured on the `convergence-chat` fixtures, two sessions posting twenty
  messages apiece cost nothing at all in the four variants with no derived
  reader and thirty-four refused commits in the one that has them, every
  refusal being the derivation's own. The cost falls on every session holding
  the derivation, including one that never writes, and it tracks how many
  sessions write at once rather than how many writes there are: the same forty
  posts cost nothing from a single session. It is also erratic where the write
  side is not — five identical runs of the deriving variant gave 7, 39, 2, 12
  and 9 — so a test can usefully require which documents a refused commit
  contended for, and cannot usefully bound a count of rolled-back writes.
  `docs/history/features/derived-reader-contention-2026-09-04.md` records the
  runs.

### The op family

`add-unique`, `increment`, and `remove-by-value` reuse every part of the above —
the intent record, the op-builder, the read-set drop, the engine touched-path
switch cases — differing only in the op they emit and how it applies:

- **`add-unique`** (`{ op: "add-unique"; path; values }`, `addUniqueAtPath`) —
  appends each value only if no existing element equals it by stored-value
  content equality (`valueEqual`), creating the array if absent.
  `Cell.addUnique(...)` does the same dedup locally (against its
  possibly-incomplete view) and records the count it added; the server re-dedups
  against durable state. Suppression is identical to
  `append` (the added elements are at the tail). A `Cell` argument dedups by its
  link rather than by value (see below), so re-adding the same entity writes
  nothing. It still reads: the dedup resolves every element's link, and with
  nothing left to add the call returns before recording its op, so neither that
  read nor the array read is dropped from the commit's conflict set. See "What a
  keyed operation reads besides the record it writes" in
  `keyed-collection-writes.md`.

- **`increment`** (`{ op: "increment"; path; by }`, `incrementAtPath`) — adds
  `by` (which may be negative) to the number at `path`. A missing value implies a
  zero default: the increment treats it as 0 and creates the path, so a counter
  need not be initialized before its first increment. `Cell.increment(by?)`
  records the summed delta. A zero amount is an error, rejected at
  `Cell.increment` and at the op (so `increment(0)` surfaces a mistake rather
  than committing a no-op); two non-zero increments that sum to zero are a no-op
  the op builder drops, not an error. Suppression drops the scalar replace the
  diff would emit at the value path; the read of the current number is dropped
  from conflict detection, so concurrent increments sum instead of conflicting.

- **`remove-by-value`** (`{ op: "remove-by-value"; path; value }`,
  `removeByValueAtPath`) — removes every element of the array at `path` that
  equals `value` by stored-value content equality (`valueEqual`); absent or
  non-array is a no-op. `Cell.removeByValue(ref)` matches by link when `ref` is a
  `Cell` and by value otherwise, filters the matches locally, and records one op
  per removed element, carrying the element's stored representation so the server
  matches the durable element exactly. Because it identifies what to remove by
  value rather than by position, concurrent removes of distinct entries merge
  instead of clobbering through a whole-array rewrite. Suppression drops the
  whole subtree at the array path that the local positional removal produced,
  which makes the op the commit's only carrier for that array — so it is emitted
  only when it fully accounts for the local value (see the removal-check bullet
  below).

`add-unique` and `remove-by-value` compare by stored-value content equality. For
an element that is a separate entity, that stored value is a link, so the
comparison is by same-target — identity, not deep content.
`Cell.addUnique`/`removeByValue`
accept either a plain value (compared by content) or a `Cell` (compared by its
link); passing the cell returned by `elementById` is how a handler adds or
removes a keyed element by identity (see `keyed-collection-writes.md`). Because a
missing value is a zero default, `increment` is always zero-based: a counter
whose displayed starting value should be non-zero must be `set` to that value
first, since the op carries only the delta.

- **Call sites** — `Cell.push` (`packages/runner/src/cell.ts`) calls
  `recordMergeableOp` with an `append` delta after writing the combined array, so
  id anchoring, cross-space link elements, and CFC write-policy recording
  continue to run through the existing `diffAndUpdate` path unchanged.

## Semantics and limitations

- **Add-wins across whole-entity writes.** Because an append carries no
  conflict-generating read of its entity and the server resolves it at the live
  tail (creating the array if absent), an append merges on top of a concurrent
  whole-entity `set` and is applied even after a `delete` — which recreates the
  list from the appended elements. This is the intended robustness against the
  rehydration race, at the cost of "delete then concurrent stale append"
  resurrecting the list rather than the append being rejected.

- **Append order is server-arrival order.** Concurrent appends from different
  sessions land in the order the server applies their commits, not a globally
  predetermined order. Code must not assume a specific interleaving of
  independently-issued appends.

- **Mixed ops on one path fall back to the whole-array diff.** A tail-relative
  intent can only carry the change it recorded. When one transaction records more
  than one kind of mergeable op at the same array path (an `addUnique` and a
  `push`, a `removeByValue` and an `addUnique` — the "remove the old value, add
  the new" idiom), or reshapes the array with an in-place mutator after a push
  (`sort`, `reverse`, `splice`, `unshift`, `fill`), the recorded tail no longer
  identifies what the op should carry. The path is *poisoned*: its mergeable
  intent is dropped and the commit emits the whole-array diff, which reflects the
  correct combined local value. That transaction's write to that path forfeits
  merge-friendliness (it commits as a value diff, so it can false-conflict under
  contention) rather than being silently corrupted. Read that as a description of
  the poisoned path, not as a closed-class guarantee for every op: what makes it
  hold is the list of commit-time checks below, each of which had to be found.
  The rule is that every whole-value write poisons the ops it
  covers, so the sites to keep in step are every path that performs one:
  `Cell.set` and `Cell.setRawUntyped`. Plus `recordMergeableOp` itself, on a
  second, different op kind at one path. `poisonMergeableOp` is what they all call, and
  it acts on every intent at *or beneath* the path written — a
  write to an enclosing object (`doc.set({rows})`) reshapes the array inside it
  just as surely as a write to the array itself — and on nothing above it. So a
  same-kind repeat (two `push`es, two `increment`s) still folds into one op, an
  element edit (`cell.key(i).set(...)`, which writes *beneath* the array and
  carries no intent of its own) still composes with a push, and a write to a
  sibling field leaves the push mergeable.

  Reaching descendants is what catches the sequence the length check below
  cannot: a `push`, an ancestor reshape, then a second `push`. The two pushes
  sum to a `count` that spans the reshape, so the recorded tail lands back on
  the base length while covering an element the reshape supplied rather than one
  an op appended.

- **A reshape the surviving diff cannot express falls back too.** The poison
  sites all fire at the moment of the write, so they see only a reshape that
  lands *after* an op was recorded. A reshape that lands *before* the op —
  `rows.set([])` and then `addUnique`, the clear-and-reseed idiom — is invisible
  to them. The tail op's builder therefore re-checks, at commit, the invariant
  its suppression rests on.

  The suppression drops the whole-array candidate at the op's path outright,
  plus every element candidate at or past the tail start. What is left to carry
  the prefix is only the diff's *per-index* candidates — so the op is honest
  only while the diff actually decomposes the prefix that way.
  `buildArrayPatchCandidates` gives up and emits a whole-array replacement in
  three situations, and each one abandons the op instead:

  1. **the prefix changed length** — the base array's length no longer equals
     the tail start, `max(0, working.length - count)`. This is what keeps a
     clear-and-reseed honest: a tail op cannot express "and remove everything
     that was here", and its suppression covers the very candidates that would
     have carried the removal, so without the check the store keeps the old
     elements and appends the new ones on top — a silently doubled list, with
     the writing session's own local value showing the correct one.
  2. **the prefix's hole layout changed** — a hole punched or filled without a
     length change. Presence is not expressible per index, and sparse arrays are
     preserved elsewhere in the runner, so this must not be flattened away.
  3. **the payload is sparse.** Unlike the other two this needs no base to
     compare against, and must be checked whether or not one exists: the payload
     is `array.slice(start)` either way, and with no base that slice is the whole
     working array — so a hole anywhere in a freshly created sparse array is a
     hole in the payload. The wire op rebuilds its payload elementwise and cannot
     carry one.

  Abandoning is the same fallback the poison sites produce, decided at commit
  rather than at the write.

  A *dense* same-length replacement (`rows.set(["x","y","z"])` and then a
  `push`) does *not* need the fallback and keeps its op: it diffs into per-index
  candidates below the tail, which survive the suppression and commit alongside
  the append. Value changes are fine; length and presence changes are not.

  Abandoning at build time drops the intent from the transaction rather than
  merely skipping the op: a live intent still narrows reads out of the commit's
  conflict set (see below) on behalf of an op that is no longer being sent, and
  the whole-value diff replacing it is entitled to those reads.
  `buildMergeableOps` deletes and poisons the path, and it runs inside
  `getNativeCommit`, ahead of the narrowing, so both sides see the same intents.

  In every case reachable today the reshaping write also leaves an unmarked read
  at the path, which keeps it in the conflict set regardless — so the delete is
  belt and braces rather than a demonstrated behavior change, and no test
  asserts a conflict outcome that depends on it. It is kept because the
  guarantee should not rest on that coincidence: nothing obliges a reshape to
  read what it overwrites.

- **A whole-document transaction abandons every intent it holds.** A
  transaction marked `markWholeDocumentWrites` — or `markAuthoritativeWrites`,
  which implies it — emits each written document as a whole-document `set` or
  `delete` and sends no mergeable op at all, so the same rule applies to all of
  them at once: `getNativeCommit` deletes and poisons every recorded path
  before the narrowing runs. Here the reads are not belt and braces. The
  whole-document write is the value the run computed from what it read, so an
  intent left standing would drop a real dependency.

  Two marks reach this. The client speculation overlay's seal takes it because
  an entry's operations are layered above a confirmed value that moves under
  them, and its read set is what the entry's retirement floor is built from
  (`docs/specs/server-side-execution/speculation.md` §1). Effect-completion
  writebacks under the serving posture take it through
  `markAuthoritativeWrites`, and they can hold an intent — llm-dialog's marked
  update pushes onto the message list. Their commit carries `basisSeq` of NOW
  and does not export its read set, so what changes there is which local
  dependencies the transaction registers, not what the server arbitrates.

- **A `removeByValue` that does not account for the whole local array falls back
  too.** Its suppression is `subtree: true` — the array path and everything under
  it — so unlike a tail op it leaves *nothing* to carry the array, not even the
  per-index candidates. That is a stronger claim, and it is checked against the
  whole value rather than a prefix: applying the recorded removals to the base
  array (every occurrence of each value, exactly as the store applies the wire
  op) must reproduce the working array. The comparison is `valueEqual`, so hole
  layout counts too. Anything else the transaction changed on that array breaks
  the equality and abandons the intent, and the whole-array diff commits the
  local value instead.

  Two ordinary shapes need it, and neither is caught earlier. An element edit —
  the "edit one row and delete another in the same handler" shape — writes
  *beneath* the array and so deliberately does not poison the intent, yet the
  subtree suppression discards its per-index candidate; a tail op survives that
  composition, a removal cannot. And a whole-value `set` landing *before* the
  removal (at this path or at a parent) has no intent to poison yet. In both
  cases the store would otherwise apply the removals to an untouched base and
  drop everything else, while the writing session's own value shows the change.

  A transaction that creates the array and removes from it in one go has no base
  array to check against, and abandons for that reason: the removals say nothing
  about the elements the transaction created, so with the diff suppressed the
  entity would never be written at all.

  A removal that is the transaction's only change to the array — including
  alongside a write to a *sibling* field, which is not that array — reproduces
  the working array exactly and keeps its op, so concurrent removals of distinct
  entries still merge.

- **An op inside another op's payload falls back.** A tail op's payload is
  `array.slice(tailStart)` — live values lifted out of the working document at
  commit — so it carries whatever those elements contain, however deep. Push a
  new inner list onto an outer list and then push into that inner list, and the
  outer append's payload already holds the inner list *including* the element the
  inner append would add: the store applies the outer op, then the inner op adds
  its element a second time. Each array is individually dense and its own length
  arithmetic individually consistent, so none of the checks above sees it — they
  each judge one intent against the base, and this is a relationship *between*
  two intents.

  So an intent whose path lies inside another op's payload is abandoned, and the
  containing op carries the combined value — its suppression already covers the
  region, so the diff candidates the abandoned intent leaves behind are dropped
  with it. The *contained* intent is the one abandoned: the containing op is the
  one that can still carry both changes, and keeping it is what preserves the
  outer list's merge-friendliness. Containment is judged on what each intent
  recorded, not on which ops survived, so an intent inside an op that is itself
  abandoned falls back with it and the whole-value diff is the only thing
  carrying that region.

  Only the tail ops carry live values this way. An `increment` sends a number and
  a `removeByValue` sends the elements it removes, so neither contains another
  intent's target, and a nested push landing *before* the outer tail
  (`outer.key(0).push(...)` alongside `outer.push(...)`) is in no payload and
  stays mergeable. `mergeableOpPayloadContains` is where an op declares what its
  payload holds; `buildMergeableOps` is where the sibling intents on one document
  are compared, since no single builder can see them.

## Conditional pushes stay protected: the read-set narrowing

A `push` whose correctness depends on first reading the list — the most common
shape being dedup-then-push,

```ts
// Shown for illustration only.
if (!users.get().some((u) => u.name === name)) users.push(newUser);
```

— is the case the read-set narrowing exists to get right. A naive read-drop that
removed every read whose path overlaps the array would break it: it would drop
the `.some(...)` uniqueness check along with the op's own read, so two clients
adding the same name at the same moment would each read the list without the
other's entry, both pass the check, and both append, with no conflict to force a
retry.

The implemented drop is narrower than that. It removes only the reads the op
*itself* issues — the list value it reads to build the write (marked
`mergeableOpRead`), the link-resolution and element sub-reads strictly beneath
the array path, the shape-only container read a view of the array records, and
the `["cfc"]` policy label — and keeps a *recursive* read at the array path
that the op did not make, which is the handler's own explicit `.get()`/`.some()`.
So a handler that reads the list and then `push`es still records that read: two
concurrent conditional appends conflict, the loser retries, sees the winner's
entry, and bails, while an unconditional `push` (no explicit read) stays fully
mergeable. This is the narrowing described under the read-set builder above. The
lunch poll's `addUser`
([participant-identity-card.tsx](../../packages/patterns/lunch-poll/participant-identity-card.tsx))
is a deliberate read-then-push that relies on it.

The narrowing keys on the read's path, and does not care which layer issued the
read. Runtime machinery that runs during a commit is bound by the same rule as
handler code. A recursive read at a document's root depends on every path in
that document, so a concurrent write anywhere in it — including the mergeable
append the commit is carrying — invalidates that read and conflicts the commit.
A runtime pass that needs one member of a document reads that member's own path
instead. The CFC label envelope at `["cfc"]` and the schema meta at
`["schema"]` are each read at their own path, so each depends on that member
alone and a concurrent append to the document's value leaves it undisturbed.

Two further responses make the keyed case cheaper and catch misuse (see
`keyed-collection-writes.md`):

- **Address the membership by identity (implemented).** A uniqueness condition is
  expressible as "add this entity, deduped by its identity": give the element a
  deterministic address with `elementById`, then `addUnique` it. The dedup is by
  link, so concurrent adds of the same key resolve to one entity on the server,
  with no retry — and concurrent adds of *different* keys merge. This replaces the
  read-then-`some()`-then-push shape for the keyed case, avoiding the retry the
  narrowing would otherwise force. Other content-dependent conditions (not a
  uniqueness check — for example "append only if the list has fewer than N
  elements") are not generally mergeable and keep a read-modify-write `set`/`push`,
  which the narrowing above keeps safe.

- **Catch misuse at build time (implemented).** The transformer's capability
  analysis already tracks per-handler reads and the mergeable write methods. The
  `MergeablePushValidationTransformer`
  ([packages/ts-transformers/src/transformers/mergeable-push-validation.ts](../../packages/ts-transformers/src/transformers/mergeable-push-validation.ts))
  runs that analysis over each handler, finds a handler that both reads a
  collection (an explicit `.get()` or an iteration) and mergeable-`push`es to
  the same collection path, and classifies how the read relates to the push
  ([packages/ts-transformers/src/policy/mergeable-push-classification.ts](../../packages/ts-transformers/src/policy/mergeable-push-classification.ts)).
  A push that *depends* on the read — through a guard (the dedup-then-push
  shape: an enclosing condition or an earlier early-return derived from the
  read) or through the pushed value — gets the diagnostic
  (`mergeable-push:read-then-push`) pointing at the identity-addressed
  `elementById` + `addUnique` for a uniqueness condition, or at a
  read-modify-write `set` for other content-dependent appends. A read that
  instead feeds an *independent* write to the same collection — for example
  appending an entry and then trimming the list to a maximum length — still
  costs the append its mergeability, so the same diagnostic fires with the
  matching remedy: keep the independent read-modify-write in its own handler so
  the append stays mergeable. A read related to neither the push nor another
  write of the collection is not reported — the append forfeits merging, but
  there is usually no better expression to point at, so warning would be noise.
  Read influence is tracked by name through variable initializers, assignments,
  and loop bindings, without scope analysis: over-approximation only promotes a
  site to the dependent-push diagnosis (the diagnosis every flagged site got
  before classification), while a missed influence demotes toward the softer
  message or silence, never toward a wrong remedy. It is a warning, not an
  error: the kept read keeps every flagged shape safe today (it forces the
  conflict-and-retry), so the check nudges toward the better expression without
  failing the build. A bare push with no read of that path, or a read of a
  different path, is left alone. The analysis exposes the classified findings
  through an optional `mergeablePushMisuseSink`; the read-vs-push correlation
  lives next to the read/write classification in `capability-analysis.ts`. The
  lunch poll's `addUser` read-then-push is the worked example the dependent-push
  warning fires on: its push is both dedup-guarded and built from the read.

## Scope

Four mergeable ops are implemented: tail append (`Cell.push`), set-add
(`Cell.addUnique`), numeric increment (`Cell.increment`), and remove-by-value
(`Cell.removeByValue`). Together with `elementById` for deterministic element
addressing, these cover the keyed-collection mutations (insert-if-new, set my
value, edit a record's field, delete a record) — see `keyed-collection-writes.md`.
The lunch poll is migrated to them as the worked example. Patterns still using a
read-modify-write `set` for these shapes — a dedup-then-push for a set, a
`set(get() + 1)` for a counter, a `set(filter(...))` to delete — can adopt the
mergeable methods to stop false-conflicting and clobbering under contention; the
favorites, spaces, MRU, and pin lists on the owner-protected home space are the
highest-value remaining candidates.

### Home-space migration outcome

The favorites and spaces lists on the home space are migrated, both to the
keyed `elementById` form. A favorite is addressed by its piece's identity, and a
space by its name; adding sets the keyed entity and `addUnique`s it, and removing
is `removeByValue` of the same entity. The whole-value `addUnique(value)` and
`removeByValue(value)` do not apply to either list, because a list element that
is an object is stored as a link to a separate entity: two objects that are equal
by content are still distinct entities, so a value comparison never matches, an
`addUnique` of an equal object never dedups, and a `removeByValue` of an equal
object never removes. Addressing the element by a deterministic key and matching
by that link is the form that works — the same form the lunch poll uses for its
votes and options.

Pattern code cannot read a cell's link, so a favorite's key is derived by the
client that adds or removes it (the client holds the piece's address as strings)
and passed in as event data. The handler stores that key on the entry, so the
in-app remove button can address the same entity without introspecting the piece
cell. A space's key is the space name, which the handler already has from the
event.

The profile most-recently-used list stays a read-modify-write `set`. Its write
is not a set-membership change: it moves an entry to the front of the list and
caps the length, so its correctness depends on reading the current order and
count. That is a condition other than
uniqueness, which the mergeable ops do not preserve: `addUnique` appends at the
tail and never reorders, and there is no mergeable "keep only the first N". A
concurrent pair of most-recently-used stamps conflicts and one retries, which
only reorders a recency heuristic, so the read-modify-write is acceptable here.

The profile pinned-elements list is owner-protected by a `writeAuthorizedBy`
claim on its container. A mergeable op is authorized by that claim the same way a
whole-value `set` is: the authorization runs over the transaction's write log and
the schema write-policy inputs, and the mergeable ops record those inputs exactly
as `set` does, so migrating the list would not weaken the owner-write protection.
A test in `packages/runner/test/profile-owner-cfc.test.ts` confirms this — an
authorized writer's `addUnique` and `removeByValue` on an owner-protected list
commit, and an unauthorized writer's are rejected. The list is left unmigrated
for two other reasons. A pin is addressed by its element cell's identity rather
than a scalar key, so a keyed migration needs an addressing scheme the entries do
not yet carry — unlike a space, which is keyed by its name, or a favorite, which
is keyed by its piece's identity. And a keyed removal takes on the
add-wins-after-delete ordering, so a pin removed while a stale add is in flight
would reappear, which is a semantic change worth weighing for an owner-protected
list.

## Residual: profile-append-during-rehydration (closed by stale-basis retry windowing)

This work was motivated by profile creates being lost when issued while the home
space is rehydrating. The mergeable-append mechanism here is necessary for that
case: it fixes the part where a stale or empty base produced a clobbering or
position-wrong op. It was not sufficient on its own. A second failure remained on
the cross-space, multi-space commit path. That failure is described and closed
below.

A profile create is a multi-space commit. The handler pushes a freshly-created
`ProfileHome.inSpace()` onto the home `profiles` list, so a single transaction
both appends to the home space and writes the new profile's own space. A
multi-space commit runs one per-space commit in order — the child space first,
then the home space — with no rollback. During the reload storm the home-space
commit fails repeatedly with transient errors: a stale read, or a same-replica
race as rehydration applies revisions to the local replica concurrently with the
commit. The child space, committed first, is already durable, so the new
profile exists in its own space; but the home-space append keeps failing.

The event-handler commit path retried these failures, but a transient error that
is not a `ConflictError` consumed the handler's fixed retry budget (five
attempts). Once the budget was exhausted the commit hit the give-up disposition,
which drops the write. The mergeable append — add-wins, commutative, and unable
to truly conflict — was dropped along with it. The durable result is a profile
whose `ProfileHome` exists but which is absent from the home list, so the durable
count of `profiles` ends at one.

The fix routes the storm's stale-basis inconsistency through the windowed-retry
path a `ConflictError` already used, rather than the fixed budget. A
`StorageTransactionInconsistent` is a same-basis race: a value the transaction
read changed on this replica between the read and the commit, which re-running
against fresh state resolves, so it is windowed like a conflict and lands once
the storm clears. The mergeable append commutes, so retrying it is always safe.
Windowing applies to every `StorageTransactionInconsistent`, whether or not the
commit carries a mergeable op — an earlier version scoped it to mergeable-op
commits, but a stale basis converges by re-running regardless, and the receipt
machinery keeps the re-run from double-applying, so the gate was unnecessary.
For a child-first cross-space result, the canonical handler result/receipt stays
in the final home commit while only the actual child node materializes in the
child space. A partial child commit therefore cannot masquerade as the terminal
receipt and strand the retry. A stale retry reuses the deterministic child
identity and may update that orphan child phase, while the create-only handler
result commits atomically with the home-space effects. This fixes the lost home
append, but it is not cross-space atomicity: simultaneous runtimes can still
stage competing child values before one wins the parent receipt. A durable
per-event/per-child-space phase protocol remains the stronger follow-up recorded
in the scheduler-v2 spec.

A non-stale-basis rejection — an authorization failure, a malformed store op,
or a transport error — is not windowed: re-running cannot resolve it, so it
drops on the first attempt rather than burning the window. A stale basis that
cannot converge within the retry window surfaces a loud `CommitConvergenceError`
instead of silently dropping the append. See `classifyCommitDisposition` in
`packages/runner/src/scheduler/events.ts`, and the regression test
`packages/runner/test/mergeable-append-multispace-conflict.test.ts`, which injects
a stale-basis inconsistency storm on the home-space commit of a multi-space
mergeable append and asserts the append survives durably, alongside a companion
case that asserts a non-stale-basis rejection fails fast.
