/**
 * Realm-crossing codec performance benchmarks, encoding and decoding.
 *
 * Run with:
 *
 *     deno bench --no-check bench/codec-realm.bench.ts
 *
 * The subjects come from `fixtures/codec-fixtures.ts`, the same ones
 * `codec-json.bench.ts` measures, so the two tables line up subject for
 * subject: a row here and the row named for the same subject there differ by
 * the format and nothing else. Names carry a `realm-` prefix so that a run
 * covering both files keeps them apart.
 *
 * Two series carry most of what this format is for. `pass-through` holds only
 * values structured cloning takes directly, so encoding returns the tree by
 * identity and the walk is the whole cost; `json-pass-through` holds only what
 * JSON also takes directly. The gap between those two rows, read against the
 * same two rows in the JSON table, is what a second format buys.
 *
 * The `bytes` and `bigint` series answer a narrower question, and answer it
 * against each other: both are sized in bytes, so a row from one and the row
 * of the same size from the other carry the same quantity of data. Cloning
 * takes each as itself, and takes a `bigint` in constant time whatever its
 * magnitude. JSON reaches the same wire form for both -- base64url of a
 * two's-complement byte string, the same length to within a character -- and
 * still spends several times more on the `bigint`, which is what the four
 * columns are for.
 *
 * **A decoded tree carries no guarantee of being usable again.** `decode()`
 * cedes its input, and `FabricBytes` takes over the `ArrayBuffer` it arrived
 * in, which detaches it -- so a tree carrying bytes cannot be decoded twice.
 * That is by design, the tree across a real boundary being the receiver's own
 * clone, and it decides the shape of the decode direction here:
 *
 * * Subjects that survive repeated decoding take the plain `fn()` form.
 * * The omnibus subjects hold a `FabricBytes`, so each iteration encodes a
 *   fresh tree outside `b.start()` / `b.end()` and measures only the decode.
 *   Deno honors that bracketing when an iteration averages at least 10µs and
 *   warns when it does not; these are far above it, but that is a fact about
 *   this machine rather than about the subjects, so read the warnings.
 * * `single-bytes` and the whole `bytes` series are too small for bracketing
 *   to be honored, so each appears as a `round-trip` row instead -- named for
 *   what it measures rather than reported as a decode that is really an encode
 *   and a decode. Nothing is lost by it: a byte decode takes the buffer over
 *   by `transfer()` rather than copying, so it is ~1µs at any size, and the
 *   climb those rows show is the encode's copy.
 *
 * Every other decode row reuses one encoded tree across all of its iterations,
 * which the guarantee does not cover: it works because a byte-free tree holds
 * nothing the walk consumes, not because a decoded tree is promised to
 * survive. Measured, it also costs nothing -- a reused tree and a fresh one
 * per iteration are within noise of each other, the reused one being frozen by
 * its first decode and V8 not caring. **A decode that exploited ceding harder
 * would silently turn these rows into measurements of something else**, so a
 * change to what `decode()` retains is a reason to revisit this file.
 */

import type { FabricValue } from "@";
import { fabricFromRealmValue, realmFromFabricValue } from "@/codecs.ts";
import {
  ARRAYS,
  BIGINTS,
  BYTES,
  groupKey,
  JSON_PASS_THROUGH_OMNIBUSES,
  OBJECTS,
  OMNIBUSES,
  REALM_PASS_THROUGH_OMNIBUSES,
  SINGLES,
  SPARSE,
} from "./fixtures/codec-fixtures.ts";

/** Subjects whose encoded form holds a byte buffer, so decodes only once. */
const SINGLE_SHOT = new Set(["bytes"]);

/** Encoded forms of the repeat-safe singles, for the decode direction. */
const SINGLES_REALM = SINGLES
  .filter(([name]) => !SINGLE_SHOT.has(name))
  .map(([n, v]) => [n, realmFromFabricValue(v)] as const);

const ARRAYS_REALM = ARRAYS.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const SPARSE_REALM = SPARSE.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const BIGINTS_REALM = BIGINTS.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const OBJECTS_REALM = OBJECTS.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const JSON_PASS_THROUGH_REALM = JSON_PASS_THROUGH_OMNIBUSES.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const REALM_PASS_THROUGH_REALM = REALM_PASS_THROUGH_OMNIBUSES.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);

/** Prefixes a group key, so a run over both formats keeps the rows apart. */
function realmKey(prefix: string, size: number): string {
  return `realm-${groupKey(prefix, size)}`;
}

