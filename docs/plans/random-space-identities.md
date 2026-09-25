# Random Space Identity Implementation Plan

## Status

Proposed implementation plan. The
[random space identities specification](../specs/random-space-identities.md) is
the normative target.

The goal is that every newly created ordinary space gets a fresh random DID and
is owned by its creator from its first committed state, while every space that
already exists keeps its DID and keeps working, including the name-bearing URLs
people have shared. The work is one pull request in this repository, preceded by
three preparatory pull requests here, two operational runs against production,
and two changes in other repositories.

The [Common Fabric URL](../specs/fabric-urls.md) and
[space name registry](space-name-registry.md) designs are separate concepts for
which no deployment is planned. This plan contains no partial implementation of
either.

## What the code does today

These facts are what the plan is built on.

- `createSession({ identity, spaceName })` computes the space key as
  `Identity.fromPassphrase("common user").derive(spaceName)`
  ([`packages/identity/src/session.ts`](../../packages/identity/src/session.ts)).
  The calling identity is not used, so anyone who knows a space name can
  recompute that space's private key, and two users choosing the same name get
  one space.
- The derived key is handed to the storage manager as bootstrap authority
  through `registerSpaceIdentity`. At the space's first mount, a short-lived
  session authenticating as the space writes the genesis access-control
  document.
- The genesis document for a fresh non-Home space is
  `{ [creator]: "OWNER", "*": "WRITE" }`. The wildcard comes from
  `DEFAULT_GENESIS_GRANTS`
  ([`packages/runner/src/storage/v2.ts`](../../packages/runner/src/storage/v2.ts)).
  The only callers that supply a genesis document of their own are tests, and no
  user-facing surface narrows an access-control document afterwards, so an
  ordinary space is born world-writable and stays that way.
- The Memory server grants OWNER to any principal equal to the space DID, with
  no access-control entry and no expiry
  ([`packages/memory/v2/server.ts`](../../packages/memory/v2/server.ts), in
  `#resolveCapability` and in `foreignWriteAuthorityFor`). Only the first of
  those two is gated by `MEMORY_ACL_MODE`.
- A genesis commit is admitted by two checks in sequence: `#validateAclCommit`
  requires the principal to be the space identity or a service DID, and then the
  ordinary capability check requires OWNER on a commit that touches the
  access-control document. That OWNER comes from `#resolveCapability`'s
  space-identity arm and from nowhere else, so genesis depends on that arm
  rather than being independent of it.
- A populated space that has no access-control document already grants WRITE to
  any authenticated principal, under the temporary compatibility rule in
  `#resolveCapability`, and it grants the space identity OWNER through the same
  arm. The bootstrap that writes an access-control document for such a space
  requires server sequence zero for an ordinary space and exempts a Home space
  from that requirement, so a populated Home space with no document can still be
  repaired today.
- `foreignWriteAuthorityFor` grants write authority to any principal for a space
  whose store does not yet exist, deliberately and independently of
  `MEMORY_ACL_MODE`. That arm is a separate hole, and narrowing the
  space-identity arm beside it does not close it.
- `PatternFactory.inSpace("name")` and the anonymous `PatternFactory.inSpace()`
  both resolve through that derivation. The anonymous form first computes a name
  by hashing the handler frame's cause together with a per-call ordinal
  ([`packages/runner/src/builder/pattern.ts`](../../packages/runner/src/builder/pattern.ts)),
  so a re-run of one handler reaches the same space and two calls in one handler
  reach two spaces.
