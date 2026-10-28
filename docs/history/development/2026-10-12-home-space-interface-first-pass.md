---
status: historical
created: 2026-10-12
archived: 2026-10-12
reason: "Local implementation and validation snapshot of the Home interface first pass."
superseded-by: "docs/features/shared-space-catalog.md"
---

# Home interface first pass

Prepared locally on `codex/home-space-interface`, stacked on the FabriChat
private-catalog fix and its review follow-up at `419c65eec6`. The user requested
an unattended first pass and no further pushes. This snapshot records work in
the local branch; it is not a deployment or a switch of native collection
authority.

## Implemented surface

Home publishes `sharedSpaces`, with independent collection-view,
offer-receipt, command, and import-undo roles. The catalog keeps its owned
`sharedSpaceCatalog` backing cause. Flat fields remain aliases over the same
current storage and command streams. Registration and membership rules stay in
authored Home code, including target validation, offer deduplication,
revision comparisons, extension retention, and ordinary handling receipts.

The read model distinguishes ready, loading, and malformed observations. It
offers keyed entries and saved, archived, and unfamiliar-state partitions,
both across the collection and per kind. Admission hints determine list order,
with a deterministic DID tie-breaker. Kind grouping takes one pass over entries.
The `home-schemas` package publishes host projections of the individual roles.

Home's Social spaces tab provides search, kind and membership filters, space
navigation, archive, and restore. Filters are session-local. Choices use the
revision copied into the rendered control's event, and a stale choice produces
a conflict notice. Listing does not load target roots or change routing or ACLs.

FabriChat publishes separate manager commands and private observations. Its room
passes these roles independently through its core and member controls. Shared
record handlers receive command bindings; observations stay in the rendering.
Flat-manager inputs remain usable, including an absent manager.

The live contract and usage paths are described in
[`shared-space-catalog.md`](../../features/shared-space-catalog.md).

## Validation

- System authored tests: the 18-entry suite passed 245 assertions under strict
  CFC enforcement and persisted flow labels, and the additional session test
  passed five assertions. Two sessions of the same owner retain independent
  filters while observing the same archive, including the first session's view
  after the second session has rendered.
- All 22 FabriChat authored test entries: 181 assertions passed under that same
  posture.
- Patterns package: 60 unit tests with 408 steps and its headless browser test
  passed. Home-schema package: six existing schema-package test steps passed.
- The Home catalog integration cases cover withheld peer writes, rejected
  optimistic predecessors, held serving commits, denied and cold loads,
  retained constructor state, extension fields, future states, malformed input,
  concurrent choices, and durable receipts.
- The new boundary case runs with serving execution on and off. A social-space
  consumer writes shared records and sends Home registration through a narrow
  command binding. A consumer discovering `#default/sharedSpaces/commands` in
  the actor's Home does the same. A control that explicitly reads a private
  collection observation is refused by CFC and saves no shared message.
- Four recorded Home vintages replayed with no held state stranded. In a local
  diagnostic, Home updated from the stack's base Home source retained all three
  flat command paths, and a caller retaining the registration path successfully
  registered after the update. Resolved endpoint IDs are source-specific;
  consumers retain the role path and follow its published bindings.
- Workspace formatting, lint, and type checks passed. Final Home, collection,
  and FabriChat contracts passed compatibility against recorded baselines.
  Documentation checks passed all 637 checked blocks; pattern-tier checks passed.

## Remaining product integration

Native Loom and Weaver collection authority is not switched by this change.
Their adapters still need last-confirmed projection retention, transport and
access failure states, compatible-Home readiness evidence, pending command
recovery, and receipt-based completion across restarts. The existing
[`integration plan`](../../plans/shared-space-catalog-pattern-access.md) specifies
that evidence. Private, unshared looms remain outside catalog migration.

Ordinary shell navigation uses the configured runtime routes; catalog admission
does not install or overwrite a routing hint. Foreign-host opening and route
repair belong to the native resolver integration. Catalog compaction and
destructive account recovery each need their own contract.

The flat catalog fields remain compatibility surfaces. Removing them requires
consumer adoption and a separately reviewed migration. No CFC ruling, runtime
enforcement mode, account ACL, deployed Home, or live social loom was changed.
Deployment requires the repository's populated-space clone rehearsal; this
local first pass uses synthetic stores and recorded vintages.
