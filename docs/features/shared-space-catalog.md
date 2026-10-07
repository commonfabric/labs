# Shared-space catalog

The Home pattern owns the shared-space catalog: which shared spaces a person
keeps in their collection. It exposes reactive `sharedSpaceCatalog` data and the
`registerSharedSpace` and `changeSharedSpaceMembership` handlers. Authored
patterns and host applications use these same operations. Catalog types,
validation, and transitions live in
`packages/patterns/system/shared-space-catalog.ts`.

The catalog's backing cell has Home's stable `sharedSpaceCatalog` cause. An
in-place source update retains that identity. Supported root-recreation commands
refuse an existing identity Home before stopping or unlinking it. Home source
changes use in-place updates to retain its account data.
The [integration plan](../plans/shared-space-catalog-pattern-access.md) lists
the remaining deployment and consumer requirements.

## Identity and routing

Each catalog entry is keyed by space DID and has an accepted memory host, kind,
collection state, and membership revision. The initial registration may also
provide a display title. The space DID is its identity; the host is a routing
fact. Registration refuses an existing entry with a different host or kind.
Applications resolve the current root from the space when opening it.

Authored code validates routes with the sandbox's existing `URL` global. Stored
hosts are canonical HTTP or HTTPS origins, the same rule used by inbox offers.
Registration also accepts case differences, explicit default ports, surrounding
whitespace, and a trailing root slash, then stores `URL.origin`. Credentials,
paths (including dot paths), query strings, fragments, backslashes, and embedded
whitespace are refused before parsing can erase them.

Consumers discover the authenticated person's Home using their identity and
configured Home host, independently of an offered space's host or profile.
Pattern consumers can follow Home through the ordinary default-pattern link;
host consumers use the same link in the configured Home space. Home's ACL
controls access to its data and handlers. A serving runtime executes the
addressed handler on behalf of the event's authenticated actor; it must not
substitute the service identity's Home. Configuring two clients with different
Home hosts still names two stores; this interface does not choose a canonical
host on their behalf. Consumers must verify their identity and route before
invoking handlers or accepting a catalog observation.

## Registration and membership

Home's `registerSharedSpace` handler accepts an application-validated kind, such
as `loom` or `fabrichat-room`. The caller first validates the target's root kind
and the recipient's access. Registration grants no access and makes no claim
that the target remains accessible. Kinds are nonempty strings of at most 32
characters, not a fixed enumeration. An intake consumer must leave offers whose
kinds it does not understand unconsumed. Readers retain entries of other kinds
and filter explicitly for the kinds their application understands.

Registration is insert-if-absent. An existing entry keeps its title, revision,
and membership, including when a new offer names it. The returned status is
`registered`, `existing`, or `conflict`. Separate registrations run through
Fabric's transaction conflict handling so one client cannot replace another's
entry with its stale collection. A legacy binding may supply
`initialState: "archived"` to insert an archived entry in the same commit;
omitted `initialState` means saved. This hint never overrides an existing Home
entry.

The whole of what `registerSharedSpace` does is `registerSharedSpaceIn()`,
exported beside it, which takes the catalog's writable cell and a registration
and stages its writes in the transaction of the handler that calls it. A
Home-space handler holding the catalog cell calls it to register a space in the
same commit as its own writes, as a room's creator can register the room it
creates; it returns the outcome the handler would. A new entry's revision names
the calling handler's event, so only a handler can call it.

New entries record `since`, the recipient's admission time in epoch
milliseconds. Registration records it when admitting the entry; a migration may
supply a historical value. It is a handler-clock display hint, not a revision,
server timestamp, or ordering authority. An offer-backed first registration also
records `from`, that offer's validated sender DID. A direct save has no sender.
Subsequent offers and membership changes preserve both fields, even if the
initial save had no sender. Older entries may lack either field; lists must
handle that absence. The sender's `sharedAt` claim is not substituted for
recipient admission time.

