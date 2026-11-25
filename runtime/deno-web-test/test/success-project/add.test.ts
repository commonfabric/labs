// deno-lint-ignore-file cf-test/registration -- a fixture testing the browser harness's own `Deno.test`
import { assert } from "@std/assert";

import { add } from "./mod.ts";

Deno.test("add-sync", function () {
  assert(add(5, 10) === 15, "add(5, 10) should equal 15");
});

Deno.test("add-async", async function () {
  await Promise.resolve();
  assert(add(1, 2) === 3, "add(1, 2) should equal 3");
});
