// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case.

import { describe, it, test } from "../../src/testing.ts";

const scenario = Deno.env.get("FIXTURE_CASE");

if (scenario === "groups") {
  describe("group", () => {
    it("first", () => {});
  });
  describe("group", () => {
    it("second", () => {});
  });
} else if (scenario === "separator") {
  test("a > b", () => {});
} else if (scenario === "step") {
  test("runs steps", async (t) => {
    await t.step("again", () => {});
    await t.step("again", () => {});
  });
} else {
  describe("group", () => {
    it("again", () => {});
    it("again", () => {});
  });
}
