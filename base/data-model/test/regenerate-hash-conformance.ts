/**
 * Writes `fixtures/hash-conformance.json` from the conformance cases, by way
 * of `deno task regenerate-hash-conformance`. `hash-conformance.test.ts` fails
 * whenever the committed file differs from what this writes.
 */

import {
  HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  hashConformanceFixtureTextForTestingOnly,
} from "@/for-testing-only.ts";

await Deno.writeTextFile(
  new URL("./fixtures/hash-conformance.json", import.meta.url),
  hashConformanceFixtureTextForTestingOnly(
    HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  ),
);
