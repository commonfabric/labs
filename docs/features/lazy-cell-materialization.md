# Lazy cell materialization

`Cell.get()` builds everything its schema selects before the reader touches any
of it: every entry link-resolved, defaulted, annotated and registered as a
reactive dependency. A lift declaring a thousand-entry list pays for a thousand
entries to read `list.length`.

A **view** does that work per path instead. It is a proxy over a
`(link, schema)` pair that resolves each property as the reader asks for it,
narrowing the schema by that step. What nobody reads is never built, never
link-resolved and never registered, with one exception described below: a
combinator the value's type does not settle is evaluated whole at the position
where it is accessed.

What that buys is pinned where it is largest.
`packages/patterns/integration/topics-lazy-lookup-reruns.test.ts` holds the
Topics board's per-topic backlink lookup, which reads a pivot table declared
with a default, to re-running only for the topics whose row a mention edit
changed. A runtime change that materializes a defaulted or nullable subtree
whole under a view fails it, however faithfully the result matches an eager
read.

## Where a view comes from

The transaction decides, not the call site. `tx.markLazyMaterialize(true)` puts
a transaction in the mode; reads through it use views where validation can be
decided per child. The runner marks the transaction it runs a lift's
argument read and body on, and unmarks it afterwards.

`validateAndTransform` in
[`schema.ts`](../../packages/runner/src/schema.ts) is the single entry point.
It reads the mark and branches to
[`schema-view.ts`](../../packages/runner/src/schema-view.ts) **after** its own
link resolution, `asCell` dispatch and schema combination have run, so a view
and an eager read start from the same link and the same schema and only the
materialization differs.

A view's children go back through that same entry point rather than being built
in place. That is what keeps `asCell` minting, the follow-scope cap, link
resolution and schema combination in one implementation each; the view supplies
the child's link and lets the front door decide what the child is.

## What a view checks, and when

At the container it is built over: the value's type against the schema's, and
the schema's `required` keys — that the value carries each of them, and that
the
schema selects each one it requires. Both come off the container read a
view takes anyway, so neither descends.

