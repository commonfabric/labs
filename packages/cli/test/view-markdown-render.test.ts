import { assert, assertEquals } from "@std/assert";
import { Lexer } from "marked";
import { buildView } from "../lib/view/mod.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Line } from "../lib/view/model.ts";
import {
  _internal as markdownInternals,
  renderMarkdownLines,
} from "../lib/view/languages/markdown/markdown.ts";
import { parseDiff } from "../lib/view/diff.ts";
import {
  _internal as diffDocumentInternals,
  buildDiffDocument,
  type DiffWorkspace,
  type WorkspaceCache,
} from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { renderLineColored } from "../lib/view/highlight.ts";

const MARKDOWN = [
  "# **Title** &amp;",
  "",
  "> A *quote* with [link](https://example.com) and `code`.",
  "- [x] Done",
  "1) First",
  "",
  "| Name | Value |",
  "| :--- | ---: |",
  "| one | **two** |",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    const key: Key = name.length === 1 && name >= " "
      ? { name, char: name }
      : { name };
    session.handleKey(key);
  }
}

Deno.test("markdown rendered view formats blocks and inline content", () => {
  const lines = renderMarkdownLines(MARKDOWN);
  assertEquals(lines.length, MARKDOWN.split("\n").length);
  assertEquals(lines.map((line) => line.text), [
    "Title &",
    "",
    "│ A quote with link and code.",
    "☑ Done",
    "1. First",
    "",
    "│ Name │ Value │",
    "├──────┼───────┤",
    "│ one  │   two │",
    "",
    "",
    "const x = 1;",
    "",
  ]);
  for (const line of lines) {
    assertEquals(
      line.spans.map((span) => span.text).join(""),
      line.text,
      `spans reconstruct ${JSON.stringify(line.text)}`,
    );
  }

  assert(lines[0].spans.some((span) => span.bold), "strong text is bold");
  assert(lines[2].spans.some((span) => span.italic), "emphasis is italic");
  assert(
    lines[2].spans.some((span) => span.underline),
    "link text is underlined",
  );
  assert(
    renderLineColored(lines[0], true).includes("\x1b[1;"),
    "bold spans reach ANSI output",
  );
  assert(
    renderLineColored(lines[2], true).includes("\x1b[4;"),
    "underlined spans reach ANSI output",
  );
  assert(
    lines[2].spans.some((span) => span.cls === "string"),
    "inline code has code color",
  );
  assert(
    lines[6].spans.some((span) => span.bold),
    "table headings are bold",
  );
  assert(lines[0].renderedSourceHidden, "heading levels remain diff-visible");
});

Deno.test("markdown rendered view handles setext, rules, images, and fenced tables", () => {
  const lines = renderMarkdownLines([
    "```",
    "a | b",
    "--- | ---",
    "```",
    "Setext heading &copy;",
    "==============",
    "",
    "---",
    "![diagram](diagram.png) and ~~retired~~",
    "<b>HTML text</b>",
    "",
    "- item",
    "---",
    "# Heading",
    "---",
  ].join("\n"));

  assertEquals(lines.map((line) => line.text), [
    "",
    "a | b",
    "--- | ---",
    "",
    "Setext heading ©",
    "",
    "",
    "────────────────────────────────",
    "▧ diagram and retired",
    "HTML text",
    "",
    "• item",
    "────────────────────────────────",
    "Heading",
    "────────────────────────────────",
  ]);
  assert(
    lines[8].spans.some((span) => span.strikethrough),
    "deleted text is struck through",
  );
  assert(
    renderLineColored(lines[8], true).includes("\x1b[9;"),
    "rich modifiers reach ANSI output",
  );

  assertEquals(
    renderMarkdownLines("foo\nbar\n---").map((line) => line.text),
    ["foo", "bar", ""],
  );
  assertEquals(
    renderMarkdownLines("![**bold**](x)").map((line) => line.text),
    ["▧ bold"],
  );
  assertEquals(
    renderMarkdownLines("![a *b* `c`](x)").map((line) => line.text),
    ["▧ a b c"],
  );
});

Deno.test("markdown rendered view covers nested blocks and table alignment", () => {
  const lines = renderMarkdownLines([
    "[target]: https://example.com",
    "> > nested **[quote][target]**",
    "- bullet",
    "2. [ ] pending",
    "    indented code",
    "",
    "| Center | Left | Right |",
    "| :---: | :--- | ---: |",
    "| x\\|y | \\*literal\\* | `p|q` |",
    "",
    "\\*literal\\* and <https://example.com>",
    "  ~~~ text",
    "    fenced code",
    "  ~~~~",
  ].join("\n"));

  assertEquals(lines[0].text, "");
  assertEquals(lines[1].text, "│ │ nested quote");
  assert(lines[1].spans.some((span) => span.underline));
  assertEquals(lines[2].text, "• bullet");
  assertEquals(lines[3].text, "2. ☐ pending");
  assertEquals(lines[4].text, "      indented code");
  assert(lines[6].text.includes("Center"));
  assert(lines[7].text.includes("┼"));
  assert(lines[8].text.includes("x|y"));
  assert(lines[8].text.includes("*literal*"));
  assert(lines[8].text.includes("p|q"));
  assertEquals(lines[10].text, "*literal* and https://example.com");
  assertEquals(lines[11].text, "");
  assertEquals(lines[12].text, "  fenced code");
  assertEquals(lines[13].text, "");
});

