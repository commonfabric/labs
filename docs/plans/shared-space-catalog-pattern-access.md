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

The host and pattern adapters should share one transition implementation in a
package the runner can depend on. SDK wrappers provide confirmed asynchronous
operations. A pattern-facing read must be reactive and validated, with explicit
readiness and failure; the access-path comparison below decides how it is
exposed. Handler operations stage registration and membership
changes in the handler's existing transaction, with the same receipt, revision,
and server value-pin rules as the SDK. They must not start a nested asynchronous
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

## Work independent of consumer interface decisions

First complete the host contract's compatibility and failure tests. Confirmed
absence, failed reads, unknown states, duplicate offers, rejected value pins,
and stale membership actions have the same obligations whichever interface
patterns use.

Next use an isolated compiled-pattern experiment with an explicitly supplied
catalog reference in a synthetic owner's Home. Share the transition code with
the SDK, stage changes in the existing handler transaction, and prove SDK
archive survives pattern registration and a fresh runtime. Exercise competing
membership actions and a withheld or rejected commit. Keep the reference
supply explicit: an injected test reference proves transaction behavior, not
production discovery, canonical Home routing, or authority to write another
person's Home.

Compare two access paths before selecting a public surface:

1. Home exposes a catalog reference and action streams through existing pattern
   facilities. Trace first creation, existing Home upgrades, root recreation,
   loading/failure visibility, and both execution modes. This is viable only if
   all paths reach the same dedicated document without starting Home for an SDK
   operation or duplicating the transition rules.
2. A runtime capability resolves the catalog and stages its operations. Trace
   the trusted Home route source, event actor versus service identity, reactive
   read scope, and commit outcome. Its runtime/API cost needs Berni's review.

Each experiment should identify which claims it proves and which configuration
it injects. An experiment may be discarded without migrating user data.
Keep production Home/inbox wiring, public API names, and cross-space authority
out of these experiments until their contracts are agreed.

A separate low-risk client rehearsal can use synthetic catalog snapshots to
exercise local projection and reconstruction: absent versus unavailable,
archive preservation, unreadable targets, identity/host mismatch, and restart
after a confirmed registration. It must preserve the last confirmed list on
failure and must not write production Home state.
