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
changes; any other is tried again on the next editor focus.

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
