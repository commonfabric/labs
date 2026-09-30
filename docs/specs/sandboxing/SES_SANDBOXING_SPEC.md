# SES Sandboxing Specification for Pattern Execution

## Status: Implementation Baseline

## Authors
- AI-assisted specification

## Last Updated
2026-09-28

This document is the sole authoritative SES sandboxing specification for the
current reimplementation effort. It supersedes prior divergence notes and
branch-specific planning summaries.

---

## 1. Executive Summary

This specification describes a security architecture for sandboxing untrusted
JavaScript execution in the Common Fabric pattern runtime using
**SES (Secure ECMAScript)**. The primary goal is not to trust an authored
pattern as a unit, but to ensure that each invocation of pattern-authored
callbacks is isolated from shared mutable module state except through trusted
Common Fabric abstractions. SES Compartments reduce ambient authority and limit
blast radius, but the primary enforcement mechanism is runtime verification and
hardening of module-scope definitions at load time.

### Key Principles

1. **Invocation Isolation**: Each callback invocation must be isolated from
   any other invocation except through trusted runtime abstractions such as
   `Cell`, `lift`, `handler`, and `pattern`.
2. **Verified Module Load**: Every top-level module item must be classified and
   verified before it may execute or become observable.
3. **Direct Callback Builders**: `pattern`, `lift`, `handler`, and
   similar trusted builders must receive direct callbacks, not IIFE-produced or
   otherwise computed callables.
4. **Safe Top-Level Functions**: Standalone top-level functions are allowed
   only when they are direct functions.
5. **Verified Module-Safe Data**: Any other top-level value must be proven to
   be a versioned, recursively inert subset of `FabricValue` and then
   hardened by a custom checker/freezer. Computing that value via an IIFE is
   allowed only if the final result passes this verifier. The gated ambient
   clock/entropy intrinsics (`Date.now()`, no-argument `new Date()`,
   `Math.random()`) are allowed as narrow exceptions inside a handler and
   return plain data.
6. **Compiler Assists, Runner Enforces**: Transformers may annotate or rewrite
   code to reduce runtime parsing cost, but compiler output is not trusted and
   the runner must verify the final code boundary.
7. **Per-Pattern Compartments Provide Containment**: The runtime uses one
   Compartment per loaded pattern to limit blast radius, while verification and
   hardening remain the primary enforcement mechanisms.

---

## 2. Background

### 2.1 Current Architecture

The current execution pipeline:

```
Pattern Source (.tsx)
    ↓ ts-transformers (compile-time)
    ↓ js-compiler (TypeScript → one CommonJS body per authored file)
    ↓ verified SES module Compartment
    ↓ instantiateJavaScriptNode() → fn(argument)
```

The legacy `UnsafeEvalIsolate` authored-module path has been removed. The
remaining security work is about tightening the verified SES boundary and the
callback rehydration path, not replacing `eval()` anymore.

### 2.2 Why SES?

SES (Secure ECMAScript) provides:
- **Frozen Intrinsics**: Built-in objects (Array, Object, etc.) are frozen
- **Compartments**: Isolated module graphs with controlled globals
- **Hardened APIs**: `harden()` to deeply freeze object graphs
- **Import Hooks**: Control over module resolution and loading

`harden()` is necessary but not sufficient for this threat model. It preserves
behavioral objects as-is, including functions and collection types whose
mutator methods remain live unless they are handled specially. This spec
therefore requires an additional runtime module-safe-data checker/freezer for
top-level non-function values.

Alternative considered: QuickJS as a separate JavaScript runtime. SES is preferred because:
- Runs in the same V8/SpiderMonkey engine (no serialization overhead)
- Same JavaScript semantics (no edge cases)
- Can share frozen objects between Compartments without copying
- Better debugging experience (same DevTools)

### 2.3 Trust Model

Patterns are treated as untrusted code and may attempt to collude with
themselves across callbacks or invocations to route around the intended data
flow controls provided by trusted runtime abstractions.

The primary trust boundary is therefore:

- the verified set of module-scope bindings that survive module load
- the trusted builder/runtime capabilities injected by the platform
- the individual invocation of a verified callback

The following are **not** trusted:

- pattern source code
- compiled JavaScript output
- transformer or compiler rewrites
- arbitrary top-level closures or objects, even if later frozen

Compartments are still valuable, but as containment and ambient-authority
reduction rather than as the sole or primary trust boundary.

---

## 3. Architecture Overview

### 3.1 High-Level Flow

```
Pattern Source (.tsx)
    ↓
[1] ts-transformers (enhanced)
    - Hoist lift/handler to module scope (when external references exist)
    - Lower `computed(...)` to the lift-applied form `lift(...)(input)`
    - Emit optional verification hints for top-level items
    ↓
[2] js-compiler (existing)
    - TypeScript → one CommonJS body per authored file, plus its source map
    ↓
[3] Runtime Verifier (TCB)
    - Wrap each body in a record keyed by its content-addressed specifier
    - Classify every top-level item of each module body before execution
    - Validate the record graph's shape and wiring before anything executes
    - Require direct callbacks for trusted builders
    - Permit direct top-level functions only
    - Route all other top-level values through module-safe-data verification
    - Reject anything else
    ↓
[4] SES Execution
    - Execute verified module factories in one Compartment per loaded pattern
    - Freeze verified top-level functions and exports
    - Expose only approved callable/data exports
    ↓
[5] Runner (modified)
    - Call frozen .implementation directly
    - No eval() per invocation
```

### 3.2 Compartment Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ Root Compartment (lockdown applied)                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Pattern Compartment (one per loaded pattern)          │  │
│  │                                                       │  │
│  │  Globals: trusted runtime capabilities + SES          │  │
│  │  intrinsics                                            │  │
│  │                                                       │  │
│  │  Module Exports (frozen):                            │  │
│  │  - MyPattern: { implementation: fn, patternId: ... } │  │
│  │  - myLift: { implementation: fn, ... }               │  │
│  │  - myHandler: { implementation: fn, ... }            │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Future Dynamic Import Compartments (v2 only)          │  │
│  │  Not part of this implementation baseline             │  │
│  │                                                       │  │
│  │  If added later, each import must get fresh module    │  │
│  │  instantiation plus the same verification policy      │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

The primary enforcement mechanism is still verified module load plus hardened
exports, not the Compartment itself. The runtime nevertheless SHOULD use one
Compartment per loaded pattern as the default containment boundary, because that
reduces blast radius if verification misses something. Future dynamic-import
isolation may add fresh Compartments later, but authored pattern execution in
this baseline uses exactly one verified SES path.

---

## 4. Transformer Enhancements

### 4.1 Overview of Changes

The `ts-transformers` package requires the following enhancements:

| Transformation | Current Behavior | New Behavior |
|----------------|------------------|--------------|
| `computed(() => ...)` | → `lift(() => ...)({})` (lift-applied) | → hoist `lift(...)` when the post-transform callback still depends on imports or module scope |
| `action(() => ...)` | → `handler((_, {}) => ...)({})` | → hoist `handler(...)` when the post-transform callback still depends on imports or module scope |
| `lift(...)` | allowed inline | **ERROR** if not at module scope |
| `handler(...)` | allowed inline | **ERROR** if not at module scope |
| module-scope calls | minimal validation | strict allowlist enforcement |

### 4.2 Module-Scope Verification Rules

At module scope, every surviving binding must fall into exactly one of the
following categories:

1. Trusted builder definitions with a **direct callback**
2. Direct top-level function definitions
3. Verified module-safe data that is hardened before exposure
4. Type-only and import/export declarations

Authored top-level class declarations are rejected in v1. They are neither
plain data nor trusted builders, and they create mutable prototype/static state
that violates the invocation-isolation goal. If class-like behavior is needed,
it must arrive through trusted runtime imports rather than authored module
scope.

All surviving top-level bindings should be normalized into a small canonical
wrapper language before trusted verification. The wrappers are not trusted on
their own; they exist so the verifier can recognize a tiny emitted grammar
instead of parsing arbitrary JavaScript.

#### 4.2.1 Trusted Builder Definitions

Trusted builders may only appear at module scope when their callback is direct.
A callback is "direct" when it is:

- an inline `function` expression
- an inline arrow function that the transformer normalizes to a `function`
  expression before verification
- an identifier that resolves to a direct top-level function definition that is
  itself normalized into the canonical function wrapper form

The following are allowed:

```typescript
// Shown at module scope.
import { pattern, lift, handler } from "commonfabric";

export const MyPattern = pattern<Input, Output>((props) => {
  return { value: props.value };
});

export const SecondaryPattern = pattern<Input, Output>((props) => {
  return { value: props.value };
});

export const myLift = lift<Input, Output>((input) => {
  return transform(input);
});

export const myHandler = handler<Event, State>((event, state) => {
  return newState;
});
```

The following are rejected:

```typescript
// Shown for illustration only.
const makeCallback = () => (input) => transform(input);

// ❌ Callback is computed, not direct
export const badLift = lift(makeCallback());

// ❌ Callback produced by an IIFE
export const badHandler = handler((() => (event, state) => state)());
```

In canonical emitted form, trusted builders should remain builder-shaped. Their
callbacks may be left inline when already direct, or hoisted to a hardened
binding when that makes verification simpler. For example:

```javascript
// Shown for illustration only.
const __cfModuleCallback_1 = __cfHardenFn(function (input) {
  return transform(input);
});
const myLift = lift(inputSchema, outputSchema, __cfModuleCallback_1);
```

The trusted verifier must confirm both:

- the outer trusted-builder call is one of the expected canonical builder forms
- any hoisted callback wrapper is the expected canonical hardening wrapper
- the callback itself is syntactically direct (`function` or arrow), not an
  arbitrary expression that merely evaluates to a function

#### 4.2.2 Direct Top-Level Functions

Standalone top-level functions are allowed when they are direct function
declarations or direct function-valued initializers.

```typescript
function helperFunction(x: number): number {
  return x * 2;
}

const helper2 = (x: number): number => {
  return x * 2;
};
```

These function objects are hardened immediately after definition. The verifier
only needs to accept direct function forms here; they are not part of the
`__cfHelpers.__cf_data(...)` plain-data bucket.

#### 4.2.3 Verified Module-Safe Data

Any top-level value that is not a trusted builder definition or direct function
must be module-safe data and pass a custom checker/freezer before it survives
module load. This is the only category where an IIFE is acceptable.

```typescript
// Shown inside a pattern body.
const CONFIG = freezeVerifiedPlainData({
  maxItems: 100,
  labels: ["a", "b"],
});

const LOOKUP = freezeVerifiedPlainData((() => {
  return {
    open: "Open",
    closed: "Closed",
  };
})());
```

Canonical emitted form:

```javascript
// Shown inside a pattern body.
const LOOKUP = __cfHelpers.__cf_data((() => {
  return {
    open: "Open",
    closed: "Closed",
  };
})());
```

The verifier does not need to semantically interpret the body of a
`__cfHelpers.__cf_data(...)` initializer. It only needs to recognize the wrapper boundary
and confirm the call shape. The runtime helper then evaluates the initializer,
validates the value that survives module load, and freezes the surviving inert
snapshot.

Accessor-backed values are allowed as transient snapshot sources. Their getters
may run during one-time snapshot materialization, but the surviving exported
value must be a copied inert graph with no live accessor behavior remaining.
Proxy-backed snapshotting is intentionally narrower than normal plain-data
usage: authored SES compartments explicitly disable `Proxy`, so authored code
cannot construct new proxies in v1. However, the runtime snapshotter may still
accept proxy-backed host/runtime values that already exist and materialize them
once into inert data. That is a compatibility boundary, not an authored escape
hatch.

The sandbox replaces ambient `Date.now()` / `new Date()` / `Math.random()` with
gated intrinsics, and those are the stable SES contract: pattern authors call
the built-ins directly, the runtime coarsens the clock to one-second resolution
inside a handler, and it forbids any ambient clock/entropy read in a
lift/computed or at pattern body.

Version 1 of the allowed domain is a deliberate subset of
`@commonfabric/api`'s `FabricValue`:

