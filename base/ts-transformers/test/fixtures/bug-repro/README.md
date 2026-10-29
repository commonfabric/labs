# bug-repro

Standalone, `cf check`-runnable repro patterns for compiler bugs — **not**
golden fixtures, and deliberately outside the suites `fixture-based.test.ts`
discovers.

A shape belongs here instead of an `.input.tsx` / `.expected.jsx` pair in a
suite directory exactly when it **produces an error diagnostic** (or, pre-fix,
a crash): the golden runner fails any fixture whose transform reports an
error-severity diagnostic, so diagnostic-producing shapes cannot be golden
pairs. Their contract is pinned the other way around:

- the **diagnostic** (type, message, no-crash) is pinned by a `validateSource`
  unit test (see `test/README.md` — diagnostic message text is the one
  sanctioned string-match), and
- the file here stays as a human-runnable repro for the real pipeline:

  ```sh
  deno task cf check base/ts-transformers/test/fixtures/bug-repro/<file>.tsx --no-run
  ```

The moment a shape compiles cleanly it stops belonging here — promote it to a
golden pair in the right suite so its lowering is pinned. (Example: the hoisted
remedy for the builder-arg computation diagnostic lives at
`../ast-transform/builder-arg-hoisted-nullish-selection.input.tsx`, while the
rejected inline form stays here as
`compute-wrap-shape3-builder-arg-nullish.tsx`, pinned by
`test/builder-argument-computation-diagnostic.test.ts`.)
