import { BaseIncrementalHasher } from "@/BaseIncrementalHasher.ts";

/** Size of the small-data buffer. */
const SMALLS_SIZE = 4096;

/** Most buffers `smallsPool` keeps. */
const SMALLS_POOL_MAX = 8;

/**
 * Small-data buffers no instance holds, for the next instance that needs one to
 * take rather than allocate. Nothing in one needs clearing: an instance tracks
 * how much of its buffer is in use.
 */
const smallsPool: Uint8Array[] = [];

/**
 * Base implementation of an `IncrementalHasher` which ephemerally collects
 * small-size `update()`s to pass along to an underlying `update()` which also
 * gets called directly for larger-size chunks.
 *
 * Using this base class is a win if (a) multiple small-size updates are common,
 * and (b) a small amount of extra byte copying wins over direct calls to the
 * underlying hasher's `update()`.
 *
 * The buffer small updates collect in is taken from a shared pool on the first
 * small update and given back by `digest()`, so an instance used "one-shot"
 * allocates nothing for it, and one that is never digested holds its buffer
 * only as long as it lives.
 */
export abstract class BaseSmallChunkUpdatingHasher
  extends BaseIncrementalHasher {
  /** The buffer small updates collect in, while this instance holds one. */
  #smallsBuf: Uint8Array | null = null;

  /** How many bytes of `#smalls` are pending. */
  #smallsOffset: number = 0;

  /** @inheritDoc */
  override digest(): Uint8Array;
  override digest(encoding: "base64url"): string;
  override digest(encoding: string | undefined): Uint8Array | string;
  override digest(encoding?: string | undefined): Uint8Array | string {
    this.#updateFromSmalls();
    const result = super.digest(encoding);
    this.#releaseSmalls();
    return result;
  }

  /** @inheritDoc */
  override update(data: Uint8Array) {
    // The small-data path below returns without reaching `super.update()`,
    // which is where the finalized-state check otherwise happens.
    this._throwIfDone();

    const length = data.length;

    if (length <= SMALLS_SIZE) {
      const smallsOffset = this.#smallsOffset;

      if (length <= (SMALLS_SIZE - smallsOffset)) {
        // The given `data` fits in the space available in `#smalls`.
        this.#smalls.set(data, smallsOffset);
        this.#smallsOffset += length;
        return;
      }
    }

    // `data` is too big to fit in the available `#smalls` space (even if it
    // would have fit if `#smalls` were emptier).

    this.#updateFromSmalls();
    super.update(data);
  }

  /**
   * The buffer small updates collect in. If this instance holds none, it first
   * takes one from `smallsPool`, or allocates one if the pool is empty.
   */
  get #smalls(): Uint8Array {
    let smalls = this.#smallsBuf;

    if (smalls === null) {
      smalls = smallsPool.pop() ?? new Uint8Array(SMALLS_SIZE);
      this.#smallsBuf = smalls;
    }

    return smalls;
  }

  /** Gives the buffer this instance holds, if any, back to `smallsPool`. */
  #releaseSmalls() {
    const smalls = this.#smallsBuf;

    if (smalls !== null) {
      this.#smallsBuf = null;
      if (smallsPool.length < SMALLS_POOL_MAX) {
        smallsPool.push(smalls);
      }
    }
  }

  /**
   * Helper for `digest()` and `update()`, which flushes any pending
   * small-update bytes to the underlying `_rawUpdate()`.
   */
  #updateFromSmalls() {
    const smallsOffset = this.#smallsOffset;

    if (smallsOffset === 0) {
      return;
    }

    const smalls = this.#smalls;
    const smallsFinal = (smallsOffset === smalls.length)
      ? smalls
      : smalls.subarray(0, smallsOffset);

    this._rawUpdate(smallsFinal);
    this.#smallsOffset = 0;
  }
}
