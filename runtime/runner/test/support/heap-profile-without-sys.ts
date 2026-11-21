/**
 * Run without sys access to "inspector": starts heap sampling, which cannot
 * start, then asks for the thread's profile, and prints what each step gave.
 */

import {
  startHeapSampling,
  writeThreadHeapProfile,
} from "../../src/heap-profile.ts";

const [directory] = Deno.args;
await startHeapSampling();
console.log("started without rejecting");
try {
  await writeThreadHeapProfile(directory, "without-sys");
  console.log("wrote a profile");
} catch (error) {
  console.log(String(error));
}
