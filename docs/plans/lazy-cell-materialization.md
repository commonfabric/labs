# Lazy, schema-observing cell materialization

Status: built end to end and on by default behind `lazyMaterialization`. What
remains is removing the flag and the eager path for lift arguments; handler
materialization is settled under Stage 5.

Switch retirement is optional work for the flag owner. The separate
[lazy materialization fast-follow](lazy-materialization-fast-follow.md) owns
default-on measurements and guidance and can complete without retirement. This
document retains the view and snapshot design and its implementation record.

`Cell.get()` materializes everything its schema selects, in one pass, before the
reader touches any of it. A lift declaring a list of a thousand entries gets a
thousand entries built, link-resolved, defaulted, back-to-cell annotated and
registered as reactive dependencies — even when its body reads `list.length` and
returns.

This plan makes that materialization lazy. A reader gets a proxy that resolves
each path when it is touched, narrowing the schema as it descends and refusing
the read when the data no longer matches. A transaction can be flipped into a
mode where every cell read hands back such a proxy; the runner flips it for the
transaction that runs a lift, and treats a schema refusal as it treats an
argument that did not resolve.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all of its child checks pass. Keep
this plan updated in the same commits as the implementation. When the final
stage lands, archive it under `docs/history/plans/` following
[`../README.md`](../README.md).

## What the runtime does today

Four mechanisms carry the current behavior. The design below reuses all four.

**Eager, schema-driven materialization.** `Cell.get()`
([`cell.ts`](../../packages/runner/src/cell.ts)) calls `validateAndTransform`
([`schema.ts`](../../packages/runner/src/schema.ts)), which reads the whole
document value in one shot and hands it to `SchemaObjectTraverser`
([`traverse.ts`](../../packages/runner/src/traverse.ts)). The traverser walks
the _data's_ own properties and, for each one, narrows the schema by that key.
Properties the schema does not select are skipped without descent, via the
`emptyProperties` / `missingProperty` marker schemas that make
`TransformObjectCreator.addOptionalProperty` a no-op. So schema-on-read already
prunes. What it does not do is defer: everything the schema _does_ select is
built.

**A schema-less lazy proxy.** `createQueryResultProxy`
([`query-result-proxy.ts`](../../packages/runner/src/query-result-proxy.ts)) is
the existing lazy view. It resolves links per access, records container reads as
non-recursive shape reads (`SHAPE_READ`) and value reads as recursive, wraps
array methods, and exposes `toCell`. It is reached from two places:
`Cell.getAsQueryResult()`, and `validateAndTransform` itself — at the root and
again per subtree, in `TransformObjectCreator.createObject` — whenever the
effective schema is absent or `true`. It observes no schema, so it cannot apply
defaults, cannot mint `Cell`s for `asCell` fields, and cannot tell a reader that
the data has stopped matching.

**Schema narrowing already exists.** `ContextualFlowControl.schemaAtPath`
([`cfc.ts`](../../packages/runner/src/cfc.ts)) narrows a schema by a path,
resolves `$ref`, and caches per interned schema. That is the narrowing a view
applies to an ordinary container child. It does not decide a combinator: the
view defers `anyOf`, `oneOf` and `allOf` to the eager traverser at the position
where they are accessed, because whether a branch matches is a question about
the whole branch. `canBranchMatch`, in `traverse.ts`, stays a shallow prefilter
on the eager path — type check plus required-key presence, no descent — and
nothing in the view is decided by it.

**The "argument did not resolve" path.** `readJavaScriptArgument`
([`runner.ts`](../../packages/runner/src/runner.ts)) computes `isValidArgument`
as `argument !== undefined`. When it is false the action skips the body, writes
an undefined result through the ordinary result path, and logs at info level —
the run is a non-event, not a failure. This is the disposition a schema refusal
should reuse.

Two boundaries worth naming because they bound the win:

