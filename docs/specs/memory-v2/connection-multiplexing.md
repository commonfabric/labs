# Memory Connection Multiplexing

Status: the direct setup of section 3 is implemented behind the
`sharedMemoryConnection` experimental flag, which is off by default
([EXPERIMENTAL_OPTIONS.md](../../development/EXPERIMENTAL_OPTIONS.md#sharedmemoryconnection)).
The wire behavior it shipped is specified in [04-protocol.md](./04-protocol.md);
where the two differ, that chapter describes the system. `space.genesis`
(section 4), the router (section 5), and attestation (section 6) are proposed
and not implemented.

This document describes how a client reaches every space it uses over one
memory connection per toolshed instead of one per space, and how routers that
terminate client connections in front of several toolsheds fit on top of that.
Authentication moves from each `session.open` to the start of the connection:
a client authenticates each key it uses once per connection, and every later
request names the authenticated principal it acts as. That is also how a client
acts as a second identity for a few requests — the case that matters is
initializing a space's ACL as the space identity.

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
2. A client authenticates once per connection and key. It can authenticate
   more than one key on a connection, open sessions as any of them, and
   perform a one-shot operation as another identity (space ACL genesis) without
   a session for it.
3. Startup and reconnect latency for N spaces stays close to what N parallel
   sockets give today.
4. A router can sit between clients and toolsheds. The toolshed that owns a
   space verifies the client's signature itself and trusts the router for the
   freshness of it.
5. Everything about establishing trust happens in one exchange at the start of
   a connection, and nothing later in the connection carries authentication
   material. That exchange is where remote attestation will be added
   (section 6), so the steps it has today are placed where those steps will
   go.

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

#### Connection authentication

A connection is established in two steps: the `hello` exchange, and then one
`connection.auth` request for each key the client will act as. The server
advertises the second step with a new capability flag, `connectionAuth`.

The challenge is created by the peer the client is connected to, never by the
client. `hello.ok` carries the audience and the first challenge, in the
`sessionOpen` field it has today. The client signs an invocation over them:

```typescript
// Shown at module scope.
type DID = string;

interface ConnectionAuthInvocation {
  iss: DID;
  cmd: "connection.auth";
  aud: DID;
  args: { protocol: "memory" };
  challenge: string;
  iat: number;
  exp: number;
}

interface ConnectionAuthRequest {
  type: "connection.auth";
  requestId: string;
  invocation: ConnectionAuthInvocation;
  authorization: { signature: Uint8Array };
}

interface ConnectionAuthResult {
  principal: DID;
}

interface ConnectionChallengeRequest {
  type: "connection.challenge";
  requestId: string;
}

interface ConnectionChallengeResult {
  challenge: { value: string; expiresAt: number };
}
```

The server accepts a `connection.auth` when:

- the signature verifies against `iss`
- `aud` is the audience the server advertised
- `challenge` is one the server issued on this connection, has not expired, and
  has not already been accepted for this `iss`
- `exp` is not earlier than the server clock minus the clock-skew grace

From then on `iss` is an authenticated principal of the connection, until the
connection closes or the client releases it (section 4). A challenge may be
signed by several keys, once each, so authenticating two keys needs no
ordering between them. A client that needs a challenge after the one in
`hello.ok` has expired — to authenticate another key on a connection that has
been open for a while — requests one with `connection.challenge`.

Requests that are signed today stop carrying a signature and name a principal
instead:

```typescript
// Shown at module scope.
type SpaceId = string;
type SessionId = string;
type DID = string;

interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: SpaceId;
  /** An authenticated principal of this connection. */
  principal: DID;
  session: {
    sessionId?: SessionId;
    seenSeq?: number;
    sessionToken?: string;
  };
}
```

The server refuses a `session.open` whose `principal` is not authenticated on
the connection with an `AuthorizationError`, and otherwise treats the principal
exactly as it treats the verified issuer of a signed open today: the ACL of the
space decides what the session may do, the session records the principal, and a
resume by a different principal is refused. The session descriptor —
`readCeiling` and `actingAs` included — is no longer inside a signature. It
does not need to be: only the authenticated client can send on the connection.

Session opens no longer consume a challenge, so opens on one connection run
concurrently, and restoring N spaces after a reconnect costs one signature per
key instead of one per space.

What a signature authorizes becomes wider. A signed `session.open` is good for
one space; a signed `connection.auth` is good for everything its key can reach
through the peer that issued the challenge. The challenge binds the signature
to one connection, so a captured one cannot be used on another.

Why the peer creates the challenge rather than the client creating a nonce:

- A value the client chooses proves nothing about freshness by itself. The
  server would have to remember every value it accepted and compare clocks
  with the client. A challenge the server issued is fresh by construction, and
  the server keeps nothing beyond the connection's own state.
- A signature over a client-chosen value can be made ahead of time by anything
  that can ask the key to sign, and used later. A signature over a challenge
  cannot be made before the challenge exists.

A challenge has a risk of its own, which the audience covers: a peer can hand
the client a challenge it obtained elsewhere and present the signature there.
The signature names the audience, so it is accepted only by servers of the
deployment the client meant to reach, and within a deployment that relay is
what a router does (section 5).

Compatibility follows the flag:

- a server advertising `connectionAuth` keeps accepting signed `session.open`
  requests from clients that do not advertise it, until that path is retired
- a client talking to a server without the flag signs each `session.open` as
  today and serializes its opens on the connection: sign, send, receive the
  response and its new challenge, and only then sign the next

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

- The client keeps the signer for each key it has authenticated. `mount()`
  authenticates its signer's key if the connection has not yet, and then sends
  an unsigned `session.open` naming it. Mounts run concurrently.
- The reconnect loop runs `hello`, authenticates every key that has a session,
  and then restores every session in parallel. A permanent authorization
  failure of a `session.open` still terminates only the session it belongs to;
  one of a `connection.auth` terminates the sessions of that key.
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

A second identity is a second `connection.auth` on the same connection. The
client can then open sessions as either principal. A principal the client no
longer needs is released:

```typescript
// Shown at module scope.
type DID = string;

interface ConnectionReleaseRequest {
  type: "connection.release";
  requestId: string;
  principal: DID;
}
```

After a release the server refuses new requests naming that principal.
Sessions already open keep the principal they recorded when they opened. The
server bounds the number of principals a connection holds, so a client that
creates many spaces releases each space identity once it has used it.

Opening a session is heavy for the case that exists today: writing one genesis
ACL as the space identity, which needs a session, a point read, a single
commit, and a close, and which the runner keeps apart from the replica session
because both allocate `localSeq` from 1. A one-shot request covers that case:

```typescript
// Shown at module scope.
type SpaceId = string;
type DID = string;

interface SpaceGenesisRequest {
  type: "space.genesis";
  requestId: string;
  space: SpaceId;
  /** An authenticated principal of this connection. */
  principal: DID;
  /** The whole ACL document to install. */
  acl: Record<string, "READ" | "WRITE" | "OWNER">;
  /** The custom root intent, when the space reserves one. */
  genesisRoot?: unknown;
}

interface SpaceGenesisResult {
  serverSeq: number;
  /** False when an ACL already stood; the caller then reads it. */
  created: boolean;
}
```

The server requires `principal` to be authenticated on the connection and to
be the space DID or a configured service DID, and applies the genesis commit
under the admission rules of INV-12 and INV-13 in
[09-invariants.md](./09-invariants.md). It needs no open session for the
space. When an ACL already stands the result says so and nothing is written;
the caller reads the standing ACL through its own session, which has READ on a
space whose ACL was never created and on any space whose ACL grants it.

The bootstrap then becomes: open the user session, read the ACL, and if it was
never created, authenticate the space identity, send `space.genesis`, and
release the space identity. The replica continues on the user session. The
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

**The router link.** A router and a toolshed establish trust once per pair,
on a long-lived connection called the router link. The router authenticates on
it with `connection.auth` as its own identity, and the toolshed's configuration
lists the router identities it accepts. Being a router grants one thing: the
toolshed accepts client authentication statements the router forwards. It
grants no capability on any space. Everything expensive about trust between a
router and a toolshed is paid on the link, once, and not per client or per
session; today that is one signature, and later it is attestation (section 6).

**Client authentication through a router.** The client runs the same exchange
it runs against a toolshed. The router issues the challenge in its `hello.ok`,
advertises the audience of the deployment, and verifies each `connection.auth`
itself. When the client first names a space on some toolshed, the router
forwards the client's signed statement to that toolshed, marked as forwarded.
The toolshed verifies the signature, the audience, and `exp`, and accepts the
router's word for the challenge, which it did not issue. The toolshed therefore
checks for itself that the key signed, and trusts the router that the
signature was made for a connection that is open now.

A statement is valid for 300 seconds, the validity clients stamp on a signed
open today. When the router needs to forward a statement that has expired —
the client reaches a new toolshed after the connection has been open for a
while, or a router link was re-established — it asks the client to sign again:

```typescript
// Shown at module scope.
type DID = string;

interface ConnectionChallengePush {
  type: "connection/challenge";
  principal: DID;
  challenge: { value: string; expiresAt: number };
}
```

The client answers with a `connection.auth` for that principal over the new
challenge. A toolshed never sends this push to a client connected to it
directly.

**What the router is trusted with.** Requests after authentication carry no
signature, so a router can send any request as any principal whose statement
it holds and can keep current. A compromised router can therefore act as every
client connected to it, in every space those clients' keys can reach, for as
long as they stay connected. It cannot act as a key whose client is not
connected, because it cannot obtain a fresh statement for it. This exposure is
accepted.

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
- An upstream connection does not authenticate the router again. The toolshed
  issues short-lived tickets over the router link, and the router presents one
  in the `hello` of each upstream connection, which makes that connection part
  of the link's trust.
- The principals authenticated on an upstream connection are the ones its
  client authenticated, forwarded as section 5.1 describes.
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
- **The router link carries the traffic.** The shared upstream connection is
  the router link itself, so no tickets are needed.
- **Principals per client.** Authenticated principals belong to a client, not
  to the connection. The router assigns each client an id, stamps it on every
  frame it forwards, and the toolshed keeps principals and sessions under it.
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
  connection detaches together, and the router must forward every client's
  statement again, asking for a new signature where one has expired. The
  router spreads the `session/detached` pushes over time to avoid every client
  reopening in the same instant.

### 5.4 Choosing a mode

Mode A keeps the toolshed's view of a connection as one client, and leaves
ordering, back pressure, and failure isolation as they are. What it adds is
the router link and its tickets. Mode B saves toolshed sockets and needs no
tickets, at the cost of putting every client on the router behind the same
connection for ordering, large frames, and failures.

Both modes pay for router-to-toolshed trust once per pair, on the router link,
so amortizing that cost does not decide between them. Mode A is the proposed
first router. Mode B is worth building when the number of sockets a toolshed
holds is the measured limit.

## 6. Remote attestation

Remote attestation is not designed here. This section records what is known
about it and how the design above leaves room for it.

What is known:

- Attestation will run between client and router, and between router and
  toolshed. A client that has attested a router which has attested its
  toolsheds has attested those toolsheds transitively.
- Attestation is expensive, and its cost between a router and a toolshed must
  be amortized across the clients the router serves.
- The exchange at the start of a client connection will have more steps than
  it has today.

Where it goes:

- **Connection establishment is the one place trust is established.** After
  section 3.2, `hello` and `connection.auth` are the only messages that carry
  authentication material, and establishment is already a sequence of requests
  and responses rather than one message. Attestation adds steps to that
  sequence, under capability flags, and changes nothing after it:
  `session.open` and every request that follows carry no material that
  attestation would have to extend.
- **The router link is where router-to-toolshed attestation is paid.** It is
  long-lived and established once per pair, and Mode A's upstream connections
  inherit its trust through tickets. Attesting the link once covers every
  client and every session that crosses it.
- **Freshness in both directions.** The challenge in `hello.ok` is the value
  the peer contributes and the client signs. Attestation evidence from the
  peer needs a value the client contributes, which `hello` can carry.

Two things follow for work done now. Authentication is not added to any
message outside connection establishment. And the state authentication
produces, the set of authenticated principals, is kept by the connection, or
by the client id on a router link, and never by a session.

## 7. Phases

| Phase | Change | Depends on |
| --- | --- | --- |
| 1 | Server: `connection.auth`, `connection.challenge`, `connection.release`, unsigned `session.open` naming a principal, per-space receive chains, `session.close`, presence membership per session | — |
| 2 | Client: authentication per key, concurrent mounts, parallel restore, `session.close` on release | 1 |
| 3 | Runner: one pooled client per host, session release in place of client close | 2 |
| 4 | `space.genesis` and its use in the ACL bootstrap | 1 |
| 5 | The router link, forwarded statements, `connection/challenge`, the space field in the binary envelope, `session/detached` | 2 |
| 6 | Mode A router, link tickets, and space directory | 5 |

Phases 1 to 3 give the direct setup a single connection per host and do not
depend on anything after them.

## 8. Open questions

- **Retiring signed session opens.** A server keeps accepting them for clients
  without `connectionAuth`. When that path can be removed depends on how long
  older clients stay deployed.
- **The limit on principals per connection.** Its value, and whether the
  server releases the least recently used principal or refuses the next
  `connection.auth`, is not settled.
- **Toolsheds a router reaches later.** A client attests transitively the
  toolsheds its router has attested when the connection starts. What the
  client learns when the router starts routing it to a toolshed it attested
  afterwards belongs to the attestation design.
- **Detach grace after `session.close`.** Keeping a closed session resumable
  helps a client that remounts a space soon after releasing it. Whether the
  grace period should differ from the one after a dropped connection is not
  settled.
- **Holdings on a shared connection.** The 1,000,000-slot message limit bounds
  one resume's holdings declaration per space. Parallel restore sends several
  such messages at once; whether the server needs a limit across a connection's
  concurrent restores is not settled.
