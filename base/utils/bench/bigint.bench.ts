/**
 * BigInt encoding/decoding performance benchmarks.
 *
 * Measures `bigintToMinimalTwosComplement()` and
 * `bigintFromMinimalTwosComplement()` using both implementations and across the
 * full byte-length spectrum, with separate positive/negative tracks. Sizes
 * 1-127 sweep in single-byte steps so several discontinuities are visible: the
 * 8-byte fast-path boundary (both directions switch from a
 * `DataView.{set,get}BigUint64()` fast path to a per-byte fallback) and the
 * 32-byte large-negative-decoder crossover. Sizes 128, 256, 512 sample the
 * deep-fallback regime; 1008..1039 brackets 1024 to expose `partials` cost
 * (`bytes.length & 7`) at very large sizes.
 *
 * Each iteration of a benchmark function processes a fixed BATCH of values
 * pre-generated with a deterministic xorshift RNG, so JIT specialization on
 * a single repeated value can't skew the result. The reported `ns/iter` is
 * per BATCH; divide by BATCH for per-operation cost.
 *
 * Generated values lie in the upper half of each byte-size band (positive
 * v in [2^(8b-2), 2^(8b-1)-1], negative v = -p for p in the same range), so
 * encoded magnitudes are guaranteed to need exactly b bytes. The encoder's
 * sign-extension `byteLen++` branch (taken for values straddling a byte
 * boundary) is not benchmarked separately; add a third track if its cost is
 * of interest.
 *
 * Decoder inputs are produced by running the encoder over the same generated
 * bigints, so the encode and decode benchmarks for a given (size, sign)
 * exercise inverse operations on matching data.
 *
 * A second section measures the base64url convenience pair
 * (`bigintToUnpaddedBase64url()` / `bigintFromUnpaddedBase64url()`). Each of
 * its groups carries four tracks. The two's-complement step and the base64url
 * step, measured alone, show where the time goes. Then `two-step inline` --
 * the same two calls written out in one loop -- against `combined`, which is
 * the pair that answers whether wrapping them costs anything.
 *
 * Read the composition's cost off that pair, NOT off `combined` against the
 * sum of the two step tracks. Summing two tracks double-counts the batch loop,
 * and each step track is handed a pre-built input where the composition
 * allocates its intermediate one step earlier -- so the sum is biased by a
 * loop iteration and describes different allocation behavior besides.
 *
 * It sweeps every size up to
 * 33 bytes and then doubles out to 1 MiB: the base64url layer is linear in byte
 * count with no branch structure of its own, so past the crossovers in the
 * layer below it, reach matters more than resolution. Positive and negative
 * tracks sit in one group per (size, direction), so the sign's effect reads off
 * the same table as the layering. Its batch size shrinks as values grow, and so
 * is stated per benchmark rather than being BATCH throughout.
 *
 * Run with: deno bench --no-check bench/bigint.bench.ts
 */

import { fromBase64url, toUnpaddedBase64url } from "../src/base64url.ts";
import {
  bigintFromMinimalTwosComplement,
  bigintFromUnpaddedBase64url,
  bigintToMinimalTwosComplement,
  bigintToUnpaddedBase64url,
} from "../src/bigint.ts";
import {
  bigintFromMtcDirect,
  bigintToMtcDirect,
} from "../src/bigint-uint8-direct.ts";
import {
  bigintFromMtcHex,
  bigintToMtcHex,
} from "../src/bigint-uint8-hex-string.ts";

const BATCH = 64;

const BYTE_SIZES: readonly number[] = (() => {
  const set = new Set<number>();
  for (let i = 1; i <= 127; i++) set.add(i);
  set.add(128);
  set.add(256);
  set.add(512);
  for (let i = 1008; i <= 1039; i++) set.add(i);
  return [...set].sort((a, b) => a - b);
})();

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9; // xorshift can't start at 0
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/**
 * Returns a positive bigint that requires exactly `bytes` bytes when encoded
 * as minimal two's complement. Forces bit (8*bytes - 2) so the value lies in
 * the upper half of the band, then fills the remaining magnitude bits from
 * `rng`.
 */
function makePositive(bytes: number, rng: () => number): bigint {
  const magBits = 8 * bytes - 1; // sign bit must be 0 in the canonical form
  let v = 1n << BigInt(magBits - 1);
  let bitsLeft = magBits - 1;
  let shift = 0n;
  while (bitsLeft > 0) {
    if (bitsLeft >= 32) {
      v |= BigInt(rng()) << shift;
      shift += 32n;
      bitsLeft -= 32;
    } else {
      const mask = (1 << bitsLeft) - 1;
      v |= BigInt(rng() & mask) << shift;
      bitsLeft = 0;
    }
  }
  return v;
}

