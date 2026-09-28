/**
 * `patch.ts` deep-clones incoming op values for isolation. It MUST preserve
 * fabric wrapper classes: it previously used `structuredClone()`, which
 * silently demotes class instances to plain objects, so a `FabricError`
 * (or any `FabricInstance`/`FabricPrimitive`) round-tripped through a patch
 * op came back as a plain object and was then serialized lossily (PR #3613).
 * These tests pin the property directly at the `patch.ts` layer, exercising
 * every op that clones a value (`replace`, `add`, `splice`, and the
 * `add`-via-`move` path), plus a second `applyPatch` pass to mimic the
 * engine replaying a stored patch sequence over an already-deep-frozen base.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";

import { FabricInstance } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";

import { applyPatch, applyPatchToDocument } from "../v2/patch.ts";

Deno.test("memory v2 patch preserves `FabricInstance` values with full fidelity", () => {
  const placements = [
    () =>
      applyPatch({ a: { x: 1 } }, [
        {
          op: "replace",
          path: "/a",
          value: FabricError.fromNativeError(new Error("boom")),
        },
      ]) as { a: unknown },
    () =>
      applyPatch({}, [
        {
          op: "add",
          path: "/a",
          value: FabricError.fromNativeError(new Error("boom")),
        },
      ]) as { a: unknown },
    () =>
      applyPatch({ a: ["keep"] }, [
        {
          op: "splice",
          path: "/a",
          index: 1,
          remove: 0,
          add: [FabricError.fromNativeError(new Error("boom"))],
        },
      ]) as { a: unknown[] },
  ];
  const reads: Array<(r: any) => unknown> = [
    (r) => r.a,
    (r) => r.a,
    (r) => r.a[1],
  ];

  placements.forEach((place, i) => {
    const out = reads[i]!(place()) as FabricError;
    assert(out instanceof FabricError, `placement ${i}: not a FabricError`);
    assertEquals(out.message, "boom");
    assertEquals(typeof out.stack, "string");
  });
});

Deno.test("memory v2 patch keeps `FabricInstance` values as `FabricInstance`s (not demoted to plain objects)", () => {
  const patched = applyPatch({}, [
    {
      op: "add",
      path: "/e",
      value: FabricError.fromNativeError(new Error("boom")),
    },
  ]) as { e: unknown };
  const out = patched.e;

  // The structuredClone-regression guard: a demoted value would be a plain
  // object (`Object.prototype`), failing every check below.
  assert(out instanceof FabricInstance);
  assert(out instanceof FabricError);
  assertEquals(Object.getPrototypeOf(out) === Object.prototype, false);
});

Deno.test("memory v2 patch round-trips `FabricInstance` values across replayed patch passes", () => {
  const first = applyPatch({ box: {} }, [
    {
      op: "add",
      path: "/box/err",
      value: FabricError.fromNativeError(new Error("boom")),
    },
  ]);
  // `first` is deep-frozen by applyPatch; a second pass mimics the engine
  // replaying a stored patch sequence (here `move` -> `add`-clones the
  // already-deep-frozen FabricInstance).
  const second = applyPatch(first, [
    { op: "move", from: "/box/err", path: "/moved" },
  ]) as { moved: unknown };
  const out = second.moved as FabricError;

  assert(out instanceof FabricError);
  assertEquals(out.message, "boom");
  assertEquals(typeof out.stack, "string");
});

Deno.test("memory v2 patch preserves `FabricPrimitive` values with full fidelity", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const patchedBytes = applyPatch({ a: ["keep"] }, [
    {
      op: "splice",
      path: "/a",
      index: 0,
      remove: 0,
      add: [new FabricBytes(bytes)],
    },
  ]) as { a: unknown[] };
  const outBytes = patchedBytes.a[0] as FabricBytes;
  assert(outBytes instanceof FabricBytes);
  assertEquals(outBytes.length, 4);
  assertEquals([...outBytes.slice()], [1, 2, 3, 4]);

  const patchedEpoch = applyPatch({}, [
    { op: "add", path: "/ts", value: new FabricEpochNsec(1_234n) },
  ]) as { ts: unknown };
  const outEpoch = patchedEpoch.ts as FabricEpochNsec;
  assert(outEpoch instanceof FabricEpochNsec);
  assertEquals(outEpoch.value, 1_234n);
});

Deno.test("memory v2 patch keeps `FabricPrimitive` values as `FabricPrimitive`s (not demoted to plain objects)", () => {
  const patched = applyPatch({}, [
    { op: "add", path: "/b", value: new FabricBytes(new Uint8Array([9, 9])) },
  ]) as { b: unknown };
  const out = patched.b;

  assert(out instanceof FabricBytes);
  assertEquals(Object.getPrototypeOf(out) === Object.prototype, false);
  // structuredClone would have dropped the private `#bytes` entirely.
  assertEquals((out as FabricBytes).length, 2);
});

Deno.test("memory v2 patch round-trips `FabricPrimitive` values across replayed patch passes", () => {
  const first = applyPatch({ box: {} }, [
    {
      op: "add",
      path: "/box/b",
      value: new FabricBytes(new Uint8Array([7, 8, 9])),
    },
  ]);
  const second = applyPatch(first, [
    { op: "move", from: "/box/b", path: "/moved" },
  ]) as { moved: unknown };
  const out = second.moved as FabricBytes;

  assert(out instanceof FabricBytes);
  assertEquals([...out.slice()], [7, 8, 9]);
});

Deno.test("memory v2 patch applies multiple operations without mutating the input", () => {
  const original = {
    profile: { name: "Alice" },
    tags: ["one"],
  };

  const patched = applyPatch(original, [
    { op: "replace", path: "/profile/name", value: "Bob" },
    { op: "add", path: "/profile/title", value: "Dr" },
    {
      op: "splice",
      path: "/tags",
      index: 1,
      remove: 0,
      add: ["two", "three"],
    },
  ]);

  assertEquals(original, {
    profile: { name: "Alice" },
    tags: ["one"],
  });
  assertEquals(patched, {
    profile: { name: "Bob", title: "Dr" },
    tags: ["one", "two", "three"],
  });
});

Deno.test("memory v2 patch can replace the root and continue patching the replacement", () => {
  const original = {
    stale: true,
  };

  const patched = applyPatch(original, [
    { op: "replace", path: "", value: { items: [] } },
    { op: "add", path: "/items/-", value: "next" },
  ]);

  assertEquals(original, { stale: true });
  assertEquals(patched, { items: ["next"] });
});

Deno.test("memory v2 patch move updates the cloned document without mutating the input", () => {
  const original = {
    from: { value: 1 },
    to: {},
  };

  const patched = applyPatch(original, [
    { op: "move", from: "/from/value", path: "/to/value" },
  ]);

  assertEquals(original, {
    from: { value: 1 },
    to: {},
  });
  assertEquals(patched, {
    from: {},
    to: { value: 1 },
  });
});

Deno.test("memory v2 patch rejects moves into a descendant path", () => {
  const original = {
    a: { child: { keep: true } },
  };

  let error: Error | null = null;
  try {
    applyPatch(original, [
      { op: "move", from: "/a", path: "/a/child/moved" },
    ]);
  } catch (caught) {
    error = caught as Error;
  }

  assertEquals(error?.message, "cannot move a value into its own descendant");
  assertEquals(original, {
    a: { child: { keep: true } },
  });
});

Deno.test("memory v2 patch rejects invalid array indices", () => {
  const original = {
    items: ["a"],
  };

  for (const path of ["/items/01", "/items/4294967295"]) {
    let error: Error | null = null;
    try {
      applyPatch(original, [
        { op: "replace", path, value: "b" },
      ]);
    } catch (caught) {
      error = caught as Error;
    }

    assertEquals(error instanceof Error, true);
    assertEquals(original, {
      items: ["a"],
    });
  }
});

Deno.test("memory v2 patch rejects missing array indices in parent traversal", () => {
  const original = {
    items: [{}],
  };

  let error: Error | null = null;
  try {
    applyPatch(original, [
      { op: "add", path: "/items/1/name", value: "missing" },
    ]);
  } catch (caught) {
    error = caught as Error;
  }

  assertEquals(error?.message, "missing path /items/1/name");
  assertEquals(original, {
    items: [{}],
  });
});

Deno.test("memory v2 patch rejects add through a missing key into an array index", () => {
  // The intermediate `0` would land inside a freshly-created (empty) array,
  // which has no element 0 to traverse into -- so this must be rejected, not
  // silently fabricated.
  const original = {};

  let error: Error | null = null;
  try {
    applyPatch(original, [
      { op: "add", path: "/missingKey/0/x", value: 1 },
    ]);
  } catch (caught) {
    error = caught as Error;
  }

  assertEquals(error instanceof Error, true);
  assertEquals(original, {});
});

Deno.test("memory v2 patch rejects add through a missing key into an array append marker", () => {
  const original = {};

  let error: Error | null = null;
  try {
    applyPatch(original, [
      { op: "add", path: "/missingKey/-/x", value: 1 },
    ]);
  } catch (caught) {
    error = caught as Error;
  }

  assertEquals(error instanceof Error, true);
  assertEquals(original, {});
});

Deno.test("memory v2 patch appends via the `-` marker on an existing array", () => {
  const original = { items: ["a"] };

  const out = applyPatch(original, [
    { op: "add", path: "/items/-", value: "b" },
  ]) as typeof original;

  assertEquals(out, { items: ["a", "b"] });
  // Input untouched.
  assertEquals(original, { items: ["a"] });
});

Deno.test("memory v2 patch reuses unchanged branches across sibling updates", () => {
  const original = {
    left: {
      stable: {
        deep: true,
      },
    },
    right: {
      count: 0,
    },
  };

  const patched = applyPatch(original, [
    { op: "replace", path: "/right/count", value: 1 },
  ]) as typeof original;

  assertStrictEquals(patched.left, original.left);
  assertEquals(patched, {
    left: {
      stable: {
        deep: true,
      },
    },
    right: {
      count: 1,
    },
  });
});

//
// `append`
//
// An `append` op is tail-relative: it inserts `values` at the array's live tail,
// creating the array (and the path to it) when absent. This is what lets a client
// whose base is stale or empty still land its elements after whatever durably
// precedes them.
//

Deno.test("memory v2 append lands at the live tail", () => {
  const out = applyPatch({ value: ["a", "b"] }, [
    { op: "append", path: "/value", values: ["c"] },
  ]) as { value: string[] };
  assertEquals(out.value, ["a", "b", "c"]);
});

Deno.test("memory v2 appends compose to land at successive tails", () => {
  const out = applyPatch({ value: ["a"] }, [
    { op: "append", path: "/value", values: ["b"] },
    { op: "append", path: "/value", values: ["c"] },
  ]) as { value: string[] };
  assertEquals(out.value, ["a", "b", "c"]);
});

Deno.test("memory v2 append creates the array when absent", () => {
  const fromEmptyDoc = applyPatch({}, [
    { op: "append", path: "/value", values: ["x"] },
  ]) as { value: string[] };
  assertEquals(fromEmptyDoc, { value: ["x"] });

  const nested = applyPatch({ value: {} }, [
    { op: "append", path: "/value/items", values: [1, 2] },
  ]) as { value: { items: number[] } };
  assertEquals(nested, { value: { items: [1, 2] } });
});

Deno.test("memory v2 append rejects a non-array target", () => {
  let threw = false;
  try {
    applyPatch({ value: "not-an-array" }, [
      { op: "append", path: "/value", values: ["b"] },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "append onto a non-array must throw");
});

//
// `add-unique`
//
// `add-unique` appends each value only if no existing element equals it, and
// creates the array if absent. It is idempotent against durable state.
//

Deno.test("memory v2 add-unique adds only absent elements", () => {
  const out = applyPatch({ value: ["a", "b"] }, [
    { op: "add-unique", path: "/value", values: ["b", "c", "c"] },
  ]) as { value: string[] };
  assertEquals(out.value, ["a", "b", "c"]);
});

Deno.test("memory v2 add-unique on a present element is a no-op", () => {
  const out = applyPatch({ value: ["a"] }, [
    { op: "add-unique", path: "/value", values: ["a"] },
  ]) as { value: string[] };
  assertEquals(out.value, ["a"]);
});

Deno.test("memory v2 add-unique creates the array when absent", () => {
  const out = applyPatch({}, [
    { op: "add-unique", path: "/value", values: ["x", "x"] },
  ]) as { value: string[] };
  assertEquals(out, { value: ["x"] });
});

Deno.test("memory v2 add-unique compares by stored value (objects)", () => {
  const out = applyPatch({ value: [{ id: 1 }] }, [
    { op: "add-unique", path: "/value", values: [{ id: 1 }, { id: 2 }] },
  ]) as { value: { id: number }[] };
  assertEquals(out.value, [{ id: 1 }, { id: 2 }]);
});

Deno.test("memory v2 add-unique compares special objects by content", () => {
  // A `FabricSpecialObject` keeps its state in private `#fields`, so its
  // content is what distinguishes two instances, not its (empty) own-property
  // set.
  const out = applyPatch({ value: [new FabricBytes(new Uint8Array([1, 2]))] }, [
    {
      op: "add-unique",
      path: "/value",
      values: [
        new FabricBytes(new Uint8Array([1, 2])),
        new FabricBytes(new Uint8Array([3, 4])),
        new FabricEpochNsec(1234n),
      ],
    },
  ]) as { value: unknown[] };
  assertEquals(out.value, [
    new FabricBytes(new Uint8Array([1, 2])),
    new FabricBytes(new Uint8Array([3, 4])),
    new FabricEpochNsec(1234n),
  ]);
});

Deno.test("memory v2 add-unique adds only absent elements when adding many", () => {
  // Enough distinct values that elements are looked up in a set of them
  // rather than compared one by one; the result is the same.
  const incoming = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  const out = applyPatch({ value: [{ id: 3 }, "x", { id: 17 }] }, [
    {
      op: "add-unique",
      path: "/value",
      values: [...incoming, { id: 5 }, "x", -0, 0, NaN, NaN],
    },
  ]) as { value: unknown[] };
  assertEquals(out.value, [
    { id: 3 },
    "x",
    { id: 17 },
    ...incoming.filter(({ id }) => id !== 3 && id !== 17),
    -0,
    0,
    NaN,
  ]);
  assert(Object.is(out.value[out.value.length - 3], -0));
});

Deno.test("memory v2 add-unique adds a hole among the values as `undefined`", () => {
  const out = applyPatch({ value: ["a"] }, [
    // deno-lint-ignore no-sparse-arrays
    { op: "add-unique", path: "/value", values: ["b", , "b"] },
  ]) as { value: unknown[] };
  assertEquals(out.value.length, 3);
  assertEquals([out.value[1], 2 in out.value, out.value[2]], [
    "b",
    true,
    undefined,
  ]);
});

Deno.test("memory v2 add-unique on the weird numbers", () => {
  // `NaN` is the same value as `NaN`; `-0` and `+0` are different values.
  const nan = applyPatch({ value: [NaN] }, [
    { op: "add-unique", path: "/value", values: [NaN] },
  ]) as { value: number[] };
  assertEquals(nan.value.length, 1);

  const zero = applyPatch({ value: [-0] }, [
    { op: "add-unique", path: "/value", values: [+0] },
  ]) as { value: number[] };
  assertEquals(zero.value.length, 2);
  assert(Object.is(zero.value[0], -0), "the stored -0 must survive");
  assert(Object.is(zero.value[1], +0), "the added +0 must be distinct");
});

//
// `increment`
//
// `increment` adds `by` to the number at the path, treats an absent value as 0,
// creates the path if absent, and sums when composed.
//

Deno.test("memory v2 increment adds to an existing number", () => {
  const out = applyPatch({ value: { count: 5 } }, [
    { op: "increment", path: "/value/count", by: 3 },
  ]) as { value: { count: number } };
  assertEquals(out.value.count, 8);
});

Deno.test("memory v2 increments compose by summing", () => {
  const out = applyPatch({ value: 0 }, [
    { op: "increment", path: "/value", by: 1 },
    { op: "increment", path: "/value", by: 1 },
  ]) as { value: number };
  assertEquals(out.value, 2);
});

Deno.test("memory v2 increment treats an absent value as zero and creates it", () => {
  const created = applyPatch({}, [
    { op: "increment", path: "/value", by: 4 },
  ]) as { value: number };
  assertEquals(created, { value: 4 });

  const nested = applyPatch({ value: {} }, [
    { op: "increment", path: "/value/count", by: -2 },
  ]) as { value: { count: number } };
  assertEquals(nested, { value: { count: -2 } });
});

Deno.test("memory v2 increment rejects a non-number target", () => {
  let threw = false;
  try {
    applyPatch({ value: { count: "five" } }, [
      { op: "increment", path: "/value/count", by: 1 },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "increment onto a non-number must throw");
});

Deno.test("memory v2 increment rejects a zero amount", () => {
  let threw = false;
  try {
    applyPatch({ value: { count: 1 } }, [
      { op: "increment", path: "/value/count", by: 0 },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "a zero increment must throw");
});

Deno.test("memory v2 increment rejects a non-finite amount", () => {
  // A non-finite `by` is meaningless for a concurrent-sum counter and would set
  // the counter to an absorbing `NaN`/`±Infinity`, so it is rejected alongside
  // a zero amount. (`-0 === 0`, so negative zero is already caught by the zero
  // gate.)
  for (const by of [NaN, Infinity, -Infinity]) {
    let threw = false;
    try {
      applyPatch({ value: { count: 1 } }, [
        { op: "increment", path: "/value/count", by },
      ]);
    } catch {
      threw = true;
    }
    assert(threw, `increment by ${by} must throw`);
  }
});

//
// `remove-by-value`
//
// `remove-by-value` removes every element equal to the given value (by stored
// value), idempotently, and is a no-op on a missing/non-array target.
//

Deno.test("memory v2 remove-by-value removes matching elements", () => {
  const out = applyPatch({ value: ["a", "b", "a", "c"] }, [
    { op: "remove-by-value", path: "/value", value: "a" },
  ]) as { value: string[] };
  assertEquals(out.value, ["b", "c"]);
});

Deno.test("memory v2 remove-by-value matches by stored value (links/objects)", () => {
  const link = { "/": { "link@1": { path: [], id: "of:fid1:vote-x" } } };
  const other = { "/": { "link@1": { path: [], id: "of:fid1:vote-y" } } };
  const out = applyPatch({ value: [link, other] }, [
    {
      op: "remove-by-value",
      path: "/value",
      value: { "/": { "link@1": { path: [], id: "of:fid1:vote-x" } } },
    },
  ]) as { value: unknown[] };
  assertEquals(out.value, [other]);
});

Deno.test("memory v2 remove-by-value matches special objects by content", () => {
  const out = applyPatch({
    value: [
      new FabricBytes(new Uint8Array([1, 2])),
      new FabricBytes(new Uint8Array([3, 4])),
    ],
  }, [
    {
      op: "remove-by-value",
      path: "/value",
      value: new FabricBytes(new Uint8Array([1, 2])),
    },
  ]) as { value: unknown[] };
  assertEquals(out.value, [new FabricBytes(new Uint8Array([3, 4]))]);
});

Deno.test("memory v2 remove-by-value on the weird numbers", () => {
  const nan = applyPatch({ value: [NaN, 1] }, [
    { op: "remove-by-value", path: "/value", value: NaN },
  ]) as { value: number[] };
  assertEquals(nan.value, [1]);

  const zero = applyPatch({ value: [-0, +0] }, [
    { op: "remove-by-value", path: "/value", value: +0 },
  ]) as { value: number[] };
  assertEquals(zero.value.length, 1);
  assert(Object.is(zero.value[0], -0), "only the +0 may be removed");
});

Deno.test("memory v2 remove-by-value keeps holes, closing up only removed slots", () => {
  // deno-lint-ignore no-sparse-arrays
  const out = applyPatch({ value: ["a", , "b", "a", , "c"] }, [
    { op: "remove-by-value", path: "/value", value: "a" },
  ]) as { value: string[] };
  assertEquals(out.value.length, 4);
  assertEquals([0 in out.value, 1 in out.value], [false, true]);
  assertEquals([2 in out.value, 3 in out.value], [false, true]);
  assertEquals([out.value[1], out.value[3]], ["b", "c"]);
});

Deno.test("memory v2 remove-by-value is a no-op when absent", () => {
  const original = { value: ["a", "b"] };
  const out = applyPatch(original, [
    { op: "remove-by-value", path: "/value", value: "z" },
  ]) as { value: string[] };
  assertEquals(out.value, ["a", "b"]);

  const missing = applyPatch({}, [
    { op: "remove-by-value", path: "/value", value: "z" },
  ]);
  assertEquals(missing, {});
});

//
// Targets an op refuses
//
// A non-array target is rejected once the path resolves to a traversable
// container (an object) rather than to a scalar. A scalar target is caught
// earlier by the spine thaw with a "not traversable" message; an object target
// reaches the op's own array-shape check. The root path is refused outright.
//

Deno.test("memory v2 append rejects a non-array object target", () => {
  let threw = false;
  try {
    applyPatch({ value: {} }, [
      { op: "append", path: "/value", values: ["b"] },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "append onto an object must throw");
});

Deno.test("memory v2 add-unique rejects a non-array object target", () => {
  let threw = false;
  try {
    applyPatch({ value: {} }, [
      { op: "add-unique", path: "/value", values: ["b"] },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "add-unique onto an object must throw");
});

Deno.test("memory v2 increment rejects the root path", () => {
  let threw = false;
  try {
    applyPatch({ count: 0 }, [
      { op: "increment", path: "", by: 1 },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "increment at the root must throw");
});

//
// Paths through array indices
//
// What an index path does when it resolves, and what it does when the index
// names nothing.
//

Deno.test("memory v2 increment updates a numeric array element by index", () => {
  // Both `increment` and `remove-by-value` read the current value by walking
  // the path through array indices as well as object keys. Incrementing a
  // numeric array element addresses it positionally and writes back into the
  // array.
  const out = applyPatch({ scores: [10, 20, 30] }, [
    { op: "increment", path: "/scores/1", by: 5 },
  ]) as { scores: number[] };
  assertEquals(out.scores, [10, 25, 30]);
});

Deno.test("memory v2 remove-by-value is a no-op through a missing array index", () => {
  // A path segment that names an out-of-range array index resolves to absent,
  // so remove-by-value finds no array there and leaves the document untouched.
  const original = { items: [["a"]] };
  const out = applyPatch(original, [
    { op: "remove-by-value", path: "/items/5/inner", value: "a" },
  ]) as typeof original;
  assertEquals(out, { items: [["a"]] });
});

//
// `applyPatchToDocument`
//
// `applyPatchToDocument` is the shared "replay these ops over whatever this
// document currently is" entry point (server-side reconstruction and the
// client's pending replay). It normalizes an absent base to the empty
// envelope and guarantees the result IS an entity envelope — a root-level
// op can produce any FabricValue, and type-laundering a scalar root into
// EntityDocument would let an invalid shape reach envelope-assuming code.
//

Deno.test("memory v2 applyPatchToDocument replays over an absent base as the empty envelope", () => {
  const patched = applyPatchToDocument(undefined, [
    { op: "add", path: "/value", value: { items: { mine: "hello" } } },
  ]);
  assertEquals(patched, { value: { items: { mine: "hello" } } });
});

Deno.test("memory v2 applyPatchToDocument rejects a patched root that is not an entity document", () => {
  assertThrows(
    () =>
      applyPatchToDocument({ value: { count: 1 } }, [
        { op: "replace", path: "", value: 5 },
      ]),
    Error,
    "patched root is not an entity document",
  );
});
