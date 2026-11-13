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

The sibling documents are referred to by file name.
`plan-and-label-templates.md` governs the plan's records and the label
rules. `execution-and-storage.md` owns what happens inside one cause's
transaction for one instance, and what is stored: cone evaluation, the
in-memory memo, the keep set and the documents it is stored in, causal
identifiers, durable operation state, cache promotion, and migration.
`footprint-analysis.md` owns the analysis that fills in a body's footprint and
decides between a static side-write target and a materializer.
`language-subset.md` owns the source constructs. This document owns what
happens across instances and across processes: which slots are dirty, which
cone instances are stale, which outputs are demanded, which transactions
run for which cause and in what order, and what a client does. Where it
needs something from another document it states the assumption it made.

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

- **Cause.** What a transaction is opened for. There are four kinds: an
  event delivered to a handler, a set of changes, the completion of an
  effect, and a change of demand (section 4.5). A set of changes is the
  commits that arrived from storage, the commit of an effect's completion
  among them, and the writes of the events of a batch (section 10.2).
- **The transaction of a cause.** An event has an **event's transaction**:
  the stale cone instances the handler reads, and then the handler body.
  A set of changes and a change of demand each have a **derivation
  transaction**, which evaluates the stale cone instances that something
  demands (`execution-and-storage.md` §1.1). The completion of an effect
  opens no transaction beside the operation's own completion transaction:
  its commit is one of the changes of the set of the cycle that follows
  it, and what reads the result is evaluated in that set's derivation
  transaction (sections 6.5 and 10.2). A transaction covers one space. A
  cause that reaches instances in two spaces has one transaction in each
  (section 9).
- **Batch.** The events one cycle handles in one space (section 5.1). Each
  has a transaction of its own, and one derivation transaction runs behind
  the batch.
- **Unit.** Something the remaining scheduler holds a record for and decides
  to run: a pattern instance, an effectful operation, or a materializer.
  `plan-and-label-templates.md` §4.6 uses the word for something else, a
  part of what a commit preparation verified, which this document calls a
  unit of the preparation.
- **Loaded.** An instance is loaded when a runtime holds its record. An
  instance that is not loaded has stored documents and no record.
- **Bound address.** The address a slot of a loaded instance resolves to: a
  space, a scope key, a document, and a path. The links crossed on the way
  are the slot's **chain** (`plan-and-label-templates.md` §2.5).
- **Dirty.** A slot is dirty when the value it observes at its bound address
  changed since a cone instance last read it. A slot can also be
  *label-dirty* (section 3.6).
- **Cone instance.** One cone of the plan as it is evaluated for one scope
  key and, inside element bodies, one element key per enclosing collection
  (`execution-and-storage.md`, Terms).
- **Evaluation.** One run of a cone's value function for one cone instance.
- **Stale.** A cone instance is stale when something its last evaluation
  read has changed, or when it has never been evaluated. What an evaluation
  read is its slots, the addresses its `dynamic` nodes journaled, and the
  outputs of other cones it pulled. A cone instance that is not stale is
  *current*. In a process that holds a memo entry for the cone instance,
  the entry decides (`execution-and-storage.md` §3.3). In a process that
  holds none, after a restart or a load, the basis rows decide (section
  10.4).
- **Unstored.** A kept output, or the target of a write edge, is unstored
  when the memo holds a value or an instantiation key for it that storage
  does not hold (`execution-and-storage.md` §3.3). Its cone instance can be
  current: storing the output needs no evaluation.
- **Derived write.** A kept output, or a write edge of a cone. A failed
  constraint **drops** a derived write. A conflict, the failure of the cone
  that staged it, or a handler body that wrote what its cone instance had
  read **withdraws** one (section 3.5).
- **Demanded.** A kept output is demanded when something outside its cone
  needs its current value (section 4). A cone instance is demanded when one
  of its kept outputs is, or when something demanded reads the target of
  one of its write edges.
- **Handling.** One event on one stream, identified by its receipt
  (section 5.5).
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

The dispositions hold for compiled instances. An instance that still runs
on the builder path keeps the mechanisms it runs on today, and section 10.8
says how the two kinds share one space.

Five places where the Scheduler v2 document and the source differ are
recorded here because the tables depend on them.

- The node record has no `runBudget` field. The per-pass count is
  `SchedulerNode.passRuns`, held against the constant `PASS_RUN_BUDGET`
  (`scheduler/node-record.ts`, `scheduler/constants.ts`).
- `NodeStatus` has a fourth value, `"unavailable"`, beside `never-ran`,
  `clean`, and `invalid` (`scheduler/node-record.ts`).
- The read set is not a field of the node. It is held per action in
  `DependencyUpdateState.dependencies` (`scheduler/dependency-updates.ts`).
- No identifier is named `sideWriteEnvelope`. A declared envelope is the
  member `materializerWriteEnvelopes` of an action's annotations
  (`TelemetryAnnotations` in `scheduler/types.ts`), and
  `SchedulerMaterializers` indexes the envelopes
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
| D3, the graph rewires itself through data | A changed link or a changed condition changes the next run's read log | Changed | A changed link rebinds a slot. A changed selection changes which slots a cone instance reads. Both are deltas to existing records, with no rediscovery (sections 3.2, 4.3) |
| D4, nodes create nodes | A `map` coordinator starts a sub-pattern per element, and a node registered during a live run takes provisional demand (`Scheduler#markProvisionalDemand` in `scheduler/facade.ts`) | Changed | An element body is one or more cones of its instance, evaluated per element key, and is no unit. A child instance, and an instance a computation makes, is created by the transaction that requested it and gets a record when something demanded first reads it or an event is sent to it (section 2.7) |
| D5, large dormant regions | `SchedulerNode.liveRefs`, maintained by `registerDependentEdge` and its siblings (`scheduler/dependency-graph.ts`) | Kept | Demand is counted per kept output path and per write edge (section 4). An instance nothing demands is not loaded at all |
| D6, runs are transactions | `runSchedulerAction` (`scheduler/run.ts`) opens one transaction per node run | Changed | One transaction per cause and space. An event's transaction covers the handler and what it reads. A derivation transaction covers every instance of the space the cause reaches (section 10.2) |
| D7, events are serialized, transactional, and consistency-gated | `processPullQueuedEventDuringExecute` and `dispatchQueuedEvent` (`scheduler/events.ts`) | Kept, changed form | Section 5. The consistency gate becomes evaluation before the body, inside the event's transaction |
| D8, scheduler state is reconstructible | The serving loop's basis index: rows `SchedulerBasisRow` written by the wave (`executor/wave.ts`) | Kept, re-keyed | Rows are keyed by instance and cone (section 10.4) |
| D9, confidentiality flows through scheduling | `takeInvalidCauses` (`scheduler/invalidation.ts`) hands the trigger addresses to `tx.addCfcTriggerReads` in `runSchedulerAction` | Removed for slots; kept for dynamic reads | A template already contains every slot whose change can cause a recomputation. Trigger reads remain for `dynamic` reads (section 3.4) |

### 1.3 The principles

| Principle | Disposition | In this design |
| --- | --- | --- |
| P1, one change channel | Kept | Committed changes arrive through the storage subscription only. The writes the open transaction has staged are matched against the same index (section 3.5), so that a cone instance reads what its own transaction staged before the transaction seals. That is one matching mechanism with two sources, not a second channel with rules of its own |
| P2, value-accurate invalidation | Kept | A slot becomes dirty only when what its observation class observes at its bound address changed (section 3.3). Reachability is used for order and for demand, never to decide that something is stale |
| P3, demand gates execution | Kept | A cone instance is evaluated only when it is stale and demanded: one of its kept outputs is demanded, or something demanded reads the target of one of its write edges, or a demanded cone instance pulls one of its outputs |
| P4, one static write surface | Kept, and stricter | The plan lists every write edge and every write envelope, and the runtime refuses a write that neither covers (`plan-and-label-templates.md`, §3.11 and §7.4). The registration-time log that could seed a write surface is not carried over. A handler received as a factory value is the exception: its write edges are known when the binding is made, not when the binder is compiled |
| P5, self-identification through the transaction | Changed | The source of a commit is a cause's transaction, not a node (`sourceAction` today, set in `runSchedulerAction`). The index has already been applied to that transaction's staged writes, so its own commit notification marks nothing. Materializers and effect operations keep suppression per unit |
| P6, subscriptions are durable and runs apply deltas | Removed for slots; kept for dynamic reads | Slot entries change only when a slot is rebound, element entries when a collection's membership changes, and the entries of a slot whose path holds `*` when the children of its container change. The journaled reads of a `dynamic` node are diffed against the registered ones after each evaluation, as a node's read log is today |
| P7, convergence is bounded | Kept, at two levels | Section 8 |
| P8, policies are time gates | Kept for the units that have gates | Effect operations, materializers, and render sinks keep `eligibleAt` and the one wake timer (`SchedulerGates` in `scheduler/gates.ts`). A cone instance has no gate of any kind (section 8.4) |
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
| §4.4 Registration and removal | `Scheduler.register` | Changed | Loading and releasing an instance record. Loading inserts index entries for the instance's slots and reads no cell data. The entries of element slots are inserted after a collection is first evaluated, and those of a slot whose path holds `*` after its container is first read (section 3.2) |
| §5.1, §5.2 Liveness | `notifyNodeLivenessChange`, `registerDependentEdge`, and the reference definition `recomputeLiveRefs` (`scheduler/dependency-graph.ts`) | Kept | The same maintenance over kept outputs and write edges instead of nodes (section 4.3) |
| §5.3 Provisional demand, `deferUntilDemand` | `Scheduler#markProvisionalDemand`; `deferUntilDemand` is set by `collectionIndexKeys` only | Removed | A pull extends through a link inside a derivation transaction, so an instance created in a transaction is evaluated in a derivation transaction exactly when something demanded reads it (section 2.7) |
| §6.1 The change channel | `processStorageNotification` | Kept | Section 3 |
| §6.2 Declared reads as ordering hints | `SchedulerNode.declaredReads` | Removed | Order inside an instance is static. Across instances it follows from the reads (section 10.2) |
| §7.1, §7.2 The pass and the work set | `runPullSchedulerSettleLoop`, `collectPullIterationSeeds`, `buildPullIterationWorkSet` (`scheduler/settle.ts`) | Changed | The pass becomes the transactions of one cycle: one per event of the batch, and one derivation transaction behind the batch (section 10.2). No work set is collected inside an instance |
| §7.3 Run gate and run | `runSchedulerAction` | Changed | A cone instance is evaluated when it is stale and demanded. Rejection, a dropped write, and a withdrawn write are handled per transaction and per write (section 5.5) |
| §7.4 Ordering and cycle breaking | `topologicalSort` and `CycleBreaks` (`scheduler/topology.ts`) | Removed | A cone instance is evaluated when a demanded cone instance reads what it writes, so a producer is evaluated before its reader finishes. A cycle is bounded by the evaluation budget (section 8) and is not broken |
| §7.5 Events | `scheduler/events.ts` | Kept, changed form | Section 5 |
| §7.6 Event-initiated work, lineage, receipts, rejection classes | `SpeculationLineage` (`scheduler/lineage.ts`), `handlingReceiptId` (`scheduler/event-identity.ts`), `classifyCommitDisposition` (`scheduler/events.ts`) | Kept | Section 5.5. An event sent to a stream of the same space and an instantiation request are writes of the sending transaction, so they exist only if it commits |
| §7.7 Convergence bounds | `MAX_ITERS`, `PASS_RUN_BUDGET`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS` (`scheduler/constants.ts`), `planBudgetBackoff` (`scheduler/execution.ts`) | Kept, changed form | Section 8 |
| §8 Time gates | `SchedulerGates.eligibleAt` and `scheduleWake` | Kept on units that have transactions of their own | Section 6.4 lists the gates of effect operations. The remote-echo gate (`RemoteEchoBreaker` in `scheduler/echo-breaker.ts`) has no counterpart for a cone instance (section 8.4) |
| §9 Persistence | Deleted there already | As is | Section 10.4 |
| §10 Trigger reads | `addInvalidCause`, `takeInvalidCauses`, `restoreInvalidCauses` | Kept for dynamic reads | Section 3.4 |
| §10 Preflight transactions | A read-only transaction that commits nothing and is outside CFC | Removed | What a handler reads is made current inside the event's transaction, before its body (section 5.3) |
| §10 Refusal surfacing | Reasons and structured refusal details (`cfc/refusal-detail.ts`) | Kept | Sections 5.5 and 11.5 |

### 1.5 The invariants

| Invariant | Disposition | In this design |
| --- | --- | --- |
| I1, live consistency | Kept | At quiescence every demanded kept output holds the value its cone computes from the current committed inputs. The exception is an output whose write a failed constraint dropped: it holds what was stored before, until the instantiation key of the write changes (section 5.6) |
| I2, dormancy | Kept | An instance nothing demands is not evaluated, and loading, dirtying, and releasing it read no cell data. The entries of element slots are not built by loading: they come from the first evaluation of the collection. The entries of a slot whose path holds `*` come from the first read of its container (section 3.2) |
| I3, value-gated execution | Kept | A cone instance that has been evaluated is evaluated again only when something its last evaluation read has changed, or when the process holds no memo entry for it and either its basis rows are behind the heads of its inputs or a stale consumer pulls an interim output of it, which is stored nowhere. A transaction that does not commit, a dropped write, and a withdrawn write leave a cone instance current and its output unstored, and cause no evaluation. The one exception is a cone instance that staged a side-write or made an instance in a transaction that did not commit, or whose side-write was withdrawn: its memo entry is dropped, so that a later evaluation performs the write (section 3.5) |
| I4, event order and consistency | Kept, per space | Handlers run in the order of section 5.4. Every value a handler reads from its own space is current when it reads it (section 5.3). There are five exceptions, and in each the handler reads what is stored: a cell a materializer creates under a cause computed from data (section 7.2); an address inside the envelope of a materializer of an instance that is not loaded (section 7.4); a cell that an instance that is not loaded writes through a handle, and a path of a child's argument whose writing instance is not loaded (sections 4.4 and 5.3); and a derived value of another space (section 9.2). A value of an instance marked as torn down has no current value beside the one last stored (section 2.7) |
| I5, self-stability | Kept | The commit of a cause's transaction dirties nothing in the instances that transaction evaluated |
| I6, bounded non-convergence | Kept, changed form | Section 8 |
| I7, restart equivalence | Kept | Through the basis index (section 10.4) |
| I8, provenance | Changed | A transaction carries its cause. A kept output carries its template, the identities bound to its slots, and the compiled pattern's identity |
| I9, order within a pass | Changed | Within a transaction, a cone instance is evaluated after every cone instance whose output it reads in that evaluation |
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
Settle becomes the transactions of one cycle. The runner becomes cone
evaluation, which `execution-and-storage.md` owns. Events are kept, and
gates are kept for effect operations and materializers. Persistence is the
serving loop's basis index, the stream index of section 5.1, and the
pending-effect rows of section 2.3. Introspection is kept.

## 2. Units and edges

### 2.1 The three kinds of unit

| Unit | What it is | Its transactions |
| --- | --- | --- |
| Pattern instance | One running pattern with a result cell: an instantiated pattern, a `Child` of a plan, or an instance a `lift` or a `computed` makes (section 2.7). A pattern compiled into another, such as a `map` body, is part of the enclosing instance and is no unit | None of its own. It is evaluated in the transactions of the causes that reach it |
| Effectful operation | One `Operation` of kind `effect` of a loaded instance, or one occurrence of a `BodyCall` of kind `effect` that a handler's committed transaction recorded | Its own: a request transaction and a completion transaction (section 6) |
| Materializer | One `Operation` of kind `materializer` of a loaded instance | Its own, one per run (section 7) |

A unit exists per scope instance where its state is scoped. The scope of a
cone instance is the narrowest among three things: `Output.scope` of the
cone's outputs, the addresses its slots are bound to, and the addresses its
`dynamic` nodes read. `Output.scope` is in the rule because a read that
answers for the acting principal, such as `spaceAccess`, is made at an
address every principal shares, so no address shows that the output is of
user scope (`plan-and-label-templates.md` §1.4). A cone instance of user
or session scope is evaluated once per scope key that demands it
(`execution-and-storage.md` §1.8). This is what a narrowed node is today
([scopes](../server-side-execution/scopes.md), §2). The scheduler supplies
the scope keys that demand an instance: they are the principals and
sessions of the demand sources of section 2.5. Section 6.2 says which
principal an operation's request transaction acts as.

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
  /**
   * The document. A kept output is addressed by its instance's result cell
   * and its path, whichever document stores the path (section 4.2).
   */
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

/**
 * Where one slot is bound, for one scope key, one position, and one child
 * of each container that a `*` of the slot's path ranges over.
 */
export interface SlotBinding {
  /** The address the slot resolves to. */
  readonly bound: Address;
  /**
   * The addresses of the links crossed from the slot's root to `bound`. A
   * change at one of them rebinds the slot (section 3.2). A storage link
   * to a part document is not among them.
   */
  readonly chain: readonly Address[];
  /**
   * For a slot with root `element`: the key of the element the position
   * holds. It is a tag. The binding is per position, so two positions that
   * hold one key have two bindings.
   */
  readonly elementKey?: string;
  /**
   * For a slot whose path holds `*`: the segment that takes the place of
   * each `*` for this child, outermost first. A slot has one binding per
   * child its path reaches (section 3.2).
   */
  readonly child?: Path;
  /**
   * For a slot whose path holds `*`: the address of each container a `*`
   * ranges over on the way to this child, outermost first. A change of the
   * children of one of them rebinds the slot (section 3.2).
   */
  readonly containers?: readonly Address[];
}

/** A derived write that storage does not hold (section 3.5). */
export interface UnstoredWrite {
  /** The cone instance: the cone's index, the element keys, the scope key. */
  readonly coneInstance: string;
  /** The kept output, or the write edge by index into `Cone.writes`. */
  readonly write: { readonly output: Index } | { readonly edge: Index };
  /**
   * Present where a failed constraint dropped the write: the constraint, by
   * index into `Plan.constraints`, and the instantiation key of the write's
   * template, as a hash (`plan-and-label-templates.md` §4.1, step 2). The
   * write is not attempted again while its instantiation key is the same,
   * and is attempted again when the key changes (section 5.6).
   */
  readonly refusal?: {
    readonly constraint: Index;
    readonly instantiationKey: Hash;
  };
}

/** The part of an instance record that is per instance. */
export interface InstanceRecord {
  /** The instance's result cell. */
  readonly result: Address;
  readonly plan: PlanIndex;
  /**
   * By slot index and scope key. For a slot with root `element`, also by
   * the positions of the enclosing collections, outermost first. For a
   * slot whose path holds `*`, also by `SlotBinding.child`.
   */
  readonly bindings: ReadonlyMap<string, SlotBinding>;
  /** Slots whose observed value changed since a cone instance read them. */
  readonly dirty: ReadonlySet<string>;
  /** Slots whose stored label changed and whose value did not. */
  readonly labelDirty: ReadonlySet<string>;
  /**
   * For each `dynamic` node of each cone instance that was evaluated: the
   * addresses its journaled reads touched, and the addresses whose change
   * made it stale since.
   */
  readonly dynamic: ReadonlyMap<string, DynamicReadState>;
  /**
   * Demand count per kept output and per write edge, for each scope key
   * and, inside element bodies, each element key (section 4.3).
   */
  readonly demand: ReadonlyMap<string, number>;
  /** The derived writes that did not reach storage. */
  readonly unstored: readonly UnstoredWrite[];
}

export interface DynamicReadState {
  readonly registered: readonly Address[];
  /** The trigger reads of section 3.4. */
  readonly triggers: readonly Address[];
}
```

The record holds no read set, no status per cone instance, no order, no
count of evaluations, and no gate. Cone evaluation holds, beside the
record: the memo entry of each cone instance, with what its last evaluation
read and the selections it made; the count of evaluations in the open
transaction; the element table of each collection; and which instances the
last evaluation of a computation made (`execution-and-storage.md` §2.5,
§2.7, §2.8 and §3.1). The scheduler keeps no second copy of any of them.

**How a dirty slot becomes a stale cone instance.** The scheduler reports
each dirty slot, each label-dirty slot, and each change at an address a
`dynamic` node registered to cone evaluation. Cone evaluation marks the memo
entries whose last evaluation read that address, and when a marked cone
instance is needed it compares what the read returns with what the entry
recorded. A cone instance none of whose reads differ is current again
(`execution-and-storage.md` §3.3). A slot's value is resolved when the
value function first asks for it, so a slot that only an unselected branch
reads is in no entry and makes no cone instance stale
(`execution-and-storage.md` §2.2).

**Element slots.** A binding of an element slot is held per slot and
position, with the element's key as a tag, because labels are per position
and values are per key (`plan-and-label-templates.md` §1.3). The bindings
come from the element table (section 3.2).

**Slots whose path holds `*`.** Such a slot stands for every child of a
container, as `argument rows/*/price` stands for the price of every row.
It is bound at one address per child the path reaches, each with a chain
of its own (`plan-and-label-templates.md` §2.5), so it has one
`SlotBinding` per slot, scope key and child. The bindings are not known
when an instance is loaded, because which children a container has is
data. They are made when the container is first read, and section 3.2 says
what is registered for them and what rebinds them.

**Unstored writes.** `unstored` is the scheduler's record of the derived
writes that a transaction computed and storage does not hold. It is what
the cycle of section 10.2 reads to decide that a derivation transaction is
needed when nothing is stale, and it holds the refusal of a dropped write:
the constraint and the instantiation key the verdict was reached on. The
memo holds the values (`MemoEntry.unstored` in
`execution-and-storage.md` §3.1).

### 2.3 The record of an effectful operation

- **Static:** the built-in, the label of its request (`Operation.input`,
  the join of the templates of its request paths), and the name its state
  document's identifier derives from.
- **Per operation:** the address of its state document, which holds the
  stored request; the request hash and the claim stored there; the
  addresses its last request transaction followed below the references the
  request holds (section 6.2); whether a request is outstanding in this
  process; its gates (section 6.4); and, for an `Operation` of a plan, a
  demand count, which decides whether its request transaction runs
  (section 6.2).

**An operation a handler requested** is named durably by its state
document. The document's identifier derives from the handling and the
request's ordinal (`execution-and-storage.md` §5.4), and the document
holds a `result` back-link to the result cell of the instance whose
handler requested it (§6.4 there). Three things follow from the back-link.

- The operation belongs to that instance. When the instance is torn down,
  the operation leaves the registry with the instance's other operations
  (section 2.7), and a completion for it writes nothing once the instance
  is marked (section 6.3).
- The back-link names an owner and no writer. The operation's own
  transactions write the document and no cone does, so the check of
  section 10.4 finds no cone for an address in it, and a read of the
  result returns what is stored.
- Such an operation has no demand count. Its request is sent when the
  event's transaction commits, whether or not anything demands its result
  (section 6.2).

