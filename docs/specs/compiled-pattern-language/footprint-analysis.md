# Footprint analysis (proposed)

**Status:** proposed. Nothing here is implemented. This document details one
part of the [compiled pattern language](README.md): the analysis that computes
the footprint of a function body. The footprint says which paths of its
inputs a body observes and in which way, which cell handles it reads through,
which paths it writes, and which runtime calls it makes. The runtime builds a
body's argument from the footprint, and the label of everything the body
produces is the join over it.

This document defines no label rule. The label rule of a sandboxed call is
`plan-and-label-templates.md` §3.9, and this document specifies how the record
that rule reads is filled in. Where the analysis narrows what a body is given
further than the runtime does today, the narrowing is the "equal or tighter"
claim §3.9 already makes, and it is ruled on with the rest of that document.

Three documents beside this one own their subjects. This document refers to
them and does not define their content.

- `language-subset.md` owns the grammar of function bodies (§5), the method
  surface of cell handles (§4.7), the standard-library surface (§9), and the
  diagnostics catalog (§10).
- `plan-and-label-templates.md` owns the footprint record (§1.1), the
  observation classes (§2), the label rules (§3), and what rests on the
  compiler (§7).
- `builtin-inventory.md` owns the runtime calls a body may make.

`execution-and-storage.md` and `scheduler-and-serving-loop.md` are not yet
written, and nothing here depends on them. Where this document needs a fact
that belongs to another document, it states the assumption it made and lists
it under [Open questions](#13-open-questions).

## Contents

1. [Scope and inputs](#1-scope-and-inputs)
2. [The abstract domain](#2-the-abstract-domain)
3. [Transfer rules](#3-transfer-rules)
4. [Implicit flows](#4-implicit-flows)
5. [Giving up and widening](#5-giving-up-and-widening)
6. [The write side](#6-the-write-side)
7. [Cell handles](#7-cell-handles)
8. [Runtime calls in a body](#8-runtime-calls-in-a-body)
9. [Soundness](#9-soundness)
10. [Relation to the current system](#10-relation-to-the-current-system)
11. [Corpus measurement](#11-corpus-measurement)
12. [Worked example: a FabriChat handler](#12-worked-example-a-fabrichat-handler)
13. [Open questions](#13-open-questions)

## Notation

- A **path** is a list of segments, and `*` stands for each element of an
  array or each child of a record, as in `plan-and-label-templates.md`.
- A **formal input** of a body is one of its parameters, or, for a body
  written inside the reactive tier, one of the values it captures.
- `x.p` is the path `p` of formal input `x`. Listings write an entry as
  `input path : class`.
- `h->q` is the path `q` in the cell that the handle at `h` links to. A path
  may hold several such hops.
- The **classes** are the five observation classes of
  `plan-and-label-templates.md` §2: `value`, `shape`, `enumeration`,
  `identity`, and `labelMetadata`.
- A **scalar** type is a primitive type, a literal type, or a union of those.
  A **container** type is an object, array, or tuple type. A **handle** type
  is one of the cell types of `language-subset.md` §7.2, `Stream` included.

## 1. Scope and inputs

### 1.1 What the analysis computes

The analysis takes one function body and fills in the fields of its `Body`
record (`plan-and-label-templates.md` §1.1).

| Field | What the analysis supplies | Section |
| --- | --- | --- |
| `reads` | The static entries of the footprint: input paths, each with a class | 2, 3, 5 |
| `handles` | The handles the body reads through in ways no static entry covers | 7 |
| `writes` | The paths the body writes, and the template of each written value | 6 |
| `outputs` | The result paths that hold a reference the body was given | 3.8 |
| `calls` | The sites of the runtime calls the body makes | 8 |
| `widenings` | Where the analysis gave up, and what each widening covers | 5 |

A footprint entry is a triple of a formal input, a path, and a class. The
analysis works on the body alone and does not look at where the body is
called or bound, so its result is the same for every use of the body. Mapping
a formal input to a slot of the plan, or to the template of a value another
cone computed, is done where the body is used and belongs to
`plan-and-label-templates.md` ([§13](#13-open-questions), request 1).

### 1.2 Which bodies it runs on

| Body | Formal inputs | Notes |
| --- | --- | --- |
| `handler(...)` at module scope | The event and the state | The state's paths are slots with root `binding`; the event's have root `event` |
| `action(...)`, and an inline JSX event handler | The event, and each captured value | The compiler hoists the arrow to a handler whose state is its captures (`language-subset.md` §5.2) |
| `lift(...)` | Its parameter | |
| `computed(...)` that is not promoted | Each captured value | A promoted `computed` is not a body. Its expression is compiled in the reactive tier, operation by operation (`language-subset.md` §6) |
| `assert(...)` | Each captured value | Analyzed as a `computed` |
| An authored function called from the reactive tier | Its parameters | A body of kind `function` |
| An authored function called from another body | Its parameters | Not a body of the plan. It is analyzed once for a summary ([§3.6](#36-functions)), and the summary is applied in each caller |
| A function of an imported TypeScript module | Its parameters | Not analyzed. See below |

Three kinds of function are not bodies. The callback of a reactive
collection method in the reactive tier is compiled against an element slot
and has label rules of its own. A callback passed to a standard-library method
inside a body is part of that body. A pattern callback is the reactive tier.

**Imported TypeScript.** The compiler reads the signature of an imported
function and nothing else (`language-subset.md` §5.5). Its record has kind
`imported` and is fixed by the signature:

- `reads` holds one entry per parameter, of class `value` at the parameter's
  root, so every argument is read in full;
- `handles`, `writes`, and `calls` are empty, because a parameter of such a
  function is a data type, and a module of that tier cannot call a builder or
  a built-in;
- `outputs` is empty, so every result path is computed from every argument.

A body in the subset that passes one of its inputs to an imported function
reads that input in full. That is the widening cause W3 of
[§5.2](#52-the-causes).

### 1.3 What it takes as given

- **The record.** `Body`, `BodyOutput`, `BodyCall`, `Widening`, and
  `WriteEdge` are as `plan-and-label-templates.md` §1.1 declares them.
- **The grammar.** A body contains the statements and expressions of
  `language-subset.md` §5.1 and nothing else. In particular it has no
  classes, no `this`, no `async` code, no generators, no `for...in`, no
  dynamic code, and no write to module scope or to a global.
- **Types.** The analysis runs after the subset type checker. Every
  expression has a concrete type, since the checker has no deferred types and
  refuses `any` (`language-subset.md` §7.3, §7.8). A generic function is
  analyzed once per instantiation, as it is checked. The analysis uses types
  for four decisions: whether a position is a scalar, a container, or a
  handle; whether an object type is closed or has an index signature; whether
  a type admits `null` or `undefined`; and which declaration a call resolves
  to.
- **Statelessness.** No function of the program holds mutable state between
  calls (`language-subset.md` §3.3). A closure created in a body dies with
  the call, so everything a body can reach is its formal inputs, module-scope
  constants, and what it creates.
- **Schema conformance.** A body never receives a value outside the type of
  its input (`plan-and-label-templates.md` §5.2).

### 1.4 Requirements on the result

1. **Sound.** Every path the body can observe at run time, in each class, is
   in the footprint ([§9](#9-soundness)).
2. **Never wider than today.** For every body, what the footprint puts into
   the body's label is a subset of what the body's transaction reads today.
   This is the ruling that template labels are equal to or tighter than
   today's, applied to this analysis. It has two consequences that shape the
   design: the analysis is at least as precise as the capability analysis the
   transformer runs today ([§10](#10-relation-to-the-current-system)), and a
   read through a cell handle that today happens only on some runs is not
   turned into a static entry ([§7.2](#72-static-and-dynamic-reads)).
3. **Deterministic.** Equal source and equal types give an equal footprint.
   The footprint is part of the plan, and the plan is content-addressed.
4. **Local when it gives up.** A value the analysis loses track of widens the
   footprint to the subtree that value came from, and no further
   ([§5](#5-giving-up-and-widening)).
5. **Never an error.** A widening, a read that stays dynamic, and a
   computation that is a materializer are reported as hints
   (`language-subset.md` §2, rule 5).

## 2. The abstract domain

### 2.1 Abstract values

The analysis evaluates every expression of a body to an abstract value.

| Abstract value | Stands for |
| --- | --- |
| **Projection** `x.p` | The value at path `p` of formal input `x`, exactly as the body received it. The path may hold `*` segments and handle hops |
| **Alternatives** `{v1, v2, …}` | One of several abstract values, where control flow or a conditional expression decides which |
| **Record** `{k: v, …}`, **list** `[v, …]` | An object or array the body built, with one abstract value per member |
| **Bag** of `v` | A local container whose members the analysis does not tell apart: an array filled in a loop, a `Map`, a `Set`, an object written under computed keys. `v` joins everything put in |
| **Closure** | A function value created in the body, with the environment it was created in |
| **Created** at a site | A cell, a link to a pattern instance, a link to an effect's result, or a stream that the body obtained at a runtime call site |
| **Computed** | Any other value. It carries no path |

Only projections lead back to inputs. A value that an operator or a
standard-library function computed from inputs is `Computed`, and the
analysis records nothing more about it: the label of a body's result is the
join over the whole footprint ([§4](#4-implicit-flows)), so the analysis
needs to know which inputs were observed and not where the observed
information went.

A projection whose static type is a handle type is a **handle**. A handle is
**anchored** when its path has no `*` segment, so that it names one position
of one formal input. `event.message` is an anchored handle, and so is
`state.composer->editing`, which is reached through one hop. An element of
`state.rooms`, a list of handles, is not.

### 2.2 Observations

An observation is a projection and a class. The body's footprint is the set
of observations the analysis records. The class an operation needs depends on
the static type of the position it is applied to.

| What the operation does | Scalar | Container | Handle |
| --- | --- | --- | --- |
| Consumes the content: arithmetic, a string method, comparison with a value, conversion to a string | `value` | `value` over the subtree, which is a widening ([§5](#5-giving-up-and-widening)) | Not typed |
| Tests presence or kind: `=== undefined`, `?.`, `??`, `typeof`, `in`, `Array.isArray` | `shape` | `shape` | `shape` |
| Tests truthiness | `value` | `shape` | `shape` |
| Asks for the length, the key set, or iterates | `value` (a string) | `enumeration` | Not typed |
| Passes the value on unchanged to a place that keeps it by reference ([§3.8](#38-what-leaves-the-body)) | `value` | `identity` | `identity` |
| Compares references: `equals`, `===` between two containers or handles | Not applicable | `identity` | `identity` |

A position whose type is a union takes the row of each member, so a test of
truthiness on `string | Donut` records `value` and `shape`.

Three rules apply to every observation.

- **Navigation observes nothing.** `donut.glaze` extends a path. It records
  no observation of `donut`, by the rule `plan-and-label-templates.md` §2.1
  quotes from the specification.
- **A test the type decides is a constant.** `typeof name` where `name` has
  type `string`, and `donut?.glaze` where `donut` cannot be `null` or
  `undefined`, record nothing. A body never receives a value outside its
  input's type (§1.3), so the outcome carries no information.
- **`value` stops at a handle.** A `value` observation at a container covers
  its subtree down to, and not through, each position that holds a handle.
  At such a position it is an `identity` observation. What the handle links
  to is read only through an explicit hop ([§7](#7-cell-handles)).

### 2.3 The footprint is one set per body

The analysis keeps one footprint for the whole body, and an observation made
on any path through the body is in it. There is no footprint per branch,
because the runtime builds the body's argument before the body runs and
cannot know which branch will be taken.

The set is kept in a normal form:

- a `value` entry at `p` removes every entry at or below `p` in the same
  cell, other than `identity` entries, which name a different stored label
  (`plan-and-label-templates.md` §2.2);
- entries that differ only in the alternative they came from are one entry.

The environment that maps each local name to an abstract value is tracked
along control flow ([§3.7](#37-control-flow)). The footprint is not.

## 3. Transfer rules

Each rule states the abstract value of an expression and the observations it
records. Where an operand is a set of alternatives, the rule applies to each.
Where it is `Computed`, `Created`, or a closure, the rule records nothing.

### 3.1 Access

| Construct | Result | Observations |
| --- | --- | --- |
| `v.k`, and `v[k]` where `k` is static in the sense of `language-subset.md` §4.3 | The projection extended by `k` | None |
| `v?.k` | The same | `shape` at `v` |
| `v[i]`, `v.at(i)` where `v` has an array type | The projection `v/*` | `enumeration` at `v` |
| `v[i]` where `v` has a tuple type and `i` is not static | The projection `v/*` | None |
| `v[k]` where `v` has an object or record type and `k` is not static | The projection `v/*` | `enumeration` at `v`. Widening W1 |
| `text[i]` where `text` is a string | `Computed` | `value` at `text` |
| `const { a, b: c } = v` | `a` and `c` are the projections `v.a` and `v.b` | None |
| A default in a destructuring, `{ a = d }` | `v.a`, or the value of `d` | `shape` at `v.a` |
| `const { a, ...rest } = v` where the type of `v` is closed | `rest` is a record of the projections of the remaining declared properties | None |
| `const [first, second] = v` | `v/0` and `v/1` for a tuple; `v/*` for an array | `enumeration` at an array |
| `const [first, ...others] = v` | `others` is a bag of `v/*` | `enumeration` at `v` |
| A rest element where the type of `v` has an index signature | `rest` is a bag of `v/*` | `enumeration` at `v` |
| A destructuring under a computed key | The projection `v/*` | `enumeration` at `v`. Widening W1 |
| `h.get()`, `h.sample()`, `h.key(k)`, and the other handle methods | [§7.1](#71-what-a-body-may-do-with-a-handle) | |

An index into an array is not a widening. The analysis does not track which
element an index names, so `rows[i].price` is `rows/*/price`: the body may
read the `price` of any row. That is the path iteration over the array
produces too, so indexing loses nothing against `for...of`. The index itself
is whatever its own expression is.

### 3.2 Tests and operators

| Construct | Observations |
| --- | --- |
| `v === w`, `v !== w`, `==`, `!=` | For a scalar operand, `value`. Against a literal `undefined` or `null`, `shape`. Between two containers or two handles, `identity` at each |
| `typeof v`, `v instanceof C`, `Array.isArray(v)` | `shape` |
| `v ?? w` | `shape` at `v`. The result is the alternatives `{v, w}` |
| `v && w`, `v \|\| w`, `!v`, `Boolean(v)`, and the condition of `if`, `while`, `for`, `do`, and `?:` | Truthiness of `v` by the table of §2.2. The result of `&&` and `\|\|` is the alternatives `{v, w}`; of `c ? a : b`, `{a, b}` |
| `"k" in v`, `Object.hasOwn(v, "k")` | `shape` at `v.k` |
| `k in v`, `Object.hasOwn(v, k)` with a key that is not static | `enumeration` at `v` |
| Arithmetic, relational, and bitwise operators, unary `+` and `-`, `+` on strings | `value` at each scalar operand. A container operand is converted, which is widening W2 |
| `switch (v)` | As `v === c` for each case |
| Assignment to a local, the comma operator, `void` | None. An assignment updates the environment (§3.5) |

The equality functions of the runtime (`equals`, the `equals` and
`equalLinks` methods of a handle, and their static forms) record `identity`
at each operand, as `plan-and-label-templates.md` §3.16 says.

### 3.3 Construction

| Construct | Result | Observations |
| --- | --- | --- |
| `{ k: e, … }` | A record of the members' abstract values | None |
| `[e, …]` | A list | None |
| `{ ...v }` where the type of `v` is closed | The record gains the projection `v.k` for each property the type declares | `shape` at `v` when its type admits `null` or `undefined` |
| `{ ...v }` where the type of `v` has an index signature | The record's remaining members are a bag of `v/*` | `enumeration` at `v` |
| `[...v]`, a spread argument in a call, `Array.from(v)` | A bag of `v/*` | `enumeration` at `v` |
| A template literal, `String(v)`, `v + ""` | `Computed` | `value` at a scalar substitution. A container substitution is widening W2 |
| JSX | A record: the element's attributes and children are its members | None |

Building a value observes nothing. What is recorded depends on what is done
with the value afterwards. A record that is only passed on leaves each of its
members where it goes ([§3.8](#38-what-leaves-the-body)), and a record whose
`price` member is later read is a read of whatever projection that member
holds.

A spread of a closed type is expanded from the type, property by property.
Storage cannot hold a property the type does not declare, by schema
conformance (§1.3), so the expansion is exact. A spread of a type with an
index signature copies children the analysis cannot name, so the copy holds
them as a bag, joined with any member written before the spread. Neither
form reads a child: a spread is a widening in no case.

### 3.4 The standard-library surface

Every member `language-subset.md` §9 lists has a rule. The rules for a
receiver or argument that is a projection `v`:

**Strings, numbers, booleans, and bigints.** Every member, and every global
function that takes one (`Number(v)`, `parseInt(v)`, `Math.max(v, w)`,
`encodeURIComponent(v)`, `new Date(v)`, `new URL(v)`, `new Error(v)`,
`regexp.test(v)`), records `value` at `v`. The result is `Computed`. The
function argument of `replace` and `replaceAll` receives `Computed`
parameters.

**Arrays.**

| Members | Observations | Result |
| --- | --- | --- |
| `length` | `enumeration` | `Computed` |
| `map`, `flatMap`, `forEach` | `enumeration`. The callback's element parameter is `v/*`, its index parameter is `Computed`, and its array parameter is `v` | A bag of what the callback returns; `Computed` for `forEach` |
| `filter`, `find`, `findLast` | The same | A bag of `v/*`; for the two lookups, `v/*` |
| `some`, `every`, `findIndex`, `findLastIndex` | The same | `Computed` |
| `reduce`, `reduceRight` | `enumeration`. The element parameter is `v/*`. The accumulator parameter is the join of the initial value and what the callback returns | That join |
| `toSorted(compare)`, and `sort(compare)` on a local copy | `enumeration`. Both parameters of `compare` are `v/*` | A bag of `v/*` |
| `toSorted()` and `sort()` with no argument | `enumeration`, and `value` at `v/*`, since elements are compared as strings. Widening W2 when the element type is a container | A bag of `v/*` |
| `slice`, `concat`, `flat`, `toReversed`, `toSpliced`, `with`, `values`, `entries`, `keys` | `enumeration` | A bag of `v/*`, joined with the other operands |
| `includes(w)`, `indexOf(w)`, `lastIndexOf(w)` | `enumeration`. At `v/*` and at `w`: `value` for a scalar element type, `identity` otherwise | `Computed` |
| `join(separator)` | `enumeration`, and `value` at `v/*`. Widening W2 when the element type is a container | `Computed` |
| `push`, `pop`, `shift`, `unshift`, `splice`, `fill`, `sort`, `reverse`, called on `v` itself | Widening W5 | |

The mutating methods are ordinary on a local list or bag, where `push` adds
its arguments to the bag.

**Objects.**

| Call | Observations | Result |
| --- | --- | --- |
| `Object.keys(v)` | `enumeration` | `Computed` |
| `Object.values(v)` | `enumeration` | A bag of `v/*` |
| `Object.entries(v)` | `enumeration` | A bag of pairs of a `Computed` key and `v/*` |
| `Object.fromEntries(e)` | None | A record or a bag, from the members of `e` |
| `Object.assign(target, v)` | As `{ ...v }` | The members are added to `target` |
| `Object.freeze(v)`, `Object.getPrototypeOf(v)` | `shape` | `v`; `Computed` |

**`JSON`.** `JSON.stringify(v)` records `value` at `v` and is widening W2.
`JSON.parse` returns `Computed`.

**`Map` and `Set`.** A `Map` or `Set` created in a body is a bag. `set` and
`add` put a value in. `get`, iteration, `values`, and `entries` return the
bag's member. `has`, `get`, and `delete` compare keys, which records `value`
at a scalar key and `identity` at a container or handle key. The same
applies to the frozen `ReadonlyMap` and `ReadonlySet` of module scope, whose
content is constant.

**`console`.** Each argument is written to a log, so each is observed as a
conversion: `value` at a scalar, and widening W2 at a container. Whether a
log is a place labeled data may go at all is not a question for this
analysis ([§13](#13-open-questions), request 11).

### 3.5 Locals and aliasing

- **A `const` or `let`** binds a name to the abstract value of its
  initializer. An assignment to a `let` replaces the binding at that point.
- **A member assignment on a record or list the body built** replaces that
  member when the key is static. Under a key that is not static, the value
  becomes a bag.
- **A bag never loses a member.** A value put into a local container stays
  in its join for the rest of the body, whatever is removed later. Reading
  from the container returns the join.
- **Two names for one built value** share it. The analysis keeps one
  abstract object per construction site, so a member written through one
  name is seen through the other.
- **A `let` captured by a closure** holds the join of every value assigned
  to it anywhere in the body, because the closure may run between any two
  assignments.
- **An input value is not updated in place.** A member assignment, a
  `delete`, an increment, or a mutating method applied to a projection is
  widening W5: the value at that projection is read in full, and its members
  are `Computed` from there on. Today such an update throws, because a value
  read through a schema is frozen (`annotateWithBackToCellSymbols` in
  `runtime/runner/src/schema.ts`), and the corpus has none
  ([§11.3](#113-where-the-analysis-gives-up)).
  [§13](#13-open-questions), request 6, asks `language-subset.md` whether a
  body's inputs have read-only types, which would make it a type error.

### 3.6 Functions

**Authored functions.** The analysis computes one summary per authored
function of the program, in whichever module it is declared, and per
instantiation when it is generic. A summary holds, in terms of the
function's parameters:

- the observations it records;
- its writes and its runtime calls;
- the abstract value it returns: a projection of a parameter, alternatives,
  a record or bag built from them, a created value, or `Computed`;
- its widenings, each with the source position inside the function;
- for each read through a handle, whether the read is unconditional in the
  function ([§3.7](#37-control-flow)).

At a call, the summary is applied with the arguments' abstract values in
place of the parameters. An argument that is `Computed` drops the entries
recorded on its parameter. Because the returned value is part of the
summary, a helper that returns one of its arguments, or a part of one, does
not end the tracking: what the caller reads from the result is a read of the
caller's own input.

Summaries are computed over the program's call graph from the leaves. A
group of mutually recursive functions is iterated to a fixed point, which
exists because the set of projections of a function's parameter types is
finite once recursive types are cut (W6).

**A function passed as an argument.** When an authored function takes a
function parameter, its summary is computed per call, with the argument
bound: a function written at the call, or a named authored function. The
call of the parameter inside the helper is then a resolved call. Where the
argument is neither, the call is unresolved.

**Closures.** A function expression inside a body is analyzed in the
environment it is created in. Its body is always analyzed, called or not:
every observation in it is in the footprint. Its parameters are bound where
the call is resolved:

- a direct call of a local name that holds one closure;
- an immediately invoked function;
- a callback position of a standard-library method (§3.4);
- an argument of an authored function, as above.

A captured value is tracked inside the closure like any local. Capturing an
input therefore never widens it.

**An unresolved call.** A call whose callee the analysis cannot resolve to
one function, or to a set of closures it can enumerate, is widening W4: each
argument that is a projection is read in full. The result is `Computed`.
The grammar leaves few ways to write one: a function taken out of a local
container, and a function parameter whose argument was itself a parameter.

### 3.7 Control flow

The environment follows the control-flow graph of the body. The footprint
does not (§2.3).

- **Joins.** Where two paths merge, a name bound to different abstract
  values on each is bound to the alternatives of both. Two records with the
  same keys join member by member.
- **Loops.** A loop body is iterated until the environment at its head no
  longer changes. A loop variable of `for...of` over a projection `v` is
  `v/*`, with `enumeration` at `v`. Over a string it is `Computed`, with
  `value` at the string. Over a local bag it is the bag's member.
- **Termination.** The environment's values are drawn from a finite set:
  the projections of the body's input types, which are finite once
  recursive types are cut (W6), and the construction sites of the body. A
  join only adds alternatives. Where a value would exceed a fixed number of
  alternatives, or a fixed point is not reached within a fixed number of
  rounds, the analysis widens (W7).
- **Early return.** The body's result is the join of the operands of every
  `return`. A `return` with no operand contributes a constant.
- **Exceptions.** An observation made before a `throw` stays in the
  footprint. The operand of `throw` is a conversion: a body that throws a
  projection reads it in full (W2). The variable of a `catch` clause is
  `Computed`. A `finally` block is analyzed on both exits.
- **`switch`, `break`, `continue`, and labels** are edges of the graph and
  need no rule of their own.

One property is decided on the graph and used only in
[§7.2](#72-static-and-dynamic-reads). A program point is **unconditional**
when every execution of the body that returns normally passes through it.
In terms of syntax, a point is unconditional unless it is:

- in a branch of `if`, `switch`, `?:`, `&&`, `||`, or `??`;
- in the body of a `while`, `for`, or `for...of` loop;
- in a `try` block that has a `catch` clause, or in a `catch` clause;
- after a statement that can `return` on some path;
- in a closure, other than an immediately invoked one.

A `throw` does not make what follows it conditional, since an execution that
throws does not return normally. A point inside an authored function is
unconditional for a caller when it is unconditional in the function and the
call is unconditional in the caller.

### 3.8 What leaves the body

A value leaves a body when the body returns it, writes it through a handle,
passes it as the argument of a pattern instantiation or of an effect
request, or puts it into JSX. These destinations keep a container or a
handle **by reference**: what is stored is a link to where the value was
read, and whatever reads it later does so under a schema of its own.

| What arrives at such a destination | Recorded |
| --- | --- |
| A projection of scalar type | `value` |
| A projection of container or handle type, whole | `identity`. The content is not read |
| A record or list the body built | Nothing for the value itself. Each member is treated by this table |
| A bag | The member, by this table |
| `Computed`, `Created` | Nothing |

The state a handler is bound to is the one destination that copies. A
captured data value is copied into the binding, and a captured handle stays
a link (`language-subset.md` §5.2). [§8.5](#85-binding-a-handler) gives the
rule.

The reference rule is the reason a body that moves a record from one list to
another does not read the record. It rests on how the runtime stores a value
that was read from an input and passed on unchanged. Today such a value
carries the address it was read from (`annotateWithBackToCellSymbols` in
`runtime/runner/src/schema.ts`), and a write of it stores a link. This
document assumes that stays ([§13](#13-open-questions), question 2).

**`Body.outputs`.** For each path of the body's result, the analysis looks
at the abstract value the joined return value has there:

- one projection of container or handle type gives
  `reference: { passes }`, naming that projection's `identity` entry;
- alternatives that are all such projections give `reference: { oneOf }`;
- anything else gives no entry, and the path is computed.

The runtime verifies both forms by reference identity
(`plan-and-label-templates.md` §3.9), so an error in this part of the
analysis costs precision and cannot produce a wrong label. `required` is
read from the result schema and not from the analysis. The same two forms
apply to each path of a value the body writes
([§6.5](#65-the-label-of-a-written-value)).

## 4. Implicit flows

A body's result depends on values it never returns:

```ts
// Shown for illustration only.
const priceOf = lift(
  ({ donut, coupon }: { donut: Donut; coupon?: Coupon }) => {
    if (coupon !== undefined && coupon.code === "GLAZED") {
      return donut.basePrice / 2;
    }
    return donut.basePrice;
  },
);
```

The number returned is computed from `donut.basePrice` alone, and whether it
was halved reveals `coupon.code`. The footprint is

```text
donut   basePrice   : value
coupon  (root)      : shape
coupon  code        : value
```

and the label of the result is the join over all three entries.

### 4.1 Labels are per body

The analysis tracks no flow inside a body, explicit or implicit. Every
observation is recorded where it is made, and the template of everything the
body returns and writes is `derive` over the whole footprint
(`plan-and-label-templates.md` §3.9). Three facts make that sufficient.

- **It covers every implicit flow.** A body is a function of what it
  observes ([§9](#9-soundness), S1). Any information that reaches a result
  or a write, through data or through a branch, an exception, or the order
  of evaluation, was observed first, and the observation is in the join.
- **It equals today's label.** Today a body is one transaction, and every
  path the transaction writes carries the join of everything it read
  (`plan-and-label-templates.md` §3.1). A per-body label loses nothing
  against that.
- **Anything finer would rest on the compiler.** A label per result path, or
  per write, needs a dependency analysis of full JavaScript: branches,
  `throw`, loops, closures, and aliasing through mutable locals. A `throw`
  alone makes every later write depend on every condition evaluated before
  it. The result would be a claim the runtime cannot check, of the kind
  `plan-and-label-templates.md` §7.4 lists, and the function tier has no
  restriction that would make such an analysis simple.

This settles the first open question of `plan-and-label-templates.md`: a
body's computed values have one template. The reference rules of §3.8 are
the only refinement, and the runtime verifies them.

An author who wants a label per path has two ways to get one. A `computed`
whose body meets the promotion criterion is compiled in the reactive tier,
where every operation has a rule (`language-subset.md` §6). And two values
with different dependencies can be computed by two bodies.

### 4.2 The argument is per path

The same footprint is used a second way. The runtime builds the body's
argument from it, entry by entry, so the body receives `donut.basePrice` and
not the rest of `donut`. For this use the footprint is a tree of paths with
a class at each, and its precision is what keeps a body from being tainted
by, or gaining access to, data it never touches.

The two uses do not conflict. A narrower footprint gives a smaller argument
and a smaller join. A footprint that is too narrow gives the body an
argument that lacks what it reads, which changes what the body computes and
never what its label covers ([§9.2](#92-what-rests-on-the-analysis)).

## 5. Giving up and widening

### 5.1 What a widening is

The analysis gives up in two ways.

- **On a value,** when an operation consumes it in a way the rules of §3
  cannot follow member by member. The analysis records a `value`
  observation at the projection the value is, which stands for the whole
  subtree below it, and treats the value as `Computed` from there on.
- **On a key,** when it cannot tell which child of a record the key names.
  The analysis continues with `*` in place of the key, so that what the
  body goes on to read of the one child is recorded for every child.

Each widening adds one entry to `Body.widenings`: the slot that now stands
for more than the body reads, and the source position of the expression.

A widening never reaches above the projection it applies to, never reaches
another formal input, and never passes through a handle: by §2.2 a `value`
entry stops at a position that holds a handle. A handle the analysis loses
track of is not read in full. It becomes a handle the body reads through
dynamically ([§7.4](#74-where-a-handle-may-go)), which is what the runtime
records for it today.

### 5.2 The causes

This is the complete list. An operation that is not on it does not widen.

| | Cause | Widens to | Is the wider entry exact? |
| --- | --- | --- | --- |
| W1 | A key that is not static on an input of object or record type, in an element access or a destructuring | Every child of the keyed container, at the paths the body reads below the key, and the container's `enumeration` | No: one child is read |
| W2 | Conversion of a container to a string or a number: `JSON.stringify`, a template literal, `String()`, `+`, `join`, a sort with no comparator, a relational or arithmetic operator, `throw`, an argument of `console` | The converted value | Yes for `JSON.stringify`; otherwise the conversion reads less than the subtree |
| W3 | An argument of an imported TypeScript function | The argument | By the language rule: the function may read all of it |
| W4 | An argument of a call the analysis cannot resolve (§3.6) | The argument | No |
| W5 | An update in place of an input value: a member assignment, `delete`, an increment, or a mutating method | The updated value | No |
| W6 | A path that enters a recursive type a second time | The value at the position where the path entered the type for the second time | No |
| W7 | An analysis limit: too many alternatives for one value, or no fixed point within the bound | The projections involved | No |

W1 is the widening on a key. `prices[flavor].amount` reads
`prices/*/amount` and the key set of `prices`. Only a child that is then
consumed whole widens to whole children.

W6 keeps the set of paths finite. A body that walks a tree of donut boxes
reads `box.label` and `box/children/*/label` as separate paths, and
everything below the second level through `box/children/*/children` as one
subtree.

The following do not widen. They are listed because the current analysis
([§10](#10-relation-to-the-current-system)), or the list of
`language-subset.md` §5.4, treats them as if they did:

- an index into an array, and iteration in any form;
- `Object.keys`, `Object.values`, and `Object.entries`;
- a spread or a rest element, of an object or of an array;
- a value stored in a local array, `Map`, `Set`, or object and read back;
- a value captured by a closure, wherever the closure is passed;
- a value passed to an authored function, in the same module or another;
- a conditional between two inputs;
- a key that is not static on a handle, `h.key(k)`, which is a dynamic read
  and not a static one ([§7](#7-cell-handles)).

### 5.3 The diagnostic

Each widening is reported as the hint `footprint:widened`
(`language-subset.md` §10.3). The message names the expression, the cause,
the input path the footprint widened to, and the rewrite.

| Cause | The message tells the author to |
| --- | --- |
| W1 | Read the named properties, or keep the record in a cell and read `cell.key(k).get()`, which reads the one child |
| W2 | Convert the properties that are needed: `` `${donut.name}` `` in place of `` `${donut}` ``; pass `JSON.stringify` an object built from them |
| W3 | Pass the imported function the properties it needs |
| W4 | Call the function directly, or declare it at module scope |
| W5 | Copy first: `[...rows]`, `{ ...donut }` |
| W6 | Bound the depth of the walk, or keep the nodes in cells and read through handles |
| W7 | Split the body |

Two more hints report outcomes that are not widenings, and this document
asks `language-subset.md` to add them ([§13](#13-open-questions), request 5):
`footprint:dynamic-read`, for a read through a handle that stays dynamic
(§7.2), and `footprint:materializer`, for a computation whose write makes it
a materializer (§6.3).

### 5.4 Widening is sound

A widening replaces entries by entries that cover them. By the normal form
of §2.3, a `value` entry at `p` covers every class at every path at or below
`p`. An entry at `p/*/q` covers the same observation at `p/k/q` for every
key `k`. The footprint after a widening therefore covers every observation
the footprint before it covered, and the soundness statement of
[§9](#9-soundness) holds for it if it held before. The analysis applies a
widening exactly where it stops tracking a value or a key, so from that
point on no observation of it can be missing.

A widening can only make a label wider and an argument larger. By the
requirement of §1.4 it cannot make either wider than today, because each
cause reads no more than the current transformer's treatment of the same
construct reads ([§10.2](#102-where-the-proposed-analysis-differs)).

## 6. The write side

### 6.1 What counts as a write

| Operation | Target | Paths written |
| --- | --- | --- |
| `h.set(v)` | The cell of `h`, at the path of `h` | The subtree |
| `h.update(partial)` | The same | The properties of the type of `partial` |
| `h.push(…)`, `h.pushAll(…)`, `h.addUnique(…)` | The same | The container's enumeration, and `*` below it |
| `h.remove(…)`, `h.removeByValue(…)`, `h.removeAll(…)` | The same | The container's enumeration |
| `h.increment(by)`, `h.applyChanges(changes)` | The same | The path |
| `stream.send(event)` | The stream | The event |
| `db.exec(sql, params)` | The database handle | The handle (`builtin-inventory.md`, "`SqliteDb.exec`") |
| A cell constructor with an initial value | The created cell | The whole cell |
| The argument of a pattern instantiation | The child's argument document | Each argument path |
| `return` | The body's primary output | The result |

For each write the analysis records the abstract value of the handle written
through, the path below it, and the abstract value written.

### 6.2 Targets

A write target is classified by what the analysis knows of its address.

- **Static.** The handle is an anchored handle, or a set of alternatives
  that are all anchored, and the path below it has only static segments. The
  target is named by the position of the handle among the body's inputs and
  the path. The address that position links to is bound when the instance
  is, like any slot. A set of alternatives gives one target per alternative.
- **Dynamic.** The write goes to another cell, and which one depends on
  data the body read: the handle is an element of a list of handles, or a
  handle found in a value the body read, or a cell the body created under a
  cause computed from data ([§8.2](#82-creating-a-cell)).
- **Too broad to predict.** The narrowest static path the analysis can name
  for the write is a proper prefix of what is written. That is the case
  when the path below an anchored handle has a segment that is not static,
  as in `counts.key(flavor).set(n)` or a write through `elementById`, where
  the analysis can name `counts` and the write changes one child of it. It
  is also the case when the analysis lost track of the handle, because it
  was passed to an unresolved call (W4) or reached through an analysis
  limit (W7), so that the write can be bounded only by the handles the body
  holds.

For a dynamic target and for one that is too broad, the analysis records an
**envelope**: the static prefix the write lies under. For a key that is not
static it is the container's path. For an element of a list of handles it is
the list, meaning the cells the list links to. For a created cell it is the
creation site. For a lost handle it is every writable handle among the
body's inputs.

### 6.3 Computations: static side-write or materializer

A `lift` or a `computed` that writes through a handle is a computation with
side-writes. The three tiers of
[Scheduler v2](../scheduler-v2/README.md) (§4.3) carry over, and the
analysis decides the tier.

| The body's writes | Tier | What the plan records |
| --- | --- | --- |
| Only its return value | Primary output | Nothing beyond the body |
| Side-writes whose targets are all static | Static side-write targets | One `WriteEdge` per target on the body. Each is one more output edge of the cone that runs the body |
| At least one side-write whose target is dynamic or too broad | Materializer | An `Operation` of kind `materializer` implemented by the body, with its envelopes |

The classification is per body. A body with one write that is not static is
a materializer for all of its writes, as a node with a declared envelope is
today. Envelopes come from the analysis and never from observed writes,
which is the rule Scheduler v2 states for them: "Membership and envelopes
are **declared**".

A computation that creates a cell under a constant cause writes a static
target. `plan-and-label-templates.md` §3.14 makes that cell a `StateCell` of
the plan.

### 6.4 Handlers

A `handler`, an `action`, and an inline event handler have no tier. Each
runs once per event in the transaction of its cause, and the cones its
writes dirtied are known from the writes themselves.

Their record still lists every write. A static target is a `WriteEdge`. A
dynamic target, or one that is too broad, is listed by its envelope. The
runtime refuses a write that neither covers
(`plan-and-label-templates.md` §7.4), so an error in this part of the
analysis fails closed.

A write policy that names a handler is checked against the write edges:
`plan-and-label-templates.md` §4.4 checks at compile time that the body of
a static edge is one the target's policy names. For a dynamic target the
check runs when the write is made.

### 6.5 The label of a written value

Every value a body writes carries the body's template, by §4.1. The
reference rules of §3.8 apply to each path of the written value: a path that
holds one projection of container or handle type is a reference the body
passed on, and its template is that projection's `identity` slot.

This document assumes the plan records such a path as a `WriteEdge` of its
own, at the sub-path, with a `slot` template
([§13](#13-open-questions), request 3).

### 6.6 Idempotency

The idempotency contract of Scheduler v2 (§4.2) applies to every
computation that writes, in either tier: run again against unchanged
inputs, it produces the same writes. The idempotency validator checks it by
running the computation twice, and stays.

The analysis has the read set and the write set of a body side by side, and
reports three shapes that break the contract whatever the data:

- **An append or an increment.** `push`, `pushAll`, and `increment` in a
  computation add to what is there, so a second run writes something else.
- **A send.** `stream.send(event)` in a computation delivers one event per
  run.
- **A read of its own target.** A computation that reads a path at or below
  one it writes, through the same anchored handle, computes its write from
  its own previous write. `count.set(count.get() + 1)` is the simplest case.

The first two are properties of the operation. The third is also the
smallest cycle through a side-write. The read and write sets of all the
bodies of a pattern are what the compiler's static cycle report, which the
overview asks for, is computed from.

`language-subset.md` owns the identifiers and severities of these reports
([§13](#13-open-questions), request 5). The ambient reads that also break
the contract are already refused in a computation
(`function-body:ambient-read`).

## 7. Cell handles

### 7.1 What a body may do with a handle

The methods are those of `language-subset.md` §4.7. For a handle `h`:

| Method | Abstract result | Recorded |
| --- | --- | --- |
| `h.get()`, `h.sample()` | The projection `h->`, the root of the cell `h` links to | `identity` at `h`. What is done with the result is recorded below the hop |
| `h.key("k")` | The handle `h` with `k` added to the path below its hop | Nothing |
| `h.key(k)` with a key that is not static, `h.elementById(id)` | The handle at `*` below `h`. It is not anchored | Nothing here. A read through it is dynamic (§7.2), and a write through it is too broad to predict ([§6.2](#62-targets)) |
| `h.resolveAsCell()` | `h`: the handle it reaches holds the same data | `identity` at `h` |
| `h.for(cause)` | `h` | Nothing |
| `h.getArgumentCell()` | A handle that is not anchored | `identity` at `h` |
| `h.equals(o)`, `h.equalLinks(o)` | `Computed` | `identity` at `h` and at `o` |
| The writers | | [§6.1](#61-what-counts-as-a-write) |
| `index.lookup(k)`, `index.keys()`, `index.keyEntries()` | A projection below the index, at `*` for `lookup` | `value` at `k`, and the index's `enumeration` |

A read through a handle is a hop followed by ordinary accesses.
`box.get()?.label` is the projection `box->label`, with `shape` at `box->`
when the cell may hold no value, and what the body then does with the label
is recorded at that path. Reading through a handle is a dereference in the
sense of `plan-and-label-templates.md` §3.10, which is why each `get()`
records `identity` at the handle.

A method on a collection handle (`map`, `filter`, and the others) is refused
in a body (`cell:collection-method-in-function`).

### 7.2 Static and dynamic reads

A read at `h->q` is **static** when all three hold:

1. `h` is one anchored handle, not a set of alternatives;
2. `q` has no `*` segment and no further hop through a handle that is not
   anchored;
3. the `get()` or `sample()` is unconditional (§3.7).

A static read is an entry of `Body.reads` like any other. Every other read
through a handle is **dynamic**: the handle is listed in `Body.handles`, the
runtime journals what the body reads through it while it runs, and the
journaled reads enter the label as a `dynamic` template
(`plan-and-label-templates.md` §3.9).

One relaxation applies to condition 3. A read that is conditional only on
the handle being present, `profile?.get()` where `profile` may be
`undefined`, counts as unconditional. When the handle is absent there is
nothing at the entry's path to resolve, and the test of its presence is a
`shape` observation the footprint holds anyway.

**Why the conditions.** They are the cases in which a static entry reads
exactly what the body's transaction reads today.

- Today a read through a cell is journaled when it happens. A body that
  reads `secret.get()` in one branch carries the label of `secret` only on
  the runs that take the branch. A static entry is in the label on every
  run. So a conditional read is left dynamic, or the label would be wider
  than today on the runs that skip it (§1.4, requirement 2).
- With alternatives, `(event.donut ?? state.donut).get()`, the body reads
  through one handle and a static entry would name both.
- With `*`, a body that looks up one element of a list of handles and reads
  it would get an entry for every element.

A read of a data-typed input is different: today the argument schema
materializes it before the body runs, on every run, so a static entry for a
conditional data read equals today's read.

**What a static read is for.** A body whose reads are all static has a
template with no `dynamic` node, so its label is a function of slot labels
and can be reused without running the body
(`plan-and-label-templates.md` §4.1). Its inputs are known before it runs,
which is what lets the cones a handler reads be evaluated first
(`plan-and-label-templates.md` §5.4), and what gives the order of
evaluation inside an instance.

### 7.3 A dynamic read is still narrowed

Whether a read happens can be dynamic while what it can read is static. For
each handle the analysis collects the **read envelope**: the paths below the
hop that any read through the handle may observe, each with its class. The
handle's `get()` returns the value narrowed to the envelope, so the journal
holds those reads and no others.

This is where the analysis is tighter than today for the handler of
[§12](#12-worked-example-a-fabrichat-handler). Today each handle in its
state keeps the schema it was declared with, and `message.get()` reads the
whole message. With the envelope it reads the paths the body goes on to
use.

The envelope is also what the scheduler knows of a dynamic read before the
body runs. `plan-and-label-templates.md` has to say where it is recorded
([§13](#13-open-questions), request 2).

### 7.4 Where a handle may go

- **Into a local.** The local is the handle. An alias changes nothing.
- **Into a local container.** The bag's member is the handle, or the
  alternatives of every handle put in. A handle taken back out is anchored
  only when the bag holds one.
- **To an authored function.** The summary's reads, writes, and returned
  value are applied to the handle (§3.6). A helper that resolves a link and
  returns the handle returns the caller's own handle.
- **To an imported function.** Refused: such a function takes no handle
  (`language-subset.md` §5.5).
- **Out of the body,** by `return`, by a write, or as an argument of an
  instantiation or an effect request: `identity` at the handle, and a
  reference the body passed on (§3.8). What the receiver does with the
  handle is in the receiver's footprint.
- **Into a handler binding.** A handle captured by an inline event handler
  or an `action`, or applied as a handler's state, stays a link. The body
  records `identity` at it. The bound handler's reads and writes through it
  are in the handler's own record, over its `binding` root, and not in the
  body that made the binding ([§8.5](#85-binding-a-handler)).
- **To an unresolved call.** The analysis no longer knows what is read or
  written through the handle. Its reads become dynamic with the handle's
  whole declared type as the envelope, and a writable handle makes the
  body's write surface too broad (§6.2).

### 7.5 Link hops through data

There are three ways a body reaches another cell.

- **A handle at a static path,** such as `state.composer`, or
  `state.composer->editing` where `editing` is declared as a cell. The hop
  is explicit and the handle is anchored. §7.2 decides whether a read
  through it is static.
- **A handle found at a computed place:** an element of a list of handles,
  a `key(k)` with a key that is not static, an `elementById`. The handle is
  not anchored, and every read through it is dynamic. The anchored handle
  it was found under is the one listed in `Body.handles`.
- **A link the type does not show.** A position declared with a data type
  can be stored as a link: a record that a handler wrote into a list is a
  document of its own, and the list holds a link to it
  (`builtin-inventory.md`, "Element keys"). The body sees a plain value and
  the analysis sees a path of the declared type. The footprint is the same
  whether storage holds the record inline or as a link. This document
  assumes the runtime resolves an entry whose path crosses such a link as a
  dereference, joining the link's own label, and that
  `plan-and-label-templates.md` says how
  ([§13](#13-open-questions), request 2).

A cell or an instance the body created is not an input. Reading back what
the body itself wrote records nothing.

`sample()` has the footprint of `get()`. The difference is that the body is
not recomputed when the sampled cell changes, which is a property of the
dependency and not of the label ([§13](#13-open-questions), request 2).

## 8. Runtime calls in a body

A body may make five kinds of runtime call (`language-subset.md` §5.2;
`builtin-inventory.md`, "Calls inside function bodies"). Four of them
create something, and the analysis records their sites in `Body.calls`,
with the fields `BodyCall` declares. For all five it records what the call
observes of the body's inputs. A site inside a loop or a closure is one
site.

In each table, "by the reference rule" means the table of §3.8.

### 8.1 Instantiating a pattern

Legal in a `handler` and an `action`.

| Part of the call | Recorded |
| --- | --- |
| The callee, when it is a factory value | `identity` at the position that holds it |
| Each path of the argument | A `WriteEdge` with target `argument`, and the argument's members by the reference rule |
| `.for(tag)` | The tag by the reference rule. The site is `identifiedBy: "tag"` |
| `inSpace(space, options)` | `identity` at a cell that names the space; `value` at a name |
| The link returned | A created value. Reading through it in the same body is a dynamic read with no envelope, since the child's result is declared by its own plan |

### 8.2 Creating a cell

| Where | Recorded |
| --- | --- |
| In a `handler` or an `action` | The site, with `identifiedBy: "order"`. The initial value is a `WriteEdge` with target `created` |
| In a `lift` or a `computed`, with a constant cause | The same, with `identifiedBy: "cause"`. The write is a static target (§6.3) |
| In a `lift` or a `computed`, with a cause computed from data | The same, and the cause by the reference rule: `value` for a scalar, `identity` for a cell. The write's target is dynamic, so the body is a materializer whose envelope is the site |

A cause is constant when its expression is built from literals and
module-scope constants alone. A cause that is the element of the enclosing
element body, captured whole, is that element's key, and
`plan-and-label-templates.md` §3.14 treats it as constant too.

### 8.3 Requesting an effect

Legal in a `handler` and an `action`. The site records the built-in's name.
Each member of the request is recorded by the reference rule, so
`navigateTo(target)` is `identity` at `target`, and a URL built from inputs
is `value` at what it was built from.

The request's label is the body's template. `builtin-inventory.md`
describes the request template as "the join of the body's slots that flow
into the request", which would be a label per value inside a body. By §4.1
there is none, and `plan-and-label-templates.md` §3.14 says the same: "The
request's arguments carry `T_b`".

### 8.4 Reading context

Each context read is recorded as `plan-and-label-templates.md` §3.16 lists
it. The analysis supplies the operand.

| Call | Recorded |
| --- | --- |
| `eventKey()`, `currentPrincipal()` | The `cause` entry. No input is observed |
| `principalOf(x)`, `principalsOf(x)`, `profileOwnerOf(x)` | `identity` and `labelMetadata` at `x` |
| `spaceOf(x)` | `identity` at `x` |
| `resultOwnerOf(x)`, `spaceAccess(x)`, `spaceAccessOf(x, p)`, `spaceMembers(x)` | `identity` at `x`, and a dynamic read through it. `value` at `p` |
| `linksOf(list)` | `enumeration` at `list` and `identity` at `list/*` |
| `equals(a, b)` | `identity` at both |
| `spaceDeleted()`, `getPatternEnvironment()` | Nothing |

When the operand is one anchored handle and the call is unconditional, the
`labelMetadata` entry is static. Otherwise the observation is journaled, as
the runtime records it today, and the operand is listed in `Body.handles`.
This is the rule of §7.2 applied to an observation of a label.

### 8.5 Binding a handler

A binding is made by `action(...)`, by an inline event handler in JSX the
body builds, or by applying a handler to its state. The site refers to a
`Binding` of the plan.

| Captured or applied value | Recorded in the binding body |
| --- | --- |
| A handle | `identity`. It stays a link |
| A scalar | `value`. It is copied |
| A container | `value` at the paths the bound handler's own footprint reads of it. They are copied |
| A container, when the handler is a factory value | `value` over the subtree the handler's declared state type covers, since the handler's footprint is not known until the binding is made (`plan-and-label-templates.md` §3.21) |

The third row uses the hoisted or named handler's record, which the compiler
has: the handler's footprint over its `binding` root says which paths of
each captured value it reads, and the copy needs no more.

The bound handler is a body of its own, analyzed with the captured values as
formal inputs. Its reads and writes happen when an event arrives, in that
event's transaction, and are not part of the body that made the binding.

## 9. Soundness

### 9.1 The statement

Fix a body `b` with footprint `F`. Two arguments **agree on `F`** when, for
every static entry of `F`, they give the same observation:

| Class | Two arguments agree at `x.p` when |
| --- | --- |
| `value` | The values at `p` are equal, down to each position that holds a handle, and the references at those positions are the same |
| `shape` | The path exists in both or in neither, and holds a value of the same kind |
| `enumeration` | The containers at `p` have the same keys in the same order, or the same length |
| `identity` | The references at `p` are the same |
| `labelMetadata` | The label metadata observed at `p` is the same |

Two executions **agree on dynamic reads** when every read made through a
handle of `Body.handles`, and every context read recorded as dynamic,
returns the same value in both.

**S1 (reads).** If two executions of `b` receive arguments that agree on
`F`, and agree on dynamic reads, then they behave alike: they return the
same value or throw the same error, make the same writes with the same
values to the same targets, and make the same runtime calls with the same
arguments in the same order.

**S2 (writes and calls).** Every write an execution of `b` makes has a
target that a `WriteEdge` of the body names, or that lies under one of its
envelopes. Every runtime call it makes is at a site in `Body.calls`.

**S3 (references).** If `Body.outputs`, or a write edge, records that a
path holds a reference the body passed on, then on every execution the
reference at that path is the one, or one of the ones, named.

S1 is the lemma the specification needs. It says a body is a function of
its footprint, which is the property an opaque call with a footprint has in
the calculus of the plan. It is stated over arguments and not over an
instrumented execution, so it does not depend on defining what each
JavaScript operation "observes": the classes are defined by which arguments
they tell apart. The transfer rules of §3 are how the analysis establishes
it, and the proof obligation for the analysis is that each rule's
observations are enough for the operation to give equal results on
arguments that agree.

Two corollaries are used elsewhere.

- **Narrowing preserves behavior.** The argument the runtime builds from
  `F` agrees on `F` with the full input. By S1 the body behaves on it as it
  would on the full input.
- **Widening preserves S1** (§5.4). Arguments that agree on a wider
  footprint agree on the narrower one.

### 9.2 What rests on the analysis

`plan-and-label-templates.md` §7 separates what the runtime enforces from
what holds only if the compiler is correct. For the footprint:

| Property | If the analysis is wrong | Rests on the analysis? |
| --- | --- | --- |
| The label of a body's result covers everything the result depends on | An entry missing from `reads` is not materialized. The body computes from an argument that lacks it, and the label still covers everything the body was given | No. Body narrowing is enforced by the runtime (§7.3 there) |
| Data outside the footprint stays confidential from the body | The same: the body is not given it | No |
| The body computes what its author wrote | A missing entry gives the body an absent value or a default, or fails its cone on validation. The result is wrong or an error state, with a label that covers it | Yes: this is S1 |
| A class is narrow enough | A `shape` entry where the body needs the value gives the body a stand-in. The result is wrong, with a label that covers what was given | Yes, for correctness. No, for the label |
| A read marked static is unconditional | The entry is in the label on a run that did not read it. The label is wider than today's on that run | For precision only |
| A read left dynamic | The runtime journals it | No |
| A body writes only what its record lists | The runtime refuses the write | No. It fails closed (§7.4 there) |
| A reference recorded as passed on | The runtime compares identities and falls back to the body's template | No |
| The tier of a computation | A computation classed as having static targets that writes elsewhere has the write refused | No. It fails closed |

So an analysis that under-approximates a read fails closed for
confidentiality and integrity, and fails open only for the correctness of
the value. That failure is visible: the body runs against an argument that
lacks something it reads, and for a missing required path the cone takes an
error state.

The fourth row depends on how the runtime builds an argument from entries
of class `shape`, `enumeration`, and `identity`: it has to hand the body
something that carries that observation and no more. That is a question for
`execution-and-storage.md` ([§13](#13-open-questions), request 8).

## 10. Relation to the current system

### 10.1 What the transformer and the schema generator do today

The current pipeline already narrows the schemas a body is invoked with. It
has three parts.

**Capability analysis.** `analyzeFunctionCapabilities` in
`base/ts-transformers/src/policy/capability-analysis.ts` walks a function
and returns a `FunctionCapabilitySummary` (declared in
`base/ts-transformers/src/core/transformers.ts`), with one
`CapabilityParamSummary` per parameter. A summary holds sets of paths, each
a list of static string segments:

- `readPaths`, `fullShapePaths`, `writePaths`, and `opaquePaths`;
- `identityPaths` and `comparablePaths`, with the subsets that are cells,
  for values the body only passes on or only compares
  (`isKnownIdentityArgumentCall` recognizes `equals`, `equalLinks`, and
  `navigateTo`);
- `forwardedPaths`, for values handed to a pattern the body instantiates,
  and `escapedPaths`, for values that left the function whole;
- the flags `wildcard`, with `wildcardPaths`, `passthrough`, and
  `hasUnverifiedCellUse`, and one `capability` for the parameter
  (`"opaque"`, `"comparable"`, `"readonly"`, `"writeonly"`, or
  `"writable"`).

The analysis resolves a value to the inputs it may be: through locals,
destructuring, conditionals and fallbacks, array literals, local arrays and
maps, the element parameters of array callbacks (the table
`ARRAY_CALLBACK_PARAMETERS`), and the cell methods of the table
`CELL_REF_STEPS` (`key`, `elementById`, `for`, `resolveAsCell`). It reads a
member access through `get()` as a path below the cell. Where the mode asks
for it, it follows a call into a helper declared in the same source file
(`isInterproceduralSummaryTarget`). The
[current-behavior specification](../ts-transformer/ts_transformers_current_behavior_spec.md)
describes it in full, in its §6.4 and §10.7.

**Shrinking.** `applyShrinkAndWrap` in
`base/ts-transformers/src/transformers/type-shrinking.ts` applies a summary
to a parameter's type and returns a narrowed type node. It keeps the paths
the summary retains, replaces an identity-only position by `unknown` or by
an opaque or comparable cell (`applyIdentityOnlyPathsToTypeNode`), keeps an
array whose items are not read as an array of `unknown`
(`isArrayRootOnlyPath`), and wraps a cell in the wrapper its capability
selects. `validateShrinkCoverage` reports a path the declared type does not
have (`schema:path-not-in-type`, `schema:unknown-type-access`). It is called
from `applyCapabilitySummaryToArgument` and
`applyCapabilitySummaryToParameter` in
`base/ts-transformers/src/transformers/schema-injection.ts`, and from
`base/ts-transformers/src/closures/strategies/lift-applied-strategy.ts` for
a lowered `computed`.

The summary is applied in one of three modes
(`CapabilitySummaryApplicationMode`):

- `full`, for a `lift`, a lowered `computed`, and a handler's state: the
  type is narrowed to what the body uses;
- `defaults_only`, for a pattern's input: defaults are kept and the shape
  is not narrowed;
- `contract`, for a handler's or an action's event when its type is
  authored: the authored type is served whole, and only the capability of
  each cell in it is narrowed to what the body does at that path
  (`narrowEventCapabilities` in
  `base/ts-transformers/src/transformers/contract-capabilities.ts`).

**Schema generation.** `SchemaGenerator` in
`base/schema-generator/src/schema-generator.ts` turns the narrowed type
node into a JSON schema, in which a cell is an `asCell` marker around the
schema of its value. The runner reads a node's inputs through that schema
(`#readJavaScriptArgument` in `runtime/runner/src/runner.ts`), so the
schema is what the body is given. Reads the body makes through a cell at
run time are journaled by the transaction.

**Writes.** For a lowered `computed`, `createDeriveSchedulerOptions` in
`lift-applied-strategy.ts` emits the summary's write paths as
`materializerWriteInputPaths`, and emits
`completeSchedulerScopeSummary` when the summary has no wildcard, no
unverified cell use, no passthrough, and no opaque path
(`hasCompleteSchedulerScopeSummary`). The runner resolves the input paths
to `materializerWriteEnvelopes` (`#collectWritableCellArgumentLinks`, called
from `#instantiateJavaScriptActionNode`). Its static side-write tier is
reserved for outputs bound by a write redirect
(`#collectStaticRedirectWriteTargetsWithCompleteness`). So today a
`computed` that writes through a captured cell is a materializer whenever
its write paths resolve to a cell, whether or not the target is static.

### 10.2 Where the proposed analysis differs

| Aspect | Today | Proposed |
| --- | --- | --- |
| Where it runs | On the TypeScript syntax tree with the TypeScript checker, between transformer stages, with a registry of types for nodes the transformer synthesized | In the compiler, after the subset type checker, on source it has typed in full |
| Result | Path sets by kind, turned into a narrowed type and then a schema | Entries of a path and a class, a list of handles, write edges, calls, and widenings. The schema is derived from the entries |
| Classes | A read; an identity use (`unknown`, opaque and comparable cells); an array kept with unread items. A truthiness test of a container adds no path of its own (`isBooleanConditionUsage`) | The five classes of the plan, on every path |
| Reach | Helpers in the same source file. A value passed to a helper in another file leaves whole, and a cell passed to one is judged by the wrapper type the helper declares; a declaration the analysis cannot read is the error `capability:unreadable-cell-argument` | Every authored function of the program. Only an imported TypeScript function is opaque, and it takes no cell |
| Losing track | A `wildcard` on a parameter turns shrinking off for the whole parameter (`applyShrinkAndWrap` shrinks only when the flag is unset) | A widening covers the subtree of the value that was lost, and nothing beside it |
| A key that is not static | The whole static prefix above the key is read (`trackDynamicRead`) | Every child of the keyed container, at the paths read below the key |
| Object spread, `for...in` | A wildcard (`markWildcardFromExpression`) | A spread is expanded by property, or copied as a bag of the children where the type has an index signature. `for...in` is not in the language |
| `Object.keys`, `Object.values`, `Object.entries`, `JSON.stringify` | A wildcard (`classifyWildcardTraversalCall` in `base/ts-transformers/src/ast/call-kind.ts`) | `enumeration`, with `*` children for the two that return values; `JSON.stringify` reads its argument and nothing beside it |
| A handler's event | Served as the authored type, whole; cells in it narrowed by capability | The body is given the paths its footprint names. The declared event type stays the contract of the stream (§10.4) |
| Reads through a cell | The cell's value type is narrowed where the access chain resolves. Every read is journaled at run time | A static entry when the read is unconditional through one anchored handle. Otherwise journaled, under the handle's read envelope |
| Writes through a cell | The cell's wrapper becomes writable; a lowered `computed` carries its write paths, and is a materializer when they resolve | Write edges. A computation whose targets are all static is not a materializer |
| What it cannot verify | `hasUnverifiedCellUse`, set by a method call on a cell the analysis does not know | The language refuses an undeclared cell method (`cell:unsupported-method`), so the case does not arise |

Every row narrows, or leaves the same, what a body reads. None widens it,
which is requirement 2 of §1.4.

### 10.3 What can be reused

The compiler is a separate program, so no code carries over. Three things
do.

- **The rules.** The alias resolution of the current analysis is the
  environment of §3.5 and §3.6 in another form: the value-to-inputs
  resolution (`resolveValueRefs`), the cell steps (`CELL_REF_STEPS`), the
  callback parameter table (`ARRAY_CALLBACK_PARAMETERS`), the rule for when
  a key is static (`getStaticPathKey`), and the rule for which destinations
  keep a value by reference (`wholeValueDestination`). The proposed rules
  are checked against each of them.
- **The tests.** The suites under `base/ts-transformers/test/policy/`
  (`capability-analysis.test.ts` and its siblings for array callbacks,
  dynamic keys, static keys, value references, whole-value escapes, and
  interprocedural summaries) state the expected reads and writes of small
  bodies. They are the first test corpus for the new analysis, read as
  "the footprint is no wider than this".
- **The summaries as an oracle.** Stage 3 of the overview compares template
  labels with today's labels. The same run can compare, body by body, the
  proposed footprint with the summary `analyzeFunctionCapabilities`
  returns, and report every body where the proposed one is wider.

The check for a read followed by a mergeable push
(`createMergeablePushClassifier` in
`base/ts-transformers/src/policy/mergeable-push-classification.ts`) uses
the same read and write sets and moves with them. Its diagnostic,
`mergeable-push:read-then-push`, is carried by `language-subset.md`.

### 10.4 A handler's event

The `contract` mode exists because an event's schema has two readers. It
tells a sender what the stream accepts, and it tells the runner what to
give the body. Today one schema does both, so the body is given the whole
declared event.

In the proposed design the two are separate records. The event schema of a
`Binding` is the declared type, which a sender is checked against. The
handler's footprint over its `event` root is what the body is given and
what joins the label of what it writes. A handler that reads `event.body`
of an event type with eight fields carries the label of `body`.

`plan-and-label-templates.md` §3.12 compares a handler's template with
today's transaction join and calls them equal. For the event they are not:
today's transaction reads every declared field of an authored event, and
the template reads the footprint. The template is tighter
([§13](#13-open-questions), request 4).

## 11. Corpus measurement

### 11.1 Method

The corpus is the one `language-subset.md` §11.1 defines: every `.ts` and
`.tsx` file under the six pattern categories that imports `commonfabric`,
or is reachable by relative import from a file that does, without test
files, the test fixture `patterns/system/fabrichat/room-test-fixture.ts`,
the iframe guest scripts, and the Topics command-line tools. A throwaway
script, which is not part of the repository, parsed each file with the
TypeScript parser, found the bodies of §1.2, applied the promotion criterion
of `language-subset.md` §6.1 by syntax, and looked in each remaining body
for the constructs of §5.2, §6, and §7.

By that rule the script counts 423 modules and about 119,000 lines.
`language-subset.md` counts 403 modules by the same rule. The difference of
20 modules was not traced. The counts of definitions agree with
`builtin-inventory.md` to within a few: 620 `handler` definitions, 73
`lift` definitions, 1,493 `computed` calls, 249 `action` calls, and 188
inline event handlers.

**The numbers are syntactic.** The script has no type information. It
marks a local as holding an input by following property accesses,
destructuring, loop variables, callback parameters, and a short list of
methods, and it does not follow a value through the return of a helper.
Three things follow.

- It cannot tell an array from a record, so it separates index-like keys
  (a loop counter, an index parameter, arithmetic) from other keys by their
  form.
- It cannot see a conversion of a container in a template literal, in
  `String()`, or in an operator, so W2 is counted for `JSON.stringify` and
  `console` only.
- It counts a handle returned by a helper as not anchored, where the
  analysis would apply the helper's summary.

"Through helpers" in the tables counts a body when it, or an authored
function it passes an input to, directly or through further calls, contains
the construct.

### 11.2 Bodies

| Kind | Corpus | FabriChat |
| --- | --- | --- |
| `handler` | 620 | 25 |
| `action` | 249 | 10 |
| Inline event handler | 188 | 0 |
| `lift` | 73 | 0 |
| `computed`, not promoted | 121 of 1,493 | 3 of 112 |
| Authored function | 711 | 91 |
| **Bodies and summaries analyzed** | **1,962** | **129** |

The other 1,372 `computed` calls (92%) meet the promotion criterion by
syntax and are not bodies. `language-subset.md` §11.5 reports 1,351 of
1,466 on its count of the corpus, the same share.

### 11.3 Where the analysis gives up

Bodies that contain each cause, directly and through helpers, of 1,962:

| Cause | Sites | Directly | Through helpers | By kind, through helpers |
| --- | --- | --- | --- | --- |
| W1: a key that is not static and not index-like, on an input | 50 | 36 | 64 | 16 handlers, 2 actions, 7 computeds, 39 functions |
| W2: `JSON.stringify` applied to an input | 8 | 4 | 4 | 1 lift, 2 computeds, 1 function |
| W2: an input passed to `console` | 26 | 10 | 10 | 5 handlers, 3 actions, 1 inline handler, 1 computed |
| W3: an imported TypeScript function | 0 | 0 | 0 | No module carries the directive yet |
| W4: an input passed to a call the script could not resolve | 6 | 4 | 6 | 2 handlers, 4 functions |
| W5: an input updated in place | 0 | 0 | 0 | |
| W6: a recursive authored function | 0 | 0 | 0 | Three closures inside bodies call themselves |
| **Any of the above** | | **53 (2.7%)** | **83 (4.2%)** | 23 handlers, 4 actions, 1 inline handler, 1 lift, 10 computeds, 44 functions |

By syntax, then, the analysis gives up somewhere in about one body in
twenty-five, counting the helpers a body passes its inputs to. In three
quarters of those the cause is W1, where the analysis still tracks the paths
read below the key.

Constructs that occur and do not widen:

| Construct | Sites | Bodies, directly | Through helpers |
| --- | --- | --- | --- |
| An index-like key on an input | 75 | 59 | 74 |
| A spread of an input into an array or a call | 167 | 123 | 150 |
| A spread of an input into an object, or an object rest element | 94 | 67 | 113 |
| `Object.keys`, `Object.values`, or `Object.entries` of an input | 36 | 31 | 66 |
| `JSON.stringify` of an array or object built from inputs | 7 | 7 | 24 |
| A call of a function parameter | 8 | 7 | 22 |

The `JSON.stringify` row is the idiom that builds an identifier from a few
strings, `JSON.stringify([space, requestId])`. It reads the members it
names, each by its own type.

Under the current analysis, object spread, `Object.keys` and its siblings,
and `JSON.stringify` are wildcards that turn shrinking off for the whole
parameter, and a key that is not static reads its whole prefix (§10.2).
Counting those, 136 bodies directly and 208 through helpers (10.6%) contain
a construct on which the current analysis gives up. Two and a half times as
many bodies are affected as under the proposed analysis, and each of them
loses the narrowing of a whole parameter where the proposed analysis loses
a subtree.

### 11.4 Reads through handles

The script counted every `get()` and `sample()` with no argument: 1,201
reads in 649 bodies.

| Reads | Count | Share |
| --- | --- | --- |
| Through an anchored handle at a static path, unconditional: static by §7.2 | 684 | 57% |
| Through an anchored handle at a static path, conditional | 401 | 33% |
| Through a handle the script could not anchor | 116 | 10% |

361 of the 649 bodies (56%) have only reads of the first kind and would
have a template with no `dynamic` node. The third row is an upper bound: 68
of its reads go through a local the script could not trace and 17 through a
handle a helper returned, both of which the analysis resolves. 17 are under
a key that is not static and 14 are elements of a collection, which stay
dynamic.

The second row is the cost of requirement 2 of §1.4. A third of the reads
through handles are at a known place and happen only on some runs, usually
after an early `return`. They stay dynamic so that the label is no wider
than today's ([§13](#13-open-questions), question 1).

Separately, 153 sites in 111 bodies call `key(k)` or `elementById` with a
key that is not static. A read under one is dynamic, and a write under one
is too broad to predict (§6.2).

### 11.5 Writes

| Kind | Bodies that write through a handle | Every target at a static path | Write sites | Sites at a static path |
| --- | --- | --- | --- | --- |
| `handler` | 567 | 519 | 1,005 | 940 |
| `action` | 233 | 226 | 450 | 436 |
| Inline event handler | 185 | 183 | 219 | 217 |
| `computed`, not promoted | 23 | 23 | 32 | 32 |
| `lift` | 1 | 0 | 2 | 0 |
| Authored function | 51 | 28 | 115 | 83 |

Of the 194 computations (73 `lift` bodies and 121 `computed` bodies that
are not promoted), 33 write anything beside their result in their own
text.

- **23 `computed` bodies write through a captured cell, and every one of
  their 32 write sites is a `set` at a static path.** Under §6.3 all 23
  have static side-write targets. Today each carries
  `materializerWriteInputPaths` and is a materializer when those paths
  resolve (§10.1). Eleven of them are under `patterns/dev/`, and six of
  those exist to test the idempotency validator.
- **One `lift` writes through elements of a list**
  (`patterns/system/backlinks-index/backlinks-index.tsx`). It stays a
  materializer.
- **Nine `lift` bodies create a cell under an explicit cause and write it
  at once,** in `patterns/apps/topics/main.tsx`,
  `patterns/product/collection-naming/naming.ts`,
  `patterns/examples/cfc-spec-gallery/main.tsx`,
  `patterns/examples/cfc-render-policy-demo/main.tsx`, and
  `patterns/examples/cfc-trusted-component-examples/disclaimer-examples.tsx`.
  `builtin-inventory.md` counts one more that does so through a helper. In
  every one the cause is computed from data: a topic, a member, an
  identifier field of the input. So all are materializers with a creation
  site as their envelope (§8.2). No computation in the corpus creates a
  cell under a constant cause.

So the write-path analysis leaves 10 materializers among these 33
computations, or 11 of 34 with the one the inventory adds.

### 11.6 FabriChat

FabriChat is the eight source modules of `patterns/system/fabrichat/`. The
tree the script ran on has 25 handlers there, 10 actions, and 112
`computed` calls, of which 109 are promoted by syntax.

| | Handlers (25) | Actions (10) | Computeds (3) | Functions (91) |
| --- | --- | --- | --- | --- |
| W1, directly / through helpers | 0 / 3 | 0 / 0 | 0 / 0 | 8 / 10 |
| W2 to W6 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Any | 0 / 3 | 0 / 0 | 0 / 0 | 8 / 10 |

No FabriChat handler contains a widening construct itself. Three reach one
through a helper: the manager handlers `commitStart`, `commitManager`, and
`listRooms` call helpers that read catalog records under a computed key.
That is the only cause in FabriChat, in eight authored functions. Its three
uses of `JSON.stringify` build identifiers from strings, and its four
object spreads, one of them in `settleTakenOut`, copy records of declared
types. Neither widens.

Handles: 83 reads in 44 bodies, of which 22 are static by syntax, 19 are
conditional, and 42 go through a handle the script could not anchor. The
last figure is high because FabriChat resolves its handles through small
helpers (`resolvedProfile`, `messageInRoom`, `reactionsOf`), which the
script does not follow. 25 sites use `key(k)` with a key that is not
static, which is how the room reads and writes its per-message and
per-request records.

Writes: 19 of the 25 handlers write through a handle, at 43 sites, of which
27 are at a static path by syntax. All 10 actions write at static paths
only. No FabriChat computation writes.

### 11.7 What the prototype has to re-measure

The type-checker prototype of the overview's stage 2 replaces these numbers.
It has to measure:

1. how many keys that are not static are indexes into arrays, and how many
   of the rest (W1) are followed by a read of a few paths, where the
   widening is narrow, or by a read of the whole child;
2. the conversions of containers the script cannot see (W2);
3. the share of handle reads that are static once helper summaries are
   applied, and the share of bodies with no `dynamic` node;
4. for each body, whether the proposed footprint is within the summary the
   current analysis returns (§10.3), which is the test of requirement 2;
5. the write tiers of §11.5 with handles resolved through helpers.

## 12. Worked example: a FabriChat handler

`commitEdit` in `patterns/system/fabrichat/room-records.tsx` records a new
version of a message. It is bound to a rendered message's edit control and
to the room's exported `editMessage` stream. It is a useful example because
it reads its event, reads through three handles, calls seven helpers, reads
context in four ways, and writes two cells.

### 12.1 The source, in outline

The handler's event is a `RoomStreamEvent`: optional `body`, `replyTo`,
`threadTitle`, `attachments`, `message`, `reaction`, `emoji`, and `target`.
Its state is an `EditState`: `myProfile`, a profile cell or `undefined`;
`room`, a cell of unknown content; `message`, an optional message cell; and
`composer`, the cell of the session's composer state.

The body does the following.

1. `resolvedProfile(myProfile)` resolves the profile link and returns the
   resolved handle, or `undefined` when there is no handle or the profile
   holds no value. The body throws when the result is `undefined`.
2. `messageInRoom(room, event?.message ?? message)` resolves whichever
   message link is present, throws when there is none or when
   `spaceOf(target)` differs from `spaceOf(room)`, and returns the resolved
   handle, `target`.
3. `current = target.get()`. The body throws when `isDeleted(current)`,
   which tests whether `current` is `undefined` or `current.body` is not a
   string.
4. `isActorAuthor(target)` compares `currentPrincipal()` with
   `principalOf(target, "authored-by")`. The body throws when they differ.
5. `textOf(event)` returns `event.body`, or else `event.target.value`, when
   it is a string. `hasTextIn(event)` tests the same two fields. The body
   throws when there is no text, or when the text is blank and
   `current.attachments` is absent or empty.
6. `target.key("body").set(body)` and `target.key("editedAt").set(now())`.
7. `editing = composer.get()?.editing`. When it is defined and
   `equals(editing, target)`, the body does
   `composer.key("editing").set(undefined)`.

### 12.2 The analysis, step by step

Formal inputs are `event` and the four members of the state. The helpers'
summaries are applied at each call.

**Step 1.** The summary of `resolvedProfile(p)`: `p?.resolveAsCell()` tests
whether the handle is present and resolves it, recording `shape` and
`identity` at `p`. `profile?.get() === undefined` reads through it and
compares with `undefined`, recording `shape` at `p->`. It returns `p`.
Applied to `myProfile`, which is one anchored handle. The read is
conditional only on the handle being present, and the call is the first
statement, so the read is static.

The `shape` entry assumes the profile cell's type admits `undefined`. The
source declares it as a cell of the profile record and relies on `get()`
returning `undefined` for a profile that has not resolved. In this language
a test the type decides records nothing (§2.2), and a cell that holds no
value where its type requires one fails the cone that reads it
(`plan-and-label-templates.md` §5.2). The helper keeps its meaning only if
the type says the value can be absent ([§13](#13-open-questions), request
14).

**Step 2.** `event?.message` records nothing for `event`, whose type admits
no `undefined`. `?? message` records `shape` at `event.message`. The
argument is the alternatives `{event.message, state.message}`. The summary
of `messageInRoom(room, link)` records `shape` and `identity` at `link` and,
through `spaceOf`, `identity` at `room`. It returns `link`. So `target` is
the alternatives `{event.message, state.message}`.

**Step 3.** `target.get()` is unconditional, since the statements before it
can throw and cannot return. It still fails condition 1 of §7.2: the handle
is a set of alternatives. The read is dynamic through both handles.
`isDeleted(current)` adds `(root) : shape` and `body : shape` to their read
envelopes, because `typeof record.body` asks for the kind of `body` and not
for its content.

**Step 4.** `currentPrincipal()` is the `cause` entry. `principalOf(target,
…)` is an observation of label metadata through the same alternatives, so
it is journaled.

**Step 5.** `textOf` and `hasTextIn` record `shape` and `value` at
`event.body`, `shape` at `event.target`, and `shape` and `value` at
`event.target/value`. `current.attachments?.length` adds
`attachments : shape` and `attachments : enumeration` to the read envelope
of the two message handles.

**Step 6.** Two writes through the alternatives, at the static paths `body`
and `editedAt`. By §6.2 these are static targets, one per alternative. The
value written to `body` is `Computed`: it came through `textOf`, which
returns a projection or a constant, and then through a test of
`body.trim()`, but its label is the body's template whatever it is. `now()`
reads the handler clock, which has no entry
(`plan-and-label-templates.md`, open question 8).

**Step 7.** `composer` is one anchored handle and the read is
unconditional, so it is static. The `?.` after `get()` records nothing: the
composer's value has a declared default and its type admits no `undefined`.
`composer->editing` gets `shape` from the test against `undefined` and
`identity` from `equals`. The write to `composer->editing` is conditional,
which does not matter for a write: the edge says what the body may write.

No step widens.

### 12.3 The footprint

```text
reads
  cause   principal              : value
  event   body                   : shape, value
  event   target                 : shape
  event   target/value           : shape, value
  event   message                : shape, identity
  state   myProfile              : shape, identity
  state   myProfile->            : shape
  state   room                   : identity
  state   message                : shape, identity
  state   composer               : identity
  state   composer->editing      : shape, identity

handles, with their read envelopes
  event.message, state.message
          ->                     : shape
          ->body                 : shape
          ->attachments          : shape, enumeration
          label metadata (authored-by)

writes
  event.message->body            state.message->body
  event.message->editedAt        state.message->editedAt
  state.composer->editing

calls
  context reads only: currentPrincipal, principalOf, spaceOf, equals

widenings
  none
```

The template of everything `commitEdit` writes is `derive` over the eleven
static entries and the journaled reads through the two message handles.

### 12.4 Against what the transformer emits today

The schemas below were read from the transformer's output for the module
(`deno task cf check … --show-transformed --no-run`).

| Input | Today | Under this analysis |
| --- | --- | --- |
| `event` | The whole `RoomStreamEvent`: all eight fields, with the full schemas of the message, reaction, reply, and file records behind its cells (the `contract` mode of §10.1) | `body`, `target/value`, and the reference at `message` |
| `state.myProfile` | A read-only cell of the profile record, with `name` and `avatar` | The reference, and whether the profile holds a value |
| `state.message`, `event.message` | A cell of the whole `MessageRecord`. `target.get()` reads `body`, `sentAt`, `editedAt`, `replyTo`, and the references at `authorProfile`, `attachments`, and `reactions`. `state.message` is emitted read-only, although the body writes through the handle `messageInRoom` returns for it | The kind of `body`, and the presence and length of `attachments`. Two write edges per handle |
| `state.composer` | A cell of the whole `ComposerState`: the draft, the attachments being added and removed, and four message references | The reference at `editing`, and whether there is one |
| `state.room` | A read-only cell of unknown content | The reference |

The labels differ accordingly. Today the handler's transaction reads the
draft text in `composer`, although an edit never looks at it. A deployment
that labeled a session's draft would put that label on every edited
message. Under the footprint it does not.

FabriChat declares no confidentiality, so as deployed the instantiated
labels are equal, as `plan-and-label-templates.md` §6.4 finds for the send
handler. The difference is in what the handler loads.

### 12.5 The send handler of the plan's example

`plan-and-label-templates.md` §6.2 lists `commitSend` with the handles
`myProfile`, `messages`, and `threadInfo`. Applying this analysis to the
source gives a different list.

- The read through `myProfile` is the call of `resolvedProfile` that opens
  `sendInto`, the same static read as step 1 above.
- `messages` is not read through. `sendInto` passes it to `spaceOf`, by way
  of `isInRoomOf`, which records `identity`, and pushes onto it.
- The dynamic reads go through handles the event carries: each element of
  `event.attachments`, read in `attachmentsIn`, and `event.replyTo/thread`
  and `event.replyTo/quotes`, read in `checkedReply` when the event names a
  reply.
- `threadInfo` stays a handle. It is read under a key computed from the
  thread's root, through `elementById`.

The example is for its author to correct
([§13](#13-open-questions), request 13).

## 13. Open questions

Decided in this document, and written into the sections above: a body's
computed values have one template, and only references are told apart
(§4.1, which settles open question 1 of `plan-and-label-templates.md`); a
widening covers the subtree of the value that was lost, and for a key that
is not static it covers the children at the paths read (§5.2); a read
through a handle is static exactly under the three conditions of §7.2; a
computation is a materializer exactly when one of its side-writes has a
target that is not static (§6.3); and an under-approximated read fails
closed for labels (§9.2).

### Needing the project owner

1. **Conditional reads through handles.** A third of the reads through
   handles in the corpus are at a statically known place and happen on some
   runs only (§11.4). The ruling that template labels are never wider than
   today's keeps them dynamic. Making them static would remove the
   `dynamic` node from the templates of many more bodies, at the price of a
   label that includes a cell on runs that did not read it. *Assumed:* they stay
   dynamic, and the ruling has no second exception.
2. **A value passed on unchanged is a reference.** §3.8 records `identity`,
   and not `value`, for a record a body reads from an input and returns or
   writes whole. That is how the current analysis treats it
   (`wholeValueDestination`), and it is what keeps such a body from reading
   the record. It makes "passed on unchanged" a rule of the language with a
   visible consequence: the stored value is a link to the original, and a
   later change to the original shows through it. *Assumed:* the rule
   stands as today. The alternative, a copy, reads the record in full and
   is wider than today.

### For another document or the prototype

Each request states the assumption this document made.

1. **Formal inputs and slots** (to `plan-and-label-templates.md`).
   `Body.reads` indexes slots. A body's input can also be a value another
   cone computed, which has a template and no slot. *Assumed:* the
   footprint is over formal inputs, and where a body is used the compiler
   maps each entry to a slot, or to the sub-template of the producing
   expression at that path.
2. **Handles in the record** (to `plan-and-label-templates.md`). Five
   things need settling. (a) An entry of `reads` whose path crosses a link:
   a static read through a handle (`composer->editing`), and a data-typed
   path that storage holds as a link (§7.5). *Assumed:* a slot path may
   cross a link, and the slot's label then joins the link's `identity`
   label with the observation at the target, as §3.10 there says of a
   dereference. (b) What an index in `Body.handles` refers to. *Assumed:*
   the `identity` slot of the handle. (c) The read envelope of a handle
   (§7.3). *Assumed:* the `schema` of that slot is the narrowed schema of
   what is read through it. (d) A sampled read, which is in the label and
   does not dirty the cone. *Assumed:* a flag on the slot. (e) The overview
   and §1.1 there say every read through a handle is journaled, and §7.2
   here makes the unconditional ones static. *Assumed:* `Body.handles`
   lists a handle only when some read through it is dynamic, and both
   documents are corrected.
3. **Write targets** (to `plan-and-label-templates.md`). `WriteEdge.target`
   names outputs, state cells of the instance, child arguments, created
   cells, and anchors documents. A handler writes through handles in its
   event and its bound state, which §3.21 there describes as "relative to
   the cells in its state". *Assumed:* a target that names a handle's
   `identity` slot and a path below it; an envelope form of the same for a
   dynamic write; and one `WriteEdge` per sub-path where a written value
   holds a passed reference (§6.5).
4. **A handler's event against today** (to `plan-and-label-templates.md`).
   §3.9 and §3.12 there take today's argument schema to be the narrowed
   one. For an authored event it is the whole declared type (§10.4), so the
   handler row of the summary is "equal or tighter", not "equal".
   *Assumed:* the event schema of a `Binding` stays the declared type, and
   the footprint narrows what the body is given.
5. **The grammar's list of causes, and three diagnostics** (to
   `language-subset.md`). §5.4 there lists the causes of a widening visible
   in syntax, ahead of this document. It differs from §5.2 here in four
   ways. A key that is not static widens to the container's children at the
   paths read, and an index into an array does not widen. A spread or a
   rest element never widens. An input captured by a closure never widens,
   and since an imported function takes no function argument (§5.5 there),
   that entry has no instance. And W5, W6, and W7 are missing. *Assumed:*
   §5.4 refers to §5.2 here. This document also uses the hints
   `footprint:dynamic-read` and `footprint:materializer` (§5.3), and a
   report for the three shapes of §6.6. *Assumed:* hints for the first two
   and a warning for the third.
6. **Read-only inputs** (to `language-subset.md`). If the value a body
   receives has a deeply read-only type, as module-scope data has, an
   update in place is a type error and W5 goes away. The corpus has no
   instance of it by syntax (§11.3), and today it throws (§3.5).
   *Assumed:* inputs are mutable in the type system, and W5 stands.
7. **The request template of an effect** (to `builtin-inventory.md`). "An
   effect request made from a body" describes the request template as the
   join of the slots that flow into the request. *Assumed:* the body's
   template, as `plan-and-label-templates.md` §3.14 has it (§8.3). The same
   section's statement that a cell created in a lift is a materializer
   "unless the write-path analysis can bound the target" is settled by
   §8.2: it is bounded for a constant cause only.
8. **Building an argument from entries** (to `execution-and-storage.md`).
   The runtime has to hand a body a value for an entry of class `shape`,
   `enumeration`, or `identity` that carries that observation and no more:
   a stand-in of the right kind, a container with the right keys or length,
   a reference that can be passed on and not read. *Assumed:* it does, as
   the opaque and comparable cells and the `unknown` items of today's
   schemas do. The same document has to confirm that a value passed on
   unchanged is stored as a reference (question 2 above), and that a
   handle's `get()` returns the value narrowed to the envelope.
9. **Static reads and the scheduler** (to
   `scheduler-and-serving-loop.md`). *Assumed:* the static entries of a
   handler are what is evaluated before its body; a handle of
   `Body.handles` stands for its read envelope when the order of
   evaluation is decided; the envelope of a materializer is the one of
   §6.2; and the read and write sets of §6.6 are the input of the static
   cycle report.
10. **Limits** (to the prototype). W6 cuts a recursive type at its second
    entry, and W7 needs two bounds: alternatives per value, and rounds to a
    fixed point. *Assumed:* the second entry, eight alternatives, and eight
    rounds. The prototype measures whether any body in the corpus reaches
    them. No authored function in the corpus is recursive (§11.3).
11. **Logs** (to the overview). `console` is in the standard-library
    surface, and a body can pass it labeled data. This analysis counts the
    arguments as read. Whether the sandbox lets labeled data reach a log is
    outside it.
12. **The measurements** (to the prototype): the five items of §11.7.
13. **The plan's FabriChat example** (to `plan-and-label-templates.md`).
    §6.2 there lists `messages` as a handle of `commitSend` and gives
    `event.replyTo` a `value` slot. In the source the handler reads through
    the reply's two message handles and the attachment handles, and uses
    `messages` for its identity and for the push (§12.5). Its bodies `B2`
    and `B3` are named as `computed` bodies, where by the promotion
    criterion the `computed` is promoted and the body is the authored
    function it calls. *Assumed:* the example's labels are unaffected,
    since every label in it is empty in the deployed configuration.
14. **A cell that holds no value** (to `language-subset.md` and the
    prototype). The corpus tests whether a link has resolved by comparing
    `cell.get()` with `undefined`, on cells whose declared value type
    admits no `undefined` (`resolvedProfile` in FabriChat, §12.2). Under
    `plan-and-label-templates.md` §5.2 such a read fails its cone instead
    of returning `undefined`. *Assumed:* the type has to say so,
    `Cell<Profile | undefined>`, and the analysis then records `shape`.
    The prototype has to measure how many cells the idiom is used on.
