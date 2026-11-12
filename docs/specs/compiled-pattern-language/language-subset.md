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
a promoted `computed`.

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
   how the typings keep this true for labels.
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

**Builder definition.** A call to one of the three module-scope builders:
`pattern`, `lift`, or `handler`. The callback argument is a function written
at the call, or the name of a function or function-valued constant declared
in the same module. A callback reached through a property, an import, or a
call is refused (`builder-callback:indirect-reference`).

The other builders are not module-scope builders. `computed` and `assert`
take a function and are written in tier R only (§4.4). `action` takes a
function and is written in tier R or in tier F (§5.2).

Every other API function called at module scope is a plain function whose
result is frozen data, or a compile-time intrinsic: `exchangeRule(...)` and
`exchangeRules([...])`, which freeze and return a rule declaration that the
CFC authoring contract requires to be exported and static; `toSchema<T>()`,
which the compiler replaces with the schema of `T`; and `schema(...)`,
`dataFile(path)`, `table(...)`, the `cfcAtom` and `cfcPattern`
constructors, and the Fabric value classes.

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
| Element access `a[k]`, `a?.[k]` | Static when `k` is a literal, a module-scope constant of literal type, or a well-known key (`UI`, `NAME`, `SELF`, and the others the API exports). Dynamic otherwise | Path projection when static; chosen child when dynamic |
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
constructors; `this`; `class`; a tagged template; `void`;
the comma operator; a getter, a setter, a method, or a function-valued
property in an object literal; and `instanceof`.

### 4.4 Calls

A call in tier R is classified by its callee, in this order. A call that
matches none of the rows is refused (`reactive:unsupported-call`). A read of
the ambient clock or entropy and a call of a removed form are refused under
their own identifiers instead (`function-body:ambient-read`, §5.1; the
`removed-form:` entries, §4.4.3), because wrapping either in `computed` does
not make it legal.

