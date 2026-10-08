# Random Space Identity Implementation Plan

## Status

The code is implemented in this repository. What remains is the deployment
sequence under "What remains" and two changes in other repositories. When those
are done, this plan is archived.

The [random space identities specification](../specs/random-space-identities.md)
is the normative target. The [Common Fabric URL](../specs/fabric-urls.md) and
[space name registry](space-name-registry.md) designs are separate concepts for
which no deployment is planned. This plan contains no partial implementation of
either.

## What is implemented

Creating a space and opening a space are separate operations.

- **Creating a space.** `StorageManager.createSpace(acl, genesis?)`
  ([`packages/runner/src/storage/v2.ts`](../../packages/runner/src/storage/v2.ts))
  generates a key pair from the platform random source, opens one session as
  that key through the same route every later session for the DID takes, and
  commits `acl` as the space's genesis document against a confirmed absent one,
  with an optional reserved root and an optional declared kind, each of which
  requires the host to advertise its capability (`genesisRoot`, `spaceKind`).
  The memory client resubmits the identical commit after a lost connection
  until the server confirms or refuses it. The DID is returned only after
  confirmation, and the key is dropped when the call returns.
  `Runtime.createSpace({ owner?, grants?, root?, spaceKind? })` writes
  `{ ...grants, [owner]: "OWNER" }`, defaulting the owner to the runtime's
  identity; a serving runtime requires an owner. The client surfaces are
  `RuntimeClient.createSpace(label?)`, `PiecesController.createSpace(label?)`,
  `cf space create`, the Home pattern's `cf-space-create` control, and the
  piece menu's clone into a new space, which creates the destination through
  `RuntimeClient.createSpace`; each records the new space in the user's Home
  space list and site table.
- **Opening a space.** Opening never writes genesis for anything but a Home
  space with no ACL document and no history. `Runtime.spaceExists()` answers
  whether a DID has an ACL document or a space cell.
  `PiecesController.ensureDefaultPattern` throws `SpaceNotFoundError`
  (defined in
  [`packages/runner/src/ensure-space-root.ts`](../../packages/runner/src/ensure-space-root.ts))
  for a non-Home space that does not exist, and it crosses the worker boundary
  as `RuntimeErrorCode.SpaceNotFound`; the serving loop's root ensure already
  skips a space with no owner. The
  shell shows that no space answers to the address and offers to create one;
  `cf piece new` reports it and names `cf space create`; the FUSE mount answers
  `ENOENT`.
- **Legacy names.** `legacySpaceDid(name)`
  ([`packages/identity/src/legacy-space.ts`](../../packages/identity/src/legacy-space.ts))
  returns the DID a legacy name resolves to, and never a key. `createSession`
  takes a DID only. The shell's `resolveSpaceDid`, the CLI's ingest-channel
  resolver, `PiecesController.initialize`, the connectors, and `cellFromUrl`
  resolve names through it, offline. Creation never calls it.
- **`inSpace` allocation records.**
  `PatternFactory.inSpace(name, { grants, root, spaceKind })` resolves through
  one document per name in the calling space, addressed by the cause
  `{ inSpaceAllocation: { space, name } }` (`Runtime.resolveInSpaceNameSync`
  and `Runtime.resolveInSpaceName`). On a miss the runner creates a space with
  the request's grants, root reservation and declared kind, which are
  independent of one another, and the re-run writes the record in the same
  commit as the writes that refer to it; until the record is written, a
  request finds only a space created for the same grants, root and kind. A
  concurrent writer of the same record makes that commit conflict. A record is
  never overwritten, and one naming a DID with no history is reported rather
  than replaced. The in-process map of resolved names only grows. Profile
  creation grants the wildcard `"*"` WRITE on the space it creates, because a
  runtime showing a profile writes into the profile's space.
- **Narrowed space-identity authority.** The memory server grants a principal
  equal to the space DID OWNER only while the space has no ACL document and is
  at server sequence 0 (`#resolveCapability`), and grants it nothing beyond the
  ACL elsewhere: `foreignWriteAuthorityFor` has no identity arm, invitations
  treat only service DIDs as implicit owners, CFC `spaceReaderRole` and the
  render membership provider consult the ACL alone, the render ceiling's member
  space is the session's workspace, and the custody seal's room readers are the
  room's ACL entries. `#validateAclCommit` is unchanged. Service DIDs keep their
  configured authority. `foreignWriteAuthorityFor` refuses a space whose store
  does not exist, since no space answers to that DID until its genesis lands;
  the sink's refusal of a foreign batch into a space with no genesis ACL stays
  behind it.
- **Home space list.** An entry with a `did` opens that space and is keyed by
  it, and its `name` is only its label
  ([`packages/home-schemas/spaces.ts`](../../packages/home-schemas/spaces.ts));
  the Home pattern's streams are `addSpace`, `removeSpace`, `adoptSpace` and
  `renameSpace`. The runtime worker adopts each name-only legacy entry once per
  worker, keyed by the DID the name resolves to and labeled with the name, and
  records its serving origin in the site table.
