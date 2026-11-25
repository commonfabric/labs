import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";
import { parseSkipList, serializeSkipList } from "./skip-list.ts";

describe("skip-list", () => {
  it("parses what it serializes", () => {
    const skips = { "a.test.ts": ["outer > leaf"], "b.test.ts": [] };
    expect(parseSkipList(serializeSkipList(skips))).toEqual(skips);
  });

  it("returns undefined for anything that is not a skip list", () => {
    for (
      const text of [
        "not json",
        "[]",
        "null",
        '"a"',
        '{"a.test.ts": "leaf"}',
        '{"a.test.ts": [1]}',
      ]
    ) {
      expect(parseSkipList(text)).toBeUndefined();
    }
  });

  it("keeps a file named `__proto__` as a file of its own", () => {
    const skips = parseSkipList('{"__proto__": ["leaf"], "a.test.ts": []}');
    expect(skips === undefined ? [] : Object.entries(skips)).toEqual([
      ["__proto__", ["leaf"]],
      ["a.test.ts", []],
    ]);
    expect(Object.getPrototypeOf(skips)).toBe(Object.prototype);
  });
});
