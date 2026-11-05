import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { stringTupleKey } from "../src/string-tuple-key.ts";

describe("stringTupleKey()", () => {
  it("preserves tuple boundaries through empty strings and embedded separators", () => {
    const tuples = [
      [],
      [""],
      ["", ""],
      ["a\0b", "c"],
      ["a", "b\0c"],
      ["a:b", "c"],
      ["a", "b:c"],
      ["12", ":abc"],
      ["1", "2:abc"],
      ['["a"]'],
      ["a"],
    ];
    expect(new Set(tuples.map(stringTupleKey)).size).toBe(tuples.length);
  });

  it("retains every tuple in a corpus of delimiter and UTF-16 edge cases", () => {
    const strings = [
      "",
      "\0",
      ":",
      "0:",
      "12",
      "a",
      "a\0",
      "\0a",
      "名字",
      "😀",
      "\ud800",
      "\udc00",
    ];
    let level: string[][] = [[]];
    const keys = new Set<string>();
    let count = 0;
    for (let width = 0; width <= 3; width++) {
      for (const tuple of level) {
        const key = stringTupleKey(tuple);
        expect(keys.has(key)).toBe(false);
        expect(stringTupleKey([...tuple])).toBe(key);
        keys.add(key);
        count++;
      }
      level = level.flatMap((tuple) => strings.map((part) => [...tuple, part]));
    }
    expect(keys.size).toBe(count);
  });

  it("retrieves a value through an independently constructed frozen tuple", () => {
    const tuple = Object.freeze(["space", "of:document", "field\0name", "😀"]);
    const values = new Map([[stringTupleKey(tuple), "stored"]]);
    expect(values.get(stringTupleKey([...tuple]))).toBe("stored");
    expect(tuple).toEqual(["space", "of:document", "field\0name", "😀"]);
  });
});
