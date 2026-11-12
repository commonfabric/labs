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
  collection. A cone outside every element body has one cone instance per
  scope key it is evaluated for.
- An **evaluation** is one run of a cone's value function for one cone
  instance.
- A cone instance is **current** when the memo holds an entry for it and
  nothing that entry records as read has changed. A cone instance that is
  not current is stale, in the sense of `scheduler-and-serving-loop.md`.
- A kept output, or the target of a write edge, is **unstored** when the
  memo holds a value or an instantiation key for it that storage does not
  hold (section 3.3).
- A **fingerprint** is a value that changes whenever the result of a read
  changes. Section 3 says what it is made of.
- A **split point** is a kept path at which a part document can begin
  (section 4.10).

## 1. One transaction per cause

### 1.1 Causes

There are four kinds of cause. Each opens one transaction in one space.

| Cause | What it carries into the transaction | Its transaction |
| --- | --- | --- |
| An event delivered to a handler | The event's payload (the `event` slot root), its key and its acting principal (the `cause` slot root), the handling it is (section 5.4), and the binding the stream belongs to (the `binding` slot root) | An **event's transaction**: the stale cone instances the handler reads, then the handler body. It holds no other derivation |
| A set of changes | The slots whose bound addresses changed, and the slots whose label alone changed. The changes are commits arriving from storage, written by another instance, by another runtime, or by the runtime itself, such as a clock tick (`plan-and-label-templates.md` §3.19), and the writes of the events of a batch | A **derivation transaction** |
| The completion of an effect | The `operation` slots of the completed operation. They are dirty because the operation's own completion transaction wrote the result and committed (section 6.4) | A derivation transaction |
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
one derivation transaction (`scheduler-and-serving-loop.md` §10.2). Which
changes form one set belongs to that document. Nothing below depends on the
choice.

A cause's transaction can evaluate more than one instance: a pull of an
output extends through a link into the producing instance, and a child
instance in the same space is evaluated in the transaction that pulls its
result (`plan-and-label-templates.md` §3.15). The order in which instances
are evaluated belongs to `scheduler-and-serving-loop.md`. Sections 1.3 to 1.5
describe the part of a transaction that concerns one instance. Section 1.6
describes the commit preparation, which runs once per transaction over
everything staged in it.

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
| Bind | The dirty slots, the label-dirty slots and the demanded outputs are bound. For an effect completion the dirty slots are the `operation` slots of the completed operation | Section 1.1 |
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
  nothing. Every path of the handler's state resolves through
  `Binding.state` to a slot or an output of the instance, the body of a
  per-element callback included. Where the path is an output, the cone that
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
- **A static read through a handle.** A read through a handle that
  `footprint-analysis.md` §7.2 makes static is a slot of `Body.reads` like
  any other, and is covered by the rules above.
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
runs, and the event is dispatched again (section 1.4).

### 1.4 The body

The runtime builds the handler's argument from the slots in `Body.reads`
and the entries of `Body.computed`, each validated against its schema and
narrowed to its class (section 2.4), hands the body the handles its record
names, and calls it once.

