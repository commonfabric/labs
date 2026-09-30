# Memory Router Security Requirements

## Status and scope

Proposed requirements for the router phases of the
[Memory connection multiplexing design](../specs/memory-v2/connection-multiplexing.md).
The router phases are proposed. They depend on the direct connection-auth
protocol described in that design. The first public stage serves existing spaces
through one client WebSocket that can reach several toolsheds. It uses the
design's Mode A: one upstream connection per client per toolshed. Mode B needs a
separate security review before deployment.

This stage assumes that space creation is restricted, spaces have the intended
access-control documents, and no legacy spaces are served. Those are deployment
prerequisites, not properties established by the router. The router protects
Memory WebSockets; public HTTP routes need their own ingress and authorization
review.

## Trust boundary

The client authenticates a principal by signing a fresh challenge issued by the
router. The router terminates the client socket and can read, modify, omit, and
inject all later messages. The toolshed verifies the client signature and trusts
an allowlisted router only for challenge freshness and the binding between a
client connection and its forwarded requests. The toolshed remains the authority
for space ACLs, session admission, and every operation. A router identity grants
no space capability, service identity, or ability to bypass ACL checks.

Consequently, compromise of a router permits acting as its authenticated clients
while their backend contexts remain valid. Process isolation limits which router
can be compromised; it does not make traffic through a compromised router
end-to-end authenticated. This authority must be represented explicitly in the
threat model and operational response. With the one-hour lease proposed below,
compromise can preserve a disconnected client's authority for the remainder of
that hour.

## Authentication and authorization

1. **Bind each proof to one router.** `connection.auth` must sign the protocol,
   deployment audience, router identity, router-issued unpredictable challenge,
   principal, issue time, and expiry. A toolshed must verify the signature and
   all these fields before accepting a forwarded proof. A proof for one router
   must fail through another; failover requires a new challenge and signature.
   The router accepts a challenge signature only once for a principal on its
   client connection. It may then forward that verified statement to assigned
   toolsheds for the same client context before expiry. Each toolshed binds the
   statement to one router client-context ID and permits at most one live
   backend context for it. Re-presentation for recovery atomically replaces the
   old context; presentation for another client-context ID is rejected. A new
   router-link epoch requires a new client signature. Both peers reject expired,
   future-dated, or malformed proofs and a client-chosen `exp` beyond the
   deployment's maximum authorization lease.
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
   when the parent link is revoked or replaced.
4. **Track client contexts at the toolshed.** A forwarded principal belongs to
   one router-authenticated client context, not to the router link in general.
   The context binds the signed proof, client connection, negotiated protocol
   flags, and any sessions opened under it. A request cannot name another
   context's principal or session. Client close and principal release must have
   defined effects on contexts and sessions. Router-link loss invalidates its
   epoch, upstream connections, contexts, and sessions; restoration requires
   fresh client authentication.
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
   `connection.release` must define what happens to existing sessions; if they
   remain open, release cannot serve as revocation.
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
   space DID, looks up its assigned toolshed, and denies unknown spaces in this
   public stage. A client cannot supply an upstream address. Route changes need
   a fenced ownership epoch so a stale router cannot keep sending writes to the
   former owner; resume must reauthorize on the new toolshed.
10. **Treat routing metadata as untrusted.** A binary envelope's cleartext space
    DID is a routing hint. The toolshed must decompress and parse the
    authenticated message, compare its canonical `space` and session binding
    with that hint and the routed context, and reject any mismatch. The same
    comparison applies to text frames and any transformed frames. No
    authorization decision may rely on a header the client can edit.
11. **Validate at both boundaries.** Before allocating expensive state, the
    router and toolshed reject invalid WebSocket framing, invalid UTF-8,
    duplicate or ambiguous security fields, malformed DIDs, unsupported envelope
    versions, impossible lengths, and frames with inconsistent `space`,
    `sessionId`, `requestId`, or principal fields. Define one parser
    interpretation for JSON and binary envelopes, including compression. Unknown
    security-critical flags fail closed. Errors to unauthenticated callers
    should avoid disclosing whether a space exists.
12. **Bound work before and after authentication.** Set explicit limits for
    handshake state and duration, raw and decompressed frame sizes, expansion
    ratio, nesting depth, concurrent decompressions, principals, sessions,
    watches, holdings, queued bytes, and outstanding requests. Enforce quotas
    per network source before auth and per principal, client context, router,
    and toolshed after auth. Dropping a slow or abusive client must release its
    upstream and backend state without blocking other clients.

## Process isolation and operations

13. **Isolate content inspection.** Run untrusted JSON and compressed-frame
    parsing in restricted Rust worker processes. Workers have no router or
    toolshed signing keys, no other client's traffic, no direct toolshed or
    directory write access, and only the file and network access needed for
    their task. The broker keeps authenticated connection state and treats
    worker output as an untrusted parse result. Bound worker memory, CPU, input
    size, and IPC messages; a worker crash or timeout closes affected client
    contexts without exposing another router's traffic.
14. **Isolate routers from one another.** Each router has separate credentials,
    process boundaries, state, and resource budgets. A compromised router
    process must not read another router's client traffic, proofs, tickets, or
    keys. Backend allowlists and audit records identify the particular router,
    so one router can be revoked without removing all routing.
15. **Harden the Rust boundary.** Keep `unsafe` and native-code dependencies
    small and reviewed; pin and update parser, compression, TLS, and WebSocket
    dependencies. Fuzz the JSON and binary envelope parsers, compression
    decoder, routing-hint comparison, and state transitions. Redact signatures,
    tickets, challenges, and user payloads from logs. Record router identity,
    client-context ID, space, toolshed, and authorization verdict for incident
    investigation without logging private content.
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
- A challenge expires within one minute; a client-chosen lease longer than one
  hour is rejected; renewing with the same proof cannot extend a backend
  context.
- Disconnecting a client or killing its router eventually removes its backend
  authority within the documented lease; an expired proof cannot reopen it.
- The router denies unknown spaces in this public stage, and a client cannot
  select a toolshed or create a space by choosing a new DID.
- Incompatible client flags are rejected even when the router's upstream
  advertises compatible flags. A header/body space mismatch, ambiguous JSON, and
  a compressed expansion attack fail before any write or watch is admitted.
- A worker crash, malformed frame, or slow client affects only its bounded
  contexts. Revoking one router ends all its backend contexts and sessions while
  other routers continue serving their own clients.
- Public ingress has a separate decision for every HTTP route; exposing the
  Memory router does not implicitly expose toolshed HTTP APIs.

Remote attestation can strengthen the router and toolshed identity checks, but
its evidence, measurements, freshness, and route binding need a separate design.
A client trusting a router to attest toolsheds is trusting the router's report;
that is not an end-to-end attestation of each toolshed by the client.
