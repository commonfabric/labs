# TypeScript Transformers Target Pattern Language Specification

**Status:** Candidate v1 (normative target language for current hardening phase)\
**Package:** `@commonfabric/ts-transformers`\
**Related:**

- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`

## 1. Purpose

This document defines the **intended authored pattern language** that the
transformer pipeline should support.

It is not a file-by-file description of the current implementation. Instead, it
answers:

1. what authors should be allowed to write
2. which constructs are first-class parts of the language
3. which constructs are merely tolerated compatibility behavior
4. which constructs are outside the language and should diagnose clearly

If this document and the current implementation disagree on a supported or
unsupported construct family, treat the implementation as needing correction or
an explicitly recorded follow-up in the design-deltas/current-behavior docs. Do
not silently let implementation accident become language policy.

## 2. Scope

This v1 draft focuses on the **reactive expression language inside patterns**:

- supported lowered value-expression sites (`jsx-expression`,
  `return-expression`, `variable-initializer`, `call-argument`,
  `object-property`, `array-element`)
- helper-owned control flow (`ifElse`, `when`, `unless`)
- collection operators over reactive receivers
- direct reactive property/element access
- pattern-body expression forms that interact with ownership-first lowering

It does **not** attempt to restate every validation rule in the package. The
existing current-behavior spec remains the descriptive inventory for those
details.

## 3. Status Labels

Each construct family is classified as one of:

- **Supported**
  - first-class part of the intended language
- **Compatibility-only**
  - tolerated behavior for existing code, but not something we want to bless as
    a core target-language construct
- **Unsupported**
  - outside the intended language; should fail clearly or remain explicitly out
    of scope

## 4. Core Language Matrix

| Construct family | Status | Intended meaning |
| --- | --- | --- |
| `compileDiagnosticsOf()` on a direct compilation request in the producer's pattern body | Supported | The accessor returns a live sibling-cell alias without a computation. Bind it to a standalone const before deriving values, or return the alias directly. Stable const aliases of the compilation request are accepted |
| `compileDiagnosticsOf()` inside a computation, on a subpattern result, or inside an inline derived expression | Unsupported | A materialized request has no diagnostics-channel association. Capture a standalone diagnostics alias into computations and export the diagnostics separately across pattern boundaries |
| Reactive property access in JSX or helper-owned expressions | Supported | Authored reactive reads like `state.user.name` should remain natural and lower to explicit reactive access as needed |
| Reactive element access with static or known-symbol keys | Supported | Forms like `items[0]`, `item[NAME]`, `state["foo"]` should lower predictably when the access path is statically representable |
| `input[SELF]` on a pattern's own input parameter, in the pattern body, JSX, a plain-array callback, or a handler's bound state | Supported | `SELF` names the pattern's own result, and on the input the pattern body receives `input[SELF]` reads the same result as a destructured `[SELF]: self` binding, including a path read through it (`input[SELF].title`, `input[SELF].items.map(...)`), a local bound to it (`const self = input[SELF]`), and a `[SELF]` destructured off the input in the body |
| `x[SELF]` inside an explicit computation callback, inside a reactive collection callback, or on anything but the pattern's own input parameter itself | Unsupported | Only the input the pattern body receives knows the pattern's result. `computed` / `action` / `lift` / `handler` callbacks see plain values, a reactive collection callback sees a captured reference to the input, and a value read off the input or another pattern's result is not the input, so `[SELF]` on any of them is `undefined`. The receiver must be the parameter itself: a local holding the input (`const i = input; i[SELF]`) is not followed back to it, and is reported too. So is a well-known key read through `input[SELF]`, such as `input[SELF][NAME]`, which is `undefined`; `const me = input[SELF]; me[NAME]` is the form that works. The compiler reports all of these; write `input[SELF]` or destructure `[SELF]: self`, in the pattern body, and capture that local where a callback needs it. A value built from an object literal holds whatever keys it was given and is outside this row |
| Reactive ternary control flow in supported lowered value-expression sites | Supported | Authored `cond ? x : y` should preserve JavaScript branch meaning in JSX, top-level pattern-body value sites, and callback-local values inside supported collection callbacks |
| Callback-local value bindings inside a plain-array `map` callback | Supported | A plain-array `map` callback in a pattern body runs during pattern build and its result is collected rather than read, so its value-expression sites are pattern-body value sites: a binding such as `const isToday = weekDates?.[colIdx] === todayDate` inside `COLUMN_INDICES.map(...)` lowers to a per-iteration lift-applied computation, and reads the same as the equivalent binding written directly in the pattern body |
| Callback-local value bindings inside a result-interpreting array callback | Unsupported | `filter`, `find`, `some`, `every`, `sort`, `flatMap`, and `reduce` read what their callback returns while they run — as a boolean, a number, an array test, or the next accumulator. A lifted binding returned from one of those is a cell rather than the value the method expects, so these callbacks carry no pattern-owned wrapper site and a reactive computation in one still moves into `computed(...)` |
| Reactive logical control flow in supported lowered pattern-owned expression sites (`&&`, `||`, `??`) | Supported | Reactive short-circuiting should preserve authored JavaScript meaning where the expression-site policy admits lowering |
| Authored helper control flow (`ifElse`, `when`, `unless`) | Supported | These are first-class reactive control-flow forms, not mere implementation helpers |
| `map` / `filter` / `flatMap` on reactive receivers in pattern-facing contexts | Supported | These operators are core language forms and may be structurally rewritten to explicit reactive collection operators |
| Keyed indexes on explicit array-valued cells | Supported | `groupBy` and `keyBy` accept one-element selectors and return typed lookup handles. Cell keys denote identity; primitive keys denote values; nullish keys omit the occurrence. Index and whole-array selector parameters are not supported; see [index documentation](../../features/collection-indexes.md) |
| Named aggregates on explicit array-valued cells | Supported | `count`, `sum`, `min`, `max`, `minBy`, and `maxBy` build reactive aggregates. Predicate and score callbacks lower to per-element patterns. Ordinary array-typed receivers do not expose these extra methods through the public types; see [aggregate contracts](../../features/collection-aggregates.md) |
| Callback-local plain JS arrays in rewritten callbacks | Supported | Plain JS arrays inside callbacks stay plain; they are not implicitly promoted into pattern-owned array operators |
| Direct JSX sink chains over structural array results | Supported | Terminal sink chains like `.filter(...).join(", ")` and ordinary receiver-method chains above that sink are valid JSX expression forms |
| Receiver-method calls inside JSX expressions, explicit computation callbacks, or authored helper control flow | Supported | Receiver methods are valid in local authored expression contexts such as JSX interpolation, `computed` / `action` / `lift` / `handler` callbacks, and helper control flow branches like `ifElse(show, name.trim(), "fallback")` |
| Event-handler JSX attributes | Supported | Event handlers form an explicit callback boundary; they are part of the language but not part of ordinary expression-site lowering |
| Dynamic key access inside JSX expressions, explicit computation callbacks, supported collection callbacks, or structural binding forms | Supported | Dynamic access like `selectedScopes[key]` is valid in local authored expression contexts or in binding forms that preserve the dynamic key directly |
| Bare dynamic key access in top-level pattern-facing code | Unsupported | Forms like `input[key]` as a direct top-level pattern-body traversal are outside the intended declarative language and should move into JSX, an explicit computation callback, a supported collection callback, or a structural binding form |
| Cell-style `.key(...)` traversal on explicitly cell-like values | Supported | When the authored value is truly `Cell`/`Writable`/`Stream`-like, `.key(...)` remains part of that value's direct API rather than an implementation artifact |
| Cell-style `.get()` reads on explicitly cell-like values inside JSX expressions, authored helper control flow, or explicit computation callbacks | Supported | Eager cell reads remain valid when authored in JSX interpolation, helper control flow such as `ifElse` / `when` / `unless`, and explicit computation callbacks such as `computed`, `action`, `lift`, and `handler` |
| Foreign callback / imperative container roots in JSX | Unsupported | Shapes like `[0, 1].forEach(() => list.map(...))` are not part of the intended reactive language core and should move into supported value expressions, wrappers, or helpers |
| Residual callback-container pass-through behavior for invalid programs | Compatibility-only | Some invalid callback-container shapes may still survive as plain JS in current emitted output, but that is residual implementation behavior rather than supported language policy |
| Optional receiver navigation and optional invocation on otherwise-supported call roots | Supported | Optionality does not define a separate call family: `value?.method()`, `value.method?.()`, and combined chains lower wherever the corresponding non-optional call is supported, with receiver binding, evaluation order, nullish short-circuiting, and skipped argument evaluation preserved |
| Direct non-JSX receiver-method calls on reactive values in top-level pattern-body expression sites | Supported | Value-like receiver-method roots at top-level object-property, call-argument, variable-initializer, array-element, or return-expression sites lower to derived local value expressions |
| Direct receiver-method roots inside supported collection callbacks | Supported | Callback-local value-like receiver-method roots lower to callback-local lift-applied computations instead of remaining raw or requiring manual wrapper calls |
| Direct top-level `.get()` reads on explicitly cell-like values at a lowerable expression site | Supported | On a true `Cell`/`Writable`/`Stream`, an eager read is part of the language wherever a lowerable expression site can carry it: a variable initializer, a return, an object property, an array element, a call argument, a computation over the read, or a call whose receiver chain reaches it. That site lowers into a lift, so the read stays live rather than freezing. Parentheses, the computed-key spelling `cell["get"]()`, and the optional spellings `cell?.get()` / `cell.get?.()` do not change the classification |
| Direct top-level `.get()` reads with no lowerable expression site | Unsupported | A read with nothing to carry it stays outside the language, because there is no site to lower into a lift: statement position (`count.get();`) and a reactive array-method callback (`rows.map((row) => row.cell.get())`), whose callback becomes a sub-pattern over per-element cells rather than pattern-body code. These move into an explicit computation callback such as `computed`, `action`, `lift`, or `handler` |
| `.get()` on ordinary opaque/reactive values | Unsupported | Pattern inputs, `computed` results, `lift` results, and other ordinary reactive values should be read directly rather than through `.get()` |
| Statement-boundary imperative constructs in top-level pattern-owned code (`let`, loops, function creation, early return) | Unsupported | Top-level pattern context is intentionally declarative; imperative statement structure belongs in explicit callback bodies such as `computed`, `action`, `lift`, or `handler` |

## 4.1 Authoring Context Guide

The matrix above is the policy summary. This section states the same boundary
in author-facing terms: **what kinds of expressions belong in each authored
context.**

### Supported Lowered Value-Expression Sites

The shared lowering model starts from a small set of recognized authored
container kinds:

- `jsx-expression`
- `return-expression`
- `variable-initializer`
- `call-argument`
- `object-property`
- `array-element`

Those container kinds appear to authors in three main buckets:

1. JSX expressions
2. top-level pattern-body value-expression sites such as returned object
   property values, variable initializers, call arguments, array elements, and
   direct function return expressions
3. callback-local value-expression sites inside supported collection
   callbacks, both the reactive operators and plain-array `map` callbacks

Explicit computation callbacks such as `computed`, `action`, `lift`, and
`handler` are important boundaries, but their bodies are **not** blanket
"lower everything here" regions. The shared container list above does not imply
that nested compute-context JSX/control-flow receives pattern-context lowering;
current-main behavior preserves authored JavaScript control flow there.

### Top-Level Pattern Body

The top-level pattern body should stay declarative.

**Good here**

```ts
// Shown for illustration only.
pattern(({ items, show }) => ({
  upper: items[0].name.toUpperCase(),
  maybeUpper: items[0]?.name?.toUpperCase?.(),
  title: show ? "Visible" : "Hidden",
  visibleCount: ifElse(show, items.length, 0),
  [UI]: <div>{items.map((item) => item.name)}</div>,
}));
```

**Move elsewhere**

```ts
// Shown for illustration only.
pattern(({ count }) => {
  count.get();
  return { value: 1 };
});
```

Why:

- top-level pattern-body value-expression sites participate in the shared
  lowering model
- top-level helper control flow is part of the language
- top-level receiver-method roots are supported at lowerable non-JSX
  expression sites
- an eager `.get()` read on a true cell is supported wherever a lowerable
  expression site carries it, so `{ value: count.get() }` belongs here; a read
  in statement position has no such site and moves into an explicit
  computation callback

### JSX Expressions

JSX is the main local reactive expression context.

**Good here**

```tsx
// Shown as JSX element children.
<div>
  {user.name.toUpperCase()}
  {user.name?.toUpperCase?.()}
  {selectedScopes[key]}
  {ifElse(show, count.get(), 0)}
  {items.filter((item) => item.visible).join(", ")}
