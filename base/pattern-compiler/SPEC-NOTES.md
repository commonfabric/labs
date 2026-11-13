# Notes on the specification

Places where
[`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
is ambiguous, says two things, or cannot be implemented as written, with the
reading this crate chose. The crate implements the document as it stands at
commit `a118e85a78`.

Where a note has a key, a diagnostic that depends on the reading carries the key
in its `note` field, and the corpus report counts the errors per key.

## Rules without a catalog identifier

Rule 3 of §2 says no construct is refused without a catalog entry. These
refusals have none.

1. **What a frozen-data initializer may not do** (§3.2; key
   `frozen-data-prohibitions`). The initializer "may not read the ambient clock
   or entropy, call a builder, or call an effectful built-in". Chosen: a read of
   the clock is `function-body:ambient-read` and an effect request is
   `function-body:effect-in-computation`, in the initializer and in a function
   it runs. `computed`, `action`, and `assert` called at module scope are
   `function-body:builder-call`. A `pattern`, `lift`, or `handler` call nested
   inside a frozen-data expression, such as `const TOOLS = [pattern(...)]`, is
   treated as a builder definition and is not reported.
2. **A reactive body with no final `return`, or with `return;`** (§4.2; key
   `return-without-expression`). §4.2 requires one `return` with an expression.
   `pattern-context:early-return` covers a `return` that is not last and a
   second one. Chosen: `return;` as the last statement is reported under
   `pattern-context:early-return`. A block with no `return` at all is not
   reported; the type checker sees its result type.
3. **Module-scope forms outside the table of §3.1.** `export =`,
   `export as namespace`, and a `using` declaration are reported as
   `module-scope:statement`, and `import x = require(...)` as
   `module-scope:import-form`. `export default` is accepted with any expression
   that is one of the three initializer kinds, although the table lists
   `export default name` and `export default pattern(...)` only.
4. **`new` of a constructor §9 does not list, in a function body** (§5.1). Not
   reported. A reference to a global that §9 does not list is reported as
   `stdlib:unsupported-member`, whether it is called, constructed, or read.
5. **A staged change in the reactive tier** (`grantSpaceAccess`,
   `revokeSpaceAccess`, `nameBlob`). `builtin-inventory.md` says only a handler
   requests one. Chosen: `reactive:unsupported-call`.
6. **`assert` in a function body.** §3.2 says `assert` is written in tier R
   only. `function-body:builder-call` lists `pattern`, `lift`, `handler`,
   `computed`, and `multiUserTest`. Chosen: `assert` there is
   `function-body:builder-call`.
7. **A removed helper outside the reactive tier.** `removed-form:helper` is for
   tier R, and `removed-form:helper-unsupported` lists three other forms.
   Chosen: `ifElse`, `when`, `unless`, or the `str` tag in a function body or at
   module scope is `removed-form:helper-unsupported`.
8. **Dynamic keys in a `const` destructuring and in an object literal of tier
   R** (§4.2, §4.3). Both tables allow static keys only. Whether a key is static
   needs the literal type of a module-scope constant. Not reported.
9. **Declaration merging** (§7.9). Reported as
   `subset-syntax:ambient-declaration` for a second interface of one name. Other
   merges, such as a function with a namespace, are covered by the refusal of
   the namespace.

## Two statements that differ

10. **A pattern callback passed by name** (§3.2 and §4.1; key
    `callback-by-name`). §3.2 lets the callback of any of the three module-scope
    builders be the name of a function of the module. §4.1 says the callback of
    `pattern(...)` is written at the call. Chosen: a name is accepted for `lift`
    and `handler` and refused for `pattern`, `computed`, `action`, and `assert`,
    as `builder-callback:indirect-reference`.
11. **The corpus rule** (§11.1). §11.1 describes 403 modules. The corpus
    measurement that accompanies the documents uses the files
    `deno task cfcheck` compiles and arrives at 425. The `corpus` command uses
    the measurement's rule.
12. **FabriChat** (§11.3). §11.3 says FabriChat needs one change, the four
    overload signatures. By §4.4.1 it needs a second:
    `patterns/system/fabrichat/message-row.tsx` maps the module-scope constant
    `FABRICHAT_QUICK_REACTIONS`, imported from another module, and binds the
    handler `commitSendReaction` in the callback without using the index
    (`collection:shared-element-state`).
13. **The plain-object test** (§9.3, §11.3). §9.3 adds `Object.getPrototypeOf`
    "for the test that a value is a plain object". The test the corpus writes is
    `Object.getPrototypeOf(value) !== Object.prototype`, and §9.3 does not list
    `Object.prototype`. Chosen: as written, so the three sites are
    `stdlib:unsupported-member`.

## Readings

14. **The parameter of a pattern callback** (§4.1; key
    `pattern-parameter-nesting`). "An object destructuring pattern with static
    keys" does not say whether a property may itself be destructured. Chosen: a
    nested object pattern is accepted under the same rules, and an array pattern
    is refused.
15. **The parameters of a collection callback** (§4.4.1). The callback "takes
    the element and, optionally, the index". Chosen: either may be a
    destructuring pattern, since §4.2 allows destructuring in a `const`.
16. **A method call with one argument in tier R.** A call `x.name(arg)` whose
    method is not marked "R" could be a call of a pattern or handler factory
    held in a property (§4.4.2), which only the receiver's type decides. Chosen:
    it is reported as `reactive:unsupported-call` only when it has no argument,
    more than one, or one that cannot be an object, such as a string literal.
17. **An expression statement in tier R whose callee is not resolved** (§4.2). A
    call of a local value or of an import the program does not hold could be a
    pattern instantiation, which is a recorded call. Chosen: accepted.
18. **A promoted `computed`.** The body is checked under the rules of the
    function tier, which accept everything the criterion of §6.1 accepts, so
    that promotion cannot change whether a program is accepted (§6.2). The body
    record has tier R and the outcome of the criterion. The function form
    `equals(a, b)` and a pure API function of §4.4.4 are taken to be allowed in
    a promoted body, although condition 4 of §6.1 does not list them.
19. **`collection:shared-element-state` over an imported constant.** §4.4.1 says
    a module-scope constant is plain. Chosen: a constant imported from another
    module of the program counts, as one declared in the module does.
20. **An import with no bindings that imports types** (§3.1).
    `import type {} from "commonfabric/schema"` in
    `patterns/apps/topics/topic.tsx` is an import with no bindings, so it is
    `module-scope:import-form`.

## Found in the corpus and not in §11

These are refused by the rules as written, and §11.3 does not list them.

- A collection callback that is a name: `.filter(Boolean)` in
  `patterns/apps/annotation-manager/annotation-manager.tsx` and
  `.map(toMentionable)` in
  `patterns/examples/nested-mentionables/nested-mentionables.tsx`
  (`collection:callback-parameters`).
- An authored function that the pattern body calls and that creates a cell
  without a cause (`makeProfile` in
  `patterns/dev/catalog/stories/cf-profile-badge-story.tsx`) or requests an
  effect (`BuildingBlock` in `patterns/dev/gideon-tests/test-reactive.tsx`).
- `Math.random()` and `Date.now()` in a `computed`, in the two patterns under
  `patterns/dev/test/non-idempotent/`, which exist to do that.
- The `Function` constructor and a `console.log(...)` statement in the pattern
  body of `patterns/dev/test/data-model-test.tsx`.
- Two immediately invoked functions in JSX in
  `patterns/dev/gideon-tests/test-helper-owned-jsx-iife-captures.tsx`.
