# Collaborative fields

Collaborative fields let multiple editors change one stored value without
turning the owning Cell into a last-writer-wins document. Memory orders and
integrates versioned codec operations, stores their durable history, and writes
the resulting value through the ordinary entity revision path. CodeMirror text
collaboration is the first product consumer; the runtime contract itself is
codec-neutral.

## What remains ordinary

The Cell's materialized value remains a string for CodeMirror. Graph queries,
reactive computations, snapshots, point-in-time reads, and non-collaborative UI
consume that ordinary value. They do not read or reconstruct the operation log.

`cf-code-editor` enables this path only when its `collaborative` property is set,
its value is a string Cell handle, and the Memory server advertises
`codemirror-changeset@1`. Plain strings, non-collaborative Cell bindings, and
existing debounce behavior keep their existing whole-value write path.

## Ephemeral co-presence

Live participant names, carets, and selections travel over the memory
connection the runtime already holds, as presence rooms the memory server
relays ([`../specs/memory-v2/04-protocol.md`](../specs/memory-v2/04-protocol.md),
section 4.13). A room lives under a space and holds one membership per
connection, owned by the session that joined it; the server remembers each
member's latest record and nothing else, receives no document contents or
changes, and forgets a member the moment their membership ends. A presence
message is handled outside the ordered frame queue that memory commands wait
in, so it cannot delay, alter, or disable a memory operation. It shares the
socket with those commands, and the WebSocket hosts hand frames to the
connection one at a time, so a presence message behind a large command shares
that command's latency — an accepted cost of the shared socket.

Joining is admitted by the runtime's session on the space: space access,
decided by the memory ACL, is what lets a participant in, and there is no
separate presence endpoint, authentication, or configuration. Each record the
server relays carries the DID the publishing session was opened as, stamped
by the server, beside the client-supplied display name.

`cf-code-editor` joins only while collaborative editing is active and a
`participantName` is set, through `RuntimeClient.joinPresenceRoom()`
([`../../runtime/runtime-client/README.md`](../../runtime/runtime-client/README.md)).
A room belongs to a field, not to a person: each editor joins the room of the
field it is bound to, and everyone editing that field meets there, with one
entry per browser tab. A tab with editors for two different fields is in both
rooms, with an entry in each; two editors for the same field in one tab share
the tab's entry. An editor joins as soon as its field has a confirmed cursor
and publishes its caret; the record's `focused` says whether that editor owns
focus, and an editor publishes no selection until it has been focused once.
Blur keeps the room joined with the last selection, and unmounting an editor
leaves its room. By default the runtime derives an editor's room from the
resolved, pinned field: the space DID, branch, full schemed document id,
resolved scope instance, and complete field path are domain-separated and
hashed. An explicit `presenceRoom` overrides that derived
room. The hash is a
rendezvous key, not authorization; a human space name is display state and
does not participate in Cell identity.

A record's state is keyed by facet, and the editor publishes one: `caret`,
holding focus, the Memory `{ epoch, version }` whose document coordinates the
selection uses, the selection with CodeMirror's side association for every
range endpoint, and whether the selection is exact or mapped back over
pending local edits. A consumer decodes the facets it knows and ignores the
rest, so a further kind of state — a pointer — is one more facet and one more
renderer, with no change to the protocol. CodeMirror maps a displayable remote
selection through the same transactions that install later document changes
and through the receiver's own pending changes. A selection for a future
version waits until Memory reaches that version, while a late selection for
an already-passed version is discarded instead of being guessed into place.

Presence follows the memory connection: a reconnect rejoins every room and
republishes the last record, with no timer of the editor's own. A failure the
room reports — a refused publication, a server or runtime without presence,
the session's termination — clears only ephemeral decorations, is reported
once through `cf-presence-error` as a category with no room, name, or server
payload in it, and never makes Memory collaboration read-only. A
`configuration` failure stays reported until the room or participant name
changes; any other is tried again on the next editor focus. The editor fires
`cf-presence-join`, with no detail, each time it joins its room, so a host that
shows a presence failure can clear it once the editor has joined again.

