/**
 * Selection of the SHA-256 implementation to use, from what the current
 * environment offers.
 */

import type { DigestFn, IncrementalHasher } from "@/interface.ts";
import { createHasherDeno, sha256Deno } from "@/sha256-deno.ts";
import { createHasherNoble, sha256Noble } from "@/sha256-noble.ts";
import { createHasherWasm, sha256Wasm } from "@/sha256-wasm.ts";

/** One SHA-256 implementation's two entry points. */
export interface Implementation {
  /** All-at-once SHA-256 hash. */
  sha256: DigestFn;

  /** Creates a new incremental SHA-256 hasher. */
  createHasher: () => IncrementalHasher;
}

/**
 * Returns the best implementation available, in order of preference:
 *
 * 1. `node:crypto` (Deno/server), where `canUseDeno()` says it is usable --
 *    hardware-accelerated via OpenSSL, with `hash-wasm` for inputs short
 *    enough that a `node:crypto` hasher's fixed cost outweighs WASM's slower
 *    rounds.
 * 2. `hash-wasm` (browser), where `initWasm()` succeeds -- WASM, about twice
 *    the speed of the fallback.
 * 3. `@noble/hashes` (fallback) -- pure JS.
 */
export async function chooseImplementation(
  canUseDeno: () => boolean,
  initWasm: () => Promise<boolean>,
): Promise<Implementation> {
  if (canUseDeno()) {
    return { sha256: sha256Deno, createHasher: createHasherDeno };
  }
  if (await initWasm()) {
    return { sha256: sha256Wasm, createHasher: createHasherWasm };
  }
  return { sha256: sha256Noble, createHasher: createHasherNoble };
}
