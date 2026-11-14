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
111. **The `Binding` of a `bind` site of a body** (PL §1.1, FA §8.5) is
    filled in: the handler is a body of the plan, and each path of its
    state is `copy` or `link`, with the reference a linked path holds
    where the binding body was given it. This replaces the last two
    sentences of note 89. A path the body copies from a value it
    computed has no `template` yet. A handle or a link the body made at
    a site is `link` with no `reference`, because `reference` names only
    what the body was given. A binding of a handler received as a
    factory value is still unsupported.
112. **The first templates** (PL §1.1 `Template`, §3.3, §3.9, §3.19).
    Built: `const`; `slot`; `derive` by expression code for a binary or
    unary operator and a template literal, over the templates of its
    operands in source order; `derive` by a body, over the slots of
    `Body.reads`, the templates of its computed inputs, each once, and a
    `dynamic` node for each entry of `Plan.dynamicReads` the use made,
    as `T_send` lists them; and the template of a promoted `computed`
    whose body is one expression, which is that expression's. A path of
    a value has the value's template (§3.3, for one opaque call). They
    are on `Output.template` and `ComputedInput.template`, and are left
    out where an operand has none: a `select`, a `pick`, a `fold`, a
    collection, a method call, JSX, and a record written in place are
    not built. A constant operand is one `const` node each time it is
    written; PL does not say whether inputs are a set. `WriteEdge.template`,
    `Operation.input`, `Collection.membership`, and
    `Binding.state.template` are not filled in.

## The crate against PL as corrected from notes 86 to 97

113. **Whose names are counted together** (PL §1.3). "Two bindings of a
    handler `save` are `save#1` and `save#2`", and the handler is a body
    named `save` too. Chosen: the names of `Plan.bodies` are counted
    apart from the names of the other records, so a handler is not one
    more declaration of the name its bindings have. PL lists `Body`
    among the records that hold a name and does not say this. A hint
    that is the property or the JSX attribute an expression is written
    at is the fallback only: a call of a pattern, a use of a body, a
    collection, an effect, and a binding of a named handler take their
    base name before it. A state cell has no base name in PL's list, and
    takes the property's name. A child or a state cell that a site of a
    body makes is named after the ordinals are given, so it is
    `make#1/n0`. A state cell a body creates under a constant cause is
    still named `body/nK` and not `body/cause`: the footprint record
    does not keep the cause.
114. **PL §6.2 as corrected, against the crate.** This replaces note
    104. The listing and the crate agree on the slots `e0` to `e8` and
    `b0` to `b4`, the handles of `B0`, `n0`, the writes `w0` to `w7`,
    the envelope, the binding, `m4` in place, and that the result of
    `B1` and the conditions of `T_edited` and `T_label` are no outputs.
    What differs: (a) `B1` reads `threadInfo?.get()`, which FA §7.1
    makes static, so the crate has `threadInfo : value` and no handle,
    where the listing has `handles h0 slot s2`, and `T_titles` has no
    `dynamic` node. (b) `B2` has `messages : value` and
    `messages/* : identity` beside `s0`, and its computed input is
    `titles/* : identity` with `titles : enumeration`, where the listing
    has `titles/* : value` (notes 71, 104). (c) `B4` lists the plain
    `identity` slot beside `identity, resolved`. (d) `threadTitles`,
    `bodyText` and `viewKeyOf` are used more than once, so their uses
    have ordinals. (e) The row is a pattern used as a JSX tag, which the
    crate does not compile in (note 105), so `m0` to `m6` have the root
    `argument` and the path `message` in a plan of the row's own, `m1`
    is absent, `c1` has no body in the room's plan, and `facts.places`
    is no output of the room. (f) The source declares the row's key
    inside the `computed` of `replies`, so the crate has no cone `key`:
    `B4` and the pick are in the cone `replies`. (g) The crate has three
    more `shape` slots in place than the listing names "among them":
    `binding threadInfo`, `event attachments/*`. (h) `isEdited` reads
    `editedAt` and `body` for `value` where the listing has `m5` and
    `m3` for `shape`, until expression code takes its class from the
    kind of test.
