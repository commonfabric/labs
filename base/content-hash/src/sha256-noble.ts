/** Noble version of SHA256. */

import { sha256 } from "@noble/hashes/sha2.js";
import type { IncrementalHasher } from "@/interface.ts";
import {
  BaseSmallChunkUpdatingHasher,
} from "@/BaseSmallChunkUpdatingHasher.ts";

/**
 * Noble-specific incremental hasher. Noble notably only has a one-shot digest
 * function.
 */
class NobleHasher extends BaseSmallChunkUpdatingHasher {
  #hasher = sha256.create();

  /** @inheritDoc */
  protected _rawUpdate(data: Uint8Array) {
    this.#hasher.update(data);
  }

  /** @inheritDoc */
  protected _rawDigest(_encoding: string | undefined): Uint8Array {
    return this.#hasher.digest();
  }
}

/** Creates an incremental hasher. */
export function createHasherNoble(): IncrementalHasher {
  return new NobleHasher();
}

/** Performs a hash on a single array. */
export function sha256Noble(payload: Uint8Array): Uint8Array {
  // Note: This whole function isn't just a re-`export` of `sha256()` from
  // Noble, because that `sha256()` has additional properties which we don't
  // want to expose as part of this module's interface.
  return sha256(payload);
}
