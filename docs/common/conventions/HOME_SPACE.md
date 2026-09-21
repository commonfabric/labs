<!-- @reviewed 2025-12-10 docs-rationalization -->

# Home Space and User Identity

## Overview

The **home space** is a special space where the space DID equals the user's
identity DID. Every user has exactly one home space that is automatically
available when they authenticate.

```
Home Space DID = User Identity DID = runtime.storageManager.as.did()
```

## Identities, Home Spaces, and People

Because the home space DID and the identity DID are the same value, home spaces
and identities are one-to-one by construction. Every identity has one home
space, and every home space belongs to one identity.

An identity is a keypair, not a person. There are no accounts, so the system has
no way to know that two identities belong to the same human, or that one
identity is driven by several humans or by automation. Treating an identity as a
person is an assumption a caller layers on top, not a property the system
provides.

Work that counts people — daily active users, for example — rests on that
assumption. What the assumption costs, and what the server records about the
identity behind a session, are covered in
[`docs/features/active-user-counting.md`](../../features/active-user-counting.md).

## Purpose

The home space provides a persistent, user-owned storage location for:

- **Favorites** - A singleton list of favorited pieces that works across all
  spaces
- **Profile** - A list of the user's shared profiles, plus the chosen default
- **Spaces** - A managed list of spaces the user has created or bookmarked
- **Agent queue** - The index of the user's agent runs, and their registered
  runner
- **Settings** - User-level preferences including `defaultAppUrl`

## Favorites

Favorites are stored on the home default pattern at
`homeSpaceCell.defaultPattern.favorites`. This design means:

1. **Singleton per user** - There is ONE favorites list per user, regardless of
   how many spaces they access
2. **Cross-space** - Favorites persist and are accessible from any space the
   user visits
3. **Identity-tied** - Favorites are tied to the user's identity, not any
   particular space

### Accessing Favorites

Favorites are reached through the runtime's favorites manager
(`FavoritesManager`, exported by `@commonfabric/runtime-client`), which reads
and writes the home space's default pattern directly. A piece is addressed by
the space it lives in, its entity id there, and the scope that id resolves in,
carried as the one `FavoritePieceAddress` value since one id in two scopes is
two documents:

```typescript
// Shown for illustration only.
const favorites = rt.favorites();
const piece = { space, pieceId, scope: "space" };

await favorites.addFavorite(piece);
await favorites.removeFavorite(piece);

const entries = await favorites.getFavorites();
const unsubscribe = favorites.subscribeFavorites((list) => render(list));
```

An entry is keyed by that whole address, so favoriting the same piece twice
replaces its entry rather than adding a second one, removing it reaches that
entry whatever else the list holds, and one id favorited in two scopes holds
two entries rather than one. A space-scoped address names no scope in its key,
that being the scope an address defaults to; only a narrower scope is written,
and that elision is what keys every favorite in durable storage.

## Profile

A user can have **multiple** shared profiles (e.g. Work / Personal / Family).
The home default pattern stores them as a list, plus a chosen default and a
most-recently-used (MRU) ordering:

- `homeSpaceCell.defaultPattern.profiles` — the list of profile links (each a
  cross-space link to a `profile-home.tsx` default pattern in its own space).
- `homeSpaceCell.defaultPattern.defaultProfile` — the profile `#profile`
  resolves to in headless mode and that the picker selects by default.
- `homeSpaceCell.defaultPattern.mru` — recency-ordered links; drives ordering
  after the default.

Each profile lives in its own space, created with the anonymous
`PatternFactory.inSpace()` (CT-1650 — a *named* `inSpace(name)` would derive the
space DID from the display name alone and collide same-named profiles across
users) running `/api/patterns/system/profile-home.tsx`; the link is appended to
`profiles`. The home Profile tab renders the **profile picker**
(`profile-picker.tsx`): it lists profiles, lets the user create more inline, pick
the default, and stamp MRU. There is no `profileName` mirror field anymore.

`profiles`/`defaultProfile`/`mru` are CFC-protected profile-link data, created
through the trusted profile-create / picker surfaces. Untrusted writes are
rejected: adding/replacing a link fails the element contract, and structural
changes (truncation/removal/reorder) fail the array's container
`writeAuthorizedBy`. The inline `#profile` wish UI uses the trusted
profile-create surface for the same creation event and does not navigate away
from the current view.

Patterns can discover profile data from any space:

```tsx
// Shown inside a pattern body.
const profile = wish({ query: "#profile" });
const profileName = wish<string>({ query: "#profileName" });
const portfolioItem = wish({ query: "#portfolio", scope: ["profile"] });
```

Shared pieces that directly render viewer-specific profile data should use a
user-scoped result schema for that rendered output, so each authenticated viewer
sees their own profile.

## Spaces