function makeBatch(bytes: number, sign: 1n | -1n, seed: number): bigint[] {
  const rng = makeRng(seed);
  const out: bigint[] = [];
  for (let i = 0; i < BATCH; i++) {
    out.push(sign * makePositive(bytes, rng));
  }
  return out;
}

const IMPLS: ReadonlyArray<{
  readonly name: string;
  readonly biToMtc: (value: bigint) => Uint8Array;
  readonly biFromMtc: (bytes: Uint8Array) => bigint;
}> = [
  {
    name: "direct",
    biToMtc: bigintToMtcDirect,
    biFromMtc: bigintFromMtcDirect,
  },
  {
    name: "hex",
    biToMtc: bigintToMtcHex,
    biFromMtc: bigintFromMtcHex,
  },
];

for (const { name: implName, biToMtc, biFromMtc } of IMPLS) {
  const isBaselineImpl = implName === IMPLS[0]!.name;

  const encodeBatch = (values: bigint[]): Uint8Array[] => {
    return values.map((v) => biToMtc(v));
  };

  // Warm up both directions to avoid measuring JIT compilation in the first
  // reported bucket.
  {
    const warmSmallVals = makeBatch(8, 1n, 1);
    const warmLargeVals = makeBatch(64, -1n, 2);
    const warmSmallBytes = encodeBatch(warmSmallVals);
    const warmLargeBytes = encodeBatch(warmLargeVals);
    for (let i = 0; i < 200; i++) {
      for (const v of warmSmallVals) biToMtc(v);
      for (const v of warmLargeVals) biToMtc(v);
      for (const b of warmSmallBytes) biFromMtc(b);
      for (const b of warmLargeBytes) biFromMtc(b);
    }
  }

  for (const bytes of BYTE_SIZES) {
    const positives = makeBatch(bytes, 1n, bytes * 31 + 1);
    const negatives = makeBatch(bytes, -1n, bytes * 31 + 2);
    const positiveBytes = encodeBatch(positives);
    const negativeBytes = encodeBatch(negatives);
    // Pad the group key so Deno bench's grouped output sorts in size order.
    const groupKey = String(bytes).padStart(4, "0");
    const encodeGroup = `encode-${groupKey}B`;
    const decodeGroup = `decode-${groupKey}B`;
    const label = `${bytes}B`;

    Deno.bench({
      name: `encode positive ${label} ${implName} (${BATCH} ops)`,
      group: encodeGroup,
      baseline: isBaselineImpl,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biToMtc(positives[i]!);
        }
      },
    });

    Deno.bench({
      name: `encode negative ${label} ${implName} (${BATCH} ops)`,
      group: encodeGroup,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biToMtc(negatives[i]!);
        }
      },
    });

    Deno.bench({
      name: `decode positive ${label} ${implName} (${BATCH} ops)`,
      group: decodeGroup,
      baseline: isBaselineImpl,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biFromMtc(positiveBytes[i]!);
        }
      },
    });

    Deno.bench({
      name: `decode negative ${label} ${implName} (${BATCH} ops)`,
      group: decodeGroup,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biFromMtc(negativeBytes[i]!);
        }
      },
    });
  }
}

//
// The base64url convenience pair
//

/**
 * Byte sizes for the base64url benchmarks: every size from 1 to 33 inclusive,
 * which brackets both the 8-byte and the 32-byte crossover in the underlying
 * encoders, and then a doubling sweep out to 1 MiB.
 */
const B64_BYTE_SIZES: readonly number[] = (() => {
  const result: number[] = [];
  for (let i = 1; i <= 33; i++) result.push(i);
  for (let i = 64; i <= (1 << 20); i *= 2) result.push(i);
  return result;
})();

/**
 * Payload budget per benchmark, in bytes. The batch shrinks as values grow, so
 * that the megabyte end of the sweep measures a single operation rather than
 * allocating 64 MiB of them. Each benchmark's name carries its own batch size,
 * since it is no longer `BATCH` throughout.
 */
const B64_BATCH_BYTES = 1 << 18;

/** Returns the batch size for `bytes`-sized values. */
function b64BatchFor(bytes: number): number {
  return Math.max(1, Math.min(BATCH, Math.floor(B64_BATCH_BYTES / bytes)));
}

/**
 * Returns the minimal two's-complement encoding of a value of the given sign
 * that needs exactly `bytes` bytes. The leading byte lands in `[0x40, 0x7f]`
 * for a positive value and `[0x80, 0xbf]` for a negative one, so the magnitude
 * sits in the upper half of its band -- the same guarantee `makePositive()`
 * gives -- while staying linear to build at megabyte sizes, where repeated
 * bigint shifting is not.
 */
