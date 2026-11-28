# Compiled pattern language (proposed)

**Status:** proposed design direction. Nothing here is implemented. The
questions that cut across documents are listed under
[Open questions](#open-questions). The
[continuation plan](../../plans/compiled-pattern-language.md) lists every
question the project owner has still to rule on. The parts that change what
Contextual Flow Control (CFC) decides go through the specification first, as
[`../development/cfc-spec-correspondence.md`](../../development/cfc-spec-correspondence.md)
requires.

This document proposes a pattern language that is a defined subset of
TypeScript with its own compiler. The compiler emits JavaScript that computes
values and a data plan from which the runtime computes CFC labels, decides
what to store, and schedules work. The goal is that label bookkeeping and
storage stop scaling with the number of reactive nodes a pattern lowers to.

## The problem

A pattern lowers to a graph of nodes, and each node run is one storage
transaction ([Scheduler v2](../scheduler-v2/README.md), D6). CFC derives the label
of everything a transaction writes from everything the transaction read
([CFC commit preparation](../cfc-commit-preparation.md)), so the way to keep one
value's label off an unrelated value is to compute them in separate
transactions. Cost and label precision therefore come from the same mechanism,
and three costs follow from it.

- **Label work dominates commits.** One measured load of a chat room made
  1,157 scheduler runs, 190 commits, and 615 CFC preparations, and CFC
  preparation was 86% of commit finalization
  ([row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md)).
- **Interim state dominates storage.** Every node output is a document with
  its own label envelope, and a `map` instantiates a full sub-pattern per
  element. Label envelopes were measured at about 93% of live stored JSON
  ([content-addressed CFC labels](../content-addressed-cfc-labels.md)).
- **Labels are carried by TypeScript types the checker was not built for.**
  The label carrier is a phantom brand intersected with the payload type, which
  needs special handling wherever TypeScript simplifies the intersection, for
  example with `null`
  ([CFC authoring contract](../ts-transformer/cfc_authoring_contract.md)). Many
  programs that cannot satisfy their label constraints are refused only at run
  time.

Patterns themselves use a small part of TypeScript. The complex types are in
the API, not in pattern code, and the transformer already refuses many idioms
([target pattern language](../ts-transformer/ts_transformers_target_pattern_language_spec.md)).
That makes a defined subset practical, on the condition that every refusal
comes with a diagnostic that says what to write instead.

## The design in one paragraph

The compiler knows the data flow of a pattern body statically, so label
precision can come from the program's structure instead of from transaction
boundaries. For each output path the compiler emits a **label template**: the
set of inputs whose labels join to form that output's label. The runtime runs
one transaction per cause (an event, a set of changes, the completion of an
effect, or a change of demand), evaluates only the outputs something demands,
stores only the outputs something outside the pattern instance can reach, and
instantiates label templates only for what it stores or checks: those
outputs, the targets of side-writes, the arguments of child instances, effect
requests, and the values a handler binding or an inline pattern copies. What
an inline pattern copies is an assumption
([continuation plan](../../plans/compiled-pattern-language.md), question 48).

## The language

The language is valid TypeScript, so editors and existing tools keep working.
The pattern compiler has its own parser front end and its own type checker for
the subset. It has three tiers.

### Reactive expressions

The pattern body. It is first-order and has no loops, no reassignment, and no
function creation other than the callbacks of the collection constructs below,
the functions given to `computed`, `action`, and `assert`, inline event
handlers, and inline patterns. Conditional expressions (`?:`, `&&`, `||`),
property access, object and array construction, the array methods `map`,
`filter`, `flatMap`, `reduce`, `findIndex`, `some`, `every`, and `find`, the
aggregates, and the collection indexes are reactive constructs here, and the
compiler lowers each to an operation with a known label rule
([language subset](language-subset.md), §4.4).

A `computed` whose body is a pure expression over its captures is promoted to
this tier. It then costs no sandboxed call, and its result gets a label per
output path instead of one label for the whole result. A `computed` that
instantiates a pattern or binds a handler is not promoted, because promotion
would change which documents exist and how the state inside is named
([language subset](language-subset.md), §6.1). Both are assumptions
([continuation plan](../../plans/compiled-pattern-language.md), questions 49
and 60).

### Function bodies

The bodies of `lift`, `handler`, `computed`, `action`, and `assert`, inline
event handlers, and functions declared at module scope are JavaScript with a
stated set of restrictions ([language subset](language-subset.md), §5.1) and
run in the sandbox. The compiler parses them and type-checks them in the
subset, and performs **footprint analysis** on them: for each input path,
whether the body reads the value, the shape, the enumeration, only the
identity, or the label stored for the path, and which paths it writes. The
footprint narrows the schema each body is invoked with, which is what keeps a
body from being tainted by, or gaining access to, data it never touches.

Footprint analysis is allowed to give up. When it loses track of a value it
widens the footprint to the whole subtree that value came from, and no
further. When it cannot tell which child of a record a key names, it records
what the body reads of that one child for every child. A widening does not
pass through a cell handle: a handle the analysis loses track of is not read
in full, and the reads through it become dynamic
([footprint analysis](footprint-analysis.md), §5.1). The less often the
analysis gives up the more precise the labels are, so it is worth investing
in, and a diagnostic tells the author which expression caused a widening.

Inside a function body the reactive constructs do not exist. `?:` and
`Array.prototype.map` are ordinary JavaScript there. A collection method
called on a cell handle in a function body, such as `aCell.map(...)`, is a
compile error, and the compiler does not rewrite it to a reactive form. The
diagnostic names two corrections: wrap the expression in an inline
`pattern(...)` and instantiate it, which keeps it reactive, or read first,
`aCell.get().map(...)`, which processes the values the cell holds when the
body runs ([language subset](language-subset.md), §4.7).

### Imported TypeScript

A module outside the subset can be imported for functions whose types the
subset cannot express. A module is imported TypeScript when it begins with the
directive `"use typescript";` ([language subset](language-subset.md), §5.5).
The compiler reads only the annotated signature of each imported function,
does not analyze the body, and treats every argument as read in full.

### Statelessness

Functions in all three tiers are stateless: module scope holds no mutable
state, and module-scope data is frozen. A function that closes over nothing
mutable can be called repeatedly without a fresh sandbox per call, which is
the property the loader relies on today
([SES sandboxing](../sandboxing/SES_SANDBOXING_SPEC.md)). In this design the
property is a language rule. For a module in the subset the compiler checks
it, reports on it, and emits the freezing wrappers. The compiler does not
analyze the bodies of an imported TypeScript module, so for such a module the
load-time verifier and the freezing wrappers of the current system stay in
force ([language subset](language-subset.md), §3.4 and §5.5).

### Labels in the type system

The authored spelling of labels stays the alias set of the
[CFC authoring contract](../ts-transformer/cfc_authoring_contract.md), such as
`Confidential<T, L>`. The compiler reads these as label annotations in its own
type system instead of evaluating them as TypeScript intersection types. A
label on `string | null` is then a label on that union, with no dependence on
how TypeScript simplifies a brand intersected with `null`.

### An example

```ts
// Shown for illustration only.
export default pattern<{ donuts: Donut[]; taxRate: number }>(
  ({ donuts, taxRate }) => {
    const glazed = donuts.filter((d) => d.glaze !== "none");
    const prices = glazed.map((d) => ({
      name: d.name,
      price: d.basePrice * (1 + taxRate),
    }));
    const total = computed(() => prices.map((p) => p.price).sum());
    return { prices, total };
  },
);
```

The compiler emits value code for `glazed`, `prices`, and `total`, and a plan
that records, among other things:

- `prices[i].name` depends on element `i` of `donuts` at `name`, and on the
  membership of `glazed`;
- `prices[i].price` depends on element `i` at `basePrice`, on `taxRate`, and
  on the membership of `glazed`;
- membership of `glazed` depends on `glaze` of every element;
- `total` depends on `basePrice` and `glaze` of every element and on
  `taxRate`.

`prices` and `total` are returned, so they are kept outputs: paths of the
result. They are stored in the result document, or, for a subtree that is
large enough, in a part document the result links to
([The keep set](#the-keep-set)). `glazed` is interim and is not stored, no
element of either list is a pattern instance with documents of its own, and
`d.name` never taints `total`.

## What the compiler emits

The compiler emits two things for a pattern, content-addressed together.

- **Value code:** JavaScript functions, one per dependency cone (defined
  under [Execution](#execution)), plus the sandboxed function bodies. This code
  computes values and nothing else. Where a value holds the stream of a
  handler, as a rendered tree does at an event attribute, the function
  places a marker that the runtime gives it for that binding. The
  function cannot send to the marker or read through it. When the runtime
  stores the value it writes the link to the stream in the marker's
  place, for the element keys of the cone instance that asked for the
  marker. That is the one rule wherever a marker is stored, over an
  array of references, over an array of plain values in place, and
  over the result of another per-element construct alike. The plan
  does not say where a stream is stored, no position is checked, and
  a reader finds a stream in the stored result
  ([execution and storage](execution-and-storage.md), §2.2).
- **The plan:** data describing the pattern. It holds the input slots and
  their schemas, the label template of each output path, the footprint of each
  function body, the keep set, the causal identity of each state cell, the
  operations with durable state, and the edges between cones.

Labels are never computed by emitted code. The runtime's CFC kernel evaluates
label templates from the plan.

### Trust

The compiler is trusted. It is small and purpose-built, which is the
difference from trusting the TypeScript compiler. Two properties limit what a
compiler defect can do:

- Each sandboxed function body receives only its narrowed inputs, so the
  confidentiality of data outside a body's footprint does not depend on the
  compiler's dependency analysis of that body being exact.
- Precision finer than a function boundary, such as per-path labels on a
  promoted expression, does rest on compiler correctness.

Trust in the compiler is a property of the deployment and not a decision a
user makes per pattern or per build: the design does not work without it, and
there is no mode in which a runtime executes a compiled pattern while
distrusting the compiler that produced it. A runtime therefore either compiles
from source itself or accepts a compiled artifact from a party it already
trusts to execute the pattern. For a module in the language subset the
compiler's statelessness check is the enforcement, and no load-time verifier
runs on it. The verifier runs only on imported TypeScript modules.

### Why not an interpreted intermediate representation

A serializable intermediate representation interpreted by the runtime would
keep the compiler out of the trusted base. It is not proposed, for two
reasons. The plan is needed as data in either design, because scheduling,
label instantiation, and storage all read it, so a full intermediate
representation saves little. And emitting JavaScript for expression operations
is about as complex as emitting an intermediate representation for them, while
running faster. WebAssembly output is out of scope.

## Label templates

Confidentiality combines by join and integrity by meet, so the label of an
output path is determined by which inputs flow into it. A label template is
that set in symbolic form: a set of **slots**, plus constants from declared
schemas. A slot stands for the label of one input at one path and one
observation class (value, shape, enumeration, identity, or label metadata).

- **Objects:** slots follow the paths the footprint analysis found. A subtree
  the analysis could not resolve is one slot, standing for the join over the
  subtree, and a key it could not name is the slots at every child.
- **Arrays:** the body of a `map` is compiled once against an element slot,
  so there is one template per body, not per element. Membership of the
  collection is its own slot. By ruling, the callback of a per-element
  construct is a pattern, and labels flow through it per value. The
  element has the label of its own slot of the collection and of what
  that slot holds, the index and the whole collection have theirs only
  for a node that reads them, and each captured value has its own.
  A node of the body takes the labels of what it reads and closes over,
  and nothing of what another node of the same body reads. So a handler
  that closes over the element alone writes under the event and the
  element, also where another node of the body reads the index. Nothing
  of another element, and nothing of the collection's length or order,
  reaches a node that reads neither the index nor the collection. The
  label of the index is the label of the collection's own array: its
  length and which link each position holds. It holds nothing of what
  the links point to, and it is the label of the whole array, not of
  the positions up to the element's own
  ([plan format and label templates](plan-and-label-templates.md),
  §2.2). This is
  tighter than the runtime of today, which stores one join of the `map`
  coordinator's transaction on every path of an element's argument
  document ([plan format and label templates](plan-and-label-templates.md),
  §3.6).
- **Conditionals:** the template of a conditional is the condition's slots
  plus the slots of the branch that was selected. A template depends on a
  value in three places: the branch a conditional selected, the prefix at
  which a `findIndex`, `some`, `every`, or `find` stopped, and the child that
  a dynamic key, a `minBy`, a `maxBy`, or a keyed lookup chose
  ([plan format and label templates](plan-and-label-templates.md), §3.13 and
  §3.18). Where several elements have equal keys, `minBy`, `maxBy`, and a
  keyed lookup choose the first in the source order of the collection
  (§3.8 and §3.18 there).
- **Sandboxed calls:** the output's template is the union of the slots in the
  body's footprint, of the templates of the computed values the body
  observes, and of what the body read dynamically through the cell handles
  it was given. A reference the body passes on unchanged keeps its own label
  ([plan format and label templates](plan-and-label-templates.md), §3.9).
  By ruling, a handle that a body passes on without reading through it adds
  nothing of the label of its cell to what the body writes: the label stays
  at the cell and reaches only a reader that follows the handle. The link
  the body writes is labeled all the same, with the label of the link the
  body was given the handle through, and in a handler with the body's
  template, which holds the label of the event (§2.2 and §3.9 there).

A template label is equal to the label the runtime computes today or tighter,
with three deliberate exceptions
([plan format and label templates](plan-and-label-templates.md), §3.1).
Tighter means fewer confidentiality clauses or more integrity atoms.

- The membership label of a collection index bucket is wider, because it
  includes the keys of the elements that are not in the bucket (§3.17 there).
- A read through a cell handle is a static slot when every run of the body
  that returns normally makes it. A run that throws before the read carries
  the read's label all the same, where today its transaction does not (§3.9
  there).
- A read of a default carries no integrity, where today the read has the
  integrity of the entries that resolve at the place. Fewer integrity atoms is
  looser, and the exception is by ruling. Integrity is anchored in a stored
  object as a whole: a read of the object whole keeps the object's integrity,
  also where a default fills one of its properties, and a read that selects a
  defaulted property carries none (§2.5 there).

Two rows are tighter than today by ruling. The runtime joins the confidentiality
that the arguments of a node declare onto the node's result, whatever a run
read. A conditional and the container of a `map` are trusted not to join the
labels of all their arguments, so their templates leave that static part out,
and the comparison of staging step 3 expects the difference (§3.1, §3.5 and §3.6
there).

By ruling, trust is attached to a pattern. A promoted `computed` mints no
`TransformedBy` atom for the code of its callback, and every kept output of a
pattern carries a `TransformedBy` atom that names the pattern, a value the
pattern only passes on included. Where the value is passed on by reference,
the atom is joined onto the content at the output path, with no scope, so a
read through the link takes it; the stored label of the target, at its own
address, stays what it was. A value the pattern body passes on then has
an atom where the runtime stores none today, which is tighter. By ruling,
every commit of a compiled pattern is prepared when the experimental option
is on, so the atom is stored even where a commit reads no labeled data; the
build does not yet do this. By ruling, code of a pattern compiled into
another mints the atom of the pattern whose source holds it. What identifies
the pattern, and whether anything besides a kept output gets the atom, are
*assumed* (§3.2 there, question 71).

Instantiating a template means substituting actual labels for slots and
combining them. The runtime does this only for what it stores or checks:
kept outputs, the targets of side-writes, the arguments of child instances,
effect requests, and the values a handler binding or an inline pattern copies
([plan format and label templates](plan-and-label-templates.md), §4.1). That
an inline pattern instantiated in a function body binds its captures as a
handler binding does is an assumption
([continuation plan](../../plans/compiled-pattern-language.md), question 48).
The runtime instantiates only when a slot's label changed, or one of the
three choices above did. A change of value alone does no label work. With
labels held by content address
([content-addressed CFC labels](../content-addressed-cfc-labels.md)), an
instantiation is a union of identifiers and can be memoized by template and
input label identifiers.

By ruling a template that reads another output of the plan names that
output's template and holds no copy of it. The size of a plan is then
linear in the number of its outputs and of the nodes of their templates,
and does not follow the number of paths by which one output depends on
another. The label of an output is evaluated once in a transaction and
used by every template that names it, so the cost of label evaluation is
linear as well, and no template changes its meaning
([plan format and label templates](plan-and-label-templates.md), §3.2
and §4.1).

Provisional (P6 and P7 of the continuation plan, decisions of the
coordinator of this work and not rulings): a template that is no output
and stands at more than one position of a plan, as the operand of `&&`
that is both the condition and a branch does, is written once in a table
of the plan and named at each position, and a subschema that is equal at
more than one position of a schema is written once under `$defs` and
named by `$ref`, whatever types the author declared. Neither changes a
label or the meaning of a schema ([plan format and label
templates](plan-and-label-templates.md), §1.5 and §3.2).

Constraints such as required integrity and maximum confidentiality become
constraints on slots. Where the labels of the slots are declared in schemas the
compiler checks the constraint and reports a violation as a compile error.
The check also runs when the template is instantiated, because a declared
label is a lower bound on what a slot carries. Two results are settled at
compile time: a writer policy on a static write edge, and an integrity
requirement that a declared atom satisfies
([plan format and label templates](plan-and-label-templates.md), §4.4).

## Execution

### One transaction per cause

A cause is what a transaction is opened for. There are four kinds: an event
delivered to a handler, a set of changes, the completion of an effect, and a
change of demand. A set of changes is the commits that arrived from storage
and the writes of the events that were handled. The commit that stores an
effect's result is among the changes of the set that follows it
([scheduler and serving loop](scheduler-and-serving-loop.md), §10.2). A
change of demand is a cause because an output that becomes demanded may be
stale, and its transaction runs as the principal whose demand changed. An
event, a set of changes, and a change of demand each open one transaction,
in one space ([execution and storage](execution-and-storage.md), §1.1).

A transaction is one of two kinds.

- **An event's transaction** evaluates the stale cones that compute what the
  handler reads, and then runs the handler body. It holds no other
  derivation.
- **A derivation transaction** is what a set of changes and a change of
  demand each have. It evaluates the cones that are stale and that something
  demands, and commits the kept outputs that changed, with their labels. The
  completion of an effect has no derivation transaction of its own: what
  reads the result is evaluated in the derivation transaction of the set of
  changes its commit joins.

Several events are handled in one batch. Each event of the batch has a
transaction of its own. The stale cones a handler reads are evaluated before
its body, the ones an earlier event of the batch made stale included. Every
other derivation the batch made stale settles once, in one derivation
transaction behind the batch, and not once per event
([scheduler and serving loop](scheduler-and-serving-loop.md), §5.1 and §5.4).

What a failure does depends on what failed
([plan format and label templates](plan-and-label-templates.md), §4.4 and §5;
[execution and storage](execution-and-storage.md), §1.7).

- **A label constraint on what a handler itself writes** rejects that event's
  whole transaction. The other events of the batch are not affected.
- **A label constraint on a derived write** drops that write alone. A derived
  write is a kept output, or a write a cone performs. Its target keeps what
  is stored, and the rest of the transaction commits.
- **A conflict on a derived write,** found when the transaction commits,
  withdraws that write alone, with the writes that used what it staged. The
  rest of the cause's transaction commits. That the writes that used it are
  withdrawn with it is an assumption
  ([continuation plan](../../plans/compiled-pattern-language.md), question
  39).
- **A cone that fails,** for example because the body of a `lift` or a
  `computed` throws, takes an error state with a label for its outputs, and
  the rest of the transaction commits. Where a handler reads the failed
  cone, the handler fails in turn, and its event's transaction is aborted
  as for a body that throws
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §5.5).
- **A handler body that throws** aborts its event's transaction, as it does
  today.

### Pull and dependency cones

Evaluation is demand-driven. The compiler partitions the pattern body into
**dependency cones**. Every value the instance computes is computed by exactly
one cone, a cone can compute several outputs, and a cone that uses a value
another cone computes has an edge from that cone
([execution and storage](execution-and-storage.md), §2.1). A pull of an output
evaluates the cone that computes it, with the cones that cone depends on
where they are not current, and nothing else, for the value and for the
label. A **cone instance** is one cone as it is evaluated for one scope key
and, inside the body of an element construct, one element key. The record
of a cone lists the collections of the element bodies it is written in,
and the runtime takes from the list which cone instances exist and under
which element keys what they hold is kept
([plan format and label templates](plan-and-label-templates.md), §1.4).

- An output passed to another pattern is a link. When the consumer is pulled,
  the pull extends through the link into the cone of the producing instance
  that computes that path. That holds within one space. A consumer in
  another space reads the producer's kept output as stored
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §9.2).
- The body of an element construct, such as the callback of a `map`, is one
  or more cones, and they are evaluated once per element key
  ([execution and storage](execution-and-storage.md), §2.1 and §2.5). That
  holds for every cone of the body, one that reads neither the element
  nor the index included, and alike for an array of references, an array
  of plain values in place, and the result of another per-element
  construct. The
  key holds the element's value when the element is a plain value, and the
  identity of the element's cell when it is not. In both cases it also
  holds the count of earlier occurrences of the same value or identity in
  the collection, so two equal elements have two keys. Over an array
  of plain values in place, in particular a plain array that one
  computation generates from scratch, as the result of an API call
  is, the author can declare the key on the array with the array
  type `ArrayByKey<T, "field">`, which is a `T[]` whose elements are
  plain `T`: the key then names that field and holds a salted hash of
  its value, and an element of a new array with the same value of
  the field is the same element. The declaration can name several
  fields, as `ArrayByKey<Repo, "owner" | "name">`, and the element
  then has one key across them, with the names and one hash of the
  combined values. A reference that holds such a key is resolved
  from the key alone, with no schema, and does not show the values.
  The key belongs to the array: an element that is put into a second
  array has the key that array declares, or none. An array of
  references does not
  need the declaration, because the key is the identity of the element's
  cell and an edit does not change it, and the result of another
  per-element construct carries a declared key through the upstream
  key. The position is never in the key, also where the callback
  uses the index. An element
  that moves keeps what was evaluated for its key, and its state cells,
  streams, effects, and children. The index is a slot given to the nodes
  of the body that read it, so a move evaluates those nodes alone, and
  reordering a list recomputes nothing else. A state cell declared with
  a value from the index keeps what it holds when its element moves. A
  cell or a child that a function body makes under an explicit cause
  that holds the index is named by the cause, and a binding of a
  function body that copies the index is a stream named by the copied
  value, so a move names another. A key derived from a value
  is salted with a secret of the space before it enters a document
  identifier, so that an identifier does not reveal the value
  ([plan format and label templates](plan-and-label-templates.md), §1.3).
- When an element moves, the runtime moves what its key holds, its
  stored results included, to the new position, and evaluates nothing
  for it except the nodes that read the index. An element of a
  collection that is the result of a per-element construct, such as a
  `map` or a `filter`, is keyed by the key of the upstream element it
  came from, so a change of one upstream element evaluates that
  element's nodes through a chain of such constructs and no other
  element's. An output that passes such a result on unchanged is the
  same collection for keying, and the plan marks it. Where the source
  is plain values that one computation
  produces as a whole array, an implementation may evaluate the whole
  collection again on each change, with the same observable result
  ([execution and storage](execution-and-storage.md), §2.6).
- An element that is a plain value in place is named by its collection
  and its key. A reference to it or to a member of it resolves to the
  position the element has at each read and each write, so `equals`,
  a member bound both ways, and a write through the element work over
  an array of plain values in place, and a move still evaluates
  nothing. A cone that passes such an element on stores that
  reference and no copy. After the element is removed the reference
  reads as nothing, which is a deliberate difference from today. A
  write through the reference that changes the value re-keys the
  element in the same transaction, and what its key holds moves with
  it. A function body that reads such a value through a handle holds
  a copy and stores the value where it writes it elsewhere, as today.
  A handler that declares a data type for its element in its state,
  as `stop: Stop`, is given a reference by key, and a member read
  from it carries the reference, so `center.set(stop.position)`
  stores a reference by key. `items.key(i)` is
  a handle by position that nothing rewrites to a reference to the
  element, over all three kinds of source, and it is equal to the
  reference of the element that stands at `i` at the moment of the
  comparison. Over
  an array of references a reference to an element is the link to its
  cell ([plan format and label templates](plan-and-label-templates.md),
  §1.3).
- Everything an element body holds is per element key, and so per
  occurrence: its state cells, its streams, its effects, and its
  children. Equal elements share nothing, and each has the label of the
  address it was read from. A body over plain values may declare a state
  cell. A body with no state of its own could reuse one outcome for equal
  values, and the design does not special-case it. Where two equal values
  stand in a collection and the first is removed, the state that remains
  is that of the first occurrence
  ([language subset](language-subset.md), §4.4.1).
- A collection among the children of a view node is stored as one
  nested child, with its elements at `children/<n>/*`, over an array
  of references, over an array of plain values in place, and over the
  result of another per-element construct alike
  ([execution and storage](execution-and-storage.md), §4.2). A spread
  child, and an array literal among the children that itself has a
  spread or a hole, is one child at its written position as well, the
  literal stored as one nested array value, in the same three cases
  ([plan format and label templates](plan-and-label-templates.md),
  §3.4).
- The removal of an element drops the cone instances of its key and
  deletes nothing that is stored under the key. An event for a stream
  of the element's body is refused while the key is away. An element that
  returns under the same key reads what its state cells held, over an
  array of references, over an array of plain values in place, and
  over the result of another per-element construct alike. Nothing in
  the design reclaims that storage
  ([execution and storage](execution-and-storage.md), §2.6).
- A change to one element dirties that element's cones. A membership change
  dirties the container.

Within an instance the order of evaluation is static, so the runtime does not
discover read sets or sort nodes for it at run time. Dynamic read tracking
remains for link hops through data, whose targets are not known statically,
and for some of the reads a function body makes through a cell handle it was
given. Such a read is static when it goes through one handle whose position
in the body's inputs is known, at a static path, and every run of the body
that returns normally makes it. It is dynamic otherwise: a read that only
some runs make, such as one under a condition, stays dynamic
([footprint analysis](footprint-analysis.md), §7.2). Where footprint analysis
gives up on a value or on a key it widens a static slot, and no dynamic
tracking is involved. A cell handle the analysis loses track of is
different: the reads through it are tracked dynamically, and may reach
everything the handle's declared type covers
([footprint analysis](footprint-analysis.md), §5.1).

### Computations that write

A computation may write through a cell passed to it, and the write tiers of
[Scheduler v2](../scheduler-v2/README.md) (§4.3) carry over.

- **Primary output and static side-write targets** are part of the compiled
  instance. A static side-write target is one more output edge of the cone
  that writes it. Its label is the template of the written expression, which
  is the body's template when a sandboxed body performs the write, and the
  write-side checks apply to it: the write floor, the fit with the target's
  declared confidentiality, and the writer policy
  ([plan format and label templates](plan-and-label-templates.md), §3.11).
  The cone is an ordinary node, and its write targets count as its
  outputs for demand: a demanded reader of a written cell demands the
  cone first, a reader that passes the cell on by reference included
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §4.3).
- **Materializers**, whose write targets are dynamic or too broad to predict,
  are scheduled outside the compiled instance with their own transactions.
  A materializer is evaluated eagerly whenever one of its inputs
  changes, as a rule after the rest of the wave has been evaluated, and
  its writes make their readers stale, which a further wave evaluates.
  Those are the rules it has today: standing demand, idle priority, and
  promotion when a reader touches the declared envelope. Where a
  materializer cannot be promoted for a handler that reads inside its
  envelope, the event waits:
  it holds its place in the queue and is handled after the derivation
  transaction and the materializer have run
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §7.2).

