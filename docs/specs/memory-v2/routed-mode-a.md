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
- The optional public `hello.ok.routerFrameSlots` advertises the deployment's
  JSON value-count cap: `null` disables counting, and a positive JavaScript safe
  integer sets a custom cap. An absent field uses 150,000 for peers that omit
  it. The SDK learns the cap from each hello and applies it to both sent and
  received routed frames, including compressed and streamed messages. Closing
  or resetting the transport restores the default; a replacement connection
  learns its own cap. Byte, nesting, duplicate-key and DID checks remain active
  when counting is disabled.
- The router does not refuse a client whose capabilities omit
  `stableExpressionResultIds`: such a client is granted a context, a ticket
  and a data socket, and the toolshed answers each of its `session.open`
  requests with the final `SessionRevokedError` refusal of
  [04-protocol.md](04-protocol.md), which the SDK treats as terminal for that
  session.
- `connection.auth` carries `{statement: BASE64URL}`: an unpadded canonical
  base64url signed `mra1` record. Its principal, command, audience, protocol,
  deployment, challenge, issue time and expiry all participate in the signature.
- Routed binary compression uses `mcmp` version 2, a big-endian expanded length,
  two-byte space-hint length, canonical DID bytes and one minimal gzip member.
  Version 1 has no routing hint and is refused. Uncompressed `fvj1` text still
  uses the Fabric codec after strict JSON validation. When the client
  negotiated both `messageCompressionV1` and `routedCompressionV1`, its streamed
  uploads and the toolshed's responses carry messages of 1 KiB or more that
  gzip makes smaller in this envelope, end to end: the record header says
  `binary:true`, the toolshed or the SDK expands the body,
  and the router expands only the controls it reads (`connection.*`,
  `memory.compression`, `session.open`, `session.watch.*`). The sender keeps a
  message as text when it is under 1 KiB, over the 16 MiB expanded bound,
  would pass the 32-times expansion bound, or gzip would not make it smaller.
  The router answers `memory.compression` itself, for every toolshed on the
  connection, and its reply governs only the client's uploads: `enabled` is
  what the client asked for, if the compression its framing uses was
  negotiated. Toolsheds keep compressing their bodies to a client that
  negotiated both capabilities whatever it asks, and the client expands them
  either way; a direct host's reply also sets its own send mode. `routedCompressionV1` is a public
  capability the SDK offers only with streaming, toolsheds advertise on their
  signed link, and the router's offer carries; a client without it, such as an
  SDK that predates it, receives text bodies, since it would take a binary body
  on a credited connection for router credit. Legacy public uploads may use the
  envelope too, and the router expands them.
- The router offers `routerTransport:1` and `routerUploadWindow:262144` in
  `hello.ok`. A supporting client selects
  `fvj1:{"type":"router.transport","version":1,"uploadCredits":true}` as text
  before authentication, on the same ordered send queue as its requests. Every
  subsequent logical Memory upload, including authentication, compression
  controls, session opens and watch mutations, uses the `mrt\x01` records
  described below (at most 32 KiB of body per record, at most 512 records per
  message). The router assembles control messages completely and applies their
  byte, slot and admission limits before processing them; ordinary data is
  forwarded incrementally.
- The upload window counts complete on-wire record bytes, including the header,
  each chunk's five-byte prefix and the completion record. The client charges
  each record before sending it and waits for enough credit for the entire next
  record. The router returns additive binary acknowledgements for accepted
  record bytes, possibly coalesced. Each is exactly eight bytes: magic
  `6d 72 63 01` (`mrc\x01`; the ASCII `mrc1` tag names the signed challenge
  issuance record, a different format), then a four-byte unsigned big-endian
  credit amount. The amount must be positive and no greater than the client's
  outstanding sent bytes. Unsolicited or invalid credits close the connection.
  Text `router.credit` messages cannot grant credit and close the connection.
  The router forwards a private upstream body with `binary:true` only to a
  client that negotiated both `messageCompressionV1` and
  `routedCompressionV1`, and only once its first record opens with
  the envelope's `mcmp\x02`; otherwise it fails the upstream before emitting a
  public fragment. Binary public frames are therefore credit or a compression
  envelope, told apart by their first bytes, and no body can impersonate a
  credit. The SDK takes a binary frame that does not open with `mcmp` as credit,
  before Memory or compression decoding, and accepts windows
  from 32,773 through 262,144 bytes. Credit acknowledges receipt, not Memory
  execution, and provides the event that permits a browser's native send queue
  to drain. The SDK retains its separate 4 MiB native queue cap. Closing,
  resetting or replacing the socket rejects blocked uploads and discards credit;
  credit and writes never transfer to a replacement connection.