115. **`Slot.inPlace` by type** (PL §1.1, §2.5). This replaces note 93.
    A position is of handle type or of reference type where the body
    uses a handle there, or where a test of truthiness, of presence, or
    of kind is made on an expression whose static type is a handle or
    `unknown` and no container or scalar. A `shape` entry from a
    destructuring default, a spread, `in`, or `Object.hasOwn` has no
    expression of the position, and is in place only by the first rule.
116. **Which slots read a `handle` target** (PL §3.11). This replaces
    the rule of note 94. `Slot.schema` is not emitted, so the type a
    `value` slot above the handle has at the handle's position is the
    declared type of the reading body's formal input there. Expression
    code, a `computed` that is a body, and a parameter that is a
    destructuring give no type, and the slot then counts as a reader. A
    position of type `unknown` stops the read, as a handle type does.
    Of the `identity` slots at the handle's own position the plain one
    and the one the target names are excepted, and a resolved one the
    target does not name is not. "No slot is excepted" for a state
    target is taken literally, so the cone that writes a state cell has
    an edge to itself through its own `identity` slot of the cell, and
    is reported unless the body reads its own target. The corpus has 9
    reports of `side-write:cycle` where it had none, 2 of them in
    accepted modules, and the plans of the accepted modules have 41
    edges through a side-write (20 before). Most of the 9 are an edge
    from a cone to itself through a state cell or a handle that the
    body writes and does not read.
117. **`side-write:cycle` names the side-write** where the write is in
    the module of the pattern, and the function where it is in another
    module. One site is reported once, whatever the number of cones it
    is on a cycle with. An authored function used in the reactive tier
    has no tier of its own (FA §6.3): it counts as a computation with
    static side-writes where each of its writes has a static target,
    and whether a write reads its own target is recorded for it too.
118. **`Binding.state.place`** (PL §1.1). A path of a value the instance
    computed resolves to an interim output at that path. A constant is
    held as its value where it is a literal written at the binding, and
    as `null` where it is a name of a constant or `undefined`, which the
    emitter does not evaluate. The stream of another binding has the
    template `const`: PL gives the template for a slot, an output, and a
    constant, and the stream of a binding of the reactive tier is named
    by constants of the plan (§3.14). A path bound to the index of an
    element has neither `place` nor `template`: PL has no place for it.
119. **The cones of an element body** (PL §1.4, question 44). PL states
    the partition "the prototype emits" as one cone for each declaration
    in the callback that computes and one for the returned expression.
    The crate emits one cone for the whole callback (note 91), and a
    declaration inside a promoted `computed` with a statement body is in
    the cone of that `computed`. Not changed in this slice.

## Label templates, second slice

120. **The class expression code reads a slot for** (PL §3.5, §6.2).
    This adds to note 91. A condition is read for `value` where its
    static type is a scalar and for `shape` where it is a record, an
    array, a handle, or `unknown`. A test against `undefined` or `null`
    reads the other operand for `shape`, and so does `typeof`, as the
    listing's `m5` and `m3` are. `a?.b` reads `a` for `shape`, and that
    observation joins the template of the expression code around it, as
    `m0` joins `T_isSet`. PL states the class of a condition and not of
    these three.
121. **`select`** (PL §3.5). `??` tests presence, so its condition is
    read for `shape`. The branch that is the condition is the same
    operand read for `identity`. `ifElse`, `when`, and `unless` are the
    operation of `?:`, `&&`, and `||`. An `if` of a promoted `computed`
    with a statement body is a `select` over what its two paths return,
    and a path that returns nothing returns a constant. PL does not say
    this of a statement. A dynamic key on a record written in place is a
    `select` over its keys, as §3.18 says, with one more branch,
    `const`, for a key that names no member: PL gives the label of a
    missing key for a `pick` and not for this `select`.
122. **A join** (PL §3.2). `Template` has no node for a join, and PL
    writes "joined with" for the choice of a `pick` and for the
    membership of a `filter`, a `flatMap`, and a scan. Chosen: `derive`
    by expression code over the joined templates. Its confidentiality is
    the join. Its integrity is the meet with `TransformedBy`, which PL
    does not say of a membership.