A more precise write-path analysis turns more materializers into computations
with static targets, which removes them from eager scheduling.

Side-writes mean a pattern instance is not acyclic by construction. A
side-write to a cell an earlier cone read dirties that cone again. The
compiler reports the cycles it can see in the plan, as a warning. Every cycle
is bounded inside the cause's transaction: a cone instance is evaluated at
most ten times in one transaction, and one that would need an eleventh
evaluation fails and takes an error state. The number is a placeholder, and
it is fixed with the plan version so that a client and the server fail the
same cone instances. A cone instance that failed at the bound is not
evaluated again until one of its inputs changes
([execution and storage](execution-and-storage.md), §2.7;
[scheduler and serving loop](scheduler-and-serving-loop.md), §8.1). The
idempotency contract and its validator apply to every body that writes.

## What is stored

### The keep set

An **instantiated** pattern is one whose result cell was explicitly assigned.
The keep set of an instance is everything reachable from that result cell.
Reachable derived values are stored with their labels, because readers
elsewhere cannot recompute them. The rendered tree under `[UI]` is part of
the result, so a value bound into it is kept, as a path of the result and
not as a node with a document and a transaction of its own. Nothing reaches
a value inside an instance except through the result cell.

The keep set is stored in as many documents as serve its readers: the result
document, and part documents. A kept subtree, such as a row of a kept
collection or a node of the rendered tree, can be stored in a part document
of its own, with a link to it at its place in the result, so that a reader
loads and subscribes to the parts it uses. The runtime decides which
subtrees are split off by a rule about size. Provisional (P20 of the
continuation plan): a subtree is a part only from a minimum size on, and
an array that is too large for one document is stored in chunk documents,
each a contiguous run of its entries, so that one change of one row
writes one chunk at any length of the list. Provisional (P27 and P28): a
record with many members is stored in chunks the same way, and the part of
a row is named by a number that the runtime mints and by no key. An index
from a key to its chunk is open, with no provisional decision (question 299
of the continuation plan): a runtime that does not hold an array's keys
reads its chunks in order to resolve a reference by key. Chunked storage of
long arrays is a requirement on the storage layer and is decided there;
this design keeps the split points, P22 and the bound on what the change of
one row writes (the coordinator's recommendation, not an owner ruling). A
reader names the result cell and a path, whichever document stores the path,
and a split changes no value and no label. One evaluation writes every
document it changed in one transaction.
[Execution and storage](execution-and-storage.md) §4.10 owns the rule, and
[plan format and label templates](plan-and-label-templates.md) §2.3 says
what a split has to preserve.

A pattern compiled into another, such as the body of a `map` or an inline
sub-pattern, is not instantiated in this sense. It has no result cell and no
pattern metadata. If all its outputs are consumed by further computation it
has no stored state at all. Provisional (P18 of the continuation plan): a
plan holds a pattern that a call or a tag names once, as one record that
each of its call sites names, so the size of a plan is linear in the source
for any nesting of calls
([plan format and label templates](plan-and-label-templates.md) §1.1).

### State cells

State that handlers write is stored in documents whose identifiers derive from
the cause of their creation, not from their content: the parent instance, the
compiled-in calls and element bodies that enclose the declaration, and the
cell's name. Two independent executions arrive at the same identifier even
when they start from slightly different data. Such a document is written when
the cell is first written. A first value that is a constant is the
default of the cell's schema: nothing is written when the cell is
created, and a read of a cell that holds nothing reads the default. A
first value that is not a constant is computed by a cone and written
once, when the cell is first created, always as a value and never as
a reference, so a write to the cell does not land in the input the
value came from. A write below the root of a cell that holds nothing
creates the document from the default with the write applied, and the
members taken from the default keep the label of a default
([plan format and label templates](plan-and-label-templates.md), §1.3).
A state cell document carries no pattern reference and no manifest, and it
keeps the back-link to its result, which `resultOwnerOf` reads
([plan format and label templates](plan-and-label-templates.md), §3.16).

The compiler derives the name as the transformer does, from the variable the
cell is assigned to (the `.for(...)` cause it emits). A declaration assigned
to nothing takes a name from what it is, such as the callee's name for a
call. Where two declarations of one pattern body have the same name, each
takes its ordinal among them
([plan format and label templates](plan-and-label-templates.md), §1.3).
Where the author writes `.for(cause)` on a declaration in the reactive tier,
the cause is a string literal, and it takes the place of the declaration's
name. A cause that is data is legal only in a function body. Both are
assumptions ([language subset](language-subset.md), §4.7).

A state cell declared directly in the pattern body, under a variable's name
that no other declaration of the body has, keeps the identifier it has today.
One declared inside a sub-pattern that is compiled into the surrounding
instance has a new identifier, and its stored value is found through a
carry-over record. The record is an assumption with a limit: computing it
needs the builder path, so the instances of a space switched after stage 6
start that state empty
([continuation plan](../../plans/compiled-pattern-language.md),
question 27). One declared inside a `map` body is not carried over: its
identifier includes the element key, which this design redefines
([execution and storage](execution-and-storage.md), §5.7 and §9).

Migration is by space. The scheduler is switched per space: a space runs
the builder path or the compiled path, and never both. That document
proposes the procedure (§9.4). A switch gives every instance of the space
its compiled setup and marks the space, and it evaluates nothing. The
first compiled evaluation of an instance, one setup transaction when the
instance is first loaded after the switch, replaces its stored layout with
the compiled one.

### Provenance

A kept output has a full provenance chain: its label template, the identities
of the inputs bound to the template's slots, and the identity of the compiled
pattern. The stored record names the template and holds the selections and
the addresses read dynamically. The identities bound to slots are not copied
into the record where the plan and the document determine them
([execution and storage](execution-and-storage.md), §7.2). Interim values that
are not kept have no stored provenance of their own.

### Caching for incremental computation

Storing a pure derivation does not change what a pattern means, so whether to
cache one is a runtime decision and not a language feature.

- The runtime always keeps a memo of evaluated cones in memory.
- Effect results, and the state of aggregates, `reduce`, and collection
  indexes, are always stored.
- The runtime measures the recomputation cost of each cone and how often it is
  pulled, and promotes a cone to a durable cache when recomputing costs more
  than storing. The plan can carry a directive per cone that forces or
  forbids the promotion. The language has no form by which an author writes
  one, so a compiled plan leaves the decision to the runtime
  ([execution and storage](execution-and-storage.md), §8.5).

## Built-ins and factories

The [built-in inventory](builtin-inventory.md) places each built-in and
factory in one of four classes, A to D, and states its label rule. Two of the
classes hold what remains an operation at run time.

- **Structural operations** (class A) become compiler operations with label
  rules: `ifElse`, `when`, `unless`, `map`, `filter`, `flatMap`, the
  aggregates, the collection-index family, `str`, `anchorsOf`,
  `inspectConfLabel`, and `wish`. Authors write the reactive constructs of
  the language, and `mapWithPattern`, which the transformer generates today,
  has no counterpart: the compiler does not rewrite a collection method to
  such a form, in any tier. The callable forms `ifElse`, `when`, `unless`,
  and the `str` tag are removed, so that no new pattern is written in the old
  way. The compiler accepts them for an interim period, with a warning that
  names the replacement, only as long as doing so costs it nothing beyond
  mapping each to the same operation as `?:`, `&&`, `||`, and a template
  literal.
  `reduce`, `findIndex`, `some`, `every`, and `find` are reactive constructs
  too. The callback of `reduce` is restricted to an expression, and its
  accumulator is a data type. The labels of `findIndex`, `some`, and `every`,
  and of the choice `find` makes, join the elements up to and including the
  deciding one, and not the ones after it
  ([plan format and label templates](plan-and-label-templates.md), §3.13).
  `wish` is structural because what it creates, it creates idempotently: its
  result reads as if the data had already existed.
- **Effectful operations** (class B) stay durable boundaries with declared
  label rules and their own transactions: the fetch family and
  `fetchProgram`, `generateText`, `generateObject`, `llmDialog`, `agent`,
  `sqliteQuery`, `navigateTo`, `compileAndRun`, and the staged changes
  (`grantSpaceAccess`, `revokeSpaceAccess`, and `nameBlob`). The staged
  changes have no transaction of their own: an access change is a step of
  the commit of the event's transaction, and `nameBlob` stages a document
  in that transaction
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §6.1).
  `cellFromUrl` splits: parsing an address is structural, and resolving a
  space name or host is effectful.

