import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { rootScalarOf, writesMoreMembersThan } from "@/codec-json/text-scan.ts";

describe("text-scan", () => {
  describe("writesMoreMembersThan()", () => {
    /** Returns the least limit `text` does not exceed. */
    function membersOf(text: string): number {
      let limit = 0;
      while (writesMoreMembersThan(text, limit)) limit++;
      return limit;
    }

    it("returns the count a parse would build, for a range of shapes", () => {
      const samples = [
        "1",
        '"a,b"',
        "[]",
        "{}",
        "[1]",
        "[1, 2, 3]",
        '{"a": 1, "b": [2, 3], "c": {}}',
        "[[], [[]], {}, [{}]]",
        " [ 1 ,\n\t2 ] ",
        '[{"/hole": 5}, "x"]',
      ];
      for (const text of samples) {
        expect({ text, members: membersOf(text) }).toEqual({
          text,
          members: countBuilt(JSON.parse(text)),
        });
      }
    });

    it("ignores commas and brackets inside strings, escaped quotes included", () => {
      expect(membersOf('["a,[b]{c}", "d\\",e", "f\\\\", "g"]')).toBe(4);
      expect(membersOf('{"k,[": "v,{"}')).toBe(1);
    });

    it("returns `true` for text past the limit whatever follows it", () => {
      // The text is not even well formed; the answer is settled before its
      // end is reached.
      expect(writesMoreMembersThan("[" + "0,".repeat(1_000_000), 10)).toBe(
        true,
      );
    });

    it("counts nothing inside a string that is never closed", () => {
      // Two members: `a`, and the string that runs to the end.
      expect(writesMoreMembersThan('["a", "b, c, d', 2)).toBe(false);
      expect(writesMoreMembersThan('["a", "b, c, d', 1)).toBe(true);
    });

    it("returns `false` at the limit and `true` one below it", () => {
      expect(writesMoreMembersThan("[1, 2, 3]", 3)).toBe(false);
      expect(writesMoreMembersThan("[1, 2, 3]", 2)).toBe(true);
    });
  });

  describe("rootScalarOf()", () => {
    const text = JSON.stringify({
      items: [1, { requestId: "inner" }, "]}"],
      requestId: "r1",
      nested: { requestId: "not this one" },
      seq: 4,
      open: false,
      none: null,
      quoted: 'a "quote" and a \\ backslash',
    });

    it("returns a root member's scalar value, stepping over the rest", () => {
      expect(rootScalarOf(text, "requestId")).toBe("r1");
      expect(rootScalarOf(text, "seq")).toBe(4);
      expect(rootScalarOf(text, "open")).toBe(false);
      expect(rootScalarOf(text, "none")).toBeNull();
      expect(rootScalarOf(text, "quoted")).toBe('a "quote" and a \\ backslash');
    });

    it("returns `undefined` for a member that is absent or not a scalar", () => {
      expect(rootScalarOf(text, "items")).toBeUndefined();
      expect(rootScalarOf(text, "nested")).toBeUndefined();
      expect(rootScalarOf(text, "request")).toBeUndefined();
      expect(rootScalarOf(text, "requestIdx")).toBeUndefined();
    });

    it("reads keys and values written with escapes and whitespace", () => {
      const escaped = ' { "re\\u0071uestId" :\n "r\\n2" , "n" : -1.5e3 } ';

      expect(rootScalarOf(escaped, "requestId")).toBe("r\n2");
      expect(rootScalarOf(escaped, "n")).toBe(-1500);
    });

    it("returns the last of a name written more than once, as a parse does", () => {
      expect(rootScalarOf('{"id": "a", "id": "b"}', "id")).toBe("b");
      expect(rootScalarOf('{"id": "a", "id": [1]}', "id")).toBeUndefined();
    });

    it("returns `undefined` when the root is not a record", () => {
      expect(rootScalarOf('["requestId", "b"]', "requestId")).toBeUndefined();
      expect(rootScalarOf('"requestId"', "requestId")).toBeUndefined();
    });

    it("returns a member written last, with no space before the close", () => {
      expect(rootScalarOf('{"a":[1],"n":1}', "n")).toBe(1);
    });

    it("returns `undefined` when the member itself is malformed", () => {
      expect(rootScalarOf('{"a" 1}', "a")).toBeUndefined();
      expect(rootScalarOf('{"a": tru}', "a")).toBeUndefined();
      expect(rootScalarOf('{"a": "unterminated', "a")).toBeUndefined();
    });

    it("returns what was read before a malformation", () => {
      expect(rootScalarOf('{"requestId": "r", "bad": tru', "requestId")).toBe(
        "r",
      );
      expect(rootScalarOf('{"requestId": "r" "next": 1}', "next"))
        .toBeUndefined();
    });
  });
});

/** Counts the array elements and record members in a parsed JSON value. */
function countBuilt(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum: number, entry) => sum + 1 + countBuilt(entry), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce(
      (sum: number, entry) => sum + 1 + countBuilt(entry),
      0,
    );
  }
  return 0;
}