- **Loading is unaffected.** The query selector that decides which documents the
  server ships is the cell's own schema, taken in `syncCell`
  ([`v2.ts`](../../packages/runner/src/storage/v2.ts)), independent of `.get()`.
  Laziness saves local traversal, allocation, freezing, and reactive read
  registration. It does not, by itself, save network. Narrowing the sync
  selector to what a reader touches is a separate, later piece of work.
- **Lifts run in-process.** `invokeJavaScriptImplementation` calls
  `fn(argument)` directly, with no serialization boundary, so a proxy reaches
  the body intact.

## The model

A **lazy view** is a proxy over a `(link, schema)` pair. Creating one costs a
single non-recursive read of the container at `link`. Reading a property `p`:

1. Narrows the schema: `schemaAtPath(schema, [p])`, with the same
   `emptyProperties` / `missingProperty` markers the traverser uses, so a
   property the schema does not select is absent from the view rather than
   present and raw.
2. Resolves links at the child path, combining the link's own schema into the
   narrowed one, exactly as `validateAndTransform` does.
3. Dispatches on the narrowed schema: `asCell` / `asStream` mints a `Cell`; an
   absent or `true` schema hands back today's schema-less query-result proxy; a
   scalar returns the value; a container returns another lazy view.
4. Applies the schema `default` when the slot is absent.
5. Registers the read on the transaction before returning — including the read
   that fails.

Point 5 is load-bearing and not incidental. A refusal must leave behind the
dependency that will re-trigger the reader when the missing data arrives. The
existing read path already records the activity before it inspects the value
([`v2-transaction.ts`](../../packages/runner/src/storage/v2-transaction.ts)), so
a read of an absent path registers; the lazy view must make sure it issues that
read rather than short-circuiting on the container's key set.

It binds every way of answering "nothing is there", not just the refusal. A key
the container does not hold, and a value replaced by the schema's `default`,
both have to register the read they are standing in for: the entry point takes
the value without telling the scheduler, so a view that answers from the schema
and returns registers nothing, and the reader goes on reading its default however
late the value arrives. Each is one line, and each was missing once.

Point 2 is the other one worth stating plainly, because a view meets it in a
place an eager read does not. Eager traversal walks THROUGH a link and settles
the crossing's schema by reader precedence as it goes
(`combineOptionalSchema`); a view re-enters `validateAndTransform` per
property, so the entry point has to do that settling itself. Handing the view the link's schema alone loses whatever
the reader asked for that the link's own schema does not name — a `title` read
off a piece typed by its registration reads as a property the schema does not
select, and the reader gets `undefined` for data that is right there.

### What the view promises

**Root guard, then touch-scoped.** At materialization the view validates the
root container only: its type, the presence of its `required` keys, and the
immediate JSON type of each required key where the schema states a scalar type.
That is one non-recursive shape read — the read the view takes anyway. If the
root guard fails, `.get()` returns `undefined`, exactly as today, and the
runner's existing `isValidArgument` gate handles it with no new machinery.

Below the root, every check happens where the reader touches. Reading a
container validates that container's `required` keys; reading a leaf validates
its type; reading a property the schema excludes yields `undefined`.

**A mismatch surfaces at the nearest enclosing property, and only a `required`
one refuses.** An eager read leaves a property whose traversal fails out of the
object it belongs to and carries on; the object collapses only when the property
that failed was `required`. A view answers the same way: the failure travels up
to the property that owns it, and there it either reads as `undefined` or, if
the schema requires that property, refuses on past it. Refusing an optional
property instead would stop a reader the eager path runs, and a field waiting on
a computed that has not produced yet is the ordinary case rather than a fault.
The read that failed is registered either way, so the reader comes back when the
data arrives.

For ordinary containers, a mismatch in an untouched child does not stop the
reader. Validation follows demand, with whole-subtree decisions made at the
boundaries below. A reader that touches broken data still refuses unless the
schema permits an omitted property or a fallback.

**Combinators resolve at the point of access.** `anyOf`, `oneOf`, and `allOf`
use eager traversal for the selected subtree, preserving whole-branch validation
and merging only successful results. Shallow candidate matching does not decide
branch validity. Property defaults and nullable array-item fallbacks also need
the selected subtree evaluated before choosing a replacement; see
[the feature contract](../features/lazy-cell-materialization.md).

