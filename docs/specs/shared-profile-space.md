# Shared Profile Space

## Status

Implementation spec — **partially superseded** by multi-profile support
(PR #3830). This document describes the original *single* shared profile linked
at `homeSpaceCell.defaultPattern.profile`. The home space now stores a **list**
of profiles (`defaultPattern.profiles`) plus `defaultProfile` and a
recency-ordered `mru`, and `#profile` resolves the default (then by MRU) and
launches a picker for 2+ profiles. For the current model see
`docs/common/conventions/HOME_SPACE.md` (Profile section) and
`docs/common/conventions/wish.md` (Well-Known Profile Targets). The per-profile
*space* shape, owner-protection, and `wish()` resolution described below still
hold per profile.

This document captures the target behavior for shared user profiles across
multi-user patterns. It is intended to drive implementation across home-space
schema, profile-space creation, default-pattern selection, `wish()` resolution,
authorization, and integration tests.

## Summary

Multi-user patterns should not ask each user for their display name and avatar
inside every pattern. A user has one shared profile space, linked from their
home space. Patterns can discover profile data and profile-hosted pieces through
`wish()` without knowing the profile space DID up front.

The profile is a real space. Its `spaceCell.defaultPattern` is a new
profile-specific default pattern, not the normal space default app. The profile
default pattern initially owns:

- the profile owner's name and avatar
- a list of profile elements, implemented as pieces in the profile space
- owner-only handlers for adding profile elements from a fixed catalog or a
  pattern URL

The user's home space links to the profile through a well-known field on the
home default pattern, following the same durable field pattern as favorites. If
the link is missing, the home pattern renders a profile-name input. Submitting a
name starts the profile default pattern in a new profile space via
`PatternFactory.inSpace(...)` and stores the created profile default-pattern link
on the home default pattern.

`wish()` gains a profile search scope for hashtag queries. A profile-scoped wish
searches pieces in the current user's profile space whose descriptions or user
tags contain the requested hashtag, analogous to the existing favorites and
mentionables hashtag paths.

Patterns that render viewer-specific profile data from a shared space should
make that rendered result user-scoped. For example, a shared demo pattern that
directly renders `wish({ query: "#profileName" })` should use a user-scoped
result schema so each viewer sees their own profile projection.

## Goals

- Provide one durable profile per authenticated user.
- Keep profile data separate from ordinary home-space settings and from
  per-collaboration-space data.
- Make profile discovery work from any space the user visits.
- Let profile owners add profile elements without exposing direct mutation of
  the profile element list.
- Add an integration test that creates a profile and proves a demo multi-user
  pattern can render the user's shared name.
- Make `wish({ query: "#profile" })` resolve to the current user's profile
  default pattern. Existing learned-summary consumers must migrate to a more
  explicit target before relying on this feature.

## Non-Goals

- Replacing the home space. The home space remains the user's singleton root for
  settings, favorites, spaces, and the profile-space link.
- Designing a full rich profile data model. The first profile default pattern
  only needs name, avatar, and add-element mechanics.
- Migrating every current profile-like pattern in one change.
- Making `wish()` scope strings part of the cell storage scope lattice. This
  document uses "wish scope" for search domains; it is separate from
  `space | user | session` cell instance scopes.

## Current Repo Facts

- `Runtime.getHomeSpaceCell()` creates the home space cell at
  `(space = userIdentityDID, cause = userIdentityDID)`.
- `PiecesController.ensureDefaultPattern()` links a default pattern at
  `spaceCell.defaultPattern`. Today it chooses `system/home.tsx` for the home
  space and `system/default-app.tsx` for other spaces.
- The current home pattern owns durable cells such as `favorites`, `journal`,
  `learned`, `spaces`, and `defaultAppUrl` on the home default pattern.
- The current docs say favorites are on `spaceCell.favorites`, but current code
  uses `homeSpaceCell.defaultPattern.favorites`. The implemented profile flow
  follows that actual shape and stores the profile link at
  `homeSpaceCell.defaultPattern.profile`.
- `PatternFactory.inSpace(space?: string | AnyCell<unknown>)` exists. DID
  strings and cell arguments resolve synchronously; named spaces and omitted
  spaces resolve during async action/handler post-run. Post-run resolution
  replaces the runtime annotation itself with the resolved DID; unresolved names
  must not survive outside the handler frame.
- `wish()` currently supports scope values `"~"` for home favorites, `"."` for
  current-space mentionables, and arbitrary DIDs for other spaces.
- The string `#profile` was previously a well-known home target that resolved
  to `home.defaultPattern.learned.summary`. This implementation intentionally
  retargets it to the profile default pattern so profile-aware patterns have a
  direct well-known profile entry point.

## Data Model

### Home Default Pattern Link

Add a well-known field to the home default pattern:

```ts
// Shown at module scope.
// v1 single-profile shape (historical). Superseded by multi-profile support
// (PR #3830): the home default pattern now carries
//   profiles: Cell<ProfileDefaultPattern>[]; defaultProfile; mru
// and there is no `profileName` mirror field — see HOME_SPACE.md for the
// current shape. The per-profile space behavior described below still holds.
type HomeDefaultPattern = {
  favorites: Favorite[];
  profile?: Cell<ProfileDefaultPattern>;
  profileName?: string;
};
```

`profile` is a cell link to the profile default pattern. The linked cell lives
in the profile space, so its normalized link carries the profile space DID:

```ts
// Shown for illustration only.
homeSpaceCell.defaultPattern.profile -> profile default pattern cell
```

`homeSpaceCell.profileSpace` is not part of the target v1 shape. Earlier
implementation notes used that name for the durable link, but the implemented
home-field convention is `homeSpaceCell.defaultPattern.profile`.

### Profile Space Identity

Profile creation uses the **anonymous** `PatternFactory.inSpace()` (CT-1650):

```ts
// Shown inside a pattern body.
const profile = ProfileHome.inSpace()({ initialName: name });
```

The argument MUST be omitted. A *named* `inSpace(spaceName)` derives the space
DID from `Identity.fromPassphrase("common user").derive(spaceName)` (the
`createSession` spaceName path) — the name ALONE, ignoring the authenticated
user — so two users picking the same profile name, or one user creating two
same-named profiles, collide into a single shared space. That named path
supports the legacy space names used during development and nothing else, and is
removed once those development-only spaces have been migrated
([random space identities](../plans/random-space-identities.md)). The anonymous
case
instead derives a fresh DID from the creating handler's frame cause (per-user
home-space input links + the durable per-event id), so the space is unique per
user AND per creation event, stable across the cross-space-commit retry. The
display name is therefore independent of the space identity: it flows to
`initialName`, which the profile shows until a name is stored in the profile's
`name` cell, and into that cell itself at creation. The cell is initialized
statically so it keeps its identity — and the name saved in it — across
releases of the profile pattern; the create handler queues a second step
(`seedProfileName` in `profile-create.tsx`, addressed by the new entry's
position in `profiles`) that stores the creation name through `setName`, the
cell's owner-protected writer, once the profile's docs have loaded, so
`#profile` readers find the name in storage without running the profile. A profile renamed under
an earlier release, whose `name` cell was derived from `initialName`, loses
that saved name once, at its first release under the static initializer, and
keeps every name saved after. The home default pattern's `profile` link is
the durable source of truth after creation, and runtime-only `.inSpace`
annotations are rewritten to the resolved DID during post-run.