Deno.test("markdown rendered view follows block containers and literal syntax", () => {
  const lines = renderMarkdownLines([
    "    a | b",
    "    --- | ---",
    "",
    "> ```js",
    "> const x = 1;",
    "> ```",
    "",
    "`&amp;`",
    '<span title="1 > 0">visible</span>',
  ].join("\n"));

  assertEquals(lines.map((line) => line.text), [
    "a | b",
    "--- | ---",
    "",
    "│ ",
    "│ const x = 1;",
    "│ ",
    "",
    "&amp;",
    "visible",
  ]);
  assertEquals(lines[0].spans[0]?.cls, "string");
  assertEquals(lines[1].spans[0]?.cls, "string");
  assertEquals(lines[4].spans[1]?.cls, "string");
});

Deno.test("markdown rendered view preserves nested and multiline structure", () => {
  const nested = renderMarkdownLines([
    "- outer",
    "  - inner",
    "    - deep",
  ].join("\n"));
  assertEquals(nested.map((line) => line.text), [
    "• outer",
    "  • inner",
    "    • deep",
  ]);
  assertEquals(
    renderMarkdownLines("-\n  continuation").map((line) => line.text),
    ["• ", "  continuation"],
  );
  assertEquals(
    renderMarkdownLines("1.\n   continuation").map((line) => line.text),
    ["1. ", "   continuation"],
  );

  const code = renderMarkdownLines([
    "- outer",
    "",
    "      code",
  ].join("\n"));
  assertEquals(code.map((line) => line.text), ["• outer", "", "  code"]);
  assertEquals(code[2].spans[1]?.cls, "string");

  const paragraph = renderMarkdownLines([
    "This is *emphasis",
    "continued here*.",
  ].join("\n"));
  assertEquals(paragraph.map((line) => line.text), [
    "This is emphasis",
    "continued here.",
  ]);
  assert(paragraph[0].spans.some((span) => span.italic));
  assert(paragraph[1].spans.some((span) => span.italic));

  const comment = renderMarkdownLines(["<!--", "hidden", "-->"].join("\n"));
  assertEquals(comment.map((line) => line.text), ["", "", ""]);
  assert(comment.every((line) => line.renderedSourceHidden));
});

Deno.test("markdown rendered view keeps inline content on its source lines", () => {
  const code = renderMarkdownLines("`first\nsecond`");
  assertEquals(code.map((line) => line.text), ["first", "second"]);
  assert(code.every((line) => line.spans[0]?.cls === "string"));

  const entity = renderMarkdownLines("before&#10;after");
  assertEquals(entity.map((line) => line.text), ["before after"]);

  const html = renderMarkdownLines(
    'before <span\ntitle="x">visible</span> after',
  );
  assertEquals(html.map((line) => line.text), ["before ", "visible after"]);

  const comment = renderMarkdownLines("before <!--\nhidden --> after");
  assertEquals(comment.map((line) => line.text), ["before ", " after"]);

  const link = renderMarkdownLines(
    '[link](https://example.com\n  "title") after',
  );
  assertEquals(link.map((line) => line.text), ["link", " after"]);

  const image = renderMarkdownLines(
    '![alt](diagram.png\n  "title") after',
  );
  assertEquals(image.map((line) => line.text), ["▧ alt", " after"]);

  const heading = renderMarkdownLines("foo  \nbar\n---");
  assertEquals(heading.map((line) => line.text), ["foo", "bar", ""]);

  const imageBreak = renderMarkdownLines("![first  \nsecond](x) after");
  assertEquals(imageBreak.map((line) => line.text), [
    "▧ first",
    "second after",
  ]);

  const loneCarriage = renderMarkdownLines("# hi\rbody");
  assertEquals(loneCarriage.map((line) => line.text), ["hi body"]);

  assertEquals(
    renderMarkdownLines("#\rheading").map((line) => line.text),
    ["heading"],
  );
  assertEquals(
    renderMarkdownLines("-\ritem").map((line) => line.text),
    ["• item"],
  );
  assertEquals(renderMarkdownLines("a\r&#xE000;")[0].text, "a \uE000");

  for (
    const line of [
      ...code,
      ...entity,
      ...html,
      ...comment,
      ...link,
      ...image,
      ...heading,
      ...imageBreak,
      ...loneCarriage,
    ]
  ) {
    assertEquals(
      line.spans.map((span) => span.text).join(""),
      line.text,
      `spans reconstruct ${JSON.stringify(line.text)}`,
    );
  }
});

