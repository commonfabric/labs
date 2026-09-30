# Multi-document runtime attachment

A worker runs one runtime and serves any number of documents. The first
document to reach it stands the runtime up; each later one attaches to the
runtime already running, over a duplex of its own. This document is what a
document owns separately, what all of them share, how an attach is refused, and
which traffic still goes only to the first document.

Read it before changing the worker's message loop, the keys a client-owned
resource is filed under, or what an attach is checked against.

## Why a document attaches rather than starting its own runtime

A runtime is a `StorageManager`, a compile cache, and a heap. A host that shows
several documents over one user's data — a native shell placing each pattern in
its own web view — pays for all three once per document if each boots its own,
and each then converges on the others only through storage.

Attachment makes those documents one runtime's clients. What they gain is the
single heap and the single memory session; what they do not gain is isolation
from each other. **One runtime is one memory session**, so `PerSession`-scoped
cells and session-scoped navigation are shared across every attached document.
That is what the shell already does with several pieces in one document;
attachment preserves it rather than adding per-document isolation.

## What a client owns, and what it shares

A **client** is one document's end of the worker's IPC.
[`WorkerClient`](../../packages/runtime-client/src/backends/worker-client.ts)
is where a message addressed to it goes, plus the id everything it owns is
filed under.

Owned per client, because each document mints these ids inside itself and two
documents mint the same ones:

- **Cell subscriptions.** Keyed by the client's scoped cell key, so two
  documents watching one cell are two subscriptions to the runtime. One
  document's unsubscribe stops its own feed and no other's.
- **VDOM mounts.** Keyed by the client's scoped mount id. A mount id comes from
  a counter that starts at 1 in every document, so the id alone names a mount
  only while there is one client. A DOM event and a batch acknowledgement reach
  the sending client's own mount, and a batch reaches the client that mounted.
- **Operation subscriptions and sessions.** The subscription and session ids
  are UUIDs, so two clients do not collide on one — but that is convention
  rather than protocol, and nothing on the wire stops one client naming
  another's. Each records the client that opened it, and only that client can
  unsubscribe it, close it, or have it torn down with its departure.

Shared, because they are the runtime's rather than any document's: the identity
the runtime signs as, the storage manager and its memory session, the compile
cache, and the security context below.

## The security context, and why an attach is refused rather than merged

`InitializationData` carries the CFC enforcement mode, the flow-label dial, the
render declassification policy, the render confidentiality ceiling, the trust
snapshot, and the backend and per-space hosts the runtime reads from. They are
per-runtime, not per-request: there is one signer and one posture, and every
attached document acts under both. The backend and host map are compared for
the same reason as the rest — a document believing it reads from somewhere else
is as wrong about what it has joined as one believing another enforcement mode,
and its reads would silently go to the runtime's hosts. Both are normalized
first, so two spellings of one origin are one posture and do not refuse each
other.

So an attach states the
[`RuntimeSecurityContext`](../../packages/runtime-client/src/protocol/types.ts)
it believes it is joining, and the runtime compares it field for field against
its own. Any disagreement is **refused, by name**. Merging is not available:
whatever a merge chose, one of the two documents would then be running under a
posture it does not believe it has. A document that needs a different posture
needs a different runtime.

The comparison is over the whole of `RuntimeSecurityContext`, and the field
list is a record keyed by that type, so a field added to the type and not to
the list is a type error rather than a posture nobody checks. Fields compare
one at a time, because the two contexts are built in different documents and
one of them crossed an encoding: a posture carried as an absent property in one
and as an explicit `undefined` in the other is the same posture.

Each context is built the way it is compared. The runtime's own is read off the
payload it was initialized from; an attaching client's is read off that
client's options. Both are written out field by field, and each literal is held
to a record keyed by the context's type, so a field the type declares and a
literal drops is a type error as well. That matters most where both ends drop
the same field: the comparison then finds two absences and agrees, and two
documents run under one runtime each believing its own answer.

Being complete is not the same as being normalized, and the two fields that
are normalized are the two named above. The backend and the host map are put
into one spelling on both sides, so two ways of writing one origin are one
posture. The render declassification policy and the render confidentiality
ceiling are not: each is recorded as the payload spelled it while the runtime
applies a normalized form, so two documents holding one render posture and
spelling it differently refuse each other. The refusal is the fail-closed
direction — an attach is never accepted on a render posture the runtime does
not hold — which is what makes the spelling a wart rather than a hole.

The assertion is a check against misconfiguration, not the authorization. The
port **is** the capability: a document can only attach because the page that
owns the worker handed it a duplex.

### No key material crosses an attach port

The initializing client supplies the signer, once. An attaching client
supplies none: it names the acting principal as a DID, and the runtime refuses
it when that is not the principal it acts as. So no step of an attach needs a
key to cross, and a frame carrying one is refused by name — on the sending
side before it reaches a port, and again on the receiving side — with the path
the key sits at.

That refusal is loud rather than left to the platform, because the platform's
answer varies and one of its answers is worse than a refusal. Measured on the
SP5 spike: a non-extractable `CryptoKey` posted over a `MessagePort` between
two WKWebViews throws `DataCloneError`, which is an embedding defect — browsers
carry it — but means a frame with a key in it would fail there as a transport
error, in a shell, at run time, saying nothing about why. A `DataCloneError`
seen on this path is therefore never to be "fixed" by finding a way to pass
the key: the key was not supposed to be in the frame.
`packages/runtime-client/src/shared/key-material.ts` holds the invariant and
the finding; the acting principal is additionally required to be a DID, so a
signer cannot ride in as the field that names one. The refusal sits in
`RuntimeConnection.attach`, immediately before the frame reaches a transport,
so a caller holding a connection directly is covered by it too.

