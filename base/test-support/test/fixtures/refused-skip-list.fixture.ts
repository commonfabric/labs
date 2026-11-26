// Run by `../registration.test.ts` as a test file of its own, with a skip
// list that is not one. The test module refuses it as it loads, so this file
// loads the module itself and logs the refusal.

try {
  // deno-lint-ignore cf-imports/no-inline-module-import -- the module refuses the list as it loads, which only a deferred load can catch
  await import("../../src/testing.ts");
} catch (error) {
  console.log(`LOG refused: ${(error as Error).message}`);
}
