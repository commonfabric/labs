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
  cross-space link to a `profile-home.tsx` piece in its own space).
- `homeSpaceCell.defaultPattern.defaultProfile` — a slot holding, under
  `profile`, the link to the profile `#profile` resolves to in headless mode and
  that the picker selects by default; no `profile` while none is chosen. The
  link sits under a key because a handle to a cell whose root holds a link
  denotes the cell that link names, so a link stored at the root could be set
  once and never re-pointed.
- `homeSpaceCell.defaultPattern.legacyDefaultProfile` — a default chosen before
  the slot, kept as a link at the root of its cell. It is the default while the
  slot holds none, and nothing writes it. A home that has not yet run with the
  slot keeps its default this way in `defaultProfile` itself; `#profile` reads
  it from there, and the picker it shows for such a home offers no "Set
  default".
- `homeSpaceCell.defaultPattern.mru` — recency-ordered links; drives ordering
  after the default.

Each profile lives in its own space, created with the anonymous
`PatternFactory.inSpace()` — one allocation per creation, each a new space with
a random DID owned by the creating user and writable by anyone, since its ACL
grants the wildcard `"*"` WRITE: a runtime showing a profile writes into the
profile's space, so a visitor needs more than READ. CFC owner-protects the
profile's data fields, and its view state is per session; nothing else in the
space is protected from a visitor (a *named* `inSpace(name)` would put every
profile created under one name in one space) —
running `/api/patterns/system/profile-home.tsx`; the link
is appended to `profiles`.

The create passes `root: true`, so the profile is its space's root: the space's
genesis commit reserves the root's address, the space cell's `defaultPattern`
links the profile there, and a host holding only the profile space's DID
reaches the profile as it reaches any space's root. A profile space whose
genesis reserved no root, which is every profile space created before the
create passed `root: true`, has no profile as its root, and its profile is
reached only through a link to it, such as the one in `profiles`. The home Profile tab renders the **profile picker**
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

## Private Inbox

The home default pattern holds the user's private inbox in
`defaultPattern.privateInbox.piece`: a share inbox piece, in a space of its own,
where other people deliver offers to the user. The user has one inbox, whichever
side creates it. The host sends Home's `ensurePrivateInbox` stream the first
time a runtime worker brings up Home, and again at the worker's next bring-up of
Home if that ensure failed, and decides by one profile: the first, in the order
`#profile` answers in (the default, then the MRU list, then `profiles` list
order), that points at an inbox. A loom daemon decides by the profile `#profile`
answers with too. Home keeps an inbox it holds while that profile points at it,
or while no profile points at an inbox. Otherwise the host vets the inbox that
profile points at, such as a loom daemon's, as a loom daemon vets one; Home
adopts it if it passes, and moves an inbox it held to
`defaultPattern.retainedPrivateInboxes`, a list kept so that what senders
delivered there stays readable. The host's share intake follows the offers in
the inbox Home holds and in each one it retains, vets each as the user, and
registers each one that passes in Home's shared-space catalog through Home's
`registerSharedSpace` stream; it leaves every offer in its inbox. Home creates
an inbox from `packages/patterns/system/private-inbox.tsx` only when it holds
none and no profile points at one. An inbox that fails vetting is neither
adopted nor replaced, and Home keeps what it holds, or holds none. While Home
holds an inbox, it points each profile that points at no inbox at it, through
the profile's `inbox` field, which is how a sender finds it, and leaves a
profile pointing at another inbox as it is. While it holds none, as after a
failed vetting, a profile that points at no inbox stays unpointed. A failed
vetting is recorded in `defaultPattern.privateInboxRefusal`, under `refusal`:
the host's reason code, a link to the refused inbox, and when Home first
recorded it. Each ensure, which is to say the next bring-up of Home in a runtime
worker, clears it when Home adopts or creates an inbox, when the deciding
profile points at the inbox Home holds, or when no profile points at the refused
inbox any longer. Nothing else clears it automatically in between, though the
owner's own code can also clear it, or record a refusal, by sending Home's
`ensurePrivateInbox` stream. It is read from Home's root like any other field of
Home, the root being the link the `#default` wish answers with, as "Custom Home
Pattern" below says. A profile created once Home holds the inbox is pointed at
it as it is created; one created earlier is pointed by the next ensure. Home
decides only when an ensure runs, so a pointer that moves is decided at the
first bring-up of Home in the next runtime worker to start, once the current
worker's ensure has succeeded. A loom daemon does the same in the other
direction, adopting the inbox a profile advertises and never replacing a pointer
to a different one. [The private inbox](../../features/private-inbox.md)
describes the whole arrangement.

## Spaces

