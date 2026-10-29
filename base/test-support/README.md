# @commonfabric/test-support

Shared testing infrastructure for Common Fabric packages. This package exports
helpers that tests can reuse without duplicating setup code.

## Usage

```ts
import { defineFixtureSuite } from "@commonfabric/test-support/fixture-runner";

await defineFixtureSuite({
  suiteName: "Schema fixtures",
  rootDir: "./test/fixtures/schema",
  expectedPath: (fixture) => `${fixture.stem}.expected.json`,
  async execute(fixture) {
    // run transformer and return normalized JSON
  },
  async loadExpected(fixture) {
    const text = await Deno.readTextFile(fixture.expectedPath);
    return JSON.parse(text);
  },
  compare(actual, expected) {
    expect(actual).toEqual(expected);
  },
});
```

The package also exports a compiled-module-byte cache helper for integration
tests that build `Runtime` or `PiecesController` instances. It keeps an
in-memory cache in every run and writes a disk snapshot when
`CF_COMPILE_CACHE_FILE` is set.

The configuration API is flexible enough to handle text-based outputs,
structured comparisons, per-suite warmup hooks, grouped fixture descriptions,
and golden updates controlled via the `UPDATE_GOLDENS` environment variable.

For additional examples see `base/schema-generator/test/fixtures-runner.test.ts`
and `base/ts-transformers/test/fixture-based.test.ts`.
