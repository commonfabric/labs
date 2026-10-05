# Reactivity

This document specifies how changes propagate through the system.

## Status

Current behavior. The scheduler-v2 spec contains the normative algorithm; this
chapter describes the space-model view.

---

## Current State

### Overview

The reactivity system connects data changes to computation through two patterns:
**dataflow** (value changes propagate to dependent computations) and **events**
(occurrences trigger handlers). These patterns compose: events often write to
value cells, which then propagate through dataflow.

### Two Data Flow Patterns

The system supports two fundamental patterns of data flow:

#### Dataflow: Value Cells → Pattern → Result Cell

```
┌─────────────┐     ┌─────────────┐
│ input cell  │────>│             │     ┌─────────────┐
└─────────────┘     │   pattern    │────>│ result cell │
┌─────────────┐     │             │     └─────────────┘
│ input cell  │────>│             │
└─────────────┘     └─────────────┘
```

This is **pull-based / demand-driven** reactivity:
- Pattern declares dependencies on input cells
- When any input value changes, dependent computations are marked invalid
- Invalid computations re-execute when an effect, handler preflight, or explicit
  `pull()` needs their output
- Result cell receives the new computed value
- Like a lazy spreadsheet: change a cell, and dependent formulas update when
  their values are observed

The scheduler tracks dependencies and ensures consistent propagation.

#### Events: External Occurrence → Stream Cell → Handler

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  external   │────>│ stream cell │────>│   handler   │
│   event     │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
```

This is **push-based / occurrence-driven** reactivity:
- External event (user click, API response, timer) arrives
- Event is sent to a stream cell
- Registered handlers are invoked with the event payload
- Like DOM events: something happens, listeners react

Handlers may write to value cells, bridging events into dataflow.

#### Bridging the Two Patterns

Events often produce state changes:

```
click event ──> stream ──> handler ──> writes to value cell ──> dataflow propagates
```

This is how user interactions flow through the system: an event triggers a
handler, which updates state, which causes dependent computations to re-run.

### Graph structure and persisted observations

The live object graph is reconstructed at runtime; JavaScript node objects and
edges are not serialized directly. What is persisted:

- Cell values (including stream markers)
- Result-cell metadata (`pattern`, `argument`, and the `internal` manifest)
- Ownership links from generated cells back to their result cell
- When persistent scheduler state is enabled, per-action observations containing
  durable identity, reads, the fixed registered write surface, gate options,
  and clean/invalid markers

From this persistent data, the system loads patterns, registers handlers, and
restores valid dependency/write indexes without re-running clean computations.
Missing, stale, or mismatched observations conservatively run fresh.

The dependency graph is also **dynamic and state-dependent**. Conditional
constructs like `ifElse(cond, left, right)` cause downstream nodes to react to
changes in `left` or `right` depending on the current value of `cond`. The
edges in the graph shift as state changes. This means the set of dependencies
for a given computation can only be known by actually running it.

### Subscription Mechanisms

#### `sink()` — Subscribe to Changes

For value cells:
```typescript
// Shown for illustration only.
const cancel = cell.sink((value) => {
  console.log("Value changed:", value);
});
```

The callback fires when the cell's value changes.

For stream cells:
```typescript
// Shown for illustration only.
const cancel = stream.sink((event) => {
  console.log("Event received:", event);
});
```

The callback fires for each event.

#### `pull()` — Read with Dependency Tracking

```typescript
// Shown for illustration only.
const value = await cell.pull();
```

Used for one-shot reads with dependency tracking.

### Event Dispatch

When `stream.send(event)` is called:

1. The event receives a durable id and reserves its position in the global FIFO
2. If necessary, the owning piece loads while that position remains parked
3. Exactly one registered handler is consistency-preflighted and invoked
4. The handling transaction creates the event-derived result-cell receipt

### Lazy Piece Loading

When an event arrives but no handler is registered:

1. Start from the event cell's document root
2. Follow `result` metadata to the owning result cell
3. Read the result cell's `patternIdentity` metadata
4. Load the pattern by that identity, start the piece, and hydrate the reserved
   queue slot

This enables pieces to start on-demand when events arrive.

### The Ownership Metadata Chain

The current runtime treats the result cell as the root of a piece. The result
cell names its pattern in its `patternIdentity` metadata: a
`{ identity, symbol }` reference, where `identity` is the content identity of
the pattern's entry module and `symbol` the export that module defines it
under. The reference is a value rather than a link, and the runtime loads the
pattern by that identity. The result cell also stores a metadata link to its
argument cell. Its `internal` metadata is not a direct link either; it is a
manifest of derived internal cells:

```
              ┌─ meta:patternIdentity ─ { identity, symbol }
              │