The home space maintains a managed list of spaces in
`defaultPattern.spaces`. An entry with a `did` opens that space, and its `name`
is only what it is called; two entries may share a name. Users
create spaces from the Spaces tab in the home pattern, which gives each new
space a random DID and adds its entry. Clicking a space link opens the space by
its DID. Opening a space never creates one; the one exception is the user's
own Home space, which is initialized on its first open (see
[Identity Matching](#identity-matching)). An entry is a label and a route and
grants nothing: the space's own access-control document decides who may use it.

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

Home's **Agent runs** tab renders this queue beside Spaces, Favorites, Profile,
and Self. Each row shows its task, state, age, and available token usage.
Reported cost and estimated cost have separate labels; an unavailable estimate
shows the harness's withheld reason when supplied. Missing counters and costs
remain unavailable rather than displaying zero. Relative ages share a one-minute
clock from `#now/60`.

**Cancel** records `cancelRequestedAt` on the selected run. The row shows
"Cancellation requested" while the runner settles the request; the action does
not change the run's state or outcome. A terminal run has no Cancel action. When
no runner is registered, the tab explains that requests remain queued until one
starts. A queue with no entries shows "No agent runs yet."

A request made in a home space that holds no queue — its home pattern does not
exist, or is a version without the field — ends `refused`, and
`wish({ query: "#agent_queue" })` there resolves to nothing.
[`docs/common/capabilities/agent.md`](../capabilities/agent.md) describes the
request side.

## Chat Manager

The home default pattern holds the user's FabriChat manager in
`defaultPattern.chatManager`, a piece of
`packages/patterns/fabrichat/manager.tsx`. It is discovered with
`wish({ query: "#chatManager" })`, a well-known home-space target, and
satisfies the `ChatManagerOutput` contract
([FabriChat](../../specs/fabrichat/ChatManagerOutput.md)). Like the agent
queue, it is not a favorite, so a hashtag search does not find it.

It holds the user's index of chat rooms: `rooms`, every room they belong to and
haven't forgotten; `direct`, the direct room shared with each counterpart, by
principal; `requests`, the outcome of each request but a report that a notice
was delivered, which records none; and `outgoingNotices`, the notices its
requests produced for a client to deliver. It creates each room as the root
of a space of its own. Everything it holds is private to the user, as the home
space is.

Home holds it but renders it nowhere of its own: a page shows it at its path
in home's result, `chatManager`, with the user's rooms, each a link that opens
the room as a page of its own, and the controls that start a direct or a group
chat.

A home space whose system home pattern was set up before it held a chat manager
holds none until the home space is next opened, since nothing updates a piece
nobody opens, and the wish does not open it; a custom home pattern
([Custom Home Pattern](#custom-home-pattern)) holds one only if it says so.
Until then `wish({ query: "#chatManager" })` reports an error naming both
remedies, rather than resolving to nothing.

Home hands the manager its shared-space catalog ([Shared-space
catalog](../../features/shared-space-catalog.md)), and the manager registers
there each room it creates, and each room a manager created that it accepts, as
a `fabrichat-room` entry.

## Custom Home Pattern

The home space's default pattern is the home experience itself — by default,
`/api/patterns/system/home.tsx`. A Home is created once, on its user's first
open, and from then on it owns account data: profiles, favorites, navigation,
the shared-space catalog and the private inbox pointer. It is changed only in
place, with `cf piece setsrc` on its root, which retains that data. Nothing
but that first open creates the root of an identity Home, and nothing replaces
or unlinks it: root recreation refuses a Home before stopping, unlinking or
compiling anything, whether the Home is absent, installed, or pointing at a
target that cannot currently be loaded, and the low-level link and unlink
refuse to replace or drop a root a Home holds. (`cf space set-home` is
retired; see
[Retired: `cf space set-home`](../../../packages/cli/README.md#retired-cf-space-set-home).)

To run custom Home source, open the Home once so it exists, find its root, and
update the root in place with the complete authored source and its tests. The
system Home exports no piece registry, so `cf piece ls` does not list its
root; the `#default` wish answers with the root's link without starting it:

```bash
# Run its automated pattern test
cf test ./my-home.test.tsx

# The Home space is the identity's DID; the root is the link the wish answers
cf wish '#default' -i ./my.key -a http://localhost:8000 \
  -s "$(cf id did ./my.key)" --select @

# Update the existing Home in place, retaining the tested source package. The
# wish answers with a relative reference, so the Home space is named here too.
cf piece setsrc -i ./my.key -a http://localhost:8000 \
  -s "$(cf id did ./my.key)" --cell <home-root> \
  --test ./my-home.test.tsx ./my-home.tsx
```

Write automated tests for new or changed home-pattern behavior. Repeat
`--test` for every authored test entry. Deployment packages and type-checks
the tests but does not run them, so run each entry with `cf test` first.
Compatible source changes retain the Home's owned cells; incompatible changes
require an explicit migration, rehearsed on a `cf space clone` first.

A Home updated with `setsrc` is detached: it records no origin, so the
automatic system-source updates pass it by, which is what a custom Home wants.
A standard Home should instead follow the system source, with the same
identity, host and Home space:

```bash
cf piece follow -i ./my.key -a http://localhost:8000 \
  -s "$(cf id did ./my.key)" --cell <home-root> system:system/home.tsx
```

That adopts the current system pattern and records the origin for future
updates (`packages/cli/README.md`, "Following a piece source").

### A Home that will not load

There is no supported reset. A Home that misbehaves is repaired in place, and
the first step is to say which kind of trouble it is:

1. **The root's source will not load** — the browser shows the Home failing
   to start, or the in-place update reports that the stored source cannot be
   loaded for its compatibility check (the
   [stale source closure](../../development/debugging/gotchas/stale-source-closure-cfhelpers.md)
   gotcha is the common cause). Find the root with the `#default` wish as
   above. A standard Home rejoins the system source with `cf piece follow`,
   as above, so that it keeps receiving updates; a custom Home takes
   `cf piece setsrc` with its authored source and tests, with the same
   identity, host and Home space. Either command refuses when the old source
   cannot be loaded to compare against: rehearse the repair on a clone of the
   space (`cf space clone`, then `verify` and `reset`), and only then run the
   real one with `--dangerously-allow-incompatible-schema`.
2. **Storage is refusing every commit** — nothing in the space can be
   written, not only the Home, and the server's own health says so. That is
   not a Home problem; no operation on the root helps, and the fix is on the
   server (a restart of the engine serving the space). Do not touch the root.
3. **Neither** — the root loads and commits land, but the Home is wrong.
   That is a bug in the Home pattern or its data, and is fixed as one.

A Home that is truly unrecoverable has no supported path. The only low-level
option, a direct write clearing the space cell's `defaultPattern` followed by
a first open, is not an account operation: it loses profiles, favorites,
navigation and the catalog, and it leaves every outside record that named the
old Home (loom's inbox binding, lobby entries) pointing at the wrong profile.
Until a recovery contract that carries those forward is designed, that call is
the platform owners', not an operator's.

### Identity Matching

The home space DID equals the user's identity DID. This means **the CLI identity
must match the browser identity** for a source update to affect what the
browser displays.

That equality is also the ACL genesis authority. When the home space has no ACL
document and no history, remote storage opens a temporary session with the same
identity and writes `{ [homeSpaceDid]: "OWNER" }` before returning the normal
session. A home space that has history but no ACL document is opened as it
stands: the memory server grants a space's own DID OWNER only while the space
has no history, so its user cannot claim it, and it stays public under the
temporary compatibility rule, like a named legacy space with no ACL document,
until an operator gives it one with `cf acl set`, as a memory service identity.

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

# 3. Update the existing Home in place, retaining the tested source package
cf piece setsrc -i ./browser.key -a http://localhost:8000 \
  -s "$(cf id did ./browser.key)" --cell <home-root> \
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
   a `defaultPattern` piece already exists on the space cell. Through
   `RuntimeClient.getSpaceRootPattern()`, which is how the shell opens a space,
   a space whose genesis reserved no root, and which has none, gets one only
   from an open that runs the root (`start` true) by an identity that owns the
   space, as its Home or as an `OWNER` in its access list. For such a space,
   the open of any other principal the space admits, and any read with `start`
   false, returns `undefined` and writes nothing, so a visitor never puts a
   root in someone else's space. A principal the space refuses gets that
   refusal instead, whether or not the space has a root. An open or a read of
   a DID no space answers to, other than the identity's own Home, throws
   `SpaceNotFoundError` and creates nothing. A space whose genesis
   reserved its root, as a profile's space does, gets that root from the run of
   its creator's `inSpace(..., { root: true })` call
2. If not, it creates one:
   - **Home space** (`space === userIdentityDID`): uses
     `/api/patterns/system/home.tsx`
   - **Profile space** (explicit profile creation path): uses
     `/api/patterns/system/profile-home.tsx`
   - **Other spaces**: reads `defaultAppUrl` from the home space; falls back to
     `/api/patterns/system/default-app.tsx`
3. The pattern is compiled, run, linked as `spaceCell.defaultPattern`, and its
   source URL is stamped as `patternSource` for future updates
4. `recreateDefaultPattern()` replaces a non-Home root, and refuses an identity
   Home, absent or present, which is created on first open and updated in
   place. A URL-based pattern stamps `patternSource`; a custom `RuntimeProgram`
   remains untracked by the URL updater and may carry a separate repository
   locator
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