The egress ceiling of an effect is checked on its request and on the
content the request holds by reference. A language-model built-in also
sends content after its request: a tool-loop result sent back to the
model, a system prompt rendered again from live context, and each send of
a dialog's live transcript. The ceiling is checked again on each such
send. A send that fails the check is not made, and the built-in's result
takes the error state
([plan format and label templates](plan-and-label-templates.md), §3.14;
[scheduler and serving loop](scheduler-and-serving-loop.md), §6.3). A
request a handler made that is still pending when a process activates the
space is made again at activation, with the references followed and the
ceiling checked on the content as it is then (§2.3 there).

A pattern closure can be given to a language-model built-in as a tool.
The argument the model supplies carries the label of the model's output,
which is the label of the generation that produced the tool call. The
result of the call carries the label of the instance's own result, by the
ordinary rules for an instance's outputs
([plan format and label templates](plan-and-label-templates.md), §3.15).
How the instance of a tool call is identified, in which space and scope
it is made, and when it is torn down are assumptions
([built-in inventory](builtin-inventory.md), open question 6).

The other two classes are the authoring markers (class C), such as `pattern`,
`handler`, and `computed`, which stay in the language as syntax the compiler
recognizes, and the removed forms (class D), which have no counterpart, among
them `streamData`, `llm`, and every form the transformer emits.

