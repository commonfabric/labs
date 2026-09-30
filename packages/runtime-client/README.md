# Runtime client

`RuntimeClient` connects a host to the Common Fabric runtime and renderer.

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
