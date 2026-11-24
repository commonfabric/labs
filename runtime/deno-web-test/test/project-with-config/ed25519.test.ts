import { createEd25519Key } from "./mod.ts";

Deno.test("create ed25519 key", async function () {
  // We test that console log is propagated to test runner,
  // so this console log is load bearing.
  console.log("LOG FROM TEST");

  // This will fail in Chrome unless experimental web feature
  // flag was set.
  await createEd25519Key();
});