Deno.test("markdown rendered view strips multiline block HTML", () => {
  const source = [
    "<section",
    '  class="note">',
    "**visible**",
    "</section>",
  ].join("\n");
  const lines = renderMarkdownLines(source);

  assertEquals(lines.map((line) => line.text), ["", "", "visible", ""]);
  assert(lines[0].renderedSourceHidden);
  assert(lines[1].renderedSourceHidden);
  assertEquals(lines[2].renderedSourceHidden, undefined);
  assert(lines[2].spans.some((span) => span.bold));
  assert(lines[3].renderedSourceHidden);
  for (const line of lines) {
    assertEquals(
      line.spans.map((span) => span.text).join(""),
      line.text,
      `spans reconstruct ${JSON.stringify(line.text)}`,
    );
  }

  const script = renderMarkdownLines([
    "<script>",
    'if (a < b) alert("safe");',
    "</script>",
  ].join("\n"));
  assertEquals(script.map((line) => line.text), [
    "",
    'if (a < b) alert("safe");',
    "",
  ]);
  assertEquals(script[1].renderedSourceHidden, undefined);

  const rawScript = renderMarkdownLines([
    "<script>",
    'if (a<b && c>d) alert("safe");',
    "const template = `[x](url)`;",
    "</script>",
  ].join("\n"));
  assertEquals(rawScript.map((line) => line.text), [
    "",
    'if (a<b && c>d) alert("safe");',
    "const template = `[x](url)`;",
    "",
  ]);
  assertEquals(rawScript[1].renderedSourceHidden, undefined);
  assertEquals(rawScript[2].renderedSourceHidden, undefined);

  const style = renderMarkdownLines([
    "<style>",
    ".x{width:calc(1<em + 2>rem)}",
    "</style>",
  ].join("\n"));
  assertEquals(style.map((line) => line.text), [
    "",
    ".x{width:calc(1<em + 2>rem)}",
    "",
  ]);

  const closePrefix = renderMarkdownLines([
    "<script>",
    'const x = "</scripture>";',
    "</script>",
  ].join("\n"));
  assertEquals(closePrefix.map((line) => line.text), [
    "",
    'const x = "</scripture>";',
    "",
  ]);

  const expandingCaseFold = renderMarkdownLines([
    "<script>",
    "const İ = 1;",
    "</script>",
  ].join("\n"));
  assertEquals(expandingCaseFold.map((line) => line.text), [
    "",
    "const İ = 1;",
    "",
  ]);

  const declaration = renderMarkdownLines(
    '<!DOCTYPE html PUBLIC "x>y"><span>visible</span>',
  );
  assertEquals(declaration.map((line) => line.text), ["visible"]);
  const declarationSubset = renderMarkdownLines(
    "<!DOCTYPE svg [<!ELEMENT svg ANY>]><p>visible</p>",
  );
  assertEquals(declarationSubset.map((line) => line.text), ["visible"]);
  const multilineDeclarationSubset = renderMarkdownLines([
    "<!DOCTYPE svg [",
    "<!ELEMENT svg ANY>",
    "]>",
    "<p>visible</p>",
  ].join("\n"));
  assertEquals(multilineDeclarationSubset.map((line) => line.text), [
    "",
    "",
    "",
    "visible",
  ]);
  const commentedDeclarationSubset = renderMarkdownLines(
    "<!DOCTYPE svg [<!-- ] --> <!ELEMENT svg ANY>]><p>visible</p>",
  );
  assertEquals(
    commentedDeclarationSubset.map((line) => line.text),
    ["visible"],
  );
  const adjacentDeclarationSubset = renderMarkdownLines([
    "<!DOCTYPE a><!DOCTYPE b [",
    "<!ELEMENT b ANY>",
    "]>",
    "<p>visible</p>",
  ].join("\n"));
  assertEquals(adjacentDeclarationSubset.map((line) => line.text), [
    "",
    "",
    "",
    "visible",
  ]);
  const separatedDeclarationSubset = renderMarkdownLines(
    "<!DOCTYPE a><!-- separator --><?next?>" +
      "<!DOCTYPE b [<!ELEMENT b ANY>]><p>visible</p>",
  );
  assertEquals(
    separatedDeclarationSubset.map((line) => line.text),
    ["visible"],
  );
  const declarationAfterText = renderMarkdownLines(
    "<!DOCTYPE a> text " +
      "<!DOCTYPE b [<!ELEMENT b ANY>]><p>visible</p>",
  );
  assertEquals(declarationAfterText.map((line) => line.text), [
    " text visible",
  ]);
});

Deno.test("rendered Markdown diff keeps changed multiline HTML tags visible", () => {
  const oldSource = [
    "<section",
    '  class="old">',
    "**visible**",
    "</section>",
  ].join("\n");
  const newSource = oldSource.replace('class="old"', 'class="new"');
  const diffText = `diff --git a/notes.md b/notes.md
index 1234..5678 100644
--- a/notes.md
+++ b/notes.md
@@ -1,4 +1,4 @@
 <section
-  class="old">
+  class="new">
 **visible**
 </section>`;
  const model = parseDiff(diffText);
  assert(model);
  const workspace: DiffWorkspace = {
    resolve: () => "/workspace/notes.md",
    read: () => newSource,
    readBlob: (object) => object === "1234" ? oldSource : null,
  };
  const doc = buildDiffDocument(
    diffText,
    model,
    workspace,
    new Map(),
    "rendered",
  ).doc;

  assertEquals(doc.lines[6].text, '-  class="old">');
  assertEquals(doc.lines[7].text, '+  class="new">');
  assertEquals(doc.lines[6].renderedSourceHidden, undefined);
  assertEquals(doc.lines[7].renderedSourceHidden, undefined);
});

Deno.test("rendered Markdown diff keeps contextless fragments in source form", () => {
  const diffText = `diff --git a/notes.md b/notes.md
index 1234..5678 100644
--- a/notes.md
+++ b/notes.md
@@ -10 +10 @@
-**old**
+**new**`;
  const model = parseDiff(diffText);
  assert(model);
  const workspace: DiffWorkspace = {
    resolve: () => "/missing/notes.md",
    read: () => null,
  };
  const doc = buildDiffDocument(
    diffText,
    model,
    workspace,
    new Map(),
    "rendered",
  ).doc;

  assertEquals(doc.lines[5].text, "-**old**");
  assertEquals(doc.lines[6].text, "+**new**");
});

Deno.test("markdown rendered view composes lines without prebuilt spans", () => {
  const composed = new markdownInternals.RichLine();
  composed.appendLine({
    text: "plain",
    spans: [],
    renderedSourceHidden: true,
  });
  assertEquals(composed.line(), {
    text: "plain",
    spans: [{ col: 0, text: "plain", cls: "plain" }],
    renderedSourceHidden: true,
  });

  const padded = markdownInternals.splitRichLine({
    text: "visible",
    spans: [{ col: 0, text: "visible", cls: "plain" }],
    renderedSourceHidden: true,
  }, 3);
  assertEquals(padded.map((line) => line.text), ["visible", "", ""]);
  assert(padded.every((line) => line.renderedSourceHidden));
});

