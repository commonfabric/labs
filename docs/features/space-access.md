# A principal's own access to a space

`spaceAccess(target)` tells pattern code what the principal it runs for may do
in a space: `"OWNER"`, `"WRITE"`, `"READ"`, or `"none"`, and `undefined` while
that is not known. It is what a pattern consults to decide what to offer a
person, such as whether to show the controls only an owner can use, or whether
a room it lists is one they belong to. The implementation is
`packages/runner/src/builder/space-access.ts`.

The answer is advisory. A memory server in `enforce` mode, which is toolshed's
default (`MEMORY_ACL_MODE`), checks every read and write against the space's
access list whatever a pattern decided, so a pattern that offers a control on
the strength of this answer has not granted anything. In `observe` mode the
server only logs an ordinary shortfall, and in `off` mode, the memory server's
own default when it is constructed without a mode, it checks nothing.

## Where the level comes from

The level is the principal's membership as the space's access list states it:
the principal's entry in the list (the document `of:<space DID>`), else the
list's `"*"` entry. A space's own DID is no exception, and holds only what the
list grants it. `spaceReaderRole()` in
`packages/runner/src/cfc/space-membership.ts` makes that decision, and it is the
same function the render membership lookup uses, so a pattern and the renderer
read one list the same way, and the same way the memory server resolves a listed
principal.

It is the access-list view, not the whole of what the memory server decides. The
server also grants `OWNER` to any configured service DID
(`MEMORY_SERVICE_DIDS`), and admits any authenticated principal to a space with
no access list for compatibility. Neither is membership. The first never arises
here, because the principal `spaceAccess(target)` asks about is always a user,
never the service, even on a serving runtime. The second is covered below.

`target` picks the space, and it is required: a call about the space the
calling code runs in passes a cell that lives there, so every call names the
space it asks about. A cell, or a value read through one, stands for the space
its value lives in, after following any links it holds, so a reference to a
piece in another space returns the level in that piece's space. A call with no
argument at all throws; the declared type refuses one as well.

## Who the principal is

| Where the call runs | Principal |
| --- | --- |
| A reactive computation (`computed()`, `lift()`) | the principal demanding the value, `Runtime.homeSpacePrincipalFor()` |
| A handler | the event's actor, `Runtime.actingPrincipalFor()` |
| A pattern body | none: the call throws |

A pattern body builds one graph that every viewer shares, so any value it baked
in would be one person's. A handler's actor is not always the principal a
computation would name: a handler running on one user's instance, fired by
another user, acts for the second.

A call in a computation narrows the computation's read scope to `user` before
it returns, on every runtime and whether or not there is a principal. The
answer differs by who asks, so its value has to live in a per-user instance; at
`space` scope, two users viewing the same piece would write their own answers
into one shared slot. `spaceAccess(target)` narrows the scope itself rather than
leaving it to how the principal was found.

The narrowing carries downstream. A computation that reads only the value of
one calling `spaceAccess(target)`, and never calls it itself, reads a per-user
document, so its own read scope is `user` as well and its value lands in a
per-user instance too. That holds on a client, and on a serving runtime, where
two principals demanding the same derived value each get their own.

## Another principal's level

`spaceAccessOf(target, principal)` returns `principal`'s level, where
`spaceAccess(target)` returns the caller's own, read from the same access list
the same way. It is a function of its own because the two answers differ in
kind: the caller's own depends on who is asking, and narrows a computation to
a per-user value; another principal's does not. A
handler that must know whether the principal a label names still belongs to
the space asks this: the Loom root lets an OWNER remove a panel whose attested
adder the list grants nothing. The answer does not depend on who is asking, so
a call in a computation leaves the computation's read scope as it was, and the
memory server's refusal of this runtime's session, which says something only
about the caller's own principal, does not enter into it: the list alone
decides, and `undefined` means it has not arrived. A `principal` that is not a
well-formed DID throws; `*` is not a principal.

## `"none"` and `undefined`

| Answer | When |
| --- | --- |
| a level | the access list grants the principal one |
| `"none"` | the list grants the principal nothing, or, on a client, the memory server has refused the runtime the space for good |
| `undefined` | the list has not arrived, the space has no list, the run has no principal, or `target` was passed as `undefined` |

`undefined` is never a guess. A space with no access list is one the memory
server opens to any authenticated principal for compatibility, but that grant
is not membership: `spaceReaderRole()` returns no role for it, and neither does
the render membership lookup, so `spaceAccess(target)` agrees with both and
returns `undefined`.

