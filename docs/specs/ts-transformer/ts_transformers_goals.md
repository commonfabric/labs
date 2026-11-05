# TS Transformers Goals

**Status:** Working goals (current understanding)\
**Date:** July 16, 2026\
**Package:** `@commonfabric/ts-transformers`\
**Related:**

- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
- `docs/specs/ts-transformer/ts_transformers_design_deltas.md`

## 1. Why This Package Exists

Pattern authors should be able to write natural TypeScript/JSX while the runtime
still receives explicit, structured dataflow artifacts needed for reactivity,
schema-driven execution, and policy enforcement.

`ts-transformers` is the compile-time bridge between:

1. author-friendly code
2. runtime-friendly explicit forms

## 2. Primary Product Goal

Convert idiomatic authored code into explicit reactive/runtime forms with
minimal author burden and maximal semantic fidelity.

In practice, this means:

1. preserve what authors mean
2. make implicit reactive boundaries explicit
3. emit actionable diagnostics when intent cannot be represented safely

## 3. Users And Their Outcomes

## 3.1 Pattern Authors

Authors should be able to:

1. write normal TS/JSX in patterns without manually threading schemas/captures
2. get clear diagnostics when using unsupported/reactively-invalid constructs
3. reason about transformed behavior without needing deep compiler internals

## 3.2 Runtime And Platform

The runtime should receive:

1. explicit schemas for significant boundaries (`pattern`, `lift`,
   `handler`, `cell`, `wish`, `generateObject`, conditional helpers)
2. explicit closure capture params instead of hidden lexical captures
3. explicit control-flow helper calls where required by reactive semantics

## 3.3 Maintainers

Maintainers should have:

1. deterministic stage boundaries and order
2. behavior locked by fixtures and focused unit tests
3. architecture that supports incremental policy changes without total rewrites

## 4. Goal Set

## G-001 Natural Authoring, Explicit Runtime

Default authoring should stay idiomatic, but output should carry the explicit
shape needed for runtime execution and tracking.

## G-002 Semantic Preservation

Transformations must preserve JavaScript/TypeScript runtime semantics, including
short-circuit/value behavior for conditional operators.

## G-003 Context-Aware Reactivity

Rules should be context-driven (pattern-facing vs compute-facing code), not
globally uniform or accidentally heuristic.

## G-004 High-Quality Diagnostics

Diagnostics should identify:

1. what pattern was detected
2. why it is invalid in this context
3. the preferred author action

## G-005 Schema Fidelity With Graceful Degradation

Prefer precise schemas when type information is available. When precision is not
possible (for example, unresolved generics), degrade predictably without
crashing transformation.

Schema fidelity includes preserving meaningful optional/undefined distinctions
(`T | undefined`) through synthetic-node schema generation paths.
It also includes preserving the semantic distinction between `unknown`
(`{ type: "unknown" }`, opaque/unresolved) and `any` (`true`, accept anything).

Executable factory contracts are the deliberate exception to graceful
degradation: if a factory's kind, public schemas, execution exposure, or trusted
provenance cannot be proved, transformation must fail closed rather than emit a
guessed invocation contract.

## G-006 Explicit Closure Capture

Eliminate hidden closure dependencies in transformed runtime-critical paths by
making captures explicit in params objects/pattern wrappers. For first-class
factories, keep this private capture contract separate from the factory's public
input/output contract.

## G-007 Deterministic, Explainable Rewrites

Given the same source and options, output should be stable, predictable, and
explainable via a small set of rules.

Factory calls specifically should be explainable by value origin plus the
nearest decisive execution boundary, not local syntax or union ordering.

## G-008 Test-Anchored Behavior

Behavior changes should be intentional and visible through fixture/unit deltas,
not incidental side effects of refactors.

## G-009 Readable Transformed Output

Generated output is an operational artifact for debugging. Readability and
traceability are goals, not just parser validity.

## G-010 Nested Collection-Operator Semantics

Nested contexts must preserve a clear, deterministic operator policy, especially
for collection methods (`.map`, `.filter`, `.flatMap`, and future analogs).

The key requirement is that rewrite policy follows the **active context at the
operator site**, not only the outer expression.

### Collection Operator Policy Matrix

