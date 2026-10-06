/**
 * Tests for VDOM keying utilities.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { generateChildKeys, generateKey } from "../src/worker/keying.ts";

Deno.test("keying - generateKey", async (t) => {
  await t.step("generates stable keys for strings", () => {
    assertEquals(generateKey("hello"), generateKey("hello"));
    assertNotEquals(generateKey("hello"), generateKey("goodbye"));
  });

  await t.step("generates stable keys for numbers", () => {
    assertEquals(generateKey(42), generateKey(42));
    assertNotEquals(generateKey(42), generateKey(43));
  });

  await t.step("keys a number apart from the string that spells it", () => {
    assertNotEquals(generateKey(42), generateKey("42"));
  });

  await t.step("generates stable keys for null and undefined", () => {
    assertEquals(generateKey(null), generateKey(null));
    assertEquals(generateKey(undefined), generateKey(undefined));
    assertNotEquals(generateKey(null), generateKey(undefined));
    // Both are strings. A key is what a child is identified by, so a child
    // that keys as nothing at all has no identity to be reused under.
    assertEquals(typeof generateKey(undefined), "string");
  });

  await t.step("generates stable keys for objects", () => {
    const obj = { name: "div", type: "vnode" };
    const key1 = generateKey(obj);
    const key2 = generateKey({ name: "div", type: "vnode" });
    assertEquals(key1, key2);
  });

  await t.step("generates different keys for different objects", () => {
    const key1 = generateKey({ name: "div" });
    const key2 = generateKey({ name: "span" });
    assertNotEquals(key1, key2);
  });

  await t.step("generates stable keys for arrays", () => {
    const arr = [1, 2, 3];
    const key1 = generateKey(arr);
    const key2 = generateKey([1, 2, 3]);
    assertEquals(key1, key2);
  });

  await t.step("generates stable keys for nested structures", () => {
    const vnode = {
      type: "vnode",
      name: "div",
      props: { className: "foo" },
      children: ["hello"],
    };
    const key1 = generateKey(vnode);
    const key2 = generateKey({
      type: "vnode",
      name: "div",
      props: { className: "foo" },
      children: ["hello"],
    });
    assertEquals(key1, key2);
  });

  await t.step("handles booleans", () => {
    assertNotEquals(generateKey(true), generateKey(false));
    assertEquals(generateKey(true), generateKey(true));
  });

  await t.step("keys members that differ only in fabric terms", () => {
    // Members a child can differ by, each of which must key it apart: two
    // children keying alike are reconciled as one, and the second one's content
    // never reaches the DOM. Each of these is a value `WorkerProps` admits.

    const key = (props: Record<string, unknown>) =>
      generateKey({ type: "vnode", name: "div", props });

    // A present-but-undefined member is not an absent one.
    assertNotEquals(key({ n: undefined }), key({}));

    assertNotEquals(key({ n: NaN }), key({ n: null }));
    assertNotEquals(key({ n: -0 }), key({ n: 0 }));

    // A `bigint` is a `FabricValue`, so it keys precisely even though
    // `WorkerProps` does not admit one.
    assertNotEquals(key({ n: 1n }), key({ n: 2n }));
    assertNotEquals(key({ n: 1n }), key({ n: 1 }));
  });

  //
  // Beyond `FabricValue`
  //
  // An event handler, which is not a `FabricValue` and so cannot be hashed as
  // one, and the coarse key that comes back for a node the keyer cannot hash
  // at all.
  //

  await t.step("keys an event handler without falling back", () => {
    const key = (props: Record<string, unknown>) =>
      generateKey({ type: "vnode", name: "div", props });

    // Handlers are on most interactive nodes, so a node carrying one has to
    // key by the rest of its content rather than by a fallback that every
    // `div` would share.
    assertNotEquals(
      key({ onClick: () => {}, a: 1 }),
      key({ onClick: () => {}, a: 2 }),
    );
    assertEquals(key({ onClick: () => {} }), key({ onClick: () => {} }));
    assertNotEquals(key({ onClick: () => {} }), key({}));
  });

  await t.step("answers a coarse key for a node it cannot hash", () => {
    // A `Map` has no fabric representation, and no render node holds one. What
    // matters is that an answer comes back at all: keying is on the render
    // path, where a throw takes the render with it.
    assertEquals(typeof generateKey({ n: new Map() }), "string");
    assertEquals(generateKey({ n: new Map() }), generateKey({ n: new Map() }));
  });

  await t.step("tells apart coarse keys of arrays by their length", () => {
    // An array the keyer cannot hash keys by its length, so siblings of
    // differing length still key apart.
    assertNotEquals(
      generateKey([new Map()]),
      generateKey([new Map(), new Map()]),
    );
    assertEquals(generateKey([new Map()]), generateKey([new Map()]));
  });

  //
  // A hole and a cycle
  //
  // Neither is a value the keyer can hash by following it: one is a gap where
  // an element would be, the other a structure that would not terminate if
  // followed.
  //

  await t.step("keys a hole apart from an undefined element", () => {
    const hole = [1, , 3];
    assertNotEquals(generateKey(hole), generateKey([1, undefined, 3]));
  });

  await t.step("answers a cyclic node instead of following it", () => {
    const cyclic: Record<string, unknown> = { name: "div" };
    cyclic.self = cyclic;
    assertEquals(generateKey(cyclic), generateKey(cyclic));
  });
});

Deno.test("keying - generateChildKeys", async (t) => {
  await t.step("generates unique keys for identical children", () => {
    const children = ["a", "a", "a"];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    // Keys should all be different
    assertEquals(new Set(keys).size, 3);
    // Identical children are told apart by their occurrence count alone.
    assertEquals(keys[0], `${generateKey("a")}-0`);
    assertEquals(keys[1], `${generateKey("a")}-1`);
    assertEquals(keys[2], `${generateKey("a")}-2`);
  });

  await t.step("generates stable keys for different children", () => {
    const children = ["a", "b", "c"];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    assertEquals(new Set(keys).size, 3);
  });

  await t.step("handles mixed types", () => {
    const children = ["text", 42, { type: "vnode", name: "div" }];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    assertEquals(new Set(keys).size, 3);
  });

  await t.step("handles empty array", () => {
    const keys = generateChildKeys([]);
    assertEquals(keys, []);
  });

  await t.step("handles single child", () => {
    const keys = generateChildKeys(["only"]);
    assertEquals(keys.length, 1);
    assertEquals(keys[0], `${generateKey("only")}-0`);
  });
});
