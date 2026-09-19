import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  debugStr,
  toCompactDebugString,
  toIndentedDebugString,
  toLongQuotedDebugString,
  toShortQuotedDebugString,
} from "@/index.ts";

/** A value whose compact rendering runs past 5000 characters. */
const BIG = {
  text: "x".repeat(150),
  list: Array.from({ length: 90 }, () => "y".repeat(100)),
};

/** A value whose indented rendering runs past 500 lines. */
const TALL = Array.from({ length: 95 }, (_, i) => [i, [i], { i }]);

describe("debugStr()", () => {
  describe("with no directive", () => {
    it("returns the text alone for a template with no substitution", () => {
      expect(debugStr`just text`).toBe("just text");
      expect(debugStr``).toBe("");
    });

    it("returns what a template literal would for ordinary values", () => {
      const values = [1, -0, 2n, "str", true, null, undefined, [1, 2], {}];
      for (const value of values) {
        expect(debugStr`a ${value} b`).toBe(`a ${value} b`);
      }
    });

    it("returns a symbol as `String()` converts it", () => {
      expect(debugStr`${Symbol("s")}`).toBe("Symbol(s)");
    });

    it("returns the default debug rendering for a value whose `toString()` throws", () => {
      const value = {
        toString() {
          throw new Error("no");
        },
      };
      expect(debugStr`value: ${value}`)
        .toBe(`value: ${toCompactDebugString(value, { maxLength: 50 })}`);
    });

    it("returns the text as written when it merely holds a dollar sign", () => {
      expect(debugStr`costs $${5} or $5${"!"} or US$ ${1}`)
        .toBe("costs $5 or $5! or US$ 1");
    });
  });

  describe("with a compact directive", () => {
    it("returns the compact rendering cut to 50 characters for `short`", () => {
      const expected = toCompactDebugString(BIG, { maxLength: 50 });
      expect(expected.length).toBe(50);
      expect(debugStr`v: $short${BIG}.`).toBe(`v: ${expected}.`);
    });

    it("returns the compact rendering cut to 500 characters for `long`", () => {
      const expected = toCompactDebugString(BIG, { maxLength: 500 });
      expect(expected.length).toBe(500);
      expect(debugStr`v: $long${BIG}.`).toBe(`v: ${expected}.`);
    });

    it("returns the compact rendering cut to 5000 characters for `xlong`", () => {
      const expected = toCompactDebugString(BIG, { maxLength: 5000 });
      expect(expected.length).toBe(5000);
      expect(debugStr`v: $xlong${BIG}.`).toBe(`v: ${expected}.`);
    });

    it("returns what `toShortQuotedDebugString()` does for `quote`", () => {
      expect(debugStr`v: $quote${BIG}.`)
        .toBe(`v: ${toShortQuotedDebugString(BIG)}.`);
    });

    it("returns what `toLongQuotedDebugString()` does for `quote,long`", () => {
      const expected = `v: ${toLongQuotedDebugString(BIG)}.`;
      expect(debugStr`v: $quote,long${BIG}.`).toBe(expected);
      expect(debugStr`v: $long,quote${BIG}.`).toBe(expected);
    });

    it("returns a rendering per substitution, each by its own directive", () => {
      expect(debugStr`${"kind"}: $quote${[1]} and $long${{ a: 2n }}`)
        .toBe("kind: `[1]` and {a:2n}");
    });
  });

  describe("with `indent`", () => {
    it("returns the indented rendering whole when it fits", () => {
      const value = { a: 1 };
      expect(debugStr`v: $indent${value}.`)
        .toBe(`v: ${toIndentedDebugString(value)}.`);
    });

    it("returns the first 5 lines and then the line count, by default", () => {
      const lines = toIndentedDebugString(TALL).split("\n");
      const expected = [...lines.slice(0, 5), `... lines: ${lines.length}`];
      expect(lines.length).toBeGreaterThan(500);
      expect(debugStr`$indent${TALL}`).toBe(expected.join("\n"));
      expect(debugStr`$indent,short${TALL}`).toBe(expected.join("\n"));
    });

    it("returns the first 50 lines and then the line count for `long`", () => {
      const lines = toIndentedDebugString(TALL).split("\n");
      const expected = [...lines.slice(0, 50), `... lines: ${lines.length}`];
      expect(debugStr`$indent,long${TALL}`).toBe(expected.join("\n"));
    });

    it("returns the first 500 lines and then the line count for `xlong`", () => {
      const lines = toIndentedDebugString(TALL).split("\n");
      const expected = [...lines.slice(0, 500), `... lines: ${lines.length}`];
      expect(debugStr`$indent,xlong${TALL}`).toBe(expected.join("\n"));
    });

    it("returns a rendering of exactly the line limit whole", () => {
      const value = [1, 2, 3];
      expect(toIndentedDebugString(value).split("\n").length).toBe(5);
      expect(debugStr`$indent${value}`).toBe(toIndentedDebugString(value));
    });
  });

  describe("with `indent` and `quote`", () => {
    it("returns the rendering as a fenced block on lines of its own", () => {
      expect(debugStr`Bad value: $quote,indent${{ a: 1 }} Try again.`)
        .toBe("Bad value: \n```\n{\n  a: 1\n}\n```\n Try again.");
    });

    it("returns no line break beyond the ones the text supplies", () => {
      expect(debugStr`Bad value:\n$quote,indent${{ a: 1 }}\nTry again.`)
        .toBe("Bad value:\n```\n{\n  a: 1\n}\n```\nTry again.");
    });

    it("returns no line break at either end of the result", () => {
      expect(debugStr`$quote,indent${[]}`).toBe("```\n[]\n```");
    });

    it("returns a line break between a block and a substitution right after it", () => {
      expect(debugStr`a $quote,indent${[]}${"next"} b`)
        .toBe("a \n```\n[]\n```\nnext b");
    });

    it("returns one line break between two blocks in a row", () => {
      expect(debugStr`$quote,indent${[]}$quote,indent${[1]}`)
        .toBe("```\n[]\n```\n```\n[\n  1\n]\n```");
    });

    it("returns a cut rendering with its line count inside the fence", () => {
      const lines = toIndentedDebugString(TALL).split("\n");
      const expected = [
        "```",
        ...lines.slice(0, 5),
        `... lines: ${lines.length}`,
        "```",
      ];
      expect(debugStr`$quote,indent${TALL}`).toBe(expected.join("\n"));
    });

    it("returns a fence longer than a backtick run in the rendering", () => {
      expect(debugStr`$quote,indent${"a```b"}`).toBe('````\n"a```b"\n````');
    });
  });

  describe("with an escaped directive", () => {
    it("returns the directive as text and the value converted plainly", () => {
      expect(debugStr`v: \$quote${[1, 2]}`).toBe("v: $quote1,2");
    });

    it("returns a backslash and the rendering for an escaped backslash", () => {
      expect(debugStr`v: \\$quote${[1, 2]}`).toBe("v: \\`[1,2]`");
    });
  });

  describe("with a directive holding an unknown word", () => {
    it("returns the directive as text and the default debug rendering", () => {
      // The misspelling is what is under test.
      // deno-lint-ignore cf-debug-str/valid-directive
      expect(debugStr`v: $qoute,long${BIG}`)
        .toBe(`v: $qoute,long${toCompactDebugString(BIG, { maxLength: 50 })}`);
    });
  });

  it("returns a directive at the very end of a template as text", () => {
    expect(debugStr`${1} costs $long`).toBe("1 costs $long");
  });

  it("returns the larger cut when a directive holds two size words", () => {
    // The second size word is what is under test.
    // deno-lint-ignore cf-debug-str/valid-directive
    expect(debugStr`$short,long${BIG}`)
      .toBe(toCompactDebugString(BIG, { maxLength: 500 }));
  });

  it("returns a fresh result for each call from one call site", () => {
    const render = (value: unknown) => debugStr`v: $quote${value}`;
    expect(render(1)).toBe("v: `1`");
    expect(render("two")).toBe('v: `"two"`');
  });
});