Inside a function body, five kinds of runtime call remain:

- instantiating a pattern, which every kind of function body may do;
- creating a cell, which receives a causal identifier. In a `lift` or a
  `computed` the cell needs an explicit cause;
- requesting an effectful built-in, which behaves like instantiating a
  built-in pattern. Only a `handler` or an `action` requests one directly. A
  `lift` or a `computed` does not request one itself. It has an indirect
  way: a pattern it instantiates may request effects in its own body. An
  effect that depends on computed data is written in a pattern the
  computation instantiates, or in the reactive tier with the computed
  value as its input;
- reading context that is not a cell: the event's key and acting principal,
  a space's identity and access list, and the principals a label attests;
- binding a handler to its state, which yields a stream. An inline event
  handler in JSX built by a function body is such a binding
  ([language subset](language-subset.md), §5.2).

The [built-in inventory](builtin-inventory.md) ("Which body may make which
call") has the table of which body may make which of them.

A function body that needs reactivity instantiates a pattern. A body that
wants a reactive mapped list, for example, wraps the expression in an inline
`pattern(...)` and instantiates it.

Each handler invocation is a new frame, so the cells and instances it creates
are new on every call. They are identified by the handling and their order
within the invocation. A handling is one event on one stream, and it is
identified by its receipt, which leaves the acting principal out
([plan format and label templates](plan-and-label-templates.md), §1.3). What
a handler creates under an explicit cause is the exception: a cell created
with `X.for(cause)`, or an instance requested with `.for(tag)`, is
identified without the handling, so different events name the same thing,
and its existence label is fixed when it is first created (§1.3 and §3.14
there). Without an explicit cause an identifier minted in a handler
derives from the event, as today.
Pattern bodies, lifts, and computeds are re-evaluated, so what they create
needs an identifier that is the same on every evaluation.

What a handler binding holds depends on where it is made
([plan format and label templates](plan-and-label-templates.md), §3.14).

- **A binding made in the reactive tier copies nothing.** The reactive tier
  is the pattern body and everything compiled in it, the body of a
  per-element callback included. Every path of the handler's state resolves
  to a slot or an output of the instance, and the handler reads it from
  there when an event arrives. The stream is named by where the binding is
  declared.
- **A binding made while a function body runs** holds a link or a copy for
  each path of the handler's state. A cell handle stays a link. A container
  that the body read from an input or a cell and passes on unchanged is
  bound by reference: the binding holds a link to the address the container
  is stored at, the body does not read its content, and the handler reads it
  when an event arrives. A scalar, and a container the body computed, are
  copied. The stream is identified by the enclosing instance, the handler,
  the copied values, the identities of the linked cells, and the addresses
  of the containers bound by reference. A copied value is salted before it
  enters the identifier, as an element key is. A binding made in a handler
  is identified the same way, and not by the handling.

### Instantiating a pattern from a function body

Instantiation is a request the runtime records and performs, not graph
construction in JavaScript. The syntax stays a call, `DonutCard({ donut })`,
and the callee must be one of:

- a pattern declared in the module or imported by name;
- an inline `pattern(...)` expression, which the compiler hoists, turning its
  captures into private parameters. In the reactive tier such an expression
  may also be used as a value, a pattern closure, which is what replaces
  `patternTool` ([language subset](language-subset.md), §4.4.2). For an
  interim period a direct `patternTool(...)` call in a pattern body is
  accepted with a warning and rewritten to such a closure (§4.4.3 there);
- a pattern received as a factory value
  ([first-class serializable factories](../pattern-construction/node-factory-shipping.md)).

A callee may carry the modifiers `asInstance()`, `asScope(scope)` and
`inSpace(space, options)`. A call through `asInstance()` is an
instance of its own, with an argument document and a result document
of its own, and is not compiled into the surrounding instance; a call
through `inSpace` is such an instance already. In the body of a
per-element construct such an instance is identified by the site, the
collection and the element key. It stays when its element leaves the
collection, it is the same instance when the key returns, and events
for its streams are handled in between. Over an array of references
its argument holds the reference to the element; over an array of
plain values in place, and over the result of another per-element
construct whose upstream position holds a value, it holds the value,
written again when the element changes while it is in the
collection. Over an array of plain values in place that declares a
key with `ArrayByKey<T, "field">`, a new array that
holds an element with the same value of the field has the same
instance. An event for a stream of an element body without the
modifier is refused once the element has left. Cleanup of instances
that nothing refers to is deferred
([language subset](language-subset.md), §4.4.2). The identifier of an
instance an `inSpace` request
makes is known when the body makes the request. The identifier of a space
the request creates is obtained and is not derived from the request. The
runtime records the allocation in the calling space, in a step that commits
before the step in the other space, so that a retry names the same space
([execution and storage](execution-and-storage.md), §5.6).

A function body may call two kinds of factory value: a pattern factory, which
it instantiates, and a handler factory, which it binds to state to obtain a
stream. A handler received by reference is resolved at run time like a
pattern received by reference: its own compiled record supplies its
footprint, its write edges, and the identity that write policies name. A
`lift` result is not a factory value.

In a handler, the call records an instantiation request with a causal
identifier and returns a link. The runtime performs the instantiation when the
handler's transaction commits. Writing the link into state is what gives the
new instance a result cell and makes it an instantiated pattern. Passing the
link to `navigateTo` does the same, because navigation requires a result
cell. A request whose link the body drops creates nothing
([plan format and label templates](plan-and-label-templates.md), §3.14).

In a `lift` or a `computed`, the instance the call makes belongs to the
computation
([plan format and label templates](plan-and-label-templates.md), §3.14;
[execution and storage](execution-and-storage.md), §2.8).

- An evaluation that instantiates the same pattern at the same place names
  the same instance and updates its argument. The instance keeps its state
  across evaluations.
- An instance that an evaluation no longer makes is torn down: its cones are
  not evaluated again and its effects are not requested again.
- The pattern may request effects. An effect in the instance is requested
  again when its request changes, as any effect is whose input changed. What
  the computation read reaches the request through the argument the
  computation writes, and its label reaches the request with it.
- The instance is identified by the enclosing instance, the body's `name`
  and `within`, the site of the call, and the ordinal of the
  instantiation among those the evaluation makes at that site. Where the
  author writes `.for(cause)`, that cause takes the place of the ordinal
  ([plan format and label templates](plan-and-label-templates.md), §1.3).
- A site in a loop or a callback of the function body names its instances
  by the order in which an evaluation makes them. The compiler warns, and
  does not refuse, where such a site has no `.for(cause)`
  (`function-body:instantiation-without-cause`;
  [language subset](language-subset.md), §5.2).
- The computation does not request an effect directly.

In the reactive tier the same call, with a callee the compiler can resolve
statically, denotes an anonymous sub-pattern, compiled into the surrounding
instance like the body of a `map`. A callee that is a factory value is known
only at run time, so the call creates a child instance with its own plan and
result cell
([plan format and label templates](plan-and-label-templates.md), §3.15).
Inside a per-element body such a child is per element key, so each
occurrence of an element has a child of its own (§1.3 there).

## The scheduler

The compiled instance takes over the work the scheduler does inside a pattern
today, for cones whose write surface is static:

- the node registry and the per-node record;
- read-set discovery from transaction journals and the diffing of read sets;
- ordering nodes within a pass;
- trigger-read bookkeeping for statically known reads, because a template's
  slot set already contains every such input that can cause a recomputation.

Trigger reads stay for dynamic reads: the reads that follow links through
data, and the reads through a cell handle that stay dynamic. Their targets
are not in any template, so a recomputation caused by a change at such an
address has to join that address's label the way it does today.

A scheduler remains across instances. Its units are pattern instances,
effectful operations, and materializers. An edge exists where one unit reads
an address that another writes: a kept output, or the target of a write a
cone performs. It keeps five responsibilities:

- turning the storage change channel, including remote writes, into dirty
  slots;
- tracking demand, which is held on kept outputs per path, whichever
  document stores the path, and on the writes of cones, so that an output
  nothing observes is not evaluated. A change of demand is a cause
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §4.1, §4.2,
  and §4.5);
