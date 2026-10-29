/**
 * `backtickQuote()` has to produce a span that survives being read back, and
 * the two rules that achieve it are independent.
 *
 * Choosing a delimiter longer than the longest backtick run inside is the
 * obvious half. The padding rule is the half that is easy to omit: text
 * beginning or ending with a backtick, or with a space at both ends, needs a
 * space inserted or the span closes early or loses a character. The cases here
 * cover both, including the ones where padding must NOT be added.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { backtickFence, backtickQuote } from "../src/markdown.ts";
import { parseCodeSpan } from "./parse-code-span.ts";

describe("markdown", () => {
  describe("backtickQuote()", () => {
    it("wraps ordinary text in a single pair of backticks", () => {
      expect(backtickQuote("hello")).toBe("`hello`");
      expect(backtickQuote("a b c")).toBe("`a b c`");
    });

    it("returns a bare pair of backticks for empty text", () => {
      expect(backtickQuote("")).toBe("``");
    });

    it("uses a longer delimiter than the longest run inside", () => {
      expect(backtickQuote("a`b")).toBe("``a`b``");
      expect(backtickQuote("a``b")).toBe("```a``b```");
      expect(backtickQuote("a```b``c")).toBe("````a```b``c````");
    });

    it("pads when the text starts or ends with a backtick", () => {
      expect(backtickQuote("`x")).toBe("`` `x ``");
      expect(backtickQuote("x`")).toBe("`` x` ``");
      expect(backtickQuote("`")).toBe("`` ` ``");
    });

    it("pads when the text both starts and ends with a space", () => {
      expect(backtickQuote(" x ")).toBe("`  x  `");
    });

    it("does not pad when only one end is a space", () => {
      expect(backtickQuote(" x")).toBe("` x`");
      expect(backtickQuote("x ")).toBe("`x `");
    });

    it("does not pad all-space text, which a reader leaves alone", () => {
      expect(backtickQuote(" ")).toBe("` `");
      expect(backtickQuote("   ")).toBe("`   `");
    });

    it("round-trips through a Markdown reader", () => {
      // The property that matters: parsing the result yields back the input.
      for (
        const text of [
          "hello",
          "a`b",
          "a``b",
          "`x",
          "x`",
          "`",
          "``",
          " x ",
          " x",
          "x ",
          " ",
          "   ",
          '{"a":1}',
          "Symbol(`odd`)",
        ]
      ) {
        expect(parseCodeSpan(backtickQuote(text))).toBe(text);
      }
    });
  });

  describe("backtickFence()", () => {
    it("wraps text in a pair of three-backtick fence lines", () => {
      expect(backtickFence("a\nb")).toBe("```\na\nb\n```");
    });

    it("returns two adjacent fence lines around an empty line for empty text", () => {
      expect(backtickFence("")).toBe("```\n\n```");
    });

    it("keeps a fence of three backticks for a shorter run inside", () => {
      expect(backtickFence("a``b")).toBe("```\na``b\n```");
    });

    it("uses a longer fence than the longest run inside", () => {
      expect(backtickFence("a```b")).toBe("````\na```b\n````");
      expect(backtickFence("`````")).toBe("``````\n`````\n``````");
    });
  });
});
