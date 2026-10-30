import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EXCERPT_CODE_POINTS,
  excerptOf,
  locateQuote,
  resolveAnchor,
} from "./anchors.ts";

describe("anchors", () => {
  describe("locateQuote()", () => {
    it("returns the start of a quote the text holds once", () => {
      expect(locateQuote("one two three", "two")).toBe(4);
    });

    it("returns `empty` for an empty quote, whatever the text", () => {
      expect(locateQuote("one two", "")).toBe("empty");
      expect(locateQuote("", "")).toBe("empty");
    });

    it("returns `absent` for a quote the text holds nowhere", () => {
      expect(locateQuote("one two three", "four")).toBe("absent");
    });

    it("returns `repeated` for a quote the text holds more than once", () => {
      expect(locateQuote("two one two", "two")).toBe("repeated");
    });

    it("compares code unit for code unit, so case and spacing count", () => {
      expect(locateQuote("one two", "Two")).toBe("absent");
      expect(locateQuote("one  two", "one two")).toBe("absent");
    });
  });

  describe("resolveAnchor()", () => {
    it("returns the stored range while the text holds the quote there", () => {
      expect(resolveAnchor("two one two", { from: 8, to: 11, quote: "two" }))
        .toEqual({ from: 8, to: 11 });
    });

    it("returns the one place the quote occurs once the stored range no longer holds it", () => {
      expect(resolveAnchor("oh one two", { from: 4, to: 7, quote: "two" }))
        .toEqual({ from: 7, to: 10 });
    });

    it("returns `null` for a quote the text has lost", () => {
      expect(resolveAnchor("one three", { from: 4, to: 7, quote: "two" }))
        .toBeNull();
    });

    it("returns `null` for a quote the text holds more than once and not at the stored range", () => {
      expect(resolveAnchor("two one two", { from: 0, to: 3, quote: "one" }))
        .toEqual({ from: 4, to: 7 });
      expect(resolveAnchor("two one two", { from: 4, to: 7, quote: "two" }))
        .toBeNull();
    });

    it("returns `null` for an empty quote, even at a stored range it trivially matches", () => {
      expect(resolveAnchor("one two", { from: 3, to: 3, quote: "" }))
        .toBeNull();
    });
  });

  describe("excerptOf()", () => {
    it("returns a short quote as it is", () => {
      expect(excerptOf("a short quote")).toBe("a short quote");
    });

    it("collapses line breaks and runs of spaces to one space, and trims", () => {
      expect(excerptOf("  two\n\nlines   here ")).toBe("two lines here");
    });

    it("cuts a long quote to the excerpt length in code points, with an ellipsis", () => {
      const quote = "😀".repeat(EXCERPT_CODE_POINTS + 1);
      expect(excerptOf(quote)).toBe("😀".repeat(EXCERPT_CODE_POINTS) + "…");
      expect(excerptOf("x".repeat(EXCERPT_CODE_POINTS))).toBe(
        "x".repeat(EXCERPT_CODE_POINTS),
      );
    });
  });
});