- serializing the event queue, and forming the batches of events. An event
  for an instance that is not loaded is routed through a stream index, which
  holds one row per stream, from the stream's identifier to its instance and
  binding
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §5.1);
- running effect operations, with their time gates and retries, and
  materializers;
- following links across spaces.

Convergence bounds apply at this level and, because of side-writes, at cone
level inside an instance. What a handler reads through its static footprint
is known before its body runs, so the stale cones that compute it are
evaluated inside the event's transaction, before the body. A read the
handler makes through a cell handle that stays dynamic is not known before
the body runs. The runtime makes it current when the body makes it
([scheduler and serving loop](scheduler-and-serving-loop.md), §5.3).

A read of a cell whose writer is in an instance that is not loaded consults
the rows the scheduler stores of what is current. Where they show the stored
value current, the read returns it and does not load the instance
([scheduler and serving loop](scheduler-and-serving-loop.md), §5.3 and
§10.4).

The scheduler is switched per space. A space runs either the builder path
with [Scheduler v2](../scheduler-v2/README.md) or the compiled path with
the scheduler described here, and never both, so no loop hosts two
schedulers for one space. The two paths exist side by side only for
validation (§10.8 there).

## Server execution and client speculation

Execution is authoritative on the server
([server-primary execution](../server-side-execution/README.md)), and the
compiler runs there. The remaining scheduler is a natural part of the serving
loop ([serving loop](../server-side-execution/serving-loop.md)).

