# Shared-space catalog

The Home pattern owns the shared-space catalog: which social spaces a person
keeps in their collection. Its `sharedSpaces` surface separates private
observations from command bindings. Authored patterns and host applications use
the same operations. The flat `sharedSpaceCatalog`, `registerSharedSpace`,
`changeSharedSpaceMembership`, and `removeSharedSpace` fields are aliases over
the same storage and streams, as is `markSharedSpaceDeleted`.
Catalog types, validation, and transitions live in
`patterns/system/shared-space/shared-space-catalog.ts`.

The catalog's backing cell has Home's stable `sharedSpaceCatalog` cause. An
in-place source update retains that identity. Supported root-recreation commands
refuse an existing identity Home before stopping or unlinking it. Home source
changes use in-place updates to retain its account data.
The [integration plan](../plans/shared-space-catalog-pattern-access.md) lists
the remaining deployment and consumer requirements.

## Product interface

Consumers discover the authenticated actor's Home through the ordinary Home
root path, then select the role they need. The grouped surface is additive;
its required outputs are produced by Home setup, and the backing catalog keeps
its stable cause. Importing Home's full output type or binding the whole
`sharedSpaces` object selects unrelated private observations.

| Path below Home | Role |
| --- | --- |
| `sharedSpaces.commands.register` | Admit a target the caller has vetted |
| `sharedSpaces.commands.changeMembership` | Archive or restore at the observed revision |
| `sharedSpaces.commands.markDeleted` | Record that a listed space is deleted, at the observed revision |
| `sharedSpaces.view` | Validated collection observation and membership lists |
| `sharedSpaces.receipts` | Validated offer-admission evidence |
| `sharedSpaces.profiles` | Which of the person's profiles acts in each space |
| `sharedSpaces.imports.remove` | An application's undo of its own import |

Pattern consumers can wish for `#default/sharedSpaces/commands` with
`scope: ["~"]` and the shallow `SharedSpaceCommands` role exported by
`patterns/system/shared-space/shared-space-interface.ts`. A reader selects
`#default/sharedSpaces/view` with `SharedSpaceCollectionView`, or a narrower
local projection. The `~` scope is essential: an unscoped `#default` names the
current social space's root. No catalog-specific wish builtin is required.

Host projections are exported by `@commonfabric/home-schemas`:
`sharedSpaceCommandsSchema`, `sharedSpaceCollectionViewSchema`,
`sharedSpaceReceiptViewSchema`, `sharedSpaceProfileViewSchema`, and
`sharedSpaceImportCommandsSchema`. Apply a
projection to its individual role cell, for example
`home.key("sharedSpaces").key("view").asSchema(sharedSpaceCollectionViewSchema)`.
The host's materialized view type is `HomeSharedSpaceCollectionView`; the
authored pattern observation type is `SharedSpaceCollectionView`.
These schemas describe the interface; Home's authored validator and handlers
own the catalog rules. Command projections retain every event field so an
optional malformed value reaches that validator. Handler result receipts remain
the operation completion mechanism.

Retain the role's cell path across source updates, and resolve a command from
that path when invoking it. Home publishes refreshed handler bindings when its
source changes; a resolved stream endpoint is a snapshot of one binding. The
Home root and the catalog backing cell retain their identity. The flat and
grouped paths expose the same current streams.

The flat command streams keep their named Home addresses; grouped commands
alias them through Home's own result. Home exposes its collection browser as
`socialSpaceCollection`, including its session-local controls. That result key
names the browser's instance, so adding it does not consume an existing
anonymous cause or move the flat catalog observation's computed document.

The collection view is either `status: "ready"` or `status: "unavailable"`. An
unavailable observation reports `loading` for an undefined value and `malformed`
for a value the complete catalog validator refuses. A ready view has `entries`,
keyed by space DID, and `saved`, `archived`, `deleted`, and `other` lists. It
also has `byKind`, whose keys are the kinds actually present and whose values
contain those four lists. An absent kind has no entry. For presentation, lists
sort admission hints newest first, treating missing times as zero and breaking
ties by space DID. This display order establishes no authoritative chronology or
conflict precedence. Entries retain extension fields and opaque revisions;
unfamiliar states appear under `other`. The receipts view has the same
availability distinction and exposes `offers` when ready.

Read availability establishes a valid initialized observation. It does not
establish synchronized loading, producer-interface absence, or durable command
completion. Native clients still retain their last confirmed projection and
handle transport failure, denied access, optimistic rollback, and a settled
incompatible Home as described below.

Command bindings carry no collection data. A social-space handler may write its
shared records and send a registration to Home without reading membership. Home
handles that command in its own transaction; the two operations are separate
commits, and completion of the social-space write does not confirm Home's
registration. Reading the private view in the shared-record handler introduces
private confidentiality into that handler's writes. Selecting commands avoids
reading collection observations; it grants no additional access and declassifies
no data. An application's rendered membership list reads the view privately and
sends its observed revision to Home when the person chooses archive or restore.

