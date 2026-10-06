/**
 * Writes `fixtures/fvj1-conformance.json` from the conformance cases, by way
 * of `deno task regenerate-fvj1-conformance`. `fvj1-conformance.test.ts` fails
 * whenever the committed file differs from what this writes.
 */

import {
  FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  fvj1ConformanceFixtureTextForTestingOnly,
} from "@/for-testing-only.ts";

await Deno.writeTextFile(
  new URL("./fixtures/fvj1-conformance.json", import.meta.url),
  fvj1ConformanceFixtureTextForTestingOnly(
    FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  ),
);