Before the argument is built, every derived write that this transaction
staged at an address a slot of `Body.reads` is bound to is instantiated,
and its constraints are checked (section 1.6, "What is instantiated
early"). The slot is then materialized from what is staged there, or from
what is stored where the check dropped the write.

During the call:

- A **write through a handle** is staged in the transaction. The runtime
  refuses a write that neither a `WriteEdge` in `Body.writes` nor a
  `WriteEnvelope` in `Body.envelopes` covers
  (`plan-and-label-templates.md` §3.11 and §7.4). A write through what
  `resolveAsCell()` returned, a target with `resolved`, lands in the cell
  where the resolution ends. The runtime resolves the reference when the
  write is made.
- A **read through a handle** follows the rules of section 2.4: it returns
  the materialized slots where slots cover it, it is journaled under the
  entry's envelope where the handle is listed in `Body.handles`, and it is
  refused otherwise.
- A **journaled read is made current at the read.** Before a read through a
  handle of `Body.handles`, or through a link the body follows, returns, the
  runtime looks up the address in the writer map. When a stale cone instance
  of a loaded instance of the same space writes it, that cone instance is
  evaluated first, inside the transaction and under the bound of section
  2.7. A derived write that this transaction staged at the address, by
  that evaluation or by an earlier one, is instantiated and checked before
  the read returns (section 1.6). The read then returns what is staged, or
  what is stored where no write is staged or the check dropped the write.
  Where the writer is in an instance of the same space that is not loaded,
  the read does not settle on the stored value: the attempt is withdrawn
  whole, the instance is loaded, and the event is dispatched again under
  the same handling, so that it names the same things
  (`scheduler-and-serving-loop.md` §5.3). The same happens where the
  address lies inside the envelope of an invalid materializer, which runs
  before the event is dispatched again. Where the writer is in an instance
  that is marked as torn down, or in another space, the read returns what
  is stored.
- A **request** (`Body.calls`) is recorded and returns at once: a link to an
  instance, a handle to a cell, a link to an effect's result, or a stream.
  The identifier in what is returned is computed from the request and the
  handling (section 5.4), so the body can store it, pass it on, or read
  `spaceOf` from it in the same invocation. A read through the link of an
  instance requested in the same invocation finds no value, because the
  instance's documents are staged when the body returns.
- An **event sent to a stream** is staged. It is delivered after the commit,
  as a cause of its own.

When the body returns, the requests are performed. A requested cell is
staged with its initial value. A requested child instance gets its argument
document, and its result document when its link was written into state or
passed to `navigateTo`. An effect request stages the stored request, its
hash and the pending mark in the operation's state document (section 6.4). A
binding made in the body stages its state document (section 4.7).

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

The second step of a derivation transaction is the same for the three kinds
of cause that have one. Its input is a set of dirty slots, a set of
label-dirty slots, and a set of demanded outputs.

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
  transaction from the memo, without an evaluation (section 3.3).
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
- **What is instantiated early.** In an event's transaction, a derived
  write whose target the handler body reads by address is instantiated,
  and its constraints are checked, before that read returns
  (`plan-and-label-templates.md` §4.6). A handler body is not run again
  when a constraint drops a write, so it must not read a value that a
  later check drops. The body reads by address in two ways.
  - *Through a slot of `Body.reads`.* The writes concerned are the derived
    writes this transaction staged at an address such a slot is bound to:
    a side-write to a state cell or to a cell reached through a handle,
    and a kept output that the slot's path reaches through a link. They
    are instantiated and checked after the cone instances of section 1.3
    were evaluated and before the handler's argument is built.
  - *Through a journaled read:* a read through a handle of `Body.handles`,
    or through a link the body follows. A derived write this transaction
    staged at the address read, by a cone instance evaluated before the
    body or by one the read made current (section 1.4), is instantiated
    and checked before the read returns.

  Such a write is instantiated after the staged writes it uses
  (`plan-and-label-templates.md` §4.5), which are instantiated and checked
  first. A write the check drops is unstaged at once: the body reads what
  is stored, and the slot or the journaled read resolves to the stored
  label. A cone instance that had read the dropped value through a slot is
  stale again, and where the read depends on it, it is evaluated again
  before the read returns, against what is stored (section 1.7).

  The early step is a step of the preparation, made ahead of the rest: the
  same instantiation of the same template, from the labels stored or
  staged when the read is made. The preparation keeps the instantiation
  key and the verdict in the write's unit (section 1.9) and does not
  instantiate the write again. A label the body stages afterward does not
  enter it, because the value was computed from what was there before
  (section 11, request 50).

  Everything else is instantiated in the preparation: the handler's own
  write edges, the derived writes of the event's transaction that the body
  does not read by address, and every write of a derivation transaction. A
  value a handler receives for a state path that names an output of its
  instance is not read by address (section 1.3): the handler's template
  holds the output's template, and the handler receives the computed value
  whether or not the output's write is stored. A body that runs inside a
  cone needs no early step, because a cone instance that read a dropped
  value is evaluated again (section 1.7).
- **What is instantiated.** The templates of what the transaction stores or
  checks, as `plan-and-label-templates.md` §4.1 lists them: a kept output;
  a write edge, which is a side-write, a write through a handle, a path of
  a child's argument, the initial value of a created cell, or a path of an
  effect's stored request; the request of an effect a handler makes, on
  which the egress ceiling is checked; a copied state path of a binding; a
  copied parameter of a pattern closure; and an output a cache stores
  (section 8). An interim value is not instantiated.
- **When there is something to do.** One of the three conditions of that
  section holds: the cone or body that computes the value was evaluated in
  this transaction; something demands it and a slot its template reaches
  has a new label and an unchanged value; or it is unstored and something
  demands it.
- **Order, and labels staged in the transaction.** A write is instantiated
  before every template that has a slot bound to its target: the derived
  writes instantiated early first, each before the read that needs it,
  then a handler's write edges, then producers before consumers, in the
  order the cone instances were evaluated. A slot bound to an address this
  transaction, or an earlier transaction of the batch, wrote resolves to
  the label staged there and not to the stored one
  (`plan-and-label-templates.md` §4.5).
- **A kept output evaluated before a handler body** is a derived write of
  the event's transaction. Its value was staged when it was evaluated. If
  the body then wrote something its cone instance had read, the staged
  value is withdrawn before the preparation: its label would otherwise be
  instantiated from the label the body staged, for a value computed from
  what was there before. The cone instance is stale, the handler keeps the
  value it read, and the derivation transaction behind the batch evaluates
  and stores the output. A write that was instantiated early is not
  withdrawn this way. Its label was instantiated before the body wrote,
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
  inline patterns it instantiated. Nothing the event would have written is
  committed. The other events of the batch are not affected. The
  rejection is reported to whoever delivered the event. What it reveals is
  bounded as `plan-and-label-templates.md` §5.5 says.
- **A failed constraint on a derived write drops that write alone.** A
  derived write is a kept output, or a write edge of a cone. The dropped
  write is unstaged. Its target keeps the value, the label and the
  provenance record that are stored, and the rest of the transaction
  commits, other outputs of the same cone instance included. A cone
  instance that had read the staged value through a slot, in this instance
  or another, is stale again and is evaluated again in the same
  transaction, against what is stored. A write dropped once is not staged
  again in the same transaction. Section 3.3 says what the memo holds.
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
- **A handler body that throws aborts the event's transaction**, as it does
  today. Its staged writes and requests are discarded. A handler that
  receives an error state for one of its inputs, because a cone instance it
  reads failed, fails in the same way.
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
2.7, by ruling. *Assumed:* it holds as well for a body that exceeded its
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
- **The scope of a cone instance** at run time is the narrowest scope among
  the addresses its slots are bound to and its dynamic reads touched, in
  the order `space`, `user`, `session`. It is the plan's scope or a
  narrower one, because a slot can be bound through a link to a document of
  narrower scope. This is the rule built-ins apply to their stores today
  (`builtin-inventory.md`, "the narrowest scope the input read touched").
- **Evaluation is per scope key.** A cone instance of space scope is
  evaluated once for a cause. A cone instance of user or session scope is
  evaluated once per scope key that demands it, with the slots of that scope
  bound to that key's scope instances.
- **Storage is per scope instance.** A kept output of narrower scope is
  stored in the scope instance, for that key, of the document that holds
  its path (section 4.2).

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
2. **Where a written path's label comes from.** For a path the plan covers
   (a kept output, a write edge, a created cell, a child's argument, a
   stored request, a copied state path of a binding, an operation's state),
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
   slots, the staged ones among them, and the labels of the `dynamic` nodes
   with their trigger reads; and which derived writes a failed constraint
   dropped, and which a conflict withdrew, so that the digest is over the
   writes that commit. A read, a write or a new decision input after the
   preparation invalidates it, as it does today. The withdrawal of a
   derived write at the commit is the one exception, and item 4 says why
   it needs no second verification.
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
     drops it. A cone instance that had read its value is evaluated again,
     and a derived write a handler body reads by address is checked before
     that read returns (section 1.6).

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
  a key function) is one or more cones whose slots include `element` roots.
  They are evaluated once per element key (section 2.5).

### 2.2 Invocation and inputs

The runtime invokes a cone's function with one argument, a host object, and
the function returns a result record. Both are plain data apart from the
host's three functions.

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
   * (section 2.4).
   */
  slot(slot: Index): unknown;
  /** The index of the element in its collection, when the body uses it. */
  readonly index?: number;
  /**
   * The value of an output another cone computes, by index into
   * `Plan.outputs`. Legal only for an output an incoming `ConeEdge` names.
   * The runtime evaluates the producing cone first when it is stale.
   */
  output(output: Index): unknown;
  /**
   * Runs a sandboxed body of `Cone.bodies`. `computed` is the body's
   * argument with the values this evaluation computed at their places and
   * nothing at the places of slots. The runtime copies from it the paths
   * the entries of `Body.computed` name, each narrowed to its class, and
   * builds the slot part of the argument itself.
   */
  invoke(body: Index, computed: unknown): unknown;
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
  A storage link to a part document is passed through and is not on the
  chain (section 4.10). An `identity` slot stops at its last segment, and
  with `resolved` it yields the reference where resolution ends. Emitted
  code does not follow a link.
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

Where two entries name one path, the argument holds the form that carries
more: `value` before `enumeration`, `enumeration` before `shape`, and a
reference stand-in where the only entries are `identity` and `shape`, since
a stand-in that is present carries the presence. A position typed `unknown`
holds a reference stand-in whatever is stored behind it, so a test of
presence or kind sees presence and no more. These are the stand-ins
`footprint-analysis.md` asks for (its requests 8 and 17).

**A value passed on unchanged is stored as a reference.** When a body
returns or writes a container that carries the address it was read from, or
a reference stand-in, the runtime stores a link to that address and not a
copy (`footprint-analysis.md` §3.8). *Assumed*, pending question 10 of the
continuation plan: the rule stands, as today.

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
  returns, a stale cone instance that writes the address is evaluated, as
  section 1.4 says for a handler. For a body that runs inside a cone, a
  read that lands inside the envelope of an invalid materializer is not
  waited for: the body reads what is stored, and the materializer's later
  write makes the cone instance stale
  (`scheduler-and-serving-loop.md` §7.3).
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

### 2.5 Element cones

`plan-and-label-templates.md` §1.3 and `builtin-inventory.md` ("Element
keys") define the key of an element. This section says what the runtime does
with it.

For a collection the runtime keeps, per scope key, an **element table**. It
holds two things.

- **Per key:** the cone instances of the body for that key. Positions that
  hold one key share the value, the selections, and the reads made through
  handles and links.
- **Per position:** the key the position holds, the binding of each element
  slot at that position, which is the address the element was read from
  and, for a linked element, the chain to its cell, and the label
  identifiers resolved at those addresses. Labels are per position
  (`plan-and-label-templates.md` §1.3): two positions that hold equal plain
  values at two addresses can carry different labels, and the instantiation
  key of a position is formed from the labels at that position's addresses.

**What is stored once per key.** A kept output of an element cone is
stored per position, under the label of that position. Everything else an
element cone stores is stored once per key, and the positions that hold
the key share it: the state of an operation declared in the body (section
6), the stored request and the result of an effect (section 6.4), a path
of the argument of a child or of an instance the cone makes (sections 4.6
and 2.8), a side-write, a copied path of a binding or of an inline
pattern's parameters (sections 4.7 and 4.6), and an entry of the cache
document (section 8.4). The element slots of those positions can resolve
to different labels. *Assumed*, as open question 27 of
`plan-and-label-templates.md` states it for the first three: what is
stored once per key carries the join over the positions that hold the key
(§2.6 there), formed from the label identifiers the table holds per
position. This document applies the same assumption to the others
(section 11, request 51). An output at one position that reads such a
result through a slot then carries the labels of the other positions that
hold an equal element, which is looser than today, so the question is the
project owner's.

The runtime evaluates a `map` over the collection as follows.

1. Read the collection's `enumeration` slot and each position's reference
   or plain value. This is the runtime's own observation
   (`plan-and-label-templates.md` §1.3) and is the only read of the
   collection the `map` itself makes.
2. Compute the key of every position. A position that holds a link is keyed
   by the identity of the cell it links to. A position that holds a plain
   value is keyed by the salted hash of the value (section 5.3). The index
   joins the key when `Collection.bodyUses` says the body uses it. Record
   each position's binding.
3. For each key not in the table, create its cone instances and evaluate
   them with the `element` slots bound to that element. Equal keys share
   one evaluation.
4. For each key in the table whose cone instances are stale, evaluate them.
5. For each key in the table that no position holds any more, drop its cone
   instances and its memo entries, and tear down the instances their
   evaluations made (section 2.8). State cells and operation state declared
   under the key are not deleted by this step (section 9.6).
6. Assemble the result: position `i` receives the outputs of the cone
   instances of the key at position `i`. A hole stays a hole.

The assembled collection is an output like any other. A cone that uses it
pulls it with `host.output`, and it is stored when it is kept.

The element table is built by evaluation and not when an instance is
loaded: a plain value's key is a hash of the value, and a collection
derived by `map` or `flatMap` has positions only once it was evaluated. The
scheduler registers its per-position entries for element slots from the
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
keyed by the outer element's key and then the inner one's, outermost first.

### 2.6 What a change re-evaluates

| Change | Made stale | Evaluated when demanded | Written |
| --- | --- | --- | --- |
| A slot of one element changes (a field of a message is edited) | The cone instances of that element's key whose last evaluation read the slot, or read the address through a handle or a link | Those cone instances, once | The changed kept paths of the positions that hold the key |
| A captured outer value changes | Every element's cone instances that read it | All of them | The changed kept paths |
| An element is appended or inserted | The collection's membership; no existing element's cone | The new key's cone instances | The new positions; for an insertion, the positions after it move in the stored array (section 4.2) |
| An element is removed | The collection's membership | Nothing | The stored array loses the position, and a part document of the row is deleted (section 4.10) |
| Elements are reordered | The collection's membership | Nothing, unless the body uses the index | The stored array is rewritten in the new order: the storage links of rows that are parts, and the values of rows stored in place. Label entries only where the label at a position changed |
| The body uses the index and an element moves | The moved elements' cone instances | The moved elements | Their kept paths |
| The value behind a linked element changes | That element's cone instances; the key is unchanged | That element | Its changed kept paths |
| A plain value is edited in place | Membership: the old key leaves and a new key enters | The new key | The position |

A cone downstream of a collection, such as a `count` or a `filter` over the
result of a `map`, is made stale through its own slots and upstream outputs
in the same way. A fold updates the contribution of the keys that changed
and does not visit the others (section 6.1).

The cutoff applies at every step: a cone instance whose evaluation produces
the outputs it produced before does not make its consumers stale.

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
- **Iteration.** The evaluation step repeats over the stale cone instances
  that are needed for a demanded output until none is left.
- **The bound.** A cone instance is evaluated at most ten times in one
  transaction. The number is ruled as a placeholder and is fixed with the
  plan version (`Plan.version`), because the server and a client have to
  arrive at the same error states from the same plan
  (`scheduler-and-serving-loop.md` §8.1). It is `MAX_ITERS` of
  [Scheduler v2](../scheduler-v2/README.md) (§7.7), the bound on the
  iterations of one pass today. Cone evaluation keeps the count, per cone
  instance and transaction. The right value needs measurement on the corpus
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
  (section 3.3). This differs from today, where the remaining work is
  deferred behind a backoff gate and tried again, so that a graph needing
  more than ten iterations still converges. How many patterns of the corpus
  need more than ten iterations today is part of the measurement above.

A cell that a handler factory value may write counts as written by an
unknown handler (`plan-and-label-templates.md` §3.21). It can make any cone
that reads it stale, and the bound above is what limits the effect.

### 2.8 Instances a cone's evaluation makes

A `lift` or a `computed` may instantiate a pattern, by ruling: an inline
`pattern(...)` used as the callee, a named pattern, or a pattern factory
value. The pattern may request effects. A `lift` or a `computed` still does
not request an effect directly (*assumed*, question 38 of the continuation
plan). The instance belongs to the computation that makes it: to the cone
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

- **Identity.** An instance is identified by the enclosing instance, the
  body's `name` and `within`, the site, and the ordinal of the
  instantiation among those this evaluation makes at that site, or, with
  `.for(cause)`, by that cause in place of the ordinal
  (`plan-and-label-templates.md` §1.3). This is *assumed*, as question 38
  of the continuation plan states it. Section 5.5 gives the preimage. A
  site inside a loop makes one instance per iteration, numbered from zero.
  The ordinal is per site, so adding a site renames nothing. When the
  items a loop instantiates for change order, an instance and the state it
  holds go to the item that takes its position. A cause taken from the
  item keeps the instance with the item.
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
- **The record of what was made.** The enclosing instance has one
  **instances document** per scope key. For each computation that makes
  instances, and each of its cone instances, it lists per site the result
  cells the last committed evaluation made, each with the identity of its
  compiled pattern. It is written in the transaction of an evaluation that
  makes a different set, and not otherwise. It exists so that an instance
  an evaluation stops making can be found after a restart, when the memo is
  empty. Its label is the confidentiality of the making body's template,
  instantiated, with no integrity (`plan-and-label-templates.md` §2.6),
  and it is a store the runtime owns. Where the making cone is an element
  cone, the document holds one record per element key, under the key, and
  a key derived from a value is the salted one (section 5.3). The record
  of one key carries the join of section 2.5 ("What is stored once per
  key"). The set of keys says which elements the collection has.
  *Assumed:* it carries the collection's instantiated membership label, as
  §2.6 there rules for an operation's state document that holds several
  keys (section 11, request 49).
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
  each marked instance, its parts, its state
  cells and its operation state among them, are retired and are deleted
  under the rule of section 9.6: after the retention period, when nothing
  read them. An evaluation that fails makes no instance and tears none
  down: the instances of the last committed evaluation stay, and their
  argument paths take the error state (`plan-and-label-templates.md`
  §3.14; section 1.7). The instances of a cone instance that is dropped,
  because its element key left its collection or the enclosing instance
  was torn down, are torn down with it.
- **Made again.** An evaluation that makes an instance under the identity
  of one that was torn down clears the mark and sets the instance up
  again. *Assumed:* it finds the state cells and operation state stored
  under that identity, where they were not deleted yet, as an element
  whose key returns to its collection does (section 11, question 33). An
  author who needs a new instance writes a `.for(cause)` whose cause
  differs.
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
of the scope key the making cone instance is evaluated for. A cone
instance of space scope is evaluated for no principal, so an `inSpace`
request it makes is refused when it is made, and the cone instance fails.
Both are `scheduler-and-serving-loop.md`'s (§9.3 and §10.3). The second
is an assumption there, and its open question 34.

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
   * label is per position.
   */
  readonly label?: Hash;
  /** The read was made with `sample()` and does not make the entry stale. */
  readonly sampled?: true;
}

/** The labels of the element slots at one position that holds the key. */
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
  /** The label identifiers of the slots the constraint lists. */
  readonly labels: readonly Hash[];
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
  /** The slots the evaluation read, by slot index. */
  readonly slots: Readonly<Record<Index, ReadFingerprint>>;
  /** For an element cone: one record per position that holds the key. */
  readonly positions?: readonly PositionLabels[];
  /**
   * Reads through handles and links, by index into `Plan.dynamicReads`, in
   * the order they were made.
   */
  readonly dynamic: Readonly<Record<Index, readonly ReadFingerprint[]>>;
  /** The upstream outputs the evaluation pulled, by output index. */
  readonly upstream: Readonly<Record<Index, string>>;
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
are held per position, so that each position's instantiation key is formed
from the labels at its own addresses.

The trigger reads of a `dynamic` node are not in the entry. They are part of
the scheduler's instance record, which is not dropped under memory pressure
(`scheduler-and-serving-loop.md` §3.4).

Two further memos exist beside it.

- **The label memo** of `plan-and-label-templates.md` §4.3, keyed by
  template hash, selections and slot label identifiers. It is shared across
  instances and patterns.
- **A body memo**, optional. A body with no handles, no writes and no calls
  is a function of its argument, so its result may be memoized by
  `Body.code` and a hash of the argument, across cone instances and across
  instances. This is what makes equal plain values in two collections cost
  one call.

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
of the chain rebinds the slot and changes the fingerprint.

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
  date.
- **A transaction that does not commit.** When an event's transaction is
  rejected by a constraint on the handler's own writes, or aborted because
  the body threw, nothing it staged is stored. An entry of a cone instance
  that staged no side-write keeps its values, because they are pure
  derivations of state the transaction did not change
  (`plan-and-label-templates.md` §5.4). Its kept outputs are recorded as
  unstored. An entry whose cone instance staged side-writes or made
  instances is dropped: the writes did not happen, and a later evaluation
  has to perform them.
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
  carries a refusal is not attempted again until one of the slots the
  constraint lists changes its value or its label, since the verdict would
  be the same. A change of value makes the cone instance stale, and it is
  evaluated. A change of label alone instantiates the write again from the
  entry's value.
- **What the scheduler is told.** For every write that did not reach
  storage, the scheduler does not advance the basis rows of the cone
  instance, so that after a restart, when the entry is gone, the cone
  instance is found stale and evaluated again
  (`scheduler-and-serving-loop.md` §10.4). It records a refusal with the
  instance (`plan-and-label-templates.md` §4.4). In the terms of that
  document such a cone "stays stale". In this process the entry is current
  and unstored, which gives the same stored result without an evaluation.
- **A failed cone instance.** Its entry holds the error state and the reads
  made up to the failure. It is current until one of those reads changes.
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
| Argument document | The instance's argument, as the creator wrote it | Derived from the result cell, linked from it | As today |
| Parameters document | The private parameters of an instance whose callee is an inline pattern written at an instantiation in a function body (section 4.6) | Derived from the result cell, linked from it | As the argument document |
| State cell document | The value of one state cell | Section 5.2 | By the cell's declared scope |
| Operation state document | The durable state of one aggregate, `reduce`, index, effect, forced cache or materializer. For an effect it includes the stored request | Section 6 | By the scope of the operation's cone instance |
| Cache document | The entries of cones the runtime promoted | Section 8.4 | One per scope the promoted cones have |
| Binding state document | The state of a binding made in a function body: the copied paths, and a link for each cell and each container bound by reference | Section 5.5 | The body's |
| Instances document | Which instances the evaluations of the instance's computations made | Section 2.8 | One per scope the making cone instances have |
| Stream document | The entries of the events appended to one stream, and the stream's `eventWatermark`. It exists once the stream received an event (section 4.7) | The stream's identifier (sections 5.2 and 5.5) | As today |

A cell or a child instance that a handler of the instance created is not
one of the instance's documents. It is reached through whatever link the
handler stored. An instance a computation made is listed in the instances
document and has documents of its own.

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
| A reference passed through: a state cell, a part of the argument, a cell an element links to, a child's result, a stream | A link to that address |
| An output of narrower scope than this scope instance | A link to the same document and path with the narrower declared scope |

A reader of a computed kept output names the result cell and the output's
path, whichever document stores the path
(`plan-and-label-templates.md` §2.3). There is no document per kept output:
a part document holds a subtree, with every kept path inside it, and a
subtree below the size the rule sets has none.

The fourth row is how a space-scoped document contains per-user and
per-session values. A link carries a declared scope and no user or session
identifier, and the reader's runtime resolves it to its own scope instance
([scoped cell instances](../scoped-cell-instances.md)). The scope instance
of a document for a user or a session holds only the paths of that scope.

A kept collection is stored as an array at its path. Positions are array
indexes, so an insertion or a reorder changes which index a row is stored
at even though no row is evaluated. The write is a `splice` of the stored
array (`PatchOp` in `runtime/memory/v2.ts`), not a rewrite of the document.
What moves is a storage link where the row is a part, and the row's value
where it is stored in place.

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
  differ, each position that differs has its own entry at its index path.
  Those entries are positional and are rewritten when the positions move.
  A row that is a part document also carries the entries of its paths in
  its own envelope, where they do not move with the position (section
  4.10).
- **A path whose label is empty has no entry.** A kept path whose template
  is `const`, such as the static structure of a rendered tree, contributes
  nothing to the envelope.
- **Each scope instance has its own envelope**, holding the entries of the
  paths that scope instance stores.
- **Declared entries are unchanged.** They come from the result schema, and
  are stored with the document that stores the path.

State cell documents, operation state documents and binding state documents
carry their labels in their own envelopes, as documents do today.

### 4.4 A link to another instance's output

A link to an output of another instance is a link to that instance's result
cell at the output's path: space, document identifier, path, and a declared
scope where the output has one. This is the link a consumer holds today.
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

- **Its documents** are the kinds of section 4.1, under its own result
  cell. The parent and the child share nothing but the child's argument
  document, which the parent writes, and the child's result, which the
  parent reads.
- **The argument is part of the parent's keep set.** Each argument path is
  written with the template the parent's plan gives it. A computed value
  passed to a child is therefore stored, in the child's argument document,
  even when the parent would not otherwise keep it.
- **A child in the reactive tier** has a result cell named from the
  enclosing instance and the call site (section 5.2). When the factory at
  the slot changes, the runtime tears the old child down and sets up the
  new one on the same result cell. The new child's kept outputs replace the
  old ones at their paths. The old child's state cells are found again
  where the new plan declares a cell under the same name, and are otherwise
  left unreferenced.
- **A child a handler requested** has a result cell named from the handling
  and the request's ordinal (section 5.4). Its argument document is staged
  when the handler's body returns. Its result document is staged when the
  link was stored or passed to `navigateTo`. A request whose link the
  handler dropped writes nothing. Its cones are evaluated in a derivation
  transaction, when something demanded reads its result (section 1.4).
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
  the original element. The stream has an identifier (section 5.2), and
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
  it by identity, as it verifies a reference a body writes. A copied path
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
path the handler does not observe is not stored. Every copied path carries
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
received an event has a document. Today a stream document also exists from
setup and holds a back-link to its owner, and a bound handler has an
argument document
([row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md),
"Its handlers"). In the compiled layout a stream document holds the
entries of the events appended to the stream and the stream's
`eventWatermark`, and nothing else. It is created by the first event
appended to the stream, and no transaction writes one when a binding comes
to exist. A stream identifier is a hash and cannot be inverted, and the
document it names does not exist before the first append, so an event is
not routed by a document. It is routed by a row of the stream index that
`scheduler-and-serving-loop.md` §5.1 proposes: one row per stream of a
compiled instance, in the space's store beside the basis index, from the
stream's identifier to the instance and the binding. A binding therefore
costs one row of that index, written in the store transaction of the wave
whose transaction first computed the stream's identifier, and no document
until its stream receives an event.

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
  callback's pattern into it. The container is a further document.
- **A document per record written into an array through a cell.** A plain
  object that `set()`, `push()` or `addUnique()` puts into an array becomes
  a document of its own, and the array holds a link to it
  (`anchorValueAsEntity` in `runtime/runner/src/data-updating.ts`).
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

**The rule about size.** The size of a split point is the length in bytes
of the stored encoding of its subtree, with each part below it counted as
its storage link, plus the stored label entries and provenance records of
the paths in it. The three numbers below are placeholders. Stage 4 of the
overview's staging has to measure them (section 11, question 32).

1. A split point whose size is at least `PART_SPLIT_BYTES`, 1,024, is
   stored in a part document.
2. A part whose size is at most `PART_MERGE_BYTES`, 512, is stored in place
   again. Between the two numbers a split point stays as it is, so that a
   subtree near one number does not alternate.
3. When the content of a document, the result document or a part, exceeds
   `DOCUMENT_MAX_BYTES`, 65,536, every split point directly below it that
   is stored in place becomes a part, whatever its size. Such a part is
   stored in place again only when rule 2 holds for it and the document it
   returns to would then hold at most half of `DOCUMENT_MAX_BYTES`. A
   document can still exceed the number where its content has no split
   point, such as one long string.

The rule is applied when a transaction seals, to the split points on the
paths the transaction wrote, from the innermost outward. A subtree no write
touched keeps its arrangement. Sizes are computed from the documents being
written and are not stored.

- **A row.** Rule 1 applies to each row by itself. A list of many small
  rows stays in the document that stores the array until that document
  exceeds `DOCUMENT_MAX_BYTES`, and then rule 3 makes each of those rows a
  part.
- **The rendered tree.** Every node is a split point, so a large subtree of
  a tree is split where it is large: a row's node, a panel inside it, a
  long list inside that. Static structure whose labels are empty is stored
  like any other: in place when small, and once, in a part, when large.
- **Another kept output.** A record or an array that one opaque call
  returns is one split point at the output's root. Nothing inside it is a
  split point unless it is itself the root of an `Output` or a row of a
  kept collection.

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
(`plan-and-label-templates.md` §2.3).

**How a part document is identified.** By the instance and the kept path of
its split point, with every position of a kept collection on the path
replaced by the key of the element at that position, hashed under the
secret of the space. This is the naming rule of
`plan-and-label-templates.md` §1.3, with a path where a declaration has a
name and with every key hashed.

```text
createRef({}, {
  parent: <result cell entity id>,
  type:   "part",
  within: [ <step>, … ],      outermost first
  cause:  <path>,
})

step = { element: <collection name>, key: <hashed key>, nth: <ordinal> }
```

- `within` has one step per kept collection whose position the path passes
  through. `key` is the hash of the secret of the space and the element
  key of section 5.3, for every key: a cell's identity is hashed under the
  secret as a plain value is, and so is the pair with the index
  (`plan-and-label-templates.md` §2.3). A storage link is part of what is
  stored, and a reader of the document that holds it can see the
  identifier it names: for a row, a reader of the collection's membership.
  An identifier derived from a cell's identity alone could be compared
  with one derived from a guessed cell. Hashed under the secret, the
  identifier tells such a reader which positions hold the same row before
  and after a change of membership, which the membership label covers,
  and nothing of the cell or the value the row was computed from. `nth` is
  present where several positions of the collection hold the same key,
  and is the ordinal of the position among them. Two rows that show equal
  plain values share a cone and not a part document, because their labels
  are per position.
- `cause` is the path from the innermost row on it, or from the result
  root where there is none, down to the split point. Its segments are
  property names and the indexes of arrays that are not kept collections,
  such as the children written in one JSX element.
- The identifier does not hold a position, so a reorder, an insertion or a
  removal elsewhere in a collection renames no part. A reorder moves
  storage links in the stored array. It rewrites a part document only
  where the move changes a label that the row's slots resolve to (below).
- No client derives the identifier, since a client cannot read the secret
  (section 5.3). A reader names the result cell and a path.
- A part document is derived state and takes the `computed:` scheme, like
  an operation's state document (section 6). It has a scope instance per
  scope key that a path inside it was evaluated for, as the result document
  has.

**What a part document holds.** At its root: `value`, the subtree; a
`result` meta link back to the result cell, as a state cell document has;
the `within` steps and the path it was named from; and its `cfc` envelope.
A path inside it that is itself a part holds a storage link to that part.
Nothing but the storage link in its parent names a part document.

**What a reader of one part loads, subscribes to, and demands.**

- **Addressing.** A reader names the result cell and a path. The runtime
  resolves the path from the result document and, at each storage link on
  the way, continues in the part document it names.
- **Loading.** The reader loads the documents the path passes through and,
  for a read of a subtree, the part documents below the path that its
  schema reaches. It loads no other part. A session that lists rooms by
  name loads each room's result document and no row.
- **Subscribing.** The reader subscribes to the same documents. A change
  inside one row is a write to that row's part document and reaches the
  readers of that row. A change of membership is a write to the document
  that stores the array and reaches its readers, who find the moved storage
  links. A runtime that has resolved a path may hold the part document's
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
transaction: the result document, each part document a changed path is
stored in, and the document that holds a storage link that was added,
removed or moved. No reader sees a value in one document beside a value
or a label from another state in a second one. A part document of which no
path changed is not written.

**Crossing a number.** A split point that reaches `PART_SPLIT_BYTES`, or
falls to `PART_MERGE_BYTES`, changes its arrangement in the transaction
whose write changed its size.

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
  removes the position from the array and deletes the row's part document,
  with the part documents below it.

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
  stored in place. It is stored only while every position instantiates to
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
- where two declarations of one pattern body have the same name by these
  rules, each takes the name and its ordinal among them, in source order.

A name is unique within one pattern body and is not a position among
unrelated declarations. The steps of `within` tell two bodies apart.

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

The record has a `type` and a `within` member no preimage of today has, so
it cannot equal one. These identifiers are new. Section 9 says what happens
to state stored under today's identifiers for the same declarations.

A child instance of the reactive tier keeps today's two steps where it is
declared directly in the pattern body: its output spot is the internal cell
of the call's name, and its result cell is `{ resultFor: <spot> }`. Declared
anywhere else, its result cell has the second form with type `child`.

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

A part document is named by the same record with type `part`, a path in
place of the name, and every element key hashed under the secret of the
space (section 4.10).

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

The identifier of a part document is the one identifier in which every
key is hashed under the secret, a cell's identity included (section
4.10): it is stored in a storage link, which carries no label, where a
reader of the collection's membership can see it. In every other
identifier a key that is a cell's identity enters as it is.

Two consequences.

- **The memo needs no salt.** A key that only indexes the element table in
  memory never enters an identifier. The runtime may use the unsalted hash
  there.
- **A client cannot read the secret**, by ruling. A reader who could would
  be able to confirm a guess at a confidential value from an identifier,
  which is what the salt prevents. A client therefore cannot name
  per-element state over plain values or a binding with copied paths
  before the server stores a link to it, and it learns such an identifier
  from the stored link. It cannot derive the identifier of a part document
  at or below a row of a kept collection, and does not need to: it names
  the result cell and a path, and reaches the part through the storage
  link (section 4.10). A speculative handler that makes a binding with
  copied paths cannot name the stream the server will name. What a client
  shows for such state before the server's result arrives belongs to
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

- **The handling** is identified by the receipt, by ruling: the durable
  event identifier and the stream it was sent to (`handlingReceiptId` in
  `runtime/runner/src/scheduler/event-identity.ts`). A retry of the same
  event on the same stream is the same handling. The event key of today
  also names the acting principal (`deriveEventKey` in the same file). The
  receipt leaves the principal out, so that one event on one stream is one
  handling whoever sends it. The identifier is the same in a client's
  speculative run and in the served run.
- **The ordinal** counts the body's requests of every kind in the order
  they were made: cells, instances, effects. A retry with the same control
  flow names the same things.
- **An event the handler sends** to a stream is identified by the handling
  and the event's order among the events that invocation sends
  (`plan-and-label-templates.md` §1.3). The speculative run and the served
  run of one handling therefore name the same event.
- **A request with `.for(tag)`** is identified by the handler's instance
  and the tag, without the handling, so that different events name the
  same thing (`plan-and-label-templates.md` §1.3). Today every identifier
  minted in a handler's frame derives from a cause that holds the event
  identifier, so this is new behavior and not a carried-over one. It is
  *assumed*, pending question 19 of the continuation plan.
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
                       { parent: <result cell entity id>,
                         within: [ <step>, … ] })

