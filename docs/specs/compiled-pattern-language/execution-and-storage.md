# Execution and storage (proposed)

**Status:** proposed. Nothing here is implemented. This document details one
part of the [compiled pattern language](README.md): what the runtime does
inside the transaction of one cause for one pattern instance, and what it
stores. It proposes answers to two questions the overview lists as open, the
cost model for cache promotion (section 8) and the migration of stored
instances (section 9).

Label rules are not defined here. They are defined in
`plan-and-label-templates.md` and ruled on in `commonfabric/specs`, as
[the correspondence procedure](../../development/cfc-spec-correspondence.md)
requires. Where this document needs a label the plan does not give, it states
the assumption and lists it under [Open questions](#11-open-questions).

Five documents beside this one own their subjects, and this document refers
to them by name without defining their content:

- `language-subset.md`: the source constructs and their tiers;
- `plan-and-label-templates.md`: the plan's records, label templates,
  instantiation, error states;
- `builtin-inventory.md`: each built-in, the element key rule, and which
  operations have durable state;
- `footprint-analysis.md`: the analysis that fills in a body's footprint;
- `scheduler-and-serving-loop.md`: everything across instances. That document
  owns dirty slots from the change channel, demand, the event queue, effects
  with their gates and retries, the scheduling of materializers, convergence
  bounds across instances, links across spaces, and client speculation.

The boundary with the last one is this: it decides *that* an instance is
evaluated for a cause, *which* slots are dirty, and *which* outputs are
demanded. This document says what the evaluation does with those three
inputs and what is written.

## Contents

1. [One transaction per cause](#1-one-transaction-per-cause)
2. [Cone evaluation](#2-cone-evaluation)
3. [The in-memory memo](#3-the-in-memory-memo)
4. [The keep set and the layout of a result document](#4-the-keep-set-and-the-layout-of-a-result-document)
5. [Causal identifiers](#5-causal-identifiers)
6. [Durable state of operations](#6-durable-state-of-operations)
7. [Provenance](#7-provenance)
8. [Cache promotion](#8-cache-promotion)
9. [Migration of stored instances](#9-migration-of-stored-instances)
10. [Worked example: a FabriChat send](#10-worked-example-a-fabrichat-send)
11. [Open questions](#11-open-questions)

## Terms

The terms of `plan-and-label-templates.md` are used as defined there: path,
instance, cone, slot, template, kept output, plan. This document adds five.

- A **cause** is what a transaction is opened for: an event delivered to a
  handler, a change arriving from storage, or the completion of an effect.
- A **scope instance** of a document is the document as one scope key
  addresses it: the space's, one user's, or one session's
  ([scoped cell instances](../scoped-cell-instances.md)).
- A **cone instance** is one cone of the plan as it is evaluated for one
  scope key and, inside element bodies, one element key per enclosing
  collection. A cone outside every element body has one cone instance per
  scope key it is evaluated for.
- An **evaluation** of an instance is one run of the procedure of section
  1.2 for one cause.
- A **fingerprint** is a value that changes whenever the result of a read
  changes. Section 3 says what it is made of.

## 1. One transaction per cause

### 1.1 Causes

There are three kinds of cause. Each opens one transaction in one space.

| Cause | What it carries into the transaction | First step |
| --- | --- | --- |
| An event delivered to a handler | The event's payload, its key and its acting principal (the `event` and `cause` slot roots), and the binding the stream belongs to | The handler's read closure (section 1.3) |
| A change arriving from storage | The slots whose bound addresses changed: a write by another instance, by another runtime, or by the runtime itself, such as a clock tick (`plan-and-label-templates.md` §3.19) | Evaluation of the demanded outputs those slots dirty (section 1.5) |
| The completion of an effect | The settled result or error of one effect operation, and the operation it belongs to | The write of the result into the operation's state (section 6.4), which dirties the `operation` slots |

*Assumed:* the first evaluation of an instance, and an evaluation that
happens because demand appeared for an output whose cone is not current, are
presented by the scheduler as a cause of the second kind, with the slots it
cannot show to be unchanged reported as dirty. Section 3.4 says what this
document needs from the scheduler for that.

A cause's transaction can evaluate more than one instance: a pull of an
output extends through a link into the producing instance, and a child
instance in the same space is evaluated in the cause's transaction
(`plan-and-label-templates.md` §3.15). The order in which instances are
evaluated belongs to `scheduler-and-serving-loop.md`. This section describes
the part of the transaction that concerns one instance, and every step below
is per instance unless it says otherwise.

### 1.2 The sequence

The transaction of a cause, for one instance, has these steps in this order.
Steps 1 and 2 exist only for an event.

| Step | What happens | Governed by |
| --- | --- | --- |
| 0. Bind | The cause's slots are bound: `event` and `cause` roots for an event, the dirty slots for a change, the `operation` root for an effect completion | Section 1.1 |
| 1. Before the body | The cones in the handler's static read closure that are not current are evaluated | Section 1.3 |
| 2. The body | The handler body runs once. It stages writes and requests | Section 1.4 |
| 3. After | The cones that the cause dirtied and that something demands are evaluated, to a fixed point bounded as section 2.7 says | Sections 1.5 and 2 |
| 4. Staged requests | Cells, child instances, effect requests and bindings the body asked for are given their identifiers and their initial documents | Sections 1.4, 4.6 and 5.4 |
| 5. Instantiation | The template of each kept output whose cone was evaluated, and of each write edge, is instantiated when its instantiation key changed | `plan-and-label-templates.md` §4.1 to §4.3 |
| 6. Constraints | The constraints of those outputs and write edges are checked | `plan-and-label-templates.md` §4.4 |
| 7. Write and commit | Changed values, labels and provenance are staged, the preparation takes its snapshot, and the transaction commits | Sections 1.6, 1.9 and 4 |

Nothing reaches storage before the commit of step 7. Steps 1 to 6 read
storage through the transaction and hold their results in the transaction
and in the memo of section 3. Steps 5 to 7 together are the commit
preparation of the cause's transaction (section 1.9).

The runtime may also check a write edge's constraints as soon as the edge's
template can be instantiated, which for a handler's own writes is at the end
of step 2, so that a cause that will be rejected stops before step 3. The
check in step 6 is still made. The outcome is the same, because a failed
constraint rejects the whole transaction wherever it is found.

### 1.3 Before a handler body

A handler's read closure is static: the plan lists the slots the body reads
(`Body.reads`) and the cell handles it receives (`Body.handles`). The cones
evaluated in step 1 are the ones that compute a value in that closure and are
not current. They are found from the plan alone.

- **The state a reactive-tier binding carries.** A `Binding` of the reactive
  tier records, for each path of the handler's state, the template of the
  expression bound to it. Where that expression is computed by a cone, the
  cone is in the closure. Its value is materialized into the handler's
  argument when the event is delivered, so the body sees the value as of the
  event and not as of an earlier evaluation.
- **State cells that a cone writes.** A state cell the handler reads, or
  holds a handle to, can be the target of a static side-write. The plan
  records that as a `ConeEdge` through the state cell. The writing cone is in
  the closure, and so is every cone it depends on.
- **Nothing else.** A slot with root `event`, `cause`, `argument`, `state`
  (with no writing cone), `operation` or `child` is read from storage or
  from the cause. No cone computes it in this instance. A `child` slot or an
  argument link whose producer is another instance is brought up to date by
  the pull across instances, which the scheduler orders.

The body's reads through handles are not known before it runs. They are
journaled while it runs (section 2.4). A materializer whose envelope such a
read falls in is promoted by the scheduler, as today.

*Assumed:* a binding of the reactive tier stores nothing. Its copied captures
are slots and cone outputs of the instance, read when an event arrives. Only
a binding made in a function body has a stored state document (section 4.7).
`plan-and-label-templates.md` §3.14 describes the stored document for the
second case and does not say which holds for the first.

### 1.4 The body

The runtime builds the handler's argument from exactly the slots in
`Body.reads`, each validated against its slot's schema
(`plan-and-label-templates.md` §5.2), hands the body the listed handles, and
calls it once. During the call:

- A **write through a handle** is staged in the transaction. The runtime
  checks it against the body's `Body.writes` and refuses a write the record
  does not list (`plan-and-label-templates.md` §7.4).
- A **read through a handle** is a read through the transaction and is
  journaled for the body's `dynamic` template.
- A **request** (`Body.calls`) is recorded and returns at once: a link to an
  instance, a handle to a cell, a link to an effect's result, or a stream.
  The identifier in what is returned is computed from the request alone
  (section 5.4), so the body can store it, pass it on, or read `spaceOf` from
  it in the same invocation.
- An **event sent to a stream** is staged. It is delivered after the commit,
  as a cause of its own.

When the body returns, its staged writes dirty the slots bound to the
addresses they wrote, exactly as a change from storage would.

### 1.5 After the body, and for the other two causes

Step 3 is the same for all three kinds of cause. Its input is a set of dirty
slots and a set of demanded outputs. For an event the dirty slots are the
ones the body wrote. For a change they are the ones the scheduler reported.
For an effect completion they are the `operation` slots of the completed
operation.

The runtime evaluates the cone instances that are both dirty and needed for
a demanded output, in the manner section 2 describes, and repeats while a
side-write made during the step dirties a cone instance already evaluated
(section 2.7). A cone instance that is dirty and not needed stays dirty: its
kept outputs keep their stored values and labels until something demands
them (`plan-and-label-templates.md` §5.5).

Step 4 then performs what the body requested. A requested cell is written
with its initial value. A requested child instance gets its argument
document, and its result document when its link was written into state or
passed to `navigateTo`. An effect request writes the operation's pending
state. A binding made in the body writes its state document. A child
instance in the same space that something demands is evaluated in this
transaction, by the same procedure.

### 1.6 Instantiation, constraints, and commit

Steps 5 and 6 are `plan-and-label-templates.md` §4. This document adds what
they act on and what step 7 writes.

- **What is instantiated.** The kept outputs whose cone instance was
  evaluated in this transaction, the write edges of every body and cone that
  wrote, the arguments of requested children, and the outputs a forced or
  promoted cache stores (section 8). An interim value is not instantiated.
- **What is written.** For each kept output: its value, when the value
  changed; its label entries, when the instantiation key changed; its
  provenance record, when the key or the template changed (section 7). For
  each staged write to a state cell, a created cell, a child's argument, or
  an operation's state: the value and the label of its write edge. Section 4
  gives the layout.
- **What is not written.** A kept output whose value and instantiation key
  are both unchanged produces no write. This is the equality cutoff: a cause
  that changes nothing a reader can see commits nothing for that output.
- **Commit.** The transaction commits once. Section 1.9 relates the commit
  to commit preparation as it exists today.

### 1.7 Failure

Two kinds of failure have different outcomes, and
`plan-and-label-templates.md` §5 governs both.

- **A failed constraint rejects the whole transaction.** Nothing the cause
  would have written is committed: no handler write, no kept output, no
  requested cell, instance, effect or binding. The memo keeps the values of
  cones that performed no side-write (section 3.3), because they are pure
  derivations of state the rejection did not change. The rejection is
  reported to whoever delivered the cause. What it reveals is bounded as
  `plan-and-label-templates.md` §5.5 says.
- **A failed cone takes a labeled error state and the rest commits.** The
  failed cone instance's outputs hold an error state whose label is the
  output's template instantiated with the selections made up to the failure.
  A kept output stores the error state at its path with that label. A cone
  that reads the errored value fails in turn. Every other cone instance
  evaluated for the cause commits normally.
- **A handler body that throws aborts the transaction**, as it does today.
  Its staged writes and requests are discarded and step 3 does not happen. A
  handler that receives an error state for one of its inputs, because a cone
  in its read closure failed in step 1, fails in the same way.

A cone instance that fails stays dirty in the sense of section 3: the next
cause that demands it evaluates it again.

### 1.8 Scope instances

A cone's output can depend on state that differs by user or by session, and
such an output has one value per user or per session. FabriChat's rows are
the reference: each row derives values from the room's per-session `composer`
cell and from its own per-session `pickerOpen` cell
(`patterns/system/fabrichat/message-row.tsx`).

- **The scope of a cone instance** is the narrowest scope among the
  addresses its slots are bound to and its dynamic reads touched, in the
  order `space`, `user`, `session`. This is the rule built-ins apply to
  their stores today (`builtin-inventory.md`, "the narrowest scope the input
  read touched"). The plan bounds it from below where a slot's root has a
  declared scope: a state cell's `scope`, a child's `scope`.
- **Evaluation is per scope key.** A cone instance of space scope is
  evaluated once for a cause. A cone instance of user or session scope is
  evaluated once per scope key that demands it, with the slots of that scope
  bound to that key's scope instances.
- **Storage is per scope instance.** A kept output of narrower scope is
  stored in the scope instance of the result document for that key (section
  4.2).

*Assumed:* the scheduler says which scope keys demand an instance, and one
cause's transaction may hold the evaluations for several scope keys, each
attributed to its acting principal as the
[serving loop](../server-side-execution/serving-loop.md) (§3c, §3d)
attributes an action run today. Labels stay per scope instance because each
kept output's label is instantiated from its own bound slots, never from a
union over the transaction.

### 1.9 Relation to CFC commit preparation as it exists today

Today `ExtendedStorageTransaction.commit()` materializes schema documents
and runs `prepareForCommit()`, which probes whether the transaction is
relevant to CFC and, when it is, runs the verification of `prepareCfc()`
([CFC commit preparation](../cfc-commit-preparation.md)). That verification
derives one join over the transaction's counted reads (`deriveFlowJoin` in
`runtime/runner/src/cfc/prepare.ts`), stamps it on every written path,
persists the label map, and ends by taking the snapshot the prepared digest
is computed from. One node run is one transaction, so a load of a
thirty-message room made 615 preparations for 190 commits
([row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md)).

A cause's transaction goes through the same entry points in the same order.
Four things differ.

1. **One preparation per cause.** The preparation runs once. It is steps 5
   and 6 and the staging of labels in step 7, over everything the cause
   wrote for every instance and scope key it evaluated.
2. **Where a written path's label comes from.** For a path the plan covers
   (a kept output, a write edge, a created cell, a child's argument, an
   operation's state), the preparation calls `instantiateTemplate` with the
   path's template and its bound slots, in place of stamping the
   transaction's join. The preparation performs the instantiation itself. It
   does not accept a label a caller computed, which keeps the property that
   no caller supplies what the verifier verifies. The persist step is
   unchanged: it writes envelope entries of the existing shape
   (`plan-and-label-templates.md` §2.3).
3. **What the prepared digest binds.** Today the digest is derived from the
   journal and from the decision inputs recorded beside it. With templates,
   the labels are a function of more than the journal: the identity of the
   compiled pattern, and for each instantiated template its instantiation
   key (the slot-free template hash, the selections the value code reported,
   and the label identifiers of the bound slots). *Assumed:* these are
   recorded on the transaction as decision inputs, through the same
   recording interface the write-policy inputs use, so that the snapshot,
   the activity epoch and the commit-time recheck cover them without a new
   mechanism. A read, a write or a new decision input after the preparation
   invalidates it as it does today.
4. **What the journal is still for.** Reads made to materialize slots, reads
   through handles and reads through links are journaled as today. The
   journal remains the commit's read set for conflict detection, and it
   remains the source of the `dynamic` templates. It is no longer the source
   of the label of a plan-covered path.

A write the plan does not cover is not part of a cause's transaction for a
compiled instance. A materializer keeps its own transactions and today's
derivation (`plan-and-label-templates.md` §3.11).

The serving loop forbids label unions over a wave and places the CFC check
at the end of each action run
([serving loop](../server-side-execution/serving-loop.md), §3c). One
transaction per cause removes the action run as a unit. What that section
protects, that one action's secret read does not taint another action's
write, is kept by the templates: each written path is labeled from its own
slots. How the wave and the cause's transaction relate is for
`scheduler-and-serving-loop.md`.

## 2. Cone evaluation

### 2.1 The unit

The unit of value code is the cone: one emitted JavaScript function per
`Cone` record of the plan, named by `Cone.entry` and addressed by
`Cone.code`. A cone computes one or more outputs (`Output.cone`), kept or
interim, and may perform static side-writes (`Cone.writes`).

The compiler partitions the pattern body into cones. This document assumes
the following about that partition, which `plan-and-label-templates.md`
records without stating:

- Every value the instance computes is computed by exactly one cone. A
  value two outputs depend on is an interim output of the cone that computes
  it, not a copy inside each consumer.
- A cone that uses a value another cone computes has a `ConeEdge` from that
  cone with `via.kind` `output`. `Plan.outputs` therefore lists interim
  outputs (`kept: false`) as well as kept ones.
- The body of an element construct (`map`, `filter`, `flatMap`, a predicate,
  a selector) is one or more cones whose slots include `element` roots.
  They are evaluated once per element key (section 2.5).

### 2.2 Invocation and inputs

The runtime invokes a cone's function with one argument, a host object, and
the function returns a result record. Both are plain data apart from the
host's two functions.

```ts
type Index = number;

/** What the runtime hands a cone's value function. */
export interface ConeHost {
  /**
   * The value of each slot in `Cone.slots`, by slot index, already
   * validated against the slot's schema. A slot of class `identity` holds a
   * reference, and a slot of class `shape` or `enumeration` holds only
   * what that class observes.
   */
  readonly slots: Readonly<Record<Index, unknown>>;
  /** The index of the element in its collection, when the body uses it. */
  readonly index?: number;
  /**
   * The value of an output another cone computes, by index into
   * `Plan.outputs`. Legal only for an output an incoming `ConeEdge` names.
   * The runtime evaluates the producing cone first when it is not current.
   */
  output(output: Index): unknown;
  /**
   * Runs a sandboxed body of `Cone.bodies`. The runtime builds the slot
   * part of the body's argument itself. `computed` holds the values the
   * body captures that this evaluation computed, by capture position.
   */
  invoke(body: Index, computed: readonly unknown[]): unknown;
}

/** What a cone's value function returns. */
export interface ConeResult {
  /** The value of each output this cone computes, by output index. */
  readonly outputs: Readonly<Record<Index, unknown>>;
  /** The branch taken at each selector the cone evaluated. */
  readonly selections: Readonly<Record<Index, number>>;
  /** The key a `pick` over a container chose, by slot index. */
  readonly picks: Readonly<Record<Index, string | undefined>>;
  /** The value of each static side-write, by index into `Cone.writes`. */
  readonly writes: Readonly<Record<Index, unknown>>;
}
```

Five rules hold for an invocation.

- **Slots are materialized by the runtime.** A cone's function never reads
  storage. It receives the slots in `Cone.slots` and nothing else from
  storage, which is the cone narrowing of `plan-and-label-templates.md`
  §7.3.
- **Other cones' outputs are pulled.** A cone asks for an upstream output
  when its code reaches the use, so an output used only in the unselected
  branch of a conditional is not evaluated. This is how demand stops at a
  `select`.
- **Selections are reported, not inferred.** The function returns the branch
  it took at each selector and the key each `pick` chose. The runtime needs
  them for the instantiation key (`plan-and-label-templates.md` §4.1).
- **Side-writes are returned, not performed.** The function returns the
  value of each static side-write. The runtime stages the write to the
  target the `WriteEdge` names. A cone's function holds no handle.
- **Collection operations are the runtime's.** A cone does not iterate a
  reactive collection. Section 2.5 says what the runtime does.

*Assumed:* a body's argument has two parts. The slot part is `Body.reads`,
which the runtime materializes. The computed part is the values the body
captures that are not slots, for example the result of an earlier
`computed`. `plan-and-label-templates.md` §1.1 lists slots only, and its
worked example already nests one body's template inside another's
(`T_empty` over `T_facts`), so the record needs a field for the computed
captures. This document assumes it has one.

### 2.3 Order

The order of evaluation within an instance is fixed by the plan and the
value code, so the runtime neither discovers read sets nor sorts.

- The runtime starts from the demanded outputs whose cone instances are
  dirty, in the order of `Plan.outputs`.
- Evaluating a cone runs its function. Each `host.output` call evaluates the
  producing cone first when that cone instance is not current, depth first.
- A slot with root `state` whose cell is the target of another cone's static
  side-write is treated like an upstream output: the writing cone is
  evaluated first when it is not current.
- A cone instance is evaluated at most once per pass, where a pass is one
  repetition of step 3 (section 2.7). A second request for its output in
  the same pass returns the value the first evaluation produced.

Because the value code is the same on the server and on a client, and the
order depends only on the plan, the demanded outputs and the values, two
runtimes that start from the same state evaluate the same cone instances in
the same order.

*Assumed:* `Plan.cones` and `Plan.outputs` are listed so that an edge that
is not part of a cycle goes from a lower index to a higher one. The runtime
does not depend on this for correctness, since it pulls. It uses it to
recognize a back edge (section 2.7).

### 2.4 Sandboxed bodies

`host.invoke` is where emitted code and sandboxed code join. For one call the
runtime:

1. builds the argument: the slot part from `Body.reads`, narrowed to those
   slots, and the computed part from what the cone passed;
2. hands the body the handles in `Body.handles` and brackets the call, so
   that every read made through a handle is journaled with its address;
3. calls the body in the sandbox, under its time and memory budget;
4. validates the result against the body's result schema, and checks each
   result path that `Body.outputs` declares as a passed or chosen reference
   by identity (`plan-and-label-templates.md` §3.9);
5. returns the result to the cone's function, or fails the cone when the
   body threw, exceeded its budget, or returned a value outside its schema.

The addresses journaled in step 2 become part of the cone instance's memo
entry (section 3.1) and are what the scheduler watches for that cone
instance beside its bound slots.

A `lift` or a `computed` may be called any number of times and has to
produce the same writes each time. The idempotency contract of
[Scheduler v2](../scheduler-v2/README.md) (§4.2) and its validator apply to
every body that writes, unchanged.

### 2.5 Element cones

`plan-and-label-templates.md` §1.3 and `builtin-inventory.md` ("Element
keys") define the key of an element. This section says what the runtime does
with it.

For a collection the runtime keeps, per scope key, an **element table**:
for each key present, the cone instances of the body for that key and the
positions that hold the key. It evaluates a `map` over the collection as
follows.

1. Read the collection's `enumeration` slot and each position's reference
   or plain value. This is the runtime's own observation
   (`plan-and-label-templates.md` §1.3) and is the only read of the
   collection the `map` itself makes.
2. Compute the key of every position. A position that holds a link is keyed
   by the identity of the cell it links to. A position that holds a plain
   value is keyed by the salted hash of the value (section 5.3). The index
   joins the key when `Collection.bodyUses` says the body uses it.
3. For each key not in the table, create its cone instances and evaluate
   them with the `element` slots bound to that element. Equal keys share
   one evaluation.
4. For each key in the table whose cone instances are dirty, evaluate them.
5. For each key in the table that no position holds any more, drop its cone
   instances and its memo entries. State cells and operation state declared
   under the key are not deleted by this step (section 9.6).
6. Assemble the result: position `i` receives the outputs of the cone
   instances of the key at position `i`. A hole stays a hole.

The assembled collection is an output like any other. A cone that uses it
pulls it with `host.output`, and it is stored when it is kept.

`filter`, `flatMap`, the aggregates, the collection index and the prefix
operations use the same table for their per-element cones. The structural
step that follows is the runtime's: dropping elements, concatenating
segments, folding, bucketing, scanning for the first match
(`plan-and-label-templates.md` §3.7, §3.8, §3.13, §3.17). For a derived
collection the runtime records one fact per source element, whether it was
included or the length of its segment, and derives each output position's
origin from those facts. Section 7.3 says where the facts are stored when
the derived collection is kept.

Nested element bodies nest tables: the cone instances of an inner body are
keyed by the outer element's key and then the inner one's, outermost first.

### 2.6 What a change re-evaluates

| Change | Dirtied | Evaluated when demanded | Written |
| --- | --- | --- | --- |
| A slot of one element changes (a field of a message is edited) | The cone instances of that element's key that have the slot in `Cone.slots` or in their journaled reads | Those cone instances, once | The changed kept paths of the positions that hold the key |
| A captured outer value changes | Every element's cone instances that read it | All of them | The changed kept paths |
| An element is appended or inserted | The collection's membership; no existing element's cone | The new key's cone instances | The new positions; for an insertion, the positions after it move in the stored array (section 4.2) |
| An element is removed | The collection's membership | Nothing | The stored array loses the position |
| Elements are reordered | The collection's membership | Nothing, unless the body uses the index | The stored array is rewritten in the new order; label entries only where the label at a position changed |
| The body uses the index and an element moves | The moved elements' cone instances | The moved elements | Their kept paths |
| The value behind a linked element changes | That element's cone instances; the key is unchanged | That element | Its changed kept paths |
| A plain value is edited in place | Membership: the old key leaves and a new key enters | The new key | The position |

A cone downstream of a collection, such as a `count` or a `filter` over the
result of a `map`, is dirtied through its own slots and upstream outputs in
the same way. A fold updates the contribution of the keys that changed and
does not visit the others (section 6.1).

The cutoff applies at every step: a cone instance whose evaluation produces
the outputs it produced before does not dirty its consumers.

### 2.7 Side-writes and bounded iteration

A static side-write makes an instance's cones cyclic when the written cell
is read by a cone the writer depends on. The compiler reports the cycles it
can see. The rest are handled inside the cause's transaction.

- **Detection.** When a pull reaches a cone instance that is already being
  evaluated, the request is a back edge. The requester receives the value
  the cone instance had before this pass: its memo entry or stored value,
  or `undefined` where the slot's schema admits it. The cone instance in
  progress is marked as read early.
- **Re-dirtying.** When step 3 stages a side-write to a cell, every cone
  instance that read that cell earlier in the transaction, or was marked as
  read early through it, becomes dirty again if the written value differs
  from what it read.
- **Iteration.** Step 3 repeats over the dirty cone instances that are
  needed for a demanded output. Each repetition is a pass, and a cone
  instance is evaluated at most once per pass.
- **The bound.** A cone instance is evaluated at most ten times in one
  transaction. Ten is `MAX_ITERS` of
  [Scheduler v2](../scheduler-v2/README.md) (§7.7), the bound on the
  iterations of one pass today. The right value needs measurement on the
  corpus once the write-path analysis says which side-writes are static.
- **Exhaustion.** A cone instance that would need an eleventh evaluation
  fails, with the error state and label of section 1.7, and so does every
  cone instance still dirty in the same cycle. This differs from today,
  where the remaining work is deferred behind a backoff gate and tried
  again, so that a graph needing more than ten iterations still converges.
  A cause's transaction has to end, and `plan-and-label-templates.md` §5.2
  makes non-convergence a cone failure. A later cause evaluates the failed
  cone instances again, starting from the values the failed attempt did
  not commit. How many patterns of the corpus need more than ten
  iterations today is part of the same measurement.

A handler's writes are not side-writes of a cone, but they enter the same
iteration: a state cell the handler wrote that a cone evaluated in step 1
had read makes that cone instance dirty for step 3.

A cell that a handler factory value may write counts as written by an
unknown handler (`plan-and-label-templates.md` §3.21). It can re-dirty any
cone that reads it, and the bound above is what limits the effect.

## 3. The in-memory memo

### 3.1 What is memoized

The runtime keeps, in process memory, one entry per cone instance it has
evaluated.

```ts
type Index = number;
type Hash = string;

/** One address a cone instance read, with what the read returned. */
export interface ReadFingerprint {
  /** Space, document identifier, scope key and path, canonicalized. */
  readonly address: string;
  /** The observation class of the read. */
  readonly observes: string;
  /** Changes whenever the result of the read changes (section 3.2). */
  readonly fingerprint: string;
  /** The identifier of the label the read consumed. */
  readonly label: Hash;
}

/** The memo entry of one cone instance. */
export interface MemoEntry {
  /** The reads of the slots in `Cone.slots`, by slot index. */
  readonly slots: Readonly<Record<Index, ReadFingerprint>>;
  /** Reads through handles and links, in the order they were made. */
  readonly dynamic: readonly ReadFingerprint[];
  /** The upstream outputs the evaluation pulled, by output index. */
  readonly upstream: Readonly<Record<Index, string>>;
  /** What the cone's function returned, or the error state it took. */
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
  /** The transaction that staged the cone's side-writes, if it made any. */
  readonly wroteIn?: string;
  /** Whether a slot or dynamic read was reported changed since. */
  dirty: boolean;
}
```

The entry holds everything a later evaluation needs to decide that the cone
instance is current and everything a consumer needs from it: its output
values, its selections and picks, and the label identifiers its reads
consumed. The last is what lets step 5 form an instantiation key for a kept
output without resolving a label again.

Two further memos exist beside it.

- **The label memo** of `plan-and-label-templates.md` §4.3, keyed by
  template hash, selections and slot label identifiers. It is shared across
  instances and patterns.
- **A body memo**, optional. A body with no handles and no writes is a
  function of its argument, so its result may be memoized by `Body.code` and
  a hash of the argument, across cone instances and across instances. This
  is what makes equal plain values in two collections cost one call.

### 3.2 Keys and fingerprints

An entry is keyed by:

1. the identifier of the instance's result cell and the space it is in;
2. the identity of the compiled pattern (`CompiledPattern`), so that no
   entry survives a pattern update;
3. the scope key the cone instance was evaluated for;
4. the cone's index in the plan;
5. the element keys of the enclosing element bodies, outermost first.

A read's fingerprint is the version of the scope instance of the document
the read went to, together with a comparison of what the read returned at
its path and class. The version alone would dirty a cone on every write to
the document, including writes to paths the cone does not read. The
comparison is what gives the cutoff of section 2.6. Stored values are
immutable, so the comparison is by reference where the replica shares
structure and by hash otherwise.

### 3.3 Invalidation

- **Marking.** When the scheduler reports a dirty slot, the runtime marks
  the entries of the cone instances bound to that address, by slot or by
  dynamic read. Marking is all that happens outside an evaluation.
- **Checking.** When a marked entry is needed, the runtime re-reads the
  marked addresses and compares fingerprints. If none differs, the entry is
  current again and nothing is evaluated. A write to a path the cone does
  not read ends here. If only the label identifier of a read differs, the
  entry's values stay, its label identifiers are updated, and the kept
  outputs that depend on it get a new instantiation key in step 5: a label
  changes without an evaluation (`plan-and-label-templates.md` §4.1).
- **Upstream.** An entry is not current when an upstream output it pulled
  has a different value from the one recorded. The check is made when the
  entry is needed, after the upstream cone instance has been brought up to
  date.
- **Side-writes.** An entry whose cone performed side-writes records the
  transaction that staged them. If that transaction does not commit, the
  entry is dropped: the writes did not happen, and a later evaluation has
  to perform them. An entry with no side-writes survives a rejected or
  aborted transaction, because it is a pure derivation of state the
  transaction did not change (`plan-and-label-templates.md` §5.4).
- **Removal.** Entries are dropped when their element key leaves its
  collection (section 2.5), when the instance is stopped, when the compiled
  pattern changes, and under memory pressure in any order the runtime
  chooses.

### 3.4 Lifetime, and what the memo needs from the scheduler

The memo lives in one process. It is not written to storage, not sent to
another runtime, and not shared between a client and the server. A server
process that restarts starts with no entries. A client keeps its own.

After a restart, or when an instance that was not demanded is demanded
again, there is no entry to mark. The runtime then has to know which cone
instances are current in storage.

*Assumed:* for an instance the scheduler can report the slots that changed
since a given commit sequence number of the space. The runtime asks with the
sequence number of the last commit that wrote the instance's result document
or one of its operation state documents. Cone instances whose slots are not
in the report are current: their kept outputs are read from the result
document and are not evaluated, and their interim outputs are evaluated only
when a dirty consumer pulls them. Where the scheduler cannot report this,
every demanded cone instance is evaluated once per process. The equality
cutoff then prevents writes, and unchanged instantiation keys prevent label
work, so the fallback costs evaluation and nothing else.

### 3.5 Never a source of truth

Every value in the memo can be recomputed from stored slots, the plan and
the value code. The rules that keep it that way:

- A memo entry is never read by a transaction of another process and never
  decides what another runtime sees.
- A commit writes values and labels that were computed in its own
  transaction or taken from entries that are current. When a transaction
  writes a value that came from a memo entry, directly or through a
  consumer, the runtime adds the entry's reads to the transaction's read
  set at the versions the entry records. A write elsewhere that moved one
  of them then fails the commit, as it would for a fresh evaluation.
- Dropping any entry at any time changes what is evaluated and never what
  is committed.
- A client's memo holds values computed over its speculative view. They
  carry the fingerprints of that view and stop being current when the view
  is replaced. How a client reconciles is for
  `scheduler-and-serving-loop.md`.

## 4. The keep set and the layout of a result document

### 4.1 The documents of an instance

An instantiated pattern has the following documents and no others. "Scope"
says how many scope instances exist.

| Document | Holds | Identifier | Scope instances |
| --- | --- | --- | --- |
| Result document | Every kept output, its labels, its provenance | The result cell's, assigned when the instance is created | The space's, and one per user or session that a kept output of that scope was evaluated for |
| Argument document | The instance's argument, as the creator wrote it | Derived from the result cell, linked from it | As today |
| State cell document | The value of one state cell | Section 5.2 | By the cell's declared scope |
| Operation state document | The durable state of one aggregate, `reduce`, index, effect or forced cache | Section 6 | By the scope of the operation's cone instance |
| Cache document | The entries of cones the runtime promoted | Section 8.4 | One per scope the promoted cones have |
| Binding state document | The copied captures of a binding made in a function body | Section 5.5 | The body's |

A cell or a child instance that a handler of the instance created is not
one of the instance's documents. It is reached through whatever link the
handler stored.

Two kinds of shared, immutable document are referenced: schema documents
and label documents, both under `cid:` identifiers
([content-addressed CFC labels](../content-addressed-cfc-labels.md)), and
the compiled pattern's plan and value code, by content address.

### 4.2 The result document

The keep set of an instance is every output path reachable from its result
cell, the rendered tree under `[UI]` included. The result document's value
*is* the result: at each kept path it holds one of three things.

| What the output is | What the path holds |
| --- | --- |
| A value the instance computed | The value, inline |
| A reference passed through: a state cell, a part of the argument, a cell an element links to, a child's result, a stream | A link to that address |
| An output of narrower scope than this scope instance | A link to the same document and path with the narrower declared scope |

There is no document per kept output and no link from the result to a
document that holds a computed value. A reader of a computed kept output
reads the result document at the output's path.

The third row is how a space-scoped result contains per-user and per-session
values. A link carries a declared scope and no user or session identifier,
and the reader's runtime resolves it to its own scope instance
([scoped cell instances](../scoped-cell-instances.md)). The scope instance
of the result document for a user or a session holds only the paths of that
scope.

A kept collection is stored as an array at its path. Positions are array
indexes, so an insertion or a reorder changes which index a row's subtree is
stored at even though no row is evaluated. The write is a `splice` of the
stored array (`PatchOp` in `runtime/memory/v2.ts`), not a rewrite of the
document.

The document root holds, beside `value`:

- the `argument` meta link, as today (`META_FIELDS` in
  `runtime/runner/src/meta-seam.ts`);
- the pattern reference (`patternIdentity`) and the setup record, which name
  the compiled pattern the stored layout was written by (section 7.1);
- the carry-over record of a migrated instance (section 9.3);
- the `cfc` envelope, with the label map (section 4.3) and the provenance
  records (section 7).

It does not hold the manifest of internal cells that today's `internal` meta
field holds. The plan lists the state cells, and section 5.2 derives their
identifiers.

### 4.3 Where labels live

Labels live in the result document's envelope, at the reserved `cfc` member
of the document root ([the stored CFC envelope](../cfc-stored-envelope.md)).
Each kept output path contributes the entries
`plan-and-label-templates.md` §2.3 lists: a `value` entry, a `shape` entry
frozen at the path's creation, and for a kept collection an `enumerate`
entry at the container and `*`-child entries.

- **Labels are held by content address.** An entry keeps its path, origin
  and class inline and holds its label as a reference to a `cid:` label
  document when the label's canonical form exceeds `CFC_LABEL_INLINE_LIMIT`,
  128 bytes, and inline otherwise. The instantiation key of section 1.6
  uses the label's hash in either case.
- **One entry per path, shared where labels are equal.** When every element
  of a kept collection instantiates to the same label at a path, one
  `*`-child entry covers all positions, and appending an element adds no
  entry. When positions differ, each position that differs has its own
  entry at its index path. Those entries are positional and are rewritten
  when the positions move.
- **A path whose label is empty has no entry.** A kept path whose template
  is `const`, such as the static structure of a rendered tree, contributes
  nothing to the envelope.
- **Each scope instance has its own envelope**, holding the entries of the
  paths that scope instance stores.
- **Declared entries are unchanged.** They come from the result schema.

State cell documents, operation state documents and binding state documents
carry their labels in their own envelopes, as documents do today.

### 4.4 A link to another instance's output

A link to an output of another instance is a link to that instance's result
document at the output's path: space, document identifier, path, and a
declared scope where the output has one. This is the link a consumer holds
today. What changes is what it reaches. Today the path holds a link to the
node document that holds the value, so a read is two hops and consumes the
labels of both documents. In the compiled layout the path holds the value,
so a read is one hop and consumes the entries of the result document at
that path.

In the consumer's plan the link is a slot of class `identity` and a
`dynamic` template for what is read through it
(`plan-and-label-templates.md` §3.10). The pull that extends through the
link, and the watch on the address, belong to
`scheduler-and-serving-loop.md`.

### 4.5 A sub-pattern compiled into another

The body of a `map`, an inline pattern, and a call of a statically resolved
pattern in the reactive tier are compiled into the enclosing instance
(`plan-and-label-templates.md` §1.1). Such a sub-pattern stores nothing of
its own:

- It has no result document, no argument document, and no pattern
  reference. Its argument is expressions of the enclosing instance.
- Its outputs that the enclosing result reaches are kept outputs of the
  enclosing instance, stored at the paths where the enclosing result holds
  them. Its other outputs are interim and are not stored.
- A state cell it declares is a state cell of the enclosing instance, named
  with the call site and the element keys in its cause (section 5.2). The
  cell's document is written when the cell is first assigned.
- A durable operation it declares is an operation of the enclosing plan,
  named the same way.
- A handler it binds is a binding of the enclosing plan (section 4.7).

If every output of such a sub-pattern is consumed by further computation
and it declares no state and no operation, it adds no document and no path
to anything stored.

### 4.6 Child instances

A `Child` is a pattern with a plan of its own: a pattern received as a
factory value and called in the reactive tier, or any pattern a function
body instantiates (`plan-and-label-templates.md` §3.15).

- **Its documents** are the six kinds of section 4.1, under its own result
  cell. The parent and the child share nothing but the child's argument
  document, which the parent writes, and the child's result document, which
  the parent reads.
- **The argument is part of the parent's keep set.** Each argument path is
  written with the template the parent's plan gives it. A computed value
  passed to a child is therefore stored, in the child's argument document,
  even when the parent would not otherwise keep it.
- **A child in the reactive tier** has a result cell named from the
  enclosing instance and the call site (section 5.2). When the factory at
  the slot changes, the runtime stops the old child and sets up the new one
  on the same result cell. The new child's kept outputs replace the old
  ones at their paths. The old child's state cells are found again where
  the new plan declares a cell under the same name, and are otherwise left
  unreferenced.
- **A child a handler requested** has a result cell named from the handling
  and the request's ordinal (section 5.4). Its argument document is written
  in step 4 of the requesting transaction. Its result document is written
  when the link was stored or passed to `navigateTo`. A request whose link
  the handler dropped writes nothing.
- **A child in another space** (`inSpace`) has its documents in that space.
  The requesting transaction writes only what belongs to its own space. The
  commit that spans both spaces belongs to
  `scheduler-and-serving-loop.md`.

### 4.7 Streams and bindings

A handler bound to state yields a stream. What is stored depends on where
the binding was made.

- **A binding of the reactive tier** stores no document. Its stream has an
  identifier (section 5.2), and wherever the stream is a kept output, such
  as an event attribute in the rendered tree or an exported stream of the
  result, the result document holds a link to that identifier. The state
  the handler reads when an event arrives is the instance's slots and cone
  outputs (section 1.3).
- **A binding made in a function body** stores one binding state document:
  the copied captures, each with the label `plan-and-label-templates.md`
  §3.14 gives it, and the captured cells as links. Its identifier, and the
  stream's, derive from the enclosing instance, the handler and the
  captures (section 5.5).

Today a stream is a document that holds only a back-link to its owner, and
a bound handler has an argument document
([row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md),
"Its handlers"). *Assumed:* the event queue finds the instance and the
binding of a stream identifier without a stored document per stream. If
`scheduler-and-serving-loop.md` needs a stored owner record, each binding of
the reactive tier costs one small document per element, written once and
never rewritten.

### 4.8 What the runtime stores today, from source

The comparison in section 4.9 rests on these facts about the current
layout.

- **A result document.** Its value is the pattern's result with a link at
  every position a node computes. Its meta fields include `argument`, a
  link to the argument document; `internal`, a manifest with one entry per
  derived internal cell holding the cell's partial cause, kind and link;
  and the pattern reference and setup records (`META_FIELDS` in
  `runtime/runner/src/meta-seam.ts`; `#applySetupState` in
  `runtime/runner/src/runner.ts`).
- **One document per derived internal cell.** Setup creates a document for
  every internal cell the pattern builder assigned a partial cause to:
  every node output, every state cell, every stream
  (`#materializeDerivedInternalCells` in `runtime/runner/src/runner.ts`).
  Each carries a `result` meta link back to the result document and its own
  `cfc` envelope.
- **A full instance per sub-pattern call.** A pattern called in a pattern
  body runs under a child result cell minted from the output spot the call
  writes through (`#mintChildResultCell` in `runtime/runner/src/runner.ts`),
  with its own argument document and internal documents.
- **A full instance per `map` element.** The coordinator mints one result
  cell per element key under the map's container
  (`listElementResultCell` in
  `runtime/runner/src/builtins/list-coordinator-plan.ts`) and runs the
  callback's pattern into it. The container is a further document.
- **A store per structural built-in.** A conditional has a store that holds
  a link, and an aggregate has a document per tree node
  (`builtin-inventory.md`, the entries for `ifElse` and `aggregate`).
- **An envelope per labeled document**, copied into each revision that
  rewrites the document
  ([content-addressed CFC labels](../content-addressed-cfc-labels.md),
  "Motivation").

### 4.9 FabriChat: today and compiled

FabriChat is the reference pattern (`patterns/system/fabrichat/`, eight
source modules without `room-test-fixture.ts`). Its message rows are
`facts.main.map((message) => <FabriChatMessageRow … />)` in `room.tsx`. The
row pattern is imported by name, so the callback and the row are both
compiled into the room's instance.

The figures for today are measurements of a thirty-message room, from the
[row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md)
unless another source is named. The figures for the compiled layout follow
from sections 4.1 to 4.7 and are not measurements.

| Per message row | Today | Compiled |
| --- | --- | --- |
| Instances | One list child with a result slot, and a `FabriChatMessageRow` instance inside it | None |
| Documents the row owns | A result slot and about forty owned cells: 16 computeds, 7 conditionals, 5 actions and at least 11 handler bindings with a stream document and an argument document each, 1 writable, 1 reactive list | None when created. One session state cell, `pickerOpen`, once a session first assigns it |
| Values a reader binds | About 25 bound props, each a link to a document of the row | The same values as path entries of the room's result document: the space's scope instance for most, the session's for the 4 or 5 the record counts as session-scoped |
| Label envelopes | One per document of the row | Entries in the room's result envelope, shared across rows by `*`-child entries where the rows' labels are equal |

| Per room of thirty messages | Today | Compiled |
| --- | --- | --- |
| Documents for the rows | About 1,230 (thirty families of about forty-one) | 0 to 30 per session that opened a picker |
| What a resume synchronizes | 1,663 list-child syncs and 285 cell syncs, the twelve participant chips included | The result document's scope instances, the argument document, and the state cells that exist |
| Commits a load stores | 190, of which 167 are session-scoped derivations of the rows | One per cause that changed a kept output. A second load that finds every cone current commits nothing (section 3.4) |
| CFC preparations a load makes | 615 | One per cause |

The envelope figures of
[content-addressed CFC labels](../content-addressed-cfc-labels.md) are from
another store, of chat-row entities whose labels carry confidentiality.
They show what a document per row value costs when labels are not empty:
about 465 bytes of value and about 5.2 KB of envelope per entity, 93% of
live JSON, with 5, 8 or 9 entries of about 790 bytes each. With labels by
reference the same envelope is about 1.1 KB. In the compiled layout an
entry is about 25 bytes of path, origin and class plus a 63-byte reference,
and the number of entries for the rows of a room is the number of distinct
kept paths of the row template, about 25, when the rows' labels are equal.
It is that number times the number of rows only where every row's label
differs.

As deployed, FabriChat declares no confidentiality and its derived values
have empty labels (`plan-and-label-templates.md` §6.4). The compiled result
envelope of a room then holds its declared entries and nothing per row.

Two costs move into the result document and need measurement at stage 4 of
the overview's staging:

- **Its size.** The rendered tree of every row is inline in one document.
  Today each row's tree is in the row's own result document. A room of a
  thousand messages has a result document a thousand rows large, written by
  path-level patches but loaded whole by a reader of the room.
- **Its write rate.** Every cause that changes any kept output of the room
  writes the same document. Under server execution one runtime commits for
  a space, so the writes do not conflict with each other, but every reader
  of the room receives every patch.

Open question 1 for the owner is about the first.

## 5. Causal identifiers

### 5.1 The derivation today, from source

Every identifier below is produced by `createRef` in
`runtime/runner/src/create-ref.ts`, which hashes the record
`{ ...source, causal: cause }` with the value hasher and returns the hash as
an entity identifier. The identifier is written as a URI with a scheme:
`of:` for an unkinded entity, `computed:` for a cell the builder classified
as computed ([computed cell identity](../computed-cell-identity.md)). The
scheme is not in the hash.

| Thing | Preimage today | Where |
| --- | --- | --- |
| An internal cell of an instance: a state cell, a stream, a node output | `source` empty; `cause` is `{ parent, type: "internal", cause: partialCause }`, where `parent` is the result cell's entity identifier | `DerivedInternalCellIds.idFor()` in `runtime/runner/src/derived-internal-cell-ids.ts`, called by `getDerivedInternalCellLink` in `runtime/runner/src/link-utils.ts` |
| The partial cause | The name the transformer attached with `.for(name, true)`, as a plain string; `{ $generated: N }` for an anonymous cell, with `$kind: "stream"` for a stream; `{ name, $generated: N }` when a name repeats; `{ $instance: name }` for a named instance | `factoryFromPattern` in `runtime/runner/src/builder/pattern.ts` |
| The argument document | `cause` is `{ type: "argument", parent: resultCell }` | `getMetaCell` in `runtime/runner/src/link-utils.ts` |
| A sub-pattern's result cell | `cause` is `{ resultFor: { space, id, path } }` of the output spot, which is the parent's internal cell for the call's partial cause | `#mintChildResultCell` in `runtime/runner/src/runner.ts` |
| A `map` element's result cell | `cause` is `{ map: container, elementKey }` | `listElementResultCell` in `runtime/runner/src/builtins/list-coordinator-plan.ts` |
| A cell created in a handler | `source` is `{ frame: { count: n } }`, with `n` a counter on the frame; `cause` is the frame's cause, the handler's bound inputs in causal form with `$event` set to the durable event identifier | `#ensureLink` in `runtime/runner/src/cell.ts`; `#instantiateJavaScriptHandlerNode` in `runtime/runner/src/runner.ts` |
| A cell created in a `lift` with `.for(cause)` | `source` is `{ frame: cause }`; the frame's cause is the lift's `{ inputs, outputs, fn }` record | `#ensureLink`; `#instantiateJavaScriptActionNode` in `runtime/runner/src/runner.ts` |
| The receipt of a handling | A hash of the event identifier and the stream's address, under the receipt scheme | `handlingReceiptId` in `runtime/runner/src/scheduler/event-identity.ts` |

Scope is not part of any preimage. One identifier has a scope instance per
scope key.

### 5.2 State cells, streams, operations and children of the reactive tier

A thing declared in the reactive tier is identified by where it is declared:
the instance, the compiled-in sub-pattern calls and element bodies that
enclose the declaration, and its name. The compiler derives the name as the
transformer's `.for(...)` does, from the variable the declaration is
assigned to.

**Declared directly in the instance's pattern body**, outside every element
body and every compiled-in sub-pattern, under a name no other declaration of
that body has:

```text
createRef({}, {
  parent: <result cell entity id>,
  type:   "internal",
  cause:  <name>,
})
```

This is today's preimage for a named cell, so the hash is byte-identical.
The scheme is `of:` for a state cell and a stream of a new instance. For a
migrated instance the scheme is the one the stored manifest records for the
cell (section 9.3), because the builder classifies some cells that only
computations write as computed, and the hash alone does not say which.

**Declared anywhere else**:

```text
createRef({}, {
  parent: <result cell entity id>,
  type:   "state" | "stream" | "operation" | "child",
  within: [ <step>, … ],        outermost first
  cause:  <name>,
})

step = { site: <call-site name> }                       a compiled-in call
     | { element: <collection name>, key: <element key> }  an element body
```

The record has a `type` and a `within` member no preimage of today has, so
it cannot equal one. These identifiers are new. Section 9 says what happens
to state stored under today's identifiers for the same declarations.

A child instance of the reactive tier keeps today's two steps where it is
declared directly in the pattern body: its output spot is the internal cell
of the call's name, and its result cell is `{ resultFor: <spot> }`. Declared
anywhere else, its result cell has the second form with type `child`.

Three requirements on names follow, which this document needs from the plan.

- **A name is unique within its body.** Where two declarations of one body
  would take one name, the compiler has to tell them apart in a way that
  does not move when unrelated code is added. Today's form for a repeated
  name, `{ name, $generated: N }`, is positional and is not reproduced.
- **A call site has a name.** A compiled-in call bound to a `const` takes
  that name. A call that is bound to nothing, such as a pattern used as a
  JSX tag, needs a name the compiler assigns. *Assumed:* an ordinal among
  the unnamed calls of the same pattern in the same body, so that adding a
  call of another pattern moves nothing.
- **A binding has a name.** A handler applied to its state and bound to a
  `const` takes that name. An inline event handler and an `action` not
  bound to a name need one the compiler assigns, by the same rule.

### 5.3 Element keys and the salt

The `key` of an `element` step is:

- for a position that holds a link: the space and identifier of the cell
  the link resolves to, and its path, without the link's scope;
- for a position that holds a plain value: the hash of a secret of the
  space and the canonical form of the value;
- with the index, where the body uses it: the pair of the above and the
  index.

The secret is a runtime secret of the space, minted and read by the runtime
alone (`ensureRuntimeSecret`, described in
`runtime/runner/src/runtime-secret.ts`), under a name of its own so that it
is not the salt `sqliteQuery` uses for row documents. Executed code cannot
read it, and it is stored under a label no reader's ceiling admits.

Two consequences.

- **The memo needs no salt.** A key that only indexes the element table in
  memory never enters an identifier. The runtime may use the unsalted hash
  there.
- **A runtime that cannot read the secret cannot derive a value-keyed
  identifier.** *Assumed:* a client cannot read it, since a reader who
  could would be able to confirm a guess at a confidential value from an
  identifier, which is what the salt prevents. A client then learns the
  identifier of per-element state over plain values, and of a binding made
  from copied captures, only from a link the server stored. What a client
  shows for such state before the server's result arrives is for
  `scheduler-and-serving-loop.md`.

State and handlers over plain values exist only where the index is in the
key (`plan-and-label-templates.md` §1.3), so the first case is a state cell
keyed by a salted value hash and an index.

### 5.4 Cells and instances a handler invocation creates

Each handler invocation is a new frame, so what it creates is new. An
occurrence is identified by the handling and by its order in the invocation.

```text
createRef({ request: <ordinal> }, { handling: <receipt identifier> })
```

- **The handling** is the receipt's identity: the durable event identifier
  and the stream it was sent to. A retry of the same event on the same
  stream is the same handling. `plan-and-label-templates.md` §1.3 says "the
  event's key". The event key of today also names the acting principal
  (`builtin-inventory.md`, "Context reads"). The receipt leaves the
  principal out, so that one event on one stream is one handling whoever
  sends it, and this document follows the receipt.
- **The ordinal** counts the body's requests of every kind in the order
  they were made: cells, instances, effects. A retry with the same control
  flow names the same things.
- **A request with `.for(tag)`** is identified by the handler's instance
  and the tag, without the handling, so that different events name the
  same thing (`plan-and-label-templates.md` §1.3). Today every identifier
  minted in a handler's frame derives from a cause that holds the event
  identifier, so this is new behavior and not a carried-over one.
- **A binding** made in a handler is identified as in section 5.5.

The identifier of a requested instance is that of its result cell. Its
argument document derives from the result cell as today.

Nothing here has to match today's bytes. A cell or an instance a handler
created before a migration is reached through the link the handler stored,
not by deriving its identifier again. The one case in which both
derivations could name something is an event handled by the current runtime
and delivered again to a compiled instance, and the receipt refuses the
second handling.

### 5.5 Cells and bindings a re-evaluated body creates

A `lift` or a `computed` is evaluated any number of times, so what it
creates is identified by content and never by order.

```text
a cell:     createRef({ cell: <cause value> },
                      { parent: <result cell entity id>, site: <body name>,
                        within: [ <step>, … ] })

a binding:  createRef({ binding: <handler>, captures: <capture keys> },
                      { parent: <result cell entity id>,
                        within: [ <step>, … ] })
```

- `<body name>` is the name of the `lift` or `computed` in the plan, by
  the naming rule of section 5.2. It is not the body's code, so that
  editing the body does not rename the cells it addresses. Two bodies of
  one instance that pass equal causes address two cells, as today.
- `<handler>` is `Body.code` of a handler of the plan, or the content
  address of a handler factory value.
- `<capture keys>` holds, per state path, the salted hash of a copied value
  or the identity of a captured cell, by the rule of section 5.3.
- The binding state document and the stream have this identifier, with the
  types `binding` and `stream`.

A cell a `lift` creates by a cause computed from data is the target of a
materializer write (`plan-and-label-templates.md` §3.14). Today's preimage
for such a cell holds the lift's `{ inputs, outputs, fn }` record, which
changes with the lift's source text and its input schemas and is not
reproduced. These identifiers are new. The cells hold what the lift wrote
and are written again on the first evaluation.

### 5.6 `inSpace`

The identifiers of an `inSpace` request are known when the body makes the
request, before the commit that spans both spaces.

- **The instance.** With `root: true` the result cell is the one the
  target space reserves for its root (`inSpaceRootCause` in
  `runtime/runner/src/in-space-root-cause.ts`). Otherwise it is the
  identifier of section 5.4, in the target space.
- **The space.** For a target given as a space identifier or as the space
  of a cell, the identifier is the given one. For a named or anonymous
  target, today the name is resolved through an allocation record in the
  calling space, the space is created when no record exists, and the
  handler is run again once it does (`resolveInSpaceTargetSpace` in
  `runtime/runner/src/builder/pattern.ts`;
  `Runtime.resolveInSpaceNameSync` in `runtime/runner/src/runtime.ts`).
  *Assumed:* the runtime that executes the handler authoritatively obtains
  the space's identifier when the request is made, and records it in the
  calling space's allocation record in the cause's transaction, so that the
  body is not run a second time. An anonymous target is named from the
  handling and the ordinal among the body's `inSpace` requests.

How the space's identifier comes to exist before its first commit, and what
a client's speculative run of the same handler sees, belong to
`scheduler-and-serving-loop.md`. Section 11 lists a disagreement about it.

### 5.7 What stays byte-identical

| Identifier | Same bytes as today |
| --- | --- |
| The result cell of an instance | Yes. The compiler does not derive it |
| The argument document | Yes. It derives from the result cell |
| A state cell or a stream declared directly in the pattern body under a unique name | Yes for the hash. The scheme is taken from the stored manifest for a migrated instance |
| A child instance declared directly in the pattern body, where today's call has a name as its partial cause | Yes |
| A state cell, stream or operation inside a compiled-in sub-pattern | No. Carried over by record where section 9.3 allows |
| Anything inside an element body | No. Not carried over |
| A cell, instance or effect a handler requests | No, and nothing depends on it |
| A cell or binding a `lift` or a `computed` creates | No. Recomputed |
| The state of a structural operation: a conditional's store, a `map` container, an aggregate's tree | Not applicable. These documents have no counterpart, or a new one under section 6 |

## 6. Durable state of operations

`builtin-inventory.md` says which operations have durable state: the
aggregates, `reduce`, the collection index, and every effectful built-in.
`plan-and-label-templates.md` records each as an `Operation` and gives the
label of its result. This section says where the state is stored, under
what identifier, with what label, and how it is rebuilt.

One operation has one state document per scope key its cone instance is
evaluated for. Its identifier is that of section 5.2 with type `operation`:
the instance, the enclosing sites and element keys, and `Operation.name`. An
operation a handler requests has the identifier of section 5.4. The
documents of aggregates, `reduce`, indexes and caches can be recomputed and
take the `computed:` scheme. The document of an effect cannot and takes
`of:`.

### 6.1 Aggregates

- **State.** Per element key: the contribution (a count, a truthiness, a
  number, a selector value) and the number of positions that hold the key.
  The folded value, in the representation the operation needs to update it
  in constant time, such as the exact partial sum for `sum`. For `minBy`
  and `maxBy`, the winning key. The multiset of label identifiers the fold
  joins, as a count per identifier (`plan-and-label-templates.md` §4.3).
- **Update.** A change to one element replaces that key's contribution and
  adjusts the folded value. A reorder changes nothing. `min` and `max` need
  the contributions of the other keys when the current extreme leaves,
  which is why contributions are stored and not only the folded value.
- **Result.** The operation's result is a path of the state document. It is
  what an `operation` slot reads, and its label is the operation's `fold`
  or `pick` template instantiated.
- **Rebuild.** From the collection: evaluate the per-element cone of every
  key and fold. The cost is one evaluation per distinct key.

### 6.2 `reduce`

- **State.** The result, and the multiset of step label identifiers. In the
  baseline there are no checkpoints (`builtin-inventory.md`, open question
  7), so a change at any position recomputes the fold in order, from the
  per-element step inputs.
- **Checkpoints**, if the runtime keeps them: the accumulator after chosen
  positions, each with the join of its prefix as its label
  (`plan-and-label-templates.md` §3.13).
- **Rebuild.** Evaluate the fold from the initial value.

### 6.3 Collection indexes

- **State.** Per element key: the index key the selector produced and the
  number of positions. Per index key: the bucket, as the element references
  in source order for `group` mode and the winning reference for `key`
  mode. The set of occupied index keys.
- **Readers.** `lookup`, `keys` and `keyEntries` read paths of this
  document. A bucket's label entry holds the bucket's membership template
  instantiated (`plan-and-label-templates.md` §3.17).
- **Rebuild.** Evaluate the selector cone of every key and bucket the
  elements.

### 6.4 Effects

- **State.** What `builtin-inventory.md` lists per built-in: the hash of
  the request, the claim, and the settled result or error. For
  `sqliteQuery` also the row documents, and for the language-model
  built-ins the conversation where a tool loop is to survive a restart.
- **Writes.** The requesting transaction writes the request hash and the
  pending state. The completion is a cause of its own (section 1.1): its
  transaction writes the settled result with the label the boundary
  declares, and then evaluates what depends on it.
- **Label.** The declared rule of the boundary (`builtin-inventory.md`),
  with the request's label from `Operation.input`.
- **If lost.** An effect's result cannot be recomputed. When the state
  document is absent, or its request hash differs from the current
  request's, the effect is requested again. Loss therefore repeats the
  request.

### 6.5 The label of bookkeeping state

`plan-and-label-templates.md` gives the label of an operation's result, of
a bucket, and of a checkpoint. It does not give the label of the rest of
the state: the per-key contributions, the per-key index keys, the counts,
the multiset of label identifiers. These are derived from element content
and are stored, so they need a label.

*Assumed:* every path of an operation's state document that has no label
rule of its own carries `Operation.input` instantiated, which is the join
over everything the operation folds. The runtime reads these paths only as
its own bookkeeping, and no template has a slot for them, so the label is
never joined into an output. It governs a reader that reaches the document
by some other route. This is a label rule the plan and the specification
change do not state. Section 11 lists it.

### 6.6 Currency

Operation state is updated in the transaction of the cause that changes its
input, when the operation is demanded. When it is not demanded it stops
being current, like a kept output. On a later demand the runtime needs the
slots that changed since the state document was last committed, which is
the request of section 3.4. Without that, the state is rebuilt.

State is discarded and rebuilt when the compiled pattern changes in a way
that changes the operation: its `implementation`, its `input` template, or
the code of its per-element cone. The state document records the content
address of each of the three for that comparison.

## 7. Provenance

A kept output records where its value and its label came from: the
template, the identities bound to the template's slots, and the identity of
the compiled pattern. An interim value has no stored provenance. Its
template is a sub-template of every kept output that depends on it.

### 7.1 Per document

The result document names the compiled pattern that wrote its layout:

- the pattern reference (`patternIdentity`), which names the authored
  program's export as today;
- in the setup record, the `CompiledPattern` hash, which fixes the plan,
  the value code and the compiler build.

*Assumed:* the pattern reference continues to name the authored export, and
the setup record is where the compiled artifact is named. Which of the two
a deployment accepts builds by is `plan-and-label-templates.md` §7.2.

### 7.2 Per kept output

The envelope holds, beside the label map, one provenance record per kept
output path that has a label entry or a dynamic part.

```ts
type Hash = string;
type Index = number;

/** Provenance of one kept output path, stored in the result envelope. */
export interface OutputProvenance {
  /** The output's path in the result. */
  readonly path: readonly string[];
  /** The slot-free hash of the output's template. */
  readonly template: Hash;
  /** Hash of the instantiation key the stored label was computed from. */
  readonly key: Hash;
  /** The branch taken at each selector the template reaches. */
  readonly selections: Readonly<Record<Index, number>>;
  /**
   * Addresses the output depends on that the plan does not name: what was
   * read through links and handles, and the child a `pick` chose.
   */
  readonly dynamic: readonly string[];
}
```

The identities bound to the template's slots are not copied into the
record where the plan and the document determine them:

- A slot with root `argument`, `state`, `operation` or `child` is bound to
  an address that follows from the instance and the plan (sections 4.1 and
  5.2).
- A slot with root `element` is bound to the element at the output's
  position, through the collection's source and, for a derived collection,
  the origins of section 7.3.
- A slot with root `event`, `cause` or `binding` belongs to a handler's
  write edge, not to a kept output.

What is recorded is what cannot be derived: the selections and the dynamic
addresses. A reader that wants the full chain for a path takes the compiled
pattern from the document, the `Output` and its template from the plan, and
binds the slots as above.

Like label entries, provenance records are shared across the positions of a
collection: one record at a `*` path covers the rows whose template,
selections and key are equal, and a row with dynamic addresses has a record
of its own.

The `key` member is what step 5 compares to decide that a stored label can
be reused (`plan-and-label-templates.md` §4.1, step 3).

Each kept path can thus be traced to the inputs it was computed from
without a document per value. The display boundary's check of what a sink
consumed reads the label entries at the path, as it reads a document's
entries today.

### 7.3 Origins of a kept derived collection

A kept collection produced by `filter` or `flatMap` records, with its
`enumerate` entry, one fact per source element: whether it was included, or
the length of its segment. The origin of each position follows by prefix
sum (`plan-and-label-templates.md` §3.7). An interim derived collection
keeps the facts in the memo only.

### 7.4 The label of provenance

A provenance record says which branch was taken and which addresses were
read, and origin facts say which elements a predicate admitted. Both are
derived from data. *Assumed:* a path's provenance record and origin facts
are label metadata of that path and are protected as the path's label
metadata is
([label metadata confidentiality](../cfc-label-metadata-confidentiality.md)).
The stored format is a host arrangement. That these members exist and what
protects them is not stated in `plan-and-label-templates.md`, whose open
question 9 leaves the location to this document. Section 11 lists it.

## 8. Cache promotion

Storing a pure derivation does not change what a pattern means, so whether
to store one is the runtime's decision. The overview lists the cost model as
open. This section proposes one. The constants in it are placeholders until
stage 4 of the overview's staging measures them.

### 8.1 What can be promoted

A cone is a candidate when all of these hold:

- it has at least one interim output. A cone whose outputs are all kept is
  already stored, and its stored values are read in place of an evaluation
  when the cone is current (section 3.4);
- it performs no side-write;
- the plan does not forbid it (section 8.5).

For an element cone the decision is made once for the collection, not per
key.

### 8.2 What is measured

The runtime that executes authoritatively measures, per candidate cone of an
instance, over a window of the last 64 evaluations or cache hits of that
cone:

| Quantity | Meaning |
| --- | --- |
| `evaluate` | The mean time of one evaluation: the cone's function, its bodies, and the loading of slot documents that were not in the replica |
| `repeats` | The number of evaluations in which no slot, dynamic read or upstream output of the cone instance had changed since its previous evaluation or since the commit of section 3.4. These are the evaluations a stored entry would have replaced |
| `changes` | The number of evaluations that followed a change. Each would rewrite a stored entry |
| `size` | The stored size of the cone's outputs and of their label entries |
| `label` | The mean time to instantiate the outputs' templates when their key changed. A promoted output is labeled; an interim one is not |

`repeats` is the quantity that matters. The in-memory memo already serves a
cone instance whose entry exists, so a repeat happens only when the entry
was absent: after a restart, after the instance was stopped and demanded
again, or after an eviction.

A client measures nothing and decides nothing.

### 8.3 The comparison

```text
saved = repeats × (evaluate − read(size))
spent = changes × (write(size) + label) + hold(size)
```

`read`, `write` and `hold` are the deployment's costs of reading a stored
entry, of adding one to a commit, and of keeping one for the length of the
window. They are functions of size and are measured once per deployment,
not per cone.

- **Promote** when `repeats ≥ 4` and `saved ≥ 2 × spent`.
- **Demote** when `saved ≤ spent ÷ 2`.
- **Otherwise keep the current state.** The gap between the two thresholds
  is the hysteresis. A decision also stands for at least one full window,
  so that a cone near a threshold does not alternate.

While a cone is promoted, a cache hit counts as a repeat, with `evaluate`
taken from the last evaluations that did run. A demotion deletes the cone's
entries with the next commit that writes the cache document.

What needs measurement: the window, the two thresholds, the minimum of
four, and whether `evaluate` should be the mean or a high percentile.

### 8.4 Where a promoted cache lives

One cache document per instance and per scope key, under the `computed:`
scheme:

```text
createRef({}, { parent: <result cell entity id>, type: "cache" })
```

Its value maps `Cone.code` to the cone's entries, and for an element cone
maps each element key to an entry. An entry holds the outputs, the
selections and picks, and the fingerprints of section 3.1 in a form that
survives the process: per read, the address, the class, the version and
the label identifier.

- The document is never linked from the result, from state, or from another
  instance. The only reader is a runtime evaluating the same instance.
- Keying by `Cone.code` lets entries survive a pattern update that does not
  change the cone, and makes entries of a changed cone unreachable. They
  are removed with the next write.
- A client that speculates may read the document. It does so only for cones
  it would otherwise evaluate.

### 8.5 The author's annotation

*Assumed:* the plan records, per cone, one of three directives, and
`language-subset.md` defines how an author writes them.

| Directive | Effect |
| --- | --- |
| None | The runtime decides, by section 8.3 |
| Always | The compiler emits an `Operation` of kind `cache` for the cone. Its state document is named and stored as section 6 says, and is written whenever the cone is evaluated |
| Never | The cone is not a candidate |

### 8.6 The label of a cached value

A cached output is stored, so it is labeled. *Assumed:* each cached output
carries its own template instantiated, as it would if it were kept, and its
entries are in the envelope of the cache document or of the forced cache's
state document. The plan has the `cache` kind and no label rule for it.
Section 11 lists it.

### 8.7 Why promotion does not change what a pattern means

- **Values.** A cone without side-writes is a function of its slots, its
  dynamic reads and its upstream outputs. An entry is used only when every
  fingerprint it records equals the current one, checked in the using
  transaction (section 3.5). The value read is then the value an evaluation
  would produce.
- **Labels.** The label of a kept output is instantiated from the labels of
  its slots and from selections. A cache entry supplies the selections it
  recorded, which are a function of the same inputs. No template has a slot
  for a cache, so a cache's own label never enters an output's label.
- **The keep set.** A cached output is not kept. It has no path in the
  result, nothing can link to it, and `inspectConfLabel` on it returns what
  it returns for an interim value (`plan-and-label-templates.md` §3.16).
- **Loss.** Deleting a cache, or never creating one, changes what is
  evaluated and not what is committed.

One thing does depend on it. Whether an entry exists is a function of how
long a cone takes and how often it is pulled, and both can depend on data.
An observer who can list a space's documents can see that a cache document
changed. This is a timing and demand channel of the kind
`plan-and-label-templates.md` §5.5 already accepts. It is listed in section
11 so that the list there can name it.

## 9. Migration of stored instances

The overview asks whether anything besides state cells has to keep its
identifier, and when per-node documents already stored can be deleted. This
section proposes a procedure. It assumes the runtime that migrates contains
both the builder path and the compiled path, which is the case until stage
6 of the overview's staging.

### 9.1 What an instance stored by the current runtime consists of

Section 4.8 lists it: a result document whose value is links, an argument
document, one document per internal cell with the manifest that lists them,
a full instance per sub-pattern call and per `map` element, and the stores
of structural built-ins.

### 9.2 What migrating means

An instance is migrated by one setup transaction that replaces the stored
layout with the compiled one, for the same authored source.

| Stored today | After migration |
| --- | --- |
| The result document's identifier | Unchanged |
| The result document's value: links to node documents | The kept outputs, inline, as the first compiled evaluation computes them |
| The argument document | Unchanged |
| A state cell declared directly in the pattern body | Unchanged: the derived identifier is the stored one (section 5.7) |
| A stream declared directly in the pattern body | Unchanged identifier. Its document is no longer needed and is left |
| A state cell inside a compiled-in sub-pattern | Found through the carry-over record (section 9.3) |
| A state cell inside a `map` body | Not carried over. The compiled instance starts it empty under its new identifier |
| A node output document: a `computed`, a conditional's store, a `map` container, an element result, an aggregate node | No longer written. Retired (section 9.6) |
| The result and argument documents of a sub-pattern instance that is now compiled in | No longer written. Retired, with a forwarding link where section 9.5 says |
| A child instance a handler created | Unchanged, and migrated on its own when it is next started |
| The settled result of an effect | See open question 2 for the owner |
| The `internal` manifest | Kept as the list of retired documents until they are deleted |

Per-element state is not carried over by ruling. In FabriChat the one such
cell is the row's `pickerOpen`, a session flag.

### 9.3 The carry-over record

A state cell inside a compiled-in sub-pattern has a new identifier (section
5.2), and its stored value is under the old one: an internal cell of the
sub-pattern's own instance. The migration writes, in the result document's
meta, a record that maps the cell's cause in the plan (its `within` steps
and its name) to the link of the stored document. Binding reads the record
on every start and uses the recorded document for that cell. The record is
written once and is not removed.

This is the mechanism a named sub-pattern instance uses today to keep the
child it had at a positional spot (`instanceChildren`,
[computed cell identity](../computed-cell-identity.md), "Sub-pattern
instance identity").

Finding the stored document needs the build the instance was set up with.
The stored manifest names a sub-pattern's output spot by a positional
cause, `{ $generated: N }`, which says nothing about which call it was. The
migration therefore loads the stored source through the builder path,
matches each sub-pattern node of that build to a call site of the plan, and
walks the stored child's manifest for the cell's name. The matching is by
the variable the call is bound to, and otherwise by the description and
order `runtime/runner/src/cause-assignment.ts` uses to match cells across
two builds. A call the matching cannot place carries nothing over, and the
migration reports it.

Two consequences.

- An instance migrated after the builder path is retired cannot have this
  record computed. Its sub-pattern state starts empty.
- The record also carries the scheme of each state cell declared directly
  in the body, taken from the stored manifest (section 5.2).

### 9.4 The procedure

For one instance, when a runtime that can execute compiled patterns starts
it and finds the stored setup record written by the builder path:

1. **Compile.** Compile the instance's stored source. If the compiler
   refuses it, the instance is not migrated and keeps running on the
   builder path (open question 4 for the owner).
2. **Compare contracts.** Apply the existing compatibility comparison of a
   source update to the compiled pattern's argument and result schemas
   against the stored instance
   ([piece source lifecycle](../piece-source-lifecycle.md), "Compatibility
   policy"). The source is the same, so a difference means the two
   compilers generate different schemas, and the migration stops and
   reports it.
3. **Compute the carry-over record** (section 9.3).
4. **Evaluate.** Run the first compiled evaluation as a cause of the second
   kind with every slot dirty, reading state through the record.
5. **Write, in one transaction:** the result document's value, envelope and
   provenance in the compiled layout; the setup record naming the compiled
   pattern; the carry-over record; forwarding links (section 9.5); and the
   mark that makes the space refuse older builds (section 9.7).
6. **Start the compiled instance.** From this commit on, no node document
   of the instance is written.

The transaction is a setup transaction in the sense of the
[serving loop](../server-side-execution/serving-loop.md) (§3e): the
running graph is replaced only after the commit is accepted, and a
withdrawn commit leaves the builder-path instance running.

Instances are migrated one at a time, when they are started. A space can
hold migrated and unmigrated instances, and they read each other through
links in both directions: a link into a migrated result reaches a value
where it used to reach a link, and a link into an unmigrated result is
followed through the node document as today.

### 9.5 Links that point at retired documents

Other documents can hold links that point past a result document, directly
at a document the migration retires: the result of a sub-pattern instance
that was stored in a list or navigated to, or a node document a reader
resolved to and stored.

- **A retired document whose content is now a kept output** gets a
  forwarding link: the migration overwrites its value with a link to the
  path of the migrated result document that holds the output. A reader
  that follows a stored link to it reaches the current value. The
  forwarding link is written once.
- **A retired document whose content is now interim** has nothing to
  forward to. It keeps its last value until it is deleted, and a reader
  that follows a stored link to it reads a value that no longer changes.

The second case is the answer to the overview's question: an interim node
document that something outside the instance links to directly would have
to keep its identifier and its writes to stay correct, and the compiled
design does not write it. Listing such links means reading every document
that could hold one. *Assumed:* they are rare enough to find by observation
(section 9.6) and to repair by making the output kept in the pattern's
source.

### 9.6 Deleting retired documents

A retired document can be deleted when both hold:

1. **No admitted runtime binds the old layout.** The space refuses builds
   that predate the compiled layout (section 9.7).
2. **Nothing read it during a retention period.** The serving runtime can
   see which documents a session watches. A read of a retired document that
   is not a forwarding link, during the period, is reported and stops the
   deletion of that document.

The serving runtime deletes the document in a transaction of its own and
removes the document's entry from the kept manifest. Forwarding links are
not deleted by this rule, since following one is the read they exist for.
State cells that were not carried over, such as per-element state, are
retired documents and are deleted under the same rule.

*Assumed:* a retention period of thirty days. It needs the owner's
decision (open question 3).

The same rule applies after migration to documents that go out of use
without a migration: the state of an element whose key left its collection,
and the state cells of a replaced child that the new child does not declare
(section 4.6). Today such documents are released and never deleted
(`builtin-inventory.md`, the entry for `map`).

### 9.7 What a reader on an older client sees

- **A client that only reads** the instance's result, and runs none of its
  code, reads the result document through the result schema. Before the
  migration commit it follows links to node documents. After it, it finds
  values at the same paths. The migration is one transaction, so it sees
  one layout or the other and never a mixture. Nothing in such a client has
  to change.
- **A client that runs the instance's pattern on the builder path** would
  set the instance up again from the stored source. A start holds the
  stored setup against the build it loads (`#storedSetupVerdict` in
  `runtime/runner/src/runner.ts`), and a setup record it cannot interpret
  reads as no record, on which the builder path can restage its own
  projection over the compiled result. Its speculative run would also read
  retired node documents that no longer change.

The second kind of client has to be refused. The migration's commit marks
the space, and the memory server admits to a marked space only a runtime
that declares it executes the compiled layout, as it does today for
instance naming ([memory invariants](../memory-v2/09-invariants.md), INV-16).

*Assumed:* migration happens only in a space that runs under server
execution, so that the one runtime that commits derived values is a
compiled one, and a client's part is to read and to speculate.

### 9.8 Interaction with the pattern-update mechanism

A pattern update after migration is a source transition as today
([piece source lifecycle](../piece-source-lifecycle.md)). What the update's
setup does changes.

- **State cells are found by name.** A cell the new source declares under
  the same name, at the same sites, has the same identifier. A renamed cell
  is a new cell, as today. No cell moves because another was added, since
  no identifier is positional. The refusal that protects positional state
  today (`PieceStateMovedError`) and the gate that holds the compiler to a
  numbering (`deno task check-cause-assignments`) do not apply to a
  compiled instance.
- **The carry-over record stays.** It is keyed by the cell's cause in the
  plan, so it keeps applying while the declaration keeps its name and
  sites.
- **Kept outputs are recomputed.** The first evaluation under the new
  compiled pattern writes the kept outputs whose values or instantiation
  keys differ.
- **Memo entries are dropped**, because they are keyed by the compiled
  pattern (section 3.2). Cache entries and operation state survive where
  the code they were computed by is unchanged (sections 6.6 and 8.4).
- **The compatibility comparison is unchanged.** It compares argument and
  result schemas and retained input links, none of which the layout
  affects.
- **Migration is itself a setup under a new setup record.** An instance
  that follows an origin is migrated when the origin's release is first
  compiled by the new compiler. A detached instance is migrated by
  rebuilding its retained source, which the lifecycle already has as a
  transition.

## 10. Worked example: a FabriChat send

This traces one cause through sections 1 to 7: a message sent into a
FabriChat room that holds thirty messages, is rendered by the sender's
session, and has no thread open. It uses the slice and the names of
`plan-and-label-templates.md` §6: the handler `commitSend` (body `B0`), the
derivation `facts` (body `B1`, template `T_facts`), the row templates, and
the constraints `k0` and `k1`.

### 10.1 The transaction

**Step 0.** The cause is an event on the send stream. Its payload is bound
to the `event` root, and its key and principal to the `cause` root.

**Step 1, before the body.** The read closure of `B0` is the event slots,
the `identity` slot of `myProfile`, and three handles: `myProfile`,
`messages` and `threadInfo`. No cone of the room computes any of these, and
no cone side-writes a cell the handler reads. Nothing is evaluated.

**Step 2, the body.** `sendInto` reads the sender's profile through its
handle, checks the event, and then:

- creates the reactions list, a cell request with ordinal 0;
- pushes the message record onto `messages`. The record is a plain object
  written into an array, so it gets a document of its own and the array
  receives a link (`builtin-inventory.md`, "Element keys");
- sends on the `joined` stream. The send is staged and becomes a cause of
  its own after the commit.

Staged by the body: a new message document, a new reactions document, and
one appended link in the `messages` list.

**Step 3, after.** The append dirties two slots of the room, the
enumeration of `messages` and the identity of its elements, and the
addresses `B1` read through its `messages` handle.

| Cone instance | Dirty | Evaluated | Why |
| --- | --- | --- | --- |
| `facts` | Yes | Yes: one call of `B1`, which walks 31 records through its handle | Its slots changed |
| `isEmpty` | Yes | Yes: one comparison | `facts.main.length` changed. The value stays `false`, so its kept output is not written |
| The participants derivation | No | No | It reads the authors `facts` lists, and the list is equal to the one before |
| Per-session records the room derives for every row, such as the rights of each message | Yes | Yes, once per demanding session | They read the entries of `facts` |
| The 30 existing rows | No | No | Their keys are their message cells' identities, their element slots did not change, and each reads only its own entry of the room's records through a handle |
| The new row | New key | Yes, once: the row body's cones for the new message | Step 3 of section 2.5 |

By a syntactic count, the body of `FabriChatMessageRow` in `message-row.tsx`
has 14 `computed` calls, 7 actions and 12 applications of a handler to
state. `language-subset.md` §11.5 counts 106 of FabriChat's 111 `computed`
calls as promoted, so most of the row is expression code with calls of
authored functions such as `bodyText`.

**Step 4, staged requests.** The reactions document is given its
identifier from the handling and ordinal 0, and its initial value.

**Step 5, instantiation.**

- The write edges of `B0`: `T_send` is instantiated once for the message's
  computed fields and the reactions list. The `authorProfile` link carries
  the label of the reference the handler was given.
- The room's `messages` output: its cone was evaluated, its instantiation
  key is unchanged when the new message's label identifier equals the
  others', and the stored label is reused.
- The new row's kept paths, about 25: their templates instantiate to the
  labels the other rows have, the `*`-child entries already cover them, and
  no entry is added.

As deployed, every one of these labels is empty apart from the declared
authorship entry on the message.

**Step 6, constraints.** `k0`: the writer is `commitSend`, which the policy
names, and the event satisfies the alternative's UI contract. `k1`:
writer-fit. Both pass. Had `k0` failed, nothing below would be written.

**Step 7, write and commit.** One commit carries:

| Document | Write |
| --- | --- |
| The handling's receipt | Created |
| The message | Created, with the declared authorship entry |
| The reactions list | Created |
| The `messages` list | One appended link |
| The room's result document, the space's scope instance | One element appended to the `messages` output; one row subtree appended to the main list under `[UI]` |
| The room's result document, the sender's session scope instance | The new row's session-scoped paths |

A second session that has the room open receives the same commit. Its own
session-scoped paths for the new row are written when its scope key is
evaluated, in this transaction if the scheduler includes it (section 1.8).

### 10.2 Against the counts today

| Per send into a thirty-message room | Today | Compiled |
| --- | --- | --- |
| Transactions | The handler's, and one per node run that follows | One |
| Scheduler runs | 68 in the browser measurement; 36 in the pattern-test rig after the room's derivations became one walk, of which 17 are the new row's computeds | Not a unit. Cone evaluations: `facts`, `isEmpty`, the room's per-session records, and the new row's cones |
| Sandboxed calls for the 30 existing rows | None for their computeds; the `map` coordinator ran twice and resolved all 31 links each time, 219 link hops | None, and no coordinator: step 1 of section 2.5 reads the list once |
| CFC preparations | One per commit that touched labeled documents | One |
| Documents created | The message, the reactions list, the receipt, and the new row's family: a result slot and about forty owned cells | The message, the reactions list, the receipt |
| Label instantiations | One join per transaction | `T_send` once; none for unchanged rows |
| Round trips for the renderer to read the new row's cells | 26 | For the scheduler document. The new row's values arrive in one document |

The figures for today are from two measurement records:
[posting the thirtieth message](../../history/development/performance/2026-10-fabrichat-room-send-30-profile.md)
for the browser measurement and the round trips, and
[the thirty-first send's derivations](../../history/development/performance/2026-10-fabrichat-send-derivations.md)
for the pattern-test rig. Neither record gives the number of commits of a
send. The row family's size is from the
[row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md).

One cost remains. `facts` is one opaque call over the whole list,
so a send still walks every record once. Making that walk incremental is a
change to the pattern, for example by deriving per-message entries with a
`map` and folding them, and is not something the layout provides.

## 11. Open questions

Each entry states the assumption this document made.

### 11.1 For the project owner

1. **The size of a result document.** By ruling, a kept output is a path
   entry of the result document, the rendered tree included. A room's
   result then holds every row's tree, and a reader of the room loads all
   of it (section 4.9). Today a row's tree is in the row's own document and
   a reader loads the rows it follows links to. *Assumed:* one document,
   written by path-level patches, with no splitting. If measurement at
   stage 4 shows a bound is needed, the options are a size at which the
   runtime stores a kept subtree in a document of its own and links to it,
   which is a storage arrangement that changes neither values nor labels,
   or a way for a reader to load a result partially.
2. **Settled effect results at migration.** The stores of an effectful
   built-in are keyed today on a cause that includes the node's inputs
   document (`builtin-inventory.md`, "What every built-in shares"), which
   the compiled identifier does not reproduce. A migrated instance then
   finds no stored result and requests the effect again. For a
   language-model call that costs a request and changes the text a person
   already saw. *Assumed:* the migration copies a settled result forward
   when the stored store says it is settled for its current inputs, and
   requests again otherwise.
3. **Retiring documents.** Section 9.6 deletes retired documents after a
   retention period in which nothing read them, and section 9.7 has a
   migrated space refuse builds that predate the compiled layout.
   *Assumed:* thirty days, and refusal from the first migrated instance in
   the space.
4. **Instances whose stored source the compiler refuses.** Such an
   instance cannot be migrated and runs on the builder path. *Assumed:*
   when the builder path is retired it stops running, its stored state and
   last result stay readable, and it runs again when its source is
   updated.

### 11.2 For another document or the prototype

To `scheduler-and-serving-loop.md`:

5. **Dirty slots since a commit.** Section 3.4 needs the slots of an
   instance that changed since a given commit sequence number, after a
   restart and when demand returns. *Assumed:* available. The fallback is
   one evaluation of every demanded cone instance per process.
6. **Routing an event to a binding.** Section 4.7 stores no document for a
   stream of the reactive tier. *Assumed:* the event queue finds the
   instance and binding from the stream's identifier without one.
7. **Several scope keys in one transaction.** Section 1.8 evaluates a
   cone of user or session scope once per demanding scope key. *Assumed:*
   the scheduler names the keys and attributes each evaluation to its
   acting principal, in one transaction per cause.
8. **The first evaluation as a cause.** *Assumed:* a first evaluation and
   an evaluation on returning demand are causes of the second kind (section
   1.1).
9. **What is watched.** The addresses a cone instance depends on are its
   bound slots and its journaled dynamic reads (section 2.4). *Assumed:*
   the scheduler takes that set from the memo entry.
10. **A client and the element-key salt.** *Assumed:* a client cannot read
    the salt and learns value-keyed identifiers only from stored links
    (section 5.3).
11. **The identifier of a space an `inSpace` request creates.**
    `plan-and-label-templates.md` §3.14 says the space's identifier derives
    from the request. [Random space identities](../random-space-identities.md)
    says creating a space computes nothing from a string and returns a new
    identifier. *Assumed:* the identifier is obtained when the request is
    made and recorded in the cause's transaction (section 5.6), without
    saying which of the two holds.
12. **Staged events and effect requests.** *Assumed:* an event a handler
    sends and an effect it requests leave through the commit, as post-commit
    work, and are causes of their own.

To `plan-and-label-templates.md`, with the specification change where a
label is concerned:

13. **The label of an operation's bookkeeping state** (section 6.5).
    *Assumed:* `Operation.input` instantiated, for every path that has no
    rule of its own.
14. **The label of a cached output**, promoted or forced (section 8.6).
    *Assumed:* the output's own template instantiated. A cache document is
    a store the runtime owns, and the write-side fit check has to treat it
    as one, as it treats a built-in's store today.
15. **The protection of provenance records and origin facts** (section
    7.4). *Assumed:* label metadata of the path.
16. **What the prepared digest binds** (section 1.9). *Assumed:* the
    compiled pattern's identity and each instantiation key, as recorded
    decision inputs.
17. **The `shape` entry of a migrated path.** A migration replaces a stored
    link at a result path with a value. *Assumed:* the path's frozen
    `shape` entry is kept, so that a migration never loosens a stored
    label.
18. **Cache promotion as a channel** (section 8.7). *Assumed:* accepted,
    and added to the list in that document's §5.5.
19. **Inputs of a cone and of a body that are not slots** (sections 2.1 and
    2.2). *Assumed:* a cone receives the upstream outputs its incoming
    edges name, a body's record lists its computed captures, and the
    cone-level join of that document's §7.2 is over the slots of a cone and
    of the cones it pulls from.
20. **The order of `Plan.cones` and `Plan.outputs`** (section 2.3).
    *Assumed:* an edge outside a cycle goes from a lower index to a higher
    one.
21. **Names** (sections 5.2 and 5.5). *Assumed:* the plan gives every
    state cell, stream, operation and child a name that is unique within
    its body, and every compiled-in call site, every binding and every
    `lift` or `computed` that creates a cell a name, none of them
    positional among unrelated declarations.
22. **The scope of an output** (section 1.8). *Assumed:* decided at
    evaluation from the bound addresses, with the plan giving a lower
    bound. The `Output` record has no scope.
23. **A promotion directive per cone** (section 8.5). *Assumed:* the plan
    records one.
24. **State of an operation inside an element body.** That document names
    it per element key, so an aggregate declared in a row has one state
    document per row. *Assumed:* as that document says. The alternative,
    one document per operation with an entry per element key, would keep
    the number of documents independent of the number of elements.
25. **The back-link of a state cell.** The overview says a state cell's
    document carries no pattern metadata, and that document's §3.16 has
    `resultOwnerOf` read a document's back-link to its result. *Assumed:*
    a state cell document keeps the `result` back-link and carries no
    pattern reference, manifest or setup record.

To `language-subset.md`:

26. **The spelling of the promotion directive** (section 8.5).
27. **Stored source.** Section 9.4 compiles an instance's stored source.
    That document's open question 7 asks with which severities. *Assumed:*
    the interim acceptance of the removed forms applies, and any other
    refusal leaves the instance unmigrated.

To the prototype:

28. **The iteration bound** of section 2.7. *Assumed:* ten.
29. **The constants of section 8.3**, and the costs `read`, `write` and
    `hold`.
30. **Mixed labels in a kept collection.** Section 4.3 stores one entry per
    position whose label differs. Whether a shared entry for the common
    part and per-position entries for the rest is smaller needs
    measurement.
31. **Matching calls at migration** (section 9.3). How many compiled-in
    calls in the corpus the matching places, and how much state is stored
    under the ones it cannot.
