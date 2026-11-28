/**
 * The Lean scanner reads every character of a source, so characters that no
 * Lean rule names do not stop it from coloring and structuring what follows.
 */

import { assertEquals } from "@std/assert";
import { test } from "@commonfabric/test-support/test";
import { leanDocument, leanLines } from "../lib/view/languages/lean/lean.ts";

/** Returns the text and class of each span of the first line of `text`. */
const classes = (text: string) =>
  leanLines(text)[0].spans.map(({ text, cls }) => [text, cls]);

test("lean scanner classes characters no rule names and reads on", () => {
  // NUL and a lone surrogate are operators, and the line and paragraph
  // separators and the carriage return are white space.
  assertEquals(classes("x \0\uD800\u2028\r\u2029:= 1 -- c"), [
    ["x", "identifier"],
    [" ", "whitespace"],
    ["\0\uD800", "operator"],
    ["\u2028\r\u2029", "whitespace"],
    [":=", "operator"],
    [" ", "whitespace"],
    ["1", "number"],
    [" ", "whitespace"],
    ["-- c", "comment"],
  ]);
  // The same tail without the comment marker is not a comment.
  assertEquals(classes("x \0\uD800 1 c").slice(-3), [
    ["1", "number"],
    [" ", "whitespace"],
    ["c", "identifier"],
  ]);
});

test("lean structure lists declarations after characters no rule names", () => {
  const text = "def a\uD800 := 1\ntheorem b : True := trivial";
  assertEquals(
    leanDocument(text).flatStructure.map(({ label, startLine, endLine }) => ({
      label,
      startLine,
      endLine,
    })),
    [
      { label: "def a", startLine: 0, endLine: 0 },
      { label: "theorem b", startLine: 1, endLine: 1 },
    ],
  );
});
