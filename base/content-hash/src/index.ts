/**
 * Shared SHA-256 hashing module. Provides both an all-at-once function
 * and an incremental hasher factory, using the best available
 * implementation for the current environment.
 *
 * Priority:
 * 1. `node:crypto` (Deno/server) -- hardware-accelerated via OpenSSL
 * 2. `hash-wasm` (browser) -- WASM, about twice the speed of the fallback
 * 3. `@noble/hashes` (fallback) -- pure JS
 */

import type { DigestFn, IncrementalHasher } from "@/interface.ts";
import { canUseDeno, createHasherDeno, sha256Deno } from "@/sha256-deno.ts";
import { createHasherNoble, sha256Noble } from "@/sha256-noble.ts";
import { createHasherWasm, initWasm, sha256Wasm } from "@/sha256-wasm.ts";

export type { DigestFn, IncrementalHasher } from "@/interface.ts";

let sha256: DigestFn;
let createHasher: () => IncrementalHasher;

if (canUseDeno()) {
  // The Deno implementation is available.
  sha256 = sha256Deno;
  createHasher = createHasherDeno;
} else if (await initWasm()) {
  // The `hash-wasm` implementation is available.
  sha256 = sha256Wasm;
  createHasher = createHasherWasm;
} else {
  // Final fallback: Use the Noble implementation.
  sha256 = sha256Noble;
  createHasher = createHasherNoble;
}

/** All-at-once SHA-256 hash. */
export { sha256 };

/** Creates a new incremental SHA-256 hasher. */
export { createHasher };
