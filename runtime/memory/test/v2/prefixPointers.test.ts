import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { encodePointer, prefixPointers } from "../../v2/path.ts";

describe("prefixPointers()", () => {
  it("returns the pointer of each prefix, the root's first and the path's own last", () => {
    expect(prefixPointers(["value", "a", "0"])).toEqual([
      "",
      "/value",
      "/value/a",
      "/value/a/0",
    ]);
    expect(prefixPointers([])).toEqual([""]);
  });

  it("returns at each index the pointer `encodePointer()` gives that prefix", () => {
    // A set keyed by `encodePointer()` is looked up with these pointers, so
    // an escape or an empty segment spelled differently here would miss.
    const paths = [
      [""],
      ["", ""],
      ["a/b", "m~n", "~1", "~0"],
      ["value", "", "*", "-", "0"],
      ["雪", "\u0000", "c%d"],
    ];
    for (const path of paths) {
      const pointers = prefixPointers(Object.freeze(path));
      expect(pointers.length).toBe(path.length + 1);
      pointers.forEach((pointer, length) =>
        expect(pointer).toBe(encodePointer(path.slice(0, length)))
      );
    }
  });
});
