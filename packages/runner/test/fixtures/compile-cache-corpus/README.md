# Compile-cache version corpus

A frozen copy of pattern sources, each entry with its import closure, that
`deno task compile-cache-version` compiles to mint the durable compile cache's
version (`packages/runner/src/compilation-cache/compile-cache-version.ts`). The
version is a hash of the bytes the compiler emits for these files under every
persisted cache variant (plain, instance-naming, coverage-instrumented, and
both), so a compiler change that emits the same bytes in every mode keeps every
compiled document in every space valid, and one that moves any byte recompiles
them all once.

The entries are named in `tasks/compile-cache-version.ts` (`CORPUS_ENTRIES`);
the other files here are the modules those entries import. They are copies of
files under `packages/patterns`, taken as they stood when the corpus was last
refreshed, and they are not kept in step with the originals: what matters is
that they exercise the compiler widely, not that they are current. A construct
the corpus lacks is one the version cannot see a change to, so a transformer
feature the corpus does not reach earns a file here.

Editing a file here, refreshing one from `packages/patterns`, or adding an entry
changes the bytes the corpus compiles to, so it re-mints the version
(`deno task compile-cache-version --write`) in the same change, and the
`check-compile-cache-version` gate holds the two together.

These files are data for that task: `deno task check` does not type-check them
(`UNCHECKED_TREES` in `tasks/typecheck.ts`), and the pattern gates over
`packages/patterns` do not read them.
