import { backtickQuote } from "@commonfabric/utils/markdown";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "@/interface.ts";

/**
 * Base implementation for the `IncrementalHasher` interface. This takes
 * care of:
 *
 * * Disallowing use of an instance after `digest()`.
 * * Converting an array result of `_rawDigest()` into a string when so
 *   requested.
 */
export abstract class BaseIncrementalHasher implements IncrementalHasher {
  #done: boolean = false;

  //
  // Subclass contract
  //

  /**
   * Passes data to the underlying hash implementation. Called by the base
   * class when there is data to be hashed. `data` must not be retained past
   * the call: it can be a buffer the base class reuses, as well as one owned
   * by the original caller. An implementation that needs to keep the bytes
   * must copy them.
   */
  protected abstract _rawUpdate(data: Uint8Array): void;

  /**
   * Performs a digest operation using the underlying hash implementation.
   * Called by the base class. May ignore the `encoding` and always return a
   * `Uint8Array`. An array result becomes `digest()`'s return value directly,
   * so it must be freshly allocated and unshared -- never a window onto WASM
   * memory, a pooled allocation, or anything else that outlives the call.
   */
  protected abstract _rawDigest(
    encoding: string | undefined,
  ): Uint8Array | string;

  //
  // Instance members
  //

  /** @inheritDoc */
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding: string | undefined): Uint8Array | string;
  digest(encoding?: string | undefined): Uint8Array | string {
    this._throwIfDone();

    const result = this._rawDigest(encoding);
    this.#done = true;

    if (typeof result === "string") {
      // `_rawDigest()` handles encoding.
      return result;
    }

    switch (encoding) {
      case "base64url": {
        return toUnpaddedBase64url(result);
      }
      case undefined: {
        return result;
      }
      default: {
        throw new Error(`Unknown encoding: ${backtickQuote(encoding)}`);
      }
    }
  }

  /** @inheritDoc */
  update(data: Uint8Array) {
    this._throwIfDone();
    this._rawUpdate(data);
  }

  /**
   * Throws if this instance has already been finalized via `digest()`.
   * Subclasses that override `update()` must call this before accepting data.
   */
  protected _throwIfDone() {
    if (this.#done) {
      throw new Error("Cannot use instance: `digest()` already done.");
    }
  }
}
