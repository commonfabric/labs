# DIDs, and what counts as one

A space is named by a DID, a person is named by a DID, and several surfaces
accept either a space DID or a human-readable space name in the same argument.
So "is this string a DID?" is a question the codebase asks in many places, and
every place has to answer it the same way. This document is that answer.

## The rule

**A string is a DID when it starts with `did:`, compared exactly.**

Nothing else about the string is consulted. The method name, the
method-specific identifier, the number of colons, and every character after the
prefix are free. `did:key:z6Mk…` is a DID; so are `did:web:example.com:8080`,
`did:key`, and `did:` on its own. `DID:key:z6Mk…` is not a DID — the prefix is
compared character for character, so a differently-cased prefix makes some
other string. Neither is ` did:key:z6Mk…`, which begins with a space.

The rule is deliberately loose. Everything the runtime is handed as a DID
either came from a signer that minted it or is about to be handed back to one
that will reject it, and the surfaces this predicate serves are routing
decisions — which of two branches a string takes — rather than validation. A
narrower predicate would send a DID the routing does not recognize down the
branch for names, and that branch derives a *different* space from the same
string.

## Where it lives

`@commonfabric/identity/did` is the module. It imports nothing, so any package
can reach it without loading key material, and `@commonfabric/identity`
re-exports all of it for callers that already depend on the package as a whole.
Import the DID vocabulary from the `/did` entry point.

| Export | What it is |
| --- | --- |
| `isDID(value)` | The rule above, as a type predicate over `unknown`. |
| `isDIDKey(value)` | The same test against `did:key:`, for a caller that supports only that method. |
| `isWellFormedDID(value)` | A DID in DID Core syntax, at most 256 characters: the narrower question below, asked where a DID is shown or read as a principal. |
| `parseDID(value)` | The DID split into `method` and `id`, or `undefined` when it is not a DID. |
| `assertNotDID(value, role)` | Throws when `value` is a DID. `role` opens the message: `assertNotDID(name, "A space name")`. |
| `DID_PREFIX`, `DID_KEY_PREFIX` | The literal prefixes, for a caller that has to slice or restate them. |
| `DID`, `DIDKey` | The types, `` `did:${string}` `` and `` `did:key:${string}` ``. |

`parseDID` is the one way to take a DID apart. `did:key:z6Mk…` parses to method
`key` and id `z6Mk…`; `did:web:example.com:8080` parses to method `web` and id
`example.com:8080`, because everything after the method's colon is the
identifier. A DID with no second colon parses to an empty identifier.

A pattern is the exception, and it is a hard one. A pattern compiles against
the `commonfabric` module and nothing else, so it cannot reach this module at
all. A pattern that has to inspect a DID states the shape it accepts in its own
source, and says which shape that is and why, the way
`packages/patterns/system/profile-home.tsx` pins a share inbox pointer to a
`did:key`. The `DID` type is available to a pattern, since `packages/api`
declares a standalone copy of it.

## Asking a narrower question

A caller that needs more than "is this a DID" asks for it explicitly, on top of
these, and says at the point of asking why the narrower question is the right
one. `packages/toolshed/lib/space-authority.ts` is the worked example: the
space DID it is handed becomes an ACL document key, a channel-id input, and an
on-disk filename all at once, so it pins the string to
`^did:key:z[1-9A-HJ-NP-Za-km-z]{20,120}$` and says so. That is a different
question from `isDID`, and it is not a reason to make `isDID` stricter.

Two more sites ask a narrower question of their own. The memory server refuses
to provision a store for a space that is not `^did:[^:]+:[^:]+$`, and the
harness reads a space DID off a store file's name under the same shape. Both
strings go on to name a file on disk, and a string that proves nothing about
which space a file holds must not be read as proving one.

`isWellFormedDID` is the narrower question for a DID a person sees or a claim
names as its principal. `isDID` admits whitespace, zero-width and
direction-override characters, and uppercase method names after `did:`, so two
spellings of one principal could both pass, or a room could make a principal
read as something it is not. The custody seal shows its seats and readers
through it, and `representsPrincipalSubject` in
`packages/runner/src/cfc/represents-principal.ts` reads a `represents-principal`
subject only when it holds.

## Values that must not be a DID

The mirror of the rule. A space is addressed either by its DID or by a name,
and a name is turned into a DID by deriving a key from the name itself
(`createSession` in `packages/identity/src/session.ts`). A name that is also a
DID therefore addresses one space when it travels as a name and a different
space when it travels as a DID — the same string, two spaces, decided by the
route it took.

Every surface that accepts "a DID or a name" splits on `isDID` and routes each
to its own handling. A surface that accepts only a name refuses a DID rather
than deriving a space from one. `assertNotDID` is how it does that where a
generic message will do:

- `createSession({ spaceName })` — the derivation itself, and the backstop
  under every other named-space path.
- `appViewToUrlPath` and `isAppView` in `packages/navigation/src/view.ts` — a
  view's URL is read back by `urlToAppView`, which routes a DID-shaped first
  segment to `spaceDid`, so a DID-shaped name would not survive the round trip.
- `deriveSpaceDid` in `packages/state-inspector/discover.ts`, and
  `cloneIntoNewSpace` in the piece menu — both derive a key from a name and
  also show or address that name elsewhere.

A surface with something better to say tests `isDID` and raises its own error.
The harness console's `--fabric-space` is the example: its message names
`assign_slug` and says that a URL is composed from the space's name, which is
the fact its caller needs and a generic message cannot carry.

Refuse a DID at any new surface that takes a space name, an identity name, or
anything else a DID would be mistaken for. Failing at the surface costs one
error message; not failing costs a durable write to a space nobody meant.
