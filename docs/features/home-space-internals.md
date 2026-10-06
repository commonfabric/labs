# Home Space Runtime Internals

Implementation details behind the home-space behavior described in
[`docs/common/conventions/HOME_SPACE.md`](../common/conventions/HOME_SPACE.md).

## Runtime Configuration

The runtime exposes `userIdentityDID`, the user's actual identity DID (distinct
from the current space DID). It is not a constructor option — the runtime
derives it internally from the storage manager's identity:

```typescript
// Shown inside a pattern body.
const runtime = new Runtime({
  apiUrl,
  storageManager,
});
// Derived internally: runtime.userIdentityDID === storageManager.as.did()
```

## Profile warming

The preload lives in `runtime-client`, where the authenticated browser worker
owns the session and can pair startup with disposal. Keeping it there makes
Home warming a browser-session optimization; the shared runner supplies
request-time readiness for browser, server, and CLI callers.

The authenticated browser worker starts a read-only subscription to
`Home.defaultPattern.profiles` during initialization. Its schema reads only
`name`, `avatar`, and `initialNameApplied` from each profile. Roster changes warm
new entries; unrelated profile content is outside the subscription.

The subscription belongs to the worker's authenticated identity, independently
of the space being viewed. Worker initialization returns without waiting for
the loads, and disposal cancels the subscription. It neither creates a Home
pattern nor creates a profile. Wish still checks document readiness when
resolving a request, because a preload can be incomplete or fail.

## ACL Initialization

The home space has no separate space signer: the active user identity is itself
the space identity. `StorageManager` recognizes
`space === storageManager.as.did()`, checks the space's ACL document, and—when
it is absent and the space has no history—uses a temporary space-authenticated
session to write `{ [space]: "OWNER" }`. It closes that bootstrap session and
mounts a fresh normal session so local sequence numbers and user/session scope
partitions are not shared with bootstrap work. `session.open` remains
read-only; the claim is an ordinary, conflict-checked ACL transaction. See
`packages/runner/src/storage/v2.ts`.

A populated Home space with no ACL document is left as it stands: the memory
server grants a space's own DID OWNER only while the space has no history, so
nothing on the client can claim it. Every other space is born through
`Runtime.createSpace()`, with a random DID and the genesis document
`{ [creator]: "OWNER" }` plus any grants the creator chose. The home ACL is
owner-only.

## The space list

The Home pattern's `spaces` list holds one entry per space the user keeps. An
entry with a `did` opens that space, and its `name` is only what the entry is
called: entries are keyed by DID, so two may share a name, and renaming one
(`renameSpace`) changes nothing but its name. Creating a space from Home
(`cf-space-create`, which calls `RuntimeClient.createSpace(label)`) creates the
space, adds its entry through `addSpace` under the label, and records the
space's serving origin in the site table. An entry without a `did` was written
by name — before spaces had random identities, or by an older sender of
`addSpace` — and its name resolves as a legacy space name; the runtime worker
replaces each such entry, once per worker, with one keyed by the DID the name
has always resolved to (`adoptSpace`). The entry's shape is the one the list
has always had, so every stored entry still reads. An entry is a label and a
route and never authority: anything with Home write access can add one, and it
grants nothing.
