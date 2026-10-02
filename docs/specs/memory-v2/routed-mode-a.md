# Routed Memory Mode A

The opt-in private listener implements the public-stage forwarding contract. The
Rust router lives in `commonfabric/infra/memory-router`; its companion revision
selects this Labs implementation. Both repositories and their main-built
artifacts must pass the deployment gates before public exposure. Mode B and
remote workload attestation are separate proposed phases.

The direct protocol in [04-protocol.md](04-protocol.md) stays unchanged. Routed
clients use its `hello`, `connection.challenge`, `connection.auth`,
`connection.release`, sessions and Memory operations, with these differences:

- `hello.ok` advertises `routedAuthV1:true` and provides router DID audience,
  deployment, random hex challenge and expiry in `sessionOpen`. The SDK pins
  those connection values across later toolshed `session.open` responses.
- `connection.auth` carries `{statement: BASE64URL}`: an unpadded canonical
  base64url signed `mra1` record. Its principal, command, audience, protocol,
  deployment, challenge, issue time and expiry all participate in the signature.
- Routed binary compression uses `mcmp` version 2, a big-endian expanded length,
  two-byte space-hint length, canonical DID bytes and one minimal gzip member.
  Version 1 has no routing hint and is refused. Uncompressed `fvj1` text still
  uses the Fabric codec after strict JSON validation. Compression is negotiated
  per hop: the router compresses frames to a client that negotiated it, and
  router-to-toolshed data sockets stay uncompressed.
- The router pings a quiet client and closes the connection when no frame
  answers, so a vanished client releases its worker.

The public endpoint accepts `/api/storage/memory` for shared connections and
`/api/storage/memory?space=<DID>` for dedicated connections. The optional query
contains exactly one `space` parameter with a canonical Ed25519 DID, including
the percent-encoded form emitted by `URLSearchParams`. Repeated parameters,
additional fields and malformed escapes are refused. A dedicated socket denies
frames naming another space. The URL grants no authority and never selects a
private endpoint: each space frame still requires authoritative directory
admission and toolshed verification. Unknown DIDs receive the same generic
request denial after authentication; the upgrade does not reveal directory
membership.

`sharedMemoryConnection` controls the runner's socket topology. Both topologies
supply a `SessionPrincipal`, so authentication follows the peer's advertised
capabilities. A routed peer always requires signed `connection.auth`; a direct
peer without that capability receives signed `session.open`. A deployment can
install routed-capable clients and toolsheds with sharing off, move Memory
WebSockets from nginx to this router, verify dedicated connections, then enable
sharing. Clients that only sign direct session opens require an SDK update
before that switch. Each dedicated socket consumes its own isolated worker and
source-admission slot.

The router issues a challenge through its link agent's channel-assigned context.
A client completes it within 60 seconds. The agent verifies the fixed-format
signed statement itself before admitting the worker, hashes its exact bytes and
signs issuance and receipt evidence; its fixed-format IPC never interprets
public Memory values. The toolshed verifies the client signature, issuance
signature, receipt signature, exact statement/issuance digests, claimed
principal, router, deployment, epoch, context and timestamps. The statement's
expiry cannot exceed one hour after either client issue or attested receipt.
Positive client skew is bounded to 120 seconds.

Each toolshed link has its own epoch, fresh for every connection, and a
toolshed checks a proof only against its own link. A challenge records the
link epochs live when it was issued, and the agent signs a separate issuance
and receipt for each, so one client signature serves several toolsheds. A
failed link is replaced with a new epoch; its toolshed closes the contexts it
held, and only clients with sessions there reconnect. A statement signed
before a toolshed's current link cannot reach it: the router pushes
`connection/challenge` and holds that `session.open` until the client signs
again. An open on a toolshed whose link is down is refused alone.

## Canonical binary records

Domains are the four ASCII bytes below. `text` is a two-byte big-endian length
followed by 1–256 printable ASCII bytes, `blob` a two-byte length and at most
4096 bytes, `time` an eight-byte big-endian safe unsigned Unix second, IDs are
16 bytes and challenges/digests/tickets 32 bytes. A signed record appends the
64-byte Ed25519 signature of **all preceding bytes**. DIDs must be canonical,
non-small-order Ed25519 `did:key` values. Trailing bytes and alternate encodings
are refused. No field accepts a Fabric tagged-value interpretation.