`cf-iframe` is the second consumer. A context name whose `resourceKinds` entry
is `presence` grants the sandboxed guest the room of that context cell's
resolved field, derived exactly as an editor's room is, and none of the cell's
data. The guest chooses its own facets, such as a pointer position or a shape
held mid-drag, and sets its own display name. What it is told of another
member is that member's relay-assigned id, name, and facets; the DID the relay
stamps on a record does not cross into the guest. A relay's refusal of the
guest's join or of its publication reaches the guest in the relay's words,
since it concerns what the guest did, and any other failure reaches it as a
category alone.
[`../../base/iframe-sandbox/README.md`](../../base/iframe-sandbox/README.md)
covers the guest API, and
[`../common/ai/iframe-pattern-guide.md`](../common/ai/iframe-pattern-guide.md)
the authoring contract.

## Authority and lifecycle

Memory is the only integration authority. A client submits an `apply-op` with a
versioned codec id, durable submission id, field cursor, and codec payload. The
same transaction stores the submitted projection, appends canonical integrated
operations, advances the field cursor, and writes the ordinary materialized
revision.

Pattern code edits a collaborative field with `Writable<string>.applyChanges()`,
which takes changes in the shape of a CodeMirror change spec against the value
the handler read. The handler's commit carries them as an `apply-op` with no
base, carrying the hash of the value read, beside the handler's read of the
field. The edit lands only while the field still holds the value the handler
read, at the field's current version with nothing to rebase over. Otherwise
the read refuses the commit as an ordinary conflict, and the scheduler runs the
handler again against the new text. Under server execution a wave drops the
reads of what it seals, and the hash is what refuses a stale edit there.

The commit's ordinary patch of the document leaves the edited field as it was,
so that only the `apply-op` changes it, and Memory writes the field's new value
when it integrates the edit. The handler's own view and the replica's pending
layer show the changed text from the start. An `applyChanges()` on a field no
editor has opened activates it from the value read.

`cf-code-editor` submits every unconfirmed local update in one apply, and
edits made while that apply is in flight go out in the next one, until none
remain. A local update is confirmed by Memory or reported through the editor's
error and reconciliation events; it is never dropped silently.

The replica settles an accepted `applyOperation()` through the same catch-up
barrier as an ordinary write. While its subscription is live and the server
advertises verdict catch-up markers, the call waits for a frame covering the
operation's local sequence, so the watched materialized value has arrived
before the caller resumes. A duplicate submission crosses that barrier too.
With no marker channel, or when that channel closes, the accepted result is
returned without waiting for delivery.

Disabling collaboration keeps the editor read-only while it confirms pending
operations and refreshes the bound Cell's materialized value. The operation
stream remains the editor's display authority until that read completes. A
failed refresh leaves the editor read-only and emits `cf-error`.

One collaborative epoch owns a field until it is explicitly released or its
entity is deleted. An ordinary write may change other paths, but it cannot
change an active collaborative path. Deliberate release plus replacement may be
one ordered commit. Reopening the field creates a new epoch.

The current implementation supports only the default branch. Collaborative
queries, applies, and releases on child branches fail explicitly.

## Anchors

A collaborative field carries **anchors**: points in its value, each under an
id its writer chooses, that Memory moves with the text. An anchor is an offset
into the field. Whenever an edit integrates, the codec maps every anchor of
the field through it in the same transaction, as an editor maps a cursor: text
inserted at an anchor lands after it, text inserted before it moves it, and an
anchor inside deleted text lands where the deletion began.

A range of the field is two anchors, one where it starts and one where it
ends. Because both follow the one rule, text inserted at the start of a range
falls inside it, text inserted at its end falls outside it, a replacement of
exactly the range stays inside it, and a deletion that covers the range brings
both anchors to the same offset, which is an empty range where the text was.

