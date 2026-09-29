# Memory Connection Multiplexing

Status: proposed design. Nothing in this document is implemented yet.

This document describes how a client reaches every space it uses over one
memory connection per toolshed instead of one per space, and how routers that
terminate client connections in front of several toolsheds fit on top of that.
It also covers how a client acts as a second identity for a few requests —
the case that matters is initializing a space's ACL as the space identity —
without opening a separate connection for it.

## 1. Where the protocol stands

The wire protocol in [04-protocol.md](./04-protocol.md) does not tie a
connection to a space:

- every request after `hello` names its `space`, and every request after
  `session.open` names its `sessionId`
- server pushes (`session/effect`, `session/revoked`, `presence/*`) carry
  `space` and `sessionId`
- authorization is per logical session: each `session.open` carries its own
  signed invocation, and the server records the principal on the session, not
  on the connection

The implementations follow that shape:

- The server's `Connection` (`packages/memory/v2/server.ts`) holds a map of
  sessions keyed by `(space, sessionId)`, and the session registry records
  each session's principal and owning connection. Fan-out finds a session's
  connection through the registry.
- The client's `Client` (`packages/memory/v2/client.ts`) holds a set of
  `SpaceSession`s, and `mount()` takes the session-open signer per call, so two
  sessions on one client can be opened by two different identities.

The runner is what opens one socket per space. `RemoteSessionFactory.create`
(`packages/runner/src/storage/v2-remote-session.ts`) builds a new
`WebSocketTransport` and a new `Client` for every space it is asked for, and
the storage manager closes that client to end the session. Toolshed ignores the
`?space=` query parameter the factory adds to the URL. The ACL bootstrap of a
fresh named space in `packages/runner/src/storage/v2.ts` opens three
connections in sequence: one as the active user to inspect the ACL, one as the
space identity to write the genesis ACL, and one as the active user again for
the replica.

So one socket per space costs, per space: a TCP and TLS handshake, a `hello`
exchange, a compression channel, and a toolshed socket. A client with many
spaces holds that many sockets against the same host.

## 2. Goals and non-goals

Goals:

1. One memory connection per client per toolshed in the direct setup (a client
   talking to one toolshed, as in local development).
2. A client can open sessions as more than one identity over that connection,
   and can perform a one-shot signed operation as another identity (space ACL
   genesis) without a session for it.
3. Startup and reconnect latency for N spaces stays close to what N parallel
   sockets give today.
4. A router can sit between clients and toolsheds, with signed session opens
   still verified end to end by the toolshed that owns the space.

Non-goals:

- Changing the commit model, sync payloads, or watch semantics.
- Cross-space atomicity. Sessions for different spaces on one connection stay
  independent.
- Sharding one space across toolsheds. A space is served by one toolshed at a
  time.

## 3. Direct setup: one connection per client per toolshed

### 3.1 What breaks when sessions share a connection

Pooling the `Client` in the runner without other changes runs into five
problems.

1. **Concurrent session opens collide on the challenge.** A connection holds a
   single session-open challenge. The server issues it in `hello.ok`, accepts it
   once, and issues the next one in the `session.open` response. Two mounts in
   flight both sign the current challenge, and the second fails with a
   retriable "challenge already used" `AuthorizationError`. Nothing in the
   client serializes mounts, because nothing has needed to.
2. **Reconnect restores sessions one at a time.** `Client`'s reconnect loop
   awaits `restore()` for each session in turn, and each restore is a
   `session.open` round trip followed, for a session that was not resumed, by a
   watch-set round trip. With a socket per space those run in parallel; on one
   socket they run in series.
3. **Frames for different spaces wait on each other.** The server's
   `Connection.receive` runs every non-presence frame through one serial chain.
   A `transact` in one space that waits for that space's publication lock
   during fan-out delays every frame queued behind it, including frames for
   other spaces.
4. **A session cannot end without the connection ending.** No request closes a
   session. `SpaceSession.close()` sends `presence.leave` for its rooms and then
   forgets the session locally; the server detaches a session only when its
   connection closes. On a shared connection a released session keeps its watch
   set and keeps receiving fan-out until the connection closes or the ACL
   revokes it.
5. **A connection failure resets every space.** A frame the transport refuses
   (the 64 MiB WebSocket frame limit) or a protocol violation closes the
   connection. Today that resets one space; on a shared connection it resets
   all of them. Session resume with declared holdings makes the recovery
   correct; the cost is that every space pays for it at once.

### 3.2 Protocol changes

#### Nonce-based session-open signatures

