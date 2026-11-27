// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case.

import { test } from "../../src/testing.ts";

if (Deno.env.get("FIXTURE_CASE") === "step") {
  test("runs a step", async (t) => {
    await t.step({
      name: "checks for leaks",
      sanitizeResources: true,
      fn: () => {},
    });
  });
} else {
  test("checks for leaks", { sanitizeResources: true }, () => {});
}