The anchors live in the field's **anchors document** and nowhere else. It is
an ordinary entity at an id derived from the field's address (`of:op-anchors:`
plus a hash of the entity id, scope and path), in the field's own scope, and
its value is a map from anchor id to offset. Anyone who may write the space
changes the anchors by writing that document, as they would any entity, and
Memory refuses a write that leaves anything other than such a map in it
([`../specs/memory-v2/07-op-views-and-annotations.md`](../specs/memory-v2/07-op-views-and-annotations.md),
§7.8). In the transaction that integrates an edit, Memory rewrites the
document's value where the edit moved an anchor, and labels every anchor
with the field's confidentiality, moved or not, as described below. The rest
of the document is left as it was.

Releasing a field keeps its anchors, since the released text is the text they
refer to, and so does deleting the field's entity, which releases its fields.
A writer that deletes an entity and wants its fields' anchors gone deletes
their anchors documents in the same commit; one that leaves them has them
again if the entity is created anew. Memory moves anchors
through collaborative edits and through nothing else, so an ordinary write
that replaces the text of a released field, or of one no editor has opened,
moves none of them. The writer that replaces the text, an agent rewording a
released note for example, reads the anchors and writes them where the new
text puts them, in the same commit.

Changing anchors is therefore an ordinary transaction. A writer reads the
field and the anchors, writes the anchors it wants the field to hold, and
commits. The commit carries both reads, so it lands only while the field and
the anchors are still what the writer read: an edit from another client, or
another writer's change to the anchors, refuses it, and the writer runs again
against what the field holds now. An anchor is not an operation: it enters no
submitted or integrated projection and advances no version. Memory cannot tell
which field a write to an anchors document belongs to, so it does not check an
offset against the field's length; an offset past the end of the text is taken
as the end.

Anchors reach readers two ways. Graph queries, watches, point-in-time reads
and server-executed handlers read the anchors document as plain state. And
every operation snapshot an editor receives carries the field's anchors as the
document holds them, which can change at a cursor the editor has already
applied.

An annotation on the field, a comment, a highlight or a bookmark, is an
ordinary entity that names its anchors' ids and stores no position of its own.

Pattern code reaches the anchors document with `anchorsOf(field)`, which
returns it as a cell
([`../common/concepts/types-and-schemas/writable.md`](../common/concepts/types-and-schemas/writable.md),
"Anchoring text"). A handler given that cell and the field reads both and
writes the anchors.

An anchor says something about the field's text: where text is, how far apart
two points are, and whatever its writer put in the id. The anchors document
carries a Contextual Flow Control label from two sources.

The first is the transaction that writes an anchor. An anchor a transaction
writes carries the confidentiality of what that transaction read, by the
ordinary flow from what a transaction read to what it wrote: the field, if the
handler read it before writing the anchors, and any confidential link it
followed to reach the field or the anchors, since which document a link led
to is something an offset in that document can reveal. A writer that does
not read the field leaves the anchors under whatever it did read, which for a
writer that read nothing is no label at all: an offset its writer chose says
nothing about the field. Writing one anchor labels that anchor alone; the
other anchors in the document keep the labels they had.

