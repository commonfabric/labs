import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fitColumns, prose } from "./prose.ts";
import { columns } from "./text.ts";

/** Where a Topic cited by its number links to. */
const topicHref = (number: string) => `https://fabric.example/top/${number}`;

/** `text` drawn `width` wide, as plain text. */
function plain(text: string, width = 30): string[] {
  return prose(text, width, topicHref).map((row) =>
    row.map((span) => span.text).join("")
  );
}

describe("prose", () => {
  describe("fitColumns()", () => {
    it("returns what each column wants when all fit", () => {
      expect(fitColumns([3, 5], [1, 2], [1, 1], 20)).toEqual([3, 5]);
    });

    it("returns what each needs and shares of the rest by how much more each wants", () => {
      expect(fitColumns([10, 30], [4, 4], [1, 1], 24)).toEqual([7, 17]);
    });

    it("returns, when not even what each needs fits, all a column of short words needs, and the rest to the longer", () => {
      expect(fitColumns([5, 30], [5, 20], [1, 1], 15)).toEqual([5, 10]);
      expect(fitColumns([10, 10], [8, 8], [2, 2], 6)).toEqual([3, 3]);
    });
  });

  describe("prose()", () => {
    it("draws headings, lists, quotes, code, emphasis, and links without their markup", () => {
      expect(
        plain(
          "# Title\n\n- one **two**\n  1. three\n\n> quoted\n\n```\ncode()\n```\n\n*soft* [link](https://x)",
        ),
      ).toEqual([
        "Title",
        "",
        "• one two",
        "  1. three",
        "",
        "│ quoted",
        "",
        "code()",
        "",
        "soft link",
      ]);
    });

    it("wraps at word boundaries, breaking a word longer than the width", () => {
      expect(plain("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
      expect(plain("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    it("puts a character wider than the width on a row of its own", () => {
      expect(plain("a 日本 b", 1)).toEqual(["a", "日", "本", "b"]);
    });

    it("measures an emoji of several code points as two columns, as terminals draw it", () => {
      for (const emoji of ["⚠️", "👨‍👩‍👧", "👍🏽", "🇺🇸"]) {
        expect(plain(emoji.repeat(3), 4)).toEqual([emoji.repeat(2), emoji]);
      }
    });

    it("wraps a word of a hundred thousand characters in one pass", () => {
      expect(plain("x".repeat(100_000), 50)).toEqual(
        Array(2000).fill("x".repeat(50)),
      );
    });

    it("joins the lines of a paragraph before wrapping them, keeping a hard break", () => {
      expect(plain("one two\nthree\nfour five", 10)).toEqual([
        "one two",
        "three four",
        "five",
      ]);
      expect(plain("one  \ntwo", 10)).toEqual(["one", "two"]);
    });

    it("hangs a wrapped list item's and quote's further rows at their indent", () => {
      expect(plain("- alpha beta gamma\n  delta", 12)).toEqual([
        "• alpha beta",
        "  gamma",
        "  delta",
      ]);
      expect(plain("> alpha beta gamma", 12)).toEqual([
        "│ alpha beta",
        "│ gamma",
      ]);
    });

    it("puts one space where a soft break meets a space, and keeps a blank line of code", () => {
      expect(plain("foo \nbar")).toEqual(["foo bar"]);
      expect(plain("```\na\n\n\nb\n```")).toEqual(["a", "", "", "b"]);
    });

    it("does not break at a non-breaking space, and drops an indent that leaves no room", () => {
      expect(plain("aaa bbb\u00a0ccc", 8)).toEqual(["aaa", "bbb\u00a0ccc"]);
      expect(plain("> > > > deep words", 8).every((row) => row.length > 1))
        .toBe(true);
    });

    it("cuts a code block's long line into rows rather than reflowing it", () => {
      expect(plain("```\nab  cd  ef\n```", 5)).toEqual(["ab  c", "d  ef"]);
    });

    it("keeps a cut line of code at its list item's indent, and leaves a Topic cited in code unlinked", () => {
      expect(plain("- ```\n  abcdefghij\n  ```", 8)).toEqual([
        "•",
        "  abcdef",
        "  ghij",
      ]);
      const spans = prose("`top/42` and top/7", 40, topicHref).flat();
      expect(spans.filter((s) => s.href !== undefined).map((s) => s.text))
        .toEqual(["top/7"]);
    });

    it("drops leading and trailing blank lines and collapses runs of blank lines", () => {
      expect(plain("\n\none\n\n\n\ntwo\n\n")).toEqual(["one", "", "two"]);
      expect(plain("\n\n")).toEqual([]);
    });

    it("links a link's text to where it points, and a Topic cited by its number to that Topic", () => {
      const spans = prose(
        "See [docs](https://docs.example) and top/42, not stop/42.",
        80,
        topicHref,
      ).flat();

      expect(
        spans.flatMap((s) => s.href === undefined ? [] : [[s.text, s.href]]),
      ).toEqual([
        ["docs", "https://docs.example"],
        ["top/42", "https://fabric.example/top/42"],
      ]);
    });

    it("cuts a rule to the width, and moves code's tabs to the next tab stop", () => {
      expect(plain("a\n\n---\n\nb", 10)).toEqual([
        "a",
        "",
        "─".repeat(10),
        "",
        "b",
      ]);
      expect(plain("```\nab\tc\n\td\n```", 30)).toEqual([
        "ab      c",
        "        d",
      ]);
    });

    it("lays a table out to the width, each cell wrapped in its column and aligned as the table says", () => {
      const table =
        "| Name | Says |\n|---|---:|\n| Ada | a long remark that wraps |\n| Bo | 7 |";

      expect(plain(table, 40)).toEqual([
        "│ Name │                     Says │",
        "├──────┼──────────────────────────┤",
        "│ Ada  │ a long remark that wraps │",
        "│ Bo   │                        7 │",
      ]);
      expect(plain(table, 22)).toEqual([
        "│ Name │        Says │",
        "├──────┼─────────────┤",
        "│ Ada  │      a long │",
        "│      │ remark that │",
        "│      │       wraps │",
        "├──────┼─────────────┤",
        "│ Bo   │           7 │",
      ]);
    });

    it("lays a table out within any width, a wide character never cut", () => {
      const table = "| Step | ✓ | Branch | Notes |\n|---|---|---|---|\n" +
        "| consolidate | ✅ | ianh/consolidate-memory-pass | rebased onto main |";

      for (let width = 8; width <= 80; width++) {
        for (const row of prose(table, width, topicHref)) {
          expect(columns(row.map((s) => s.text).join(""))).toBeLessThanOrEqual(
            width,
          );
        }
      }
      expect(plain(table, 30).join("\n")).toContain(" ✅ │");
    });

    it("lays a table out in a quote and in a list item, behind their marks", () => {
      expect(plain("> | a | b |\n> |---|---|\n> | x | y |", 20)).toEqual([
        "│ │ a │ b │",
        "│ ├───┼───┤",
        "│ │ x │ y │",
      ]);
      expect(plain("- item\n\n  | a | b |\n  |---|---|\n  | x | y |", 20))
        .toEqual(["• item", "", "  │ a │ b │", "  ├───┼───┤", "  │ x │ y │"]);
    });

    it("draws a character a terminal would act on as a glyph", () => {
      expect(plain("bell\u0007 here").join("")).not.toContain("\u0007");
    });
  });
});
