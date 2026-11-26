# Unit Tests

Most `*.test.ts` files in this directory (and its subdirectories, e.g. `ast/`,
`policy/`, `closures/`) are ordinary unit tests: each drives a piece of the
transformer directly and asserts on what it returns or emits.

This is distinct from the golden/snapshot tests in `test/fixtures/` — see
[fixtures/README.md](fixtures/README.md) for that convention — and from the
one-shot investigation scripts in `test/diagnostics/` — see
[diagnostics/README.md](diagnostics/README.md).

## Two harnesses

**A. Drive an exported function directly.** Most `src/ast/*.ts` and
`src/policy/*.ts` modules export pure functions that take a `ts.Node` and a
`ts.TypeChecker`. Build a `ts.Program` from in-memory sources with
`createInMemoryProgram` from `utils.ts`, locate the node, call the function,
assert on the result. See `ast/call-kind.test.ts`, `ast/dataflow.test.ts`, and
`policy/capability-analysis.test.ts` for node-finding helpers.

**B. Drive the full pipeline.** `utils.ts` exports two entry points: a
`transformSource` function returning the transformed output string, and a
`validateSource` function returning the diagnostics and output together. Both
take a source string and a `types` option. Use these for diagnostic/validation
transformers and for whole-file transform behavior. `commonfabric-test-types.ts`
exports `COMMONFABRIC_TYPES`, the `commonfabric.d.ts`/`cfc.ts` type definitions
used by harness B and by any harness-A program that needs to resolve
`Cell`/`Reactive` branded types.

## Assert on structure, not printed text

A test that checks the compiler's output with a printed-text substring match
(e.g. `assertStringIncludes`) is weaker than it looks:

- The printer preserves authored comments, so a substring can be satisfied by a
  comment in the input rather than by anything the transformer emitted.
- If the expected substring already appears verbatim in the input, a transform
  that did nothing at all still passes.

`transformed-ast.ts` exists to close both gaps. It parses the transformer's
output back into a `ts.SourceFile` — parsing discards comments as trivia — and
exposes typed queries over the result:

- `collect`, `callsNamed`/`callsMatching`, `calleeName` — find emitted calls by
  name or pattern.
- `iifeCalls`, `isImmediatelyInvokedFunction` — find immediately-invoked
  function expressions (e.g. to check whether an authored IIFE survived a
  rewrite or was replaced).
- `hasKeyPathRead(root, segment, receiver?)` — check for the lowered
  `<receiver>.key("segment")` reactive path read.
- `forCauses(root)` — the evaluated first argument of every emitted
  `.for(cause, true)` stable-cause call.
- `literalToValue`, `emittedSchemas`, `patternSchemas`, `callSchemas` — evaluate
  an emitted `... as const satisfies ...JSONSchema` object literal (or a whole
  `pattern(cb, input, output)` / `handler(cb, event, state)` /
  `lift(cb, input, result)` call's schema arguments) into a real JS value, so a
  test can assert `schema.properties.name.type === "string"` instead of matching
  printed text.
- `extractedCallbackBody(root, variableName)` — isolate the body of an extracted
  callback (e.g. the hoisted `__cfPattern_1` map callback) for focused
  assertions.

Use these — or add a new query to `transformed-ast.ts` when a test needs one
that doesn't exist yet — for any assertion that inspects emitted code or an
emitted schema.

**The one legitimate exception is a diagnostic, error, or analyzer-reason
message.** There the message text _is_ the contract the test is pinning, not
incidental printed code, so a substring match against a diagnostic's message, a
caught error's `.message`, or an analyzer's returned reason string is the right
check and should stay a string match.
