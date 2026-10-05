# Shared-space catalog in Home

The Home pattern owns the shared-space catalog and exposes its operations as
handlers. Other patterns and host applications use the same
[catalog interface](../features/shared-space-catalog.md). Its state, validation,
and transitions belong to authored Home code; the remaining integration work
must make ordinary subscriptions and handler invocation reliable for consumers.

## State and operations

Home exposes reactive catalog data and handlers for registration and explicit
membership changes. Registration remains insert-if-absent, receipts deduplicate
offers without restoring archived entries, and membership actions retain their
action ID and observed revision. Retries preserve the original user intent; they
cannot rebase an old choice onto a peer's newer revision.

The catalog contains shared spaces only. Migration must not register a private,
unshared hosted loom merely because it has a Fabric binding. A subsequent
explicit sharing operation may register that space.

Catalog rules belong with Home's authored source. The runtime provides general
execution and storage primitives. Product catalog schemas and transitions must
not be added to the runner merely to make them available to authored code.
Consumers use a narrow structural interface rather than Home's full UI schema.

All catalog writes execute in Home. FabriChat's Home-local room manager and
share intake can use that boundary. An intake caller validates the offered
target and its access before requesting registration; a catalog receipt records
that application action and is not independent sender authentication. `from`
records the first validated sender, if there was one, and `since` records
recipient admission time. Subsequent offers preserve both.

`Home.spaces` is the navigation list of names and space DIDs. The site table
holds routing hints. The catalog holds shared-space membership and admission
evidence. Registration does not grant access, populate the other lists, or allow
a routing hint to override an accepted catalog host.

## Observation and completion

A reply describes what happened to its request. Current membership comes from
the catalog's reactive read surface. A consumer must not install membership from
a returned entry or interpret `confirmed` as a promise that the action remains
the latest choice.

Host observers use `Cell.sink` or its ordinary SDK subscription interface.
Pattern consumers use reactive data directly. Subscription updates can reflect
optimistic writes and their rollback. A missing initial value is not confirmed
absence, and a failed or refused load must preserve the consumer's previous
projection with an explicit unavailable state.

Handlers stage their reads and writes in the transaction supplied by the
platform. Host transaction work uses `editWithRetry` where needed; a handler
does not start a nested asynchronous transaction. Normal handler results and
their committed receipts are the first choice for operation completion.
Consumer-specific reply cells or a second command journal need a demonstrated
gap in that mechanism.

An actual write's committed result and a locally completed read-only transaction
are different evidence. Consumers clear durable pending actions only on a
committed outcome or valid durable evidence of that action. Observing an
optimistic matching state is insufficient. A later action may supersede an
earlier successful one without making its historical success false.

An authored pin API is not a prerequisite merely to make a reply's copied
membership current at commit: even that value can be stale by the time a
consumer receives it. Home returns operation outcomes without copied entries.
The result receipt is durable action evidence, and the reactive catalog is the
current membership observation.

## Implementation sequence

1. Establish the catalog in the real Home pattern, with authored handlers and
   tests. Use ordinary pattern imports, validation before a typed projection,
   stable event identities, and normal handler results. Preserve unknown fields,
   kinds, states, and incompatible action evidence on untouched entries.
2. Prove Home creation, source upgrades, and explicit root recovery preserve the
   catalog authority. Recreating a Home root must not silently publish an empty
   replacement catalog to consumers.
3. Adapt consumers to discover Home, invoke its handlers, and subscribe to its
   catalog. A thin wrapper may coordinate these existing operations without
   owning catalog rules.
4. Connect the native projection and shared-loom flows to that interface, then
   rehearse recovery across fresh devices, reconnect, and sidecar restart.

Each slice must be reviewable against its immediate dependency. The Home
foundation can land with guarded root creation, state-preserving source updates,
and handler settlement evidence. Consumer integration must provide evidence of
recovery and failure handling before the catalog becomes the native collection
authority; landing Home does not switch that authority.

## Required evidence

- Real Home creation and source upgrades expose the same catalog and handlers
  without resetting membership. Home's owned backing cell is the authority;
  there is no independent SDK writer or second catalog to reconcile.
- Root recreation refuses an existing identity Home before stopping or
  unlinking it, including a Home installed by another initializer during
  compilation. First creation and in-place source updates retain their normal
  behavior.
- Authored and host callers register, archive, and restore through the same
  handlers, with server execution enabled and disabled.
- Duplicate offers, stale actions, unknown states, malformed optional fields,
  invalid hosts, and extension fields retain the base contract's protections.
- Competing actions rerun safely. Held, rejected, or superseded commits do not
  produce false durable success, including an attempt that observed an
  optimistic predecessor.
- Ordinary subscriptions follow peer writes, replacement, and rollback. Loading,
  denied access, and transport failure remain distinguishable from a
  successfully read empty collection.
- A successfully loaded, accessible Home missing `sharedSpaceCatalog`,
  `registerSharedSpace`, or `changeSharedSpaceMembership` produces the distinct
  `home-update-required` consumer state. The consumer retains its last confirmed
  projection and waits for a compatible Home update instead of blindly retrying.
  Pending or denied loading, including pending serving output after a completed
  read, must not be classified as an old Home. Interface absence requires a
  settled Home or verified source-interface evidence.
- The authenticated actor reaches their configured Home. Serving execution does
  not substitute the service identity or a pattern-compilation origin for the
  owner or Home route.

Controlled held-commit and rejected-predecessor tests remain required in
addition to the concurrent registration and membership races. Those ordinary
races do not establish behavior under every optimistic rollback ordering.

The Home integration suite covers withheld peer writes, a rejected optimistic
predecessor, and a held serving commit. Its cold and denied reader cases exercise
ordinary `Cell.sink`, `Cell.pull`, and storage access-error signals. A sink value
alone does not prove loading completed: consumers must await synchronization and
check access errors before treating a valid empty catalog as authoritative. A
completed pull can still precede the serving producer's first output; keep the
read unavailable until the subscription delivers a valid catalog. The consumer
still needs its own end-to-end tests for last-projection retention, transport
failure, and `home-update-required` handling.

## Home replacement

Ordinary source updates and automatic roll-forward repair retain the Home root
identity. Explicit recreation, including the debugger action and CLI
`space recreate-root` and `space set-home`, refuses an existing identity Home.
The guard runs before stopping, unlinking, fetching, or compiling, and a second
transactional check protects a Home installed during first-creation compilation.
An unavailable root target is still an existing root to preserve.

Changing the Home application uses an in-place source update. Preserving account
data by default covers profiles, favorites, navigation, and the catalog
together. A true account-data reset, if needed, requires a separately designed
destructive contract. Low-level unlink and direct space-cell writes are not
account recovery operations.

For every proposed shim, record the required behavior, the ordinary platform
operation attempted, the failing example, and whether a small general platform
change would suffice. Keep any retained shim's responsibility explicit. This
includes stable backing-cell discovery and result receipt access if a production
consumer demonstrates a gap. `normalizeSpaceHost` is a general authoring helper
backed by the runtime's canonical routing validator. The direct-runtime Loom
sidecar can use existing `sendEvent` receipts; a new runtime-client invocation
API is not a prerequisite for that consumer.

Coordination with FabriChat is recorded in the
[consumer Topic](https://estuary.saga-castor.ts.net/topics-dev-476ea34f/of:fid1:LWFAKJVz0hlcUUz6hlo9gGwYXajuXpUyblkS_MFOwlg).
Berni approved the interim inbox posture for this cohort, confirmed by Gideon
on October 5, 2026. Delivery hardening is separate from catalog ownership and
does not weaken intake validation.
