/** Deno version of SHA256. */

import { backtickQuote } from "@commonfabric/text/markdown";
import { isDeno } from "@commonfabric/platform/env";
import type { IncrementalHasher } from "@/interface.ts";
import {
  BaseSmallChunkUpdatingHasher,
} from "@/BaseSmallChunkUpdatingHasher.ts";
import { initWasmOneShot, sha256Wasm } from "@/sha256-wasm.ts";

/** The part of a `node:crypto` hash object this module uses. */
interface NodeHash {
  update(data: Uint8Array): NodeHash;
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
}

// Can't `import` at the top, because then `import`ing this module would fail
// in a non-Deno environment.
let crypto: { createHash: (algorithm: string) => NodeHash } | null = null;

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
 * Whether `hash-wasm` is ready to hash short inputs: `undefined` until the first
 * short input asks for it, then `false` while its WASM compiles in the
 * background, and `true` once it is usable or `false` for good if it is not.
 * Until it is usable, `node:crypto` hashes every input, so a process that hashes
 * nothing short compiles nothing.
 */
let wasmReady: boolean | undefined;

/**
 * Length in bytes of the longest input hashed in WASM. Up to it, the fixed cost
 * of a `node:crypto` hasher outweighs WASM's slower rounds.
 */
const MAX_WASM_INPUT_LENGTH = 192;

/** The input of a hash that is fed nothing. */
const EMPTY = new Uint8Array(0);

/**
 * Deno-specific incremental hasher. Small updates are collected before they
 * reach `node:crypto`, where each `update()` call costs enough to dominate a
 * hash fed as many short chunks. A short input arrives as a single collected
 * chunk, and is digested by `sha256Deno()`, so that it costs no `node:crypto`
 * hasher at all.
 */
class DenoHasher extends BaseSmallChunkUpdatingHasher {
  /** The `node:crypto` hasher, once the input is known not to be short. */
  #hasher: NodeHash | null = null;

  /** A copy of the only chunk so far, while that chunk is short. */
  #whole: Uint8Array | null = null;

  /** @inheritDoc */
  protected _rawUpdate(data: Uint8Array) {
    if (this.#hasher === null) {
      if (this.#whole === null && data.length <= MAX_WASM_INPUT_LENGTH) {
        // The base class may reuse `data`'s buffer once this returns.
        this.#whole = data.slice();
        return;
      }
      this.#hasher = crypto!.createHash("sha256");
      if (this.#whole !== null) this.#hasher.update(this.#whole);
      this.#whole = null;
    }
    this.#hasher.update(data);
  }

  /** @inheritDoc */
  protected _rawDigest(encoding: string | undefined): Uint8Array | string {
    if (this.#hasher === null) {
      return sha256Deno(this.#whole ?? EMPTY);
    }

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

  if (payload.length <= MAX_WASM_INPUT_LENGTH) {
    if (wasmReady) return sha256Wasm(payload);
    if (wasmReady === undefined) {
      wasmReady = false;
      initWasmOneShot().then((usable) => {
        wasmReady = usable;
      });
    }
  }

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