123. **`pick` over a container slot** (PL §3.18). The child slots are
    the `shape` slot at `a/*`, which `choice` joins and `from` names,
    and one `value` slot at `a/*` as the body. PL has the path the
    surrounding expression reads below the child with the class of that
    read; the crate reads the whole child.
124. **`fold` and the membership of a derived collection** (PL §3.2,
    §3.7, §1.1). The crate has one `Collection` for one element
    construct, and for a `filter` directly over a slot there is no
    second record for "the source". Chosen: `fold.collection` names the
    construct's own record, whose element slots the body is over, and
    the membership that §3.2 joins into a `fold` is that of what the
    construct iterates, which the template also names beside the `fold`.
    PL does not say whether `Collection.source.via` is the method that
    made the source or the one applied to it; the crate keeps the second.
    The assembled output of a scan has the member `collection` (note
    107) and the template of the scan's value, not the membership.
125. **Per-element outputs** (PL §1.4). A `map`, a `filter`, and a
    `flatMap` have one entry at the path of the collection followed by
    `*`, beside the assembled entry, with the template of an element.
    An output of a cone inside the body that only the body uses has no
    entry.
126. **A constructed value used as one value** has no template: a record
    or an array written in place and a rendered tree have a template
    per path (PL §3.4), and `Template` has no node for one where it is
    the branch of a `select`, the element of a `map`, or the value of a
    promoted `computed`. PL does not give the paths below `$UI` either,
    so the output of a rendered tree is one entry with no template. Of
    the 2630 outputs of the plans emitted with no unsupported construct,
    1751 have a template, and 25 of 319 plans have one on every output.
    Nearly all the rest are rendered trees and records.
127. **The template of a write edge, of an operation, and of a binding**
    (PL §3.11, §3.14, §1.1). Every write edge of a body has the body's
    template, a reference edge included, where it "applies where the
    check fails". A path of a binding made in a body has the binding
    body's template whether it is copied or bound by reference. The
    input of an effect requested in the reactive tier is the template of
    its request where that is one path, and else their join (note 122).
    A `Child` has no template member, and its argument is the write
    edges with target `argument`.
128. **`T_label`** (PL §6.2). The listing has
    `derive(expression) [ const, T_repl ]` for the template literal.
    §3.19 makes a template literal a `derive` "over the templates of
    the substitutions", and the crate follows §3.19: no `const` for the
    text.
129. **Hashes, constraints, and `cfc-flow:*` are not emitted.** A `Hash`
    is the tagged hash of a canonical record (PL §1.2), which is
    determined, but every member that holds one is the address of
    something the crate does not produce: the emitted value code
    (`Cone.code`, `CompiledPattern.valueCode`), a body's source "as the
    loader receives it" (`Body.code`), and a schema in its stored form
    (`Slot.schema`, the argument and result schemas, the read
    envelopes). A `Constraint` is built from the label annotations of
    the schemas at a write target and at the inputs (§4.4), and
    `cfc-flow:*` compares the declared labels of a template's slots
    (`Slot.declared`) with those constraints. The templates are there;
    the declared labels and the constraints need the schemas first.

## The records of `wish`, `reduce`, scans, literals, and tags

130. **PL §6.2 as corrected, against the crate.** This replaces note
    114. The crate now agrees with the listing on `B1` (`s2` to `s5`, no
    handle, and `dynamic(link through s4)` in `T_titles`), on
    `titles/* : value` in `B2`, on `B4` (the resolved `identity` slot
    alone), on the ordinals of the uses, and on the row being compiled
    into the room under `{ element }` and `{ site }`. What still
    differs: (a) of the four `shape` slots the listing gives `B1`, the
    crate has the one in place at `threadInfo` and the one at the root of
    the list, and not the ones at `threadInfo/*/root` and at
    `threadInfo/*`. Why the analysis records neither was not traced.
    (b) The source declares the row's key inside the `computed` of
    `replies`, so the crate has no cone `key` (note 114 f). (c) The crate
    has more `shape` slots in place than the listing names "among them"
    (note 114 g). (d) An element body is one cone (note 119). (e)
    `T_label` has no `const` for the text of the template literal (note
    128). (f) The tag is compiled in with the tag's name as the `site`
    step, and what the row declares is in cones of its own inside the
    cone of the `map` callback's tree; the listing does not show the
    cones of the row apart from `text`, `isEdited`, the key, `replies`
    and `threadLabel`.
