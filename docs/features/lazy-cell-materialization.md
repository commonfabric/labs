# Lazy cell materialization

`Cell.get()` builds everything its schema selects before the reader touches any
of it: every entry link-resolved, defaulted, annotated and registered as a
reactive dependency. A lift declaring a thousand-entry list pays for a thousand
entries to read `list.length`.

A **view** does that work per path instead. It is a proxy over a
`(link, schema)` pair that resolves each property as the reader asks for it,
narrowing the schema by that step. What nobody reads is never built, never
link-resolved and never registered.

## Where a view comes from

The transaction decides, not the call site. `tx.markLazyMaterialize(true)` puts
a transaction in the mode; every read through it is lazy, and nothing else in
the runtime changes behavior. The runner marks the transaction it runs a lift's
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
the schema's `required` keys — that the value carries each of them, and that the
schema selects each one it requires. Both come off the container read a
view takes anyway, so neither descends.

Everything below is checked where the reader touches it. **A subtree the reader
never reads is never validated.** That is the one behavior change a pattern
author can observe: today a broken field five levels down collapses the whole
argument and the lift does not run; under a view the lift runs, because nothing
ever asked. It is bounded in the direction that matters — a reader that touches
broken data still refuses — and it removes a class of whole-argument collapses
caused by data the reader had no interest in.

A mismatch the reader does touch surfaces at the **nearest enclosing property**,
which is where an eager read decides the same question:

- under a `required` property it throws a `SchemaMismatchError`;
- under an optional one the property reads as absent, because an eager read
  leaves a property whose traversal fails out of the object rather than voiding
  it.

Either way the read that failed is registered first.

## Returning "nothing is there" still owes a read

The entry point takes the container's value without telling the scheduler, and
lets whatever materializes it register reads as it walks. So every way a view
returns without a value has to register the read it stands in for: a refusal, a
key the container does not hold, and a value replaced by the schema's `default`.
Miss one and the reader holds no dependency on the path it just found empty — it
goes on reading its default however late the value arrives.

## Agreeing with an eager read

A view and an eager read must agree; where they do not, the view is
wrong. Six rules exist only to hold that:

- **The last link hop's schema is combined in.** Eager traversal walks *through*
  a link and combines the link's schema — which describes the value at its
  target — with the reader's, which describes what was asked for. A view
  re-enters per property instead of walking through, so the entry point does
  that combining. Without it, a property the reader asked for that the link's
  own schema does not name reads as one the schema does not select.
- **A union's own keywords ride onto the branch it narrows to.** Its
  `properties`, `required` and `default` apply to whichever branch matches, so a
  branch alone accepts values the schema rejects. Its `$defs` ride along too: a
  branch is routinely a `$ref` into them. Subscription-selector matching resolves a
  union branch against those definitions, in place of any `$defs` the branch
  declares of its own.
- **A default comes from the schema's own top level**, never out of a branch of
  a union — a branch is reached by evaluating it against a value, and an absent
  value gets no branch evaluated.
- **An inline array element is identified by its value.** `toCell` on such an
  element must not name the array's index; written elsewhere that link would
  follow whatever lands at the index next. Eager traversal rebases it onto a
  [`data:` identifier](data-uri-identifiers.md), and the view does the same. The
  read stays on the slot, and recursively: the identity is derived from the whole
  element value.
- **A property the schema turns down is settled off the schema, not by reading
  it.** Declaring it `false` turns it down, and so does leaving it unnamed by a
  schema that refuses the properties it does not name — unless a part of an
  `allOf` beside it admits the key: by naming it with a schema other than
  `false`, or, where it does not name the key, by an `additionalProperties`
  other than `false`. An eager read merges the schema's keywords into each part
  and lets the part's win. Either way it is absent to a reader — from `in`, from
  enumeration and from a plain access alike — and the link under it is never
  followed. Deciding it by reading and letting the read fail would fetch the
  document first, which is the cost the declaration was meant to avoid: a
  selection projection asks for a link's address that way, and a marked
  collection would otherwise load one document per element. Requiring such a
  property instead voids the object, since nothing reaches the filtered result
  at that key. This is narrower than it sounds — schema narrowing also returns
  `false` where it cannot read a child out of the shape it was given, an `allOf`
  among them, and there the subschema is still reachable below.
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
property above, whose answer is absence rather than a refusal. It clears only
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

Before the first write there is nothing to resolve — every document still stands
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
