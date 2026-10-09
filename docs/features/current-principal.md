# The principal a handler acts for

A handler often has to know who it is acting for: to key a record by its
sender, to refuse a second request from the same person, or to refuse a request
from someone who left. `currentPrincipal()`, exported to patterns through the
`commonfabric` module, returns that principal's DID. This document says where
the value comes from on each kind of runtime, what it can and cannot be made to
say, and why it is available only in a handler.

"Handler" here means any event handler a pattern defines, `action()` included:
the compiler lowers an `action()` to a `handler()`.

## What it returns

In a handler, `currentPrincipal()` returns the authenticated actor of the event
being handled.

- **On a client runtime**, which is where handlers run unless server execution
  is on, it is the runtime's own user: the identity its storage manager
  authenticates as.
- **On a serving runtime**, it is the acting user stamped on the run's wave
  context. The serving loop takes it from the event's server-stamped `firedAt`,
  which the memory server writes from the authenticated commit, or, for an event
  a run emitted, from the actor that run carried.
- **For a served run with no actor**, it is `undefined`. It is never the empty
  string, and never the serving runtime's own identity.

A pattern treats `undefined` as "no one", and refuses whatever needs someone.

The choice is made in one place, `Runtime.actingPrincipalFor()` in
`packages/runner/src/runtime.ts`, and `currentPrincipal()` is a frame check in
front of it (`packages/runner/src/builder/current-principal.ts`). Runtime code
that needs the actor of a handler run calls that method rather than choosing
again.

## Where it does not come from

Three nearby sources are wrong for this, each in a different way.

- **The event payload.** A payload is the one part of an event its sender
  authors, so no field of it is consulted, whatever it is named. A payload
  carrying `acting`, `user` or `firedAt` fields changes nothing.
- **The CFC trust snapshot.** A serving runtime gives a run with no actor the
  ambient snapshot, whose `actingPrincipal` names the serving runtime itself,
  and the memory plane represents a run with no actor as an empty
  `actingPrincipal`. Either would pass for a principal.
- **`Runtime.homeSpacePrincipalFor()`.** It decides a different thing — whose
  home space a run targets — and so prefers the owner of the scope instance a
  run executes on over the run's actor. A handler on one user's instance fired
  by another user acts for the second one. It also narrows the transaction's
  read scope to `user`, which a handler has no need of.

## Authority, not intent

The value says on whose behalf a handler runs. It does not say that the person
asked for what the handler is doing. An event a run emits carries that run's
actor forward, so a handler that another pattern invokes with a `send()` of its
own sees the user that pattern runs as, and any pattern a user runs can reach a
handler that way.

Where a handler has to know that the person made a request — a message they
sent, a setting they changed — what shows it is a trusted gesture: a write to a
position declaring a UI contract, which the runtime admits only under a trusted
UI event matching it. `currentPrincipal()` is the right tool for keying and for
refusing, not for proving consent.

An `authored-by` claim is authority in the same sense. It says that a run
acting for the principal wrote the value, through the writer its position
declares, or initialized it in one of their handler runs. It does not say that
the person asked for it. Where the position also declares a UI contract, a
write to it came under their trusted gesture, though a value initialized there
did not.

## How far the value can be trusted

The value is as trustworthy as the runtime that runs the handler.

- On a client, the client's own runtime supplies it. A modified client can
  return anything, but it could equally write any record, or mint any label,
  that its access allows, so this adds no weakness of its own.
- On a serving runtime, it comes from the stamp the memory server makes on the
  appended event, which a client cannot set. A handler that has to hold against
  a modified client has to run served.

## Its relation to the `CurrentPrincipal` label subject

