/**
 * Benchmarks comparing the three SHA-256 implementations across all fixtures
 * and three call styles:
 *
 * * `sha256()` -- all-at-once function.
 * * `createHasher()` one-shot -- a single `update()` then `digest()`.
 * * `createHasher()` multi-byte variety -- many `update()` calls with
 *   pseudo-randomly varying chunk sizes (mirrors the unit test of the same
 *   name).
 * * `createHasher()` byte-at-a-time -- one `update()` per byte. Skipped for
 *   fixtures large enough that this would dominate the whole bench run.
 *
 * Benchmarks are grouped by implementation (`sha256Deno`, `sha256Noble`,
 * `sha256Wasm`, `sha256WasmCollecting`). The last of these is the fallback
 * path used when the WASM hasher pool is exhausted; the `sha256()` column is
 * a duplicate of `sha256Wasm`'s (same underlying one-shot path).
 */

import { createHasherDeno, sha256Deno } from "@/sha256-deno.ts";
import { createHasherNoble, sha256Noble } from "@/sha256-noble.ts";
import {
  createHasherWasm,
  createHasherWasmCollecting,
  initWasm,
  sha256Wasm,
} from "@/sha256-wasm.ts";
import type { DigestFn, IncrementalHasher } from "@/interface.ts";
import { FIXTURES } from "../test/fixtures.ts";

await initWasm();

/**
 * Maximum fixture size (in bytes) for the byte-at-a-time bench style. Larger
 * fixtures would do millions of `update()` calls per iteration and dominate
 * the suite's runtime.
 */
const BYTE_AT_A_TIME_MAX = 10000;

type CreateHasherFn = () => IncrementalHasher;

interface Impl {
  name: string;
  sha256: DigestFn;
  createHasher: CreateHasherFn;
}

const IMPLS: readonly Impl[] = [
  { name: "sha256Deno", sha256: sha256Deno, createHasher: createHasherDeno },
  { name: "sha256Noble", sha256: sha256Noble, createHasher: createHasherNoble },
  { name: "sha256Wasm", sha256: sha256Wasm, createHasher: createHasherWasm },
  {
    name: "sha256WasmCollecting",
    sha256: sha256Wasm,
    createHasher: createHasherWasmCollecting,
  },
];

/**
 * Incremental hashing with varying chunk sizes, matching the "multi-byte
 * variety" unit test.
 */
function hashMultiVariety(
  createHasher: CreateHasherFn,
  bytes: Uint8Array,
  startingChunk: number,
): Uint8Array {
  const hasher = createHasher();
  let oneLength = startingChunk;
  let i = 0;
  while (i < bytes.length) {
    const someBytes = bytes.subarray(i, i + oneLength);
    hasher.update(someBytes);
    i += someBytes.length;
    oneLength = ((oneLength + 7) * 1123) % (bytes.length - i + 1) + 1;
  }
  return hasher.digest();
}

for (const impl of IMPLS) {
  let fixtureId = 0;
  for (const { bytes } of FIXTURES) {
    const id = fixtureId++;
    const sizeLabel = `${bytes.length}B`;
    const fixtureLabel = `#${String(id).padStart(2, "0")} (${sizeLabel})`;

    Deno.bench({
      name: `${fixtureLabel} sha256()`,
      group: impl.name,
      fn: () => {
        impl.sha256(bytes);
      },
    });

    Deno.bench({
      name: `${fixtureLabel} createHasher() one-shot`,
      group: impl.name,
      fn: () => {
        const hasher = impl.createHasher();
        hasher.update(bytes);
        hasher.digest();
      },
    });

    Deno.bench({
      name: `${fixtureLabel} createHasher() multi-variety`,
      group: impl.name,
      fn: () => {
        hashMultiVariety(impl.createHasher, bytes, 10);
      },
    });

    if (bytes.length <= BYTE_AT_A_TIME_MAX) {
      Deno.bench({
        name: `${fixtureLabel} createHasher() byte-at-a-time`,
        group: impl.name,
        fn: () => {
          const hasher = impl.createHasher();
          for (let i = 0; i < bytes.length; i++) {
            hasher.update(bytes.subarray(i, i + 1));
          }
          hasher.digest();
        },
      });
    }
  }
}
