# Discovering Loom resources with wish

## Recommendation

Publish one **Loom resources piece** in each Loom space. It exports references
to the existing connector database handles, freshness cells, CFC context cells,
and people index. Publish a reference to that piece in the viewer's **home
favorites** once. Patterns in any authorized consumer space discover it with
`wish({ query: "#loom_resources_v1", scope: ["~"], headless: true })`,
requesting a `Writable<PerUser<LoomResourcesV1>>` projection.

The home space is the discovery point. Consumers need neither source-space DIDs
nor database IDs in their startup configuration. The favorite carries the
provider reference, including its original space. Require user-scoped discovery
and selection for this path; SQL results use `PerSession<>` where the inbox needs row filtering under its
runtime read ceiling.

Start with `cf-person-inbox`. Keep its person selection and session view as
explicit inputs. Resolve its environmental dependencies through the resources
piece, and retain explicit resource overrides for tests and specialized hosts.

Use Labs' existing wish, registration, cell-link, and SQLite machinery. No new
wish target, global registry, filesystem search, or startup dependency engine is
needed. Most implementation belongs in Loom. Cross-space SQLite reads require a
bounded Labs change to route through the referenced handle's source space;
compiled integration tests must establish that behavior and its authorization.

The daemon still registers external database files and publishes freshness.
Discovery removes consumer-specific linking; it does not replace those duties.

The
[investigation record](../history/development/2026-09-14-wish-resource-discovery.md)
contains the examined revisions, source evidence, and test results. This
document tracks the implementation and its remaining verification gates.

## Why a resources piece

The application wants a coherent environment: a database and its freshness
signal belong together, as do a handle and its CFC context. Resolving those
independently could mix two connections or two generations of a moved store. A
small resources piece provides that grouping without copying underlying data. It
is an ordinary provider pattern, discoverable through the existing space
mentionable index.

Use one provider for the first implementation because the inbox already has six
fixed source roles. One home wish discovers all source roles for a consumer and
user. Six differently tagged wishes would require six discovery scans; home-dependent
wishes execute under the demanding user rather than sharing an identity-free
resolver. The resources piece must remain small: only descriptors and
references, never message rows or a materialized copy of the people index.

This introduces one publication point per environment, not zero configuration.
The operator still decides which account is personal Gmail and which is work
Gmail. That decision belongs with the provider, where every consumer can reuse
it, rather than in each consumer's deployment record.

## Existing contracts to reuse

| Concern                | Existing surface                                              | Consequence                                                                     |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Discovery              | `wish` over favorites, mentionables, or profile elements      | Publish a provider; wish cannot find arbitrary stored cells or disk files.      |
| Home discovery         | Explicit `scope: ["~"]`                                       | Search the viewer's favorited provider references across source spaces.         |
| Consumer isolation     | `PerUser<>` projection and selection                          | Different viewers of a shared inbox resolve their own home resources.           |
| Publication            | Default pattern `addPiece`, then `backlinksIndex.mentionable` | A registered ordinary provider is enough; no direct write to the derived index. |
| Child publication      | A registered parent exports `mentionable`                     | Available if the provider later owns child providers.                           |
| Programmatic selection | `headless: true`, `candidates`                                | No suggestion sidecar; multiple matches still put the first match in `result`.  |
| Reference transport    | Schema-shaped wish links, nested `SqliteDb` fields            | Preserve handles as references, not serialized `{ id, tables, rev }` copies.    |
| Source registration    | `deriveDiskHandleId`, `registerSqliteDiskSource`              | Keep the stable handle and server-side path registration.                       |
| External changes       | Existing freshness cell and SQLite `reactOn`                  | Keep `{ gen, epoch }` as the query trigger.                                     |
| Query isolation        | Existing session-scoped query results                         | Preserve the inbox's ceiling-sensitive result scope.                            |

Hashtags are exact, case-insensitive terms, not structural interface matching.
Use underscores: the hashtag extractor ends a tag at a hyphen. The generic type
argument shapes reads; it does not prove a candidate implements the requested
interface. Filter candidates by the supported provider version; absent source handles remain unavailable.

## Provider contract

Define the shared types in Loom beside its existing connector-cell contracts.
The following is a contract sketch, not compiled pattern source:

