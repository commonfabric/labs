# Memory Router Security Requirements

## Status and scope

Proposed requirements for the router phases of the
[Memory connection multiplexing design](../specs/memory-v2/connection-multiplexing.md).
The opt-in Mode A implementation is specified in
[the routed protocol](../specs/memory-v2/routed-mode-a.md); public deployment
remains subject to the acceptance gates below. Other router phases are proposed.
They depend on the direct connection-auth protocol described in that design.
The first public stage serves the spaces its directory places
through one client WebSocket that can reach several toolsheds. It uses the
design's Mode A: one upstream connection per client per toolshed. Mode B needs a
separate security review before deployment. That review must establish a
payload-opaque multiplexer that holds no router identity key. The link agent
authenticates each toolshed link and transfers only its data channel to the
multiplexer. The multiplexer assigns client IDs from worker IPC channels, never
from client fields; scopes request IDs by client ID at the toolshed instead of
rewriting payloads; moves client-specific flags into `session.open`; and signals
client loss once per client without tracking session IDs in the multiplexer. The
directory service must be outside the client data path. The review must bound
per-client queues and chunk sizes, interleave chunks fairly, enforce per-client
rate limits, and cap per-client and total reassembly at the toolshed. Only a
client's worker and the multiplexer may hold its data channel. The review must
assess the shared multiplexer compromise and crash blast radius, including
sharding per toolshed. Section 5.3 of the multiplexing design must be reconciled
with those constraints before Mode B is implemented.

This stage assumes that spaces have the intended access-control documents. That
is a deployment prerequisite, not a property established by the router. Legacy
spaces, which have history but no ACL, are refused until a service DID gives
them an ACL, which it may do at any time. Space creation is open to any
authenticated client when the directory has an `unlisted` rule (requirement 9);
a registry the router enforces is planned to restrict it. Because any client can
then own a space, operator requests such as disk-source registration are refused
to the router's clients and accepted elsewhere only from service DIDs. The
router protects Memory WebSockets; public HTTP routes need their own ingress and
authorization review.

## Trust boundary

The client authenticates a principal by signing a fresh challenge issued by the
router's link agent. The router terminates the client socket and can read,
modify, omit, and inject all later messages. The toolshed verifies the client
signature and the link agent's evidence of challenge issuance and timely receipt
of the signed statement. It trusts an allowlisted router for the binding between
a client connection and its forwarded requests. The toolshed remains the
authority for space ACLs, session admission, and every operation. A router
identity grants no space capability, service identity, or ability to bypass ACL
checks.

Consequently, compromise of a router permits acting as its authenticated clients
while their backend contexts remain valid. Process isolation limits which router
can be compromised; it does not make traffic through a compromised router
end-to-end authenticated. This authority must be represented explicitly in the
threat model and operational response. With the one-hour lease proposed below,
compromise can preserve a disconnected client's authority for the remainder of
that hour. The listener remains a shared ingress boundary: compromise can
interfere with connections it accepts. If it terminates TLS and retains the
certificate private key, compromise exposes that key too.

## Authentication and authorization

1. **Bind each proof to one router.** `connection.auth` must sign the protocol,
   deployment identifier, router identity, router-issued unpredictable
   challenge, principal, issue time, and expiry. The routed invocation names
   the router in `aud` and the deployment in `args.deployment`; routed
   `hello.ok` supplies both. A toolshed must verify the signature and all
   signed fields before accepting a forwarded proof. The link agent must
   attest challenge issuance, router identity, and client-context binding in a
   form the toolshed can verify. It must also attest receipt of the exact signed
   statement within the challenge's one-minute lifetime, binding it to the
   exact forwarded statement bytes, context, and claimed principal without
   trusting the worker's claimed timestamp. The toolshed checks that the
   receipt's claimed principal equals the signed issuer, verifies both
   attestations, and records accepted challenges and statement digests per
   router, link epoch, context, and principal. Later presentation to another
   assigned toolshed remains valid until the statement's lease expires. A proof
   for one router must fail through another; failover requires a new challenge
   and signature. The router accepts a challenge signature only once for a
   principal on its client connection. It may then forward that verified
   statement to assigned toolsheds for the same client context before expiry.
   Each toolshed binds the statement to one router client-context ID and permits
   at most one live backend context for it. Re-presentation for recovery
   atomically replaces the old context; presentation for another client-context
   ID is rejected. A new router-link epoch requires a new client signature. Both
   peers reject expired or malformed proofs, an `iat` beyond the bounded
   positive clock skew from attested receipt, and a client-chosen `exp` beyond
   one hour from either the signed `iat` or the attested receipt.
   The forwarding protocol in the multiplexing design must carry this evidence
   before Mode A is implemented.
