# TypeScript Transformers Lowering Contract

**Status:** Candidate v1 (normative semantic contract for current hardening phase)\
**Package:** `@commonfabric/ts-transformers`\
**Related:**

- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`

## 1. Purpose

This document defines the semantic obligations of the transformer system when it
does rewrite supported pattern-language constructs.

It is intentionally narrower than a full implementation spec. The point is to
state **what must be preserved**, not to freeze the current module layout or
pipeline internals.

For supported target-language constructs, this contract is the source of truth.
If current implementation behavior disagrees, fix the implementation or record
the divergence in descriptive docs rather than weakening the contract.

## 2. Contract Scope

This contract applies to lowering of supported reactive expression constructs,
especially:

- shared lowered value-expression sites (`jsx-expression`,
  `return-expression`, `variable-initializer`, `call-argument`,
  `object-property`, `array-element`)
- reactive control flow
- reactive collection operators
- property/element access over reactive values
- receiver-method and other supported call expressions
- wrapper introduction (`computed`, helper control-flow forms)
- callback capture and ownership lowering
- serializable factory values, modifier derivations, and invocation across eager
  graph-construction and scheduled execution boundaries

## 3. Semantic Invariants

## 3.1 Control-Flow Semantics Must Be Preserved

Lowering of `?:`, `&&`, `||`, and related helper-owned control flow must
preserve authored JavaScript meaning:

1. the same branch must be selected
2. the same short-circuit behavior must hold
3. the resulting value semantics must match authored code

In particular, the compiler must not silently replace value-level control flow
with truthiness of an opaque proxy/ref object.

## 3.2 Parentheses Must Not Change Reactive Meaning

Equivalent nested control-flow expressions must lower equivalently regardless of
superficial parenthesization.

If:

- `a ? b : c ? d : e`

and:

- `a ? b : (c ? d : e)`

mean the same thing as authored JS, they must not differ only because one shape
was rewritten structurally and the other was left raw.

## 3.3 Crossing Context Boundaries Must Be Explicit

An outer rewrite must not silently root-rewrite through a nested reactive
context boundary such as:

- `computed(...)`
- `action(...)`
- `handler(...)`
- rewritten collection callbacks

Nested callbacks may be traversed according to their own rules, but an outer
site must not rewrite them as though they were part of the same ownership
region.

## 3.4 Call-Target Shape Must Be Preserved

Lowering must not change call shape in a way that alters receiver binding or
callee evaluation order.

In particular, a rewrite must not transform:

- `obj[key](arg)`

into a semantically different shape like:

- `(someWrapper(obj[key]))(arg)`

unless that new shape is explicitly proven equivalent.

Whole-call wrapping is acceptable when it preserves authored callee semantics.

Optionality is part of that same obligation, not a separate call family. When
lowering a supported form such as `obj?.method(arg)`, `obj.method?.(arg)`, or a
combined chain, the lowered form must preserve:

1. single evaluation of the receiver and callee
2. the original receiver as `this`
3. the authored nullish short-circuit points
4. non-evaluation of call arguments when optional invocation short-circuits

The compiler should lower the whole call rather than extract a function-valued
member into reactive data.

Two boundaries of that obligation are deliberate:

- The four properties govern value evaluation inside the lowered computation.
  Reactive dependency subscription stays eager: capability analysis captures
  every dependency mentioned in the authored expression regardless of control
  flow, so a dependency that appears only after a short-circuit point (for
  example `state.suffix` in `value.replace?.("x", state.suffix)`) is still
  subscribed, and a change to it re-runs the computation even while the chain
  short-circuits. Short-circuiting constrains evaluation of the authored
  expression, not the dependency set — the same rule as the untaken branches
  of conditional and logical expressions.
- On total navigation into cell space, authored `?.` may be absorbed rather
  than preserved verbatim: `key(...)` navigation cannot throw on missing
  values, so an optional navigation step lowered to `key(...)` (for example
  `state.items?.[0]`, or the receiver path of `value.auth?.get?.()`) carries
  no residual short-circuit point, and reads of absent members yield
  `undefined` through the read itself. Value-space chains inside lowered
  closures keep their authored `?.` tokens verbatim.

## 3.5 Collection Operator Ownership Must Stay Coherent

For collection operators:

1. if a call is structurally owned and rewritten (for example to
   `mapWithPattern`), its callback becomes a pattern-like opaque callback
   boundary
2. if a call is not structurally rewritten, its callback stays ordinary JS for
   that context

The compiler must not accidentally mix these models for the same operator site.

For `groupBy` and `keyBy`, lowering must distinguish a selector's returned Cell
identity from a returned primitive value before serialization can erase that
distinction. Reading a primitive field to select a key establishes a dependency
on that field; selecting a Cell identity establishes no dependency on its stored
contents. Nullish selected keys omit the source occurrence. Key extraction and
membership publication retain the original source occurrence address.

## 3.6 Chain Ownership Must Be Single-Owner

Receiver chains must have one coherent owner:

1. **structural owner**
   - recurse structurally through the relevant operator/callback chain
2. **sink owner**
   - whole-wrap the chain as one reactive expression unit

The compiler should not partly whole-wrap and partly independently lower the
same chain in ways that make ownership reasoning ambiguous.

## 3.7 Captures Must Be Explicit And Minimal

When lowering introduces a wrapper callback:

1. all semantically relevant reactive dependencies must be captured
2. nested function-local or plain-array callback locals must not be captured by
   outer reactive wrappers
3. closure lowering must not leak callback-local bindings into outer wrapper
   scopes

This is a semantic requirement, not merely an output readability preference.

## 3.8 Dynamic Access Must Either Lower Safely Or Diagnose

Dynamic key access over reactive values is valid only when the compiler can
represent it safely.

So the compiler must do one of two things:

1. lower the minimal containing expression with correct captures and value
   semantics
2. emit a clear diagnostic that the construct is not lowerable in that context

Silent half-lowering is not acceptable.

## 3.9 Unsupported Constructs Must Fail Clearly

When the language boundary is exceeded, the compiler should prefer:

1. an explicit diagnostic

over:

2. leaving a construct in a semantically misleading partially lowered state

This is especially important for:

- wildcard traversal outside supported whole-call expression-root positions
- foreign callback-container roots in pattern-facing contexts
- eager `.get()` reads with no lowerable expression site to carry them, and
  eager reads on ordinary opaque values — a read on a true cell at a lowerable
  site lowers into a lift instead (target-language spec §5.7)
- imperative statement-boundary constructs in top-level pattern context

## 3.10 Phase Choice Is An Implementation Detail

Some constructs may be routed pre-closure and others post-closure, but that
phase choice is not itself part of the language contract.

The semantic contract is:

1. supported authored constructs should lower equivalently regardless of which
   internal phase owns them
2. phase boundaries should exist to preserve semantics and maintainability, not
   to create user-visible special cases

## 3.11 Factory Calls Follow Value Origin And Execution Boundary

Factory call lowering must use both:

1. the factory value's proven origin (`live`, `symbolic`, or
   `runtime-materialized`), and
2. the nearest decisive callback boundary.

Live and scheduled-materialized factories remain direct calls. Public factory
inputs and private factory captures in an eager pattern are symbolic and must
lower to an explicit runtime invocation node. A nested eager pattern inside
scheduled code re-establishes symbolic exposure; a non-decisive collection
callback must not erase its enclosing boundary.

## 3.12 Public Factory Input And Private Captures Stay Separate

A factory's public input/output schema is an executable contract and must not be
rewritten to include lexical closure state. Pattern closure conversion therefore
must preserve:

1. public input as callback argument 0
2. private captured params as callback argument 1
3. the private capture schema in compiler/runtime metadata
4. at most one private `.curry(params)` at a capturing site

Private curry state must never bind, default, or widen public input fields.

## 3.13 Factory Call Semantics Must Be Preserved

Whether a factory call stays direct or lowers to `invokeFactory`, the compiler
must preserve:

1. one evaluation of the callee and explicit input
2. authored evaluation order
3. receiver binding for live/materialized direct calls; symbolic calls select
   the same property/element factory value without treating artifact selection
   as JavaScript method dispatch
4. one public argument (with no synchronous tuple/rest spread read during eager
   graph construction)
5. result family: pattern/module → reactive value; handler → stream

`asScope()` and `inSpace()` derive factories and must not be mistaken for an
invocation.

## 3.14 Exact Public Contracts And Provenance Are Required

Serializable factory recognition requires trusted Common Fabric provenance or
an exact compiler-owned contract hint. A matching name or callable shape alone
is insufficient.

Every callable union arm must independently carry its authority. Invocation is
valid only when all arms have one factory kind, exactly equal normalized public
input/output schemas, and exactly equal FrameworkProvided paths. One arm's
provenance must not authorize another, and compiler-owned exact contracts take
precedence over reconstructed checker types.

## 3.15 Executable Factory Contracts Fail Closed

Ordinary schema inference may degrade predictably when a non-executable data
shape is unresolved. Factory invocation is the explicit exception: if origin,
execution exposure, factory kind, public contract, or FrameworkProvided
provenance cannot be proved, the compiler must diagnose instead of emitting a
guessed executable contract.

This fail-closed rule also applies to recursive nested factory contracts that
cannot be emitted as finite self-contained schema documents.

## 4. Non-Normative Implementation Interpretation

The current implementation realizes this contract through:

1. validation transformers
2. early JSX and factory routing
3. FrameworkProvided forwarding and symbolic invocation
4. computed/closure normalization
5. shared ownership-first lowering
6. shared expression-rewrite backend
7. final capability/schema/authority layers

But these layers are explanatory only. The contract above is the normative
piece.

## 5. Use This Contract

When evaluating a bug, refactor, or new construct, ask:

1. which invariant would be violated if this lowering were wrong?
2. is the construct part of the supported target language?
3. should the implementation be clarified, or should the construct be demoted
   out of the language?

That question ordering is deliberate:

- first the language
- then the semantic contract
- then the implementation