**Pending-effect rows.** A stored hash with a pending mark says that a
request left the process, or was about to, and that no result is stored
yet. For an `Operation` of a plan the instance leads to it: the
operation's record is built when the instance is loaded, and its request
transaction compares the stored hash (section 6.2). Nothing leads to the
state document of an operation a handler requested. No plan lists it, and
a document the scheduler loads holds a link to it only where the handler
stored one. The serving runtime therefore keeps one **pending-effect row**
for each such operation whose pending mark is set, in the space's store,
beside the basis index (section 10.4).

| Column | Holds |
| --- | --- |
| The operation | Its state document: space, identifier, scope instance |
| The instance | The identifier of the result cell the back-link names |
| The requester | The principal the event was stamped with, as whom the event's transaction ran |

- **When a row is written.** In the store transaction that commits the
  event's transaction: the wave's on a serving runtime. The same store
  transaction writes the state document with the hash and the pending
  mark, so a mark that is stored has a row.
- **When a row is deleted.** In the store transaction of the commit that
  clears the pending mark, which is the completion's, or the commit that
  writes a refusal as the operation's result. A row is also deleted when
  its instance is torn down (section 2.7).
- **What it is.** Identifiers only, never pushed to a client, and never
  read at admission, like a basis row. Only the scheduler of the space's
  serving runtime reads it, at activation and at a teardown. Where the
  runtime shows a row in a diagnostic or to a tool, it shows it under the
  label `plan-and-label-templates.md` §2.6 gives the rows beside the
  documents, which is an assumption there.
- **What activation does with a row.** The process that wrote the mark is
  gone, and with it the outbox's copy of the request. The scheduler reads
  the state document the row names, builds the operation's record, and
  runs a request transaction for it, with the steps of section 6.2: it
  reads the stored request, follows the references the request holds,
  checks the gates, the egress ceiling among them, on the content as it is
  then, writes the hash it computed with the pending mark, and hands the
  request to the outbox. The transaction acts as the requester the row
  names, with the context an evaluation for that principal has (section
  10.3). A ceiling that fails there rejects that transaction and no other:
  the event committed earlier and is not affected, and the operation's
  result takes the refusal as an error state, as for a request of the
  reactive tier (section 6.3). A row whose instance is marked as torn down
  is deleted, and nothing is requested. No instance is loaded on account
  of a row.

That the recovered request is checked and sent with the content as it is
at the recovery is *assumed* (open question 38). The alternative stores
with the state document the content the first request read, which is a
copy of data under a label of its own.

### 2.4 The record of a materializer

A materializer keeps the record a node has today: the read set its last run
journaled, the trigger addresses that made it stale, a status, gates, and its
declared write envelope. The record is process memory. What says after a
restart or a load whether a materializer is valid is its basis rows
(sections 7.2 and 10.4). The plan gives the envelope: it is the `writes` and
the `envelopes` of the body that `Operation.implementation` names
(`plan-and-label-templates.md` §3.11). The two forms of `WriteEnvelope`
differ in what they give the scheduler.

- A `WriteEdge` of the body, and a `WriteEnvelope` of kind `handle`, name
  addresses once the handle's slot is bound: a cell, or the cells the
  elements of a list link to, and a path prefix. They are entries of the
  envelope index, and a reader's bound address can be looked up in it.
- A `WriteEnvelope` of kind `created` names a creation site and no address:
  the cells the site creates are named by causes the body computes from
  data. It bounds what the body may write and is not in the envelope index.
  Section 7.2 says what follows for promotion.

### 2.5 Demand sources

A demand source is not a unit. It holds demand and is never run by the
scheduler.

| Source | Where | Holds demand on |
| --- | --- | --- |
| A client session's tracked set | Serving runtime | Every kept output path the session's watches reach under their schemas ([serving loop](../server-side-execution/serving-loop.md), §1) |
| A render sink | Client | Every kept output path the rendered tree reads |
| An effect operation that is itself demanded | Serving runtime | The cone instances whose write edges stage its request (section 6.2) |
| A materializer | Serving runtime | The addresses of its registered read set and the cone instances that produce its computed inputs, for as long as its instance is loaded (section 7) |
| An event's transaction | Both | What the handler reads, for the length of the transaction (section 5.3) |
| A one-shot pull, such as `cell.pull()` | Both | The paths it reads, until it resolves |
| A warm request | Serving runtime | The documents a provisioning commit staged, for one tenure ([serving loop](../server-side-execution/serving-loop.md), §1) |

A client has no effect operations. It enacts one effect, `navigateTo`,
from its speculative run (section 6.7). *Assumed:* a client runs no
materializer either (section 7.2).

### 2.6 Edges and the writer map

An edge exists where a slot of one unit is bound to an address that another
unit writes. Edges are not stored. They follow from two structures.

- **The address index** (section 3.1) maps an address to the slots bound to
  it, so it gives the readers of an address.
- **The writer map** maps an address to the unit that writes it, and for an
  instance to the cone and the kept output or write edge. For a loaded
  instance its entries are:
  - the instance's result cell at each path of `Plan.outputs` with
    `kept: true`, whichever document stores the path;
  - the target of every `WriteEdge` of its cones, bound as a slot is bound:
    a state cell (`state`); a cell reached through a handle (`handle`), at
    the address the handle's `identity` slot links to, or with `resolved`
    at the address where the resolution ends; a path of a child's argument
    document (`argument`); a created cell (`created`); a path of the stored
    request of an effect operation (`request`); an anchors document
    (`anchors`).

  An effect operation writes the rest of its state document: the hash, the
  claim, the pending mark, and the result. A materializer writes the result
  path of its state document. Its declared write envelope is in a separate
  envelope index, because an envelope says where a materializer may write
  and not where it does.

A target of kind `handle` is bound to an address like a slot, so the writer
map shows a write through an argument handle as it shows a write to a state
cell. Two places of a plan can link to one cell without the plan showing
it. The writer map and the address index are keyed by bound address, so
that overlap is found at run time (`plan-and-label-templates.md` §3.11).

**A handle the instance computed.** A `handle` target can name its handle
by an `identity` entry of the writing body's `Body.computed`, for a handle
that reached the body in a value the instance computed. The plan has no
root and no path for the cell, and no `ConeEdge` for the write. The address
is known once the cone that produces the value has been evaluated, which is
before the body runs. The scheduler then enters the target in the writer
map at the address the reference leads to, or with `resolved` at the
address where its resolution ends, and replaces the entry when a later
evaluation produces another reference. The readers of the cell are the
slots and the registered addresses that the address index holds for it, so
they are found by bound address, as for two places that link to one cell.
A `WriteEnvelope` of kind `handle` that names an entry of `Body.computed`
is entered in the envelope index in the same way.

Three kinds of writer are not in the map, and each is handled by a rule of
its own.

- **A handler.** Its writes arrive as an event's transaction, and its write
  edges say which bound addresses it may write.
- **A handler bound from a factory value.** Its write edges are known only
  once the binding is resolved (`plan-and-label-templates.md` §3.21). Until
  then `footprint-analysis.md` §8.5 bounds what it may write by position:
  the cells the `link` entries of `Binding.state` link to at positions
  where the declared state type has a writable handle type, and the cells
  reachable from those entries through a writable handle type. Once the
  binding is resolved, the handler's own record replaces the bound.
- **A writer in an instance that is not loaded.** Section 4.4 applies.

### 2.7 Instances a computation makes

A `lift` or a `computed` may instantiate a pattern, by ruling, and that
pattern may request effects. A `lift` or a `computed` does not request an
effect itself (*assumed*, question 38 of the continuation plan). Such a
`computed` is not promoted (`language-subset.md` §6.1), so the call is made
by a sandboxed body. `plan-and-label-templates.md` §3.14 has the label
rules, and `execution-and-storage.md` §2.8 has what one transaction does
and stores: the identity of an instance, the write edges that stage its
argument, the instances document, and the mark on an instance that was
torn down. This section has the scheduler's part.

**Today.** A `lift` or a `computed` whose run called a pattern has its
frame turned into one synthesized pattern (`patternFromFrame` in
`runtime/runner/src/builder/pattern.ts`), which the runner runs on a result
cell named from the computation's record of its inputs, its outputs and its
function source (`resultFor` in `#instantiateJavaScriptActionNode` in
`runtime/runner/src/runner.ts`). That record is the same on every run, so
every run names the same cell. The runner keeps a content hash of the
synthesized pattern per result cell and scope key (`#resultPatternCache`).
A run whose synthesized pattern has the hash of the run before starts
nothing. A run with another hash, which a changed argument value gives,
calls `run` on the same result cell, which stops what runs there and starts
the new pattern (`#writeJavaScriptActionResult`). The instance inside is
released when the computation's node is canceled, and when a commit that
set it up is rejected (`releaseChild`). So an instance belongs to the
computation and is named by its place today as well. What differs is that
today a changed argument value replaces the running synthesized pattern,
where this design updates the argument of an instance that stays.

**The record of what was made** is cone evaluation's. The memo entry of the
making cone instance lists, per site, the instances its last evaluation
made, and the instances document of the enclosing instance holds the same
list as of the last committed evaluation, so that it is found after a
restart (`execution-and-storage.md` §2.8). Cone evaluation compares the
two site by site. It tells the scheduler which instances a transaction made
and which it tore down.

**When an instance gets its record.** A transaction that makes an instance
stages its result document and its argument. The scheduler builds the
instance's record in that transaction when something demanded reads its
result, and not before: when demand reaches an address of the instance's
result cell (section 4.3), the scheduler finds the staged result document,
takes the compiled pattern it names, and loads the instance from what the
transaction staged. Where the compiled pattern is not in the process, the
instance stays unloaded with its demand pending, as section 10.5 has it for
any instance, and a reader of its result finds no value until it is loaded.
An instance whose result nothing demanded reads has documents and no
record.

**When its cones are evaluated.** After the invocation that made the
instance has ended, because the requests of an invocation are performed
when it ends. From then on its cone instances are evaluated in the same
derivation transaction when something demanded reads its result, by the
pull that extends through that result, like those of any child in the same
space. Three cases follow.

- A consumer that reads through the link pulls the making cone instance
  first, because the link is a value that cone instance computed, and then
  the instance's cone instances that compute the path it reads.
- The making body can read the instance's result through the link it holds
  from an earlier evaluation. That read is journaled under the entry of
  `Body.handles` that names the site, and it is made current at the read
  (`execution-and-storage.md` §2.4). The address is registered for the
  `dynamic` node, so a change of the result makes the making cone instance
  stale and records a trigger read (section 3.4). The result depends on the
  argument the same body writes, so this is a cycle, and the plan has no
  edge for it. It ends when an evaluation writes the argument it wrote
  before, and otherwise at the bound of section 8.1.
- A later evaluation in the same transaction that changes a staged argument
  path dirties the instance's `argument` slots bound to it, by the matching
  of section 3.5. The instance's cone instances that read the path are
  stale and are evaluated again, each under its own count.

**Demand.** The making computation holds no demand on what it makes. Demand
reaches such an instance as it reaches any instance: through a slot of a
consumer whose path crosses the link, through a watch or a render sink
whose schema reaches through the link, and through the addresses the making
body's `dynamic` node registered. An instance that a computation makes and
nothing reads through is not evaluated, and its effects are not requested.

**Teardown.** An instance that the last committed evaluation made and an
evaluation no longer makes is torn down in the transaction of that
evaluation. Cone evaluation stages the mark in the instance's setup record
and removes the instance from the instances document. When the transaction
seals, the scheduler does the following for the instance and for every
instance that belongs to it: its children of the reactive tier, and the
instances its own computations made.

- **The record is released.** Its slot, chain, dynamic, operation and
  materializer entries leave the address index, and its entries leave the
  writer map and the envelope index.
- **Demand held on it is withdrawn.** The counts of its kept outputs and
  write edges go to zero, and the withdrawal of section 4.3 runs upstream
  of them. A source that still reaches it, through a link some other
  document holds, reads the values last stored and evaluates nothing.
- **Queued events are not handled.** An event that is queued for one of its
  streams, or that arrives later, is unrunnable. It takes the drop of
  [events](../server-side-execution/events.md) §5: the entry records the
  dropped-event notice, and the stream's `eventWatermark` passes it. An
  event whose transaction sealed earlier in the same cycle stands.
- **Pending effects are abandoned.** Its effect operations leave the
  registry: the `Operation`s of its plan, and the operations its handlers
  requested, which belong to it by their back-link (section 2.3). A
  request the outbox holds and has not dispatched is removed from the
  outbox. A request that was dispatched is not recalled, and its
  completion writes nothing, as a completion for a superseded request
  writes nothing (section 6.3).
- **Its materializers stop**, and their standing demand ends.
- **Its rows are deleted** from the basis index and from the stream index,
  and its pending-effect rows with them, in the wave's store transaction.

A marked instance is not loaded again (section 4.4). If the write of the
mark is withdrawn on a conflict, the instance is not torn down in storage,
and the next demand that reaches it loads it.

The transaction that tears an instance down marks every instance that
belongs to it as well: its children of the reactive tier, the instances
its own computations made, and the instances that belong to those in turn
(`execution-and-storage.md` §2.8). A child of the reactive tier of a
torn-down instance, reached later through a link some document holds, is
therefore found marked.

**A failed evaluation** makes no instance and tears none down. The
instances of the last committed evaluation stay loaded, and the paths of
their arguments take the error state (`plan-and-label-templates.md` §3.14
and §5.2). Their cone instances that read those paths fail in turn, by the
matching of section 3.5.

**A changed factory.** Where the callee at a site is a factory value and an
evaluation finds another factory there, the instance is torn down as above
and a new one is set up on the same result cell
(`plan-and-label-templates.md` §3.15). Its basis rows are keyed by the
compiled pattern (section 10.4), so the rows of the earlier one match
nothing and every cone instance of the new one starts stale.

**An effect in such an instance** is an `Operation` of the instance's own
plan, and no rule is special to it. A cone of the instance computes its
request from the instance's `argument` slots. When an evaluation of the
making computation writes a changed argument path, the path's slot is
dirty, the cone instance that computes the request is stale, and, where
the operation is demanded, it is evaluated in the same derivation
transaction and stages the request. The operation's request transaction
then runs in the same cycle, finds another hash, and requests the effect
again (section 6.2). An evaluation that writes the argument it wrote before
changes no hash and requests nothing (section 6.6). The label of what the
computation read reaches the request through the label staged for the
argument path (`plan-and-label-templates.md` §4.5), and the egress ceiling
is checked in the operation's own request transaction.

**In another space.** Section 9.3 has an `inSpace` instantiation that a
computation makes: what carries its argument, a changed argument of a
later evaluation, and the mark of its teardown into the other space, and
which loop does the steps of the teardown above.

**On a client.** A client that speculates the enclosing instance evaluates
an instance a computation makes like any child, and tears it down in its
overlay in the same way. It names the same result cell unless an enclosing
element key is a salted plain value (section 11.6).

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
| Chain | Each link address on a slot's chain | Rebinds the slot, then marks it dirty |
| Container | For a slot whose path holds `*`: the address of each container a `*` ranges over, observed for `enumeration` (section 3.2) | Marks the slot dirty. The next read of the slot binds it again at the children the container then has |
| Dynamic | Each address a `dynamic` node's last evaluation journaled, with the class of the read | Adds the address to that node's trigger reads, which makes the cone instance stale |
| Row | Each input document a basis row names, for a cone instance whose slot or dynamic entries this process does not hold, and for a materializer that has not run in this process (section 10.4) | Makes that cone instance stale, or marks that materializer invalid |
| Materializer read | Each address of a materializer's read set | Marks the materializer invalid and records the address as a trigger read |
| Operation | The request path of an effect operation's state document, each address its last request transaction followed below a reference of the request, and the result path | Marks the operation's request stale, or delivers its completion |

The index is keyed by space, scope key, and document, as the trigger index is
(`SpaceScopeAndURI`), so an entry for a document of another space is an
ordinary entry (section 9.1).

Three kinds of read have no entry.

- **A sampled read.** A slot with `sampled`, and a `sample()` through a
  handle of `Body.handles`, is in the label and makes nothing stale
  (`plan-and-label-templates.md` §2.5). The scheduler registers no slot
  entry, no chain entry and no dynamic entry for it. Its address is
  resolved at each evaluation, and a change at it, of the value or of the
  label, marks nothing.
- **A slot bound for one transaction.** A slot with root `event`, `cause`
  or `binding` is bound when an event is dispatched (section 3.2).
- **A storage link.** A storage link to a part document is passed through
  and is on no chain (`plan-and-label-templates.md` §2.3). An entry for a
  kept path is registered at the document that stores the path. A
  transaction that moves a subtree into a part document or back writes the
  parent document in the same commit, and the scheduler then registers the
  entry at the document that stores the path after the move. That is not a
  rebinding: the bound address names the result cell and the path, which
  did not change, and the slot is dirty only if what it observes changed.

### 3.2 Entries from the plan and the bindings

Loading an instance builds the entries of its slots that are not element
slots and whose path holds no `*`, from two inputs, and reads no cell data
beyond link structure.

1. **The plan** gives each slot a root, a path, a class, and the flags
   `resolved`, `inPlace` and `sampled`.
2. **The bindings** give each root a document:

   | Slot root | Bound to |
   | --- | --- |
   | `argument` | The instance's argument document |
   | `state` | The state cell's document. Its identifier derives from the instance, the steps of `within` with the element keys, and the cell's name. For a migrated instance, the carry-over record in the result document names the stored document of a cell declared inside a compiled-in sub-pattern, and the scheme of a cell declared directly in the body, and the binding takes both from it (`execution-and-storage.md` §5.2 and §9.3) |
   | `operation` | The result path of the operation's state document, named the same way. For an operation inside an element body, the element key is a step of `within` in the document's identifier (`execution-and-storage.md` §6). The result of a materializer is read through such a slot (section 7.1) |
   | `child` | The child's result cell, named the same way |
   | `params` | For an instance whose callee is an inline pattern written at an instantiation in a function body: the instance's parameters document. For a closure called as a factory value: the factory value, at the address the `identity` slot of the factory is bound to (`plan-and-label-templates.md` §3.15; `execution-and-storage.md` §4.6) |
   | `binding` | Bound when an event is dispatched, for the length of its transaction. For a binding of the reactive tier each state path resolves through `Binding.state` to a slot or an output of the instance. For a binding made in a function body the root is the binding state document: a copied path is a path of that document, and a path bound by reference crosses the link the document holds. No index entry |
   | `event`, `cause` | The event, for the length of its transaction. No index entry |
   | `element` | Per position, the address the element was read from, and for a linked element the cell it links to. Bound from the element table, not at load (below) |

**Paths that cross links.** A slot's path is resolved from its root the way
a read resolves it (`plan-and-label-templates.md` §2.5). Where the value at
a segment is a stored link, resolution continues at the link's target: an
argument path that holds a link to a cell of the parent, a position of a
data type that storage holds as a link to a record's own document, a path
that continues below a cell handle, a link to an output of another
instance. The scheduler records the address of each link crossed as the
slot's chain and registers a chain entry for it, observed for `identity`.
The pointer labels of the chain are part of the slot's label.

- An `identity` slot stops at its last segment. Its chain holds the links
  crossed before that segment, and its slot entry observes the reference
  stored there.
- An `identity` slot with `resolved` continues from its last segment
  through every link, to the cell whose value is not a link. Its chain
  holds those further links, so a change of any of them rebinds it.
- A `shape` slot with `inPlace` stops at its last segment. Its entry is at
  the position, and it matches when the position comes to hold something,
  ceases to, or changes between a link and a plain value. It does not
  observe the cell a link there leads to. A `shape` slot without the flag
  at the same path resolves through the link and is bound in that cell.
- Every other slot resolves through a link at its last segment.
- A storage link is passed through and is not on the chain (section 3.1).

A change at a chain address rebinds the slot: the scheduler resolves the path
again, replaces the slot's entries, and marks the slot dirty. That is the
whole of what D3 requires for slots.

**A static read through a handle** is a slot of this kind
(`footprint-analysis.md` §7.2): its path is the handle's path followed by
the path read, and it crosses the handle's link. So is a read of an output
of another instance through a link the plan names
(`execution-and-storage.md` §4.4).

**Collections.** A collection's element slots are bound per position
(`plan-and-label-templates.md`, §1.3). The bindings are not known when an
instance is loaded: the key of a plain value is a hash of the value, and a
collection derived by `map` or `flatMap` has positions only once it was
evaluated. Cone evaluation builds the element table of a collection when it
evaluates it (`execution-and-storage.md` §2.5). The table holds, per
position, the key and the binding of each element slot.

- After the first evaluation of a collection, and after each change of its
  membership, the scheduler registers one entry per position and element
  slot from the table, tagged with the element's key, and removes the
  entries of positions that are gone.
- A change to one element's cell marks the slots of the positions that hold
  that key dirty and no others.
- A membership change arrives as a change to the collection's `enumeration`
  slot, which is a slot of the plan and has its entry from load. The
  evaluation it causes rebuilds the table, and the scheduler then replaces
  the entries of the positions that changed. An element that moved keeps
  its key, so its cone instances are not stale, which is the property the
  element-key rule exists for.
- Before a collection is first evaluated in a process, its element slots
  have no entries. A collection that was never evaluated has cone instances
  that are stale anyway. A collection that was evaluated by an earlier
  process has basis rows, and the scheduler registers a row entry for each
  input document the rows name (section 10.4), so a change to an element's
  document makes that element's cone instances stale by document until the
  table exists.

**A path that holds `*`.** A slot such as `argument rows/*/price`, of
class `value`, has no one bound address. It is bound at one address per
child its path reaches, each with a chain of its own
(`plan-and-label-templates.md` §2.5). Over a stored list of links to row
documents that is one address per row, each behind the link of its row.

- **When it is bound.** When the value function first asks for the slot
  (`execution-and-storage.md` §2.2), and for a slot of a handler's
  `Body.reads` when the event is dispatched (section 5.2). The path up to
  the first `*` is resolved as any path is, which gives the address of the
  container. The container's children are read, and for each child the
  rest of the path is resolved from that child, through a link where the
  child or a later segment holds one. A path with a second `*` repeats
  the step at each container the first resolution ends in. The result is
  one `SlotBinding` per child: its bound address, its chain, the segment
  that took the place of each `*`, and the addresses of the containers
  (section 2.2). The links crossed before the first `*` are on the chain
  of every child.
- **What is registered.** One slot entry per child, at its bound address,
  with the slot's class; one chain entry per link on a child's chain; and
  one container entry at each container, observed for `enumeration`. The
  entries are registered after the container was read, never at load,
  because which children a container has is data.
- **A change at one child's bound address** marks the slot dirty. A change
  at a link on one child's chain rebinds that child alone, as a chain
  entry rebinds any slot.
- **A change of a container's children** matches the container entry, as
  a change of membership matches a collection's `enumeration` slot: a
  child was added or removed, or the order changed. The slot becomes
  dirty, so the cone instances that read it are stale. The evaluation
  that reads the slot next binds it again, and the scheduler adds the
  entries of the children that are new, removes the entries of the
  children that are gone, and keeps the rest. Until then the slot is
  dirty and nothing more can make its readers stale, so the entries that
  are missing for a new child are not needed.
