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
  computes values and nothing else.
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
  collection is its own slot.
- **Conditionals:** the template of a conditional is the condition's slots
  plus the slots of the branch that was selected. A template depends on a
  value in three places: the branch a conditional selected, the prefix at
  which a `findIndex`, `some`, `every`, or `find` stopped, and the child that
  a dynamic key, a `minBy`, a `maxBy`, or a keyed lookup chose
  ([plan format and label templates](plan-and-label-templates.md), §3.13 and
  §3.18).
- **Sandboxed calls:** the output's template is the union of the slots in the
  body's footprint, of the templates of the computed values the body
  observes, and of what the body read dynamically through the cell handles
  it was given. A reference the body passes on unchanged keeps its own label
  ([plan format and label templates](plan-and-label-templates.md), §3.9).

A template label is equal to the label the runtime computes today or tighter,
with two deliberate exceptions
([plan format and label templates](plan-and-label-templates.md), §3.1).

- The membership label of a collection index bucket is wider, because it
  includes the keys of the elements that are not in the bucket (§3.17 there).
- A read through a cell handle is a static slot when every run of the body
  that returns normally makes it. A run that throws before the read carries
  the read's label all the same, where today its transaction does not (§3.9
  there).

A third difference in that direction is assumed and not ruled on. What is
stored once per element key, such as an effect's request, a side-write, or a
child's argument, carries the join over the positions that hold equal plain
values, where today each occurrence has a run of its own
([continuation plan](../../plans/compiled-pattern-language.md), question 40).

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
and, inside the body of an element construct, one element key.

- An output passed to another pattern is a link. When the consumer is pulled,
  the pull extends through the link into the cone of the producing instance
  that computes that path. That holds within one space. A consumer in
  another space reads the producer's kept output as stored
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §9.2).
- The body of an element construct, such as the callback of a `map`, is one
  or more cones, and they are evaluated once per element key
  ([execution and storage](execution-and-storage.md), §2.1 and §2.5). The
  key is the element's value when the element is a plain value, and the
  identity of the element's cell when it is not. An element that moves keeps
  what was evaluated for its key, so reordering a list does not recompute
  it. The element's index is part of the key only when the callback uses the
  index, and a body that uses it is evaluated again for an element that
  moves. A key derived from a value is salted with a secret of the space
  before it enters a document identifier, so that an identifier does not
  reveal the value.
- Equal plain values have one key and so share one evaluation. They share
  the value and not the label: each position has the label of the address
  its element was read from. A body over plain values that declares a state
  cell or binds a handler without using the index is refused, because the
  two rows would share that state.
- A change to one element dirties that element's cones. A membership change
  dirties the container.

Within an instance the order of evaluation is static, so the runtime does not
discover read sets or sort nodes for it at run time. Dynamic read tracking
remains for link hops through data, whose targets are not known statically,
and for some of the reads a function body makes through a cell handle it was
given. Such a read is static when it goes through one handle whose position
in the body's inputs is known, at a static path, and every run of the body
that returns normally makes it. It is dynamic otherwise
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
- **Materializers**, whose write targets are dynamic or too broad to predict,
  are scheduled outside the compiled instance with their own transactions and
  the rules they have today: standing demand, idle priority, and promotion
  when a reader touches the declared envelope. Where a materializer cannot
  be promoted for a handler that reads inside its envelope, the event waits:
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
subtrees are split off by a rule about size. A reader names the result cell
and a path, whichever document stores the path, and a split changes no value
and no label. One evaluation writes every document it changed in one
transaction. [Execution and storage](execution-and-storage.md) §4.10 owns the
rule, and [plan format and label templates](plan-and-label-templates.md)
§2.3 says what a split has to preserve.

A pattern compiled into another, such as the body of a `map` or an inline
sub-pattern, is not instantiated in this sense. It has no result cell and no
pattern metadata. If all its outputs are consumed by further computation it
has no stored state at all.

### State cells

