/**
 * Subjects shared by the codec benchmarks, built once so that every format
 * measures the same values.
 *
 * A format's benchmark supplies its own encoded forms and its own
 * `Deno.bench()` cases; what it takes from here is the values going in. That is
 * what lets two formats' numbers be read side by side: a difference between
 * them is a difference between the formats rather than between two sets of
 * subjects that happen to have been written separately.
 *
 * The containers hold nothing but the number `0`. That is deliberate: it makes
 * the per-element cost as close to nil as a format allows, so what the size
 * series measures is the walker and the container handling rather than any one
 * codec. The single-value group covers the codecs themselves, one subject each,
 * and the omnibus groups cover what a mixed tree costs when escaping, holes,
 * and several codecs all appear at once.
 */

import type { FabricValue } from "@";
import { FabricError } from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@/fabric-primitives";

/** Container sizes: the empty case, then five orders of magnitude. */
export const SIZES = [0, 1, 10, 100, 1000, 10000, 100000] as const;

/**
 * Sizes for the sparse series. Below ten there is nothing for a gap pattern to
 * do: the generator always fills index zero, so a one-element array comes out
 * dense, and an empty one has nothing to be sparse about.
 */
export const SPARSE_SIZES = SIZES.filter((size) => size >= 10);

/**
 * Payload sizes **in bytes** for the two series that carry bulk data rather
 * than structure, one magnitude further than the containers reach.
 *
 * Bytes rather than elements, and the same ladder for both, because the point
 * of these two series is to be read against each other. A `FabricBytes` and a
 * `bigint` of the same size carry the same quantity of data through formats
 * that treat them oppositely: cloning takes each as itself, where JSON writes
 * both as base64url of the same byte count -- the same wire text, to within a
 * character or two -- and still does not spend alike getting there.
 */
export const BYTE_SIZES = [
  0,
  1,
  10,
  100,
  1000,
  10000,
  100000,
  1000000,
] as const;

/**
 * One subject per interesting path through the codec system: the
 * self-representing cases, the four JavaScript types JSON cannot carry, a
 * terminal and a nonterminal fabric codec, and both structural escapes.
 *
 * The two escapes are here rather than only inside the omnibus because that is
 * where a path's own cost is legible. A `/`-prefixed key alone does not settle
 * which applies: an object whose values are all plain data is quote-safe and
 * gets `/quote`, where one carrying anything that itself encodes to a tagged
 * form gets `/object` and has its entries decoded one by one.
 */
export const SINGLES: readonly (readonly [string, FabricValue])[] = [
  ["null", null],
  ["number", 914],
  ["string", "a modest string"],
  ["bigint", 9_007_199_254_740_993n],
  ["special-number", Number.NaN],
  ["symbol", Symbol.for("bench.symbol")],
  ["undefined", undefined],
  ["bytes", new FabricBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))],
  ["epoch-nsec", new FabricEpochNsec(1_700_000_000_000_000_000n)],
  ["regexp", new FabricRegExp(/wildcard.*match/gi)],
  ["error", FabricError.fromNativeError(new Error("bench"))],
  [
    "quote-escape",
    Object.freeze({
      id: 914,
      label: "plain throughout, so quote-safe",
      enabled: true,
      "/looks-tagged": "escaped by `/quote`",
    }),
  ],
  [
    "object-escape",
    Object.freeze({
      id: 914,
      label: "carries a tagged value, so not quote-safe",
      when: new FabricEpochNsec(1_700_000_000_000_000_000n),
      "/looks-tagged": "escaped by `/object`",
    }),
  ],
];

/** Builds an array of `size` zeroes. */
export function makeArray(size: number): FabricValue {
  return Object.freeze(new Array(size).fill(0));
}

/**
 * Builds a sparse array of `size` logical elements, with gaps that widen as
 * the array goes on.
 *
 * Runs of a single hole would be the easy shape to generate and the least
 * informative one: a run of any length costs exactly one wire entry, so
 * alternating present and absent would measure one run length over and over
 * and never exercise a large count. Widening the gaps covers the range
 * instead, from ten missing indices up to runs of thousands. (Not from one:
 * the first gap is already ten wide, `Math.max((1 * 3) - 10, 10)` having
 * floored it there. A run of a single hole is exercised by the omnibus.)
 *
 * A consequence worth expecting rather than being surprised by: gaps that
 * widen geometrically leave a count of present elements that grows with the
 * logarithm of `size`. Under JSON, that makes the decode side of this series
 * nearly flat across the magnitudes while the encode side still scales with
 * the index range it walks. The flat column is the result to expect there.
 * Large sparse arrays ceasing to decode quickly would mean a `/hole` run had
 * stopped costing one entry, which is the property this series exists to hold.
 * A format that carries a hole as a hole has no such run to hold, and reads
 * differently.
 */