131. **Typing `handle?.get()` and `list ?? []`.** The static read of FA
    §7.2 through `threadInfo?.get() ?? []` needs both typed: the first
    is the value type of the handle where the handle is present, and the
    second is the array type of its left operand, since the empty
    literal has the element type `never`. Three sites whose check was not
    decided before are decided now and report `subset-type:mismatch`:
    `product/workbench/sessions.ts:267`, `system/fabrichat/room.tsx:1848`
    and `system/quick-capture/quick-capture.tsx:113`. One module that was
    accepted is refused for it.
132. **The operands of `wish`** (PL §3.19). An operand is one write edge
    at the path of its name, with the template of the expression as one
    value: for an array or a record written in place, the join of the
    templates of its members. PL gives "the template of its expression"
    and §3.4 gives a literal a template per path. The form
    `wish("#tag")`, with the query as the one argument, is read as the
    operand `query`. An operand written with a spread or under a name PL
    does not list is counted as unsupported.
133. **The row of a constant query** (PL §3.19). The query is a constant
    where it is a literal written at the call; a name of a constant is
    taken as computed, which adds records and removes none. With the key
    `#now`, a `path` operand that is computed keeps the state cell of
    the one-shot clock. With the key `#profile`, a `path` that is
    computed is taken as a home target, not as the refused picture. PL
    does not give the scope of the clock's `StateCell`; the crate emits
    `space`. PL names the three sidecars by their `launch` functions and
    gives no name for the `name` of the `Child`; the crate uses
    `suggestion`, `profileCreate` and `profilePicker`. The callee is
    `{ compiled: null }` with the sidecar's name beside it, since the
    crate has no content address. PL does not say whether "any other
    string" launches the suggestion sidecar under `headless: true`; the
    crate emits the `Child`.
134. **The hint for a computed query** (PL §8 question 48) has no
    identifier in LS §10. The crate lists it per plan
    (`PatternPlan::hints`) and counts it in `plan --corpus`, and reports
    no diagnostic. The corpus has 1 such call.
135. **The label of a path of a `wish` result** (PL §3.19) is a rule the
    runtime applies to a slot with root `operation` of an operation of
    kind `wish`: `Operation.input` joined with the `dynamic` entry of
    kind `search` that names the operation. `Template` has no node that
    says so, so a reader's template is the `slot` node alone, as PL
    states, and the plan holds the two parts.
136. **`reduce`** (PL §3.13). The operation takes the name §1.3 gives
    it and the collection is named `reduce`, so the two never share a
    name. `Operation.input` joins the `fold`, the membership of the
    receiver, and the template of `init`: "The record" names the `fold`
    and `init`, and "Template" adds the membership. A `reduce` with no
    initial value has no edge at `initial`, which PL does not cover. A
    callback with a statement body is counted as unsupported. The step's
    output is interim at the path `*` with the operation's name.
137. **The predicate of a scan** (PL §3.13) has one output at the path
    of the scan followed by `*`, as a `map` has for its element (note
    125). A scan with a receiver that is a collection of the plan names
    that collection's assembled output, as before.
138. **A spread in an object literal** (PL §3.4). The crate has the
    rule for an operand whose type is an object type with no index
    signature, or a union of such types, where a property one
    alternative lacks counts as optional. An operand of a record type,
    or one with no type, is counted as unsupported (4 sites). The key
    set of the result has no template of its own in the crate, since a
    record written in place has a template per path only (note 126).