- `null`
- `undefined`
- `boolean`
- `number`
- `string`
- `bigint`
- arrays of allowed values
- plain object records whose string-keyed or symbol-keyed own data properties
  are allowed values
- exact intrinsic non-stateful `RegExp` instances (`global === false` and
  `sticky === false`)
- exact intrinsic `Map` instances whose keys and values are allowed values
- exact intrinsic `Set` instances whose elements are allowed values

Future widening of this set beyond the above, including temporal primitives or
other richer `FabricValue` members, requires an explicit spec revision and
validator version bump. The v1 verifier MUST NOT silently widen with upstream
`FabricValue` changes.

This boundary is about executable behavior and authority, not about forcing
author data into a JSON-like normal form. Sparse arrays, symbol keys, cyclic
graphs, reserved property names, non-finite numbers, and extra own data
properties are not security failures by themselves and MUST NOT be rejected
solely for shape reasons if the runtime can preserve and freeze them without
invoking user-defined behavior.

The default rejected domain includes:

- functions
- `Promise`
- `Error`
- `Date`
- class instances
- `Map` / `Set` subclasses
- platform capability objects

The required security property is about the surviving exported graph, not about
forbidding every transient effect that can happen while snapshotting it.
Trusted graph construction during active builder execution is allowed as part of
pattern assembly, and the current implementation may also trigger effects caused
by proxy traps/getters during `__cfHelpers.__cf_data(...)` snapshotting. This is accepted in
the current baseline, especially while ambient `fetch()` remains temporarily
available. The exported value that survives module load must still be copied and
inert.

For `Map` and `Set`, the checker/freezer must not rely on `harden()` alone.
The surviving value must have immutable collection semantics: mutators such as
`set`, `add`, `delete`, and `clear` must not remain usable on the object that
survives module load.

`__cfHelpers.__cf_data(...)` validates the result that survives module load, not the full
semantics of the computation that produced it. This is acceptable under the
current threat model because the sandboxing contract for this path is about the
surviving copied value rather than forbidding all transient effects during
snapshot evaluation.

#### 4.2.4 Type-Only Syntax

Type-only declarations remain allowed:

```typescript
type MyType = { name: string };
```

Import/export policy:

- static imports are allowed only from trusted runtime modules and from other
  modules in the same transformed-and-verified program
- trusted runtime capabilities are supplied through those runtime modules, as
  records in the same module graph, not as ambient application globals
- external third-party static imports are rejected in v1
- exports should be normalized to simple local bindings plus explicit export
  wiring so the verifier does not need to accept the full surface of ESM export
  syntax
- non-trusted external module access is deferred to dynamic imports in v2

#### 4.2.5 Disallowed Module-Scope Forms

The following are rejected unless they are normalized into `__cfHelpers.__cf_data(...)`,
and the final escaping value passes module-safe-data validation:

```typescript
// Shown for illustration only.
// ❌ Arbitrary call result at module scope
const result = someFunction();

// ❌ Callable produced by an IIFE
const helper = (() => (x: number) => x * 2)();

// ❌ Non-builder side effect at module scope
const data = fetchJson();

// ❌ Await expressions (implies side effects)
const response = await loadSomething();

// ❌ Hidden mutability survives even behind const
const state = { count: 0 };
```

#### 4.2.6 Compiler Assistance and Trusted Verification

The compiler/transformer is not in the TCB. It may assist by:

- inserting stable sentinel comments before each top-level item
- rewriting trusted builders and data initializers into a small canonical
  grammar: direct top-level functions become `__cfHardenFn(...)`, trusted
  builders become canonical builder calls with direct or hoisted callbacks, and
  data initializers become `__cfHelpers.__cf_data(...)`
- rewriting candidate plain-data initializers into
  `freezeVerifiedPlainData(...)`
- hoisting inline callbacks to make direct-callback verification easier
- emitting those wrappers during compilation so source maps and stack traces
  continue to point back to authored source, rather than introducing wrappers at
  runtime

However, the runner must still verify the code that is about to execute. The
trusted verification boundary is two-stage:

- validate the shape and wiring of the whole module-record graph before any
  module executes: every specifier content-addressed, every record well-formed,
  every resolved import pointing at a record actually present in the graph
- classify every top-level item of each module body before that body can be
  imported or executed

The per-module body is the authored-code boundary. Each module's top-level
structure is verified on its own terms, with nothing to unwrap first.

The trusted verifier should be a recognizer for the canonical emitted grammar,
not a general JavaScript parser. It only needs to:

- locate top-level item boundaries using sentinel comments and balanced
  delimiter scanning
- handle strings, comments, and template literals correctly so delimiters line
  up
- confirm that each surviving top-level item matches one of the canonical
  wrapper forms or allowed import/export/type forms
- reject anything outside that mini-language

The trusted verifier does **not** need to understand arbitrary JavaScript AST
structure if the emitted grammar is kept small and canonical.

### 4.3 Hoisting Inline Transformations

Hoisting decisions are made against the post-transform builder form, not the
raw authored callback.

By the time this hoisting pass runs:

- `computed(...)` has already been rewritten to the lift-applied form
  `lift(...)(input)`
- `action(...)` has already been rewritten to `handler(...)(params)`
- closure lowering has already converted local closed-over values into explicit
  callback parameters / params objects where possible
- `mapWithPattern(...)` and `patternTool(...)` have already been expressed as
  inner-scope `pattern(...)` forms with explicit captures

The hoisting pass therefore only cares about what still crosses the callback
boundary after those rewrites: remaining free variables, imported symbols, and
module-scoped bindings.

Self-contained callbacks remain inline. A callback is self-contained when, after
the earlier rewrites, all referenced values are callback parameters or locals.
This is the default behavior, not merely an optimization.

**Detection criteria for leaving inline (no hoisting needed):**
- No remaining free variables after closure lowering
- No imported symbol references
- No module-scoped binding references
- No `this` references
- No `arguments` references
- No `eval` or `Function` calls

```typescript
// Shown for illustration only.
// This stays inline (self-contained after normalization)
const doubled = lift(({ value }) => value * 2)({ value: props.value });

// This MUST be hoisted (still references module scope after normalization)
const doubled = lift(({ value }) => value * multiplier)({ value: props.value });
```

#### 4.3.1 Computed Hoisting Rule

**Before (current):**
```typescript
// Shown at module scope.
export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = computed(() => props.value * 2);
  return { doubled };
});
```

**After transformation (current):**
```typescript
// Shown at module scope.
export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = lift(({ value }) => value * 2)({ value: props.value });
  return { doubled };
});
```

If the post-transform lift-applied callback is self-contained, it stays inline.

If the post-transform callback still references imports or module scope, the
transformer must hoist the builder factory, not the fully applied call. This
applies equally to nested builder callbacks introduced by helpers such as
`map(...)`, `mapWithPattern(...)`, or inline sub-`pattern(...)` creation. If
the post-transform callback still sees module-scoped bindings, it must be
lifted to module scope so verified evaluation can mint and register a stable
`implementationRef` for the real executable body.

Concretely, the lift-applied shape splits into a factory and an application:

- starting point: `lift(inputSchema, outputSchema, fn)(params)`
- hoist target: `lift(inputSchema, outputSchema, fn)` (the factory)
- original-site replacement: `hoistedLift(params)`

**After transformation (new, when hoisting is required):**
```typescript
// Shown at module scope.
// Hoisted to module scope
const __computed_1 = lift<{ value: number }, number>(
  ({ value }) => value * 2
);

export const MyPattern = pattern<Input, Output>((props) => {
  const doubled = __computed_1({ value: props.value });
  return { doubled };
});
```

#### 4.3.2 Action / Handler Hoisting Rule

**Before (current):**
```typescript
// Shown at module scope.
export const MyPattern = pattern<Input, Output>((props) => {
  const doSomething = action(() => {
    props.count = props.count + 1;
  });
  return { doSomething };
});
```

If the post-transform handler callback is self-contained, the inline
`handler(...)(params)` form may remain at the original location.

If the post-transform handler callback still references imports or module scope,
the transformer must hoist the builder factory, not the final bound result.
Any remaining nested handler-like callback with module-scoped free variables is
therefore a transformer bug. The runtime may rehydrate such a callback from
source as a fail-closed fallback, but verified execution must rely on the
hoisted, module-scoped callback form.

Concretely:

- starting point: `handler(eventSchema, stateSchema, fn)(params)`
- hoist target: `handler(eventSchema, stateSchema, fn)`
- original-site replacement: `hoistedHandler(params)`

**After transformation (when hoisting is required):**
```typescript
// Shown at module scope.
// Hoisted to module scope
const __action_1 = handler<void, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  }
);

export const MyPattern = pattern<Input, Output>((props) => {
  const doSomething = __action_1({ count: props.count });
  return { doSomething };
});
```

#### 4.3.3 Pattern-Based Inner-Scope Forms

The `pattern(...)` forms created for `mapWithPattern(...)`,
`filterWithPattern(...)`, `flatMapWithPattern(...)`,
`groupByWithPattern(...)`, `keyByWithPattern(...)`, and `patternTool(...)`
remain inner-scope constructs in this phase. They already carry their captures
explicitly and are not the target of the module-hoisting rule above.

**Before:**
```typescript
// Shown for illustration only.
export const MyPattern = pattern<Input, Output>((props) => {
  const total = computed(() => props.items.reduce((a, b) => a + b, 0));
  return { total };
});
```

For reactive collection methods, the current transformation remains:

- detect a reactive receiver
- rewrite `.map()` / `.filter()` / `.flatMap()` / `.groupBy()` / `.keyBy()`
  to the corresponding
  `*WithPattern(...)` form
- keep the generated `pattern(...)` callback inline with explicit params/captures

These transforms are driven by reactive receiver semantics, not by the
module-hoisting rule.

**After transformation:**
```typescript
// Shown at module scope.
const __derive_1 = lift<number[], number>(
  items => items.reduce((a, b) => a + b, 0)
);

export const MyPattern = pattern<Input, Output>((props) => {
  const total = __derive_1(props.items);
  return { total };
});
```

---

## 5. SES Execution Details

The runtime uses one authoritative SES execution path for compiled pattern
modules:

- verify each module body before it can execute
- execute verified modules inside one Compartment per loaded pattern
- expose only verified exported builder objects to the runner

Fresh Compartment evaluation remains available only for the rare string-based
fallback path described in Section 5.4. It is not the normal invocation path.

### 5.1 Lockdown Configuration

The runtime's sandbox surface is `SESRuntimeOptions`
(`packages/runner/src/sandbox/ses-runtime.ts`):

```typescript
export interface SESRuntimeOptions {
  globals?: Record<string, unknown>;
  lockdown?: boolean;
  hideInternalStackFrames?: boolean;
}
```

`lockdown` gates `ensureSESInitialized`; `globals` supplies the compartment
endowments of §5.3.1; `hideInternalStackFrames` gates the runner-frame collapse
described in §8.6. All three default to off/empty at this type, and the Runtime
threads its own defaults down through `Engine` (see
`packages/runner/src/runtime-presets.ts` for which are core-defaulted).

Lockdown options are a fixed constant, `DEFAULT_LOCKDOWN_OPTIONS`, applied
unconditionally — they are not derived from a debug flag, and no caller varies
them:

```typescript
// Shown for illustration only.
const DEFAULT_LOCKDOWN_OPTIONS = {
  errorTaming: "safe",
  stackFiltering: "concise",
  overrideTaming: "severe",
  consoleTaming: "unsafe",
  localeTaming: "unsafe", // paired with the pre-lockdown locale sanitizer
  evalTaming: "safe-eval",
  // …plus errorTrapping, reporting, unhandledRejectionTrapping, regExpTaming,
  // domainTaming, overrideDebug, legacyRegeneratorRuntimeTaming, __hardenTaming__
};

sanitizeLocaleMethods(); // vetted shim; before the intrinsics freeze
repairIntrinsics(DEFAULT_LOCKDOWN_OPTIONS);
restoreErrorIsError(); // vetted shim; only this seam has both constructors
hardenIntrinsics();
```

