# Shared-space catalog pattern integration

Home share intake and FabriChat's room list must use the same membership
authority as host clients. The [host SDK](../features/shared-space-catalog.md)
supplies durable catalog operations, but authored patterns cannot import it.
This plan keeps the experiments and open interface decisions separate from
the implemented contract.

## Required behavior and proposed implementation

The catalog SDK methods are implemented for host clients. Authored patterns
cannot import `@commonfabric/runtime-client`, and a raw cell link alone does
not provide registration and membership semantics. A Labs-only Home intake
and FabriChat room list must be able to use the same catalog with server
execution enabled or disabled. This pattern path is required before treating
the shared storage contract as ready for those consumers.

The host and pattern adapters share one portable transition implementation in
the runner. SDK wrappers provide confirmed asynchronous
operations. A pattern-facing read must be reactive and validated, with explicit
readiness and failure; the access-path comparison below decides how it is
exposed. Handler operations stage registration and membership
changes in the handler's existing transaction, with the same receipt, revision,
and authoritative confirmation guarantees as the SDK. SDK no-op confirmation
uses a value pin; a stream needs an explicit catalog observation precondition
or a proven equivalent, since the wave's destination checks do not protect an
unchanged catalog. They must not start a nested asynchronous
transaction. A staged handler result is not a committed success; consumers
observe the event's committed outcome before promising completion.

Canonical Home routing must come from trusted deployment configuration. The
runtime's general `apiUrl` is insufficient under serving execution: it can be
the pattern compilation origin, while loopback storage routes locally. The
handler's acting principal must determine whose Home it may update; the service
identity is not that principal. The current SDK refusal of unscoped serving
runtimes remains in force.

Dan and Berni need to settle the Home route source and capability shape, whether
all writes execute in Home or creation requires a cross-space write to Home,
and the `from`/`since` semantics in the host contract. Coordination is in the
[FabriChat consumer Topic](https://estuary.saga-castor.ts.net/topics-dev-476ea34f/of:fid1:LWFAKJVz0hlcUUz6hlo9gGwYXajuXpUyblkS_MFOwlg).
These questions gate the first shared Home write contract; inbox admission
posture remains a separate decision.

The pattern implementation must demonstrate, with real compiled patterns:

- A Labs-only handler registers a room and the SDK reads that same entry.
- SDK archive survives repeated pattern intake, including after a fresh load.
- Pattern and SDK membership actions respect the same observed revision, and a
  withheld server verdict never becomes a confirmed result.
- A failed or unfinished catalog load never appears as an empty room list.
- Serving execution selects the authorized person's Home and canonical route,
  not the service identity or compilation origin.

## Evidence and remaining work

The [compiled-pattern rehearsal](../history/development/2026-10-04-shared-space-catalog-rehearsal.md)
records interoperability, archive preservation, extension retention, membership
races, held and retried serving commits, and stable Home link discovery. It also
exposes a stale no-op observation that still receives a stream acknowledgement. Its
synthetic bootstrap and emulated storage do not establish production discovery,
canonical Home routing, or authority to write another person's Home. It also
demonstrates two validation failures in a schema-only adapter. Passing those
negative probes means the gap is documented, not that the writer is ready.

Existing action streams are a candidate for dispatch and commit notification.
They require an additional no-op observation check to match the SDK contract.
Select the public surface after resolving the remaining comparison:

1. Home exposes a catalog reference and action streams through existing pattern
   facilities. Trace first creation, existing Home upgrades, root recreation,
   loading/failure visibility, and both execution modes. This is viable only if
   all paths reach the same dedicated document without starting Home for an SDK
   operation or duplicating the transition rules.
2. A runtime capability resolves the catalog and stages its operations. Trace
   the trusted Home route source, event actor versus service identity, reactive
   read scope, and commit outcome. Its runtime/API cost needs Berni's review.

The production adapter must protect no-op observations at commit, with frozen
result evidence in the concurrent-archive test. It must validate raw stored data before typed projection,
normalize all commands through the shared contract, preserve unknown fields,
and expose failed/stale reads separately from an empty collection. Test cached
ACL revocation, actor/owner mismatch, real Home bootstrap and upgrades, and
root recreation. Prove the agreed deployment routing with the actual storage
transport; the current loopback executor refuses remote-host resolution.

Keep production Home/inbox wiring, public API names, and cross-space authority
provisional until their contracts are agreed. Client reconstruction can be
rehearsed independently with synthetic snapshots, but deployed web-to-native
recovery still requires real SDK acquisition, subscriptions, identity changes,
sidecar restart, and visible freshness in both clients.