- Initial client hellos remain compatible with routers that do not offer
  streaming. A streaming router without a supported upload window is selected
  with `fvj1:{"type":"router.transport","version":1}`. That mode streams ordinary
  data and sends control messages as complete public envelopes, with the same
  limits.
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
request the mount has sent fails the mount, as in direct mode. Nothing else
ends the wait, and some refusals for now clear only when the client itself
gives something up: a connection at its session limit or its principal limit
stays there while the client keeps its sessions open and its keys renewed. A
mount made without a cancellation signal, as the runner's `createSpace` and
`spaceKind` make theirs, then waits until the client closes. The marker shows
whether the toolshed a DID maps to is down or saturated, not whether a space
exists or what its ACL grants; without an `unlisted` rule it also shows that a
DID is listed while its toolshed is down.

A failed data handshake is retriable on the same connection only before the
link agent issues its signed `rdb1` binding. The worker then releases its broker
assignment through the acknowledged internal rollback described below. Once a
binding has been issued, a failed hello or transport closes the public
connection: the signature may already have redeemed its single-use ticket, so
the worker cannot authorize a second binding by reporting failure.

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
The SDK shares a challenge among at most 32 different keys, including keys
released before it expires. The router's `max_principals_per_challenge` must
therefore be at least 32; configuration validation and preflight enforce this.
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
service: the rehearsal is the only deployment. Positive client skew is allowed
up to 120 seconds; the router answers a refusal that honest timing, clock skew
within that allowance or load can cause, and the router README lists each.

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
| `rph1` signed by toolshed | toolshed DID text, nonce, issued time, supported flags blob including required private `routerEncodingNegotiation: true` and `routerRequestCredit: true` |
| `rpc1` signed by router | deployment text, router DID text, toolshed DID text, epoch ID, nonce, one byte `0x01` asserting request-admission support |
| `rpo1` | authenticated private protocol v1 acknowledgement; no fields |
| `mlq1`                    | strictly increasing sequence time, operation byte, payload blob                                                                              |
| `mls1`                    | sequence time, status byte (`0` success), payload blob                                                                                       |
| `mat1`, operation 1       | context ID, actual client flags blob, space DID text, ownership epoch time; returns ticket                                                   |
| `map1`, operation 2       | ticket, proof blob                                                                                                                           |
| operation 3               | context ID; closes the context and its sessions and drops the statements it accepted; a later open may use that ID again                     |
| `mrl1`, operation 4       | context ID, principal text; releases new-open authority                                                                                      |
| `mas1`, operation 5       | context ID, space DID text, ownership epoch time                                                                                             |
| `mvp1`, operation 6       | context ID, actual client flags blob, proof blob; verifies initial auth without space admission                                              |
| `rdh1` signed by toolshed | toolshed DID text, data-socket nonce, issued time |
| `rdb1` signed by router | router DID text, deployment text, toolshed DID text, epoch ID, context ID, ticket, socket nonce, socket-issued time, SHA-256 of canonical original client flags, SHA-256 of canonical `negotiatedMemoryFlags` |

The authenticated TLS link accepts only an allowlisted router key and network
peer. A single-use 15-second ticket is owned by that link epoch and context. The
data socket first receives `rdh1`; the worker obtains `rdb1` over its own agent
capability, then sends plain JSON `router.hello` with `version:1`, the original
client's `memoryFlags`, a separate `negotiatedMemoryFlags` descriptor,
`routerRequestCredit: true`, `routerTicket` hex and `routerBinding` base64url.
Both flag hashes in `rdb1` are
mandatory, in the order above: the original-flag hash precedes the selected
descriptor's hash, followed by the signature. Each hashes compact UTF-8 JSON
with lexicographically sorted object keys and array members in their declared
order. The selected descriptor's string sets retain public-offer order.