The home space maintains a managed list of spaces in
`defaultPattern.spaces`. Each entry has a `name` (required) and optional `did`.
Users add spaces via the Spaces tab in the home pattern. Clicking a space link
navigates to it (creating it if it doesn't exist yet).

## Agent Queue

The home default pattern holds the user's agent queue in
`defaultPattern.agentQueue`, a piece of
`packages/patterns/system/agent-queue.tsx`. It is discovered with
`wish({ query: "#agent_queue" })`, a well-known home-space target. A hashtag
search does not find it, because under `scope: ["~"]` that search reads the
user's favorites only, and the queue is not a favorite.

The piece holds two things:

- `entries` - one `{ run, host }` entry per `AgentRun` record the user has
  submitted, across spaces and toolsheds. The `agent` builtin adds an entry
  when a request commits, as an element addressed by the record's id
  (`elementById` and `addUnique`, the way favorites are keyed), so two requests
  indexed side by side land as two elements. `run` links to the record in the requesting space;
  `host` is the origin of the toolshed serving that space, carried beside the
  link because a link resolves a space and not the host that serves it.
- `agentRunner` - the user's registered runner:
  `{ host, tools, registrationId, registeredAt, lastClaimAt }`.
  `cf agent runner` writes it
  when it starts and refreshes it on every claim. It is owner-protected the way
  the profile's share-inbox pointer is: the only writer is the piece's
  `setAgentRunner` stream, and only the owner may send it. Cleanup names the
  process's `registrationId`, so a stopped process cannot clear a replacement
  registration. It holds no secret.
  It exists so a consumer can say that no runner is registered, and so the
  `agent` builtin can fail a request naming a tool the runner does not offer
  before the request is staged.

A request made in a home space that holds no queue — its home pattern does not
exist, or is a version without the field — ends `refused`.
[`docs/common/capabilities/agent.md`](../capabilities/agent.md) describes the
request side.

## Custom Home Pattern

The home space's default pattern is the home experience itself — by default,
`/api/patterns/system/home.tsx`. You can replace it with a custom pattern using
the CF CLI:

```bash
# Run its automated pattern test
cf test ./my-home.test.tsx

# Deploy a custom home pattern with the test attached
cf space set-home -i ./my.key -a http://localhost:8000 \
  --test ./my-home.test.tsx ./my-home.tsx

# Reset to the system default
cf space set-home -i ./my.key -a http://localhost:8000 --reset
```

Write automated tests for new or changed home-pattern behavior. Repeat
`--test` for every authored test entry. Deployment packages and type-checks
the tests but does not run them, so run each entry with `cf test` first.

Under the hood, `set-home` calls `PiecesController.recreateDefaultPattern()`
with the compiled program. This tears down the existing default pattern, creates
a new piece from the custom source, and links it as the space's
`defaultPattern`.

### Identity Matching

The home space DID equals the user's identity DID. This means **the CLI identity
must match the browser identity** for `set-home` to affect what the browser
displays.

That equality is also the ACL bootstrap authority. When remote storage finds no
ACL for the home space, it opens a temporary session with the same identity and
writes `{ [homeSpaceDid]: "OWNER" }` before returning the normal session. This
also privatizes a populated ACL-less legacy home; named legacy spaces remain
public under the temporary compatibility rule.

For local development, prefer one shared PKCS8/PEM key imported into the browser
and exported through `CF_IDENTITY` for CLI commands. The browser login screen has
an `Import CLI Key` option for this workflow. See
[`docs/features/shared-identity.md`](../../features/shared-identity.md).

The browser shell derives identity from a mnemonic via
`Identity.fromMnemonic()`, while `cf id derive` uses
`Identity.fromPassphrase()`. These are different algorithms — the same input
produces different DIDs.

To share identity between browser and CLI:

```bash
# 1. Create a mnemonic in the browser (login/register screen)
# 2. Export a matching CLI key with `cf id from-mnemonic`, reading the phrase
#    from a file (`-- <file>`; or `-` for stdin) so it stays out of shell
#    history and the process list:
deno run -A packages/cli/mod.ts id from-mnemonic -- phrase.txt > ./browser.key

# 3. Use that key with cf, retaining the tested source package
cf space set-home -i ./browser.key -a http://localhost:8000 \
  --test ./my-home.test.tsx ./my-home.tsx
```

Note: `cf id derive <passphrase>` will NOT produce the same identity as the
browser — it uses `Identity.fromPassphrase()`, whereas browser mnemonic login
and `cf id from-mnemonic` use `Identity.fromMnemonic()`. Use `from-mnemonic` to
get a PKCS8 key that matches the browser's identity.

## Default App URL

The `defaultPattern.defaultAppUrl` setting controls which pattern is used as the
default app when creating new spaces. When `PiecesController.ensureDefaultPattern()`
runs for a non-home space, it reads this value from the home space. If set, the
custom URL is used; otherwise it falls back to
`/api/patterns/system/default-app.tsx`.

This enables users to maintain personal forks of the default app pattern (e.g.,
`default-app-ben.tsx`) with different features or configurations.

## How Default Patterns Work

Both the home pattern and the default app pattern follow the same mechanism:

1. When a space is opened, `PiecesController.ensureDefaultPattern()` checks if
   a `defaultPattern` piece already exists on the space cell
2. If not, it creates one:
   - **Home space** (`space === userIdentityDID`): uses
     `/api/patterns/system/home.tsx`
   - **Profile space** (explicit profile creation path): uses
     `/api/patterns/system/profile-home.tsx`
   - **Other spaces**: reads `defaultAppUrl` from the home space; falls back to
     `/api/patterns/system/default-app.tsx`
3. The pattern is compiled, run, linked as `spaceCell.defaultPattern`, and its
   source URL is stamped as `patternSource` for future updates
4. `recreateDefaultPattern()` can replace it — either with a URL-based pattern,
   which also stamps `patternSource`, or a custom `RuntimeProgram` (used by
   `cf space set-home`), which remains untracked by the URL updater and may carry
   a separate repository locator
5. Before an existing eligible root starts, it is reconciled in place. A root
   with stored `patternSource` tracks that source. A pre-provenance root is
   admitted only when its stored `{ identity, symbol }` exactly matches the
   current official entry's advertised content identity for that space;
   otherwise it remains pinned. The exception is a sourceless root the current
   runtime explicitly cannot load: it is replaced by the current system root,
   and its displaced identity is recorded for recovery. Repository-pinned
   sourceless roots always remain pinned.


Runtime internals (ACL initialization, PiecesController home-space detection)
are
documented in [docs/features/home-space-internals.md](../../features/home-space-internals.md).