The `CurrentPrincipal` placeholder in a principal claim — what
`AuthoredByCurrentUser` and `RepresentsCurrentUser` lower to, and what
`ownerPrincipal` may name — resolves when the write is prepared, to the
`actingPrincipal` of the transaction's trust snapshot. A `User` reader named
`CurrentPrincipal` resolves by its own rule, which
[the next section](#a-reader-named-currentprincipal) gives, and is not one of
the places below. Where the handler has an actor and that snapshot
names the identity the runtime authenticates as, which is the default when no
host supplies a snapshot of its own, the two agree: a label the same handler
writes names the principal `currentPrincipal()` returned.

They part in two places.

- A served run with no actor keeps the ambient trust snapshot, whose principal
  is the serving runtime's identity, where `currentPrincipal()` returns
  `undefined`. A write of such a run that would mint a placeholder claim, on a
  position that declares no `ownerPrincipal`, is refused rather than labeled
  with that identity. A value it initializes on nobody's behalf mints no claim
  and is admitted.
- A host embedding the runtime can supply its own trust snapshot naming a
  different acting principal. The placeholder then resolves to that principal,
  and `currentPrincipal()` still returns the identity the runtime authenticates
  as.

## A reader named `CurrentPrincipal`

A `User` confidentiality clause whose subject is `CurrentPrincipal` declares a
store readable by one principal, and commit preparation replaces the
placeholder with a concrete DID. Which DID depends on whether the store already
exists, and on where a new one is created.

- **A store already holding labels** keeps the readers it stores. A writer
  presenting the same symbolic declaration does not become a reader of it.
- **A document created beneath a stored parent** takes the parent's readers.
  When a transaction creates a document, writing it where nothing stood before
  in its scope, and links it into a document that existed before the
  transaction, the placeholder binds to the concrete `User`
  readers the parent's declared policy names at the position the link lands
  on. An item a second principal appends to an owner-private list is that
  case: the item becomes a document of its own, and it is bound to the list's
  owner, not to the principal who appended it. A document created beneath such
  a document in the same transaction takes the same readers, so nesting does
  not change the answer.
- **Any other new document** binds to the acting principal of the
  transaction's trust snapshot, as the integrity placeholder does. That
  includes a document beneath a parent whose policy names no `User` reader at
  that position, such as one labeled only for its space.

A principal who creates a document beneath a private store of their own gets
the same reader either way, since the store's reader is that principal.

Binding to the parent cannot widen who reads anything. The new document's
readers are the readers the parent already promised the data at that position
to, and a reader of the new document has to satisfy every clause it holds. A
writer gains no standing as a reader: what a sender appends to someone else's
private list is labeled for the list's readers, so a read ceiling admitting
only the sender withholds it.

What the binding changes is which writes fit the new document's write ceiling,
which the CFC spec's `canWrite` (§8.12.4) measures a transaction's taint
against. A transaction that read the parent carries the parent's readers in its
taint, and those now fit. Data labeled for any other reader still misfits, the
writer's own private data included, so moving it into the owner's list still
needs a declassification. SC-57 in
[the CFC spec change list](../specs/cfc-spec-changes.md) records the rule for
the spec.

## Why only in a handler

`currentPrincipal()` throws in a pattern body, a `computed()`, and a `lift()`.

- A pattern body builds one graph for every viewer, so a value read there would
  be one person's, baked in for everyone.
- A computed could read the viewer — whoever the value is being computed for.
  That value differs from one viewer to the next, so it has to be stored per
  user on every runtime, clients included. And a viewer's DID is not otherwise
  visible to pattern code, so reading one in a computed needs a label saying who
  may see it.

Until both are settled, a pattern shows the viewer by resolving `#profile`, as
[multi-user patterns](../common/patterns/multi-user-patterns.md) describes.

## Tests

`packages/runner/test/current-principal.test.ts` covers the helper on both
kinds of runtime — including the run on another user's instance, the run with no
actor, and the read scope it leaves alone — and the function in each kind of
frame, in a compiled pattern, and against an `authored-by` claim written in the
same handler. The `currentPrincipal()` case in
`packages/runner/test/executor-trust-attribution.test.ts` drives a handler
through the live serving loop, with a payload naming someone else.
`packages/runner/test/cfc/authored-by-writer.test.ts` covers the claim on a
position that declares a writer and no gesture: on a client, on a served run
with an actor and with none, reached through another handler's `send()`, and
against claims naming someone other than the acting principal.

`packages/runner/test/cfc-current-principal-confidentiality.test.ts` covers the
reader binding, under "a document created under a labeled parent": an item
another principal appends to an owner-private list, a document nested in it,
the owner's own append, a list whose policy names no `User` reader, an
existing document linked into the list, both one stored as present but
`undefined` and one whose id the transaction also creates in another scope,
and an existing store another principal writes.
`packages/patterns/integration/owner-private-inbox-multi-runtime.test.ts`
drives the same append through compiled patterns in separate runtimes, under
either server-execution posture. With server execution on, it also refuses a
stranger's served copy of the appended items.
