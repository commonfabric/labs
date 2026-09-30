import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  decodeJsonPointer,
  encodeJsonPointer,
} from "@commonfabric/utils/json-pointer";

describe("json-pointer", () => {
  describe("encodeJsonPointer()", () => {
    it("joins plain tokens with `/`", () => {
      expect(encodeJsonPointer(["a", "b", "0"])).toBe("a/b/0");
    });

    it("keeps an empty leading token as a leading `/`", () => {
      expect(encodeJsonPointer(["", "a"])).toBe("/a");
    });

    it("escapes `~` before `/`, so a token holding `~1` does not read as `/`", () => {
      expect(encodeJsonPointer(["a/b"])).toBe("a~1b");
      expect(encodeJsonPointer(["a~b"])).toBe("a~0b");
      expect(encodeJsonPointer(["~1"])).toBe("~01");
    });
  });

  describe("decodeJsonPointer()", () => {
    it("splits on `/` and keeps an empty leading token", () => {
      expect(decodeJsonPointer("/a/b")).toEqual(["", "a", "b"]);
    });

    it("unescapes `~1` before `~0`, so `~01` reads as `~1`", () => {
      expect(decodeJsonPointer("a~1b")).toEqual(["a/b"]);
      expect(decodeJsonPointer("a~0b")).toEqual(["a~b"]);
      expect(decodeJsonPointer("~01")).toEqual(["~1"]);
    });

    it("returns the tokens `encodeJsonPointer()` was given", () => {
      const tokens = ["", "#", "$defs", "a/b~c", ""];
      expect(decodeJsonPointer(encodeJsonPointer(tokens))).toEqual(tokens);
    });
  });
});
