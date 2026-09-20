/**
 * JSON codec performance benchmarks, encoding and decoding.
 *
 * Run with:
 *
 *     deno bench --no-check bench/codec-json.bench.ts
 *
 * The subjects come from `fixtures/codec-fixtures.ts`, shared with the other
 * formats' benchmarks so that their numbers can be read side by side.
 *
 * Each group pairs the two directions over one subject, so the encode/decode
 * ratio for that subject reads off a single block. A name repeats its group
 * because `--filter` matches names and not groups, and a subject one cannot
 * select is a subject one cannot iterate on.
 *
 * Every subject is built before any measurement, and no case has setup to
 * exclude, so these take the plain `fn()` form rather than bracketing with
 * `b.start()` / `b.end()`.
 */

import type { FabricValue } from "@";
import { fabricFromJsonValue, jsonFromFabricValue } from "@/codecs.ts";
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

/** Encoded forms of the singles, for the decode direction. */
const SINGLES_JSON = SINGLES.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);

const ARRAYS_JSON = ARRAYS.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const SPARSE_JSON = SPARSE.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const OBJECTS_JSON = OBJECTS.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const BYTES_JSON = BYTES.map(([n, v]) => [n, jsonFromFabricValue(v)] as const);
const BIGINTS_JSON = BIGINTS.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const OMNIBUSES_JSON = OMNIBUSES.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const JSON_PASS_THROUGH_JSON = JSON_PASS_THROUGH_OMNIBUSES.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const REALM_PASS_THROUGH_JSON = REALM_PASS_THROUGH_OMNIBUSES.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);

// Warm up. Deno warms each benchmark on its own, so this is belt-and-braces
// -- but it covers the codec paths rather than only the container walks,
// since the single-value groups are measured first and are the shortest.
for (let i = 0; i < 50; i++) {
  for (const [, value] of SINGLES) {
    fabricFromJsonValue(jsonFromFabricValue(value));
  }
  fabricFromJsonValue(jsonFromFabricValue(ARRAYS[2]![1]));
  fabricFromJsonValue(jsonFromFabricValue(OBJECTS[2]![1]));
}

//
// Single values, one group per codec path
//

for (const [name, value] of SINGLES) {
  Deno.bench({
    name: `encode single-${name}`,
    group: `single-${name}`,
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [name, json] of SINGLES_JSON) {
  Deno.bench({
    name: `decode single-${name}`,
    group: `single-${name}`,
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Arrays of zeroes, by magnitude
//

for (const [size, value] of ARRAYS) {
  Deno.bench({
    name: `encode ${groupKey("array", size)}`,
    group: groupKey("array", size),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [size, json] of ARRAYS_JSON) {
  Deno.bench({
    name: `decode ${groupKey("array", size)}`,
    group: groupKey("array", size),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Sparse arrays, by magnitude
//

for (const [size, value] of SPARSE) {
  Deno.bench({
    name: `encode ${groupKey("sparse", size)}`,
    group: groupKey("sparse", size),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [size, json] of SPARSE_JSON) {
  Deno.bench({
    name: `decode ${groupKey("sparse", size)}`,
    group: groupKey("sparse", size),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Plain objects of zeroes, by magnitude
//

for (const [size, value] of OBJECTS) {
  Deno.bench({
    name: `encode ${groupKey("object", size)}`,
    group: groupKey("object", size),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [size, json] of OBJECTS_JSON) {
  Deno.bench({
    name: `decode ${groupKey("object", size)}`,
    group: groupKey("object", size),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

// Bulk payloads by magnitude, both reaching base64url text of a byte string
// of the same length. Sized in bytes so the two columns answer the same
// question of each; what separates them is the trip a `bigint` takes through
// `toString(16)` to become bytes in the first place.

const BULK: readonly (readonly [
  string,
  readonly (readonly [number, FabricValue])[],
  readonly (readonly [number, string])[],
])[] = [
  ["bytes", BYTES, BYTES_JSON],
  ["bigint", BIGINTS, BIGINTS_JSON],
];

for (const [prefix, subjects, encodedForms] of BULK) {
  for (const [size, value] of subjects) {
    Deno.bench({
      name: `encode ${groupKey(prefix, size)}`,
      group: groupKey(prefix, size),
      baseline: true,
      fn() {
        jsonFromFabricValue(value);
      },
    });
  }

  for (const [size, json] of encodedForms) {
    Deno.bench({
      name: `decode ${groupKey(prefix, size)}`,
      group: groupKey(prefix, size),
      fn() {
        fabricFromJsonValue(json);
      },
    });
  }
}

//
// Omnibus trees
//

for (const [leaves, value] of OMNIBUSES) {
  Deno.bench({
    name: `encode ${groupKey("omnibus", leaves)}`,
    group: groupKey("omnibus", leaves),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [leaves, json] of OMNIBUSES_JSON) {
  Deno.bench({
    name: `decode ${groupKey("omnibus", leaves)}`,
    group: groupKey("omnibus", leaves),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

// Omnibus trees whose contents need no encoding, and those whose contents need
// none only under a realm-crossing format. The gap between the two is what
// this format's tagging and escaping cost over a tree that another format
// carries directly.

for (const [leaves, value] of JSON_PASS_THROUGH_OMNIBUSES) {
  Deno.bench({
    name: `encode ${groupKey("json-pass-through", leaves)}`,
    group: groupKey("json-pass-through", leaves),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [leaves, json] of JSON_PASS_THROUGH_JSON) {
  Deno.bench({
    name: `decode ${groupKey("json-pass-through", leaves)}`,
    group: groupKey("json-pass-through", leaves),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

for (const [leaves, value] of REALM_PASS_THROUGH_OMNIBUSES) {
  Deno.bench({
    name: `encode ${groupKey("realm-pass-through", leaves)}`,
    group: groupKey("realm-pass-through", leaves),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [leaves, json] of REALM_PASS_THROUGH_JSON) {
  Deno.bench({
    name: `decode ${groupKey("realm-pass-through", leaves)}`,
    group: groupKey("realm-pass-through", leaves),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}