The option *types* admit the looser values (`errorTaming: "unsafe"`,
`stackFiltering: "verbose"`) that a debug build would want, so varying them
remains available — but nothing does today, and `Runtime`'s own `debug` option is
unrelated: it only gates an initialization `console.log`. Stack readability for
pattern authors is handled after the fact instead, by the mapping and
frame-collapse passes in §8.6.5.

Notes:

- `lockdown(options)` is exactly `repairIntrinsics(options)` followed by
  `hardenIntrinsics()`. The runtime spells out the two phases because the
  `Error.isError` shim has nowhere else to run: SES's error taming rebuilds the
  `Error` constructor and copies forward only `length`, `prototype` and the V8
  stack surface, so the method exists neither before the repair (the
  constructors are not minted yet) nor after the harden (they are frozen). Every
  `ses` release through 2.2.0 drops it, and `permits.js` listing `isError` does
  not help — a permit lets a property survive, it never adds one. Two
  constructors need the restoration, not one: `%InitialError%` for the host
  realm and `%SharedError%` for compartments, the latter reachable only as
  `Error.prototype.constructor`. See
  `packages/runner/src/sandbox/error-taming.ts`. The phase call reveals
  `globalThis.hardenIntrinsics`, which the runtime deletes afterwards so the
  host realm's global surface matches the one-call form.
- An engine that does not provide `Error.isError` before lockdown has no
  intrinsic to restore. Native error classification falls back to
  `instanceof Error` there. This recognizes SES errors because the repaired
  constructors share the host error prototype hierarchy. General
  cross-realm error recognition requires the native method.
- `overrideTaming: "severe"` remains the compatibility default.
- `localeTaming: "unsafe"` is load-bearing only together with the pre-lockdown
  vetted shim in `packages/runner/src/sandbox/locale-taming.ts`, which replaces
  every method SES's `"safe"` mode would amputate with a pinned-default
  wrapper: omitted locale → `"en-US"`, omitted Date `timeZone` → `"UTC"`, and
  the ECMA-402 unsupported-tag locale fallback → `"en-US"` (appended to every
  request so resolution can never reach the host default locale). Explicit
  arguments pass through; invalid `timeZone` values throw per spec (ECMA-402
  has no timezone fallback to the host zone). Do not change this option in
  isolation: `"safe"` would clobber the sanitized methods with
  argument-ignoring aliases, and bare `"unsafe"` without the shim reintroduces
  ambient host-locale reads.
- `mathTaming` and `dateTaming` should not be relied on as policy knobs in the
  reimplementation. In newer SES releases those options are gone; any future
  reintroduction of time/randomness helpers for authored code must be explicit
  and accompanied by call-site restrictions.

### 5.2 Compiled Module Evaluation

Each authored file compiles to its own CommonJS body, which the runtime wraps in
a module record keyed by the module's content-addressed specifier
(`cf:module/<hash>`). A record declares what it imports, what it exports, how
each of its import specifiers resolves, and how to execute its body:

```typescript
interface SesCompartment {
  importNow(specifier: string): Record<string, unknown>;
  evaluate(source: string): unknown;
}

interface VirtualModuleRecord {
  imports: string[];
  exports: string[];
  resolutions?: Record<string, string>;
  execute(
    moduleExports: Record<string, unknown>,
    compartment: SesCompartment,
    resolvedImports: Record<string, string>,
  ): void;
}
```

Both verifications run on the **compile** path, before any module executes: each
body is classified as it is wrapped, then the assembled graph is validated as a
whole. Loading afterwards registers every reachable record in the pattern's
Compartment and drives the entry synchronously:

```typescript
// Shown for illustration only.
// Compile: classify each body, then validate the assembled graph.
verifyCompiledModuleBody(compiledBody, filename);
verifyModuleGraph(records, entrySpecifier);
// Load: the graph is already verified, so the loader does not re-check it.
const { namespace } = loadModuleGraph(entrySpecifier, {
  records,
  globals,
  verify: false,
});
```

Important details:

- each module body is classified before it can execute, and the record graph is
  validated structurally before anything in it runs
- the compile path is the authoritative verification boundary: a body reaches a
  record only after `verifyCompiledModuleBody` has accepted it, and no graph
  reaches a Compartment before `verifyModuleGraph` has accepted its wiring. The
  loader's own `verify` option defaults to **on** for any other caller, so a
  graph assembled outside the Engine cannot load unverified; the Engine passes
  `verify: false` precisely because it has already run the check, and the warm
  cached-module path runs it again on the graph it rebuilds
- a warm cache hit may skip the body verifier only when the compiled bodies came
  from an integrity-gated read; a miss or partial hit always re-verifies (see
  the compilation-cache threat model in
  [module-loading.md](../module-loading.md))
- runtime capability injection happens explicitly: `commonfabric` and its
  siblings are records under `cf:runtime/<specifier>` in the same graph
- a module body receives a `require` bound to `compartment.importNow`. A declared
  import specifier resolves through that record's `resolutions` map, which the
  graph verifier has already constrained: every entry must remap an import the
  record actually declares, every target must be a content-addressed specifier
  present in the graph, and a trusted-runtime import must resolve to exactly its
  matching `cf:runtime/<specifier>` record — so a declared runtime binding cannot
  be rewired to an authored sibling. A specifier absent from the map falls through
  to the compartment's `importNowHook`, which serves only records present in the
  validated graph. The reachable set is therefore bounded by this load's
  already-verified modules plus the trusted runtime records the import policy
  admits; there is no path from `require` to an unverified module or to an
  ungranted host capability
- security must not depend on syntactically detecting every obfuscated path to
  `require`; the confinement above is what bounds it, and verifier rejection of
  unrecognized `require()` forms is defense in depth
- the harness uses the resulting export map to associate exported runtime values
  with their source `RuntimeProgram`
- only verified exported builder objects are cached for later invocation

The graph validation step MUST confirm all of the following:

- the entry specifier is present in the graph
- every specifier is content-addressed (`cf:module/…` or `cf:runtime/…`)
- every record is well-formed: array `imports`, array `exports`, callable
  `execute`
- every entry in a record's `resolutions` map remaps an import that record
  actually declares — a resolution for an undeclared specifier is a smuggled
  edge
- every resolved import target is content-addressed and present in the graph
- every trusted-runtime import resolves to `cf:runtime/<specifier>` and not to
  any other record

For any cached export-based execution path, the minimal runtime-facing metadata
shape can stay small:

```typescript
interface FrozenExport {
  readonly name: string;
  readonly implementation: unknown;
  readonly patternId: string;
}

interface PatternCompartment {
  readonly patternId: string;
  readonly exports: Map<string, FrozenExport>;
  getExport(name: string): FrozenExport | undefined;
}
```

Source maps, source files, and display metadata belong in the error-mapping
layer rather than on every `PatternCompartment`.

### 5.3 Authority Surfaces

The runtime distinguishes two authority surfaces:

#### 5.3.1 Minimal Compartment Globals

Ambient Compartment globals for authored modules must stay intentionally narrow:

- SES intrinsics
- sandboxed `console`
- `harden`
- verifier/runtime helper bindings needed to realize canonical wrappers
- temporary compatibility forwarding for the current compatibility-global
  surface used by legacy importer/auth code paths:
  `fetch`, `Headers`, `Request`, `Response`, `structuredClone`,
  `TextDecoder`, `TextEncoder`, `URL`, `URLSearchParams`, `atob`, `btoa`,
  and an explicit `Proxy = undefined`
- a frozen compartment `globalThis`, so authored code cannot rebind or extend
  installed global bindings

Ambient globals available to authored module code in v1 MUST NOT include:

- `Temporal`
- `secureRandom`
- `randomUUID`
- any host object that performs network, time, randomness, navigation, storage,
  or compilation effects immediately when called

Whatever this surface ends up being, the type libraries the pattern compiler
serves from `packages/static/assets/types` MUST NOT declare a global the
Compartment does not install. A name the compiler declares but the sandbox
lacks type checks, compiles and deploys, and then throws a `TypeError` in the
user's hands, which is the one failure mode every gate lets through.
`SANDBOX_WITHHELD_GLOBALS` in `packages/utils/src/sandbox-contract.ts` records
the names held back and why; `deno task strip-withheld-globals` in
`packages/static` removes their declarations, and
`packages/runner/test/sandbox-global-contract.test.ts` checks both directions
against a real Compartment. Endowing one of these globals means dropping it
from that list and restoring its declaration together.

Only the value declaration goes. The matching `interface` stays, so authored
code may still name a withheld global in a type position — `let bytes:
Float32Array` — and only the constructor is out of reach. What this does cost
is feature detection: `typeof Proxy` no longer compiles, though coping with an
absent global is the whole point of that idiom. Code that needs to ask must go
through a `globalThis` record.

The contract test enforces this as a zero-gap invariant: the set of globals the
compiler declares but the Compartment lacks must be empty. A type-library change
that reintroduces a gap fails the test until the new name is endowed or
withheld. Withholding a `declare namespace` such as `Intl` removes only its
value members, so its interfaces stay and authored code can still name the types
even though it cannot construct the objects.

Notably, SES stops listing `Float32Array` and `Float64Array` as universal
globals as of version 2. A NaN carries spare mantissa bits, and storing one
into a float typed array writes them through to the underlying buffer, where a
second view reads them back. Lockdown repairs `DataView.prototype.setFloat*` to
write only canonical NaNs, but a typed-array element store is not a method and
nothing can intercept it, so endowing the constructors would reopen the channel
the repair closes.

That channel is SES's threat model rather than this one: a NaN mantissa moves
bits between two views of one buffer inside a single compartment, which is not a
boundary this specification defends. The constructors stay out because doing so
matches the upstream default, is reversible, and costs nothing — no pattern uses
them — not because it denies an attacker anything today. What the roll does
change is honesty: the compiler stops offering constructors the sandbox will not
supply. Modules compiled before the roll still carry `Float32Array` and throw at
runtime regardless of what the type libraries say; stripping the declarations
only fixes what compiles from here.

When host constructors or functions from that compatibility surface are
forwarded into a Compartment, the runtime MUST freeze the actual forwarded
outer-realm value before installation. In particular, forwarded constructor
objects and their `.prototype` objects must be frozen before authored code can
observe them. This explicit host-realm hardening is part of the prototype
pollution defense for forwarded web APIs; it is not provided by SES
automatically.

A compartment forwards no ambient `fetch` and none of the adjacent web request
globals (`Headers`, `Request`, `Response`). Network access is a runtime-managed
capability: the graph constructors `fetchJson()`, `fetchText()`,
`fetchBinary()`, `fetchJsonUnchecked()`, and `fetchProgram()` issue the request
on the pattern's behalf, which is what lets the runtime record it as a CFC sink
request for a deployment's ceiling to gate, and sign it when it targets a
first-party route.

#### 5.3.2 Trusted Runtime Modules

Common Fabric capabilities are supplied as trusted runtime modules, registered as
records under `cf:runtime/<specifier>` in the same content-addressed module graph
as the authored modules. This is the primary way authored code receives builder
and graph-construction capabilities.

In the current implementation, the trusted runtime module identifiers are
(`RuntimeModuleIdentifiers`, `packages/runner/src/sandbox/runtime-module-policy.ts`):

- `commonfabric`
- `commonfabric/cfc`
- `commonfabric/schema`
- `turndown`

Other internal `@commonfabric/*` packages exist in the monorepo, but they are
not currently exposed to authored SES modules.

These runtime modules may export:

- module-scope trusted builder entrypoints: `pattern`, `lift`, `handler`,
  `action`, `computed`
- callback-scope helper entrypoints such as `patternTool(...)`, which remain
  valid inside verified pattern callbacks but are not part of the module-scope
  trusted-builder allowlist
- cell constructors and helpers: `Cell`, `Writable`, `OpaqueCell`, `Stream`,
  `ComparableCell`, `ReadonlyCell`, `WriteonlyCell`, `cell`, `equals`
- graph-construction built-ins: `str`, `ifElse`, `when`, `unless`, `llm`,
  `llmDialog`, `generateObject`, `generateText`, `fetchJson`, `fetchProgram`,
  `streamData`, `compileAndRun`, `navigateTo`, `wish`