- **Before the container is first read in a process,** the slot has no
  entries. A cone instance that was never evaluated is stale anyway. One
  that an earlier process evaluated has basis rows, which name the
  documents the children were read from, and the scheduler registers a
  row entry for each (section 10.4).
- **With `sampled`** the slot has no entries of any kind (section 3.1).
- **In an element body.** A slot with root `element` whose path holds `*`
  has one binding per position and child.
- **Demand and the writer map.** Each child's bound address is looked up
  in the writer map by itself, so demand reaches the writer of each child
  the slot reads and of no other (section 4.3).

**What loading costs.** One index insert per slot that is not an element
slot and whose path holds no `*`, one per chain address of such a slot,
and one per basis row whose cone instance has element slots, slots whose
path holds `*`, or `dynamic` nodes. Nothing is evaluated.

### 3.3 Matching by observation class

A committed change names a document and carries its value before and after.
The index decides which entries it matches as the trigger index does today
(`collectTriggeredActionsForChange`), with the comparison chosen by the
slot's class:

| Slot class | Dirty when |
| --- | --- |
| `value` | The value at the bound path differs, compared deeply. A change that makes the path reachable or unreachable counts |
| `shape` | The path came to exist, ceased to exist, or changed kind |
| `shape`, with `inPlace` | The position came to hold something, ceased to, or changed between holding a link and holding a plain value |
| `enumeration` | The set of children at the path, their order, or their count changed |
| `identity` | The reference stored at the path changed. What it refers to is not compared |
| `labelMetadata` | The label stored for the path changed (section 3.6) |

These are the deep and shallow matches of Scheduler v2 §6.1, split by class.
*Assumed:* until storage has an entry class that separates a count from a
key set, `shape` and `enumeration` match alike, as they resolve alike for
labels (`plan-and-label-templates.md`, §2.2).

Marking a slot dirty does nothing else. No cone instance is evaluated, no
reader of the instance's outputs is marked, and no cell data is read. The
match decides that a slot is dirty. Whether a cone instance that read the
slot is stale is confirmed by cone evaluation when the cone instance is
needed (section 2.2).

### 3.4 Dynamic reads and their trigger reads

A `dynamic` node of a template stands for reads whose addresses are data
(`DynamicReads` in `plan-and-label-templates.md`, §1.1). There are five
kinds.

| Kind | What is journaled |
| --- | --- |
| `link` | The links followed through a reference the plan cannot name a path for: a reference the instance computed, the further links of a `resolveAsCell()` or another resolution that some runs skip, and the links `resultOwnerOf` follows |
| `handle` | The reads a body makes through an entry of `Body.handles`, each narrowed to the entry's read envelope: a read on some runs only, a read at a path the body computes, a read through a handle found by such a read, a read through a handle whose formal input is bound to a value the instance computed (`footprint-analysis.md` §7.2), and a read through the link of an instance an earlier evaluation of the same body made (section 2.7) |
| `space` | The read of a space's access list |
| `search` | The name and the schema of every candidate a search considered |
| `labelMetadata` | The label-metadata observations a body made of targets no slot names (`plan-and-label-templates.md` §3.16) |

For these the scheduler does what it does for every read today.

- **Registration.** When a cone instance is evaluated, the runtime journals
  the reads its dynamic nodes make, per node
  (`execution-and-storage.md` §2.4 and §3.1). The scheduler diffs them
  against the addresses registered for that node and applies the difference
  to the index. A node whose reads did not change costs nothing. A read
  made with `sample()` is journaled for the label and is not registered.
- **One evaluation late.** A dynamic node cannot read a new address except
  as a consequence of a change to something it already read, so the reads of
  evaluation *k* decide what makes evaluation *k + 1* necessary, as
  [serving loop](../server-side-execution/serving-loop.md) §3b states for
  nodes.
- **Trigger reads.** A change that matches a dynamic entry is recorded with
  the node as a trigger read, keyed by address. When the cone instance is
  next evaluated, the label of each trigger address joins the node's label,
  whether or not the new evaluation reads that address again. This is what
  §8.9.2 (`08-09-runtime-label-propagation.md`) requires of a rerun that a
  dependency scheduled, as `plan-and-label-templates.md` §3.10 states it,
  and it is what `addCfcTriggerReads` does for a node today.
- **Handed to the preparation.** The trigger reads are not in the journal
  of the evaluation. The scheduler holds them, and the commit preparation
  of the transaction that evaluated the cone instance takes them from the
  instance record: they enter the node's label, the instantiation key, and
  the prepared digest (`execution-and-storage.md` §1.9, item 5;
  `plan-and-label-templates.md` §4.6).
- **When they are cleared.** The trigger reads of a node are cleared when
  every write of the evaluation that consumed them has reached storage.
  That is the commit of the transaction that evaluated the cone instance,
  where all of its writes commit. Where a write of that evaluation is
  unstored, because the transaction did not commit or the write was dropped
  or withdrawn, the trigger reads stay with the record, so that the
  transaction that later stores the write from the memo forms the same
  instantiation key.
- **Label metadata.** A journaled label-metadata observation is registered
  with the class `labelMetadata`, so a change of the label stored at an
  observed path makes the cone instance stale, as a change at a
  `labelMetadata` slot does.
- **The back-link `resultOwnerOf` reads** is journaled with the reads of
  the node of kind `link` and registered, so a change of the back-link
  makes the cone instance stale. It is left out of the node's label and
  out of its trigger reads, because it is a verifier read
  (`plan-and-label-templates.md` §3.16). *Assumed*, with question 35 of
  the continuation plan.
- **Whether a space is deleted** is state of the runtime and not a
  document. When the memory server's answer for a space changes, the
  runtime reports a change at the address of that space's access list. The
  `space` node of a cone instance that asked about the space has an entry
  there, so the cone instance is made stale and the address is a trigger
  read (`plan-and-label-templates.md` §3.16).
- **Why slots need none.** A change to a slot makes a cone instance stale
  only if its last evaluation read that slot, and then the slot is in the
  templates of the outputs that evaluation produced. A slot that only an
  unselected branch reads causes no evaluation and no rewrite.

A dynamic read is the one place where the label of a kept output depends on
which changes the scheduler delivered. The trigger reads are therefore part
of the instance record and not of the memo, which the runtime may drop
under memory pressure.

**After a restart** the instance record is gone, and with it the registered
addresses. The basis rows name the documents a dynamic node's reads
touched. The scheduler registers a row entry for each (section 10.4), so a
change to such a document makes the cone instance stale by document until
its next evaluation registers the addresses again. The trigger reads that
were held at the restart are lost. That is sound, with one exception
(`plan-and-label-templates.md` §3.10, "Trigger reads across a restart").
A write whose evaluation consumed them and that did not reach storage left
the basis rows of its cone instance behind (section 3.5), so the cone
instance is evaluated again and its journal holds the labels of what it
reads then. The label of an address the evaluation no longer reads is not
joined. A change at such an address lies behind a changed read that the
evaluation makes again, whose label it joins, so the label covers what the
value depends on.

The exception is a body that makes a sampled read. A change at the address
of a sampled read makes no cone instance stale (section 3.1), and the
value read can decide which reads follow. Such a body can then be
evaluated because of a change at an address that it does not read again,
and after a restart the label of that address is not joined. That is an
accepted residual, equal to today, which that document assumes and lists
for the owner (its open question 29; open question 31 here).

### 3.5 The open transaction's own writes

The writes a transaction stages have to reach the cone instances that read
them before it commits, without waiting for a commit notification. Values
are staged when they are computed: a kept output and a side-write when
their cone instance is evaluated, a handler's writes while its body runs
(`execution-and-storage.md` §1.6).

- **Matching.** When a write is staged, to a kept output, through a write
  edge, or by a handler, the scheduler matches it against the index exactly
  as it matches a committed change. Slots of the same instance and of other
  instances become dirty, and trigger reads are recorded.
- **In a derivation transaction,** a cone instance made stale this way is
  evaluated in the same transaction when it is demanded (section 10.2).
- **In an event's transaction,** the cone instances that the body's writes
  made stale are not evaluated. They are evaluated before the body of a
  later event of the batch that reads them, or in the derivation
  transaction behind the batch (section 5.2).
- **Across the transactions of a cycle.** A sealed transaction's writes are
  visible to the later transactions of the cycle, and the dirty marks they
  made stand.
- **Staged labels.** Labels are instantiated in the commit preparation,
  after evaluation, producers before consumers
  (`plan-and-label-templates.md` §4.5). A slot bound to an address that the
  transaction, or an earlier transaction of the batch, wrote resolves to
  the label staged there. A label the preparation stages for an address
  whose value did not change is matched as a label-only change (section
  3.6): the slots bound to the address become label-dirty, and a demanded
  output whose template reaches one is instantiated in the same
  preparation, after the write that staged the label.
- **The commit notification.** When the transaction commits, storage emits
  a commit notification whose source is that transaction. The scheduler
  skips it: every change in it was matched when it was staged. This is P5
  with a cause in place of a node.

**A staged write that is unstaged.** Three things take a staged write out
of a transaction before it seals: a failed constraint drops a derived write
(section 5.6), the failure of a cone withdraws its side-writes (section
8.2), and a body that wrote something a cone instance had read before the
body ran withdraws the derived writes of that cone instance that were not
instantiated early (section 5.2). The third case holds for every derived
write of the cone instance: a kept output, a side-write, a path of a
child's argument, and a path of an effect's request. In each case the
scheduler matches the address again, with what is stored. A cone instance
that had read the staged value through a slot is stale again. In a
derivation transaction, and before a handler body, it is evaluated again
in the same transaction, against the stored value, under its own count.
After a handler body it is not evaluated again in the event's
transaction. The writes it staged from the value that is gone are
unstaged with that write, and it waits for the derivation transaction
behind the batch, like every cone instance the body made stale (section
5.2). It does not fail because the writer failed, and a write dropped
once is not staged again in the same transaction.

**What a write that did not reach storage leaves.** Four kinds of
transaction do not commit: an event's transaction that a constraint on
the handler's own writes rejected, one that was aborted, an attempt that
was withdrawn whole at a journaled read (section 5.3), and the transaction
of an event that is requeued (section 5.5). A write does not reach storage
when its transaction is one of those, when a constraint drops it, or when
it is withdrawn, by a conflict at the commit or in one of the ways above.
Stale and unstored are two states, and the scheduler keeps them apart.

- **The dirty marks of writes that did not happen are undone.** A slot that
  only the unstaged or uncommitted write had dirtied returns to its state
  before it. A slot the cause itself dirtied stays dirty.
- **A cone instance that staged no side-write and made no instance stays
  current.** Its memo entry keeps the value it computed, which is a pure
  derivation of state the transaction did not change. Its kept output is
  unstored. The scheduler adds the write to `InstanceRecord.unstored`, with
  the refusal where a constraint dropped it, and does not evaluate the cone
  instance again on that account.
- **A cone instance that staged a side-write or made an instance** in a
  transaction that did not commit, or whose side-write was withdrawn, by a
  conflict or because a handler body wrote something the cone instance
  had read, has its memo entry dropped by cone evaluation
  (`execution-and-storage.md` §3.3). It is stale, and a later evaluation
  performs the write.
- **The basis rows are not advanced** for a cone instance with a write that
  did not reach storage (section 10.4). After a restart, when no memo entry
  exists, the rows are behind the heads, the cone instance is stale, and it
  is evaluated again.
- **Storing what is unstored.** The next transaction that demands an
  unstored output stores it from the memo, without an evaluation, by the
  third condition of `plan-and-label-templates.md` §4.1. The cycle runs a
  derivation transaction for a demanded unstored output even when nothing
  is stale (section 10.2). A write that carries a refusal is the exception
  (section 5.6). The output is staged from the memo before anything in
  the transaction reads its address, so that no reader takes the stored
  value, which was computed before the change the unstored value holds.
  An event's transaction is such a transaction for what its handler
  reads: an unstored output at an address the handler reads, or that a
  cone instance evaluated for the handler reads, is staged before that
  read and instantiated early (section 5.2).
- **A failed evaluation is an evaluation.** A cone instance that failed has
  a memo entry with the error state and the reads made up to the failure,
  its error state is stored like a value, and its basis rows advance. It is
  evaluated again when something it read changes, and not before. Where
  the transaction that evaluated it does not commit, the error state is
  unstored like any other output of that transaction, and the rows wait
  for the transaction that stores it. That is the case when the handler
  of an event's transaction reads the failed cone instance (section 5.5).

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
  value is the label, so the cone instance that reads it is stale and is
  evaluated like any other. `principalOf` and `inspectConfLabel` then return
  current results. A `dynamic` node of kind `labelMetadata` that observed
  the path is made stale in the same way (section 3.4).
- A slot of any other class bound to the path becomes **label-dirty**. No
  value changed, so no cone instance is stale and no value code runs. A
  slot with `sampled` has no entry and is never label-dirty.
- For a kept output or a write edge that is demanded and whose template
  reaches a label-dirty slot under its last selections, a derivation
  transaction instantiates the template again, from the memo's value and
  the last selections. This is the second of the three conditions of
  `plan-and-label-templates.md` §4.1. The instantiation key differs, so
  steps 2 to 4 of that section run: the label is rewritten and the
  constraints are checked again. The cycle runs a derivation transaction
  for a demanded output that a label-dirty slot reaches even when nothing
  is stale (section 10.2).
- For a kept output nothing demands, nothing happens. The slot stays
  label-dirty, and the next evaluation of the cone instance instantiates
  with the current label. §8.9.4 permits the delay: "There is **no
  retroactive relabeling obligation**".

The rule changes when a label is derived again, not what it is. It is
*assumed*, pending the owner (question 11 of the continuation plan; open
question 8), and `plan-and-label-templates.md` §4.1 states the same
assumption.

### 3.7 A change that reaches nothing loaded

An instance that is not loaded has no entries, so a change to one of its
inputs matches nothing and costs nothing. Its stored kept outputs keep the
values and labels they have. What makes the instance correct when it is next
loaded is the basis index: its rows record the sequence number of each input
at the last evaluation, and loading compares them with the inputs' current
heads (section 10.4).

## 4. Demand

### 4.1 Which outputs are demanded, and why

Demand is held on kept outputs, per path, and on the write edges of cones.
The sources are the rows of section 2.5. In short:

- a **rendered result**: on a client the render sinks, on the serving runtime
  the union of what the space's client sessions track;
- an **effect's input**: an effect operation that is itself demanded holds
  demand on the cone instances that stage its request;
- a **materializer's standing demand** on what it read and on the cone
  instances that produce its computed inputs;
- a **handler's reads**, for the length of the event's transaction.

An instance is *demanded* when at least one of its kept outputs or write
edges is. On the serving runtime an instance is loaded when demand that
stands reaches it, when a read finds something it wrote stale (section
4.4), or when one of its streams has a queued event, and not otherwise, as
only the structure "sufficient to resolve the demanded values and the
queued events" is loaded today
([serving loop](../server-side-execution/serving-loop.md), §1).

### 4.2 Why per path

The keep set of an instance is stored in several documents: the result
document, and a part document for each kept subtree that the rule about
size splits off, such as a row of a kept collection or a node of the
rendered tree. `execution-and-storage.md` §4.10 owns that rule. Demand does
not depend on it.

- **Demand is per kept output path, whichever document stores the path.** A
  reader names the result cell and a path, and demands the kept paths it
  reads and so the cone instances that compute them. A session that lists
  pieces by name reads each result's name and not its rendered tree, and
  causes the cone for the name to be evaluated and no cone of the tree. A
  reader of one row demands that row's element cones and no other row's.
- **Why not per document.** Whether a subtree has a document of its own is a
  function of its size, which is a function of data. A count per document
  would make which cone instances are evaluated depend on the split, and
  would make a whole result document demanded whenever any path stored in
  it is read.
- **A watch on a part document.** A runtime that has resolved a path may
  subscribe to a part document by its own address. Where a session's watch
  names a part document, the scheduler maps it to kept paths: the `result`
  link at the part's root gives the instance, and the `within` steps and
  the path stored there give the kept path of the part's root
  (`execution-and-storage.md` §4.10). The watch then demands the kept paths
  below that root that its schema reaches. A part's envelope is complete
  for its paths (`plan-and-label-templates.md` §2.3), so a session that is
  served a part document by its address is served every path under the
  label a read through the result consumes.
- **A client decides no split.** A speculative transaction writes overlay
  entries per kept path (section 11.6), and a client reads whatever
  arrangement the server stored.

### 4.3 How demand propagates through links

Demand on a kept output, or on a write edge of a cone, is demand on the
cone instance that computes it. From there it follows what that cone
instance's last evaluation read: its slots, the addresses its `dynamic`
nodes registered, and the outputs of other cones it pulled.

1. For each slot and each registered address, the writer map gives the unit
   that writes the bound address, and for an instance the cone and the kept
   output or write edge, if a loaded unit writes it.
2. That output's or edge's demand count is raised by one. If it went from
   zero to one, the step repeats from its cone instance.
3. If the writer is in an instance that is not loaded, section 4.4
   applies: demand that stands loads the instance, and demand held for a
   read consults the basis index first.

So demand reaches, for one path of a consumer, exactly the cone instances
of the producers that path reads, and no other cone instance of those
producers. Three cases of step 1 are worth naming.

- A slot whose path crosses a link to an output of another instance is
  bound to that output, and the writer is that instance's cone.
- A child's `argument` slot is bound to a path of its argument document,
  and the writer is the `WriteEdge` with target `argument` of the cone of
  the parent, or of the computation that made the instance (section 2.7).
- A slot bound to a cell that a cone side-writes, a state cell or a cell
  reached through a handle, has that cone's write edge as its writer.

A slot's value is supplied when the value function first asks for it, and
a slot the function does not ask for is not recorded as read
(`execution-and-storage.md` §2.2). A branch that was not selected therefore
reads no slot, and its producers are not demanded, which is what marking
both branches of `ifElse` opaque achieves today.

A registered address of a `dynamic` node carries demand one evaluation
late, like its entry (section 3.4): the reads of one evaluation decide
which producers are demanded for the next.

**Maintenance.** Counts change only when an edge or a source changes: a
selection changed which slots a cone instance reads, a slot was rebound, a
dynamic node registered other addresses, a source appeared or went away. A
change of value alone changes no count. Granting is incremental.
Withdrawing can leave a cycle that holds itself demanded, so a withdrawal
derives the counts again over the region upstream of the output that lost
demand, as Scheduler v2 §5.2 specifies and `dependency-graph.ts` implements
for nodes. The algorithm is unchanged, with kept outputs and write edges in
place of nodes.

### 4.4 Loading on demand

When demand reaches an address that no loaded unit writes, the scheduler
looks at the document the address is in. Its metadata can name a pattern
instance that is not loaded: the address is a path of a result cell whose
result document holds a pattern reference, or it lies in a document with a
`result` back-link to such a result document, as a state cell document
has. A cell that an instance that is not loaded writes through a handle
names that instance nowhere, so demand on it loads nothing and a read of
it returns what is stored. The same holds for a path of a child's argument
document that a cone of the parent writes, or a cone of the computation
that made the instance: the argument document is linked from the child's
result cell and names the child, and nothing stored leads from it to the
instance whose cone writes it. Both are *assumed* (question 57 of the
continuation plan, which records the first; open question 39). What
happens for a named instance depends on the demand.

- **Demand that stands** loads the instance: a session's tracked set, a
  render sink, an effect operation, a materializer, a warm request, and
  the registered addresses and slots of a cone instance that one of these
  demands (section 2.5). The scheduler has to learn of later changes to
  the instance's inputs, and it learns of them through the entries of a
  record. The compiled pattern is fetched by identity (section 10.5), the
  record is built, and the basis rows are compared with the current heads
  to mark the stale cone instances. The demand then continues into the
  instance. This is the demand pass's structure load of today, without a
  step that starts a piece.