```text
LoomResourcesV1
  version: 1
  name: human-readable provider name
  signal?: LoomSource
  imessage?: LoomSource
  whatsapp?: LoomSource
  telegram?: LoomSource
  gmailPersonal?: LoomSource
  gmailWork?: LoomSource
  peopleIndex?: reference to the existing keyed people-index cell

LoomSource
  db?: SqliteDb reference
  fresh?: reference to the existing freshness cell
  cfc?: reference to the context for this exact handle
```

Use a schema description containing `#loom_resources_v1` on the exported
provider type. Register a stable provider piece once through `addPiece`. Give it
an ordinary human-readable name and a minimal status UI, since headless wish
still reads the first candidate's UI field. Do not use mentionable index rows
with a reserved `piece` property for this provider: wish returns the matched
entry itself and does not implement the editors' row-unwrapping convention.

The provider's inputs point to existing cells. Its output forwards references.
The daemon owns source bindings and status; the people-index publisher remains
the sole writer of that map; freshness writers remain the sole writers of
freshness. Do not add a second writer through the provider.

Panel settings require a separate decision per consumer. The inbox declares
panel and CFC fields but its pattern body currently consumes only database,
freshness, and people-index inputs from that group. Migrate those actual reads
first. Keep the existing panel-config cell and host writer for connector panels.
Expose its reference in a later provider extension only where that shared UI
preference is intentional. Keep personal/session selections out of the
environment contract.

### Identity and updates

- Keep each disk handle's current `(space, canonical path)` identity and all
  existing labels, owner, scope, and revision data.
- Keep provider identity stable across restarts. Persist its address with the
  environment deployment metadata using the existing deployment lifecycle.
- Publish a source binding only after its registration succeeds. Replace the
  descriptor's handle, freshness reference, and CFC reference together in one
  transaction when their association changes.
- A path move changes handle identity. Publish the new handle's context even if
  it is empty; never retain the old handle's CFC context as a fallback.
- Removing a connection clears its binding or marks it unavailable and removes
  its usable handle. A disconnected consumer must stop showing prior rows as
  current data.
- `ready` records successful provisioning; it is not proof the current server
  still has an in-memory registration. Query probes/errors and reconnect
  recovery remain necessary after a silent toolshed restart.

## Consumer resolution

Call wish once at pattern level and keep its state reactive. Request a narrow
typed provider projection with optional source slots and a reference-shaped
people index. Do not call wish in a computed, handler, or per-row map.

Apply this selection policy in a small Loom helper or subpattern:

1. A complete explicit resource override wins for the corresponding source.
   Treat the handle and freshness/context as a bundle. Do not combine an
   override database with the discovered connection's freshness.
2. Otherwise use the sole compatible provider among the user's home favorites.
3. Zero candidates means resources are not available yet; show discovery status
   and let reactive updates resolve it.
4. Multiple compatible providers mean ambiguous configuration; show their
   names/identifiers and withhold automatic queries. Never silently use the
   first candidate. A typed tag alone is not an authority check.
5. Incompatible provider versions are excluded from selection. Missing source
   handles withhold that source's query; SQLite query errors remain visible.

Store the selected provider as a `Writable.perUser` cell reference. Compare
references with `equals`, including the source space and cell identity. A
selection is valid only while that provider remains a compatible candidate.
Do not infer account roles from discovery order, a filename, or a display name.
The provider exposes explicit Gmail slot-to-role assignments, initially
unassigned, and editable account labels for its setup UI.

### Home-space publication and discovery

The source environment deploys its provider through normal piece registration.
The signed-in user then adds that provider to home favorites once, using
`FavoritesManager.addFavorite` in
`packages/runtime-client/src/favorites-manager.ts`. Reuse its full piece
address, `favoriteKey`, and the home pattern's `addFavorite` handler. Do not
hand-write home internals or mirror the database cells into the home space.

The favorite must contain the normalized discovery tag `loom_resources_v1`. The
client can derive it from the provider schema or accept the explicit tag. Ensure
the schema/tag is available before first publication: the home handler seeds
tags only for a new entry, so re-favoriting an existing tagless entry does not
repair its tags. Test this case and provide an explicit metadata repair
preserving its reference and user tags if onboarding encounters it.

