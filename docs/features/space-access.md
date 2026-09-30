# A principal's own access to a space

`spaceAccess(target)` tells pattern code what the principal it runs for may do
in a space: `"OWNER"`, `"WRITE"`, `"READ"`, or `"none"`, and `undefined` while
that is not known. It is what a pattern consults to decide what to offer a
person, such as whether to show the controls only an owner can use, or whether
a room it lists is one they belong to. The implementation is
`packages/runner/src/builder/space-access.ts`.

The answer is advisory. The memory server enforces every read and write against
the space's access list whatever a pattern decided, so a pattern that offers a
control on the strength of this answer has not granted anything.

## Where the level comes from

The level is the one the memory server enforces: the principal's entry in the
space's access list (the document `of:<space DID>`), else the list's `"*"`
entry, with the space's own identity holding `OWNER` without an entry.
`spaceReaderRole()` in `packages/runner/src/cfc/space-membership.ts` makes that
decision, and it is the same function the render membership lookup uses, so a
pattern, the renderer and the server resolve one list the same way.

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
into one shared slot. `spaceAccess()` narrows the scope itself rather than
leaving it to how the principal was found.

## `"none"` and `undefined`

| Answer | When |
| --- | --- |
| a level | the access list grants the principal one |
| `"none"` | the list grants the principal nothing, or, on a client, the memory server has refused the runtime the space for good |
| `undefined` | the list has not arrived, the space has no list, the run has no principal, or `target` was passed as `undefined` |

`undefined` is never a guess. A space with no access list is one the memory
server opens to any authenticated principal for compatibility, but that grant
is not membership: `spaceReaderRole()` returns no role for it, and neither does
the render membership lookup, so `spaceAccess()` agrees with both and returns
`undefined`.

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

A computation that calls `spaceAccess()` reads the access list through its
transaction, so a grant or revoke that reaches the replica runs it again like
any other read.

A refusal changes no document the computation has read, and neither does a
readmission, so on a client the call also registers the running action with the
storage manager's access-change observer (`subscribeSpaceAccessChange()`), which
runs it again through `Scheduler.invalidateAction()` when the verdict changes.
Each registration lasts until the next change for that space; a run that still
asks registers again.

A client does not ask the memory server again about a space it was refused on
its own. The session opens again when something reads a document of that space
that the replica has not asked for, and a refused principal who has since been
granted access sees a level only from then on.

## What it discloses

The answer names no principal. It tells a member only what a member can
already read, since the memory server serves the whole access list to anyone
holding `READ`, and it tells a non-member only that they are one.
