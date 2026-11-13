# Notes on the specification

Places where
[`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
is ambiguous, says two things, or cannot be implemented as written, with the
reading this crate chose. Where the document leaves a choice, the reading is the
one that accepts less. The crate implements the document as it stands at commit
`46ffb54cbd`.

## The front end (§3 to §6)

1. **A runtime call at module scope whose callee is a value** (§3.2).
   `module-scope:runtime-call` covers instantiating a pattern and binding a
   handler. A call of a factory value held in a module-scope constant is one of
   those, and only the callee's type shows it. Chosen: the entry is reported
   where the callee resolves by name, and the rest waits for types.
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
7. **Promotion, the two forms that need more than syntax** (§6.1). A `reduce`
   whose accumulator has a code type and an object literal with a key that is
   not static disqualify a `computed`. Chosen: neither is tested by the
   syntactic criterion, so `computed:redundant` can be reported for a body the
   type checker's criterion would not promote.

## The type system (§7, §8)

13. **`Default<T, typeof NAME>`** (§8.8). Ruled: a default named by `typeof` of
    a constant whose initializer is a call is refused. Still open: an
    initializer that is not a literal and not a call, such as one that spreads
    another constant. Chosen: not decided, and not reported.
14. **An intersection with a handle, a function, or an opaque API type** (§7.4).
    "Any other combination is `never`" would refuse `Cell<A> & { ... }` and
    `VNode & { ... }`. The document does not give the structure of the opaque
    API types. Chosen: such an intersection is left unevaluated and is not
    reported. This is the one place the crate does not take the reading that
    accepts less.
15. **`Default<V>` as a member of a union** (§8.8). `T | Default<V>` gives the
    value type `T`. Chosen: the member is dropped from the union when the type
    is resolved, and the default annotation is not kept on the union, because no
    rule of this slice reads it there.
16. **`.get()` on a value whose type declares a `get` of its own** (§4.4). A
    helper's parameter typed `{ get(): T }` is not a `Cell`, and
    `opaque-get:invalid-call` names the three cell types only. Chosen: not
    reported, since the call is an ordinary method call of that object type.
17. **`get()` after a `key` that flattens to a stream** (§4.7, ruling R2). `key`
    flattens every handle it passes through, so `inbox.key("receive")` on a
    `Cell<{ receive: Stream<E> }>` is a `Stream<E>`.
    `patterns/system/fabrichat/manager.tsx` line 632 then calls `.get()` on it
    to obtain the stream, and a `Stream` has no `get` (§4.7). Chosen: as the two
    rules say, so the call is `opaque-get:invalid-call`, and the rewrite drops
    the `.get()`.
18. **Label arguments** (§8.5). A label list written as a reference to an alias,
    and the arguments of `PolicyOf` and of the trusted-action aliases, are not
    evaluated, so `cfc-label:not-a-list` and `cfc-label:not-static` are decided
    for a list written in place.
19. **What this slice does not evaluate.** `Exclude`, `Extract`, an optional or
    rest element of a named tuple member, a qualified name, the type arguments
    of a generic function at a call, and a type from a module outside the
    program resolve to an unevaluated type. No rule refuses a program because of
    one.

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

20. **Where the warning for an instantiation without a cause applies** (ruling
    R10). The ruling says "inside a loop or a callback in a function body".
    Chosen: a `lift`, a `computed`, and an `assert`, where an instance is named
    by its ordinal. A `handler` and an `action` are not warned, and neither is
    an authored function a computation calls. A nested function counts as a
    callback whatever it is passed to. The identifier is provisional:
    `function-body:instantiation-without-cause`.
21. **A state cell in a per-element body that also instantiates a child**
    (ruling R11). The ruling puts the position in the key where such a body
    instantiates a child, and asks whether the body's own state cell is then
    accepted. The documents do not say. Chosen: the state cell is still refused
    when the callback does not use its index. The crate counts the bodies over
    plain values that instantiate a child; the corpus has none. This is a
    question for the owner.
22. **A call of an overloaded function** (§7.9). Overloads are refused, and a
    call of one still has to have a type for the code around it. Chosen: the
    result type of the first signature.
23. **A value of a function type** (§7.1). The representation keeps no signature
    for a function type, so the result of calling a parameter or a property of
    function type has no type. Six receivers in the corpus.
24. **Generic functions** (§7.3). A type parameter is bound from a written type
    argument, or from the argument whose parameter is the type parameter, an
    array of it, or a handle of it. Any other parameter stays unbound, and the
    function body is not checked per instantiation.
25. **Narrowing** (§7.6). Not applied. A method called on a union is typed when
    the union has one member besides `null` and `undefined`.
26. **The result of `computed`** (§7.2). `Reactive<T>` is `T`, so the result of
    `computed(() => e)` has the type of `e`, and `.get()` on it is
    `opaque-get:invalid-call`.
27. **Built-ins whose result this slice types.** `wish`, `fetchJson`,
    `fetchJsonUnchecked`, and `generateObject` have the result
    `{ pending: boolean; result: T | undefined; error: unknown }` with `T` the
    written type argument, and `generateText` and `fetchText` the same with
    `string`. The declarations in `base/api/index.ts` have more fields, which
    read as untyped here. The other effectful built-ins have no signature in
    this slice.
