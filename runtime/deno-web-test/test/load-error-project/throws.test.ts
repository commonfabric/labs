Deno.test("registered before the throw", function () {});

throw new Error("this file fails as it loads");