The toolshed validates the descriptors and both signed hashes before binding
the data socket, consuming its ticket, or replacing an existing backend. After
signature verification yields, it rechecks the live ticket and endpoint support
before atomically consuming the ticket. Missing descriptors or hashes, a
selected capability outside the client or endpoint offer, a cell-mode mismatch,
private flags in the selected descriptor, or a hash mismatch reject the data
handshake without replacing the backend. A ticket confers no principal or space
authority by itself. Link control is never accepted on a data socket.

### Private transport version and streaming records

The signed `rph1`, `rpc1`, `rdh1` and `rdb1` domains select private router
protocol version 1 independently of the Memory API. Unsupported domains fail
before authentication or ticket redemption. The binary, router-signed `rpc1`
record includes exactly one request-admission byte, `0x01`, immediately after
the nonce and before its signature. It is a required assertion, not a bitmask.
The host requires that byte and end-of-record before registering the control
link or replacing its predecessor; a missing, different or extra byte is
refused. The `rpo1` acknowledgment remains exactly four ASCII bytes.

A successful data handshake returns
plain JSON `router.ready` with `version:1`, the endpoint's `memoryFlags`,
`routerEncodingNegotiation: true`, `routerRequestCredit: true`, and an exact
echo of `negotiatedMemoryFlags`. The host requires
`routerRequestCredit: true` in the private `router.hello` as well.
The router requires the acknowledgment and exact descriptor equality before
using the data socket; a different subset or superset is refused. It also checks
that the endpoint's flags still support the frozen public offer.
Memory incompatibility rejects that data connection without invalidating an
otherwise transport-compatible private control link.

The link agent checks authenticated Memory capabilities before issuing a ticket
or binding. An incompatible endpoint receives a retriable admission refusal;
sessions on compatible endpoints of that public connection remain usable. At
startup, only endpoints whose signed `rph1` descriptor includes both
`routerEncodingNegotiation: true` and `routerRequestCredit: true` and matches
the deployment's cell mode
contribute to the public snapshot. The link lifecycle remains active while
waiting for one to become available. This snapshot is fixed for the router
process's lifetime. A replacement endpoint must support every advertised true
boolean and string-set member, at the same cell mode. Additional support cannot
expand the snapshot: a capability advertised as false, or omitted, remains
unavailable even for new public connections until the router restarts.

Capability descriptors contain at most 64 capabilities, each a boolean value or
a set of at most 16 string names.
Their public intersection uses logical AND and set intersection, including names
the router has never seen. `modernCellRep` is a wire mode and must match the
deployment; absence means false and a present value must be boolean.
`serverExecution` (the posture described below) and the private
`routerEncodingNegotiation` and `routerRequestCredit` flags are excluded from
the public offer and selected descriptor. Unknown well-formed capabilities do
not require a router release.

For each client, `negotiatedMemoryFlags` is the intersection of its original
flags and that frozen public offer: booleans use logical AND, and string sets
retain common members in public-offer order. The link agent computes this
descriptor independently of the worker and signs its hash in `rdb1`. The
toolshed checks that the selection is supported by the original client and its
own authenticated offer, verifies the exact signed selection, and uses it for
the backend Memory `hello` and encoding decisions, including schema/label tables
and message compression. A worker cannot substitute another supported subset:
subset validation establishes support, while the signature binds the precise
selection authorized by the link agent's frozen offer. An endpoint upgrade
therefore cannot silently enable a codec the public handshake did not offer.