an instance: createRef({ instance: <ordinal> } | { cause: <cause value> },
                       { parent: <result cell entity id>, site: <body name>,
                         child: <child name>, within: [ <step>, … ] })
```

- `<body name>` is the name of the `lift` or `computed` in the plan, by
  the naming rule of section 5.2. It is not the body's code, so that
  editing the body does not rename what it addresses. Two bodies of one
  instance that pass equal causes address two cells, as today.
- `<handler>` is `Body.code` of a handler of the plan, or the content
  address of a handler factory value.
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
  `<cause value>` the cause of a `.for(cause)`, which takes the place of
  the ordinal. This is the rule of `plan-and-label-templates.md` §1.3,
  which is the assumption of question 38 of the continuation plan (section
  2.8). The record has members no preimage of today has, so the identifier
  is new: today such an instance is a node of a pattern synthesized from
  the computation's frame (section 2.8).

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
   depends on what the body read (`plan-and-label-templates.md` §3.14).
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
the same documents.

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
aggregates, `reduce`, the collection index, and every effectful built-in.
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
cannot and takes `of:`.

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
key that left its collection is retired by itself (section 9.6). No
document holds the state of several keys of the enclosing collection, so
there is no key set that would need the collection's membership label.
The cost is that the number of documents grows with the number of
elements.

The state of one key is stored once for the positions that hold the key.
Where those positions resolve to different labels, it carries the join
over them, as open question 27 of that document assumes (section 2.5,
"What is stored once per key").

The keys an aggregate or an index holds contributions for are those of
the collection the operation folds, and they are paths of the operation's
own state document (sections 6.1 and 6.3). They are bookkeeping, and
their label is the confidentiality of `Operation.input`, which joins the
membership of that collection (section 6.5).

### 6.1 Aggregates

- **State.** Per element key: the contribution (a count, a truthiness, a
  number, a key function's result) and the number of positions that hold
  the key. The folded value, in the representation the operation needs to
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

### 6.3 Collection indexes

- **State.** Per element key: the index key the key function produced and
  the number of positions. Per index key: the bucket, as the element
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
- **The request, in the reactive tier.** A cone computes the request. Each
  path of it is a write edge of that cone with target `request`, staged
  into the operation's state document in the derivation transaction that
  evaluated the cone, with the template of the expression at that path
  (`plan-and-label-templates.md` §3.14). The request is a derived write
  and not a kept output: nothing reaches it from the result cell. A
  request path whose cone failed holds the error state, and such a request
  is not made: the operation's result is that error state.
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
  writes, so a failure rejects the event.
- **The completion transaction** is the operation's own as well. It writes
  the settled result or the error with the label the boundary declares,
  clears the pending mark, and commits by itself. That commit dirties the
  `operation` slots bound to the result, which is a cause of the third
  kind (section 1.1): a derivation transaction evaluates the demanded cone
  instances that read the result. They are two transactions because the
  result exists whether or not anything reads it. A cone that reads the
  result and fails, or whose write a constraint drops, therefore cannot
  lose the result.
- **Label.** For the result, the declared rule of the boundary
  (`builtin-inventory.md`), over the request's label, which is the join of
  the request's templates and of what its references lead to. For the
  hash, the claim and the pending mark, the confidentiality of
  `Operation.input`, instantiated, and no integrity (section 6.5).
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
gives them. Every other path carries the confidentiality of
`Operation.input`, instantiated, and no integrity: a contribution per
element key, an index key per element key, a count, and the request hash,
the claim and the pending mark of an effect. A path that holds label
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
address of each of the three for that comparison.

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
  scheduler's to order. A computed input joins the run's label with its
  instantiated template.
- **What it creates.** A cell the body creates under a cause computed from
  data has the identifier of section 5.5 and is reached through whatever
  link the body stored.
- **If lost.** The materializer runs again.

## 7. Provenance

A kept output records where its value and its label came from: the
template, the identities bound to the template's slots, and the identity of
the compiled pattern. An interim value has no stored provenance. Its
template is a sub-template of every kept output that depends on it.

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
  /** The key a `pick` over a container chose, by slot index. */
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
  the origins of section 7.3.
- A slot with root `event`, `cause` or `binding` belongs to a handler's
  write edge, not to a kept output.

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
one (section 5.3). An entry is stored once for the positions that hold
its key, so a cached output carries the join of section 2.5 ("What is
stored once per key") where those positions resolve to different labels.
The set of keys says which elements the collection has. *Assumed:* it
carries the collection's instantiated membership label, as §2.6 there
rules for an operation's state document that holds several keys (section
11, request 49). A forced cache in an element body is an operation and
has one state document per key (section 6).

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
| The result document's value: links to node documents | The kept outputs, in the layout of section 4, as the first compiled evaluation computes them: in the result document, and in part documents where section 4.10 splits them off |
| The label of a result path that held a link and comes to hold a value | The `value` entry is replaced by the instantiated template. The frozen `shape` entry is kept and joined with the confidentiality of the `followRef` entries the link had, so the stored label of the path is not looser after the migration than before it (`plan-and-label-templates.md` §2.6) |
| The argument document | Unchanged |
| A state cell declared directly in the pattern body | Unchanged: the derived identifier is the stored one (section 5.7) |
| A stream declared directly in the pattern body | Unchanged identifier. Its document stays the stream's document, where events are appended (section 4.7) |
| A state cell inside a compiled-in sub-pattern | Found through the carry-over record (section 9.3) |
| A state cell inside a `map` body | Not carried over. The compiled instance starts it empty under its new identifier |
| A node output document: a `computed`, a conditional's store, a `map` container, an element result, an aggregate node | No longer written. Retired (section 9.6) |
| The result and argument documents of a sub-pattern instance that is now compiled in | No longer written. Retired, with a forwarding link where section 9.5 says |
| A child instance a handler created | Unchanged, and migrated on its own when it is next loaded |
| The pattern a `lift` or a `computed` synthesized, and the instances in it | No longer written. Retired. The first compiled evaluation makes the instances under their new identifiers (section 5.7), so state inside them is not carried over |
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

- An instance migrated after the builder path is retired cannot have this
  record computed. Its sub-pattern state starts empty.
- The record also carries the scheme of each state cell declared directly
  in the body, taken from the stored manifest (section 5.2).

### 9.4 The procedure

For one instance, when a runtime that can execute compiled patterns loads
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
4. **Evaluate.** Run the first compiled evaluation inside the setup
   transaction, reading state through the record. Every cone instance is
   stale, because no basis row exists under the compiled pattern's
   identity. Every kept output of the space's scope instance is demanded
   for the length of the transaction, and so is every kept output of a
   narrower scope for the scope keys that demand the instance, so that the
   whole layout is written.
5. **Write, in one transaction:** the result document and its part
   documents, with values, envelopes and provenance in the compiled
   layout; the setup record naming the compiled pattern; the carry-over
   record; forwarding links (section 9.5); and the mark that makes the
   space refuse older builds (section 9.7).
6. **Load the compiled instance.** From this commit on, no node document
   of the instance is written.

The transaction is a setup transaction in the sense of the
[serving loop](../server-side-execution/serving-loop.md) (§3e): the
running graph is replaced only after the commit is accepted, and a
withdrawn commit leaves the builder-path instance running. It is not the
transaction of one of the four causes of section 1.1. Where a setup
transaction sits in the scheduler's cycle, and whether one serving runtime
runs compiled and builder-path instances in one space, belong to
`scheduler-and-serving-loop.md` and to question 24 of the continuation
plan.

Instances are migrated one at a time, when they are loaded. A space can
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

A part document is not a retired document. It is deleted in the
transaction that removes the storage link to it, because nothing else
names it (section 4.10).

*Assumed:* a retention period of thirty days. It needs the owner's
decision (open question 3).

The same rule applies after migration to documents that go out of use
without a migration: the state of an element whose key left its collection,
the state cells of a replaced child that the new child does not declare
(section 4.6), and the documents of an instance that a computation no
longer makes (section 2.8). Today such documents are released and never
deleted
(`builtin-inventory.md`, the entry for `map`).

### 9.7 What a reader on an older client sees

- **A client that only reads** the instance's result, and runs none of its
  code, reads the result through the result schema. Before the migration
  commit it follows links to node documents. After it, it finds values at
  the same paths, in the result document or in a part document behind a
  storage link. The migration is one transaction, so it sees one layout or
  the other and never a mixture. A runtime that does not know the stored
  form of a storage link cannot resolve a path that passes through one.
- **A client that runs the instance's pattern on the builder path** would
  set the instance up again from the stored source. A start holds the
  stored setup against the build it loads (`#storedSetupVerdict` in
  `runtime/runner/src/runner.ts`), and a setup record it cannot interpret
  reads as no record, on which the builder path can restage its own
  projection over the compiled result. Its speculative run would also read
  retired node documents that no longer change.

