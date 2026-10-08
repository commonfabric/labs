# A space's declared kind

A space may declare what kind of space it is. The kind is a fact about the
space that its creator states once, in the space's genesis commit beside its
access list, and that nothing changes afterward. A standalone FabriChat room's
space, for example, declares itself a `fabrichat-room` space. Code that has to
tell one kind of space from another reads the declared kind, and loads and runs
nothing in the space to do it.

## Declaring one

A pattern declares the kind of a space it creates with
`inSpace(name, { spaceKind })`. Host code declares one with
`Runtime.createSpace({ spaceKind })`, or with
`StorageManager.createSpace(acl, { spaceKind })` below it.

The kind is independent of the space's root. `inSpace(name, { spaceKind })`
declares a kind for a space whose root is something else, and
`inSpace(name, { root: true, spaceKind })` declares one for a space whose root
is the call's result; [`custom-space-roots.md`](custom-space-roots.md)
describes the root reservation. What a kind says about a space's root, if
anything, is that kind's own contract, which the table below states.

A kind is a lowercase word of letters and digits that starts with a letter, or
several such words joined by single hyphens, at most 32 characters long:
`fabrichat-room` and `photo-album` are kinds, while `Room`, `chat_room` and
`chat--room` are not. `isSpaceKind()` in `packages/memory/v2/space-kind.ts`
decides it. The memory server holds every declared kind to it, and `inSpace()`
refuses a kind of any other form before it creates anything. `inSpace()` also
refuses `spaceKind` with a DID or a cell, which name a space that already
exists.

The kind is part of what an `inSpace()` call asks for, beside its grants and
`root`. Until a name's allocation record is written, requests for different
kinds create different spaces for the same name. A name whose allocation
record already names a space resolves to that space, whatever kind the call
names. A kind declares what a space is when it is created; asking for a kind
later does not give one to a space created without it.

## How it is sealed

The space's own key creates the space, as
[random space identities](../specs/random-space-identities.md) describes. The
session that key opens declares the kind in its signed `session.open`
descriptor, and the genesis commit carries the same kind beside the access
list. The memory server admits a declared kind only under these rules, in
every access-control mode, `off` included:

- The commit is the space's genesis: its first commit, made by the space's own
  key, on the default branch, holding nothing but a `set` of the access list
  to a valid list naming a concrete owner. A kind on any other commit is
  refused, whoever makes it, and the commit writes nothing.
- The commit's kind equals the kind the session declared. A genesis commit
  that changes, adds or drops the declared kind is refused.
- A `session.open` that declares a kind on a space whose genesis has committed
  is refused unless the kind equals the sealed one.

Those are the rules a root reservation is held to as well. The signed
descriptor's kind is compared with the message's, so a kind cannot be added to
or removed from a signed open in transit.

The genesis receipt is never rewritten, so once a space has a kind it keeps
it. A member with `WRITE` can re-point the space's root, but cannot change its
kind.

## Reading one

`Runtime.spaceKind(space)` returns the kind `space` declares, or `undefined`
when it declares none. Once a space has history, the memory server reports
its kind in the result of every `session.open` of it that the server admits,
so whoever can open the space can read it. Under the `enforce` access-control
mode, that is whoever the space's access list admits, with any level of
access, and a principal the list admits to nothing learns nothing. The
`observe` and `off` modes admit more opens, and report the kind to each of
them.

A session that opens a space with no history yet is told nothing of the kind,
and is not told when the genesis commit lands. `Runtime.spaceKind()` reads the
kind afresh, in a session of its own, when the space's session opened that
way, so the kind it returns is the space's as it stands.

`Runtime.spaceKind()` throws when the space cannot be opened, and when the
host does not advertise the `spaceKind` capability. A host without the
capability could not have sealed a kind, and cannot report one, so the kind is
then unknown rather than absent, and the caller decides what to do about that.

A space declares no kind unless its creator gave it one. Home and default-app
spaces declare none, and neither does any space created by a host without the
capability. So no declared kind says nothing about what a space is not: a space
with no kind may well be a container that hosts a chat.

The server reads the kind from the receipt of the space's first commit. Only a
receipt holding a commit with a kind of the form above declares one. A receipt
whose kind is malformed, as a server without the capability could have kept,
declares none, and so does one holding no commit at all.

## Known kinds

A kind is a string anyone may declare, and memory gives it no meaning. Its
meaning is the contract its readers rely on, so a kind is listed here, with
that contract, before code in this repository relies on it.

| Kind | The space |
| --- | --- |
| `fabrichat-room` | A standalone FabriChat room's own space, a chat-only social space whose root is the room, at the address the space's genesis commit reserves for a root `inSpace(..., { root: true })` places ([FabriChat](../specs/fabrichat/README.md)) |

Home's share intake reads the kind: it admits an offer of a `fabrichat-room`
space only when the space declares that kind, and refuses an offer of a space
declaring another kind or none, for good, since the kind never changes. A host
that cannot tell the kind leaves the offer to be vetted again;
[the private inbox](private-inbox.md#the-share-intake) describes the intake.

A container that hosts a chat among other things declares its own kind, not
`fabrichat-room`. A kind says what a space is; it is not a list of what the
space holds, which can change after the genesis commit that seals the kind.

## What a kind does not vouch for

A declared kind is the space's creator's claim, sealed so that nobody else can
change it. The memory server checks its form and who made it, never whether
the space is what it says: a creator can declare `fabrichat-room` for a space
whose root is no chat room at all. A reader that needs more than the claim
checks the rest itself: for a `fabrichat-room` space, at least that the root
the space links is a piece of the space itself, at the address the space's
genesis commit reserves for it, since a member with `WRITE` can link another
document as the root. The share intake checks both.

## On the wire

The memory protocol carries the kind in three optional fields, `spaceKind` on
the `transact` commit, on the `session.open` descriptor, and on the
`session.open` result, and advertises it with the `spaceKind` hello
capability. [The memory protocol chapter](../specs/memory-v2/04-protocol.md)
gives the details.
