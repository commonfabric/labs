import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { center, clip, linkable, span, take, wrap } from "./text.ts";

/** `rows` as text. */
function text(rows: readonly { text: string }[][]): string[] {
  return rows.map((row) => row.map((s) => s.text).join(""));
}

describe("text", () => {
  describe("linkable()", () => {
    it("returns `true` only for an address on the web", () => {
      expect(linkable("https://example.com/a")).toBe(true);
      expect(linkable("HTTP://example.com")).toBe(true);
      expect(linkable("file:///etc/passwd")).toBe(false);
      expect(linkable("javascript:alert(1)")).toBe(false);
      expect(linkable(undefined)).toBe(false);
    });
  });

  describe("clip()", () => {
    it("returns the text on one line, cut with an ellipsis where it does not fit", () => {
      expect(clip("one\n  two", 20)).toBe("one two");
      expect(clip("abcdef", 4)).toBe("abc…");
      expect(clip("日本語", 4)).toBe("日…");
    });
  });

  describe("take()", () => {
    it("returns the longest start that fits, never half a wide character", () => {
      expect(take("ab日c", 3)).toBe("ab");
      expect(take("ab日c", 4)).toBe("ab日");
    });
  });

  describe("center()", () => {
    it("returns the text with as much space before it as half what is left", () => {
      expect(center("ab", 7)).toBe("  ab");
    });
  });

  describe("wrap()", () => {
    it("returns rows broken at spaces, later rows hung at the indent given", () => {
      const rows = wrap([span("one two three four")], 9, [span("  ")]);

      expect(text(rows)).toEqual(["one two", "  three", "  four"]);
    });

    it("keeps a bullet on the row its text starts on", () => {
      const rows = wrap(
        [span("•"), span(" "), span("unbreakable")],
        6,
        [span("  ")],
      );

      expect(text(rows)[0]).toBe("• unbr");
    });

    it("breaks no word where its style changes", () => {
      const rows = wrap(
        [span("aaaa bb"), span("cc", { bold: true }), span("dd. ee")],
        8,
      );

      expect(text(rows)).toEqual(["aaaa", "bbccdd.", "ee"]);
    });

    it("moves a word that would overrun the first row to the next, however short the first row's text", () => {
      // The first row's "a" is no wider than the hang, so it is not held to
      // the rule for a row holding only its indent.
      expect(text(wrap([span("a bbbbb")], 6, [span(" ")]))).toEqual([
        "a",
        " bbbbb",
      ]);
      expect(text(wrap([span("a bbbb")], 6, [span(" ")]))).toEqual([
        "a bbbb",
      ]);
    });

    it("keeps the whitespace the first row starts with", () => {
      expect(text(wrap([span("  a b")], 10))).toEqual(["  a b"]);
    });
  });
});
