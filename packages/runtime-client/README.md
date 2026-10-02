# Runtime client

`RuntimeClient` connects a host to the Common Fabric runtime and renderer.

## Reading render state

`CellHandle.pull()` demands lazy producers and crosses the runtime-wide
commit-aware barrier before returning their value. Renderers can use
`pull({ awaitDurability: false })` to demand producers and read reactive state
while writes remain unconfirmed. This option still waits for reactive work and
required loads; it cannot bypass a blocked producer or storage read. A cell with
no value yet, or only an empty plain object, crosses that barrier as the default
pull does, because the write that creates its value may be one still in flight.

A rendered value does not confirm that a write was saved. Hosts using this
option should continue observing `RuntimeClient.hasPendingWrites()` and
`pendingwriteschange` to show unsaved state and guard navigation. The barrier
covers pending pattern work as well as commits. Operations that require
durability should retain the default pull.

## Diagnosing pending writes

`RuntimeClient.getStorageDiagnostics()` asks the worker for a current storage
snapshot without waiting for idle or durability. It reports registration kind,
age, affected spaces, transaction state and known local/store sequence numbers.
Per-space snapshots include the existing session ID, replica catch-up marker,
unsettled sequences, conflict repairs and accepted writes waiting for coverage.
These identifiers can be correlated with memory-server traces without exporting
cell values or credentials. Reading the snapshot starts no storage I/O.

The pending count measures promise registrations, not distinct writes. A write
and its scheduler disposition can both appear. Lists contain at most 64 entries;
counts include omitted entries. Completed registrations are discarded. A `null`
result means the storage manager does not implement diagnostics. This request
still needs a responsive worker; `getPendingRequests()` remains available on the
host when the worker cannot answer.

## Presence rooms

`RuntimeClient.joinPresenceRoom(cell, { room? })` joins the presence room of the
cell's resolved field — or the named room, under the cell's space — on the
memory connection the runtime already holds, and returns a `PresenceRoomHandle`.
The room is the one every client of that field joins: the worker derives it from
the field's space, branch, document id, resolved scope instance, and path, so
aliases of one field share a room and different user or session instances do
not. The memory server admits the join by the runtime's session on the space,
and forgets the membership the moment it ends.

A handle carries the room's name and the facets it sets — `caret` for an
editor's focus and selection, whatever a later consumer adds — and every handle
on one room shares the membership and the record: `setName()` names the room's
participant, `setFacet()` and `clearFacet()` change this handle's share of the
record, and the merged record is published once per animation frame.
`.participants` is every other member's latest record, and `subscribe()` hears
each `snapshot`, `upsert`, and `remove` as it is applied. A `failure` ends the
room; a consumer that still wants it leaves and joins again. `leave()` releases
the handle, and the room once its last handle is gone.

A server that does not advertise `presenceV1` makes the join reject; nothing is
sent to it.

## Refused event admission

The `eventintentoutcome` event reports a refused event admission to every
accepted client attached to the runtime. Its payload contains `space` (a DID),
`eventId`, `kind: "refused"`, and `reason: "admission-refused"`. It contains no
event payload or server diagnostic text. Hosts scope their feedback to `space`
and can use `eventId` to distinguish outcomes.

A refusal means that the event was not admitted. It does not revoke read access,
and hosts can retain the space's rendered view. Authoritative access loss uses
`spaceaccesslost`. Events requiring recovery use `eventneedsattention` with
attention details.

## Retrying a refused space

`RuntimeClient.retrySpaceAccess(space)` asks the memory server once more for a
space it refused the runtime, and resolves once the server has decided. It is
for a host with word that the runtime's principal was granted access, such as a
notice naming the space. The runtime asks again on its own only when the memory
server tells it, with `session/admissible`, that a grant may admit it, since the
refusal otherwise turns on an access list it cannot read; a connection the
runtime closed on its first refusal of a space hears no such word. The retry
goes through the memory server's ordinary session admission, so it can admit
only what that admission would. An admission clears the refusal, tells the
render boundaries and every `spaceAccess(target)` computation that read it, and
repeats the loads the refusal failed. A refusal leaves the space refused, and
the call resolves all the same; any other failure rejects it. A space the
runtime has not opened is left alone.
[`docs/features/space-access.md`](../../docs/features/space-access.md) says how
the answer is kept current.
