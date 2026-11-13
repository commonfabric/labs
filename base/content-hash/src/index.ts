/**
 * Shared SHA-256 hashing module. Provides both an all-at-once function
 * and an incremental hasher factory, using the best available
 * implementation for the current environment, as `chooseImplementation()`
 * decides.
 */

import { chooseImplementation } from "@/implementation.ts";
import { canUseDeno } from "@/sha256-deno.ts";
import { initWasm } from "@/sha256-wasm.ts";

export type { DigestFn, IncrementalHasher } from "@/interface.ts";

const { sha256, createHasher } = await chooseImplementation(
  canUseDeno,
  initWasm,
);

/** All-at-once SHA-256 hash. */
export { sha256 };

/** Creates a new incremental SHA-256 hasher. */
export { createHasher };
