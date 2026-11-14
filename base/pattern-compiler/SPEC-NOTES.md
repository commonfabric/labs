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
    §7.6.1). The document says both follow the schema mapping and gives no
    rule of its own. Chosen: `T | Default<V>` has the value type `T`, the
    member is dropped when the type is resolved, and the union keeps the
    default annotation, which is what §7.6.1 asks about. `DeepDefault<V>`
    is an opaque named type here and does not count as declaring a default;
    the corpus does not use it.
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
19. **`cfc-label:conflict`** (§8.4, §10.5). The entry names "a key other than
    `confidentiality`". Chosen: every annotation key the crate keeps, the
    default and the scope included, and `addIntegrity` although its name says it
    adds. Two annotations are compared where they are written around one type
    node, and not where an intersection brings them to one property.
20. **`cfc-policy-of` and `cfc-policy-authoring`** (§10.5). The catalog says "as
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
27. **Built-ins whose result the crate types.** `wish`, `fetchJson`,
    `fetchJsonUnchecked`, and `generateObject` have the result
    `{ pending: boolean; result: T | undefined }` with `T` the written type
    argument, and `generateText` and `fetchText` the same with `string`. The
    declarations in `base/api/index.ts` have more fields. The crate does not
    read them, so any other field of such a result has a type that is not
    evaluated. The other effectful built-ins have no signature here.
29. **Iterators of `Map` and `Set`** (§9.9). `keys()`, `values()`, and
    `entries()` are given array types, which is enough for spread, `for...of`,
    and `Array.from`, and wrong for a method called on the iterator itself.

## Assignability (§7.5, §7.5.1, §7.5.2)

49. **API types the crate does not read** (§7.2). `VNode` is opaque, and
    `JSONValue` and `JSONSchema` are structural, as the document states. Every
    other type `commonfabric` exports that is not a constructor of §7.2, such
    as a built-in's parameter type, is an ordinary object type whose
    declaration the crate does not read. Chosen: nothing is decided against
    one.
50. **Where the expected type is carried** (§7.5, §7.3). The crate carries
    the expected type into the callback of `map` and `flatMap`, into a
    `computed`, into a function written where a function type is expected,
    and into the one callback of an authored generic function whose result
    type is a type parameter `U` or `U[]` and whose callback is declared to
    return `U`. For any other form of result type, such as `Box<U>` or a
    union, the expected type is not carried, and the call is typed from its
    arguments alone.

## Narrowing and data positions (§7.6, §7.8)

52. **Narrowing** (§7.6). Implemented for every test the section lists. The
    type of a `let` at a reference is a join that is computed, and it is
    over-approximated: it is taken over every assignment written between
    the last assignment that definitely runs before the reference and the
    reference itself, whether or not each of them can reach it. A binding assigned in another function
    than the one that reads it is not narrowed. Three cases narrow less than
    TypeScript does: the `default` case of a `switch`, a case another case can
    fall into, and a path such as `order.note` of a binding that is assigned.
    One case narrows more than it should: a path stays narrowed after an
    assignment to that path. A type that a condition would narrow to `never`
    is left as it was. An optional chain that is truthy, is compared with a
    value that is never absent, or is not `undefined`, narrows each receiver
    it tests and the path it reads.
54. **Which expressions are data positions** (§7.8). As the section lists
    them. One reading was chosen: a `const` whose initializer is an
    operator or a call other than `get()` and `sample()` is an ordinary
    value, as the section says of the expression itself.
55. **The type names of the browser** (§7.10). The list is the interface
    and type-alias names of `lib.dom.d.ts` of TypeScript 6.0.3, the
    version the repository pins (`src/dom-names.txt`, 1,795 names). The
    document does not say which version of the library, and the names of
    `lib.webworker.d.ts` and of the other libraries are not in the list.
56. **The parts of §7 the crate does not apply.** Assignability is applied at
    an argument, an attribute of a tag that names a pattern, a returned value,
    and an initializer, and not at an assignment, a property of an object
    literal outside those sites, or an argument of a handle method such as
    `set`, `push`, or `send`. `e as T` is not tested for relatedness unless it
    goes through `unknown`, and `e satisfies T` is not checked (§7.7). A
    generic function is not checked per instantiation; a property read on a
    type parameter reads its constraint (§7.3). The predicate of
    `isWellFormedDID` is the one built-in predicate the crate knows.

## The second round of corrections (the document at `8bc4a3001a`)

