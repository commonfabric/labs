// A test whose body both rides the read-repair backstop AND fails its own
// assertion. The guard must surface both: its own message leads, the appended
// "The test body failed as well." line appears, and the body's error rides as
// the cause. Not a `.test.ts` file: the package task never selects it; the
// guard's pin (`test/silent-backstop-guard.test.ts`) runs it in a subprocess
// under the package preload and expects it to FAIL, exercising the guard's
// failing-body path. The ride is shared through
// `conflict-read-repair-backstop-scenario.ts`.

import { expect } from "@std/expect";
import { rideReadRepairBackstop } from "./conflict-read-repair-backstop-scenario.ts";

Deno.test("a body that rides the backstop and also fails its assertion", async () => {
  await rideReadRepairBackstop();
  expect(true, "the body's own assertion, deliberately failing").toBe(false);
});
