# Pattern Learnings

Use this as the prompt for new pattern runs. Focus on deterministic, reusable,
offline-friendly patterns that the harness can assert confidently.

## Core Mindset

- Treat patterns as data pipelines: sanitize inputs, expose stable derives, keep
  handlers lean.
- Prefer `lift`-centric flows; `derive` is just `lift(fn)(cell)`, so stay with
  the `lift` form unless readability demands otherwise.
- Type defaults with `Default<Type, Value>` so argument cells always start from
  a known shape without runtime `.setDefault`.
- Every output surfaced to the harness must be deterministic, regardless of
  payload ordering or missing fields.
- The framework can turn cells into non-cells and vice-versa, and so call sites
  have to only match the underlying schema, but not cell boundaries. E.g.
  handlers request data as Cell<> to be able to write into them, but the pattern
  creating the handler can pass in regular references, they don't have to be
  cells.

## Cells and Lifts

- Normalize raw argument cells with a dedicated `lift` once, then share the
  sanitized cell across derives, handlers, and children.
- Capture immutable argument snapshots during the first `lift` run with
  `createCell`, then return cloned views so later mutations never leak back into
  the preserved defaults.
- Chain multiple `lift`s for multi-stage views; each stage should accept
  sanitized input and return a predictable shape.
- Combine sanitized inputs by calling `lift(fn)({ ...cells })` so ratios or
  paired transforms stay in sync without manual recompute steps.
- When arrays may contain sparse slots, create a sanitized copy before filling
  fallbacks so derives and handlers share the same dense ordering.
- When only reading from a cell, as is the case most of the times with `lift`,
  it isn't necessary to request Cell<> and then have to call .get, just specifiy
  the shape of the data needed.
- Use `cell()` for state owned by the pattern. when the new cell remains part of
  the returned graph.
- Lift automatically memoized derived objects, they only get recomputed when the
  data changes.

## Handler Design

- Guard every handler against `undefined` events or malformed payloads; exit
  early rather than mutating partial structures.
- Sanitize payload fields inside the handler before touching cells; shared
  helpers keep behavior consistent across events.
- Mutate the minimal slice of state, letting derives recompute projections.
  Prefer updating a single source cell and deriving summaries from it.
- For batched updates, write through sanitized cells shared with derives so the
  handler and viewer always agree on defaults.
- Only override metadata when events provide explicit values so sanitized
  defaults stay stable and deterministic.
- When handler logic depends on argument cells and internal aggregates,
  re-sanitize the argument cells inside the handler before writing so newly
  created entries share the same canonical structure as derived views.
- Gate multi-step navigation inside handlers so validation failures can still
  store canonical state while surfacing deterministic block reasons the harness
  can assert.
- When argument cells double as mutable state, write the canonicalized entries
  back into that argument cell and keep consumers on a sanitized `lift` view so
  initialization never needs to read values during pattern creation.
- Allow handlers to accept optional target priorities so escalations can jump
  directly to stricter SLAs while countdowns stay clamped to shared defaults.
- When promoting new keys (like reaction types), extend the canonical catalog
  before sanitizing state so every derive sees zeroed placeholders immediately.
- When relocating hierarchical nodes, pre-build a child adjacency map so cycle
  guards can short-circuit before mutating shared state.
- To re-open staged workflows, re-sanitize the full list before writing so
  downstream derives recompute from the canonical stage definitions.
- Capture both successful and rejected handler attempts in a normalized history
  cell so derives can expose deterministic audit logs without reusing transient
  event payloads.

## Derived Views & Determinism

- Sort, clamp, or normalize inside derives so lists, buckets, and summaries keep
  a stable ordering independent of mutation order.
- Deduplicate keyed collections inside the same sanitize helper before sorting
  so upsert-style handlers stay idempotent and replay produces deterministic
  ordering.
- Build cross-field validation snapshots with a single `lift` so boolean flags
  and delta views stay aligned across every exposed field.
- Aggregate compliance-style metrics in one `lift` snapshot and let smaller
  derives reuse those counts, labels, and gaps so handlers only update the
  canonical task list once.
- Collapse checklist readiness into a single sanitized lift so status labels,
  gating reasons, and summary strings reuse the same counts without drift.
- When deriving keyed collections, sanitize the key list first and iterate that
  order everywhere so handlers and derives reuse a deterministic sequence even
  after fallback entries populate missing items.
- Keep history or audit logs append-only and sanitized; store formatted strings
  or structured entries that can be asserted deterministically.
- Build cumulative timelines from sanitized arrays so start/end offsets stay
  deterministic even after reorder handlers reshuffle source entries.
- Preserve weighted totals alongside counts when deriving moving averages so
  sliding windows can reuse sanitized sums instead of recalculating from raw
  entries.
- Seed mutable log cells separately from their initial derived entry so handlers
  write into the history while a lift combines sanitized arguments with the
  recorded events.
