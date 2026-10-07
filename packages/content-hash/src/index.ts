/**
 * Shared SHA-256 hashing module. Provides an all-at-once function, an
 * incremental hasher factory, and HMAC-SHA-256 over the former, using the best
 * available implementation for the current environment.
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

/** The block size of SHA-256, in bytes. */
const BLOCK_SIZE = 64;

/**
 * Returns HMAC-SHA-256 of `message` under `key` (RFC 2104), computed with
 * `sha256()`. A key longer than one block is hashed first, as the RFC
 * requires.
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  block.set(key.length > BLOCK_SIZE ? sha256(key) : key);
  const inner = new Uint8Array(BLOCK_SIZE + message.length);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, BLOCK_SIZE);
  outer.set(sha256(inner), BLOCK_SIZE);
  return sha256(outer);
}
