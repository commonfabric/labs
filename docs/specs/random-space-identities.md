# Random Space Identities

## Status

Proposed target behavior and the active deployment direction. The
[implementation plan](../plans/random-space-identities.md) describes the code
and data change.

The [Common Fabric URL](fabric-urls.md) and
[space name registry](../plans/space-name-registry.md) designs are separate
concepts. Neither is planned for deployment, and neither is a dependency of
this specification.

## Scope

This specification applies to newly created ordinary spaces. A Home space
continues to use its user's DID as its space DID.

Existing ordinary spaces keep their DIDs and keep working, including the
name-bearing URLs people have already shared. "Existing spaces" below says how,
and what about them this change does not repair.

A display label is user metadata. It does not select key data, determine a DID,
or resolve a route.

## Two operations, never one

Creating a space and opening a space are separate operations.

Creating a space takes an authenticated creator and takes no name. It returns a
DID.

Opening a space takes a DID, or a legacy name that resolves to one. It brings no
space into being: a DID that has no history opens nothing.

Creating a space computes nothing from a string. Opening one may: a legacy name
still resolves through the derivation that made it, as "Existing spaces" below
describes. What the change removes is the derivation's authority, not its
arithmetic.

## Identity and genesis

- Each create action generates a fresh key pair from at least 256 bits of
  entropy supplied by the platform cryptographic random source.
- The public key determines the space DID. The display label, creator DID,
  application service provider hostname, clock, and process identity do not
  contribute key material.
- The private key signs one access-control-only genesis transaction. That
  transaction has no prior version and makes the authenticated creator the
  first owner.
- The genesis transaction grants the creator alone. A newly created space is
  not world-writable. The deployment's configured service identities keep the
  authority the deployment already gives them; that authority is policy, not
  anything derived from the space key.
- The private key is destroyed once the genesis commit has been confirmed. It
  survives an indeterminate submission so that the same transaction can be
  submitted again, and it is destroyed the moment the commit is known to have
  landed. It is never stored, returned, logged, or used after that.
- After genesis, the space DID has no implicit owner or repair capability.
  Ordinary access-control grants determine access.

## Creating a space

A create action runs in this order:

1. Generate the key pair and derive the DID from the public key.
2. Sign the genesis transaction and submit it through the ordinary
   space-addressed Memory endpoint, resubmitting the identical transaction
   until the commit is confirmed or permanently refused.
3. Destroy the private key.
4. Return the DID to the caller, which records it.

A process that stops before step 3 loses the key, and the DID it was creating is
abandoned whether or not genesis landed. Nothing references that DID, so nothing
has to recover it: the caller starts a new create action and gets a new DID. A
process that stops between steps 3 and 4 leaves a space that exists, is owned by
its creator, and appears in no record. Such a space costs one access-control
document and is unreachable.

Creating a space twice creates two spaces. There is no idempotency key, no
resumable creation record, and no deduplication of concurrent create actions. A
user who asks for two spaces gets two spaces. A user whose create request was
lost before it was processed asks again and gets one space; a user whose
response was lost after the space was created asks again and gets a second
space, and the first is unreferenced. That is accepted: an unreferenced space
costs one access-control document and is reachable by nobody.

## Recording a created space

A DID is recorded by whatever refers to it, beside the reference. Nothing
records a newly created space in a shared directory, there is no per-user
name-to-DID map, and no provider keeps a table of names.

Three things refer to a space created under this specification, and each
records its own DID:

- **A pattern's `PatternFactory.inSpace(name)` target.** The space that calls
  `inSpace` holds an allocation record for that name. Resolution reads the
  record; on a miss it creates a space and writes the record in the same commit
  as the writes that refer to it. `inSpace("notebook")` therefore means "the
  space this space calls notebook". Two spaces using one name reach two spaces.

  The creator of a space made this way is the identity the run is acting as:
  on a client, the user whose runtime is resolving the name; on a serving
  runtime, the run's demanding identity. A serving run with no such identity
  resolves no name and creates no space, rather than creating one owned by the
  service.

  An allocation record is one document per name, addressed by a canonical cause
  over the calling space and the name, and immutable once written. A
  compare-and-set against a document that does not yet exist is then the whole
  of the mutual exclusion. A record held as a row in a list would not be: a list
  whose reader takes its last matching row lets a later writer take a name over
  without ever losing a compare-and-set.

- **A user's Home space list.** Each entry carries a space DID and an optional
  editable display label. The entry is what a person navigates through.

- **A user's Home site table.** Each entry maps a space DID to the origin
  serving it. This table already exists.

The allocation record is what makes repeated resolution converge. A handler that
runs more than once for one logical event reads the record its first run wrote
and reaches the same space. Concurrent resolvers contend on one document in one
logical writable history, and the resolver that loses adopts the recorded DID
and abandons the space it created.

Resolution must also terminate. A name that a run cannot resolve suspends that
run and resolves before it is retried, and a name that has resolved once must
resolve again without suspending, for as long as the run is being retried.
A resolver that can forget a name it has resolved, or that can leave a name
unresolved after an attempt, turns the retry into a loop with no bound.

