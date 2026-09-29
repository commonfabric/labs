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

## Cell write acknowledgments

`CellHandle` exposes three overwrite contracts:

| Method        | Local display                                                                    | Promise completion                                    | Operation queue                                         |
| ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `set()`       | Publishes an optimistic handle value immediately                                 | Request acknowledgment; transport failures are logged | Releases after acknowledgment                           |
| `setStrict()` | Publishes after commit if no newer write or delivery superseded it               | Commit outcome; rejects refusal                       | Holds subsequent operations until commit                |
| `setForUI()`  | The calling control owns its optimistic display; subscriptions update the handle | Commit outcome; rejects refusal                       | Releases after dispatch so subsequent input can proceed |

`setForUI()` is for controls that protect a pending local edit while observing
the stored value through a subscription. A matching value delivery can still be
speculative; the control retains that edit until the commit outcome arrives. A
refused write must release the edit and repaint from the bound state. The commit
promise is distinct from the subscription stream: resolving it does not itself
publish a value or guarantee that a component has rendered. `get()` therefore
keeps its cached value until a worker delivery or explicit read updates it;
other subscribers receive no synchronous optimistic publication. A following
`push()` may briefly display an optimistic array built from that older cache,
although its native append is applied to the correct worker-side array.

Controls that reconcile after commit must account for handler writes already
delivered before the acknowledgment. `CellController` follows the commit with a
fresh read of the current bound view; it does not require another subscription
delivery to release the edit.

`getCacheVersion()` exposes a handle-local cache revision. It advances on local
publications, reads that update the cache, and worker value confirmations,
including unchanged values that do not notify subscribers. A read whose stale
result is declined does not advance it. Controls use it to expire temporary
display snapshots; it is not a storage version or a commit acknowledgment, and
versions from different handles cannot be compared.

`onCacheChange(callback)` observes those revisions after value subscribers have
run. It also fires for unchanged worker confirmations and successful cache
reads, so a control can repaint when a temporary display override expires. The
listener is local to the handle, has no initial callback, and opens no worker
subscription; its returned cancel function removes it. Ordinary `subscribe()`
callbacks keep their value-change contract.

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