Clients run the same compiled artifact speculatively to render with low
latency, and send events to the server
([speculation](../server-side-execution/speculation.md)). A client fetches the
value code and the plan and does not compile. A client requests no effect,
with one exception: it enacts `navigateTo` from its speculative run, and the
enactment is reconciled with the server's result as it is today
([scheduler and serving loop](scheduler-and-serving-loop.md), §6.7).

A client cannot read the secret that element keys are salted with. It can
therefore not derive an identifier that holds a value-derived key or a
copied value: per-element state whose key holds a value, and the stream of a
handler binding with a copied path. It names either one only from a link
the server has stored. Everything else a client names from the plan and the
data it holds, before the server's result arrives
([scheduler and serving loop](scheduler-and-serving-loop.md), §11.1).

Speculative values that reach the render boundary need labels. A client
reuses the last committed label of an output while the labels of its
template's slots and its selections are unchanged, and instantiates the
template locally otherwise.

A client also evaluates the gates it can from the plan and the data it holds,
so that it does not show a result it can tell the server is going to refuse.
It cannot evaluate every gate: the egress ceiling of an effect a handler
requests, for example, depends on sink ceilings that are server
configuration. The table of which gates a client can evaluate is in
[scheduler and serving loop](scheduler-and-serving-loop.md), §11.3. FabriChat
is the reference case: the pattern declares that a message is added only when
the send event comes from a trusted UI element. The constraint guards what
the handler itself writes, so a send from an element without that integrity
has its whole transaction rejected by the server. The client's speculative
run of the handler rejects it too, from the same plan. The client's verdict
is advisory and the server's is authoritative.

## Correspondence with the CFC specification

This design changes what CFC decides: labels come from templates instead of
from the read set of a transaction. That is a specification change, and it
lands in `commonfabric/specs` first, with prose, pseudocode, and proof
together. The relevant parts of the specification are §8.9.1, which requires
that precision beyond the structural record rests on a trusted
`flow-taint-precision` claim by the executing implementation, and §8.9.2, the
propagation algorithm.

