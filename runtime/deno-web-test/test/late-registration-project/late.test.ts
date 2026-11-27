// deno-lint-ignore-file cf-test/registration -- a fixture testing the browser harness's own `Deno.test`
Deno.test("registers another", function () {
  Deno.test("registered while a test ran", function () {});
});
