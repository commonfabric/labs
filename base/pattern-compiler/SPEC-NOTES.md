# Notes on the specification

Places where
[`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
is ambiguous, says two things, or cannot be implemented as written, with the
reading this crate chose. Where the document leaves a choice, the reading is the
one that accepts less. The crate implements the document as it stands at commit
`8bc4a3001a`. A note that the document has since settled is removed, so the
numbers have gaps.

## The front end (§3 to §6)

1. **A runtime call at module scope whose callee is a value** (§3.2).
   `module-scope:runtime-call` covers instantiating a pattern and binding a
   handler. Where the callee names a definition the walk of `src/check` reports
   it, and where it does not, `module_scope_call` in `src/typed.rs` reports a
   call whose callee has a pattern factory or handler factory type. A callee
   with no type is not reported.
2. **An expression statement in tier R whose callee is not resolved** (§4.2).
   The document decides it by the callee's type. Chosen until types exist: a
   call of a local value or of an import the program does not hold is accepted.
3. **A computed key that names a module-scope constant** (§4.3). The key is
   static when the constant has a literal type. Chosen: a key rooted at a
   module-scope definition or an import is not reported, and any other key that
   is not a literal or a well-known key is `reactive:unsupported-expression`.
4. **A staged change through an authored function that tier R calls** (§5.2).
   `function-body:effect-in-computation` covers every effect such a function
   requests, so a staged change there needs no separate treatment. Nothing is
   open; the note records that the two cases share one report.
5. **`new` in a function that a frozen-data initializer runs** (§5.1).
   `function-body:constructor` is stated for tier F. Chosen: it is reported in
   an immediately invoked function and in a callback inside a frozen-data
   initializer too, and not in the initializer expression itself, where
   `new Map(...)` and a Fabric value class are the legal forms and any other
   `new` waits for the type rule of `module-scope:frozen-data-type`.
6. **A Fabric value class** (§4.4.4, §5.1). The document does not list the
   classes. Chosen: an import from `commonfabric` whose name begins with
   `Fabric`.
7. **Promotion where a type is not evaluated** (§6.1). The typed criterion reads
   the type of the receiver of each method call, of the accumulator of a
   `reduce`, of a computed key, and of an argument passed by name. The document
   does not say what a compiler does when it has no such type, because its
   checker types every expression. Chosen: the outcome of the syntactic
   criterion stands for that `computed`, and the call is counted as not decided
   by type.

## The type system (§7, §8)

14. **An intersection the document does not compute** (§7.4). Written in: an
    intersection with a handle, a factory, a function, or an opaque API type is
    `subset-type:empty-intersection`. Still open in the crate: an intersection
    with an operand it did not evaluate is not decided.
15. **`Default<V>` as a member of a union, and `DeepDefault<V>`** (§8.8,
    §7.6.1). The document says both follow the schema mapping and gives no rule
    of its own. Chosen: `T | Default<V>` has the value type `T`, the member is
    dropped when the type is resolved, and the union keeps the default
    annotation, which is what §7.6.1 asks about. `DeepDefault<V>` is an opaque
    named type here and does not count as declaring a default; the corpus does
    not use it.
16. **Label arguments** (§8.5). Decided after a reference to an alias is
    replaced by its body (`label_list_at` and `label_atom` in `src/types.rs`).
    Three things are not decided: a term that is a type parameter of a generic
    alias, which is written where the alias is used; an alias from a module the
    program does not hold; and the members of `WritePolicyAnyOf`, which the
    document says are not a label list and gives no rule for.
17. **What the crate does not evaluate.** `Pick` and `Omit` of a type that is
    not evaluated to one object type, an optional or rest element of a named
    tuple member, `keyof` of a type that is not an object type, an indexed
    access with a key that is not a literal, and a type from a module outside
    the program resolve to a type that is not evaluated. No rule refuses a
    program because of one, and every rule that reads one counts the site as not
    decided.
18. **`cfc-label:conflict`** (§8.4, §10.5). The entry names "a key other than
    `confidentiality`". Chosen: every annotation key the crate keeps, the
    default and the scope included, and `addIntegrity` although its name says it
    adds. Two annotations are compared where they are written around one type
    node, and not where an intersection brings them to one property.
19. **`cfc-policy-of` and `cfc-policy-authoring`** (§10.5). The catalog says "as
    the contract defines", and the contract is not part of the document. Chosen:
    `cfc-policy-of` is the condition §8.5 states for the argument of `PolicyOf`.
    `cfc-policy-authoring` is the one condition §4.4.4 states, a rule
    declaration outside the initializer of an exported module-scope constant.
    What the contract requires of the rules themselves is not checked.

## The corpus (§11)

8. **The corpus has moved.** §11 was measured at commit `47776e6c9c`, with 425
   modules. `patterns/` at the commit this crate is on has 426, after a merge of
   the main branch. Run on the tree of the measured commit, the crate's counts
   differ from §11 only in the rows the notes below explain.
9. **`.get()` in the pattern body** (§11.4): 68 against 66. The two the crate
   does not count are inside the two immediately invoked functions of
   `patterns/dev/gideon-tests/test-helper-owned-jsx-iife-captures.tsx`, which
   are refused, so their content is not tier-R code.
10. **`map` callbacks in the pattern body** (§11.4): 326 against 325. The one
    the crate does not count is `.map(toMentionable)`, which has no callback
    body.
11. **Per-element bodies over plain values** (§11.3). The ruling of 2026-11-13
    limits `collection:shared-element-state` to a state cell. No callback in the
    corpus declares one, so the crate reports none, where §11.3 as it stands
    counts 7 handler bindings.
12. **The split of the promotion table** (§11.5). The totals agree: 1,369
    promoted, 109 not, 15 in statement position. The crate counts a body under
    "guard" whenever it uses a guard, and a collection callback with a statement
    body as a disqualifying expression, so the rows differ by a few calls each.

## The rulings of 2026-11-13, and inference

20. **The warning for an instantiation without a cause** (§5.2, question 26).
    Written in. The crate reports it in a `lift`, a `computed`, an `assert`, and
    an authored function one of them or tier R calls. A nested function counts
    as a callback whatever it is passed to.
21. **A state cell declared by a pattern called in a per-element body**
    (§4.4.1). The document counts a state cell of a statically resolved pattern
    called in the body as a state cell of the body. The crate does not look into
    the called pattern, so it does not report that case.
22. **A call of an overloaded function** (§7.9). Overloads are refused, and a
    call of one still has to have a type for the code around it. Chosen: the
    result type of the first signature.
23. **The parameter types of a function written in place** (§7.6). A function
    type keeps its parameter types and its result type. A function written in
    place takes the types of its parameters from their annotations, from the
    function type its callee declares for the argument, or from the annotation
    of the binding it initializes. In any other position, such as a property of
    an object literal or a returned value, a parameter without an annotation has
    no type in the function's own type, and the parameter is counted as untyped.
24. **Generic functions** (§7.3). The document specifies first-order unification
    and one check of the body per instantiation. The crate binds a type
    parameter from a written type argument, or from the argument whose parameter
    is the type parameter, an array of it, or a handle of it, and checks the
    body once with its parameters unbound. So
    `subset-type:cannot-infer-type-argument` is reported only where no parameter
    given an argument names the type parameter, and a parameter an argument
    names in another form is counted as not decided.
25. **Built-ins whose result the crate types.** `wish`, `fetchJson`,
    `fetchJsonUnchecked`, and `generateObject` have the result
    `{ pending: boolean; result: T | undefined }` with `T` the written type
    argument, and `generateText` and `fetchText` the same with `string`. The
    declarations in `base/api/index.ts` have more fields. The crate does not
    read them, so any other field of such a result has a type that is not
    evaluated. The other effectful built-ins have no signature here.
26. **Iterators of `Map` and `Set`** (§9.9). `keys()`, `values()`, and
    `entries()` are given array types, which is enough for spread, `for...of`,
    and `Array.from`, and wrong for a method called on the iterator itself.

## Assignability (§7.5, §7.5.1, §7.5.2)

49. **API types the crate does not read** (§7.2). `VNode` is opaque, and
    `JSONValue` and `JSONSchema` are structural, as the document states. Every
    other type `commonfabric` exports that is not a constructor of §7.2, such as
    a built-in's parameter type, is an ordinary object type whose declaration
    the crate does not read. Chosen: nothing is decided against one.
50. **Where the expected type is carried** (§7.5, §7.3). The crate carries the
    expected type into the callback of `map` and `flatMap`, into a `computed`,
    into a function written where a function type is expected, and into the one
    callback of an authored generic function whose result type is a type
    parameter `U` or `U[]` and whose callback is declared to return `U`. For any
    other form of result type, such as `Box<U>` or a union, the expected type is
    not carried, and the call is typed from its arguments alone.

## Narrowing and data positions (§7.6, §7.8)

52. **Narrowing** (§7.6). Implemented for every test the section lists. The type
    of a `let` at a reference is a join that is computed, and it is
    over-approximated: it is taken over every assignment written between the
    last assignment that definitely runs before the reference and the reference
    itself, whether or not each of them can reach it. A binding assigned in
    another function than the one that reads it is not narrowed. Three cases
    narrow less than TypeScript does: the `default` case of a `switch`, a case
    another case can fall into, and a path such as `order.note` of a binding
    that is assigned. One case narrows more than it should: a path stays
    narrowed after an assignment to that path. A type that a condition would
    narrow to `never` is left as it was. An optional chain that is truthy, is
    compared with a value that is never absent, or is not `undefined`, narrows
    each receiver it tests and the path it reads.
53. **Which expressions are data positions** (§7.8). As the section lists them.
    One reading was chosen: a `const` whose initializer is an operator or a call
    other than `get()` and `sample()` is an ordinary value, as the section says
    of the expression itself.
54. **The type names of the browser** (§7.10). The list is the interface and
    type-alias names of `lib.dom.d.ts` of TypeScript 6.0.3, the version the
    repository pins (`src/dom-names.txt`, 1,795 names). The document does not
    say which version of the library, and the names of `lib.webworker.d.ts` and
    of the other libraries are not in the list.
55. **The parts of §7 the crate does not apply.** Assignability is applied at an
    argument, an attribute of a tag that names a pattern, a returned value, and
    an initializer, and not at an assignment, a property of an object literal
    outside those sites, or an argument of a handle method such as `set`,
    `push`, or `send`. `e as T` is not tested for relatedness unless it goes
    through `unknown`, and `e satisfies T` is not checked (§7.7). A generic
    function is not checked per instantiation; a property read on a type
    parameter reads its constraint (§7.3). The predicate of `isWellFormedDID` is
    the one built-in predicate the crate knows.

## The second round of corrections (the document at `8bc4a3001a`)

57. **A default on a type that names `undefined`** (§7.6.1). The table gives the
    read "the value type, without `undefined`", and `RequireDefaults` in the
    published typings removes `undefined` from the property's type. Chosen: the
    crate removes the `undefined` that the `?` adds and keeps one the type
    itself names, so `glaze?: Default<string | undefined, "plain">` is read as
    `string | undefined`.
58. **Which input types the rule of §7.6.1 reaches.** The rule is stated for
    "the properties of the input type of a `pattern`". Chosen: it is applied
    where the input type resolves to one object type, an intersection included,
    and not where it is a union of object types or is not evaluated.
59. **A value where `AnyCell` is declared, bound by reference** (§7.5.2). The
    second row of the table lists the six cell kinds a value stands for, and
    `AnyCell` is not one of them. §7.2 calls it "a handle of a kind the type
    does not state". Chosen: a value is refused where an `AnyCell` is declared,
    in tier R too.
60. **`key` on an optional property that is not a handle** (§4.7). "A `?` on the
    property does not change the result" is written after the flattening rule
    and reads as general. Chosen: `key("a")` on a `Cell<{ a?: Cell<T> }>` is the
    `Cell<T>`, and on a `Cell<{ a?: string }>` it stays a
    `Cell<string | undefined>`, because a `Cell<string>` there would let `get()`
    return a `string` where nothing is stored (question 12).
61. **`"k" in x` on a union with `object`** (§7.6). The section gives the rule
    for a union of object types and for `object` alone. Chosen: in
    `object | null`, which `typeof x === "object"` gives, the true branch drops
    `null` and adds the property to `object`. On a data position typed with an
    object type that does not declare `k`, nothing is added, as on one typed
    `unknown` or `object`.
62. **An attribute of a pattern tag in a function body** (§7.5.3). The section
    names "a pattern instantiated in a function body". Chosen: a JSX tag that
    names a pattern there is one, and its attributes are checked as the argument
    is.

## Footprint analysis (`footprint-analysis.md`, cited as FA)

64. **What of FA the crate implements.** The abstract values of §2.1, the
    classes `value`, `shape`, `enumeration`, and `identity` of §2.2, the normal
    form of §2.3, the transfer rules of §3.1 to §3.3 and §3.5 to §3.8, the
    array, object, `JSON`, `Map`, `Set`, and `console` rows of §3.4, the causes
    W1 to W5 of §5.2, the reads and the writes through handles of §6.1, §6.2,
    §7.1, and §7.2, and the read envelope of §7.3 as the entries below a dynamic
    hop. Notes 76 to 85 say what of §6.3 to §6.6, §7.1 ("Resolutions"), §8,
    `Body.outputs`, and W6 is implemented. Not implemented: `Body.computed`
    (note 85), the templates of written values (§6.5), the `identity` entries
    that accompany a `value` entry, and the `sampled` mark of §2.3.
65. **A summary is applied by evaluating the callee again** (FA §3.6). FA
    computes one summary per function and applies it at each call. The crate
    evaluates the callee's body at each call with the arguments' abstract values
    bound, which gives the same record where the callee does not call itself. A
    function that is being evaluated, and a call nested more than eight deep, is
    not followed: each argument that is a projection is read in full, and the
    site is counted as W7. FA's fixed point over a group of recursive functions
    is not computed. W6 is implemented as note 79 has it.
66. **Control flow** (FA §3.7). The environment is not joined on the
    control-flow graph. An assignment under a condition joins the old and the
    new value of the binding, a loop body is evaluated twice, and a `break` or a
    `continue` changes nothing. A `let` captured by a closure holds what was
    assigned before the closure is evaluated, and not the join over the body.
67. **An index into an array that is a literal** (FA §3.1). The first row of the
    table extends the path by a static key, `v[0]` included, and the third row
    gives `v[i]` on an array the path `v/*`. Chosen: an index into an array type
    is `v/*` with `enumeration` at `v` whatever the index is, and a literal
    index extends the path on a tuple type alone.
68. **The `identity` entries that accompany a `value` entry** (FA §2.2) are not
    emitted. A `value` entry over a container stands for its subtree, and the
    positions of handle, reference, and factory type inside it have no entry of
    their own.
69. **A test the type decides** (FA §2.2). FA states the rule for `typeof name`
    and for `donut?.glaze`. Chosen: a test of presence is decided where the type
    admits neither `null` nor `undefined`; a kind test where the type is of one
    kind, admits neither, and is not `unknown`; a test of truthiness of a
    container, a handle, or a reference under the same condition. A test of
    truthiness of a scalar is never decided.
70. **A truthiness test of a union** (FA §2.2, §2.3). "A test of truthiness on
    `string | Donut` records `value` and `shape`", and the normal form of §2.3
    removes a `shape` entry at the path of a `value` entry. So the record of
    such a body has `value` alone at the path, which by §2.2 covers the subtree
    of the `Donut`. FA does not say whether that is meant, or whether the
    `value` of a union position is the value of its scalar members alone.
71. **A member of a built value that leaves the body** (FA §3.8). The table
    decides by the member's type. A member the body put into a record earlier
    has no expression at the place where the record leaves. Chosen: an object
    literal written at that place is taken apart member by member, and any other
    built value records `identity` at each projection it holds, unless the body
    has a `value` entry there.
72. **An expression that has no type** (FA §1.3). FA takes every expression as
    typed. Where the checker has none, the crate takes the position as a scalar,
    records `value`, and counts the observation
    (`footprint:observations of an expression with no type`, 604 in the corpus).
    A receiver with no type is taken as a handle where the call is one only a
    handle has: `get()`, `sample()`, `resolveAsCell()`, `key(k)`, `set(v)` with
    one argument, and five more writers.
73. **The rest of an object** (FA §3.1). `const { a, ...rest } = v` binds `rest`
    to a record that holds a spread of `v`, so `rest.a` reads `v.a` where the
    document gives a record without `a`. The type checker refuses such a read,
    so the difference shows in no accepted program.
74. **Which bodies** (FA §1.2). A function nested in a body is part of the body
    where it is a closure, and is a body of its own where the front end records
    one: an inline event handler, an `action`, a `computed`. The measurement
    counts a site once, for the innermost body around it. A `computed` is a body
    where the typed promotion criterion does not promote it, which FA §11
    decides by syntax.
75. **The declared type of an argument bound by reference** (LS §7.5.2, ruling
    "An argument bound by reference takes the declared type of its path"). The
    crate takes the declared type at the outermost step of the path alone: for
    `order.note.text` it reads the declared type of `text` in the type the
    checker has for `order.note`, which a condition on `order` or on
    `order.note` may have narrowed.

## The rest of footprint analysis (FA §6.3 to §6.6, §7.1, §8)

76. **The `cause` entries** (FA §8.4). §12.3 lists `cause principal :
    value`
    and no document names the entry `eventKey()` records. Chosen:
    `cause.principal` and `cause.eventKey`, each of class `value`.
77. **A static resolution** (FA §7.1). The relaxation for "a call that is
    conditional only on the operand being present" is applied where the test is
    the optional chain of the call itself, `p?.resolveAsCell()`, and not where
    an `if` around the call tests the operand. A use of the handle a static
    resolution returned records the resolved entry and no plain one beside it,
    as §12.3 lists `state.myProfile`. `writtenPrincipalOf`, which the table of
    §8.4 does not list, is recorded as `principalOf` is.
78. **A dynamic read of kind `space` or `link` is listed by its entries** and
    not as a record of the plan. The crate lists, per resolution that is
    journaled, the entries it starts from, and one line `labelMetadata` where
    any observation of label metadata is journaled.
79. **W6 follows the checker's cut** (FA §5.2). The checker's type of a
    recursive type is cut at the first use of the type inside itself. The
    analysis widens at a property read on a value whose type is the cut, reached
    through a value whose type is the cut: the second time the path enters the
    type. The widened entry is at the path with its trailing `*` removed, as the
    example of §5.2 has it (`box/children/*/children`). A destructuring and an
    element access with a key are not counted as entering the type.
80. **`Body.outputs`** (FA §3.8). A projection at a result path is a reference
    where the record has an `identity` entry at it, as note 71 decides it for a
    member with no expression. A bag the body built gives `path/* : oneOf` and
    its entries. `required` is not recorded, and an entry is named by its path,
    since the `{ computed }` form needs the use (note 85). A handle a static
    resolution returned is named by its path, and not told apart from the plain
    entry.
81. **An authored function has no tier** (FA §6.3, §8). FA holds an authored
    function to the rules of the bodies that call it, and the crate does not
    know which tier calls one. Chosen: its own record has no tier, no shape of
    §6.6, and no `read-then-push`. A write in it whose target is not static does
    make a computation that calls it a materializer, and the hint is then
    reported at no site, because the site is outside the computation's text.
82. **`mergeable-push:read-then-push`** (LS §10.3). The condition is "a handler
    reads a mergeable collection and then pushes to it". Chosen: a `push`,
    `pushAll`, or `addUnique` in a `handler`, an `action`, or an inline event
    handler, through a handle whose cell the body read with `get()` or
    `sample()` earlier in the order of evaluation, at the path pushed to, above
    it, or below it. Whether the pushed value depends on the read is not
    decided.
83. **Which runtime calls are sites** (FA §8). Recorded: a call of a pattern or
    of a handler the module resolves by name, `.for(tag)` on such an
    instantiation, `X.of(value)` and `X.for(cause)` with the three scopes,
    `action(...)`, and the effect built-ins. Not recorded: a call of a factory
    value held in an input, an inline event handler in JSX the body builds,
    `new X(value)`, `inSpace` and `asScope`, the schema and scope of a created
    cell, the `{ call }` entry of `Body.handles` for a read through what a site
    returned, and the write edges of an argument or a request. A binding copies
    by the handler's footprint in FA §8.5; the crate applies the reference rule
    of §3.8 to the state whatever the handler reads of it.
84. **A constant cause** (FA §8.2) is a literal, a template with no
    substitution, or a name whose value comes from no input and is not computed
    in the body. The element of an enclosing element body is not recognized as
    the element key, so a cell created under it counts as created under data.
85. **`Body.computed` was not implemented** when this note was written; note 86
    has what is. (FA §1.1). The record is per body. The split of the entries
    into `reads` and `computed` needs, for each use, what each formal input is
    bound to, which `origin_of_place` in `assign.rs` classifies for an argument
    of tier R and no pass yet joins with the record. Until then every entry is
    listed under `reads`, and the rules that journal a read, a resolution, or an
    observation "whatever the conditions say" for a computed input are not
    applied.

## Completing the record, and the first slice of plan emission

86. **`Body.computed`** (FA §1.1, §7.2, §8.4). `bind_use` gives the record of
    one use: the entries on an input bound to a value the instance computed are
    entries of `computed`, a read through a handle from such an input moves into
    the envelope of a handle entry that names the handle's `identity` entry of
    `computed`, a resolved entry becomes a plain one with a dynamic read of kind
    `link`, and an observation of label metadata is journaled. What an input is
    bound to is decided by the plan emitter, which follows a place to its root
    and path. `origin_of_place` in `assign.rs` names the kind of a place and not
    its path, so the emitter does not use it. A record written in the reactive
    tier binds each member on its own: an entry below a member that is a slot is
    a slot. FA does not say this.
87. **`Body.handles`** (FA §7.2, PL §3.9). A handle found below a hop whose read
    is dynamic has no entry of its own. It is counted under the listed handle it
    was found through, and where the analysis has no such handle, under the
    position before the first hop. A read through what a site returned is
    `get()`, `sample()`, or a property read, and the site is an entry where it
    is `instantiate` by tag, `instantiate` in a body that is evaluated again, or
    `createCell` under a cause.
88. **Write edges** (FA §6.5). `push`, `pushAll` and `addUnique` write at `*`
    below the cell. PL §6.2 lists `w0`, a `push`, at `*`, and `w4`, an
    `addUnique`, with no path; the crate gives both `*`. FA does not say what a
    path holds where the written record is one of several the body built, or has
    a record spread into it on some runs. Chosen: the path is an edge that names
    the references of all alternatives as `oneOf`, since the runtime verifies a
    reference by identity. `new X(value)` on a cell constructor is a
    `createCell` site by order, which note 83 said was not recorded, and PL §6.2
    lists it as `n0`.
89. **What a copy holds** (FA §8.5). The crate analyzes the bound handler at the
    bind site. A member of a record written at the site is a scalar by its type.
    A value an `action` or an inline handler captures has no expression at the
    site, and is taken as a scalar where the handler has a `value` or `shape`
    entry at its root and none below. A handler received as a factory value is
    not handled. The `Binding` of a `bind` site of a body is not filled in, and
    the plan lists such a site as unsupported.
90. **What the first slice of the plan leaves out** (PL §1.1). Every member that
    holds a `Template`, a `Hash`, or a `Constraint`, and so `Slot.schema`,
    `Body.code`, `HandleReads.envelope`, `Child.callee` and its schemas,
    `Cone.code`, `Collection.membership`, `Operation.input`; and
    `Slot.declared`, `Slot.sampled`, `BodyOutput.required`, `Output.scope`,
    `Operation.scope`, the records of `Body.widenings`,
    `Collection.bodyUses.child`, and `Plan.closures`. `constraints` is empty
    everywhere. `Binding.state` has a member `bound` that PL does not define, in
    the place of `template`: the slot, the output, the binding whose stream it
    is, or that it is a constant.
91. **Cones** (PL §1.4). PL leaves the partition to the compiler. Chosen: one
    cone for each declaration of the reactive tier that computes, with
    everything nested in its expression; one for a JSX tree; one for the body of
    an element construct; and one named `result` for the inputs the result
    passes through. `Cone.entry` is the name of the declaration. A slot that
    expression code reads is of class `value` where an operator, a condition, or
    a method of a scalar consumes it, and `identity` where it is passed on. PL
    decides the class by the template, which this slice does not build. PL §6.2
    says the listing leaves out one `shape` slot at a data position,
    `event target`. The crate has a second, `event attachments`.
92. **Names** (PL §1.3). PL does not give the form of a name with its ordinal.
    Chosen: `name#1`, `name#2`. The key `[UI]` of a result is the segment `$UI`.
    A value assigned to no `const` takes the name of the property or the
    attribute it is written at. A child or a state cell a body creates is named
    by the body's name and the number of the site. `ComputedInput.at` starts
    with the name of the formal input for a function and for what a `computed`
    captures, and not for a `lift`, whose argument is its one parameter.
93. **`Slot.inPlace`** (PL §1.1). The member is for a `shape` slot at a position
    of handle or reference type. The crate sets it where the same body has an
    `identity` entry at the same path, and does not ask the type.
94. **`side-write:cycle`** (LS §10.3, FA §6.3). An edge of a static side-write
    goes to each cone with a slot of the same root whose path overlaps the
    written path and that is not the `identity` slot of the handle itself. For a
    handle that is a state cell the edge is of kind `state`, and the write
    target stays of kind `handle`, since the body names it by a slot. The
    warning is reported at the function of the writing body, for each side-write
    whose target cone reaches its own cone. An edge from a cone to itself is in
    the plan and is not reported. A write through a handle from a computed input
    has no edge (FA §6.3), and a handler is no cone.
95. **A pattern called in the reactive tier** (PL §1.1, §1.3) is compiled into
    the plan under a `site` step, at most eight deep. Its argument is bound
    place by place, so a slot of the callee is a slot of the caller.
96. **A dynamic key in the reactive tier** (PL §3.18) is an entry of
    `Plan.picks` with `chosenBy: "valueCode"`, and for a container that is a
    slot the cone has a `value` slot at `*` below it.
97. **What the emitter does not translate** is listed per plan by kind, and
    `plan --corpus` counts it: `wish`, the context reads and the remaining
    built-ins in the reactive tier, a collection method with a callback other
    than `map`, `filter`, and `flatMap`, an element construct over a constant, a
    spread in the reactive tier, a dynamic read of kind `space`, and a call of a
    name it does not resolve.

## Bringing the crate in line with the documents, and more of the plan

98. **What a called function brings into a body** (FA §3.6, "A summary has no
    tier"). The crate reports a dynamic read, a widening, a write with no static
    target, a write that is not idempotent, and a read and a push at the call in
    the body's text, with the position inside the function in the message. "The
    call" is the innermost call written in the body's text whose evaluation
    reached the site, so for `f(g(x))` what `g` does is reported at `g(x)`. One
    call is reported once per diagnostic, whatever the number of sites behind
    it. FA does not say whether the function's own record still reports a
    widening or a dynamic read at the site inside it; the crate reports both, so
    a widening in a helper is a hint at the helper and at each call.
99. **A bag whose member joins a `Computed` value with projections** (FA §3.8)
    cannot be told from a bag of the projections alone, because the join of
    abstract values drops `Computed`. Such a bag gets an entry. A bag of one
    projection whose path has no `*` gives `passes`.
100. **A constant cause** (FA §8.2). The conditional operator counts as an
     operator over constants, and so does a logical one. A module-scope `const`
     whose initializer is a call, a member access, or an object is not constant,
     and neither is a name a destructuring binds. This replaces note 84.
101. **W6 and a destructuring with no type** (FA §5.2). A destructuring in a
     declaration or in a `for...of` has the type of its initializer. A
     destructuring in a parameter list has none, and counts as entering a
     recursive type only where the value was reached through one already. This
     replaces the last sentence of note 79.
102. **`mergeable-push:read-then-push`** follows LS §10.3 and question 36 as
     assumed: `push` and `pushAll`, any earlier read of the list. This replaces
     note 82.
103. **The catalog table** (LS §10). §10 now has a second table whose rows start
     with an identifier, "What a diagnostic is computed from". The catalog test
     takes a row as a catalog entry only where its second cell is a severity or
     `—`.
104. **PL §6.2 against the crate, `B1` to `B4`.** Four differences. (a) `B1`
     reads `threadInfo?.get()`, which FA §7.1 makes static, so the crate has the
     slot `threadInfo : value` and no handle, where the listing has
     `handles h0 slot s2`. (b) `B2` has `titles/* : identity` where the listing
     has `value`, by note 71: the title leaves in a record a helper built, which
     has no expression to take a type from. (c) `B4` lists `identity` beside
     `identity, resolved`. (d) The source calls `threadTitles`, `bodyText` and
     `viewKeyOf` more than once, so their uses have ordinals.
105. **A pattern used as a JSX tag** (PL §1.1, §6.2). The listing has the row's
     slots at the root `element`, so the row is compiled into the room. The
     crate compiles in a pattern that is called, and gives a pattern used as a
     tag a plan of its own, with its attributes passed by reference. No document
     says that a tag is a call for this purpose.
106. **`wish` is not planned** (PL §3.19, BI "`wish`"). PL gives the templates
     of four parts and says a constant query tells them apart. Three things are
     missing for a record. No document has the table from a query to its part
     (`#profile`, `#now`, `#now/300`, a path). A path or a well-known target is
     "a reference", and `SlotRoot` has no root for it; a read through it in the
     reactive tier would be a `dynamic` node of kind `link`, whose `through` is
     a slot or an entry of a body's `computed`, and expression code is neither.
     A search is a `DynamicReads` of kind `search`, which names a body.
107. **A scan** (PL §3.13, §1.1). PL gives the templates of `some`, `every`,
     `findIndex` and `find` and not their records. Chosen: a `Collection` of its
     own, named as the construct is, whose source is the receiver (a slot, or an
     output, the assembled output for a receiver that is a collection, because
     `via` has no value for a scan); the predicate as the cone of its body,
     whose result is read for `value`; a `Selector` of arity 0 for the
     `through`; for `find` a `Pick` with `chosenBy: "runtime"`; and an `Output`
     with the member `collection`, as for an assembled result, since the runtime
     produces the value. The selector and the pick are in no `Cone.selectors` or
     `Cone.picks`, because no value function reports them. PL does not say which
     cone lists them. `reduce` stays unsupported: PL makes it an `Operation` of
     kind `reduce`, and `Operation.implementation` has no form for an
     expression.
108. **An array written in the reactive tier as the source of a collection** (PL
     §1.1, `Collection.source`). `[a, b].map(...)` and `["x", "y"].map(...)`
     have no slot. Chosen: the array is "an array the instance computed", made
     by a cone of its own that passes each member by reference, and the source
     is its output. For an array of constants that cone has no slot. A
     collection over a path of a computed value, as `facts.main`, has an interim
     output at that path beside the output of the whole value.
109. **Context reads and library calls in the reactive tier** (PL §3.16).
     `spaceOf`, `equals`, `principalOf`, `principalsOf`, `profileOwnerOf`,
     `spaceAccess`, `spaceAccessOf`, `spaceMembers`, `spaceDeleted`, and
     `linksOf` have the slots of the table, in a cone of expression code.
     `a.equals(b)`, `X.equals(a, b)` and `equalLinks` are the method forms (LS
     §4.7). A dynamic read of kind `space` whose operand is a value the instance
     computed is unsupported in the reactive tier: `of` would name an entry of a
     body's `computed`, and there is no body. The debug strings and a call of a
     global function such as `String` are expression code that reads each
     operand for `value`. `writtenPrincipalOf` and `resultOwnerOf` in the
     reactive tier stay unsupported.
110. **A pattern that is a default export** has no name in its module. Compiled
     in, its site takes the name of the `const` the call is assigned to, as any
     call does (PL §1.3). The offsets of the unsupported constructs of a pattern
     compiled in from another module are offsets in that module, and the plan
     lists them without the module.
111. **The `Binding` of a `bind` site of a body** (PL §1.1, FA §8.5) is filled
     in: the handler is a body of the plan, and each path of its state is `copy`
     or `link`, with the reference a linked path holds where the binding body
     was given it. This replaces the last two sentences of note 89. A path the
     body copies from a value it computed has no `template` yet. A handle or a
     link the body made at a site is `link` with no `reference`, because
     `reference` names only what the body was given. A binding of a handler
     received as a factory value is still unsupported.
112. **The first templates** (PL §1.1 `Template`, §3.3, §3.9, §3.19). Built:
     `const`; `slot`; `derive` by expression code for a binary or unary operator
     and a template literal, over the templates of its operands in source order;
     `derive` by a body, over the slots of `Body.reads`, the templates of its
     computed inputs, each once, and a `dynamic` node for each entry of
     `Plan.dynamicReads` the use made, as `T_send` lists them; and the template
     of a promoted `computed` whose body is one expression, which is that
     expression's. A path of a value has the value's template (§3.3, for one
     opaque call). They are on `Output.template` and `ComputedInput.template`,
     and are left out where an operand has none: a `select`, a `pick`, a `fold`,
     a collection, a method call, JSX, and a record written in place are not
     built. A constant operand is one `const` node each time it is written; PL
     does not say whether inputs are a set. `WriteEdge.template`,
     `Operation.input`, `Collection.membership`, and `Binding.state.template`
     are not filled in.

## The crate against PL as corrected from notes 86 to 97

113. **Whose names are counted together** (PL §1.3). "Two bindings of a handler
     `save` are `save#1` and `save#2`", and the handler is a body named `save`
     too. Chosen: the names of `Plan.bodies` are counted apart from the names of
     the other records, so a handler is not one more declaration of the name its
     bindings have. PL lists `Body` among the records that hold a name and does
     not say this. A hint that is the property or the JSX attribute an
     expression is written at is the fallback only: a call of a pattern, a use
     of a body, a collection, an effect, and a binding of a named handler take
     their base name before it. A state cell has no base name in PL's list, and
     takes the property's name. A child or a state cell that a site of a body
     makes is named after the ordinals are given, so it is `make#1/n0`. A state
     cell a body creates under a constant cause is still named `body/nK` and not
     `body/cause`: the footprint record does not keep the cause.
114. **PL §6.2 as corrected, against the crate.** This replaces note 104. The
     listing and the crate agree on the slots `e0` to `e8` and `b0` to `b4`, the
     handles of `B0`, `n0`, the writes `w0` to `w7`, the envelope, the binding,
     `m4` in place, and that the result of `B1` and the conditions of `T_edited`
     and `T_label` are no outputs. What differs: (a) `B1` reads
     `threadInfo?.get()`, which FA §7.1 makes static, so the crate has
     `threadInfo : value` and no handle, where the listing has
     `handles h0 slot s2`, and `T_titles` has no `dynamic` node. (b) `B2` has
     `messages : value` and `messages/* : identity` beside `s0`, and its
     computed input is `titles/* : identity` with `titles : enumeration`, where
     the listing has `titles/* : value` (notes 71, 104). (c) `B4` lists the
     plain `identity` slot beside `identity, resolved`. (d) `threadTitles`,
     `bodyText` and `viewKeyOf` are used more than once, so their uses have
     ordinals. (e) The row is a pattern used as a JSX tag, which the crate does
     not compile in (note 105), so `m0` to `m6` have the root `argument` and the
     path `message` in a plan of the row's own, `m1` is absent, `c1` has no body
     in the room's plan, and `facts.places` is no output of the room. (f) The
     source declares the row's key inside the `computed` of `replies`, so the
     crate has no cone `key`: `B4` and the pick are in the cone `replies`. (g)
     The crate has three more `shape` slots in place than the listing names
     "among them": `binding threadInfo`, `event attachments/*`. (h) `isEdited`
     reads `editedAt` and `body` for `value` where the listing has `m5` and `m3`
     for `shape`, until expression code takes its class from the kind of test.
115. **`Slot.inPlace` by type** (PL §1.1, §2.5). This replaces note 93. A
     position is of handle type or of reference type where the body uses a
     handle there, or where a test of truthiness, of presence, or of kind is
     made on an expression whose static type is a handle or `unknown` and no
     container or scalar. A `shape` entry from a destructuring default, a
     spread, `in`, or `Object.hasOwn` has no expression of the position, and is
     in place only by the first rule.
116. **Which slots read a `handle` target** (PL §3.11). This replaces the rule
     of note 94. `Slot.schema` is not emitted, so the type a `value` slot above
     the handle has at the handle's position is the declared type of the reading
     body's formal input there. Expression code, a `computed` that is a body,
     and a parameter that is a destructuring give no type, and the slot then
     counts as a reader. A position of type `unknown` stops the read, as a
     handle type does. Of the `identity` slots at the handle's own position the
     plain one and the one the target names are excepted, and a resolved one the
     target does not name is not. "No slot is excepted" for a state target is
     taken literally, so the cone that writes a state cell has an edge to itself
     through its own `identity` slot of the cell, and is reported unless the
     body reads its own target. The corpus has 9 reports of `side-write:cycle`
     where it had none, 2 of them in accepted modules, and the plans of the
     accepted modules have 41 edges through a side-write (20 before). Most of
     the 9 are an edge from a cone to itself through a state cell or a handle
     that the body writes and does not read.
117. **`side-write:cycle` names the side-write** where the write is in the
     module of the pattern, and the function where it is in another module. One
     site is reported once, whatever the number of cones it is on a cycle with.
     An authored function used in the reactive tier has no tier of its own (FA
     §6.3): it counts as a computation with static side-writes where each of its
     writes has a static target, and whether a write reads its own target is
     recorded for it too.
118. **`Binding.state.place`** (PL §1.1). A path of a value the instance
     computed resolves to an interim output at that path. A constant is held as
     its value where it is a literal written at the binding, and as `null` where
     it is a name of a constant or `undefined`, which the emitter does not
     evaluate. The stream of another binding has the template `const`: PL gives
     the template for a slot, an output, and a constant, and the stream of a
     binding of the reactive tier is named by constants of the plan (§3.14). A
     path bound to the index of an element has neither `place` nor `template`:
     PL has no place for it.
119. **The cones of an element body** (PL §1.4, question 44). PL states the
     partition "the prototype emits" as one cone for each declaration in the
     callback that computes and one for the returned expression. The crate emits
     one cone for the whole callback (note 91), and a declaration inside a
     promoted `computed` with a statement body is in the cone of that
     `computed`. Not changed in this slice.

## Label templates, second slice

120. **The class expression code reads a slot for** (PL §3.5, §6.2). This adds
     to note 91. A condition is read for `value` where its static type is a
     scalar and for `shape` where it is a record, an array, a handle, or
     `unknown`. A test against `undefined` or `null` reads the other operand for
     `shape`, and so does `typeof`, as the listing's `m5` and `m3` are. `a?.b`
     reads `a` for `shape`, and that observation joins the template of the
     expression code around it, as `m0` joins `T_isSet`. PL states the class of
     a condition and not of these three.
121. **`select`** (PL §3.5). `??` tests presence, so its condition is read for
     `shape`. The branch that is the condition is the same operand read for
     `identity`. `ifElse`, `when`, and `unless` are the operation of `?:`, `&&`,
     and `||`. An `if` of a promoted `computed` with a statement body is a
     `select` over what its two paths return, and a path that returns nothing
     returns a constant. PL does not say this of a statement. A dynamic key on a
     record written in place is a `select` over its keys, as §3.18 says, with
     one more branch, `const`, for a key that names no member: PL gives the
     label of a missing key for a `pick` and not for this `select`.
122. **A join** (PL §3.2). `Template` has no node for a join, and PL writes
     "joined with" for the choice of a `pick` and for the membership of a
     `filter`, a `flatMap`, and a scan. Chosen: `derive` by expression code over
     the joined templates. Its confidentiality is the join. Its integrity is the
     meet with `TransformedBy`, which PL does not say of a membership.
123. **`pick` over a container slot** (PL §3.18). The child slots are the
     `shape` slot at `a/*`, which `choice` joins and `from` names, and one
     `value` slot at `a/*` as the body. PL has the path the surrounding
     expression reads below the child with the class of that read; the crate
     reads the whole child.
124. **`fold` and the membership of a derived collection** (PL §3.2, §3.7,
     §1.1). The crate has one `Collection` for one element construct, and for a
     `filter` directly over a slot there is no second record for "the source".
     Chosen: `fold.collection` names the construct's own record, whose element
     slots the body is over, and the membership that §3.2 joins into a `fold` is
     that of what the construct iterates, which the template also names beside
     the `fold`. PL does not say whether `Collection.source.via` is the method
     that made the source or the one applied to it; the crate keeps the second.
     The assembled output of a scan has the member `collection` (note 107) and
     the template of the scan's value, not the membership.
125. **Per-element outputs** (PL §1.4). A `map`, a `filter`, and a `flatMap`
     have one entry at the path of the collection followed by `*`, beside the
     assembled entry, with the template of an element. An output of a cone
     inside the body that only the body uses has no entry.
126. **A constructed value used as one value** has no template: a record or an
     array written in place and a rendered tree have a template per path (PL
     §3.4), and `Template` has no node for one where it is the branch of a
     `select`, the element of a `map`, or the value of a promoted `computed`. PL
     does not give the paths below `$UI` either, so the output of a rendered
     tree is one entry with no template. Of the 2630 outputs of the plans
     emitted with no unsupported construct, 1751 have a template, and 25 of 319
     plans have one on every output. Nearly all the rest are rendered trees and
     records.
127. **The template of a write edge, of an operation, and of a binding** (PL
     §3.11, §3.14, §1.1). Every write edge of a body has the body's template, a
     reference edge included, where it "applies where the check fails". A path
     of a binding made in a body has the binding body's template whether it is
     copied or bound by reference. The input of an effect requested in the
     reactive tier is the template of its request where that is one path, and
     else their join (note 122). A `Child` has no template member, and its
     argument is the write edges with target `argument`.
128. **`T_label`** (PL §6.2). The listing has
     `derive(expression) [ const, T_repl ]` for the template literal. §3.19
     makes a template literal a `derive` "over the templates of the
     substitutions", and the crate follows §3.19: no `const` for the text.
129. **Hashes, constraints, and `cfc-flow:*` are not emitted.** A `Hash` is the
     tagged hash of a canonical record (PL §1.2), which is determined, but every
     member that holds one is the address of something the crate does not
     produce: the emitted value code (`Cone.code`, `CompiledPattern.valueCode`),
     a body's source "as the loader receives it" (`Body.code`), and a schema in
     its stored form (`Slot.schema`, the argument and result schemas, the read
     envelopes). A `Constraint` is built from the label annotations of the
     schemas at a write target and at the inputs (§4.4), and `cfc-flow:*`
     compares the declared labels of a template's slots (`Slot.declared`) with
     those constraints. The templates are there; the declared labels and the
     constraints need the schemas first.

## The records of `wish`, `reduce`, scans, literals, and tags

130. **PL §6.2 as corrected, against the crate.** This replaces note 114. The
     crate now agrees with the listing on `B1` (`s2` to `s5`, no handle, and
     `dynamic(link through s4)` in `T_titles`), on `titles/* : value` in `B2`,
     on `B4` (the resolved `identity` slot alone), on the ordinals of the uses,
     and on the row being compiled into the room under `{ element }` and
     `{ site }`. What still differs: (a) of the four `shape` slots the listing
     gives `B1`, the crate has the one in place at `threadInfo` and the one at
     the root of the list, and not the ones at `threadInfo/*/root` and at
     `threadInfo/*`. Why the analysis records neither was not traced. (b) The
     source declares the row's key inside the `computed` of `replies`, so the
     crate has no cone `key` (note 114 f). (c) The crate has more `shape` slots
     in place than the listing names "among them" (note 114 g). (d) An element
     body is one cone (note 119). (e) `T_label` has no `const` for the text of
     the template literal (note 128). (f) The tag is compiled in with the tag's
     name as the `site` step, and what the row declares is in cones of its own
     inside the cone of the `map` callback's tree; the listing does not show the
     cones of the row apart from `text`, `isEdited`, the key, `replies` and
     `threadLabel`.
131. **Typing `handle?.get()` and `list ?? []`.** The static read of FA §7.2
     through `threadInfo?.get() ?? []` needs both typed: the first is the value
     type of the handle where the handle is present, and the second is the array
     type of its left operand, since the empty literal has the element type
     `never`. Three sites whose check was not decided before are decided now and
     report `subset-type:mismatch`: `product/workbench/sessions.ts:267`,
     `system/fabrichat/room.tsx:1848` and
     `system/quick-capture/quick-capture.tsx:113`. One module that was accepted
     is refused for it.
132. **The operands of `wish`** (PL §3.19). An operand is one write edge at the
     path of its name, with the template of the expression as one value: for an
     array or a record written in place, the join of the templates of its
     members. PL gives "the template of its expression" and §3.4 gives a literal
     a template per path. The form `wish("#tag")`, with the query as the one
     argument, is read as the operand `query`. An operand written with a spread
     or under a name PL does not list is counted as unsupported.
133. **The row of a constant query** (PL §3.19). The query is a constant where
     it is a literal written at the call; a name of a constant is taken as
     computed, which adds records and removes none. With the key `#now`, a
     `path` operand that is computed keeps the state cell of the one-shot clock.
     With the key `#profile`, a `path` that is computed is taken as a home
     target, not as the refused picture. PL does not give the scope of the
     clock's `StateCell`; the crate emits `space`. PL names the three sidecars
     by their `launch` functions and gives no name for the `name` of the
     `Child`; the crate uses `suggestion`, `profileCreate` and `profilePicker`.
     The callee is `{ compiled: null }` with the sidecar's name beside it, since
     the crate has no content address. PL does not say whether "any other
     string" launches the suggestion sidecar under `headless: true`; the crate
     emits the `Child`.
134. **The hint for a computed query** (PL §8 question 48) has no identifier in
     LS §10. The crate lists it per plan (`PatternPlan::hints`) and counts it in
     `plan --corpus`, and reports no diagnostic. The corpus has 1 such call.
135. **The label of a path of a `wish` result** (PL §3.19) is a rule the runtime
     applies to a slot with root `operation` of an operation of kind `wish`:
     `Operation.input` joined with the `dynamic` entry of kind `search` that
     names the operation. `Template` has no node that says so, so a reader's
     template is the `slot` node alone, as PL states, and the plan holds the two
     parts.
136. **`reduce`** (PL §3.13). The operation takes the name §1.3 gives it and the
     collection is named `reduce`, so the two never share a name.
     `Operation.input` joins the `fold`, the membership of the receiver, and the
     template of `init`: "The record" names the `fold` and `init`, and
     "Template" adds the membership. A `reduce` with no initial value has no
     edge at `initial`, which PL does not cover. A callback with a statement
     body is counted as unsupported. The step's output is interim at the path
     `*` with the operation's name.
137. **The predicate of a scan** (PL §3.13) has one output at the path of the
     scan followed by `*`, as a `map` has for its element (note 125). A scan
     with a receiver that is a collection of the plan names that collection's
     assembled output, as before.
138. **A spread in an object literal** (PL §3.4). The crate has the rule for an
     operand whose type is an object type with no index signature, or a union of
     such types, where a property one alternative lacks counts as optional. An
     operand of a record type, or one with no type, is counted as unsupported (4
     sites). The key set of the result has no template of its own in the crate,
     since a record written in place has a template per path only (note 126).
139. **A spread in an array literal** (PL §3.4). The positions from the first
     spread on are one member at `*`, a value a cone computes. A spread of an
     array literal written in place is the members written out. A spread operand
     the instance computed gives its own template as the template at `*` and as
     its `enumeration`. An element construct over such an array has the template
     at `*` as the membership of what it iterates.
140. **A computed key** (PL §3.4, LS §4.3). A key written as a string, a number,
     or a template literal with no substitution is the name. A key that is an
     identifier keeps the form `$name` the crate had for `[UI]` and `[NAME]`.
141. **`db.query(sql, options)`** (PL §3.14) is an operation of kind `effect`
     with the built-in `sqliteQuery`: the handle at the path `db`, read for
     `value`, the statement at `sql`, and each member of the options at its own
     path. The names `db` and `sql` are those of the operands of `sqliteQuery`.
     `Operation.scope` from a `scope` option or from `readClearance` is not
     emitted.
142. **A write through what a site returned** (PL §3.11). A `bind` site and an
     `effect` site return a value the analysis follows, as an `instantiate` and
     a `createCell` site did. A write through the stream or the cell is an edge
     with target `created`, with an empty path whatever the path of the write
     below the cell. A write through the link of an `instantiate` or an `effect`
     site is an envelope `{ kind: "created", call }`. The crate does not refuse
     a write that lands at a path the instance or the effect computes.
143. **A tag that names a pattern** (PL §1.1). The children of the tag are the
     path `children` of the argument. The enclosing tree holds the `[UI]` of
     what the pattern returns. A tag that names a factory value is a `Child`
     whose callee is `{ factory: { slot } }`, with one write edge of target
     `argument` per attribute. A factory value the instance computed has
     `{ factory: {} }`: PL names it by an entry of `computed` of a body, and the
     reactive tier has no body there.
144. **Where a helper's widening is reported** (FA §3.6). An authored function
     is a body where a call in the reactive tier names it, in any module. The
     call in the reactive tier is the use of that body and reports nothing
     itself.

## Schemas, declared labels, and constraints

145. **The schema of a type** (`ts_to_json_schema_mapping.md`, cited as SM).
     `src/schema.rs` emits the forms of SM §4, §6.2, §7, §8 and §11 that the
     types of the subset have: primitives and literals, objects with
     `properties`, `required` and `additionalProperties`, arrays and tuples,
     unions with the all-literal and the primitive-merging rules, a handle as
     one more entry of `asCell`, a default, and the label annotations under
     `ifc`. It hoists no named type into `$defs` (SM §5), so a type that
     contains itself is cut at depth 12 with `{}`; it emits no scope entry in
     `asCell` (SM §10), no `description` (SM §12), and the native table of SM
     §5.2 as `{}`. A literal has the `enum` form of the type path. A pattern
     factory and a handler factory are `{ asCell: ["cell"] }` and
     `{ asCell: ["stream"] }`, after the callable properties SM §4 keeps.
146. **`Slot.schema`** (PL §1.1) is a `Hash`. The crate holds the schema itself
     in its place, since it computes no content address (note 129). A slot has
     one where the emitter has the declared type of its root: the pattern's
     input, the element of a collection, and the event and the state of a named
     handler. A state cell, an operation, a binding of an inline handler or an
     action, and the cause have none. Of the 10,167 slots of the plans of the
     accepted modules, 5,720 have a schema. A kept output has a `schema` member,
     which PL's `Output` does not have, where the pattern declares a result
     type: 923 of 1,561.
147. **A label argument as data** (LS §8.5). The checker keeps the text of an
     annotation's argument. `src/schema.rs` reads a list, a literal atom, an
     object atom, and `AnyOf<list>` from it, and nothing else: a reference to an
     alias, a constant reference `typeof NAME`, a marker type such as
     `CurrentPrincipal`, `PolicyOf`, and a spread are not replaced. Such an
     argument is `{ "$source": text }` in the schema, and the slot then declares
     nothing for that dimension. The corpus has 1 slot with a declared label by
     this reading.
148. **`Slot.declared`** (PL §4.4, LS §8.3). `confidentiality` joins the lists
     of every node from the root to the path, outer first, each atom once.
     `integrity` is the first one found on the way, since LS requires it
     declared alike on one path; `cfc-label:conflict` is not checked here. A
     handle on the way counts as two nodes, the handle and its value.
149. **`Plan.constraints`** (PL §4.4). The crate emits `writer`, `writerFit`,
     `writeFloor`, `requiredIntegrity` and `maxConfidentiality`. An input
     constraint lists the slots of `Body.reads` at or below the annotated node;
     a slot above the annotated path, which overlaps it in the other prefix
     direction, is not listed, and neither are `handles` and `computed`. It is
     listed on every write edge of the body, as the writes it guards; a body
     with no write edge lists it nowhere, since PL does not say which output of
     the cone it guards. `WriterPolicy.body` is the name of the binding where PL
     has a `Hash`. Only a write edge of a body through a handle of a slot has
     constraints: a write to a state cell, a cone's write, and an output have
     none. The corpus has 6 `writer` and 4 `writerFit` records.
150. **`cfc-flow:write-policy`** (LS §8.6, PL §4.4) is reported where the
     writing body is not the handler, or the function, that the binding of
     `WriteAuthorizedBy` names, compared by name. A write the body makes through
     a function it calls is the body's. The policies of `WritePolicyAnyOf`,
     `TrustedActionWrite` and `TrustedActionWriteWithIntegrity` are not read:
     the checker keeps the name of those aliases and not their arguments. The
     corpus has no report.
151. **`cfc-flow:max-confidentiality`, `cfc-flow:required-integrity`,
     `cfc-flow:write-floor` and `cfc-flow:writer-fit` are not built.** PL §4.4
     states each as a relation between labels, "fits the ceiling", "fits it",
     and "satisfies the patterns, with one coherent witness across them", and
     gives the relations by the runtime functions that hold them today
     (`verifyInputRequirements`, `verifyWriteFloor`,
     `prepareBoundaryCommitSteps`). Neither PL nor LS defines when a list of
     atoms fits another or when an integrity satisfies a pattern, with `AnyOf`
     clauses and object atoms. Two more things are open for the two write
     checks: `I(template)` and `C(template)` of a `derive` by a body need the
     `TransformedBy` atom, which holds `Body.code`, a hash the crate does not
     have, and PL says a compile-time pass on confidentiality "settles nothing",
     so only a failure counts, which needs the relation's negation to be exact.
     The records are emitted, and `plan --corpus` counts the input constraints
     whose every listed slot declares the label: the corpus has no input
     constraint.
152. **`cfc-flow:ui-contract` is not built.** The checker does not keep the
     arguments of the trusted-action aliases (note 150), and the crate has no
     record of the surface an element sits under.
153. **Hashes** stay as note 129 has them: every `Hash` is the address of
     emitted value code, of source as the loader receives it, or of a schema in
     its stored form, and the crate produces none of the three in that form.

## PL as merged, and the label arguments

154. **The three sites of note 131.** (a) `product/workbench/sessions.ts:267`
     was a checker gap: a truthy `s?.startedAs` did not narrow the path
     `s.startedAs`, because the rule for a chain that did not stop was tried
     before the rule for the tested reference. Fixed, and the module is accepted
     again. (b) `system/fabrichat/room.tsx:1848` is reported as LS states it:
     `container?.key("fileStoreRecord")` on an optional property that is not a
     handle is a `Cell<FileStoreRecord | undefined>` (LS §4.7), and it is given
     where the handler declares
     `fileStore?: Writable<FileStoreRecord | Default<{}>>`. LS §7.5.2 removes
     `undefined` before the comparison where the callee declares the property
     optional, but states that for the second row, a value where a cell is
     declared, and this argument is a handle, the fourth row. The same place
     named as a value path would be accepted. Not changed. (c)
     `system/quick-capture/quick-capture.tsx:113` is reported as LS states it:
     an array of the values `Note(...)` returns, given in a handler where
     `Notebook` declares a cell of `NotePiece[]`. LS §7.5 makes one such value
     assignable "to a cell of such a type", and says nothing of an array of
     them, so the third row of §7.5.1 refuses the cell of the array. Not
     changed.
155. **`Binding.state` and `Collection.construct`** (PL §1.1). A collection has
     `construct`, which for a `reduce` is `operation`. A path bound to the index
     of an element has `place: { index }` and the membership the collection
     iterates as its template, and a path bound to `undefined` has no entry. A
     constant written as the name of a module-scope constant is still held as
     `null`: the emitter evaluates a static initializer for a label argument
     (note 163) and not here.
156. **A join** (PL §3.2). This replaces note 122 and the joins of notes 124,
     127, 132 and 136. `joined` drops `const` inputs and equal inputs and
     returns the one template left, and a `fold` is not joined with the
     membership its collection iterates. Expression code of an operator keeps
     its `const` operands, as the condition of `T_label` does in PL §6.2. PL
     does not say where the line is between "a join" and "expression code with a
     constant operand"; the crate takes every place a rule says "joined with" or
     "the join of" as a join, and the operands of an operator, a call of the
     standard library, and a template literal as expression code.
157. **The cones of an element body** (PL §1.4). This replaces note 119. Each
     declaration of the callback that computes is a cone, and the returned
     expression is one more, made before the constructs written in that
     expression. `Plan.cones` is ordered by the edges and then by the order in
     which the cones were made, so the cone of the returned expression is after
     every cone it uses, and is not last where a construct written in the
     returned expression is unused by it, which the grammar makes rare. A value
     a declaration cone computes that another cone of the body uses is an
     interim output at the empty path under the declaration's name, as a
     declaration of a pattern compiled into a callback already was: PL says the
     path "has `*` at the position of each enclosing collection" and gives no
     path for an interim name inside a body.
158. **The entries of a constructed value** (PL §3.4). This replaces note 126. A
     value one cone computes that is a record or an array written in place, a
     JSX element, a `select` or a static-key `pick` over such values, a promoted
     `computed` with an expression body that returns one, or the element of a
     `map`, has a container entry and one entry per member that is not
     constructed in place and not `const`. A rendered tree has the paths
     `props/<name>` and `children/<n>`; `type` and `name` are constants and have
     no entry. JSX text that is white space with a line break is no child. A
     child whose type is an array, or that is the assembled result of an element
     construct, puts every later child at `children/*`, whose template joins the
     element template and the membership of each spread child with the templates
     of the later children. A spread attribute whose operand declares no
     properties is the member `*` of `props` and decides the key set. Chosen
     where PL is silent or the crate differs: (a) the template of the value
     observed whole is, for a `select`, the one `select` over the whole
     branches, and not the join of the per-path `select` nodes, which is the
     same label in fewer nodes; (b) a record written directly in a pattern body
     or in the returned object has an entry per member as before and no
     container entry, since each member is a value of its own cone; (c) a
     promoted `computed` with a block body, and a `pick` whose `from` is an
     output, are one template; (d) what a tag that names a factory value renders
     has no slot in the crate, so its entry has no template. Of the 9,100
     outputs of the plans emitted with no unsupported construct, 9,051 have a
     template, and 356 of 364 plans have one on every output.
159. **The readers of a state target** (PL §3.11). This replaces the last part
     of note 116. The `identity` slot at the cell's root is no reader.
     `side-write:cycle` is reported nowhere in the corpus, where it was reported
     at 12 sites, each an edge from a cone to itself through that slot.
160. **The `shape` slots of `B1`** (PL §6.2, note 130 a). The listing gives `B1`
     a `shape` slot at `threadInfo/*` and one in place at `threadInfo/*/root`.
     The source tests `record?.root === undefined` on an element of
     `StoredThreadInfo[]`, whose type admits neither `null` nor `undefined`,
     with `root: Cell<unknown>` required. Both tests are decided by the type (FA
     §2.2), and FA §2.3 removes a `shape` entry that only such a test recorded
     where another entry is at or below its path, which
     `threadInfo/*/root : identity` is. The crate follows FA and has neither
     slot. `T_label` equals the listing as merged.
161. **The child slots of a `pick`** (PL §3.18). This replaces note 123. A read
     of a path below the chosen child in the cone the pick is written in, or in
     a cone that uses its output, has the slot at the path of the container,
     `*`, and that path, with the class of the read. A child passed on whole is
     read for `value` at the child, because the crate does not follow what a
     later reader observes through a reference a `select` or an output passes
     on; PL would have the `identity` slot there and the reader's own slots
     below it.
162. **`function-body:wish`** (LS §5.2) is reported at the call, in every
     function body, the body of an authored function included whatever calls it.
     The corpus has no report.
163. **A label argument as data** (LS §8.5). This replaces note 147. The checker
     evaluates the argument where it resolves the alias and keeps the value
     beside the text: a list with each alias replaced by its body, a type
     parameter of an alias by the term written for it where the alias is used, a
     spread by its members, `typeof NAME` and `typeof NAME.key` by the value of
     the constant's static initializer, `AnyOf<list>` by `{ anyOf: list }`, and
     `CurrentPrincipal` by `{ __ctCurrentPrincipal: true }`, the form the schema
     mapping gives it. LS says "`CurrentPrincipal` and the other marker types
     the API exports for atoms" and names no other; the crate reads no other.
     `PolicyOf<typeof rules>` is `{ policyOf: { module, binding } }`, where the
     mapping has a record with a digest the crate does not compute. `Cfc<T, M>`
     adds the label keys of the record `M`, and `RepresentsCurrentUser` and
     `AuthoredByCurrentUser` add `addIntegrity` with their atom. A term the
     checker cannot evaluate keeps `{ "$source": text }` in the schema and
     declares nothing.
164. **A writer policy** (LS §8.5; PL §1.5, §4.4). This replaces the last part
     of note 150 and `WriterPolicy.body` of note 149. `WriteAuthorizedBy`,
     `TrustedActionWrite` and `TrustedActionWriteWithIntegrity` around a type
     are the annotation `writeAuthorizedBy` with one policy, and
     `WritePolicyAnyOf` is `writePolicyAnyOf` with one policy per member,
     written directly or through an alias. `WriterPolicy.body` is the record
     `{ module, binding }` PL §1.5 hashes, with the path of the module where PL
     has its content-addressed identity. A trusted-action policy has
     `uiContract` with `helper: "UiAction"`, the action, the pattern, and
     `requiredEventIntegrity`, which for `TrustedActionWrite` is the pattern
     alone, as the schema mapping has it. `TrustedActionUiContract` is the
     annotation `uiContract` and gives no constraint: PL §4.4 has the UI
     contract on a `WriterPolicy` only. `cfc-flow:write-policy` compares the
     writing handler or function with each alternative by module and name. LS
     §8.3 requires two declarations of one key on a path to be alike; a path
     with a `writeAuthorizedBy` below a `writePolicyAnyOf`, as
     `fabrifile/store.tsx` has at `entries/*/addedBy`, gives one `writer`
     constraint per annotation, and the write has to satisfy each.
165. **Where the constraints are read** (PL §1.5). Still as note 149: only a
     write edge of a body through a handle of a slot has constraints. A `state`
     target, an `argument` target, a `created` target, a `request` target, and a
     kept output against `Plan.resultSchema` have none, and an input constraint
     is not listed on an output whose template has a `derive` by the body. A
     push has the target path `*`, so the annotation of the element type applies
     to it.
166. **The corpus, with the label arguments read.** The plans of the accepted
     modules that are emitted with no unsupported construct have 11 slots with a
     declared label, and 10 `writer`, 4 `writerFit` and 2 `writeFloor` records.
     Over every plan of the corpus, the refused modules included, there are 32
     `writer`, 8 `writeFloor`, 5 `writerFit` and 4 `requiredIntegrity` records,
     and 93 write edges list a `writer` constraint, 51 of them in
     `fabrichat/room.tsx`. `cfc-flow:write-policy` reports nothing: every such
     edge is in a handler its policy names.

## The label-flow checks of PL §4.4

167. **Where the constraints are read** (PL §1.5). This replaces note 165 and
     the last part of note 149. A write edge of a body and of a cone, and a kept
     output, has the constraints of the annotations at its target: through a
     handle of a slot, at a `state` target under the type argument of the cell
     constructor, at an `argument` target under the argument type of a factory
     the tag names by a slot, and at a kept output under the result type the
     pattern declares. A `created` target, a `request` target, an `argument`
     target of a child a body instantiates, and a state cell whose constructor
     has no type argument have none: the footprint keeps no type for a site, and
     the request types the API declares were not read. A `requiredIntegrity` at
     a kept output gives a `writeFloor`, by the assumption of LS §8.6 that the
     crate already made for a write edge; PL §1.5 names `writerFit` and `writer`
     alone for an output.
168. **A slot that observes a reference declares nothing** (PL §1.5, question
     55). An `identity` slot and a `shape` slot in place have no `declared`
     member. The template of a write a body makes through a handle always has
     the `identity` slot of that handle, so by PL §4.4 ("evaluated only where
     every `slot` node it reaches ... has the `declared` member")
     `cfc-flow:writer-fit` and `cfc-flow:write-floor` are never decided for a
     write of a handler, an action, or a computation's side-write. They are
     decided for an output or an edge whose template has `value` slots alone:
     expression code, and a body that reads values and no handle. For a lower
     bound of confidentiality the restriction is stricter than soundness needs,
     since an undeclared slot could count as the empty list; the crate follows
     PL. The corpus has 9 slots with a declared label where it had 11.
169. **What an input constraint lists** (PL §1.5, §4.4). This replaces the
     middle of note 149. The annotations are those of the type the body declares
     for a formal input, where the emitter has it (a `lift` and an authored
     function), and otherwise of the type of the slot root the input is bound
     to, from the root, which for a handler is its event and state type and for
     a capture stands in for "the static type the checker gives the expression".
     A constraint lists slots, entries of `Body.computed`, and entries of
     `Body.handles` with the annotated path below the cell, in either prefix
     direction. Chosen where PL is silent: an entry of a class other than
     `value` at or above a handle does not overlap an annotated path below the
     hop, since it observes the reference and reads nothing through it; PL's
     "overlaps ... in either prefix direction" does not say whether a path
     overlaps across a link. Without this a handler that holds a handle to a
     document with one `RequiresIntegrity` field would be held to that
     requirement on the pointer label of the handle. A body with no write edge
     and no output derived by it still has its constraint in `Plan.constraints`,
     listed nowhere, and the compile-time check runs on it.
170. **The relations** (PL §4.4, `src/flow.rs`). An atom's type is compared by
     the last segment of its identifier, so `Expires`, `User`, `PersonalSpace`,
     `Space`, `Policy`, `Concept` and `TransformedBy` are read alike with and
     without the prefix `https://commonfabric.org/cfc/atom/`. A variable is a
     record with the one member `var`. A pattern member given as `undefined` has
     no canonical form in LS §8.5 and is not read. Where PL says "a check that
     would compare one is not decided", the crate skips the clause or the
     pattern that holds the run-time term and still reports another clause or
     pattern of the same constraint; a run-time term in the ceiling, in the
     target's declared list, or in an integrity atom of an input leaves the
     whole constraint undecided, and so does a `Policy` atom anywhere in a
     confidentiality check. PL §3.2 says a `derive` keeps "the inputs'
     hereditary atoms" and §4.4 says "the atoms that every input has"; the crate
     follows §4.4, having no record of which declared atom is hereditary. A
     template that is `const` alone is not evaluated for integrity.
171. **`TransformedBy`** (PL §4.4). The crate forms no `Body.code` and no
     `Cone.code` (note 153), so a pattern that can match the atom, a variable or
     a record whose `type` is absent, a variable, or `TransformedBy`, is not
     decided against a template with a `derive`.
172. **`cfc-flow:ui-contract`** (PL §4.4). The chain of an element is the
     elements written around it in the JSX. The surface is not decided, and the
     compiler is silent, where the chain has a tag that is neither a host
     element nor one of the three helpers, where the element is written between
     the tags of a pattern or in one of its attributes, where the tree is
     written anywhere but as the `[UI]` value (a tree held in a constant and
     placed by a reference is not followed), and inside a pattern called as a
     function. The handler of an alternative is found by the name of its
     binding. A pattern with a plan of its own that binds the handler and leaves
     the surface to the pattern that embeds it is reported, as PL has it ("the
     chain ends at the root of the pattern's own tree"): both reports of the
     corpus are of this kind.
173. **`wish`** (PL §3.19, LS §10.2). A string given as the argument is
     `subset-type:mismatch`, reported at the argument by the checker, which
     names the one parameter of `WishFunction`; no document states the rule
     apart from the API's type. `query`, `scope`, `headless` and `path` are
     constants where the static initializer of a module-scope constant
     evaluates, a literal included. `wish:computed-query` is reported at the
     call for a query that is not a constant, and for a `path` that is not a
     constant where the query is exactly `#now` or `#profile`.
174. **Schema identifiers** (PL §1.1, §1.5). This replaces note 146.
     `Slot.schema`, `Plan.argumentSchema` and `Plan.resultSchema` hold an
     identifier, the documents are listed once each beside the plan
     (`PatternPlan.schemas`, and `schemas` in the output of `plan`), and an
     output has no schema member. The identifier is the placeholder
     `unhashed:schema/` and the position of the document. PL §1.2 gives the
     canonical form and names the tagged hash by a runtime function for label
     documents, with no tag for a schema document, so the crate computes none.
     `StateCell.schema`, `Child.argumentSchema`, `Child.resultSchema`,
     `Binding.eventSchema`, `Binding.stateSchema` and `HandleReads.envelope` are
     not emitted. `$defs` (PL §1.5, SM §5) is not built: the type store holds a
     recursive reference as an unresolved type with no name, so the emitter has
     nothing to refer to, and such a position is `{}` as before.
175. **The path of a `created` edge** (PL §3.11) is read from the `key` calls
     the receiver is written with at the write, and `*` for an append. A key
     that is not static leaves the edge at the path above it. A handle of the
     created cell held in a variable after a `key` call has the empty path, as
     before.
176. **The corpus, with the label-flow checks.** 335 modules accepted and 386
     errors, as before; plans with no unsupported construct for 271 of 288
     modules. `cfc-flow:ui-contract` is reported twice
     (`product/lobby/main.tsx`, `system/fabrichat/room.tsx`) and the four error
     diagnostics nowhere. The accepted plans have 52 `writer`, 9 `writerFit` and
     2 `writeFloor` records and no input constraint.
177. **What the stage 3 comparison compares** (PL §3.1; `compare/`). PL names
     "the label of a written path" on both sides. The two sides do not store the
     same thing at an output path: today a result path holds a link to a
     document of the node that computed it, and a node that returns an input
     copies its value, where a template has the `identity` slot of the input and
     the plan stores a reference. The comparison therefore takes, for the
     runtime, what a value read of the output path consumes with every link
     followed (`cfcLabelViewForResolvedCell`), and for the template the label of
     §3.2 with each `identity` slot joined with what a value read at the slot's
     path consumes. The label of §3.2 as written is reported beside it. For an
     entry that names a collection the runtime's side is what a read of the
     container's shape consumes. PL does not say which of these the criterion is
     about.
178. **Today's label has a declared part that PL §3.1 does not list.** A module
     joins the labels its argument schema declares onto its result schema
     (`runtime/runner/test/cfc-argument-ifc-propagation.test.ts` states it), and
     the document of each `computed`, `ifElse` and `map` result stores that join
     as an entry of origin `declared` at its root, beside the `derived` entry of
     the transaction's join. It does not depend on what the run read. Observed:
     the result of `ifElse` carries the declared labels of both branches and of
     the condition with either branch selected and has no `derived` entry, where
     PL §3.5 has "the link consumes the selected branch's label at its own
     document. **Equal.**"; the template is tighter when the unlabeled branch is
     selected. `isEdited` over a message without `editedAt` carries the clause
     of `editedAt` from the declared entry alone. Every template of the
     comparison is at most as wide as this static join, so a row can read
     "tighter" where the template equals the `derived` entry. The harness reads
     label views, which do not keep an entry's origin, and so does not separate
     the two.
179. **The container of a `map` result** (PL §3.6: "the container carries
     membership"). Observed for `items.map(...)` over a list with no label of
     its own whose elements have a declared clause: the result container's root
     resolves to that clause on a covering entry and on its `enumerate` and
     `shape` entries. The template of the container is the source's
     `enumeration` slot, which has no label. The template is tighter, where PL
     has **Equal**.
180. **A conditional written in a `computed`** (PL §3.5). The "Today" paragraph
     describes `ifElse`, `when` and `unless`. `c ? a : b` in a `computed` is a
     lift today: its transaction reads the condition and both operands, writes a
     copy of the selected value, and mints `TransformedBy`. The template is a
     `select` over the operands' `identity` slots. Its confidentiality is equal
     with the labeled branch selected and tighter with the other. Its integrity
     is the selected branch's, which has no `TransformedBy` atom, so by "tighter
     means ... more integrity atoms" the template is looser on integrity. This
     is none of the three exceptions of §3.1. The comparison reports it as
     looser.
181. **`TransformedBy` beside no label** (PL §3.1, §3.2, §6.4). §3.2 gives a
     `derive` its atom without a condition. The runtime mints it "when ... the
     join is not empty" (§3.1; `deriveFlowJoinImpl` mints where the label has a
     clause or an atom), and the table of §6.4 has "`TransformedBy(commitSend)`
     when the join is not empty" for a template. The evaluator follows §3.2,
     with an option for the other reading. A `derive` over inputs with no label
     is then tighter on integrity than today's unlabeled result.
182. **Input witnesses** (PL §3.2). A derivation over the result of a derivation
     stores two atoms today: `TransformedBy` with the identity, and one with the
     identity and an `inputWitness` (`mintTransformedBy` in
     `runtime/runner/src/cfc/input-witness.ts`). §3.2 has one atom per `derive`
     and names no witness. Compared atom by atom the template would be looser.
     The evaluator leaves witness-bearing atoms out of the relation and counts
     them.
183. **`.length` in expression code.** For `computed(() => items.length)` the
     crate emits the output as the `identity` slot at `items/length`. PL §3.8
     has the collection's membership for `.length`, an `enumeration` slot at
     `items`. This is a gap of the crate. The comparison row is looser by an
     artifact of it: the dereferenced read at `items/length` matches the `*` of
     the elements' declared entries. Closed: `.length` of an input collection is
     now its `enumeration` slot and of an input string its `value` slot, and the
     row is equal.
184. **A slot at an absent path** (PL §2.2, §6.4). The runtime stores a declared
     entry where a value is written, so a `shape` slot at an optional field that
     is absent resolves to no label, by the definition of §2.2. `C(m5)` of §6.4
     is then empty for a message that was not edited, and the template of
     `isEdited` has no clause, though its value says that the field is absent.
     Today's `derived` entry for the same run has the clauses of the fields that
     are present.
185. **Selectors and picks.** §3.2 takes `sel(i)` from the value code, and the
     crate emits none. The fixtures state the branch each selector takes with
     their argument. Where none is stated the evaluator joins every branch and
     marks the label as a bound.
186. **`T_edited`** (PL §6.2) is compared on `compare/fixtures/is-edited.tsx`,
     which holds the source of `isEdited` over a message with a label per field.
     The crate emits the same template for it as for
     `patterns/system/fabrichat/message-row.tsx`. In the row `isEdited` is an
     interim value with no output path, and the plan holds nothing that names
     the document today's runtime stores it in. Observed as §6.5 has it: today
     the whole record, and the template the presence of `editedAt` with the kind
     of `body`.
187. **`binding:write-to-computed`, and what the crate decides** (ruling T3; LS
     §10.2; PL §3.11). The crate decides the case of a bound path in the plan,
     for the state of a handler bound in the reactive tier, a pattern compiled
     in included. A path is a reference where it is an element of a `filter`
     over a stored collection, a `select` whose branches are stored places, a
     `pick` of a child of a stored container, the expression of a `computed`
     typed as a handle, or a `computed` that stays a body and returns, on every
     `return`, a `filter`, `slice`, `sort`, `find`, `at`, `get`, `key` or member
     chain over a stored place, or a `map` whose callback returns its element.
     The binding's state entry then has `"through": "reference"`, which no
     record of PL §1.1 has. A path is produced where its template is a `derive`
     by expression code, a `fold`, or a `const` under a listing of the checker.
     Anything else that could hold a reference is counted as `mixed` and not
     reported: a selection with one branch of each kind, what an authored
     function returns, a record or an array a body assembles, and a parameter a
     function returns. `Body.outputs` of FA §3.8 would decide the last three,
     and the crate does not read it here. A `lift` result that writes through
     its argument is not examined.
188. **No hint for a callee that only reads** (ruling T3; LS §10.2). The brief
     of this slice asked for a hint where a writable handle is bound to a
     produced value and the callee only reads. LS §10.2 names one diagnostic, an
     error for a callee that writes. The crate follows LS and counts the read
     case (`plan:handle bound to a computed value:computed:
    read`) without
     reporting it.
189. **A literal reached through a pattern compiled in** (LS §10.2). A literal
     given to a handler where a writable handle is declared is reported. A
     literal given to a pattern in the reactive tier reaches the pattern's own
     bindings as a constant, which the emitter does not tell from a property the
     argument leaves out. The checker counts the argument
     (`types:by-reference:a writable handle bound to:a literal`), and the plan
     does not report the write. PL §3.15 refuses it.
190. **The position of a report inside a pattern compiled in.** A
     `binding:write-to-computed` found in a pattern compiled into the plan is
     positioned at the outermost call or tag of the module being compiled, since
     a diagnostic of a module has a position in that module. The message names
     the inner binding by file and line. LS §10.2 does not say where such a
     report is positioned.
191. **An `ifElse` without the static part carries no label of its condition**
     (ruling T2; PL §3.1, §3.5). The document of an `ifElse` result stores one
     entry, of origin `declared`, with the join of the argument schema's labels.
     The label of the condition reaches a reader through that entry alone. Read
     by origin, without it, the runtime's label is the selected branch's own
     label, and the template, which joins the condition, is looser in both runs
     of the fixture. With the static part the row is equal when the labeled
     branch is selected and tighter otherwise. The ruling expects equal without
     it. The container of a `map` is as the ruling has it: tighter with the
     static part and equal without. For a container the static part is the
     `declared` entry of the module's result document and the entries of origin
     `structure` the runtime makes from the declared label of the elements; with
     the `structure` entries kept the row stays tighter.
192. **Which documents the static part is removed from** (ruling T2). The
     comparison walks the documents from an output to its value and leaves out
     the `declared` and `structure` entries of each, except those of the
     argument's own document, whose declared entries are the labels of the
     inputs. PL §3.1 does not say how a reader tells the two apart, and a stored
     entry does not say which schema declared it.
193. **A defaulted property in the comparison** (ruling T1). The fixture
     `compare/fixtures/defaulted.tsx` declares an integrity atom on an object
     with one defaulted property. The runtime's label at the defaulted property
     has the object's atom, with the property given or not. The comparison gives
     a slot at a property the argument leaves out the empty integrity, so that
     row is looser, the exception by ruling. The atom of the fixture is a
     string, which has no propagation class and which a `derive` drops on both
     sides, so the whole read and the property read are compared on outputs that
     pass the place on. A hereditary atom written as a type argument (`typeof`
     of a constant record with the `PolicyCertified` type) produced no stored
     label in the run, so a `derive` over the whole object is not compared.
194. **The surface of a pattern written as a tag** (PL §4.4, §8). A pattern's
     own plan is not reported under `cfc-flow:ui-contract` where another plan of
     the same module compiles the pattern in as a tag and reports none of its
     bindings there. A tag in another module is not followed, and a pattern with
     a tag under a surface in one place and under none in another is reported
     from the second.
195. **`.length` of a value the instance computed.** `.length` of an input
     collection is its `enumeration` slot, and of an input string its `value`
     slot (PL §3.8). `.length` of a collection the instance computed has the
     template of the value at the path `length`, which for an assembled result
     is the membership and for a constructed value the nearest entry. PL §3.8
     does not treat a string.
196. **Alignments that needed no change.** The comparison compares atoms by the
     canonical JSON of the whole atom, the type's URL included, and prints the
     last segment only. The evaluator's `derive` and `fold` keep the atoms every
     input has whose propagation class is hereditary (`atomPropagationClass`),
     which is the class-aware meet of PL's notation. A `select` keeps every atom
     all its branches have, of any class, since it passes the selected branch
     on.

## The comparison beyond the fixtures, and over the corpus

197. **When the evaluator mints** (PL §3.2, question 66). PL §3.2 now assumes
     that a `derive` and a `fold` mint `TransformedBy` where the label has a
     confidentiality clause or a hereditary atom, and not beside an empty label.
     The evaluator of `compare/template.ts` minted on every `derive` (note 181),
     with an option for the other reading. The option's default is now the
     assumed one, for `fold` as for `derive`. `greeting` of the small fixture
     and `derived` of the defaulted one are equal where they were tighter.
     `isEdited` over a message that was not edited is now looser on integrity:
     its template has no clause (note 184), so it mints nothing, and the
     runtime's label has the clauses of the fields that are present and a
     `TransformedBy` atom beside them.
198. **The label an event's schema declares** (PL §3.12). The fixture
     `compare/fixtures/handler.tsx` declares a clause on the field `text` of its
     event. The runtime's label at the paths the handler wrote has the clause of
     the input the handler read and not that of `text`, with the event sent to
     the stream at the result path or to the stream the manifest of internal
     cells names. An event is not stored, so the harness takes as the label of
     an `event` slot the label the plan's slot declares. The template then has
     the clause of `text` and is looser on confidentiality. PL §3.12 says
     "Today. The handler's transaction join over the event payload and the state
     it read lands on every written path", which the run does not show for a
     label the event's schema declares. No corpus pattern declares a label on an
     event.
199. **What the harness reads for a handler, and what the plan lacks for it.** A
     binding names the result path that holds its stream (`result`), and a
     handler's body the schema of the type its event declares (`eventSchema`);
     no record of PL §1.1 has either. A state cell is found in the run's
     manifest of internal cells by the name of the plan's `StateCell`, which is
     the transformer's `.for(...)` name. A slot of root `binding` resolves
     through the binding's state entry to the slot its `place` names, or has the
     label of the entry's template. The template of a write edge is evaluated
     with no `identity` slot dereferenced: the body writes through a handle and
     does not read what it holds. A write edge is compared at the paths the
     event's run wrote: a target whose stored value changed, and for a target
     that ends in `*` the elements the run added. A write the run did not make
     has no row.
200. **Selectors and picks from the run** (PL §3.2; closes note 185 in part).
     The plan holds no value code. The harness finds the branch of a `select` in
     three ways, in this order. Where the node is the whole template of an
     output and the branches are slots, the branch is the one whose value is the
     stored one, where exactly one is. Where one branch is the condition itself,
     which is the form of `&&` and `||` (PL §3.5), the stored value decides by
     whether it converts to true. Where the condition is one slot, its value
     decides, by presence where the slot observes `shape` (the form of `??`) and
     by conversion to true otherwise. The child of a `pick` in a container is
     the value of the key's slot where the key is one slot, or the child whose
     value is the stored one; the element of a `find` is the first whose value
     is the stored one. A selector inside a `derive` whose condition is computed
     is not found, and its row is a bound and is counted apart.
201. **A generated scenario gives labels through links** (stage 3). The corpus
     declares a label on 9 slots, so a run of a corpus pattern with its own
     schema's labels compares almost nothing. The generator writes each
     top-level input to a cell of its own under the input's schema with one more
     confidentiality atom, and the argument holds a link to the cell. The
     pattern's argument schema then declares none of these atoms, and the static
     part of PL §3.1 is empty for them. With the small fixture run this way,
     `ifElse(flag, secret, note)` has the label of the selected branch and no
     label of `flag`, with the static part or without it: the template, which
     joins the condition, is looser on confidentiality. Note 191 found the same
     without the static part. Where the argument schema declares the condition's
     label, the static part hides it.
202. **A `computed` whose template is not a `derive`** (PL §3.5, §3.8, §3.4;
     section 8, question 64). Every looser row of the corpus run but three is of
     this kind, on integrity alone. The runtime runs a `computed` as a lift,
     which mints `TransformedBy` on every path it writes where its join has a
     label. The template mints for a `derive` and a `fold` only. It has no atom
     where the body's value is a slot passed on (`computed(() => secret)`,
     `computed(() => zoom.get())`), the membership of a collection
     (`computed(() => items.get().length)`, PL §3.8), a selection
     (`computed(() => pending || isProcessing)`,
     `(bookmarks.get() ?? []).length`), or a constructed value
     (`computed(() => ({ who: secret, n: 1 }))`, whose container entry is
     `const` and whose entry at `who` is the slot). PL §3.1 names the
     conditional as open and not counted among the four exceptions; the other
     three forms are the same difference and PL does not name them.
203. **A label that only a declaration gives, and the mint beside it.**
     `patterns/examples/cfc-spec-gallery/main.tsx` renders the result of a
     `materializer` with no input. The template is a `derive` over a `derive`
     with no inputs, which has no label and so mints nothing. The runtime's
     label has the caveat the materializer's result schema declares, and a
     `TransformedBy` atom minted beside it. The template is tighter on
     confidentiality, which PL §3.12 expects of a declared entry ("added as it
     is today"), and looser on integrity. PL does not say whether a template
     mints beside a label that a declaration adds after the template is
     evaluated.
204. **The container of a constructed value in the comparison** (PL §3.4;
     extends note 177). An output entry that has entries below it is compared
     with what a read of the container's shape consumes, as an entry that names
     a collection is. A value read of the container consumes the labels of
     everything below it, and the template of the container entry is `const`.
205. **`TransformedBy` atoms are counted by identity.** A label view lists an
     atom once for each of its entries that has it. A value read of a rendered
     node joined the same atom from each entry, and the comparison counted each
     occurrence, so a template with one atom read as looser than a runtime label
     with the same atom many times. The count is now of distinct atoms. Where
     the entries below a path have atoms of different identities the runtime's
     side still counts each, though a read of the whole has only what every part
     has.
206. **A literal argument of a pattern compiled in** (LS §10.2; PL §3.15; closes
     note 189). `binding:write-to-computed` is reported where a call of a
     pattern the plan compiles in writes a property of its argument as a
     literal, the pattern's parameter binds that property by name, and a handler
     bound in the pattern writes through it. The three corpus sites are
     `Counter({ value: N })` at `examples/cf-picker/cf-picker.tsx` lines 25 and
     29 and `examples/drag-drop-demo/drag-drop-demo.tsx` line 61. An argument
     the call leaves out is not reported, and neither is a property bound to a
     path the caller's own argument leaves out
     (`outgoingNotices:
    input.outgoingNotices` of
     `system/fabrichat/manager.tsx`, called from `system/home/home.tsx` with no
     such property), which the emitter holds as a constant too. Not reported: a
     literal given as an attribute of a tag, a parameter the pattern does not
     destructure, a module-scope constant given by name, and a write through the
     parameter by an `action` of the pattern. The corpus has 389 errors (386
     before) and 333 accepted modules (335), and 270 modules with a plan with no
     unsupported construct (271).
207. **The comparison over the corpus** (`compare/corpus.ts`). Of the 270
     modules with a plan with no unsupported construct, one pattern each (the
     default export, or the first exported by name), with a generated scenario,
     in one process with no server:

    | | |
    | --- | --- |
    | modules attempted | 270 |
    | modules run | 213 |
    | not run: needs `wish` | 33 |
    | not run: requests an effect | 14 |
    | not run: the run's commit is refused (a trusted-event policy 6, a trust-sensitive form 2, a `maxConfidentiality` the generated atom exceeds 2) | 10 |
    | outputs compared | 1191: 1120 equal, 23 tighter, 48 looser, 0 incomparable |
    | outputs whose label is a bound, counted apart | 118 |
    | events sent, one per handler whose stream the result holds | 145 |
    | write edges compared | 28: 28 equal |

    The 48 looser rows are looser on integrity alone: 45 by note 202 (25
    with a slot as the template, 17 with a `select`, 3 with a constructed
    value) and 3 by note 203. None is one of the four exceptions of PL
    §3.1, and none is looser on confidentiality. Not compared, by
    reason: 196 outputs the run holds no value at; 183 write edges the
    event's run did not make; 171 rows that read a state cell of a
    per-element body, which the manifest does not name by element; 113
    outputs at an element of a collection no output entry names; 89 at
    an element slot outside its collection; 89 below a child no pick
    chose; 23 over a collection whose source is not a stored slot; 20
    with a slot of root `operation`; 12 outputs with no template; 10
    with a `dynamic` node; 1 write target with no stored cell. Of the
    selectors and picks the rows met, 12 were found from a stored value,
    195 from the slot of the condition or the key, and 304 were not
    found. Of the handler bindings of the patterns run, 145 are at the
    top level with their stream at a result path, 121 are at the top
    level and bound in the rendered tree, where the plan names no result
    path for the stream, and 385 are in a per-element body. No slot of
    root `cause` was met. The column "without the static part" (ruling
    T2) has 56 looser rows: the 8 more are array results of a `computed`
    whose only entries are of origin `structure`, which note 192 leaves
    out with the declared ones.

208. **The patterns of a plan, and the pattern a node is written in** (PL §1.1,
     §1.5, §3.2 "The atom of the pattern"). `Plan.patterns` lists the pattern
     the plan is compiled from and each pattern compiled in, in the order of its
     first site. A `derive` by expression code and a `fold` hold `pattern` where
     the pattern is not entry 0. PL has the hash of `{ module, binding }` as an
     entry, with the module's identity in it. The crate has neither, so an entry
     is the placeholder `unhashed:pattern/`, the path of the module, `#`, and
     the binding: `unhashed:pattern/row.tsx#default`. For an inline
     `pattern(...)` that no `const` names, PL forms the binding from the
     enclosing pattern's, the `within` steps and the name of the site. The crate
     writes the enclosing binding, `/`, and the line and column of the inline
     pattern, which names the same pattern and is not PL's form. The emitter
     makes a `derive` and a `fold` in functions that hold no emitter state, so
     the pattern being evaluated is a thread-local that the evaluation of a
     compiled-in pattern sets.
209. **The atom of a kept output in the comparison** (PL §3.1 "An atom that
     names code", §3.2 "Every kept output"; closes notes 202 and 197's
     `isEdited` row). The evaluator mints the atom of the pattern for expression
     code and a `fold`, and adds the atom of entry 0 to the label of every kept
     output, also beside no label. A body's atom names the body's index.
     `compareLabels` counts atoms as before and reports how many of the
     template's atoms name a pattern where the runtime's label has an atom for
     other code: the template's atoms of bodies are taken to correspond to the
     runtime's first, and the pattern's to those that are left. A row that is
     not looser and has such an atom is counted as "atom names the pattern".
     Since the runtime stores no atom for a value a pattern passes on or for an
     unlabeled value, every row that was equal is now tighter on integrity, and
     no row of the corpus is equal. The report says for each row what it was
     before the atom was added. The row `nick` of the defaulted fixture (the
     fourth exception of PL §3.1) is now incomparable on integrity: the template
     lacks the object's atom and has the pattern's.
210. **The label of an event slot** (PL §3.12 "The label of an event slot",
     question 73; closes note 198). The harness gave an event slot the label its
     schema declares. It now gives it no label, since an event the harness sends
     arrives with none, and the handler fixture's writes are equal on
     confidentiality. The crate took `Slot.declared` of an event slot as a lower
     bound in `cfc-flow:max-confidentiality`, `cfc-flow:required-integrity`,
     `cfc-flow:writer-fit` and the write floor. It no longer does: the slot
     keeps the member, and a check that would need it is not decided. No corpus
     diagnostic changes.
211. **Which entries are the static part** (PL §3.1 "Which entries are the
     static part", question 70; changes note 192). The harness left out the
     entries of origin `structure` with the `declared` ones. It now leaves out
     the `declared` entries outside the argument's document and the cells of the
     generated inputs, and no other. With the small fixture, the container of
     each `map` (`titles`, `loud`) is tighter on confidentiality with the static
     part and without it, where it was equal without it: the clause of the
     elements is on the container's `enumerate` and `shape` entries, which are
     `structure` stamps. `ifElse(flag, secret, note)` is equal with the static
     part where the labeled branch is selected and tighter where it is not, and
     looser without the static part in both cases, as PL §3.5 says. One corpus
     row is looser without the static part: `pinned` of
     `dev/test/cfc-trusted-write/main.tsx`, a state cell whose own type declares
     a clause. The slot's label has that clause, and the only stored entry that
     holds it is the `declared` entry of the state cell's own document, which
     PL's table counts as the static part because it is a document on the way
     from the output to its value. PL keeps the argument's document out of the
     static part because its declared entries are the labels of inputs. The
     declared entry of a state cell's document is the label of a slot in the
     same way, and PL does not say so.
212. **`Binding.result` and `Binding.eventSchema`** (PL §1.1, question 75;
     changes note 199). `Binding.result` is the list of the result paths that
     hold the stream, the positions of a rendered tree included:
     `["$UI", "children", "0", "props", "onClick"]`. PL has the paths in source
     order. The emitter holds the members of a record by name, so the paths are
     in the order of their segments. `Binding.eventSchema` holds the schema of
     the type the handler's event declares, for every binding of the handler,
     and a body has no `eventSchema`. The corpus comparison now sends 226 events
     where it sent 145.
213. **The position of a tag that names a pattern** (PL §1.1: "the entries of
     the enclosing rendered tree at the tag's position are those of the callee's
     `[UI]`"). The run holds the callee's result at the position, with its tree
     under `$UI`, so the paths the plan names there held no value and 143
     outputs were not compared. The harness now reads a path below `$UI` where
     the run holds a result with `$UI` that is no view node and the path goes on
     with a member of a view node, or ends there. 123 more outputs are compared,
     and none is looser. The crate has the callee's tree at the tag's position
     also where the tag is the whole value of a result path
     (`controls: <Controls>...</Controls>` of the catalog stories), and PL says
     that a tag evaluates to what the pattern returns, as the call does. Which
     the plan should hold there was not decided here.
214. **The comparison over the corpus, after the rulings** (replaces the table
     of note 207).

    | | |
    | --- | --- |
    | modules attempted | 270 |
    | modules run | 213 |
    | not run: needs `wish` | 33 |
    | not run: requests an effect | 14 |
    | not run: the run's commit is refused | 10 |
    | outputs compared | 1314 |
    | equal | 0 |
    | tighter | 1190: 1170 equal before the atom of a kept output is added, 20 tighter before |
    | atom names the pattern | 124: 76 before the atom is added, 48 looser on integrity before (notes 202 and 203); 103 equal otherwise, 21 tighter otherwise |
    | looser | 0 |
    | incomparable | 0 |
    | outputs whose label is a bound, counted apart | 124 |
    | events sent | 226 |
    | write edges compared | 61: 56 equal, 5 tighter |

    Without the static part one output is looser (note 211). Not
    compared, by reason: 269 write edges the event's run did not make;
    174 rows that read a state cell of a per-element body; 113 at an
    element of a collection no output entry names; 94 at an element slot
    outside its collection; 89 below a child no pick chose; 53 outputs
    the run holds no value at; 25 over a collection whose source is not
    a stored slot; 24 with a slot of root `operation`; 12 outputs with
    no template; 10 with a `dynamic` node; 18 write targets with no
    stored cell. Of the selectors and picks the rows met, 12 were found
    from a stored value, 216 from the slot of the condition or the key,
    and 393 were not found. The runtime refuses the commit of 90 of the
    226 events ("Event handler commit terminally rejected"), in 50
    modules, and 207 of the 269 write edges not made are in those
    modules. Why each is refused was not examined.

215. **The outputs the run holds no value at.** The earlier run had 196. 143
     were at the position of a tag that names a pattern, where the run holds a
     value and its label below `$UI` (note 213): the harness did not read them.
     26 of them had an empty runtime label beside a template with a clause (12)
     or one that was not evaluated (14). The 12 are read now and are equal in
     confidentiality, 2 of them as bounds. The 14 are still not compared,
     because their template is not evaluated. Of the 53 that remain: 26 are at a
     position the run did not render, below a conditional that gave `null` or a
     string, or beyond the end of an array, and nothing is stored there; 17 are
     a link to a cell that holds no value, 6 of them in a module where an action
     of the run threw (the generated inputs, or a `computed` that throws by
     design) and 11 where a `computed` returned `undefined` or a state cell has
     no initial value; 9 hold a stored value that does not read under the schema
     of the path, because the generated input does not fit the type (a string
     where a view node is declared, a record that refers to itself), which is a
     gap of the generator; and 1 has a value once it is read on its own. In 13
     of the 53 the runtime's label is empty and the template has a clause or was
     not evaluated. In all 13 the runtime stores nothing at the path: 6 where an
     action threw (5 with a clause in the template), 5 where a cell holds
     nothing (template not evaluated), and 2 below a conditional that rendered
     `null` (with a clause). A computation that throws writes nothing, so the
     runtime stores no label for it, and PL does not say what label the compiled
     path gives the output of a body that throws. So "no output is looser in
     confidentiality" holds for every output the run holds a value at, and for 7
     outputs with no value the template has a clause where the runtime stores no
     label. Two rows counted apart as bounds have a clause where the runtime's
     label is empty: `$UI/children/0/children/0` and `$UI/children/0/children/2`
     of `system/profile-create/profile-create.tsx`, a conditional that rendered
     `null` under a condition whose label is stored and not declared. That is
     the finding of PL §3.5 against the runtime (question 69).
216. **Note 203 is not closed** (PL §3.10, question 74). The three rendered
     positions of `patterns/examples/cfc-spec-gallery/main.tsx` are now in the
     category "atom names the pattern", tighter in confidentiality by the
     caveat: the template has no clause, and the runtime's label has the caveat
     the created cell's type declares. PL assumes that a reader of the created
     cell follows the reference by §3.10, so that its template holds the
     declared clause. In the plan the reader is the body of
     `LabelDisclosureCard`, which observes the reference at `arg0/value` as
     `identity` and passes it on in `$value`; it does not follow it, so §3.10
     gives it no `dynamic` node. What follows the reference is a reader of the
     rendered position. The plan has no record that says the result of
     `makePromptInfluenceDisclosure` is the handle of the cell its `createCell`
     site made: `BodyOutput.reference` names a reference the body was given, and
     a created cell is none. The harness dereferences an `identity` slot and has
     no address for this reference. The crate is not changed.

## Why the runtime refused the events of the corpus comparison

217. **How the comparison sees what became of an event.** The harness sent an
     event with `stream.send(event)` and did not look at the outcome. It now
     sends with `sendEvent` of `runtime/runner/src/cell.ts` and a callback,
     which the runtime calls once with the transaction of the event's final
     outcome (`runFinalCommitCallback` and `notifyEventDropped` in
     `runtime/runner/src/scheduler/events.ts`). `Run.events` holds, for each
     event, whether the transaction was committed, the error it ended with, the
     reasons of a `CfcCommitRefusalError`, for a reason its gate describes
     (`runtime/runner/src/cfc/refusal-detail.ts`) the store of the refused write
     and the reads it names, and for an aborted transaction what `abort` was
     called with, which is the error the handler threw. The corpus results hold
     the same with the generated event, and `corpus.ts report` counts the
     refused events by reason. Note 214 said 90 of 226 events were refused,
     counted from the lines the runtime logs for a refused CFC commit. With the
     outcome read from the transaction, 108 were not committed, in 60 modules:
     the others are events whose handler threw, which logs no such line.
218. **Why each of the 108 was refused** (evidence: the reasons the transactions
     carry, in the results of the run before any fix).

    | Cause | Events | Modules | After the fixes |
    | --- | --- | --- | --- |
    | writer-fit names a generated clause alone: `writer-fit confidentiality misfit for <store> at <path> (canWrite, §8.12.4): "input:<name>"` | 75 | 44 | committed |
    | the same together with `cfc-envelope-stability: confidentiality cannot be weakened` | 2 | 1 | committed |
    | `cfc-envelope-stability: confidentiality cannot be weakened at /` alone | 3 | 2 | committed |
    | writer-fit names the crate's name for a policy, `{"policyOf":{...}}` | 2 | 2 | 1 committed, 1 refused |
    | the handler threw `Cannot destructure property ... of 'undefined'`: the event did not read under the type the event declares | 12 | 8 | 11 committed, 1 throws on its state |
    | the handler threw `ReadOnlyAddressError`: a plain value where the event declares a handle | 1 | 1 | committed |
    | the handler threw an error of its own on the content of the event or the state (`attach: workstreamId must name one of this person's workstreams`, `Collection choice requires a known membership state`) | 5 | 3 | 1 committed, 4 refused |
    | `handler did not run: action argument is undefined (potential schema mismatch)` | 1 | 1 | refused |
    | `writeAuthorizedBy requires a trusted verified binding identity at /` | 5 | 2 | refused |
    | `missing trusted-event policy input for <store> at /` | 1 | 1 | refused |
    | the transaction was aborted with `cfc-schema-migration-incompatible: required field name needs a default to preserve old documents` (`system/profile-create/profile-create.tsx`, `createProfile`) | 1 | 1 | refused, by writer-fit |

    No event was refused for a conflict or a read invariant: the harness
    sends one event at a time and waits for its outcome.

219. **The generated clause of an input** (the 77 rows of writer-fit over a
     generated clause; PL does not describe the scenario the comparison runs).
     The generator gave each input the clause `input:<name>`, declared at the
     root of a cell the harness makes for the input. The runtime's writer-fit
     rule (`prepareBoundaryCommit` in `runtime/runner/src/cfc/prepare.ts`, the
     block that builds the reason "writer-fit confidentiality misfit") measures
     the join of what a transaction read against the ceiling of each store it
     writes: the store's declared clauses and the audience of its own space
     (`residencyCeiling`). A store the runtime owns has its declaration widened
     instead (`tx.isRuntimeOwnedStore`), which is why the handler fixture's
     writes of a labeled input to state cells were committed. The cell of an
     input is not such a store. So the runtime refused: a write to the document
     of an object pushed onto an input list, which declares nothing
     (`addExpense` of `apps/budget-tracker/expense-form.tsx`); a write to one
     input by a handler that read another (`toggle` of
     `dev/gideon-tests/test-ifelse-both-branches.tsx` reads `condition` and
     `toggleCount` and sets both); and a write below the root of an input
     (`testEmptySimpleKey` of `dev/gideon-tests/test-record-key-set-56.tsx`).
     The refusals are correct for those stores, and the stores are the
     generator's. The clause is now
     `{ anyOf: ["input:<name>", Space(<the scenario's
    space>)] }`, which
     every store of the space admits (`atomsOutsideCeiling` in
     `runtime/runner/src/cfc/observation.ts`: a ceiling clause subsumes a label
     clause that has its alternatives) and no other input has. `createProfile`
     of `system/profile-create/profile-create.tsx` writes documents of another
     space, whose ceiling does not admit a clause that names the scenario's
     space, and is still refused.
220. **A value held from an earlier read is a view** (harness). The harness kept
     what a write target held before the event and compared it with what it held
     after. The value of an array or an object that `cell.get()` returns shows
     what a later transaction wrote, so a push onto a list that already had
     elements showed no new element, and the write was counted under "a write
     the event's run did not make". The harness now keeps the value as text and
     the number of elements. The handler fixture did not show this because its
     list starts empty.
221. **The schema an input is stored under** (the 5 rows of "cannot be
     weakened"). The harness wrote the cell of an input under the crate's schema
     for the argument's property with the generated clause added at its root. A
     handler writes the input under the schema of its own type, and the runtime
     refuses a write that declares fewer clauses at a path than the store
     declares there
     (`cfc-envelope-stability: confidentiality cannot be
    weakened`). Two
     things made the store declare more. Where the type declares clauses at its
     root (`OnlyMe<string>` of `dev/test/cfc-trusted-write/other-writer.tsx`),
     the store had the generated clause beside them. And the crate's schema
     names a policy as `{ policyOf: { module, binding } }` (the form of note
     163), which the harness stored as a clause, where the runtime's schema has
     the atom of the policy (`type: ".../atom/Policy"`, with `moduleIdentity`,
     `symbol` and `policyDigest`): `submit` and `commit` of
     `examples/cfc-exchange-rules/witnessed-chain.tsx`. The harness now writes
     an input under the schema the compiled pattern's argument has for the
     property, and the generator adds no clause where the type declares one at
     its root. Such inputs are no longer told apart by a clause of their own. A
     schema of the plan cannot stand for the runtime's schema wherever it holds
     a `policyOf` record, and PL does not say that the two differ there.
222. **`Binding.eventSchema` of an `action`** (PL §1.1: "the schema of the type
     the handler's event declares"). The crate had the type of an event for
     `handler(...)` alone. An `action` declares it as the annotation of its
     parameter, `action(({ index }: { index: number })
    => ...)`, or as its
     type argument, `action<{ index: number }>(...)`, and its binding had no
     `eventSchema` and its event slots no schema. The generator then made a
     string at each path the body reads, the runtime read the event under the
     declared type as no value, and the body threw on its parameter (12 events:
     `toggleIndent` of `examples/simple-list/simple-list.tsx`, `removeItem` of
     `examples/todo-list/todo-list.tsx`). `handler_body` in `src/plan.rs` now
     records the type of the first parameter of an `action`. An inline handler
     still has none.
223. **A handle in an event** (generator). `getValue` of
     `showcase/dice/dice-handlers.ts` declares
     `{ result?:
    Writable<string> }` and sets `result`. A plain value sent
     there is read as a handle that cannot be written
     (`ReadOnlyAddressError:
    Cannot write to read-only address: snapshot:...`).
     The generated event leaves out a member that is declared as a handle and is
     not required. A required one keeps its plain value: `moveToPile1` of
     `showcase/card-piles/main.tsx` reads `detail.sourceCell` and does not write
     it.
224. **What is still refused: 14 events in 9 modules.**

    | Cause | Events | Whose |
    | --- | --- | --- |
    | `writeAuthorizedBy requires a trusted verified binding identity`: `rewriteDigest`, `replaceWithText`, `replaceTags` of `dev/test/cfc-trusted-write/frozen.tsx`, `repin` and `overwrite` of `main.tsx` there | 5 | the patterns': each handler is written to be refused |
    | `missing trusted-event policy input`: `pinDraft` of `dev/test/cfc-trusted-write/main.tsx` | 1 | the scenario's: the handler takes an event with the integrity of a trusted surface, and the harness sends a plain one |
    | the handler throws on the content of the event or the state: `attach` of `apps/person-workbench/main.tsx`, `pin` and `rename` of `apps/work-snapshot/main.tsx`, `chooseMembership` of `system/shared-space/shared-space-collection.tsx`, `fireShot` of `showcase/battleship/multiplayer/room.tsx` | 5 | the generator's: a value of the declared type that the handler does not accept |
    | `handler did not run: action argument is undefined`: `onClick#2` of `dev/self-reference-test/self-reference-test.tsx` | 1 | the crate's schema: a type that refers to itself has `{}` at the reference, so the generated `parent` holds strings where records are declared, and the handler's state does not read |
    | writer-fit names the atom of the pattern's own policy at the input `terms`: `propose` of `examples/cfc-exchange-rules/custody-projector.tsx` | 1 | the harness's: the input's cell is not a store the runtime owns, so its declaration is not widened |
    | writer-fit names the generated clause at documents of another space: `createProfile` | 1 | the generator's (note 219) |

    None of them looks like a fault of the runtime.

225. **The comparison over the corpus, after the fixes** (replaces the event and
     write rows of note 214).

    | | before | after |
    | --- | --- | --- |
    | events sent | 226 | 226 |
    | events committed | 118 | 212 |
    | write edges compared | 61 | 144, and 1 whose label is a bound |
    | equal | 56 | 131 |
    | tighter | 5 | 11 |
    | looser | 0 | 2 |
    | incomparable | 0 | 0 |
    | write edges the event's run did not make | 269 | 133 |

    The 226 handlers that get an event have 354 write edges. Of the 133
    not made, 26 are in the 9 modules with a refused event and 107 in
    modules where every event was committed: the handler returned
    before the write for the generated values. 18 have a target with no
    stored cell, and the rest have a template the harness does not
    evaluate. The 11 tighter rows are tighter in confidentiality and
    equal in integrity; they were not examined one by one. The outputs
    are 1,313 compared where they were 1,314, with 0 looser, 0
    incomparable, 124 "atom names the pattern" and 1,189 tighter. The
    one output less is `$UI/children/2/children/0/props/$cell` of
    `dev/self-reference-test/self-reference-test.tsx`: under the
    runtime's schema the generated `parent` does not read (note 224,
    fourth row), where under the crate's schema it did. Two modules
    whose first commit is refused are refused for another reason now,
    `writeAuthorizedBy requires a trusted verified binding identity`
    where it was `unsupported trust-sensitive ...`
    (`dev/test/writer-policy/main.tsx`,
    `examples/cfc-exchange-rules/custody-answer-room.tsx`): the input's
    store declares the runtime's schema, and the harness is not the
    writer it names.

226. **The two looser write edges: a handle the body passes on** (PL §2.2, the
     table of slot classes: the label of an `identity` slot is what "a journaled
     read" of shape `followRef` at the slot's address consumes). `joinAsP1` of
     `showcase/battleship/multiplayer/repro-minimal.tsx` sets `data1` and passes
     `data1` and `data2` to `Child(...)`. The plan has both as `identity` slots
     in the body's reads, and the write's template is the `derive` over them.
     The harness reads the label of an `identity` slot as the `followRef`
     entries of the label view at the cell the slot resolves to, which for
     `data2` is the generated clause of the input: the argument reaches the
     input's cell through a link, and the clause is declared at the cell's root
     for every class. The label the runtime stored for `data1` has the clause of
     `data1` and not that of `data2`. So the template is looser by the clause of
     an input whose handle the body passes on and does not read through.
     `joinAsP2` is the same with the inputs exchanged. Either the run journals
     no `followRef` read for a handle that is only passed on, or its join does
     not hold what such a read consumes; which was not found here. PL defines
     the slot's label by a read that this run does not show, and does not say
     whether a body that passes a handle on reads the reference.
227. **Events for per-element handlers.** 385 bindings of the modules run have a
     `within` step, with 511 write edges, and get no event. It takes three
     things. The plan has no `Binding.result` for such a binding: PL §1.1 has
     the paths "at which the instance stores a link to the stream" and does not
     say how a path names the position inside an element, so the path would need
     a `*` step as an output's path has. The harness would choose an element of
     each collection of `within`, resolve the stream at that index, and evaluate
     the write's template and the binding's state with that element bound; today
     a write row is evaluated with no element. And the state cells of a
     per-element body have no address the harness can form (174 rows are not
     compared for that reason already), so a write whose target or template
     names one would still not be compared. It was not built.

## Ruling U1, the comparison rules of PL §3.1, and the write edges examined

228. **The label of a handle that is passed on, and the `link` entry** (ruling
     U1; PL §2.2 "The label of an `identity` slot", §3.9 "A handle a body passes
     on"; closes note 226). PL has the label of an `identity` slot as what a
     `followRef` read consumes at the position that holds the reference, "the
     `link` entry of the stored link, and the stamp of the run that wrote the
     link", and says the result is equal to today for `joinAsP1` of
     `showcase/battleship/multiplayer/repro-minimal.tsx`. The harness read the
     slot that way before the ruling, and the two rows are still looser by the
     clause of the input whose handle is passed on. What the run stores, read
     from the documents after the event: the argument document holds at `data1`
     and at `data2` one entry each of origin `link`, with the clause of that
     input. An entry of origin `link` holds what the schema of the link declares
     and what the link carries (`prepareBoundaryCommitSteps` in
     `runtime/runner/src/cfc/prepare.ts`, where it persists the result of
     `linkLabels.persisted`), and the schema of a link to a cell is the cell's
     own, so the entry repeats the clause the cell's type declares. The
     transaction of `joinAsP1` reads the argument document at `value/data1` and
     the document of `data1` at `value`, and reads neither the argument document
     at `value/data2` nor the document of `data2` (`getReadActivities` of the
     transaction before its commit). The document the same transaction writes
     for the child's argument, which holds the links to both cells, has stamps
     with the clause of `data1` alone. So the run makes no `followRef`
     observation of a link it only passes on, where PL §2.2 says "a probe of a
     reference that the transaction does not follow is a `followRef`
     observation". The harness keeps PL's rule as the row's template and holds a
     second label beside it, `WriteRow.templateWithoutPassedLinks`: the entries
     of origin `link` are left out of the label of each `identity` slot that no
     write edge of the body targets. With it both rows are equal. PL does not
     say that the `link` entry of a link to a cell holds the cell's declared
     clause, and the ruling's "nothing of the label of its cell" does not hold
     for the slot as PL defines it wherever the link's schema declares a label.
229. **A write row beside the target's declared label, and an edge that passes a
     reference on** (PL §3.1 "A write edge of a handler"). The template's side
     of a write row is now joined with the entries of origin `declared` in the
     document that holds the written value. For an edge with a `reference`
     member it is also joined with what a value read through the stored link
     consumes. PL does not say what the integrity of such a row is. The template
     of the edge mints the body's atom, and with it the row had one atom more
     than the runtime's label, in 6 corpus rows (`boundSelectRoom` of
     `examples/scoped-group-chat/main-plain-inputs.tsx`, `moveToPile1` of
     `showcase/card-piles/main.tsx`). The harness takes the atom as one on the
     link: the row has the integrity of the value read through the link, as a
     read has with a stored `followRef` entry, whose integrity the harness
     leaves out (`consumed` in `compare/harness.ts`).
230. **Where an `identity` slot is dereferenced** (PL §3.1 "What is compared").
     `TemplateInputs.slot` of `compare/template.ts` takes a third argument that
     says whether the slot stands for the value the template passes on: the
     `slot` node that is the template, the selected branch of a `select`, and
     the body of a `pick`. The harness joins the value read of the slot's path
     only there. PL names "the chosen child of a `pick`"; the evaluator takes
     the body of the `pick` at the chosen child. An input of a `derive`, a
     condition, a choice and the body of a `fold` have the label of the link.
231. **The static part by document** (PL §3.1 "Which entries are the static
     part"; closes the last part of note 211). The harness keeps the `declared`
     entries of the argument's document, of the cell of each generated input,
     and now of each state cell the manifest names. `pinned` of
     `dev/test/cfc-trusted-write/main.tsx` is tighter without the static part
     where it was looser, and no corpus output is looser without the static
     part. A cell that a site of a body created is read through the stored link
     (note 232) and has no address in the harness, so its document is not in the
     set; no corpus row depends on it.
232. **A reference a site of a body made** (PL §3.9 of that name, §3.1 "A
     reference whose target no slot names", §3.11 "What a materializer returns";
     closes notes 203 and 216). The crate did not change. It writes what a
     materializer returned as the template of the materializer's body, a
     `derive` with no input for the three `lift`s of
     `examples/cfc-spec-gallery/main.tsx`, where PL has "a slot with root
     `operation`". The two have the same label there, and the harness has no
     reading for a slot of root `operation`. The harness takes an output as one
     that passes on a computed reference where its template is the template of a
     materializer's body, or a `derive` by a body that has an `identity` entry
     of `Body.computed`, and joins the template's side with what a value read
     through the stored link consumes. For the first form the link is the one at
     the output path. For the second the body's result holds the reference at a
     path the plan does not name: the three corpus rows are the tree an authored
     function returns, with the handle at `children/0/children/3/props/$value`
     below it. The harness takes every link stored below the path in the
     document that holds the value, and cannot tell the link of the reference
     from another link there. The three rows are equal in confidentiality, and
     so are five outputs of `examples/cfc-render-policy-demo/main.tsx` that were
     tighter by a clause a created cell's type declares. Without the atom of a
     kept output they are looser in integrity, as before (note 203): the
     document of the tree has stamps with the caveat on every path and an atom
     beside them, so the run of the node that built the tree had the caveat in
     its join. Which read brought it in was not examined; PL §3.9 expects it
     ("tighter for a re-evaluated body ... where the runtime stamps the join of
     the whole run").
233. **The two classifications of a row** (PL §3.1 "The atom of a kept output").
     `corpus.ts report` prints for each category the outputs classified without
     the atom of a kept output and with it, and for write edges a column with
     the link entries of a passed handle left out (note 228). `tally` of
     `compare/corpus.ts` counts them.
234. **`Binding.result` in source order** (PL §1.1). The emitter holds the
     members of a record by name, so the order is formed from the paths
     (`stream_at` in `src/plan.rs`): the members of the record the pattern
     returns in the order its object literal writes them, in a view node the
     attributes before the children, and the children by position, compared as
     numbers. Two things are not source order: the members of a record nested
     below a result path are in the order of their names, and so are two
     attributes of one element.
235. **A tag at a child position, and anywhere else** (PL §1.1; closes the open
     point of note 213). `jsx_pattern` in `src/plan.rs` returned the callee's
     `[UI]` wherever the tag was written. It now does so for a tag at a child
     position of a view node, and a call or a variable there that evaluates to a
     record with `$UI` is the same. At any other place the tag is the callee's
     result, with the tree below `$UI`: the outputs of
     `controls: <Controls>...</Controls>` in the catalog stories are at
     `controls/$UI/...`. Before the change a variable that holds the result of a
     pattern, written as a child, had the whole result at the position: the
     corpus has 2,584 edges where it had 2,616, and the comparison has 12
     outputs fewer, which were members of a result beside its `[UI]` at a child
     position.
236. **A type that contains itself** (PL §1.5 "A recursive type, and what is
     hashed"). Not done. `src/schema.rs` writes `{}` at the reference, as
     before. The type checker ends a declaration that reaches itself with
     `Shape::Unresolved(Why::Recursive)` (`src/types.rs`), which names no
     declaration, and a type has no record of the name it was declared under.
     PL's rule needs both: the declaration each reference leads to, and the
     declared name for the member of `$defs`. `onClick#2` of
     `dev/self-reference-test/self-reference-test.tsx` is still refused for that
     reason (note 224).
237. **`Binding.eventSchema` of an inline handler** (PL §1.1). An inline handler
     whose parameter has an annotation now has the schema of that type. One
     without an annotation has none: PL has "the type the checker gives its
     parameter", which comes from the type of the attribute the handler is
     written at, and the crate has no types for the attributes of a host
     element. `Binding.result` for a binding of an element body (PL §1.1,
     question 78) was not built.
238. **The tighter write rows.** Each of the 9 rows that are tighter in the last
     run has clauses in the runtime's label that the template lacks, and in each
     the clauses are held by a `derived` entry of class `shape` at the written
     path or below it, which an earlier event of the same scenario stamped. The
     later write replaced the `value` entry with its own join and left the
     `shape` entry. `prepareBoundaryCommitSteps` carries such an entry forward
     until the path is created again; its comment calls the entry left by a
     deletion a known residual. So the rows are tighter because the template has
     the label of this write alone, and the runtime's label also has the
     existence label of what an earlier write stored. None is tighter because
     the template leaves out a read of the handler.

    | Row | The clauses the template lacks | The entry that holds them |
    | --- | --- | --- |
    | `clearLogs` write 0, `dev/gideon-tests/test-record-key-set-56.tsx` | `emptyRecord`, `populatedRecord` | `shape` at `2` to `6` and `length` of the list, which is now empty |
    | `onClick#3` write 0, `examples/map-demo/map-demo.tsx` | `center`, `zoom` | `shape` at `2` and `length` of `areasOfInterest`, now empty |
    | `onClick#4` writes 0 and 2, the same module | `selectedStopIndex` | `shape` at the root of `areasOfInterest` and of `stops`, from `onClick#3` |
    | `closeModal` writes 0 to 2, `examples/text-swapper/text-swapper.tsx` | `leftText` | `shape` at the root of each state cell, from `openEditLeft`; the handler's own join is empty and stores no `value` entry |
    | `restart` write 0, `showcase/wordsearch/play.tsx` | `puzzle` | `shape` at `at` and `index` of the state cell `anchor`, from `tap` |
    | `cancelJob` write 1, `system/cfc/trusted-surfaces/long-running-job.tsx` | `jobAuthorization` | `shape` at the root of `jobStatus`, from `startJob` |

239. **The write edges an event's run did not make.** The results now name them
     (`ModuleResult.notMade`). Before the change of the generator below, 132
     were not made: 17 in events the runtime refused, and 115 in events that
     were committed, in 35 modules. 40 of the 115 were read against the
     handler's source and the generated values. None shows a fault of the
     harness or of the runtime: in each the handler did not store a new value.

    | Cause | Edges read | Examples |
    | --- | --- | --- |
    | The handler writes the value the target already holds, and the storage layer stores no write of an equal value | 13 | `increment`, `decrement`, `reset` of `product/primitives/counter.tsx` (every generated number is 3, so `clamp` gives 3); `setStatus`, `setRating` of `examples/reading-list/reading-item-detail.tsx`; `toggleWithLogging` of `examples/cf-checkbox-cell/cf-checkbox-cell.tsx`; writes 2 to 4 of `saveEdit` and writes 0 and 2 of `openEditRight` of `examples/text-swapper/text-swapper.tsx`, after an earlier event of the scenario |
    | The handler returns before the write, or does not take the branch, on the generated event | 7 | `toggleIndent`, `setIndent`, `deleteItem` (2) of `examples/simple-list/simple-list.tsx` (index 3 in a list of two); `select` of `product/primitives/option-picker.tsx` (the option is not among the options); `handleTitleKeydown` of `apps/weekly-calendar/event.tsx` (the key is not `Enter`); `rename` of `examples/scoped-user-directory/main.tsx` |
    | The same, on the state an earlier event of the scenario left | 4 | writes 0 and 1 of `saveEdit` (the side being edited is `null` after `closeModal`); writes 1 and 2 of `tap` of `showcase/wordsearch/play.tsx` |
    | The event's type is a string and the generator sent `{}` | 4 | `navigate` of `examples/router/router.tsx`; `setForwardRecipient`, `setResearchCommand`, `setSafeLinkSource` of `examples/cfc-spec-gallery/main.tsx` |
    | The handler removes an element by identity, and the object of the event is no element of the list | 4 | `removeItem` (2) of `examples/todo-list/todo-list.tsx`; `removeItem` of `product/primitives/check-list.tsx`; `removeEntry` of `product/primitives/amount-ledger.tsx` |
    | An edge at the elements of a list, where the run stored no new element | 2 | write 1 of `archiveCompleted` of `examples/todo-list/todo-list.tsx` and of `clearCompleted` of `product/primitives/check-list.tsx` |
    | The written value depends on `Math.random` | 6 | `shuffle` (4) of `showcase/card-piles/main.tsx`; `roll` of `showcase/dice/dice.tsx`, which differs from run to run |

     The generator now gives an event values an input does not have: 1 for
     a number, which is an index inside a generated array, `false`, and the
     last member of an `enum`. An event whose declared type is a string, a
     number or a boolean is that value. 13 more edges are made, and the
     comparison has 152 write rows where it had 144.

240. **The comparison over the corpus, after ruling U1** (replaces the output
     rows of note 214 and the table of note 225). "Before" is the run at the
     start of this work, which differs from note 225 by one row of
     `showcase/dice/dice.tsx`.

    | | before | after |
    | --- | --- | --- |
    | outputs compared | 1,313, and 124 bounds | 1,301, and 124 bounds |
    | without the atom of a kept output: equal | 1,169 | 1,165 |
    | tighter | 20 | 15 |
    | atom names the pattern | 76 | 74 |
    | looser | 48 | 47 |
    | incomparable | 0 | 0 |
    | with the atom: tighter | 1,189 | 1,180 |
    | atom names the pattern | 124 | 121 |
    | looser, incomparable | 0, 0 | 0, 0 |
    | looser without the static part | 1 | 0 |
    | events sent, committed | 226, 212 | 226, 212 |
    | write edges compared | 143, and 1 bound | 152, and 1 bound |
    | equal | 130 | 141 |
    | tighter | 11 | 9 |
    | looser | 2 | 2 |
    | looser with the link entries of a passed handle left out | not measured | 0 |
    | write edges the event's run did not make | 133 | 120 |

    The 47 outputs that are looser without the atom are looser in
    integrity alone, by notes 202 and 203. The 12 outputs fewer are by
    note 235. The 2 looser write edges are those of note 228. The 2 write
    edges that were tighter and are equal are `submit` and `plantBrief` of
    `examples/cfc-exchange-rules/witnessed-chain.tsx`, whose target declares
    a policy clause that the template's side now has (note 229).

## Events for handlers bound in an element body or in a pattern compiled in

241. **What the 385 bindings of note 227 are** (corrects notes 227 and 237).
     Note 227 calls them "per-element handlers". Of the 385 bindings of the
     modules run that have a `within` step, 71 have an `element` step, with 117
     write edges, and 314 have `site` steps alone, with 394: handlers bound in a
     pattern compiled in at a tag or a call. The corpus run sent no event to
     either kind because it left out every binding with a step. Likewise no
     state cell of the modules run has an `element` step: the 723 with a step
     have `site` steps alone, and the 88 rows not compared for "a state cell of
     a per-element body" were output rows that read a state cell of a pattern
     compiled in.
242. **`Binding.result` for a binding of an element body** (PL §1.1 "The result
     paths of a binding in an element body"; question 78). The assembled result
     of a `map` holds the stream paths of what its callback returns below `*`
     (`collection` in `src/plan.rs`), the children of a view node from a spread
     on hold them where one collection is spread there (`jsx_children`), and
     `stream_paths` reads the paths of a member that is a value with paths of
     its own. Three things follow that PL does not state.

     - A callback that returns the tag `<Row item={item} />` has the path
       `children/*/$UI/props/onClick`. PL has "a `site` step adds no segment,
       because the callee's tree is in place at the call", and also that a tag
       anywhere but at a child position "evaluates to the callee's result ...
       with the callee's tree below `$UI`". What a callback returns is no child
       position, so the element is the callee's result. The run of today stores
       the stream at that path (`compare/fixtures/element-handlers.tsx`).
     - The same walk gives a path to a binding in a tree held in a variable and
       in the tree of a pattern compiled in at a child position. Neither had one
       before: 65 more bindings with `site` steps alone have a path (76 of 314).
     - A binding made outside every element body whose stream is written in an
       element body, `items.map((item) => <li onClick={inc} />)`, has a path
       with `*` and no `element` step. PL forms the path with "one `*` for each
       `element` step of `within` whose collection the path passes through",
       which says nothing of a collection the binding is not within. The emitter
       lists the path; every position holds the one stream
       (`compare/fixtures/outer-stream.tsx`).

     Over every accepted plan, 127 of 202 bindings of a handler in an element
     body have a path, and `plan --corpus` prints the count. In the modules run,
     65 of 71 have one.
243. **Where the rule gives no path** (PL §8, question 78). The emitter gives a
     binding of an element body no path, and lists it with the reason in
     `PatternPlan.element_bindings` and as `noResultPath` in the JSON, in two
     cases. Two collections spread into one array of children: 15 bindings over
     every plan, 2 in the modules run. PL gives a path there too, "the `*` of
     each binding's path stands for the positions of its own collection alone,
     which the runtime knows from how it assembled the array". The emitter emits
     none. The reason is in PL §8, question 78: what is assumed there is the
     resolution of the path, "in particular where two collections are spread
     into one array of children, where the path alone does not say which
     positions are whose", and the alternative PL names gives the path a segment
     that names the collection. A reader that has the path and the stored array
     alone, as the comparison harness has, cannot choose a position of one
     collection there, so a path would name a position no reader of this
     prototype can resolve. A stream at no kept path of what the callback
     returns: 60 over every plan, 4 in the modules run (one `detachRow` of
     `apps/person-workbench/main.tsx`, `toggleEmojiPicker` and one
     `toggleReaction` of `examples/group-chat-room/group-chat-room.tsx`,
     `setProfileRetired` of `system/profile-picker/profile-picker.tsx`). The
     four were not read one by one, so some may be at a position the emitter
     does not follow, as through a `computed`. A third case is outside the rule:
     208 bindings with `site` steps alone in
     `examples/cfc-trusted-component-examples/` are made in patterns whose
     results an array literal holds, and the tree reaches them through the
     elements of that array,
     `renderedExamples.map((example) => <div>{example[UI]}</div>)`. The path
     passes through a collection the binding is not within, at a member of the
     element and not of what the callback constructs. They have no path.
244. **A stream in a branch of a `select`** (PL §1.1). PL has "the paths of the
     result at which the instance stores a link to the stream" and does not say
     whether a position that holds the stream under one selection is one. The
     emitter lists it (`select_in`): 27 more bindings of an element body in the
     modules run have a path, and 10 more of no step. The run holds no stream
     there while the other branch is selected, and the harness then tries the
     binding's next path.
245. **From a path to a position, in the run of today** (PL §1.1 "From a path to
     a position"). PL has "the index of that position in the stored array ...
     plus the number of children stored before the spread". The run of today
     does not store the children as one array. The assembled array of a `map`
     over a cell is one child, at the position the expression is written at, so
     the stream of element `i` is at `children/k/i/...` (`streamAt` in
     `compare/harness.ts`, which finds `k` as the one child whose value is an
     array). A `map` over an array of the module, `COLORS.map(...)`, is
     evaluated when the tree is built and its elements are stored in place among
     the children; the path does not say how many children are stored before
     them, and the harness sends no event (2 bindings: `selectColor` of
     `apps/weekly-calendar/event.tsx`, `toggleReaction` of
     `examples/group-chat-room/group-chat-room.tsx`). The harness chooses the
     last position of each enclosing collection. The generator gives an array
     two elements, so that is position 1 unless an earlier event of the scenario
     added or removed one.
246. **How the run of today addresses a state cell of another instance.** Each
     instance of a pattern has a result document of its own: the pattern of the
     scenario, each run of an element callback, and each pattern at a tag or a
     call. The `internal` metadata of that document lists the cells the
     instance's body made, a state cell under the name of its declaration
     (`partialCause`), and its `argument` metadata links to the instance's
     argument document. The plan has no record that says where the result of a
     `site` step is stored, so the harness finds the instance among the
     documents the stored links lead through on the way from the result to the
     row (`instancesAlong`, `stateCell`): the stream's path for a write row, the
     output's path for an output row. Where the way has one instance for each
     step of the binding's `within`, the cell's instance is the one at the depth
     of the cell's own steps, and otherwise the one instance on the way that
     names the cell. 88 more output rows are compared, 87 and one bound, each
     tighter with the atom of a kept output and equal without it.
247. **Where a handler is given the handle of its element** (PL §2.2 "It is the
     label of the link": "the position that holds the reference: the path of the
     document the body was given the handle from, such as a path of the argument
     document or of a binding's state document"). The plan binds such a state
     path to a slot of root `element`, and the harness read the slot at the
     position in the source list. The run of today reads it elsewhere: the
     argument document of the element's instance holds the element at `element`,
     a link to the position in the source, with an entry of origin `link` that
     holds the clause the source's cell declares. `askToRetire` of
     `system/profile-picker/profile-picker.tsx` calls `spaceOf(profile)` on the
     handle of its element and sets a state cell. Its transaction reads the
     instance's argument document at `value/element` and `value/params`, and the
     list document at `value/1` and at the link probe below it, and what it
     stores for the write has the clause of the input `profiles` and a
     `TransformedBy` atom. With the slot read at the source position the
     template had no clause and minted no atom: tighter in confidentiality and
     looser in integrity. The harness now reads the `identity` slot of a state
     path that is the element itself at `element` of the instance's argument
     document (`elementHeldAt`), in a write row, and the row is equal. PL does
     not say which stored position an `element` slot of class `identity` has in
     a run of today.
248. **One rule for a write row, and a `resolved` slot** (PL §2.2 "The `link`
     entry of a handle that is only passed on is not in it"; replaces the two
     columns of notes 228 and 233). `WriteRow.template` takes the `identity`
     slot of a handle the body only passes on as the entries of class
     `followRef` at the position that are not of origin `link`.
     `WriteRow.looserByLinkStamp` says whether a row is looser or incomparable
     and is not with the label of each such slot left empty; the corpus has no
     such row. The harness takes a handle as only passed on where no write edge
     of the body targets its slot and the slot has no `resolved`. PL has the
     entry out "where the body neither reads nor writes through the handle". A
     body that calls `spaceOf` on a handle reads nothing through it, so by that
     sentence the entry is out, and the run of note 247 consumed it. PL does not
     say whether the `link` entry is in the label of a `resolved` slot, or of a
     handle the body compares.
249. **The comparison over the corpus, with events for the handlers of an
     element body and of a pattern compiled in** (adds to note 240). The events
     of the bindings with no step are sent first, so that what their runs find
     stored is what it was.

    | | no step | `site` steps alone | an `element` step |
    | --- | --- | --- | --- |
    | bindings of a handler, write edges | 266, 413 | 314, 394 | 71, 117 |
    | with a result path, write edges | 236, 371 | 76, 102 | 65, 108 |
    | events committed | 214 | 75 | 55 |
    | refused | 14 | 0 | 1 |
    | not sent | 8 | 1 | 9 |
    | write edges compared | 154, and 1 bound | 66 | 14 |
    | equal | 145 | 66 | 8 |
    | tighter | 9 | 0 | 6 |
    | looser, incomparable | 0, 0 | 0, 0 | 0, 0 |
    | write edges the event's run did not make | 120 | 19 | 30 |
    | a write edge whose target is the stream of a binding | 7 | 7 | 23 |
    | a slot below a child no pick chose | 32 | 0 | 20 |

    The 152 rows of note 240 are unchanged under the one rule: 143 equal
    and 9 tighter. The two rows more are of bindings that have a path
    through a `select` (`toggleSidebar` of `dev/catalog/catalog.tsx`,
    `incrementHandler` of
    `dev/gideon-tests/test-onclick-ifelse-simple-cell-working.tsx`). The
    14 refused events are those of note 224. The one refused event of an
    element body is `setProfileRetired` of
    `system/profile-picker/profile-picker.tsx`, which throws on the
    generated lists. The 8 and 9 not sent are paths in a branch that is
    not selected, a collection with no element, and the two of note 245.
    The outputs are 1,388 compared and 125 bounds, with 0 looser and 0
    incomparable with the atom, and the 1,425 rows of note 240 are
    unchanged. The 6 tighter rows of an element body were not examined
    one by one: four are writes of `center` and `zoom` in
    `examples/map-demo/map-demo.tsx`, whose documents hold entries of
    earlier events of the scenario, as the rows of note 238 do.

250. **What is still not compared of those handlers.** A write edge whose target
     is the stream of another binding, as an inline handler that calls
     `remove.send({ index })` has: nothing is stored at the target, and the
     write of the handler it reaches belongs to another event. A binding with no
     result path may be reached this way alone, as `boundIncrement` of
     `examples/nested-counter/nested-counter.tsx` is, and the harness sends it
     no event. A slot whose path has `*` for every element of a list the handler
     reads, `expenses/*/id`: the harness has no reading for it outside a `pick`.
     A collection whose source is an output, `filter(...).map(...)`: 4 rows. The
     outputs below `children/*` are not compared either ("an element of no
     listed collection", 113): the plan has no output with a `collection` at the
     path of the children, and the run stores the element at `children/k/i`
     (note 245).
251. **A read of the result that failed after an event.** In one run of the
     corpus, with the events in the order of the plan, the read of the result
     after `onClick#1` of `examples/map-demo/map-demo.tsx` for the third element
     of `areasOfInterest` (`center.set(area.center); zoom.set(13)`) threw
     `Doc path should never exceed selector path` (`traverseWithSelector` in
     `runtime/runner/src/traverse.ts`). With the events of the bindings with no
     step sent first it did not. It was not examined. The harness records such a
     failure with the event (`EventOutcome.afterwards`) and goes on.

## The order of the events, three looser rows, and the tighter rows of element bodies

252. **Why three write rows were looser with the events in the order of the
     plan** (closes the question of note 249 on the order of the events). The
     rows are of `examples/map-demo/map-demo.tsx`: writes 0 and 1 of the inline
     handler of an area's button (binding 9, `center.set(area.center)`), and
     write 1 of the inline handler of the reset button (binding 12). None is
     looser because the template names a read the handler does not make, and
     none because the runtime stores less than its rules say. In the order of
     the plan three events leave a cycle of two links. `addAreaHandler`
     (binding 8) stores `center.get()` in a new area; what a `get` returns of an
     object is a view of the cell, so the area's `center` holds a link to the
     cell of the input `center`. The event of binding 9 goes to the last
     element, which is that area, and sets the cell of `center` to a link to the
     area's `center`. After it the cell of `center` holds the link, with an
     entry of origin `link` and one of origin `structure` and class `followRef`
     at its root, each with the clauses of `areasOfInterest`, `center`, `stops`
     and `zoom`: the clauses of the template. The transaction read
     `element/center` and `params/center` and `params/zoom` of the element's
     argument document, the area's document at `center`, and the cells of
     `center` and `zoom`. The harness read the runtime's label through
     `cfcLabelViewForResolvedCell`, whose resolution throws at a cycle; the
     runtime then returns the entry of the first link alone, the clause of
     `center`, and says that the read failed, and the harness did not read that
     status. The third row is of an event the runtime dropped ("Event dropped:
     dependency preflight failed"): the harness takes a target with no value
     before the event as written, and the cell of `center` had none before and
     after.
253. **A label the runtime fails to read.** The harness reads every label of the
     run through `cfcLabelViewForResolvedCellWithStatus` (`labelView` in
     `compare/harness.ts`), and a row that needs a label the runtime failed to
     read is not compared, under the reason "a label the runtime fails to read".
     PL §3.1 does not say what the runtime's side of a row is at a path where a
     read resolves no value. `compare/fixtures/link-cycle.tsx` has the two
     handlers that leave the cycle.
254. **An event that was not committed.** The write edges of an event the
     runtime refused or dropped are listed under "a write edge of an event not
     committed", and none is compared. Before, they were counted with the write
     edges an event's run did not make, 17 of the 132 of note 239, and a target
     that held no value made a row. Over the corpus the count of "a write the
     event's run did not make" is 151 where it was 169, and 18 are under the new
     reason. `compare/fixtures/handler-throws.tsx` has a handler that throws
     before its write.
255. **The template of a write edge is evaluated before the event.** The harness
     evaluated it after the event. A slot of a cell that the handler reads and
     writes then has the label of the run's own write, which holds every clause
     the run consumed, so a template that lacks a read of the handler was
     compared as equal: with the read of `label` taken out of the template of
     `count` in `compare/fixtures/input-writes.tsx`, the row was equal, and it
     is tighter now. The harness evaluates the templates of a handler's write
     edges on what is stored before it sends the event (`writeTemplates`), which
     is what the handler's transaction reads, and reads the runtime's side after
     it. This is the rule that does not depend on what the event itself stores.
     PL §3.1 says what a write row compares and not on which state the
     template's slots are read. No row of the corpus changed its category with
     it. The choices of a `select` and a `pick` are counted once for an edge,
     where they were counted for each path the run wrote.
256. **The read that throws at a cycle of links** (closes note 251). The read of
     the result after the event of binding 9 throws
     `Doc path should never exceed selector path` because the result holds
     `areasOfInterest`, whose last element holds the link into the cycle. The
     read is `Cell.pull` of the result under the pattern's result schema, and
     the stored values were made by `Cell.set` and `Cell.get` alone, so the
     harness's read is well formed. Reduced, with the runner alone: a cell `a`
     that holds a link to `b` at `center`, where `b` holds
     `{ center: <a link to a> }`. A `get` of `a` throws `Link cycle detected`
     from `resolveLink`. A `get` of `b` under a schema with the property
     `center` throws the other message. `followPointer` in
     `runtime/runner/src/traverse.ts` finds the cycle and returns "not found"
     with the address of the link it stopped at, `["value", "center"]`, and the
     selector it had already rooted at the link's target, `["value"]`;
     `#traversePointerWithSchema` passes the two to `traverseWithSelector`,
     which throws on a document path longer than the selector's. The runtime was
     not changed.
257. **The six tighter rows of handlers in an element body** (replaces the last
     sentence of note 249). One has the cause of note 238. The others do not.

    | Row | What the template lacks | The entry that holds it | Cause |
    | --- | --- | --- | --- |
    | write 2 (`zoom.set(14)`) of the handler of a stop's button, and write 2 (`zoom.set(13)`) of the handler of an area's button, `examples/map-demo/map-demo.tsx` | `areasOfInterest`, `selectedStopIndex`, `stops` | The `derived` entry of class `value` at the root of the cell of `zoom`, which this event's run wrote | The run's own join. The transaction reads `params/center`, `params/zoom` and `element` of the element's argument document, whose entries of origin `structure` at `*` and `params/*` have the five clauses: the stamp of the run of the `map` that wrote that document. The harness reads the slots of `center` and `zoom` at the pattern's argument, as the plan's state entries place them |
    | write 0 (`center.set(...)`) of the same two handlers | the same three | The entries of origin `link` and of origin `structure`, class `followRef`, at the root of the cell of `center`, which this event's run wrote; the document of the element, through the stored link, has `areasOfInterest`, `center`, `stops`, `zoom` | The same join. The run stored a link, which the edge with `reference` (write 1) describes, and that row is equal; write 0 is the edge for a value |
    | write 0 of `selectRoomRef`, `examples/scoped-group-chat/main-with-writable-inputs.tsx` | `draft`, `name`; the integrity atom is the template's alone | `derived` entries of class `shape` at `room/messages/2` and `room/messages/length` of the cell of `selectedRoom`, from `send` | Note 238: the run wrote the link at `room` alone, and the entries below it are of what `send` pushed while the room was stored in place. The run stored no `value` entry at the root, so a read there has no atom |
    | write 0 of `setDefaultProfile`, `system/profile-picker/profile-picker.tsx` | nothing in confidentiality; the template has the body's atom and the runtime's label has none | One entry at `profile` of the cell of `defaultProfile`: origin `structure`, class `followRef`, with the clauses of `defaultProfile` and `profiles` | The run stored a link. Write 1, the edge with `reference`, is equal; write 0 is the edge for a value, and a read through the link has the integrity of the target |

     With the events in the order of the plan, before any event wrote the
     clauses of `areasOfInterest` and `selectedStopIndex` anywhere, the two
     rows of the stop's handler are tighter by `stops` alone, the entries of
     the element's argument document have `stops` alone, and the `shape`
     entry at the root of `zoom` has `center` and `zoom`. So no entry an
     earlier write left accounts for them. Two things follow that PL does not
     state. PL §2.2 has the label of an `identity` slot read at "the path of
     the document the body was given the handle from, such as a path of the
     argument document or of a binding's state document"; in the run of today
     a handler of an element body is given every handle from `params` and
     `element` of the element's argument document, and the harness reads that
     position for the element itself alone (note 247). The plan has no record
     of the name a captured handle has under `params`. And where one write has
     an edge with `reference` and an edge without, PL does not say that the
     row of the second is not compared when the run stored a link.

258. **The order of the events** (adds to note 249). `compare/corpus.ts run`
     takes `--plan-order`. The two orders over the corpus, after the changes of
     notes 253 to 255:

    | | no-step bindings first | the order of the plan |
    | --- | --- | --- |
    | outputs compared | 1,388, and 125 bounds | 1,388, and 125 bounds |
    | with the atom: tighter, atom names the pattern | 1,267, 121 | 1,267, 121 |
    | looser, incomparable | 0, 0 | 0, 0 |
    | events committed, refused, not sent | 344, 15, 18 | 342, 17, 18 |
    | write edges compared | 234, and 1 bound | 230, and 1 bound |
    | equal | 219 | 219 |
    | tighter | 15 | 11 |
    | looser, incomparable | 0, 0 | 0, 0 |
    | a write the event's run did not make | 151 | 149 |
    | a write edge of an event not committed | 18 | 23 |
    | a label the runtime fails to read | 0 | 2 |

     Every difference is in two modules. In
     `examples/array-in-cell-with-remove-editable/array-in-cell-with-remove-editable.tsx`
     two pushed elements are at another index and are equal in both. In
     map-demo, the cycle of note 252 forms in the order of the plan alone: two
     rows of binding 9 are not compared, the events of bindings 10 and 12 are
     dropped, and two tighter rows of binding 12 are not made. One row has
     another category: write 2 of binding 9 is tighter with the no-step
     bindings first and equal in the order of the plan. It is no row of one
     state. The event goes to the last element, which is the second generated
     area in one order and the area `addAreaHandler` added in the other. That
     area's `center` is a stored link, the handler passes it on, and the stamp
     of the link has the four clauses the run's join has. A category depends
     on the order of the events where the events leave another state, and
     after these changes on nothing else that was found.

259. **A write row names its binding.** Two inline handlers of map-demo are both
     named `onClick#1`, since the emitter numbers the handlers of each body from
     1, and the results file named a write row by the handler's name.
     `ResultRow.binding` holds the index of the binding.
260. **What the harness still takes as a write.** A write is one whose target's
     value differs after the event. A link stored in the place of an equal value
     is not seen: write 1 of `keep` in `compare/fixtures/link-cycle.tsx` is
     listed as not made. The harness cannot read the write attempts of the
     transaction, since the runtime releases them when the transaction settles.

## What the argument document of an element of `map` is stamped with

261. **The stamp on an element's argument document, entry by entry** (corrects
     note 257). Measured with the runner alone, by a probe that is not in the
     repository. The pattern has one `map` whose callback declares neither
     `index` nor `array`. Its element body has three handlers: one that writes a
     captured cell and reads nothing of the element (`zoom.set(14)`), one that
     passes on a field of the element (`center.set(stop.position)`), and one
     that does both, as the handler of a stop's button in
     `examples/map-demo/map-demo.tsx` does. The list holds two elements, A and
     B. The runtime is made as the comparison harness makes it. The clauses are
     `a` and `b` for the elements, `pc` and `pz` for the cells of `center` and
     `zoom`, and `s` for the list.

     A clause declared in a schema cannot set the label of a list apart from the
     labels of its elements. It is stored as one entry of origin `declared` at
     the root, with no class, and the coordinator's read of the list consumes it
     for the slots as it does for the root: with the seeded lists that clause is
     in the stamp, and the root's clauses of class `enumerate` and `shape` are
     not. That is how the harness labels an input, so in the harness the one
     clause of `stops` is the label of the array, of every slot, and of every
     element. The probe therefore has four lists.

    | List | What a slot holds | How the entries are made |
    | --- | --- | --- |
    | links | a link to a cell of the element | by the runtime, from schemas: `s` declared at the root of the list, `a` and `b` at the roots of the two cells. The list's document then has `declared {s}` at the root and an entry of origin `link` at each slot, `{a}` and `{b}` |
    | seeded links | the same | written entry by entry through the test seam `seedStoredEnvelope`, each with a clause of its own: `declared` at the root; `structure` of class `enumerate` and of class `shape` at the root; `structure` of class `followRef`, `shape` and `value` at `*`; and at each slot `link`, `derived` of class `value`, and `derived` of class `shape`. The elements' cells keep `a` and `b` |
    | inline | the element's value, in the list's document | by the runtime: one transaction read a cell with `a` and stored slot 0 with `setRaw`, another read a cell with `b` and stored slot 1. The list's document has `derived` entries `{a}` at `0` and `{b}` at `1` and none at the root |
    | seeded inline | the same | as for seeded links without the `link` entries, and a `derived` entry at `title` of each element |

     A `push` of an object through a cell with no schema gave the object a
     document of its own and stored a link, so the inline list is stored with
     `setRaw`.

     **Where the stamp is computed** (read from the code; the observed entries
     agree with it). `reconcile` in `createMapInstance`
     (`runtime/runner/src/builtins/map.ts`) runs in a transaction of its own. It
     sets up each element that has no run with `Runner.runInTransaction` in that
     transaction, and that call writes the element's argument document.
     `prepareBoundaryCommit` (`runtime/runner/src/cfc/prepare.ts`) computes one
     join for the transaction, `deriveFlowJoin`, and stores it on what the
     transaction wrote: at a written path that holds links alone as entries of
     origin `structure`, and at a written scalar as entries of origin `derived`.
     For an argument document `{ element, params: { center, zoom } }` those are
     ten entries: class `enumerate` and class `shape` at the root and at
     `params`, and class `followRef`, `shape` and `value` at `*` and at
     `params/*`. All ten hold the same clauses. This is the stamp. The link at
     `element` gets one entry of origin `link` beside it, from `linkSlotLabel`,
     with the clause of the schema that the stored link carries. The reads of
     the coordinator that enter the join:

     - `listMembershipRead`
       (`runtime/runner/src/builtins/list-coordinator-plan.ts`) reads the whole
       raw array of the list once, marked `declaredOnwardRead` with the result
       container as its target. `deriveFlowJoinImpl` splits what that read
       consumes. The entries of class `shape` and `enumerate` at the list's own
       path are kept out of the join and stored in the `enumerate` entry at the
       root of the result container. Everything else the read consumes is
       joined: an entry with no class at the root or above it, which is what a
       declared clause is, and every entry below the root, which are the entries
       at `*`, the entries at each slot, and the entries of everything stored in
       place below a slot.
     - `listSlotResolutions` resolves each slot to the link it ends on. For a
       slot that holds a link, `listElementLink` parses the stored link, and the
       resolution probes the root of the target for a further link. The
       transaction has no read of the slot's own path and no other read of the
       element's value. For a slot that holds a value, the resolution probes the
       slot's own path, which is an observation of class `followRef` there.
     - A reconcile that a change of the list started has the list as a trigger
       read: `runSchedulerAction` (`runtime/runner/src/scheduler/run.ts`) passes
       the changed addresses to `addCfcTriggerReads`, and `triggerReadSources`
       reads each recursively at its own path, without the declaration. In the
       probe the trigger read was at the root of the list's document for each
       change it made: a `set` of the list, a `setRaw` of one slot, and a write
       of the whole document through the test seam. So the join of such a
       reconcile also has the list's own `shape` and `enumerate` entries. The
       first reconcile has no trigger read.
     - The coordinator's reads of its result container are marked
       `machineryRead`. `params` of an argument document holds one link for each
       captured cell, to the path of the enclosing pattern's argument that holds
       it, and the transaction reads no value of a captured cell. A read of an
       argument document that the transaction writes for the first time finds no
       stored entry. Where the transaction writes `index` of a stored argument
       document again, it reads that document, and the entries the document has
       enter the join.

     **What was observed.** Each row is an assertion of the probe that passes.
     "Stamp" means the clauses of the ten `structure` entries.

    | Question | List | Observed |
    | --- | --- | --- |
    | 1. A's argument document, both elements set up by the first reconcile | links | Stamp `{s}`. `link {a}` at `element`. No entry has `b`, `pc` or `pz`. B's document is the same with `b` for `a` |
    | | seeded links | Stamp: the `declared` clause of the root, the clauses of class `shape` and `value` at `*`, and the `derived` clauses of both slots, B's included. Not in it: the `enumerate` and `shape` clauses of the root, which are in the `enumerate` entry at the root of the result container and in no other entry of it; the `followRef` clause at `*`; the `link` clauses of the slots. `link {a}` at `element`, the clause of the link's schema and not the clause of the list's `link` entry |
    | | inline | Stamp `{a, b}` on both documents. No entry at `element` |
    | | seeded inline | The stamp also has the clause at `title` of B and the `followRef` clause at `*` |
    | 2. `zoom.set(14)` in A's body | links | The transaction reads one path of A's argument document, `params/zoom`, and no path of B's argument document, of A, of B or of the list. `zoom` gets `derived` entries of class `shape` and `value` with `{pz, s}`: `s` yes, `a` no, `b` no |
    | | links, with each entry of A's argument document given a clause of its own first | The write consumes one of them: the `followRef` entry at `params/*` |
    | | seeded links | The entries at `zoom` hold the whole stamp, the `derived` clauses of B's slot included |
    | | inline | `{a, b, pz}` |
    | 3. `center.set(stop.position)` in A's body | links | `center` holds a link to `position` of A, with `link {a, s}` and `structure` of class `followRef` `{a, pc, s}`. No entry has `b`. The transaction reads `element`, `element/position` and `params/center` of A's argument document, and `position` of A shallowly. Of the entries of A's argument document it consumes the three at `*`, the `link` entry at `element`, and the `followRef` entry at `params/*` |
    | The handler that does both | links | `zoom` gets `{a, pc, pz, s}`; `center` gets `link {a, s}` and `followRef` `{a, pc, pz, s}` |
    | 4. The callback declares `index` | links | The argument document holds `index` as a number, with two more entries, `derived` of class `shape` and of class `value`, that hold the stamp's clauses. The ten entries and the entry at `element` are the same. `zoom.set(14)` consumes the same one entry and neither entry at `index` |
    | | seeded links, A then removed | One commit writes `index` of B's argument document, 1 to 0, and no other path of its value. The `value` entry at `index` then holds the join of that reconcile beside the clauses it had. Every other entry is unchanged. Without `index` no commit writes B's argument document, and its entries are unchanged |
    | 6. B added to a list that holds A | seeded links | No commit writes A's argument document, and its entries are those of the first reconcile. The transaction that sets up B neither reads nor writes A's argument document, and its one read of A's value is the probe for a link at the root. B's stamp has the `derived` clauses of A's slot and of its own, and the `enumerate` and `shape` clauses of the list's root, which a stamp of the first reconcile lacks |
    | | inline | A's stamp stays `{a}`. B's is `{a, b}`. `zoom.set(14)` stores `{a, pz}` in A's body and `{a, b, pz}` in B's |

     Question 5 is answered by the four lists above: with declared clauses the
     probe used links to separate cells, and with elements stored in place it
     used entries that the runtime derived or that the test seam wrote.

     **What follows for the independence of elements.** The elements are
     independent in three ways that were observed. The clause of an element's
     own document, behind a link, is in no entry of another element's argument
     document and in no write of another element's handler. Where a slot holds a
     link, the coordinator reads nothing of the element's document but a probe
     for a link at its root. And the argument document of an element is not
     written when another element is added or removed, unless the callback
     declares `index` and the element's position changed. They are not
     independent in one way: the stamp is the join of the coordinator's
     transaction, that transaction reads the list's document whole, and every
     argument document it writes gets the same stamp. So the stamp of each
     element set up by one reconcile holds the entries of every slot of the
     list's document, and with elements stored in place the entries of every
     element. An element set up later gets the entries of all slots stored at
     that time, and the earlier elements keep the stamp they have. The stamp
     reaches a handler that reads nothing of the element, because the handler is
     given each captured handle from `params` of the argument document and the
     entry of class `followRef` at `params/*` is part of the stamp.
     `list-coordinator-plan.ts` says of the read of the list that a child
     "carries its own slot's label and the selection's, not every element's";
     with `derived` entries at the slots, the probe observed every slot's.

     **Corrections to note 257.** "The stamp of the run of the `map` that wrote
     that document" is the join of the coordinator's transaction that set the
     element up, as above: labels of the list's document, and neither the labels
     of element documents behind links nor the labels of captured cells. In the
     harness the clause of `stops` is declared at the root of the list, so the
     harness cannot say which of the list's entries the stamp took it from. Two
     facts about the rows were left out. First, the map over `stops` in map-demo
     is `stops.map((stop, index) => ...)`: it declares `index`, so each argument
     document there also holds `index` with two `derived` entries, and a change
     of an element's position writes `index` again; the handlers of the two
     buttons do not read `index`. The map over `areasOfInterest` declares no
     `index`. Second, the handler of a stop's button is one body with two
     writes, `center.set(stop.position)` and `zoom.set(14)`. The first passes on
     a handle taken from the element, and the transaction has one join, which
     every write of it stores. So the row of `zoom.set(14)` is not the row of a
     handler that reads nothing of the element, and its label has what the reads
     of `element` and of `position` consumed: `a` and `pc` in the row of the
     probe, where a handler that sets `zoom` alone stores `{pz, s}`. Note 257's
     account of the three clauses the template lacks, that the entries of the
     argument document hold them, stands.

     **Not determined.** Whether the harness stores the generated elements of an
     input list in place or as links. What the integrity of these entries is:
     the probe compares confidentiality clauses alone. What changes when the
     callback declares `array`, and what `filter` and `flatMap` store. The
     comment at the declaration in `deriveFlowJoinImpl` marks the split of the
     declared read as pending a ruling of the specification (`SPEC-PENDING`), so
     the rule itself may change.

## Rulings V1, W1, X1 and Y2 in the crate and in the comparison

262. **The index is a slot** (PL §1.1 `SlotRoot`, §1.3 "The index is a slot").
     The emitter binds the index parameter of a callback to a slot of root
     `index` that names the callback's collection, with the empty path and the
     class `value`. A cone that reads the name lists the slot in `Cone.slots`,
     the use of a sandboxed body lists it in `Body.reads`, and a state path of a
     handler binding has it as `place: { slot }` with the `slot` node as its
     template. `Collection.bodyUses` is not emitted, and `Binding.state.place`
     has no `{ index }`. The slot has the class `value` whatever the reader does
     with it: a callback that writes the index at a child position, or passes it
     to a child, reads the same slot as one that computes with it. PL gives the
     slot one class and does not say that a node that only passes the index on
     reads it under another. The step of a `reduce` and the predicate of a scan
     read the index the same way (PL §3.13).
263. **An index given to a sandboxed body had no entry** (a defect of the
     emitter, found while writing the test for note 262). In
     `rows.map((row, index) => label(index))`, with `label` a `lift`, the use of
     the body had `inputs: []` and `Body.reads` did not list the index, so the
     template of that output held nothing of the collection. The emitter left a
     place of kind index out of the entries of a use. It now places the slot.
     The corpus comparison did not show this, because the outputs below
     `children/*` are not compared (note 250).
264. **The removed diagnostic and the count of LS §11.3** (ruling W1). The crate
     no longer reports `collection:shared-element-state`, and
     `collection:index-keyed` is `collection:index-read`, with a message that
     does not say the elements are keyed by position. The corpus report has a
     row named for LS §11.3 "A handler bound, without the index, in a
     per-element body over plain values", which it counted from the removed
     diagnostic. It now counts the same condition as a construct,
     `state per
     element of plain values without the index`: the collection
     is plain by its syntax, the callback does not use the index and
     instantiates no child, and its body declares a state cell. That condition
     is about a state cell and the row of LS is about a handler binding; the
     crate counted the first under the name of the second before this change
     too. The count "child instantiated per element of plain values" is removed
     with the rule it served.
265. **The label of the index in the comparison** (ruling Y2; PL §2.2 "The label
     of a slot of root `index`"). `compare/template.ts` evaluates a slot of root
     `index` by rule: `TemplateInputs.indexOf` names the collection, and the
     label is `TemplateInputs.array` of that collection, evaluated outside the
     element of it, so every element has one label. The harness gives `array` as
     the membership the collection iterates (PL §3.2), joined for a collection
     over a stored slot with the confidentiality of the entries of class
     `followRef` at each slot of the array, without the entries of origin
     `link`. PL §2.2 as merged has the membership alone; the ruling adds "which
     link each slot holds", and the documents author is writing it in. Three
     things neither states, and what the harness does:
     - An entry of origin `link` at a slot holds what the reference declares,
       which for a link to a cell repeats the label of the cell's type (PL
       §2.2). The harness leaves it out, as "nothing of what the links point
       to".
     - A collection that holds plain values in place has no link at a slot, and
       its element keys derive from the values. The harness gives the index the
       membership alone there. The position of an element is then a function of
       the array's length and order alone, but which state an occurrence finds
       depends on the equal values before it (PL §5.5), and no label of the
       index holds those values.
     - A derived collection, such as the result of a `filter`, has the
       membership template of its record, which folds the predicate's reads. The
       harness evaluates that template and adds nothing. The integrity of the
       label is the integrity of the membership. No document says what integrity
       a position has.
266. **Where the harness reads the handle of an element** (ruling V1; PL §2.2
     "The position of a slot of root `element`"; replaces note 247). In a write
     row the `identity` slot of a state path that is the element itself is read
     at the element's position in the source collection, as every other slot of
     root `element` is, and no longer at `element` of the argument document of
     the element's instance. A captured handle is read at the place the plan's
     state entry names, which it was before. Where the body resolves the handle
     of its element or writes through it, the harness joins two things to the
     slot (PL §8, question 85): what the entries of origin `link` at `element`
     of that argument document hold, and the entries of origin `declared` in the
     document that holds the element's position, at the position and above it,
     read as a `shape` read reads them.
267. **No `link` entry at `element` in the runs observed** (PL §2.2, §8 question
     85; corrects note 247). PL §2.2 says of `askToRetire` of
     `system/profile-picker/profile-picker.tsx` that what the run stores "has
     the clause the input list declares, which the `link` entry at `element`
     holds". In the corpus run of that module, and in
     `compare/fixtures/element-resolved.tsx`, the argument document of the
     element's instance has no entry of origin `link`. The clause of the list is
     on its entries of origin `structure`, the entry of class `followRef` at `*`
     among them, which is the coordinator's join (note 261), and on the two
     `derived` entries at `index` where the callback declares the index. Note
     247 took the clause for the `link` entry without reading the origins. So
     question 85's two descriptions of one label, "the label that the
     declaration of the source collection gives the element" and "what the
     `link` entry at `element` holds today", differ in these runs: the first has
     the clause and the second is empty. With the `link` entry alone the
     template of `askToRetire` has no clause and mints no atom, and the row is
     tighter in confidentiality by the coordinator's join and looser in
     integrity by the atom (note 268); the first corpus run of this round showed
     that. With the declared entries, which the harness now reads, the row is
     equal, as PL states it. In the harness the clause of an input list is
     declared at the root of the list's cell, with no class, so the declared
     label of an element is the label of the list. Not determined: whether a
     list whose schema declares a clause for its items, and none for itself,
     gives the stored link at `element` an entry of origin `link`.
268. **A template with no clause mints no atom, and the run mints beside the
     coordinator's join** (PL §3.1 "The coordinator's join on an element's
     argument document"; §3.2 "When `derive` and `fold` mint", question 66). The
     rule counts a row as tighter where every clause the template lacks is held
     by the argument document of the element's instance. Where those are all the
     clauses the run's label has, the template's label is empty, and a `derive`
     mints no atom beside an empty label. The run's join is not empty, so the
     run stores the atom of the handler's body. Such a row is tighter in
     confidentiality and looser in integrity by that one atom. PL §3.2 says the
     same of a test for an absent optional field and does not say how the row is
     counted; a kept output carries the pattern's atom all the same, and a write
     edge has no such atom. The harness does not count the row as tighter.
     `WriteRow.noAtomBesideCoordinatorJoin` marks it, the corpus report counts
     it apart, and its category stays looser. The fixtures have one: `clear` of
     `compare/fixtures/index-nodes.tsx`, which closes over a state cell of the
     pattern alone and is bound in an element body whose list has two clauses.
     The corpus has none (note 272). Whether such a row is a row of the rule,
     and so counted as tighter, is for the documents.
269. **How the harness decides that a row is of the coordinator's join.** PL has
     "held by an entry of origin `structure` or `link` of the argument document
     of the element's instance that the event's transaction consumed". The
     harness cannot read what a transaction consumed. It takes the clauses of
     every entry of those two origins, at every path, of the argument document
     of each element instance on the way from the result to the handler's
     stream, and it finds those instances only where the way has one instance
     for each step of the binding's `within`. `WriteRow.byCoordinatorJoin` is
     set where the row is tighter and every clause the template lacks is among
     them. `WriteRow.lacking` holds the clauses, and the report lists each
     tighter write row with them.
270. **A written path that holds a link, for an edge with no `reference`** (PL
     §3.1; replaces note 260 in part). The harness counts the links stored on
     the way from the path of a write target to its value, before and after each
     event, and keeps the fewest it saw at each target. An edge with no
     `reference` whose target holds more than that after the event is not
     compared, under a reason of its own. Three limits. A target that already
     held a link when the harness first read it has that count as its fewest. A
     path the run added below a target, such as a pushed element, is not decided
     this way, because the runtime stores a pushed object through a link of its
     own. And a row that needs a label the runtime fails to read is counted
     under that reason first. The harness now also takes as written a target
     that holds a link where it held an equal value, which note 260 had as not
     seen.
271. **State and identity that derive from the index** (ruling Y1). The crate
     has nothing to change for the three rules. The plan has no record of the
     value a declaration gives a state cell (PL §1.1, `StateCell`), so no cone
     lists the index slot on account of `Writable.of(index)` in an element body,
     and nothing writes the declared value again on a move. An explicit cause
     and a copied value of a binding made in a function body are computed by
     that body, whose use lists the index slot where the body is given the
     index.
272. **The comparison over the corpus, after rulings V1, W1, X1 and Y2.** Both
     orders of the events (note 258), run one after the other. "Before" is the
     run of note 258.

    | | no-step first, before | after | plan order, before | after |
    | --- | --- | --- | --- | --- |
    | outputs compared | 1,388, and 125 bounds | the same | 1,388, and 125 bounds | the same |
    | with the atom: tighter, atom names the pattern | 1,267, 121 | the same | 1,267, 121 | the same |
    | looser, incomparable | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
    | bindings of a handler: no step, `site`, `element` | 266, 314, 71 | the same | 266, 314, 71 | the same |
    | events committed, refused, not sent | 344, 15, 18 | the same | 342, 17, 18 | the same |
    | write edges compared | 234, and 1 bound | 231, and 1 bound | 230, and 1 bound | 228, and 1 bound |
    | equal | 219 | 219 | 219 | 219 |
    | tighter | 15 | 12 | 11 | 9 |
    | of those, by an entry an earlier write left (note 238) | 10 | 10 | 8 | 8 |
    | by the coordinator's join | not counted | 2 | not counted | 1 |
    | looser, incomparable | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
    | a written path that holds a link, for an edge with no `reference` | not counted | 3 | not counted | 2 |
    | a label the runtime fails to read | 0 | 0 | 2 | 2 |
    | a write the event's run did not make | 151 | 150 | 149 | 148 |
    | a `dynamic` node | 44 | 45 | 44 | 45 |

     Every row that changed, in both orders:

    | Row | Before | After | Cause |
    | --- | --- | --- | --- |
    | write 0 (`center.set(...)`) of bindings 6 and 9, `examples/map-demo/map-demo.tsx` | tighter | not compared | The run stored a link at the target of the edge for a value (note 270). Write 1, the edge with `reference`, is the row of the write and is equal. In the order of the plan binding 9 was not compared before either (a label the runtime fails to read, note 252) |
    | write 0 of `setDefaultProfile`, `system/profile-picker/profile-picker.tsx` | tighter | not compared | The same. Write 1 is equal |
    | write 2 (`zoom.set(14)`, `zoom.set(13)`) of bindings 6 and 9, `examples/map-demo/map-demo.tsx` | tighter | tighter, by the coordinator's join | The category is the same. The template lacks `areasOfInterest`, `selectedStopIndex` and `stops`, and in the order of the plan `stops` alone (binding 6; binding 9 is equal there, note 258). Every one is on an entry of origin `structure` or `link` of the argument document of the element's instance |
    | write 2 of `startEditBody`, `product/collection-naming/item.tsx` | a write the event's run did not make | not compared, a `dynamic` node | `referencesDraft.set(references.get())` stores a link where the cell held an equal value, which the harness now takes as a write (note 270) |

     No row is looser or incomparable in either order. The one row of an
     element body that is tighter for another cause is write 0 of
     `selectRoomRef` of
     `examples/scoped-group-chat/main-with-writable-inputs.tsx` (notes 238 and
     257). `askToRetire` of
     `system/profile-picker/profile-picker.tsx` is equal, by note 267.

     Two things the corpus does not show. No compared row evaluates a slot of
     root `index`. The plans of the corpus have 54 such slots in 30 patterns:
     52 cones list one, 12 uses of a sandboxed body read one, 18 state paths of
     handler bindings are bound to one, and 70 kept outputs have one in their
     template. Those outputs are below `children/*` or are the assembled
     children, which are not compared (note 250), and the handlers have no
     write edge that is compared: their body has none, their target is a
     stream, their template has a slot below a child no pick chose, or their
     run made no write. And no row of the corpus is looser by the atom of note
     268. The two fixtures of this round are the test of both.

## What compiling, running and storing cost: today measured, the plan derived

273. **What is a measurement here and what is not.** The crate emits a plan and
     no value code, and nothing executes a plan. So three kinds of number
     follow, and each table says which a row is.

     - _Measured_ on both sides: the time to compile (note 274).
     - _Measured_ for today's runtime alone: the time, the transactions and the
       runs of a scheduler action of a scenario (note 276), and what the
       scenario leaves stored (notes 277 and 278).
     - _Derived_ for the compiled path: counts that `execution-and-storage.md`
       (ES) fixes for a plan, computed from the plan's records by
       `compare/cost-model.ts`. A derived count is not a time, and no time of
       the compiled path is given anywhere below.

     The set is the modules of the corpus comparison: the 270 modules the crate
     accepts and emits a plan for with no unsupported construct (note 272).
     Compile time is over all 270. The run and the storage are over the 213 that
     the corpus comparison runs: 33 need `wish`, 14 request an effect, and the
     run of 10 fails on a CFC refusal, as before. The scenario of a module is
     the generated one of `compare/generate.ts`: every top-level input has a
     value and a confidentiality atom of its own, an array has two elements, and
     one event is sent to each handler whose stream the result holds, the
     handlers bound outside an element body first (note 258).

     The machine is an Apple M3 Max with 16 cores and 128 GB, macOS (Darwin
     25.4.0), Deno 2.9.8, and rustc 1.93.0 with the release profile of Cargo
     unchanged. Nothing else was run during a measurement, and no measurement
     was repeated on another day. `compare/cost.ts` makes the measurements,
     `compare/cost-report.ts` prints the tables, and the crate's `time` command
     times the crate. Times are wall time in milliseconds. A table gives the
     total over the modules, the median, the tenth and the ninetieth percentile,
     and the least and the most.

274. **Compile time.** Both pipelines were given the same program for a module:
     the module and the modules it imports by path, as `resolveLocalProgram` in
     `runtime/runner/src/harness/local-program.deno.ts` resolves them, without
     the data files (7 modules have some). That is 1,004 files for the 270
     modules, 336 of them distinct, with a median of one file and 5.9 KB of
     source per module. The plan the crate emits for a module from its own
     program is equal to the plan it emits for the module from the whole corpus,
     for all 270.

     _Today_ is `PatternManager.compilePattern` in
     `runtime/runner/src/pattern-manager.ts` with a space, which is what the
     harness calls and what the piece controllers call
     (`runtime/piece/src/ops/pieces-controller.ts`). It runs
     `Engine.compileToRecordGraph` and `Engine.evaluateRecordGraph` of
     `runtime/runner/src/harness/engine.ts`. The first builds a TypeScript
     program with the declarations of `commonfabric` and of the standard
     library, checks every file, and emits one CommonJS module per file through
     the transformer pipeline of `base/ts-transformers`, which is where the
     schemas are generated (`compileModulesHere` in
     `runtime/runner/src/harness/module-compile.ts`,
     `TypeScriptCompiler.compileToModulesInterleaved` in
     `base/js-compiler/typescript/compiler.ts`). There is no bundling step. The
     second evaluates the modules, which runs the builder and yields the
     pattern. Each module was compiled three times, each time in a runtime and a
     store of its own, and then once more in the same runtime, which finds the
     compiled modules in the cache the first compile stored. The phases are the
     pipeline's own timing spans (`js-compiler/phase/*`, `engine/*`,
     `pattern-manager/compile-cache/*`), read after the last of the three:
     `program` is `createProgram`, `check` is the semantic and the declaration
     check, `emit` is the transformers and the emit together (the pipeline does
     not time them apart), `evaluate` is the evaluation of the modules, `cache`
     is the read and the write of the compile cache, and `rest` is what remains,
     which includes the verification of the emitted modules and the hashing of
     module identities.

     _The crate_ is `analyze` and the JSON text of the plans of every module of
     the program (`time` in `src/main.rs`), 20 times in one process, from source
     text in memory.

     | In one process, 270 modules            | total  | median | p10    | p90  | least  | most  |
     | -------------------------------------- | ------ | ------ | ------ | ---- | ------ | ----- |
     | crate, median of 20                    | 5,104  | 0.626  | 0.0822 | 15   | 0.0387 | 1,189 |
     | today, first compile of the module     | 91,115 | 151    | 96.5   | 666  | 84.9   | 5,207 |
     | today, median of the two later         | 87,419 | 146    | 96.3   | 657  | 82.7   | 4,892 |
     | today, again in the same runtime       | 7,644  | 18.6   | 15     | 43.1 | 13.2   | 389   |
     | today, last compile: reading the files | 549    | 0.71   | 0.336  | 4.68 | 0.235  | 35    |
     | today, last compile: `program`         | 7,794  | 28.6   | 25.1   | 32   | 20.3   | 49.5  |
     | today, last compile: `check`           | 24,933 | 47.9   | 24.7   | 187  | 13.5   | 1,142 |
     | today, last compile: `emit`            | 33,988 | 28.4   | 7.84   | 241  | 3.94   | 2,449 |
     | today, last compile: `evaluate`        | 2,130  | 2.05   | 0.827  | 10.2 | 0.513  | 355   |
     | today, last compile: `cache`           | 5,996  | 11.8   | 9.26   | 38.8 | 8.08   | 285   |
     | today, last compile: `rest`            | 11,426 | 27.5   | 23.5   | 64.8 | 21.6   | 552   |

     Per module, today's later compiles take 240 times the crate's time at the
     median (p10 41, p90 1,201). The totals differ by 17, and by 12 without
     today's `check` and `evaluate`. The two figures are far apart because the
     crate's total is three programs: the three that hold FabriChat's room (15
     to 18 files, about 500 KB of source) take 1.1 to 1.2 s each and are 3.4 s
     of the 5.1 s. 172 modules take the crate under a millisecond and 5 take it
     over 100 ms. The crate's 20 runs of a module differ little: p90 less p10 is
     6% of the median, at the median module.

     | Largest ratio                                   | files | crate  | today | ratio |
     | ----------------------------------------------- | ----- | ------ | ----- | ----- |
     | `dev/catalog/stories/cf-submit-input-story.tsx` | 1     | 0.0393 | 104   | 2,643 |
     | `examples/aside/aside.tsx`                      | 1     | 0.0395 | 98.7  | 2,497 |
     | `dev/catalog/stories/cf-collapsible-story.tsx`  | 1     | 0.0453 | 113   | 2,494 |
     | `dev/catalog/stories/cf-markdown-story.tsx`     | 1     | 0.0387 | 87.9  | 2,274 |
     | `dev/catalog/stories/cf-toggle-group-story.tsx` | 1     | 0.044  | 98.4  | 2,235 |

     | Smallest ratio                                           | files | crate | today | ratio |
     | -------------------------------------------------------- | ----- | ----- | ----- | ----- |
     | `dev/factory-outputs/lot-with-coordinator-demo/main.tsx` | 6     | 286   | 3,354 | 11.7  |
     | `system/shared-space/shared-space-collection.tsx`        | 3     | 42.5  | 320   | 7.53  |
     | `dev/loom-chat-room-fixture/main.tsx`                    | 18    | 1,154 | 4,892 | 4.24  |
     | `dev/loom-overlay-fixture/main.tsx`                      | 18    | 1,189 | 4,763 | 4.01  |
     | `system/fabrichat/room-test-fixture.ts`                  | 15    | 1,102 | 3,715 | 3.37  |

     With one process per module, each started from the same parent and timed
     from its start to its end: the crate's `plan` command, which reads the
     files and prints the plans, five times, and today's compile once
     (`cost.ts compile-one`), which starts Deno, loads the runtime, and compiles
     as above.

     | One process per module, 270 | total   | median | p10  | p90   | least | most  |
     | --------------------------- | ------- | ------ | ---- | ----- | ----- | ----- |
     | crate, median of 5          | 6,651   | 3.58   | 2.46 | 21.6  | 2.05  | 1,336 |
     | today, one run              | 381,950 | 1,101  | 960  | 2,014 | 869   | 6,870 |

     The ratio per module has the median 310 (p10 83, p90 515). Of today's 1,101
     ms about half is the compile itself (median 551 ms in a new process,
     against 146 ms for a later compile in a process that has compiled before),
     and the rest is starting Deno and loading the runtime's modules. The crate
     in one process over the whole patterns directory (426 modules read, 118,537
     lines, 333 accepted) takes 3.2 to 3.5 s, five runs.

     What makes the comparison less than even, in each direction:

     - The crate emits no value code. Today's `emit` produces the JavaScript
       that runs, with source maps. The crate's output is the plan: the records,
       the label templates, and the schemas. An emitter of value code will add
       time that is not in the crate's figure.
     - The crate forms no hash. A plan names its schemas, bodies and patterns
       `unhashed:…`. Today's figure includes the content identity of every
       module.
     - The crate's type checker is its own and does less than TypeScript's: it
       does not check a generic function per instantiation, and it applies
       assignability at four kinds of site (README, "What it does not cover").
       Today's `check` is the full semantic check of every file against the
       declarations of `commonfabric` and the standard library, and `program`
       builds that program. The crate knows the API by name (`src/api.rs`) and
       reads no declaration file.
     - Today's `evaluate` has no counterpart in the crate: it runs the builder,
       which makes the graph of nodes that the plan's records take the place of.
       It is 2% of today's total.
     - Today's figure includes storing the source and the compiled modules in
       the space (`cache`, 7%), and the crate's includes writing nothing. The
       crate's in-process figure also leaves out reading the files, which is
       under a millisecond per module for today.
     - Today's second compile of a program in one runtime takes 19 ms at the
       median, from the cache. The crate has no cache, and its first and every
       later compile cost the same. Against that cache the two medians differ by
       30 times, and the crate is slower on the three large programs.

275. **The crate is slow on a large program, for a cause of the prototype.** At
     the median the crate takes 0.12 ms per KB of source. On the three programs
     with FabriChat's room it takes 2.3 ms per KB. A sample of the process on
     `system/fabrichat/room-test-fixture.ts` has 70% of its top frames in the
     allocator and in `memmove`, and the first frames of the crate below them
     are `String::clone`, and `Resolver::shape` and `Resolver::display_at` of
     `src/types.rs`. The reading is that the type evaluator builds the shape of
     a type again at each use and keeps none. It was read from the sample alone,
     and no fix was tried. It matters for the comparison because the reference
     pattern is the one case where the measured gain is 3.4 times and not
     hundreds.

     A second finding of the same kind: given the 1.5 MB bundled `guest.js` of
     `showcase/iframe-firebreak-commons` as a module, the crate had not finished
     one run after 108 s. The file is a data file of that program and is no
     module of the corpus, so no figure here includes it, and `cost.ts closures`
     leaves data files out.

276. **Run time: today measured, the plan's counts derived.** Today's side is
     the scenario run by the harness (`runScenario` in `compare/harness.ts`)
     with a probe at five points. "To settle" is from the compiled pattern to
     the point where the instance was started, the result and every kept output
     were read, the scheduler was idle and the store had confirmed. "Per event"
     is from sending one event to the same point after it. The counts are the
     runtime's own timing spans: a transaction committed is
     `storage.v2.transaction/commit/commitNative`, a run of an action is
     `scheduler/run/action`, a call of an authored body is
     `runner/action/invokeJavaScriptImplementation`, a CFC preparation is
     `extended-storage-transaction/prepareCfc`. The reads are the entries of the
     read journal of each transaction whose commit was called, taken by wrapping
     `Runtime.edit` on the one runtime of the scenario. The scheduler asked for
     a commit after every run of an action (4,343), and 1,461 of those had
     something to write. All 213 modules ran in one process one after the other,
     so the times are those of a process that has run patterns before.

     The derived side, from `settledCost` and `eventCost` of
     `compare/cost-model.ts`:

     - _Transactions to settle: 2_, whatever the plan (ES §1.1, §1.2). One
       creates the instance and writes its argument. One is the derivation
       transaction of the change of demand, which evaluates every demanded cone
       instance, those of the children in the same space included.
     - _Cone instances._ A cone is evaluated once per combination of element
       keys of the collections around it (ES §2.1, §2.5). A cone belongs to the
       innermost collection among those a slot of root `element` or `index` of
       it names and those of the cones whose output it reads. The number of
       element keys of a collection is the length of the generated array where
       the collection iterates a path of the argument, or of an element of such
       an array, or a collection made from one. For the other collections, over
       a computed array, a state cell or the result of an operation, the plan
       and the inputs give no size: the first row takes them as empty and the
       second as two elements. 54 of the 213 modules have such a collection.
     - _Per event: 1 or 2 transactions_ (ES §1.1): the event's, and one
       derivation transaction behind the batch where a demanded cone instance
       became stale. An event the handler sends has a transaction of its own and
       is not counted. The cone evaluations of an event are bounded by the cones
       that have a slot of the same root as the place a written path of the
       handler's state is bound to, and the cones behind them by `output` edges,
       each counted for every element key.

     | To settle, 213 modules                                     | total   | median | p10  | p90   | least | most    |
     | ---------------------------------------------------------- | ------- | ------ | ---- | ----- | ----- | ------- |
     | today, measured: milliseconds                              | 21,566  | 37.8   | 9.96 | 238   | 4.73  | 2,058   |
     | today, measured: transactions committed                    | 1,461   | 2      | 1    | 19.8  | 1     | 76      |
     | today, measured: runs of an action                         | 4,343   | 11     | 4    | 44.8  | 2     | 187     |
     | today, measured: calls of an authored body                 | 844     | 1      | 0    | 13    | 0     | 53      |
     | today, measured: CFC preparations                          | 2,822   | 8      | 0    | 35    | 0     | 134     |
     | today, measured: reads journaled                           | 674,328 | 819    | 160  | 7,057 | 58    | 107,490 |
     | compiled, derived: transactions                            | 426     | 2      | 2    | 2     | 2     | 2       |
     | compiled, derived: cones                                   | 1,845   | 5      | 2    | 14.8  | 0     | 150     |
     | compiled, derived: cone instances, other collections empty | 1,708   | 4      | 2    | 15    | 0     | 147     |
     | compiled, derived: cone instances, other collections of 2  | 2,406   | 5      | 2    | 23    | 0     | 153     |
     | compiled, derived: sandboxed bodies in the plan            | 724     | 1      | 0    | 9     | 0     | 37      |
     | compiled, derived: bindings in the plan                    | 651     | 1      | 0    | 7     | 0     | 122     |
     | compiled, derived: effects in the plan                     | 0       | 0      | 0    | 0     | 0     | 0       |

     The ratio of transactions, today's to the derived, is 1 at the median
     module (p10 0.5, p90 9.9), and 3.4 over the totals. 84 modules commit one
     transaction today, where the design has two, and 92 commit more than two.
     The ratio of today's runs of an action to the derived cone instances is 2.3
     at the median (p10 1.4, p90 3.7), and 1.8 over the totals.

     | Largest ratio of transactions              | ms today | transactions today | actions today | transactions derived | cone instances derived | ratio |
     | ------------------------------------------ | -------- | ------------------ | ------------- | -------------------- | ---------------------- | ----- |
     | `apps/topic-workbench/main.tsx`            | 514      | 76                 | 134           | 2                    | 59                     | 38    |
     | `apps/person-workbench/main.tsx`           | 590      | 69                 | 117           | 2                    | 73                     | 34.5  |
     | `dev/catalog/catalog.tsx`                  | 311      | 55                 | 69            | 2                    | 11                     | 27.5  |
     | `dev/catalog/ui/sidebar/sidebar.tsx`       | 215      | 51                 | 59            | 2                    | 5                      | 25.5  |
     | `dev/plain-array-callback-locals/main.tsx` | 115      | 46                 | 52            | 2                    | 24                     | 23    |

     | Smallest ratio of transactions                  | ms today | transactions today | actions today | transactions derived | cone instances derived | ratio |
     | ----------------------------------------------- | -------- | ------------------ | ------------- | -------------------- | ---------------------- | ----- |
     | `showcase/iframe-impossible-machine/main.tsx`   | 29.5     | 1                  | 8             | 2                    | 3                      | 0.5   |
     | `showcase/iframe-orbital-salvage-yard/main.tsx` | 74.5     | 1                  | 8             | 2                    | 3                      | 0.5   |
     | `showcase/iframe-shared-tape-lab/main.tsx`      | 21.5     | 1                  | 8             | 2                    | 3                      | 0.5   |
     | `system/fabrichat/adapter.tsx`                  | 65.9     | 1                  | 13            | 2                    | 7                      | 0.5   |
     | `system/fabrichat/room-test-fixture.ts`         | 19.9     | 1                  | 3             | 2                    | 1                      | 0.5   |

     The smallest ratio is shared by the 84 modules with one transaction today,
     and the five shown are the last of them in the order of the corpus.

     | Per committed event, 344 events of 104 modules | total   | median | p10  | p90   | least | most   |
     | ---------------------------------------------- | ------- | ------ | ---- | ----- | ----- | ------ |
     | today, measured: milliseconds                  | 18,219  | 26     | 8.22 | 123   | 2.87  | 420    |
     | today, measured: transactions committed        | 1,175   | 2      | 1    | 8     | 1     | 38     |
     | today, measured: runs of an action             | 1,605   | 3      | 1    | 12    | 1     | 48     |
     | today, measured: reads journaled               | 701,101 | 979    | 199  | 4,712 | 63    | 14,451 |

     Derived per event: 1 to 2 transactions, and at most 4.7 cone evaluations at
     the mean over all events (2.7 at the median module). Today's mean per
     committed event is 3.4 transactions and 4.7 runs of an action. 15 further
     events were refused by the runtime and are in no row.

     What can be said about run time is these ratios of counts and nothing more.
     A transaction of the design is not a transaction of today: it prepares CFC
     once over everything a cause staged, where today each of the 2,822
     preparations to settle is one node's. A cone evaluation is not a run of an
     action: it is one call of emitted code with no scheduler step, no
     transaction and no journal of its own. Neither difference has a measured
     cost.

277. **Storage: today measured, the plan's documents derived.** Today's side is
     what the replica of the scenario's space holds after the runs of note 276,
     for every document a commit wrote. A document is counted in one of six
     kinds: a _result_ document holds an `argument` meta link, an _argument_
     document is what such a link names, an _internal_ document holds a `result`
     meta link, a _computed_ document has an identifier of the `computed:`
     scheme, a _schema_ document has a `cid:` identifier, and _other_ is the
     rest: the scenario's inputs, the records of their arrays, and after events
     the receipts and the records a handler made. The first four are the
     documents of the instance, which the design replaces. Schema documents and
     the others exist in both layouts. The documents the compile stored are
     counted apart. Bytes are of the JSON of a document's `value`, of its meta
     fields, and of its `cfc` envelope. The replica holds each label in place.
     The second envelope row counts a label above 128 bytes as a reference of 63
     bytes (`CFC_LABEL_INLINE_LIMIT` in
     `runtime/runner/src/cfc/label-documents.ts`), which is how the store holds
     it.

     The derived side, from `settledCost`, is the documents of ES §4.1:

     - one result document and one argument document;
     - one operation state document per durable operation and combination of
       element keys;
     - none to one state cell document per state cell and combination of element
       keys, since a cell's document is written when the cell is first assigned
       (ES §4.5);
     - none to two documents per child, its result and its argument (ES §4.6).
       The documents of the child's own plan are not derived: 5 of the 213
       modules have a child record, and `dev/catalog/catalog.tsx` and
       `dev/catalog/ui/story-renderer.tsx` have 64 each, of which the scenario
       instantiates few;
     - none to one part document per row of a kept collection (ES §4.10).
       Whether a row is a part depends on its size in bytes against
       `PART_SPLIT_BYTES`, which the plan does not give. The nodes of a rendered
       tree are split points too and are not counted, so a rendered tree above
       1,024 bytes adds part documents that the "most" row does not have;
     - one row of the stream index per binding and combination of element keys,
       and no stream document before an event (ES §4.7).

     Label entries, by ES §4.3: one entry of the pattern's atom at the root of
     the result document, then a `value` and a `shape` entry per kept output
     whose template is not `const` and whose label is not empty, and an
     `enumerate` entry per kept collection. Whether a template instantiates to a
     label with nothing in it depends on the labels of the inputs, which the
     derivation does not evaluate. So three rows: one entry where every label is
     empty, and the count where none is, with the entries of a path below `*`
     once where the rows share a label and once per element key where they
     differ. A template is held once in the plan and in no document. ES §4.9
     gives an entry stored by reference as about 25 bytes and a reference of 63,
     and that is the one size of a record ES gives: the bytes of the derived
     envelopes are 88 per entry, and no bytes of values are derived.

     One more row is measured and is an estimate of the compiled side, not a
     derivation: the bytes of the result document's value with every link to a
     document of the instance replaced by what it names (`inlined` in
     `compare/cost.ts`). That is the instance's result as one value, with the
     references it passes through left as links, which is the content ES §4.2
     and §4.5 put in the result document and its parts. It leaves out the
     storage links of parts, state cells and operation state.

     | After settle, 213 modules                                   | total      | median | p10    | p90     | least  | most      |
     | ----------------------------------------------------------- | ---------- | ------ | ------ | ------- | ------ | --------- |
     | today, measured: result documents                           | 978        | 1      | 1      | 7       | 1      | 121       |
     | today, measured: argument documents                         | 980        | 1      | 1      | 7       | 1      | 121       |
     | today, measured: internal documents                         | 2,058      | 2      | 0      | 15      | 0      | 453       |
     | today, measured: computed documents                         | 1,866      | 1      | 0      | 22      | 0      | 243       |
     | today, measured: documents of the instance (the four above) | 5,882      | 9      | 2      | 50      | 2      | 938       |
     | today, measured: bytes of their values                      | 7,990,374  | 5,900  | 1,286  | 31,799  | 283    | 1,705,696 |
     | today, measured: bytes of their meta fields                 | 2,996,753  | 4,463  | 997    | 28,152  | 924    | 478,329   |
     | today, measured: envelopes                                  | 1,562      | 2      | 0      | 20      | 0      | 96        |
     | today, measured: label entries                              | 9,735      | 3      | 0      | 130     | 0      | 825       |
     | today, measured: envelope bytes, labels in place            | 4,481,160  | 968    | 0      | 47,114  | 0      | 348,887   |
     | today, measured: envelope bytes, labels by reference        | 1,505,693  | 578    | 0      | 19,710  | 0      | 163,929   |
     | today, measured: schema documents                           | 3,703      | 12     | 2      | 32.8    | 2      | 234       |
     | today, measured: other documents                            | 936        | 2      | 0      | 12      | 0      | 42        |
     | today, measured: documents the compile stored               | 4,444      | 9      | 9      | 29      | 9      | 321       |
     | today, measured: bytes the compile stored                   | 32,177,821 | 51,239 | 29,901 | 291,739 | 27,350 | 3,899,340 |
     | estimate from today's run: bytes of the result, inlined     | 6,112,595  | 3,205  | 786    | 13,327  | 15     | 1,705,985 |
     | compiled, derived: documents, least                         | 466        | 2      | 2      | 2       | 2      | 16        |
     | compiled, derived: documents, most                          | 1,834      | 3      | 2      | 8       | 2      | 335       |
     | compiled, derived: rows of the stream index                 | 734        | 1      | 0      | 8.8     | 0      | 122       |
     | compiled, derived: label entries, every label empty         | 213        | 1      | 1      | 1       | 1      | 1         |
     | compiled, derived: label entries, none empty, rows share    | 3,512      | 11     | 1      | 35.6    | 1      | 143       |
     | compiled, derived: label entries, none empty, rows differ   | 3,850      | 11     | 1      | 40      | 1      | 143       |
     | compiled, derived: envelope bytes at 88 per entry, most     | 338,800    | 968    | 88     | 3,520   | 88     | 12,584    |

     Documents: today's instance documents are 2.75 times the most derived at
     the median module (p10 1, p90 8.9), 3.2 times over the totals, and 12.6
     times the least derived. Over the 208 modules with no child the median is
     the same and the totals differ by 3.7. Bytes: today's values and meta
     fields together are 3.3 times the inlined result at the median (p10 1.6,
     p90 8.8) and 1.8 times over the totals. Two modules hold the bundle of an
     iframe guest, 1.6 and 1.7 MB, in one value, which both layouts store once
     and which is 54% of the estimate. Without them the totals differ by 2.7.
     Label entries: today stores 9,735, and the design stores between 213 and
     3,850 for the same runs. That is 2.5 times fewer over the totals against
     the most derived, and it is not fewer per module: 145 of the 213 modules
     store fewer entries today than the most derived, and 68 store none today,
     where the design stores the one entry of the pattern's atom. The gain is in
     the modules with many entries: the p90 is 130 today and 40 derived.

     | Largest ratio of documents               | documents today | value bytes today | entries today | documents derived | entries derived | ratio |
     | ---------------------------------------- | --------------- | ----------------- | ------------- | ----------------- | --------------- | ----- |
     | `showcase/wordsearch/play.tsx`           | 148             | 70,731            | 495           | 2 to 6            | 1 to 34         | 24.7  |
     | `dev/catalog/ui/sidebar/sidebar.tsx`     | 71              | 13,314            | 198           | 2 to 4            | 1 to 10         | 17.8  |
     | `examples/map-demo/map-demo.tsx`         | 70              | 35,398            | 254           | 2 to 4            | 1 to 60         | 17.5  |
     | `apps/topic-workbench/main.tsx`          | 115             | 46,729            | 469           | 2 to 7            | 1 to 112        | 16.4  |
     | `product/primitives/demo/atoms-demo.tsx` | 173             | 62,208            | 10            | 3 to 12           | 1 to 90         | 14.4  |

     | Smallest ratio of documents                         | documents today | value bytes today | entries today | documents derived | entries derived | ratio  |
     | --------------------------------------------------- | --------------- | ----------------- | ------------- | ----------------- | --------------- | ------ |
     | `showcase/battleship/multiplayer/repro-minimal.tsx` | 4               | 1,501             | 2             | 2 to 6            | 1 to 1          | 0.667  |
     | `dev/catalog/catalog.tsx`                           | 84              | 17,773            | 202           | 2 to 133          | 1 to 16         | 0.632  |
     | `dev/catalog/stories/style-tokens-story.tsx`        | 2               | 173,156           | 0             | 2 to 4            | 1 to 8          | 0.5    |
     | `dev/gideon-tests/style-object-repro/main.tsx`      | 2               | 5,861             | 0             | 2 to 4            | 1 to 14         | 0.5    |
     | `dev/catalog/ui/story-renderer.tsx`                 | 3               | 764               | 3             | 2 to 130          | 1 to 5          | 0.0231 |

     The three with a ratio below 0.7 that have a child are below 1 because the
     "most" row counts two documents for each child record of the plan and the
     scenario instantiates few of them. The two with 0.5 are patterns of one
     node today, two documents, where the "most" row adds a part per row of a
     kept collection.

     After the events of the 108 modules that have one, today's instance
     documents grew by 543 and the other documents by 526 (median 0 and 2 per
     module), and the label entries by 2,676. The design adds a stream document
     for each stream that received an event, 359 over these modules, and the
     same other documents: a receipt per handling and a document per record a
     handler writes into an array.

278. **Storage per element of a `map`.** 34 of the modules that run have a `map`
     over an array of the argument. Each was run to settle at two lengths of
     every array of its argument, 2 and 10, with no event. A figure is the
     difference between the two runs divided by 8.

     | Per element                                             | median | p10   | p90    | least | most    |
     | ------------------------------------------------------- | ------ | ----- | ------ | ----- | ------- |
     | today, measured: result documents                       | 1      | 0     | 3.7    | 0     | 17      |
     | today, measured: argument documents                     | 1      | 0     | 3.7    | 0     | 17      |
     | today, measured: internal documents                     | 1      | 0     | 5      | 0     | 14      |
     | today, measured: computed documents                     | 0.5    | 0     | 13.4   | 0     | 38      |
     | today, measured: documents of the instance              | 5.5    | 0     | 19.8   | 0     | 80      |
     | today, measured: other documents (the element's record) | 2      | 0     | 10.5   | 0     | 15      |
     | today, measured: bytes of values                        | 2,290  | 16.8  | 8,739  | 0     | 18,328  |
     | today, measured: bytes of meta fields                   | 3,101  | 0     | 10,093 | 0     | 44,208  |
     | today, measured: label entries                          | 15     | 2.1   | 225    | 0     | 292     |
     | today, measured: envelope bytes, labels in place        | 4,208  | 547   | 77,175 | 0     | 122,736 |
     | today, measured: envelope bytes, labels by reference    | 2,270  | 333   | 32,676 | 0     | 42,752  |
     | today, measured: milliseconds to settle                 | 18.8   | -1.83 | 86.9   | -9.83 | 194     |
     | today, measured: transactions                           | 0.5    | 0     | 13.9   | 0     | 38      |
     | today, measured: runs of an action                      | 0.5    | 0     | 15.5   | 0     | 39      |
     | estimate from today's run: bytes of the result, inlined | 974    | 0     | 3,810  | 0     | 5,024   |
     | compiled, derived: documents, most (a part per row)     | 1      | 0     | 1      | 0     | 2       |
     | compiled, derived: label entries, rows share            | 0      | 0     | 0      | 0     | 0       |
     | compiled, derived: label entries, rows differ           | 2      | 0     | 4      | 0     | 8       |
     | compiled, derived: cone instances                       | 2.5    | 0     | 7.7    | 0     | 31      |

     An element of today's median module costs 5.5 documents of the instance,
     which is a result document, an argument document, and the internal and
     computed documents of the element's nodes, with 5.4 KB of values and meta
     fields and 15 label entries. The design stores the element in the array, or
     in one part document, with no entry of its own where the rows share a label
     and 2 where they differ. The p10 of 0 is 5 modules. In three the `map` is
     over an array below the top level of the argument, which the two runs do
     not lengthen. In the other two the longer array adds no document of the
     instance. A negative time is the noise of two runs.

279. **What was not measured, and what it would take.**

     - _Any time of the compiled path._ It needs an executor of plans, and
       before that an emitter of value code. The smallest one that gives a
       number: emit one function per cone for expression code and call the
       sandboxed bodies as today's; evaluate the cones of a derivation
       transaction in the order of `Plan.cones` against the store of today;
       write the kept outputs to one result document. With no labels, no parts,
       no scope instances and no events, that measures the time to settle and
       the bytes of the result, on the modules with no collection first.
     - _Bytes of the compiled layout._ The inlined result of note 277 is an
       estimate. The real size needs the executor, and the rule of ES §4.10
       applied to it gives the part documents.
     - _Label entries of the compiled layout_ between the two bounds. The
       harness already evaluates the template of each compared output
       (`evaluateTemplate` in `compare/template.ts`). Counting the kept outputs
       whose label is not empty would give the count for a scenario, for the
       1,388 outputs the comparison reaches. It was not done here.
     - _The history._ The store keeps every revision of a document, and a
       document of today's layout is rewritten by each run that changes it. The
       bytes above are of the latest values. The revisions were not counted,
       since the replica does not hold them.
     - _A cold compile on the server and in the browser._ Both figures are of
       Deno on one machine.
     - _The modules that need `wish` or an effect_ (47), and the 10 whose run
       fails.

280. **Against the expectation that all three improve significantly.** Stated
     without softening:

     - _Compile time improves by two orders of magnitude at the median, and by
       3.4 times on FabriChat._ The second figure is a defect of the prototype's
       type evaluator (note 275), not of the design, and it is the figure for
       the reference pattern until that is fixed. The crate also does not yet
       emit code or hash, so its figure will grow.
     - _Run time is not measured._ The counts that stand in for it improve for
       the modules that are large today and not for the median module: the
       median module settles in 2 transactions today and in 2 by the design, and
       84 modules of 213 settle in one transaction today. The top tenth commits
       20 or more today and would commit 2. Runs of an action against cone
       instances is 2.3 to 1 at the median. Per event it is 3.4 transactions
       against 1 to 2.
     - _Storage improves in documents and in the modules with a `map`, and not
       in label entries for a small module._ Documents fall by 3.2 times over
       the corpus against the upper bound and the bound is loose in both
       directions (parts of a rendered tree are not in it, and unassigned state
       cells are). A small module stores no label entry today and one in the
       design. The bytes of values fall by an estimated 1.8 times over the
       corpus, and 2.7 times without two modules that each hold one value above
       1.5 MB. Most of what falls away is meta fields and links that the design
       does not store.
     - _The scenario is small._ Every array has two elements. The costs that
       grow with the data are per element, and per element the measured
       difference is 5.5 documents against at most 1, and 15 label entries
       against 0 to 2 (note 278). On data of realistic size the totals would be
       dominated by that row, which the corpus totals above do not show.

## Value code, an executor, and the values against today's runtime

Notes 281 to 306 are about the value code the crate emits beside a plan
(`src/emit.rs`, the `emit` command), the executor that runs the two
(`exec/executor.ts`), and the comparison of the values it computes with those of
today's runtime (`compare/values.ts`). ES is `execution-and-storage.md`. A note
that ends with **Needs a ruling** names something the executor could not take
from the documents and that the owner or the documents author has to decide. The
other notes record a choice the documents leave open, a defect of the prototype,
or a result.

281. **The artifact** (PL §1.1, `CompiledPattern`; ES §2.1). PL has a compiled
     pattern as two addressed things, the plan and the value code, and ES §2.1
     has the value code as "one emitted JavaScript function per `Cone` record of
     the plan, named by `Cone.entry` and addressed by `Cone.code`". Neither says
     what one artifact a compiler writes. The `emit` command prints one JSON
     record per pattern: the plan, the schema documents the plan names, and a
     member `code`. `code.modules` has one JavaScript text per module of the
     program that the plan's code is written in or imports. A text is the body
     of a function of two parameters, `$rt` and `$exports`. It holds the
     module's own statements of module scope, with the types removed, each
     import as a read of another module's exports, each export as a member of
     `$exports`, and the function of every `pattern(...)` call replaced by
     `undefined`. After those statements it holds one registration for each
     function the plan needs from that module. The other members of `code` are
     what the executor needed beside the plan, and notes 283 to 290 say why each
     exists. No ruling is needed for the shape itself.
282. **A function per value, and what a value function returns** (ES §2.2,
     `ConeResult`). ES has one function per cone that returns the cone's outputs
     by output index, the branch taken at each selector, the key at each choice
     point, and the value of each static side-write. The emitter writes one
     function per value a cone computes (`$rt.value`), and the function returns
     the value. In the crate's plans a cone has one value that another record
     refers to in all but the cones of an element body, where the per-element
     value and the assembled one share a cone, so the two forms hold the same
     code. The emitter reports no selection and no choice, because the executor
     instantiates no label and nothing else reads them. It emits no value for
     `Cone.writes`: a body's side-write goes through the handle the body holds,
     when the body runs (note 302). These three members of `ConeResult` are not
     exercised.
283. **Sandboxed code and value code share the scope of a module.** A body of
     the function tier names what its module declares: a helper function, a
     constant, an import. `Body.code` is "content address of the body's source
     as the loader receives it" (PL §1.1), and no document says in what scope
     that source is evaluated, or how the value code of a cone reaches a
     constant of the module it is written in. The emitter puts both into the
     module's text, after the module's own statements, so a name resolves as it
     does in the source. One plan can hold code from several modules, a pattern
     compiled in from another module among them, and each function is registered
     in the module it is written in. Not a question for the owner, and the
     documents should say it.
284. **A cone has no `within`** (PL §1.1, `Cone`; §1.4, "An interim value of an
     element body"). PL §1.4 says "the cone that computes the entry has the
     `element` step of the collection in its `within`", and the `Cone` record
     has no such member. The executor has to know for which element keys a cone
     instance exists before it evaluates the cone. The slots do not say it: PL
     §1.4 has "every cone of the body has slots of root `element`, or reads none
     and is evaluated per element key all the same", and of the 446 cones of an
     element body in the corpus plans, 38 list no slot of root `element` or
     `index`. The output paths do not say it either: a path has `*` for a
     collection and does not name it, and an interim output has no `*`. The
     artifact holds `code.coneWithin`: for each cone, the collections of the
     element bodies it is written in, outermost first. **Needs a ruling**: the
     member PL §1.4 refers to should be in the record.
285. **Where a slot sits in a body's argument** (PL §1.1, `Body.reads`; ES
     §2.4). `Body.reads` is a list of slot indexes, "slots the runtime
     materializes into the body's argument", and ES §2.4 has the runtime build
     "the slot part from `Body.reads`". A slot has a root and a path in the
     instance. For a handler the two give the place in the argument: root
     `event` is the first parameter and root `binding` the second, and the path
     is the path below it. For a `lift`, a `computed` or an authored function
     used in the reactive tier, the slot has the root and the path of what the
     caller passed, `argument/profile/name` for a body whose parameter is `p`
     and that reads `p.name`. Only `ComputedInput` has an `at`. The artifact
     holds `code.layouts`: for each use of a body, the path in the argument of
     each slot of `reads`. The corpus plans have 355 uses of a body that is no
     handler with 1,093 slots placed this way. **Needs a ruling**: an entry of
     `Body.reads` needs its place, as an entry of `Body.computed` has.
286. **The first value of a state cell** (PL §1.1, `StateCell`; §1.3). PL §1.3
     rules that "the value a declaration gives the cell is written when the cell
     is first created", and `StateCell` holds a name, a scope, a `within` and a
     schema. No record holds the value, and no cone computes it: the plan
     emitter does not evaluate the argument of `Writable.of(...)`. The emitter
     writes a function per state cell (`$rt.state`), which the executor calls
     when it makes the cell's document. Of the 1,399 such functions in the
     corpus, 1,377 are a literal, 19 are another expression that reads no slot,
     and 3 read a slot. A function that reads a slot reads it through no cone,
     so no record of the plan lists the read and no template has its label.
     **Needs a ruling**: where the plan holds the first value, and what the
     label of a first value that is computed from an input is.
287. **Constants.** Three kinds of constant reach value code and have no record.
     - A constant path of the result, such as `[NAME]: "Counter"`.
       `Plan.outputs` has an entry for a computed path and for a path that
       passes an input on. PL §1.4 gives the `result` cone "an expression
       written in the returned object, and a path that passes an input through",
       and `ConeResult.outputs` is by output index, so a constant path has no
       index to be returned under. The emitter writes one function for the
       result, which returns the whole record with the other cones' outputs read
       through `host.output`.
     - A constant of the argument of a pattern compiled in. PL §1.1 binds the
       argument "place by place" to "a slot of the caller, an output of the
       caller, or a constant". The emitter writes the body of a pattern compiled
       in as a setup function (`$rt.setup`), called with the constants of the
       argument, and the value functions it registers close over them.
     - A constant a handler written in place captures. `Binding.state.place` has
       `{ constant }`, "held as its value", for a literal and for a module-scope
       constant the compiler evaluates. The crate evaluates a literal written at
       the binding, and holds `null` for every other constant: 200 state entries
       of the corpus plans have `constant: null`. The emitter registers the
       function of such a handler inside the setup function it is written in
       (`$rt.handler`), so that the captured name is the one of its scope. The
       `null` entries are a defect of the crate. The documents should say that
       the value function of the `result` cone returns the constant paths, and
       how.
288. **A path the call of a compiled-in pattern leaves out** (PL §1.1, "The
     argument of a pattern compiled into another is bound place by place"; ES
     §2.2). Where the callee declares `symbol: Default<string, "$">` and the
     call writes no `symbol`, today's runtime reads `"$"`: the callee is an
     instance with an argument document and a schema. In the compiled path "no
     slot with root `argument` stands for the callee's own argument", and ES
     §2.2 gives a path "that resolves to a slot of the instance without a stored
     link" the default of that slot's schema, which is the caller's. A path the
     call leaves out resolves to nothing, and no record holds the callee's
     argument schema: the pattern has no `Child`. The emitter takes the default
     from the callee's declared argument type and writes it into the setup
     function. Without it the corpus showed `"undefined420.00"` for `"$420.00"`.
     Where the call does pass a slot of the caller and nothing is stored there,
     the executor reads the default of the caller's schema, as ES says, and the
     callee's default is not applied. **Needs a ruling**: that a path the call
     leaves out reads the default of the callee's type, and which default a path
     bound to an empty slot of the caller reads.
289. **The value of a constructed value that has an entry per path** (PL §3.4;
     ES §2.2). A rendered tree has one entry of `Plan.outputs` for its container
     and one for each member that is not constant. `ConeResult` has "the value
     of each output this cone computes, by output index", and no document says
     what the value of the container entry is, or whether the function also
     returns each member under its own index. The emitter's function returns the
     whole tree once, and the entries below it are paths of that value. The
     documents should state it.
290. **The stream of a binding in a computed value** (ES §2.2, "Side-writes are
     returned, not performed"; PL §1.1, `Binding.result`). A tree holds the
     stream of a handler at an event attribute. A cone's function "holds no
     handle", `ConeHost` has no member that yields a stream, and
     `Binding.result` exists "because the instance has to store a link to the
     stream at those positions and no other record says where". So either the
     function leaves the position empty and the runtime fills in the paths of
     `Binding.result`, or the function places the stream. The emitter adds
     `host.stream(binding)`, which the function calls at the position. The
     executor then compares where the stored result holds a stream with the
     paths `Binding.result` lists. Over the executed corpus modules (note 304),
     431 stored positions are named by a listed path and 18 are named by none,
     and of the listed paths without `*`, 315 hold the stream and 12 do not. Of
     the 18, 14 hold the stream of a binding that has no `result` member, for
     which the crate found no path, and 4 hold a stream that is an input of the
     pattern, which no binding stands for. The 12 were not examined. So the
     listed paths agree with where the value code puts a stream in all but those
     cases. The runtime still cannot place a stream from `Binding.result` alone:
     PL says a reader with the plan alone cannot resolve a path with `*` (§8,
     question 78), and a path below a conditional holds the stream under one
     selection only. **Needs a ruling**: whether value code places a stream,
     which `ConeHost` then needs a member for, or the runtime does, and from
     what.
291. **An `identity` and a `value` entry at one path of an argument** (ES §2.4,
     "What the argument holds at a path"). A handler that calls `count.get()`
     and `count.set(...)` has two slots at `binding/count`, one of each class.
     ES says "where two entries name one path, the argument holds the form that
     carries more: `value` before `enumeration`, `enumeration` before `shape`,
     and a reference stand-in where the only entries are `identity` and
     `shape`". It does not say what the argument holds for `identity` with
     `value`. By the wording the value would win, and the body's `count.set`
     would fail. The executor hands the body the handle: an entry at or below
     the position of a handle is what a read through the handle gives, and it is
     not put into the argument. The documents should state it.
292. **A name a body captures and reads nothing of.** The body
     `computed(() => { void flag; ... })` names `flag` and reads nothing of it,
     so its record has no entry for `flag`, and `Body.reads` and `Body.computed`
     list nothing. The body's code still names it. The emitter binds every name
     the body captures that the reactive tier declares, and the argument holds
     nothing at a name with no entry. The documents should say that a body is
     called with a binding for each name it captures, an empty one included.
293. **Element keys in the executor** (PL §1.3, "Element keys"; ES §2.5). The
     element part is "the identity of the cell the slot links to, when it holds
     a link". The executor's documents hold a link to a path of a document, and
     it takes the document and the path where the chain of links ends as the
     identity. It keys a position that holds a plain value by the canonical JSON
     of the value, with no salt, since it derives no document identifier a
     client could see. An element of a collection the instance computed is keyed
     as a link where the computing body passed a stored container on unchanged
     (note 300) and by its value otherwise. The state cell of an element body
     has the keys of its `within` in the identifier of its document. No ruling
     is needed.
294. **A moved element that is passed on by reference** (ES §2.6; PL §1.3, "A
     move is a membership change and a change of the index"). ES §2.6 has for
     "elements are reordered" that nothing is evaluated "unless a cone of the
     body reads the index", and PL has "no cone that lists only element slots is
     evaluated". For `tags.map((tag) => <li>{tag}</li>)` over plain values, the
     cone passes the element on by its `identity` slot, and the row holds a link
     to the address the element was read from, which is the position:
     `argument/tags/0`. After a move the key is bound to another position, and
     the link the row holds names the old one, where another value now is. The
     executor's first form evaluated nothing, as ES says, and the row of `"a"`
     showed `"b"` (`exec/test/executor.test.ts`, "keeps an element's state with
     its value when the element moves"). The executor now records the address
     each element slot was bound to and evaluates a cone instance again when
     that address changed. For a position that holds a link the address is the
     cell's and does not change. **Needs a ruling**: for an element that is a
     plain value in place, either a cone that passes it on is evaluated again on
     a move, or the row holds the value and not a link to the position.
295. **When the document of a state cell is made.** The documents give the
     identifier of a state cell's document (ES §5.2) and say the declared value
     is written "when the cell is first created" (PL §1.3). They do not say when
     that is: when the instance is created, or when a cone first binds a slot to
     the cell. Today's run has the document of every state cell of the pattern's
     body after the instance settled. The executor makes the documents of the
     cells with no `element` step when the instance is created, and those of an
     element body when the key enters the element table. The documents should
     state it.
296. **Which cones are evaluated** (ES §2.3). ES starts "from the demanded
     outputs whose cone instances are stale, in the order of `Plan.outputs`".
     The executor has no reader, so it evaluates every kept output and then the
     result. Three things followed.
     - A cone with a side-write whose value nothing reads. In
       `patterns/dev/test/non-idempotent/accumulator.tsx` a `computed` pushes
       onto a state cell, and the result passes that cell on by reference. No
       output of the cone is kept, and PL §3.11 excepts "the `identity` slot at
       the cell's root" from the slots that make an edge, so no edge leads from
       the writing cone to the `result` cone. A reader of the result reads the
       cell, and nothing in the plan has the writing cone evaluated before that
       read. The executor evaluates every cone of the pattern's own body that
       has a side-write before it stores the result. **Needs a ruling**: what
       demands a cone whose only effect is a side-write to a cell that the
       result passes on by reference.
     - A cone that writes a cell it reads. ES §2.7 makes such a cone instance
       stale again by its own write, up to the bound of ten evaluations, and
       then fails it. The executor evaluates it once: 6 evaluations over the
       executed corpus modules wrote a position they had read. Under ES those
       cone instances end in the error state. Today's runtime runs each once.
     - A branch that is not selected. ES §2.2 has "an output used only in the
       unselected branch of a conditional is not evaluated".
       `patterns/dev/gideon-tests/test-ifelse-both-branches.tsx` counts the
       evaluations of both branches of an `ifElse`: today's runtime evaluates
       both, and the executor the selected one (note 305).
297. **The container of a `pick`** (ES §2.2, assumed there under question 75).
     For `example[UI]` over the element of a collection, the cone lists the slot
     of the chosen child, at `*`, and no slot of the container. The emitter
     reads the container through that slot, and the executor yields every child
     for it, as ES assumes. The executed corpus modules have three with such a
     read. The assumption was enough.
298. **A handle to a constant** (PL §1.1, `Binding.state.place`; §3.11, "A write
     through a handle to a value the instance computes"). A pattern compiled in
     declares `step: Writable<number>`, the call writes `step={5}`, and a
     handler of the callee calls `step.get()`. The state path resolves to
     `{ constant: 5 }`, and the body holds a position of handle type there. ES
     §2.4 gives a handle at "a position of handle type" and speaks of a link or
     of "the position itself", and a constant has no position. The executor
     hands the body a handle that reads the constant and refuses a write, as the
     ruling on a write to a computed value has it. One event of the corpus is
     refused this way. The documents should say what a handle to a constant is.
299. **`equals` on a value with no address.** A handler compares an element of a
     list it read with a record from the event's payload, which the generated
     event gives as plain data. The executor's first form compared two values
     with no common address by their content, and removed a card from a pile
     that today's runtime keeps. It now compares addresses, and a value read
     from a stored address is never equal to one that was not. PL §3.16 has
     `equals` as a read of two references after resolution, which agrees.
300. **A container passed on unchanged** (ES §2.4, "A value passed on unchanged
     is stored as a reference", assumed there pending question 10 of the
     continuation plan). `items.get().filter((i) => !i.done)` in a `computed`
     returns records it read. A later `items.remove(item)`, with `item` an
     element of a `map` over that result, finds the record only where the
     elements of the result are references to the records of `items`. The
     executor gives every container it materializes the address it was read
     from, and stores a link where a body returns or writes such a container. A
     write of a list back to its own cell, as
     `items.set(items.get().toSpliced(i, 1))`, would then store links to the
     positions the write replaces, and the executor puts the values there
     instead. The values of the corpus need the rule, so the assumption stands
     as far as this comparison shows. What a write holds where the reference
     leads into what the write replaces is not in ES.
301. **A pattern called inside a cone, and what a cone lists.** Three properties
     of the crate's plan, each a defect of the prototype and not of the
     documents.
     - A pattern compiled in at a call written inside an initializer is
       evaluated in the caller's cone, where PL §1.4 has "a pattern compiled
       into the instance is cones by these same rules". The emitter follows the
       plan: the setup function of such a call runs when the cone is evaluated.
     - The cone the crate makes for an array written in place lists no slot of
       what the members hold. The value code of
       `[First({ ... }), Second({ ... })]` reads state cells of the two patterns
       through that cone.
     - `code.unlistedReads` has 76 reads over the 361 corpus patterns that no
       slot of the reading cone names, 55 of them the result of an operation (a
       pending effect, which the comparison does not run). At run time the
       executed modules made 165 reads of a slot the reading cone does not list,
       141 of them in two modules that hold an array of pattern results, and 29
       reads by root and path. Every read of an output of another cone was over
       an edge of `Plan.edges`, and every write of a handler was one a write
       edge or an envelope of its body covers (291 writes).
302. **What the executor does not do.** It instantiates no label, checks no
     constraint, has no transaction log, persists nothing, and runs no effect:
     the result of an operation reads as pending, and a module with an operation
     of kind `effect` or `wish` is not run by the comparison. It hands a body
     the whole value at a `value`, `shape` or `enumeration` slot and narrows
     none to its class (ES §2.4). It runs a body as plain JavaScript with no
     sandbox and no budget. It rolls a handler that throws back by restoring the
     documents. It makes no part document (ES §4.10), no stream document, and
     one scope instance. It does not instantiate a pattern or bind a handler in
     a function body (`BodyCall` of kind `instantiate` and `bind`), does not
     evaluate a `reduce`, and has no `elementById`, `linksOf`, or debug-string
     built-in. It reads `spaceOf` as the space it is given and has no acting
     principal. `Cone.writes`, `ConeResult.selections` and `ConeResult.picks`
     are not used.
303. **The fixtures.**
     `deno run -A --no-check
     base/pattern-compiler/compare/values-fixtures.ts`
     runs 19 of the 20 fixtures, 23 runs in all, with the scenario the tests of
     the label comparison write for a fixture where they write one and a
     generated one otherwise. All 23 are executed, and 122 of 122 compared
     values are equal. A value is one member of the result or one state cell of
     the pattern's body, after the instance settled and after each event.
     `fixtures/link-cycle.tsx` is left out: its handlers make two cells link to
     each other, and a read of the whole result of today's run rejects with a
     `LinkCycleError`. One event of `fixtures/handle-passed.tsx` is not handled,
     because its handler instantiates a pattern. The executor stores two
     documents for a fixture with no state cell, and one more per state cell.
304. **The corpus: what is executed.** `values-corpus.ts run` takes the 270
     modules the crate emits a plan for with no unsupported construct. Today's
     runtime runs 213 of them, as in note 273. Of the 213, the executor runs
     186, and 159 of those have every compared value equal and every committed
     event handled. The other 27 are not executed, by cause:

     | Cause                                                                | Modules |
     | -------------------------------------------------------------------- | ------: |
     | The emitter writes no code for a `reduce` in the reactive tier       |       7 |
     | The value code throws                                                |       6 |
     | An output that no value function computes                            |       4 |
     | A handler called in a function body                                  |       2 |
     | The built-in `toIndentedDebugString`                                 |       2 |
     | The emitter writes no code for a spread in the argument of a pattern |       1 |
     | A value that is no plain data                                        |       1 |
     | The built-in `linksOf`                                               |       1 |
     | The built-in `toCompactDebugString`                                  |       1 |
     | The value code does not parse                                        |       1 |
     | The value code names something it does not bind                      |       1 |

     The first row is the emitter's. The rows that name a built-in, a handler or
     a pattern called in a function body, and a value that is no plain data, are
     things the executor does not implement (note 302). The rows "the value code
     throws", "names something it does not bind" and "does not parse" are not
     examined one by one, and each is a defect of the prototype until shown
     otherwise. Of the 269 events today's runtime committed for the executed
     modules, the executor does not handle 15: 9 call `elementById`, 4
     instantiate a pattern in the handler, one writes through a handle to a
     constant (note 298), and one calls `increment` on a value that is no
     handle.
305. **The corpus: the values.** Over the executed modules, 4,537 values are
     compared, 4,472 are equal, and 65 differ, in 24 modules. Three things are
     made equal before the comparison: the children of a view node are one flat
     list; a child that is the result of a pattern is compared as its tree,
     since the compiled path holds the callee's tree in place at a child
     position (PL §1.1, question 53) where today's run holds the result with the
     tree under `$UI`; and a time read from the clock is compared as one token.
     The differing modules, by cause and class:

     | Cause                                                                                                       | Class                                         | Modules | Values |
     | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------: | -----: |
     | `dataFile(...)` at module scope, a built-in the executor does not have                                      | Prototype defect                              |       6 |      7 |
     | An event the executor did not handle (note 304), and what later values show of it                           | Prototype defect                              |       4 |     15 |
     | A handler factory as a value of the result (PL §3.21), which the executor does not store                    | Prototype defect                              |       1 |      5 |
     | A check today's JSX factory makes of a `$` attribute and the executor does not                              | Prototype defect                              |       1 |      2 |
     | A branch that is not selected is not evaluated (ES §2.2), and the pattern counts its evaluations            | Design difference the documents already state |       1 |      5 |
     | Today's runtime writes a cell in a template literal as `[object Object]`, and the executor writes its value | Today's runtime, not the design               |       1 |      5 |
     | A read of the acting principal or of an access list, which the executor does not have. Not verified         | Prototype defect, not verified                |       2 |      3 |
     | Not examined                                                                                                | Not classed                                   |       8 |     23 |

     The eight modules not examined are `examples/todo-list/todo-list.tsx`,
     `showcase/card-piles/main.tsx`, `examples/map-demo/map-demo.tsx`,
     `system/agent-run/agent-run.tsx`, `dev/catalog/catalog.tsx`,
     `examples/cfc-spec-gallery/main.tsx`,
     `dev/gideon-tests/test-cell-equals.tsx` and
     `showcase/wordsearch/wordsearch.tsx`.

     No difference is classed as a design gap by itself. The design gaps this
     round found are in what the executor needed to compute a value at all
     (notes 284 to 291, 294 and 296), and each of them showed as a wrong value
     or a failed run before the emitter or the executor supplied what was
     missing. The causes marked "not examined" are a first reading of the source
     and the two values, and are not verified.
306. **Documents.** The executor stores an argument document, a result document,
     and one document per state cell that exists, and counts a cell a function
     body creates. Over the 186 executed modules that is 1,302 documents, 7.0
     per module: 186 argument documents, 186 result documents, 898 state cells,
     and 32 created cells. Today's runtime stored 9,700 documents for the same
     modules and scenarios from the compile on, 52.2 per module, the cells the
     scenario gives its inputs through included (one per top-level input). The
     executor's count leaves out what ES §4.1 lists and the executor does not
     make: a part document, the state document of an operation, a stream
     document, and the instances document. So it is a lower bound on the
     compiled path's documents for these scenarios, and the derived counts of
     note 277 are the ones to compare with today's.

## Rulings Z2, Z3, Z4, Z6 and Z7 in the emitter and the executor

Notes 307 to 324 are about the owner's rulings of 2026-11-16 on what the
executor needed beside the plan (notes 285, 286, 288, 294 and 296). Each note
says what the crate and the executor do for a ruling, which statement of an
earlier note it replaces, and what the ruling leaves undetermined for an emitter
or an executor. A note that ends with **Needs a ruling** names something the
owner has to decide. Notes 284 (`Cone.within`) and 290 (who places a stream)
were ruled after these notes were written: notes 325 to 334 have them. FA is
`footprint-analysis.md`.

307. **Z2: an entry of `Body.reads` holds the place of its slot** (replaces the
     request of note 285). An entry is `{ slot, at }`, the `ReadInput` of PL
     §1.1, and `code.layouts` is gone: the executor builds the slot part of a
     body's argument from the plan (`Host.invoke` in `exec/executor.ts`). For a
     handler `at` is `event` or `binding` and then the slot's path. For another
     body it is formed as `ComputedInput.at` is: the name of the parameter or of
     the captured variable first, and for a `lift` the path below its one
     parameter (`body_record` in `src/plan.rs`). The corpus plans have 6,179
     entries, 1,314 of them in the 602 uses of a body that is no handler. Two
     things follow that the ruling does not speak of, and neither needs the
     owner. One slot can be placed twice, where two inputs of a use are bound to
     one place: the list then has two entries with one slot, and the body's
     template names the slot once. An entry whose `at` has a `*` stands for each
     element, and the executor places nothing for it: the container is given
     whole by the entry at the container's own path, where the body lists one.
     What the argument holds where the body lists no such entry is not in ES
     §2.4.
308. **Z4, a path the call leaves out** (replaces the first request of note 288
     and narrows the third item of note 287). The plan emitter binds the name of
     the callee's parameter to the default that the callee's argument type
     declares for the path, as a constant (`inline_argument` in `src/plan.rs`).
     PL §1.1 gives a constant of a compiled-in argument no record, so the
     default shows in one record alone, the state of a binding that captures the
     name: `Binding.state.place` is `{ constant: 5 }` for a callee that declares
     `step: Default<number, 5>` (`tests/emit.rs`,
     `a_path_the_call_leaves_out_is_a_constant_of_the_plan_with_the_default`).
     Of the 410 state entries of the corpus plans that hold a constant, 144 hold
     `null`, where note 287 counted 200. Elsewhere the constant is in the value
     code: the setup function of the call declares the name with the default.
     The corpus has 72 names declared with a default of the callee, for a path
     the call leaves out or writes a constant at. Two limits are the
     prototype's. The crate applies the default to a name the parameter
     destructures, and a callee that reads `props.symbol` of a parameter it does
     not destructure reads nothing. It applies it where the call writes its
     argument as a record, and not where the call passes one value for the whole
     argument.
309. **Z4, a path bound to a slot of the caller that holds nothing** (replaces
     the second request of note 288). Expression code of the callee reads the
     slot as `$rt.or($h.v($h.slot(i)), () => default)`, at 49 reads of the
     corpus. A sandboxed body of the callee is handed the default at the place
     of the slot: the value code passes `$h.invoke` a third argument, a list of
     places with their defaults, in 27 uses of a body (`Rewriter::compute` in
     `src/emit.rs`, `Host.invoke`). `fixtures/callee-default.tsx` has both
     halves, and today's runtime reads `"$"` in each: 8 of 8 values are equal.
     The slot's own schema is applied first, so a default of the place governs,
     as PL assumes (section 8, question 102). Three things are undetermined.
     - `ConeHost.invoke` of ES §2.2 takes a body and its computed inputs, and
       the runtime builds the slot part of the argument from `Body.reads`. An
       entry of `Body.reads` has no default, so a runtime that follows ES cannot
       hand a body the callee's default. Either `ReadInput` holds it, or value
       code passes it as the prototype does. **Needs a ruling**: which.
     - A callee that passes the path on by reference reads nothing. Its row
       holds a link to the caller's empty slot, and a reader of the row gets the
       default of the place or nothing, where today's runtime shows the callee's
       default. The crate applies the default to a read alone. **Needs a
       ruling**: what such a path of the callee's result holds.
     - "Nothing is stored" is read as `undefined`. A stored `null` is a value,
       and the default is not applied to it.
310. **Z3, a first value that is a constant** (replaces the request of note 286;
     changes notes 295 and 306). `StateCell.schema` names the schema of the
     cell's value with the first value as its `default`, and no code gives the
     value: the emitter writes no `$rt.state` for the cell
     (`Emitter::first_value` in `src/plan.rs`). A constant is what
     `Resolver::constant_value` (`src/types.rs`) evaluates: a literal, a negated
     number, an array or a record of constants, and a module-scope `const` with
     such an initializer. Of the 1,496 state cells of the corpus plans, 1,473
     have a constant first value, 15 have none, and 8 have another one (note
     312). The schema is the type argument of the constructor where the
     declaration writes one, and `{ "default": ... }` alone otherwise, which is
     a limit of the crate. The executor writes nothing when it creates such a
     cell (`Instance.stateCell`): the store holds the default for the cell's
     identifier (`Store.declare` in `exec/store.ts`), a read at any path of the
     cell reads the default while the cell has no document, and the first write
     makes the document. Over the executed corpus modules the state cells with a
     document are 98, where note 306 counted 898. So the question of when the
     document of a state cell is made (note 295; ES §8, question 83) has the
     answer "with the first write" for these cells. `compare/cost-model.ts`
     still counts one document per state cell, which is now an upper bound, and
     the derived figures of note 277 are not computed again.
311. **Z3, a write below the root of a cell that holds nothing.** The default
     stands for the whole value of a cell with no document. A write at a path
     below the root, as `draft.key("text").set("x")` on a cell whose default is
     `{ text: "", tags: ["new"] }`, has to start from something. Where the
     document is made from the written path alone, `tags` reads as nothing
     afterwards. The executor starts the document from the default and applies
     the write (`Store.write`; `exec/test/executor.test.ts`, "starts a write
     below the root of an empty cell from the default"), so the members the
     write did not name are stored from then on, with whatever label a stored
     default has. A `push` onto a cell whose default is an array that is not
     empty is the same case. A write of the whole value makes the document also
     where the value equals the default, which the ruling permits. **Needs a
     ruling**: what a write below the root of a cell that holds nothing stores,
     and the label of the members it takes from the default.
312. **Z3, a first value that is not a constant.** A cone computes it, the cone
     has a write edge with target `state` among its `writes`, and
     `StateCell.first` names the cone and the edge. The cone has no entry of
     `Plan.outputs`. The emitter registers the cone's function as
     `$rt.state(cell, ...)`, and the executor calls it once, when it creates the
     cell: for a cell of an element body when the key enters the element table,
     with that element bound, so `cell(index)` has the index of that moment
     (`fixtures/state-first.tsx`; `exec/test/executor.test.ts`, "writes a first
     value that is not a constant once, at creation"). A later change of what
     the cone read writes nothing. The 8 such cells of the corpus read no slot
     and no output of another cone: their value is a call, a record written in
     the pattern body, or a member of a module constant, which the crate does
     not evaluate. Two things are undetermined.
     - The cone lists what the value is computed from by its `value`, and the
       cell stores the value. For a declaration that gives the cell an input
       whole, as `Writable.of(start)`, the other reading stores a reference to
       the input, and a write of the cell then lands in the input. **Needs a
       ruling**: that the first value is stored as a value, never as a
       reference.
     - Today's runtime refuses a reactive value in a cell constructor
       (`validateStaticData` in `runtime/runner/src/cell.ts`), so no corpus
       module and no run of today's runtime has a first value computed from an
       input, and the fixture is not compared with today's runtime.
313. **Z6, a moved element** (replaces the request of note 294). The executor
     evaluates nothing for an element on a move but what read the index. The
     entry of a cone instance no longer records the address its element slot was
     bound to, and a cone reads an element that is a plain value stored in place
     as the value its key is formed from, held in the element table, so the
     evaluation reads no position (`Instance.rootOf`). What passes such an
     element on stores the value. In `fixtures/index-nodes.tsx` a move of two of
     three elements evaluates the function that reads the index for the two
     moved keys, 2 evaluations of a cone instance of an element body, where the
     executor before evaluated 4, and the row of each key shows its own title.
     `Instance.counts` has `elementEvaluations` and `assemblies` apart: the
     assembly of a collection is the runtime's step and runs again on a move.
     Where a body is permitted to evaluate the whole collection again, for an
     array one computation produces, the executor keeps results per key all the
     same.
314. **Z6, the keys of a derived collection** (adds to note 293). An element of
     the assembled result of a `map`, a `filter` or a `flatMap` has the key of
     the element it came from, and for a `flatMap` that key with the position in
     the element's segment, as PL assumes (section 8, question 101), which no
     fixture exercises. A cone instance of a body applied to such a result
     depends on the result of the upstream body for the same key, at the path it
     reads (`Instance.assembled`, `Host.depend`). `fixtures/chain.tsx` is a
     `map` over a `filter` over a `map`, once over records and once over plain
     values, and `exec/test/executor.test.ts` ("a chain of element constructs")
     runs it with the records given as references to cells. It counts the
     evaluations of cone instances of an element body:

     | Step                                                        | Evaluations |
     | ----------------------------------------------------------- | ----------: |
     | The instance is created: 3 records and 3 plain values       |          16 |
     | The title behind one reference changes                      |           2 |
     | `done` behind one reference changes, and the element leaves |           1 |
     | One plain value is replaced in place                        |           3 |
     | Both arrays are reversed                                    |           0 |

     The 2 are the first `map` and the last for that key: the predicate of the
     `filter` read `done`, which did not change. The 3 are one cone instance in
     each body for the key that entered. On the move the six collections are
     assembled again, once each. `Plan.edges` has no edge between the cones of
     the chain: `Collection.source` names the upstream collection, and that is
     what the executor takes the dependency from. The documents should say that
     a `source` of kind `collection` makes the cone instances of a key stale as
     an edge does.
315. **Z6, a derived collection that a cone passes on unchanged.** In
     `patterns/examples/todo-list/todo-list.tsx` a `computed` returns the result
     of a `filter`, and a `map` is applied to the `computed`. The plan has that
     `map` over an output, "an array the instance computed", which PL §1.3 keys
     by the rule for a stored array. Under ruling Z6 the result of a `filter`
     over plain values holds values, so the elements of the `map` have no place:
     a handler of its body that passes its element to `items.remove` removed
     nothing, and 6 values differed. The executor hands the elements of an
     assembled result on with their keys and their places where a cone returns
     the same array (`Instance.#table`), and the 6 values are equal. No test of
     the crate covers it. **Needs a ruling**: whether an output that passes a
     derived collection on unchanged carries the keys of its elements, and which
     record says so.
316. **Z6, what an element that is a plain value is to its readers** (keeps ES
     §8, question 79, open). The assumption that a cone which passes such an
     element on stores the value is what the executor implements, and the values
     of the corpus agree with it but for one. Four consequences show in the
     prototype.
     - Identity. A cone that compares the element with a reference, as
       `equals(selected, item)` in
       `patterns/dev/gideon-tests/test-cell-equals.tsx`, holds a value with no
       address, and the executor compares an addressed value and one without as
       two. Today's runtime, where the element is a cell, finds them equal. One
       value of the corpus differs for it.
     - A handler bound in the body is given the element as its position, which
       it writes through. The executor keeps the position beside the key for
       this alone.
     - A row that binds a member of the element both ways, as
       `$checked={item.done}`, holds a value, and a write from the tree has no
       target. The comparison reads values and does not show it.
     - A handler that writes a member of the element to a cell, as
       `center.set(stop.position)` in `patterns/examples/map-demo/map-demo.tsx`,
       stores a reference to a position below the array (ES §2.4, note 300).
       After the element is removed the reference leads nowhere, and the cell
       reads as nothing, where today's run keeps the value. Four values of the
       corpus differ for it.

     **Needs a ruling**: whether a plain value stored in place has an identity
     that `equals` and a stored reference can name, as the key and the
     collection, or whether a reader of one always holds a copy.
317. **Z7, the kind of a cone with side-writes in the plan** (adds to note 296).
     `Cone.sideWrites` is `static` or `materializer`, and absent for a cone with
     no side-write of a body. It is the tier FA §6.3 gives the cone's bodies,
     which the crate had (`Record.tier`, set where the analysis of a body ends
     in `src/footprint.rs`): a cone is a materializer where one of its bodies is
     one (`finish` in `src/plan.rs`). PL has no such member, and the kind can
     also be read from `Plan.operations`, where a materializer has an
     `Operation` that names its body. The documents author decides whether the
     member stays. `plan --corpus` counts the kinds over the 3,717 cones of the
     382 corpus patterns:

     | Kind           | Cones | What their bodies write                                  |
     | -------------- | ----: | -------------------------------------------------------- |
     | `static`       |    14 | 13 a state cell, 1 the cell of a handle at a slot        |
     | `materializer` |    33 | A cell the body creates under a cause computed from data |

     The 187 executed modules have 6 and 19 of them. No computation of the
     corpus writes through a `*`, a computed path, or a handle read from a
     value: every materializer of the corpus is a `lift` that creates a cell and
     gives it a value. The writes that expression code makes, a stored request
     and a first value, are in `Cone.writes`, name their target, and are not
     counted.
318. **Z7, a cone of kind `static` in the executor** (replaces the first request
     of note 296). The executor no longer evaluates every cone with a side-write
     before the outputs. Where an evaluation reads a slot, or the element table
     of a collection over a slot, at a place a write edge of a `static` cone
     names, the cone is evaluated first (`Host.demand`, `Instance.writersOf`).
     The class of the slot does not matter, so the `result` cone, which passes a
     state cell on by its `identity` slot, demands the cone that writes the
     cell: the case of `accumulator.tsx`. The entry of the reader keeps the
     cones it demanded and brings them up to date before it is taken as current,
     since a reader that passes a cell on reads nothing and is never stale by
     itself. A cone that nothing demands this way is not evaluated
     (`fixtures/side-write-undemanded.tsx`), where today's runtime evaluates it:
     a design difference the ruling makes. No value of the corpus changed with
     it. Three limits are the prototype's, and none needs the owner. A handler's
     read of a write target demands nothing in the executor. A write edge that
     names its handle by `computed`, and one with target `created` or
     `argument`, has no root and path, and the executor finds no reader for it.
     A cone of an element body whose reader is outside the body is evaluated for
     every key of the table.
319. **Z7, a materializer in the executor.** After the kept outputs and the
     result of a wave, the executor evaluates each materializer whose input
     changed, and a write it makes starts a further wave (`Instance.settle`). A
     reader of the materializer's own value in the wave reads what it returned
     last, and nothing before its first run. In `fixtures/side-writes.tsx` the
     cone that counts the keys the materializer wrote is evaluated twice when
     the instance is created, before the materializer and after it, and the
     values equal today's, 20 of 20. FA §6.3 has the result of a materializer
     read through a slot of root `operation`, and the crate's plan has the body
     in a cone and its value as an output of that cone, which is a defect of the
     crate. The ruling's "often after the rest of the wave" is "always" in the
     executor.
320. **Three defects of the prototype found on the way.** A name the pattern
     binds to `[SELF]` had no declaration in value code and resolved to a global
     of the host; it is a reference to the result now. The executor copied every
     container it read under a schema that describes its members, and the copy
     had no address, so a member a handler read through a typed handle was not
     found again by `equals` or `remove` (`withDefaults` in `exec/store.ts`).
     And note 315.
321. **The fixtures again.**
     `deno run -A --no-check
     base/pattern-compiler/compare/values-fixtures.ts`
     runs 22 of the 25 fixtures, 27 runs in all, and 152 of 152 compared values
     are equal, where note 303 had 23 runs and 122 values. The added runs are
     two of `callee-default` with 8 values, one of `chain` with 2, and one of
     `side-writes` with 20. Three fixtures are not compared with today's
     runtime: `link-cycle` as before, `state-first` (note 312), and
     `side-write-undemanded` (note 318).
322. **The corpus again.** The values of today's runtime are those of the run of
     note 304: `values-corpus.ts again` runs the executor alone on the crate's
     current output against them. The crate now emits a plan with no unsupported
     construct for 272 modules, two more, because a first value that is not a
     constant is no longer unsupported, and `values-corpus.ts run` ran today's
     runtime on those two.

     |                                               | Note 304 to 306 |   Now | Now, 272 modules |
     | --------------------------------------------- | --------------: | ----: | ---------------: |
     | Modules run by today's runtime                |             213 |   213 |              215 |
     | Executed                                      |             186 |   187 |              189 |
     | Every value equal and every event handled     |             159 |   161 |              161 |
     | Values compared                               |           4,537 | 4,539 |            4,607 |
     | Values equal                                  |           4,472 | 4,485 |            4,527 |
     | Values that differ                            |              65 |    54 |               80 |
     | Modules with a difference                     |              24 |    22 |               23 |
     | Committed events the executor does not handle |       15 of 269 |    15 |        20 of 278 |
     | Documents the executor stored                 |           1,302 |   504 |              509 |
     | Of them state cells                           |             898 |    98 |               99 |

     Two values that were equal differ now, both in
     `examples/map-demo/map-demo.tsx` after its last event: the handler of that
     event removes an area, which it did not find before the fix of note 320,
     and a cell that an earlier event had set to the area's center then reads as
     nothing (note 316). The two values of the module that differed after that
     event are equal now, so the module has 4 values that differ as before. No
     other value that was equal differs. `todo-list.tsx` (6 values, notes 313
     and 315), `card-piles/main.tsx` (2) and `contacts/contact-book.tsx` (4,
     both note 320) are equal throughout. `dev/test/input-self/subjects.tsx`
     executes now and has one value that differs of two: the result holds a
     reference to itself, which the executor's read gives as nothing at the
     second level and today's read follows. Of the two added modules,
     `battleship/pass-and-play/main.tsx` has 32 of 32 values equal, and
     `apps/base/contacts.tsx` 10 of 36: two of its handlers construct a cell
     with `new` in a function body, which the executor does not do. The result
     holds a stream at 425 positions a listed path names, where note 290 had
     431, and still at 18 that none names. The difference is not examined.
323. **The differences note 305 left without a cause.** Of its 23 values in 8
     modules, 6 are equal now (`todo-list.tsx`) and 2 more (`card-piles`). The
     other 15 values, by class:

     | Module                              | Values | Class                          | Cause                                                                                     |
     | ----------------------------------- | -----: | ------------------------------ | ----------------------------------------------------------------------------------------- |
     | `examples/map-demo`                 |      4 | Design gap                     | A stored reference to a member of a plain-value element, which is then removed (note 316) |
     | `dev/gideon-tests/test-cell-equals` |      1 | Design gap                     | `equals` of a reference with a plain-value element (note 316)                             |
     | `showcase/wordsearch`               |      3 | Neither                        | The pattern draws its seed from `Math.random`, and the two runs draw two numbers          |
     | `system/agent-run`                  |      4 | Today's runtime, not verified  | The scenario's argument holds `run.state`, and today's run reads nothing at `run`         |
     | `dev/catalog/catalog`               |      2 | Prototype defect, not verified | A child that is `null` in today's run holds nothing in the executor's                     |
     | `examples/cfc-spec-gallery`         |      1 | Prototype defect, not verified | A `$cell` attribute holds a pattern's result; today's read gives no `$NAME` below it      |

     The two rows classed as a design gap are the first differences of the
     comparison with that class. Both come from elements that are plain values
     stored in place, which today's runtime does not have: it stores an element
     that is a record as a cell of its own.
324. **Rules of the task not kept, and what is not verified.** The tests of
     rulings Z2, Z3, Z4, Z6 and Z7 were written before the code. The two fixes
     of note 320 in the executor were made from a corpus difference, with a test
     of the store written after the first and none for note 315. The counts of
     notes 308 to 310 are over all 382 corpus patterns, the ones with an
     unsupported construct included. The rows of note 323 marked "not verified"
     are a reading of the source and of the two values.

## Rulings Z10 and Z11 in the crate and the executor

Notes 325 to 343 are about the owner's rulings of 2026-11-16 on notes 284
(`Cone.within`) and 290 (who places a stream), and about four pieces of the
prototype that the earlier notes listed as missing. Each note says what the
crate and the executor do, which statement of an earlier note it replaces, and
what the ruling leaves undetermined. A note that ends with **Needs a ruling**
names something the owner has to decide. Every statement about a per-element
construct says which of the three cases it is about: a collection over an array
of references, over an array of plain values stored in place, or over the result
of another per-element construct.

325. **Z10: `Cone.within` is a member of the cone's record** (replaces the
     request of note 284). The record holds the steps of where the cone's code
     is written: the `element` step of each element body around it, outermost
     first, and the `site` step of each pattern compiled in, as PL §1.4 assumes
     under question 98 (`ConeOut.within` and `computing` in `src/plan.rs`).
     `code.coneWithin` is gone from the artifact. Of the 3,717 cones of the 382
     corpus patterns, 576 have an `element` step, 60 of those list no slot of
     root `element` or `index`, and 1,336 have a `site` step. The record is the
     same in the three cases: the plan does not say whether the elements of a
     source are references or plain values, and a cone of a body over the result
     of another construct names its own collection and not the upstream one
     (`tests/plan.rs`, `a_cone_lists_the_collections_it_is_written_in`). One use
     the documents do not name: the collection of a `reduce` is the last
     `element` step of the `within` of its step's cone, and the emitter and the
     executor take it from there (note 340), since `Operation.input` holds the
     `fold` node at no fixed place.
326. **Z10 in the executor.** The executor takes the collections a cone has an
     instance per key of from the `element` steps of `Cone.within`
     (`Instance.collectionsOf` in `exec/executor.ts`), and keeps each memo entry
     under the keys of those collections. `fixtures/within.tsx` has, in each of
     three callbacks, a declaration that reads neither the element nor the
     index: over references, over plain values in place, and over the result of
     a `filter`. Its cone has one instance per key in each (`exec/test/`, "the
     `within` of a cone"), and a change of the input it reads evaluates every
     instance. The executor now drops the instances of a key that left its
     collection (`Instance.#drop`), and a key that comes back has new instances,
     which are evaluated. It did not before, and the count of evaluations over
     the corpus is higher by a few for it. Two things are undetermined.
     - The executor drops the cone instances of a key and keeps the state cells
       declared under it. Over plain values in place a key is formed from the
       value, so a value that is removed and written again has the key it had,
       and its state cell reads what it held before. Over references the same
       holds for a cell that leaves a list and enters it again. ES §2.6 has a
       part document deleted when an element is removed and says nothing of a
       state cell. **Needs a ruling**: whether what is stored under a key is
       deleted when the key leaves its collection, in each of the three cases.
     - A cone of an element body whose reader is outside the body is evaluated
       for every key of the table, as note 318 has.
327. **Z11: the marker.** `Host.stream` returns a `StreamMarker`
     (`exec/store.ts`): a frozen object with no member. Which binding and which
     keys it stands for is in a map of the store's module that value code does
     not reach. `Host.v` returns a marker unchanged and `Host.at` reads nothing
     below it, so value code cannot read through it, and it has no `send`. The
     keys are those the cone instance that called has at the `element` steps of
     the binding's `within`, taken when it calls. Before, the executor gave
     value code the reference it gives a handler body, and a read of it in value
     code gave the record `{ $stream: true }`: in three corpus modules that
     record was stored in the place of a stream (note 330, the third row).
328. **Z11: the replacement and the check.** `Instance.stored` writes the link
     to the stream in the place of a marker, wherever the value is stored. The
     check is made where the result document is stored (`Instance.#check`, from
     `Instance.settle`): each marker in the value of the result has to be at a
     position that a path of `Binding.result` of its binding covers, segment for
     segment, with `*` for any element. A path below a conditional is listed
     whichever branch is selected, so it matches under either. Where a marker is
     at a position no listed path covers, the result is not stored, and
     `Instance.failures` has the binding and the position.
     `fixtures/stream-marker.tsx` binds a handler per element in three bodies,
     over references, over plain values in place, and over the result of a
     `filter`: the stored link has the key of the element in each, an event for
     it reads that element, and without its listed path each fails at the first
     element. Three things are undetermined.
     - ES §2.2 has "the cone instance takes the error state". A marker can be
       placed by one cone, passed through an interim output, and stored by
       another: the tree of `stream-marker.tsx` is one cone's value and the
       `result` cone stores it. The executor fails the evaluation of the result,
       which is the one that stores. **Needs a ruling**: which cone instance
       fails, the one that called `host.stream` or the one whose output holds
       the position, and what the positions of the result that the failed
       evaluation does not concern hold afterwards.
     - A marker stored outside the result, in a state cell or a created cell, is
       replaced and not checked, as ES assumes (section 11, question 78). No
       test of the crate stores one there.
     - A marker at an `identity` path of the `computed` argument of a body is
       handed to the body as a handle to the stream (`Host.invoke`,
       `Instance.handleOf`), as ES assumes under the same question.
329. **Z11: a stream that is an input of the pattern.** A slot of class
     `identity` yields the reference to the input's place, with the slot's
     schema, and what passes it on stores a link to that place (`Host.slot`).
     The check does not concern it. A read of a position that holds nothing and
     that the schema of the reference declares as a stream gives
     `{ $stream: true }`, as a read of a binding's stream does, and a `send`
     through such a handle does nothing: the executor has no other instance.
     Before, the executor stored a stream of no binding at such a position. 2 of
     the 18 positions of note 290 are of this kind:
     `apps/recommend-a-book/views.tsx` and `dev/catalog/ui/sidebar/sidebar.tsx`.
     Note 290 counted 4 positions of a stream that no binding stands for. They
     are 5: these 2, and the 3 of note 333.
330. **Z11: the positions no listed path named.** The count of note 290 was 18
     over the 189 executed modules. By kind:

     | Kind                                                                               | Positions | Bindings | What it was                                         |
     | ---------------------------------------------------------------------------------- | --------: | -------: | --------------------------------------------------- |
     | A member written after a spread among the children of a view node                  |         6 |        3 | Crate defect: the documents give the path           |
     | A stream inside a value the elements of a collection hold, read as `entry.node`    |         7 |        5 | Crate defect against an assumption of the documents |
     | The same, read as `entry[UI]`, which the executor did not store as a stream before |       208 |      208 | Crate defect and executor defect                    |
     | A stream that is an input of the pattern                                           |         2 |        0 | Executor defect (note 329)                          |
     | The stream of a binding a function body makes, which the body returns              |         3 |        0 | Not determined (note 333)                           |

     The first two rows are the "14 of a binding with no `result` member" of
     note 290, which are 13. The third row was in no count: the stored result
     held a record in the place of each stream (note 327). With the marker and
     the check, and the crate as it was, 12 evaluations in 8 modules failed:
     `apps/person-workbench/main.tsx`, `apps/project-list/main.tsx`,
     `apps/recommend-a-book/views.tsx`,
     `dev/catalog/stories/kitchen-sink-story.tsx`, the three modules of
     `examples/cfc-trusted-component-examples/`, and
     `examples/todo-list/todo-list.tsx`, whose position an earlier count missed
     because it is below a branch that is selected after an event. The crate now
     lists a path for each kind (`jsx_children`, `stream_paths` and
     `streams_of_elements` in `src/plan.rs`):
     - **After a spread.** PL §1.1 ("From a path to a position") has "a member
       written after a spread, whose path is `children/*` as well", and "two
       collections spread into one array of children: the path is a result path
       of each binding all the same". The crate dropped both, and gave the
       second the reason "two collections are spread into one array". It lists
       them now, in the children of a view node and in an array literal. The
       path is the same whether the collection spread before the member is over
       references, over plain values in place, or the result of another
       construct (`tests/plan.rs`,
       `a_stream_written_after_a_spread_has_the_path_of_the_positions_from_the_spread_on`).
     - **Through a member of an element.** PL §1.1 assumes, under question 84,
       that the path has `*` at the collection. The crate lists it for two
       sources: an array literal whose members hold the result of a pattern
       compiled in, which is an array of plain values in place, and the
       assembled result of another per-element construct, whose elements hold
       the stream of a binding of that construct's body. For an array of
       references the plan knows no stream inside an element, and lists none.
       Over the 382 corpus patterns, 1,142 of the 1,355 bindings of a handler
       have a `result` member, where 823 had one, and they list 1,420 paths,
       where they listed 1,012. Of the 202 bindings of an element body, 181 have
       a path, where 127 had one. With this, no evaluation of the corpus run
       fails the check.
331. **Z11: the listed paths that held no stream.** The 12 of note 290 are 12
     paths of 12 bindings in 7 modules, and each is below a conditional whose
     other branch is selected at the end of the run. 4 of them held the stream
     at an earlier point of the same run: one of `dev/catalog/catalog.tsx`, two
     of `product/collection-naming/item.tsx`, one of
     `product/primitives/check-list.tsx`. The other 8 held it at no point,
     because no event of the scenario selects the branch: five of
     `examples/group-chat-room/group-chat-room.tsx`, in the branch a session
     that is not expired selects, and one each of
     `examples/map-demo/map-demo.tsx`, `system/agent-run/agent-run.tsx` and
     `system/profile-create/profile-create.tsx`. For the last three and for
     `catalog.tsx` the source was read and the branch writes the stream. For the
     five of `group-chat-room.tsx` only the other branch was read. So none of
     the 12 is a path that no selection fills, as far as this was examined, and
     the crate changed nothing for them. The run cannot show such a path: the
     check is of the markers a run stores (ES §2.2).
332. **Why the count of positions at a listed path went from 431 to 425.** Three
     modules hold 2 positions fewer each at the end of the run:
     `apps/contacts/contact-book.tsx`, `examples/map-demo/map-demo.tsx` and
     `examples/todo-list/todo-list.tsx`. In each, the fix of note 320 made a
     handler's `remove` find its element, so the list has one row fewer at the
     end, and a row holds the stream of its binding at two positions. The listed
     paths that hold the stream were 315 before and after. No path was lost.
333. **The stream of a binding a function body makes.** In
     `dev/gideon-tests/computed-array-repro.tsx` a `computed` returns rows that
     each hold a handler written in the body. The stream is no marker: the body
     returns the reference, and the stored result holds a link to it at 3
     positions that no path names. PL §1.1 has `Binding.result` as the paths "at
     which value code can place the stream", and a body is not value code. A
     body that is handed the stream of a binding of the reactive tier and
     returns it is the same case. The executor checks neither. **Needs a
     ruling**: whether a stream that a body returns into a kept path of the
     result is allowed, and if it is, what states where it is stored, since the
     compiler does not know the path.
334. **What a `*` of a listed path stands for, after ruling Z11.** A complete
     list has `children/*` for three things: every element of a collection holds
     the one stream of an outer binding, one member written after the spread
     holds it, or one element holds it inside a value (note 330). The path does
     not say which, as PL §8 has under questions 78 and 84. Two consequences
     showed. The check accepts a marker of such a binding at any position from
     the spread on, so it does not find a marker at a wrong one of them. And a
     reader with the plan alone resolves the path wrongly: the harness of the
     comparison sent an event for the binding of `fixtures/stream-marker.tsx` to
     the stream of an element, where the path was that of a member after the
     spread. The harness now tries a path with no `*` first and resolves no
     position where today's run holds a child after the assembled array
     (`streamAt` in `compare/harness.ts`). **Needs a ruling**: whether
     `Binding.result` says, for a `*` that no `element` step of the binding
     names, which of the three it stands for.
335. **A tag in a branch of a conditional at a child position.** PL §1.1 has the
     callee's tree in place where a tag "is written at a child position of a
     view node". In `dev/catalog/catalog.tsx` the tag is a branch of a
     conditional that is the child. The crate lists the path with `$UI` after
     the position, as for "every other place", and the executor stores the
     callee's result there, so the two agree and the check passes. The documents
     do not say which rule a branch of a conditional follows. Not a question for
     the owner.
336. **`x[UI]` is a chosen child in the crate.** The crate evaluates a member
     read with a computed key as a `pick`, also where the key is `UI` or `NAME`,
     which the pattern API names and which is a static path. It now lists the
     streams below such a read (`ComputedMemberExpression` in `eval`,
     `src/plan.rs`) and still emits the `pick`. A defect of the prototype.
337. **The keys of the result of a `flatMap`** (keeps PL §8, question 101,
     open). `fixtures/flat-keys.tsx` has a `flatMap` over references, whose
     segment is an array the element holds, and one over plain values in place,
     whose segment the callback writes, each with a `map` over its result. The
     cone instances of the `map` have the key of the source element with the
     position in the segment, in both. A segment behind a reference that grows
     evaluates the new position alone, a move of the source elements evaluates
     nothing in either case, and a plain value that enters evaluates its own
     segment. One consequence differs from ruling Z6: two members of one segment
     that change places are two keys whose values changed, and both are
     evaluated again, where a moved element of a `map` keeps its results. A
     state cell declared in a body over the result of a `flatMap` would stay
     with the position in the segment and not with the member. **Needs a
     ruling**: whether the element part of such a key is the position in the
     segment, or is formed from the member as the key of a stored array is.
338. **The record of a key of a list** (`elementById`; replaces its entry in
     note 302). The executor names a place by the address of the list and the
     key, which holds nothing and has no document until something writes it
     (`Instance.keyedElement`). `addUnique` appends a reference unless the list
     holds it, and `removeByValue` removes the members that are the reference. A
     write through the handle counts as a write at `*` below the list, as FA §7
     records the handle. `fixtures/keyed.tsx` has 48 of 48 values equal with
     today's runtime. ES has no statement on `elementById`: FA has the handle
     "at `*` below" the list and "not anchored", and today's runtime makes an
     entity of its own that is no position of the list until it is added
     (`elementById` in `runtime/runner/src/cell.ts`). The executor does what
     today's runtime does. **Needs a ruling**: where the record of a key is
     stored and how it is named, and whether a record that is no member of the
     list is below the list for a reader of the list's label.
339. **A cell made with `new`.** A cell constructor is called with `new` in a
     function body as with `of` (`commonfabric` in `exec/executor.ts`). Both
     corpus events that failed for it now fail at the next step, a pattern
     instantiated in the handler (note 341).
340. **A `reduce` in the reactive tier** (replaces its entries in notes 302 and
     304). The emitter registers
     `$rt.reduce(operation, cone, initial, cone,
     step)` where the `reduce`
     is written (`Rewriter::reduce_construct` in `src/emit.rs`): the function of
     the initial value, in the cone the `reduce` is written in, and the function
     of the step, which reads the accumulator as the slot of root `operation`
     its cone lists. The executor evaluates the initial value and then the step
     once per element, in the order the collection iterates, as one entry
     (`Instance.reduced`): the whole fold is evaluated again when what a step
     read, the membership, or the order changed. `fixtures/reduce.tsx` folds
     over references, over plain values in place with the index, and over the
     result of a `map`, and 3 of 3 values equal today's. The 9 `reduce`
     operations of the corpus are all registered. Three limits are the
     prototype's. The fold is not kept per key, so one changed element evaluates
     every step. A `reduce` with no initial value has no function for it. And
     the compiler of today's runtime refuses a step that reads an outer input,
     so that case is in `tests/emit.rs` alone and is not compared.
341. **What was not reduced.** A pattern instantiated in a function body (6
     events) and a handler bound in one (2 modules) are not done. PL §3.15 and
     ES §2.8 say what an instance a body makes is. What stops the prototype is
     the artifact: `Child.callee` names a compiled pattern by hash, and the
     output of `emit` holds one plan and its code per pattern of a module, with
     no member for the plan of a pattern from another module (note 281). The
     executor would also need more than one instance over one store. The debug
     strings and `linksOf` (6 modules) are built-ins of today's runtime that
     were not looked at. None of these needs the owner.
342. **The fixtures and the corpus after these rulings.**
     `deno run -A --no-check base/pattern-compiler/compare/values-fixtures.ts`
     runs 27 of the 30 fixtures, 33 runs in all, and 280 of 280 compared values
     are equal, where note 321 had 27 runs and 152 values. The added runs are
     `within` (3 values), two of `stream-marker` (70), `flat-keys` (4), `keyed`
     (48) and `reduce` (3). The corpus figures are of `values-corpus.ts again`
     on the values of today's runtime that the run of note 322 read:

     |                                               | Note 322, 272 modules |       Now |
     | --------------------------------------------- | --------------------: | --------: |
     | Modules run by today's runtime                |                   215 |       215 |
     | Executed                                      |                   189 |       194 |
     | Every value equal and every event handled     |                   161 |       167 |
     | Values compared                               |                 4,607 |     4,735 |
     | Values equal                                  |                 4,527 |     4,642 |
     | Values that differ                            |                    80 |        93 |
     | Modules with a difference                     |                    23 |        24 |
     | Committed events the executor does not handle |             20 of 278 | 15 of 293 |
     | Evaluations that fail the check of note 328   |                     — |         0 |
     | Stored stream positions at a listed path      |                   440 |       683 |
     | Stored stream positions at no listed path     |                    18 |         3 |
     | Documents the executor stored                 |                   509 |       535 |

     Over the 189 modules that were executed before, 4,529 of 4,607 values are
     equal, 2 more, and 11 events are not handled, 9 fewer. Seven values of
     `apps/topic-workbench/main.tsx` are equal now that its events are handled
     (note 338). Five values of `apps/person-workbench/main.tsx` that were equal
     differ: its handler `attachToPicked` ran to its end for the first time, and
     it attaches a session where today's run returns early because the picked
     card is nothing. The executor holds something that is not nothing for the
     card. That was so before and did not show, because the event failed at
     `elementById`. Not examined further, and a defect of the prototype until
     shown otherwise. No other value that was equal differs. The five modules
     executed for the first time are those with a `reduce`:
     `apps/budget-tracker/data-view.tsx`,
     `product/primitives/amount-ledger.tsx`, `budget-vs-actual.tsx` and
     `spend-by-category.tsx` have every value equal (80 values), and
     `product/primitives/demo/atoms-demo.tsx` has 33 of 48, with 4 events not
     handled, each a handler of a pattern compiled in whose state holds a
     constant where the handler expects a handle (note 298). Its 15 differences
     were not examined. Two modules with a `reduce` now stop at
     `toIndentedDebugString`. The 3 positions at no listed path are those of
     note 333. The 26 documents more are 5 argument and 5 result documents of
     the added modules, 5 state cells, and 11 records of a key.
343. **Rules of the task not kept, and what is not verified.** The tests of
     rulings Z10 and Z11, of the crate's paths, of `keyed`, and of `reduce` were
     written before the code. The three tests of where a marker of an element
     body is stored passed before the change, since the executor stored such a
     stream already. The fixture of `flatMap` keys describes what the executor
     did and changed no code. The classes of note 331 rest on a reading of the
     source for 7 of the 12 paths and of one branch for the other 5. The
     difference of `person-workbench` and the differences of `atoms-demo` in
     note 342 are not examined. No fresh run of today's runtime over the corpus
     was made: `again` uses the values of the earlier run, and the change to the
     harness (note 334) is exercised by the fixtures alone.

## What today's runtime stores for a record in a list, and rulings Z12 to Z17

Notes 344 to 366 are about a measurement of today's runtime and about the
owner's rulings Z12 to Z17 of 2026-11-16. Each note says what the crate and the
executor do, which statement of an earlier note it replaces, and what a ruling
leaves undetermined. A note that ends with **Needs a ruling** names something
the owner has to decide. Every statement about a per-element construct says
which case it is about: an array of references, an array of plain values in
place, or the result of another per-element construct.

344. **What today's runtime stores when a record gets into a list.** Measured
     with the runner alone (scratchpad
     `cpp/probe26/list-record-storage.test.ts`, 12 tests):

     | How the element is written                            | What the list stores                  | The key `map` gives the element                | A reference to `item.position` stored elsewhere, after the element is removed |
     | ----------------------------------------------------- | ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
     | `items.push({ ... })` in a handler                    | A link to a document of the record's  | The record's document, with no path            | Reads the record's value still: the document stays                            |
     | `items.set([...items.get(), { ... }])` in a handler   | The same for the new record           | The same                                       | The same                                                                      |
     | A record of the argument the instance is created with | The record, in the argument document  | The argument document and the path `items/<n>` | Reads the element that moved to the position, and nothing once none is there  |
     | A record of a `Default` of the argument               | The record, written into the argument | The same, by position                          | The same                                                                      |
     | A string, however it is written                       | The string, in the list               | The list's document and the position           | Reads the string that moved to the position                                   |

     `Cell.set` and `Cell.pushAll` (`runtime/runner/src/cell.ts`) call
     `diffAndUpdate` and `diffAndAppend` with `frameAnchorIds(frame)`, and
     `normalizeAndDiff` then gives a plain object that sits in an array a
     document of its own through `anchorValueAsEntity`
     (`runtime/runner/src/data-updating.ts`). The document's id is
     `createRef({ id }, { parent, path, context })` over the counter of the
     writing frame, the list's document, the path of the list, and the frame's
     cause: it is formed from where and by which run the record was written, and
     two pushes of equal records make two documents. A record the list held
     stays as it was: in place, or the link it was. `Runner.#updateArgument`
     (`runtime/runner/src/runner.ts`) writes the argument with no source of
     anchor ids, so its records stay in place. `listElementKeys`
     (`runtime/runner/src/builtins/list-element-keys.ts`) keys a slot by the
     link it resolves to (`cellIdentityKey` in
     `runtime/runner/src/builtins/scope-policy.ts`), which for a value in place
     is the position. A schema read of a record in place gives it a `snapshot:`
     address (`arrayItemUsesValueIdentity` in `runtime/runner/src/traverse.ts`),
     and a cell set to such a value holds a copy. So the sentence "a record that
     a handler writes into a list is a cell of its own" holds as worded. "An
     element that is a record is a cell of its own" (PL §1.3, ES §2.6, notes 316
     and 323) does not hold for a record of the argument or of a default:
     today's runtime keys it by position, and a reference to it reads whatever
     stands at the position.
345. **The executor stores what today's runtime stores** (replaces the class of
     two rows of note 323). `Handle.set`, `Handle.push` and `Handle.addUnique`
     put each record that sits in an array of the written value into a document
     of its own and store a link (`Instance.anchored` in `exec/executor.ts`).
     The list is then an array of references, and rulings Z6 and Z12 do not
     concern it. `fixtures/list-records.tsx` has 84 of 84 values equal to
     today's. Over the corpus the 4 values of `examples/map-demo/map-demo.tsx`
     and the 1 of `dev/gideon-tests/test-cell-equals.tsx` are equal now: both
     modules fill their list with `push`, so their elements are cells in today's
     runtime and in the executor, and the two rows of note 323 classed "design
     gap" were a defect of the prototype. 64 such documents exist after the
     corpus scenarios. Four limits are the prototype's. The identifier is a
     counter, not the `createRef` of today. A `set` of a record at a position of
     an array, as `items.key(0).set({ ... })`, stores it in place. A cell a body
     creates with an array of records keeps them in place. And the executor does
     not write a default of the argument into the argument document, where
     today's runtime does.
346. **Z12: the reference by key in the executor** (replaces note 316 and the
     second half of note 313). The case is an array of plain values in place. A
     reference to an element is a `Ref` whose path has, at the array, a segment
     that holds the key (`keySegment` in `exec/store.ts`), and the path below
     the element follows: the form PL §1.3 assumes under question 113, "a link
     whose target is the address of the collection, with the key in the place of
     a position". `Store.locate` finds the position that holds the key at each
     read and each write. The element table gives every reader that reference
     (`Instance.#stored`): a cone, a handler bound in the body, and the assembly
     of a `filter`, which passes the element of its source on. What passes the
     element or a member on stores the link with the key. A read through it
     records no position: it records the reference and the value read, and it is
     stale when a read gives another value (`Position.keyed`,
     `Store.changedSince`), so a move evaluates nothing
     (`exec/test/executor.test.ts`, "an element that is a plain value in
     place"). Over an array of references the element is the link to its cell as
     before, and each test has that case beside it. Over the result of another
     per-element construct, an element a `filter` passes on is the reference of
     the source. An element of a `map` or `flatMap` result whose body computes a
     value is passed on as that value: PL names "the assembled result, as the
     output that holds it" as the collection, and the executor stores no
     assembled result at an address of its own. The key holds the value with no
     salt (note 293). An element that holds a link to an element of its own
     array is keyed by that reference, with no key resolved.
347. **Z12: a write that changes the value, as the documents assume** (PL §8,
     question 112). The case is an array of plain values in place. The reference
     keeps the key it was made with. `fixtures/value-identity.tsx` shows the
     consequence in three handlers of a row:
     - `stop.key("done").set(true)`: the event commits. The position holds
       another key, the cone instances of that key are evaluated, and the row
       holds the reference with the new key. The state cell `open` of the row is
       that of the new key and reads its first value, `false`, where the row had
       set it to `true`: the cell of the old key keeps its document and nothing
       reads it. A cell that held the element, `selected`, reads as nothing, and
       `equals(selected, stop)` is false in every row.
     - `stop.key("done").set(true)` and then `stop.key("title").set(...)`: the
       second write finds no position that holds the key, and the event is
       rejected with both writes.
     - `stop.update({ done: true, title: ... })`: the executor resolves the key
       once and writes both members, and the event commits. Whether `update` is
       one write is not in the documents.

     Over an array of references the same two writes commit and the row keeps
     its state. No event of the corpus run is refused for a missing key. **Needs
     a ruling**: question 112 as the documents put it, with these consequences:
     a row loses its state cells on every write to its element, a cell that
     holds the element loses it, and a handler that writes two members one after
     the other is rejected.
348. **Z12: a function body that read the array through a handle** (PL §8,
     question 115, first half, assumed). The case is an array of plain values in
     place. A container that a read of a stored array gives carries the
     reference by key (`Store.#copy`), so `selected.set(items.get()[i])` stores
     it. One module of the corpus shows what follows where a handler moves
     values between two arrays: `showcase/card-piles/main.tsx` reads two piles,
     shuffles the cards and sets both piles. The first pile then holds
     references by key into the second, the second is set next, with references
     into the first, and neither key is held any more: the cards that changed
     piles read as nothing. Today's runtime stores copies there. 6 or 9 of the
     module's 28 values differ, or none, by what `Math.random` draws. Before,
     the executor stored a link to the position, which read whatever card stood
     there, and the scenario's cards are all equal. ES §2.4 assumes under
     question 84 that a reference into what a write replaces is stored as the
     value, which covers one array and not two. **Needs a ruling**: whether a
     function body that reads a plain value in place and writes it elsewhere
     stores a reference by key or a copy.
349. **Z12: a handle that names a position is not equal to a reference by key**
     (PL §8, question 115, second half, assumed). The case is an array of plain
     values in place. In `dev/gideon-tests/test-handler-capture-key-equals.tsx`
     a handler of a row finds its element with
     `inboxItems.key(i).equals(inboxItem)`. The handle of `key(i)` names the
     position, the row's element is a reference by key, and the two are not
     equal, so the handler removes nothing: 2 values differ. Today's runtime
     finds the element, since both are the position there. Over an array of
     references both resolve to the cell and are equal. **Needs a ruling**:
     whether `items.key(i)` is equal to the reference by key of the element that
     stands at `i`.
350. **Z12: `equals` in value code.** The emitter wrote `equals` with the value
     of each operand, and two equal plain values were one. It now writes
     `$h.equals(a, b)` with each operand as the reference it is
     (`Rewriter::call` in `src/emit.rs`; 18 calls in the corpus), and the host
     resolves the links each holds and compares what they name, with no key
     resolved to a position (`Host.equals`, `Store.locate` with `names`). The
     evaluation depends on the links it crossed. `ConeHost` of ES §2.2 has no
     member for it: the documents should say how value code compares two
     references. Today's compiler refuses a string operand of `equals`, so the
     fixture compares records with `equals` and tells two equal strings apart by
     a stored reference to one of them.
351. **A reference stand-in at a position of a handler's state** (ES §2.4). The
     executor handed a body a handle at every `identity` entry, and
     `stop.position` of a handler whose state declares `stop: Stop` was nothing.
     It now hands a stand-in that carries the reference where the slot's schema
     declares no handle, and places the entries below it. It does so for a slot
     of root `binding` alone. The schema of a slot of a `lift` or a `computed`
     is that of the place the caller bound, which for a body of a pattern
     compiled in is the caller's type and not the body's: in
     `dev/gideon-tests/test-pattern-composition-shared-cells.tsx` the caller
     declares a plain array and the callee's body calls `items.get()`. The
     documents should say which record tells the runtime that a position of a
     body's argument is of handle type.
352. **Z12 leaves note 326 open.** The executor still keeps the state cells of a
     key that left its collection. With a key formed from the value, a value
     that is written back finds the cell it had, and a value that was edited
     finds none (note 347).
353. **Z13: the mark in the plan** (replaces the request of note 315).
     `Output.passesCollection` names the record of the collection. The crate
     marks a promoted `computed` whose expression is the assembled result of a
     `map`, a `filter` or a `flatMap`, or a marked output (`Computed.passes` in
     `src/plan.rs`; `tests/plan.rs`,
     `an_output_that_passes_a_derived_collection_on_is_marked_with_the_collection`).
     An output that is the result under one selection only has no mark, as PL
     assumes under question 111. The corpus plans have 27 marked outputs in 15
     modules. Two limits are the prototype's: a `computed` with a block body
     that returns the result, and a result path of a sandboxed body that passes
     its input on, have no mark. The mark is the same whether the upstream
     source holds references or plain values in place, since the plan does not
     say which.
354. **Z13 in the executor.** A construct whose `source` is a marked output
     takes the element table of the marked collection (`Instance.#table`), and
     checks that the output holds the array that was assembled. The map from an
     array to its elements that the executor kept beside the plan is gone.
     `fixtures/passes-collection.tsx` has the case over references, where the
     keys are those of the cells with or without the mark, and over plain values
     in place, where a `filter` that drops the first of two equal values leaves
     the second with the count it has in the source, and without the mark the
     count is lost. No value of the corpus changed.
355. **Z14: nothing changed in the executor** (replaces the request of note
     311). `fixtures/state-below.tsx` has a write of one member and a `push`
     below the root of a cell that has no document, in the pattern's body and in
     an element body over references, over plain values in place, and over the
     result of a `filter`: 54 of 54 values equal today's. The executor
     instantiates no label, so the label of the members taken from the default
     is not exercised. One case the ruling does not name: a `push` through a
     handle to a path of the argument at which nothing is stored and whose
     schema declares a default array. The executor starts from the empty array
     there, by a reading of its code and with no test. Today's runtime has
     written the default into the argument document by then (note 344). **Needs
     a ruling**: whether a write below a place that holds nothing and is no
     state cell starts from the default of the place.
356. **Z15: a computed first value is a value** (replaces the first request of
     note 312). The emitter wrote a read of the slot's value already, and the
     executor now resolves a reference a value function returns before it stores
     (`Instance.stateCell`). `fixtures/state-first.tsx` gives a cell an input
     whole and the cell of a row its element: over references the cell holds the
     value behind the link, over plain values in place the value and no
     reference by key, and a write below the root of the cell leaves the input.
     A member of handle type is stored as a value too, where ES §4.1 assumes a
     link under question 87: a limit of the prototype. The fixture is not
     compared with today's runtime (note 312).
357. **Z16: `ReadInput.default`** (replaces the first request of note 309). An
     entry of `Body.reads` of a body of a pattern compiled in has `default`
     where its slot is at or below a slot of the caller that the call bound a
     path of the callee's argument to, and the callee declares a default for the
     path (`slot_defaults` and `default_for` in `src/plan.rs`): 51 entries in 9
     modules of the corpus. Value code passes `$h.invoke` the computed inputs
     alone. The executor applies the slot's own schema first and the entry's
     default where the slot still yields nothing (`Host.invoke`). The record is
     the same for a callee in an element body over references, over plain values
     in place, and over the result of a `filter`
     (`fixtures/callee-default.tsx`). One thing the ruling does not name: where
     a callee calls another and both bind one slot of the outer caller, the
     crate lists the outer callee's default, since its place is nearer the end
     of the chain a read resolves through (ruling Z8). The documents should
     state it.
358. **Z16: a reference the callee passes on** (replaces the second request of
     note 309). Value code of the callee wraps the reference in
     `$h.withDefault(reference, default)`, 42 times in the corpus, and the
     stored link holds the default in its schema unless the schema of the
     caller's place declares one. `Store.locate` reads, through a chain of
     links, the default of the last link that declares one, and the reader's own
     where none does (`exec/test/executor.test.ts`, "reads, through a chain of
     links, the default declared nearest the end"). The crate does this where
     value code of the callee stores the reference. Where code of the caller
     names a path of the callee's result, as `price.symbol`, the crate resolves
     the name to the caller's slot at compile time and writes a read of that
     slot with no default: a defect of the crate. Behind it is a gap of the
     plan. The ruling has "the link holds the schema that the callee declares
     for the path", and no record gives a runtime that schema for a reference an
     output passes on: the slot has the schema of the caller's place. **Needs a
     ruling**: which record holds the default, or the schema, that a stored
     reference to a path bound by a call carries.
359. **Z16: the state of a binding of the callee** (PL §8, question 110,
     assumed). The entry of `Binding.state` whose `place` is a slot the call
     bound has `default`, 78 entries in the corpus, and the executor applies it
     when it resolves the path at dispatch: a handler of the callee that reads
     the path through its handle reads `"$"` where the caller's slot is empty,
     and its write lands in the caller's slot.
360. **Z16 against today's runtime.** One of the 22 values of
     `fixtures/callee-default.tsx` differs: `marked.symbol`, the path the callee
     passes on, where the caller's slot is empty. A read of today's runtime
     addressed at the path gives the callee's default, as the executor's does,
     and a read of the whole result gives nothing there, with the result schema
     or with none (scratchpad `cpp/probe26/callee-default-read.test.ts`). The
     comparison reads the whole result. It is the first of the two rows that the
     measurement of ruling Z8 excepts, and today's runtime, not the design.
361. **Z17: the name bound to `[SELF]`** (PL §8, question 108). Value code has
     the name as a reference to the result document (`$rt.self`), and where it
     is placed the executor stores a link to the result, in the pattern's body
     and in an element body over references and over plain values in place
     (`fixtures/self.tsx`). Two things are undetermined. The state entry of a
     binding that captures the name has no `place`, since no slot root and no
     record names the result, and the executor hands the handler nothing for it.
     **Needs a ruling**: what `Binding.state.place` holds for a state path bound
     to the name. And a read of the whole result follows the reference into the
     result again: the executor's read gives nothing at the second level,
     today's read gives the result again at each level, and one value of
     `dev/test/input-self/subjects.tsx` differs for it, as question 108 has.
362. **A defect of the executor behind the 5 values of `person-workbench`**
     (replaces the last part of note 342). A handler whose body has an entry at
     a state path and one at a member below it was handed a record with the
     member, also where the path was bound to a value that is nothing. The
     executor now places nothing for an entry that yields nothing
     (`fixtures/absent-state.tsx`, 12 of 12 values equal to today's), and the 5
     values are equal.
363. **The other differences earlier notes left unexplained.**

     | Module                               | Values | Class                               | Cause                                                                                                                                                                      |
     | ------------------------------------ | -----: | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | `product/primitives/demo/atoms-demo` |     11 | Prototype defect, and note 298      | A handler of a pattern compiled in sorts `rows`, which the call writes as a literal. The crate holds `null` for each constant of it (note 287), and the handler ends early |
     | `product/primitives/demo/atoms-demo` |      4 | Prototype defect                    | What four events that are not handled leave: `step`, `min` and `items` are constants the crate holds as `null`, where the handler expects a handle                         |
     | `system/agent-run/agent-run`         |      4 | The scenario, not verified by a run | The generator gives `run` no value for four required members of type `unknown`, and today's read of `run` under its schema gives nothing                                   |
     | `dev/catalog/catalog`                |      2 | Prototype defect, not verified      | As note 323                                                                                                                                                                |
     | `examples/cfc-spec-gallery`          |      1 | Prototype defect, not verified      | As note 323                                                                                                                                                                |

     With the crate's constants right, the first row would still differ: the
     handler writes through a handle to a constant of the call, which the
     compiled path refuses (note 298), and today's runtime writes the callee's
     argument document. The rows of `agent-run`, `catalog` and
     `cfc-spec-gallery` rest on a reading of the source and of the two values.
364. **The fixtures.**
     `deno run -A --no-check base/pattern-compiler/compare/values-fixtures.ts`
     runs 32 of the 36 fixtures, 39 runs in all, and 489 of 490 compared values
     are equal, where note 342 had 33 runs and 280 values. The added runs are
     `list-records` (84 values), `value-identity` (44), `passes-collection` (2),
     `state-below` (54) and two of `absent-state` (12), and `callee-default` has
     22 values where it had 8. The one value that differs is that of note 360.
     `self` is not compared, beside the three of note 321.
365. **The corpus.** The figures are of `values-corpus.ts again` on the values
     of today's runtime that the run of note 322 read.

     |                                               |  Note 342 |            Now |
     | --------------------------------------------- | --------: | -------------: |
     | Modules run by today's runtime                |       215 |            215 |
     | Executed                                      |       194 |            194 |
     | Every value equal and every event handled     |       167 |     168 or 169 |
     | Values compared                               |     4,735 |          4,735 |
     | Values equal                                  |     4,642 | 4,641 to 4,650 |
     | Values that differ                            |        93 |       85 to 94 |
     | Modules with a difference                     |        24 |       22 or 23 |
     | Committed events the executor does not handle | 15 of 293 |      15 of 293 |
     | Documents the executor stored                 |       535 |            598 |

     The range is `card-piles` alone (note 348): 0, 6 or 9 of its values differ
     from one run to the next. Without it 85 values differ in 22 modules.
     Against note 342: 10 values are equal that differed (`map-demo` 4 and
     `test-cell-equals` 1, note 345; `person-workbench` 5, note 362), and 2
     differ that were equal (`test-handler-capture-key-equals`, note 349). No
     other value changed. The 63 documents more are the 64 documents of a record
     a handler wrote into a list, less one record of a key. Rulings Z13 to Z17
     changed no value of the corpus.
366. **Rules of the task not kept, and what is not verified.** The fixture of
     note 345 was red before the change, and its unit tests were written with
     the change. The tests of ruling Z12 were written after the store and before
     the executor was complete, and they found the defect of note 351. The unit
     tests of ruling Z13 in the executor were written with the change, and the
     test that removes the mark shows what the mark decides. The tests of
     rulings Z14 and Z17 describe what the executor did and changed no code. The
     test of the emitter's `$h.equals` in `tests/emit.rs` was written after the
     code. The counts of evaluations over the corpus differ by a few from those
     of the run of note 342 before any change of this round, which was not
     examined. No fresh run of today's runtime over the corpus was made.

## Rulings Z18 to Z23, a seeded comparison, and instances a function body makes

Notes 367 to 386 are about the owner's rulings Z18 to Z23 of 2026-11-16, about a
seeded `Math.random` in the comparison, and about a pattern instantiated and a
handler bound in a function body. Each note says what the crate and the executor
do, which statement of an earlier note it replaces, and what a ruling leaves
undetermined. A note that ends with **Needs a ruling** names something the owner
has to decide. Every statement about a per-element construct says which case it
is about: an array of references, an array of plain values in place, or the
result of another per-element construct.

367. **Z18: a key that left its collection** (replaces the first request of note
     326 and note 352). The executor did what the ruling has, and no code
     changed: `Instance.#drop` drops the cone instances of the key and their
     memo entries, and the document of a state cell declared under the key
     stays. `fixtures/key-returns.tsx` declares a cell in the body of a `map`
     over the result of a `filter`, once over records that a handler pushed,
     which are references, and once over plain values in place. The tests of "a
     key that left its collection" in `exec/test/executor.test.ts` have five
     cases: a link that leaves an array of references and stands in it again, a
     plain value that leaves an array in place and is written again at another
     position, the last occurrence of two equal plain values, and an upstream
     key that leaves the result of the `filter` and enters it again, over
     references and over plain values in place. In each the cone instances of
     the key are gone while it is away, no document is made or deleted, and the
     key that returns reads what its cell held. Against today's runtime the
     fixture has 72 of 72 values equal, with the keys leaving and entering the
     result of the `filter`. Over plain values in place today's key is the
     position, so a value that returns at another position is the one case where
     today's runtime would read another cell, and the comparison does not have
     it. The executor has no state of an operation that is kept per key and no
     child of an element body, so neither is exercised.
368. **Z18: an event for the stream of a key that is away.** ES §2.6 has "a
     binding of the key has the stream it had" once the key returns. A link to
     that stream can be stored outside the collection while the key is away, and
     an event can be sent through it. The executor finds the element of a stream
     in its element tables alone and refuses the event ("no element holds the
     stream"). The alternative handles it with each slot of root `element`
     reading as nothing over plain values in place (ruling Z12) and as the cell
     over references. This is the same over an array of references, over an
     array of plain values in place, and over the result of another per-element
     construct. **Needs a ruling**: whether an event for the stream of a key
     that left its collection is refused or handled.
369. **Z19: which output keeps its value** (replaces the first open point of
     note 328). `Instance.settle` stores the result with each failed output left
     as it was stored: `Instance.#check` finds the markers at a position no
     listed path covers, `Instance.#holderOf` finds for each the kept entry of
     `Plan.outputs` with the longest path that the position is at or below, with
     `*` for the index of an element, and the stored value at that path is put
     back. `Instance.failures` has one entry per such marker, with the output,
     its path, the binding and the position. The evaluation named is the one
     that stores, whichever cone called `host.stream`: in
     `fixtures/stream-marker.tsx` one cone computes the whole tree, the plan has
     an entry of `Plan.outputs` per path of it, and the entry at
     `$UI/children/0` keeps its value while an event changes `count`, which is
     stored. For a cone of an element body the output that fails is that of the
     row that holds the position, and the rows beside it are stored: the test
     removes the listed path of a binding over references, over plain values in
     place, and over the result of a `filter`, and the rows hold nothing while
     the member written after the spread and the other lists are stored. Two
     things are undetermined.
     - A stream at a member of the result, as `inc` in the same fixture, is at
       no entry of `Plan.outputs`: the crate has an output for a value a cone
       computes and none for a position that holds a stream alone. The executor
       then leaves the position itself as it was. And where the plan has an
       entry per path of a rendered tree, the unit that keeps its stored value
       is as small as the entry nearest the position, so a tree can be stored
       with one subtree of an earlier evaluation in it. **Needs a ruling**: what
       "the output that holds the position" is where the plan has entries at
       several depths above the position, and where it has none.
     - The stored value put back is the one at the same position. Where the
       element moved in the evaluation that fails, the row keeps what another
       key had stored there: a limit of the prototype, which stores a result by
       position.
370. **Z19: the memo.** The executor keeps the memo entry of the cone that
     computed the value, markers included, and records the failure once per
     evaluation. A reader of an interim output of that cone gets the new value
     while the stored result holds the old one, which is what ES §2.2 assumes
     for a derived write that is dropped. Nothing of the corpus run exercises
     it: see note 373 for the one module where an evaluation fails.
371. **Z20: a stream a function body returns** (replaces note 333). `Host.pass`
     hands a marker in the computed argument of a body to the body as a handle
     to the stream, wherever it is in the argument. Before, it handed the record
     `{ $stream: true }`, and a body that returned it had that record stored.
     What the body returns holds the reference, which is stored as the link to
     the stream and checked against nothing. `fixtures/stream-returned.tsx` has
     a `lift` that returns the stream it is handed, for a binding outside every
     element body and for a binding of an element body over references and over
     plain values in place: the stored link has the key of the element in each,
     and no path of `Binding.result` names the position (16 of 16 values equal
     today's). One gap of the plan showed. `body_record` in `src/plan.rs`
     records nothing for a stream bound to a formal of a body (`Place::Stream`),
     so `Body.computed` has no entry that says the position holds a stream,
     where ES §2.2 assumes an `identity` entry. The executor does not need the
     entry. The documents should say which record tells the runtime that a
     position of a body's argument is the stream of a binding. Over the corpus 6
     more stored positions hold a stream at no listed path, 9 where note 342 had
     3, all in `examples/cfc-spec-gallery/main.tsx`: they held the record
     before.
372. **Z21: the form** (replaces the request of note 334). An entry of
     `Binding.result` is `{ path, stars }`, as `ResultPath` of PL §1.1 has it,
     with one entry of `stars` for each `*` of the path. The crate carries the
     kind with each path while it builds the plan (`StreamAt` and `Star` in
     `src/plan.rs`). The `*` of a collection is `element` where the binding has
     an `element` step for it and `every` where it has none (`star_of`). A
     member written after a spread is `member` with the number of entries
     written before it, counted over the members and the spreads of the array
     literal or of the children (`jsx_children` and the array literal in
     `eval`). A stream reached through a member of an element has what its
     source gives: `inside` for a member of an array written in place, and the
     kind of the upstream `*` for the result of another per-element construct,
     which is `element` where the binding has the upstream step
     (`streams_of_elements`). Of the 1,420 listed paths of the 382 corpus
     patterns, 448 have a `*`, and their 476 `*` are 215 `inside`, 207
     `element`, 51 `member` and 3 `every`. In every path with a `*` the number
     of `element` kinds is the number of `element` steps of the binding. The
     kinds are the same whether the collection is over references or over plain
     values in place: the plan does not say which (`tests/plan.rs`,
     `each_star_of_a_result_path_states_what_it_stands_for` and
     `a_star_through_a_member_of_an_element_is_inside_or_element`).
373. **Z21: the check by kind.** The executor has the origin of each position of
     an array it assembled (`Origin` in `exec/executor.ts`): the entry the
     position was written with, whether it is an element of what a spread holds,
     and the key for an element of the result of a `map`, a `filter` or a
     `flatMap`. Value code hands it the entries apart: an array literal with a
     spread is `$rt.list([...])` with each spread as `$rt.spread(value)`, the
     children of a view node are flattened by `$rt.h`, and those of a tag that
     names a pattern by `$rt.children`. `coversPosition` accepts a marker at a
     `*` of kind `element` at the position that holds the key the marker has for
     that step, of kind `every` or `inside` at an element of a collection, and
     of kind `member` at the member written at that entry. A position of an
     array with no origin is covered by no `*`. `fixtures/star-kinds.tsx` has
     each kind, `every` and `element` over references and over plain values in
     place, `inside` over an array of plain values written in place, and
     `element` over the result of another construct. The tests restate one kind
     as another and get the failures the kinds predict, and two collections
     spread into one array of children are told apart by their keys. Over the
     corpus scenarios of note 365 no evaluation fails. With the events that note
     381 has the executor handle for the first time, 3 evaluations of
     `apps/base/contacts.tsx` fail: a promoted `computed` with a block body
     returns a tree that holds the stream of `openInNewView`, value code places
     the marker, and the crate lists no path for the binding. A defect of the
     crate's list, which the check found.
374. **Z21: three places where the kind is not determined or not right.**
     - The result of a `flatMap` whose elements hold the stream of a binding of
       the upstream body. PL has `element` "where the binding has the `element`
       step of the collection whose keys the result has". Under ruling Z22 a
       position of the result has the upstream key together with a member part,
       and every member of one segment holds the stream of the one upstream key.
       The crate states `element`, and the executor would compare the upstream
       key with the composed one and refuse. No pattern of the corpus has the
       case. **Needs a ruling**: what a `*` at the result of a `flatMap` is for
       a binding of the upstream body, over a segment of references and over a
       segment of plain values.
     - The result of a `filter`. The crate records the streams of what a
       callback returns for a `map` alone, so a stream inside an element that a
       `filter` passes on, read downstream, has no listed path. A defect of the
       crate, with no case in the corpus run.
     - An array assembled from entries that is spread into another. The crate
       gives the positions the kind they have in the inner array, so a `member`
       has the `index` it has there, and the executor does the same. The
       documents do not have the case.
375. **Z21: a reader with the plan alone** (replaces the second half of note
     334). `streamAt` in `compare/harness.ts` resolves a listed path from the
     kinds, in the order of the plan, and the two workarounds are gone: it tried
     a path with no `*` first, and it resolved no position where a child
     followed the assembled array. Today's run stores the assembled array of a
     `map` as one child, so there a `member` is at the position its `index`
     gives, and an element is at the position of the array and then at its own.
     `fixtures/star-kinds.tsx` has 49 of 49 values equal with an event for each
     binding but one. Three things showed.
     - Two collections spread into one array. The kind does not say which of the
       two a `*` stands for, as PL §1.1 has under question 78, and the harness
       sends no event for such a binding: one event of the fixture. The
       alternative of PL, an `index` on a `*` that stands for a collection,
       would resolve it. A `member` in an array that is stored flat needs the
       same: the reader adds "the length of each collection spread before it",
       and the path does not name those collections. Under the layout the
       compiled path stores, the children of a view node are such an array.
       **Needs a ruling**: whether a `*` that stands for a collection holds the
       entry it is written at, as `member` does.
     - Kind `inside` does not say which element holds the stream. A reader finds
       it by the link that is stored. The harness does not read which binding a
       stored stream is of, and takes the bindings that list one path to be in
       the order of the elements.
     - A `map` over an array written in place runs when today's pattern is
       built, and today's run holds its elements as children of their own. The
       harness takes the children as the positions for `inside` where no child
       is an assembled array.
376. **Z22: the key of an element of a `flatMap` result** (replaces note 337).
     `Instance.#segment` forms the member part by the rule for any array, with
     the count among the members of the one segment, and the key is the source
     key, `/`, and that part. A segment that is a stored array, which the
     callback passed on, is keyed as a stored array is: a link by the identity
     of its cell, a plain value by its value. A segment the callback wrote is
     keyed by what each member is. `fixtures/flat-keys.tsx` has, over a source
     of references, a segment of plain values and a segment of references that
     the element holds, and over a source of plain values in place a segment of
     plain values that the callback writes in an order an input chooses. Two
     members of one segment that change places evaluate nothing in the body over
     the result, for plain values and for references. Where the callback
     computes the members, the callback is evaluated, once per source element,
     and the body over the result for no member. Equal members of one segment
     are occurrences 0 and 1, an equal member of another segment has another
     key, a plain member whose value changes is another key, and a member that
     is a reference keeps its key when the value of its cell changes. 6 of 6
     values equal today's. The state cell of a body over the result is named by
     the key, so it stays with the member: no fixture declares one there.
377. **Z22: what the executor assumes beside the ruling.**
     - A member that is a plain value in place of a stored array, which the
       callback passed on, is named by that array and its key in it (ruling
       Z12), and the body over the result reads through that reference. PL §1.3
       names the collection of such a reference as "the assembled result". The
       two differ in what a move between two segments is: the executor's
       reference stays with the stored array. The documents should say which
       collection a reference by key to a member of a `flatMap` result names.
     - A segment that is the assembled result of another per-element construct
       has the keys of that result, as PL assumes under question 101
       (`assembledElements` in `exec/executor.ts`). No test has the case.
     - A member the callback computes has no address and is passed on as its
       value. The body over the result reads it from the callback's result at
       the position that holds its key at that time.
378. **Z23: the record of a key of a list** (replaces the request of note 338).
     Nothing changed in what the executor stores: `Instance.keyedElement` names
     a cell by the address of the list and the key, which has no document until
     something writes it. The tests of "the record of a key" show that a write
     through the handle makes no document of the list and evaluates no reader of
     the list before a reference to the record is a member, and that a reader
     that follows the reference is stale on a write to the record afterwards.
     The plan holds no record that names the record of a key: the body of
     `fixtures/keyed.tsx` has a write edge and an envelope with target `handle`
     at `*` below the list, and an entry of `Body.handles` for the list, as
     `footprint-analysis.md` §7 has it. The executor uses the path `*` for its
     count of the writes an edge covers and for nothing else. By the ruling the
     write is "no write at `*` below the list for the label", and the edge at
     `*` is the only edge whose template could label it. The documents should
     say which template labels a write to the record, with question 89 of ES.
379. **A seeded `Math.random`** (replaces the range of note 365).
     `compare/random.ts` installs a `Math.random` before today's runtime freezes
     the intrinsics of the realm, and the harness and the executor's run seed it
     with the index of each event. Today's sandbox calls the host's
     `Math.random` while a handler runs (`sandboxRandom` in
     `runtime/runner/src/builder/safe-builtins.ts`), and the executor runs a
     body in the host realm. No pattern and no runtime code changed. Three
     things had to be kept out of the sequence. The jitter of a retry's delay
     (`computeBackoffDelayMs` in `runtime/runner/src/scheduler/backpressure.ts`)
     calls the function with no receiver, and gets a draw of the realm's own
     generator. The timing statistics of the logger draw inside a handler's run
     once a statistic holds 1,000 samples (`TimingDataStore.record` in
     `base/logger/src/logger.ts`), and cannot be told from the handler: the
     harness empties them before each event (`resetAllTimingStats`). And the
     sequence starts again for each run of a handler, by its frame, since
     today's runtime can run the handler of one event more than once.
     `fixtures/random.tsx` has 18 of 18 values equal. With it
     `showcase/card-piles/main.tsx` has the same values in three runs of today's
     runtime, alone and in one process with 13 other modules, and 9 of its 28
     values differ in every run: the case of note 348, which still needs its
     ruling. `showcase/wordsearch/wordsearch.tsx` draws as well, and its 3
     differences of the earlier runs are gone in a fresh run (note 384). A
     handler that sends to another stream is one run in the executor and two in
     today's runtime, and the two would then draw differently: no module of the
     corpus run shows it.
380. **A pattern instantiated in a function body: the artifact** (replaces the
     first half of note 341). The smallest change that lets an executor find the
     callee is in value code, and the plan is as it was. In the text of a module
     the marker of each `pattern(...)` has, in the place of the pattern's
     function, the identity of the pattern: the entry that the pattern's own
     `Plan.patterns` begins with (`Finished.identities` in `src/emit.rs`;
     `tests/emit.rs`,
     `a_pattern_is_written_with_the_identity_its_plan_begins_with`). An artifact
     holds the text of every module its code imports, so the factory value that
     a body of the caller calls carries the identity of a callee from another
     module. The executor is given the artifacts of the program and finds the
     callee's by that identity (`options.artifacts` of `Instance`): the output
     of `emit --corpus` has one artifact per pattern of every module, and the
     comparison builds the table from it. Two things follow. The output of
     `emit` for one file holds the artifacts of that file alone, so a callee
     from another file is found only in the output for the corpus. And `Child`
     of the crate's plan still has no `callee`, where PL §1.1 has the hash of
     the compiled pattern: the footprint record of a call (`BodyRecord.calls` in
     `src/footprint.rs`) names the kind of the call and not the callee. A
     runtime that takes the callee from the factory value does not need the
     member for a named pattern, and needs nothing else for a factory value
     received as data. The documents should say whether `Child.callee` is what a
     runtime instantiates from, or the factory value.
381. **A pattern instantiated in a function body: the executor.**
     `Instance.instantiate` makes an instance of the callee's plan with
     documents of its own in the same store, each named with a prefix. The body
     gets a handle to the result, and what stores it stores a link to the result
     document. A handle in the argument is stored as a link, so a binding of the
     callee writes the caller's cell. An event is routed to the instance its
     stream is of (`StreamRef.instance`), and a handler that throws leaves no
     instance. `fixtures/instantiate.tsx` has 27 of 27 values equal today's,
     with two instances made by two events. Over the corpus the 6 events that
     failed with "a pattern called in a function body" are handled or fail
     later: 3 now fail at `navigateTo` in the handler, which requests an effect.
     Four limits are the prototype's. The name of an instance is the run that
     made it and the ordinal among all that the run made, where PL §1.3 has the
     site and the ordinal at that site. A run of a `lift` or a `computed` is
     named by the body and its element keys, and a run of a handler by a count
     of the events handled, where PL has the receipt of the handling. An
     instance is never torn down. And an instance that a run names again has its
     argument written whole.
382. **A handler bound in a function body** (replaces the second half of note
     341). `handler(...)` at module scope is, in the executor, a factory that a
     body can call with the state: `Instance.bind` makes a stream with the index
     -1 and a key that names it as an instance is named, and an event for it
     runs the handler with the state the body bound. The stored position holds
     the link, at no listed path (ruling Z20). The fixture binds `bump` twice in
     a `computed`: an event for the second stream writes the cell, the
     `computed` is not evaluated again, and the streams are the ones it bound.
     PL §1.3 identifies such a binding by "the enclosing instance, the handler,
     and what the binding holds, and not the place of the site". The executor
     names it by the run and the ordinal: a limit of the prototype.
     `apps/base/person.tsx` and `apps/base/family-member.tsx` are executed for
     the first time, with 2 of 18 and 2 of 16 values that differ, at a child of
     the tree that today's run holds as nothing. Not examined.
383. **The fixtures.**
     `deno run -A --no-check base/pattern-compiler/compare/values-fixtures.ts`
     runs 37 of the 41 fixtures, 44 runs in all, and 673 of 674 compared values
     are equal, where note 364 had 39 runs and 489 of 490. The added runs are
     `key-returns` (72 values), `stream-returned` (16), `star-kinds` (49),
     `random` (18) and `instantiate` (27), and `flat-keys` has 6 values where it
     had 4. The one value that differs is that of note 360. The run now prints
     the events the harness did not send: one, of `star-kinds` (note 375). One
     event of `handle-passed` is not handled by the executor: its handler
     instantiates a pattern, which the executor now does, and then calls
     `navigateTo`.
384. **The corpus.** Two runs, both of `values-corpus.ts again`. The first is on
     the values of today's runtime that the run of note 322 read, with the line
     of `showcase/card-piles/main.tsx` from a seeded run of today's runtime in
     its place. The second is on a fresh seeded run of today's runtime over all
     272 modules (`values-corpus.ts run`), which sends more events: with the
     kinds the harness resolves the stream of more bindings, most of them
     through a `*` of kind `inside`.

     |                                               |       Note 365 | Saved values | Fresh run |
     | --------------------------------------------- | -------------: | -----------: | --------: |
     | Modules run by today's runtime                |            215 |          215 |       215 |
     | Executed                                      |            194 |          196 |       196 |
     | Every value equal and every event handled     |     168 or 169 |          168 |       169 |
     | Values compared                               |          4,735 |        4,769 |     5,410 |
     | Values equal                                  | 4,641 to 4,650 |        4,680 |     5,324 |
     | Values that differ                            |       85 to 94 |           89 |        86 |
     | Modules with a difference                     |       22 or 23 |           25 |        24 |
     | Committed events the executor does not handle |      15 of 293 |    10 of 295 | 10 of 475 |
     | Evaluations that fail the check of a marker   |              0 |            3 |         3 |
     | Stored stream positions at no listed path     |              3 |           31 |        31 |
     | Documents the executor stored                 |            598 |          615 |       793 |

     Each run gives the same file byte for byte when it is repeated. Before the
     instances of notes 380 to 382, and with rulings Z18 to Z23 applied, the
     first run had the figures of note 365 with `card-piles` at its 9
     differences: 4,641 of 4,735 values, 94 that differ in 23 modules, 168
     modules fully equal, 15 of 293 events, 598 documents. No value that was
     equal differs for a ruling. Against that, in the first run:
     `apps/base/contacts.tsx` has 17 differences where it had 26, with its 4
     events handled; `person.tsx` and `family-member.tsx` are executed, with 2
     differences each (note 382), which is the 2 modules more with a difference;
     `dev/self-reference-test` has its event handled and its 2 differences
     still; and 3 events fail at `navigateTo`. The stored stream positions at no
     listed path are 9 of ruling Z20 (note 371) and 22 in `person.tsx`,
     `family-member.tsx`, `contacts.tsx` and `dev/self-reference-test`: the
     streams of bindings a function body made, and those of bindings of an
     instance a function body made, which the count reads against the plan of
     the instance it started with. The 17 documents more are 5 argument and 5
     result documents, of the 2 modules and of 3 instances, and 7 cells and
     records of theirs. In the fresh run `wordsearch.tsx` has no difference
     where it had 3, which is the seed, and 7 modules send more events than
     before, 180 more committed in all, with every value of theirs equal.
385. **What was not done.** The crate's `null` constants for the literal
     arguments of a call of a pattern compiled in (note 287, `atoms-demo`), and
     the other categories of modules that are not executed, were not started.
     The 19 modules not executed are 6 whose value code throws, 4 at an output
     that no value function computes, 5 at a debug string, and one each at
     `linksOf`, at a spread in the argument of a pattern compiled in, at value
     code that does not parse, and at a name value code does not bind.
386. **Rules of the task not kept, and what is not verified.** The tests of
     rulings Z18 and Z23 describe what the executor did and changed no code. The
     tests of rulings Z19, Z20, Z21 and Z22, of the seed, and of the executor's
     part of notes 381 and 382 were written and seen to fail before the code.
     The test of the emitter's pattern identity in `tests/emit.rs` was written
     in the same step as the code. The fresh run of today's runtime was made
     once, with the crate and the executor as they were before notes 380 to 382,
     and `again` compares the current ones with it: that today's values are the
     same in a second fresh run is shown for `card-piles` and the 13 other
     modules of `showcase/` alone. The differences of `person.tsx` and
     `family-member.tsx` are not examined. The classes of note 374 rest on a
     reading of the crate and have no fixture. The comparison's scripts are run
     with `--no-check`: `values-corpus.ts` does not pass the type check, at a
     call that gives a pattern of the corpus where an `Artifact` is declared.
     The call was written so before this round, and that it failed the check
     then was not run.
