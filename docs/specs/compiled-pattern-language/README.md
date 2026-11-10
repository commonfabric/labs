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
pattern instance can reach, and instantiates label templates for those stored
outputs alone.

## The language

The language is valid TypeScript, so editors and existing tools keep working.
The pattern compiler has its own parser front end and its own type checker for
the subset. It has three tiers.

### Reactive expressions

The pattern body. It is first-order and has no loops, no reassignment, and no
function creation other than the callbacks of the constructs below. Conditional
expressions (`?:`, `&&`, `||`), property access, object and array construction,
and the array methods `map`, `filter`, and `flatMap` are reactive constructs
here, and the compiler lowers each to an operation with a known label rule.

A `computed` whose body is a pure expression over its captures is promoted to
this tier. It then costs no sandboxed call, and its result gets a label per
output path instead of one label for the whole result.

### Function bodies

The bodies of `lift`, `handler`, `computed`, and `action` are full JavaScript
and run in the sandbox. The compiler parses them and type-checks them in the
subset, and performs **footprint analysis** on them: for each input path,
whether the body reads the value, the shape, the enumeration, or only the
identity, and which paths it writes. The footprint narrows the schema each
body is invoked with, which is what keeps a body from being tainted by, or
gaining access to, data it never touches.

Footprint analysis is allowed to give up. When it loses track of a value it
widens the footprint to the whole subtree that value came from, and no
further. The less often it gives up the more precise the labels are, so the
analysis is worth investing in, and a diagnostic can tell the author which
expression caused a widening.

Inside a function body the reactive constructs do not exist. `?:` and
`Array.prototype.map` are ordinary JavaScript there.

### Imported TypeScript

A module outside the subset can be imported for functions whose types the
subset cannot express. The compiler reads only the annotated signature of each
imported function, does not analyze the body, and treats every argument as
read in full.

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

No per-element document exists for `glazed` or `prices` unless something
outside the instance reads them, and `d.name` never taints `total`.

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

Because the compiler is trusted, a runtime either compiles from source itself
or accepts a compiled artifact from a party it already trusts to execute the
pattern.

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
observation class (value, shape, enumeration, or identity).

- **Objects:** slots follow the paths the footprint analysis found. A subtree
  the analysis could not resolve is one slot, standing for the join over the
  subtree.
- **Arrays:** the body of a `map` is compiled once against an element slot,
  so there is one template per body, not per element. Membership of the
  collection is its own slot.
- **Conditionals:** the template of a conditional is the condition's slots
  plus the slots of the branch that was selected. This is the one place a
  template depends on a value.
- **Sandboxed calls:** the output's template is the union of the slots in the
  body's footprint.

Instantiating a template means substituting actual labels for slots and
combining them. The runtime does this only for outputs it stores, and only
when a slot's label or a selected branch changed. A change of value alone does
no label work. With labels held by content address
([content-addressed CFC labels](../content-addressed-cfc-labels.md)), an
instantiation is a union of identifiers and can be memoized by template and
input label identifiers.

Constraints such as required integrity and maximum confidentiality become
constraints on slots. Where the labels of the slots are declared in schemas the
compiler checks the constraint and reports a violation as a compile error.
Otherwise the check runs when the template is instantiated.

## Execution

### One transaction per cause

A cause is an event delivered to a handler, a change arriving from storage, or
the completion of an effect. The runtime opens one transaction per cause,
evaluates what the cause invalidated and something demands, and commits the
state the handler wrote and the kept outputs that changed, with their labels.

### Pull and dependency cones

Evaluation is demand-driven. Each output path has a **dependency cone**: the
part of the pattern that path's value depends on. A pull of an output
evaluates its cone and nothing else, for the value and for the label.

- An output passed to another pattern is a link. When the consumer is pulled,
  the pull extends through the link into the producing instance's cone for
  that path.
- A `map` element is a cone keyed by element identity. A change to one element
  dirties that element's cone. A membership change dirties the container.

Within an instance the order of evaluation is static, so the runtime does not
discover read sets or sort nodes for it at run time. Dynamic read tracking
remains for link hops through data, whose targets are not known statically,
and for function bodies where footprint analysis gave up.

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
elsewhere cannot recompute them. Nothing reaches a value inside an instance
except through the result cell.

A pattern used inside another, such as the body of a `map` or an inline
sub-pattern, is not instantiated in this sense. It has no result cell and no
pattern metadata. If all its outputs are consumed by further computation it
has no stored state at all.

### State cells

State that handlers write is stored in documents whose identifiers derive from
the cause of their creation, not from their content: the parent instance, the
element key where there is one, and the cell's name. Two independent
executions arrive at the same identifier even when they start from slightly
different data. Such a document is written when it is first assigned, and it
carries no pattern metadata.