- **Demand held for a read** consults the basis index first, by ruling: an
  event's transaction, which holds demand on what the handler reads for
  its length, and a one-shot pull. The check of section 10.4 ("A read
  answered from the rows") says whether the stored value is current. Where
  it is, the read returns it, and the instance is not loaded. Where it is
  stale, the instance is loaded as above and the stale cone instance that
  writes the address is evaluated before the read returns. Sections 5.2
  and 5.3 say when that happens for a handler: before the transaction
  opens for a static read, and after a withdrawn attempt for a journaled
  one.
- **A journaled read of a cone instance in a derivation transaction** does
  not wait in either case. The read returns what is stored, and the
  address is registered for the `dynamic` node (section 3.4). A registered
  address carries the demand of its cone instance (section 4.3). Where
  the basis index shows the address current, nothing more is evaluated,
  and the instance is loaded only where that demand stands, by the first
  item. Where it shows the address stale, the instance is loaded, and the
  stale cone instance that writes the address is evaluated in the same
  transaction if the load completes without a wait, and otherwise in the
  derivation transaction of the change of demand that the completed load
  is (section 4.5). Its write matches the registered address, so the
  reading cone instance is stale, the address is a trigger read, and the
  reading cone instance is evaluated again, under the bound of section
  8.1. This is the one-evaluation-late rule of section 3.4, which a cone
  instance follows for a read inside an invalid materializer's envelope
  as well (section 7.3). A body inside a cone may be evaluated any number
  of times, so the stored value can be handed to it and corrected. A cone
  instance that is evaluated in an event's transaction follows the
  handler's rule (section 5.3).

Three kinds of instance are not loaded in any of these ways.

- **An instance marked as torn down** (section 2.7). The setup record of
  its result document holds the mark. Demand that reaches it evaluates
  nothing, and the reader reads the values last stored.
- **An instance whose setup record the builder path wrote.** It is migrated
  first, or it runs on the builder path (section 10.8).
- **An instance in another space** (section 9.2).

### 4.5 A change of demand is a cause

An output that becomes demanded may be stale: its instance was just loaded
with rows behind the heads, or its slots were marked dirty while nothing
demanded it. It may also be unstored, or reached by a label-dirty slot. It
has to be brought up to date, and no event, storage change, or effect
completion has occurred. A change of demand is therefore a cause of its
own, the fourth kind, by ruling. Its transaction is a derivation
transaction. It evaluates the stale cone instances the new demand reaches
and stores the kept outputs that changed. It runs as the demanding
principal, for the scope instances of that principal: on the serving
runtime, the principal whose session's demand changed
([serving loop](../server-side-execution/serving-loop.md), §3c).

A change of demand can also reach a stale cone instance of space scope. It
is evaluated once, with the context every evaluation of space scope has
(section 10.3), and what it stores is read by every session. Who demanded
it does not enter its evaluation.

Demand is already listed as a channel the design accepts
(`plan-and-label-templates.md`, §5.5): whether an output is current depends
on whether something demands it.

### 4.6 What an undemanded instance does when its inputs change

Nothing is evaluated, read, or written. What is recorded depends on whether
the instance is loaded.

| State | On a change to an input | What makes it correct later |
| --- | --- | --- |
| Not loaded | Nothing | Its basis rows stay at the sequence numbers of its last evaluation. Loading finds the heads ahead of them and marks the cone instances stale |
| Loaded, output not demanded | The slot is marked dirty or label-dirty in the record, and trigger reads accumulate for dynamic nodes | The cone instances that read the slot are stale. The derivation transaction of the cause that next demands the output evaluates them. Their basis rows are not advanced meanwhile |

In both states the stored kept output keeps the value and label of its last
evaluation, and a reader that follows a link to it without creating demand
reads that. `plan-and-label-templates.md` (open question 4) leaves undecided
whether such an output should carry a mark saying it may be stale. This
document does not need the mark: every reader the scheduler knows about
creates demand that loads the instance, or has the basis rows checked
before its read returns (section 4.4). Section 9.2 names the reader it
does not know about.

### 4.7 Releasing demand

A source releases what it holds when it ends: a session closes or its
tracked set is evaluated again, a render sink is removed, an effect operation
loses its own demand, a pull resolves, an event's transaction ends, an
instance is torn down (section 2.7). Counts are lowered by the withdrawal
of section 4.3.

An instance whose last demanded output was released stays loaded until the
runtime releases its record. Releasing a record is always safe, because the
record holds nothing the basis rows and the stored documents do not allow to
be built again. It discards the in-memory dirty marks and the record of
unstored writes, which is sound because the rows were not advanced for
them: the cone instances are found stale when the instance is loaded again.
A refusal that was recorded is discarded with it, so the write it refused
is attempted once more and refused again. When to release is a matter of
memory and is decided with the memo's retention
(`execution-and-storage.md` §3.3).

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

**The batch.** Several events are handled in one batch, by ruling. The
batch of a cycle is the events in the space's queue when the cycle begins
to handle events, together with the events that their handlers send to
streams of the same space, which join the queue when the sending
transaction seals. The batch ends when the queue is empty or the cycle's
budget is reached
([serving loop](../server-side-execution/serving-loop.md), §3). Each event
of the batch has a transaction of its own (section 5.2), and one derivation
transaction runs behind the batch (section 10.2). On a runtime with no
serving loop a batch is the events queued when the runtime begins to handle
them, and a batch of one event is the common case.

**What a stream document holds, and who creates it.** A stream document
holds the entries of the events appended to the stream and its
`eventWatermark`, as today, and nothing else. It is created by the first
event appended to it. No transaction writes a stream document when a
binding comes to exist, so a binding that never receives an event has no
document (`execution-and-storage.md` §4.7).

**Today: from a queued event to its handler.** Server-primary execution
stores no index from a stream to its piece. It follows back-links that
setup stored, and then starts the piece. Activation has no step that
starts the pieces of a space
([serving loop](../server-side-execution/serving-loop.md), §1): a piece
is started when a queued event or a demanded value needs its structure,
and both go through the same function (`ensurePieceRunningVerdict`,
which `#attemptStructureLoad` of `SpaceServer` calls for a demanded
root).

- **What is stored.** A stream is a cell of its piece, with a document of
  its own. Setup creates that document and writes a `result` back-link on
  it, as on every internal cell of the piece (`setResultCell` in
  `runtime/runner/src/result-utils.ts`, called by
  `#materializeDerivedInternalCells` in `runtime/runner/src/runner.ts`).
  The piece's result document holds the pattern reference
  (`patternIdentity`). The events of the stream are entries of a second
  document, whose identifier is a hash of the stream's link
  (`streamEntriesDocId` in `runtime/memory/v2.ts`), and each entry names
  its stream by that link (`StreamEventEntry.stream`).
- **Finding the pending entries.** The drain lists the entries documents
  that hold an entry past their `eventWatermark`, by a scan of the document
  heads of the space (`selectPendingStreamEventDocs` in
  `runtime/memory/v2/engine.ts`). It brings each entries document and the
  document of each stream into the replica, and queues each entry under
  the link of its stream (`#drainStreamEvents` of `SpaceServer` in
  `runtime/runner/src/executor/space-server.ts`).
- **A piece that runs.** The scheduler holds the handlers of the pieces
  that run in a registry keyed by the stream's link (`EventHandlerRegistry`
  in `runtime/runner/src/scheduler/events.ts`). An event whose stream has a
  handler there is queued with it (`queueSchedulerEvent`).
- **A piece that does not run.** An event whose stream has no handler
  takes its place in the queue at once and holds it (`handlerLoadPending`)
  while the scheduler starts the piece (`startEventPiece`, which calls
  `ensurePieceRunningVerdict` in
  `runtime/runner/src/ensure-piece-running.ts`). The start reads the
  stream's document and follows `result` back-links, over at most ten
  hops, to a document that has none (`followResultCellChain`). It reads
  the pattern reference there and loads the pattern by its identity. On a
  serving runtime it then reads the piece's argument document, follows the
  back-links of every document of the same space that the argument links
  to, and starts the pieces those documents belong to first
  (`startInputSources` and `inputSourcesOf`), so that a stream of a nested
  instance starts the instance that encloses it. Then it starts the piece
  (`Runtime.start`), which registers a handler for each stream of the
  piece (`#instantiateJavaScriptHandlerNode` in
  `runtime/runner/src/runner.ts`, through `addSchedulerEventHandler`). The
  scheduler looks the stream up in the registry again and gives the
  waiting event the handler it finds.
- **A piece that cannot be found or started.** A piece that started with
  its graph installed and registered no handler for the stream makes the
  event unrunnable: the entry records the dropped-event notice, and the
  `eventWatermark` passes it. Every other outcome defers the event: a
  chain that cycles or is longer than ten hops, a document at the end of
  the chain that holds no pattern reference, a pattern that cannot be
  loaded, a start that throws, and a piece whose graph is not installed.
  The entry stays pending, every later entry of the space waits behind
  it, and a later cycle drains it again. Each deferral counts against a
  budget of eight (`EVENT_DEFERRAL_DROP_THRESHOLD` in
  `runtime/runner/src/scheduler/constants.ts`), after which the event is
  dropped. A deferral counts nothing while an earlier entry of the space
  is still pending, because that entry's handler may be what creates the
  piece. A pattern whose program the space does not hold yet is waited
  for, and its absence ends in a `needs-attention` notice
  ([events](../server-side-execution/events.md), §5).
- **What it costs.** One event on a stream of a piece that does not run
  loads the entries document, the stream's document, each document on the
  back-link chain, the pattern's program, the argument document, the
  chain of each document the argument links to, and the pieces found that
  way, each started whole.

**What this design keeps, and what it cannot keep.** The entries, the
drain and the queue are unchanged: how the pending entries are found, the
order they are queued in, the place an event takes in the queue before
its handler is known, the registry in memory from a stream to its handler,
the pattern reference of the result document as what names the code to
load, and what becomes of an event that cannot be routed. Two steps have
no counterpart.

- **The walk has no document to start from.** A stream identifier of this
  design is a hash over the instance, the binding, and the element keys
  (`execution-and-storage.md` §5.2 and §5.5), and it cannot be inverted.
  The one document it names is the stream document, which does not exist
  before the first append, and that append is a client's commit in the
  common case. A back-link would have to be written when the binding
  comes to exist, in a document per binding of each element, which is the
  cost `execution-and-storage.md` §4.7 removes: a message row of
  FabriChat has at least eleven handler bindings today, each with a
  stream document and an argument document (§4.9 there).
- **A load does not register every stream.** Today a start instantiates
  the piece's graph, each row of a collection is a piece of its own, and
  so a start registers every stream. Loading a compiled instance
  evaluates nothing (section 4.4). It can compute the identifier of a
  stream whose binding is outside every element body, from the result
  cell and the plan. It cannot compute one that holds an element key or
  what a binding made in a function body holds, because those come from
  evaluation.

**The stream index.** By ruling, an event is routed to an instance that is
not loaded through a stream index. The serving runtime keeps one row per
stream of a compiled instance, in the space's store, beside the basis
index (section 10.4). The index is needed for the two steps above and for
nothing else. A row takes the place of the `result` back-link on the
stream's document and of the walk that follows it. For a stream whose
identifier a load cannot compute, it also takes the place of the
registration that a start makes today.

| Column | Holds |
| --- | --- |
| The stream | The stream document's identifier |
| The instance | The result cell's identifier |
| The binding, for one of the reactive tier | `Binding.name` and the steps of `within`, with the key of the element at each `element` step |
| The binding, for one made in a function body | The handler, as `Body.code` or the content address of a factory value, and the identifier of the binding state document |

- **When a row is written.** In the store transaction of the wave whose
  transaction first computed the stream's identifier, or of the setup
  transaction that did (section 10.8). For a binding outside
  every element body that is the first evaluation of a cone whose output
  holds the stream. For a binding in an element body it is the evaluation
  that adds the element's key. For a binding made in a function body it is
  the transaction that stages the binding state document. A link to a
  stream is stored only by a transaction that computed the identifier, so
  every stream a stored link names has a row.
- **When a row is deleted.** When its element key leaves the collection,
  and when its instance is torn down (section 2.7) or retired. A source
  update deletes no row: a stream identifier holds no compiled identity,
  so the row still names the stream.
- **What it is.** Identifiers only, overwritten in place, written inside the
  wave's store transaction or a setup transaction's, never pushed to a client,
  and never read at admission. Those are the properties of a basis row. Only
  the scheduler of the space's serving runtime reads it. Where the runtime
  shows a row in a diagnostic or to a tool, it shows it under the label
  `plan-and-label-templates.md` §2.6 gives a row of the stream index ("Rows
  beside the documents"), which is an assumption there.
- **The registry comes first.** The scheduler keeps the registry in memory
  from a stream to its binding, as today. A loaded instance's streams are
  entered in it when the instance is loaded, for the bindings outside
  every element body, and when a transaction of this process computes a
  stream's identifier, for the others. A row is read only for a stream
  that is not in the registry.

**From a queued event to its handler.** The steps are today's, with a row
in the place of the walk.

1. The stream is looked up in the registry. A stream found there has its
   binding, and its instance is loaded.
2. Otherwise the event takes its place in the queue and holds it, as
   today, and the scheduler reads the row. The row gives the instance,
   which the scheduler loads if it is not loaded (section 4.4), and the
   binding, which it enters in the registry. One row is read and one
   instance is loaded. No document is read to find the instance, and no
   other instance is started on the event's account: the instances that
   write what the handler reads are loaded only where what they wrote is
   stale (section 5.3), which takes the place of starting the pieces a
   piece's inputs come from.
3. For a binding in an element body, the element keys of the row name the
   cone instances the handler's `binding` slots resolve to, and the
   collection's membership is evaluated before the handler body, like any
   stale cone instance the handler reads, so that the positions that hold
   the key are known. The stream is per key and not per position, and two
   positions can hold one key (`plan-and-label-templates.md` §1.3). The
   handler's element slots are bound at every position that holds the
   key, and each resolves to the join over those positions. The value is
   the same at each of them, because they hold equal values or link to
   one cell, and the label is the join of the labels the positions give.
   The join is *assumed* (open question 27 of that document; question 40
   of the continuation plan; open question 37 here).

An event that cannot be routed is treated as today.

- **No row.** An event on a stream that has no row cannot be routed yet.
  A client can derive the identifier of a stream before the server has
  evaluated the binding (section 11.1), and the binding can come to exist
  in more than one way. A handler of an earlier event adds a row to a
  collection. Or a commit that is not an event does: an input the user
  typed, a change another space pushed, or the completion of an effect.
  In each case the client's speculative run renders the control and the
  user acts on it, and the event can reach the server in the drain that
  holds the commit, before any transaction has evaluated the binding.
  Such an event is deferred, by ruling, as an event is deferred today
  whose piece cannot be started yet
  ([events](../server-side-execution/events.md), §5). It is not dropped
  at once: a stream with no row is the counterpart of a piece that may
  still start once another writer's commit lands, and not of a started
  piece that registered no handler.
  - The entry stays pending, and the events that arrived after it in the
    space are deferred with it, so the order of section 5.4 holds. The
    batch of that cycle ends before it.
  - The derivation transaction behind the batch evaluates the binding,
    where a session that rendered the control demands it, and the wave's
    store transaction writes the row.
  - The entry is drained again on the next input of the space and when a
    wave writes a row for its stream. Where neither happens, it is
    drained again on the backstop tick the drain arms today
    (`#armDeferredRescan` of `SpaceServer`).
  - A deferral counts against the deferral budget of that section, which
    is eight (`EVENT_DEFERRAL_DROP_THRESHOLD`). It counts nothing while
    an entry that arrived earlier in the space is still pending, because
    that entry's handler may be what creates the binding
    (`#anyStreamEntryPending`, called from the failure callback that
    `#drainStreamEvents` of `SpaceServer` gives each queued entry). The
    earliest pending entry always spends the budget.
  - When the budget is spent, the event is dropped: the entry records
    the dropped-event notice, and the `eventWatermark` passes it.
- **A key no position holds.** An event on a stream of an element whose key
  left its collection is unrunnable, and is dropped in the same way.
- **A binding the plan does not have.** After a source update, a row can
  name a binding that the plan the instance runs does not have. An event
  on its stream is unrunnable.
- **An instance that is marked as torn down,** or whose result document
  holds no pattern reference. The event is unrunnable (section 2.7).
- **An instance that cannot be loaded yet.** A load that waits for a
  compiled pattern or for a migration holds the event's place in the
  queue (sections 10.5 and 10.8). A load that fails defers the event with
  the events that arrived after it, under the deferral budget of
  [events](../server-side-execution/events.md) §5, and a compiled pattern
  the space does not hold yet is waited for as a program is today.

The alternative to the index is a document per binding written at setup
with a back-link, as today. It costs one document for each binding of
each element, where the index costs one row
(`execution-and-storage.md` §4.7 states that cost). What remains for the
prototype is the size of the index (open question 26).

### 5.2 One transaction per event

An event is a cause, and it has one transaction. The transaction has the
two parts `plan-and-label-templates.md` §5.4 defines: the stale cone
instances that compute what the handler reads, and the body. It holds no
other derivation. The cone instances that the body's writes made stale are
evaluated before the body of a later event of the batch that reads them,
or once, in the derivation transaction behind the batch (section 10.2).
What is evaluated in each part for one instance is
`execution-and-storage.md`'s (§1.2 to §1.4). This section states what the
scheduler does around them and across instances.

Before the transaction opens:

1. **Resolving the handler.** The stream gives the instance and the binding,
   from the registry or from its row of the stream index (section 5.1),
   and the instance is loaded if it is not. The binding gives the
   handler: a body of the instance's plan, or a compiled handler named by
   a factory value, whose record is fetched by content address
   (`plan-and-label-templates.md`, §3.21).
2. **Loading.** The documents the handler's bound slots name are brought into
   the replica. A slot of `Body.reads` whose path holds `*` is bound here, at
   each child its path reaches (section 3.2). Where an instance that is not
   loaded writes one of them, the basis index decides whether it is loaded, by
   ruling: it is loaded where the address is stale, and not where the stored
   value is current (sections 4.4 and 10.4). The scheduler follows the
   handler's static reads upstream through the loaded cone instances that write
   them, as demand does (section 4.3), and makes the same check at each address
   it reaches whose writer is in an instance that is not loaded. The event
   holds its place in the queue while that I/O runs, and the load's completion
   queues the next step. Nothing polls. All of this happens before the
   transaction opens, so no attempt is withdrawn on account of a static read.
3. **Materializers.** If the bound address of one of the handler's `reads`
   slots lies inside the envelope index, under an entry of an invalid
   materializer, that materializer runs first, in its own transaction
   (section 7.2). Where it cannot be promoted, the event waits until it
   has run, as that section says.
4. **Lineage.** An event whose origin transaction committed in another space
   waits until that commit is confirmed, as today (Scheduler v2 §7.6).

Then the transaction opens, and the `event`, `binding`, and `cause` slots
are bound.

**What the `binding` root resolves to.** It depends on where the binding
was made (`plan-and-label-templates.md` §3.14).

- **A binding of the reactive tier copies nothing.** The reactive tier is
  the pattern body and everything compiled in it, the body of a
  per-element callback included. Every path of the handler's state resolves
  through `Binding.state` to a slot or an output of the instance. Where the
  path is an output, the cone instance that computes it is evaluated before
  the body when it is stale, and its value is materialized into the
  handler's argument when the event is delivered. The body therefore sees
  the value as of the event. In
  `list.map((el) => … action(() => otherList.push(el)))`, written in a
  pattern body, the state path for `el` is the element's slot, so the
  handler is handed the reference to the element and the push stores a
  link to the original.
- **A binding made in a function body** resolves through its binding state
  document. A copied path, a scalar or a container the body computed,
  holds a value, and no cone instance computes it. A path that holds a
  link, to a cell or to a container bound by reference, is a slot whose
  path crosses the link. The handler reads the target when the event
  arrives, in the event's transaction, and a stale cone instance that
  writes the bound address is evaluated before the body.

**Before the body.** The scheduler evaluates the stale cone instances that
compute a slot of `Body.reads` or an entry of `Body.computed`, the ones an
earlier event of the batch made stale included, each with the cone
instances it depends on, in whichever instance of the space they are. A
slot of `Body.reads` includes a static read through a handle (section
5.3). The handler's reads hold demand for the length of the transaction
(section 2.5).

**The derived writes the handler depends on are checked first.** A handler
body is not run again when a constraint drops a write. So neither the
body, nor a cone instance whose value the handler receives, may have read
a value that a later check drops. The following derived writes of this
transaction are therefore instantiated, and their constraints checked,
ahead of the rest of the preparation (`plan-and-label-templates.md` §4.5
and §4.6; `execution-and-storage.md` §1.6). This is the **early step**.

- Every derived write staged at an address that a slot of `Body.reads` is
  bound to.
- Every derived write staged at an address that was read by a cone
  instance whose value the handler receives, directly or through any
  number of `output` edges. A value the handler receives for a state path
  that names an output of its own instance is not read by address: the
  handler's template holds the output's template, and the handler
  receives the computed value whether or not the output's write is
  stored. But the cone instance that computed it read addresses, and a
  write staged at one of them is among these.
- Every derived write staged at an address that a journaled read of the
  body reaches.

The first two are checked after the cone instances above were evaluated
and before the handler's argument is built, and the third before the
journaled read returns. Each is instantiated after the staged writes it
uses, which are checked first. A write the check drops is unstaged
(section 3.5). A cone instance that had read the dropped value is stale
again and is evaluated again, against what is stored, before the argument
is built or the read returns. The body then reads what is stored, and
every value the handler receives was computed from writes that passed
their checks.

**An unstored output that the handler reads.** A kept output can be
unstored while its cone instance is current: an earlier transaction
computed it and did not commit (section 3.5). Nothing is stale, so nothing
would be evaluated, and the stored value was computed before the change
that the unstored value holds. Where such an output carries no refusal and
lies at an address of one of the three kinds above, it is staged from the
memo before the read, and it is then a derived write of this transaction
that the early step instantiates and checks. An unstored output that
carries a refusal is not staged, and the reader reads what is stored, as
for a write the early step dropped.

**The body** runs once. Its writes are matched against the index as they
are staged (section 3.5). When it returns, its requests are performed, the
transaction is prepared, and it seals. What a cone instance staged before
the body is a derived write of this transaction: a kept output, a
side-write, a path of a child's argument, or a path of an effect's
request. If the body wrote something that cone instance had read, the cone
instance is stale, and the derivation transaction behind the batch
evaluates it again. What becomes of each write it staged depends on
whether the early step instantiated it (`execution-and-storage.md` §1.6).

- A write that was not instantiated early is withdrawn before the
  preparation. Its label would otherwise be instantiated from the label
  the body staged, for a value computed from what was there before. Where
  the write is a side-write, the memo entry of the cone instance is
  dropped, so that the later evaluation performs it (section 3.5).
- A write that was instantiated early was instantiated from the labels
  its value was computed under, and the handler's own writes use it. It
  commits with the event's transaction under that label.

### 5.3 What the static read closure allows

Today the scheduler computes a handler's read closure by a deep read under
the handler's schema in a separate read-only transaction, finds the invalid
nodes upstream of it by walking down from the set of invalid nodes
(`collectInvalidUpstreamForLog` in
`scheduler/event-preflight-dependencies.ts`), runs them in their own
transactions, and parks the event while any of them is held by a time gate.

In this design the handler's `Body.reads` are slots of the plan and its
`Body.computed` are outputs of cones, and the cone instances behind them
are known without reading anything. Four things follow.

- **No preflight transaction.** The stale cone instances the handler reads
  are evaluated inside the event's transaction, before the body, by the
  pull that a read of a demanded output is. The handler's reads hold demand
  for the length of the transaction (section 2.5), so cone instances
  nothing else demands are evaluated for the handler and not stored unless
  they are kept and changed.
- **A static read through a handle is a slot.** A read through a handle the
  body was given at a static place, at a static path, that every run that
  returns normally makes, is an entry of `Body.reads` whose path crosses
  the handle's link (`footprint-analysis.md` §7.2). It is bound, watched
  and made current before the body like any slot.
- **No parking on time gates.** A cone instance has no gate. One that does
  not converge takes an error state (section 8.1), and a handler that reads
  it fails, as `plan-and-label-templates.md` §5.4 says. The remaining
  reasons an event waits are a load in flight, a materializer that has to
  run first (section 7.2), an unconfirmed origin in another space, and a
  stream with no row (section 5.1). Each ends on a notification. An event
  deferred for a stream with no row is drained again by today's backstop
  tick as well, which is what spends its budget when no input arrives.
- **A read through a handle of `Body.handles` is not known before the body
  runs.** That is a read on some runs only, a read at a path the body
  computes, a read through a link the body finds in data, and a read
  through a handle whose formal input is bound to a value the instance
  computed. Nothing is evaluated ahead of the body on account of such a
  handle. Its read envelope narrows what a read through it returns
  (`footprint-analysis.md` §7.3) and gives no order.

**A journaled read is made current at the read.** Before a read through a
handle of `Body.handles`, or through a link the body follows, returns, the
runtime looks the address up in the writer map
(`execution-and-storage.md` §1.4). What happens depends on the writer.

| The address is written by | What happens |
| --- | --- |
| No loaded unit, and the document of the address names no instance that is not loaded | The read returns what is stored or staged |
| A stale cone instance of a loaded instance of the same space | It is evaluated first, inside the transaction and under the bound of section 8.1. Its write to the address is instantiated and checked before the read returns (section 5.2). The read then returns what it staged, or what is stored where the check dropped the write |
| A current cone instance of a loaded instance of the same space, whose kept output at the address is unstored and carries no refusal | The output is staged from the memo, and instantiated and checked before the read returns (section 5.2). The read then returns it, or what is stored where the check dropped the write. Nothing is evaluated |
| An instance of the same space that is not loaded, where the basis index shows the address current | The read returns what is stored, with the label stored there. The instance is not loaded, and the event holds no demand on it |
| An instance of the same space that is not loaded, where the basis index shows the address stale | The attempt is withdrawn whole, the instance is loaded, and the event is dispatched again under the same handling. The event holds demand on the instance until its transaction ends, so the second attempt finds it loaded and evaluates the stale cone instance at the read, by the second row |
| An invalid materializer, by an entry of the envelope index | The attempt is withdrawn whole, the materializer runs, and the event is dispatched again under the same handling. Where the materializer cannot be promoted, the event waits until the derivation transaction and the materializer have run (section 7.2) |
| An instance marked as torn down, or an instance of another space | The read returns what is stored (sections 2.7 and 9.2) |

Nothing of a withdrawn attempt is committed, and what it leaves in the memo and
the instance record is what any transaction that does not commit leaves
(section 3.5). Every cell, instance and effect the handler requests is named by
the handling and its order among the handler's requests, so the next attempt
names the same things. Each withdrawn attempt loads an instance or runs a
materializer that the attempt before it did not have, so the attempts end.

**A writer in an instance that is not loaded.** The third and fourth rows
are the ruling: the scheduler's stored record of what is stale decides,
and the instance is loaded only where the stored value is stale.

- **Which reads are checked.** Every journaled read looks the address up
  in the writer map, as it does for the other rows. The basis index is
  consulted only where the map has no entry and the document of the
  address names an instance that is not loaded: the address is a path of
  that instance's result cell, or lies in a state cell document of it
  (section 10.4, "A read answered from the rows"). A read of a document
  that names no instance, of an instance marked as torn down, or of
  another space consults no row. A cell that an instance that is not
  loaded writes through a handle is attributed to that instance by
  nothing stored, so a read of it returns what is stored. So is a path of
  a child's argument document whose writing instance is not loaded: the
  document names the child and not the instance whose cone writes the
  path. A handler of a child that an event loaded while its parent is not
  loaded therefore reads a computed argument path as stored, and the rows
  of the parent's cone are not consulted. Section 4.4 has the same limit
  for demand.
- **What is consulted.** The basis rows of the cones of that instance
  that write the address and of the cones they depend on, and the rows of
  the instances whose outputs those cones read, as section 10.4 states
  it. The address is current when every one of those rows holds the
  sequence number its input document has now. That is the definition of
  the Terms and of section 10.4, by which the rows decide in a process
  that holds no memo entry, and it is what loading the instance would
  find: a load marks the stale cone instances from the same rows (section
  4.4). A write that did not reach storage left its rows behind (section
  3.5), so an unstored output is found stale.
- **The check loads no instance.** It builds no record, binds no slot,
  enters nothing in the address index or the writer map, fetches no
  compiled pattern, and evaluates nothing. It reads rows, heads, and the
  metadata of the documents the rows name.
- **What it costs.** A read whose address the writer map holds costs the
  lookup and no more. A checked read costs, beside it, one range of the
  index per consulted cone and scope instance and one head per row. The
  verdict for an instance is kept for the length of the transaction, and
  is dropped when the transaction stages a write to a document the
  verdict consulted, so a body that reads several paths of one instance
  pays for one check.
- **The current case.** The stored value is the one the writer's last
  evaluation stored, and nothing that evaluation read has changed, so the
  read returns what it would return if the instance were loaded. What a
  handler reads therefore does not depend on which instances other
  sessions happen to have loaded.
- **The stale case** keeps the withdrawal. The documents give no cheaper
  sound rule for a handler. Its body runs once, so it cannot be handed
  the stored value and evaluated again when the writer has been
  evaluated, as a cone's body is (section 4.4). And a load is I/O, which
  a body suspended at a read does not wait for: a body can be suspended
  while a cone instance is evaluated (`execution-and-storage.md` §1.4),
  and not while a record is built from documents the replica may not
  hold. The cost is one more run of the handler for each instance whose
  stale output a journaled read discovers (open question 28).
- **A cone instance evaluated in the event's transaction,** before the
  body or at a read of the body, follows the same two rows for its own
  journaled reads: the body that waits for its value runs once.
- **A runtime that keeps no basis index,** such as a client (section
  11.1), has nothing that says whether the stored value is current. There
  the stale case applies.

### 5.4 Ordering guarantees

- Events of one stream run in the order of their entries.
- Events of different streams of one space run in arrival order.
- No order is promised across spaces.
- A handler never reads a value that an earlier event of its space was
  going to change: the earlier event's transaction has sealed before the
  later one opens, and the stale cone instances the later handler reads,
  the ones the earlier event made stale included, are evaluated before its
  body.
- A storage change with a lower sequence number than an event is reflected
  in what the handler reads, because the cone instances it made stale are
  evaluated in the event's transaction before the body reads them.

**Derivations settle once behind the batch.** Today the serving scheduler
runs the handlers of several ready events back to back and settles the
derivations once behind all of them (`Scheduler#processExecuteEventPhases`
in `scheduler/facade.ts`). The ruling keeps that: every derivation the
batch made stale that something demands is evaluated once, in one
derivation transaction behind the batch, and not once per event. A body
that reads a whole collection is evaluated once per burst of events.

Two things follow for what is observable.

- **No derived output is computed from a state between two events of a
  batch,** apart from what a later handler of the batch reads. A derived
  output is computed, labeled and checked against the state after the
  whole batch (`plan-and-label-templates.md` §5.4).
- **How many events a batch holds depends on arrival times.** It decides
  which states are derived from, and `plan-and-label-templates.md` §5.5
  lists it with the residual channels.

### 5.5 Rejection, failure, and conflict

| Outcome | What happens to the event | Retried |
| --- | --- | --- |
| A constraint fails on what the handler itself writes | The event's whole transaction is rejected: the handler's writes, its requests, and the derived writes staged before its body. The refusal is the event's consequence: the entry records the error, the stream's `eventWatermark` passes it, and the outcome is reported to whoever delivered the event, with the handler's template as its label ([events](../server-side-execution/events.md), §5). The other events of the batch are not affected | No. The verdict is a function of labels and selections |
| A constraint fails on a derived write, in the event's transaction or in a derivation transaction | That write is dropped alone, and the rest of the transaction commits (section 5.6). The event is not affected | Not while the instantiation key of the write is the same |
| The handler body throws | The event's transaction is aborted: nothing the body staged exists, and the error is the consequence | No |
| A cone instance that the handler does not read fails before the body | Its outputs take an error state and the rest commits | No |
| A cone instance that the handler reads fails before the body | The handler receives an error state for that input and fails. The event's transaction is aborted, as for a body that throws, and the error is the consequence. Nothing the transaction staged is stored, and the error state of the failed cone instance is unstored (section 3.5) | No |
| A cone instance fails at the bound of section 8.1 | The same two cases. It is not evaluated again until one of its inputs changes | No |
| A recorded read of the handler is stale when the wave commits | The event is requeued whole and runs again once the replica holds the commit that made the read stale. Later entries of the same stream that sealed into the wave requeue behind it ([serving loop](../server-side-execution/serving-loop.md), §3d, where the rule is proposed and awaits a ruling) | Yes, on the arrival of that commit |
| A derived write conflicts when the wave commits | That write is withdrawn alone, with the derived writes that used what it staged. The rest of the transaction commits | The cone instance is evaluated again when the conflicting commit arrives and marks it stale. A write withdrawn for a conflict on its target alone is stored again from the memo |
| A withdrawal reaches the handler's own writes, because the handler read by address a value that a withdrawn derived write staged, or received a value that a cone instance computed from it | The event's transaction is withdrawn whole, and the event is requeued, as for a stale read of the handler | Yes, on the arrival of the conflicting commit |
| The handler body did not run to its end, because an input did not resolve or a journaled read reached a stale address of an instance that is not loaded or an invalid materializer (sections 5.3 and 7.2) | The transaction is withdrawn whole and the entry stays pending | Yes, when the document arrives, the instance is loaded, or the materializer has run |
| The handling's receipt exists already | The event was handled. The attempt is dropped | No |
| A deterministic refusal by the memory server: a refused access-list change, a refused write to another space | The refusal is the consequence | No |

Five points go beyond today's rules.

- **The handler's stale reads include what was evaluated before the body.**
  A handler that reads a derived value computed in its own transaction, or
  taken from a current memo entry, depends on that cone instance's reads.
  They are held to the store's heads with the handler's own reads, so a
  commit that changed one of them requeues the event
  (`execution-and-storage.md` §3.5).
- **A conflict on a derived write withdraws that write alone,** by ruling.
  A derived write is a pure derivation. When the document it targets, or
  something it was computed from, moved under the wave, that write is
  withdrawn, as a derivation's write is dropped today, and the handler's
  writes and every other derived write commit, except as the next point
  says.
- **The writes that used what a withdrawn write staged are withdrawn with
  it.** `plan-and-label-templates.md` §4.5 defines the relation: a write
  uses another when a label it was instantiated or checked with, or a value
  it was computed from by a read at an address, was staged by the other.
  The relation is transitive, and it crosses the transactions of a batch.
  The commit preparation records what it verified per unit of the
  preparation, the commit leaves out every unit that uses a unit it leaves
  out, and the prepared digest is over the units that commit. Nothing is
  instantiated or checked again, because no unit that remains used
  anything a unit that was left out staged
  (`plan-and-label-templates.md` §4.6). That document lists this reading of
  the ruling for the owner to confirm (its open question 28). A dropped
  write is used by no unit, which is what the check before a body's read
  secures (section 5.2).
- **A withdrawal that reaches a handler's own writes requeues the event.**
  Everything a handler itself stages for one event is one unit of the
  preparation. It uses a derived write when the body read by address a
  value that write staged: a kept output of another instance, or a cell a
  cone side-writes, that a cone instance wrote before the body, in this
  transaction or in an earlier transaction of the batch. It uses one as
  well when a cone instance whose value the handler received read the
  value that write staged, because the reads of the producing cone
  instance are reads of the handler's unit (`execution-and-storage.md`
  §1.9). When the commit
  withdraws that derived write, the handler ran against a value that is
  not stored, and the event's transaction is withdrawn whole. The event is
  then treated as an event whose own read is stale: it is requeued and runs
  again once the replica holds the commit that caused the conflict, no
  receipt is created, and later entries of the same stream that sealed
  into the wave requeue behind it. The handlings of the events it sent in
  the same cycle are undone with it, through the lineage of today.