The server-issued connection challenge is replaced by a nonce the client
chooses. The server advertises the change with a new capability flag,
`sessionOpenNonce`. When both peers advertise it, the signed invocation carries
a `nonce` in place of `challenge`:

```typescript
// Shown at module scope.
type SpaceId = string;
type SessionId = string;
type DID = string;

interface NonceSessionOpenInvocation {
  iss: DID;
  cmd: "session.open";
  sub: SpaceId;
  aud: DID;
  args: {
    protocol: "memory";
    session: {
      sessionId?: SessionId;
      seenSeq?: number;
      sessionToken?: string;
    };
  };
  /** 32 random bytes as 64 hexadecimal characters, chosen by the client. */
  nonce: string;
  iat: number;
  exp: number;
}
```

The server accepts the invocation when:

- the signature verifies against `iss`, and `aud`, `sub`, and the session
  descriptor match as they do today
- `iat` is not later than the server clock plus the clock-skew grace
- `exp` is not earlier than the server clock minus the clock-skew grace
- `exp - iat` is at most the server's session-open window, 300 seconds by
  default, which is the validity clients already stamp on a signed open
- the server has not already accepted an open carrying the same
  `(iss, sub, nonce)`

It then records `(iss, sub, nonce)` until `exp` plus the grace has passed and
refuses a repeat with a retriable `AuthorizationError`. The record's size is
bounded by the number of opens accepted inside one window.

A nonce belongs to one signed open, not to a space or a connection. The client
draws a fresh nonce for every `session.open` it signs — each first mount and
each reopen after a reconnect — so a client with sessions in five spaces signs
five opens with five nonces, and signs new ones when it reconnects. The space
is part of the record's key because the signature already binds the open to
its space: a nonce cannot be moved to another space, and each space's record
lives on the server that owns the space.

Nothing about a signed open depends on the connection it arrives on, so opens
on one connection run concurrently, and a client signs each open without first
waiting for a server round trip. `hello.ok` still carries `sessionOpen.audience`
and no longer needs `sessionOpen.challenge`; a `session.open` response no
longer carries a new challenge.

What the change gives up is the binding of a signature to one connection. A
signed open captured in transit could be presented on another connection before
the original arrives, within its window. Reading an open in transit already
requires breaking TLS or holding the client, and either of those exposes the
session's traffic anyway; the window bounds the exposure in time and the replay
record makes each open usable once.

The replay record is kept only in the memory of the server that owns the
space, and is not persisted. A server that restarts inside a window forgets the
opens it accepted in that window, which lets a captured open from that window
be used once more before it expires. The window bounds that exposure, and it is
accepted.

Compatibility follows the flags:

- a server advertising `sessionOpenNonce` keeps accepting challenge-signed
  opens from clients that do not advertise it, until that path is retired
- a client talking to a server without the flag signs challenges as today and
  serializes its opens on the connection: sign, send, receive the response and
  its new challenge, and only then sign the next

#### Per-space receive order

The server replaces the connection's single receive chain with one chain per
space. A frame enters the chain for the `space` it names; a frame that names no
space (`hello`, an unreadable message) enters a connection-level chain that
every space chain waits for. This keeps the ordering each space has today,
since today a connection carries one space, and removes waiting between spaces.
No flag is needed: the change is invisible to a client that uses one space per
connection.

The client's own guarantees do not change. It still sends a session's commits
in `localSeq` order and serializes a session's watch mutations; both are
per-session and therefore per-space.

#### `session.close`

A new request ends a session on the server:

```typescript
// Shown at module scope.
type SpaceId = string;
type SessionId = string;

interface SessionCloseRequest {
  type: "session.close";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
}

/** `ok` of the response. */
type SessionCloseResult = Record<string, never>;
```

The server removes the session from the connection, detaches it in the session
registry, ends its presence memberships, and stops fan-out to it. The session
stays resumable for the registry's detach grace period, exactly as after a
dropped connection, so a client that releases a space and mounts it again soon
after resumes rather than starting fresh. A close of a session the connection
does not hold returns `SessionError`. The server advertises the request with a
`sessionClose` flag; against a server without it, the client leaves the session
attached, which is today's behavior.

#### Presence membership per session

Presence rooms key membership by connection, and a connection is in a room at
most once. With several sessions on one connection that becomes a limit: two
sessions in the same space (for example two identities) cannot both be members
of one room. Membership moves to `(connection, space, sessionId)`. The
`presence.*` messages already name the session, so the wire does not change.

### 3.3 Client library changes

- `mount()` signs a nonce-based open and runs concurrently with other mounts
  when the server advertises `sessionOpenNonce`, and otherwise signs the
  current challenge and waits for the previous open on the connection.