Deno.test("markdown rendered view retains readable source when lexing fails", () => {
  const originalStaticLex = Lexer.lex;
  const originalInstanceLex = Lexer.prototype.lex;
  const throwLex = () => {
    throw new Error("lexer unavailable");
  };
  Lexer.lex = throwLex as typeof Lexer.lex;
  Lexer.prototype.lex = throwLex as typeof Lexer.prototype.lex;
  try {
    assertEquals(
      renderMarkdownLines("plain **source**").map((line) => line.text),
      ["plain source"],
    );
  } finally {
    Lexer.lex = originalStaticLex;
    Lexer.prototype.lex = originalInstanceLex;
  }

  const originalInline = Lexer.lexInline;
  Lexer.lexInline = throwLex as typeof Lexer.lexInline;
  try {
    assertEquals(
      markdownInternals.renderInlineLine("plain **source**").text,
      "plain **source**",
    );
  } finally {
    Lexer.lexInline = originalInline;
  }

  const throwingInlineLexer = {
    inlineTokens: throwLex,
  } as unknown as Lexer;
  assertEquals(
    markdownInternals.renderParagraphBlock(
      { type: "paragraph", raw: "fallback" },
      ["fallback"],
      throwingInlineLexer,
    ).map((line) => line.text),
    ["fallback"],
  );
});

Deno.test("markdown rendered view handles incomplete block token data", () => {
  assertEquals(
    markdownInternals.renderBlockToken(
      { type: "space", raw: "\n" },
      [""],
    ).map((line) => line.text),
    [""],
  );
  assertEquals(
    markdownInternals.renderBlockToken(
      { type: "extension", raw: "plain" },
      ["plain"],
    ).map((line) => line.text),
    ["plain"],
  );
  assertEquals(
    markdownInternals.renderCodeBlock(
      { type: "code", raw: "body", text: "first\nsecond" },
      ["first", "second"],
    ),
    [
      {
        text: "first",
        spans: [{ col: 0, text: "first", cls: "string" }],
        renderedSourceHidden: true,
      },
      {
        text: "second",
        spans: [{ col: 0, text: "second", cls: "string" }],
        renderedSourceHidden: true,
      },
    ],
  );
  assertEquals(
    markdownInternals.renderHtmlBlock(["plain"]).map((line) => line.text),
    ["plain"],
  );

  const originalLex = Lexer.lex;
  Lexer.lex = (() => [{
    type: "space",
    raw: "not present",
  }]) as unknown as typeof Lexer.lex;
  try {
    assertEquals(
      markdownInternals.renderMarkdownBlocks("source").map((line) => line.text),
      ["source"],
    );
  } finally {
    Lexer.lex = originalLex;
  }

  assertEquals(markdownInternals.tokenLineRange("\n\n", 0, [0, 1, 2]), null);
});

Deno.test("markdown rendered view handles incomplete list token data", () => {
  assertEquals(
    markdownInternals.renderListBlock(
      { type: "list", raw: "- item" },
      ["- item"],
    ).map((line) => line.text),
    ["• item"],
  );
  assertEquals(
    markdownInternals.renderListBlock(
      {
        type: "list",
        raw: "- item",
        items: [{ type: "list_item", raw: "missing", text: "item" }],
      },
      ["- item"],
    ).map((line) => line.text),
    [""],
  );
  assertEquals(
    markdownInternals.renderListBlock(
      {
        type: "list",
        raw: "\n\n",
        items: [{ type: "list_item", raw: "\n\n", text: "" }],
      },
      ["", ""],
    ).map((line) => line.text),
    ["", ""],
  );
  assertEquals(
    markdownInternals.renderListBlock(
      {
        type: "list",
        raw: "plain",
        items: [{ type: "list_item", raw: "plain", text: "plain" }],
      },
      ["plain"],
    ).map((line) => line.text),
    [""],
  );
  assertEquals(
    markdownInternals.renderListBlock(
      {
        type: "list",
        raw: "- first\n  second",
        items: [{
          type: "list_item",
          raw: "- first\n  second",
          text: "first",
        }],
      },
      ["- first", "  second"],
    ).map((line) => line.text),
    ["• first", "  second"],
  );
});

Deno.test("markdown rendered view handles uncommon inline token shapes", () => {
  const line = new markdownInternals.RichLine();
  markdownInternals.appendInlineTokens(
    line,
    [
      { type: "br", raw: "  \n" },
      {
        type: "extension",
        raw: "outer",
        tokens: [{ type: "text", raw: "nested", text: "nested" }],
      },
    ],
    { cls: "plain" },
    true,
  );
  assertEquals(line.line().text, "\nnested");

  assertEquals(
    markdownInternals.codeSpanText(
      { type: "codespan", raw: "invalid", text: "fallback" },
      true,
    ),
    "fallback",
  );
  assertEquals(
    markdownInternals.codeSpanText(
      { type: "codespan", raw: "` padded\ncode `", text: "" },
      true,
    ),
    "padded\ncode",
  );

  const child = new markdownInternals.RichLine();
  markdownInternals.appendTokenChildren(
    child,
    { type: "strong", raw: "fallback", text: "fallback" },
    { cls: "plain", bold: true },
  );
  assertEquals(child.line().spans, [{
    col: 0,
    text: "fallback",
    cls: "plain",
    bold: true,
  }]);
});