| Active context at operator call | Receiver category                                                                                   | Goal policy                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Pattern context                 | reactive/opaque pattern-facing values                                                               | Rewrite to explicit reactive form (currently `...WithPattern` + patternized callback)             |
| Pattern context                 | plain JS arrays/values                                                                              | No reactive rewrite                                                                               |
| Compute context                 | cell-like values that still require reactive lifting (`Cell` / `Writable` / `Stream` / equivalents) | Rewrite                                                                                           |
| Compute context                 | values treated as plain/auto-unwrapped in compute callbacks                                         | Do not rewrite                                                                                    |

This is the tricky case for array methods: in pattern context we want broad
rewrite coverage for reactive receivers, while in compute context rewrites
should be narrow and type-driven.

For future operators (`.find`, `.some`, etc.), the goal is to keep the same
matrix shape unless there is a semantics-specific reason to diverge.

Important callback rule for rewritten collection methods:

1. If a call site is rewritten to a `...WithPattern` form, its callback parameter
   semantics are pattern-like (opaque/pattern callback boundary).
2. If a call site is not rewritten, callback parameter semantics stay normal for
   that context (no implicit promotion to pattern callback semantics).

Nested compute nuance:

1. Local aliases that re-wrap reactive collections inside a compute callback
   should re-enter the same policy matrix as other reactive receivers.
2. Fully compute-owned branches introduced by earlier rewrites must not
   accidentally fall back to pattern-context collection policy.

## G-011 Least-Capability Boundary Types

Boundary types should reflect the minimum authority required by observed usage
where capability authority is semantically meaningful, while preserving opaque
contract continuity where that matters more than local minimization.

Context-specific target direction:

1. Pattern boundaries: default to opaque boundary contracts (`OpaqueCell<T>`) so
   schema/default continuity is preserved across downstream links.
2. Compute boundaries: use least-capability wrappers from observed usage:
   read-only -> `ReadonlyCell<T>`, write-only -> `WriteonlyCell<T>`, read+write
   -> `Cell<T>` / `Writable<T>`, pass-through-only -> `OpaqueCell<T>`.

## G-012 Path-Sensitive Type Shrinking

Path-sensitive shrinking should be context-scoped, not global.

1. Pattern boundaries should preserve broad declared/inferred schema shape
   (including defaults) to maintain downstream compatibility.
2. Compute boundaries should shrink to observed read/write paths when evidence
   is strong.
3. Unknown-dynamic or wildcard operations should conservatively fall back to
   broader shape.
4. Array-like shapes accessed only through non-item properties (for example
   `.length`) should preserve array shape while shrinking item type to
   `unknown`.

Context-specific propagation rule:

1. Pattern context keeps non-transitive analysis for legality diagnostics, but
   does not use that local summary to prune boundary shape.
2. Compute context may require transitive/interprocedural propagation so helper
   calls can contribute required capability and shrink decisions.

## G-013 Destructured Parameter Compatibility Under Key-Based Access

Common authored forms like `pattern(({ foo, bar }) => ...)` must remain valid.
If key-based access becomes canonical, transforms should preserve author
ergonomics by rewriting destructured pattern-style parameters into explicit
receiver-plus-key bindings.

## G-014 One Source Of Truth For Pattern Diagnostics

Pattern-context errors should come from the same lowerability/capability
analysis that powers rewriting. We should avoid a separate heuristic validator
with independent acceptance criteria.

## G-015 Guard Against Common Type Inference Footguns

The transformer should catch common authoring traps early when TypeScript
inference creates unusable reactive types (for example `new Cell([])` inferring
`never[]`), and emit diagnostics that provide a direct fix path.

## G-016 Validate Schema Shrink Coverage

When capability analysis detects that a callback reads specific properties, and
schema shrinking attempts to narrow the declared type to those paths, the result
must be validated. If the declared type is `unknown` (no structure), or is
concrete but missing accessed properties, the transformer must produce a hard
error so authors fix their types before the pattern compiles. `any` remains the
full-shape fallback and does not trigger this diagnostic. Silent fallback to
unshrunk schemas hides type mismatches that cause runtime surprises. This
includes declared members whose own type is `unknown`, not just top-level
`unknown` parameters.

## G-017 First-Class Serializable Factory Values

