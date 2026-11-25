// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case.

import { test } from "../../src/testing.ts";

const scenario = Deno.env.get("FIXTURE_CASE");

/** A step body that settles only after the test that started it. */
const slowly = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

if (scenario === "throws") {
  test("throws with a step running", (t) => {
    t.step("never awaited", slowly);
    throw new Error("the test threw");
  });
} else if (scenario === "orphan") {
  test("leaves a step behind", (t) => {
    t.step("slow", slowly);
  });
  test("rejects while it settles", async () => {
    Promise.reject(new Error("this test left this"));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
} else if (scenario === "skipped") {
  test("skips every step", async (t) => {
    await t.step({ name: "skipped", ignore: true, fn: () => {} });
  });
} else if (scenario === "together") {
  test("runs two steps at once", async (t) => {
    await Promise.all([t.step("slow", slowly), t.step("fast", () => {})]);
  });
} else {
  test("leaves a step running", (t) => {
    t.step("never awaited", slowly);
  });
}