Both kinds of client have to be refused. The migration's commit marks
the space, and the memory server admits to a marked space only a runtime
that declares it executes the compiled layout, as it does today for
instance naming ([memory invariants](../memory-v2/09-invariants.md), INV-16).

*Assumed:* migration happens only in a space that runs under server
execution, so that the one runtime that commits derived values is a
compiled one, and a client's part is to read, to speculate, and to send
events.

### 9.8 Interaction with the pattern-update mechanism

A pattern update after migration is a source transition as today
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
- **Memo entries are dropped**, because they are keyed by the compiled
  pattern (section 3.2), and the basis rows under the earlier identity
  match nothing, so every cone instance starts stale
  (`scheduler-and-serving-loop.md` §10.4). Cache entries and operation
  state survive where the code they were computed by is unchanged
  (sections 6.6 and 8.4).
- **The compatibility comparison is unchanged.** It compares argument and
  result schemas and retained input links, none of which the layout
  affects.
- **Migration is itself a setup under a new setup record.** An instance
  that follows an origin is migrated when the origin's release is first
  compiled by the new compiler. A detached instance is migrated by
  rebuilding its retained source, which the lifecycle already has as a
  transition.

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

The event is the only one of its batch, so two transactions run: the
event's, and one derivation transaction behind the batch.