2. **Authenticate the forwarding channel.** Every router has its own identity
   and key. The toolshed accepts forwarded proofs only over a mutually
   authenticated, encrypted link whose peer identity is on its router allowlist
   and matches the proof's router identity. Link authentication, key rotation,
   and revocation must be independent for each router. Revocation closes the
   router link and all its upstream connections and invalidates their tickets,
   client contexts, and sessions at the toolshed as soon as it learns of the
   revocation. No client can set a `forwarded` marker or present a router ticket
   on the public socket.
3. **Bind Mode A tickets.** A toolshed-issued upstream ticket is single-use,
   short-lived, and bound to the issuing toolshed, router identity, router-link
   epoch, and one upstream connection. It must not authenticate a client by
   itself. Ticket redemption must be atomic, and tickets must be invalidated
   when the parent link is revoked or replaced. A ticketed upstream carries no
   router-only control authority beyond its one bound client context; link
   control stays on the router link.
4. **Track client contexts at the toolshed.** A forwarded principal belongs to
   one router-authenticated client context, not to the router link in general.
   The context binds the signed proof, client connection, negotiated protocol
   flags, and any sessions opened under it. A request cannot name another
   context's principal or session. Client close and principal release must have
   defined effects on contexts and sessions. An authenticated context-close
   control operation revokes a context and its sessions; it is distinct from
   `connection.release`. Router-link loss invalidates its epoch, upstream
   connections, contexts, and sessions; restoration requires fresh client
   authentication.
5. **Bound the life of delegated authority.** Specify two distinct lifetimes: a
   single-use challenge valid for at most one minute to complete authentication,
   and an authorization lease of at most one hour for the resulting client
   context. The signed statement's `exp` can serve as the lease expiry, but the
   toolshed must enforce it after admission. The client renews with a new
   challenge and signature before expiry; forwarding the old statement must not
   extend the lease. A statement may establish one live context on each toolshed
   until its expiry, so this choice also accepts a one-hour proof-presentation
   window through its issuing router. The toolshed must expire a context and
   close or revoke its sessions when renewal fails. A router's disconnect
   assertion alone cannot prove client liveness if the router is compromised.
   In routed mode, `connection.release` prevents new session opens as that
   principal; existing sessions retain their original lease. Release is not
   revocation. A permanent renewal refusal revokes the context immediately;
   a transient failure cannot carry it past its existing `exp`.
6. **Preserve authentication ordering.** `connection.auth`, challenge renewal,
   `connection.release`, session open, and session close need a causal order
   across the per-space receive chains. A request must observe the latest
   preceding authentication or release state on its client connection. A
   rejected proof cannot leave an authenticated principal behind.
7. **Keep authorization at the toolshed.** The toolshed must derive the
   principal from its bound client context and recheck the relevant ACL and
   scope at session admission and on each protected operation, including reads,
   writes, watches, presence, and resume. The router's directory or routing
   decision is never evidence of authorization. Client-supplied `actingAs`,
   service identity, or router identity cannot enlarge a user's authority.
8. **Preserve client negotiation.** The toolshed must admit a routed client
   against that client's actual negotiated flags, including
   `stableExpressionResultIds` and any future security-relevant capability. Mode
   A's router-owned upstream `hello` cannot silently substitute the router's
   flags for the client's. If the router translates a protocol feature, its
   exact semantics and admission consequences need a verified mapping; otherwise
   it rejects the client.