139. **A spread in an array literal** (PL §3.4). The positions from the
    first spread on are one member at `*`, a value a cone computes. A
    spread of an array literal written in place is the members written
    out. A spread operand the instance computed gives its own template
    as the template at `*` and as its `enumeration`. An element
    construct over such an array has the template at `*` as the
    membership of what it iterates.
140. **A computed key** (PL §3.4, LS §4.3). A key written as a string, a
    number, or a template literal with no substitution is the name. A key
    that is an identifier keeps the form `$name` the crate had for
    `[UI]` and `[NAME]`.
141. **`db.query(sql, options)`** (PL §3.14) is an operation of kind
    `effect` with the built-in `sqliteQuery`: the handle at the path
    `db`, read for `value`, the statement at `sql`, and each member of
    the options at its own path. The names `db` and `sql` are those of
    the operands of `sqliteQuery`. `Operation.scope` from a `scope`
    option or from `readClearance` is not emitted.
142. **A write through what a site returned** (PL §3.11). A `bind` site
    and an `effect` site return a value the analysis follows, as an
    `instantiate` and a `createCell` site did. A write through the
    stream or the cell is an edge with target `created`, with an empty
    path whatever the path of the write below the cell. A write through
    the link of an `instantiate` or an `effect` site is an envelope
    `{ kind: "created", call }`. The crate does not refuse a write that
    lands at a path the instance or the effect computes.
143. **A tag that names a pattern** (PL §1.1). The children of the tag
    are the path `children` of the argument. The enclosing tree holds
    the `[UI]` of what the pattern returns. A tag that names a factory
    value is a `Child` whose callee is `{ factory: { slot } }`, with one
    write edge of target `argument` per attribute. A factory value the
    instance computed has `{ factory: {} }`: PL names it by an entry of
    `computed` of a body, and the reactive tier has no body there.
144. **Where a helper's widening is reported** (FA §3.6). An authored
    function is a body where a call in the reactive tier names it, in
    any module. The call in the reactive tier is the use of that body
    and reports nothing itself.

## Schemas, declared labels, and constraints

145. **The schema of a type** (`ts_to_json_schema_mapping.md`, cited as
    SM). `src/schema.rs` emits the forms of SM §4, §6.2, §7, §8 and §11
    that the types of the subset have: primitives and literals, objects
    with `properties`, `required` and `additionalProperties`, arrays and
    tuples, unions with the all-literal and the primitive-merging rules,
    a handle as one more entry of `asCell`, a default, and the label
    annotations under `ifc`. It hoists no named type into `$defs` (SM §5),
    so a type that contains itself is cut at depth 12 with `{}`; it emits
    no scope entry in `asCell` (SM §10), no `description` (SM §12), and
    the native table of SM §5.2 as `{}`. A literal has the `enum` form of
    the type path. A pattern factory and a handler factory are
    `{ asCell: ["cell"] }` and `{ asCell: ["stream"] }`, after the
    callable properties SM §4 keeps.
146. **`Slot.schema`** (PL §1.1) is a `Hash`. The crate holds the schema
    itself in its place, since it computes no content address (note 129).
    A slot has one where the emitter has the declared type of its root:
    the pattern's input, the element of a collection, and the event and
    the state of a named handler. A state cell, an operation, a binding
    of an inline handler or an action, and the cause have none. Of the
    10,167 slots of the plans of the accepted modules, 5,720 have a
    schema. A kept output has a `schema` member, which PL's `Output`
    does not have, where the pattern declares a result type: 923 of
    1,561.
147. **A label argument as data** (LS §8.5). The checker keeps the text
    of an annotation's argument. `src/schema.rs` reads a list, a literal
    atom, an object atom, and `AnyOf<list>` from it, and nothing else:
    a reference to an alias, a constant reference `typeof NAME`, a
    marker type such as `CurrentPrincipal`, `PolicyOf`, and a spread are
    not replaced. Such an argument is `{ "$source": text }` in the
    schema, and the slot then declares nothing for that dimension. The
    corpus has 1 slot with a declared label by this reading.