Deno.test("markdown rendered view handles incomplete HTML, fences, and tables", () => {
  assertEquals(
    markdownInternals.stripHtmlTags("plain <![CDATA[visible]]> <span"),
    "plain visible <span",
  );
  assertEquals(
    markdownInternals.stripHtmlTags("before <!-- hidden\nstill hidden"),
    "before \n",
  );
  assertEquals(
    markdownInternals.stripHtmlTags(
      '<?xml version="1.0"?><!DOCTYPE html><span>visible</span>',
    ),
    "visible",
  );
  assertEquals(
    markdownInternals.stripHtmlTags("if (a < b && c > d)"),
    "if (a < b && c > d)",
  );
  assertEquals(
    renderMarkdownLines("<![CDATA[\nvisible <tag>").map((line) => line.text),
    ["<![CDATA[", "visible <tag>"],
  );
  assertEquals(
    renderMarkdownLines("<?target\ndata > still instruction\n?>").map((line) =>
      line.text
    ),
    ["", "", ""],
  );
  assertEquals(
    renderMarkdownLines("<?target\ndata <tag>\n?>").map((line) => line.text),
    ["", "", ""],
  );
  assertEquals(markdownInternals.openingFence("plain"), null);
  assertEquals(markdownInternals.openingFence("```bad`info"), null);

  assertEquals(markdownInternals.tableAlignment("plain"), null);
  assertEquals(markdownInternals.tableAlignment("bad | ---"), null);
  assertEquals(markdownInternals.splitTableCells("plain"), null);
  assertEquals(markdownInternals.splitTableCells("a | ``b|c``"), [
    "a ",
    " ``b|c``",
  ]);
  assertEquals(
    markdownInternals.renderTableBlock([
      "a | b",
      "--- | ---",
      "only one cell",
    ]).map((line) => line.text),
    ["a | b", "--- | ---", "only one cell"],
  );

  const literalBackslashes = renderMarkdownLines([
    "code | value",
    "--- | ---",
    "`a\\\\b` | x",
  ].join("\n"));
  assert(literalBackslashes[2].text.includes("a\\\\b"));
});

Deno.test("markdown rendered view handles malformed HTML boundaries", () => {
  assertEquals(
    markdownInternals.htmlDeclarationRanges(
      "<!DOCTYPE",
      0,
      { type: "html", raw: "<!DOCTYPE" },
    ),
    [],
  );
  assertEquals(
    markdownInternals.htmlDeclarationRanges(
      "<!DOCTYPE a><!--",
      0,
      { type: "html", raw: "<!DOCTYPE a>" },
    ),
    [],
  );
  assertEquals(
    markdownInternals.htmlDeclarationRanges(
      "<!DOCTYPE a><?next",
      0,
      { type: "html", raw: "<!DOCTYPE a>" },
    ),
    [],
  );

  assertEquals(
    markdownInternals.skipAdjacentDeclarationWhitespace("    next", 0),
    3,
  );
  assertEquals(
    markdownInternals.skipAdjacentDeclarationWhitespace("\tnext", 0),
    0,
  );
  assertEquals(
    markdownInternals.skipAdjacentDeclarationWhitespace("x \tnext", 1),
    3,
  );

  const lines = renderMarkdownLines("abcdef");
  markdownInternals.applyHtmlDeclarations(
    "abcdef",
    ["abcdef"],
    lines,
    [{ start: 1, end: 4 }, { start: 2, end: 5 }],
  );
  assertEquals(lines, [{
    text: "af",
    spans: [{ col: 0, text: "af", cls: "plain" }],
    renderedSourceHidden: true,
  }]);

  assertEquals(
    markdownInternals.renderBlockquoteBlock(["plain"]).map((line) => line.text),
    ["plain"],
  );
  assertEquals(
    renderMarkdownLines("![](image.png)").map((line) => line.text),
    ["▧ image"],
  );

  assertEquals(
    renderMarkdownLines("<![CDATA[unterminated").map((line) => line.text),
    ["<![CDATA[unterminated"],
  );
  assertEquals(
    markdownInternals.stripHtmlTags("<![CDATA[unterminated"),
    "<![CDATA[unterminated",
  );
  assertEquals(
    renderMarkdownLines('<script title="unterminated').map((line) => line.text),
    ['<script title="unterminated'],
  );
  assertEquals(
    renderMarkdownLines("<script>visible").map((line) => line.text),
    ["visible"],
  );
  assertEquals(
    renderMarkdownLines("<img/>").map((line) => line.text),
    [""],
  );
  assertEquals(
    renderMarkdownLines("<span @>visible").map((line) => line.text),
    ["<span @>visible"],
  );
  assertEquals(
    markdownInternals.stripHtmlTags("<span @>visible"),
    "<span @>visible",
  );
  assertEquals(
    renderMarkdownLines('<span title="unterminated>').map((line) => line.text),
    ['<span title="unterminated>'],
  );
  assertEquals(
    renderMarkdownLines(
      "<span title=value>visible</span>",
    ).map((line) => line.text),
    ["visible"],
  );
  assertEquals(
    renderMarkdownLines("<span disabled>visible</span>").map((line) =>
      line.text
    ),
    ["visible"],
  );
  assertEquals(
    renderMarkdownLines("<span title=>").map((line) => line.text),
    ["<span title=>"],
  );
  assertEquals(
    markdownInternals.stripHtmlTags("<span title=>"),
    "<span title=>",
  );

  assertEquals(
    markdownInternals.declarationMarkupEnd(
      "<!DOCTYPE a [<!-- unfinished",
      2,
    ),
    null,
  );
  assertEquals(
    markdownInternals.declarationMarkupEnd(
      "<!DOCTYPE a [<?next] >",
      2,
    ),
    null,
  );
  const declarationWithInstruction = "<!DOCTYPE a [<?next?>]>";
  assertEquals(
    markdownInternals.declarationMarkupEnd(declarationWithInstruction, 2),
    declarationWithInstruction.length,
  );
});