### Snapshot semantics

A lazy view reads the state as of the `.get()` that created it, not the live
transaction state. A reader that materializes a list and then writes into it
iterates what it was handed, which is what eager materialization gives.

Read-your-own-writes is preserved by re-reading rather than by reading live: a
fresh `.get()` fixes a fresh instant, and `.get()` on a handle the argument
carried does too, so a lift that writes into a `Writable` input and reads it
back gets what it wrote.

The transaction carries a write epoch, bumped each time it replaces a document
root, and a view records the epoch it was taken at. Reading a document at epoch
E resolves to the root standing at E: the current one where nothing has
displaced it, and otherwise the one a write set aside.

A write sets a root aside only where a reader holds an instant that root answers
for, so a transaction nobody reads this way costs its write path nothing, and a
run of writes with no read between them keeps one root rather than one per
write. Setting one aside means deep-freezing it first, because a write thaws a
frozen container by cloning and edits an already-mutable one in place —
so without the freeze the next write would edit the value a reader is
describing. `deepFreeze` short-circuits on what is already deep-frozen, so this
costs only what the transaction has thawed by writing.

Before the first write every document still stands at its `initial` attestation,
so every epoch names the same state and reads skip epoch resolution on that
check alone. That is the shape the plan exists to serve: the scheduler opens a
transaction and hands it straight to the action, whose first act is to read its
argument.

Reads register their activity on the live transaction, so reactivity and commit
preconditions are unchanged; only the _value_ comes from the epoch. The
preconditions describe committed state, which is what an untouched root holds,
so the two stay consistent.

Caches that key on path rather than on instant — the transaction's read-result
cache, its link-resolution memo, the frozen-reads cache, and the proxy cache —
are not consulted or filled while a read resolves against an earlier epoch. A
value kept under one instant and served under another is the failure this
avoids.

### The mismatch signal

A refusal below the root throws a dedicated error class — call it
`SchemaMismatchError` — carrying the link, the path, and which check failed.

