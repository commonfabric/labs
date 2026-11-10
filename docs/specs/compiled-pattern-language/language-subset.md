# Language subset (proposed)

**Status:** proposed. Nothing here is implemented. This document details one
part of the [compiled pattern language](README.md): the language itself. It
defines the TypeScript subset, its type rules, how labels are read, the
statelessness rule, the promotion of `computed`, the diagnostics, and the
standard-library surface the subset type checker has to type. It ends with a
measurement of the pattern corpus against these rules and with the questions
that remain open.

Two documents beside this one are written in parallel and own their subjects.
This document refers to them and does not define their content.

- `plan-and-label-templates.md` owns the plan format, slots, observation
  classes, footprints, and the label rule of every operation.
- `builtin-inventory.md` owns the classification of each built-in as a
  structural or an effectful operation, and each built-in's label rule.

Where this document needs a fact that belongs to one of them, it states the
assumption it made and lists it under [Open questions](#13-open-questions).

## 1. Terms

**Program.** The set of modules reachable by static import from one entry
module.

**Module scope (tier M).** The top level of a module. It is not one of the
three tiers of the overview, but it has a grammar of its own, and the
statelessness rule is mostly a rule about it.

**Reactive tier (tier R).** The body of a `pattern(...)` callback, the bodies
of the callbacks of the reactive collection methods inside it, and the body of
a promoted `computed`.

**Function tier (tier F).** The body of a callback given to `lift`, `handler`,
`computed` (when not promoted), or `action`; the body of an inline JSX event
handler; and the body of a function declared at module scope of a module in
the subset.

**Imported tier (tier I).** A module that begins with the directive
`"use typescript";`. It is not checked against the subset. The compiler reads
the annotated signatures of its exports and nothing else
([§5.5](#55-imported-typescript-tier-i)).

**Authored function.** A function declared at module scope, in tier F or in
tier I. A builder result (`lift(...)`, `handler(...)`, `pattern(...)`) is not
an authored function. It is a builder definition.

**Data type and code type.** A data type describes a value the runtime can
store: it has a schema. A code type describes a value that exists only while
a function runs, such as a function value, a `Map`, or an `Error`. Every type
is one or the other, and a type that contains a code type is a code type.

**Diagnostic.** A refusal or a warning with an identifier, a condition, and a
message that says what to write instead. Identifiers have the form
`family:name`, as the transformer's do today.

## 2. Design rules

Five rules decide the cases the rest of this document does not list.

1. **Valid TypeScript.** Every program in the subset parses as TypeScript and
   as TSX. The subset adds no syntax.
2. **Accepted programs type-check in an editor.** A program the subset type
   checker accepts is also accepted by the TypeScript compiler against the
   published `commonfabric` typings, so an editor shows no error the compiler
   does not also report. The reverse does not hold: the subset refuses
   programs TypeScript accepts. One deliberate exception is listed in
   [§8.6](#86-assignability).
3. **A refusal names the replacement.** No construct is refused without a
   catalog entry in [§10](#10-diagnostics-catalog) whose message contains the
   rewrite. Most authors of patterns are language models, and a message that
   only says "unsupported" costs a round trip.
4. **A construct means one thing per tier.** `?:` is a reactive operation in
   tier R and ordinary JavaScript in tier F. The tier is decided by syntax
   alone, never by a type.
5. **Not being promoted, and losing footprint precision, are not errors.**
   They cost label precision and performance. They are reported at a severity
   the author can ignore.

## 3. Module scope (tier M)

### 3.1 Statements

A module in the subset consists of the following statements and no others.

| Statement | Allowed forms |
| --- | --- |
| Import | `import { a, type B } from "..."`, `import d from "..."`, `import * as ns from "..."`, `import type ...`. Specifiers: `commonfabric`, `commonfabric/<name>`, a relative path to another module of the program, or a pinned `cf:` specifier |
| Type declaration | `type` alias, `interface`, each optionally exported and optionally generic ([§7](#7-type-system)) |
| Function declaration | `function name(...) { ... }`, optionally exported. Not `async`, not a generator, no overload signatures |
| Constant declaration | `const name = initializer`, optionally exported, with exactly one of the initializer kinds of §3.2. A type annotation is optional. Destructuring is allowed only for frozen data |
| Export | `export { a, b as c }`, `export { a } from "..."`, `export * from "..."`, `export type { T }`, `export default name`, `export default pattern(...)` |

Refused at module scope: `let`, `var`, `class`, `enum`, `namespace`,
`declare global` and module augmentation, an import with no bindings, an
expression statement, a control-flow statement, a block, and top-level
`await`. An ambient `declare const` emits nothing and is allowed.

### 3.2 Initializer kinds

Every `const` at module scope is one of three kinds, decided by the syntax of
its initializer after parentheses, `as`, and `satisfies` are removed.

**Builder definition.** A call to a module-scope builder. The builders are
`pattern`, `lift`, and `handler`, and the further module-scope builders that
`builtin-inventory.md` lists (for example `exchangeRules`, `toSchema`, and
`dataFile`). The callback argument is a function written at the call, or the
name of a function or function-valued constant declared in the same module.
A callback reached through a property, an import, or a call is refused
(`builder-callback:indirect-reference`).

**Function.** An arrow function or a function expression written in place. It
is an authored function, exactly as a function declaration is.

**Frozen data.** Any other expression. It is evaluated once when the module
loads, and the value is frozen deeply before any function can observe it. Its
type must be a data type, or a `ReadonlyMap`, `ReadonlySet`, or `RegExp` of
data types. The expression may call authored functions and pure
standard-library functions, may be an immediately invoked function, and may
read other module-scope constants declared earlier or imported. It may not
read the ambient clock or entropy, call a builder, or call an effectful
built-in.

```ts
// Shown for illustration only.
const GLAZES = ["plain", "sugar", "chocolate"] as const; // frozen data
const PRICE_BY_GLAZE = new Map([["plain", 2], ["sugar", 3]]); // frozen data
const MENU = buildMenu(GLAZES); // frozen data: the result is frozen
const buildLabel = (name: string) => `${name} donut`; // function
const DonutCard = pattern<CardInput>(({ donut }) => ({ donut })); // builder
```

### 3.3 The statelessness rule

**Rule.** No binding that outlives one call of a function holds mutable
state. The compiler checks four conditions, and reports each.

1. Module scope declares no `let` and no `var`
   (`module-scope:let-declaration`, `module-scope:var-declaration`).
2. Module scope declares no class (`module-scope:class-declaration`). A class
   has a mutable prototype and mutable statics.
3. Every frozen-data constant has a deeply read-only type. The compiler
   infers `readonly` arrays and tuples, read-only properties, `ReadonlyMap`,
   and `ReadonlySet` for it, whatever the initializer's own type was. A write
   through such a value is then a type error at the write
   (`module-scope:frozen-data-write`): an assignment to a member, `delete`,
   an increment, or a call of a mutating method such as `push`, `sort`, `set`,
   or `clear`. Passing the value where a mutable type is expected is a type
   error too, because a read-only type is not assignable to its mutable
   counterpart ([§7.5](#75-assignability)).
4. A `RegExp` held at module scope has neither the `g` nor the `y` flag
   (`module-scope:stateful-regexp`), since `lastIndex` is state.

A function value cannot be frozen data, because a function type is a code
type. So a function exists at module scope only as an authored function or
as a builder's callback, both written in place, and never as the result of a
call. A function body may create closures over its own locals. Such a closure
lives in locals, arguments, and return values, and dies with the call,
because no binding that outlives the call can hold it, and a cell cannot
store a function.

Assignment to a global or to a member of a global is refused
(`function-body:global-write`), for the same reason.

**Emitted code.** The compiler emits the freeze of each frozen-data constant
and the hardening of each authored function. Map and Set values are frozen so
that their mutators throw, which freezing the object alone does not achieve.

### 3.4 Comparison with the current enforcement

The rule is the one
[`SES_SANDBOXING_SPEC.md`](../sandboxing/SES_SANDBOXING_SPEC.md) §4.2 states
and the module verifier enforces
(`classifyModuleItems` in
`runtime/runner/src/sandbox/compiled-bundle-verifier.ts`). The three
initializer kinds are §4.2.1 (trusted builder definitions), §4.2.2 (direct
top-level functions), and §4.2.3 (verified module-safe data). What changes is
where and how the rule is checked.

| Aspect | Current system | This language |
| --- | --- | --- |
| Who checks | The verifier recognizes a small emitted grammar at load and refuses anything else. The transformer mirrors some refusals so that they arrive at compile time (`module-scope:let-declaration`, `builder-callback:indirect-reference`) | The compiler checks the source. Each refusal is a source diagnostic with a replacement |
| Mutable data behind `const` | The verifier requires `__cf_data(...)` around an object literal, an array literal, a regular expression, or a `new` expression (`isRawMutableExpression`), and the helper freezes the value at load. A later write throws at run time | The same freeze is emitted. In addition the value has a read-only type, so the write is a compile error |
| Call results at module scope | Allowed only inside `__cf_data(...)`. The surviving value is validated as plain data at load | Allowed when the result type is a data type. The type check replaces the load-time shape validation for authored code; the freeze stays |
| Classes | Refused at load ("Top-level class declarations are not allowed in SES mode") | Refused at compile time. Also refused inside function bodies ([§5](#5-function-tier-tier-f)) |
| `let` and `var` | Refused at load when not exported; an exported one compiles to an assignment to `exports` and is refused only by the transformer | Refused at compile time in both forms, by one rule |
| Builder callbacks | `verifyTrustedBuilderCall` accepts a function at the call or a local name | Unchanged |
| Stateful `RegExp` | Refused when the value is frozen | Refused at compile time from the literal's flags; a `RegExp` built by `new RegExp(...)` at module scope is still checked when frozen |
| Ambient clock and entropy | Gated at run time: coarse in a handler, refused in a `lift`, a `computed`, and the pattern body (`createGatedDate` in `compartment-globals.ts`) | The same gate stays. The compiler also reports the read where it can see it (`function-body:ambient-read`) |

The compiler is trusted, so for a module in the subset the compiler's check
is the only one: the load-time verifier does not run on it, and the emitted
code no longer has to stay inside the grammar the verifier recognizes. The
verifier stays for tier-I modules, whose function bodies the compiler does
not analyze ([§5.5](#55-imported-typescript-tier-i)).

## 4. Reactive tier (tier R)

### 4.1 Pattern callback

The callback of `pattern(...)` is an arrow function or a function expression
written at the call. It is not `async` and not a generator. It has zero
parameters or one. The parameter is an identifier or an object destructuring
pattern with static keys; a destructured property may be renamed, and may be
the well-known key `[SELF]`. Default values and rest elements in the
parameter are refused (`pattern-context:parameter-form`): a default belongs
in the input type as `Default<T, V>`, where the schema can see it.

The input type comes from the first type argument of `pattern`, or from the
parameter's annotation. The result type comes from the second type argument,
from the callback's return annotation, or is inferred from the returned
expression.

### 4.2 Statements

The body is an expression, or a block that consists of the following
statements in any order, followed by exactly one `return` with an expression.

| Statement | Rule |
| --- | --- |
| `const` declaration | One or more declarators, each with an initializer that is a tier-R expression. Object and array destructuring with static keys is allowed. Defaults and rest elements are allowed in a destructuring of a plain (non-reactive) value only |
| Expression statement | Only a call whose result is deliberately unused and that the plan records: `computed(...)` in statement position (a computation that writes), a call of a `lift` result, a call of an authored function, or a pattern instantiation |
| `type`, `interface` | Allowed. They declare types and emit nothing |
| `return` | Exactly one, last, with an expression |

Everything else is refused: `let`, `var`, assignment, `if`, loops, `switch`,
`try`, `throw`, an early or a second `return`, a function declaration, a
class, a labeled statement, and an expression statement that is not one of
the calls above. Each has a diagnostic in §10 that names the tier-F construct
to move the code into.

The same statement rules apply to the body of a reactive collection callback.

### 4.3 Expressions

A tier-R expression is built from the forms in this table. "Operation" names
the plan operation the form lowers to; the label rule of each operation is
defined in `plan-and-label-templates.md`.

| Form | Rule | Operation |
| --- | --- | --- |
| Literal | String, number, boolean, `null`, `undefined`, bigint, a template literal without a tag, a regular expression without the `g` or `y` flag | Constant |
| Identifier | A `const` of the body, a parameter, a module-scope constant, an import | Reference |
| Property access `a.b`, `a?.b` | Static name | Path projection |
| Element access `a[k]`, `a?.[k]` | Static when `k` is a literal, a module-scope constant of literal type, or a well-known key (`UI`, `NAME`, `SELF`, and the others the API exports). Dynamic otherwise | Path projection when static; index operation when dynamic |
| Unary, binary, comparison | `+ - * / % **`, `< <= > >= === !== == !=`, `!`, unary `-` and `+`, `typeof`, bitwise operators, `in` | Primitive operation |
| Conditional | `c ? a : b`, `a && b`, `a \|\| b`, `a ?? b` | Selection |
| Object literal | Properties, shorthand, computed keys that are static in the sense above, spread | Construction |
| Array literal | Elements, spread | Construction |
| Template literal | Substitutions are tier-R expressions | Primitive operation |
| Type-only wrappers | `e as T`, `e satisfies T`, `e!`, parentheses ([§7.7](#77-casts)) | None |
| JSX | [§4.5](#45-jsx) | Construction |
| Call | [§4.4](#44-calls) | By callee |

Refused in tier R: an arrow function or a function expression anywhere other
than the callback positions §4.4 names; assignment and compound assignment;
`++` and `--`; `delete`; `await`; `yield`; `new` other than the cell
constructors; `this`; `class`; a tagged template other than `str`; `void`;
the comma operator; a getter, a setter, a method, or a function-valued
property in an object literal; and `instanceof`.

### 4.4 Calls

A call in tier R is classified by its callee, in this order. A call that
matches none of the rows is refused (`reactive:unsupported-call`).

| Callee | Arguments | Meaning |
| --- | --- | --- |
| `xs.map(f)`, `xs.filter(f)`, `xs.flatMap(f)` where `xs` has an array type | `f` is an arrow function written at the call, with an element parameter and an optional index parameter. Its body follows §4.2 | Reactive collection operation. The body is compiled once against an element slot |
| Another structural collection method (the aggregates and the collection-index family) | As `builtin-inventory.md` specifies | Structural operation |
| A standard-library function or method marked "R" in [§9](#9-standard-library-surface) | Tier-R expressions; no function arguments | Primitive operation |
| An authored function, or a `lift` result | Tier-R expressions; no function arguments | Sandboxed call |
| `computed(f)`, `action(f)` | `f` is a function written at the call; its body is tier F, unless the `computed` is promoted ([§6](#6-promotion-of-computed)) | Sandboxed call, or the promoted expression |
| A `handler` result | One object argument: the state binding | Stream |
| A pattern: an imported or module-scope `pattern(...)` definition, an inline `pattern(...)` expression, or a value of a pattern factory type | One object argument | Anonymous sub-pattern, compiled into the surrounding instance |
| A cell operation: `new Writable<T>(init)`, the scoped constructors, `Writable.of`, `Cell.for`, and `.for(name)`, `.key(k)`, `.get()`, `.equals(x)`, `.asScope(s)` on a value of a cell type | As `builtin-inventory.md` specifies | State cell, path projection, or read |
| A structural or effectful built-in (`ifElse`, `when`, `unless`, `str`, `wish`, the fetch family, the language-model built-ins, and the others) | As `builtin-inventory.md` specifies | As classified there |

Three rules hold across the rows.

- **`.get()` requires a cell type.** `.get()` on a value whose type is not
  `Cell`, `Writable`, `ReadonlyCell`, or `Stream` is refused
  (`opaque-get:invalid-call`): the value is read directly. Because a tier-R
  expression is an operation of the plan wherever it is written, a `.get()`
  on a cell is allowed at every tier-R expression site, including the body of
  a reactive collection callback. The transformer's distinction between sites
  that can and cannot carry the read goes away. A `.get()` in statement
  position is still refused, as any expression statement that is not a
  recorded call is.
- **Dynamic keys are allowed.** `scopes[key]` is an index operation at every
  tier-R site. The transformer's refusal of a bare dynamic key in the pattern
  body goes away for the same reason.
- **Function arguments are refused** except in the first two rows.
  `xs.some((x) => x.done)`, `xs.find(...)`, `xs.reduce(...)`, and
  `xs.toSorted(compare)` are tier-F code: the author wraps the expression in
  `computed(() => ...)`. `builtin-inventory.md` may classify more methods as
  structural operations later; each one that becomes structural moves from
  this refusal into the second row.

### 4.5 JSX

JSX elements and fragments are tier-R expressions wherever a tier-R
expression is allowed, and their attribute values and children are tier-R
expressions.

- A lower-case tag is a host element. A tag that names a pattern is a pattern
  instantiation with the attributes as its argument.
- An attribute whose name starts with `on` takes a stream, or an arrow
  function written in place. The arrow's body is tier F, and the form is
  equivalent to an `action`.
- An arrow function in any other attribute is refused
  (`pattern-context:function-creation`).
- Spread attributes and spread children are allowed.

### 4.6 Captures

A tier-F body written inside tier R (a `computed`, an `action`, an inline
event handler) may refer to `const` bindings and parameters of the enclosing
tier-R bodies. The compiler turns each such reference into an input of the
body. It may not capture a function value declared in an enclosing function
scope (`ses-callback:callable-capture`); a reference to an authored function
is not a capture.

`x[SELF]` is valid on the pattern's own input parameter in tier R and nowhere
else (`pattern-context:self-access`), as today.

## 5. Function tier (tier F)

### 5.1 Grammar

Tier F is JavaScript with the restrictions below. Inside it, reactive
constructs do not exist: `?:`, `&&`, and `Array.prototype.map` have their
JavaScript meaning, and every value is a plain value or a cell handle.

**Allowed statements.** `const` and `let` declarations with destructuring,
defaults, and rest elements; expression statements; `if`; `for`, `for...of`,
`while`, `do...while`; `switch`; `break` and `continue`, with labels;
`return`; `throw`; `try` with `catch` and `finally`; blocks; nested function
declarations; local `type` and `interface` declarations.

**Allowed expressions.** Every tier-R form, and in addition: arrow functions
and function expressions; assignment and compound assignment to locals and to
members of local values; `++` and `--`; `delete` on a member of a local
value; `new` on the constructors of [§9](#9-standard-library-surface) and on
the cell constructors; `instanceof` against those constructors; tagged
templates (an ordinary call of the tag); the comma operator; spread in calls;
object and array destructuring assignment.

**Refused.**

| Construct | Diagnostic | Reason |
| --- | --- | --- |
| `async` functions, `await`, `for await` | `function-body:async` | A body runs inside one transaction and returns synchronously. Asynchronous work is an effectful built-in |
| Generators, `yield` | `function-body:generator` | The same |
| `class` declarations and expressions | `function-body:class` | The subset type checker has no class types, and a class is a second way to create hidden state |
| `this`, `super`, `new.target`, `arguments` | `function-body:this` | No authored function is a method. Rest parameters replace `arguments` |
| `var` | `function-body:var` | Hoisting rules the subset checker does not model |
| `for...in` | `function-body:for-in` | Enumerates a shape without naming it; `Object.keys` states the read |
| `with`, `debugger`, `eval`, the `Function` constructor, dynamic `import()`, `import.meta` | `function-body:dynamic-code` | No dynamic code |
| Getters, setters, and methods in object literals | `function-body:accessor` | A property holding an arrow function is the supported form for a code-typed object |
| `Proxy`, `Reflect`, `Symbol(...)`, `WeakMap`, `WeakSet`, `WeakRef` | `function-body:unsupported-global` | Not typed by the subset ([§9](#9-standard-library-surface)) |
| A write to a module-scope constant, an import, or a global | `module-scope:frozen-data-write`, `function-body:global-write` | Statelessness ([§3.3](#33-the-statelessness-rule)) |
| `Date.now()`, `new Date()` with no argument, `Math.random()` in a `lift`, a `computed`, or an authored function they call | `function-body:ambient-read` | A computation is a function of its inputs. The read is allowed in a `handler`, an `action`, and an inline event handler |
| `pattern`, `lift`, `handler`, `computed` called in tier F | `function-body:builder-call` | Builders define nodes at module scope or in tier R. The exceptions are an inline `pattern(...)` used directly as the callee of an instantiation, which the compiler hoists, and `action` (§5.2) |

### 5.2 Runtime calls

A tier-F body may make four kinds of runtime call: instantiate a pattern,
create a cell, request an effectful built-in, and bind a handler. The forms
of the first three are those of §4.4. Which of the four a `lift` or a
`computed` may make, as opposed to a `handler`, is specified in
`builtin-inventory.md`.

**Binding a handler.** An arrow function written as an `on*` attribute of
JSX built in tier F means what it means in tier R: an `action` around the
arrow. `action(() => ...)` may also be written out. The compiler hoists the
arrow to a handler definition whose state is the set of values the arrow
captures, and the expression evaluates, at run time, to a stream bound to the
captured values. Three rules apply to the captures.

- A captured value is a data value or a cell handle. A captured function
  value is refused (`ses-callback:callable-capture`), as in tier R.
- A captured local is a `const` or a parameter. A captured `let` is refused
  (`function-body:handler-capture`): the handler would see the value at the
  time of binding, not later assignments, and the diagnostic says to copy it
  into a `const` first.
- A captured data value is copied into the binding. A captured cell handle
  stays a link.

```tsx
// Shown for illustration only.
const toppingButtons = (toppings: string[], chosen: Writable<string>) =>
  toppings.map((topping) => (
    <button onClick={() => chosen.set(topping)}>{topping}</button>
  ));
```

A cell handle supports `.get()`, `.set()`, `.key()`, `.update()`, `.push()`,
`.send()`, and the other methods `builtin-inventory.md` lists for its type.
A write through a `ReadonlyCell`, and a read through a `WriteonlyCell`, are
type errors.

### 5.3 Verb results

A `handler` or an `action` declares the value it returns to its caller by a
result type argument. A block body that returns a plain value without one is
refused (`verb-result:undeclared-return`), as today.

### 5.4 What footprint analysis needs from the grammar

Footprint analysis is specified in `plan-and-label-templates.md`. The grammar
above is chosen so that it rarely gives up. The compiler reports each place
it does, as a hint (`footprint:widened`), naming the expression and the
subtree the footprint widened to. The causes visible in syntax are:

- a dynamic key on an input (`input[key]`), which widens to the keyed
  container;
- an input, or a subtree of one, passed to a tier-I function, to
  `JSON.stringify`, or to another function whose body is not analyzed;
- an input spread into an object or an array, or destructured with a rest
  element, which widens to that subtree;
- an input captured by a closure that is passed to a function whose body is
  not analyzed.

### 5.5 Imported TypeScript (tier I)

A module is in tier I when its first statement is the directive
`"use typescript";`. The directive is valid TypeScript, survives formatting,
and is visible to the parser. Nothing else puts a module in tier I: a module
without the directive that fails the subset check is refused, never treated
as imported, so a mistake cannot silently turn a precise module into an
opaque one.

```ts
// Shown for illustration only.
"use typescript";

type Shape<T> = T extends readonly (infer E)[] ? E : never;

export function unitPrice(basePrice: number, glaze: string): number {
  // Anything TypeScript accepts.
}
```

- **Signatures.** Each exported function that a subset module imports has
  annotated parameters and an annotated return type, all in the subset
  (`import:signature-not-in-subset`). Types and interfaces it exports can be
  imported when they are in the subset. Other exported values cannot
  (`import:not-a-function`).
- **Bodies.** The compiler does not analyze them. A call to such a function
  reads every argument in full, and its result depends on every argument.
- **Module scope.** The rules of §3.1 to §3.3 apply as far as syntax shows:
  no `let`, `var`, or class at module scope, and data constants are frozen.
  Because the compiler has not checked the bodies, the load-time verifier and
  the freezing wrappers of the current system stay in force for these
  modules, and a write to frozen data throws at run time.
- **Authority.** It imports only types from `commonfabric`. It cannot call a
  builder or a built-in.
- **Parameters and results are data types.** A cell passed to such a function
  could be written without the plan knowing, so cell-typed parameters are
  refused until [§13](#13-open-questions) is settled.

## 6. Promotion of `computed`

A `computed` call is **promoted** when the compiler replaces it with its body
as a tier-R expression. The result then has a label per output path, and
costs no sandboxed call for the operations the body is made of.

### 6.1 Criterion

`computed(f)` is promoted exactly when all of the following hold.

1. **The call is used as a value.** A `computed` in statement position exists
   for its writes and is never promoted.
2. **`f` is written at the call** as an arrow function or a function
   expression with no parameters.
3. **The body is expression-shaped.** A body is expression-shaped when it is
   - an expression; or
   - a block of the form `S1 ... Sn R`, where each `S` is a `const`
     declaration or a guard, and `R` is a `return` with or without an
     expression, or a guard with an `else` branch whose branches both end in
     a `return`. A guard is `if (c) B` or `if (c) B else B`, where each `B`
     is a `return` statement or an expression-shaped block.

   Every path through such a block ends in a `return`, and the block is
   equivalent to one expression built from `const` bindings and conditional
   expressions. A `return` without an expression contributes `undefined`.
4. **Every expression in the body is pure tier R.** It is built from the
   forms of §4.3, and each call in it is one of:
   - `map`, `filter`, or `flatMap` with a callback written in place whose
     body is itself expression-shaped and pure, or another structural
     collection method `builtin-inventory.md` marks as pure;
   - a standard-library function or method marked "R" in §9;
   - an authored function or a `lift` result, with no function arguments;
   - `.get()`, `.key(k)`, or `.equals(x)` on a cell;
   - `ifElse`, `when`, `unless`, or `str`.
5. **Nothing else occurs in the body.** In particular it creates no cell,
   instantiates no pattern (including by a JSX tag that names one), requests
   no effect, and writes nothing.

JSX with host elements is allowed in a promoted body, and so is an inline
event handler in it, which is then a tier-R handler (§4.5). A call of an
authored function inside a promoted body stays a sandboxed call with its own
footprint; the expression around it is promoted.

### 6.2 What promotion preserves

A promoted `computed` computes the same value as the unpromoted one. Three
things differ, none of them in the value.

- **Labels.** The unpromoted result has one label, the join over the body's
  footprint. The promoted result has a label template per output path, a
  conditional contributes only the selected branch, and a mapped collection
  has an element template and a membership slot.
- **Cost.** The promoted expression is part of a dependency cone's value
  code and makes no sandboxed call of its own.
- **Granularity of recomputation.** A promoted `map` is a cone per element.

Promotion never changes whether a program is accepted. A `computed` that
fails the criterion stays a tier-F body. The compiler reports why on request
(`computed:not-promoted`, a hint that names the first disqualifying
construct), because the fix is often small: `xs.sort(...)` on a copy becomes
`xs.toSorted(...)` inside a tier-F helper, or a loop that sums becomes an
aggregate.

### 6.3 An author-visible consequence

Because promotion is decided by the criterion alone, an author can read it
off the source: a `computed` whose body is an expression over property
accesses, operators, conditionals, `map`, `filter`, `flatMap`, and calls of
helpers is as precise as writing the expression directly in the pattern
body. [§12](#12-recommended-syntax-changes) recommends that such a
`computed` wrapper become optional.

## 7. Type system

The subset has its own type checker. It is strict: there is no implicit
`any`, and `null` and `undefined` are distinct types that belong only to the
unions that name them.

### 7.1 Types the checker supports

| Type form | Notes |
| --- | --- |
| `string`, `number`, `boolean`, `bigint`, `null`, `undefined`, `void` | `void` only as a function's return type |
| Literal types | String, number, boolean, and bigint literals |
| `unknown` | The top type. In a data type it declares a reference to another piece that is not read ([`unknown.md`](../../common/concepts/types-and-schemas/unknown.md)) |
| `any` | Refused ([§7.8](#78-any-and-unknown)) |
| `never` | The bottom type. `Record<string, never>` is the empty object |
| Object types | Type literals and interfaces, `extends` between interfaces, optional properties (`?`), `readonly` properties. Property names are identifiers, string literals, numeric literals, and the well-known keys the API exports (`[UI]`, `[NAME]`, `[SELF]`, and the others) |
| Index signatures | `[key: string]: T` and `Record<K, T>` where `K` is `string` or a union of string literals |
| Arrays | `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>` |
| Tuples | Fixed elements, optional trailing elements, named elements, `readonly`, and a spread of another tuple type |
| Unions | Of any supported types |
| Intersections | Computed eagerly ([§7.4](#74-intersections)) |
| References | To aliases and interfaces, with type arguments |
| `typeof name` | The declared or inferred type of a value binding. In a label argument it names the binding itself ([§8.5](#85-label-arguments)) |
| Indexed access `T["k"]`, `T[number]` | Computed eagerly; the key is a literal type, a union of literals, or `number` on an array or tuple |
| `keyof T` | Computed eagerly to a union of string literals; `T` is an object type |
| Function types | `(a: A) => B`, and method signatures in object types. Code types |
| Type predicates | `x is T` as a function's return type. The body is checked to return a boolean; the predicate is trusted |
| Type operators, implemented natively | `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Record`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters` |
| Standard-library object types | `Date`, `RegExp`, `Error` and its subtypes, `Map`, `Set`, `ReadonlyMap`, `ReadonlySet`, `URL`, `Uint8Array`, `Iterable` ([§9](#9-standard-library-surface)). Code types, except where the schema mapping gives one a schema |
| API types | [§7.2](#72-api-types) |

### 7.2 API types

The types the `commonfabric` module exports are built into the checker as
type constructors with native rules. The checker does not evaluate their
TypeScript declarations in `base/api/index.ts`, which use conditional and
higher-kinded types to express the same rules to TypeScript.

| API type | Rule in the subset |
| --- | --- |
| `Cell<T>`, `Writable<T>` | A read-write handle to a value of type `T`. `Writable` is the same type as `Cell` |
| `ReadonlyCell<T>`, `WriteonlyCell<T>`, `ComparableCell<T>`, `OpaqueCell<T>` | Handles with fewer capabilities. `Cell<T>` is assignable to each |
| `Stream<T>` | A handle that accepts events of type `T` |
| `Reactive<T>` | The same type as `T` |
| `Default<T, V>`, `DeepDefault<V>` | `T` with a default-value annotation `V`; `V` is a literal-like type assignable to `T` ([§8.8](#88-defaults-and-scopes)) |
| `PerSpace<T>`, `PerUser<T>`, `PerSession<T>`, `PerAny<T>`, `Scoped<T, S>` | `T` with a scope annotation ([§8.8](#88-defaults-and-scopes)) |
| The CFC aliases | `T` with label annotations ([§8](#8-labels-as-annotations)) |
| `VNode`, `JSONSchema`, `JSONValue`, the built-in parameter and state types | Opaque named types or ordinary object types, as the API declares them |
| `PatternFactory<I, O>`, `HandlerFactory<E, S>`, and the results of `pattern`, `lift`, and `handler` | Factory types. Calling one follows §4.4 |
| `ReturnType<typeof someHandler>`, `Parameters<typeof SomePattern>[0]` | Defined on factory types: the stream type a handler yields, and a pattern's input type |

A type is an API type when its name resolves, through its import, to a
declaration in `commonfabric`. A local type that happens to be named
`Writable` or `Confidential` is that local type.

### 7.3 Generics

Type aliases, interfaces, and functions may declare type parameters, with an
optional constraint (`T extends C`) and an optional default.

- **Aliases and interfaces** are instantiated by substitution. A recursive
  reference inside a generic declaration must pass the declaration's own
  parameters unchanged (`type Tree<T> = { value: T; children: Tree<T>[] }`).
  A reference that changes them (`Nest<T[]>` inside `Nest<T>`) never reaches
  a fixed point and is refused (`subset-type:non-regular-recursion`).
- **Functions** are checked once per distinct instantiation, with the type
  arguments substituted, in addition to one check with each parameter
  replaced by its constraint (`unknown` when it has none) so that an exported
  generic function nothing calls is still checked. There are no deferred
  types: `keyof T` and `T[K]` are always computed on a concrete type.
  Footprints and schemas need concrete types in any case.
- **Inference at a call** is first-order unification of the argument types
  against the parameter types, left to right. An argument that is a lambda is
  typed after the other arguments. A type parameter no argument determines
  takes its default, or is an error
  (`subset-type:cannot-infer-type-argument`).

### 7.4 Intersections

`A & B` is computed when it is written, to a type with no intersection in it.

- Two object types merge into one object type. A property both declare has
  the intersection of the two property types, and their annotations combine
  ([§8.4](#84-composition)).
- A union distributes: `(A | C) & B` is `(A & B) | (C & B)`.
- A union of literal types intersected with the primitive type they belong to
  is that union with the non-members removed (`keyof T & string`).
- `T & unknown` is `T`.
- Any other combination is `never`. Writing one directly is refused
  (`subset-type:empty-intersection`), since it is almost always a mistake.

Because intersections do not survive as types, nothing in the checker or the
schema generator has to recover which part of an intersection a brand was
written around.

### 7.5 Assignability

Assignability is structural, with these rules.

- An object type is assignable to another when it has every required
  property of the target with an assignable type. A fresh object literal may
  not have properties the target does not declare.
- A mutable array, tuple, `Map`, or `Set` type is assignable to its read-only
  counterpart. The reverse is refused. A property is assignable to a
  `readonly` property; a `readonly` property is not assignable to a mutable
  one. This is stricter than TypeScript, and is what makes the frozen-data
  rule of §3.3 a type rule.
- A literal type is assignable to its primitive type. A `const` binding keeps
  the literal type of its initializer; `let` bindings and mutable properties
  widen it. `as const` keeps literal types and adds `readonly` throughout.
- A function type is assignable when parameters are assignable in reverse and
  the result is assignable forward.
- The value a pattern instantiation returns is assignable to every type the
  pattern's result type is assignable to, to a cell of such a type, and to
  `unknown`. This is what lets a handler push a new instance onto a list
  declared with a narrower view of it, or hand it to `navigateTo`.
- `Cell<T>` is assignable to `ReadonlyCell<U>` when `T` is assignable to `U`,
  and to `Cell<U>` only when `T` and `U` are the same type up to
  annotations, because the handle can write.
- Label annotations do not take part in structural assignability
  ([§8.6](#86-assignability)).

### 7.6 Inference and narrowing

Types are inferred for variable initializers, for the return type of a
function without a return annotation, and for the parameters of a lambda from
the function type expected at its position. Parameters of authored functions
and of builder callbacks need annotations, unless the builder's type
arguments supply them.

Narrowing applies in tier F and in tier R conditionals. The checker narrows
on `typeof x === "..."`, on `===` and `!==` against a literal, `null`, or
`undefined`, on truthiness, on `"k" in x`, on `Array.isArray(x)`, on
`instanceof` against a standard-library constructor, on a discriminant
property of a union of object types, on a call of a function with a type
predicate, and on an assignment to a `let`.

The variable of a `catch` clause has type `unknown`.

### 7.7 Casts

- `e as T` is allowed when the type of `e` and `T` are related: one is
  assignable to the other, ignoring annotations. It asserts the type and
  changes no value.
- `e as const` is allowed on literals.
- `e!` removes `null` and `undefined`.
- `e satisfies T` checks assignability and keeps the type of `e`.
- A cast through `unknown` to an unrelated type is refused
  (`cast-validation:double-unknown`), as today.
- A cast to a cell type or to `Reactive<T>` is refused
  (`cast-validation:cell-cast`, `cast-validation:forbidden-cast`), as today.
- A cast never changes a label ([§8.6](#86-assignability)).

### 7.8 `any` and `unknown`

`any` is refused, as a type and as the target of a cast
(`subset-type:any`). A position typed `any` has the schema that accepts
every value and is read in full, so every footprint that reaches it widens
to the whole subtree, and a cast to `any` hides a type from the checker and
from footprint analysis alike. A tier-I module may use `any` inside its
bodies and not in the signatures a subset module imports.

`unknown` is the supported top type. In a data type it declares a reference
that is not read, and in code it forces a narrowing before use.

The corpus uses `any` for a small number of things
([§11.3](#113-what-the-subset-refuses-in-the-corpus)). The subset supports
each of them explicitly instead.

| What `any` stands for today | Explicit form |
| --- | --- |
| A reference to some other piece, or a cell of unknown content (`cell: any`, `Writable<any>`) | `unknown` for the reference; `Cell<unknown>` for a handle. `.key(name)` on a `Cell<unknown>` takes any string and yields a `Cell<unknown>`, so a helper can walk a path without knowing the shape |
| A pattern instance, or a cell, passed where a narrower or differently labeled view of it is declared (`entries.push(note as any)`, `navigateTo(note as any)`, `entries: entries as any`) | No cast. A pattern instance is assignable to every type its result type is assignable to (§7.5), and label annotations are not part of assignability (§8.6) |
| A caught error (`(error as any).message`) | `error instanceof Error ? error.message : String(error)` (§7.6) |
| An open record or arbitrary JSON (`Record<string, any>`, `result: any \| null`) | `Record<string, unknown>`, or `JSONValue` where the value is read |
| Elements of a collection that was typed `any[]` (`(e: any) => e.name`) | Type the collection; the lambda parameter is then inferred |
| An event or a result a builder does not use (`handler<any, State>`, `pattern<Input, any>`) | `handler<unknown, State>`; a declared result type |

A pattern's result type that is `unknown` at the top level stays an error
(`pattern:any-result-schema`).

### 7.9 Type features the checker refuses

| Feature | Diagnostic | What to write instead |
| --- | --- | --- |
| Conditional types, `infer` | `subset-type:conditional` | A union, an overload-free generic, or one of the native type operators |
| Mapped types | `subset-type:mapped` | `Record<K, T>`, `Partial`, `Required`, `Readonly`, `Pick`, or `Omit` |
| Template literal types | `subset-type:template-literal` | `string`, or a union of string literals |
| `symbol`, `unique symbol` | `schema-type:symbol` | A string literal key, or a well-known key exported by the API |
| Function overloads | `subset-type:overload` | One signature with a union parameter, or two functions with different names. To read a cell under another type, `cell.asSchema<T>()` ([§12.4](#124-a-named-form-for-re-typing-a-cell)) |
| `enum`, `namespace` | `subset-syntax:enum`, `subset-syntax:namespace` | A union of string literals with an `as const` object; a module |
| Class types, constructor types, abstract members, `this` types | `subset-type:class` | Object types and authored functions |
| Declaration merging, `declare global`, module augmentation | `subset-syntax:ambient-declaration` | One declaration per name |
| Call and construct signatures in object types, accessors in types | `subset-type:callable-object` | A function type, or a property of function type |
| `asserts x is T` | `subset-type:assertion-signature` | A type predicate and an `if` that throws |
| Variance annotations, `satisfies` on a type parameter, `const` type parameters | `subset-type:unsupported-modifier` | Omit the modifier |
| Index signatures keyed by `number`, `symbol`, or a template literal | `subset-type:index-signature-key` | An array, or a `string` key |
| A function type inside a data type | `subset-type:function-in-data` | A stream for behavior a consumer triggers; an authored function for behavior the module owns |
| Decorators | `subset-syntax:decorator` | A builder call |

## 8. Labels as annotations

### 8.1 The model

Every type in the subset is a pair: a **shape**, which is one of the type
forms of §7.1, and a set of **annotations** on that node. Annotations are of
three kinds: label annotations (this section), a default value, and a scope
(§8.8). A type alias from the CFC alias set is a type constructor that
returns its first argument with one annotation added at the root. It is not
an intersection with a brand, and the checker never evaluates the
declarations of `Cfc`, `CfcTag`, and `CfcStamp` in `base/api/cfc.ts`.

The alias set is the canonical one of
[`cfc_authoring_contract.md`](../ts-transformer/cfc_authoring_contract.md),
held in `CFC_CANONICAL_ALIAS_NAMES` in `base/api/cfc.ts`. Each alias adds the
annotation whose key the contract's lowering rules give it.

| Alias | Annotation added at the root of `T` |
| --- | --- |
| `Confidential<T, L>` | `confidentiality: L` |
| `Integrity<T, L>` | `integrity: L` |
| `AddIntegrity<T, L>` | `addIntegrity: L` |
| `RepresentsCurrentUser<T>`, `AuthoredByCurrentUser<T>` | `addIntegrity` with the corresponding atom over the current principal |
| `RequiresIntegrity<T, L>` | `requiredIntegrity: L` |
| `MaxConfidentiality<T, L>` | `maxConfidentiality: L` |
| `WriteAuthorizedBy<T, typeof b>` | `writeAuthorizedBy`: the binding `b` |
| `WritePolicyAnyOf<T, [P, ...]>` | `writePolicyAnyOf`: the list of writer policies |
| `TrustedActionWrite<...>`, `TrustedActionWriteWithIntegrity<...>`, `TrustedActionUiContract<...>` | `writeAuthorizedBy` and `uiContract`, as the contract defines |
| `ExactCopy<T, P>`, `ProjectionPath<T, F, P>`, `ProjectionOf<T, P>`, `Projection<R>` | `exactCopyOf`, `projection` |
| `Cfc<T, M>` | Each key of the record `M` |
| `AnyOf<X>`, `PolicyOf<typeof rules>` | Not type constructors. They are terms of the label-argument language (§8.5) |

What an annotation means for the label of a stored value, and how declared
annotations combine with label templates, is specified in
`plan-and-label-templates.md`. This section specifies only where an
annotation sits and how it survives the type operations of §7.

### 8.2 Three uses of an annotation

1. **Schema emission.** An annotation on a node of a type that reaches a
   schema becomes the `ifc` metadata of that schema node, with the keys the
   schema mapping emits today
   ([`ts_to_json_schema_mapping.md`](../schema-generator/ts_to_json_schema_mapping.md),
   §11).
2. **Compile-time checks.** Where the plan needs the declared label of a
   slot, or a declared constraint on one, the compiler reads the annotation
   at the slot's path. The overview's compile-time constraint checks read
   these.
3. **Nothing else.** The label of a computed value comes from its label
   template, not from the static type of the expression that computes it. An
   annotation on the type of an intermediate expression declares nothing.

### 8.3 Paths

The annotation at a path of a type is the combination of the annotations on
every node from the root to that path. `confidentiality` lists join, outer
first, each atom once. Any other key that two nodes on one path both declare
must be declared alike, or the type is refused (`cfc-label:conflict`). This
is the rule the contract states for nested wrappers and for a wrapper around
a named type; here it is one rule about paths, with no separate treatment of
references to named definitions.

### 8.4 Composition

**Unions.** An annotation written around a union sits on the union node:
`Confidential<A | B, L>` labels the value whichever member it is. An
annotation written on a member sits on that member:
`Confidential<A, L> | B` labels the value when it is an `A`. A union is never
flattened across an annotation, so
`Confidential<A | B, L> | C` keeps the boundary. The schema has `anyOf` with
`ifc` on the node where the annotation sits.

**`null` and `undefined`.** They are ordinary union members.
`Confidential<string | null, L>` is a labeled union, and its `null` is
labeled: whether the value is present is as confidential as the value.
`Confidential<null, L>` is a labeled `null`. `NonNullable<T>` removes the
`null` and `undefined` members of the union at the root of `T` and keeps the
root's annotations.

**Optional properties.** `?` is a modifier of the property, not a member of
its type. An annotation on the type of an optional property covers the
property's slot, present or absent: `note?: Confidential<string, L>` and
`note?: Confidential<string | undefined, L>` are the same declaration.

**Arrays and tuples.** `Confidential<T[], L>` annotates the array node: its
membership, order, and, by the path rule, every element.
`Confidential<T, L>[]` annotates each element and not the membership. Both
may be written together. A tuple's element types carry their own
annotations.

**Nested objects.** An annotation on an object type covers the object. An
annotation on a property's type covers that property. The path rule combines
them.

**Intersections.** When two object types merge, each property of the result
keeps the annotations of the operand it came from, and a property both
declare combines them. Annotations on an operand's root move to each
property that operand contributed, because the merged type has one root and
the annotation was written around one part of it. So
`A & Confidential<B, L>` labels the properties of `B`, and
`Confidential<A & B, L>` labels the merged object. An annotated primitive
cannot be intersected with an object type (§7.4).

**Type operators.** `Partial`, `Required`, `Readonly`, `Pick`, and `Omit`
keep the annotations at the root of their operand and the annotations of
every property they keep. Applied to a type that is not an object type, they
are refused (`subset-type:operator-operand`), except that `Readonly` of a
primitive is that primitive. `Record<K, T>` keeps the annotations of `T` on
each value. `Exclude` and `Extract` keep the annotations of the members they
keep. `T["k"]` is the type of the property with the path-combined
annotations, and `ReturnType` and `Parameters` return types with their
annotations intact.

**Generic aliases.** `type Sec<T> = Confidential<T, readonly ["secret"]>` is
an alias like any other, instantiated by substitution. The result of
`Sec<Donut>` is `Donut` with the annotation, exactly as if written in place.

**`unknown` and `never`.** They can carry annotations like any shape.
`Confidential<unknown, L>` is a labeled reference, and
`Confidential<never, L>` is `never` with the annotation.

### 8.5 Label arguments

The second argument of a label alias is a term of a small constant language,
which the compiler evaluates itself.

- A label list is a tuple type, optionally `readonly`, whose elements are
  atoms or a spread of another label list.
- An atom is a string, number, or boolean literal type, `null`, an object
  type literal whose property types are atoms or tuples of atoms,
  `AnyOf<list>`, `PolicyOf<typeof rules>`, `CurrentPrincipal` and the other
  marker types the API exports for atoms, or a reference to an alias whose
  body is an atom.
- An alias with parameters may stand for a list or an atom; it is evaluated
  by substitution.
- `typeof name` in `WriteAuthorizedBy`, `PolicyOf`, and the trusted-action
  aliases is a **binding reference**. It denotes the declaration `name`
  resolves to, through imports and re-exports, and never that declaration's
  type. The validity conditions for the binding are the contract's
  (`cfc-write-authorized-by`, `cfc-policy-of`).

Anything else in a label argument is an error
(`cfc-label:not-static`): a union of literals, an array type, a conditional
or indexed type, an optional tuple element. A label argument that is no list
at all stays `cfc-label:not-a-list`.

### 8.6 Assignability

Annotations are not part of structural assignability. A `string` is
assignable to a position declared `Confidential<string, L>`, and the reverse
is also assignable: the type system does not police flows. Flows are checked
against label templates and declared constraints, by the rules of
`plan-and-label-templates.md`. This document only reserves the identifiers
those checks report under: `cfc-flow:max-confidentiality`,
`cfc-flow:required-integrity`, and `cfc-flow:write-policy`.

A cast cannot move a label. In `e as T`, annotations in `T` that differ from
those of the type of `e` have no effect, and writing them draws a warning
(`cfc-label:cast-ignored`) that says to declare the label on the cell, the
pattern input, or the pattern result instead.

This is the one place rule 2 of §2 can fail. The compiler does not read the
declarations in `base/api/cfc.ts` (§7.2), but an editor does: it runs the
TypeScript compiler over the same source against those declarations. A
generic function that returns its unconstrained parameter as
`Confidential<T, L>` is accepted by the subset and reported by the editor,
because the brand type is not assignable from an unconstrained `T`. The
author can write `T extends {}` to satisfy both.

Once nothing but editors reads the published typings, they can be reduced to
what an editor needs: each label alias an identity alias of its payload
(`type Confidential<T, L> = T`), and each scope wrapper likewise. The
exception then disappears, and so does every editor error that comes from
the brand encoding ([§13](#13-open-questions)).

### 8.7 The TypeScript corner cases

The brand encoding needs the rules below today. Each is documented in
[`ts_to_json_schema_mapping.md`](../schema-generator/ts_to_json_schema_mapping.md)
§11, in `cfc_authoring_contract.md`, or in §6.3a and §6.12 of
[`ts_transformers_current_behavior_spec.md`](../ts-transformer/ts_transformers_current_behavior_spec.md).
The right column says what the annotation model does with it.

| Corner case today | In this language |
| --- | --- |
| An intersection of the brand with `null` or `undefined` reduces to `never`, so `CfcTag` keeps those members beside the stamp and the alias distributes over the union | Disappears. `null` is a union member of a labeled union (§8.4) |
| `Confidential<null, L>` is `null`, with no label left | Disappears. It is a labeled `null` |
| `NonNullable<Confidential<T \| null, L>>` intersects with `{}` and drops the alias name, so the label is recovered from carriers | Disappears. `NonNullable` is a native operator that keeps annotations |
| `A & Confidential<B, L>` and `Confidential<A & B, L>` are the same TypeScript type, so each carrier records its payload (`CfcStamp`) and labels are placed by `placeCarriedLabels` | Disappears. The two are different types, by the intersection rule of §8.4. `CfcStamp` has no counterpart |
| Restrictions and evidence are placed differently when a carrier is merged into a spread, a mapped type, or an object with an index signature | Disappears for types: intersections and operators place annotations property by property. For values, the label of `{ ...b, name }` is given by its label template, not by a type |
| `Pick`, `Omit`, `Partial`, `Readonly` fold the carrier into the object they build, as one more property; `Pick<Sec<string>, "length">` is a labeled object of string methods | Disappears. The operators keep annotations by rule, and applied to a primitive they are refused (`subset-type:operator-operand`) |
| The checker folds a union member that is itself a union into the whole and loses the label boundary, so unions under bound parameters are read from syntax | Disappears. Unions are not flattened across annotations |
| An alias read from a type alone, with no argument nodes, cannot name a `typeof` writer binding; the schema would carry no write restriction (`cfc-write-authorized-by:unread`) | Disappears. A binding reference is a term of the type system and survives every substitution. The diagnostic is retired |
| A writer policy reached through a conditional alias, an indexed access, or a parameter the conditional checks cannot be read | Conditional types are refused (`subset-type:conditional`); indexed access keeps annotations by rule |
| A CFC alias chain is followed by substituting type-argument nodes, with recursion bounded at three nested readings (`cfc-schema:recursion-limit`) | Replaced. Aliases are instantiated by ordinary substitution, and non-regular recursion is refused where it is declared (`subset-type:non-regular-recursion`) |
| `Confidential<any, L>` is `any` to the checker, so the alias is read from its declaration, and a recursive such alias is refused (`cfc-schema:recursive-alias-of-any`) | Disappears. `any` is refused (§7.8), and `unknown` carries annotations |
| A label list read only in part leaves `null` atoms and a warning (`cfc-label:unread`) | Replaced by an error. A label argument is in the constant language or is refused (`cfc-label:not-static`) |
| Aliases are detected by canonical name, with no check of the declaring package, so a local type named like one is lowered as one | Disappears. An alias is recognized by resolving its import to `commonfabric` (§7.2) |
| A function `<T>(v: T): Confidential<T, L>` does not type-check for unconstrained `T`, because the stamp is not assignable from `null` | Disappears in the subset. It remains in an editor until the typings change (§8.6) |
| An optional property adds `undefined`, which readings from a type have to subtract before matching the payload | Disappears. `?` is a property modifier (§8.4) |
| A value typed with the brand needs a cast at a write: `cell.set(text as Confidential<string, L>)` | Disappears. Annotations are not part of assignability, and the cast is reported as redundant (`cfc-label:cast-ignored`) |
| A scope wrapper may not be a union member, so the shrink moves nullish members inside it (`moveNullishIntoScopeWrapper`) | Replaced by the scope rule of §8.8 |
| A `Default` whose value cannot be recovered from the node, the type, or the brand payload supplies no default (`schema-default:unresolved`, a warning) | Replaced by an error (`default:not-static`) |

### 8.8 Defaults and scopes

`Default<T, V>` adds a default-value annotation to `T`. `V` is a literal-like
type: a literal, a tuple or object literal type of literal-like types, or
`Record<string, never>` for the empty object. It must be assignable to `T`.
Anything else is refused (`default:not-static`). `T | Default<V>` and
`DeepDefault<V>` follow the schema mapping's §7.

A scope wrapper adds a scope annotation. A scope annotation is valid at the
root of a cell's value type, at the root of a pattern input property, and at
the root of a type given to a cell constructor. On a union member it is
valid only when every other member is `null` or `undefined`, and it then
applies to the whole union: `PerUser<T> | undefined` and
`PerUser<T | undefined>` are the same declaration. On a member of any other
union it is refused (`scope:union-member`).

## 9. Standard-library surface

The subset type checker types the standard-library members below and no
others. A use of a member that is not listed is refused
(`stdlib:unsupported-member`), with a message that names the nearest listed
member when there is one.

The list is derived from the corpus: every member in it is called in at
least one pattern module, except those marked †, which are included because
a listed sibling makes their absence surprising. Receivers were attributed
by method name, not by resolved type, so a count that depends on telling
`String.prototype.includes` from `Array.prototype.includes` was not taken.

"R" marks a member that is a primitive operation in tier R: it is pure, takes
no function argument, and does not mutate its receiver. Every listed member
is available in tier F.

### 9.1 String

R: `length`, `at`, `charAt`, `charCodeAt`, `codePointAt`, `concat`†,
`endsWith`, `includes`, `indexOf`, `lastIndexOf`, `localeCompare`,
`normalize`, `padEnd`†, `padStart`, `repeat`, `slice`, `split`,
`startsWith`, `substring`, `toLowerCase`, `toUpperCase`, `trim`, `trimEnd`,
`trimStart`†, `toString`; `match`, `replace`, `replaceAll`† with a string or
a non-stateful `RegExp` pattern and a string replacement.

F only: `replace` and `replaceAll` with a function replacement; `matchAll`†.

Static: `String(x)` (R), `String.fromCharCode` (R), `String.fromCodePoint`†
(R).

### 9.2 Array

R: `length`, `at`, `concat`†, `entries`, `flat`†, `includes`, `indexOf`,
`join`, `keys`, `lastIndexOf`, `slice`, `toReversed`†, `toSpliced`,
`values`, `with`†; `toSorted` with no argument.

Reactive collection operations in tier R, ordinary methods in tier F: `map`,
`filter`, `flatMap`.

F only, because they take a function: `every`, `find`, `findIndex`,
`findLast`†, `findLastIndex`†, `forEach`, `reduce`, `reduceRight`†,
`some`, `toSorted` with a comparator.

F only, because they mutate: `fill`, `pop`, `push`, `reverse`, `shift`†,
`sort`, `splice`, `unshift`†. On a read-only array type these are type
errors.

Static: `Array.isArray` (R), `Array.from` (R with one argument; F with a
mapping function), `Array.of`† (R), `new Array(n)` (F).

### 9.3 Object

R: `Object.keys`, `Object.values`, `Object.entries`, `Object.fromEntries`,
`Object.hasOwn`.

F only: `Object.assign`†, `Object.freeze`†, `Object.getPrototypeOf`,
`Object.create(null)`. The last two are typed narrowly, for the test that a
value is a plain object and for a record without a prototype:
`Object.getPrototypeOf(x)` has type `object | null`, and `Object.create`
accepts only `null`.

### 9.4 Number, Boolean, BigInt, and global functions

R: `Number(x)`, `Number.isFinite`, `Number.isInteger`, `Number.isNaN`,
`Number.isSafeInteger`, `Number.parseFloat`†, `Number.parseInt`†,
`Number.MAX_SAFE_INTEGER`†, `Number.EPSILON`†, `toFixed`, `toPrecision`†,
`toString`, `toLocaleString`; `Boolean(x)`; `BigInt(x)`; `parseInt`,
`parseFloat`, `isNaN`, `isFinite`†; `encodeURIComponent`,
`decodeURIComponent`, `encodeURI`†, `decodeURI`†; `btoa`, `atob`†;
`Infinity`†, `NaN`†, `undefined`.

### 9.5 Math

R: `abs`, `atan2`, `ceil`, `cos`†, `floor`, `hypot`, `imul`, `log`†, `max`,
`min`, `pow`, `round`, `sign`†, `sin`, `sqrt`†, `trunc`†, `PI`, `E`†.

F only, and only where an ambient read is allowed (§5.1): `Math.random`.

### 9.6 Date

R: `Date.parse`, `Date.UTC`; on a `Date` value: `getDate`, `getDay`,
`getFullYear`, `getHours`, `getMinutes`, `getMonth`, `getSeconds`,
`getTime`, `getUTCDate`, the other `getUTC*` readers†, `toISOString`,
`toLocaleDateString`, `toLocaleString`, `toLocaleTimeString`, `valueOf`†.

F only: `new Date(value)` and `new Date(year, month, ...)`; the mutators
`setDate`, `setMonth`†, `setFullYear`†, `setHours`†, `setMinutes`†,
`setTime`†; and, where an ambient read is allowed, `Date.now()` and
`new Date()`.

`Date` is a code type. A `Date` cannot appear in a tier-R expression except
as the receiver of an R member, which in practice means inside a `computed`
that is then not promoted because of the `new`.

### 9.7 JSON

R: `JSON.stringify` with one argument, or with an indent. F only:
`JSON.parse`, whose result has type `unknown`, and `JSON.stringify` with a
replacer.

`JSON.stringify(x)` reads `x` in full (§5.4).

### 9.8 RegExp

A regular-expression literal without the `g` or `y` flag is a constant in
every tier. Members: `test` (R), `exec` (F), `source`†, `flags`†. In tier F,
`new RegExp(pattern, flags)` and literals with `g` or `y` are allowed for
values that stay local.

### 9.9 Map and Set

F only: `new Map(entries?)`, `new Set(values?)`; `get`, `set`, `has`,
`delete`, `clear`, `add`, `size`, `keys`, `values`, `entries`, `forEach`,
and iteration with `for...of` and spread.

On `ReadonlyMap` and `ReadonlySet`, the type of frozen module data, only the
readers exist: `get`, `has`, `size`, `keys`, `values`, `entries`, `forEach`,
and iteration. `has` and `get` on such a value are R.

### 9.10 Errors

F only: `new Error(message)`, `new TypeError(message)`,
`new RangeError(message)`, with the optional `cause`; the members `message`,
`name`, `cause`; and `instanceof` against the three constructors.

### 9.11 Other

F only: `new URL(text)` with the readers `protocol`, `username`, `password`,
and `host`†, `hostname`†, `pathname`†, `search`†, `hash`†, `href`†,
`origin`†;
`new TextEncoder().encode(text)`; `Uint8Array` construction, `length`, and
index access; `console.log`, `console.warn`, `console.error`; iteration
protocols as far as `for...of`, spread, and destructuring use them on
arrays, strings, `Map`, `Set`, and their iterators.

Not typed, and refused: `Promise`, `fetch`, timers, `structuredClone`,
`crypto`, `Intl` (the `toLocale*` methods above are the supported surface),
`Proxy`, `Reflect`, `Symbol`, `WeakMap`, `WeakSet`, `WeakRef`, `globalThis`,
`window`, `document`, typed arrays other than `Uint8Array`, and
`Object.defineProperty` and the other reflective `Object` members. The
effectful built-ins of `builtin-inventory.md` replace the first four.

## 10. Diagnostics catalog

Severity is **error** (the program is refused), **warning** (accepted, and
the report is shown by default), or **hint** (accepted, shown on request).
Under the stored-source option of the current pipeline
(`TransformationOptions.storedSource`), some authoring-shape errors are
demoted to warnings so that already-deployed source reloads. Whether the
compiled language keeps that mode is a migration question
([§13](#13-open-questions)); the catalog gives authoring severities.

"Status" compares with the diagnostics of
`ts_transformers_current_behavior_spec.md` §6 and the unsupported rows of
[`ts_transformers_target_pattern_language_spec.md`](../ts-transformer/ts_transformers_target_pattern_language_spec.md)
§4: **carries** (same identifier and condition), **changes** (same
identifier, different condition or severity), **new**, or **retired**.

Message texts are normative in content, not in wording: each must name the
construct found and the replacement given here.

### 10.1 Module scope

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `module-scope:let-declaration` | error | `let` at module scope, exported or not | Use `const`. For a value that changes, create a cell in a pattern (`new Writable<T>(initial)`). For imperative code that needs `let`, move it into a function | carries |
| `module-scope:var-declaration` | error | `var` at module scope | The same | carries |
| `module-scope:class-declaration` | error | A class declaration or class expression at module scope | Use an object type and authored functions that take the value as a parameter | new (the verifier's load-time refusal becomes a compile diagnostic) |
| `module-scope:statement` | error | An expression statement, control flow, a block, or top-level `await` at module scope | Move the code into a function. To compute a constant once, write `const NAME = compute()` and let the result be frozen | new |
| `module-scope:frozen-data-type` | error | A frozen-data constant whose type contains a function, a cell, a `Date`, an `Error`, or another code type other than `ReadonlyMap`, `ReadonlySet`, and `RegExp` | Declare the function directly (`const f = (...) => ...`), or build the value inside the function that uses it | new |
| `module-scope:frozen-data-write` | error | A write through a module-scope constant or an import: member assignment, `delete`, `++`, or a mutating method | Copy first (`[...NAME]`, `{ ...NAME }`, `new Map(NAME)`) and change the copy, or keep the state in a cell | new |
| `module-scope:stateful-regexp` | error | A regular expression with the `g` or `y` flag held at module scope | Remove the flag and use `replaceAll` or `matchAll`, or create the expression inside the function that uses it | new |
| `module-scope:import-form` | error | An import with no bindings, or a specifier that is not `commonfabric`, `commonfabric/<name>`, relative, or `cf:` | Import a named binding. External packages are not available to patterns | new |
| `builder-callback:indirect-reference` | error | A builder's callback is neither a function written at the call nor a name bound to a function in the same module; also a generator, or a declaration without a body | Write the function at the call, or bind it in this module (`const save = (event, state) => ...; handler(save)`) | carries |
| `cell-factory:empty-array` | error | A cell constructor called with `[]` and no type argument | Write the element type: `new Writable<Donut[]>([])` | carries |

### 10.2 Reactive tier

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `pattern-context:let-declaration`, `pattern-context:var-declaration` | error | `let` or `var` in a tier-R body | Use `const`. For a value computed with reassignment, write `computed(() => { let x = ...; ...; return x; })` | carries |
| `pattern-context:assignment` | error | Assignment, compound assignment, `++`, `--`, or `delete` in tier R | Move the write into an `action(() => ...)` or a `handler` | carries (now also covers `++`, `--`, `delete`) |
| `pattern-context:loop` | error | A loop in tier R | Use `map`, `filter`, or `flatMap` on the collection, or move the loop into `computed(() => ...)` | carries |
| `pattern-context:early-return` | error | A `return` that is not the last statement, or a second `return` | Write one `return` and select with `c ? a : b` | carries |
| `pattern-context:control-flow` | error | `if`, `switch`, `try`, `throw`, or a labeled statement in tier R | Use `c ? a : b` for a choice of values. Move anything else into `computed(() => ...)` | new (the transformer reports some of these as `pattern-context:computation`) |
| `pattern-context:statement` | error | An expression statement that is not a recorded call (§4.2), including `cell.get();` and `void x;` | Bind the value with `const`, or delete the statement. To run code for its writes, use `computed(() => { ... })` as a statement | changes (replaces the statement-position case of `pattern-context:get-call`) |
| `pattern-context:function-creation` | error | A function or class created in tier R outside the callback positions of §4.4 and §4.5 | Declare the function at module scope and call it, or wrap the computation in `computed(() => ...)` | carries |
| `pattern-context:object-member` | error | A method, getter, setter, or function-valued property in an object literal in tier R | Return data. For behavior, return a stream made by `action` or a bound `handler` | carries |
| `pattern-context:parameter-form` | error | A default value or a rest element in the pattern parameter, or a dynamic key in its destructuring | Declare the default in the input type (`glaze: Default<string, "plain">`). Read remaining properties from the undestructured parameter | new |
| `pattern-context:builder-placement` | error | `lift(...)` or `handler(...)` called in tier R | Define it at module scope, or use `computed(() => ...)` for an immediate `lift(fn)(args)` and `action(() => ...)` for a handler that needs no separate state | carries |
| `pattern-context:callback-container` | error | An arrow function passed to a method or function that §4.4 does not give a callback position (`forEach`, `some`, `find`, `reduce`, `toSorted`, `then`) | Wrap the whole expression: `computed(() => xs.some((x) => x.done))` | changes (now covers every non-structural callback, in every tier-R site, not only JSX) |
| `reactive:unsupported-call` | error | A call in tier R whose callee matches no row of §4.4, such as a method the standard-library table does not mark "R" | Wrap the expression in `computed(() => ...)`, or call an authored function that does the work | new (replaces `pattern-context:receiver-method-call`, `pattern-context:inline-reactive-root-access`, `reactive:call-argument-computation`) |
| `reactive:unsupported-expression` | error | `new` of a non-cell constructor, `await`, `yield`, `this`, `instanceof`, a tagged template other than `str`, `void`, or the comma operator in tier R | Wrap the expression in `computed(() => ...)` | new (replaces the remaining cases of `pattern-context:computation`) |
| `opaque-get:invalid-call` | error | `.get()` on a value whose type is not a cell or stream type | Read the value directly: `donut.name`, not `donut.get().name`. Only `Writable<T>` and `Cell<T>` are read with `.get()` | carries |
| `pattern-context:self-access` | error | `x[SELF]` where `x` is not the pattern's own input parameter, or anywhere in tier F | Read `const self = input[SELF]` in the pattern body, or destructure `[SELF]: self`, and capture `self` | carries |
| `ses-callback:callable-capture` | error | A tier-F body inside tier R captures a function value from an enclosing function scope | Move the function to module scope | carries |
| `pattern-context:patterntool-requires-pattern` | error | `patternTool` given a bare function | Wrap it: `patternTool(pattern(fn), extraParams)` | carries |
| `collection:nested-scan` | warning | An inline reactive collection callback scans a captured reactive collection | Measure, and consider an index (`keyBy`, `groupBy`) or an aggregate | carries |
| `pattern-context:get-call` | — | — | — | retired: a `.get()` on a cell is valid at every tier-R expression site (§4.4); the statement case is `pattern-context:statement` and the non-cell case is `opaque-get:invalid-call` |
| `pattern-context:optional-chaining` | — | — | — | retired: `?.` is a path projection at every tier-R site |
| `pattern-context:computation` | — | — | — | retired: operators and dynamic keys are tier-R operations everywhere; what stays unsupported has the two `reactive:` identifiers above |
| `compute-context:local-reactive-use` | — | — | — | retired: tier F cannot create a reactive value (`function-body:builder-call`) |
| `standalone-function:reactive-operation` | — | — | — | retired: replaced by `function-body:builder-call`; `map` in an authored function is ordinary JavaScript |

### 10.3 Function tier

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `function-body:async` | error | `async`, `await`, or `for await` | Use an effectful built-in for asynchronous work (the fetch family, the language-model built-ins) and read its result reactively | new |
| `function-body:generator` | error | A generator or `yield` | Return an array | new |
| `function-body:class` | error | A class declaration or expression | Use an object type and functions | new |
| `function-body:this` | error | `this`, `super`, `new.target`, or `arguments` | Take the value as a parameter; use a rest parameter for variable arguments | new |
| `function-body:var` | error | `var` | Use `let` or `const` | new |
| `function-body:for-in` | error | `for...in` | Use `for (const key of Object.keys(value))` | new |
| `function-body:dynamic-code` | error | `eval`, the `Function` constructor, `import()`, `import.meta`, `with`, `debugger` | Import statically; remove the statement | new |
| `function-body:accessor` | error | A getter, setter, or method in an object literal | Write a property that holds an arrow function, or compute the value eagerly | new |
| `function-body:unsupported-global` | error | A reference to a global §9 lists as not typed | The built-in named in the message, where one replaces it; otherwise remove the use | new |
| `function-body:global-write` | error | A write to a global or to a member of one | Keep the state in a cell | new |
| `function-body:ambient-read` | error | `Date.now()`, `new Date()` without arguments, or `Math.random()` in a `lift`, a `computed`, a promoted expression, or the pattern body, directly or through an authored function they call | Read the clock in a `handler` or `action` and store the value in a cell, or take the time as an input | new (the sandbox gate refuses the same read at run time) |
| `function-body:builder-call` | error | `pattern`, `lift`, `handler`, or `computed` called in tier F, other than an inline `pattern(...)` as the callee of an instantiation | Define the builder at module scope and call its result. A function body that needs a reactive value instantiates a pattern | new |
| `function-body:handler-capture` | error | An inline event handler or an `action` in tier F captures a `let` binding | Copy the value into a `const` before the handler and capture that | new |
| `verb-result:undeclared-return` | error | A `handler` or `action` without a result type argument returns a plain value from a block body | Declare the result (`action<Event, Result>(...)`, `handler<Event, State, Result>(...)`), or use a bare `return;` | carries |
| `mergeable-push:read-then-push` | warning | A handler reads a mergeable collection and then pushes to it | Push without reading, or use the merge-safe operation the message names | carries |
| `footprint:widened` | hint | Footprint analysis gave up on an expression (§5.4) | The rewrite for the cause: a static key, a narrower argument, named properties in place of a spread | new |
| `computed:not-promoted` | hint | A `computed` used as a value fails the criterion of §6.1 | The first disqualifying construct and its promotable form, where one exists | new |
| `computed:redundant` | hint | A `computed` meets the criterion of §6.1, so the wrapper changes nothing | Write the body in place of the call ([§12.2](#122-drop-computed-around-a-promotable-expression)) | new |

### 10.4 Types

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `subset-type:conditional`, `subset-type:mapped`, `subset-type:template-literal`, `subset-type:overload`, `subset-type:class`, `subset-type:callable-object`, `subset-type:assertion-signature`, `subset-type:unsupported-modifier`, `subset-type:index-signature-key`, `subset-syntax:enum`, `subset-syntax:namespace`, `subset-syntax:ambient-declaration`, `subset-syntax:decorator` | error | The feature of §7.9 | The replacement in §7.9. Where the feature is needed for a helper's signature, move the helper to an imported module ([§5.5](#55-imported-typescript-tier-i)) | new |
| `subset-type:function-in-data` | error | A function type inside a pattern input or result type, a cell's value type, or a handler's state or event type | Use a stream for behavior, or keep the function at module scope | new (today the value fails to store at run time) |
| `subset-type:non-regular-recursion` | error | A recursive generic alias or interface that passes changed type arguments to itself | Recurse with the declaration's own parameters | new (replaces `cfc-schema:recursion-limit`) |
| `subset-type:empty-intersection` | error | A written intersection that is `never` | Use a union, or one object type with both sets of properties | new |
| `subset-type:operator-operand` | error | `Pick`, `Omit`, `Partial`, or `Required` applied to a type that is not an object type | Apply the operator to the object type and label the result | new |
| `subset-type:cannot-infer-type-argument` | error | A generic call leaves a type parameter undetermined and without a default | Write the type argument | new |
| `subset-type:any` | error | `any` written as a type or as a cast target | The explicit form of §7.8 for the use found: `unknown` or `Cell<unknown>` for a reference, no cast for a pattern instance or a labeled value, `instanceof Error` for a caught error, `Record<string, unknown>` or `JSONValue` for open data | new |
| `subset-type:mismatch` | error | An ordinary type error: assignability, a missing property, a wrong argument count, a possibly-`undefined` receiver | The expected and found types, and for a possibly-`undefined` receiver the `?.` or `??` form | new (reported by TypeScript today) |
| `cast-validation:double-unknown` | error | A cast through `unknown` to an unrelated type | Declare the value with the type it has, or narrow it with a type predicate | carries |
| `cast-validation:forbidden-cast` | error | A cast to `Reactive<T>` | Remove the cast | carries |
| `cast-validation:cell-cast` | error | A cast to a cell type | Declare the cell type where the value is received (the pattern input or the handler state) | carries |
| `schema:unknown-type-access` | error | A function body reads a property of a parameter, or of a member, typed `unknown`, or of an unbound type parameter | Replace `unknown` with a type that declares the properties read | carries |
| `schema:path-not-in-type` | error | A function body reads a property its parameter's type does not declare | Add the property to the type | carries (now an ordinary type error with this identifier) |
| `pattern:any-result-schema` | error | A pattern's inferred result is `any` or `unknown` at the top level | Declare the result: `pattern<Input, Output>(...)` | carries |
| `pattern-result:unknown-type` | error | A field of an inferred, unnamed result type is `unknown` | Annotate the value that produces the field, or declare the result type | carries |
| `pattern-result:opaque-reserved-key` | error | A pattern's declared result types a reserved key such as `[UI]` as `unknown` at its root | Type it as `VNode`, or as the value it holds | carries |
| `reactive-capture:unknown-type` | error | A value captured by a tier-F body has type `unknown` | Annotate the captured value | carries |
| `schema-type:symbol` | error | `symbol` or a `unique symbol` in a type | A string key, or `Exclude<T, symbol>` on a union | carries |
| `schema-type:unread` | — | — | — | retired: the checker either types a node or refuses it |
| `stdlib:unsupported-member` | error | A standard-library member §9 does not list | The nearest listed member | new |
| `import:signature-not-in-subset` | error | An export imported from a tier-I module lacks a full annotation, or its signature uses a type the subset refuses | Annotate every parameter and the return type with subset types | new |
| `import:not-a-function` | error | A value imported from a tier-I module is not a function or a type | Move the constant into a subset module | new |

### 10.5 Labels, defaults, and scopes

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `cfc-label:not-a-list` | error | A label argument that is not a tuple of atoms, such as `string[]` | Write a tuple: `readonly ["secret"]` | carries |
| `cfc-label:not-static` | error | A label atom outside the constant language of §8.5 | Write a literal, an object literal type, `AnyOf<...>`, or `PolicyOf<typeof rules>` | changes (was the warning `cfc-label:unread`, which left a `null` atom) |
| `cfc-label:conflict` | error | Two annotations on one path declare a key other than `confidentiality` differently | Declare the key once | changes (was a generation error without an identifier) |
| `cfc-label:cast-ignored` | warning | A cast whose target type carries annotations the operand's type does not | Remove the cast; declare the label on the cell, the pattern input, or the pattern result | new |
| `cfc-write-authorized-by` | error | A writer binding that is not `typeof` of a supported declaration | Name a `handler(...)`, `module(...)`, or `requireEventIntegrity(...)` binding, or a function declaration | carries |
| `cfc-policy-of`, `cfc-policy-authoring` | error | As the contract defines | As the contract defines | carries |
| `cfc-write-authorized-by:unread` | — | — | — | retired: a binding reference survives every substitution (§8.7) |
| `cfc-label:unread` | — | — | — | retired: replaced by `cfc-label:not-static` |
| `cfc-schema:recursion-limit`, `cfc-schema:recursive-alias-of-any` | — | — | — | retired (§8.7) |
| `cfc-flow:max-confidentiality`, `cfc-flow:required-integrity`, `cfc-flow:write-policy` | error | A declared constraint that the declared labels of a template's slots cannot satisfy. The conditions are defined in `plan-and-label-templates.md` | The slot whose label violates the constraint, and the declaration to change | new (reserved here, specified there) |
| `default:not-static` | error | A `Default` value that is not literal-like or not assignable to its type | Write a literal value of the declared type | changes (was the warning `schema-default:unresolved`) |
| `scope:union-member` | error | A scope wrapper on a member of a union that has a member other than `null` and `undefined` | Put the scope around the union: `PerUser<A \| B>` | new |

## 11. Corpus evidence

### 11.1 Method

The measurements below come from throwaway scripts that parse each file with
the TypeScript parser and classify every node by tier, using the syntactic
tier boundaries of §1. The scripts are not part of the repository. Counts
are of syntax nodes, and the file counts are of files containing at least
one.

**The corpus** is every `.ts` and `.tsx` file under the six pattern
categories (`patterns/system`, `product`, `apps`, `examples`, `showcase`,
`dev`) that imports `commonfabric`, or is reachable by relative import from
a file that does, excluding test files. That is 404 modules and about
114,000 lines. It holds 477 `pattern` definitions, 594 `handler` and 45
`lift` definitions at module scope, 1,466 `computed` calls, 245 `action`
calls, and 180 inline JSX event handlers.

Files that are not patterns were left out: the iframe guest scripts
(`guest.ts`), which are browser programs, the Topics command-line tools
under `patterns/apps/topics/tools/`, and plain unit tests. Pattern test
files (`*.test.tsx`) are patterns too; they were measured separately and are
reported only where they differ.

**FabriChat** is the nine non-test modules of `patterns/system/fabrichat/`:
about 9,000 lines, 16 patterns, 25 handlers, 111 `computed` calls, and 10
actions. Its design is in [`docs/specs/fabrichat/`](../fabrichat/README.md).

Two limits of the method matter. Receiver types were not resolved, so method
counts are by name. And nothing was type-checked, so the measurements show
which constructs the subset would refuse, not whether the remaining code
passes the subset's type rules. The second is the prototype of the
overview's stage 2.

### 11.2 Constructs with no occurrence

The corpus contains none of the following, so refusing them costs nothing
today: `let`, `var`, classes, enums, and namespaces at module scope;
top-level statements; `async` functions, `await`, generators, classes,
`this`, `var`, `for...in`, labeled statements, getters, setters, object
methods, and `arguments` in any function body; conditional types, `infer`,
and template literal types; decorators; a write to module-scope data from a
function body; and a stateful regular expression at module scope.

The current transformer and the module verifier already refuse several of
these, which is why they are absent. The tier-R statement rules are in the
same position: the 454 block-bodied pattern callbacks consist of 2,820
`const` statements, 454 final `return` statements, 15 expression statements,
and 2 local type declarations, and nothing else.

### 11.3 What the subset refuses in the corpus

| Construct | Occurrences (files) | Where | Resolution |
| --- | --- | --- | --- |
| Function overloads | 5 (2) | `patterns/system/fabrichat/manager.tsx` (4), `patterns/system/private-inbox/private-inbox.tsx` (1); 34 more in 29 pattern test files | Rewrite. Every occurrence is one idiom: a one-line function whose overload signature re-types a cell (`function inboxOf(pointer: Cell<A>): Cell<B>`) over an implementation that returns its argument as `unknown`. It exists because the double cast is refused. [§12.4](#124-a-named-form-for-re-typing-a-cell) proposes `asSchema<T>()` |
| Mapped type | 1 (1) | `patterns/apps/topics/topic.tsx` | Rewrite as `Readonly<Record<K, number \| undefined>>` |
| `any` in a type | 126 (see below) | for example `patterns/system/link-tool/link-tool.tsx`, `patterns/system/knowledge-graph/knowledge-graph.tsx` | Rewrite with the explicit forms of §7.8 |
| `as any` | 52 (21) | for example `patterns/system/notes/daily-journal.tsx`, `patterns/system/agent-queue/agent-queue.tsx` | Remove: the rules of §7.5, §7.6, and §8.6 make most of them unnecessary |
| Arrow function passed to a non-structural method in the pattern body | 2 (1) | `patterns/system/loom/main.tsx` (`some`) | Rewrite: wrap in `computed(() => ...)` |
| `new` of a non-cell constructor in the pattern body | 4 (3) | `new Date(value)` in `patterns/system/notes/voice-note.tsx` and `patterns/apps/activity-log/activity-log.tsx`; `new Uint8Array` in a catalog story | Rewrite: wrap in `computed(() => ...)` |
| `void name;` in the pattern body | 2 (2) | `patterns/system/home/home-ben.tsx`, `patterns/apps/store-mapper/store-mapper.tsx` | Rewrite: delete the statement |
| Ambient authority | 2 (2) | `globalThis.prompt` in `patterns/showcase/scrabble/scrabble.tsx`; `Promise.resolve().then(...)` in a `patterns/dev/` test fixture | Refused with no rewrite. Both rely on something the sandbox is meant not to offer |
| Reflection | 1 (1) | `Object.getOwnPropertySymbols` in a `patterns/dev/` test | Refused. `Object.getPrototypeOf` (4 uses) and `Object.create(null)` (2) were added to §9.3 instead, because the plain-object test they implement has no other spelling |

`any` occurs 178 times in 48 modules, 126 times in a type and 52 times as
the target of a cast. By what it stands for:

| Use | Occurrences | Explicit form (§7.8) |
| --- | --- | --- |
| A reference to another piece or a cell of unknown content: a property typed `any` (33), `Writable<any>` (27), `any[]` and `Array<any>` (6), `AnyCell<any>` (1) | 67 | `unknown`, `Cell<unknown>` |
| A parameter over such a value: a lambda parameter in `map`, `find`, `findIndex`, `filter`, `some` (21), a function parameter (10) | 31 | Follows from typing the collection or the parameter |
| An open record: `Record<string, any>` (12), an index signature (2) | 14 | `Record<string, unknown>`, `JSONValue` |
| A type argument of a builder: `handler<any, State>`, `pattern<Input, any>` | 9 | `unknown`; a declared result |
| Other type positions | 5 | Case by case |
| Cast: `(error as any).message` and similar member reads | 23 | Narrowing with `instanceof Error` |
| Cast: a pattern instance or a cell passed where a view of it is declared: an object property (7), `navigateTo` (5), `push` (5), and 5 others | 22 | No cast: instance-to-view assignability (§7.5), labels outside assignability (§8.6) |
| Cast: a JSX attribute value (5), `Object.keys(x as any)` (2) | 7 | Type the value |

The 22 casts in the seventh row are the ones that exist because a type could
not be expressed: a new `Note` pushed onto a list of `NotePiece`, or a queue
whose exported type carries a write policy its local view does not. Whether
the two assignability rules remove every one of them needs the type-checking
prototype; the script classified them by syntax.

**FabriChat** would need one change: the four overload signatures in
`manager.tsx`. Nothing else in its nine modules is refused. In particular it
uses no `any`, and its two generic helpers and its use of
`keyof T & string` are inside the generics of §7.3 and the intersections of
§7.4.

### 11.4 Where the subset was adjusted to the corpus

These constructs were candidates for refusal. They are accepted, for the
counts shown or because the project owner asked for them.

| Construct | Occurrences (files) | Decision |
| --- | --- | --- |
| Inline event-handler arrows in JSX built inside a function body | 8 (5), for example `patterns/apps/habit-tracker/habit-tracker.tsx` | Accepted as a handler binding (§5.2) |
| `action` created inside a function body | 1 (1) | Accepted, the same way |
| `as T` casts other than `as const` and `as any` | 240 (57) | Accepted as assertions between related types (§7.7) |
| Non-null `!` | 56 (33) | Accepted |
| `typeof name` in a type, outside label arguments | 125 (43) | Accepted (§7.1). Common forms are `Default<typeof EMPTY>`, `ReturnType<typeof handler>`, and `(typeof LIST)[number]` |
| Indexed access types | 29 (13) | Accepted, eager |
| Type predicates | 22 (13) | Accepted, trusted |
| Generic functions; generic aliases and interfaces | 25 (14); 27 (14) | Accepted (§7.3) |
| Intersection types | 17 (13) | Accepted, eager (§7.4) |
| Function types and method signatures in types | 16 (10); 20 (7) | Accepted as code types. Most describe a structural "cell-like" parameter of a helper |
| `Parameters<typeof P>[0]`, `ReturnType<typeof h>` | 12 (2); 5 (1) | Accepted on factory types (§7.2) |
| `Pick`, `Omit`, `Partial`, `Required`, `Readonly`, `Exclude`, `NonNullable` | 46 in total | Native operators |
| Module-scope constant computed by a call or an immediately invoked function | 7 (6) | Accepted as frozen data (§3.2), for example the board tables of `patterns/showcase/scrabble/scrabble.tsx` |
| Default exports and default imports of patterns | 187 imports (52) | In the grammar (§3.1) |
| Module-scope `new Set(...)` | 2 (2) | Accepted, typed `ReadonlySet` |
| Module-scope regular expressions | 9 (6), none stateful | Accepted |
| `try`, `throw`, `instanceof Error` in function bodies | 29 (16); 145 (20); 8 (6) | Accepted (§5.1) |
| `delete` in a function body | 1 (1) | Accepted on local values |
| Expression statements in the pattern body | 15 (13): 11 `computed` calls kept for their writes, 2 calls of `lift` results, 2 `void` | The first 13 are accepted (§4.2) |
| `.get()` in the pattern body | 66 (23) | Accepted on cells at every site (§4.4) |
| Dynamic keys in the pattern body | 17 (7) | Accepted (§4.4) |
| Handler or lift callback passed by local name | 6 (2) | Accepted (§3.2) |
| Tagged templates in function bodies | 7 (4), all `debugStr` | Accepted as calls |

### 11.5 Promotion

Of the 1,466 `computed` calls, 11 are in statement position and exist for
their writes. Applying the criterion of §6.1 by syntax to all 1,466:

| Outcome | Count | Share |
| --- | --- | --- |
| Promoted: expression or `const`-then-`return` body, structural operations only | 980 | 67% |
| Promoted: the same, with at least one call of an authored function | 222 | 15% |
| Promoted through the guard form (`if (...) return ...;` chains) | 93 | 6% |
| Not promoted: a statement body (loops, `let`, expression statements, `try`) | 101 | 7% |
| Not promoted: an expression with a disqualifying construct | 70 | 5% |

So 1,295 of 1,466 (88%) are promoted. Without the guard form the figure is
82%, which is the reason the criterion includes it.

The 70 disqualified expressions fail on: a function argument to `some`,
`find`, `findIndex`, `reduce`, `toSorted`, or `replace` (about 40); the
mutating `sort` or `reverse` on a copy (14); `new Set` or `new Date` (9);
and a few cell methods outside the pure list. If `builtin-inventory.md`
classifies `some`, `find`, and `findIndex` as structural operations, about 25
of them move to the promoted rows.

In FabriChat, 96 of 111 (86%) are promoted by the expression and
`const`-then-`return` forms and 3 more by the guard form.

The count is syntactic. It treats a method as pure by its name, and it does
not check condition 5 of §6.1 against types, so the type-checked figure will
differ slightly.

### 11.6 Labels

The corpus writes 199 references to label aliases outside `AnyOf` and
`PolicyOf`. `TrustedActionWrite` (56) and `WriteAuthorizedBy` (40) dominate,
then `Confidential` (30) and `AddIntegrity` (15).

- 221 label arguments are `typeof` binding references, 56 are tuples written
  in place, 12 name an alias, 12 are object literal types, and 10 are string
  literals. All are in the constant language of §8.5.
- 42 payloads are themselves label aliases (nesting), 10 are arrays, and 1
  is a union with `undefined`. None is an intersection.
- 10 generic aliases wrap a label alias, such as `OwnerPrivate<T>` in
  `patterns/system/private-inbox/private-inbox.tsx`.
- 4 casts target a labeled type, in
  `patterns/examples/cfc-spec-gallery/main.tsx` and
  `patterns/examples/cfc-render-policy-demo/main.tsx`
  (`input.content as Confidential<string, L>`). They become redundant
  (`cfc-label:cast-ignored`).

No authored label in the corpus depends on a corner case of §8.7 that the
annotation model changes the meaning of. The cases that table removes are
ones the brand encoding has to defend against, not ones patterns rely on.

### 11.7 Standard library

The members listed in §9 without a † each occur in the corpus. The most
frequent in function bodies, by name, are `trim` (346), `map` (338),
`filter` (296), `push` (292), `some` (134), `Date.now` (105), `slice`
(100), `join` (99), `findIndex` (77), `includes` (71), `toLowerCase` (71),
`find` (63), `sort` (49), `Math.floor` (49), `split` (44), `has` (42),
`toString` (41), and `Array.from` (41). `new Error` occurs 114 times,
`new Date` 54, `new Set` 44, and `new Map` 42.

`Date.now` (105 occurrences in 45 files) and `Math.random` (31 in 23) are
the two ambient reads. The script did not determine how many sit in a
handler, where they are allowed, and how many in a `lift` or a `computed`,
where the sandbox refuses them at run time today.

## 12. Recommended syntax changes

Each change keeps today's form valid unless it says otherwise.

### 12.1 Write conditionals as JavaScript

`ifElse`, `when`, and `unless` stay recognized forms of the selection
operation, and the conditional expression is the recommended spelling. The
corpus has 155 `ifElse` calls in 53 files against 439 conditional
expressions in pattern bodies.

```tsx
// Shown for illustration only.
// Before
<div>{ifElse(hasSprinkles, <SprinkleBadge />, <PlainBadge />)}</div>

// After
<div>{hasSprinkles ? <SprinkleBadge /> : <PlainBadge />}</div>
```

### 12.2 Drop `computed` around a promotable expression

A `computed` that meets §6.1 is equivalent to its body, so the wrapper is
optional. The compiler reports such a wrapper as a hint
(`computed:redundant`) and can offer the removal as a fix.

```ts
// Shown for illustration only.
// Before
const label = computed(() => count === 1 ? "1 donut" : `${count} donuts`);
const total = computed(() => {
  const subtotal = price * count;
  return subtotal * (1 + taxRate);
});

// After
const label = count === 1 ? "1 donut" : `${count} donuts`;
const subtotal = price * count;
const total = subtotal * (1 + taxRate);
```

`computed` remains the way to enter tier F from the pattern body: loops,
`let`, `try`, and methods that take a function.

### 12.3 Read cells the same way everywhere

Because a `.get()` on a cell is valid at every tier-R site, the author no
longer moves a read into `computed` only because of where it stands.

```ts
// Shown for illustration only.
// Before
const titles = computed(() => rows.map((row) => row.title.get()));

// After
const titles = rows.map((row) => row.title.get());
```

### 12.4 A named form for re-typing a cell

The overload idiom of §11.3 states "this cell, read under another type"
through a hole in overload compatibility. The runtime's cells already have
the operation the idiom stands for: `asSchema`, which returns the same cell
read under another schema. This document proposes its type-argument form as
the language construct, with the compiler supplying the schema from the
type, as it does for `toSchema<T>()`.

```ts
// Shown for illustration only.
// Before
function boxOf(pointer: Cell<DonutBoxPointer>): Cell<Pick<DonutBox, "add">>;
function boxOf(pointer: Cell<DonutBoxPointer>): unknown {
  return pointer;
}

// After
const boxOf = (pointer: Cell<DonutBoxPointer>) =>
  pointer.asSchema<Pick<DonutBox, "add">>();
```

The proposed rules are these.

- It is a method of cell handles only, valid in tier R and tier F.
- It changes how the cell is read, never what is stored. A read through the
  result is validated against the schema of `T`, as any read is.
- It cannot remove a label. The labels of what is read come from the stored
  document and from the template of the read. Annotations in `T` add
  constraints and never replace the stored ones.
- The plan records the call as a path projection with a schema, so a
  footprint through it is as precise as one through a declared type.

Because it changes the schema a value is read under, the second and third
rules are CFC decisions and go through the specification
([§13](#13-open-questions)).

### 12.5 Remove casts to labeled types

```ts
// Shown for illustration only.
// Before
note.set(text as Confidential<string, readonly ["recipe-secret"]>);

// After
note.set(text);
```

The label is declared once, on the cell
(`new Writable<Confidential<string, readonly ["recipe-secret"]>>("")`).

### 12.6 Mark imported TypeScript with a directive

A helper whose types need a feature the subset refuses moves to a module
that begins with `"use typescript";` ([§5.5](#55-imported-typescript-tier-i)).

```ts
// Shown for illustration only.
// Before: in the pattern module
type Shape<T> = T extends readonly (infer E)[] ? E : never;
const firstOf = <T extends readonly unknown[]>(xs: T): Shape<T> => xs[0];

// After: in sprinkle-math.ts
"use typescript";
export function firstTopping(toppings: string[]): string | undefined {
  return toppings[0];
}
```

### 12.7 Declare defaults in types, not in the parameter

```ts
// Shown for illustration only.
// Before
pattern<{ glaze?: string }>(({ glaze = "plain" }) => ({ glaze }));

// After
pattern<{ glaze: Default<string, "plain"> }>(({ glaze }) => ({ glaze }));
```

## 13. Open questions

Settled since the first draft, and written into the sections above: tier I
is marked by `"use typescript";` (§5.5); the load-time verifier is retired
for subset modules and kept for tier-I modules (§3.4); `any` is refused and
each use gets an explicit form (§7.8); and an inline event handler in a
function body is a handler binding (§5.2).

The first two questions need a decision from the project owner. The rest are
for the sibling documents or for the prototype.

1. **What editors show.** An editor type-checks pattern source with the
   TypeScript compiler against the published `commonfabric` typings. The
   pattern compiler reads neither. So an editor can report an error the
   compiler does not (the brand encoding, §8.6), and cannot report the errors
   only the compiler knows: read-only module data, a refused type feature, a
   tier-R statement rule. There are two steps, and they are independent.
   - Simplify the published typings to identity aliases once the transformer
     no longer reads them (§8.6). This removes the false errors and needs no
     new tooling.
   - Show the compiler's own diagnostics while editing. The usual mechanism
     is a language-service plugin: a small extension the TypeScript service
     inside the editor loads, which runs the pattern compiler on the open
     file and adds its diagnostics to the list the editor displays. Without
     one, authors see the compiler's diagnostics only when they compile.
     Since most authors are language models that compile on every change,
     this step can wait.
2. **The rules of `asSchema<T>()`.** §12.4 proposes it to replace the
   overload idiom found in FabriChat, the private inbox, and 29 pattern test
   files, and proposes that it validates reads and can never remove a label.
   Those two rules change what CFC decides about a re-typed read, so they
   need a ruling in the specification before the construct is relied on.
3. **Value semantics of tier R on missing data.** This document assumes a
   tier-R expression has the value semantics of the same JavaScript
   expression, so that promotion preserves values exactly, and that strict
   `null` checks make a read through a possibly-missing value a type error.
   Stored data can still fail to match its declared type. What a path
   projection does then (yield `undefined`, or put the cone in an error
   state) belongs with the overview's open question on error states.
4. **The label rule of a dynamic key.** §4.4 allows `a[k]` in tier R as an
   index operation. This document assumes its template is the key's slots,
   the container's enumeration, and the selected element's slots, and that
   `plan-and-label-templates.md` defines the operation. If it does not, the
   fallback is to refuse a dynamic key in tier R, as the transformer does in
   the pattern body today, which affects 17 expressions in 7 modules.
5. **The label rule of a handler binding.** §5.2 adds a fourth runtime call
   to the three the overview lists. `plan-and-label-templates.md` has to say
   what the plan records for a stream bound inside a function body, and
   `builtin-inventory.md` whether a `lift` or a `computed` may make one.
6. **More structural collection methods.** `some`, `find`, and `findIndex`
   with a callback account for most `computed` calls that fail promotion on
   a single construct. Whether they become structural operations is for
   `builtin-inventory.md`.
7. **Instance-to-view assignability.** §7.5 lets a pattern instance stand
   where a view of its result is declared. The prototype has to confirm that
   this, with labels outside assignability, removes the 22 casts of §11.3,
   and whether a handle needs a further rule.
8. **Cells as arguments of imported functions.** §5.5 refuses them. Allowing
   them needs a declared write footprint in the signature.
9. **External packages.** The corpus's pattern modules import none. The
   iframe guests import several, and they are not patterns. Whether tier I
   ever reaches beyond the program's own modules is deferred with the
   sandbox's dynamic-import question.
10. **Stored source.** Today some authoring errors are demoted to warnings
    when stored source is recompiled. Whether the new compiler ever compiles
    source that an older compiler admitted, and with which severities, is
    part of the overview's migration question.
11. **Per-instantiation checking of generic functions.** §7.3 checks a
    generic function body once per instantiation. That is simple and exact,
    and it reports an error in a generic helper at each call that triggers
    it. The prototype should confirm that the messages stay usable.