**This is a misbuild detector, not an exfiltration filter.** A secret already
reduced to bytes or text — a PKCS8 blob, a JWK, a seed as a `Uint8Array` — is
out of scope and would pass unnoticed. Both ends of an attach are a page and a
worker at one trust level under one origin, so a sender determined to move
bytes has the whole payload to do it in; what this catches is the accident of
handing an attach the signer that initialization takes. The classes it
recognizes are enumerated rather than derived, so a future codec class able to
hold a key has to be added to the walker.

## The protocol

`Attach` is its own request rather than a second `Initialize`. A worker that
quietly accepted a second initialization as an attach would make a genuine
double-initialization bug silent, which is the failure the singleton it
replaced existed to prevent.

1. The owner's page calls `WebWorkerRuntimeTransport.attachClientPort(port)`,
   which transfers the port to the worker alongside an `AttachPort` message.
   The port rides `postMessage`'s transfer list, a port being no `FabricValue`
   and having no encoding; the message beside it is the marker saying what the
   transferred port is for. Only the owner may hand one over — a document that
   arrived over a port does not get to enlarge the family it joined.
2. The joining document speaks over its end of that port and sends `Attach`,
   carrying its asserted security context. Until that is accepted it may ask
   for nothing else. An attach that arrives while the runtime is still standing
   up waits for that rather than refusing; one that arrives after the runtime
   has been disposed is refused by name, a client joining a runtime-shaped void
   being the one failure it could not otherwise detect.
3. Every later request on that duplex carries the attached client, and the
   runtime files what it creates under it.

An attach that is refused rejects on the joining side, so a document learns it
is not part of the family rather than waiting on a promise nobody settles.
Until the attach is accepted the client may send nothing else, and a
notification — which cannot be refused, having no reply — is dropped rather
than acted on.

`RuntimeClients.attach` takes anything shaped like a
[`MessagePortLike`](../../packages/runtime-client/src/shared/message-port-like.ts),
so how a duplex arrived — carried by a page's opener, relayed by a native
shell, built by a test from a `MessageChannel` — is not something the worker
learns. `MessagePortRuntimeTransport` is the other end of the same seam, and
`RuntimeInternals.create`'s `transport` and `attach` options are how an
embedder supplies one instead of spawning a dedicated worker.

A page that both runs a runtime and hands ports to it needs the transport in
its own hands, since `attachClientPort` lives there. `resolveWorkerUrl` is
exported for exactly that: build the URL, connect a `WebWorkerRuntimeTransport`
to it, pass that transport to `RuntimeInternals.create`, and keep it for the
ports handed over later.

## Departure

A `Dispose` from an attached client is that client leaving. Its cell and
operation subscriptions stop, its VDOM trees unmount, and the runtime and every
other client's work keep running. Only the owner's `Dispose` reaches the
runtime's own, the worker being the owner's page's to end.

Both ways a client ends — refused, or departed — the worker forgets it and lets
go of its channel, so a page that reloads into a refusal cannot grow the worker
one listener at a time. A message already in flight from a client that has
departed is acked in silence, which is how the owner's own post-disposal
stragglers read.

A dead `MessagePort` emits no event, so a departure is something a client says
rather than something the worker observes. A document that vanishes without
sending `Dispose` leaves its subscriptions and mounts behind until the worker
itself goes. Closing that means an app-observable liveness signal, which does
not exist yet.

## What still reaches only the first document

Four kinds of notification are the runtime's rather than any client's, and each
still goes to the client that initialized it:

- pattern console output,
- the navigation a pattern asks for,
- the pending-writes barrier the shell's beforeunload handler consults,
- telemetry markers and terminal event-delivery notices.

For a single document that is every notification it ever had. For an attached
one, three of the four are a matter of policy and are deliberately left until a
host needs an answer: console output has no obvious single destination, and
pending writes are the owner's business anyway — the worker lives in the
owner's page, so it is the owner's unload that can lose them and the owner's
handler that gates it.

**The navigation is different, and is a known gap rather than a policy
choice.** A navigation a pattern asks for belongs to the document whose mount
raised it, and delivering it to the owner makes one document's intent move
another's view. Routing it is not possible at this seam: `NavigateCallback` is
`(target: Cell) => void`, and it is invoked from a post-commit effect flush
(`packages/runner/src/builtins/navigate-to.ts`), decoupled by then from the
event dispatch that caused it — so nothing in hand names a mount, and the
mounts this worker holds cannot be asked which one is responsible. Closing it
means the runner carrying the raising context to the callback. Until it is
closed, a host with more than one document should treat pattern-driven
navigation as reaching the family root.

Console forwarding itself is the owner's for the same reason: the bridge posts
on the worker's own global, which is the owner's end of the IPC.

## Where the code is

| Concern | File |
| --- | --- |
| A client's identity and outbound sink | `packages/runtime-client/src/backends/worker-client.ts` |
| The registry and the per-client message loop | `packages/runtime-client/src/backends/client-registry.ts` |
| Per-client keys, routing, and teardown | `packages/runtime-client/src/backends/runtime-processor.ts` |
| The duplex shape both ends take | `packages/runtime-client/src/shared/message-port-like.ts` |
| The joining document's transport | `packages/runtime-client/src/client/transports/message-port/transport-message-port.ts` |
| `transport` and `attach` for an embedder | `packages/lib-shell/src/runtime.ts` |