</div>
```

**Unsupported here**

```tsx
// Shown for illustration only.
<div>{[0, 1].forEach(() => list.map((item) => item))}</div>
```

Why:

- JSX supports local reactive reads, control flow, receiver methods, supported
  collection callbacks, and true-cell eager reads
- JSX does not bless foreign imperative callback containers as language forms

### Explicit Computation Callbacks

`computed`, `action`, `lift`, and `handler` callbacks are explicit
imperative/value-computation boundaries.

**Good here**

```ts
// Shown inside a pattern body.
computed(() => input[key])
computed(() => count.get())
computed(() => input.name?.trim?.())
action(() => state.name.trim())
```

**Still unsupported here**

```ts
// Shown inside a pattern body.
computed(() => derivedValue.get())
computed(() => input[SELF])
```

Why:

- dynamic access, receiver methods, and true-cell eager reads are valid here
- `.get()` on ordinary opaque/reactive values is still not part of the
  language, even inside a computation callback
- `input[SELF]` looks like any other key read off the input, and dynamic access
  such as `computed(() => input[key])` is valid here, but the callback sees the
  input as a plain value, on which `SELF` names nothing; `const self =
  input[SELF]` in the pattern body, captured here, is the form that works

### Where A Builder's Callback May Come From

A trusted builder's callback is written at the call, or named by a binding the
same module declares. Those are the two shapes the module verifier can follow,
and a module that uses any other is refused at load
(`docs/specs/sandboxing/SES_SANDBOXING_SPEC.md`, goal 3 "Direct Callback
Builders"), so the compiler rejects them instead.

**Good here**

```ts
// Shown at module scope.
const atTheCall = lift((n: number) => n + 1);
const double = (n: number) => n * 2;
const byName = lift(double);
function triple(n: number) {
  return n * 3;
}
const byDeclaration = lift(triple);
```

**Still unsupported here**

```ts
// Shown at module scope.
declare const callbacks: { double: (n: number) => number };
declare const importedDouble: (n: number) => number;
const viaProperty = lift(callbacks.double);
const viaImport = lift(importedDouble);
```

Why:

- the verifier reads one module at a time, so a callback whose body it cannot
  see at this call is indistinguishable from a computed one
- naming the function in this module costs one line and keeps the callback
  where every later stage — schema injection, hoisting, and the verifier —
  already looks for it

### Event Handler JSX Attributes

Event handlers are an explicit callback boundary for imperative UI logic.

**Good here**

```tsx
// Shown as JSX element children.
<button onClick={() => count.set(count.get() + 1)} />
```

Why:

- imperative statements and eager reads belong naturally inside the event
  handler callback boundary
- event handlers are part of the language, but they are not ordinary
  expression-site lowering roots

### Supported Collection Callbacks

Callbacks for supported reactive collection operators are their own authored
expression context. A plain-array `map` callback shares it: it runs during
pattern build and `map` collects what it returns without reading it, so a value
site in one is a pattern-body value site.

**Good here**

```ts
// Shown inside a pattern body.
items.map((item) => item.name)
items.map((item) => item.toUpperCase())
items.map((item) => item?.toUpperCase?.())
items.map((item) => identity(item.toUpperCase()))
items.map((item) => ifElse(item.active, item.name, "hidden"))
items.map((item) => <span>{item.name.toUpperCase()}</span>)
```

Why:

- the outer callback belongs to the supported reactive collection operator
- callback-local value-expression sites participate in the shared lowering model
- structural access, receiver-method value expressions, helper control flow,
  and nested JSX-local expressions are valid here
- inner plain arrays stay plain JS and are not implicitly promoted into
  pattern-owned collection operators
- a plain-array `map` callback's own value sites lower too, so naming a value
  there reads the same as writing the expression where the name is used
- the array callbacks that read their result as they run — `filter`, `find`,
  `some`, `every`, `sort`, `flatMap`, `reduce` — do not lower callback-local
  value sites. A lift returned to one of them is a cell where the method wants
  a boolean, a number, or an array, so a reactive computation in one belongs in
  `computed(...)`
- a read of a reactive operator's own per-element binding does not lower
  either: `rows.map((row) => row.cell.get())` makes its callback a sub-pattern
  over per-element cells, and the read has no pattern-body site to become a
  lift

A plain-array map in JSX, with the per-column comparison named before it is
used as a condition:

```tsx
// Shown as JSX element children.
{COLUMN_INDICES.map((colIdx: number) => {
  const isToday = weekDates?.[colIdx] === todayDate;
  return <div>{isToday ? "Today" : ""}</div>;
})}
```

## 4.2 Common Relocation Patterns

When an authored form is unsupported, the right answer is usually to move it
into a context that already has a clear language meaning.

### Site-Less Eager `.get()` -> Computation Callback

An eager read on a true cell needs a lowerable expression site to become a
lift. A read in statement position, or inside a reactive array-method
callback, has none, so it moves into a callback that supplies one.

**Avoid**

```ts
// Shown for illustration only.
pattern(({ rows }) => ({
  titles: rows.map((row) => row.title.get()),
}));
```

**Prefer**

```ts
// Shown for illustration only.
pattern(({ rows }) => ({
  titles: computed(() => rows.map((row) => row.title.get())),
}));
```

A read that already has a site needs no relocation — `{ value: count.get() }`,
`const total = rows.get().length`,
`["-", "+"].map((sep) => rows.get().join(sep))`, and
`{ifElse(show, count.get(), 0)}` are all part of the language as written.

### Bare Dynamic Key Access -> JSX, Callback, Or Structural Binding

**Avoid**

```ts
// Shown for illustration only.
pattern(({ selectedScopes, key }) => ({
  value: selectedScopes[key],
}));
```

**Prefer**

```tsx
// Shown for illustration only.
pattern(({ selectedScopes, key }) => ({
  [UI]: <div>{selectedScopes[key]}</div>,
}));
```

or:

```ts
// Shown for illustration only.
pattern(({ selectedScopes, key }) =>
  computed(() => selectedScopes[key])
);
```

### Foreign Callback Container -> Supported Wrapper Or Helper

**Avoid**

```tsx
// Shown for illustration only.
<div>{[0, 1].forEach(() => list.map((item) => item))}</div>
```

**Prefer**

```tsx
// Shown as JSX element children.
<div>{computed(() => list.map((item) => item))}</div>
```

or move the imperative container entirely outside the pattern-facing expression
site into a named helper or handler.

### Optional Calls Follow The Underlying Call Policy

Optionality does not make an otherwise unsupported call legal, and it does not
make an otherwise supported call ambiguous.

```ts
// Shown for illustration only.
pattern(({ maybeName }) => ({
  result: maybeName?.trim?.(),
}));
```

The compiler lowers the whole call expression and preserves JavaScript's
receiver binding and short-circuit behavior. A function-valued pattern input is
still outside the reactive data model whether invoked as `fn()` or `fn?.()`:
the problem in that case is the unstorable function value, not optional-call
syntax. Put behavior in a module-scope helper, `lift`, or `handler` instead of
placing a function in reactive data.

## 5. Construct Notes

## 5.1 JSX Is A Routing Boundary, Not A Separate Semantic World

JSX is part of the authored language, but it is not a privileged semantic
universe. The intended model is:

1. JSX sites may require special routing because of phase/ownership concerns
2. the semantics supported inside JSX should otherwise match the same language
   rules we would want outside JSX

Any rule that is hard to state without saying “because JSX” is a sign that the
implementation boundary may still need cleanup.

## 5.2 Helper Control Flow Is Part Of The Language

`ifElse`, `when`, and `unless` are not merely output artifacts. They are part of
the intended reactive source language as well:

- authors may write them directly
- the compiler may also lower ordinary JS control flow into them

So the language should treat authored helper control flow and lowered helper
control flow as semantically aligned.

## 5.3 Collection Operators Are Contextual

The same method names do not mean the same thing in every context.

The intended rule is:

1. on reactive receivers in pattern-facing contexts, `map` / `filter` /
   `flatMap` are language operators and may be structurally rewritten
2. on plain JS arrays or compute-owned plain values, the same methods stay
   ordinary JS

This distinction is part of the language, not an incidental optimizer detail.

A reactive receiver guarded by a nullish/`||` array fallback —
`(items ?? []).map(...)`, `(items || []).filter(...)`,
`(items ?? []).flatMap(...)`, including cast-/`satisfies`-wrapped reactive left
sides — is **supported** and lowers as a reactive collection operator. (An
earlier `pattern-context:map-on-fallback` error rejected this shape; it was
removed when this boundary was drawn.)

## 5.4 Callback / Container Boundary Is Four-Way Split

The callback/container boundary should be read in four distinct buckets:

1. **supported reactive collection callbacks**
   - examples:
     - `items.map((item) => item.name)`
     - `items.map((item) => item.toUpperCase())`
   - why:
     - the callback belongs to a supported language operator over a supported
       receiver family
2. **supported terminal sink chains over structural array values**
   - examples:
     - `<div>{items.filter((item) => item.visible).join(", ")}</div>`
     - `<div>{items.map((item) => item.name).join(", ")}</div>`
   - why:
     - these are still value expressions over structural array results, not
       foreign callback-container roots
3. **unsupported foreign callback / imperative container roots**
   - examples:
     - `<div>{[0, 1].forEach(() => list.map((item) => item))}</div>`
     - `<div>{somePromise.then(() => list.map((item) => item))}</div>`
   - why:
     - the outer wrapper is not a target-language operator or local value
       expression context; it is a foreign imperative container
4. **compatibility-only residual pass-through for invalid programs**
   - meaning:
     - if a shape from bucket 3 still survives as plain JS in current emitted
       output, that is residual implementation behavior rather than language
       policy

This is why callback-container pass-through is not a language goal. If a
construct is only supportable by compatibility behavior such as:

1. leaving the foreign container authored as plain JS
2. or, in older/rarer cases, wrapping the whole foreign container as one
   compute island

that is strong evidence it should be rejected from the target language rather
than elevated into the core language.

One important nuance: an explicit wrapper like `computed(() => list.map(...))`
is supported because `computed` creates a supported computation boundary around
an inner value expression. That does **not** make foreign containers like
`forEach(...)` or `then(...)` themselves part of the language.

## 5.5 Dynamic Key Access Is Context-Split

Dynamic key access is not one single language category.

The intended split is:

1. **dynamic access inside local expression contexts or structural binding
   forms**
   - allowed when written inside JSX expressions, explicit computation
     callbacks, supported collection callbacks, or a binding form that
     preserves the dynamic key structurally
   - examples:
     - `computed(() => input[key])`
     - JSX-local `{input[key]}`
     - JSX-local derived checkbox bindings
     - callback-local wrapped expressions
     - captured dynamic element access inside rewritten collection callbacks
     - computed binding-key destructuring like `({ [key]: foo }) => ...`
2. **bare top-level pattern traversal**
   - not part of the target language
   - examples:
     - direct `input[key]` in a top-level pattern body expression

This is why the target-language matrix treats the two forms differently.

## 5.6 Receiver-Method Calls Are Context-Split

Receiver-method calls are also not one single language category.

The intended split is:

1. **direct top-level non-JSX pattern-body receiver calls**
   - part of the target language at lowerable top-level expression sites
   - examples:
     - `{ upper: state.name.toUpperCase() }`
     - `const upper = identity(state.name.trim())` in top-level pattern code
2. **receiver-method calls inside explicit local expression contexts**
   - valid as part of those local expression contexts
   - examples:
     - JSX expression sites like `{state.name.toUpperCase()}`
     - `computed(() => state.name.toUpperCase())`
     - `action(() => state.name.trim())`
     - `ifElse(show, state.name.trim(), "fallback")`
     - `items.map((item) => item.toUpperCase())`
     - `items.map((item) => identity(item.toUpperCase()))`
3. **optional receiver and invocation forms of supported calls**
   - part of the same target-language call family
   - examples:
     - `{ upper: input.name?.trim?.() }`
     - JSX expression sites like `{input.name?.trim?.()}`
     - `computed(() => input.name?.trim?.())`
     - `items.map((item) => item?.toUpperCase?.())`
   - lowering preserves:
     - single evaluation of the receiver and callee
     - the original `this` binding
     - nullish short-circuiting
     - non-evaluation of arguments when invocation short-circuits
4. **calls that are already outside the language**
   - remain unsupported with or without `?.`
   - examples:
     - a statement-position receiver call in the top-level declarative pattern
       body
     - invocation of a function value supplied through reactive pattern data

So the language should not be read as “receiver methods are unsupported.” The
real rule is that **receiver methods are supported in explicit local expression
contexts, inside supported collection callbacks, and at lowerable top-level
non-JSX pattern sites, and optionality does not change that classification**.
Optional property / element access and optional invocation follow the ordinary
lowerable expression-site and call-root rules. Standalone functions and
execution callbacks such as `action`, `lift`, and `handler` retain ordinary
JavaScript behavior as before.

## 5.7 `.key(...)` And `.get()` Are Cell-Semantics-Split

Path-terminal cell-style APIs should not be described as one coarse bucket.

The intended split is:

1. **true cell-style traversal**
   - `.key(...)` on explicitly declared `Cell` / `Writable` / `Stream`-like
     values is part of the authored language
   - example:
     - `input.key("foo")` where `input` is a declared `Writable<{ ... }>`
2. **true cell-style eager read inside an explicit computation callback**
   - `.get()` is ordinary eager reading inside a `computed` / `lift` /
     `handler` / `action` body, where the callback already supplies the
     compute context
   - examples:
     - `computed(() => input.key("foo").get())`
     - `lift` / `handler` / `action` callbacks that preserve declared cell
       semantics
3. **true cell-style eager read at a lowerable expression site**
   - `.get()` is part of the authored language in pattern-owned context
     wherever a lowerable expression site can carry it; that site lowers into
     a lift, which is what keeps the read live instead of freezing it to a
     construction-time snapshot
   - the qualifying sites are the variable initializer, the return, the object
     property, the array element, the call argument, a computation over the
     read, a call whose receiver chain reaches the read, and the JSX
     expression
   - examples:
     - `{ value: input.key("foo").get() }` in a top-level pattern body
     - `const total = rows.get().length`
     - `const sorted = rows.get().toSorted(byDate)`
     - JSX expression sites like `{input.key("foo").get()}`
     - `ifElse(show, count.get(), 0)`
   - the spelling of the read does not change the classification
     (paren-invariance): parentheses around the site, the computed-key form
     `cell["get"]()`, and the optional forms `cell?.get()` and `cell.get?.()`
     all follow the same rule (§5.6)
4. **eager read with no lowerable expression site**
   - not part of the target language, even for true cells — there is no site
     to lower into a lift, so the read cannot be kept live
   - examples:
     - statement position: `count.get();`
     - a reactive array-method callback: `rows.map((row) => row.cell.get())`,
       whose callback becomes a sub-pattern over per-element cells
   - a plain-array `map` callback is not an example: it runs during pattern
     build and collects what it returns, so its value sites carry the read the
     way the pattern body's own sites do. Its result-interpreting siblings
     (`filter`, `find`, `sort`, and the rest) remain examples
5. **`.get()` on ordinary opaque/reactive values**
   - not part of the target language
   - examples:
     - `input.get()` where `input` is an ordinary pattern value
     - `computedResult.get()`

So the language should not be read as “`.get()` / `.key()` are transitional.”
The real rule is:

- `.key(...)` is a real source-level API for true cell-like values
- `.get()` is valid when the value truly has cell semantics **and** the read
  either sits inside an explicit computation callback or has a lowerable
  expression site to carry it
- ordinary opaque/reactive values should still prefer direct property access
  and canonical lowered traversal rather than authored `.get()`

The site rule is deliberately about the site rather than the shape of the
read. A terminal read and a read feeding a computation are the same construct
at the same site, and an author who extracts a JSX expression into a named
binding is refactoring, not changing what their program means — so both
spellings resolve the same way.

## 5.8 Verb Results Are Declared, Never Inferred

A verb (an `action(...)` or `handler(...)` body) that produces a value for
its caller declares it by naming the result type argument —
`action<Event, Result>(...)` / `handler<Event, State, Result>(...)` — so the
schema layer can see it (verb contract WS-C). Inference is deliberately
unavailable: the void overloads absorb every callback, because a concise
body's completion value is whatever its last call returns (`Cell.set` returns
the cell) and an incidental return must never declare a result nobody wrote.

Consequently, under a void-declared verb, a block body's explicit
`return <expr>` of a **definitely plain-shaped** expression — object/array
literal, string/number/boolean/null literal, template string, or
arithmetic/concatenation over those — is a compile-time error
(`verb-result:undeclared-return`): plain data returned without a declaration
is a value the verb's contract never announces — no caller can rely on it.
The fix the diagnostic names is declaring the result, or a bare `return;`
for an early exit.

Everything else stays legal, deliberately: concise bodies (the absorption
rule above), bare `return;` / `return undefined;` (control flow), and
returns of calls, identifiers, property reads, or JSX — the
launch/navigation/render idioms (`return navigateTo(piece)`, returning a
freshly created piece, returning rendered UI) that the runtime consumes
without a declaration. The authored surface renders `Reactive<T>`
transparently, so these cannot be told apart from plain values by type;
the boundary is syntactic and is pinned in
`test/verb-return-validation.test.ts`.

## 6. Non-Normative Hardening Follow-Ups

These are implementation/documentation follow-ups, not unresolved v1 language
questions:

1. remove residual invalid-program callback-container pass-through where
   feasible; until then it remains compatibility-only and may disappear without
   language change
2. keep the explicit-cell `.key(...)` / `.get()` boundary documented
   consistently across diagnostics, examples, and specs; any future narrowing
   would be a later language revision rather than an unresolved v1 semantic
3. preserve typed-input/schema continuity tests around explicit cell-like
   inputs without promoting direct top-level `.get()` reads into the language
4. preserve the optional-call evaluation model with golden coverage for
   receiver optionality, invocation optionality, combined chains, receiver
   binding, and lazy argument evaluation

## 7. Use This Spec

When a construct is hard to classify cleanly, do not paper over the difficulty.
Instead ask:

1. is this really part of the intended language?
2. is the implementation boundary still leaking through?
3. should this be reworked, demoted to compatibility-only, or rejected
   outright?

That is the intended role of this document: to make those decisions explicit.
If current implementation behavior still differs, record that as a follow-up in
the descriptive docs rather than softening this spec by accident.