Deno.test("markdown rendered view preserves unusual Unicode token data", () => {
  const loneLowSurrogateLexer = {
    inlineTokens: () => [{
      type: "text",
      raw: "\udc00",
      text: "\udc00",
    }],
  } as unknown as Lexer;
  assertEquals(
    markdownInternals.renderInlineLine(
      "plain",
      "plain",
      loneLowSurrogateLexer,
    ).text,
    "plain",
  );

  const pairedSurrogateInputs: string[] = [];
  const pairedSurrogateLexer = {
    inlineTokens: (source: string) => {
      pairedSurrogateInputs.push(source);
      return [{
        type: "text",
        raw: source,
        text: source,
      }];
    },
  } as unknown as Lexer;
  assertEquals(
    markdownInternals.renderInlineLine(
      "😀",
      "plain",
      pairedSurrogateLexer,
    ).text,
    "😀",
  );
  assertEquals(pairedSurrogateInputs, ["😀"]);

  const masked = markdownInternals.maskAstralCharacters("☀😀");
  assert(masked);
  const placeholder = masked.text.at(-1)!;
  assert(placeholder !== "☀");
  assertEquals(masked.original.get(placeholder), "😀");
  assertEquals(
    markdownInternals.restoreInlineTokens([{
      type: "link",
      raw: placeholder,
      text: placeholder,
      href: `https://${placeholder}`,
      tokens: [{
        type: "text",
        raw: placeholder,
        text: placeholder,
      }],
    }], masked.original),
    [{
      type: "link",
      raw: "😀",
      text: "😀",
      href: "https://😀",
      tokens: [{
        type: "text",
        raw: "😀",
        text: "😀",
      }],
    }],
  );

  const tooManyAstralCharacters = Array.from(
    { length: 705 },
    (_, index) => String.fromCodePoint(0x10000 + index),
  ).join("");
  const fallbackSource = `${tooManyAstralCharacters}_a_😀\\😀`;
  assertEquals(
    renderMarkdownLines(fallbackSource).map((line) => line.text),
    [fallbackSource],
  );

  assertEquals(
    markdownInternals.codeSpanText(
      { type: "codespan", raw: "`unfinished\nspan", text: "fallback" },
      true,
    ),
    "fallback",
  );
});

Deno.test("markdown rendered view makes decoded controls inert", () => {
  const line = renderMarkdownLines(
    "safe&#27;[31mred&#7;&#127;\u0085",
  )[0];
  assertEquals(line.text, "safe␛[31mred␇␡␦");
  assert(!line.text.includes("\x1b"));
  assert(!line.text.includes("\x07"));

  const malformedQuote = renderMarkdownLines("\r>");
  assertEquals(malformedQuote.map((row) => row.text), [" │ "]);
  assertEquals(
    malformedQuote[0].spans.map((span) => span.text).join(""),
    malformedQuote[0].text,
  );

  const astral = renderMarkdownLines("_a_😀\\😀")[0];
  assertEquals(astral.text, "a😀\\😀");
  assertEquals(
    astral.spans.map((span) => span.text).join(""),
    astral.text,
  );
});

Deno.test("session toggles Markdown between source and rendered views", () => {
  const built = buildView(MARKDOWN, "notes.md");
  const session = new Session(
    built.doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 10 },
    undefined,
    built.editSource,
  );

  assertEquals(session.doc.lines[0].text, "# **Title** &amp;");
  assertEquals(session.view().viewMode, "source");
  assert(session.view().canRender);

  press(session, "s", "l");
  const selected = session.view().selected?.label;
  assert(selected);
  assertEquals(session.view().left, 8);
  press(session, "v");
  assertEquals(session.doc.lines[0].text, "Title &");
  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.view().message, "View: rendered");
  assertEquals(session.view().selected?.label, selected);
  assertEquals(session.view().left, 0);

  press(session, "#");
  assertEquals(session.view().lineNumbers?.slice(0, 3), [1, 2, 3]);

  press(session, "enter", "tab");
  assert(session.view().overlay?.sourceView, "card source remains source text");
  assertEquals(session.view().overlay?.lines[0]?.text, "# **Title** &amp;");
  press(session, "escape");

  press(session, "e");
  assertEquals(session.view().viewMode, "source");
  assertEquals(session.doc.lines[0].text, "# **Title** &amp;");
  assert(session.view().cursor, "editing enters source view with a cursor");
  assertEquals(session.view().message, "Source view for editing.");

  press(session, "end", "!", "escape", "v");
  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.doc.lines[0].text, "Title &!");

  const oneHeading = buildView("# **Heading**", "heading.md");
  const selectionSession = new Session(
    oneHeading.doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 4 },
    undefined,
    oneHeading.editSource,
  );
  press(selectionSession, "s", "v");
  assertEquals(selectionSession.view().selected?.startCol, 0);
  assertEquals(selectionSession.view().selected?.endCol, 7);
});

Deno.test("session can start rendered and recomputes visible search matches", () => {
  const text = "# A [visible target](hidden-destination)\n";
  const built = buildView(text, "notes.md");
  const session = new Session(
    built.doc,
    { color: false, showLineNumbers: false, viewMode: "rendered" },
    { width: 20, height: 5 },
    undefined,
    built.editSource,
  );

  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.doc.lines[0].text, "A visible target");
  press(
    session,
    "/",
    "h",
    "i",
    "d",
    "d",
    "e",
    "n",
    "enter",
  );
  assertEquals(session.view().matches?.length, 0);

  press(session, "V");
  assertEquals(session.view().viewMode, "source");
  assertEquals(session.view().matches?.length, 1);
  assertEquals(session.doc.lines[0].text, text.trim());
});

