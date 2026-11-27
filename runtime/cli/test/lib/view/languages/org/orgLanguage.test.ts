import { expect } from "@std/expect";

import {
  languageForFile,
  prepareLanguages,
} from "../../../../../lib/view/languages/language.ts";
import { orgLanguage } from "../../../../../lib/view/languages/org/language.ts";
import { shellLanguage } from "../../../../../lib/view/languages/shell/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

// Source blocks are colored through their languages' synchronous entry
// points, which show plain text until the language's parser has loaded.
await prepareLanguages([shellLanguage]);

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Every distinct class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.spans.filter((span) => span.text === text).map((span) => span.cls)
      ),
    ),
  ];
}

/** The classes of each span on one line, other than white space. */
function spansOf(source: string, line: number): [string, TokenClass][] {
  return orgLanguage.highlightLines(source)[line].spans
    .filter((span) => span.cls !== "whitespace")
    .map((span) => [span.text, span.cls]);
}

/** Each structure entry's label, name, depth, and first and last lines. */
function outline(
  source: string,
): [string, string | undefined, number, number, number][] {
  return orgLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.name,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

describe("orgLanguage", () => {
  it("selects `.org` files in any case, and no other name", () => {
    expect(languageForFile("scenarios.org").id).toBe("org");
    expect(languageForFile("notes/PLAN.ORG").id).toBe("org");
    expect(languageForFile("org").id).toBe("plain-text");
    expect(languageForFile("example.org.txt").id).toBe("plain-text");
  });

  it("colors a headline's stars, to-do keyword, priority, title, and tags", () => {
    expect(spansOf("** TODO [#A] Ship ~cf view~ :cli:org:", 0)).toEqual([
      ["**", "sectionHeader"],
      ["TODO", "keyword"],
      ["[#A]", "keyword"],
      ["Ship", "sectionHeader"],
      ["~cf view~", "string"],
      [":cli:org:", "typeName"],
    ]);
    // A word is a keyword only in the keyword's place, and a line needs a
    // space after its stars to be a headline.
    expect(spansOf("* Notes TODO", 0)).toEqual([
      ["*", "sectionHeader"],
      ["Notes", "sectionHeader"],
      ["TODO", "sectionHeader"],
    ]);
    expect(classesOf(orgLanguage.highlightLines("*bold* text"), "*bold*"))
      .toEqual(["plain"]);
  });

  it("reads a headline with several spaces after its stars, and tags after long white space", () => {
    expect(spansOf("**  TODO   Title", 0)).toEqual([
      ["**", "sectionHeader"],
      ["TODO", "keyword"],
      ["Title", "sectionHeader"],
    ]);
    expect(outline("*   Title")).toEqual([["* Title", "Title", 0, 0, 0]]);
    expect(orgLanguage.parseDocument("*   Title").flatStructure[0].nameOffset)
      .toBe(4);

    // White space that no tags follow is part of the title, however long.
    const spaces = " \t".repeat(50_000);
    expect(spansOf(`* a${spaces}x`, 0).map(([text]) => text)).toEqual([
      "*",
      "a",
      "x",
    ]);
    // So are unclosed links and code markers.
    const links = "[[x ".repeat(25_000);
    expect(spansOf(links, 0).every(([, cls]) => cls === "plain")).toBe(true);
    const code = "~a ".repeat(33_000);
    expect(spansOf(code, 0).every(([, cls]) => cls === "plain")).toBe(true);
    expect(spansOf(`* a${spaces}:tag:`, 0).at(-1)).toEqual([
      ":tag:",
      "typeName",
    ]);
    expect(spansOf("* :tag:", 0)).toEqual([
      ["*", "sectionHeader"],
      [":tag:", "typeName"],
    ]);
    expect(spansOf("* a :not:tag", 0).at(-1)).toEqual([
      ":not:tag",
      "sectionHeader",
    ]);
  });

  it("reads the to-do keywords a file declares in place of the default ones", () => {
    const source = [
      "#+TODO: WAIT(w) NEXT",
      "#+SEQ_TODO: | FIXED(f!)",
      "* WAIT first",
      "* NEXT second",
      "* FIXED third",
      "* TODO fourth",
    ].join("\n");
    const lines = orgLanguage.highlightLines(source);
    for (const word of ["WAIT", "NEXT", "FIXED"]) {
      expect(classesOf(lines, word)).toEqual(["keyword"]);
    }
    expect(classesOf(lines, "TODO")).toEqual(["sectionHeader"]);
    expect(spansOf(source, 0)).toEqual([
      ["#+TODO:", "keyword"],
      ["WAIT(w) NEXT", "string"],
    ]);

    // A word's fast-access key is the parenthesized text that ends it.
    const parentheses = "A(".repeat(50_000);
    const declared = orgLanguage.highlightLines(
      `#+TODO: ${parentheses}\n* ${parentheses}\n* B(x)`,
    );
    expect(classesOf(declared, parentheses)).toEqual(["string", "keyword"]);
    expect(classesOf(declared, "B(x)")).toEqual(["sectionHeader"]);

    // A declaration quoted in a literal block declares nothing.
    const quoted = orgLanguage.highlightLines(
      "* TODO Write\n#+begin_example\n#+TODO: NEXT | DONE\n#+end_example",
    );
    expect(classesOf(quoted, "TODO")).toEqual(["keyword"]);
  });

  it("nests each headline's section in the one above it", () => {
    const source = [
      "#+TITLE: Plan",
      "* Goal",
      "text",
      "",
      "** DONE Part [#B] one :a:",
      "*** Detail",
      "",
      "** Part two",
      "* ",
      "*** Deep",
      "body",
      "",
    ].join("\n");
    expect(outline(source)).toEqual([
      ["* Goal", "Goal", 0, 1, 7],
      ["** Part [#B] one", "Part [#B] one", 1, 4, 5],
      ["*** Detail", "Detail", 2, 5, 5],
      ["** Part two", "Part two", 1, 7, 7],
      ["*", undefined, 0, 8, 10],
      ["*** Deep", "Deep", 1, 9, 10],
    ]);
    expect(orgLanguage.parseDocument(source).definitions.get("Detail"))
      .toHaveLength(1);
  });

  it("colors keywords, comments, fixed-width lines, drawers, and planning", () => {
    const source = [
      "#+TITLE: The plan",
      "# a comment",
      "#not a comment",
      ": fixed width",
      ":PROPERTIES:",
      ":ID:       abc-123",
      ":END:",
      ":ID: outside a drawer",
      "SCHEDULED: <2026-11-13 Fri> DEADLINE: <2026-11-20 Fri>",
      "CLOCK: [2026-11-13 Fri 09:00]--[2026-11-13 Fri 10:00] =>  1:00",
      "-----",
      ":PROPRIÉTÉS:",
    ].join("\n");
    expect(spansOf(source, 0)).toEqual([
      ["#+TITLE:", "keyword"],
      ["The plan", "string"],
    ]);
    expect(spansOf(source, 1)).toEqual([["# a comment", "comment"]]);
    expect(spansOf(source, 2)).toEqual([["#not", "plain"], ["a", "plain"], [
      "comment",
      "plain",
    ]]);
    expect(spansOf(source, 3)).toEqual([[": fixed width", "string"]]);
    expect(spansOf(source, 4)).toEqual([[":PROPERTIES:", "keyword"]]);
    expect(spansOf(source, 5)).toEqual([
      [":ID:", "propertyName"],
      ["abc-123", "string"],
    ]);
    expect(spansOf(source, 6)).toEqual([[":END:", "keyword"]]);
    expect(spansOf(source, 7)[0]).toEqual([":ID:", "plain"]);
    expect(spansOf(source, 11)).toEqual([[":PROPRIÉTÉS:", "keyword"]]);

    // A property drawer with no end before the next headline holds no
    // properties.
    const unclosed = [
      ":PROPERTIES:",
      ":ID: 1",
      "* Next",
      ":END:",
    ].join("\n");
    expect(spansOf(unclosed, 0)).toEqual([[":PROPERTIES:", "keyword"]]);
    expect(spansOf(unclosed, 1)[0]).toEqual([":ID:", "plain"]);

    // A property with no value leaves the drawer open.
    const empty = [":PROPERTIES:", ":ARCHIVE:", ":ID: 123", ":END:"].join(
      "\n",
    );
    expect(spansOf(empty, 1)).toEqual([[":ARCHIVE:", "propertyName"]]);
    expect(spansOf(empty, 2)).toEqual([
      [":ID:", "propertyName"],
      ["123", "string"],
    ]);
    expect(spansOf(empty, 3)).toEqual([[":END:", "keyword"]]);
    expect(spansOf(source, 8)).toEqual([
      ["SCHEDULED:", "keyword"],
      ["<2026-11-13", "number"],
      ["Fri>", "number"],
      ["DEADLINE:", "keyword"],
      ["<2026-11-20", "number"],
      ["Fri>", "number"],
    ]);
    expect(spansOf(source, 9).slice(0, 2)).toEqual([
      ["CLOCK:", "keyword"],
      ["[2026-11-13", "number"],
    ]);
    expect(spansOf(source, 10)).toEqual([["-----", "punctuation"]]);
    // A timestamp closes with the bracket it opened with.
    expect(spansOf("<2026-11-13 Fri] [2026-11-13]", 0)).toEqual([
      ["<2026-11-13", "plain"],
      ["Fri]", "plain"],
      ["[2026-11-13]", "number"],
    ]);
  });

  it("colors list bullets, checkboxes, description terms, and tables", () => {
    const source = [
      "- [X] done item",
      "  + nested ~code~ item",
      "  * starred item",
      "3) ~term~ :: its description",
      "| name | value |",
      "|------+-------|",
      "| ~a|b~ | =c= |",
      "-not a bullet",
    ].join("\n");
    expect(spansOf(source, 0)).toEqual([
      ["-", "punctuation"],
      ["[X]", "keyword"],
      ["done", "plain"],
      ["item", "plain"],
    ]);
    expect(spansOf(source, 1)).toEqual([
      ["+", "punctuation"],
      ["nested", "plain"],
      ["~code~", "string"],
      ["item", "plain"],
    ]);
    expect(spansOf(source, 2)[0]).toEqual(["*", "punctuation"]);
    expect(spansOf(source, 3)).toEqual([
      ["3)", "punctuation"],
      ["~term~", "string"],
      ["::", "operator"],
      ["its", "plain"],
      ["description", "plain"],
    ]);
    expect(spansOf(source, 4)).toEqual([
      ["|", "punctuation"],
      ["name", "plain"],
      ["|", "punctuation"],
      ["value", "plain"],
      ["|", "punctuation"],
    ]);
    expect(spansOf(source, 5)).toEqual([["|------+-------|", "punctuation"]]);
    // A table splits its cells at every bar, and reads each cell's markup on
    // its own.
    expect(spansOf(source, 6)).toEqual([
      ["|", "punctuation"],
      ["~a", "plain"],
      ["|", "punctuation"],
      ["b~", "plain"],
      ["|", "punctuation"],
      ["=c=", "string"],
      ["|", "punctuation"],
    ]);
    expect(spansOf(source, 7)).toEqual([["-not", "plain"], ["a", "plain"], [
      "bullet",
      "plain",
    ]]);
  });

  it("colors links, code, and verbatim text only where Org's markup rules allow", () => {
    const lines = orgLanguage.highlightLines(
      "See [[https://example.com][the ~site~]] and [[file:notes.org]], " +
        "(=x=) but not a~b~ or ~ c~ or [[a[b]].",
    );
    expect(
      lines[0].spans.filter((span) => span.cls !== "whitespace").map((
        span,
      ) => [span.text, span.cls]),
    ).toEqual([
      ["See", "plain"],
      ["[[", "punctuation"],
      ["https://example.com", "string"],
      ["][", "punctuation"],
      ["the", "plain"],
      ["~site~", "string"],
      ["]]", "punctuation"],
      ["and", "plain"],
      ["[[", "punctuation"],
      ["file:notes.org", "string"],
      ["]]", "punctuation"],
      [",", "plain"],
      ["(", "plain"],
      ["=x=", "string"],
      [")", "plain"],
      ["but", "plain"],
      ["not", "plain"],
      ["a~b~", "plain"],
      ["or", "plain"],
      ["~", "plain"],
      ["c~", "plain"],
      ["or", "plain"],
      ["[[a[b]].", "plain"],
    ]);
  });

  it("colors a source block's body as the language it names", () => {
    const source = [
      "#+begin_src bash :results output -n",
      'echo "$HOME"',
      "#+end_src",
      "#+BEGIN_SRC sh",
      "#+END_SRC",
      "#+begin_src unknown-language",
      "echo plain",
      "#+end_src",
      "#+begin_src",
      "echo plain",
      "#+end_src",
    ].join("\n");
    const lines = orgLanguage.highlightLines(source);
    expect(spansOf(source, 0)).toEqual([
      ["#+begin_src", "keyword"],
      ["bash", "typeName"],
      [":results", "propertyName"],
      ["output", "string"],
      ["-n", "keyword"],
    ]);
    expect(spansOf(source, 1)).toEqual([
      ["echo", "callName"],
      ['"', "string"],
      ["$", "punctuation"],
      ["HOME", "propertyName"],
      ['"', "string"],
    ]);
    expect(classesOf(lines, "#+end_src")).toEqual(["keyword"]);
    expect(classesOf(lines, "#+END_SRC")).toEqual(["keyword"]);
    expect(spansOf(source, 6)).toEqual([["echo plain", "string"]]);
    expect(spansOf(source, 9)).toEqual([["echo plain", "string"]]);
    expect(verbatim(lines)).toBe(source);

    // A language that is not text, and a body of blank lines, stay literal.
    const binary = "#+begin_src binary\nff 00\n#+end_src";
    expect(spansOf(binary, 1)).toEqual([["ff 00", "string"]]);
    const blank = "#+begin_src bash\n\n  \n#+end_src\n- item";
    expect(verbatim(orgLanguage.highlightLines(blank))).toBe(blank);
    expect(spansOf(blank, 4)[0]).toEqual(["-", "punctuation"]);
  });

  it("hides shared indentation and escaping commas from a block's language", () => {
    const source = [
      "- item",
      "  #+begin_src bash",
      "    if true; then",
      "  ,#+not a keyword",
      "  ,,#+still escaped",
      "     ,#+indented",
      "",
      "      echo",
      "    fi",
      "  #+end_src",
    ].join("\n");
    const lines = orgLanguage.highlightLines(source);
    expect(classesOf(lines, "if")).toEqual(["controlKeyword"]);
    expect(classesOf(lines, "fi")).toEqual(["controlKeyword"]);
    expect(classesOf(lines, "echo")).toEqual(["callName"]);
    expect(spansOf(source, 3)).toEqual([
      [",", "plain"],
      ["#+not a keyword", "comment"],
    ]);
    // One comma of a run escapes the line, after any indentation, so the
    // shell reads `,#+still` as a command and `#+indented` as a comment.
    expect(spansOf(source, 4)).toEqual([
      [",", "plain"],
      [",#+still", "callName"],
      ["escaped", "plain"],
    ]);
    expect(spansOf(source, 5)).toEqual([
      [",", "plain"],
      ["#+indented", "comment"],
    ]);
    expect(verbatim(lines)).toBe(source);
  });

  it("keeps a source block in Org literal, however deeply it nests", () => {
    const source = [
      "#+begin_src org",
      ",* not a headline",
      ",#+begin_src bash",
      "echo nested",
      ",#+end_src",
      "#+end_src",
    ].join("\n");
    const lines = orgLanguage.highlightLines(source);
    expect(spansOf(source, 1)).toEqual([[",* not a headline", "string"]]);
    expect(classesOf(lines, "echo")).toEqual([]);
    expect(spansOf(source, 3)).toEqual([["echo nested", "string"]]);
    expect(orgLanguage.parseDocument(source).flatStructure).toEqual([]);
  });

  it("keeps example, export, and comment blocks literal, and quote blocks Org", () => {
    const source = [
      "#+begin_example",
      "* not a headline? It is: headlines end blocks",
      "#+end_example",
      "#+begin_example",
      "- not a bullet",
      "#+end_example",
      "#+begin_comment",
      "hidden ~text~",
      "#+end_comment",
      "#+begin_quote",
      "- a bullet ~code~",
      "#+end_quote",
      "#+BEGIN: clocktable :scope file",
      "#+END:",
    ].join("\n");
    const lines = orgLanguage.highlightLines(source);
    // A block cannot contain a headline, so the first block is no block.
    expect(spansOf(source, 1)[0]).toEqual(["*", "sectionHeader"]);
    expect(spansOf(source, 4)).toEqual([["- not a bullet", "string"]]);
    expect(spansOf(source, 7)).toEqual([["hidden ~text~", "comment"]]);
    expect(spansOf(source, 10)).toEqual([
      ["-", "punctuation"],
      ["a", "plain"],
      ["bullet", "plain"],
      ["~code~", "string"],
    ]);
    expect(classesOf(lines, "#+begin_quote")).toEqual(["keyword"]);
    expect(classesOf(lines, "#+BEGIN:")).toEqual(["keyword"]);
    expect(classesOf(lines, "#+END:")).toEqual(["keyword"]);
    expect(
      orgLanguage.parseDocument(source).flatStructure.map((node) => node.label),
    ).toEqual(["* not a headline? It is: headlines end blocks"]);
  });

  it("leaves the lines after an unclosed block as Org, as an edit in progress does", () => {
    const source = [
      "#+begin_src bash",
      "echo one",
      "- item",
      "#+end_example",
      "#+end_src trailing text",
    ].join("\n");
    expect(spansOf(source, 0)).toEqual([
      ["#+begin_src", "keyword"],
      ["bash", "typeName"],
    ]);
    expect(spansOf(source, 1)).toEqual([["echo", "plain"], ["one", "plain"]]);
    expect(spansOf(source, 2)[0]).toEqual(["-", "punctuation"]);
    expect(spansOf(source, 3)).toEqual([["#+end_example", "keyword"]]);
    // An end line holding more than the block's name is text.
    expect(spansOf(source, 4)).toEqual([
      ["#+end_src", "plain"],
      ["trailing", "plain"],
      ["text", "plain"],
    ]);
  });

  it("reconstructs carriage returns and updates as it is edited", () => {
    const source = "* One\r\n#+begin_src bash\r\necho\r\n#+end_src\r\n";
    const lines = orgLanguage.highlightLines(source);
    expect(verbatim(lines)).toBe(source);
    expect(classesOf(lines, "echo")).toEqual(["callName"]);
    expect(outline(source)).toEqual([["* One", "One", 0, 0, 3]]);

    // A carriage return inside a line is part of it, and one that ends the
    // source without a line feed is not.
    const lone = "#+TITLE: a\rb\n#+begin_example\nbody\n#+end_example\r";
    expect(spansOf(lone, 0)).toEqual([
      ["#+TITLE:", "keyword"],
      ["a\rb", "string"],
    ]);
    expect(spansOf(lone, 2)).toEqual([["body", "string"]]);
    expect(verbatim(orgLanguage.highlightLines(lone))).toBe(lone);

    const highlighter = orgLanguage.createHighlighter("* One");
    expect(classesOf(highlighter.lines, "One")).toEqual(["sectionHeader"]);
    const edited = highlighter.update("* TODO One");
    expect(classesOf(edited, "TODO")).toEqual(["keyword"]);
    expect(highlighter.update("* TODO One")).toBe(edited);
  });
});