148. **`Slot.declared`** (PL §4.4, LS §8.3). `confidentiality` joins the
    lists of every node from the root to the path, outer first, each
    atom once. `integrity` is the first one found on the way, since LS
    requires it declared alike on one path; `cfc-label:conflict` is not
    checked here. A handle on the way counts as two nodes, the handle
    and its value.
149. **`Plan.constraints`** (PL §4.4). The crate emits `writer`,
    `writerFit`, `writeFloor`, `requiredIntegrity` and
    `maxConfidentiality`. An input constraint lists the slots of
    `Body.reads` at or below the annotated node; a slot above the
    annotated path, which overlaps it in the other prefix direction, is
    not listed, and neither are `handles` and `computed`. It is listed
    on every write edge of the body, as the writes it guards; a body
    with no write edge lists it nowhere, since PL does not say which
    output of the cone it guards. `WriterPolicy.body` is the name of the
    binding where PL has a `Hash`. Only a write edge of a body through a
    handle of a slot has constraints: a write to a state cell, a cone's
    write, and an output have none. The corpus has 6 `writer` and 4
    `writerFit` records.
150. **`cfc-flow:write-policy`** (LS §8.6, PL §4.4) is reported where
    the writing body is not the handler, or the function, that the
    binding of `WriteAuthorizedBy` names, compared by name. A write the
    body makes through a function it calls is the body's. The policies
    of `WritePolicyAnyOf`, `TrustedActionWrite` and
    `TrustedActionWriteWithIntegrity` are not read: the checker keeps
    the name of those aliases and not their arguments. The corpus has no
    report.
151. **`cfc-flow:max-confidentiality`, `cfc-flow:required-integrity`,
    `cfc-flow:write-floor` and `cfc-flow:writer-fit` are not built.** PL
    §4.4 states each as a relation between labels, "fits the ceiling",
    "fits it", and "satisfies the patterns, with one coherent witness
    across them", and gives the relations by the runtime functions that
    hold them today (`verifyInputRequirements`, `verifyWriteFloor`,
    `prepareBoundaryCommitSteps`). Neither PL nor LS defines when a list
    of atoms fits another or when an integrity satisfies a pattern, with
    `AnyOf` clauses and object atoms. Two more things are open for the
    two write checks: `I(template)` and `C(template)` of a `derive` by a
    body need the `TransformedBy` atom, which holds `Body.code`, a hash
    the crate does not have, and PL says a compile-time pass on
    confidentiality "settles nothing", so only a failure counts, which
    needs the relation's negation to be exact. The records are emitted,
    and `plan --corpus` counts the input constraints whose every listed
    slot declares the label: the corpus has no input constraint.
152. **`cfc-flow:ui-contract` is not built.** The checker does not keep
    the arguments of the trusted-action aliases (note 150), and the
    crate has no record of the surface an element sits under.
153. **Hashes** stay as note 129 has them: every `Hash` is the address
    of emitted value code, of source as the loader receives it, or of a
    schema in its stored form, and the crate produces none of the three
    in that form.

## PL as merged, and the label arguments

154. **The three sites of note 131.** (a) `product/workbench/sessions.ts:267`
    was a checker gap: a truthy `s?.startedAs` did not narrow the path
    `s.startedAs`, because the rule for a chain that did not stop was
    tried before the rule for the tested reference. Fixed, and the module
    is accepted again. (b) `system/fabrichat/room.tsx:1848` is reported as
    LS states it: `container?.key("fileStoreRecord")` on an optional
    property that is not a handle is a `Cell<FileStoreRecord | undefined>`
    (LS §4.7), and it is given where the handler declares
    `fileStore?: Writable<FileStoreRecord | Default<{}>>`. LS §7.5.2
    removes `undefined` before the comparison where the callee declares
    the property optional, but states that for the second row, a value
    where a cell is declared, and this argument is a handle, the fourth
    row. The same place named as a value path would be accepted. Not
    changed. (c) `system/quick-capture/quick-capture.tsx:113` is reported
    as LS states it: an array of the values `Note(...)` returns, given in
    a handler where `Notebook` declares a cell of `NotePiece[]`. LS §7.5
    makes one such value assignable "to a cell of such a type", and says
    nothing of an array of them, so the third row of §7.5.1 refuses the
    cell of the array. Not changed.
