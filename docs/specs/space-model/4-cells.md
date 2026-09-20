# Cells

This document specifies cells — the fundamental unit of reactive state in the
system.

## Status

Draft — based on extensive codebase investigation and design discussion.

## Overview

A **cell** is a named location that holds a typed value. Cells are identified
by a link (entity ID + path) and participate in the reactive dataflow graph.

Cells can be categorized along two dimensions:

1. **Implementation mechanism**: How change detection works
   - Value cells (content-compared)
   - Stream cells (occurrence-based)

2. **Semantic role**: What purpose the cell serves
   - Result metadata cells (execution metadata)
   - Precious data cells (irreplaceable):
     - User input (created/edited by user)
     - External input (fetched from outside, world has moved on)
   - Computed result cells (derived, reconstructible)
   - Stream cells (event endpoints)

---

## Current State

### Cell API

Cell methods are stratified by layer:

#### Transaction Layer

The core methods for data access:
- `get()`, `getRaw()` — read value (reactive)
- `sample()` — read value (non-reactive, no dependency tracking)
- `set()`, `setRaw()` — write value
- `update()`, `push()`, `remove()` — mutate
- `key()` — navigate to nested property
- `withTx()` — bind to transaction
- `asSchema()` — type cast

#### Reactivity Layer

Subscription and synchronization:
- `sink()` — subscribe to changes
- `pull()` — read with dependency tracking
- `sync()` — ensure synchronized with storage

#### Stream-Specific

- `send()` — dispatch event (only on streams)

#### Rarely Used Outside Foundation

- `setInitialValue()`, `setSelfRef()`
- `connect()`, `export()`
- `setSchema()` (deprecated)

### Implementation Mechanism: Value vs Stream

The implementation distinguishes cells by their change detection behavior:

| Aspect | Value Cell | Stream Cell |
|--------|------------|-------------|
| Stored value | Actual data | Nothing; the schema declares the stream |
| Read | `get()` returns value | `get()` returns the stream handle |
| Write | `set()` stores value | `send()` dispatches event |
| Change detection | Content comparison | Every send is distinct |
| Persistence | Value persisted | Only the declaration persists; events ephemeral |

The essential difference is **duplicate handling**:

- `cell.set(5); cell.set(5);` → one state, no second reaction (idempotent)
- `stream.send(5); stream.send(5);` → two events, two handler invocations

This is **state vs occurrence**:
- Value cells answer: "What is the current state?"
- Streams answer: "What just happened?"

### Semantic Categories

While the implementation sees only "value" and "stream," there are richer
semantic distinctions that matter for garbage collection, recovery, and UI:

#### Result Cell Metadata

Control plane metadata for piece execution is stored as metadata on the result
cell:

```
{
  pattern: SigilLink,  // link to pattern
  argument: SigilLink, // link to input data cell
  internal: Array<{
    partialCause: JSONValue,
    link: SigilLink
  }>,                 // manifest of derived internal cells
  schema?: JSONSchema
}
```

The argument cell and each derived internal cell are value cells with reciprocal
`result` metadata links back to their owning result cell. See
[Storage Format](./2-storage-format.md) for details.

#### Precious Data Cells

Data that **cannot be reconstructed** from inputs. Two subtypes:

**User input**: Data created or edited directly by the user:
- Text they typed
- Selections they made
- Files they uploaded
- Manually curated content

Loss means losing the user's creative act, which cannot be replayed.

**External input**: Data fetched from outside the system:
- API responses (stock prices, weather, search results)
- Scraped web content
- Sensor readings at a point in time

Loss means the data is gone — the external world has moved on and won't
produce the same result again. Even "re-fetching" yields different data.

Both subtypes must be preserved. The system should never garbage-collect
precious data.

#### Computed Result Cells

Derived data produced by patterns from inputs:
- Pattern outputs
- Aggregations and transformations
- Cached computations

These **can be reconstructed** by re-running the pattern with the same inputs.
Persisting them is an optimization (avoid recomputation), not a requirement.
The system could potentially discard and recompute these during compaction.

#### Stream Cells

Event endpoints for occurrences:
- User interactions (clicks, input)
- External events
- Signals between pieces

Events are ephemeral — only the most recent matters for triggering handlers.
The stream's identity is its document, which persists along with the schema
that declares it a stream; event payloads do not persist.

### Cross-Cutting Observations

