# Memory Connection Multiplexing

Status: the direct setup of section 3 is implemented behind the
`sharedMemoryConnection` experimental flag, which is off by default
([EXPERIMENTAL_OPTIONS.md](../../development/EXPERIMENTAL_OPTIONS.md#sharedmemoryconnection)).
The wire behavior it shipped is specified in [04-protocol.md](./04-protocol.md);
where the two differ, that chapter describes the system. The opt-in Mode A router contract is implemented in
[routed-mode-a.md](./routed-mode-a.md) and the companion infra Rust service.
Public deployment requires the security acceptance and main-artifact gates.
Mode B and attestation (section 6) remain proposed.

## 1. Two ways to reach a host

The wire protocol in [04-protocol.md](./04-protocol.md) does not tie a
connection to a space: every request after `hello` names its `space`, every
request after `session.open` names its `sessionId`, and server pushes carry
both. A connection may hold sessions for several spaces, and several sessions
for one space, each with the principal its own open was authorized as.

What ties a connection to a space is the runner. `RemoteSessionFactory`
(`packages/runner/src/storage/v2-remote-session.ts`) works one of two ways,
chosen by the `sharedMemoryConnection` flag (the toolshed's own runtime is the
exception: it always dials one connection per space, see [routed Mode
A](routed-mode-a.md) step 4):

- **One connection per space**, the default. Each space gets a
  `WebSocketTransport` and a `Client` of its own, dialed at an address that
  names the space in its `space` query parameter. Authentication follows
  the server's capabilities: `connection.auth` when advertised, otherwise
  a signed `session.open`. Ending the session closes the connection. This is
  what a deployment that routes a connection to a toolshed by the space its
  address names requires.
- **One connection per host**, under the flag. The factory dials one
  connection per storage address, with no space in it, and mounts the session
  of every space on that host on it. Each key the manager acts as authenticates
  with `connection.auth`, renews before its lease expires, and opens sessions
  naming that principal. Ending a session sends `session.close` and
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
2. A client authenticates each key when it is first needed and renews it before
   its lease expires. It can authenticate more than one key on a connection and
   open sessions as any of them.
3. Startup and reconnect latency for N spaces stays close to what N parallel
   sockets give: session opens on one connection run concurrently, and a
   reconnect restores every session at once.
4. A router can sit between clients and toolsheds. The toolshed that owns a
   space verifies the client's signature itself and trusts the router for the
   freshness of it.
5. Authentication material stays in connection-level exchanges: the initial
   exchange and later lease renewals. Session opens and operations carry no
   authentication material. Remote attestation can extend the initial exchange
   (section 6), with its renewal policy specified separately.

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
one outright. With `connectionAuth`, the client keeps the audience from
`hello.ok` and does not replace it from a `session.open` response. A
`session.open` then names an authenticated principal and carries no signature,
so opens on one connection run concurrently and a
reconnect costs one signature per key rather than one per space. The server
advertises the capability as `connectionAuth`; toolshed does so under the
flag. `connection.release` ends a key's authentication for new session opens,
which a client uses after acting as a space identity for its genesis ACL.
Existing sessions remain under their original lease.

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
reach through the peer that issued the challenge, while its authentication
lease remains valid. The challenge binds it to one connection.

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
`session.open`. The client authenticates a key when first needed, however many
sessions are mounted as it, and renews it before its lease expires. It asks for
a challenge of its own when the one it holds has expired or the key has signed
it. Against a server without `connectionAuth`, it signs each `session.open`
and issues them one at a time, since each uses the connection's current
challenge and receives the next.
With `connectionAuth`, it keeps the audience and first challenge from
`hello.ok`; subsequent `session.open` authentication metadata does not change
that audience. It asks for a new challenge when the same key must sign again.

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
on a mutually authenticated, encrypted, long-lived connection called the router
link. The router authenticates as its own identity, and the toolshed's
configuration lists the router identities it accepts. The link agent holds that
identity's key and a link epoch; replacing or revoking the link invalidates its
epoch, tickets, client contexts, and sessions at the toolshed. Being a router
grants one thing: the toolshed accepts verifiable client authentication
statements it forwards. It grants no capability on any space. Router-to-toolshed
authentication, and later attestation (section 6), is paid once per link rather
than per client or session.

**Client authentication through a router.** The link agent issues the
challenge in the router's `hello.ok`. Its `sessionOpen` metadata carries the
router identity as `audience`, the challenge, and a configured `deployment`
identifier. A routed `connection.auth` signs the principal in `iss`, `cmd`, the
router identity in `aud`, the memory protocol in `args.protocol`, the same
identifier in `args.deployment`, the challenge, `iat`, and `exp`. The routed
invocation is distinct from the direct invocation in
[04-protocol.md](./04-protocol.md); clients and toolsheds negotiate its support
before using a router. The client signs a challenge once per principal on its
connection. A new router or router-link epoch requires a new challenge and
signature.

The link agent assigns a client-context ID unique within its link epoch from
the worker IPC channel, never from client-supplied data. Its signed challenge
record binds the deployment, router identity, link epoch, context ID,
challenge value, issue time, and expiry. Its separately signed receipt binds
that challenge record, a claimed principal, and a digest of the exact
`connection.auth` statement bytes to a receipt time measured by the link
agent. The worker supplies the claimed
principal as bounded IPC metadata but supplies neither the time nor the
context ID. The link agent receives and hashes the opaque statement without
parsing Memory payloads and records one receipt per context, challenge, and
claimed principal. The toolshed checks that the signed `iss` equals the
receipt's principal; a different claim cannot permit a second accepted
statement for the same signer and challenge. The router worker verifies the
client's signature before it asks the link agent to retain the statement.

**Forwarded-proof control.** The link agent sends the exact statement bytes,
both signed records, the client-context ID, and the assigned upstream ticket
identifier to a toolshed over its authenticated router link. The toolshed
accepts this control message only from the link agent on that link, associates
it with the one ticketed upstream for the context, hashes the statement bytes
before parsing them, and verifies the records against the allowlisted router
identity. It compares the digest, challenge, deployment, context, epoch, and
times with the parsed and signed invocation. The records must show
`issuedAt <= receivedAt < expiresAt`, with at most 60 seconds from issue to
expiry. A public client cannot set a
`forwarded` marker or send this control message. Session traffic on the
ticketed upstream waits behind proof admission. The control-record encoding
must have one interpretation and bounded lengths; its canonical bytes and test
vectors are part of the phase 4 wire change.

The toolshed verifies the client signature and signed fields itself. The
invocation uses integral Unix seconds for `iat` and `exp`. At most 120 seconds
of positive client clock skew is allowed against the attested receipt time;
`exp` is no later than 600 s after either `iat` or receipt, and a statement
presented at or after `exp` is refused. A challenge received at or after its
expiry, or a proof for a different deployment, router, context, or link epoch,
is refused. Clock skew cannot extend the challenge or lease past its recorded
expiry. The toolshed records each accepted challenge and statement digest by
router, epoch, context, and principal. It rejects a different statement for
the same challenge and principal. The same statement can reach another
assigned toolshed before `exp`; on one toolshed it can establish at most one
live backend context for that client context. Re-presentation for recovery
atomically replaces that context rather than creating another. A statement
from one router is refused on every other router's link.

A statement's signed `exp` bounds both the window in which it may first reach a
toolshed and the backend lease it creates. Forwarding it later never starts a
new ten-minute lease. The client renews before `exp` with a new challenge and
signature for the same context. A permanent refusal of renewal revokes the
routed context and its sessions; a transient failure leaves authority only
until the existing `exp`, when the toolshed closes or revokes its sessions.
Client close and router-link loss revoke the context and sessions immediately
when the toolshed receives that event. A compromised router can withhold a
client-close event, but cannot extend the signed lease. In routed mode,
`connection.release` prevents new sessions as that principal while existing
sessions retain their original lease; it is not a revocation signal. Context
close is a separate authenticated router-link operation. The direct setup
keeps its renewable-session behavior specified in [04-protocol.md](./04-protocol.md).

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
challenge, using the router audience and deployment identifier from its
`hello.ok`. A toolshed never sends this push to a client connected to it
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
  forward a client's flags exactly refuses the client. The router stage
  requires the client's `connectionAuth` and routed-auth support; older clients
  using signed `session.open` are not routed under this contract.
- Authentication metadata: the client pins the router audience and deployment
  identifier from the router's `hello.ok`. With `connectionAuth`, it ignores
  the toolshed's `sessionOpen` metadata in a forwarded `session.open` response
  and gets later challenges from the router. A toolshed's audience cannot
  replace the router's on the client connection.
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
- Before `session/detached` exists, the router closes the client connection
  when any of its upstream connections drops. That resets all of the client's
  spaces, which is today's behavior for a single host.

### 5.3 Mode B: one upstream per router per toolshed

Mode B shares the client-authentication and router-link requirements of
section 5.1, but needs a separate security review before implementation. It
replaces Mode A's ticketed upstream connections with one shared data channel.
The minimum constraints for that review are:

- **Receive order per session.** The per-space turns of section 3.1 would
  still make clients in one space wait for each other; the chains become per
  session.
- **The router link carries the traffic.** The link agent authenticates the
  toolshed, then hands only its data channel to a payload-opaque multiplexer.
  No tickets are needed on that channel, and the multiplexer holds no router
  identity key.
- **Principals per client.** Authenticated principals belong to a client, not
  to the connection. A client ID is assigned from the worker IPC channel, not
  from a client field, and the toolshed keeps principals and sessions under it.
- **Request id namespaces.** The client's request ids (`req:1`, `req:2`, …)
  collide across clients. The toolshed scopes each request ID by client ID;
  the multiplexer does not rewrite payloads.
- **Per-connection flags move to the session.** `stableExpressionResultIds`
  admission and the `syncSchemaTableV2` encoding are negotiated per connection.
  Clients of different builds share one upstream connection, so their
  negotiated flags move into each client's `session.open` admission state.
- **Detach on client loss.** A client that disconnects from the router no
  longer closes a connection the toolshed can see. The multiplexer sends one
  client-loss signal; the toolshed closes that client's sessions.
- **Large frames.** The data channel carries bounded chunks interleaved fairly
  across clients, with per-client and total reassembly limits at the toolshed.
- **Back pressure.** The server sends without waiting for the peer. The router
  holds a bounded queue per client and drops a client that fills it, rather
  than stalling every client on the shared channel.
- **Rate limiting** keys on client context and principal, not the shared TCP
  peer.
- **Upstream loss affects every client at once.** Every session on the
  connection detaches together. The router obtains a new challenge and client
  signature for each context in the new link epoch before restoring it. It
  spreads client reconnects or `session/detached` pushes over time to avoid
  every client reopening in the same instant.

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

- **Connection-level exchanges carry authentication.** Under connection
  authentication (section 3.1), `hello` and `connection.auth` establish trust
  initially, and a later challenge and `connection.auth` renew the lease. No
  `session.open` or session operation carries authentication material.
  Attestation adds steps to the initial exchange under capability flags.
  Whether renewing a lease also renews attestation is part of the separate
  attestation design.
- **The router link is where router-to-toolshed attestation is paid.** It is
  long-lived and established once per pair, and Mode A's upstream connections
  inherit its trust through tickets. Attesting the link once covers every
  client and every session that crosses it.
- **Freshness in both directions.** The challenge in `hello.ok` is the value
  the peer contributes and the client signs. Attestation evidence from the
  peer needs a value the client contributes, which `hello` can carry.

Two things follow for work done now. Authentication and renewal stay in
connection-level messages. The state authentication produces, the set of
authenticated principals, is kept by the connection or by the client context
on a router link, never by a session.

## 7. Phases

| Phase | Change | State |
| --- | --- | --- |
| 1 | Server: `connection.auth`, `connection.challenge`, `connection.release`, unsigned `session.open` naming a principal, per-space turns, `session.close`, presence membership per session | done |
| 2 | Client: authentication per key, concurrent mounts, parallel restore, `session.close` on release | done |
| 3 | Runner: one pooled client per host, session release in place of client close, behind `sharedMemoryConnection` | done |
| 4 | Routed-auth negotiation and client signing context, the router link, forwarded statements and evidence, `connection/challenge`, the space field in the binary envelope | implemented; public deployment gated |
| 5 | Mode A router, link tickets, and space directory | implemented; public deployment gated |
| 6 | `session/detached` for restoring one session without closing the client connection | proposed |

The flag can stay off while Memory WebSockets move from the HTTP placement
router to the Mode A router. Routed-capable clients and toolsheds must be
installed first. Dedicated connections keep `?space=<DID>`, negotiate routed
`connection.auth`, and can use only that space. After that path passes
acceptance, enabling the flag uses the space-free URL and shares one socket
across spaces. The URL parameter grants no space authority; directory admission,
client signature verification, ownership, session bindings and ACLs apply in
both topologies.

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