### Profile Default Pattern Output

The initial profile default pattern should export this contract:

```ts
// Shown at module scope.
import type { Cell, RequiresIntegrity } from "commonfabric";

type ProfileElement = {
  cell: Cell<unknown>;
  tag: string;
  userTags: string[];
  title?: string;
  source?: "catalog" | "url";
};

type ExternalProfileLink = {
  label: string;
  url: string;
};

type ExternalIdentityAssertion = {
  type: string;
  value: string;
  verifiedAt: string;
};

type VerifiedExternalIdentity = RequiresIntegrity<
  ExternalIdentityAssertion,
  readonly ["loom-verified-external-identity"]
>;

type VerifiedExternalIdentityCell = Cell<VerifiedExternalIdentity>;

type ProfileDefaultPattern = {
  [NAME]: string;
  [UI]: VNode;
  name: string;
  avatar: string;
  bio: string;
  externalLinks: ExternalProfileLink[];
  verifiedIdentities: VerifiedExternalIdentityCell[];
  elements: ProfileElement[];
  addExternalLink: Stream<{ label?: string; url?: string }>;
  removeExternalLink: Stream<{ url?: string }>;
  publishVerifiedIdentities: Stream<{
    identities?: readonly VerifiedExternalIdentityCell[];
  }>;
  revokeVerifiedIdentities: Stream<{
    identities?: readonly VerifiedExternalIdentityCell[];
  }>;
  addElement: Stream<AddProfileElementEvent>;
  removeElement: Stream<{ cell: Cell<unknown> }>;
  setBio: Stream<SetProfileBioEvent>;
  inbox?: ProfileInbox;
  setInbox: Stream<SetProfileInboxEvent>;
  initialNameApplied: string;
};

type ShareInboxPiece = {
  [NAME]?: string;
};

type ProfileInbox = {
  piece?: Cell<ShareInboxPiece>;
};

type SetProfileInboxEvent = {
  inbox?: Cell<ShareInboxPiece>;
};
```