## Routing across provider processes

The process that receives a create request is not assumed to host the new
space. Genesis and every later space operation use the provider's ordinary
space-addressed Memory endpoint, which routes one DID to one logical writable
Common Memory history and its durable store. They do not call a Memory server
merely because it is embedded in the process handling the request.

The routed endpoint accepts a previously unseen DID and atomically creates its
history when it accepts the genesis transaction. Every connection for that DID
reaches the same logical history even when request processes restart or the
backend set changes.

The selected process may change after a restart, failover, or placement move.
Before another process accepts writes, the provider must preserve the durable
history and fence the previous writer. Process identity is neither space
identity nor part of any routing decision this specification makes.

Every allocation record lives in a space that reaches its durable history
through that same route. No additional provider-owned storage is required for
space creation.

## Deployment mappings

The current Estuary and Rapids
[process inventory](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/vars/toolshed-binary.yml)
runs 21 Toolshed processes on one host. The checked-in
[nginx configuration](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/roles/nginx/templates/toolshed.conf.j2)
round-robins ordinary API requests across five processes and routes a Memory
WebSocket carrying `space=<did>` to one of sixteen processes. Every process
loads the same
[service environment](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/roles/toolshed-binary/templates/toolshed-binary%40.service.j2),
and the host prepares one
[data volume](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/playbooks/toolshed_setup_disk.yml).
Newly allocated space connections must go through that nginx route. In
particular, each production `MEMORY_URL` must name the host-internal routed
endpoint rather than a process-local endpoint. Process restarts and changes to
the nginx backend set must not change the durable history selected by a DID.

Labs supplies the common client boundary. A remote Memory session appends the
space DID to its
[`space` query parameter](../../packages/runner/src/storage/v2-remote-session.ts)
and Toolshed server runtimes connect through
[`MEMORY_URL`](../../packages/toolshed/runtime-options.ts). Both current and
future deployment routers must preserve that contract.

## Existing spaces

Every ordinary space that exists when this change lands was created by deriving
its key from the fixed passphrase `"common user"` and the space name, and was
born with an access-control document granting every principal write access.

Those spaces keep their DIDs, and every URL that names one keeps opening it.

### Resolving a legacy name

The derivation is a pure function of the name. It takes no host, no user, and no
clock, so it gives the same answer in every process and at every provider, and
it needs no record of which names exist. It survives this change as a resolver
and nothing more:

- Opening a space by a name derives the DID and opens it.
- Creating a space never derives. A create action generates random key data, so
  no new space is born at a DID anyone can recompute.
- The resolver returns a DID. It does not return a key, so no caller reaches a
  legacy space's signing key through it.

### A name that reaches no space

A name nobody has used derives a DID like any other, and that DID has no
history. Opening it opens nothing: the reader is told that no space answers to
that name, and offered the one operation that would make one, which allocates a
random DID and takes the typed string as its display label.

Opening must not bring the space into being, and this is the case that decides
it. A conjured space would be born at a DID anyone can recompute from the name
it was conjured by, which is the whole of what this specification removes. Two
people typing one name would land in one space, and anyone at all could write
to it.

Creating the root pattern inside a space that already has history is a different
matter and continues. The distinction is whether the space exists: a DID whose
access-control document is absent at sequence zero is not a space, and opening
leaves it that way.

Deleting the derivation would not make a legacy space's key secret. The
passphrase and the algorithm are in this repository's history and in every
bundle already shipped, so those keys are public permanently whatever the
product does next. Removing the derivation prevents future use; it recovers
nothing. Only one use has to stop, and that is creating a space.

A record is consulted where the resolution has one to consult: the allocation
record `PatternFactory.inSpace(name)` reads sits in the space that called it. A
name a person types, or follows in a URL, has no such record and is derived,
which is what keeps that resolution local. A Home list entry is not consulted,
because it is keyed by DID and opening it uses that DID rather than resolving
its label.

Existing spaces reached through a stored link rather than a name need no
resolution at all. A cross-space child, including every space an anonymous
`PatternFactory.inSpace()` call created, is reached through the link its parent
holds.

### What this does not repair

Narrowing the space identity's authority ends what a recomputed key can do from
that point on, and rewriting a legacy space's access-control document ends the
world-writable grant it was born with. Together those make a legacy space
private going forward. Neither undoes what was already possible. Anyone who
learned a name could already read that space's whole history, write to it, and
grant themselves a concrete owner capability. Three facts follow, and they are
to be recorded rather than repaired:

- The contents of every legacy space are to be treated as already disclosed.
- Its access-control document is to be treated as untrusted until swept, because
  a grant in it may have been planted.
- Its history contains writes that cannot be attributed, because per-commit
  authorship was never recorded.

Home spaces are not affected. A Home space DID is its user's identity DID, whose
key was never derived from a name.

## Compatibility

New browser navigation uses the existing Application Service Provider-hosted DID
route. This change does not add friendly-name lookup, name registration, Domain
Name System namespaces, or cross-provider move redirects.