Throwing alone is not enough: a reader can catch it. So the throw also **marks
the transaction**. The transaction gains a sticky note ("this transaction
produced a schema refusal", with the detail for diagnostics) that survives any
`try`/`catch` in the reader's body and any `await` in an async one. The runner
checks the mark after the body returns, and treats a marked transaction as a
refusal regardless of what the body handed back.

The view withdraws the mark for a refusal it catches itself — the optional
property above, whose answer is `undefined` rather than a refusal. The mark is
for a refusal the reader saw, so it has to go with the throw it belonged to, and
withdrawing it clears only that exact refusal: another one held on the same
transaction is somebody else's and still owed to the runner.

Disposition of a refusal:

- The result is written as undefined through the ordinary result path, the same
  value a non-resolving argument produces.
- It is **not** reported as an action error and **not** logged as one. A refusal
  is a run that could not proceed on the data available, not a fault.
- Writes the body made before the refusal remain in the transaction and commit.
  This matches how an ordinary thrown lift error already behaves, and the sticky
  mark leaves the door open to a stricter disposition later without changing the
  detection mechanism.
- The reads taken up to the refusal — including the one that failed — stay
  registered, so the node re-runs when its inputs change and may then find valid
  data. This is the property that makes the disposition correct rather than
  merely quiet.

### The transaction mode

Lazy materialization is a mode on the transaction, not an argument threaded
through every call. `TransactionWrapper`
([`extended-storage-transaction.ts`](../../packages/runner/src/storage/extended-storage-transaction.ts))
is the existing shape for a transaction that changes read behavior —
`createNonReactiveTransaction` is the precedent — and the mode belongs alongside
it, with a scoped `runWithLazyMaterialization(fn)` helper mirroring
`runWithAmbientReadMeta`.

`Cell.get()` consults the mode and dispatches to the lazy view instead of
`validateAndTransform`. Cells minted during a lazy read inherit the mode through
`getTransactionForChildCells`, so a lift reaching through an `asCell` handle
stays lazy — which is where most of the win is, since a large argument is
usually large because of what hangs off its handles.

The runner turns the mode on around argument materialization and the body, and
off before `writeJavaScriptActionResult`. Result writing, diffing, and the
scheduler's own reads keep eager semantics.

The per-transaction read cache on `Cell.get()`
([`cell.ts`](../../packages/runner/src/cell.ts)) keys on a `variant` string; the
mode joins it, so an eager and a lazy read of the same view do not share an
entry.

## Stages

### Stage 0 — Measure

- [x] Baseline recorded. `test/cell-schema-read-depth.bench.ts` already measures
      whole-array materialization across schema depth, which is the number a
      lazy read has to beat: eager `.get()` costs the same whether the reader
      wants one field or all of them.
- [x] Confirm which cost dominates. It is traversal, by a wide margin.

For a 1000-item list, one `.get()`:

| Schema at the item          | time    |
| --------------------------- | ------- |
| schemaless (the proxy path) | 1.1 ms  |
| `items: true`               | 13.2 ms |
| `items: { type: "object" }` | 29.4 ms |
| every field declared        | 7.2 ms  |

Materializing the recorded read activities is 15 µs against those milliseconds,
so read registration is not where the time goes. The permissive object schema
costing four times the fully declared one is worth its own look: a schema that
declares less should not traverse more.

- [x] The one-scalar and all-row comparison is available in
      `test/cell-schema-read-width.bench.ts`. It uses fresh transactions and the
      same declared schema in both eager and lazy modes, verifies every result,
      and reports journal activity separately from timing. The
      [baseline report](../history/development/performance/2026-09-11-lazy-scalar-read-width.md)
      records the measured workload and its limits. Re-run it after per-access
      implementation changes.

### Stage 1 — Split the standing handle from the pinned view

**Done, with a scope correction.** The plan assumed one kind of view and that
every consumer reading past its transaction was a bug to fix. Execution
disproved the second half: pinning universally broke 36 tests across the LLM
dialog builtin, the SQLite builtins, piece auto-start, `inSpace` children, the
module byte cache, and pattern scope. Those are not accidents. A query-result
proxy is a _standing handle on a cell_, and long-lived consumers read one after
the run that made it has committed — an LLM tool call dispatched later, a SQLite
result flushed post-commit, a piece started on demand. Re-resolving the
transaction is the mechanism that makes a handle live, not an oversight.

A test pinned that contract directly (`runtime-v2-read-tx-fallback.test.ts`,
"uses a fresh read transaction for top-level query result proxy reads when no tx
is provided"), which settles it: the behavior is intended.

So both readings now exist over one proxy body, and **the transaction decides
which one a caller gets**. `markLazyMaterializationTx` marks a transaction, on
the same wrapper chain as the marks beside it in `reactivity-log.ts`, and
`createQueryResultProxy` reads that mark:

- [x] Unmarked — every caller today — is the standing handle, resolving per
      access exactly as before. Nothing outside the mark changes behavior.
- [x] Marked is the view. It keeps that transaction for every access and every
      child it hands out; reading after the transaction finishes throws
      `StorageTransactionCompleteError` through the transaction's own
      `editable()` guard, with no new error type.

Gating on the transaction rather than on a second entry point is what keeps the
rule single: a call site cannot pin by accident, and everything a marked
transaction reads pins together, including the schema-less subtrees a
schema-observing view will delegate.

- [x] `Cell.pull()` fixed. It built its value inside a scheduler effect whose
      transaction has committed by the time the promise resolves, so a
      schemaless cell resolved a handle over a dead transaction. The effect
      drives the scheduler; the value the caller keeps is read after it.
- [x] Suite green: 1162 passed, 0 failed, against a baseline of 1161 passed and
      1 failed — the `pull()` fix took that one too.

This also settles Stage 3's "pin both or pin neither": both, within a marked
transaction, and neither outside one. A `.get()` under lazy materialization
hands back handles that agree on which instant they describe, while an unmarked
read keeps the live-handle semantics its consumers rely on.

Stage 4 no longer has to invent the mode — it has to decide what else the mark
means, and set it. Today nothing in the runtime marks a transaction, so the
behavior is dormant by construction.

### Stage 2 — The schema-observing view

**Done.** `schema-view.ts` builds a view over a `(link, schema)` pair.
`validateAndTransform` branches into it when the transaction is marked, after
its own link resolution, `asCell` dispatch and schema combination have run — so
a view and an eager read start from the same link and the same schema, and only
the materialization differs.

- [x] Property reads narrow with `schemaAtPath`, using the `emptyProperties` /
      `missingProperty` markers, so a property the schema does not select is
      absent from the view rather than present and raw.
- [x] A child goes back through `validateAndTransform`, which is what keeps link
      resolution, `asCell` dispatch and schema combination in one place.
- [x] Schema `default` applied for an absent declared property, through
      `processDefaultValue`.
- [x] `ownKeys`, `has` and `getOwnPropertyDescriptor` answer from the schema's
      selection intersected with the data's own keys, so a spread carries what
      an eager read carries.
- [x] Arrays: `length`, iteration, index access, and the read-only
      `Array.prototype` methods over element views built on demand. The
      reshaping methods refuse — a view is a read.
- [x] `toCell` on every view.
- [x] `anyOf`, `oneOf`, and `allOf` evaluated through eager traversal at the
      point of access, preserving whole-branch validation and result merging.
- [x] `SchemaMismatchError`, carrying link and reason.
- [x] Root guard: type, `required` presence. A mismatch at the root is
      `undefined`, matching an eager read; below it, a refusal.
- [x] Reads registered as the view goes: non-recursive at a container, recursive
      at a leaf the reader materializes. `validateAndTransform`'s own document
      read is deliberately `ignoreReadForScheduling` — the eager traverser
      registers its reads as it walks, and a view has to do the same or a
      computed never re-runs.
- [x] A view refuses assignment, deletion, `defineProperty` and freezing.

Verified: a view returns the same value as an eager read across flat and nested
records, arrays of scalars and of records, unselected properties, declared
defaults and a matching `anyOf` branch; and reading one field of a record
registers no read for its siblings, nor for array elements never reached.

### Stage 3 — Snapshot semantics

**Done, by the write epoch.** A view describes the instant its `.get()` fixed,
containers and values alike, and a reader sees its own writes by re-reading.
"Snapshot semantics" above states the design.

- [x] A write epoch on the transaction, bumped at the one chokepoint every root
      replacement funnels through.
- [x] A read resolves against the epoch its view was taken at, decided at the
      single site where a read chooses its root.
- [x] A write sets aside the root it displaces, deep-frozen, only where a reader
      holds an instant that root answers for.
- [x] Caches keyed on path rather than instant stand aside while a read resolves
      against an earlier epoch.
- [x] A nested materialization inherits the instant it is being read at rather
      than fixing a later one.
- [x] `validateAndTransform` takes the lazy route on every marked transaction,
      whether or not it has written.
- [x] Both readings on a marked transaction pin: the schema view and the
      schema-less proxy. Unmarked reads are untouched, and the standing handle
      keeps tracking current state.
- [x] Benchmarked in `test/lazy-view-epoch.bench.ts`, with one runtime for the
      file and every iteration aborting, so no iteration pays for a runtime or a
      seeded document. A single walk of a thousand elements is not slower under
      an epoch — it comes out ahead, because an epoch read neither fills nor
      consults the per-path caches, which a walk that touches each path once
      pays for and never collects on. Fifty writes after one view is taken cost
      no more than fifty writes after a raw read: one preserve covers the run
      and deep-freezing an already-frozen root is a cache hit. Fifty
      write/read rounds, where every write finds an instant to preserve, cost
      about 1.6x — seven runs spread between 1.5x and 2.0x, which is the figure
      to quote rather than any single run's.

### Stage 4 — The transaction mode

**Done**, and it is the gate for everything: `markLazyMaterialize(enabled)` and
`isLazyMaterialize()` on `IExtendedStorageTransaction`, marked along the wrapper
chain so a wrapper and the transaction it wraps answer alike.

- [x] `Cell.get()` dispatches on the mark, through `validateAndTransform`.
- [x] `noteSchemaRefusal` / `takeSchemaRefusal` on the transaction: a refusal is
      recorded as well as thrown, so a reader that catches it does not get to
      hand back a result built on data the schema does not describe.

### Stage 5 — Runner integration

**Done.** The runner marks the action's transaction around argument
materialization and the body, and unmarks it before the result is written, so
diffing and the scheduler's own reads keep eager semantics.

- [x] A refusal caught inside the body and found on the transaction afterwards,
      or rejected out of an asynchronous body, writes an undefined result
      through the ordinary path. Logged at info level as a non-run, not reported
      as an action error. Verified by reading the path; no test in the tree
      asserts the result for these two arms.
- [x] A refusal a synchronous body throws writes the same undefined result:
      `postRun` is assigned before the body is invoked, and
      `packages/runner/test/lift-refusal-disposition.test.ts` pins it in both
      postures. A refusal raised during the argument read still precedes the
      assignment and keeps the earlier disposition.
- [x] The reads taken up to the refusal stay registered, including the one that
      failed, so the node runs again when its inputs change.
- [x] Handlers materialize eagerly, by decision rather than by omission. The
      [fast-follow](lazy-materialization-fast-follow.md) built and measured a
      lazy bound-context prototype and deferred it: a view narrows the read
      log a handler's commit is checked against, and its measured win is
      confined to a shape the collection guidance already steers away from.
      The [record](../history/development/performance/2026-09-11-lazy-handler-context-prototype.md)
      names the conditions for taking it up again.

### Stage 6 — Rollout

- [x] `lazyMaterialization` registered in
      [`../development/EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md),
      reachable by `EXPERIMENTAL_LAZY_MATERIALIZATION` or
      `RuntimeOptions.experimental`.
- [x] Landed default-off with both suites green.
- [x] Default-on, both suites green. Every divergence that stood in the way was
      a place a view answered from less than an eager read had: the schema of
      the last link hop uncombined, a `default` read out of a union branch an
      eager read never evaluates, an optional property refused where an eager
      read drops it, and three reads that were answered without being
      registered. None of them was the "argument refused for a missing field"
      story the earlier note here guessed at; that disposition was not among
      them.
- [x] Read `.length` off a string. `.length` on a string output lowers to a link
      ending in that segment, and a string's `length` is not a stored path, so
      the store cannot serve the address the link resolves to. Eager traversal
      computes it from the string in passing (`getAtPath`); the value read after
      link resolution now applies the same rule, which is also where an eager
      read of such a link used to answer `undefined`.
      `gideon-tests/proxy-length-repro` pins it.
- [ ] Owner-led: decide whether and when to remove the default-on flag. The
      [fast-follow plan](lazy-materialization-fast-follow.md) supplies evidence;
      its completion does not depend on this optional retirement.

## Testing

Follow
[`../development/unit-test-coding-style.md`](../development/unit-test-coding-style.md)
for shape, and
[`../development/waiting-in-tests.md`](../development/waiting-in-tests.md) for
anything that waits — no polls, no sleeps, no retry loops. The gates in
[`../../AGENTS.md`](../../AGENTS.md) that do not run under `deno task check`
(`check-no-waitfor`, `check-docs`, `check-skill-facts`, and the dependency
checks) all apply.

Four properties carry most of the confidence:

- **Equivalence.** A full walk of a lazy view equals the eager result, across a
  corpus wide enough to cover `anyOf`, `asCell`, defaults, links, arrays,
  `prefixItems`, and `additionalProperties`.
- **Frugality.** Reading one scalar from a large argument registers reads for
  the path touched and its containers, and for nothing else. Assert on the
  registered read set, not on timing.
- **Refusal.** A touched mismatch under a `required` property refuses, marks the
  transaction, survives being caught by reader code, and leaves behind the
  dependency that re-triggers the node. Assert the re-trigger by writing the
  missing data and observing the run. Under an optional property the same
  mismatch reads as `undefined`, leaves no mark, and still leaves the dependency.
- **Dependency on absence.** Every way of answering "nothing is there" —
  refusal, absent key, declared default — registers the read it stands in for.
  The cheapest assertion is on the registered read set; the honest one writes
  the value afterwards and observes the reader run.
- **Snapshot.** A view iterates the list it was handed while the reader writes
  into that list, whichever side of a write the view was taken on, and a value
  below the container reads as what stood at the instant the view was taken.
  Taking the read again reads what the transaction now holds. Test it over a
  list of primitives: an inline object element is rebased onto a `data:`
  identity derived from its own value, so a read of one never reaches the
  document and holds still whether or not the instant does any work.

Mutation-test each new test: break the behavior it claims to guard and confirm
it fails. A test over a proxy is unusually easy to write in a form that cannot
fail, because a proxy answers almost anything.

## Risks

**Silent semantic drift in patterns.** The touch-scoped contract lets a lift run
where it previously did not. A pattern relying on whole-argument collapse as a
guard will change behavior. The experimental flag and the soak exist for this;
the Stage 5 gate asserts the change deliberately rather than discovering it.

**Proxy-hostile consumers.** Code that freezes, structurally clones, or
`preventExtensions` a materialized value will now hit a proxy that refuses those
operations. `snapshotQueryResult`
([`query-result-proxy.ts`](../../packages/runner/src/query-result-proxy.ts)) is
the existing escape and should be the documented answer. Auditing the consumers
that survive to the result-writing boundary is part of Stage 5.

**CFC label timing.** Labels join the flow as paths are touched rather than at
materialization, so a run's label set can be narrower — which is more precise,
and is a change. Stage 1 covers the closed-transaction half of the hazard: a
view that escapes its run can no longer reach past the transaction it was taken
against. What it does not cover is a view read late but still inside a live
transaction, after `prepareCfc()` — that invalidates the prepared digest by
design, and Stage 4 needs a test that the invalidation is what happens rather
than a read slipping past a prepared boundary.

**Escaped views.** Settled: a view keeps the transaction it was created with,
and reading after that transaction finishes throws. `validateAndTransform` keeps
a marked transaction rather than swapping a finished one for a fresh read, so
the refusal is not routed around. A standing handle — every unmarked caller —
still resolves per access and keeps tracking current state, which is what its
long-lived consumers rely on.

One carve-out, and it is deliberate: a finished view answers a `then` probe with
`undefined` instead of refusing. Promise adoption probes `then` on every value
it receives and a lift's result crosses a promise boundary by construction, so a
view that refuses the probe cannot be returned at all.

**What an instant costs a transaction that keeps taking them.** A read between
every write is the shape where every write preserves a root, and it is the one
to watch: such a run costs around 1.6x the same run reading raw, spread between
1.5x and 2.0x across runs. A run of writes under a single view costs nothing
measurable, because one preserve covers it. Neither is the lift path, which reads its argument and writes nothing.

Retention rides on the same thing. `displaced` grows one root per document per
read-then-write round and is never pruned, and `documentAtEpoch` scans it
oldest-first, so a long-lived transaction alternating reads and writes pays in
both memory and lookup. Deliberately left: the transactions this runs on are one
action long.

**CFC label timing.** Labels join the flow as paths are touched rather than at
materialization, so a run's label set can be narrower — more precise, and a
change. A read issued after `prepareCfc()` invalidates the prepared digest by
design; that a view's late read still triggers that invalidation rather than
slipping past a prepared boundary is untested.

## Not in scope

- Narrowing the **sync selector** so the server ships only what a reader
  touches. That is the larger win for genuinely huge data and depends on this
  work landing first; it belongs with
  [shaped reads and verb results](shaped-reads-and-verb-results.md).
- Making **handlers** lazy: Stage 5 records the decision to keep them eager.
- Replacing the schema-less `createQueryResultProxy`. It remains the view for an
  absent or `true` schema, and the lazy view delegates to it.