- **What a withdrawn or dropped write leaves** is section 3.5: the output is
  unstored, its cone instance is current unless something it read changed,
  and the basis rows are not advanced. A dropped write among the units a
  withdrawal takes loses its verdict with them, so no refusal is recorded
  for it.

**The handling and its receipt.** A handling is one event on one stream,
and it is identified by its receipt, by ruling: the event's identifier and
the stream it was sent to (`handlingReceiptId` in
`scheduler/event-identity.ts`). The receipt leaves the acting principal
out, so one event on one stream is one handling whoever sends it. The
string `eventKey()` returns is a different thing: it also names the acting
principal (`deriveEventKey` in the same file). The receipt is the
handling's result cell, created under a create-only precondition, as
today. Every cell, instance and effect a handler requests without an
explicit cause is named by the handling and its order among the handler's
requests, and an event the handler sends by the handling and its order
among the events that invocation sends (`plan-and-label-templates.md`
§1.3). A binding a handler makes is not named by the handling: it is
identified by what it holds, like every binding made in a function body.

### 5.6 A constraint that fails in another instance

A failed constraint has one of two outcomes, by ruling, and which one
depends on whose write the constraint guards
(`plan-and-label-templates.md` §4.4).

- **On what a handler itself writes, the event's whole transaction is
  rejected.** What a handler itself writes is everything its body stages:
  its write edges, the arguments of the instances it requests, the requests
  of the effects it asks for with their egress ceilings, the copied state
  of the bindings it makes, and the copied parameters of the inline
  patterns it instantiates. The target of such a write can be in another
  instance, such as a cell the handler was handed.
- **On a derived write, that write is dropped alone.** A derived write is a
  kept output, or a write edge of a cone: a side-write, a path of a child's
  argument, a path of an effect's request. It makes no difference which
  instance computes it, or whether it was evaluated before a handler body
  or in a derivation transaction. The target keeps the value, the label and
  the provenance record that are stored, and the rest of the transaction
  commits, other outputs of the same cone instance included. No event is
  rejected because a derived output of some instance fails a constraint.

A cause that is not an event has derived writes only, so a failed
constraint never rejects a derivation transaction.

**What the scheduler does with a dropped write.**

- It matches the target's address again, with what is stored, so a cone
  instance that had read the staged value is stale again (section 3.5).
- It records the write in `InstanceRecord.unstored` with the refusal: the
  constraint, and the instantiation key of the write's template, which is
  the label identifiers of the slots the template reaches under the
  reported selections, with those selections
  (`plan-and-label-templates.md` §4.1, step 2). A constraint on a write,
  such as writer-fit or a write floor, lists no slot of its own, and its
  verdict is a function of that key.
- It does not advance the basis rows of the cone instance.
- It does not attempt the same write again while its instantiation key is
  the same, since the verdict would be the same. It attempts the write
  again when the key changes, in one of two ways. A slot the template
  reaches gets another label and keeps its value: the write is
  instantiated again from the memo's value, as for any label-only change
  (section 3.6). Or the cone instance is stale and is evaluated again,
  and the evaluation reports other selections or resolves another label.
  An evaluation that computes another value under the same key attempts
  nothing: the memo holds the new value, and the write stays unstored
  with its refusal.
- It reports the refusal on the scheduler's error channel with its
  structured details, as a terminal refusal is reported today. The refusal
  is a fact about labels and selections, and it is shown only where the
  label of an inspection of the output's label permits
  (`plan-and-label-templates.md` §4.4).

A consumer inside the instance that pulls the dropped output receives the
value the evaluation computed, and its own outputs are checked against
their own constraints. A consumer that reads the output through its stored
address reads the stored value and the stored label
(`execution-and-storage.md` §3.3).

## 6. Effects

### 6.1 An effect operation is a unit

The effectful built-ins are the class B entries of the inventory: the fetch
family, `fetchProgram`, `generateText`, `generateObject`, `llmDialog`,
`agent`, `sqliteQuery`, `navigateTo`, the compiling half of `compileAndRun`,
the resolving half of `cellFromUrl`, the staged access changes, and
`nameBlob`. Each request, apart from a `nameBlob`, is an effect operation,
and it comes to exist in one of two ways:

- **In the reactive tier**, as an `Operation` of kind `effect` of a plan. Its
  state document is named from the instance, the element keys, and the
  operation's name. The plan can be that of an instance a computation made
  (section 2.7).
- **In a handler**, as an occurrence of a `BodyCall` of kind `effect`. It is
  identified by the handling and its ordinal among the handler's requests,
  and it exists once the event's transaction commits. Its state document
  holds a back-link to the instance whose handler requested it, and while
  its request is pending it has a pending-effect row (section 2.3).

A `lift` or a `computed` requests no effect itself (*assumed*, question 38
of the continuation plan). It reaches an effect through a pattern it
instantiates.

The inventory's sentence governs both: requesting an effect "behaves like
instantiating a built-in pattern". An effect operation therefore has a
request, which is to it what an argument is to a child, a result, and
transactions of its own. It is never evaluated inside the transaction of
another cause.

The staged access changes are the exception in form. A handler requests
them and reads no result, and they have no completion: each is a step of
the commit of the event's transaction (section 9.4).

`nameBlob` is not an effect operation. It stages a content-addressed
document in the event's transaction, as a write of the handler
(`builtin-inventory.md`, "Staged changes"). It has no request transaction
and no completion, it is no step of the commit sequence, and it is no
unit.

### 6.2 The request

**In the reactive tier** a cone of the enclosing instance computes the
request. The request is not a kept output: nothing reaches it from the
result cell. Each path of it is a write edge of that cone with the target
`request`, and the derivation transaction that evaluated the cone stages
the path into the operation's state document, with the template of the
expression at that path (`plan-and-label-templates.md` §3.14;
`execution-and-storage.md` §6.4). This is how a computed argument of a
child is written into the child's argument document. The operation then
observes a stored, labeled request, and a change to it reaches the
operation through its index entry on the request path. The request is a
derived write, so a failed constraint on a path of it drops that path
alone.

**When an operation of a plan is demanded.** The demand rule is for an
`Operation` of a plan. Such an operation is demanded when something
demands a path of its result. It then holds demand on the cone instances
whose write edges stage its request, so that the request is current
whenever the result is wanted. A `navigateTo` written in the reactive tier
is made in order to act and has no result a pattern reads, so it is
demanded whenever its instance is. A request a handler makes waits for no
demand: every one is sent when its event's transaction commits ("In a
handler", below; `builtin-inventory.md`, "When an effect is demanded, and
its time gates").

**Who a request transaction acts as.** The request transaction of an
operation of a plan acts as the principal of the scope key of the cone
instance that staged the request, with the context an evaluation for that
scope key has (section 10.3). An operation whose request a cone instance
of user or session scope staged has one state document per scope key
(`execution-and-storage.md` §6), and each has a request transaction of its
own. A request a handler makes is part of the event's transaction, which
acts as the actor of the event.

A cone instance of space scope is evaluated for no principal, so a
request it staged has no requester of that kind. What then happens
depends on the built-in, and the table under "The requester of a request"
in `builtin-inventory.md` has a row for each.

- **A built-in that needs no requester** is requested with no principal:
  the fetch family, which signs with the runtime's identity,
  `generateText`, `generateObject`, a `sqliteQuery` on a database of the
  same space without `readClearance`, the compiling half of
  `compileAndRun`, and the resolving half of `cellFromUrl`.
- **A built-in that needs one has an operation of narrower scope than its
  cone instance.** The operation of `agent`, and of a `sqliteQuery` on a
  database of another space or with `readClearance`, has user scope
  whatever the scope of the cone instance that computes its request, or
  session scope where the result is declared so. Its unit exists per
  principal that demands its result, with a state document per such
  principal, and its request transaction acts as that principal. The
  request itself is stored once, where the cone instance staged it. A
  unit exists only for a demanding principal, so with none the request
  transaction does not run: the `agent` request is not made, and the
  inventory's table has the `sqliteQuery` refused.
- **`navigateTo` has session scope.** A request that is not a consequence
  of an event a client session fired is refused, which is the boundary's
  declared rule (section 6.3).
- **Where the table gives no behavior, the request is refused,** as an
  `inSpace` instantiation by a computation of space scope is refused
  (section 9.3). The request is not made, and the operation's result takes
  the refusal as an error state, which is the outcome of a failed egress
  ceiling (section 6.3).

All of this is *assumed*, and it extends question 45 of the continuation
plan, which covers an evaluation of space scope and not an effect it
requests (open question 36). The principal of a completion transaction and
of a materializer's run is not decided here: each writes a store the
runtime owns, under a label its own rule gives.

When the request of a demanded operation is stale, the scheduler runs the
operation's **request transaction**. The request is stale when a path of
the stored request changed, or when something the last request transaction
followed below a reference changed.

1. Read the stored request and its label. A request path whose cone failed
   holds an error state. Such a request is not made, and the operation's
   result is that error state (`plan-and-label-templates.md` §5.2).
2. Follow the references the request holds, as far as the built-in
   serializes or hashes them. The "Request operands" paragraph of the
   built-in's entry in `builtin-inventory.md` says which operands are read
   by value and how deep, and which are references that leave as links and
   are not followed. These reads are the request transaction's own. The
   scheduler registers the addresses they touched as entries of the
   operation (section 3.1), in place of the ones the last request
   transaction registered.
3. Compute the request hash: the built-in's identifier and the canonical
   form of the request with what step 2 read
   ([serving loop](../server-side-execution/serving-loop.md), §4).
4. If the stored hash is equal and a settled result or error is present, do
   nothing. The stored result is the operation's value.
5. If the stored hash is equal and a request is outstanding, do nothing. The
   completion will arrive.
6. Otherwise check the gates of section 6.3, write the hash with a pending
   mark into the state document, and hand the request to the outbox. The
   hash, the claim and the pending mark carry the confidentiality of
   `Operation.input`, instantiated, joined with what step 2 consumed, and
   no integrity (`plan-and-label-templates.md` §2.6). The outbox dispatches
   the request after the transaction's commit is accepted.

So a change of content behind a reference the request holds runs the
request transaction again, and it requests the effect again exactly when
the hash differs.

**In a handler** the request is staged in the event's transaction. Each
path of it is a write edge of the body with the target `request`, and it
carries the handler's template or the reference rules. When the body
returns, the event's transaction stages the stored request, its hash and
the pending mark (`execution-and-storage.md` §1.4). The transaction
follows the references as in step 2, on the server, and checks the egress
ceiling. The ceiling is a constraint on what the handler itself writes, so
a failure rejects the event (`plan-and-label-templates.md` §3.14 and
§4.4). The hash, the claim and the pending mark carry the join of the
templates of the body's `request` write edges, instantiated, with what
following the references consumed, and no integrity
(`plan-and-label-templates.md` §3.14). The outbox receives the request
when the transaction commits, whether or not anything demands the result:
the demand rule above does not apply. The store transaction that commits
the event's transaction writes the operation's pending-effect row (section
2.3). Such a request is made once: a later change behind one of its
references does not request it again, because the occurrence belongs to
one handling. The one case in which its request is formed again is a
recovery, when the process that held the request is gone (sections 2.3
and 10.6).

### 6.3 Which gate is evaluated when

| Gate | At the request | At the completion |
| --- | --- | --- |
| Egress ceiling: the confidentiality of the request fits the ceiling configured for the sink (`verifySinkRequestCeilings` in `cfc/prepare.ts`, which today measures the whole staging transaction) | Yes, on the join of the request's instantiated templates and of what following the references the request holds consumes (`plan-and-label-templates.md` §3.14) | No. The request has left |
| Release check: the request about to leave equals the snapshot that was checked (`verifySinkRequestRelease` in `cfc/sink-request.ts`) | After the staging commit, before dispatch | |
| The built-in's own request rules: the `agent` request's declared maximum confidentiality, the refusal of a labeled `sqliteQuery` request to a database of another space, `navigateTo` only among the consequences of an event fired by a connected session | Yes | |
| Outbox budgets: outstanding requests and egress rate per space ([serving loop](../server-side-execution/serving-loop.md), §5) | They hold the dispatch | |
| Selection: the completion's hash is still the request the operation selects, and the operation's instance is not torn down | | Yes. A completion for a superseded request, or for an operation of an instance that was torn down (section 2.7), writes nothing |
| The result's label: the built-in's declared rule over the request's label, which is the joined label of the first row, with the constants the result schema declares and the integrity the boundary declares, such as `LlmDerived` | | Yes, from the request as it stands at write-back |
| Validation of the result: a response schema, declared ceilings on rows | | Yes. A failure is an error result |
| Gates on a tool call of a language-model turn | | During the effect, before each call |
| Constraints of the cones that read the result | | In the derivation transaction that follows the completion's commit (section 6.5), and not in the completion. A failure there drops one derived write and cannot lose the result |