## Routing and input handling

9. **Use an authoritative space directory.** The router accepts a canonical
   space DID and looks up its assigned toolshed. The directory places a DID it
   does not list by its `unlisted` rule, which derives the toolshed from the
   DID's last character and stays fixed for the deployment, and without that
   rule denies it. A client cannot supply an upstream address; choosing its DID
   selects a toolshed only through the rule, which grants no authority. Route
   changes need a fenced ownership epoch so a stale router cannot keep sending
   writes to the former owner; resume must reauthorize on the new toolshed.
10. **Treat routing metadata as untrusted.** A binary envelope's cleartext space
    DID is a routing hint. The toolshed must decompress and parse the
    authenticated message, compare its canonical `space` and session binding
    with that hint and the routed context, and reject any mismatch. The same
    comparison applies to text frames and any transformed frames. No
    authorization decision may rely on a header the client can edit.
11. **Validate at both boundaries.** Before allocating expensive state, the
    client worker and toolshed reject invalid WebSocket framing, invalid UTF-8,
    duplicate or ambiguous security fields, malformed DIDs, unsupported envelope
    versions, impossible lengths, and frames with inconsistent `space`,
    `sessionId`, `requestId`, or principal fields. Define one parser
    interpretation for JSON and binary envelopes, including compression. Unknown
    security-critical flags fail closed. Errors to unauthenticated callers
    should avoid disclosing whether a space exists.
12. **Bound work before and after authentication.** Set explicit limits for
    handshake state and duration, raw and decompressed frame sizes, expansion
    ratio, nesting depth, concurrent decompressions, principals, sessions,
    watches, holdings, queued bytes, and outstanding requests. Enforce ingress
    limits per network source and a global cap on unauthenticated workers before
    each accepted connection consumes a process; require an authentication
    deadline after TLS and HTTP upgrade. Enforce quotas per principal, client
    context, router, and toolshed after auth. Measure private memory for idle
    and active workers at expected concurrency before public deployment.
    Dropping a slow or abusive client must release its upstream and backend
    state without blocking other clients.

## Process isolation and operations

13. **Isolate content inspection.** HTTP upgrade, `Origin` checks, WebSocket
    framing, decompression, and Memory payload parsing run in a dedicated Rust
    worker process for one client connection. A worker is never reused for
    another client. No process with a router identity key, a long-term TLS key,
    or another client's application state parses those bytes. A narrow listener
    accepts client sockets and transfers exclusive custody before application
    parsing. Either the listener completes TLS with a reviewed record-layer
    handoff, or the per-client worker completes TLS with certificate signing
    delegated to a separate key process; neither path puts the certificate
    private key in a payload parser. A secret-free, single-threaded process
    creates workers from an image that has never held credentials or client
    application data. It holds no listening socket, does not read client bytes,
    and renews worker address-space layout after a bounded number of forks by
    re-exec or equivalent isolation. Each worker holds only its own client
    connection and upstream TLS sessions, cannot create or connect sockets, and
    asks a credential-free directory process for a canonical space DID rather
    than naming an upstream address. The directory process passes an
    unnegotiated TCP connection and a single-use ticket to the worker and closes
    its copy of the socket; the worker performs upstream TLS and verifies the
    toolshed. Only a separate link agent holds the router identity key, issues
    client challenges, obtains toolshed-issued tickets, and controls router
    links. The pristine process creates a narrow worker-to-link-agent IPC
    channel so the link agent can bind each challenge and proof receipt to that
    channel's client context. Broker services never trust a context ID supplied
    in a message. The link agent accepts bounded, fixed-format IPC metadata. It
    verifies the fixed-format `mra1` client statement (signature, principal,
    router, deployment, challenge, issue time and lease) before admitting a
    worker, so admission depends on no toolshed, and it parses no Memory
    payload; each toolshed still verifies the statement itself. Processes have the
    minimum network access for their roles: the listener has no egress, workers
    cannot create sockets, and the directory process can reach only the
    directory and assigned toolsheds. Network namespaces or equivalent egress
    controls and syscall filters enforce this; cgroups bound resources. Sibling
    workers cannot inspect or signal each other through process APIs, inherited
    descriptors, or shared credentials. Bound worker memory, CPU, input size,
    and IPC messages; a worker crash or timeout closes only its own client
    context. Before choosing listener-side TLS, validate exclusive descriptor
    custody and TLS post-handshake behavior on the deployment kernel and TLS
    stack. If per-client processes are too costly, a weaker isolation model
    requires a separate security review before public deployment.
