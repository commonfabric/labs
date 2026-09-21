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

The home space has no separate derived space signer: the active user identity
is itself the space identity. `StorageManager` recognizes
`space === storageManager.as.did()`, checks the space's ACL document, and—when
it is absent—uses a temporary space-authenticated session to write
`{ [space]: "OWNER" }`. It closes that bootstrap session and mounts a fresh
normal session so local sequence numbers and user/session scope partitions are
not shared with bootstrap work.

Unlike named-space bootstrap, the home path also claims a populated legacy
space with no ACL. `session.open` remains read-only; the claim is an ordinary,
conflict-checked ACL transaction. See `packages/runner/src/storage/v2.ts`.
The home ACL is owner-only. Fresh named spaces are born with the genesis
document registered beside their space key, else the rollout default
`{ [activeUser]: "OWNER", "*": "WRITE" }` until ACL management has a UI.