For a request made in the reactive tier, a failed egress ceiling rejects the
operation's request transaction and no other
(`plan-and-label-templates.md` §3.14). The request is not made, and the
operation's result takes the refusal as an error state in a following
transaction, under the joined label, as a built-in's rejected staging
settles today ([built-in contracts](../server-side-execution/builtins.md),
§2). For a request a handler makes, the failure rejects the event (section
6.2).

### 6.4 Time gates and retries, as they exist

The design adds no timer and no retry. The ones that exist are these, and
each stays as it is (`builtin-inventory.md`, "When an effect is demanded,
and its time gates"). The 50 ms debounce of `wish` has no counterpart,
because `wish` is structural and its parts are evaluated on demand like any
cone. That document states it as an assumption.

| What | Where | Behavior |
| --- | --- | --- |
| Completion write-back | `Runtime.editWithRetry` (`runtime/runner/src/runtime.ts`) | Up to `DEFAULT_MAX_RETRIES` (5) attempts when the commit is rejected for a stale basis. Between attempts it waits in `awaitCommitRetryReadiness` for the conflicting documents to arrive. No timed backoff |
| A claim that went silent | `tryClaimMutex` (`builtins/fetch-utils.ts`), `MUTEX_STALE_AFTER`; `REQUEST_TIMEOUT` in `builtins/llm-dialog.ts` | A pending request may be claimed again once its `lastActivity` is older than 5 seconds for the fetch family, or 5 minutes for a dialog turn. The claim exists so that several committing runtimes do not send one request twice |
| A failed request | `builtins/fetch.ts` | Not retried. The error is written with the request hash, so the next request is one whose inputs changed |
| Dispatch held by a budget | `SpaceOutbox` (`executor/outbox.ts`) | A request over the cap on outstanding requests, or over the egress rate, waits in the outbox. A park drops held requests, and the next activation finds them missing and requests them again: an `Operation` of a plan when its instance is loaded and its request transaction compares the hash, and a handler's request from its pending-effect row (section 2.3) |
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
   ([serving loop](../server-side-execution/serving-loop.md), §4). For an
   operation a handler requested, the same store transaction deletes the
   pending-effect row (section 2.3).
2. The commit is matched against the index in the process that made it. The
   slots with root `operation` that are bound to the result become dirty.
3. That is a cause of the third kind. It opens no transaction of its own
   beside the completion transaction. The commit joins the set of changes
   of the cycle that follows it, and that set's one derivation transaction
   evaluates the demanded cone instances that read the result, in every
   instance that does, with whatever else the set made stale (section
   10.2). On a runtime without a serving loop the commit is a set of
   changes by itself (section 10.7).

The completion transaction is the boundary's, and the derivation
transaction is the instances'. They are two transactions because the first
exists whether or not anything reads the result. A cone instance that reads
the result and fails, or whose write a constraint drops, therefore cannot
lose the result.

A completion writes nothing in two cases: its hash is no longer the
request the operation selects, or the operation's instance was torn down
after the request left (section 2.7).

### 6.6 One request across re-evaluations

A request is made at most once per distinct request hash and state document,
whatever is evaluated again.

- A cone instance that computes a request is evaluated again whenever
  something it read changed. If the request's value is unchanged, nothing
  is written and the operation is not told. If it changed back and forth,
  the hash decides.
- An operation's state document is named by its cause, so every evaluation
  names the same document.
- An operation of an instance a computation made is named within that
  instance, and the instance is named as `plan-and-label-templates.md`
  §1.3 names it: by the enclosing instance, the body, the site, and an
  ordinal or a cause (section 2.7). An evaluation of the computation that
  makes the same instance with the same argument changes no request.
- A handler's requests are named by the handling and their order. An event
  that is requeued and runs again names the same operations, finds the
  hashes it wrote if its first attempt committed them, and otherwise had
  committed nothing.
- After a restart, the hash is computed again from the stored request and
  compared with the stored hash. A settled result is reused.

### 6.7 On a client

A client has no effect operations and requests no effect. Its speculative
transaction computes the request and writes its paths to the overlay, as
it writes any write edge. If the request's hash differs from the stored
one, the operation's result reads as pending, and otherwise as the last
committed result
([speculation](../server-side-execution/speculation.md), §2).

`navigateTo` is the one effect a client enacts, by ruling. When the
speculative run of an event the client fired stages a `navigateTo` request,
in the handler or in a derivation that follows from it, the client
navigates. The enactment is reconciled with the intent the server computes
by the intent's nonce, as it is today: `deferSealedEffects` in
`speculation/overlay-destination.ts` enacts the effects of a speculative
run whose kind is `navigateTo` and of no other kind
(`SPECULATION_ENACTABLE_EFFECT_KINDS`). A client enacts no other effect.

## 7. Materializers

### 7.1 What a materializer is here

A materializer is a `lift` or a `computed` with at least one side-write
whose target is dynamic or too broad to list as a write edge. Which bodies
those are is decided by `footprint-analysis.md` §6.3, per body: a body with
one such write is a materializer for all of its writes. The plan records an
`Operation` of kind `materializer` whose `implementation` names the body,
and the body's `writes` and `envelopes` are its declared write envelope
(`plan-and-label-templates.md` §3.11; section 2.4).

A materializer is not part of the compiled evaluation of its instance. It
keeps a transaction per run and today's label rule: every path it writes
gets the join over everything the run read, trigger reads included. A
computed input joins that label with its instantiated template.

**What it returns.** The value the body returns is the result of its
`Operation`. The materializer's transaction stores it at the result path of
the operation's state document, under that transaction's join
(`execution-and-storage.md` §6.7). A cone that uses the value reads it
through a slot with root `operation`, which is bound and watched like any
slot (section 3.2). The materializer's commit dirties the slot, and that is
a cause of the second kind.

### 7.2 The rules it keeps

- **Discovered reads.** Its read set is the journal of its last run, and the
  delta is applied to the index after each run. This is Scheduler v2's P6,
  which remains for materializers alone.
- **Standing demand.** A materializer of a loaded instance is always
  demanded. Its readers cannot be known, so a change to what it read has to
  lead to a run.
- **Demand on its computed inputs.** An entry of the body's `Body.computed`
  is an output of a cone of the instance. A materializer holds demand on
  the cone instances that produce its computed inputs, for as long as its
  instance is loaded. The derivation transaction of a cycle therefore
  evaluates them when they are stale, and stores what they keep.
- **Idle priority.** It runs after the events of a cycle and the
  derivation transaction behind them have sealed, and its invalidations up
  to that point become one run. Its computed inputs are then current, and
  its transaction takes them from the memo
  (`execution-and-storage.md` §6.7).
- **Promotion.** If a cone instance about to be evaluated has a slot bound
  to an address that the envelope index holds for an invalid materializer,
  that materializer runs first. The check is a lookup of the cone
  instance's bound addresses in the envelope index and needs no evaluation.
  Section 5.2 states the same rule for a handler.
- **A promoted run and its computed inputs.** A materializer that is
  promoted runs ahead of the derivation transaction. Where a cone instance
  that produces one of its computed inputs is stale, the materializer's
  transaction evaluates it for its value and stages none of its writes.
  Where that cone instance performs a side-write, it is not evaluated
  there, and the materializer is not promoted: it runs behind the
  derivation transaction. A reader that is a cone instance reads what is
  stored, and the materializer's write makes it stale
  (`execution-and-storage.md` §6.7).
- **A handler that reads inside the envelope of a materializer that
  cannot be promoted waits.** A handler body runs once, so it cannot read
  what is stored and be corrected. This is the case where a slot of the
  handler's `Body.reads` is bound inside the envelope (section 5.2, step
  3), or a journaled read of its body reaches it (section 5.3), and the
  invalid materializer has a stale computed input whose cone instance
  performs a side-write. The event keeps its place in the queue, the
  events that arrived after it in the space wait behind it, and the batch
  of the cycle ends before it. An attempt that was open at a journaled
  read is withdrawn whole first. The cycle then runs the derivation
  transaction behind the batch, which evaluates that cone instance and
  performs its side-write, and then the materializer (section 10.2). The
  end of the materializer's run releases the event, which is handled at
  the head of the next batch. No deferral is counted, since the wait ends
  on the run and not on a later drain. A materializer that stays invalid
  at its budget keeps the event waiting until it has run, as an event is
  parked today behind a node that a gate holds (section 8.3).
- **After a restart or a load, the basis rows say whether a materializer
  is valid.** A materializer has basis rows, keyed by its `Operation` in
  the place of the cone (section 10.4): one per document its last run
  read, with the document's sequence number at that run. The rows are
  written when the writes of the run reach storage. When its instance is
  loaded in a process that holds no read set for it, the materializer is
  valid where it has rows and every row is at the head of its input, and
  invalid where a row is behind or it has none. For a valid one the
  scheduler registers a row entry at each document the rows name (section
  3.1), so that a change to one of them marks it invalid by document. Its
  first run in the process replaces the row entries by the entries of
  its read set. The trigger addresses held at a restart are lost, as they
  are for a `dynamic` node, with the same residual (section 3.4).
- **A creation-site envelope gives nothing to wait for.** A
  `WriteEnvelope` of kind `created` names a site and no address, so it is
  not in the envelope index, and no reader's address can be found inside
  it. Nothing is promoted for it and nothing waits for it: a cone instance
  and a handler that read a cell such a site creates read what is stored,
  and the materializer's write then makes the cone instance stale. The
  envelope still bounds what the body may write, since the runtime refuses
  a write to a created cell of a site the body does not list
  (`plan-and-label-templates.md` §3.11).
- **Envelopes order and never dirty.** A reader becomes dirty only by a
  write the materializer committed.
- **Its writes are a cause.** They are matched against the index when its
  transaction seals, and the cone instances they make stale are evaluated
  in the derivation transaction of that cause.
- **On a client.** *Assumed:* a client runs no materializer. What a
  materializer writes reaches a client from the server, and a cone
  instance on a client that reads a materializer's result or one of its
  targets reads the committed value (open question 27).

### 7.3 What changes around it

- A cone instance whose `dynamic` read is inside an invalid materializer's
  envelope is not promoted for, because the address was not known before
  the evaluation. The cone instance is evaluated with the value it found,
  the materializer runs at idle priority, and its write makes the cone
  instance stale again. That is the one-evaluation-late rule of section
  3.4, and it is how a computation behaves today.
- A handler in the same position cannot be evaluated late. Section 5.3 says
  what happens: the attempt is withdrawn and the event is dispatched again
  after the materializer has run, which for a materializer that cannot be
  promoted is behind the derivation transaction (section 7.2). A cell
  under a creation-site envelope is the exception, as above.
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

A cone instance is evaluated at most once for one state of what it reads.
It can be evaluated more than once in one transaction for these reasons:

- a side-write of one cone instance changes a slot another cone instance
  already read, through a state cell or through a cell reached by a handle;
- two instances of one space read each other's outputs through links;
- a staged write that a cone instance read is dropped by a constraint or
  withdrawn, and the reader is evaluated again against what is stored
  (section 3.5);
- a computation reads, through the link, the result of an instance it made,
  and that result depends on the argument the computation writes (section
  2.7);
- a journaled read of a handler is made current at the read, which
  evaluates a cone instance that an earlier read of the same body already
  evaluated and that the body's own writes made stale since.

The bound is one rule, and it is ruled:

> In one transaction, one cone instance is evaluated at most 10 times. An
> evaluation that would be the eleventh does not run, and the cone instance
> fails.

- **The number is a placeholder,** fixed with the plan version
  (`Plan.version`). The server and a client have to arrive at the same
  error states from the same plan, so the bound is part of what a plan
  means and not a setting of a deployment. Changing it is a new version.
- **Who counts.** Cone evaluation keeps the count, per cone instance and
  transaction (`execution-and-storage.md` §2.7). The instance record holds
  no second count.
- **Why a count per cone instance.** A cycle within one plan is visible in
  `Plan.edges`, and a count per cycle would do for it. A cycle through links
  between instances exists only in data, and a count per cone instance
  covers both with one rule.
- **Why 10.** It is the bound of today: `MAX_ITERS` and `PASS_RUN_BUDGET`
  are both 10 (`scheduler/constants.ts`). A cycle through a side-write that
  settles within one pass today settles within one transaction here. A
  chain of cones that is not a cycle evaluates each cone instance once,
  however long it is, so the bound does not limit depth, which is the
  mistake Scheduler v2 §7.7 records for a budget of 5.
- **Convergence is by value.** A cone instance that is evaluated again and
  stages the values already staged makes nothing stale. The idempotency
  contract is what makes a cycle through a side-write end, and the
  validator of Scheduler v2 §4.2 stays the test of it.
- **After the bound.** A cone instance that failed at the bound is not
  evaluated again until one of its inputs changes, by ruling: with the same
  inputs a later cause would reach the bound again. Its failed evaluation
  is an evaluation. Its memo entry holds the error state and the reads made
  up to the failure, its error state is stored, and its basis rows advance
  (section 3.5). This differs from today, where the work that remains is
  deferred behind a backoff gate and tried again
  (`planBudgetBackoff` in `scheduler/execution.ts`), so that a graph that
  needs more than ten iterations still converges. A cone instance has no
  such gate (section 8.4).

### 8.2 What is reported when the bound is reached

- **The error state.** The cone instance fails as
  `plan-and-label-templates.md` §5.2 defines: its outputs take an error
  state whose label is the output's template instantiated with the
  selections made up to the failure, and the rest of the transaction
  commits. Cone instances that read its outputs fail in turn.
- **Its write edges.** What the target of a write edge of the failed cone
  instance takes depends on the target
  (`plan-and-label-templates.md` §5.2). A path of a child's argument and a
  path of an effect's request take the error state: the child's cone
  instances that read the path fail in turn, and an effect whose request
  holds an error state is not requested. A side-write to a state cell, to a
  cell reached through a handle, to a created cell, or to an anchors
  document is withdrawn, and the target keeps the value and the label it
  had before the transaction. A state cell that a handler also writes does
  not come to hold an error state because a computation that normalizes it
  did not settle.
- **A reader of a withdrawn value does not fail.** The scheduler matches
  the withdrawn target again with what is stored. A cone instance that had
  read the withdrawn value is stale, is evaluated again against the earlier
  value under its own count, and does not fail because the writer failed.
  This rule is the same for a cycle inside one instance and for one through
  links between instances, so that the server and a client fail the same
  cone instances.
- **The diagnostic.** For each evaluation after the first, the scheduler
  records which slot or registered address made the cone instance stale and
  which cone instance or body staged the write that changed it. When the
  bound is reached, the record names the cycle: the cones by their
  `Cone.entry` and their source position `Cone.at`, the instances, and the
  target of each write. A target is a kept output path, a state cell, a
  cell reached through a handle with the handle's slot and the path below
  it, a path of a child's argument, or a path of a stored request. The
  record goes to the scheduler's error channel and to telemetry under the
  marker `scheduler.non-settling`, which today carries only the first ten
  deferred actions. The record is computed from the cones' inputs, so it
  has the label of the error state and is shown only where that label
  permits.
- **At compile time.** `PlanIndex.cyclicCones` is known from the plan:
  `Plan.edges` holds an edge for every static write of a cone, through a
  state cell (`via` of kind `state`) and through a handle (`via` of kind
  `handle`), and an edge from a cone to itself or to a cone with a lower
  index is on a cycle (`plan-and-label-templates.md` §1.4 and §3.11). The
  compiler reports an edge to a cone with a lower index, and an edge from
  a cone to itself where no body of the cone reads its own write target,
  as a warning that names the side-write, `side-write:cycle`. A body that
  reads its own write target is reported as `side-write:not-idempotent`
  and not as a cycle (`language-subset.md` §10.3). The compiler refuses
  neither: a write that leaves a settled value unchanged is a cycle that
  settles in two evaluations.

**What the compiler cannot see.** Six kinds of cycle are found only by the
budget:

- a cycle through links between instances;
- a cycle through two places of one plan that link to one cell, which is
  found from the bound addresses (section 2.6);
- a cycle through a write through a handle the instance computed, for
  which the plan has no `ConeEdge` (section 2.6);
- a cycle through a cell handed to a handler that was received as a factory
  value. Until the binding is resolved, `footprint-analysis.md` §8.5 bounds
  what such a handler may write by position and not by address, so a cell
  at a writable position of its state counts as written by code the
  compiler did not see (`plan-and-label-templates.md`, §3.21);
- a cycle through an instance a computation made and reads, for which the
  plan has no edge (section 2.7);
- a cycle through a materializer, which section 8.3 bounds.

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
  should stop after a number of rounds is open (open question 9; question
  20 of the continuation plan). An effect in an instance a computation
  made can close such a cycle through the computation: its result changes
  what the computation reads, and the computation writes another argument.
- **A cycle across spaces.** Each space has its own serving loop and its own
  cycles, so a round is one commit in each space and no budget of either
  loop counts it. Telling that cycle from a stream of ordinary changes
  would need the chain of causes to be carried on commits between spaces,
  which it is not (open question 9).

**A cone instance has no gate.** The instance record holds no backoff and
no remote-echo state, and cone evaluation checks no time gate before it
evaluates a cone instance (`execution-and-storage.md` §2.7). Two gates of
today therefore have no counterpart for a cone instance.

- **The backoff after an exhausted budget.** A cone instance that reaches
  the bound fails and waits for an input to change (section 8.1). The
  backoff gate remains for the units of section 8.3.
- **The remote-echo gate** (`RemoteEchoBreaker` in
  `scheduler/echo-breaker.ts`). It backs off a computation that keeps
  rewriting a document it also reads and that is run again each time by a
  commit to that document from elsewhere. *Assumed:* that loop needs two
  runtimes that both commit derived writes to the document. In this design
  the serving runtime alone commits the derived writes of a space, and a
  client's evaluations write to its overlay, so the loop does not arise
  between a client and the server. The same loop inside one runtime is two
  cone instances in one transaction, which the bound of section 8.1 ends.
  The gate would not cover the cycle across spaces above either (open
  question 29).

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
| An `inSpace` instantiation: the child's argument and result cell | An authored batch per target space, under the acting principal of the requesting evaluation or handler | At the wave's commit step, before the home batch |
| The creation of a space an `inSpace` request names and that does not exist | The genesis commit of the new space, which makes the acting principal its owner, and then a commit of the home space that holds the allocation record alone | At the wave's commit step, ahead of the batch for that space (section 9.4) |
| A staged change to a space's access list | An authored commit of the list alone, decided by the memory server that holds the list | At the wave's commit step, before every batch of writes |
| A bookkeeping write a run triggers after it ended, such as a compile-cache write-back | The same foreign batch, under the triggering run's carriage | With the provisioning batches |
| The mark of a torn-down instance in another space: an `inSpace` instance that a computation made and an evaluation no longer makes | An authored batch for that space, under the principal of the scope key the making cone instance is evaluated for | At the wave's commit step, with the batches of writes for other spaces, before the home batch |

The first, the second, the fourth and the fifth exist today
([protocol](../server-side-execution/protocol.md), §2b;
[serving loop](../server-side-execution/serving-loop.md), §3d and §5). The
third is section 9.4's, and the sixth is described below. The
child of an `inSpace` instantiation is evaluated by its own space's loop,
when something there demands it, and never in the transaction that requested
it (`plan-and-label-templates.md`, §3.15).