Offer this as a one-time setup action such as “Use these Loom resources”. It
adds the provider to the user's existing home favorites, where it remains
visible and removable. Do not republish it at every inbox startup or recreate an
intentionally removed favorite on the daemon's health cycle. Each viewer
publishes their own reference under their existing source access.

All inboxes use the same constant query and explicit `scope: ["~"]`. A missing
favorite shows setup/discovery status. A single compatible favorite resolves
automatically; multiple compatible providers require selection. Store that
selection per user in the consumer for the initial implementation. Do not
repurpose favorite list order as an environment preference or assume a global
home default that the current schema does not define.

Use `wish<Writable<PerUser<LoomResourcesV1>>>` and verify compilation
places `scope: "user"` at the requested schema root. The outer `Writable`
preserves a reference to the provider in its original scope; placing `PerUser`
outside `Writable` scopes the target instead. Candidates, errors, selected provider identity, and
downstream personal data must stay user-scoped or narrower. Narrow SQL results
further to session scope for the existing inbox ceiling contract.

`WishParams.scope` chooses the discovery collection; `PerUser<>` chooses the
reader's result instance. Keep the provider and handle in their original source
scopes: a user-scoped consumer projection must not create a new user-scoped
database or rewrite its references into the home or consumer space.

Do not expose a source-space list or combine local mentionables with favorites
in this product flow. Explicit resource overrides remain useful for fixtures and
specialized hosts, but everyday discovery always starts from home.

### Why favorites first

Favorites already supply home ownership, cross-space references, discovery tags,
identity deduplication, and removal. A separate home `resources` collection
would duplicate those mechanisms and require home-schema changes, publication
handlers, migration, and a new wish scope or target. It is unnecessary for the
initial implementation.

If resource connections later need a lifecycle distinct from visible favorites,
add an analogous home-owned collection as a separate extension, reusing the
favorite entry/link conventions and wish resolver machinery. Preserve the same
provider and consumer contract. Do not introduce it merely to hide the one-time
publication step; favorites are the chosen implementation for this plan.

Wire selected references into the existing query graph. Retain session scope,
SQL, identifier routing, row labels, and `{ gen, epoch }` reactivity. Do not
subscribe SQL to the entire provider or to `tickAt`: an unrelated provider
change or a badge-clock update must not rerun every inbox query.

The exact compiled expression for selecting an optional `SqliteDb` reference is
a first-stage acceptance test. Prefer ordinary property/reference access and the
existing SQLite builtin. If conditional method syntax loses the reference or
fails to activate after late discovery, use a fixed query node with a reactive
optional database input through the existing `sqliteQuery` surface. Do not
create an ad hoc JavaScript object that imitates a handle.

Suppress rendered stale rows whenever provider selection or source availability
is invalid, even if a query retains its previous result while inputs change.
Keep distinct UI states for discovery pending, configuration ambiguity, source
unavailable, query failure, and a successfully queried empty inbox. Wish has no
dedicated pending field; do not parse its error strings into a readiness API.

## Authority and scope

Discovery locates references. Authorization remains at the existing space, cell,
link, and SQLite boundaries. Restrict provider mutation to the trusted
provisioner under the deployment's current write policy. A match on the tag or
A provider name is not proof of publisher identity.

Cross-space mode is part of the pilot's acceptance criteria. The acting viewer
must be authorized to read the provider, its references, the source handle, and
the queried rows. `PerUser<>` separates result instances; it does not grant
access to another space. Source-space denial or revocation must suppress stale
rows and surface an access/query failure, never fall back to another account.
Preserve all CFC table contracts and run the same reader/ceiling cases through
discovery as through explicit links. The CFC context is descriptive input for
the lens; it must not grant authority.

Keep selected references, discovery diagnostics, and exported derived personal
data user-scoped or narrower throughout the consumer graph. The inbox's SQL
results, rendered row data, and ceiling-dependent UI remain session-scoped. Do
not write a viewer's selected provider or personal rows into a shared result
while exposing only the final wish slot as `PerUser<>`.