Original client flags remain unchanged in context state, `mat1` tickets and
`mvp1` proof validation. Client statements, issuances, receipts and proof records
keep their existing bindings. Deploy the router and private toolshed peers with
this contract together. A toolshed lacking either required signed-link flag
contributes no public capabilities and receives no data ticket; admission is
refused retriably as `upstream-unavailable`. A router without the signed `rpc1`
request-admission byte cannot register a control link. A supporting endpoint
refuses a data hello without the separate selected descriptor, both signed
hashes, or the request-admission assertion.
Private transport version 1, public `mrt\x01` streaming, binary `mrc\x01` upload
credits and the signed ASCII `mrc1` challenge issuance format keep their
existing framing. The binary prefixes `mrt\x01` and `mrc\x01` end in byte
`0x01` and the request credit prefix `mri\x02` in byte `0x02`; the signed record
tags in the table above, `mrc1` among them, end in the ASCII digit `1`.

Every data record is one complete binary WebSocket message. It starts with bytes
`6d 72 74 01` and a one-byte kind:

- `0`: a UTF-8 JSON header `{bytes,binary,route}`, at most 4,096 bytes including
  the prefix. `bytes` declares the exact encoded body length; `binary` identifies
  its public WebSocket representation. `route` carries message kind, applicable
  request/space/session/principal identifiers, response error presence, and an
  assigned session ID when applicable. It contains no application document data.
  Private request headers additionally require `requestOrdinal`, as specified
  below. Public upload headers and private response headers must not carry it.
- `1`: one nonempty opaque chunk, at most 32 KiB after the five-byte prefix.
- `2`: an empty completion record, valid only after exactly `bytes` body bytes.

There is one active body per source socket, with at most 512 data records. The router verifies routing bindings
before forwarding a chunk. Private responses become public WebSocket fragments;
the final `FIN` is withheld until valid completion. Private request credit may
interleave between response records and is consumed by the router; only
WebSocket control frames may interleave with the resulting public fragments.
Other upstreams pause while one owns public message output; local
responses wait in a queue. Blocked output stops source reads and resumes
on writable readiness. A truncated, malformed or lost source closes the affected
connection; the router never replays a partially forwarded mutation.

Streamed public requests use these same records. For ordinary data, the router
reserves request capacity from the header before reading its body and forwards
each chunk to the selected toolshed. Credited uploads carry control messages in
these records too; the router assembles them, checks that their routing
projection matches the header, then parses and admits the complete control
message. A refused request's body is discarded within its declared bound. Held
control messages cannot interleave an admitted upload. The toolshed reserves
its assembly budget against the request credit it granted when the header
arrives, requires completion, validates the payload, and compares its routing
projection with the header before
backend execution. Endpoint-generated response headers come from the same
structured message as the payload. Application decoding belongs to the endpoints.

### Private request-body admission

Every private request's `mrt\x01` header carries a router-assigned
`requestOrdinal`. It is a safe integer starting at `1` on each data socket and
increasing by exactly one through `2^53 - 1`, without wrapping. Ordinals belong
to that socket, not to a session, a request ID, or a replacement connection.
Public upload headers do not supply ordinals.

Admission is by credit, in declared body bytes. Once the data socket is ready,
right after `router.ready`, the endpoint grants its whole 4 MiB pending-input
budget (`ROUTER_REQUEST_WINDOW`, infra `REQUEST_WINDOW`). The router sends a
request header only when the credit it holds covers the header's declared
bytes, spends them as it sends the header, and sends the body and completion
record immediately after it. A header the credit does not cover waits at the
router, and so does the client's input behind it, bounded like the router's
other pauses (`admission-timeout`). When a request's turn ends, answered or
refused, the endpoint releases its reservation and returns its declared bytes
as credit. So requests are pipelined up to the budget with no round trip per
request. The credit counts bodies as sent. The endpoint refuses a header past
the credit the router has received (what it granted, less what the router
spent and what the endpoint has not yet written) or past its budget. It
expands a compressed body only while the expanded bodies being decoded or
waiting for their turns fit the same 4 MiB budget, and closes the data socket
(`data-queue-limit`) on a body whose declared expansion alone exceeds it, so a
routed request is at most 4 MiB expanded. This applies to ordinary
streamed requests, buffered control messages and legacy public envelopes
forwarded over the private socket.

