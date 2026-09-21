import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { snapshotJsonValue } from "../src/cfc/share-snapshot-value.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

describe("cfc-share-snapshot-value", () => {
  it("copies and freezes the complete JSON payload for review", () => {
    const value = {
      books: [{ title: "Solaris", author: "Stanisław Lem" }],
      count: 1,
      selected: true,
      extra: null,
    };
    const snapshot = snapshotJsonValue(value);
    expect(snapshot).toEqual(value);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen((snapshot as typeof value).books)).toBe(true);
    expect(Object.isFrozen((snapshot as typeof value).books[0])).toBe(true);
  });

  it("refuses primitives that JSON cannot represent", () => {
    for (
      const value of [
        undefined,
        NaN,
        Infinity,
        -Infinity,
        Symbol("private"),
        1n,
        () => "private",
      ]
    ) {
      expect(() => snapshotJsonValue(value))
        .toThrow(/JSON values without cell references/);
    }
  });

  it("refuses a primitive cell link inside the snapshot", () => {
    const link = { "/": { [LINK_V1_TAG]: { id: "of:fid1:book", path: [] } } };
    expect(() => snapshotJsonValue({ book: link })).toThrow(
      /JSON values without cell references/,
    );
  });

  it("refuses cyclic objects and arrays", () => {
    const object: { nested?: unknown } = {};
    object.nested = object;
    const array: unknown[] = [];
    array.push(array);
    for (const value of [object, array]) {
      expect(() => snapshotJsonValue(value)).toThrow(/cyclic values/);
    }
  });

  it("refuses custom object prototypes and prototype keys", () => {
    expect(() => snapshotJsonValue(new Date(0)))
      .toThrow(/plain JSON objects/);
    expect(() =>
      snapshotJsonValue(JSON.parse('{"__proto__":{"private":true}}'))
    )
      .toThrow(/prototype keys/);
  });

  it("allows repeated references when they do not form a cycle", () => {
    const book = { title: "Solaris" };
    expect(snapshotJsonValue({ first: book, second: book }))
      .toEqual({ first: { title: "Solaris" }, second: { title: "Solaris" } });
  });
});
