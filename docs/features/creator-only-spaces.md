# Creator-only spaces

`PatternFactory.inSpace(name, { access: "creator", members })` creates a space
whose access list names exactly the principal the handler acts for, as `OWNER`,
and the members the handler lists. This document says how that space comes into
being, how a name keeps reaching the same one, what the runtime checks before
it creates anything, and what it leaves unchecked.

The pattern-facing description is in
[multi-user patterns](../common/patterns/multi-user-patterns.md#a-space-only-its-members-can-open).
It is the creation half of
[random space identities](../specs/random-space-identities.md), available as an
option on `inSpace()`.

## The key and the genesis

A plain `inSpace(name)` derives its space's key from the name, so anyone who
knows the name can sign as the space. A creator-only space has no such key to
recompute:

1. `Runtime.createCreatorSpace()` generates a fresh key with
   `Identity.generate()`. The public key is the space's DID.
2. It registers the key with the storage manager as the space's genesis
   authority, with `owner` set to the creator and `grants` set to the members.
   The genesis document is then exactly the creator as `OWNER` plus the members,
   with none of the default grants a plain space's genesis carries.
3. It forces the genesis with `ensureSpaceInitialized()`, which returns once
   the memory server has confirmed it.
4. It drops the key with `forgetSpaceIdentity()`, and records the DID for the
   handler run that asked for it.

A genesis whose outcome is unknown, because the call in step 3 failed, keeps
the key in the runtime, and a later attempt for the same request resubmits the
same genesis. Once it is confirmed, no process holds the key.

Storage that cannot write a genesis document refuses `grants` in
`registerSpaceIdentity()`, as it refuses a `genesisAcl`. A space created there
would have no access list at all, and so would not be the space the handler
asked for.

## The allocation record

The calling space holds one allocation record per name: a document addressed by
the calling space and the name, whose value is the DID. The anonymous form
derives its name from the handler frame's cause and a per-frame counter, as the
anonymous `inSpace()` does, so a retry of the same event finds the same record.
Nothing a plain `inSpace()` resolves is addressed this way, so the two never
reach the same space.

A handler run goes through `resolveCreatorSpaceTarget()` in
`packages/runner/src/builder/pattern.ts`:

- A record holding a DID is the space. The record is not checked against the
  space's current access list, which may have changed since the genesis.
- With no record, a space the runtime has already created for this request is
  written into the record in the run's own transaction.
- Otherwise the run leaves the request pending on its frame. The runner syncs
  the record, since a replica that had not loaded it read it as absent, creates
  the space if the record is still absent, and re-runs the handler, as it does
  for an unresolved name.

A request is keyed by the record, the creator and the members, so a run for a
different principal, or with a different member list, never picks up a space
created for another.

Two runs that both create a space for one name converge on one record. Each
transaction read the record as absent, so the second commit to write it fails
with a stale read; that handler re-runs, reads the record the first wrote, and
abandons the space it created. An abandoned space is one access-list document
that nothing refers to, which the spec accepts.

## What is checked, and where

All of these are checked in the handler run, before any space is created:

- **Handler only.** A pattern body builds one graph for every viewer, and a
  computation must not have outward effects, so both throw, as
  `currentPrincipal()` does.
- **The creator** is `Runtime.actingPrincipalFor()`, the principal
  [the handler acts for](current-principal.md). Nothing in the options or the
  event names it. A run acting for no principal throws rather than creating a
  space owned by the service.
- **Members** are DIDs at `WRITE` or `OWNER`, each listed once, never the
  creator. The wildcard is not a DID.
- **A trusted gesture.** A member can read everything the space will hold, so a
  genesis naming members is a grant, and a non-empty `members` needs the
  handler's event to be a trusted gesture: an event the renderer marked, whose
  provenance says the browser trusted a DOM event on a UI surface. This is the
  test the snapshot-share and custody-seal commits apply, without their match
  on which surface it was. Like theirs, it is not governed by the CFC
  enforcement mode. It could not be a check at commit preparation: the genesis
  lands before the handler's commit is prepared, so such a check could refuse
  the handler's writes but not the grant.

On a serving runtime a creator-only space with no members is created on the
same path a served plain `inSpace()` uses to name the acting user its owner,
with no grants beside the owner. A non-empty `members` is refused there: the
serving runtime writes through the wave's delegated carriage, and nothing on
that path checks that the person who sent the event asked for the grant.

## What it does not do

- **It does not protect the record.** Anyone who can write the calling space can
  write a record first and point a name at a space they own. For a record in a
  user's home space that is only the user. Checking, on a record's first use,
  that the space's access list names the creator as `OWNER` would close it for
  a shared calling space, and needs an asynchronous read of the child's access
  list before the handler can proceed.
- **It does not know the deployment's service principals.** A client runtime
  cannot tell a service DID from any other, so a member naming one is admitted.
  The memory server already grants a service principal `OWNER` on every space,
  so such a grant adds nothing there.
- **It changes nobody's access after creation.** The members are fixed at
  genesis.
