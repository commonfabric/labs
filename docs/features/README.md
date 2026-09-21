# Features and subsystems

One document per feature, or per aspect of the runtime. Each one is deep and
narrow: it explains how that piece behaves, what invariants it holds, and what
you need to know before you change it. Read one when you are working on the
thing it describes. None of them is general orientation.

The neighboring trees answer different questions.
[`../development/`](../development/README.md) is how to work in this repository
— style, dependencies, testing, debugging, continuous integration.
[`../specs/`](../specs/README.md) is what the system is required to do.
[`../common/`](../common/README.md) is how to author patterns.
[`../tutorial/`](../tutorial/README.md) is the guided introduction.

Name new documents in lowercase with hyphens, after the thing they describe. Add
a line for each new document to the index below.

## Writes, storage, and sync

- [`collection-indexes.md`](collection-indexes.md) — reactive grouping,
  unique-key lookup, membership ownership, and work limits
- [`collection-aggregates.md`](collection-aggregates.md) — named incremental
  aggregates, their numeric contracts, public type surface, and update costs
- [`read-accounting.md`](read-accounting.md) — opt-in reactive action read
  counters, execution boundaries, and per-step pattern-test reports
- [`view-scoped-client-replication.md`](view-scoped-client-replication.md) —
  visible renderer demand, server-observed input selection, and guarded local
  previews

- [`collaborative-fields.md`](collaborative-fields.md) — operation-based fields,
  CodeMirror's opt-in editor path, retained cursors and reset behavior, and
  offline inspection
- [`schema-graph-queries.md`](schema-graph-queries.md) — the query that asks
  which documents a schema reaches, why the client and the memory server run one
  implementation of it, what the two packages exchange to do that, and what the
  resulting coupling costs
- [`patch-operations.md`](patch-operations.md) — the family of single logical
  changes a commit carries, the registries that define each one exactly once,
  and how to add a new one across the memory, runner, api, and transformer
  layers
- [`mergeable-collection-writes.md`](mergeable-collection-writes.md) — why
  append, add-unique, increment, and remove-by-value exist as operations rather
  than as whole-value writes, and what they do to conflict detection
- [`keyed-collection-writes.md`](keyed-collection-writes.md) — addressing a
  record inside a collection by its key, which covers the read-then-write shapes
  the whole-value operations cannot
- [`migrating-collection-writes.md`](migrating-collection-writes.md) — how to
  change an existing handler over to a mergeable or keyed write, and the
  mistakes that make such a migration look finished when it is not
- [`committed-write-backpressure.md`](committed-write-backpressure.md) — how the
  scheduler keeps a committed write from being silently dropped when the server
  rejects it under contention
- [`authorization-failure-surfacing.md`](authorization-failure-surfacing.md) —
  how an authorization failure during storage sync reaches the caller as a typed
  error instead of a silent absent read or an endless wait
- [`custom-space-roots.md`](custom-space-roots.md) — seal a custom
  default-pattern reservation with the initial ACL.
- [`lazy-cell-materialization.md`](lazy-cell-materialization.md) — the
  schema-observing view a marked transaction hands back from a read, what it
  checks and when, and the rules that keep it agreeing with an eager read
- [`data-uri-identifiers.md`](data-uri-identifiers.md) — the cell identifiers
  that carry their own frozen value rather than naming a document in a space,
  why the runtime keeps both a broad and a narrow test for one, and what follows
  from there being nothing stored behind such an address

## Identity and people

- [`did-identifiers.md`](did-identifiers.md) — what makes a string a DID, the
  one module that decides it, and the guard for an argument that takes a space
  name rather than a DID
- [`shared-identity.md`](shared-identity.md) — using one identity across the
  browser, the `cf` command-line tool, the FUSE mount, and browser-driving
  agents when testing behavior that depends on who is acting
- [`active-user-counting.md`](active-user-counting.md) — what signal the server
  offers for counting active people, and the assumption any such count rests on
- [`home-space-internals.md`](home-space-internals.md) — the runtime
  implementation behind home-space behavior, including how the runtime derives
  the user's identity DID

## Talking to the outside world

- [`did-inboxes.md`](did-inboxes.md) — authenticated private delivery and durable
  receipts

- [`fetch-request-deadlines.md`](fetch-request-deadlines.md) — why the fetch
  builtins keep a wall-clock bound, what that bound actually measures, and what
  to check before changing when a request starts
- [`bidirectional-sync.md`](bidirectional-sync.md) — building an importer that
  syncs both ways with an external system that is the source of truth: identity,
  reconciliation, and write-back
- [`vouched-ingest-channel-mint.md`](vouched-ingest-channel-mint.md) — the
  split-mint seam that lets an outside source deposit data carrying a trusted
  provenance mark, without ever authoring that mark itself
- [`self-serve-ingest-channels.md`](self-serve-ingest-channels.md) — how a user
  mints an ingest channel for their own space without an operator: the space-ACL
  authorization model, why the two obvious designs are unsound, and the
  procedure for retiring channels when the trust conditions change
- [`gateway-request-provenance.md`](gateway-request-provenance.md) — how a
  request to the LLM gateway says which workload produced it, what a value is
  allowed to contain given that it reaches the provider, and why the machine
  label is drawn at random and the codebase declared
- [`llm-provider-boundary.md`](llm-provider-boundary.md) — which side of the
  language-model boundary owns the model catalog and the provider credentials,
  why the caller's package cannot hold either, and how a model name is resolved
  to a provider

## Patterns, components, and hosts

- [`server-pattern-lifecycle.md`](server-pattern-lifecycle.md) — the upload,
  instantiate, and setsrc verbs as calls the space's serving runtime executes
  under server execution: the route, the writer authority it needs, the wave
  cycle a verb runs in, the direct commit a source update's setup transaction
  makes outside that wave, and what `cf` still does in its own process
- [`invoking-handlers-outside-a-pattern.md`](invoking-handlers-outside-a-pattern.md)
  — calling a handler stream from `RuntimeProcessor`, or from anywhere else
  outside a pattern body
- [`host-embedding.md`](host-embedding.md) — the seams a host that is not the
  labs shell may bind to when it mounts our components and patterns, each one
  pinned by a test that goes red if the contract changes
- [`multi-document-runtime-attachment.md`](multi-document-runtime-attachment.md)
  — one worker serving several documents: what each of them owns separately,
  what all of them share, why an attach asserting a different security context
  is refused rather than merged, and which traffic still reaches only the
  document that stood the runtime up
- [`piece-bulk-operations.md`](piece-bulk-operations.md) — retargeting,
  repairing, and reversing many pieces in one space as one reviewable, resumable
  operation: what a plan row means, what each write proves first, what a stop
  leaves behind, and what a resume may claim

## Observability and testing

- [`logger-internals.md`](logger-internals.md) — the TypeScript side of the
  structured logging system: creating a logger, severity, timing, and flags
- [`cfc-denial-reporting.md`](cfc-denial-reporting.md) — how each Contextual
  Flow Control gate says what it turned away, what may be said at warning level
  and what reaches only debug, and how often a gate reports
- [`llm-testing.md`](llm-testing.md) — testing patterns and server routes that
  call a language model, covering the test-environment guard, the mocks, and the
  conversation fixtures
