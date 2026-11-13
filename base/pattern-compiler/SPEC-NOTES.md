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

13. **`Default<T, typeof NAME>`** (§8.8, §11.4). §8.8 requires a literal-like
    type, and §11.4 lists `Default<typeof EMPTY>` as a common accepted form. The
    type of an annotated constant, `const EMPTY: Viewer = {}`, is `Viewer`,
    which is not literal-like. Chosen: `typeof NAME` in a default takes the
    value from the initializer of `NAME`, whatever its annotation, and a
    primitive literal there has its literal type. It is static when the
    initializer is a literal expression, refused (`default:not-static`) when the
    initializer is a call or a `new`, and not decided when the initializer
    refers to other values. One corpus site is refused:
    `INITIAL_SHOTS = createInitialShots()` in
    `patterns/showcase/battleship/multiplayer/schemas.tsx`.
14. **An intersection with a handle, a function, or an opaque API type** (§7.4).
    "Any other combination is `never`" would refuse `Cell<A> & { ... }` and
    `VNode & { ... }`. The document does not give the structure of the opaque
    API types. Chosen: such an intersection is left unevaluated and is not
    reported. This is the one place the crate does not take the reading that
    accepts less.
15. **A function type inside a data type that describes a cell-like value**
    (§7.9, §11.4). `MentionablePiece` in
    `patterns/system/backlinks-index/backlinks-index.tsx` declares
    `mentionable?: MentionablePiece[] | { get?: () => MentionablePiece[] }`, and
    the type is a pattern input, a cell value, and a handler state in ten
    modules. §11.4 accepts function types "as code types". Chosen: as §7.9 says,
    so each use is `subset-type:function-in-data`, 35 reports from the one
    declaration.
16. **`.get()` on a value whose type declares a `get` of its own** (§4.4). A
    helper's parameter typed `{ get(): T }` is not a `Cell`, and
    `opaque-get:invalid-call` names the three cell types only. Chosen: not
    reported, since the call is an ordinary method call of that object type.
17. **`key` on a handle whose property is itself a handle** (§4.7, §12.4). §4.7
    says `key(k)` "yields a handle of the same kind for the property". For a
    property of type `Cell<T>` that is `Cell<Cell<T>>`. `aboutRecordOf` in
    `patterns/system/fabrichat/manager.tsx` returns
    `room.key("about").key("record")` under the result type `Cell<AboutRecord>`,
    where the declared type gives `Cell<Cell<AboutRecord>>`. Neither rewrite of
    §12.4 covers it: the function does not return its argument. Chosen: the
    crate reports the declared type and proposes no replacement.
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
11. **Per-element bodies over plain values** (§11.3): 7 in 7 files against 9
    callbacks in 7 files. With declared types the crate also finds a stored list
    of strings in `patterns/dev/map-captured-object-spread/main.tsx`. The crate
    reports per callback, and three are in
    `patterns/apps/weekly-calendar/weekly-calendar.tsx`. The document counts a
    collection that is a call result, and the crate decides those only for
    `Object.keys`, `Object.entries`, and `split`; the plainness of any other
    call result needs the body record of the function (§4.4.1).
12. **The split of the promotion table** (§11.5). The totals agree: 1,369
    promoted, 109 not, 15 in statement position. The crate counts a body under
    "guard" whenever it uses a guard, and a collection callback with a statement
    body as a disqualifying expression, so the rows differ by a few calls each.
