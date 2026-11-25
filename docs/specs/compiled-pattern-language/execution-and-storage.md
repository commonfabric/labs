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
  instantiation, error states, and what a split of the keep set into
  several documents has to preserve;
- `builtin-inventory.md`: each built-in, the element key rule, and which
  operations have durable state;
- `footprint-analysis.md`: the analysis that fills in a body's footprint;
- `scheduler-and-serving-loop.md`: everything across instances. That document
  owns dirty slots from the change channel, demand, the event queue and the
  batch of events, effects with their gates and retries, the scheduling of
  materializers, the basis index, links across spaces, and client
  speculation.

The boundary with the last one is this: it decides *that* a transaction is
run for a cause, *which* slots are dirty, *which* cone instances are stale in
storage, and *which* outputs are demanded. This document says what the
transaction does with those inputs for one instance, and what is written.

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
instance, cone, slot, template, kept output, plan, part document, storage
link. The terms of `scheduler-and-serving-loop.md` are used as defined
there: loaded, bound address, dirty, label-dirty, stale, demanded, wave.
This document adds the following.

- A **cause** is what a transaction is opened for: an event delivered to a
  handler, a set of changes, the completion of an effect, or a change of
  demand (section 1.1).
- A **scope instance** of a document is the document as one scope key
  addresses it: the space's, one user's, or one session's
  ([scoped cell instances](../scoped-cell-instances.md)).
- A **cone instance** is one cone of the plan as it is evaluated for one
  scope key and, inside element bodies, one element key per enclosing
  collection. The enclosing collections of a cone are the ones the
  `element` steps of `Cone.within` name
  (`plan-and-label-templates.md` §1.4). A cone outside every element
  body has one cone instance per scope key it is evaluated for.
- An **evaluation** is one run of a cone's value function for one cone
  instance.
- A cone instance is **current** when the memo holds an entry for it and
  nothing that entry records as read has changed, or, where the process
  holds no entry for it, when its basis rows are at the heads of their
  inputs (section 3.4). A cone instance that is not current is stale, in
  the sense of `scheduler-and-serving-loop.md`.
- A kept output, or the target of a write edge, is **unstored** when the
  memo holds a value or an instantiation key for it that storage does not
  hold (section 3.3).
- A **fingerprint** is a value that changes whenever the result of a read
  changes. Section 3 says what it is made of.
- A **split point** is a kept path at which a part document can begin
  (section 4.10).
- A **chunk document** holds a contiguous run of the entries of an array
  whose content is too large for one document, and a **chunk list** at
  the place of the array holds the storage links to the chunks, each
  with the number of entries below it (section
  4.10). A record with many members is stored in chunk documents the
  same way, by ranges of member names (section 4.10; provisional, P27).
  How a reference by key finds the chunk of its row without reading the
  chunks in order is open (section 4.10, "Finding the chunk of a key";
  question 110).
- A **collection reference** is what a cone holds of the assembled
  result of a per-element construct that it places and does not observe
  (section 2.2).

## 1. One transaction per cause

### 1.1 Causes

There are four kinds of cause. An event, a set of changes and a change of
demand each open one transaction. The completion of an effect opens none
beside the operation's own completion transaction: what reads the result is
evaluated in the derivation transaction of the set of changes its commit
joins. A transaction covers one space.

An effect operation has transactions of its own, which no cause of the
table opens for an instance: its request transaction, its completion
transaction, and, for a language-model built-in, a send transaction
before each send after the first (section 6.4). They are the boundary's
transactions. Each commits or is rejected by itself.

| Cause | What it carries into the transaction | Its transaction |
| --- | --- | --- |
| An event delivered to a handler | The event's payload (the `event` slot root), its key and its acting principal (the `cause` slot root), the handling it is (section 5.4), and the binding the stream belongs to (the `binding` slot root) | An **event's transaction**: the stale cone instances the handler reads, then the handler body. It holds no other derivation |
| A set of changes | The slots whose bound addresses changed, and the slots whose label alone changed. The changes are commits arriving from storage, written by another instance, by another runtime, or by the runtime itself, such as a clock tick (`plan-and-label-templates.md` §3.19) or the commit of an effect's completion (next row), and the writes of the events of a batch | A **derivation transaction** |
| The completion of an effect | The `operation` slots of the completed operation. They are dirty because the operation's own completion transaction wrote the result and committed (section 6.4) | The derivation transaction of a set of changes: the completion's commit is one of the changes of the set of the cycle that follows it (`scheduler-and-serving-loop.md` §10.2) |
| A change of demand | The kept outputs that became demanded, with the dirty slots already recorded for their instances | A derivation transaction. It runs as the demanding principal, for the scope instances of that principal (`scheduler-and-serving-loop.md` §4.5) |

**Events are handled in batches.** Each event of a batch has a transaction
of its own. Every derivation that the batch's events made stale and that
something demands is evaluated once, in one derivation transaction behind
the batch, and not once per event. The one exception is what a later handler
of the batch reads: the stale cone instances it reads are evaluated in that
handler's own transaction, before its body (section 1.3). Which events form
a batch belongs to `scheduler-and-serving-loop.md`.

*Assumed:* the changes one cycle of the serving loop drains from storage and
the writes of the events that cycle handled form one set of changes, and so
one derivation transaction (`scheduler-and-serving-loop.md` §10.2). The
commit of a completion is among the changes the cycle that follows drains.
Which changes form one set belongs to that document. Nothing below depends
on the choice.

A cause's transaction can evaluate more than one instance: a pull of an
output extends through a link into the producing instance, and a child
instance in the same space is evaluated in the transaction that pulls its
result (`plan-and-label-templates.md` §3.15). The order in which instances
are evaluated belongs to `scheduler-and-serving-loop.md`. Sections 1.3 to 1.5
describe the part of a transaction that concerns one instance. Section 1.6
describes the commit preparation, which runs once per transaction over
everything staged in it.

**From the creation of an instance to its settled result.** An instance
that a handler creates gets its result document and its argument
document in that event's transaction (section 1.4). Its cone instances
are evaluated when something demands a kept output of it, in one
derivation transaction: that of the change of demand, or the one behind
the batch where the demand already stands. That transaction evaluates
every demanded cone instance of the instance to a fixed point, and
those of its children in the same space (section 1.5). So an instance
that requests no effect and has no child in another space settles in
two transactions, the one that creates it and one derivation
transaction. No row of the table is the creation of an instance by
something that is no handler, such as a command that starts a pattern
in a space. *Assumed* (section 11, question 77): such a creation is one
transaction that writes the argument document and what links to the
result cell, and it evaluates nothing, so the count is two there as
well.

### 1.2 The sequence

**An event's transaction** has these steps.

| Step | What happens | Governed by |
| --- | --- | --- |
| Bind | The `event`, `cause` and `binding` roots are bound | Section 1.1 |
| Before the body | The stale cone instances that compute what the handler reads are evaluated. Each stages the values of its kept outputs and of its side-writes as it is evaluated | Section 1.3 |
| The body | The handler body runs once. It stages writes and requests. When it returns, the requests are performed: each cell, child instance, effect request and binding it asked for is given its identifier and its initial documents | Sections 1.4, 4.6 and 5.4 |
| Preparation | Section 1.6 | |

**A derivation transaction** has these steps.

| Step | What happens | Governed by |
| --- | --- | --- |
| Bind | The dirty slots, the label-dirty slots and the demanded outputs are bound. The `operation` slots of an operation whose completion committed are among the dirty slots | Section 1.1 |
| Evaluate | The cone instances that are stale and needed for a demanded output are evaluated, to a fixed point bounded as section 2.7 says. Each stages the values of its kept outputs and of its side-writes as it is evaluated, and the requests of the instances its evaluation makes are performed when the evaluation ends | Sections 1.5, 2 and 2.8 |
| Preparation | Section 1.6 | |

**The preparation** is the same in both and runs once per transaction, over
everything the transaction staged for every instance and every scope key.

| Step | What happens | Governed by |
| --- | --- | --- |
| Instantiation | The templates of what the transaction stores or checks are instantiated, where one of the three conditions of `plan-and-label-templates.md` §4.1 holds, in the order its §4.5 gives | Section 1.6 |
| Constraints | The constraints of what was instantiated are checked. A failure rejects the event's transaction or drops one write, depending on whose write it guards | Section 1.7 |
| Seal | The labels and the provenance records are staged with the values, the part documents are arranged (section 4.10), the preparation takes its snapshot, and the transaction seals | Sections 1.6, 1.9 and 4 |

Nothing reaches storage before a transaction seals. On a runtime with no
wave, sealing is committing. On a serving runtime a sealed transaction joins
the wave, and a later transaction of the same cycle reads what it staged
(`scheduler-and-serving-loop.md` §10.2).

The runtime may instantiate a handler's write edges and check their
constraints as soon as the body returns, so that an event that will be
rejected stops before the preparation. The check in the preparation is still
made, and the outcome is the same.

### 1.3 Before a handler body

What a handler reads is known from its record before its body runs: the
slots of `Body.reads` and the entries of `Body.computed`
(`plan-and-label-templates.md` §5.4). The cone instances evaluated before the
body are the stale ones that compute a value among them. They include the
ones an earlier event of the same batch made stale.

- **The state of a binding of the reactive tier.** Such a binding copies
  nothing. Every path of the handler's state resolves to what the
  member `place` of its entry of `Binding.state` names
  (`plan-and-label-templates.md` §1.1): a slot of the instance, an output
  of the instance, the stream of another binding of the reactive tier, or
  a constant written at the binding. That holds in the body of a
  per-element callback too. Where the path is an output, the cone that
  computes it is evaluated, and its value is materialized into the handler's
  argument when the event is delivered. The body sees the value as of the
  event and not as of an earlier evaluation.
- **The state of a binding made in a function body.** Its `binding` slots
  resolve through the binding's state document (section 4.7). A copied path
  holds a value and no cone computes it. A path that holds a link, to a cell
  or to a container bound by reference, is a slot whose path crosses the
  link (`plan-and-label-templates.md` §2.5). The handler reads the target
  when the event arrives, in the event's transaction, and a stale cone
  instance that writes the bound address is evaluated first.
- **A cell that a cone writes statically.** A slot of the handler can be
  bound to the target of a static side-write: a state cell, or a cell
  reached through a handle (`WriteEdge` targets of kind `state` and
  `handle`). The writing cone instance is evaluated first when it is stale,
  with every cone instance it depends on. Inside one instance the plan's
  edges name the writer (`ConeEdge.via` of kind `state` or `handle`). Across
  instances the writer is found from the bound addresses, which the
  scheduler's writer map holds.
  Provisional (P8; section 11, question 98): the slot is one through which the
  handler reads the cell, of class `value`, `shape` or `enumeration`. A slot of
  class `identity` observes the reference and not the content, and where the
  handler holds that slot alone, because its body only writes through the handle
  or passes it on, the writing cone instance is not evaluated before the body on
  its account (`scheduler-and-serving-loop.md` §5.2, "A slot that observes the
  reference alone").
- **A writer in an instance that is not loaded.** The writer map holds no
  entry for it. Where the document a slot is bound to names such an
  instance, the basis rows decide, by ruling
  (`scheduler-and-serving-loop.md` §4.4 and §10.4). Where they show the
  stored value current, the slot is read from storage and the instance is
  not loaded. Where they show it stale, the instance is loaded and the
  stale cone instance that writes the address is evaluated first. The
  check and the load happen before the transaction opens; the evaluation
  is in the transaction, before the body (§5.2 there).
- **A static read through a handle.** A read through a handle that
  `footprint-analysis.md` §7.2 makes static is a slot of `Body.reads` like
  any other, and is covered by the rules above.
- **An output that is current and unstored.** A cone instance can be
  current while a kept output of it is unstored, because the transaction
  that evaluated it did not commit (section 3.3). Nothing is evaluated for
  such an output, and nothing is staged at its address. Where a slot of
  `Body.reads` is bound to that address, or a cone instance evaluated for
  the handler reads it, and the output carries no refusal, the runtime
  stages the output from the memo entry before anything in the
  transaction reads the address, and instantiates it early, like a write
  the body reads by address (section 1.6). The handler would otherwise
  read the stored value, which was computed before the change that made
  the cone instance stale. An unstored output that carries a refusal is
  not staged: the handler reads what is stored, as it does where the
  early check drops a write.
- **Nothing else.** A slot with root `event` or `cause` is read from the
  cause. A slot bound to an address no cone writes is read from storage. A
  slot bound to an output of another instance is brought up to date by the
  pull across instances, which the scheduler orders.

A read through a handle listed in `Body.handles` is not known before the
body runs. Section 1.4 says what happens when it is made. Where the bound
address of one of the handler's slots, or such a read, lies inside the
envelope of an invalid materializer, `scheduler-and-serving-loop.md` §5.2 and
§5.3 govern. For a slot the materializer runs first, in its own
transaction. For such a read the attempt is withdrawn, the materializer
runs, and the event is dispatched again (section 1.4). A materializer that
cannot be promoted, because a stale cone instance that produces one of its
computed inputs performs a side-write (section 6.7), runs behind the
derivation transaction. The event then waits for it: it holds its place
in the queue, the batch ends before it, and it is handled after the
derivation transaction and the materializer have run
(`scheduler-and-serving-loop.md` §7.2). A read through such a handle that
reaches a writer in an instance that is not loaded follows the two cases
of section 1.4.

### 1.4 The body

The runtime builds the handler's argument from the slots in `Body.reads`
and the entries of `Body.computed`, each validated against its schema and
narrowed to its class (section 2.4), hands the body the handles its record
names, and calls it once.

Before the argument is built, two groups of derived writes that this
transaction staged are instantiated, and their constraints are checked
(section 1.6, "What is instantiated early"): every one at an address a
slot of `Body.reads` is bound to, and every one at an address that was
read by a cone instance whose value the handler receives. A slot is then
materialized from what is staged at its address, or from what is stored
where the check dropped the write. A cone instance that had read a dropped
write is evaluated again before the argument is built, against what is
stored.

During the call:

- A **write through a handle** is staged in the transaction. The runtime
  refuses a write that neither a `WriteEdge` in `Body.writes` nor a
  `WriteEnvelope` in `Body.envelopes` covers
  (`plan-and-label-templates.md` §3.11 and §7.4). A write through what
  `resolveAsCell()` returned, a target with `resolved`, lands in the cell
  where the resolution ends. The runtime resolves the reference when the
  write is made. A write through a handle that `key` flattened lands in
  the inner cell: for `h` of type `Cell<{ a: Cell<T> }>`, a write through
  `h.key("a")` is staged in the cell the link at `a` leads to, at the
  path below it, and does not replace the link stored at `a`
  (`plan-and-label-templates.md` §3.11; `footprint-analysis.md` §6.2).
  The runtime follows the link at `a` when the write is made, and the
  staged write names the inner cell's document as its target.
- A **read through a handle** follows the rules of section 2.4: it returns
  the materialized slots where slots cover it, it is journaled under the
  entry's envelope where the handle is listed in `Body.handles`, and it is
  refused otherwise.
- A **journaled read is made current at the read.** Before a read through a
  handle of `Body.handles`, or through a link the body follows, returns, the
  runtime looks up the address in the writer map. When a stale cone instance
  of a loaded instance of the same space writes it, that cone instance is
  evaluated first, inside the transaction and under the bound of section
  2.7. A kept output at the address that is unstored, carries no refusal,
  and has a current cone instance is staged from the memo entry (section
  1.3). A derived write that this transaction staged at the address, by
  that evaluation, by an earlier one or from the memo, is instantiated and
  checked before the read returns (section 1.6). The read then returns
  what is staged, or what is stored where no write is staged or the check
  dropped the write.
  Where the writer is in an instance of the same space that is not loaded,
  the scheduler's basis rows decide, by ruling
  (`scheduler-and-serving-loop.md` §5.3 and §10.4). Where they show the
  stored value current, the read returns it, with the label stored there,
  and the instance is not loaded. The check reads rows and loads nothing.
  Where they show it stale, the attempt is withdrawn whole, the instance
  is loaded, and the event is dispatched again under the same handling,
  so that it names the same things. The second attempt finds the instance
  loaded and evaluates the stale cone instance at the read. The attempt is
  withdrawn in the same way where the address lies inside the envelope of
  an invalid materializer, which runs before the event is dispatched
  again. Where that materializer cannot be promoted, the event waits for
  it as section 1.3 says (`scheduler-and-serving-loop.md` §7.2). Where the
  writer is in an instance that is marked as torn down, or in another
  space, the read returns what is stored.
- A **request** (`Body.calls`) is recorded and returns at once: a link to an
  instance, a handle to a cell, a link to an effect's result, or a stream.
  The identifier in what is returned is computed from the request and the
  handling (section 5.4), so the body can store it, pass it on, or read
  `spaceOf` from it in the same invocation. A read through the link of an
  instance requested in the same invocation finds no value, because the
  instance's documents are staged when the body returns.
- An **event sent to a stream** is staged, as an entry appended to the
  stream's document. It joins the queue when the transaction seals. An
  event for a stream of the same space joins the batch, and is handled in
  a transaction of its own as a cause of its own
  (`scheduler-and-serving-loop.md` §5.1). An event for a stream of another
  space leaves through the outbox after the commit (§9.3 there).

When the body returns, the requests are performed. A requested cell is
staged with its initial value. A requested child instance gets its result
document and its argument document when its link was written into state or
passed to `navigateTo`. A request whose link the body dropped stages
nothing: no result document, no argument document, and so no write on
which a constraint could fail (`plan-and-label-templates.md` §3.14 and
§4.4). An effect request stages the stored request, its hash and the
pending mark in the operation's state document (section 6.4). A binding
made in the body stages its state document (section 4.7).

The body's staged writes dirty the slots bound to the addresses they wrote,
exactly as a change from storage would. The cone instances those slots make
stale are not evaluated in the event's transaction. They are evaluated
before the body of a later event of the batch that reads them, or in the
derivation transaction behind the batch. That holds for a child instance the
body requested as well: it is evaluated in a derivation transaction, when
something demanded reads its result.

*Assumed:* a body can be suspended at a read while the runtime evaluates a
cone instance, which can invoke another sandboxed body. Functions hold no
state between calls (`language-subset.md` §3.3), so the nesting changes no
result. The time and memory budget of the outer body does not count what the
nested evaluation uses. The prototype has to confirm that the sandbox allows
it.

### 1.5 Derivation: behind a batch, and for the other causes

The second step of a derivation transaction is the same whatever its
cause. Its input is a set of dirty slots, a set of label-dirty slots, and
a set of demanded outputs.

- **Evaluation.** The runtime evaluates the cone instances that are both
  stale and needed for a demanded output, in the manner section 2 describes.
  A value staged during the step dirties the slots bound to the address it
  was staged at, in this instance and in others, and a cone instance made
  stale that way is evaluated in the same transaction when it is needed,
  within the bound of section 2.7. Matching staged writes against bound
  addresses is the scheduler's
  (`scheduler-and-serving-loop.md` §3.5).
- **A slot whose label alone changed** makes no cone instance stale and runs
  no value code. A demanded output whose template reaches such a slot under
  its last selections is instantiated again in the preparation, from the
  value and the selections the memo holds (section 3.3).
- **An unstored output** that something demands is stored by this
  transaction from the memo, without an evaluation (section 3.3). It is
  staged before anything in the transaction reads its address, so that
  no reader takes the stored value.
- **What is not needed stays stale.** A cone instance that is stale and not
  needed is not evaluated. Its kept outputs keep their stored values and
  labels until something demands them (`plan-and-label-templates.md` §5.5).
- **Children.** A child instance in the same space is evaluated in this
  transaction when something demanded reads its result, by the same
  procedure. That covers a child a handler of the batch requested and a
  child a cone's evaluation made (section 2.8).

A derivation transaction has no handler, so every write in it is a derived
write.

### 1.6 Instantiation, constraints, and seal

Instantiation and the constraint checks are `plan-and-label-templates.md`
§4. This document adds what they act on, in what order relative to
evaluation, and what is written.

- **Values are staged at evaluation, labels in the preparation.** The value
  of a kept output and of a side-write is staged when its cone instance is
  evaluated, so that a consumer in another instance reads it inside the
  transaction. Its label is instantiated in the preparation, with the one
  exception of the next item.
- **What is instantiated early.** A handler body is not run again when a
  constraint drops a write, so it must neither read nor be handed a value
  that a later check drops. In an event's transaction three groups of
  derived writes are therefore instantiated, and their constraints
  checked, ahead of the rest of the preparation
  (`plan-and-label-templates.md` §4.5 and §4.6).
  - *What a cone instance read whose value the handler receives.* The
    handler receives the value of a cone instance for each entry of
    `Body.computed`, such as a state path that names an output of its
    instance. The writes concerned are the derived writes this
    transaction staged at an address read by such a cone instance, or by
    a cone instance it pulled from through any number of `output` edges:
    a side-write to a state cell or to a cell reached through a handle, a
    path of a child's argument, and a kept output that a slot's path
    reaches through a link. They are instantiated and checked after the
    cone instances of section 1.3 were evaluated and before the handler's
    argument is built.
  - *What the body reads through a slot of `Body.reads`.* The writes
    concerned are the derived writes this transaction staged at an
    address such a slot is bound to. A kept output that was unstored and
    is staged from the memo is one of them, in this group and in the
    first (section 1.3). They are
    instantiated and checked at the same point.
  - *What the body reads through a journaled read:* a read through a
    handle of `Body.handles`, or through a link the body follows. A
    derived write this transaction staged at the address read, by a cone
    instance evaluated before the body, by one the read made current, or
    from the memo (section 1.4), is instantiated and checked before the
    read returns.

  Such a write is instantiated after the staged writes it uses
  (`plan-and-label-templates.md` §4.5), which are instantiated and checked
  first. That section counts the same writes in another division: the
  second and third groups here are its one group of writes the body reads
  by address, and the staged writes one of these uses are its third. A
  write the check drops is unstaged at once. A slot or a
  journaled read at its address reads what is stored and resolves to the
  stored label. A cone instance that had read the dropped value through a
  slot is stale again and is evaluated again, against what is stored,
  before the handler's argument is built or the read returns (section
  1.7). The writes that evaluation stages belong to the same groups.

  The early step is a step of the preparation, made ahead of the rest: the
  same instantiation of the same template, from the labels stored or
  staged when the read is made. The preparation keeps the instantiation
  key and the verdict in the write's unit (section 1.9) and does not
  instantiate the write again. A label the body stages afterward does not
  enter it, because the value was computed from what was there before
  (section 11, request 50).

  Everything else is instantiated in the preparation: the handler's own
  write edges, the derived writes of the event's transaction that are in
  none of the three groups, and every write of a derivation transaction. A
  value a handler receives for a state path that names an output of its
  instance is not read by address (section 1.3): the handler's template
  holds the output's template, and the handler receives the computed value
  whether or not the output's own write is stored. The first group covers
  what the cone instance that computed the value read by address. A body
  that runs inside a cone needs no early step, because a cone instance
  that read a dropped value is evaluated again (section 1.7).
- **What is instantiated.** The templates of what the transaction stores or
  checks. `plan-and-label-templates.md` §4.1 has the list. An interim
  value is not instantiated for storage: no label is stored for it and
  no constraint is checked on it. Where a template that is instantiated
  names an interim output, with an `output` node, the preparation forms
  the label of that output's template once in the transaction and uses
  it at every node that names the output
  (`plan-and-label-templates.md` §4.1, "A label is instantiated once").
- **When there is something to do.** One of the three conditions of that
  section holds: the cone or body that computes the value was evaluated in
  this transaction; something demands it and a slot its template reaches
  has a new label and an unchanged value; or it is unstored and something
  demands it. A slot that the template reaches through an output it
  names counts, and whether an output reaches such a slot is found once
  per output (`plan-and-label-templates.md` §3.2, "A rule over a
  template").
- **Order, and labels staged in the transaction.** A write is instantiated
  before every template that has a slot bound to its target: the derived
  writes instantiated early first, in the three groups above, each before
  the argument or the read that needs it and after the staged writes it
  uses; then a handler's write edges; then producers before consumers, in
  the order the cone instances were evaluated. A slot bound to an address
  this transaction, or an earlier transaction of the batch, wrote resolves
  to the label staged there and not to the stored one
  (`plan-and-label-templates.md` §4.5).
- **A derived write of a cone instance evaluated before a handler body**
  is a derived write of the event's transaction: a kept output, a
  side-write, a path of a child's argument, or a path of an effect's
  request. Its value was staged when the cone instance was evaluated. If
  the body then wrote something that cone instance had read, every
  derived write of the cone instance that was not instantiated early is
  withdrawn before the preparation: its label would otherwise be
  instantiated from the label the body staged, for a value computed from
  what was there before. The cone instance is stale, the handler keeps the
  value it read, and the derivation transaction behind the batch evaluates
  the cone instance and stores its writes. Where a write edge of the cone
  instance is withdrawn this way, the memo entry of the cone instance is
  dropped, as it is where a conflict withdrew a side-write (section 3.3).
  A write that was instantiated early is not withdrawn this way. Its
  label was instantiated before the body wrote,
  from the labels its value was computed under, and the handler's own
  writes use it (section 1.9), so a withdrawal would leave out the
  handler's unit with it. It commits with the event's transaction under
  that label. Its cone instance is stale all the same, and the derivation
  transaction behind the batch evaluates it again and stores the result
  (`scheduler-and-serving-loop.md` §5.2 has the same rule).
- **What is written.** For each kept output: its value, when the value
  changed; its label entries, when the instantiation key changed; its
  provenance record, when the key or the template changed (section 7). For
  each staged write to a state cell, a cell reached through a handle, a
  created cell, a child's argument, a stored request or a binding's state
  document: the value and the label of its write edge. Section 4 gives the
  layout.
- **What is not written.** A kept output whose value and instantiation key
  are both unchanged produces no write. This is the equality cutoff: a
  cause that changes nothing a reader can see commits nothing for that
  output. A document of which no path changed is not written.
- **Seal.** The transaction seals once. One transaction writes the result
  document and every part document it changed, so no reader sees a partly
  updated result. Section 1.9 relates the seal to commit preparation as it
  exists today.

### 1.7 Failure

There are five outcomes. `plan-and-label-templates.md` §4.4 and §5 govern
the label side of each.

- **A failed constraint on what a handler itself writes rejects the event's
  whole transaction.** What a handler itself writes is everything its body
  staged: its write edges, the arguments of the instances it requested, the
  requests of the effects it asked for with their egress ceilings, the
  copied state of the bindings it made, and the copied parameters of the
  inline patterns it instantiated. An instance whose link the body dropped
  staged nothing and is not among them (section 1.4). Nothing the event
  would have written is committed. The other events of the batch are not
  affected. The rejection is reported to whoever delivered the event. What
  it reveals is bounded as `plan-and-label-templates.md` §5.5 says.
- **A failed constraint on a derived write drops that write alone.** A
  derived write is a kept output, or a write edge of a cone. The dropped
  write is unstaged. Its target keeps the value, the label and the
  provenance record that are stored, and the rest of the transaction
  commits, other outputs of the same cone instance included. A cone
  instance that had read the staged value through a slot, in this instance
  or another, is stale again. In a derivation transaction, and before a
  handler body, it is evaluated again in the same transaction, against
  what is stored. After a handler body it is not evaluated again in the
  event's transaction, which holds no derivation behind the body: the
  writes it staged from the dropped value are unstaged with the dropped
  write, and the derivation transaction behind the batch evaluates it
  (`plan-and-label-templates.md` §4.6;
  `scheduler-and-serving-loop.md` §3.5). Such a cone instance is not one
  whose value the handler received, because the early step of section 1.6
  checked, before the body ran, every write that such a cone instance
  read. A write dropped once is not staged again in the same transaction.
  Section 3.3 says what the memo holds.
- **A failed cone takes a labeled error state and the rest commits.** The
  failed cone instance's outputs hold an error state whose label is the
  output's template instantiated with the selections made up to the
  failure. A kept output stores the error state at its path with that
  label. A cone that reads the errored value fails in turn. What the
  target of a write edge of the failed cone takes depends on the target
  (`plan-and-label-templates.md` §5.2). A path of a child's argument and a
  path of an effect's request take the error state. A side-write to a state
  cell, to a cell reached through a handle, to a created cell or to an
  anchors document is withdrawn, and the target keeps the value and the
  label it had before the transaction. Every other cone instance evaluated
  for the cause commits normally.
  Provisional (P11): an error state is the record `{ $error: { message } }`, and
  a cone that places a failed value in what it returns and observes nothing of
  it does not fail: the value it returns holds the error state at that position
  (`plan-and-label-templates.md` §5.2 and §5.3). The withdrawal of a side-write
  differs from today, where a node that throws commits the writes it made before
  it threw (`plan-and-label-templates.md` §5.2 and its question 172).
- **A handler body that throws aborts the event's transaction**, as it does
  today. Its staged writes and requests are discarded. A handler that
  receives an error state for one of its inputs, because a cone instance it
  reads failed, fails in the same way: the event's transaction is aborted,
  and nothing it staged is stored, the error state of the failed cone
  instance included, which is unstored (section 3.3). Where a cone
  instance evaluated before the body failed and the handler does not read
  it, the item above applies: its outputs take the error state and the
  rest commits.
- **A conflict.** When a document a derived write targets, or something the
  write was computed from, moved before the commit, that write is withdrawn
  alone and the rest of the transaction commits. A stale read of the
  handler itself requeues the event whole. Both are decided when the wave
  commits (`scheduler-and-serving-loop.md` §5.5). Section 1.9 says what a
  withdrawal leaves of the preparation, and section 3.3 what the memo
  holds.

A failed cone instance is not evaluated again by the next cause. Its memo
entry holds the error state and the reads made up to the failure, and it is
current like any other entry: it is evaluated again when something it read
changes. That holds for a cone instance that failed at the bound of section
2.7, by ruling. Provisional (P10; `scheduler-and-serving-loop.md` §12,
question 43): the entry of a cone instance that failed at the bound is
current against what is stored when its transaction ends, after its
side-writes are withdrawn, and not against the values that its last
evaluation read, which the transaction staged and then withdrew. A cause
that changes nothing the cone instance reads does not evaluate it again.
The same is assumed for a body that wrote a cell, read it, and threw. *Assumed:*
it holds as well for a body that exceeded its
time or memory budget, although that failure is not a function of the
inputs alone (section 11, question 34).

### 1.8 Scope instances

A cone's output can depend on state that differs by user or by session, and
such an output has one value per user or per session. FabriChat's rows are
the reference: each row derives values from the room's per-session `composer`
cell and from its own per-session `pickerOpen` cell
(`patterns/system/fabrichat/message-row.tsx`).

- **The scope the plan gives.** `Output.scope` is the narrowest scope the
  plan can show for an output: the narrowest declared scope among the state
  cells and children its template reaches, and `user` where it depends on a
  read that answers for the acting principal
  (`plan-and-label-templates.md` §1.4).
- **The scope of a cone instance** at run time is the narrowest among
  `Output.scope` of the cone's outputs, the scopes of the addresses its
  slots are bound to, and the scopes of the addresses its `dynamic` nodes
  read, in the order `space`, `user`, `session`. It is the plan's scope or
  a narrower one, because a slot can be bound through a link to a document
  of narrower scope. `Output.scope` is part of the rule because a read
  that answers for the acting principal, such as `spaceAccess`, is made at
  one address for every principal, so the addresses alone would give its
  cone instance space scope. For the addresses, this is the rule built-ins
  apply to their stores today (`builtin-inventory.md`, "the narrowest
  scope the input read touched").
- **Evaluation is per scope key.** A cone instance of space scope is
  evaluated once for a cause. A cone instance of user or session scope is
  evaluated once per scope key that demands it, with the slots of that scope
  bound to that key's scope instances.
- **Storage is per scope instance.** A kept output of narrower scope is
  stored in the scope instance, for that key, of the document that holds
  its path (section 4.2).
- **A value of narrower scope that a cone of the space places.** An
  operator expression written at a position of a constructed value, a
  child or an attribute of a JSX element or the value of a member of a
  record, or the argument of a spread into a record, that reads a value
  of narrower scope is a value of its own in a cone of its own, and the
  cone around it places the value without reading it. In the body of a
  per-element construct the cone has one instance per element key, as
  the element's own cone has, for a construct over an array of
  references, over an array of plain values in place, and over the result
  of another per-element construct. *Provisional (decisions P451 and P454
  of the prototype):* the value is stored in a document of its own for
  each output and element keys, in the scope instance of each key that
  evaluated it, and the position that places it holds a link of that
  scope to it, so a row that places such a value stays a row of the
  space, evaluated once for every key, as today's runtime keeps the result
  of a node of a row that reads a cell of a scope in a cell of its own for
  the row. A spread of such a value gives each member the type declares
  as a link into that document. A derivation for one scope key brings up
  to date the documents whose inputs a change marked for that key or for
  the space, and every one for a key not evaluated for before. Whether
  such a document is made only for a key whose reader demands it is
  question 115.
- **A value found to be of a narrower scope after it was stored.** The scope
  of a cone instance is known once it is evaluated, and a value can become of
  a narrower scope later, as a body over an array of references does when an
  element comes to hold a link to a document of a scope. *Provisional
  (decision P458 of the prototype):* a document that holds what a body
  returned whole for an output, named in the space while the value was of
  the space, is no place of the value from then on: the value is stored in
  the document of its scope, nothing stores it in the document of the space
  again, a row that holds a reference into that document is evaluated again,
  and the rows of a collection over it that stood in a document of the space
  are stored in the scope instances, as for a collection of that scope from
  the first. The move is one way, since the scope of a cone instance only
  narrows.

The scheduler says which scope keys demand an instance. One derivation
transaction may hold the evaluations for several scope keys, each carrying
the acting principal, the scope key of what it writes, and the read ceiling
of the session it acts as (`scheduler-and-serving-loop.md` §10.3). A
transaction whose cause is a change of demand evaluates for the demanding
principal alone. Labels stay per scope instance because each kept output's
label is instantiated from its own bound slots, never from a union over the
transaction.

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
Five things differ.

1. **One preparation per transaction.** The preparation runs once, over
   everything the transaction staged for every instance and scope key it
   evaluated.
2. **Where a written path's label comes from.** For a path the plan
   covers, which is everything `plan-and-label-templates.md` §4.1 lists,
   the preparation calls `instantiateTemplate` with the path's template and
   its bound slots, in place of stamping the transaction's join. The
   preparation performs the instantiation itself. It does not accept a
   label a caller computed, which keeps the property that no caller
   supplies what the verifier verifies. The persist step is unchanged: it
   writes envelope entries of the existing shape
   (`plan-and-label-templates.md` §2.3).
3. **What the prepared digest binds.** `plan-and-label-templates.md` §4.6
   governs. The preparation records as decision inputs, and the digest
   binds: the identity of the compiled pattern of every instance the
   transaction evaluated; for every template it instantiated, the
   instantiation key, which holds the slot-free template hash, the
   selections and the children a `pick` chose, the label identifiers of the
   slots, the staged ones among them, the label identifiers of the outputs
   that the template names (provisional, P2; its question 163) and of the
   entries of the template table that it names (provisional, P6; its
   question 168), and the labels of the `dynamic` nodes with their trigger
   reads; and which derived writes a failed constraint dropped, and which a
   conflict withdrew, so that the digest is over the writes that commit. A
   read, a write or a new decision input after the preparation invalidates
   it, as it does today. The withdrawal of a derived write at the commit is
   the one exception, and item 4 says why it needs no second verification.
4. **Units, so that a conflict can withdraw one derived write.** The
   preparation records what it verified per **unit**, as
   `plan-and-label-templates.md` §4.6 ("Units") rules.
   - **What a unit is.** Everything a handler itself stages for one event
     is one unit (§4.4 there lists it). Each derived write is a unit of
     its own, together with the runtime-stored state that describes that
     write alone (§2.6 there): its provenance record (section 7.2), and
     for a cached output the other members of its cache entry (section
     8.4). Runtime-stored state that describes several writes is a unit
     of its own: the bookkeeping of an operation (section 6.5), the origin
     facts of a kept derived collection (section 7.3), and the record of
     the instances one cone instance made (section 2.8). The writes
     computed from such state use that unit. A derived write that a failed
     constraint dropped is a unit that holds the verdict and no write.
     Every write the transaction stages is in exactly one unit. Which
     document stores a kept path is not a write in this sense: the
     arrangement of part documents (section 4.10) follows the paths that
     commit.
   - **What a unit holds.** Its writes, the instantiation keys of their
     templates, the verdicts of their constraints, what it read from
     storage, and the units it uses. What a derived write read from
     storage is the reads of the cone instance that computed it and of the
     cone instances it pulled from through `output` edges, the reads a
     memo entry records for them included (section 3.5).
   - **What a unit uses** is as §4.5 there lists it ("What a write uses").
     A unit uses another unit when a slot of one of its templates, of one
     of its constraints, or of an egress check on it resolved to a label
     the other staged; when its value was computed from a value read at an
     address the other staged, by a slot, by a journaled read, or by the
     following of a reference; when a label-metadata observation that
     joins its label read a label the other staged; or when its target
     exists only through a write of the other. The relation is taken
     transitively, and it crosses the transactions of a batch: a unit uses
     a unit of an earlier transaction of the batch whose staged value or
     label it read. A value a cone receives through an `output` edge, and
     a value a handler receives for a state path that names an output of
     its instance, are not uses. The reads of the producing cone instance
     are reads of the receiving unit in their place.
   - **The digest** is computed over the digests of the units that commit,
     with the identities of the compiled patterns and the list of the
     units that were dropped or withdrawn.
   - **The commit leaves out every unit that uses a unit it leaves out.**
     When the commit withdraws a derived write on a conflict, it withdraws
     every unit that uses that write's unit, in the same transaction and
     in the later transactions of the batch, and computes each digest
     again over the units that remain. Nothing is instantiated or checked
     again, because the value, the labels and the verdicts of a unit that
     remains were computed from what is stored and from what the units it
     uses staged, and each of those commits with it (§4.6 there, "Why
     nothing is verified again"). The withdrawal is recorded as a decision
     input, as a dropped write is. A dropped write among the units
     withdrawn loses its verdict with them, and its refusal is not
     recorded with the instance. A withdrawal that reaches the unit of a
     handler's own writes withdraws the event's transaction whole
     (`scheduler-and-serving-loop.md` §5.5).
   - **A dropped write is used by no unit.** It is unstaged when the check
     drops it. A cone instance that had read its value is stale again. In
     a derivation transaction, and before a handler body, it is evaluated
     again in the same transaction. After a handler body its staged writes
     are unstaged with the dropped one, and it is evaluated in the
     derivation transaction behind the batch (section 1.7). A handler's
     unit uses no dropped write, because every derived write that the
     body reads by address, or that was read by a cone instance whose
     value the handler receives, is checked before the body reads it or
     before the handler's argument is built (section 1.6).

   The units are a host arrangement of the preparation. The property that
   §4.6 there requires of it is that no write commits whose value, label
   or verdict was computed from a value or a label staged by a write that
   does not commit.
5. **What the journal is still for.** Reads made to materialize slots, reads
   through handles and reads through links are journaled as today. The
   journal remains the commit's read set for conflict detection, attributed
   to units as item 4 says, and it remains the source of the `dynamic`
   templates. The trigger reads of a `dynamic` node are not in the journal
   of the evaluation: the scheduler holds them with the instance record,
   and the preparation takes them from there
   (`scheduler-and-serving-loop.md` §3.4). They stay in the instance record
   until every write of the evaluation that consumed them is stored, so
   that a transaction that later stores an unstored write from the memo
   forms the same instantiation key. The journal is not the source of the
   label of a plan-covered path.

A write the plan does not cover is not part of a cause's transaction for a
compiled instance. A materializer keeps its own transactions and today's
derivation (`plan-and-label-templates.md` §3.11; section 6.7).

The serving loop forbids label unions over a wave and places the CFC check
at the end of each action run
([serving loop](../server-side-execution/serving-loop.md), §3c). One
transaction per cause removes the action run as a unit. What that section
protects, that one action's secret read does not taint another action's
write, is kept by the templates: each written path is labeled from its own
slots. How the wave and a cause's transaction relate is in
`scheduler-and-serving-loop.md` §10.2 and §10.3.

## 2. Cone evaluation

### 2.1 The unit

The unit of value code is the cone: one emitted JavaScript function per
`Cone` record of the plan, named by `Cone.entry` and addressed by
`Cone.code`. A cone computes one or more outputs (`Output.cone`), kept or
interim, and may perform static side-writes (`Cone.writes`).

The compiler partitions the pattern body into cones.
`plan-and-label-templates.md` §1.4 states what this document relies on:

- Every value the instance computes is computed by exactly one cone. A
  value another cone, a `pick` or a collection refers to is an entry of
  `Plan.outputs` whether or not it is kept. An interim output has
  `kept: false` and a path below the name in `Output.interim`. A value that
  only the cone computing it uses has no entry.
- A cone that uses a value another cone computes has a `ConeEdge` from that
  cone with `via` of kind `output`. A cone's value function receives the
  slots in `Cone.slots`, the outputs its incoming edges of that kind name,
  and nothing else.
- The body of an element construct (`map`, `filter`, `flatMap`, a predicate,
  a key function) is one or more cones, each of which names the
  construct's collection in `Cone.within`. Most list slots of root
  `element`, and one that lists none is a cone of the body all the same.
  They are evaluated once per element key (section 2.5).

**The scope a function is evaluated in.** The value code of a compiled
pattern is one emitted module (`plan-and-label-templates.md` §1.5). A
plan can hold code from several source modules: the module of the
pattern, the modules it imports, and the module of each pattern compiled
into it. A name that the expression of a cone or a sandboxed body uses,
and that its source module declares at module scope (a helper function,
a constant, an import), resolves as it does in the source. So the value
function of a cone and the function of a sandboxed body are evaluated in
the scope of the module they are written in, after that module's
statements of module scope, and a body's function is the one `Body.code`
identifies by its module and its binding. Module data is frozen and
functions are stateless (`language-subset.md` §3.3), so one evaluation of
those statements per loaded copy of the value code serves every call.

No other document fixes the text of the module. *Assumed* (question 81),
as the prototype's emitter has it. The value code holds one function per
source module that the plan's code is written in or imports. The body of
that function is the module's own statements of module scope with the
types removed, each import as a read of another module's exports, each
export as a member of an exports object, and the function of every
`pattern(...)` call left out. After those statements it registers each
function the plan needs from the module: the value function of a cone
under `Cone.entry`, and the function of a sandboxed body. A function is
registered in the module it is written in, the functions of a pattern
compiled in from another module included. The functions of one call of a
pattern compiled in are registered inside a function for that call,
which is given the constants of the call's argument, so that they close
over those constants and over the names of the scope a handler written
in place captures.

Provisional (P18; question 102). A pattern that is compiled in has one record in
the plan, whatever the number of its call sites (`plan-and-label-templates.md`
§1.1, "A pattern compiled in is written once"). The value function of each cone
of that record is registered once, and not once per call. It closes over no
constant of a call: a constant that a call writes at a path of the callee's
argument is in the call-site record, and the runtime hands it to the function as
the value of the slot at that path. The value code of a plan is then linear in
the source, for any nesting of calls. A cone instance of such a cone is
evaluated for one chain of call sites, and the runtime binds the slots of the
function for that chain.

### 2.2 Invocation and inputs

The runtime invokes a cone's function with one argument, a host object, and
the function returns a result record. Both are plain data apart from the
host's functions and the stream markers that one of them returns.

```ts
type Index = number;

/** What the runtime hands a cone's value function. */
export interface ConeHost {
  /**
   * The value of one slot of `Cone.slots`, by slot index. The runtime
   * resolves the slot's path, validates what it reads against the slot's
   * schema, and narrows it to the slot's class when the function first
   * asks for it. A slot of class `identity` yields a reference, and a slot
   * of class `shape` or `enumeration` yields only what that class observes
   * (section 2.4). A slot of root `index` yields the position the element
   * has in the order its collection iterates (section 2.5). `below` is a
   * path below the slot's path; for the child slot of a `pick`, at `*`,
   * its first segment is the key the function chose, in the place of `*`
   * (below).
   */
  slot(slot: Index, below?: readonly unknown[]): unknown;
  /**
   * The value of an output another cone computes, by index into
   * `Plan.outputs`, or with `path` what the output holds at that path.
   * Legal only for an output an incoming `ConeEdge` names. The runtime
   * evaluates the producing cone first when it is stale. A cone instance
   * that read a path is stale only when what the output holds there
   * changed (below).
   */
  output(output: Index, path?: readonly unknown[]): unknown;
  /**
   * Runs a sandboxed body of `Cone.bodies`. `computed` is the body's
   * argument with the values this evaluation computed at their places and
   * nothing at the places of slots. The runtime copies from it the paths
   * the entries of `Body.computed` name, each narrowed to its class, and
   * builds the slot part of the argument itself.
   */
  invoke(body: Index, computed: unknown): unknown;
  /**
   * A marker for the stream of one binding of `Plan.bindings`. The
   * function puts it at each position of a value it computes where the
   * source writes the stream, and can do nothing else with it. When the
   * runtime stores the value it writes, in the marker's place, the link
   * to the stream of that binding for the element keys this cone
   * instance is evaluated for (below).
   */
  stream(binding: Index): unknown;
  /**
   * Whether two references name the same thing: the `equals` of the
   * source. Each operand is the reference that a slot of class
   * `identity` or an output yields, and no value. The runtime resolves
   * the links each holds and compares what they name (below). Assumed
   * (section 11, question 90).
   */
  equals(a: unknown, b: unknown): boolean;
}

/** What a cone's value function returns. */
export interface ConeResult {
  /** The value of each output this cone computes, by output index. */
  readonly outputs: Readonly<Record<Index, unknown>>;
  /** The branch taken at each selector the cone evaluated. */
  readonly selections: Readonly<Record<Index, number>>;
  /**
   * The key chosen at each choice point of `Cone.picks` that the value
   * code decides, by index into `Plan.picks`. `undefined` where no child
   * was chosen.
   */
  readonly picks: Readonly<Record<Index, string | undefined>>;
  /** The value of each static side-write, by index into `Cone.writes`. */
  readonly writes: Readonly<Record<Index, unknown>>;
}
```

The child slots of a `pick` over a container slot are bound to the path a
dynamic key chose (`plan-and-label-templates.md` §3.18), and the function
computes that key and has to read the child before it returns. How the
function reads the chosen child is question 46 of that document, and
question 75 here. *Provisional (decision P453 of the prototype):* the
function passes the key it chose to `host.slot` as the first segment of
`below`, and the runtime reads that child alone, at the path and class of
the child slot. `host.slot` of the child slot with no `below` returns
every child of the container, keyed by the child's key. The label is
instantiated at the chosen child alone, and the cone instance is stale
when the chosen child changed (section 3.3), and not when another child
is added, removed or written.

A member read of an output, by a static path or by a key the function
computes, is one call of `host.output` with the whole path, under the
same decision. The cone instance then depends on what the output holds at
that path: an evaluation of the producing cone that leaves what it holds
there as it was leaves the reader current, as a write of another member of
a stored record does.

**Value code places a stream.** A value a cone computes can hold the
stream of a handler, as a rendered tree does at an event attribute. By
ruling the value function places the stream, and the runtime stores the
link where the function put it. No record of the plan names the position
(`plan-and-label-templates.md` §1.1, "Where the stream of a binding is
stored"): which position of a collection holds which element key is
known when the value is computed, and a position below a conditional
holds the stream under one selection only.

- **The marker.** `host.stream` returns a marker for the binding. The
  function places the marker in the value it returns, at each position
  where the source writes the stream. It can do nothing else with it:
  the marker has no member to send an event with and none to read
  through. So the rule that a cone's function holds no handle stands
  ("Side-writes are returned, not performed", below). A marker in an
  interim output stays a marker, because an interim output is not
  stored, and a cone that pulls that output can pass it on in turn.
- **The replacement.** When the runtime stores a value, it writes, in
  the place of each marker, the link to the stream of the marker's
  binding. For a binding whose `within` has `element` steps, the stream
  is the one of the keys that the cone instance that called
  `host.stream` has at those steps (section 5.2). For a binding with no
  `element` step, the stream is the binding's one stream, whichever cone
  instance called.
- **One rule for every place.** By ruling the replacement is the whole
  rule, wherever the marker is: at a position of the instance's result,
  in the value of a side-write, and at a path of a child's argument that
  a cone computes. The runtime checks no position, and no evaluation
  fails for where a stream is. A marker can be placed by one cone
  instance, passed through an interim output, and stored by another, as
  where a declaration cone computes a tree and the `result` cone stores
  it. The link is then to the stream of the keys of the cone instance
  that called `host.stream`, whichever cone instance stores the value.
  The label of what is stored is by the rule of the write: the template
  of the output for a position of the result, and the rule of the
  side-write or of the child's argument otherwise
  (`plan-and-label-templates.md` §1.1, "The label of a position that
  holds a stream", §3.11 and §3.15).
- **A reader of the plan.** A reader that has the plan alone cannot say
  where a stream is stored. It reads the stored result, in which each
  position that holds a stream holds a link to it.
- **A stream that is an input of the pattern** is no binding of the plan
  and has no marker. The function receives it as the reference of an
  `identity` slot and passes it on as any input, and the runtime stores
  the link by the rule for a value passed on unchanged (section 2.4).
- **A stream that a function body returns** is no marker either. A
  sandboxed body that returns a value with the stream of a binding it
  made, or of one it was handed, returns a reference, and the runtime
  stores the link as for any reference a body returns (section 2.4). By
  ruling reads through the stream are dynamic, as through any reference
  a body returns (`plan-and-label-templates.md` §1.1).
- **A marker handed to a sandboxed body.** *Assumed* (question 78 of
  section 11): where the `computed` argument of `host.invoke` holds a
  marker at a path that an `identity` entry of `Body.computed` names,
  the runtime hands the body the reference to the stream, as it hands it
  any reference at such a path (section 2.4). The prototype's compiler
  records no such entry for a stream bound to a formal of a body, and
  its executor hands the body a handle to the stream wherever a marker
  is in the computed argument (`plan-and-label-templates.md` §8,
  question 124).

The rule is the same for a cone of an element body in the three cases of
a per-element source: an array of references, an array of plain values
in place, and the result of another per-element construct. The marker is
replaced by the link to the stream of the instance's key in each, and
the three differ only in how the key is computed (section 2.5). In the
result of a `flatMap` each stored position holds the link that value
code placed in the member, over a source of any of the three cases.

**What is undecided for a pattern closure used as a value: what value
code writes.** `ConeHost` has no member that makes a factory value, so a
cone's value function has no way to place an inline pattern that the
source uses as a value, with its captures, in the value it returns. The
prototype translates no such closure: it is left out of the value, and a
closure that a language-model built-in is given as a tool is not in the
request. *Assumed,* provisional (P35 of the continuation plan; section
11.1, question 113): `ConeHost` gets a member

```ts
// Shown for illustration only.
type Index = number;

interface ClosureHost {
  /**
   * A marker for the factory value of one entry of `Plan.closures`.
   * `computed` holds the captured values this evaluation computed, at
   * their paths below the private parameters, and nothing at the paths
   * of captures that are slots.
   */
  closure(closure: Index, computed: unknown): unknown;
}
```

which the function calls where the source writes the closure. It returns
a marker, as `stream` does, and the function places the marker and can
do nothing else with it. When the runtime stores the value, it writes
the factory value in the marker's place (section 4.6, "A pattern closure
used as a value"): it copies from `computed` the paths that
`Closure.params` lists as copied, each narrowed to what the inline
pattern's plan observes, and builds the paths of slots and the links to
captured cells itself, from the bindings of the cone instance that called
`closure`, as it builds the slot part of the argument of `invoke`. A
marker in an interim output stays a marker. A closure that is called in
the body that wrote it is compiled in and has no marker. Under a
conditional between two closures the function makes the marker of the
branch it takes and reports the selection
(`plan-and-label-templates.md` §3.15, "What is undecided for a pattern
closure used as a value").

The prototype's executor implements the marker and the replacement. Its
marker is a frozen object with no member, and the binding and the keys
it stands for are held where value code does not reach them. It replaces
a marker stored in a state cell or a created cell as well, and no test
of it stores one there. It stores the children of a view node as value
code gives them, so a collection among them is one nested array. Its
compiler also emits a list of result paths for each binding, and the
executor fails an evaluation that stores a marker at a position that the
list does not cover; this design has neither. In its corpus run 2 stored
positions hold a stream that is an input of the pattern, and 3 hold the
stream of a binding that a function body makes and returns.

**Value code compares two references through the host.** `equals(a, b)`
in the reactive tier compares what its operands name once the links
they hold are resolved, and its slots are `identity` slots that are
resolved (`plan-and-label-templates.md` §3.16). A value function holds
each operand as the reference its slot yields, which it cannot read
through, so it cannot make the comparison itself. A comparison of the
operands' values would find two equal plain values to be one element.
*Assumed* (section 11, question 90): the function calls `host.equals`
with the two references. The runtime resolves the links each holds,
and where resolution ends at a reference by key it compares the
collection, the key and the path, and resolves no key to a position
(its §1.3). The cone instance depends on the links the resolution
crossed, and is stale when one of them changes. It does not depend on
the position a key stands at. One comparison does resolve a key. By
ruling a handle by position, as `items.key(i)` yields, is equal to a
reference by key to the element that stands at position `i`: the
runtime resolves both to the current position and compares there.
That needs a read of the collection's array, so the cone instance
depends on the array's membership as well, and the result is of the
moment of the comparison. What it gives where the parent cannot be
read is open (its §8, question 121). The call is the same in an element body
over an array of references, where an element resolves to its cell;
over an array of plain values in place, where an element is a
reference by key; and over the result of another per-element
construct, where the element is what the upstream element is. The
prototype's emitter writes the call so, 18 times over its corpus.

**The callee's default for a sandboxed body.** By ruling a path of the
argument of a pattern compiled in that the call binds to a slot at
which nothing is stored reads the callee's default
(`plan-and-label-templates.md` §1.1). Expression code reads the slot
with `host.slot` and takes the default, a constant of the value code,
where the slot yields nothing. A sandboxed body of the callee finds the
slot in the argument that the runtime builds from `Body.reads`. By
ruling the entry holds the callee's default (`ReadInput.default`), and
the value code passes `host.invoke` nothing for it, so the interface
above needs no member for defaults. The runtime puts the default at the
entry's place `at` where the slot reads nothing and no place the slot
resolves through declares a default of its own. "Nothing" is an absent
value: a stored `null` is a value, and no default takes its place. The
rule is the same for a body used in an element body, over an array of
references, over an array of plain values in place, and over the
result of another per-element construct. For a handler of the callee
the default is assumed to be held by the binding
(`plan-and-label-templates.md` §8, question 110), and the runtime
applies it when it resolves the state path at dispatch. The prototype's
executor passes `host.invoke` a list of places with their defaults in
place of the member.

**An output with entries below it.** A constructed value, such as a
rendered tree, has an entry of `Plan.outputs` for its container and one
for each member that is not constant (`plan-and-label-templates.md`
§3.4), and `ConeResult.outputs` is by output index. *Assumed* (question
82): the function returns the whole constructed value once, under the
entry at the root of the construction, with the constant members in
place. It returns nothing under the entries below that one, which are
paths of the value returned. The object a pattern returns has no
container entry where its key set is static, and a constant path of it,
such as `[NAME]: "Counter"`, has no entry at all. The `result` cone
computes the paths of the result that no other cone computes (its §1.4).
*Assumed,* under the same question: the value function of the `result`
cone returns the whole returned record, with the constant paths in place
and the outputs of other cones read through `host.output`, and the
runtime stores from it the kept paths that no entry of another cone
covers. `ConeResult.outputs` has no index for that record. The
interface above stays as it is until the question is decided.

**A collection that a cone places.** Provisional (P22 of the continuation
plan; section 11, question 104). A cone that places the assembled result
of a `map`, a `filter` or a `flatMap` at a path of the value it
constructs, and observes nothing of the collection, holds a reference to
the collection at that path and not the rows. `host.output` of the
assembled entry (`plan-and-label-templates.md` §1.4) gives the value
function a **collection reference**: a value of the runtime that names
the entry of `Plan.outputs` and the cone instance context it was pulled
in, which is the keys of the enclosing collections, the chain of call
sites and the scope key. It is one value whatever the rows hold and
however many there are. The rows are stored by the collection. This is
the same for a collection over an array of references, over an array of
plain values in place, and over the result of another per-element
construct. Over a plain array generated from scratch it is *assumed*
the same, and the prototype did not build that case.

- **Placing and observing.** A cone places the collection when it writes
  the reference as a child of a node, as a member of a record or an
  entry of an array literal that it returns, as its whole value, or as
  the chosen branch of a `select`. It observes the collection when its
  value code asks anything of it: an entry, the length, an iteration, a
  spread, a method, `equals`, or a call of a function body with the
  collection in its argument. The runtime gives the assembled array at
  the first such request, as it supplies a slot when the slot is first
  read, and the cone instance then depends on the assembly as on any
  upstream output (section 3.3). A reference is placed by expression
  code of the reactive tier alone, since handing it to a function body
  is observing. So the plan shows every kept path at which a collection
  can stand: the paths of the per-element entries, with `*` at the
  position of the collection.
- **What makes the placing cone stale.** Its memo entry records the pull
  under `upstream` with a fingerprint of the reference: the entry and
  the context. A change of a row, an append, an insertion, a removal
  and a reorder change no such fingerprint. So the placing cone instance
  is not stale, and neither is a cone that pulls its output and places
  it in turn, nor the `result` cone. One change of one row evaluates the
  element cone instances of the row and brings the assembly up to date,
  and evaluates no enclosing cone.
- **What is stored, and by whom.** The store step stores the collection
  at each kept path where a reference to it stands in a value that is
  stored: the row of each key whose cone instances returned another
  value, and a `splice` of the stored array for the keys that left or
  entered, in the layout of section 4.10. The value of the placing cone
  is not written for it, since that value did not change. *Assumed:*
  where one collection is placed at two kept paths, its rows are stored
  at both, and a change of one row writes both.
- **Reading through the place.** A cone or a body that reads a path
  through the output of the placing cone and reaches the reference
  reads on into the collection: it depends on the assembled entry, or
  through a `pick` on the row it chose, and not on the placing cone for
  what is below the reference. A slot of a handler whose path passes
  the place reads the stored rows by address. Before the body runs, the
  stale element cone instances and the assembly are evaluated as
  section 1.3 has it, and the placing cone is not evaluated on their
  account.
- **Labels.** No label differs. A kept path below the collection has the
  template of the per-element entry, and the path of the collection the
  membership template (`plan-and-label-templates.md` §1.4 and §2.3).
  Placing consumes nothing of what is placed (its §5.3), so the template
  of the placing cone's own paths never held the content of the rows.
  The instantiation key of a row's kept paths changes where that row's
  labels change and for no other row.
- **Demand.** Demand is held per kept output path
  (`scheduler-and-serving-loop.md` §4.2). A demanded path below the
  collection demands the element cones of its key and the collection's
  membership; a demanded path of the container demands the placing
  cone. A reader of one row therefore causes neither the placing cone
  nor another row's cones to be evaluated.
- **The keep set** holds the same paths as it does where the cone
  returns the rows: the container's paths from the placing cone, and
  the rows' paths from the per-element entries.
- **A client that renders one row** reads the kept paths of the row,
  loads the documents on the path, which are the chunk or the part of
  the row (section 4.10), and demands the cones of that key. A change of
  another row reaches it only where both rows are stored in one chunk,
  as a write that leaves its paths unchanged.
- **An errored row** is the error state of that row at its position, as
  for any failed value that is placed
  (`plan-and-label-templates.md` §5.3).

The alternative is that the cone returns the whole value: the first
assumption of this section's question 82 read for a collection as well,
with `plan-and-label-templates.md` §1.4 ("The enclosing cone uses the
assembled result") and the paragraph "Upstream" of section 3.3. Then a
change of one row makes every enclosing cone and the `result` cone
stale, each returns a value of every row, and the store step compares
or writes the result whole. The prototype measured both on a `map` in
the result: 3 evaluations for one change of one row and 5 for a `map`
over the result of a `filter`, with 238,904 bytes put into the
documents for a list of 10,000, against 2 and 4 evaluations and 2 to 26
bytes with the reference, at every length.

Six rules hold for an invocation.

- **Slots are materialized by the runtime, when they are first read.** A
  cone's function never reads storage. It receives the slots in
  `Cone.slots` and nothing else from storage, which is the cone narrowing
  of `plan-and-label-templates.md` §7.3. A slot the function does not ask
  for is not resolved, not validated and not recorded as read. A slot that
  only an unselected branch reads therefore makes no cone instance stale,
  creates no demand on its producer, and cannot fail the cone when it does
  not resolve or does not match its schema
  (`plan-and-label-templates.md` §5.3).
- **A slot's path is resolved through links.** Where the value at a segment
  is a stored link, resolution continues at the link's target, and the
  links crossed are the slot's chain (`plan-and-label-templates.md` §2.5).
  A storage link, to a part document or to a narrower scope instance, is
  passed through and is not on the chain (sections 4.2 and 4.10). An
  `identity` slot stops at its last segment, and
  with `resolved` it yields the reference where resolution ends. Emitted
  code does not follow a link.
- **Where nothing is stored, a slot reads as the default of the place.**
  The runtime validates what it read against the slot's schema, with one
  member taken from the chain: the default of the link nearest the bound
  address whose schema declares one, and the slot's own default where no
  link declares one (section 4.4;
  `plan-and-label-templates.md` §2.5, "A default belongs to the place").
  A path that resolves to a slot of the instance without a stored link,
  as a path of a binding of the reactive tier does, takes the default of
  that slot's schema in the same way. Two cases are by ruling. A slot
  of root `state` whose cell holds nothing reads the default of the
  cell's schema, which is the first value of the cell where the
  declaration gives it a constant (section 4.1). And for a pattern
  compiled into another, a path of the callee's argument that the call
  leaves out is a constant, the callee's declared default, and a path
  that the call binds to a slot at which nothing is stored reads the
  callee's default too. By ruling the default read is the one declared
  nearest the end of the chain of places the read resolves through, and
  the reader's own, a callee's included, only where no place declares
  one: where the place of that slot declares a default of its own, that
  one is read (`plan-and-label-templates.md` §1.1 and §2.5). Two things
  are assumed there (its §8, questions 103 and 104): the order holds at
  every path of a read of an object whole, and a stored `undefined`
  reads as absent does, with no default written into an argument
  document when an instance is set up. A read of a default carries no
  integrity: where a slot reads as a default, the runtime gives it the
  empty integrity when it instantiates the label, and the
  confidentiality the read consumed. Integrity is anchored in a stored
  object as a whole: a slot that reads a stored object whole keeps the
  integrity of the observation at the object's address, also where a
  default fills one of its properties, and a slot that selects a
  defaulted property has the empty integrity
  (`plan-and-label-templates.md` §2.5). Where there is no default, the slot
  reads as `undefined` if its schema admits that, and the cone fails otherwise
  (`plan-and-label-templates.md` §5.2).
- **Other cones' outputs are pulled.** A cone asks for an upstream output
  when its code reaches the use, so an output used only in the unselected
  branch of a conditional is not evaluated. This is how demand stops at a
  `select`.
- **Selections are reported, not inferred.** The function returns the branch
  it took at each selector and the key chosen at each choice point. Every
  `pick` node has a choice point of its own, an index into `Plan.picks`,
  as a `select` has a selector, so a `pick` whose `from` is an output and
  two picks over one container each have a place in `picks`
  (`plan-and-label-templates.md` §1.1 and §3.18). The runtime needs both
  for the instantiation key (§4.1 there), and the chosen keys also for
  the memo (section 3.3). Three things are not reported, because the
  runtime supplies them from its own scan (section 2.5; §4.2 there): the
  selection of a selector that a `fold` names with `through`, the
  position that bounds a prefix fold, and the key at a choice point the
  runtime decides (`Pick.chosenBy`).
- **Side-writes are returned, not performed.** The function returns the
  value of each static side-write. The runtime stages the write to the
  target the `WriteEdge` names. A cone's function holds no handle. The
  marker that `host.stream` returns is no handle: the function can
  place it in a value and nothing else.
- **Collection operations are the runtime's.** A cone does not iterate a
  reactive collection. Section 2.5 says what the runtime does.

### 2.3 Order

The order of evaluation within an instance is fixed by the plan and the
value code, so the runtime neither discovers read sets nor sorts.

- The runtime starts from the demanded outputs whose cone instances are
  stale, in the order of `Plan.outputs`.
- Evaluating a cone runs its function. Each `host.output` call evaluates the
  producing cone first when that cone instance is stale, depth first.
- A slot bound to a cell that another cone writes statically is treated like
  an upstream output: the writing cone is evaluated first when it is stale.
  The plan lists the edge, a `ConeEdge` with `via` of kind `state` for a
  state cell and of kind `handle` for a cell reached through a handle
  (`plan-and-label-templates.md` §3.11). Two places of a plan can link to
  one cell without the plan showing it. That overlap is found at run time
  from the bound addresses, and is handled as section 2.7 handles a
  side-write to a cell already read.
- A cone instance is evaluated once for one state of what it reads. It is
  evaluated again in the same transaction only when a write staged in that
  transaction changed something it had read (section 2.7).

**A cone with side-writes.** By ruling a cone with side-writes is of one
of two kinds.

- **A small, fixed set of targets that the compiler names.** The cone is
  an ordinary node, and the targets of its write edges count as its
  outputs for demand. A cone instance is demanded when one of its kept
  outputs is, or when something demanded reads the target of one of its
  write edges, or passes that target on by reference
  (`scheduler-and-serving-loop.md`, "Terms" and §4.3). It is evaluated
  before the reader is, and before a path that passes the target on is
  stored.
- **A write set that is dynamic or very large.** The cone's body is a
  materializer. It is evaluated eagerly whenever one of its inputs
  changes, as a rule after the rest of the wave has been evaluated, and
  its writes make their readers stale, which a further wave evaluates
  (section 6.7; `scheduler-and-serving-loop.md` §7).

The first kind covers a cone whose only effect is a side-write. A
pattern can pass a state cell on by reference at a path of its result
while a cone of the pattern side-writes that cell and has no kept
output. In `patterns/dev/test/non-idempotent/accumulator.tsx` a
`computed` pushes onto a state cell, and the result holds the cell. The
`identity` slot at the root of the cell makes no edge
(`plan-and-label-templates.md` §3.11), so no edge leads from the writing
cone to the `result` cone, and a reader that demands the result path is
handed a link and has not read the cell. The demand on that path is a
demand on the write edges to the cell all the same: the runtime finds
them from the address the `identity` slot is bound to, and the writing
cone is evaluated before the path is stored. The prototype's executor
has no reader and evaluates every cone of the pattern's own body that
has a side-write before it stores the result.

*Assumed* (question 80): the compiler decides the kind from the
footprint, as `footprint-analysis.md` §6.3 has it. A body is of the
first kind where every write target is a statically named slot, and a
materializer where a target is reached through data: a `*`, a computed
path, or a handle read from a value. No number is set for "very large",
so no count of static targets makes a body a materializer.

The kind is no member of the cone's record. A cone of the first kind
has the edges in its `writes`, and a body of the second kind is the
implementation of an `Operation` of kind `materializer` and is in no
cone (`plan-and-label-templates.md` §3.11).

Three things follow for the first kind.

- **The writer stays demanded.** A reader that passes the cell on reads
  nothing of it, so no change of what the writing cone reads makes the
  reader stale. The demand the reader places on the write edges stands
  for as long as its own path is demanded. When an input of the writing
  cone changes, that cone instance is stale and demanded, and the
  derivation transaction evaluates it, although no reader is evaluated.
- **A cone with side-writes that nothing demands is not evaluated.**
  Where none of its kept outputs is demanded, and nothing demanded
  reads or passes on a target of its edges, its writes are not made.
  The owner's words with the ruling are that the scheduler of today
  often evaluates such nodes eagerly. Where it does, this is a
  difference from today that the ruling makes. The prototype has a
  fixture for the case and does not compare it with today's runtime.
- **A cone of an element body that writes a cell outside the body** has
  an instance per element key, and each instance has the write edge. A
  demanded reader of the cell demands the edge of every key's
  instance, because each of them can write the cell. This is the same
  over an array of references, over an array of plain values in place,
  and over the result of another per-element construct.

Because the value code is the same on the server and on a client, and the
order depends only on the plan, the demanded outputs and the values, two
runtimes that start from the same state evaluate the same cone instances in
the same order.

`Plan.cones` is listed so that an edge that is not on a cycle goes from a
lower index to a higher one, and `Plan.outputs` is listed by cone in that
order (`plan-and-label-templates.md` §1.4). The runtime does not depend on
this for correctness, since it pulls. It uses it to recognize a back edge
(section 2.7).

### 2.4 Sandboxed bodies

`host.invoke` is where emitted code and sandboxed code join. For one call the
runtime:

1. builds the argument: the slot part from `Body.reads`, and the computed
   part from the value the cone passed, narrowed to the entries of
   `Body.computed`;
2. hands the body its handles, and brackets the call, so that every read
   made through a handle of `Body.handles` is journaled with its address;
3. calls the body in the sandbox, under its time and memory budget;
4. validates the result against the body's result schema, and checks each
   result path that `Body.outputs` declares as a passed or chosen reference
   by identity (`plan-and-label-templates.md` §3.9);
5. performs the requests the body made, when the body is one that may make
   them (section 2.8);
6. returns the result to the cone's function, or fails the cone when the
   body threw, exceeded its budget, or returned a value outside its schema.

**Where a slot of `reads` sits in the argument.** By ruling each entry
of `Body.reads` holds the path in the body's argument at which the
slot's value is placed, its member `at`
(`plan-and-label-templates.md` §1.1, `ReadInput`), and the runtime
builds the slot part from the entries. For a handler, a slot of root
`event` is placed below the first parameter and a slot of root `binding`
below the second, at the slot's path. For another body the root and the
path of a slot are those of what the caller passed, and the place is the
entry's `at` alone.

Two entries of `reads` can hold one slot at two places, where two
inputs of the use are bound to one place, and the runtime puts the
slot's value at both. An entry whose `at` holds `*` is placed at each
child the path reaches, with what the table below gives its class. The
container that holds the children is in the argument by the
`enumeration` entry at the container's own place, which a footprint
with an entry below `*` always has (`plan-and-label-templates.md`
§2.5). By the row for `enumeration`, a member of that container is
`undefined` unless such an entry materializes it.

**What the argument holds at a path.** The runtime builds the argument entry
by entry. What it puts at an entry's path depends on the entry's class, so
that the body is handed that observation and no more.

| Class of the entry | What the argument holds at the path |
| --- | --- |
| `value` | The stored value, recursively, validated against the entry's schema. A container in it that was read from a stored address carries that address, invisibly to the body, as a value read from a cell does today (`annotateWithBackToCellSymbols` in `runtime/runner/src/schema.ts`) |
| `shape` | A stand-in of the stored kind: an empty object for a record, an empty array for an array, and for a scalar the fixed value of its kind (`""`, `0`, `false`, `0n`, `null`). An absent path is absent |
| `shape` with `inPlace` | Whether the position itself holds anything, without continuing through a link stored there. Where it holds a link, the argument holds the handle or the reference stand-in of the `identity` rows below, which carries the presence. Where it holds a plain value, the stand-in of the row above. An empty position is absent |
| `enumeration` | A container with the stored keys in the stored order, or the stored length. Each member is `undefined` unless another entry materializes it |
| `identity` at a position of handle type | A cell handle, bounded as below |
| `identity` at a position of data type | A reference stand-in: a frozen object with no members that carries the address. The body can pass it on and compare it, and cannot read through it. Converted to a string, it yields a string that is a function of the address alone |
| `identity` with `resolved` | The same, for the reference where resolution ends |
| `labelMetadata` | Nothing on its account. The observation is made by the call that reads the label |
| No entry | The path is absent from the argument |

A `value` entry at a path where nothing is stored holds the default of
the place, by the rule of section 2.2. An `identity` entry at a position
of handle type holds a handle whether or not anything is stored at the
position: where the position holds no link, the handle names the position
itself, which for an optional property of a pattern's input that the
caller left out is that path of the instance's argument document
(`plan-and-label-templates.md` §2.5, "A handle to a position that holds
nothing"). A read through the handle gives the default of the place where
it has one, and a write through it stores a value at that path.

A write below such a position has to start from something, as a write
below the root of a state cell that holds nothing does (section 4.1).
By ruling the same holds for a place that holds nothing and is no
state cell, such as a path of the argument whose schema declares a
default array and onto which a handler pushes: the array starts from
the default, and the push is applied. The write starts from the
default that a read of the place gives, by the rule of section 2.2,
and stores the result at the path. *Assumed* with it, as for a state
cell: the members taken from the default keep the label of
a default. The runtime of today reaches the same value by another
route. It has written the callee's default into the argument document
at setup (`#applySetupState` in `runtime/runner/src/runner.ts`), which
this design is assumed not to do (`plan-and-label-templates.md` §8,
question 104). The prototype's executor starts from the empty array,
by a reading of its code that no test covers.

Where two entries name one path, the argument holds the form that carries
more: `value` before `enumeration`, `enumeration` before `shape`, and a
reference stand-in where the only entries are `identity` and `shape`, since
a stand-in that is present carries the presence. A position typed `unknown`
holds a reference stand-in whatever is stored behind it, so a test of
presence or kind sees presence and no more. These are the stand-ins
`footprint-analysis.md` asks for (its requests 8 and 17).

An `identity` entry at a position of handle type comes before every
entry at or below that position. The argument holds the handle, and an
entry of another class at or below the position is not put into the
argument: it is what a read through the handle returns ("Handles",
below). A handler that calls `count.get()` and `count.set(...)` has a
`value` slot and an `identity` slot at the path `count` of its state,
and is handed the handle.

**Which positions are of handle type.** The rows for `identity` differ
by the type of the position. For an entry of `reads` that type is
`Slot.schema` of the entry's slot, which is the type the body declares
for the formal input at the path: the parameter type of an authored
function or a `lift`, the event type and the state type of a handler,
and for a capture of a `computed` the type the checker gives the
expression (`plan-and-label-templates.md` §1.5, "The schema of a
slot"). It is not the type of the place the slot is bound to. For a
body of a pattern compiled in the two can differ: where the caller
declares a plain array and a body of the callee declares a handle and
calls `items.get()`, the body is handed a handle. A state path that a
handler declares with a data type, as `stop: Stop`, holds a reference
stand-in or, where the body has entries below the path, the form that
carries more with the reference's address, by the rule for two entries
at one path. Where the path is bound to an element that is a plain
value in place, by ruling that form carries the reference by key, and
a member read from it carries the reference with the member's path
(`plan-and-label-templates.md` §1.3, "What a function body holds").
An entry of `computed` has no slot and so no schema.
*Assumed* (section 11, question 91): the runtime takes the type of
such a position from the type the body declares at the entry's `at`.
No record of the plan holds that type.

**An entry below a path that yields nothing.** Where a path of the
argument is bound to a place that yields nothing, the argument holds
nothing at the path, also where the body has a further entry at a
member below it. The runtime makes no record at the path in order to
place the member: an entry below an absent path is absent, as a read
of the member through the absent value is. A handler whose state path
is bound to a value that is `undefined`, and whose body reads a member
of it behind a test such as `if (!card) return;`, then sees the path
absent and returns. The same holds for a body used in an element body
in each of the three cases of a per-element source.

**A captured name with no entry.** A `computed`, or another function
written in place, is called with a binding for every name of the reactive
tier that its code captures. A name the code mentions and reads nothing
of, as `flag` in `computed(() => { void flag; ... })`, has no entry of
`reads` and none of `computed`. It is bound all the same, and holds
`undefined`, because the path is absent from the argument by the last
row of the table.

**A value passed on unchanged is stored as a reference.** When a body
returns or writes a container that carries the address it was read from, or
a reference stand-in, the runtime stores a link to that address and not a
copy (`footprint-analysis.md` §3.8). *Assumed*, pending question 10 of the
continuation plan: the rule stands, as today. The values the prototype's
executor computed for the corpus need the rule: a later
`items.remove(item)`, with `item` an element of a `map` over
`items.get().filter(...)`, finds the record only where the elements of
the filtered list are references to the records of `items`.

What the reference is depends on what was read. A container read from
a cell, or below a link, carries that address. By ruling an element
that is a plain value in place of an array carries a reference by key:
the collection, the element's key, and the path below the element
(`plan-and-label-templates.md` §1.3). The runtime stores that
reference where a cone of the reactive tier passes the element or a
member of it on, and where a body passes on a handle that it was
given for the element, and no copy and no link to the position. The
reference resolves to
the position that holds the key at each read and each write, so it
stays right when the element moves, and it reads as nothing once no
position holds the key. By ruling such a reference does not reach a
function body through a read: a function body that reads a plain
value in place through `get()` or `sample()` on a handle holds a
copy, and writing it elsewhere stores the value, as today. A position of
its argument that a body declares as data is ruled the other way. At the
state path `stop: Stop` of a handler bound in an element body, the
handler is given a stand-in that carries the reference by key, a member
read from it, as `stop.position`, carries the reference with the
member's path, and `center.set(stop.position)` stores a reference by key
(`plan-and-label-templates.md` §1.3, "What a function body holds"). The
binding copies nothing under either answer: a binding made in an element
body is a binding of the reactive tier, whose state path resolves to the
element's slot, so the stream is the same stream when the element's data
changes. By ruling as well, the handle of a member that a body reads
through a handle of handles, as `Writable<Writable<Item>[]>`, is a
reference by key where the member is a plain value in place. The
prototype's executor does both, and by the prototype's measurement the
runtime of today stores a link to the position where such a handler
stores a member of the element. A value that a body read through `get()`
or `sample()` carries no address for the rule of this paragraph. So a
body that exchanges members between two arrays of plain values in place
and sets both stores the values in both. A handle by position, as
`items.key(i)` yields, is stored as a link to the position and is
never rewritten to a reference to the element, by ruling, in each of
the three cases of a per-element source. Two writes do not follow the
rule of this paragraph: that of a plain value in place that a
function body read, and the edge of a first value of a state cell,
which always stores a value (section 4.1).

The rule does not decide a write whose value holds a reference into what
the write replaces. `items.set(items.get().toSpliced(i, 1))` writes to
the cell of `items` a list whose members carry the addresses they were
read from. For a member stored in place that is a reference to an
element of the list the write replaces, and a reference to it would
name what the write itself overwrites. *Assumed* (question 84): where
a member of a written value carries a reference at or below the path
the write replaces, by key or by position, and the element it names
is held there in place, the runtime stores the value there and no
reference. A member that carries the address of
a cell a link led to is stored as a link, by the rule above.

**Handles.** The runtime hands a body a cell handle for every position of
handle type that its record names: an `identity` slot of `reads`, an
`identity` entry of `computed`, the handle of a write target or of a write
envelope, and every entry of `handles` (`plan-and-label-templates.md` §3.9).
For a slot with `resolved` the handle is the resolved reference.

- A read through a handle at a path that slots of `reads` cover returns the
  value the runtime materialized for those slots. It is not journaled.
- A handle listed in `handles` reads through the transaction. Its `get()`
  and `sample()` read under the entry's `envelope` schema and return the
  value narrowed to it, and each read is journaled. Before such a read
  returns, a stale cone instance of a loaded instance that writes the
  address is evaluated, as section 1.4 says for a handler. For a body
  that runs inside a cone, a read that lands inside the envelope of an
  invalid materializer is not waited for: the body reads what is stored,
  and the materializer's later write makes the cone instance stale
  (`scheduler-and-serving-loop.md` §7.3).
- A read of a body inside a cone whose writer is in an instance that is
  not loaded is not waited for either, in a derivation transaction. The
  read returns what is stored, with the label stored there, and the
  address is registered for the `dynamic` node. Where the basis rows show
  the stored value current, nothing more is evaluated. Where they show it
  stale, the scheduler loads the instance and evaluates the stale cone
  instance that writes the address, in the same transaction where the
  load needs no wait and otherwise in the derivation transaction of the
  change of demand that the load is. Its write makes the reading cone
  instance stale through the registered address, which is recorded as a
  trigger read, and the reading cone instance is evaluated again, under
  the bound of section 2.7 (`scheduler-and-serving-loop.md` §4.4). The
  transaction is not withdrawn: a body inside a cone may be evaluated any
  number of times, so it can be handed the stored value and evaluated
  again. Until that evaluation, a kept output computed from the stale
  value can be stored, under a label that joins the label stored at the
  address read. A cone instance evaluated in an event's transaction,
  before the body or at a read of the body, follows the handler's rule of
  section 1.4 instead, because the body that waits for its value runs
  once.
- A handle the body finds by a read through a listed handle reaches it by
  that read, where the listed entry's envelope admits the position as a
  handle. Reads through it are journaled with the reads of the entry it was
  found through, narrowed to what that envelope admits below the position.
- The link to an instance that an earlier evaluation of the same `lift` or
  `computed` made is a handle of this kind. Its entry of `handles` names
  the `instantiate` site, and a read through it is journaled and made
  current like any other (section 2.8).
- A handle that is in none of these groups cannot be read through. It can
  be passed on, compared, and written through where a write target names
  it.
- A write through a handle is refused unless a `WriteEdge` or a
  `WriteEnvelope` of the body covers it. A target with `resolved` is
  resolved when the write is made, as section 1.4 says.
- A write through a handle bound to a path that holds a value the instance
  produced, and no reference, is refused, by ruling
  (`plan-and-label-templates.md` §3.11, "A write through a handle to a value the
  instance computes"). The runtime decides it when the write is made, by whether
  the bound path holds a reference. In a handler the refusal rejects the event's
  transaction, and a cone whose write is refused fails. Where the path holds a
  reference, the write lands in the cell the reference links to, as the next
  paragraph says. A path of a child's argument that a function body gave when it
  instantiated the child is written freely by the child
  (`plan-and-label-templates.md` §3.15).
- A position of handle type can be bound to a constant: a state path of a
  binding whose `place` is a constant, or a path of the argument of a
  pattern compiled in at which the call writes a literal, as `step={5}`
  does for a callee that declares `step: Writable<number>`. A constant
  has no position. The body is handed a handle that reads the constant,
  and a write through it is refused by the ruling above, because a
  literal is a value the instance produces and no reference.

**What a handle names, and where its reads and writes go.** *Provisional
(decision P471 of the prototype):*

- A handle for an input names the cell the instance was given. The
  input's position in the argument holds a link to that cell, the
  binding, and the handle is past it. A link that any other position
  holds is part of what the cell holds, and the handle names the
  position that holds it. This holds for a handler's state and for value
  code alike.
- `get()` and `sample()` follow the write redirects at the handle's
  position, then the one link the position holds, if it holds one, then
  the write redirects after it, and give the value at the position
  reached. That value carries the position: a write of it elsewhere
  stores a link to it. Each read of a cell of cells gives one level. A
  plain value in place reached this way is a copy with no address, by
  the ruling of section 2.5.
- `resolveAsCell()` follows every link and gives a handle to the position
  where they end. It reads the positions that hold the links and no
  member of that position.
- `set(v)` writes at the handle's position past its write redirects, and
  replaces what the position holds, a plain link included; a write
  redirect written replaces what the position holds. A write at a path
  below the handle, through `key`, `update` or `push`, follows the links
  on that path. A write of a member bound both ways from the rendered
  tree passes the link that binds the attribute to its cell, as a
  binding.
- A handle stored elsewhere is stored as a link to the position it names.

So a handler given a state cell that holds a link to an item can store
the item it holds now, with `kept.set({ current: selected.get() })` or
`resolveAsCell()`, and point the cell at another item with
`selected.set(other)`, which leaves the first item as it was. A write of
a plain value replaces the link: `selected.set({ ...selected.get(), title })`
leaves the item as it was, where `selected.key("title").set(title)` and
`selected.update({ title })` write it.

The runtime of today makes the cell of every handle one link past its
position, after the write redirects (`validateAndTransform` in
`runtime/runner/src/schema.ts`), and not past a binding alone. A handler
given such a state cell is then given the item: `selected.set(other)`
writes a link to `other` into the first item, and a plain value written to
the cell lands in the item. Its `get()` gives a value that carries the
handle's own position past its write redirects (`toCell` in
`runtime/runner/src/back-to-cell.ts`), so for an input bound to a
position that holds a link, a value read and stored elsewhere names that
position and not the item. Its `resolveAsCell()` of an element in place
gives a snapshot of the element, whose value a write stores.

The crate emits a read that value code returns, as `computed(() => x.get())`
or a member `current: x.get()` of a record it returns, as the input
itself, and the result then holds a link to the input's position in the
argument. The value is the same, and value code is evaluated again when
what the position leads to changes, so where the link points matters to
no reader of the value.

**A handle or a reference from a computed input.** A handle or a container
can reach a body in a value the instance computed, such as one another
body returned or one a `pick` chose. It has no slot, and the body's record
names it by its `identity` entry of `Body.computed`: a `GivenReference`
with `computed`, the `computed` variant of a `handle` target or envelope,
and an entry of `handles` (`plan-and-label-templates.md` §3.9 and §3.11).
The runtime takes the reference from the computed value it was passed, at
the entry's path, and hands the body what the table above gives an
`identity` entry: a cell handle at a position of handle type, and a
reference stand-in at a position of data type. That reference is the one
the runtime compares with, by identity, where the record says the body
passes it on. A write through such a handle lands in the cell the
reference links to, at the target's path, and with `resolved` at the
address where the resolution of that reference ends. The runtime resolves
the target when the write is made, and a resolution is journaled. The plan
has no edge from such a write to the cones that read the cell, so the
cone instances it makes stale are found from the bound addresses, as
section 2.3 says of two places that link to one cell. A read through such
a handle is journaled where an entry of `handles` names the entry, and is
refused otherwise.

**Sampled reads.** A slot with `sampled` is materialized like any slot, and
its label joins the template. A change at its address does not make the
cone instance stale (section 3.3). A `sample()` through a handle of
`handles` is journaled, joins the `dynamic` label, and is not registered as
a read that makes the cone instance stale
(`plan-and-label-templates.md` §2.5).

The addresses journaled in step 2 are recorded in the cone instance's memo
entry, per `dynamic` node (section 3.1). The scheduler registers them, with
the trigger reads, in the instance record
(`scheduler-and-serving-loop.md` §3.4).

A `lift` or a `computed` may be called any number of times and has to
produce the same writes each time. The idempotency contract of
[Scheduler v2](../scheduler-v2/README.md) (§4.2) and its validator apply to
every body that writes, unchanged.

A body that is a materializer is not invoked through `host.invoke`. It runs
in a transaction of its own (section 6.7).

**The record of a key of a list.** `h.elementById(id)` on a handle of a
list yields a handle for the record of that key (`language-subset.md`
§4.7), and `footprint-analysis.md` §7 records it as the handle at `*`
below the list, not anchored. In the runtime of today the record is an
entity of its own, named from the list and the key, and it is no
position of the list until something adds it (`elementById` in
`runtime/runner/src/cell.ts`). By ruling the compiled path stores the
record as today, and the prototype's executor does so.

- **Its name.** The record is a cell of its own, named by the address
  of the list and the key. It has no document until something writes
  it.
- **Membership.** It is not a member of the list until a reference to
  it is added, as `addUnique` adds one unless the list holds it, and
  `removeByValue` removes the members that are that reference.
- **Its label.** A reader of the list's label does not cover the record
  before it is a member: the label of the list does not extend to the
  record, and a read of the list does not read it. The record has the
  label of what is written to it and of what its own schema declares,
  which is the element schema of the list that the handle carries
  (`elementSchemaFor` in `runtime/runner/src/cell.ts`). A write
  through the handle is a write to the record. It is not a write at a
  position of the list, it does not make a reader of the list stale,
  and it is not labeled as a member of the list. Once a reference to
  the record is a member, a reader that follows the reference reads
  the record under the record's label, as it reads any cell behind a
  reference in an array.

*Assumed* (section 11, question 89): for the footprint the handle
stays the handle at `*` below the list, as `footprint-analysis.md` §7
records it, read as the name of some record of the list. The list here
is one a handle names, and its members are references to the records.
The key is the one the caller passes and is no element key of a
per-element construct, and a per-element construct over such a list is
the case of an array of references.

### 2.5 Element cones

`plan-and-label-templates.md` §1.3 and `builtin-inventory.md` ("Element
keys") define the key of an element. This section says what the runtime does
with it.

For a collection the runtime keeps, per scope key, an **element table**. A
key stands at one position of the collection, and the table holds, per
key:

- the cone instances of the body for that key, with the value, the
  selections, and the reads made through handles and links;
- the position that holds the key, and the binding of each element slot at
  that position, which is the address the element was read from and, for a
  linked element, the chain to its cell;
- the label identifiers resolved at those addresses. Two positions that
  hold equal plain values at two addresses have two keys and can carry
  different labels, and the instantiation key of each is formed from the
  labels at its own addresses (`plan-and-label-templates.md` §1.3).

**What an element slot reads, by case.** Over an array of references
the element slots are bound to the cell the position links to, and a
move changes no binding. Over an array of plain values in place the
element is stored at its position, which a move changes, and by ruling
it is named by the collection and its key. The value of such an
element is the value its key is formed from, so the runtime can hold
it in the element table with the key, and an evaluation for the key
then reads no position. A move changes no value that an element slot
yields, which is why nothing is evaluated for a moved element (section
2.6). An `identity` slot of the element, or of a member of it, yields
the reference by key: the collection, the key, and the path
(`plan-and-label-templates.md` §1.3). A cone that passes the element
on, a handler bound in the body, a sandboxed body used there, and the
argument of a child are all given that reference, and each read or
write through it is resolved to the position the table has for the
key at that time. The label identifiers are read at that position.
Over the result of another per-element construct the element slots
read the results of the upstream body for the same key ("A chain of
per-element constructs", section 2.6). Where the upstream result holds
a link at the position, the element is the cell it links to. Where it
holds a value, the element is named by the upstream result and the
key, and its reference is by key as well. By ruling an element of a
plain array generated from scratch, which a `lift` or a `computed`
returns whole and the instance stores as an output, is named the same
way: by the output, at its address, and its key, with or without a
declared key. With no declared key such a reference reads as nothing
once the computation returns the element with another value. The owner
gave that ruling with the reservation that a copy is acceptable where
the reference proves complex to build for little gain
(`plan-and-label-templates.md` §8, question 148). By ruling the same
holds where such an output is inside an element body, whichever of the
three cases that body is over: a link to one of its elements that is
stored elsewhere reads the current value. An array at a path below a
value that a function body returns, and an array that the reactive tier
writes, give their elements no place for now, and a body over one is
given the value and stores a copy. That is a known limit, and no ruling
says that such an array never gives its elements a place (its question
151). By ruling a plain array generated from scratch that is given whole
to an instance of its own, as `Rows.asInstance()({ repos })`, is given
as a link to the stored output with the schema of the array, and the
argument of the instance does not hold the values (its §3.15, "Labels
going in", and its §8, question 149). An array of plain values in place
and an array of references that are given whole are given as links
already. What the argument holds for the result of another per-element
construct that is given whole to an instance of its own is *assumed*:
the assembled values. The coordinator of this work recommends a link to
the assembled collection in their place, which is not ruled (its
question 154). Where an output that is not kept is stored, so that it
has an address, is *assumed* as well: in a document of its own
(sections 4.1 and 5.2; its question 157).

**Resolving a reference by key.** A reference by key that is stored
outside the element body, as in a cell a handler wrote, is resolved by
whoever reads or writes through it. Where the collection has an
element table, the table gives the position. Where it has none,
because no loaded instance iterates the array, the runtime computes
the keys of the array's positions as step 2 below does, which needs
the salt of the space (section 5.3). The reader is registered at the
collection's membership and at the path below the position it resolved
to, so a move, a removal, and a change at the path each make it stale.
Provisional (P24 of the continuation plan): a write below the array
marks the readers through the keys that the write touched, and not
every reader through a key of the array
(`scheduler-and-serving-loop.md` §3.2).
A reference whose key no position holds reads as nothing. How the
reference is stored, and what a client does that cannot read the
salt, are assumed (`plan-and-label-templates.md` §8, question 113).

**A write that changes the value re-keys the element.** The case is an
array of plain values in place, where the key is formed from the
value; it does not arise over an array of references. By ruling a
write through a reference by key that changes the value re-keys the
element in the same transaction. The runtime computes the key of the
new value, with its occurrence count, and moves what the old key
holds to the new key: in the element table the entry of the position,
and in storage the state cells, the streams, the operation state and
the children that the body keeps under the key ("State, handlers and
children", below). It updates the reference that the writer holds, so
a later write through it in the same run of a handler lands at the
same element. References stored elsewhere under the old key are not
updated, because the runtime cannot find them all, and read as
nothing. The cone instances of the row are those of the new key and
are stale for the changed value. *Assumed*
(`plan-and-label-templates.md` §8, question 112): the stored
documents are moved by writing them under the identifiers of the new
key and retiring those of the old key in the same transaction, so
that an identifier is still a function of the key (section 5.3); and
a link held elsewhere to a state cell or a stream of the old key
reads what it read before the write and no later value. By ruling as
well: an instance that a `lift` or a `computed` of
the body made under the old key is moved as a child is, and nothing
is moved for a binding that a function body made, which is named by
what it holds; what is moved replaces what is stored under the new
key from an element that left earlier; and an element whose
occurrence count the edit changed has nothing moved and reads what is
stored under the key of its new count. A write that is not made
through a reference by key, as a `set` of the whole array, re-keys
nothing. By ruling, where an instance that was called through
`asInstance()` moves to a key under which another such instance is
named, the replaced instance is no longer named by the element table
and its documents stay in the store: nothing is cleaned up, as when
an element leaves, and a link to it that is stored elsewhere keeps
reading it. *Assumed* (`plan-and-label-templates.md` §8, question
146): a replaced instance that a `lift` or a `computed` of the body
made is removed with its documents. Where the replaced instance was
called through `asInstance()` and stays, the moved one cannot be
written under the identifiers of the new key, which the replaced one
holds. *Assumed* (its question 158): the moved instance keeps the
identifier it was made with, and an instance that is made later under
the key it left has a cause that tells it from the moved one.

The prototype's executor re-keys when the handler returns, or at its
next settling for a write from outside a handler, as through a member
bound both ways, and a handler that throws moves nothing. Until the
transaction ends it finds a key that was changed under the key the
element has now, so the handler's second write succeeds. It moves
the state cells of the old key, in the body over the array and in the
bodies over the results of the constructs applied to it, and drops
the cone instances of the old key. It moves an instance that a
function body made in the element body, as ruled, and removes the
instance that the moved one replaces, with its documents. It leaves a
replaced `asInstance()` instance in the store, and moves nothing for a
binding that a function body made.

**The runtime reports state under a key formed from a whole value.**
Provisional (P21 of the continuation plan, as replaced; section 11,
question 112). The case is an array of plain values in place with no
declared key, a plain array generated from scratch with none, and the
result of a chain of per-element constructs whose first source is one
of these; it does not arise over an array of references or with
`ArrayByKey`. Where the body of the construct stores state under the
key (a state cell, the stream of a handler binding, the state of an
operation, a child called through `asInstance()`), each edit of a row
either moves that state to another key, where the edit is a write
through a reference by key, or leaves it stored under a key that no
position holds, where it is any other write. The runtime reports
`array-by-key:state-under-value-key`, the name *assumed*, at the first
such change of a collection: the first that moves stored state to
another key or leaves stored state under a key that left. *Assumed:*
a change is such an edit where one transaction removes a key at a
position and enters another key at that position, and a removal alone
is not reported. The runtime reports it once for each collection in a
session. The report names the
collection and the two corrections: declare the key fields on the
array with `ArrayByKey`, or hold the rows as an array of references.
It changes nothing that is stored and no label. The compiler reports
nothing for the case: the type of an array does not say whether it
holds plain values in place or references, and a list that is filled
by `push` of a record through a handle holds references
(`language-subset.md` §4.4.1). *Assumed:* the report is a warning of
the runtime that evaluated the transaction, in the channel in which a
runtime reports a failed cone, and a session is the lifetime of that
runtime's loaded instance. The prototype does not report it.

**Which cones are the body's.** The cones of a collection's body are the
cones of the plan whose `Cone.within` has the `element` step that names
the collection (`plan-and-label-templates.md` §1.1 and §1.4). By ruling
the runtime takes two things from the `element` steps of a cone,
outermost first. An instance of the cone exists for each combination of
keys of the collections they name: it is made when a key is added and
dropped when the key is removed (steps 3 and 5 below). And what the
instance holds is kept under those keys ("What is stored per key",
below). The runtime does not decide either from the slots a cone lists.
A cone of the body that lists no slot of root `element` or `index` has
an instance per key as every other cone of the body has, and is
evaluated for each key, also where the instances of two keys read the
same inputs and compute equal values. The rule is the same whether the
collection is over an array of references, an array of plain values in
place, or the result of another per-element construct: the three differ
in how step 2 computes a key, and in nothing this paragraph says.
`Cone.within` is assumed to hold `site` steps as well
(`plan-and-label-templates.md` §8, question 98). They name no
collection, and the runtime does not use them here.

**What is stored per key.** Everything an element cone stores is stored
per key: a kept output, the state of an operation declared in the body
(section 6), the stored request and the result of an effect (section
6.4), a path of the argument of a child or of an instance the cone makes
(sections 4.6 and 2.8), a side-write, a copied path of a binding or of an
inline pattern's parameters (sections 4.7 and 4.6), and an entry of the
cache document (section 8.4). Each carries the label its own rule gives
it, instantiated for the key from the label identifiers at the one
position that holds the key (`plan-and-label-templates.md` §2.6 has the
rule for every item of this list; section 11, request 51). Nothing is
stored once for two positions, and no label is a join over positions.
Each occurrence of an element has an element run of its own in the
runtime of today as well (`listElementKeys` in
`runtime/runner/src/builtins/list-element-keys.ts`), so this is equal to
today.

**Labels per value.** By ruling, the callback of a per-element construct
is a pattern, and labels flow through it per value
(`plan-and-label-templates.md` §3.6). The runtime forms no label for an
element body as a whole and stores none per element: the element table
holds label identifiers per key and per slot, and the label of what a
cone instance or a handler writes is instantiated from the slots that one
node reads. A node that reads neither the index nor the collection takes
nothing of another position and nothing of the collection's membership.
The compiled path has no argument document per element, so nothing
carries a join of the evaluation that set an element up, as the argument
document of an element's instance does in the runtime of today. The
labels of two positions meet nowhere.

**State, handlers and children.** Everything an element body holds is
per key, and so per occurrence of an element, whether a position holds a
link or a plain value and whether or not the body uses the index. The
position is in no key.

- **A state cell.** A body may declare a state cell over every
  collection. Two rows that show equal values have two keys and a cell
  each. A cell whose first value is a constant has no document for a
  key until something writes it (section 4.1).
- **A handler.** The binding is made once for each key, and the stream's
  identifier holds the key (section 5.2), so two rows that show equal
  values have two streams. An event names one key, and the handler's
  element slots resolve at the position that holds the key
  (`scheduler-and-serving-loop.md` §5.1). By ruling an event for the
  stream of a key that has left the collection is refused, also where
  a link to the stream is stored outside the collection: the binding
  of an element body exists while its key is in the collection. That
  is the same over an array of references, over an array of plain
  values in place, and over the result of another per-element
  construct. A row that is to take events after its element has left
  is a pattern called through `asInstance()` ("Children of an element
  body", below).
- **The index.** A cone of the body that reads the index lists the slot
  of root `index` that names the collection
  (`plan-and-label-templates.md` §1.3), and `host.slot` yields the
  position that the key stands at. The runtime binds the slot per key
  from the element table. When a key's position changes, the slot's
  value changes, the cone instances of that key that list the slot are
  stale, and no other cone instance of the key is. The state cells, the
  streams, the operation state and the children under the key stay. An
  effect whose request holds the index is requested again, and a child's
  argument path that holds the index is written again, as for any input
  that changed. A state cell declared with a value from the index keeps
  what it holds: the declared value is written when the cell is first
  created and not again. A cell or a child that a function body makes
  under an explicit cause that holds the index is named by the cause,
  and a binding of a function body that copies the index is a stream
  named by the copied value, so after a move the evaluation names
  another. A child that the evaluation no longer makes is torn down
  (section 2.8). The label of the slot is
  the label of the collection's own array: its length and which link
  each position holds, and nothing of what the links point to
  (`plan-and-label-templates.md` §2.2).
- **A child.** A child that the body instantiates is named through the
  key. Two equal elements have two children, and each factory of
  `factories.map((F) => F({ ... }))` has a child per occurrence. The
  paragraph
  "Children of an element body" below has what a change of the
  collection does to them.

The runtime evaluates a `map` over the collection as follows.

1. Read the collection's `enumeration` slot and each position's reference
   or plain value. This is the runtime's own observation
   (`plan-and-label-templates.md` §1.3) and is the only read of the
   collection the `map` itself makes.
2. Compute the key of every position. The element part of a position that
   holds a link is the identity of the cell it links to, which is the
   address the link resolves to, the path within the document included,
   and that of a position that holds a plain value is the salted hash
   of the value (section 5.3). A position of the result of another
   per-element construct has the key of the upstream element it came
   from, and a position of a `flatMap` result has that key together
   with a part formed from the member the position holds ("A chain of
   per-element constructs", section 2.6;
   `plan-and-label-templates.md` §1.3 names the three cases). The key
   holds the element part and the number of earlier positions with the
   same element part. The position is not in
   the key. Record each key's position and binding. The position is the
   value of the key's slot of root `index`, for the cones that list it.
3. For each key not in the table, create its cone instances, one for
   each cone whose `within` names the collection, and evaluate them
   with the `element` slots bound to that element. No two positions
   have one key, so each position has an evaluation of its own.
4. For each key in the table whose cone instances are stale, evaluate them.
   A key whose position changed has stale the cone instances that list
   the slot of root `index`, and those alone on that account.
5. For each key in the table that no position holds any more, drop its cone
   instances and its memo entries, and tear down the instances their
   evaluations made (section 2.8) and the children the body has under the
   key. By ruling the removal deletes nothing that is stored under the
   key: the state cells and the operation state declared under it stay
   stored, in each of the three cases of a source. A key that returns
   has new cone instances, which are evaluated, and they read what the
   state cells of the key held before ("A key that left its
   collection", section 2.6).
6. Assemble the result: position `i` receives the outputs of the cone
   instances of the key at position `i`. A hole stays a hole.

No cone computes the assembled collection: the runtime assembles it in
step 6. Which entry of `Plan.outputs` stands for it, and what that
entry's `cone` is, is in `plan-and-label-templates.md` §1.4. A cone that
uses the assembled collection pulls that entry with `host.output`, and it
is stored when it is kept. Provisional (P22): a cone that places the
collection and observes nothing of it is given a collection reference,
and the rows are stored by the collection (section 2.2, "A collection
that a cone places").

**The groups of a `fold` over the collection.** Provisional (P31 of the
continuation plan; `plan-and-label-templates.md` §4.2 and §4.3). The
label of a `fold` is instantiated once per group of element inputs, not
once per element. In the `groups` form, the form for an array of
references and for the result of another per-element construct, the
assembly keeps the group of each element key and the count per group,
beside the element table and not in a durable state of the `fold`, so a
`fold` that belongs to no operation, such as the membership of a `filter`
or a `flatMap`, has them as well. Step 3, step 4 and step 5 each update
them once for each key they touch: one update per changed element. The
label of the `fold` changes only when the count of a group crosses zero or
the label of a group changes. In the `uniform` form, the form for an array
of plain values in place, there is one group and no count. A plain array
generated from scratch is included in that case, as
`plan-and-label-templates.md` §1.3 has it.

**The stored form of equal element labels.** Provisional (P31;
`plan-and-label-templates.md` §2.3, "One entry for the elements of an array
written whole"). When an array is written whole and every element of it is
covered with one label, the stored form holds one entry at the array's `*`
path and none per element. An element written later with another label
adds an entry of its own at its position, and a read of that position
consumes the union of that entry and the `*` entry. A `splice` of the array
removes the `*` entry, and the elements then take the label of the list.
Both limits give a label equal to or wider than the label per element,
never a narrower one.

**The steps state the result, and not an algorithm.** Provisional (P23
of the continuation plan; section 11, question 105). A runtime may keep
what a change did not touch, where the table and the assembled result
it then holds are those that steps 1 to 6 give.

- **A kept key.** The key of a position is a function of what the
  position holds, so the key that a runtime kept for a position that no
  write touched is the key that step 2 computes. A write below one
  element forms the key of that element. A `splice` forms the keys of
  the entries it put in. An array that is written whole keeps the keys
  of the entries that are equal at its start and at its end, compared
  with no hash, and forms those between. Where an element part that left
  or entered is one that another position has, the occurrence counts
  are formed again from the kept element parts, with no hash.
- **An assembly brought up to date.** The runtime applies the splices of
  the source to the element table and to the assembled result:
  it creates and evaluates the cone instances of the keys that entered
  (step 3), evaluates those of the keys whose entries are marked (step
  4), and drops those of the keys that left (step 5). For a construct
  over the result of another per-element construct the splices are those
  that the upstream assembly reports.
- **What still follows the length.** A key whose position changed has a
  new value of its slot of root `index`, so an insertion or a removal
  that is not at the end gives every later key another position, which
  is one number written per later key and no evaluation except of the
  cones that list the slot. And an array that a writer replaces by a
  `set` of a whole new array is compared entry by entry.

The case of the first bullet is an array of plain values in place, with
a declared key and without, where the prototype measured 1 salted hash
for one append, insertion or edit and none for a removal at a length of
10,000, against 10,000 with every key formed again. Over an array of
references no key is hashed in either way. Over the result of another
per-element construct the keys are the upstream keys and the second
bullet applies.

The element table is built by evaluation and not when an instance is
loaded: a plain value's key is a hash of the value, and a collection
derived by `map` or `flatMap` has positions only once it was evaluated. The
scheduler registers its entries for element slots from the
table, after the collection's first evaluation and after each change of
membership (`scheduler-and-serving-loop.md` §3.2).

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
keyed by the outer element's key and then the inner one's, outermost first,
which is the order of the `element` steps of `Cone.within`.

**Children of an element body.**
A body instantiates a child where a factory value is called in the
reactive tier of the body, or where a `lift` or a `computed` written in
the body instantiates a pattern, whose instances are named through the
body's `within` (section 5.5). Two things are not children of the
element. An instance that only a handler requests is identified by no
element key. And a statically resolved pattern called in the body is
compiled into the body: the call is no `Child`, and a state cell it
declares is a state cell of the body, per key as any other
(`language-subset.md` §4.4.1). A pattern that is called in the body
through the modifier `asInstance()` is a child, whatever kind its
callee is of, and by ruling it is one that stays when its key leaves
("A child called through `asInstance()`", below). The items that
follow say of a removal, of an edit and of teardown what holds for a
child without the modifier.

- **The key.** The child's `within` has the `element` step with the key
  of the body's cone instances (section 5.3): the element part and the
  occurrence count, and never the position. So
  everything the body has for an element is under one key: its cone
  instances, the child with its documents, a stream a handler bound in
  the body yields, a state cell, and the state of an operation declared
  in the body.
- **A reorder.** A key moves with its element, so the child, its state
  cells, the state of its operations and the settled results of its
  effects stay with the element. Elements with the same element part
  are told apart by their order alone: a move that changes the order of
  two of them changes no key, and the first in the new order has the
  child of occurrence 0.
- **An insertion** adds one key, and a child is set up for it. Where the
  inserted element has the element part of elements already in the
  collection, the key that enters is the one with the highest count,
  whatever the position of the insertion, and each of those elements has
  the child of its place in their order.
- **A removal.** The child of the key that left is torn down, unless it
  was called through `asInstance()`. Where two
  equal values stand in the collection and the first is removed, the
  one that remains becomes occurrence 0 and has the child and the state
  of the first occurrence. The key that left is that of the last
  occurrence, and its child is the one torn down. The state cells and
  the operation state that the body declares under that key stay
  stored, by ruling (section 2.6).
- **A plain value edited in place** is another key at the same position:
  the child of the earlier value is torn down and a child is set up for
  the new one. By ruling an edit made through a reference by key is
  excepted: the element is re-keyed, and the child, with the rest of
  what the old key holds, is moved to the new key and not torn down
  ("A write that changes the value re-keys the element", above). In
  the runtime of today the key of a value stored in
  place holds the position (`plan-and-label-templates.md` §1.3;
  `listElementKeys` in
  `runtime/runner/src/builtins/list-element-keys.ts`), so today such a
  child stays and receives the new value as its argument.
- **Teardown.** A child whose key no position holds is torn down as an
  instance that a computation no longer makes is: by the mark in its
  setup record, with the instances that belong to it, and with its
  documents retired (section 2.8, "Teardown"). So that such a child is
  found after a restart, when the element table is empty, the instances
  document of the enclosing instance lists the children of an element
  body per element key, as it lists the instances a computation made.
- **A key that returns.** A child set up under a key that was held
  before, such as a value that was removed and is added again, is made
  again under the identity of the one that was torn down, with the
  outcome section 2.8 gives ("Made again"). The state cells and the
  operation state that the body itself declares under the key are read
  again by ruling. What the child finds of its own state is *assumed*
  (section 11, question 33).

- **A child called through `asInstance()`.** By ruling a pattern call
  through `asInstance()` in an element body is an instance of its own
  from the moment the element first appears, with an argument
  document and a result document of its own, identified by the site
  of the call, the collection and the element key (section 5.2;
  `plan-and-label-templates.md` §3.15, `Child.asInstance`). It is in
  the instances document of the enclosing instance under its key, as
  any child of an element body is.
  - **While the key is in the collection** the enclosing instance
    writes the child's argument. Over an array of references a path
    bound to the element holds the link to the element's cell, and a
    change of the cell's value writes nothing. Over an array of plain
    values in place, and over the result of another per-element
    construct where the upstream position holds a value, the path
    holds the value, and the write edge writes it again when the
    element changes while it is in the collection.
  - **When the key leaves** nothing is written and nothing is torn
    down. The cone instances of the body for the key are dropped, as
    for any key, and with them the cone instance that writes the
    child's argument, so the argument stays as it was last written.
    The child stays a set-up instance: its documents are not retired,
    it is evaluated on demand as any instance is, and an event for one
    of its streams is routed to it and handled
    (`scheduler-and-serving-loop.md` §5.1). A link to its result that
    a handler stored elsewhere reads the instance. No copy is made,
    when the key leaves or when such a link is stored.
  - **When the key returns** the row has the same instance, with the
    state it accumulated, and the enclosing instance writes its
    argument again.
  - **Cleanup.** Nothing removes an instance that no element and no
    stored link refers to any more. Cleanup of such instances is
    deferred. It is not a new issue: the state cells of a key that
    left stay stored under the same ruling (section 2.6), and the
    history of every document is kept by default.

  The rule is the same in the three cases of a source except for what
  the argument holds, as stated. The instance is identified by the
  key, so what changes a key differs by case
  (`plan-and-label-templates.md` §3.15, "A change of the key, by
  case"). Over an array of references an edit of the element changes
  no key. Over an array of plain values in place that declares a key
  field with `ArrayByKey<T, "field">`, an edit of another
  member, and a new array with the same value of the field, keep the
  key and the instance. Over an array of plain values in place with
  no declared key, an edit through a reference by key re-keys the
  element, and that the instance is re-keyed with it is *assumed*
  (its §8, question 123). Over the result of another per-element
  construct the case is that of the upstream source. Section 2.6 has
  a worked case of the first two ("Two worked cases").

  The prototype's executor implements the modifier, and its fixture
  has the three cases. Over an array of references the argument holds
  the link to the element's cell, and a change of the element's value
  writes no argument and changes no key. Over an array of plain
  values in place the argument holds the value: the instance of a
  value that left reads the value it was last given, and the same
  value written again, at any position, has the same instance. Over
  the result of a `filter` the instance is identified by the upstream
  key, and it is the same when the `filter` drops the element and
  keeps it again. An event for a stream of the instance is handled
  while the key is away, and an event for a binding of an element
  body with no modifier is refused then. The executor identifies the
  instance by a table from the child and the element keys, and on a
  re-key it moves the table entry and leaves the documents under the
  names they were made with, so a link stored elsewhere to the result
  reads the later values, which the assumption of question 123 does
  not have. The runtime of today has no such modifier, so nothing of
  this is compared with it.

An author who needs a child to stay with a record across an edit of the
record makes the elements cells: a position that holds a link keeps its
element part when the value behind the link changes. An author who
needs a row to stay when its element leaves the collection calls the
row's pattern through `asInstance()`.

### 2.6 What a change re-evaluates

| Change | Made stale | Evaluated when demanded | Written |
| --- | --- | --- | --- |
| A slot of one element changes (a field of a message is edited) | The cone instances of that element's key whose last evaluation read the slot, or read the address through a handle or a link | Those cone instances, once | The changed kept paths of the position that holds the key |
| A captured outer value changes | Every element's cone instances that read it | All of them | The changed kept paths |
| A child of a captured outer output changes, and the body reaches that output only through a `pick` | The cone instances whose `pick` chose that child (section 3.3) | Those | Their changed kept paths |
| An element is appended or inserted | The collection's membership; no existing element's cone | The new key's cone instances | The new positions; for an insertion, the positions after it move in the stored array (section 4.2) |
| An element is removed | The collection's membership | Nothing. The cone instances of the key are dropped | The stored array loses the position, and a part document of the row is deleted (section 4.10). Nothing stored under the key is deleted (below, "A key that left its collection") |
| Elements are reordered | The collection's membership | Nothing, unless a cone of the body reads the index. The runtime moves what each key holds (below) | The stored array is rewritten in the new order: the storage links of rows that are parts, and the values of rows stored in place. Label entries only where the label at a position changed |
| A cone of the body reads the index and an element moves | The cone instances of the moved keys that list the slot of root `index`. No key changes, and state cells, streams, operation state and children stay | Those cone instances | Their changed kept paths |
| The value behind a linked element changes | That element's cone instances; the key is unchanged | That element | Its changed kept paths |
| A plain value with no declared key field is edited in place, other than through a reference by key | Membership: the old key leaves and a new key enters | The new key | The position |
| A plain value with no declared key field is edited through a reference by key | The element is re-keyed: what the old key holds moves to the new key (section 2.5) | The cone instances of the row that read the changed value | The position |
| A plain value of an array that declares a key field (`ArrayByKey<T, "field">`) changes in another member, by a write of any kind or by a new array from the computation that produces it | The cone instances of the element's key that read the changed member; the key is unchanged, and state cells, streams, operation state and children stay | Those cone instances | The position, and their changed kept paths |

A cone downstream of a collection, such as a `count` or a `filter` over the
result of a `map`, is made stale through its own slots and upstream outputs
in the same way. A fold updates the contribution of the keys that changed
and does not visit the others (section 6.1).

The cutoff applies at every step: a cone instance whose evaluation produces
the outputs it produced before does not make its consumers stale.

**A moved element.** By ruling, when an element moves the runtime moves
what the element's key holds to the new position: the stored results of
its cone instances, which are the kept paths of its row, with their
labels and provenance. It evaluates nothing for the element, except the
cone instances that list the slot of root `index`. Evaluating the
element's cone instances again is permitted, and moving is preferred.
The state cells, streams, operation state and children of the key are
named by the key and do not move.

**A key that left its collection.** By ruling the removal of an element
deletes nothing that is stored under its key. The rule is the same over
an array of references, over an array of plain values in place, and
over the result of another per-element construct.

- **What is dropped.** The cone instances of the key and their memo
  entries (section 2.5, step 5). The stored outputs of those cone
  instances go with them: the position leaves the stored array, and a
  part document of the row is deleted in the same transaction (section
  4.10). A part document holds kept paths of the row, which the cone
  instances of a key that returns compute again. It holds no state
  cell and no operation state, so its deletion deletes nothing that
  the ruling keeps.
- **What stays.** The state cells that the body declares under the key,
  and the state of the operations declared under it, the settled
  result of an effect included. Their documents are named from the
  enclosing instance and the key (section 5.2), and the removal writes
  none of them. They are not retired documents, and the rule of
  section 9.6 does not delete them.
- **A key that returns.** The key returns when a link that resolves to
  the same address stands in an array of references again, when the
  same value stands in an array of plain values in place again, with
  the same occurrence count, or an element with the same value of a
  declared key field, and when the upstream key returns in the
  result of another per-element construct, as where an element leaves
  the result of a `filter` and enters it again. New cone instances are
  made for the key and evaluated. A state cell of the key reads what
  it held, an operation of the key finds its state, and a binding of
  the key has the stream it had, because each is named from the key.
  While the key is away an event for that stream is refused, by
  ruling (section 2.5, "State, handlers and children").
  Over an array of plain values in place the key is formed from the
  value. A value that is removed and written back finds the cells it
  had. A value that was edited through a reference by key was
  re-keyed, and its state moved with it (section 2.5); a value that
  was edited in another way, as by a `set` of the whole array, is
  another key and finds none.
- **As today.** The runtime of today names the result cell of an
  element from the result container and the key
  (`listElementResultCell` in
  `runtime/runner/src/builtins/list-coordinator-plan.ts`) and deletes
  no document of an element that was removed (`releaseChild` in
  `runtime/runner/src/runner.ts`), so an element that returns finds
  its old values. Over an array of plain values in place today's key
  holds the position (`plan-and-label-templates.md` §1.3), so what
  returns there today is a position, and under this design a value.
- **Reclaiming the storage** would be a separate mechanism. This design
  has none: the state under a key that does not return stays stored.
- **The prototype.** Its executor drops the cone instances of a key
  that left and their memo entries and keeps the document of a state
  cell declared under the key. A fixture of it declares a cell in the
  body of a `map` over the result of a `filter`, over references and
  over plain values in place: while a key is away its cone instances
  are gone, no document is made or deleted, and the key that returns
  reads what its cell held (72 of 72 values equal those of the runtime
  of today). It has no state of an operation that is kept per key,
  and the one child of an element body it has is a pattern called
  through `asInstance()`, which stays, so neither the operation state
  nor the teardown of a child is exercised. Over plain
  values in place a value that returns at another position is the one
  case where the runtime of today, whose key is the position, would
  read another cell, and the comparison does not have it.

The ruling names the state cells and the operation state under the
key. A child of the body under the key that was called through
`asInstance()` stays, by ruling, and is the same instance when the key
returns. Another child of the body under the key is torn down (section
2.5, "Children of an element body"), and what becomes of its documents
is *assumed* (section 11, question 33).

For an element that is a plain value stored in place, the place the
element is read from is its position in the collection's document. A
cone that passes such an element on through its `identity` slot, as the
cone of `tags.map((tag) => <li>{tag}</li>)` does, would with a link to
that position name, after a move, a position where another value
stands. By ruling an element that is a plain value in place is named by
its collection and its key, and a reference to it or to a member of it
resolves to the current position at each read and each write
(`plan-and-label-templates.md` §1.3, "A plain value in place has an
identity"). The cone stores that reference by key in the element's
result, by the rule that a value passed on unchanged is stored as a
reference (section 2.4), and no copy of the value. A move changes
nothing the reference holds, so the row is right after a move and
nothing is evaluated for it. For a position that holds a link the
element is the cell, a move does not change it, and the result holds
the link. Over the result of another per-element construct the
result holds what the upstream element is: the link to a cell, or the
reference by key that names the upstream collection and the key.

Four things follow, each over an array of plain values in place, and
over the result of another per-element construct where the upstream
position holds a value and not a link. None arises over an array of
references, where the element is a cell.

- **Identity.** A cone that compares the element with a reference, as
  `equals(selected, item)` does, holds a reference by key. Two
  references by key are equal where they name the same collection, key
  and path, and a reference by key and a reference to a cell are not
  equal. `equals` of two references by key resolves no key to a
  position. By ruling a handle by position, as `items.key(i)`, is
  equal to the reference by key of the element that stands at `i`,
  with both resolved to the current position (section 2.2).
- **A handler bound in the body** is given the same reference as the
  cones of its row, and a write through it lands at the position that
  holds the key when the write is made. The element table keeps the
  position of each key for that resolution and for the index slot.
- **A member bound both ways.** A row that binds a member of the
  element both ways, as `$checked={item.done}` does, holds at the
  attribute a reference by key with the member's path, and a write
  from the rendered tree lands in the member of the element where it
  stands. The write changes the value, so the position then holds
  another key. By ruling the write re-keys the element in the same
  transaction: what the old key held is moved to the new key, and the
  row keeps its state (section 2.5, "A write that changes the value
  re-keys the element").
- **A stored reference to a member.** A node of the reactive tier that
  passes a member of the element on, and a handler that stores a
  handle it was given for the member, store a reference by key with
  the member's path. It follows the element when
  the element moves. After the element is removed no position holds
  the key, and the cell reads as nothing. That is a deliberate
  difference from the runtime of today, where a reference to a member
  of a record stored in place names the position: after a removal it
  reads the element that moved to the position, and nothing once no
  element stands there (`plan-and-label-templates.md` §1.3, "Which
  stored forms make which case"). By ruling a handler that reads the
  member through a handle and writes the value to a cell stores a
  copy, as today, and the cell reads the value after the removal.
  By ruling a handler that is given the element at a state path of
  data type, as `center.set(stop.position)` with the state
  `stop: Stop`, stores a reference by key with the member's path,
  and the cell reads as nothing after the removal. By the
  prototype's measurement the runtime of today stores a link to the
  position there.

A list that function bodies fill with records through `set`, `push`
or `addUnique` is not this case. Each record is a document of its own
and the list holds a link to it, today and in this design (section
4.8; `plan-and-label-templates.md` §1.3), so the list is an array of
references. A stored reference to a member of such a record is a link
into the record's document, and it reads the record after the list no
longer holds it. The stops of
`patterns/examples/map-demo/map-demo.tsx` and the elements of
`patterns/dev/gideon-tests/test-cell-equals.tsx` are such records:
both modules fill their list with `push`, and the prototype's
executor, which stores a record so written as a document of its own,
computes for them the values of today's runtime.

**A chain of per-element constructs.** By ruling an element of a
collection that is the result of a per-element construct is keyed by
the key of the upstream element it came from
(`plan-and-label-templates.md` §1.3). The element table of a body
applied to the result of a `map` or a `filter` therefore has the keys
of the source of that construct, for the positions the result holds. A
change of one upstream element makes stale the cone instances of that
key in each body of the chain, by the first row of the table, and no
cone instance of another key. For a `flatMap` the key is ruled as
well (its §1.3): the key of the source element together with a part
formed from the member itself, by the rule for any array. The part is
the address a member that is a reference resolves to, or the salted
hash of a member that is a plain value, with the count of earlier
equal members of the same segment. So the element table of a body over
a `flatMap` result is computed from the segments, when the runtime
assembles the result and records the length of each source element's
segment (section 2.5). A move of the source elements evaluates
nothing, and two members of one segment that change places evaluate
nothing either, except the cone instances that list the slot of root
`index`. The state cells, streams, operation state and children of a
body over the result stay with the member. That is the same for a
segment of references and for a segment of plain values, over a source
of any of the three cases.

The dependency is by key, and it is no edge of `Plan.edges`: a cone
instance of the downstream body depends on the results of the upstream
body for its key, at the paths its element slots read, through the
`source` of kind `collection` of the downstream record
(`plan-and-label-templates.md` §1.3). It makes the downstream cone
instance stale as an edge does. When the source of the chain is
reordered, each collection of the chain is assembled again, and no
cone instance of an element body is evaluated unless it reads the
index. This holds whether the source of the chain is an array of
references or an array of plain values in place. By ruling an output
that passes the result of a per-element construct on unchanged is the
same collection for keying, and the plan marks it
(`Output.passesCollection`, its §1.1 and §1.3). A construct whose
source is a marked output uses the element table of the collection the
mark names: the runtime builds no table from what the positions of the
output hold. Where the mark is absent the table is built from the
positions (its §8, question 111).

**A whole array of plain values from one computation.** Where the
source of a collection is plain values that one `lift` or `computed`
returns as a whole array, the runtime may evaluate the body for the
whole collection again on each change of the array, in place of
keeping the results of cone instances per key. This is a choice of the
implementation and is not observable: the stored values and labels are
those the per-key evaluation gives, and the state cells, streams,
operation state and children stay per key. Such an array is the one
case where no upstream cause identifies an element, where by ruling
the key of an element of an array of references, and of the result of
another per-element construct, derives from upstream causes and stays
stable. By ruling the author declares the key of such an array on the
array, with the array type `ArrayByKey<T, "field">`, and the key of
each element then names that field and holds a salted hash of its
value, with the occurrence count where two elements have the same
value of it. By ruling the declaration can name several fields, as a
union of their names, and the element then has one key across them
(`plan-and-label-templates.md` §1.3, "A declared key field"). Without
the declaration the key of each is its whole value with the occurrence
count, and an element whose value changes in one member is a new
element.

**Two worked cases: a list that a handler fills, and an API result.**
The first is an array of references and needs no declared key. The
second is a plain array generated from scratch, which is an array of
plain values in place, with a declared key, read through two
per-element constructs.

*An array of references.* A handler instantiates a pattern and pushes
the result.

```tsx
// Shown for illustration only.
const Note = pattern<{ title: Writable<string> }>(({ title }) => ({
  title,
  rename: action<{ title: string }>((event) => title.set(event.title)),
  [UI]: <cf-input $value={title} />,
}));
type NoteResult = ReturnType<typeof Note>;

const addNote = handler<{ title: string }, { notes: Cell<NoteResult[]> }>(
  ({ title }, { notes }) => {
    notes.push(Note({ title }));
  },
);

const Notebook = pattern<{ notes: NoteResult[] }>(({ notes }) => ({
  add: addNote({ notes }),
  [UI]: <ul>{notes.map((note) => <li>{note}</li>)}</ul>,
}));
```

- **The stored form.** Each event makes one instance of `Note`, with a
  result cell that is named from the handling and the ordinal of the
  request in the handler (section 5.4). `notes` holds a link to that
  result cell at each position, so it is an array of references.
- **The key** of a row of `notes.map(...)` is the address the link
  resolves to, with the occurrence count. It is tied to the cause of
  adding the item: the event that the handler handled.
- **A rename** writes `title` in the note's own argument document. No
  position of `notes` changes, no key changes, and the cone instances
  of the row that read the title are evaluated again. What the body
  of the `map` holds for the row stays.
- **`asInstance()` is not needed for the item itself.** The item is an
  instance of its own already, made by the handler and by no element
  body. A handler that stores the item elsewhere, as
  `pinned.push(note)` does, stores the link to its result cell, and
  the link reads the note after `notes` no longer holds it. The
  modifier concerns a pattern that the body of the `map` calls for the
  row, where that row is to stay when its element leaves (section 2.5,
  "A child called through `asInstance()`").

*A plain array generated from scratch, with a declared key.* An API
result is filtered and mapped, and each row is an instance of its own.

```tsx
// Shown for illustration only.
// `ArrayByKey` is an array type of this design. `commonfabric` does
// not export it yet.
type Repo = { id: number; name: string; stars: number };

const RepoSearch = pattern<{ url: string; minStars: number }>(
  ({ url, minStars }) => {
    const response = fetchJson<{ items: ArrayByKey<Repo, "id"> }>({ url });
    const rows = response.result.items
      .filter((repo) => repo.stars >= minStars)
      .map((repo) => RepoRow.asInstance()({ repo }));
    return { rows };
  },
);
```

- **The stored form.** The result of `fetchJson` is one document
  (`builtin-inventory.md`, `fetchJson`), and each response replaces
  `result.items` whole. So `response.result.items` is an array of
  plain values in place that is generated from scratch. The schema of
  the array has `keyFields: ["id"]` beside `items`, and the schema of
  its items is that of `Repo`. That the keyword is on the schema of
  the array is ruled, and its name is *assumed*
  (`plan-and-label-templates.md` §8, question 139).
- **The key** of an element of `response.result.items` names the
  field `id` and holds one salted hash of its value, with the
  occurrence count, which is 0 unless a response holds one `id`
  twice. For the repository whose `id` is 7 the element part is the
  record `{ fields: ["id"], hash }`, where the hash is the salted
  hash of the array `[7]`. By ruling the key is that fabric value,
  with no separators of this design: it is hashed with `hashOf`
  (`base/data-model/src/value-hash/impl.ts`) where it enters an
  identifier, and written with `jsonFromFabricValue`
  (`base/data-model/src/codecs.ts`) where a string is needed. The
  names of the members are *assumed* (its question 144). The key does
  not hold the 7. It is not the key of an element whose whole value
  is 7, whose element part is a hash and names no field.
- **What a link shows, and what a client can form.** A stored
  reference by key to a repository shows the name `id` and a hash. It
  does not show the value of `id` to a reader of the link who cannot
  read the salt. A client cannot read the salt (section 5.3), so it
  cannot form the key of a repository from the response, and cannot
  name the state of a row, a stream bound in the row, or the instance
  of `RepoRow` before the server stores a link to it. That is as for
  an array of plain values in place with no declared key.
- **The result of the `filter`** is the result of another per-element
  construct: an element has the key it has in
  `response.result.items`. **The result of the `map`** is the same
  case, over the `filter`, and an element has that same key. The
  declared key is carried through both.
- **The instance** of `RepoRow` for a repository is identified by the
  site of the call, the collection and that key (section 5.2). The
  upstream position holds a value, so the argument path `repo` holds
  the value.
- **A new response with the same `id`,** for the same `url` or for
  another one, is the same key and the same instance. Where `stars`
  or `name` changed, the cone instance of the predicate for the key is
  evaluated again, and the write edge writes `repo` in the instance's
  argument again. State that the instance accumulated stays.
- **A response without the `id`** makes the key leave. The instance
  stays, with its argument as last written, and a link to it that a
  handler stored elsewhere reads it. When a later response holds the
  `id` again, the row has the same instance.
- **A reference by key is resolved with no schema.** Where the body
  of the `map` also binds a handler whose state declares the element
  with a plain type, as `repo: Repo`, the handler is given a
  reference by key, and `selected.set(repo.name)` stores that
  reference with the path `name`. The link has the schema of the
  member, a string, and not that of the items. A reader of `selected`
  resolves it from the key alone: in the collection that the
  reference names it finds the element whose `id` is 7, and reads
  `name` there. To find the element it combines the `id` of each
  element of the array as the key was formed, hashes with the salt,
  and compares with the hash in the key. No reader needs to know
  that the array was declared with `ArrayByKey`, and the runtime
  keeps no record of the schema the array is stored under for this.
- **An element put into a second array.** By ruling the key belongs
  to the array. A `computed` that returns some of the repositories in
  a new array of type `Repo[]` returns a plain array generated from
  scratch with no declared key, and a `map` over it keys each element
  by its whole value. Declared as `ArrayByKey<Repo, "id">`, the new
  array has a key of its own. The result of the `filter` above is
  not such an array: it has the upstream keys.
- **A reader typed `Repo[]`.** By ruling a pattern whose input is
  typed `repos: Repo[]`, given `response.result.items`, forms the
  keys of a `map` over `repos` with the key field `id` of the array
  it is given, so a row there has the key it has here. It learns the
  field from the keyword `keyFields` of the schema of the array, which
  is met on the schema that is traversed while the link to the array
  is resolved. *Assumed* (`plan-and-label-templates.md` §8, question
  145): where no schema with the keyword is met on the way, the reader
  forms the keys from the whole value.
- **Without the declaration** the key of an element is the hash of its
  whole value. A response in which `stars` changed is then a new key
  and a new instance, and the instance of the old key stays with the
  old value.

*The same, with a key of two fields.* An API whose repositories have
no `id` of their own identifies one by its owner and its name.

```tsx
// Shown for illustration only.
// `ArrayByKey` is an array type of this design. `commonfabric` does
// not export it yet.
type Repo = { owner: string; name: string; stars: number };

const RepoSearch = pattern<{ url: string; minStars: number }>(
  ({ url, minStars }) => {
    const response = fetchJson<{
      items: ArrayByKey<Repo, "owner" | "name">;
    }>({ url });
    const rows = response.result.items
      .filter((repo) => repo.stars >= minStars)
      .map((repo) => RepoRow.asInstance()({ repo }));
    return { rows };
  },
);
```

- **The stored form** is as above, an array of plain values in place
  that is generated from scratch. The schema of the array has
  `keyFields: ["name", "owner"]`, the names in the order of the names.
  The order is ruled, and the name of the keyword is *assumed*
  (`plan-and-label-templates.md` §8, question 139).
- **The key** of an element is one key, formed across the two fields.
  For the repository `labs` of the owner `commonfabric` the element
  part is the record `{ fields: ["name", "owner"], hash }`, where the
  hash is the salted hash of the array `["labs", "commonfabric"]`,
  the values in the order of the names (the names of the members are
  *assumed*, its question 144).
  Two repositories named `labs` of two owners have two keys with the
  occurrence count 0, and two rows. The two keys have the names in
  common and two unrelated hashes, so neither a link nor a pair of
  links shows that the two repositories share a name.
- **The results of the `filter` and of the `map`** are the result of
  another per-element construct, and their elements have that key.
- **A new response** that holds the same `owner` and `name` with
  another `stars` is the same key and the same instance of `RepoRow`.
  A repository that its owner renames has another `name`, so it is
  another key and another instance, and the instance of the old key
  stays.
- **A reference by key** to such an element, or to a member of it, is
  resolved by finding the element of the array whose `name` and
  `owner`, combined and hashed with the salt, give the hash that the
  key holds.
- **An array of references** with the same element type would be
  keyed by its cells, and the declaration would change nothing there.

The prototype's executor has the second case in a fixture, with a
`lift` in the place of `fetchJson`: each element has the key of its
`id`, a state cell of its row stays when every element has another
`stars`, and the instance of a row is the same when its element has
another `stars`, leaves the result of the `filter`, and enters it
again. A second fixture has a key of two fields. The prototype reads
the declaration of the key from the array type and the keyword from the
schema of the array. Its key names the fields and holds one salted hash
of their values, it is written with `jsonFromFabricValue`, and its
store resolves a reference by key from the key alone, as ruled. Its
key has the record forms of the documents, and its salted hash is of
the record with `salt` and `value`, as ruled
(`plan-and-label-templates.md` §1.3, "A declared key field", and its
§8, questions 144 and 152). In the fixtures the
array is what a `lift` returns, which the executor stores in a document
of the output, and a handler over it stores a reference by key, with
that document as the collection. A pattern whose input is typed `Repo[]`
and that is given the array keys its rows by `id` where it is compiled
in, which is *assumed* to be the design (its question 149). By ruling a
pattern that is called through `asInstance()` and given whole what a
`lift` or a `computed` returns is given a link to the stored output with
the schema of the array, so its rows are keyed by `id` as well, and its
argument does not hold the values. The prototype's executor does so.
By ruling the type of the result of a `map` keeps the key fields of its
receiver, as the type of the result of a `filter` does (its question
150). *Assumed* (its question 155): it does so only where the element
type of the result has those fields. The rows of the `map` in the
example are results of `RepoRow`, so the type of `rows` declares the key
`id` only where that result type has a property `id`; the rows have the
upstream keys in either case. The prototype's compiler keeps the key
fields for every `map` result. The runtime of
today has no such declaration, so nothing of this is compared with
it.

Three points are open for a declared key: a write to the key field
itself (`plan-and-label-templates.md` §8, question 129), the document
of a plain value of a keyed array that a body pushes elsewhere
(section 11, question 93), and the declaration on an array of
references (`language-subset.md` §13, question 43). The order of the
fields, what the element part holds, that a key is a fabric value with
no separators of this design, and where a reader whose type declares
no key learns the key fields are ruled. Six points about the
declaration and the form of a key that names its fields are assumed:
which properties can be key fields beyond the deferred extension, the
name of the schema keyword, an array passed where another key is
declared, the names of the members of the record of a key, what a
reader whose type declares no key does where it meets no schema with
the keyword, and an array whose type declares no key given where a
key is declared (`plan-and-label-templates.md` §8, questions 138,
139, 141, 144, 145 and 147).

### 2.7 Side-writes and bounded iteration

A static side-write makes an instance's cones cyclic when the written cell
is read by a cone the writer depends on. The compiler reports the cycles it
can see in `Plan.edges`. The rest are handled inside the cause's
transaction.

- **Detection.** When a pull reaches a cone instance that is already being
  evaluated, the request is a back edge. The requester receives the value
  the cone instance last staged in this transaction, or else its memo entry
  or stored value, or `undefined` where the slot's schema admits it. The
  cone instance in progress is marked as read early.
- **Staleness inside the transaction.** When a write is staged to a cell,
  every cone instance that read that cell earlier in the transaction, or
  was marked as read early through it, is stale again if the written value
  differs from what it read. A handler's writes count: a state cell the
  handler wrote that a cone instance evaluated before the body had read
  makes that cone instance stale, for a later handler of the batch that
  reads it or for the derivation transaction.
  Provisional (P9; section 11, question 99), and flagged for the owner: a write
  to a cell does not make a cone instance stale that writes that cell and did
  not read it. A cone instance with a static side-write is evaluated again when
  something it read changes, and not because a handler or another cone wrote its
  target. What a cell holds that a cone and a handler both write then depends on
  which of them wrote last, and so on the batch (`scheduler-and-serving-loop.md`
  §5.4). Today's runtime runs the writing computation again.
- **Iteration.** The evaluation step repeats over the stale cone instances
  that are needed for a demanded output until none is left.
- **The bound.** A cone instance is evaluated at most ten times in one
  transaction. The number is ruled as a placeholder and is fixed with the
  plan version (`Plan.version`), because the server and a client have to
  arrive at the same error states from the same plan
  (`scheduler-and-serving-loop.md` §8.1). It is `MAX_ITERS` of
  [Scheduler v2](../scheduler-v2/README.md) (§7.7), the bound on the
  iterations of one pass today. Cone evaluation keeps the count, per cone
  instance and transaction. Provisional (P17): a cone with several value
  functions has a count for each value function of a cone instance
  (`plan-and-label-templates.md` §8, question 173). The right value needs
  measurement on the corpus
  once the write-path analysis says which side-writes are static.
- **Exhaustion.** A cone instance that would need an eleventh evaluation
  fails, with the error state and label of section 1.7. The rule is the one
  `scheduler-and-serving-loop.md` §8.1 and §8.2 state, for a cycle inside
  one instance and for one through links between instances alike. The cone
  instances that read the failed one's outputs fail in turn. Its staged
  side-writes are withdrawn, and their targets keep the values and labels
  they had before the transaction, except that a path of a child's argument
  or of an effect's request takes the error state
  (`plan-and-label-templates.md` §5.2). A cone instance that had read a
  withdrawn value is stale again and is evaluated against the earlier
  value, under its own count. It does not fail because the writer failed.
- **After exhaustion.** A cone instance that failed at the bound is not
  evaluated again until one of its inputs changes, by ruling. Its memo
  entry and its basis rows record the failed evaluation as an evaluation
  (section 3.3). Provisional (P10): the entry is current against what
  is stored when the transaction ends (section 1.7). This differs from today,
  where the remaining work is
  deferred behind a backoff gate and tried again, so that a graph needing
  more than ten iterations still converges. How many patterns of the corpus
  need more than ten iterations today is part of the measurement above.

A cell that a handler factory value may write counts as written by an
unknown handler (`plan-and-label-templates.md` §3.21). It can make any cone
that reads it stale, and the bound above is what limits the effect.

### 2.8 Instances a cone's evaluation makes

A `lift` or a `computed` may instantiate a pattern, by ruling: an inline
`pattern(...)` used as the callee, a named pattern, or a pattern factory
value. The pattern may request effects. A `lift` or a `computed` does not
request an effect directly, by ruling. The instance belongs to the
computation that makes it: to the cone
that runs the body, for the element key and the scope key it is evaluated
for. `plan-and-label-templates.md` §3.14 has the label rules, and
`footprint-analysis.md` §8.1 what the body records. A `computed` that
instantiates a pattern is not promoted (`language-subset.md` §6.1), so the
call is always made by a sandboxed body.

**Today.** A `lift` or a `computed` whose run created builder nodes, a
pattern call among them, has its frame turned into one synthesized pattern
(`patternFromFrame` in `runtime/runner/src/builder/pattern.ts`, called from
`#writeJavaScriptActionResult` in `runtime/runner/src/runner.ts`). The
synthesized pattern runs on one result cell per computation, named from the
computation's `{ inputs, outputs, fn }` record (`resultFor` in
`#instantiateJavaScriptActionNode`). The runner keeps a content hash of the
synthesized pattern per result cell (`#resultPatternCache`). A run that
synthesizes an equal pattern starts nothing. A run that synthesizes a
different one calls `run` on the same result cell, which stops what was
running there and starts the new pattern. A pattern called in the body is a
node of the synthesized pattern, and its result cell is named from its
place in it: the anonymous cells of a synthesized pattern are numbered in
the order they were created (`factoryFromPattern`). Cancelling the
computation releases the synthesized pattern (`releaseChild`).

**In this design** each instantiation is a `Child` of the plan, requested
at a `BodyCall` site of kind `instantiate`.

- **Identity.** By ruling, an instance is identified by the enclosing
  instance, the body's `name`, the calls and callbacks the body is
  written in (its `within`), the site, and the ordinal of the
  instantiation among those this evaluation makes at that site, or, with
  `.for(cause)`, by that cause in place of the ordinal
  (`plan-and-label-templates.md` §1.3). Section 5.5 gives the preimage. A
  site inside a loop makes one instance per iteration, numbered from zero.
  The ordinal is per site, so adding a site renames nothing. When the
  items a loop instantiates for change order, an instance and the state it
  holds go to the item that takes its position. A cause taken from the
  item keeps the instance with the item. For that reason the compiler
  warns, and does not refuse, where an instantiation inside a loop or a
  callback of a function body has no `.for(cause)`
  (`function-body:instantiation-without-cause`, in the catalog of
  `language-subset.md` §10.3). *Assumed,* with that document (its open
  question 26): the warning is reported in a `lift`, a `computed`, an
  `assert`, and an authored function that one of them or the reactive
  tier calls, and not in a `handler`, an `action`, or an inline event
  handler.
- **A re-evaluation names the same instances.** An evaluation that
  instantiates at the same site with the same ordinal or cause names the
  same result cell. The request returns a link to it at once.
- **A read through the link.** The instance outlives the evaluation that
  made it, so a later evaluation that reads through the link finds the
  instance's result. That read is journaled under an entry of
  `Body.handles` that names the site, and is made current at the read
  (section 2.4). In the evaluation that first makes the instance, the read
  finds no value. A read finds the result for the argument that is stored
  or staged when it is made. When the invocation then changes the
  argument, the instance's cones that read it are stale, and when their
  outputs change, the making cone instance is stale through the address it
  read and is evaluated again, under the bound of section 2.7.
- **The argument is written in the same transaction.** Each path of the
  argument is a write edge with target `argument`, which carries the
  body's template or the reference rules of
  `plan-and-label-templates.md` §3.9. The edges belong to the cone that
  runs the body. They are derived writes, so a failed constraint on one
  drops that write alone, and they do not make the body a materializer.
  They are staged when the body's invocation ends, and the instance exists
  once the transaction commits. The first evaluation that makes the
  instance also stages its result document, with the pattern reference,
  the setup record and the `argument` link. A later evaluation stages the
  argument paths whose values differ from what is stored, and nothing
  else.
- **The parameters of an inline pattern.** Where the callee is an inline
  `pattern(...)` written at the call, the values it captures from the body
  are its private parameters. They are stored with the instance, in its
  parameters document (section 4.6), each path bound as a path of a
  handler's state is bound in a function body (section 4.7). A copied
  path holds what the inline pattern's plan reads below its `params` root
  and no more (section 4.6). Each evaluation that makes the instance
  writes them as it writes the argument.
- **When the instance's own cones are evaluated.** After the invocation
  that made it ended, inside the same transaction, when something demanded
  reads the instance's result: by the pull that extends through that
  result, as for any child in the same space. An instance nothing demands
  is not evaluated. When a later evaluation in the same transaction changes
  a staged argument path, the instance's cone instances that read the path
  are stale and are evaluated again, each under its own count toward the
  bound of section 2.7.
- **A changed factory.** When the callee at a site is a factory value and a
  later evaluation finds another factory there, the instance of that site
  and ordinal is torn down and a new one is set up on the same result cell,
  as for a child of the reactive tier (section 4.6).
- **What is stored for it.** The documents of an instance (section 4.1),
  under its own result cell. The enclosing instance stores the link
  wherever the computation's result or a write of it holds it, and one
  record of what the computation made (below).
- **The record of what was made.** The enclosing instance has one **instances
  document** per scope key. For each computation that makes instances, and each
  of its cone instances, it lists per site the result cells the last committed
  evaluation made, each with the identity of its compiled pattern. It also
  lists, per element key, the children an element body has under the key, so
  that the child of a key that left is found (section 2.5). It is written in
  the transaction of an evaluation that makes a different set, and not
  otherwise. It exists so that an instance an evaluation stops making can be
  found after a restart, when the memo is empty. Its label is the
  confidentiality of the making body's template, instantiated, with no
  integrity (`plan-and-label-templates.md` §2.6), and it is a store the runtime
  owns. Where the making cone is an element cone, the document holds one record
  per element key, under the key, and a key derived from a value is the salted
  one (section 5.3). The record of one key carries the label of the one
  position that holds the key (section 2.5, "What is stored per key").
  The set of keys says which
  elements the collection has, so it carries the collection's instantiated
  membership label (`plan-and-label-templates.md` §2.6, "The state of an
  operation inside an element body").
- **Teardown.** An instance that the last committed evaluation made and
  this evaluation does not make is torn down in this transaction. The
  transaction removes it from the instances document and writes a mark
  into the setup record of its result document. The same transaction
  writes the mark for every instance that belongs to the torn-down one:
  its children of the reactive tier, the instances its own computations
  made, and the instances that belong to those in turn. A child of a
  torn-down instance that is reached later through a link some document
  holds is then found marked (`scheduler-and-serving-loop.md` §2.7). A
  marked instance is not loaded: demand that reaches it through a link
  some other document holds evaluates nothing, an event sent to one of
  its streams is not handled, and its effect operations request nothing.
  A reader of such a link reads the values last stored. The documents of
  each marked instance, its parts, its state cells and its operation state
  among them, are retired and are deleted under the rule of section 9.6:
  after the retention period, when nothing read them. An instance made
  with `inSpace` has its result document in another space, which this
  transaction does not write. Its mark is carried there as an authored
  batch, under the principal of the scope key the making cone instance is
  evaluated for, and the serving loop of that space does the scheduler's
  part of the teardown when that commit arrives. The home transaction
  writes the mark of the instance it made and of no other. The marks of
  the instances that belong to it in that space are written by that
  space's loop, because the instances documents that list them are
  there. That is *assumed* (`scheduler-and-serving-loop.md` §9.3 and
  §2.7, and its open question 40). An evaluation that
  fails makes no instance and tears none down: the instances of the last
  committed evaluation stay, and their argument paths take the error
  state (`plan-and-label-templates.md` §3.14; section 1.7). The instances
  of a cone instance that is dropped, because its element key left its
  collection or the enclosing instance was torn down, are torn down with
  it.
- **Made again.** An evaluation that makes an instance under the identity
  of one that was torn down clears the mark and sets the instance up
  again. *Assumed* (section 11, question 33): it finds the state cells
  and operation state stored under that identity, where they were not
  deleted yet. For the state that an element body itself declares
  under a key the ruling of section 2.6 holds instead ("A key that
  left its collection"): it is not deleted, and a key that returns
  reads it. An author who needs a new instance writes a `.for(cause)`
  whose cause differs.
- **What the memo holds.** The memo entry of the making cone instance
  records, per site, the result cells its last evaluation made and the
  compiled pattern of each (`MemoEntry.made`, section 3.1). A cone instance
  whose entry is current is not evaluated, so it writes nothing. A cone
  instance that is evaluated and makes the same instances with equal
  arguments also writes nothing: each argument path is compared with what
  is stored, the set made is compared with the entry's, or with the
  instances document when there is no entry, and an instance that exists
  with the same compiled pattern is not set up again. Argument writes are
  side-writes, so the entry is dropped when the transaction that staged
  them does not commit (section 3.3).

An instance made by a computation is evaluated on a client like any child:
the client's speculative run names the same result cell, because the
identity holds nothing a client cannot derive, unless an enclosing element
key is a salted plain value (section 5.3).

The modifiers `asScope` and `inSpace` apply at such a site as in a handler
(sections 4.6 and 5.6). The step in the other space of an `inSpace`
instantiation that a derivation transaction stages acts as the principal
of the scope key the making cone instance is evaluated for. A later
evaluation that changes the argument of such an instance stages the
changed paths for the other space in the same way, and the mark of a
teardown is carried there as the Teardown item above says. A cone
instance of space scope is evaluated for no principal, so an `inSpace`
request it makes is refused when it is made, and the cone instance fails.
All of this is `scheduler-and-serving-loop.md`'s (§9.3 and §10.3). The
refusal is an assumption there, and its open question 34.

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
  /**
   * The identifier of the label the read consumed, the pointer labels of
   * the slot's chain included. Absent for a read of an element slot, whose
   * label is held with the position of the key.
   */
  readonly label?: Hash;
  /** The read was made with `sample()` and does not make the entry stale. */
  readonly sampled?: true;
}

/** The labels of the element slots at the position that holds the key. */
export interface PositionLabels {
  /** The address the element was read from at this position. */
  readonly position: string;
  /** By slot index: the label identifier resolved at this position. */
  readonly labels: Readonly<Record<Index, Hash>>;
}

/** Why a write the memo holds is not in storage. */
export interface Refusal {
  /** The constraint that failed, by index into `Plan.constraints`. */
  readonly constraint: Index;
  /**
   * The hash of the instantiation key of the write's template under which
   * the constraint failed (`plan-and-label-templates.md` §4.1, step 2).
   */
  readonly instantiationKey: Hash;
}

/** One instance an evaluation made (section 2.8). */
export interface MadeInstance {
  /** The identifier of the instance's result cell. */
  readonly result: string;
  /** The identity of the compiled pattern it runs. */
  readonly compiled: Hash;
}

/** The memo entry of one cone instance. */
export interface MemoEntry {
  /**
   * The slots the evaluation read, by slot index. The entry of a slot of
   * root `index` has the address of the array the collection
   * iterates, the class `value`, and a fingerprint of the position, so
   * it differs when the key stands at another position.
   */
  readonly slots: Readonly<Record<Index, ReadFingerprint>>;
  /** For an element cone: the record of the position that holds the key. */
  readonly position?: PositionLabels;
  /**
   * Reads through handles and links, by index into `Plan.dynamicReads`, in
   * the order they were made.
   */
  readonly dynamic: Readonly<Record<Index, readonly ReadFingerprint[]>>;
  /**
   * The upstream outputs the evaluation pulled, by output index, each
   * with the fingerprint of its value. An output the cone reaches only
   * through picks has no entry here. Provisional (P22): for a collection
   * that the cone placed and did not observe, the fingerprint is that of
   * the collection reference.
   */
  readonly upstream: Readonly<Record<Index, string>>;
  /**
   * For each choice point whose `pick` has an output as its `from`, by
   * index into `Plan.picks`: the fingerprint of the child chosen there,
   * or of the absence of one.
   */
  readonly picked: Readonly<Record<Index, string>>;
  /** What the cone's function returned, or the error state it took. */
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
  /**
   * The instances the evaluation made, by the name of the `Child` the site
   * instantiates, in the order they were made.
   */
  readonly made?: Readonly<Record<string, readonly MadeInstance[]>>;
  /** The transaction that staged the cone's side-writes, if it made any. */
  readonly wroteIn?: string;
  /**
   * Kept outputs, by output index, and write edges, by index into
   * `Cone.writes`, whose value or instantiation key storage does not hold,
   * with the refusal where a failed constraint dropped the write.
   */
  unstored: {
    readonly outputs: Readonly<Record<Index, Refusal | null>>;
    readonly writes: Readonly<Record<Index, Refusal | null>>;
  };
  /** Whether something the entry records as read was reported changed. */
  marked: boolean;
}
```

The entry holds everything a later transaction needs to decide that the
cone instance is current and everything a consumer needs from it: its
output values, the values of its side-writes, its selections and picks, and
the label identifiers its reads consumed. The last is what lets the
preparation form an instantiation key for a kept output without resolving a
label again. For an element cone the label identifiers of the element slots
are held with the position that holds the key, so that the instantiation
key is formed from the labels at that position's addresses.

The trigger reads of a `dynamic` node are not in the entry. They are part of
the scheduler's instance record, which is not dropped while something
demands the instance (`scheduler-and-serving-loop.md` §3.4).

Two further memos exist beside it.

- **The label memo** of `plan-and-label-templates.md` §4.3, keyed by
  template hash, selections and slot label identifiers. It is shared across
  instances and patterns.
- **A body memo**, optional. A body with no handles, no writes and no calls
  is a function of its argument, so its result may be memoized by
  `Body.code` and a hash of the argument, across cone instances and across
  instances. Equal arguments in two cone instances then cost one call of
  such a body.

### 3.2 Keys and fingerprints

An entry is keyed by:

1. the identifier of the instance's result cell and the space it is in;
2. the identity of the compiled pattern (`CompiledPattern`), so that no
   entry survives a pattern update;
3. the scope key the cone instance was evaluated for;
4. the cone's index in the plan;
5. the element keys of the enclosing element bodies, outermost first.

These are the key parts of a basis row
(`scheduler-and-serving-loop.md` §10.4), with the element keys added.

A read's fingerprint is the version of the scope instance of the document
the read went to, together with a comparison of what the read returned at
its path and class. The version alone would make a cone instance stale on
every write to the document, including writes to paths the cone does not
read. The comparison is what gives the cutoff of section 2.6. Stored values
are immutable, so the comparison is by reference where the replica shares
structure and by hash otherwise. A slot whose path crosses links has one
fingerprint over the chain and the bound address: a change at an address
of the chain rebinds the slot and changes the fingerprint. A slot whose
path holds `*` is bound at one address per child the path reaches, each
with a chain of its own (`plan-and-label-templates.md` §2.5). Its
fingerprint is over the container's children and over the chain and the
bound address of each, so a change of the children rebinds the slot and
changes the fingerprint as well.

### 3.3 Invalidation, and writes that did not reach storage

- **Marking.** When the scheduler reports a dirty or a label-dirty slot, or
  a change at an address a `dynamic` node read, the runtime marks the
  entries of the cone instances whose last evaluation read that address.
  A read made with `sample()` is not marked. Marking is all that happens
  outside a transaction.
- **Checking.** When a marked entry is needed, the runtime reads the marked
  addresses again and compares fingerprints. If none differs, the entry is
  current again and nothing is evaluated. A write to a path the cone does
  not read ends here. If only the label identifier of a read differs, the
  entry's values stay, its label identifiers are updated, and the kept
  outputs that depend on it get a new instantiation key in the
  preparation: a label changes without an evaluation
  (`plan-and-label-templates.md` §4.1, the second condition).
- **Upstream.** An entry is not current when an upstream output it pulled
  has a different value from the one recorded. The check is made when the
  entry is needed, after the upstream cone instance has been brought up to
  date. Provisional (P22): for the assembled result of a per-element
  construct that the cone placed and did not observe, the value recorded
  is the collection reference, which no change of a row and no change of
  membership alters, so the entry stays current and the assembly is not
  brought up to date for the check (section 2.2, "A collection that a
  cone places"). An upstream output that the cone reaches only through
  picks, which
  the plan shows, is compared by the children the picks chose and not as a
  whole: the entry records, per choice point, the fingerprint of the chosen
  child (`MemoEntry.picked`), and the entry is not current when the child
  at a chosen key differs from the one recorded. A change of another child
  of that output, or the addition of one, leaves the entry current. This
  is what keeps a row that picks its own entry of a record the instance
  computed from being evaluated when another row's entry changes (section
  10.1).
- **A transaction that does not commit.** An event's transaction does not
  commit in four cases: it is rejected by a constraint on the handler's
  own writes; it is aborted because the body threw or the handler read a
  failed cone instance; its attempt is withdrawn at a journaled read, so
  that an instance can be loaded or a materializer run (section 1.4); or
  the event is requeued whole at the wave's commit
  (`scheduler-and-serving-loop.md` §5.5). In each, nothing it staged is
  stored. An entry of a cone instance that staged no side-write keeps its
  values, because they are pure derivations of state the transaction did
  not change (`plan-and-label-templates.md` §5.4). Its kept outputs are
  recorded as unstored. An entry whose cone instance staged side-writes or
  made instances is dropped: the writes did not happen, and a later
  evaluation has to perform them. A handler of the batch that then reads
  such an unstored output by address reads the entry's value, which is
  staged from the memo before the read (section 1.3).
- **A derived write withdrawn before the preparation.** When a handler
  body wrote something a cone instance evaluated before the body had read,
  the derived writes of that cone instance that were not instantiated
  early are withdrawn (section 1.6). The body's write marks the entry, so
  the cone instance is stale. Where one of the withdrawn writes is a write
  edge of the cone, the entry is dropped, so that the evaluation behind
  the batch performs the write.
- **A write unstaged with a dropped write.** A cone instance that had read
  a write that a constraint dropped after a handler body has its staged
  writes unstaged with it (section 1.7). The cone instance is stale, and
  the derivation transaction behind the batch evaluates it against what is
  stored. Where one of the unstaged writes is a write edge of the cone,
  the entry is dropped.
- **A dropped derived write.** When a constraint drops a kept output's
  write, storage keeps the value, the label and the provenance record of
  the commit before, and those three agree with each other. The entry keeps
  the value the evaluation computed and records the output as unstored,
  with the refusal. A consumer inside the instance that pulls the output
  receives the entry's value, and its own outputs are checked against their
  own constraints. A consumer that reads the output through its stored
  address reads the stored value and resolves the stored label. The same
  holds for a dropped write edge of a cone: the entry keeps the value the
  cone's function returned for the side-write, and the target keeps what is
  stored.
- **A withdrawn derived write.** When a conflict withdraws a derived write
  at the commit, the write is recorded as unstored. Where the conflict was
  on something the cone instance read, the change that caused it arrives
  through the change channel and marks the entry, so the cone instance is
  evaluated again. Where it was on the target alone, the entry stays
  current. An entry whose side-write a conflict withdrew is dropped, so
  that a later evaluation performs the write.
- **Storing what is unstored.** A transaction that demands an unstored kept
  output stores it from the entry without running value code, by the third
  condition of `plan-and-label-templates.md` §4.1, and section 3.5 adds the
  entry's reads to that transaction's read set. An unstored write that
  carries a refusal is the exception. The refusal records the
  instantiation key of the write's template under which the constraint
  failed (`Refusal.instantiationKey`), for a constraint that lists slots
  and for one
  that lists none, such as writer-fit or a write floor
  (`plan-and-label-templates.md` §4.4). The write is not attempted again
  while the key its template forms is the recorded one, since the verdict
  would be the same, and it is attempted again when the key changes. A
  change of a label the template reaches changes the key, and the write
  is instantiated again from the entry's value, without an evaluation. A
  change of value makes the cone instance stale, and it is evaluated.
- **What the scheduler is told.** For every write that did not reach
  storage, the scheduler does not advance the basis rows of the cone
  instance, so that after a restart, when the entry is gone, the cone
  instance is found stale and evaluated again
  (`scheduler-and-serving-loop.md` §10.4). It records a refusal with the
  instance (`plan-and-label-templates.md` §4.4, which has the same two
  states: the cone instance is current and its output is unstored).
- **A failed cone instance.** Its entry holds the error state and the reads
  made up to the failure. It is current until one of those reads changes.
  Provisional (P10): for a cone instance that failed at the bound, the
  entry is current against what is stored when the transaction ends, after
  the withdrawal of its side-writes (section 1.7).
  The failed evaluation advances the basis rows like any evaluation.
- **Removal.** Entries are dropped when their element key leaves its
  collection (section 2.5), when the instance is released or torn down,
  when the compiled pattern changes, and under memory pressure in any order
  the runtime chooses. Dropping an entry that has unstored writes loses
  nothing: the basis rows were not advanced for them.

### 3.4 Lifetime, and what is current after a restart

The memo lives in one process. It is not written to storage, not sent to
another runtime, and not shared between a client and the server. A server
process that restarts starts with no entries. A client keeps its own.

After a restart, or when an instance that was released is loaded again,
there is no entry to mark. Which cone instances are current in storage is
then the scheduler's knowledge: it marks the stale cone instances from the
basis rows of `scheduler-and-serving-loop.md` §10.4, which record, per
instance, cone, scope instance and input document, the sequence number of
the input at the cone's last evaluation. A cone instance whose rows are at
the heads of its inputs is current in storage: its kept outputs are read
from the documents that store them and are not evaluated, and its interim
outputs are evaluated only when a stale consumer pulls them. A cone
instance whose rows are behind, or that has none, is stale.

The same rows answer a read of something an instance that is not loaded
wrote, by ruling. A read whose writer is in such an instance returns the
stored value where the rows of the writing cones, and of what they depend
on, are at the heads of their inputs, and the instance is not loaded on
account of the read. It is loaded on account of the read only where the
rows are behind (sections 1.4 and 2.4;
`scheduler-and-serving-loop.md` §10.4, "A read answered from the rows").
Standing demand that reaches the instance through the address the read
registered loads it all the same, whether or not the stored value is
current (§4.4 there). That is *assumed*, as question 56 of the
continuation plan has it. A handler's reads hold demand for the length
of the event's transaction only (§2.5 there), so a read by a handler
leaves the instance unloaded where the stored value is current.

Two kinds of document are not attributed to a writer by that check when
the writing instance is not loaded, and a read of them returns what is
stored: a cell an instance writes through a handle, and a child's
argument document. Nothing stored leads from either to the instance that
writes it (section 4.6; §4.4 and §5.3 there).

The runtime does not derive this from the commit that last wrote the result
document. That commit says nothing about a cone instance that was stale and
not demanded when another cone instance of the same instance was written,
nothing about a cone instance that was evaluated and wrote nothing because
its output was equal, and nothing about an input in another space.

The basis rows are per cone, and an element cone has one cone instance per
element key. *Assumed:* the row of one element's document is replaced when
that element's key is evaluated, as §10.4 there says, so that after a
restart the stale element keys of a collection are found from the rows and
the other keys are not evaluated.

### 3.5 Never a source of truth

Every value in the memo can be recomputed from stored slots, the plan and
the value code. The rules that keep it that way:

- A memo entry is never read by a transaction of another process and never
  decides what another runtime sees.
- A commit writes values and labels that were computed in its own
  transaction or taken from entries that are current. When a transaction
  writes a value that came from a memo entry, directly or through a
  consumer, the runtime adds the entry's reads to the transaction's read
  set at the versions the entry records, attributed to the units of the
  writes that used it (section 1.9). A write elsewhere that moved one of
  them then withdraws those derived writes, and requeues the event when
  the handler itself read the value, as it would for a fresh evaluation.
- Dropping any entry at any time changes what is evaluated and never what
  is committed.
- A client's memo holds values computed over its speculative view. They
  carry the fingerprints of that view and stop being current when the view
  is replaced. How a client reconciles is in
  `scheduler-and-serving-loop.md` §11.6.

## 4. The keep set and the layout of a result document

### 4.1 The documents of an instance

An instantiated pattern has the following documents and no others. "Scope"
says how many scope instances exist.

| Document | Holds | Identifier | Scope instances |
| --- | --- | --- | --- |
| Result document | The kept outputs that are not stored in a part document, their labels, their provenance, and a storage link in the place of each part | The result cell's, assigned when the instance is created | The space's, and one per user or session that a kept output of that scope was evaluated for |
| Part document | One kept subtree that the rule of section 4.10 stores by itself, with its labels and provenance | Section 4.10 | As the result document |
| Chunk document | One contiguous run of the entries of an array that is too large for one document, with the labels and provenance of the run (provisional, P20) | Section 4.10 | As the result document |
| Argument document | The instance's argument, as the creator wrote it. An array in it that is too large for one document is stored in chunk documents (section 4.10; provisional, P26) | Derived from the result cell, linked from it | As today |
| Parameters document | The private parameters of an instance whose callee is an inline pattern written at an instantiation in a function body (section 4.6) | Derived from the result cell, linked from it | As the argument document |
| State cell document | The value of one state cell. An array in it that is too large for one document is stored in chunk documents (section 4.10; provisional, P26) | Section 5.2 | By the cell's declared scope |
| Operation state document | The durable state of one aggregate, `reduce`, index, effect, `wish`, forced cache or materializer. For an effect it includes the stored request, for a `wish` the stored operands, and for a `reduce` the initial value (`plan-and-label-templates.md` §3.13 and §3.19, where the last two are assumptions) | Section 6 | By the scope of the operation's cone instance |
| Cache document | The entries of cones the runtime promoted | Section 8.4 | One per scope the promoted cones have |
| Binding state document | The state of a binding made in a function body: the copied paths, and a link for each cell and each container bound by reference | Section 5.5 | The body's |
| Output document | One interim output that is a plain array generated from scratch and has to have an address, because a per-element construct is over it or it is given whole to an instance of its own (section 2.5). *Assumed* (`plan-and-label-templates.md` §8, question 157) | Section 5.2 | By the scope of the output's cone instance |
| Scoped value document | The value of one output of narrower scope that a cone of the space places, under the element keys of its cone (section 1.8). *Provisional* (P454) | Section 5.2, of the output and the element keys | One per scope key that evaluated the value; none of the space |
| Instances document | Which instances the evaluations of the instance's computations made | Section 2.8 | One per scope the making cone instances have |
| Stream document | The entries of the events appended to one stream, and the stream's `eventWatermark`. It exists once the stream received an event (section 4.7) | The stream's identifier (sections 5.2 and 5.5) | As today |

**When a state cell's document is written.** A state cell has no
document until something writes it (section 4.5). By ruling that holds
for a cell whose declaration gives it a first value that is a constant:
the constant is the default of the cell's schema, nothing is written
when the cell is created, and a read of the cell reads the default
(section 2.2; `plan-and-label-templates.md` §1.3). A handler's
`set(...)`, or a side-write of a cone, is what first writes such a
cell. Writing the constant at creation as well is legal and is not
what this design does.

By ruling (2026-11-20) a cell whose schema declares a label is the exception: it
has a document from the start. A label is stored with a document, so the
constant is written under the cell's schema when the cell is created, and the
document stores the label that the schema declares
(`plan-and-label-templates.md` §1.3). The owner's reason: a state cell that gets
a document is no problem in general, and what this design avoids storing is the
intermediate values. The prototype's executor does so (`Instance.stateCell` of
`base/pattern-compiler/exec/executor.ts`), and leaves a cell without a document
where the schema holds a declared label as the text of its type, which no store
takes. The rule is the same for a state cell of an element body in each of the
three cases of a per-element source.

While such a cell has no document, a read at any path of it reads the
default at that path. A write of the whole value makes the document,
also where the value equals the default. A write below the root has to
start from something: `draft.key("text").set("x")` on a cell whose
default is `{ text: "", tags: ["new"] }`, or a `push` onto a cell
whose default is an array that is not empty. A document made from the
written path alone would have `tags` read as nothing afterwards. By
ruling the runtime creates the document from the default and applies
the write to it, so the members the write did not name are stored from
then on, and `tags` stays readable. The members taken from the default
keep the label of a default, with the empty integrity, and the written
path has the label of the write (`plan-and-label-templates.md` §1.3).
The rule is the same for a state cell of an element body, in each of
the three cases of a per-element source.

A first value that is not a constant is computed by a cone and written
once, through the write edge that `StateCell.first` names, and the
document exists from that write on. *Assumed* (question 83): the edge
is performed in the first transaction that evaluates the cone instance
that computes the value, and only where the cell has no document, so a
value that a handler wrote before that evaluation stays. The cone is of
the first kind of section 2.3, so it is demanded when something
demanded reads the cell or passes it on, and a handler that reads the
cell has it evaluated before the body runs (section 1.4). For a cell of
an element body the cone instance is that of the element key, in each
of the three cases of a per-element source. The prototype's executor
does the alternative of question 83: it computes the value when it
creates the cell, which for a cell of an element body is when the key
enters the element table.

By ruling the edge always stores the value the cone computed, and
never a reference, so that a write to the cell never lands in the
input. Where the declaration gives the cell an input whole, as
`Writable.of(start)` does, the rule that a value passed on unchanged is
stored as a reference (section 2.4) would store a link to the input.
The edge of a first value is the exception to that rule: the runtime
stores the value the reference resolves to when the edge is performed.
*Assumed* (question 87): a member of the value that is of data type
and carries the address it was read from is stored as a value as
well, because a write below the root of the cell would otherwise land
in the input, and a member of handle type is stored as the link its
type declares. The rule is the same for a cell of an element body in
each of the three cases of a per-element source. Where the first value
is the element itself, the cell holds the element's value: over an
array of references the value behind the link, and over an array of
plain values in place the value, and no reference to the element
(section 2.6).

The compiled path therefore stores fewer state cell documents than a
runtime that writes every first value. The prototype's executor keeps
the rule for a constant first value: it writes nothing when it creates
such a cell, a cell whose schema declares a label excepted, and the
first write makes the document. Over its corpus
run 98 state cells have a document after the scenario, where an
executor that wrote every first value stored 898. The run of today's
runtime it is compared with has the document of every state cell of
the pattern's body once the instance has settled.

A cell or a child instance that a handler of the instance created is not
one of the instance's documents. It is reached through whatever link the
handler stored. The state document of an effect a handler requested is
not one either, and it holds a back-link to the instance (section 6.4).
An instance a computation made is listed in the instances document and
has documents of its own. The allocation record of a space an `inSpace`
request creates is a document of the calling space and of no instance
(section 5.6).

Two kinds of shared, immutable document are referenced: schema documents
and label documents, both under `cid:` identifiers
([content-addressed CFC labels](../content-addressed-cfc-labels.md)), and
the compiled pattern's plan and value code, by content address.

### 4.2 The result document

The keep set of an instance is every output path reachable from its result
cell, the rendered tree under `[UI]` included. The keep set is stored in as
many documents as serve its readers: the result document and the part
documents of section 4.10. Together they hold the result. At each kept path
the document that stores the path holds one of four things.

| What the output is | What the path holds |
| --- | --- |
| A value the instance computed, stored in place | The value |
| A value the instance computed, stored in a part document | A storage link to the part document (section 4.10) |
| A reference passed through: a state cell, a part of the argument, a cell an element links to, a cell a body created, a child's result, a stream | A link to that address. The target keeps its own label (section 4.3). A state cell of the instance, and a position of the argument that the result returns as a member or whole, is held as a write redirect (below) |
| An output of narrower scope than this scope instance | A storage link to the same document and path in the narrower declared scope (below) |

**A state cell or an input the result holds.** *Provisional (decision
P470 of the prototype):* the link at a path of the result to a state cell
of the instance is a write redirect, and carries the cell's schema, as
today's runtime stores a cell a pattern returns (`getAsWriteRedirectLink`
in `runtime/runner/src/cell.ts`). So is the link to a position of the
argument that the result, or a row of it, returns as one of its members
or whole, as today's runtime holds an input a pattern returns as an
alias. A link inside a member, as a child of a view node, stays a plain
link, as today's view nodes hold one. Another pattern's handler that
writes through such a path, on today's path or as a compiled piece,
writes the cell or the argument: a write follows a write redirect at its
position and replaces any other link there (section 2.4, "What a handle
names"; `normalizeAndDiff` in `runtime/runner/src/data-updating.ts`). A
write through the path of a protected input is then checked against the
input's policy, as today. The schema gives a reader through the link the
cell's default where the cell has no document yet, as for a cell whose
first value is a constant (ruling Z3), and not where the link leads to a
reference by key that no position holds: that reads as nothing (section
2.5). The first write of such a cell by another writer makes its
document, and the instance takes that write as it takes a later one.

**The paths of the rendered tree.** The rendered tree is stored under
the key `$UI` of the result, the string the API's `UI` constant holds
(`base/api/index.ts`). A node of it is a view node, the record the JSX
factory returns (`h` in `runtime/runner/src/builder/h.ts`), and it is
stored with the paths of that record: `type` and `name`, which are
constants, `props/<attribute>` for the value of each attribute, and
`children/<n>` for the child at position `n`. By ruling a collection
among the children of a view node, the assembled result of a `map`
among them, is stored as one nested child, as the runtime of today
stores the result of a `map`: the collection is the child at the
position `n` it is written at, and its elements are at
`children/<n>/*`. The children array is not stored flat. A child
written after the collection is at the static position that follows
it, and two collections among the children of one node are two child
positions. That holds for a collection over an array of references,
over an array of plain values in place, and over the result of
another per-element construct. An array literal that the author
writes among the children is not such a collection: its members are
written out among the children when the tree is built, as the JSX
factory does today (`children.flat()` in `h`), and each has a child
position of its own. By ruling a spread child, `{...xs}`, and an
array literal among the children that itself has a spread or a hole
are each one child at the position they are written at, the second
stored as one nested array value, so every child written after one
has a static position. That is the same for `xs` an array of
references, an array of plain values in place, and the result of
another per-element construct. A `map` over
an array that is written in place in the pattern body is a collection
over plain values in place and is one nested child as well; by the
prototype's comparison the runtime of today holds the elements of
such a `map` as children of their own. These are the paths
`plan-and-label-templates.md` §3.4
gives the entries of `Plan.outputs` for a JSX element, and the paths a
label entry, a provenance record and a split point of section 4.10 are
named by. A link to the stream of a binding is stored at the same paths,
where value code placed the stream (section 2.2): an event attribute of
the first child of the root is `$UI/children/0/props/onClick`. For a
binding in an element body, each element of the collection holds the
link to the stream of its own element key, below the child position of
the collection: the row at position `i` of a `map` that is the first
child of the root holds it at `$UI/children/0/<i>/props/onClick` (that
document's §1.1, "A stream of a binding of an element body"). The value
function puts the marker of `host.stream` at the position, and the
runtime stores the link in its place (section 2.2). No record of the
plan names these positions.
Where the callback writes the stream of a binding made outside it, the
binding has one stream and every position of the collection holds a
link to it. A child position whose value is the result of a pattern
compiled into the plan holds the callee's tree in place, with no `$UI`
level between the position and the tree's paths (its §1.1). An element
of an assembled collection is no child position, also where the
collection is a child of a view node: where the callback returns the
result of a pattern, the element is that result, with the callee's tree
below `$UI`, as `$UI/children/0/*/$UI/props/onClick`. These rules are
the same for a collection over an array of references, over an array
of plain values in place, and over the result of another per-element
construct. That document assumes the paths of a view node
(its §8, question 53: how fine the entries are, and that the paths of a
view node are part of the plan),
and this document assumes the same paths with it. The alternative there
keeps one entry per constructed value and changes the records, not the
stored paths.

A reader of a computed kept output names the result cell and the output's
path, whichever document stores the path
(`plan-and-label-templates.md` §2.3). There is no document per kept output:
a part document holds a subtree, with every kept path inside it, and a
subtree below the size the rule sets has none.

The fourth row is how a space-scoped document contains per-user and
per-session values. The link from a broader scope instance to a narrower
one is written by the runtime and held by no pattern code. It is a
storage link, with the four properties `plan-and-label-templates.md` §2.3
gives a storage link, and everything that resolves a path passes through
it as through the storage link of a part (section 4.10). It differs from
that link in what it holds. *Assumed:* its stored form is the storage
link's (section 4.10) with a declared scope, `user` or `session`, and
nothing else. It holds no document identifier and no path, because the
document and the path it names are the ones it is stored at, no schema,
and no user or session identifier. The reader's runtime resolves it to
its own scope instance of that scope
([scoped cell instances](../scoped-cell-instances.md)). The scope instance
of a document for a user or a session holds only the paths of that scope.
Where a path of narrower scope is a split point that is stored in a part,
the broader scope instance holds the link of this paragraph, and the
narrower scope instance holds the storage link to the part.

The scope a cone instance has at run time can be narrower than the plan's
(section 1.8), so whether the space's scope instance holds a value or
such a link at a path can depend on data. §5.5 of that document lists
what the presence of the link shows.

A kept collection is stored as an array at its path. Positions are array
indexes, so an insertion or a reorder changes which index a row is stored
at even though no row is evaluated. The write is a `splice` of the stored
array (`PatchOp` in `runtime/memory/v2.ts`), not a rewrite of the document.
What moves is a storage link where the row is a part, and the row's value
where it is stored in place. Where the array is stored in chunks
(section 4.10; provisional, P20), the `splice` is of the run of one
chunk, no stored document holds a position, and the rows of the other
chunks are not written.

The root of the result document holds, beside `value`:

- the `argument` meta link, as today (`META_FIELDS` in
  `runtime/runner/src/meta-seam.ts`);
- the pattern reference (`patternIdentity`) and the setup record, which name
  the compiled pattern the stored layout was written by (section 7.1), and
  which hold the mark of an instance that was torn down (section 2.8);
- the carry-over record of a migrated instance (section 9.3);
- the `cfc` envelope, with the label map (section 4.3) and the provenance
  records (section 7) of the paths this document stores.

It does not hold the manifest of internal cells that today's `internal` meta
field holds. The plan lists the state cells, and section 5.2 derives their
identifiers.

### 4.3 Where labels live

Labels live in the envelope of the document that stores the path they
label, at the reserved `cfc` member of the document root
([the stored CFC envelope](../cfc-stored-envelope.md)). Each kept output
path contributes the entries `plan-and-label-templates.md` §2.3 lists: a
`value` entry, a `shape` entry frozen at the path's creation, and for a
kept collection an `enumerate` entry at the container and `*`-child
entries.

- **Labels are held by content address.** An entry keeps its path, origin
  and class inline and holds its label as a reference to a `cid:` label
  document when the label's canonical form exceeds `CFC_LABEL_INLINE_LIMIT`,
  128 bytes, and inline otherwise. The instantiation key of section 1.6
  uses the label's hash in either case.
- **One entry per path, shared where labels are equal.** When every element
  of a kept collection instantiates to the same label at a path, one
  `*`-child entry in the document that stores the array covers every
  position, and appending an element adds no entry there. When positions
  differ, there is no `*`-child entry at that path, and each position has
  its own entry at its index path (`plan-and-label-templates.md` §2.3).
  Those entries are positional and are rewritten when the positions move.
  A row that is a part document also carries the entries of its paths in
  its own envelope, where they do not move with the position (section
  4.10).
- **A path whose template has no label has no entry of its own.** A kept
  path whose template is `const`, such as the static structure of a
  rendered tree, contributes no entry at its path. The root entry below
  covers it.
- **The atom of the pattern is one entry at the document's root.** Every
  kept output carries the `TransformedBy` atom that names the pattern of
  the instance, with no condition
  (`plan-and-label-templates.md` §3.2, "The atom of the pattern"). The
  atom is the same at every kept output of an instance, so the envelope of
  the result document and of each part document, in each scope instance,
  holds it once, in one entry at the document's root. The entry applies
  at every path the document stores, and no entry at a path repeats the
  atom. *Assumed,* with that document (its §8, question 71). By ruling
  (that document's §8, question 177), every commit of a compiled pattern
  is prepared when the experimental option is on, a commit that reads no
  labeled data included, so every document of the keep set it writes holds
  the entry. Not yet built: the build prepares only the commits that read
  labeled data.
- **For a value passed on by reference the atom is in the label of the
  content at the output path.** A kept path that holds a link to another
  address (section 4.2) is covered by the same root entry. By ruling
  (2026-11-20; that document's §3.2, "Where the atom of a kept output is
  stored") the atom is joined onto the content there, with no scope: it
  is in the label that a read of the value at the path consumes, so a
  read through the link takes it beside the integrity of the target.
  Nothing is written to the envelope of the document the link names: the
  target keeps its own entries, and a reader that reaches it through
  another reference does not take the atom (what the ruling leaves open
  is its §8, question 72).
- **Each scope instance has its own envelope**, holding the entries of the
  paths that scope instance stores.
- **Declared entries are unchanged.** They come from the result schema, and
  are stored with the document that stores the path.

State cell documents, operation state documents and binding state documents
carry their labels in their own envelopes, as documents do today.

**What a later write does to the entries of a path.** A write to a path
that holds a value replaces the `value` entry with the instantiated
template of that write and keeps the `shape` entry, which holds the label
under which the path was created. That holds for a kept output and for a
path that a write edge targets, in a state cell document or in the
document of a cell reached through a handle
(`plan-and-label-templates.md` §2.3, "A path that a write edge targets").
A write that removes a path and creates it again in one transaction
replaces the `shape` entry with one minted from its own label. *Assumed*
(section 11, question 76): a write that removes a path and does not
create it again leaves the `shape` entry of the path, and of each path
below it, in the envelope until the path is created again, as
`prepareBoundaryCommitSteps` in `runtime/runner/src/cfc/prepare.ts` does
today. The entry then labels no stored value, and a read of the container
above consumes it.

### 4.4 A link to another instance's output

A link to an output of another instance is a link to that instance's result
cell at the output's path: space, document identifier, path, and a declared
scope where the output has one. This is the link a consumer holds today.

**A stored link holds a schema.** Every link an instance writes for a
path bound by reference holds, beside the address, the schema of the
place it names, as the plan of the writing instance declares it, the
default of that declaration included. That is the case for a link in a
child's argument document, in a parameters document, in a binding state
document, and for a link a body stores for a value it passes on
unchanged. The schema is part of the stored link, as it is today
(`CellLinkRefPayload` in `runtime/runner/src/sigil-types.ts`), and it is
no part of the link's identity: two links to one address with different
schemas name one cell. By ruling, a default belongs to the stored place
and reaches a reader through this schema. A read that crosses the link
is validated against the reader's schema, and where nothing is stored at
the target it gives the default of the link nearest the target whose
schema declares one, or the reader's own default where no link declares
one (section 2.2). Nothing is written at the target by such a read: the
place stays empty until a write stores a value there, and every reader
then reads that value. Today the reader's schema governs a read that
crosses a link, and the default is taken from the last link crossed that
declares one (`combineSchemaForLink` in `runtime/runner/src/traverse.ts`).
What changes is what it reaches. Today the path holds a link to the node
document that holds the value, so a read is two hops and consumes the
pointer labels of both links. In the compiled layout the path holds the
value, in the result document or in a part document behind storage links.
A storage link carries no label and is not a reference, so the read
consumes the pointer label of the one link and the entries at the output's
path.

In the consumer's plan such a read is a slot whose path crosses the link,
wherever the plan names the path: an argument path that holds the link, a
path below a handle the instance was given. The link's address is on the
slot's chain, and the slot is bound to the producer's output
(`plan-and-label-templates.md` §2.5). The read is a `dynamic` template only
where the plan cannot name the path, as for a reference the consumer
computed (`plan-and-label-templates.md` §3.10). The pull that extends
through the link, and the watch on the chain, belong to
`scheduler-and-serving-loop.md`.

### 4.5 A sub-pattern compiled into another

The body of a `map`, an inline pattern, and a call of a statically resolved
pattern in the reactive tier are compiled into the enclosing instance
(`plan-and-label-templates.md` §1.1). Such a sub-pattern stores nothing of
its own:

- It has no result cell, no argument document, and no pattern reference.
  Its argument is expressions of the enclosing instance.
- Its outputs that the enclosing result reaches are kept outputs of the
  enclosing instance, stored at the paths where the enclosing result holds
  them. A subtree among them can be a part document of the enclosing
  instance, by the rule of section 4.10. Its other outputs are interim and
  are not stored.
- A state cell it declares is a state cell of the enclosing instance, named
  with the call site and the element keys in its cause (section 5.2). The
  cell's document is written when the cell is first written (section
  4.1).
- A durable operation it declares is an operation of the enclosing plan,
  named the same way.
- A handler it binds is a binding of the enclosing plan (section 4.7).

If every output of such a sub-pattern is consumed by further computation
and it declares no state and no operation, it adds no document and no path
to anything stored.

Provisional (P18). The plan holds a pattern that a call or a tag names once, and
each call as a call-site record (`plan-and-label-templates.md` §1.1). Nothing
above changes with it. What exists once for each chain of call sites, and for
each combination of element keys on that chain, is what the list above names:
the cone instances with their memo entries and basis rows, the kept outputs at
the paths that the call-site records give, the state cell documents, the
operation state documents, the streams and the children. The identifier of each
holds the names of the call sites of its chain, as section 5.2 has it for one
call site. That is the same for a call in an element body over an array of
references, over an array of plain values in place, and over the result of
another per-element construct: the three differ in how the key of an element is
formed (section 2.5).

### 4.6 Child instances

A `Child` is a pattern with a plan of its own: a pattern received as a
factory value and called in the reactive tier, any pattern a function
body instantiates, or a pattern that the author calls through
`asInstance()` or `inSpace(...)` in the reactive tier
(`plan-and-label-templates.md` §3.15).

- **Its documents** are the kinds of section 4.1, under its own result
  cell. The parent and the child share nothing but the child's argument
  document, which the parent writes, and the child's result, which the
  parent reads.
- **The argument is part of the parent's keep set.** Each argument path is
  written with the template the parent's plan gives it. A computed value
  passed to a child is therefore stored, in the child's argument document,
  even when the parent would not otherwise keep it. The argument document
  derives from the child's result cell and holds no link to the instance
  that writes it. A child that is loaded while that instance is not
  therefore reads a computed argument path as stored, without a check of
  the writer's basis rows, like a cell written through a handle
  (`scheduler-and-serving-loop.md` §4.4 and §5.3). An argument path that
  is bound by reference holds a link with the schema of the place it
  names (section 4.4), so the child reads the default of that place
  where nothing is stored there. Where the child declares a handle at a
  path that holds a value, the handle names that path of the argument
  document. A write through it is stored there, and the next evaluation
  of the parent's cone that writes the path replaces it
  (`plan-and-label-templates.md` §3.15, "A handle to a path of the
  argument").
- **A child in the reactive tier** has a result cell named from the
  enclosing instance and the call site (section 5.2). When the factory at
  the slot changes, the runtime tears the old child down and sets up the
  new one on the same result cell. The new child's kept outputs replace the
  old ones at their paths. The old child's state cells are found again
  where the new plan declares a cell under the same name, and are otherwise
  left unreferenced. A child inside an element body has the element key
  as a step of `within`, so each occurrence of an element has a child of
  its own (section 2.5, "Children of an element body"). A factory that is
  itself the element, as in
  `factories.map((F) => F({ ... }))`, is the element part of the key:
  another
  factory at the position is another key, so the earlier child is torn
  down and the new one has a result cell of its own.
- **A child called through `asInstance()`** is such a child of the
  reactive tier, also where its callee is statically resolved: the
  callee is not compiled into the enclosing plan, and the child has
  the documents of section 4.1 under its own result cell. Inside an
  element body it is not torn down when its key leaves the collection,
  and it is the same instance when the key returns (section 2.5,
  "Children of an element body"), over an array of references, over an
  array of plain values in place, and over the result of another
  per-element construct. *Assumed*, with `language-subset.md` §13,
  question 42: outside an element body the modifier has the same
  meaning and nothing else follows from it.
- **A child a handler requested** has a result cell named from the handling
  and the request's ordinal, or, with `.for(tag)`, from the handler's
  instance and the tag, so that every event names the same child and
  only the first creates it (section 5.4). Its result document and its
  argument document, and for an inline pattern its parameters document,
  are staged when the handler's body returns, where the link was stored or
  passed to `navigateTo`. A request whose link the handler dropped stages
  none of them, so no constraint on its argument can fail
  (`plan-and-label-templates.md` §3.14 and §4.4). Its cones are evaluated
  in a derivation transaction, when something demanded reads its result
  (section 1.4).
- **A child a computation made** has a result cell named from the enclosing
  instance, the body, the site and the ordinal or the cause (section 5.5).
  Section 2.8 says when it is written, evaluated and torn down.
- **The parameters of an inline pattern.** An inline `pattern(...)` written
  as the callee of an instantiation in a function body is the callee of a
  `Child` (`Child.callee` of kind `closure`). What it captures from the
  body is stored with the instance, in a parameters document beside the
  argument document: its identifier derives from the result cell with the
  type `params`, as the argument document's does with `argument`, and the
  result document links to it. Each path is bound as section 4.7 binds a
  path of a handler's state in a function body: a cell handle and a
  container the body passes on unchanged are links, and a scalar and a
  container the body computed are copied, with the making body's
  template. A copied path holds what the inline pattern's plan reads below
  its `params` root and no more: the paths at which that plan has a slot
  with root `params`, each narrowed to the slot's class by the rule of
  section 4.7 ("What a copied path holds"), with the `params` slots in the
  place of the handler's `binding` slots (`plan-and-label-templates.md`
  §3.15). The body that makes the instance writes the document with the
  argument, and the child's `params` slots resolve to it. A caller cannot
  read or supply it. A pattern closure used as a value is different: its
  copied captures are stored with the factory value, wherever that is
  stored, narrowed in the same way.
- **A pattern closure used as a value.** *Assumed,* provisional (P34 of
  the continuation plan; section 11.1, question 114). Its factory value
  is a record stored in place at the path the value is written to: a
  kept output, a path of a child's argument, or a path of the stored
  request of an effect, where it is given as a tool. The record holds
  the content address of the compiled inline pattern, in the form a
  module-scope pattern factory is stored in, and a member `params` that
  holds each path of `Closure.params`: the copied value, narrowed as
  above, or the link to the captured cell. Each copied path has the
  label of its instantiated template at its position. An instance that a
  receiver makes by calling the factory has no parameters document: its
  `params` slots resolve below the `params` member of the record the
  receiver called (`scheduler-and-serving-loop.md` §3.2). A body that
  passes the factory on unchanged passes a reference to the record's
  address and copies nothing. The prototype stores no such record,
  because it translates no closure used as a value. Not determined: the
  names of the record's members; and where the captures are stored for a
  closure called through `inSpace`, on which
  `plan-and-label-templates.md` §3.15 states three alternatives and
  assumes none.
- **A child with a scope** (`asScope`). The scope is a constant of the
  site, `Child.scope`, and sets the scope of the state the child declares
  (`plan-and-label-templates.md` §3.14). *Assumed:* the transaction that
  sets the child up writes the scope into the setup record of the child's
  result document, beside the name of the compiled pattern, so that a
  runtime that loads the child without the instance that made it finds
  the scope there. Among the documents of section 4.1 it changes the
  child's state cell documents: a state cell that the child's plan
  declares with a broader scope has scope instances by the scope of the
  modifier, and a state cell declared with a narrower scope keeps its
  own. The other documents follow from the rule of section 1.8 and are
  not changed by the modifier itself. A cone instance of the child that
  reads such a cell has that scope, so its kept outputs are stored in the
  scope instance, for that key, of the result document or of a part
  document, and the state of an operation it evaluates is stored per
  scope key (section 6). A kept output that reads no such cell stays in
  the space's scope instance. The argument document and the parameters
  document are written by the making instance and are not changed. Today
  the modifier puts the scope on the link of the child's result cell
  (`#mintChildResultCell` in `runtime/runner/src/runner.ts`, from the
  `defaultScope` of the node's module), so the child's result as a whole
  is addressed in that scope.
- **A child in another space** (`inSpace`) has its documents in that space.
  The requesting transaction writes only what belongs to its own space. The
  sequence of commits that spans both spaces belongs to
  `scheduler-and-serving-loop.md` (§9.4 there).

### 4.7 Streams and bindings

A handler bound to state yields a stream. What is stored depends on where
the binding was made.

- **A binding of the reactive tier** copies nothing and stores no state
  document. Every path of the handler's state resolves to a slot or an
  output of the instance (section 1.3). That includes a binding in the
  body of a per-element callback: in
  `list.map((el) => … action(() => otherList.push(el)))`, written in a
  pattern body, `el` is bound by reference, and the push stores a link to
  the original element. A path so bound reads the default that the
  declaration of the slot has where nothing is stored there, whatever the
  handler's state type declares (section 2.2). In an element body the
  binding is made once per element key. Each occurrence of an element
  has a key of its own, so two rows that show equal plain values hold
  links to two streams (section 2.5), and an event on either names one
  key. The stream has an identifier (section 5.2), and
  wherever the stream is a kept output, such as an event attribute in the
  rendered tree or an exported stream of the result, the document that
  stores the path holds a link to that identifier.
- **A binding made while a function body runs** (a `bind` site in a `lift`,
  a `computed`, a `handler`, an `action`, or an authored function they
  call) stores one binding state document. It holds, per path of the
  handler's state that `Binding.state` lists:

  | What the body bound at the path | `capture` | What the document holds |
  | --- | --- | --- |
  | A cell handle | `link` | A link to the cell |
  | A scalar | `copy` | The value, as the bound handler observes it (below) |
  | A container the body computed | `copy` | The paths of it that the bound handler observes, each as its class observes it (below). A reference inside it stays a reference, by the rule for values passed on unchanged (section 2.4) |
  | A container the body read from an input or a cell and passes on unchanged, or a reference at a position typed `unknown` | `link` | A link to the address the container was read from. The body records `identity` there and does not read the content |
  | A path that holds a reference on some runs and a computed value on others | `copy` | Decided per run from the value the runtime is handed: a link where the value carries a stored address, and the copy otherwise |

  For a path bound by reference, `Binding.state` names the `identity` slot
  whose reference the binding holds (`reference`), and the runtime verifies
  it by identity, as it verifies a reference a body writes. A container
  the body found by reading through a handle whose read is dynamic has no
  such slot: its path has `capture: "link"` and no `reference`, and the
  link carries the making body's template (`footprint-analysis.md` §8.5).
  A copied path
  carries the label `plan-and-label-templates.md` §3.14 gives it, the
  making body's template. The handler reads a container bound by
  reference when an event arrives, in the event's transaction, and a record
  the handler passes on links to the original. The document's identifier,
  and the stream's, derive from the enclosing instance, the handler and
  what is bound (section 5.5).

**What a copied path holds.** What the bound handler observes of it and no
more, by the rule of `plan-and-label-templates.md` §3.14 ("How much a copy
holds"). `Binding.state` records no class for a copied path. The runtime
narrows the copy by the handler's slots with root `binding` at or below
the path, as it narrows the handler's argument, and stores at each slot's
path what section 2.4 puts into an argument for an entry of that class.

| The handler's `binding` slot | What the document holds at the slot's path |
| --- | --- |
| `value` | The value |
| `shape` | A stand-in of the same kind |
| `enumeration` | A container with the same keys, or the same length |
| `identity` | The subtree. The reference the handler observes is the reference to the copy, so a handler that passes the container on passes on a link to this document |
| `labelMetadata` | Nothing on its own account. The handler observes the label stored for the copy |
| No slot at or below a path | Nothing |

The table holds for a scalar as for a container: a scalar that the handler
observes for `shape` alone is stored as the stand-in of its kind, and a
path the handler does not observe is not stored. A copied scalar is what
the making body read. A scalar the body read from a place where nothing
is stored, and whose declaration has a default, is copied as that
default: the document holds the default as a value, and a later write to
the place does not change the copy. A link the document holds carries
the schema of its place (section 4.4), so a path bound by reference reads
the default when an event arrives, if the place is still empty then.
Every copied path carries
the making body's template, whatever the class. `footprint-analysis.md`
§8.5 has what the body that makes the binding records for each row, and
`language-subset.md` §5.2 has the source forms.

For a handler received as a factory value the compiler does not have the
handler's record. The copy then holds the subtree that the handler's
declared state type covers (`Binding.stateSchema`), as `value`. The record
the runtime resolves when the binding is made narrows what the handler's
argument takes from the copy when an event arrives, and does not narrow
the copy. When an event arrives, the handler's argument is built from its
`binding` slots, which resolve through this document, as any argument is
built. For a factory value bound in a function body, the binding state
document also holds the factory's content address, under the stored label
of which factory was bound: the label of the factory's `identity` slot,
or the template of its entry of `Body.computed`, instantiated by the
transaction that makes the binding. When an event arrives, the handler's
template joins the label stored there (`plan-and-label-templates.md`
§3.21, where it is an assumption).

**The stream document.** Under server execution an event is an entry
appended to a stream document
([events](../server-side-execution/events.md), §1), so a stream that
received an event has a document. Today a stream has two documents and a
bound handler a third. The stream's cell has a document that exists from
setup and holds a `result` back-link to its owner. The entries and the
`eventWatermark` are in a second document, named by a hash of the
stream's link (`streamEntriesDocId` in `runtime/memory/v2.ts`). And a
bound handler has an argument document
([row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md),
"Its handlers"). The runtime routes an event on a stream of a piece that
does not run by following the back-link from the stream's cell to the
piece's result document (`followResultCellChain` in
`runtime/runner/src/ensure-piece-running.ts`).

In the compiled layout a stream document holds the entries of the events
appended to the stream and the stream's `eventWatermark`, and nothing
else: it is today's second document, under the stream's identifier. It is
created by the first event appended to the stream, and no transaction
writes one when a binding comes to exist. Nothing takes the place of the
document of the stream's cell. A stream identifier is a hash and cannot
be inverted, and the document it names does not exist before the first
append, so an event is not routed by a document. By ruling, it is routed
by a row of the stream index
(`scheduler-and-serving-loop.md` §5.1): one row per stream of a compiled
instance, in the space's store beside the basis index, from the stream's
identifier to the instance and the binding. The row takes the place of
the back-link and of the walk that follows it. A binding therefore costs
one row of that index, and no document until its stream receives an
event. The row is written in the store transaction of the wave whose
transaction first computed the stream's identifier, or of the setup
transaction that did (section 9.4).

### 4.8 What the runtime stores today, from source

The comparison in section 4.9 and the rule of section 4.10 rest on these
facts about the current layout.

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
  callback's pattern into it. The container is a further document. Each
  element's instance has an argument document, which the coordinator's
  transaction writes and which carries that transaction's join on every
  path (`plan-and-label-templates.md` §3.6).
- **A document per record written into an array through a cell.** A plain
  object that `set()`, `push()` or `addUnique()` puts into an array becomes
  a document of its own, and the array holds a link to it
  (`anchorValueAsEntity` in `runtime/runner/src/data-updating.ts`,
  which `normalizeAndDiff` calls where `Cell.set`, `Cell.pushAll` or
  `Cell.addUnique` in `runtime/runner/src/cell.ts` supplied anchor
  ids). A record of the argument that an instance is created with, or
  of a default of the argument, gets no document. It is stored in
  place in the argument document, because `Runner.#updateArgument` in
  `runtime/runner/src/runner.ts` writes the argument with no source
  of anchor ids, and `map` keys it by its position.
- **The rendered tree is stored in many documents.** It follows from the
  items above: the static structure of a pattern's tree is
  in that pattern's result document, every position a node computes is a
  link to that node's document, and every row and every sub-pattern has a
  result document that holds its own tree.
- **The renderer subscribes per part.** The schema the renderer reads a
  tree under makes the `props` of a node, its `children`, and each child a
  cell of its own (`rendererVDOMSchema` in `runtime/runner/src/schemas.ts`).
  The reconciler subscribes to each with a `sink` of its own
  (`#renderCellChild`, `#bindCellProps` and `#bindCell` of
  `WorkerReconciler` in `runtime/html/src/worker/reconciler.ts`), so a
  change to one row's document reaches that row's subscription and no
  other.
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
from sections 4.1 to 4.7 and 4.10 and are not measurements. *Assumed:* the
rendered subtree of a row is at or above the placeholder size at which a
subtree becomes a part document. A row binds about 25 values and a dozen
streams, each stream stored as a link, but the size has not been measured.

| Per message row | Today | Compiled |
| --- | --- | --- |
| Instances | One list child with a result slot, and a `FabriChatMessageRow` instance inside it | None |
| Documents the row owns | A result slot and about forty owned cells: 16 computeds, 7 conditionals, 5 actions and at least 11 handler bindings with a stream document and an argument document each, 1 writable, 1 reactive list | One part document, for the row's rendered subtree. One session state cell, `pickerOpen`, once a session first assigns it. One stream document per stream of the row that received an event, and none for a stream that received none. Each of the row's streams, about a dozen, has one row of the stream index, which is not a document (section 4.7) |
| Values a reader binds | About 25 bound props, each a link to a document of the row | The same values as paths of the row's part document: the space's scope instance for most, the session's for the 4 or 5 the record counts as session-scoped |
| Label envelopes | One per document of the row | One, in the row's part document, with an entry per labeled path |

| Per room of thirty messages | Today | Compiled |
| --- | --- | --- |
| Documents for the rows | About 1,230 (thirty families of about forty-one) | 30 part documents, each with a scope instance per session that rendered the row, 0 to 30 state cells per session that opened a picker, and a stream document for each stream that received an event. The rows' streams have about 360 rows of the stream index, a dozen per message row |
| What a resume synchronizes | 1,663 list-child syncs and 285 cell syncs, the twelve participant chips included | The result document, the part documents the session's reads reach, the argument document, and the state cells that exist |
| Commits a load stores | 190, of which 167 are session-scoped derivations of the rows | One per cause that changed a kept output. A second load that finds every cone instance current commits nothing (section 3.4) |
| CFC preparations a load makes | 615 | One per cause |

The envelope figures of
[content-addressed CFC labels](../content-addressed-cfc-labels.md) are from
another store, of chat-row entities whose labels carry confidentiality.
They show what a document per row value costs when labels are not empty:
about 465 bytes of value and about 5.2 KB of envelope per entity, 93% of
live JSON, with 5, 8 or 9 entries of about 790 bytes each. With labels by
reference the same envelope is about 1.1 KB. In the compiled layout an
entry is about 25 bytes of path, origin and class plus a 63-byte reference.
A row that is a part document carries one entry per labeled kept path of
the row, about 25, which is about 2.2 KB where every path is labeled. Rows
stored in place share one `*`-child entry per path where their labels are
equal.

As deployed, FabriChat declares no confidentiality and its derived values
have empty labels (`plan-and-label-templates.md` §6.4). The envelopes of a
room's documents then hold their declared entries and nothing per row.

Two things need measurement at stage 4 of the overview's staging:

- **The sizes.** How large a row's part document and the room's result
  document are, and which placeholder of section 4.10 they call for. A
  reader of the room loads the result document and the parts its reads
  reach, where today it loads the documents it follows links to.
- **The write rate.** A cause that changes one row writes that row's part
  document and no other. A cause that changes membership writes the
  document that stores the array. Under server execution one runtime
  commits for a space, so the writes do not conflict with each other.

### 4.10 Part documents

The keep set is stored in as many documents as serve its readers, by
ruling. A kept subtree can have a document of its own, a **part document**,
with the place it has in the result holding a link to it, so that a reader
loads and subscribes to the parts it uses. `plan-and-label-templates.md`
§2.3 says what a split has to preserve. This section says which subtrees
are split off, how a part document is identified, what stands in its place,
what a reader of a part loads and demands, and what happens when a subtree
crosses the size at which it is split.

**Split points.** A part document can begin only at a split point. A split
point is a kept path whose value is a record or an array and that is one
of:

- the root of a kept `Output` of the plan;
- a position of a kept collection, which is a **row**;
- a node of the rendered tree: a value under `[UI]` that is a node, at any
  depth, a child position of another node included.

The root of the result is not a split point: it is the result document. A
scalar, a link, the `props` of a node and the `children` array of a node
are not split points. They are stored with the node or the record that
holds them.

**The rule about size.** Provisional (P20 of the continuation plan;
section 11, question 103). The size of a split point is the length in
bytes of the stored encoding of its subtree, with each part below it
counted as its storage link and each array or record below it that is
stored in chunks counted as its chunk list (below), plus the stored
label entries and provenance records of the paths that are counted. The
numbers are placeholders. Stage 4 of the overview's staging has to measure them
(section 11, question 32).

| Constant | Value | What it is |
| --- | ---: | --- |
| `PART_MIN_BYTES` | 1,024 | The least size at which a split point is a part of its own. *Assumed* several times the size of a storage link, which is 61 bytes in the encoding of the prototype: about 17 links |
| `DOCUMENT_MAX_BYTES` | 65,536 | The most that the content of one document holds, where the content can be divided: the result document, a part, and a chunk |

1. A split point whose size is at least `PART_MIN_BYTES` is stored in a
   part document. A smaller split point is stored in place, whatever the
   size of the document that holds it.
2. A part whose size falls under half of `PART_MIN_BYTES` is stored in
   place again. Between the two numbers a split point stays as it is, so
   that a subtree near one number does not alternate.
3. An array whose content would exceed `DOCUMENT_MAX_BYTES` where it is
   stored in place is stored in chunk documents ("A long array is stored
   in chunks", below). The content of an array is the stored encoding of
   its entries, each a value in place or a storage link to a part, with
   the label entries and provenance records of the paths in them.
4. A document can still exceed `DOCUMENT_MAX_BYTES` where its content
   cannot be divided by these rules: one long string, or another single
   value that is neither a record nor an array and is larger than the
   number by itself.
5. Provisional (P27 of the continuation plan; section 11, question
   108). A record whose content would exceed `DOCUMENT_MAX_BYTES` where
   it is stored in place is stored in chunk documents ("A record with
   many members is stored in chunks", below). The content of a record
   is the stored encoding of its members, each a value in place or a
   storage link, with the label entries and provenance records of the
   paths in them. *Assumed,* as the prototype built it: where a record
   exceeds the number and holds arrays that are each under it, the
   largest of those arrays are stored as chunk documents first, each
   one chunk under a list of one link, until the record is under the
   number, and rule 5 applies to what is left.

The rule is applied when a transaction seals, to the split points and
the arrays on the paths the transaction wrote, from the innermost
outward. A subtree no write touched keeps its arrangement. Sizes are
computed from the documents being written and are not stored. With each
part and each chunk counted as its link, a split point whose size a
write can change lies in a document that the transaction writes, so
measuring encodes no document that the transaction does not write. A
runtime may keep the sizes of the split points of a loaded instance in
memory and add the difference that each write makes.

- **A row.** Rule 1 applies to each row by itself. A row under
  `PART_MIN_BYTES` stays in the array, at any length of the list, and
  rule 3 bounds the document that holds it. No number of small rows
  makes one of them a part.
- **The rendered tree.** Every node is a split point, so a large subtree of
  a tree is split where it is large: a row's node, a panel inside it, a
  long list inside that. Static structure whose labels are empty is stored
  like any other: in place when small, and once, in a part, when large.
  The `children` array of a node is no split point and is an array of
  rule 3.
- **Another kept output.** A record or an array that one opaque call
  returns is one split point at the output's root. Nothing inside it is a
  split point unless it is itself the root of an `Output` or a row of a
  kept collection. An array inside it is an array of rule 3.
- **The root of a kept collection** is the root of an `Output` and so a
  split point: by rule 1 the array is a part of its own from
  `PART_MIN_BYTES` on, and its rows are in that part, in place or as
  storage links, until rule 3 stores the array in chunks.

**A long array is stored in chunks.** Provisional (P20). Rule 3 applies
to every array that a result document or a part stores: the array of a
kept collection, over an array of references, over an array of plain
values in place, over a plain array generated from scratch, and over the
result of another per-element construct alike; the `children` array of
a node; and an array inside a value that an opaque call returns.
Provisional (P26 of the continuation plan): it applies as well to an
array in an argument document, in a parameters document and in a state
cell document, which a handler or a client writes ("An array of an
argument document or of a state cell", below; section 11, question
107).

- **A chunk document** holds a contiguous run of the entries of one
  array, in their order, with the label entries and provenance records
  of the paths in the run. Its content is at most `DOCUMENT_MAX_BYTES`,
  except where it holds one entry that is larger by itself.
- **The chunk list.** The place of the array holds a chunk list: the
  storage links to the chunks, in the order of their runs, and the
  serial number that names the next chunk (below). *Assumed:* its stored
  form is a record with the tag of a storage link and a member that
  marks it as a list, so that what is stored tells it from an array of
  the pattern, and a value of that form written by pattern code or by a
  client is refused. Provisional (P25 of the continuation plan): beside
  each link the list holds the number of entries of the array below
  that link, which for a link to a chunk is the length of its run and
  for a link to a chunk of links the sum of the numbers in it. A chunk
  list holds no position and no key.
- **A tree.** A chunk list is an array of storage links, and rule 3
  applies to it: a list whose content exceeds `DOCUMENT_MAX_BYTES` is
  stored in chunk documents that hold runs of links to chunks, and the
  place of the array holds the list of links to those. With a storage
  link of 61 bytes and its number, about 70 bytes, a document holds
  about 930 entries of a list. One list then serves about 930 chunks,
  which is about a million rows that are parts and more where the rows
  are in place, and a tree of two levels about 930 times 930 chunks.
- **The first division.** When the content of an array first exceeds
  `DOCUMENT_MAX_BYTES`, the entries are divided into the fewest runs
  that are each under the number, of about equal bytes, at boundaries
  between entries. *Assumed,* as the prototype built it: equal shares,
  and not a division in two that is repeated, which left chunks of one
  row where many rows were written at once.
- **A split.** A chunk whose content exceeds `DOCUMENT_MAX_BYTES` when a
  transaction seals is divided the same way: in two for one more row,
  and in more where one transaction wrote many rows into it. The
  transaction creates a chunk document for each further run and writes
  the list above, which gains the links behind the link of the chunk
  that was divided. A list that then exceeds the number is divided in
  turn.
- **A merge.** Two chunks that are adjacent in one list and whose
  contents together fall under half of `DOCUMENT_MAX_BYTES` become one:
  the transaction writes the first with both runs, deletes the second,
  and writes the list above, which loses one link. A chunk whose run is
  empty is deleted in the same way. A list of an inner level that holds
  one link is replaced by that link. When the list at the place of the
  array holds one chunk whose content is under half of
  `DOCUMENT_MAX_BYTES`, the array is stored in place again and the chunk
  is deleted. A chunk between half of the number and the number stays
  as it is, so an array near one number does not alternate.
- **How a chunk document is identified.** *Assumed:* by the record of a
  part document (below) with `type: "chunk"`, the kept path of the
  array as `cause`, and a member `serial`, the number that the chunk
  list at the place of the array held when the chunk was created. A
  split increments the number in that list, so a split writes that
  list also where it is not the list directly above the chunk. The
  identifier holds no position and no key of an entry: an insertion, a
  removal, a reorder and a re-key rename no chunk. A chunk document
  takes the `computed:` scheme and has scope instances as a part has.
- **What a chunk document holds.** At its root: `value`, the run; a
  `result` meta link back to the result cell; the `within` steps, the
  path and the serial number it was named from; and its `cfc` envelope.
  Nothing but the storage link in the list above names it.

**A record with many members is stored in chunks.** Provisional (P27 of
the continuation plan; section 11, question 108). Rule 5 applies to
every stored record: the root of a result, a record that an opaque call
returns, a row, and a record of an argument document or of a state
cell. The case that the prototype measured is a record that holds one
member for each element under an identifier, as the record `pool` of
`fixtures/rows-state.tsx` does for the cells that an array of
references names: it is one document at any number of members, and one
keystroke in one member wrote 572,774 bytes of documents at 10,000
members for 25 bytes of change.

- **A chunk document of a record** holds the members of one contiguous
  range of member names, in the order in which a read gives the members
  of a stored record: the order of the `base/data-model` codec
  (section 2.4; provisional, P1 of the continuation plan). It is
  identified and holds what a chunk of an array holds, with the range
  in the place of the run.
- **The chunk list of a record** holds the storage links to the chunks
  in that order and, beside each link, a member name that is a lower
  bound of the names in the chunk. *Assumed:* the bound is the first
  name of the chunk when the chunk was created and is not written when
  that member is removed or a member with a lesser name is inserted
  into the chunk, so that an insertion or a removal of a member writes
  no list; the first chunk has no bound. The list holds no number of
  members: a record has no positions.
- **The tree, a split and a merge** are those of an array. A chunk is
  divided at boundaries between members, two adjacent chunks that
  together fall under half of `DOCUMENT_MAX_BYTES` become one, and a
  list that exceeds the number is stored in chunks of links.
- **A path** whose next segment is a member name finds the chunk by
  comparing the name with the bounds of the list, and continues at the
  member. A read of one member loads one list for each level and one
  chunk. A read of the names of the members, as `Object.keys`, a
  spread and a whole read make, loads every chunk.
- **What one change writes.** A write of one member, an insertion and a
  removal each write the chunk that holds the name. A list is written
  on a split or a merge alone.
- **Labels.** The envelope of a chunk is complete for its paths, as for
  a chunk of an array, and an entry that covers every member is
  repeated in each chunk and stands at the place of the record.
  *Assumed:* the bounds in a chunk list are member names of the record
  and are read under the label of the record's set of names, the entry
  that a read of its names consumes, which stands at the place of the
  record with the list.
- **A member is no part for being a member.** A member of a record is a
  split point only where the list of split points above makes it one.
  A member that is larger than `DOCUMENT_MAX_BYTES` by itself and is a
  record or an array is divided by rule 3 or rule 5 in turn.
- **What it is not.** *Assumed:* a value that the codec stores as an
  instance of its own, such as a `FabricMap`, is one value of rule 4
  and is not divided.

The prototype does not build this rule: a record is no split point
there, and the figure above is what it measured without it.

**Finding the chunk of a key.** Open, with no provisional decision
(section 11, question 110). A chunk is found by position, and a reference
by key names no position. A runtime that holds the keys of the array in
memory, in an element table or as the kept keys of section 2.5, resolves
from them. One that does not reads the chunks in order and forms the keys
of their rows until it finds the key, which is a read of the whole array
on a runtime that has just started. No index from a key to its chunk is
stored. Question 110 lists what an index would have to settle, among them
what its entry names: an entry that names the chunk is written again for
every row that a split or a merge moves, and those entries are spread over
the whole index. The rule is the same over an array of plain values in
place, over an array of plain values generated from scratch, over an
array of references, whose key is the identity of a cell, and over the
result of a `map`, a `filter` or a `flatMap`, whose rows have the keys of
their source or of another per-element construct.

The scope of this section follows the coordinator's recommendation on the
scope of the storage decisions (the continuation plan, "Provisional
decisions awaiting the owner's ratification"; not an owner ruling).
Chunked storage of long arrays is a requirement on the storage layer and
is decided there; this design keeps the split points, the cone's reference
to a collection it places (P22), and the bound on what the change of one
row writes and delivers. The chunk layout of this section is the shape the
design expects of storage.

The prototype does not build the index: its executor resolves a key
from the keys it keeps in memory.

**How a position is derived.** No stored document holds the position of
an entry of an array that is stored in chunks. The position of an entry
is the number of entries in the chunks before its chunk, in the order of
the lists, plus its offset in the run of its chunk. The numbers in the
chunk lists give the first term (provisional, P25): a reader finds the
chunk of a position by reading the list at the place of the array and
one chunk of links for each further level, adding the numbers of the
links it passes, and then reads the one chunk. A read by position
therefore loads one document for each level of the tree and one chunk,
at any length of the array. An insertion or a removal changes the
position of every later entry and writes none of them: no later chunk,
no storage link, and no part. It writes the chunk it changed and, for
each level of the tree, the one list whose number for that chunk
changed. The runtime that has loaded the instance may keep the numbers
in memory, beside the element table of a kept collection (section 2.5).

**How a path, a reference by key and a storage link resolve through
chunks.**

- **A path.** Where resolution reaches the place of the array and finds
  a chunk list, the next segment is a position. The runtime finds the
  chunk and the offset as above and continues at the entry. Where the
  entry is a storage link to a part, it continues in the part. A chunk
  list and a link to a chunk are storage links in every property that
  `plan-and-label-templates.md` §2.3 gives one: resolution passes
  through them without observing them, they are on no chain, they carry
  no label, and they give a row no cell identity.
- **A reference by key** names the collection and the key (section 2.5).
  The runtime takes the position of the key from the element table and
  resolves the path below that position as above. Where no loaded
  instance iterates the array, it forms the keys of the entries by
  reading the chunks in order until the key is found ("Finding the chunk
  of a key", above; question 110 is open). That is the cost that the
  paragraph "Resolving a reference by key" of section 2.5 states, with
  the chunks as the unit that is loaded. Where
  the row of the key is a part, the part is reached through the storage
  link in the chunk and in no other way: its identifier holds no key
  (provisional, P28; "How a part document is identified", below).
- **A storage link to a part** names the part document and nothing
  else. Neither the link nor the part holds a chunk, a position or a
  serial number, so a split or a merge that moves the link to another
  chunk writes no part. A reference to a kept path names the result
  cell and the path, whichever chunk stores the path.

**What one change of an array writes.**

| Change | Documents written |
| --- | --- |
| A member of a row stored in place changes | The chunk that holds the row, or the document that holds the array where it is not stored in chunks |
| A member of a row that is a part changes | The part document alone |
| A row under `PART_MIN_BYTES` is appended or inserted | The chunk that holds the position, and one list for each level of the tree, for the number of entries. On a split: the new chunk as well |
| A row of at least `PART_MIN_BYTES` is appended or inserted | The part document, created, the chunk that receives its storage link, and one list for each level. On a split: the new chunk as well |
| A row is removed | The chunk that held it, one list for each level, and the part document of the row, deleted, where it had one. On a merge: the chunk merged into, and the other chunk deleted |
| A row crosses `PART_MIN_BYTES`, or falls under half of it | The part document, created or deleted, and the chunk that holds the row. No list: no number changed |
| Rows are reordered | The chunks that hold a position whose entry changed, and the lists only where a row moved from one chunk to another |
| The array is replaced by another of other rows | Every chunk whose run changed, and the lists whose numbers changed |

The bound, provisional (P25): one change of one row writes at most one
chunk and, where the number of entries changed, one list for each level
of the tree, and on a split or a merge two chunks. A tree has one level
of lists up to about 930 chunks and two beyond that, so the documents
written are at most four, each of at most `DOCUMENT_MAX_BYTES`, at any
length of the array up to about 930 times 930 chunks. An edit of a row
writes no list. One thing is beside the bound, and it is provisional: a
change that creates a part at or below a row writes the root that holds
the counter of minted identifiers (P28; "How a part document is
identified", below). No index from a key to its chunk is stored
("Finding the chunk of a key", above). The
write of a chunk is a `splice` of its run or a write below a path of it
(section 4.2). Today's storage takes the second as a patch from the
writer and sends the chunk whole to each subscriber ("What today's
storage does with a write below a path", below), and what the design
requires of storage there is not decided (section 11, question 103).

**How label entries and provenance records are counted, and where they
are stored.**

- The size of a row, of a chunk and of an array counts the label entries
  and the provenance records that are stored for its paths, in the
  encoding the envelope stores them in. An entry that covers several
  paths is counted once in each document that stores it.
- A chunk's envelope is complete for its paths, as a part's is ("How the
  labels of a part relate to the templates of the outputs", below). It
  holds the `enumerate` entry of the array and, while every position
  instantiates to one label, the `*`-child entry, each once for the
  chunk and not once for each row; and the entries of a row whose label
  differs from that of the other rows, at paths relative to the run.
  The same entries stand at the place of the array, for a read of the
  membership that loads no chunk.
- A change of the label of the membership, or of a label that every row
  shares, therefore writes every chunk of the array and no part: the
  number of documents is the number of chunks. A row that is a part
  repeats the entries in its own envelope, and is written for such a
  change.
- The entries of a path inside a run are at paths relative to the run,
  so an insertion at position `i` renumbers the entries of the later
  rows of one chunk, and of no other chunk.

**A re-key of an element of an array of plain values in place.** By
ruling a plain value with no declared key that is edited in place is
another element, with another key (`plan-and-label-templates.md` §1.3).
Neither the identifier of a chunk nor that of a part holds a key
(provisional, P28), so the edit renames no document of the layout.

- **In the source array** the row is edited where it stands: the edit
  writes the chunk that holds the row or, for a row that is a part, the
  part alone.
- **In the result of a per-element construct over it** the old key
  leaves and the new key enters at the same position. For a row stored
  in place the transaction writes the chunk that holds it. For a row
  that is a part, *assumed* by the decision's words, that the
  identifier stays with the entry of the row's position across edits
  and re-keys: where one transaction removes a key at a position and
  enters another at that position, the entry keeps its storage link and
  the transaction writes the part's content. The prototype, with a
  minted identifier, deletes the part of the old key and creates one
  for the new key there, which is 2 documents more (question 109).
- **With a declared key** (`ArrayByKey`) the key is unchanged and the
  edit writes the chunk or the part alone, in the source and in the
  result.
- **Over an array of references** the key is the identity of the cell
  and no edit of the cell's content changes it.

Measured with the key in the identifier of a part, which is the rule
that P28 replaces, on rows of 2,000 bytes at 10,000 rows: with no
declared key every edit renamed the part of the source row, 5 documents
and 128,748 bytes, of which 2 parts deleted and 2 created; with a
minted identifier 4 documents and 66,747 bytes, the 2 that remain
being the row of the result. With a declared key the first edit after
a reader formed keys renamed the part, 3 documents and 65,977 bytes,
against 2 documents and 3,976 bytes with a minted identifier. What is
stored under the key outside the result, the state cells, streams,
operation state and children, is moved as section 2.5 has it and is
not part of this layout.

**An array of an argument document or of a state cell.** Provisional
(P26 of the continuation plan; section 11, question 107). Rule 3 and
the paragraphs on chunks apply to every stored array, so an array of
plain values in place that a handler or a client writes is stored in
chunks from `DOCUMENT_MAX_BYTES` on, and an edit of one element of an
array of 10,000 records writes one chunk and not below a path of one
document of 676,691 bytes, which is what the prototype measured for
that array. The same for an array of references in such a document,
whose entries are links.

- **Addressing is unchanged.** A handle, a link, a slot and a reference
  by key name the document and a path, or the array and a key. A path
  with a position resolves through the chunk list as above. A handle by
  position, `items.key(i)`, is bound at the position, whichever chunk
  holds it.
- **Who lays the array out.** *Assumed:* the runtime that commits the
  transaction applies the rule when the transaction seals, as for a
  result. A handler body and a client name the array's path in every
  write and decide no split.
- **`set` of the whole array** writes every chunk whose run changed, by
  the first division where the new content exceeds the number.
- **`push` and a `splice`** are written by the writer as an operation on
  the array at its path. The committing runtime applies it to the last
  chunk, or to the chunk of the position, and to one list for each
  level.
- **A reference by key** into such an array resolves as into any array
  that is stored in chunks: from the element table or the kept keys,
  and where there are none by reading the chunks in order and forming
  the keys ("Finding the chunk of a key", above; question 110 is
  open).
- **An entry of such an array is a part from `PART_MIN_BYTES` on.**
  *Assumed,* as the prototype built it, whose layout does not know
  which kind of document it stores: an element of a source array that
  is a record or an array is a split point as a row of a result is, and
  rules 1 and 2 apply to it. A source array has no key before a reader
  forms one, and a reader forms it by its own declared key fields (by
  ruling), so a part of such an element cannot be named by a key; it
  has a minted identifier (provisional, P28), and an edit or a re-key
  of the element writes the part alone.
- **A record of such a document** is stored in chunks by rule 5
  (provisional, P27).
- **The chunk documents** are named from the document that holds the
  array, with the path of the array and the serial number, and
  *assumed* to take the scheme of that document, since a state cell is
  no derived state.

Three things conflict with this or are not determined, and are in
question 107: a mergeable `push`, which today's storage applies as an
operation on one array of one document, and which with P25 writes a
number that two concurrent pushes both change; a writer that is not
the compiled runtime, which finds a chunk list at the place of the
array; and the envelope of a chunk of a document whose labels a writer
declared.

**What today's storage does with a write below a path.** From source;
it bears on what a chunk costs (section 11, questions 103 and 107).

- **What a writer sends.** A commit carries one operation for each
  document it writes (`ClientCommit.operations` in
  `runtime/memory/v2.ts`): a `set` with the whole document, a `patch`
  with a list of operations that each name a path of the document
  (`PatchOp`: `replace`, `add`, `remove`, `move`, `splice`, `append`,
  `add-unique`, `remove-by-value`, `increment`), or a `delete`. For a
  document that the transaction read before it wrote, the writer sends
  a `patch` of the paths it wrote (`getNativeCommit` and
  `#buildPatchOperation` in
  `runtime/runner/src/storage/v2-transaction.ts`). It sends a `set`
  where the document had no value before, where the transaction wrote
  the document's root, and for a transaction that is marked to write
  whole documents, which the write-back of an effect's completion is.
- **What the server stores.** One row for each operation, which for a
  `patch` holds the list of operations and not the document
  (`writeOperation` in `runtime/memory/v2/engine.ts`). After every
  tenth patch of one document it stores the whole document once more
  as a snapshot (`maybeMaterializeSnapshot`, with
  `DEFAULT_SNAPSHOT_INTERVAL`), and keeps the last two. A read forms
  the document from the latest `set` or snapshot and the patches behind
  it (`reconstructPatchedDocument`).
- **What a subscriber receives.** The whole document, for each document
  that changed (`doc` of `SessionSyncUpsert` in `runtime/memory/v2.ts`,
  filled by `toCacheEntry` and `toWireUpsert` in
  `runtime/memory/v2/server-sync.ts`). No sync carries a patch of a
  document.
- **A mergeable `push`.** `Cell.push` records that it appended
  (`pushAll` in `runtime/runner/src/cell.ts`, which calls
  `recordMergeableOp` of the transaction), and the commit
  carries the operation `append` with the path of the array and the
  values pushed, not the resulting array (`buildMergeableIntent` in
  `runtime/runner/src/storage/mergeable-ops.ts`). The server applies it
  to the array that it holds at that path (`appendAtPath` in
  `runtime/memory/v2/patch.ts`), so two pushes from two sessions both
  land. The operation names one path of one document. Nothing in the
  server applies an operation to an array that is stored across
  several documents.
- **One value across several documents.** Nothing in storage keeps one
  value of a document in several documents under a layout that storage
  maintains. Two things are near it. `Cell.push` of a record stores the
  record in a document of its own and a link in the array
  (`diffAndAppend` in `runtime/runner/src/data-updating.ts`): that
  layout is made by the writer, and a reader sees the links. And a
  field that takes collaborative text edits is kept by the server as a
  baseline, the operations integrated since, and checkpoints, in tables
  beside the document rows (`op_field_epoch`, `op_integrated` and
  `op_checkpoint` in `runtime/memory/v2/engine.ts`): a representation
  of one field that storage maintains, in rows and not in documents.

**What follows for the size of a chunk.** Not decided; the figures are
the prototype's, for a `map` over an array of plain values in place
with a declared key, 10,000 rows of 23 bytes, by the value of
`DOCUMENT_MAX_BYTES`:

| Maximum | Edit: documents, bytes | Append: documents, bytes | Documents read for one row | Documents in all |
| ---: | ---: | ---: | ---: | ---: |
| 65,536 | 2, 122,242 | 4, 123,166 | 2 | 13 |
| 16,384 | 2, 32,134 | 4, 35,372 | 2 | 44 |
| 4,096 | 2, 8,130 | 7, 14,794 | 3 | 173 |
| 1,024 | 2, 2,026 | 12, 6,222 | 4 | 721 |

The bytes are those of the documents written, each whole. The bytes
that the writer and the derivation put in are 24 for the edit and 71
for the append at every maximum. An edit writes one chunk of the
argument and one of the result. An insertion writes those and one list
for each level, and the list of the first level holds `N * s / C`
entries of about 75 bytes for `N` rows of `s` bytes in chunks of `C`
bytes, so a chunk and its list are of one size at
`C = sqrt(75 * N * s)`: about 5,900 bytes for 10,000 rows of 45 bytes
of JSON, 18,600 for 100,000 and 59,000 for a million.

By what the source shows, three parties pay for one edit of one small
row, and they pay differently. The writer sends the patch. The server
stores the patch and, for each tenth patch of a chunk, the chunk whole,
which is a tenth of the chunk for each edit on average. Each subscriber
of the chunk receives the chunk whole. So the bytes sent by a writer
and stored for a commit favor a large chunk, and the bytes that every
subscriber receives for every edit are the size of the chunk and favor
a small one. `DOCUMENT_MAX_BYTES` stays 65,536, a placeholder. A
maximum that follows the size of the array is no part of the
provisional rule.

**Worked sizes.** The prototype measured the layout with every row a
part once the document exceeds `DOCUMENT_MAX_BYTES`, for a `map` over an
array of plain values in place whose rows are 23 bytes and whose storage
links are 61 bytes, with no label entry and no provenance record in any
size (the first two columns of figures). The last column is derived
from the same sizes by the rule of this section and is not measured.

| Rows | Change | Measured, every small row a part: documents and their bytes | Derived, by rules 1 to 3 |
| ---: | --- | --- | --- |
| 2,000 | settle | 2 documents: the result and one part of 46,960 bytes that holds the array | The same |
| 2,000 | edit one field | 1 document of 46,895 bytes, 14 bytes put in | The same |
| 2,600, 200 rows appended | append | 2,800 part documents created in the one transaction, and the array of links, about 171,000 bytes | The array of 2,800 rows is about 65,700 bytes and is divided once: 2 chunks of about 32,900 bytes and a list of 2 links |
| 3,000 | settle | 3,002 documents, 250,960 bytes | 4 documents: the result, the part that holds the list, and 2 chunks of about 35,200 bytes |
| 10,000 | settle | 10,002 documents, 838,960 bytes | 6 documents: the result, the part that holds the list of 4 links, and 4 chunks of about 58,700 bytes |
| 10,000 | append | 2 documents, 610,081 bytes, for 98 bytes put in | 1 chunk of at most 65,536 bytes, for about 24 bytes put in, and the part that holds the list of 4 entries, about 300 bytes, for one number |
| 10,000 | edit one field, `ArrayByKey` | 1 part document of 24 bytes | 1 chunk of at most 65,536 bytes, 14 bytes put in |
| 10,000 | edit one field, no declared key | 2 documents, 610,025 bytes, one part deleted and one created | 1 chunk of at most 65,536 bytes, and no part |
| 10,000 | remove first | 1 document of 609,940 bytes, one part deleted | 1 chunk of at most 65,536 bytes, and the part that holds the list, for one number |

A list that is built by appends has chunks that are half full: each
split leaves a first run of about half of `DOCUMENT_MAX_BYTES` that no
later append reaches, so 10,000 rows of 23 bytes built that way are
about 7 chunks of 1,400 rows. For rows of 2,000 bytes each row is a
part, the array holds 10,000 storage links, 610,000 bytes, and is 16
chunks of 625 links with a list of 16 links; an append creates one part
and writes one chunk of links. The row with a declared key shows what
the rule gives up: an edit of a small row writes its chunk, where a row
that is a part by itself is one document of 24 bytes.

**Measured sizes.** The prototype built rules 1 to 3 as documents, with
`PART_MIN_BYTES` 1,024, `DOCUMENT_MAX_BYTES` 65,536, the numbers in the
chunk lists, and the identifier of a part by the key, and measured a
`map` over an array of plain values in place with a declared key. The
source array and the result are both laid out, so each row counts
twice. "Bytes" are those of the documents written, each whole, and
"put in" is what the writer and the derivation changed.

| Rows of | Length | Change | Documents written | Bytes | Put in | Documents read for one row | Documents in all |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 23 bytes | 1,000 | append | 2 | 64,759 | 65 | 1 | 2 |
| 23 bytes | 10,000 | append | 4 | 123,166 | 71 | 2 | 13 |
| 23 bytes | 10,000 | edit one field | 2 | 122,242 | 24 | 2 | 13 |
| 23 bytes | 10,000 | remove first | 4 | 123,078 | 2 | 2 | 13 |
| 23 bytes | 100,000 | append | 4 | 139,217 | 74 | 2 | 112 |
| 23 bytes | 100,000 | edit one field | 2 | 130,916 | 24 | 2 | 110 |
| 2,000 bytes | 10,000 | append | 6 | 129,644 | 3,979 | 3 | 20,064 |
| 2,000 bytes | 10,000 | edit one field | 3 | 65,977 | 3,930 | 3 | 20,022 |
| 2,000 bytes | 100,000 | append | 6 | 149,137 | 3,980 | 3 | 200,236 |
| 2,000 bytes | 100,000 | edit one field | 3 | 69,202 | 3,930 | 3 | 200,192 |

The bytes of the documents that one change writes are bounded at every
length: at most 139,217 for rows of 23 bytes and 149,137 for rows of
2,000 bytes, in at most 6 documents, at 100,000 rows. The edit of a row
of 2,000 bytes writes 3 documents because the key in the identifier
renames the part of the source row at the first edit after a reader
formed keys; with a minted identifier (P28) it writes 2 documents and
3,976 bytes. With no number in a chunk list an insertion writes 2
documents where it writes 4, and the row at position 50,000 of 100,000
is read through 20 documents where it is read through 2. Over an array
of plain values in place with no declared key, and over the result of
a `filter` of such an array, an edit writes one document more, the
document that holds the result's list, since the row leaves and enters
under another key. Over an array of references each element is a
document of its own, and an edit writes it and the chunk of the result:
2 documents and 48,048 bytes at 10,000 rows of 23 bytes. Nothing was
measured over a plain array generated from scratch or with a `flatMap`.
No size holds a label entry or a provenance record, and the value code
of the prototype does not read through the part documents: a reader
outside its executor reads every document back from them after each
change.

**Points that the rule leaves open, as the prototype built them.** Each
is *assumed* here as built, and is part of question 111.

- **A chunk whose run is empty** is deleted, also where its neighbors
  are over half of `DOCUMENT_MAX_BYTES` and no merge takes place.
- **When an array is stored in place again:** when one chunk is left
  and its content is at most half of `DOCUMENT_MAX_BYTES`.
- **A document that holds several arrays** can exceed the number while
  each array is under it. The largest of them are stored as chunk
  documents of their own until the document is under the number
  (rule 5).
- **An array that is written whole,** as a `set` of a new array writes
  it, is compared with what is stored: the rows that are equal at the
  start and at the end are kept and the rest is written as a `splice`.
  The comparison reads the whole stored array. Without it such a write
  writes every chunk.
- **The first write of a long array** creates every chunk and every
  part of it in one transaction: 200,236 documents for 100,000 rows of
  2,000 bytes with their results. No rule of this section avoids it.
- **Rows that are inserted one at a time at one end** leave every chunk
  about half full, since each split leaves two halves and only the one
  at the end is filled again. 40,000 rows of 23 bytes that were
  appended, or prepended, one in each transaction stand in 55 chunks
  where 28 would hold them; inserted at random positions, in 32. After
  nine tenths of them are removed at random, 8 or 9 chunks stand where
  3 would hold the rows. The number of chunks stays within about three
  times the least. A split that leaves the full chunk behind at the end
  where an array grows is not part of the rule.

**What stands in the place of a part.** The path holds a **storage link**
to the part document. A storage link is written by the runtime and held by
no pattern code. *Assumed:* its stored form is a link with a tag of its
own, beside the tag a stored reference carries (`LINK_V1_TAG`, which
`runtime/runner/src/sigil-types.ts` exports), so that what is stored tells
the two apart, and a value of that form written by pattern code or by a
client is refused. The link names the part document and nothing else: no
path, no schema, no scope. Everything that resolves a path passes through
it without observing it: slot resolution, schema validation, the resolution
of a consumed label, `resolveAsCell()`, and the element-key rule, which
gives a row no cell identity on its account
(`plan-and-label-templates.md` §2.3). The link from a broader scope
instance to a narrower one is the second kind of storage link. It has the
same tag and the same properties, and holds a declared scope in the place
of a document (section 4.2).

**How a part document is identified.** Two cases. A part whose kept
path passes through no position of an array is identified by the
instance and the path. A part that is a row, or that lies below a row,
is identified by a number that the runtime mints, and by no key
(provisional, P28 of the continuation plan; section 11, question 109).

```text
no row on the path:
createRef({}, {
  parent: <result cell entity id>,
  type:   "part",
  cause:  <path>,
})

a row, or below a row:
createRef({}, {
  parent: <result cell entity id, or the source document>,
  type:   "part",
  serial: <number>,
})
```

The record is a fabric value that `createRef` hashes, by the ruling that
this design joins no parts with separators of its own
(`plan-and-label-templates.md` §1.2, "Written forms").

- `cause` of the first form is the path from the result root down to
  the split point. Its segments are property names and the indexes of
  arrays that are not kept collections and are not stored as rows, such
  as the children written in one JSX element. This is the naming rule
  of `plan-and-label-templates.md` §1.3, with a path where a
  declaration has a name.
- **A minted identifier.** The number is minted when the subtree first
  becomes a part. It is held by the storage link in the entry of the
  row's position, or at the place of the subtree inside the row, and
  nowhere else. It is derived from no content: not from the key of the
  element, not from the position, and not from the path. It stays with
  the entry through every edit of the row, a re-key included, through a
  move of the row to another position, and through a split or a merge
  of chunks, each of which moves or keeps the storage link and renames
  nothing. A part that returns in place and later becomes a part again
  gets another number.
- **Where the number comes from.** *Assumed:* from one counter of the
  document that `parent` names, kept at its root beside `value`, which
  a transaction that creates such a part reads and writes. The number
  is then unique among the parts of that document, whichever array
  holds the row. The cost is that each creation of a part at or below
  a row writes that root, and two transactions that create one each
  conflict on it. A counter for each array, and an identifier derived
  from the cause of the creating transaction with no counter, are the
  alternatives of question 109.
- **Why not the key.** With the key in the identifier, an edit that
  changes the key renames the part: for an array of plain values in
  place with no declared key that is every edit ("A re-key of an
  element", above). And an array of an argument document or of a state
  cell has no key before a reader forms one, by the key fields that
  the reader declares (by ruling), so its rows have no key to be named
  by when they are written.
- **What a reader of the storage link learns.** A storage link is part
  of what is stored, and a reader of the document that holds it can see
  the identifier it names: for a row, a reader of the collection's
  membership. The identifier holds nothing of the cell or the value
  that the row was computed from, so it needs no hash under the secret
  of the space. It tells such a reader which entries hold the same part
  before and after a change of membership, which the membership label
  covers, and, with a counter, the order in which the parts of one
  document were created (question 109).
- **No one derives the identifier.** Neither a client nor the server
  forms it from a path or a key. A reader names the result cell and a
  path, or the collection and a key, and reaches the part through the
  storage link.
- A part document of a result is derived state and takes the
  `computed:` scheme, like an operation's state document (section 6),
  and a part of a source document takes the scheme of that document.
  It has a scope instance per scope key that a path inside it was
  evaluated for, as the result document has.

**What a part document holds.** At its root: `value`, the subtree; a
`result` meta link back to the result cell, as a state cell document has;
the path or the number it was named from; and its `cfc` envelope.
*Assumed:* a part at or below a row of a kept collection also holds,
as data and not as part of its identifier, one step for each kept
collection whose position its path passes through, `{ element:
<collection name>, key: <hashed key> }` with the key hashed under the
secret of the space, outermost first, and the path below the innermost
row. They are what gives the scheduler the kept paths of a watch on
the part ("Demand", below). A transaction that changes the key of the
row writes them with the content. A part of a source document holds
none: a source document has no demand (question 109).
A path inside it that is itself a part holds a storage link to that part.
Nothing but the storage link in its parent names a part document.

**What a reader of one part loads, subscribes to, and demands.**

- **Addressing.** A reader names the result cell and a path. The runtime
  resolves the path from the result document and, at each storage link on
  the way, continues in the part document it names, and at a chunk list
  in the chunk of the position ("How a path, a reference by key and a
  storage link resolve through chunks", above).
- **Loading.** The reader loads the documents the path passes through and,
  for a read of a subtree, the part documents below the path that its
  schema reaches. It loads no other part. A session that lists rooms by
  name loads each room's result document and no row. A reader of one
  row of an array that is stored in chunks loads one list for each
  level of the tree and the chunk of the row. A reader of the whole
  array loads every chunk and
  the parts its schema reaches.
- **Subscribing.** The reader subscribes to the same documents. A change
  inside one row is a write to that row's part document and reaches the
  readers of that row; for a row stored in place it is a write to the
  chunk, or to the document that stores the array, and reaches the
  readers of the other rows stored there, each of which finds the paths
  it reads unchanged. A change of membership is a write to the chunk of
  the position, or to the document that stores the array, and reaches
  its readers, who find the moved entries. A runtime that has resolved
  a path may hold the part document's
  address for its own subscription. What it stores or passes on stays the
  result cell and the path.
- **Demand** is held on kept output paths
  (`scheduler-and-serving-loop.md` §4.2) and does not depend on the split.
  A reader of one part demands the kept paths it reads, and so the cone
  instances that compute them: for a row, that row's element cones and no
  other row's. Where a session watches a part document by its own
  address, the `result` link and the path at the part's root give the
  scheduler the instance and the kept paths the watch reaches, as that
  section has it.

**Writing.** One evaluation writes every document it changed in one
transaction: the result document, each part document and each chunk
document a changed path is stored in, and the document that holds a
storage link that was added, removed or moved. No reader sees a value
in one document beside a value
or a label from another state in a second one. A part document of which no
path changed is not written.

**Crossing a number.** A split point that reaches `PART_MIN_BYTES`, or
falls under half of it, changes its arrangement in the transaction whose
write changed its size. So does an array or a chunk that crosses
`DOCUMENT_MAX_BYTES` or half of it ("A long array is stored in chunks",
above).

- **Into a part.** The transaction creates the part document with the
  subtree and replaces the subtree in its parent by a storage link. The
  label entries and provenance records of the paths inside move with them
  into the part's envelope, at paths relative to the part's root. A frozen
  `shape` entry moves unchanged: the move is not the creation of the path.
- **Back in place.** The transaction writes the subtree and its entries
  into the parent, at the paths they have there, in place of the storage
  link, and deletes the part document. Nothing else names the document, so
  it needs no retention period.
- **What a reader sees.** At every result path the same value, the same
  label for every observation class, and the same references to it, since
  a reference names the result cell and the path. A reader that subscribed
  to the documents on its path receives the change of the parent in the
  same commit, resolves the path again, and reads the same value. What can
  be seen is that a document came to exist or ceased to, by an observer
  who can list the documents of a space. `plan-and-label-templates.md`
  §5.5 lists that with the residual channels.
- **A removed row.** When a key leaves a kept collection, the transaction
  removes the position from the array, in the chunk that holds it where
  the array is stored in chunks, and deletes the row's part document,
  with the part documents and the chunk documents below it. A part
  document holds kept paths
  of the result and nothing that is stored under the key, so this
  agrees with the ruling that a removal deletes no state cell and no
  operation state of the key (section 2.6).

**How the labels of a part relate to the templates of the outputs.** A part
document has no label as a whole, and its storage link carries none. Each
kept path inside it has the template the plan gives that output path, with
the element slots bound for the row's position, and is instantiated like
any kept path (section 1.6).

- The entries of a path inside a part are stored in the part's envelope:
  the `value` entry, the frozen `shape` entry, the `enumerate` and
  `*`-child entries of a collection inside the part, the declared entries
  of the result schema for those paths, and the provenance records.
- The entries of a path above the part stay with the document that stores
  that path, the `enumerate` entry of a collection whose rows are parts
  included. Which rows a collection has is labeled there, by the
  collection's membership template.
- **A part's envelope is complete for its paths**, by the rule of
  `plan-and-label-templates.md` §2.3. Where a `*`-child entry of the
  collection's document covers a path inside a row, the row's part
  document holds an entry at that path with that entry's label all the
  same. A read of the part document by its own address then consumes what
  a read of the same paths through the result consumes, and no path is
  served under a label that only another document holds.
- **The repeated entry and the `*`-child entry agree.** The `*`-child
  entry stays in the collection's document, where it covers the positions
  stored in place, and it is repeated in each chunk of an array that is
  stored in chunks. It is stored only while every position instantiates to
  its label, the positions that are parts included, and one transaction
  writes it and the entries of the parts. A read through the result that
  consumes both consumes one label twice, which a join absorbs. The
  entries of a part are those of the position its row has: a move that
  changes a label the row's slots resolve to rewrites them in the
  transaction that moves the row.
- The constraints are evaluated per output path and per write edge and do
  not depend on which document stores the path.

**Clients.** A client decides no split. A speculative transaction writes
overlay entries per kept path, and the client reads whatever arrangement
the server stored.

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
enclose the declaration, and its name. The names are those of
`plan-and-label-templates.md` §1.3:

- a declaration assigned to a `const` takes the variable's name, as the
  transformer's `.for(...)` does;
- a declaration assigned to nothing takes a base name from what it is: the
  callee's name for a call site, a child or a use of a body, the
  built-in's or the method's name for an operation and a collection, the
  handler's name for a binding of a named handler, and the attribute's name
  for an inline event handler;
- a declaration written with `X.for(cause)` or `h.for(cause)` in the
  reactive tier takes the cause in the place of the name. The cause is a
  string literal there, so the preimages below hold a name and no cause
  that is data. This is *assumed*, pending the project owner
  (`plan-and-label-templates.md` §1.3; `language-subset.md` §4.7);
- where two declarations of one pattern body have the same name by these
  rules, each takes the name and its ordinal among them, in source order.

A name is unique within one pattern body and is not a position among
unrelated declarations. The steps of `within` tell two bodies apart.

A `StateCell` of the plan that stands for a cell a function body creates
under a constant cause, or under the element key, is not identified by
this section. It has the preimage of section 5.5.

**Declared directly in the instance's pattern body**, outside every element
body and every compiled-in sub-pattern, under a name that is a variable's
and that no other declaration of that body has:

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

By ruling the cause is this fabric value as it stands. `createRef`
hashes it with `hashOf` (`base/data-model/src/value-hash/impl.ts`), and
nothing in it is a string that joins parts: a `<name>` of several
parts is the record that `plan-and-label-templates.md` §1.1 gives it
(`Name`), each step of `within` is a record, and an `<element key>` is
the record of section 5.3.

The record has a `type` and a `within` member no preimage of today has, so
it cannot equal one. These identifiers are new. Section 9 says what happens
to state stored under today's identifiers for the same declarations.

A child instance of the reactive tier keeps today's two steps where it is
declared directly in the pattern body: its output spot is the internal cell
of the call's name, and its result cell is `{ resultFor: <spot> }`. Declared
anywhere else, its result cell has the second form with type `child`. A
pattern called through `asInstance()` in an element body is such a
child: its result cell has the second form, with the call's name as
the cause and the `element` step of each enclosing collection in
`within`, which is the site, the collection and the element key that
the ruling identifies it by. The identifier does not depend on whether
the key is in the collection, so the instance is found again when the
key returns, in each of the three cases of a source.

Three consequences of the naming rule for what is stored.

- **Today's form for a repeated name is not reproduced.** Today a repeated
  name is `{ name, $generated: N }`, where `N` counts every anonymous cell
  of the body. The ordinal of the naming rule counts the declarations of
  that one name, so adding a declaration with another name moves nothing.
  Adding one with the same name before an existing one moves the ordinals
  after it, and state stored under them is not found again
  (`plan-and-label-templates.md`, open question 18).
- **A call that is bound to nothing**, such as a pattern used as a JSX
  tag, takes the callee's name, with an ordinal among the calls of that
  pattern in the same body where there are several.
- **A binding** of a named handler that is bound to nothing takes the
  handler's name, and an inline event handler the attribute's name.

A part document whose path passes through no row is named by the same
record with type `part` and a path in place of the name. A part that is
a row or lies below a row is named by type `part` and a number that the
runtime mints, and by no element key (section 4.10; provisional, P28).
A chunk document is named with type `chunk` and a serial number
(section 4.10; provisional, P20).

An output document is named by the same record with type `output`, the
`within` of the output's cone, and as the cause the name of the interim
value with the output's path. It holds an interim output that is a
plain array generated from scratch and that has to have an address:
one that a per-element construct is over, or that is given whole to an
instance of its own (section 2.5). That is *assumed*
(`plan-and-label-templates.md` §8, question 157).

### 5.3 Element keys and the salt

The `key` of an `element` step has an element part and an occurrence
count. By ruling it is a fabric value and has no written form of this
design: a record of the members `element` and `occurrence`, which
`createRef` hashes with the rest of the cause, and which
`jsonFromFabricValue` (`base/data-model/src/codecs.ts`) writes where a
key has to stand as a string (`plan-and-label-templates.md` §1.2,
"Written forms", and §1.3, "The structure of a key"). In the stored
path of a reference by key it stands as the record, which is *assumed*
(its §8, question 156). The names of the members are *assumed* (its
§8, question 144).

- The element part for a position that holds a link is the record of
  the address that the link resolves to: the space, the identifier of
  the document, the scope, and the path, with the members `space`,
  `document`, `scope` and `path`. That is the case of an array of
  references. The ruling on the identity of such a cell lists the four
  parts, and `cellIdentityKey` in
  `runtime/runner/src/builtins/scope-policy.ts` forms today's key from
  them. *Assumed* (its §8, question 153): the scope is a member, absent
  where the link names none. The scope of the link then enters the
  identifiers of what the element body holds, through the key. That is
  apart from the scope instances of section 5.1, of which one
  identifier has one per scope key.
- The element part for a position that holds a plain value is the hash
  of a secret of the space and the value: what `hashOf` returns for the
  record of the two, a `FabricHash`. Where the
  array declares key fields with the array type
  `ArrayByKey<T, "field">`, by ruling the element part holds the list
  of the field names and one hash of the same secret and the combined
  values of those fields: a record whose member `fields` is the array
  of the names, in the order of the names, and whose member `hash` is
  the hash of the secret and the array of the values of the fields in
  that order. It does not hold the
  values, and a reference by key that holds it is resolved from the
  key alone: the resolver reads the names, combines those fields of
  each element of the array, hashes, and compares
  (`plan-and-label-templates.md` §1.3, "A declared key field"). A hash
  in an element part is written as the helpers write one, with its
  algorithm tag. The case is an array of plain values in place, a
  plain array generated from scratch included.
- The occurrence count is the number of earlier positions of the
  collection that have the same element part. It is in every key, so no
  two positions of a collection have one key.
- The position is in no key, also where the body uses the index. A cone
  that reads the index is given it as a slot (section 2.5).
- For a collection that is the result of a per-element construct, the
  key of an element is, by ruling, the key of the upstream element it
  came from, and no key is computed from what the result holds
  (`plan-and-label-templates.md` §1.3). The identifiers of what a body
  applied to a `map` or a `filter` result holds per element therefore
  derive from the keys of that construct's source.

The secret is a runtime secret of the space, minted and read by the runtime
alone (`ensureRuntimeSecret`, described in
`runtime/runner/src/runtime-secret.ts`), under a name of its own so that it
is not the salt `sqliteQuery` uses for row documents. Executed code cannot
read it, and it is stored under a label no reader's ceiling admits.

The identifier of a part document holds no key (section 4.10;
provisional, P28): it is stored in a storage link, which carries no
label, where a reader of the collection's membership can see it, and it
is minted and derived from nothing of the element. In every identifier
that holds a key, a key that is a cell's identity enters as it is.

Two consequences.

- **The memo needs no salt.** A key that only indexes the element table in
  memory never enters an identifier. The runtime may use the unsalted hash
  there.
- **A client cannot read the secret**, by ruling. A reader who could would be
  able to confirm a guess at a confidential value from an identifier, which is
  what the salt prevents. By ruling the key of a plain value with declared key
  fields holds a hash under the same secret, so what follows holds alike for a
  key formed from a whole value and for a key that names its fields. A client
  therefore cannot name per-element state over
  plain values, a stream bound in an element body at a key that holds a value
  hash, a child under such a key, or a binding with copied paths before the
  server stores a link to it, and it learns such an identifier from the stored
  link. It cannot derive the identifier of a part document at or below a row of
  a kept collection, which is minted and derived from nothing, and does not
  need to: it names the result cell and a path, and reaches the part through
  the storage link (section 4.10). A speculative
  handler that makes a binding with copied paths cannot name the stream the
  server will name. What a client shows for such state before the server's
  result arrives belongs to `scheduler-and-serving-loop.md`.

A state cell over plain values is keyed by a salted value hash and an
occurrence count, and so is a stream of a handler bound over plain
values. Two equal values have two counts, so they share neither.

### 5.4 Cells and instances a handler invocation creates

Each handler invocation is a new frame. What it creates without an
explicit cause is new on every event: the occurrence is identified by the
handling and by its order in the invocation, so its identifier derives
from the event, as today.

```text
createRef({ request: <ordinal> }, { handling: <receipt identifier> })
```

- **The handling** is identified by the receipt, by ruling: the durable
  event identifier and the stream it was sent to (`handlingReceiptId` in
  `runtime/runner/src/scheduler/event-identity.ts`). A retry of the same
  event on the same stream is the same handling. The event key of today
  also names the acting principal (`deriveEventKey` in the same file). The
  receipt leaves the principal out, so that one event on one stream is one
  handling whoever sends it. The identifier is the same in a client's
  speculative run and in the served run.
- **The ordinal** counts the body's requests of every kind in the order
  they were made: cells, instances, effects. A request under an explicit
  cause is counted like any other, although its own identifier does not
  hold the ordinal. A retry with the same control flow names the same
  things.
- **An event the handler sends** to a stream is identified by the handling
  and the event's order among the events that invocation sends
  (`plan-and-label-templates.md` §1.3). The speculative run and the served
  run of one handling therefore name the same event.
- **A request under an explicit cause**, which is a cell created with
  `X.for(cause)` or an instantiation with `.for(tag)`, is identified by
  the enclosing instance, the handler and the cause, without the
  handling, by ruling
  (`plan-and-label-templates.md` §1.3). Its preimage is the one section
  5.5 gives a cell or an instance, with the handler's name in the plan as
  `<body name>`, the handler's `within`, and, for an instance, the cause
  in the place of the ordinal. The rules are these.
  - **The same thing on every event.** Two events whose handler requests
    under equal causes name one cell or one instance. Two handlers of one
    instance that pass equal causes name two, as two bodies do (section
    5.5).
  - **First creation.** The transaction of the first event that requests
    it and commits stages its documents: for a cell the document with
    the initial value, and for an instance the documents of section 4.6.
    The existence label is fixed there. It is the template of the cause
    as that transaction instantiated it, because which document exists
    shows the cause's value (`plan-and-label-templates.md` §3.14).
  - **A later event** that requests under an equal cause finds what is
    stored. The request returns the handle or the link, stages no
    document, does not write the initial value again, and does not
    change the existence label. A read through the handle or the link is
    journaled, as a read through any handle of `Body.handles` is
    (section 1.4). *Assumed,* with `plan-and-label-templates.md` (its
    open question 39): a later event that instantiates under an equal
    cause does not write the argument it passes, so the instance keeps
    the argument the creating event wrote.
  - **An identifier a client can derive.** The cause enters the
    identifier unsalted (`plan-and-label-templates.md` §1.3), so the
    speculative run names the same cell or instance as the served run.

  Today every identifier minted in a handler's frame derives from a cause
  that holds the event identifier, the ones under an explicit cause
  included, so this is new behavior and not a carried-over one.
- **A binding** made in a handler is identified as in section 5.5.

The identifier of a requested instance is that of its result cell. Its
argument document derives from the result cell as today.

Nothing here has to match today's bytes. A cell or an instance a handler
created before a migration is reached through the link the handler stored,
not by deriving its identifier again. The one case in which both
derivations could name something is an event handled by the current runtime
and delivered again to a compiled instance, and the receipt refuses the
second handling.

### 5.5 Cells, bindings and instances a re-evaluated body creates

A `lift` or a `computed` is evaluated any number of times, so what it
creates is never identified by its order among the body's requests.

```text
a cell:      createRef({ cell: <cause value> },
                       { parent: <result cell entity id>, site: <body name>,
                         within: [ <step>, … ] })

a binding:   createRef({ binding: <handler>, bound: <bound keys> },
                       { parent: <result cell entity id> })

an instance: createRef({ instance: <ordinal> } | { cause: <cause value> },
                       { parent: <result cell entity id>, site: <body name>,
                         child: <child name>, within: [ <step>, … ] })
```

- `<body name>` is the name of the `lift` or `computed` in the plan, by
  the naming rule of section 5.2. It is not the body's code, so that
  editing the body does not rename what it addresses. Two bodies of one
  instance that pass equal causes address two cells, as today.
- A cell created under a constant cause, or under the element key of the
  enclosing element body, is a `StateCell` of the plan. The `StateCell`
  records the body's `within` and a `name` formed from the body's name and
  the cause, and the `createCell` site of `Body.calls` refers to it by
  index (`plan-and-label-templates.md` §3.14). Its document has the
  preimage of a cell above, with the constant, or the element key of
  section 5.3, as `<cause value>`, and not the preimage section 5.2 gives
  a declared state cell. A slot with root `state` that names the
  `StateCell` is bound to that document, so the cone that reads the cell
  and the body that creates it address one document.
- `<handler>` is `Body.code` of a handler of the plan, or the content
  address of a handler factory value.
- The preimage of a binding holds no `within`. A binding is identified by
  the enclosing instance, the handler and what it holds, and not by the
  place it was made at (`plan-and-label-templates.md` §1.3 and §3.14). A
  `computed` inside an element body, or inside a compiled-in call, that
  binds one handler to equal state for two element keys or at two sites
  makes one stream. For two element keys that is *assumed* there, beside
  the ruling that everything an element body holds is per element key
  (its §8, question 90).
- `<bound keys>` holds one key per path of the handler's state, by what
  `Binding.state` records for the path. For a copied path, a scalar or a
  container the body computed, it is the salted hash of what the binding's
  state document holds there, by the rule of section 5.3. For a cell
  handle it is the identity of the cell. For a container bound by
  reference it is the address the container was read from. For a path
  that holds a reference on some runs only, it is the address on the runs
  on which the runtime stores a link, and the salted hash otherwise. Two
  bindings to equal records stored in two places are therefore two
  streams.
- The binding state document and the stream have this identifier, with the
  types `binding` and `stream`. A binding made in a handler is identified
  the same way and not by the handling.
- For an instance, `<body name>` and `within` are the body's, and
  `<child name>` is `Child.name` of the site. `<ordinal>` is the ordinal of
  the instantiation among those this evaluation makes at that site, and
  `<cause value>` the cause of a `.for(cause)`, which takes the place of the
  ordinal. This is the rule of `plan-and-label-templates.md` §1.3, and it is
  ruled (section 2.8). An evaluation counts the instantiations of one site
  from zero, in the order it makes them, so two evaluations that make the
  same number of instances at a site name the same instances, whatever each
  is made for. A cause is compared by its canonical form, so two
  instantiations at one site under equal causes name one instance. The
  record has members no preimage of today has, so the identifier is new:
  today such an instance is a node of a pattern synthesized from the
  computation's frame (section 2.8).

A binding of the reactive tier is not identified this way. It has a name,
and its stream has the identifier of section 5.2.

A cell a `lift` creates by a cause computed from data is the target of a
materializer write (`plan-and-label-templates.md` §3.14). Today's preimage
for such a cell holds the lift's `{ inputs, outputs, fn }` record, which
changes with the lift's source text and its input schemas and is not
reproduced. These identifiers are new. The cells hold what the lift wrote
and are written again on the first evaluation.

### 5.6 `inSpace`

The identifiers of an `inSpace` request are known when the body makes the
request, before the commit that spans both spaces, so the body can read
`spaceOf` of the returned link in the same invocation.

- **The instance.** With `root: true` the result cell is the one the
  target space reserves for its root (`inSpaceRootCause` in
  `runtime/runner/src/in-space-root-cause.ts`). Otherwise it is the
  identifier of section 5.4, or of section 5.5 for a request a computation
  makes, in the target space.
- **A space that exists.** For a target given as a space identifier or as
  the space of a cell, the identifier is the given one.
- **A space the request creates.** Its identifier is obtained and not
  derived from the request, by ruling: creating a space returns a new
  identifier ([random space identities](../random-space-identities.md)).
  The runtime records the allocation in the calling space: the obtained
  identifier, under the name the request gives, or for an anonymous target
  under the request's own identifier. The request's own identifier is the
  one section 5.4 gives the occurrence, or section 5.5 for a request a
  computation makes. It is the identifier of the instance requested,
  except with `root: true`: the instance then takes the root the target
  space reserves, whose identifier derives from the identifier of that
  space and so cannot name the record that yields that identifier
  (`plan-and-label-templates.md` §3.14). The record is written in a step
  that commits before the step in the other space, so that a retry finds
  it and names the same space.
- **The allocation record** is a document of its own in the calling space.
  It holds the identifier of the space, as `did`, and nothing else. Its
  identifier is

  ```text
  createRef({}, { inSpaceAllocation: { space: <calling space>,
                                       name:  <name> } })
  ```

  where `<name>` is the name the request gives, or for an anonymous target
  the request's own identifier. For a named target this is the preimage
  of today's record (`#inSpaceAllocationCell` of `Runtime` in
  `runtime/runner/src/runtime.ts`), so a name the current runtime
  allocated resolves to the same space. For an anonymous target today's
  name is a hash of the frame's cause and a counter (`anonymousSpaceName`
  in `runtime/runner/src/builder/pattern.ts`), which is not reproduced.
  The record belongs to no instance: two instances of one space that
  request the same name find one record.

Today a named target is resolved through an allocation record in the
calling space. When no record exists, the first run finds the target
unresolved and is discarded, the runtime creates the space, and the handler
is run again. That run writes the record in its own transaction, with its
other writes (`resolveInSpaceTargetSpace` in
`runtime/runner/src/builder/pattern.ts`; `resolveInSpaceNameSync` and
`resolveInSpaceName` of `Runtime` in `runtime/runner/src/runtime.ts`).

In this design the order is as follows, for the runtime that executes
authoritatively.

1. The body makes the request. If the calling space's allocation record
   names a space, the request returns its identifier.
2. Otherwise the runtime obtains a new identifier when the request is made:
   it generates the key pair of a new space, whose public key determines
   the identifier. The request returns it, and the body goes on. The body
   is not run a second time.
3. The body stages the allocation record as one of its writes. The record
   carries the body's template, because that a space exists under a name
   depends on what the body read. It is a write of the unit that makes
   the request, the handler's or the making cone instance's, that commits
   ahead of that unit, and it is instantiated from stored labels only
   (`plan-and-label-templates.md` §3.14 and §4.6).
4. When the transaction commits, its steps are applied in this order: the
   genesis commit of the new space, which makes the acting principal its
   owner; the allocation record, by itself; the step that writes the
   instance's documents in the other space; and the home step. Where the
   transaction also staged changes to access lists, they are applied
   after the allocation record and before every batch of writes to
   another space: genesis, allocation record, access changes, the
   batches for other spaces, home (`scheduler-and-serving-loop.md` §9.4).

A transaction that is rejected or aborted applies no step, and the key pair
is discarded. A failure after the genesis commit and before the allocation
record leaves a space that is named by nothing and holds only its genesis
commit, as a failed creation leaves today. A failure after the allocation
record committed leaves the record: the event runs again, finds the record
in step 1, and names the same space, so its step in the other space writes
the same documents. The record also stays where the commit withdraws the
unit that made the request after the record committed. It is the one
write that can commit without its unit, and §4.6 there states it as the
exception to the property the units keep.

*Assumed:* the runtime can generate the key pair without waiting, inside
the body's invocation, for example from key pairs it generated ahead. If it
cannot, the invocation ends without a result, the runtime obtains the
identifier, and the event is dispatched again, as today. The genesis commit
is applied ahead of the allocation record, so that a record never names a
space that does not come to exist: the private key signs the genesis commit
alone and does not survive the process
([random space identities](../random-space-identities.md), "Identity and
genesis"). The step of the ruling, the one in the other space that the
record has to precede, is read as the step that writes the instance's
documents (section 11, question 47).

Where these steps sit in the sequence of commits of a cause that crosses
spaces, and what a client's speculative run of the same handler does when
no record exists, belong to `scheduler-and-serving-loop.md` (§9.4 there). A
client does not create a space.

### 5.7 What stays byte-identical

| Identifier | Same bytes as today |
| --- | --- |
| The result cell of an instance | Yes. The compiler does not derive it |
| The argument document | Yes. It derives from the result cell |
| A state cell or a stream declared directly in the pattern body under a variable's name that no other declaration of the body has | Yes for the hash. The scheme is taken from the stored manifest for a migrated instance |
| A child instance declared directly in the pattern body, where today's call has a name as its partial cause | Yes |
| A state cell, stream or operation inside a compiled-in sub-pattern | No. Carried over by record where section 9.3 allows |
| Anything inside an element body | No. Not carried over |
| A cell, instance, effect or sent event a handler requests | No, and nothing depends on it |
| A cell or binding a `lift` or a `computed` creates | No. Recomputed |
| An instance a `lift` or a `computed` makes | No. Set up again by the first compiled evaluation |
| A part document | Not applicable. It has no counterpart: today a row's tree is in the row's own result document |
| The state of a structural operation: a conditional's store, a `map` container, an aggregate's tree | Not applicable. These documents have no counterpart, or a new one under section 6 |

## 6. Durable state of operations

`builtin-inventory.md` says which operations have durable state: the
aggregates, `reduce`, the collection index, every effectful built-in, and
a `sqliteDatabase` declaration.
`plan-and-label-templates.md` records each as an `Operation`, with a forced
cache (section 8.5) and a materializer beside them, and gives the label of
its result and of the rest of its state. This section says where the state
is stored, under what identifier, and how it is rebuilt.

One operation has one state document per scope key its cone instance is
evaluated for. Its identifier is that of section 5.2 with type `operation`:
the instance, the enclosing sites and element keys, and `Operation.name`. An
operation a handler requests has the identifier of section 5.4. The
documents of aggregates, `reduce`, indexes, caches and materializers can be
recomputed and take the `computed:` scheme. The document of an effect
cannot and takes `of:`. The document of a database declaration cannot
either: it is written once and takes `of:` (section 6.8).

An operation's state document is a store the runtime owns: the runtime
alone writes it, and no authored schema declares a label for it
(`plan-and-label-templates.md` §2.6).

**An operation inside an element body** has one state document per element
key. `plan-and-label-templates.md` §2.6 leaves to this document whether
that is one document per key, or one document per operation with the
state of each key at a path of its own, and the choice changes no label.
This document chooses one document per key. The element key is a step of
`within` in the identifier (section 5.2), a key derived from a value is
the salted one (section 5.3), and the state of one key is labeled by the
table of §2.6 there, instantiated for that element. A change to one
element then writes that element's state document and no other, a
document is created when its key is first evaluated, and the state of a
key that left its collection stays stored by itself, by ruling (section
2.6). No
document holds the state of several keys of the enclosing collection, so
there is no key set that would need the collection's membership label.
The cost is that the number of documents grows with the number of
elements.

The state of one key belongs to the one position that holds the key, and
carries the label that position's slots resolve to (section 2.5, "What
is stored per key").

The keys an aggregate or an index holds contributions for are those of
the collection the operation folds, and they are paths of the operation's
own state document (sections 6.1 and 6.3). They are bookkeeping, and
their label is the confidentiality of `Operation.input`, which joins the
membership of that collection (section 6.5).

### 6.1 Aggregates

- **State.** Per element key: the contribution (a count, a truthiness, a
  number, a key function's result). The folded value, in the
  representation the operation needs to
  update it in constant time, such as the exact partial sum for `sum`. For
  `minBy` and `maxBy`, the winning key. The multiset of label identifiers
  the fold joins, as a count per identifier
  (`plan-and-label-templates.md` §4.3).
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
- **The three cases.** The fold is in the order the collection iterates,
  and the state is the same, over an array of references, over an array
  of plain values in place, and over the result of another per-element
  construct. In the baseline the fold is not kept per key, so one
  changed element evaluates every step (`plan-and-label-templates.md`
  §3.13).

### 6.3 Collection indexes

- **State.** Per element key: the index key the key function produced.
  Per index key: the bucket, as the element
  references in source order for `group` mode and the winning reference
  for `key` mode. The set of occupied index keys.
- **Readers.** `lookup`, `keys` and `keyEntries` read paths of this
  document. A bucket's label entry holds the bucket's membership template
  instantiated (`plan-and-label-templates.md` §3.17).
- **Rebuild.** Evaluate the key function cone of every key and bucket the
  elements.

### 6.4 Effects

An effect operation has transactions of its own, which
`scheduler-and-serving-loop.md` §6 owns. This section says what its state
document holds and which transaction writes each part.

- **State.** The stored request; the hash of the request, the claim and
  the pending mark; and the settled result or error
  (`builtin-inventory.md` lists them per built-in). For `sqliteQuery` also
  the row documents, and for the language-model built-ins the conversation
  where a tool loop is to survive a restart.
- **Layout.** Provisional (P14; section 11, question 100). The state document
  has three members. `request` holds the stored request: the one argument of the
  call, or, for a call with several arguments, the array of the arguments in the
  order they are written, each as the call binds it, a cell that is passed on as
  a link. `requestHash` holds the hash. `outcome` holds the record that a reader
  reads, with `pending`, `result` and `error`. A link to the result of an
  effect, as the one a handler stores, names `outcome`, so it leads to those
  three members and not to the request. The request transaction follows every
  reference of the stored request. Where `builtin-inventory.md` gives a built-in
  an operand that is not followed, or followed to a depth, that entry governs,
  and the prototype does not have it. The schema that today's compiler adds to a
  `fetchJson` request is no part of `request` under this layout, which that
  entry has as part of the request and of its hash.
- **What a reader reads.** Provisional (P12): before the first request
  transaction of the operation the document holds `request` alone, and
  `pending`, `result` and `error` read as nothing. While a newer request is
  outstanding, `outcome` holds the pending mark and the result or the error of
  the request before it (`scheduler-and-serving-loop.md` §6.2). Provisional
  (P459 of the prototype): where a request is not made because it holds an
  error state (`scheduler-and-serving-loop.md` §6.2, step 1), `outcome` holds
  that error state and no request is outstanding, so the next request that
  holds none is made. A read of a path below the outcome then reads the error
  state, as a read of a member of a value in an error state does
  (`plan-and-label-templates.md` §5.2), and a cone that passes the result on by
  reference reads nothing of the state document.
- **A `wish`.** Provisional (P15; `builtin-inventory.md`, open question 18). A
  `wish` has no request transaction. The evaluation that stages its operands
  resolves it, in the transaction of the reader, and nothing is handed to the
  outbox.
- **The request, in the reactive tier.** A cone computes the request. Each
  path of it is a write edge of that cone with target `request`, staged
  into the operation's state document in the derivation transaction that
  evaluated the cone, with the template of the expression at that path
  (`plan-and-label-templates.md` §3.14). The request is a derived write
  and not a kept output: nothing reaches it from the result cell. A
  request path whose cone failed holds the error state, and such a request
  is not made: the operation's result is that error state.
  Provisional (P16; section 11, question 101): the request is formed by one
  function of the cone, so where that function fails, the stored request holds
  one error state for the whole request, and not an error state at the path
  whose expression failed beside values at the other paths. The readers of the
  operation's result fail in turn under both.
- **The request transaction** is the operation's own. It reads the stored
  request, computes the hash, checks the gates, the egress ceiling among
  them, writes the hash and the pending mark, and hands the request to the
  outbox. The ceiling is checked on the request's templates joined with
  what following the references the request holds consumes. Which
  operands of a request are references that are not followed is in the
  "Request operands" paragraph of each effectful built-in in
  `builtin-inventory.md`. A failure
  rejects that transaction and no other, and the operation's result takes
  the refusal as an error state.
- **The request, in a handler.** The event's transaction stages the stored
  request, its hash and the pending mark when the body returns (section
  1.4). The egress ceiling is a constraint on what the handler itself
  writes, so a failure rejects the event. The request is sent when the
  event's transaction commits.
- **What names a handler's operation.** An operation a handler requested
  is no `Operation` of a plan, and its identifier derives from the
  handling (section 5.4), so nothing in the instance's plan or documents
  leads to it. Its state document therefore holds a `result` back-link to
  the result cell of the instance whose handler requested it, as a state
  cell document does, written with the request. While the operation is
  pending it also has a pending-effect row beside the basis index, which
  names the operation's state document, the instance's result cell, and
  the requester, the principal the event was stamped with. Only an
  operation a handler requested has one. The row is written in the store
  transaction that commits the event, and deleted in the one that clears
  the pending mark, or when the instance is torn down. After a restart or a
  park, activation reads the rows to find the operations whose requests
  have to be made again, and the back-link gives the instance an
  operation belongs to when that instance is torn down
  (`scheduler-and-serving-loop.md` §2.3 and §10.6). The row is not a
  document, and `plan-and-label-templates.md` §2.6 gives it the label of
  the other rows beside the documents.
- **The send transaction** is the operation's own as well, and only a
  language-model built-in has one. Such a built-in sends content after
  its request was checked: the result of a tool call, a system prompt
  rendered again from live context, and a dialog's live transcript with
  each model call. By ruling, the egress ceiling is checked again on each
  of those sends, in a transaction that reads what the send will hold
  (`plan-and-label-templates.md` §3.14, "Each later send is checked";
  `scheduler-and-serving-loop.md` §6.3). Where the operation stores the
  conversation, that transaction writes the part the send adds, and
  otherwise it writes nothing. A send that fails the check is not made.
  The failure rejects that transaction and no other, no further send is
  made for the request, and the operation's result takes the refusal as
  an error state, which the completion transaction writes. What the
  effect stored before the refused send stays stored, and the event
  whose handler requested the effect is not rejected.
- **The completion transaction** is the operation's own as well. It writes
  the settled result or the error with the label the boundary declares,
  clears the pending mark, and commits by itself. That commit dirties the
  `operation` slots bound to the result, which is a cause of the third
  kind (section 1.1): the commit joins the set of changes of the cycle
  that follows, and the derivation transaction of that set evaluates the
  demanded cone instances that read the result. They are two transactions
  because the result exists whether or not anything reads it. A cone that
  reads the result and fails, or whose write a constraint drops, therefore
  cannot lose the result.
- **Label.** For the result, the declared rule of the boundary
  (`builtin-inventory.md`), over the request's label, which is the join of
  the request's templates and of what its references lead to. The hash,
  the claim and the pending mark carry the joined label of
  `plan-and-label-templates.md` §3.14: the hash is computed from the
  content behind the references the request holds, so the confidentiality
  of `Operation.input` alone would not cover it. For a request a handler
  made there is no `Operation`, and the join is over the templates of its
  `request` write edges (section 6.5).
- **If lost.** An effect's result cannot be recomputed. When the state
  document is absent, or its request hash differs from the current
  request's, the effect is requested again. Loss therefore repeats the
  request.
- **On a client.** A client has no effect operations and requests no
  effect. Its speculative transaction computes the request, and the result
  reads as pending when the request's hash differs from the stored one
  (`scheduler-and-serving-loop.md` §6.7). There is one exception, by
  ruling: a client enacts `navigateTo` from its speculative run, and the
  enactment is reconciled with the server's result as it is today. It is
  the one effect a client enacts.

### 6.5 The label of bookkeeping state

`plan-and-label-templates.md` §2.6 gives the label of every path of an
operation's state document. The result of an operation, a bucket of an
index and a checkpoint of a `reduce` carry the label the operation's rule
gives them. Every other path of an operation that is not an effect
carries the confidentiality of `Operation.input`, instantiated, and no
integrity: a contribution per element key, an index key per element key,
and a count. The request hash, the claim and the pending mark of an
effect carry more: the confidentiality of `Operation.input`,
instantiated, joined with what following the references of the request
consumed, and no integrity, which is the joined label of §3.14 there. For
a request a handler made, the join is over the templates of its `request`
write edges in the place of `Operation.input`. A path that holds label
identifiers, such as the count per identifier a fold keeps, also joins the
label of the label-metadata observation of each label it names.

The runtime reads these paths only as its own bookkeeping, and no template
has a slot for them, so their label is never joined into an output. It
governs a reader that reaches the document by some other route.

### 6.6 Currency

The state of an aggregate, a `reduce`, an index or a forced cache is
updated in the derivation transaction of the cause that changed its input,
when the operation is demanded. When it is not demanded it stops being
current, like a kept output: the basis rows of its cone instances stay
behind the heads of their inputs
(`scheduler-and-serving-loop.md` §10.4). On a later demand the scheduler
marks the stale element keys from those rows, and the operation updates
the contributions of those keys (section 3.4). Where the rows do not say
which keys are stale, the state is rebuilt.

An effect's state is not updated this way. Its request is staged by the
cone that computes it, and its hash, its pending mark and its result are
written by the operation's own transactions (section 6.4). A
materializer's result is written by its own run (section 6.7).

State is discarded and rebuilt when the compiled pattern changes in a way
that changes the operation: its `implementation`, its `input` template, or
the code of its per-element cone. The state document records the content
address of each of the three for that comparison. The handle of a
database declaration is never discarded (section 6.8).

### 6.7 Materializers

A `lift` or a `computed` with a write that has no static target is a
materializer: an `Operation` of kind `materializer`, implemented by the
body, for all of its writes (`plan-and-label-templates.md` §3.11). When it
runs is `scheduler-and-serving-loop.md` §7.

- **Where it runs.** Not inside a cone and not through `host.invoke`. Each
  run is a transaction of its own, with today's label rule: every path it
  writes carries the join over everything the run read, trigger reads
  included.
- **State.** One state document, which holds the value the body returned,
  at the operation's result path, under that transaction's join. The read
  set of its last run is the scheduler's record and is not stored here.
  Whether that run is still valid after a restart, or after the instance
  was released and loaded again, is decided from basis rows: a
  materializer has rows of its own, keyed by its index in
  `Plan.operations`, marked as an operation, in the place of a cone's
  index. They are written when the writes of a run reach storage, one
  per document the run read. The scheduler registers a row entry at each
  document they name until the materializer's first run in the process
  gives it a read set (`scheduler-and-serving-loop.md` §7.2 and §10.4).
- **How a cone reads the result.** Through a slot with root `operation`,
  and the cone's template for the value is that `slot`. The materializer's
  commit dirties the slot, which is a cause of the second kind.
- **Its inputs.** The runtime materializes the slots of `Body.reads` and
  hands the body its handles in the materializer's transaction, as section
  2.4 says for any body. A computed input, an entry of `Body.computed`, is
  an output of a cone of the instance. *Assumed:* the materializer's
  transaction takes it from the memo entry of the producing cone instance
  where that entry is current, and adds the entry's reads to its own read
  set. Where the entry is not current, it evaluates the cone instance for
  its value and stages none of its writes: the cone instance's kept
  outputs are recorded as unstored (section 3.3), and the next derivation
  transaction that demands them stores them. A producing cone instance
  that performs a side-write is not evaluated there. The materializer then
  runs behind the derivation transaction that evaluates it, which is the
  scheduler's to order. A cone instance that reads the materializer's
  result meanwhile reads what is stored and is made stale by the
  materializer's write. A handler that reads it waits (section 1.3). A
  computed input joins the run's label with its instantiated template.
- **What it creates.** A cell the body creates under a cause computed from
  data has the identifier of section 5.5 and is reached through whatever
  link the body stored.
- **If lost.** The materializer runs again.

### 6.8 Database declarations

A `sqliteDatabase` declaration is an `Operation` of kind `database`
(`plan-and-label-templates.md` §3.14). It has no request, no transaction
of its own and no cone. Its state is the database's handle.

- **Stored once, not recomputable.** The state document holds the handle:
  `id`, `tables`, `scope`, `owner` and `rev`. Two of its members cannot be
  computed again. The `owner` is the acting principal of the transaction
  that first wrote the handle, and a later transaction has another
  principal or none. The `rev` is the revision that each write of
  `db.exec` advances. A third,
  the `id`, names the database and has to stay what it was first written
  as, whatever the document's identifier is (the migration, below). The
  document therefore takes the `of:` scheme, like an effect's, and no
  step of this design rebuilds it.
- **Identifier.** That of section 5.2 with type `operation`: the
  instance, the `within` steps and `Operation.name`. One document exists
  per scope key of `Operation.scope`, the scope the declared type of the
  handle gives. The identifier holds nothing of the `tables` option, so
  a change to the table declarations names the same database
  (`builtin-inventory.md`, "`sqliteDatabase`").
- **The first write.** The first transaction that resolves a slot with
  root `operation` to the handle, for a scope key, and finds no document
  stages the handle: the `id`, which is the document's own identifier
  without its scheme, as today; the `tables` of the plan; the `scope`;
  and the `owner`, the acting principal of that transaction. A
  transaction with no acting principal writes no `owner`, and the handle
  stays without one, which is the assumption of question 69 of the
  continuation plan. The handle is a write of the runtime and not of a
  cone or a body, so no constraint of a template applies to it.
- **Later writes.** A transaction that finds the document changes two
  members and no other. It merges the `tables` of the plan into the
  stored ones, grow-only, when the compiled pattern's declarations
  differ, as `growOnlyMergeDbTables` in
  `runtime/runner/src/builtins/sqlite-builtins.ts` does today. And a
  `db.exec` in a handler advances `rev`, in the event's transaction. No
  transaction writes `id` or `owner` again, and an `owner` that is
  absent stays absent.
- **A change of the compiled pattern** discards nothing here. The rule of
  section 6.6 that rebuilds an operation's state does not apply: a source
  update keeps `id`, `owner` and `rev` and merges the tables.
- **If lost.** The handle cannot be rebuilt. A first write that follows
  the loss derives the same `id` for an instance that was not migrated,
  so the same database is named, and it takes the `owner` from the
  acting principal of that transaction, who can be another principal.
  Loss of the document is therefore loss of who owns the database.
- **Migration.** The identifier of the compiled layout is not today's:
  today the handle is a cell under the cause
  `{ sqliteDatabase: { result: cause } }`, and its `id` is that cell's
  identifier (`sqliteDatabase` in
  `runtime/runner/src/builtins/sqlite-builtins.ts`). *Assumed:* the
  switch of the space copies the stored handle into the operation's
  state document as it is, in the setup transaction that writes the
  instance's compiled setup (section 9.4), with its `id`, its `owner`, or
  the absence of one, and its `rev`. The `id` of a migrated instance
  then names the database the instance had, and is not the identifier
  of the document that holds it. The stored handle is found as the
  carry-over record finds a state cell (section 9.3).
- **Label.** The declaration has no label rule of its own
  (`plan-and-label-templates.md` §3.14), and the table declarations the
  handle holds carry the rules that queries and writes enforce. This
  section adds none. *Assumed* there (its open question 40): the state
  document itself carries the label of an operation's bookkeeping state,
  which is empty for a database, so the handle carries no label beyond
  what the table declarations declare (section 11, request 66).

## 7. Provenance

A kept output records where its value and its label came from: the
template, the identities bound to the template's slots, and the identity of
the compiled pattern. An interim value has no stored provenance. Its
template is a sub-template of every kept output that depends on it, by
reference and not by copy: the template of the kept output names it with
an `output` node, or names an output that does
(`plan-and-label-templates.md` §3.2, "A reference to an output").

### 7.1 Per document

The result document names the compiled pattern that wrote its layout. A
part document names it through its `result` link:

- the pattern reference (`patternIdentity`), which names the authored
  program's export as today;
- in the setup record, the `CompiledPattern` hash, which fixes the plan,
  the value code and the compiler build.

*Assumed:* the pattern reference continues to name the authored export, and
the setup record is where the compiled artifact is named. Which of the two
a deployment accepts builds by is `plan-and-label-templates.md` §7.2.

### 7.2 Per kept output

The envelope of the document that stores a kept output path holds, beside
the label map, one provenance record for the path where it has a label
entry or a dynamic part. A record of a path inside a part document is in
that part's envelope, at the path relative to the part's root.

```ts
type Hash = string;
type Index = number;

/** Provenance of one kept output path, stored in an envelope. */
export interface OutputProvenance {
  /** The output's path, relative to the root of the document it is in. */
  readonly path: readonly string[];
  /** The slot-free hash of the output's template. */
  readonly template: Hash;
  /** Hash of the instantiation key the stored label was computed from. */
  readonly key: Hash;
  /** The branch taken at each selector the template reaches. */
  readonly selections: Readonly<Record<Index, number>>;
  /**
   * The key chosen at each choice point the template reaches, by index
   * into `Plan.picks`.
   */
  readonly picks: Readonly<Record<Index, string | undefined>>;
  /**
   * Addresses the output depends on that the plan does not name, by index
   * into `Plan.dynamicReads`: what was read through links and handles, and
   * the trigger reads the scheduler held for the node.
   */
  readonly dynamic: Readonly<Record<Index, readonly string[]>>;
}
```

The identities bound to the template's slots are not copied into the
record where the plan and the document determine them:

- A slot with root `argument`, `state`, `operation` or `child` is bound to
  an address that follows from the instance and the plan (sections 4.1 and
  5.2).
- A slot with root `element` is bound to the element at the output's
  position, through the collection's source and, for a derived collection,
  the origins of section 7.3. A slot with root `index` is that position.
- A slot with root `event`, `cause` or `binding` belongs to a handler's
  write edge, not to a kept output.

**A template that names other outputs.** The template of a kept output
names the template of each output it reads with an `output` node and
holds no copy of it (`plan-and-label-templates.md` §3.2). *Assumed,*
provisional (P4; section 11.1, question 97): "reaches" in the comments
of `selections`, `picks` and `dynamic` follows `output` nodes. The
record holds an entry for each selector, each choice point and each set
of dynamic reads that the output's template reaches through the outputs
it names, each once, so that it holds what it would hold with every
template in place. `template` is the slot-free hash of the template as
it is written, and `key` covers the labels of the named outputs
(`plan-and-label-templates.md` §1.2 and §4.1; provisional, P2). The
record of one kept output then grows with what is upstream of it, and
question 97 has the alternative.

A template can also name an entry of the plan's template table with a
`shared` node (`plan-and-label-templates.md` §3.2, "A template written
once"; provisional, P6). "Reaches" follows a `shared` node as it follows
the same template written in place: the record holds an entry for each
selector, each choice point and each set of dynamic reads of the table
entry, each once, however many positions of the output's template name
the entry. `key` holds the identifier of the label of each entry that
the template names, as it holds that of a named output.

What is recorded is what cannot be derived: the selections, the chosen
keys and the dynamic addresses. A reader that wants the full chain for a
path takes the compiled pattern from the document, the `Output` and its
template from the plan, and binds the slots as above.

Like label entries, provenance records are shared across the positions of a
collection: one record at a `*` path covers the rows whose template,
selections and key are equal, and a row with dynamic addresses has a record
of its own.

The `key` member is what the preparation compares to decide that a stored
label can be reused (`plan-and-label-templates.md` §4.1, step 3). A write
that a failed constraint dropped, or that a conflict withdrew, leaves the
stored record as it was, so the stored value, label and key keep agreeing
with each other (section 3.3).

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
derived from data, so both have a label, which
`plan-and-label-templates.md` §2.6 gives.

- **A provenance record** carries the confidentiality of the output's
  instantiated label, joined with the label of the label-metadata
  observation at the path, and no integrity. A selection is a function of
  the value of a condition, and an address a body read is a function of
  the body's inputs, both of which the output's template joins. The label
  of the path's label metadata alone would not cover a selection.
- **Origin facts** carry the collection's instantiated membership label.

No template has a slot for either, so these labels never join the label of
an output. They govern a reader that reaches the stored record by another
route, and what the runtime may show of it in a diagnostic or to a tool.
The stored format is a host arrangement.

## 8. Cache promotion

Storing a pure derivation does not change what a pattern means, so whether
to store one is the runtime's decision. The overview lists the cost model as
open. This section proposes one. The constants in it are placeholders until
stage 4 of the overview's staging measures them.

### 8.1 What can be promoted

A cone is a candidate when all of these hold:

- it has at least one interim output. A cone whose outputs are all kept is
  already stored, and its stored values are read in place of an evaluation
  when the cone instance is current in storage (section 3.4);
- it performs no side-write and makes no instance (section 2.8);
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
| `repeats` | The number of evaluations in which no slot, dynamic read or upstream output of the cone instance had changed since its previous evaluation, or since its basis rows were last advanced (section 3.4). These are the evaluations a stored entry would have replaced |
| `changes` | The number of evaluations that followed a change. Each would rewrite a stored entry |
| `size` | The stored size of the cone's outputs and of their label entries |
| `label` | The mean time to instantiate the outputs' templates when their key changed. A promoted output is labeled; an interim one is not |

`repeats` is the quantity that matters. The in-memory memo already serves a
cone instance whose entry exists, so a repeat happens only when the entry
was absent: after a restart, after the instance was released and loaded
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
- It is a store the runtime owns: the runtime alone writes it, no authored
  schema declares a label for it, and no writer policy applies
  (`plan-and-label-templates.md` §2.6).
- Keying by `Cone.code` lets entries survive a pattern update that does not
  change the cone, and makes entries of a changed cone unreachable. They
  are removed with the next write.
- A client that speculates may read the document. It does so only for cones
  it would otherwise evaluate.

### 8.5 The author's annotation

The plan records the directive per cone, as `Cone.cache`
(`plan-and-label-templates.md` §1.4).

| `Cone.cache` | Effect |
| --- | --- |
| Absent | The runtime decides, by section 8.3 |
| `always` | The compiler emits an `Operation` of kind `cache` whose `implementation` names the cone. Its state document is named and stored as section 6 says, and is written whenever the cone is evaluated |
| `never` | The cone is not a candidate |

`language-subset.md` has no form by which an author writes either value, so
a compiled plan leaves the member absent and the runtime decides (section
11, question 26).

### 8.6 The label of a cached value

A cached output is stored, so it is labeled.
`plan-and-label-templates.md` §2.6 gives the labels. Each cached output, of
a cone the runtime promoted or of a forced cache, carries its own template
instantiated, as it would if it were kept. Every other member of an entry,
its selections, the keys a `pick` chose and what it records of the cone's
reads, carries the confidentiality of the cone-level join and no integrity.
The entries are in the envelope of the cache document, or of the forced
cache's state document.

For an element cone the cache document holds one entry per element key,
under the key (section 8.4), and a key derived from a value is the salted
one (section 5.3). An entry belongs to the one position that holds its
key, so a cached output carries the label of that position (section 2.5,
"What is stored per key").
The set of keys says which elements the collection has, so it carries
the collection's instantiated membership label
(`plan-and-label-templates.md` §2.6, "The state of an operation inside an
element body"). A forced cache in an element body is an operation and has
one state document per key (section 6).

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
An observer who can list a space's documents, or time a load, can see that
a cache exists. `plan-and-label-templates.md` §5.5 lists this with the
channels the design accepts. No value and no label depends on it.

## 9. Migration of stored instances

The overview asks whether anything besides state cells has to keep its
identifier, and when per-node documents already stored can be deleted. This
section proposes a procedure. It assumes the runtime that migrates contains
both the builder path and the compiled path, which is the case until stage
6 of the overview's staging.

By ruling, the scheduler is switched per space. A space runs either the
builder path with Scheduler v2 or the compiled path with the scheduler of
`scheduler-and-serving-loop.md`, and never both. The two paths exist side
by side only for validation, and the builder path is to be retired soon
after. A space is therefore migrated as a whole, by a **switch**: one
step that gives every instance of the space its compiled setup and marks
the space. No instance is migrated by itself when it is loaded, and no
space holds instances of both kinds.

Migrating an instance has two parts. Its **compiled setup** is written at
the switch: the setup record that names its compiled pattern, and its
carry-over record. Its **first compiled evaluation** replaces the stored
layout of its result with the compiled one, and happens when the instance
is first loaded after the switch. Sections 9.2 and 9.3 say what the two
write, and section 9.4 has the procedure.

### 9.1 What an instance stored by the current runtime consists of

Section 4.8 lists it: a result document whose value is links, an argument
document, one document per internal cell with the manifest that lists them,
a full instance per sub-pattern call and per `map` element, and the stores
of structural built-ins.

### 9.2 What migrating means

The first compiled evaluation of an instance is one setup transaction
that replaces the stored layout with the compiled one, for the same
authored source. The table says what an instance's documents hold once it
committed.

| Stored today | After migration |
| --- | --- |
| The result document's identifier | Unchanged |
| The result document's value: links to node documents | The kept outputs, in the layout of section 4, as the first compiled evaluation computes them: in the result document, and in part documents where section 4.10 splits them off |
| The label of a result path that held a link and comes to hold a value | The `value` entry is replaced by the instantiated template. The frozen `shape` entry is kept and joined with the confidentiality of the `followRef` entries the link had, so the stored label of the path is not looser after the migration than before it (`plan-and-label-templates.md` §2.6) |
| The argument document | Unchanged |
| A state cell declared directly in the pattern body | Unchanged: the derived identifier is the stored one (section 5.7) |
| A stream declared directly in the pattern body | Unchanged identifier. Its document stays the stream's document, where events are appended (section 4.7) |
| A state cell inside a compiled-in sub-pattern | Found through the carry-over record (section 9.3) |
| A state cell inside a `map` body | Not carried over. The compiled instance starts it empty under its new identifier |
| A node output document: a `computed`, a conditional's store, a `map` container, an element result, an aggregate node | No longer written. Retired (section 9.6) |
| The result and argument documents of a sub-pattern instance that is now compiled in | No longer written. Retired, with a forwarding link where section 9.5 says |
| A child instance a handler created | An instance of its own: it gets its compiled setup at the switch, and its first compiled evaluation when it is next loaded |
| The pattern a `lift` or a `computed` synthesized, and the instances in it | No longer written. Retired. The first compiled evaluation makes the instances under their new identifiers (section 5.7), so state inside them is not carried over |
| The settled result of an effect | See open question 2 for the owner |
| The handle of a `sqliteDatabase` declaration | Copied into the operation's state document as stored, with its `id`, `owner` and `rev` (section 6.8) |
| The `internal` manifest | Kept as the list of retired documents until they are deleted |

Per-element state is not carried over by ruling. In FabriChat the one such
cell is the row's `pickerOpen`, a session flag.

### 9.3 The carry-over record

A state cell inside a compiled-in sub-pattern has a new identifier (section
5.2), and its stored value is under the old one: an internal cell of the
sub-pattern's own instance. The migration writes, in the result document's
meta, a record that maps the cell's cause in the plan (its `within` steps
and its name) to the link of the stored document. Binding reads the record
whenever the instance is loaded and uses the recorded document for that
cell. The record is written once and is not removed.

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

- A space switched after the builder path is retired cannot have this
  record computed for its instances. Their sub-pattern state starts
  empty.
- The record also carries the scheme of each state cell declared directly
  in the body, taken from the stored manifest (section 5.2).

### 9.4 The procedure

**When a space is switched.** *Assumed:* the deployment names the spaces
that run the compiled path, and the serving runtime switches a named
space at an activation, after it holds the lease and before the first
cycle. No graph of the space is running at that point and no wave is
open. The switch is not triggered by a load, by demand, or by an event
(section 11, question 69).

**The switch.** It has three steps, and a space is switched when the
third commits.

1. **Check, without writing.** Find the instances of the space: the
   result documents whose setup record the builder path wrote. Compile
   the stored source of each, and apply the existing compatibility
   comparison of a source update to the compiled pattern's argument and
   result schemas against the stored instance
   ([piece source lifecycle](../piece-source-lifecycle.md), "Compatibility
   policy"). The source is the same, so a difference means the two
   compilers generate different schemas. *Assumed:* if the compiler
   refuses the source of one instance, or one comparison fails, the space
   is not switched. It stays on the builder path as a whole, and the
   switch reports the instances (section 11, questions 4 and 70).
2. **Write the compiled setup of every instance.** For each instance, a
   setup transaction writes the setup record that names the compiled
   pattern, the carry-over record (section 9.3), and the copied handle of
   each database declaration (section 6.8), and its store transaction
   writes the stream rows of the instance's bindings outside every
   element body, whose identifiers need no evaluation
   (`scheduler-and-serving-loop.md` §5.1). The compiled setup record is
   written beside the record the builder path wrote and does not replace
   it, so the builder path does not read it. The runtime may write
   several instances in one transaction. An instance that the compiled
   pattern of another compiles in, a sub-pattern instance or an element
   instance of a `map`, gets no setup of its own: it is found from the
   stored manifest of the instance that holds it, and its documents are
   retired by that instance's first compiled evaluation.
3. **Mark the space.** One transaction writes the mark of the space
   (section 9.7) and deletes the basis rows the builder path kept for the
   space. From this commit on, the compiled setup records are in force,
   the serving runtime runs the scheduler of
   `scheduler-and-serving-loop.md` for the space, and no node document of
   the space is written.

The transactions of steps 2 and 3 are setup transactions in the sense of
the [serving loop](../server-side-execution/serving-loop.md) (§3e): each
commits by itself, in no wave, and is the transaction of none of the four
causes of section 1.1.

**No instance is evaluated at the switch.** The switch runs no pattern
code. A space can hold many instances that nothing demands, and
evaluating all of them would make the switch cost as much as loading the
whole space.

**Demand and queued events during the switch.** The serving runtime runs
no cycle of the space between the start of step 1 and the commit of step
3. Sessions stay connected and read the stored values, which the builder
path wrote. The demand they register is pending, and the first cycle
after the switch counts it. An event appended to a stream of the space
during the switch is stored in its stream document and holds its place,
and the first cycle after the switch drains it. *Assumed:* the switch
starts only when the builder path has handled every event that was
queued before it, so that no event appended for the builder path's
bindings waits across the switch (section 11, question 73).

**The first compiled evaluation.** After the switch, no basis row exists
under the compiled identity of any instance, so every cone instance of
the space is stale. When demand or a queued event first loads an
instance, the scheduler runs, in one setup transaction:

1. **Evaluate.** Run the first compiled evaluation, reading state through
   the carry-over record. Every kept output of the space's scope instance
   is demanded for the length of the transaction, and so is every kept
   output of a narrower scope for the scope keys that demand the
   instance, so that the whole layout is written.
2. **Write, in one transaction:** the result document and its part
   documents, with values, envelopes and provenance in the compiled
   layout; forwarding links (section 9.5); and the removal of the setup
   record the builder path wrote. The store transaction of this setup
   transaction also writes the rows beside the documents: the basis rows
   of the cone instances it evaluated, and the stream rows of the streams
   whose identifiers it computed. The transaction is in no wave, and the
   memo holds its evaluations afterward, so no later transaction of the
   process would write those rows
   (`scheduler-and-serving-loop.md` §10.8).
3. **Load the compiled instance.**

Until that transaction commits, the instance's result document holds the
links the builder path wrote, and a reader follows them to the node
documents and reads the values the builder path last stored. A read by a
handler or a cone of another instance of the space finds no basis rows
for the writer, which shows the stored value stale, so the instance is
loaded and evaluated first (sections 1.3 and 3.4). The instance stays
unloaded, with its demand pending and its events holding their place,
until the commit is accepted.

**What a withdrawn or failed switch leaves.**

- **Before the mark commits, nothing is in force.** A check that fails
  writes nothing. A setup transaction of step 2 that is withdrawn, or a
  process that stops between the steps, leaves compiled setup records,
  carry-over records, copied handles and stream rows that the builder
  path does not read. The space is not marked, so the next activation
  runs the builder path, or starts the switch again from step 1 and
  writes the same records over the ones it finds.
- **A withdrawn marking transaction** leaves the space on the builder
  path, in the same state.
- **After the mark commits, the space is switched.** A first compiled
  evaluation whose transaction is withdrawn leaves that instance
  unloaded, with its stored layout as the builder path wrote it, and the
  next load runs it again. A cone that fails in it takes an error state
  like any cone (section 1.7), and does not undo the switch.
- **A switch is not reversed.** *Assumed:* a switched space stays
  switched. The first compiled evaluations replace stored layouts, and
  per-element state is stored under identifiers the builder path does
  not derive, so the builder path cannot take the space back without
  loss (section 11, question 71).

Where a setup transaction sits in the scheduler's cycle belongs to
`scheduler-and-serving-loop.md` (§10.8).

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

A part document is not a retired document. It is deleted in the
transaction that removes the storage link to it, because nothing else
names it (section 4.10).

*Assumed:* a retention period of thirty days. It needs the owner's
decision (open question 3).

The same rule applies after migration to documents that go out of use
without a migration: the state cells of a replaced child that the new
child does not declare (section 4.6), and the documents of an instance
that a computation no longer makes (section 2.8). Today such documents
are released and never deleted
(`builtin-inventory.md`, the entry for `map`).

The rule does not apply to what is stored under an element key that
left its collection. By ruling the removal of an element deletes no
state cell and no operation state of its key, in each of the three
cases of a source, and such a document is not a retired document
(section 2.6, "A key that left its collection"). Reclaiming that
storage would be a separate mechanism, which this design does not
have. For the documents of a child of an element body whose key left,
this section's rule is *assumed* (section 11, question 33).

### 9.7 What a reader on an older client sees

- **A client that only reads** the instance's result, and runs none of its
  code, reads the result through the result schema. Before the instance's
  first compiled evaluation commits it follows links to node documents.
  After it, it finds values at the same paths, in the result document or
  in a part document behind a storage link. That evaluation is one
  transaction, so the client sees one layout or the other for an
  instance and never a mixture. A runtime that does not know the stored
  form of a storage link cannot resolve a path that passes through one.
- **A client that runs the instance's pattern on the builder path** would
  set the instance up again from the stored source. A start holds the
  stored setup against the build it loads (`#storedSetupVerdict` in
  `runtime/runner/src/runner.ts`), and a setup record it cannot interpret
  reads as no record, on which the builder path can restage its own
  projection over the compiled result. Its speculative run would also read
  retired node documents that no longer change.

Both kinds of client have to be refused. The marking transaction of the
switch marks the space, and the memory server admits to a marked space
only a runtime that declares it executes the compiled layout, as it does
today for instance naming
([memory invariants](../memory-v2/09-invariants.md), INV-16). The mark is
also what tells a serving runtime at activation, and a client when it
opens the space, which of the two schedulers runs the space.

*Assumed:* a space is switched only if it runs under server execution, so
that the one runtime that commits derived values is a compiled one, and a
client's part is to read, to speculate, and to send events.

### 9.8 Interaction with the pattern-update mechanism

A pattern update in a switched space is a source transition as today
([piece source lifecycle](../piece-source-lifecycle.md)). What the update's
setup does changes.

- **State cells are found by name.** A cell the new source declares under
  the same name, at the same sites, has the same identifier. A renamed cell
  is a new cell, as today. No cell moves because a declaration with
  another name was added, since no identifier is a position among
  unrelated declarations. A declaration that takes an ordinal among
  declarations of its own name is the exception (section 5.2). The refusal
  that protects positional state today (`PieceStateMovedError`) and the
  gate that holds the compiler to a numbering
  (`deno task check-cause-assignments`) do not apply to a compiled
  instance.
- **The carry-over record stays.** It is keyed by the cell's cause in the
  plan, so it keeps applying while the declaration keeps its name and
  sites.
- **Kept outputs are recomputed.** The first evaluation under the new
  compiled pattern writes the kept outputs whose values or instantiation
  keys differ. A part document whose path the new result no longer has is
  deleted with its storage link.
- **Memo entries are dropped**, because they are keyed by the compiled pattern
  (section 3.2), and the basis rows under the earlier identity match nothing,
  so every cone instance starts stale (`scheduler-and-serving-loop.md` §10.4).
  The store transaction of the update's setup transaction deletes the basis
  rows of the earlier compiled identity and writes the basis rows of the cone
  instances it evaluated and the stream rows of the streams it computed, as a
  first compiled evaluation does (section 9.4; §10.8 there). Cache entries and
  operation state survive where the code they were computed by is unchanged
  (sections 6.6 and 8.4).
- **The compatibility comparison is unchanged.** It compares argument and
  result schemas and retained input links, none of which the layout
  affects.
- **The switch compiles what an instance runs.** The switch compiles the
  source that each instance's stored setup record names. An instance that
  follows an origin is compiled from the release it follows, and a
  detached instance from its retained source. A release that arrives
  after the switch is a source transition of a compiled instance.

### 9.9 A link between a switched space and one that is not

During the validation period a link can cross between a space that is
switched and one that is not. Each space is derived by its own loop
(`scheduler-and-serving-loop.md` §9), so the rule of one scheduler per
space is not affected. What crosses is a stored value and its stored
label. *Assumed*, for the project owner (section 11, question 72):

- **The reading side reads what the other path stored.** A compiled
  instance that reads an output of an instance in a space that is not
  switched reads the stored value, following the links to node documents
  as today, with the label the builder path stored: today's join over
  the reads of the node that wrote it. A builder-path instance that
  reads a kept output of a switched space reads the value and the
  envelope the compiled path stored, through a storage link where the
  path lies in a part document. The runtime of the validation period
  contains both paths, so its builder path resolves a storage link.
- **The tighter labels hold only along switched spaces.** A label that
  the compiled path computes from templates is tighter than today's
  only for what its own space derived. A value that passed through a
  space that is not switched carries that space's label from there on.
  The tighter labels therefore hold for an output only where every
  space in the chain of links it was derived through is switched.
- **Nothing else crosses.** No basis row of one space is read by the
  other, and no slot is bound to a node of another space's graph. An
  event for a stream of the other space leaves through the outbox,
  whichever path that space runs.

This document says nothing on how a validation run compares the two
paths, beyond that the comparison is between two spaces, one on each
path, since no space runs both (section 11, question 74).

## 10. Worked example: a FabriChat send

This traces one event through sections 1 to 7: a message sent into a
FabriChat room that holds thirty messages, is rendered by one session, and
has no thread open. It uses the slice and the names of
`plan-and-label-templates.md` §6: the handler `commitSend` (body `B0`), the
derivation `facts` (the bodies `B1` and `B2`, template `T_facts`), the row
templates, and the constraints `k0` and `k1`.

`commitSend` is bound to the room's exported `sendMessage` stream and to no
rendered control (`patterns/system/fabrichat/room.tsx`). The event of this
trace is sent to that stream by another pattern, from a reviewed send
surface, so that its provenance satisfies the UI contract of `k0`. The
room's own composer binds `commitComposerSend`, whose state adds the
`composer` cell and the file store and whose body calls the same `sendInto`.
For a send from the composer the handler also reads and clears the
composer, and the rest of the trace is the same.

The event is the only one in the room's queue when the cycle begins. Its
handler sends an event on the room's `joined` stream, which joins the
batch (section 1.4). So the batch holds two events and three transactions
run: the send's, the `joined` event's, and one derivation transaction
behind the batch.

### 10.1 The transactions

**The transaction of the send.**

*Bind.* The cause is an event on the `sendMessage` stream. Its payload is
bound to the `event` root, its key and principal to the `cause` root, and
the binding `sendMessage` to the `binding` root. The binding is one of the
reactive tier and every path of its state is a cell, so nothing is copied.

*Before the body.* What `B0` reads is the event slots and the five
`binding` slots. Two of them concern the sender's profile: one observes the
resolved reference, and one crosses the link from the handler's state to
the profile cell and observes whether that cell holds a value. No cone of
the room computes any of these, and no cone side-writes a cell they
are bound to. Nothing is evaluated.

*The body.* `sendInto` resolves the sender's profile, which the runtime
materialized for those two slots, and checks the event. The event carries
no attachment and no reply, so the body reads through none of the handles
listed in `Body.handles`. It then:

- creates the reactions list, a cell request with ordinal 0;
- pushes the message record onto `messages`. The record is a plain object
  written into an array, so it gets a document of its own and the array
  receives a link (`builtin-inventory.md`, "Element keys");
- sends on the `joined` stream, which the room binds to
  `tellManagerJoined` (`tellJoined` in `room.tsx`). The event is
  identified by the handling and its order among the events this
  invocation sends (section 5.4), and is staged as an entry of that
  stream's document. The stream belongs to the same instance and space,
  so the event joins the queue when this transaction seals and is the
  second event of the batch.

When the body returns, the reactions document is given its identifier from
the handling and ordinal 0, and its initial value. Staged by the event: a
new message document, a new reactions document, one appended link in
the `messages` list, and the entry of the `joined` event. The appended
link changes addresses that `B2` read through its `messages` handle, so
the cone of `facts` is stale. It is not evaluated in this transaction.

*Preparation.* The write edges of `B0` are instantiated: `T_send` once, for
the message's computed fields and the reactions list. The `authorProfile`
link carries the label of the reference the handler was given, joined with
`T_send`, and nothing of the profile cell's own label
(`plan-and-label-templates.md` §3.9, "A handle a body passes on"). The
constraints are then checked. `k0`: the writer is `commitSend`, which the
policy names, and the event satisfies the alternative's UI contract. `k1`:
writer-fit. Both pass. Both guard what the handler itself writes, so had
`k0` failed, the event's whole transaction would have been rejected,
nothing below would have been written, and no derivation would have
followed from it.

*Seal.* The transaction carries:

| Document | Write |
| --- | --- |
| The handling's receipt | Created |
| The message | Created, with the declared authorship entry |
| The reactions list | Created |
| The `messages` list | One appended link |
| The document of the `joined` stream | One appended entry. The document is created if the stream had received no event (section 4.7) |

**The transaction of the `joined` event.** The handler is
`tellManagerJoined` in `room-records.tsx`, which is outside the slice of
`plan-and-label-templates.md` §6, so its templates are not traced here.

*Bind.* The cause is the event on the `joined` stream. The binding
`tellJoined` is one of the reactive tier. Its state names `canJoin`, which
is an output of a cone of the room; `container`, which is the argument's
`container` or nothing, chosen by the computed `ownSpace`; and `manager`
and `self`, which are paths of the room's argument.

*Before the body.* `canJoin` and `ownSpace` are computed from the
argument's `about`, `self` and the `chatRoom` entry of `container`. The
send wrote none of them, so it made neither cone instance stale. They are
evaluated before the body where no earlier cause had them evaluated, and
not otherwise. The send staged no derived write, so nothing is
instantiated early.

*The body.* It returns at once unless `canJoin` is true and the viewer's
manager has a `joinRoom` stream. Otherwise it sends one event on that
stream and writes nothing else. By the handler's source comment the event
writes nothing in the room's space: the stream is the manager's. An event
for a stream of another space leaves through the outbox after the wave
commits (section 1.4). No cone instance of the room is made stale.

*Preparation and seal.* The handler's own writes are the sent event. The
transaction carries the receipt of this handling and nothing else in the
room's space.

**The derivation transaction behind the batch.**

*Bind.* The cause is the changes the batch made. The scheduler reports the
address that `B2` read as changed, and records it as a trigger read of that
`dynamic` node.

*Evaluate.*

| Cone instance | Stale | Evaluated | Why |
| --- | --- | --- | --- |
| `facts` | Yes | Yes: one evaluation, which calls `B1` and `B2`. `B2` walks 31 records through its handle | An address it read through a handle changed |
| `isEmpty` | Yes | Yes: one comparison | `facts.main.length` changed. The value stays `false`, so its kept output is not written |
| The participants derivation | No | No | It reads the authors `facts` lists, and the list is equal to the one before |
| Per-session records the room derives for every row, such as the rights of each message | Yes | Yes, once per demanding session | They read the entries of `facts` |
| The 30 existing rows | No | No | Their keys are their message cells' identities, their element slots did not change, and each reaches the room's records, such as `facts.places`, only through a `pick` of its own entry. That output gained an entry, and the entry each row chose is equal to the one before, so no row's memo entry stops being current (section 3.3) |
| The new row | New key | Yes, once: the row body's cones for the new message | Step 3 of section 2.5 |

No cone of the rendered tree is in the table. The cone that places the
main list among the children of its node holds a collection reference
(section 2.2, "A collection that a cone places"; provisional, P22), so
the new row makes neither that cone nor the `result` cone stale, and the
row is stored by the collection.

By a syntactic count, the body of `FabriChatMessageRow` in `message-row.tsx`
has 14 `computed` calls, 7 actions and 12 applications of a handler to
state. `language-subset.md` §11.5 counts 109 of FabriChat's 112 `computed`
calls as promoted, so most of the row is expression code with calls of
authored functions such as `bodyText`.

*Preparation.*

- The room's `messages` output: its cone was evaluated, its instantiation
  key is unchanged when the labels of the new message and of the trigger
  read equal the ones before, and the stored label is reused.
- The new row's kept paths, about 25: their templates instantiate to the
  labels the other rows have. The entries are stored in the envelope of the
  new row's part document.
- No constraint is declared on these outputs. A constraint that failed here
  would drop that output's write and nothing else.

As deployed, every one of these labels is empty, so no entry is written.

*Seal.* The transaction carries:

| Document | Write |
| --- | --- |
| The room's result document, the space's scope instance | One element appended to the `messages` output |
| The document that stores the main list under `[UI]`: the result document, the part document of a node that encloses the list, or the last chunk of the list where it is stored in chunks (section 4.10) | One storage link appended |
| The new row's part document, the space's scope instance | Created, with the row's subtree |
| The new row's part document, the session's scope instance | The row's session-scoped paths |

A second session that has the room open receives the commits. Its own
session-scoped paths for the new row are written when its scope key is
evaluated, in this transaction if the scheduler includes it (section 1.8).

### 10.2 Against the counts today

| Per send into a thirty-message room | Today | Compiled |
| --- | --- | --- |
| Transactions | The handler's, and one per node run that follows | Three: the send's, that of the `joined` event the send's handler sends, and one derivation transaction. Several sends in one batch share the third |
| Scheduler runs | 68 in the browser measurement; 36 in the pattern-test rig after the room's derivations became one walk, of which 17 are the new row's computeds | Not a unit. Cone evaluations: `facts`, `isEmpty`, the room's per-session records, and the new row's cones |
| Sandboxed calls for the 30 existing rows | None for their computeds; the `map` coordinator ran twice and resolved all 31 links each time, 219 link hops | None, and no coordinator: step 1 of section 2.5 reads the list once |
| CFC preparations | One per commit that touched labeled documents | Three, one per transaction |
| Documents created | The message, the reactions list, the receipt, and the new row's family: a result slot and about forty owned cells | The message, the reactions list, the receipt, and the new row's part document |
| Label instantiations | One join per transaction | `T_send` once; the row templates once for the new row; none for unchanged rows |
| Round trips for the renderer to read the new row's cells | 26 | Not a measured count. A reader loads the documents on its paths (section 4.10): for the new row, its part document, in the space's scope instance and the session's, and a part below it where the row's subtree is split further |

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

Each entry states the assumption this document made. Entries keep their
numbers, because other documents cite them. A request marked "met" points
to where the other document has what was asked.

Ruled by the project owner, and written into the sections above: an event's
transaction holds no derivation behind the body, and derivations settle
once behind a batch (1.1, 1.2); a failed constraint on a handler's own
write rejects the event, and one on a derived write drops that write alone
(1.7, 3.3); a change of demand is a cause of its own (1.1); a conflict on a
derived write withdraws that write alone (1.7, 1.9, 3.3); a handling is
identified by the receipt (5.4); ten evaluations of a cone instance per
transaction, and a cone instance that failed at the bound is not evaluated
again until an input changes (2.7); the identifier of a space an `inSpace`
request creates is obtained, and recorded before the step in that space
(5.6); a client cannot read the element-key salt (5.3); a client enacts
`navigateTo` and no other effect (6.4); a binding of the reactive tier
copies nothing, and a binding made in a function body binds a stored
container by reference (4.7, 5.5); a `lift` or a `computed` may instantiate
a pattern (2.8); the keep set is stored in several documents, by a rule
about size that this document owns (4.10); an event is routed to an
instance that is not loaded through a stream index (4.7); a read of a cell
whose writer is in an instance that is not loaded returns the stored
value where the basis rows show it current, and loads the instance only
where they show it stale (1.3, 1.4, 2.4, 3.4); an element key holds the
count of earlier occurrences of the same value or identity, so equal
elements have two keys, and everything an element body holds is per key:
a state cell in an element body over plain values is legal, and a
handler bound there has a stream per occurrence (2.5, 4.7, 5.3); nothing
is stored once for several positions, so no stored label joins the
labels of two positions (2.5, 6); an instance
a `lift` or a `computed` makes is identified by the enclosing instance,
the body, the site and an ordinal or an explicit cause, and such a body
requests no effect directly (2.8, 5.5); a child an element body
instantiates is per element key, without the position (2.5, 5.3); an
explicit cause in a handler names the same thing on every event, with the
existence label fixed at first creation (5.4); the scheduler is switched
per space, so a space is migrated as a whole and holds no instances of
both kinds (9); a default belongs to the stored place, and a reader
bound by reference reads it through the schema the link holds (2.2, 4.4,
4.7); a read of a default carries no integrity, and a read of a stored
object whole keeps the object's integrity where a default fills one of
its properties (2.2); a write through a handle bound to a value the
instance produced is refused, and one bound to a reference lands at the
reference's target (2.4); an array of plain values may declare a key
field with the array type `ArrayByKey<T, "field">`, or several as a
union of their names, and the key of an element then names the
fields and holds one salted hash of their values, and is resolved
with no schema; the key belongs to the array, so an element put into
a second array has that array's key, or none (2.6, 5.3). The ruling
on the keep set
answers what was question 1 of this list, the size of a result document.

### 11.1 For the project owner

<!-- The list starts at 2 so that the numbers stay as cited. -->

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
   switched space refuse builds that predate the compiled layout.
   *Assumed:* thirty days, and refusal from the commit that marks the
   space.
4. **Instances whose stored source the compiler refuses.** Such an
   instance cannot be given a compiled setup, and a space that holds one
   is not switched (question 70). *Assumed:* when the builder path is
   retired, the space is switched without the instance: it stops
   running, its stored state and last result stay readable, and it runs
   again when its source is updated.

Added by the rulings on several documents, on batches and on instances a
computation makes:

32. **The numbers and the split points of section 4.10.** The ruling leaves
    the rule about size to this document. *Assumed:* a part document
    begins only at the root of a kept output, at a row of a kept
    collection, or at a node of the rendered tree; a split point becomes a
    part at `PART_MIN_BYTES`, 1,024 bytes, and returns in place under
    half of it; and an array whose content exceeds 65,536 bytes is
    stored in chunks (provisional, P20; question 103). The two numbers
    are placeholders for stage 4 to measure. One choice in
    the rule is not about numbers: that the `props` of a node are stored
    with the node and are not a part of their own, although the renderer
    subscribes to them separately today.
33. **An instance made again under the identity of one that was torn down**
    (section 2.8). The identity is ruled. With an ordinal as the identity,
    a list that shrinks and grows makes instance number 2 again for
    another item, and a child of an element body is made again when a
    value that was removed is added again (section 2.5). Not open, by
    ruling: the removal of an element deletes nothing stored under its
    key, so the state cells and the operation state that an element
    body declares stay stored, and a key that returns reads what its
    state cells held (section 2.6, "A key that left its collection").
    That is the same in the three cases of a source: over an array of
    plain values in place a value that is removed and written again,
    over an array of references a cell that leaves the list and enters
    it again, and over the result of another per-element construct an
    upstream key that returns. The prototype's executor does this in
    the three cases. The ruling does not speak of an instance.
    *Assumed:* an instance made again finds the state cells and
    operation state stored under its identity where they were not
    deleted yet, the documents of a torn-down instance are retired and
    deleted under section 9.6, and an author who needs a new instance
    writes `.for(cause)`. That is assumed for an instance a `lift` or a
    `computed` makes, which is not about a per-element construct, and
    for a child of an element body whose key left, in each of the three
    cases. By ruling a child of an element body that was called
    through `asInstance()` is not torn down when its key leaves and is
    the same instance when the key returns, so the assumption covers
    a child without the modifier alone. The alternatives: delete a
    torn-down instance's documents
    in the transaction that tears it down, which needs them to be
    listed; or, for a child of an element body, keep its documents as
    the ruling keeps the state cells of the body, so that a child made
    again under a key that returns always finds its state. A second
    consequence of the ruling on identity is stated here so that it is
    accepted knowingly: a link to a torn-down instance that another
    document holds reads the values last stored, and nothing marks them
    as such for a reader that does not load the instance.
34. **A cone instance that failed on a time or memory budget** (section
    1.7). The ruling covers a failure at the bound of ten. *Assumed:* the
    same holds for a budget failure: the cone instance is not evaluated
    again until one of its inputs changes. Such a failure is not a function
    of the inputs alone, so an evaluation on another day could succeed.

<!-- The list restarts so that the numbers stay as cited. -->

47. **The order of the steps for a space an `inSpace` request creates**
    (section 5.6). The ruling has the allocation recorded in a step that
    commits before the step in the foreign space. *Assumed:* the identifier
    is known at the request, from a key pair the runtime generates without
    waiting, so that the body is run once; and the steps commit in the
    order genesis of the space, allocation record, the instance's
    documents in that space, home. A record that committed before the
    genesis commit could name a space that never comes to exist, because
    the key that signs the genesis commit does not survive the process.

<!-- The list restarts so that the numbers stay as cited. -->

52. **What `asScope` changes of what a child stores** (section 4.6).
    `Child.scope` sets the scope of the state the child declares.
    *Assumed:* the scope is stored in the setup record of the child's
    result document, and it changes the child's state cell documents
    alone: a cell declared with a broader scope has scope instances by
    the modifier's scope. A kept output of the child that reads no such
    cell stays in the space's scope instance. Today the modifier puts the
    scope on the child's result cell, so the whole result is addressed in
    that scope. The assumption computes and stores such an output once
    where today it is stored per user or per session. No label depends on
    the choice.

<!-- The list restarts so that the numbers stay as cited. -->

64. **A state cell in an element body that instantiates a child** (section
    2.5). Not open: a state cell in an element body is legal whatever
    else the body does, and it is per element key as the child is. The
    entry keeps its number.
67. **The cost of a child per position** (section 2.5). Not open: a child
    is per element key and moves with its element, so an insertion or a
    removal sets up or tears down one child. The entry keeps its number.

Added by the ruling that the scheduler is switched per space (section 9):

69. **When a space is switched** (section 9.4). The ruling does not say
    what starts a switch. *Assumed:* the deployment names the spaces that
    run the compiled path, and the serving runtime switches a named space
    at an activation, before its first cycle. The switch writes each
    instance's compiled setup and evaluates nothing, and an instance has
    its first compiled evaluation when it is first loaded afterward. The
    alternative evaluates every instance at the switch, which makes the
    switch cost as much as loading the whole space and leaves no instance
    in the stored layout of the builder path.
70. **A space that holds an instance whose source the compiler refuses**
    (section 9.4). *Assumed:* the space is not switched and stays on the
    builder path as a whole, because a switched space runs no builder
    path for the one instance. One such instance then keeps every other
    instance of its space from the compiled path until its source is
    updated or the builder path is retired (question 4).
71. **Reversing a switch** (section 9.4). *Assumed:* a switch is not
    reversed during the validation period. A space is validated on a
    copy, or is switched for good. The alternative keeps what the builder
    path needs to resume, the node documents and per-element state under
    its identifiers, current or restorable for the length of the period.
72. **A link between a switched space and one that is not** (section
    9.9). *Assumed:* the reading side reads the stored value and the
    stored label as the other path wrote them, so the tighter labels of
    the compiled path hold only where every space in the chain of links
    is switched. The alternative refuses to switch a space until the
    spaces it reads are switched.
73. **Events across the switch** (section 9.4). A stream declared
    directly in a pattern body keeps its identifier, and every other
    stream has a new one (section 5.7). *Assumed:* the switch starts only
    when the builder path has handled the events queued before it. An
    event that a client appends afterward to a stream whose identifier
    the compiled layout does not keep, from a tree rendered before the
    instance's first compiled evaluation, has no row in the stream index
    and is deferred and then dropped as an event on a stream with no row
    is (`scheduler-and-serving-loop.md` §5.1).
74. **How a validation run compares the two paths.** Nothing is designed
    here. *Assumed:* the comparison is between two spaces, one on each
    path, since no space runs both.

<!-- The list restarts so that the numbers stay as cited. -->

76. **The `shape` entry of a path that a write removed** (section 4.3;
    `plan-and-label-templates.md` §8, question 83). *Assumed:* it stays
    in the envelope until the path is created again, as today, so a read
    of a list that a handler emptied still consumes the labels under
    which its former elements were created. The alternative removes the
    entry in the transaction that removes the path, which is tighter
    than today.
77. **The transaction that creates an instance outside a handler**
    (section 1.1). The causes of section 1.1 cover an instance that a
    handler or a computation creates. They do not cover one that a
    command or a client creates directly, as the first instance of a
    space is. *Assumed:* one transaction writes the argument document
    and the link to the result cell and evaluates nothing, and the
    first demand opens the derivation transaction that evaluates the
    instance. The alternative evaluates the instance in the creating
    transaction, as the acting principal of the creation, which settles
    a new instance in one transaction where something demands it at
    once. The prototype's derived count of two transactions to settle
    an instance rests on this assumption.
78. **A marker stored outside the result, and a marker handed to a
    sandboxed body** (section 2.2; `plan-and-label-templates.md` §1.1,
    "Where the stream of a binding is stored"). Not open, by ruling: the
    value function places a stream, with the marker that
    `ConeHost.stream` returns, and the runtime writes the link in the
    marker's place when it stores the value, wherever the marker is. So
    a marker stored outside the result, in a side-write or a computed
    path of a child's argument, is replaced by the link as one in the
    result is, and no position is checked. Open is one thing the ruling
    does not determine. *Assumed:* a marker at an `identity` path of the
    argument of a sandboxed body is handed to the body as the reference
    to the stream; the alternative refuses it. The prototype's executor
    does both. The same for a cone of an element body over an array of
    references, over an array of plain values in place, and over the
    result of another per-element construct.
79. **What a cone stores that passes on an element that is a plain
    value** (section 2.6; `plan-and-label-templates.md` §1.3). Not
    open: by ruling an element that is a plain value in place is named
    by its collection and its key, a reference to it or to a member of
    it resolves to the current position at each read and write, and a
    cone that passes the element on stores that reference by key and
    no copy. `equals` compares two such references by collection, key
    and path, a write through one lands at the position that holds the
    key, a move evaluates nothing, and after removal the reference
    reads as nothing, which is a deliberate difference from today. The
    case is an array of plain values in place, and the result of
    another per-element construct where the upstream position holds a
    value. Over an array of references the result holds the link to
    the cell, and nothing changed. Ruled as well
    (`plan-and-label-templates.md` §8, questions 112 and 115): a
    write through the reference that changes the value re-keys the
    element in the same transaction, a function body that reads a
    plain value holds a copy, and a handle by position is equal to a
    reference by key to the element that stands there. What the
    rulings leave open is assumed there (its questions 113, 114 and
    121): the stored form and a key that returns, the label, and the
    comparison where the parent cannot be read.
80. **Which cone with side-writes is of which kind** (section 2.3;
    `scheduler-and-serving-loop.md` §7.1). By ruling a cone with a
    small, fixed set of write targets is an ordinary node whose targets
    count as outputs for demand, and one whose write set is dynamic or
    very large is evaluated eagerly. *Assumed:* the compiler decides
    from the footprint, by `footprint-analysis.md` §6.3: the first kind
    where every write target is a statically named slot, and a
    materializer where a target is reached through data. The ruling's
    "very large" has no number, and no bound is set: a body with any
    number of static targets is of the first kind.
85. **How a sandboxed body of a compiled-in callee is handed the
    callee's default** (section 2.2; `plan-and-label-templates.md`
    §1.1). Not open: by ruling the entry of `Body.reads` holds the
    default, in `ReadInput.default`, and the value code passes
    `host.invoke` nothing for it. The same for a body used in an
    element body, in each of the three cases of a per-element source.
    Where a handler's binding holds the default is assumed in
    `plan-and-label-templates.md` (its §8, question 110).
86. **What a write below the root of a state cell that holds nothing
    stores** (section 4.1). Not open: by ruling a write at a path
    below the root, a `push` included, creates the document from the
    default with the write applied, and the members taken from the
    default keep the label of a default, the empty integrity
    (`plan-and-label-templates.md` §1.3). The same for a state cell of
    an element body in each of the three cases.
87. **Whether a first value is stored as a value** (section 4.1). Not
    open for the cell as a whole: by ruling a first value that is not a
    constant is always stored as a value and never as a reference, so
    a write to the cell never lands in the input. Open beside it: the
    members of such a value. *Assumed:* a member of data type that
    carries the address it was read from is stored as a value as well,
    and a member of handle type as the link its type declares. The
    alternative stores a member passed on unchanged as a reference, by
    the rule of section 2.4, and a write below the root of the cell at
    that member then lands in the input. The same for a cell of an
    element body in each of the three cases; where the first value is
    the element itself the cell holds the element's value, and over an
    array of plain values in place no reference to the element.
88. **Which cone instance fails where a stream is stored at a position
    the plan does not name** (section 2.2). Not applicable, by the
    ruling that value code places a stream and that the runtime checks
    no position: no evaluation fails for where a stream is, no error is
    recorded for it, and every property of the result is stored. Where
    one cone instance called `host.stream` and another stores the value,
    the link is to the stream of the keys of the instance that called.
    The same for a cone of an element body over an array of references,
    over an array of plain values in place, and over the result of
    another per-element construct. The entry keeps its number.
89. **Where the record of a key of a list is stored** (`elementById`;
    section 2.4). Not open, by ruling: as the runtime of today does,
    the record is a cell of its own, named by the address of the list
    and the key, with no document until something writes it. It is no
    member of the list until a reference to it is added, and a reader
    of the list's label does not cover it before that. So a write
    through the handle is a write to the record and no write at `*`
    below the list for the label. Open: what the footprint records.
    `footprint-analysis.md` §7 has the handle at `*` below the list and
    not anchored. *Assumed:* that entry stays, as the name of some
    record of the list, with a write through it too broad to predict;
    the runtime resolves it to the record, and the write makes no
    reader of the list stale. The alternative records a dynamic write,
    as for a cell made under a cause computed from data. In the
    prototype's fixture 48 of 48 values equal those of the runtime of
    today. Its executor names the record by the address of the list
    and the key, with no document until something writes it: a write
    through the handle makes no document of the list and evaluates no
    reader of the list before a reference to the record is a member,
    and a reader that follows the reference is stale on a write to
    the record afterwards. Which template labels the write is assumed
    in `plan-and-label-templates.md` (its §8, question 126). The
    question is about a list whose members are references
    to the records. It is the case of an array of references for a
    per-element construct over the list, and does not arise over an
    array of plain values in place or over the result of another
    per-element construct, whose elements have no such record.
90. **How value code compares two references** (section 2.2).
    `equals` compares what its operands name once their links are
    resolved (`plan-and-label-templates.md` §3.16), and a value
    function cannot read through a reference. *Assumed:* `ConeHost`
    has a member `equals(a, b)` that takes the two references, and the
    cone instance depends on the links the resolution crossed. The
    alternative makes `equals` an operation of the plan with an output
    of its own, which value code reads as it reads any output. The
    same over an array of references, over an array of plain values in
    place, where an element is a reference by key and no key is
    resolved to a position, and over the result of another per-element
    construct. By ruling one comparison resolves a key: a handle by
    position against a reference by key, which are equal where the
    element stands at the position at that moment. The cone instance
    then depends on the membership of the collection's array.
91. **Which record gives the type of a position of a body's argument
    that no slot names** (section 2.4). Whether an `identity` position
    holds a handle or a reference stand-in follows from the type the
    body declares there. For an entry of `Body.reads` that is
    `Slot.schema`. An entry of `Body.computed` has no schema, and the
    plan holds no schema of a body's argument. *Assumed:* the runtime
    takes the type from the body's declared parameter type at the
    entry's `at`, which the artifact holds beside the plan. The
    alternative gives `ComputedInput` a schema member. Not about a
    per-element construct: the same in an element body in each of the
    three cases.
92. **A write below a place that holds nothing and is no state cell**
    (section 2.4). Not open, by ruling: as for a state cell. A `push`
    below a path of the argument at which nothing is stored and whose
    schema declares a default starts from the default, and the push
    is applied. The write stores the result at the path, and the
    members taken from the default keep the label of a default. The
    prototype's executor starts a `push` from the default nearest the
    end of the links that the handle resolves through, or from that
    of the handle's declared type, and in its fixture 12 of 12 values
    equal those of the runtime of today. It does so for `push`
    alone: a `set` of one member below an empty path of the argument
    starts there from an empty record, a limit of the prototype. The
    same for a
    handle in an element body in each of the three cases of a
    per-element source. The entry keeps its number.
93. **The document of a plain value of a keyed array that a function
    body pushes elsewhere** (sections 2.6 and 5.4). A handler that
    reads an element of an array that declares a key field with
    `ArrayByKey<T, "field">` holds a copy, by ruling, and a push of
    it to another list without `asInstance()`, as
    `saved.push(repo)`, stores the copy as a document of its own with
    a link in the list (section 4.8). By ruling the key belongs to
    the array, and an element put into a second array has that
    array's key, or none; here the second list holds a link and is
    keyed by the cell. The rulings do not say whether the identity of
    that document derives from the key, and the owner gave no
    assumption.
    *Assumed* by this document: it does not. The document is named as
    a cell that the body creates with no explicit cause is (section
    5.4; `plan-and-label-templates.md` §8, question 118), so two
    pushes of one element make two documents, and the declared key is
    the key of the element in its source alone. The alternative
    derives the identifier from the destination list and the key, so
    that a second push of the same element names the same document.
    The case is a body that reads an array of plain values in place,
    or the result of another per-element construct where the upstream
    position holds such a value. Over an array of references the body
    pushes the link, and no document is made.
94. **The order in which a read gives the members of a stored record**
    (section 2.4). An entry of class `enumeration` gives the body "the
    stored keys in the stored order", and no section says what the
    stored order of a record is. By the prototype's comparison the
    runtime of today gives the members of a record that a handler wrote
    in the order of their names, in the one module that shows it, and
    the prototype's executor gives them in the order in which they were
    written. *Assumed,* as the coordinator of this work recommends, and
    not ruled: a read gives the members in the order in which the
    serialization of a fabric value by `base/data-model` writes them,
    the order of the UTF-8 bytes of their names (`encodePlainObject` of
    `JsonEncodeAct` in
    `base/data-model/src/codec-json/JsonEncodeAct.ts`). That method does
    not write that order for a member whose name reads as an integer,
    and which order such a member has is part of the question. The
    alternative is the order in which the members were written. Not
    about a per-element construct. It is question 218 of the
    continuation plan.
95. **`equals` of a reference by key with a copy of the same element, in
    a function body** (sections 2.2 and 2.4). A handler bound in an
    element body over an array of plain values in place is given a
    reference by key for its element, and a member of the array that it
    reads through a handle, as with `items.get()`, is a copy that
    carries no address, by ruling. So `items.get().findIndex((x) =>
    equals(element, x))` finds nothing: a reference and a value that
    carries no address do not name one thing. Today each record of such
    a list is a cell in the modules of the corpus that do this, and the
    handler finds its element. This follows from the rulings and is
    recorded for the owner to see. *Assumed:* the comparison is false,
    as the rulings give it. The `findIndex` is the JavaScript method on
    the array that `get()` returned, and no per-element construct of the
    reactive tier. Over an array of references each member carries the
    address of its cell, and the comparison holds for the element. It is
    question 220 of the continuation plan.
96. **Which split points the rule on the size of a document takes, and
    which size is measured** (section 4.10). Rule 3 makes a part of
    every split point directly below a document that exceeds
    `DOCUMENT_MAX_BYTES`. The paragraph "A row" says that rule 3 then
    makes each row of a list a part. Where the array is a kept output
    that is stored in place in the result document, the root of that
    output is a split point between the document and the rows, so rule 3
    as it is written makes the array one part, and the paragraph makes
    the rows parts. Under the provisional rule of section 4.10 (P20;
    question 103) the first half has no case: no rule makes a part of a
    split point for the size of the document that holds it, the array
    is a part by rule 1, and a row is a part by its own size alone. The
    second half stands: the size of a split point is the length of "the
    stored encoding of its subtree", and no section names the encoding;
    nothing is assumed for it. The same for the rows of a kept
    collection over an array of references, over an array of plain
    values in place, and over the result of another per-element
    construct. It is question 229 of the continuation plan.
97. **What the provenance record of a kept output holds of the outputs
    that its template names** (section 7.2). By ruling a template names
    the template of another output and holds no copy of it
    (`plan-and-label-templates.md` §3.2). `OutputProvenance` holds the
    selections, the chosen keys and the dynamic addresses "the template
    reaches", and the ruling does not say whether that follows an
    `output` node. *Assumed,* provisional (P4 of the continuation plan,
    the author's recommendation, adopted by the coordinator of this work
    and not ruled): it does, each selector, choice point and set of
    dynamic reads once, so the record holds what it held with every
    template in place. An interim output has no record of its own, so
    nothing else stores its selections. The size of one record then
    follows everything upstream of its output, and the records of an
    instance together can grow faster than the plan. The alternative
    holds the entries of the nodes of the output's own template alone:
    the records are then linear in the plan, and the selections of an
    interim output that a kept output names are stored nowhere, unless
    such an output gets a record of its own. If the owner decides for
    the alternative, the paragraph "A template that names other
    outputs" of section 7.2 and the comments of the three members
    change. The same for a kept output of an element body over an array
    of references, over an array of plain values in place, and over the
    result of another per-element construct. It is question 241 of the
    continuation plan.

98. **A slot of a handler that observes the reference alone** (section 1.3). The
    bullet "A cell that a cone writes statically" has a slot of the handler
    bound to the target of a static side-write, and does not say whether a slot
    of class `identity` counts. *Assumed,* provisional (P8 of the continuation
    plan): it does not. The alternative, the tests and what changes are in
    `scheduler-and-serving-loop.md` (its question 54). It is question 276 of the
    continuation plan.
99. **A cone instance that writes a cell which another writer writes** (section
    2.7). "Staleness inside the transaction" makes a cone instance stale by a
    write to a cell that it read. *Assumed,* provisional (P9 of the continuation
    plan, flagged for the owner to look at first): a write to a cell that it
    writes and did not read does not make it stale. A batch and the same events
    one at a time can then store different values, and today's runtime stores
    one. The alternative, the tests and what changes are in
    `scheduler-and-serving-loop.md` (its question 55). It is question 277 of the
    continuation plan.
100. **The layout of an operation's state document, the shape of a request, and
     how far a request's references are followed** (section 6.4). The section
     lists what the document holds and no layout. *Assumed,* provisional (P14 of
     the continuation plan, the prototype's layout): the members `request`,
     `requestHash` and `outcome`; a request that is the one argument of the
     call, or the arguments in order; and every reference of the request
     followed. Three points are open under it. `builtin-inventory.md` says per
     built-in which operands are read by value and how deep, and "every
     reference" is wider than that for a built-in with a reference operand. That
     document has the schema of a `fetchJson` request as part of the request and
     its hash, and the layout has no place for it. And where the claim is held
     is not said. If the owner decides otherwise, the bullet "Layout" changes,
     and the prototype follows the depth of each built-in's entry. It is
     question 281 of the continuation plan.
101. **A request one of whose paths has a failed cone** (section 6.4). The
     section has the error state at the path whose cone failed. *Assumed,*
     provisional (P16 of the continuation plan): one error state for the whole
     request, since the prototype forms the request with one function. The
     alternative: the request function is split by path, and the stored request
     holds the values of the other paths. Under both the request is not made and
     the readers of the result fail in turn; the two differ in what the state
     document holds and in the label of each path. The prototype tests the first
     on `fixtures/effects.tsx`, which has no per-element construct. It is
     question 283 of the continuation plan.
102. **The value code of a pattern that is compiled in** (section 2.1).
     *Assumed,* provisional (P18 of the continuation plan): one function per
     cone of the pattern's record, registered once, and handed the constants of
     a call as slot values. Question 81 has the text of the module, and its
     sentence on a function for each call is superseded under this assumption.
     Not determined: how a handler that is written in place in a callee, and
     that captures names of the callee's scope, is registered once for all
     sites. It is part of question 247 of the continuation plan.
103. **Part documents: a row is a part by its own size alone, and a long
     array is stored in chunks** (section 4.10). *Assumed,* provisional
     (P20 of the continuation plan, the coordinator's decision, and not
     ruled): rules 1 to 4 of the section and the paragraphs on chunks.
     The alternative is a rule that makes every split point directly
     below a document a part, whatever its size, when the document
     exceeds `DOCUMENT_MAX_BYTES`. The prototype measured that rule on a
     `map` over an array of plain values in place with rows of 23 bytes:
     2,800 part documents created in the transaction that crosses the
     number; an array of storage links of 61 bytes each that is larger
     than the rows it replaced, exceeds the number and has no split
     point; and at 10,000 rows 610,081 bytes of documents written for
     an append that puts 98 bytes in. If the owner decides for that
     rule, the constants `PART_MIN_BYTES` and the paragraphs "A long
     array is stored in chunks" to "Worked sizes" of section 4.10 are
     removed with the sentences that name a chunk in sections 2.2, 4.1,
     4.2 and 10.1, and the measured cost stands. Five points under the
     decision follow: two are open, and three are decided provisionally.
     - **(a) Whether storage takes a patch below a path of a document,
       and the size of a chunk.** Section 4.2 has the write of a kept
       collection as a `splice` of the stored array. Today's storage
       takes such a write as a patch, by the source that section 4.10
       cites ("What today's storage does with a write below a path"):
       the writer sends the operations at the paths it wrote, and the
       server stores them as one row. It also stores the whole document
       after every tenth patch, and it sends the whole document to
       every subscriber for every change. So an edit of one small row
       of a chunk costs the writer the bytes of the change, the store
       those bytes and a tenth of the chunk on average, and each
       subscriber the chunk. The prototype measured the chunk written
       whole: 122,242 bytes in 2 documents for an edit of a row of 23
       bytes at 10,000 rows with a maximum of 65,536, and 8,130 bytes
       with a maximum of 4,096; a chunk and its list are of one size at
       `C = sqrt(75 * N * s)`. Not decided, and nothing is assumed
       beyond the placeholder of 65,536: whether the size of a chunk is
       chosen for what a subscriber receives, which wants a small
       chunk, or for the number of documents and reads, which wants a
       large one; whether the maximum follows the size of the array;
       and whether the design requires of storage a sync that carries
       the patch of a document, which today's has not. The author of
       this document recommends that the last be required, since with
       it every figure is the bytes of the change and the size of a
       chunk is chosen for reads alone.
     - **(b) Whether a chunk list holds the number of entries below each
       link.** *Assumed,* provisional (P25 of the continuation plan, the
       coordinator's decision, and not ruled): it does. A read by
       position then loads one document for each level of the tree and
       one chunk, and each insertion or removal writes the chunk and
       one list for each level, each a document of at most 65,536
       bytes of which one number changes. The alternative is a list of
       links alone, which an insertion does not write and under which a
       reader of one position that holds no numbers reads every chunk
       before the position. If the owner decides for it, the numbers
       leave the paragraphs "The chunk list", "How a position is
       derived" and "What one change of an array writes".
     - **(c) Which arrays.** *Assumed,* provisional (P26 of the
       continuation plan, the coordinator's decision, and not ruled):
       every stored array, the array of an argument document, of a
       parameters document and of a state cell document included, so
       that an array of plain values in place that a handler or a
       client writes is not one document at any length: it was 676,691
       bytes for the 10,000 small records that the prototype measured.
       The alternative is the arrays of a result alone. Question 107
       has what conflicts with the decision.
     - **(d) The stored form of a chunk list and the serial number in the
       identifier of a chunk.** Both are assumed in section 4.10. With
       the serial number in the list at the place of the array, a split
       writes that list.
     - **(e) A document of many small members.** A record whose
       members are each under `PART_MIN_BYTES` and that exceeds
       `DOCUMENT_MAX_BYTES` is stored in chunks by rule 5 (provisional,
       P27; question 108).
     The numbers are placeholders (question 32), and the encoding that a
     size is measured in is question 96. The same for an array over an
     array of references, over an array of plain values in place, over a
     plain array generated from scratch, and over the result of another
     per-element construct. It is questions 229, 264 and 290 of the
     continuation plan.
104. **A cone that places the result of a per-element construct and
     observes nothing of it** (sections 2.2, 2.5, 3.3 and 10.1). Three
     sentences made such a cone stale for a change of one row:
     `plan-and-label-templates.md` §1.4, "The enclosing cone uses the
     assembled result"; section 3.3, "An entry is not current when an
     upstream output it pulled has a different value from the one
     recorded"; and the first assumption of question 82, that a value
     function returns the whole constructed value. The worked example of
     section 10.1 lists no cone of the tree among the cone instances
     evaluated behind a send. *Assumed,* provisional (P22 of the
     continuation plan, the choice of the prototype's author): the cone
     holds a collection reference, the rows are stored by the
     collection, and the enclosing cone and the `result` cone are not
     evaluated for a change of one row, which is the reading of section
     10.1 (section 2.2, "A collection that a cone places"). It applies
     to the result of a `map`, a `filter` and a `flatMap` over an array
     of references, over an array of plain values in place, and over the
     result of another per-element construct. If the owner decides
     otherwise, that paragraph and the provisional sentences of sections
     2.5, 3.1, 3.3 and 10.1 are removed, a cone returns the rows, and
     the work and the bytes of one change follow the list at every
     enclosing cone. Three points under the decision are open. (a) One
     collection placed at two kept paths: *assumed* stored at both.
     (b) A per-element construct over a plain array generated from
     scratch: *assumed* the same; the prototype forms the assembly of
     such a construct whole and did not test it. (c) What a path of a
     child's argument or of a request holds where a derived collection
     is passed on is not changed by the decision and is as
     `plan-and-label-templates.md` has it. It is questions 259 and 292
     of the continuation plan.
105. **Whether the steps of section 2.5 prescribe an algorithm** (section
     2.5). Step 2 reads "Compute the key of every position", and
     `scheduler-and-serving-loop.md` §3.2 has the evaluation rebuild the
     table. *Assumed,* provisional (P23 of the continuation plan, the
     choice of the prototype's author): the steps state the result, and
     a runtime may keep the key of a position that no write touched and
     bring the table and the assembled result up to date from the
     splices of the source. The prototype measured, at 10,000 elements
     of an array of plain values in place, 1 salted hash for one change
     with the keys kept and 10,000 with every key formed. No value and
     no key differs. If the owner decides that the steps are the
     algorithm, the paragraph "The steps state the result" is removed
     and each change of membership costs the length of the list. It is
     question 256 of the continuation plan.
106. **What a re-key does with the stream documents of the old key**
     (section 2.5, "A write that changes the value re-keys the
     element"). The case is an array of plain values in place with no
     declared key; it does not arise with `ArrayByKey` or over an array
     of references. The section has the runtime move "the state cells,
     the streams, the operation state and the children", by writing
     them under the identifiers of the new key and retiring those of
     the old key. A stream has a document from its first event (section
     4.7). The prototype makes no document for the stream of the new
     key until an event arrives for it and leaves the stream document
     of the old key: 20 edits of one row, each followed by an event for
     the row, leave 20 stream documents. Not determined: whether the
     move writes a stream document under the new key, and when a
     document that the move retired is deleted. Nothing is assumed. It
     is question 295 of the continuation plan.
107. **A source array that is stored in chunks, and its writers**
     (section 4.10, "An array of an argument document or of a state
     cell"). Provisional decision P26 stores the array of an argument
     document or of a state cell in chunks, and P25 has a chunk list
     hold the number of entries of each chunk. Five points conflict or
     are not determined.
     - **(a) A mergeable `push`.** A `push` that reads nothing of the
       array commits without a conflict with another such `push`
       (`footprint-analysis.md`, "A read and a push"). With the array
       in chunks, each push writes the last chunk and the number of
       that chunk in each list, so two concurrent pushes write the
       same number, and a push that fills the chunk splits it. Either
       storage applies the push and the layout itself, below the
       operation that the writer sent, or two such pushes conflict.
       *Assumed:* the writer sends the operation on the array at its
       path, and the layout is applied where the operation is applied,
       so that the pushes merge as today. Verified against source
       (section 4.10, "What today's storage does with a write below a
       path"): today the writer sends `append` with the path of the
       array and the values, and the server applies it to the array of
       the one document that the operation names. Today's server has
       no layout of one array across documents, so the assumption
       requires a change of storage: the server resolves the path of an
       operation through a chunk list, applies `append`, `add-unique`
       and `remove-by-value` to the chunks, and maintains the lists,
       and the numbers in the commit. Without that
       change, by inference and not by a test: a `push` can still merge
       where the writer sends `append` to the last chunk and
       `increment` for the number of each list, both of which today's
       server applies against what it holds, provided that a split
       never changes which document is the last chunk; a split and a merge
       are then writes of the runtime that
       conflict with a concurrent `push`; and `add-unique` and
       `remove-by-value`, which compare with every entry of the array,
       cannot be sent to one chunk and stop merging. The author of
       this document recommends the change of storage. Not decided.
     - **(b) A writer that is not the compiled runtime.** A client, the
       command line and a runtime of the validation period read and
       write the document by its address. *Assumed:* each reads and
       writes through the chunk list as the runtime does, and a writer
       that does not know the form is refused where it writes at or
       below the place of the array. Section 9.7 says nothing of it.
     - **(c) The labels.** A chunk's envelope is complete for its
       paths. For a source document the entries are those that its
       writers and its schema give. *Assumed:* they are repeated in
       each chunk as for a result.
     - **(d) An element of at least `PART_MIN_BYTES` is a part,** with
       a minted identifier (provisional, P28), and the scheme and the
       identifier of a chunk of a source document: all three are
       assumed in the section. The alternative for the first is that no
       element of a source array is a part, and an element larger than
       `DOCUMENT_MAX_BYTES` is a chunk of one entry.
     - **(e) A record of a source document** is stored in chunks by
       rule 5 (provisional, P27). A write of one member by a writer
       that names the path, and a mergeable `increment` below it, meet
       the same conflict as point (a).
     A `set` of the whole array, a `splice` and a reference by key into
     the array have no conflict that was found: each names the array's
     path, or the array and a key, and resolves through the chunk list.
     The case is an array of plain values in place and an array of
     references in an argument document or a state cell; the result of
     another per-element construct is an array of a result and is not
     this case. It is question 296 of the continuation plan.
108. **A record with many members is stored in chunks** (section 4.10,
     rule 5). *Assumed,* provisional (P27 of the continuation plan, the
     coordinator's decision, and not ruled). The prototype measured
     what the decision removes: a record of an argument that holds one
     member for each of 10,000 elements is one document, and one
     keystroke in one member writes 572,774 bytes of documents for 25
     bytes of change. The alternative is that a record is never
     divided. If the owner decides for it, rule 5 and the paragraph "A
     record with many members is stored in chunks" are removed. Not
     determined by
     the decision, each *assumed* in the section: (a) the bound beside
     each link is fixed when the chunk is created, so an insertion
     writes no list; (b) the bounds are member names and are read
     under the label of the record's set of names; (c) where a record
     exceeds the number and holds arrays that are each under it, the
     largest arrays are stored as chunk documents first, which is what
     the prototype built for a document of several arrays, and rule 5
     takes what is left; the alternative is rule 5 alone; (d) a member
     is no part for being a member; (e) a `FabricMap` is not divided;
     (f) the order of the names is that of provisional decision P1,
     and the place of a name that reads as an integer is part of
     question 94. The prototype builds none of it. It is question 297
     of the continuation plan.
109. **The identifier that a part of a row is minted with** (section
     4.10, "How a part document is identified"). *Assumed,* provisional
     (P28 of the continuation plan, the coordinator's decision, and not
     ruled): a part that is a row or lies below a row is identified by
     a minted number and by no key. The alternative is the key of the
     element, hashed under the secret of the space, with which an edit
     that changes the key renames the part and a source array has no
     name for the part of a row before a reader forms keys. If the
     owner decides for it, the paragraphs "How a part document is
     identified" and "A re-key of an element" return to the key, with
     the sentences of sections 5.2 and 5.3. Not determined by the
     decision. (a) Where the number comes from. *Assumed:* one counter
     at the root of the result cell or of the source document, which
     each creation of such a part writes, so two transactions that
     each create one conflict. A counter for each array has no home
     while the array is stored in place, and is not unique where the
     array lies inside a row of another array. An identifier derived
     from the cause of the creating transaction and an ordinal needs
     no counter and no write, and requires that every transaction have
     an identifier that a retry repeats, which the documents have for
     a handling and not for every cause. (b) What a reader of the
     storage link learns: with a counter, the order in which the parts
     of one document were created. (c) A row of a result whose key
     changes at its position: *assumed* to keep its part, where the
     prototype deletes and creates one. (d) A part that lies below a
     row and is no row: *assumed* minted as a row's is. (e) What gives
     the scheduler the kept paths of a watch on such a part:
     *assumed* the steps with the hashed keys, held in the part as
     data. (f) A reference by key from a client that cannot read the
     salt is not affected: no client derived the identifier of a part
     before, and a client reaches a part through its storage link. One
     thing is lost on the server: a runtime could form the identifier
     of the part of a key and read it with no chunk, and reads the
     chunk of the key first. It is question 298 of the continuation
     plan.
110. **The index from a key to its chunk** (section 4.10, "Finding the
     chunk of a key"). Open, with no provisional decision. Until it is
     decided, a runtime that does not hold an array's keys in memory
     reads the array's chunks in order to resolve a reference by key, and
     no index is stored. Chunked storage of long arrays is a requirement
     on the storage layer and is decided there; this design keeps the
     split points, P22 and the bound on what the change of one row
     writes (the coordinator's recommendation on the scope of the storage
     decisions, not an owner ruling). The points below are what any index
     has to settle. (a) What the "stored schema" of an array is, since by
     ruling no record of a stored schema is kept. *Assumed* for any
     index: the schema that the plan of the owning instance has for the
     place, with the names of the key fields written into the chunk list.
     (b) What an entry names. An entry that names the chunk is written
     again for every row that a split or a merge moves, and those entries
     are spread over the whole index by the order of the hashes, so one
     split can write every chunk of the index, which the bound of section
     4.10 on the bytes of one change does not cover. An entry that names
     a number minted for the row, with the chunk found from a second
     record that a split writes once, or a record in the chunk list of
     which chunk each chunk was divided from, would bound it; neither is
     designed. (c) Two rows with equal key fields, whose keys differ in
     the occurrence count: an insertion before the first changes the
     count of the later ones. (d) A client, which holds the hash of a
     stored reference and could find the chunk, and cannot tell which
     row of the chunk has the key. It waits for the assumption on how a
     client resolves a reference by key (`plan-and-label-templates.md`
     §8, question 113). (e) The label of the index documents: that of
     the array's membership is the candidate. (f) An array of references,
     whose key is the identity of a cell, and an array with no declared
     key: no index is the candidate, with a read of every chunk on a
     runtime that holds no keys. (g) The result of a `map`, a `filter` or
     a `flatMap` over an array of plain values in place with a declared
     key, and over the result of another per-element construct, whose
     rows have the upstream keys: an index of its own under those keys
     is the candidate. (h) A collection that is placed at two kept paths
     (question 104) would have two indexes, and each change would write
     both. The prototype builds no index. It is question 299 of the
     continuation plan.
111. **Points that the rule on chunks leaves open, as the prototype
     built them** (section 4.10, the paragraph of that name and the
     paragraph "A long array is stored in chunks"). Each is *assumed*
     as built: an empty chunk is deleted; an array is stored in place
     again when one chunk of at most half of `DOCUMENT_MAX_BYTES` is
     left; the largest arrays of a document that exceeds the number
     become chunk documents of their own; a chunk over the number is
     divided into equal shares, more than two where one transaction
     wrote many rows; an array that is written whole is compared with
     what is stored, which reads the whole array; and the first write
     of a long array creates all its documents in one transaction.
     Measured and not changed: rows inserted one at a time at one end
     leave every chunk half full, 55 chunks for 40,000 small rows
     where 28 would hold them. Open: whether a split leaves the full
     chunk behind where an array grows at an end, which would halve
     the documents of a list that is appended to. It is question 300
     of the continuation plan.
112. **The runtime's report of state under a key formed from a whole
     value** (section 2.5). *Assumed,* provisional (P21 of the
     continuation plan as replaced, the coordinator's decision, and not
     ruled): the report `array-by-key:state-under-value-key`, once for
     each collection in a session, at the first change that moves
     stored state to another key or leaves it under a key that left.
     It replaces a compile-time warning, which the prototype counted
     over the corpus: 168 reports in 80 of 286 modules, most of them
     for lists that hold references at run time, which the type of an
     array does not tell from plain values in place. Not determined by
     the decision, each *assumed* in the section: the name; the
     channel of the report; what a session is for a transaction that a
     server evaluates; and that a change counts where one transaction
     removes a key at a position and enters another there, and a
     removal alone, which also leaves state stored, does not. It is
     question 301 of the continuation plan.
113. **What value code writes for a pattern closure used as a value**
     (section 2.2). *Assumed,* provisional (P35 of the continuation
     plan, the coordinator's decision, and not ruled): a member
     `closure` of `ConeHost` that returns a marker, which the runtime
     replaces by the factory value when it stores the value. The
     alternative has the value function return the record, which needs
     it to hold links and the content address of the inline pattern. It
     is question 309 of the continuation plan.
114. **The stored form of the factory value of a pattern closure**
     (section 4.6). *Assumed,* provisional (P34 of the continuation
     plan, the coordinator's decision, and not ruled): a record in
     place with the content address of the inline pattern and a member
     `params`. The alternative is a parameters document that the
     factory value links to, shared by every holder of the factory. It
     is question 308 of the continuation plan.
115. **Where a value of narrower scope that a cone of the space places
     is stored, and for which keys** (section 1.8). *Assumed,*
     provisional (P454 and P455 of the prototype, the coordinator's
     decisions, and not ruled): one document for each output and element
     keys, with a scope instance for each key that evaluated the value,
     made for every key a derivation runs for. The alternative named
     first, one document of the scoped values per instance with each
     value at the output and the element keys, holds one value per row in
     a document a change of one row writes, so a change would store a
     document that grows with the rows. Not decided: whether a key's
     instances are made only while a reader of that key demands them, as
     today's runtime derives a cell of a session only for a client that
     subscribes to it, which also bounds the documents and the memory that
     follow the keys a piece has seen.


### 11.2 For another document or the prototype

To `scheduler-and-serving-loop.md`:

5. **Dirty slots since a commit.** Withdrawn. The scheduler marks the stale
   cone instances from the basis rows of its §10.4 (section 3.4 here).
6. **Routing an event to a binding.** Met by its §5.1, and ruled. A
   stream document holds the entries and the `eventWatermark` and is
   created by the first append. An event is routed by a row of the stream
   index, one row per stream beside the basis index, from the stream's
   identifier to the instance and the binding, which also leads to an
   instance that is not loaded (section 4.7 here). The row takes the
   place of the back-link that setup stores on a stream's document today.
   The row is written in the store transaction of a wave, or of a setup
   transaction (request 52). Its open question 26 leaves the size of the
   index to the prototype.
7. **Several scope keys in one transaction.** Met by its §10.3.
8. **The first evaluation as a cause.** Ruled: a change of demand is the
   fourth kind of cause (section 1.1), as its §4.5 has it.
9. **What is watched.** Withdrawn. The scheduler registers a slot's bound
   address from the plan and the bindings, and holds the journaled reads of
   a `dynamic` node and their trigger reads in the instance record (its
   §3.2 and §3.4). The memo keeps its own copy of what an evaluation read
   (section 3.1).
10. **A client and the element-key salt.** Ruled (section 5.3). What a
    client shows for state it cannot name is that document's to state.
11. **The identifier of a space an `inSpace` request creates.** Ruled
    (section 5.6), and met by its §9.4: the genesis commit of the space
    and the step that records the allocation come ahead of the staged
    access changes, the batch that writes the instance's documents in the
    other space, and the home writes.
12. **Staged events and effect requests.** Met by its §5.1, §6.2 and §9.3:
    an event a handler sends joins the queue when the sending transaction
    seals; one for a stream of the same space joins the batch, and one for
    a stream of another space leaves through the outbox after the commit
    (sections 1.4 and 10.1 here). Every effect request a handler makes is
    sent when its event's transaction commits (section 6.4 here).

<!-- The list restarts so that the numbers stay as cited. -->

35. **The evaluation count, and gates** (sections 1.5 and 2.7). Met by its
    §8.1 and §5.3: cone evaluation keeps the count of evaluations per cone
    instance and transaction, the instance record keeps no second count,
    and no gate holds a cone instance.
36. **Stale, and unstored** (sections 1.7 and 3.3). Met by its §3.5, §5.6
    and §10.4: after a rejection, an abort, a withdrawn attempt, a
    requeued event, a dropped write or a withdrawn write, the scheduler
    does not advance the basis rows of the cone instance, records the
    refusal of a dropped write with the instantiation key it failed
    under, and has an unstored output stored when something demands it,
    without treating the cone instance as one that needs an evaluation.
    An event's transaction is among what demands it: an unstored output a
    handler reads by address is staged from the memo before the read
    (section 1.3 here; its §5.2 and §5.3).
37. **A read made current at the read** (sections 1.4 and 2.4). Met by its
    §5.3: a stale cone instance of a loaded instance of the same space
    that writes the address is evaluated before a journaled read returns.
    Where the writer is in an instance that is not loaded, the basis rows
    decide, by ruling (its §4.4, §5.3 and §10.4). Where they show the
    stored value current, the read returns it and the instance is not
    loaded on account of the read, for a handler and for a body inside a
    cone alike; standing demand that reaches the instance through the
    registered address loads it (its §4.4; section 3.4 here). Where they
    show it stale, a handler's attempt is withdrawn whole, the instance
    is loaded, and the event is dispatched again under the same handling.
    A body inside a cone, in a derivation transaction, reads what is
    stored and is evaluated again after the instance was loaded and the
    writer evaluated.
38. **Element entries come from the element table** (section 2.5). Met by
    its §3.2: the scheduler registers the per-position entries of element
    slots after the collection's first evaluation and after each change of
    membership, from the table cone evaluation holds, and does not build
    them when the instance is loaded.
39. **Instances a computation makes** (section 2.8). Met by its §2.7, §9.3
    and §10.3: an instance made in a transaction gets its record in that
    transaction when something demanded reads it; an instance marked as
    torn down is not loaded, its queued events are not handled, and a
    completion that arrives for one of its effect operations writes
    nothing; and the step in another space of an `inSpace` instantiation
    by a computation acts as the principal of the scope key the making
    cone instance is evaluated for. That the transaction that tears an
    instance down marks the instances that belong to it is stated in
    section 2.8 here, and that document follows it. The mark of a
    torn-down instance in another space, and a changed argument of one,
    are carried as its §9.3 says. That a cone instance of space scope
    cannot instantiate with `inSpace` is an assumption there (its open
    question 34).
40. **Demand over several documents** (section 4.10). Met by its §4.2:
    demand is per kept output path whichever document stores the path, and
    a watch on a part document by its own address is mapped to kept paths
    through the `result` link and the path at the part's root.

<!-- The list restarts so that the numbers stay as cited. -->

48. **A derived write that was instantiated early is not withdrawn**
    (section 1.6). Met by its §3.5 and §5.2: a derived write of a cone
    instance evaluated before a handler body, a kept output or a write
    edge of the cone, is withdrawn before the preparation when the body
    wrote something that cone instance had read, unless the write was
    instantiated early. A write instantiated early was instantiated
    before the body wrote, the handler's own writes use it, and it
    commits with the event's transaction.

<!-- The list restarts so that the numbers stay as cited. -->

53. **The rows a setup transaction writes** (sections 4.7, 9.4 and 9.8).
    Met by its §10.8, §5.1 and §10.4: the store transaction of a setup
    transaction writes the basis rows of the cone instances it evaluated
    and the stream rows of the streams it computed, and deletes the basis
    rows of the earlier compiled identity.
54. **An effect operation a handler requested, after a restart** (section
    6.4). Met by its §2.3 and §10.6: the operation's state document holds
    a `result` back-link to the result cell of the instance whose handler
    requested it, which this document stores, and a pending operation has
    a pending-effect row beside the basis index, which activation reads.
55. **A materializer after a restart, and a handler that waits for one**
    (sections 1.3 and 6.7). Met by its §7.2 and §10.4: a materializer has
    basis rows, keyed by its operation in the place of a cone; and an
    event whose handler reads an invalid materializer that cannot run
    ahead holds its place until the derivation transaction and the
    materializer have run.
56. **A child's argument whose writer is not loaded** (sections 3.4 and
    4.6). Met by its §4.4 and §5.3: the argument document is read as
    stored, like a cell written through a handle. This document stores no
    link from a child to the instance that writes its argument. It is an
    assumption, and extends question 57 of the continuation plan.

To `plan-and-label-templates.md`, with the specification change where a
label is concerned:

13. **The label of an operation's bookkeeping state.** Met by its §2.6: the
    confidentiality of `Operation.input`, instantiated, and no integrity.
    The request hash, the claim and the pending mark of an effect carry
    the joined label of its §3.14, and for a request a handler made the
    join is over the templates of its `request` write edges (sections 6.4
    and 6.5 here).
14. **The label of a cached output.** Met by its §2.6, which also makes the
    cache document a store the runtime owns (section 8.6 here).
15. **The protection of provenance records and origin facts.** Met by its
    §2.6, with another rule than this document assumed: a provenance record
    carries the confidentiality of the output's instantiated label joined
    with the label of the label-metadata observation at the path (section
    7.4 here).
16. **What the prepared digest binds.** Met by its §4.6 (section 1.9 here),
    request 41 included.
17. **The `shape` entry of a migrated path.** Met by its §2.6, "A stored
    link that becomes a value" (section 9.2 here).
18. **Cache promotion as a channel.** Met by its §5.5.
19. **Inputs of a cone and of a body that are not slots.** Met by its §1.4,
    by `Body.computed`, and by the cone-level join of its §7.2 (sections
    2.1 and 2.2 here).
20. **The order of `Plan.cones` and `Plan.outputs`.** Met by its §1.4.
21. **Names.** Met by its §1.3 (sections 5.2 and 5.5 here). Two
    declarations of one name take an ordinal among declarations of that
    name, which its open question 18 lists.
22. **The scope of an output.** Met by `Output.scope` and its §1.4 (section
    1.8 here).
23. **A promotion directive per cone.** Met by `Cone.cache` (section 8.5
    here).
24. **State of an operation inside an element body.** Met by its §2.6: the
    state is per element key, the layout is this document's choice and
    changes no label, and in a document that held several keys the key set
    would carry the collection's membership label. This document chooses
    one state document per key (section 6 here). The state of one key
    carries the label of the one position that holds the key (section
    2.5 here).
25. **The back-link of a state cell.** Met: a state cell document keeps the
    `result` back-link, which its §3.16 has `resultOwnerOf` read, and
    carries no pattern reference, manifest or setup record.

<!-- The list restarts so that the numbers stay as cited. -->

41. **Units of the preparation, and a withdrawn write** (section 1.9). Met
    by its §4.5 ("What a write uses") and §4.6 ("Units"): the preparation
    records what it verified per unit, the digest binds the dropped and
    the withdrawn writes and is over the units that commit, the commit
    leaves out every unit that uses a unit it leaves out, and nothing is
    verified again. The third condition of its §4.1 covers an output whose
    write a conflict withdrew. That a withdrawal takes the using units
    with it is its open question 28, for the project owner.
42. **A part's envelope is complete for its paths** (section 4.10). Met by
    its §2.3: a part document repeats, for its own paths, the entries a
    `*`-child entry in the collection's document covers, and the two
    agree. Its §2.3 also has the identifier of a part document reveal no
    element key, which section 4.10 here meets with an identifier that
    holds none (provisional, P28). Its open question 19 is answered here:
    section 4.10 has
    which subtrees get a part document, how one is identified, how a
    storage link is told from a reference, and what a reader demands;
    section 1.6 has which transaction stores a kept output computed
    before a handler body, and which derived writes are instantiated
    before a handler body reads them; sections 1.4 and 2.4 have the read
    through a handle; section 1.9 has the units; section 6 has the layout
    of an operation's state in an element body; and section 6.7 has the
    computed inputs of a materializer.
43. **An instance a computation makes** (section 2.8). Met by its §1.3,
    §2.6 and §3.14: the identity, the argument's write edges as the
    cone's, what a failed evaluation leaves, and the label of the record of
    the instances an evaluation made. This document adds where that record
    is stored, the mark on an instance that was torn down, and what
    becomes of its documents (section 2.8), and where the parameters of an
    inline pattern are stored (section 4.6).
44. **The handling, sent events, and `inSpace` identifiers** (sections 5.4
    and 5.6). Met by its §1.3 and §3.14: the handling is the receipt, an
    event a handler sends is identified by the handling and its order
    among the events that invocation sends, and the identifier of a space
    a request creates is obtained and recorded by a write the body stages.
    Question 47 is what remains.

<!-- The list restarts so that the numbers stay as cited. -->

49. **The key set of a document that holds several element keys**
    (sections 2.8 and 8.6). Met by its §2.6 ("The state of an operation
    inside an element body"): the cache document and the instances
    document hold several element keys, the set of keys under one cone in
    each carries the collection's instantiated membership label, and a
    key derived from a value is the salted one.
50. **The order of an early instantiation** (section 1.6). Met by its
    §4.5 ("Order" and "A write instantiated early") and §4.6: a derived
    write that a handler body reads by address is instantiated before
    that read returns, and a derived write staged at an address that was
    read by a cone instance whose value the handler receives, directly or
    through `output` edges, is instantiated before the handler's argument
    is built. Each is instantiated after the staged writes it uses and
    ahead of the handler's write edges. The preparation does not
    instantiate it again, and a label the body stages afterward does not
    enter it.
51. **What is stored per key** (section 2.5). Met by its §2.6, which
    lists everything an element cone stores per key: a kept output, the
    state of an operation, the stored request and the
    result of an effect, a path of the argument of a child or of an
    instance the cone makes, a side-write, a copied path of a binding or
    of an inline pattern's parameters, an entry of the cache document,
    and the record in the instances document. A key stands at one
    position, and each carries the label of that position. No label is a
    join over positions (section 2.5).

75. **How value code reads the child a dynamic key chose** (section
    2.2). Open, as its question 46; the prototype takes a provisional
    decision, P453. Its §3.18 binds the child slots of a `pick` over a
    container slot to the chosen path. Handing the function every child
    of the container loads every child, and makes every cone instance
    that chose one child stale when any child is added, removed or
    written, so a `map` whose rows each read one member of a record by
    the row's key evaluates every row when one member changes. Under
    P453 the function passes the key to `ConeHost.slot`, which reads the
    chosen child alone, and a member read of an output passes the path
    to `ConeHost.output`. The binding of the child slots to the chosen
    path happens at that call, which is the alternative this question
    named.

<!-- The list restarts so that the numbers stay as cited. -->

57. **A choice point per `pick`** (sections 2.2, 3.1, 3.3 and 7.2). Met by
    its §1.1 and §3.18: every `pick` node has an index into `Plan.picks`,
    the value code reports the chosen key per choice point, and a cone
    instance that reaches an upstream output only through picks is stale
    only when a child it chose changed. This document keys `picks` by
    choice point and has the memo record the chosen children.
58. **A refusal records an instantiation key** (sections 3.1 and 3.3). Met
    by its §4.4: the refusal of a derived write records the instantiation
    key of the write's template, for every kind of constraint, and the
    write is attempted again when the key changes.
59. **The link between scope instances** (sections 4.2 and 4.10). Met by
    its §2.3: the link from a broader scope instance to a narrower one is
    a storage link, and may hold a declared scope. Its §5.5 lists what
    the presence of such a link shows. The stored form is an assumption
    of this document.
60. **The allocation record** (section 5.6). Met by its §3.14 and §4.6:
    the record is a write of the requesting unit that commits ahead of
    it, and is instantiated from stored labels only. This document says
    in which document and under which identifier it is stored.
61. **A cell created under a constant cause** (sections 5.2 and 5.5). Met
    by its §3.14: such a cell is a `StateCell` that records the body's
    `within` and a `name` formed from the body's name and the cause, and
    the `createCell` site refers to it by index. Its document has the
    preimage of section 5.5.
62. **The output that stands for an assembled collection** (section 2.5).
    Met by its §1.4.
63. **A slot whose path holds `*`** (section 3.2). Met by its §2.5: such a
    slot is bound at one address per child the path reaches, each with a
    chain of its own. The memo's fingerprint of the slot is over all of
    them.
65. **Which element bodies instantiate a child** (sections 2.5 and 5.3).
    Met by its §1.3 and §2.6. A child is named through the element key
    and puts no position in it, so the plan records nothing in the
    `Collection` for it. Its §2.6 gives the record of
    the children of an element body, which this document lists in the
    instances document per element key, the collection's membership
    label.
66. **The label of a database declaration's state document** (section
    6.8). This document stores the handle once, under the `of:` scheme,
    and gives it no label rule. Met by its §3.14, as an assumption (its
    open question 40): the document carries the label its §2.6 gives an
    operation's bookkeeping state from `Operation.input`, which is
    `const` for a database, so the handle carries no label beyond what
    the table declarations in it declare, as today.

To `language-subset.md`:

26. **The spelling of the promotion directive** (section 8.5). Not met:
    that document has no form by which an author writes it (its open
    question 10), so a compiled plan leaves `Cone.cache` absent and the
    runtime decides.
68. **The name of a diagnostic** (section 2.8). Met by its
    §10.3: the warning for an
    instantiation inside a loop or a callback of a function body that has
    no `.for(cause)` is `function-body:instantiation-without-cause`.
27. **Stored source.** Section 9.4 compiles an instance's stored source.
    That document's open question 7 asks with which severities. *Assumed:*
    the interim acceptance of the removed forms applies, and any other
    refusal leaves the space of the instance on the builder path
    (question 70).

To `footprint-analysis.md`:

45. **Its requests 8 and 17 are answered in section 2.4:** what the
    argument holds for an entry of each class, a `shape` entry in place
    included, the reference stand-in at a position of data type and at a
    position typed `unknown`, that a value passed on unchanged is stored as
    a reference, that `get()` and `sample()` through a listed handle read
    under the entry's envelope, and that the handle for a resolved entry
    is the resolved reference. Section 4.7 has what a binding's state
    document stores, with the same stand-ins. Its request 9 is answered in
    section 2.8: the instantiations of an evaluation are staged when the
    invocation ends and exist when the transaction commits, the instances
    made are compared site by site with those of the last committed
    evaluation, and the ones no longer made are torn down.

To the prototype:

28. **The iteration bound** of section 2.7. Ruled as ten, a placeholder
    fixed with the plan version. The measurement of how many patterns need
    more remains.
29. **The constants of section 8.3**, and the costs `read`, `write` and
    `hold`.
30. **Mixed labels in a kept collection.** Where positions differ in
    label at a path, section 4.3 stores no `*`-child entry there and one
    entry per position. Whether a shared entry for the common part and
    per-position entries for the rest is smaller needs measurement. The
    collection is the stored result of a per-element construct, and the
    question does not depend on whether its source is an array of
    references, an array of plain values in place, or the result of
    another per-element construct.
31. **Matching calls at migration** (section 9.3). How many compiled-in
    calls in the corpus the matching places, and how much state is stored
    under the ones it cannot.

<!-- The list restarts so that the numbers stay as cited. -->

46. **A cone instance evaluated while a body is suspended at a read**
    (section 1.4). Whether the sandbox allows one body to run while another
    waits at a read, and how the budgets of the two are counted.

From the prototype's executor, for this document to decide:

<!-- The list restarts so that the numbers stay as cited. -->

81. **The text of the value-code module** (section 2.1). *Assumed:* one
    function per source module, with the module's statements of module
    scope and then a registration of each function the plan needs from
    it, and a function per call of a pattern compiled in that is given
    the constants of the call. The prototype emits these texts as
    members of one record beside the plan and the schema documents, and
    not as one text, so it forms no `CompiledPattern.valueCode`. Its
    emitter also writes one function per value a cone computes where
    section 2.1 has one per cone; the two hold the same code wherever a
    cone has one value that another record refers to.
82. **What a value function returns for an output with entries below
    it, and for the constant paths of the result** (section 2.2).
    *Assumed:* the whole constructed value under the entry at its root,
    and for the `result` cone the whole returned record, constants
    included. The alternatives return each member under its own index
    as well, and hold the constant paths of the result in the plan.
    Provisional (P22 of the continuation plan; section 11.1, question
    104): where the value holds the assembled result of a per-element
    construct that the cone placed and did not observe, it holds a
    collection reference there and not the rows.
83. **In which transaction a first value that is not a constant is
    written** (section 4.1). By ruling a state cell whose first value
    is a constant, or that is declared with no value, has no document
    until something writes it, and a first value that is not a constant
    is written once through a write edge. *Assumed:* that edge is
    performed in the first transaction that evaluates the cone instance
    that computes the value, and only where the cell has no document.
    The alternative performs it when the instance is created or the
    element key enters the element table, which evaluates the cone
    without demand. The prototype's executor does the alternative, so
    `cell(index)` in an element body holds there the index the element
    had when its key entered. The two are the same choice over an
    array of references, over an array of plain values in place, and
    over the result of another per-element construct.
84. **A written value that holds a reference into what the write
    replaces** (section 2.4). *Assumed:* a member that carries a
    reference to an element inside the replaced path, by key or by
    position, where the element is held there in place, is stored as
    its value. The case is an array of plain values in place; a
    member that is a reference to a cell is stored as a link. It
    extends question 10 of the continuation plan. By ruling a
    function body that reads a plain value in place holds a copy, so
    the case remains only for a member that is a handle the body was
    given, and a body that exchanges members between two stored
    arrays of plain values in place and sets both stores the values,
    as the runtime of today does (`plan-and-label-templates.md` §8,
    question 115). What the write replaces is what the position the write
    lands at holds (section 2.4, "What a handle names"): where a handler
    stores again the record that its cell holds a link to, that link is
    no part of what the write replaces, and the record is stored as a
    link and not as its value.
85. **What a handle's reads and writes follow** (section 2.4). The owner
    proposed the rule on 2026-11-24, and the prototype takes it as a
    provisional decision, P471: a handle for an input names the cell the
    instance was given; `get()` follows one link past the write redirects
    and gives a value that carries the position it reached;
    `resolveAsCell()` follows every link; and `set()` replaces what the
    handle's position holds past its write redirects. It differs from
    the runtime of today, which makes the cell of every handle one link
    past its position, in three places: a handler given a state cell
    that holds a link writes to the cell and not to what the link names;
    a value it reads through an input bound to a position that holds a
    link carries the position the link names; and a plain value written
    to such a cell replaces the link.
86. **How the result holds a state cell or an input it returns**
    (section 4.2). Open; the prototype takes a provisional decision,
    P470, which follows the runtime of today: a write redirect, which a
    write through the result's path follows into the cell or the
    argument. The crate emits a read that value code returns of an input
    as the input itself, so an output such as `computed(() => x.get())`
    is held as such a redirect too, and a write through its path lands
    in the argument, where the runtime of today writes the output of the
    computation.