- `Runtime.resolveSpaceName`
  ([`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts))
  caches resolved names in process memory only. Nothing durable records which
  name became which DID, because the mapping is recomputable.
- About a dozen production modules call `createSession({ spaceName })` directly
  and never reach `Runtime.resolveSpaceName`: the shell library, the
  command-line interface, the piece package, both connector runtimes, the
  pattern-index harness, and the Toolshed pattern-lifecycle route.
- Two of those resolve a name with no network at all. The shell library's
  `resolveSpaceDid` is documented as resolving "without touching any runtime",
  and the command-line interface's ingest-channel helper does the same. Keeping
  the derivation as a resolver is what lets both keep doing so.
- The Home space already carries a per-user table addressed by a canonical cause
  rather than by the Home pattern's output: the site table, which maps a space
  DID to the host serving it
  ([`packages/home-schemas/spaces.ts`](../../packages/home-schemas/spaces.ts)).
  Its own documentation records that anything with Home write access, patterns
  running there included, can write it.
- The Home pattern's managed space list is `defaultPattern.spaces`, an array of
  `{ name, did? }` where only `name` is required, owned and published by the
  Home pattern
  ([`packages/patterns/system/home.tsx`](../../packages/patterns/system/home.tsx)).
  Adding a space is typing a name; the DID is derived when the link is opened.
  Nothing writes the optional DID: `addSpaceHandler` stores a name alone.
- Opening a space creates it. `handleGetSpaceRootPattern` calls
  `ensureDefaultPattern`, which calls `createSpaceRootIfAbsent`
  ([`packages/runner/src/ensure-space-root.ts`](../../packages/runner/src/ensure-space-root.ts)),
  so navigating to any name at all writes a genesis access-control document and
  a default pattern for whatever DID that name derives. The Home space
  convention records the same thing: clicking a space link creates the space if
  it does not exist yet.
- `spaceName` appears about a thousand times across more than two hundred
  files. Some forty-five of those are not tests, benchmarks, or fixtures; the
  rest want a repeatable space DID from a string.
- `tasks/check-tripwires.ts` fails continuous integration as soon as the
  derivation stops colliding across users. Its stated obligation is four
  operational steps: audit issued ingest channels, retire them, sweep space
  access-control documents for owner grants nobody can account for, and audit
  again. The two tasks it names live in `packages/toolshed/deno.jsonc`. The
  tripwire entry and its test are deleted in the same change that discharges the
  obligation.
- The Memory server already stages access-control decisions. Under
  `MEMORY_ACL_MODE: observe`, `#authorizeMessageWithEngine` counts what it would
  have refused and warns, rather than refusing.

## The shape of the change

Creating a space and opening a space become separate operations. Creating takes
no name, computes nothing from a string, and returns a DID. Opening takes a DID,
or a legacy name that still derives one.

A DID is recorded by whatever refers to it, beside the reference, so the change
adds no directory:

- A space that calls `PatternFactory.inSpace(name)` holds an allocation record
  for that name: one document, addressed by a canonical cause over the calling
  space and the name, immutable once written, and committed together with the
  writes that refer to the child. That record is what makes a replayed handler
  reach the same space.
- A user's Home space list holds a DID and an editable label per entry. That is
  what a person navigates through.
- The existing Home site table keeps mapping a DID to its serving origin.
- The derivation survives as a resolver for legacy names and nowhere else. It
  is a pure function of the name, so it gives the same answer at every provider
  and needs no record of which names exist, which is what keeps a URL such as
  `https://<asp-host>/team-lunch/<piece>` opening the space it always opened
  without any per-instance data. It returns a DID rather than a key, and
  creation never calls it.

## Prerequisites

None of these is part of the pull request. Each has to be finished first, and
none depends on another, so they can be done in any order and by different
people. Retiring the wildcard genesis grant is the one to start with: it is the
smallest, and on its own it closes the larger of the two holes a new space is
born with.

### In this repository, as separate pull requests

- **Retire the wildcard genesis grant.** Change `DEFAULT_GENESIS_GRANTS` to
  `{}`, so a fresh non-Home space is born owned by its creator and by nobody
  else. This is one edit plus the tests that assert the current default. A
  random DID that anyone may write to is no more private than a derived one, so
  this is worth landing on its own.

- **Route every name resolution through one seam, and record allocations.**
  Give `PatternFactory.inSpace(name)` a durable allocation record in the calling
  space, and make every production caller of `createSession({ spaceName })` go
  through one resolution function instead. That function consults a recorded DID
  where one exists and derives otherwise, which is what it keeps doing after the
  change. Keep the existing derivation as the generator for a name with no
  record, so this pull request changes no DID and no behavior a user can see.

  This is what makes the rest one pull request: afterwards the step that invents
  a DID for a name is one expression in one function, rather than being spread
  across a dozen modules.

  Two callers resolve a name today without touching the network, and both keep
  doing so, because a name is resolved by the derivation alone. A record is read
  where one addresses the resolution — the allocation record `inSpace(name)`
  reads sits in the calling space, which is mounted already — and no record is
  consulted for a name a person typed. Neither the shell library's
  `resolveSpaceDid` nor the command-line interface's ingest-channel resolver
  changes its signature.

- **Convert the test call sites off `spaceName`.** A test that wants one space
  uses an explicit DID generated once; a test that wants two sessions on one
  space shares that DID between them. No production code changes. This is the
  largest mechanical part of the whole change, and separating it is what keeps
  the pull request that changes behavior readable.

### Operational, before the pull request lands

- **Discharge the ingest-channel tripwire obligation.** From
  `packages/toolshed`, run `deno task audit-ingest-channels`, then
  `deno task retire-ingest-channels --reason space-key-derivation-fix`, then
  sweep every legacy space's access-control document, then the audit again.
  Until this is done the pull request cannot delete the tripwire, and continuous
  integration is red from the first commit that changes the derivation.

  The sweep is the third of those four steps and carries most of their weight.
  It removes the wildcard grant each legacy space was born with, removes owner
  grants nobody can account for, and confirms a concrete owner. Together with
  the narrowed space-identity authority, it is what makes a legacy space private
  going forward. Until it runs, every legacy space is writable by anyone holding
  any key, whatever else this change does.

- **Give every Home space an access-control document.** A Home space with no
  such document is repaired today by a bootstrap that authenticates as the space
  identity, and that bootstrap is exempt from the server-sequence-zero
  requirement that ordinary spaces face. The repair works because
  `#resolveCapability` grants the space identity OWNER, which the commit needs
  because it touches the access-control document. Narrowing that arm to sequence
  zero therefore takes the repair away from every populated Home space that
  still lacks a document, permanently. That check is not gated by
  `MEMORY_ACL_MODE`, so the loss cannot be staged or observed first. This
  prerequisite blocks the pull request rather than merely preceding it.

### In other repositories

- **`commonfabric/specs`:** amend the Confidential Fabric Computing rule that
  grants membership when a principal equals the space, and the corresponding
  Lean membership model, so that genesis is admitted without creating permanent
  membership.

- **`commonfabric/infra`:** confirm, and change where needed, that every
  production `MEMORY_URL` names the host-internal nginx endpoint rather than the
  Memory server embedded in the request process. Confirm that the nginx hash
  route admits a previously unseen DID, that Memory creates its history
  atomically on accepted genesis, and that later connections reach the same
  durable history across process restarts and backend-set changes.

## The pull request

### Generate the space identity

- Replace the derivation with `Identity.generate()`. The key pair comes from at
  least 256 bits of entropy supplied by the platform cryptographic random
  source. The name, the creator, the host, the clock, and the process contribute
  nothing to it.
- Derive the space DID from the generated public key.
- Build an access-control-only genesis transaction with no prior version,
  granting the creator alone the owner capability.
- Sign it with the space private key and submit it through the ordinary
  space-addressed Memory endpoint. Resubmit the identical transaction until the
  commit is confirmed or permanently refused. Destroy the key once the commit is
  confirmed, and not before: a key destroyed while the outcome is unknown can
  leave a DID that has no access-control document and no way to acquire one.
- Return the DID only after that confirmation, so the caller never records a
  space whose genesis did not land.
- Keep the key in one process, for one create action. Never write it to storage,
  return it to a caller, place it in a log, or carry it through background
  execution.

### Stop opening a space from creating one

- Open a space only where its history exists. A DID whose access-control
  document is absent at sequence zero is not a space, and opening it must leave
  it that way rather than writing genesis for it.
- Keep creating the root pattern inside a space that already has history. That
  is what `createSpaceRootIfAbsent` is for, and a space whose genesis committed
  but whose root was never made still needs it.
- Have the shell, the command-line interface, and the FUSE filesystem report a
  name that reaches no space, and offer creation rather than performing it. A
  conjured space would be born at a DID anyone can recompute from the name, so
  two people typing one name would share a space that anyone can write to.
- Change the Home pattern's space control to match. Adding a space creates one
  and records its DID with the typed string as its label, rather than recording
  a name whose space appears on first click.

### Record allocations beside their references

- Give each space an allocation record per `inSpace` name: one document,
  addressed by a canonical cause over the calling space and the name. Do not
  hold these as rows in a list. A list whose reader takes the last matching row
  lets a later writer take a name over without ever losing a compare-and-set,
  which is the whole of the mutual exclusion here.
- Make a written record immutable. A name that has resolved keeps its DID.
- Resolve `inSpace(name)` by reading that record. On a miss, create a space and
  write the record in the same commit as the writes that refer to the child.
- Resolve a concurrent miss with a compare-and-set against a document that does
  not yet exist. The resolver that loses adopts the recorded DID and abandons
  the space it created, publishing neither that DID nor its key.
- Keep the per-call ordinal in the anonymous `inSpace()` name, so two calls in
  one handler still reach two spaces and a re-run still reaches one.
- Keep the in-process name cache monotonic. A run that cannot resolve a name is
  suspended, the name is resolved, and the run is retried; a name that has
  resolved must resolve again without suspending. Nothing may remove a name from
  that cache while a run is being retried, because the retry has no other bound.
- Decide what a resolver does when a record names a DID whose genesis is absent,
  or names a DID the resolver cannot open. Creating a replacement silently would
  move a space's data; the record is immutable, so the honest outcome is to
  report the inconsistency rather than to allocate again.
- Do not resolve a label. A Home list entry carries a DID, so opening one uses
  that DID and no name is resolved at all; two entries may share a label without
  anything having to choose between them. A name a person types or follows in a
  URL is resolved by the derivation, which is what makes that resolution local.
- Treat a Home list entry as a label and a route, never as authority. Anything
  with Home write access can add one, so an entry a user did not create must be
  able to mislead them about what a space is called and about nothing else.

### Confine the derivation to opening an existing space

- Replace the `spaceName` form of `createSession` with a function that derives
  a legacy name's DID and returns that DID alone. It must not return an
  `Identity`, a `Session`, or anything else carrying the derived key, so no
  caller reaches a legacy space's signing key through it.
- Keep it out of every creation path. A create action calls
  `Identity.generate()` and never this.
- Leave `resolveSpaceDid` in the shell library and the command-line interface's
  ingest-channel resolver resolving offline. Both keep their signatures; only
  what they call underneath changes.
- Read an allocation record before deriving, where the resolution has one to
  read: `inSpace(name)` has one in its calling space. A name reached any other
  way has no record to consult and is derived.
- Remove `Session.spaceIdentity` and every other route by which the derived key
  reaches a caller.
- Rewrite the `space-key-derivation` tripwire to probe what now matters: that
  creating a space yields an unguessable DID. Its present probe asserts the
  derivation collides across users, which stays true of the surviving resolver
  and would leave the tripwire armed forever against a weakness the change has
  already addressed. Then delete the entry and its test file, once its
  obligation is discharged.

### Narrow the space identity's authorization

- In `#resolveCapability`, grant OWNER for `principal === space DID` only while
  the space has no access-control document and remains at sequence zero. That is
  what genesis needs and all it needs. Everywhere else, evaluate the space DID
  against the access-control document like any other identity.
- Narrow `foreignWriteAuthorityFor`'s space-identity arm to match. Its
  store-does-not-exist arm, which grants any principal write authority to a
  space nobody has created, is a separate hole that this change does not close;
  say so rather than letting the narrowing imply otherwise.
- Remove every remaining read, write, access-control mutation, Confidential
  Fabric Computing membership, and cross-space write path that treats equality
  with the space DID as permanent ownership.
- Leave `#validateAclCommit` alone. It already admits nothing but a genesis
  access-control commit from the space identity or a service DID, and it is a
  storage invariant that holds in every mode.
- Keep configured service authority as its existing explicit policy. It is not
  derived from the space key.
- Home spaces keep working because their genesis document grants their user DID
  ownership explicitly.
- Stage the `#resolveCapability` change through the existing
  `MEMORY_ACL_MODE: observe` arm, which counts and warns rather than refusing.
  Run a deployment with it and read the count before enforcing. That arm covers
  ordinary capability decisions only, so it does not stage the loss of the
  Home-space repair path, which is why that repair is a blocking prerequisite
  rather than something to discover in production.

### Separate labels from identity

- Make the DID required and the name optional in the Home space list entry
  schema (`spaceEntrySchema`, `packages/home-schemas/spaces.ts`), and rename the
  optional name to a display label.
- Key entries by DID. Allow duplicate labels. Use the DID as the list key and
  the navigation target.
- Show a shortened DID when an entry has no label.
- Renaming a label changes nothing but the label. It does not rewrite links,
  access-control documents, stored references, or URLs.
- Change the Home pattern's "add a space" control to create a space rather than
  to record a name, and its list rows to navigate by DID.

### Use the existing DID browser routes

- Emit `https://<asp-host>/<space-did>` for a space root and
  `https://<asp-host>/<space-did>/<piece-did>` for a piece.
- Use `https://<asp-host>/` for the authenticated user's Home space where the
  application chooses the hostname-based URL.
- Keep existing piece-slug URLs as user-facing input and replace them with
  piece-DID URLs after loading.
- Stop constructing `?host=` and `?spaceHost=` URLs. Keep them as user-facing
  input that validates the origin and redirects to the hostname-based URL.
- Do not add unregistered friendly-name routing, and do not implement
  provider-to-provider transfer or space-move redirects.

### Migrate the remaining data

- Move `defaultPattern.spaces` entries into the new Home list keyed by DID,
  deriving the DID for a name-only entry as the entry itself would have.
- Record each entry's serving origin in the existing site table.
- Leave every existing cross-space link alone. A child space, including every
  space an anonymous `PatternFactory.inSpace()` call created, is reached through
  the link its parent holds rather than by resolving a name, so those spaces
  need no resolution and no allocation record.
- Rewrite pattern code and fixtures that use a name as an identity.
- Rewrite repository-owned links and managed Home references to DID URLs.
- Leave the `"common user"` passphrase where the legacy resolver needs it, and
  remove every other mention. It stays because the names it made have to keep
  resolving, and deleting it would recover nothing: it is in this repository's
  history and in every bundle already shipped, so the keys it derives are public
  whatever happens next.

## Verification

- Create two spaces with the same label and prove their DIDs differ.
- Create spaces with the same label for two users and prove their DIDs differ.
- Prove a space DID cannot be computed from its label, its creator, the host, or
  any repository constant.
- Prove a newly created space grants its creator, and grants no identity
  besides the creator and the deployment's configured service identities. Prove
  another identity cannot write to it without a later grant.
- Prove the creator owns the space before the first default-pattern write.
- Refuse the genesis commit, and prove the create action reports failure without
  returning a DID and without leaving a record anywhere.
- Make the genesis commit's outcome indeterminate, and prove the create action
  resubmits the identical transaction, keeps the key until the commit is
  confirmed, and never returns a DID whose access-control document is absent.
- Replay a committed handler event and prove its `inSpace()` call reaches the
  original space. Trigger a second event with identical inputs and prove it
  creates a different space.
- Call `inSpace()` twice in one handler and prove the two calls reach two
  spaces, on the first run and on a re-run.
- Resolve one `inSpace` name concurrently from two processes and prove exactly
  one allocation record is written, that both processes return that DID, and
  that the loser publishes neither its DID nor its key.
- Attempt to overwrite an allocation record, and to shadow it with a second
  record for the same name. Prove both are refused and that the name keeps its
  DID.
- Suspend and retry a run whose `inSpace` name resolves, repeatedly, and prove
  the name resolves without suspending every time after the first, so the retry
  terminates.
- Add a Home list entry naming a space the user does not own. Prove it changes
  the label and route a person sees and grants nothing.
- Exit a process after the genesis commit and before the allocation record
  commits. Prove the next resolution creates a new space rather than adopting
  the unreferenced one, and that the unreferenced space is inert.
- Use the same `inSpace` name from two different spaces and prove they reach two
  spaces.
- Prove the bootstrap private key never reaches an allocation record, a Home
  cell, Fabric history, a log, a background event, browser storage, or a
  returned value.
- Submit genesis through a request process whose embedded Memory server does not
  host the space, and prove the transaction lands on the routed history.
- Open several Memory connections for a newly created DID, restart the selected
  process, change the backend set, and prove every connection observes the same
  committed genesis and history.
- Open `https://<asp-host>/team-lunch/<piece>` and
  `https://<asp-host>/topics-dev-476ea34f/<piece>` after the change, signed in
  as an identity that has never opened either, and prove both reach the space
  they reached before, with the same DID.
- Resolve `topics-dev-476ea34f` through the command-line interface with no
  network available at resolution time, and prove it answers.
- Prove the legacy resolver returns a DID and that no caller can obtain the
  derived key through it.
- Prove creating a space never calls the legacy resolver, and that two spaces
  created with the same label differ.
- Prove a Home list entry carrying a DID is preferred over what the name would
  derive.
- Navigate to a name nobody has used. Prove nothing is written for the DID it
  derives, that its access-control document is still absent afterwards, and that
  the reader is told no space answers to that name.
- Navigate to that name as two different identities. Prove neither creates a
  space and neither can write to the DID the name derives.
- Open a space whose genesis committed but whose root was never made. Prove the
  root is created as before.
- Navigate to a piece slug that names nothing, in a space that exists. Prove the
  segment is reported and nothing opens, as it is today.
- Prove the rewritten tripwire fires on random creation rather than on the
  surviving resolver.
- Prove an existing cross-space child, including a profile space created by an
  anonymous `PatternFactory.inSpace()` call, still loads through its parent's
  stored link.
- Give two Home entries one label and prove both still open, each by its own
  DID, with nothing having to choose between them.
- Prove the shell, the command-line interface, and the FUSE filesystem resolve a
  typed name with no network available.
- Edit and remove a Home list entry and prove the space, its access-control
  document, and its site-table hint are unchanged.
- Prove duplicate and renamed labels do not affect resolution.
- Under the narrowed rule, prove the space DID authorizes genesis and nothing
  afterwards, and that a Home space remains accessible to its user.
- Prove `MEMORY_ACL_MODE: observe` reports what the narrowed rule would have
  refused without refusing it.
- Prove DID URLs work through every production frontend and identify the same
  provider without a host query parameter.
- Run repository formatting, lint, documentation-link, unit, integration,
  browser, access-control, background-execution, and migration checks before
  landing.

## Result

Every new space has a fresh, unguessable DID backed by random key data. Its
creator owns it from its first committed state, and no identity besides the
creator and the deployment's configured service identities holds any capability
on it. The bootstrap key exists for one create action and is gone once that
action's genesis commit is confirmed. Creating and opening a space are separate
operations, neither of which turns a string into a DID, and every DID is
recorded beside the thing that refers to it.

Every space that existed before the change keeps its DID and keeps working. The
URLs people have shared still open, because the derivation that made those names
survives as a resolver with no authority, and cross-space children still load
through the links their parents hold.
Those spaces become private going forward once their access-control documents
are swept and the space identity's authority is narrowed; what was disclosed
while their keys were public stays disclosed.
