/**
 * Helper for `collected-memory.test.ts`. Runs in a process of its own, which
 * never exposes the collector, and prints what `collectedMemory()` throws there.
 */

import { collectedMemory } from "../src/collected-memory.ts";

try {
  collectedMemory();
  console.log("collected");
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