### 10.1 The transactions

**The event's transaction.**

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
- sends on the `joined` stream. The send is staged and becomes a cause of
  its own after the commit.

When the body returns, the reactions document is given its identifier from
the handling and ordinal 0, and its initial value. Staged by the event: a
new message document, a new reactions document, and one appended link in
the `messages` list. The append changes addresses that `B2` read through
its `messages` handle, so the cone of `facts` is stale. It is not evaluated
in this transaction.

*Preparation.* The write edges of `B0` are instantiated: `T_send` once, for
the message's computed fields and the reactions list. The `authorProfile`
link carries the label of the reference the handler was given. The
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
| The 30 existing rows | No | No | Their keys are their message cells' identities, their element slots did not change, and each reads only its own entry of the room's records, which is equal to the one before |
| The new row | New key | Yes, once: the row body's cones for the new message | Step 3 of section 2.5 |

By a syntactic count, the body of `FabriChatMessageRow` in `message-row.tsx`
has 14 `computed` calls, 7 actions and 12 applications of a handler to
state. `language-subset.md` §11.5 counts 106 of FabriChat's 111 `computed`
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
| The document that stores the main list under `[UI]`: the result document, or the part document of a node that encloses the list | One storage link appended |
| The new row's part document, the space's scope instance | Created, with the row's subtree |
| The new row's part document, the session's scope instance | The row's session-scoped paths |