Deno.test("session preserves wrapping while changing Markdown views", () => {
  const built = buildView(
    "# Title\nA long line of Markdown content.\n",
    "notes.md",
  );
  const session = new Session(
    built.doc,
    { color: false, showLineNumbers: false },
    { width: 12, height: 5 },
    undefined,
    built.editSource,
  );

  press(session, "\\", "v");
  assertEquals(session.view().wrapMode, "hard");
  assertEquals(session.view().viewMode, "rendered");

  press(session, "e");
  assertEquals(
    session.view().message,
    "Source view; line wrapping turned off for editing.",
  );

  const sourceSession = new Session(
    built.doc,
    { color: false, showLineNumbers: false },
    { width: 12, height: 5 },
    undefined,
    built.editSource,
  );
  press(sourceSession, "\\", "e");
  assertEquals(
    sourceSession.view().message,
    "Line wrapping turned off for editing.",
  );
});

Deno.test("languages without a renderer remain in source view", () => {
  const built = buildView("const value = 1;\n", "value.ts");
  const session = new Session(
    built.doc,
    {
      color: false,
      showLineNumbers: false,
      viewMode: "rendered",
    },
    { width: 40, height: 4 },
    undefined,
    built.editSource,
  );

  assertEquals(session.view().viewMode, "source");
  assertEquals(session.view().canRender, false);
  press(session, "v");
  assertEquals(session.view().viewMode, "source");
  assertEquals(session.view().message, "Rendered view isn't available here.");
  assertEquals(session.doc.lines[0].text, "const value = 1;");
});

const MARKDOWN_DIFF = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1 +1 @@
-# Old **title**
+# New *title*
`;

Deno.test("rendered Markdown diff retains markers, tints, and source topology", () => {
  const built = buildView(MARKDOWN_DIFF, undefined, true);
  const rendered = built.editSource.render?.(built.doc);
  assert(rendered, "Markdown diff offers a rendered view");
  assertEquals(rendered.text, MARKDOWN_DIFF);
  assertEquals(rendered.lines.length, built.doc.lines.length);
  assertEquals(rendered.lines[4].text, "-# Old **title**");
  assertEquals(rendered.lines[5].text, "+# New *title*");
  assertEquals(rendered.lines[4].bg, "del");
  assertEquals(rendered.lines[5].bg, "add");
  assertEquals(rendered.lines[4].spans[0]?.cls, "diffDel");
  assertEquals(rendered.lines[5].spans[0]?.cls, "diffAdd");
  assertEquals(built.doc.lines[4].text, "-# Old **title**");
  assertEquals(built.doc.lines[5].text, "+# New *title*");
  assertEquals(rendered.flatStructure.length, built.doc.flatStructure.length);

  const renamed = buildView(`diff --git a/notes.md b/notes.ts
--- a/notes.md
+++ b/notes.ts
@@ -1 +1 @@
-# Old **title**
+const title = "new";
`);
  const renderedRename = renamed.editSource.render?.(renamed.doc);
  assert(renderedRename, "a renamed Markdown old side offers rendered view");
  assertEquals(renderedRename.lines[4].text, "-# Old **title**");
  assertEquals(renderedRename.lines[5].text, '+const title = "new";');

  const renameSession = new Session(
    renamed.doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 6 },
    undefined,
    renamed.editSource,
  );
  press(renameSession, "tab", "tab", "tab", "v");
  assertEquals(renameSession.view().selected?.label, "title");
  assertEquals(renameSession.view().selected?.startCol, 1);
  assertEquals(renameSession.view().selected?.endCol, 21);

  const destinationOnly = buildView(
    `diff --git a/links.md b/links.md
--- a/links.md
+++ b/links.md
@@ -1,2 +1,2 @@
-[target]: https://safe.example
-[open][target]
+[target]: https://evil.example
+[open][target]
`,
    undefined,
    true,
  );
  const renderedDestinationOnly = destinationOnly.editSource.render?.(
    destinationOnly.doc,
  );
  assert(renderedDestinationOnly);
  assertEquals(
    renderedDestinationOnly.lines.slice(4, 8).map((line) => line.text),
    [
      "-[target]: https://safe.example",
      "-[open][target]",
      "+[target]: https://evil.example",
      "+[open][target]",
    ],
  );

  const inlineDestinationOnly = buildView(
    `--- a/links.md
