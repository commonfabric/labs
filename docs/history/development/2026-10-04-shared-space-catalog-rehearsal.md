---
status: historical
created: 2026-10-04
archived: 2026-10-04
reason: "Point-in-time catalog interoperability and access-path experiments."
---

# Shared-space catalog: compiled-pattern rehearsal

This experiment extends draft [#8449](https://github.com/commonfabric/labs/pull/8449).
It tests the contract while Home routing and the consumer interface remain open
with Dan and Berni. It changes no live Home, inbox, or deployment configuration.
The [integration plan](../../plans/shared-space-catalog-pattern-access.md)
retains the production gates.

## Result and recommendation

Existing action streams can run the same catalog transition code as the SDK
and provide an authoritative signal that the handler's writes committed.
However, that signal alone does not supply the SDK's no-op confirmation
guarantee. Keep the stable Home link and action-stream experiment as a candidate
while determining how to attach an explicit catalog observation precondition.
This is not a settled public interface.

The experiment demonstrates why that prototype cannot ship as the writer:
a typed pattern read can hide malformed optional fields, and a schema alone
does not normalize or validate host strings. Production needs the host SDK's
raw-data validation, trusted routing, failure visibility, and no-op confirmation.
Path-based writes preserve extensions but do not supply those missing checks.

No experiment here establishes deployed Home/FabriChat integration, cross-host
serving, or web-to-native recovery. The native companion is a separate synthetic
snapshot rehearsal over real CFS persistence.

## What ran

`packages/runtime-client/test/shared-space-catalog-pattern.test.ts` compiles a
real authored handler. Its relative source dependency is the actual
`packages/runner/src/shared-space-catalog-data.ts`, with only import aliases
adapted for the compiler. The SDK calls those same registration and membership
functions. The algorithm is not copied into the fixture.

Each case uses fresh client replicas against a real ACL-enforcing memory
server. The Home owner is the only OWNER; a separate serving identity has the
server's delegation permission. With server execution enabled, an actual
`ExecutorHost` executes the graph. With it disabled, the client executes it.
Storage transport is emulated, all identities are synthetic, and Home and
catalog references are supplied explicitly. The handler compares its event
principal with the owner supplied by this trusted test bootstrap.

The compiled handler assumes application-validated commands and catalog data.
Its result is observed through `sendEvent`'s commit callback, not by treating a
speculative output or accepted event append as success.

| Executable case | Observation |
| --- | --- |
| Pattern registration, SDK archive, new runtime and replacement graph, fresh offer | One entry remains archived; admission provenance survives; receipts accumulate without restoration. |
| Competing SDK and pattern actions against one revision | Exactly one applies; the loser conflicts; replay cannot replace the winner. |
| Root, entry, and receipt extensions | Registration and membership path writes retain unknown fields, including through duplicate confirmation. |
| Stable Home space-cell link, then replacement default graph | `wish` at `/sharedSpaceCatalog` in `~` reaches the dedicated catalog and observes the SDK's archive. |
| Held authoritative serving commit | Event append is accepted, but no commit acknowledgement or durable catalog entry appears until release. |
| Rejected first wave, held next wave | The executor retries; it emits no success while the next commit is held. Releasing it produces one confirmed result. This is not a permanent-rejection test. |
| Held no-op registration, concurrent SDK archive | The wave commits a frozen observation of the old saved state after the SDK archive completes. An explicit catalog observation precondition is missing. |
| Invalid host path | The SDK refuses it; the schema-only pattern can store it, after which an SDK read refuses the catalog. |
| Malformed optional admission timestamp | The SDK refuses the raw catalog; the typed pattern can hide that field and mutate membership. Minimal writes retain the malformed value, so the SDK still refuses it. |

The ordinary interoperability, extension, discovery, and negative validation
cases run with server execution both off and on. Wave fault injection is on the
serving arm. Gates use event arrivals and explicit release signals.

## Transition boundary

The runner now owns portable schema data, contract validation, and a synchronous
transition core. The runtime-client contract remains a re-export. Dependency
direction stays downward; the core needs neither a runtime-client nor a nested
transaction.

The core takes a transaction-local catalog and emits bounded field writes.
New registration writes only its entry and receipt; membership writes only
state, revision, and action evidence. This matters because a typed pattern
projection omits extensions: setting the whole projected catalog would erase
them. The SDK continues to validate and copy the complete raw value before its
whole-document write.

Input validation, principal and route authority, loading, and confirmation
belong to the adapter. The shared pure core is not a production pattern API.
The SDK keeps its existing whole-value pin for no-op confirmation. The stream
wave's commit check covers write destinations; an unchanged catalog is not
one. Writing a separate outcome document therefore does not protect the
catalog observation. A held no-op wave can commit a stale result. A production
adapter needs an explicit precondition or another proven equivalent.

The fixture records primitive observed state and revision in its outcome.
Storing the typed entry itself can retain a live cell link: reading it after a
peer archive would show archived even if the handler never reran. Review caught
that false witness; freezing the evidence exposed the no-op gap. The negative
probe records the limitation and must become a positive guarantee test when
the production adapter supplies that precondition.

Source inspection found the needed value-pin mechanism on the internal storage
transaction, and waves carry explicit preconditions. The authored cell API does
not expose it. Equal-value sets are normally elided and cannot stand in for a
pin. The bounded follow-up is a validated, transaction-scoped catalog adapter
or a sanctioned read-precondition facility; a general change to wave concurrency
semantics needs separate runtime review.

A transaction-stage API that added a value pin on every invocation was also
examined and removed: a second operation on the same catalog could pin the
first operation's uncommitted result and conflict with the server. Any future
composable transaction API must pin its original baseline once.

## Access-path comparison

| Concern | Stable Home link and action streams | Runtime capability |
| --- | --- | --- |
| Catalog identity | Bootstrap attaches the independently addressed document to the Home space cell; consumers use existing lookup. The fixture proves that a replacement default graph retains access. | Resolve the same dedicated cause internally. Must not introduce a second store. |
| Operations | Shared pure transitions in a synchronous handler; acknowledgement confirms writes, but a no-op catalog observation needs an additional precondition. | Stage into the current transaction with a baseline pin and expose committed outcomes. Adds runtime/API surface. |
| Validation | Requires a raw validated read/admission boundary beyond typed `Writable` projection. | Can centralize raw validation, but must provide reactive readiness and errors without disguising failure as absence. |
| Bootstrap and upgrade | A trusted installer must attach the link and current streams for new and existing Homes. Root recreation must rebind streams without moving the catalog. | Still needs trusted owner/host configuration; cannot infer it from a service identity. |
| Cross-space creation | Depends on whether a room creator sends a Home event or writes directly under a grant. Not exercised. | Same authority decision; a capability does not create authorization. |
| Cost | Reuses event machinery, with bootstrap, raw validation, and observation pinning remaining. | May centralize raw validation and pinning, with additional runtime surface requiring Berni's review. |

Source inspection bounds that recommendation:

- `packages/patterns/system/home.tsx` takes empty creation arguments and owns
  its own writable fields. `packages/piece/src/ops/pieces-controller.ts` and
  `packages/runner/src/ensure-space-root.ts` have distinct creation/existing-root
  paths. Updating source alone is not evidence that every old Home receives a
  new link. Actual upgrade/recreation acceptance remains necessary.
- `packages/runner/src/executor/loopback-storage.ts` refuses remote host
  registration with `no-remote-resolution`. The emulated same-host fixture
  cannot establish cross-host serving. The runtime's `apiUrl` may be the
  compilation origin and cannot select canonical Home storage.
- `currentPrincipal()` is the event actor; Home ownership comes from trusted
  instance/bootstrap configuration. Neither should fall back to the service
  identity. A second-user attack matrix remains part of consumer integration.
- Generic wish document readiness can return ready for cached present data
  (`packages/runner/src/document-readiness.ts`). The SDK explicitly synchronizes
  storage and checks access before reporting absence. Cached ACL revocation
  with a wish was not exercised; the source difference prevents treating a
  truthy wish value as a validated current catalog read.

## Next evidence needed

Implement the validated pattern adapter only after settling the Home route
source and where registration runs. First prove no-op confirmation with frozen
outcome evidence under concurrent membership changes. Demonstrate malformed and failed reads,
revocation with cached data, owner/actor refusal, real Home upgrades and root
recreation, and the agreed same-host or cross-host deployment. Then integrate
the actual Home/FabriChat consumers and test their empty, loading, stale, and
conflict UI states. The experiment does not decide inbox posture or provenance
policy on Dan's behalf.
