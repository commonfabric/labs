# @commonfabric/static

This is a package that abstracts away handling of lazy-loaded static assets in
both our Deno and browser environments. In Deno, the assets are loaded from
disk, and in browsers, rely on the host (`toolshed`) to serve assets at a
well-known route (`/static/*`).

## Type library maintenance

The dependency guide owns the TypeScript checkout prerequisite, compiler-roll
checks, and regeneration command for the vendored type libraries. See
[the vendored type libraries](../../docs/development/DEPENDENCIES.md#the-vendored-type-libraries).

## Generated type modules

Two of the files under `assets/types/` are built from workspace sources rather
than authored in place. Generating them puts a "do not edit by hand" line at the
top of what a reader opens, and lets a module reach declarations that live in
other packages: the pattern compiler serves each module as a single
self-contained text, so anything a module takes from elsewhere has to arrive as
text in the generated file.

- `commonfabric.d.ts` is generated from `packages/api/index.ts` by
  `scripts/generate-commonfabric-types.ts`. Regenerate it with
  `deno task gen-commonfabric-types`, and `deno task check-commonfabric-types`
  fails when the checked-in copy is stale.
- `cfc.ts` is generated from `packages/api/cfc-authoring.ts` by
  `scripts/generate-cfc-types.ts`, flattened to a declaration-only module.
  Regenerate it with `deno task gen-cfc-types`, and `deno task check-cfc-types`
  fails when the checked-in copy is stale.

Both checks run in CI, and `scripts/generated-asset.ts` holds the command line
the two scripts share. The remaining sources under `assets/types/` are the
vendored type libraries, `turndown.d.ts`, and two symlinks:
`commonfabric-schema.d.ts` into `packages/api` and `jsx.d.ts` into
`packages/html`.

## Withheld globals

`assets/types/es2023.d.ts` and `assets/types/dom.d.ts` describe the sandbox
patterns run in, not stock TypeScript. A global that the SES compartment does
not install has its declaration removed from them, so a pattern that reaches for
it fails to compile rather than throwing a `TypeError` once deployed. The names
live in `SANDBOX_WITHHELD_GLOBALS` (`packages/utils/src/sandbox-contract.ts`).

`compile-types` applies this on the way out, so a regenerated `es2023.d.ts`
already has them removed. After changing the list, run:

    deno task strip-withheld-globals

`deno task check-withheld-globals` fails when a checked-in library still
declares a withheld global, and
`packages/runner/test/sandbox-global-contract.test.ts` checks the libraries and
a real compartment against each other in both directions.

That test requires zero gaps: every global the compiler declares must be one the
compartment installs. A newly declared global that the compartment lacks fails
the test until it is endowed or added to the withheld list.

### Checks that run only in CI

Two things depend on this list that neither `deno task cfcheck` nor
`deno task check` catches, so a change that passes both locally can still fail
in CI:

- The `packages/ts-transformers` and `packages/schema-generator` fixture suites
  type-check their fixture inputs against the pattern type libraries, so a
  fixture that uses a now-withheld global stops compiling. `deno task cfcheck`
  only checks `packages/patterns`, and `deno task check` type-checks source;
  neither compiles those fixtures. After changing the withheld list or the type
  libraries, run `deno task test` in both packages, and regenerate the
  transformer goldens with `UPDATE_GOLDENS=1` (see
  `packages/ts-transformers/AGENTS.md`).
- The coverage gate holds `packages/static`'s measured set, its `deno-test`
  half, to its baseline on a pull request that changes the package and reaches
  at most two measured sets. New code under `scripts/` needs matching tests, or
  it fails the gate. Neither `cfcheck` nor `deno task check` measures coverage.
