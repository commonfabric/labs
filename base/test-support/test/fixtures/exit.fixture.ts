// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case. Deno makes an `unload` event as a
// test calls `Deno.exit()`, fails that test, goes on to the next, and makes
// another as the file ends.

import { afterAll, beforeAll, test } from "../../src/testing.ts";

beforeAll(() => {});
test("exits", () => {
  Deno.exit(0);
});
if (Deno.env.get("FIXTURE_CASE") === "rejects") {
  test("rejects without awaiting", () => {
    Promise.reject(new Error("nobody awaited this"));
  });
} else {
  test("passes", () => {});
}
afterAll(() => {});
