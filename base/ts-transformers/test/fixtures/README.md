# Fixture Tests

Golden/snapshot tests for the TypeScript compiler transforms. Each test is a
pair of files:

- **`<name>.input.tsx`** — Source code a pattern author would write.
- **`<name>.expected.jsx`** — What the compiler should produce after
  transformation. The test runner transforms the input and compares the output
  character-for-character against this file.

## How it works

1. The test runner (`fixture-based.test.ts`) discovers all `.input.tsx` files
   under each subdirectory.
2. For each input, it looks for a matching `.expected.jsx` (or `.expected.js`)
   file.
3. It runs the full compiler transform pipeline on the input.
4. It compares the output against the expected file — exact string match.
5. If `UPDATE_GOLDENS=1` is set, it overwrites the expected file with the
   actual output instead of comparing.

## Directories

| Directory | What it tests |
|---|---|
| `closures/` | Closure extraction: map/filter/flatMap to WithPattern, computed (lift-applied), handler, action |
| `kitchensink/` | Deeply nested cross-feature regressions spanning closures, JSX, helper branches, and computed maps |
| `jsx-expressions/` | JSX expression handling: computed/lift-applied wrapping, conditionals, method chains |
| `schema-injection/` | Schema argument injection for new Cell, lift-applied computeds, lift, etc. |
| `schema-transform/` | Schema generation from TypeScript types |
| `handler-schema/` | Handler-specific schema generation |
| `ast-transform/` | General AST transforms: pattern schemas, builder patterns |

`bug-repro/` is not a suite: it holds `cf check`-runnable repros for
diagnostic-producing shapes, which cannot be golden pairs because the runner
fails any fixture whose transform reports an error. See `bug-repro/README.md`.

## Documenting test intent

Since these are golden tests, there's no explicit setup/execute/assert
structure. Instead, **comments in the input file** serve as test documentation:

```typescript
// FIXTURE: filter-basic
// Verifies: .filter() and .map() on reactive arrays are both transformed
//   .filter(fn) → .filterWithPattern(pattern(...), {})
//   .map(fn)    → .mapWithPattern(pattern(...), {})
// Context: No captured outer variables, basic chain
export default pattern<State>((state) => {
```

These comments carry through into the expected output (the compiler preserves
top-level comments), so they appear in both files.

Use this convention when adding or modifying fixtures:

- **What is being tested** — which transform behavior this fixture exercises.
- **Expected transform** — what the compiler should produce (method renames,
  wrapping, schema generation, etc.).
- **Key context** — captures, safe wrappers, negative tests, edge cases.

## Updating golden files

When you change the compiler and fixture outputs change:

```sh
UPDATE_GOLDENS=1 deno task test
```

Then review the diffs to confirm the changes are correct before committing.

## Skipping fixtures

Rename the input file to `.input.tsx.skip` to skip a fixture without deleting
it. Used for known issues or work-in-progress.