`avatar` starts as a string. The first implementation can use a URL, data URL,
or emoji-like text. Binary/blob avatar upload is out of scope.

`bio` (CT-1648) is a short, owner-authored free-text description, the canonical
shared-profile bio — distinct from Home's legacy `learned.summary`. Like `name`
and `avatar` it is owner-protected (written only through `setBio`), readable
from the profile result, and exposed as the well-known wish target
`#profileBio`.

`externalLinks` is the owner-authored list of public profiles maintained
outside Common Fabric, such as GitHub, LinkedIn, or a personal site. Entries
contain a display label and an `http(s)` URL; unsafe schemes are rejected before
storage and never render as live anchors. The list is owner-protected and is
mutated only through `addExternalLink` / `removeExternalLink`.

`inbox` is the owner's share inbox pointer: where other people's daemons
deliver things shared with the owner. Its one member, `piece`, is a cell link
to the owner's share inbox piece — the piece whose `receive` stream a sender's
daemon calls — inside the dedicated inbox space the owner's daemon minted,
and it names the piece and its space together. Stored, the link is the
`link@1` sigil the profile's pinned-piece elements also use, so the stored
pointer reads:

```json
{ "piece": { "/": { "link@1": { "id": "of:baedreia…", "space": "did:key:z6Mk…", "path": [] } } } }
```

The link names the piece rather than only its space because an inbox space
can hold more than one inbox piece (each mint adds one), and a sender that
picks one by listing the space can pick one the owner's reader never reads.
It carries no memory host: the inbox lives on the host the profile pointing at
it lives on, so a reader uses the host it read the profile from. The pointer
holds no secret — the inbox space's ACL is the gate — and is owner-protected,
written only through `setInbox`, which takes the link alone (`{ inbox: <link>
}`) and stores it as `piece`, or nothing (`{}`) to clear the pointer. A
profile with no inbox holds a pointer without `piece`; a stored profile
predating the pointer has no `inbox` property.

The link sits under `piece` rather than being the stored value itself because
a write to a cell whose document root holds a link goes through the link into
the piece it names, so a pointer stored bare could be set once and never
re-pointed or cleared; under a key, a new link re-binds the slot and an
omitted key removes it.

`verifiedIdentities` is an opt-in list of identifiers that Loom observed only
after a connector successfully authenticated as the profile owner. Each
assertion has exactly three integrity-covered fields: a namespaced `type`, its
`value`, and the ISO timestamp `verifiedAt`. A provider can publish multiple
assertions for one account: GitHub, for example, publishes both
`github.node_id` and `github.login`. This preserves the stable provider ID for
exact matching while retaining the login a local owner-authored person record
may use. Multiple accounts may also contribute assertions of the same type.

