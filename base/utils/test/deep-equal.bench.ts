/**
 * `deepEqual()` over 1000-element arrays, at the three points that bound its
 * cost: two arrays that are equal, so every element is visited; two differing
 * only at the last element, so the walk runs to the end before it can say no;
 * and one array against itself, which short-circuits on identity and is the
 * floor. That floor is what says how much of any measured difference is
 * dispatch rather than comparison.
 *
 * Number arrays and object arrays are run separately because the per-element
 * work differs between them, and the fixtures are built once outside the
 * measured region so that array construction is not part of what is timed.
 */

import { deepEqual } from "@commonfabric/utils/deep-equal";

// Create test fixtures once, outside the benchmarks
const denseArray1000 = Array.from({ length: 1000 }, (_, i) => i);
const denseArray1000Copy = Array.from({ length: 1000 }, (_, i) => i);
const denseArray1000Different = Array.from(
  { length: 1000 },
  (_, i) => i === 999 ? -1 : i,
);

const denseObjectArray1000 = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  name: `item-${i}`,
}));
const denseObjectArray1000Copy = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  name: `item-${i}`,
}));

Deno.bench(
  "deepEqual - 1000-element dense number arrays (equal)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseArray1000, denseArray1000Copy);
  },
);

Deno.bench(
  "deepEqual - 1000-element dense number arrays (different at end)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseArray1000, denseArray1000Different);
  },
);

Deno.bench(
  "deepEqual - 1000-element dense object arrays (equal)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseObjectArray1000, denseObjectArray1000Copy);
  },
);

Deno.bench(
  "deepEqual - same array reference (identity check)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseArray1000, denseArray1000);
  },
);
