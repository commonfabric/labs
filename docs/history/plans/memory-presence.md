---
status: historical
created: 2026-09-27
archived: 2026-09-27
reason: "Executed plan; presence rooms relayed over the memory connection shipped, and the Cloudflare relay and its endpoint configuration were retired."
superseded-by: docs/features/collaborative-fields.md
---

# Presence over the memory socket — Implementation Plan

Status: Complete

This plan moves ephemeral co-presence — live participant names, carets, and
selections, and whatever per-participant state comes after them — off the
separate Cloudflare relay and onto the WebSocket every client already holds to
the memory server. The memory server becomes the presence relay. Presence
messages share the socket, the `hello` negotiation, and the session
authorization of the memory protocol, and nothing else: they are not commits,
carry no `seq`, are never acknowledged, and are handled outside the ordered
frame queue that memory commands wait in.

[`cf-code-editor` co-presence](cf-code-editor-copresence.md)
is the plan this one supersedes. Its client-side design — the two-phase provisional/confirmed
selection, the CodeMirror StateField that maps remote selections through local
transactions, the `latest`/`displayed` receiver — stands unchanged and is not
restated here. What changes is the transport, the record shape, and who is
allowed into a room.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a work package complete only after its focused tests and completion gate
pass. Keep this plan current as work lands. Archive it under
`docs/history/plans/` when the final package is complete.

## Outcome

Two people editing the same collaborative field see each other's name, caret,
and selection, with no service configured beyond the memory server they are
already connected to. A participant disappears when their socket closes or
their session loses the space. Reconnecting rejoins every room the client was
in and delivers a fresh snapshot, through the reconnect the memory client
already performs.

A second kind of per-participant state — a mouse pointer is the first
candidate — is added by registering one more _facet_ on the client and one
more renderer, with no change to the memory protocol, the server, or the
worker plumbing.

## Fixed boundaries

- Memory's operation session remains the only document authority. Presence
  never enters `apply-op`, a commit, a sync frame, or durable storage of any
  kind. The server holds room state in memory only, and forgets a participant
  the moment their membership ends.
- A presence message cannot delay a memory command, and a memory command
  cannot delay a presence message. On the server, a presence frame is handled
  on arrival rather than queued behind the connection's ordered frames; on the
  client, a presence push is dispatched on receipt and never parked behind a
  catch-up marker.
- A room is addressed under a space, and joining it requires an open memory
  session for that space on the same connection. Space access, decided by the
  memory ACL, is what admits a participant. There is no separate presence
  authentication, origin allowlist, or endpoint configuration.
- The server validates the record envelope and enforces bounds; it does not
  interpret facet contents. Every consumer decodes strictly the facets it
  knows and ignores the ones it does not.
- Presence activates for `cf-code-editor` only while `collaborative` is active
  on a `CellHandle<string>`, exactly as before.

## Architecture

```text
cf-code-editor ──▶ PresenceRoomHandle ──postMessage──▶ RuntimeProcessor
   (caret facet)     (runtime-client,                   (worker; resolves
                      main thread;                       the room's space)
                      coalesces facets                        │
                      per animation frame)                    ▼
                                                     runner storage Provider
                                                      (IPresenceCapability)
                                                              │
                                                              ▼
                                                     memory SpaceSession
                                                      (presence.* frames)
                                                              │
                                                    ═══ WebSocket ═══
                                                              │
                                                              ▼
                                            memory Server ── Connection
                                              rooms keyed (space, room)
```

One membership per `(connection, space, room)`. A page holding several
consumers of one room — an editor publishing a caret, an overlay publishing a
pointer — shares one membership and one record; the handle merges their facets
into it. The server assigns the participant id at join and identifies every
later publication by the membership it arrives on, never by a claimed id.

## Protocol

The server advertises `presenceV1` in `hello.ok`. It is build-inherent: a
server of this version always advertises it, and it defaults to `false` when
absent, so a client connected to an older server does not send presence
messages and reports presence as unavailable rather than failing. It is
recorded in `docs/development/EXPERIMENTAL_OPTIONS.md` beside the other
build-inherent handshake capabilities.