Structural role separation does not remove labels already declared on Home or
manager documents. FabriChat sends through the flat wrapper-to-core manager link
chain are covered under a root-private core. Manager-derived UI computations
that persist in a room's shared space and direct bindings to a labeled manager
remain separate limitations. Grouped command and observation roles alone do not
establish that those reads are safe.

Home's **Social spaces** tab browses the same validated collection. Search,
kind, and membership filters are session-local. It lists saved and archived
spaces independently of target-space availability, deleted spaces in a view of
their own with no membership control, and preserves unfamiliar states in a
separate view with no membership control. Archive and restore use
the revision embedded in the rendered control's event, so a newer peer choice
causes a conflict notice instead of being replaced. Opening uses ordinary shell
space navigation and its configured routing; listing does not fetch target
roots, add routing hints, grant access, or change the navigation list.

## Identity and routing

Each catalog entry is keyed by space DID and has an accepted memory host, kind,
collection state, and membership revision. The initial registration may also
provide a display title, which a retitle can later refresh. The space DID is its
identity; the host is a routing fact. Registration refuses an existing entry
with a different host or kind. Applications resolve the current root from the
space when opening it.

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

A registration may also name `profile`, the space DID of the person's profile
that acts in the space. "The profile acting in a space" below says what Home
records of it.

The whole of what `registerSharedSpace` does is `registerSharedSpaceIn()`,
exported beside it, which takes the catalog's writable cell and a registration
and stages its writes in the transaction of the handler that calls it. So a
Home-space handler holding the catalog cell can register a space in the same
commit as its own writes, and gets back the outcome the handler would return. A
new entry's revision names the calling handler's event, so only a handler can
call it.

Likewise, the whole of what `changeSharedSpaceMembership` does is
`changeSharedSpaceMembershipIn()`, exported beside it, which applies a
membership choice in the calling handler's transaction and returns the outcome
the handler would. So a handler can archive or restore an entry in the same
commit as its own writes. The revision the change names as observed is the one
the person saw, carried in on the event. A handler that reads the current
revision and names that one gives the check up, which is right only where the
person's request is the choice whatever the entry's state. A new revision names
the calling handler's event, so only a handler can call it.

`retitleSharedSpaceIn()` sets an existing entry's display title in the calling
handler's transaction, to the title the space's root now gives. It writes only
when the title differs, and returns `retitled`, `unchanged`, or `conflict` for a
space with no entry. It moves no revision, state, or last action: a title is a
display hint, not a membership choice, so a choice made from a list shown
before the retitle still names the current revision. Home exposes no command
for it; the application that knows the root's current title calls it from its
own handler.

FabriChat's manager in Home calls all three from its own handlers. For standalone
`fabrichat-room` spaces, the catalog's current state and revision govern the
chat list, including when a saved container also declares that room. Creating a
room, or accepting one a manager created, registers the room's space. Forgetting
a standalone room archives its entry, naming the revision the person's list
showed. Finding a direct room again, or accepting a room, restores its entry if
it was archived. Asking to open or accept the room is the person's choice to
have it listed, so that restore names the revision the handler reads. Catalog
restoration supersedes a prior room tombstone; catalog archive or removal
supersedes a saved room record. Registration takes a standalone room's title,
direct room or group, and whenever the manager hears of a listed room, from a
join or an acceptance, it retitles the entry where the room's title has moved
on, except for the join a room sends with each message or reaction, which
never changes the title. A room's retitle tells the retitling member's manager
at once; another member's catalog follows on their manager's next other event
for that room, such as opening it.

Other saved spaces expose conversations through their roots' explicit
`chatRoom` declarations. FabriChat keeps choices about those individual rooms
separately from the container's catalog entry. Forgetting such a conversation
leaves its container saved and suppresses rediscovery through the declaration.
See [FabriChatManager](../specs/fabrichat/FabriChatManager.md).

