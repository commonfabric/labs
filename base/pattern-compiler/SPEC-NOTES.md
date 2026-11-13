# Notes on the specification

Places where
[`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
is ambiguous, says two things, or cannot be implemented as written, with the
reading this crate chose. Where the document leaves a choice, the reading is the
one that accepts less. The crate implements the document as it stands at commit
`d24ff348c7`. A note that the document has since settled is removed, so the
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
15. **`Default<V>` as a member of a union, and `DeepDefault<V>`** (§8.8). The
    document says both follow the schema mapping and gives no rule of its own.
    Chosen: `T | Default<V>` has the value type `T`, the member is dropped when
    the type is resolved, and the default annotation is not kept on the union.
    `DeepDefault<V>` is an opaque named type here.
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
18. **`typeof` of a string constant in a label argument** (§8.5, §7.1). The
    document says `typeof name` in a label argument names the binding and never
    its type, and allows a binding reference in `WriteAuthorizedBy`, in
    `PolicyOf`, and as the writer of a trusted-action alias. The corpus writes
    `typeof SOME_CONSTANT`, with the constant a string literal, as a label atom
    (48 sites) and as the action or the pattern of a trusted-action alias (72
    sites). Read with TypeScript's meaning of `typeof` these are string literal
    types. Chosen: as the document states, so each is `cfc-label:not-static`.
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
25. **Narrowing** (§7.6). Implemented in `src/narrow.rs` for every test the
    section lists except an assignment to a `let`. A binding that is assigned
    anywhere in the module is not narrowed at all, which is the reading that
    types less. Three cases narrow less than TypeScript does: the false branch
    of `a && b` and the true branch of `a || b`, the `default` case of a
    `switch`, and a case another case can fall into. One case narrows more than
    it should: a path such as `order.note` stays narrowed after an assignment to
    `order.note` between the test and the use, because the walk does not look
    for writes to a path. A type that a condition would narrow to `never` is
    left as it was.
26. **A kind test on `unknown`** (§7.8, §7.6). A kind test narrows a value typed
    `unknown` that the body computed and does not narrow a data position typed
    `unknown`. The document does not say how the checker tells the two apart.
    Chosen: a reference rooted at a parameter of a builder's callback is a data
    position, and `typeof`, `Array.isArray`, and `instanceof` leave its
    `unknown` as it is. A reference rooted at any other binding, a parameter of
    an authored function included, is narrowed. A type predicate narrows both.
27. **Built-ins whose result the crate types.** `wish`, `fetchJson`,
    `fetchJsonUnchecked`, and `generateObject` have the result
    `{ pending: boolean; result: T | undefined }` with `T` the written type
    argument, and `generateText` and `fetchText` the same with `string`. The
    declarations in `base/api/index.ts` have more fields. The crate does not
    read them, so any other field of such a result has a type that is not
    evaluated. The other effectful built-ins have no signature here.
28. **The parts of §7 the crate does not apply.** Assignability is applied at an
    argument, a returned value, and an initializer, and not at an assignment, a
    property of an object literal outside those sites, an argument of a handle
    method such as `set`, `push`, or `send`, or a JSX attribute. `e as T` is not
    tested for relatedness unless it goes through `unknown`, and `e satisfies T`
    is not checked (§7.7). A generic function is not checked per instantiation
    (§7.3).
29. **Iterators of `Map` and `Set`** (§9.9). `keys()`, `values()`, and
    `entries()` are given array types, which is enough for spread, `for...of`,
    and `Array.from`, and wrong for a method called on the iterator itself.

## Assignability (§7.5)

31. **A value named where a cell is declared, in the reactive tier** (§7.5,
    §4.6). §4.6 says the state of a handler applied in tier R is bound by
    reference, and each path of it is an input, a state cell, an element, or a
    computed value. So `save({ items })` with `items` an input declared
    `Donut[]` binds a state declared `Writable<Donut[]>`, and the corpus writes
    this at about 200 sites. The same holds in the other direction for a cell
    named where a pattern input, or the parameter of a `lift` called in tier R,
    declares the value type. §7.5 has no rule for either: it makes a handle type
    assignable only to handle types and `unknown`, and makes nothing but a
    pattern instance assignable to a handle type. Chosen: both are refused
    (`subset-type:mismatch`), and counted under "a value where a cell is
    declared" and "a cell where a value is declared" so that the corpus report
    can tell them from other refusals.
32. **`Cell<T>` where `Cell<unknown>` is declared** (§7.5, §7.8). §7.8 gives
    `Cell<unknown>` as the type of a handle whose content the body does not
    know. §7.5 makes `Cell<T>` assignable to `Cell<U>` only when `T` and `U` are
    the same type, and `unknown` is not the same type as a declared `T`. Chosen:
    refused, as §7.5 states, and counted on its own.
33. **Handles §7.5 gives no value rule for.** The section states the value rule
    for a `ReadonlyCell` target (the value type is assignable) and for a `Cell`
    target (the same type). Chosen for a `WriteonlyCell`, a `ComparableCell`, an
    `OpaqueCell`, and a `Stream` target: the same type, which is the rule that
    accepts less.
34. **Where a literal type is widened** (§7.5). The section names `let` bindings
    and mutable properties. Chosen in addition: an element of an array literal,
    and the inferred result type of a function that returns one literal. A
    literal written where a type is expected is checked part by part against
    that type and is not widened there. The crate does not carry an expected
    type into the body of a callback through a generic method, so
    `rows.map((row) => ({ kind: "mix" }))` returned under a result type with a
    literal `kind` is refused. That is a gap of the crate and not a rule of the
    document; the count "a primitive type where its literal types are declared"
    holds these.
35. **An opaque API type** (§7.2, §7.5). The structure of `VNode`, `JSONSchema`,
    and the other opaque named types is not part of the language. Chosen:
    assignability between an opaque type and any other type but itself is not
    decided, and nothing is reported.
36. **Tuples.** The type representation does not keep which elements of a tuple
    are optional. Chosen: a shorter tuple against a longer one is not decided.

## The rules that read a type (§10.4)

40. **A property read on `unknown`** (§10.4, §7.8). The entry
    `schema:unknown-type-access` names "a function body". §7.8 lists `?.` among
    the tests of presence of a position typed `unknown`. Chosen: `x.p` and
    `x?.p` with `x` typed `unknown` are both reported, because both read the
    property `p`, and they are reported in every function, a pattern's callback
    included.
41. **A receiver that may be absent** (§10.4). `subset-type:mismatch` names "a
    possibly-`undefined` receiver". The crate gives the read of an optional
    property the declared type without `undefined`, so a receiver that is an
    optional property is not reported. A receiver whose type names `null` or
    `undefined` is.
42. **A type name of the browser** (§7.10). `Event`, `CustomEvent`, and the
    other names of the DOM library resolve to no declaration of the program, no
    API type, and no standard-library type of §7.1. Chosen: as the document
    states for a name that resolves to nothing, `subset-type:mismatch`.
43. **`ReturnType` of a pattern factory and `Parameters` of a handler factory**
    (§7.10, §7.2). The table defines `ReturnType` on a handler factory and
    `Parameters` on a pattern factory, so the letter of the table refuses the
    other two (`subset-type:operator-operand`). The crate gives them the
    pattern's result type and a tuple of the handler's state type and reports
    nothing. This is the one place where the crate accepts more than the
    document states, and it was left so because the previous slice computed both
    and the corpus was not measured without them.
