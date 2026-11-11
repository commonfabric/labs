# Scheduler and serving loop (proposed)

**Status:** proposed. Nothing here is implemented. This document details one
part of the [compiled pattern language](README.md): what remains of
[Scheduler v2](../scheduler-v2/README.md) once a compiled instance evaluates
itself, how that remainder runs inside the
[serving loop](../server-side-execution/serving-loop.md), and how a client
speculates from the same compiled artifact.

The label rules and the constraints are taken as given from
[plan format and label templates](plan-and-label-templates.md) and from the
[built-in inventory](builtin-inventory.md). This document states when each is
evaluated and by which transaction. Where that needs a rule one of those
documents does not have, the rule is listed under
[Open questions](#12-open-questions) and goes to the specification first, as
[the correspondence procedure](../../development/cfc-spec-correspondence.md)
requires. The rulings in the
[continuation plan](../../plans/compiled-pattern-language.md) are fixed and
are applied as written.

Two documents beside this one are being written and are referred to by file
name only. `execution-and-storage.md` owns what happens inside one cause's
transaction for one instance, and what is stored: cone evaluation, the
in-memory memo, the keep set and the layout of a result document, causal
identifiers, durable operation state, cache promotion, and migration.
`footprint-analysis.md` owns the analysis that fills in a body's footprint and
decides between a static side-write target and a materializer. This document
owns what happens across instances and across processes. Where it needs
something from another document it states the assumption it made.

Citations of source name a file and a function, type, or constant. Paths that
begin with `scheduler/`, `executor/`, `cfc/`, `storage/`, `speculation/`, or
`builtins/` are relative to `runtime/runner/src/`.

## Contents

1. [What the compiled instance takes over, and what remains](#1-what-the-compiled-instance-takes-over-and-what-remains)
2. [Units and edges](#2-units-and-edges)
3. [Dirty slots from the change channel](#3-dirty-slots-from-the-change-channel)
4. [Demand](#4-demand)
5. [The event queue](#5-the-event-queue)
6. [Effects](#6-effects)
7. [Materializers](#7-materializers)
8. [Convergence bounds](#8-convergence-bounds)
9. [Links across spaces](#9-links-across-spaces)
10. [Joining the serving loop](#10-joining-the-serving-loop)
11. [Client speculation](#11-client-speculation)
12. [Open questions](#12-open-questions)

## Terms

The terms of the sibling documents are used unchanged: *instance*, *cone*,
*slot*, *observation class*, *template*, *kept output*, *keep set*, *body*,
*binding*, *operation*, *child*, *plan*. This document adds the following.

- **Cause.** An event delivered to a handler, a set of committed changes
  arriving from storage, the completion of an effect, or a change of demand
  (section 4.5). The overview lists the first three.
- **The transaction of a cause.** The one transaction in which the runtime
  evaluates what the cause made stale and something demands, in one space. A
  cause that reaches instances in two spaces has one transaction in each
  (section 9).
- **Unit.** Something the remaining scheduler holds a record for and decides
  to run: a pattern instance, an effectful operation, or a materializer.
- **Loaded.** An instance is loaded when a runtime holds its record. An
  instance that is not loaded has stored documents and no record.
- **Bound address.** The address a slot of a loaded instance resolves to: a
  space, a scope key, a document, and a path.
- **Dirty.** A slot is dirty when the value it observes at its bound address
  changed since the instance last evaluated a cone against it. A slot can
  also be *label-dirty* (section 3.6).
- **Stale.** A cone is stale when one of the slots its last evaluation read
  is dirty, or when it has never been evaluated. Which slots a cone's last
  evaluation read is recorded by cone evaluation, which
  `execution-and-storage.md` owns.
- **Demanded.** A kept output is demanded when something outside its cone
  needs its current value (section 4).
- **Scope instance.** One instance of a scoped document: the space's, one
  user's, or one session's
  ([scopes](../server-side-execution/scopes.md)). The word *instance* alone
  always means a pattern instance.
- **Wave.** The serving loop's unit of durable commit: the sealed
  transactions of the causes one cycle processed, committed together
  ([serving loop](../server-side-execution/serving-loop.md), §3).

## 1. What the compiled instance takes over, and what remains

### 1.1 Method

Scheduler v2 is specified as nine distinguishing facts (D1 to D9), ten
principles (P1 to P10), numbered sections of mechanism, and eleven invariants
(I1 to I11). The tables below go through all of them. Each row says what the
scheduler does today, with the source that does it, and gives one of three
dispositions:

- **Removed:** the compiled instance does it statically, and no run-time
  mechanism remains for work inside an instance;
- **Kept:** it applies across instances as it does today across nodes;
- **Changed:** it remains with a different unit or a different mechanism,
  which the row and the section it names describe.

Five places where the Scheduler v2 document and the source differ are
recorded here because the tables depend on them.

- The node record has no `runBudget` field. The per-pass count is
  `SchedulerNode.passRuns`, held against the constant `PASS_RUN_BUDGET`
  (`scheduler/node-record.ts`, `scheduler/constants.ts`).
- `NodeStatus` has a fourth value, `"unavailable"`, beside `never-ran`,
  `clean`, and `invalid` (`scheduler/node-record.ts`).
- The read set is not a field of the node. It is held per action in
  `DependencyUpdateState.dependencies` (`scheduler/dependency-updates.ts`).
- No identifier is named `sideWriteEnvelope`. Declared envelopes are
  `materializerWriteEnvelopes`, indexed by `SchedulerMaterializers`
  (`scheduler/materializers.ts`).
- There is one event queue for the whole runtime, `Scheduler.#eventQueue`
  (`scheduler/facade.ts`). The per-space lanes of §7.5 are proposed there and
  not built. An event handler's read closure is not a demand root in
  `isDemandRoot` (`scheduler/dependency-graph.ts`); it enters a pass as seeds.

### 1.2 The distinguishing facts

| Item | Today | Disposition | In this design |
| --- | --- | --- | --- |
| D1, state is external, shared, and written by many | The `Scheduler` constructor subscribes once with `storageManager.subscribe`, and `processStorageNotification` (`scheduler/invalidation.ts`) handles every notification that carries changes. The kinds are `commit`, `revert`, `load`, `pull`, `integrate`, and `reset` (`StorageNotification` in `storage/interface.ts`) | Kept | Every committed change, local or remote, is matched against one address index (section 3) |
| D2, dependencies are discovered | Each run's transaction becomes a read log (`txToReactivityLog` in `scheduler/reactivity.ts`), and the delta against the previous log is applied to the reader index (`resubscribePullSchedulerAction` in `scheduler/registration.ts`, `applyActionReadDelta` in `scheduler/trigger-index.ts`) | Removed for slots; kept for dynamic reads | A slot's bound address follows from the plan and the instance's bindings. Only `dynamic` reads are discovered from a journal (section 3.4) |
| D3, the graph rewires itself through data | A changed link or a changed condition changes the next run's read log | Changed | A changed link rebinds a slot. A changed selection changes which slots a cone reads. Both are deltas to existing records, with no rediscovery (sections 3.2, 4.3) |
| D4, nodes create nodes | A `map` coordinator starts a sub-pattern per element, and a node registered during a live run takes provisional demand (`Scheduler#markProvisionalDemand` in `scheduler/facade.ts`) | Changed | An element is a keyed cone inside its instance and is no unit. A child instance is created by a commit and gets a record when it is first demanded or sent an event |
| D5, large dormant regions | `SchedulerNode.liveRefs`, maintained by `registerDependentEdge` and its siblings (`scheduler/dependency-graph.ts`) | Kept | Demand is counted per kept output path (section 4). An instance nothing demands is not loaded at all |
| D6, runs are transactions | `runSchedulerAction` (`scheduler/run.ts`) opens one transaction per node run | Changed | One transaction per cause and space. It covers every instance of that space the cause reaches (section 10.2) |
| D7, events are serialized, transactional, and consistency-gated | `processPullQueuedEventDuringExecute` and `dispatchQueuedEvent` (`scheduler/events.ts`) | Kept, changed form | Section 5. The consistency gate becomes evaluation inside the event's transaction |
| D8, scheduler state is reconstructible | The serving loop's basis index: rows `SchedulerBasisRow` written by the wave (`executor/wave.ts`) | Kept, re-keyed | Rows are keyed by instance and cone (section 10.4) |
| D9, confidentiality flows through scheduling | `takeInvalidCauses` (`scheduler/invalidation.ts`) hands the trigger addresses to `tx.addCfcTriggerReads` in `runSchedulerAction` | Removed for slots; kept for dynamic reads | A template already contains every slot whose change can cause a recomputation. Trigger reads remain for `dynamic` reads (section 3.4) |

### 1.3 The principles

| Principle | Disposition | In this design |
| --- | --- | --- |
| P1, one change channel | Kept | Committed changes arrive through the storage subscription only. The writes the open transaction has staged are matched against the same index (section 3.5), so that one cause is evaluated to completion in one transaction. That is one matching mechanism with two sources, not a second channel with rules of its own |
| P2, value-accurate invalidation | Kept | A slot becomes dirty only when what its observation class observes at its bound address changed (section 3.3). Reachability is used for order and for demand, never to decide that something is stale |
| P3, demand gates execution | Kept | A cone is evaluated only when it is stale and one of its kept outputs is demanded, or a demanded cone reads it |
| P4, one static write surface | Kept, and stricter | The plan lists every write edge, and the runtime refuses a write the record does not list (`plan-and-label-templates.md`, §7.4). The registration-time log that could seed a write surface is not carried over. A handler received as a factory value is the exception: its write edges are known when the binding is made, not when the binder is compiled |
| P5, self-identification through the transaction | Changed | The source of a commit is a cause's transaction, not a node (`sourceAction` today, set in `runSchedulerAction`). The index has already been applied to that transaction's staged writes, so its own commit notification marks nothing. Materializers and effect operations keep suppression per unit |
| P6, subscriptions are durable and runs apply deltas | Removed for slots; kept for dynamic reads | Slot entries change only when a slot is rebound. The journaled reads of a `dynamic` node are diffed against the registered ones after each evaluation, as a node's read log is today |
| P7, convergence is bounded | Kept, at two levels | Section 8 |
| P8, policies are time gates | Kept for the units that have gates | Effect operations, materializers, and render sinks keep `eligibleAt` and the one wake timer (`SchedulerGates` in `scheduler/gates.ts`). A cone has no gate |
| P9, start modes | Removed | An instance record is built from its plan, its bindings, and its basis rows. There is no `fresh` or `resume` |
| P10, diagnostics observe | Kept | |

### 1.4 The mechanisms, by section

| Section | Today | Disposition | In this design |
| --- | --- | --- | --- |
| §4.1 Node record | `SchedulerNode` and `NodeRegistry` (`scheduler/node-record.ts`): status, `liveRefs`, `invalidCauses`, gate, `passRuns`, `provisionalDemand` | Removed for computations; kept for materializers | The instance record of section 2.2 replaces the records of all computations of one instance |
| §4.2 Computations | `lift`, `computed`, the list built-ins, and the raw built-ins register as computations | Removed as units | They are cones and bodies of an instance. The idempotency contract and its validator stay for every body that writes |
| §4.2 Effects | `sink` callbacks and `cell.pull()` | Kept | They are demand sources (section 2.5). The scheduler's word *effect* for them is not used here, where an effect is an effectful operation |
| §4.2 Event handlers are not nodes | | Kept | |
| §4.3 Primary output and static side-write targets | The static writer map | Changed | The writer map is derived from the plans' kept outputs and write edges (section 2.6). The stores a raw built-in declares (`storeWrites`) have no counterpart |
| §4.3 Materializers | `collectIdleMaterializerSeeds` and `addInvalidMaterializerPromotions` (`scheduler/settle.ts`) | Kept | Section 7 |
| §4.4 Registration and removal | `Scheduler.register` | Changed | Loading and releasing an instance record. Loading inserts index entries for the instance's slots and reads no cell data |
| §5.1, §5.2 Liveness | `notifyNodeLivenessChange`, `registerDependentEdge`, and the reference definition `recomputeLiveRefs` (`scheduler/dependency-graph.ts`) | Kept | The same maintenance over kept outputs instead of nodes (section 4.3) |
| §5.3 Provisional demand, `deferUntilDemand` | `Scheduler#markProvisionalDemand`; `deferUntilDemand` is set by `collectionIndexKeys` only | Removed | A pull extends through a link inside the cause's transaction, so a child created in a transaction is evaluated there exactly when something demanded reads it |
| §6.1 The change channel | `processStorageNotification` | Kept | Section 3 |
| §6.2 Declared reads as ordering hints | `SchedulerNode.declaredReads` | Removed | Order inside an instance is static. Across instances it follows from the reads (section 10.2) |
| §7.1, §7.2 The pass and the work set | `runPullSchedulerSettleLoop`, `collectPullIterationSeeds`, `buildPullIterationWorkSet` (`scheduler/settle.ts`) | Changed | The pass becomes the processing of one cause (section 10.2). No work set is collected inside an instance |
| §7.3 Run gate and run | `runSchedulerAction` | Changed | A cone is evaluated when it is stale and demanded. Commit rejection is handled per cause (section 5.5) |
| §7.4 Ordering and cycle breaking | `topologicalSort` and `CycleBreaks` (`scheduler/topology.ts`) | Removed | A cone is evaluated when a demanded cone reads it, so a producer is evaluated before its reader finishes. A cycle is bounded by the evaluation budget (section 8) and is not broken |
| §7.5 Events | `scheduler/events.ts` | Kept, changed form | Section 5 |
| §7.6 Event-initiated work, lineage, receipts, rejection classes | `SpeculationLineage` (`scheduler/lineage.ts`), `handlingReceiptId` (`scheduler/event-identity.ts`), `classifyCommitDisposition` (`scheduler/events.ts`) | Kept | Section 5.5. An event sent to a stream of the same space and an instantiation request are writes of the sending transaction, so they exist only if it commits |
| §7.7 Convergence bounds | `MAX_ITERS`, `PASS_RUN_BUDGET`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS` (`scheduler/constants.ts`), `planBudgetBackoff` (`scheduler/execution.ts`) | Kept, changed form | Section 8 |
| §8 Time gates | `SchedulerGates.eligibleAt` and `scheduleWake` | Kept on units | Section 6.4 lists the gates of effect operations. The remote-echo gate (`RemoteEchoBreaker` in `scheduler/echo-breaker.ts`) is kept and keyed by instance and cone (section 8.4) |
| §9 Persistence | Deleted there already | As is | Section 10.4 |
| §10 Trigger reads | `addInvalidCause`, `takeInvalidCauses`, `restoreInvalidCauses` | Kept for dynamic reads | Section 3.4 |
| §10 Preflight transactions | A read-only transaction that commits nothing and is outside CFC | Removed | What a handler reads is made current inside the event's transaction (section 5.3) |
| §10 Refusal surfacing | Reasons and structured refusal details (`cfc/refusal-detail.ts`) | Kept | Sections 5.5 and 11.5 |

### 1.5 The invariants

| Invariant | Disposition | In this design |
| --- | --- | --- |
| I1, live consistency | Kept | At quiescence every demanded kept output holds the value its cone computes from the current committed inputs |
| I2, dormancy | Kept | An instance nothing demands is not evaluated, and loading, dirtying, and releasing it read no cell data |
| I3, value-gated execution | Kept | A cone that has been evaluated is evaluated again only when a slot it read is dirty or its cause's transaction was rejected |
| I4, event order and consistency | Kept, per space | Handlers run in the order of section 5.4. Every value a handler reads is current when it reads it (section 5.3) |
| I5, self-stability | Kept | The commit of a cause's transaction dirties nothing in the instances that transaction evaluated |
| I6, bounded non-convergence | Kept, changed form | Section 8 |
| I7, restart equivalence | Kept | Through the basis index (section 10.4) |
| I8, provenance | Changed | A transaction carries its cause. A kept output carries its template, the identities bound to its slots, and the compiled pattern's identity |
| I9, order within a pass | Changed | Within a transaction, a cone is evaluated after every cone whose output it reads in that evaluation |
| I10, event-launched work | Kept | |
| I11, events handled at most once | Kept, with the same gap | The gap for a child phase in another space remains (section 9.4) |

### 1.6 What remains, in one list

A scheduler remains across instances with the five responsibilities the
overview names, and with convergence bounds:

1. turning committed changes into dirty slots (section 3);
2. tracking demand (section 4);
3. serializing events (section 5);
4. running effect operations (section 6) and materializers (section 7);
5. following links across spaces (section 9).

Its nine components of Scheduler v2 §12 reduce as follows. The registry
holds instance, operation, and materializer records. The graph holds the
address index, the writer map, and demand counts. Invalidation is unchanged.
Settle becomes the processing of one cause. The runner becomes cone
evaluation, which `execution-and-storage.md` owns. Events and gates are kept.
Persistence is the serving loop's basis index. Introspection is kept.

## 2. Units and edges

### 2.1 The three kinds of unit

| Unit | What it is | Its transactions |
| --- | --- | --- |
| Pattern instance | One running pattern with a result cell: an instantiated pattern, or a `Child` of a plan. A pattern compiled into another, such as a `map` body, is part of the enclosing instance and is no unit | None of its own. It is evaluated in the transactions of the causes that reach it |
| Effectful operation | One `Operation` of kind `effect` of a loaded instance, or one occurrence of a `BodyCall` of kind `effect` that a handler's committed transaction recorded | Its own: a request transaction and a completion transaction (section 6) |
| Materializer | One `Operation` of kind `materializer` of a loaded instance | Its own, one per run (section 7) |

A unit exists per scope instance where its state is scoped. A cone that reads
a `state` slot whose `StateCell.scope` is `user` or `session` is evaluated
once per demanding principal or session, as a narrowed node is today
([scopes](../server-side-execution/scopes.md), §2). *Assumed:* the known-scope
record that decides how many scope instances a node has carries over with a
cone in place of a node, and a slot bound through a link to a scoped document
narrows the cone when it is first evaluated, as a logged read narrows a node
today. `execution-and-storage.md` is asked to confirm it (open question 14).

### 2.2 The record of an instance

The record has a static part, which every instance of one compiled pattern
shares, and a part per instance.

```ts
/** Content address of a canonicalized record. */
export type Hash = string;
/** Index into the array of the plan that the field name says it indexes. */
export type Index = number;
export type Path = readonly string[];

/** A place in storage: what a slot is bound to and what a change names. */
export interface Address {
  readonly space: string;
  /** The scope instance: the space's, one user's, or one session's. */
  readonly scopeKey: string;
  readonly document: string;
  readonly path: Path;
}

/**
 * What the scheduler derives once from a plan and shares among all loaded
 * instances of that compiled pattern. Nothing in it depends on data.
 */
export interface PlanIndex {
  /** Identity of the `CompiledPattern` the plan belongs to. */
  readonly compiled: Hash;
  /** For each slot, the cones whose `Cone.slots` list it. */
  readonly conesOfSlot: readonly (readonly Index[])[];
  /** For each cone, the outputs with `kept: true` it computes. */
  readonly keptOutputsOfCone: readonly (readonly Index[])[];
  /** For each cone, the cones `Plan.edges` say it can make stale. */
  readonly readersOfCone: readonly (readonly Index[])[];
  /** Cones on a cycle of `Plan.edges`, for diagnostics (section 8.2). */
  readonly cyclicCones: readonly Index[];
}

/** Where one slot of one instance is bound. */
export interface SlotBinding {
  /** The address the slot resolves to. */
  readonly bound: Address;
  /**
   * The addresses of the links followed from the slot's root to `bound`. A
   * change at one of them rebinds the slot (section 3.2).
   */
  readonly chain: readonly Address[];
  /** For a slot with root `element`: the key of the element it is bound for. */
  readonly elementKey?: string;
}

/** The part of an instance record that is per instance. */
export interface InstanceRecord {
  /** The instance's result cell. */
  readonly result: Address;
  readonly plan: PlanIndex;
  /** By slot index, and for element slots by slot index and element key. */
  readonly bindings: ReadonlyMap<string, SlotBinding>;
  /** Slots whose observed value changed since a cone last read them. */
  readonly dirty: ReadonlySet<string>;
  /** Slots whose stored label changed and whose value did not. */
  readonly labelDirty: ReadonlySet<string>;
  /**
   * For each `dynamic` node that was evaluated: the addresses its journaled
   * reads touched, and the addresses whose change made it stale since.
   */
  readonly dynamic: ReadonlyMap<string, DynamicReadState>;
  /** Demand count per kept output (section 4.3). */
  readonly demand: ReadonlyMap<Index, number>;
  /** Evaluation counts of the open transaction (section 8.1). */
  readonly evaluations: ReadonlyMap<string, number>;
  /** The convergence and remote-echo gates (section 8). */
  readonly gate: UnitGate;
}

export interface DynamicReadState {
  readonly registered: readonly Address[];
  /** The trigger reads of section 3.4. */
  readonly triggers: readonly Address[];
}

export interface UnitGate {
  readonly backoffUntil?: number;
  readonly backoffStreak: number;
  readonly echoBackoffUntil?: number;
}
```

The record holds no read set, no status per cone, and no order. Which cones
are stale follows from `dirty`, the slots each cone's last evaluation read,
and `PlanIndex.readersOfCone`. The selections of the last evaluation and the
memo of evaluated cones are held beside the record by cone evaluation.

*Assumed:* cone evaluation supplies a function from an instance's dirty slots
and its last selections to its stale cones, and a slot that only an unselected
branch reads does not make a cone stale. `plan-and-label-templates.md` §3.5
permits either: it says such a slot can dirty the cone and that no kept output
is rewritten for it (open question 15).

### 2.3 The record of an effectful operation

- **Static:** the built-in, the template of its request (`Operation.input`),
  and the name its state document's identifier derives from.
- **Per operation:** the address of its state document; the request hash and
  the claim stored there; whether a request is outstanding in this process;
  its gates (section 6.4); and a demand count.

### 2.4 The record of a materializer

A materializer keeps the record a node has today: the read set its last run
journaled, the trigger addresses that made it stale, a status, gates, and its
declared write envelope. *Assumed:* the plan records the envelope with the
`Operation` of kind `materializer`, as paths relative to the cells the body
writes through. `plan-and-label-templates.md` has no field for it yet (open
question 17).

### 2.5 Demand sources

A demand source is not a unit. It holds demand and is never run by the
scheduler.

| Source | Where | Holds demand on |
| --- | --- | --- |
| A client session's tracked set | Serving runtime | Every kept output path the session's watches reach under their schemas ([serving loop](../server-side-execution/serving-loop.md), §1) |
| A render sink | Client | Every kept output path the rendered tree reads |
| An effect operation | Both | The kept output that holds its request (section 6.2) |
| A materializer | Both | The addresses of its registered read set, for as long as its instance is loaded (section 7) |
| An event's transaction | Both | What the handler reads, for the length of the transaction (section 5.3) |
| A one-shot pull, such as `cell.pull()` | Both | The paths it reads, until it resolves |
| A warm request | Serving runtime | The documents a provisioning commit staged, for one tenure ([serving loop](../server-side-execution/serving-loop.md), §1) |

### 2.6 Edges and the writer map

An edge is a link between kept outputs: a slot of one unit is bound to an
address that another unit writes. Edges are not stored. They follow from two
structures.

- **The address index** (section 3.1) maps an address to the slots bound to
  it, so it gives the readers of an address.
- **The writer map** maps an address to the unit and output that writes it.
  For a loaded instance its entries are the instance's result cell at each
  path of `Plan.outputs` with `kept: true`, and the target of every
  `WriteEdge` of its cones and bodies: a state cell, a child's argument
  document, a created cell, an anchors document. An effect operation writes
  its state document. A materializer's envelope is in a separate envelope
  index, because an envelope says where a materializer may write and not
  where it does.

Three kinds of writer are not in the map, and each is handled by a rule of
its own: a handler, whose writes arrive as an event's transaction; a handler
bound from a factory value, whose write edges are known only once the binding
is resolved (`plan-and-label-templates.md`, §3.21, and open question 24);
and a writer in an instance that is not loaded, for which section 4.4
applies.

## 3. Dirty slots from the change channel

### 3.1 The address index

The scheduler keeps one index from addresses to what observes them. It is
the trigger index of today (`SchedulerTriggerIndex` in
`scheduler/trigger-index.ts`, a trie of paths per document in
`scheduler/entity-triggers.ts`) with a different kind of entry. An entry is
one of:

| Entry | Registered for | A match does |
| --- | --- | --- |
| Slot | The bound address of a slot of a loaded instance, with the slot's observation class | Marks that slot dirty in that instance's record |
| Chain | Each link address on a slot's binding chain | Rebinds the slot, then marks it dirty |
| Dynamic | Each address a `dynamic` node's last evaluation journaled | Adds the address to that node's trigger reads, which makes the cone stale |
| Materializer read | Each address of a materializer's read set | Marks the materializer invalid and records the address as a trigger read |
| Operation | The state document of an effect operation, and the document that holds its request | Marks the operation's request stale, or delivers its completion |

The index is keyed by space, scope key, and document, as the trigger index is
(`SpaceScopeAndURI`), so an entry for a document of another space is an
ordinary entry (section 9.1).

### 3.2 Entries from the plan and the bindings

Loading an instance builds its slot entries from two inputs and reads no
cell data beyond link structure.

1. **The plan** gives each slot a root, a path, and a class.
2. **The bindings** give each root a document:

   | Slot root | Bound to |
   | --- | --- |
   | `argument` | The instance's argument document |
   | `state` | The state cell's document, whose identifier derives from the instance, the element keys, and the cell's name |
   | `operation` | The operation's state document, named the same way |
   | `child` | The child's result cell, named the same way |
   | `params` | The factory value the closure was called through |
   | `binding`, `event`, `cause` | Bound when an event is dispatched, for the length of its transaction. They have no index entry |
   | `element` | Per position, the address the element was read from, and for a linked element the cell it links to |

Resolving a slot's path from its root can pass through links: an argument
path usually holds a link to a cell of the parent. The resolution follows
them and records each link's address as the slot's chain. A chain address is
observed for `identity`, and its label is part of the slot's label, since
`plan-and-label-templates.md` §2.2 defines a slot's label as what a journaled
read at that address consumes, and such a read consumes the pointer labels
on its way.

A change at a chain address rebinds the slot: the scheduler resolves the path
again, replaces the slot's entries, and marks the slot dirty. That is the
whole of what D3 requires for slots.

**Collections.** A collection's element slots are bound per position
(`plan-and-label-templates.md`, §1.3). The scheduler registers one entry per
position and slot, tagged with the element's key. A change to one element's
cell marks that key's slots dirty and no other key's. A membership change
arrives as a change to the collection's `enumeration` slot and to the
`identity` slots of the positions that changed. The scheduler then rebinds
those positions. An element that moved keeps its key, so its cone is not
stale, which is the property the element-key rule exists for.

**What loading costs.** One index insert per slot, and one per position and
element slot of each collection. Nothing is evaluated.

### 3.3 Matching by observation class

A committed change names a document and carries its value before and after.
The index decides which entries it matches as the trigger index does today
(`collectTriggeredActionsForChange`), with the comparison chosen by the
slot's class:

| Slot class | Dirty when |
| --- | --- |
| `value` | The value at the bound path differs, compared deeply. A change that makes the path reachable or unreachable counts |
| `shape` | The path came to exist, ceased to exist, or changed kind |
| `enumeration` | The set of children at the path, their order, or their count changed |
| `identity` | The reference stored at the path changed. What it refers to is not compared |
| `labelMetadata` | The label stored for the path changed (section 3.6) |

These are the deep and shallow matches of Scheduler v2 §6.1, split by class.
*Assumed:* until storage has an entry class that separates a count from a
key set, `shape` and `enumeration` match alike, as they resolve alike for
labels (`plan-and-label-templates.md`, §2.2).

Marking a slot dirty does nothing else. No cone is evaluated, no reader of
the instance's outputs is marked, and no cell data is read.

### 3.4 Dynamic reads and their trigger reads

A `dynamic` node of a template stands for reads whose addresses are data: a
link that is followed, a read through a cell handle, a space's access list, a
search over candidates (`DynamicReads` in `plan-and-label-templates.md`,
§1.1). For these the scheduler does what it does for every read today.

- **Registration.** When a cone is evaluated, the runtime journals the reads
  its dynamic nodes make. The scheduler diffs them against the addresses
  registered for that node and applies the difference to the index. A node
  whose reads did not change costs nothing.
- **One evaluation late.** A dynamic node cannot read a new address except
  as a consequence of a change to something it already read, so the reads of
  evaluation *k* decide what makes evaluation *k + 1* necessary, as
  [serving loop](../server-side-execution/serving-loop.md) §3b states for
  nodes.
- **Trigger reads.** A change that matches a dynamic entry is recorded with
  the node as a trigger read, keyed by address. When the cone is next
  evaluated, the label of each trigger address joins the node's label,
  whether or not the new evaluation reads that address again. This is what
  §8.9.2 (`08-09-runtime-label-propagation.md`) requires of a rerun that a
  dependency scheduled, as `plan-and-label-templates.md` §3.10 states it,
  and it is what `addCfcTriggerReads` does for a node today. The trigger
  reads are cleared when the transaction that evaluated the cone commits,
  and restored when it is rejected.
- **Why slots need none.** A change to a slot makes a cone stale only if the
  cone's last evaluation read that slot, and then the slot is in the
  templates of the outputs that evaluation produced. A slot that only an
  unselected branch reads causes no evaluation and no rewrite.

A dynamic read is the one place where the label of a kept output depends on
which changes the scheduler delivered. The trigger reads are therefore part
of the instance record and not of the memo.

### 3.5 The open transaction's own writes

A cause is evaluated to completion in one transaction. The writes that
transaction stages have to reach the cones that read them before it commits,
without waiting for a commit notification.

- When cone evaluation stages a write, to a kept output or through a write
  edge, the scheduler matches that write against the index exactly as it
  matches a committed change. Slots of the same instance and of other
  instances become dirty, and trigger reads are recorded.
- A cone made stale this way is evaluated in the same transaction when it is
  demanded (section 10.2).
- When the transaction commits, storage emits a commit notification whose
  source is that transaction. The scheduler skips it: every change in it was
  matched when it was staged. This is P5 with a cause in place of a node.
- When the transaction is rejected, the slots it marked dirty by its own
  writes are restored to their state before it, and the slots the cause
  itself dirtied stay dirty.

Materializers and effect operations have transactions of their own, so their
writes are matched when those transactions seal or commit, and each skips its
own notification.

### 3.6 A write that changes only a label

A commit can change the label stored for a path and leave the value alone,
for example when a later write to a document adds a confidentiality clause
to an entry. The label is stored at a reserved member of the document beside
its value ([CFC stored envelope](../cfc-stored-envelope.md)), and readers
register paths under the value, so today such a commit matches no reader.
The inventory records one consequence: `inspectConfLabel` is the one
structural built-in a re-run does not reproduce, because the label it read
changes without its inputs changing
(`REPLAYABLE_BUILTIN_REFS` in
`runtime/runner/src/builder/builtin-replayability.ts`).

In this design a label-only change does the following.

- A slot of class `labelMetadata` bound to the path becomes **dirty**. Its
  value is the label, so the cone that reads it is stale and is evaluated
  like any other. `principalOf` and `inspectConfLabel` then return current
  results.
- A slot of any other class bound to the path becomes **label-dirty**. No
  value changed, so no cone is stale and no value code runs.
- For a kept output that is demanded and whose template reaches a
  label-dirty slot under its current selections, the transaction of the
  cause instantiates the template again, from the memo's value and the last
  selections. The instantiation key differs, so steps 2 to 4 of
  `plan-and-label-templates.md` §4.1 run: the label is rewritten and the
  constraints are checked again.
- For a kept output nothing demands, nothing happens. The slot stays
  label-dirty, and the next evaluation of the cone instantiates with the
  current label. §8.9.4 permits the delay: "There is **no retroactive
  relabeling obligation**".

This needs one change to `plan-and-label-templates.md`. Its §4.1 begins "If
the output's cone was not evaluated in this transaction, do nothing", which
leaves a demanded output with a stale label until its value next changes.
The step has to read "was not evaluated and has no label-dirty slot". The
change is to when a label is derived again, not to what it is, and it is
listed as open question 8 because it goes to the specification.

### 3.7 A change that reaches nothing loaded

An instance that is not loaded has no entries, so a change to one of its
inputs matches nothing and costs nothing. Its stored kept outputs keep the
values and labels they have. What makes the instance correct when it is next
loaded is the basis index: its rows record the sequence number of each input
at the last evaluation, and loading compares them with the inputs' current
heads (section 10.4).

## 4. Demand

### 4.1 Which outputs are demanded, and why

Demand is held on kept outputs, per path. The sources are the rows of
section 2.5. In short:

- a **rendered result**: on a client the render sinks, on the serving runtime
  the union of what the space's client sessions track;
- an **effect's input**: an effect operation that is itself demanded holds
  demand on the output that computes its request;
- a **materializer's standing demand** on what it read;
- a **handler's reads**, for the length of the event's transaction.

An instance is *demanded* when at least one of its kept outputs is. On the
serving runtime an instance is loaded when it is demanded or one of its
streams has a queued event, and not otherwise, as only the structure
"sufficient to resolve the demanded values and the queued events" is loaded
today ([serving loop](../server-side-execution/serving-loop.md), §1).

### 4.2 Why per path

All kept outputs of an instance are paths of one result document, so a
count per document would make the whole instance demanded whenever any part
of it is read. A session that lists pieces by name reads each result's name
and not its rendered tree. With demand per path, such a session causes the
cone for the name to be evaluated and no cone of the tree.

### 4.3 How demand propagates through links

Demand on a kept output is demand on its cone. From there it follows the
slots the cone's last evaluation read:

1. For each such slot, the writer map gives the unit and output that write
   the slot's bound address, if a loaded unit writes it.
2. That output's demand count is raised by one. If it went from zero to one,
   the step repeats from that output's cone.
3. If the writer is an instance that is not loaded, the scheduler loads it
   (section 4.4).

So demand reaches, for one path of a consumer, exactly the cones of the
producers that path reads, and no other cone of those producers.

*Assumed:* cone evaluation supplies a slot's value when the value code first
reads it and not before. Then a branch that was not selected reads no slot,
and its producers are not demanded, which is what marking both branches of
`ifElse` opaque achieves today. If the runtime resolved every slot of
`Cone.slots` before calling the value function, demand would follow every
slot, and the producers of unselected branches would be evaluated (open
question 12).

**Maintenance.** Counts change only when an edge or a source changes: a
selection changed which slots a cone reads, a slot was rebound, a source
appeared or went away. A change of value alone changes no count. Granting is
incremental. Withdrawing can leave a cycle that holds itself demanded, so a
withdrawal derives the counts again over the region upstream of the output
that lost demand, as Scheduler v2 §5.2 specifies and `dependency-graph.ts`
implements for nodes. The algorithm is unchanged, with kept outputs in place
of nodes.

### 4.4 Loading on demand

When demand reaches an address that no loaded unit writes, the scheduler
looks at the document the address is in. If its metadata names a pattern
instance, that instance is loaded: its compiled pattern is fetched by
identity (section 10.5), its record is built, and its basis rows are compared
with the current heads to mark its dirty slots. The demand then continues
into it. This is the demand pass's structure load of today, without a step
that starts a piece.

### 4.5 A change of demand is a cause

An output that becomes demanded may be stale: its instance was just loaded
with rows behind the heads, or its slots were marked dirty while nothing
demanded it. It has to be evaluated, and no event, storage change, or effect
completion has occurred. A change of demand is therefore a fourth kind of
cause. Its transaction evaluates the stale cones the new demand reaches and
commits the kept outputs that changed. On the serving runtime it runs as the
principal whose session demanded, for the scope instances of that principal
([serving loop](../server-side-execution/serving-loop.md), §3c). The
overview's list of causes has three entries and needs this one (open
question 2).

Demand is already listed as a channel the design accepts
(`plan-and-label-templates.md`, §5.5): whether an output is current depends
on whether something demands it.

### 4.6 What an undemanded instance does when its inputs change

Nothing is evaluated, read, or written. What is recorded depends on whether
the instance is loaded.

| State | On a change to an input | What makes it correct later |
| --- | --- | --- |
| Not loaded | Nothing | Its basis rows stay at the sequence numbers of its last evaluation. Loading finds the heads ahead of them and marks the slots dirty |
| Loaded, output not demanded | The slot is marked dirty or label-dirty in the record, and trigger reads accumulate for dynamic nodes | The cones that read the slot are stale. The transaction of the cause that next demands the output evaluates them. Their basis rows are not advanced meanwhile |

In both states the stored kept output keeps the value and label of its last
evaluation, and a reader that follows a link to it without creating demand
reads that. `plan-and-label-templates.md` (open question 4) leaves undecided
whether such an output should carry a mark saying it may be stale. This
document does not need the mark: every reader the scheduler knows about
creates demand. Section 9.2 names the reader it does not know about.

### 4.7 Releasing demand

A source releases what it holds when it ends: a session closes or its
tracked set is evaluated again, a render sink is removed, an effect operation
loses its own demand, a pull resolves, an event's transaction ends. Counts
are lowered by the withdrawal of section 4.3.

An instance whose last demanded output was released stays loaded until the
runtime releases its record. Releasing a record is always safe, because the
record holds nothing the basis rows and the stored documents do not allow to
be built again. It discards the in-memory dirty marks, which is sound because
the rows were not advanced for them. When to release is a matter of memory
and is decided with the memo's retention (`execution-and-storage.md`).

## 5. The event queue

### 5.1 The queue

Events are serialized. Under server execution an event is a durable entry of
a stream document, committed by the client that fired it or written by a
transaction of the serving runtime
([events](../server-side-execution/events.md), §1 and §2). The serving loop's
drain puts the entries of its space into the scheduler's queue in commit
order per stream and in arrival order across the streams of the space. That
is unchanged, and so is everything about an entry: its identifier, the
server-stamped actor, the renderer-trust attestation, and the per-stream
`eventWatermark`.

A serving runtime serves one space, so its queue is that space's queue. A
client holds several spaces in one runtime and has one queue today. *Assumed:*
the per-space order Scheduler v2 §7.5 proposes is adopted, so that an event
waiting on a load in one space does not hold events of another. Nothing here
relies on an order across spaces, which
[events](../server-side-execution/events.md) §2 does not promise either
(open question 10).

### 5.2 One transaction per event

An event is a cause, and it has one transaction. The transaction has the
three parts `plan-and-label-templates.md` §5.4 defines: the cones that
compute what the handler reads, the body, and the cones the body's writes
made stale that something demands. What is evaluated in each part for one
instance is `execution-and-storage.md`'s. This section states what the
scheduler does around them and across instances.

Before the transaction opens:

1. **Loading.** The documents the handler's bound slots name are brought
   into the replica. The event holds its place in the queue while that I/O
   runs, and the load's completion queues the next step. Nothing polls.
2. **Resolving the handler.** The binding the stream belongs to gives the
   handler: a body of the instance's plan, or a compiled handler named by a
   factory value, whose record is fetched by content address
   (`plan-and-label-templates.md`, §3.21).
3. **Materializers.** If the bound address of one of the handler's `reads`
   slots, or the cell behind one of its handles, lies inside the envelope of
   an invalid materializer, that materializer runs first, in its own
   transaction (section 7.2).
4. **Lineage.** An event whose origin transaction committed in another space
   waits until that commit is confirmed, as today (Scheduler v2 §7.6).

Then the transaction opens, the `event`, `binding`, and `cause` slots are
bound, and the three parts run.

### 5.3 What the static read closure allows

Today the scheduler computes a handler's read closure by a deep read under
the handler's schema in a separate read-only transaction, finds the invalid
nodes upstream of it by walking down from the set of invalid nodes
(`collectInvalidUpstreamForLog` in
`scheduler/event-preflight-dependencies.ts`), runs them in their own
transactions, and parks the event while any of them is held by a time gate.

In this design the handler's `Body.reads` are slots of the plan, and the
cones behind them are known without reading anything. Three things follow.

- **No preflight transaction.** The stale cones the handler reads are
  evaluated inside the event's transaction, by the pull that a read of a
  demanded output is. The handler's reads hold demand for the length of the
  transaction (section 2.5), so cones nothing else demands are evaluated for
  the handler and not stored unless they are kept and changed.
- **No parking on time gates.** A cone has no gate. A cone on a cycle that
  does not converge takes an error state (section 8.1), and a handler that
  reads it fails, as `plan-and-label-templates.md` §5.4 says. The remaining
  reasons an event waits are a load in flight, a materializer that has to
  run first, and an unconfirmed origin in another space. Each ends on a
  notification.
- **Reads through handles.** A handler also reads through cell handles at
  paths it computes, and follows links it finds in data. Those addresses are
  not slots. *Assumed:* the runtime, which brackets and journals such reads
  already, evaluates a stale cone that writes the address before it returns
  the value, inside the same transaction. That is a pull like any other,
  made at the read instead of ahead of the body (open question 11). If such
  a read is inside the envelope of an invalid materializer, the
  transaction is withdrawn whole, the materializer runs, and the event is
  dispatched again under the same identifier. Nothing of the withdrawn
  attempt is committed, and what the handler creates is named by the event
  and the order of creation, so the second attempt names the same things.

### 5.4 Ordering guarantees

- Events of one stream run in the order of their entries.
- Events of different streams of one space run in arrival order.
- No order is promised across spaces.
- A handler never reads a value that an earlier event of its space was
  going to change: the earlier event's transaction has sealed before the
  later one opens, and the later one's reads are made current inside it.
- A storage change with a lower sequence number than an event is reflected
  in what the handler reads, because the cones it made stale are evaluated
  in the event's transaction before the body reads them.

**The cost of the third part.** Today the serving scheduler runs the
handlers of several ready events back to back and settles the derivations
once behind all of them (`Scheduler#processExecuteEventPhases` in
`scheduler/facade.ts`). With the third part inside each event's transaction,
every event evaluates the demanded cones its writes made stale, so a body
that reads a whole collection is evaluated once per event of a burst and not
once per burst. Per-element cones are not affected: each event evaluates the
elements it changed. This follows from the ruling that a constraint on any
output of a cause rejects the cause, which requires those outputs to be
evaluated in its transaction (open question 3).

### 5.5 Rejection, failure, and conflict

| Outcome | What happens to the event | Retried |
| --- | --- | --- |
| A constraint fails when the transaction's templates are instantiated | The whole transaction is rejected: the handler's writes, its requests, and every derived output. The refusal is the event's consequence: the entry records the error, the stream's `eventWatermark` passes it, and the outcome is reported to whoever delivered the event, with the handler's template as its label ([events](../server-side-execution/events.md), §5) | No. The verdict is a function of labels and selections |
| The handler body throws | The same: nothing the body staged exists, and the error is the consequence | No |
| A cone fails in the first or third part | The cone's outputs take an error state and the rest commits. If the handler read the failed cone, the handler fails | No |
| A recorded read of the handler is stale when the wave commits | The event is requeued whole and runs again once the replica holds the commit that made the read stale. Later entries of the same stream that sealed into the wave requeue behind it ([serving loop](../server-side-execution/serving-loop.md), §3d, where the rule is proposed and awaits a ruling) | Yes, on the arrival of that commit |
| The handler body did not run, because an input did not resolve | The transaction is withdrawn whole and the entry stays pending | Yes, when the input's document arrives |
| The handling's receipt exists already | The event was handled. The attempt is dropped | No |
| A deterministic refusal by the memory server: a refused access-list change, a refused write to another space | The refusal is the consequence | No |

Two points go beyond today's rules.

- **The handler's stale reads include what the first part read.** A handler
  that reads a derived value computed in its own transaction depends on that
  cone's slots. They are held to the store's heads with the handler's own
  reads, so a commit that changed one of them requeues the event.
- **Derived outputs withdraw alone.** A kept output the third part computed
  is a pure derivation. When the document it is written to moved under the
  wave, that write is dropped and its cone stays stale, as a derivation's
  write is dropped today, and the handler's writes commit. *Assumed:* this
  per-write rule of the serving loop applies inside one cause's transaction
  (open question 4). The constraint checks are not affected: they ran when
  the transaction sealed, before any conflict was known.

The receipt is unchanged: the handling's result cell, created under a
create-only precondition, with an identifier derived from the event
(`handlingReceiptId`).

### 5.6 A constraint that fails in another instance

The transaction of an event covers every instance of the space that the
handler's writes reach and something demands. A constraint of any of them
rejects the event. The same holds for a storage change: its transaction
covers every demanded instance the change reaches, for every demanding
principal, and one failing constraint rejects all of it.

For a storage change, a rejected transaction leaves the cones it evaluated
stale. The scheduler records the refusal with each instance: the constraint,
the slots it lists, and their label identifiers. It does not attempt the
same instantiation again until one of those slots changes value or label,
since the verdict would be the same. The refusal reaches the scheduler's
error channel with its structured details, as a terminal refusal does today.

This document applies the ruling as written. Its consequence across
instances is stated under open question 1.

## 6. Effects

### 6.1 An effect operation is a unit

The effectful built-ins are the class B entries of the inventory: the fetch
family, `fetchProgram`, `generateText`, `generateObject`, `llmDialog`,
`agent`, `sqliteQuery`, `navigateTo`, the compiling half of `compileAndRun`,
the resolving half of `cellFromUrl`, the staged access changes, and
`nameBlob`. Each request is an effect operation, and it comes to exist in one
of two ways:

- **In the reactive tier**, as an `Operation` of kind `effect` of a plan. Its
  state document is named from the instance, the element keys, and the
  operation's name.
- **In a handler**, as an occurrence of a `BodyCall` of kind `effect`. It is
  identified by the event and its ordinal among the handler's requests, and
  it exists once the event's transaction commits.

The inventory's sentence governs both: requesting an effect "behaves like
instantiating a built-in pattern". An effect operation therefore has a
request, which is to it what an argument is to a child, a result, and
transactions of its own. It is never evaluated inside the transaction of
another cause.

The staged access changes are the exception in form. A handler requests
them and reads no result, and they have no completion: each is a step of
the commit of the event's transaction (section 9.4).

### 6.2 The request

**In the reactive tier** the request is computed by a cone of the enclosing
instance, like any output. *Assumed:* that output is kept. It is written
into the operation's state as the request, with the label `Operation.input`
instantiates to, the way a computed argument of a child is written into the
child's argument document (`plan-and-label-templates.md`, §3.15). The
operation then observes a stored, labeled input, and a change to it reaches
the operation through the index (open question 13).

An operation is demanded when something demands a path of its result. It
then holds demand on the output that computes its request. One built-in is
requested in order to act and has no result a pattern reads:
`navigateTo`. *Assumed:* such an operation is demanded whenever its instance
is. The inventory is asked to state this per built-in (open question 20).

When the request of a demanded operation changes, the scheduler runs the
operation's **request transaction**:

1. Read the request and its label.
2. Compute the request hash: the built-in's identifier and the canonical
   form of the request
   ([serving loop](../server-side-execution/serving-loop.md), §4).
3. If the stored hash is equal and a settled result or error is present, do
   nothing. The stored result is the operation's value.
4. If the stored hash is equal and a request is outstanding, do nothing. The
   completion will arrive.
5. Otherwise check the gates of section 6.3, write the hash with a pending
   mark into the state document, and hand the request to the outbox. The
   outbox dispatches it after the transaction's commit is accepted.

**In a handler** the request is staged in the event's transaction. Its
arguments carry the handler's template, the egress ceiling is a constraint
of that transaction, and a failure rejects the event
(`plan-and-label-templates.md`, §3.14 and §4.4). The pending mark and the
hash are writes of that transaction, and the outbox receives the request
when it commits.

### 6.3 Which gate is evaluated when

| Gate | At the request | At the completion |
| --- | --- | --- |
| Egress ceiling: the confidentiality of the request fits the ceiling configured for the sink (`verifySinkRequestCeilings` in `cfc/prepare.ts`, which today measures the whole staging transaction) | Yes, on the request's own label | No. The request has left |
| Release check: the request about to leave equals the snapshot that was checked (`verifySinkRequestRelease` in `cfc/sink-request.ts`) | After the staging commit, before dispatch | |
| The built-in's own request rules: the `agent` request's declared maximum confidentiality, the refusal of a labeled `sqliteQuery` request to a database of another space, `navigateTo` only among the consequences of an event fired by a connected session | Yes | |
| Outbox budgets: outstanding requests and egress rate per space ([serving loop](../server-side-execution/serving-loop.md), §5) | They hold the dispatch | |
| Selection: the completion's hash is still the request the operation selects | | Yes. A completion for a superseded request writes nothing |
| The result's label: the built-in's declared rule over the request's label, with the constants the result schema declares and the integrity the boundary declares, such as `LlmDerived` | | Yes, from the request as it stands at write-back |
| Validation of the result: a response schema, declared ceilings on rows | | Yes. A failure is an error result |
| Gates on a tool call of a language-model turn | | During the effect, before each call |
| Constraints of the cones that read the result | | In the transaction of the cause the completion is, not in the completion |

For a request made in the reactive tier, a failed egress ceiling rejects the
operation's request transaction and no other. The request is not made, and
the operation's result takes the refusal as its error in a following
transaction, with the request's label, as a built-in's rejected staging
settles today ([built-in contracts](../server-side-execution/builtins.md),
§2). `plan-and-label-templates.md` §4.4 says a failed constraint rejects the
cause's transaction and does not say which transaction that is for an
operation of the reactive tier (open question 19).

### 6.4 Time gates and retries, as they exist

The design adds no timer and no retry. The ones that exist are these, and
each stays as it is until the inventory says otherwise (open question 20).

| What | Where | Behavior |
| --- | --- | --- |
| Completion write-back | `Runtime.editWithRetry` (`runtime/runner/src/runtime.ts`) | Up to `DEFAULT_MAX_RETRIES` (5) attempts when the commit is rejected for a stale basis. Between attempts it waits in `awaitCommitRetryReadiness` for the conflicting documents to arrive. No timed backoff |
| A claim that went silent | `tryClaimMutex` (`builtins/fetch-utils.ts`), `MUTEX_STALE_AFTER`; `REQUEST_TIMEOUT` in `builtins/llm-dialog.ts` | A pending request may be claimed again once its `lastActivity` is older than 5 seconds for the fetch family, or 5 minutes for a dialog turn. The claim exists so that several committing runtimes do not send one request twice |
| A failed request | `builtins/fetch.ts` | Not retried. The error is written with the request hash, so the next request is one whose inputs changed |
| Dispatch held by a budget | `SpaceOutbox` (`executor/outbox.ts`) | A request over the cap on outstanding requests, or over the egress rate, waits in the outbox. A park drops held requests, and the next activation finds them missing and requests them again |
| An event appended to a stream of another space | The durable outbox rows of [serving loop](../server-side-execution/serving-loop.md) §5 | Delivered at least once. A transient failure keeps the row for the next attempt, and a deterministic refusal writes a failure notice in the source space |
| Across a crash | [Serving loop](../server-side-execution/serving-loop.md), §6 | A request whose result was never committed is made again. External effects are at least once |

Where a gate is a point in time, it is one input of the scheduler's
`eligibleAt` for that operation, and the one wake timer covers it. With one
serving runtime per space, a request has one claimant, so the silent-claim
gate decides nothing while the process lives. It is listed because the code
has it.

### 6.5 The completion is a new cause

The network call runs in the outbox and never in the loop. When it returns:

1. The operation's **completion transaction** writes the result or the
   error, the request hash, and clears the pending mark, with the label of
   section 6.3. It commits by itself and does not seal into a wave
   ([serving loop](../server-side-execution/serving-loop.md), §4).
2. The commit is matched against the index in the process that made it. The
   slots with root `operation` that are bound to the result become dirty.
3. That is a cause of the third kind. Its transaction evaluates the demanded
   cones that read the result, in every instance that does.

The completion transaction is the boundary's, and the cause's transaction is
the instances'. They are two transactions because the first exists whether or
not anything reads the result.

### 6.6 One request across re-evaluations

A request is made at most once per distinct request hash and state document,
whatever is evaluated again.

- A cone that computes a request is evaluated again whenever a slot it reads
  is dirty. If the request's value is unchanged, nothing is written and the
  operation is not told. If it changed back and forth, the hash decides.
- An operation's state document is named by its cause, so every evaluation
  names the same document.
- A handler's requests are named by the event and their order. An event that
  is requeued and runs again names the same operations, finds the hashes it
  wrote if its first attempt committed them, and otherwise had committed
  nothing.
- After a restart, the hash is computed again from the stored request and
  compared with the stored hash. A settled result is reused.

### 6.7 On a client

A client has no effect operations. Its speculative transaction computes the
request like any kept output and writes it to the overlay. If the request's
hash differs from the stored one, the operation's result reads as pending,
and otherwise as the last committed result
([speculation](../server-side-execution/speculation.md), §2). Navigation is
the one effect a client enacts from a speculative run, reconciled by the
intent's nonce, as today.

## 7. Materializers

### 7.1 What a materializer is here

A materializer is a body whose write targets are dynamic or too broad to
list as write edges. Which bodies those are is decided by
`footprint-analysis.md`. This document assumes the result: an `Operation` of
kind `materializer`, with the body that implements it and a declared write
envelope.

A materializer is not part of the compiled evaluation of its instance. It
keeps a transaction per run and today's label rule: every path it writes
gets the join over everything the run read, trigger reads included
(`plan-and-label-templates.md`, §3.11).

### 7.2 The rules it keeps

- **Discovered reads.** Its read set is the journal of its last run, and the
  delta is applied to the index after each run. This is Scheduler v2's P6,
  which remains for materializers alone.
- **Standing demand.** A materializer of a loaded instance is always
  demanded. Its readers cannot be known, so a change to what it read has to
  lead to a run.
- **Idle priority.** It runs after the events and the storage changes of a
  cycle have been processed and their transactions sealed, and its
  invalidations up to that point become one run.
- **Promotion.** If a cone about to be evaluated has a slot bound inside the
  envelope of an invalid materializer, that materializer runs first. The
  check is a lookup of the cone's bound addresses in the envelope index and
  needs no evaluation. Section 5.2 states the same rule for a handler.
- **Envelopes order and never dirty.** A reader becomes dirty only by a
  write the materializer committed.
- **Its writes are a cause.** They are matched against the index when its
  transaction seals, and the cones they make stale are evaluated in the
  transaction of that cause.

### 7.3 What changes around it

- A cone whose `dynamic` read is inside an invalid materializer's
  envelope is not promoted for, because the address was not known before the
  evaluation. The cone is evaluated with the value it found, the
  materializer runs at idle priority, and its write makes the cone stale
  again. That is the one-evaluation-late rule of section 3.4, and it is how
  a computation behaves today.
- A handler in the same position cannot be evaluated late. Section 5.3 says
  what happens: the attempt is withdrawn and the event is dispatched again
  after the materializer has run.
- Fewer bodies are materializers. `collectionIndexMember`, one of the two
  built-ins that declare envelopes today, has no counterpart, because the
  per-element selector cones write a statically known target
  (`builtin-inventory.md`). A more precise write-path analysis moves
  authored bodies out of this section in the same way.

### 7.4 A limit that carries over

Standing demand holds while the materializer's instance is loaded. An
instance that is not loaded runs nothing, so a reader of an address inside
the envelope of one of its materializers reads what was last written there.
The same holds today for a piece that is not running. The instance is loaded
when one of its kept outputs is demanded or one of its streams receives an
event, and not when an address inside an envelope is read, because nothing
stored says which instance's envelope an address is in.

## 8. Convergence bounds

### 8.1 Inside one transaction: an evaluation budget per cone

A cone is evaluated at most once for one state of its slots. It can be
evaluated more than once in one transaction for three reasons: an event's
transaction evaluates it before the body and again after the body wrote; a
side-write of one cone changes a slot another cone already read; and two
instances of one space read each other's outputs through links.

The bound is one rule:

> In one transaction, one cone is evaluated at most 10 times for one element
> key and one scope instance. An evaluation that would be the eleventh does
> not run, and the cone fails.

- **Why a count per cone.** A cycle within one plan is visible in
  `Plan.edges`, and a count per cycle would do for it. A cycle through links
  between instances exists only in data, and a count per cone covers both
  with one rule.
- **Why 10.** It is the bound of today: `MAX_ITERS` and `PASS_RUN_BUDGET`
  are both 10 (`scheduler/constants.ts`). A cycle through a side-write that
  settles within one pass today settles within one transaction here. A
  chain of cones that is not a cycle evaluates each cone once, however long
  it is, so the bound does not limit depth, which is the mistake Scheduler
  v2 §7.7 records for a budget of 5.
- **Why a constant.** The server and a client have to arrive at the same
  error states from the same plan. The bound is therefore part of what a
  plan means and not a setting of a deployment. *Proposed:* it is fixed with
  `Plan.version`, and changing it is a new version.
- **Convergence is by value.** A cone that is evaluated again and stages the
  values already staged makes nothing stale. The idempotency contract is
  what makes a cycle through a side-write end, and the validator of
  Scheduler v2 §4.2 stays the test of it.

### 8.2 What is reported when the bound is reached

- **The error state.** The cone fails as
  `plan-and-label-templates.md` §5.2 defines: its outputs take an error
  state whose label is the output's template instantiated with the last
  selections, and the rest of the transaction commits. Cones that read it
  fail in turn.
- **Its side-writes.** *Assumed:* the writes the failed cone staged through
  its write edges in this transaction are withdrawn, and their targets keep
  the values they had before the transaction. A state cell that a handler
  also writes must not come to hold an error state because a computation
  that normalizes it did not settle. `plan-and-label-templates.md` §5.2
  speaks of a failed cone's outputs and not of its write-edge targets (open
  question 18).
- **The diagnostic.** For each evaluation after the first, the scheduler
  records which slot made the cone stale and which cone or body staged the
  write that dirtied it. When the bound is reached, the record names the
  cycle: the cones by their `Cone.entry`, the instances, and the state cell or
  output path of each write. It goes to the scheduler's error channel and to
  telemetry under the marker `scheduler.non-settling`, which today carries
  only the first ten deferred actions. The record is computed from the
  cones' inputs, so it has the label of the error state and is shown only
  where that label permits.
- **At compile time.** `PlanIndex.cyclicCones` is known from the plan. The
  compiler reports a cycle of `Plan.edges` as a warning that names the side
  write, and does not refuse it: a write that normalizes the value it reads
  is a cycle that settles in two evaluations. `language-subset.md` is asked
  for the diagnostic (open question 21).

**What the compiler cannot see.** Three kinds of cycle are found only by the
budget: a cycle through links between instances; a cycle through a cell
handed to a handler that was received as a factory value, since any such
cell counts as written by code the compiler did not see
(`plan-and-label-templates.md`, §3.21); and a cycle through a materializer,
which section 8.3 bounds.

### 8.3 Across transactions: a budget per unit and cycle

A cycle can also pass through a unit that has transactions of its own. A
materializer writes what a cone reads, and the cone side-writes what the
materializer reads. An effect's result feeds its own request. Each round is
then several causes, and no single transaction sees the cycle.

For these the rule of Scheduler v2 §7.7 is kept with units in place of
nodes:

- In one serving cycle, a materializer runs at most 10 times and an effect
  operation's request transaction runs at most 10 times.
- A unit that reaches the budget stays invalid and takes the escalating
  backoff gate of today: 250 ms, doubling per consecutive exhaustion, to at
  most 2 s (`BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `nextBackoffDelayMs` in
  `scheduler/execution.ts`). One wake is scheduled for the earliest gate.
- The cycle closes its wave with what has sealed, which is the first trigger
  of the serving loop's budget exhaustion
  ([serving loop](../server-side-execution/serving-loop.md), §3). The rest
  continues in later cycles as dirty slots.
- No unit is forced to run or forced clean, and reaching this budget is not
  an error state. A graph that settles in more rounds than one cycle allows
  settles over several cycles.

### 8.4 Two cycles the budgets do not close

- **An effect that feeds itself.** Each round is a request that leaves the
  process, and the budget of section 8.3 limits the rounds per cycle, not in
  total. What limits the rate is the outbox's budget per space. Whether an
  operation whose request changes as a consequence of its own completion
  should stop after a number of rounds is open question 9.
- **A cycle across spaces.** Each space has its own serving loop and its own
  cycles, so a round is one commit in each space and no budget of either
  loop counts it. The remote-echo gate (`RemoteEchoBreaker` in
  `scheduler/echo-breaker.ts`) is kept, keyed by instance and cone, for the
  case it covers today: a cone that keeps rewriting a document it also
  reads, made stale each time by another writer's commit to that document.
  It does not cover two instances in two spaces that derive from each
  other, and telling that cycle from a stream of ordinary changes would need
  the chain of causes to be carried on commits between spaces, which it does
  not (open question 9).

## 9. Links across spaces

A transaction covers one space. Four things cross: a read, demand, an event,
and a write that provisions or changes access.

### 9.1 A read, and the change that follows it

A slot bound through a link to a document of another space is an ordinary
slot whose bound address names that space.

- **On the serving runtime** the read goes over a session of the home
  space's runtime on the other space, which reaches that space's owner over
  the deployment's route and reads with the authority
  [serving loop](../server-side-execution/serving-loop.md) §3b describes.
  The label of the slot is resolved from the foreign document's envelope,
  as for any slot.
- **A change in the other space** arrives on that session as a frame, and
  storage notifies the scheduler. The index is keyed by space, so the change
  matches the slot's entry and marks it dirty. That is a cause for the home
  space, and its transaction is the home space's.
- **It is not home input.** The home space's watermark and input batch count
  the home space's commits only. A basis row for a foreign document records
  that space's sequence number and is compared with that space's head at
  activation.

No transaction of the home space evaluates anything in the other space, and
no derived commit of one space's loop is written into another
([protocol](../server-side-execution/protocol.md), §2b).

### 9.2 A pull that reaches another space

Within one space a pull extends through a link into the producing
instance's cone and evaluates it in the same transaction. Across spaces it
cannot: the producer belongs to another space's loop, which is the only
deriver of that space. The consumer reads the producer's kept output as
stored. The question is whether that output is current.

Today a serving loop does not activate a space it reaches through the route
([serving loop](../server-side-execution/serving-loop.md), §2), and a space's
demand is the union of what its client sessions track. So a kept output of
another space is current only if a client there demands it.

| Option | What it does | Cost |
| --- | --- | --- |
| A. Read as stored | The consumer reads the stored value and label and is evaluated again when the producer's space commits a new one. Nothing tells the producer's space that a reader exists | None. A value nobody demands in its own space is read stale, without a mark |
| B. The reader's session counts as demand | The session the home runtime holds on the other space contributes its tracked set to that space's demand, like a client session, and its opening is a reason to activate the space. The producer's loop evaluates the output in a transaction of its own, a cause of the fourth kind, and its commit dirties the consumer's slot | One space's activity activates the spaces it reads. A space read by many is active most of the time. Budgets per space bound each one |
| C. A mark on the stored output | An output whose cone is stale carries a mark, written when it first becomes stale, and a reader that finds the mark treats the value as pending | A write to every output that goes stale undemanded, in a space where nothing is running to write it |

**Recommended: B.** It is the only option under which a pull means across
spaces what it means within one, and it uses what exists: a session, a
tracked set, and the identity-less demand a warm request already adds to a
tenure. The consumer is still one evaluation late: it reads the stored value
in its own transaction and is evaluated again when the producer's commit
arrives. A handler that reads a derived value of another space can therefore
act on a value that is about to change, as it can today. Option C does not
work without B, since an inactive space writes no marks. This changes when a
space is active, which is the serving loop's rule to change (open question
5).

### 9.3 Writes that leave a space

| Crossing | Carried by | When |
| --- | --- | --- |
| An event sent to a stream of another space | A durable outbox row written in the wave's own store transaction, delivered as an authored append under the acting identity | After the home commit, at least once, deduplicated by event identifier at the target |
| An `inSpace` instantiation: the child's argument and result cell, and for a new space its creation | An authored batch per target space, under the acting principal of the event | At the wave's commit step, before the home batch |
| A staged change to a space's access list | An authored commit of the list alone, decided by the memory server that holds the list | At the wave's commit step, before every other batch |
| A bookkeeping write a run triggers after it ended, such as a compile-cache write-back | The same foreign batch, under the triggering run's carriage | With the provisioning batches |

All four exist today ([protocol](../server-side-execution/protocol.md), §2b;
[serving loop](../server-side-execution/serving-loop.md), §3d and §5). The
child of an `inSpace` instantiation is evaluated by its own space's loop,
when something there demands it, and never in the transaction that requested
it (`plan-and-label-templates.md`, §3.15).

### 9.4 One commit sequence for a cause that crosses

`builtin-inventory.md` (open question 3) and the overview ask whether a
staged access change and an `inSpace` instantiation can share one commit
across spaces. The inventory describes the client's arrangement, in which
the access change commits by itself before the handler's transaction
(`commitSpaceAccessChanges` in
`runtime/runner/src/builder/space-access-change.ts`) and the instantiation
commits the child's space first and the parent's after
(`V2StorageTransaction.#commitMultiSpace` in `storage/v2-transaction.ts`).
On a serving runtime both are already steps of one sequence at the wave's
commit step (`stageSpaceAccessChanges` in `executor/wave.ts`).

| Option | What it is | Assessment |
| --- | --- | --- |
| 1. Two mechanisms | Keep the client's separate commit for access changes beside the split commit for `inSpace` | It describes a runtime that commits handler writes itself. Under the ruling that execution is authoritative on the server, no such runtime runs a compiled pattern outside tests |
| 2. One ordered sequence, foreign steps first | The transaction of a cause carries an ordered list of foreign steps beside its home writes. A step is an access-list change or a batch of writes to one other space. At commit the steps are applied in order, access changes first, then the home writes. The first failure stops the sequence and the home writes do not commit | It is what the serving loop does. It is not atomic: a step that was committed stays committed |
| 3. An atomic commit across spaces | A prepare phase in every space, then a commit | It closes the gap of I11. It is a protocol of its own, which Scheduler v2 lists as open question 3 and defers |

**Recommended: option 2, as the one definition for both** (open question
6). It is a commit in two steps, foreign then home, and not a commit in two
phases. Four
properties make it sufficient:

- **Every constraint is checked before the first step.** Templates are
  instantiated and constraints checked when the transaction seals, in
  memory, and that includes the write-side checks of the target space on a
  child's argument (`plan-and-label-templates.md`, §3.14). A rejected cause
  therefore leaves nothing in any space.
- **Access changes go first**, in the order the handler staged them, because
  a grant can be what admits the steps after it.
- **A repeated attempt converges.** If the home step fails after a foreign
  step was committed, on a conflict or a crash, the event is not
  consequenced and runs again. The identifiers of an `inSpace` instance and
  of a space it creates are known before the commit (a ruling), so the
  second attempt writes the same documents and its foreign step changes
  nothing. An access change that was committed is found unchanged.
- **What can remain.** A foreign step can remain without its home step when
  the home step never succeeds: a created space nothing links to, or a grant
  without the write that explained it. That is the state a crash between the
  two leaves today, and Scheduler v2 records it as the gap of I11.

A client's speculative transaction stages foreign steps and applies none.
A handler that names an `inSpace` target whose allocation record does not
exist yet does not speculate at all
([speculation](../server-side-execution/speculation.md), §2).

## 10. Joining the serving loop

### 10.1 What stays the loop's

The serving loop hosts a scheduler and does not contain one
([serving loop](../server-side-execution/serving-loop.md), Anchors). That
stays true: the remaining scheduler of this document is what it hosts. The
lease, activation and parking, the two planes, the wave and its commit, the
outbox, the watermark, recovery, and the counters are unchanged. The
sections below say where each responsibility of this document sits in the
loop of that document's §3.

### 10.2 The cycle, in causes

```text
on activate(space):
  acquire the lease, build the runtime
  load the instances the demanded outputs and the queued events need
  read the watermark
  mark dirty slots from the basis index           (section 10.4)
  subscribe from the head the index scan ran against

on commits [s..n] arriving:
  for each commit c, in sequence order:
    skip the loop's own derived commits
    match c's changes against the address index   (section 3)
    if c appends an event: queue it               (section 5.1)

  for each queued event, in order:                -- one cause each
    run the event's transaction                   (section 5.2)
    seal it into the wave

  if a demanded output is stale:                  -- one cause for the batch
    run one transaction that evaluates the stale demanded cones
    seal it into the wave

  for each change of demand since the last cycle: -- one cause each
    run one transaction for the stale cones it reaches (section 4.5)
    seal it into the wave

  until nothing is invalid, or a unit's budget is reached (section 8.3):
    run each invalid materializer and each stale effect request
      in a transaction of its own, sealed into the wave
    run one transaction for the cones their writes made stale

  commit the wave: one derived commit with the watermark
  hand the effect requests of the wave to the outbox
```

| Responsibility | Where in the loop |
| --- | --- |
| Changes into dirty slots | The first step on arriving commits, which is "mark dirty" today. A completion commit and the open transaction's own writes are matched in process (sections 3.5, 6.5). A foreign commit is matched when its frame arrives (section 9.1) |
| Demand | The demand registry the loop keeps per client session is the source. A change to it is a cause (section 4.5), processed in the next cycle |
| The event queue | The scheduler's queue of the space's runtime, filled by the loop's drain from the durable stream entries |
| Effects | Request transactions run inside the cycle. The network call runs in the outbox after the wave's commit. The completion commits by itself and is input to the next cycle |
| Materializers | Inside the cycle, after the events and the batch |
| Convergence | The evaluation budget inside each transaction. The budget per unit ends the cycle, which is the loop's budget exhaustion |
| Links across spaces | Reads on the runtime's sessions. Writes at the wave's commit step, in the order of section 9.4 |

**The changes of one batch are one cause.** The overview names "a change
arriving from storage" as a cause. The loop drains commits in batches, and a
transaction per commit would evaluate one cone once per commit of a burst.
This document takes the storage changes one cycle drains together as one
cause with one transaction, evaluated after the cycle's events (open
question 3).

**Order across instances.** A transaction evaluates the demanded stale
outputs in a fixed order, by instance identifier and output index. A cone
that reads a slot whose bound address a stale cone writes causes that cone
to be evaluated first, in the same transaction, whichever instance it
belongs to. A cone that is read while it is being evaluated returns the
value it last staged or the committed one, and is evaluated again when its
own write is staged, within the budget of section 8.1.

**A transaction seals, and the wave commits.** Sealing is what committing is
on a runtime with no wave: the reads feed the basis rows, the templates are
instantiated and the constraints checked, and the writes join the wave
([serving loop](../server-side-execution/serving-loop.md), §3d). A later
transaction of the same cycle reads the earlier ones' sealed writes. "One
transaction per cause" is therefore a statement about evaluation, labels,
and constraints. The durable commit is the wave's.

### 10.3 The enforcement boundary

[Serving loop](../server-side-execution/serving-loop.md) §3c fixes the
enforcement boundary at the action run, so that a wave's union of reads
never taints an unrelated write. With templates the label of a write does
not come from a read set at all. What §3c forbids stays forbidden, in this
form:

- A label is instantiated per kept output and per write edge, when the
  transaction that evaluated its cone seals. Nothing is derived from the
  reads of a wave or of a whole transaction, except by a materializer, whose
  transaction is one run.
- No check is deferred to the wave's commit or to admission.
- One transaction can evaluate cones for several scope instances, for
  example a storage change read by the instances of fifty users. Each
  evaluation carries the context a run carries today: the acting principal,
  the scope key of what it writes, and the read ceiling of the session it
  acts as (`WaveRunContext` in `executor/wave.ts`). The context belongs to
  the evaluation of one cone for one scope instance and not to the
  transaction.

The text of §3c is a host arrangement and changes with this design. The
label semantics it arranges are the specification change's.

### 10.4 The basis index

The basis index is the one persisted form of scheduler state besides the
watermark and the stream watermarks. Its rows say that an output is current
if and only if its inputs are unchanged since the recorded sequence numbers
([serving loop](../server-side-execution/serving-loop.md), §3b). Its shape
stays: identifiers and sequence numbers, by document, overwritten in place,
written inside the wave's store transaction, never pushed and never read at
admission.

What changes is what a row is keyed by. Today the key is a durable action
identity and the scope instance that ran. Here it is:

| Column | Holds |
| --- | --- |
| The instance | The result cell's identifier and the identity of the compiled pattern |
| The cone | Its index in the plan |
| The scope instance | As today |
| The input document | Space, identifier, scope instance |
| The sequence number | The input's at the evaluation |

- A cone that is evaluated replaces its rows as a set. For a cone with
  element keys, the row of one element's document is replaced when that
  element's key is evaluated. The row of a document every key reads advances
  only when every bound key has been evaluated against it.
- A cone that is stale and not demanded is not evaluated, and its rows stay
  behind the heads. That is the whole durable record of section 4.6.
- A pattern update gives the instance a new compiled identity, so the old
  rows match nothing and every cone starts stale. The transaction that
  swaps the pattern deletes them.
- Dynamic reads contribute the documents they journaled, as logged reads do
  today.

The number of rows is the number of cones times the documents each reads. A
collection costs one row per element document for each cone applied to it,
where today each element is a sub-pattern with several nodes and a set of
rows for each. Whether the cone is the right granularity, or the instance
with a separate record of stale cones, is for the prototype to measure
(open question 22).

### 10.5 Plans and compiled artifacts

**Identity.** A compiled pattern is addressed by the hash of its
`CompiledPattern` record, which names the plan, the value code, and the
compiler build (`plan-and-label-templates.md`, §1.2). An instance's result
cell names the compiled pattern it runs.

**What is compiled when.** Only the server compiles.

| When | What |
| --- | --- |
| An instance is loaded and its source has no compiled pattern under a compiler build the deployment accepts | The serving runtime compiles the source. This covers a first instantiation, a source update, and a deployment that accepts a new compiler build |
| A `compileAndRun` request | The compiling half of that built-in: an effect operation whose result is the identity of a compiled pattern or a list of errors (`builtin-inventory.md`) |

Compiling never runs on the loop's thread and the loop never waits for it.
It runs in the compile worker a serving worker starts
(`ModuleCompileWorker`), and an instance whose compiled pattern is not ready
stays unloaded with its demand pending, as a piece whose source is being
followed does today
([serving loop](../server-side-execution/serving-loop.md), §3e).

**The cache.** Today compiled modules are documents of the space that uses
them, in two content-addressed sets: sources keyed by a hash over a module
and its imports, and compiled output keyed by that hash and a runtime
version ([module loading](../module-loading.md), "Storage model";
`sourceDocKey` and `compiledDocKey` in
`runtime/runner/src/compilation-cache/cell-cache.ts`). *Proposed:* the same
two levels.

- An index entry from the source identity and the compiler build to the
  compiled pattern's hash. The compiler build takes the place of the runtime
  version.
- The plan and the value code as immutable documents under their own
  hashes, so that two sources that compile to the same plan share it.

They are stored in the space of the instance, written by the serving
runtime alone, with the integrity atom that marks compiled output today
(`COMPILED_INTEGRITY_ATOM`). A handler record or a child's plan that another
compiled pattern refers to by content address is stored the same way.

**One process, many spaces.** A serving worker serves one space or several
([serving loop](../server-side-execution/serving-loop.md), §1). A plan is
immutable data, and what the scheduler derives from it (`PlanIndex`) depends
on nothing else. A worker therefore keeps one parsed plan, one `PlanIndex`,
and one loaded copy of the value code per compiled pattern, for all
instances in all the spaces it serves. Sharing loaded code between spaces
is sound because functions are stateless and module data is frozen
(`language-subset.md`, §3.3), which is the property that lets one call
follow another without a fresh sandbox. One compile serves every space of a
worker that loads the same source at the same time, as `CompileTurns`
arranges today (`executor/serving-runtime.ts`).

**Delivery to clients.** The plan and the value code are documents, and a
client receives them by replication, by content address, when it decides to
speculate an instance. A client does not compile. Today a client that finds
no compiled module compiles the source itself and writes the result back
([module loading](../module-loading.md), threat model). Here a client that
finds none does not speculate that instance and renders its committed
values. A client accepts a compiled pattern only when the document carries
the compiled-output integrity and names a compiler build the deployment
accepts (open questions 23 and 25).

### 10.6 Recovery

Recovery is the activation of section 10.2 and needs nothing further
([serving loop](../server-side-execution/serving-loop.md), §6): the lease,
the watermark, dirty slots from the basis index, undelivered events from the
stream watermarks, pending outbox rows, and effect requests found missing
from their hashes. The memo of evaluated cones is process memory and starts
empty.

### 10.7 A runtime without a serving loop

A test runner or a command-line run evaluates and commits in one process
with no wave. It is the same scheduler with sealing equal to committing:
each cause's transaction commits by itself, a rejected transaction is not
committed, and the outbox dispatches after each commit. Nothing in sections
3 to 8 depends on the wave.

## 11. Client speculation

### 11.1 What a client runs

A client that speculates an instance fetches its compiled pattern, loads the
value code, and runs the scheduler of this document with three differences.

- **Its transactions seal into the overlay.** An event the client fired and
  an input the user typed are causes. Each has one transaction, evaluated
  like the server's, and its writes become an overlay entry that is never
  committed ([speculation](../server-side-execution/speculation.md), §1).
  The client's one commit for an event is the event itself.
- **It has no effect operations** (section 6.7), no outbox, and no basis
  index.
- **Its demand sources are render sinks.** Only what is rendered is
  evaluated.

An input the client has not replicated makes the cones that read it
pending: nothing is fetched for a speculation, and the branch renders its
loading state until the server's value arrives.

### 11.2 Labels of speculative values

A value that reaches the page is fitted against the render boundary's policy
by its label
([render-boundary composition](../cfc-render-boundary-composition.md);
`canRenderLabelUnderPolicy`, called from
`runtime/html/src/worker/display-fit.ts`). A speculative kept output has no
committed label, so the client supplies one, with the rule
`plan-and-label-templates.md` §4.1 gives the server:

1. If the output's instantiation key is the key stored with its last
   committed label (the same slot label identifiers and the same
   selections), the committed label is reused.
2. Otherwise the client instantiates the template with
   `instantiateTemplate`, from the labels of the replicated slots and the
   selections its own evaluation reported.
3. If a slot's label cannot be resolved, because its document is not
   replicated or its label document has not arrived, the output is not
   rendered from the speculation. The page keeps the committed value or
   shows the pending state.

The client's label decides what the client itself displays from data it
already holds. It is never sent, and the label the server commits replaces
it with the value.

### 11.3 Which gates a client evaluates

A client evaluates a gate when the plan and what it has replicated determine
the verdict. The kinds are those of `plan-and-label-templates.md` §4.4 and of
the inventory.

| Gate | From the plan and replicated data alone | What a client lacks when it cannot |
| --- | --- | --- |
| `requiredIntegrity` on input slots | Yes, when every listed slot is replicated with its label | The label of a slot it has not replicated: another user's scope instance, or a document of a space it has no session on |
| `maxConfidentiality` on input slots | Yes, on the same condition | The same |
| Write floor on a write edge | Yes. The integrity of the edge's template, including the atom minted for the body or cone, follows from the plan and the slot labels | The same |
| Writer-fit | Yes. The target's declared confidentiality is in its schema | The exchange rules of a policy the label names, where they are documents it has not replicated |
| Writer policy: the writing body is one the policy names | Yes. It is checked at compile time for a static write edge, and for a handler bound from a factory value once that handler's record is fetched | Nothing, once the record is there |
| UI contract of an event | Yes, exactly. The provenance the contract tests is created by the client's own renderer | Nothing. Section 11.4 says what the server evaluates in turn |
| Egress ceiling of an effect a handler requests | No | The ceiling configured per sink, which is a setting of the serving runtime (`DEFAULT_SINK_MAX_CONFIDENTIALITY` in `cfc/sink-inventory.ts` is the default). A deployment can publish it (open question 23) |
| The request and completion gates of an effect operation (section 6.3) | No. A client has no effect operations | The operation |
| A staged access change | In part. A client can evaluate that the actor owns the space when it holds the access list | The list as the memory server holds it when the change is decided |
| A write to another space by `inSpace` | No | The target's access list, and the allocation record of a target that does not exist yet |
| Writes to a SQLite database through `exec` | In part. The declared ceilings are constants of the plan | Row rules, whose data is in the database on the server |
| The read ceiling of the session | Yes. The client declared it | |
| Admission by the memory server: append authority, a conflict with a concurrent commit, a receipt that exists | No | The store's state when the event arrives |
| A body's time or memory budget | Not reliably | The server's measurement |
| The evaluation budget (section 8.1) | Yes. The bound is a constant of the plan version | |

Two general limits apply to every "yes". The client evaluates against the
labels it holds at the time, and the server evaluates later, against the
store as it then stands. And a client evaluates as its own user, which is
the principal the server stamps on the event, so the trust the two apply
is the same user's.

The client's verdict is advisory. The server's verdict decides what is
committed.

### 11.4 FabriChat's send gate, through the server and the client

FabriChat declares that a message is added only when the send event comes
from a reviewed surface. The declaration is the write policy of the stored
element type: `SentMessage` in `patterns/system/fabrichat/room-records.tsx`
wraps the message record in `AuthoredByCurrentUser` and `WritePolicyAnyOf`
with seven `TrustedActionWrite` entries. Four of them name a sending
handler (`commitSend`, `commitComposerSend`, `commitThreadSend`,
`commitReply`) with the action `ChatSend` and the surface `ChatSendSurface`
(`CHAT_SEND_ACTION` and `CHAT_SEND_SURFACE` in
`patterns/system/fabrichat/schemas.tsx`). In the plan this is constraint
`k0` of `plan-and-label-templates.md` §6.2: a `writer` constraint on the
write edge to `messages/*`, whose alternatives each name a body and a
`uiContract`.

The composer in `patterns/system/fabrichat/room.tsx` is a `cf-submit-input`
that carries `data-ui-action` with the send action, inside an element that
carries `data-ui-pattern` and `data-ui-event-integrity` with the send
surface. Its click is bound to `commitComposerSend`. The exported
`sendMessage` stream is bound to `commitSend` and to no rendered control.

**A send from the composer.**

| Step | Where | What happens |
| --- | --- | --- |
| 1 | Client, renderer | The click is a trusted browser event. The renderer walks from the bound element up through its ancestors and builds the provenance: the pattern and integrity names of the surface and the action of the control (`getEventProvenance` in `runtime/html/src/main/event-provenance.ts`). The worker marks the event as renderer-trusted (`markRendererTrustedEvent` in `cfc/ui-contract.ts`), a mark pattern code cannot set |
| 2 | Client | The event is appended to the stream as a durable entry with `rendererTrusted: true`. This is the client's one commit |
| 3 | Client, speculation | The event's transaction runs on the overlay. The cones the handler reads are made current, the body pushes the message, and the cones that write made stale and the page demands are evaluated: the message list, the empty-state test, and the new row |
| 4 | Client, speculation | The templates are instantiated and `k0` is checked. The writer half was settled when the pattern was compiled: `commitComposerSend` performs the write and an alternative names it. The event half is evaluated on the event bound to the handler's `event` root, by the predicate the server uses (`trustedEventProvenanceMatchesUiContract`). It passes |
| 5 | Client | The transaction seals as an overlay entry whose origin is the event. The row renders. Its labels are instantiated locally by section 11.2 |
| 6 | Server, memory server | The append is admitted on the sender's append authority, and the actor is stamped from the authenticated envelope |
| 7 | Server, serving loop | The drain queues the entry and marks its payload renderer-trusted because the entry carries the attestation (`SpaceServer` in `executor/space-server.ts`). The event's transaction runs as the stamped actor, with the same three parts and the same check of `k0`. It passes, and the transaction seals into the wave with the entry's consequence mark |
| 8 | Both | The wave commits and is pushed. The client retires the overlay entry on the mark, and the committed row replaces the speculative one ([speculation](../server-side-execution/speculation.md), §4) |

**A send from an element without the integrity.** Take a pattern that binds
the room's `sendMessage` stream to a button of its own, outside any reviewed
surface, or that sends to the stream from one of its handlers.

| Step | Where | What happens |
| --- | --- | --- |
| 1 | Client | The event has no provenance naming the send surface, or no renderer-trust mark at all |
| 2 | Client | The event is appended, with no attestation or with provenance that does not name the surface |
| 3 | Client, speculation | The event's transaction runs. `commitSend` pushes the message |
| 4 | Client, speculation | `k0` fails: the alternative that names `commitSend` requires an event from the send surface with the send action, and no other alternative names this body. The transaction is rejected whole. No overlay entry is made and nothing renders. The client presents a predicted refusal (section 11.5) |
| 5 | Server | The same transaction, the same constraint, the same verdict. The whole transaction is rejected, the refusal is recorded as the entry's consequence, and the stream's watermark passes the entry |
| 6 | Client | The entry's error arrives. The predicted refusal becomes the authoritative one |

For this constraint the client's prediction is exact, because the fact the
constraint tests originates in the client. The same fact limits the gate. The
server evaluates the same predicate over the provenance the firing runtime
attested, and admission checks only that the attestation, when present, is
`true` ([events](../server-side-execution/events.md), §2). What the server
adds is the stamped actor and the identity of the writing body. The gate
therefore holds against pattern code, which cannot set the mark, and against
other users, who cannot append as this one. It does not hold against a
client runtime that attests falsely. That is the current trust statement of
the events document, unchanged by this design, and
[the FabriChat client rules](../fabrichat/clients.md) state what a client
that issues gestures must do.

### 11.5 Presenting a predicted refusal

Today a refusal of an event reaches the client as an intent outcome
(`EventIntentOutcome` in `speculation/overlay-destination.ts`). The host is
told of two kinds, a refusal at admission and an event that needs attention
(`subscribeEventAttentionNotifications` in
`runtime/runtime-client/src/backends/runtime-processor.ts`), and a caller
that awaits its send receives the reason. A send from a rendered control
awaits nothing, so its user sees the speculative result disappear.

*Proposed:* a predicted refusal is presented in three places, none of which
is visible to pattern code.

- **No speculative result.** The rejected transaction left no overlay entry,
  so the page never shows the result the server will refuse. This is the
  purpose of evaluating the gate.
- **An outcome to the host and to the caller**, of a new advisory kind,
  carrying the structured refusal: the constraint, the path it guards, and
  what was required. It uses the channel that carries refusals and
  needs-attention notices today. A caller that awaits its send still
  receives the server's outcome and not the client's.
- **A mark on the control that fired**, as an attribute the renderer sets
  and removes, so that a component can show that the action was not
  accepted.

The refusal's text is derived from labels the client holds. It names label
atoms only where the label metadata of the slots involved fits the policy of
the surface it is shown on, and otherwise states the constraint's kind
alone.

When the server's outcome arrives, it replaces the prediction. If the server
accepted the event, because the client held an older label, the consequence
renders and the advisory outcome is withdrawn.

*Assumed:* the client appends the event even when it predicts a refusal.
Deciding that the server would be wrong, or that it need not be asked, is
what [speculation](../server-side-execution/speculation.md) §6 forbids a
client. The presentation and this assumption are open question 7.

### 11.6 Reconciliation

Reconciliation is as
[speculation](../server-side-execution/speculation.md) §4 has it. An entry
whose origin is an event retires when that event's terminal consequence
arrives. An entry whose origin is an input retires when the watermark covers
its commit and a confirmed value has arrived for every document it wrote.
The stored value replaces the speculative one, and a client never decides
between them.

One transaction per cause changes five things.

- **An entry is a cause.** Today a handler's echo is one entry and each
  derivation its writes trigger is another, retired by coverage and arrival.
  Here the handler's writes and every kept output its transaction computed
  are one entry, which retires as a whole on the event's consequence.
- **The consequence and its derivations arrive together.** The serving loop
  can commit a handler's writes one wave ahead of the derivations over them
  ([events](../server-side-execution/events.md), §2). With the derivations
  inside the event's transaction they seal with the handler's writes. The
  exception is a derived write that was dropped on a conflict (section 5.5),
  which arrives with the cause that evaluates its cone again.
- **A result document holds many outputs.** An overlay entry carries whole
  documents, and a standing entry hides a concurrent authoritative change to
  any other path of the same document
  ([speculation](../server-side-execution/speculation.md), §1). With every
  kept output of an instance in one result document, an entry for one
  output would hide the others. *Assumed:* an entry for a result document
  carries the kept paths its transaction wrote, each as a whole value, and
  not the document (open question 16).
- **Identifiers agree.** What a handler creates is named by the event's key
  and the order of creation (`plan-and-label-templates.md`, §1.3), and the
  key is the same in the speculative and the served run
  (`deriveEventKey` in `scheduler/event-identity.ts`). The cells and
  instances a speculative handler creates are therefore the ones the served
  handler creates, which today they are not
  ([speculation](../server-side-execution/speculation.md), §4). *Assumed:*
  an event a handler sends is named the same way, so that the echo of such
  an event retires on its own consequence (open question 16).
- **A refusal is predicted, not discovered.** A transaction the server will
  reject for a gate of section 11.3 leaves no entry to retire.

The sources of divergence are the ones that remain: a clock or entropy a
handler reads, an input that is not replicated, an effect result, a body
that exceeds a budget on one side, and a label that changed between the two
evaluations. Each reconciles by replacement.

## 12. Open questions

Each entry states the assumption this document made.

### Needing the project owner

1. **The extent of a rejection across instances.** The ruling is that a
   failed constraint rejects the cause's whole transaction. A cause's
   transaction covers every demanded instance of the space the cause
   reaches, for every demanding principal (section 5.6). *Assumed:* the
   ruling as written. Two consequences are stated here so that they are
   accepted knowingly. A send can be refused because an unrelated instance
   that reads the same list, and that some session has open, fails a
   constraint of its own. And a storage change read by many instances is
   derived by none of them while one fails. Today a failing node's write is
   dropped alone.
2. **A change of demand as a cause.** Section 4.5 adds it to the three the
   overview lists. *Assumed:* it has a transaction of its own and runs as
   the demanding principal.
3. **Derivations per event, and the storage changes of a batch as one
   cause.** With the derivations an event's writes make stale inside its
   transaction, a burst of events evaluates a whole-collection body once per
   event (section 5.4). The serving loop settles once behind several events
   today. *Assumed:* the cost is accepted for events, and the storage
   changes of one drained batch are one cause (section 10.2).
4. **Which writes withdraw alone on a conflict.** *Assumed:* inside one
   cause's transaction, a derived kept output whose document moved is
   dropped by itself, and a handler's stale read requeues the event whole
   (section 5.5). The alternative is that any conflict withdraws the cause
   whole, which requeues an event whenever a concurrent commit touches
   anything its derivations read.
5. **Demand across spaces.** *Assumed, and recommended:* the session a
   serving runtime holds on another space counts as demand there and as a
   reason to activate it (section 9.2, option B). Until then a derived value
   of another space is read as stored.
6. **One commit sequence across spaces.** *Recommended:* foreign steps in
   order, access changes first, then the home writes, with no atomicity
   (section 9.4, option 2). The alternative that closes the gap of I11 is a
   protocol with a prepare phase.
7. **Presenting a predicted refusal.** *Assumed:* no speculative result, an
   advisory outcome to the host and the caller, a mark on the control, no
   state a pattern can read, and the event is appended regardless (section
   11.5).
8. **A change of label alone.** *Assumed:* a demanded kept output is
   instantiated again when a slot's label changes, without evaluating value
   code (section 3.6). This changes the first step of
   `plan-and-label-templates.md` §4.1 and is stated in the specification
   change with it.
9. **The bounds.** *Proposed:* 10 evaluations of one cone per transaction,
   fixed with the plan version, and 10 runs of a materializer or of an
   effect's request transaction per cycle (section 8). Two cycles are not
   closed: an effect whose completion changes its own request, and
   derivations in two spaces that read each other (section 8.4).
10. **Event order per space.** *Assumed:* the proposal in Scheduler v2 §7.5,
    which awaits a ruling there.

### For another document or the prototype

11. **Reads through handles are made current at the read**
    (`execution-and-storage.md`). Section 5.3 assumes that a handler's read
    through a handle, or through a link it followed, evaluates a stale cone
    that writes the address before it returns.
12. **A slot's value is supplied when it is first read**
    (`execution-and-storage.md`). Section 4.3 assumes it, so that demand
    follows only the slots an evaluation read.
13. **An effect's request is stored** (`execution-and-storage.md`). Section
    6.2 assumes a request of the reactive tier is a kept output written into
    the operation's state, like a child's argument.
14. **Scope instances per cone** (`execution-and-storage.md`). Section 2.1
    assumes the known-scope record of the scopes document carries over with
    a cone in place of a node.
15. **Which cones are stale** (`execution-and-storage.md`). Section 2.2
    assumes a function from dirty slots and the last selections to stale
    cones, under which a slot only an unselected branch reads makes no cone
    stale.
16. **Overlay entries and the identifiers of sent events**
    (`execution-and-storage.md`). Section 11.6 assumes an overlay entry for
    a result document carries kept paths, and that an event a handler sends
    is named by the event's key and its order.
17. **A materializer's envelope in the plan**
    (`plan-and-label-templates.md`, `footprint-analysis.md`). The
    `Operation` record has no field for it. Section 2.4 assumes paths
    relative to the cells the body writes through.
18. **A failed cone's write-edge targets** (`plan-and-label-templates.md`).
    Section 8.2 assumes they keep their values from before the transaction.
    The diagnostic of that section would also be more useful with a source
    position on `Cone`, which the record lacks.
19. **Which transaction a failed egress ceiling rejects**
    (`plan-and-label-templates.md` and the specification change). Section
    6.3 assumes the operation's own request transaction for a request of the
    reactive tier, and the event's transaction for a request a handler makes.
20. **Per effectful built-in: when it is demanded and which time gates it
    declares** (`builtin-inventory.md`). Section 6.2 assumes `navigateTo` is
    demanded with its instance and every other operation with its result.
    Section 6.4 lists the gates the code has. The inventory also does not
    say what becomes of the 50 ms debounce of `wish`, which has no unit to
    apply to once `wish` is structural.
21. **A diagnostic for a cycle through a side-write**
    (`language-subset.md`). Section 8.2 assumes a warning.
22. **The granularity of basis rows** (the prototype). Section 10.4 assumes rows
    per cone.
23. **What a client is told about the deployment** (the prototype, and the
    server-execution documents). Section 11.3 needs the sink ceilings, and
    section 10.5 the accepted compiler builds. *Assumed:* neither is
    available to a client yet, so a client does not predict an egress
    refusal.
24. **Writers the compiler does not see** (`footprint-analysis.md`).
    Sections 2.6 and 8.2 treat a cell handed to a handler factory value as
    written by an unknown body. Whether the analysis can bound that set is
    its question.
25. **Where compiled patterns are stored** (the prototype, and
    [module loading](../module-loading.md)). Section 10.5 assumes the space
    of the instance, written by the serving runtime alone.
