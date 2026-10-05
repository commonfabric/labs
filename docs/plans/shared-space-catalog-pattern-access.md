# Shared-space catalog in Home

The Home pattern owns the shared-space catalog and exposes its operations as
handlers. Other patterns and host applications use the same interface. The
[direct host SDK](../features/shared-space-catalog.md) supplies tested catalog
rules; completing the Home implementation includes moving those rules into Home
and replacing direct host mutation with handler invocation.

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

The direct SDK's whole-catalog value pin can remain a stronger implementation
check while it exists. An authored pin API is not a prerequisite merely to make
a reply's copied membership current at commit: even that value can be stale by
the time a consumer receives it.

## Implementation sequence

1. Align the base contract with the distinction between operation outcome and
   observed state. Keep the direct SDK provisional until the Home and host paths
   use one implementation.
2. Add the catalog to the real Home pattern, with authored handlers and tests.
   Use ordinary pattern imports, validation before a typed projection, stable
   event identities, and normal handler results. Preserve unknown fields, kinds,
   states, and incompatible action evidence on untouched entries.
3. Adapt the host client to discover Home, invoke its handlers, and subscribe to
   its catalog. Remove the independent mutation implementation. A thin wrapper
   may coordinate these existing operations without owning catalog rules.
4. Connect the native projection and shared-loom flows to that interface, then
   rehearse recovery across fresh devices, reconnect, and sidecar restart.

Each slice must be reviewable against its immediate dependency. The base and
Home/host integration remain drafts until they form a coherent interface; a
tested direct SDK alone is not the completed feature.

## Required evidence

- Real Home creation and source upgrades expose the same catalog and handlers
  without resetting membership. Resolve the storage identity deliberately:
  either Home retains the dedicated backing document or its owned cells replace
  the unpublished direct-SDK addressing. No two writable catalogs may coexist.
- Root recreation either preserves the catalog reference or requires an explicit
  recovery that preserves its data; it must not silently create an empty
  membership authority.
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
- The authenticated actor reaches their configured Home. Serving execution does
  not substitute the service identity or a pattern-compilation origin for the
  owner or Home route.

For every proposed shim, record the required behavior, the ordinary platform
operation attempted, the failing example, and whether a small general platform
change would suffice. Keep any retained shim's responsibility explicit. This
includes stable backing-cell discovery, host normalization, and result receipt
access if the production path demonstrates a gap in one of them.

Coordination with FabriChat is recorded in the
[consumer Topic](https://estuary.saga-castor.ts.net/topics-dev-476ea34f/of:fid1:LWFAKJVz0hlcUUz6hlo9gGwYXajuXpUyblkS_MFOwlg).
The interim inbox posture is accepted for this cohort; delivery hardening is
separate from catalog ownership and does not weaken intake validation.