A `target` of `undefined` is a target not known yet, and returns `undefined`. A
computation that takes its target by value, rather than as a cell, reads
`undefined` for it while the value it names cannot be read, which is exactly
when the target's space is one the principal may not belong to. Were that
`undefined` read as "the calling code's own space", it would report a level in
the wrong space, typically one where the principal holds `OWNER`.

The refusal counts only on a client, where the session the memory server
refused is the principal's own. A serving runtime reads every space as that
space's owner, so its session says nothing about the principal whose level it
returns, and there the access list alone decides. Two principals demanding the
same computation on a serving runtime get their own levels.

## Keeping the answer current

A computation that calls `spaceAccess(target)` reads the access list through its
transaction, so a grant or revoke that reaches the replica runs it again like
any other read.

A refusal changes no document the computation has read, and neither does a
readmission, so on a client the call also registers the running action with the
storage manager's access-change observer (`subscribeSpaceAccessChange()`), which
runs it again through `Scheduler.invalidateAction()` when the verdict changes.
Each registration lasts until the next change for that space, or until the
scheduler unsubscribes the action; a run that still asks registers again. The
runtime owns that registration (`Runtime.spaceAccessWatch`, a `SpaceAccessWatch`
in `packages/runner/src/space-access-watch.ts`) and cancels its subscription
when it is disposed, so a storage manager that outlives the runtime keeps no
hold on it.

A client does not ask the memory server again about a space it was refused on
its own, since the refusal turns on an access list it cannot read. A host with
word that the principal has been granted access, such as a notice naming the
space, asks again with `retrySpaceAccess(space)`, on `Runtime` or, across the
worker boundary, on `RuntimeClient`. That opens the session once more through
the memory server's ordinary admission, so it admits only what that admission
would. An admission reaches the computations above through the same
access-change observer, and repeats every load the refusal failed, so a
computation that read a document of the space without calling
`spaceAccess(target)` runs again too. A refusal leaves the answer `"none"`. It
acts only on a space the runtime has opened, and asks for admission only while
that space's session is refused, one attempt per call. A session that stands is
left alone, except that loads a failed repeat left recorded are repeated. The
session also opens again when something reads a document of that space that the
replica has not asked for.

Across the worker boundary, a retry of a space asked for while another retry of
that space is still in flight shares it rather than asking again, whoever asks:
a host calling `RuntimeClient.retrySpaceAccess(space)`, or one of the two
callers built in. The renderer's "Access unavailable" placeholder carries a
Retry button, which asks for the space whose refusal it stands in for. A refusal
removes the handlers of the content it stands in for, and leaves this one. The
shell asks on the person's behalf when they may have been granted access since:
on navigating into a space the runtime reported refused (`spaceaccesslost`), and
on the page's `focus` or `visibilitychange` to visible, for every space the
runtime has reported refused, since a view can show content of a space other
than its own. Both are event-driven, with no timer behind them. While a retry of
the space is in flight, whoever asked for it, the placeholder is `aria-busy` and
reads "Retrying…" after the button. The button itself stays as it was, so it
keeps keyboard focus, and pressing it again shares the retry in flight. An
admission re-renders the refused content; a refusal leaves the placeholder as it
was before the retry. The placeholder's `data-space-access-retries` attribute
counts the space's settled retries, which is what a test waits on to know that
a retry has been decided.

## Changing the level

`spaceAccess(target)` only reads. A handler changes a principal's entry with
`grantSpaceAccess()` and `revokeSpaceAccess()`, which
[`space-access-changes.md`](space-access-changes.md) describes.

## What it discloses

The answer names no principal. It tells a member only what a member can
already read, since the memory server serves the whole access list to anyone
holding `READ`, and it tells a non-member only that they are one.

## In a pattern test

`cf test` gives the test's space an access list, so `spaceAccess(target)`
returns a level there rather than `undefined`. A multi-user test's list holds a
level per user. A single-user test's space holds no list on the store `cf test`
creates, and gets one naming the test's identity as its only OWNER; a store a
caller supplies to the runner (`TestRunnerOptions.storageHost`) keeps any list
it already holds, and that list decides the level. The test lane's storage does
not enforce the list.
[The test's space and its access list](../common/workflows/pattern-testing.md#the-tests-space-and-its-access-list)
says how a participant declares its level.