The provider must not expose host paths, credentials, or connector rows. The
people index must retain reference semantics and keyed reads. Provider metadata
itself may be sensitive and must use the same space/read policy as the resources
it describes.

### SQLite source-space routing

The disk registry is keyed by `(space, id)`. In
`packages/runner/src/builtins/sqlite-builtins.ts`, `sqliteQuery` resolves the
`db` input's source space and opens that space's storage provider. A descriptor
contains database identity and schema, while the cell reference supplies space.

Resolve the database input's canonical cell link under the query transaction
before dereferencing its descriptor. Derive the request's source space from that
link using existing cell/link resolution. Do not trust a pattern-supplied
`sourceSpace` string, or add host paths to the handle value. Register the disk
source once in its owning space; do not replicate its registration or handle
into each consumer space.

Route the read through the source space's existing storage provider and host
routing. Keep result publication, output scope, and execution ownership in the
consumer space. Include canonical source space and handle identity in request
hashing/memoization, alongside the existing reader/clearance dimensions, so
equal descriptor IDs in different spaces cannot share a query result. Capture
the resolved source alongside the staged request so an in-flight request cannot
be retargeted by a later selection change.

For server execution, foreign requests carry the demanding principal and the
session identity when needed. The source server accepts carriage only from a
configured delegating principal and checks both the serving session and the
reader's source READ access before and after SQLite I/O. Negotiation of the
`sqliteQueryReader` capability rejects older servers before sending a request
that could otherwise ignore that context.

Headless wish's shared resolver is limited to home-independent, space-scoped
searches. Home-dependent wishes use the demanding transaction directly. The
wish builder describes its actual `WishState` container, and internal derived
cells retain declared user/session scope through child-path bindings. Scoped
wish state also carries its owning result and pattern links for served demand.
A final `PerUser<>` annotation alone is insufficient evidence of isolation;
compiled and served regressions exercise the complete chain.

Cross-space references to freshness and the people index must subscribe through
normal Fabric reads. Keep the freshness publisher in the source environment;
prove its `{ gen, epoch }` update invalidates a remote consumer's query without
a second bridge writer. Test source and consumer on distinct hosts as well as
different spaces on one host; source paths remain local to the source host.

## Delivery boundary

The implementation PRs deliver the provider, home-favorite consumer selection,
source-space SQLite routing, authenticated reader propagation, and automated
regressions. Setup reuses the existing favorite UI. Real-space migration,
separate-host rollout rehearsal, and removal of wiring for other consumers are
follow-up stages; the acceptance matrix below also covers those rollout gates.

## Implementation sequence

### 1. Prove the composition in an isolated fixture

**Files:** a Loom test provider and consumer fixture; Labs runner integration
tests only if needed to isolate a platform defect.

- Compile a provider exporting a nested `SqliteDb` reference and freshness
  reference, and user-scoped consumers discovering it through home favorites.
  Exercise providers both in the consumer space and in another space.
- Seed a temporary SQLite file with distinguishable rows and a labeled column.
  Register it using the existing source path; publish the provider through the
  real default pattern, not a manually fabricated mentionable index.
- Add its reference through the real home favorites handler and resolve from a
  separate consumer space. Test two users with different home favorites, an
  unsigned viewer, an unavailable home space, and favorite removal/readdition.
  An unavailable home must not trigger a local-space discovery fallback.
- Inspect generated schemas and transformed output: the database field must
  preserve `asCell: ["sqlite"]`, and the forwarded handle must retain identity.
- Verify root user scope on cross-space wish output, isolation of candidates and
  selection for two users in one shared consumer, and preservation of the source
  handle's original space and scope.
- Reproduce the current query-routing gap with a database registered only in the
  source space. Add the regression test and implement source-link-based routing,
  request identity, and acting-reader propagation in Labs before declaring
  cross-space composition functional.
- Repeat with distinct hosts, same descriptor ID in two spaces, source access
  denial/revocation, and a source change during an in-flight query. Assert no
  consumer-space fallback database or registration is created.
- Start the consumer before publication, then publish, update freshness, replace
  the handle, introduce a duplicate provider, and remove the provider.
- Read a keyed people-index entry and inspect reads to rule out a whole-map copy
  or subscription introduced by the provider projection.
