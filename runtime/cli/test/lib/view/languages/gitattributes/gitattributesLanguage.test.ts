import { expect } from "@std/expect";

import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { gitAttributesLanguage } from "../../../../../lib/view/languages/gitattributes/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** The spans of one line, as text and class. */
function spansOf(line: Line): [string, TokenClass][] {
  return line.spans.map((span) => [span.text, span.cls]);
}

/** The spans of a source's only line. */
function colored(source: string): [string, TokenClass][] {
  const lines = gitAttributesLanguage.highlightLines(source);
  expect(lines.length).toBe(1);
  return spansOf(lines[0]);
}

describe("gitAttributesLanguage", () => {
  describe("selection", () => {
    it("selects a .gitattributes file in any directory", () => {
      for (const path of [".gitattributes", "src/.gitattributes"]) {
        expect(languageForFile(path).id).toBe("gitattributes");
      }
    });

    it("leaves names that only resemble it to plain text", () => {
      for (const path of ["notes.gitattributes", ".gitattributes.orig"]) {
        expect(languageForSource(path, "*.png binary\n").id).toBe(
          "plain-text",
        );
      }
    });
  });

  describe("coloring", () => {
    it("colors a pattern, its wildcards, and each form of attribute", () => {
      expect(colored("docs/**/*.md text -diff !merge eol=lf")).toEqual([
        ["docs", "string"],
        ["/", "punctuation"],
        ["**", "regex"],
        ["/", "punctuation"],
        ["*", "regex"],
        [".md", "string"],
        [" ", "whitespace"],
        ["text", "propertyName"],
        [" ", "whitespace"],
        ["-", "operator"],
        ["diff", "propertyName"],
        [" ", "whitespace"],
        ["!", "operator"],
        ["merge", "propertyName"],
        [" ", "whitespace"],
        ["eol", "propertyName"],
        ["=", "operator"],
        ["lf", "string"],
      ]);
      expect(colored("a[!0-9]\\*? x")).toEqual([
        ["a", "string"],
        ["[!0-9]", "regex"],
        ["\\", "punctuation"],
        ["*", "string"],
        ["?", "regex"],
        [" ", "whitespace"],
        ["x", "propertyName"],
      ]);
    });

    it("leaves a value after an unset or unspecified attribute uncolored", () => {
      expect(colored("* -diff=x !eol=lf")).toEqual([
        ["*", "regex"],
        [" ", "whitespace"],
        ["-", "operator"],
        ["diff", "propertyName"],
        ["=x", "plain"],
        [" ", "whitespace"],
        ["!", "operator"],
        ["eol", "propertyName"],
        ["=lf", "plain"],
      ]);
    });

    it("colors a quoted pattern that holds blanks as one pattern", () => {
      expect(colored('"My Documents/*.txt" text')).toEqual([
        ['"My Documents', "string"],
        ["/", "punctuation"],
        ["*", "regex"],
        ['.txt"', "string"],
        [" ", "whitespace"],
        ["text", "propertyName"],
      ]);
      expect(colored('"a\\" b"x')).toEqual([
        ['"a\\" b"', "string"],
        ["x", "propertyName"],
      ]);
    });

    it("colors a quoted pattern's closing quote as a string", () => {
      expect(colored('"a*" x').slice(0, 3)).toEqual([
        ['"a', "string"],
        ["*", "regex"],
        ['"', "string"],
      ]);
      expect(colored('"[ab]" x').slice(0, 3)).toEqual([
        ['"', "string"],
        ["[ab]", "regex"],
        ['"', "string"],
      ]);
      expect(colored('"[attr]m" x').slice(0, 4)).toEqual([
        ['"', "string"],
        ["[attr]", "keyword"],
        ["m", "functionName"],
        ['"', "string"],
      ]);
    });

    it("reads a quoted pattern's wildcards after removing its quoting", () => {
      // Once unquoted, `\\t*` is a tab and then a wildcard, and `\\\\*` a
      // backslash that makes the `*` after it match itself.
      expect(colored('"caf\\303\\251\\t*/\\\\*" x')).toEqual([
        ['"caf\\303\\251\\t', "string"],
        ["*", "regex"],
        ["/\\\\", "punctuation"],
        ['*"', "string"],
        [" ", "whitespace"],
        ["x", "propertyName"],
      ]);
    });

    it("ends a quoted pattern at a NUL that an octal escape writes", () => {
      expect(colored('"a\\000*" x').slice(0, 2)).toEqual([
        ['"a\\000*"', "string"],
        [" ", "whitespace"],
      ]);
      expect(colored('"[attr]m\\000z" x').slice(0, 3)).toEqual([
        ['"', "string"],
        ["[attr]", "keyword"],
        ["m", "functionName"],
      ]);
    });

    it("reads a pattern whose quoting is not valid as though unquoted", () => {
      expect(colored('"foo bar')).toEqual([
        ['"foo', "string"],
        [" ", "whitespace"],
        ["bar", "propertyName"],
      ]);
      expect(colored('"a\\q" x')).toEqual([
        ['"a', "string"],
        ["\\", "punctuation"],
        ['q"', "string"],
        [" ", "whitespace"],
        ["x", "propertyName"],
      ]);
      expect(colored('"\\4"* x')).toEqual([
        ['"', "string"],
        ["\\", "punctuation"],
        ['4"', "string"],
        ["*", "regex"],
        [" ", "whitespace"],
        ["x", "propertyName"],
      ]);
    });

    it("colors a macro definition's prefix and name", () => {
      expect(colored("[attr]generated -diff linguist-generated")).toEqual([
        ["[attr]", "keyword"],
        ["generated", "functionName"],
        [" ", "whitespace"],
        ["-", "operator"],
        ["diff", "propertyName"],
        [" ", "whitespace"],
        ["linguist-generated", "propertyName"],
      ]);
      expect(colored('"[attr] m x" -diff')).toEqual([
        ['"', "string"],
        ["[attr]", "keyword"],
        [" ", "string"],
        ["m", "functionName"],
        [' x"', "string"],
        [" ", "whitespace"],
        ["-", "operator"],
        ["diff", "propertyName"],
      ]);
      // The prefix alone is a pattern, whose bracket expression it is.
      expect(colored("[attr] x")).toEqual([
        ["[attr]", "regex"],
        [" ", "whitespace"],
        ["x", "propertyName"],
      ]);
    });

    it("colors a comment only where it starts a line", () => {
      const lines = gitAttributesLanguage.highlightLines(
        "  # comment\n*.sh text # note",
      );
      expect(spansOf(lines[0])).toEqual([
        ["  ", "whitespace"],
        ["# comment", "comment"],
      ]);
      // `#` is not a name Git accepts, so it ignores the line.
      expect(spansOf(lines[1])).toEqual([
        ["*.sh", "plain"],
        [" ", "whitespace"],
        ["text", "plain"],
        [" ", "whitespace"],
        ["#", "plain"],
        [" ", "whitespace"],
        ["note", "plain"],
      ]);
    });

    it("leaves each line that Git ignores uncolored", () => {
      for (
        const source of [
          "* --x",
          "* builtin_objectmode=1",
          "[attr]-x y",
          "[attr]builtin_x y",
          "!*.log text",
          "a".repeat(2043) + " text",
          "é".repeat(1022) + " text",
          "☕".repeat(682) + " text",
        ]
      ) {
        expect(
          gitAttributesLanguage.highlightLines(source)[0].spans.filter((span) =>
            span.cls !== "plain" && span.cls !== "whitespace"
          ),
        ).toEqual([]);
        expect(gitAttributesLanguage.parseDocument(source).structure).toEqual(
          [],
        );
      }
      for (
        const source of [
          "a".repeat(2042) + " text",
          "😀".repeat(510) + " text",
          "☕".repeat(680) + " text",
          "\\!*.log text",
        ]
      ) {
        expect(colored(source).at(-1)).toEqual(["text", "propertyName"]);
      }
      // Git drops a carriage return before a line feed before it measures the
      // line, and keeps one that ends the file.
      const crlf = gitAttributesLanguage.highlightLines(
        "a".repeat(2042) + " text\r\n" + "a".repeat(2042) + " text\r",
      );
      expect(spansOf(crlf[0]).at(-2)).toEqual(["text", "propertyName"]);
      expect(spansOf(crlf[1]).at(-2)).toEqual(["text", "plain"]);
    });

    it("treats a carriage return as a blank", () => {
      const lines = gitAttributesLanguage.highlightLines("*.bat eol=crlf\r\n");
      expect(spansOf(lines[0]).slice(-2)).toEqual([
        ["crlf", "string"],
        ["\r", "whitespace"],
      ]);
    });
  });

  describe("structure", () => {
    it("lists each pattern and macro, and indexes each macro's name", () => {
      const source = [
        "# Generated files.",
        "[attr]generated -diff",
        "",
        "dist/** generated",
        '"a b" text',
      ].join("\n");
      const document = gitAttributesLanguage.parseDocument(source);

      expect(document.structure.map((node) => [node.kind, node.label])).toEqual(
        [
          ["function", "[attr]generated"],
          ["object", "dist/**"],
          ["object", '"a b"'],
        ],
      );
      expect(document.structure[1]).toMatchObject({
        startLine: 3,
        endLine: 3,
        startCol: 0,
        endCol: 17,
      });
      expect([...document.definitions.keys()]).toEqual(["generated"]);
      expect(document.definitions.get("generated")![0].startLine).toBe(1);
      expect(verbatim(document.lines)).toBe(source);
    });
  });

  it("recolors each edit with a recoloring highlighter", () => {
    const highlighter = gitAttributesLanguage.createHighlighter("*.sh text");
    expect(highlighter.update("*.sh text")).toBe(highlighter.lines);
    const updated = highlighter.update("*.sh -text");
    expect(spansOf(updated[0]).slice(-2)).toEqual([
      ["-", "operator"],
      ["text", "propertyName"],
    ]);
    expect(highlighter.lines).toBe(updated);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of [
        '"unclosed *.x',
        "a[",
        "[attr",
        "x =",
        "\\",
        "",
        "# ☕ 😀\n",
      ]
    ) {
      expect(verbatim(gitAttributesLanguage.highlightLines(source))).toBe(
        source,
      );
    }
  });
});