57. **A default on a type that names `undefined`** (§7.6.1). The table
    gives the read "the value type, without `undefined`", and
    `RequireDefaults` in the published typings removes `undefined` from
    the property's type. Chosen: the crate removes the `undefined` that
    the `?` adds and keeps one the type itself names, so
    `glaze?: Default<string | undefined, "plain">` is read as
    `string | undefined`.
58. **Which input types the rule of §7.6.1 reaches.** The rule is stated
    for "the properties of the input type of a `pattern`". Chosen: it is
    applied where the input type resolves to one object type, an
    intersection included, and not where it is a union of object types or
    is not evaluated.
59. **A value where `AnyCell` is declared, bound by reference** (§7.5.2).
    The second row of the table lists the six cell kinds a value stands
    for, and `AnyCell` is not one of them. §7.2 calls it "a handle of a
    kind the type does not state". Chosen: a value is refused where an
    `AnyCell` is declared, in tier R too.
61. **`key` on an optional property that is not a handle** (§4.7). "A `?`
    on the property does not change the result" is written after the
    flattening rule and reads as general. Chosen: `key("a")` on a
    `Cell<{ a?: Cell<T> }>` is the `Cell<T>`, and on a
    `Cell<{ a?: string }>` it stays a `Cell<string | undefined>`, because
    a `Cell<string>` there would let `get()` return a `string` where
    nothing is stored (question 12).
62. **`"k" in x` on a union with `object`** (§7.6). The section gives the
    rule for a union of object types and for `object` alone. Chosen: in
    `object | null`, which `typeof x === "object"` gives, the true branch
    drops `null` and adds the property to `object`. On a data position
    typed with an object type that does not declare `k`, nothing is added,
    as on one typed `unknown` or `object`.
63. **An attribute of a pattern tag in a function body** (§7.5.3). The
    section names "a pattern instantiated in a function body". Chosen: a
    JSX tag that names a pattern there is one, and its attributes are
    checked as the argument is.

## Footprint analysis (`footprint-analysis.md`, cited as FA)

64. **What of FA the crate implements.** The abstract values of §2.1, the
    classes `value`, `shape`, `enumeration`, and `identity` of §2.2, the
    normal form of §2.3, the transfer rules of §3.1 to §3.3 and §3.5 to
    §3.8, the array, object, `JSON`, `Map`, `Set`, and `console` rows of
    §3.4, the causes W1 to W5 of §5.2, the reads and the writes through
    handles of §6.1, §6.2, §7.1, and §7.2, and the read envelope of §7.3
    as the entries below a dynamic hop. Notes 76 to 85 say what of §6.3 to §6.6, §7.1
    ("Resolutions"), §8, `Body.outputs`, and W6 is implemented. Not
    implemented: `Body.computed` (note 85), the templates of written
    values (§6.5), the `identity` entries that accompany a `value` entry,
    and the `sampled` mark of §2.3.
65. **A summary is applied by evaluating the callee again** (FA §3.6). FA
    computes one summary per function and applies it at each call. The
    crate evaluates the callee's body at each call with the arguments'
    abstract values bound, which gives the same record where the callee
    does not call itself. A function that is being evaluated, and a call
    nested more than eight deep, is not followed: each argument that is a
    projection is read in full, and the site is counted as W7. FA's fixed
    point over a group of recursive functions is not computed. W6 is
    implemented as note 79 has it.
66. **Control flow** (FA §3.7). The environment is not joined on the
    control-flow graph. An assignment under a condition joins the old and
    the new value of the binding, a loop body is evaluated twice, and a
    `break` or a `continue` changes nothing. A `let` captured by a closure
    holds what was assigned before the closure is evaluated, and not the
    join over the body.
67. **An index into an array that is a literal** (FA §3.1). The first row
    of the table extends the path by a static key, `v[0]` included, and
    the third row gives `v[i]` on an array the path `v/*`. Chosen: an
    index into an array type is `v/*` with `enumeration` at `v` whatever
    the index is, and a literal index extends the path on a tuple type
    alone.
68. **The `identity` entries that accompany a `value` entry** (FA §2.2) are
    not emitted. A `value` entry over a container stands for its subtree,
    and the positions of handle, reference, and factory type inside it
    have no entry of their own.
69. **A test the type decides** (FA §2.2). FA states the rule for
    `typeof name` and for `donut?.glaze`. Chosen: a test of presence is
    decided where the type admits neither `null` nor `undefined`; a kind
    test where the type is of one kind, admits neither, and is not
    `unknown`; a test of truthiness of a container, a handle, or a
    reference under the same condition. A test of truthiness of a scalar
    is never decided.