155. **`Binding.state` and `Collection.construct`** (PL §1.1). A
    collection has `construct`, which for a `reduce` is `operation`. A
    path bound to the index of an element has `place: { index }` and the
    membership the collection iterates as its template, and a path bound
    to `undefined` has no entry. A constant written as the name of a
    module-scope constant is still held as `null`: the emitter evaluates
    a static initializer for a label argument (note 163) and not here.
156. **A join** (PL §3.2). This replaces note 122 and the joins of notes
    124, 127, 132 and 136. `joined` drops `const` inputs and equal
    inputs and returns the one template left, and a `fold` is not joined
    with the membership its collection iterates. Expression code of an
    operator keeps its `const` operands, as the condition of `T_label`
    does in PL §6.2. PL does not say where the line is between "a join"
    and "expression code with a constant operand"; the crate takes every
    place a rule says "joined with" or "the join of" as a join, and the
    operands of an operator, a call of the standard library, and a
    template literal as expression code.
157. **The cones of an element body** (PL §1.4). This replaces note 119.
    Each declaration of the callback that computes is a cone, and the
    returned expression is one more, made before the constructs written
    in that expression. `Plan.cones` is ordered by the edges and then by
    the order in which the cones were made, so the cone of the returned
    expression is after every cone it uses, and is not last where a
    construct written in the returned expression is unused by it, which
    the grammar makes rare. A value a declaration cone computes that
    another cone of the body uses is an interim output at the empty path
    under the declaration's name, as a declaration of a pattern compiled
    into a callback already was: PL says the path "has `*` at the
    position of each enclosing collection" and gives no path for an
    interim name inside a body.
158. **The entries of a constructed value** (PL §3.4). This replaces
    note 126. A value one cone computes that is a record or an array
    written in place, a JSX element, a `select` or a static-key `pick`
    over such values, a promoted `computed` with an expression body that
    returns one, or the element of a `map`, has a container entry and
    one entry per member that is not constructed in place and not
    `const`. A rendered tree has the paths `props/<name>` and
    `children/<n>`; `type` and `name` are constants and have no entry.
    JSX text that is white space with a line break is no child. A child
    whose type is an array, or that is the assembled result of an
    element construct, puts every later child at `children/*`, whose
    template joins the element template and the membership of each
    spread child with the templates of the later children. A spread
    attribute whose operand declares no properties is the member `*` of
    `props` and decides the key set. Chosen where PL is silent or the
    crate differs: (a) the template of the value observed whole is, for
    a `select`, the one `select` over the whole branches, and not the
    join of the per-path `select` nodes, which is the same label in
    fewer nodes; (b) a record written directly in a pattern body or in
    the returned object has an entry per member as before and no
    container entry, since each member is a value of its own cone;
    (c) a promoted `computed` with a block body, and a `pick` whose
    `from` is an output, are one template; (d) what a tag that names a
    factory value renders has no slot in the crate, so its entry has no
    template. Of the 9,100 outputs of the plans emitted with no
    unsupported construct, 9,051 have a template, and 356 of 364 plans
    have one on every output.
159. **The readers of a state target** (PL §3.11). This replaces the
    last part of note 116. The `identity` slot at the cell's root is no
    reader. `side-write:cycle` is reported nowhere in the corpus, where
    it was reported at 12 sites, each an edge from a cone to itself
    through that slot.
160. **The `shape` slots of `B1`** (PL §6.2, note 130 a). The listing
    gives `B1` a `shape` slot at `threadInfo/*` and one in place at
    `threadInfo/*/root`. The source tests `record?.root === undefined`
    on an element of `StoredThreadInfo[]`, whose type admits neither
    `null` nor `undefined`, with `root: Cell<unknown>` required. Both
    tests are decided by the type (FA §2.2), and FA §2.3 removes a
    `shape` entry that only such a test recorded where another entry is
    at or below its path, which `threadInfo/*/root : identity` is. The
    crate follows FA and has neither slot. `T_label` equals the listing
    as merged.
