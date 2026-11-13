# Notes on the specification

Places where
[`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
is ambiguous, says two things, or cannot be implemented as written, with the
reading this crate chose. Where the document leaves a choice, the reading is the
one that accepts less. The crate implements the document as it stands at commit
`d0973bc0de`. A note that the document has since settled is removed, so the
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

44. **A read of an optional property, where the property holds a handle or
    has a default** (§7.6, §7.5.2, §12.7). §7.6 gives the read of an optional
    property `undefined`, and refuses a receiver that is one. The corpus
    declares a pattern input that may be left out as an optional property,
    `bookmarks?: Writable<Bookmark[] | Default<[]>>`, and uses the binding as
    present: `bookmarks.get()`. Chosen: as §7.6 states, the read has
    `undefined`, whatever the property holds and whether or not its type
    declares a default. 503 receivers are refused for this alone (434 hold a
    handle), and 223 arguments. §12.7 writes the input without the `?`,
    `glaze: Default<string, "plain">`, and the document does not say whether a
    caller may leave out a property whose type declares a default. The crate
    requires it of the caller.
45. **An argument that is an optional property of the caller, where the
    callee declares the property required** (§7.5.2, the point on
    `undefined`). The sentence "an argument of type `string | undefined` is
    accepted, as an argument that is an optional property of the caller's own
    input is" can be read to accept the second case wherever it occurs. Its
    reason names the callee's declaration. Chosen: both are accepted only
    where the callee declares the property optional.
46. **A literal where a cell is declared, in an argument bound by reference**
    (§7.5.2, the second row). The row asks whether a `Cell<T>` of the
    argument's type is assignable to the declared handle, and a literal has a
    literal type: `Cell<"ring">` is not a `Cell<string>`. Chosen: a literal
    written at such a position is checked part by part against the value type
    of the declared cell, as a literal is wherever a type is expected (§7.5).
47. **The body of a `computed` and §7.5.2.** The rule holds in tier R. §6.2
    has every `computed` checked under the rules of tier F, promoted or not.
    Chosen: a call in the body of a `computed` is not bound by reference.
48. **`AnyCell<T>`** (§7.2). The document does not list the type, and
    `base/api/index.ts` declares the parameters of `equals` and of the context
    reads with it. Chosen: a handle kind with no method. A handle of every
    kind but `SqliteDb` is assignable to it, with the value type compared
    forward, and it is assignable to itself alone.
49. **API types the crate does not read** (§7.2). `VNode` is opaque, and
    `JSONValue` and `JSONSchema` are structural, as the document states. Every
    other type `commonfabric` exports that is not a constructor of §7.2, such
    as a built-in's parameter type, is an ordinary object type whose
    declaration the crate does not read. Chosen: nothing is decided against
    one. An optional property of an object type is assignable to `JSONValue`
    by its declared type.
50. **Where a literal type is widened** (§7.5). The inferred result type of a
    function is widened where the function returns a literal, in each branch
    of a conditional too. Chosen: a returned value of a declared union of
    literal types keeps that type, and so does a property of an object
    literal and a `let` initialized with one. The crate carries the expected
    type into the callback of `map` and `flatMap`, into a `computed`, and into
    a function written where a function type is expected. It does not carry
    it into the callback of an authored generic function.
51. **A pattern instantiated in a function body with a value where it declares
    a cell** (§7.5.2, §5.2). `Note({ title: "New Notebook" })` in a handler,
    with `title?: Writable<string | Default<"">>`, is refused as §7.5.2
    states: a function body passes a handle where a handle is declared. The
    corpus has 35 such arguments, and the document names no form for giving a
    new instance its initial values.

## Narrowing and data positions (§7.6, §7.8)

52. **Narrowing** (§7.6). Implemented for every test the section lists. An
    assignment to a `let` narrows a reference where it is the last assignment
    written before the reference, is a statement of a block around it, and no
    loop around the reference assigns the binding outside that statement. The
    crate computes no join: after an `if` that assigns in one branch, the
    binding has its declared type. A binding assigned in another function
    than the one that reads it is not narrowed. Three cases narrow less than
    TypeScript does: the `default` case of a `switch`, a case another case can
    fall into, and a path such as `order.note` of a binding that is assigned.
    One case narrows more than it should: a path stays narrowed after an
    assignment to that path. A type that a condition would narrow to `never`
    is left as it was. An optional chain that is truthy, is compared with a
    value that is never absent, or is not `undefined`, narrows each receiver
    it tests and the path it reads.
53. **`"k" in x` on `object`** (§7.6, §7.8). `typeof x === "object"` narrows
    an ordinary `unknown` to a type with no property. The corpus then tests
    `"id" in x` and reads `x.id` (14 reads in 4 modules). §7.6 lists `"k" in
    x` without saying what it gives a type that declares no property. Chosen:
    nothing, so the read is `schema:path-not-in-type`.
54. **Which expressions are data positions** (§7.8). As the section lists
    them. Two readings were chosen. A `let`, and a `const` whose initializer
    is an operator or a call other than `get()` and `sample()`, is an ordinary
    value, `detail ?? fallback` included. The parameter of an inline event
    handler is a root, with the event of an `action`.
55. **The type names of the browser** (§7.10). The document names four and
    "every other name of the DOM library". Chosen: a global type name that
    ends in `Event`, or begins with `HTML`, `SVG`, or `DOM`, and a list of
    other names in `is_dom_type_name` of `src/api.rs`.
56. **The parts of §7 the crate does not apply.** Assignability is applied at
    an argument, an attribute of a tag that names a pattern, a returned value,
    and an initializer, and not at an assignment, a property of an object
    literal outside those sites, or an argument of a handle method such as
    `set`, `push`, or `send`. `e as T` is not tested for relatedness unless it
    goes through `unknown`, and `e satisfies T` is not checked (§7.7). A
    generic function is not checked per instantiation; a property read on a
    type parameter reads its constraint (§7.3). The predicate of
    `isWellFormedDID` is the one built-in predicate the crate knows.