FabriChat consumes the manager's flat fields through its room-specific schema.
Shared-record handlers bind individual streams without materializing a manager
selection. The manager's stored defaults and module are independent of the
catalog interface; changing that module or its room dependency requires separate
state-retention verification. New catalog consumers select Home's grouped roles
rather than the manager's complete result or its stored catalog.

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
observation, not a membership change. A `deleted` entry names a space that has
been deleted, as [Deleted spaces](#deleted-spaces) describes. Stored states are
extensible nonempty strings of at most 32 characters. Readers retain `left` and
other unfamiliar states without listing them as saved, archived, or deleted.
`changeMembership` applies only saved and archived choices, and `markDeleted`
moves only a saved or archived entry to `deleted`; an action on an entry in
another state returns
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

## Deleted spaces

Deleting a space
([random space identities](../specs/random-space-identities.md#deleting-a-space))
ends it for everyone, and writes nothing in anyone's catalog: each entry naming
the space keeps its state and revision until a consumer comes upon the
deletion. The consumer then records it with `markDeleted`, which takes the
space DID and the revision its caller observed, and moves the entry to the
`deleted` state. That carries the space's tombstone into the person's own
collection, so a list stops offering a space nobody can open.

`markDeleted` changes the entry only when all of these hold, checked in this
order, and otherwise returns `conflict` with the reason given:

| Condition | Reason |
| --- | --- |
| the catalog has an entry for the space | `missing` |
| the entry is still at the observed revision | `revision` |
| the entry is `saved` or `archived` | `unsupported-state` |
| `spaceDeleted(space)` returns `true` in the handler | `not-deleted` |

The last check is the handler's own: it asks the runtime it runs on, as
[`space-access.md`](space-access.md#a-deleted-space) describes, so an event
naming a space that is not deleted, forged or mistaken, changes nothing. The
handler passes the entry's space DID, and on a runtime that has not opened the
space, the call has the handler run again once the memory server has answered
for it. A runtime with no memory server it can ask about the space reads
`undefined`, and the handler returns `not-deleted`. Success returns `deleted`,
advances the entry's revision as a membership change does, and keeps `since`,
`from`, the title, and every offer receipt naming the space.

`deleted` is terminal. No command restores or saves a deleted entry:
`changeMembership` returns `conflict: unsupported-state` for it, and a later
registration of the same space, from an offer or a direct save, returns
`existing` and leaves it `deleted`, as registration leaves any existing entry's
membership. The entry and its receipts stay, so a replayed or stale offer for
the space is refused as before rather than admitting it as a new entry. A view
lists a deleted entry under `deleted`, apart from saved and archived ones, with
no membership control.

Consumers call `markDeleted` when they come upon a deleted space, and nothing
sweeps the catalog for them. The shell sends it when a `spaceaccesslost` it
receives is marked `deleted` and the catalog holds the space as saved or
archived, at the revision its view shows. A pattern that lists catalog entries
sends it for an entry whose `spaceDeleted(space)` reads `true`. As with the
other commands, the whole of what the handler does is
`markSharedSpaceDeletedIn()`, exported beside it, so a Home-space handler
holding the catalog cell can record the deletion in its own transaction.

Deleting a space is not implemented yet, and neither are `markDeleted`, its
flat alias `markSharedSpaceDeleted`, `markSharedSpaceDeletedIn()`, and the
`deleted` lists.

## The profile acting in a space

A person can have several profiles, and acts in each social space as one of
them. Which one is part of the person's membership in the space, so Home
records it beside the catalog, in `sharedSpaceProfiles`: a record per space,
keyed by the space's DID as the space's entry is, holding `{ space, profile }`,
where `profile` is the profile's own space DID. A record belongs to the space,
not to any root the space has, so replacing the space's root, archiving and
restoring its entry, a restart, and a host reading Home afresh all leave it as
it is.

A registration naming `profile` records it when Home records no profile for
the space, whether the registration admits a new entry or names one already
there. A host that joins a space, or makes one social, records the profile the
person acts as there by naming it in its registration, and the share intake
records the profile an offer's `toProfile` names
([the private inbox](private-inbox.md#the-share-intake)). Repeating the
profile Home records is a replay: the result is the one the registration
would have without it, and nothing about the record changes. A registration
naming no profile leaves the record as it is. A record is never replaced or
removed. Home records no profile for a registration, and the registration
returns `conflict` with the reason, when:

- Home records another profile for the space, or holds a record for it that
  this writer cannot read (`profile`);
- Home records none, and the named profile is not one of the person's live
  profiles (`unknown-profile`): one Home's `profiles` list holds, that is the
  person's own by the one rule for every reader of which profiles are the
  person's (`profileOwnerOf()`, which applies `profileOwnerAt()` in
  `runtime/runner/src/profile-owner.ts`; "Profile" in
  [`HOME_SPACE.md`](../common/conventions/HOME_SPACE.md) states it), and that
  `retiredProfiles` does not list. A label that cannot be read fails the
  registration, which writes nothing, rather than refusing the profile.

Such a registration still registers the space and the offer's receipt, as one
naming no profile would; only the profile is refused. The result carries the
space and `registration`, `registered` when it admitted a new entry and
`existing` when it found one. The offer's receipt, new or already there,
carries the reason as `profileConflict`, so a reader of the receipts, such as
the share intake, can tell an offer whose profile Home refused from one it has
not seen. A later registration of the same offer naming a profile replaces
that reason with its own outcome, so one that records the profile clears it. A
conflict over the host, the kind or the offer's receipt still writes nothing.

Home records no profile that no registration named. There is no rule that
infers one for a space registered without a profile, and nothing chooses the
person's default profile for such a space.

`removeSharedSpace` leaves a space's record in place when it takes the entry
out, so a later registration of the space naming that profile records nothing
new, and one naming another is a `conflict`.

`sharedSpaceProfiles` carries its write contract on the stored document
itself, as `retiredProfiles` does: `registerSharedSpace` alone writes it, the
whole and each record alike, and any other write is refused. The contract
names the handler's code, so another pattern can bind the same handler to
Home's records. Since the handler only adds a record where there is none, such
a binding can neither replace nor remove a record, and a registration naming a
profile refuses a binding missing Home's `profiles` or `retiredProfiles`, and
one where the records, the lists and the catalog are not each the field of
their name of the result that owns the records (`resultOwnerOf()`), as Home's
are, since the lists decide which profile it may record. The catalog's field is
`sharedSpaceCatalogStorage`, the document Home stores the catalog in, which
`sharedSpaceCatalog` reads. It asks for no gesture, so any pattern that reaches Home's streams
can record one of the person's live profiles for a space that has none by
registering it.

`sharedSpaces.profiles` is the reader's view. It is `unavailable`, as the
collection view is, while the catalog, the records, or Home's lists are
unfinished (`loading`) or malformed (`malformed`). It decides whether a
recorded profile is one of the person's own when it is read, by the same rule
a registration applies. A ready view has `spaces`,
which holds, for each space the catalog has an entry for, one of the states
below, and `live`, the spaces of the person's live profiles, which a
registration can record, so that the share intake can tell when a profile it
was refused for becomes one:

| `status` | Meaning |
| --- | --- |
| `unrecorded` | Home records no profile for the space, as for a space registered by a registration naming none |
| `unreadable` | Home holds a record for the space that this reader cannot read |
| `live` | The record names `profile`, one of the person's own profiles |
| `retired` | The record names `profile`, one of the person's own profiles that they retired |
| `foreign` | The record names `profile`, which is not one of the person's own now: Home does not list it, or it is not the person's own by the rule a registration applies |

A space the catalog has no entry for has no key in `spaces`. None of these
states means the person's default profile. A host that needs to know which
profile acts in a space does not act in it as any profile while it reads
`unrecorded`, `unreadable`, `retired`, or `foreign`. A registration naming a
profile settles `unrecorded`. Restoring the retired profile settles `retired`,
and its becoming the person's own again settles `foreign`.
Nothing replaces an `unreadable` record, so a space holding one stays
unsettled. A host reads it as
`home.key("sharedSpaces").key("profiles").asSchema(sharedSpaceProfileViewSchema)`,
and gets an `undefined` value, as for the collection view, until Home has
produced it.

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
follow custom source. If the catalog or the registration or membership handler
is absent, consumers report `home-update-required`, retain their last confirmed
projection, and wait for a compatible Home update rather than blindly retrying
operations. A consumer that removes entries reports the same state when
`removeSharedSpace` is absent; that absence does not make Home outdated for a
consumer that only registers or changes membership. An
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

Host, kind, and admission provenance describe the first accepted registration.
A title is a display hint: repeated registration does not refresh it, a retitle
does, and applications read the space's root for its current name. Host and
kind conflicts require investigation rather than an automatic rewrite. There is
no supported route-migration operation in this API.

Changing a target's host or kind is an exceptional owner-authorized repair. It
must preserve a backup, compare its observed catalog at commit, and update every
retained receipt naming the target in the same transaction, so receipt and entry
evidence cannot disagree.

Archive is the person's removal from the ordinary collection; it retains the
membership and receipt evidence. Home's `removeSharedSpace` handler instead
takes an entry back out of the catalog, so that an application that registered
spaces on the person's behalf can undo that import. That is its only purpose: it
is not a general way to delete or clean up entries, nothing a person invokes
calls it, and Home renders no control for it. The caller removes only entries it
can show it registered itself. It takes the space DID and the revision its
caller observed, and removes the entry only while it is still at that revision
and no offer receipt names it. The result is `removed`, or `conflict` with the
reason `missing`, `revision`, or `offer`. An entry a receipt names stays:
deleting the entry alone leaves invalid receipts, and deleting its receipts as
well loses replay evidence and permits a stale offer to recreate the entry. The
caller keeps the entry it observed as its backup.

Removal leaves no record in the catalog. A later registration admits the space
as a new entry, so an application undoing its import stops registering those
spaces first. A re-admitted invocation of the original registration recreates
the entry at its original revision, because the generation restarts with the
entry and the event key repeats with the invocation; a caller still holding
that revision therefore acts on the recreated entry.

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