function makeBandBytes(
  bytes: number,
  sign: 1n | -1n,
  rng: () => number,
): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = rng() & 0xff;
  }
  out[0] = (sign === 1n ? 0x40 : 0x80) | (out[0]! & 0x3f);
  return out;
}

// Warm up all six measured paths, for the same reason the first section does.
{
  const rng = makeRng(7);
  const warmBytes = [
    ...Array.from({ length: BATCH }, () => makeBandBytes(8, 1n, rng)),
    ...Array.from({ length: BATCH }, () => makeBandBytes(8, -1n, rng)),
  ];
  const warmVals = warmBytes.map((b) => bigintFromMinimalTwosComplement(b));
  const warmStrings = warmBytes.map((b) => toUnpaddedBase64url(b));
  for (let i = 0; i < 200; i++) {
    for (const v of warmVals) {
      bigintToMinimalTwosComplement(v);
      bigintToUnpaddedBase64url(v);
    }
    for (const b of warmBytes) {
      toUnpaddedBase64url(b);
      bigintFromMinimalTwosComplement(b);
    }
    for (const s of warmStrings) {
      fromBase64url(s);
      bigintFromUnpaddedBase64url(s);
    }
  }
}

for (const bytes of B64_BYTE_SIZES) {
  const batch = b64BatchFor(bytes);
  // Pad the group key so Deno bench's grouped output sorts in size order.
  const groupKey = String(bytes).padStart(7, "0");
  const encodeGroup = `b64-encode-${groupKey}B`;
  const decodeGroup = `b64-decode-${groupKey}B`;
  const label = `${bytes}B`;

  for (const sign of [1n, -1n] as const) {
    const signLabel = sign === 1n ? "positive" : "negative";
    const isBaselineSign = sign === 1n;
    const rng = makeRng(bytes * 37 + (sign === 1n ? 3 : 5));
    const encodedBytes = Array.from(
      { length: batch },
      () => makeBandBytes(bytes, sign, rng),
    );
    const values = encodedBytes.map((b) => bigintFromMinimalTwosComplement(b));
    const encodedStrings = encodedBytes.map((b) => toUnpaddedBase64url(b));

    Deno.bench({
      name:
        `b64 encode ${signLabel} ${label} two's-complement step (${batch} ops)`,
      group: encodeGroup,
      baseline: isBaselineSign,
      fn() {
        for (let i = 0; i < batch; i++) {
          bigintToMinimalTwosComplement(values[i]!);
        }
      },
    });

    Deno.bench({
      name: `b64 encode ${signLabel} ${label} base64url step (${batch} ops)`,
      group: encodeGroup,
      fn() {
        for (let i = 0; i < batch; i++) {
          toUnpaddedBase64url(encodedBytes[i]!);
        }
      },
    });

    Deno.bench({
      name: `b64 encode ${signLabel} ${label} two-step inline (${batch} ops)`,
      group: encodeGroup,
      fn() {
        for (let i = 0; i < batch; i++) {
          toUnpaddedBase64url(bigintToMinimalTwosComplement(values[i]!));
        }
      },
    });

    Deno.bench({
      name: `b64 encode ${signLabel} ${label} combined (${batch} ops)`,
      group: encodeGroup,
      fn() {
        for (let i = 0; i < batch; i++) {
          bigintToUnpaddedBase64url(values[i]!);
        }
      },
    });

    Deno.bench({
      name:
        `b64 decode ${signLabel} ${label} two's-complement step (${batch} ops)`,
      group: decodeGroup,
      baseline: isBaselineSign,
      fn() {
        for (let i = 0; i < batch; i++) {
          bigintFromMinimalTwosComplement(encodedBytes[i]!);
        }
      },
    });

    Deno.bench({
      name: `b64 decode ${signLabel} ${label} base64url step (${batch} ops)`,
      group: decodeGroup,
      fn() {
        for (let i = 0; i < batch; i++) {
          fromBase64url(encodedStrings[i]!);
        }
      },
    });

    Deno.bench({
      name: `b64 decode ${signLabel} ${label} two-step inline (${batch} ops)`,
      group: decodeGroup,
      fn() {
        for (let i = 0; i < batch; i++) {
          bigintFromMinimalTwosComplement(fromBase64url(encodedStrings[i]!));
        }
      },
    });

    Deno.bench({
      name: `b64 decode ${signLabel} ${label} combined (${batch} ops)`,
      group: decodeGroup,
      fn() {
        for (let i = 0; i < batch; i++) {
          bigintFromUnpaddedBase64url(encodedStrings[i]!);
        }
      },
    });
  }
}