Authors should be able to store, pass, derive, capture, union, and invoke trusted
`PatternFactory`, `ModuleFactory`, and `HandlerFactory` values without reverting
to legacy tool descriptors or plain functions.

The compiler/runtime contract must:

1. preserve exact public input/output schemas independently of private captures
2. distinguish eager symbolic invocation from scheduled materialized calls
3. preserve trusted provenance and FrameworkProvided authority end to end
4. support same-kind unions only when their executable contracts are exactly
   compatible
5. diagnose ambiguity instead of guessing

## 5. Non-Goals

## NG-001 Security Boundary

The transformer is not a trust boundary and does not make authored code
"trusted." Security comes from sandbox/runtime architecture.

## NG-002 Full Program Verification

This package is not a whole-program theorem prover or full soundness checker for
all reactive misuse patterns.

## NG-003 Complete Type-System Perfection

Perfect schema inference for all TypeScript features is not required for useful
operation. Graceful fallback is acceptable.

## NG-004 Source-Level No-Op Transforming

Keeping output textually similar to input is not a goal if explicit runtime
forms are required. Semantic fidelity is higher priority than textual identity.

## NG-005 Performance Micro-Optimization Over Clarity

Reasonable compile-time performance matters, but correctness and explainability
take priority over opaque micro-optimizations.

## 6. Constraints And Invariants

## C-001 Applies To Every File

Transform-heavy behavior applies to every file a program carries; there is no
per-file opt-out.

## C-002 Ordered Multi-Stage Pipeline

Stage order is part of behavior. Reordering is a design change requiring
explicit validation. The current pipeline has 26 stages; factory authoring,
FrameworkProvided forwarding, symbolic invocation, final authority metadata,
closure conversion, schema injection, and schema generation have deliberate
relative order.

## C-003 Shared Cross-Stage Registries

Type and metadata propagation across stages (`typeRegistry`, callback markers,
schema hints, factory contracts/provenance, live derivation markers,
diagnostics) is intentional and required for fidelity.

## C-004 Best-Effort On Synthetic Nodes

Synthetic nodes are unavoidable. The system should keep behavior stable using
registry fallbacks and robust node handling.

## C-005 Runtime Contract Compatibility

Transforms must target runtime helper contracts as implemented (not idealized
future contracts).

This includes `invokeFactory` / `NodeRef.expectedFactory`, `asFactory` schema
shapes, independent nested contract documents, and FrameworkProvided callback
metadata.

## C-006 Context Transitions In Nested Code

Nested callbacks can cross context boundaries. The effective rewrite policy must
switch when entering a new callback context, then switch back when exiting.

Examples of required behavior:

1. Pattern callback -> nested compute callback: compute-context policy applies
   inside the nested callback.
2. Compute callback -> nested reactive collection callback: collection rewrite
   decision is evaluated at that nested operator/callback site, not inherited
   blindly from the parent.
3. Context shifts introduced by earlier transformer passes (for example JSX
   rewriting introducing synthetic compute wrappers) are treated as real context
   boundaries for downstream collection-operator decisions.
4. For collection callbacks (notably `.map`), callback context classification is
   tied to transform outcome: only rewritten `mapWithPattern` callbacks are
   treated as pattern callback boundaries.

## C-007 Conservative Analysis Fallback

When capability/path analysis is uncertain, behavior must degrade safely toward
broader types and fewer aggressive rewrites rather than risking unsound
narrowing.

This conservative fallback does not permit an executable factory contract to
degrade to a broader schema: uncertain factory authority or invocation exposure
must diagnose.

## C-008 Optional-Chain Navigation And Call Semantics

If property-navigation optional chains are lowered to `key(...)` on opaque
receivers, lowering must preserve no-throw navigation semantics. Optional
receiver and invocation forms follow the same support policy as their
non-optional call root. Whole-call lowering must preserve receiver binding,
single evaluation, authored nullish short-circuit points, and skipped argument
evaluation.

## C-009 Destructuring Lowering Semantics

Destructured parameter lowering must preserve meaning for supported forms
(property pick, alias, nested pick). Forms that imply full-value materialization
or undefined-default semantics beyond current model (`...rest`, computed binding
keys, complex defaults) require explicit conservative handling or diagnostics.