result cell ──┼─ meta:argument ───────> argument cell
              │
              └─ meta:internal ───────> [
                                          { partialCause, link: internal cell },
                                          ...
                                        ]
```

Cells created as implementation details of the piece store metadata pointing
back to that result cell. In code this is the `result` metadata link, set by
`setResultCell(...)` and read through `getMetaLink(cell, "result")`:

```
argument cell ── meta:result ──┐
derived internal cell ─────────┼──> result cell
child result ─── meta:result ──┘
```

The important property is the direction of discovery: from an arbitrary owned
cell, follow `result` metadata until reaching the owning result cell; from that
result cell, read `patternIdentity` metadata to determine which pattern governs
the piece.

This metadata is not a reactive dependency edge. Runtime code generally reads it
with scheduling ignored, because it is ownership/control-plane information used
to find and start the responsible piece.

This chain enables:
- Finding which pattern governs a cell
- Lazy piece loading (traverse to find owner)
- Schema-aware traversal of argument metadata, internal manifest links, and
  result metadata

### Handler Registration

Handlers are registered when patterns run. They are stored in memory (not
persisted) and re-register on piece restart.

### Change Detection

For value cells, change detection compares content:
- Same value written twice → no reaction
- Different value → dependents notified

For streams, every send triggers:
- Handler invoked for each event
- No content comparison

---

## Proposed Directions

### Unified Change Detection

If cells are unified via timestamps (see [Cells](./4-cells.md)), change detection
would naturally handle both cases via content comparison on timestamped data.
This would eliminate the special-casing for streams.

---

## Open Questions (Answered)

- ~~What is the exact scheduling algorithm?~~ One demand-driven scheduler runs
  invalid live nodes. Effects/materializers establish demand; handler preflight
  and `.pull()` add transient demand. Each settle iteration topologically orders
  the active wave using writer→reader edges.
- ~~How are cycles in the dependency graph handled?~~ Settle iterations and
  per-node run budgets are bounded. Work that still fails to converge is
  deferred behind a capped escalating backoff gate rather than spinning.
- ~~What are the consistency guarantees during propagation?~~ Effects (sinks)
  should only run once all computations are done, so they observe a consistent
  state. Exceptions exist for deliberate debouncing or threshold-based execution.
- ~~How does batching work for multiple simultaneous changes?~~ Each
  action/handler invocation is its own transaction. The transaction mechanism is
  used for marking dependencies dirty, which then triggers propagation.
- ~~What is the relationship between reactivity and transactions?~~ See above —
  the transaction commit is the event that marks dependencies dirty and triggers
  the reactive propagation cycle.

## Remaining Open Questions

- Scheduler state is not persisted (the experimental persisted form was
  deleted by server-execution v2 Phase 1 stage C; the archived account is
  [Persistent Scheduler State](../../history/specs/persistent-scheduler-state.md)).
  The durable successor is the serving loop's basis index
  ([serving-loop.md §3b](../server-side-execution/serving-loop.md)).
- How should deliberate debouncing and threshold-based execution be specified?

---

**Previous:** [Transactions](./5-transactions.md) | **Next:** [Schemas](./7-schemas.md)