State that handlers write is stored in documents whose identifiers derive from
the cause of their creation, not from their content: the parent instance, the
compiled-in calls and element bodies that enclose the declaration, and the
cell's name. Two independent executions arrive at the same identifier even
when they start from slightly different data. Such a document is written when
it is first assigned. It carries no pattern reference and no manifest, and it
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
carry-over record. The record is an assumption with a limit: writing it
needs the builder form, so an instance migrated after stage 6 loses that
state ([continuation plan](../../plans/compiled-pattern-language.md),
question 27). One declared inside a `map` body is not carried over: its
identifier includes the element key, which this design redefines
([execution and storage](execution-and-storage.md), §5.7 and §9). Migrating an
instance is a procedure that document proposes: one setup transaction that
replaces the stored layout with the compiled one.

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
  `lift` or a `computed` has an indirect way: a pattern it instantiates may
  request effects in its own body. That a `lift` or a `computed` does not
  request an effect itself is an assumption, which the
  [continuation plan](../../plans/compiled-pattern-language.md) lists as
  question 38. An effect that depends on computed data is written in a
  pattern the computation instantiates, or in the reactive tier with the
  computed value as its input;
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
([plan format and label templates](plan-and-label-templates.md), §1.3). One
exception is assumed: what a handler creates with `.for(tag)` is identified
by the handler's instance and the tag, so that different events name the
same thing
([continuation plan](../../plans/compiled-pattern-language.md), question 19).
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
  `patternTool` ([language subset](language-subset.md), §4.4.2);
- a pattern received as a factory value
  ([first-class serializable factories](../pattern-construction/node-factory-shipping.md)).

A callee may carry the modifiers `asScope(scope)` and
`inSpace(space, options)`. The identifier of an instance an `inSpace` request
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
- Two things are assumed, as question 38 of the
  [continuation plan](../../plans/compiled-pattern-language.md) states them.
  The instance is identified by the enclosing instance, the body's `name`
  and `within`, the site of the call, and the ordinal of the
  instantiation among those the evaluation makes at that site. Where the
  author writes `.for(cause)`, that cause takes the place of the ordinal
  ([plan format and label templates](plan-and-label-templates.md), §1.3).
  And the computation does not request an effect directly.

In the reactive tier the same call, with a callee the compiler can resolve
statically, denotes an anonymous sub-pattern, compiled into the surrounding
instance like the body of a `map`. A callee that is a factory value is known
only at run time, so the call creates a child instance with its own plan and
result cell
([plan format and label templates](plan-and-label-templates.md), §3.15).

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
   Template labels must be equal or tighter, with the two deliberate
   exceptions listed under [Label templates](#label-templates): the
   membership label of a collection index bucket, and a static read through
   a cell handle on a run that throws before the read
   ([plan format and label templates](plan-and-label-templates.md), §3.1).
   The comparison expects these two differences and no other in that
   direction, apart from the assumed one that question 40 of the
   [continuation plan](../../plans/compiled-pattern-language.md) describes.
4. Run one pattern with one transaction per cause and with only its keep set
   stored. Then do the same for `map`. FabriChat is the reference pattern for
   this stage and the previous one, because it exercises event integrity,
   write policy, and per-row instances together. This stage measures two
   sets of placeholder numbers in
   [execution and storage](execution-and-storage.md): the sizes at which a
   kept subtree becomes a part document (§4.10), and the constants of cache
   promotion (§8).
5. Move the remaining scheduler into the serving loop.
6. Retire the builder form the transformer emits.

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
  Open are the number, which needs measurement on the corpus, and whether a
  cycle that spans several transactions is bounded at all: an effect whose
  completion changes its own request, and a cycle across two spaces
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §8.4).
- **Instances a computation makes.** A `lift` or a `computed` may
  instantiate a pattern. How such an instance is identified, and that the
  computation does not request an effect directly, are assumptions
  ([continuation plan](../../plans/compiled-pattern-language.md), question
  38).
- **Cache promotion.** The cost model for promoting a cone to a durable cache,
  and where that cache lives. A model and a cache document per instance and
  scope key are proposed ([execution and storage](execution-and-storage.md),
  §8). The model's constants are placeholders until stage 4 measures them.
- **Migration.** Whether anything besides state cells in existing stored
  instances has to keep its identifier, and when per-node documents already
  stored can be deleted. A procedure is proposed
  ([execution and storage](execution-and-storage.md), §9). Open with it are
  what happens to settled effect results, how long retired documents are
  kept, what becomes of an instance whose stored source the compiler
  refuses, and whether one serving runtime runs compiled instances and
  instances that are not migrated in one space
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §10.8).
- **Logs.** `console` is in the standard-library surface, and a function
  body can pass it labeled data. Footprint analysis counts the arguments as
  read ([footprint analysis](footprint-analysis.md), §3.4). Whether the
  sandbox lets labeled data reach a log is not decided.
