/**
 * Selection of the SHA-256 implementation to use, from what the current
 * environment offers.
 */

import type { Implementation } from "@/interface.ts";
import { createHasherNoble, sha256Noble } from "@/sha256-noble.ts";
import { createHasherWasm, sha256Wasm } from "@/sha256-wasm.ts";

/**
 * Returns the best implementation available, in order of preference:
 *
 * 1. `deno`, over `node:crypto` (Deno/server), where it is not `null` --
 *    hardware-accelerated via OpenSSL, with `hash-wasm` for inputs short
 *    enough that a `node:crypto` hasher's fixed cost outweighs WASM's slower
 *    rounds.
 * 2. `hash-wasm` (browser), where `initWasm()` succeeds -- WASM, about twice
 *    the speed of the fallback.
 * 3. `@noble/hashes` (fallback) -- pure JS.
 */
export async function chooseImplementation(
  deno: Implementation | null,
  initWasm: () => Promise<boolean>,
): Promise<Implementation> {
  if (deno) return deno;
  if (await initWasm()) {
    return { sha256: sha256Wasm, createHasher: createHasherWasm };
  }
  return { sha256: sha256Noble, createHasher: createHasherNoble };
}
