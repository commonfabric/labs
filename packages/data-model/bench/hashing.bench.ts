/**
 * Hashing Performance Benchmarks
 *
 * Run with:
 *
 *     deno bench --allow-read --allow-write --allow-net --allow-ffi \
 *       --allow-env --no-check bench/hashing.bench.ts
 */

import { deepFreeze, hashOf } from "@";

//
// Pre-generated test data
//

const smallObject = {
  name: "Alice",
  age: 30,
  active: true,
  score: 95.5,
  tag: null,
};

function makeMediumObject() {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < 15; i++) {
    obj[`key_${i}`] = {
      value: `value_${i}`,
      count: i * 10,
      nested: { a: i, b: `nested_${i}`, flag: i % 2 === 0 },
    };
  }
  return obj;
}
const mediumObject = makeMediumObject();

function makeLargeNestedTree(
  depth: number,
  breadth: number,
): Record<string, unknown> {
  if (depth === 0) {
    return { leaf: true, value: 42.5, label: "leaf-node" };
  }
  const children: Record<string, unknown> = {};
  for (let i = 0; i < breadth; i++) {
    children[`child_${i}`] = makeLargeNestedTree(depth - 1, breadth);
  }
  return { depth, children };
}
const largeNestedTree = makeLargeNestedTree(6, 3); // ~364 nodes

const smallArray = [1, "hello", true, null, 42.5];

const largeArray = Array.from({ length: 200 }, (_, i) => ({
  id: i,
  name: `item_${i}`,
  value: i * 1.5,
}));

function makeRepeatedSubtrees() {
  const shared = {
    type: "shared-component",
    config: { x: 1, y: 2, z: 3 },
    metadata: { version: "1.0", tags: ["a", "b", "c"] },
  };
  const items = [];
  for (let i = 0; i < 50; i++) {
    items.push({ id: i, component: shared, label: `item_${i}` });
  }
  return { items };
}
const repeatedSubtrees = makeRepeatedSubtrees();

const unclaimedFact = {
  the: "application/json",
  of: "did:key:z6Mktest1234567890",
};

const assertion16KB = {
  the: "application/json",
  of: "did:key:z6Mktest1234567890",
  is: { content: "X".repeat(16 * 1024 - 100), id: "bench-id" },
};

// Warm up to avoid measuring JIT compilation
for (let i = 0; i < 20; i++) {
  hashOf(smallObject);
}

//
// Same-object benchmarks (measures cache effectiveness)
//

Deno.bench({
  name: "small object (5 keys)",
  group: "small-object",
  fn(b) {
    b.start();
    hashOf(smallObject);
    b.end();
  },
});

Deno.bench({
  name: "medium object (15 keys, 2-level)",
  group: "medium-object",
  fn(b) {
    b.start();
    hashOf(mediumObject);
    b.end();
  },
});

Deno.bench({
  name: "large tree (~364 nodes)",
  group: "large-tree",
  fn(b) {
    b.start();
    hashOf(largeNestedTree);
    b.end();
  },
});

Deno.bench({
  name: "small array (5 elements)",
  group: "small-array",
  fn(b) {
    b.start();
    hashOf(smallArray);
    b.end();
  },
});

Deno.bench({
  name: "large array (200 objects)",
  group: "large-array",
  fn(b) {
    b.start();
    hashOf(largeArray);
    b.end();
  },
});

Deno.bench({
  name: "repeated subtrees (50 items, 1 shared)",
  group: "repeated-subtrees",
  fn(b) {
    b.start();
    hashOf(repeatedSubtrees);
    b.end();
  },
});

Deno.bench({
  name: "unclaimed {the, of}",
  group: "unclaimed",
  fn(b) {
    b.start();
    hashOf(unclaimedFact);
    b.end();
  },
});

Deno.bench({
  name: "16KB assertion",
  group: "assertion-16kb",
  fn(b) {
    b.start();
    hashOf(assertion16KB);
    b.end();
  },
});

//
// Fresh-object benchmarks (no cache benefit -- measures raw hashing speed)
//

function freshSmallObject() {
  return {
    name: "Alice",
    age: 30,
    active: true,
    score: 95.5,
    tag: null,
  };
}

function freshMediumObject() {
  return makeMediumObject();
}

function freshUnclaimedFact() {
  return {
    the: "application/json",
    of: "did:key:z6Mktest1234567890",
  };
}

function freshAssertion16KB() {
  return {
    the: "application/json",
    of: "did:key:z6Mktest1234567890",
    is: { content: "X".repeat(16 * 1024 - 100), id: "bench-id" },
  };
}

Deno.bench({
  name: "small object (5 keys, fresh)",
  group: "small-object-fresh",
  fn(b) {
    const data = freshSmallObject();
    b.start();
    hashOf(data);
    b.end();
  },
});