+++ b/links.md
@@ -1 +1 @@
-[open](https://safe.example)
+[open](https://evil.example)
`,
    undefined,
    true,
  );
  const renderedInlineDestinationOnly = inlineDestinationOnly.editSource
    .render?.(inlineDestinationOnly.doc);
  assert(renderedInlineDestinationOnly);
  assertEquals(
    renderedInlineDestinationOnly.lines.slice(3, 5).map((line) => line.text),
    [
      "-[open](https://safe.example)",
      "+[open](https://evil.example)",
    ],
  );

  const noNewline = buildView(
    `--- a/links.md
+++ b/links.md
@@ -1 +1 @@
-[open](https://safe.example)
\\ No newline at end of file
+[open](https://evil.example)
\\ No newline at end of file
`,
    undefined,
    true,
  );
  const renderedNoNewline = noNewline.editSource.render?.(noNewline.doc);
  assert(renderedNoNewline);
  assertEquals(
    renderedNoNewline.lines[3].text,
    "-[open](https://safe.example)",
  );
  assertEquals(
    renderedNoNewline.lines[5].text,
    "+[open](https://evil.example)",
  );

  const labelAndDestination = buildView(
    `--- a/links.md
+++ b/links.md
@@ -1 +1 @@
-[safe](https://safe.example)
+[evil](https://evil.example)
`,
    undefined,
    true,
  );
  const renderedLabelAndDestination = labelAndDestination.editSource.render?.(
    labelAndDestination.doc,
  );
  assert(renderedLabelAndDestination);
  assertEquals(
    renderedLabelAndDestination.lines.slice(3, 5).map((line) => line.text),
    [
      "-[safe](https://safe.example)",
      "+[evil](https://evil.example)",
    ],
  );

  const headingLevel = buildView(
    `--- a/headings.md
+++ b/headings.md
@@ -1 +1 @@
-## Old title
+# New title
`,
    undefined,
    true,
  );
  const renderedHeadingLevel = headingLevel.editSource.render?.(
    headingLevel.doc,
  );
  assert(renderedHeadingLevel);
  assertEquals(
    renderedHeadingLevel.lines.slice(3, 5).map((line) => line.text),
    ["-## Old title", "+# New title"],
  );

  const multilineCode = buildView(
    `--- a/code.md
+++ b/code.md
@@ -1,2 +1,2 @@
 \`first
-second\`
+third\`
`,
    undefined,
    true,
  );
  const renderedMultilineCode = multilineCode.editSource.render?.(
    multilineCode.doc,
  );
  assert(renderedMultilineCode);
  assertEquals(
    renderedMultilineCode.lines.slice(3, 6).map((line) => line.text),
    [" first", "-second", "+third"],
  );
});

Deno.test("rendered Markdown diff restores hidden old-file source", () => {
  const diffText = `diff --git a/notes.md b/notes.md
index 1234..5678 100644
--- a/notes.md
+++ b/notes.md
@@ -1,2 +1 @@
-# Removed heading
 keep
`;
  const model = parseDiff(diffText);
  assert(model);
  const workspace: DiffWorkspace = {
    resolve: () => "/workspace/notes.md",
    read: () => "keep\n",
    readBlob: (object) =>
      object === "1234" ? "# Removed heading\nkeep\n" : null,
  };
  const rendered = buildDiffDocument(
    diffText,
    model,
    workspace,
    new Map(),
    "rendered",
  ).doc;
  assertEquals(rendered.lines[5].text, "-# Removed heading");
  assertEquals(rendered.lines[5].renderedSourceHidden, undefined);
});

Deno.test("rendered Markdown diff restores source with every span fallback", () => {
  const lines: Line[] = [
    {
      text: "-rendered",
      spans: [],
      renderedSourceHidden: true,
    },
    {
      text: "-rendered",
      spans: [],
      renderedSourceHidden: true,
    },
    {
      text: "-rendered",
      spans: [],
      renderedSourceHidden: true,
    },
  ];
  const context = {
    rawLines: ["-same", "-raw", "-plain"],
    lines,
  } as unknown as Parameters<
    typeof diffDocumentInternals.restoreLossyChangeGroup
  >[2];
  const sourceFallbacks = new Map([
    [
      0,
      {
        text: "same",
        spans: [{ col: 0, text: "same", cls: "sectionHeader" as const }],
      },
    ],
    [
      1,
      {
        text: "different",
        spans: [{ col: 0, text: "different", cls: "string" as const }],
      },
    ],
  ]);

  diffDocumentInternals.restoreLossyChangeGroup(
    [0, 1, 2],
    [],
    context,
    sourceFallbacks,
  );

  assertEquals(lines.map((line) => line.text), ["-same", "-raw", "-plain"]);
  assertEquals(lines[0].spans.map((span) => span.cls), [
    "diffDel",
    "sectionHeader",
  ]);
  assertEquals(lines[1].spans.map((span) => span.cls), ["diffDel", "plain"]);
  assertEquals(lines[2].spans.map((span) => span.cls), ["diffDel", "plain"]);
});

Deno.test("diff expansion rebuilds the active rendered Markdown view", () => {
  const fileText = "# Title\nalpha\nnew **value**\nomega\n";
  const diffText = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -3 +3 @@
-old value
+new **value**
`;
  const absPath = "/workspace/notes.md";
  const workspace: DiffWorkspace = {
    resolve: () => absPath,
    read: (path) => path === absPath ? fileText : null,
  };
  const cache: WorkspaceCache = new Map();
  const model = parseDiff(diffText);
  assert(model);
  const { doc, edit } = buildDiffDocument(
    diffText,
    model,
    workspace,
    cache,
  );
  const session = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 10 },
    undefined,
    diffSource(workspace, edit, cache),
  );

  press(session, "v");
  assertEquals(session.doc.lines[5].text, "+new value");
  press(session, "#", "#");
  assertEquals(session.view().lineNumbers?.[4], null);
  assertEquals(session.view().lineNumbers?.[5], 3);
  assert(session.view().canExpand, "the compact hunk offers more context");
  press(session, "ctrl-l");

  assertEquals(session.view().viewMode, "rendered");
  const sourceLines = session.doc.text.split("\n");
  const titleLine = sourceLines.findIndex((line) => line.includes("# Title"));
  assert(titleLine >= 0, "expansion revealed the file heading");
  assertEquals(session.doc.lines[titleLine].text, " Title");
  assert(
    session.doc.lines.some((line) => line.text === "+new value"),
    "the changed Markdown line remains rendered",
  );
});