// Warm up, over the codec paths as much as the container walks.
for (let i = 0; i < 50; i++) {
  for (const [name, value] of SINGLES) {
    const encoded = realmFromFabricValue(value);
    if (!SINGLE_SHOT.has(name)) {
      fabricFromRealmValue(encoded);
    }
  }
  fabricFromRealmValue(realmFromFabricValue(ARRAYS[2]![1]));
  fabricFromRealmValue(realmFromFabricValue(OBJECTS[2]![1]));
}

//
// Single values, one group per codec path
//

for (const [name, value] of SINGLES) {
  Deno.bench({
    name: `encode realm-single-${name}`,
    group: `realm-single-${name}`,
    baseline: true,
    fn() {
      realmFromFabricValue(value);
    },
  });
}

for (const [name, encoded] of SINGLES_REALM) {
  Deno.bench({
    name: `decode realm-single-${name}`,
    group: `realm-single-${name}`,
    fn() {
      fabricFromRealmValue(encoded);
    },
  });
}

// The one subject whose encoded form cannot be decoded twice, measured as the
// round trip it has to be rather than reported as a decode.
for (const [name, value] of SINGLES) {
  if (!SINGLE_SHOT.has(name)) {
    continue;
  }

  Deno.bench({
    name: `round-trip realm-single-${name}`,
    group: `realm-single-${name}`,
    fn() {
      fabricFromRealmValue(realmFromFabricValue(value));
    },
  });
}

//
// Containers by magnitude: arrays of zeroes, sparse arrays, plain objects
//

const SERIES: readonly (readonly [
  string,
  readonly (readonly [number, FabricValue])[],
  readonly (readonly [number, unknown])[],
])[] = [
  ["array", ARRAYS, ARRAYS_REALM],
  ["sparse", SPARSE, SPARSE_REALM],
  ["object", OBJECTS, OBJECTS_REALM],
  // Repeat-decodable, cloning carrying a `bigint` as itself with no buffer to
  // take over. Its byte counterpart below cannot join it here for that reason.
  ["bigint", BIGINTS, BIGINTS_REALM],
  ["json-pass-through", JSON_PASS_THROUGH_OMNIBUSES, JSON_PASS_THROUGH_REALM],
  ["pass-through", REALM_PASS_THROUGH_OMNIBUSES, REALM_PASS_THROUGH_REALM],
];

for (const [prefix, subjects, encodedForms] of SERIES) {
  for (const [size, value] of subjects) {
    Deno.bench({
      name: `encode ${realmKey(prefix, size)}`,
      group: realmKey(prefix, size),
      baseline: true,
      fn() {
        realmFromFabricValue(value);
      },
    });
  }

  for (const [size, encoded] of encodedForms) {
    Deno.bench({
      name: `decode ${realmKey(prefix, size)}`,
      group: realmKey(prefix, size),
      fn() {
        fabricFromRealmValue(encoded as never);
      },
    });
  }
}

//
// Byte payloads by magnitude, against the `bigint` series above it.
//
// The second row of each group is a round trip rather than a decode, as
// `single-bytes` is and for the same reason: a tree holding a `FabricBytes`
// decodes once, so the encode cannot be hoisted out of the iteration, and
// bracketing it away is not honored at these sizes -- an iteration has to
// average 10µs before Deno will, and only the largest reaches that.
//
// Naming the row for the round trip costs nothing here, because the decode
// half does not vary with size to begin with. Taking the buffer over is
// `ArrayBuffer.prototype.transfer()`, which moves ownership rather than
// copying, so a decode is ~1µs whether the payload is 1KB or 10MB. Encoding
// copies (`sliceBuffer()`), and that is the whole of what this series shows
// climbing.
//

for (const [size, value] of BYTES) {
  Deno.bench({
    name: `encode ${realmKey("bytes", size)}`,
    group: realmKey("bytes", size),
    baseline: true,
    fn() {
      realmFromFabricValue(value);
    },
  });
}

for (const [size, value] of BYTES) {
  Deno.bench({
    name: `round-trip ${realmKey("bytes", size)}`,
    group: realmKey("bytes", size),
    fn() {
      fabricFromRealmValue(realmFromFabricValue(value));
    },
  });
}

// Omnibus trees. These hold a `FabricBytes`, so the decode direction builds a
// fresh tree per iteration and excludes it from the measurement.

for (const [leaves, value] of OMNIBUSES) {
  Deno.bench({
    name: `encode ${realmKey("omnibus", leaves)}`,
    group: realmKey("omnibus", leaves),
    baseline: true,
    fn() {
      realmFromFabricValue(value);
    },
  });
}

for (const [leaves, value] of OMNIBUSES) {
  Deno.bench({
    name: `decode ${realmKey("omnibus", leaves)}`,
    group: realmKey("omnibus", leaves),
    fn(b) {
      const encoded = realmFromFabricValue(value);

      b.start();
      fabricFromRealmValue(encoded);
      b.end();
    },
  });
}