The list is owner-protected and writable only through
`publishVerifiedIdentities`, but the list is not the authority that creates an
assertion. Each event item is a durable cell that MUST already carry the
`loom-verified-external-identity` CFC integrity atom over the complete tuple.
The handler validates the tuple's canonical shape and appends the original cell
reference without modifying or copying its value. This lets one assertion
producer create an integrity-bearing capability and any authorized collector
forward that capability without being able to mint it.

Daily refresh updates `verifiedAt` on the same producer-owned assertion cell;
the profile continues to reference that cell. Disabling publication or logging
out passes the original assertion reference to `revokeVerifiedIdentities`,
which removes that exact reference with `removeAll` rather than comparing
identity contents. Stale assertions are a second line of defense, not the
primary revocation mechanism. Consumers MUST ignore
assertions older than their configured freshness window (48 hours by default)
and MUST fail closed when the item-level integrity label cannot be read. Fresh verified identities are
high-authority reconciliation evidence, but do not by themselves force a
merge: the candidate must remain unambiguous and the profile name should
corroborate a name-bearing local persona when available.

The initial trust root deliberately trusts Loom acting with the user's Fabric
principal through this pattern's dedicated writer. It therefore does not yet
distinguish arbitrary owner-running pattern code from Loom's connector path;
the integrity atom means "trusted by this Loom/user trust root," not an
independent cryptographic proof from the provider. A later, stronger design is
specified but not implemented here: connectors run in attested cloud
sandboxes, the assertion says that code hash H observed the login, and verifier
infrastructure blesses the allowed hashes. That makes the observation
end-to-end verifiable without hard-coding a closed set of connector providers.

The profile presentation renders every verified assertion, one row each, so a
type a connector starts publishing reaches the profile without a change there.
A type the presentation knows by name carries that name — `github.login` reads
as "GitHub" and links to the GitHub profile — and any other appears under the
type string itself. A type with no public page, such as `email`, shows its
value as text rather than a link. The presentation is itself a consumer of the
list, so it applies the 48-hour freshness window against a clock that ticks
every five minutes, and hides an assertion it cannot date. Each rendered row
binds a `cf-cfc-label` badge to the stored assertion's `value`, so the badge
reports the integrity label the runtime holds for the text beside it, and a
value that lacks the `loom-verified-external-identity` integrity atom shows as
unverified.

`elements` is the profile-space analog of favorites and mentionables. Each
entry points at a piece that lives in the profile space. `tag` stores the
snapshot string used for hashtag search, following the favorites pattern:
explicit tag if supplied, otherwise a serialized schema/description snapshot.
`userTags` stores user-supplied tags without `#`.

The profile default pattern may also include an internal `pieceRegistry` if
that is useful for rendering, but external code must depend on `elements` and
`addElement`, not `pieceRegistry`.

## Profile Default Pattern Selection

Default pattern creation needs a third case:

1. Home space: `/api/patterns/system/home.tsx`
2. Profile space: `/api/patterns/system/profile-home.tsx`
3. Other spaces: home `defaultPattern.defaultAppUrl` or
   `/api/patterns/system/default-app.tsx`

A profile space is not identified by `space === userIdentityDID`. It is
identified by the profile default-pattern link at
`homeSpaceCell.defaultPattern.profile`, whose normalized link carries the
profile space DID, or by the explicit profile-creation path before the link
exists. Implementation options:

- Add `ensureProfileDefaultPattern(profileSpaceDID)` and
  `recreateProfileDefaultPattern(profileSpaceDID)` instead of overloading
  `ensureDefaultPattern()`.
- Or add a `defaultPatternKind: "home" | "profile" | "space"` option to the
  default-pattern controller, with profile creation passing `"profile"`.

The first option is safer because opening an arbitrary non-home space should
continue to use the ordinary default app unless it is reached through the
profile-space creation/link path.

## Home Pattern Flow

The home pattern owns `homeDefaultPattern.profile`.

If `profile` is missing:

- render an input field for the user's profile name
- submitting it stores the requested name, which drives a profile-creation
  action/lift
