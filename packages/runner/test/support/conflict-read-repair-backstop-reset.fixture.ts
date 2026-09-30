// A BDD suite whose first `it` rides the read-repair backstop and whose second
// `it` resets the logger counters. The guard wraps a whole `describe` as one
// `Deno.test`, so a guard that read the logger's own count would see it zeroed
// by the reset before the wrapper ran, and the ride would pass silently. The
// guard records firings in a store the reset cannot reach, so this suite still
// fails. Not a `.test.ts` file: the package task never selects it; the guard's
// pin (`test/silent-backstop-guard.test.ts`) runs it in a subprocess under the
// package preload and expects it to FAIL. The ride is shared with the base
// fixture through `conflict-read-repair-backstop-scenario.ts`.

import { describe, it } from "@std/testing/bdd";
import { resetAllLoggerCounts } from "@commonfabric/utils/logger";
import { rideReadRepairBackstop } from "./conflict-read-repair-backstop-scenario.ts";

describe("a backstop firing survives a later logger reset", () => {
  it("rides the read-repair backstop", rideReadRepairBackstop);

  it("resets the logger counters the guard once read", () => {
    // The old guard read `storage.v2`'s resettable count; this would erase the
    // ride above before the wrapper checked. The firing store is untouched.
    resetAllLoggerCounts();
  });
});