- The reconnect loop runs `hello` once and then restores every session in
  parallel. A permanent authorization failure still terminates only the session
  it belongs to.
- `SpaceSession.close()` sends `session.close` when the server supports it.

### 3.4 Runner changes

- `RemoteSessionFactory` keeps one `Client` per resolved memory origin (the
  storage URL without the `space` parameter) and counts the sessions mounted on
  it. `create()` mounts on the pooled client; the client closes when its last
  session is released.
- The factory interface returns a handle whose release closes the session, and
  the storage manager's sites that now close a client to end a space session
  release the session instead. `serverFlags` and connection state become
  properties of the host connection rather than of a space.
- Route replacement for a space that moves hosts releases the session on the
  old host's client and mounts on the new host's client.
- The ACL bootstrap uses `space.genesis` (section 4) where the server supports
  it, and otherwise opens its space-identity session on the pooled client and
  closes it with `session.close`.
- The loopback session factory that the serving runtime uses gets the same
  pooling; it has no sockets to save, but one client per server keeps the two
  factories alike.

## 4. Acting as a second identity

Sessions already carry their own principal, so after section 3 a client can
hold sessions for several identities on one connection. That is the right tool
for sustained work as another identity. It is heavy for the case that exists
today: writing one genesis ACL as the space identity, which needs a session,
a point read, a single commit, and a close, and which the runner keeps apart
from the replica session because both allocate `localSeq` from 1.

A one-shot signed request covers that case:

```typescript
// Shown at module scope.
type SpaceId = string;
type DID = string;

interface SpaceGenesisInvocation {
  iss: DID;
  cmd: "space.genesis";
  sub: SpaceId;
  aud: DID;
  args: {
    /** The whole ACL document to install. */
    acl: Record<string, "READ" | "WRITE" | "OWNER">;
    /** The custom root intent, when the space reserves one. */
    genesisRoot?: unknown;
  };
  nonce: string;
  iat: number;
  exp: number;
}

interface SpaceGenesisRequest {
  type: "space.genesis";
  requestId: string;
  space: SpaceId;
  invocation: SpaceGenesisInvocation;
  authorization: { signature: Uint8Array };
}

interface SpaceGenesisResult {
  serverSeq: number;
  /** False when an ACL already stood; the caller then reads it. */
  created: boolean;
}
```

The server verifies the signature, the audience, the time window, and the nonce
under the same rules as a nonce-based `session.open` (section 3.2), requires `iss` to be the space DID or a
configured service DID, and applies the genesis commit under the admission
rules of INV-12 and INV-13 in [09-invariants.md](./09-invariants.md). It needs
no open session for the space: the request is its own authorization. When an
ACL already stands the result says so and nothing is written; the caller reads
the standing ACL through its own session, which has READ on a space whose ACL
was never created and on any space whose ACL grants it.

The bootstrap then becomes: open the user session, read the ACL, send
`space.genesis` if it was never created, and continue on the same session. The
server advertises the request with a `spaceGenesis` flag.

A general "act as another principal" field on `transact` is not proposed.
Session state — `localSeq`, pending reads, and the principal that user-scoped
documents resolve against — belongs to the session, and a commit that changed
principal part way through a session's stream would have to redefine all
three.

## 5. Routers in front of several toolsheds

A router accepts client connections and forwards each session's traffic to the
toolshed that owns its space. Two shapes are possible:

- **Mode A:** one upstream connection per client per toolshed. The router
  splices one client connection onto one upstream connection for each toolshed
  that client uses.
- **Mode B:** one upstream connection per router per toolshed, carrying the
  sessions of every client the router serves.

### 5.1 Requirements common to both modes

**Signatures that survive a hop.** Nonce-based session opens (section 3.2)
depend on nothing about the connection they arrive on, so the router forwards
them unchanged and the toolshed that owns the space verifies them. Signatures
stay end to end, and the router is not trusted with authorization. A space
lives on one toolshed at a time, so the replay record for a space lives in one
place. A router forwards only clients that advertise `sessionOpenNonce`: a
challenge-signed open cannot pass it, since the challenge belongs to a
connection the client never sees.

The alternative — the router authenticates the client and asserts the
principal to the toolshed as a delegating service identity — makes the router
part of the trusted base for every space it routes. It is not proposed.

**A space directory.** Today the client decides which host serves a space, from
`spaceHostMap` seeds, hints registered at runtime, and the home-space site
table. With a router, the router makes that decision and needs a directory
from space DID to toolshed.