## C-010 Pattern Context Must Be Opaque-Lowerable

In pattern-style contexts, authored expressions are valid only if they can be
lowered to opaque/key/capability-respecting operations. Non-lowerable constructs
must produce clear diagnostics with compute-context alternatives.

## C-011 Context-Specific Capability Propagation

Capability propagation is intentionally asymmetric:

1. Pattern-context legality analysis is direct/local and must not widen from
   helper-callee reads.
2. Pattern-context emitted boundary schemas preserve broad shape/defaults
   instead of shrinking to local reads.
3. Compute-context boundary signatures may widen via interprocedural summaries
   so forwarded values are typed by effective downstream usage.

## C-012 Explicit Type Guidance For Empty Array Cell Factories

Empty array literals passed to cell factories (constructor forms like
`new Cell([])` / `new Writable([])`, plus legacy `.of()` calls) should require
an explicit element type argument to avoid accidental `never[]` cell types.

## C-013 Execution-Boundary Factory Exposure

Factory invocation form is decided by value origin plus the nearest decisive
boundary. Live and scheduled-materialized values remain direct; eager pattern
public/private values are symbolic; nested eager patterns re-enter symbolic
exposure. A helper reachable from mixed or unknown exposures must diagnose.

## C-014 Factory Contract And Authority Separation

The public executable factory contract, private closure params, and
FrameworkProvided authority are distinct channels. Compiler-owned exact hints
take precedence over reconstructed types; every callable union arm must carry
its own provenance; protected paths are runtime metadata and are not serialized
inside `asFactory`.

## 7. Success Criteria

We are meeting goals when:

1. authors can write canonical pattern code without manual schema/capture
   plumbing
2. diagnostics are specific and lead directly to corrected code
3. fixture churn is intentional and tied to documented policy changes
4. known unsupported patterns fail clearly, not silently at runtime
5. transformed output supports practical debugging and code review
6. nested context tests demonstrate the collection-operator policy matrix for
   `.map` and any newly added analogous operators
7. boundary capability fixtures show deterministic wrapper selection by context:
   pattern boundaries stay opaque; compute boundaries use least-capability
   wrappers
8. path-shrinking fixtures show precise contraction on static paths in compute
   boundaries, with conservative fallback on wildcard operations
9. destructured-parameter fixtures (`{ foo, bar }`, alias, nested) produce
   stable receiver-plus-`key(...)` lowered output with equivalent behavior
10. pattern-context diagnostics in fixtures align with lowerability outcomes,
    without dependency on a separate heuristic-only validator path
11. propagation fixtures show pattern-context local-only legality isolation plus
    schema/default continuity, and compute-context transitive widening where
    enabled
12. empty-array cell-factory fixtures fail with actionable diagnostics unless
    explicit element type arguments are provided
13. schema shrink validation errors on `unknown` parameter types when property
    accesses are detected, and on concrete types missing accessed properties,
    with messages that name the missing paths and guide the fix
14. factory fixtures demonstrate eager symbolic versus scheduled direct calls,
    exact same-kind union compatibility, derivation provenance, and fail-closed
    diagnostics for ambiguous contracts/exposure
15. schema fixtures show all three `asFactory` shapes with independently rooted
    input/output `$defs`, and reject recursive non-finite factory contracts

## 8. Policy For Future Changes

When evaluating a transformer change:

1. state which goals it improves (`G-*`)
2. state which invariants it touches (`C-*`)
3. identify any non-goal drift (`NG-*`)
4. include fixture/unit evidence
5. update behavior and delta docs together
6. state whether diagnostics are emitted by lowerability analysis or legacy
   compatibility shims

## 9. Current Strategic Direction

Near-term direction implied by the current delta backlog:

1. move terminology from “safe context” toward semantic context naming
2. make conditional-operator rewrite policy context-driven and coherent
3. prioritize deterministic rules over local heuristics where possible
4. migrate from `Reactive`-driven heuristics toward capability dataflow from
   regular parameter flow
5. make context-scoped boundary emission explicit: broad opaque pattern
   boundaries plus least-capability/path-shrunk compute boundaries
6. treat trusted factories as first-class serializable values while keeping
   public contract, private captures, and system-provided authority separate
