# Compiled pattern language (proposed)

**Status:** proposed design direction. Nothing here is implemented. The
decisions the design still depends on are listed under
[Open questions](#open-questions), and the parts that change what Contextual
Flow Control (CFC) decides go through the specification first, as
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
one transaction per cause (an event, or an external change), evaluates only
the outputs something demands, stores only the outputs something outside the
pattern instance can reach, and instantiates label templates only for what it
stores: those outputs, the targets of side-writes, the arguments of child
instances, and effect requests.

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
output path instead of one label for the whole result.

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
further. The less often it gives up the more precise the labels are, so the
analysis is worth investing in, and a diagnostic can tell the author which
expression caused a widening.

Inside a function body the reactive constructs do not exist. `?:` and
`Array.prototype.map` are ordinary JavaScript there.

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
property is a language rule the compiler checks and reports on, and the
compiler emits the freezing wrappers.

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
    const total = computed(() => sum(prices.map((p) => p.price)));
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

`prices` and `total` are returned, so they are kept outputs: path entries of
the result document. `glazed` is interim and is not stored, no element of
either list has a document of its own, and `d.name` never taints `total`.

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
runs on it.

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
  subtree.
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
  body's footprint and of what the body read dynamically through the cell
  handles it was given. A reference the body passes on unchanged keeps its
  own label ([plan format and label templates](plan-and-label-templates.md),
  §3.9).

Instantiating a template means substituting actual labels for slots and
combining them. The runtime does this only for what it stores: kept outputs,
the targets of side-writes, the arguments of child instances, and effect
requests. It does so only when a slot's label changed, or one of the three
choices above did. A change of value alone does no label work. With labels
held by content address
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

A cause is an event delivered to a handler, a change arriving from storage, or
the completion of an effect. The runtime opens one transaction per cause,
evaluates what the cause invalidated and something demands, and commits the
state the handler wrote and the kept outputs that changed, with their labels.
A label constraint that fails rejects the cause's whole transaction. A cone
that fails, for example because the body of a `lift` or a `computed` throws,
does not: its outputs take an error state with a label, and the rest of the
transaction commits. A handler body that throws aborts its event's
transaction, as it does today
([plan format and label templates](plan-and-label-templates.md), §5).

### Pull and dependency cones

Evaluation is demand-driven. The compiler partitions the pattern body into
**dependency cones**. Every value the instance computes is computed by exactly
one cone, a cone can compute several outputs, and a cone that uses a value
another cone computes has an edge from that cone
([execution and storage](execution-and-storage.md), §2.1). A pull of an output
evaluates the cone that computes it, with the cones that cone depends on
where they are not current, and nothing else, for the value and for the
label.

- An output passed to another pattern is a link. When the consumer is pulled,
  the pull extends through the link into the cone of the producing instance
  that computes that path.
- A `map` element is a cone with a key. The key is the element's value when
  the element is a plain value, and the identity of the element's cell when
  it is not. Elements that move keep their cones, so reordering a list does
  not recompute it. The element's index is part of the key only when the
  callback uses the index, since such a cone cannot move. A key that enters
  a document identifier is first salted with a secret of the space, so that
  an identifier does not reveal that two confidential values are equal.
- Equal plain values have one key and so share one cone. A body over plain
  values that declares a state cell or binds a handler without using the
  index is therefore refused: the two rows would share that state.
- A change to one element dirties that element's cone. A membership change
  dirties the container.

Within an instance the order of evaluation is static, so the runtime does not
discover read sets or sort nodes for it at run time. Dynamic read tracking
remains for link hops through data, whose targets are not known statically,
and for some of the reads a function body makes through a cell handle it was
given: such a read is static when it goes through one handle whose position
in the body's inputs is known, at a static path, and unconditionally, and it
is dynamic otherwise ([footprint analysis](footprint-analysis.md), §7.2).
Where footprint analysis gives up it widens a static slot, and no dynamic
tracking is involved.

### Computations that write

A computation may write through a cell passed to it, and the write tiers of
[Scheduler v2](../scheduler-v2/README.md) (§4.3) carry over.

- **Primary output and static side-write targets** are part of the compiled
  instance. A static side-write target is one more output edge of the cone
  that writes it. Its label is that cone's template, and the write-floor
  checks apply to it.
- **Materializers**, whose write targets are dynamic or too broad to predict,
  are scheduled outside the compiled instance with their own transactions and
  the rules they have today: standing demand, idle priority, and promotion
  when a reader touches the declared envelope.

A more precise write-path analysis turns more materializers into computations
with static targets, which removes them from eager scheduling.

Side-writes mean a pattern instance is not acyclic by construction. A
side-write to a cell an earlier cone read dirties that cone again. The
compiler reports the cycles it can see statically, and the bounded-iteration
rule of the scheduler (P7) applies to the rest, inside the cause's
transaction. The idempotency contract and its validator apply to every body
that writes.

## What is stored

### The keep set

An **instantiated** pattern is one whose result cell was explicitly assigned.
The keep set of an instance is everything reachable from that result cell.
Reachable derived values are stored with their labels, because readers
elsewhere cannot recompute them. The rendered tree under `[UI]` is part of
the result, so a value bound into it is kept, as a path entry of the result
document and not as a document of its own. Nothing reaches a value inside an
instance except through the result cell.

A pattern used inside another, such as the body of a `map` or an inline
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
cell is assigned to (the `.for(...)` cause it emits). A state cell declared
directly in the pattern body keeps the identifier it has today. One declared
inside a sub-pattern that is compiled into the surrounding instance has a new
identifier, and its stored value is found through a carry-over record. One
declared inside a `map` body is not carried over: its identifier includes the
element key, which this design redefines
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
- Effect results, and the fold state of aggregates over collections, are
  always stored.
- The runtime measures the recomputation cost of each cone and how often it is
  pulled, and promotes a cone to a durable cache when recomputing costs more
  than storing. An author annotation can force or forbid the promotion.

## Built-ins and factories

The [built-in inventory](builtin-inventory.md) places each built-in and
factory in one of four classes, A to D, and states its label rule. Two of the
classes hold what remains an operation at run time.

- **Structural operations** (class A) become compiler operations with label
  rules: `ifElse`, `when`, `unless`, `map`, `filter`, `flatMap`, the
  aggregates, the collection-index family, `str`, `anchorsOf`,
  `inspectConfLabel`, and `wish`. Authors write the reactive constructs of
  the language, and `mapWithPattern`, which the transformer generates today,
  has no counterpart. The callable forms `ifElse`, `when`, `unless`, and the
  `str` tag are removed, so that no new pattern is written in the old way.
  The compiler accepts them for an interim period, with a warning that names
  the replacement, only as long as doing so costs it nothing beyond mapping
  each to the same operation as `?:`, `&&`, `||`, and a template literal.
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
  (`grantSpaceAccess`, `revokeSpaceAccess`, and `nameBlob`). `cellFromUrl`
  splits: parsing an address is structural, and resolving a space name or
  host is effectful.

The other two classes are the authoring markers (class C), such as `pattern`,
`handler`, and `computed`, which stay in the language as syntax the compiler
recognizes, and the removed forms (class D), which have no counterpart, among
them `streamData`, `llm`, and every form the transformer emits.

Inside a function body, five kinds of runtime call remain:

- instantiating a pattern;
- creating a cell, which receives a causal identifier;
- requesting an effectful built-in, which behaves like instantiating a
  built-in pattern. Only a `handler` or an `action` may do this. A `lift` or
  a `computed` may not, and since it does not instantiate a pattern either,
  it has no indirect way to. An effect that depends on computed data is
  requested in the reactive tier, with the computed value as its input;
- reading context that is not a cell: the event's key and acting principal,
  a space's identity and access list, and the principals a label attests;
- binding a handler to the values it captures, which yields a stream. An
  inline event handler in JSX built by a function body is such a binding
  ([language subset](language-subset.md), §5.2).

A function body that needs reactivity instantiates a pattern. A handler that
wants a reactive mapped list, for example, wraps the list in a pattern.

Each handler invocation is a new frame, so the cells and instances it creates
are new on every call and are identified by the event and their order within
the invocation. A handler binding is the exception: it is identified by the
enclosing instance, the handler, and what it captures
([plan format and label templates](plan-and-label-templates.md), §1.3).
Pattern bodies and lifts are re-evaluated, so their cells need identifiers
that are the same on every evaluation.

### Instantiating a pattern from a function body

Instantiation is an effect, not graph construction in JavaScript. The syntax
stays a call, `DonutCard({ donut })`, and the callee must be one of:

- a pattern imported by name;
- an inline `pattern(...)` expression, which the compiler hoists, turning its
  captures into private parameters. In the reactive tier such an expression
  may also be used as a value, a pattern closure, which is what replaces
  `patternTool` ([language subset](language-subset.md), §4.4.2);
- a pattern received as a factory value
  ([first-class serializable factories](../pattern-construction/node-factory-shipping.md)).

A callee may carry the modifiers `asScope(scope)` and
`inSpace(space, options)`. A function body may call two kinds of factory
value: a pattern factory, which it instantiates, and a handler factory, which
it binds to state to obtain a stream. A handler received by reference is
resolved at run time like a pattern received by reference: its own compiled
record supplies its footprint, its write edges, and the identity that write
policies name. A `lift` result is not a factory value.

In a handler, the call records an instantiation request with a causal
identifier and returns a link. The runtime performs the instantiation when the
handler's transaction commits. Writing the link into state is what gives the
new instance a result cell and makes it an instantiated pattern. Passing the
link to `navigateTo` does the same, because navigation requires a result
cell. In the reactive tier the same call, with a callee the compiler can
resolve statically, denotes an anonymous sub-pattern, compiled into the
surrounding instance like the body of a `map`. A callee that is a factory
value is known only at run time, so the call creates a child instance with
its own plan and result cell
([plan format and label templates](plan-and-label-templates.md), §3.15).

The body of a `computed` or a `lift` does not instantiate a pattern.
Selecting among patterns is done in the reactive tier.

## The scheduler

The compiled instance takes over the work the scheduler does inside a pattern
today, for cones whose write surface is static:

- the node registry and the per-node record;
- read-set discovery from transaction journals and the diffing of read sets;
- ordering nodes within a pass;
- trigger-read bookkeeping for statically known reads, because a template's
  slot set already contains every such input that can cause a recomputation.

Trigger reads stay for reads that follow links through data. Their targets
are not in any template, so a recomputation caused by a change behind a link
has to join that address's label the way it does today.

A scheduler remains across instances. Its units are pattern instances,
effectful operations, and materializers, and its edges are links between kept
outputs. It keeps five responsibilities:

- turning the storage change channel, including remote writes, into dirty
  slots;
- tracking demand, which is held on kept outputs per path, so that an output
  nothing observes is not evaluated
  ([scheduler and serving loop](scheduler-and-serving-loop.md), §4.1 and
  §4.2);
- serializing the event queue;
- running effects, with their time gates and retries;
- following links across spaces.

Convergence bounds apply at this level and, because of side-writes, at cone
level inside an instance. A handler's read closure is static, so the cones a
handler reads can be evaluated inside the handler's own transaction.

## Server execution and client speculation

Execution is authoritative on the server
([server-primary execution](../server-side-execution/README.md)), and the
compiler runs there. The remaining scheduler is a natural part of the serving
loop ([serving loop](../server-side-execution/serving-loop.md)).

Clients run the same compiled artifact speculatively to render with low
latency, and send events to the server
([speculation](../server-side-execution/speculation.md)). A client fetches the
value code and the plan and does not compile. Effectful operations are not
speculated.

Speculative values that reach the render boundary need labels. A client
reuses the last committed label of an output while the slots of its template
are unchanged, and instantiates the template locally otherwise.

A client also evaluates the gates it can from the plan and the data it holds,
so that it does not show a result it can tell the server is going to refuse.
It cannot evaluate every gate: the egress ceiling of an effect a handler
requests, for example, depends on sink ceilings that are server
configuration. The table of which gates a client can evaluate is in
[scheduler and serving loop](scheduler-and-serving-loop.md), §11.3. FabriChat
is the reference case: the pattern declares that a message is added only when
the send event comes from a trusted UI element. A send from an element
without that integrity is refused by the server, so the client's speculative
run of the handler refuses it too, from the same plan. The client's verdict
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
   Template labels must be equal or tighter, with one deliberate exception:
   the membership label of a collection index bucket is wider, because it
   includes the keys of absent elements
   ([plan format and label templates](plan-and-label-templates.md), §3.17).
4. Run one pattern with one transaction per cause and with only its keep set
   stored. Then do the same for `map`. FabriChat is the reference pattern for
   this stage and the previous one, because it exercises event integrity,
   write policy, and per-row instances together.
5. Move the remaining scheduler into the serving loop.
6. Retire the builder form the transformer emits.

## Detailed specifications

The documents beside this one specify the parts of the design in detail. This
document stays the overview, and where a detailed document and this one
disagree, the detailed document governs and this one is corrected.

- [Language subset](language-subset.md): grammar, type rules, and diagnostics
- [Plan format and label templates](plan-and-label-templates.md): slots,
  observation classes, and the label rule of each operation
- [Built-in inventory](builtin-inventory.md): each built-in's class, label
  rule, and durable state
- [Footprint analysis](footprint-analysis.md): the abstract domain over a
  function body, where the analysis widens, the write side, and reads through
  cell handles
- [Execution and storage](execution-and-storage.md): the transaction of one
  cause for one instance, the layout of a result document, causal
  identifiers, cache promotion, and migration
- [Scheduler and serving loop](scheduler-and-serving-loop.md): what remains
  of the scheduler across instances, effects, links across spaces, and
  client speculation

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
  stays termination-insensitive is listed there: divergence inside a body's
  budget, demand, and the rejection of a cause's transaction.
- **Commits that span spaces.** A transaction covers one space. A staged
  access change and an `inSpace` instantiation both reach another space
  ([built-in inventory](builtin-inventory.md), open question 3). The proposal
  is one ordered sequence that serves both: access changes first, then the
  writes to other spaces, then the writes to the home space, without
  atomicity ([scheduler and serving loop](scheduler-and-serving-loop.md),
  §9.4). Whether that sequence is accepted, or an atomic commit across spaces
  is required, is not ruled on.
- **Cycles through side-writes.** How much the compiler can reject statically,
  and what the iteration bound inside a cause's transaction is. The proposed
  bound is ten evaluations of a cone per transaction, after which the cone
  fails ([execution and storage](execution-and-storage.md), §2.7;
  [scheduler and serving loop](scheduler-and-serving-loop.md), §8.1). The
  number is not ruled on and needs measurement on the corpus.
- **Cache promotion.** The cost model for promoting a cone to a durable cache,
  and where that cache lives. A model and a cache document per instance and
  scope key are proposed ([execution and storage](execution-and-storage.md),
  §8). The model's constants are placeholders until stage 4 measures them.
- **Migration.** Whether anything besides state cells in existing stored
  instances has to keep its identifier, and when per-node documents already
  stored can be deleted. A procedure is proposed
  ([execution and storage](execution-and-storage.md), §9). Open with it are
  what happens to settled effect results, how long retired documents are
  kept, and what becomes of an instance whose stored source the compiler
  refuses.
