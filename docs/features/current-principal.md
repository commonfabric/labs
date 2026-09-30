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
sent, a setting they changed — what shows it is a trusted gesture, or a value
labeled `AuthoredByCurrentUser`, whose write the runtime admits only from a
reviewed writer handling a trusted UI event. `currentPrincipal()` is the right
tool for keying and for refusing, not for proving consent.

## How far the value can be trusted

The value is as trustworthy as the runtime that runs the handler.

- On a client, the client's own runtime supplies it. A modified client can
  return anything, but it could equally write any record, or mint any label,
  that its access allows, so this adds no weakness of its own.
- On a serving runtime, it comes from the stamp the memory server makes on the
  appended event, which a client cannot set. A handler that has to hold against
  a modified client has to run served.

## Its relation to the `CurrentPrincipal` label subject

The `CurrentPrincipal` placeholder in a label — what `AuthoredByCurrentUser`
and `RepresentsCurrentUser` lower to, and what `ownerPrincipal` may name —
resolves when the write is prepared, to the `actingPrincipal` of the
transaction's trust snapshot. Where the handler has an actor and that snapshot
names the identity the runtime authenticates as, which is the default when no
host supplies a snapshot of its own, the two agree: a label the same handler
writes names the principal `currentPrincipal()` returned.

They part in two places.

- A served run with no actor keeps the ambient trust snapshot, so a placeholder
  there resolves to the serving runtime's identity, where `currentPrincipal()`
  returns `undefined`.
- A host embedding the runtime can supply its own trust snapshot naming a
  different acting principal. The placeholder then resolves to that principal,
  and `currentPrincipal()` still returns the identity the runtime authenticates
  as.

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