The Lean development already has an expression language with labeled
evaluation, and a normalized authored-graph surface with a bridge to the
end-to-end theorems. The proposal is to grow the expression language into the
calculus of the plan (collections, selection, and opaque calls with a
footprint) and to prove two things:

- instantiating a template yields the same label as labeled evaluation of the
  expression;
- noninterference holds for one transaction per cause, tied to the existing
  commit-point results.

The plan then is the normalized authored graph, so no separate trusted
extraction step from builder artifacts remains.

Two mechanisms tie the proofs to code:

- the plan's type definitions are generated from the Lean definitions;
- the Lean evaluator is executable, so it serves as a differential oracle: for
  every pattern in the test corpus, the labels the runtime computes are
  compared with the labels the Lean evaluator computes.

The template evaluator is a kernel function in the sense of the correspondence
procedure: pure, named after its pseudocode, and the only place the runtime
decides what that pseudocode decides.

## Implementing the compiler

The compiler is a separate program written in Rust. The runtime's CFC kernel
and scheduler stay in TypeScript.

- **For Rust:** the compiler runs natively on the server and in the command
  line, an existing TypeScript parser can be reused, the trusted base is small
  and auditable, and the pipeline no longer depends on the transformer
  interface of the TypeScript compiler.
- **Against:** the transformer and schema generator hold a large body of
  lowering logic and fixtures in TypeScript, and the compiler's own
  diagnostics appear when the source is compiled and not while typing. The
  published typings are plain TypeScript that an editor checks as usual, and
  a language-server plugin is not part of the design
  ([language subset](language-subset.md), §8.6.1).

The largest cost in any implementation language is the type checker for the
subset, including typings for the standard-library methods patterns use. That
is the first thing to prototype.

## Staging

Each stage can be checked before the next begins.

1. Specify the plan and the label semantics in `commonfabric/specs`, with a
   Lean sketch of the two theorems.
2. Prototype the subset type checker and footprint analysis, and measure how
   much of the pattern corpus they accept and how often the analysis gives up.
3. Emit the plan alongside the transformer's existing output, and compare
   template labels with the labels the runtime computes for the whole corpus.
   Template labels must be equal or tighter, with the three deliberate
   exceptions listed under [Label templates](#label-templates): the
   membership label of a collection index bucket, a static read through
   a cell handle on a run that throws before the read, and, by ruling,
   the empty integrity of a read of a default
   ([plan format and label templates](plan-and-label-templates.md), §3.1).
   The comparison expects these three differences and no other in that
   direction. It compares dereferenced labels, and it expects a template
   to be tighter than the runtime where the runtime joins the labels that
   the arguments of a node declare, as for a conditional and the
   container of a `map`. The slot of a handle that a body holds and does
   not read through is not dereferenced: by ruling it adds nothing of the
   label of its cell (§2.2 and §3.1 there).
4. Run one pattern with one transaction per cause and with only its keep set
   stored. Then do the same for `map`. FabriChat is the reference pattern for
   this stage and the previous one, because it exercises event integrity,
   write policy, and per-row instances together. This stage measures two
   sets of placeholder numbers in
   [execution and storage](execution-and-storage.md): the sizes at which a
   kept subtree becomes a part document and an array is stored in chunks
   (§4.10), and the constants of cache
   promotion (§8).
5. Move the remaining scheduler into the serving loop. The scheduler is
   switched per space: a space runs the builder path or the compiled path,
   and never both. A space is migrated as a whole, by a switch that gives
   every instance its compiled setup and marks the space
   ([execution and storage](execution-and-storage.md), §9). The two paths
   exist side by side only for validation.
6. Retire the builder path, and with it the builder form the transformer
   emits, soon after the validation. A space switched after this stage
   has no carry-over record computed for its instances (§9.3 there).

## Detailed specifications

The documents beside this one specify the parts of the design in detail. This
document stays the overview, and where a detailed document and this one
disagree, the detailed document governs and this one is corrected.

- [Language subset](language-subset.md): the tiers, grammar, type rules,
  labels as annotations, the standard-library surface, and diagnostics
- [Plan format and label templates](plan-and-label-templates.md): the plan's
  records, slots, observation classes, the label rule of each operation,
  instantiation and constraints, error states, and what rests on the
  compiler
- [Built-in inventory](builtin-inventory.md): each built-in's class, label
  rule, and durable state, and the calls that are legal inside function
  bodies
- [Footprint analysis](footprint-analysis.md): the abstract domain over a
  function body, where the analysis widens, the write side, reads through
  cell handles, the runtime calls in a body, and the soundness statement
- [Execution and storage](execution-and-storage.md): the transaction of one
  cause for one instance, cone evaluation and the in-memory memo, the layout
  of a result document and its part documents, causal identifiers, the
  durable state of operations, provenance, cache promotion, and migration
- [Scheduler and serving loop](scheduler-and-serving-loop.md): what remains
  of the scheduler across instances, demand, the event queue and the batch
  of events, effects, materializers, convergence bounds, links and commits
  across spaces, the serving loop, compiled artifacts, and client
  speculation

The work that remains on these documents, and the rulings that are fixed, are
in the [continuation plan](../../plans/compiled-pattern-language.md).

## Open questions

- **Gates under speculation.** Which of the server's gates a client can
  evaluate from the plan and the data it holds, and how a client presents a
  refusal it predicts
  ([render-boundary composition](../cfc-render-boundary-composition.md)). A
  table of the gates and a presentation are proposed
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §11.3 and
  §11.5). The presentation, and whether a client still sends an event it
  predicts the server will refuse, are not ruled on.
- **Residual termination channels.** Error states are specified
  ([plan format and label templates](plan-and-label-templates.md), §5). What
  stays termination-insensitive is listed there (§5.5): among others,
  divergence inside a body's budget, demand, the rejection of an event's
  transaction, a derived write that is dropped or withdrawn, an instance
  that is torn down, how many events a batch holds, and whether a cache or a
  part document exists.
- **Commits that span spaces.** A transaction covers one space. A staged
  access change and an `inSpace` instantiation both reach another space
  ([built-in inventory](builtin-inventory.md), open question 3). The proposal
  is one ordered sequence that serves both, without atomicity: the creation
  of a space a request creates, the record of its allocation, the access
  changes, the writes to other spaces, and then the writes to the home space
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §9.4). One
  part of the order is ruled: the allocation record commits before the step
  in the space it names. Whether the sequence is accepted, or an atomic
  commit across spaces is required, is not ruled on.
- **Cycles through side-writes.** The bound inside one transaction is ruled:
  ten evaluations of a cone instance, a placeholder number, after which it
  fails ([execution and storage](execution-and-storage.md), §2.7;
  [scheduler and serving loop](scheduler-and-serving-loop.md), §8.1). The
  compiler warns of a cycle it can see in the plan and does not refuse it.
  Open is the number, which needs measurement on the corpus. A cycle that
  spans several transactions has no bound in this design, by ruling: an
  effect whose completion changes its own request, and a cycle across two
  spaces, fall under rate limits in general, which this design does not
  specify. The ruling is to be revisited
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §8.4).
- **Instances a computation makes.** How such an instance is identified,
  and that the computation does not request an effect directly, are
  ruled. Open is which bodies the warning for an instantiation without a
  cause covers. *Assumed:* a `lift`, a `computed`, an `assert`, and an
  authored function one of them or the reactive tier calls, and not a
  `handler`, an `action`, or an inline event handler
  ([language subset](language-subset.md), §13, question 26).
- **A reference to a plain value in place.** By ruling such an element
  is named by its collection and its key; a write through the reference
  that changes the value re-keys the element in the same transaction, so
  its row keeps its state; a function body that reads the value through
  a handle holds a copy; a handler that declares a data type for the
  element in its state is given a reference by key, and a member handle
  read through a handle of handles is a reference by key; a re-key moves
  an instance that a computation of the body made, replaces what is
  stored under the new key, moves nothing for another element whose
  occurrence count it changed, and does not happen for a write that is
  not made through a reference by key; a key formed from declared key
  fields names the fields and holds one salted hash of their values,
  a key formed from the whole value names no field, and a reference
  by key is resolved
  from the key alone, with no schema; and
  `items.key(i)` is a handle by position that nothing rewrites, equal to
  the reference of the element that stands at `i` at the moment of the
  comparison. Three things are assumed, each for an array of plain
  values in place and for the result of another per-element construct
  where the upstream position holds a value, and none for an array of
  references ([plan format and label
  templates](plan-and-label-templates.md), §8, questions 113, 114 and
  121): the reference is stored as a link that holds the key, a client
  does not resolve it, and it resolves again when an equal value is
  added after a removal; a read through it carries the label of the
  element and of the collection's array; and the comparison of a handle
  by position with such a reference gives "not equal" where the parent
  cannot be read.