- that action starts `system/profile-home.tsx` with the anonymous `.inSpace()`
  (see Profile Space Identity above), passes the submitted name as the initial
  profile name, and writes the resulting profile
  default-pattern link to `homeDefaultPattern.profile`

If `profile` is present:

- render the profile default pattern or a compact summary based on
  `profile.name` and `profile.avatar`

This write targets the home default pattern because that is the current durable
home-field convention used by favorites. If custom home pattern replacement
needs to preserve profile links independently, that should be handled as a
separate migration.

## Adding Profile Elements

Profile elements are added through the profile default pattern's `addElement`
stream. Callers must not push to `elements` directly.

`AddProfileElementEvent` initially supports two sources:

```ts
type AddProfileElementEvent =
  | { catalogId: string }
  | { patternUrl: string; title?: string; tag?: string };
```

The fixed catalog is a small allowlist of pattern URLs or module descriptors
owned by the profile default pattern. URL-based creation compiles the supplied
pattern URL using the same resolver path as ordinary piece creation.

The handler creates the piece in the profile space, snapshots its searchable
tag, deduplicates by cell identity, and appends a `ProfileElement`.

## Authorization

The v1 protected data is the profile default pattern's owner-controlled fields
and element mutations:

- `profileDefault.name`
- `profileDefault.avatar`
- `profileDefault.elements`
- `profileDefault.addElement` / `profileDefault.removeElement` writes that
  mutate `elements`

Those protected fields must carry owner integrity shaped like:

```ts
// Shown for illustration only.
{ kind: "represents-principal", subject: ownerDid }
```

Writes to those fields must satisfy the owner integrity and must be
`WriteAuthorizedBy` the trusted profile handlers or trusted profile UI actions.
This is CFC-enforced, not UI-only. The UI may hide editing controls for
non-owners, but that is only a convenience check.

The home link write to `homeSpaceCell.defaultPattern.profile` is durable and
protected by CFC as profile-link data. It carries static `"profile-link"`
integrity and is `WriteAuthorizedBy` the profile-link creation flow in the home
default pattern. This is separate from the profile owner's
`represents-principal` integrity on the profile default fields: v1 protects the
link against direct untrusted writes, but does not add a second owner-specific
atom to the home link itself.

Profile creation UI rendered by `wish({ query: "#profile" })[UI]` must be
vended through a trusted pattern surface, not raw runner-owned input markup. The
trusted surface sends the same create-profile event used by the home profile tab
and leaves navigation unchanged. The transient requested-name trigger that feeds
this flow is ordinary home default-pattern state; the durable protected surface
is the resulting `homeSpaceCell.defaultPattern.profile` link.

The owner check should use `runtime.userIdentityDID` / `storageManager.as.did()`
as the authenticated principal. It should not use the current collaboration
space DID. If static CFC authoring aliases cannot express exact owner-DID
requirements, profile creation should use a profile schema factory that embeds
the owner DID into the profile default schema.

## Wish Scope

### Scope Value

Add a profile wish scope value:

```ts
// Shown at module scope.
type WishScope = "~" | "." | "profile" | DID;
```

The string `"profile"` is reserved and must be removed from the arbitrary-DID
bucket. Today `getArbitraryDIDs()` treats every non-`"~"`/`"."` value as a DID;
that must change before `scope: ["profile"]` is exposed.

### Hashtag Search

For hashtag queries, `scope: ["profile"]` searches
`homeSpaceCell.defaultPattern.profile.elements`.

Matching follows the favorites behavior:

1. `userTags` exact match, lowercased, without `#`
2. `tag` hashtag match using the existing hashtag extractor

The result maps each matching `ProfileElement` to `element.cell`, then applies
the query path suffix the same way favorites and mentionables do.

Examples:

```tsx
// Shown inside a pattern body.
// Search profile elements only.
const profileCard = wish({ query: "#profile-card", scope: ["profile"] });

// Search favorites, current space, and profile elements.
const person = wish({
  query: "#person",
  scope: ["~", ".", "profile"],
});
```

