---
status: historical
created: 2026-08-26
archived: 2026-09-27
reason: "Superseded plan; presence moved onto the memory connection, retiring the Cloudflare relay and endpoint configuration this plan describes."
superseded-by: docs/features/collaborative-fields.md
---

# `cf-code-editor` Co-presence — Implementation Plan

Status: Superseded in transport by
[Presence over the memory socket](memory-presence.md), which retires the
Cloudflare service and endpoint configuration this plan describes. The
client-side design in "Keeping cursor and content visually aligned" and the
CodeMirror extension stand and are not restated there.

This plan adds live participant names, carets, and selections to collaborative
`cf-code-editor` instances. It builds on
[Memory `apply-op`](../../plans/memory-apply-op.md), which remains the sole authority for
document contents and operation ordering. Co-presence is a separate, lossy
WebSocket plane whose server remembers only the latest value for each connected
participant.

The first deployment is one Cloudflare Worker with one hibernating Durable
Object per room. It has no authentication, durable storage, replay, or document
data. A participant name opts a collaborative Cell-backed editor into the
feature when a service endpoint is configured. The room defaults to an opaque
hash of the resolved Memory field, with an explicit component override for
specialized rendezvous. The service endpoint is deployment configuration with
an explicit component override for local development and integration tests.
Hosts supply that configuration through the exported `presenceUrlContext`;
Labs Shell maps the optional build-time `PRESENCE_URL` into that context. The
Worker and Durable Object live in the independent private
[`commonfabric/cloudflare-copresence`](https://github.com/commonfabric/cloudflare-copresence)
repository so their deployment and operational access do not become part of a
Labs or Memory deployment.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a work package complete only after its focused tests and completion gate
pass. Keep this plan current as work lands. Archive it under
`docs/history/plans/` when the final package is complete.

## Outcome

Two people editing the same collaborative field see each other's current name,
focus state, caret, and selection. A participant disappears promptly when their
socket closes. Reconnecting obtains a snapshot of the participants who are
currently connected, but no earlier state.

Presence and contents remain independently available:

- A presence failure never makes the editor read-only, blocks a Memory edit, or
  changes the document.
- A Memory collaboration failure closes and clears presence because selection
  coordinates no longer have a trustworthy document epoch.
- A delayed or dropped presence message may make a remote cursor briefly stale,
  but can never change or delay canonical content.

## Fixed boundaries

- Memory's CodeMirror operation session is the only document synchronization
  authority. The Cloudflare service never receives document text or document
  changes.
- Presence is not added to `apply-op`, its codec payload, its shared effects,
  its history, a sibling Cell, or any other durable Fabric state.
- The presence socket carries snapshots of current state, not an event log.
  Revisions order replacement values for one participant; they do not create
  replayable history.
- Presence activates only when `collaborative` is active on a
  `CellHandle<string>`. Ordinary string and last-writer-wins Cell modes are
  unchanged.
- Canonical Memory updates are never buffered while waiting for a presence
  message. The lossy plane cannot become a commit barrier.
- Every selection is qualified by Memory's `{ epoch, version }` operation
  cursor. A selection without a matching epoch is unusable.
- The implementation uses CodeMirror's existing selection, change mapping,
  state-field, effect, and decoration APIs. It does not introduce its own text
  offset transform.

## Architecture

There are two independent paths from each editor:

1. Local document changes go through `@codemirror/collab`, the runtime client,
   and Memory `apply-op`. Memory integrates them, advances the operation cursor,
   and returns canonical changes.
2. Local focus and selection changes go directly over a WebSocket to the
   Cloudflare room. The room replaces that connection's latest record and
   broadcasts it to the other connected sockets.

The paths meet only inside CodeMirror. Remote presence is held in a StateField,
so its ranges map through the same CodeMirror transactions that install Memory
changes. Presence code may observe the collaboration controller's confirmed
cursor and pending local changes, but it may not submit, confirm, reorder, or
retain document operations.

One Worker route accepts a WebSocket upgrade for a room and forwards it to the
Durable Object selected from the opaque room identifier. The Durable Object
uses Cloudflare's WebSocket Hibernation API. Each socket's latest validated
presence record is stored in its serialized attachment; after hibernation the
object reconstructs the current room from attached live sockets. It never
writes Durable Object storage, KV, D1, R2, or Memory.

Relevant upstream APIs:

- [CodeMirror reference](https://codemirror.net/docs/ref/) for
  `EditorSelection.map`, `ChangeDesc.composeDesc`, `ChangeDesc.invertedDesc`,
  StateFields, StateEffects, and decorations.
- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  for room coordination and the recommended hibernation API.
- [Cloudflare's hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
  for `acceptWebSocket`, `getWebSockets`, serialized attachments, and lifecycle
  handlers.

## Component contract

Add these optional properties to `cf-code-editor`:

| Property | Meaning |
| --- | --- |
| `presenceRoom` | Optional opaque room override. Without one, the editor hashes its resolved, pinned Memory field identity. |
| `participantName` | Plain-text display name. Its absence disables presence. |
| `presenceUrl` | Optional WebSocket service override. A host-provided `presenceUrlContext` is the default; tests and local development may set the override directly. |

Setting `participantName` while `collaborative` is active makes the editor
eligible for presence when either the context or override supplies an endpoint.
A browser tab owns at most one editor room session. Before the first eligible
editor focus it owns none; ordinary blur retains the current room and selection;
focusing another editor closes the previous socket before joining the new room.
Unmounting the owning editor closes its socket without promoting another
editor. The default room hashes a domain-separated, versioned tuple containing
the resolved space DID, branch, full schemed document id, resolved scope key,
and complete operation field path. This keeps aliases and direct handles to the
same field together while separating different user and session instances. The
hash is not authentication. Changing the room, endpoint, bound Cell, or
collaborative mode on the owning editor closes the old socket, removes all
remote decorations, and starts a new session only after the new Memory
operation session is ready. Changing the participant name in the same room
publishes a replacement record without reconnecting.

The room creates and owns an unpredictable participant id for each socket
session and ignores any client attempt to update another participant. Names
render as text, never HTML. Color is derived locally from the participant id so
it is stable within the connection without becoming server state.

Presence errors emit `cf-presence-error` and clear remote decorations. They do
not reuse `cf-collaboration-reconcile`, change `collaborative`, or stop document
editing. The event exposes a safe error category and not the room id, name, or
raw server payload. Connection and protocol failures retry only after a browser
`online` event or the page becoming visible; no timer or retry loop runs.
Invalid configuration is reported once and remains disabled until its room,
name, or effective endpoint changes.

## Versioned presence protocol

Version the protocol from its first message. Use strict JSON decoding and reject
unknown message kinds, unexpected fields, invalid UTF-16 positions, non-integer
cursors or revisions, and values outside the configured bounds.

A participant's latest record contains:

| Field | Meaning |
| --- | --- |
| `participantId` | Server-owned id for this WebSocket connection. |
| `revision` | Strictly increasing replacement revision within the connection. |
| `name` | Bounded plain-text display name. |
| `focused` | Whether this editor currently owns focus. |
| `cursor` | Confirmed Memory `{ epoch, version }` used as the selection's coordinate space. |
| `selection` | CodeMirror selection JSON with `{ anchor, head, assoc }` per range, or null until the participant establishes one. |
| `basis` | `provisional` when mapped back over pending edits, otherwise `confirmed`. |

The wire messages are deliberately small:

| Direction | Message | Behavior |
| --- | --- | --- |
| Server to client | `room.snapshot` | Replaces the client's initial view with the latest record for every other live socket. |
| Client to server | `participant.upsert` | Replaces this socket's attachment and broadcasts the validated record. |
| Server to client | `participant.upsert` | Replaces the identified participant when its revision is newer. |
| Server to client | `participant.remove` | Removes a participant after close or error. |

The server assigns `participantId` during the upgrade and supplies it with the
snapshot. It uses socket identity, not a claimed id, to apply an upsert. A new
connection starts a new revision sequence; there is no resume token in the
first version.

Set explicit bounds for the room id, participant name, selection range count,
message bytes, sockets per room, and accepted update frequency. Close only the
offending socket with a stable protocol error. Enforce an origin allowlist in
deployed environments, while documenting that origin checking and an
unpredictable room id are abuse mitigations, not authentication.

## Keeping cursor and content visually aligned

The two networks can deliver in either order. Publishing only after Memory
confirmation would commonly let text run ahead of its cursor. Publishing only
the local post-edit offsets could let the cursor arrive first in coordinates
that peers cannot yet interpret. Use a two-phase replacement record instead.

### Sender

Immediately after a local edit:

1. Read the collaboration controller's last confirmed Memory cursor.
2. Compose all pending CodeMirror changes from that confirmed document to the
   local document with `ChangeDesc.composeDesc`.
3. Map the current `EditorSelection` backward through
   `ChangeDesc.invertedDesc` and publish it at the confirmed cursor with
   `basis: provisional`.
4. Submit the unchanged pending edits through the existing Memory path.

When Memory confirms or rebases an edit, publish the exact current selection at
the new confirmed cursor with a higher participant revision and
`basis: confirmed`. Republish on every confirmed cursor advance even when the
selection did not otherwise move. This corrects positions that could only be
approximated before the inserted text existed, such as a selection wholly
inside a new insertion.

Focus, blur, name, and selection-only changes also publish replacement records.
Blur retains the last established selection so collaborators keep its caret and
range highlight while `focused` continues to report the editor's actual state.
Coalesce bursts at the browser animation-frame boundary; do not use a sleep,
poll, debounce timer, or retry loop as a synchronization primitive.

### Receiver

Keep two values per participant:

- `latest` is the newest valid record received, even when its Memory version is
  still in the future.
- `displayed` is the most recent selection that could be installed in the local
  document and is currently being mapped through CodeMirror transactions.

Apply a record as follows:

- A different epoch clears both values for that participant. Presence from an
  old epoch must not cross a Memory reset.
- A record at the current confirmed version replaces `displayed`.
- A current or newly reached record maps forward through the receiver's pending
  local CodeMirror changes before it becomes `displayed`.
- A future record replaces `latest` but leaves `displayed` visible. When Memory
  reaches that version, install it after the same transaction that installs the
  content.
- A previously installed selection maps through every intervening CodeMirror
  transaction in its StateField.
- A past record first seen after the receiver has advanced cannot be recovered
  without retained mapping history. Discard it rather than guessing; the
  sender's confirmation republish supplies a usable replacement.
- If Memory advances beyond a queued future record, discard that record. Never
  roll a displayed selection backward.

This makes the provisional record useful whichever route is faster. If
presence arrives first, the peer sees a caret at the old insertion boundary and
the Memory transaction maps it forward with the text. If Memory arrives first,
the late provisional record is ignored and the following confirmed record is
shown. At no point does presence hold back the Memory transaction.

## Lifecycle and failure behavior

- Open presence only after CodeMirror collaboration has installed its initial
  Memory snapshot and operation cursor, and only for the editor room most
  recently focused in the browser tab.
- Clear presence on editor disposal, Cell rebinding, collaborative-mode change,
  explicit release, reconciliation failure, operation-session failure, and
  Memory epoch change.
- Send an unfocused replacement with the last established selection on ordinary
  blur. Socket close remains the authoritative removal if the page disappears
  before the message is sent.
- On a transient socket close, remove remote state and reconnect using the
  browser's next explicit online/visibility lifecycle signal. The first slice
  does not add a retry timer or reconnect on each editor interaction.
- Treat malformed server data as a presence failure local to that socket.
  Document collaboration continues.
- On service deployment or Durable Object hibernation, connected sockets remain
  usable and the object reconstructs its room from attachments. An actual
  disconnect loses that participant immediately and permanently.

## Work packages

### WP0 — Contract fixtures and pure coordinate mapping

Purpose: fix the cross-plane contract before opening a network connection.

- [x] Define versioned protocol types, strict validators, configured bounds,
      and JSON fixtures for snapshot, replacement, removal, and invalid data.
- [x] Add pure helpers that compose pending CodeMirror changes and map a local
      selection backward to a confirmed Memory cursor.
- [x] Define receiver transitions for `latest` and `displayed` without DOM or
      WebSocket dependencies.
- [x] Add fixtures for insertion, deletion, multi-range selection, concurrent
      remote change, late provisional state, future confirmed state, skipped
      version, and epoch replacement.

Required tests:

- [x] A provisional selection round-trips through the pending change mapping
      and the later canonical transaction.
- [x] Future presence does not hide the last displayable selection.
- [x] Late past presence and mismatched epochs are discarded without changing
      the document.
- [x] Invalid ranges, oversized values, duplicate/older revisions, and unknown
      protocol versions fail at the decoder.

Completion gate:

- [x] All ordering cases are deterministic pure tests, and no helper contains a
      hand-written text offset transform.

### WP1 — Ephemeral Cloudflare room service

Purpose: provide the smallest deployable latest-value relay.

- [x] Add the Worker entry point, Durable Object, protocol module, tests, and
      Wrangler configuration to the independent
      `commonfabric/cloudflare-copresence` repository.
- [x] Route one versioned WebSocket endpoint to a Durable Object named from the
      opaque room id.
- [x] Assign participant ids server-side, validate every client replacement,
      serialize the latest state into the socket attachment, and broadcast only
      newer revisions.
- [x] Reconstruct snapshots from `getWebSockets()` and their attachments after
      hibernation. Do not instantiate or write a storage API.
- [x] Broadcast removal from the WebSocket close and error lifecycle handlers.
- [x] Enforce connection, message, range, name, origin, and update-rate bounds.
      Logs and metrics exclude names, selections, raw room ids, and document
      identifiers.
- [x] Add local development, deploy, rollback, and endpoint-configuration
      instructions. Keep service deployment independent from Memory deployment.

Required tests:

- [x] Join receives an exact current snapshot; upsert replaces one participant;
      disconnect removes it.
- [x] Two sockets cannot claim or update each other's participant id.
- [x] A hibernation reconstruction test proves live attachments restore the
      room and a disconnected participant leaves no recoverable state.
- [x] Invalid origin, room, message, and capacity cases close only the offending
      connection.

Completion gate:

- [ ] A deployed test room relays latest values across two independent clients,
      hibernates without disconnecting them, and exposes no durable room rows or
      document payloads.

### WP2 — CodeMirror remote-presence extension

Purpose: render remote state through CodeMirror's own transaction model.

- [x] Add `codemirror-presence.ts` beside the existing collaboration adapter.
      Keep network/session ownership out of
      `codemirror-collaboration.ts`.
- [x] Store remote participants in a StateField updated by typed StateEffects.
      Map `displayed` selections through every transaction's changes.
- [x] Render selection ranges with `Decoration.mark`, carets with a widget
      decoration, and bounded plain-text names adjacent to carets.
- [x] Derive accessible, theme-compatible colors from participant ids. Do not
      inject per-participant style elements or untrusted CSS.
- [ ] Avoid obscuring local selections, diagnostics, backlinks, mention
      decorations, and keyboard focus indicators.

Required tests:

- [x] StateField tests cover transaction mapping, replacement, removal,
      multiple ranges, future queueing, and epoch clear.
- [ ] DOM tests cover escaped names, collapsed carets, selections, theme
      changes, and cleanup.

Completion gate:

- [x] Remote decorations survive the same CodeMirror changes that move their
      document positions and disappear without rebuilding the editor.

### WP3 — Collaboration-to-presence seam and two-phase publication

Purpose: coordinate spaces without coupling their transports.

- [x] Give `CodeMirrorCollaborationController` a read-only observer seam for
      readiness, the confirmed `{ epoch, version }`, pending CodeMirror changes,
      and canonical transaction/cursor advancement.
- [x] Keep the existing operation submission payload byte-for-byte unchanged;
      presence never enters `codeMirrorSubmission()` or shared effects.
- [x] Publish provisional base-coordinate selections immediately after local
      changes and confirmed selections after Memory advancement.
- [x] Resolve future presence immediately after the CodeMirror transaction that
      reaches its cursor, while leaving `displayed` state mapped through that
      transaction.
- [x] Clear the presence extension before installing a new Memory epoch or
      reconciliation document.

Required tests:

- [x] Presence faster than Memory maps the provisional caret with the arriving
      edit and is corrected by confirmation.
- [x] Memory faster than presence ignores the late provisional record and
      installs the confirmed record without cursor disappearance.
- [x] Several pending local updates compose back to one confirmed cursor.
- [x] A concurrent rebase maps local and remote selections through the same
      canonical transaction.

Completion gate:

- [x] Both delivery orders produce the same final document and selection, and
      no test can make presence delay or alter an `apply-op` transaction.

### WP4 — `cf-code-editor` API and lifecycle

Purpose: expose opt-in co-presence without changing existing editor modes.

- [x] Add the properties and `cf-presence-error` event to the component API and
      component documentation.
- [x] Add a small presence session controller that owns the WebSocket,
      connection participant id, revision counter, and CodeMirror effects.
- [x] Open only after collaboration readiness and editor focus; keep one active
      room per browser tab; publish focus/name/selection; and close on every
      lifecycle boundary listed above.
- [ ] Provide a deployed production endpoint through the exported host context;
      retain the explicit override for tests and local development. Labs Shell
      remains unconfigured until deployment.
- [x] Keep presence disabled when configuration is incomplete. Report invalid
      explicit configuration without affecting document collaboration.

Required tests:

- [ ] Component tests cover opt-in, incomplete properties, name change, blur,
      page-level room transfer, Cell rebind, toggle, disposal, release, socket
      failure, collaboration failure, and epoch reset.
- [x] Existing ordinary and collaborative editor tests remain unchanged and
      green with presence absent.

Completion gate:

- [ ] Presence is an additive component capability and every teardown path
      closes the socket and removes its decorations exactly once.

### WP5 — End-to-end ordering and deployment readiness

Purpose: prove the user-visible behavior on both transports before enabling the
service by default anywhere.

- [ ] Extend the two-browser integration fixture from the Memory `apply-op` work
      with a local Worker/Durable Object service and explicit event-driven
      synchronization hooks.
- [ ] Exercise concurrent typing, caret-only movement, range selection, blur,
      abrupt disconnect, reconnect snapshot, rebase, and Memory epoch reset.
- [ ] Add transport controls that independently hold and release Memory and
      presence delivery, proving both orderings without timing sleeps.
- [ ] Record service metrics for active rooms, sockets, accepted/rejected
      messages, and handler failures without recording payloads.
- [ ] Deploy to a non-production endpoint, measure both paths from two regions,
      and verify the ordering tests under induced asymmetry. Latency is an
      observation, not a pass/fail duration threshold.
- [ ] Publish the production endpoint only after origin configuration,
      connection limits, dashboards, and rollback have been exercised.

Completion gate:

- [ ] Two browsers converge through Memory and show current remote selections
      through either transport ordering; stopping the presence service degrades
      only co-presence.

## Validation matrix

| Work packages | Required validation |
| --- | --- |
| WP0 | Protocol and pure CodeMirror mapping tests; `deno task check-docs` |
| WP1 | Complete `cloudflare-copresence` tests; Wrangler local integration and configuration validation |
| WP2–WP4 | Complete UI Deno and browser tests plus existing CodeMirror collaboration tests |
| WP5 | Focused two-browser integration in both delivery orders and deployed non-production smoke test |

Every review-ready implementation PR also runs `deno fmt --check`, `deno lint`,
relevant type checks, `deno task check-docs`,
`deno task check-conflict-markers`, `deno task check-no-waitfor`, and dependency
gates affected by its imports.

## Review checkpoints

Request explicit review at these boundaries:

1. After WP0, before treating the protocol or coordinate mapping as stable.
2. After WP1, before connecting a product editor to the deployed service.
3. After WP3, with special attention to the two delivery orders and the rule
   that presence never blocks Memory.
4. After WP5, before supplying a production endpoint to any host.

The service and Labs implementation are separate pull requests in their
respective repositories. Within Labs, keep pure mapping/rendering, component
lifecycle, and browser integration independently reviewable when the stack
size permits it.