- utilities and constants required for graph construction and schema handling

The important distinction is that these are graph-building or deferred runtime
constructors. They may be used during module load to build the frozen reactive
graph, but they do not directly perform host effects merely by being present as
imports. Host-visible effects happen later, under the runtime's node execution
model, not during authored module evaluation. `patternTool(...)` is the main
exception to the "usable during module load" shorthand here: it may be exported
by trusted runtime modules, but it is only allowed inside verified pattern
callbacks after the earlier pattern transforms. These imports are not valid
from within `__cfHelpers.__cf_data(...)` initializers.

Any shared value exposed by a trusted runtime module MUST be transitively
hardened before Compartment evaluation begins. That export graph is reused across
authored evaluations, so function objects, namespace objects, and reachable
shared helper objects must be immutable when the record is built — each runtime
record simply copies the already-frozen namespace onto its module exports.
Mutable state may only be introduced through explicit runtime-managed
authorities returned later, not by mutating the shared runtime-module export
graph itself.

#### 5.3.3 Runtime Cells

Pattern code holds live runtime cells. A handler or lift argument holds one
wherever its schema says `asCell`, a builder function returns them, and a cell
method that returns a cell returns another. A cell is therefore an authority
surface, and the runtime treats it as a capability: holding a cell grants the
operations of the public cell interface and nothing else. Each of those reads
and writes through the transaction the cell is bound to, under that
transaction's CFC and ACL checks. The runtime, its storage manager, and every
transaction stay out of reach, which is what lets the CFC read ceiling, the
transaction's journal, and the write-policy inputs the runtime records be
trusted.

The rules that keep this true:

- A cell keeps its runtime, its transaction, the frame it was built under, and
  the label view it carries in ECMAScript-private fields that no member hands
  out. Host code reaches them through functions of the runner that pattern code
  cannot import: `cellRuntime()`, `cellTx()`, `exportCell()`, and
  `getCarriedCfcLabelView()`. Host code that passes a settle callback, which
  receives the transaction, or stream-send options, which name the durable
  event id, does so through `setCell()` and `sendEvent()`; a cell's own `set()`
  and `send()` take only the value.
- Those functions and `isCell()` recognize a cell by a private brand. An object
  built on the cell prototype, or shaped like a cell, does not carry it, so the
  host never takes such an object's word for its runtime, its transaction, or
  its labels. A `Reactive` proxy over a whole cell stands for that cell.
- A cell's constructor, which pattern code reaches through any cell it holds,
  throws unless it is given a runtime and a transaction the runtime created.
  `withTx()` and `getAsQueryResult()` refuse any other transaction as well.
- The cell class, its prototype, and each cell are frozen, so pattern code
  cannot change what a cell's members do for the host code that later reads
  them.
- What a handler or lift consumed is what its transaction read, and the run's
  labels and checks are computed from that transaction's journal (CFC
  specification sections 8.10.1 and 18.6). So while a run's code runs, a cell
  bound to the run's transaction keeps to it: `withTx()` with no transaction
  returns a cell still bound to it, `getArgumentCell()` binds the cell it
  returns to it, and `sink()` and `pull()`, which read through transactions of
  their own, throw. Two routes are not yet held to this, because the runtime
  tells a run's code from its own only by the run's frame: a promise
  continuation the run queued that runs after the run's function returns but
  before its transaction commits, when the frame is gone, and `sinkMeta()`,
  which the runtime's own code calls on a run's cells within the frame.

`packages/runner/test/cell-authority.test.ts` runs these attacks from a pattern
in the real sandbox. It also walks everything a cell, a stream, a `Reactive`
proxy, and a query result reach, calling each method with callbacks and with a
forged transaction in each argument position, and fails on reaching a runtime
service or a transaction, or on host code using the forged one.

### 5.4 Smaller-Compartment String Rehydration

Untrusted authored pattern code normally reaches execution through
module-graph validation plus per-module body verification. The only exception is
the lazy rehydration of serialized nested-pattern or module implementations that
exist only as function strings when first invoked.

That path must use SES, but not the full pattern-load authority surface. It
must execute inside a smaller Compartment with:

- the same compatibility globals listed in Section 5.3.1, including the
  explicit `Proxy = undefined`
- function-producing source only: the normalized source may be a direct
  function declaration/expression or a function-producing expression such as an
  IIFE, but evaluating it must yield a function before invocation proceeds
- no module graph, module map, or import hooks
- no runtime-module dependency injection
- a direct `console` global only; internal runtime hook globals such as
  `RUNTIME_ENGINE_CONSOLE_HOOK` are not part of the authored surface
- no shared mutable state other than explicit trusted runtime objects passed in

The runtime may cache a zero-argument creator per normalized function source as
a performance optimization, but each callback invocation must still
materialize a fresh function object/closure before it is called. Creator caching
is allowed; closure-state reuse across invocations is not.

A standalone `evaluateStringSync()` utility may still exist for trusted
internal tooling or diagnostics, but it is outside this threat model and MUST
NOT be used as a general authored-module execution path.

---

## 6. Dynamic Imports (Deferred)

Dynamic import support is not part of this implementation baseline.

Normative v1 behavior:

- no import-hook implementation is assumed or required for this baseline
- authored `import()` remains unavailable because the default SES compartment
  configuration rejects the syntax
- the escape-hatch and threat-model analysis must treat dynamic imports as
  unavailable, not controlled

Future v2 requirements, if dynamic imports are reintroduced:

1. each import must get fresh module instantiation so no state leaks between
   invocations
2. fetched modules must be verified under an equivalent policy before execution
3. downloaded code may be cached only if that caching does not weaken isolation
4. the import-hook implementation should live in a dedicated sandbox subsystem,
   likely under `packages/runner/src/sandbox/`

---

## 7. Closure Prevention Strategy

### 7.1 The Closure Problem

Closures can capture references to user data, leaking it between invocations:

```typescript
// Shown for illustration only.
// DANGEROUS: Closure captures `userData`
let userData: any;

export const BadPattern = pattern((props) => {
  userData = props.secretData;  // Captured!

  return {
    leak: () => userData  // Later invocation can access previous user's data!
  };
});
```

### 7.2 Prevention Mechanisms

#### 7.2.1 No Module-Scope Mutations

The verifier enforces that surviving module-scope bindings:
- Are only assigned at declaration time
- Are never reassigned
- Are const (not let/var)
- Are either trusted direct functions or verified module-safe data

```typescript
// Shown for illustration only.
// ❌ REJECTED: let at module scope
let counter = 0;

// ❌ REJECTED: Hidden mutability behind const
const config = {};
config.key = "value";

// ✅ ALLOWED: verified module-safe data
const CONFIG = freezeVerifiedPlainData({ key: "value" });
```

#### 7.2.2 Pattern/Recipe Inner Functions Run at Load Time

When `pattern()` is called, the inner function executes immediately:

```typescript
// Shown for illustration only.
export const MyPattern = pattern((props) => {
  // This code runs at LOAD TIME, not invocation time
  // At load time, `props` is a schema placeholder, not user data
  return { ui: <div>{props.name}</div> };
});
```

At load time:
- `props` is a reactive schema placeholder
- No actual user data is available
- The return value defines the reactive graph

At invocation time:
- The reactive graph is already frozen
- User data flows through the frozen graph
- No new closures are created

#### 7.2.3 Function Hardening Is Necessary but Not Sufficient

All approved top-level functions and builder implementations are frozen after
load. In this spec, that hardening works together with the stricter top-level
grammar: surviving module-scope values are direct functions, trusted builder
definitions, or module-safe data.

#### 7.2.4 Custom Module-Safe Data Checker/Freezer

This spec introduces a runtime helper dedicated to non-function top-level
values:

```typescript
// Shown for illustration only.
interface ModuleSafeRecordV1 {
  [key: string]: ModuleSafeValueV1;
  [key: symbol]: ModuleSafeValueV1;
}

type ModuleSafeValueV1 =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | ModuleSafeValueV1[]
  | ModuleSafeRecordV1
  | ReadonlyMap<ModuleSafeValueV1, ModuleSafeValueV1>
  | ReadonlySet<ModuleSafeValueV1>;

function assertPlainData(
  value: unknown,
  path = "<root>",
): asserts value is ModuleSafeValueV1;

function freezeVerifiedPlainData<T>(value: T): T {
  return snapshotAndHardenModuleSafeData(value);
}
```

The type sketch above is illustrative rather than exhaustive for JavaScript
edge cases. Runtime acceptance may still include cyclic graphs, sparse arrays,
symbol-keyed properties, extra own data properties, and non-finite numbers so
long as the surviving value remains inert and freezable.

`assertPlainData()` and `freezeVerifiedPlainData()` validate the value that
survives module load, not a JSON-normalized subset of JavaScript. The checker
or freezer MAY materialize ordinary property reads and collection iteration
while constructing the final inert snapshot. In particular, the implementation
must:

- allow accessors and proxies only by evaluating them as part of the one-time
  snapshot that escapes module load
- reject any object whose runtime kind is neither a plain object, an array, an
  exact intrinsic `Map`, nor an exact intrinsic `Set`
- recursively validate `Map` keys and values and `Set` values
- reject intrinsic `RegExp` instances whose `global` or `sticky` flags make
  `lastIndex` observable mutable state
- reject any `FabricValue` members outside the approved v1 subset
- allow shape-level cases such as sparse arrays, symbol keys, cycles, reserved
  property names, non-finite numbers, and extra own data properties if the
  surviving snapshot is inert

`freezeVerifiedPlainData()` MUST preserve the accepted `Map` / `Set` contents
while removing mutability from the surviving collection object. A plain
`harden(new Map(...))` or `harden(new Set(...))` is insufficient because those
mutators remain callable. The freezer MAY preserve sparse arrays, symbol-keyed
properties, cyclic graphs, non-finite numbers, reserved property names, and
extra own data properties; those are semantic/storage concerns, not sandboxing
concerns, so long as the resulting graph is inert. Accessor properties may be
materialized into data properties. Proxy-backed values may be accepted only as
one-time host/runtime snapshot sources; authored SES compartments still keep
`Proxy` unavailable, so patterns do not gain a general proxy capability. Any
proxy-backed snapshot that survives module load must satisfy the same inert-data
rules as ordinary plain objects.

The verifier may allow a top-level expression to compute data via an IIFE, but
only if the value that escapes module load passes `assertPlainData()` and is
then hardened.

#### 7.2.5 Constrained String Execution for Lazy Nested Patterns

Most authored pattern code must enter through module-graph validation plus
per-module body verification. However, lazily invoked nested-pattern and
module implementations may still exist only as serialized function strings at
the point they are first called.

That secondary path is allowed only under all of the following constraints:

- it evaluates only function-producing source, not arbitrary module/program
  strings; direct functions and IIFE-produced callables are allowed so long as
  the evaluation result is a function
- it runs inside a smaller SES Compartment than the main pattern-load path
- that smaller Compartment intentionally reuses the same compatibility-global
  surface as the main authored module Compartment while still omitting the
  module map and runtime-module injection
- it must not expose module-resolution hooks, runtime-module injection, or host
  capabilities beyond the minimal callback invocation surface
- it exposes `console` only as an approved global and does not expose internal
  runtime globals such as `RUNTIME_ENGINE_CONSOLE_HOOK`
- it may cache a source-specific creator function, but each invocation must
  create a fresh callable/closure from that creator before running user code
- it must not share mutable module-scope state across independently evaluated
  string-backed implementations except through explicit trusted runtime objects

A fresh Compartment utility may still exist for trusted internal tooling, but
the lazy string-backed callback path above is the only authored-code exception
to the main verified-module entry rule.

---

## 8. Error Handling and Source Map Integration

Debugging sandboxed code presents unique challenges. This section details how to maintain a good developer experience while running code in SES Compartments.

### 8.1 Current Error Strategy

The live SES runtime uses `errorTaming: 'safe'` and reconstructs host-visible
stack frames after an exception crosses the Compartment boundary. In practice:

- guest code does not receive raw unsafe stack objects from SES
- the host uses SES's stack-string utility to materialize frames after the
  throw
- those frames are then source-map translated back to original authored source

This preserves source locations for debugging without switching the authored
module Compartment to globally unsafe error taming.

### 8.2 The Source Map Challenge

Even with recovered host-visible stack frames, traces point to
**compiled/transformed code** until source maps are applied:

```
Original TypeScript (MyPattern.tsx)
        ↓
    [ts-transformers]  ← Hoisting changes line numbers
        ↓
    [js-compiler]      ← TypeScript → JavaScript
        ↓
    [record wrapping]  ← Wraps each body in a module record
        ↓
Executed in Compartment
```

#### Example: Line Number Mismatch

**Original source (MyPattern.tsx:23):**
```typescript
// Shown for illustration only.
export const MyPattern = pattern((props) => {
  const doubled = computed(() => props.value.map(x => x * 2));  // Line 23
  return { doubled };
});
```

**After transformation (compiled.js:5, 47):**
```javascript
// Shown for illustration only.
// Hoisted to line 5
const __computed_1 = lift(({ value }) => value.map(x => x * 2));

// Original location now at line 47
export const MyPattern = pattern((props) => {
  const doubled = __computed_1({ value: props.value });
  return { doubled };
});
```

**Error without source mapping:**
```
TypeError: Cannot read property 'map' of undefined
    at __computed_1 (eval:5:45)  // Points to compiled code!
```

**Error with source mapping:**
```
TypeError: Cannot read property 'map' of undefined
    at computed callback (MyPattern.tsx:23:42)  // Points to original!
    └─ (hoisted to __computed_1)
```

### 8.3 Source Map Preservation Strategy

#### 8.3.1 Compilation Pipeline Source Maps

Each stage produces and consumes source maps:

```
┌─────────────────────────────────────────────────────────────┐
│ Original Source                                              │
│ MyPattern.tsx                                                │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ ts-transformers                                              │
│ Input:  MyPattern.tsx                                        │
│ Output: MyPattern.transformed.tsx + sourceMap1               │
│                                                              │
│ sourceMap1: transformed line 5 → original line 23           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ js-compiler (TypeScript)                                     │
│ Input:  MyPattern.transformed.tsx + sourceMap1               │
│ Output: MyPattern.js + sourceMap2                            │
│                                                              │
│ sourceMap2: JS line N → transformed line M                   │
│ (TypeScript compiler can chain source maps)                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Record wrapping + source-map registration                    │
│ Input:  MyPattern.js + sourceMap2                            │
│ Output: cf:module/<hash> record + sourceMap2, registered      │
│         under the module's own sourceURL                      │
│                                                              │
│ sourceMap2: module line P → original line Q                  │
│ (Chained through the earlier stages; one map per module,      │
│  shifted by the factory-wrapper line)                        │
└─────────────────────────────────────────────────────────────┘
```

#### 8.3.2 Transformer Source Map Generation

The hoisting transformer must generate accurate source maps:

```typescript
// Shown for illustration only.
// illustrative; the shipped stage is
// packages/ts-transformers/src/transformers/builder-call-hoisting.ts

class HoistingTransformer {
  private sourceMapGenerator: SourceMapGenerator;

  visitComputedCall(node: ts.CallExpression): ts.Expression {
    const originalPos = this.sourceFile.getLineAndCharacterOfPosition(
      node.getStart()
    );

    const hoistedName = `__computed_${this.counter++}`;

    // Record mapping: hoisted location → original location
    this.sourceMapGenerator.addMapping({
      generated: { line: this.hoistedLineNumber, column: 0 },
      original: { line: originalPos.line + 1, column: originalPos.character },
      source: this.sourceFile.fileName,
      name: hoistedName,
    });

    // ... create hoisted node ...
  }
}
```

#### 8.3.3 js-compiler Source Map Chaining

js-compiler emits one map per module, parsed alongside the body
(`parseSourceMap`, `packages/js-compiler/typescript/compiler.ts`). The relevant
options are in `packages/js-compiler/typescript/options.ts`:

```typescript
// Shown for illustration only.
const compilerOptions = {
  sourceMap: true, // mappings are load-bearing: stack frames and CFC
  // verified-source resolve compiled positions through them
  inlineSources: false, // authored source is NOT embedded — see below
  inlineSourceMap: false, // separate map, registered by filename
};
```

`inlineSources` is deliberately **off**. Nothing reads `sourcesContent`: the only
code that touches it copies it into the runtime's map registry, and the consumers
there read mappings only, via `originalPositionFor`. No `//# sourceMappingURL` is
emitted for a debugger to load these maps either, and the authored source is
already persisted separately as source documents. Dropping it cuts per-module
source-map bytes — which the compile cache stores and syncs — by roughly 65%.

### 8.4 Error Mapping Implementation

**What exists today.** The shipped surface is `SESRuntime`
(`packages/runner/src/sandbox/ses-runtime.ts`) over `SourceMapParser`
(`packages/js-compiler/source-map.ts`): `loadSourceMapLazy` registers a map by
filename as a provider that runs on first lookup, `mapPosition` resolves one
coordinate, `parseStack` rewrites a whole stack, and `mapThrownError` does that
once per error — `materializeHostVisibleStack`, then `parseStack`, then a
`markErrorStackMapped` marker, because `parseStack` is **not idempotent**:
per-module maps are registered under the same module path that mapped frames
carry as their source, so re-parsing an already-mapped stack would look the
now-authored coordinates up again and corrupt them. `Engine` re-exports
`parseStack`, and the scheduler's diagnostics share the same marker helpers.

§8.4.1 describes the interface shape that surface already satisfies. The
`ErrorMappingOptions` / `MappedError` / execution-wrapper designs in §8.4.2–§8.4.3
and the display and classifier designs in §8.5–§8.6.1/§8.6.3 are **target design,
not built** — the modules their code blocks name do not exist in the tree, and
§8.8 tracks them as outstanding work. §8.6.5 records the filtering that is
actually implemented.

#### 8.4.1 Shared Source-Map State

Error mapping is synchronous and centered on
`@commonfabric/js-compiler`'s `SourceMapParser`, but SES must **reuse** the same
runtime-owned source-map state shape that already exists in the current harness
rather than introducing a second parallel `ErrorMapper` object model.

The existing shared surface is the right baseline:

```typescript
// Shown at module scope.
interface StackMapper {
  loadSourceMapLazy(
    filename: string,
    provider: () => SourceMap | undefined,
  ): void;
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null;
  parseStack(stack: string): string;
  clear(): void;
}
```

Implementation guidance:

- keep `SourceMapParser` ownership on the runtime / isolate / sandbox instance,
  not on individual errors
- keep the source-map and stack-materialization helper shared across the SES
  module runtime and the narrower callback-compartment runtime, rather than
  duplicating parsing/caching behavior in each call path
- source maps are loaded by filename into the shared mapper and do not need to
  live on every `PatternCompartment`
- the same mapper supports direct `parseStack()` and `mapPosition()` calls for
  both the module-load and lazy-callback SES paths
- after source-map parsing, runner-internal SES plumbing frames should collapse
  to `<CF_INTERNAL>` so user-facing errors show authored code first without
  leaking harness implementation details

#### 8.4.2 ErrorMappingOptions and MappedError

```typescript
// Shown at module scope.
interface ErrorMappingOptions {
  readonly debug?: boolean;
  readonly patternId?: string;
  readonly sourceMap?: SourceMap;
  readonly filename?: string;
}

interface MappedError {
  readonly originalError: Error;
  readonly mappedStack: string;
  readonly frames: readonly ClassifiedFrame[];
  readonly patternLocation?: SourceLocation;
  readonly userMessage: string;
}
```

Required behavior:

- if `filename` and `sourceMap` are present, the shared mapper registers that
  map under `filename` before parsing the stack
- `mappedStack` is the formatted post-classification stack shown to users or
  logs
- `patternLocation` comes from the first `pattern` frame after classification
- `userMessage` is preformatted so callers do not need to rebuild a concise
  display string

The synchronous helper must operate on the shared mapper rather than allocate a
fresh mapper per error:

```typescript
// Shown inside a pattern body.
function mapError(
  mapper: StackMapper,
  error: Error,
  options: ErrorMappingOptions = {},
): MappedError {
  if (options.filename && options.sourceMap) {
    mapper.loadSourceMapLazy(options.filename, () => options.sourceMap);
  }

  return classifyAndFormatMappedError(mapper, error, options);
}
```

`mapError()` is therefore a pure formatter/classifier over runtime-owned mapper
state. It must not instantiate a new `SourceMapParser`, `ErrorMapper`, or other
per-call cache container.

#### 8.4.3 Execution Wrappers

Execution wrappers are required for both sync and async pattern callbacks:

```typescript
// Shown for illustration only.
interface ExecutionWrapperOptions {
  readonly patternId: string;
  readonly functionName?: string;
  readonly includeStack?: boolean;
  readonly debug?: boolean;
  readonly mapper: StackMapper;
}

class PatternExecutionError extends Error {
  readonly patternId: string;
  readonly functionName?: string;
  readonly originalError: Error;
  readonly sourceLocation?: SourceLocation;

  toUserMessage(): string { ... }
}

function wrapExecution<T extends (...args: any[]) => any>(
  fn: T,
  options: ExecutionWrapperOptions,
): WrappedFunction<T> { ... }

function wrapAsyncExecution<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: ExecutionWrapperOptions,
): WrappedFunction<T> { ... }
```

Required behavior:

- preserve `SandboxSecurityError` unchanged
- wrap all other thrown values in `PatternExecutionError`
- attach `patternId`, optional `functionName`, and best-effort `sourceLocation`
- include the original stack in debug mode
- expose `isPatternExecutionError()` and `getErrorMessage()` helpers for
  downstream callers

### 8.5 Debugging Experience

#### 8.5.1 Console Output

With proper error mapping, developers see:

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ (originally: computed callback)
    at MyPattern (MyPattern.tsx:22:3)
    at SandboxedRunner.invoke (ses-runtime.ts:89:5)

Pattern: my-pattern-id
Export: MyPattern