- **Links the product builds** address spaces by DID: the navigation helper
  prefers a known DID to a name, so a Home entry opens by its DID and its label
  is never read as a legacy name. A page reached by a legacy name keeps that
  name in the address bar, the header and the header's link, and a link into
  the same space is written with the name, which always resolves to that DID.

## What remains

### Operational

In this order:

1. Give every Home space an ACL document before the narrowed authority is
   deployed: a populated Home space with none can no longer be claimed by its
   user, and that check is not gated by `MEMORY_ACL_MODE`, so its loss cannot
   be staged. For each user DID, `cf acl ls --space <DID>`; where it lists
   nothing, `cf acl set <DID> OWNER --space <DID>` as an identity listed in
   `MEMORY_SERVICE_DIDS`. A legacy named space's wildcard grant comes off with
   `cf acl remove ANYONE --space <name>`.
2. Deploy with `MEMORY_ACL_MODE: observe` and read `aclStats.wouldDeny` on
   `/api/health/stats` and the `[memory-acl] would deny` warnings before
   returning to `enforce`. Observe mode still refuses any principal lacking
   OWNER, so nobody can write a space's ACL during the window. It stages READ
   and WRITE decisions only.

Ingest channels minted while legacy space keys were derivable are not retired.
Every deployment has been reachable only on the team's private network, with no
users outside the team, so nobody outside it could have signed as a legacy space
to mint one, or to grant themselves OWNER on a legacy space. A deployment
reachable more widely would audit and retire those channels and review every
space's owners, as
[self-serve ingest channels](../features/self-serve-ingest-channels.md)
describes.

### In other repositories

- **`commonfabric/specs`:** SC-52 in the
  [CFC spec change list](../specs/cfc-spec-changes.md), which removes
  `principal === space` from the capability resolution (section 4.9.3),
  section 18.4.5's own-space exception, and the `p = space` disjunct of the Lean
  model's `readerRoleB`.
- **`commonfabric/infra`:** every production `MEMORY_URL` must name the
  host-internal routed endpoint. The tracked configuration does not set it; its
  value lives in the encrypted environment file. The nginx route
  (`toolshed.conf.j2`) selects a process from the last character of the
  request URI, which for a memory connection is the space DID, so a previously
  unseen DID is admitted and reaches one process deterministically; changing
  the backend set moves DIDs between processes. Routing a toolshed's own
  runtimes through it has to be reconciled with the serving loop, which writes
  directly to the engines its own process hosts.

### Deliberate departures from the plan

- A Home space list entry keeps the shape it has always had, `{ name, did? }`,
  rather than becoming `{ did, label? }`. Home is a required pattern, and
  making `name` optional, or dropping the `addSpace` event's `detail`, is a
  contract break its every stored root would take on merge, which needs a
  ruling by name. The `name` of an entry with a `did` is its label, and a
  name-only entry is a legacy one; `addSpace` still accepts a typed name.

### Deliberate departures from the specification's URL section

- A shared URL naming a legacy space stays as typed, and so do the page's own
  links into that space; the name always resolves to the same DID.
- The shell replaces a piece-ID URL with the piece's slug URL once loaded, as a
  deliberate choice of readable URLs; this plan does not reverse it.
- The shell constructs no `?host=` or `?spaceHost=` URL. `cellFromUrl`'s
  `spaceHost` input remains its way to route a named space.

## Verification

Covered by automated tests:

- Two creations differ, and one creation's ACL names its creator alone plus its
  grants: `packages/runner/test/memory-v2-acl-bootstrap.test.ts`,
  `packages/piece` controller tests.
- A refused genesis returns no DID and leaves the space uninitialized; a root
  reservation lands in the genesis commit and binds later root intents:
  `memory-v2-acl-bootstrap.test.ts`.
- Opening a DID with no history writes nothing, and nothing can be written to
  it: `memory-v2-acl-bootstrap.test.ts`; `ensureDefaultPattern` refuses a
  missing space: `packages/piece` tests; the FUSE mount answers `ENOENT`.
- Allocation records: named and anonymous targets, two calls in one handler,
  two events with identical inputs, one name from two calling spaces, a later
  process reading the record, a record never overwritten, a record naming no
  space reported, monotonic resolution, and two processes converging on one
  record: `packages/runner/test/in-space-allocation.test.ts`.
- The narrowed server rule, in `enforce` and `observe`, Home spaces, repair by
  service DIDs only, and `foreignWriteAuthorityFor`:
  `packages/memory/test/v2-server-acl.test.ts`, `v2-invites.test.ts`.
- The Home space list, labels, renaming, removal and adoption:
  `packages/patterns/system/home.test.tsx`.

Covered by integration tests, which run against live servers: the shell's
no-space alert and its create button, two identities navigating to an unused
name, legacy name URLs opening the space the name has always named
(`createLegacyTestSpace` in `packages/integration`), and every browser flow that
creates its own space with `createTestSpace`.

Needing a deployment: routing through the production frontends, process
restarts and backend-set changes, and the observe-mode counts.