- Exercise both the actual Loom execution mode and server execution. Record the
  Labs revision used by each; a root checkout pass does not validate Loom's
  vendored copy.

**Exit:** real SQL results arrive and change reactively through the wish;
ambiguity/removal withholds results; references and CFC behavior survive in
home-discovered same-space and cross-space providers. Cross-space freshness and
two-viewer isolation must pass in served execution too. Any additional failure
gets a reduced Labs regression test before changing runtime code.

### 2. Publish resources once per environment

**Files in Loom:** `src/patterns/cf-loom-resources.tsx` (new), shared resource
types, deployment documentation, and their tests.

- Declare the provider's source stems with the existing `CONNECTOR_STORES`
  mechanism. Normal deployment registers and wires the provider using the
  existing connector catalog, path validation, deterministic handles, table
  contracts, freshness, CFC context, and people-index publisher.
- The provider is the single declared consumer. It can be deployed before any
  inbox, so source provisioning needs no inbox ID and no separate inventory
  registry or reconciler refactor.
- Expose the existing references as coherent source bundles. Preserve explicit
  account-role choices on the provider and existing direct consumer links during
  migration.
- Verify repeated deployment and reconciliation preserve source identity and
  propagate freshness through references without rewriting provider metadata.

**Exit:** a new generic consumer discovers resources without an entry containing
its piece ID or database field names in the daemon configuration.

### 3. Publish to home and convert person-inbox

**Files in Loom:** `src/patterns/cf-person-inbox.tsx`, the new resource helper,
and inbox pattern/browser tests.

- Add the one-time home-favorite setup action through the existing favorites
  client. Verify tag publication, duplicate addition, intentional removal, and
  the tagless-entry repair case without overwriting user tags.
- Add one pattern-level home wish and the explicit selection policy above.
- Add the user-scoped provider selector. Test one shared inbox whose two
  viewers select resources in different spaces.
- Replace the six database/freshness input pairs and people-index read source
  with selected references. Preserve the old fields as complete overrides during
  migration so existing deployments retain their behavior.
- Keep the host-provided `people`, session `view`, generated SQL, thread
  grouping, and query result scope. Store locally `picked` contacts per user:
  choosing a personal recent contact must not publish it into shared inputs.
  Existing shared picks require an explicit migration decision; do not silently
  copy them into every viewer's private state. Do not bundle the separate
  interaction-cost plan.
- Add discovery/source diagnostics and stale-row suppression.
- Remove this consumer's per-source linking configuration only after the
  discovery path has passed the same checks as the explicit path. Until then,
  overrides deliberately mask discovery in existing deployments; test new
  instances with no overrides to prove the new route.

**Exit:** after one-time home publication, a freshly deployed inbox needs only
application inputs; connector arrival, freshness, restart recovery, and
connection changes work without consumer-specific relinking.

### 4. Rehearse migration and rollback

- Follow [space clone rehearsal](../development/space-clone-rehearsal.md) before
  updating a populated piece. A Fabric clone does not copy external connector
  SQLite files: snapshot/register separate fixture copies too.
- Record input links, people selections, session behavior, provider identity,
  handle identity, and row/label results before and after the update.
- Rehearse a consumer in a separate space against a cloned source space on a
  separately addressed test host. Preserve and restore per-user provider
  selections as part of rollback; do not grant new source access implicitly.
- First deploy the provider, then the compatible inbox source, then retire the
  old consumer-link declarations and clear only migrated resource inputs.
- Publish and verify the user's home favorite before clearing those overrides.
  Preserve all unrelated favorites and do not remove the shared provider on
  rollback; other consumers may already depend on it.
- Compare row identities and errors against the explicit-link baseline for all
  configured services, including both Gmail roles.
- Roll back by restoring recorded resource links and the prior consumer
  source/configuration. Keep underlying handles and connector databases intact.

**Exit:** migration and rollback preserve user state, source contracts, and
account routing. Live deployment and migration rehearsal remain separate rollout work.

### 5. Extend and remove redundant wiring

Migrate other connector panels individually. Move panel settings only after
their ownership semantics are explicit. Delete per-consumer `db_field`,
`fresh_field`, and related link loops after their last consumer migrates; retain
source provisioning, contract validation, relink handling, registration
recovery, and freshness publication.