`saved` entries belong in the ordinary collection. `archived` entries belong in
the archived collection with an explicit restore action. Both states retain the
entry and leave the space's ACL unchanged. Access loss is an independent
observation, not a membership change. Stored states are extensible nonempty
strings of at most 32 characters. Readers retain `left` and other unfamiliar
states without listing them as saved or archived. This API can apply only saved
and archived choices; an action on an entry in another state returns
`conflict: unsupported-state`, including an attempted confirmation. A future
writer must define the additional state's transitions.

Stored revisions are nonempty strings of at most 320 characters. When applying
a new membership action, a writer that cannot advance the stored revision
returns `conflict: unsupported-revision`. This includes an unfamiliar revision
format and a generation whose next token would exceed the length bound. The
catalog remains unchanged. Other entries remain readable and writable.

The catalog uses additive evolution without a root version gate. Readers
preserve extra root and entry fields and opaque `lastAction` evidence. A writer
that cannot interpret an entry's action evidence, or finds that its action state
differs from the entry's state, returns an `action` conflict for that entry.
Other entries remain readable and writable. The type and meaning of every
existing field, including optional fields, are fixed. A different representation
needs a new field name: changing the admission timestamp from epoch milliseconds
to an ISO string makes the stored document invalid to readers of this contract.
Incompatible changes to required fields need an explicit migration contract;
changing an ignored `version` extension does not enable incompatible semantics.

Home's `changeSharedSpaceMembership` handler takes the space DID, a durable
action ID, the membership revision the user observed, and the desired state.
Each applied action creates a new revision, including a choice that names the
same state. The local loom version and a timestamp are not catalog revisions. An
action based on an older revision returns `conflict` and does not rebase itself
onto a newer choice.

The entry retains the last action's ID, observed revision, and requested state.
Repeating that exact action returns `confirmed` while its evidence remains
current. Reusing its ID with different arguments conflicts. A later action can
make an older action impossible to confirm; clients surface that conflict rather
than replaying it. These records are application confirmation metadata, not a
general command queue or a complete action history.

An operation result describes the request and contains only its outcome and
identifiers. Consumers obtain current membership from the catalog's reactive
read surface. They never install membership from an operation reply. `confirmed`
means the action was applied, not that it remains the latest choice.

## Confirmation and unavailable data

Handlers read and write in the platform-supplied transaction. Their returned
outcomes use ordinary handler result receipts, committed with the handler's
consequences. Even a registration of an existing entry has a result receipt;
local event enqueue or an optimistic subscription update alone is not durable
completion. Host callers that need that guarantee use the normal `sendEvent`
completion callback and its handling receipt, distinguishing an appended event
from its completed handling. Authored consumers use the ordinary handler stream.

A receipt can outlive the membership it reports. Replaying the same durable
event after a later action can return the original successful outcome while the
catalog shows the later choice. A new membership invocation carrying a stale
observed revision conflicts. An ordinary transaction conflict can rerun the
handler, but the request retains its original action ID and revision.
A revision combines a positive decimal generation and the existing `eventKey()`
as `<generation>:<event-key>`. Registration starts at generation 1; each
membership transition increments it in the same transaction as the state and
action evidence. `BigInt` arithmetic keeps the increment exact beyond
JavaScript's safe integer range. The generation prevents a re-admitted
invocation ID from restoring an earlier revision. The event key distinguishes
two optimistic writes that start at the same generation, including competing
first registrations. If a user acts on a tentative transition that later loses
to a peer, that queued action conflicts instead of silently applying to the
peer's different choice at the same generation.

The writer refuses an uninterpretable generation or a resulting revision longer
than 320 characters before changing any entry fields. Readers preserve
unrecognized revision strings; consumers treat the whole revision as opaque and
retain the value they observed rather than computing one. Retrying the same
transition preserves the token.

A revision is an optimistic concurrency token, not proof that a client observed
the value or an authorization capability. Home's ACL authorizes its owner to
invoke these handlers; callers retain the observed revision to express which
choice their action may replace. Exceptional repair must preserve generation
monotonicity as well as the entry and receipt evidence.

Callers must retain the same payload when retrying an invocation ID: the
ordinary receipt is first-writer-wins even if a later admission runs a handler.