- **Implementation vs semantics**: "Value cell" spans three semantic roles
  (process, precious, computed). The implementation doesn't distinguish them.
- **Reconstructibility**: The key semantic question is "can this be rebuilt?"
  Process and computed cells: yes. Precious and stream identity: no.
- **Identity mechanism**: All categories use the same `NormalizedFullLink`
  infrastructure for addressing and reactivity.
- **Declared vs effective API**: The type system declares six cell variants
  (`Cell`, `ReadonlyCell`, `WriteonlyCell`, `ComparableCell`, `OpaqueCell`,
  `Stream`), each with a different subset of methods. In practice, pattern code
  uses only two: `Cell` and `Stream`. `Writable<T>` is a type alias for
  `Cell<T>` with no distinct semantics — the codebase uses them
  interchangeably. The restricted variants exist in the API declarations but
  have no pattern-level consumers.

### Shared Identity Base

Regardless of cell type, all cells share:

- `entityId` — stable identifier
- `schema` — optional type information
- `getAsLink()` — serialization to `SigilLink`

A cell has no representation of its own in stored data; the link naming it
stands in wherever one is reached. Two mechanisms produce that link, and they
differ in what they already know about the value in hand:

- The write path recognizes a cell **by class**, then asks the cell for its own
  link. Which accessor it uses varies by caller, and the choice is theirs: a
  write may want the link relative to a base, a reconciler may not.
- A walk over an arbitrary graph — deriving a content-addressed id, or a
  pattern-authored schema default — has recognized nothing, so it asks **by
  member name**: `toEncodableForm()`, read via `hasEncodableForm()` /
  `encodableFormOf()` (`packages/runner/src/encodable-form.ts`). That name is
  the runtime's own, shared with the builder artifacts the same walk serializes.

`toJSON()` returns the same link under the JSON protocol's name, so a cell reads
as the link it names, framed by its class name, in any renderer that honors the
protocol — `toCompactDebugString()` among them. The data model gives that name
no standing of its own, and neither mechanism above consults it.

`toSigilLinkOrNull()`, `toEncodableForm()` and `toJSON()` return one link under
three names: the latter two delegate, so they cannot disagree. `getAsLink()` is
not among them — it builds a link from the options its caller passes, so asking
it for one relative to a base deliberately returns a different link.

---

## Proposed Directions

### API Surface Reduction

The "Rarely Used Outside Foundation" methods could be made internal-only,
reducing the public API surface and clarifying which methods are intended for
general use.

Beyond method visibility, the type hierarchy itself is wider than what consumers
use. The API declares six cell variants with different capability subsets:

| Variant | get | set | push | send | key | equals |
|---------|-----|-----|------|------|-----|--------|
| `Cell` / `Writable` | yes | yes | yes | yes | yes | yes |
| `ReadonlyCell` | yes | — | — | — | yes | yes |
| `WriteonlyCell` | — | yes | yes | — | yes | — |
| `ComparableCell` | — | — | — | — | yes | yes |
| `OpaqueCell` | — | — | — | — | yes | — |
| `Stream` | — | — | — | yes | — | — |

Pattern code uses only `Cell`/`Writable` and `Stream`. The effective
pattern-level API is:

- **Cell** (= `Writable`): `.get()`, `.set()`, `.push()` (dominant);
  `.key()`, `.update()`, `.remove()`, `.equals()` (occasional)
- **Stream**: `.send()`

`Writable<T>` is a pure type alias for `Cell<T>` — same interface, same runtime
object. It carries no enforced semantics: the runtime does not distinguish the
two. However, the naming serves a practical purpose: LLM-based code generators
were observed to confuse read-only pattern parameters (which are also reactive)
with writable state when both used the `Cell<T>` name. Renaming the writable
variant improved LLM comprehension of intent. The codebase is currently
inconsistent about which name is used — some patterns write `Writable<T>`,
others write `Cell<T>` in identical roles — but the intent is for `Writable<T>`
to signal write access.

The restricted variants (`ReadonlyCell`, `WriteonlyCell`, `ComparableCell`,
`OpaqueCell`) are not yet used by pattern code. The plan is to introduce a
transformer step that automatically narrows declared types to match actual usage
— e.g. `OpaqueCell` for reference-only passing, `WriteonlyCell` for write-only
cells. This would enforce least-privilege without requiring pattern authors to
manually select the right variant.

