# Runtime client

`RuntimeClient` connects a host to the Common Fabric runtime and renderer.

## Reading render state

`CellHandle.pull()` demands lazy producers and required loads before returning
reactive state, matching the runtime's `Cell.pull()`. Writes may remain
unconfirmed when the read returns. An absent value or an empty object is a valid
read and follows the same contract. A blocked producer or required storage read
still holds the pull open.

A rendered value does not confirm that a write was saved. Hosts observe
`RuntimeClient.hasPendingWrites()` and `pendingwriteschange` to show unsaved
state and guard navigation. `pull({ awaitDurability: true })` additionally
crosses the runtime-wide commit-aware barrier, which covers pending pattern work
as well as commits. `RuntimeClient.idle()` also crosses that barrier. Strict
writes confirm their own operation independently of the pull default.

What a pull finds reaches subscribers. Unless the handle has written since the
pull was made, or an update to the cell has reached any handle on it since, the
handle takes what the pull found, and so does every other handle on the same
cell under the same schema that has not written since. The subscribers of each
handle it changes hear it, so `get()` after a pull agrees with the value each
subscriber was last given. That includes `undefined`. The worker sends an update
holding nothing for a document it has not loaded as well, so the connection
delivers none, and a pull, which waits for the loads its read starts, is how a
subscriber that was given a value learns that the cell now holds nothing. A
`sync()` waits for no loads, and one that finds nothing leaves a value the
handle holds in place, telling no subscriber.

## Refused reads

The worker builds every answer to a host's read of a cell's value, whether
`CellHandle.sync()`, `pull()`, `initialize()` or a subscription's update, in one
place, `HostReadGate`, which decides what of the cell the host may see. An
answer is either the value or a `CellReadRefusal` that stands in its place; a
refusal carries nothing of the cell, and is never an empty value, so a read the
host could not make never reads as a cell that holds nothing.

A handle holds a refusal in place of a value. `refusal` and `lastRead()` report
it; `get()` throws `CellReadRefusedError`; `sync()`, `pull()` and `initialize()`
reject with it. A subscriber hears each refusal through the `onRefused` option
of `subscribe()`, which runs at once for a handle already refused, and its value
callback never receives one. The next admitted value, or a value the host
writes, ends the refusal.

The worker builds its gate with no display ceiling, so it refuses no read.

Every request and notification the worker sends is classified in
`REQUEST_DISPOSITIONS` and `NOTIFICATION_DISPOSITIONS`: decided by the gate,
rendered, carrying no cell value, a reference, a trusted operation, or ungated.
The answers of the channels marked as decided carry a mark only the gate gives
them, and a type-level check holds the tables to it, so a new channel fails to
type-check until it says how it stands.

## Observing authorship

`observeAuthorship(value, author, onState)` watches a value cell and the cell
claiming who wrote it, the handles a render binds as `$value` and `$author` on
`cf-cfc-authorship`, and calls `onState` with an `AuthorshipObservation`. Its
`state` is the verdict: `verified` when the value's `authored-by` names the
principal the author's label represents, `unverified` when it names another, and
`unknown` when the labels establish no authorship. It also carries the value's
label as read, and the author claim. `onState` is not called until both labels
have loaded, so a verdict never passes through `unknown` on its way to
`verified`, and is called again after each later read of either label.
`observeAuthorship()` returns a function that ends the observation.

A label counts as loaded once a read of it has finished with nothing left to
wait for. When the cell a handle resolves to reads as having no label, the
observation watches that cell and reads again once an update or a read of it
shows its document has loaded; a read that still finds none then is final. A
refused read is not a cell holding nothing, as [Refused reads](#refused-reads)
says, and it carries no attestation: a refusal ends the wait for that label, and
the verdict is reached without it. A read that fails for any other reason
decides nothing, and no verdict is reported while it stands. `cf-cfc-authorship`
draws its badge from this helper, and a host that draws no Lit component calls
it directly.

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

## Sending events

`CellHandle.send()` sends an event to the stream a handle names and logs a
refusal; `sendStrict()` rejects with it. Either resolves once the runtime has
taken the event, which says nothing of its handling: a write the stream's
handler makes that the runtime refuses, such as one whose UI contract the event
does not satisfy, resolves `sendStrict()` all the same.
`sendStrict(event, { awaitHandling: true })` waits for the handler's run as
well, and rejects with the reason when that run's commit is refused, when it
throws, and when the event is dropped or refused admission. Under server
execution the run it waits for is the served one, whose outcome reaches the
worker as the consequence the serving loop recorded for the event.

`CellHandle.sendReviewed(event, { surface, action })` sends a reviewed action
from a control the host draws itself, bound to one trusted surface and one
action. The worker stamps the event with `native` provenance for them, replacing
any `provenance` the payload carries, and marks it renderer-trusted, so a write
gated on that surface and action commits as it would for a reviewed gesture on
the pattern's rendered surface. It always waits for the handler's run, as
`sendStrict()` does with `awaitHandling`, and rejects with the reason on the
same refusals. The event is renderer-trusted but is not a trusted gesture, so it
confirms no snapshot share, custody seal, or change to an access list. That is a
gap the runtime has yet to close, not a design:
[host embedding, §11](../../docs/features/host-embedding.md#11-policy-record-native-reviewed-acts-count-as-trusted-gestures)
records that a native reviewed act counts wherever a trusted gesture does.
`sendReviewed()` mints trusted events, so it is for the host's own code alone;
[host embedding, §10](../../docs/features/host-embedding.md#10-native-reviewed-controls)
says what it owes in exchange.

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
refusal otherwise turns on an access list it cannot read; a routed connection,
and a connection the runtime closed on its first refusal of a space, hear no
such word. The retry goes through the memory server's ordinary session
admission, so it can admit only what that admission would. An admission clears
the refusal, tells the render boundaries and every `spaceAccess(target)`
computation that read it, and repeats the loads the refusal failed. A refusal
leaves the space refused, and the call resolves all the same; any other failure
rejects it. A space the runtime has not opened is left alone. A call made while
a retry of the same space is in flight shares that retry rather than asking
again, and so does the Retry button the renderer puts on a refused space's
"Access unavailable" placeholder, which reaches the same retry from inside the
worker; its placeholder reads "Retrying…" while any retry of its space is in
flight. The shell calls it when the person navigates into a space
`spaceaccesslost` named, and when the page regains focus or becomes visible.
[`docs/features/space-access.md`](../../docs/features/space-access.md) says how
the answer is kept current.