A second session that has the room open receives both commits. Its own
session-scoped paths for the new row are written when its scope key is
evaluated, in this transaction if the scheduler includes it (section 1.8).

### 10.2 Against the counts today

| Per send into a thirty-message room | Today | Compiled |
| --- | --- | --- |
| Transactions | The handler's, and one per node run that follows | Two: the event's, and one derivation transaction. Several sends in one batch share the second |
| Scheduler runs | 68 in the browser measurement; 36 in the pattern-test rig after the room's derivations became one walk, of which 17 are the new row's computeds | Not a unit. Cone evaluations: `facts`, `isEmpty`, the room's per-session records, and the new row's cones |
| Sandboxed calls for the 30 existing rows | None for their computeds; the `map` coordinator ran twice and resolved all 31 links each time, 219 link hops | None, and no coordinator: step 1 of section 2.5 reads the list once |
| CFC preparations | One per commit that touched labeled documents | Two |
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
about size that this document owns (4.10). The last one answers what was
question 1 of this list, the size of a result document.

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
   migrated space refuse builds that predate the compiled layout.
   *Assumed:* thirty days, and refusal from the first migrated instance in
   the space.
4. **Instances whose stored source the compiler refuses.** Such an
   instance cannot be migrated and runs on the builder path. *Assumed:*
   when the builder path is retired it stops running, its stored state and
   last result stay readable, and it runs again when its source is
   updated.

