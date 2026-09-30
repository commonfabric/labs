# Memory Connection Multiplexing

Status: the direct setup of section 3 is implemented behind the
`sharedMemoryConnection` experimental flag, which is off by default
([EXPERIMENTAL_OPTIONS.md](../../development/EXPERIMENTAL_OPTIONS.md#sharedmemoryconnection)).
The wire behavior it shipped is specified in [04-protocol.md](./04-protocol.md);
where the two differ, that chapter describes the system. The router (section
5) and attestation (section 6) are proposed and not implemented.

This document describes how a client reaches every space it uses over one
memory connection per toolshed instead of one per space, and how routers that
terminate client connections in front of several toolsheds fit on top of that.
Authentication moves from each `session.open` to the start of the connection:
a client authenticates each key it uses once per connection, and every later
request names the authenticated principal it acts as. That is also how a client
acts as a second identity for a few requests — the case that matters is
initializing a space's ACL as the space identity.

## 1. Two ways to reach a host

The wire protocol in [04-protocol.md](./04-protocol.md) does not tie a
connection to a space: every request after `hello` names its `space`, every
request after `session.open` names its `sessionId`, and server pushes carry
both. A connection may hold sessions for several spaces, and several sessions
for one space, each with the principal its own open was authorized as.

What ties a connection to a space is the runner. `RemoteSessionFactory`
(`packages/runner/src/storage/v2-remote-session.ts`) works one of two ways,
chosen by the `sharedMemoryConnection` flag:

- **One connection per space**, the default. Each space gets a
  `WebSocketTransport` and a `Client` of its own, dialed at an address that
  names the space in its `space` query parameter, and its `session.open` is
  signed. Ending the session closes the connection. This is what a deployment
  that routes a connection to a toolshed by the space its address names
  requires.
- **One connection per host**, under the flag. The factory dials one
  connection per storage address, with no space in it, and mounts the session
  of every space on that host on it. Each key the manager acts as
  authenticates once per connection with `connection.auth`, and its sessions
  open naming that principal. Ending a session sends `session.close` and
  leaves the connection to its other sessions; the connection closes when the
  storage manager does. The ACL bootstrap of a fresh named space — a session
  as the active user to inspect the ACL, one as the space identity to write
  the genesis ACL, and the durable session as the user — runs over that one
  connection, as three sessions of two principals.

Per space, a connection of its own costs a TCP and TLS handshake, a `hello`
exchange, a compression channel, and a toolshed socket, and a client with
many spaces holds that many sockets against one host. The per-host connection
costs those once per host.

## 2. Goals and non-goals

Goals:

1. One memory connection per client per toolshed in the direct setup (a client
   talking to one toolshed, as in local development).
2. A client authenticates once per connection and key. It can authenticate
   more than one key on a connection and open sessions as any of them.
3. Startup and reconnect latency for N spaces stays close to what N parallel
   sockets give: session opens on one connection run concurrently, and a
   reconnect restores every session at once.
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

### 3.1 Protocol

[04-protocol.md](./04-protocol.md) specifies each of these; this section says
what each is for.

**Connection authentication** (section 4.5.1 there). A connection is
established in two steps: the `hello` exchange, and then one `connection.auth`
for each key the client will act as, signed over a challenge the server
issued on the connection. `hello.ok` carries the first challenge, every
`session.open` response carries another, and `connection.challenge` asks for
one outright. A `session.open` then names an authenticated principal and
carries no signature, so opens on one connection run concurrently and a
reconnect costs one signature per key rather than one per space. The server
advertises the capability as `connectionAuth`; toolshed does so under the
flag. `connection.release` ends a key's authentication, which a client uses
after acting as a space identity for its genesis ACL.

The challenge is created by the peer the client is connected to, never by the
client. A value the client chooses proves nothing about freshness by itself,
and a signature over it can be made ahead of time by anything that can ask
the key to sign. A challenge the server issued is fresh by construction and
cannot be signed before it exists. Its own risk — a peer handing the client a
challenge it obtained elsewhere and presenting the signature there — is
bounded by the audience the signature names, and inside a deployment that
relay is what a router does (section 5).

What a signature authorizes is wider than before: a signed `session.open` is
good for one space, a signed `connection.auth` for everything its key can
reach through the peer that issued the challenge, for as long as the
connection stays open. The challenge binds it to one connection.

**Per-space turns** (section 4.11.2 there). A connection handles the frames
for one space in the order they were handed over, and the frames for different
spaces independently, so a `transact` waiting for its space's publication lock
delays nothing addressed to another space. A frame naming no space — `hello`,
a `connection.*` request — is handled after every frame handed over before
it, which is what lets a client hand over a `session.open` behind the
`connection.auth` it depends on without waiting for the response.

**`session.close`** (section 4.3.7 there). Ends one session and leaves the
connection open. The session stays resumable for the detach grace a session
keeps after its connection closes.

**Presence membership per session** (section 4.13.1 there). Two sessions on
one connection each hold a membership of their own in a room.

### 3.2 Client library

`Client.mount()` takes the key a session acts as: a `SessionPrincipal`, which
signs a `connection.auth` and, for a server without `connectionAuth`, a
`session.open`. The client authenticates a key once per connection, however
many sessions are mounted as it, and asks for a challenge of its own when the
one it holds has expired or the key has signed it. Against a server without
`connectionAuth` it signs each `session.open` and issues them one at a time,
since each uses the connection's current challenge and receives the next.

A reconnect runs `hello` once and then restores every session at once. A
session's requests wait for its own restore only, so a space whose reopen is
slow delays no other space's requests. A permanent authorization failure of a
`connection.auth` terminates the sessions of that key; one of a `session.open`
terminates that session alone.

`SpaceSession.close()` sends `session.close` where the server supports it, and
otherwise leaves the session attached until the connection closes.

### 3.3 Runner

Under the flag, `RemoteSessionFactory` keeps one `Client` per storage address
and mounts every session on it. The connection a session was opened on is
handed to the storage manager as a `SessionConnection`, whose `close()` ends
that session and nothing else; the manager's own `close()` closes the
factory's connections. A pooled client that has failed or closed is replaced
on the next session. The choice is made per session as it is created, so the
`Runtime` declares the flag to its storage manager at construction, before any
session opens.

## 4. Acting as a second identity

A second identity is a second `connection.auth` on the same connection. The
client can then open sessions as either principal, and releases one it no
longer needs with `connection.release`. This is how the ACL bootstrap of a
fresh named space acts as the space identity.

The genesis of a fresh space is worth rethinking on its own. What the space
identity is for is assigning the space's first owner, and the key should be
unusable once it has: nothing in the protocol today burns it, so a client
that can sign as the space identity can keep opening sessions as the space's
implicit owner. A design that guarantees the burn — a one-shot genesis whose
acceptance retires the key, or a space identity that never exists as a
long-lived key at all — belongs to a document of its own.

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
it runs against a toolshed. The router issues the challenge in its `hello.ok`
and advertises its own identity as the audience, exactly as a toolshed
advertises its own, so the statement the client signs names the peer that
issued its challenge. The router verifies each `connection.auth` itself. When
the client first names a space on some toolshed, the router forwards the
client's signed statement to that toolshed, marked as forwarded. The toolshed
verifies the signature and `exp`, requires the statement's audience to be the
identity of the router link it arrived on, and accepts that router's word for
the challenge, which it did not issue. The toolshed therefore checks for
itself that the key signed and which router it signed for, and trusts only
that router for the statement having been made on a connection that is open
now. A statement that leaks from one router is refused on every other
router's link.

A statement's `exp` bounds two things, and the toolshed caps both. It is the
window in which the statement may be forwarded, and it is the lease on the
authentication it produces: a principal a toolshed admitted from a forwarded
statement is authenticated until that `exp`, however long the upstream
connection or the router link lives, and the toolshed caps the lease the
client may ask for. When the lease runs out, requests naming the principal
are refused, sessions opened as it are sent nothing more until it is renewed,
and renewal takes a new signature from the client's key: re-forwarding the old
statement extends nothing. A compromised router therefore holds a client's
authority for at most one lease past the client's last signature, whatever it
reports about the client's connection. The direct setup applies the same
lease, so a client renews its authentication before it runs out, over a
challenge it asks for.

When the router needs a statement it does not hold, or holds only expired —
the client reaches a new toolshed after the connection has been open for a
while, a router link was re-established, or a lease is about to run out — it
asks the client to sign again:

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
long as they stay connected and sign renewals, and for one lease after the
last signature it obtained. It cannot act as a key whose client has not signed
within a lease. This exposure is accepted.

**Parsing untrusted frames.** A router on public ingress reads what any
client sends. Expanding and parsing a frame — JSON, and the gzip member of a
compressed envelope — runs in a worker process with bounds on CPU, memory,
frame size, and expansion, that holds no router key, no link credential, and
no other client's traffic; the router treats what the worker returns as
untrusted data and forwards nothing it did not validate. A compromise of the
parser is then a compromise of one worker, not of the router's identity or of
its links. The toolshed validates every frame again for itself, as it does
today: nothing a router did is a reason for a toolshed to skip a check.

**A space directory.** Today the client decides which host serves a space, from
`spaceHostMap` seeds, hints registered at runtime, and the home-space site
table. With a router, the router makes that decision and needs a directory
from space DID to toolshed.

**Routing without parsing the payload.** The router needs a frame's `space`.
Reading it from a text frame means parsing the JSON; reading it from a
compressed frame means expanding the gzip member first. A version 2 of the
binary envelope carries the space DID in the uncompressed header, and the
router forwards the compressed bytes unchanged when the next hop negotiated
compression too. The header is routing metadata the client wrote, and nothing
more: the receiving toolshed expands the payload under the same bounds it
applies today, parses it, and refuses the frame before doing any work on it
when the space the payload names differs from the header's, when the payload
names its space or session more than once or ambiguously, or when the space
is one this toolshed does not currently own. A frame for space B carrying an
A header reaches A's toolshed and is refused there.

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
  every toolshed it routes to supports, and sends the client's own negotiated
  flags upstream, unchanged, in the `hello` of each upstream connection. The
  toolshed admits sessions by what that `hello` declares, so what it admits
  is the client, not the router: a client without `stableExpressionResultIds`
  is refused upstream exactly as it would be directly. A router that cannot
  forward a client's flags exactly refuses the client.
- An upstream connection does not authenticate the router again. The toolshed
  issues tickets over the router link, and the router presents one in the
  `hello` of each upstream connection, which makes that connection part of
  the link's trust. A ticket is not a bearer credential the link's trust
  rides on: it is redeemed once, atomically, by the toolshed that issued it;
  it names the router identity and the epoch of the link it was issued over,
  and the toolshed refuses it on any other link, after that link is revoked
  or replaced, and on any socket that is not a router's; and it is short-lived
  besides. A copied ticket joins nothing.
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

- **Receive order per session.** The per-space turns of section 3.1 would
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
  toolshed. A client that has attested a router accepts that router's
  reports of the toolsheds it has attested: delegated trust in the router,
  rather than the client's own verification of each toolshed. Whether the
  client can also bind the route it is served over, and the measurements it
  accepts, to something it verifies itself belongs to the attestation design.
- Attestation is expensive, and its cost between a router and a toolshed must
  be amortized across the clients the router serves.
- The exchange at the start of a client connection will have more steps than
  it has today.

Where it goes:

- **Connection establishment is the one place trust is established.** Under
  connection authentication (section 3.1), `hello` and `connection.auth` are
  the only messages that carry authentication material, and establishment is
  already a sequence of requests
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

| Phase | Change | State |
| --- | --- | --- |
| 1 | Server: `connection.auth`, `connection.challenge`, `connection.release`, unsigned `session.open` naming a principal, per-space turns, `session.close`, presence membership per session | done |
| 2 | Client: authentication per key, concurrent mounts, parallel restore, `session.close` on release | done |
| 3 | Runner: one pooled client per host, session release in place of client close, behind `sharedMemoryConnection` | done |
| 4 | The router link, forwarded statements, `connection/challenge`, the space field in the binary envelope, `session/detached` | proposed |
| 5 | Mode A router, link tickets, and space directory | proposed |

The flag stays off in a deployment that routes a connection by the space its
address names, until phase 5 gives it a router.

## 8. Open questions

- **Retiring signed session opens.** A server keeps accepting them for clients
  without `connectionAuth`. When that path can be removed depends on how long
  older clients stay deployed.
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
