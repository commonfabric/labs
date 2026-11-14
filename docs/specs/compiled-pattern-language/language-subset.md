# Language subset (proposed)

**Status:** proposed. Nothing here is implemented. This document details one
part of the [compiled pattern language](README.md): the language itself. It
defines the TypeScript subset, its type rules, how labels are read, the
statelessness rule, the promotion of `computed`, the diagnostics, and the
standard-library surface the subset type checker has to type. It ends with a
measurement of the pattern corpus against these rules and with the questions
that remain open.

Five documents beside this one, and the overview, own their subjects.
This document refers to them and does not define their content.

- `plan-and-label-templates.md` owns the plan format, slots, observation
  classes, the footprint record, and the label rule of every operation.
- `footprint-analysis.md` owns the analysis that computes a function body's
  footprint, the causes of a widening, and what makes a computation a
  materializer.
- `builtin-inventory.md` owns the classification of each built-in as a
  structural or an effectful operation, and each built-in's label rule.
- `execution-and-storage.md` owns the transaction of one cause, cone
  evaluation, causal identifiers, cache promotion, and the migration of
  stored instances.
- `scheduler-and-serving-loop.md` owns what remains of the scheduler across
  instances, the convergence bounds among them, and the serving loop.

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
a promoted `computed`. The body of a `computed` is checked under the rules of
tier F whether or not it is promoted, and a promoted one is compiled as a
tier-R expression ([§6.2](#62-what-promotion-preserves)).

**Function tier (tier F).** The body of a callback given to `lift`, `handler`,
`computed` (when not promoted), `action`, or `assert`; the body of an inline
JSX event handler; and the body of a function declared at module scope of a
module in the subset.

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

**Handle type.** One of the cell types of [§7.2](#72-api-types), `Stream`
included, the type `SqliteDb`, and the type of a collection index handle. A
handle type is a data type: it has a schema, and a value of it is stored as
a link to the cell. So a handle can sit in a pattern input or result, in a
cell, in a handler's state, and in an event. Two rules ask for more than a
data type and exclude a handle type by name: frozen data at module scope
holds no handle ([§3.2](#32-initializer-kinds)), and the signature of a
function imported from tier I has none
([§5.5](#55-imported-typescript-tier-i)).

**Factory type.** `PatternFactory<I, O>` and `HandlerFactory<E, S>`: the
types of a pattern and of a handler passed by reference. A factory type is a
data type, although calling it looks like calling a function. Its value is a
reference to a compiled definition, not code, so it can be stored and sent
([§7.2](#72-api-types)).

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
   programs TypeScript accepts. [§8.6.1](#861-the-published-typings) says
   how the typings keep this true for labels and for `key`, and names the
   two program shapes for which an editor reports an error the compiler
   does not, for as long as the current typings are the published ones.
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
| Import | `import { a, type B } from "..."`, `import d from "..."`, `import * as ns from "..."`, `import type ...`. Each form binds at least one name. Specifiers: `commonfabric`, `commonfabric/<name>`, a relative path to another module of the program, or a pinned `cf:` specifier |
| Type declaration | `type` alias, `interface`, each optionally exported and optionally generic ([§7](#7-type-system)) |
| Function declaration | `function name(...) { ... }`, optionally exported. Not `async`, not a generator, no overload signatures |
| Constant declaration | `const name = initializer`, optionally exported, with exactly one of the initializer kinds of §3.2. A type annotation is optional. Destructuring is allowed only for frozen data |
| Export | `export { a, b as c }`, `export { a } from "..."`, `export * from "..."`, `export type { T }`, `export default name`, `export default expression`, `export default function name(...) { ... }` |

`export default expression` is a constant declaration without a name. The
expression is of one of the three initializer kinds of §3.2, and the rules
of its kind apply to it: `export default pattern(...)` is a builder
definition, `export default (donut: Donut) => donut.name` is an authored
function, and `export default ["plain", "sugar"]` is frozen data.

Every other statement is refused at module scope, each under one
identifier.

| Refused at module scope | Diagnostic |
| --- | --- |
| `let`, `var` | `module-scope:let-declaration`, `module-scope:var-declaration` |
| `class` | `module-scope:class-declaration` |
| `enum`, `namespace` | `subset-syntax:enum`, `subset-syntax:namespace` |
| `declare global`, module augmentation, and a second `interface` of one name ([§7.9](#79-type-features-the-checker-refuses)) | `subset-syntax:ambient-declaration` |
| An import with no bindings, `import type {} from "..."` included; `import name = require("...")`; a specifier that is not one of the four of the table | `module-scope:import-form` |
| An expression statement, a control-flow statement, a block, top-level `await`, a `using` declaration, `export = name`, `export as namespace name`, and any other statement the table does not list | `module-scope:statement` |

An import with no bindings is refused in its type-only form too. It names
nothing a module can use, and the compiler has the API types built in
([§7.2](#72-api-types)), so it loads no declaration by importing a module.
An ambient `declare const` emits nothing and is allowed.

### 3.2 Initializer kinds

Every `const` at module scope is one of three kinds, decided by the syntax of
its initializer after parentheses, `as`, and `satisfies` are removed.

**Builder definition.** A call to one of the three module-scope builders:
`pattern`, `lift`, or `handler`. The callback of `lift` and of `handler` is
a function written at the call, or the name of a function or
function-valued constant declared in the same module. The callback of
`pattern` is written at the call ([§4.1](#41-pattern-callback)). A callback
reached through a property, an import, or a call is refused for all three,
and so is a name as the callback of `pattern`
(`builder-callback:indirect-reference`).

The two differ because of the tiers. A function declared at module scope is
a tier-F body ([§1](#1-terms)), and so is the callback of a `lift` or a
`handler`, so a name there denotes a body of the tier the builder expects.
The callback of `pattern` is a tier-R body. Passing a module-scope function
to `pattern` would give one function two tiers, against rule 4 of
[§2](#2-design-rules).

The other builders are not module-scope builders. `computed` and `assert`
take a function and are written in tier R only (§4.4). `action` takes a
function and is written in tier R or in tier F (§5.2). The function is
written at the call for each of the three, and a name in its place is
refused under the same identifier.

Every other API function called at module scope is a plain function whose
result is frozen data, or a compile-time intrinsic: `exchangeRule(...)` and
`exchangeRules([...])`, which freeze and return a rule declaration that the
CFC authoring contract requires to be exported and static; `toSchema<T>()`,
which the compiler replaces with the schema of `T`; and `schema(...)`,
`dataFile(path)`, `table(...)`, the `cfcAtom` and `cfcPattern`
constructors, and the Fabric value classes.
[§4.4.4](#444-pure-api-functions) lists the plain functions, with the
tiers a call of each is legal in.

**Function.** An arrow function or a function expression written in place. It
is an authored function, exactly as a function declaration is.

**Frozen data.** Any other expression. It is evaluated once when the module
loads, and the value is frozen deeply before any function can observe it. Its
type must be a data type that contains no handle type, or a `ReadonlyMap`,
`ReadonlySet`, or `RegExp` of such types (`module-scope:frozen-data-type`).
A destructuring declaration is always frozen data. The expression may call
authored functions and pure standard-library functions, may be an
immediately invoked function, and may read other module-scope constants
declared earlier or imported. The expression is checked under the
expression rules of tier F ([§5.1](#51-grammar)), and a function written in
it, an immediately invoked function or a callback, is a tier-F body. So
`new Map(...)` and `new` of a Fabric value class are legal there, and `new`
of an authored function is refused in the initializer as in any function
body (`function-body:constructor`).

Module scope has no instance, no event, and no transaction, so the
expression is limited in two ways. Each limit holds for the expression and
for every authored function it calls.

- **It reads no ambient clock and no entropy**
  (`function-body:ambient-read`). The value would differ between two loads
  of one module.
- **It makes no runtime call** (`module-scope:runtime-call`). The runtime
  calls are the five kinds of [§5.2](#52-runtime-calls): instantiating a
  pattern, creating a cell, requesting an effectful built-in, reading
  context, and binding a handler. A call of `computed`, `action`, or
  `assert` is refused under the same identifier, because each defines a
  node of an instance. The pure API functions of
  [§4.4.4](#444-pure-api-functions) that list module scope are not runtime
  calls. A call is classified as [§4.4](#44-calls) classifies it: by name
  where the callee resolves to a definition, and by the callee's type
  otherwise. So a call of a factory value held in a module-scope constant,
  `TOOLS[0]({ flavor })`, is an instantiation or a binding and is refused.

A `pattern(...)` or `handler(...)` call written inside a frozen-data
expression, as in `const TOOLS = [pattern(...), pattern(...)]`, is a
builder definition written in place. It follows the rules of a builder
definition, and the frozen data holds its factory value, which is a data
value ([§7.2](#72-api-types)). A `lift(...)` call written there yields a
function, which frozen data cannot hold
(`module-scope:frozen-data-type`).

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
| Builder callbacks | `verifyTrustedBuilderCall` accepts a function at the call or a local name | The same for `lift` and `handler`. The callback of `pattern` is written at the call, and a local name is refused (§3.2) |
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
written at the call, and not the name of a function declared elsewhere
(`builder-callback:indirect-reference`, [§3.2](#32-initializer-kinds)). It
is not `async` and not a generator. It has zero parameters or one. The
parameter is an identifier or an object destructuring pattern with static
keys; a destructured property may be renamed, and may be the well-known key
`[SELF]`. A destructured property may itself be destructured by an object
pattern, under the same rules at every depth:
`({ box: { flavor, glaze } }) => ...`. Four forms are refused in the
parameter, at any depth (`pattern-context:parameter-form`): a default
value, a rest element, a key that is not static, and an array pattern. A
default belongs in the input type as `Default<T, V>`, where the schema can
see it. An array pattern is refused because the parameter names properties
of the input; a property that holds a tuple is destructured in a `const` of
the body (§4.2).

The input type comes from the first type argument of `pattern`, or from the
parameter's annotation. The result type comes from the second type argument,
from the callback's return annotation, or is inferred from the returned
expression.

### 4.2 Statements

The body is an expression, or a block that consists of the following
statements in any order, followed by exactly one `return` with an expression.

| Statement | Rule |
| --- | --- |
| `const` declaration | One or more declarators, each with an initializer that is a tier-R expression. Object and array destructuring is allowed, nested to any depth. A destructured key that is not static is a chosen child, as `a[k]` is (§4.3, §4.4). A default value or a rest element is allowed only where the initializer is a constant expression (below) |
| Expression statement | Only a call whose result is deliberately unused and that the plan records: `computed(...)` in statement position (a computation that writes), a call of a `lift` result, a call of an authored function, or a pattern instantiation |
| `type`, `interface` | Allowed. They declare types and emit nothing |
| `return` | Exactly one, last, with an expression |

Everything else is refused, each under one identifier.

| Refused in a tier-R body | Diagnostic |
| --- | --- |
| `let`, `var` | `pattern-context:let-declaration`, `pattern-context:var-declaration` |
| Assignment, compound assignment, `++`, `--`, `delete` | `pattern-context:assignment` |
| A loop | `pattern-context:loop` |
| `if`, `switch`, `try`, `throw`, a labeled statement | `pattern-context:control-flow` |
| A `return` that is not the last statement, or a second `return` | `pattern-context:early-return` |
| A block body whose last statement is `return;`, or that has no `return` | `pattern-context:missing-return` |
| A function declaration or a class | `pattern-context:function-creation` |
| An expression statement that is not one of the calls above | `pattern-context:statement` |
| A default value or a rest element in a `const` destructuring whose initializer is not a constant expression | `reactive:unsupported-expression` |

Three points complete the two tables.

- **A constant expression** is a literal, a module-scope constant, an
  object or array literal of constant expressions, or a `const` of the same
  body that is initialized by a constant expression. The compiler knows
  such a value, so a default or a rest element in a destructuring of it is
  a constant too. In a destructuring of any other value the author writes
  the default as an expression, `const glaze = donut.glaze ?? "plain"`,
  and names the remaining properties.
- **An expression statement is reported once.** A statement that is not a
  recorded call is `pattern-context:statement`, and the expression in it is
  not reported a second time under the identifier that would refuse it as
  a value. So `void name;` and `console.log(name);` are each one
  diagnostic. One kind of statement has another identifier: a method of a
  cell handle called outside its tiers, such as `count.set(1);`, is
  `cell:method-tier` alone ([§4.7](#47-cell-and-handle-methods)).
- **Whether a call in statement position is a recorded call** is decided
  as §4.4 classifies the callee: by name where the callee resolves to a
  definition, and by the callee's type otherwise. A call of a value whose
  type is a pattern factory type is a pattern instantiation and is
  recorded. A handler applied to its state in statement position yields a
  stream nothing uses, and is refused.

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
| Element access `a[k]`, `a?.[k]` | Static when `k` is a literal, a module-scope constant of literal type, or a well-known key (`UI`, `NAME`, `SELF`, and the others the API exports). Dynamic otherwise | Path projection when static; chosen child when dynamic |
| Unary, binary, comparison | `+ - * / % **`, `< <= > >= === !== == !=`, `!`, unary `-` and `+`, `typeof`, bitwise operators, `in` | Primitive operation |
| Conditional | `c ? a : b`, `a && b`, `a \|\| b`, `a ?? b` | Selection |
| Object literal | Properties, shorthand, computed keys that are static in the sense above, spread. A computed key that is not static is refused (`reactive:unsupported-expression`): the paths of the constructed value would not be known when the pattern is compiled | Construction |
| Array literal | Elements, spread | Construction |
| Template literal | Substitutions are tier-R expressions | Primitive operation |
| Type-only wrappers | `e as T`, `e satisfies T`, `e!`, parentheses ([§7.7](#77-casts)) | None |
| JSX | [§4.5](#45-jsx) | Construction |
| Call | [§4.4](#44-calls) | By callee |

Refused in tier R: an arrow function or a function expression anywhere other
than the callback positions §4.4 names; assignment and compound assignment;
`++` and `--`; `delete`; `await`; `yield`; `new` other than the cell
constructors; `this`; `class`; a tagged template whose tag is not
`debugStr` ([§4.4.4](#444-pure-api-functions)); `void`;
the comma operator; a getter, a setter, a method, or a function-valued
property in an object literal; and `instanceof`.

### 4.4 Calls

A call in tier R is classified by its callee, in this order. A call that
matches none of the rows is refused (`reactive:unsupported-call`). Three
kinds of call are refused under their own identifiers instead, because
wrapping one in `computed` does not make it legal: a read of the ambient
clock or entropy (`function-body:ambient-read`, §5.1); a call of a removed
form (the `removed-form:` entries, §4.4.3); and a staged change
(`grantSpaceAccess`, `revokeSpaceAccess`, `nameBlob`), which only a
`handler`, an `action`, or an inline event handler requests
(`function-body:effect-in-computation`, §5.2; `builtin-inventory.md`,
"Staged changes").

A row is decided by name where the callee resolves to a definition: an
import from `commonfabric`, a definition of the program, or a member of a
standard-library namespace. It is decided by the callee's type otherwise.
So `box.format(order)` is a pattern instantiation when the property
`format` has a pattern factory type, a handler binding when it has a
handler factory type ([§4.4.2](#442-patterns-and-handlers-as-callees)),
and a method call under the third row or no row when it has neither.

| Callee | Arguments | Meaning |
| --- | --- | --- |
| `xs.map(f)`, `xs.filter(f)`, `xs.flatMap(f)`, `xs.some(f)`, `xs.every(f)`, `xs.find(f)`, `xs.findIndex(f)`, `xs.reduce(f, initial)` where `xs` has an array type | A callback written at the call ([§4.4.1](#441-collection-callbacks)) | Reactive collection operation |
| An aggregate (`count`, `sum`, `min`, `max`, `minBy`, `maxBy`) or a collection index (`groupBy`, `keyBy`, and `lookup`, `keys`, `keyEntries` on an index) | A selector or predicate callback where the method takes one, with the grammar of a `map` callback | Structural operation |
| A standard-library function or method marked "R" in [§9](#9-standard-library-surface) | Tier-R expressions; no function arguments | Primitive operation |
| A pure API function that [§4.4.4](#444-pure-api-functions) lists for tier R, such as `valueEqual`, `getEntityId`, or `uiVariant` | Tier-R expressions; no function arguments, except the row-label rule of `table` | Primitive operation |
| An authored function, or a `lift` result | Tier-R expressions; no function arguments. The argument of a `lift` result is bound by reference ([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)); the arguments of an authored function are checked by §7.5 alone | Sandboxed call |
| `computed(f)`, `action(f)`, `assert(f)` | `f` is a function written at the call; its body is tier F, unless the `computed` is promoted ([§6](#6-promotion-of-computed)) | Sandboxed call, or the promoted expression. `assert` is the marker pattern tests use, and yields the test record the API declares |
| A handler: a `handler(...)` definition called by name, or a value of a handler factory type | One object argument: the state binding ([§4.4.2](#442-patterns-and-handlers-as-callees)) | Stream |
| A pattern | One object argument ([§4.4.2](#442-patterns-and-handlers-as-callees)) | Sub-pattern |
| A cell constructor, a `sqliteDatabase` declaration, or a method of a cell handle | [§4.7](#47-cell-and-handle-methods) | State cell, database declaration, path projection, chosen child, or read |
| A context read, where the built-in inventory makes it legal in the pattern body | As `builtin-inventory.md` specifies | Context read |
| A structural or effectful built-in (`wish`, `anchorsOf`, `inspectConfLabel`, the fetch family, the language-model built-ins, `navigateTo`, and the others) | As `builtin-inventory.md` specifies | As classified there |

Three rules hold across the rows.

- **`.get()` requires a cell type.** `.get()` on a value whose type is not
  `Cell`, `Writable`, or `ReadonlyCell` is refused
  (`opaque-get:invalid-call`): the value is read directly. Because a tier-R
  expression is an operation of the plan wherever it is written, a `.get()`
  on a cell is allowed at every tier-R expression site, including the body of
  a reactive collection callback. The transformer's distinction between sites
  that can and cannot carry the read goes away. A `.get()` in statement
  position is still refused, as any expression statement that is not a
  recorded call is.

  The refusal is about data. A value whose type declares a `get` method
  of its own is a value of a code type
  ([§7.9](#79-type-features-the-checker-refuses)): a `Map`, or a local
  object typed `{ get(): Donut[] }`. A call of that
  method is an ordinary method call of tier F and is not reported. Such a
  type does not describe a cell: a cell handle is not assignable to it
  ([§7.5](#75-assignability)), and a data type cannot declare the method.
- **Dynamic keys are allowed.** `scopes[key]` is a chosen child (`pick` in
  `plan-and-label-templates.md`, §3.18) at every tier-R site. It observes
  the key and the one child it selects, not the container's other children. The
  transformer's refusal of a bare dynamic key in the pattern body goes away for
  the same reason.
- **Function arguments are refused** except in the first two rows, the
  builders, and the row-label rule of `table` (§4.4.4).
  `xs.toSorted(compare)`, `xs.forEach(...)`, and
  `text.replace(pattern, fn)` are tier-F code: the author wraps the
  expression in `computed(() => ...)`.

#### 4.4.1 Collection callbacks

The callback of `map`, `filter`, `flatMap`, `some`, `every`, `find`, and
`findIndex` is an arrow function written at the call. The four predicates
follow exactly the rules of a `filter` callback. It takes the element and,
optionally, the index. Its body follows §4.2: an expression, or `const`
declarations and one final `return`. The body is compiled once against an
element slot.

Either parameter may be a destructuring pattern, an object pattern or an
array pattern, under the rules §4.2 gives a `const` destructuring:
`Object.entries(prices).map(([flavor, price]) => ...)`. Three forms are
refused (`collection:callback-parameters`).

- **A callback that is not an arrow function written at the call,** a
  function passed by name included: `xs.filter(Boolean)` and
  `xs.map(toRow)`. The author writes the arrow,
  `xs.filter((x) => Boolean(x))` and `xs.map((x) => toRow(x))`. A function
  passed by name receives the index and the whole array as its second and
  third arguments, so whether the index is part of an element's key
  (below) would depend on a declaration written elsewhere.
- **A third parameter,** which is the whole array.
- **A default value or a rest element,** on a parameter or inside its
  destructuring pattern. An element is not a constant expression (§4.2).

The callback of `reduce` is stricter. It is an arrow function with an
expression body, `(accumulator, element) => expression`, optionally with the
index as a third parameter, and the call has an initial value. A block body
is refused (`collection:reduce-callback`), and so is a call without an
initial value (`collection:reduce-initial`), which throws on an empty array.
The type of the accumulator, which is the type of the initial value and of
the expression, is a data type (`collection:reduce-accumulator`): the
fold's state is stored.
The expression is a pure tier-R expression in the sense of
[§6.1](#61-criterion), condition 4. The restriction to an expression is
deliberate. A fold step has to be a function of the accumulator and one
element and nothing else, and the block-bodied `reduce` callbacks in the
corpus are the ones that mutate the accumulator
(`acc.push(x); return acc;`), which a fold step compiled into the plan must
not do. An author whose step needs statements writes the fold as a loop
inside `computed`.

`find` yields the first matching element itself, as a reference with the
element's own label, or `undefined`. `some` and `every` yield a boolean, and
`findIndex` a position. `reduce`, `find`, and `findIndex` are ordered: their
results depend on the order of the elements, as `map`'s per-element results
do not. The label rules are defined in `plan-and-label-templates.md`
(§3.13) and `builtin-inventory.md`.

**Element keys.** Each element of a `map` has a key. The key is the
element's value when the element is a plain value, and the identity of the
element's cell when it is not. The body of the callback is one or more
cones, and each is evaluated once per element key. A cone as it is
evaluated for one key is a cone instance (`execution-and-storage.md`,
Terms and §2.1). An element that moves keeps its cone instances, so
reordering, inserting into, or removing from a list does not recompute the
elements that stayed. Stored per-element state from earlier versions of a
pattern is not preserved by this rule; it is chosen for recomputation
cost. A key derived from a value is salted with a secret of the space
before it enters a document identifier, so that an identifier does not
reveal the value (`plan-and-label-templates.md`, §1.3).

**The index parameter costs the author that property.** The index is part
of an element's key when the callback declares the index parameter and its
body uses it. It is also part of the key where a body over plain values
instantiates a child ("A child per position", below). In no other case
is it. The cone instances of such a key cannot move:
inserting at the front of a list of a thousand elements evaluates the body
again for a thousand keys, where a callback without the index evaluates it
for one. The compiler reports the use as a hint (`collection:index-keyed`).
A callback that declares the index and does not use it is keyed without
it.

**Names inside a callback.** The identifier of a state cell declared inside
a collection callback derives from the instance, from each compiled-in call
and each collection callback that encloses the declaration, outermost
first, and from the cell's name. An enclosing callback contributes the name
of its collection and the key of the element. So per-element state follows
the element when the element moves, and does not when the key includes the
index. The cell's name and the collection's name are given by the naming
rule of [§4.6](#46-captures), and the same derivation names a child
instance, a durable operation, and the stream of a handler binding declared
inside a callback (`plan-and-label-templates.md`, §1.3).

**Equal plain values may not share a state cell.** Two elements with the
same plain value have the same key, so they share their cone instances.
That is sound for a value, which is a function of the element. It is wrong
for a state cell: two rows that show `"glazed"` would share one "expanded"
flag. So the body of a per-element construct (`map`, `filter`, `flatMap`,
the predicates, and the selector callbacks of the aggregates and indexes)
over a collection of plain values is refused when it declares a state cell
without using the index parameter (`collection:shared-element-state`).

**A handler binding over plain values needs no index.** A body that binds
a handler, in any of the spellings of §5.2, and declares no state cell is
accepted. Every path of the handler's state is the element, a value
computed from the element, or a value captured from outside the callback.
Two elements with equal values therefore bind the handler to equal state,
and they share one stream, which handles an event from either row as two
streams would. A binding made in a function body is one stream on the same
argument ([§5.2](#52-runtime-calls)).

For these rules the checker decides "plain value" statically, from the
element type and from where the collection comes from.

- **Always plain:** an element type that is a primitive, a literal, `null`,
  `undefined`, a factory type, or a union of those. A factory value is a
  reference to a compiled definition (§7.2) and has no cell of its own, so
  two equal factories in a list have one key.
- **Never plain:** an element type that is a cell handle type or a pattern
  instance. Such an element is identified by its cell.
- **An object, array, or tuple element type** is plain when the program
  builds the records: the collection is an array literal, a module-scope
  constant, declared in the module or imported from another module of the
  program, the result of a tier-R construction such as another `map`
  that builds object literals, or the result of a standard-library member
  marked "R" that builds its elements, such as `Object.entries`. It is not
  plain when the collection is read
  from the pattern's input or from a cell. A record written into a stored
  array by `set`, `push`, or `addUnique` is stored as a document of its own
  and the array holds a link to it (`builtin-inventory.md`, "Element
  keys"), so such elements are identified by their cells.
- **The result of a function body** (a `computed` that is not promoted, a
  `lift`, or an authored function) with such an element type is plain
  where the body built the records, and not plain where it passes on
  records it read. A record a body passes on unchanged is kept as a link
  to where it was read (`footprint-analysis.md`, §3.8), so the elements of
  `computed(() => { ...; return donuts.filter(isFresh); })` are links to
  the original records and are identified by their cells. The checker
  reads this from the body's record: the result is not plain at its
  element path where `Body.outputs` has a `reference` there, which says
  that every element is a reference the body was given, and plain where it
  has none (`plan-and-label-templates.md`, §1.1).
- **A collection that tier R derives without building elements** has the
  plainness of its source. The elements of a tier-R `filter` are the
  source's elements, with their keys (`plan-and-label-templates.md`,
  §1.3), and `find` yields one of them. A promoted `computed` is its body
  as a tier-R expression, so its result is classified as that expression
  is.
- **A union** of a plain and a non-plain type is plain.

A refused body has two rewrites. Take the index and use it, which puts
the position in the key at the cost described above. Or make the elements
cells, by keeping the list in a cell that a handler writes records into,
or by mapping over a list of records that carry what distinguishes them.

```tsx
// Shown for illustration only.
// Refused: two "glazed" rows would share `open`.
const rows = glazes.map((glaze) => {
  const open = new Writable(false);
  return <li onClick={() => open.set(!open.get())}>{glaze}</li>;
});

// Accepted: the index is in the key.
const rows = glazes.map((glaze, index) => {
  const open = new Writable(false);
  return (
    <li onClick={() => open.set(!open.get())}>{index + 1}. {glaze}</li>
  );
});

// Accepted: a handler binding and no state cell. Two "glazed" rows share
// one stream, and an event from either chooses "glazed".
const buttons = glazes.map((glaze) => (
  <button onClick={chooseGlaze({ order, glaze })}>{glaze}</button>
));
```

One case is outside what the checker can decide: an input declared with an
object element type whose stored array holds inline records, because a
computation elsewhere produced it. The checker treats it as not plain.
*Assumed:* a body over such a list that declares a state cell without the
index compiles, and the cone instances of an element that arrives inline
fail at run time (`plan-and-label-templates.md`, §1.3;
[§13](#13-open-questions), question 2).

**A child per position.** Where the body of a per-element construct over
plain values instantiates a child, the position joins the element key, as
it does when the callback uses the index. So two equal plain elements have
a child each, with state of its own, and
`factories.map((Card) => Card({ donut }))` over a list of factory values
has a child per position, whether or not two of the factories are equal.
The plan records it as `Collection.bodyUses.child`, beside
`Collection.bodyUses.index` (`plan-and-label-templates.md`, §1.1 and
§1.3, which owns the key). The author pays what the index costs: the cone
instances of such a body do not move with their elements, and an insertion
at the front evaluates the body again for every position after it. Where
per-element constructs nest, the position joins the key at every
enclosing level whose elements are plain values, so that equal elements
of the outer collection do not share the inner body's child. *Assumed*
there with the second way below (its §8, question 37).

A body instantiates a child, for this rule, in two ways. The first is the
ruled one: it calls a pattern factory value in tier R
([§4.4.2](#442-patterns-and-handlers-as-callees)). The second is
*assumed,* with `plan-and-label-templates.md` (§8, question 37): a `lift`
or a `computed` written in the body instantiates a pattern
([§5.2](#52-runtime-calls)), whose instances are named through the
element as well. Two things are not children. An instance that only a
`handler`, an `action`, or an inline event handler makes is identified by
the handling or by an explicit cause, and by no element key. And a
statically resolved pattern called in the body is compiled into the
surrounding instance: it has no result cell of its own, and a state cell
it declares is a state cell of the body for the rule above.

The position is then part of the key of that body, so a state cell
declared beside the child has a key per position and is not shared.
*Assumed,* with `plan-and-label-templates.md` (§8, question 34), the
built-in inventory, and the footprint analysis: such a body is accepted,
and `collection:shared-element-state` does not report its state cell.
Deleting the child from such a body then makes the cell an error
([§13](#13-open-questions), question 21).

#### 4.4.2 Patterns and handlers as callees

A pattern is called with one object argument, optionally through the
modifiers `asScope(scope)` and `inSpace(space, options)`. There are two
kinds of callee, and they differ in what the compiler can do.

- **A statically resolved pattern.** The callee is a `pattern(...)`
  definition imported by name or declared at module scope, or an inline
  `pattern(...)` expression. The compiler has its body. The call denotes an
  anonymous sub-pattern compiled into the surrounding instance, like the
  body of a `map`. A call that is on a cycle of such calls, as where a
  pattern calls itself in its own body, cannot be compiled in.
  *Assumed* ([§13](#13-open-questions), question 37): the compiler
  refuses it.
- **A pattern factory value.** The callee is an expression whose type is a
  pattern factory type, such as a property of the pattern's input or the
  result of a conditional between patterns. The compiler does not have its
  body, which is only known at run time. The call denotes a child with a
  plan and a result cell of its own, resolved at run time. The type checker
  knows the factory type's declared input type and result type, checks the
  argument against the first, and gives the call the second. What the plan
  records for such a child, and the label rule of its result, are defined in
  `plan-and-label-templates.md` (§3.15).

**Handlers** have the same two kinds of callee. A `handler(...)` definition
called by the name it is declared or imported under is statically resolved:
the compiler has its body, its footprint, and its write edges. A value of
type `HandlerFactory<E, S>`, received through an input, a cell, or an event,
is bound the same way, `received({ ...state })`. The type checker checks the
argument against `S` and gives the call the type `Stream<E>`. The handler it
names is resolved at run time, and its own compiled record supplies its
footprint, its write edges, and the identity that write policies name. A
received handler cannot be named in a label argument: `typeof name` in
`WriteAuthorizedBy` needs a declaration ([§8.5](#85-label-arguments)).

A factory value is obtained in two ways. The first is by referring to a
module-scope `pattern(...)` or `handler(...)` definition without calling it:
`{ onSave: saveDonut }` puts a handler factory in a data position. A bound
handler is not a factory. It is a stream, and has the type `Stream<E>`.

The second is a **pattern closure**: an inline `pattern(...)` expression in
tier R that is used as a value instead of being called.

```tsx
// Shown for illustration only.
const DonutSearch = pattern<{ donuts: Donut[] }>(({ donuts }) => {
  const search = pattern<{ flavor: string }>(({ flavor }) =>
    donuts.filter((donut) => donut.flavor === flavor)
  );
  return { search };
});
```

- **Captures.** The callback may refer to `const` bindings and parameters of
  the enclosing tier-R bodies, under the capture rules of
  [§4.6](#46-captures): a captured value is a data value or a cell, and a
  captured function value is refused. The compiler turns each capture into a
  private parameter of the closure and binds it where the closure is
  written. Authored code has no spelling for that binding.
- **Type.** The expression has the type `PatternFactory<I, O>`, where `I` is
  the callback's declared input type. The captures are not part of `I`: a
  caller supplies `{ flavor }` and can neither see nor supply `donuts`. This
  is what lets a closure be given to a language-model built-in as a tool
  without exposing what it closes over.
- **Use.** A pattern closure is a pattern factory value like any other. It
  may be returned in the pattern's result, passed to a child pattern, given
  as a tool, or called. Called in the body that wrote it, it is a statically
  resolved callee and is compiled in. Called by a receiver, it is a child
  with a plan of its own (`plan-and-label-templates.md`, §3.15).
- **A conditional between two closures** is a pattern factory value:
  `spicy ? hotSearch : mildSearch`, written with the closures in place or
  with names bound to them. The two branches have to have one factory
  type, up to annotations. The compiler does not have the body of the
  selected one, so a call of the value is a child resolved at run time,
  and where the value is given to a language-model built-in as a tool,
  the rule for a tool applies to whichever closure was selected
  (`plan-and-label-templates.md`, §3.15).
- **Tier F.** A function body does not write a pattern closure as a value.
  An inline `pattern(...)` there is legal only as the callee of an
  instantiation, in every kind of function body, a `lift` and a `computed`
  included (§5.1, §5.2). Its callback is a tier-R body. It may refer to
  the `const` bindings and the parameters of the enclosing function body,
  the values that body captures from tier R included
  ([§4.6](#46-captures)). A captured value is a data value or a cell
  handle. A captured `let`
  is refused (`function-body:handler-capture`), for the reason §5.2 gives
  for an inline event handler: the instantiation is made from what the
  variable holds when the call runs. A captured function value, or a value
  of another code type such as a `Map`, is refused
  (`ses-callback:callable-capture`). The compiler turns each capture into
  a private parameter of the inline pattern, as for a closure of tier R.
  *Assumed:* each capture is bound as a path of a handler's state is bound
  in a function body ([§5.2](#52-runtime-calls), "What a binding holds";
  `plan-and-label-templates.md`, §3.15; the continuation plan's question
  48).

There is no handler closure of this kind and none is needed: `action` and an
inline event handler already bind a handler to its captures and yield the
stream.

A `lift` result is not a factory type and cannot be received as data: an
imported function is called as a function. Only patterns and handlers are
factory values.

#### 4.4.3 Removed call forms

`ifElse`, `when`, `unless`, and the `str` tag are not part of the language,
so that no new pattern is written with them. `patternTool` is removed too,
in favor of pattern closures (§4.4.2).

For an interim period the compiler accepts the first four with a warning
(`removed-form:helper`) that states the replacement, by rewriting each to
the construct it is a spelling of before any other stage sees it:

| Removed form | Rewritten to |
| --- | --- |
| `ifElse(c, a, b)` | `c ? a : b` |
| `when(c, v)` | `c && v` |
| `unless(c, f)` | `c \|\| f` |
| `` str`...${x}...` `` | `` `...${x}...` `` |

The acceptance is limited to what costs the compiler nothing more than that
rewrite. Only the direct call of the imported name with exactly those
arguments, written in tier R, is accepted. The forms that take schemas
first, a helper passed as a value, and a helper reached through an alias
are errors at once (`removed-form:helper-unsupported`). So is one of the
four in a function body or at module scope, under the same identifier:
the rewrite gives the helper's meaning only in tier R, where the operator
is a reactive operation. In a function body the author writes the
operator, which is ordinary JavaScript there. The interim ends when the
builder form the transformer emits is retired, the overview's last stage:
from then on `removed-form:helper` is an error. It ends earlier for the
pattern corpus
in this repository, which is rewritten before that stage so that no pattern
an author might imitate uses a removed form.

`patternTool(...)` has no interim acceptance (`removed-form:pattern-tool`).
Its rewrite moves the bound parameters out of the pattern's input and into
captures:

```tsx
// Shown for illustration only.
// Before
const tool = patternTool(
  pattern<{ flavor: string; donuts: Donut[] }>(({ flavor, donuts }) =>
    donuts.filter((donut) => donut.flavor === flavor)
  ),
  { donuts },
);

// After
const tool = pattern<{ flavor: string }>(({ flavor }) =>
  donuts.filter((donut) => donut.flavor === flavor)
);
```

A `patternTool` call whose pattern is declared at module scope is rewritten
the same way, by writing the pattern inline where the bound values are in
scope, or by an inline closure that calls the module-scope pattern with
them.

The other forms that `builtin-inventory.md` classifies as removed are
refused in every tier, also with no interim acceptance
(`removed-form:builtin`). Each has a replacement, which the message names.

| Removed form | Write instead |
| --- | --- |
| `llm(...)` | `generateText(...)`, or `generateObject(...)` for a structured result |
| `streamData(...)` | A built-in of the fetch family, such as `fetchJson(...)`, for a request and its response. A stream of partial results has no form in the language |
| `cell(value)` | `Cell.of(value)` or `new Cell(value)` (§4.7) |
| `byRef(name)` | The built-in imported by name from `commonfabric` |
| `nameInstance(value, name)` | `const name = Child({ ... })`. The compiler records the name of the binding |
| `xs.mapWithPattern(...)` and the other seven `...WithPattern` methods | The method without the suffix, with a callback written at the call that calls the pattern: `xs.map((donut) => DonutRow({ donut }))` |

#### 4.4.4 Pure API functions

`builtin-inventory.md` keeps a set of `commonfabric` exports that create
nothing, read no frame, and request nothing ("Pure functions and
constants", and `uiVariant` under "Tool and factory helpers"). A call of
one is a call of a pure function of its arguments, like a call of a
standard-library function: a primitive operation in tier R, an ordinary
call in tier F, and part of a frozen-data initializer at module scope
(§3.2). The table lists them all and says where a call of each is legal.
"M" is module scope.

| Function | Tiers | What it is |
| --- | --- | --- |
| `valueEqual(a, b)` | M, R, F | Deep structural equality of two values. It follows no link and resolves no cell |
| `getEntityId(value)` | R, F | The entity reference of a cell handle, or of a value that holds a link, or `undefined` |
| `entityRefToString(ref)` | M, R, F | The string form of an entity reference |
| `renderCellReference(link, context?)` | M, R, F | The cell address of a plain record that names a cell, written relative to a context |
| `isWellFormedDID(value)`, `parseDID(value)` | M, R, F | The test of a DID, which is a type predicate (§7.1), and its parts |
| `toCompactDebugString(value, options?)`, `toIndentedDebugString(value, options?)` | M, R, F | A value rendered as text for a diagnostic message |
| The `debugStr` tag | M, R, F | A template tag that composes a diagnostic message from its substitutions. It is the one tag a tagged template may have in tier R (§4.3), where it is a primitive operation over the substitutions, as a template literal is |
| `uiVariant(piece, kind?)` | R, F | The view node that renders a variant of a piece. It is legal wherever JSX is |
| `schema(...)`, `cfLink()`, `table(columns, rule?, options?)` and the other `cfSqlite` helpers, the `cfcAtom` and `cfcPattern` constructors, `v(name)`, the Fabric value classes | M, R, F | Plain functions that construct data from data. A Fabric value class is constructed with `new`, which tier R accepts for a cell constructor only (§4.3). *Assumed* ([§13](#13-open-questions), question 20): §4.3 governs, and a Fabric value is constructed in tier F or at module scope |
| `dataFile(path)` | M, R, F | The text of a file attached to the program. *Assumed,* with `builtin-inventory.md`: `path` is a string literal, so that the files a program reads are known when it is compiled |
| `exchangeRule(...)`, `exchangeRules([...])` | M | A rule declaration, which the CFC authoring contract requires to be exported and static (§3.2). Elsewhere the contract's diagnostic reports the call (`cfc-policy-authoring`) |
| `multiUserTest(descriptor)` | M, in a test file | The descriptor of a multi-user pattern test, returned unchanged |
| `AuthSchema`, `WebhookConfigSchema`, the constant tables of `base/api/cfc.ts` | M, R, F | Constants, not functions: frozen data that a program reads like a module-scope constant of its own |

Three rules complete the table.

- **Arguments.** In tier R the arguments are tier-R expressions and none is
  a function, as for a standard-library member marked "R". The one
  exception is the second argument of `table`, the row-label rule: an
  arrow function written at the call. `table` calls it once, with a
  reference to each declared column, when the declaration is evaluated,
  and keeps the rule it returns as data. A table declaration given to
  `sqliteDatabase` has to be static, which limits what the rule may refer
  to ([§4.7](#47-cell-and-handle-methods)).
- **Outside the listed tiers.** `exchangeRule` and `exchangeRules` called
  anywhere but in the initializer of an exported module-scope constant are
  reported by the contract's diagnostic (`cfc-policy-authoring`), as today
  (`findNonModuleCalls` in
  `base/ts-transformers/src/transformers/cfc-policy-authoring.ts`).
  `multiUserTest` is refused in tier R as a call that matches no row
  (`reactive:unsupported-call`) and in tier F with the builders
  (`function-body:builder-call`). Module scope is left out for
  `getEntityId` and `uiVariant` because their operand is a cell handle or
  a piece, which no module-scope constant holds. The compiler does not
  refuse such a call: its result is frozen data like any other.
- **What a call observes** of its operands is not defined here.
  `builtin-inventory.md` states it for each function, and
  `footprint-analysis.md` (§3.4) has the transfer rule: which functions
  read an operand's value in full and which observe its identity alone.

`toSchema<T>()` is a compile-time intrinsic with a type argument and no
operand (§3.2), and `equals(a, b)` is a context read (§5.2). Neither is in
the table.

### 4.5 JSX

JSX elements and fragments are tier-R expressions wherever a tier-R
expression is allowed, and their attribute values and children are tier-R
expressions.

- A lower-case tag is a host element. A tag that names a pattern is a pattern
  instantiation with the attributes as its argument. It is a call of the
  pattern, and the rules of [§4.4.2](#442-patterns-and-handlers-as-callees)
  apply to it: a tag that names a statically resolved pattern is compiled
  into the enclosing pattern as such a call is, and a tag that names a
  factory value instantiates a child (`plan-and-label-templates.md` §1.1).
  The children written between the tags are the property `children` of
  the argument, an array of the children.
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

**A handler binding made in tier R copies nothing.** The state of an
`action`, of an inline event handler, and of a handler applied to its state
in tier R is bound by reference, the body of a collection callback
included. Every path of the handler's state is an input of the instance, a
state cell, an element of a collection, or a value the instance computes,
and the handler reads it from there when an event arrives. In the example
below `donut` is bound by reference, so the push stores a link to the
element of `donuts` and does not store a second record.
[§5.2](#52-runtime-calls) has the rule for a binding made while a function
body runs, which does copy some values.

The argument of a pattern and the argument of a `lift` result written in
tier R are bound the same way, path by path. Because nothing is copied,
a value may be named where the callee declares a handle of it, and a
handle where the callee declares the value
([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)).

```tsx
// Shown for illustration only.
const rows = donuts.map((donut) => (
  <li>
    {donut.name}
    <button onClick={() => favorites.push(donut)}>favorite</button>
  </li>
));
```

**Names.** Each declaration of a tier-R body that has stored state, or a
stream, has a name, and the name is part of what the identifier of that
state derives from: a state cell, a child instance, a collection, a durable
operation such as an effect or an aggregate, a use of a function body, and
a handler binding. `plan-and-label-templates.md` (§1.3) owns the rule. Four
parts of it are visible in source.

- A declaration assigned to a `const` takes the name of the variable.
- A cell declared with an explicit cause, `X.for("count")` or
  `.for("count")` on its handle, takes the string literal in place of the
  variable's name ([§4.7](#47-cell-and-handle-methods)). *Assumed*
  ([§13](#13-open-questions), question 17).
- A declaration assigned to nothing takes a base name from what it is: the
  callee's name for a call of a pattern or of a function body (an authored
  function, a `lift` result, `computed`); the built-in's or the method's
  name for an operation or a collection; the handler's name for a named
  handler applied to its state; and the attribute's name for an inline
  event handler.
- Where two declarations of one pattern body have the same name by these
  rules, each takes the name and its ordinal among them, in source
  order.

So renaming a `const` renames the state declared under it, unless the
declaration has an explicit cause. Adding or removing a declaration with
another name renames nothing. Adding an unassigned declaration ahead of
one with the same base name moves the ordinals after it, which is the one
case where an edit elsewhere in a body renames stored state, and assigning
the declaration to a `const` avoids it.

`x[SELF]` is valid on the pattern's own input parameter in tier R and nowhere
else (`pattern-context:self-access`), as today.

### 4.7 Cell and handle methods

The methods below are the whole method surface of the handle types. They are
the members the interfaces in `base/api/index.ts` declare (`IReadable`,
`IWritable`, `IStreamable`, `IKeyable`, `IEquatable`, `IResolvable`,
`ICreatable`, `IDerivable`, `ISqliteExecutable`, `ISqliteQueryable`,
`CollectionIndexHandle`, `CellTypeConstructor`). The runtime's cell object in
`runtime/runner/src/cell.ts` has further methods the API does not declare,
such as `asSchema`, `withTx`, `sink`, `sync`, `pull`, `getRaw`, `setRaw`,
`getAsLink`, and `getAsNormalizedFullLink`. They are not part of the
language (`cell:unsupported-method`).

"Tiers" says where a call of the method is legal. "Effect" says what it does
to the handle's cell: reads its value, writes it, or neither.

| Method | Declared on | Tiers | Effect |
| --- | --- | --- | --- |
| `get()` | `Cell`, `ReadonlyCell` | R, F | Reads the value |
| `sample()` | `Cell`, `ReadonlyCell` | F | Reads the value without making the body depend on the cell for recomputation. The read is still part of the footprint, for the label |
| `key(k)` | `Cell`, `ReadonlyCell`, `WriteonlyCell`, `ComparableCell`, `OpaqueCell` | R, F | Neither. Yields a handle of the same kind for the property. Where the property is declared as a handle, it yields that handle: `key` flattens (note below) |
| `elementById(idKey)` | `Cell`, `ReadonlyCell`, `WriteonlyCell`, `ComparableCell` | R, F | Neither. On a handle of `U[]`, yields a handle of the same kind of `U \| undefined` for the keyed element (note below) |
| `resolveAsCell()` | `Cell` | R, F | Neither. Follows the links from the handle until it reaches a cell whose value is not a link, and yields the handle of that cell. It observes the reference where the resolution ends, the links followed included, and reads no content |
| `getArgumentCell()` | `Cell` | F | Neither. Yields the handle of the argument of the piece the cell belongs to |
| `equals(other)`, `equalLinks(other)` | `Cell`, `ReadonlyCell`, `ComparableCell` | R, F | Neither. Compares identity |
| `for(cause)` | Every handle type, `Stream` included; and the value a pattern instantiation returns | On a handle: R with a string literal, F with any cause. On an instantiation, F | Neither. On a handle, sets the causal identity of a cell that has none yet; in tier R the literal takes the place of the declaration's name (note below). On an instantiation, `Box({ flavor }).for(cause)`, supplies an explicit cause for the instance's identifier |
| `set(value)`, `update(partial)` | `Cell`, `WriteonlyCell` | F | Writes |
| `push(...values)`, `pushAll(values)`, `addUnique(...values)`, `remove(...)`, `removeByValue(ref)`, `removeAll(...)` | `Cell`, `WriteonlyCell`, of an array | F | Writes. `push`, `pushAll`, `addUnique`, and `removeByValue` are mergeable |
| `increment(by?)` | `Cell`, `WriteonlyCell`, of a number | F | Writes, mergeable |
| `applyChanges(changes)` | `Cell`, `WriteonlyCell`, of a string | F | Writes |
| `send(event)` | `Cell`, `Stream` | F | Writes: delivers an event |
| `map`, `filter`, `flatMap`, `some`, `every`, `find`, `findIndex`, `reduce`, `count`, `sum`, `min`, `max`, `minBy`, `maxBy`, `groupBy`, `keyBy` | `Cell`, `OpaqueCell`, of an array | R | Reads, by the operation's label rule (§4.4). In tier F the method on a handle is refused (`cell:collection-method-in-function`), with the two corrections of the note below |
| `lookup(key)`, `keys()`, `keyEntries()` | A collection index handle | R, F | Reads the index |
| `query(sql, params?)` | A SQLite handle | R; F in a `handler`, an `action`, or an inline event handler | Reads. Sugar for the `sqliteQuery` built-in, which is effectful (`builtin-inventory.md`), so the call is an effect request and has the tiers of one (§5.2) |
| `exec(sql, params?)` | A SQLite handle | F | Writes to the database, in the caller's transaction |
| `new X(value)`, `X.of(value)`, `X.for(cause)`, and the same three under `X.perSpace`, `X.perUser`, `X.perSession`, for `X` among `Cell`, `Writable`, `OpaqueCell`, `Stream`, `ComparableCell`, `ReadonlyCell`, `WriteonlyCell` | The constructor | R, F. In tier R the argument of `X.for` is a string literal | Creates a cell. In tier R it is a state cell of the plan. In tier F it is the cell-creation call of §5.2 |
| `sqliteDatabase(options?)` | The function | R | Declares a SQLite database and yields its handle, of type `SqliteDb` (note below) |
| `X.equals(a, b)`, `X.equalLinks(a, b)` | The constructor | R, F | Neither. Compares identity |
| `asScope(scope)`, `inSpace(space, options)` | A pattern factory | Where the instantiation they modify is legal | Neither |

Twelve notes on the table.

- **`for` on an instantiation.** The form is legal in every kind of
  function body. Its argument is the explicit cause of the instance, which
  `plan-and-label-templates.md` calls the tag. In a `lift` or a `computed`
  it takes the place of the ordinal in the instance's identifier, and the
  site stays ([§5.2](#52-runtime-calls); `plan-and-label-templates.md`
  §1.3 and §3.14). In a `handler`, an `action`, or an inline event handler
  it names the same instance on every event, where an instantiation
  without it makes a new instance for each event (§5.2, "An explicit
  cause in a handler"). `plan-and-label-templates.md` (§1.3) owns the
  identifiers of what a function body creates.
- **An explicit cause in tier R is a string literal.** `X.for(cause)` and
  `h.for(cause)` on a handle take a string literal in tier R and nothing
  else (`cell:cause-not-literal`). The literal takes the place of the
  declaration's name in the identifier of the state cell
  ([§4.6](#46-captures), "Names"; `plan-and-label-templates.md`, §1.3).
  So `Writable.for<number>("count")` is named `count` whatever variable
  it is assigned to, and renaming the variable does not rename the stored
  state. A cause that is data, such as `Writable.for(donut.id)`, is legal
  only in a function body, where the cause is a value the body read
  ([§5.2](#52-runtime-calls)). Tier R needs no such cause for a cell per
  element: a cell declared in the body of a collection callback has the
  element's key in its identifier (§4.4.1). *Assumed:* the project owner
  has not ruled on an explicit cause in tier R
  ([§13](#13-open-questions), question 17).
- **`get`, `key`, and `elementById` in tier R** are operations of the plan
  and add no rule of their own (`plan-and-label-templates.md`, §3.18).
  `h.key("glaze")` is a path projection, like `h.glaze`. `h.key(k)` and
  `h.elementById(k)` with a key that is not a constant are a chosen child,
  like `a[k]` (§4.4): they observe the key and the one child it selects.
  `h.get()` reads the value at the handle's path.
- **A handle may hold a handle, and `key` flattens.** `Cell<Cell<T>>` is a
  valid type, and so is any handle type inside any handle type
  ([§7.2](#72-api-types)). `get()` on the outer handle returns the inner
  handle. `key(k)` flattens every handle it passes through, and the
  checker types `h.key(k)` in three steps.

  1. While the value type of the receiver is itself a handle type, the
     call goes through to that inner handle.
  2. The key is looked up in the value type, with `null` and `undefined`
     removed from it. The key is checked as a property access is.
  3. Where the property is declared as a handle, the result is that
     handle, with the type it is declared with. Otherwise the result is a
     handle of the kind the call went through, for the property's type.

  So `key("a")` on a `Cell<{ a: Cell<T> }>` has the type `Cell<T>` and not
  `Cell<Cell<T>>`, and `box.key("add")` on a
  `Cell<{ add: Stream<Donut> }>` is the `Stream<Donut>`. A chain of `key`
  calls flattens at each step, and `key` with several keys is the chain
  of the calls with one. A `?` on a property declared as a handle does
  not change the result: it is a modifier of the property and not a
  member of its type ([§8.4](#84-composition)). The checker gives `key` this type itself, so
  a pattern states it with no overload and no cast
  ([§12.4](#124-replace-the-re-typing-overloads-with-declared-types)).

  The flattened `h.key("a")` denotes what `h.get().a` does: the cell that
  the link stored at `a` names. It follows that link, and observes it as
  a reference (`plan-and-label-templates.md`, §2.5; `footprint-analysis.md`,
  §7.1). A read through it reads the inner cell. A write through it lands
  in the inner cell and does not replace the link at `a`. To replace the
  link, the author writes the outer cell: `h.update({ a: other })`.

  Two points are *assumed* ([§13](#13-open-questions), question 22).
  The flattened handle has the kind the inner handle is declared with,
  whatever the kind of the outer handle. A property whose type is a union
  of a handle type and anything but `null` and `undefined` is not
  flattened: `key` yields a handle of that union, and `get()` on it
  returns the inner handle or the other member.

  For a property that is not declared as a handle, the result keeps the
  `undefined` a `?` adds to a read of it: `key("a")` on a
  `Cell<{ a?: string }>` is a `Cell<string | undefined>`, because
  `get()` through it can find nothing stored. The `?` changes nothing
  for a property declared as a handle, by step 3: `key("a")` on a
  `Cell<{ a?: Cell<T> }>` is the `Cell<T>`.
- **`elementById` yields a handle of the element type or `undefined`.**
  By ruling, `h.elementById(k)` on a handle of `U[]` has the type of a
  handle, of the kind of `h`, of `U | undefined`. The record for a key
  may never have been written, and it may have been cleared with
  `set(undefined)`, so a `get()` through the handle has to handle
  `undefined`, and a write of `undefined` through a handle that can
  write is accepted:

  ```ts
  // Shown for illustration only.
  function clearPin(pins: Writable<Pin[]>, key: string): void {
    const pin: Writable<Pin | undefined> = pins.elementById(key);
    pin.set(undefined);
  }
  ```

  The result is not assignable to a declared `Writable<Pin>`, because
  `Cell<T | undefined>` is not assignable to `Cell<T>`
  ([§7.5.1](#751-handles)). `elementById` does not flatten: on a
  `Cell<Cell<T>[]>` it yields a `Cell<Cell<T> | undefined>`. The
  declaration in `base/api/index.ts` today gives the result the element
  type without `undefined` (`elementById` of `IKeyable`), and it is
  published with this type when the declaration of `key` is
  ([§8.6.1](#861-the-published-typings)).
- **`resolveAsCell`** observes a reference and not a value. In tier R, and
  in a function body where the call is static in the sense of
  `footprint-analysis.md` §7.1, the plan records it as an `identity`
  observation of the resolved reference, whose label joins the pointer
  labels of the links followed (`plan-and-label-templates.md`, §2.5). The
  handle it yields is the resolved one, so a write through it lands in the
  cell where the resolution ends.
- **A collection method on a handle in tier F** is a compile error
  (`cell:collection-method-in-function`). The compiler does not rewrite the
  call to a reactive form. The diagnostic names two corrections, and the
  author chooses. Wrapping the expression in an inline `pattern(...)` and
  instantiating it keeps it reactive: the body gets a link to an instance
  whose result follows the cell. Reading first, `cell.get().map(...)`,
  processes the values the cell holds when the body runs, with the
  JavaScript `map`. Both are legal in every kind of function body
  ([§5.2](#52-runtime-calls)).

  The second correction keeps the method's name for the eight methods a
  JavaScript array has too: `map`, `filter`, `flatMap`, `some`, `every`,
  `find`, `findIndex`, and `reduce`. An aggregate (`count`, `sum`, `min`,
  `max`, `minBy`, `maxBy`) and an index method (`groupBy`, `keyBy`) have
  no counterpart on an array ([§9.2](#92-array)), so
  `cell.get().sum()` is no correction. For those the second correction is
  `get()` followed by a loop or a JavaScript `reduce`:
  `cell.get().reduce((sum, price) => sum + price, 0)` for `cell.sum()`.

  ```tsx
  // Shown for illustration only.
  // Refused in a function body: `donuts` is a cell handle.
  const names = donuts.map((donut) => donut.name);

  // Correction 1: an inline pattern, instantiated. `names` is a link to
  // an instance whose result is the mapped list, and it stays current.
  const names = pattern(() => donuts.map((donut) => donut.name))({});

  // Correction 2: read first. `names` is a plain array of the names the
  // cell holds when the body runs.
  const names = donuts.get().map((donut) => donut.name);
  ```
- **Writes are tier F.** A write in a `handler`, an `action`, or an inline
  event handler is the body's purpose. A write in a `lift` or a `computed`
  is a side-write in the overview's sense, and the idempotency contract
  applies to it.
- **`Stream` is write-only.** It has `send` and `for`, and no `get`.
- **`ComparableCell` and `OpaqueCell` cannot be read.** A handle whose type
  is one of them supports projection and, for `ComparableCell`, comparison.
- **Removed.** The `...WithPattern` methods the transformer emits
  (`mapWithPattern` and its siblings; `removed-form:builtin`, §4.4.3) are
  not part of the language. Neither is `setSchema`, which
  `base/api/index.ts` declares on `IOpaquable` and marks as deprecated. A
  call of it is refused in every tier with the undeclared methods
  (`cell:unsupported-method`), and the replacement is the same: a declared
  type in place of a re-typing
  ([§12.4](#124-replace-the-re-typing-overloads-with-declared-types)).
- **`sqliteDatabase`** declares a SQLite database and yields the handle
  that `query` and `exec` are called on. It is a declaration of tier R,
  like a cell constructor there: it takes its name from the `const` it is
  assigned to (§4.6) and its scope from a scope wrapper on the declared
  type of that `const`, `PerUser<SqliteDb>` for example
  ([§8.8](#88-defaults-and-scopes)). It creates no database file and
  requests nothing. The plan records it as an operation with no request
  (`plan-and-label-templates.md`, §1.1 and §3.14; `builtin-inventory.md`,
  "`sqliteDatabase`"). Two points are *assumed,* with
  `builtin-inventory.md` ([§13](#13-open-questions), question 18).
  - The declaration is legal in tier R only. At module scope there is no
    instance to name the database, and the handle is a cell handle, which
    frozen data cannot hold (`module-scope:frozen-data-type`). In a
    function body it is refused (`cell:method-tier`): the body receives
    the handle from the pattern body that declares the database.
  - The `tables` option is static (`sqlite:tables-not-static`), so that
    the table declarations are constants of the plan. A constant
    expression, for this rule, is a literal, a module-scope constant, an
    object or array literal of constant expressions, or a `const` of the
    same body that is initialized by a constant expression. The option
    is an object literal with static keys, and each value is a
    `table(...)` call, written in place or bound to a `const` of the same
    body or of module scope. The arguments of a `table` call are constant
    expressions. The row-label rule (§4.4.4) is an arrow function with an
    expression body that refers to nothing but its parameter, constant
    expressions, and the `cfSqlite` helpers.
- **A call outside its tiers.** A method, a constructor form, or a
  declaration of the table called in a tier its "Tiers" column leaves out
  is refused. Three cases have identifiers of their own: a collection
  method on a handle in tier F (`cell:collection-method-in-function`);
  `query` in a `lift` or a `computed`, where it is an effect request
  (`function-body:effect-in-computation`); and a cause in tier R that is
  not a string literal (`cell:cause-not-literal`). Every other case is
  reported as `cell:method-tier`: in tier R, a write (`set`, `update`,
  the array writes, `increment`, `applyChanges`, `send`, `exec`),
  `sample()`, `getArgumentCell()`, and `.for(cause)` on an instantiation;
  in tier F, `sqliteDatabase(...)`.

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
value; `new` on the constructors of [§9](#9-standard-library-surface), on
the cell constructors, and on the Fabric value classes
([§4.4.4](#444-pure-api-functions)); `instanceof` against the constructors
of §9 and the cell constructors; tagged
templates (an ordinary call of the tag); the comma operator; `void`; spread
in calls; object and array destructuring assignment.

**Calls of API functions.** A call of a pure API function is an ordinary
call, legal where [§4.4.4](#444-pure-api-functions) lists tier F for the
function: every one it lists except `exchangeRule`, `exchangeRules`, and
`multiUserTest`, which are written at module scope. The runtime calls a
function body may make are those of [§5.2](#52-runtime-calls).

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
| `Proxy`, `Reflect`, `Symbol(...)`, `WeakMap`, `WeakSet`, `WeakRef`, and the other globals [§9.11](#911-other) names as not typed | `function-body:unsupported-global` | Not typed by the subset ([§9](#9-standard-library-surface)) |
| A global that §9 names nowhere, whether it is read, called, or constructed | `stdlib:unsupported-member` | The surface of §9 is closed |
| `new` whose callee is not a global: an authored function, a local value, a parameter, or an import other than a cell constructor or a Fabric value class | `function-body:constructor` | No authored function is a constructor, and the subset has no class. A function that builds a value returns it |
| A write to a module-scope constant, an import, or a global | `module-scope:frozen-data-write`, `function-body:global-write` | Statelessness ([§3.3](#33-the-statelessness-rule)) |
| `Date.now()`, `new Date()` with no argument, `Math.random()` in a `lift`, a `computed`, an `assert`, or an authored function one of them or tier R calls | `function-body:ambient-read` | A computation is a function of its inputs. The read is allowed in a `handler`, an `action`, and an inline event handler. Written in tier R, the same read is refused under the same identifier (§4.4) |
| `pattern`, `lift`, `handler`, `computed`, `assert`, `multiUserTest` called in tier F | `function-body:builder-call` | Builders define nodes at module scope or in tier R, `assert` is written in tier R only (§3.2), and `multiUserTest` marks a module-scope test descriptor (§4.4.4). The exceptions hold in every kind of function body: an inline `pattern(...)` used directly as the callee of an instantiation, which the compiler hoists, and `action` (§5.2) |

### 5.2 Runtime calls

A tier-F body may make five kinds of runtime call: instantiate a pattern,
create a cell, request an effectful built-in, read context that is not a
cell, and bind a handler. A body may call two kinds of factory value: a
pattern factory, which it instantiates, and a handler factory, which it
binds.

| Kind | Forms | `handler`, `action`, inline event handler | `lift`, `computed` |
| --- | --- | --- | --- |
| Instantiate a pattern | §4.4.2, with a statically resolved pattern or a pattern factory value | Yes | Yes. The instance belongs to the computation (below) |
| Create a cell | The constructors of §4.7 | Yes, with no cause needed | Yes, with an explicit cause (`X.for(cause)`) |
| Request an effectful built-in | As `builtin-inventory.md` lists | Yes | Not directly (below). A pattern the computation instantiates may request effects in its own body. An effect that depends on computed data is written in such a pattern, or in tier R with the computed value as its input |
| Read context | `eventKey()`, `currentPrincipal()`; `principalOf` and its siblings; `spaceOf` and its siblings; `linksOf`; `equals(a, b)`; `getPatternEnvironment()` | Yes | All except `eventKey()` and `currentPrincipal()`: a computation has no event |
| Bind a handler | Below | Yes | Yes |

`builtin-inventory.md` ("Which body may make which call") has the same
table with the pattern body beside it, and gives the reasons row by row.
Each refusal has a diagnostic in [§10.3](#103-function-tier). An authored
function is held to the rules of the bodies that call it. Two bodies have
no column of their own, and both are held to the rules of a `lift`: an
authored function called from tier R, whose call is a sandboxed call that
is evaluated again whenever an input changes (§4.4), and the body of an
`assert`, which is analyzed as a `computed` is (`footprint-analysis.md`,
§1.2). So neither requests an effect directly, each creates a cell only
with an explicit cause, and neither reads `eventKey()` or
`currentPrincipal()`. An authored function that both a handler and tier R
call is held to the stricter rules.

The staged changes (`grantSpaceAccess`, `revokeSpaceAccess`, `nameBlob`)
are effect requests that only the first column makes
(`builtin-inventory.md`, "Staged changes"). Tier R requests the other
effectful built-ins and not these, so a staged change written in tier R is
refused under the identifier that refuses it in a computation
(`function-body:effect-in-computation`). The correction in both places is
to request it in a `handler`, an `action`, or an inline event handler: a
pattern that a computation instantiates cannot request it either.

`wish` is none of the five kinds. It is a structural built-in that tier R
calls (§4.4), and its record is an operation of the plan, which a
function body has no site for (`plan-and-label-templates.md` §3.19). A
call of `wish` in tier F is refused (`function-body:wish`), in a
`handler`, an `action`, and an inline event handler as in a `lift` and a
`computed`, directly or through an authored function they call. The
body of an authored function is tier F wherever it is called from, so a
call there is refused too. The correction is to call `wish` in the
pattern body and read its result in the function body, or, where the
query depends on what the body computes, to call it in the body of a
pattern the function body instantiates. *Assumed,* with
`plan-and-label-templates.md` (its question 47): the project owner has
not ruled on it, and the corpus has no call of `wish` in a function body
(`builtin-inventory.md`, "Calls inside function bodies").

`equals(a, b)` is a context read because it observes the identity of both
operands and reads neither value (`plan-and-label-templates.md`, §3.16). It
is the function form of the comparison that §4.7 lists as the methods
`a.equals(b)` and `X.equals(a, b)`, and the three forms mean the same.

One difference between the two kinds of body explains the columns. A
handler invocation is a new frame for each event, so what it creates is new
and is identified by the handling and the order of creation. A handling is
identified by its receipt: the event's identifier and the stream the event
was sent to (`plan-and-label-templates.md`, §1.3). A `lift` or a
`computed` is evaluated again whenever an input changes, so what it creates
needs an identifier that is the same on every evaluation: an explicit cause
for a cell, the place of the call for an instance, and the bound state for
a handler binding.

**An explicit cause in a handler.** Without an explicit cause, an
identifier minted in a `handler`, an `action`, or an inline event handler
derives from the event, as it does today, so each event creates something
new. An explicit cause names the same thing on every event. A cell a
handler creates with `Writable.for<number>(cause)` is the same cell each
time an event is handled with an equal cause, and its existence label is
fixed when it is first created. The same holds for `.for(cause)` on an
instantiation ([§4.7](#47-cell-and-handle-methods)).
`plan-and-label-templates.md` (§1.3) owns the identifier. It holds the
handler's name and the calls and callbacks the handler is written in,
beside the cause, so two handlers of one instance that pass equal causes
name two cells. *Assumed* there (its §8, question 39): a later event
that instantiates under an equal cause creates nothing and does not
write the argument it passes, so the instance keeps the argument of the
event that created it. A handler that has to change what such an
instance reads passes a cell in the argument and writes the cell.

**Instantiating a pattern in a `lift` or a `computed`.** The callee is one
of the three that §4.4.2 and §5.1 allow in a function body: a pattern
declared or imported by name, an inline `pattern(...)` used as the callee,
or a pattern factory value. The call returns a link to the instance, as it does
in a handler. The pattern may request effects in its own body.

- **The instance belongs to the computation.** An evaluation that
  instantiates the same pattern at the same place names the same instance
  and updates its argument. The instance keeps its state across
  evaluations.
- **An instance an evaluation no longer makes is torn down.** A branch that
  is not taken, or a loop that runs fewer times, ends the instances the
  last evaluation made there.
- **An effect in the instance is requested again when its request
  changes,** as for any effect whose input changed. So a computation has an
  indirect way to request an effect: what it computes reaches the request
  through the argument it writes, and the label of the argument reaches
  the request with it (`plan-and-label-templates.md`, §3.14 and §3.15).
- **A callee that is a factory value can differ between evaluations.** When
  it does, the instance at that place is torn down and a new one is started
  under the same name, as for a child of the reactive tier
  (`plan-and-label-templates.md`, §3.15).

Two more rules complete the form.

- **The identity of the instance.** The instance is identified by the
  enclosing instance, the body's `name` and `within`, the site, and the
  ordinal of the instantiation among those the evaluation makes at that
  site. Where the author writes `.for(cause)` on the instantiation (§4.7),
  that cause takes the place of the ordinal. The body's `name` and
  `within` are the name the plan gives the `lift` or the `computed` and
  the calls and callbacks it is written in
  (`plan-and-label-templates.md`, §1.3 and §3.14). A site that runs once
  per evaluation needs no cause. A site in a loop names its instances by
  the order in which the loop makes them, so removing the first record of
  a list gives each instance the argument of the next record and tears
  down the last instance. An author who wants each instance to stay with
  its record writes `.for(cause)` with a cause taken from the record.

  The compiler warns where a site can run more than once in an evaluation
  and has no cause (`function-body:instantiation-without-cause`): an
  instantiation without `.for(cause)` inside a loop, or inside a function
  written in the body, such as the callback of a JavaScript `map`. It is a
  warning and not an error, because naming by order is what the author
  wants for a list that only grows at its end. The warning is reported in
  a `lift`, a `computed`, an `assert`, and an authored function that one
  of them or tier R calls. It is not reported in a `handler`, an `action`,
  or an inline event handler, where each event makes its instances anew.
  The callback of an inline `pattern(...)` is a tier-R body and not a
  function of this rule. *Assumed:* the bodies the warning covers are
  those ([§13](#13-open-questions), question 26).
- **A `lift` or a `computed` does not request an effect directly**
  (`function-body:effect-in-computation`). An effect that depends on
  computed data is written in a pattern, inline or named, that the
  computation instantiates, or in tier R with the computed value as its
  input.

```tsx
// Shown for illustration only.
const PriceQuote = pattern<{ url: string }>(({ url }) => fetchJson({ url }));

const quotes = computed(() => {
  const open = orders.filter((order) => !order.paid); // JavaScript `filter`
  return open.map((order) =>
    PriceQuote({ url: priceUrl(order) }).for(order.id)
  );
});
```

**Today.** A `lift` or a `computed` whose result holds a pattern instance
already keeps the instance across evaluations. The runner turns the frame
of the run into a synthesized pattern (`patternFromFrame` in
`runtime/runner/src/builder/pattern.ts`) and runs it into a result cell
whose cause is the computation's record of its inputs, its outputs, and its
function source, so every evaluation names the same cell
(`#instantiateJavaScriptActionNode` and `#writeJavaScriptActionResult` in
`runtime/runner/src/runner.ts`). The instance inside takes its result cell
from the place it has in the synthesized pattern (`#mintChildResultCell`).
On each evaluation the runner hashes the synthesized pattern. When the hash
is the one of the last evaluation, nothing is set up again. When it
differs, the runner runs the new synthesized pattern on the same cell,
which stops the pattern running there and starts the new one (`run`). What
was started is released when the computation's node is canceled. So an
instance is named by its place today as well. What differs is that today
a synthesized pattern that changed is stopped and the new one started,
where this design updates the argument of an instance that stays.

**Binding a handler.** There are two spellings, and they mean the same.

- *Applying a handler to its state:* `remove({ items, item })`, where
  `remove` is a `handler(...)` definition declared in the module or imported
  by name, or a value of a handler factory type. The argument is an object
  literal, and each property value is an ordinary tier-F expression evaluated
  at the call.
- *An inline event handler or an `action`:* an arrow function written as an
  `on*` attribute of JSX, or `action(() => ...)`. It means what it means in
  tier R. The compiler hoists the arrow to a handler definition whose state
  is the set of values the arrow captures.

Either evaluates, at run time, to a stream. These rules apply to the state.

- A state value is a data value or a cell handle. A function value is
  refused (`ses-callback:callable-capture`), as in tier R.
- For the inline spelling, a captured local is a `const` or a parameter. A
  captured `let` is refused (`function-body:handler-capture`): the binding
  is made from what the variable holds when the binding is made, so the
  handler would not see a later assignment. The diagnostic says to assign
  the value to a `const` first and to capture that. The applied spelling
  has no such rule, because its state expressions are evaluated where they
  are written.
- The callee is a module-scope handler called by name, or a value of a
  handler factory type (§4.4.2). The state rules are the same for both.
- Each state expression is checked against the declared state type by
  [§7.5](#75-assignability) alone. A handle is given where the state
  declares a handle, and a value where it declares a value: the rule
  that lets a value and a handle stand for each other belongs to tier R
  ([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)). The same holds
  for the argument of a pattern instantiated in a function body.

**What a binding holds.** A binding made while a function body runs holds,
for each path of the handler's state, a link or a copy. The body is a
`lift`, a `computed`, a `handler`, an `action`, an inline event handler, or
an authored function one of them calls.

| What is bound at the path | The binding holds | When the handler reads it |
| --- | --- | --- |
| A cell handle | A link to the cell | When an event arrives |
| A scalar: a primitive, a literal, `null`, `undefined` | A copy, in the binding's state document | The value is the one the body had when it made the binding |
| A container (an object, an array, or a tuple) that the body read from an input or a cell and passes on unchanged; a reference at a position typed `unknown`, likewise | A link to the address the container is stored at. The body that makes the binding does not read the container's content | When an event arrives, in the event's transaction |
| A container the body computed: an object or array literal, a spread, the result of a call or of an operator | A copy. A cell handle inside it stays a link, and so does a container inside it that the body read and passes on unchanged | The copy is the value the body computed when it made the binding |

The plan records the first and the third row as a link and the other two
as a copy (`Binding.state` in `plan-and-label-templates.md`, §1.1).

A container is passed on unchanged when the state expression denotes the
value as the body received it: a parameter or a captured input, a property
or an element of one, or the result of `get()` on a handle, with no
construction or conversion between the read and the binding.
`{ ...donut }` and `[...donuts]` are computed containers. How much a copy
holds is decided by what the bound handler observes of the path, for a
scalar as for a computed container. The copy holds the paths the
handler's footprint names, each as far as the handler observes it: the
value where the handler reads the value, a stand-in of the same kind where
it only tests for presence, and nothing at a path the handler does not
observe (`plan-and-label-templates.md`, §3.14, "How much a copy holds").
For a handler received as a factory value, whose body the compiler does
not have, the copy holds the paths its declared state type covers
(`footprint-analysis.md`, §8.5).

A binding made in tier R copies nothing ([§4.6](#46-captures)). The
difference is that a value of tier R has a place in the instance that the
handler can read later, and a scalar or a computed container of a function
body exists only while the body runs.

**The identity of a binding** is derived from the enclosing instance, the
handler definition, and the bound state: each copied value, the identity of
each linked cell, and the address of each container bound by reference. A
copied value is salted with a secret of the space before it enters the
identifier, as an element key is. `builtin-inventory.md` defines the
identity ("A handler binding made in a body"), and
`plan-and-label-templates.md` (§3.14) gives the plan record and the label
rule. `footprint-analysis.md` (§8.5) compares the rule with what a binding
reads today. Five consequences are visible to an author.

- A `lift` or a `computed` evaluated again with the same state names the
  same streams.
- A binding made in a loop is told from its neighbors by its state and not
  by its position, so reordering the loop does not re-point an event
  already on its way.
- Two bindings of one handler to equal copied values and the same cells
  are one stream, which is harmless because they behave alike. Two
  bindings of one handler to equal records stored in two places are two
  streams, because the two addresses differ.
- A handler that passes on a record bound by reference, for example by
  pushing it onto a list, stores a link to the original record and not a
  second record.
- A handler sees a container bound by reference as it is when the event
  arrives, with every change made since the binding. A scalar and a
  computed container are as they were when the binding was made.

```tsx
// Shown for illustration only.
interface RemoveState {
  chosen: Writable<string[]>;
  name: string;
}
const removeTopping = handler<unknown, RemoveState>(
  (_, { chosen, name }) => chosen.removeByValue(name),
);

// `name` is a scalar and is copied. `chosen` is a handle and stays a link.
const toppingButtons = (toppings: string[], chosen: Writable<string[]>) =>
  toppings.map((name) => (
    <span>
      <button onClick={() => chosen.addUnique(name)}>{name}</button>
      <button onClick={removeTopping({ chosen, name })}>remove</button>
    </span>
  ));

// `donut` is a record read from the cell and passed on unchanged, so it
// is bound by reference: the push stores a link to the record in `box`.
const favoriteButtons = (
  box: Writable<Donut[]>,
  favorites: Writable<Donut[]>,
) =>
  box.get().map((donut) => (
    <button onClick={() => favorites.push(donut)}>{donut.name}</button>
  ));
```

The methods of a cell handle, and the tier each is legal in, are listed in
[§4.7](#47-cell-and-handle-methods).

### 5.3 Verb results

A `handler` or an `action` declares the value it returns to its caller by a
result type argument. A block body that returns a plain value without one is
refused (`verb-result:undeclared-return`), as today.

### 5.4 What footprint analysis needs from the grammar

The footprint record is defined in `plan-and-label-templates.md` (§1.1).
The analysis that fills it in is the subject of `footprint-analysis.md`,
which takes the following from this document as given (its §1.3).

- **The grammar of a body.** A body holds the statements and expressions of
  §5.1 and nothing else. It has no classes, no `this`, no `async` code, no
  generators, no `for...in`, no dynamic code, and no write to module scope
  or to a global.
- **A closed surface.** The methods of a cell handle are those of §4.7, and
  the standard-library members a body can use are those of §9. The
  analysis has a rule for each, and a use of a member that is not listed is
  refused (`cell:unsupported-method`, `stdlib:unsupported-member`).
- **Types.** The analysis runs after the type checker of §7. Every
  expression has a concrete type, because the checker has no deferred types
  and refuses `any` (§7.3, §7.8). A generic function is analyzed once per
  instantiation, as it is checked.
- **Statelessness.** No binding that outlives a call holds mutable state
  (§3.3). Everything a body can reach is therefore its inputs, the
  module-scope constants, and what it creates.
- **The signatures of imported functions.** The parameters and the result
  of a tier-I function are data types that contain no handle type (§5.5).
  Such a function receives no cell handle and no function, and a call of
  it reads each argument in full.

The grammar is chosen so that the analysis rarely gives up. Where it does,
it widens the footprint: it replaces the entries it could not name by
entries that cover them, and reaches no further than the value or the key
it lost track of (`footprint-analysis.md` §5.1, §5.4). A widening can cover
several entries, as a key that is not static does, or a cell handle the
analysis lost track of. The compiler reports each widening as a hint
(`footprint:widened`) that names the expression, the cause, and what the
widening covers: the input paths of the widened entries, or the handle.
`footprint-analysis.md` §5.2 lists the causes of a widening, and the list
is complete: a construct that is not on it does not widen.

The analysis has two more outcomes that are not widenings and not errors,
each with a hint: a read through a cell handle that stays dynamic
(`footprint:dynamic-read`, that document's §7.2), and a `lift` or a
`computed` whose write makes it a materializer (`footprint:materializer`,
its §6.3). It also supplies the read and write sets from which two warnings
are computed: a computation whose write cannot be idempotent
(`side-write:not-idempotent`, its §6.6), and a cycle through a side-write
that is visible in the plan (`side-write:cycle`,
`scheduler-and-serving-loop.md` §8.2).

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
  builder or a built-in. An import of a value from `commonfabric` is refused
  (`import:commonfabric-value`).
- **Parameters and results are data types without handles.** A handle type
  is a data type ([§1](#1-terms)), and this rule excludes it by name: no
  parameter and no result has a type that is or contains a handle type
  (`import:signature-not-data`). A cell passed to such a function could be
  written without the plan knowing, so the refusal stays until question 5
  of [§13](#13-open-questions) is settled. A function-typed parameter is
  refused under the same identifier, because a function type is a code
  type.

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
   - `map`, `filter`, `flatMap`, `some`, `every`, `find`, or `findIndex`
     with a callback written in place whose body is itself
     expression-shaped and pure; or `reduce` with an expression-bodied
     callback and an initial value (§4.4.1). The receiver is an array
     value;
   - a standard-library function or method marked "R" in §9;
   - a pure API function that [§4.4.4](#444-pure-api-functions) lists for
     tier R;
   - an authored function or a `lift` result, with no function arguments;
   - `.get()`, `.key(k)`, `.elementById(k)`, `.resolveAsCell()`, `.equals(x)`,
     or `.equalLinks(x)` on a cell (§4.7), or the function form
     `equals(a, b)` of the same comparison (§5.2).

   A collection callback counts only where §4.4.1 accepts it in tier R. One
   that takes a third parameter, or that is a function passed by name, is
   legal JavaScript in the function body and disqualifies the `computed`.
   So do the other forms that tier F accepts and tier R refuses: a `reduce`
   whose accumulator has a code type, an object literal with a key that is
   not static, and a default value or a rest element in a `const`
   destructuring of a value that is not a constant expression (§4.2).

   The list has no aggregate and no collection-index method, because no
   accepted `computed` calls one. The body is checked under the rules of
   tier F (§6.2). There a JavaScript array has no such method
   ([§9.2](#92-array)), and a collection method on a cell handle is refused
   ([§4.7](#47-cell-and-handle-methods)). An aggregate or an index is
   written in the pattern body, outside a `computed`.
5. **Nothing else occurs in the body.** In particular it creates no cell,
   instantiates no pattern (including by a JSX tag that names one), binds
   no handler in any of the spellings of §5.2 (an inline event handler in
   JSX included), requests no effect, and writes nothing.

   A `computed` that instantiates a pattern is legal (§5.2) and is not
   promoted, because the two tiers give the call different meanings. In a
   function body the instance belongs to the computation and has a result
   cell of its own, named by the site of the call. In tier R a call of a
   pattern the compiler can resolve is compiled into the surrounding
   instance (§4.4.2). Promoting the call would change which documents
   exist and how the state inside is named.

   A `computed` that binds a handler is legal (§5.2) and is not promoted,
   for the same reason. A binding made while a function body runs copies a
   scalar and a computed container into a binding state document, and its
   stream is identified by what the binding holds (§5.2). A binding made
   in tier R copies nothing, and its stream is named by where it is
   declared (§4.6). Promoting the binding would change which documents
   exist, which stream the result links to, and when the handler reads a
   captured scalar.

   *Assumed:* the project owner has not ruled on either case
   ([§13](#13-open-questions), question 15).

JSX with host elements is allowed in a promoted body. An `on*` attribute
in it takes a stream the body refers to, and not an arrow function, which
would bind a handler. A call of an authored function inside a promoted
body stays a sandboxed call with its own footprint; the expression around
it is promoted.

### 6.2 What promotion preserves

A promoted `computed` computes the same value as the unpromoted one. Four
things differ, none of them in the value.

- **Labels.** The unpromoted result has one label, the join over the body's
  footprint. The promoted result has a label template per output path, a
  conditional contributes only the selected branch, and a mapped collection
  has an element template and a membership slot.
- **The atom for the callback's code.** This is not preserved. The unpromoted
  result carries, at every path, a `TransformedBy` atom that names the code of
  the callback, where its label is not empty. The promoted result carries no
  atom that names the callback. A path that an operator or a call computes
  carries the atom of the dependency cone it is evaluated in, and a path that
  passes a value on, as a conditional and a property access do, carries the
  integrity of that value and no minted atom. *Assumed,* with
  `plan-and-label-templates.md` (its §3.2, "A promoted `computed`", and its
  question 64). So a declared label or an exchange rule that requires
  `TransformedBy` of a named `computed` is not met by a promoted one. One that
  names a `lift` is not affected, because a `lift` is not promoted.
- **Cost.** The promoted expression is part of a dependency cone's value
  code and makes no sandboxed call of its own.
- **Granularity of recomputation.** The body of a promoted `map` is one or
  more cones, and each is evaluated once per element key (§4.4.1).

Promotion never changes whether a program is accepted. The compiler checks
the body of every `computed` under the rules of tier F, which accept
everything the criterion accepts, and applies the criterion afterwards.
So no rule of tier R is applied to a promoted body as a refusal: a
construct tier R would refuse either is legal in tier F and disqualifies
the `computed`, or is refused in both tiers. A `computed` that
fails the criterion stays a tier-F body. The compiler reports why on request
(`computed:not-promoted`, a hint that names the first disqualifying
construct), because the fix is often small: `xs.sort(...)` on a copy becomes
`xs.toSorted(...)` inside a tier-F helper, or a loop that sums becomes a
`reduce` with an expression body.

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
| `object` | Every value that is not a primitive, `null`, or `undefined`. An object type, an array, a tuple, a handle type, and a factory type are assignable to it, and it declares no property. In a data type it declares a reference that is not read, as `unknown` does ([§7.8](#78-any-and-unknown)) |
| `any` | Refused ([§7.8](#78-any-and-unknown)) |
| `never` | The bottom type. `Record<string, never>` is the empty object |
| Object types | Type literals and interfaces, `extends` between interfaces, optional properties (`?`), `readonly` properties. Property names are identifiers, string literals, numeric literals, and the well-known keys the API exports (`[UI]`, `[NAME]`, `[SELF]`, and the others) |
| Index signatures | `[key: string]: T` and `Record<K, T>` where `K` is `string` or a union of string literals |
| Arrays | `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>` |
| Tuples | Fixed elements, optional trailing elements, named elements, `readonly`, and a spread of another tuple type. A named element may be optional. A rest element of an array type is refused ([§7.9](#79-type-features-the-checker-refuses)) |
| Unions | Of any supported types |
| Intersections | Computed eagerly ([§7.4](#74-intersections)) |
| References | To aliases and interfaces, with type arguments. A qualified name resolves through a namespace import ([§7.10](#710-type-operators-and-references)) |
| `typeof name` | The declared or inferred type of a value binding. `typeof a.b` is the type of the property at that path. In a label argument `typeof name` names the binding itself where a writer or a rule set is expected, and the value of a constant everywhere else ([§8.5](#85-label-arguments)). In a default it names the binding's value ([§8.8](#88-defaults-and-scopes)) |
| Indexed access `T["k"]`, `T[number]` | Computed eagerly; the key is a literal type, a union of literals, or `number` on an array or tuple |
| `keyof T` | Computed eagerly to a union of string literals; `T` is an object type |
| Function types | `(a: A) => B`, and method signatures in object types. Code types: legal as the type of code and refused in a type used as data ([§7.9](#79-type-features-the-checker-refuses)) |
| Type predicates | `x is T` as a function's return type. The body is checked to return a boolean; the predicate is trusted |
| Type operators, implemented natively | `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Record`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters`. [§7.10](#710-type-operators-and-references) has the rule of each |
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
| `AnyCell<T>` | A handle of a kind the type does not state. Every cell handle and every `Stream` is assignable to it, and it is assignable to `AnyCell` alone ([§7.5.1](#751-handles)). It has no method of [§4.7](#47-cell-and-handle-methods): a value of it is compared with `equals`, given to a context read, or passed on |
| `Stream<T>` | A handle that accepts events of type `T` |
| `Reactive<T>` | The same type as `T` |
| `Default<T, V>`, `DeepDefault<V>` | `T` with a default-value annotation `V`; `V` is a literal-like type, or `typeof` of a constant with a static initializer, and its value is assignable to `T` ([§8.8](#88-defaults-and-scopes)) |
| `PerSpace<T>`, `PerUser<T>`, `PerSession<T>`, `PerAny<T>`, `Scoped<T, S>` | `T` with a scope annotation ([§8.8](#88-defaults-and-scopes)) |
| The CFC aliases | `T` with label annotations ([§8](#8-labels-as-annotations)) |
| `VNode`, `JSONSchema`, `JSONValue`, the built-in parameter and state types | Opaque named types or ordinary object types, as the API declares them |
| `PatternFactory<I, O>`, `HandlerFactory<E, S>` | Factory types, and data types: a value is a reference to a compiled definition, so it may sit in a pattern input or result, a cell, a handler's state, or an event. Calling one follows §4.4.2. The result of `pattern(...)` has the first type and the result of `handler(...)` the second. The result of `lift(...)` is a function, a code type |
| `ReturnType<typeof someHandler>`, `Parameters<typeof SomePattern>[0]`, `ReturnType<typeof SomePattern>`, `Parameters<typeof someHandler>[0]` | Defined on factory types, which are called with one argument and yield one value ([§7.10](#710-type-operators-and-references)): the stream type a handler yields, a pattern's input type, a pattern's result type, and a handler's state type |

A type is an API type when its name resolves, through its import, to a
declaration in `commonfabric`. A local type that happens to be named
`Writable` or `Confidential` is that local type.

**Opaque named types.** `VNode` is opaque: its structure is not part of
the language. A value of it is a JSX expression, the result of an API
function declared to return it, such as `uiVariant`, or a value read
from a position declared with it. It is assignable to itself, to a union
that names it, and to `unknown`, and nothing else is assignable to it
([§7.5](#75-assignability)). `JSONValue` is not opaque. It is the union
of `string`, `number`, `boolean`, `null`, an array of `JSONValue`, and a
record of `JSONValue`, and a read-only array or record is assignable to
it. An object type is assignable to a record of `JSONValue` when each
property is, and an optional property counts by its declared type: a
property that is absent is not stored. `JSONSchema` is `boolean` or a
record of `JSONValue`: the checker
does not check the keywords of a schema. *Assumed:* each built-in
parameter and state type is an ordinary object type unless
`builtin-inventory.md` names it as opaque.

**A handle type may hold a handle type.** `Cell<Cell<T>>` is valid, and so
is every other pair: the value type of a handle is any data type, and a
handle type is one ([§1](#1-terms)). The value stored in the outer cell is
a link to the inner cell. `get()` on the outer handle returns the inner
handle, and `key` flattens every handle it passes through
([§4.7](#47-cell-and-handle-methods)).

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
  typed after the other arguments. A type parameter that the arguments
  other than lambdas do not determine, and that occurs in the result
  type, is taken from the type expected of the call, where one is
  expected. The result type expected of a lambda argument then follows,
  and the body of the lambda is checked against it. So in
  `rows.map((row) => ({ kind: "mix" }))`, returned where a
  `Topping[]` is declared, the object literal is checked against
  `Topping` and its `kind` is not widened ([§7.5](#75-assignability)).
  A type parameter nothing determines takes its default, or is an error
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
- An intersection with an operand that is a handle type, a factory type, a
  function type, or an opaque named API type such as `VNode` is not
  computed, and writing one is refused
  (`subset-type:empty-intersection`): `Cell<A> & { ... }`,
  `VNode & { ... }`, `((a: A) => B) & { ... }`. No rule above says what
  the merged type holds: a handle is a link and has no properties to
  merge, a function with properties is a callable object
  ([§7.9](#79-type-features-the-checker-refuses)), and the structure of
  an opaque API type is not part of the language
  ([§7.2](#72-api-types)). For a handle the author intersects the value
  types, `Cell<A & B>`, which says what the cell holds. An API type that
  is an ordinary object type merges as one. *Assumed* for the opaque API
  types ([§13](#13-open-questions), question 24).
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
- A tuple type is assignable to a tuple type when it has every required
  element of the target, has no more elements than the target declares,
  and each element is assignable to the element at its position. It is
  assignable to an array type when every element is assignable to the
  array's element type. An array type is not assignable to a tuple type.
- A handle type is assignable to a handle type by the two rules of
  [§7.5.1](#751-handles), and to `unknown` and `object`
  ([§7.1](#71-types-the-checker-supports)). It is not assignable to an
  object type, one that declares methods of the same names included: a
  `Cell<Donut[]>` is not a `{ get(): Donut[] }`. A helper that takes a
  cell declares its parameter with the cell type, so that the declaration
  says whether the value is a cell, and so that footprint analysis sees
  every read and write through a handle as one (§5.4). §7.5.1 has the
  correction of such a helper.
- A value that is not a handle is not assignable to a handle type, and a
  handle is not assignable to its value type. A function body reads the
  value with `get()`. There are two exceptions: the arguments of three
  kinds of call in tier R, which are bound by reference
  ([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)), and the
  argument of a pattern instantiated in a function body
  ([§7.5.3](#753-the-argument-of-an-instantiation-in-a-function-body)).
- An opaque named API type ([§7.2](#72-api-types)), such as `VNode`, is
  assignable to itself, to a union that names it, and to `unknown`.
  Nothing else is assignable to it.
- Label annotations do not take part in structural assignability
  ([§8.6](#86-assignability)).

**Where a literal type is widened.** A literal type is widened to its
primitive type where the value is bound to a place that can be assigned
again, or where its type is inferred with nothing expected of it: a
`let` binding, a mutable property of an object literal, an element of an
array literal, and the inferred result type of a function. `as const`
prevents each. Only a literal written in the expression is widened: a
value whose type is a declared union of literal types keeps that type
wherever it is bound or returned. A literal written where a type is
expected is checked part by part against that type and is not widened
there: `{ kind: "mix" }` is assignable to `{ kind: "mix" | "plain" }` as
an argument, as a returned value under a declared result type, and as
the initializer of an annotated binding. The expected type reaches the
body of a function written in place through the function type expected
at its position, a callback of a generic method included
([§7.3](#73-generics), "Inference at a call").

#### 7.5.1 Handles

Two rules decide whether a handle of one type is assignable to a handle
of another: one about the kind, and one about the value type.

**Kind.** A handle is assignable to a handle of its own kind. `Cell<T>`,
which is `Writable<T>`, is also assignable to `ReadonlyCell`,
`WriteonlyCell`, `ComparableCell`, and `OpaqueCell`
([§7.2](#72-api-types)). A handle of every cell kind, and a `Stream`, is
assignable to `AnyCell`. No other pair of kinds is assignable: a
`ReadonlyCell` is not a `Cell`, a `Stream` is assignable to a `Stream`
and to `AnyCell` alone, and an `AnyCell` is assignable to an `AnyCell`
alone.

**Value type.** What the target handle can do decides how the value type
`T` of the source is compared with the value type `U` of the target.

| Target | Condition | Reason |
| --- | --- | --- |
| `ReadonlyCell<U>`, `ComparableCell<U>`, `OpaqueCell<U>`, `AnyCell<U>` | `T` is assignable to `U` | Nothing is written through the target. What is read through it, or projected from it, is a `T`, which is a `U` |
| `WriteonlyCell<U>`, `Stream<U>` | `U` is assignable to `T` | Nothing is read through the target. What is written or sent through it is a `U`, which the cell or the stream accepts as a `T` |
| `Cell<U>`, `Writable<U>` | `T` and `U` are the same type up to annotations | The target reads and writes, so both conditions hold |

So `Cell<T>` is not assignable to `Cell<T | undefined>`, and
`Cell<T | undefined>` is not assignable to `Cell<T>`. Through the first
target a body could store `undefined` in a cell whose other readers
declare `T`, and each of those reads would then fail its cone
(`plan-and-label-templates.md`, §5.2). Through the second a read could
return `undefined` where the type excludes it. A position that may hold
no value is declared so on both sides, or the property that holds the
handle is optional. `ReadonlyCell<T>` is assignable to
`ReadonlyCell<T | undefined>` by the first row.

**A handle of a narrower view.** A record type that declares some of the
properties of `T` is a view of `T`: with `Message` declaring `body`,
`sentAt`, and `reactions`, the type `{ body: string }` is a view of it.
`Message` is assignable to the view, so `Cell<Message>` is assignable to
`ReadonlyCell<{ body: string }>` by the first row, and a read through
the target loads the view's properties alone. `Cell<Message>` is not
assignable to `Cell<{ body: string }>`, by the third row. Through that
target a body could `set` a record that has `body` and nothing else, and
every reader that declares `Message` would then find stored data that
does not match its type and fail its cone
(`plan-and-label-templates.md`, §5.2). A position that holds a link read
through a view is declared `ReadonlyCell` of the view,
`quotes?: ReadonlyCell<RepliedMessage>`. A body that also writes through
the link declares the type the cell has.

**A writable view wider than the declaration.** A `Cell<U>` whose value
type admits more than the declared type of the place does is refused in
the same way, by the third row and by ruling: a `Cell<TopicAuthor>` is
not assignable to a `Cell<Partial<TopicAuthor>>`, nor to a
`Cell<TopicAuthor | undefined>`. There is no exception for code that
migrates stored data. An input whose stored data has an older or a
partial shape declares that shape, `createdBy?: Partial<TopicAuthor>`,
so that every reader and writer of the place agrees on what it may
hold, and the pattern exposes the complete form as an output it
computes from the input. A key that older data holds and that code
reads as a string is declared `string`
([§7.8](#78-any-and-unknown)). The one wider target the kind rule and
the table admit is `unknown` itself, below.

**A handle of `unknown`.** A handle of `T` is assignable
to a handle of `unknown` of a kind the kind rule admits, whatever the
row: `Cell<Donut>` to `Cell<unknown>`, and `Stream<Donut>` to
`Stream<unknown>`. The reverse is refused, by the table.
[§7.8](#78-any-and-unknown) says what a body may do through such a
handle. The rule is about a value type that is `unknown` itself, and not
about an `unknown` inside it: `Cell<Donut[]>` is not assignable to
`Cell<unknown[]>`. Whether a write through such a handle stays legal is
open ([§13](#13-open-questions), question 29).

**A structural type is not a handle.** A helper declared with
`{ get(): T }`, to accept "anything that can be read", accepts no cell
(§7.5). Its correction is `ReadonlyCell<T>`: every `Cell<S>` and
`ReadonlyCell<S>` with `S` assignable to `T` is assignable to it, which
is what the structural type was written for. A helper that also writes
declares `Cell<T>`. A helper that is given a cell at some calls and a
plain value at others has no one declaration: it takes the value, and
the caller that holds a cell reads it first. The prototype of the type
checker reports about 25 arguments in the corpus that pass a cell to
such a parameter ([§11.4](#114-where-the-subset-was-adjusted-to-the-corpus)).

#### 7.5.2 Arguments bound by reference in tier R

In tier R every value has a place in the instance: it is an input, a
state cell, an element of a collection, or a value the instance computes
([§4.6](#46-captures)). An argument of a call written there is not
copied into the callee. Each path of the argument is bound to the place
the expression at that path denotes, and the callee declares, path by
path, whether it wants the value at that place or a handle to it. So in
the arguments of the three calls below, a value and a handle of that
value stand for each other.

**Which calls.** The rule holds for the argument of a call written in
tier R, the body of a reactive collection callback included, whose
callee is

- a pattern, statically resolved or a factory value, the attributes of a
  JSX tag that names a pattern included ([§4.5](#45-jsx));
- a handler applied to its state, by name or as a factory value
  ([§4.4.2](#442-patterns-and-handlers-as-callees)); or
- a `lift` result.

It holds nowhere else. It does not hold for an authored function called
in tier R, whose parameters are checked by §7.5 alone: tier R passes a
cell where the function declares the cell type, and writes `count.get()`
where it declares the value, which is legal at every tier-R expression
site ([§4.4](#44-calls)). It does not hold for the value a pattern body
returns against a declared result type, for an annotated `const`, or for
a cast. And it does not hold in tier F, in any call: a value of a
function body is a JavaScript value and not a place. The body of a
`computed` is tier F for this rule whether or not the `computed` is
promoted ([§6.2](#62-what-promotion-preserves)). In a function body the
state of a handler binding is checked by §7.5 alone
([§5.2](#52-runtime-calls)), and the argument of an instantiation has a
rule of its own
([§7.5.3](#753-the-argument-of-an-instantiation-in-a-function-body)).

**The rule.** The type of the argument is compared with the declared
type position by position: through the properties of an object type,
the elements of an array or a tuple, and the value type of a handle. At
each position one of four cases applies.

| The argument has | The callee declares | Accepted when | What the callee gets |
| --- | --- | --- | --- |
| A value of type `T` | A value type `U` | `T` is assignable to `U`, by §7.5 with this table applied below the position | The value |
| A value of type `T` | A cell handle of `U`: `Cell`, `Writable`, `ReadonlyCell`, `WriteonlyCell`, `ComparableCell`, or `OpaqueCell` | A `Cell<T>` would be assignable to the declared handle ([§7.5.1](#751-handles)) | A handle of the declared kind to the place the argument denotes |
| A handle of `T` that can be read: `Cell`, `Writable`, or `ReadonlyCell` | A value type `U` | `T` is assignable to `U` | The value the cell holds, as `h.get()` written at the position would give it. The callee depends on the value and is evaluated again when it changes |
| A handle | A handle | [§7.5.1](#751-handles) | The handle |

Eight points complete the table.

- **The type of an argument that is a value is the declared type of its
  path.** By ruling, where the second row applies, the handle the callee
  gets has the declared type of the place the expression names, and
  that type is the `T` of the row. Narrowing describes the value at the
  time of a test and does not narrow the place: under a condition, the
  right operand of `&&`, or a branch of `?:`, the argument has the type
  its path declares. So `ann.status`, with `status?: AnnotationStatus`
  declared, binds a handle of `AnnotationStatus | undefined` also under
  `ann.status === "open"`, and is refused where the callee declares a
  required `Writable<AnnotationStatus>`. A non-null assertion does not
  change the type of a place either: `ann.status!` names the same place
  and binds the same handle. The callee declares
  `Writable<AnnotationStatus | undefined>`, or declares the property
  optional (the point on `undefined` below). The first row is not
  affected: where the callee declares a value, the narrowed type of the
  argument is compared, because the callee gets the value. An argument
  that is an optional property of a pattern's input whose type declares
  a default has the declared type without `undefined`
  ([§7.6.1](#761-optional-properties-of-an-input)). *Assumed*
  ([§13](#13-open-questions), question 35): where a condition narrowed
  a prefix of the path, as `order.note` is narrowed for the argument
  `order.note.text`, the declared type is that of the last step, read in
  the narrowed type of the prefix.
- **`AnyCell` and a value.** `AnyCell` is not among the handles of the
  second row. It declares a handle of a kind the type does not state
  ([§7.2](#72-api-types)), so the checker cannot say which handle a
  value would stand for, and a value is refused where an `AnyCell` is
  declared.

- **A literal where a cell is declared** is checked part by part against
  the value type of the declared cell, as a literal is wherever a type is
  expected (§7.5). `kind="ring"` meets a declared `Writable<string>`.
  The place the callee's handle names is then a constant of the
  instance, which is a value the instance computes for the point on
  writability below.

- **The value types of two handles** are compared by this table too. A
  `Cell<Donut[]>` meets a declared `Cell<Cell<Donut>[]>`, because each
  element of the stored list has a place a handle can name, and a
  `Cell<Cell<Donut>[]>` meets a declared `Cell<Donut[]>`, because a
  reader that declares the value follows the stored link.
- **`Stream`, `SqliteDb`, and a collection index handle** are in neither
  the second row nor the third. A plain value is not a stream, and a
  stream has no value to read. Each is given where it is declared, and
  nothing else is.
- **A handle that cannot be read** (`WriteonlyCell`, `ComparableCell`,
  `OpaqueCell`) is not accepted where a value is declared. The kind
  withholds the read, and the third row would grant it.
- **`undefined`.** The second row applies §7.5.1 as it stands, so a
  value of type `T` is refused where `Cell<T | undefined>` is declared,
  and a value of type `T | undefined` where `Cell<T>` is. Both are
  accepted where a `ReadonlyCell<T | undefined>` is declared. One case is
  wider, and it depends on the callee's declaration alone. Where the
  callee declares the property optional, `note?: Writable<string>`, an
  argument whose type has `undefined` is accepted, with `undefined`
  removed before the comparison: the binding refers to the place,
  whether or not something is stored there, and the callee has declared
  that the property may be absent. Where the callee declares the
  property required, an argument whose type has `undefined` is refused,
  an argument read from an optional property of the caller's own input
  included, unless that read has no `undefined` in its type
  ([§7.6.1](#761-optional-properties-of-an-input)). What a read through
  a handle returns while nothing is stored, at a place whose declaration
  has no default, is the matter of question 12 of
  [§13](#13-open-questions).
- **A default.** The default belongs to the stored place, by ruling. The
  callee gets a link and not a copy, and the link carries the schema of
  the place it names, the default included. So where nothing is stored
  at the place, the callee reads the default the place's declaration
  has, whether the callee declares the value or a handle, and whether or
  not its own type declares a default
  ([§7.6.1](#761-optional-properties-of-an-input);
  `plan-and-label-templates.md`, §2.5, "A default belongs to the place").
- **Writability.** The second row does not ask whether the place the
  argument denotes can be written, whatever the kind of the declared
  handle. The type of a reactive value does not say whether it is an
  input, a state cell, or a value an operation computes, and a declared
  type of `T` in the caller is not a capability: a pattern that declares
  its input `donuts: Donut[]` may give it to a child that declares
  `Writable<Donut[]>`, and the child's writes land in the cell the input
  is bound to. A caller that holds a `ReadonlyCell<T>` cannot do the
  same, by the kind rule. Where the place is a value the instance
  computes, such as the result of an operator, of a collection operation,
  or of a `computed`, the checker accepts the argument, and
  `plan-and-label-templates.md` defines the write (its §3.11, "A write through a
  handle to a value the instance computes"). By ruling there are two cases, and
  they are the same whether the callee is a child, a handler, a `lift` result,
  or a pattern compiled into the instance. Where the place holds a value the
  instance produces (the result of a `computed` or of an operator, an assembled
  collection, a literal), a write through the handle is refused at run time, and
  the compiler reports the argument where the callee writes through the handle
  (`binding:write-to-computed`, [§10.2](#102-reactive-tier)). A literal in the
  argument of a pattern called in tier R is such a value, also where the pattern
  is compiled into the caller: a pattern that declares `count: Writable<number>`
  and increments it is not given `{ count: 10 }`. The caller creates a state
  cell that holds the initial value and gives the cell,
  `const count = new Writable(10)` and then `{ count }`, because by ruling a
  pattern that changes or owns one of its arguments is given a writable cell
  for it. Where the place holds a reference to a stored place, the handle
  resolves through the reference and the write lands there. An element that a
  `filter` in a `computed` passes on is such a reference, and so is a handle
  that a `computed` returns: in the example that follows, `open` filters a
  stored list, and the write of the handler bound to each of its elements lands
  in the record of the stored list.

  ```tsx
  // Shown for illustration only.
  const open = computed(() => links.get().filter((link) => !link.removedAt));
  const rows = open.map((link) => (
    <cf-button onClick={retractLink({ link })}>Remove</cf-button>
  ));
  ```

  An argument given to a pattern that a function body instantiates is not bound
  by reference
  ([§7.5.3](#753-the-argument-of-an-instantiation-in-a-function-body)): it is
  the initial value of the child's stored argument, and the child writes it
  freely.

The plan records each path so bound as a link: every entry of
`Binding.state` of a binding made in tier R has `capture: "link"`
(`plan-and-label-templates.md`, §1.1 and §3.14), and the argument of a
child resolves to slots of the instance (its §3.15). The rule changes no
record. It is the typing of what those records already say.

```tsx
// Shown for illustration only.
interface RowInput {
  donut: Donut;
  shop: string; // the value
  chosen: Writable<string[]>; // a handle
}
const DonutRow = pattern<RowInput>(({ donut, shop, chosen }) => (
  <li onClick={() => chosen.addUnique(donut.name)}>
    {donut.name} at {shop}
  </li>
));

const DonutList = pattern<{
  donuts: Donut[];
  shop: Writable<string>;
  chosen: string[];
}>(({ donuts, shop, chosen }) => (
  // `shop` is a handle where `DonutRow` declares the value, and `chosen`
  // is a value where it declares a handle. Neither is copied.
  <ul>
    {donuts.map((donut) => (
      <DonutRow donut={donut} shop={shop} chosen={chosen} />
    ))}
  </ul>
));
```

**Today.** The published typings accept the same arguments for the same
three callees and no others: the input of a pattern, of a handler, and
of a `lift` result is typed `FactoryInput<StripCell<T>>` in
`base/api/index.ts`, which removes the cell types from the declared type
at every depth and accepts the value or any cell of it at each position.
`StripCell` keeps a `Stream` whole, and `CellWrappedData` admits
`undefined` at an optional property (`OptionalInputUndefined`). The
typings are wider in two ways that were read from those declarations:
they accept a value of `T` where a cell of `T | undefined` is declared,
and they accept a cell that cannot be read where a value is declared.
The project owner has ruled that the first stays refused, and that an
authored function is not bound by reference
([§13](#13-open-questions)).
The prototype of the type checker counts the sites in the corpus. In
218 arguments of a pattern or of a handler, a value is named where a
cell is declared or a cell where a value is declared. In about 37 more a
cell is named where a `lift` result or an authored function declares the
value; how many of the 37 are arguments of an authored function, which
this rule does not cover, was not measured.

#### 7.5.3 The argument of an instantiation in a function body

A pattern instantiated in a function body, by a call or by a JSX tag
that names the pattern, gets an argument document of its own, which the
request writes path by path
(`plan-and-label-templates.md`, §3.14, "Instantiating a pattern", and
§3.15). What the body gives at a path is a JavaScript value or a handle,
and the callee declares a value or a handle there. The four cases of
[§7.5.2](#752-arguments-bound-by-reference-in-tier-r) are accepted under
the same conditions, the points on a literal and on `undefined`
included. The attributes of a JSX tag that names a pattern are checked
as the properties of the argument are. What two of them mean differs,
because a value of a function body has no place of its own.

| The body gives | The callee declares | What the argument document holds at the path | What the callee has |
| --- | --- | --- | --- |
| A value | A value | The value: a copy of a scalar and of a container the body computed, and a link to a container the body read and passes on unchanged | The value |
| A value | A cell handle | The same. The value is the initial value of the new instance at that path | A handle to that path of its own argument document. A write through it changes the instance's argument and nothing the caller holds |
| A handle that can be read | A value | A link to the cell | The value the cell holds, read through the link. The instance depends on the cell and is evaluated again when it changes |
| A handle | A handle | A link to the cell | The handle |

So `Note({ title: "New note" })` in a handler, with `Note` declaring
`title?: Writable<string | Default<"">>`, starts an instance whose title
is `"New note"`, and the instance's own writes to `title` stay in it.
The same value given in tier R would bind the callee's handle to a place
of the caller (§7.5.2).

- **Copy or link** follows the ruling on what a binding made in a
  function body holds ([§5.2](#52-runtime-calls), "What a binding
  holds"): a scalar and a computed container are copied, and a handle
  and a container that has a stored address stay links. A scalar the
  body read from a place where nothing is stored, and whose declaration
  has a default, is copied as that default, which is what the body read
  ([§7.6.1](#761-optional-properties-of-an-input)).
- **A container passed on unchanged where a cell is declared.** The
  argument document holds a link to the container's address, and the
  callee's handle names the path that holds the link. A write through
  the handle follows the rule for a cell whose value is a link
  (`plan-and-label-templates.md`, §3.11, "A write through a resolved
  reference"). A caller that wants the new instance to have a record of
  its own gives a copy: `{ ...donut }`.
- **An instance named again.** In a `lift` or a `computed` an evaluation
  that names the same instance updates its argument (§5.2), so what the
  evaluation gives at a path replaces what the instance wrote there
  through its handle. Under an explicit cause in a handler, a later
  event writes no argument (§5.2, "An explicit cause in a handler").
- **The state of a handler binding** made in a function body has no such
  rule. A value given where the handler declares a cell is refused: the
  copy would live in the binding's state document, whose identity
  derives from the copied values (§5.2), and a write would change the
  state the identity was derived from. A handle given where the handler
  declares the value is refused too, and the body reads it with `get()`.

**Today.** The published typings accept these arguments: the input of a
pattern is typed `FactoryInput<StripCell<T>>` wherever it is called
(`base/api/index.ts`). The prototype of the type checker reports 35
arguments in the corpus that give a value where the instantiated pattern
declares a cell, for example in
`patterns/dev/default-app-ben/default-app-ben.tsx` and
`patterns/system/quick-capture/quick-capture.tsx`.

#### 7.5.4 Two refusals that follow from these rules

Two arguments of the corpus are refused by the rules above and look
intended by their authors. Both refusals are *assumed*
([§13](#13-open-questions), question 38), and each has an alternative
that accepts the argument.

**A handle of `T | undefined` where an optional handle of `T` is declared.**
`key` on an optional property that is not a handle yields a handle whose value
type has `undefined` ([§4.7](#47-cell-and-handle-methods)): with
`fileStoreRecord?: FileStoreRecord` declared,
`container.key("fileStoreRecord")` is a `Cell<FileStoreRecord | undefined>`.
Given in tier R where a handler declares the optional property
`fileStore?: Writable<FileStoreRecord | Default<{}>>`, it is refused
(`subset-type:mismatch`). The argument is a handle, so the fourth row of the
table of §7.5.2 applies, which is §7.5.1 as it stands, and its third row
requires the two value types to be the same. The point on `undefined` in §7.5.2
removes `undefined` before the comparison where the callee declares the
property optional, and it is stated for an argument that is a value, the second
row. It does not reach a handle. So the same place named as a value path,
`container.fileStoreRecord`, is accepted, and the handle `key` returns for it
is refused. `patterns/system/fabrichat/room.tsx` has the site, in
`FabriChatRoomCore`, where `ensureFileStore` is bound to `rootFileStore`. The
correction under the assumption is to name the value path, or to declare the
handle's value type with `undefined`. The alternative extends the point on
`undefined` to the fourth row: where the callee declares the property optional,
a handle of `T | undefined` is accepted for a declared `Cell<T>` or
`Writable<T>`, with `undefined` removed before the comparison, for the reason
the point gives for a value. The callee then holds a handle typed `T` to a
place that may hold nothing, as it does under the point for a value.

**An array of pattern results where a cell of an array is declared.**
§7.5 makes the value a pattern instantiation returns assignable to
every type the pattern's result type is assignable to, and to a cell of
such a type. It says that of one such value and not of an array of
them. So an array of the values `Note(...)` returns, given in a handler
as the `notes` of `Notebook`, which declares
`notes?: Writable<NotePiece[] | Default<[]>>`
(`patterns/system/notes/schemas.tsx`), is refused
(`subset-type:mismatch`): by the second row of §7.5.3 a
`Cell` of the array's type has to be assignable to the declared handle,
and by the third row of §7.5.1 the array of results and `NotePiece[]`
are not the same type, since `NotePiece` is a narrower view of what
`Note` returns. `createNotebookHandler` in
`patterns/system/quick-capture/quick-capture.tsx` has the site. The
correction under the assumption is for the callee to declare the type
the stored list has, or for the caller to give each element as the
record the callee declares. The alternative applies the rule for an
instantiation result at each element: an array or a tuple whose
elements are values pattern instantiations return is assignable to a
cell of an array of every type the result type is assignable to. Each
element is stored as a link to its instance, so the cell holds what a
reader of the narrower view can read, and a write of a record of the
narrower view through the cell would replace a link to an instance by
a record that has the view's properties alone.

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

**`"k" in x`** narrows by what the type of `x` declares.

- Where `x` is a union of object types, the true branch keeps the
  members that declare `k`, and the false branch keeps the members that
  do not declare it or declare it optional.
- Where `x` has the type `object`, or an object type that does not
  declare `k`, the true branch gives `x` that type with the property
  `k: unknown` added. Several tests add several properties:
  after `"id" in x && "name" in x` the type is
  `{ id: unknown; name: unknown }`. The false branch leaves the type as
  it was.
- Where `x` is a union of `object` with `null` or `undefined`, which is
  what `typeof x === "object"` gives, the true branch removes `null` and
  `undefined` and adds the property to `object`, since `in` throws on
  either.
- The property so added is an ordinary value typed `unknown`, and a
  kind test on the path narrows it: after `typeof x.id === "string"`,
  `x.id` is a `string`.

This is how a body inspects an ordinary value typed `unknown`, such as
the result of `JSON.parse`:

```ts
// Shown for illustration only.
function idOf(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!("id" in parsed)) return undefined;
  return typeof parsed.id === "string" ? parsed.id : undefined;
}
```

`typeof x === "object"` narrows an ordinary `unknown` to `object | null`.
On a data position typed `unknown` or `object`, `in` narrows nothing, as
a kind test does not ([§7.8](#78-any-and-unknown)). On a data position
typed with an object type that does not declare `k`, `in` adds no
property either: the type of a data position is the schema the position
is read under, and a property the schema does not declare is not loaded.
The author declares the property.

The variable of a `catch` clause has type `unknown`.

**Narrowing describes a value and not a place.** A test narrows what a
later read of the expression returns. It does not change the declared
type of the place the expression names, so a handle to that place has
the declared type, whatever tests surround the expression that names it
([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)).

**A value that may be absent.** A read of an optional property has the
property's type or `undefined`. The `?` is no member of the declared
type ([§8.4](#84-composition)), and the read can still find nothing. A
property read, an element read, or a call on a receiver whose type has
`undefined` or `null` is refused, in tier F and in tier R alike
(`subset-type:mismatch`), a receiver that is an optional property
included. The author writes `?.`, `??`, or a test that narrows. In tier R
`a?.b` is a path projection ([§4.3](#43-expressions)), and its type is
the type of `b` or `undefined`. One kind of optional property is read
without `undefined`: a property of a pattern's input whose type declares
a default (§7.6.1).

The types of the three forms, in every tier:

- **`a?.b`, `a?.[k]` and `a?.m(...)`.** The receiver is typed with
  `null` and `undefined` removed, the access or the call is typed on
  that, and the result is that type or `undefined`. Where the type of
  `a` has neither, the result is the type of the plain form. So with
  `handle` of type `Cell<T[]> | undefined`, `handle?.get()` has the type
  `T[] | undefined`: the method is the handle's, and the `undefined`
  comes from the absent receiver.
- **`a ?? b`.** The type is the type of `a` with `null` and `undefined`
  removed, in a union with the type of `b`. `b` is checked against the
  type of `a` so reduced, as the expected type at its position.
- **An empty array literal** has the element type its position expects,
  and `never[]` where nothing is expected. `never[]` is assignable to
  every array type, and a union of an array type with `never[]` is that
  array type. So `list ?? []` with `list` of type `T[] | undefined` has
  the type `T[]`, and `handle?.get() ?? []` above has it too.

#### 7.6.1 Optional properties of an input

A `?` on a property of a pattern's input type says one thing to the
caller and, for some properties, nothing to the body.

**The caller's side.** A caller may leave out a property declared with
`?`, and may give `undefined` for it. A property declared without `?` is
required of the caller, whether or not its type declares a default.
`Default<T, V>` says what a reader finds where nothing is stored. It
does not make the property optional, and an input that a caller may
leave out is written with both: `glaze?: Default<string, "plain">`.

**The body's side.** The type the body of a `pattern` sees for a
property of its input is decided by whether the property's type declares
a default: `Default<T, V>`, `T | Default<V>`, or `DeepDefault<V>`
([§8.8](#88-defaults-and-scopes)), written as the property's type or as
the value type of the handle the property holds.

| The property is declared | Example | The body reads | At run time |
| --- | --- | --- | --- |
| Optional, a handle whose value type declares a default | `chosen?: Writable<string \| Default<"">>` | The handle, without `undefined`. `get()` has the value type without `undefined` | The body is handed a handle whether or not the caller gave the property. A read through it finds the stored value, or the default where nothing is stored |
| Optional, a value whose type declares a default | `glaze?: Default<string, "plain">` | The value type, without `undefined` | The stored value, or the default where nothing is stored |
| Optional, a handle whose value type declares no default | `note?: Writable<string>` | The handle or `undefined`. The body tests it, or uses `?.` | The body is handed a handle here too. The type keeps `undefined` so that the checker reports what an editor reports (rule 2 of [§2](#2-design-rules)), and the test costs a comparison that always succeeds. What `get()` returns while nothing is stored is question 12 of [§13](#13-open-questions) |
| Optional, a value whose type declares no default | `note?: string` | The value type or `undefined` | `undefined` where nothing is stored |
| Required | `donuts: Donut[]` | The declared type | The caller gave it |

Four rules complete the table.

- **Where it holds.** The first two rows hold for the properties of the
  input type of a `pattern` itself, read from the parameter or from its
  destructuring pattern ([§4.1](#41-pattern-callback)). The input type
  has to be one object type, which an intersection of object types is
  once it is merged ([§7.4](#74-intersections)). Where it is a union of
  object types, the rows do not hold, and a read of an optional property
  has `undefined`: the members can declare different defaults, or none.
  They do not hold
  for a property of a nested object type, for the state or the event of
  a `handler`, or for the argument of a `lift`: there a read of an
  optional property has `undefined`, whatever the property's type
  declares. The run-time behavior of the first two rows is the same in
  those places. The checker asks for the test there because the
  published typings do.
- **A caller's optional property given where the callee requires it.**
  In tier R the argument is bound by reference
  ([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)). It is
  accepted where the read has no `undefined`, which is the first two
  rows, and refused for the third and the fourth unless the callee
  declares the property optional. So a pattern that declares
  `events?: Writable<Entry[] | Default<[]>>` may give `events` to a
  handler whose state declares `events: Writable<Entry[]>`.
- **The default belongs to the stored place.** In that example the
  handler declares no default, and it reads the place the pattern's
  input is bound to. By ruling, the callee gets a link and not a copy,
  and the link carries the schema of the place it names, the default
  included. A place whose declaration has a default therefore reads as
  that default, where nothing is stored, for every reader bound to it by
  reference, a reader whose own type declares no default included: the
  handler's `events.get()` returns `[]`. A write through the handle
  stores a value at the place, and every reader then reads that value.
  Where a chain of links leads to the place, the default is that of the
  link nearest the place whose schema declares one, and the reader's own
  default applies where no link declares one
  (`plan-and-label-templates.md`, §2.5, "A default belongs to the
  place", which also gives the label of such a read). A handle to a
  place where nothing is stored is handed to the body all the same
  (that document's §2.5, "A handle to a position that holds nothing").
  The rule does not reach a copy: a scalar that a binding made in a
  function body copies is copied as what the body read, which is the
  default ([§5.2](#52-runtime-calls), "What a binding holds").
- **A default on a type that names `undefined`.** The first two rows
  remove the `undefined` that the `?` adds. *Assumed:* an `undefined`
  that the value type itself names stays, so
  `glaze?: Default<string | undefined, "plain">` is read as
  `string | undefined` ([§13](#13-open-questions), question 34).
- **A parameter default is still refused**
  (`pattern-context:parameter-form`, §4.1). The default is declared in
  the type ([§12.7](#127-declare-defaults-in-types-not-in-the-parameter)).

**Today.** `PatternFunction` in `base/api/index.ts` types the body's
parameter as `Reactive<RequireDefaults<T>>`. `RequireDefaults` makes
required, and removes `undefined` from, each property of `T` whose type
carries the default brand, directly or as the value type of a cell
(`IsDefaultField`), and leaves every other property as declared. It maps
the properties of `T` and not those of a nested type. The caller's side
is `FactoryInput<StripCell<T>>`, which keeps each `?`. A handler's state
is typed `HandlerState<T>`, which applies no such mapping. At run time
an absent value takes its schema's default before it is validated
(`materializeSchemaView` in `runtime/runner/src/schema-view.ts`, through
`defaultForAbsentValue`), and a property declared as a cell is handed
to the body as a handle whether or not anything is stored
(`processDefaultValue` in `runtime/runner/src/schema.ts`). A read that
crosses a link continues under the reader's schema with one keyword
taken from the link: the default of the last link crossed whose schema
declares one (`combineSchemaForLink` in
`runtime/runner/src/traverse.ts`). A binding a pattern makes is written
as a link that holds the schema of the path it names
(`unwrapOneLevelAndBindToDoc` in `runtime/runner/src/pattern-binding.ts`,
with `includeSchema`). So the ruling is what the runtime does. The corpus
declares 506 optional properties that hold a handle, 255 of them with a
default (prototype). It uses a property of the first two rows without a
test at 503 receivers, of which 434 hold a handle and 69 a value, and
gives one to a callee that requires it in 223 arguments (prototype).

### 7.7 Casts

- `e as T` is allowed when the type of `e` and `T` are related: one is
  assignable to the other, ignoring annotations. It asserts the type and
  changes no value.
- `e as const` is allowed on literals.
- `e!` removes `null` and `undefined` from the type of the value. It
  does not change the type of the place `e` names, so an argument bound
  by reference to that place has the declared type
  ([§7.5.2](#752-arguments-bound-by-reference-in-tier-r)).
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

The two uses meet where a body receives a data position typed `unknown`.
The body is handed a reference there, whatever is stored behind it. It can
test the reference against `undefined`, compare it with `equals`, and pass
it on, and it cannot read through it. By ruling, the test against
`undefined` is the only test of such a position.

- **A test against `undefined`** (`=== undefined`, `!== undefined`, and
  `??`) returns whether something is stored at the position. A stored
  `0`, `""`, `false`, or `null` is something. A test of truthiness
  gives the same answer, since a reference is truthy, and tells the
  body nothing more.
- **A property read is refused.** `x.name` and `x?.name` both read the
  property `name` of a position typed `unknown`, and both are refused
  (`schema:unknown-type-access`), in every tier: the `?.` tests the
  receiver and then reads through it. The position is declared with a
  type that has the property.
- **A kind test narrows nothing.** `typeof`, `Array.isArray`,
  `instanceof`, and `"k" in x` see the reference and not the kind of
  what is stored behind it. A stored string and a stored record give
  the same result. After `typeof x === "string"` the position is still
  typed `unknown`, a string method on it is refused, and a property
  read after any such test is still `schema:unknown-type-access`. A
  body that needs the value declares the position with the type it
  reads.
- **A key of older data that code reads as a string is declared
  `string`,** and optional where it may be absent. A stored value of
  another type then reads as `undefined`, by the rule for stored data
  that does not match its declared type
  (`plan-and-label-templates.md`, §5.2), and the body tests the read
  against `undefined` and not with `typeof`.
- **A conversion to a string** (`String(x)`, a template literal) converts
  the reference. The string is a function of the reference alone and holds
  nothing of the content.

`footprint-analysis.md` (§2.2) records a test against `undefined`, of
truthiness, or of kind there as
an observation of the position's shape, and a conversion as an observation
of the reference's identity. That a kind test sees no more than presence is
how the runtime reads such a position today: it hands the body an empty
object that carries the address and nothing else (`createOpaqueReference`
in `runtime/runner/src/schema.ts`;
[`unknown`](../../common/concepts/types-and-schemas/unknown.md)). By
ruling it stays so. A value typed
`unknown` that the body computed, such as the result of `JSON.parse` or the
variable of a `catch` clause, is an ordinary value, and a kind test narrows
it (§7.6).

**Which expressions are data positions.** The checker decides it from
where the expression is rooted. An expression typed `unknown` is a data
position when it is reached, through property reads, element reads,
destructuring, and `const` bindings alone, from one of these roots:

- a parameter of the callback of a builder: the input of a `pattern`,
  the argument of a `lift`, the event and the state of a `handler`, and
  the event of an `action` or of an inline event handler;
- a parameter of a reactive collection callback;
- a binding of tier R, in tier R and in a function body that captures
  it; and
- the result of `get()` or `sample()` on a handle.

Every tier-R expression is therefore a data position, and a kind test
in a tier-R conditional never narrows `unknown`. An expression rooted
anywhere else is an ordinary value: the result of a call other than
`get()` and `sample()`, the result of an operator, `detail ?? fallback`
included, a local the body built, a `let`, and a parameter of an
authored function. A parameter of an
authored function may be handed a reference by a caller that passes on
a data position. Narrowing it is sound all the same: the only kind test
a reference passes is `typeof x === "object"`, which narrows to a type
with no property, and the branch of every other kind test does not run
for a reference. A type predicate is trusted for both
([§7.1](#71-types-the-checker-supports)).

A property read on an ordinary value typed `unknown` is an ordinary
type error (`subset-type:mismatch`), and its correction is a narrowing.

**A handle of `unknown`.** A handle of any type is assignable to the
same kind of handle of `unknown` ([§7.5.1](#751-handles)). Through a
`Cell<unknown>` a body can do the following. The write is the one part
that is open ([§13](#13-open-questions), question 29).

- **Walk.** `key(name)` takes any string and yields a `Cell<unknown>`.
- **Read.** `get()` returns a data position typed `unknown`: a
  reference, with the rules above.
- **Compare and pass on.** `equals`, `equalLinks`, and giving the handle
  to a callee, a binding, or a stored value.
- **Write.** `set(value)`, `update(partial)`, and the array writes take
  `unknown`, so the checker accepts any data value. The checker then
  does not keep the cell's other holders, which declare the type the
  cell has, from finding a value of another type. The stored-data rule
  does: a read of stored data that does not match the reader's declared
  type returns `undefined` where that type admits `undefined` or
  declares a default, and fails the reading cone otherwise
  (`plan-and-label-templates.md`, §5.2), and the checks on the write are
  those of the cell where it lands (its §3.11). The same holds for
  `send` through a `Stream<unknown>`.

The corpus uses `any` for a small number of things
([§11.3](#113-what-the-subset-refuses-in-the-corpus)). The subset supports
each of them explicitly instead.

| What `any` stands for today | Explicit form |
| --- | --- |
| A reference to some other piece, or a cell of unknown content (`cell: any`, `Writable<any>`) | `unknown` for the reference; `Cell<unknown>` for a handle, to which a cell of any type is assignable (above). `.key(name)` on a `Cell<unknown>` takes any string and yields a `Cell<unknown>`, so a helper can walk a path without knowing the shape |
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
| Function overloads | `subset-type:overload` | One signature with a union parameter, or two functions with different names. For the re-typing idiom, the rewrites of [§12.4](#124-replace-the-re-typing-overloads-with-declared-types) |
| `enum`, `namespace` | `subset-syntax:enum`, `subset-syntax:namespace` | A union of string literals with an `as const` object; a module |
| Class types, constructor types, abstract members, `this` types | `subset-type:class` | Object types and authored functions |
| Declaration merging, `declare global`, module augmentation | `subset-syntax:ambient-declaration` | One declaration per name (note below) |
| Call and construct signatures in object types, accessors in types | `subset-type:callable-object` | A function type, or a property of function type |
| `asserts x is T` | `subset-type:assertion-signature` | A type predicate and an `if` that throws |
| Variance annotations, `satisfies` on a type parameter, `const` type parameters | `subset-type:unsupported-modifier` | Omit the modifier |
| Index signatures keyed by `number`, `symbol`, or a template literal | `subset-type:index-signature-key` | An array, or a `string` key |
| A rest element of an array type in a tuple, `[string, ...number[]]` | `subset-type:tuple-rest` | An array type, or a tuple of fixed length. A spread of another tuple type is allowed |
| A function type anywhere in a type used as data (note below) | `subset-type:function-in-data` | A type that says what the value is: the cell type where the value is a cell, and the plain type where it is not. A stream for behavior a consumer triggers; an authored function for behavior the module owns |
| Decorators | `subset-syntax:decorator` | A builder call |

**A function type is the type of code and never of data.** A function
type, and an object type with a method signature or a function-typed
property, is a code type ([§1](#1-terms)). It is legal where a type
describes code: a parameter that is the callback of a builder or of a
collection method, the signature of an authored function, and the type of
a local of a function body. It is refused anywhere in a type used as data
(`subset-type:function-in-data`): a pattern's input or result type, the
value type of a cell or of any other handle, and a handler's state or
event type, at any depth and in any member of a union. Frozen data, the
accumulator of a `reduce`, and the signature of an imported function hold
no code type either, under identifiers of their own
(`module-scope:frozen-data-type`, `collection:reduce-accumulator`,
`import:signature-not-data`).

There is no exception for a type that describes a value probed for a
method. A property declared `Donut[] | { get?: () => Donut[] }`, for "a
list, or a cell of one", is refused. A declaration says whether a value is
a cell or is not: `Donut[]` where it is a list, and `Cell<Donut[]>` where
it is a cell.

**Declaration merging** is two declarations of one name that TypeScript
combines into one. The subset has one form of it left to refuse: a second
`interface` of a name, reported at the second declaration
(`subset-syntax:ambient-declaration`). Every other merge involves a
namespace, an enum, or a class, and is refused as that construct
(`subset-syntax:namespace`, `subset-syntax:enum`, `subset-type:class`,
`module-scope:class-declaration`). Two function declarations of one name
are overload signatures (`subset-type:overload`). A type and a value of
one name, such as `interface Donut` beside `const Donut = pattern(...)`,
do not merge and are allowed.

### 7.10 Type operators and references

The checker computes every type it accepts, when the type is written
(§7.3). No type is left without a value: a type the rules of this section
do not compute is refused, under the identifier of its feature (§7.9) or
under one named below.

**The native type operators.** Each is a rule of the checker, and not the
conditional or mapped type the TypeScript library declares it as. What
each does to annotations is in [§8.4](#84-composition).

| Operator | Operand | Result |
| --- | --- | --- |
| `Partial<T>`, `Required<T>` | `T` is an object type | `T` with every property optional, or with none optional |
| `Readonly<T>` | An object type, an array, a tuple, or a primitive | `T` with every property `readonly`; the read-only counterpart of an array or a tuple; a primitive unchanged |
| `Pick<T, K>`, `Omit<T, K>` | `T` is an object type. `K` is a string literal type or a union of them. For `Pick`, each names a property of `T` | `T` with the named properties alone, or without them |
| `Record<K, T>` | `K` is `string` or a union of string literals (§7.1) | An index signature, or an object type with one required property per literal |
| `Exclude<T, U>`, `Extract<T, U>` | Any types | The members of `T` that are not assignable to `U`, or that are. A `T` that is not a union is taken as a union of one member, and `boolean` as `true \| false`. Annotations are ignored in the test (§7.5). The result is the union of the members kept, and `never` when none is |
| `NonNullable<T>` | Any type | `T` without its `null` and `undefined` members |
| `ReturnType<F>` | A function type, `typeof` of an authored function or of a `lift` result, or a factory type | The function's result type; for a handler factory, the stream type; for a pattern factory, the pattern's result type, which is the type of the value an instantiation returns (§7.2) |
| `Parameters<F>` | A function type, `typeof` of an authored function or of a `lift` result, or a factory type | The tuple of the parameter types; for a factory, a tuple of one element: the input type of a pattern, or the state type of a handler (§7.2) |

An operand outside the middle column is refused
(`subset-type:operator-operand`). The checker has no deferred types, so
every operand is concrete when the operator is computed, inside a generic
function included (§7.3).

**The other utility types of the TypeScript library** are not part of the
subset: `Awaited`, `InstanceType`, `ConstructorParameters`,
`ThisParameterType`, `OmitThisParameter`, `ThisType`, `NoInfer`,
`Uppercase` and its three siblings, and any other. A reference to one is
refused as a name of the standard library that this document does not
list (`stdlib:unsupported-member`). The type of a global that
[§9.11](#911-other) lists as not typed, such as `Promise<T>`, is refused
as that global is (`function-body:unsupported-global`).

**Type arguments written at a call,** `first<Donut>(box)`, are computed as
any type is and take the place of the type parameters in order. Inference
(§7.3) fills in a parameter the call does not write. A type argument that
does not meet its parameter's constraint, and more type arguments than the
function declares, are ordinary type errors (`subset-type:mismatch`).

**A qualified name.** `ns.Donut`, where `ns` is bound by
`import * as ns from "..."`, is the type the module exports under that
name. `typeof a.b.c` is the type of the property at that path of the
binding `a`. The subset has no namespace and no enum, so no other
qualified name exists.

**Where a type comes from.** A type reference resolves to a declaration of
a module of the program ([§1](#1-terms)), a module reached through a
pinned `cf:` specifier included; to an API type (§7.2); or to a
standard-library type of §7.1. A type exported by a tier-I module is
computed by these rules when a subset module imports it, and is refused
where it uses a feature the subset refuses
(`import:signature-not-in-subset`, [§5.5](#55-imported-typescript-tier-i)).
A name that resolves to none of these is an ordinary type error
(`subset-type:mismatch`).

**The type names of the browser** are not types of the subset: `Event`,
`CustomEvent`, `KeyboardEvent`, `HTMLElement`, and every other name of
the DOM library. A name is one of them when it is a global type that
TypeScript's DOM library (`lib.dom.d.ts`) declares, and it resolves to
no declaration of the program, no API type, and no type of §7.1 or
[§9](#9-standard-library-surface). No DOM object reaches a pattern. An event arrives as
data, and a handler declares the shape of the part it reads:
`handler<{ detail: { value: string } }, State>` in place of
`handler<CustomEvent<{ value: string }>, State>`. A reference to such a
name is refused as a name of a library this document does not list
(`stdlib:unsupported-member`), with that correction in the message.
The corpus has four such references, in three modules (prototype;
[§11.3](#113-what-the-subset-refuses-in-the-corpus)).

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
| `TrustedActionWrite<...>`, `TrustedActionWriteWithIntegrity<...>` | `writeAuthorizedBy` and `uiContract`, as the contract defines |
| `TrustedActionUiContract<...>` | `uiContract` alone (§8.5, "The value of a writer policy") |
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
are refused (`subset-type:operator-operand`), except that `Readonly` of an
array or a tuple is its read-only counterpart and `Readonly` of a
primitive is that primitive
([§7.10](#710-type-operators-and-references)). `Record<K, T>` keeps the
annotations of `T` on
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
  `AnyOf<list>`, `PolicyOf<typeof rules>`, the marker type
  `CurrentPrincipal`, a reference to an alias whose body is an atom, or
  a constant reference `typeof NAME` whose value is an atom (below).
  `CurrentPrincipal` is the one marker type for an atom:
  `base/api/cfc.ts` declares no other.
- An alias, with parameters or without, may stand for a list or an atom.
  A label argument that is a reference to an alias is replaced by the
  alias's body, with the type arguments substituted, before anything else
  is decided about it, and so is a reference inside a list. Whether the
  argument is a list (`cfc-label:not-a-list`) and whether each atom is in
  this language (`cfc-label:not-static`) are decided on the result, and
  reported at the argument as written. So
  `Confidential<string, RecipeSecret>` with
  `type RecipeSecret = readonly ["recipe-secret"]` is the list written in
  place. The alias is declared in a module of the program or exported by
  `commonfabric`.
- `typeof name` means one of two things in a label argument, and its
  position decides which. Where a writer or a rule set is expected, it is
  a binding reference (next item): the second argument of
  `WriteAuthorizedBy`, the argument of `PolicyOf`, and the writer
  argument of `TrustedActionWrite` and `TrustedActionWriteWithIntegrity`,
  in a member of `WritePolicyAnyOf` as elsewhere. Everywhere else it is
  a **constant reference**, and stands for the value of a constant (the
  item after).
- A **binding reference** is `typeof name` at one of those positions.
  It denotes the declaration `name`
  resolves to, through imports and re-exports, and never that declaration's
  type. The validity conditions for the binding are the contract's
  (`cfc-write-authorized-by`, `cfc-policy-of`). Of the declarations the
  contract accepts as a writer, this language has two: a module-scope
  `handler(...)` definition and a function declaration. The contract's
  `module(...)` and `requireEventIntegrity(...)` bindings are not part of
  the surface (§3.2; `base/api/index.ts` exports neither).
- A **constant reference** is `typeof NAME` at any other position of a
  label argument: an element of a label list, a property of an object
  atom, an alternative of `AnyOf`, and the action and the pattern of a
  trusted-action alias. It is legal where `NAME` is a module-scope
  constant with a static
  initializer in the sense of [§8.8](#88-defaults-and-scopes), declared
  in the module or imported from another module of the program, and it
  stands for the value of that initializer, as `typeof NAME` does in a
  default. The value has to be what the position accepts: an atom, which
  is a string, a number, a boolean, `null`, or an object whose property
  values are atoms or arrays of atoms; and a string for an action or a
  pattern. So with `const LOBBY_ADMIN = "lobby-admin"`, the list
  `readonly [typeof LOBBY_ADMIN]` is `readonly ["lobby-admin"]`, and two
  constants with equal values name one atom. A constant whose
  initializer is not static, or whose value the position does not
  accept, is `cfc-label:not-static`. This is the meaning the reference
  has today: the lowering reads `typeof NAME` in a label argument as the
  value of the constant's initializer (`#readLiteralSyntax` in
  `base/schema-generator/src/formatters/common-fabric-formatter.ts`,
  through `extractLiteralValueOfSymbol` in
  `base/schema-generator/src/typescript/literal-value.ts`), and the
  action and the pattern of a trusted-action alias are read the same way
  (`readValue` in `#buildIfcMetadataForAlias`). The identity of the
  binding is not part of the atom there, and is not here.
- The argument of `PolicyOf` is a binding reference written in place,
  `PolicyOf<typeof rules>`, and nothing else: no alias stands for it. As
  the contract has it, `rules` is an exported module-scope constant
  initialized by `exchangeRules([...])`, declared in the module, imported
  directly from the module that declares it, or imported through a pinned
  `cf:` specifier. A binding reached through a re-export is refused for
  `PolicyOf`, although `WriteAuthorizedBy` follows one. Anything else is
  `cfc-policy-of`.
- The trusted-action aliases take, after the payload: for
  `TrustedActionWrite` and `TrustedActionWriteWithIntegrity`, a binding
  reference under the rules of `WriteAuthorizedBy`; then, for all three,
  the action and the pattern, each a string literal type, an alias
  whose body is one, or a constant reference whose value is a string;
  and last, where the alias has the parameter, the
  required integrity, a label list of strings with at least one
  element. An action or a pattern that is none of the three is
  `cfc-label:not-static`, and an integrity argument that is no list is
  `cfc-label:not-a-list`.
- The members of `WritePolicyAnyOf<T, [P, ...]>` are not a label list.
  The tuple is written in place, as the contract requires, and each member
  is a writer policy written directly or through an alias.

Anything else in a label argument is an error
(`cfc-label:not-static`): a union of literals, an array type, a conditional
or indexed type, an optional tuple element. A label argument that is no list
at all stays `cfc-label:not-a-list`.

**The value of a label argument.** The compiler reads a label argument
as data, in the order below, and the result is the **canonical form**:
the JSON value the schema holds under `ifc` and the plan holds in
`Slot.declared` and in a constraint
(`plan-and-label-templates.md` §1.5). Nothing of the argument's source
text is kept, so two arguments that evaluate to equal values declare one
label, however each was written.

1. **A reference to an alias** is replaced by the alias's body, with the
   type arguments substituted, wherever it stands: as the whole
   argument, as an element of a list, as a property of an object atom,
   as an alternative of `AnyOf`. The step is repeated until no reference
   to an alias is left. The alias may be declared in the module, in
   another module of the program, or exported by `commonfabric`.
2. **A constant reference `typeof NAME`** is replaced by the value of
   the constant's initializer.
3. **A spread `...L`** in a list is replaced by the elements of the
   list `L` evaluates to.
4. **The marker type** is replaced by the record the API declares it as.
   `CurrentPrincipal` is `{ "__ctCurrentPrincipal": true }`
   (`base/api/cfc.ts`). The marker is a term the runtime binds to the
   acting principal, so an atom that holds it is compared at run time
   alone (`plan-and-label-templates.md` §4.4).
5. **`AnyOf<list>`** is the clause `{ "anyOf": [...] }` with the atoms
   of the list.
6. **`PolicyOf<typeof rules>`** is the policy atom of the rule set the
   binding reference names, as the lowering forms it today
   (`#extractLiteralLikeValue` in
   `base/schema-generator/src/formatters/common-fabric-formatter.ts`).
   It holds the identity of the declaration and is bound at run time.
7. **A literal type** is its value, `null` is `null`, an object type
   literal is the record of its properties' values, and a tuple is the
   array of its elements' values.

**The value of a writer policy.** The aliases that name a writer are
read into the annotation keys as follows, and
`plan-and-label-templates.md` §1.5 forms the constraints from the keys.

- `WriteAuthorizedBy<T, typeof b>` is the key `writeAuthorizedBy` with
  the binding `b`.
- `TrustedActionWriteWithIntegrity<T, typeof b, A, P, I>` is
  `writeAuthorizedBy` with the binding `b`, and `uiContract` with the
  helper `UiAction`, the action `A`, the pattern `P` as
  `trustedPattern`, and the list `I` as `requiredEventIntegrity`.
- `TrustedActionWrite<T, typeof b, A, P>` is the same with the list
  `[P]`: the required event integrity is the pattern alone
  (`TrustedActionWrite` in `base/api/cfc.ts`).
- `TrustedActionUiContract<T, A, P, I>` is `uiContract` alone, with no
  `writeAuthorizedBy`. Where `I` is not written it is `[P]`.
- `WritePolicyAnyOf<T, [P, ...]>` is `writePolicyAnyOf` with one policy
  per member in order, each holding the `writeAuthorizedBy` and the
  `uiContract` the member gives by the items above.

`writeAuthorizedBy` and `writePolicyAnyOf` are two keys, so the rule of
§8.3 that one key is declared alike on a path does not relate them. A
path can combine a `writePolicyAnyOf` from one node and a
`writeAuthorizedBy` from a node below it, and a write there has to
satisfy both. One node that declares `writePolicyAnyOf` beside its own
`writeAuthorizedBy` or `uiContract` is refused by the runtime, as the
contract has it for `WritePolicyAnyOf`. This document names no
diagnostic for it.

The steps apply to the argument of every alias of §8.1 alike, to the
members of `Cfc<T, M>` included. A label annotation reached through an
alias of the payload, as `type Secret<T> = Confidential<T, L>` is, is
read after the generic alias is instantiated (§8.4), so the annotation
and its argument are found whichever alias the source names. An
argument that these steps do not reduce to a JSON value is
`cfc-label:not-static`: no slot declares a label from an argument the
compiler could not read.

### 8.6 Assignability

Annotations are not part of structural assignability. A `string` is
assignable to a position declared `Confidential<string, L>`, and the reverse
is also assignable: the type system does not police flows. Flows are checked
against label templates and declared constraints, by the rules of
`plan-and-label-templates.md`. This document only reserves the identifiers
those checks report under. There is one for each kind of constraint that
document's §4.4 can fail at compile time: `cfc-flow:required-integrity`,
`cfc-flow:max-confidentiality`, `cfc-flow:write-floor`,
`cfc-flow:writer-fit`, and `cfc-flow:write-policy`, for a writer the policy
does not name. A sixth, `cfc-flow:ui-contract`, is a warning: it reports a
handler whose policy requires a UI contract when no element of the pattern
that binds the handler sits under a surface that carries the contract's
pattern.

No alias of §8.1 is named for a write floor. *Assumed,* with
`plan-and-label-templates.md` (§8, question 15): the floor of a write
target is the `requiredIntegrity` annotation, written `RequiresIntegrity`,
on the path written. The target is that of a write edge of a body or of
expression code, or a kept output, where the annotation is in the result
type the pattern declares (`plan-and-label-templates.md` §1.5).

A cast cannot move a label. In `e as T`, annotations in `T` that differ from
those of the type of `e` have no effect, and writing them draws a warning
(`cfc-label:cast-ignored`) that says to declare the label on the cell, the
pattern input, or the pattern result instead.

#### 8.6.1 The published typings

The compiler does not read the declarations in `base/api/cfc.ts` (§7.2), but
an editor does: it runs the TypeScript compiler over the same source against
them. So that an editor reports nothing the pattern compiler accepts, the
published typings are identity aliases: each label alias is its payload
(`type Confidential<T, L> = T`), each scope wrapper likewise, and `AnyOf`
and `PolicyOf` keep a declaration only so that a label argument has a type
to name. The brand declarations `Cfc`, `CfcTag`, and `CfcStamp` are not
part of the published surface.

*Assumed:* the typings change when the transformer, which reads the
brands, is retired (the overview's last stage). When they are published
is a question for the project owner ([§13](#13-open-questions), question
16). While the brand typings are the published ones, rule 2 of §2 has one
exception: a generic function that returns its unconstrained parameter as
`Confidential<T, L>` is accepted by the subset and reported by the editor,
and `T extends {}` satisfies both.

The declaration of `key` is published with the type
[§4.7](#47-cell-and-handle-methods) gives it: a property declared as a
handle yields that handle. The declaration in `base/api/index.ts` today
wraps such a property in the outer handle (`IKeyable`), so `key("a")` on a
`Cell<{ a: Cell<T> }>` is a `Cell<Cell<T>>` to an editor. *Assumed:* the
declaration changes with the identity aliases (question 16). Until it
does, rule 2 of §2 has a second exception: a program that uses the
flattened type of such a `key` call is accepted by the subset and reported
by the editor.

The compiler's own diagnostics, such as read-only module data, a refused
type feature, or a tier-R statement rule, are reported when the source is
compiled. An editor does not show them while typing. A language-service
plugin that would is not part of this design.

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
| A function `<T>(v: T): Confidential<T, L>` does not type-check for unconstrained `T`, because the stamp is not assignable from `null` | Disappears in the subset, and in an editor once the typings are identity aliases (§8.6.1) |
| An optional property adds `undefined`, which readings from a type have to subtract before matching the payload | Disappears. `?` is a property modifier (§8.4) |
| A value typed with the brand needs a cast at a write: `cell.set(text as Confidential<string, L>)` | Disappears. Annotations are not part of assignability, and the cast is reported as redundant (`cfc-label:cast-ignored`) |
| A scope wrapper may not be a union member, so the shrink moves nullish members inside it (`moveNullishIntoScopeWrapper`) | Replaced by the scope rule of §8.8 |
| A `Default` whose value cannot be recovered from the node, the type, or the brand payload supplies no default (`schema-default:unresolved`, a warning) | Replaced by an error (`default:not-static`) |

### 8.8 Defaults and scopes

`Default<T, V>` adds a default-value annotation to `T`. A default is
static: `V` denotes a value the compiler takes from the source and does
not compute. `V` has one of two forms.

- **A literal-like type:** a literal, a tuple or object literal type of
  literal-like types, or `Record<string, never>` for the empty object.
- **`typeof NAME`,** where `NAME` is a module-scope constant that is
  frozen data ([§3.2](#32-initializer-kinds)), declared in the module or
  imported from another module of the program. Here `typeof` names the
  binding and not its type, as a constant reference does in a label
  argument ([§8.5](#85-label-arguments)), and the default is the value
  of the constant's initializer, whatever type the constant is annotated
  with.
  `const EMPTY: Viewer = {}` gives the default `{}`, although the type of
  `EMPTY` is `Viewer`, which is not literal-like. The initializer has to
  be a static initializer: a literal, a numeric literal with a sign
  included; an array literal or an object literal with static keys whose
  elements and property values are static initializers; a reference to
  another module-scope constant whose initializer is static; and any of
  these in parentheses or under `as const`, `as T`, or `satisfies T`.

The value must be assignable to `T`. Anything else is refused
(`default:not-static`). In particular a default named by `typeof` of a
constant whose initializer is a call or a `new` expression is refused, as
in `const INITIAL_SHOTS = createInitialShots()`: the author writes the
value as a literal. *Assumed* ([§13](#13-open-questions), question 25):
an initializer with a spread, an operator, or a template literal with a
substitution is refused too, and so is `typeof NAME.path`, which names a
part of a constant.

Two extensions are wanted and are not designed: a default whose value the
compiler can compute, and a default that is a link to another value.

`T | Default<V>` and `DeepDefault<V>` follow the schema mapping's §7.

A scope wrapper adds a scope annotation. A scope annotation is valid at the
root of a cell's value type, at the root of a pattern input property, at the
root of a type given to a cell constructor, and around `SqliteDb` in the
declared type of a `sqliteDatabase` declaration (§4.7). On a union member it
is valid only when every other member is `null` or `undefined`, and it then
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
`filter`, `flatMap`, `some`, `every`, `find`, `findIndex`, `reduce`.

F only, because they take a function: `findLast`†, `findLastIndex`†,
`forEach`, `reduceRight`†, `toSorted` with a comparator.

F only, because they mutate: `fill`, `pop`, `push`, `reverse`, `shift`†,
`sort`, `splice`, `unshift`†. On a read-only array type these are type
errors.

Static: `Array.isArray` (R), `Array.from` (R with one argument; F with a
mapping function), `Array.of`† (R), `new Array(n)` (F).

### 9.3 Object

R: `Object.keys`, `Object.values`, `Object.entries`, `Object.fromEntries`,
`Object.hasOwn`.

F only: `Object.assign`†, `Object.freeze`†, `Object.getPrototypeOf`,
`Object.prototype`, `Object.create(null)`. The last three are typed
narrowly, for the test that a value is a plain object and for a record
without a prototype. `Object.getPrototypeOf(x)` has type `object | null`.
`Object.prototype` has type `object` and is legal only as an operand of
`===` or `!==`, which is how the test is written:
`Object.getPrototypeOf(x) === Object.prototype`. Reading a member of it,
passing it to a function, or writing to it is refused
(`stdlib:unsupported-member`; a write is `function-body:global-write`).
`Object.create` accepts only `null`.

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
Anywhere else, tier R included, the call is refused as
`function-body:ambient-read`.

### 9.6 Date

R: `Date.parse`, `Date.UTC`; on a `Date` value: `getDate`, `getDay`,
`getFullYear`, `getHours`, `getMinutes`, `getMonth`, `getSeconds`,
`getTime`, `getUTCDate`, the other `getUTC*` readers†, `toISOString`,
`toLocaleDateString`, `toLocaleString`, `toLocaleTimeString`, `valueOf`†.

F only: `new Date(value)` and `new Date(year, month, ...)`; the mutators
`setDate`, `setMonth`†, `setFullYear`†, `setHours`†, `setMinutes`†,
`setTime`†; and, where an ambient read is allowed (§5.1), `Date.now()` and
`new Date()`. Anywhere else, tier R included, those two are refused as
`function-body:ambient-read`.

`Date` is a code type. A `Date` cannot appear in a tier-R expression except
as the receiver of an R member, which in practice means inside a `computed`
that is then not promoted because of the `new`.

### 9.7 JSON

R: `JSON.stringify` with one argument, or with an indent. F only:
`JSON.parse`, whose result has type `unknown`, and `JSON.stringify` with a
replacer.

`JSON.stringify(x)` reads `x` in full (`footprint-analysis.md` §5.2, cause
W2).

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
`Object.defineProperty` and the other reflective `Object` members. A
reference to one of the globals of this list is reported as
`function-body:unsupported-global`, in every tier. A member of a listed
namespace that this section does not list, such as
`Object.defineProperty`, and a global that this section names nowhere,
such as `navigator`, are reported as `stdlib:unsupported-member`, whether
the global is read, called, or constructed.
`builtin-inventory.md` ("The refused globals") says what stands in for
each of the first four. The fetch family replaces `fetch`. The clock of
`wish`, a structural built-in, replaces a timer. `Promise` has no
counterpart: a function body is synchronous, and the result of an effect
is read as the fields `pending`, `result`, and `error` of the built-in's
result. `structuredClone` has none either: a copy is written with spread,
or built field by field.

## 10. Diagnostics catalog

Severity is **error** (the program is refused), **warning** (accepted, and
the report is shown by default), or **hint** (accepted, shown on request).
Under the stored-source option of the current pipeline
(`TransformationOptions.storedSource`), some authoring-shape errors are
demoted to warnings so that already-deployed source reloads. In this
design a space is switched to the compiled path as a whole
(`execution-and-storage.md`, §9): the switch compiles the stored source of
every instance of the space, and no space holds instances of both paths.
*Assumed,* with that document's question 70: a space that holds an
instance whose source is refused is not switched. The catalog gives
authoring severities, and this document assumes the same severities for
stored source ([§13](#13-open-questions), question 7).

"Status" compares with the diagnostics of
`ts_transformers_current_behavior_spec.md` §6 and the unsupported rows of
[`ts_transformers_target_pattern_language_spec.md`](../ts-transformer/ts_transformers_target_pattern_language_spec.md)
§4: **carries** (same identifier and condition), **changes** (same
identifier, different condition or severity), **new**, or **retired** (the
identifier is not reported).

Message texts are normative in content, not in wording: each must name the
construct found and the replacement given here.

**What a diagnostic is computed from.** Thirteen diagnostics of the catalog
need a result of a stage after the type checker. The table names, for
each, the first result that suffices. Every other diagnostic is decided
from the source, its types, and the calls between its functions.

| Diagnostic | Computed from |
| --- | --- |
| `footprint:widened`, `footprint:dynamic-read`, `footprint:materializer`, `side-write:not-idempotent`, `mergeable-push:read-then-push` (§10.3) | The footprint analysis of one body, with the summaries of the authored functions it calls (`footprint-analysis.md` §5.3, §7.2, §6.3, §6.6, §6.4). No other body and nothing of the plan |
| `binding:write-to-computed` (§10.2) | The write edges and write envelopes of the callee's record (`footprint-analysis.md` §6.2), and what the bound path resolves to in the enclosing plan: an output whose template passes no reference on (`plan-and-label-templates.md` §3.11) |
| `side-write:cycle` (§10.3) | `Plan.edges`, the edges between the cones of an instance, which are built from the write edges of every body and the slots of every cone (`plan-and-label-templates.md` §3.11) |
| `cfc-flow:max-confidentiality`, `cfc-flow:required-integrity`, `cfc-flow:write-policy`, `cfc-flow:write-floor`, `cfc-flow:writer-fit`, `cfc-flow:ui-contract` (§10.5) | The label templates of the plan and the declared labels of their slots (`plan-and-label-templates.md` §4.4) |

A compiler that stops after footprint analysis reports the first five and
none of the other eight.

### 10.1 Module scope

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `module-scope:let-declaration` | error | `let` at module scope, exported or not | Use `const`. For a value that changes, create a cell in a pattern (`new Writable<T>(initial)`). For imperative code that needs `let`, move it into a function | carries |
| `module-scope:var-declaration` | error | `var` at module scope | The same | carries |
| `module-scope:class-declaration` | error | A class declaration or class expression at module scope | Use an object type and authored functions that take the value as a parameter | new (the verifier's load-time refusal becomes a compile diagnostic) |
| `module-scope:statement` | error | An expression statement, control flow, a block, or top-level `await` at module scope; also a `using` declaration, `export = name`, `export as namespace name`, and any other statement the table of §3.1 does not list and no other entry names | Move the code into a function. To compute a constant once, write `const NAME = compute()` and let the result be frozen | new |
| `module-scope:frozen-data-type` | error | A frozen-data constant whose type contains a function, a handle type (a cell, a stream, a SQLite handle, a collection index handle), a `Date`, an `Error`, or another code type other than `ReadonlyMap`, `ReadonlySet`, and `RegExp`. A `lift(...)` call written inside a frozen-data expression is such a function (§3.2); a `pattern(...)` or `handler(...)` call written there is a builder definition and is not reported | Declare the function directly (`const f = (...) => ...`), or build the value inside the function that uses it. Bind a `lift` to a `const` of its own and call it by name | new |
| `module-scope:frozen-data-write` | error | A write through a module-scope constant or an import: member assignment, `delete`, `++`, or a mutating method | Copy first (`[...NAME]`, `{ ...NAME }`, `new Map(NAME)`) and change the copy, or keep the state in a cell | new |
| `module-scope:stateful-regexp` | error | A regular expression with the `g` or `y` flag held at module scope | Remove the flag and use `replaceAll` or `matchAll`, or create the expression inside the function that uses it | new |
| `module-scope:import-form` | error | An import with no bindings, `import "..."` and `import type {} from "..."` alike; `import name = require("...")`; or a specifier that is not `commonfabric`, `commonfabric/<name>`, relative, or `cf:` | Import a named binding, or delete an import that binds nothing. External packages are not available to patterns | new |
| `module-scope:runtime-call` | error | A frozen-data initializer makes one of the runtime calls of §5.2 (it instantiates a pattern, creates a cell, requests an effectful built-in, reads context, or binds a handler) or calls `computed`, `action`, or `assert`, directly or through an authored function it calls (§3.2). A call whose callee does not resolve to a definition is classified by the callee's type, so a call of a factory value held in a module-scope constant is reported. A read of the clock or of entropy there is `function-body:ambient-read` | Move the call into a pattern body or a function body. Module scope has no instance to own what the call creates and no event to read | new |
| `builder-callback:indirect-reference` | error | The callback of `lift` or `handler` is neither a function written at the call nor a name bound to a function in the same module. The callback of `pattern`, `computed`, `action`, or `assert` is not a function written at the call, a name bound to a function in the same module included (§3.2, §4.1). Also, for every builder, a generator, or a declaration without a body | Write the function at the call. For `lift` and `handler` it may also be bound in this module (`const save = (event, state) => ...; handler(save)`) | changes (a name is refused as the callback of `pattern`, `computed`, `action`, and `assert`) |
| `cell-factory:empty-array` | error | A cell constructor called with `[]` and no type argument | Write the element type: `new Writable<Donut[]>([])` | carries |

### 10.2 Reactive tier

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `pattern-context:let-declaration`, `pattern-context:var-declaration` | error | `let` or `var` in a tier-R body | Use `const`. For a value computed with reassignment, write `computed(() => { let x = ...; ...; return x; })` | carries |
| `pattern-context:assignment` | error | Assignment, compound assignment, `++`, `--`, or `delete` in tier R | Move the write into an `action(() => ...)` or a `handler` | carries (now also covers `++`, `--`, `delete`) |
| `wish:computed-query` | hint | A `wish` whose `query`, or whose `path` with the key `#now` or `#profile`, is not a constant (`plan-and-label-templates.md` §3.19). The plan then holds the records of every kind of target: the user scope, the state cell of the one-shot clock, and a child for each sidecar. *Assumed,* with that document's question 48 | Write the query as a literal or a module-scope constant, so that the plan holds the records of that target alone | new |
| `pattern-context:loop` | error | A loop in tier R | Use `map`, `filter`, or `flatMap` on the collection, or move the loop into `computed(() => ...)` | carries |
| `pattern-context:early-return` | error | A `return` that is not the last statement, or a second `return` | Write one `return` and select with `c ? a : b` | carries |
| `pattern-context:missing-return` | error | The block body of a pattern callback or of a reactive collection callback ends in `return;`, or has no `return` statement (§4.2) | End the body with `return` and the value: the pattern's result, or the value the callback gives for the element | new |
| `pattern-context:control-flow` | error | `if`, `switch`, `try`, `throw`, or a labeled statement in tier R | Use `c ? a : b` for a choice of values. Move anything else into `computed(() => ...)` | new (the transformer reports some of these as `pattern-context:computation`) |
| `pattern-context:statement` | error | An expression statement that is not a recorded call (§4.2), including `cell.get();`, `void x;`, `console.log(x);`, and a handler applied to its state. The statement is reported once: the expression in it is not also reported as `reactive:unsupported-call` or `reactive:unsupported-expression`. A statement that is a call `cell:method-tier` covers, such as `count.set(1);`, is reported under that entry and not here | Bind the value with `const`, or delete the statement. To run code for its writes, use `computed(() => { ... })` as a statement | changes (replaces the statement-position case of `pattern-context:get-call`) |
| `pattern-context:function-creation` | error | A function or class created in tier R outside the callback positions of §4.4 and §4.5 | Declare the function at module scope and call it, or wrap the computation in `computed(() => ...)` | carries |
| `pattern-context:object-member` | error | A method, getter, setter, or function-valued property in an object literal in tier R | Return data. For behavior, return a stream made by `action` or a bound `handler` | carries |
| `pattern-context:parameter-form` | error | In the pattern parameter, at any depth of its destructuring (§4.1): a default value, a rest element, a key that is not static, or an array pattern. Also a parameter that is neither an identifier nor an object pattern. A nested object pattern is not reported | Declare the default in the input type (`glaze: Default<string, "plain">`). Read remaining properties from the undestructured parameter. Destructure a tuple in a `const` of the body | new |
| `pattern-context:builder-placement` | error | `lift(...)` or `handler(...)` called in tier R | Define it at module scope, or use `computed(() => ...)` for an immediate `lift(fn)(args)` and `action(() => ...)` for a handler that needs no separate state | carries |
| `pattern-context:callback-container` | error | An arrow function passed to a method or function that §4.4 does not give a callback position (`forEach`, `toSorted`, `findLast`, `replace`, `then`) | Wrap the whole expression: `computed(() => xs.toSorted((a, b) => a.price - b.price))` | changes (now covers every non-structural callback, in every tier-R site, not only JSX) |
| `reactive:unsupported-call` | error | A call in tier R whose callee matches no row of §4.4, such as a method the standard-library table does not mark "R". Where the callee does not resolve to a definition, the row is decided by its type, so a call of a value of a factory type is not reported (§4.4). An ambient read, a removed form, and a staged change are not reported here: they are `function-body:ambient-read`, the `removed-form:` entries, and `function-body:effect-in-computation`. Neither is a call that is an expression statement (`pattern-context:statement`) | Wrap the expression in `computed(() => ...)`, or call an authored function that does the work | new (replaces `pattern-context:receiver-method-call`, `pattern-context:inline-reactive-root-access`, `reactive:call-argument-computation`) |
| `reactive:unsupported-expression` | error | `new` of a non-cell constructor other than `new Date()` with no argument (which is `function-body:ambient-read`), `await`, `yield`, `this`, `instanceof`, a tagged template whose tag is not `debugStr` (§4.4.4), `void`, or the comma operator in tier R. Also an object literal with a computed key that is not static (§4.3), and a default value or a rest element in a `const` destructuring whose initializer is not a constant expression (§4.2). An expression that is an expression statement, such as `void x;`, is `pattern-context:statement` and is not reported here | Wrap the expression in `computed(() => ...)`. For a default in a destructuring, write it as an expression: `const glaze = donut.glaze ?? "plain"` | new (replaces the remaining cases of `pattern-context:computation`) |
| `opaque-get:invalid-call` | error | `.get()` on a value of a data type that is not `Cell`, `Writable`, or `ReadonlyCell`, a `Stream` included: to test that a stream is stored, read the position through a view typed `unknown` ([§12.9](#129-test-that-a-stream-is-present-through-a-view-typed-unknown)). A call of a `get` method that the value's own type declares, as on a `Map` or on a local object typed `{ get(): T }`, is an ordinary method call and is not reported (§4.4) | Read the value directly: `donut.name`, not `donut.get().name`. Only `Cell<T>`, `Writable<T>`, and `ReadonlyCell<T>` are read with `.get()` | carries |
| `pattern-context:self-access` | error | `x[SELF]` where `x` is not the pattern's own input parameter, or anywhere in tier F | Read `const self = input[SELF]` in the pattern body, or destructure `[SELF]: self`, and capture `self` | carries |
| `ses-callback:callable-capture` | error | A tier-F body inside tier R captures a function value from an enclosing function scope. In a function body: the state of a handler binding, in either spelling of §5.2, or an inline `pattern(...)` used as a callee (§4.4.2) holds or captures a function value or a value of another code type, such as a `Map`, a `Set`, a `Date`, or an `Error` | Move the function to module scope. For a value of another code type, capture data, such as an array of entries or a timestamp, and build the value inside the body that uses it | changes (now also covers a handler binding and an inline pattern in a function body, and a code type other than a function) |
| `removed-form:helper` | warning | A direct call of `ifElse`, `when`, or `unless`, or a `str` tagged template, in tier R (§4.4.3). An error once the builder form is retired | The rewrite: `c ? a : b` for `ifElse(c, a, b)`, `c && v` for `when(c, v)`, `c \|\| f` for `unless(c, f)`, a plain template literal for `str` | new |
| `removed-form:helper-unsupported` | error | One of those four in any other form: with schema arguments, passed as a value, or through an alias. Also one of the four, in any form, in a function body or at module scope (§4.4.3) | The same rewrite. In a function body the operator is ordinary JavaScript | new |
| `removed-form:pattern-tool` | error | A call of `patternTool` | Write an inline `pattern(...)` that captures the bound values, and pass it as the tool (§4.4.3) | new (replaces `pattern-context:patterntool-requires-pattern`, which is retired) |
| `removed-form:builtin` | error | A call, in any tier, of `llm`, `streamData`, `cell`, `byRef`, `nameInstance`, or a `...WithPattern` method (§4.4.3) | The replacement for the form found: `generateText` or `generateObject` for `llm`; a built-in of the fetch family for `streamData`; `Cell.of(value)` for `cell(value)`; the built-in imported by name for `byRef`; a `const` binding of the instance for `nameInstance`; the method without the suffix, with a callback written at the call, for a `...WithPattern` method | new |
| `collection:callback-parameters` | error | A reactive collection callback that is not an arrow function written at the call, a function passed by name included (`xs.filter(Boolean)`, `xs.map(toRow)`); that takes the whole array as a parameter; or that has a default value or a rest element on a parameter or inside a parameter's destructuring pattern (§4.4.1). A parameter that is an object pattern or an array pattern is not reported | Write the arrow at the call, with the element and at most the index: `xs.filter((x) => Boolean(x))`. Capture the array by name if the body needs it. Write a default as an expression in the body | new |
| `collection:reduce-callback` | error | A `reduce` in tier R whose callback has a block body | Write the step as one expression, `(sum, donut) => sum + donut.price`. A step that needs statements is a loop inside `computed(() => ...)` | new |
| `collection:reduce-initial` | error | A `reduce` in tier R without an initial value | Pass the initial value as the second argument | new |
| `collection:reduce-accumulator` | error | A `reduce` in tier R whose accumulator type is a code type, such as a `Map`, a `Set`, or a function | Accumulate into an object, an array, or a primitive. To fold into a `Map`, write the loop inside `computed(() => ...)` and return data | new |
| `collection:index-keyed` | hint | A per-element callback uses its index parameter, so its element cones are keyed by position and recompute when elements move (§4.4.1) | Drop the index if the element can supply what it was used for, such as a stable identifier in place of `key={index}` | new |
| `cell:unsupported-method` | error | A method of the runtime's cell object that the API does not declare (§4.7), such as `asSchema` or `getAsNormalizedFullLink`; also `setSchema`, which the API declares as deprecated. In every tier | The declared method that does the job, or a declared type in place of a re-typing ([§12.4](#124-replace-the-re-typing-overloads-with-declared-types)) | new |
| `cell:collection-method-in-function` | error | `map`, `filter`, or another collection method of §4.7 called on a cell handle in tier F. The compiler does not rewrite the call | One of two corrections. To keep the result reactive, wrap the expression in an inline `pattern(...)` and instantiate it: `pattern(() => cell.map(...))({})`. To process the values the cell holds when the body runs, read first: `cell.get().map(...)`. For an aggregate or an index method (`count`, `sum`, `min`, `max`, `minBy`, `maxBy`, `groupBy`, `keyBy`), which a JavaScript array does not have, the second correction is `get()` followed by a loop or a JavaScript `reduce` | new |
| `cell:cause-not-literal` | error | In tier R, the argument of `X.for(cause)` on a cell constructor, or of `h.for(cause)` on a handle, is not a string literal (§4.7) | Write a string literal, which names the cell in place of the variable's name: `Writable.for<number>("count")`. For a cell per element, declare the cell in the body of the collection callback, where the element's key is part of its identifier. A cause computed from data is legal only in a function body | new |
| `cell:method-tier` | error | A method, a constructor form, or a declaration of §4.7 called in a tier its "Tiers" column leaves out, where no other entry covers the case. In tier R: a write (`set`, `update`, `push`, `pushAll`, `addUnique`, `remove`, `removeByValue`, `removeAll`, `increment`, `applyChanges`, `send`, `exec`), `sample()`, `getArgumentCell()`, or `.for(cause)` on an instantiation. In tier F: `sqliteDatabase(...)`. It is reported in place of `reactive:unsupported-call` and `pattern-context:statement`. Not reported here: a collection method in tier F (`cell:collection-method-in-function`), `query` in a `lift` or a `computed` (`function-body:effect-in-computation`), and a cause in tier R that is not a string literal (`cell:cause-not-literal`) | For a write: move it into an `action(() => ...)` or a `handler`. For `sample()`: read with `get()`, or move the read into `computed(() => ...)`. For `getArgumentCell()`: call it in a function body. For `.for(cause)` on an instantiation: bind the instance to a `const`, whose name identifies it. For `sqliteDatabase`: declare the database in the pattern body and give the handle to the function body | new |
| `sqlite:tables-not-static` | error | The `tables` option of a `sqliteDatabase` declaration is not static in the sense of §4.7: it is not an object literal with static keys, a value is not a `table(...)` call written in place or bound to a `const`, an argument of a `table` call is not a constant expression, or a row-label rule has a block body or refers to something other than its parameter, constant expressions, and the `cfSqlite` helpers | Write the table declarations from literals and constants. Data that varies belongs in the rows of a table, not in its declaration | new |
| `binding:write-to-computed` | error | In tier R, an argument path or a state path is bound where the callee declares a handle that can write, the callee's record has a write edge or a write envelope through that handle, and the path holds a value the instance produces and can hold no reference: the result of an operator, of a template literal, or of a standard-library call, a literal, a member of a record or an array assembled in place, or a result path of a `computed` or a `lift` at which the body returns a value it computed (§7.5.2; `plan-and-label-templates.md` §3.11; `footprint-analysis.md` §6.2). A literal in the argument of a pattern called in tier R is covered, whether the pattern gets a plan of its own or is compiled into the caller, and whether the write is in the pattern's body, in a handler it binds, or in a pattern it calls in turn with the same path: `Counter({ value: 10 })` is reported where `Counter` binds `value` to a handler that increments it (`plan-and-label-templates.md` §3.15). A property that the argument leaves out is not a literal and is not reported. Not reported where the path can hold a reference on some evaluation, such as an element a `filter` passes on, a value a body returns unchanged, or a conditional with such an operand: the runtime decides those per write. Not reported for an argument that a function body gives to a pattern it instantiates. Not reported where the callee declares a handle that can write and only reads through it: the binding is legal and no write is refused (*assumed,* [§13](#13-open-questions), question 39). **Position.** *Assumed* ([§13](#13-open-questions), question 40): the report is at the expression of the module being compiled that supplies the produced value, which is the property of the argument or the attribute of the tag at the outermost call that the value passes through, and the message names the binding that writes, by file and line, where that binding is inside a pattern compiled in. *Assumed:* the severity, since the ruling says that the compiler reports the case and the write is refused at run time in every case reported | Bind a state cell, an input, or an element of a stored collection, and derive the computed value from it. For a literal, create a state cell that holds it and give the cell: `const start = new Writable(10)` and `Counter({ value: start })`. Where the callee only reads, declare the property as a value or as a `ReadonlyCell` | new |
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
| `function-body:unsupported-global` | error | A reference, in any tier, to a global §9.11 lists as not typed. A global that §9 names nowhere is `stdlib:unsupported-member` | The built-in named in the message, where one replaces it; otherwise remove the use | new |
| `function-body:global-write` | error | A write to a global or to a member of one | Keep the state in a cell | new |
| `function-body:constructor` | error | `new` in tier F, or in a frozen-data initializer at module scope (§3.2), whose callee is not a global: an authored function, a local value, a parameter, a member of one of those, or an import that is neither a cell constructor nor a Fabric value class (§5.1). `new` of a global is not reported here: a constructor of §9 is legal, and any other global is `function-body:unsupported-global`, `stdlib:unsupported-member`, or, for `Function`, `function-body:dynamic-code` | Call the function without `new`. A function that builds a value returns it | new |
| `function-body:ambient-read` | error | `Date.now()`, `new Date()` without arguments, or `Math.random()` in a `lift`, a `computed`, an `assert`, tier R, or a frozen-data initializer at module scope (§3.2), directly or through an authored function they call | Read the clock in a `handler` or `action` and store the value in a cell, or take the time as an input | new (the sandbox gate refuses the same read at run time) |
| `function-body:builder-call` | error | `pattern`, `lift`, `handler`, `computed`, `assert`, or `multiUserTest` called in tier F, other than an inline `pattern(...)` as the callee of an instantiation. `computed`, `action`, or `assert` called at module scope is `module-scope:runtime-call` | Define the builder at module scope and call its result. A function body that needs a reactive value instantiates a pattern | new |
| `function-body:handler-capture` | error | An inline event handler, an `action`, or an inline `pattern(...)` used as a callee (§4.4.2), written in tier F, captures a `let` binding | Assign the value to a `const` before the handler or the pattern and capture that | new |
| `function-body:cell-needs-cause` | error | A cell created without an explicit cause in a `lift`, a `computed`, an `assert`, or an authored function that one of them or tier R calls (§5.2) | Name it: `Writable.for<T>(cause)`, with a cause that is the same on every evaluation | new (a run-time throw today) |
| `function-body:effect-in-computation` | error | An effectful built-in requested in a `lift`, a `computed`, or an `assert`, directly or through an authored function that one of them or tier R calls (§5.2). `query` on a SQLite handle is such a request (§4.7). An effect in the body of a pattern the computation instantiates is not reported. Also a staged change (`grantSpaceAccess`, `revokeSpaceAccess`, `nameBlob`) requested in tier R, directly or through an authored function tier R calls: only a `handler`, an `action`, or an inline event handler requests one (§4.4, §5.2) | Write the effect in a pattern, inline or named, and instantiate the pattern in the computation: `PriceQuote({ url: priceUrl(order) })`, where the body of `PriceQuote` calls `fetchJson`. Or request the effect in the pattern body, with the computed value as its input: `const price = computed(...); const quote = fetchJson({ url: priceUrl(price) });`. For a staged change, in a computation or in tier R: request it in a `handler` or an `action` | new |
| `function-body:event-context-in-computation` | error | `eventKey()` or `currentPrincipal()` in a `lift`, a `computed`, an `assert`, or the pattern body, directly or through an authored function they call | Read it in the `handler` or `action` and pass or store the value | new (a run-time throw today) |
| `function-body:wish` | error | A call of `wish` in tier F: in a `handler`, an `action`, an inline event handler, a `lift`, a `computed`, an `assert`, or an authored function, whatever calls it (§5.2). `wish` is a structural built-in of tier R, and a function body has no record for one. *Assumed* (§5.2) | Call `wish` in the pattern body and read its result in the function body: `const profile = wish({ query: "#profile" });`. Where the query depends on a value the body computes, call it in the body of a pattern the function body instantiates | new |
| `collection:shared-element-state` | error | The body of a per-element construct over a collection of plain values (§4.4.1) declares a state cell without using the index parameter, so elements with equal values would share the cell. A module-scope constant is such a collection whether the module declares it or imports it. A body that binds a handler and declares no state cell is not reported: equal elements bind equal state and share one stream. *Assumed* (§4.4.1): neither is a state cell in a body that instantiates a child, whose key holds the position. A state cell that a statically resolved pattern called in the body declares is a state cell of the body | Declare the index parameter and use it in the body, which puts the position in the element's key. Or make the elements cells: keep the list in a cell that a handler writes records into | new |
| `function-body:instantiation-without-cause` | warning | A pattern instantiation without `.for(cause)` inside a loop, or inside a function written in the body, such as the callback of a JavaScript `map`, in a `lift`, a `computed`, an `assert`, or an authored function that one of them or tier R calls (§5.2). The instances of such a site are named by the order in which an evaluation makes them. Not reported in a `handler`, an `action`, or an inline event handler, and not for the callback of an inline `pattern(...)`, which is a tier-R body | Give each instance a cause taken from the record it belongs to: `PriceQuote({ url }).for(order.id)`. Without one, removing or inserting a record gives each later instance the argument of another record. Leave the site as it is where the list only grows at its end | new |
| `verb-result:undeclared-return` | error | A `handler` or `action` without a result type argument returns a plain value from a block body | Declare the result (`action<Event, Result>(...)`, `handler<Event, State, Result>(...)`), or use a bare `return;` | carries |
| `mergeable-push:read-then-push` | warning | A `handler`, an `action`, or an inline event handler reads a mergeable collection through a cell handle and then appends to it through the same handle, with `push` or `pushAll`. `addUnique` is not reported: it is the merge-safe operation the message names. A `lift` or a `computed` is not reported here: an append in one is `side-write:not-idempotent`. A read or an append in an authored function the body calls counts as the body's (`footprint-analysis.md` §3.6, §6.4). *Assumed* ([§13](#13-open-questions), question 36): which reads count, and whether the append has to depend on the read | Push without reading, or use the merge-safe operation the message names: `addUnique` on the element found with `elementById` for a uniqueness condition, a `set` of the whole value for another append that depends on the content | carries |
| `footprint:widened` | hint | Footprint analysis gave up on an expression, for one of the causes of `footprint-analysis.md` §5.2 (§5.4). The report names what the widening covers: the input paths of the widened entries, which are several for a key that is not static, or the cell handle the analysis lost track of | The rewrite for the cause, as that document's §5.3 gives it: named properties in place of a key that is not static, the properties that are needed in place of a whole value that is converted, compared with `valueEqual`, rendered by a debug formatter, or passed to an imported function, a copy in place of an update of an input | new |
| `footprint:dynamic-read` | hint | A read through a cell handle in a function body fails one of the three conditions of `footprint-analysis.md` §7.2, so it is journaled when the body runs and is no static entry of the footprint: the handle is one of several alternatives, the path below it is not static, or the `get()` or `sample()` is conditional | The condition that failed and the static form where one exists: read through one handle in place of a choice between two, use a static key, or move the `get()` ahead of the branch when every path reads the cell | new |
| `footprint:materializer` | hint | A `lift` or a `computed` has a side-write whose target is dynamic or too broad to predict (`footprint-analysis.md` §6.2), so the body is a materializer for all of its writes (its §6.3) | The write and why its target is not static. Write through a handle the body is given, at a static path (`counts.key("glazed").set(n)`), or move the write into a `handler` or an `action` | new |
| `side-write:not-idempotent` | warning | A `lift` or a `computed` contains one of the three shapes of `footprint-analysis.md` §6.6. Two write something else on a second run whatever the data: `push`, `pushAll`, or `increment`; and `send` on a stream. The third does so unless the write settles: a read of a path at or below one the body writes, through the same anchored handle | For an append or an increment, `set` the whole value computed from the inputs, or use `addUnique`. For a send, move it into a `handler` or an `action`. For a read of its own target, compute the value from other inputs, or move the update into a `handler` or an `action` (`count.set(count.get() + 1)` belongs there); a write that leaves a settled value unchanged (`name.set(name.get().trim())`) writes the same on the second run and can stay | new (the idempotency validator checks the same contract at run time) |
| `side-write:cycle` | warning | The edges of the plan form a cycle through a static side-write of a `lift` or a `computed`: a cone reads a cell that a cone depending on it writes (`scheduler-and-serving-loop.md` §8.2). A body that reads its own write target is reported as `side-write:not-idempotent` and not here | The side-write and the cells on the cycle. Make the write leave a settled value unchanged, so that the second evaluation writes what the first did, or move it into a `handler` or an `action` | new |
| `computed:not-promoted` | hint | A `computed` used as a value fails the criterion of §6.1 | The first disqualifying construct and its promotable form, where one exists | new |
| `computed:redundant` | hint | A `computed` meets the criterion of §6.1, so the wrapper changes nothing | Write the body in place of the call ([§12.2](#122-drop-computed-around-a-promotable-expression)) | new |
| `function-body:instantiation-in-computation` | — | — | — | retired: a `lift` or a `computed` may instantiate a pattern (§5.2) |

### 10.4 Types

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `subset-type:conditional`, `subset-type:mapped`, `subset-type:template-literal`, `subset-type:overload`, `subset-type:class`, `subset-type:callable-object`, `subset-type:assertion-signature`, `subset-type:unsupported-modifier`, `subset-type:index-signature-key`, `subset-type:tuple-rest`, `subset-syntax:enum`, `subset-syntax:namespace`, `subset-syntax:ambient-declaration`, `subset-syntax:decorator` | error | The feature of §7.9 | The replacement in §7.9. Where the feature is needed for a helper's signature, move the helper to an imported module ([§5.5](#55-imported-typescript-tier-i)) | new |
| `subset-type:function-in-data` | error | A function type, a method signature, or a function-typed property anywhere in a pattern's input or result type, the value type of a cell or of another handle, or a handler's state or event type: at any depth, in any member of a union, and with no exception for a type that describes a value probed for a method, such as `{ get?: () => T[] }` (§7.9). Reported at each use of the type as data | Declare what the value is: the cell type where it is a cell (`Cell<T[]>`), the plain type where it is not. Use a stream for behavior, or keep the function at module scope | new (today the value fails to store at run time) |
| `subset-type:non-regular-recursion` | error | A recursive generic alias or interface that passes changed type arguments to itself | Recurse with the declaration's own parameters | new (replaces `cfc-schema:recursion-limit`) |
| `subset-type:empty-intersection` | error | A written intersection that is `never`. Also a written intersection with an operand that §7.4 does not compute: a handle type, a factory type, a function type, or an opaque named API type such as `VNode` | Use a union, or one object type with both sets of properties. For a handle, intersect the value types: `Cell<A & B>` | new |
| `subset-type:operator-operand` | error | A native type operator applied to an operand outside the table of §7.10: `Pick`, `Omit`, `Partial`, or `Required` applied to a type that is not an object type; `Pick` or `Omit` with keys that are not string literals, or `Pick` with a key the type does not declare; `ReturnType` or `Parameters` applied to a type that is neither a function type nor a factory type | Apply the operator to the object type and label the result. For `ReturnType` and `Parameters`, name a function: `ReturnType<typeof priceOf>` | new |
| `subset-type:cannot-infer-type-argument` | error | A generic call leaves a type parameter undetermined and without a default | Write the type argument | new |
| `subset-type:any` | error | `any` written as a type or as a cast target | The explicit form of §7.8 for the use found: `unknown` or `Cell<unknown>` for a reference, no cast for a pattern instance or a labeled value, `instanceof Error` for a caught error, `Record<string, unknown>` or `JSONValue` for open data | new |
| `subset-type:mismatch` | error | An ordinary type error: assignability, a missing property, a wrong argument count, a name that resolves to no type, a property read on an ordinary value typed `unknown` (§7.8), and a receiver whose type has `undefined` or `null`, in any tier, a receiver that is an optional property included, other than a property of a pattern's input whose type declares a default (§7.6, §7.6.1) | The expected and found types. For a receiver that may be absent, the `?.` or `??` form. For a value where a cell is declared or a cell where a value is declared, outside the three calls of §7.5.2: the declaration to change, or `get()`. For a cell passed to a structural type such as `{ get(): T }`: declare the parameter `ReadonlyCell<T>` (§7.5.1). For `Cell<T>` against `Cell<T \| undefined>`: declare both sides alike, or make the property optional. For a cell of `T` where a cell of a view of `T` is declared: declare `ReadonlyCell` of the view. For a value where the state of a handler bound in a function body declares a cell: give a cell (§7.5.3) | new (reported by TypeScript today) |
| `cast-validation:double-unknown` | error | A cast through `unknown` to an unrelated type | Declare the value with the type it has, or narrow it with a type predicate | carries |
| `cast-validation:forbidden-cast` | error | A cast to `Reactive<T>` | Remove the cast | carries |
| `cast-validation:cell-cast` | error | A cast to a cell type | Declare the cell type where the value is received (the pattern input or the handler state) | carries |
| `schema:unknown-type-access` | error | A body of any tier, a pattern callback included, reads a property of a data position typed `unknown` (§7.8), with `.` or with `?.`, after a kind test such as `typeof x === "object"` included, or of an unbound type parameter | Replace `unknown` with a type that declares the properties read. For a key of older data read as a string, declare it `string` and test the read against `undefined` | changes (now also reported in tier R, and for `?.`) |
| `schema:path-not-in-type` | error | A function body reads a property its parameter's type does not declare | Add the property to the type | carries (now an ordinary type error with this identifier) |
| `pattern:any-result-schema` | error | A pattern's inferred result is `any` or `unknown` at the top level | Declare the result: `pattern<Input, Output>(...)` | carries |
| `pattern-result:unknown-type` | error | A field of an inferred, unnamed result type is `unknown` | Annotate the value that produces the field, or declare the result type | carries |
| `pattern-result:opaque-reserved-key` | error | A pattern's declared result types a reserved key such as `[UI]` as `unknown` at its root | Type it as `VNode`, or as the value it holds | carries |
| `reactive-capture:unknown-type` | error | A value captured by a tier-F body has type `unknown` | Annotate the captured value | carries |
| `schema-type:symbol` | error | `symbol` or a `unique symbol` in a type, as an operand of `Exclude` or `Extract` included | A string literal key, or a well-known key exported by the API. `keyof T` is a union of string literals in the subset (§7.1), so no `symbol` has to be removed from it | carries |
| `schema-type:unread` | — | — | — | retired: the checker either types a node or refuses it |
| `stdlib:unsupported-member` | error | A standard-library member §9 does not list. Also a utility type of the TypeScript library that §7.1 does not list, such as `Awaited` or `InstanceType`, and a type name of the DOM library, such as `Event` or `CustomEvent`, for which the message says to declare the shape of the event the handler reads (§7.10). Also a global that §9 names nowhere, whether it is read, called, or constructed, and `Object.prototype` used other than as an operand of `===` or `!==` (§9.3). A global §9.11 lists as not typed is `function-body:unsupported-global` | The nearest listed member | new |
| `import:signature-not-in-subset` | error | An export imported from a tier-I module lacks a full annotation, or its signature uses a type the subset refuses | Annotate every parameter and the return type with subset types | new |
| `import:not-a-function` | error | A value imported from a tier-I module is not a function or a type | Move the constant into a subset module | new |
| `import:signature-not-data` | error | A parameter or the result of a function imported from a tier-I module has a type that is or contains a handle type, a function type, or another code type (§5.5). A handle type is a data type (§1), and this entry excludes it by name | Pass and return data: read the cell in the caller and pass the value (`unitPrice(price.get(), glaze)`), and write the result in the caller. A function that needs the handle or a callback belongs in a subset module | new |
| `import:commonfabric-value` | error | A tier-I module imports a value from `commonfabric` or `commonfabric/<name>`, and not only types (§5.5) | Use `import type`. Move the code that calls a builder, a built-in, or a cell constructor into a subset module, and give the imported function the data it needs as arguments | new |

### 10.5 Labels, defaults, and scopes

| Id | Sev. | Condition | Message tells the author to | Status |
| --- | --- | --- | --- | --- |
| `cfc-label:not-a-list` | error | A label argument that is not a tuple of atoms, such as `string[]`, decided after a reference to an alias is replaced by the alias's body (§8.5). The required integrity of a trusted-action alias is such an argument | Write a tuple: `readonly ["secret"]` | carries |
| `cfc-label:not-static` | error | A label atom outside the constant language of §8.5, decided after a reference to an alias is replaced by the alias's body. Also an action or a pattern argument of a trusted-action alias that is not a string literal type or a constant reference whose value is a string. Also a constant reference, `typeof NAME`, to a constant whose initializer is not static (§8.8) or whose value the position does not accept | Write a literal, an object literal type, `AnyOf<...>`, `PolicyOf<typeof rules>`, or `typeof` of a module-scope constant initialized by a literal | changes (was the warning `cfc-label:unread`, which left a `null` atom) |
| `cfc-label:conflict` | error | Two annotations on one path declare a key other than `confidentiality` differently | Declare the key once | changes (was a generation error without an identifier) |
| `cfc-label:cast-ignored` | warning | A cast whose target type carries annotations the operand's type does not | Remove the cast; declare the label on the cell, the pattern input, or the pattern result | new |
| `cfc-write-authorized-by` | error | A writer binding that is not `typeof` of a supported declaration: a module-scope `handler(...)` definition or a function declaration (§8.5) | Name a module-scope `handler(...)` definition or a function declaration | changes (the contract's `module(...)` and `requireEventIntegrity(...)` bindings are not in the language) |
| `cfc-policy-of`, `cfc-policy-authoring` | error | As the contract defines | As the contract defines | carries |
| `cfc-write-authorized-by:unread` | — | — | — | retired: a binding reference survives every substitution (§8.7) |
| `cfc-label:unread` | — | — | — | retired: replaced by `cfc-label:not-static` |
| `cfc-schema:recursion-limit`, `cfc-schema:recursive-alias-of-any` | — | — | — | retired (§8.7) |
| `cfc-flow:max-confidentiality`, `cfc-flow:required-integrity`, `cfc-flow:write-policy` | error | A declared constraint that the declared labels of a template's slots cannot satisfy. The conditions are defined in `plan-and-label-templates.md` | The slot whose label violates the constraint, and the declaration to change | new (reserved here, specified there) |
| `cfc-flow:write-floor` | error | The declared integrity of the value a write edge or a kept output writes cannot satisfy the write floor of its target. The condition is defined in `plan-and-label-templates.md` §4.4 | The write, the slot whose declared integrity falls short, and the declaration to change: the integrity declared on the source, or the floor declared on the target. *Assumed* (§8.6): the floor is the `RequiresIntegrity` annotation on the written path of the target, a kept output included | new (reserved here, specified there) |
| `cfc-flow:writer-fit` | error | The declared confidentiality of the value a write edge writes does not fit the confidentiality declared on its target. The condition is defined in `plan-and-label-templates.md` §4.4 | The write, the slot whose declared confidentiality exceeds the target's, and the declaration to change: declare the confidentiality on the target, or write a value that does not derive from that slot | new (reserved here, specified there) |
| `cfc-flow:ui-contract` | warning | A handler whose write policy requires a UI contract is bound by elements of the pattern, and none of them sits under a surface that carries the pattern and integrity names the contract requires, so no event from this pattern's UI can satisfy the policy (`plan-and-label-templates.md` §4.4) | The handler, the contract, and the elements that bind it. Bind the handler on an element inside the surface the contract names, or name in the policy the handler that the surface's control does bind | new (reserved here, specified there) |
| `default:not-static` | error | A `Default` value that is neither a literal-like type nor `typeof` of a module-scope constant with a static initializer (§8.8), or that is not assignable to its type. A constant whose initializer is a call or a `new` expression is such a value: `Default<typeof INITIAL>` with `const INITIAL = createInitial()` | Write the value as a literal of the declared type, in the type or as the initializer of the constant | changes (was the warning `schema-default:unresolved`) |
| `scope:union-member` | error | A scope wrapper on a member of a union that has a member other than `null` and `undefined` | Put the scope around the union: `PerUser<A \| B>` | new |

## 11. Corpus evidence

### 11.1 Method

The measurements below, and the corpus figures of `builtin-inventory.md`,
come from one throwaway script, which is not part of the repository. It
parses each file with the TypeScript parser and uses no type checker. It
recognizes a builder or a built-in by its import from `commonfabric`, not
by its name, and assigns every node to its nearest enclosing body, using
the syntactic tier boundaries of §1: the function argument of `pattern`,
`handler`, `lift`, `computed`, or `action`, an inline JSX event handler, or
a function at module scope. Counts are of syntax nodes, and "n (m)" is n
nodes in m files.

**The corpus** is every file under `patterns/` that `deno task cfcheck`
compiles, with the modules those files import by relative path: each `.ts`
and `.tsx` file that is not a test file, is not under `integration/`,
`tools/`, or `apps/topics/tools/`, and is not an iframe guest script. Nine
modules of the iframe examples that only guest scripts import are left out.
That is 425 modules and about 118,000 lines. It holds 507 `pattern`
definitions, 621 `handler` and 73 `lift` definitions at module scope, 1,493
`computed` calls, 249 `action` calls, and 188 inline JSX event handlers.

Three sets were measured apart and are reported only where a row names
them. Pattern test files (`*.test.tsx`) are patterns too: 281 modules. The
integration fixtures under `patterns/integration/fixtures/` are patterns
that browser tests deploy: 64 modules. The nine iframe modules, the guest
scripts, the Topics command-line tools, and plain unit tests are not
patterns.

**FabriChat** is the eight source modules of `patterns/system/fabrichat/`,
without its tests and its test fixture: about 9,100 lines, 14 patterns, 25
handlers, 50 applications of a handler to its state, all in pattern bodies,
112 `computed` calls, and 10 actions. Of the 50 applications, 47 are of the
25 handlers and 3 are of two handlers imported from other modules. Its
design is in [`docs/specs/fabrichat/`](../fabrichat/README.md).

Two limits of the method matter. Receiver types were not resolved, so method
counts are by name. And nothing was type-checked, so the measurements show
which constructs the subset would refuse, not whether the remaining code
passes the subset's type rules. The second is the prototype of the
overview's stage 2.

Three marks separate the figures the script did not measure. "Needs
types" is on a figure that depends on a type the script does not have.
"Not reproduced" is on a figure the script did not confirm. "Prototype" is
on a figure that the prototype of the type checker reports and the script
cannot. Where neither has a figure, the text says that it was not
measured.

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
same position: the 472 block-bodied pattern callbacks consist of 2,919
`const` statements, 472 final `return` statements, 20 expression statements,
and 2 local type declarations, and nothing else.

### 11.3 What the subset refuses in the corpus

| Construct | Occurrences (files) | Where | Resolution |
| --- | --- | --- | --- |
| Function overloads | 5 (2) | `patterns/system/fabrichat/manager.tsx` (4), `patterns/system/private-inbox/private-inbox.tsx` (1); 34 more in 29 pattern test files | Rewrite. Every occurrence but one is one idiom: a one-line function whose overload signature re-types a cell (`function inboxOf(pointer: Cell<A>): Cell<B>`) over an implementation that returns its argument as `unknown`. It exists because the double cast is refused. The exception, `aboutRecordOf` in `manager.tsx`, returns a `key` chain that ends at a property declared as a cell, and its overload states the flattened type that `key` has in this language (§4.7). [§12.4](#124-replace-the-re-typing-overloads-with-declared-types) gives the three rewrites, which need no new construct |
| Mapped type | 1 (1) | `patterns/apps/topics/topic.tsx` | Rewrite as `Readonly<Record<K, number \| undefined>>` |
| `ifElse`, `when`, `str` | 156 (54); 1 (1); 1 (1). No `unless` | for example `patterns/system/self/self.tsx`, `patterns/system/loom/main.tsx`; `when` in `patterns/system/omnibox-fab/omnibox-fab.tsx`; `str` in `patterns/apps/deep-research/deep-research.tsx` | Accepted for the interim with a warning (§4.4.3). The rewrite is mechanical: all 158 are direct calls. That each has the plain arguments is not reproduced |
| `patternTool` | 31 (12) | pattern bodies | Rewrite to a pattern closure (§4.4.3) |
| A collection method called on a cell handle in a handler | 2, as `builtin-inventory.md` counts them (needs types) | handlers | Rewrite by one of the two corrections of §4.7: an inline `pattern(...)` that is instantiated, or `cell.get().map(...)` (`cell:collection-method-in-function`) |
| A function type in a type used as data | 1 declaration, 35 uses in 10 modules (prototype) | `MentionablePiece` in `patterns/system/backlinks-index/backlinks-index.tsx`, whose property `mentionable` is declared `MentionablePiece[] \| { get?: () => MentionablePiece[] }`. The type is a pattern input, a cell value, and a handler state | Rewrite: the declaration says what the value is, a list or a cell of one (`subset-type:function-in-data`, §7.9) |
| A cell passed to a parameter declared with a structural type | About 25 arguments (prototype) | Declarations of the kind are `roster: { get(): ... }` in `patterns/system/loom/participants.tsx` and `sources` in `patterns/apps/topics/main.tsx` | Rewrite: declare the parameter `ReadonlyCell<T>`, which accepts every cell the structural type was written to accept (§7.5.1) |
| A cell of `T` given where a cell of a view of `T` is declared | 13 arguments (prototype) | `Cell<Message>` where `quotes?: Cell<RepliedMessage>` is declared, in `patterns/system/fabrichat/room-records.tsx` | Rewrite: declare `ReadonlyCell` of the view where the link is read, and the type the cell has where it is written (§7.5.1) |
| A writable view wider than the declaration, and a kind test on a key of older data typed `unknown` | 18 errors of one cause (1) (prototype) | `patterns/apps/topics/topic.tsx`: the pattern that repairs stored topics declares `createdBy: Writable<Partial<TopicAuthor> \| undefined>` over a place declared `TopicAuthor`, and narrows `createdByName` and the `authorName` of a comment, both typed `unknown`, with `typeof` | Rewrite: the input declares the shape the stored data has, `createdBy?: Partial<TopicAuthor>`, and each such key as `string`, and the pattern exposes the complete form as an output (§7.5.1, §7.8) |
| A narrowed optional value given where a writable cell of the narrowed type is declared | 3 arguments (1) (prototype) | `ann.status` in `patterns/apps/annotation-manager/annotation-manager.tsx`, given to three handlers whose state declares `status: Writable<AnnotationStatus>` | Rewrite: the three handlers declare `Writable<AnnotationStatus \| undefined>`, the declared type of the place (§7.5.2) |
| A literal given to a pattern that writes the argument | 3 (2) | `Counter({ value: 10 })` and `Counter({ value: 30 })` in `patterns/examples/cf-picker/cf-picker.tsx`, and `Counter({ value: 5 })` in `patterns/examples/drag-drop-demo/drag-drop-demo.tsx`. `Counter` in `patterns/examples/counter/counter.tsx` declares `value?: Writable<number \| Default<0>>` and binds it to the handler `increment`, which writes it | Rewrite, by ruling: the caller creates a state cell and gives it, `const start = new Writable(10)` and `Counter({ value: start })` (`binding:write-to-computed`, §7.5.2) |
| A type name of the DOM library | 4 (3) (prototype) | `Event` in `patterns/apps/annotation/annotation.tsx` and `patterns/examples/form-demo/form-demo.tsx`; `CustomEvent` in `patterns/dev/catalog/stories/cf-chat-story.tsx` | Rewrite: declare the shape of the event the handler reads (`stdlib:unsupported-member`, §7.10) |
| `.get()` on a stream reached through `key` | 1 (1) (prototype) | `takesOffers` in `patterns/system/fabrichat/manager.tsx` | Rewrite: test presence through a view typed `unknown` ([§12.9](#129-test-that-a-stream-is-present-through-a-view-typed-unknown)) |
| A default named by `typeof` of a constant whose initializer is a call | 1 (1) (prototype) | `Default<typeof INITIAL_SHOTS>` in `patterns/showcase/battleship/multiplayer/schemas.tsx`, where `INITIAL_SHOTS = createInitialShots()` | Rewrite: write the value as a literal (`default:not-static`, §8.8) |
| `any` in a type | 132 (see below) | for example `patterns/system/link-tool/link-tool.tsx`, `patterns/system/knowledge-graph/knowledge-graph.tsx` | Rewrite with the explicit forms of §7.8 |
| `as any` | 52 (21) | for example `patterns/system/notes/daily-journal.tsx`, `patterns/system/agent-queue/agent-queue.tsx` | Remove: the rules of §7.5, §7.6, and §8.6 make most of them unnecessary |
| `new` of a non-cell constructor in the pattern body | 4 (3) | `new Date(value)` in `patterns/system/notes/voice-note.tsx` and `patterns/apps/activity-log/activity-log.tsx`; `new Uint8Array` in a catalog story | Rewrite: wrap in `computed(() => ...)` |
| `void name;` in the pattern body | 2 (2) | `patterns/system/home/home-ben.tsx`, `patterns/apps/store-mapper/store-mapper.tsx` | Rewrite: delete the statement |
| A `console.log(...)` statement in the pattern body | 1 (1) | `patterns/dev/test/data-model-test.tsx` | Rewrite: delete the statement, which is not one of the recorded calls of §4.2 |
| A function passed by name as a collection callback in tier R | 2 (2) | `.filter(Boolean)` in `patterns/apps/annotation-manager/annotation-manager.tsx`; `.map(toMentionable)` in `patterns/examples/nested-mentionables/nested-mentionables.tsx` | Rewrite: write the arrow at the call, `.filter((x) => Boolean(x))` and `.map((node) => toMentionable(node))` (`collection:callback-parameters`, §4.4.1) |
| An authored function, called from a pattern body, that creates a cell without a cause | 3 calls of one function (1) | `makeProfile` in `patterns/dev/catalog/stories/cf-profile-badge-story.tsx` | Rewrite: the function returns the value, and the pattern body creates the cell from it, where the cell is a state cell named by its `const` (`function-body:cell-needs-cause`, §5.2) |
| An authored function, called from a pattern body, that requests an effect | 1 (1) | `BuildingBlock` in `patterns/dev/gideon-tests/test-reactive.tsx`, which calls `generateObject` in the callback of a `map` | Rewrite: declare it as a `pattern(...)` and instantiate it, or write its body in the pattern body (`function-body:effect-in-computation`, §5.2) |
| An ambient read in a `computed` | 2 (2) | `Math.random()` in `patterns/dev/test/non-idempotent/shuffle.tsx`; `Date.now()` in `patterns/dev/test/non-idempotent/timestamp.tsx` | Refused with no rewrite (`function-body:ambient-read`). Both are fixtures that exist to compute another value on each evaluation, for the tooling that diagnoses a computation that is not idempotent |
| The `Function` constructor | 1 (1) | a handler in `patterns/dev/test/data-model-test.tsx` | Refused with no rewrite (`function-body:dynamic-code`). The pattern evaluates text that its user types |
| An immediately invoked function in JSX in the pattern body | 2 (1) | `patterns/dev/gideon-tests/test-helper-owned-jsx-iife-captures.tsx` | Rewrite: `computed(() => { ... })` in place of each (`pattern-context:function-creation`) |
| An import with no bindings | 1 (1) | `import type {} from "commonfabric/schema"` in `patterns/apps/topics/topic.tsx` | Rewrite: delete the import (`module-scope:import-form`, §3.1) |
| Ambient authority | 2 (2) | `globalThis.prompt` in `patterns/showcase/scrabble/scrabble.tsx`; `Promise.resolve().then(...)` in a `patterns/dev/` test fixture | Refused with no rewrite. Both rely on something the sandbox is meant not to offer |
| Reflection | 1 (1) | `Object.getOwnPropertySymbols` in a `patterns/dev/` test | Refused. `Object.getPrototypeOf` (4 uses), `Object.prototype` as the other operand of the comparison (3 uses, in `patterns/system/loom/main.tsx` and `patterns/system/shared-space/shared-space-catalog.ts`), and `Object.create(null)` (2) are in §9.3 instead, because the plain-object test they implement has no other form |

`any` occurs 184 times in 49 modules, 132 times in a type and 52 times as
the target of a cast. By what it stands for:

| Use | Occurrences | Explicit form (§7.8) |
| --- | --- | --- |
| A reference to another piece or a cell of unknown content: a property typed `any` (34), `Writable<any>` (29), `any[]` and `Array<any>` (6), `AnyCell<any>` (1) | 70 | `unknown`, `Cell<unknown>` |
| A parameter over such a value: a lambda parameter in `map`, `find`, `findIndex`, `filter`, `some` (21), a function parameter (11) | 32 | Follows from typing the collection or the parameter |
| An open record: `Record<string, any>` (12), an index signature (2) | 14 | `Record<string, unknown>`, `JSONValue` |
| A type argument of a builder: `handler<any, State>`, `pattern<Input, any>` | 9 | `unknown`; a declared result |
| Other type positions | 7 | Case by case |
| Cast: `(error as any).message` and similar member reads | 23 | Narrowing with `instanceof Error` |
| Cast: a pattern instance or a cell passed where a view of it is declared: an object property (7), `navigateTo` (5), `push` (5), and 5 others | 22 | No cast: instance-to-view assignability (§7.5), labels outside assignability (§8.6) |
| Cast: a JSX attribute value (5), `Object.keys(x as any)` (2) | 7 | Type the value |

The 22 casts in the seventh row are the ones that exist because a type could
not be expressed: a new `Note` pushed onto a list of `NotePiece`, or a queue
whose exported type carries a write policy its local view does not. Whether
the two assignability rules remove every one of them needs the type-checking
prototype; the script classified them by syntax.

**FabriChat** uses none of `ifElse`, `when`, `unless`, `str`, or
`patternTool`. By the rules that syntax and name resolution decide it
needs one change: the four overload signatures in
`manager.tsx`
([§12.4](#124-replace-the-re-typing-overloads-with-declared-types)). One
of the four, `aboutRecordOf`, needs only its overload signature deleted,
because `key` flattens (§4.7). The quick-reaction buttons of
`message-row.tsx` are accepted as written. They are a `map` over the
module-scope constant `FABRICHAT_QUICK_REACTIONS`, six distinct emoji, and
the callback applies the handler `commitSendReaction` to its state without
the index and declares no state cell (§4.4.1). Nothing else in its eight
modules is refused by a rule that syntax and name resolution decide. In
particular it uses no `any`, and its two generic helpers and its use of
`keyof T & string` are inside the generics of §7.3 and the intersections
of §7.4.

The type rules refuse more. The prototype of the type checker, run on a
later tree of the eight modules, reports the following (prototype).

- Five overload signatures in `manager.tsx`, one more than the script
  counted on the measured tree.
- One `.get()` on a stream: `takesOffers` in `manager.tsx` reads
  `inboxOf(inbox).key("receive").get()` to test that the inbox has its
  stream. With `key` flattening, the receiver is a `Stream`, which has
  no `get`
  ([§12.9](#129-test-that-a-stream-is-present-through-a-view-typed-unknown)).
- One cell given to a helper that declares a structural `{ get(): T }`,
  in `room.tsx` (§7.5.1).
- Two arguments in `room.tsx` that give a `Cell<T>` where a handler
  declares `Cell<T | undefined>`, and two in `room-records.tsx` that
  give a `Cell<Message>` where a `Cell` of a view of `Message` is
  declared (§7.5.1).
- Six uses of an optional property of a pattern's input without a test.
  [§7.6.1](#761-optional-properties-of-an-input) accepts each one whose
  property declares a default; how many of the six do was not measured.

### 11.4 Where the subset was adjusted to the corpus

These constructs were candidates for refusal. They are accepted, for the
counts shown or because the project owner asked for them.

| Construct | Occurrences (files) | Decision |
| --- | --- | --- |
| Inline event-handler arrows in JSX built inside a function body | 8 (5), for example `patterns/apps/habit-tracker/habit-tracker.tsx` | Accepted as a handler binding (§5.2) |
| A module-scope handler applied to its state inside a `computed` | 16 (3): `patterns/apps/base/person.tsx`, `patterns/apps/base/family-member.tsx`, `patterns/apps/store-mapper/store-mapper.tsx` | Accepted as a handler binding (§5.2). The same form occurs 764 times in pattern bodies |
| `reduce` | 29 calls, all in function bodies today: 20 with an expression-bodied callback and an initial value, 2 expression-bodied without one, 7 block-bodied | A reactive construct in tier R for the first 20 (§4.4.1). The other 9 stay tier-F code, where `reduce` is ordinary JavaScript |
| `some`, `every`, `find`, `findIndex` with a callback | 136, 14, 70, and 78 calls, all but 2 `some` in function bodies today | Reactive constructs in tier R (§4.4.1), and ordinary methods in tier F |
| The index parameter of a `map` callback in a pattern body | Used in 44 of 326 callbacks (28 files); none in FabriChat | Accepted, with the hint `collection:index-keyed` |
| A handler bound, without the index, in a per-element body over plain values | 7 (7) where the collection is a module-scope constant or a call result, for example `patterns/apps/weekly-calendar/event.tsx`, `patterns/examples/group-chat-room/group-chat-room.tsx`, and `patterns/system/fabrichat/message-row.tsx`. A further 95 callbacks, over a local constant or a parameter, bind a handler without the index; which of those collections are stored lists, and which have a primitive element type, needs types | Accepted (§4.4.1): equal elements bind equal state and share one stream. No callback in the corpus declares a state cell, so `collection:shared-element-state` refuses nothing in it. How many per-element bodies over plain values instantiate a child, and are therefore keyed by position, was not measured |
| A value named where the callee declares a cell, or a cell where it declares the value, in an argument written in tier R | 218 arguments of a pattern or of a handler, and about 37 arguments of a `lift` result or of an authored function (prototype) | Accepted for a pattern, a handler, and a `lift` result: the argument is bound by reference (§7.5.2). An argument of an authored function is not covered; how many of the 37 are such was not measured |
| An optional property of a pattern's input whose type declares a default, used without a test | 503 receivers, 434 of a handle and 69 of a value; 223 arguments that give one to a callee that requires it (prototype). For example `bookmarks.get()` in `patterns/apps/bookmarks/bookmarks.tsx`, `selected.set(option)` in `patterns/product/primitives/option-picker.tsx`, and `logEventHandler({ events, mentioned })` in `patterns/apps/activity-log/activity-log.tsx` | Accepted: the body reads such a property without `undefined` (§7.6.1). Whether every one of the 726 is a property whose type declares a default has to be confirmed by the prototype |
| A value given where a pattern instantiated in a function body declares a cell | 35 arguments (prototype), for example `Notebook({ title: "New Notebook" })` in `patterns/dev/default-app-ben/default-app-ben.tsx` | Accepted: the value is the initial value of the new instance's argument at that path (§7.5.3) |
| `"k" in x` on a value narrowed to `object`, followed by a read of `x.k` | 14 reads (4) (prototype) | Accepted: the test adds the property `k: unknown` (§7.6) |
| A handle of a declared type given where a handle of `unknown` is declared | 82 sites (prototype) | Accepted (§7.5.1). Whether a write through such a handle stays legal is open ([§13](#13-open-questions), question 29) |
| `typeof` of a module-scope constant as a label atom, and as the action or the pattern of a trusted-action alias | 48; 72 (prototype). For example `readonly [typeof LOBBY_ADMIN_INTEGRITY]` and `typeof TRUSTED_LOBBY_ACTION` in `patterns/product/lobby/main.tsx`, `typeof FACT_CHECK_GATE_ACTION` in `patterns/system/cfc/trusted-surfaces/fact-check-gate.tsx`, and `readonly [typeof LOOM_VERIFIED_EXTERNAL_IDENTITY_INTEGRITY]` in `patterns/system/profile-home/profile-home.tsx` | Accepted as a constant reference, with the constant's value as the atom or the name (§8.5) |
| A cell passed to a parameter typed `object` | About 23 arguments (prototype), for example `sameRoom` in `patterns/system/fabrichat/manager.tsx`, whose parameters are `object \| undefined` | Accepted: `object` is a type of the subset, and a handle is assignable to it (§7.1, §7.5) |
| `as T` casts other than `as const` and `as any` | 243 (58) | Accepted as assertions between related types (§7.7) |
| Non-null `!` | 57 (34) | Accepted |
| `typeof name` in a type, outside label arguments | 127 (45) | Accepted (§7.1). Common forms are `Default<typeof EMPTY>`, `ReturnType<typeof handler>`, and `(typeof LIST)[number]`. In a default, `typeof` names the constant's value, which has to be static (§8.8); one site is refused (§11.3) |
| Indexed access types | 29 (13) | Accepted, eager |
| Type predicates | 22 (13) | Accepted, trusted |
| Generic functions; generic aliases and interfaces | 24 (13); 28 (15) | Accepted (§7.3) |
| Intersection types | 25 (19) | Accepted, eager (§7.4). How many have an operand that is a handle type or an opaque API type, and are refused, was not measured |
| Function types and method signatures in types | 16 (10); 20 (7) | Accepted where the type describes code: a callback parameter, a helper's signature, a local (§7.9). Refused in a type used as data, which one declaration of the corpus is (§11.3). Most of the rest describe a structural "cell-like" parameter of a helper, such as `{ get(): T }`. A cell handle is not assignable to such a type (§7.5), so each of those helpers declares the cell type. The prototype reports about 25 arguments that pass a cell to one (§11.3) |
| `Parameters<typeof P>[0]`, `ReturnType<typeof h>` | 12 (2); 5 (1) | Accepted on factory types (§7.2). Whether `P` is a pattern or a handler in each was not told apart; both operators are defined on both |
| `Pick`, `Omit`, `Partial`, `Required`, `Readonly`, `Exclude`, `NonNullable` | 47 in total | Native operators (§7.10) |
| Module-scope constant computed by a call or an immediately invoked function | 7 (6) | Accepted as frozen data (§3.2), for example the board tables of `patterns/showcase/scrabble/scrabble.tsx` |
| Default exports and default imports of patterns | 187 imports (52) | In the grammar (§3.1) |
| Module-scope `new Set(...)` | 2 (2) | Accepted, typed `ReadonlySet` |
| Module-scope regular expressions | 9 (6), none stateful | Accepted |
| `try`, `throw`, `instanceof` on an error constructor in function bodies | 31 (18); 149 (23); 8 (6) | Accepted (§5.1) |
| `delete` in a function body | 1 (1) | Accepted on local values |
| Expression statements in the pattern body | 20 (18): 15 `computed` calls kept for their writes, 2 calls of `lift` results, 2 `void`, 1 `console.log` | The first 17 are accepted (§4.2) |
| `.get()` in the pattern body | 68 (24) | Accepted on cells at every site (§4.4) |
| Dynamic keys in the pattern body | 18 (8) | Accepted (§4.4) |
| Handler or lift callback passed by local name | 6 (2), not reproduced | Accepted (§3.2) |
| Tagged templates in function bodies | 7 (4), all `debugStr` | Accepted as calls |

### 11.5 Promotion

Of the 1,493 `computed` calls, 15 are in statement position and exist for
their writes. Applying the criterion of §6.1 by syntax to all 1,493:

| Outcome | Count | Share |
| --- | --- | --- |
| Promoted: expression or `const`-then-`return` body, structural operations only | 1,039 | 70% |
| Promoted: the same, with at least one call of an authored function | 222 | 15% |
| Promoted through the guard form (`if (...) return ...;` chains) | 108 | 7% |
| Not promoted: in statement position | 15 | 1% |
| Not promoted: a statement body (loops, `let`, expression statements, `try`) | 62 | 4% |
| Not promoted: an expression with a disqualifying construct | 47 | 3% |

So 1,369 of 1,493 (92%) are promoted. Without the guard form the figure is
84%, which is the reason the criterion includes it. Counting `reduce`,
`findIndex`, `some`, `every`, and `find` as reactive constructs accounts for
54 of the promoted calls; with those five in the function tier the figure
is 88%.

The 47 disqualified expressions fail, at the first such construct in each,
on: the mutating `sort` or `reverse` on a copy (14); a handler binding (10:
a named handler applied to its state in 7, an inline event handler in 3);
`new Set` or `new Date` (9); a collection method given a function by name,
as in `filter(Boolean)` (4); a pattern instantiation (2); a collection
callback with a statement body (2); the comma operator (2); and a function
passed to `replace` or `toSorted`, a `reduce` callback that is not an
expression, or a call the script could not classify (4).

The 10 that fail on a handler binding fail on nothing else. Without the
clause of condition 5 that disqualifies a binding
([§13](#13-open-questions), question 15), 1,379 of 1,493 are promoted.

In FabriChat, 105 of 112 (94%) are promoted by the expression and
`const`-then-`return` forms and 4 more by the guard form, 109 in all. No
`computed` in FabriChat binds a handler.

The count is syntactic. It treats a method as pure by its name, and it does
not check condition 5 of §6.1 against types, so the type-checked figure will
differ slightly.

### 11.6 Labels

The corpus writes 208 references to label aliases outside `AnyOf` and
`PolicyOf`. `TrustedActionWrite` (57) and `WriteAuthorizedBy` (45) dominate,
then `Confidential` (32) and `AddIntegrity` (15).

- 231 label arguments are `typeof` references, 58 are tuples written
  in place, 12 name an alias, 12 are object literal types, and 10 are string
  literals. All are in the constant language of §8.5. The script does
  not tell a binding reference from a constant reference. The prototype
  reports 48 sites where `typeof` of a module-scope constant is a label
  atom and 72 where it is the action or the pattern of a trusted-action
  alias (prototype). Both are constant references (§8.5).
- 42 payloads are themselves label aliases (nesting), 11 are arrays, and 1
  is a union with `undefined`. None is an intersection.
- 12 generic aliases wrap a label alias, such as `OwnerPrivate<T>` in
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
frequent in function bodies, by name, are `trim` (401), `map` (365),
`filter` (314), `push` (297), `some` (135), `Date.now` (112), `slice`
(108), `join` (108), `includes` (84), `findIndex` (78), `toLowerCase` (76),
`find` (70), `console.log` (59), `Math.floor` (51), `has` (51), `sort`
(49), `split` (44), `toString` (42), `flatMap` (40), `replace` (40), and
`Array.from` (39). `new Error` occurs 118 times, `new Date` 59, `new Set`
54, and `new Map` 45.

`Date.now` (112 occurrences in 48 files) and `Math.random` (33 in 25) are
the two ambient reads. Of the `Date.now` calls, 84 are in a handler, an
action, or an inline event handler, where they are allowed, 1 is in a
`computed`, where the sandbox refuses it at run time today, and 27 are in
authored functions. Of the `Math.random` calls, 15 are in a handler or an
action, 1 is in a `computed`, and 17 are in authored functions. None of
either is in a `lift`. The script does not follow an authored function to
the bodies that call it.

## 12. Recommended syntax changes

Each change keeps today's form valid unless it says otherwise. §12.1,
§12.8, and §12.9 do say otherwise.

### 12.1 Conditionals and templates are JavaScript

`ifElse`, `when`, `unless`, and the `str` tag are removed (§4.4.3). The
conditional operators and the template literal are the only spellings. The
corpus has 156 `ifElse` calls in 54 files, one `when`, and one `str`,
against 466 conditional expressions (`?:`) in pattern bodies; all 158 are
rewritten mechanically.

```tsx
// Shown for illustration only.
// Before
<div>{ifElse(hasSprinkles, <SprinkleBadge />, <PlainBadge />)}</div>
<div>{when(isFresh, <FreshBadge />)}</div>
<div>{str`${count} donuts`}</div>

// After
<div>{hasSprinkles ? <SprinkleBadge /> : <PlainBadge />}</div>
<div>{isFresh && <FreshBadge />}</div>
<div>{`${count} donuts`}</div>
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

### 12.4 Replace the re-typing overloads with declared types

Every overload in the corpus (§11.3) but one is one idiom: a one-line
function whose overload signature gives its argument another type, over an
implementation that returns the argument as `unknown`. No new construct
replaces it. The runtime's `asSchema` is not part of the language: no
pattern module calls it, apart from one personal variant under
`patterns/system/home/`. The idiom has two uses, and each has a rewrite in
the language as specified. The one overload that is not the idiom states
the type of a `key` chain, and is the third case below.

**A pattern instance typed as a cell of a view of it** (35 of the 39
signatures take `unknown`). The assignability rule of §7.5 covers it, so the
function is deleted.

```ts
// Shown for illustration only.
// Before
function boxLinkOf(box: unknown): Cell<DonutBoxLink>;
function boxLinkOf(box: unknown): unknown {
  return box;
}
const link = boxLinkOf(DonutBox({ flavor }));

// After
const link: Cell<DonutBoxLink> = DonutBox({ flavor });
```

**A link read beyond the type it is declared with** (the remaining 4, less
the one of the third case). The
link's type is kept small on purpose, because today the declared type
decides what every reader of the link loads. In this language a function
body loads what its footprint reads, whatever the declared type's width. So
the position is declared with the type that is read, and the function is
deleted.

```ts
// Shown for illustration only.
// Before
interface JoinEvent {
  box: Cell<DonutBoxLink>; // names the box and nothing else
}
function addStreamOf(box: Cell<DonutBoxLink>): Cell<{ add: Stream<Donut> }>;
function addStreamOf(box: Cell<DonutBoxLink>): unknown {
  return box;
}
const join = handler<JoinEvent, State>((event) => {
  addStreamOf(event.box).key("add").send(GLAZED);
});

// After
interface JoinEvent {
  box: Cell<DonutBoxLink & { add: Stream<Donut> }>;
}
const join = handler<JoinEvent, State>((event) => {
  event.box.key("add").send(GLAZED); // the footprint is `add` alone
});
```

**A handle reached through `key`** (`aboutRecordOf` in
`patterns/system/fabrichat/manager.tsx`). The function returns a `key`
chain whose last property is declared as a cell. The declaration of `key`
in `base/api/index.ts` wraps such a property in the outer handle
(`IKeyable`), so the overload is there to state the type of the inner
cell. In this language `key` flattens
([§4.7](#47-cell-and-handle-methods)): the chain has that type itself. The
overload signature is deleted, and the function keeps one signature with
the return type it had.

```ts
// Shown for illustration only.
interface DonutBoxLink {
  about?: { recipe?: Cell<Recipe> };
}

// Before
function recipeOf(box: Cell<DonutBoxLink>): Cell<Recipe>;
function recipeOf(box: Cell<DonutBoxLink>): unknown {
  return box.key("about").key("recipe");
}

// After
function recipeOf(box: Cell<DonutBoxLink>): Cell<Recipe> {
  return box.key("about").key("recipe");
}
```

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
pattern<{ glaze?: Default<string, "plain"> }>(({ glaze }) => ({ glaze }));
```

The `?` stays: it is what lets a caller leave the property out. The
default is what lets the body read `glaze` as a `string` without a test
([§7.6.1](#761-optional-properties-of-an-input)).

### 12.8 Use the index for a per-element state cell over plain values

A per-element body over plain values that declares a state cell takes the
index and uses it (`collection:shared-element-state`, §4.4.1). The index
is then part of each element's key, so each position has a cell of its
own. For a list that does not change, such as a module-scope constant, the
index costs nothing: no element moves.

```tsx
// Shown for illustration only.
const GLAZES = ["plain", "sugar", "chocolate"] as const;

// Before: refused
const rows = GLAZES.map((glaze) => {
  const open = new Writable(false);
  return <li onClick={() => open.set(!open.get())}>{glaze}</li>;
});

// After
const rows = GLAZES.map((glaze, index) => {
  const open = new Writable(false);
  return (
    <li onClick={() => open.set(!open.get())}>{index + 1}. {glaze}</li>
  );
});
```

No callback in the corpus declares a state cell (§11.4), so no pattern
changes for this rule today. A body that binds a handler and declares no
state cell needs no index and stays as written: the corpus has such bodies
in seven files, FabriChat's quick-reaction buttons among them.

### 12.9 Test that a stream is present through a view typed `unknown`

A body sometimes has to know whether a stream is stored at a position
before it sends to it. `takesOffers` in
`patterns/system/fabrichat/manager.tsx` does so by reading the stored
link: `inboxOf(inbox).key("receive").get()`. In this language `key`
flattens ([§4.7](#47-cell-and-handle-methods)), so the receiver is the
`Stream` itself, and a `Stream` has no `get` (`opaque-get:invalid-call`).

The test is a test of presence, and a position typed `unknown` is what
supports one without reading the content
([§7.8](#78-any-and-unknown)). The body reads the same cell through a
read-only view that declares the property `unknown`. A `Cell` of the
record is assignable to that view, because a `Stream` is assignable to
`unknown` and the target does not write ([§7.5.1](#751-handles)).

```ts
// Shown for illustration only.
interface Inbox {
  receive?: Stream<Offer>;
}

// Before
const takesOffers = (inbox: Cell<Inbox>): boolean =>
  isStreamHandle(inbox.key("receive").get());

// After
const hasReceive = (inbox: ReadonlyCell<{ receive?: unknown }>): boolean =>
  inbox.key("receive").get() !== undefined;

const takesOffers = (inbox: Cell<Inbox>): boolean => hasReceive(inbox);
```

`key("receive")` on the view is a `ReadonlyCell<unknown>`, and its
`get()` returns a reference that the body compares with `undefined`.
The footprint of the test is the presence of `receive` and nothing of
the stream. The test says that something is stored at the position. It
does not say that what is stored is a stream: a kind test on a position
typed `unknown` sees the reference alone (§7.8). The declared type of
the position, `Stream<Offer>`, is what says that, and the send is typed
by it: `inbox.key("receive").send(offer)`.

## 13. Open questions

Decided in this document, and written into the sections above: tier I is
marked by `"use typescript";` (§5.5); the load-time verifier is retired for
subset modules and kept for tier-I modules (§3.4); `any` is refused and
each use gets an explicit form (§7.8); an inline event handler in a function
body is a handler binding (§5.2); the published typings become identity
aliases, with no editor plugin (§8.6.1); an argument of a pattern, of a
handler, or of a `lift` result written in tier R is bound by reference,
so a value and a handle of it stand for each other there (§7.5.2); two
handles are compared by what the target can do, and a cell of `T` is
assignable to a `ReadonlyCell` of a view of `T` and not to a `Cell` of
it (§7.5.1); a value given where a pattern instantiated in a function
body declares a cell is the initial value of the instance's argument
(§7.5.3); an optional property of a pattern's input whose type declares
a default is read without `undefined` (§7.6.1); `"k" in x` adds the
property to a type that does not declare it (§7.6); `AnyCell` is a type
of the subset (§7.2); a data position typed
`unknown` is told from an ordinary value by where the expression is
rooted (§7.8); a read of an optional property may be `undefined`
(§7.6); and `ReturnType` and `Parameters` are defined on both factory
types (§7.10).

Decided by the project owner:

- compiler trust is unconditional;
- `ifElse`, `when`, `unless`, and the `str` tag are removed (§4.4.3);
- a function body may bind a handler and read context (§5.2);
- a `map` element is keyed by its value or its cell identity (§4.4.1);
- `reduce`, `findIndex`, `some`, `every`, and `find` are reactive
  constructs (§4.4.1);
- a per-element body over plain values that declares a state cell without
  using the index is a compile error, and one that binds a handler and
  declares no state cell is accepted: equal elements bind equal state and
  share one stream (§4.4.1);
- where a per-element body over plain values instantiates a child, the
  position joins the element key, so equal elements have a child each
  (§4.4.1);
- the scheduler is switched per space: a space runs the builder path or
  the compiled path and never both (§10; `execution-and-storage.md`, §9);
- a handle type may hold a handle type, `get()` on the outer handle
  returns the inner one, and `key` flattens every handle it passes
  through (§4.7, §7.2);
- a function type is refused anywhere in a type used as data, with no
  exception for a type that describes a value probed for a method (§7.9);
- a default is static, and a default named by `typeof` of a constant whose
  initializer is a call is refused (§8.8);
- a handle of `T` is assignable to the same kind of handle of `unknown`
  (§7.5.1, §7.8);
- `typeof` of a module-scope constant with a static initializer is a
  legal label atom, and a legal action or pattern name of a
  trusted-action alias, and stands for the constant's value (§8.5);
- an authored function called in tier R is not bound by reference: its
  arguments are checked by the ordinary rule (§7.5.2);
- `Cell<T>` is not assignable to `Cell<T | undefined>`, nor the reverse
  (§7.5.1);
- `object` is a type of the subset, to which a handle is assignable
  (§7.1);
- a handler factory may be received as a value and bound (§4.4.2);
- a handler binding made in a function body copies a scalar and a
  container the body computed, and binds a container that has a stored
  address by reference; a binding made in tier R copies nothing (§5.2,
  §4.6);
- a collection method on a cell handle in a function body is a compile
  error with two corrections, and the compiler does not rewrite it (§4.7);
- a `lift` or a `computed` may instantiate a pattern, and that pattern may
  request effects (§5.2);
- an instance made in a `lift` or a `computed` is identified by the
  enclosing instance, the body's name and the calls and callbacks it is
  written in, the site, and the ordinal, or by an explicit cause in place
  of the ordinal; the compiler warns on an instantiation in a loop or a
  callback of a function body that has no cause; and a `lift` or a
  `computed` does not request an effect directly (§5.2);
- an explicit cause in a handler names the same thing on every event, and
  without one an identifier minted in a handler derives from the event
  (§5.2);
- a default belongs to the stored place: a callee bound by reference gets
  a link, the link carries the schema with the default, and the callee
  reads the default where nothing is stored, whatever its own type
  declares (§7.5.2, §7.6.1);
- `elementById` on a handle of `U[]` yields a handle of the same kind of
  `U | undefined`, and does not flatten (§4.7);
- an argument bound by reference has the declared type of its path:
  narrowing and `!` do not change the type of a place (§7.5.2, §7.6,
  §7.7);
- on a data position typed `unknown` the only test is against
  `undefined`, a kind test narrows nothing, and a key of older data that
  code reads as a string is declared `string` (§7.8);
- a writable view wider than the declaration of a place is refused, with
  no exception for migration code: an input whose stored data has an
  older or a partial shape declares that shape (§7.5.1).

Decided by `plan-and-label-templates.md`: a dynamic key is a chosen child
that does not observe the container's enumeration (its §3.18); `reduce` and
`findIndex` have label rules (§3.13); a handler binding made in a body has a
plan record (§3.14); the report `cfc-flow:ui-contract` is a warning (§4.4,
with the assumption among that document's open questions); and stored data
that does not match its declared type reads as `undefined` exactly where
the type admits `undefined` or declares a default, and otherwise fails the
cone that reads it (§5.2). The last is what keeps the strict `null` checks
of §7 sound: value code never sees a value its type excludes.

Questions 15, 16, 17, 21, 25, 26, 29, and 34 need a decision from the
project owner. The
[continuation plan](../../plans/compiled-pattern-language.md) lists the
first three as its questions 49 with 60, 28, and 59. It lists 21, 25,
26, and 29 as its questions 72, 82, 78, and 93, and does not list 34.
The others do not need the owner. Each names
the document it is addressed to. The numbers 9, 14, 19, 30, and 33 are not in
use, so that the other numbers stay as other documents cite them.

1. **Whether declared types can replace every re-typing overload** (to the
   prototype). §12.4 removes the idiom without a new construct, on the
   argument that a footprint, not the declared type, decides what a function
   body loads. The two such functions in
   `patterns/system/fabrichat/manager.tsx`, `inboxOf` and `joinStreamOf`,
   are the test: the prototype has
   to show that widening the declared link type there changes neither what a
   handler loads nor the stored schema's compatibility. If it does, the
   fallback is a re-typing operation on cells, whose label rule would need a
   CFC ruling.
2. **Inline records in a stored list** (to `plan-and-label-templates.md`).
   The checker treats an object-typed element of a list read from an input
   or a cell as identified by its cell (§4.4.1). A stored array can still
   hold inline records, when a computation elsewhere produced it.
   *Assumed,* as that document's §1.3 has it: a body over such a list that
   declares a state cell without the index compiles, and the cone
   instances of an element that arrives inline fail at run time, with the
   error state of its §5.2. A body that binds a handler and declares no
   state cell is accepted whatever its elements are.
3. **A pattern closure written in a function body** (to the prototype).
   §4.4.2 allows a pattern closure as a value in tier R only. A handler that
   wants to store a closure over its own locals has no form for it. No
   corpus site needs one.
4. **Instance-to-view assignability** (to the prototype). §7.5 lets a
   pattern instance stand where a view of its result is declared. The
   prototype has to confirm that this, with labels outside assignability,
   removes the 22 casts of §11.3, and whether a handle needs a further rule.
5. **Cells as arguments of imported functions.** §5.5 refuses them.
   Allowing them needs a declared write footprint in the signature.
6. **External packages.** The corpus's pattern modules import none. The
   iframe guests import several, and they are not patterns. Whether tier I
   ever reaches beyond the program's own modules is deferred with the
   sandbox's dynamic-import question.
7. **Stored source** (to `execution-and-storage.md`). Today some authoring
   errors are demoted to warnings when stored source is recompiled. By
   ruling a space is switched to the compiled path as a whole, and that
   document's §9.4 compiles the stored source of each of its instances at
   the switch. *Assumed,* with its open questions 27 and 70: stored source
   is compiled with the authoring severities of §10, the interim
   acceptance of the removed forms (§4.4.3) included, and no error is
   demoted; and a space with an instance whose source the compiler
   refuses is not switched, so one refused source keeps its whole space
   on the builder path.
8. **Per-instantiation checking of generic functions** (to the prototype).
   §7.3 checks a generic function body once per instantiation. That is
   simple and exact, and it reports an error in a generic helper at each
   call that triggers it. The prototype should confirm that the messages
   stay usable.

<!-- The list restarts so that the numbers below stay as cited. -->

10. **How an author writes the cache-promotion directive** (from
    `execution-and-storage.md`, §8.5 and open question 26). That document
    assumes the plan records one of three directives for a cone (none,
    always, never) and that this document defines how an author writes
    them. This document has no form for it. *Assumed,* as
    `plan-and-label-templates.md` §1.4 has it: until a form is defined, no
    program states a directive, a compiled plan leaves `Cone.cache` absent,
    and the runtime decides.
11. **Whether the inputs of a function body have read-only types** (from
    `footprint-analysis.md`, request 6). If the value a body receives had a
    deeply read-only type, as module-scope data has (§3.3), an update in
    place of an input would be a type error, and the widening cause W5 of
    that document would have no instance. *Assumed:* inputs are mutable in
    the type system, and W5 stands.
12. **`cell.get() === undefined` on a cell whose type does not admit
    `undefined`** (from `footprint-analysis.md`, request 14; to the
    prototype). The corpus tests whether a link has resolved by comparing
    `cell.get()` with `undefined`, on cells whose declared value type
    excludes it. Under `plan-and-label-templates.md` §5.2 such a read fails
    its cone and does not return `undefined`. *Assumed:* the type has to
    say so, `Cell<Profile | undefined>`, and the checker does not report
    the comparison where the type excludes `undefined`. The prototype has
    to measure how many cells the idiom is used on.
13. **What a kind test sees at a data position typed `unknown`** (from
    `footprint-analysis.md`, request 17). Not open: ruled. The only test
    of such a position is against `undefined`, a kind test sees the
    reference and narrows nothing, and a conversion to a string yields
    nothing of the content (§7.8). The entry keeps its number because
    other documents cite the entries after it by number.

<!-- The list restarts so that the numbers below stay as cited. -->

15. **A `computed` that instantiates a pattern or binds a handler is not
    promoted** (to the project owner; the continuation plan's question
    49, which names the instantiation). Promotion would compile the call
    or the binding into the surrounding instance, and so change which
    documents exist, how the state inside is named, and, for a binding,
    what it copies (§6.1). *Assumed:* neither is promoted.
16. **When the identity-alias typings are published** (to the project
    owner; the continuation plan's question 28). Until they are, an
    accepted program can show an editor error, against rule 2 of §2, in
    the one shape §8.6.1 names. *Assumed:* they are published when the
    transformer is retired, the overview's last stage.
17. **An explicit cause in tier R** (to the project owner). In tier R
    `X.for(cause)` and `h.for(cause)` on a handle take a string literal
    only, and the literal takes the place of the declaration's name in
    the identifier of the state cell (§4.7, §4.6). A cause that is data is
    legal only in a function body. *Assumed.* The alternative lets a
    tier-R cause be data, and `plan-and-label-templates.md` (§1.3) would
    then have to say what such a cause contributes to the identifier and
    how its label reaches a link to the cell.
18. **Where the pure API functions and `sqliteDatabase` are legal** (to
    `builtin-inventory.md`, `plan-and-label-templates.md`, and
    `footprint-analysis.md`). §4.4.4 gives the tiers of each pure API
    function, which `builtin-inventory.md` marks as assumed, and §4.7 has
    `sqliteDatabase` in tier R only, with a static `tables` option.
    *Assumed:* `plan-and-label-templates.md` records the table
    declarations as constants of the operation, and
    `footprint-analysis.md` (§3.4) has a transfer rule for each function
    of §4.4.4. The row-label rule of `table` is the one function argument
    a tier-R call takes outside the collection methods and the builders.
    The corpus writes it, and the regular expressions it uses, in pattern
    bodies; whether those sites meet the static rule of §4.7 has not been
    measured.

<!-- The list restarts so that the numbers below stay as cited. -->

20. **A `new` of a Fabric value class in tier R** (to
    `builtin-inventory.md` and the prototype). §4.4.4 lists the Fabric
    value classes among the pure API functions of tier R, and §4.3 refuses
    every `new` there other than a cell constructor
    (`reactive:unsupported-expression`). The four refused `new`
    expressions of §11.3 include `new FabricBytes(...)` in a catalog
    story. *Assumed:* §4.3 governs, and a Fabric value is constructed in a
    function body or at module scope. The alternative accepts the
    construction in tier R as a primitive operation, and the count of
    §11.3 falls by one.
21. **A state cell beside a child in a per-element body over plain
    values** (to the project owner; the continuation plan's question
    72; `plan-and-label-templates.md`, §8, questions 34 and 37). Where
    such a body instantiates a child, the position joins the element key
    (§4.4.1), so a state cell declared in the same body has a key per
    position and is not shared. *Assumed,* with that document: the body
    is accepted. Deleting the child then makes the cell an error. The
    alternative keeps the error as worded and has the author use the
    index. Two readings are assumed with it. A pattern that a `lift` or
    a `computed` written in the body instantiates is a child for this
    rule. A statically resolved pattern called in the body is not: it is
    compiled into the surrounding instance, and a state cell it declares
    is reported as a state cell of the body.
22. **What `key` flattens beyond the ruled case** (to the prototype and
    to `plan-and-label-templates.md`). The ruling gives `key("a")` on a
    `Cell<{ a: Cell<T> }>` the type `Cell<T>`. §4.7 assumes two points
    it does not state. The flattened handle has the kind the inner handle
    is declared with, also where the outer handle is one that cannot be
    read (`WriteonlyCell`, `ComparableCell`, `OpaqueCell`); the
    alternative gives it the capabilities both declare. A property whose
    type is a union of a handle type and a member other than `null` and
    `undefined` is not flattened. That `elementById` does not flatten,
    and that it yields a handle of the element type or `undefined`, is
    ruled (§4.7). What a read returns through the flattened handle of
    an optional property that is absent is the matter of question 12.
    The published declarations of `key` and of `elementById` have to
    change with the rules (§8.6.1).
23. **A cell handle is not assignable to a structural object type** (to
    the prototype). §7.5 refuses a `Cell<T>` where a `{ get(): T }` is
    declared, on the ruling that a declaration says whether a value is a
    cell, and because a read through such a parameter is a method call
    that footprint analysis cannot see as a read of a cell. The refusal
    is intended. The prototype reports about 25 arguments that pass a
    cell to such a parameter (§11.3). Each of those helpers declares
    `ReadonlyCell<T>`, which accepts a cell of every type assignable to
    `T` (§7.5.1). The alternative makes a handle assignable to an object
    type whose methods it has, and then footprint analysis needs a rule
    for a call through such a type.
24. **An intersection with an opaque API type** (to the prototype and to
    `builtin-inventory.md`). §7.4 refuses an intersection with an operand
    that is a handle type, a factory type, a function type, or an opaque
    named API type such as `VNode`. For the first three the rules of this
    document decide it. For an opaque API type they do not: §7.2 does not
    give its structure. *Assumed:* refused. The alternative lists the
    properties of each such type, and the intersection then merges as two
    object types do. The prototype has to count the sites among the 25
    intersections of the corpus (§11.4).
25. **Which initializers are static for a default** (to the project
    owner, with the first of the two extensions §8.8 names). The ruling
    refuses `typeof` of a constant whose initializer is a call. §8.8
    accepts a literal, an array or object literal of static initializers,
    and a reference to another constant whose initializer is static.
    *Assumed:* an initializer with a spread, an operator, or a template
    literal with a substitution is refused, and so is `typeof NAME.path`,
    although the compiler could compute each. Where the line between
    "takes from the source" and "computes" lies is the owner's to draw
    when the extension is designed.
26. **Which bodies the warning for an instantiation without a cause
    covers** (to the project owner; a detail of the continuation plan's
    question 38). The ruling has the compiler warn on an instantiation
    inside a loop or a callback in a function body that has no
    `.for(cause)`. *Assumed:* the warning is reported in a `lift`, a
    `computed`, an `assert`, and an authored function one of them or
    tier R calls, where the ordinal names an instance from one evaluation
    to the next, and not in a `handler`, an `action`, or an inline event
    handler, where each event makes its instances anew (§5.2).
27. **A rest element in a tuple type** (to the prototype). §7.9 refuses
    `[string, ...number[]]` (`subset-type:tuple-rest`), because §7.1
    lists no tuple of open length and the schema of one is not specified
    here. *Assumed:* refused. The prototype has to count the sites in the
    corpus, which the script did not.
28. **A write through a handle bound to a value the instance computes.** Not
    open: ruled, and §7.5.2 states it with `plan-and-label-templates.md` (§3.11
    and §3.15; its question 42). A write through a handle bound to a value the
    instance produces is refused at run time, which rejects the event's
    transaction in a handler, and the compiler reports the argument where the
    callee writes through the handle (`binding:write-to-computed`, §10.2). Where
    the bound place holds a reference to a stored place, the write lands there.
    An argument given to a pattern that a function body instantiates is the
    initial value of the child's stored argument, and the child writes it
    freely. The entry keeps its number because other documents cite it. The
    prototype has to count the arguments that name a computed value where a
    writable handle is declared.
29. **Whether a write through a handle of `unknown` is refused** (to
    the project owner; the continuation plan's question 93). By ruling,
    a handle of `T` is assignable to the same kind of handle of
    `unknown` (§7.5.1). §7.8 lets a body write any data value through
    such a handle, and relies on the stored-data rule to protect the
    other holders of the cell (`plan-and-label-templates.md`, §5.2).
    The owner is considering the alternative: a write needs a specific
    type, so `set`, `update`, the array writes, and `send` through a
    handle of `unknown` are refused, and a `Cell<T>` is then given where
    a `ReadonlyCell<unknown>` is declared, which the first row of the
    table of §7.5.1 already accepts. *Assumed* until it is ruled: the
    write is legal. The prototype's count (prototype): 82 sites pass a
    handle of a known `T` where a handle of `unknown` is declared. For
    33 of them the alternative needs only the declaration retyped to
    `ReadonlyCell<unknown>`. The other 49 need more: 33 are the generic
    control `SelectControl`, whose `value: Writable<unknown>` is bound
    to `<cf-select $value>`; 9 call `resolveAsCell`, which
    `ReadonlyCell` does not have (§4.7); and 5 are stored record fields
    that an overload re-types later. Three authored sites write
    directly through a handle of `unknown`. This document does not
    design the alternative.
31. **What the by-reference rule leaves refused** (to the prototype).
    §7.5.2 is narrower than the published typings in six places. Two
    are ruled: an argument of an authored function called in tier R is
    not bound by reference, and a value of `T` is refused where
    `Cell<T | undefined>` is declared, and the reverse, unless the
    declared property is optional. A third is ruled too: an argument
    that is a value has the declared type of its path where a handle is
    declared, whatever narrowing surrounds it. Three are decided in
    this document: a handle that cannot be read is refused where a
    value is declared, a value is refused where an `AnyCell` is
    declared, and the state of a handler binding made in a function
    body is checked by §7.5 alone (§7.5.3). The prototype has to count the
    sites of each among the remaining mismatches.
32. **The event types of host elements** (to `builtin-inventory.md`).
    §7.10 refuses the type names of the DOM library, and a handler
    declares the shape of the event it reads. The corpus has four such
    references (§11.3). *Assumed:* an author learns the shape of the
    event an element delivers from the documentation of the element.
    The alternative has `builtin-inventory.md` list, for each host
    element, the event types it delivers as object types of the API,
    such as one for the event of `cf-input`.

<!-- The list restarts so that the numbers below stay as cited. -->

34. **A default on a type that names `undefined`** (to the project
    owner; from the prototype). The table of §7.6.1 gives the body's
    read of an optional property whose type declares a default as the
    value type without `undefined`. It does not say what the read is
    where the value type itself names `undefined`, as in
    `glaze?: Default<string | undefined, "plain">`. *Assumed:* the
    checker removes the `undefined` the `?` adds and keeps the one the
    type names, so the read is `string | undefined`. The published
    typings remove both (`RequireDefaults` in `base/api/index.ts`), so
    under the assumption the checker reports a use that an editor
    accepts. The alternative removes both, and then the declaration
    says something the body's type does not: that `undefined` can be
    stored at a place that has a default.
35. **The declared type of a path whose prefix is narrowed** (to the
    project owner; from the prototype). By ruling, an argument bound by
    reference has the declared type of its path, and a condition that
    narrows the value does not narrow the handle (§7.5.2). The ruling is
    stated for a condition on the place the argument names. It does not
    say what the declared type is where the path is legal only because a
    condition narrowed a prefix of it: `order.note.text` under
    `order.note !== undefined`, with `note?: Note` declared, or a
    property that one member of a union declares, under a test of the
    discriminant. *Assumed:* the declared type is that of the last step
    of the path, read in the type the checker has for the prefix, with
    the narrowing of the prefix applied. So `order.note.text` binds a
    handle of `string`, and is accepted where the callee declares a
    required `Writable<string>`. The alternative applies the ruling at
    every step: the handle has `undefined` in its type wherever a step
    of the path may be absent, so the argument is a handle of
    `string | undefined`, and the callee declares that or declares the
    property optional. Under the assumption the callee holds a handle
    typed `string` to a place where nothing is stored once `order.note`
    is cleared, and what a read through it returns then is the matter of
    question 12.
36. **Which read and which append `mergeable-push:read-then-push`
    reports** (to the project owner and to `footprint-analysis.md`; from
    the prototype). The diagnostic carries, and the catalog fixes the
    bodies and the two methods (§10.3). Two parts of the condition are
    not fixed. Today the check reports an append only where the body
    reads the collection at the same path, with `get()` or by iterating
    it, and either the append depends on the read, through a condition
    around it, an earlier exit, or the appended value, or the body makes
    another write to the collection; a read that feeds neither is not
    reported (`createMergeablePushClassifier` in
    `base/ts-transformers/src/policy/mergeable-push-classification.ts`).
    That check follows names through the text. The abstract values of
    `footprint-analysis.md` §2.1 do not record what a `Computed` value
    was computed from, so the analysis cannot decide the dependence as
    it stands. *Assumed:* the report is made for every append through a
    handle whose cell the body read with `get()` or `sample()` earlier in
    the order of evaluation, at the path appended to, above it, or below
    it, whether or not the append depends on the read. That reports more
    sites than today. The alternative adds to the analysis a record of
    which reads a condition and a value derive from, and keeps today's
    two cases and its silence for an unrelated read.
37. **A statically resolved pattern on a cycle of calls** (to the project
    owner; from the prototype, and `plan-and-label-templates.md` §8,
    question 45). A pattern that calls itself in tier R, directly or
    through other statically resolved patterns, has no finite plan when
    every such call is compiled in
    ([§4.4.2](#442-patterns-and-handlers-as-callees)).
    *Assumed:* the call is refused, and the catalog of §10.2 has no
    entry for it yet. The alternative gives the call that closes the
    cycle a child with a plan and a result cell of its own, as a call of
    a factory value has, which changes what the call denotes at that one
    place. The prototype compiles such calls in to a depth of eight and
    counts the deeper ones.
38. **Two refusals that look intended** (to the project owner; from the
    prototype). [§7.5.4](#754-two-refusals-that-follow-from-these-rules)
    states both. A handle of `T | undefined`, which `key` on an
    optional property yields, is refused where a callee declares an
    optional `Writable<T>`, though the same place named as a value path
    is accepted. An array of pattern results is refused where a cell of
    an array of a type the result type is assignable to is declared,
    though one such result is assignable to a cell of that type.
    *Assumed:* both refused. The alternatives extend the point on
    `undefined` of §7.5.2 to a handle, and the rule for an instantiation
    result of §7.5 to an array of them. The corpus has one site of each,
    in `patterns/system/fabrichat/room.tsx` and
    `patterns/system/quick-capture/quick-capture.tsx`, and one module is
    refused for each.
39. **A hint for a writable handle that is bound to a produced value and only
    read** (to the project owner; from the prototype). Where a callee declares
    `Writable<T>`, the argument is a value the instance produces, and the
    callee's record has no write edge and no write envelope through the handle,
    nothing is refused, and `binding:write-to-computed` (§10.2) is not
    reported. *Assumed:* no diagnostic. The declaration is the callee's, the
    binding is legal, and the message of `binding:write-to-computed` names the
    correction for the case that is refused. The alternative is a hint at the
    callee's declaration, and not at each binding, that a property declared
    `Writable<T>` is never written and can be declared `ReadonlyCell<T>` or as
    the value. It would be a fourteenth diagnostic computed after the type
    checker, from the callee's record alone. The prototype counts the bindings
    of this kind and reports none.
40. **Where `binding:write-to-computed` is positioned for a pattern compiled
    in** (to the project owner; from the prototype). A diagnostic of a module
    has a position in that module, and the binding that writes can be in
    another module, inside a pattern compiled into the plan. *Assumed,* as
    §10.2 has it: the position is the expression of the compiled module that
    supplies the produced value, at the outermost call or tag the value passes
    through, and the message names the inner binding by file and line. The
    prototype positions the report at that call or tag as a whole. The
    alternative reports in the module of the inner binding, which reports a
    pattern for what one of its callers gives it. A pattern compiled by itself
    is not reported for the path, since the path is its input there.