export function makeSparseArray(size: number): FabricValue {
  const result = new Array(size);
  let holeCount = 1;

  for (let at = 0; at < size; at += holeCount + 1) {
    result[at] = 0;
    holeCount = Math.max((holeCount * 3) - 10, 10);
  }

  return Object.freeze(result);
}

/**
 * Builds a `FabricBytes` of `size` bytes.
 *
 * The content is a repeating byte ramp rather than zeroes, unlike the
 * containers: base64url costs the same either way, but a run of zeroes is the
 * one input a future encoder might reasonably special-case, and a series meant
 * to price bulk data should not be measuring a shortcut.
 */
export function makeBytes(size: number): FabricValue {
  const bytes = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    bytes[i] = i & 0xff;
  }

  return new FabricBytes(bytes, true);
}

/**
 * Builds a positive `bigint` occupying `size` bytes, and as sparse as one that
 * size can be: the lowest bit set and the highest, nothing between them.
 *
 * The high bit is what makes the byte count exact -- a value with leading zero
 * bytes would carry less data than its size claims -- and the low bit is what
 * keeps the value from being a power of two, which is the shape an
 * implementation is likeliest to have a shortcut for. Between them the value
 * is all zeroes, so nothing here is measuring dense magnitude when it means to
 * be measuring size. `size` of zero gives `0n`, the ladder's empty case.
 *
 * Positive throughout, sign being stored apart from magnitude, so a negative
 * counterpart would cost what these do.
 *
 * What to have in hand when reading this series against the byte one under
 * JSON: the two reach the *same* wire form, base64url of a two's-complement
 * byte string, and at these sizes the same length to within a character. What
 * separates them is the cost of getting a `bigint`'s bytes out of the runtime
 * at all, which goes through `toString(16)` and a hex parse -- linear, base 16
 * being a power of two, but several times what handing over a `Uint8Array`
 * costs.
 */
export function makeBigint(size: number): FabricValue {
  return (size === 0) ? 0n : (1n << BigInt((8 * size) - 1)) | 1n;
}

/** Builds a plain object of `size` distinct keys, every value zero. */
export function makeObject(size: number): FabricValue {
  const result: Record<string, FabricValue> = {};
  for (let i = 0; i < size; i++) {
    result[`k${i}`] = 0;
  }
  return Object.freeze(result);
}

/**
 * Builds a mixed tree of roughly `leaves` leaf values: nested containers, a
 * sample of each codec, a rare array hole, and a rare `/`-prefixed key. This
 * is the shape a real payload has, where the size series above deliberately
 * has none of it.
 *
 * About one item in a hundred carries a `/`-prefixed key, which in a real
 * payload rounds to none at all; giving one to every item would measure the
 * escaping path rather than a tree that happens to contain it.
 *
 * Those rare items come in both flavors, because a `/`-prefixed key alone does
 * not settle which escaping applies. An object whose values are all plain data
 * is quote-safe and gets `/quote`; one carrying anything that itself encodes
 * to a tagged form is not, and gets `/object` with its entries decoded
 * individually. Two different paths through the walker, so both appear here --
 * and at these frequencies both appear even in the smallest tree below.
 */
export function makeOmnibus(leaves: number): FabricValue {
  const items: FabricValue[] = [];
  for (let i = 0; i < leaves; i++) {
    const flavor = i % 200;

    if (flavor === 0) {
      // Plain data throughout, so this one escapes as `/quote`.
      items.push(Object.freeze({
        id: i,
        label: `item_${i}`,
        enabled: (i % 2) === 0,
        ratio: i / 7,
        nested: Object.freeze({ depth: 1, tags: Object.freeze(["a", "b"]) }),
        "/looks-tagged": "escaped by `/quote`",
      }));
      continue;
    }

    const item: Record<string, FabricValue> = {
      id: i,
      label: `item_${i}`,
      enabled: (i % 2) === 0,
      ratio: i / 7,
      missing: undefined,
      big: BigInt(i) * 1_000_000_007n,
      when: new FabricEpochNsec(BigInt(i) * 1_000_000n),
      pattern: new FabricRegExp(/x/g),
      blob: new FabricBytes(new Uint8Array([i & 0xff, (i >> 8) & 0xff])),
      nested: Object.freeze({
        depth: 1,
        // Sparse for about one item in a hundred. A hole is at least as rare
        // in a real payload as a reserved key is, so making every item carry
        // one would weight this toward a shape that does not occur.
        items: Object.freeze(
          (i % 100) === 2 ? [i, , i + 2] : [i, i + 1, i + 2],
        ),
      }),
    };

    if (flavor === 1) {
      // Carries tagged values, so this one escapes as `/object`.
      item["/looks-tagged"] = "escaped by `/object`";
    }

    items.push(Object.freeze(item));
  }

  return Object.freeze({
    kind: "omnibus",
    generated: new FabricEpochNsec(1_700_000_000_000_000_000n),
    items: Object.freeze(items),
  });
}