The second is Memory. An offset Memory computed from an edit says where the
field was edited and by how much, and, for an anchor written past the end of
the text, how long the field is. Which anchors an edit moves also says where
it fell. So when an edit integrates, Memory labels every anchor of the
field, moved or not, with the label the field's document holds over the
field at that edit, in the same transaction. It reads the label entries
of the field's stored envelope that lie at, above or inside the field's path,
in the field's scope instance and in each broader instance of the same
document. The label-metadata templates are left out: they are keyed against
the stored document rather than its value, so none labels the field, not
even a field that is the whole value, whose path is a prefix of every path,
or one named `cfc`. The field's integrity is what a read of the whole field
carries: from the entries at or above its path, not those inside it, whose
claims hold for part of the text only. Memory joins the field's label into
the label of each anchor's offset, the one derived entry of the value class
at the anchor's path. The join keeps every clause either label held, since
a moved offset is computed from the old one. Its integrity is the meet of
the two: a hereditary claim both the anchor's writer and the field hold
stays, and every other is dropped, for an anchor the edit did not move too,
since its offset now points into text the edit changed. Where there is no
such entry, the anchor's writer vouched for nothing, so Memory makes one
holding the field's confidentiality, and none where the field holds no
confidentiality. A derived entry of no class at the path is consumed by a
read of the offset too, so its integrity is met with the field's as well,
and its clauses stay. Every
other label at the path stays as it was. A later reader
of that offset is tainted as a reader of the field was, whoever wrote the
anchor. An anchor the edit left where it was is labeled too: labeling only
the anchors that moved would show where the edit fell. An anchor written
since the last edit carries its writer's label alone until the next one.

The label is of the offset Memory wrote, and lasts as long as that offset
does:

- Each later edit joins what the field holds then into the label each
  anchor carries.
- The field's label changing without an edit leaves the anchors' labels as
  they were.
- A write that replaces the anchor's offset replaces the label with the
  writer's own, as a write of any derived value does. An offset written by a
  transaction that read nothing confidential is unlabeled again.
- Releasing the field leaves the labels in place, with the anchors.

Where an edit to a field with anchors integrates and Memory cannot read the
field's envelope, it refuses the edit and moves nothing, so that no offset is stored that is
less confidential than the field it came from. It checks the envelope with
the checks the runner uses, so it refuses one of a version it does not know,
one that names no schema, a label of a shape it does not know, and a label
held by reference in an envelope of a version that does not define that
spelling. Of the labels, it resolves only those that bear on the field: it
refuses the edit for a reference among them that no stored label document
backs, and leaves a reference elsewhere in the envelope unresolved. It does
not compare a label document with its hash, since the store installs a
`cid:` document only when its content hashes to its id. It reads the anchors
document's envelope only when it has a label to add to it, and refuses the
edit when that envelope cannot be read, or when a label it holds by
reference at an anchor's path has no stored label document behind it.

An edit can only narrow the integrity an anchor carries: a claim survives
it only where the anchor's writer made it and the field holds it too. Where
the field holds no confidentiality and Memory cannot read the anchors
document's envelope, it leaves that envelope as it is rather than refuse the
edit, since there is no clause to add and no reader honors an envelope it
cannot read. The field's write policy does not govern the anchors: a pattern that wants only certain
handlers to move anchors declares a write policy on the anchors cell.

## Checkpoints, reconnect, and reset

The operation cursor is `{ epoch, version }`. Memory creates storage-owned
checkpoints at a configured operation interval. When a later checkpoint is
created, integrated rows through the preceding checkpoint are pruned, while
submitted rows remain available for idempotency and audit.

A connected or reconnecting client at the retained floor receives the complete
contiguous suffix. A client behind the floor receives `reset: true` and the
current canonical materialized value. CodeMirror reinstalls from that value
when it has no pending edits. If it has unconfirmed local edits, the editor
preserves them, becomes read-only, and emits an explicit reconciliation event
containing both local and canonical values. A stale write fails with
`OpHistoryUnavailableError`; Memory never transforms it across missing history.

## Operational inspection

`deno task cf inspect operations <space> [entity-id] --json` reads the durable
store offline. It reports field addresses, epochs, cursors, retained floors,
submitted and integrated histories, checkpoints, pagination markers, and
consistency checks against the ordinary materialized value. `cf inspect` is
read-only; explicit pruning is a Memory engine maintenance operation.

OpenTelemetry instruments use the `ct.memory.operation.*` prefix for accepted
apply count, transform suffix length, submitted payload bytes, integration
duration, reset count, codec failures, and observed active-watch count.

The normative storage and protocol contract is
[`../specs/memory-v2/07-op-views-and-annotations.md`](../specs/memory-v2/07-op-views-and-annotations.md).