The reconciler contains health polling, deadlines, and retry machinery. A
separate agent investigation could replace eligible waits with connector and
reconnect events, following the repository's waiting guidance. Do not remove the
restart recovery backstop merely because discovery succeeds: it protects an
independent disk-registration lifecycle. Persistent registration and native
external-write invalidation are separate Labs projects.

## Acceptance matrix

| Scenario                           | Required result                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Consumer starts first              | Pending discovery, then rows without reload after publication.                         |
| Exactly one compatible provider    | Correct six role bindings; only configured sources query.                              |
| Two providers                      | Explicit ambiguity; no first-match account selection.                                  |
| Wrong version/missing binding      | Incompatible providers excluded; missing handles withhold source queries.               |
| Provider/source removed            | Prior rows cease to be presented as current.                                           |
| Database appears late              | Registration then publication activates the source.                                    |
| External writer commits            | `gen`/`epoch` update reruns affected queries.                                          |
| Only `tickAt` changes              | No SQL requery.                                                                        |
| Toolshed restarts                  | Existing registration recovery and query invalidation restore rows.                    |
| Path/connection changes            | Handle and context remain paired; no old-account rows.                                 |
| Two consumers                      | Same handle/freshness refs; no new consumer wiring.                                    |
| Two viewers/ceilings               | Same isolation and admission as explicit-link baseline.                                |
| Explicit override                  | Whole override bundle wins without mixed freshness.                                    |
| People index                       | Keyed reads, no provider-driven full-map materialization.                              |
| Cold reload                        | Provider remains discoverable through real publication machinery.                      |
| Home publication                   | One favorite enables new consumers without source-space or database configuration.     |
| Favorite in another space          | Viewer-specific provider found without embedding its DID in shared inputs.             |
| Home discovery shared projection   | Consumer declares a user-scoped wish schema and selection; compilation is tested.                |
| Two users in one serving runtime   | Candidates, selected refs, errors, caches, and rows remain isolated.                   |
| Same handle ID in two spaces       | Distinct query/memo identities and correct source rows.                                |
| Distinct source and consumer hosts | Source host executes SQL under authorized reader context; results publish to consumer. |
| Source permission revoked          | No stale rows, account fallback, or service-identity privilege substitution.           |
| Remote freshness update            | Only the affected consumer queries rerun without a bridge writer.                      |
| Source switched during query       | Previous completion cannot populate the newly selected source's result.                |

Measure startup link commits and time to usable inbox at one and several
consumers. Count wish scans, SQL requests, and steady-state writes. Expect
consumer wiring to scale with sources rather than sources multiplied by
consumers; do not claim a wall-clock speedup without measurement. One catalog
wish is still a scan over the space's mentionables and can be expensive in a
large space.

For implementation, run each touched package's tests, relevant compiled pattern
and browser tests, authoritative pattern checking, repo-wide formatting and
lint, and applicable documentation gates before commits. Any Labs code change
also requires the writing-code and cf-review workflows. Tests should wait for
actual publication/query events or runtime settlement, not sleeps.

## Bounded Labs changes

1. Route SQLite reads using the canonical database input link's source space,
   include it in memo/request identity, and preserve acting-reader authority
   across the existing storage boundary. Cover local, cross-space, and
   distinct-host cases; update the SQLite source and transaction documentation.
2. Ensure user-scoped headless wish intermediate state and shared resolver
   caches cannot mix principals. Prefer existing scoped-cell machinery; bypass
   sharing for this mode if that is the smaller correct implementation.
3. Repair nested `SqliteDb` reference projection or late-binding behavior if the
   compiled fixture demonstrates a failure. Add the narrow regression test and
   update the owning API documentation in the same change.
4. Document the headless first-result behavior and underscore tag convention
   with the provider example when it is executable.
5. Consider an additive strict-single selection option only after another
   independent consumer needs it. The initial implementation can inspect
   `candidates`; changing global wish selection is unnecessary.

Do not add a `#sqlite` builtin, let patterns select filesystem paths, broaden
default wish scope, implement structural schema search, or persist new disk
registrations as part of this work.