### Record

```typescript
// Shown at module scope.

/** Latest published state of one room participant. */
interface PresenceRecord {
  /** Server-assigned id for this membership; unpredictable and never reused. */
  participantId: string;

  /**
   * DID the publishing session was opened as, stamped by the server from the
   * session registry. Absent when the session has no bound principal.
   */
  principal?: string;

  /** Strictly increasing within one membership. */
  revision: number;

  /** Plain-text display name, bounded; never rendered as HTML. */
  name: string;

  /**
   * Per-kind state, keyed by facet name. The server bounds the map and
   * treats each value as an opaque plain object.
   */
  facets: Record<string, Record<string, unknown>>;
}
```

The first facet is `caret`, whose value is what the Cloudflare record carried
as top-level fields:

```typescript
// Shown at module scope.

/** Editor focus and selection in confirmed memory coordinates. */
interface CaretFacet {
  focused: boolean;
  cursor: { epoch: number; version: number };
  selection: {
    ranges: { anchor: number; head: number; assoc: -1 | 0 | 1 }[];
    main: number;
  } | null;
  basis: "confirmed" | "provisional";
}
```

Its decoder lives with its renderer in `packages/ui`, alongside the CodeMirror
presence extension. A `pointer` facet later is a second decoder and renderer
in the same package.

Bounds, enforced by the server and applied by the client before sending:

| Bound | Value |
| --- | --- |
| Room id | `^[A-Za-z0-9_-]{22,128}$` |
| Display name | 1–80 code points, ≤ 256 UTF-8 bytes, no control or surrogate code points |
| Facet name | `^[a-z][a-z0-9-]{0,31}$` |
| Facets per record | ≤ 8 |
| Published record | ≤ 8 KiB as encoded |
| Members per room | ≤ 128 |

A message outside the bounds fails only that request; the connection and its
memory sessions are unaffected. A `revision` that does not exceed the
membership's last accepted one is refused the same way.

### Messages

Client to server. Each is a request envelope and receives a `response`,
consistent with every other memory command; the client treats a `presence.publish`
response as diagnostic only and never waits for it before publishing again.

```typescript
// Shown at module scope.

type SpaceId = string;
type SessionId = string;

interface PresenceJoinRequest {
  type: "presence.join";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  room: string;
}

/** `ok` of the join response. */
interface PresenceJoinResult {
  participantId: string;
  participants: PresenceRecord[];
}

interface PresencePublishRequest {
  type: "presence.publish";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  room: string;
  revision: number;
  name: string;
  facets: Record<string, Record<string, unknown>>;
}

interface PresenceLeaveRequest {
  type: "presence.leave";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  room: string;
}

interface PresenceRecord {
  participantId: string;
  principal?: string;
  revision: number;
  name: string;
  facets: Record<string, Record<string, unknown>>;
}
```

A join on a membership that already exists returns the same participant id and
a current snapshot; it does not create a second membership. A publish before a
join is refused. The membership's own record is not in its snapshot.

Server to client. These are pushes with no request id, addressed to the
session the receiving membership joined through, so the client routes them the
way it routes `session/effect`.

```typescript
// Shown at module scope.

type SpaceId = string;
type SessionId = string;

interface PresenceUpsert {
  type: "presence/upsert";
  space: SpaceId;
  sessionId: SessionId;
  room: string;
  participant: PresenceRecord;
}

interface PresenceRemove {
  type: "presence/remove";
  space: SpaceId;
  sessionId: SessionId;
  room: string;
  participantId: string;
}

interface PresenceRecord {
  participantId: string;
  principal?: string;
  revision: number;
  name: string;
  facets: Record<string, Record<string, unknown>>;
}
```

A membership ends, and the room's other members receive `presence/remove`, on
an explicit leave, on the connection closing, and on the joining session being
revoked or detached from the connection — including a takeover by another
connection resuming the same session. The record positions in these envelopes
— the message, `facets`, each facet value, and each entry of `participants` —
join the list in the protocol chapter's "Record positions in an envelope".

