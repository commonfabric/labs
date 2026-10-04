# Shared-space catalog

The shared-space catalog records which shared spaces a person keeps in their
collection. Its schema and deterministic cause are exported by
`@commonfabric/runtime-client/shared-space-catalog-contract`. One document lives in the principal's Home under
`sharedSpaceCatalogCause(principal)`. Reading or updating it does not require
the Home UI pattern to run.

## Identity and routing

Each catalog entry is keyed by space DID and has an accepted memory host, kind,
collection state, and membership revision. The initial registration may also
provide a display title. The space DID is its identity; the host is a routing
fact. Registration refuses an existing entry with a different host or kind.
Applications resolve the current root from the space when opening it.

Every operation supplies `{ principal, host }` for Home. This configuration
must come from the person's identity and deployment configuration,
independently of the host of a shared space or profile. The runtime checks both
the authenticated identity and its effective route for Home before accessing
the catalog. It refuses a mismatch rather than writing another host's Home or
changing a live route. Configuring two clients with the same principal but
different Home hosts still names two separate stores; this API does not choose
a canonical host on their behalf.

## Registration and membership

`RuntimeClient.registerSharedSpace(home, registration)` accepts `loom` and
`fabrichat-room` targets. The caller first validates the target's root kind and
the recipient's access. Registration grants no access and makes no claim that
the target remains accessible. Unknown registration kinds are refused without
being consumed; stored entries with unknown kinds are retained by compatible
readers.

Registration is insert-if-absent. An existing entry keeps its title, revision,
and membership, including when a new offer names it. The returned status is
`registered`, `existing`, or `conflict`. Separate registrations run through
Fabric's transaction conflict handling so one client cannot replace another's
entry with its stale collection. A legacy binding may supply `initialState:
"archived"` to insert an archived entry in the same commit; omitted
`initialState` means saved. This hint never overrides an existing Home entry.

`saved` entries belong in the ordinary collection. `archived` entries belong in
the archived collection with an explicit restore action. Both states retain the
entry and leave the space's ACL unchanged. Access loss is an independent
observation, not a membership change. `left` is reserved for a later contract;
the current API accepts only saved and archived membership.

`RuntimeClient.changeSharedSpaceMembership(home, change)` takes the space DID,
a durable action ID, the membership revision the user observed, and the desired
state. Each applied action creates a new revision, including a choice that
names the same state. The local loom version and a timestamp are not catalog
revisions. An action based on an older revision returns `conflict` and does not
rebase itself onto a newer choice.

The entry retains the last action's ID, observed revision, and requested state.
Repeating that exact action returns `confirmed` while its evidence remains
current. Reusing its ID with different arguments conflicts. A later action can
make an older action impossible to confirm; clients surface that conflict
rather than replaying it. These records are application confirmation metadata,
not a general command queue or a complete action history.

## Confirmation and unavailable data

Mutation methods resolve after their Fabric transaction completes. The
transaction's result carries the entry it selected, rather than a subsequent
local read that may already reflect another action. A read-only transaction can
complete locally, so an `existing` or `confirmed` result additionally pins the
catalog's value at the memory server with an `entity-value-hash` precondition.
That check remains active independently of the optional commit-preconditions
flag. A failed value pin returns `conflict` with reason `catalog-changed`.
An ordinary transaction conflict may re-evaluate the same action against a
fresh snapshot; that action still carries its original observed revision.

The value pin covers the entire catalog. An unrelated entry changing during a
confirmation can therefore cause a conservative conflict. The caller may read
the catalog again and confirm the same action and expected revision. It must
not substitute the newly read revision into the old action.

`RuntimeClient.getSharedSpaceCatalog(home)` returns a validated snapshot:
`{ status: "ready", catalog }` or `{ status: "absent" }`. It checks the storage
read result and the Home access status before reporting absence. Failed,
refused, malformed, or unsupported reads reject. Neither failure nor an
unfinished load is an empty collection. Clients retain their last confirmed
projection and expose freshness separately. Ordinary native collection reads
can use that projection without waiting for Fabric.

The low-level `sharedSpaceCatalogCell()` supplies a reference for invalidation
signals. Generic cell reads may represent load failures as undefined, so they
must not decide catalog availability or clear a local collection. Refresh the
projection through `getSharedSpaceCatalog()` when an invalidation arrives.

The direct-runtime equivalents are exported through
`@commonfabric/runtime-client/shared-space-catalog`. They require a client
runtime with the Home principal's identity. Serving runtimes are refused so an
unscoped call cannot write the service identity's catalog. The browser worker
uses these same transaction functions and applies its host-read gate before
admitting the operation. Its read policy is described in the runtime-client
README.

## Offer receipts

A registration may include a validated `{ from, id }` offer identity. Its
receipt and the catalog entry commit in the same Home transaction. The key is
the pair of sender DID and offer ID. The receipt retains the space, memory host,
and kind; reuse of that key for another target is a conflict. Two senders may
use the same offer ID independently. Receipts remain when an entry is archived,
and a new receipt never restores an archived entry.

The receiving application validates the sender, recipient access, and target
before calling registration. A receipt is evidence of that application action,
not server-attested sender authentication. The catalog stores no invitation
bearer, identity key, profile inbox pointer, or delivery endpoint. Adopting an
inbox or changing its ACL is a separate operation.

## Client integration

The SDK provides the storage contract. Product clients still need to adopt it
for explicit save/join, background registration of durable bindings,
reconstruction, archive/restore, and their lists. `Home.spaces`, the site table,
and browser recents do not automatically populate this catalog. A successful
SDK test does not establish deployed web-to-native recovery.

Registration pending in CFS can be derived from a durable local binding without
a new retry journal. Membership changes require the durable action ID and
observed catalog revision if a client promises completion across restart. A
local membership mismatch alone is never authority to overwrite Home.