Deno.bench({
  name: "medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  fn(b) {
    const data = freshMediumObject();
    b.start();
    hashOf(data);
    b.end();
  },
});

Deno.bench({
  name: "unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  fn(b) {
    const data = freshUnclaimedFact();
    b.start();
    hashOf(data);
    b.end();
  },
});

Deno.bench({
  name: "16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  fn(b) {
    const data = freshAssertion16KB();
    b.start();
    hashOf(data);
    b.end();
  },
});

//
// sparse arrays
//

const sparseArray = new Array(100);
for (let i = 0; i < 100; i += 3) {
  sparseArray[i] = { index: i, value: `sparse_${i}` };
}

Deno.bench({
  name: "sparse array (100 slots, 34 filled)",
  group: "sparse-array",
  fn() {
    hashOf(sparseArray);
  },
});

//
// Deep-frozen same-object benchmarks (the `WeakMap` cache activates)
//

const frozenSmallFlat = deepFreeze({
  name: "Alice",
  age: 30,
  active: true,
  score: 95.5,
  tag: null,
});

const frozenNested = deepFreeze({
  user: { name: "Alice", prefs: { theme: "dark", lang: "en" } },
  scores: { math: 95, science: 88, history: 72 },
  meta: { created: "2026-01-01", version: 3 },
});

const frozenArray = deepFreeze([1, "hello", true, null, 42.5, {
  nested: "val",
}]);

const frozenObjectWithArrays = deepFreeze({
  ids: [1, 2, 3, 4, 5],
  tags: ["alpha", "beta", "gamma"],
  matrix: [[1, 2], [3, 4], [5, 6]],
  label: "container",
});

const frozenLargeTree = deepFreeze(makeLargeNestedTree(6, 3));

// Warm up frozen-object path
for (let i = 0; i < 20; i++) {
  hashOf(frozenSmallFlat);
  hashOf(frozenLargeTree);
}

Deno.bench({
  name: "frozen small flat (5 keys, WeakMap cached)",
  group: "frozen-small-flat",
  fn(b) {
    b.start();
    hashOf(frozenSmallFlat);
    b.end();
  },
});

Deno.bench({
  name: "frozen nested (3-level, WeakMap cached)",
  group: "frozen-nested",
  fn(b) {
    b.start();
    hashOf(frozenNested);
    b.end();
  },
});

Deno.bench({
  name: "frozen array (6 elements, WeakMap cached)",
  group: "frozen-array",
  fn(b) {
    b.start();
    hashOf(frozenArray);
    b.end();
  },
});

Deno.bench({
  name: "frozen object+arrays (WeakMap cached)",
  group: "frozen-obj-arrays",
  fn(b) {
    b.start();
    hashOf(frozenObjectWithArrays);
    b.end();
  },
});

Deno.bench({
  name: "frozen large tree (~364 nodes, WeakMap cached)",
  group: "frozen-large-tree",
  fn(b) {
    b.start();
    hashOf(frozenLargeTree);
    b.end();
  },
});

//
// Deep-frozen fresh-object benchmarks (freeze + hash each iteration)
//

Deno.bench({
  name: "frozen small flat (fresh)",
  group: "frozen-small-flat-fresh",
  fn(b) {
    const data = deepFreeze({
      name: "Alice",
      age: 30,
      active: true,
      score: 95.5,
      tag: null,
    });
    b.start();
    hashOf(data);
    b.end();
  },
});

Deno.bench({
  name: "frozen nested (fresh)",
  group: "frozen-nested-fresh",
  fn(b) {
    const data = deepFreeze({
      user: { name: "Alice", prefs: { theme: "dark", lang: "en" } },
      scores: { math: 95, science: 88, history: 72 },
      meta: { created: "2026-01-01", version: 3 },
    });
    b.start();
    hashOf(data);
    b.end();
  },
});

Deno.bench({
  name: "frozen large tree (fresh)",
  group: "frozen-large-tree-fresh",
  fn(b) {
    const data = deepFreeze(makeLargeNestedTree(6, 3));
    b.start();
    hashOf(data);
    b.end();
  },
});

//
// `{the, of}` unclaimed-fact pattern benchmarks
//

const frozenTheOf = Object.freeze({
  the: "application/json" as const,
  of: "did:key:z6Mktest1234567890" as const,
});

// Warm up
for (let i = 0; i < 20; i++) {
  hashOf(frozenTheOf);
}

Deno.bench({
  name: "frozen {the, of} (WeakMap cached)",
  group: "frozen-the-of",
  fn(b) {
    b.start();
    hashOf(frozenTheOf);
    b.end();
  },
});

Deno.bench({
  name: "frozen {the, of} (fresh)",
  group: "frozen-the-of-fresh",
  fn(b) {
    const data = Object.freeze({
      the: "application/json",
      of: "did:key:z6Mktest1234567890",
    });
    b.start();
    hashOf(data);
    b.end();
  },
});