| Callee | Arguments | Meaning |
| --- | --- | --- |
| `xs.map(f)`, `xs.filter(f)`, `xs.flatMap(f)`, `xs.some(f)`, `xs.every(f)`, `xs.find(f)`, `xs.findIndex(f)`, `xs.reduce(f, initial)` where `xs` has an array type | A callback written at the call ([§4.4.1](#441-collection-callbacks)) | Reactive collection operation |
| An aggregate (`count`, `sum`, `min`, `max`, `minBy`, `maxBy`) or a collection index (`groupBy`, `keyBy`, and `lookup`, `keys`, `keyEntries` on an index) | A selector or predicate callback where the method takes one, with the grammar of a `map` callback | Structural operation |
| A standard-library function or method marked "R" in [§9](#9-standard-library-surface) | Tier-R expressions; no function arguments | Primitive operation |
| An authored function, or a `lift` result | Tier-R expressions; no function arguments | Sandboxed call |
| `computed(f)`, `action(f)`, `assert(f)` | `f` is a function written at the call; its body is tier F, unless the `computed` is promoted ([§6](#6-promotion-of-computed)) | Sandboxed call, or the promoted expression. `assert` is the marker pattern tests use, and yields the test record the API declares |
| A handler: a `handler(...)` definition called by name, or a value of a handler factory type | One object argument: the state binding ([§4.4.2](#442-patterns-and-handlers-as-callees)) | Stream |
| A pattern | One object argument ([§4.4.2](#442-patterns-and-handlers-as-callees)) | Sub-pattern |
| A cell constructor or a method of a cell handle | [§4.7](#47-cell-and-handle-methods) | State cell, path projection, chosen child, or read |
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
- **Dynamic keys are allowed.** `scopes[key]` is a chosen child (`pick` in
  `plan-and-label-templates.md`, §3.18) at every tier-R site. It observes
  the key and the one child it selects, not the container's other children. The
  transformer's refusal of a bare dynamic key in the pattern body goes away for
  the same reason.
- **Function arguments are refused** except in the first two rows and the
  builders. `xs.toSorted(compare)`, `xs.forEach(...)`, and
  `text.replace(pattern, fn)` are tier-F code: the author wraps the
  expression in `computed(() => ...)`.

#### 4.4.1 Collection callbacks

The callback of `map`, `filter`, `flatMap`, `some`, `every`, `find`, and
`findIndex` is an arrow function written at the call. The four predicates
follow exactly the rules of a `filter` callback. It takes the element and,
optionally, the index. A third parameter (the whole array) is refused
(`collection:callback-parameters`). Its body follows §4.2: an expression, or
`const` declarations and one final `return`. The body is compiled once against
an element slot.

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

**Element keys.** Each element of a `map` has a cone, and the cone has a
key. The key is the element's value when the element is a plain value, and
the identity of the element's cell when it is not. An element that moves
keeps its cone, so reordering, inserting into, or removing from a list does
not recompute the elements that stayed. Stored per-element state from
earlier versions of a pattern is not preserved by this rule; it is chosen
for recomputation cost. A key derived from a value is salted with a secret
of the space before it enters a document identifier, so that an identifier
does not reveal the value (`plan-and-label-templates.md`, §1.3).

**The index parameter costs the author that property.** The index is part
of an element's key exactly when the callback declares the index parameter
and its body uses it. Such a cone cannot move: inserting at the front of a
list of a thousand elements recomputes a thousand cones, where a callback
without the index recomputes one. The compiler reports the use as a hint
(`collection:index-keyed`). A callback that declares the index and does not
use it is keyed without it.

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

**Equal plain values may not share state.** Two elements with the same
plain value have the same key, so they share one cone. That is sound for a
value, which is a function of the element. It is wrong for state: two rows
that show `"glazed"` would share one "expanded" flag and one click stream.
So the body of a per-element construct (`map`, `filter`, `flatMap`, the
predicates, and the selector callbacks of the aggregates and indexes) over a
collection of plain values is refused when it declares a state cell or
binds a handler, in any of the spellings of §5.2, without using the index
parameter (`collection:shared-element-state`).

For this rule the checker decides "plain value" statically, from the
element type and from where the collection comes from.

- **Always plain:** an element type that is a primitive, a literal, `null`,
  `undefined`, a factory type, or a union of those. A factory value is a
  reference to a compiled definition (§7.2) and has no cell of its own, so
  two equal factories in a list have one key.
- **Never plain:** an element type that is a cell handle type or a pattern
  instance. Such an element is identified by its cell.
- **An object, array, or tuple element type** is plain when the collection
  is a value computed in the program: an array literal, a module-scope
  constant, the result of a tier-R construction such as another `map` that
  builds object literals, or the result of a `computed`, a `lift`, or an
  authored function. It is not plain when the collection is read from the
  pattern's input or from a cell. A record written into a stored array by
  `set`, `push`, or `addUnique` is stored as a document of its own and the
  array holds a link to it (`builtin-inventory.md`, "Element keys"), so such
  elements are identified by their cells.
- **A union** of a plain and a non-plain type is plain.

The rewrites are the two the rule names. Take the index and use it, which
puts the position in the key at the cost described above. Or make the
elements cells, by keeping the list in a cell that a handler writes records
into, or by mapping over a list of records that carry what distinguishes
them.

```tsx
// Shown for illustration only.
// Refused: two "glazed" rows would share `open` and the click stream.
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
```

One case is outside what the checker can decide: an input declared with an
object element type whose stored array holds inline records, because a
computation elsewhere produced it. The checker treats it as not plain.
*Assumed:* a body over such a list that declares a state cell or binds a
handler without the index compiles, and the cone of an element that arrives
inline fails at run time (`plan-and-label-templates.md`, §1.3;
[§13](#13-open-questions)).

The rule covers a state cell and a handler binding. It does not cover a
body that instantiates a child, as `factories.map((Card) => Card({ donut }))`
does over a list of factory values. The child's result cell is named by the
element key, so two equal plain elements share one child and its state.
*Assumed:* such a body compiles ([§13](#13-open-questions), question 14).

#### 4.4.2 Patterns and handlers as callees

A pattern is called with one object argument, optionally through the
modifiers `asScope(scope)` and `inSpace(space, options)`. There are two
kinds of callee, and they differ in what the compiler can do.

- **A statically resolved pattern.** The callee is a `pattern(...)`
  definition imported by name or declared at module scope, or an inline
  `pattern(...)` expression. The compiler has its body. The call denotes an
  anonymous sub-pattern compiled into the surrounding instance, like the
  body of a `map`.
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
- **Tier F.** A function body does not write a pattern closure as a value.
  An inline `pattern(...)` there is legal only as the callee of an
  instantiation, in every kind of function body, a `lift` and a `computed`
  included (§5.1, §5.2).

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
arguments is accepted. The forms that take schemas first, a helper passed as
a value, and a helper reached through an alias are errors at once
(`removed-form:helper-unsupported`). The interim ends when the builder form
the transformer emits is retired, the overview's last stage: from then on
`removed-form:helper` is an error. It ends earlier for the pattern corpus
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
a handler binding. `plan-and-label-templates.md` (§1.3) owns the rule. Three
parts of it are visible in source.

- A declaration assigned to a `const` takes the name of the variable.
- A declaration assigned to nothing takes a base name from what it is: the
  callee's name for a call of a pattern or of a function body (an authored
  function, a `lift` result, `computed`); the built-in's or the method's
  name for an operation or a collection; the handler's name for a named
  handler applied to its state; and the attribute's name for an inline
  event handler.
- Where two declarations of one pattern body have the same name by these
  two rules, each takes the name and its ordinal among them, in source
  order.

So renaming a `const` renames the state declared under it. Adding or
removing a declaration with another name renames nothing. Adding an
unassigned declaration ahead of one with the same base name moves the
ordinals after it, which is the one case where an edit elsewhere in a body
renames stored state, and assigning the declaration to a `const` avoids it.

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
| `key(k)` | `Cell`, `ReadonlyCell`, `WriteonlyCell`, `ComparableCell`, `OpaqueCell` | R, F | Neither. Yields a handle of the same kind for the property |
| `elementById(idKey)` | `Cell`, `ReadonlyCell`, `WriteonlyCell`, `ComparableCell` | R, F | Neither. Yields a handle for the keyed element |
| `resolveAsCell()` | `Cell` | R, F | Neither. Follows the links from the handle until it reaches a cell whose value is not a link, and yields the handle of that cell. It observes the reference where the resolution ends, the links followed included, and reads no content |
| `getArgumentCell()` | `Cell` | F | Neither. Yields the handle of the argument of the piece the cell belongs to |
| `equals(other)`, `equalLinks(other)` | `Cell`, `ReadonlyCell`, `ComparableCell` | R, F | Neither. Compares identity |
| `for(cause)` | Every handle type, `Stream` included; and the value a pattern instantiation returns | R, F on a handle. On an instantiation, F | Neither. On a handle, sets the causal identity of a cell that has none yet. On an instantiation, `Box({ flavor }).for(cause)`, supplies an explicit cause for the instance's identifier |
| `set(value)`, `update(partial)` | `Cell`, `WriteonlyCell` | F | Writes |
| `push(...values)`, `pushAll(values)`, `addUnique(...values)`, `remove(...)`, `removeByValue(ref)`, `removeAll(...)` | `Cell`, `WriteonlyCell`, of an array | F | Writes. `push`, `pushAll`, `addUnique`, and `removeByValue` are mergeable |
| `increment(by?)` | `Cell`, `WriteonlyCell`, of a number | F | Writes, mergeable |
| `applyChanges(changes)` | `Cell`, `WriteonlyCell`, of a string | F | Writes |
| `send(event)` | `Cell`, `Stream` | F | Writes: delivers an event |
| `map`, `filter`, `flatMap`, `some`, `every`, `find`, `findIndex`, `reduce`, `count`, `sum`, `min`, `max`, `minBy`, `maxBy`, `groupBy`, `keyBy` | `Cell`, `OpaqueCell`, of an array | R | Reads, by the operation's label rule (§4.4). In tier F the method on a handle is refused (`cell:collection-method-in-function`), with the two corrections of the note below |
| `lookup(key)`, `keys()`, `keyEntries()` | A collection index handle | R, F | Reads the index |
| `query(sql, params?)` | A SQLite handle | R | Reads. Sugar for the `sqliteQuery` built-in |
| `exec(sql, params?)` | A SQLite handle | F | Writes to the database, in the caller's transaction |
| `new X(value)`, `X.of(value)`, `X.for(cause)`, and the same three under `X.perSpace`, `X.perUser`, `X.perSession`, for `X` among `Cell`, `Writable`, `OpaqueCell`, `Stream`, `ComparableCell`, `ReadonlyCell`, `WriteonlyCell` | The constructor | R, F | Creates a cell. In tier R it is a state cell of the plan. In tier F it is the cell-creation call of §5.2 |
| `X.equals(a, b)`, `X.equalLinks(a, b)` | The constructor | R, F | Neither. Compares identity |
| `asScope(scope)`, `inSpace(space, options)` | A pattern factory | Where the instantiation they modify is legal | Neither |

Eight notes on the table.

- **`for` on an instantiation.** The form is legal in every kind of
  function body. Its argument is the explicit cause of the instance, which
  `plan-and-label-templates.md` calls the tag. In a `lift` or a `computed`
  it takes the place of the site and the ordinal in the instance's
  identifier ([§5.2](#52-runtime-calls)). What it identifies from one event
  to the next in a `handler` or an `action` is not defined here:
  `plan-and-label-templates.md` (§1.3) owns the identifiers of what a
  function body creates.
- **`get`, `key`, and `elementById` in tier R** are operations of the plan
  and add no rule of their own (`plan-and-label-templates.md`, §3.18).
  `h.key("glaze")` is a path projection, like `h.glaze`. `h.key(k)` and
  `h.elementById(k)` with a key that is not a constant are a chosen child,
  like `a[k]` (§4.4): they observe the key and the one child it selects.
  `h.get()` reads the value at the handle's path.
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
  (`mapWithPattern` and its siblings; `removed-form:builtin`, §4.4.3) and
  the deprecated `setSchema` are not part of the language.

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
| `Date.now()`, `new Date()` with no argument, `Math.random()` in a `lift`, a `computed`, or an authored function they call | `function-body:ambient-read` | A computation is a function of its inputs. The read is allowed in a `handler`, an `action`, and an inline event handler. Written in tier R, the same read is refused under the same identifier (§4.4) |
| `pattern`, `lift`, `handler`, `computed` called in tier F | `function-body:builder-call` | Builders define nodes at module scope or in tier R. The exceptions hold in every kind of function body: an inline `pattern(...)` used directly as the callee of an instantiation, which the compiler hoists, and `action` (§5.2) |

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
| Request an effectful built-in | As `builtin-inventory.md` lists | Yes | Not directly (*assumed*, below). A pattern the computation instantiates may request effects in its own body. An effect that depends on computed data is written in such a pattern, or in tier R with the computed value as its input |
| Read context | `eventKey()`, `currentPrincipal()`; `principalOf` and its siblings; `spaceOf` and its siblings; `linksOf`; `equals(a, b)`; `getPatternEnvironment()` | Yes | All except `eventKey()` and `currentPrincipal()`: a computation has no event |
| Bind a handler | Below | Yes | Yes |

`builtin-inventory.md` ("Which body may make which call") has the same
table with the pattern body beside it, and gives the reasons row by row.
Each refusal has a diagnostic in [§10.3](#103-function-tier). An authored
function is held to the rules of the bodies that call it.

`equals(a, b)` is a context read because it observes the identity of both
operands and reads neither value (`plan-and-label-templates.md`, §3.16). It
is the function form of the comparison that §4.7 lists as the methods
`a.equals(b)` and `X.equals(a, b)`, and the three forms mean the same.

One difference between the two kinds of body explains the columns. A
handler invocation is a new frame for each event, so what it creates is new
and is identified by the event and the order of creation. A `lift` or a
`computed` is evaluated again whenever an input changes, so what it creates
needs an identifier that is the same on every evaluation: an explicit cause
for a cell, the place of the call for an instance, and the bound state for
a handler binding.

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

Two points are assumed, and both are in one question for the project
owner ([§13](#13-open-questions), question 9).

- *Assumed:* the instance is identified by the enclosing instance, the
  site, and the ordinal of the instantiation among those the evaluation
  makes at that site, or by an explicit cause where the author writes
  `.for(cause)` on the instantiation (§4.7). A site that runs once per
  evaluation needs no cause. A site in a loop names its instances by the
  order in which the loop makes them, so removing the first record of a
  list gives each instance the argument of the next record and tears down
  the last instance. An author who wants each instance to stay with its
  record writes `.for(cause)` with a cause taken from the record.
- *Assumed:* a `lift` or a `computed` does not request an effect directly
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
`{ ...donut }` and `[...donuts]` are computed containers. How much of a
computed container the copy holds is decided by what the bound handler
reads of it: the copy holds the paths the handler's footprint names, and
for a handler received as a factory value, whose body the compiler does not
have, the paths its declared state type covers (`footprint-analysis.md`,
§8.5).

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
  of a tier-I function are data types (§5.5). Such a function receives no
  cell handle and no function, and a call of it reads each argument in
  full.

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
- **Parameters and results are data types.** A cell passed to such a function
  could be written without the plan knowing, so cell-typed parameters are
  refused (`import:signature-not-data`) until
  [§13](#13-open-questions) is settled. A function-typed parameter is
  refused by the same rule, because a function type is a code type.

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
     expression-shaped and pure; `reduce` with an
     expression-bodied callback and an initial value (§4.4.1); or an
     aggregate or collection-index method of §4.4;
   - a standard-library function or method marked "R" in §9;
   - an authored function or a `lift` result, with no function arguments;
   - `.get()`, `.key(k)`, `.elementById(k)`, `.resolveAsCell()`, `.equals(x)`,
     or `.equalLinks(x)` on a cell (§4.7).
5. **Nothing else occurs in the body.** In particular it creates no cell,
   instantiates no pattern (including by a JSX tag that names one), requests
   no effect, and writes nothing. A `computed` that instantiates a pattern
   is legal (§5.2) and is not promoted, because the two tiers give the
   call different meanings. In a function body the instance belongs to the
   computation and has a result cell of its own, named by the site of the
   call. In tier R a call of a pattern the compiler can resolve is compiled
   into the surrounding instance (§4.4.2). Promoting the call would change
   which documents exist and how the state inside is named.

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
| `PatternFactory<I, O>`, `HandlerFactory<E, S>` | Factory types, and data types: a value is a reference to a compiled definition, so it may sit in a pattern input or result, a cell, a handler's state, or an event. Calling one follows §4.4.2. The result of `pattern(...)` has the first type and the result of `handler(...)` the second. The result of `lift(...)` is a function, a code type |
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

The two uses meet where a body receives a data position typed `unknown`.
The body is handed a reference there, whatever is stored behind it. It can
test the reference for presence, compare it with `equals`, and pass it on,
and it cannot read through it.

- **A test of presence** (`=== undefined`, `??`, `?.`, truthiness) returns
  whether something is stored at the position. A stored `0`, `""`, `false`,
  or `null` is something, so the position is truthy.
- **A kind test** (`typeof`, `Array.isArray`, `instanceof`) sees the
  reference and not the kind of what is stored behind it. A stored string
  and a stored record give the same result, so a kind test does not narrow
  such a position to the stored type. A body that needs the value declares
  the position with the type it reads.
- **A conversion to a string** (`String(x)`, a template literal) converts
  the reference. The string is a function of the reference alone and holds
  nothing of the content.

`footprint-analysis.md` (§2.2) records a test of presence or kind there as
an observation of the position's shape, and a conversion as an observation
of the reference's identity. That a kind test sees no more than presence is
how the runtime reads such a position today: it hands the body an empty
object that carries the address and nothing else (`createOpaqueReference`
in `runtime/runner/src/schema.ts`;
[`unknown`](../../common/concepts/types-and-schemas/unknown.md)). *Assumed:*
it stays so ([§13](#13-open-questions), question 13). A value typed
`unknown` that the body computed, such as the result of `JSON.parse` or the
variable of a `catch` clause, is an ordinary value, and a kind test narrows
it (§7.6).

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
| Function overloads | `subset-type:overload` | One signature with a union parameter, or two functions with different names. For the re-typing idiom, the rewrites of [§12.4](#124-replace-the-re-typing-overloads-with-declared-types) |
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
those checks report under. There is one for each kind of constraint that
document's §4.4 can fail at compile time: `cfc-flow:required-integrity`,
`cfc-flow:max-confidentiality`, `cfc-flow:write-floor`,
`cfc-flow:writer-fit`, and `cfc-flow:write-policy`, for a writer the policy
does not name. A sixth, `cfc-flow:ui-contract`, is a warning: it reports a
handler whose policy requires a UI contract when no element of the pattern
that binds the handler sits under a surface that carries the contract's
pattern.

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

The typings change when the transformer, which reads the brands, is retired
(the overview's last stage). Until then one difference remains: a generic
function that returns its unconstrained parameter as `Confidential<T, L>`
is accepted by the subset and reported by the editor, and `T extends {}`
satisfies both.

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
`Object.defineProperty` and the other reflective `Object` members. The
effectful built-ins of `builtin-inventory.md` replace the first four.

## 10. Diagnostics catalog

Severity is **error** (the program is refused), **warning** (accepted, and
the report is shown by default), or **hint** (accepted, shown on request).
Under the stored-source option of the current pipeline
(`TransformationOptions.storedSource`), some authoring-shape errors are
demoted to warnings so that already-deployed source reloads. In this
design, `execution-and-storage.md` §9.4 compiles an instance's stored source
when it migrates the instance, and an instance whose source is refused
stays on the builder path. The catalog gives authoring severities, and this
document assumes the same severities for stored source
([§13](#13-open-questions)).

"Status" compares with the diagnostics of
`ts_transformers_current_behavior_spec.md` §6 and the unsupported rows of
[`ts_transformers_target_pattern_language_spec.md`](../ts-transformer/ts_transformers_target_pattern_language_spec.md)
§4: **carries** (same identifier and condition), **changes** (same
identifier, different condition or severity), **new**, or **retired** (the
identifier is not reported).

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
| `pattern-context:callback-container` | error | An arrow function passed to a method or function that §4.4 does not give a callback position (`forEach`, `toSorted`, `findLast`, `replace`, `then`) | Wrap the whole expression: `computed(() => xs.toSorted((a, b) => a.price - b.price))` | changes (now covers every non-structural callback, in every tier-R site, not only JSX) |
| `reactive:unsupported-call` | error | A call in tier R whose callee matches no row of §4.4, such as a method the standard-library table does not mark "R". An ambient read and a removed form are not reported here: they are `function-body:ambient-read` and the `removed-form:` entries | Wrap the expression in `computed(() => ...)`, or call an authored function that does the work | new (replaces `pattern-context:receiver-method-call`, `pattern-context:inline-reactive-root-access`, `reactive:call-argument-computation`) |
| `reactive:unsupported-expression` | error | `new` of a non-cell constructor other than `new Date()` with no argument (which is `function-body:ambient-read`), `await`, `yield`, `this`, `instanceof`, a tagged template, `void`, or the comma operator in tier R | Wrap the expression in `computed(() => ...)` | new (replaces the remaining cases of `pattern-context:computation`) |
| `opaque-get:invalid-call` | error | `.get()` on a value whose type is not `Cell`, `Writable`, or `ReadonlyCell` | Read the value directly: `donut.name`, not `donut.get().name`. Only `Cell<T>`, `Writable<T>`, and `ReadonlyCell<T>` are read with `.get()` | carries |
| `pattern-context:self-access` | error | `x[SELF]` where `x` is not the pattern's own input parameter, or anywhere in tier F | Read `const self = input[SELF]` in the pattern body, or destructure `[SELF]: self`, and capture `self` | carries |
| `ses-callback:callable-capture` | error | A tier-F body inside tier R captures a function value from an enclosing function scope | Move the function to module scope | carries |
| `removed-form:helper` | warning | A direct call of `ifElse`, `when`, or `unless`, or a `str` tagged template, in tier R (§4.4.3). An error once the builder form is retired | The rewrite: `c ? a : b` for `ifElse(c, a, b)`, `c && v` for `when(c, v)`, `c \|\| f` for `unless(c, f)`, a plain template literal for `str` | new |
| `removed-form:helper-unsupported` | error | One of those four in any other form: with schema arguments, passed as a value, or through an alias | The same rewrite | new |
| `removed-form:pattern-tool` | error | A call of `patternTool` | Write an inline `pattern(...)` that captures the bound values, and pass it as the tool (§4.4.3) | new (replaces `pattern-context:patterntool-requires-pattern`, which is retired) |
| `removed-form:builtin` | error | A call, in any tier, of `llm`, `streamData`, `cell`, `byRef`, `nameInstance`, or a `...WithPattern` method (§4.4.3) | The replacement for the form found: `generateText` or `generateObject` for `llm`; a built-in of the fetch family for `streamData`; `Cell.of(value)` for `cell(value)`; the built-in imported by name for `byRef`; a `const` binding of the instance for `nameInstance`; the method without the suffix, with a callback written at the call, for a `...WithPattern` method | new |
| `collection:callback-parameters` | error | A reactive collection callback that is not an arrow function written at the call, or that takes the whole array as a parameter | Write the arrow at the call, with the element and at most the index. Capture the array by name if the body needs it | new |
| `collection:reduce-callback` | error | A `reduce` in tier R whose callback has a block body | Write the step as one expression, `(sum, donut) => sum + donut.price`. A step that needs statements is a loop inside `computed(() => ...)` | new |
| `collection:reduce-initial` | error | A `reduce` in tier R without an initial value | Pass the initial value as the second argument | new |
| `collection:reduce-accumulator` | error | A `reduce` in tier R whose accumulator type is a code type, such as a `Map`, a `Set`, or a function | Accumulate into an object, an array, or a primitive. To fold into a `Map`, write the loop inside `computed(() => ...)` and return data | new |
| `collection:index-keyed` | hint | A per-element callback uses its index parameter, so its element cones are keyed by position and recompute when elements move (§4.4.1) | Drop the index if the element can supply what it was used for, such as a stable identifier in place of `key={index}` | new |
| `cell:unsupported-method` | error | A method of the runtime's cell object that the API does not declare (§4.7), such as `asSchema` or `getAsNormalizedFullLink` | The declared method that does the job, or a declared type in place of a re-typing ([§12.4](#124-replace-the-re-typing-overloads-with-declared-types)) | new |
| `cell:collection-method-in-function` | error | `map`, `filter`, or another collection method of §4.7 called on a cell handle in tier F. The compiler does not rewrite the call | One of two corrections. To keep the result reactive, wrap the expression in an inline `pattern(...)` and instantiate it: `pattern(() => cell.map(...))({})`. To process the values the cell holds when the body runs, read first: `cell.get().map(...)` | new |
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
| `function-body:ambient-read` | error | `Date.now()`, `new Date()` without arguments, or `Math.random()` in a `lift`, a `computed`, or tier R, directly or through an authored function they call | Read the clock in a `handler` or `action` and store the value in a cell, or take the time as an input | new (the sandbox gate refuses the same read at run time) |
| `function-body:builder-call` | error | `pattern`, `lift`, `handler`, or `computed` called in tier F, other than an inline `pattern(...)` as the callee of an instantiation | Define the builder at module scope and call its result. A function body that needs a reactive value instantiates a pattern | new |
| `function-body:handler-capture` | error | An inline event handler or an `action` in tier F captures a `let` binding | Assign the value to a `const` before the handler and capture that | new |
| `function-body:cell-needs-cause` | error | A cell created in a `lift` or a `computed` without an explicit cause | Name it: `Writable.for<T>(cause)`, with a cause that is the same on every evaluation | new (a run-time throw today) |
| `function-body:effect-in-computation` | error | An effectful built-in requested in a `lift` or a `computed`, directly or through an authored function they call. An effect in the body of a pattern the computation instantiates is not reported | Write the effect in a pattern, inline or named, and instantiate the pattern in the computation: `PriceQuote({ url: priceUrl(order) })`, where the body of `PriceQuote` calls `fetchJson`. Or request the effect in the pattern body, with the computed value as its input: `const price = computed(...); const quote = fetchJson({ url: priceUrl(price) });` | new |
| `function-body:event-context-in-computation` | error | `eventKey()` or `currentPrincipal()` in a `lift`, a `computed`, or the pattern body | Read it in the `handler` or `action` and pass or store the value | new (a run-time throw today) |
| `collection:shared-element-state` | error | The body of a per-element construct over a collection of plain values (§4.4.1) declares a state cell or binds a handler without using the index parameter, so elements with equal values would share it | Take the index parameter and use it, for example in the cell's cause. Or make the elements cells: keep the list in a cell that a handler writes records into | new |
| `verb-result:undeclared-return` | error | A `handler` or `action` without a result type argument returns a plain value from a block body | Declare the result (`action<Event, Result>(...)`, `handler<Event, State, Result>(...)`), or use a bare `return;` | carries |
| `mergeable-push:read-then-push` | warning | A handler reads a mergeable collection and then pushes to it | Push without reading, or use the merge-safe operation the message names | carries |
| `footprint:widened` | hint | Footprint analysis gave up on an expression, for one of the causes of `footprint-analysis.md` §5.2 (§5.4). The report names what the widening covers: the input paths of the widened entries, which are several for a key that is not static, or the cell handle the analysis lost track of | The rewrite for the cause, as that document's §5.3 gives it: named properties in place of a key that is not static, the properties that are needed in place of a whole value that is converted or passed to an imported function, a copy in place of an update of an input | new |
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
| `import:signature-not-data` | error | A parameter or the result of a function imported from a tier-I module has a type that is or contains a cell handle type, a function type, or another code type (§5.5) | Pass and return data: read the cell in the caller and pass the value (`unitPrice(price.get(), glaze)`), and write the result in the caller. A function that needs the handle or a callback belongs in a subset module | new |
| `import:commonfabric-value` | error | A tier-I module imports a value from `commonfabric` or `commonfabric/<name>`, and not only types (§5.5) | Use `import type`. Move the code that calls a builder, a built-in, or a cell constructor into a subset module, and give the imported function the data it needs as arguments | new |

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
| `cfc-flow:write-floor` | error | The declared integrity of the value a write edge writes cannot satisfy the write floor of its target. The condition is defined in `plan-and-label-templates.md` §4.4 | The write, the slot whose declared integrity falls short, and the declaration to change: the integrity declared on the source, or the floor declared on the target | new (reserved here, specified there) |
| `cfc-flow:writer-fit` | error | The declared confidentiality of the value a write edge writes does not fit the confidentiality declared on its target. The condition is defined in `plan-and-label-templates.md` §4.4 | The write, the slot whose declared confidentiality exceeds the target's, and the declaration to change: declare the confidentiality on the target, or write a value that does not derive from that slot | new (reserved here, specified there) |
| `cfc-flow:ui-contract` | warning | A handler whose write policy requires a UI contract is bound by elements of the pattern, and none of them sits under a surface that carries the pattern and integrity names the contract requires, so no event from this pattern's UI can satisfy the policy (`plan-and-label-templates.md` §4.4) | The handler, the contract, and the elements that bind it. Bind the handler on an element inside the surface the contract names, or name in the policy the handler that the surface's control does bind | new (reserved here, specified there) |
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
a file that does, excluding test files and the test fixture
`patterns/system/fabrichat/room-test-fixture.ts`. That is 403 modules and
about 114,000 lines. It holds 475 `pattern` definitions, 593 `handler` and
45 `lift` definitions at module scope, 1,466 `computed` calls, 246 `action`
calls, and 188 inline JSX event handlers.

Files that are not patterns were left out: the iframe guest scripts
(`guest.ts`), which are browser programs, the Topics command-line tools
under `patterns/apps/topics/tools/`, and plain unit tests. Pattern test
files (`*.test.tsx`) are patterns too; they were measured separately and are
reported only where they differ.

**FabriChat** is the eight source modules of `patterns/system/fabrichat/`,
without its tests and its test fixture: about 9,000 lines, 14 patterns, 24
handlers bound at 19 sites in pattern bodies, 111 `computed` calls, and 10
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
same position: the 452 block-bodied pattern callbacks consist of 2,819
`const` statements, 452 final `return` statements, 15 expression statements,
and 2 local type declarations, and nothing else.

### 11.3 What the subset refuses in the corpus

| Construct | Occurrences (files) | Where | Resolution |
| --- | --- | --- | --- |
| Function overloads | 5 (2) | `patterns/system/fabrichat/manager.tsx` (4), `patterns/system/private-inbox/private-inbox.tsx` (1); 34 more in 29 pattern test files | Rewrite. Every occurrence is one idiom: a one-line function whose overload signature re-types a cell (`function inboxOf(pointer: Cell<A>): Cell<B>`) over an implementation that returns its argument as `unknown`. It exists because the double cast is refused. [§12.4](#124-replace-the-re-typing-overloads-with-declared-types) gives the two rewrites, which need no new construct |
| Mapped type | 1 (1) | `patterns/apps/topics/topic.tsx` | Rewrite as `Readonly<Record<K, number \| undefined>>` |
| `ifElse`, `when`, `str` | 155 (53); 1 (1); 1 (1). No `unless` | for example `patterns/system/self/self.tsx`, `patterns/system/loom/main.tsx`; `when` in `patterns/system/omnibox-fab/omnibox-fab.tsx`; `str` in `patterns/apps/deep-research/deep-research.tsx` | Accepted for the interim with a warning (§4.4.3). The rewrite is mechanical: all 157 are direct calls with the plain arguments |
| `patternTool` | 31 (12) | pattern bodies | Rewrite to a pattern closure (§4.4.3) |
| A collection method called on a cell handle in a handler | 2, as `builtin-inventory.md` counts them | handlers | Rewrite by one of the two corrections of §4.7: an inline `pattern(...)` that is instantiated, or `cell.get().map(...)` (`cell:collection-method-in-function`) |
| A per-element body over plain values that binds a handler without using the index | 6 (6) where the collection is a module-scope constant or a call result, for example `patterns/apps/weekly-calendar/event.tsx` and `patterns/examples/group-chat-room/group-chat-room.tsx`. A further 95 callbacks over stored lists bind a handler without the index; which of those have a primitive element type needs the type checker. No callback in the corpus declares a state cell | handler bindings in `map` callbacks | Rewrite: use the index, or make the elements cells (`collection:shared-element-state`) |
| `any` in a type | 126 (see below) | for example `patterns/system/link-tool/link-tool.tsx`, `patterns/system/knowledge-graph/knowledge-graph.tsx` | Rewrite with the explicit forms of §7.8 |
| `as any` | 52 (21) | for example `patterns/system/notes/daily-journal.tsx`, `patterns/system/agent-queue/agent-queue.tsx` | Remove: the rules of §7.5, §7.6, and §8.6 make most of them unnecessary |
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

**FabriChat** uses none of `ifElse`, `when`, `unless`, `str`, or
`patternTool`. It would need one change: the four overload signatures in
`manager.tsx`. Nothing else in its eight modules is refused. In particular it
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
| A module-scope handler applied to its state inside a `computed` | 16 (3): `patterns/apps/base/person.tsx`, `patterns/apps/base/family-member.tsx`, `patterns/apps/store-mapper/store-mapper.tsx` | Accepted as a handler binding (§5.2). The same form occurs 672 times in pattern bodies |
| `reduce` | 29 calls, all in function bodies today: 20 with an expression-bodied callback and an initial value, 2 expression-bodied without one, 7 block-bodied | A reactive construct in tier R for the first 20 (§4.4.1). The other 9 stay tier-F code, where `reduce` is ordinary JavaScript |
| `some`, `every`, `find`, `findIndex` with a callback | 135, 14, 65, and 78 calls, all but 2 `some` in function bodies today | Reactive constructs in tier R (§4.4.1), and ordinary methods in tier F |
| The index parameter of a `map` callback in a pattern body | Used in 44 of 303 callbacks (28 files); none in FabriChat | Accepted, with the hint `collection:index-keyed` |
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
| Promoted: expression or `const`-then-`return` body, structural operations only | 996 | 68% |
| Promoted: the same, with at least one call of an authored function | 242 | 17% |
| Promoted through the guard form (`if (...) return ...;` chains) | 113 | 8% |
| Not promoted: a statement body (loops, `let`, expression statements, `try`) | 81 | 6% |
| Not promoted: an expression with a disqualifying construct | 34 | 2% |

So 1,351 of 1,466 (92%) are promoted. Without the guard form the figure is
84%, which is the reason the criterion includes it. Counting `reduce`,
`findIndex`, `some`, `every`, and `find` as reactive constructs accounts for
56 of the promoted calls; with those five in the function tier the figure
was 88%.

The 34 disqualified expressions fail on: the mutating `sort` or `reverse` on
a copy (14); a collection callback with a statement body (9); `new Set` or
`new Date` (9); and a function created outside a callback position, a write
through a cell, or a `reduce` callback that is not an expression.

In FabriChat, 102 of 111 (92%) are promoted by the expression and
`const`-then-`return` forms and 4 more by the guard form, 106 in all.

The count is syntactic. It treats a method as pure by its name, and it does
not check condition 5 of §6.1 against types, so the type-checked figure will
differ slightly.

### 11.6 Labels

The corpus writes 197 references to label aliases outside `AnyOf` and
`PolicyOf`. `TrustedActionWrite` (55) and `WriteAuthorizedBy` (40) dominate,
then `Confidential` (30) and `AddIntegrity` (15).

- 220 label arguments are `typeof` binding references, 56 are tuples written
  in place, 12 name an alias, 12 are object literal types, and 8 are string
  literals. All are in the constant language of §8.5.
- 41 payloads are themselves label aliases (nesting), 10 are arrays, and 1
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

Each change keeps today's form valid unless it says otherwise. §12.1 does
say otherwise.

### 12.1 Conditionals and templates are JavaScript

`ifElse`, `when`, `unless`, and the `str` tag are removed (§4.4.3). The
conditional operators and the template literal are the only spellings. The
corpus has 155 `ifElse` calls in 53 files, one `when`, and one `str`,
against 439 conditional expressions in pattern bodies; all 157 are rewritten
mechanically.

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

Every overload in the corpus (§11.3) is one idiom: a one-line function whose
overload signature gives its argument another type, over an implementation
that returns the argument as `unknown`. No new construct replaces it. The
runtime's `asSchema` is not part of the language: no pattern module calls
it, apart from one personal variant under `patterns/system/home/`. The
idiom has two uses, and each has a rewrite in the language as specified.

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

**A link read beyond the type it is declared with** (the remaining 4). The
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

Decided in this document, and written into the sections above: tier I is
marked by `"use typescript";` (§5.5); the load-time verifier is retired for
subset modules and kept for tier-I modules (§3.4); `any` is refused and
each use gets an explicit form (§7.8); an inline event handler in a function
body is a handler binding (§5.2); the published typings become identity
aliases, with no editor plugin (§8.6.1); and a `computed` that instantiates
a pattern is not promoted (§6.1).

Decided by the project owner:

- compiler trust is unconditional;
- `ifElse`, `when`, `unless`, and the `str` tag are removed (§4.4.3);
- a function body may bind a handler and read context (§5.2);
- a `map` element is keyed by its value or its cell identity (§4.4.1);
- `reduce`, `findIndex`, `some`, `every`, and `find` are reactive
  constructs (§4.4.1);
- a per-element body over plain values may not declare shared state
  (§4.4.1);
- a handler factory may be received as a value and bound (§4.4.2);
- a handler binding made in a function body copies a scalar and a
  container the body computed, and binds a container that has a stored
  address by reference; a binding made in tier R copies nothing (§5.2,
  §4.6);
- a collection method on a cell handle in a function body is a compile
  error with two corrections, and the compiler does not rewrite it (§4.7);
- a `lift` or a `computed` may instantiate a pattern, and that pattern may
  request effects (§5.2).

Decided by `plan-and-label-templates.md`: a dynamic key is a chosen child
that does not observe the container's enumeration (its §3.18); `reduce` and
`findIndex` have label rules (§3.13); a handler binding made in a body has a
plan record (§3.14); the report `cfc-flow:ui-contract` is a warning (§4.4,
with the assumption among that document's open questions); and stored data
that does not match its declared type reads as `undefined` exactly where
the type admits `undefined` or declares a default, and otherwise fails the
cone that reads it (§5.2). The last is what keeps the strict `null` checks
of §7 sound: value code never sees a value its type excludes.

Questions 9 and 14 need a decision from the project owner, and the
[continuation plan](../../plans/compiled-pattern-language.md) lists them as
its questions 38 and 31. The others do not. Each names the document it is
addressed to.

1. **Whether declared types can replace every re-typing overload** (to the
   prototype). §12.4 removes the idiom without a new construct, on the
   argument that a footprint, not the declared type, decides what a function
   body loads. The three such functions in
   `patterns/system/fabrichat/manager.tsx` are the test: the prototype has
   to show that widening the declared link type there changes neither what a
   handler loads nor the stored schema's compatibility. If it does, the
   fallback is a re-typing operation on cells, whose label rule would need a
   CFC ruling.
2. **Inline records in a stored list** (to `plan-and-label-templates.md`).
   The checker treats an object-typed element of a list read from an input
   or a cell as identified by its cell (§4.4.1). A stored array can still
   hold inline records, when a computation elsewhere produced it.
   *Assumed,* as that document's §1.3 has it: a body over such a list that
   declares a state cell or binds a handler without the index compiles,
   and the cone of an element that arrives inline fails at run time, with
   the error state of its §5.2.
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
   errors are demoted to warnings when stored source is recompiled. That
   document's §9.4 compiles an instance's stored source when it migrates
   the instance, and leaves an instance whose source the compiler refuses
   on the builder path. *Assumed,* with its open question 27: stored source
   is compiled with the authoring severities of §10, the interim acceptance
   of the removed forms (§4.4.3) included, and no error is demoted.
8. **Per-instantiation checking of generic functions** (to the prototype).
   §7.3 checks a generic function body once per instantiation. That is
   simple and exact, and it reports an error in a generic helper at each
   call that triggers it. The prototype should confirm that the messages
   stay usable.
9. **An instance made in a `lift` or a `computed`** (to the project owner;
   the continuation plan's question 38). The ruling allows the
   instantiation and leaves two points, which §5.2 assumes. *Assumed:* the
   instance is identified by the enclosing instance, the site, and the
   ordinal of the instantiation among those the evaluation makes at that
   site, or by an explicit cause where the author writes `.for(cause)`.
   And *assumed:* a `lift` or a `computed` does not request an effect
   directly, so an effect that depends on computed data is written in a
   pattern, inline or named, that the computation instantiates.
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
    `footprint-analysis.md`, request 17; to `execution-and-storage.md` and
    the prototype). §7.8 has a body handed a reference at such a position,
    whatever is stored behind it, so that a kind test sees presence and no
    more and a conversion to a string yields nothing of the content.
    *Assumed:* it stays so, as the runtime reads such a position today. If
    a kind test could see the stored kind, a position narrowed by it would
    be read under the narrowed type, and `unknown` would no longer declare
    a reference that is not read.
14. **A child instantiated per element over equal plain values** (to the
    project owner; the continuation plan's question 31). The compile error
    for shared per-element state covers a body that declares a state cell
    or binds a handler (§4.4.1). A body that instantiates a child is not
    covered, and a factory-typed element is a plain value, so
    `factories.map((Card) => Card({ donut }))` gives two equal factories one
    child and its state. *Assumed:* the error is as ruled and does not
    cover it.