Added by the rulings on several documents, on batches and on instances a
computation makes:

32. **The numbers and the split points of section 4.10.** The ruling leaves
    the rule about size to this document. *Assumed:* a part document
    begins only at the root of a kept output, at a row of a kept
    collection, or at a node of the rendered tree; a split point becomes a
    part at 1,024 bytes and returns in place at 512; and a document over
    65,536 bytes makes parts of the split points directly below it. The
    three numbers are placeholders for stage 4 to measure. One choice in
    the rule is not about numbers: that the `props` of a node are stored
    with the node and are not a part of their own, although the renderer
    subscribes to them separately today.
33. **An instance made again under the identity of one that was torn down**
    (section 2.8). With an ordinal as the identity, a list that shrinks and
    grows makes instance number 2 again for another item. *Assumed:* the
    new instance finds the state cells and operation state stored under
    that identity where they were not deleted yet, as an element whose key
    returns does, and an author who needs otherwise writes `.for(cause)`.
    The alternative deletes a torn-down instance's documents in the
    transaction that tears it down, which needs them to be listed. A second
    consequence of the ruling is stated here so that it is accepted
    knowingly: a link to a torn-down instance that another document holds
    reads the values last stored, and nothing marks them as such for a
    reader that does not load the instance.
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

### 11.2 For another document or the prototype

