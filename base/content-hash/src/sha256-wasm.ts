/** WASM version of SHA256. */

import { createSHA256, type IHasher } from "hash-wasm";
import {
  BaseSmallChunkUpdatingHasher,
} from "@/BaseSmallChunkUpdatingHasher.ts";
import type { IncrementalHasher } from "@/interface.ts";

/** How many hashers to have available for concurrent use. */
const HASHER_POOL_SIZE = 5;

/**
 * Pool of usable hasher instances. This is populated at module init time, a
 * tactic that is necessary since this module exposes a synchronous interface
 * for actual hashing (once loaded), whereas `hash-wasm` only allows
 * asynchronous hasher construction. Once constructed, though, hashers can be
 * used synchronously.
 */
const hasherPool: IHasher[] = [];

/**
 * Returns a hasher to the pool once its owner is collected, for owners that
 * never released it.
 */
const hasherRepooler = new FinalizationRegistry((hasher: IHasher) => {
  if (!hasherPool.includes(hasher)) {
    hasherPool.push(hasher);
  }
});

/**
 * Takes an initialized hasher out of the pool, or returns `undefined` if the
 * pool is empty.
 */
function takeHasher(): IHasher | undefined {
  const hasher = hasherPool.pop();
  hasher?.init();
  return hasher;
}

/**
 * Records `owner` as the holder of `hasher`, so that the hasher returns to the
 * pool if `owner` is collected without releasing it.
 */
function holdHasher(owner: WeakKey, hasher: IHasher) {
  hasherRepooler.register(owner, hasher, hasher);
}

/** Returns a hasher taken by `takeHasher()` to the pool. */
function releaseHasher(hasher: IHasher) {
  hasherRepooler.unregister(hasher);
  hasherPool.push(hasher);
}

/**
 * The one-shot hasher instance, _not_ allowed to be acquired for concurrent
 * use. Used to serve one-shot hash requests.
 */
const theOneShotHasher: IHasher[] = [];

/**
 * Promised result of the call to `initIfNecessaryAndPossible()` or `null` if
 * not yet called.
 */
let initResult: Promise<boolean> | null = null;

/** Whether this module is actually usable. */
let moduleIsUsable: boolean = false;

/** Gets and initializes the unique one-shot hasher instance. */
function getOneShotHasher(): IHasher {
  const result = theOneShotHasher[0]!;
  result.init();
  return result;
}

/**
 * Throws an error indicating that this module is not usable, if it is not in
 * fact usable. Otherwise, does nothing.
 */
function assertUsable() {
  if (!moduleIsUsable) {
    throw new Error("Cannot use `sha256-wasm` in this environment.");
  }
}

/**
 * WASM-specific incremental hasher for when the pool is empty. It has no
 * hasher of its own, so it keeps the data until `digest()` and then feeds it
 * all to the one-shot hasher. The base class coalesces small `update()`s, and
 * hands over a buffer it reuses, so each one is copied on the way in.
 */
class WasmCollectingHasher extends BaseSmallChunkUpdatingHasher {
  #chunks: Uint8Array[] = [];

  /** @inheritDoc */
  protected _rawUpdate(data: Uint8Array) {
    this.#chunks.push(data.slice());
  }

  /** @inheritDoc */
  protected _rawDigest(_encoding: string | undefined): Uint8Array {
    const hasher = getOneShotHasher();

    for (const chunk of this.#chunks) {
      hasher.update(chunk);
    }

    return hasher.digest("binary");
  }
}

/**
 * WASM-specific incremental hasher which has a direct hasher instance and
 * can `update()` it.
 */
class WasmUpdatingHasher extends BaseSmallChunkUpdatingHasher {
  #hasher: IHasher;

  /**
   * Constructs an instance which hashes into `hasher`, taking over
   * responsibility for returning it to the pool.
   */
  constructor(hasher: IHasher) {
    super();
    this.#hasher = hasher;
    holdHasher(this, hasher);
  }

  /** @inheritDoc */
  protected _rawUpdate(data: Uint8Array) {
    this.#hasher.update(data);
  }

  /** @inheritDoc */
  protected _rawDigest(_encoding: string | undefined): Uint8Array {
    const hasher = this.#hasher;
    const result: Uint8Array = hasher.digest("binary");

    releaseHasher(hasher);
    return result;
  }
}

/**
 * Performs module-level setup if (a) possible and (b) not already done.
 * Returns (a promise to) `true` if initialization was successful, `false`
 * if not.
 */
export function initWasm() {
  if (!initResult) {
    initResult = (async () => {
      try {
        theOneShotHasher.push(await createSHA256());
        for (let i = 0; i < HASHER_POOL_SIZE; i++) {
          hasherPool.push(await createSHA256());
        }
        moduleIsUsable = true;
      } catch {
        // `hash-wasm` not available, or couldn't be fully initialized.
      }

      return moduleIsUsable;
    })();
  }

  return initResult;
}

/** Performs a hash on a single array. */
export function sha256Wasm(payload: Uint8Array): Uint8Array {
  assertUsable();
  const hasher = getOneShotHasher();

  hasher.update(payload);
  return hasher.digest("binary");
}

/** Creates an incremental hasher. */
export function createHasherWasm(): IncrementalHasher {
  assertUsable();
  const hasher = takeHasher();
  return hasher ? new WasmUpdatingHasher(hasher) : new WasmCollectingHasher();
}

/**
 * Creates a collecting incremental hasher, that is, the variant used when the
 * pool is empty. Exported so that it can be exercised directly, which
 * `createHasherWasm()` cannot be made to do on demand.
 */
export function createHasherWasmCollecting(): IncrementalHasher {
  assertUsable();
  return new WasmCollectingHasher();
}