Original source (MyPattern.tsx:23):
  22 │ export const MyPattern = pattern((props) => {
> 23 │   const doubled = computed(() => props.value.map(x => x * 2));
     │                                          ^^^
  24 │   return { doubled };
```

#### 8.5.2 Enhanced Error Display — target design

Not built; the module below is a proposed one.

```typescript
// Shown for illustration only.
// proposed: packages/runner/src/sandbox/error-display.ts

interface ErrorDisplayOptions {
  readonly verbose?: boolean;
  readonly colors?: boolean;
  readonly maxFrames?: number;
  readonly showFrameTypes?: boolean;
}

function formatError(
  mappedError: MappedError,
  options: ErrorDisplayOptions = {},
): string { ... }

function formatErrorForConsole(mappedError: MappedError): string { ... }
function formatErrorForLog(mappedError: MappedError): string { ... }
function formatUserMessage(mappedError: MappedError): string { ... }

interface ErrorReport {
  readonly message: string;
  readonly name: string;
  readonly patternId?: string;
  readonly location?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };
  readonly stack: string;
  readonly frameSummary: {
    readonly total: number;
    readonly pattern: number;
    readonly runtime: number;
    readonly external: number;
    readonly ses: number;
  };
}

function createErrorReport(
  mappedError: MappedError,
  patternId?: string,
): ErrorReport { ... }
```

### 8.6 Layered Stack Trace Filtering

The key insight is that **pattern authors and runtime developers have different needs**:

- **Pattern authors** need to see their code, but runtime internals are noise
- **Runtime developers** need to see everything when debugging the runtime itself

#### 8.6.1 Frame Classification — target design

Not built; §8.6.5 records what the runtime does instead. The module below is a
proposed one.

```typescript
// proposed: packages/runner/src/sandbox/frame-classifier.ts

type FrameType = "pattern" | "runtime" | "external" | "ses";

interface ClassifiedFrame {
  readonly original: string;
  readonly type: FrameType;
  readonly functionName?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly isMapped: boolean;
}

const RUNTIME_PATTERNS = [
  /\/runner\/src\//,
  /\/harness\//,
  /\/scheduler\//,
  /<CF_INTERNAL>/,
  /\beval\b/,
];

const SES_PATTERNS = [
  /\/ses\//,
  /Compartment/,
  /lockdown/,
  /harden/,
  /@endo\//,
];

const EXTERNAL_PATTERNS = [
  /node_modules/,
  /npm:/,
  /esm\.sh/,
  /deno\.land/,
  /jsr\.io/,
];
```

In non-debug mode, filtering behavior should match the implementation:

- include all `pattern` frames
- include `external` frames
- include `runtime` frames only until the first `pattern` frame, to preserve
  call-site context
- exclude `ses` frames and later runtime-internal noise

#### 8.6.2 Filtered Stack Trace Output

**For Pattern Authors (default):**

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ props.value is undefined
    at MyPattern (MyPattern.tsx:22:3)
    ... 3 runtime frames hidden (use --debug for full trace)

Pattern: my-pattern-id

Original source (MyPattern.tsx:23):
  22 │ export const MyPattern = pattern((props) => {
> 23 │   const doubled = computed(() => props.value.map(x => x * 2));
     │                                          ^^^
  24 │   return { doubled };
```

**For Runtime Developers (debug mode):**

```
TypeError: Cannot read property 'map' of undefined

    at computed callback (MyPattern.tsx:23:42)
       └─ props.value is undefined
    at MyPattern (MyPattern.tsx:22:3)
    ─── runtime frames ───
    at FrozenExport.implementation (ses-runtime.ts:89:5)
    at SandboxedRunner.invoke (runner.ts:1254:12)
    at executeWithErrorMapping (execution-wrapper.ts:15:12)
    at instantiateJavaScriptNode (runner.ts:1174:8)
    ─── end runtime frames ───

Pattern: my-pattern-id
```

#### 8.6.3 Implementation — target design

Not built; see §8.6.5. The module below is a proposed one.

```typescript
// Shown at module scope.
// proposed: packages/runner/src/sandbox/stack-filter.ts

interface StackFilterOptions {
  showRuntimeFrames: boolean;  // false for pattern authors, true for runtime devs
  showExternalFrames: boolean; // usually true
  showSESFrames: boolean;      // usually false
  maxPatternFrames: number;    // limit depth, default unlimited
}

const DEFAULT_OPTIONS: StackFilterOptions = {
  showRuntimeFrames: false,
  showExternalFrames: true,
  showSESFrames: false,
  maxPatternFrames: Infinity,
};

export function filterStack(
  frames: ClassifiedFrame[],
  options: StackFilterOptions = DEFAULT_OPTIONS
): { visibleFrames: ClassifiedFrame[]; hiddenCount: number } {
  const visibleFrames: ClassifiedFrame[] = [];
  let hiddenCount = 0;
  let patternFrameCount = 0;

  for (const frame of frames) {
    switch (frame.frameType) {
      case 'pattern':
        if (patternFrameCount < options.maxPatternFrames) {
          visibleFrames.push(frame);
          patternFrameCount++;
        } else {
          hiddenCount++;
        }
        break;

      case 'runtime':
        if (options.showRuntimeFrames) {
          visibleFrames.push(frame);
        } else {
          hiddenCount++;
        }
        break;

      case 'ses':
        if (options.showSESFrames) {
          visibleFrames.push(frame);
        } else {
          hiddenCount++;
        }
        break;

      case 'external':
        if (options.showExternalFrames) {
          visibleFrames.push(frame);
        } else {
          hiddenCount++;
        }
        break;
    }
  }

  return { visibleFrames, hiddenCount };
}

export function formatFilteredStack(
  frames: ClassifiedFrame[],
  options: StackFilterOptions
): string {
  const { visibleFrames, hiddenCount } = filterStack(frames, options);

  const lines: string[] = [];
  let inRuntimeSection = false;

  for (const frame of visibleFrames) {
    // Add section markers for runtime frames in debug mode
    if (options.showRuntimeFrames) {
      if (frame.type === 'runtime' && !inRuntimeSection) {
        lines.push('    ─── runtime frames ───');
        inRuntimeSection = true;
      } else if (frame.type !== 'runtime' && inRuntimeSection) {
        lines.push('    ─── end runtime frames ───');
        inRuntimeSection = false;
      }
    }

    lines.push(formatFrame(frame));
  }

  if (inRuntimeSection) {
    lines.push('    ─── end runtime frames ───');
  }

  if (hiddenCount > 0 && !options.showRuntimeFrames) {
    lines.push(`    ... ${hiddenCount} runtime frames hidden (use --debug for full trace)`);
  }

  return lines.join('\n');
}
```

#### 8.6.4 Sandbox Configuration

Filtering is configured through `SESRuntimeOptions.hideInternalStackFrames`
(§5.1), not a separate stack-filter option object. It is core-defaulted in every
runtime preset. Lockdown's own `errorTaming` / `stackFiltering` verbosity is a
separate axis, set at `ensureSESInitialized` time (§5.1).

#### 8.6.5 The filtering that is implemented

Two passes run in sequence over a thrown error's stack, each replacing a whole
frame line with a marker rather than classifying it into a type:

1. **Source-map rewrite** — `SourceMapParser.parse` walks the stack line by line
   and hands each recognized frame to `mapFrame`. A frame whose filename has a
   registered map and whose position resolves is rewritten to authored
   coordinates (`at <name> (<source>:<line>:<col>)`). A frame whose position does
   **not** resolve becomes `    at <CF_INTERNAL>` when its function name is
   `eval` or empty — the compiled-wrapper frames — and `    at <UNMAPPED>`
   otherwise. A frame with no registered map for its filename is left verbatim,
   which is what keeps host and external frames intact.
2. **Runner-frame collapse** — when `hideInternalStackFrames` is set,
   `sanitizeInternalFrames` (`ses-runtime.ts`) replaces any remaining frame whose
   path lies under `packages/runner/src/` with `    at <CF_INTERNAL>`.

So the layering goal of §8.6 is met, by marker substitution rather than by a
`FrameType` union: authored frames survive with authored coordinates, runtime and
compiled-wrapper frames collapse to `<CF_INTERNAL>`, frames that should have
mapped but did not are called out as `<UNMAPPED>` rather than silently dropped,
and nothing is removed from the stack — every line is preserved or replaced in
place, so frame counts stay comparable.

### 8.7 Configuration Summary

| Audience | `hideInternalStackFrames` | Runner frames | Authored frames |
|----------|--------------------------|---------------|-----------------|
| Pattern author | `true` | Collapsed to `<CF_INTERNAL>` | Authored coordinates |
| Runtime developer | `false` | Left as-is | Authored coordinates |
| Production (logging) | `true` | Collapsed to `<CF_INTERNAL>` | Authored coordinates, included in logs |

Authored frames map to authored coordinates on every row: the source-map pass of
§8.6.5 is unconditional, and only the runner-frame collapse is switched. The
lockdown verbosity knobs are not part of this table — they are constants (§5.1).

### 8.8 Implementation Checklist

Done:

| Task | Where it landed |
|------|-----------------|
| Transformer source map generation | the transformer pipeline emits per-module maps under `sourceMap: true` (`js-compiler/typescript/options.ts`); the hoisting stage is `ts-transformers/src/transformers/builder-call-hoisting.ts` |
| Source map chaining in js-compiler | `js-compiler/typescript/compiler.ts` (`parseSourceMap` per emitted module) |
| Shared `SourceMapParser` lifecycle in the SES runtime | `SESInternals` / `SESRuntime` (`runner/src/sandbox/ses-runtime.ts`), re-exported by `Engine`; per-module and composed registration in `runner/src/harness/engine.ts` |
| Map a thrown error's stack exactly once | `SESRuntime.mapThrownError` plus the `markErrorStackMapped` marker, shared with `runner/src/scheduler/diagnostics.ts` |
| Collapse runner-internal frames | `sanitizeInternalFrames`, gated on `hideInternalStackFrames` (§8.6.5) |
| Configuration options | `SESRuntimeOptions` (§5.1), core-defaulted in `runner/src/runtime-presets.ts` |

Outstanding. None of the modules below exist; the paths are proposals:

| Task | Priority | Proposed files |
|------|----------|----------------|
| `MappedError` / `ErrorMappingOptions` formatter over shared mapper state (§8.4.2) | Medium | `runner/src/sandbox/error-mapping.ts` |
| Execution wrappers (§8.4.3) | Medium | `runner/src/sandbox/execution-wrapper.ts` |
| Frame classification into a `FrameType` union (§8.6.1, §8.6.3) | Low — §8.6.5 already meets the layering goal by marker substitution | `runner/src/sandbox/frame-classifier.ts`, `runner/src/sandbox/stack-filter.ts` |
| Enhanced error display and structured error reports (§8.5.2) | Low | `runner/src/sandbox/error-display.ts` |

---

## 9. Implementation Workstreams

### Phase 1: Non-TCB Compiler Assistance

#### 1.1 Emit top-level classification hints (Priority: High)

The transformer should help the runtime verifier without becoming trusted.
Examples:

- insert stable sentinel comments before each top-level item
- normalize direct top-level functions into canonical forms such as
  `__cfHardenFn(function ...)`
- normalize trusted builders into canonical builder calls such as
  `lift(inputSchema, outputSchema, fn)`
- normalize data bindings into canonical forms such as
  `__cfHelpers.__cf_data(expr)`
- rewrite module-safe-data candidates into `freezeVerifiedPlainData(...)` within the
  canonical data wrapper
- normalize export syntax to simple local bindings plus explicit export wiring

These hints are performance aids only. The runner must be able to reject the
module even if the hints are wrong or missing.

**Files to modify:**
- `packages/ts-transformers/src/transformers/module-scope-validation.ts`
- `packages/ts-transformers/src/hoisting/*`
- compiler pipeline entrypoints that preserve the hints into emitted JS

#### 1.2 Hoist computed/action when useful (Priority: High)

Continue to hoist only when the post-transform builder callback still depends on
imports or module scope. Earlier closure-lowering passes already internalize
many local captures, so this pass is specifically about remaining external
references after normalization.

The hoist target must be the builder factory:

- `lift(inputSchema, outputSchema, fn)(params)` (the lift-applied form, e.g.
  from `computed(...)`) hoists as `lift(inputSchema, outputSchema, fn)` and
  leaves the `(params)` call in place
- `handler(eventSchema, stateSchema, fn)(params)` hoists as
  `handler(eventSchema, stateSchema, fn)` and leaves the `(params)` call in
  place

Generated `pattern(...)` forms for `*WithPattern(...)` and `patternTool(...)`
remain inner-scope transforms in this phase rather than becoming module-level
hoists.

### Phase 2: Trusted Runtime Verification at the Module Body Boundary

#### 2.1 Validate the record graph and verify module bodies before execution (Priority: High)

The trusted verifier should operate in two stages:

- validate the shape and wiring of the whole module-record graph before any
  module executes
- classify each module body before it can be imported

Verifying a body at a time preserves per-module top-level structure, and
validating the graph first prevents untrusted compiler output from rewiring an
import edge to a record the verifier did not intend.

The verifier must check:

- trusted builders receive direct callbacks only
- top-level functions are direct functions only
- all other surviving top-level values are module-safe data and hardened
- no unclassified top-level side effects survive

The verifier should be implemented as a minimal recognizer for the canonical
emitted wrapper grammar, not as a full JavaScript parser. The TCB scanner only
needs to:

- follow balanced `()`, `{}`, and `[]`
- correctly skip over strings, comments, and template literals
- split the module body into top-level items
- match those items against the small set of canonical wrapper forms

If the output deviates from the canonical wrapper language, the verifier should
fail closed.

**Files:**
- `packages/runner/src/sandbox/compiled-bundle-verifier.ts`
  (`classifyModuleItems`, the format-agnostic classification core)
- `packages/runner/src/sandbox/module-record-verifier.ts`
  (`verifyCompiledModuleBody`, `verifyModuleGraph`)
- `packages/runner/src/sandbox/compiled-js-parser.ts` (the delimiter/trivia
  scanner the classifier is built on)
- `packages/runner/src/harness/engine.ts` (calls the body verifier per module)

#### 2.2 Add custom module-safe-data checker/freezer (Priority: High)

Implement a runtime helper that proves a value is a versioned, recursively inert
subset of `FabricValue` and then hardens it. This helper is stricter than
`harden()` alone and stricter than Endo pass-style checks. It must reject
unsupported runtime kinds such as exotic/custom prototypes and non-approved
`FabricValue` members, preserve accepted `Map` / `Set` contents while
converting the surviving collection object to immutable semantics rather than
relying on `harden()` alone, and ensure that the value which escapes module
load is recursively inert. Shape-level cases such as cycles, symbol keys,
sparse arrays, reserved property names, non-finite numbers, and extra own data
properties are not sandbox failures by themselves. Accessors and proxies are
acceptable if they are only observed as part of constructing the final inert
snapshot that escapes module load.

**Likely files:**
- new `packages/runner/src/sandbox/plain-data.ts`
- `packages/runner/src/sandbox/mod.ts`
- `packages/memory/interface.ts` (contract reference only)
- tests under `packages/runner/test/sandbox/`

#### 2.3 Harden approved functions immediately after load (Priority: High)

Direct top-level functions and trusted builder implementations must be hardened
as soon as they are created. Hardening is not an execution grant. A hardened
host callback remains non-executable unless it is either:

- produced by the compiled SES verification/evaluation pipeline, or
- explicitly admitted through the runtime-scoped unsafe host trust API in
  Section 4.1.1

The spec does not require a helper-shaped encoding for direct top-level
functions. Implementations may harden them however they choose, provided the
verifier only needs to recognize direct top-level function forms. Trusted
builder implementations are hardened in the runtime builder layer as soon as
`lift(...)`, `handler(...)`, `pattern(...)`, or related constructors receive
them, but runner execution must still resolve those callbacks through the
verified or trusted-host registries rather than by invoking raw function
objects from the host graph. If a `javascript` module carries a function
implementation that has not been admitted into either registry, the runtime may
only execute it by re-evaluating its source inside the dedicated SES callback
Compartment described in Section 4.2. That fallback is not a blessing path and
must intentionally discard host closure state.

The module-body verifier also treats TypeScript's canonical default-import
normalization rebinding as part of the accepted grammar:
`local = __importDefault(local)` when `local` is already the module's import
binding for that dependency. This statement is a normalization step over
an already-verified import edge, not new capability acquisition.

Namespace-import normalization via `local = __importStar(local)` is
intentionally not supported in v1. That transform introduces additional
namespace-object surface that must be deliberately specified and hardened before
it becomes part of the accepted SES grammar. Future work may add support once
that hardening contract exists.

#### 2.4 Enforce import policy at verification time (Priority: High)

The verifier should explicitly distinguish:

- trusted static imports from runtime modules
- static imports from other transformed-and-verified local modules
- all other static imports, which are rejected in v1

External imports beyond the trusted runtime set should remain a v2 dynamic
import concern rather than a v1 load-time feature.

### Phase 3: SES Execution Path

#### 3.1 Implement one live runtime path (Priority: High)

Eliminate the split between parallel SES implementations. The runtime must have
one authoritative verified SES execution path.

#### 3.2 Use one Compartment per pattern while keeping verification primary (Priority: High)

The runtime should execute each loaded pattern in its own Compartment. That
Compartment is a containment boundary, not the primary mechanism that prevents
callback collusion. Future dynamic-import isolation may introduce additional
Compartments later. In v1, the only separate string-based path is the smaller
lazy-callback Compartment described in Section 5.4, not a general authored
module fallback.

#### 3.3 Minimal globals plus trusted runtime modules (Priority: Medium)

Keep ambient Compartment globals intentionally narrow and supply Common Fabric
capabilities through trusted runtime modules registered as `cf:runtime/` records
in the module graph. Future reintroduction of time/network/randomness helpers for
authored code remains a separate scoped decision.

#### 3.4 Runtime module provider and minimal globals

Build a new sandbox subsystem that separates:

- minimal ambient globals for Compartments
- trusted runtime-module exports registered as `cf:runtime/` records

The target module split should live under `packages/runner/src/sandbox/`.

**Likely files:**
- new `packages/runner/src/sandbox/runtime-modules.ts`
- new `packages/runner/src/sandbox/compartment-globals.ts`

### Phase 4: Runner Integration

#### 4.1 Modify instantiateJavaScriptNode

Replace direct eval with the authoritative verified SES execution path:

```typescript
// Shown for illustration only.
// packages/runner/src/runner.ts

private instantiateJavaScriptNode(
  tx: IExtendedStorageTransaction,
  module: JavaScriptModuleDefinition,
  ...
): void {
  let fn: Function;
  const patternId = this.runtime.patternManager.getPatternId(pattern);

  if (module.implementationRef) {
    fn = this.runtime.harness.getExecutableFunction(
      module.implementationRef,
      patternId,
    );
    if (!fn) {
      fn = rehydrateJavaScriptImplementationInCallbackCompartment(module);
    }
  } else {
    fn = rehydrateJavaScriptImplementationInCallbackCompartment(module);
  }

  const result =
    module.wrapper === "handler"
      ? fn(argument.$event, argument.$ctx)
      : fn(argument);
}
```

The runner must distinguish executable JavaScript implementations by origin:

- verified callbacks: produced by per-module body verification plus SES module
  evaluation
- trusted-host callbacks: admitted explicitly through the unsafe host trust API
- SES-rehydrated callbacks: created lazily from string source or from
  `Function.prototype.toString.call(module.implementation)` inside the smaller
  callback Compartment
- all other raw host function execution on the host: forbidden

“Hardened” is not a third category. Freezing a host callback prevents mutation;
it does not prove provenance.

`implementationRef` is an identity token, not a blessing. Blessing happens only
when the runtime admits callbacks into an execution registry by traversing an
already-approved graph:

- after compiled SES evaluation, the harness walks exported values / pattern
  graphs and registers the `implementationRef -> function` pairs it finds
- when a previously verified pattern is registered into a different active
  harness, that harness must re-admit the discovered `implementationRef ->
  function` pairs into its verified-load registry for the associated
  `verifiedLoadId`, not only into a pattern-local side table
- during `unsafeTrustPattern(...)`, `unsafeTrustModule(...)`, or
  `createBuilder({ unsafeHostTrust })`, the runtime walks the trusted host graph
  and registers those callbacks into the trusted-host registry

Ambient construction context must not register callbacks into either registry.
Being created while a verified load is active is not sufficient.

**Files to modify:**
- `packages/runner/src/runner.ts`

#### 4.1.1 Explicit Unsafe Host Trust API

Some tests, legacy comparison harnesses, and other trusted in-process fixtures
construct patterns directly with host builder functions instead of compiling
authored source through CTS and the module-body verifier. Those fixtures are
outside the verified SES path and therefore must not become executable by
default.

The runtime may expose an explicit, runtime-scoped opt-in for those cases:

```typescript
// Shown inside a pattern body.
const trust = runtime.createUnsafeHostTrust({
  reason: "unit test fixture",
});

const { commonfabric } = createBuilder({
  unsafeHostTrust: trust,
});
```

The builder option may recursively register the host-created pattern/module
graph with a trusted-host function registry as values are produced. Equivalent
direct helpers such as `runtime.unsafeTrustPattern(pattern, options)` or
`runtime.unsafeTrustModule(module, options)` are also allowed.

The unsafe host trust contract is:

- explicit at the callsite
- scoped to one runtime / harness instance
- non-serializable and not persisted into pattern metadata
- separate from the verified SES function registry
- auditable via a required non-empty reason string

This API exists only to admit already-trusted host fixtures. It must not become
an implicit fallback path when normal runner execution cannot find a verified
implementation reference. Without explicit trust, unblessed host callbacks may
still run only through SES source rehydration, which intentionally drops host
closure state and therefore fails closed for non-self-contained functions.

#### 4.2 Remove Legacy UnsafeEvalIsolate Usage

The runtime no longer exposes a live `unsafe-eval` authored-module path.
`harness.getInvocation()` still exists as an internal seam, but it now
delegates to SES function-source evaluation rather than `UnsafeEvalIsolate`,
and the rehydrated callback function is hardened before it is cached or invoked.
The runtime routes either:

- verified module load through the main SES module path, or
- lazy string-backed callback rehydration through the smaller SES callback
  Compartment described above.

For function-backed `javascript` modules that are not blessed through either
registry, the runner stringifies the function with
`Function.prototype.toString.call(...)` and rehydrates that source in the same
callback Compartment. Any missing lexical capture must therefore fail closed at
runtime rather than silently preserving host state.

```typescript
// Shown for illustration only.
// Before
fn = this.runtime.harness.getInvocation(module.implementation);

// After
fn = evaluateInCallbackCompartment(module.implementation);
```

**Implemented in:**
- `packages/runner/src/harness/engine.ts`
- `packages/runner/src/sandbox/ses-runtime.ts`
- `packages/runner/test/runtime.test.ts`
- `packages/runner/test/stack-trace.test.ts`

### Phase 5: Dynamic Imports (Deferred)

Dynamic imports are not implemented in v1. The verifier should reject authored
`import()` expressions outright. If this scope is reopened later, it should
introduce a dedicated import-hook subsystem under `packages/runner/src/sandbox/`
and must preserve fresh-instantiation and verification guarantees.

### Phase 6: Testing & Hardening

#### 6.1 Security Tests

```typescript
// Shown at module scope.
// packages/runner/test/sandbox/security.test.ts

describe('SES Sandbox Security', () => {
  it('prevents closure state leakage between invocations', async () => {
    const pattern = `
      let leaked;
      export const TestPattern = pattern((props) => {
        leaked = props.secret;
        return { getter: () => leaked };
      });
    `;

    // This should fail at load time (module-scope mutation)
    await expect(loadPattern(pattern)).rejects.toThrow();
  });

  it('prevents access to global objects', async () => {
    const pattern = `
      export const TestPattern = pattern(() => {
        return { hasProcess: typeof process !== 'undefined' };
      });
    `;

    const result = await invokePattern(pattern, {});
    expect(result.hasProcess).toBe(false);
  });

  it('rejects dynamic imports in v1', async () => {
    const pattern = `
      export const TestPattern = pattern(() => import('https://esm.sh/stateful-module'));
    `;

    await expect(loadPattern(pattern)).rejects.toThrow();
  });

  it('hardens direct function exports and builder implementations', async () => {
    const pattern = `
      function next() {
        next.count = (next.count ?? 0) + 1;
        return next.count;
      }

      export default next;
      export const myLift = lift(function step(x) {
        step.count = (step.count ?? 0) + 1;
        return x * 2;
      });
    `;

    const compartment = await loadPattern(pattern);
    const next = compartment.exports.get('default');
    const myLift = compartment.exports.get('myLift');

    expect(() => next()).toThrow();
    expect(() => myLift.implementation(1)).toThrow();
  });

  it('materializes accessor-based plain-data snapshots', async () => {
    const pattern = `
      export const DATA = freezeVerifiedPlainData({
        get value() { return 1; }
      });
    `;

    const compartment = await loadPattern(pattern);
    const data = compartment.exports.get('DATA');

    expect(data.value).toBe(1);
  });

  it('accepts inert non-canonical JS data shapes', async () => {
    const pattern = `
      export const DATA = freezeVerifiedPlainData((() => {
        const tag = Symbol('tag');
        const list = [1, , 3];
        list[tag] = NaN;
        list.meta = Infinity;

        const root = { list };
        root.self = root;
        return root;
      })());
    `;

    const compartment = await loadPattern(pattern);
    const data = compartment.exports.get('DATA');
    const symbols = Object.getOwnPropertySymbols(data.list);

    expect(data.self).toBe(data);
    expect(1 in data.list).toBe(false);
    expect(symbols.length).toBe(1);
    expect(Number.isNaN(data.list[symbols[0]])).toBe(true);
    expect(data.list.meta).toBe(Infinity);
  });

  it('accepts immutable Map and Set module-safe data', async () => {
    const pattern = `
      const LOOKUP = freezeVerifiedPlainData(new Map([
        ['open', 'Open'],
        ['closed', 'Closed'],
      ]));
      const TAGS = freezeVerifiedPlainData(new Set(['a', 'b']));
    `;

    const compartment = await loadPattern(pattern);
    const lookup = compartment.exports.get('LOOKUP');
    const tags = compartment.exports.get('TAGS');

    expect(lookup.get('open')).toBe('Open');
    expect(tags.has('a')).toBe(true);
    expect(() => lookup.set('draft', 'Draft')).toThrow();
    expect(() => tags.add('c')).toThrow();
  });

  it('rejects an unclassified top-level statement in a module body', async () => {
    const compiled = "evil();\nexports.x = 1;";
    expect(() => verifyCompiledModuleBody(compiled, '/m.ts')).toThrow();
  });

  it('rejects a record that rewires a runtime import to a sibling', async () => {
    const records = new Map([
      ['cf:module/a', {
        imports: ['commonfabric'],
        exports: [],
        resolutions: { commonfabric: 'cf:module/b' },
        execute() {},
      }],
      ['cf:module/b', { imports: [], exports: [], execute() {} }],
    ]);
    expect(() => verifyModuleGraph(records, 'cf:module/a')).toThrow();
  });
});
```

**Files:**
- `packages/runner/test/security.test.ts`
- `packages/runner/test/compiled-module-verifier.test.ts`
- `packages/runner/test/esm-module-body-verifier.test.ts`
- `packages/runner/test/esm-verifier-adversarial.test.ts`
- `packages/runner/test/module-item-classifier.test.ts`
- `packages/runner/test/plain-data.test.ts`

#### 6.2 Performance Tests

```typescript
// Shown inside a pattern body.
// packages/runner/test/sandbox/performance.test.ts

describe('SES Sandbox Performance', () => {
  it('reuses Compartment for multiple invocations', async () => {
    const pattern = loadPattern(source);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      await invokePattern(pattern, { value: i });
    }
    const elapsed = performance.now() - start;

    // Should be fast since no Compartment creation per invocation
    expect(elapsed).toBeLessThan(1000);  // < 1ms per invocation
  });
});
```

---

## 10. Migration Guide

### 10.1 Pattern Author Changes

Most patterns will work without changes. The following patterns require updates:

#### Patterns with module-scope side effects

**Before (breaks):**
```typescript
const startTime = Date.now();  // Side effect at module scope
```

**After:**
```typescript
// Shown at module scope.
// A lift/computed may not read the ambient clock, so capture the start time
// inside a handler, where `Date.now()` is allowed (coarsened to one second)
// and writes it into a cell.
const captureStart = handler<unknown, { startTime: Writable<number> }>(
  (_event, { startTime }) => {
    startTime.set(Date.now());
  },
);
```

#### Patterns with mutable module-scope state

**Before (breaks):**
```typescript
// Shown at module scope.
let counter = 0;
export const MyPattern = pattern(() => {
  counter++;
  return { count: counter };
});
```

**After:**
```typescript
// Shown at module scope.
// Use Cell for state
export const MyPattern = pattern(() => {
  const counter = cell(0);
  const increment = handler(() => counter.set(counter.get() + 1));
  return { count: counter, increment };
});
```

### 10.2 Runtime API Changes

```typescript
// Shown for illustration only.
// Before
const resultCell = runtime.getCell(space, "pattern-result");
const runner = new Runner(runtime);
await runner.setup(undefined, pattern, inputs, resultCell);
await runner.start(resultCell);

// After (if explicit lockdown control needed)
SESRuntime.applyLockdown({ enabled: true, debug: false });
const resultCell = runtime.getCell(space, "pattern-result");
const runner = new Runner(runtime);
await runner.setup(undefined, pattern, inputs, resultCell);
await runner.start(resultCell);
```

---

## 11. Security Considerations

### 11.1 Threat Model

| Threat | Mitigation |
|--------|------------|
| Arbitrary code execution | Record-graph validation, per-module body classification before execution, SES Compartments, and controlled runtime-module injection |
| Collusion between callbacks in the same pattern | Runtime module verifier, direct-callback enforcement, and verified module-safe-data freezing |
| Compiler/transformer compromise | Runner-side record-graph validation plus per-module body verification |
| Module-resolution abuse | `require` reaches only records present in the validated graph, so every module it can return has already passed body verification; a declared runtime import must resolve to its own `cf:runtime/` record |
| Global pollution | Frozen intrinsics, controlled globals |
| Internal runtime-global exposure | Only approved globals are installed; implementation hooks like `RUNTIME_ENGINE_CONSOLE_HOOK` stay hidden |
| Prototype pollution | SES-frozen intrinsics plus explicit freezing of forwarded host constructor/prototype pairs before installation |
| Host authority through runtime cells | Cells keep their runtime and transaction private, are frozen, and are recognized by a private brand ([§5.3.3](#533-runtime-cells)) |
| Closure-based data leakage | No surviving mutable module bindings; direct-function-only top-level forms plus function hardening |
| State leakage via modules | Verified immutable top-level bindings, hardened shared runtime-module exports, write-once module exports, and dynamic imports rejected in v1 |
| Resource exhaustion | Future: Add CPU/memory limits (not in this spec) |
| Ambient network/time/random authority at module load | Narrow Compartment globals: no `fetch` or adjacent web request globals, no `Temporal`, `secureRandom`, or `randomUUID` |

### 11.2 Known Limitations

1. **No CPU limits**: Infinite loops will still hang. Future work: Integrate with QuickJS for CPU limits or use Web Workers with timeouts.

2. **No memory limits**: Memory exhaustion possible. Future work: Monitor heap usage.

3. **No egress policy on runtime-managed network nodes**: `fetchJson()`,
   `fetchProgram()`, and `streamData()` remain allowed graph constructors and
   may still reach arbitrary URLs under runtime control.

4. **Compartments are secondary containment only**: If the verifier is wrong,
   a shared Compartment increases blast radius. Per-pattern Compartments reduce
   that blast radius but do not replace verification.

### 11.3 Deferred Capability Reintroduction

The following capabilities are intentionally excluded from the verified authored
module surface in v1. Reintroducing them requires separate scoped work.

1. **Time and randomness helpers**: Do not rely on
   `mathTaming` / `dateTaming` knobs as the long-term policy surface. Any
   future exposure of `Temporal`, `secureRandom()`, or `randomUUID()` to
   authored code requires explicit call-site restrictions.

2. **Direct `fetch()`**: Ambient `fetch()` and the adjacent web request globals
   (`Headers`, `Request`, `Response`) are excluded from SES compartments and
   withheld from the type libraries, so authored code reaching for one fails to
   compile. Network access is served by the runtime-managed graph constructors
   `fetchJson()` and its siblings. Reintroducing an imperative form means giving
   the runtime the same view of the request it has of a graph constructor's —
   the sink record, the confidentiality ceiling, and the first-party signature —
   which is scoped work of its own.

### 11.4 Escape Hatch Analysis

Potential escape routes and their status:

| Vector | Status | Notes |
|--------|--------|-------|
| `eval()` | Allowed inside SES compartments | Current lockdown uses `evalTaming: "safe-eval"` |
| `Function()` | Allowed inside SES compartments | Same `safe-eval` policy as `eval()` |
| `import()` | Rejected in v1 | Dynamic imports are deferred and verifier-rejected |
| authored `require` | Confined | Bound to `compartment.importNow`; declared specifiers resolve through the record's verifier-checked `resolutions` map and anything else falls through to the `importNowHook`, which serves only records in the validated graph — so it reaches already-verified modules of the same load and policy-admitted runtime records, never an unverified module or an ungranted host capability. A declared runtime specifier cannot be rewired to an authored sibling |
| Prototype access | Blocked | SES freezes intrinsics, and the runtime explicitly freezes forwarded host constructors and `.prototype` objects before installation |
| ambient web-fetch globals | Rejected | `fetch`, `Headers`, `Request`, and `Response` are absent from authored SES compartments and undeclared by the type libraries, so reaching for one fails to compile; egress goes through the runtime's fetch graph constructors |
| `globalThis` | Controlled | Custom minimal Compartment globals; runtime freezes the compartment global object after installing bindings and does not expose internal console-hook globals |

### 11.5 Residual Observability and Fingerprinting Channels

Distinct from escape routes: channels through which sandboxed code can learn
about the host or the user without leaving the sandbox. Two classes:
**user-level** (private information about the person — location, language) and
**environment-level** (fingerprints the software build — engine, ICU/tzdata
version — roughly user-agent-granularity information). New channels discovered
in review or incident work should be added here with a class and a status.

| Channel | Reveals | Class | Status |
|---------|---------|-------|--------|
| Untamed non-locale `Date` surface: `toString()`/`toTimeString()` (zone name in words), `getTimezoneOffset()`, local getters | Host timezone outright; the exact IANA zone via historical-offset probing (zones differ in DST history) → coarse user location | user-level | Accepted for now — patterns legitimately build local-day logic on the getters. Closure path: introduce viewer timezone as an explicit data input (CT-1881), then pin the ambient surface to UTC |
| tzdata / ICU version probing: which zone names validate (newer-tzdata-only zones), formatting quirks (e.g. ICU 72's U+202F separators) | Engine / ICU / tzdata version | environment-level | Accepted; inherent to exposing real ICU formatting |
| Supported-locale-set probing through the sanitized `toLocale*` methods | Full-ICU vs small-ICU build; available locale data | environment-level | Accepted |
| Egress to an arbitrary host | User IP (→ geolocation, typically more precise than timezone) to any contacted server; general exfiltration and latency probing | user-level | Open, but named. The ambient route is gone — `fetch`, `Headers`, `Request`, and `Response` are withheld from compartments and from the type libraries — so egress goes through the fetch graph constructors, which record each request as a CFC sink request and take either an absolute URL or a relative one resolved against the executing space's host. What a deployment's sink ceilings do not gate still reaches the host the pattern names |
| Host default locale via `toLocale*` defaults or the ECMA-402 unsupported-tag fallback | User language/region | user-level | **Closed** by `locale-taming.ts`: omitted locales and the resolution fallback both pin to `"en-US"` |
| Host timezone via `toLocale*` `timeZone` defaults | User timezone | user-level | **Closed** by `locale-taming.ts`: omitted `timeZone` pins to `"UTC"`; invalid values throw (ECMA-402 has no fallback-to-host-zone path) |

---

## 12. Appendix

### A. SES Package Selection

**Recommended**: `ses` npm package (official from Agoric)

**Alternatives considered**:
- `@aspect-labs/ses` - Fork with minor fixes
- `lavamoat` - Higher-level, more opinionated
- QuickJS - Different approach (separate runtime)

### B. Glossary

- **Compartment**: SES isolation boundary with its own global object
- **Harden**: Deep freeze an object graph
- **Lockdown**: Initialize SES, freeze all intrinsics
- **Virtual module record**: SES's third-party module representation —
  `{ imports, exports, execute }` — which the runtime uses because this `ses`
  build exposes no `ModuleSource`/`StaticModuleRecord` constructor
- **Import hooks**: `resolveHook` and `importNowHook`, the callbacks a
  Compartment uses to resolve a specifier and fetch its record
- **SESRuntime**: Runtime harness that owns the shared source-map state,
  evaluates callbacks in the shared callback Compartment, and maps the stacks of
  errors thrown by the pattern execution pipeline

---

## 13. References

1. [SES (Secure ECMAScript)](https://github.com/endojs/endo/tree/master/packages/ses)
2. [Hardened JavaScript](https://hardenedjs.org/)
3. [Compartment API](https://github.com/tc39/proposal-compartments)
4. [Common Fabric Pattern Documentation](../../common/README.md)
5. [ts-transformers Package](../../../packages/ts-transformers/)
6. [js-compiler Package](../../../packages/js-compiler/)
