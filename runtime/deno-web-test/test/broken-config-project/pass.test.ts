// deno-lint-ignore-file cf-test/registration -- a fixture testing the browser harness's own `Deno.test`
// This test would pass under the defaults. It reports nothing, because the run
// ends while reading the config.
Deno.test("would-pass", function () {});
