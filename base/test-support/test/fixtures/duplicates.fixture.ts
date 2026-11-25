// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case. A refusal is caught and logged,
// so the file goes on to end as any other does.

import { describe, it, test } from "../../src/testing.ts";

const scenario = Deno.env.get("FIXTURE_CASE");

/** Runs `register`, logging what it was refused with. */
function refused(register: () => void): void {
  try {
    register();
  } catch (error) {
    console.log(`LOG refused: ${(error as Error).message}`);
  }
}

if (scenario === "groups") {
  describe("group", () => {
    it("first", () => {});
  });
  refused(() =>
    describe("group", () => {
      it("second", () => {});
    })
  );
} else if (scenario === "separator") {
  refused(() => test("a > b", () => {}));
} else if (scenario === "step") {
  test("runs steps", async (t) => {
    await t.step("again", () => {});
    await t.step("again", () => {});
  });
} else {
  describe("group", () => {
    it("again", () => {});
    refused(() => it("again", () => {}));
  });
}