Credit is a binary WebSocket record of exactly 8 bytes:

| Offset | Width | Value |
| --- | --- | --- |
| 0 | 4 bytes | `6d 72 69 02` (`mri\x02`) |
| 4 | 4 bytes | unsigned big-endian count of declared body bytes, 1 through 4 MiB |

Credit is additive: the router adds each record to what it holds, and refuses
a record that would take its credit past the window. It reserves input
capacity; it does not acknowledge execution or replenish public upload credit.
Public `mrc\x01` credit keeps its independent record-byte accounting and format.

The endpoint sender returns credit at the next record boundary, ahead of
further response-body records, and joins returns not yet written into one
record. Credit may appear between private response records; the router
intercepts it before response assembly and public-output ownership checks,
never forwarding it to the public client. Returning credit does not release
retained logical response-body bytes or change the retained output that holds
request dispatch at the high mark. A blocked public downstream may delay
credit: the router keeps public output owned by one response at a time and
does not read arbitrarily ahead to find one.

A wrong or reused ordinal, a header past the endpoint's budget, a header inside
a body, a body record without a header, malformed or over-window credit closes
the affected connection. Close and cancellation release each owned input
reservation exactly once.

### Endpoint buffering and dispatch

Private sockets enforce the 32 KiB plus five-byte record limit at WebSocket
assembly, not just after decoding. Endpoints retain complete logical bodies under
the existing message and queue bounds. Toolshed output to one private socket is
admitted by `limits.outputBytesPerSocket` (default 4 MiB; `null` disables it):
a message is refused when the socket already holds output (retained logical
bodies or unflushed socket bytes) and that plus the message would exceed the
bound. A message sent to a socket holding nothing is admitted up to 8 MiB, the
router's response-header limit and the SDK's frame limit, and written as the
usual 32 KiB records; no message over 8 MiB is sent on any socket. A refusal
closes the socket with an `output-limit` verdict classified `single-message`
(over 8 MiB) or `queued-output`. Toolshed output passes records to the socket,
in order, while the record bytes awaiting write callbacks are below a 256 KiB
send window (`ROUTER_SEND_WINDOW_BYTES`, local to the toolshed), and resumes
from the callback that brings them back under it; returned request credit goes
out before the next body record, between any two records. Negotiated public uploads wait for the peer's byte
credit before each record. Browser output also checks the native
`bufferedAmount` against a 4 MiB cap when streaming without credit; exhaustion
terminates the connection rather than polling for drain. Session-open and
watch-mutation control messages require full router parsing; ordinary streamed
requests and private responses do not.

Toolshed request dispatch and decoding, including host refusals, continue while
the sender's retained logical output is below a high mark: half of
`limits.outputBytesPerSocket` when set, else half the 8 MiB message ceiling. At
or above the high mark the input socket pauses at body boundaries and the next
request is neither decoded nor dispatched; both resume once retained output
falls below the low mark, a quarter of the bound. Retained output falls only as
completion-record socket callbacks release bodies. An already admitted partial
body completes with its assembly reservation held, and already-buffered
receiver events remain subject to the hard input bounds. Close cancels the
wait. No event-loop turn separates requests; as on the direct path, the
requests ws delivers from one receive chunk dispatch back to back when their
handling is microtask-only. The output bound closes the socket as before,
whatever the mark state: a message that would exceed
`limits.outputBytesPerSocket` behind retained output is refused as
`queued-output`, and one over 8 MiB as `single-message`. A slow but live reader
is therefore back-pressured first, and the refusal is reached only by a message
that would take retained output past the bound itself; a reader that stops
acknowledging sits paused with retained output under the bound (under 1.5 times
the ceiling with the bound disabled, since the response that crosses the mark
is already admitted). Either way the toolshed's memory for the socket is
bounded. Unsolicited effects, presence and
revocation remain output producers under the same cap, which close the
connection on output exhaustion.

Whole-envelope forwarding in the router drains one record at a time. A blocked
private socket retains one body cursor and pauses public reads and held-request
dispatch until writable readiness resumes it. This preserves admission at the
logical message's byte limit while the router's socket buffers grow by one
record at a time.