14. **Isolate routers from one another.** Each router has separate credentials,
    process boundaries, state, and resource budgets. A compromised router
    process must not read another router's client traffic, proofs, tickets, or
    keys. Backend allowlists and audit records identify the particular router,
    so one router can be revoked without removing all routing.
15. **Harden the Rust boundary.** Keep `unsafe` and native-code dependencies
    small and reviewed; pin and update parser, compression, TLS, and WebSocket
    dependencies. Fuzz HTTP upgrade, WebSocket framing, JSON and binary envelope
    parsers, compression decoder, routing-hint comparison, and state
    transitions. Exercise TLS handoff and descriptor cleanup under failure
    injection. Redact signatures, tickets, challenges, and user payloads from
    logs. Record router identity, client-context ID, space, toolshed, and
    authorization verdict for incident investigation without logging private
    content.
16. **Protect ingress and egress.** Use TLS for client sockets and authenticated
    encryption for router-to-toolshed links. Validate browser WebSocket `Origin`
    against the deployed client origins, with no cookie-only authentication.
    Public clients cannot reach a toolshed's direct Memory listener or its
    router-link and ticket endpoints. Restrict router egress to configured
    toolsheds and the directory service. Health checks must not expose the
    directory, active principals, or session data.

## Public-stage acceptance gates

- A proof signed for Router A fails through Router B. One router challenge
  accepts one client submission; the resulting statement can reach several
  toolsheds but cannot establish parallel or differently named contexts on one
  toolshed or survive a router-link epoch change. Recovery atomically replaces
  the old context.
- After a routed `session.open` returns toolshed authentication metadata, a
  second key and a lease renewal still sign for the router and deployment from
  the client's `hello.ok`.
- A challenge expires within one minute; a client-chosen lease longer than one
  hour is rejected. A statement received after its challenge expired is
  rejected; one received in time may reach another assigned toolshed until its
  lease expires. Renewing with the same proof cannot extend a backend context.
- Disconnecting a client or killing its router eventually removes its backend
  authority within the documented lease; an expired proof cannot reopen it.
- A toolshed restart does not end client sessions: the router treats a refusal
  that rests on a passing condition, such as a down toolshed, an unreadable
  directory or a placement or topology change, as temporary, so clients
  reconnect and replay their pending commits. Other refusals stay permanent.
- Without an `unlisted` rule the router denies spaces the directory does not
  list. With one, a client creates a space only by holding its key, and only
  where the rule places it: a routed open of a DID with no store creates nothing
  unless that DID opens it there, only that DID may write the genesis ACL, and a
  populated space without an ACL is refused. Disk-source registration is refused
  to the router's clients and accepted elsewhere only from service DIDs.
- Incompatible client flags are rejected even when the router's upstream
  advertises compatible flags. A header/body space mismatch, ambiguous JSON, and
  a compressed expansion attack fail before any write or watch is admitted.
- A worker crash, malformed frame, or slow client affects only its own context.
  A compromised worker cannot read a sibling's memory or descriptors, reach
  arbitrary network destinations, obtain another worker's ticket, or use the
  router identity key. A compromised directory process cannot read upstream
  plaintext or confer client authority. Revoking one router ends all its backend
  contexts and sessions while other routers continue serving their own clients.
- Public ingress has a separate decision for every HTTP route; exposing the
  Memory router does not implicitly expose toolshed HTTP APIs.

Remote attestation can strengthen the router and toolshed identity checks, but
its evidence, measurements, freshness, and route binding need a separate design.
A client trusting a router to attest toolsheds is trusting the router's report;
that is not an end-to-end attestation of each toolshed by the client.