Consumers subscribe through ordinary cells: reactive reads in patterns and
`Cell.sink` in direct-runtime hosts. Updates may be optimistic and may roll
back. Failed, refused, malformed, or unfinished reads are not empty collections.
The catalog validator reads a broad object shape before selecting known fields
so a typed link cannot hide a malformed optional value. Only a valid initialized
catalog is usable; an unavailable value is never defaulted to an empty catalog.

Native consumers must retain their last confirmed projection and expose load and
failure status separately. A generic subscription supplies values, not a
complete load/error or operation-acknowledgment protocol. Consumer integration
must demonstrate that distinction before replacing a durable local collection.

Even a completed `Cell.pull()` may return `undefined` while a serving Home is
still producing its first computed output. Keep that state unavailable and
observe the ordinary subscription for a valid catalog; a completed read alone
does not establish producer readiness or the absence of an interface.

A successfully loaded, accessible Home may predate this catalog interface or
follow custom source. If the catalog or either handler is absent, consumers
report `home-update-required`, retain their last confirmed projection, and wait
for a compatible Home update rather than blindly retrying operations. An
unfinished or refused read, or a producer that has not settled, cannot establish
that the interface is absent.

## Offer receipts

A registration may include a validated `{ from, id }` offer identity. Its
receipt and the catalog entry commit in the same Home transaction. The key is
the pair of sender DID and offer ID. The receipt retains the space, memory host,
and kind; reuse of that key for another target is a conflict. Two senders may
use the same offer ID independently. Receipts remain when an entry is archived,
and a new receipt never restores an archived entry.

The receiving application validates the sender, recipient access, and target
before calling registration. The host's share intake is that application for
offers in Home's private inboxes; [the private
inbox](private-inbox.md#the-share-intake) says what it checks. A receipt is
evidence of that application action, not server-attested sender authentication.
The catalog stores no invitation bearer, identity key, profile inbox pointer, or
delivery endpoint. Adopting an inbox or changing its ACL is a separate
operation.

## Repair and retention

Host, kind, title, and admission provenance describe the first accepted
registration. A title is a display hint; applications read the space's root for
its current name. Repeated registration does not refresh that hint. Host and
kind conflicts require investigation rather than an automatic rewrite. There is
no supported route-migration, retitle, or repair operation in this API.

An exceptional owner-authorized repair must preserve a backup and compare its
observed catalog at commit. Changing a target's host or kind also requires
updating every retained receipt naming it in the same transaction, so receipt
and entry evidence cannot disagree. Deleting an entry alone leaves invalid
receipts. Deleting its receipts as well loses replay evidence and permits a
stale offer to recreate the entry. Archive is the supported removal from the
ordinary collection; it retains the membership and receipt evidence.

Receipts are retained indefinitely. The catalog is one document, so reads,
validation, and receipt storage grow with the collection and its receipt
history. Handlers update individual entry paths and preserve unknown fields. TTL
deletion is not safe without another retained deduplication record. Large-scale
retention or compaction needs a separate design that preserves replay refusal
and existing membership. This API implements neither automatic compaction nor a
size-based reset.

## Consumer integration

Home provides the catalog contract and its handlers. Product clients still need
to adopt them for explicit save/join, registration of durable shared bindings,
reconstruction, archive/restore, and their lists. Private, unshared hosted looms
are excluded from catalog migration. `Home.spaces` remains the navigation list,
the site table holds routing hints, and browser recents are local navigation
history; none automatically populates this catalog.

The catalog has no independent SDK mutation implementation. A host consumer
follows Home's cells and invokes its handlers using normal runtime facilities. A
wrapper may coordinate discovery, invocation, subscriptions, or errors, but must
not own a second copy of the catalog rules. Any new platform adapter must name
the demonstrated gap it closes. The direct-runtime Loom sidecar can use existing
handler receipts without adding a runtime-client protocol.

Registration pending in CFS can be derived from a durable local binding without
a new retry journal. Membership changes require the durable action ID and
observed catalog revision if a client promises completion across restart. A
local membership mismatch alone is never authority to overwrite Home.