The router accepts the toolshed's `serverExecution` flag but omits it from
the client handshake. Execution posture is therefore unknown on a routed
connection: toolsheds can have different postures or change them after a
restart, so an intersection cannot establish that execution is off. Operations
requiring a confirmed execution-off posture must refuse an unknown one.

### Router-internal data-assignment lifecycle

`mdf1` is descriptor-free IPC between the worker, directory broker and link
agent, not a toolshed control operation. Its payload is the four-byte ASCII tag,
a big-endian unsigned 16-bit toolshed index, and the 32-byte ticket. The channel
identifies the client context. The broker validates the index and ticket against
its assigned state; the link agent serializes rollback with binding issuance and
refuses rollback once a binding has been issued for that toolshed/link epoch.

The broker retains a descriptor for at most one pending data socket per worker
and refuses further placement requests while setup is pending. The link agent
confirms rollback with descriptor-free `[0]`. Only after that confirmation does
the broker shut down the socket in both directions, clear its assignment and
cached ticket, and return descriptor-free `[0]` to the worker. Shutdown revokes
any descriptor the worker retained. Space ownership and other toolsheds remain
unchanged.

After a successful handshake, the worker sends `mdc1` with the same index and
ticket fields to the broker. The broker commits that assignment, releases its
retained descriptor without shutting down the socket, and returns
descriptor-free `[0]`. A committed assignment cannot be rolled back, including
one committed by a worker before it obtained a binding.

After rollback, the next open receives a new data socket and consults the link
agent for its ticket. An unbound ticket with sufficient lifetime is reused; an
expired ticket is replaced. Binding requires less than 13 seconds elapsed since
the issuance request began; replacement requires at least 15 seconds elapsed
since its response arrived. These monotonic bounds account for issuance delay
and the toolshed's whole-second expiry clock. Between them, the open is refused
for now without issuing another ticket that could exceed the toolshed's budget.

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
cannot authorize an old queued write. Data frames are checked and reserved in
socket order and handed to the connection without waiting for the turn before
them to end, as the WebSocket hosts do (04-protocol.md section 4.13.4); each
frame retains its queue budget until its own protected Memory turn ends.

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