/**
 * Builds a mixed tree of roughly `leaves` leaf values, every one of them a
 * type JSON carries directly: no `/`-prefixed key, no array hole, no special
 * number, and no `FabricSpecialObject`. The shape otherwise matches
 * {@link makeOmnibus}, so the two are comparable size for size.
 *
 * Pass-through under JSON, and therefore under any format: nothing here draws
 * a tag or an escape, so what a walk costs over this tree is the walk itself.
 * A format that hands an unchanged subtree back by identity returns the whole
 * of this one, the outermost value included.
 */
export function makeJsonPassThroughOmnibus(leaves: number): FabricValue {
  const items: FabricValue[] = [];

  for (let i = 0; i < leaves; i++) {
    items.push(Object.freeze({
      id: i,
      label: `item_${i}`,
      enabled: (i % 2) === 0,
      ratio: i / 7,
      nested: Object.freeze({
        depth: 1,
        tags: Object.freeze(["a", "b"]),
        items: Object.freeze([i, i + 1, i + 2]),
      }),
    }));
  }

  return Object.freeze({
    kind: "omnibus",
    generated: "2026-01-01T00:00:00Z",
    items: Object.freeze(items),
  });
}

/**
 * Builds a mixed tree of roughly `leaves` leaf values, every one of them a
 * type structured cloning carries directly. That is everything
 * {@link makeJsonPassThroughOmnibus} holds plus the five things JSON has to
 * write out as tagged text or escape around: `bigint`, `undefined`, the
 * special numbers, a `/`-prefixed key, and an array hole. No symbol and no
 * `FabricSpecialObject`, cloning refusing the first and having no reading of
 * the second.
 *
 * This is the difference between the two formats stated as a value. Pass-
 * through for a realm-crossing format, which returns the whole tree by
 * identity; under JSON nearly every item here is tagged or escaped, so the
 * gap between this series and {@link makeJsonPassThroughOmnibus} is what the
 * tagging machinery costs.
 */
export function makeRealmPassThroughOmnibus(leaves: number): FabricValue {
  const items: FabricValue[] = [];

  for (let i = 0; i < leaves; i++) {
    items.push(Object.freeze({
      id: i,
      label: `item_${i}`,
      enabled: (i % 2) === 0,
      ratio: i / 7,
      missing: undefined,
      big: BigInt(i) * 1_000_000_007n,
      odd: [Number.NaN, -0, Number.POSITIVE_INFINITY][i % 3],
      "/looks-tagged": "an ordinary key where nothing reserves one",
      nested: Object.freeze({
        depth: 1,
        // A hole in every item rather than one in a hundred: this series
        // exists to hold the whole of what cloning carries and JSON does not,
        // so every item carries every one of them.
        items: Object.freeze([i, , i + 2]),
      }),
    }));
  }

  return Object.freeze({
    kind: "omnibus",
    generated: 1_700_000_000_000_000_000n,
    items: Object.freeze(items),
  });
}

//
// Pre-built subjects, so that a benchmark measures only the call under test.
//

export const ARRAYS = SIZES.map((size) => [size, makeArray(size)] as const);
export const SPARSE = SPARSE_SIZES.map(
  (size) => [size, makeSparseArray(size)] as const,
);
export const OBJECTS = SIZES.map((size) => [size, makeObject(size)] as const);

/** Byte payloads by magnitude. */
export const BYTES = BYTE_SIZES.map(
  (size) => [size, makeBytes(size)] as const,
);

/** `bigint` payloads by magnitude, sized in bytes to match {@link BYTES}. */
export const BIGINTS = BYTE_SIZES.map(
  (size) => [size, makeBigint(size)] as const,
);

/** Leaf counts for every omnibus series, so the three are read against each other. */
const OMNIBUS_SIZES = [10, 100, 1000] as const;

export const OMNIBUSES = OMNIBUS_SIZES.map(
  (n) => [n, makeOmnibus(n)] as const,
);
export const JSON_PASS_THROUGH_OMNIBUSES = OMNIBUS_SIZES.map(
  (n) => [n, makeJsonPassThroughOmnibus(n)] as const,
);
export const REALM_PASS_THROUGH_OMNIBUSES = OMNIBUS_SIZES.map(
  (n) => [n, makeRealmPassThroughOmnibus(n)] as const,
);

/**
 * Zero-pads a size, so that group keys sort by magnitude: the largest container
 * sorts after the smallest rather than between `1` and `10`.
 */
export function groupKey(prefix: string, size: number): string {
  return `${prefix}-${String(size).padStart(6, "0")}`;
}
