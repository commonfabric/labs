// A test whose conflict retry can only ride the read-repair backstop. Not a
// `.test.ts` file: the package task never selects it. The guard's pin
// (`test/silent-backstop-guard.test.ts`) runs it in a subprocess under the
// package preload and expects it to FAIL — that failure is the whole point of
// this file. The ride itself lives in
// `conflict-read-repair-backstop-scenario.ts`, shared with the reset fixture.

import { rideReadRepairBackstop } from "./conflict-read-repair-backstop-scenario.ts";

Deno.test(
  "a conflict retry that only the backstop can release",
  rideReadRepairBackstop,
);
