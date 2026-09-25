# Experimental Flags Registry

This is the single central registry of experimental flags in the repository. An
experimental flag is a toggle that gates the incremental rollout of an
in-progress feature: it lets the new behavior ship in a dormant state, be
enabled deliberately for testing or dogfooding, and be graduated to always-on
(or removed) once the feature is finished.

There is no single place in the code that enumerates every flag, because flags
live in different layers (the runner, the memory protocol, the storage layer,
and the shell). This document is the human-maintained index that ties them
together. If you add, change, graduate, or remove a flag, update this document
in the same change.

> **Maintaining this document.** Each section records who added the flag, what
> it gates, its current default, its intended end state, and the concrete path
> to removing it. When you touch a flag, update its section and the summary
> table, and move the date and status line forward. When you delete a flag, move
> its section to
> [Appendix A: Removed and never-shipped
flags](#appendix-a-removed-and-never-shipped-flags) rather than deleting the
> record, so the history stays discoverable.

**Last reviewed:** 2026-09-21. Each flag's section carries the date its status
was last checked against the code.

## Summary table

| Flag                                                                        | Toggle via                                                                                                                                      | Default today                                                                        | Originally added by                                   | Planned end state                                                                                                                                                                                                                 | Status                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`modernCellRep`](#moderncellrep)                                           | `EXPERIMENTAL_MODERN_CELL_REP` env, or `RuntimeOptions.experimental`                                                                            | off                                                                                  | Dan Bornstein (#3818)                                 | graduate to always-on, then delete flag                                                                                                                                                                                           | implemented, off by default                                                     |
| [`contentAddressedSchemas`](#contentaddressedschemas)                       | `EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS` env / shell build define, or `RuntimeOptions.experimental`                                                                  | on                                                                                   | Robin McCollum (PR #5833)                             | finish the spec's Phase 3 (retire transport schema compression for link positions), then delete flag                                                                                                                              | implemented, on by default                                                      |
| [`commitPreconditions`](#commitpreconditions)                               | `RuntimeOptions.experimental` only (mapped `null` — programmatic rollback override — in the canonical env registry)                             | on                                                                                   | Bernhard Seefeld (#4090)                              | fold into base scheduler semantics, then delete flag                                                                                                                                                                              | implemented, on by default                                                      |
| [`plainResultReceipts`](#plainresultreceipts)                               | `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` env, or `RuntimeOptions.experimental`                                                                      | on                                                                                   | Mike Salisbury (verb contract WS-C)                   | fold into receipt semantics and delete flag after a bake period                                                                                                                                                                   | implemented, on by default                                                      |
| [`computedCellIds`](#computedcellids)                                       | `EXPERIMENTAL_COMPUTED_CELL_IDS` env, or `RuntimeOptions.experimental`                                                                          | on                                                                                   | Robin McCollum (#4659)                                | graduate to unconditional behavior, then delete flag                                                                                                                                                                              | implemented, on by default                                                      |
| [`lazyMaterialization`](#lazymaterialization)                               | `EXPERIMENTAL_LAZY_MATERIALIZATION` env, or `RuntimeOptions.experimental`                                                                       | on                                                                                   | Bernhard Seefeld                                      | fold into base read semantics, then delete flag                                                             | implemented, on by default                                         |
| [`readerSchemaPrecedence`](#readerschemaprecedence)                         | `EXPERIMENTAL_READER_SCHEMA_PRECEDENCE` env, or `RuntimeOptions.experimental`                                                                   | on                                                                                   | Robin McCollum (#6338)                                | graduate to unconditional behavior, then delete flag                                                                                                                                                                              | implemented, on by default                                                      |
| [`viewScopedReplication` / `webViewScopedReplication`](#viewscopedreplication--webviewscopedreplication) | `EXPERIMENTAL_VIEW_SCOPED_REPLICATION` / `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION`, or `RuntimeOptions.experimental` | global off; web inherits global | Bernhard Seefeld (2026-09-09) | validate view selection and guarded previews, then graduate per client class | experimental, off by default |
| [`viewScopedReplicationV1`](#viewscopedreplicationv1) | Memory hello capability | available when server execution is on | Bernhard Seefeld (2026-09-09) | retain as protocol negotiation until older clients and servers retire | optional capability |
| [`serverExecution`](#serverexecution) | `EXPERIMENTAL_SERVER_EXECUTION` env, or `RuntimeOptions.experimental` | **off** (`SERVER_EXECUTION_DEFAULT_ENABLED = false`; explicit `true` selects the other arm) | Bernhard Seefeld (#5339, server-execution v2 plan Phase 1 stage A; Phase 7 flip-ready #5849) | soak on main at the ON default, then delete the flag and OFF path | Serving stack and OW28 scoped compilation have direct coverage; Phase-7 gate dispositions govern a renewed rollout; the section's dated entries carry each flip; stable `default`/`opposite` CI roles keep both postures guarded and make a default flip data-only |
| [`agentBuiltin`](#agentbuiltin) | `EXPERIMENTAL_AGENT_BUILTIN` env, or `RuntimeOptions.experimental` | on | Bernhard Seefeld (agent requests stage 3) | delete the flag after the default-on posture soaks | implemented, on by default |
| [`cfcEnforcementMode`](#cfcenforcementmode)                                 | `RuntimeOptions.cfcEnforcementMode` (`CF_CFC_MODE` in the cf-harness / fuse)                                                                    | `enforce-strict`                                                                     | Bernhard Seefeld (#3263)                              | the ladder stays; the default is at its top rung                                                                                                                                                                                  | implemented, on by default at the strictest rung                                |
| [`cfcFlowLabels`](#cfcflowlabels)                                           | `RuntimeOptions.cfcFlowLabels`                                                                                                                  | `persist`                                                                            | Bernhard Seefeld (#4011)                              | move toward `persist`                                                                                                                                                                                                             | implemented, on by default at `persist`                                         |
| [`cfcWriteFloor`](#cfcwritefloor)                                           | `RuntimeOptions.cfcWriteFloor`                                                                                                                  | `enforce`                                                                            | Bernhard Seefeld (#4479)                              | move toward `enforce`                                                                                                                                                                                                             | implemented, on by default at `enforce`                                         |
| [`cfcTriggerReadGating`](#cfctriggerreadgating)                             | `RuntimeOptions.cfcTriggerReadGating`                                                                                                           | `true`                                                                               | Bernhard Seefeld (#4488)                              | move toward `true`                                                                                                                                                                                                                | implemented, on by default                                                      |
| [`cfcDecomposedEnvelopes`](#cfcdecomposedenvelopes)                         | `RuntimeOptions.cfcDecomposedEnvelopes`                                                                                                         | `false`                                                                              | Robin McCollum (CT-2062)                              | move toward `true` once every deployed reader resolves the references a stored root carries                                                                                                                                      | implemented, off by default                                                     |
| [`cfcContentAddressedLabels`](#cfccontentaddressedlabels)                   | `RuntimeOptions.cfcContentAddressedLabels`                                                                                                      | `false`                                                                              | Bernhard Seefeld                                      | move toward `true` once every deployed reader interprets version-2 envelopes                                                                                                                                                     | implemented, off by default                                                     |
| [`cfcPolicyEvaluation`](#cfcpolicyevaluation)                               | `RuntimeOptions.cfcPolicyEvaluation`                                                                                                            | `enforce`                                                                            | Bernhard Seefeld (#4566)                              | move toward `enforce`                                                                                                                                                                                                             | implemented, on by default at `enforce`                                         |
| [`cfcDeclaredMonotonicity`](#cfcdeclaredmonotonicity)                       | `RuntimeOptions.cfcDeclaredMonotonicity`                                                                                                        | `observe`                                                                            | Bernhard Seefeld (#4647)                              | `observe` first, then `enforce` (must soak before the §8.12.7 route 2b event ships)                                                                                                                                               | implemented, on by default at `observe`                                         |
| [`cfcPrefixProvenanceStats`](#cfcprefixprovenancestats)                     | `RuntimeOptions.cfcPrefixProvenanceStats` (per-deployment; not env-wired)                                                                       | `false`                                                                              | Bernhard Seefeld (#4623)                              | stays a measurement opt-in; fold in or remove after Stage 0                                                                                                                                                                       | implemented, off by default, measurement only                                   |
| [`cfcLabelMetadataProtection`](#cfclabelmetadataprotection)                 | `RuntimeOptions.cfcLabelMetadataProtection`                                                                                                     | `enforce`                                                                            | Bernhard Seefeld (#4638)                              | `observe` (divergence counting) first, then `enforce`                                                                                                                                                                             | implemented, on by default at `enforce`                                         |
| [`conflictAdmissionMode`](#conflictadmissionmode)                           | `CF_CONFLICT_ADMISSION` env, or `setConflictAdmissionMode()`                                                                                    | `off`                                                                                | William Kelly (#4237); `hold` removed CT-1925 (#5110) | keep `preempt` as a tuning dial or remove after re-measurement                                                                                                                                                                    | implemented, off by default, measured net-negative                              |
| [`syncSchemaTableV2`](#syncschematablev2)                                   | `setSyncSchemaTableConfig()` (negotiated per connection)                                                                                        | on                                                                                   | Ben Follington (#4292)                                | retire the negotiation once every peer speaks v2                                                                                                                                                                                  | implemented, on by default                                                      |
| [`messageCompressionV1`](#messagecompressionv1)                             | `setMessageCompressionConfig()` (negotiated per connection)                                                                                     | on                                                                                   | PR #6474                                             | retire the rollback switch after the binary WebSocket envelope has field-soaked                                                                                                                                                   | implemented, on by default                                                      |
| [`ownWriteEcho`](#ownwriteecho)                                             | `setOwnWriteEchoConfig()` (server-side only, not negotiated)                                                                                    | on                                                                                   | Robin McCollum (CT-1965)                              | remove the switch once the echo has field-soaked                                                                                                                                                                                  | implemented, on by default                                                      |
| [`experimentalConcurrentWatchRefresh`](#experimentalconcurrentwatchrefresh) | `IRemoteStorageProviderSettings`; in the shell, the `commonfabric.concurrentWatchRefresh()` console command (localStorage, per browser profile) | off                                                                                  | Ben Follington (#4937; shell toggle #4974)            | graduate to always-on after live measurement, or remove if superseded                                                                                                                                                             | off by default; acquisition/removal ordering tested; real-latency measurement pending |
| [`cfcRenderCeiling`](#cfcrenderceiling)                                     | `commonfabric.cfcRenderCeiling()` in the browser (localStorage)                                                                                 | on                                                                                   | Bernhard Seefeld (#4550)                              | graduate to an unconditional ceiling                                                                                                                                                                                           | implemented, on by default; per-profile opt-out                                 |
| [`INGEST_SELF_SERVE_ENABLED`](#ingest_self_serve_enabled) | `INGEST_SELF_SERVE_ENABLED` env on toolshed | off | Alex Komoroske (self-serve ingest channels) | graduate on once named-space keys stop deriving from a public passphrase | implemented, off by default |
| [`SERVER_EXECUTION_STORE_READ_THROUGH`](#server_execution_store_read_through) | `SERVER_EXECUTION_STORE_READ_THROUGH` env on toolshed, or `SpaceServerPolicy.storeReadThrough` | off | Bernhard Seefeld (store read-through) | soak with the posture forced on, flip on, then delete the knob and the home-space session read path | implemented, off by default |
| [`fuseNfsCacheTuning`](#fusenfscachetuning)                                 | `cf fuse mount --attrcache-timeout <whole seconds; 0 = untuned>` or `--noattrcache`                                                             | cf adds `attrcache-timeout=1` (one second) to FUSE-T mounts                          | Ian Hickson                                           | keep the default; shrink the exec.ts listing-recheck delay once the default has field-soaked                                                                                                                                      | implemented, on by default for FUSE-T, soak-validated                           |

Removed or never-shipped flags that documentation elsewhere still references are
recorded in [Appendix A](#appendix-a-removed-and-never-shipped-flags). Toggles
that look like flags but are operational, debugging, or test controls rather
than experimental-feature gates are listed in
[Appendix B](#appendix-b-related-toggles-that-are-not-experimental-flags).

---

## Category 1: Runtime experimental options

These flags make up the `ExperimentalOptions` interface in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). They
are passed as `new Runtime({ experimental: { ... } })`. Each flag defaults to
`undefined`, which means "take the built-in default". `commitPreconditions`,
`contentAddressedSchemas`, `plainResultReceipts`, `computedCellIds`,
`lazyMaterialization`, `readerSchemaPrecedence`, and `agentBuiltin` default on;
`serverExecution` resolves an unset flag to the ONE first-party default
`SERVER_EXECUTION_DEFAULT_ENABLED` in the deployed-topology presets (the
summary table above states its current value and its section carries the
dated history), with an explicit value selecting either arm regardless (the
single-process presets read no default and stay OFF — the section says how);
the other flags in
this category default off unless their section says otherwise.

The mapping from environment variable to flag is defined once, canonically, as
`EXPERIMENTAL_ENV_VARS` in
[`packages/runner/src/experimental-posture.ts`](../../packages/runner/src/experimental-posture.ts),
and read by `experimentalOptionsFromEnv(envReader)`. The toolshed, the CLI, and
the background piece service all go through that one mapping, so their wirings
cannot drift; the shell reads the same variables from its build-time defines
through the same canonical parser, for the flags it defines;
`packages/shell/felt.config.ts` and `packages/shell/src/lib/env.ts` are the
authority on which those are. A CI lane builds the binaries it caches with
every define's variable unset unless `cachedBinaries()` in
[`tasks/ci-capabilities.ts`](../../tasks/ci-capabilities.ts) sets it, so a lane
that needs a flag in its baked shell names it there.
`EXPERIMENTAL_ENV_VARS` itself is the authority on
which flags are env-reachable — a flag that deliberately is not,
`commitPreconditions` today, is mapped to `null` there, which records the
decision rather than leaving an omission. The mapping accepts exactly `"true"`
and `"false"`; any other value is ignored with a warning rather than coerced.
See [How flags propagate](#how-flags-propagate).

A client that is not built alongside the server it talks to — the `cf` binary
among them — starts from the posture that deployment publishes rather than
from its own environment, with an explicit `EXPERIMENTAL_*` still winning per
flag. Which flags it takes that way is the second registry in the same file,
`EXPERIMENTAL_FLAG_AUTHORITY`; see
[Clients that are not built alongside their
server](#clients-that-are-not-built-alongside-their-server).

### `modernCellRep`

- **Toggle via.** `EXPERIMENTAL_MODERN_CELL_REP` environment variable (through
  the canonical mapping described in the category note above), or directly
  through `RuntimeOptions.experimental.modernCellRep`. The ambient control point
  is `setModernCellRepConfig` in
  [`packages/data-model/src/cell-rep.ts`](../../packages/data-model/src/cell-rep.ts).
- **Added by.** Dan Bornstein, in "Define a new 'modern cell representation'
  experiment flag" (#3818, 2026-06-02).
- **Purpose.** Switches the data model over to the new "cell representation"
  classes and their serialized form. In the modern form a link serializes as a
  `FabricHash`; in the legacy form it serializes as the older
  `{ "/": "<tag>:<hash>" }` object. The flag lets both encodings coexist while
  the format transition happens.
- **Current default and planned end state.** Off by default. The plan is to
  graduate it to always-on once every client and server produce and accept the
  modern encoding, and then delete the flag along with the legacy object-form
  code paths.
- **Status on 2026-07-08.** Implemented and gated on both sides: the data-model
  dispatch reads the ambient flag, and the memory wire protocol carries a
  `modernCellRep` capability that peers must agree on
  (`compatibleMemoryProtocolFlags` requires the two sides to match). Off by
  default. The dedicated plumbing test
  (`packages/runner/test/experimental-options.test.ts`) passes.
- **Path to removal.** Turn the default on and let it soak; confirm every peer
  in the fleet negotiates `modernCellRep` true; then delete the flag, the legacy
  `{ "/" }` serialization branches in `cell-rep.ts`, and the protocol-capability
  negotiation for it.

### `contentAddressedSchemas`

- **Toggle via.** `EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS` environment variable
  (through the canonical mapping described in the category note above), the
  shell build define of the same name (baked at build time through
  `packages/shell/felt.config.ts` and read by `packages/shell/src/lib/env.ts`),
  or directly through `RuntimeOptions.experimental.contentAddressedSchemas`.
  The ambient control point is `setContentAddressedSchemasConfig` in
  [`packages/runner/src/schema-doc-config.ts`](../../packages/runner/src/schema-doc-config.ts).
- **Added by.** Robin McCollum (PR #5833).
- **Purpose.** Phases 1 and 2 of
  [content-addressed schemas](../specs/content-addressed-schemas.md), which
  deploy together: link writers replace inline schemas with
  `{ "$ref": "cid:<hash>" }` references to content-addressed schema
  documents, whose closure is installed into the destination space in the
  same transaction as the reference, and a result document's `schema`
  metadata (the result schema a piece's setup writes, a receipt's shape)
  takes the same reference form through the same staging; `$alias`
  bindings stamp the same
  references at pattern serialization, resolving through the realm
  registry (an alias is a binding only by context — the storage layer
  treats `$alias`-shaped records as plain data); and watch/sync selectors
  normalize for the wire — the reference form only when the client
  confirmed the whole closure persisted in the target space
  (server-confirmed replica presence implies server presence), and the
  fully inline form otherwise, recomposed through the realm registry when
  the schema itself carries references (a live pattern's binding schema
  reaches selectors before any document holds it). Gates emission only —
  readers and the server accept both forms unconditionally, so old data
  keeps reading throughout the rollout, and the server answers an
  unresolvable selector reference with a loud QueryError, which a
  compliant client never provokes; a schema decomposition refuses stays
  inline exactly as with the flag off. A reference in `schema` metadata
  is delivered like a link's: the server ships its closure with the
  document, and a client validates the member on arrival, so a server
  deploys this behavior before the clients that write the reference. The
  rollout is one-way: the flag
  turns on only once every deployed client is a reader, and references
  written under it persist, so turning it back off stops emission without
  un-writing anything.
- **Interaction with `syncSchemaTableV2`.** Both mechanisms dedupe the same
  link-schema positions, and they compose: the table encoder skips
  reference-only positions (`{ "$ref": "cid:…" }` is already smaller than
  a table ref), so over reference-bearing frames the table approaches a
  no-op, while stored links minted before this flag still carry inline
  schemas that only the table compresses in flight. A Runtime therefore
  leaves the table's negotiation untouched; the table retires through the
  spec's Phase 3 — by ceasing to match once reference-bearing links
  dominate — not by a construction-time switch.
- **Current default and planned end state.** On by default, everywhere.
  An explicit `false` (env for servers and CLI, build define for the
  shell) is the rollback override: it stops emission without un-writing
  anything, and old inline links keep reading forever, aging out through
  pattern re-instantiation. Phases 1 and 2 both ship behind this flag;
  what remains is the spec's Phase 3 (retiring transport schema
  compression for link positions), then deleting the flag.
- **Status on 2026-08-19.** Phases 1 and 2 implemented (#5878, #6011), on
  by default. The flag-off behaviors stay pinned by runner tests that pass
  `false` explicitly, which is also the rollback override.
- **Status on 2026-09-11.** A result document's `schema` metadata takes the
  reference form under the flag (#7299), delivered and validated like a
  link position; the flag-off path keeps it inline.

### `plainResultReceipts`

- **Toggle via.** `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` env var, or
  `RuntimeOptions.experimental.plainResultReceipts`. The env mapping accepts
  exactly `"true"` and `"false"` (the category's canonical parsing: any other
  value — `1`, `yes`, `TRUE` — is ignored with a warning, leaving the built-in
  default in place), so the opt-out while the flag exists is an explicit
  `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false`.
- **Added by.** Mike Salisbury, verb-contract WS-C
  (`docs/history/plans/pattern-verb-contract-implementation.md`).
- **Purpose.** A handler's return value containing reactives/cells projects into
  its per-event receipt cell via the result-pattern path, but a **plain JSON
  return is discarded** — the receipt-only branch writes `{}`. Under this flag
  the receipt carries the (already-normalized) return instead, so a caller — or
  a same-id retry that collides on the create-only receipt — can read the verb's
  result back by receipt address. `{}` remains the shape for value-less
  handlers. The value goes through the receipt cell's standard write flow (`set`
  → `diffAndUpdate`), the same conversion any cell write gets: plain JSON
  persists as-is and a live `Cell` handle converts to a link — so a one-line
  setter verb (`action(() => cell.set(...))`, whose expression body implicitly
  returns the cell `set()` hands back for chaining) records a link to the
  mutated cell in its receipt. Receipts reflect what was returned. Requires
  `commitPreconditions` (the receipt write itself) to be active, which it is by
  default.
- **Current default and planned end state.** On by default. The gate the plan's
  governing decision 2 set — the integration suite proving readback end to end —
  was satisfied by the three-topic fixture (#5244): caller-supplied event id, a
  dropped-response retry and a same-id replay with a different payload, both
  reading the ORIGINAL declared result back off the receipt, cross-process
  against an isolated toolshed. An explicit `false` (env or programmatic)
  remains a rollback override while the flag exists. After a bake period the
  behavior folds into base receipt semantics and the flag is deleted.
- **Status on 2026-08-03.** Implemented, on by default (default flipped after
  #5244's proof; the receipt write's standard-flow conversion landed separately
  in #5262). Both flag states are pinned in
  `packages/runner/test/scheduler-event-receipts.test.ts` and
  `packages/runner/test/declared-result-e2e.test.ts`; the flag-off cases pass
  `plainResultReceipts: false` explicitly.
- **Path to removal.** Let the default-on behavior soak; then delete the flag
  and make the projection unconditional in `handleJavaScriptHandlerResult`'s
  receipt-only branch, remove the env mapping and the explicit-off tests, and
  update the receipt content note in `docs/specs/scheduler-v2/README.md` §7.6.

### `commitPreconditions`

- **Toggle via.** `RuntimeOptions.experimental.commitPreconditions` only. It has
  no environment variable today: it is mapped to `null` in the canonical
  `EXPERIMENTAL_ENV_VARS` registry, which puts "not env-reachable" on the record
  as a deliberate choice rather than leaving it absent from one wiring. The
  built-in behavior is enabled; an explicit `false` is a programmatic rollback
  override while the flag remains. The ambient control point is
  `setCommitPreconditionsConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts).
- **Added by.** Bernhard Seefeld, in "speculation lineage for event-launched
  work (scheduler-v2 E1)" (#4090, 2026-06-12).
- **Purpose.** Attaches origin-committed preconditions to scheduler-v2 lineage
  commits, so that event-launched follow-up work commits only against the state
  it was speculated from; create-only preconditions to durable event result
  receipts so competing runners cannot overwrite an existing terminal receipt;
  and, since #4649, create-only consumption receipts for **single-use CFC
  grants** (`docs/specs/cfc-persisted-declassification.md` §2.2).
- **Current default and planned end state.** On by default as part of
  scheduler-v2 speculation lineage and receipt enforcement. An explicit
  programmatic `false` remains a rollback override; under that override,
  single-use grants fail closed rather than silently becoming multi-use, and no
  handling publishes a receipt address on its transaction
  (`tx.handlingReceiptLink` stays absent) — nothing creates or create-only marks
  that cell while the flag is off, so an address would name a witness that does
  not exist. The planned end state is to remove the rollback flag and make the
  behavior unconditional.
- **Status on 2026-07-10.** Implemented for lineage commits and event-result
  receipts, single-use grant consumption, and the memory protocol; on by
  default, with explicit programmatic opt-out retained temporarily.
- **Path to removal.** This exists to serve scheduler-v2 speculation lineage,
  durable event receipts, and single-use CFC grant consumption. It can be
  deleted only when lineage and create-only receipt enforcement are
  unconditional base semantics. At that point remove the flag, the lineage and
  receipt precondition attachment, the storage transaction wiring, and the
  server-side precondition check in the memory engine. The single-use grant path
  then drops its availability check (`cfcGrantReceiptsAvailable` in
  `packages/runner/src/cfc/grants.ts`), not the receipts themselves.

### `computedCellIds`

- **Toggle via.** `EXPERIMENTAL_COMPUTED_CELL_IDS` environment variable (through
  the canonical env registry) or `RuntimeOptions.experimental.computedCellIds`.
- **Added by.** Robin McCollum, in #4659 (spec:
  [`docs/specs/computed-cell-identity.md`](../specs/computed-cell-identity.md)).
- **Purpose.** Mints kind-schemed entity ids (`computed:fid1:<hash>`, the
  `computed:` URI scheme replacing `of:`) for derived internal cells. The
  builder classifies written internals as computed by default, then applies
  conservative writer- and input-side disqualifiers. These include streams;
  handler, effect, opaque, and non-replayable writers; and roots
  handed writable to handlers, sub-patterns, sub-pattern operations, or
  non-replayable builtins. The linked spec is the exhaustive classifier
  reference. The flag gates minting only; readers accept both id forms
  unconditionally, so it can flip either way without a migration — but see the
  version-skew note below.
- **Current default and planned end state.** On by default. An explicit `false`
  remains a rollback override for version skew while the flag soaks; clients
  predating the `computed:` scheme throw on such ids arriving via sync (old
  servers are safe — an unknown scheme parses as no kind and stays strict). Once
  the rollout is stable, make minting unconditional and delete the flag. The
  computed-cell write-conflict policy (ack-and-drop for stale all-computed
  commits) remains a separately gated follow-up.
- **Status on 2026-07-23.** Kind-schemed minting landed in #4659 and is on by
  default. Readers accept both schemes unconditionally, and explicit `false`
  retains the legacy `of:` minting behavior as a temporary rollback path.
- **Path to removal.** Confirm all syncing clients carry `computed:`-aware
  readers and the default-on rollout has soaked; then remove the environment
  mapping, runtime option, builder guard, and legacy rollback tests.

### `serverExecution`

- **Toggle via.** `EXPERIMENTAL_SERVER_EXECUTION` environment variable (through
  the canonical mapping described in the category note above), or
  `RuntimeOptions.experimental.serverExecution`; browser-side via the shell
  build define of the same name
  ([`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts) /
  [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts)). The
  ambient control point is `setServerExecutionConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts): the runner owns the
  feature, but the per-class commit admission rows are enforced by the memory
  server under the flag, so the value lives beside the memory protocol flags.
  It is not a handshake capability — admission enforcement is server-local and
  nothing about it is negotiated per connection.
- **Added by.** Bernhard Seefeld, in server-execution v2 Phase 1 stage A
  (#5339;
  [`docs/plans/server-execution-v2.md`](../plans/server-execution-v2.md);
  spec:
  [`docs/specs/server-side-execution/`](../specs/server-side-execution/README.md)).
- **Purpose.** The single flag of server-execution v2 — servers do all the
  compute that is stored; clients commit nothing but intent. Exactly two
  states, no shippable intermediates (spec README §3.4); deliberately named
  unlike v1's `SERVER_PRIMARY_EXECUTION` so the archived v1 documents never
  alias it. Both states, defined:
  - **OFF (explicit `false` selects it regardless of the constant): the
    pre-v2 behavior, byte-for-byte.** Every client
    runtime runs and commits derivations exactly as it does today, and every
    client commit is `authored`-class — `derived` is never claimed off the
    flag. The commit `class` metadata is still *written* in this arm (it is
    written in every arm from stage A onward — protocol.md §1), but nothing
    is enforced from it, and `stream-data` behaves as today. Any OFF-arm
    behavioral diff from a v2 stage is a phase-gate failure by itself
    (testing.md §2).
  - **ON (explicit `true` selects it regardless of the constant): the v2
    posture.** With stages A–F landed
    this means: the per-class admission rows of protocol.md §2 are enforced
    — the `derived` row is the stage-B lease equality check PLUS stage F's
    derived-envelope defense-in-depth (the producing session must BE the
    holder's own service session), reads may name an explicit
    `entity_scope_key` (lease-holder-only; refused for anyone else), the
    delegated authored row validates its acting-identity + capabilityRef
    carriage, and the `authored`/`system` rows equal today's checks — the
    deferred `stream-data` built-in is disabled with a runtime error naming
    builtins.md §5 — AND the serving loop actually SERVES: toolshed
    constructs an ExecutorHost over its memory server, spaces activate on
    session open / authored admission, one SpaceServer per active space
    holds and renews the lease, runs demanded derivations through the
    seal-into-wave machinery, commits ONE derived transaction per wave
    carrying the watermark (protocol.md §4; `waitForSettled` rides it),
    hosts the pattern-update watcher server-side (serving-loop.md §3e),
    runs the pattern-lifecycle verbs a `cf` client sends it — `cf piece
    new` compiles and materializes on the space's serving runtime rather
    than in the client
    ([`server-pattern-lifecycle.md`](../features/server-pattern-lifecycle.md)),
    serves a bounded client's `db.query` under the read ceiling that client
    declared in its signed `session.open` descriptor (a flag-ON client
    runtime hands its `cfcReadMaxConfidentiality` to its sessions, and
    the serving loop stamps it onto every run served as one of them —
    `docs/specs/sqlite-builtin/06-cfc.md`, "Runtime read ceiling"),
    and exposes the §7 `servingLoop` counters on `/api/health/stats`.
    Narrowing writes chain the eager via-user hop (scopes.md §2's MUST).
    Since Phase 2 (speculation.md), a flag-ON CLIENT no longer commits
    derivations at all: derivation runs divert into the process-local
    speculation overlay (the echo), and the store's only derivation
    results are the SpaceServer's derived-class commits — the
    two-deriver interim is over. Since Phase 3 (events-down;
    events.md), client HANDLER runs divert to the overlay too and the
    fire's ONE authored act is the EVENT APPEND to the stream's sidecar
    doc (fired-order offline queue, LT9): the server drains undelivered
    events, runs handlers authoritatively as the event's stamped actor,
    marks consequences + advances the per-stream `eventWatermark` in the
    same derived commit, and the client's echo retires on the
    consequence signal (the client handler-write commit path — the old
    F10 interim — is DELETED). Later stages add their surfaces under
    this same flag; both halves of any coupled behavior move together
    on it.
- **Current default and planned end state.** The summary table's cell
  states the current value of the ONE first-party default,
  `SERVER_EXECUTION_DEFAULT_ENABLED` in
  [`packages/memory/v2/server-execution-default.ts`](../../packages/memory/v2/server-execution-default.ts)
  (a test pins the cell to the constant); the dated status entries below
  carry its history (landed flip-ready dark at `false` 2026-08-16; flipped
  ON 2026-08-28; each later flip has its own entry). OW28's served
  `compileAndRun` lifecycle has direct acceptance coverage. The Phase-7
  ordered gates still apply; a flip record does not establish their
  current verdicts. The default
  is read by every deployed-topology entry point — the `productionServer` / `remoteClient` construction presets
  (toolshed's operator runtime, the background piece service, the CLI,
  every pieces controller and integration harness against a toolshed),
  toolshed's serving-host gate and its memory ACL principal lists (the
  DELEGATING class since OW31's build — the process identity is no
  longer an implicit-OWNER service principal), and the browser
  shell's build define fallback. An UNSET flag resolves to it; an explicit
  `EXPERIMENTAL_SERVER_EXECUTION=false` (or `experimental.serverExecution:
  false`, or the shell define `"false"`) selects the OFF arm and an explicit
  `true` the ON arm, regardless of the constant; whichever arm is not the
  default is the per-deployment lever (the rollback lever whenever the
  default is ON). CI resolves stable `default` and `opposite`
  roles through `tasks/server-execution-ci.ts`: `default` leaves the flag
  unset, while `opposite` explicitly selects the inverse and bakes that same
  value into its toolshed shell. Therefore changing the default is exactly:
  `SERVER_EXECUTION_DEFAULT_ENABLED`, the summary cell above, a dated status
  entry here, and a delta in the plan's live coordination block; workflow
  job topology, probes, skip placement, coverage ownership, test record
  variants, and every other document follow automatically.
  Single-process harnesses do not
  read the constant: a bare `new Runtime` and the `patternTest` /
  `localDev` / `unitTest` presets have no serving host, so they resolve the
  ambient baseline (OFF) by construction — the unit suites and `cf test`
  run the derive-and-commit model (which is why the flip does not reach
  the no-server pattern-tests lane and its `topics/multi-user.test.tsx`,
  the lane-posture item the topics measurement report recorded for the
  flip decision). A test that runs ON in one process needs a serving loop
  beside its memory server, or the events its clients append are admitted
  and never delivered;
  `@commonfabric/runner/executor/serving-memory-server.deno` supplies one,
  in-process (`startServingMemoryServer`) or on a localhost websocket for
  `remoteClient` runtimes (`listenServingMemoryServer`), with its serving
  runtimes built by the factory toolshed uses
  ([TESTING.md](TESTING.md#the-on-topology-in-one-process)). The ON
  posture's unit coverage sets the flag explicitly on clients of such a
  server (the `executor-*` suites, the served-lifecycle verbs); the pattern
  `MultiRuntimeHarness` and the CLI's agent-connections test resolve the
  posture as a deployed entry point does and host a serving server when it
  is ON, so they follow the default and the CI role; the rest of the
  integration coverage is whichever CI role resolves ON. In CI (testing.md §2), `default`
  follows the constant and `opposite` is its explicit inverse; both are
  probed through the shared role
  resolver; the opposite lane uses `build-toolshed-opposite`, whose shell
  define is baked from the resolved inverse. The
  `deployed-topology-gate` job exercises the real `bg-piece-service`
  binary and cf-harness's fabric session at the default resolution, and
  the CLI lanes probe the server their `cf` adopts its posture from —
  with ON-arm skips and OFF-arm authored coverage following the resolved arm.
  Skips are only through `tasks/server-execution-on-skips.ts`, printed loudly
  (EMPTY at the flip, its stated precondition). End
  state: after a soak on main at the ON default, the flag retires and the
  OFF code path is removed — a separate post-soak
  PR (the plan's Phase 7 task 2; it also removes the opposite guard lanes and
  `build-toolshed-opposite`).
- **Status on 2026-09-11 (the served source update).** Under ON,
  `setsrc` runs on the space's serving runtime as well, and `cf piece
  setsrc` requests it: the update's setup transaction commits directly to
  the store, outside the wave, since a source update's module authority
  needs a transaction that commits to storage itself
  ([`server-pattern-lifecycle.md`](../features/server-pattern-lifecycle.md)).
  `cf piece setsrc --check` stays client-side. OFF is unchanged.
- **Status on 2026-09-10 (the lifecycle verbs).** Under ON, `upload` and
  `instantiate` run on the space's serving runtime as steps of a wave cycle
  and `cf piece new` requests them
  ([`server-pattern-lifecycle.md`](../features/server-pattern-lifecycle.md)).
  OFF is unchanged.
- **Status on 2026-09-10.** The first-party default remains OFF and
  the ON soak is paused. OW28's served `compileAndRun` outbox/completion and
  scoped child selection have direct lifecycle coverage. The Phase-7 gate
  dispositions govern a renewed ON rollout. The
  [coverage register](../specs/server-side-execution/verification-coverage.md#current-status)
  carries the current scope and the audit's evidence boundaries.
- **Status on 2026-09-03 (the ROLLBACK).** The rollback PR (#6840)
  returned the constant to `false` — the first data-only flip: this value
  and this registry's current-status prose, with no workflow, test, or role
  edits (the 2026-09-02 hygiene's promise, exercised). Everything the flip
  PR built stays: the serving-side machinery, the deployed-topology gates,
  and the two-arm lanes, whose roles now resolve `default` = OFF and
  `opposite` = ON (an ON-built shell, carrying the EMPTY ON-arm skip
  registry and the `server-execution` record marker; authored-pattern
  coverage rides the default lanes). Explicit `true` selects ON per
  deployment. Re-flipping is the same two-surface change back.
- **Status on 2026-09-02 (toggle hygiene).** The default remained ON and runtime
  behavior is unchanged. CI now expresses the two postures as stable roles
  derived from the one default constant. A rollback-default PR can therefore
  be a constant change plus its status documentation; it does not duplicate or
  mechanically invert the workflow.
- **Status on 2026-08-28 (the FLIP).** The flip PR set the constant `true`
  after every ordered gate was met on main (the ON-skip registry EMPTY
  across all four suites — the ruled-3b-close lift #6528; OW31's ruled
  write/read-authority posture BUILT; the first-ON-CI gate's owed rows
  OW45–OW53 CLOSED; the OW38(ii) performance bar RULED met by the owner
  on the topics measurement). It carried the lane-role swap (default
  lanes = the ON arm, probed; explicit-`false` lanes = the OFF guard on
  the then-named `build-toolshed-off`), the deployed-topology gates (the
  `bg-piece-service` binary and cf-harness's fabric session at the
  default resolution; the CLI lanes probed as `cf`'s gate;
  `PiecesController` hosts riding the default lanes), and the
  env-else-default posture resolution for the Deno-side integration
  clients. The soak on main runs from its merge; the OFF path, the OFF
  guard lanes, and this flag retire in the post-soak removal PR.
- **Status on 2026-08-16 (Phase 7 flip-READY, landed DARK).** Phases 1–6
  landed; Phase 7 landed the flip's mechanism — the one constant and its
  readers, OW27 per-stream send pacing in the event-append queue
  (pace-never-drop, per-stream independence — README §3.8), the LT9
  simplification (process-lifetime queue), served-wish read authority
  (AT THE TIME: the process identity as a memory service principal —
  implicit OWNER for its ordinary session traffic; that posture was
  RULED away and RETIRED by OW31's build 2026-08-21 — the process
  identity is now a DELEGATING principal whose serving sessions read as
  the space's owner via the `actingAs` binding, and the operator's
  service-DID list is used verbatim on both arms:
  verification-coverage.md OW31), the demand-root chain in
  the run supply (nested pieces, result-as-pattern children, and the list
  builtins' element pieces) — with the constant `false`. Known ON-arm gaps,
  carried on the plan's Phase 7 section and the register: the two-browser
  journeys stall on an UNATTRIBUTED client-side scheduler-non-settling
  loop (OW32, first gate); the serving replica's scope-name collapse at
  scoped cardinality ≥ 2 (OW17, a bounded architectural leg with a known
  fix shape); fresh `compile-and-run` inert until its serving port (OW28);
  the ON-posture Deno-client family surfaced by the uniform ON lanes
  (OW33); the topics-navigation / two-browser / lunch gates and three
  package-suite items are ON-skip-listed with loud reasons.
- **Status on 2026-08-05.** Phase 1 stages A–F landed (E re-keyed the
  vocabulary per instance; F landed the serving loop itself): the
  ExecutorHost + SpaceServer host one committing runtime per active space
  — lease renewed on stage B's cadence, waves through stage D's machinery,
  the watermark doc + `derivedThrough` + `waitForSettled`, M1 per-run
  identity seams, M4 instance-keyed push, the read-row and
  derived-envelope and delegated admission checks, the eager via-user
  hop, the server-side pattern-update posture, and the §7 counters. All
  still dark: OFF by default and byte-identical to today; the ON arm now
  actually serves (with the documented two-deriver interim). Stage G
  (effects + outbox) remains.
- **Path to removal.** Soak on main at the ON default; then the post-soak PR
  retires the flag, removes the OFF path (and the opposite regression-guard
  lanes + `build-toolshed-opposite`), and closes out this entry.

---

### `viewScopedReplication` / `webViewScopedReplication`

- **Added by:** Bernhard Seefeld, 2026-09-09.
- **Toggle:** `EXPERIMENTAL_VIEW_SCOPED_REPLICATION` sets the global default;
  `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` sets the web client override. Both
  are available through `RuntimeOptions.experimental`, deployment metadata, and
  the shell's build defines. Both have server authority in the experimental flag
  registry; explicit environment values still take precedence when adopting
  deployment defaults.
- **Default:** global `false`; web override absent. A web runtime resolves
  `webViewScopedReplication ?? viewScopedReplication ?? false`. An explicit web
  `false` overrides a global `true`.
- **Scope:** requires `serverExecution: true`, the browser-worker
  `clientClass: "web"` preset, and a server advertising
  `viewScopedReplicationV1`. Other client classes retain ordinary replication.
  Every browser tab owns its own runtime and authenticated view interests.
- **Behavior:** piece opening reads the name and opaque UI tip; mounted views
  register renderer demand. The server selects supporting documents from
  observed execution reads and shared component contracts. Client JavaScript
  runs only with admitted, resident inputs and current producer/source evidence.
  Unavailable attempts abort without implicit pulls; server-only nodes retain
  their confirmed outputs.
- **End state and removal:** validate selection, reconnect behavior, component
  coverage, and speculative currency for each supported client class. Graduate
  classes deliberately, then remove their overrides and the global switch once
  every supported class uses this protocol.
- **Status (2026-09-09):** experimental and off by default. See
  [view-scoped client replication](../features/view-scoped-client-replication.md)
  for the current bounds and
  [the implementation plan](../plans/view-scoped-client-replication.md) for
  follow-up work.


### `lazyMaterialization`

**Last checked:** 2026-09-15. **Status:** implemented, on by default.

- **Toggle via.** `EXPERIMENTAL_LAZY_MATERIALIZATION` environment variable, or
  `new Runtime({ experimental: { lazyMaterialization: false } })` for the eager
  posture, subject to the validation limits below. The flag is server-authoritative for deployed clients
  (`EXPERIMENTAL_FLAG_AUTHORITY`), so a server's `false` carries the `cf`
  clients it serves. The browser shell has no build-time define for this
  flag, so a shell build runs the runtime default and the override does not
  reach it: a server rolled back serves browsers running the other arm.
- **Purpose.** Materialize a lift's argument lazily. The runner marks the
  action's transaction (`markLazyMaterialize`), and `Cell.get()` on a marked
  transaction hands back a schema-observing view instead of building everything
  the schema selects in one pass. The body reads the paths it touches and
  nothing else; a reader that touches data the schema no longer describes
  refuses, and the run is disposed of as an argument that did not resolve.
  Unmarked transactions read exactly as they did before.
- **Behavior.**
  [`../features/lazy-cell-materialization.md`](../features/lazy-cell-materialization.md)
  — what a view checks, where it diverges from an eager read, and where a
  schema-less read takes over.
- **Design, measurements and staging.**
  [`../plans/lazy-cell-materialization.md`](../plans/lazy-cell-materialization.md).

**Validation and rollback limits.** Off is not qualified as an equivalent
rollback. Eager reads can hand `undefined` to a body whose schema promises a
value, producing a TypeError where the lazy read refuses. The focused
`unresolved-input-lift.test.ts` pins the missing followed-document case; the
served notebook scenario also exposes an unavailable nullable edit input.
The corrected notebook reload renders all seven notes in both postures, but
the eager run fails on those browser errors. Keep these failures visible when
qualifying a rollback route; rendering alone is not a successful run.

Direct Runtime construction does not read the environment variable. An eager
comparison must set the runtime option or temporarily change the built-in
default, including the browser constructor. Selected runner, runtime-client,
and shell integration results are in the
[integration evidence](../history/development/performance/2026-09-14-lazy-off-integration.md).
The [rollout evidence](../history/development/performance/2026-09-11-lazy-materialization-f3-rollout-evidence.md)
distinguishes eager unit failures from lazy-specific dependency/count
expectations and assertions of the built-in default. The
[reload diagnosis](../history/development/performance/2026-09-15-lazy-reload-diagnosis.md)
and [navigation-policy follow-up](../history/development/performance/2026-09-15-notebook-reload-navigation-policy.md)
separate nullable-read errors from a test's assumption about the selected page.
The flag owner decides whether and when to retire the switch. The
[fast-follow record](../history/plans/lazy-materialization-fast-follow.md) contains
pinned measurements and their limits. Use the [benchmark guidance](BENCHMARKS.md)
for new comparisons; neither the measurement record nor read-count equality
qualifies an operational rollback.

One behavior difference is deliberate rather than a defect, and it is the point
of the mode: a lift that FORWARDS its argument onward without reading through it
takes no dependency on the values inside, so it does not re-run when they
change. That is safe because forwarding passes a LINK — whatever the value is
written into re-reads through it and re-runs — and because a change to the
REFERENCE still re-triggers the reader, since link resolution registers its own
probe reads. `Pattern Runner - Lift` pins both halves: the forwarding lift runs
once instead of twice, while the inner lift still runs and still produces the
new result.

A view describes the instant its `.get()` fixed, so a reader iterating a list
while writing into it walks the list as it stood, and a lift that writes into a
`Writable` input reads back what it wrote by taking the read again. Both
readings on a marked transaction pin — the schema view and the schema-less
proxy; unmarked reads are untouched, so the standing handle long-lived consumers
rely on keeps tracking current state.

Handlers materialize eagerly by decision: the [handler context
record](../history/development/performance/2026-09-11-lazy-handler-context-prototype.md)
holds the measurements and the conditions for revisiting.

### `readerSchemaPrecedence`

- **Toggle via.** `EXPERIMENTAL_READER_SCHEMA_PRECEDENCE` environment variable
  (through the canonical env registry) or
  `RuntimeOptions.experimental.readerSchemaPrecedence`; browser-side, the
  build define of the same name
  ([`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts) /
  [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts),
  parsed by the one canonical parser) — baked at build time, so a browser
  rollback ships with a redeploy. The ambient control point is
  [`packages/runner/src/reader-schema-precedence-config.ts`](../../packages/runner/src/reader-schema-precedence-config.ts).
  Server-authoritative in `EXPERIMENTAL_FLAG_AUTHORITY`: a server publishes
  its resolved posture at `/api/meta` and a deployed CLI adopts it (an
  explicit `EXPERIMENTAL_*` override still wins), because the server's
  traversal decides what a subscription ships and both sides must resolve
  hops under the same combine rule.
- **Added by.** Robin McCollum, in #6338.
- **Purpose.** Resolves the schema at a link crossing by reader precedence
  (`combineSchemaForLink` in
  [`packages/runner/src/traverse.ts`](../../packages/runner/src/traverse.ts)):
  the reader's schema is used as it stands, and the link's stored schema is
  adopted only where the reader is agnostic — a true or empty reader adopts it
  under the reader's own `asCell` wrapper, and a false reader stays false. A
  link routinely describes (and requires) more of its target than the reader
  asked for; under the legacy strict pseudo-intersection those extras widened
  what a read loaded and tracked, and a link-only `required` entry could void
  the reader's narrower view. `default` is the exception that crosses the
  precedence line: a value's default is inherited from the last crossed
  schema that declares one. Spec:
  [`docs/specs/link-schema-precedence.md`](../specs/link-schema-precedence.md)
  (consolidated), with
  [`docs/specs/memory-v2/05-queries.md`](../specs/memory-v2/05-queries.md)
  §5.3.4 for the query-pipeline context.
- **Current default and planned end state.** On by default; an explicit
  `false` restores the strict pseudo-intersection (`combineSchema`) at link
  crossings as a rollback override. The rollback is plain ambient
  last-construction-wins state: each Runtime construction sets it from its
  resolved option, and dispose deliberately does NOT reset it — a server
  runs one serving runtime per space and disposes idle ones while the rest
  live, so a teardown reset would lift a rollback out from under them.
  Successive runtimes in one test process still get differing flag states,
  because every construction sets (an unset option setting the default). Compatibility: a server
  posture that DECLARES no `readerSchemaPrecedence` predates the flag and
  necessarily runs the strict combine, so adoption treats absence as the
  legacy `false` until the compatibility window closes
  (`parseServerExperimentalOptions`); an unreachable server leaves the
  built-in default. The flag gates only the combine rule: the cfc relevance
  marking off link schemas (`schemaHasIfc` at the read entry point and at
  traversal hops) is unconditional in both arms.
- **Status on 2026-08-27.** Landed on by default in #6338; the rollback arm,
  the ambient lifecycle (construction set, no teardown reset, throwing
  construction), and the default inheritance are covered by unit tests in
  `packages/runner/test/combine-schema.test.ts` and
  `packages/runner/test/experimental-options.test.ts`.
- **Path to removal.** Soak the default; then remove the env mapping, the
  runtime option and its authority entry, the ambient config module, the
  rollback branch in `combineSchemaForLink` and its unit tests, and the
  combine-mode bit in the link-hop selector memo key.

### `agentBuiltin`

- **Toggle via.** `EXPERIMENTAL_AGENT_BUILTIN` environment variable (through
  the canonical env registry) or `RuntimeOptions.experimental.agentBuiltin`.
  Server-authoritative in `EXPERIMENTAL_FLAG_AUTHORITY`: under server
  execution the server runs the builtin and creates the record, so a client
  on the other value would stage requests the deployment never picks up, or
  refuse ones it would. A client connecting to an older server that publishes
  no value for this flag adopts that server's legacy off posture.
- **Added by.** Bernhard Seefeld, agent requests stage 3
  ([`docs/history/plans/agent-requests-implementation.md`](../history/plans/agent-requests-implementation.md)).
- **Purpose.** Gates the `agent` builtin
  ([`docs/common/capabilities/agent.md`](../common/capabilities/agent.md)):
  a pattern's request for an agent run, staged as a sink request under the
  `agent` sink and handed to a runner through an `AgentRun` record. With the
  flag set to `false`, the builtin stays registered — a pattern naming it
  compiles — but every request settles with `pending: false` and an error
  naming this flag; nothing is staged and no record is written.
- **Current default and planned end state.** On by default. Set
  `EXPERIMENTAL_AGENT_BUILTIN=false` or pass
  `RuntimeOptions.experimental.agentBuiltin: false` to refuse requests while
  the rollback flag exists. A queued request needs a configured runner for the
  requester's home space to claim it. After the default-on posture soaks,
  delete the flag and the refusal branch in
  `packages/runner/src/builtins/agent.ts`.
- **Status on 2026-09-21.** Implemented behind the flag; the builtin's
  staging, memo, abandonment, tool check, and record derivation are covered
  by `packages/runner/test/agent-builtin.test.ts`, and its sink governance by
  `packages/runner/test/agent-sink-governance.test.ts`.
- **Path to removal.** Remove the env mapping, the runtime option and its
  authority entry, and the refusal branch after the default-on posture soaks.

## Category 2: Contextual Flow Control enforcement rollout dials

Contextual Flow Control (CFC) is the label-propagation and egress-gating layer
that decides which writes and outbound requests are allowed based on the
confidentiality and integrity labels the values carry. It is being rolled out in
stages, and each stage has its own dial on `RuntimeOptions` in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). The
dial types live in
[`packages/runner/src/cfc/types.ts`](../../packages/runner/src/cfc/types.ts).

Unlike the Category 1 flags, most of these are not simple on/off booleans; they
are staged dials, usually `off` then `observe` (evaluate and emit diagnostics
but do not reject) then `enforce` (reject on a violation).

They are not wired to environment variables. Instead, the first-party posture is
set once in `coreOptions`, the shared core that every construction preset
composes, in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts).
`coreOptions` pins seven CFC dials at the rungs the constructor also defaults
to, so a changed constructor default cannot silently relax a preset;
`cfcDecomposedEnvelopes`, `cfcPolicyRecords`, `cfcTrustConfig` and the ceiling
dials are left on their constructor defaults (`off` or none) there, with a
comment marking `coreOptions` as the one place to flip one when a first-party
rollout begins. So the place to advance a CFC rollout across the whole fleet is
that one function, not each call site. A few presets accept
per-environment overrides: `patternTest` and `unitTest` take a laxer
`cfcEnforcementMode`, and `browserWorker` and `remoteClient` take
host-controlled `cfcEnforcementMode` and `cfcFlowLabels` — the shell supplies
the former's from its initialization data, and cf-harness supplies the
latter's for its fabric session from `--fabric-cfc-enforcement-mode`
(the enforcing rungs: `enforce-explicit` or `enforce-strict`) and
`--fabric-cfc-flow-labels`, with `CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE` and
`CF_HARNESS_FABRIC_CFC_FLOW_LABELS` as their environment defaults.
`remoteClient` takes a host-controlled `cfcWriteFloor` on top of those two,
which `PiecesController.initialize` forwards and the pattern multi-runtime
harness routes on to each worker runtime, per session or for the whole
harness. That dial is how a caller reaches the floor's `observe` rung, which
the named bundle below sets only to `enforce`.

One named bundle sits beside the per-dial rollout: every preset's `CoreParams`
accepts `cfcPosture: "max-enforcement"`, which spreads
`MAX_ENFORCEMENT_CFC_OPTIONS` (same file) over the core — flow labels
`persist`, write floor / policy evaluation / declared monotonicity /
label-metadata protection at `enforce`, trigger-read gating on, the §10.1
standard prompt-caveat policy as the deployment's `cfcPolicyRecords`, and
public-only confidentiality ceilings on the network-fetch sinks.

The bundle's sink decisions are total over the sink registry
(`MAX_ENFORCEMENT_SINK_GOVERNANCE`, from which `MAX_ENFORCEMENT_SINK_CEILINGS`
derives): every sink `KNOWN_SINKS` names carries either a ceiling or an
explicit ungated release with its reason, its owner, and the condition that
retires it, so a sink added to the inventory without a decision is a compile
error rather than a sink that quietly releases ungated. Two families are the
explicit ungated ones, and a sink with no ceiling gets no gate. The llm sinks:
llm-sink release is ungoverned under this posture — pending a boundary-scoped
admission mechanism, since an exact-match ceiling cannot admit the
source-varying material-risk caveats an llm sink exists to process. Building
that mechanism is planned in
[`docs/plans/cfc-llm-sink-admission.md`](../plans/cfc-llm-sink-admission.md).
And `sqliteQuery`, whose request is a read handed to the provider holding a
space's replicas: the bound it wants is the database's own SPACE, which a
clause list cannot express, so the sqlite builtin refuses a request carrying
confidentiality for a database in another space before staging it. A
deployment that wants a confidentiality gate on sqlite reads declares a
ceiling for the sink, which the seam then applies.
The bundle names no enforcement mode, so a runtime taking it keeps the core's
`enforce-strict` pin, and it leaves `cfcDecomposedEnvelopes`,
`cfcContentAddressedLabels`, `cfcTrustConfig` and
`cfcPrefixProvenanceStats` alone. What it adds over the core pins is the
deployment configuration — the standard prompt-caveat policy records and the
per-sink confidentiality ceilings — plus `cfcDeclaredMonotonicity` at
`enforce`. It is opt-in per runtime, never a fleet
flip: cf-harness exposes it for its fabric session as `--fabric-cfc-posture`
(`CF_HARNESS_FABRIC_CFC_POSTURE`); toolshed publishes whatever CFC posture its
Runtime resolved on `/api/meta` (`lib/cfc-posture.ts`), so a deployment's
enforcement is readable rather than indistinguishable from the default. The
cf-harness console is the one surface that opts in by default — it exists to
show CFC working, so its fabric session takes the bundle unless
`--fabric-cfc-posture none` says otherwise, and it prints the posture it
resolved at startup.

Every surface that publishes a posture publishes the same record,
`cfcPostureReport` in `packages/runner/src/cfc/posture-report.ts`: each dial's
resolved rung together with whether that rung decides anything and what it
decides on, the policy-snapshot digest, every known sink as a ceiling or an
explicit ungated release, and every published deviation as
`{what, owner, retirement}`. Three of those are load-bearing. An `observe` rung
carries `diagnosticOnly: true`, so `policyEvaluation: observe` cannot be read
as active enforcement. The sink list is total, so a sink's absence from a list
of ceilings can no longer read as coverage. And the record carries its own
`provenance`.

`provenance` is what keeps a prediction from reading as an attestation.
`cfcPostureReport(runtime)` reads a constructed Runtime's resolved fields and
stamps `resolved`; `projectedCfcPostureReport(options)` computes what a runtime
built with those options will resolve, before it exists, and stamps
`projected`. Those are the only two ways to build a record, so neither can be
mislabelled. Toolshed's `/api/meta` publishes `resolved`. The cf-harness
console and run state publish `projected`: the session's runtime is built
lazily on the first `run_pattern` and may never be built at all, and a host may
supply its own session factory, so what those surfaces know at the time they
publish is what the run expects to be at. A projection goes through the same
`presetCfcOptions` and `resolveCfcDials` the Runtime itself resolves from —
the same resolution, not a second statement of it — but the field says what it
is. `deno task cfc-audit --expected-posture` compares a published record
against a written-down profile, and fails a deployment that publishes a
projection; see the cf-harness README.

Every value that resolution returns is a rung of its own dial.
`resolveCfcDials` checks each stated value against the same table of rungs the
record's `decidesOn` is read from, and throws on one that is not among them,
naming the dial and its rungs. The two dials that are simply on or off take
`true` and `false` and nothing else.

A dial off its ladder has no rung to run on, and the record then disagrees with
the runtime. For a named-rung dial the guards around a gate test for
`!== "off"` and let the value through, while the gate itself tests for the one
enforcing rung and declines to act, so the dial runs as `observe` does while
the published record calls it enforcing. The two on-or-off dials part the other
way round: the gates read them for truthiness, while the record tests for
`true`, so a truthy value that is not `true` runs the gate while the record
says the gate is off. Resolving such a value to the default instead would hand
a deployment a posture it never stated, so the construction fails. That check
reaches every host, whether its dials come from a preset, a worker
initialization message, a command line, or the CFC section of a JSON manifest.

The interactive `cf-harness` and the `fuse` mount expose the enforcement mode
through `CF_CFC_MODE` for testing. Because these dials are keys of
`RuntimeOptions`, the exhaustive `RUNTIME_OPTION_KEYS` registry in the same file
makes adding a new one a compile error until it is classified across every
preset. The staging plan is tracked in the CFC design docs under
[`docs/specs/`](../specs/) (for example the S16 default-transition design and
the per-epic implementation notes).

### `cfcEnforcementMode`

- **Toggle via.** `RuntimeOptions.cfcEnforcementMode`, pinned for first-party
  processes in `coreOptions` (see the category note). The cf-harness and fuse
  read `CF_CFC_MODE` as an override, and cf-harness's fabric session names its
  own runtime's rung through `--fabric-cfc-enforcement-mode` /
  `CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE`.
- **Added by.** Bernhard Seefeld, in "Implement runner commit-boundary" (#3263,
  2026-04-14).
- **Purpose.** The master strictness ladder for commit-boundary CFC enforcement.
  Values are `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`, in
  increasing strictness. `disabled` runs no gates; `observe` emits audit
  diagnostics without rejecting; `enforce-explicit` rejects writes that violate
  explicit labels; `enforce-strict` also rejects violations that come from
  inferred taint.
- **Current default and planned end state.** The type-level default constant
  (`DEFAULT_CFC_ENFORCEMENT_MODE`) is `disabled` — that is the floor a
  transaction built without a runtime carries, which is a different question —
  while both the `Runtime` constructor and the shared `coreOptions` preset set
  `enforce-strict`, the top of the ladder. (The preset pins the same value the
  constructor would default to, so that a future change to the constructor
  default cannot silently relax first-party processes.) The content-addressed
  compilation cache is also gated on this being anything other than `disabled`.
  A host that needs a laxer rung states one; there is no further tightening to
  do.
- **Status on 2026-07-08.** Active. All four rungs of the ladder are
  implemented; the ladder itself is a permanent part of the system rather than a
  temporary flag.
- **Path to removal.** The dial is not planned for removal. What changes over
  time is the default rung; the `disabled` and `observe` rungs stay available
  for local development and diagnostics.

### `cfcFlowLabels`

- **Toggle via.** `RuntimeOptions.cfcFlowLabels`; per-environment through the
  `remoteClient` and `browserWorker` preset params (cf-harness's fabric
  session exposes the former as `--fabric-cfc-flow-labels` /
  `CF_HARNESS_FABRIC_CFC_FLOW_LABELS`).
- **Added by.** Bernhard Seefeld, in "S16 default transition — flow-label
  propagation" (#4011, 2026-06-10).
- **Purpose.** Controls flow-label propagation at the commit boundary. Values
  are `off`, `observe`, and `persist`. `observe` computes the conservative label
  join and emits diagnostics but writes nothing; `persist` writes the derived
  label components onto value write targets, except where the target's declared
  store policy already carries every clause the join would state there and the
  component adds no integrity of its own — such an entry changes no label a
  reader resolves, so the persist seam drops it. A transaction the runtime
  attributes to an implementation carries derivation provenance in its
  integrity, which no store policy states, so its value entries are kept and a
  labeled collection an attributed writer maintains still grows per element.
  Propagation runs only when the enforcement mode is at least `observe`; it
  derives and stores labels but never rejects on its own.
- **Current default and planned end state.** `persist` by default, which is
  where the dial rests: the downstream egress gates it waited on — the render
  ceiling, the sink ceilings, and the LLM path — are online. A deployment that
  wants diagnostics without writes states `observe`.
- **Status on 2026-09-17.** Implemented and rolled out; the core
  propagation work is done and the dial rests at `persist`.
- **Path to removal.** Flow-label propagation is load-bearing for the S16 audit
  transition, so the dial is not expected to be removed; it will settle on
  `persist` as its steady state.

### `cfcWriteFloor`

- **Toggle via.** `RuntimeOptions.cfcWriteFloor`; per-environment through the
  `remoteClient` preset param, which `PiecesController.initialize` accepts and
  forwards. The pattern multi-runtime harness routes it on to each worker
  runtime, per session or for the whole harness, so an integration test can
  drive real patterns against an enforcing floor.
- **Added by.** Bernhard Seefeld, in "write-side requiredIntegrity floor (Epic
  D3, SC-18)" (#4479, 2026-07-02).
- **Purpose.** A write-side minimum-integrity check. Values are `off`,
  `observe`, and `enforce`. `observe` evaluates the floor and emits diagnostics;
  `enforce` records a rejection reason when a write's integrity falls below the
  floor. The floor tests the integrity of the written value, not of the reads
  that produced it.
- **Current default and planned end state.** `enforce` by default, which is
  where the dial rests. A deployment that wants the floor measured rather than
  applied states `observe`.
- **Status on 2026-09-17.** Implemented and rolled out.
- **Path to removal.** Once integrity propagation is complete and the floor is
  proven safe, the check could fold into the base enforcement ladder and the
  separate dial could be retired.

### `cfcTriggerReadGating`

- **Toggle via.** `RuntimeOptions.cfcTriggerReadGating` (a plain boolean).
- **Added by.** Bernhard Seefeld, in "trigger-read gating on the enforcement
  side (Epic H5, SC-3)" (#4488, 2026-07-02).
- **Purpose.** Closes a residual side channel where a reactive rerun is
  triggered by an invalidating write. When on, the addresses whose invalidating
  writes scheduled the rerun join the consumed-read set that the egress ceiling
  and the input-requirement gates quantify over, so the rerun cannot leak
  information through the mere fact that it was triggered. It fails closed and
  costs extra metadata resolution per commit prepare.
- **Current default and planned end state.** `true` by default, which is where
  the dial rests; the per-commit metadata resolution it costs is paid.
- **Status on 2026-09-17.** Implemented and rolled out.
- **Path to removal.** Once the cost is acceptable (or metadata caching removes
  it), the default could flip to `true` and the gating could become
  unconditional, retiring the dial.

### `cfcDecomposedEnvelopes`

- **Toggle via.** `RuntimeOptions.cfcDecomposedEnvelopes` (a plain boolean).
- **Added by.** Robin McCollum, in the CFC envelope → cid-system convergence
  (CT-2062, 2026-08-22; PR #6199 rung 3).
- **Purpose.** When on, the envelope persist path stores the DECOMPOSED
  spelling: the metadata's `schemaHash` names a root document whose
  `$defs` members are separate content-addressed documents, shared with
  the link-schema document family and elided once the space's server
  confirms them. Off preserves the merged schema's interned spelling —
  which may itself carry references a reference-form declared schema
  left, or ones the confidential merge minted, as the same section notes.
  Reading is
  the same either way — every `$ref: cid:` member a stored root carries
  resolves (space-first, content-verified, with the hash-verified realm
  registry supplying what the space does not hold) or the envelope is
  unreadable (fail closed) — and the storage commit boundary validates the whole
  closure at write time. Delivery to remote readers rides the
  result-assembly guarantee: a delivered schema document's own refs join
  the delivered set and watch set
  (`docs/specs/content-addressed-schemas.md`), so the traversal's cfc
  seam only ever needs the root.
- **Current default and planned end state.** `false` by default. The
  target is `true`; inline envelopes remain readable indefinitely.
- **Status on 2026-08-22.** Implemented, off by default. The flip is
  gated on deployment reach, not on code here: a runner that predates
  reference resolution walks a decomposed root's `$ref: cid:` members as
  inert schema content and silently under-labels, so every deployed
  reader must resolve (or fail closed) before decomposed writes become
  the default. Reference-form declared schemas already leave
  reference-carrying roots behind in narrower cases, which is what bounds
  how old a reader can be either way.
- **Path to removal.** Once the default flips, the dial retires and the
  decomposed spelling becomes the only one the persist path emits.

### `cfcContentAddressedLabels`

- **Toggle via.** `RuntimeOptions.cfcContentAddressedLabels` (a plain
  boolean).
- **Added by.** Bernhard Seefeld, in "content-addressed CFC labels"
  (2026-09-15).
- **Purpose.** When on, the envelope persist path stores version-2
  envelopes: each `labelMap` entry keeps its `path`, `origin`, and
  `observes` inline and holds its `label` as a reference to a
  content-addressed label document whenever the label's canonical JSON
  exceeds the inline limit, so every envelope carrying the same label
  shares one document per space
  (`docs/specs/content-addressed-cfc-labels.md`). Off stores version 1,
  every label inline. Reading resolves either version to the same
  metadata, space-first with content verification and the realm's label
  registry supplying what the space does not hold, and fails closed on a
  reference nothing backs; the storage commit boundary refuses a commit
  whose envelope references a label document it neither includes nor the
  space stores. With the flag on, a stored version-1 envelope is rewritten
  in version 2 on its next persist even when its labels are unchanged,
  which is how a store migrates without a data migration; with it off, a
  stored version 2 is left as it is.
- **Current default and planned end state.** `false` by default. The target
  is `true`; version-1 envelopes remain readable indefinitely.
- **Status on 2026-09-15.** Implemented, off by default. The flip is gated
  on deployment reach: a reader that predates version 2 fails closed on a
  version-2 envelope through `UnknownCfcMetadataVersionError`, which is
  correct and also unusable, so every deployed reader must interpret
  version 2 before any space sees one.
- **Path to removal.** Once the default flips, the dial retires and version
  2 becomes the only spelling the persist path emits.

### `cfcPolicyEvaluation`

- **Toggle via.** `RuntimeOptions.cfcPolicyEvaluation`.
- **Added by.** Bernhard Seefeld, in "boundary policy evaluation dial + coherent
  requiredIntegrity matcher (Epic B, stage B5)" (#4566, 2026-07-07).
- **Purpose.** Controls exchange-rule policy evaluation. Values are `off`,
  `observe`, and `enforce`. `off` decides gates on the raw labels,
  byte-identical to before the dial existed; `observe` evaluates the gated
  labels to a fixpoint and emits diagnostics while still deciding on the
  un-rewritten label; `enforce` decides on the rewritten label and fails closed
  when the evaluation runs out of fuel. The dial governs the commit and sink
  gates; the display boundary evaluates whenever `cfcRenderCeiling` is on, as
  its own switch.
- **Current default and planned end state.** `enforce` by default, which is
  where the dial rests.
- **Status on 2026-09-17.** Implemented and rolled out.
- **Path to removal.** Once policy evaluation is the norm, the dial could settle
  on `enforce` and be retired.

### `cfcDeclaredMonotonicity`

- **Toggle via.** `RuntimeOptions.cfcDeclaredMonotonicity`.
- **Added by.** Bernhard Seefeld, in "declared-component monotonicity gate (WP5,
  spec §8.12.1/§8.12.8)" (#4647, 2026-07-09).
- **Purpose.** Guards the one point where a persisted path's declared
  (store-policy) label component can change — the schema-walk re-mint at the
  commit boundary — with §8.12.1's `canUpdateStoreLabel` rule: confidentiality
  may only add clauses or remove alternatives, and the declared integrity claim
  may only remove atoms. Values are `off`, `observe`, and `enforce`. `observe`
  emits a structured diagnostic on a non-monotone re-mint while persisting
  today's bytes; `enforce` records a fail-closed prepare reason (rejecting the
  commit under the enforcing enforcement modes). The gate governs only the
  `declared` component; derived/link/structure components keep their §8.12.8
  replace disciplines. The per-transaction privileged widening exemption
  (`setCfcDeclaredWideningExemption`, trusted-builtin only) is the seam for the
  future §8.12.7 route 2b declassification event.
- **Current default and planned end state.** `observe` by default. The target
  is `enforce` after soak — the route 2b rewrite event must not ship before
  this gate is enforced
  (`docs/specs/cfc-persisted-declassification.md` §4–§5).
- **Status on 2026-09-17.** Implemented, observing.
- **Path to removal.** Not planned for removal: monotonicity is a permanent
  store invariant. Once `enforce` has soaked, the dial could settle there and
  the `off`/`observe` rungs remain for diagnostics, mirroring the enforcement
  ladder.

### `cfcPrefixProvenanceStats`

- **Toggle via.** `RuntimeOptions.cfcPrefixProvenanceStats` (a plain boolean),
  not env-wired. The presets do not pin it: like every CFC dial except the
  enforcement mode, it is left out of the shared `coreOptions` and rides the
  `Runtime` constructor default of `false` until a deployment sets it. The
  preset classification table marks it `core-default (off)`.
- **Added by.** Bernhard Seefeld, in "D4 write-prefix precision counters
  (value-level provenance stage 0, SC-24)" (#4623, 2026-07-09).
- **Purpose.** Measurement only, and the one dial here that does not affect
  enforcement. When on, each prepared transaction that has at least one
  protected write records per-prepare precision counters into `getCfcStats()`:
  gated-read counts per protected write (prefix versus transaction-global),
  bound-source classifications, and S7-exemption fires. Enforcement decisions
  are byte-identical whether it is on or off. It exists to gather the "measure
  before building" data described in
  [`docs/specs/cfc-value-level-provenance.md`](../specs/cfc-value-level-provenance.md)
  §6, which the project needs before deciding whether to build the larger
  value-level provenance narrowing (its "T1").
- **Current default and planned end state.** `false` by default; off skips all
  measurement for a single presence check. There is no plan to graduate it to on
  across the fleet — it is a diagnostic that a deployment turns on to collect
  precision data.
- **Status on 2026-07-09.** Implemented, off by default. Covered by
  `packages/runner/test/cfc-prefix-provenance-stats.test.ts`.
- **Path to removal.** Once the Stage 0 measurement has informed the
  value-level-provenance decision (build the narrowing, or not — the entry
  criteria are deliberately unscheduled in the spec's §8), the counters either
  fold into that feature or are removed. Because enforcement is unaffected,
  retiring it is low-risk.

### `cfcLabelMetadataProtection`

- **Toggle via.** `RuntimeOptions.cfcLabelMetadataProtection`.
- **Added by.** Bernhard Seefeld, in "inv-12 stage 1 — cross-space
  label-metadata representation transform" (#4638, 2026-07-09).
- **Purpose.** Applies the invariant-12 representation classes at the
  cross-space persist seam: source-bearing atom fields of label entries whose
  observations originate outside the destination space are persisted as
  `{digestOf: …}` commitment forms (or verbatim where the classification table
  says `public`), identically at the `["cfc"]` envelope and the sigil-carried
  label views, so a destination space's replicas stop disclosing source-space
  principal identities (`Caveat.source`, clause DIDs, `LinkReference`
  addresses). Values are `off`, `observe`, and `enforce`: `observe` computes the
  transformed form and emits a structured divergence diagnostic while persisting
  today's bytes (the rollout metric); `enforce` persists the transformed form.
  Enforcement matching is commitment-aware in both directions (read gating
  digests the candidate; exchange patterns digest-match concrete values and
  refuse to bind variables over committed fields). Same-space-only labels always
  persist verbatim.
- **Current default and planned end state.** `enforce` by default, which is
  where the dial rests
  (`docs/specs/cfc-label-metadata-confidentiality.md` §5, SC-25).
- **Status on 2026-09-17.** Implemented and rolled out.
- **Path to removal.** Not planned for removal: the representation rule is a
  permanent inv-12 obligation; once `enforce` soaks the dial settles there with
  the lower rungs kept for diagnostics, like the other CFC ladders.

> The related `RuntimeOptions` fields `cfcSinkMaxConfidentiality`,
> `cfcReadMaxConfidentiality` (with `cfcReadOnExceed`), `cfcPolicyRecords`, and
> `cfcTrustConfig` are CFC _configuration inputs_ (the policy records, per-sink
> ceilings, the runtime-wide `db.query` read ceiling, and trust statements the
> dials evaluate against), not on/off rollout dials, so they are not tracked as
> flags here. They are validated and frozen at `Runtime` construction.

---

## Category 3: Storage and memory-protocol capability flags

### `viewScopedReplicationV1`

- **Added by:** Bernhard Seefeld, 2026-09-09.
- **Toggle and default:** a Memory hello capability, advertised when server
  execution is configured on. An absent field means unsupported. This is
  negotiation, not permission to enable the feature on a client; the runtime
  flags above separately select that client's behavior.
- **Gates:** session-owned renderer interests, delivery-only support selections,
  and view eligibility manifests applied with their supplying document frames.
  Ordinary graph watches remain independently owned.
- **End state and removal:** retain backward-compatible negotiation while
  deployments may contain clients or servers without the protocol. Remove the
  capability only as part of a protocol version that requires view support.
- **Status (2026-09-09):** optional; the runtime feature remains off by default.


### `conflictAdmissionMode`

- **Toggle via.** `CF_CONFLICT_ADMISSION` environment variable (read directly in
  the storage layer, not through the toolshed environment schema), or
  `setConflictAdmissionMode()` in
  [`packages/runner/src/storage/v2.ts`](../../packages/runner/src/storage/v2.ts).
  The legacy `setConflictAdmissionEnabled(true|false)` wrapper maps `true` to
  `preempt` and `false` to `off`.
- **Added by.** William Kelly, in "gate conflict retries on caught-up local seq"
  (#4237, 2026-06-22).
- **Purpose.** Chooses what the client does with a new commit whose reads land
  on an identifier that is still catching up after an earlier conflict. Values
  are `off` and `preempt`. `preempt` assumes the commit will conflict and
  reverts and re-runs it locally without sending.
- **Removed value: `hold`.** A precise mode also existed: wait for the catch-up,
  re-run the server's precondition check locally against the now-current
  confirmed sequence numbers, revert only the genuinely stale commits, and send
  the rest. It was removed CT-1925 (PR #5110 review): `hold` let an earlier
  read-bearing commit sit at the admission gate while a later, independent blind
  commit proceeded straight to `session.transact`, violating the
  increasing-`localSeq` send order `docs/specs/memory-v2/04-protocol.md` §3.9
  requires per session (reproduced same-session admission order `[1, 3, 2]`
  against the real engine). It was also the reachability story for a real
  soundness hole in CT-1910's own-session exclusion before that landed as
  predecessor-only (soundness-neutral regardless of send order) — so by the time
  of removal `hold` was soundness-neutral but still protocol-violating, and
  every future §3.9-reliant design (e.g. CT-1910 phase-2 inference, which leans
  on FIFO arrival) would otherwise have had to re-discover the hazard. It had
  also never shown a measured win: neutral on lunch-poll (safe but no win,
  because the staleness is only knowable on the server, not locally).
- **What feeds it changed.** The stale floors `preempt` reads are recorded from
  server conflict verdicts, so they only cover commits that were actually sent.
  A commit refused before the wire for naming an already-rejected optimistic
  layer records none. That removes a population of floors that used to exist: a
  "pending dependency not resolved" verdict says nothing about the versions of
  the identifiers the commit read or wrote, so the floor it recorded was
  spurious and pre-empted commits on evidence it did not have. Anyone
  re-measuring `preempt` is measuring against a smaller and more accurate set of
  floors than the numbers below were taken on.
- **Current default and planned end state.** `off` by default. `preempt` was
  measured net-negative on the lunch-poll workload (it pre-empted commits that
  would have succeeded). The code comment warns not to enable it without
  re-measuring on the target workload.
- **Status on 2026-07-31.** Implemented, off by default. It is a tuning dial
  that has not shown a win on the workloads measured so far.
- **Path to removal.** Either it finds a workload where `preempt` pays off and
  graduates into a documented tuning knob, or it is removed once the underlying
  conflict-retry behavior is settled and the experiment is closed.

### `ownWriteEcho`

- **Toggle via.** `setOwnWriteEchoConfig()` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts). Server-side only; not
  a hello capability — every client generation handles the echoed frames, so
  there is nothing to negotiate.
- **Added by.** Robin McCollum, for CT-1965.
- **Purpose.** A sync frame includes a doc unless the writing session provably
  holds it: own accepted `patch`-produced heads ride the covering frame as full
  post-apply documents (merged state the writer cannot extrapolate), while own
  `set`- and `delete`-produced heads stay elided. Off restores full echo
  suppression — the pre-CT-1965 behavior, where promotion extrapolates every own
  write from the client's own ops.
- **Current default and planned end state.** On by default. The switch exists as
  an operational backstop while the echo field-soaks.
- **Status on 2026-08-08.** Implemented and on by default.
- **Path to removal.** After the echo has soaked in production, delete the
  config trio and the suppression branch it re-enables.

### `syncSchemaTableV2`

- **Toggle via.** `setSyncSchemaTableConfig()` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts). It is advertised as a
  capability in the memory `hello` handshake and negotiated per connection, so a
  peer only receives the compact form if it advertises support.
- **Added by.** Ben Follington, in "intern schemas in sync frames" (#4292).
- **Purpose.** A wire-size optimization: it packs the schemas in a sync payload
  into a hash-keyed, frame-local schema table instead of repeating them inline.
  It changes only the size of the payload, not its meaning. Peers that do not
  advertise the capability keep receiving the historical fully-expanded
  `SessionSync` shape.
- **Interaction with `contentAddressedSchemas`.** The two mechanisms
  compose (see that flag's entry): the table encoder skips
  reference-only positions, so it compresses exactly the stored links
  that still carry inline schemas and approaches a no-op as
  reference-bearing links take over. Runtime construction leaves the
  table's negotiation untouched.
- **Current default and planned end state.** On by default, everywhere;
  negotiated, so it degrades safely against older peers. The end state is
  to retire the negotiation and the expanded form once every peer AND the
  stored stock speak the compact form — the content-addressed-schemas
  spec's Phase 3 covers the link-position half of that retirement, and it
  is gated on stored data (reference-bearing links dominating), not on
  the flag: inline stock outlives every flag flip, and delivering it
  uncompressed pushes a large space's sync past Deno's 64 MiB inbound
  websocket frame cap (#6319).
- **Status on 2026-08-25.** Implemented; on by default everywhere.
- **Path to removal.** Confirm no peer still needs the expanded payload, then
  delete the negotiation and the expanded-form encoder and always send the
  compact form.

### `messageCompressionV1`

- **Toggle via.** `setMessageCompressionConfig()` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts). It is advertised as a
  capability in the memory `hello` handshake and enabled only when both peers
  advertise it and the transport supports compression streams.
- **Added by.** PR #6474, "compress memory WebSocket messages."
- **Purpose.** Compresses eligible memory messages into versioned binary
  WebSocket frames whose fixed header is followed directly by gzip bytes. Small
  and incompressible messages remain ordinary text frames. This raises the
  effective logical-message ceiling above Deno's 64 MiB frame limit when the
  compressed frame remains below that limit.
- **Current default and planned end state.** On by default. An explicit `false`
  is the programmatic rollback override: both clients and servers omit the
  capability and keep every frame textual. Remove the switch after the binary
  path and known relays have field-soaked; keep compression itself always on.
- **Status on 2026-08-28.** Implemented and on by default, negotiated per
  connection, with an explicit rollback override.
- **Path to removal.** Confirm all deployed peers and relays preserve binary
  WebSocket frames, then delete the config trio and advertise the capability
  unconditionally.

> Two neighbors in the same handshake are related but are not
> runtime-toggleable experimental flags:
>
> - **`sqliteCommitRowLabelEval`** is a build-inherent capability, hardwired to
>   `true`, advertising that this build's engine evaluates row-label rules at
>   commit time. It is not configuration: an older server that lacks the
>   capability advertises it absent (parsed as `false`), and a newer runner then
>   keeps its write gate failing closed. It was added by Bernhard Seefeld in
>   "server-side commit-time row-label re-derivation (Epic E4, Phase 3.c)"
>   (#4552). It is permanent.
> - **`verdictCatchUpMarkers`** is a build-inherent capability, hardwired to
>   `true`, advertising that the server stages a `caughtUpLocalSeq` catch-up
>   obligation for every accept and conflict rejection, delivered on the batched
>   fan-out (CT-1927; `04-protocol.md` §4.11.2). It is not configuration: the
>   CLIENT keys verdict parking on it — an accepted commit's promotion waits for
>   the marker only when the server advertises the capability AND a sync
>   consumer is live; against an older server (or with no watch view) verdicts
>   apply immediately, the historical behavior. Added by Robin McCollum
>   (CT-1927). It is permanent.
> - **`pendingReadStacks`** is a build-inherent capability, hardwired to `true`,
>   advertising that this build's engine resolves array-`localSeq` pending reads
>   (the full-stack dependency sets of CT-1872 1c; `resolvePendingReads` in
>   [`packages/memory/v2/engine.ts`](../../packages/memory/v2/engine.ts)). It is
>   not configuration: against a server that advertises it absent, the client
>   scalarizes each dependency array to its top-of-stack element before sending
>   (`scalarizePendingReadStacks` in
>   [`packages/runner/src/storage/v2.ts`](../../packages/runner/src/storage/v2.ts)),
>   and HOLDS the send until every omitted lower dependency has settled — a
>   dropped one dooms the commit locally before it reaches the wire; once all
>   are accepted the scalar shape is sound. (Sending while an omitted dependency
>   is unsettled would let the old server durably accept a commit the client
>   cascade-rejects — a split-brain where the caller sees a conflict for a write
>   that landed.) Scheduler observations degrade instead of holding: a
>   multi-layer observation is dropped client-side (flag-off semantics), so the
>   flush that semantic commits await never waits on verdicts. Added on CT-1872
>   (PR #4606). Path to removal: retire the scalarization fallback once every
>   server in the fleet advertises the capability; the flag itself then reads as
>   permanent documentation of the wire shape. (The CT-1910 basis repair —
>   `basisSeq` on pending reads, scanned with own-session exclusion — landed
>   WITHOUT a capability of its own: servers ignore unknown read fields, so
>   clients attach it unconditionally and older servers keep the legacy
>   max-dependency basis. CT-1910's remaining scope, server-inferred
>   dependencies, stays a follow-on protocol step.)
> - **`entityIdListing`** is a build-inherent capability, hardwired to `true`.
>   It advertises that the memory server can list live space-scoped entity
>   identifiers without returning stored values. Older servers omit it, which
>   parses as `false`. It is permanent.
> - **`entityIdPagination`** is a build-inherent capability, hardwired to
>   `true`. It advertises snapshot-checked, server-capped pages for
>   `entity-id.list`. Older servers return the historical complete response. It
>   is permanent.
> - **`entityIdLookup`** is a build-inherent capability, hardwired to `true`. It
>   advertises identifier-only `entity-id.exists` point lookup. Older servers
>   omit it, which parses as `false`. It is permanent.

### `experimentalConcurrentWatchRefresh`

- **Toggle via.** `experimentalConcurrentWatchRefresh` on
  `IRemoteStorageProviderSettings`
  ([`packages/runner/src/storage/interface.ts`](../../packages/runner/src/storage/interface.ts)),
  passed through `StorageManager` settings. The runner mirrors it onto each
  memory session via `SpaceSession.setConcurrentWatchRefresh()`
  ([`packages/memory/v2/client.ts`](../../packages/memory/v2/client.ts)) —
  per-session, not a process global. In the **shell** it is a
  per-browser-profile dogfood toggle: run
  `commonfabric.concurrentWatchRefresh(true)` in the console and reload. The
  flag crosses the worker IPC in `InitializationData` and is fixed at
  `StorageManager.open` time, so — like the render ceiling — it takes effect on
  the next runtime (reload), not live. Threaded shell → worker via
  `runtimeHostFlags()`
  ([`packages/shell/src/lib/host-toggles.ts`](../../packages/shell/src/lib/host-toggles.ts))
  → `RuntimeInternals.create` → `runtime-processor.ts`'s storage settings.
- **Added by.** Ben Follington (#4937; shell dogfood toggle #4974).
- **Purpose.** By default watch acquisition is strict single-flight per space: a
  guard holds every watch refresh after the first until the prior response
  lands, so traversal-driven pulls discovered a tick apart serialize into
  one-round-trip-each frames even when nothing depends on the prior response. On
  a high-RTT link this dominates cold-load wall-clock. With the flag on,
  refreshes overlap up to a bounded window (`CONCURRENT_WATCH_REFRESH_WINDOW`,
  currently 8) in `storage/v2.ts`, and the memory client issues the whole
  watch-mutation family (`watch.set` + `watch.add`) in an ordered issue phase so
  wire order is preserved and application stays ordered. Watch removals derive
  a full replacement set from session state, so they wait for preceding
  responses to be applied before constructing that set. Later acquisitions
  remain behind the removal in wire order. Each removal therefore drains the
  in-flight window: acquisitions issued after it wait until every earlier
  response has applied and the removal has been sent. Operation-watch
  cancellations pay that drain. Independent acquisitions still overlap, and
  same-tick microtask coalescing is unchanged.
- **Current default and planned end state.** Off by default. It is a spike
  pending live measurement on a real (estuary-latency) load; the window size is
  a tuning value. End state is either graduation to always-on with a settled
  window, or removal if the render-side fix (initial-render descent) makes the
  waterfall shallow enough that concurrency no longer pays.
- **Status on 2026-09-08.** Implemented behind the flag, off by default;
  concurrent acquisitions and removal retries have deterministic ordering
  coverage. Not yet measured end-to-end over real latency.
- **Path to removal.** Graduate to always-on once measured safe and beneficial,
  or remove if superseded by reducing the round-trip count at the source.

---

## Category 4: Shell dogfood toggles

### `cfcRenderCeiling`

- **Toggle via.** The browser console command
  `commonfabric.cfcRenderCeiling(enabled?)`, backed by the `cfcRenderCeiling`
  key in `localStorage`. It is per browser profile. See
  [`packages/shell/src/lib/render-ceiling.ts`](../../packages/shell/src/lib/render-ceiling.ts).
  Because the ceiling crosses the worker boundary in the fixed initialization
  data, flipping it takes effect on the next runtime (a reload or re-login), not
  live. A browser integration test states the side it needs through the
  `renderCeiling` option of `ShellIntegration.goto`, which writes the same key
  after the navigation and before the login.
- **Added by.** Bernhard Seefeld, in "populate the render confidentiality
  ceiling behind a shell dogfood flag (Epic H3a)" (#4550, 2026-07-07).
- **Purpose.** Populates the CFC render confidentiality ceiling in the shell's
  runtime. Display sinks admit the acting user's identity and personal-space
  atoms plus allow-listed influence-class caveat kinds. Before the fit check,
  the worker resolves shared `Space` labels through verified reader membership,
  and runs the exchange rules of any module policy (`PolicyOf`) a label
  selects, reading that policy's manifest from the space the label is stored
  in and verifying its digest; a delegate's access to the session workspace
  requires its own membership evidence. Confidentiality the ceiling does not
  satisfy stays blocked, and author-supplied render-boundary declassification
  is denied.
- **Current default and planned end state.** On by default; a browser profile
  opts out with `commonfabric.cfcRenderCeiling(false)`, which is what the
  `cfcRenderCeiling` localStorage key records. The end state is to remove the
  toggle and make the ceiling unconditional.
- **Status on 2026-09-23.** Exchange resolution is implemented, including
  module policies. Where reader membership is required, missing or unsynced
  ACL evidence keeps the content blocked; a reader grant admits it and a
  revocation blocks it again. A module policy whose manifest is missing, has
  not synced, or fails verification keeps its content blocked until a
  verifying manifest arrives. A rule guarded on reader membership of a subject
  held in commitment form, as it is on a value copied across spaces, releases
  only to a viewer whose membership in that subject the render boundary
  already verified for another reason: the viewer's own or session space, or
  a `Space` atom the same label names. The commitment is never opened.
- **Path to removal.** Retire the opt-out once no profile needs it, then make
  the ceiling unconditional.

## Category 5: Fuse mount cache tuning

### `fuseNfsCacheTuning`

- **Toggle via.** `cf fuse mount --attrcache-timeout <seconds>` or
  `cf fuse mount --noattrcache` (mutually exclusive). Both plumb through the
  background supervisor and the compiled binary's hidden
  `fuse-daemon`/`fuse-supervisor` subcommands to `-o attrcache-timeout=<n>` /
  `-o noattrcache` in the args handed to FUSE-T's `fuse_mount`
  ([`packages/fuse/mount-options.ts`](../../packages/fuse/mount-options.ts),
  `buildMountFuseArgs`). The options are applied only when the loaded provider
  is FUSE-T; Linux and macFUSE mounts accept and ignore the flags, matching
  `--allow-other`'s Linux-only handling in reverse.
- **Added by.** Ian Hickson (noattrcache evaluation following #4642/#4654).
- **Purpose.** FUSE-T serves mounts through the macOS NFS client and ignores the
  entry/attribute timeouts the filesystem returns, so the client's age-based
  5-60 second caching defaults apply: a daemon-side `ENOENT` seeds a negative
  name cache entry served without daemon round-trips, and cached directory
  listings are served stale. Measured against a live space on FUSE-T 1.2.7 /
  macOS 26 (2026-07-14, recorded in
  [the evaluation](../history/packages/fuse/noattrcache-mount-option-evaluation.md)):
  untuned mounts showed stale-`NotFound` windows of 3.2-56.3 s and listing
  staleness of 0.8-53.4 s, while `attrcache-timeout=1` bounded both below half a
  second at no measurable stat cost (about 2 microseconds per stat,
  cache-served) and with zero read errors through sustained rebuild storms.
  `noattrcache` on FUSE-T 1.2.x maps to the NFS `nonegnamecache` flag only; it
  left 7.5-29 s windows and is kept as a diagnostic dial.
- **Current default and planned end state.** The flag value is a whole number of
  seconds. When neither flag is given, cf itself adds `-o attrcache-timeout=1`
  (one second) to every FUSE-T mount — the default lives in cf's
  `buildMountFuseArgs`, not in FUSE-T, whose own default is the untuned NFS
  client caching. `--attrcache-timeout 0` turns cf's addition off and leaves
  that untuned caching in place. Separately, the `cf exec` listing-recheck delay
  in [`packages/cli/lib/exec.ts`](../../packages/cli/lib/exec.ts)
  (`DIR_LISTING_RECHECK_DELAY_MS`, 3.5 seconds) remains as the backstop for
  untuned, macFUSE, and pre-1.0.29 FUSE-T mounts. That delay is sized for the
  untuned client's multi-second listing staleness; once field use confirms most
  mounts run with the one-second cache bound, the delay can be reduced to just
  over one second to match.
- **Status on 2026-07-14.** Implemented, on by default for FUSE-T mounts.
  Validated by a 5-minute live-space soak (1296 daemon-side writes, ~2790 reads
  per probe target, p99 read latency 4 ms, worst transient 110 ms, zero
  stale-negative false positives, daemon CPU ≤3%, no livelock).
- **Path to removal.** Fold the default into permanent documented behavior and
  shrink the exec.ts recheck delay, or retire the NFS dial entirely if FUSE-T's
  FSKit backend (macOS 26+) replaces the NFS backend.

---

## Category 6: Deployment feature gates

### `INGEST_SELF_SERVE_ENABLED`

- **Toggle via.** The `INGEST_SELF_SERVE_ENABLED` environment variable on
  toolshed, read once at module load
  ([`packages/toolshed/env.ts`](../../packages/toolshed/env.ts)). Not a
  `RuntimeOptions` flag: it gates an HTTP router, not runtime behavior.
- **Added by.** Alex Komoroske, in the self-serve ingest channels change.
- **Purpose.** Gates the `/api/ingest-channels` control plane, through which a
  user holding their own identity key mints, lists, rotates, and revokes ingest
  channels for spaces they own — without an operator. When off, the router
  [404s every verb](../../packages/toolshed/routes/ingest-channels/gate.ts)
  before the body limit, the rate limiter, or signature verification runs, so a
  deployment that has not opted in does not advertise the endpoint. The data
  plane (`/api/ingest/:id`) and the operator provisioning scripts are
  unaffected by the flag.
- **Current default and planned end state.** Off by default. The gate exists
  because minting issues a durable bearer capability that outlives the trust
  conditions that authorized it, and because authorization rests on the memory
  ACL — which, for a NAMED space, is only as strong as a key currently derived
  from the public passphrase `"common user"`
  ([`packages/identity/src/session.ts`](../../packages/identity/src/session.ts)).
  Anyone can derive that key today, so on a deployment with named spaces the
  owner check is not yet a real boundary. That derivation supports the legacy
  space names used during development and nothing else, and is removed once
  those development-only spaces have been migrated
  ([random space identities](../plans/random-space-identities.md)). The end
  state is on by default.
- **Status on 2026-08-07.** Implemented, off by default. The derivation
  weakness is pinned by a tripwire test
  ([`space-key-derivation-tripwire.test.ts`](../../packages/toolshed/routes/ingest-channels/space-key-derivation-tripwire.test.ts))
  that FAILS once the derivation is fixed — the signal to flip the default and
  to sweep any channels minted under the old trust conditions with
  `retire-ingest-channels`. See
  [`self-serve-ingest-channels.md`](../features/self-serve-ingest-channels.md).
- **Path to removal.** Fix named-space key derivation, run the retirement
  sweep, turn the flag on by default, then delete the gate and mount the router
  unconditionally.

### `SERVER_EXECUTION_STORE_READ_THROUGH`

- **Toggle via.** The `SERVER_EXECUTION_STORE_READ_THROUGH` environment
  variable on toolshed, read by the serving-host bootstrap
  ([`packages/toolshed/lib/server-execution.ts`](../../packages/toolshed/lib/server-execution.ts))
  into `SpaceServerPolicy.storeReadThrough`; a harness constructing an
  `ExecutorHost` sets the policy field directly. Only the literal `true` turns
  it on; `false` and unset leave it off, and anything else warns and leaves it
  off. Meaningful only with the serving loop running
  ([`serverExecution`](#serverexecution) on).
- **Added by.** Bernhard Seefeld, in the store read-through change.
- **Purpose.** The serving runtime reads its HOME space straight from the
  space's engine instead of over its loopback session: a document its replica
  does not hold is read synchronously on first access and a `sync()` of that
  document resolves from the engine with no session watch, while a `sync()` of
  a held document is answered from the replica, and the feed's admitted commits
  re-read the documents the replica holds. The memory server then never walks
  a selector's schema closure for the serving session, and the loopback
  transport carries no frames for it. Writes and foreign-space reads stay on
  the session. [`serving-loop.md`](../specs/server-side-execution/serving-loop.md)
  §1 plane (a) states the posture and what it does not do.
- **Current default and planned end state.** Off by default. The read-through
  follows session delivery's rules in its own form: another principal's
  instance is read only under a live tenure of the space's lease (a read that
  finds the row lapsed runs the renew arm first, and is withheld when the
  lease is not regained), and an address the store holds nothing at leaves no
  record. What stands between it and a default is soak with the posture forced
  on. The end state is on by default, then the session read path for the home
  space goes.
- **Status on 2026-09-11.** Implemented, off by default. With the posture
  forced on, the runner's executor suites pass except two steps whose
  expectations are session-specific: a precondition probe that reads the
  serving replica to check what it holds (under the posture the probe itself
  loads the instance), and the lease-lapse pin's withheld-then-re-delivered
  shape (under the posture the read reacquires and is served at once). The
  fan-out RAGGED case is pinned under the posture in
  `packages/runner/test/executor-fan-out.test.ts`: the run that discovers
  session depth serves the session instance at the moved ratchet, and a later
  session-scoped write re-runs it under the session key. The toolshed-backed
  integration lanes pass. Measured on the topic-board navigation benchmark:
  the served journey runs in roughly a third of the time.
- **Path to removal.** Soak with the posture forced on, flip the default, then
  delete the knob and the home-space session read path it replaces.

## Flag-gated tripwires

Some code paths refuse a value they cannot yet handle, by throwing and naming
what is missing, rather than accepting it and doing something plausible but
wrong. The `FabricInstance` checks in the runner's binding walks are the
recurring example: such a value is a container reached by its codec contents
rather than by property name, and a walk that cannot yet descend one would
otherwise hand it back whole, leaving a binding nested inside it silently
unresolved.

These throws are **discovery instruments**. Each one that fires names a site
that owes work — for a flag-gated site, work the flag needs before it can
graduate — which is more useful than a quiet wrong answer that surfaces later as
corrupted data.

**The invariant that makes this safe rather than merely lucky:** nothing that
reaches one of these throws is believed to be in production use. That is what a
tripwire asserts, and it is what makes refusing the right answer — refusing
costs nothing if nobody is doing the thing, and says so immediately if somebody
is.

The invariant holds in two strengths, and it is worth knowing which one a given
site has:

- **By construction**, where an experiment flag gates the only path that
  arrives. A default configuration never reaches the throw, and any arrival is
  something a flag was deliberately turned on to reach.
- **De facto**, where the value is shipped and ungated and simply has no
  production caller yet. A `FabricError` is exposed to pattern authors
  (`builder/factory.ts`) and reaches these throws with every flag off; the same
  value written from the client reaches `CellHandle.serialize()`'s refusal of a
  `FabricInstance` the same way. Nothing stops such a call being written
  tomorrow. What makes the tripwire safe today is that none exists.

The second is the weaker claim, but it does not fail quietly, and that is the
point. Add a production use of one of these values and the throw fires — at the
moment the use is added, in the change that added it. Three honest ways lead out
of that: implement the handling the throw names, back the use out, or establish
that the site was never one a refusal belonged at and give it the answer it
owes.

That third one is rare and carries the heaviest burden of proof, because it
closes nothing. A site taking it still cannot reach what the value holds; what
changes is that it reports that in a form its caller can act on rather than
throwing. So it is available only where the site has somewhere to put the
report and records it there, and where refusing would cost more than the gap
does — a walk under a subscription that has to keep delivering cannot throw at
all, and a walk that only decides what a path finds is reporting an absence
rather than handing back a wrong value. Reaching for a non-throwing predicate,
on its own, is not this: without the record it is the quiet exemption the next
obligation rules out, and the two are told apart by what the site does with the
answer rather than by which identifier it calls.

`reactive-dependencies.ts` is the worked example. Its `isKeyable()` descends a
`FabricInstance` by property name, because refusing would cost the rest of a
notification's changes and reporting one as having no keys would lose
reachability the walk already reports. The marker above it records what the
descent still misses, which is the record the paragraph above requires.

So the tripwire is its own enforcement, which is why an ungated site is
legitimate. What it is not is a flag, so do not cite this section as though one
stood behind every throw.

Three obligations follow, and they are the reason this is recorded here rather
than at any one of the sites:

- **Adding a feature.** If your change would let a value reach one of these
  throws in a default configuration, you have three options and they are all
  fine: gate the change on an experiment flag, implement the handling the throw
  names first, or do not add the use. What is not an option is shipping the use
  and leaving the throw reachable in production.
- **Adding a throw.** Say which strength it has. A de-facto one is legitimate —
  several exist — but it is a claim about the callers that exist today, so it
  should be made deliberately rather than assumed from this section.
- **Meeting one.** A throw firing is the instrument working, not a defect in it.
  Implement the missing handling at the site it names — for a flag-gated site
  that work _is_ the flag's graduation work — or back out the use that reached
  it, or take the third way above and say in the change why the site owes an
  answer rather than a refusal. What is not on the list is exempting the value
  so the walk stays quiet, and swapping a throwing call for a non-throwing one
  without recording what the site now under-reports is that.

The container question `isWalkableObjectOrArray()` asks is the widest of these
refusals, being reached from around twenty-five walks across `runner` and
`piece`. Its strength at those sites is de facto rather than structural: a
`FabricInstance` can be constructed and handed to any of them. What supports
the claim is that `FabricError` is the one instance with live traffic today —
the fetch builtins store one as a result. Writing one, appending one, reading
one back, replacing one and deleting it were each driven through `Cell` within
a single transaction, and replacing one was driven again across a commit
boundary. Four walks refused something those operations reach, and each now
answers instead: the two stored path reads in `storage/v2-path.ts`, three sites
in `data-updating.ts`, and the shallow structure comparison in
`storage/v2-transaction.ts` that the commit-time reactivity pass feeds. The
last was found only by the cross-boundary replace, which is why the list is a
record of what has been driven rather than a claim about what has not.

Three walks were given the same treatment without a reachable operation to
justify it, and are recorded here as untested rather than measured: `getAtPath`
in `traverse.ts`, `mergeAnyOfMatches` in the same file, and
`sendValueToBindingInner` in `pattern-binding.ts`. `getAtPath` follows the
decision `traverseDAG` states a few hundred lines above it, that this file
cannot fail loudly on an instance yet; the other two keep the refusal.

Worked example: with [`modernCellRep`](#moderncellrep) on, a link is a
`FabricLink` and therefore a `FabricInstance`, so ordinary links reach these
checks and throw. That is expected, and the set of sites it lights up is a
useful part of the remaining work for that flag.

---

## How flags propagate

The environment-backed flags (`EXPERIMENTAL_MODERN_CELL_REP`,
`EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS`,
`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS`,
`EXPERIMENTAL_COMPUTED_CELL_IDS`,
`EXPERIMENTAL_LAZY_MATERIALIZATION`,
`EXPERIMENTAL_READER_SCHEMA_PRECEDENCE`,
`EXPERIMENTAL_SERVER_EXECUTION`) reach the runtime through the
deployed processes. The runtime-only flags (`commitPreconditions`, the CFC
dials) reach it only through the `RuntimeOptions` passed to `new Runtime(...)`.

All first-party processes build their `RuntimeOptions` through a construction
preset in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
and the environment-backed flags reach the runtime through the one canonical
mapping, `experimentalOptionsFromEnv`, in
[`packages/runner/src/experimental-posture.ts`](../../packages/runner/src/experimental-posture.ts). That mapping accepts
exactly `"true"` and `"false"`: an unset variable stays `undefined`, which the
runtime reads as "use the built-in default", and any other value is ignored with
a warning. (The distinction between unset and an explicit `false` matters,
because an explicit value overrides a built-in default that happens to be on.)

### Server-side (Deno processes)

```
Server Process (Deno)
  |
  +-- ENV: EXPERIMENTAL_* = "true" | "false"
  |
  +-- runner/experimental-posture.ts --> experimentalOptionsFromEnv(Deno.env.get)
  +-- toolshed/runtime-options.ts --> runtimePresets.productionServer({ experimental, ... })
  +-- toolshed/index.ts           --> new Runtime(toolshedRuntimeOptions(...))
```

The background piece service's main and worker processes use the same mapping
and the same presets, so the server-side wirings agree on how a value parses.

The CLI is not one of them. `cf`, the pieces controller behind it, the agents
host, the GitHub connector host and `cast-admin` are clients of a deployment
rather than part of one, and
they resolve their posture from that deployment first — the environment
supplies their overrides, not their starting point. Their wiring is
[Clients that are not built alongside their
server](#clients-that-are-not-built-alongside-their-server). The CLI's
LOCAL modes (`cf test`, `cf check`) run against emulated storage, have no
deployment to ask, and do read the environment alone, through this same
mapping.

### Browser-side (build-time defines)

Browser-side flags are baked at build time and carried to the web worker
that hosts the runtime; changing one means rebuilding and redeploying the
shell.

```
Build Time (shell)
  |
  +-- ENV: EXPERIMENTAL_* = <value>
  +-- felt.config.ts   --> esbuild define: $EXPERIMENTAL_*
  +-- src/lib/env.ts   --> EXPERIMENTAL (parsed via the canonical parser)
  |
Browser (main thread)
  +-- views/RootView.ts --> RuntimeInternals.create({ ..., experimental: EXPERIMENTAL })
  +-- RuntimeClient.initialize(transport, { ..., experimental })
        |  postMessage (IPC), InitializationData carries experimental + CFC dials
        v
Browser web worker
  +-- runtime-client/src/backends/runtime-processor.ts
        --> new Runtime(runtimePresets.browserWorker({ experimental, cfcEnforcementMode, cfcFlowLabels, ... }))
```

The browser is also the one place a CFC dial is host-controlled at
construction: the `browserWorker` preset takes `cfcEnforcementMode` and
`cfcFlowLabels` from the shell's initialization data.

### Clients that are not built alongside their server

The shell disagrees with its server only by explicit define: toolshed bakes
the defines and serves the bundle, so the two ship one posture per deploy.
Every other client is installed, deployed, or checked out on its own
schedule — the `cf` binary, the pieces controller a FUSE mount opens, the
agents host, the GitHub connector host, the background-piece admin CLI — and
the environment they read
belongs to whoever launched them, not to the deployment they talk to. Left
there, the operator has to know a deployment's flags and set them by hand, and
nothing reports it when they do not.

These clients take the posture from the server instead. Each one calls
`experimentalOptionsForDeployedClient` in place of `experimentalOptionsFromEnv`
before constructing its `Runtime`:

```
cf / pieces controller / agents host / github host / cast-admin
  |
  +-- GET <apiUrl>/api/meta  --> { experimental: { <flag>: <boolean>, ... } }
  |     the posture the SERVER runs at
  |
  +-- runner/experimental-posture.ts --> experimentalOptionsForDeployedClient()
  |     explicit EXPERIMENTAL_* > server declaration > built-in default
  |
  +-- runtimePresets.remoteClient({ experimental, ... })
```

What the server publishes is the posture its constructed `Runtime` resolved —
built-in defaults and preset resolution included, not a second reading of its
own environment that could disagree with the first — flattened at
publish. A flag the server left unresolved is omitted, and a server
that has no `Runtime` yet publishes `experimental: null`; a client reads
either as "this deployment said nothing" and keeps its own default. A fetched
posture record that declares no `readerSchemaPrecedence` or `agentBuiltin`, or
a meta document with no `experimental` field at all, uses the corresponding
legacy `false` for those flags. An older server runs strict schema combining
and refuses agent requests, so this preserves its posture for newer clients.
An explicit `experimental: null` means a current server has no posture yet and
leaves the built-in defaults in force (`parseServerExperimentalOptions` draws
the line). For every other flag, absence of a declaration is not a declaration
of `false`.

A serving toolshed runs two kinds of runtime, and what it publishes is the
posture it SERVES at. The generic runtime it constructs for webhook pattern
execution supplies the base; under server-execution the per-space serving
runtimes force `serverExecution` on top of it (`SERVING_RUNTIME_EXPERIMENTAL`
in
[`packages/toolshed/lib/server-execution.ts`](../../packages/toolshed/lib/server-execution.ts),
the one place it is written), and that overrides the base for as long as the
serving loop runs. Every other flag reaches both runtimes from the same
environment, so the base already carries it.

Three rules govern what a client does with a declaration:

- **An explicit `EXPERIMENTAL_*` still wins.** It outranks the declaration:
  it is the documented rollback lever and how CI pins a lane, and a server
  able to overrule it would leave neither mechanism working. Setting one is
  also how you disagree with a deployment on purpose.
- **Only a server-authoritative flag is adopted.**
  `EXPERIMENTAL_FLAG_AUTHORITY` in
  [`packages/runner/src/experimental-posture.ts`](../../packages/runner/src/experimental-posture.ts)
  classifies every flag as `"server"` or `"client"`, type-gated the same way as
  the environment mapping, so a new flag does not compile until someone decides
  whether a `cf` binary follows the deployment on it. Every flag is `"server"`
  today: each is visible in what gets written, in what the server admits, or in
  which side runs the compute. `"client"` is for a flag that gates a purely
  in-process experiment — over-adopting costs nothing, while a client
  diverging where it should not is a silent corruption, so classify toward
  `"server"` when the answer is not obvious.
- **A client adopts only flags it knows.** The declaration is read through an
  allowlist of this build's own flags, and only boolean values: a key from a
  newer server is ignored as a matter of course, and a malformed value is
  dropped with a warning rather than coerced.

`CF_ADOPT_SERVER_FLAGS=false` turns the whole mechanism off for one process,
for the case where a deployment publishes something a client cannot run and you
do not yet know which flag it is. Per-flag `EXPERIMENTAL_*` overrides are the
answer when you do.

A caller whose startup can be cancelled passes its `AbortSignal`, and the
request carries it. Without one, a deployment that accepts the connection and
then says nothing holds that startup for as long as it stays silent, with no
shutdown able to reach it. An aborted signal is the one failure that does not
resolve to the environment: it throws the abort reason, because the caller has
stopped wanting a posture at all.

Presets that run against local emulated storage — `cf test`, `cf check`, the
pattern harnesses — have no server to ask and keep reading the environment
alone. The background piece service's own main and worker processes have one
but do not ask it: they are deployed with the same environment as the toolshed
they serve alongside, and read it directly through `productionServer`.

The adoption happens before `new Runtime(...)`, not at the memory handshake,
even though `hello`/`hello.ok` already carries capability flags in both
directions. Flags such as `modernCellRep` reach ambient control points inside
the constructor, before the transport connects, so a handshake-time value
would arrive after the process had already committed to a serialization. The
handshake's job stays what it is: refusing a connection whose peer resolved a
wire contract differently — which, for a client that adopts, is a mismatch
that should no longer arise.

### Background piece service

The background piece service reads the same environment variables and builds its
main and worker runtimes through the `productionServer` preset, so set the same
`EXPERIMENTAL_*` variables when starting it. Its `cast-admin` CLI is the
exception: that one is a client of whatever toolshed it is pointed at, and
adopts the deployment's posture like the others above.

## Enabling flags locally

Set the environment variables before building the shell (for browser-side flags)
and before starting the server (for server-side flags):

```bash
# One flag, build and run.
EXPERIMENTAL_EXAMPLE_NAME=true deno task dev

# Several flags.
EXPERIMENTAL_EXAMPLE_NAME_1=true \
EXPERIMENTAL_EXAMPLE_NAME_2=true \
deno task dev
```

Use exactly `true` or `false`. Values like `1`, `yes`, or `TRUE` used to be
coerced (and, before the mapping was unified, in opposite directions in
different processes); they are now ignored with a warning, leaving the built-in
default in place.

For the runtime-only flags and the CFC dials there is no environment variable;
enable them by constructing the `Runtime` with the option set (which is how the
tests exercise them). To advance a CFC dial for every first-party process at
once, change its value in `coreOptions` in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts).
For the enforcement mode in the interactive tools, use `CF_CFC_MODE`.

## Verifying flags are working

When any experimental flag is explicitly overridden, the `Runtime` constructor
logs it on startup, for example:

```
Experimental flag overrides: modernCellRep=true
```

- Server-side: look in the toolshed log.
- Browser-side: look in the browser developer console (the message comes from
  the web worker that hosts the runtime). You can also inspect the
  `EXPERIMENTAL` export from `packages/shell/src/lib/env.ts` in the console to
  see the baked-in values.

The dedicated plumbing test checks that constructing and disposing a `Runtime`
sets and resets the ambient flag state correctly:

```bash
cd packages/runner
deno test --allow-ffi --allow-env --allow-read test/experimental-options.test.ts
```

A second test, `packages/runner/test/runtime-presets.test.ts`, is a conformance
golden: it pins the full `RuntimeOptions` each preset produces, including the
`coreOptions` CFC pins, and the exact value each environment variable parses to
through `experimentalOptionsFromEnv`. Any change to the fleet-wide posture or
the env mapping shows up as a diff in that one file.

Both tests pass as of 2026-07-08. They exercise the flag plumbing and the
per-preset posture, not the full behavior of every feature under every flag
combination; the per-feature test matrices live with each feature's specs (for
example under [`docs/specs/scheduler-v2/`](../specs/scheduler-v2/) and the CFC
design docs).

## Implementation details

The Category 1 flags are declared as the `ExperimentalOptions` interface in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). The
`Runtime` constructor merges the provided flags with the built-in defaults —
the per-flag defaults live in the summary table above and each flag's
section, not in a second list here — propagates each one to its ambient
control point, and then reads the effective state back so that
`runtime.experimental.*` reflects what is actually in effect.

First-party construction config is centralized in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
while flag parsing, environment mappings, and deployed-client adoption live in
[`packages/runner/src/experimental-posture.ts`](../../packages/runner/src/experimental-posture.ts).
The browser-safe `@commonfabric/runner/experimental-posture` export provides
those functions to standalone hosts without loading the runtime implementation.
`runtime-presets.ts` re-exports those functions. The modules use these
registries:

- `EXPERIMENTAL_ENV_VARS` is
  the single environment-variable mapping for `ExperimentalOptions`, typed as
  `Record<keyof ExperimentalOptions, string |
  null>`, so every flag must be
  listed there (a real env var name, or `null` for "programmatic-only").
  `experimentalOptionsFromEnv` reads it.
- `RUNTIME_OPTION_KEYS` is an exhaustive, compile-checked registry of every
  `RuntimeOptions` key (including the CFC dials). Adding a new option to
  `RuntimeOptions` without registering it there is a compile error, which forces
  a decision about how each preset treats it.
- `coreOptions` holds the shared first-party posture (today, the CFC pins) that
  every preset composes.
- `EXPERIMENTAL_FLAG_AUTHORITY` classifies every flag as `"server"` or
  `"client"` for a client that is not built alongside its server, typed the same
  way, so a new flag forces that decision too.
  `experimentalOptionsForDeployedClient` resolves one client's posture through
  it; see
  [Clients that are not built alongside their
server](#clients-that-are-not-built-alongside-their-server).

- Only one set of experimental flags is active per JavaScript context at a time.
- In the browser the web worker is a separate JavaScript context, so its flags
  are independent of the main thread.
- For most flags, creating a new `Runtime` overwrites the ambient config and
  disposing it resets to the defaults. Two exceptions: `serverExecution`'s
  enabler is an OWNED refcounted claim — acquired at construction, released
  by that runtime's dispose (or its throwing construction) — so a co-hosted
  runtime's dispose cannot lift another's live claim; and
  `readerSchemaPrecedence` is construction-set only — dispose leaves it
  standing, since serving runtimes are per-space and idle-disposed.

---

## Appendix A: Removed and never-shipped flags

These are recorded so that references to them elsewhere in the tree do not send
a future reader hunting for a flag that no longer exists.

### `persistentSchedulerState` / `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` (removed)

Persisted the scheduler's observations to durable storage through memory-v2
and used them to rehydrate scheduler state after a restart, with a live
extension (incremental observation adoption) that let one client adopt
another's committed action runs. Added by Bernhard Seefeld in #3646
(2026-05-28); implemented and OFF by default throughout its life. Deleted by
server-execution v2 Phase 1 stage C (2026-08-04): the flag, its ambient
control point, the hello negotiation, the `scheduler.snapshot.list` RPC, the
commit-carried observation payload, and the seven observation tables all
left the tree, and the persisted form was REPLACED by the `scheduler_basis`
index ([`serving-loop.md`](../specs/server-side-execution/serving-loop.md)
§3b) — ids + seqs only, written by the serving loop when it lands. A store
that had opted in lost warm start once at the migration, by design; old
clients take the hello-degrade path (a server advertising nothing to
negotiate reads as "state absent, run fresh"). The archived specs:
[`persistent-scheduler-state.md`](../history/specs/persistent-scheduler-state.md),
[`per-doc-rehydration-persisted-form.md`](../history/specs/scheduler-v2/per-doc-rehydration-persisted-form.md),
[`incremental-observation-adoption.md`](../history/specs/scheduler-v2/incremental-observation-adoption.md).

### `eagerSourceAnnotation` / `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` (removed)

This flag gated the eager per-primitive stack capture and source-map walk that
populated debug `fn.src`. It was removed when builder source positions moved to
the compiler-generated `BuilderSourceSitesV1` sidecar: source locations are now
recorded once at compile time, persist with compiled module bytes, and are
served through a debug-only `WeakMap`. There is no runtime source-resolution
work left to gate, and identity, authorization, and scheduling remain
independent of `fn.src`.

TODO(gideon): drop this entry once no shell development build still in
circulation sets the flag. It is the one entry in this appendix that no
reference in the tree points at, so it earns its place only for the developer
whose local environment or deploy config still carries
`EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` — the flag was environment-settable and
defaulted on in shell development builds, so those values outlive the code.
Once that has aged out, this entry is pure history and belongs in neither this
document nor any other.

### `systemPatternAutoUpdate` / `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE` (removed)

The gate on rolling a same-toolshed system-source pattern forward in place.
Following a piece's source origin is no longer a deployment posture: it is what
opening a piece does, for every piece, described by
[`docs/specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md).
Nothing reconciles a piece nobody opened, so there is no fleet-wide behavior
left for a flag to select. `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE` is ignored
wherever it is still set.

### `systemPatternAutoUpdateHome` / `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME` (removed)

The second gate that held the **home** root (home.tsx) out of the system-pattern
update while the stable-addressing question was open: the home root carries real
user data (favorites, journal, the spaces list), and an in-place roll had to be
proven state-preserving first. `home-golden-replay.test.ts` pins exactly that
(seed representative home data, roll N→N+1 in place, prove every list
survives), and the 2026-07-21 estuary incident — a runtime migration bricking
every old-generation home root with no self-repair path because this flag was
off — made the cost of the extra gate concrete. Removed at the flag owner's
direction; the home root follows its origin like every other piece.

### `schedulerHistoricalMightWrite` (removed)

An `ExperimentalOptions` flag that preserved the scheduler's cumulative
"historical might-write" tracking for dependency scheduling, instead of the
current-known write set. It was confirmed deletable on 2026-06-11 and has been
removed from the code; under scheduler-v2's static write surface the writer map
is fixed at registration, so the discovered write history is obsolete. Several
scheduler-v2 spec documents still mention it as part of their migration history.

### `esmModuleLoader` / `CF_ESM_MODULE_LOADER` (removed)

The flag that selected the ESM module-record loader during the content-addressed
module-loading rollout. (An early draft of the plan called it
`EXPERIMENTAL_ESM_MODULE_LOADER`.) It was defaulted on, and then the flag and
the whole-bundle loader and cache it switched away from were all removed; the
ESM module-record loader is now the only loader. See
[`docs/history/specs/module-loading-implementation-plan.md`](../history/specs/module-loading-implementation-plan.md),
whose status header records the removal.

### `modernDataModel` / `MODERN_DATA_MODEL` (removed)

The flag that selected the fabric data model during its rollout. It was a
memory-config flag with a matching environment variable, carried in the memory
protocol's flag set so that peers agreed on which encoding was in use, and it
bifurcated cell-storage behavior along with the tests that pinned it — interned
symbols and the special numbers among them — for as long as the two encodings
coexisted. It ran from March 2026 until #3821 removed the environment variable
and the memory-config flag together; the fabric data model is now the only one.

[`docs/history/specs/persistent-scheduler-state/implementation_notes.md`](../history/specs/persistent-scheduler-state/implementation_notes.md)
cites it as the worked example of how to plumb a flag through the runtime,
shell, toolshed, and CLI, which is the pattern the persistent-scheduler-state
flag then followed.

---

## Appendix B: Related toggles that are not experimental flags

The sweep that produced this registry also turned up toggles that look like
flags but gate operational, debugging, build, or test behavior rather than the
rollout of an in-progress feature. They are intentionally out of scope here; the
general configuration reference is
[`docs/development/CONFIGURATION.md`](./CONFIGURATION.md). Recorded so a future
sweep does not mistake them for missing experimental flags:

- **`CF_CFC_MODE`** — sets `cfcEnforcementMode` in the cf-harness and the fuse
  mount. It is the way to drive the enforcement dial in those tools, not a
  separate flag.
- **Shell debugging and preference toggles** (localStorage):
  `forwardWorkerConsole` (forward the web worker's console to the main thread),
  `telemetryEnabled` (browser OpenTelemetry), `showDebuggerView`,
  `themePreference`.
- **Runner diagnostics** (environment): `CF_TRAVERSE_CAPTURE`,
  `CF_TRAVERSE_CAPTURE_MAX`, `CF_TRAVERSE_DIAGNOSTICS`. What each one does is in
  [the configuration reference](./CONFIGURATION.md#runner-diagnostics).
- **CLI controls** (environment): `CF_EXEC_SHEBANG`, `CF_CLI_TRACE_TIMINGS`,
  `CF_PROFILE_DONE_MARKER`.
- **`CF_ADOPT_SERVER_FLAGS`** — set to `false` to stop a client that is not
  built alongside its server from adopting that deployment's posture, leaving
  it on its own environment. An escape hatch over the mechanism, not a flag
  over a feature; see
  [Clients that are not built alongside their
server](#clients-that-are-not-built-alongside-their-server).
- **Operational and build toggles**: `RATE_LIMIT_TRUST_FORWARDED_FOR`
  (deployment topology, not a feature dial — see CONFIGURATION.md),
  `MEMORY_ACL_MODE` (`off` / `observe` /
  `enforce` space-access policy), `MEMORY_DUMP_ENABLED` (state-inspector dump
  endpoint), `OTEL_ENABLED`, `PRODUCTION` (shell build mode). ACL mode is a
  permanent deployment policy ladder, not an experimental runtime feature.
- **Test controls**: `TEST_LLM`, `TEST_HTTP`, and the integration-test
  environment variables (`HEADLESS`, `PIPE_CONSOLE`,
  `CFC_BROWSER_PROFILE_COUNT`, `CF_WAITFOR_DELAY_MS`).
