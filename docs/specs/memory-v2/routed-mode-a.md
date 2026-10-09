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
placement and toolshed verification. The directory places a DID it does not list
by its optional `unlisted` rule, which maps the DID's last character to a
toolshed. The router reads the rule and the toolshed list once, and each
toolshed the rule and, when there is one, its own index; a snapshot that changes
them is refused until restart. Without a rule, unlisted DIDs receive the same
generic request denial after authentication. The upgrade does not reveal
directory membership. A refusal that rests on a condition that passes, such as a
toolshed that is down, an unreadable directory, a placement change or a topology
change awaiting a router restart, is temporary: a refused open is marked
`retriable`, so the SDK holds that session and retries its open on the same
connection, and a refused frame of an open session closes the connection, so the
SDK reconnects; either way it replays the session's pending commits rather than
ending the session. A first mount refused that way has no session yet, and the
SDK holds it the same: it tries the mount again on the same connection, a second
or more apart at the reconnect backoff and with no limit on how often, until the
mount is admitted or refused for good, its caller cancels it, or the client
closes or fails for good. That covers a refusal for now of the open, of the
key's statement and of a challenge for it. A connection that drops while the
mount waits is followed onto the next one; a connection that drops under a
request the mount has sent fails the mount, as in direct mode. The marker shows
whether the toolshed a DID maps to is down or saturated, not whether a space
exists or what its ACL grants; without an `unlisted` rule it also shows that a
DID is listed while its toolshed is down.

`sharedMemoryConnection` controls the runner's socket topology. Both topologies
supply a `SessionPrincipal`, so authentication follows the peer's advertised
capabilities. A routed peer always requires signed `connection.auth`; a direct
peer without that capability receives signed `session.open`. Clients learn the
router from the deployment: the shell from the page a compiled toolshed serves,
or from its API URL's `/api/meta` when the page states none or came from
another origin, such as a CDN copy; `cf`, FUSE mounts and the connector hosts
from `/api/meta`. Only Memory moves; the HTTP APIs stay on the API host, and a
host hint naming the deployment's own API host or router is the default route
and cannot move a space's Memory off the router. A host hint naming any other
origin, such as a site-table row for a space hosted elsewhere, opens that
space's Memory where that origin's deployment serves it: the client reads
`/api/meta` on the hinted origin, once per origin for the runtime's lifetime
and for at most 64 origins, and opens Memory on the `memoryUrl` it publishes,
or on the origin itself when it publishes none, while the space's HTTP work
goes to the hinted origin. An origin that publishes this client's own memory
URL is a sibling toolshed of this deployment behind the same router: the
space's HTTP work goes to it and its Memory takes the default route. The first
route a space is given is fixed for the runtime's lifetime. A hinted origin
whose memory host cannot be learned leaves its spaces on no route, warned about
once: the client's own router is not where another deployment keeps its spaces,
so it is never the fallback. A deployment rolls the router out in this order:

1. Install routed-capable clients and toolsheds with sharing off.
2. Give the router its own hostname, set it as every toolshed's
   `MEMORY_PUBLIC_URL`, and restart the toolsheds.
3. Verify that clients open dedicated connections to the router: in a browser,
   the shell's `/api/storage/memory` WebSocket connects to the router's
   hostname, and `cf acl ls --space <space>` run against the API URL succeeds
   while the app host's access log shows no Memory upgrade from it.
4. Enable sharing: set `EXPERIMENTAL_SHARED_MEMORY_CONNECTION=true` on every
   toolshed and restart them. The flag is server-authoritative, so `cf`, FUSE
   mounts and the connector hosts adopt it from `/api/meta`, and the shell
   adopts it from the page a compiled toolshed serves, or from `/api/meta`
   when the page states nothing or came from another origin, as it does the
   memory URL. No shell build changes: a release build leaves the build
   define of the same name unset, and the same binary serves a deployment
   that routes by space with sharing off. A shell tab opened before the
   restart keeps the value its page carried until it reloads.

   The toolshed's own runtime (webhooks, ingest, pattern lifecycle, OAuth
   token cells) does not follow the flag: it opens Memory on `MEMORY_URL`, a
   route that sends `?space=<DID>` to the toolshed owning the space, and a
   shared connection names no space, lands on whichever toolshed the route
   defaults to, and is refused for every space that toolshed does not own.
   So its storage manager always dials dedicated connections
   (`createToolshedRuntime` in `packages/toolshed/runtime-options.ts`), and
   the toolsheds installed in step 1 must include that behavior; the flag
   they publish on `/api/meta` is unchanged.
