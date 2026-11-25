// deno-lint-ignore-file cf-test/registration -- a fixture testing the browser harness's own `Deno.test`
import { hang } from "./mod.ts";

Deno.test("before-hang", function () {});

Deno.test("hangs-forever", async function () {
  await hang();
});

Deno.test("after-hang", function () {});
