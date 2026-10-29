import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { encodePointer, parsePointer } from "../../v2/path.ts";

describe("encodePointer()", () => {
  it("preserves empty segments and escapes JSON Pointer tokens in order", () => {
    const cases: [string[], string][] = [
      [[], ""],
      [[""], "/"],
      [["", "", ""], "///"],
      [["value", "items", "0", "subject"], "/value/items/0/subject"],
      [["a/b"], "/a~1b"],
      [["m~n"], "/m~0n"],
      [["~1", "~0"], "/~01/~00"],
      [["~/~//", ""], "/~0~1~0~1~1/"],
      [["c%d", 'k"l', "i\\j"], '/c%d/k"l/i\\j'],
      [["雪", "🍩", "\ud800", "\u0000"], "/雪/🍩/\ud800/\u0000"],
    ];
    for (const [path, pointer] of cases) {
      expect(encodePointer(Object.freeze(path))).toBe(pointer);
      expect(parsePointer(pointer)).toEqual(path);
    }
  });

  it("distinguishes separators, literal escape tokens, and empty segments as keys", () => {
    const paths = [[], [""], ["/"], ["~1"], ["", ""], ["a/b"], ["a", "b"]];
    const keys = new Map(
      paths.map((path, index) => [encodePointer(path), index]),
    );
    expect(keys.size).toBe(paths.length);
    for (const [index, path] of paths.entries()) {
      expect(keys.get(encodePointer(path))).toBe(index);
    }
  });
});