70. **A truthiness test of a union** (FA §2.2, §2.3). "A test of truthiness
    on `string | Donut` records `value` and `shape`", and the normal form
    of §2.3 removes a `shape` entry at the path of a `value` entry. So the
    record of such a body has `value` alone at the path, which by §2.2
    covers the subtree of the `Donut`. FA does not say whether that is
    meant, or whether the `value` of a union position is the value of its
    scalar members alone.
71. **A member of a built value that leaves the body** (FA §3.8). The table
    decides by the member's type. A member the body put into a record
    earlier has no expression at the place where the record leaves.
    Chosen: an object literal written at that place is taken apart member
    by member, and any other built value records `identity` at each
    projection it holds, unless the body has a `value` entry there.
72. **An expression that has no type** (FA §1.3). FA takes every
    expression as typed. Where the checker has none, the crate takes the
    position as a scalar, records `value`, and counts the observation
    (`footprint:observations of an expression with no type`, 604 in the
    corpus). A receiver with no type is taken as a handle where the call is
    one only a handle has: `get()`, `sample()`, `resolveAsCell()`,
    `key(k)`, `set(v)` with one argument, and five more writers.
73. **The rest of an object** (FA §3.1). `const { a, ...rest } = v` binds
    `rest` to a record that holds a spread of `v`, so `rest.a` reads `v.a`
    where the document gives a record without `a`. The type checker
    refuses such a read, so the difference shows in no accepted program.
74. **Which bodies** (FA §1.2). A function nested in a body is part of the
    body where it is a closure, and is a body of its own where the front
    end records one: an inline event handler, an `action`, a `computed`.
    The measurement counts a site once, for the innermost body around it.
    A `computed` is a body where the typed promotion criterion does not
    promote it, which FA §11 decides by syntax.
