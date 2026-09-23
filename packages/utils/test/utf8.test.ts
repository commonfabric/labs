/**
 * `utf8Compare()` exists because JavaScript's own string comparison is not
 * UTF-8 order, and these cases are where the two disagree.
 *
 * Ordinary strings and prefixes are the easy half. The astral-plane cases are
 * the reason the function is not `a < b`: those characters are stored as
 * surrogate pairs, whose UTF-16 code units sort differently from the UTF-8
 * bytes any other implementation would compare, so a sort that crosses a
 * process boundary needs this one to agree with itself on both sides.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { utf8Compare, utf8SortedKeysOf } from "@commonfabric/utils/utf8";

describe("utf8Compare()", () => {
  it("returns `0` for two equal UTF-8 strings", () => {
    expect(utf8Compare("abc", "abc")).toBe(0);
  });

  it("returns a negative number if `first < second`", () => {
    expect(utf8Compare("abc", "def")).toBeLessThan(0);
  });

  it("returns a positive number if `first > second`", () => {
    expect(utf8Compare("def", "abc")).toBeGreaterThan(0);
  });

  it("returns a negative number if `first` is a prefix of `second`", () => {
    expect(utf8Compare("abc", "abcd")).toBeLessThan(0);
  });

  it("returns a positive number if `second` is a prefix of `first`", () => {
    expect(utf8Compare("abcd", "abc")).toBeGreaterThan(0);
  });

  describe("strings with astral-plane characters", () => {
    it("returns `0` for two equal astral-plane characters", () => {
      expect(utf8Compare("😊", "😊")).toBe(0);
    });

    it("returns a negative number if `first < second`", () => {
      expect(utf8Compare("😊", "😎")).toBeLessThan(0);
    });

    it("returns a positive number if `first > second`", () => {
      expect(utf8Compare("😎", "😊")).toBeGreaterThan(0);
    });

    it("returns `0` for two equal multi-character strings with astral-plane characters", () => {
      expect(utf8Compare("happy 😊😊 folks", "happy 😊😊 folks")).toBe(0);
    });

    it("returns a negative number if `first < second` for multi-character strings with _same_ astral-plane characters", () => {
      expect(utf8Compare("What 😊 is a biscuit?", "What 😊 is a muffin?"))
        .toBeLessThan(0);
    });

    it("returns a positive number if `first > second` for multi-character strings with _same_ astral-plane characters", () => {
      expect(utf8Compare("What 😊 is a muffin?", "What 😊 is a biscuit?"))
        .toBeGreaterThan(0);
    });

    it("sorts astral plane characters after non-astral-plane characters", () => {
      const firstAstral = String.fromCodePoint(0x10000);

      expect(utf8Compare("\x00", firstAstral)).toBeLessThan(0);
      expect(utf8Compare("\uffff", firstAstral)).toBeLessThan(0);
      expect(utf8Compare(firstAstral, "\x00")).toBeGreaterThan(0);
      expect(utf8Compare(firstAstral, "\uffff")).toBeGreaterThan(0);

      for (let ch = 123; ch < 0xffff; ch += 876) {
        const str = String.fromCharCode(ch);
        expect(utf8Compare(str, firstAstral)).toBeLessThan(0);
        expect(utf8Compare(firstAstral, str)).toBeGreaterThan(0);
      }
    });
  });

  describe("strings with lone surrogates", () => {
    it("sorts a lone surrogate as the code point of the same value", () => {
      expect(utf8Compare("\ud7ff", "\ud800")).toBeLessThan(0);
      expect(utf8Compare("\ud800", "\udc00")).toBeLessThan(0);
      expect(utf8Compare("\udfff", "\ue000")).toBeLessThan(0);
      expect(utf8Compare("\udfff", "\u{10000}")).toBeLessThan(0);
    });

    it("sorts a pair after the same high surrogate standing alone", () => {
      // The strings share their first code unit but not their first code
      // point: a pair on one side, a lone high surrogate on the other. What
      // follows the lone one does not matter.
      const pair = "\ud800\udc00";

      for (const alone of ["\ud800x", "\ud800\ue000", "\ud800\ud801\udc00"]) {
        expect(utf8Compare(pair, alone)).toBeGreaterThan(0);
        expect(utf8Compare(alone, pair)).toBeLessThan(0);
      }
    });

    it("compares what follows two lone high surrogates that are the same", () => {
      expect(utf8Compare("\ud800\ud801", "\ud800\ud802")).toBeLessThan(0);
      expect(utf8Compare("\ud800\ue000", "\ud800x")).toBeGreaterThan(0);
    });
  });
});

describe("utf8SortedKeysOf()", () => {
  it("returns a sorted array of keys for an object", () => {
    const obj = { b: 2, a: 1, c: 3 };
    const sorted = utf8SortedKeysOf(obj);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("returns the keys of an object that has just one", () => {
    expect(utf8SortedKeysOf({ solo: 1 })).toEqual(["solo"]);
  });

  it("returns an empty array for an object with no keys", () => {
    expect(utf8SortedKeysOf({})).toEqual([]);
  });

  it("returns keys that arrive already in order, in that order", () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(utf8SortedKeysOf(obj)).toEqual(["a", "b", "c"]);
  });

  it("sorts keys that are in UTF-16 order but not UTF-8 order", () => {
    // `"\u{10000}"` is a surrogate pair, so by UTF-16 code unit it comes
    // before `"￿"`; by code point, which is what UTF-8 byte order
    // follows, it comes after. Arriving in UTF-16 order is arriving out of
    // order, and has to be sorted.
    const obj = { "\u{10000}": 1, "￿": 2 };
    expect(utf8SortedKeysOf(obj)).toEqual(["￿", "\u{10000}"]);
  });

  it("returns a frozen value", () => {
    const obj = { beep: "x", bop: "y", awOOOOga: "z" };
    const sorted = utf8SortedKeysOf(obj);
    expect(Object.isFrozen(sorted)).toBe(true);
  });

  it("returns a frozen value for keys that arrive already in order", () => {
    const sorted = utf8SortedKeysOf({ awOOOOga: "z", beep: "x", bop: "y" });
    expect(Object.isFrozen(sorted)).toBe(true);
  });

  it("returns the same (`===`) value on two different calls, given the same frozen object", () => {
    const obj = Object.freeze({
      "what": [],
      "a": [1, 2, 3],
      "feeling": [4],
      "to": -99,
      "be": null,
      "alive": true,
    });
    const sorted1 = utf8SortedKeysOf(obj);
    const sorted2 = utf8SortedKeysOf(obj);
    expect(sorted1).toBe(sorted2);
  });
});
