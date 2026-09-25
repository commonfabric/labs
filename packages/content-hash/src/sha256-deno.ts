/** Deno version of SHA256. */

import { backtickQuote } from "@commonfabric/utils/markdown";
import { isDeno } from "@commonfabric/utils/env";
import type { IncrementalHasher } from "@/interface.ts";
import {
  BaseSmallChunkUpdatingHasher,
} from "@/BaseSmallChunkUpdatingHasher.ts";

// Can't `import` at the top, because then `import`ing this module would fail
// in a non-Deno environment.
let crypto: { createHash: (algorithm: string) => any } | null = null;

if (isDeno()) {
  try {
    // deno-lint-ignore cf-imports/no-inline-module-import
    crypto = await import("node:crypto");
  } catch {
    // We're not in a Deno environment.
  }
}

/**
 * Throws an error indicating that this module is not usable, if it is not in
 * fact usable. Otherwise, does nothing.
 */
function assertUsable() {
  if (crypto === null) {
    throw new Error("Cannot use `sha256-deno` in this environment.");
  }
}

/**
 * Deno-specific incremental hasher. Small updates are collected before they
 * reach `node:crypto`, where each `update()` call costs enough to dominate a
 * hash fed as many short chunks.
 */
class DenoHasher extends BaseSmallChunkUpdatingHasher {
  #hasher = crypto!.createHash("sha256");

  /** @inheritDoc */
  protected _rawUpdate(data: Uint8Array) {
    this.#hasher.update(data);
  }

  /** @inheritDoc */
  protected _rawDigest(encoding: string | undefined): Uint8Array | string {
    switch (encoding) {
      case "base64url": {
        return this.#hasher.digest(encoding);
      }
      case undefined: {
        // `node:crypto`'s `digest()` returns `Buffer`; normalize to plain
        // `Uint8Array`.
        const buf = this.#hasher.digest();
        return new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        );
      }
      default: {
        throw new Error(`Unknown encoding: ${backtickQuote(encoding)}`);
      }
    }
  }
}

/** Indicates whether this module is usable. */
export function canUseDeno() {
  return crypto !== null;
}

/** Performs a hash on a single array. */
export function sha256Deno(payload: Uint8Array): Uint8Array {
  assertUsable();

  // `node:crypto digest()` returns a `Buffer` (a `Uint8Array` subclass);
  // normalize it to plain `Uint8Array`, so downstream equality checks work
  // correctly.
  const buf = crypto!.createHash("sha256").update(payload).digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Creates an incremental hasher. */
export function createHasherDeno(): IncrementalHasher {
  assertUsable();
  return new DenoHasher();
}