### Ordering

`Connection.receive()` parses the frame once. A `presence.*` message is handled
at that point and returns; every other message enters the ordered queue as it
does today. A presence publish therefore reaches the room while a large
`transact` ahead of it is still being decided. Within one membership, the
revision is what orders publications: the server broadcasts only a record
whose revision exceeds the last it accepted for that membership, and a client
applies only a record whose revision exceeds the last it holds for that
participant.

Outbound, presence pushes take the same send path as every other server
message. The compression channel preserves order, and a push is a small text
frame, so nothing about that path needs to change.

## Client library

### Memory client

`SpaceSession` gains:

```typescript
// Shown at module scope.

interface PresenceMembership {
  readonly participantId: string;
  publish(
    record: { name: string; facets: Record<string, Record<string, unknown>> },
  ): void;
  leave(): Promise<void>;
}

type PresenceEvent =
  | { kind: "snapshot"; participantId: string; participants: PresenceRecord[] }
  | { kind: "upsert"; participant: PresenceRecord }
  | { kind: "remove"; participantId: string }
  | { kind: "failure"; error: Error };

interface PresenceRecord {
  participantId: string;
  principal?: string;
  revision: number;
  name: string;
  facets: Record<string, Record<string, unknown>>;
}

declare function joinPresenceRoom(
  room: string,
  observer: (event: PresenceEvent) => void,
): Promise<PresenceMembership>;
```

`publish()` assigns the revision and sends; it does not wait. A publish the
server refuses reaches the observer as a `failure` event, since nothing else
holds the response. A session restore re-sends `presence.join` for every live membership, delivers the new
snapshot to the observer as a `snapshot` event, and republishes the last local
record at a higher revision. A session that terminates ends its memberships
and delivers nothing further.

### Runner and worker

The runner's storage `Provider` and `Replica` expose
`IPresenceStorageCapability` with one method, `joinPresenceRoom()`, forwarded
to the active space session through the same replacement-following path the
operation capability uses. The runtime-client worker resolves the space from
the cell a request names, exactly as an operation session does, and derives
the room from the resolved field identity — space, branch, document id, scope
key, path — when the request carries no explicit room. It holds one membership
per `(client, space, room)` and forwards events to that client as
`presence:update` notifications.

Worker protocol additions: `presence:join`, `presence:publish`,
`presence:leave` requests and the `presence:update` notification, keyed by a
client-chosen `subscriptionId` like operation subscriptions.

### Main thread

`RuntimeClient.joinPresenceRoom(cell, options?)` returns a
`PresenceRoomHandle`:

- `.participantId`, `.room`, `.participants` — the current view.
- `setName(name)`, `setFacet(name, value)`, `clearFacet(name)` — update the
  local record. Updates coalesce at the browser animation-frame boundary and
  publish the merged record; no timer, debounce, or retry is involved.
- `subscribe(listener)` — receives every snapshot, upsert, and removal after
  it is applied to `.participants`.
- `leave()` — ends the membership exactly once.

The handle is what a pointer overlay, a participant list, or any other
consumer uses. `cf-code-editor` is its first consumer and publishes only the
`caret` facet.

## `cf-code-editor`

- `participantName` and `presenceRoom` keep their meaning. `presenceUrl` and
  the host `presenceUrlContext` are removed: there is no endpoint to
  configure.
- The editor joins through its `RuntimeClient` after collaboration readiness
  and editor focus, and publishes the `caret` facet on the schedule the
  superseded plan describes. Focus, blur, name, and selection changes call
  `setFacet` and `setName`; the handle coalesces them.
- `cf-presence-error` keeps its shape and categories. `connection` failures
  are now the memory connection's failures and recover with it; the editor no
  longer installs `online` or `visibilitychange` listeners.
- The one-room-per-tab rule (`activePresenceEditor`) was written to bound
  socket count and would bound only membership count here, so the same change
  removes it: every collaborative editor on a page joins its own room, and the
  caret facet's `focused` says which editor owns focus.
