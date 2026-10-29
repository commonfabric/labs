Deno.test("registers another", function () {
  Deno.test("registered while a test ran", function () {});
});