**An `inSpace` instantiation that a computation makes.** A `lift` or a
`computed` may instantiate with `inSpace` (*assumed*, with question 38 of
the continuation plan; `builtin-inventory.md`, "An instantiation request
from a `lift` or a `computed`"). The request is then staged by a
derivation transaction, and its step in the other space is authored like a
handler's. It acts as the acting principal of the evaluation that made the
request, which section 10.3 gives: the principal of the scope key the
making cone instance is evaluated for.

*Assumed:* a cone instance of space scope is evaluated for no principal,
as a derivation of space scope is run for none today
([events](../server-side-execution/events.md), §2). Its evaluation has no
identity under which a batch in another space could be authored, and the
serving runtime's own identity is not a substitute, because the other
space would then admit a write for whoever caused the evaluation. Such an
instantiation is refused when the request is made, and the cone instance
fails. A computation that instantiates with `inSpace` therefore has to
read state of user or session scope, or the instantiation belongs in a
handler (open question 34).

**A later evaluation that changes the argument.** An evaluation that makes
the same `inSpace` instance again and computes other values for paths of
its argument stages those paths, as it does for an instance in its own
space (section 2.7). The argument document is in the other space, so the
paths are carried by the second row of the table: an authored batch for
that space, under the same principal, at the wave's commit step. The other
space's loop receives the commit as a storage change, which dirties the
instance's `argument` slots there.

**Tearing down an instance in another space.** The transaction of the
evaluation that no longer makes the instance covers the home space. It
removes the instance from the instances document of the enclosing
instance, which is a home write. The mark belongs in the setup record of
the instance's result document, which is in the other space, so the
transaction stages it as a step for that space: the sixth row of the
table. Three things follow.

- **The home scheduler does its part for what it holds.** It withdraws
  the demand its own slots held through the link, and it has no record,
  no queue and no rows for the instance.
- **The other space's loop does the scheduler's part of section 2.7.**
  The mark arrives there as a commit from storage. That loop finds the
  mark at the setup record of a result document, and does for the
  instance, and for every instance of that space that belongs to it,
  what section 2.7 lists: it releases the record if the instance is
  loaded, withdraws demand, drops the events queued for its streams,
  abandons its pending effects, stops its materializers, and deletes its
  rows from that space's basis index, stream index and pending-effect
  rows, in the store transaction of the wave of that cycle. Where the
  space is not active, the mark is stored all the same, a marked instance
  is not loaded (section 4.4), and the rows are deleted when the space is
  next activated and the loop finds them under a marked instance.
- **The instances that belong to it.** The home transaction writes the
  mark of the instance it made, and of no other. *Assumed:* the other
  space's loop writes the marks of the instances that belong to that
  instance in its space, in the derivation transaction of the set of
  changes the arriving commit is part of, because the records that say
  which those are, such as the instances documents, are in that space
  (`execution-and-storage.md` §2.8; open question 40).

If the home batch then does not commit, the mark stays in the other space
while the instances document still lists the instance. The making cone
instance is evaluated again later. Where it again makes no such instance,
it stages the same mark and finds it stored. Where it makes the instance,
it clears the mark and sets the instance up again
(`execution-and-storage.md` §2.8, "Made again").

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
| 2. One ordered sequence, foreign steps first | The transaction of a cause carries an ordered list of steps beside its home writes. A step is the creation of a space, the record of its allocation, an access-list change, or a batch of writes to one other space. At commit the steps are applied in order, and then the home writes. The first failure stops the sequence and the home writes do not commit | It is what the serving loop does. It is not atomic: a step that was committed stays committed |
| 3. An atomic commit across spaces | A prepare phase in every space, then a commit | It closes the gap of I11. It is a protocol of its own, which Scheduler v2 lists as open question 3 and defers |

**Recommended: option 2, as the one definition for both.** It is *assumed*
pending the owner (open question 6; question 15 of the continuation plan).
It is a commit in steps, the home writes last, and not a commit in two
phases. One part of the order is ruled: the allocation of a space an
`inSpace` request creates is recorded in a step that commits before the
step in that space.

**The order of the steps.**

1. **The genesis commit of each space a request of the transaction
   creates.** It makes the acting principal the owner of the new space.
   The identifier of such a space is obtained and not derived from the
   request: the runtime generates the key pair of the new space when the
   request is made, the public key determines the identifier, and the
   request returns it, so the body is run once
   (`execution-and-storage.md` §5.6).
2. **The allocation record of each such space,** in a commit of the home
   space that holds the allocation records and nothing else. A record
   holds the obtained identifier under the name the request gives, or for
   an anonymous target under the request's own identifier. That is the
   identifier of the instance requested, except with `root: true`: the
   instance identifier then derives from the identifier of the space, so
   it cannot name the record that yields that identifier
   (`plan-and-label-templates.md` §3.14). The record is a write of the
   unit that made the request and carries the body's template. It commits
   ahead of that unit, so its label is instantiated from stored labels
   only (§3.14 and §4.6 there; `execution-and-storage.md` §5.6 says in
   which document it is stored). It commits by itself, at the wave's
   commit step, ahead of the wave's derived commit.
3. **The staged changes to access lists,** in the order the handler staged
   them.
4. **The batch of writes for each other space:** the documents of the
   instances an `inSpace` request made there, the argument paths a later
   evaluation changed, and the marks of the instances there that an
   evaluation tore down (section 9.3).
5. **The home writes.**

The genesis commit comes before the allocation record so that a record
never names a space that does not come to exist: the private key signs the
genesis commit alone and does not survive the process
([random space identities](../random-space-identities.md)). The ruling's
"step in the foreign space" is read as step 4, the step that writes the
instance's documents. That reading is `execution-and-storage.md`'s
assumption (its question 47), and this document takes the same order. The
access changes come after the first two steps, because a handler can stage
a change to the access list of a space it creates in the same invocation,
and before every batch of writes, because a grant can be what admits a
batch.

Five properties make the sequence sufficient:

- **Every constraint is checked before the first step.** Templates are
  instantiated and constraints checked when the transaction seals, in
  memory, and that includes the write-side checks of the target space on a
  child's argument (`plan-and-label-templates.md`, §3.14). A rejected or
  aborted transaction therefore applies no step and leaves nothing in any
  space, and the key pair of a space it would have created is discarded.
- **A repeated attempt names the same instance.** The identifier of an
  `inSpace` instance is known at the request. For a request a handler
  makes it derives from the handling and the request's ordinal. For a
  request a computation makes it derives from the enclosing instance, the
  body's `name` and `within`, the site, and the ordinal of the
  instantiation among those the evaluation makes at that site, or, with
  `.for(cause)`, that cause in place of the ordinal
  (`plan-and-label-templates.md` §1.3).
- **A repeated attempt names the same space.** If a later step fails after
  the allocation record committed, on a conflict or a crash, the event is
  not consequenced and runs again. The request finds the record, returns
  the identifier it holds, and the batch for that space writes the same
  documents. An access change that was committed is found unchanged.
- **Without the record there would be two spaces.** A failure after the
  genesis commit and before the allocation record leaves a space that
  nothing names and that holds only its genesis commit, and the next
  attempt creates another. That is what a failed creation leaves today.
- **What can remain.** A step can remain without the home writes when the
  home step never succeeds: a created space with its allocation record
  that nothing else links to, or a grant without the write that explained
  it. That is the state a crash between the two leaves today, and
  Scheduler v2 records it as the gap of I11.

Under a wave the sequence runs once for the wave: the steps of every
transaction that sealed into it, in the order the transactions sealed, and
then the wave's one derived commit.

A client's speculative transaction stages these steps and applies none,
and a client does not create a space. A handler that names an `inSpace`
target whose allocation record does not exist yet does not speculate at
all ([speculation](../server-side-execution/speculation.md), §2).

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
  mark stale cone instances from the basis index  (section 10.4)
  subscribe from the head the index scan ran against

on commits [s..n] arriving:
  for each commit c, in sequence order:
    skip the loop's own derived commits
    match c's changes against the address index   (section 3)
    if c appends an event: queue it               (section 5.1)

  for each queued event, in order:                -- the batch
    if the event has to wait: end the batch       (sections 5.1, 7.2)
    run the event's transaction                   (section 5.2)
    seal it into the wave
    queue the events it sent to streams of this space

  if a demanded output is stale, unstored,        -- one cause: the changes
      or reached by a label-dirty slot:           -- drained and the batch
    run one derivation transaction
    seal it into the wave

  for each change of demand since the last cycle: -- one cause each
    run one derivation transaction, as the demanding principal,
      for what the new demand reaches             (section 4.5)
    seal it into the wave

  until nothing is invalid, or a unit's budget is reached (section 8.3):
    run each invalid materializer and each stale effect request
      in a transaction of its own, sealed into the wave
    run one derivation transaction for what their writes made stale

  commit the wave: the steps of section 9.4, then one derived commit
    with the watermark, the basis rows, the stream rows
    and the pending-effect rows
  hand the effect requests of the wave to the outbox
```

| Responsibility | Where in the loop |
| --- | --- |
| Changes into dirty slots | The first step on arriving commits, which is "mark dirty" today. A completion commit, a setup commit, and the open transaction's own writes are matched in process (sections 3.5, 6.5 and 10.8). A foreign commit is matched when its frame arrives (section 9.1) |
| Demand | The demand registry the loop keeps per client session is the source. A change to it is a cause (section 4.5), processed in the next cycle |
| The event queue | The scheduler's queue of the space's runtime, filled by the loop's drain from the durable stream entries. The events of one cycle are one batch (section 5.1) |
| Effects | Request transactions run inside the cycle. The network call runs in the outbox after the wave's commit. The completion commits by itself, and its commit joins the set of changes of the cycle that follows (section 6.5) |
| Materializers | Inside the cycle, after the events and the derivation transaction behind them |
| Convergence | The evaluation budget inside each transaction. The budget per unit ends the cycle, which is the loop's budget exhaustion |
| Links across spaces | Reads on the runtime's sessions. Writes at the wave's commit step, in the order of section 9.4 |
| Setup | A setup transaction commits by itself, ahead of the wave, and is none of the cycle's transactions (section 10.8) |

**One derivation transaction behind the batch.** The changes one cycle
drains from storage and the writes of the events that cycle handled form
one set of changes, which is one cause with one derivation transaction.
The commit of an effect's completion is among the changes: it was matched
in process when it was made, and the slots it dirtied are evaluated in the
derivation transaction of the cycle that follows it, with no transaction
of its own (section 6.5).
The loop drains commits in batches, and a transaction per commit would
evaluate one cone instance once per commit of a burst. That transaction
does three things, and it runs when any of them is needed.

- It evaluates the cone instances that are stale and demanded.
- It instantiates again each demanded output whose template reaches a
  label-dirty slot (section 3.6).
- It stores each demanded output that is unstored and carries no refusal
  (section 3.5).

It evaluates for every scope key that demands an instance, each evaluation
with its own context (section 10.3). Every write in it is a derived write,
so no constraint rejects it.

**Order across instances.** A derivation transaction evaluates the demanded
stale outputs in a fixed order, by instance identifier and output index. A
cone instance that reads a slot whose bound address a stale cone instance
writes causes that one to be evaluated first, in the same transaction,
whichever instance it belongs to. A cone instance that is read while it is
being evaluated returns the value it last staged or the committed one, and
is evaluated again when its own write is staged, within the budget of
section 8.1. The order is a function of the plan, the demanded outputs and
the values, so a client and the server that start from the same state
evaluate the same cone instances in the same order
(`execution-and-storage.md` §2.3).

**A transaction seals, and the wave commits.** Sealing is what committing is
on a runtime with no wave: the templates are instantiated and the
constraints checked in the commit preparation, the reads of what was
stored feed the basis rows, and the writes join the wave
([serving loop](../server-side-execution/serving-loop.md), §3d). A later
transaction of the same cycle reads the earlier ones' sealed writes and
resolves its slots to the labels they staged. "One transaction per cause"
is therefore a statement about evaluation, labels, and constraints. The
durable commit is the wave's, and it is the wave's commit that finds a
conflict and withdraws a derived write or requeues an event (section 5.5).

### 10.3 The enforcement boundary

[Serving loop](../server-side-execution/serving-loop.md) §3c fixes the
enforcement boundary at the action run, so that a wave's union of reads
never taints an unrelated write. With templates the label of a write does
not come from a read set at all. What §3c forbids stays forbidden, in this
form:

- A label is instantiated per kept output and per write edge, in the commit
  preparation of the transaction that stores it, from that write's own
  slots. Nothing is derived from the reads of a wave or of a whole
  transaction, except by a materializer, whose transaction is one run.
- No check is deferred to the wave's commit or to admission. What the
  wave's commit decides is which prepared writes commit: it leaves out a
  derived write that conflicts and the writes that used it, and verifies
  nothing again (section 5.5).
- One derivation transaction can evaluate cone instances for several scope
  keys, for example a storage change read by the instances of fifty users.
  Each evaluation carries the context a run carries today: the acting
  principal, the scope key of what it writes, and the read ceiling of the
  session it acts as (`WaveRunContext` in `executor/wave.ts`). The context
  belongs to the evaluation of one cone instance and not to the
  transaction.
- The acting principal of an evaluation is the principal of the scope key
  the cone instance is evaluated for. An evaluation of a cone instance of
  space scope has none, as a derivation of space scope has none today
  ([events](../server-side-execution/events.md), §2). A derivation
  transaction whose cause is a change of demand evaluates the scope
  instances of the demanding principal and no other principal's.
- The request transaction of an effect operation acts as the principal
  section 6.2 gives it, and a request transaction that a recovery runs for
  a handler's operation as the requester of its pending-effect row
  (section 2.3).

The text of §3c is a host arrangement and changes with this design. The
label semantics it arranges are the specification change's.

### 10.4 The basis index

The basis index is the persisted form of which cone instances are current. The
other persisted forms of scheduler state are the watermark, the stream
watermarks, the stream index of section 5.1, and the pending-effect rows of
section 2.3. Its rows say that an output is current if and only if its inputs
are unchanged since the recorded sequence numbers ([serving
loop](../server-side-execution/serving-loop.md), §3b). Its shape stays:
identifiers and sequence numbers, by document, overwritten in place, written
inside the wave's store transaction or a setup transaction's (section 10.8),
never pushed and never read at admission. Where the runtime shows a basis row
in a diagnostic or to a tool, it shows it under the label
`plan-and-label-templates.md` §2.6 gives a basis row ("Rows beside the
documents"), which is an assumption there.

What changes is what a row is keyed by. Today the key is a durable action
identity and the scope instance that ran. Here it is:

| Column | Holds |
| --- | --- |
| The instance | The result cell's identifier and the identity of the compiled pattern |
| The cone | Its index in `Plan.cones`. For a row of a materializer, the index of its `Operation` in `Plan.operations` in the place of the cone, marked as an operation |
| The scope instance | As today |
| The input document | Space, identifier, scope instance |
| The sequence number | The input's at the evaluation |

- A cone instance that is evaluated, and whose writes all reach storage,
  replaces its rows as a set. For a cone with element keys, the row of one
  element's document is replaced when that element's key is evaluated. The
  row of a document every key reads advances only when every bound key has
  been evaluated against it.
- A cone instance that is stale and not demanded is not evaluated, and its
  rows stay behind the heads. That is the whole durable record of section
  4.6.
- **A write that did not reach storage does not advance the rows.** When a
  transaction does not commit, because it was rejected or aborted, its attempt
  was withdrawn, or its event was requeued, when a constraint drops a derived
  write, or when one is withdrawn, the rows of the cone instance that computed
  the write stay where they were (section 3.5). In the process that evaluated
  it, the memo entry is current and the output is unstored (section 3.5). After
  a restart there is no entry, the rows are behind the heads, and the cone
  instance is found stale and evaluated again. The rows advance when a later
  transaction stores the write.
- **A failed evaluation advances the rows.** A cone instance that failed,
  at the bound of section 8.1 or otherwise, stored its error state. It is
  current after a restart as well, and is evaluated again when an input
  changes.
- A pattern update gives the instance a new compiled identity, so the old
  rows match nothing and every cone instance starts stale. The transaction
  that swaps the pattern deletes them. The rows of an instance that was
  torn down are deleted in the same way (section 2.7).
- Dynamic reads contribute the documents they journaled, as logged reads do
  today. A sampled read contributes none. A slot whose path holds `*`
  contributes the document of each child it was bound at (section 3.2).
- **A materializer has rows.** A materializer is no cone, and its rows are
  keyed by its `Operation` in the place of the cone. A run whose writes
  all reach storage replaces its rows as a set: one per document the run
  read. A run whose transaction does not commit leaves them. Section 7.2
  says how they decide, after a restart or a load, whether the
  materializer is valid. They are deleted with the rows of the instance.
- **Rows as entries.** A row names an input document. Where this process
  does not hold the precise entries of a cone instance, the scheduler
  registers a row entry at each document its rows name (section 3.1). That
  is the case for the element slots of a collection whose element table
  has not been built in this process, for a slot whose path holds `*` and
  whose container has not been read in it, and for the `dynamic` nodes of
  a cone instance that has not been evaluated in it. A change to such a
  document makes the cone instance stale. The first evaluation in this
  process replaces the row entries by slot, chain, container and dynamic
  entries. A materializer that has not run in this process has row
  entries in the same way (section 7.2).

**A read answered from the rows.** By ruling, a read of an address whose
writer is in an instance that is not loaded consults the rows, and the
instance is loaded only where they show the stored value stale (sections
4.4 and 5.3). The check is made for an address in one scope instance, as
follows.

1. **The instance.** The document of the address names it. The address is
   a path of a result cell whose result document holds a pattern
   reference, whether the result document or a part document stores the
   path. Or it lies in a state cell document, whose `result` back-link
   leads to that result document (`execution-and-storage.md` §4.2, and
   request 25 there). An instance marked as torn down is not checked: a
   read of it returns what is stored (section 4.4).
2. **The cones.** The plan of the compiled pattern that the result
   document names gives the cones that write the address: the cone of
   each kept output at, above or below the path, or each cone with a
   write edge of kind `state` to the cell. A write edge of kind `handle`
   or `argument` is not among them: nothing stored leads from a cell
   written through a handle, or from a child's argument document, to the
   instance whose cone writes it, so a read of either consults no row and
   returns what is stored (sections 4.4 and 5.3). The check adds every
   cone from which `Plan.edges` leads to one of them, over any number of
   edges. It
   uses the parsed plan the worker holds for that compiled pattern
   (section 10.5). Where the worker holds none, the address counts as
   stale.
3. **The rows.** Every row of those cones, under the instance and that
   compiled pattern, for the scope instance of the address and for each
   broader one: the user's and the space's for a session's, and the
   space's for a user's.
4. **Current.** The address is current when each of those cones has a row
   among them and every row holds the sequence number its input document
   has now. This is the definition by which the rows decide after a
   restart (Terms, "Stale"; `execution-and-storage.md` §3.4): an output is
   current if and only if its inputs are unchanged since the recorded
   sequence numbers, and a cone that has no row has not been evaluated. A
   document to which a transaction of the open cycle staged or sealed a
   write counts as changed, the reading transaction's own writes
   included, because the store does not hold that write yet and an
   instance that is not loaded has no entry for it to match (section
   3.7).
5. **Inputs that are derived.** An input document that a row names can
   itself be written by a cone: it is a result document, a part document
   or a state cell document of a compiled instance of the same space,
   loaded or not. For each such document the check is repeated from step
   2 with every cone that writes into that document, because a row names
   a document and no path. The address is current when every instance
   reached this way passes. An instance is checked once per read. An
   input document of another space is compared with the head the
   runtime's replica of that space holds and is not followed further
   (section 9.2).

The check errs toward stale. A row names a document and no path, so a
write to a path the cone does not read puts the row behind the head. A
change of a label alone is a write to the document that stores the label,
so it does the same, and a current address has a current stored label. A
row, a head or a document that the check cannot read without a wait
counts as behind. An address the check finds stale is treated as section
4.4 says, and the load that follows marks the stale cone instances from
the same rows.

The check loads nothing. It builds no instance record, enters nothing in
the address index or the writer map, fetches no compiled pattern, and
evaluates nothing. It costs one range of the index per consulted cone and
scope instance, one head per row, and the metadata of each input document
that a row names. For a cone applied to a collection that is one row per
element document. Section 5.3 says which reads are checked and how long a
verdict is kept.

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

Recovery is the activation of section 10.2 and needs nothing further ([serving
loop](../server-side-execution/serving-loop.md), §6): the lease, the watermark,
stale cone instances from the basis index, undelivered events from the stream
watermarks, their bindings from the stream index, pending outbox rows, and
effect requests found missing from their hashes. A missing request is found in
one of two ways. For an `Operation` of a plan it is found when the instance is
loaded: the operation's request transaction compares the stored hash and finds
a pending mark with no request outstanding in the process (section 6.2). For an
operation a handler requested, activation reads the pending-effect rows of the
space and runs a request transaction for each (section 2.3). Which
materializers are valid is read from their basis rows (section 7.2). The memo
of evaluated cone instances is process memory and starts empty, and so do the
element tables, the bindings of slots whose path holds `*`, the registered
addresses of `dynamic` nodes, their trigger reads, the read sets of
materializers, and the record of unstored writes and refusals. Sections 3.2,
3.4, 3.5, 7.2 and 10.4 say why each loss is sound. Which instances a
computation made is read from the instances document
(`execution-and-storage.md` §2.8).

### 10.7 A runtime without a serving loop

A test runner or a command-line run evaluates and commits in one process
with no wave. It is the same scheduler with sealing equal to committing:
each transaction commits by itself, a rejected event's transaction is not
committed, a conflict on a derived write is found at that commit, and the
outbox dispatches after each commit. A batch is the events queued when the
runtime begins to handle them, and the derivation transaction behind it
commits after theirs. Nothing in sections 3 to 8 depends on the wave.

### 10.8 Setup transactions, and a space with instances of both kinds

**Setup transactions.** Three transactions are not the transaction of one
of the four causes. Each commits by itself, ahead of the wave, as the
setup transaction of a source update does today
([serving loop](../server-side-execution/serving-loop.md), §3e).

| Transaction | When it runs | What the scheduler does |
| --- | --- | --- |
| The migration of an instance (`execution-and-storage.md` §9.4) | When demand or a queued event causes the load of an instance whose stored setup record the builder path wrote | The instance stays unloaded, with its demand pending and its events holding their place in the queue, until the commit is accepted. The transaction evaluates every cone instance, with every kept output of the space's scope instance demanded, and every kept output of narrower scope for the scope keys that demand the instance. Then the record is built, and the builder-path graph of the instance is released. A withdrawn commit leaves the builder-path instance running |
| The setup of an instance under a new compiled pattern, after a source update | When the update is applied | The same. The basis rows under the earlier compiled identity are deleted, so every cone instance starts stale |
| The deletion of a retired document (`execution-and-storage.md` §9.6) | At idle priority, after the cycle's transactions have sealed | None beyond matching the commit |

**The rows a setup transaction writes.** A migration and a setup under a
new compiled pattern evaluate every cone instance and compute the
identifiers of the instance's streams, in a transaction that is in no
wave. The memo then holds those evaluations, so no later transaction of
the process would compute them again and write their rows. The store
transaction of a setup transaction therefore writes rows as a wave's
does:

- the basis rows of the cone instances it evaluated, under the compiled
  identity the setup gives the instance;
- the stream rows of the streams whose identifiers it computed (section
  5.1), which for a migrated instance are all of its rows, since the
  builder path keeps none;
- and it deletes the basis rows under the earlier compiled identity, the
  rows of the instance's materializers among them, and for a migration
  the rows the builder path kept for the instance's nodes.

A stream row of a binding the new plan lacks is kept (section 5.1), and so
is a pending-effect row, which names no compiled identity.
`execution-and-storage.md` §9.4, step 5, names the rows among what the
migration writes.

The commit of a setup transaction is matched against the address index in
the process that made it, like a completion commit, so the slots of other
instances that are bound to what it wrote become dirty and are evaluated
in the next derivation transaction. Binding a migrated instance reads its
carry-over record (section 3.2).

**Instances of both kinds in one space.** Instances are migrated one at a
time, when they are loaded, and an instance whose source the compiler
refuses stays on the builder path (`execution-and-storage.md` §9.4). A
space can therefore hold compiled instances and builder-path instances
that read each other through links. Whether one serving runtime runs both
is a question of scope for the owner (question 24 of the continuation
plan; open question 35). *Assumed:* until the builder form is retired, it
does, as follows.

- **Two schedulers, one loop.** The serving runtime hosts Scheduler v2 for
  the builder-path instances and the scheduler of this document for the
  compiled ones. The dispositions of section 1 apply to compiled instances
  only: the node record, ordering, preflight, and provisional demand stay
  for a builder-path instance.
- **One change channel.** Both match each committed change, the builder
  path against its trigger index and this scheduler against the address
  index. A write one of them stages is matched by the other when its
  transaction seals.
- **Transactions.** A node run of a builder-path instance is a transaction
  of its own, as today, and seals into the same wave. The label of what it
  writes is today's join over its reads.
- **A slot bound to a builder-path output** is an ordinary slot. Its writer
  is not in the writer map. It holds demand through the liveness of the
  builder-path node that writes it, and a change of the output reaches the
  slot through the index. Within a cycle the two schedulers alternate
  until neither has work, under the budget of section 8.3.
- **A builder-path node that reads a compiled kept output** reads it
  through its stored address, and its read is a demand source on that
  output for as long as the node is live.
- **Events** share one queue and one order (section 5.4). An event for a
  builder-path instance is handled as today, with its preflight.
- **The basis index** holds rows of both kinds, keyed as each scheduler
  keys them.

## 11. Client speculation

### 11.1 What a client runs

A client that speculates an instance fetches its compiled pattern, loads the
value code, and runs the scheduler of this document with three differences.

- **Its transactions seal into the overlay.** An event the client fired and
  an input the user typed are causes. An event has an event's transaction,
  and the derivations that follow run in a derivation transaction behind
  the client's batch, as on the server. The writes of each become an
  overlay entry that is never committed
  ([speculation](../server-side-execution/speculation.md), §1). The
  client's one commit for an event is the event itself.
- **It has no effect operations** (section 6.7), no outbox, no basis index, no
  stream index and no pending-effect rows. It enacts one effect, `navigateTo`.
  *Assumed:* it runs no materializer (section 7.2).
- **Its demand sources are render sinks.** Only what is rendered is
  evaluated.

An input the client has not replicated makes the cone instances that read
it pending: nothing is fetched for a speculation, and the branch renders
its loading state until the server's value arrives.

**What a client cannot name.** A client cannot read the element-key salt,
by ruling. It can therefore derive no identifier that is derived under
that secret: one that holds a key derived from a value, and that of a part
document. Three kinds of thing are affected.

| What | Why a client cannot name it | What the client does until a stored link arrives |
| --- | --- | --- |
| A state cell declared in an element body over plain values, which exists only where the index is in the key, and the state of an operation declared in such a body | The `element` step of its cause holds a salted value hash | The `state` or `operation` slot has no bound address. The cone instances that read it are pending, and what they feed renders its committed value or its loading state |
| A part document at or below a row of a kept collection | Its identifier is derived under the secret of the space for every key, a cell's identity included (`plan-and-label-templates.md` §2.3) | Nothing: a client names a kept path by the result cell and the path, never a part document, and its overlay entries are per kept path (section 11.6) |
| A binding made in a function body that has a copied path | The stream's identifier holds the salted hash of the copy | The stream is pending. A control the speculative run rendered for it sends nothing until the server's link to the stream arrives. A speculative handler that makes such a binding stores no link to it in its overlay entry |

A client learns such an identifier from a link the server stored: a kept
output that passes the state cell on, or the stream link in the rendered
tree. A state cell that no kept output passes on is never named by a
client, and the cone instances that read it stay with their committed
values.

**What a client can name.** Everything else, from the plan and the data it
holds, before the server's result arrives.

- A binding of the reactive tier copies nothing, so its stream is named by
  the binding's name and `within` steps. A client derives it, unless an
  enclosing element key is a salted value hash.
- A binding made in a function body whose paths are all links, to cells or
  to containers bound by reference, is named by the identities of those
  cells and the addresses of those containers. A client derives it.
- A cell, an instance, an effect and a sent event that a handler requests
  are named by the handling and their order (section 11.6).
- An instance a computation makes is named by the enclosing instance, the
  body's `name` and `within`, the site, and the ordinal of the
  instantiation among those the evaluation makes at that site, or, with
  `.for(cause)`, that cause in place of the ordinal
  (`plan-and-label-templates.md` §1.3; section 2.7).

So a user can act on a control that a speculative run rendered, before
the server has evaluated the binding. The event is appended to a stream
the server has no row for yet, and it is deferred as section 5.1 says.

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
| 3 | Client, speculation | The event's transaction runs on the overlay. The cone instances the handler reads are made current, and the body pushes the message |
| 4 | Client, speculation | The handler's write edges are instantiated and `k0` is checked. It guards what the handler itself writes. The writer half was settled when the pattern was compiled: `commitComposerSend` performs the write and an alternative names it. The event half is evaluated on the event bound to the handler's `event` root, by the predicate the server uses (`trustedEventProvenanceMatchesUiContract`). It passes, and the transaction seals as an overlay entry whose origin is the event |
| 5 | Client, speculation | The derivation transaction behind the client's batch evaluates the cone instances that the write made stale and the page demands: the message list, the empty-state test, and the new row. It seals as a second overlay entry with the same origin. The row renders. Its labels are instantiated locally by section 11.2 |
| 6 | Server, memory server | The append is admitted on the sender's append authority, and the actor is stamped from the authenticated envelope |
| 7 | Server, serving loop | The drain queues the entry and marks its payload renderer-trusted because the entry carries the attestation (`SpaceServer` in `executor/space-server.ts`). The event's transaction runs as the stamped actor, with the same two parts and the same check of `k0`. It passes, and the transaction seals into the wave with the entry's consequence mark. The derivation transaction behind the batch evaluates the same cone instances and seals into the same wave |
| 8 | Both | The wave commits and is pushed. The client retires both overlay entries on the mark, and the committed row replaces the speculative one ([speculation](../server-side-execution/speculation.md), §4) |

**A send from an element without the integrity.** Take a pattern that binds
the room's `sendMessage` stream to a button of its own, outside any reviewed
surface, or that sends to the stream from one of its handlers.

| Step | Where | What happens |
| --- | --- | --- |
| 1 | Client | The event has no provenance naming the send surface, or no renderer-trust mark at all |
| 2 | Client | The event is appended, with no attestation or with provenance that does not name the surface |
| 3 | Client, speculation | The event's transaction runs. `commitSend` pushes the message |
| 4 | Client, speculation | `k0` fails: the alternative that names `commitSend` requires an event from the send surface with the send action, and no other alternative names this body. The constraint guards what the handler itself writes, so the event's transaction is rejected whole. No overlay entry is made, no derivation follows from it, and nothing renders. The client presents a predicted refusal (section 11.5) |
| 5 | Server | The same transaction, the same constraint, the same verdict. The event's whole transaction is rejected, the refusal is recorded as the entry's consequence, and the stream's watermark passes the entry. The other events of the batch are not affected |
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

One transaction per cause changes six things.

- **An entry is a transaction.** Today a handler's echo is one entry and
  each derivation its writes trigger is another, retired by coverage and
  arrival. Here an event's transaction is one entry: the handler's writes
  and the kept outputs evaluated before its body. The derivation
  transaction behind the client's batch is one more entry, whose origin is
  the events of that batch.
- **The consequence and its derivations arrive together.** On the server
  the event's transaction and the derivation transaction behind its batch
  seal into one wave, so the handler's writes and the derivations over
  them are pushed in one commit. An entry whose origin is an event retires
  when that event's terminal consequence arrives, and the derivation entry
  retires when the terminal consequence of every event of its origin has
  arrived. There are two exceptions. A derived write that was dropped by a
  constraint or withdrawn on a conflict (section 5.5) arrives with the
  transaction that stores it later, or not at all. And a cycle that ends on
  its budget closes its wave with what has sealed (section 8.3), so a
  derivation can arrive one wave behind the consequence. In both cases the
  entry retires on the consequence, and the page then shows the committed
  value until the later commit arrives.
- **The server's batch need not be the client's.** A client that fires two
  events evaluates one derivation transaction behind both. The server can
  handle them in two cycles. The client's derivation entry stays until
  both consequences have arrived, so the page shows the state after both
  events throughout.
- **An entry carries kept paths, not documents.** Today an overlay entry
  carries whole documents, and a standing entry hides a concurrent
  authoritative change to any other path of the same document
  ([speculation](../server-side-execution/speculation.md), §1). An entry
  of this design carries each kept path its transaction wrote, as a whole
  value, addressed by the result cell and the path, and each write-edge
  target by its address. A client decides no split of the keep set: it
  writes no part document and no storage link, and it reads a committed
  kept path from whichever document the server stored it in
  (`execution-and-storage.md` §4.10). An entry for one row therefore hides
  no other row and no other path, whether or not the server stores the row
  in a part document.
- **Identifiers agree, where a client can derive them.** A handling is
  identified by its receipt, the event's identifier and the stream
  (`handlingReceiptId` in `scheduler/event-identity.ts`), which is the same
  in the speculative and the served run. Every cell, instance and effect
  a handler requests without an explicit cause is named by the handling
  and its order among the handler's requests, and an event the handler
  sends by the handling and
  its order among the events that invocation sends
  (`plan-and-label-templates.md` §1.3; `execution-and-storage.md` §5.4).
  The cells, instances and effects a speculative handler requests are
  therefore the ones the served handler requests, which today they are not
  ([speculation](../server-side-execution/speculation.md), §4), and the
  echo of a sent event retires on that event's own consequence. The
  identifiers a client cannot derive are those of section 11.1:
  value-keyed per-element state, a part document at or below a row of a
  kept collection, and a binding with a copied path. What reads or uses one is
  pending on a client until a stored link arrives.
- **A refusal is predicted, not discovered.** An event's transaction that
  the server will reject for a gate of section 11.3 leaves no entry to
  retire. A derived write that a client's check drops is left out of its
  derivation entry, and the page keeps the committed value at that path.

The sources of divergence are the ones that remain: a clock or entropy a
handler reads, an input that is not replicated, an effect result, a body
that exceeds a budget on one side, and a label that changed between the two
evaluations. Each reconciles by replacement.

## 12. Open questions

Each entry states the assumption this document made. Entries keep their
numbers, because other documents cite them. A request marked "met" points
to where the other document has what was asked.

Ruled by the project owner, and written into the sections above: several
events are handled in one batch, an event's transaction holds no
derivation behind the body, and derivations settle once behind the batch
(5.1, 5.2, 5.4, 10.2); a failed constraint on what a handler itself writes
rejects the event's transaction, and one on a derived write drops that
write alone (5.5, 5.6); a change of demand is a cause of its own, with a
transaction that runs as the demanding principal (4.5); a conflict on a
derived write withdraws that write alone (5.5); a handling is identified
by its receipt (5.5, 11.6); a cone instance is evaluated at most ten times
in one transaction, and one that failed at the bound is not evaluated
again until an input changes (8.1); the identifier of a space an `inSpace`
request creates is obtained, and its allocation is recorded before the
step in that space (9.4); a client cannot read the element-key salt
(11.1); a client enacts `navigateTo` and no other effect (6.7); the keep
set is stored in several documents (4.2, 11.6); a binding of the reactive
tier copies nothing, and a binding made in a function body binds a stored
container by reference (5.2, 11.1); a `lift` or a `computed` may
instantiate a pattern (2.7); an event is routed to an instance that is not
loaded through a stream index, aligned with what server-primary execution
does for a queued event (5.1); a read of a cell whose writer is in an
instance that is not loaded returns the stored value where the basis index
shows it current, and loads the instance only where it shows it stale
(4.4, 5.3, 10.4).

### Needing the project owner

1. **The extent of a rejection across instances.** Ruled. Only a
   constraint on what a handler itself writes rejects an event. A
   constraint on a derived write of any instance drops that write alone
   (sections 5.5 and 5.6).
2. **A change of demand as a cause.** Ruled (section 4.5). One reading is
   this document's: a stale cone instance of space scope that a change of
   demand reaches is evaluated for no principal, like every evaluation of
   space scope (sections 4.5 and 10.3; question 34 below).
3. **Derivations per event, and the storage changes of a batch as one
   cause.** Ruled for events: derivations settle once behind the batch
   (section 5.4). That the changes one cycle drains from storage join the
   same derivation transaction is this document's decision (section 10.2).
4. **Which writes withdraw alone on a conflict.** Ruled: a derived write
   (section 5.5). The writes that used what it staged are withdrawn with
   it, which `plan-and-label-templates.md` §4.6 states and lists for the
   owner to confirm (its open question 28). A withdrawal that reaches a
   handler's own writes requeues the event.
5. **Demand across spaces.** *Assumed, and recommended:* the session a
   serving runtime holds on another space counts as demand there and as a
   reason to activate it (section 9.2, option B). Until then a derived value
   of another space is read as stored. It is question 16 of the
   continuation plan.
6. **One commit sequence across spaces.** *Assumed, and recommended:* one
   ordered sequence with no atomicity (section 9.4, option 2): the genesis
   of a created space, its allocation record, the access changes, the
   batches for other spaces, then the home writes. That the allocation
   record precedes the step in the created space is ruled. The alternative
   that closes the gap of I11 is a protocol with a prepare phase. It is
   question 15 of the continuation plan, which states the same five
   steps.
7. **Presenting a predicted refusal.** *Assumed:* no speculative result, an
   advisory outcome to the host and the caller, a mark on the control, no
   state a pattern can read, and the event is appended regardless (section
   11.5). It is question 23 of the continuation plan.
8. **A change of label alone.** *Assumed:* a demanded kept output is
   instantiated again when a slot's label changes, without evaluating value
   code (section 3.6). `plan-and-label-templates.md` §4.1 states the same
   assumption, and it is in the specification change. It is question 11 of
   the continuation plan.
9. **The bounds.** The bound inside one transaction is ruled: ten
   evaluations of one cone instance, a placeholder fixed with the plan
   version (section 8.1). *Proposed:* 10 runs of a materializer or of an
   effect's request transaction per cycle (section 8.3). Two cycles are
   not closed: an effect whose completion changes its own request, and
   derivations in two spaces that read each other (section 8.4). They are
   question 20 of the continuation plan.
10. **Event order per space.** *Assumed:* the proposal in Scheduler v2 §7.5,
    which awaits a ruling there. It is question 21 of the continuation
    plan.

<!-- The list restarts so that the numbers of the next list stay as cited. -->

34. **The acting principal of an evaluation of space scope.** *Assumed:* a
    cone instance of space scope is evaluated for no principal, whichever
    cause its transaction has, as a derivation of space scope is run for
    none today (sections 4.5 and 10.3). Two things follow. A change of
    demand "runs as the demanding principal" for the scope instances of
    that principal and not for a space-scoped cone instance it reaches.
    And an `inSpace` instantiation made by a computation of space scope
    has no identity to author its step in the other space, so it is
    refused and the cone instance fails (section 9.3). The alternative for
    the second is to author the step as the principal whose event or
    demand caused the evaluation, which a derivation transaction behind a
    batch of several principals' events cannot name.
35. **Compiled and builder-path instances in one space.** *Assumed:* until
    the builder form is retired, one serving runtime hosts Scheduler v2
    for the builder-path instances of a space beside the scheduler of this
    document, with one change channel, one event queue and one wave
    (section 10.8). It is question 24 of the continuation plan.
36. **The requester of an effect that a cone instance of space scope
    requests.** *Assumed:* the request transaction of an operation of a
    plan acts as the principal of the scope key of the cone instance that
    staged the request. At space scope there is none. A built-in that
    needs no requester is requested with no principal. The operation of a
    built-in that needs one, such as `agent`, has user or session scope
    whatever the scope of the cone instance, its unit exists per principal
    that demands its result, and without one it is not requested. Where
    `builtin-inventory.md` gives a built-in no behavior, the request is
    refused and the result takes the refusal as an error state (section
    6.2; that document's "The requester of a request"). It extends
    question 45 of the continuation plan. The principal of a completion
    transaction and of a materializer's run is not decided.
37. **The element slots of a handler whose key two positions hold.**
    *Assumed:* they are bound at every position that holds the key, and
    each resolves to the join over those positions (section 5.1). It is
    open question 27 of `plan-and-label-templates.md` and part of
    question 40 of the continuation plan.
38. **The recovery of a pending effect that a handler requested.**
    *Assumed:* activation reads the pending-effect rows and runs a request
    transaction for each, which follows the references of the stored
    request again, checks the egress ceiling on the content as it is
    then, and sends that content, acting as the principal the row names
    (section 2.3). A request that passed its ceiling when the event
    committed can therefore be refused at the recovery, after the event's
    other writes are stored, and the content that leaves can differ from
    the content the first request read. The alternative stores what the
    first request read with the operation's state.
39. **A read of something that an instance that is not loaded writes and
    that names it nowhere.** *Assumed:* the read returns what is stored,
    for a cell written through a handle and for a path of a child's
    argument document (sections 4.4, 5.3 and 10.4). The first is question
    57 of the continuation plan. The second extends it: a handler of a
    child whose parent is not loaded reads a computed argument as stored.
    The alternative has the child's result document hold a link to the
    instance that writes its argument, and adds the write edges of kind
    `argument` to the check of section 10.4.
40. **The teardown of an instance in another space.** *Assumed:* the home
    transaction stages the mark as an authored batch for the other space,
    under the principal of the scope key the making cone instance is
    evaluated for, and the other space's loop does the scheduler's part
    and writes the marks of the instances that belong to the torn-down one
    in its space (section 9.3). That `inSpace` is legal at such a site is
    question 50 of the continuation plan.

### For another document or the prototype

11. **Reads through handles are made current at the read**
    (`execution-and-storage.md`). Met by its §1.4 and §2.4 for a writer in
    a loaded instance of the same space. Where the writer's instance is
    not loaded, the ruling decides (sections 4.4, 5.3 and 10.4): the read
    returns the stored value where the basis index shows it current. Where
    it shows it stale, a handler's attempt is withdrawn, the instance is
    loaded, and the event is dispatched again, and a cone instance in a
    derivation transaction reads what is stored and is evaluated again
    after the writer. Question 28 has the cost.
12. **A slot's value is supplied when it is first read**
    (`execution-and-storage.md`). Met by its §2.2 (section 4.3 here).
13. **An effect's request is stored** (`execution-and-storage.md`). Met in
    another form than this document assumed: the request is not a kept
    output. Each path of it is a write edge with the target `request`,
    staged into the operation's state document
    (`plan-and-label-templates.md` §1.1 and §3.14;
    `execution-and-storage.md` §6.4; section 6.2 here).
14. **Scope instances per cone** (`execution-and-storage.md`). Met by its
    §1.8 (section 2.1 here).
15. **Which cones are stale** (`execution-and-storage.md`). Met by its §2.2
    and §3.3: the scheduler reports dirty slots, cone evaluation marks and
    checks memo entries, and a slot only an unselected branch reads is in
    no entry (section 2.2 here).
16. **Overlay entries and the identifiers of sent events.** The first half
    is this document's own subject and is decided in section 11.6: an
    overlay entry carries kept paths. The second is met by
    `plan-and-label-templates.md` §1.3 and `execution-and-storage.md`
    §5.4: an event a handler sends is identified by the handling and its
    order among the events that invocation sends.
17. **A materializer's envelope in the plan**
    (`plan-and-label-templates.md`, `footprint-analysis.md`). Met by
    `Operation.implementation` and §3.11 of the first, and §6.2 and §6.3
    of the second: the envelope is the `writes` and the `envelopes` of the
    body (sections 2.4 and 7.2 here).
18. **A failed cone's write-edge targets** (`plan-and-label-templates.md`).
    Met by its §5.2: a side-write is withdrawn, and a path of a child's
    argument or of an effect's request takes the error state (section 8.2
    here). The source position the diagnostic wanted is `Cone.at`.
19. **Which transaction a failed egress ceiling rejects**
    (`plan-and-label-templates.md`). Met by its §3.14: the operation's own
    request transaction for a request of the reactive tier, and the
    event's transaction for a request a handler makes (section 6.3 here).
20. **Per effectful built-in: when it is demanded and which time gates it
    declares** (`builtin-inventory.md`). Met by its "When an effect is
    demanded, and its time gates": an operation of a plan is demanded with a
    path of its result, every request a handler makes is sent when its event's
    transaction commits, the two claim timeouts stay, and the debounce of
    `wish` has no counterpart, which it assumes. It takes the rule for a
    `navigateTo` of the reactive tier from section 6.2 here.
21. **A diagnostic for a cycle through a side-write**
    (`language-subset.md`). Met by `side-write:cycle` in its §10.3, a
    warning (section 8.2 here).
22. **The granularity of basis rows** (the prototype). Section 10.4 assumes rows
    per cone.
23. **What a client is told about the deployment** (the prototype, and the
    server-execution documents). Section 11.3 needs the sink ceilings, and
    section 10.5 the accepted compiler builds. *Assumed:* neither is
    available to a client yet, so a client does not predict an egress
    refusal.
24. **Writers the compiler does not see** (`footprint-analysis.md`). Met by
    its §8.5: until a binding to a handler factory value is resolved, what
    the handler may write is bounded by position, from the `link` entries
    of `Binding.state` at writable positions of the declared state type
    (sections 2.6 and 8.2 here).
25. **Where compiled patterns are stored** (the prototype, and
    [module loading](../module-loading.md)). Section 10.5 assumes the space
    of the instance, written by the serving runtime alone.
26. **The stream index** (`execution-and-storage.md`, and the prototype).
    Ruled: one row per stream in the space's store, beside the basis
    index, from the stream's identifier to the instance and the binding
    (section 5.1). It answers question 6 of that document, how an event
    reaches its binding when no stream document is written at setup. The
    row takes the place of the back-link that setup stores on a stream's
    document today and of the walk that follows it; the entries, the
    drain, the queue and the registry in memory are kept. Its §4.7 and
    §4.9 count no document for a stream that received no event, and one
    row. An event on a stream with no row is deferred under the deferral
    budget of today and is not dropped at once, which is part of the same
    ruling. What remains for the prototype is the size of the index.
27. **Materializers on a client** (the prototype). *Assumed:* a client runs
    no materializer, and reads what a materializer wrote as committed
    (section 7.2). The alternative runs it inside the speculative
    transaction of the cause that made it invalid, which needs today's
    label rule on a client.
28. **A handler's journaled read of an output of an instance that is not
    loaded** (the prototype). Ruled: the basis index decides. Where it
    shows the stored value current, the read returns it and the instance
    is not loaded. Where it shows it stale, the instance is loaded and the
    event runs again (section 5.3). What a handler reads then does not
    depend on what other sessions have loaded. The prototype has to
    measure how many handlers of the corpus read outputs of other
    instances through handles of `Body.handles`, how many rows one check
    reads (section 10.4), and how many loads one event causes.
29. **The remote-echo gate** (the prototype). *Assumed:* it has no case for
    a cone instance, because the loop it bounds needs two runtimes that
    commit derived writes to one document (section 8.4).
30. **The mark on the instances that belong to a torn-down instance**
    (`execution-and-storage.md`). Met by its §2.8: the transaction that
    marks an instance a computation no longer makes marks that instance's
    children of the reactive tier, the instances its computations made,
    and the instances that belong to those in turn, so that none of them
    is loaded again through a link another document holds (section 2.7).
    Question 40 has the case of an instance in another space.
31. **Trigger reads across a restart** (`plan-and-label-templates.md`, and
    the specification change). Met by its §3.10 ("Trigger reads across a
    restart"). The trigger reads a `dynamic` node held are lost with the
    process. The evaluation that the basis rows cause after a restart
    joins the labels of what it reads then, and not the label of an
    address that changed before the restart and that it no longer reads
    (section 3.4). That covers what the value depends on, with one
    exception: a body that makes a sampled read can be evaluated because
    of a change at an address that it does not read again, and after a
    restart the label of that address is not joined. The exception is an
    accepted residual, equal to today, which that document assumes and
    lists for the owner (its open question 29). A basis row names a
    document and no path, so it cannot stand in for the trigger read.
32. **To `plan-and-label-templates.md`: two wordings.** Met. Its §4.4
    says of a dropped derived write, and of a withdrawn one whose
    conflict was on the target alone, that the cone instance that
    computed it is current and its output is unstored. Those are the
    terms of this document and of `execution-and-storage.md` §3.3
    (section 3.5). And its open question 20 lists what it needs from this
    document, each of which is met: the chain of a slot and of a
    `resolved` slot (3.2), sampled reads (3.1), a journaled label-metadata
    observation (3.4), the deletion answer of a space (3.4), the request
    transaction run again when content behind a reference changes (6.2),
    what waits for a materializer with a creation-site envelope (7.2), the
    readers of a cell written through a handle the instance computed
    (2.6), and the event whose handler's unit a withdrawal reaches (5.5).
33. **To `footprint-analysis.md`: its request 9.** Met. The static entries
    of a handler are what is evaluated before its body, and a read through
    a handle of `Body.handles` is not known before the body runs (sections
    5.2 and 5.3); the envelope of a materializer is its body's `writes`
    and `envelopes` (section 2.4); the compile-time report of cycles is
    computed from `Plan.edges` (section 8.2); and which instances the last
    evaluation of a computation made at each site is kept by cone
    evaluation, with the scheduler tearing down the ones an evaluation no
    longer makes (section 2.7).