- The `copresence-client.ts` socket transport, its room-URL builder, and the
  Cloudflare protocol decoders are deleted. The caret facet decoder, the room
  derivation hash, and the bounds constants survive in a facet module beside
  the CodeMirror presence extension.

## Shell, deployment, and configuration

`PRESENCE_URL`, `$PRESENCE_URL`, `optionalPresenceUrl()`, the `RootView`
context provider, the `SHELL_PRESENCE_URL` and `STAGING_SHELL_PRESENCE_URL`
repository variables and the workflow steps that validate and bake them are
removed. `docs/development/CONFIGURATION.md` and
`docs/development/deploying.md` lose their rows and paragraphs, and
`docs/features/collaborative-fields.md`'s "Ephemeral co-presence" section is
rewritten for the memory-socket transport. The standalone memory host gains
presence with no change of its own, since it runs the same `Server`.

## Work packages

### WP1 — Memory protocol, server rooms, and client memberships

Purpose: the relay and its client, complete and tested, with no consumer.

- [x] Add the `presence.*` request types, the `presence/*` push types, the
      record type, and the bounds to `packages/memory/v2.ts`; extend
      `parseClientMessage()` with the three requests, asking the plain-object
      question at every record position.
- [x] Advertise `presenceV1` as a build-inherent server capability; parse and
      carry it like `entityIdLookup`.
- [x] Add a room registry to `Server` keyed by `(space, room)`, holding
      memberships keyed by connection; assign participant ids; stamp the
      session principal; broadcast upserts and removals to the other members
      through their own connections and sessions.
- [x] Route `presence.*` in `Connection.receive()` ahead of the ordered queue;
      require an open session for the space; end memberships from
      `Connection.close()` and `revokeSession()`.
- [x] Add `SpaceSession.joinPresenceRoom()` and `PresenceMembership`; route
      `presence/*` pushes in `Client.#onMessage()`; rejoin and republish on
      restore; end memberships on session termination.
- [x] Document the messages, bounds, and ordering in a new section of
      `docs/specs/memory-v2/04-protocol.md`, extend its record-position list,
      and add the capability to `docs/development/EXPERIMENTAL_OPTIONS.md`.

Required tests (`packages/memory/test/v2-presence-*.test.ts`, through the
loopback transport):

- [x] Join returns an exact snapshot excluding self; a publish reaches every
      other member and not the publisher; leave and connection close remove.
- [x] A membership cannot publish under another's participant id; a publish
      before join, a stale revision, and each bound violation fail only that
      request.
- [x] A session revoked by takeover ends its memberships, and the new owner
      joins fresh.
- [x] A publish sent behind a `transact` whose engine open is paused by an
      `EngineOpener` is delivered before the transact is decided.
- [x] A client restore rejoins and delivers a `snapshot` event; a server
      without `presenceV1` makes `joinPresenceRoom()` fail with a typed error.
- [x] A record stamped with a principal carries the session's DID and nothing
      a client claimed.

Completion gate:

- [x] `packages/memory` tests, `deno task check`, `deno task check-docs`, and
      `deno task check-test-shuffle` pass; no presence test waits on a timer.

### WP2 — Runner capability and runtime-client plumbing

Purpose: carry a room from a page to the memory session through the worker.

- [x] Add `IPresenceStorageCapability` and its predicate to
      `packages/runner/src/storage/interface.ts`; implement it on `Provider`
      and `Replica` in `storage/v2.ts` through the replacement-following path.
- [x] Add the worker request and notification types to
      `packages/runtime-client/src/protocol/`, handlers to
      `RuntimeProcessor` that resolve the space and derive the room, share one
      membership per `(client, space, room)`, and tear down on client detach.
- [x] Add `RuntimeClient.joinPresenceRoom()` and `PresenceRoomHandle` with
      facet merging, animation-frame coalescing, revision-ordered application
      of remote records, and a single `leave()`.
