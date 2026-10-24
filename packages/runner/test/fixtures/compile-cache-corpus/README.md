# Compile-cache version corpus

A frozen copy of pattern sources, each entry with its import closure, that a
build compiles to compute the durable compile cache's version
(`packages/runner/src/compilation-cache/compile-cache-output-version.deno.ts`).
The version is a hash of what the compiler emits for these files under every
persisted cache variant (plain, instance-naming, coverage-instrumented, and
both): each compiled document's body, stored fields and import edges. A compiler
change that compiles them to the same documents in every mode keeps the compiled
documents of every construct these files exercise valid, in every space, and one
that changes any of them recompiles them all once. A construct these files do
not exercise is the version's blind spot, which is why the corpus is wide and
why `COMPILE_CACHE_EPOCH` exists. `tasks/build-binaries.ts` bakes the version
into a binary, the shell's production bundle defines it, and
`deno task compile-cache-version --bake` writes it into a tree that runs from
source but ships as it stands, as loom's vendored copy does.

The entries are named in that module (`CORPUS_ENTRIES`); the other files here
are the modules those entries import. They are copies of files under
`packages/patterns`, taken as they stood when the corpus was last refreshed, and
they are not kept in step with the originals: what matters is that they exercise
the compiler widely, not that they are current. A construct the corpus lacks is
one the version cannot see a change to, so a transformer feature the corpus does
not reach earns a file here.

Editing a file here, refreshing one from `packages/patterns`, or adding an entry
changes the bytes the corpus compiles to, so it moves the version of every later
build, and every compiled document recompiles once.

These files are data for that build step: `deno task check` does not type-check
them (`UNCHECKED_TREES` in `tasks/typecheck.ts`), and the pattern gates over
`packages/patterns` do not read them.