| Domain                    | Ordered fields before signature, if any                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `mra1` signed by client   | principal text, `connection.auth` text, router audience text, `memory` text, deployment text, challenge, iat time, exp time                  |
| `mrc1` signed by router   | deployment text, router text, epoch ID, context ID, challenge, issued time, expires time                                                     |
| `mrr1` signed by router   | SHA-256 of signed issuance, principal text, SHA-256 of exact signed statement, received time                                                 |
| `mrp1`                    | statement blob, signed issuance blob, signed receipt blob                                                                                    |
| `mlh1` signed by toolshed | toolshed DID text, nonce, issued time, supported flags blob                                                                                  |
| `mlc1` signed by router   | deployment text, router DID text, toolshed DID text, epoch ID, nonce                                                                         |
| `mlo1`                    | authenticated-link acknowledgement; no fields                                                                                                |
| `mlq1`                    | strictly increasing sequence time, operation byte, payload blob                                                                              |
| `mls1`                    | sequence time, status byte (`0` success), payload blob                                                                                       |
| `mat1`, operation 1       | context ID, actual client flags blob, space DID text, ownership epoch time; returns ticket                                                   |
| `map1`, operation 2       | ticket, proof blob                                                                                                                           |
| operation 3               | context ID; revokes context/sessions and prevents reopening that ID                                                                          |
| `mrl1`, operation 4       | context ID, principal text; releases new-open authority                                                                                      |
| `mas1`, operation 5       | context ID, space DID text, ownership epoch time                                                                                             |
| `mvp1`, operation 6       | context ID, actual client flags blob, proof blob; verifies initial auth without space admission                                              |
| `mdh1` signed by toolshed | toolshed DID text, data-socket nonce, issued time                                                                                            |
| `mdb1` signed by router   | router DID text, deployment text, toolshed DID text, epoch ID, context ID, ticket, socket nonce, socket-issued time, SHA-256 of actual flags |

The authenticated TLS link accepts only an allowlisted router key and network
peer. A single-use 15-second ticket is owned by that link epoch and context. The
data socket first receives `mdh1`; the worker obtains `mdb1` over its own agent
capability, then sends `hello` with `routerTicket` hex and `routerBinding`
base64url. The toolshed rechecks the live ticket after signature verification
and atomically consumes it. Client flags are canonical sorted JSON, with exactly
the client's negotiated values. A ticket confers no principal or space authority
by itself. Link control is never accepted on a data socket.

## Toolshed authority and lifecycle

`RoutedMemoryHost` requires `acl.mode=enforce`, explicit ACL documents and an
ownership fence. It rejects router DIDs as principals and forbids router service
or delegation ACL entries. Principal leases are admitted into the existing
Server connection authority; each session and protected engine turn rechecks its
bound connection, lease, ownership and ACL. Checks after asynchronous waits
retain the originating session object, so resumed sessions cannot authorize an
old queued write. Data frames are serialized through the protected Memory turn,
retaining their queue budget until it ends.

The durable ledger exclusively locks a separate inode, fsyncs authority changes
before acknowledging them and fsyncs the parent directory on creation or atomic
compaction. A link epoch cannot be reused while it is recorded: while its link
lives, for 3,780 seconds after the link closes (the longest lease plus the
challenge lifetime and clock skew), and while any unexpired claim names it.
Links do not survive a restart, so a restart retires every live epoch. After
that period every proof bound to the epoch has expired, so forgetting it frees
the 1,024-epoch bound without reviving authority.

Each principal/challenge and exact client digest binds to one
router, deployment, epoch and context. Exact repeats within the same active
context are idempotent. Re-signed router evidence cannot move them to another
context or epoch. Release tombstones prevent replay from reinstating new-open
authority; a fresh client signature can reauthorize. Closed contexts cannot
reopen under the same link ID until every statement they could hold has
expired (3,780 seconds), and their proofs are tombstoned through expiry.
Key revocation remains permanently denied after toolshed restart.

Release leaves existing sessions on their original lease. Renewal with a fresh
challenge extends current principal sessions; replaying an old statement cannot
extend them. Expiry or context/link closure removes routed session state and
watches immediately. Valid same-context data recovery atomically closes its old
socket/backend and requires a full interest restore. A new public connection
uses new client signing. Until detached-session handling exists, the Rust router
uses section 5.2's permitted whole-public-connection close on upstream loss.

The private listener uses TLS 1.3 and bounded `ws` framing before application
parsing. It exposes only `/memory/router-link` and `/memory/router-data`, and
serves no toolshed HTTP API. Both boundaries reject duplicate JSON keys,
ambiguous security tags, invalid UTF-8/DIDs, unknown critical flags, unsupported
versions, mismatched hints and gzip expansion/CRC/member violations. Context,
principal, router and toolshed quotas cover sessions, watches and holdings;
resource bounds and exact values are in the infra router README.

## Toolshed deployment inputs

`MEMORY_ROUTER_CONFIG_FILE` opts in to a strict tracked policy with version 1,
deployment, private bind hostname/port, certificate/key paths, shared
authoritative directory, durable epoch ledger and per-router DID/network-peer
allowlists. Directory storage, `MEMORY_ACL_MODE=enforce` and
`EXPERIMENTAL_MODERN_CELL_REP=true` are mandatory. The policy initializes the
Memory encoder before listening; Runtime startup reads the same required flag.
Only already-owned, explicit-ACL spaces can open. Directory epoch changes fence
protected turns and close affected contexts. Remove a router from its tracked
allowlist and restart for immediate permanent policy withdrawal; in-process
`revokeRouter` also persists a key tombstone. Production secrets come from
managed credentials, and public firewall policy must block direct Memory/private
endpoints and independently decide every toolshed HTTP route.

`test/routed-router.exercise.ts` is a disposable Linux CLI driven by the Rust
repository's CI; it uses two real SQLite toolsheds and the actual SDK. Unit
tests cover exact crypto records, parser failures, durable replay custody,
router revocation isolation and queued protected turns. This test support does
not establish that an existing public deployment is eligible or has been
changed.