- [x] Describe the handle in `packages/runtime-client/README.md`.

Required tests:

- [x] The provider forwards a join to the active session and follows a
      replica replacement.
- [x] The worker derives the same room for two clients naming the same field
      and a different room for a different scope instance; a second join
      shares the membership; detaching one client leaves the other joined.
- [x] The handle merges facets from two setters into one publication per
      frame, applies only newer revisions, and leaves exactly once.

Completion gate:

- [x] `packages/runner` and `packages/runtime-client` tests and
      `deno task check` pass.

### WP3 — `cf-code-editor` on the handle, and the Cloudflare path retired

Purpose: the product consumer, and the removal of the transport it replaces.

- [x] Move the caret facet decoder, the room derivation hash, and the bounds
      into `packages/ui/src/v2/components/cf-code-editor/presence-facets.ts`;
      delete `copresence-client.ts` and its socket-fake tests.
- [x] Replace `CopresenceSession` in `cf-code-editor.ts` with the handle;
      remove `presenceUrl`, `presenceUrlContext`, and the `online` and
      `visibilitychange` reconnect listeners; keep `cf-presence-error`.
- [x] Remove `PRESENCE_URL` from `packages/shell` (`env.ts`, `felt.config.ts`,
      `presence-url.ts`, `RootView.ts`, their tests) and the two workflow
      steps in `.github/workflows/deno.yml`.
- [x] Update `docs/features/collaborative-fields.md`,
      `docs/development/CONFIGURATION.md`, `docs/development/deploying.md`,
      and the component's own documentation.

Required tests:

- [x] Editor tests cover opt-in, missing name, name change, blur, room
      transfer between editors, Cell rebind, collaborative toggle, disposal,
      memory session failure, and epoch reset, driven through a fake
      `RuntimeClient` rather than a fake socket.
- [x] Existing ordinary and collaborative editor tests remain green with
      presence absent.

Completion gate:

- [x] Every teardown path leaves the membership once; `packages/ui` and
      `packages/shell` tests, `deno task check`, `deno task check-docs`, and
      `deno task check-skill-facts` pass.

### WP4 — Two-browser verification and archive

Purpose: prove it end to end and close the superseded plan.

- [x] Extend `packages/patterns/integration/cf-code-editor-collaboration.test.ts`
      with two browsers seeing each other's caret through the local toolshed,
      an abrupt disconnect removing a participant, and a reconnect restoring
      one, synchronized on the handle's events rather than on time.
- [x] Archive `docs/plans/cf-code-editor-copresence.md` to
      `docs/history/plans/` with a `superseded-by` key naming this plan, and
      then this plan on its own completion.

Completion gate:

- [x] `deno task integration patterns cf-code-editor` passes; stopping nothing
      but the memory server degrades editing and presence together, and
      restarting it restores both.

## Open items

- A server-side rate limit on publications. Client coalescing bounds the
  honest rate; a hostile client is bounded today only by record size and the
  per-connection socket. A counter that drops (never queues) publications
  above a per-second budget is the shape to add if it proves necessary, and
  is not a timer in the sense the repository avoids.
- Whether a `pointer` facet should carry its own `cursor` for coordinate
  mapping or be expressed in viewport-independent document coordinates; the
  decision belongs to the change that adds it.

## Validation matrix

| Work packages | Required validation |
| --- | --- |
| WP1 | `packages/memory` tests; `deno task check`; `deno task check-docs`; `deno task check-test-shuffle` |
| WP2 | `packages/runner` and `packages/runtime-client` tests; `deno task check` |
| WP3 | `packages/ui` and `packages/shell` tests; `deno task check`; `deno task check-docs`; `deno task check-skill-facts` |
| WP4 | focused pattern integration run; `deno task check-docs-history-index`; `deno task docs-links --orphan` |

Every review-ready pull request also runs `deno fmt --check`, `deno lint`,
`deno task check`, `deno task check-conflict-markers`,
`deno task check-no-waitfor`, and the dependency gates affected by its imports.