5. Close public ingress to `/api/storage/memory`: stop the app host
   forwarding it to the toolsheds, and close the toolsheds' public direct
   Memory listeners (see the infra router README), once the app host's access
   log has shown no WebSocket upgrade on `/api/storage/memory` for seven
   days. Until then some clients still open Memory on the API host: `cf`
   binaries and connector hosts built before the memory URL existed, CDN
   shell copies built before it, shell tabs opened before step 2, and any
   client that could not read `/api/meta` when it started, which logs a
   `[deployment-meta]` warning naming the API host. A client that only signs
   direct session opens cannot use the router at all, so it is one of these
   until it is updated.

   The toolsheds' own runtimes still open Memory on `MEMORY_URL` (step 4),
   so this step keeps a loopback-only route to the direct listeners,
   reachable from the toolshed host alone, that sends `?space=<DID>` to the
   toolshed owning the space; the direct listener shares the toolshed's main
   HTTP port, so it is closed per route, not per port. Pointing `MEMORY_URL`
   at the router instead, which makes the toolsheds routed clients of it and
   lets the direct route close completely, is the longer-term shape
   (infra#244).

Each dedicated socket consumes its own isolated worker and source-admission
slot. A retriable reopen denial holds only its session, which retries on the
same connection, so on a shared socket one toolshed that is down does not stall
the other spaces.

The router issues a challenge through its link agent's channel-assigned context.
A client completes it within 60 seconds. The agent verifies the fixed-format
signed statement itself before admitting the worker, hashes its exact bytes and
signs issuance and receipt evidence; its fixed-format IPC never interprets
public Memory values. The toolshed verifies the client signature, issuance
signature, receipt signature, exact statement/issuance digests, claimed
principal, router, deployment, epoch, context and timestamps. The statement's
expiry cannot exceed ten minutes (600 seconds) after either client issue or
attested receipt. The router refuses a longer lease for good
(`lease-too-long`) rather than disconnecting the client, and a toolshed refuses
one by closing the context, so the labs SDK, which asks for ten minutes, ships
first, then the router, then the toolsheds. No router that admits an hour is in
service: the rehearsal is the only deployment. Positive client skew is bounded
to 120 seconds; the router answers a refusal that honest timing, clock skew
within that bound or load can cause, and the router README lists each.

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
| operation 3               | context ID; closes the context and its sessions and drops the statements it accepted; a later open may use that ID again                     |
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
or delegation ACL entries. A space is created by its own key, as
`StorageManager.createSpace` does, and only on the toolshed the `unlisted` rule
places it on: a routed open of a DID with no store is refused, before a store is
created, unless the space's own DID opens it there, so a listed space whose
store has not arrived is never re-created empty. Until its genesis ACL lands,
that DID is the space's only principal and may commit only the ACL, carrying the
genesis declarations (`genesisRoot`, `spaceKind`) its signed open declared. A
space with history but no valid ACL is refused to everyone but a service DID,
which may give it an ACL or repair an invalid one, as in direct mode, so legacy
spaces can be given ACLs after cutover. Routed connections refuse
`sqlite.register-disk-source`, an operator request, and in Mode A other
connections accept it only from a service DID. Principal leases are admitted
into the existing Server connection authority; each session and protected engine
turn rechecks its bound connection, lease, ownership and ACL. Checks after
asynchronous waits retain the originating session object, so resumed sessions
cannot authorize an old queued write. Data frames are serialized through the
protected Memory turn, retaining their queue budget until it ends.

The durable ledger records only what must outlive a restart: link epochs and
router-key revocations. It exclusively locks a separate inode, fsyncs each
change before acknowledging it and fsyncs the parent directory on creation or
atomic compaction. A link epoch cannot be reused while it is recorded: while its
link lives, and for 780 seconds after the link closes (the longest lease plus
the challenge lifetime and clock skew). Links do not survive a restart, so a
restart retires every live epoch and rewrites the file to what it holds. After
that period every proof bound to the epoch has expired, so forgetting it frees
the 1,024-epoch bound without reviving authority. Key revocation remains
permanently denied after toolshed restart.

Each principal/challenge and exact client digest binds to one live context of
one router: exact repeats within that context are idempotent, and re-signed
router evidence cannot move them to another live context. Release tombstones
prevent replay from reinstating new-open authority while the context lives; a
fresh client signature can reauthorize. These bindings are held in memory with
their context and dropped when it closes, when its link closes, and on a
toolshed restart. A closed context ID may open again at once: its statements
left with it, so refusing it would protect nothing.

This departs from the router design, which kept every accepted statement in the
ledger until it expired, closed context or not. A compromised router can already
keep a disconnected client's authority until its lease ends by holding the
client's contexts open (see the trust boundary in the router security
requirements). Keeping a closed context's statements protected only where
something outside that router closed the context: link loss, a toolshed restart
or an operator, and any client could fill the ledger that kept them by cycling
connections. The longest lease is ten minutes rather than an hour, which
shortens the compromised-router window sixfold. The remaining window is an
unenforced trust dependency on the router: a compromised router can re-present a
closed context's statement, in a new context or on a new link epoch, for the
rest of that statement's ten-minute lease. No toolshed check prevents it.

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
versions, mismatched hints and gzip expansion/CRC/member violations. A frame's
JSON is at most 64 levels deep and at most `limits.frameSlots` values, counted
as the router counts them: one slot per value, whether scalar, object or array,
with keys free. The default, 150,000, is the router's default `max_frame_slots`,
sized from the largest measured sync frame (119,720 slots) against the router
worker's memory. The router and the toolshed close the socket a frame over the
cap arrives on; the SDK refuses to send one and closes on receiving one. The
slot cap exists for the router worker's memory; a toolshed's own exposure to one
frame is bounded by the byte caps (8 MiB raw, 16 MiB expanded, 4 MiB queued per
data socket). A whole-space sync still exceeds any per-frame cap (the largest
rehearsal stores are 7 to 29 million slots as one frame) and needs chunking
(infra#244). Context, principal, router and toolshed quotas cover sessions,
watches and holdings; resource bounds and exact values are in the infra router
README.

## Toolshed deployment inputs

`MEMORY_ROUTER_CONFIG_FILE` opts in to a strict tracked policy with version 1,
deployment, private bind hostname/port, certificate/key paths, shared
authoritative directory, durable epoch ledger and per-router DID/network-peer
allowlists. An optional `limits` object sets the toolshed's capacity
(`RoutedHostLimits` in `routed-host.ts`); absent fields take defaults sized for
the proof of concept. The values must be positive integers that nest from
context to router to toolshed, a context's proofs must cover its principal
history and a renewal for each active principal, and every allowed router's
contexts must fit the sockets and tickets at once (`routedHostLimitsFor`); a
limit that fails, or one the toolshed does not know, is named in the error.
`frameSlots` is the one limit the router must match rather than cover:
`max_frame_slots == frameSlots`, a check for the infra preflight beside the
limits it compares already, and the SDK sends and accepts at most
`ROUTED_FRAME_SLOTS` (150,000), which must not exceed either. The infra router
README's capacity section has the arithmetic and maps each limit to the
router's.

The toolshed answers one request it refuses and leaves the data socket open.
A request over a session, watch (views included) or holdings limit, or one
whose principal's grant expired after the router forwarded it, is denied
marked `retriable`, so the client holds the session and tries again; a request
for a session the toolshed revoked, or a principal it released, after the
router forwarded it is denied for good, as is a watch mutation that would
leave a session with more than 1,024 watch IDs or 64 views (`frame-limit`).
Each is logged in the toolshed's own journal, never the router's, as a
`routed-memory-verdict` with verdict `request-refused` and reason
`session-limit`, `watch-limit`, `holdings-limit`, `frame-limit`,
`principal-expired`, `session-not-held` or `principal-not-held`. A frame that
itself names more than 1,024 watches or 8,192 holdings, and a request whose
`holdings` or `views` is not a JSON list, are malformed and are not answered:
each closes the socket, as the router closes the client's connection on one.
A proof is refused with verdict `proof-denied` and reason `proof-limit`,
`principal-limit` or `principal-history-limit`, and the refusal closes its
context, which ends the client's connection. The proofs live contexts hold are
bounded by the routers, `contextsPerLink` and `proofsPerContext`. An earlier
toolshed's ledger also held `claim` lines; this one drops them when it loads,
and an earlier toolshed reads this one's `epoch`, `retire` and `revoke` lines,
so rolling either way needs no change to the file: every toolshed bounds the
file at 32 MiB, and this one rewrites it without the claim lines as it loads.
Directory storage and
`MEMORY_ACL_MODE=enforce` are mandatory.
The cell representation follows the deployment's `EXPERIMENTAL_MODERN_CELL_REP`
setting, which every toolshed, every client and the router's `modern_cell_rep`
must share: the router refuses a toolshed link at the other representation, and
the toolshed's handshake refuses a client at it. Only the legacy representation
is usable in Mode A today. The modern one is unfinished: a pattern binding a
stored link fails ("Cannot yet handle FabricLink"), and `Runtime.dispose` resets
the process-global flag to legacy, so a toolshed configured modern switches to
legacy once it disposes an idle serving runtime. It is unsupported until that
work lands. `MEMORY_PUBLIC_URL` names the router's public origin, the same on
every toolshed, which clients open Memory on (see the configuration reference).
The policy initializes the Memory encoder from that setting before listening;
Runtime startup reads the same flag. Only owned spaces open a Memory session:
explicit-ACL spaces, and a space with no history to its own DID. The toolshed's
HTTP routes, such as blobs and invitations, open a space without checking
ownership, so moving a space blocks them first (see the infra router README). A
routed connection is never sent `session/admissible` (see [the
protocol](04-protocol.md)): the toolshed records no refusal on it, so a routed
client refused for want of `READ` learns of a later grant only by opening the
session again. Directory epoch changes fence protected turns and close affected
contexts. Remove a router from its tracked allowlist and restart for immediate
permanent policy withdrawal; in-process `revokeRouter` also persists a key
tombstone. Production secrets come from managed credentials, and public firewall
policy must block direct Memory/private endpoints and independently decide every
toolshed HTTP route. `MEMORY_URL`, which the toolshed's own runtime opens
Memory on, names a route that sends each space to the toolshed owning it, and
the toolshed reaches it with dedicated connections whatever the deployment's
sharing flag says (rollout steps 4 and 5).

`test/routed-router.exercise.ts` is a disposable Linux CLI driven by the Rust
repository's CI; it uses two real SQLite toolsheds and the actual SDK. Unit
tests cover exact crypto records, parser failures, durable replay custody,
router revocation isolation and queued protected turns. This test support does
not establish that an existing public deployment is eligible or has been
changed.
