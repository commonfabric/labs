// deno-lint-ignore-file cf-test/registration -- a fixture testing the browser harness's own `Deno.test`
Deno.test("registered before the throw", function () {});

throw new Error("this file fails as it loads");
