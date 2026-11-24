/**
 * Type definitions for SHA-256 hashing: the incremental hasher interface, and
 * the all-at-once digest function type.
 */

/**
 * Incremental hasher. Feed data via `update()`, finalize with
 * `digest()`. A hasher must not be reused after `digest()` is called.
 */
export interface IncrementalHasher {
  /**
   * Feeds the given data into the hasher. Must not be called after
   * `digest()`. `data` is only read, never retained, so the caller keeps
   * ownership of it and may mutate or reuse it once this returns.
   */
  update(data: Uint8Array): void;

  /**
   * Finalizes the hash and returns the digest, as bytes or in a named string
   * encoding.
   *
   * The `Uint8Array` result is freshly allocated and unshared -- no part of it
   * is a window onto a buffer the hasher, its implementation, or any other
   * caller retains -- so the caller may mutate it, or cede it to something that
   * takes ownership of a buffer.
   */
  // As bytes.
  digest(): Uint8Array;
  // In an encoding; currently only `"base64url"` (unpadded) is supported.
  digest(encoding: "base64url"): string;
}

/**
 * All-at-once hash digest function, which takes a payload array and returns
 * the digest. `payload` is only read, never retained. The result is freshly
 * allocated and unshared, on the same terms as `IncrementalHasher.digest()`.
 */
export type DigestFn = (payload: Uint8Array) => Uint8Array;