The compiler derives these identifiers exactly as the transformer does, which
names a state cell after the variable it is assigned to (the `.for(...)` cause
it emits). Existing stored state then keeps its identifiers, and migrating an
instance consists of no longer writing its per-node documents.

### Provenance

A kept output carries a full provenance chain: its label template, the
identities of the inputs bound to the template's slots, and the identity of
the compiled pattern. Interim values that are not kept have no stored
provenance of their own.

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

Built-ins divide into two groups.

- **Structural operations** become compiler operations with label rules:
  `ifElse`, `when`, `unless`, `map`, `filter`, `flatMap`, the aggregates, the
  collection-index family, and `str`. They stop being callable factories.
  Authors write the reactive constructs of the language, and
  `mapWithPattern`, which the transformer generates today, has no counterpart.
- **Effectful operations** stay durable boundaries with declared label rules
  and their own transactions: the fetch family, `streamData`, the language
  model built-ins, the SQLite built-ins, `wish`, `navigateTo`,
  `compileAndRun`, and `cellFromUrl`.

Each built-in needs to be placed in one of the two groups by reading its
semantics, which this document has not done one by one.

Inside a function body, four kinds of runtime call remain:

- instantiating a pattern;
- creating a cell, which receives a causal identifier;
- requesting an effectful built-in, which behaves like instantiating a
  built-in pattern;
- binding a handler to the values it captures, which yields a stream. An
  inline event handler in JSX built by a function body is such a binding
  ([language subset](language-subset.md), §5.2).

A function body that needs reactivity instantiates a pattern. A handler that
wants a reactive mapped list, for example, wraps the list in a pattern.

### Instantiating a pattern from a function body

Instantiation is an effect, not graph construction in JavaScript. The syntax
stays a call, `DonutCard({ donut })`, and the callee must be one of:

- a pattern imported by name;
- an inline `pattern(...)` expression, which the compiler hoists, turning its
  captures into parameters;
- a pattern received as a factory value
  ([first-class serializable factories](../pattern-construction/node-factory-shipping.md)).

In a handler, the call records an instantiation request with a causal
identifier and returns a link. The runtime performs the instantiation when the
handler's transaction commits. Writing the link into state is what gives the
new instance a result cell and makes it an instantiated pattern. In the
reactive tier the same call denotes an anonymous sub-pattern, compiled into
the surrounding instance like the body of a `map`.

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
- tracking which instances are demanded, so that unobserved ones do not run;
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

A client also evaluates the gates the server will evaluate, so that it does
not show a result the server is going to refuse. FabriChat is the reference
case: the pattern declares that a message is added only when the send event
comes from a trusted UI element. A send from an element without that
integrity is refused by the server, so the client's speculative run of the
handler refuses it too, from the same plan. The client's verdict is advisory
and the server's is authoritative.

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
  lowering logic and fixtures in TypeScript, and editor diagnostics need a
  path of their own, such as a language-server plugin that runs the compiler.

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
   Template labels must be equal or tighter, and never looser.
4. Run one pattern with one transaction per cause and with only its keep set
   stored. Then do the same for `map`. FabriChat is the reference pattern for
   this stage and the previous one, because it exercises confidentiality,
   event integrity, and per-row instances together.
5. Move the remaining scheduler into the serving loop.
6. Retire the builder form the transformer emits.

## Detailed specifications

The documents beside this one specify the parts of the design in detail. This
document stays the overview, and where a detailed document and this one
disagree, the detailed document governs and this one is corrected.

- [Language subset](language-subset.md): grammar, type rules, and diagnostics
- [Plan format and label templates](plan-and-label-templates.md): slots,
  observation classes, and the label rule of each operation
- [Built-in inventory](builtin-inventory.md): each built-in's group, label
  rule, and durable state

## Open questions

- **Gates under speculation.** Which of the server's gates a client can
  evaluate from the plan alone, and how a client presents a refusal it
  predicts ([render-boundary composition](../cfc-render-boundary-composition.md)).
- **Error states and termination.** A function body that throws, or does not
  terminate, reveals something about its inputs. An error is a state with a
  label of its own, and a cone in an error state stops propagating unless
  something reads that state. The label rule for it, and how far the design
  is termination-sensitive, follow the specification's treatment of
  termination.
- **Built-in classification.** Which group each built-in belongs to, and the
  label rule of each structural operation.
- **Cycles through side-writes.** How much the compiler can reject statically,
  and what the iteration bound inside a cause's transaction is.
- **Factory values.** Which kinds of factory value a function body may call
  beyond patterns.
- **Cache promotion.** The cost model for promoting a cone to a durable cache,
  and where that cache lives.
- **Migration.** Whether anything besides state cells in existing stored
  instances has to keep its identifier, and when per-node documents already
  stored can be deleted.
