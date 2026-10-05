# Shared-space catalog

The shared-space catalog records which shared spaces a person keeps in their
collection. Its schema and deterministic cause are exported by
`@commonfabric/runtime-client/shared-space-catalog-contract`, which re-exports
the runner's contract module. One document lives in the principal's Home under
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

`RuntimeClient.registerSharedSpace(home, registration)` accepts an
application-validated kind, such as `loom` or `fabrichat-room`. The caller first validates the target's root kind and
the recipient's access. Registration grants no access and makes no claim that
the target remains accessible. Kinds are nonempty strings of at most 32
characters, not an SDK-owned enumeration. An intake consumer must leave offers
whose kinds it does not understand unconsumed. Readers retain entries of other
kinds and filter explicitly for the kinds their application understands.

Registration is insert-if-absent. An existing entry keeps its title, revision,
and membership, including when a new offer names it. The returned status is
`registered`, `existing`, or `conflict`. Separate registrations run through
Fabric's transaction conflict handling so one client cannot replace another's
entry with its stale collection. A legacy binding may supply `initialState:
"archived"` to insert an archived entry in the same commit; omitted
`initialState` means saved. This hint never overrides an existing Home entry.

New entries record `since`, the recipient's admission time in epoch
milliseconds. Registration captures it once before transaction retries; a
migration may supply a historical value. It is a client-clock display hint,
not a revision, server timestamp, or ordering authority. An offer-backed first
registration also records `from`, that offer's validated sender DID. A direct
save has no sender. Subsequent offers and membership changes preserve both
fields, even if the initial save had no sender. Older entries may lack either
field; lists must handle that absence. The sender's `sharedAt` claim is not
substituted for recipient admission time.

`saved` entries belong in the ordinary collection. `archived` entries belong in
the archived collection with an explicit restore action. Both states retain the
entry and leave the space's ACL unchanged. Access loss is an independent
observation, not a membership change. Stored states are extensible nonempty
strings of at most 32 characters. Readers retain `left` and other unfamiliar
states without listing them as saved or archived. This API can apply only saved
and archived choices; an action on an entry in another state returns
`conflict: unsupported-state`, including an attempted confirmation. A future
writer must define the additional state's transitions.

The catalog uses additive evolution without a root version gate. Readers
preserve extra root and entry fields and opaque `lastAction` evidence. A writer
that cannot interpret an entry's action evidence, or finds that its action
state differs from the entry's state, returns an `action` conflict for that
entry. Other entries remain readable and writable. The type and meaning of
every existing field, including optional fields, are fixed. A different
representation needs a new field name: changing the admission timestamp from
epoch milliseconds to an ISO string makes the
stored document invalid to readers of this contract. Incompatible changes to
required fields need an explicit migration contract; changing an ignored
`version` extension does not enable incompatible semantics.

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

An operation first waits for this runtime's earlier optimistic writes to settle
so an unconfirmed local value cannot become its baseline. The scheduler barrier
covers the whole runtime and can therefore wait on unrelated work. It is a
correctness barrier for confirmed SDK operations, not a list-rendering API.
A future narrower barrier must prove the same guarantee for the catalog.

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

## Repair and retention

Host, kind, title, and admission provenance describe the first accepted
registration. A title is a display hint; applications read the space's root for
its current name. Repeated registration does not refresh that hint. Host and
kind conflicts require investigation rather than an automatic rewrite. There
is no supported route-migration, retitle, or repair operation in this API.

An exceptional owner-authorized repair must preserve a backup and compare its
observed catalog at commit. Changing a target's host or kind also requires
updating every retained receipt naming it in the same transaction, so receipt
and entry evidence cannot disagree. Deleting an entry alone leaves invalid
receipts. Deleting its receipts as well loses replay evidence and permits a
stale offer to recreate the entry. Archive is the supported removal from the
ordinary collection; it retains the membership and receipt evidence.

Receipts are retained indefinitely. The catalog is one document, so reads,
validation, copies, value-hash pins, and writes grow with the collection and
its receipt history. TTL deletion is not safe without another retained deduplication
record. Large-scale retention or compaction needs a separate design that
preserves replay refusal and existing membership. This API implements neither
automatic compaction nor a size-based reset.

## Pattern access

Authored patterns cannot import this host SDK, and it exposes no pattern-facing
catalog capability. The runner's portable data module supplies synchronous
registration and membership transitions shared with the SDK. Its caller must
validate the complete raw catalog and input, establish principal and route
authority, and confirm the enclosing transaction. The core emits minimal field
writes so an adapter need not replace extensions omitted by a typed projection.
It does not provide a validated reactive read or Home discovery.

A raw cell link does not supply the SDK's registration, receipt, revision, or
confirmation semantics. The
[pattern integration plan](../plans/shared-space-catalog-pattern-access.md)
describes the work needed for Labs-only consumers.

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