To `scheduler-and-serving-loop.md`:

5. **Dirty slots since a commit.** Withdrawn. The scheduler marks the stale
   cone instances from the basis rows of its §10.4 (section 3.4 here).
6. **Routing an event to a binding.** Met by its §5.1. A stream document
   holds the entries and the `eventWatermark` and is created by the first
   append. An event is routed by a row of the stream index, one row per
   stream beside the basis index, from the stream's identifier to the
   instance and the binding, which also leads to an instance that is not
   loaded (section 4.7 here). That document proposes the index and lists
   it as its open question 26.
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
12. **Staged events and effect requests.** Met by its §5.1, §6.2 and §9.3.

<!-- The list restarts so that the numbers stay as cited. -->

35. **The evaluation count, and gates** (sections 1.5 and 2.7). Met by its
    §8.1 and §5.3: cone evaluation keeps the count of evaluations per cone
    instance and transaction, the instance record keeps no second count,
    and no gate holds a cone instance.
36. **Stale, and unstored** (sections 1.7 and 3.3). Met by its §3.5, §5.6
    and §10.4: after a rejection, an abort, a dropped write or a withdrawn
    write, the scheduler does not advance the basis rows of the cone
    instance, records the refusal of a dropped write, and has an unstored
    output stored when something demands it, without treating the cone
    instance as one that needs an evaluation.
37. **A read made current at the read** (sections 1.4 and 2.4). Met by its
    §5.3: a stale cone instance of a loaded instance of the same space
    that writes the address is evaluated before a journaled read returns.
    Where the writer is in an instance that is not loaded, the attempt is
    withdrawn whole, the instance is loaded, and the event is dispatched
    again under the same handling.
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
    nothing; the transaction that tears an instance down marks the
    instances that belong to it; and the step in another space of an
    `inSpace` instantiation by a computation acts as the principal of the
    scope key the making cone instance is evaluated for. That a cone
    instance of space scope cannot instantiate with `inSpace` is an
    assumption there (its open question 34).
40. **Demand over several documents** (section 4.10). Met by its §4.2:
    demand is per kept output path whichever document stores the path, and
    a watch on a part document by its own address is mapped to kept paths
    through the `result` link and the path at the part's root.

<!-- The list restarts so that the numbers stay as cited. -->

48. **A derived write that was instantiated early is not withdrawn**
    (section 1.6). Met by its §3.5 and §5.2: a kept output computed before
    a handler body is withdrawn before the preparation when the body wrote
    something its cone instance had read, unless the body read the write
    by address. Such a write was instantiated before the body wrote, the
    handler's own writes use it, and it commits with the event's
    transaction.

To `plan-and-label-templates.md`, with the specification change where a
label is concerned:

13. **The label of an operation's bookkeeping state.** Met by its §2.6: the
    confidentiality of `Operation.input`, instantiated, and no integrity
    (section 6.5 here).
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
    one state document per key (section 6 here). What is stored once per
    key where positions differ in label is its open question 27 (section
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
    agree. Its §2.3 also has the identifier of a part document derived
    under the secret of the space for every key, which section 4.10 here
    follows. Its open question 19 is answered here: section 4.10 has
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
    §4.5 ("Order" and "A write instantiated early"): a derived write that
    a handler body reads by address is instantiated before that read
    returns, after the staged writes it uses and ahead of the handler's
    write edges. The preparation does not instantiate it again, and a
    label the body stages afterward does not enter it.
51. **What is stored once per key** (section 2.5). Met by its §2.6 and
    its open question 27, which list everything an element cone stores
    once per key: the state of an operation, the stored request and the
    result of an effect, a path of the argument of a child or of an
    instance the cone makes, a side-write, a copied path of a binding or
    of an inline pattern's parameters, an entry of the cache document,
    and the record in the instances document. Each carries the join over
    the positions that hold the key. The join is an assumption there, for
    the project owner (its open question 27).

To `language-subset.md`:

26. **The spelling of the promotion directive** (section 8.5). Not met:
    that document has no form by which an author writes it (its open
    question 10), so a compiled plan leaves `Cone.cache` absent and the
    runtime decides.
27. **Stored source.** Section 9.4 compiles an instance's stored source.
    That document's open question 7 asks with which severities. *Assumed:*
    the interim acceptance of the removed forms applies, and any other
    refusal leaves the instance unmigrated.

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
30. **Mixed labels in a kept collection.** Section 4.3 stores one entry per
    position whose label differs. Whether a shared entry for the common
    part and per-position entries for the rest is smaller needs
    measurement.
31. **Matching calls at migration** (section 9.3). How many compiled-in
    calls in the corpus the matching places, and how much state is stored
    under the ones it cannot.

<!-- The list restarts so that the numbers stay as cited. -->

46. **A cone instance evaluated while a body is suspended at a read**
    (section 1.4). Whether the sandbox allows one body to run while another
    waits at a read, and how the budgets of the two are counted.
