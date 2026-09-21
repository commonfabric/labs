import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { currentCompilerFingerprint } from "./compile-cache-key.ts";
import { VERSION_NAMESPACE } from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { getCompileCacheRuntimeVersion } from "../packages/runner/src/compilation-cache/cell-cache.ts";

describe("compile-cache-key", () => {
  // Walking and hashing the fingerprint inputs reads on the order of a
  // thousand files, so the value is resolved once for both cases.
  let fingerprint: string;

  beforeAll(async () => {
    fingerprint = await currentCompilerFingerprint();
  });

  it("returns the fingerprint the runtime resolves its compile cache under", async () => {
    // CI names a compile byte cache entry by this value, and the runtime reads
    // compiled documents back under `compileCache:<version>/<identity>`. The
    // comparison is against the runtime's own resolution rather than against a
    // fresh computation, because that resolution is what a running binary
    // follows: a baked literal in `compile-cache-version.ts` left behind by a
    // build would answer here and would not match this fingerprint. Were the
    // two to part, a restored entry would be one the runtime never looks for,
    // and the cache would silently stop doing anything.

    expect(await getCompileCacheRuntimeVersion()).toBe(
      `${VERSION_NAMESPACE}/${fingerprint}`,
    );
  });

  it("returns a value every character of which is safe in a cache key", () => {
    // The workflow interpolates it into a key with no quoting or escaping
    // around it.

    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