161. **The child slots of a `pick`** (PL §3.18). This replaces note 123.
    A read of a path below the chosen child in the cone the pick is
    written in, or in a cone that uses its output, has the slot at the
    path of the container, `*`, and that path, with the class of the
    read. A child passed on whole is read for `value` at the child,
    because the crate does not follow what a later reader observes
    through a reference a `select` or an output passes on; PL would have
    the `identity` slot there and the reader's own slots below it.
162. **`function-body:wish`** (LS §5.2) is reported at the call, in every
    function body, the body of an authored function included whatever
    calls it. The corpus has no report.
163. **A label argument as data** (LS §8.5). This replaces note 147.
    The checker evaluates the argument where it resolves the alias and
    keeps the value beside the text: a list with each alias replaced by
    its body, a type parameter of an alias by the term written for it
    where the alias is used, a spread by its members, `typeof NAME` and
    `typeof NAME.key` by the value of the constant's static initializer,
    `AnyOf<list>` by `{ anyOf: list }`, and `CurrentPrincipal` by
    `{ __ctCurrentPrincipal: true }`, the form the schema mapping gives
    it. LS says "`CurrentPrincipal` and the other marker types the API
    exports for atoms" and names no other; the crate reads no other.
    `PolicyOf<typeof rules>` is `{ policyOf: { module, binding } }`,
    where the mapping has a record with a digest the crate does not
    compute. `Cfc<T, M>` adds the label keys of the record `M`, and
    `RepresentsCurrentUser` and `AuthoredByCurrentUser` add
    `addIntegrity` with their atom. A term the checker cannot evaluate
    keeps `{ "$source": text }` in the schema and declares nothing.
164. **A writer policy** (LS §8.5; PL §1.5, §4.4). This replaces the
    last part of note 150 and `WriterPolicy.body` of note 149.
    `WriteAuthorizedBy`, `TrustedActionWrite` and
    `TrustedActionWriteWithIntegrity` around a type are the annotation
    `writeAuthorizedBy` with one policy, and `WritePolicyAnyOf` is
    `writePolicyAnyOf` with one policy per member, written directly or
    through an alias. `WriterPolicy.body` is the record
    `{ module, binding }` PL §1.5 hashes, with the path of the module
    where PL has its content-addressed identity. A trusted-action policy
    has `uiContract` with `helper: "UiAction"`, the action, the pattern,
    and `requiredEventIntegrity`, which for `TrustedActionWrite` is the
    pattern alone, as the schema mapping has it.
    `TrustedActionUiContract` is the annotation `uiContract` and gives
    no constraint: PL §4.4 has the UI contract on a `WriterPolicy` only.
    `cfc-flow:write-policy` compares the writing handler or function
    with each alternative by module and name. LS §8.3 requires two
    declarations of one key on a path to be alike; a path with a
    `writeAuthorizedBy` below a `writePolicyAnyOf`, as
    `fabrifile/store.tsx` has at `entries/*/addedBy`, gives one `writer`
    constraint per annotation, and the write has to satisfy each.
165. **Where the constraints are read** (PL §1.5). Still as note 149:
    only a write edge of a body through a handle of a slot has
    constraints. A `state` target, an `argument` target, a `created`
    target, a `request` target, and a kept output against
    `Plan.resultSchema` have none, and an input constraint is not listed
    on an output whose template has a `derive` by the body. A push has
    the target path `*`, so the annotation of the element type applies
    to it.
166. **The corpus, with the label arguments read.** The plans of the
    accepted modules that are emitted with no unsupported construct
    have 11 slots with a declared label, and 10 `writer`, 4 `writerFit`
    and 2 `writeFloor` records. Over every plan of the corpus, the
    refused modules included, there are 32 `writer`, 8 `writeFloor`, 5
    `writerFit` and 4 `requiredIntegrity` records, and 93 write edges
    list a `writer` constraint, 51 of them in `fabrichat/room.tsx`.
    `cfc-flow:write-policy` reports nothing: every such edge is in a
    handler its policy names.