### Unification via Timestamps

If timestamps are an essential component of event data, the distinction
collapses:

```
stream.send(5) at t=1  →  {value: 5, timestamp: 1}
stream.send(5) at t=2  →  {value: 5, timestamp: 2}
```

These are content-distinct. Standard change detection handles it correctly.

#### The Unified Model

Instead of two cell types with different methods:
- One cell type
- Schema describes the data shape, including timestamps if event-like
- Change detection compares the whole value
- No special `asStream` flag needed

Example schema for an event location:
```json
{
  "type": "object",
  "properties": {
    "x": { "type": "number" },
    "y": { "type": "number" },
    "timestamp": { "type": "number" }
  }
}
```

The "event-ness" emerges from the data shape. Event producers include timestamps
(they know when things happened). No magic flags or bifurcated types.

#### What Unification Eliminates

- `asStream: true` flag
- Separate Stream type with duplicated methods
- `isStream()` / `isCell()` brand checking
- Special change-detection logic

#### What Unification Requires

- Clear convention for timestamp fields
- Possibly: schema-level indication of "where does the timestamp come from"
- Migration path for existing stream usages

#### Concerns and Constraints

The original stream/cell distinction was intentional and reflects real semantic
differences beyond change detection:

- **Scheduler context**: Computed values (lifts) are idempotent — they receive
  the same context across re-invocations, and re-running them with the same
  inputs should produce the same result. Event handlers are not idempotent —
  each invocation receives a fresh context, and side effects should not be
  replayed. A unified cell type would still need to distinguish these execution
  modes.
- **Reactive trigger semantics**: A lift re-executes when *any* input changes.
  An event handler should execute only when the event fires, not when other
  inputs change. This "react to event only" behavior is distinct from "react to
  any dependency" and would need to be preserved or re-expressed.
- **Stored last-event utility**: Unified cells could store the last event value,
  but the use cases for reading "the last click event" are unclear compared to
  reading current state.
- **DX clarity**: "Stream" is an established concept with well-understood
  semantics. Replacing it with timestamp conventions may reduce clarity.

Any implementation of unification should adopt the existing behavioral
distinctions (scheduler context, trigger semantics) rather than trying to
eliminate them. The goal is to unify the *storage and type representation*, not
to pretend that state and events have identical execution semantics.

#### Current State: No Timestamps on Payloads (but Invocations Are Unique)

The current system does **not** add timestamps or unique IDs to event payloads:
- `stream.send(event)` passes the payload directly to the scheduler
- DOM events have a `timeStamp` property, but `serializeEvent()` does not
  include it in the allowlist of properties passed through

However, each handler **invocation** does receive a unique identity. When an
event handler is invoked, `Runner.#instantiateJavaScriptHandlerNode`
(`packages/runner/src/runner.ts`) puts an event id in the `cause` object used
to derive cell identities for handler results — the durable id minted for the
dispatched event (`tx.dispatchedEventId`), falling back to a fresh
`crypto.randomUUID()` for non-dispatch invocations such as a test calling the
handler directly. This ensures that each invocation produces distinct result
cells, even for identical event payloads. The uniqueness is in the invocation
context, not in the event data itself.

For unification, timestamps or IDs would need to be part of the **event payload
or cell value** (not just the invocation context) — either injected at the
`send()` layer, in `serializeEvent()`, or by event producers explicitly.

#### Event Replay Consideration

Event replay (for debugging, testing, or recovery) is a related concern. For
replay to be possible, events would likely need unique markings anyway —
timestamps, sequence numbers, or IDs. This aligns with the unification
proposal: if events must be uniquely identifiable for replay, that same
identity makes them content-distinct for change detection.

---

## Open Questions

### Implementation Unification
- What is the migration path from current stream/cell split to unified model?
- How do existing `asStream: true` schemas translate?
- Should timestamps be required for events, or can the system add them?
- What are the exact semantics of "last event" queries on unified cells?
- How does the unified model affect the handler registration mechanism?

### Semantic Categories
- How should precious vs computed be distinguished in the data model?
- Should there be explicit markers, or is it inferred from the dataflow graph?
- What are the garbage collection / compaction rules for each category?
- How do semantic categories affect sync and backup strategies?

---

**Previous:** [Identity and References](./3-identity-and-references.md) | **Next:** [Transactions](./5-transactions.md)
