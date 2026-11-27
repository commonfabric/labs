// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case.

import { describe, it, test, wrapSuites } from "../../src/testing.ts";

const scenario = Deno.env.get("FIXTURE_CASE");

if (scenario === "skips") {
  wrapSuites(async () => {});
} else if (scenario === "swallows") {
  wrapSuites(async (run) => {
    try {
      await run();
    } catch {
      // A wrapper that hides what its suite threw.
    }
  });
  test("throws", () => {
    throw new Error("the test threw");
  });
} else {
  wrapSuites(async (run) => {
    await run();
    throw new Error("the wrapper found something wrong");
  });
}

describe("wrapped", () => {
  it("passes inside", () => {});
});

test("alone", () => {});