75. **The declared type of an argument bound by reference** (LS §7.5.2,
    ruling "An argument bound by reference takes the declared type of its
    path"). The crate takes the declared type at the outermost step of the
    path alone: for `order.note.text` it reads the declared type of `text`
    in the type the checker has for `order.note`, which a condition on
    `order` or on `order.note` may have narrowed.

## The rest of footprint analysis (FA §6.3 to §6.6, §7.1, §8)

76. **The `cause` entries** (FA §8.4). §12.3 lists `cause principal :
    value` and no document names the entry `eventKey()` records. Chosen:
    `cause.principal` and `cause.eventKey`, each of class `value`.
77. **A static resolution** (FA §7.1). The relaxation for "a call that is
    conditional only on the operand being present" is applied where the
    test is the optional chain of the call itself, `p?.resolveAsCell()`,
    and not where an `if` around the call tests the operand. A use of the
    handle a static resolution returned records the resolved entry and no
    plain one beside it, as §12.3 lists `state.myProfile`.
    `writtenPrincipalOf`, which the table of §8.4 does not list, is
    recorded as `principalOf` is.
78. **A dynamic read of kind `space` or `link` is listed by its entries**
    and not as a record of the plan. The crate lists, per resolution that
    is journaled, the entries it starts from, and one line
    `labelMetadata` where any observation of label metadata is journaled.
79. **W6 follows the checker's cut** (FA §5.2). The checker's type of a
    recursive type is cut at the first use of the type inside itself. The
    analysis widens at a property read on a value whose type is the cut,
    reached through a value whose type is the cut: the second time the
    path enters the type. The widened entry is at the path with its
    trailing `*` removed, as the example of §5.2 has it
    (`box/children/*/children`). A destructuring and an element access
    with a key are not counted as entering the type.
80. **`Body.outputs`** (FA §3.8). A projection at a result path is a
    reference where the record has an `identity` entry at it, as note 71
    decides it for a member with no expression. A bag the body built gives
    `path/* : oneOf` and its entries. `required` is not recorded, and an
    entry is named by its path, since the `{ computed }` form needs the
    use (note 85). A handle a static resolution returned is named by its
    path, and not told apart from the plain entry.
81. **An authored function has no tier** (FA §6.3, §8). FA holds an
    authored function to the rules of the bodies that call it, and the
    crate does not know which tier calls one. Chosen: its own record has
    no tier, no shape of §6.6, and no `read-then-push`. A write in it
    whose target is not static does make a computation that calls it a
    materializer, and the hint is then reported at no site, because the
    site is outside the computation's text.
82. **`mergeable-push:read-then-push`** (LS §10.3). The condition is "a
    handler reads a mergeable collection and then pushes to it". Chosen: a
    `push`, `pushAll`, or `addUnique` in a `handler`, an `action`, or an
    inline event handler, through a handle whose cell the body read with
    `get()` or `sample()` earlier in the order of evaluation, at the path
    pushed to, above it, or below it. Whether the pushed value depends on
    the read is not decided.
83. **Which runtime calls are sites** (FA §8). Recorded: a call of a
    pattern or of a handler the module resolves by name, `.for(tag)` on
    such an instantiation, `X.of(value)` and `X.for(cause)` with the three
    scopes, `action(...)`, and the effect built-ins. Not recorded: a call
    of a factory value held in an input, an inline event handler in JSX
    the body builds, `new X(value)`, `inSpace` and `asScope`, the schema
    and scope of a created cell, the `{ call }` entry of `Body.handles`
    for a read through what a site returned, and the write edges of an
    argument or a request. A binding copies by the handler's footprint in
    FA §8.5; the crate applies the reference rule of §3.8 to the state
    whatever the handler reads of it.
84. **A constant cause** (FA §8.2) is a literal, a template with no
    substitution, or a name whose value comes from no input and is not
    computed in the body. The element of an enclosing element body is not
    recognized as the element key, so a cell created under it counts as
    created under data.
85. **`Body.computed` was not implemented** when this note was written;
    note 86 has what is. (FA §1.1). The record is per
    body. The split of the entries into `reads` and `computed` needs, for
    each use, what each formal input is bound to, which
    `origin_of_place` in `assign.rs` classifies for an argument of tier R
    and no pass yet joins with the record. Until then every entry is
    listed under `reads`, and the rules that journal a read, a
    resolution, or an observation "whatever the conditions say" for a
    computed input are not applied.

## Completing the record, and the first slice of plan emission

86. **`Body.computed`** (FA §1.1, §7.2, §8.4). `bind_use` gives the record
    of one use: the entries on an input bound to a value the instance
    computed are entries of `computed`, a read through a handle from such
    an input moves into the envelope of a handle entry that names the
    handle's `identity` entry of `computed`, a resolved entry becomes a
    plain one with a dynamic read of kind `link`, and an observation of
    label metadata is journaled. What an input is bound to is decided by
    the plan emitter, which follows a place to its root and path.
    `origin_of_place` in `assign.rs` names the kind of a place and not its
    path, so the emitter does not use it. A record written in the reactive
    tier binds each member on its own: an entry below a member that is a
    slot is a slot. FA does not say this.
87. **`Body.handles`** (FA §7.2, PL §3.9). A handle found below a hop whose
    read is dynamic has no entry of its own. It is counted under the
    listed handle it was found through, and where the analysis has no such
    handle, under the position before the first hop. A read through what a
    site returned is `get()`, `sample()`, or a property read, and the site
    is an entry where it is `instantiate` by tag, `instantiate` in a body
    that is evaluated again, or `createCell` under a cause.
88. **Write edges** (FA §6.5). `push`, `pushAll` and `addUnique` write at
    `*` below the cell. PL §6.2 lists `w0`, a `push`, at `*`, and `w4`, an
    `addUnique`, with no path; the crate gives both `*`. FA does not say
    what a path holds where the written record is one of several the body
    built, or has a record spread into it on some runs. Chosen: the path
    is an edge that names the references of all alternatives as `oneOf`,
    since the runtime verifies a reference by identity. `new X(value)` on
    a cell constructor is a `createCell` site by order, which note 83 said
    was not recorded, and PL §6.2 lists it as `n0`.
89. **What a copy holds** (FA §8.5). The crate analyzes the bound handler
    at the bind site. A member of a record written at the site is a scalar
    by its type. A value an `action` or an inline handler captures has no
    expression at the site, and is taken as a scalar where the handler has
    a `value` or `shape` entry at its root and none below. A handler
    received as a factory value is not handled. The `Binding` of a `bind`
    site of a body is not filled in, and the plan lists such a site as
    unsupported.
90. **What the first slice of the plan leaves out** (PL §1.1). Every
    member that holds a `Template`, a `Hash`, or a `Constraint`, and so
    `Slot.schema`, `Body.code`, `HandleReads.envelope`, `Child.callee` and
    its schemas, `Cone.code`, `Collection.membership`, `Operation.input`;
    and `Slot.declared`, `Slot.sampled`, `BodyOutput.required`,
    `Output.scope`, `Operation.scope`, the records of `Body.widenings`,
    `Collection.bodyUses.child`, and `Plan.closures`. `constraints` is
    empty everywhere. `Binding.state` has a member `bound` that PL does
    not define, in the place of `template`: the slot, the output, the
    binding whose stream it is, or that it is a constant.
91. **Cones** (PL §1.4). PL leaves the partition to the compiler. Chosen:
    one cone for each declaration of the reactive tier that computes, with
    everything nested in its expression; one for a JSX tree; one for the
    body of an element construct; and one named `result` for the inputs
    the result passes through. `Cone.entry` is the name of the
    declaration. A slot that expression code reads is of class `value`
    where an operator, a condition, or a method of a scalar consumes it,
    and `identity` where it is passed on. PL decides the class by the
    template, which this slice does not build. PL §6.2 says the listing
    leaves out one `shape` slot at a data position, `event target`. The
    crate has a second, `event attachments`.
92. **Names** (PL §1.3). PL does not give the form of a name with its
    ordinal. Chosen: `name#1`, `name#2`. The key `[UI]` of a result is the
    segment `$UI`. A value assigned to no `const` takes the name of the
    property or the attribute it is written at. A child or a state cell a
    body creates is named by the body's name and the number of the site.
    `ComputedInput.at` starts with the name of the formal input for a
    function and for what a `computed` captures, and not for a `lift`,
    whose argument is its one parameter.
93. **`Slot.inPlace`** (PL §1.1). The member is for a `shape` slot at a
    position of handle or reference type. The crate sets it where the same
    body has an `identity` entry at the same path, and does not ask the
    type.
94. **`side-write:cycle`** (LS §10.3, FA §6.3). An edge of a static
    side-write goes to each cone with a slot of the same root whose path
    overlaps the written path and that is not the `identity` slot of the
    handle itself. For a handle that is a state cell the edge is of kind
    `state`, and the write target stays of kind `handle`, since the body
    names it by a slot. The warning is reported at the function of the
    writing body, for each side-write whose target cone reaches its own
    cone. An edge from a cone to itself is in the plan and is not
    reported. A write through a handle from a computed input has no edge
    (FA §6.3), and a handler is no cone.
95. **A pattern called in the reactive tier** (PL §1.1, §1.3) is compiled
    into the plan under a `site` step, at most eight deep. Its argument is
    bound place by place, so a slot of the callee is a slot of the caller.
96. **A dynamic key in the reactive tier** (PL §3.18) is an entry of
    `Plan.picks` with `chosenBy: "valueCode"`, and for a container that is
    a slot the cone has a `value` slot at `*` below it.
97. **What the emitter does not translate** is listed per plan by kind,
    and `plan --corpus` counts it: `wish`, the context reads and the
    remaining built-ins in the reactive tier, a collection method with a
    callback other than `map`, `filter`, and `flatMap`, an element
    construct over a constant, a spread in the reactive tier, a dynamic
    read of kind `space`, and a call of a name it does not resolve.

## Bringing the crate in line with the documents, and more of the plan

98. **What a called function brings into a body** (FA §3.6, "A summary
    has no tier"). The crate reports a dynamic read, a widening, a write
    with no static target, a write that is not idempotent, and a read and
    a push at the call in the body's text, with the position inside the
    function in the message. "The call" is the innermost call written in
    the body's text whose evaluation reached the site, so for `f(g(x))`
    what `g` does is reported at `g(x)`. One call is reported once per
    diagnostic, whatever the number of sites behind it. FA does not say
    whether the function's own record still reports a widening or a
    dynamic read at the site inside it; the crate reports both, so a
    widening in a helper is a hint at the helper and at each call.
99. **A bag whose member joins a `Computed` value with projections** (FA
    §3.8) cannot be told from a bag of the projections alone, because the
    join of abstract values drops `Computed`. Such a bag gets an entry.
    A bag of one projection whose path has no `*` gives `passes`.
100. **A constant cause** (FA §8.2). The conditional operator counts as
    an operator over constants, and so does a logical one. A module-scope
    `const` whose initializer is a call, a member access, or an object is
    not constant, and neither is a name a destructuring binds. This
    replaces note 84.
101. **W6 and a destructuring with no type** (FA §5.2). A destructuring
    in a declaration or in a `for...of` has the type of its initializer.
    A destructuring in a parameter list has none, and counts as entering
    a recursive type only where the value was reached through one
    already. This replaces the last sentence of note 79.
102. **`mergeable-push:read-then-push`** follows LS §10.3 and question
    36 as assumed: `push` and `pushAll`, any earlier read of the list.
    This replaces note 82.
103. **The catalog table** (LS §10). §10 now has a second table whose
    rows start with an identifier, "What a diagnostic is computed from".
    The catalog test takes a row as a catalog entry only where its
    second cell is a severity or `—`.
104. **PL §6.2 against the crate, `B1` to `B4`.** Four differences. (a)
    `B1` reads `threadInfo?.get()`, which FA §7.1 makes static, so the
    crate has the slot `threadInfo : value` and no handle, where the
    listing has `handles h0 slot s2`. (b) `B2` has `titles/* : identity`
    where the listing has `value`, by note 71: the title leaves in a
    record a helper built, which has no expression to take a type from.
    (c) `B4` lists `identity` beside `identity, resolved`. (d) The source
    calls `threadTitles`, `bodyText` and `viewKeyOf` more than once, so
    their uses have ordinals.
105. **A pattern used as a JSX tag** (PL §1.1, §6.2). The listing has
    the row's slots at the root `element`, so the row is compiled into
    the room. The crate compiles in a pattern that is called, and gives
    a pattern used as a tag a plan of its own, with its attributes passed
    by reference. No document says that a tag is a call for this purpose.
106. **`wish` is not planned** (PL §3.19, BI "`wish`"). PL gives the
    templates of four parts and says a constant query tells them apart.
    Three things are missing for a record. No document has the table from
    a query to its part (`#profile`, `#now`, `#now/300`, a path). A path
    or a well-known target is "a reference", and `SlotRoot` has no root
    for it; a read through it in the reactive tier would be a `dynamic`
    node of kind `link`, whose `through` is a slot or an entry of a
    body's `computed`, and expression code is neither. A search is a
    `DynamicReads` of kind `search`, which names a body.
107. **A scan** (PL §3.13, §1.1). PL gives the templates of `some`,
    `every`, `findIndex` and `find` and not their records. Chosen: a
    `Collection` of its own, named as the construct is, whose source is
    the receiver (a slot, or an output, the assembled output for a
    receiver that is a collection, because `via` has no value for a
    scan); the predicate as the cone of its body, whose result is read
    for `value`; a `Selector` of arity 0 for the `through`; for `find` a
    `Pick` with `chosenBy: "runtime"`; and an `Output` with the member
    `collection`, as for an assembled result, since the runtime produces
    the value. The selector and the pick are in no `Cone.selectors` or
    `Cone.picks`, because no value function reports them. PL does not say
    which cone lists them. `reduce` stays unsupported: PL makes it an
    `Operation` of kind `reduce`, and `Operation.implementation` has no
    form for an expression.
108. **An array written in the reactive tier as the source of a
    collection** (PL §1.1, `Collection.source`). `[a, b].map(...)` and
    `["x", "y"].map(...)` have no slot. Chosen: the array is "an array
    the instance computed", made by a cone of its own that passes each
    member by reference, and the source is its output. For an array of
    constants that cone has no slot. A collection over a path of a
    computed value, as `facts.main`, has an interim output at that path
    beside the output of the whole value.
109. **Context reads and library calls in the reactive tier** (PL
    §3.16). `spaceOf`, `equals`, `principalOf`, `principalsOf`,
    `profileOwnerOf`, `spaceAccess`, `spaceAccessOf`, `spaceMembers`,
    `spaceDeleted`, and `linksOf` have the slots of the table, in a cone
    of expression code. `a.equals(b)`, `X.equals(a, b)` and `equalLinks`
    are the method forms (LS §4.7). A dynamic read of kind `space` whose
    operand is a value the instance computed is unsupported in the
    reactive tier: `of` would name an entry of a body's `computed`, and
    there is no body. The debug strings and a call of a global function
    such as `String` are expression code that reads each operand for
    `value`. `writtenPrincipalOf` and `resultOwnerOf` in the reactive
    tier stay unsupported.
110. **A pattern that is a default export** has no name in its module.
    Compiled in, its site takes the name of the `const` the call is
    assigned to, as any call does (PL §1.3). The offsets of the
    unsupported constructs of a pattern compiled in from another module
    are offsets in that module, and the plan lists them without the
    module.
