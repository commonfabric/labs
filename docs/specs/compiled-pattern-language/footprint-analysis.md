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

Two more documents use what the analysis produces.
`execution-and-storage.md` owns how the runtime builds a body's argument from
the record and what a handle returns to a body.
`scheduler-and-serving-loop.md` owns what the scheduler does with the read
and write sets. Where this document needs a fact that belongs to another
document, it states the assumption it made and lists it under
[Open questions](#13-open-questions).

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
  may hold several such hops. The arrow is this document's notation for the
  place where a path crosses a handle's link. The plan has no segment for
  it: the slot's path is the handle's path followed by `q`, and the runtime
  crosses the link when it resolves the path
  (`plan-and-label-templates.md` §2.5). The notation keeps apart two
  observations: one at the position that holds the handle, written `h`, and
  one at the root of the cell it links to, written `h->`. In the plan both
  have the path of `h`. An `identity` slot, and a `shape` slot with
  `inPlace`, observe the position. A slot of any other form observes the
  cell the link leads to.
- The **classes** are the five observation classes of
  `plan-and-label-templates.md` §2: `value`, `shape`, `enumeration`,
  `identity`, and `labelMetadata`.
- A **scalar** type is a primitive type, a literal type, or a union of those.
  A **container** type is an object, array, or tuple type. A **handle** type
  is one of the cell types of `language-subset.md` §7.2, `Stream` included.
  A **reference** type is `unknown` in a data type, which declares a
  reference to another piece that is not read (`language-subset.md` §7.1).
  A **factory** type is the type of a pattern factory value or of a handler
  factory value. It is a data type (`language-subset.md` §1, §7.2), and a
  position of that type is a kind of its own, which is none of the other
  four. It takes the rules of a position of reference type
  ([§2.2](#22-observations)).

## 1. Scope and inputs

### 1.1 What the analysis computes

The analysis takes one function body and fills in the fields of its `Body`
record (`plan-and-label-templates.md` §1.1).

| Field | What the analysis supplies | Section |
| --- | --- | --- |
| `reads` | The static entries of the footprint on inputs that are slots: input paths, each with a class | 2, 3, 5 |
| `computed` | The static entries on inputs that are values the instance computed | 1.1 |
| `handles` | The handles the body reads through in ways no static entry covers, each with its read envelope | 7 |
| `writes` | The static targets the body writes, and the template of each written value | 6 |
| `envelopes` | Where the body's writes that have no static target may land | 6.2 |
| `outputs` | The result paths that hold a reference the body was given | 3.8 |
| `calls` | The sites of the runtime calls the body makes | 8 |
| `widenings` | Where the analysis gave up, and what each widening covers | 5 |

A footprint entry is a triple of a formal input, a path, and a class. The
analysis works on the body alone and does not look at where the body is
called or bound, so its result is the same for every use of the body.

Where the body is used, each formal input is bound to one of two things. An
input bound to a slot root, such as the event, the state of a binding, the
argument, or an element, gives entries of `Body.reads`: each entry is a slot
at the entry's path. An input bound to a value the instance computed, the
result of another body or of expression code, gives entries of
`Body.computed`: each holds the entry's path and class and the template of
the producing expression at that path
(`plan-and-label-templates.md` §3.9, "Computed inputs"). The runtime narrows
both kinds of input to the entries.

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
| A `lift(...)` definition called from another body | Its parameter | An ordinary call with no reactivity (`builtin-inventory.md`, "What a function body may call"). The lifted function's summary is applied, as for an authored function |
| A function of an imported TypeScript module | Its parameters | Not analyzed. See below |

Three kinds of function are not bodies. The callback of a reactive
collection method in the reactive tier is compiled against an element slot
and has label rules of its own. A callback passed to a standard-library method
inside a body is part of that body. A pattern callback is the reactive tier.

**Imported TypeScript.** The compiler reads the signature of an imported
function and nothing else (`language-subset.md` §5.5). Its record has kind
`imported` and is fixed by the signature:

- `reads` and `computed` hold one entry per parameter between them, of class
  `value` at the parameter's root, so every argument is read in full. Where
  a parameter's type has a position of reference type or of factory type,
  the `identity` entry that accompanies a `value` entry is there too
  ([§2.2](#22-observations));
- `handles`, `writes`, `envelopes`, and `calls` are empty, because a
  parameter of such a function is a data type, and a module of that tier
  cannot call a builder or a built-in;
- `outputs` is empty, so every result path is computed from every argument.

A body in the subset that passes one of its inputs to an imported function
reads that input in full. That is the widening cause W3 of
[§5.2](#52-the-causes).

### 1.3 What it takes as given

- **The record.** `Body`, `ComputedInput`, `HandleReads`, `BodyOutput`,
  `BodyCall`, `Widening`, `WriteEdge`, `WriteEnvelope`, and `DynamicReads`
  are as `plan-and-label-templates.md` §1.1 declares them.
- **The grammar.** A body contains the statements and expressions of
  `language-subset.md` §5.1 and nothing else. In particular it has no
  classes, no `this`, no `async` code, no generators, no `for...in`, no
  dynamic code, and no write to module scope or to a global.
- **Types.** The analysis runs after the subset type checker. Every
  expression has a concrete type, since the checker has no deferred types and
  refuses `any` (`language-subset.md` §7.3, §7.8). A generic function is
  analyzed once per instantiation, as it is checked. The analysis uses types
  for four decisions: whether a position is a scalar, a container, a handle,
  a reference, or a factory; whether an object type is closed or has an index
  signature; whether a type admits `null` or `undefined`; and which
  declaration a call resolves to.
- **Statelessness.** No function of the program holds mutable state between
  calls (`language-subset.md` §3.3). A closure created in a body dies with
  the call, so everything a body can reach is its formal inputs, module-scope
  constants, and what it creates.
- **Schema conformance.** At every path the runtime materializes, a body
  never receives a value outside the type of its input
  (`plan-and-label-templates.md` §5.2).

### 1.4 Requirements on the result

1. **Sound.** Every path the body can observe at run time, in each class, is
   in the footprint ([§9](#9-soundness)).
2. **Never wider than today, on a run that returns normally.** For every
   body, and every run of it that returns normally, what the footprint puts
   into the body's label is a subset of what the body's transaction reads
   today. This is the ruling that template labels are equal to or tighter
   than today's, applied to this analysis. It has two consequences that
   shape the design: the analysis is at least as precise as the capability
   analysis the transformer runs today
   ([§10](#10-relation-to-the-current-system)), and a read through a cell
   handle that some run that returns normally does not make is not turned
   into a static entry ([§7.2](#72-static-and-dynamic-reads)).

   A run that throws is outside the requirement. That is the second of the
   two deliberate exceptions to the ruling
   (`plan-and-label-templates.md` §3.1). A failed body's error state, and a
   failed handler's outcome, are labeled with the body's template over the
   whole footprint (`plan-and-label-templates.md` §5.2). So a failed run
   carries every static entry, including a static read through a handle
   that the run did not reach, where today its transaction carries only the
   reads made before the throw. For an entry on a data-typed input the two
   are the same, since today the argument is materialized before the body
   runs.
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

An observation at or below a hop is a static entry of the footprint only
where the read that makes the hop is static
([§7.2](#72-static-and-dynamic-reads)). Where that read is dynamic, the
observation is part of the read envelope of the entry of `Body.handles`
the hop goes through ([§7.3](#73-a-dynamic-read-is-still-narrowed)), and
the footprint has no static entry at the position. A handle or a container
at such a position is one the body **found** by reading through another
handle. No record can name an `identity` entry for it, because it has
none. [§3.8](#38-what-leaves-the-body), [§6.2](#62-targets), and
[§8.5](#85-binding-a-handler) say what the record holds for a found handle
or container that the body passes on, writes through, or binds.

### 2.2 Observations

An observation is a projection and a class. The body's footprint is the set
of observations the analysis records. The class an operation needs depends on
the static type of the position it is applied to.

| What the operation does | Scalar | Container | Handle | Reference or factory |
| --- | --- | --- | --- | --- |
| Consumes the content: arithmetic, a string method, comparison with a value | `value` | `value` over the subtree, which is a widening ([§5](#5-giving-up-and-widening)) | Not typed | Not typed |
| Converts to a string: a template literal, `String()`, `JSON.stringify`, an argument of `console` | `value` | `value` over the subtree, which is a widening | Not typed | `identity` |
| Tests presence or kind: `=== undefined`, `?.`, `??`, `typeof`, `in`, `Array.isArray` | `shape` | `shape` | `shape` | `shape` |
| Tests truthiness | `value` | `shape` | `shape` | `shape` |
| Asks for the length, the key set, or iterates | `value` (a string) | `enumeration` | Not typed | Not typed |
| Passes the value on unchanged to a place that keeps it by reference ([§3.8](#38-what-leaves-the-body)) | `value` | `identity` | `identity` | `identity` |
| Compares references: `equals`, `===` between two containers or handles | Not applicable | `identity` | `identity` | `identity` |

A position whose type is a union takes the row of each member, so a test of
truthiness on `string | Donut` records `value` and `shape`.

**A reference.** A position typed `unknown` holds a reference that the body
can test for presence, compare, and pass on, and whose target it cannot
read. A test of truthiness there is a test of presence, whatever is stored
behind the reference
([`unknown`](../../common/concepts/types-and-schemas/unknown.md)). The
checker allows nothing that consumes content without a narrowing. A
conversion to a string is typed, and what it converts is the reference, so
it records `identity`. A position the checker narrowed from `unknown` is used
under the narrowed type and takes that type's column at the same path
([§13](#13-open-questions), request 17).

**A factory.** A position of factory type holds a pattern factory value or
a handler factory value, which is a reference to a compiled definition
(`language-subset.md` §1). A body can test it for presence, compare it,
pass it on, and call it, and it has no content to consume. The position
takes the column of a reference: `shape` for a test of presence or of
truthiness, and `identity` where the body passes the value on, compares
it, or converts it to a string. Calling it records `identity` too: an
instantiation ([§8.1](#81-instantiating-a-pattern)) or a binding
([§8.5](#85-binding-a-handler)) depends on which factory the position
holds. That is the class the plan gives the slot that holds a factory
(`plan-and-label-templates.md` §3.15, §3.21). Wherever a rule of this
document names a position of reference type, it applies to a position of
factory type in the same way.

Three rules apply to every observation.

- **Navigation observes nothing.** `donut.glaze` extends a path. It records
  no observation of `donut`, by the rule `plan-and-label-templates.md` §2.1
  quotes from the specification.
- **A test the type decides needs no entry of its own.** The outcome of
  `typeof name` where `name` has type `string`, and of `donut?.glaze` where
  `donut` cannot be `null` or `undefined`, is fixed by the type, provided
  the tested path is in the body's argument: a body never receives a value
  outside its input's type at a path the runtime materialized (§1.3). The
  runtime materializes a path when the footprint has an entry at or below
  it, other than a `labelMetadata` entry. So such a test records nothing
  when the body's footprint has another such entry at or below the tested
  path. When it has none, the test records `shape` at the tested path.
  Without that entry the narrowed argument would lack the path, and the
  test would come out the other way.
- **`value` stops at a handle, and an `identity` entry takes over there.**
  A `value` observation at a container covers its subtree down to, and not
  through, each position of handle type, of reference type, or of factory
  type that the subtree's type has. At each such position the analysis
  emits an `identity` entry of its own, with `*` in its path where the
  position is under an array or a record. So a `value` entry over a subtree
  is accompanied by one `identity` entry per such position. The `value`
  entry does not consume the pointer label of the reference stored at the
  position, and does not have the runtime hand the body a handle there: an
  `identity` slot does the first, and a position the record names for
  `identity` is what the runtime hands a handle for
  (`plan-and-label-templates.md` §2.2 and §3.9, "Handles"). What a handle
  links to is read only through an explicit hop ([§7](#7-cell-handles)).

  The positions are read from the type. Where the subtree's type is
  recursive, they are the positions down to where a recursive type is
  entered a second time below the entry's path, which is the cut W6 makes
  on a path ([§5.2](#52-the-causes)). *Assumed:* a position of handle,
  reference, or factory type below that cut has no entry, the argument
  holds nothing there, and the body finds it absent. A path has no form
  for "at any depth", so the analysis cannot name such a position
  ([§13](#13-open-questions), request 22).

### 2.3 The footprint is one set per body

The analysis keeps one footprint for the whole body, and an observation made
on any path through the body is in it. There is no footprint per branch,
because the runtime builds the body's argument before the body runs and
cannot know which branch will be taken.

The set is kept in a normal form:

- a `value` entry at `p` removes every `value`, `shape`, and `enumeration`
  entry at or below `p` in the same cell. It removes no `identity` entry
  and no `labelMetadata` entry: each of those names a stored label that a
  `value` read does not consume (`plan-and-label-templates.md` §2.2, §2.4).
  The `identity` entries that accompany a `value` entry (§2.2) stay with
  it, one per position of handle, reference, or factory type in its
  subtree;
- a `shape` entry that only a test the type decides recorded (§2.2) is
  removed when another entry, other than a `labelMetadata` entry, is at or
  below its path;
- entries that differ only in the alternative they came from are one entry;
- an entry is marked as sampled when every read that records it is made
  with `sample()` ([§7.5](#75-link-hops-through-data)).

The environment that maps each local name to an abstract value is tracked
along control flow ([§3.7](#37-control-flow)). The footprint is not.

## 3. Transfer rules

Each rule states the abstract value of an expression and the observations it
records. Where an operand is a set of alternatives, the rule applies to each.
Where it is `Computed`, `Created`, or a closure, the rule records nothing.

One rule applies throughout, and the tables state it only where it is easy
to miss. **A key, an index, and a scalar argument are consumed.** A scalar
projection that is used as a key or an index, in an element access, a
destructuring, an `in` test, `at`, `key`, or `elementById`, or that is
passed as an argument to a member of the standard-library surface, records
`value`, like an operand of an operator. Which child is read, and what a
member returns, depend on it.

### 3.1 Access

| Construct | Result | Observations |
| --- | --- | --- |
| `v.k`, and `v[k]` where `k` is static in the sense of `language-subset.md` §4.3 | The projection extended by `k` | None |
| `v?.k` | The same | `shape` at `v` |
| `v[i]`, `v.at(i)` where `v` has an array type | The projection `v/*` | `enumeration` at `v`; `value` at `i` |
| `v[i]` where `v` has a tuple type and `i` is not static | The projection `v/*` | `value` at `i` |
| `v[k]` where `v` has an object or record type and `k` is not static | The projection `v/*` | `enumeration` at `v`; `value` at `k`. Widening W1 |
| `text[i]` where `text` is a string | `Computed` | `value` at `text` and at `i` |
| `const { a, b: c } = v` | `a` and `c` are the projections `v.a` and `v.b` | None |
| A default in a destructuring, `{ a = d }` | `v.a`, or the value of `d` | `shape` at `v.a` |
| `const { a, ...rest } = v` where the type of `v` is closed | `rest` is a record of the projections of the remaining declared properties | None |
| `const [first, second] = v` | `v/0` and `v/1` for a tuple; `v/*` for an array | `enumeration` at an array |
| `const [first, ...others] = v` | `others` is a bag of `v/*` | `enumeration` at `v` |
| A rest element where the type of `v` has an index signature | `rest` is a bag of `v/*` | `enumeration` at `v` |
| A destructuring under a computed key | The projection `v/*` | `enumeration` at `v`; `value` at the key. Widening W1 |
| `h.get()`, `h.sample()`, `h.key(k)`, and the other handle methods | [§7.1](#71-what-a-body-may-do-with-a-handle) | |

An index into an array is not a widening. The analysis does not track which
element an index names, so `rows[i].price` is `rows/*/price`: the body may
read the `price` of any row. That is the path iteration over the array
produces too, so indexing loses nothing against `for...of`. The index is
consumed: in `rows[event.position].price` the body reads `event.position`
for its value, since which row it reads depends on it.

An entry whose path holds `*` is one entry of the footprint and one slot
of the plan. The runtime binds such a slot at one address per child the
path reaches, each with its own chain of links
(`plan-and-label-templates.md` §2.5).

### 3.2 Tests and operators

| Construct | Observations |
| --- | --- |
| `v === w`, `v !== w`, `==`, `!=` | For a scalar operand, `value`. Against a literal `undefined` or `null`, `shape`. Between two containers, handles, or references, `identity` at each |
| `typeof v`, `v instanceof C`, `Array.isArray(v)` | `shape` |
| `v ?? w` | `shape` at `v`. The result is the alternatives `{v, w}` |
| `v && w`, `v \|\| w`, `!v`, `Boolean(v)`, and the condition of `if`, `while`, `for`, `do`, and `?:` | Truthiness of `v` by the table of §2.2. The result of `&&` and `\|\|` is the alternatives `{v, w}`; of `c ? a : b`, `{a, b}` |
| `"k" in v`, `Object.hasOwn(v, "k")` | `shape` at `v.k` |
| `k in v`, `Object.hasOwn(v, k)` with a key that is not static | `enumeration` at `v`; `value` at `k` |
| Arithmetic, relational, and bitwise operators, unary `+` and `-`, `+` on strings | `value` at each scalar operand. A container operand is converted, which is widening W2 |
| `switch (v)` | As `v === c` for each case |
| Assignment to a local, the comma operator, `void` | None. An assignment updates the environment (§3.5) |

The equality functions of the runtime record `identity` at each operand.
`equals`, in its three forms (`equals(a, b)`, `a.equals(b)`, and
`X.equals(a, b)`), compares the two references after resolving the links
both hold, and [§8.4](#84-reading-context) says when its `identity` entry is
a resolved one. `equalLinks`, as a method and in its static form, compares
the references as they are stored (`equals` and `equalLinks` in
`runtime/runner/src/cell.ts`), so its entry is never a resolved one.

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

Every member `language-subset.md` §9 lists has a rule: a row below, or one
of three defaults.

- A member that takes and returns only scalars follows the first paragraph
  below.
- A callback of a listed member that has no row of its own is bound as the
  callback of `map` is: its element parameter is the receiver's member and
  its other parameters are `Computed`.
- A constructor or a static function that takes an iterable observes it as
  `Array.from` does: `enumeration`, and a bag of the members.

The rules for a receiver or argument that is a projection `v`:

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
| `map`, `flatMap`, `forEach`, `Array.from(v, fn)` | `enumeration`. The callback's element parameter is `v/*`, its index parameter is `Computed`, and its array parameter is `v` | A bag of what the callback returns; `Computed` for `forEach` |
| `filter`, `find`, `findLast` | The same | A bag of `v/*`; for the two lookups, `v/*` |
| `some`, `every`, `findIndex`, `findLastIndex` | The same | `Computed` |
| `reduce`, `reduceRight` | `enumeration`. The element parameter is `v/*`. The accumulator parameter is the join of the initial value and what the callback returns | That join |
| `toSorted(compare)`, and `sort(compare)` on a local copy | `enumeration`. Both parameters of `compare` are `v/*` | A bag of `v/*` |
| `toSorted()` and `sort()` with no argument | `enumeration`, and `value` at `v/*`, since elements are compared as strings. Widening W2 when the element type is a container | A bag of `v/*` |
| `slice`, `concat`, `toReversed`, `toSpliced`, `with`, `values`, `entries`, `keys` | `enumeration` | A bag of `v/*`, joined with the other operands |
| `flat()`, `flat(depth)` | `enumeration` at `v` and at each nested array the call opens: at `v/*` for a depth of one, and one level further for each further level of a literal depth. A depth that is not a literal opens every array level of the element type | A bag of the members at the levels opened, joined with the members at each level that are not arrays |
| `Array.of(…)`, `new Array(n)` | None | A list of the arguments; an empty list |
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
| `Object.create(null)` | None | An empty record |

**`JSON`.** `JSON.stringify(v)` records `value` at `v` and is widening W2,
with or without an indent or a replacer. The parameters of a replacer
function are `Computed`: what it is called with was read by the conversion.
`JSON.parse` returns `Computed`.

**`Map` and `Set`.** A `Set` created in a body is a bag. A `Map` is two
bags, one of its keys and one of its values.

- `add` and `set` put a value in.
- `get`, `values`, and the value parameter of `forEach` return the member
  of the value bag. `keys` and the key parameter of `forEach` return the
  member of the key bag. `entries` and iteration return pairs of the two,
  and for a `Set` its member.
- `size` is `Computed`. `delete` and `clear` remove nothing from a bag
  (§3.5).
- Every operation that looks a key up or adds one compares keys. `has`,
  `get`, `delete`, `set`, and `add` record `value` at a scalar key and
  `identity` at a container, handle, or reference key.
- `new Set(v)` and `new Map(v)` over a projection record `enumeration` at
  `v` and put its members in: `v/*` for a `Set`, and `v/*/0` and `v/*/1` for
  the keys and the values of a `Map`. The keys are compared as `add` and
  `set` compare them.

The same applies to the frozen `ReadonlyMap` and `ReadonlySet` of module
scope, whose content is constant.

**`console`.** Each argument is written to a log, so each is observed as a
conversion: `value` at a scalar, and widening W2 at a container. Whether a
log is a place labeled data may go at all is not a question for this
analysis ([§13](#13-open-questions), request 11).

**The pure API functions.** `builtin-inventory.md` keeps a set of exports
that create nothing and read no context ("Pure functions and constants",
and `uiVariant` under "Tool and factory helpers"). They are not members of
the standard-library surface. The inventory's table there says what each
observes of its operands, and `language-subset.md` §4.4.4 says in which
tier each may be called. Two rules cover them. Every function but
`getEntityId` consumes its operands: `value` at a scalar, and `value` over
the whole subtree at a container, with the `identity` entry that
accompanies a `value` entry at each position of handle, reference, or
factory type inside it (§2.2). No link is followed there. `getEntityId`,
and `uiVariant` for its first operand, observe the operand for `identity`
and read nothing below it. A call of one in a body, with a projection `v`
as an operand, records the following.

| Call | Observations | Result |
| --- | --- | --- |
| `valueEqual(a, b)` | The content of each operand: `value` at a scalar, and `value` over the subtree at a container, which is widening W2. The comparison follows no link (`valueEqual` in `base/data-model/src/comparison/valueEqual.ts`). At an operand, or a position inside one, of handle, reference, or factory type it compares the references: `identity` there, which for a position inside a container is the entry that accompanies the `value` entry (§2.2) | `Computed` |
| `getEntityId(v)` | `value` at a string. `identity` at a handle, a reference, or a container: the result is the identifier of the document the reference at the position names, as stored. No link below it is followed and no content is read (`getEntityId` in `runtime/runner/src/create-ref.ts`) | `Computed` |
| `entityRefToString(v)`, `renderCellReference(v, context)`, `isWellFormedDID(v)`, `parseDID(v)` | Each operand is consumed: `value` at a scalar, and `value` over the subtree at a container, which is widening W2. `identity` at a position of reference type | `Computed` |
| `toCompactDebugString(v, options)`, `toIndentedDebugString(v, options)`, a `debugStr` template | A conversion to a string, as a template literal converts (§3.3): `value` at a scalar, widening W2 at a container, `identity` at a reference | `Computed` |
| `uiVariant(piece, kind)` | `identity` at `piece`, and `value` at a scalar `kind`. The call builds the JSX element `cf-render` with `piece` and `kind` as its properties (`uiVariant` in `runtime/runner/src/builder/built-in.ts`), so `piece` is passed on unchanged to a place that keeps it by reference ([§3.8](#38-what-leaves-the-body)) | The record JSX gives (§3.3) |
| Any other export of that list that takes an operand | Each operand is consumed, as in the third row | `Computed` |

The inventory states the rule of `getEntityId` for a handle and a
reference. *Assumed,* for a container operand: the function returns
the identifier of the stored address the value carries
([§3.8](#38-what-leaves-the-body)), and `undefined` for a container the
body computed. Today it returns an identifier for a cell, for a value that
stands for a cell, and for a link, and `undefined` for any other object
(`parseLink` in `runtime/runner/src/link-utils.ts`), so it reads no content
of a record ([§13](#13-open-questions), request 21).

The API functions that read context are in
[§8.4](#84-reading-context), and `equals` and `equalLinks` in §3.2. A
`sqliteDatabase` declaration is legal in the reactive tier only
(`builtin-inventory.md`, "`sqliteDatabase`"), so no body makes one and the
analysis has no rule for it.

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
instantiation when it is generic. The function a `lift(...)` definition
wraps has a summary too, which is applied where another body calls the
definition (§1.2). A summary holds, in terms of the function's parameters:

- the observations it records;
- its writes and its runtime calls;
- the abstract value it returns: a projection of a parameter, alternatives,
  a record or bag built from them, a created value, or `Computed`;
- its widenings, each with the source position inside the function;
- for each read through a handle, each resolution, and each observation of
  label metadata, whether it is unconditional in the function
  ([§3.7](#37-control-flow)).

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

One property is decided on the graph and used in
[§7.1](#71-what-a-body-may-do-with-a-handle),
[§7.2](#72-static-and-dynamic-reads), and [§8.4](#84-reading-context). A
program point is **unconditional** when every execution of the body that
returns normally passes through it. The analysis decides it by syntax, with
a test that can take an unconditional point for a conditional one and never
the reverse. A point is taken as unconditional unless it is:

- in a branch of `if`, `switch`, `?:`, `&&`, `||`, or `??`;
- in the body of a `while`, `for`, or `for...of` loop;
- in a `try` block that has a `catch` clause, or in a `catch` clause;
- after a statement that can `return` on some path;
- in a closure, other than an immediately invoked one.

A `throw` does not make what follows it conditional, since an execution that
throws does not return normally. The property is defined over runs that
return normally because that is the ruling: a read through a handle is
static when every run that returns normally makes it, and a run that throws
before the read carries its label all the same (§1.4, requirement 2). A
point inside an authored function is unconditional for a caller when it is
unconditional in the function and the call is unconditional in the caller.

### 3.8 What leaves the body

A value leaves a body when the body returns it, writes it through a handle,
passes it as the argument of a pattern instantiation or of an effect
request, or puts it into JSX. These destinations keep a container or a
handle **by reference**: what is stored is a link to where the value was
read, and whatever reads it later does so under a schema of its own.

| What arrives at such a destination | Recorded |
| --- | --- |
| A projection of scalar type | `value` |
| A projection of container, handle, reference, or factory type, whole | `identity`. The content is not read |
| A record or list the body built | Nothing for the value itself. Each member is treated by this table |
| A bag | The member, by this table |
| `Computed`, `Created` | Nothing |

The state a handler is bound to is one more such destination, and so are
the private parameters of an inline pattern the body instantiates. A
handle, and a container the body passes on unchanged, arrive there by
reference: the body records `identity`, and the binding or the instance
holds a link. A scalar is copied, and so is a container the body computed,
whose members are treated by the table above (`Binding.state` and
`Closure.params` in `plan-and-label-templates.md` §1.1). A copy holds what
the bound handler, or the inline pattern, observes of it and no more, so
for a scalar that is copied the body records the class the handler's
footprint has at the path, and nothing where it has none.
[§8.5](#85-binding-a-handler) gives the rule for a binding, and
[§8.1](#81-instantiating-a-pattern) for an inline pattern.

One kind of call consumes what it is given and keeps nothing by reference:
the options of an `inSpace` request
([§8.1](#81-instantiating-a-pattern)).

The reference rule is the reason a body that moves a record from one list to
another does not read the record. It rests on how the runtime stores a value
that was read from an input and passed on unchanged. Today such a value
carries the address it was read from (`annotateWithBackToCellSymbols` in
`runtime/runner/src/schema.ts`), and a write of it stores a link. This
document assumes that stays ([§13](#13-open-questions), question 2).

**An effect request.** A request keeps the reference rule, although the
effect serializes what the request holds. The content behind a reference of
a request is read by the transaction that checks the egress ceiling: it
follows the references the request holds, as far as the built-in
serializes, and checks the ceiling on the join of the request's templates
and what those reads consume (`plan-and-label-templates.md` §3.14). Those
reads belong to the check and not to the body. They are in no entry of the
footprint and do not join the body's template, so the label of the content
reaches the ceiling and the effect's result, and does not reach what else
the handler writes.

**`Body.outputs`.** For each path of the body's result, the analysis looks
at the abstract value the joined return value has there:

- one projection of container, handle, reference, or factory type whose
  path has no `*` segment gives `reference: { passes }`, naming that
  projection's `identity` entry;
- one such projection whose path has a `*` segment gives
  `reference: { oneOf }`, naming that one entry. The entry stands for
  every reference those positions hold, and which of them is at the result
  path is a choice the body made: by a predicate, by an index, or by the
  order of a loop. `passes` would leave that choice out of every label. An
  element the body picked out of a list with `filter`, `find`, or
  `rows[i]`, and an element a `map` callback returns unchanged, are this
  case;
- alternatives that are all such projections give `reference: { oneOf }`,
  naming the entry of each;
- a projection the body found below a hop whose read is dynamic
  ([§2.1](#21-abstract-values)) gives no entry. It has no `identity` entry
  to name, and the path takes the body's template, which holds the
  journaled read that found the reference;
- anything else gives no entry, and the path is computed.

`passes` names an entry whose path has no `*`, and an entry whose path has
one is named in `oneOf`, alone or with others
(`BodyOutput.reference` in `plan-and-label-templates.md` §1.1). The label
of a path recorded as `oneOf` is the label of the reference actually
returned, joined with the body's template as the label of the choice
(`plan-and-label-templates.md` §3.9).

Each form names an `identity` entry by where the entry is in the body's
record (`GivenReference` in `plan-and-label-templates.md` §1.1). An entry
on an input bound to a slot root is a slot of `Body.reads`, and its name is
the slot's index. An entry on an input bound to a value the instance
computed is an entry of `Body.computed`, and its name is `{ computed }`
with the entry's index there ([§1.1](#11-what-the-analysis-computes)). A
handle or a container that reached the body in a computed value is named
in the second way. The label of the path then has the entry's template in
the place of a slot, and the reference the runtime compares with is the
one it placed at the entry's position in the argument
(`plan-and-label-templates.md` §3.9, "A reference from a computed input").

A handle that a static `resolveAsCell()` returned names the resolved
`identity` entry, and the reference the runtime compares is the resolved
one ([§7.1](#71-what-a-body-may-do-with-a-handle)). A handle that a
journaled `resolveAsCell()` returned names the plain entry it started from.
Where the resolution followed a further link, the returned reference is not
the stored one, the comparison fails, and the path takes the body's
template. A resolution of a handle from a computed input is always
journaled ([§7.2](#72-static-and-dynamic-reads)), so the handle it returned
names the plain entry of `Body.computed`.

The runtime verifies both forms by reference identity
(`plan-and-label-templates.md` §3.9), so an error in this part of the
analysis costs precision and cannot produce a wrong label. `required` is
read from the result schema and not from the analysis. The same two forms,
with the same names and the same rules for a path with `*` and for a found
reference, apply to each path of a value the body writes
([§6.5](#65-the-label-of-a-written-value)), and to each path bound by
reference among the state paths of a binding
([§8.5](#85-binding-a-handler)) and the parameter paths of an inline
pattern ([§8.1](#81-instantiating-a-pattern)).

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

So a body's computed values have one template, which is the rule of
`plan-and-label-templates.md` §3.9 and the answer its open question 1
records. The reference rules of §3.8 are the only refinement, and the
runtime verifies them.

An author who wants a label per path has two ways to get one. A `computed`
whose body meets the promotion criterion is compiled in the reactive tier,
where every operation has a rule (`language-subset.md` §6). And two values
with different dependencies can be computed by two bodies.

### 4.2 The argument is per path

The same footprint is used a second way. The runtime builds the body's
argument from it, entry by entry, from `Body.reads` and `Body.computed`
alike, so the body receives `donut.basePrice` and not the rest of `donut`.
For this use the footprint is a tree of paths with a class at each, and its
precision is what keeps a body from being tainted by, or gaining access to,
data it never touches.

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
  subtree below it, with the `identity` entries that accompany a `value`
  entry (§2.2), and treats the value as `Computed` from there on.
- **On a key,** when it cannot tell which child of a record the key names.
  The analysis continues with `*` in place of the key, so that what the
  body goes on to read of the one child is recorded for every child.

Each widening adds one entry to `Body.widenings`, a `Widening` of
`plan-and-label-templates.md` §1.1.

- `slots` lists the entries of `Body.reads` that stand for more than the
  body reads. For a widening on a value it is the `value` entry at the
  projection, or one per alternative. The `identity` entries that
  accompany it are entries of the footprint like any other and are not
  listed. For a widening on a key it is the entries at `*` below the keyed
  container, with the container's `enumeration` entry.
- `computed` lists the entries of `Body.computed` that stand for more than
  the body reads, in the same two ways.
- `handle` names an entry of `Body.handles`, for a handle the analysis lost
  track of.
- `at` is the source position of the expression.

Which of the two lists a widened entry is in follows from what its formal
input is bound to where the body is used (§1.1): `slots` for an input bound
to a slot root, and `computed` for an input bound to a value the instance
computed.

A widening never reaches above the projection it applies to, never reaches
another formal input, and never passes through a handle: by §2.2 a `value`
entry stops at a position that holds a handle. A handle the analysis loses
track of (W4, W7) is not read in full. It becomes a handle the body reads
through dynamically ([§7.4](#74-where-a-handle-may-go)), which is what the
runtime records for it today. Its entry of `Body.handles` gets the handle's
whole declared type as its read envelope, and where the handle is writable
the body gets a write envelope over the handle's whole cell
([§6.2](#62-targets)).

### 5.2 The causes

This is the complete list. An operation that is not on it does not widen.

| | Cause | Widens to | Is the wider entry exact? |
| --- | --- | --- | --- |
| W1 | A key that is not static on an input of object or record type, in an element access or a destructuring | Every child of the keyed container, at the paths the body reads below the key, and the container's `enumeration` | No: one child is read |
| W2 | Conversion of a container to a string or a number, or a use of its whole content by a pure API function: `JSON.stringify`, a template literal, `String()`, `+`, `join`, a sort with no comparator, a relational or arithmetic operator, `throw`, an argument of `console`, an operand of `valueEqual` or of a debug formatter (§3.4) | The converted or compared value | Yes for `JSON.stringify` and for `valueEqual`; otherwise the operation reads less than the subtree |
| W3 | An argument of an imported TypeScript function | The argument | By the language rule: the function may read all of it |
| W4 | An argument of a call the analysis cannot resolve (§3.6) | The argument. For a handle, every read and write through it (§5.1) | No |
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
([§10](#10-relation-to-the-current-system)) treats several of them as if
they did:

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
the input paths of the widened entries or the handle the analysis lost, and
the rewrite.

| Cause | The message tells the author to |
| --- | --- |
| W1 | Read the named properties, or keep the record in a cell and read `cell.key(k).get()`, which reads the one child |
| W2 | Convert or compare the properties that are needed: `` `${donut.name}` `` in place of `` `${donut}` ``; pass `JSON.stringify` or `valueEqual` an object built from them |
| W3 | Pass the imported function the properties it needs |
| W4 | Call the function directly, or declare it at module scope |
| W5 | Copy first: `[...rows]`, `{ ...donut }` |
| W6 | Bound the depth of the walk, or keep the nodes in cells and read through handles |
| W7 | Split the body |

Two more hints of `language-subset.md` §10.3 report outcomes that are not
widenings: `footprint:dynamic-read`, for a read through a handle that stays
dynamic (§7.2), and `footprint:materializer`, for a computation whose write
makes it a materializer (§6.3).

### 5.4 Widening is sound

A widening replaces entries by entries that cover them. A `value` entry at
`p` covers the `value`, `shape`, and `enumeration` entries at every path at
or below `p` in the same cell. It does not cover an `identity` or a
`labelMetadata` entry, and by the normal form of §2.3 a widening removes
neither. A widening on a value adds the `identity` entries that accompany
its `value` entry (§2.2), so a reference inside the widened subtree is
observed after the widening as it was before. An entry at `p/*/q` covers
the same observation at `p/k/q` for
every key `k`. A widening on a handle replaces static entries below the hop
by reads the runtime journals, under an envelope that admits every path of
the handle's type. The footprint after a widening therefore covers every
observation the footprint before it covered, and the soundness statement of
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
| An effect request | The stored request of the effect | Each path of the request |
| A handler binding | The binding's state document | The state paths: a copy at a path that is copied, and a link at a path bound by reference. The `bind` site and its `Binding` record them, and no `WriteEdge` does ([§8.5](#85-binding-a-handler)) |
| `return` | The body's primary output | The result |

For each write the analysis records the abstract value of the handle written
through, the path below it, and the abstract value written. A write through
a handle that is a projection also records `identity` at the handle: which
cell is written depends on which reference the position holds, and the
write's target names that entry (§6.2). For a handle the body found below
a hop whose read is dynamic ([§2.1](#21-abstract-values)), that
observation is a journaled read of the reference at the position, and no
static entry.

### 6.2 Targets

A write target is classified by what the analysis knows of its address.

- **Static.** The handle is an anchored handle, or a set of alternatives
  that are all anchored, the path below it has only static segments, and
  every hop on the handle's own path is a static read by
  [§7.2](#72-static-and-dynamic-reads). The third condition is what gives
  the handle an `identity` entry for the target to name. A handle below a
  hop whose read is dynamic is one the body found by reading through
  another handle ([§2.1](#21-abstract-values)), and a write through it is
  dynamic (below). So `composer.get().editing.set(x)` has a static target
  where the `get()` is unconditional, and an envelope where it follows a
  statement that can `return`. The
  target is a `WriteEdge` whose target has the kind `handle`: it names the
  handle's `identity` entry and the path below the handle's cell
  (`plan-and-label-templates.md` §1.1, §3.11). A set of alternatives gives
  one edge per alternative. How the target names the entry depends on what
  the handle's formal input is bound to where the body is used (§1.1).
  - For an input bound to a slot root, the target names the handle's
    `identity` slot. The address that slot links to is bound when the
    instance is, like any slot.
  - For an input bound to a value the instance computed, the target names
    the handle's `identity` entry of `Body.computed`, in the `computed`
    variant of the `handle` target. The plan has no root and path for the
    cell. The runtime knows the cell once the cone that produces the value
    has been evaluated, which is before the body runs
    (`plan-and-label-templates.md` §3.11, "A handle from a computed
    input"). The target is static all the same
    ([§6.3](#63-computations-static-side-write-or-materializer)).
  - Where the body is used with a state cell of the instance as the
    handle, the target has the kind `state`. The initial value of a cell
    that a `lift` or a `computed` creates under a constant cause, or under
    the element key, has that kind too: the cell is a `StateCell` of the
    plan ([§8.2](#82-creating-a-cell)).
- **Dynamic.** The write goes to another cell, and which one depends on
  data the body read: the handle is an element of a list of handles, or a
  handle the body found by reading through another handle, below a hop
  whose read is dynamic, or a cell the body created under a cause computed
  from data ([§8.2](#82-creating-a-cell)).
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
**envelope**: the static prefix the write lies under. It is a
`WriteEnvelope` in `Body.envelopes`, in one of two forms
(`plan-and-label-templates.md` §1.1).

- **`handle`**: at or below a path of the cell a handle links to. The
  envelope names the handle's `identity` entry and a path. It names the
  entry as a static target does: by its slot, or, for a handle that reached
  the body in a value the instance computed, by its entry of
  `Body.computed`, in the `computed` variant of the `handle` envelope.
  - For a key that is not static below an anchored handle, the path is the
    path to the keyed container, `*` at the key, and the static segments
    written below it.
  - For an element of a list of handles, the envelope names the `identity`
    entry at `list/*`, which stands for every cell an element links to, and
    the path is the one written below the element.
  - For a handle the body found by reading through another handle, the slot
    is at the position where it was found. Its path crosses the first
    handle's link and has `*` at each segment the analysis cannot name.
    That slot is in no `Body.reads`: it names the place, nothing is
    materialized for it, and it joins no template
    (`plan-and-label-templates.md` §3.11).
  - For a handle the body found by reading through a handle that reached
    the body in a value the instance computed, no slot path leads to the
    position. The envelope names the first handle's `identity` entry of
    `Body.computed`, in the `computed` variant, and its `found` member
    holds the position where the handle was found: a path below the cell
    the first handle links to, with `*` at each segment the analysis
    cannot name. The runtime resolves `found` as it resolves the path of
    an `identity` slot, so it crosses the link of a handle found on the
    way and stops at its last segment. The envelope's `path` is at or
    below the cell the found handle links to, and is not a path from the
    first handle's cell. `found` is no entry of the footprint: nothing is
    materialized for it, and it joins no template
    (`plan-and-label-templates.md` §1.1 and §3.11).
  - For a handle the analysis lost track of, there is one envelope for each
    writable handle among the body's inputs, over the handle's whole cell.
- **`created`**: a cell that a `createCell` site creates under a cause
  computed from data. The envelope names the site.

`plan-and-label-templates.md` §3.11 says what each form gives the
scheduler. A `handle` envelope names addresses once its slot is bound, or,
where it names an entry of `Body.computed`, once the cone that produces the
value has been evaluated. Both happen before the body runs, so a reader
can be found inside the envelope ahead of it. A `created` envelope
names no address: it bounds what the body may write and gives nothing to
order by.

**A write through a resolved handle.** A write through `h` lands in the cell
`h` links to, and a link stored there as the value is not followed. A write
through `h.resolveAsCell()` lands in the cell where the resolution ends.
The two differ when the cell `h` links to holds a link (`resolveWriteTarget`
in `runtime/runner/src/cell.ts` documents the difference as it is today).
So the target of the first is a `handle` target that names the `identity`
slot of `h`, and the target of the second is a `handle` target with
`resolved`. The slot of the second is the `identity` slot the body has at
the position of `h`: the resolved one where the resolution is static, and
the plain one where the body journals it
([§7.1](#71-what-a-body-may-do-with-a-handle)). Either is the entry the
write records at the handle (§6.1). The flag says that the write lands
where the resolution ends, and the runtime resolves the reference when the
write is made (`plan-and-label-templates.md` §3.11). An envelope for a
write through a resolved handle has the flag in the same way. For a handle
from a computed input the resolution is journaled (§7.2), so the target or
the envelope names the plain entry of `Body.computed`, with the flag. On
an envelope that has `found`, the flag applies to the found handle.

### 6.3 Computations: static side-write or materializer

A `lift` or a `computed` that writes through a handle is a computation with
side-writes. The three tiers of
[Scheduler v2](../scheduler-v2/README.md) (§4.3) carry over, and the
analysis decides the tier.

| The body's writes | Tier | What the plan records |
| --- | --- | --- |
| Only its return value | Primary output | Nothing beyond the body |
| Side-writes whose targets are all static | Static side-write targets | One `WriteEdge` per target on the body. Each is one more output edge of the cone that runs the body. Where the target is a state cell or names its handle by a slot, the plan lists a `ConeEdge` from that cone to each cone with a slot that reads the target |
| At least one side-write whose target is dynamic or too broad | Materializer | An `Operation` of kind `materializer` implemented by the body. Its declared write envelope is the body's `writes` and `envelopes` |

The classification is per body. A body with one write that is not static is
a materializer for all of its writes, as a node with a declared envelope is
today. Envelopes come from the analysis and never from observed writes,
which is the rule Scheduler v2 states for them: "Membership and envelopes
are **declared**". The records are those of
`plan-and-label-templates.md` §3.11.

**A handle from a computed input.** A write edge that names its handle by
`computed` (§6.2) is a static target, and the write is a static side-write.
It does not make the body a materializer
(`plan-and-label-templates.md` §3.11, "A handle from a computed input").
The tier is decided on the body alone, and one body can be used with the
handle as a slot in one place and as a computed value in another, so the
tier does not depend on which of the two it is. Such a target has no root
and no path to compare with a slot, so the plan lists no `ConeEdge` for it.
The cones that read the cell are found at run time, from the address the
reference leads to and the addresses the slots are bound to.

A computation that creates a cell under a constant cause, or under the
element key, writes a static target. `plan-and-label-templates.md` §3.14
makes that cell a `StateCell` of the plan, and the write of its initial
value is a `WriteEdge` with target `state` ([§8.2](#82-creating-a-cell)).
So the plan lists a `ConeEdge` from the cone that runs the body to each
cone with a slot on the cell, as for any state cell.

A write through a handle that the body found below a hop whose read is
dynamic has an envelope and no edge (§6.2), so in a `lift` or a `computed`
it makes the body a materializer. `composer.get().editing.set(x)` after an
early `return` is the smallest case.

**What a materializer returns.** `return` is one of a body's writes (§6.1),
and a materializer is not part of the compiled evaluation of its instance
(`scheduler-and-serving-loop.md` §7.1). The value it returns is the result
of its `Operation`. The materializer's transaction stores it at the result
path of the operation's state document, and a cone that uses the value
reads it through a slot with root `operation`
(`plan-and-label-templates.md` §3.11).

**A binding does not make a materializer.** A `lift` or a `computed` that
binds a handler writes the binding's state document, under an identifier
derived from the captures, which can be data
([§8.5](#85-binding-a-handler)). That write is not a side-write with a
dynamic target, for two reasons. The identifier and the content of the
document are functions of the same captures, so an evaluation never writes
a different value into a document that exists. And no cone has a slot on
the document: its one reader is the bound handler, when an event arrives on
the stream. So there is no reader to order behind the write. A cell created
under a cause computed from data differs in both respects: the body writes
a value into it that is no part of its identifier, and any cone that holds
a link to it can read it.

**An instantiation does not make a materializer.** A `lift` or a
`computed` that instantiates a pattern writes the child's argument
document ([§8.1](#81-instantiating-a-pattern)), and a site in a loop makes
as many instances as the data has it make. Those writes are not side-writes
with a dynamic target either. Each target is named by the site and the
occurrence, and by no address the body read. And no cone of the enclosing
instance has a slot on an argument document: its readers are the child's
own cones, through their `argument` slots. So the tier of the body is
decided by its other writes. A body that also reads through the link an
instantiation returned reads the child's result, which depends on the
argument it writes. That read is dynamic (§8.1), and the plan has no edge
for the dependency it makes. `plan-and-label-templates.md` §3.14 ("In a
body that is re-evaluated") has the same rule from the side of the plan:
the write edges belong to the cone that runs the body, and they do not
make the body a materializer.

### 6.4 Handlers

A `handler`, an `action`, and an inline event handler have no tier. Each
runs once per event in the transaction of its cause, and the cones its
writes dirtied are known from the writes themselves.

Their record still lists every write. A static target is a `WriteEdge`. A
dynamic target, or one that is too broad, is listed by its envelope in
`Body.envelopes`. The runtime refuses a write that neither covers
(`plan-and-label-templates.md` §3.11, §7.3), so an error in this part of
the analysis fails closed. A handler is not a cone, so its edges are not
among `Plan.edges`: they say what the body may write and, through the
addresses they are bound to, which cones its writes make stale.

A write policy that names a handler is checked against the write edges:
`plan-and-label-templates.md` §4.4 checks at compile time that the body of
a static edge is one the target's policy names. For a dynamic target the
check runs when the write is made.

### 6.5 The label of a written value

Every value a body writes carries the body's template, by §4.1. The
reference rules of §3.8 apply to each path of the written value. A path
that holds one projection of container, handle, reference, or factory
type, whose path has no `*` segment, is a reference the body passed on,
and its template is that projection's `identity` entry: the slot, or, for
an entry of `Body.computed`, the entry's template. A path that holds one
such projection whose path has a `*` segment, or alternatives of such
projections, is a reference the body chose: its label is the label of the
entry the reference came from, joined with the body's template as the
label of the choice. A path that holds a reference the body found below a
hop whose read is dynamic ([§2.1](#21-abstract-values)) is neither. It has
the body's template, like a computed value.

The plan records a path of the first two kinds as a `WriteEdge` of its
own. Its target is the sub-path, and its `reference` member names the
entry, as `passes`, where the entry's path has no `*`, and otherwise the
entry or the entries the reference is one of, as `oneOf`. Each name is a
slot's index, or `{ computed }` for an entry of `Body.computed`, as §3.8
has it (`plan-and-label-templates.md` §1.1, §3.9). The runtime verifies
the reference by identity, and the edge's `template`, which is the body's,
applies where the check fails. The same holds for a path of a child's
argument and of an effect's request.

### 6.6 Idempotency

The idempotency contract of Scheduler v2 (§4.2) applies to every
computation that writes, in either tier: run again against unchanged
inputs, it produces the same writes. The idempotency validator checks it by
running the computation twice, and stays.

The analysis has the read set and the write set of a body side by side, and
reports three shapes. The first two break the contract whatever the data.
The third breaks it unless the write settles.

- **An append or an increment.** `push`, `pushAll`, and `increment` in a
  computation add to what is there, so a second run writes something else.
- **A send.** `stream.send(event)` in a computation delivers one event per
  run.
- **A read of its own target.** A computation that reads a path at or below
  one it writes, through the same anchored handle, computes its write from
  its own previous write. Whether a second run writes the same depends on
  the body. `count.set(count.get() + 1)` writes something else on every
  run. `name.set(name.get().trim())` normalizes the value it reads: once
  the value is trimmed it writes that value again, so it settles in two
  evaluations (`scheduler-and-serving-loop.md` §8.2). The analysis does not
  tell the two apart. It reports the shape, and the idempotency validator
  decides at run time.

The first two are properties of the operation. The third is also the
smallest cycle through a side-write: an edge from a cone to itself. It is
reported as `side-write:not-idempotent` and not as `side-write:cycle`
(`language-subset.md` §10.3). Two anchored handles can link to one
cell without the body's text showing it, so a body can read its own target
in a way this report does not see. That overlap is found at run time, from
the addresses the slots and the targets are bound to
(`plan-and-label-templates.md` §3.11).

The compiler's report of cycles is computed from `Plan.edges`, which hold an
edge for every static write of a cone, through a state cell or through a
handle that a slot names (`plan-and-label-templates.md` §3.11;
`scheduler-and-serving-loop.md` §8.2). The write edges of this analysis are
what those edges are built from. A write through a handle from a computed
input has no edge there (§6.3), so the report does not see it, and a cycle
through it ends at the bound on evaluations of a cone
(`plan-and-label-templates.md` §3.11, §5.2).

`language-subset.md` §10.3 has the reports: `side-write:not-idempotent`, a
warning, for the three shapes, and `side-write:cycle`, a warning, for a
cycle of the plan other than a body that reads its own target. The
ambient reads that also break the contract are
already refused in a computation (`function-body:ambient-read`).

## 7. Cell handles

### 7.1 What a body may do with a handle

The methods are those of `language-subset.md` §4.7. For a handle `h`:

| Method | Abstract result | Recorded |
| --- | --- | --- |
| `h.get()`, `h.sample()` | The projection `h->`, the root of the cell `h` links to | `identity` at `h`. What is done with the result is recorded below the hop |
| `h.key("k")` | The handle `h` with `k` added to the path below its hop | Nothing |
| `h.key(k)` with a key that is not static, `h.elementById(id)` | The handle at `*` below `h`. It is not anchored | `value` at a key that is a scalar projection (§3). A read through the handle is dynamic (§7.2), and a write through it is too broad to predict ([§6.2](#62-targets)) |
| `h.resolveAsCell()` | `h`, resolved: reads through it are reads at `h->`, and a write through it lands where the resolution ends ([§6.2](#62-targets)) | A resolution of `h` (below) |
| `h.for(cause)` | `h` | The cause, by the reference rule of [§3.8](#38-what-leaves-the-body) |
| `h.getArgumentCell()` | A handle that is not anchored | `identity` at `h` |
| `h.equals(o)` | `Computed` | A resolution of `h` and of `o`, as for `equals(h, o)` ([§8.4](#84-reading-context)) |
| `h.equalLinks(o)` | `Computed` | `identity` at `h` and at `o`, as stored |
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

**Resolutions.** A resolution follows the links below a reference to the
cell that holds its value. `resolveAsCell()` is one, and so are `equals`,
`spaceOf`, the principal reads, and the operand of an access-list read
([§8.4](#84-reading-context)). A resolution observes the reference at the
operand and the links below it, and reads no content. It is recorded in one
of two ways (`plan-and-label-templates.md` §2.5, §3.16).

- **Static**, when all three hold:
  1. the operand is one projection of handle, container, or reference type,
     not a set of alternatives;
  2. the operand's path has no `*` segment and no hop through a handle that
     is not anchored, and where it has a hop, the read that reaches the
     operand is static (§7.2);
  3. the call is unconditional (§3.7), with the relaxation §7.2 gives a
     call that is conditional only on the operand being present.

  The resolution then records a **resolved** `identity` entry at the
  operand: a slot with `resolved`, whose chain holds the links the
  resolution follows and whose label joins their pointer labels.
- **Journaled** otherwise. The resolution records a plain `identity` entry
  at the operand, at each alternative, or at the path with its `*`, and the
  links followed below that reference are a dynamic read of kind `link`
  through the entry. The read names the entry by its slot, or, for an entry
  of `Body.computed`, by the body and the entry's index there
  (`ComputedReference` in `plan-and-label-templates.md` §1.1). A
  resolution whose operand reached the body in a value the instance
  computed is journaled whatever the three conditions say (§7.2).

These are the three conditions of §7.2 with the operand in place of the
path of a read, and the reason is the same. Today the runtime records the
links a resolution follows when it follows them. A resolved entry for a
resolution that some run that returns normally skips, or that goes through
one of two operands, would put pointer labels on runs that did not consume
them.

A body can hold a plain and a resolved `identity` entry at one position.
The first is the reference as stored, which is what the body passes on when
it passes on `h`. The second is the reference `h.resolveAsCell()` returns.

### 7.2 Static and dynamic reads

A read at `h->q` is **static** when all three hold:

1. `h` is one anchored handle, not a set of alternatives;
2. `q` has no `*` segment and no further hop through a handle that is not
   anchored;
3. the `get()` or `sample()` is unconditional (§3.7): every run of the body
   that returns normally makes it.

A static read is an entry of `Body.reads` like any other. In the plan it is
a slot whose path is the handle's path followed by `q`, which crosses the
handle's link when the runtime resolves it
(`plan-and-label-templates.md` §2.5). Every other read through a handle is
**dynamic**: the handle is listed in `Body.handles` with its read envelope
(§7.3), the runtime journals what the body reads through it while it runs,
and the journaled reads enter the label as a `dynamic` template
(`plan-and-label-templates.md` §3.9).

The conditions are decided on the body alone. Where the body is used with
the handle's formal input bound to a value the instance computed, the plan
cannot name the path, and the read is dynamic there whatever the
conditions say: the handle's entry of `Body.handles` names its `identity`
entry of `Body.computed` (`plan-and-label-templates.md` §2.5, §3.10). A
resolution of such a handle is journaled for the same reason, and the
dynamic read of kind `link` names the same entry
(`plan-and-label-templates.md` §3.10, §3.16).

The entry of `Body.computed` is also what the record names for everything
else the body does with such a handle, in the place of a slot: a reference
the body passes on ([§3.8](#38-what-leaves-the-body)), the target or the
envelope of a write through it ([§6.2](#62-targets)), and a state path or a
parameter path it is bound to ([§8.5](#85-binding-a-handler),
[§8.1](#81-instantiating-a-pattern)). The same holds for a container the
body passes on unchanged from such an input.

`Body.handles` lists a handle only when some read through it is dynamic. A
handle the body passes on, writes through, or reads at static entries alone
is not listed. The runtime hands the body a handle for every position of
handle type the record names, listed or not
(`plan-and-label-templates.md` §3.9, "Handles").

One relaxation applies to condition 3. A read that is conditional only on
the handle being present, `profile?.get()` where `profile` may be
`undefined`, counts as unconditional. When the handle is absent there is
nothing at the entry's path to resolve, and the test of its presence is a
`shape` observation the footprint holds anyway.

That observation is at the position that holds the handle, `profile`, and
not at the root of the cell it links to, `profile->`. The plan has one path
for the two and tells them apart by a flag
(`plan-and-label-templates.md` §2.5). A `shape` slot with `inPlace` stops
at its last segment and observes whether the position holds anything, a
link included. A `shape` slot without the flag resolves through a link at
its last segment and observes the root of the cell the link leads to. The
analysis emits the first for a `shape` entry at a position of handle type
or of reference type, the two kinds of position at which
`plan-and-label-templates.md` §2.5 sets the flag, and the second for a
`shape` entry at `profile->`.

**Why the conditions.** They are the cases in which a static entry reads
exactly what the body's transaction reads today, on a run that returns
normally.

- Today a read through a cell is journaled when it happens. A body that
  reads `secret.get()` in one branch carries the label of `secret` only on
  the runs that take the branch. A static entry is in the label on every
  run. So a read that some run that returns normally skips is left dynamic,
  or the label would be wider than today on that run (§1.4, requirement 2).
- With alternatives, `(event.donut ?? state.donut).get()`, the body reads
  through one handle and a static entry would name both.
- With `*`, a body that looks up one element of a list of handles and reads
  it would get an entry for every element.

A read of a data-typed input is different: today the argument schema
materializes it before the body runs, on every run, so a static entry for a
conditional data read equals today's read.

**A run that throws.** Condition 3 is over the runs that return normally. A
run that throws before a static read did not make it, and today its
transaction does not carry the read's label. The body's template holds the
entry on every run, so the error state of the failed body, or the outcome
of the failed handler, carries the label of the entry all the same
(`plan-and-label-templates.md` §3.9, §5.2). This is ruled: it is the second
deliberate exception to "equal to or tighter than today"
(`plan-and-label-templates.md` §3.1). Without it, every read through a
handle that follows a statement that can throw would be dynamic, and a
handler checks its inputs and throws before it reads on.

**What a static read is for.** A body whose reads are all static has a
template with no `dynamic` node, so its label is a function of slot labels
and can be reused without running the body
(`plan-and-label-templates.md` §4.1). Its inputs are known before it runs,
which is what lets the cones a handler reads be evaluated first
(`plan-and-label-templates.md` §5.4), and what gives the order of
evaluation inside an instance.

### 7.3 A dynamic read is still narrowed

Whether a read happens can be dynamic while what it can read is static. For
each handle of `Body.handles` the analysis collects the **read envelope**:
the paths below the hop that any read through the handle may observe, each
with its class. The plan records it on the handle's entry, as
`HandleReads.envelope`: the schema every read through the handle is made
under, which admits those paths, each narrowed to its class, and nothing
else (`plan-and-label-templates.md` §1.1). The handle's `get()` and
`sample()` return the value narrowed to the envelope, so the journal holds
those reads and no others (`plan-and-label-templates.md` §3.9).

This is where the analysis is tighter than today for the handler of
[§12](#12-worked-example-a-fabrichat-handler). Today each handle in its
state keeps the schema it was declared with, and `message.get()` reads the
whole message. With the envelope it reads the paths the body goes on to
use.

The envelope bounds what a dynamic read can return. It does not make the
read known before the body runs: a read through a handle of `Body.handles`
returns what is stored or staged when it is made
(`plan-and-label-templates.md` §5.4).

**The envelope keeps the label annotations.** The envelope is narrowed
from the handle's declared type, and at each path it admits it keeps the
label annotations that type declares there, `requiredIntegrity` and
`maxConfidentiality` among them (`language-subset.md` §8.1). A dynamic
read has no slot, so a constraint that such an annotation yields has no
slot to list. It lists the entry of `Body.handles`, and the gate is
evaluated on the journaled reads the entry's envelope admits at the
annotated path (`ConstraintInputs` in `plan-and-label-templates.md` §1.1,
and §4.4 there). A requirement on a path the body reads only through a handle
is therefore checked on the runs that make the read, as it is today, where
it is checked against the reads of the transaction. A constraint on a path
of an entry of `Body.computed` lists that entry in the same way, and is
evaluated on the entry's template. The analysis supplies both: the
envelope with its annotations, and the entries a constraint can list.

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
  whole declared type as the envelope, the widening names the handle's
  entry (§5.1), and a writable handle makes the body's write surface too
  broad (§6.2).

### 7.5 Link hops through data

There are three ways a body reaches another cell.

- **A handle at a static path,** such as `state.composer`, or
  `state.composer->editing` where `editing` is declared as a cell. The hop
  is explicit and the handle is anchored. §7.2 decides whether a read
  through it is static.
- **A handle found at a computed place:** an element of a list of handles,
  a `key(k)` with a key that is not static, an `elementById`. The handle is
  not anchored, and every read through it is dynamic. Which entry of
  `Body.handles` stands for it depends on where the place is.
  - Below an anchored handle, under a key that is not static: the anchored
    handle's entry, whose envelope has `*` at the key.
  - At a static entry of the footprint with a `*`, such as an element of a
    list of handles the event carries: an entry that names that `identity`
    entry, and that stands for every handle the position holds.
  - At a place the body reaches only by a dynamic read through another
    handle: the found handle has no slot and no entry of its own. Its
    reads are journaled with the reads of the entry it was found through.
    That entry's envelope admits the position as a handle, and what it
    admits below the position is the envelope of the reads through the
    found handle (`plan-and-label-templates.md` §3.9, "Handles").
- **A link the type does not show.** A position declared with a data type
  can be stored as a link: a record that a handler wrote into a list is a
  document of its own, and the list holds a link to it
  (`builtin-inventory.md`, "Element keys"). The body sees a plain value and
  the analysis sees a path of the declared type. The footprint is the same
  whether storage holds the record inline or as a link. The runtime
  resolves an entry whose path crosses such a link as it resolves any slot
  path: resolution continues at the link's target, and the slot's label
  joins the pointer labels of the links crossed with the observation at the
  target (`plan-and-label-templates.md` §2.5).

A cell or an instance that the body created, and that no other run of the
body names, is not an input. Reading back what the body itself wrote
records nothing. That is the case in a `handler` or an `action` for a site
that is `identifiedBy: "order"`: the identifier derives from the event, so
nothing is behind the link but what this invocation put there.

A site whose occurrence another run names again is different. What is
behind the link or the cell it returns can be what an earlier run wrote,
or what another holder of the link wrote, and that is no input of the body
and has no static entry. There are three kinds of such site.

- An `instantiate` site in a `lift` or a `computed`. The instance outlives
  the evaluation that made it ([§8.1](#81-instantiating-a-pattern)).
- An `instantiate` site that is `identifiedBy: "tag"` in a `handler` or an
  `action`. A later event that gives the same tag names the same instance
  and creates nothing (`plan-and-label-templates.md` §1.3 and §3.14, where
  it is an assumption: question 19 of the continuation plan).
- A `createCell` site that is `identifiedBy: "cause"`, in a `handler` or
  an `action` as in a `lift` or a `computed`
  ([§8.2](#82-creating-a-cell)). A later run under the same cause names
  the same cell. For a handler that rests on the same assumption as the
  tag.

A read through the link or the cell such a site returns is dynamic, in a
handler as in a computation. The site is an entry of `Body.handles` whose
`handle` is `{ call }`, and its envelope admits what the body reads
through what the site returns (`HandleReads` in
`plan-and-label-templates.md` §1.1). The read is journaled and joins the
entry's `dynamic` node.

`sample()` has the footprint of `get()`. The difference is that the body is
not recomputed when the sampled cell changes, which is a property of the
dependency and not of the label. The plan records it on the slot
(`plan-and-label-templates.md` §2.5): a static entry that only reads made
with `sample()` record has the slot's `sampled` flag, and an entry that a
`get()` also records does not. A `sample()` through a handle of
`Body.handles` is journaled like a `get()` and joins the `dynamic` label,
and the runtime does not register it as a read that makes the cone stale.

## 8. Runtime calls in a body

A body may make five kinds of runtime call (`language-subset.md` §5.2;
`builtin-inventory.md`, "Calls inside function bodies"). Four of them
create something, and the analysis records their sites in `Body.calls`,
with the fields `BodyCall` declares. For all five it records what the call
observes of the body's inputs. A site inside a loop or a closure is one
site.

In each table, "by the reference rule" means the table of §3.8.

Where a section says a call is legal in a `handler` or an `action` only,
an authored function is held to the rules of the bodies that call it. An
authored function called from the reactive tier, and an `assert`, are held
to the rules of a `lift` (`language-subset.md` §5.2).

### 8.1 Instantiating a pattern

Legal in every body. A `lift` or a `computed` may instantiate a pattern as
a `handler` or an `action` may: a named pattern, an inline `pattern(...)`,
or a pattern factory value. The table applies to every kind of body, and
what is specific to a body that is evaluated again follows it.

| Part of the call | Recorded |
| --- | --- |
| The callee, when it is a factory value | `identity` at the position that holds it |
| The callee, when it is an inline `pattern(...)` written at the call | The `Child` of the site has a `Closure` as its callee, and each value the inline pattern captures from the body is a path of `Closure.params`. A path is bound as a state path of a handler binding is bound ([§8.5](#85-binding-a-handler)), with what the inline pattern's plan reads below its `params` root in place of the handler's footprint (`plan-and-label-templates.md` §3.15, "How much a copy holds"). A handle, and a container passed on unchanged, record `identity` and stay links. A scalar, and a container the body computed, are copied by the rows §8.5 has for each: the body records the class the inline pattern's plan has at the path, and nothing where it has none (below) |
| Each path of the argument | A `WriteEdge` with target `argument`, and the argument's members by the reference rule. A path that holds a passed reference is an edge with `reference` ([§6.5](#65-the-label-of-a-written-value)) |
| `.for(tag)` | The tag by the reference rule. The site is `identifiedBy: "tag"` |
| `asScope(scope)` | Nothing. The scope is a constant of the site (`Child.scope`) |
| `inSpace(space, options)` | The target, as one of the four kinds of `SpaceRequest`: `value` at an identifier or a name that is a scalar projection; for the space of a cell, what `spaceOf` of that cell records ([§8.4](#84-reading-context)); nothing for an anonymous space. Each of the options `grants`, `root`, `spaceKind`, and `selfOwned` that the site writes is consumed: a scalar records `value`, and a container records `value` over its subtree |
| The link returned | A created value. In a `handler` or an `action` the child is created when the transaction commits (`plan-and-label-templates.md` §3.14), so at a site that is `identifiedBy: "order"` a read through the link in the same invocation finds no value and records nothing. At a site that is `identifiedBy: "tag"` a later event names the instance an earlier one made, so a read through the link is dynamic ([§7.5](#75-link-hops-through-data)). In a `lift` or a `computed` a read through the link is dynamic (below). The body can store the link, pass it on, and give it to `navigateTo` or `spaceOf` |

The target and each option of an `inSpace` request is a `RequestValue` of
`plan-and-label-templates.md` §1.1: a constant of the site; the slot of the
one projection it is, which is a slot of class `value`; or, for a value
the body computes, the body, whose template the value then carries.

An option is not kept by reference. The runtime turns `grants`, a record
from a principal to an access level (`InSpaceGrants` in
`base/api/index.ts`), into the access list of the space, so the request
reads its content. The entry is exact, and it is not a widening. A
`grants` record the body built records `value` at each scalar projection
it holds.

Where the body is used with the input bound to a value the instance
computed, these records name no slot (`plan-and-label-templates.md` §3.14,
"The values of an `inSpace` request", and §3.15, "A factory from a
computed input").

- The factory of `Child.callee`, and the cell of a `SpaceRequest` target
  of kind `spaceOf`, are named by `{ computed }`: the `identity` entry of
  `Body.computed`, as a `GivenReference` names an entry.
- A target or an option that is one projection of such an input is
  recorded as `body`. It carries the body's template, which joins the
  template of the projection's entry of `Body.computed`. A `RequestValue`
  has no form that names the entry alone.

*Assumed,* for an inline pattern: the ruling on what a handler binding
holds applies to its captures, on which the owner has not ruled
(`plan-and-label-templates.md` §3.15, "Written at an instantiation in a
function body", and open question 23 there). The analysis fills `capture`
and `reference` for each path of `Closure.params` as it fills them for a
path of `Binding.state` (§8.5), and a `reference` names its entries as
[§3.8](#38-what-leaves-the-body) has it. `Closure.params` records no class
for a copied path. The copy holds the paths at which the inline pattern's
plan has a slot with root `params`, each narrowed to that slot's class
(`plan-and-label-templates.md` §3.15, "How much a copy holds"). The
parameters are stored with the instance, and each evaluation that makes
the instance writes them as it writes the argument.

**In a `lift` or a `computed`.** The analysis of the call is the one above:
the members of the argument are recorded by the reference rule, each
argument path is a `WriteEdge` with target `argument`, and the site is an
entry of `Body.calls`. Three things are specific to a body that is
evaluated again.

- **The instance belongs to the computation.** An evaluation that
  instantiates the same pattern at the same place names the same instance
  and updates its argument, and an instance that an evaluation no longer
  makes is torn down. The sites of `Body.calls` are what the runtime
  compares: the occurrences an evaluation made at each site, against the
  occurrences the evaluation before it made there. An occurrence is
  identified as `plan-and-label-templates.md` §1.3 has it: by the
  enclosing instance, the body's `name` and `within`, the site, and its
  ordinal among the instantiations the evaluation makes at that site,
  which is `identifiedBy: "order"`, or, with `.for(cause)`, by that cause
  in place of the ordinal, which is `identifiedBy: "tag"`. The rule is an
  assumption there (open question 26 there).
- **A read through the returned link is dynamic.** The instance outlives
  the evaluation that made it, so a later evaluation that reads through
  the link finds the child's result. That result is no input of the body
  and has no entry in the footprint. The read is journaled, like a read
  through a handle of `Body.handles`, and S1 holds for it because two
  executions are compared only when they agree on dynamic reads
  ([§9.1](#91-the-statement)). The site is an entry of `Body.handles`
  whose `handle` is `{ call }`, and its envelope admits what the body
  reads of the results of the instances the site makes
  (`plan-and-label-templates.md` §3.9, "Handles").
- **The computation requests no effect itself** (assumed, §8.3). The
  pattern it instantiates may. What the computation read reaches such a
  request through the argument: each argument path carries the body's
  template, or is a reference the body passed on
  ([§6.5](#65-the-label-of-a-written-value)).

Today, when the body of a `lift` calls a pattern factory,
`#writeJavaScriptActionResult` in `runtime/runner/src/runner.ts` builds a
synthesized pattern from the body's result (`patternFromFrame` in
`runtime/runner/src/builder/pattern.ts`). It runs that pattern into one
result cell, named from the node's bindings and its function, and keeps
that cell across the evaluations of the node. It runs the pattern again
only when it differs from the one the evaluation before built, and it
releases the child when the node is cancelled. So today too, what a
computation instantiates belongs to the node that ran it and is kept from
one evaluation to the next.

### 8.2 Creating a cell

| Where | Recorded |
| --- | --- |
| In a `handler` or an `action` | The site, with `identifiedBy: "order"`. The initial value is a `WriteEdge` with target `created` |
| In a `handler` or an `action`, with an explicit cause | The same, with `identifiedBy: "cause"`, and the cause by the reference rule |
| In a `lift` or a `computed`, with a constant cause or the element key | The site, with `identifiedBy: "cause"`. The cell is a `StateCell` of the plan, and the site names it in its `stateCell` member. The initial value is a `WriteEdge` with target `state`, a static target (§6.3) |
| In a `lift` or a `computed`, with a cause computed from data | The same, and the cause by the reference rule: `value` for a scalar, `identity` for a cell. The write's target is dynamic, so the body is a materializer whose envelope is the site, a `WriteEnvelope` of kind `created` |

A cause is constant when its expression is built from literals and
module-scope constants alone. A cause that is the element of the enclosing
element body, captured whole, is that element's key, and
`plan-and-label-templates.md` §3.14 treats it as constant too.

The `StateCell` of a cell created under a constant cause or the element
key records the body's `within`, and a `name` formed from the body's name
and the cause (`plan-and-label-templates.md` §3.14;
`execution-and-storage.md` §5.5 has the identifier). The site stays an
entry of `Body.calls`.

A read through the cell that a site with an explicit cause returns is
dynamic, in every kind of body: a later run under the same cause names the
same cell, which can hold what an earlier run or another holder of the
handle wrote. The site is an entry of `Body.handles`
([§7.5](#75-link-hops-through-data)). A cell created at a site that is
`identifiedBy: "order"` is new on every invocation, and reading it back
records nothing.

### 8.3 Requesting an effect

Legal in a `handler` and an `action`. *Assumed:* a `lift` or a `computed`
does not request an effect itself, as `language-subset.md` §10.3 has it
(`function-body:effect-in-computation`), and instantiates a pattern that
does (§8.1). The site records the built-in's name.
Each path of the request is a `WriteEdge` with target `request`. Each
member of the request is recorded by the reference rule, so
`navigateTo(target)` is `identity` at `target`, and a URL built from inputs
is `value` at what it was built from.

The request's label is the body's template, apart from the paths that hold
a reference the body passed on. A body has no label per computed value
(§4.1), and `plan-and-label-templates.md` §3.14 and `builtin-inventory.md`
("An effect request made from a body") give the request the body's
template.

A request that holds a container or a cell by reference does not read its
content, and the effect serializes it. The footprint is not where that
content is accounted for. The transaction that checks the egress ceiling
follows the references the request holds, and checks the ceiling on the
request's templates joined with what those reads consume
(`plan-and-label-templates.md` §3.14; [§3.8](#38-what-leaves-the-body)). An
operand that the built-in's entry in `builtin-inventory.md` declares a
reference, such as the target of `navigateTo`, is not followed.

### 8.4 Reading context

Each context read is recorded as `plan-and-label-templates.md` §3.16 lists
it. The analysis supplies the operand, and decides whether the call's
resolution and its observation of label metadata are static or journaled.

| Call | Recorded |
| --- | --- |
| `eventKey()`, `currentPrincipal()` | The `cause` entry. No input is observed |
| `principalOf(x)`, `principalsOf(x)`, `profileOwnerOf(x)` | A resolution of `x`, and an observation of the label metadata of `x` |
| `spaceOf(x)` | A resolution of `x` |
| `equals(a, b)` | A resolution of `a` and one of `b`, each decided on its own |
| `spaceAccess(x)`, `spaceAccessOf(x, p)`, `spaceMembers(x)` | A resolution of `x`, and a dynamic read of kind `space` through its `identity` entry. `value` at `p` |
| `spaceDeleted(x)` | For a cell operand, as `spaceAccess(x)`. For an operand that names a space, `value` at it and a dynamic read of kind `space` through that entry |
| `resultOwnerOf(x)` | A plain `identity` entry at `x`, and a dynamic read of kind `link` through it for the links the call follows. `value` at a field name that is a scalar projection |
| `linksOf(list)` | `enumeration` at `list` and `identity` at `list/*` |
| `getPatternEnvironment()` | Nothing |

**A resolution** is recorded by the rule of
[§7.1](#71-what-a-body-may-do-with-a-handle): a resolved `identity` entry
at the operand when it is static, and a plain `identity` entry with a
dynamic read of kind `link` when it is journaled. `resultOwnerOf` never
records a resolved entry, because the links it follows lead to the document
a write to the operand lands in, and with a field to that field of the
owning result, and not to the cell that holds the operand's value.

**An observation of label metadata** follows the same three conditions.
When the operand is one anchored projection and the call is unconditional,
it is a `labelMetadata` entry at the operand. Otherwise the runtime
journals the observation when the body makes it, as it records it today,
and it joins the body's dynamic read of kind `labelMetadata`
(`DynamicReads` in `plan-and-label-templates.md` §1.1). That read belongs
to the body and to no handle: the operand is not listed in `Body.handles`
on its account.

The access-list reads and the reads `resultOwnerOf` makes are dynamic
wherever the call is, since which space or document is read is data.

**An operand from a computed input.** Where the body is used with the
operand's formal input bound to a value the instance computed, the
resolution and the observation of label metadata are journaled whatever
the conditions say (`plan-and-label-templates.md` §3.16, "Static and
journaled"). The operand's entry is then an entry of `Body.computed`, and
a dynamic read of kind `link` or of kind `space` names it by the body and
the entry's index there (`ComputedReference` in
`plan-and-label-templates.md` §1.1).

### 8.5 Binding a handler

A binding is made by `action(...)`, by an inline event handler in JSX the
body builds, or by applying a handler to its state. The site refers to a
`Binding` of the plan, which holds, for each path of the handler's state,
the template of what is bound to it and whether it is copied or stays a
link.

What the body that makes the binding records for a captured or applied
value, and what the binding holds, depend on the kind of value that arrives
at the state path. For a value that is copied, a scalar or a container
the body computed, they also depend on what the bound handler's footprint,
over its `binding` root, has at the paths of that value: a copy holds what
the handler observes of it and no more (`plan-and-label-templates.md`
§3.14, "How much a copy holds").

| Captured or applied value | The handler's footprint there | Recorded in the body that makes the binding | What the binding holds |
| --- | --- | --- | --- |
| A handle | Any | `identity` | A link |
| A container passed on unchanged | Any | `identity`. The content is not read | A link to the address the container was read from |
| A scalar | `value` | `value`, where the scalar is a projection | The value |
| | `shape` | `shape`, where the scalar is a projection | A stand-in of the same kind |
| | `labelMetadata` | What the other entries at the path record, and nothing for this one | The handler observes the label stored for the copy |
| | No entry | Nothing | Nothing |
| A container the body computed | `value` at a path | `value` at a scalar projection the computed value holds at or below that path | The value at that path |
| | `shape` at a path | `shape` at a scalar projection the computed value holds at that path | A stand-in of the same kind |
| | `enumeration` at a path | Nothing. What the keys or the length depend on is recorded where the body built the container | A container with the same keys, or the same length |
| | `identity` at a path: the handler passes the value there on whole, or compares it | `value` at each scalar projection the computed value holds at or below that path | The subtree. The reference the handler observes is the reference to the copy |
| | `labelMetadata` at a path | What the other entries at the path record, and nothing for this one | The handler observes the label stored for the copy |
| | No entry at or below a path | Nothing | Nothing |
| A scalar, or a container the body computed, when the handler is a factory value | Not known when the site is compiled | `value` at the scalar projection, or at each scalar projection the computed value holds, in the subtree the handler's declared state type covers (`plan-and-label-templates.md` §3.14, "How much a copy holds", and §3.21) | That subtree, as `value` |
| The callee, when it is a handler factory value | | `identity` at the position that holds it (`plan-and-label-templates.md` §3.21) | |

**Which kind a value is.** The analysis tells the kinds apart by the
abstract value that arrives at the state path, with the rule
[§3.8](#38-what-leaves-the-body) has for a value that leaves the body.

- A value is **passed on unchanged** when it arrives whole as one
  projection of container, reference, or factory type, or as alternatives
  that are all such projections. It is a value the body read from an input or
  through a handle, and it has a stored address: the value carries the
  address it was read from (§3.8). The body records `identity` at the
  projection and reads none of the content, whatever the handler's
  footprint has at or below the path, and the binding holds a link to that
  address.
- A container is **computed** when it arrives as a record or a list the
  body built, as a bag, or as a `Computed` value. It has no stored address,
  and the binding's state document is where it is stored.
- A `Created` value is a reference the body obtained at a runtime call. It
  stays a link and records nothing.
- A handle or a container the body **found** below a hop whose read is
  dynamic ([§2.1](#21-abstract-values)) stays a link too. It has no
  `identity` entry, and finding it is a journaled read of the reference at
  its position.

**References inside a computed container.** Each member of a computed
container is treated by the table of §3.8.

- A member that is a handle, or a container passed on unchanged, is bound
  by the first two rows. The body records `identity` at it, and the copy
  holds a link at that path, whatever the handler's footprint has there.
- A member that is a scalar projection is recorded by the rows for a
  computed container.
- A member the body computed records nothing.
- A bag stands for each of its members.

Where the value at a state path is a set of alternatives of both kinds,
each alternative is recorded by its own row. `Binding.state` records such
a path with `capture: "copy"` and no `reference`, and the runtime stores a
link there on the runs on which the value it is handed carries a stored
address (`plan-and-label-templates.md` §3.14).

**What the `Binding` records.** For each state path the analysis fills
`capture` and `reference` (`plan-and-label-templates.md` §1.1).

- A path bound by reference has `capture: "link"`. Its `reference` names
  the `identity` entry of the one projection, as `passes`, where the
  entry's path has no `*` segment. Where it has one, the reference is one
  of those the entry stands for, and `reference` names the entry as
  `oneOf`. Alternatives give `oneOf` with the entry of each. All of this
  is as for a path of a written value
  ([§6.5](#65-the-label-of-a-written-value)). Each name is a slot's index,
  or `{ computed }` for a handle or a container that reached the body in a
  value the instance computed ([§3.8](#38-what-leaves-the-body)). The entry
  is one of the body whose `bind` site refers to the binding. The runtime
  verifies the reference by identity.
- A copied path has `capture: "copy"` and no `reference`.
- A reference inside a computed container is a path of its own, bound by
  reference, below the copied path.
- A `Created` value has `capture: "link"` and no `reference`. Its template
  is the body's.
- A handle or a container the body found below a hop whose read is dynamic
  has `capture: "link"` and no `reference`, and its template is the
  body's, as for a `Created` value.

For a handler received as a factory value, `Binding.handler` names the
factory as a `GivenReference`: by the index of the `identity` slot the
body has at the factory's position, or by `{ computed }` for a factory
that reached the body in a value the instance computed
(`plan-and-label-templates.md` §3.21, "A factory bound in a function
body").

The rows for a scalar and for a computed container use the record of the
hoisted or named handler, which the compiler has. The copy holds the
paths that record names, each as its class observes it, and no others
(`language-subset.md` §5.2). `Binding.state` records no class for a
copied path, because the
handler's own record has it: the runtime narrows the copy by the handler's
slots with root `binding` at or below the path, as it narrows the
handler's argument (`plan-and-label-templates.md` §3.14, "How much a copy
holds"). For a handler received as a factory value the compiler does not
have that record, and the copy holds the subtree the declared state type
covers, as `value` (the same paragraph there). The stand-ins a copy holds
are the ones an argument holds ([§13](#13-open-questions), request 8).

The `identity` row for a computed container follows from the copy. A
computed container has no stored address but the binding's state document.
A handler that passes it on stores a link to that document, and a handler
that compares it compares that link.

**What the bound handler reads.** The handler's own record holds its reads
of the state as slots with root `binding`. A slot at or below a path that
holds a link has a path that crosses the link
(`plan-and-label-templates.md` §2.5). So the handler reads a container
bound by reference when an event arrives, in that event's transaction, at
the paths and in the classes of its own footprint. A record it passes on is
a link to the original, and an observation of label metadata finds the
label stored for the original.

**The identity of the stream** derives from the enclosing instance, the
handler, the copied values, salted as element keys are, the identities of
the linked cells, and the addresses of the containers bound by reference
(`plan-and-label-templates.md` §3.14). Two bindings to equal records stored
in two places are two streams.

**The rule keeps S1** ([§9.1](#91-the-statement)). Two arguments that agree
on the footprint of the body give the same binding. At a copied path they
agree in the class the row records, and the copy holds what that class
observes and no more, so the copies are equal. That holds for a scalar the
handler only tests for presence: two arguments that differ in its value
agree on `shape`, the binding holds the same stand-in, and the stream is
the same. At a path
bound by reference they agree on `identity`, so the links are the same, and
so is the identity of the stream, which takes the address and not the
content.

**A binding made in the reactive tier** is not a `bind` site of a body and
copies nothing. The reactive tier is the pattern body and everything
compiled in it, the body of a per-element callback included. There every
path of the handler's state resolves to a slot or an output of the
instance, and `Binding.state` has no copied path. The analysis runs on the
hoisted or named handler, whose state paths are slots with root `binding`.

**Against today.** In each case the rule is equal to today or tighter. It
is within requirement 2 of §1.4 and is not an exception to it.

- **A container passed on unchanged stays a link today.** A value read
  from an input carries the address it was read from (§3.8). When a body
  applies a handler to its state, the builder replaces such a value by the
  cell at that address (`connectInputAndOutputs` in
  `runtime/runner/src/builder/node-utils.ts`), so the binding holds a link.
  The handler reads the value through the link, under its own state
  schema, when an event arrives (`#instantiateJavaScriptHandlerNode` in
  `runtime/runner/src/runner.ts`), and a record it passes on is a link to
  the original. What the binding holds and what the handler observes are
  equal.
- **A handler applied to its state.** `analyzeFunctionCapabilities` in
  `base/ts-transformers/src/policy/capability-analysis.ts` takes the
  application for a call that binds its arguments by reference, and does
  not charge the caller with what the handler reads of an argument. It
  records a read at the position the argument was taken from, and the
  argument schema the transformer emits for the body keeps the container's
  declared type there (read from the transformer's output for a `lift` that
  applies a handler to a record of its input). So the body's transaction
  reads the container today, and the `identity` entry of the rule is
  tighter.
- **An inline event handler or an `action`.** The transformer rewrites the
  captures into an object of the paths the handler reads
  (`transformHandlerJsxAttribute` in
  `base/ts-transformers/src/closures/strategies/handler-strategy.ts` and
  `transformActionCall` in
  `base/ts-transformers/src/closures/strategies/action-strategy.ts`, with
  `buildCaptureParamsObject` in
  `base/ts-transformers/src/closures/utils/capture-scaffold.ts`). A
  container the handler uses whole is passed as it is and stays a link,
  which is equal. A scalar the handler reads below a captured container is
  read by the body today and copied. Under the rule the captured container
  is one link: the body records `identity` in place of those paths, and
  the handler reads them through the link when an event arrives. That is
  tighter for the body. For the handler, a read of the path itself takes
  the place of a read of a copy, and the copy carries the label of
  everything the body read.
- **A scalar, and a container the body computed,** are copied today and
  under the rule. Under the rule the copy is narrowed to what the handler
  observes. Where the handler's footprint has `shape` or no entry at a
  scalar, the body records `shape` or nothing, where today it reads the
  value. That is no wider.

**What a handler received as a factory value may write.**
`scheduler-and-serving-loop.md` (open question 24) asks whether the
analysis can bound it. It can bound it by position and not by address, and
the bound needs no record beside the `Binding`.

- The compiler does not have the handler's body, so the plan has no write
  edge for it until the binding is resolved
  (`plan-and-label-templates.md` §3.21). What the compiler has is the
  factory's declared state type.
- A handler writes only through a handle it holds. Through its state it
  holds the handles the binding links and the handles it reaches through a
  container the binding links, and it can write through one only at a
  position where the declared state type has a writable handle type:
  `Cell`, `WriteonlyCell`, or `Stream`. A handle bound at a position typed
  `ReadonlyCell`, `ComparableCell`, or `OpaqueCell` cannot be written
  through.
- So the cells the handler may write through its state are found from the
  `link` entries of `Binding.state`. For an entry at a writable position
  of `Binding.stateSchema`, it is the whole cell that entry links to. For
  every entry, a handle and a container bound by reference alike, it is
  also every cell reachable from what the entry links to through a
  writable handle type in the declared types. The second part names
  positions, with `*` and hops, and no addresses.
- The handler can also write through handles its event carries, which the
  sender supplies and the binder does not see, and into cells it creates.

Once the binding is resolved, the handler's own record replaces the bound
with its write edges and envelopes.

The bound handler is a body of its own, analyzed with the captured values as
formal inputs. Its reads and writes happen when an event arrives, in that
event's transaction, and are not part of the body that made the binding.

## 9. Soundness

### 9.1 The statement

Fix a body `b` with footprint `F`. An argument is **admissible** when it is
a value of the type of the body's input, or such a value narrowed to a
footprint that contains `F`. A narrowed value holds, at each entry, what
the entry's class observes, and holds nothing at a path that has no entry
at or below it. Where a `value` entry covers a recursive type, an
admissible argument holds nothing at a position of handle, reference, or
factory type below the cut of §2.2, which has no entry. Two admissible
arguments **agree on `F`** when, for every
static entry of `F`, they give the same observation:

| Class | Two arguments agree at `x.p` when |
| --- | --- |
| `value` | The values at `p` are equal, down to each position of handle, reference, or factory type. The references at those positions are compared by the `identity` entries that accompany the `value` entry (§2.2) |
| `shape` | The path exists in both or in neither, and holds a value of the same kind |
| `enumeration` | The containers at `p` have the same keys in the same order, or the same length |
| `identity` | The references at `p` are the same. For a resolved entry, the links followed from there are the same too, and so is the reference where the resolution ends |
| `labelMetadata` | The label metadata observed at `p` is the same |

Two executions **agree on dynamic reads** when each of these returns the
same value in both: every read made through a handle of `Body.handles`,
the ones through a link or a cell that a site of `Body.calls` returned
included (§7.5), every link a journaled resolution follows, every
journaled observation of label metadata, every other context read
recorded as dynamic, and the clock and
the entropy a handler may read, which have no entry
(`plan-and-label-templates.md`, open question 8).

**S1 (reads).** If two executions of `b` receive admissible arguments that
agree on `F`, and agree on dynamic reads, then they behave alike: they
return the same value or throw the same error, make the same writes with
the same values to the same targets, and make the same runtime calls with
the same arguments in the same order.

**S2 (writes and calls).** Every write an execution of `b` makes has a
target that a `WriteEdge` of the body names, or that lies under one of its
envelopes. Every runtime call it makes is at a site in `Body.calls`.

**S3 (references).** If `Body.outputs`, a write edge, a state path of a
binding, or a parameter path of an inline pattern records that a path
holds a reference the body was given, then on every execution the
reference at that path is the one the named entry holds, for `passes`, or
one of those the named entries hold, for `oneOf`. An entry whose path has
a `*` holds one reference per position, which is why it is named in
`oneOf` and never in `passes`.

S1 is the lemma the specification needs. It says a body is a function of
its footprint, which is the property an opaque call with a footprint has in
the calculus of the plan. It is stated over arguments and not over an
instrumented execution, so it does not depend on defining what each
JavaScript operation "observes": the classes are defined by which arguments
they tell apart. The transfer rules of §3 are how the analysis establishes
it, and the proof obligation for the analysis is that each rule's
observations are enough for the operation to give equal results on
arguments that agree.

Three rules exist only so that S1 holds as stated.

- **A key or an index records `value`** (§3). Two arguments that differ
  only in `event.position` return different values from
  `rows[event.position].price`.
- **A write records `identity` at the handle written through** (§6.1). S1
  compares the targets of writes, and the target is the cell the reference
  at that position links to.
- **A test the type decides records `shape` where no other entry puts the
  tested path into the argument** (§2.2). A narrowed argument is outside
  the input's type at every path with no entry at or below it. A body
  whose one use of
  `donut.name` is a `typeof` test would receive no `name`, and the test
  would differ from the test on the full input.

Several entries of the record exist for the lemma, or change what it
compares. Each is listed with how the lemma uses it.

- **The `identity` entries that accompany a `value` entry** (§2.2). S1
  compares content at a `value` entry and references at an `identity`
  entry. A body that converts, compares, or passes on a subtree observes
  which reference sits at each handle or reference position inside it.
  The accompanying entries put those references into the agreement, so
  two arguments that agree on `F` cannot differ in one.
- **A handle or a container found below a dynamic hop** (§2.1) has no
  static entry. The body observes it by a journaled read under the
  envelope of the entry it was found through, and S1 covers it by
  agreement on dynamic reads. S3 says nothing of it: the record holds no
  `reference` for it.
- **A read through what a site returned** (§7.5) is covered in the same
  way: the site is an entry of `Body.handles`.
- **`oneOf` for an entry with `*`** (§3.8). S3 holds because the
  reference at the path is one of those the entry holds. Which one is a
  function of the footprint by S1, and its label joins the body's
  template.
- **The class recorded for a copied scalar** (§8.5). S1 compares the
  bindings a body makes by what they hold. A binding holds a copy narrowed
  to the class the body recorded, so two arguments that agree in that
  class give the same binding.
- **`value` for an option of an `inSpace` request** (§8.1). The request
  is a runtime call whose arguments S1 compares, and the access list it
  makes is a function of the content of `grants`.
- **A `WriteEdge` with target `state` for a cell created under a constant
  cause** (§8.2) is the edge S2 needs for that write.
- **The pure API functions** (§3.4). Each rule records what the function's
  result depends on: the content of a consumed operand, and the reference
  alone for `getEntityId` and the first operand of `uiVariant`.

Two corollaries are used elsewhere.

- **Narrowing preserves behavior.** The argument the runtime builds from
  `F` is admissible and agrees on `F` with the full input. By S1 the body
  behaves on it as it would on the full input. The one input that is not
  admissible as it stands holds a handle or a reference below the cut of
  a recursive type under a `value` entry (§2.2). There the body behaves as
  on that input without those references.
- **Widening preserves S1** (§5.4). Arguments that agree on a wider
  footprint agree on the narrower one.

### 9.2 What rests on the analysis

`plan-and-label-templates.md` §7 separates what the runtime enforces from
what holds only if the compiler is correct. For the footprint:

| Property | If the analysis is wrong | Rests on the analysis? |
| --- | --- | --- |
| The label of a body's result covers everything the result depends on | An entry missing from `reads` or from `computed` is not materialized. The body computes from an argument that lacks it, and the label still covers everything the body was given | No. Body narrowing is enforced by the runtime, for slots and for computed inputs alike (§7.3 there) |
| Data outside the footprint stays confidential from the body | The same: the body is not given it | No |
| The body computes what its author wrote | A missing entry gives the body an absent value or a default, or fails its cone on validation. The result is wrong or an error state, with a label that covers it | Yes: this is S1 |
| A class is narrow enough | A `shape` entry where the body needs the value gives the body a stand-in. The result is wrong, with a label that covers what was given | Yes, for correctness. No, for the label |
| A read or a resolution marked static is unconditional | The entry is in the label on a run that returned normally and did not make the read. The label is wider than today's on that run, and no narrower on any | For precision only (§7.4 there) |
| A read left dynamic | The runtime journals it, under the handle's envelope. An envelope that is too narrow starves the read | No |
| A handle the record does not name | The body is not handed it | No |
| A body writes only what its record lists | The runtime refuses the write | No. It fails closed (§7.3 there) |
| A reference recorded as passed on | The runtime compares identities and falls back to the body's template | No |
| A reference recorded as `passes` where the entry's path has `*` | The check passes for any reference the entry holds, and which one the body chose is in no label | Yes. The analysis never emits it (§3.8) |
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
| A handler binding made in a body | The captures of an inline handler are rewritten to the paths the handler reads. The body reads a scalar among them, which is copied. The state of an applied handler, and a captured container the handler uses whole, are bound by reference, and the body's argument schema keeps the container's declared type | A container passed on unchanged is bound by reference and the body records `identity`, for an applied handler and an inline one alike. A scalar and a container the body computed are copied, narrowed to what the bound handler observes ([§8.5](#85-binding-a-handler)) |
| What it cannot verify | `hasUnverifiedCellUse`, set by a method call on a cell the analysis does not know | The language refuses an undeclared cell method (`cell:unsupported-method`), so the case does not arise |

Every row narrows, or leaves the same, what a body reads on a run that
returns normally, which is requirement 2 of §1.4. The row for reads through
a cell is where the ruled exception for a run that throws applies (§7.2).

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
today's transaction join in the same way. Today's transaction reads every
declared field of an authored event, and the template reads the footprint.
The two are equal for an event whose type is inferred and for a body that
reads every field the authored type declares, and the template is tighter
when the authored type declares a field the body does not read.

## 11. Corpus measurement

### 11.1 Method

The corpus, and the way a construct is counted, are those of
`language-subset.md` §11.1: one script that uses the TypeScript parser and
no type checker, over 425 modules. It holds 621 `handler` definitions, 73
`lift` definitions, 1,493 `computed` calls, 249 `action` calls, and 188
inline event handlers. That script finds the bodies of §1.2 and applies the
promotion criterion of `language-subset.md` §6.1 by syntax, which gives
the counts of §11.2: 1,966 bodies.

A second throwaway script, also not part of the repository, looked in each
body for the constructs of §5.2, §6, and §7. The counts of §11.3, the split
of §11.4, and the rows of §11.5 are its results. It read 1,962 of the 1,966
bodies. The four it did not read are the handler `writeProfile` in
`patterns/system/fabrichat/room-test-fixture.ts` and three `computed`
bodies that are not promoted because each holds an inline event handler:
one each in `patterns/dev/gideon-tests/computed-array-repro.tsx`,
`patterns/examples/fair-share/main.tsx`, and
`patterns/examples/reading-list/reading-list.tsx`. Those tables are
therefore over 1,962 bodies, and for the four bodies they are not
reproduced. The one exception is the `handler` row of §11.5, which includes
`writeProfile`, read by hand.

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
| `handler` | 621 | 25 |
| `action` | 249 | 10 |
| Inline event handler | 188 | 0 |
| `lift` | 73 | 0 |
| `computed`, not promoted | 124 of 1,493 | 3 of 112 |
| Authored function | 711 | 91 |
| **Bodies and summaries analyzed** | **1,966** | **129** |

The other 1,369 `computed` calls (92%) meet the promotion criterion by
syntax and are not bodies (`language-subset.md` §11.5).

### 11.3 Where the analysis gives up

Bodies that contain each cause, directly and through helpers, of the 1,962
that the second script read (§11.1):

| Cause | Sites | Directly | Through helpers | By kind, through helpers |
| --- | --- | --- | --- | --- |
| W1: a key that is not static and not index-like, on an input | 50 | 36 | 64 | 16 handlers, 2 actions, 7 computeds, 39 functions |
| W2: `JSON.stringify` applied to an input | 8 | 4 | 4 | 1 lift, 2 computeds, 1 function |
| W2: an input passed to `console` | 26 | 10 | 10 | 5 handlers, 3 actions, 1 inline handler, 1 computed |
| W3: an imported TypeScript function | 0 | 0 | 0 | No module carries the directive yet |
| W4: an input passed to a call the script could not resolve | 6 | 4 | 6 | 2 handlers, 4 functions |
| W5: an input updated in place | 0 | 0 | 0 | |
| An authored function that calls itself, counted in place of W6 | 0 | 0 | 0 | Three closures inside bodies call themselves |
| **Any of the above** | | **53 (2.7%)** | **83 (4.2%)** | 23 handlers, 4 actions, 1 inline handler, 1 lift, 10 computeds, 44 functions |

Two causes are not measured. W6 is a path that enters a recursive type a
second time, which a loop over a recursive type produces as well as a
recursive function. The script has no types, so the row above counts
recursive authored functions, which are one way a body produces such a
path and not the only one. W7, an analysis limit, needs the analysis itself
and has no row.

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

The bodies hold 1,205 calls of `get()` or `sample()` with no argument, in
650 bodies. The table splits the 1,201 reads, in 649 bodies, of the 1,962
bodies that the second script read (§11.1). The 4 reads in the three
`computed` bodies it did not read are not reproduced.

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
| `handler`, with `writeProfile` read by hand | 568 | 520 | 1,006 | 941 |
| `action` | 233 | 226 | 450 | 436 |
| Inline event handler | 185 | 183 | 219 | 217 |
| `computed`, not promoted | 23 | 23 | 32 | 32 |
| `lift` | 1 | 0 | 2 | 0 |
| Authored function | 51 | 28 | 115 | 83 |

The corpus has 197 computations: 73 `lift` bodies and 124 `computed`
bodies that are not promoted. The second script read 194 of them (§11.1),
and 33 of those write anything beside their result in their own text. For
the other three `computed` bodies the count is not reproduced.

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
5. the write tiers of §11.5 with handles resolved through helpers;
6. W6 by type, and whether any body reaches a limit of W7;
7. how many handler bindings made in a body bind a container, counted
   apart for applied and inline handlers, and for a container passed on
   unchanged, which §8.5 binds by reference, and a container the body
   computed, which it copies.

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
whether the handle is present and resolves it, recording `shape` at `p` and
a resolution of `p`. `profile?.get() === undefined` reads through it and
compares with `undefined`, recording `shape` at `p->`. It returns `p`,
resolved. Applied to `myProfile`, which is one anchored handle. The
resolution and the read are conditional only on the handle being present,
and the call is the first statement, so both are static: the `identity`
entry at `myProfile` is a resolved one, and `myProfile->` is a static
entry.

The `shape` entry at `myProfile->` assumes the profile cell's type admits
`undefined`. The source declares it as a cell of the profile record and
relies on `get()` returning `undefined` for a profile that has not
resolved. In this language the type decides such a test (§2.2), and a cell
that holds no value where its type requires one fails the cone that reads
it (`plan-and-label-templates.md` §5.2). The helper keeps its meaning only
if the type says the value can be absent ([§13](#13-open-questions),
request 14).

**Step 2.** `event?.message` records nothing for `event`: its type admits
no `undefined`, and the footprint has entries below it. `?? message`
records `shape` at `event.message`. The argument is the alternatives
`{event.message, state.message}`. The summary of `messageInRoom(room, link)`
records `shape` at `link` and a resolution of it, and through the two calls
of `spaceOf` a second resolution of `link` and one of `room`. It returns
`link`, resolved. So `target` is the alternatives
`{event.message, state.message}`, resolved.

None of these resolutions is static. `link` is a set of alternatives, and
both calls of `spaceOf` are in the right operand of `||`. Each records a
plain `identity` entry, at `event.message`, `state.message`, and
`state.room`, and the links followed below those references are journaled
(§7.1).

**Step 3.** `target.get()` is unconditional, since the statements before it
can throw and cannot return. It still fails condition 1 of §7.2: the handle
is a set of alternatives. The read is dynamic through both handles.
`isDeleted(current)` adds `(root) : shape` and `body : shape` to their read
envelopes, because `typeof record.body` asks for the kind of `body` and not
for its content.

**Step 4.** `currentPrincipal()` is the `cause` entry. `principalOf(target,
…)` resolves the same alternatives and observes their label metadata, so
both are journaled. The links join the journaled resolutions of step 2, and
the observation joins the body's dynamic read of kind `labelMetadata`
(§8.4).

**Step 5.** `textOf` and `hasTextIn` test `event.body`, `event.target`, and
`event.target/value` for presence and kind, and `textOf` returns one of the
two strings, which the body goes on to consume. So they record `value` at
`event.body` and at `event.target/value`, which covers the tests there, and
`shape` at `event.target`. `current.attachments?.length` adds
`attachments : shape` and `attachments : enumeration` to the read envelope
of the two message handles.

**Step 6.** Two writes through the alternatives, at the static paths `body`
and `editedAt`. By §6.2 these are static targets: one write edge per
alternative. Each target has `resolved`, since the writes go through what
`resolveAsCell()` returned, and names the plain `identity` slot the body
has at the handle, since the resolution is journaled. Each write records
`identity` at the handle written through, which the footprint holds
already. The value written to `body` is the alternatives
`{event.body, event.target/value}` and the empty string `textOf` returns
when neither holds a string. Both projections are scalars, so the write
records `value` at each, and the label of what is written is the body's
template. `now()` reads the handler clock, which has no entry
(`plan-and-label-templates.md`, open question 8).

**Step 7.** `composer` is one anchored handle and the `get()` is
unconditional, so the read is static. The `?.` after `get()` records
nothing: the composer's value has a declared default, its type admits no
`undefined`, and the footprint has an entry below it. `composer->editing`
gets `shape` from the test against `undefined`, and `equals` resolves it.
That call is in the right operand of `&&`, so the resolution is journaled:
a plain `identity` entry at `composer->editing`, and the links followed
below it. The write to `composer->editing` is conditional, which does not
matter for a write: the edge says what the body may write. It records
`identity` at `composer`.

On a run that throws at one of the earlier steps, today's transaction never
reads `composer`. The outcome of that failed run carries the label of
`composer->editing` all the same, by the ruling on runs that throw (§7.2).

No step widens.

### 12.3 The footprint

The listing is in the notation of this document and in the normal form of
§2.3. In the plan a path has no arrow: `state.composer->editing` is the
slot path `composer/editing`, which crosses the link at `composer`. In the
writes, `(resolved)` is the flag of the target, and its slot is the plain
`identity` entry of the handle.

```text
reads
  cause   principal              : value
  event   body                   : value
  event   target                 : shape
  event   target/value           : value
  event   message                : shape, identity
  state   myProfile              : shape, identity (resolved)
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

other dynamic reads
  links followed below event.message, state.message, state.room,
    and state.composer->editing
  label metadata (authored-by) of the message

writes, each a write edge with target `handle`
  event.message (resolved) body        state.message (resolved) body
  event.message (resolved) editedAt    state.message (resolved) editedAt
  state.composer editing

envelopes
  none

calls
  none

widenings
  none
```

The template of everything `commitEdit` writes is `derive` over the fifteen
static entries, the journaled reads through the two message handles, the
links the journaled resolutions follow, and the journaled observation of
label metadata.

Four of the `shape` entries are at a position that holds a handle:
`event.message`, `state.myProfile`, `state.message`, and
`state.composer->editing`. Each observes whether a handle is there and not
the cell behind it, and is a `shape` slot with `inPlace` (§7.2). The entry
at `state.myProfile->` has the path of the entry at `state.myProfile` and
no flag: it resolves through the link.

### 12.4 Against what the transformer emits today

The schemas below were read from the transformer's output for the module
(`deno task cf check … --show-transformed --no-run`).

| Input | Today | Under this analysis |
| --- | --- | --- |
| `event` | The whole `RoomStreamEvent`: all eight fields, with the full schemas of the message, reaction, reply, and file records behind its cells (the `contract` mode of §10.1) | `body`, `target/value`, and the reference at `message` |
| `state.myProfile` | A read-only cell of the profile record, with `name` and `avatar` | The reference, and whether the profile holds a value |
| `state.message`, `event.message` | A cell of the whole `MessageRecord`. `target.get()` reads `body`, `sentAt`, `editedAt`, `replyTo`, and the references at `authorProfile`, `attachments`, and `reactions`. `state.message` is emitted read-only, although the body writes through the handle `messageInRoom` returns for it | The kind of `body`, and the presence and length of `attachments`. Two write edges per handle |
| `state.composer` | A cell of the whole `ComposerState`: the draft, the attachments being added and removed, and four message references | The reference at `editing`, and whether there is one |
| `state.room` | A read-only cell of unknown content | The reference, and the links below it on the runs that reach `spaceOf` |

The labels differ accordingly. Today the handler's transaction reads the
draft text in `composer`, although an edit never looks at it. A deployment
that labeled a session's draft would put that label on every edited
message. Under the footprint it does not.

FabriChat declares no confidentiality, so as deployed the instantiated
labels are equal, as `plan-and-label-templates.md` §6.4 finds for the send
handler. The difference is in what the handler loads.

### 12.5 The send handler of the plan's example

`plan-and-label-templates.md` §6.2 gives the record of `commitSend`, its
body `B0`. Its listing is a slice of the record this analysis gives for
the source. What the listing has agrees with the analysis as follows, and
what it leaves out is after the list.

- `myProfile` is not in `handles`. The call of `resolvedProfile` that opens
  `sendInto` is the static resolution and the static read of step 1 above:
  a resolved `identity` slot, and a `shape` slot whose path crosses the
  link.
- `messages` is not read through. `sendInto` pushes onto it, which is a
  write edge with target `handle`, and passes it to `spaceOf`, by way of
  `isInRoomOf`, on the runs that check an attachment or a reply. Those
  calls are conditional, so the `identity` entry at `messages` is a plain
  one and the links `spaceOf` follows are journaled.
- The reads through handles the event carries are dynamic: each element of
  `event.attachments`, read in `attachmentsIn`, and `event.replyTo/thread`
  and `event.replyTo/quotes`, read in `checkedReply` when the event names a
  reply. The entry for the attachments names the `identity` entry at
  `event.attachments/*` (§7.5).
- `threadInfo` is in `handles`. It is read under a key computed from the
  thread's root, through `elementById`, and the write through that element
  is too broad to predict, so the body has a `handle` envelope over the
  children of `threadInfo` (§6.2).

The plan's listing leaves out five things this analysis records, and
§6.2 there says what its listing leaves out.

- **The `shape` entries at optional positions.** One is at a data
  position, `event.target`. The others are in place, at the positions of
  the optional handles, among them `state.myProfile`, `state.joined`,
  `event.replyTo/thread`, and `event.replyTo/quotes`.
- **Three dynamic reads of kind `link`,** through the entries `e3`, `e5`,
  and `e6` there. `attachmentsIn` calls `resolveAsCell()` on each element
  of `event.attachments`, inside a callback, and `checkedReply` calls it
  on `reply.thread` and `reply.quotes` in a branch of `?:`. Each is
  conditional, so each is a journaled resolution (§7.1). The listing has
  the one through `b2`.
- **Two reference edges.** The pushed value holds `replyTo`, whose
  `thread` and `quotes` are the handles those journaled resolutions
  returned. Each is a `WriteEdge` of its own, at `*/replyTo/thread` and
  `*/replyTo/quotes`, whose `reference` names the plain entry, `e5` and
  `e6` (§3.8, §6.5).
- **The `enumeration` entry of `titles`.** `threadTitleOf` reads
  `titles[key]` on a record under a key that is not static, which is
  widening W1: `enumeration` at `titles` beside `value` at `titles/*`,
  and an entry of `widenings` that lists both in `Widening.computed`
  (§3.1, §5.1).
- **`inPlace` on `m4`.** `authorProfile` is a position of handle type, so
  the `shape` slot there is in place (§7.2).

All of them are in the footprints of the bodies and join their templates,
and with FabriChat's labels none changes an instantiated label.

The edge `w2` there, `*/attachments/*` as one of `e3`, is the rule of
§3.8 for an entry whose path has `*`: `attachmentsIn` returns the
elements it resolved, a bag of `event.attachments/*`, and which reference
is at a position of the stored list is the body's choice.

## 13. Open questions

Decided in this document, and written into the sections above: a body's
computed values have one template, and only references are told apart
(§4.1); a widening covers the subtree of the value that was lost, and for a
key that is not static it covers the children at the paths read (§5.2); a
read through a handle is static exactly under the three conditions of §7.2,
and a resolution under the same three applied to its operand (§7.1); a
computation is a materializer exactly when one of its side-writes has a
target that is not static (§6.3); and an under-approximated read fails
closed for labels (§9.2).

Ruled by the project owner, and written into §1.4 and §7.2: a read through
a handle is static when every run that returns normally makes it, and a run
that throws before the read carries the read's label all the same.

Ruled by the project owner, and written into §3.8 and §8.5: a handler
binding made in a body binds a container the body passes on unchanged by
reference, and copies a scalar and a container the body computed. A binding
made in the reactive tier copies nothing.

Ruled by the project owner, and written into §6.3 and §8.1: a `lift` or a
`computed` may instantiate a pattern, and that pattern may request
effects. An evaluation that instantiates the same pattern at the same
place names the same instance and updates its argument, and an instance an
evaluation no longer makes is torn down.

### Needing the project owner

1. **Conditional reads through handles.** A third of the reads through
   handles in the corpus are at a statically known place and happen on some
   runs only (§11.4). The ruling that template labels are never wider than
   today's keeps them dynamic. Making them static would remove the
   `dynamic` node from the templates of many more bodies, at the price of a
   label that includes a cell on runs that did not read it. *Assumed:* they
   stay dynamic. The exception for a run that throws (§7.2) does not extend
   to a run that returns normally.
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

Each request states the assumption this document made. An entry marked
"met" keeps its number and points to where the other document has what was
asked.

1. **Formal inputs and slots** (to `plan-and-label-templates.md`). Met by
   `Body.computed` and §3.9 there ("Computed inputs"): an entry on an input
   the instance computed is a `ComputedInput`, with the template of the
   producing expression at its path, and the runtime narrows the value to
   the entries (§1.1 here).
2. **Handles in the record** (to `plan-and-label-templates.md`). Met, in
   two places in another form than this document assumed. (a) A slot path
   crosses a link, and the hop is not a segment (§2.5 there). (b) An entry
   of `Body.handles` names the handle's `identity` slot, an `identity`
   entry of `Body.computed`, or a site of `Body.calls`: an `instantiate`
   site, or a `createCell` site with an explicit cause (`HandleReads`;
   §7.5 here).
   (c) The read envelope is a schema on that entry,
   `HandleReads.envelope`, and not the schema of a slot. (d) A sampled
   read is the flag `Slot.sampled`. (e) `Body.handles` lists a handle only
   where some read through it is dynamic, and the body is handed every
   handle its record names (§3.9 there). Request 16 has the further forms.
3. **Write targets** (to `plan-and-label-templates.md`). Met by §1.1 and
   §3.11 there: the `handle` target of a `WriteEdge`; `WriteEnvelope`, in
   `Body.envelopes`, for a write with no static target; the `reference`
   member of a `WriteEdge` for a passed reference; the `handle` kind of
   `ConeEdge.via`; and the `operation` slot for what a materializer
   returns (§6 here).
4. **A handler's event against today** (to `plan-and-label-templates.md`).
   Met by §3.12 there: equal or tighter (§10.4 here).
5. **The grammar's list of causes, and three diagnostics** (to
   `language-subset.md`). Met by §5.4 there, which refers to §5.2 here for
   the causes, and by §10.3 there, which has `footprint:dynamic-read`,
   `footprint:materializer`, `side-write:not-idempotent`, and
   `side-write:cycle`.
6. **Read-only inputs** (to `language-subset.md`, its open question 11). If
   the value a body receives has a deeply read-only type, as module-scope
   data has, an update in place is a type error and W5 goes away. The
   corpus has no instance of it by syntax (§11.3), and today it throws
   (§3.5). *Assumed:* inputs are mutable in the type system, and W5 stands.
7. **The request template of an effect** (to `builtin-inventory.md`). Met:
   "An effect request made from a body" there gives the request the body's
   template, and the inventory cites §8.2 here for a cell created in a
   lift.
8. **Building an argument from entries** (to `execution-and-storage.md`).
   The runtime has to hand a body a value for an entry of class `shape`,
   `enumeration`, or `identity` that carries that observation and no more:
   a stand-in of the right kind, a container with the right keys or length,
   a reference that can be passed on and not read. *Assumed:* it does, as
   the opaque and comparable cells and the `unknown` items of today's
   schemas do. The copy a binding holds, and the copied capture of an
   inline pattern, need the same stand-ins. What narrows such a copy is
   decided in `plan-and-label-templates.md` §3.14 and §3.15 ("How much a
   copy holds" in each): the bound handler's slots with root `binding`,
   and the inline pattern's slots with root `params` (§8.5 and §8.1 here;
   request 19). The same document has to confirm that a value passed on
   unchanged is stored as a reference (question 2 above), that a handle's
   `get()` and `sample()` return the value narrowed to the entry's envelope
   (`plan-and-label-templates.md` §3.9), and that the reference a body is
   handed for a resolved entry is the resolved one.
9. **Static reads and the scheduler** (to
   `scheduler-and-serving-loop.md`). *Assumed:* the static entries of a
   handler are what is evaluated before its body, and a read through a
   handle of `Body.handles` is not known before the body runs
   (`plan-and-label-templates.md` §5.4); the declared write envelope of a
   materializer is its body's `writes` and `envelopes`
   (`plan-and-label-templates.md` §3.11); and the compile-time report of
   cycles is computed from `Plan.edges`, which the write edges of §6
   supply. §8.5 answers its open question 24. It also has to keep, with a
   cone, which instances the last evaluation of a `lift` or a `computed`
   made at each site, and tear down the ones an evaluation no longer
   makes, as `plan-and-label-templates.md` §3.14 has it (§6.3, §8.1).
10. **Limits** (to the prototype). W6 cuts a recursive type at its second
    entry, and W7 needs two bounds: alternatives per value, and rounds to a
    fixed point. *Assumed:* the second entry, eight alternatives, and eight
    rounds. The prototype measures whether any body in the corpus reaches
    them. No authored function in the corpus is recursive (§11.3).
11. **Logs** (to the overview). Met: the overview lists it under its open
    questions ("Logs"). `console` is in the standard-library surface, and
    a body can pass it labeled data. This analysis counts the arguments as
    read (§3.4). Whether the sandbox lets labeled data reach a log is
    outside it, and is not decided there.
12. **The measurements** (to the prototype): the items of §11.7.
13. **The plan's FabriChat example** (to `plan-and-label-templates.md`).
    Met: §6.2 there lists the handles of `commitSend` as this analysis
    finds them, and its bodies are the authored functions the promoted
    `computed` calls call. The listing there is a slice of the record
    this analysis gives, and §6.2 there and §12.5 here name what it
    leaves out.
14. **A cell that holds no value** (to `language-subset.md`, its open
    question 12, and the prototype). The corpus tests whether a link has
    resolved by comparing `cell.get()` with `undefined`, on cells whose
    declared value type admits no `undefined` (`resolvedProfile` in
    FabriChat, §12.2). Under `plan-and-label-templates.md` §5.2 such a read
    fails its cone instead of returning `undefined`. *Assumed:* the type
    has to say so, `Cell<Profile | undefined>`, and the analysis then
    records `shape`. The prototype has to measure how many cells the idiom
    is used on.
15. **How much of a computed container a binding copies** (to
    `language-subset.md`). Met by §5.2 there ("What a binding holds"): the
    copy holds the paths the bound handler's footprint names, and for a
    handler received as a factory value the paths its declared state type
    covers (§8.5 here). Two bindings whose computed records differ only at
    paths the handler does not read are one stream.
16. **Forms of the record for eight things the analysis produces** (to
    `plan-and-label-templates.md`). Met by §1.1 there, form by form.
    - **`shape` at a position that holds a handle:** a `shape` slot with
      `inPlace` (§2.5 there; §7.2 here). The handler of §12 has four such
      entries.
    - **A widening on a computed input:** `Widening.computed` (§5.1).
    - **A write through a resolved handle:** a `handle` target with
      `resolved`, whose slot is the `identity` slot the body has at the
      handle, the plain one where the resolution is journaled (§3.11
      there; §6.2).
    - **A handle found by a dynamic read:** no entry of its own. The
      envelope of the entry it was found through admits the position as a
      handle (§3.9 there; §7.5), and a write envelope names it by a slot
      that is in no `reads` (§3.11 there; §6.2).
    - **The captures of an inline pattern a body instantiates:** a `Child`
      whose callee is a `Closure` (§3.15 there; §8.1). That they are bound
      as the state of a handler binding is an assumption there (open
      question 23 there).
    - **`equalLinks`:** a row in §3.16 there, with a plain `identity` slot
      at each operand (§3.2).
    - **A state path of a binding that holds a reference on some runs
      only:** `capture: "copy"` and no `reference`, and the runtime stores
      a link where the value it is handed carries a stored address (§3.14
      there; §8.5).
    - **A read through the link of an instance a computation made:** an
      entry of `Body.handles` whose `handle` is `{ call }` (§3.9 there;
      §8.1). The same form names an `instantiate` site that is
      `identifiedBy: "tag"` in a handler, and a `createCell` site with an
      explicit cause (§7.5).
17. **What a body sees at an `unknown` position** (to `language-subset.md`
    and `execution-and-storage.md`). §2.2 records `shape` for a test of
    presence or kind at such a position and `identity` for a conversion to
    a string. *Assumed:* as today, the body is handed a reference there,
    whatever is stored behind it, so a kind test sees presence and no more,
    and the string a conversion yields is a function of the reference
    alone. If a kind test can see the stored kind, a position narrowed by
    it is read under the narrowed type, which §2.2 covers.
18. **The identity of an instance a computation makes** (to
    `plan-and-label-templates.md`). Met by §1.3 and §3.14 there: the
    enclosing instance, the body's `name` and `within`, the site, and the
    ordinal of the instantiation among those the evaluation makes at that
    site, or, with `.for(cause)`, that cause in place of the ordinal
    (§8.1). `BodyCall` records the first as `identifiedBy: "order"` and
    the second as `identifiedBy: "tag"`. The rule is an assumption there,
    pending the owner (open question 26 there).
19. **Four further forms of the record** (to
    `plan-and-label-templates.md`). Met by §1.1 there, form by form.
    - **A handle or a container that reached the body in a value the
      instance computed, where the body passes it on, binds it, writes
      through it, or resolves it:** its `identity` entry of
      `Body.computed`. `GivenReference` names it in
      `BodyOutput.reference`, `WriteEdge.reference`, `Binding.state`, and
      `Closure.params`. The `computed` variant of a `handle` target and of
      a `handle` envelope names it for a write. `ComputedReference` names
      it in a dynamic read of kind `link` or of kind `space` (§3.9, §3.10,
      §3.11, and §3.16 there; §3.8, §6.2, §6.5, §7.1, §7.2, §8.1, §8.4,
      and §8.5 here).
    - **The class of a copied path:** none is recorded in `Binding.state`
      or in `Closure.params`. The runtime narrows the copy by the bound
      handler's slots with root `binding`, or by the inline pattern's
      slots with root `params`. For a handler received as a factory value
      the copy holds the subtree the declared state type covers, as
      `value` (§3.14 and §3.15 there; §8.5 and §8.1 here).
    - **`shape` at a position of reference type:** a `shape` slot with
      `inPlace`, as at a position of handle type (§2.5 there; §7.2 here).
    - **The tier of a write through a handle from a computed input:** a
      write edge that names its handle by `computed` is a static
      side-write and does not make the body a materializer (§3.11 there;
      §6.2 and §6.3 here).
20. **Records that name a slot only** (to `plan-and-label-templates.md`).
    Met by §1.1 there, form by form. Each of five places of the record
    has a form for a body used with the input bound to a value the
    instance computed.
    - **`Child.callee` of kind `factory`,** for a factory value the body
      instantiates: a `GivenReference`, which names the factory's
      `identity` entry of `Body.computed` as `{ computed }` (§3.15 there,
      "A factory from a computed input"; §8.1).
    - **`Binding.handler` of kind `factory`,** for a handler factory value
      the body binds: a `GivenReference`, in the same way (§3.21 there,
      "A factory bound in a function body"; §8.5).
    - **The cell of a `SpaceRequest` target of kind `spaceOf`:** a
      `GivenReference`, in the same way (§3.14 there, "The values of an
      `inSpace` request"; §8.1).
    - **`RequestValue`,** for a target or an option of an `inSpace`
      request that is one projection: recorded as `body`. Where the
      projection is of an input bound to a slot root, the value is
      recorded as a slot of class `value`. It carries the
      body's template, which joins the entry's, and the record has no
      form that names the entry alone (§3.14 there; §8.1).
    - **A `handle` envelope for a handle the body found by a read through
      a handle from a computed input:** the `computed` variant names the
      first handle's entry of `Body.computed`, its `found` member holds
      the position of the found handle, and its `path` is at or below the
      cell the found handle links to, and not a path from the first
      handle's cell that crosses the link (§3.11 there; §6.2).
21. **The pure API functions** (to `language-subset.md` and
    `builtin-inventory.md`). Met for what a call observes: the inventory's
    table under "Pure functions and constants" and its entry for
    `uiVariant` give each function's observations, which §3.4 here
    follows, and `language-subset.md` §4.4.4 says in which tier each
    call is legal. *Assumed:* `getEntityId` of a container that carries a
    stored address returns the identifier of that address and reads no
    content. The inventory states the rule for a handle and a reference
    only (§3.4).
22. **A reference below the cut of a recursive type** (to
    `plan-and-label-templates.md` and the prototype). A `value` entry is
    accompanied by an `identity` entry at each position of handle,
    reference, or factory type in its subtree (§2.2). A path has no form
    for a position at any depth of a recursive type. *Assumed:* the
    entries reach to the cut W6 makes, and below it the argument holds
    nothing at such a position, so a body that reads a handle there
    computes from an argument that lacks it (§9.1). The prototype has to
    measure whether any body of the corpus reads a handle or a reference
    below a second entry into a recursive type.
23. **Six further forms of the record** (to
    `plan-and-label-templates.md`). Met by §1.1 there, form by form,
    apart from the last sentence of the last entry.
    - **`passes` names an entry whose path has no `*`,** and an entry
      whose path has one is named in `oneOf` (`BodyOutput.reference`;
      §3.8, §6.5, §8.5 here).
    - **A constraint on a path read through an entry of `Body.handles`
      or of `Body.computed`** lists that entry, and is evaluated on the
      journaled reads through the handle, or on the entry's template
      (`ConstraintInputs`, and §4.4 there; §7.3).
    - **`HandleReads.handle` of kind `call`** names an `instantiate` site
      of a body that is re-evaluated, an `instantiate` site that is
      `identifiedBy: "tag"`, or a `createCell` site that is
      `identifiedBy: "cause"` (§7.5).
    - **A cell created under a constant cause or the element key** is a
      `StateCell`, which the `createCell` site names in its `stateCell`
      member, and its initial value is a `WriteEdge` with target `state`
      (§3.14 there; §6.3, §8.2).
    - **The slot of a `RequestValue`** is of class `value` (§8.1).
    - **A reference found through a dynamic read** has no `reference`
      member, a write through such a handle is listed by an envelope, and
      such a container bound in a binding has `capture: "link"`, no
      `reference`, and the body's template (§3.9 there; §2.1, §3.8,
      §6.2, §8.5). *Assumed,* and not stated there: a projection of
      factory type that a body binds unchanged is bound as a reference
      at a position typed `unknown` is, so the body records `identity`
      and the binding holds the factory value (§8.5).