- **A pattern call that is an instance of its own.** The modifier
  `asInstance()` and what it does in a per-element body are ruled.
  Two things are assumed: that a function body which stores, outside
  the collection, a reference to the result of a pattern call written
  in a per-element body without the modifier is a compile error, and
  that the modifier is legal outside a per-element body
  ([language subset](language-subset.md), §13, questions 41 and 42).
  Each is the same over the three cases of a source. That an author
  declares the key of an array of plain values in place on the array,
  with the array type `ArrayByKey<T, "field">`, is ruled. So is that
  the declaration names several fields as a union of their names,
  that the fields enter the key in the order of their names, that the
  schema keyword is on the schema of the array, that the element part
  holds the names and one salted hash of the combined values, and
  that an element put into a second array has that array's key, or
  none. Three further things are ruled. No key, identifier or stored
  string of the design is built by joining parts with separators and
  an escaping of its own: each is a fabric value that the helpers of
  `base/data-model` hash and write. A reader whose type declares no
  key learns the key fields from the schema that is traversed while
  the link to the array is resolved. And an element of a plain array
  generated from scratch, which a `lift` or a `computed` returns
  whole, has a reference by key as an element of a stored array of
  plain values has, where the owner accepts a copy if the reference
  proves complex to build for little gain. Four more things are ruled,
  for a plain array generated from scratch and for the result of another
  per-element construct over an array with a declared key. Such an array
  that is given whole to an instance of its own is given as a link to
  the stored output with the schema of the array, so the key fields are
  carried forward and the argument does not hold the values. The type of
  a `map` result keeps the key of its receiver, as the type of a
  `filter` result does. An array that a `lift` or a `computed` of an
  element body returns whole gives its elements the reference by key as
  well, and a link to one of them reads the current value. And the
  salted hash is of the record of the salt and the value. One known
  limit is recorded: an array below a value that a function body
  returns, or one that the reactive tier writes, gives its elements no
  reference by key for now. Thirteen things about a declared key are
  assumed. Eight are about the declaration and the
  form of the key: each field is a required top-level property of
  type `string` or `number`, with a key field that holds a reference
  deferred; the schema keyword is named `keyFields`; an array whose
  type declares one key is not accepted where the compiler sees that
  another key is declared; the names of the members of the records
  that a key and a name are; a reader whose type declares no key
  forms keys from the whole value where it meets no schema with the
  keyword; an array whose type declares no key is accepted where
  a key is declared; a reader whose type declares no key and that is
  compiled in is given the key fields by the compiler, and the result of
  another per-element construct that is given whole to an instance of
  its own is given as the assembled values; and the type of a `flatMap`
  result declares no key ([plan format and label
  templates](plan-and-label-templates.md), §8, questions 138, 139, 141,
  144, 145, 147, 149 and 150; the names of the two
  diagnostics are question 44 of
  [language subset](language-subset.md), §13). The other five
  follow. Over an array of
  plain values in place with no declared
  key, an instance called through `asInstance()` is re-keyed with its
  element when a write through a reference by key changes the value;
  over an array of references no edit changes a key, and a declared
  key avoids the case
  ([plan format and label templates](plan-and-label-templates.md), §8,
  question 123). By ruling an `asInstance()` instance that such a
  re-key replaces under the new key stays in the store, and a link
  stored elsewhere keeps reading it; an instance that a `lift` or a
  `computed` of the body made and that is replaced is assumed to be
  removed (its question 146). A write to the key field itself is the
  same re-key (its question 129). A plain value of a keyed array that a function
  body pushes to another list is stored in a document whose identity does not
  derive from the key
  ([execution and storage](execution-and-storage.md), §11, question
  93). And the declaration written on an array of references is accepted
  and has no effect
  ([language subset](language-subset.md), §13, question 43).
- **Element bodies and equal elements.** The rulings leave five things
  open ([plan format and label templates](plan-and-label-templates.md),
  §8, questions 36, 90, 101, 105, and 111). By ruling each says
  which case
  of a source it is about: an array of references, an array of plain
  values in place, or the result of another per-element construct
  (§1.3 there). Which state an occurrence has depends on which equal
  elements stand before it, and a reader of the row can see that:
  assumed accepted, for an array of references and an array of plain
  values in place alike; an element of the result of another
  per-element construct has its upstream key, so it depends on the
  equal elements of the first source. Whether a binding that a `lift`
  or a `computed` written in an element body makes has a stream per
  occurrence: assumed not, in all three cases, as a binding made in a
  function body is named by what it holds. Which key an element of a
  `flatMap` segment has where the segment is itself the result of
  another per-element construct: assumed the key the member has in
  that result. By ruling a member of any other segment is keyed by
  the member itself, a reference by its cell identity and a plain
  value by its value, with its count in the segment and the key of
  its source element. And what it means that
  the causes of what an element body holds are computed as they were
  in the runtime of today: assumed the same inputs and structure of
  derivation, not equal identifiers. And whether an output that is
  the result of another per-element construct on some evaluations
  only keeps that collection's keys: assumed not, so it is keyed by
  what its positions hold.
- **Where a stream is stored.** By ruling value code places a stream
  and no record of the plan names the position. Two things are
  assumed, each the same over an array of references, over an array
  of plain values in place, and over the result of another
  per-element construct
  ([plan format and label templates](plan-and-label-templates.md),
  §8, questions 135 and 136): the label of a position that holds a
  stream is what the rules for the stored value give, with nothing
  added for the stream; and a binding exists by its record and its
  enclosing element keys, whether or not a stored value holds its
  stream.
- **Which default is read.** The default declared nearest the end of
  the chain of places a read resolves through is read, by ruling. Two
  cases are assumed
  ([plan format and label templates](plan-and-label-templates.md), §8,
  questions 103 and 104): an absent property reads the same default in
  a read of an object whole as in a selection of it, and a stored
  `undefined` reads as an absent value does, with no default written
  into an argument document when an instance is set up. For a pattern
  compiled into another, the entry of `Body.reads` holds the callee's
  default for a sandboxed body, and a reference the callee passes on
  carries it, by ruling; where a handler's binding holds it, and that
  every reference the callee stores carries it, are assumed (question
  110 there).
- **An explicit cause in a handler.** A later event that instantiates
  under a cause an earlier event gave creates nothing. Whether it writes
  the argument it passes is open. *Assumed:* it does not
  ([plan format and label templates](plan-and-label-templates.md), §8,
  question 39).
- **The instance of a tool call.** How the instance a language model's
  tool call makes is identified, in which space and scope it is made, and
  when it is torn down are assumptions
  ([built-in inventory](builtin-inventory.md), open question 6).
- **Cache promotion.** The cost model for promoting a cone to a durable cache,
  and where that cache lives. A model and a cache document per instance and
  scope key are proposed ([execution and storage](execution-and-storage.md),
  §8). The model's constants are placeholders until stage 4 measures them.
- **Migration.** Whether anything besides state cells in existing stored
  instances has to keep its identifier, and when per-node documents already
  stored can be deleted. That a space is switched as a whole is ruled, and
  a procedure is proposed
  ([execution and storage](execution-and-storage.md), §9). Open with it,
  each with an assumption in that document's §11.1, are what happens to
  settled effect results, how long retired documents are kept, what
  starts a switch, what becomes of a space that holds an instance whose
  stored source the compiler refuses (assumed: the space is not switched,
  questions 4 and 70 there), whether a switch can be reversed, what
  happens to events across a switch, and what a link between a switched
  space and one that is not carries (§9.9 there;
  [scheduler and serving loop](scheduler-and-serving-loop.md), §10.8).
- **Logs.** `console` is in the standard-library surface, and a function
  body can pass it labeled data. Footprint analysis counts the arguments as
  read ([footprint analysis](footprint-analysis.md), §3.4). Whether the
  sandbox lets labeled data reach a log is not decided.