The private listener uses TLS 1.3 and `ws` framing with a 32 KiB plus five-byte
record limit before application parsing. It exposes only `/memory/router-link`
and `/memory/router-data`, and serves no toolshed HTTP API. Routing headers reject duplicate JSON keys,
ambiguous security tags, invalid UTF-8/DIDs and unsupported versions. Endpoints
validate complete application bodies, including compressed envelope hints and
gzip expansion/CRC/member checks when applicable. A decoded application's
JSON is at most 64 levels deep. When `limits.frameSlots` is enabled, it also
bounds the number of values, counted as the router counts them: one slot per
value, whether scalar, object or array, with keys free. The default, 150,000,
matches the router's default `max_frame_slots`; `null` disables value counting.
The router enforces the enabled cap on complete public envelopes; opaque
streamed bodies are checked at the toolshed and SDK. The SDK refuses to send a
frame exceeding the advertised cap and closes on receiving one. Endpoint
exposure is also bounded by the byte caps (8 MiB raw, 16 MiB expanded, 8 MiB
for one message sent alone and 4 MiB of output queued behind other output per
data socket), including when value counting is disabled. A
whole-space sync can exceed these byte bounds and needs chunking (infra#244).
Context, principal, router and toolshed quotas cover sessions, watches and
holdings; resource bounds and exact values are in the infra router README.

## Toolshed deployment inputs

`MEMORY_ROUTER_CONFIG_FILE` opts in to a strict tracked policy with version 1,
deployment, private bind hostname/port, certificate/key paths, shared
authoritative directory, durable epoch ledger and per-router DID/network-peer
allowlists. An optional `limits` object sets the toolshed's capacity
(`RoutedHostLimits` in `routed-host.ts`). Omitted fields retain their defaults;
an explicit `null` disables that quota, and a positive safe integer supplies a
custom bound. Every quota is independently configurable, including
`viewsPerSession` (default 64) and `holdingsPerSession` (default 8,192).
`spacesPerContext` (default 1,200) bounds distinct spaces authorized over the
context's lifetime, independently of `sessionsPerContext`, which bounds
simultaneous sessions and open reservations. Closing a session frees session
capacity but leaves its space authorized and counted. Either quota can be
disabled independently; omitting `spacesPerContext` retains its own default
regardless of the configured session quota.
`frameSlots` follows the same rule: omission uses 150,000, `null` disables value
counting, and a positive safe integer sets the cap. Disabling it skips the slot
counter while preserving byte, nesting, duplicate-key and DID checks. The
`limits` object itself cannot be `null`.

Enabled nested limits must be ordered from context to router to toolshed, a
context's proofs must cover its principal history and a renewal for each active
principal, and every allowed router's contexts must fit the sockets and tickets
at once (`routedHostLimitsFor`). A comparison involving a disabled quota is
skipped: disabling a per-context quota while keeping an aggregate quota finite
is valid, and the aggregate still refuses excess usage. A malformed or unknown
limit is named in the startup error. When all aggregate scopes for sessions,
watches or holdings are disabled, that family's aggregate counters are skipped.
When all three families are disabled, usage reservations and aggregate maps are
also skipped. Sessions, principals, tickets, replay protection, ownership epochs
and other authorization state remain active.

Watch IDs are mirrored only when an aggregate watch quota or
`watchesPerSession` needs them. View counts are mirrored only for an aggregate
watch quota or `viewsPerSession`, and holdings counts only for an aggregate
holdings quota or `holdingsPerSession`. With all these consumers disabled, the
host validates watch mutations and forwards them to the backend without building
watch-ID sets or reserving mirrored mutations. The backend still maintains the
functional watches and views that deliver data to sessions.

A mirror holds what the backend has answered. The host hands each request to
the backend without waiting for the turns before it, so while mirrors are kept
it dispatches a session's watch mutations, resumptions (`session.open` of an
existing session) and close one at a time: each waits until the turn of the one
before it has ended, and then reads or changes the answered mirrors. The infra
router already holds a session's requests behind its unanswered watch mutation,
but holds neither a resumption behind a watch mutation nor the reverse, so the
host rarely waits; while it does, the socket's later requests wait behind it in
order.

For a quota-free rehearsal, set every quota, including `max_frame_slots` and
`frameSlots`, in both the router and toolshed policy to `null`. Byte, nesting and
unambiguous-JSON bounds remain active. Changing only the
router leaves the toolshed's independently enforced defaults in effect. Config
changes take effect when the host restarts.
Two limits are ones the router must match rather than cover, each a check for
the infra preflight beside the limits it compares already. One is
`max_frame_slots == frameSlots`, including `null`; the router advertises this
value as `routerFrameSlots` and the SDK applies it in both directions. The other
is `max_watches_per_session == watchesPerSession`, the watch IDs one session may
hold, default 2,048, which may not exceed `watchesPerContext` when both are
enabled. Matching a disabled watch quota means `null` on both sides. The two are
sized together: a session is restored by one `session.watch.set` that names
its whole watch set, so that many watches must fit one frame together with
their selectors, views and holdings. The count limit does not enforce this
aggregate size: incremental adds can create a set too large to restore, causing
reconnect attempts to fail. Size the limit against the workload's complete
restore frame. Clients that do not learn `routerFrameSlots` retain their own
150,000-slot ceiling. A frame's `watches` have no count
bound of their own. The infra router README's capacity section has the
arithmetic and maps each limit to the router's.