- Derive forward-looking projections from the sanitized baseline rather than
  mutating extra cells so charts stay deterministic even if events skip days.
- When exposing conditional branches, make all branches share the same shape so
  downstream derives remain ergonomic and predictable.
- Snapshot raw values with `lift` before cloning or duplicating nodes; this
  keeps replicas in sync without leaking unsanitized data.
- Tie sanitize fallbacks to the same `lift` inputs (e.g. plan defaults + cycle
  overrides) so derived strings stay aligned when handlers swap configurations
  mid-run.
- Build live queues with derives so priority/schedule ordering stays consistent
  without mutating the underlying source list inside handlers.
- When surfacing per-entity summaries, reuse the sanitized source ordering so
  deterministic arrays stay stable regardless of event insertion order.
- Expose selected child metadata via a derive that inspects sanitized lists so
  index changes always follow the updated ordering without extra handlers.
- Derive eligibility or status summaries from the sanitized screening report so
  toggling guardrails only re-evaluates derived views while preserving the
  canonical ordering.
- Pre-build categorical buckets before populating them inside `lift` so empty
  groups remain visible and ordering stays deterministic when counts reach zero.
- Compose filter summary strings from sanitized counts plus label derives so
  harness expectations stay readable while filter cells remain internal.
- Derive category totals once and reuse them when mapping rules so handlers only
  mutate the raw collections feeding the pricing pipeline.
- Round weighted totals and shares before formatting derived strings so progress
  percentages stay consistent after handler-driven weight updates.
- Mirror tiered summaries from the same sanitized list so count labels and
  grouped arrays stay aligned when handlers promote entries between buckets.
- Drive display toggles from the same sanitized source cells so mode switches
  never diverge between raw text and formatted derives.
- When layering nested percentages, reuse a shared lift for sanitized totals so
  both group- and item-level ratios stay aligned without duplicate math.
- Clamp sequential ratio derives before formatting so percent labels remain
  stable when stages grow or shrink between events.
- When deriving topological orderings, keep the ready queue sorted after each
  push so deterministic traversal stays stable when multiple roots share zero
  indegree.
- Build canonical catalogs (questions, demographics, etc.) via lifts before
  deriving cross-stat tables so new records reuse the same stable ordering.
- When summarizing coverage across a catalog, populate a map keyed by sanitized
  identifiers first, then derive sorted arrays so registration order never
  affects deterministic expectations.
- Prime grouping derives from the sanitized catalog (channels, buckets, etc.) so
  every group returns a stable bucket even before entries arrive.
- For matrix-style summaries, build row and column order maps from sanitized
  inputs so handler writes can re-sort the combined entries deterministically.

- Seed bucket derives from a canonical status list so empty statuses still
  surface deterministic entries for assertions.

## Composition & Child Patterns

- Pass argument cells straight into child patterns; let each child sanitize its
  own inputs so shared handlers stay synchronous.
- Use guard cells to control conditional instantiation, and keep the guard in
  sync with status derives so re-instantiating a child resets defaults cleanly.
- Bubble child events by capturing their handler streams and forwarding through
  parent helpers; typed helpers prevent casting churn.
- Store manifests or configuration lists in sanitized cells so parent summaries
  and child resets remain aligned.
- Build child arrays via a `lift` that iterates index cells so parent summaries
  stay aligned with each child's sanitized subtotal output.

## Scenario & Harness Hygiene

- Scenario payloads should always be objects; avoid relying on implicit defaults
  or `undefined` in the harness.
- Reset or snapshot relevant cells at the start of multi-event steps so replayed
  batches stay predictable.
- Maintain dedicated cells for "latest" or "selected" slices when assertions
  need a simple hook; keep the raw log intact for derived summaries.
- Keep scenarios offline and deterministic: no timers, randomness, or ambient IO
  beyond the CTS APIs.
- When arguments supply initial collections that must later mutate, mirror them
  into your own `cell` via a seeding `lift` so handlers avoid reading during
  pattern creation while still honoring caller-provided defaults.
- When a pattern needs hyphenated identifiers (e.g. `in-progress`), expose an
  ordered array summary so harness assertions can use numeric indices instead of
  awkward bracket notation.
- Accumulate sequential timelines with a single `lift` that sums durations so
  reorder handlers only update the source array while derives recompute offsets
  deterministically.
- When scenarios stage new arguments mid-run, keep runtime state in dedicated
  cells and route the adoption through a handler so harness writes can queue
  inputs without mutating the live projection prematurely.

## Reuse & Abstractions

- Extract reusable sanitizer and formatter helpers so multiple handlers and
  derives can share them without drift.
- Treat patterns as building blocks. Compose them instead of re-implementing
  similar flows; parameterize shared logic with cells rather than global state.
- Document key invariants through derives and summary strings so harness output
  stays human-readable while remaining machine-checkable.
