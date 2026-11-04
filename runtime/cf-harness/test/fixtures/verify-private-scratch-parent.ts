/**
 * Verifies the scratch parent named by the first argument and prints
 * `verified`, for a test that runs it under the permissions it chooses.
 */

import { verifyPrivateScratchParent } from "../../src/sandbox/runsc.ts";

await verifyPrivateScratchParent(Deno.args[0]!);
console.log("verified");
