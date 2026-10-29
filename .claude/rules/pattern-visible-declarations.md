---
paths:
  - "base/api/index.ts"
  - "base/api/schema.ts"
  - "base/data-model/src/**"
  - "runtime/runner/src/builder/factory.ts"
  - "runtime/runner/src/builder/types.ts"
  - "runtime/memory/v2/sqlite/schema.ts"
---

# The declarations a pattern compiles against

`base/api/index.ts` is the whole of the `commonfabric` module's type, and
what the sandbox hands the pattern compiler is
`base/static/assets/types/commonfabric.d.ts`, generated from it by
`base/static/scripts/generate-commonfabric-types.ts`. So an edit to the
declarations takes `deno task gen-commonfabric-types` in `base/static` with
it, and `check-commonfabric-types` fails the build until it has been run. The
generator inlines the modules `index.ts` draws its declarations from rather than
following a specifier out of them, because the compiler that reads the result
resolves none.

Anything that file describes and does not implement, it describes by declaring a
second copy of the shape by hand, and the implementation is in
`runtime/runner/src/builder`, `base/data-model`, or
`runtime/memory/v2/sqlite`.

The fabric value types are not among them: `base/api` re-exports
`@commonfabric/data-model/api`, so there is one declaration and each
implementation asserts against it beside its own definition. What is copied is
the builder vocabulary, and the compiler compares that too.

## A value: the binding has to satisfy the declaration

The sandbox binds the `commonfabric` module to the object
`builder/factory.ts` builds, and `BuilderFunctionsAndConstants` in
`builder/types.ts` is derived from `typeof import("@commonfabric/api")`. So
adding an `export declare const` to `index.ts` and nothing else makes
`factory.ts` stop compiling, which is the point: without a binding the
declaration is a promise the runtime does not keep.

Three kinds of failure show up at the object literal in `factory.ts`:

- A missing property is a declaration with no binding. Bind it, or drop the
  declaration.
- A property whose type does not match is drift. The declaration is what pattern
  authors were compiled against, so fix whichever side is wrong on its merits.
- An excess property is a binding nothing declares. Either declare it, or add
  it to the members `BuilderFunctionsAndConstants` writes out for itself — the
  ones a pattern cannot name, which the interface lists with why.

Two lists in that file are the whole of what escapes this. `DriftingBindings`
names the bindings that cannot satisfy their declarations today, each with what
stands in the way; it can only shrink, because `NoStaleDriftingBindings` stops
compiling when an entry's drift has been fixed and the entry survives.
`IntentionallyUnrequired` names the declarations that need no binding at all —
brands, and the CFC vocabulary that `commonfabric/cfc` binds instead. A
declaration not on that list is required, so adding to it is how you exempt one,
and the reason goes beside the name.

## `schema.ts` is part of the declared surface

`base/api/schema.ts` augments several of the interfaces in `index.ts` with
schema-carrying overloads. Those augmentations are part of what a binding has to
satisfy, so a signature that looks unimplemented may have its second half
there.
