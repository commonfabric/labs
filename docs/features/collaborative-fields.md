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
([`../../packages/runtime-client/README.md`](../../packages/runtime-client/README.md)).
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

A record is published once per animation frame. A hidden document is given no
animation frames, so there the runtime client paces the publication on a timer
of a frame's length instead: a name set in a document that never paints, such
as a host's background document, is sent all the same.

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
[`../../packages/iframe-sandbox/README.md`](../../packages/iframe-sandbox/README.md)
covers the guest API, and
[`../common/ai/iframe-pattern-guide.md`](../common/ai/iframe-pattern-guide.md)
the authoring contract.

`cf-loom-presence` is the third consumer, and its room belongs to a Loom
rather than to a field. Every client with a socialized Loom open joins the
Loom's room: a Weaver through its own runtime, and the FabriChat room the
Loom's panel renders through this element. The room is derived from an anchor
cell the Loom's space derives from a fixed cause and that nothing writes
(`joinLoomPresenceRoom()` in
[`../../packages/runtime-client/README.md`](../../packages/runtime-client/README.md)),
so the room is the space's, and a client that knows the space joins it with no
record of the Loom in hand. The element is bound a cell in the Loom's space,
reads nothing of it but its space, publishes the viewer's name, and shows the
other members by the principal the relay stamped on their records, one entry
per person however many devices they hold the Loom open on. A record with no
principal names nobody and is left out. A join refused by the connection is
asked again on the next change the element sees, not on a timer, since a join
asked the moment a runtime reports ready can race its first socket.

## Authority and lifecycle

Memory is the only integration authority. A client submits an `apply-op` with a
versioned codec id, durable submission id, field cursor, and codec payload. The
same transaction stores the submitted projection, appends canonical integrated
operations, advances the field cursor, and writes the ordinary materialized
revision.

`cf-code-editor` submits every unconfirmed local update in one apply, and
edits made while that apply is in flight go out in the next one, until none
remain. A local update is confirmed by Memory or reported through the editor's
error and reconciliation events; it is never dropped silently.

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
