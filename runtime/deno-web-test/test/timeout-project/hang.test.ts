import { hang } from "./mod.ts";

Deno.test("before-hang", function () {});

Deno.test("hangs-forever", async function () {
  await hang();
});

Deno.test("after-hang", function () {});