Search order for mixed scopes is:

1. favorites (`"~"`)
2. current-space mentionables (`"."`)
3. profile elements (`"profile"`)
4. explicit DID spaces, in caller-provided order

This preserves existing favorites-first behavior and makes profile an explicit
extension rather than a new default.

### Well-Known Profile Targets

`wish({ query: "#profile" })` resolves to the current user's profile default
pattern.

Add these explicit profile targets:

```tsx
// Shown at module scope.
wish({ query: "#profile" })            // homeDefault.profile
wish({ query: "#profileSpace" })       // the profile space cell, derived from the profile link
wish({ query: "#profileName" })        // default profile's initialNameApplied (no `profileName` mirror field post-#3830)
wish({ query: "#profileAvatar" })      // homeDefault.profile.avatar
wish({ query: "#profileBio" })         // homeDefault.profile.bio (CT-1648)
```

The optional `[UI]` for `wish({ query: "#profile" })` is persona-aware:

- when the profile exists, render a link to the profile default pattern
- when the profile is missing, render the same profile-name input as the home
  profile tab through the trusted profile-create pattern surface
- submitting the input creates the profile through the home default pattern but
  does not navigate away from the current view
- the wish UI should then reactively replace itself with the profile link once
  `homeDefault.profile` is written

If the old learned-summary shortcut remains useful, it should get a new explicit
target instead of overloading `#profile`.

## Integration Test Plan

Add a browser integration test with a demo pattern.

### Demo Pattern

Create a small test/demo pattern that renders the current user's shared profile
name and profile wish UI:

```tsx
// Shown for illustration only.
export default pattern(() => {
  const profile = wish({ query: "#profile" });
  const name = wish<string>({ query: "#profileName" });
  return {
    [NAME]: "Profile Name Demo",
    [UI]: (
      <div>
        <div>{name.result ?? "No profile"}</div>
        <div>{profile}</div>
      </div>
    ),
  };
});
```

The test should assert both states:

1. before profile creation, the demo renders the missing-profile state and the
   inline profile creation input from `wish({ query: "#profile" })[UI]`
2. after profile creation and name entry, the demo renders the profile name
   and the profile wish UI renders a link to the profile

### Browser Flow

The integration test should:

1. create a fresh browser identity
2. navigate to a fresh ordinary space
3. add or open the demo pattern
4. assert the demo has no profile name yet
5. submit the profile name through the demo's inline profile wish UI
6. assert the rendered text is the profile name
7. assert the inline profile wish UI has reacted into a profile link
8. optionally create a second ordinary space with the same identity and assert
    the same profile name renders there too
9. for multi-user coverage, log in as a second identity against the same
    shared ordinary space/piece, create that user's profile, and assert the demo
    renders the second user's name without changing the first user's profile

The test should use the existing shell integration harness style from
`packages/patterns/integration/default-app.test.ts`, including fresh noble
identities and `waitForRuntimeIdle` before assertions. The CFC browser helpers
already provide useful primitives such as `waitForText`, `fillCfInput`, and
`waitForRuntimeIdle`; the CFC group-chat integration tests show the existing
shape for switching identities while keeping a shared piece under test.

### Runner-Level Tests

Add focused runner tests for `wish()`:

- `scope: ["profile"]` is not treated as a DID
- profile hashtag search reads `homeSpaceCell.defaultPattern.profile`
- mixed scope ordering is stable
- missing profile link returns an empty/error `WishState` without throwing out
  of the scheduler action
- `wish({ query: "#profile" })` returns the profile default pattern

The [shared-profile participant roster guide](shared-profile-rosters.md) shows
how multi-user patterns build live participant lists on this profile model.

## Open Questions

- Should profile spaces be readable by all collaborators by default, or private
  until explicitly shared?
- Should the profile default pattern expose `elements` only, or also a
  default-app-compatible `addPiece` stream for reuse?
- Should avatar be a string permanently, or should the first implementation
  reserve a future blob shape?
- How should a user intentionally reset or migrate their profile space if the
  home-space link points to a broken or obsolete profile?