The toolshed answers one request it refuses and leaves the data socket open.
A request over a session, watch (views included) or holdings limit, or one
whose principal's grant expired after the router forwarded it, is denied
marked `retriable`, so the client holds the session and tries again; a request
for a session the toolshed revoked, or a principal it released, after the
router forwarded it is denied for good, as is a watch mutation, a set or an
add, that would leave a session with more than `watchesPerSession` watch IDs
or `viewsPerSession` views (`frame-limit`), when the respective quota is enabled.
Each is logged in the toolshed's own journal, never the router's, as a
`routed-memory-verdict` with verdict `request-refused` and reason
`session-limit`, `watch-limit`, `holdings-limit`, `frame-limit`,
`principal-expired`, `session-not-held` or `principal-not-held`. A frame that
itself names more than the enabled `holdingsPerSession` quota is malformed,
and so is a request whose
`watches`, `holdings` or `views` is not a JSON list. Such a
request is not answered: it closes the socket, as the router closes the
client's connection on one. The SDK declares at most 8,192 holdings
on a routed connection. A session that holds more declares the first 8,192,
and the server delivers the documents left out a second time, since a document
a session does not declare is one it is sent again. Two limits follow for such
a session. The server removes only documents a session declares, so a document
left out that is no longer in the session's watch set gets no remove, and the
client keeps the value it last had for it until the document is watched again.
And the documents left out all come back in one response frame, which must fit
the 8 MiB the toolshed may send to a data socket as one message
(`limits.outputBytesPerSocket`, default 4 MiB, bounds only output queued behind
other output); a response past 8 MiB closes the socket.

Each context closes with one `routed-memory-verdict` event whose verdict is
`context-closed` and whose `reason` retains the first socket failure through
cleanup. An `output-limit` failure adds an `outputLimit` object captured at the
failed send, before socket accounting can change during close:

- `frameBytes`: the attempted message's encoded payload size, in UTF-8 bytes
  for text or byte-array length for binary.
- `bufferedBytes`: the larger of retained logical output bytes and npm `ws`'s
  `bufferedAmount`. Control sockets use `bufferedAmount` alone. Socket writable
  bytes can include framing.
- `limitBytes`: the bound that refused the send: 8 MiB for a message too large
  to send alone, else `limits.outputBytesPerSocket` (default 4 MiB) on their
  sum; equality is admitted.
- `endpoint`: `data` or `control`. A control-link failure carries its snapshot
  into each context it closes, unless that context already has a socket failure.
- `classification`: `single-message` when `frameBytes` exceeds 8 MiB, otherwise
  `queued-output` (the message would fit alone but not behind the output the
  socket holds).
- `messageType`: the structured Memory message kind when available at the
  sender; omitted for binary control records and data greetings.
- `diagnostics`: for structured data output, separate socket and retained-body
  bytes, queue depth, lifetime body/record counters, active-body written progress,
  records passed to the socket whose callbacks have not run, queue/callback
  ages, and source attribution. Its sixteen-entry history records enqueues and
  high-water progress without payloads. At 2 MiB retained output a single
  `setImmediate` marker measures event-loop opportunity; recovery to 1 MiB or
  close cancels it. The high-water episode is a fixed diagnostic marker,
  independent of the dispatch high and low marks above. It changes neither
  admission nor write scheduling.
  Failure-only canonical size measurements retain eight result fields, documents
  and schema-table entries per category, with explicit scan bounds and truncation.
  The [memory package diagnostics reference](../../../packages/memory/README.md#routed-transport-and-quotas)
  defines the fields and measurement limits.

The snapshot contains no payload or error text. Data message sizes are the
bytes on the private hop, compressed or not; the router forwards their encoding
unchanged.
Buffered bytes describe local output buffering, not browser processing or
acknowledgment.
An earlier non-output failure keeps its reason and has no `outputLimit` object.

A proof is refused with verdict `proof-denied` and reason `proof-limit`,
`principal-limit` or `principal-history-limit`, and the refusal closes its
context, which ends the client's connection. When enabled, `contextsPerLink`
and `proofsPerContext` bound the proofs live contexts hold per router. An earlier
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
repository's CI; it uses two real SQLite toolsheds and the actual SDK. Its
systemd mode kills the idle spawner before any client connects and verifies
automatic listener restart through process-exit and journal events, without
client traffic triggering recovery. Unit tests cover exact crypto records,
parser failures, durable replay custody,
router revocation isolation and queued protected turns. This test support does
not establish that an existing public deployment is eligible or has been
changed.