**Routing without parsing the payload.** The router needs a frame's `space`.
Reading it from a text frame means parsing the JSON; reading it from a
compressed frame means expanding the gzip member first. A version 2 of the
binary envelope carries the space DID in the uncompressed header, and the
router forwards the compressed bytes unchanged when the next hop negotiated
compression too.

**Losing one upstream.** When one upstream connection drops, only the sessions
it carried are affected. A new push tells the client which:

```typescript
// Shown at module scope.
type SpaceId = string;
type SessionId = string;

interface SessionDetached {
  type: "session/detached";
  space: SpaceId;
  sessionId: SessionId;
}
```

The client restores that session alone, with the same resume and holdings
declaration it uses after a dropped connection. Today the client restores
sessions only after its transport closes.

### 5.2 Mode A: one upstream per client per toolshed

The router opens an upstream connection to a toolshed the first time the
client names a space that toolshed owns.

- `hello`: the router answers the client itself, advertising the flags that
  every toolshed it routes to supports, and sends its own `hello` upstream.
- Request ids are unique within one client connection, so they pass through
  unchanged, and every server push names its session.
- Compression is negotiated separately on each hop.
- Ordering and back pressure are what they are today: each upstream connection
  serves one client.
- Before `session/detached` exists, the router may close the client connection
  when any of its upstream connections drops. That resets all of the client's
  spaces, which is today's behavior for a single host.

### 5.3 Mode B: one upstream per router per toolshed

Everything in section 5.2 applies, and the shared upstream connection adds the
following.

- **Receive order per session.** The per-space chains of section 3.2 would
  still make clients in one space wait for each other; the chains become per
  session.
- **Request id namespaces.** The client's request ids (`req:1`, `req:2`, …)
  collide across clients. The router rewrites each id on the way up and
  restores it on the way down.
- **Per-connection flags move to the session.** `stableExpressionResultIds`
  admission and the `syncSchemaTableV2` encoding are negotiated per connection.
  Clients of different builds share one upstream connection, so either these
  move into `session.open`, or the router normalizes every frame to what its
  client negotiated.
- **Detach on client loss.** A client that disconnects from the router no
  longer closes a connection the toolshed can see. The router sends
  `session.close` upstream for each of that client's sessions.
- **Large frames.** A WebSocket message is not interleaved with others, so a
  large sync frame for one client holds the upstream connection while it
  transfers. This needs either fragmenting large messages into chunks that
  interleave by session, or bounding sync payloads by paging them.
- **Back pressure.** The server sends without waiting for the peer. The router
  holds a bounded buffer per client and drops a client that fills it, rather
  than stalling the upstream connection for everyone; resume with declared
  holdings makes that drop cheap for the client.
- **Rate limiting** keys on the session principal rather than the TCP peer.
- **Upstream loss affects every client at once.** Every session on the
  connection detaches together, and each client must sign a new open. The
  router spreads the `session/detached` pushes over time to avoid every client
  reopening in the same instant.

### 5.4 Choosing a mode

Mode A needs the common requirements and little else, keeps the toolshed's
view of a connection as one client, and leaves ordering, back pressure, and
failure isolation as they are. Mode B saves toolshed sockets at the cost of
putting every client on the router behind the same connection for ordering,
large frames, and failures. Mode A is the proposed first router. Mode B is
worth building only when the number of sockets a toolshed holds is the measured
limit.

## 6. Phases

| Phase | Change | Depends on |
| --- | --- | --- |
| 1 | Server: `sessionOpenNonce`, per-space receive chains, `session.close`, presence membership per session | — |
| 2 | Client: nonce-signed concurrent mounts, parallel restore, `session.close` on release | 1 |
| 3 | Runner: one pooled client per host, session release in place of client close | 2 |
| 4 | `space.genesis` and its use in the ACL bootstrap | 1 |
| 5 | The space field in the binary envelope, `session/detached` | 2 |
| 6 | Mode A router and space directory | 5 |

Phases 1 to 3 give the direct setup a single connection per host and do not
depend on anything after them.

## 7. Open questions

- **Retiring challenge-signed opens.** A server keeps accepting them for
  clients without `sessionOpenNonce`. When that path, and the challenge in
  `hello.ok`, can be removed depends on how long older clients stay deployed.
- **Detach grace after `session.close`.** Keeping a closed session resumable
  helps a client that remounts a space soon after releasing it. Whether the
  grace period should differ from the one after a dropped connection is not
  settled.
- **Holdings on a shared connection.** The 1,000,000-slot message limit bounds
  one resume's holdings declaration per space. Parallel restore sends several
  such messages at once; whether the server needs a limit across a connection's
  concurrent restores is not settled.