Everything below is checked where the reader touches it. **A subtree the reader
never reads is never validated.** That is the one behavior change a pattern
author can observe, and [the divergences](#where-a-view-deliberately-diverges)
below spell out what follows from it.

One shape is evaluated whole at the position where it is accessed, through the
same traverser an eager read uses: a combinator the value's type does not
settle. `anyOf`, `oneOf`, and `allOf` must validate entire branches before
selecting and merging successful results. A shallow prefilter cannot decide
whether a branch matches, and combining candidate property schemas loses
relationships between the properties of a branch. Accessing such a combinator
therefore registers reads throughout its selected subtree; an untouched sibling
remains deferred, and cell handles retain their ordinary traversal boundaries.

Where the value's type alone selects one branch of an `anyOf` or `oneOf` —
an array under `Row[] | null`, an object under `Row | null` — every other
branch has already refused the value, and nothing below it can change which
branch applies. The view is built over that branch, with the keywords beside
the union carried onto it, and stays lazy: `rows.length` under `Row[] | null`
reads what it reads under `Row[]`. A union the type does not settle — a branch
declaring no `type`, two branches accepting the value's type, none doing so,
or an `allOf`, which is not a choice — is evaluated whole as above.

A combinator evaluated whole can cross a hop to a linked document the replica
cannot serve. Where the traversal fails, nothing in it is known to be invalid,
so the read refuses as unresolved input — the same `UnresolvedInputError` a
view raises when its own link chain dead-ends. Any unserved hop inside the
subtree counts, including one the failure did not turn on; the refusal errs
toward waiting, and the reader runs again when the document arrives. Where the
traversal succeeds, what decides is whether a substitute stood in for what the
hop hides: an array item's `null` or `undefined`, or a default, covering a
subtree that crossed the hop, refuses the same way, since the value it replaces
is unserved rather than known. A position that admits the `undefined` the hop
reads as stands, as it does for an eager read, with the document's read
registered.

A mismatch the reader does touch surfaces at the **nearest enclosing property**,
which is where an eager read decides the same question:

- under a `required` property it throws a `SchemaMismatchError`;
- under an optional one the property reads as absent, because an eager read
  leaves a property whose traversal fails out of the object rather than voiding
  it.

A declared non-null property default takes precedence over either outcome when
the view rejects the property at the container it is built over. The read that
failed is registered first, including when a default replaces it.

## Where a view deliberately diverges

A view and an eager read agree on every value they both produce. Where they
part is in what a view declines to look at, and each divergence below is a
decision rather than a gap. `packages/runner/test/materialization-parity.test.ts`
pins each one in both modes, under "where a view deliberately diverges from an
eager read".

- **An untouched mismatch does not stop the reader.** An eager read of
  `{ count: 1, box: { n: "bad" } }` under a schema requiring a numeric `box.n`
  is `undefined`, and a lift over it does not run. A view hands `count` back
  and the lift runs, because nothing asked for `box.n`. A reader that does
  touch `box.n` refuses there, with the read registered.
- **A property default replaces what the view rejects, not what fails deeper.**
  An eager read evaluates a defaulted property's whole subtree and takes the
  default when any of it fails: `{ box: { n: "bad" } }` under a `box` whose
  default is `{ n: 7 }` reads as `{ box: { n: 7 } }`. A view takes the default
  when the property is absent or when its own container-level check rejects
  the value — the wrong type, a required key missing — and otherwise hands
  back a view of what is there, so `box.n` refuses where it is touched. A
  present value is never evaluated whole to decide its default.
- **An array substitute replaces what the view rejects, not what fails deeper.**
  The same rule for an item whose schema permits `null` or `undefined`: an
  eager read substitutes for `{ n: "bad" }` under a required numeric `n`, and
  a view hands the element back and refuses at `n`.
- **An array no element can satisfy reads as a view, not as nothing.**
  `items: false` is what the schema generator emits for a `never[]`, the type
  a bare `[]` literal infers, and an eager read of a non-empty array under it
  voids the array, so the property holding it is absent. A view validates at
  the container what the container read shows and hands the array back:
  `length` reads, and an element refuses where the reader touches it. An
  `items` schema is never evaluated ahead of the elements, however little
  there is to evaluate; an empty array satisfies it in both modes.
- **Unresolved input refuses instead of reading as absent.** A link chain that
  dead-ends at a document the replica cannot serve makes a view refuse with
  `UnresolvedInputError` where the schema declares no default. An eager read
  reads the same position as `undefined`. This one is lazy-branch only by
  design; the runner's bindings, diffing and scheduler reads keep eager
  semantics. The refusal stands wherever something would otherwise be
  published in the unknown value's place — the position read, a required
  property, a declared default, an array substitute. An optional property
  with no default has nothing to publish, and reads as absent there as it
  does eagerly, the dead-end's read registered so the reader runs again when
  the document arrives.

The first four share one reason: deciding a fallback by evaluating a present
subtree registers every read below it, and a pattern's optional inputs are
declared with defaults, so that rule would make every such input read eagerly.
The Topics test named above is what holds the line.

## Returning "nothing is there" still owes a read

The entry point takes the container's value without telling the scheduler, and
lets whatever materializes it register reads as it walks. So every way a view
returns without a value has to register the read it stands in for: a refusal, a
key the container does not hold, and a value replaced by the schema's `default`.
Miss one and the reader holds no dependency on the path it just found empty —
it
goes on reading its default however late the value arrives.

## Agreeing with an eager read

A view and an eager read must agree; where they do not, the view is
wrong. These rules hold that agreement:

- **The last link hop's schema is combined in.** Eager traversal walks *through*
  a link and combines the link's schema — which describes the value at its
  target — with the reader's, which describes what was asked for. A view
  re-enters per property instead of walking through, so the entry point does
  that combining. Without it, a property the reader asked for that the link's
  own schema does not name reads as one the schema does not select.
- **A combinator the value's type does not settle uses eager branch
  evaluation at the accessed position.** Outer keywords, `$defs`, handle
  selection, and merging of successful results are decided by the traverser.
  `oneOf` requires exactly one match; `allOf` requires every branch to match.
  A failed branch cannot contribute properties to an
  `anyOf` result. The union classified this way, and the schema the traverser
  is handed, are the reader's: a link that carries a schema of its own puts
  that schema on the selector, and the union the reader asked for is what the
  view was given. A union the value's type settles is not evaluated whole; the
  view is built over the one branch that can match, which is the branch the
  eager read would have selected.
- **A union whose branches declare a handle mints the handle an eager read
  would.** An optional handle — `Cell<T> | undefined` — generates as a union
  whose one branch declares `asCell`, and the entry point's dispatch sees the
  marker only at the top of a schema. A handle outlives the read that minted
  it and is read later by code that never knew which mode minted it, so its
  schema is the reader's declaration and not the mode's: which branches match
  is decided by traversing them, and the handle an eager read keeps carries
  the branch's own schema where one branch matched, the schema adopted from
  the hop where a bare branch was the one, and otherwise the compound with the
  branches' markers removed, as
  [the traversal spec](../specs/space-model/8-traversal.md#merging-branch-results)
  records. No reading of the schema alone reproduces that, so at a view's
  child such a union is handed to the traverser from the hop, exactly the
  position the parent's eager traversal evaluates, and the merge mints the
  handle. A reader gets the same `Cell` either way, carrying the same schema.
- **Object property defaults follow filtering.** A missing or rejected
  declared property takes its non-null default, including when it is required.
  A property default of `null` does not fill an absent or rejected property.
  At the top level an absent value can take a `null` default. Both paths apply
  the same rule, which `getPropertyDefaultSchema` in `traverse.ts` states. What
  counts as rejected is where the two paths part, and that is listed under the
  divergences above.
- **Invalid array items take a permitted substitute.** `undefined` takes
  precedence over `null`; when neither is permitted, the mismatch refuses.
  Both paths use the same fallback selector. An unavailable linked document
  still raises the lazy read's `UnresolvedInputError`, whether it is the item
  itself or a link inside a combinator item evaluated whole: its value is not
  known to be invalid, so an array substitute does not satisfy that refusal.
  Under a union the item's type settles, the item is a view over the selected
  branch, and the dead-end below it refuses where the reader touches it, as
  under any view; the item never reads as the substitute.
- **An inline array element is identified by its value.** `toCell` on such an
  element, including a nested array, must not name the array's index; written
  elsewhere that link would follow whatever lands at the index next. Eager
  traversal rebases it onto a
  [`data:` identifier](data-uri-identifiers.md), and the view does the same. The
  read stays on the slot, and recursively: the identity is derived from the
  whole
  element value.
- **A property the schema turns down is settled off the schema, not by reading
  it.** Declaring it `false` turns it down, and so does leaving it unnamed by a
  schema that refuses the properties it does not name. Either way it is absent
  to a reader — from `in`, from enumeration and from a plain access alike —
  and
  the link under it is never followed. Deciding it by reading and letting the
  read fail would fetch the document first, which is the cost the declaration
  was meant to avoid: a selection projection asks for a link's address that way,
  and a marked collection would otherwise load one document per element.
  Requiring such a property instead voids the object, since nothing reaches the
  filtered result at that key. Schema narrowing also returns `false` where the
  schema's declared type holds no children at all, and there nothing was turned
  down. Omitting `type` alone restricts no type — an `enum`, a `const` or a
  combinator beside it still does — and narrowing without the value in hand
  can say only what such a schema's object and array readings both admit; a
  read that holds the value settles the type first, so an object's key narrows
  through the properties and an array's element through the items, on both
  paths. [How a step narrows](../specs/json_schema.md#how-a-step-narrows)
  states the whole rule, including how an enumeration narrows.
- **A read-only array method visits every element, even past one that does not
  match.** An eager read walks the whole array before it calls the array
  invalid, so each element is a dependency of the reader either way. Stopping at
  the first mismatch would leave the reader depending on the elements up to it,
  and nothing would wake it when the rest arrived.

## Reading a key the schema does not select

A schema is a selection, so a key the data carries and the schema does not
select is absent to a reader. A schema that names its properties and admits no
others selects only those; one that admits additional properties selects an
unnamed key too, and this section is not about it. A view returns `undefined`
for an unselected key, which is what the object an eager read filters gives, and
nothing at the read tells that apart from a key that is not there. A reader in
that position has a schema that selects less than its body reads: one written by
hand narrower than the code, or a builder's input schema shrunk past a read the
capability analysis did not see.

A view counts such a read as a warning on the `schema-view` logger, under the
key `unselected-key-read`. The logger is disabled by default, so nothing prints
and the count is kept regardless. The pattern test runner fails a test on any
warning its run counts, unless the test allows console warnings, so a pattern
test whose lift reads an unselected key fails, and the failure names the logger
and the key. Enabling the logger prints which key was read and at which link.

Three reads are not counted:

- A key the schema turned down on purpose, as in the rule above. That is a
  deliberate absence.
- `then` and `toJSON`, which promise adoption and `JSON.stringify` probe on any
  object they are handed, whatever the reader's body asked for.
- A read through an eager value. An eager read hands back a plain object with
  the key already gone, so a handler, which stays eager, is not covered.

## The refusal, and how the runner disposes of it

A `SchemaMismatchError` carries the link and which check failed. Throwing alone
is not enough, because a reader can catch it — so the throw also records the
refusal on the transaction, where it survives any `try`/`catch` in the body and
any `await` in an async one.

The runner checks after the body returns and treats a recorded refusal as an
argument that did not resolve: an undefined result through the ordinary result
path, **not** an action error and not logged as one. A refusal the body throws
takes the same path whether it escapes synchronously or as the rejection of an
async body. A run that could not proceed on the data available is a non-event.
The reads it took stay registered, including the one that failed, so it runs
again when the data changes and may then find it valid.

The view withdraws the record for a refusal it catches itself — the optional
property, a property default, or an array-item substitute. It clears only
that exact refusal; another one held on the same transaction is somebody else's.

## A view describes the instant it was taken

`Cell.get()` on a marked transaction fixes an instant, and everything read
through the value it returns describes that instant — the keys an object
carried, an array's length and iteration order, and the values below them. A
reader that writes and then reads back through a value it already holds sees
what was there when it took that value, which is what an eager read gives, since
an eager read hands back a value built before the write.

Seeing your own write means taking the read again. A fresh `.get()` fixes a
fresh instant, and so does `.get()` on a handle the argument carried, so a lift
that writes into a `Writable` input and reads it back gets what it wrote. Two
values taken either side of a write describe their own instants and disagree
with each other, which is the point of them.

That is what carries a reader iterating a list while writing into it: the walk
runs over the list as it stood, whatever the writes do to it meanwhile.

### How an instant is kept

The transaction counts the roots it replaces, and a read taken now names that
count. A write keeps the root it displaces only where a reader was handed an
instant that root answers for — so a transaction nobody reads this way keeps
nothing, and a run of writes with no read between them keeps one root rather
than one per write.

Keeping a root means freezing it first. A write thaws a frozen container by
cloning it and edits an already-mutable one where it stands, so a root left
behind by an earlier write is mutable and the next write would edit the very
value a reader is describing. Freezing puts that write on the cloning path.
Deep-freezing what is already deep-frozen costs nothing, so this is paid only on
what the transaction has thawed by writing.

Before the first write there is nothing to resolve — every document still
stands
at the root it was loaded with, so every instant names the same state — and
reads skip the machinery outright on that check.

## Where a view is not used

- **Handlers.** They stay eager. A handler's read log is what its commit's read
  set is built from, so the set of paths it reads is also the set of concurrent
  writes its commit refuses. A view would narrow that set to the paths the body
  touched: an append to a list the body read, or a change to a field it read,
  would still conflict, but a change to a field of a row it never touched would
  not, and a handler relying on that conflict would lose the guard without any
  change to its code. A handler's reads through a handle are ordinary eager
  reads for the same reason.
- **An absent or `true` schema.** That is the schema-less query-result proxy's
  job, and `validateAndTransform` dispatches to it before a view is considered.
  [Where a schema-less read takes over](#where-a-schema-less-read-takes-over)
  below has what that costs and where the boundary falls.

## Where a schema-less read takes over

A schema that constrains nothing — absent, `true`, `{}`, or a `$ref` resolving
to one of those — selects the schema-less query-result proxy in
[`query-result-proxy.ts`](../../packages/runner/src/query-result-proxy.ts),
which `validateAndTransform` dispatches to before a view is considered. `false`
is not among them: it constrains everything, so it reaches traversal, and the
read is nothing.

That dispatch is not the root's alone. An eager read hands back a proxy for any
subtree whose narrowed schema says nothing
(`TransformObjectCreator.createObject` in
[`schema.ts`](../../packages/runner/src/schema.ts)), and a view's children go
back through the same front door, so they reach it the same way. One
`cell.get()` is therefore schema-checked at the top and schema-less wherever
the schema runs out below, and nothing in the value marks where that changes.

What stops at that boundary is everything a schema decides. A proxy observes
none, so it applies no `default`, mints no handle from an `asCell`, and cannot
tell a reader that the data stopped matching — the divergences above have
nothing to act on below it. One thing is decided by the value instead of by a
schema and so survives: a stored stream marker still mints a stream-kind cell,
which is what keeps `.send()` reaching a stream whose schema was lost.

What the proxy keeps is the per-access machinery. Links resolve as the reader
descends, `toCell` names the position the value was read from, and every access
registers a read — a container's shape as a shape-only read, a value
recursively.

Pinning follows the transaction's mark rather than the path that reached the
proxy. On a marked transaction it keeps that transaction and describes its
instant, as a view does; unmarked it is the standing handle described under
[A view is a read](#a-view-is-a-read). So a proxy reached from inside an eager
read on an unmarked transaction stands, and one reached from inside a view is
pinned.

Two further differences are the proxy's own. It refuses to nest past 100 levels
of child proxy, where the schema paths bound their descent with cycle trackers
instead. And it is read-only in its own right: assignment, deletion, `freeze`
and `defineProperty` each throw, and `snapshotQueryResult` is how a caller
takes a value it owns.

## A view is a read

Assignment, deletion, `defineProperty` and freezing all throw. Snapshot it with
`snapshotQueryResult` if you need a value you own. A view also keeps the
transaction it was created with, so reading after that transaction finishes
throws rather than quietly reading from committed state.

That is what separates a view from the standing handle in
[`query-result-proxy.ts`](../../packages/runner/src/query-result-proxy.ts),
which re-resolves its transaction on every access so a holder keeps reading
current state after the transaction it was made against has finished. Long-lived
consumers depend on that — an LLM tool call dispatched later, a SQLite result
flushed post-commit, a piece started on demand — so the mark is what selects
between the two readings rather than one replacing the other. A schema-less read
on a marked transaction is a view like any other, and describes its instant; it
is the unmarked ones that stand.

## Related documents

- [`data-uri-identifiers.md`](data-uri-identifiers.md) — the identifiers an
  inline array element is rebased onto.
- [`../specs/space-model/7-schemas.md`](../specs/space-model/7-schemas.md) —
  what a schema means on a read.
- [`../specs/space-model/8-traversal.md`](../specs/space-model/8-traversal.md) —
  the eager traversal a view has to agree with.
- [`../development/EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md)
  — the `lazyMaterialization` flag while it exists.
