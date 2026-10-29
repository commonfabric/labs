/**
 * Tests for the template a markdown document builds.
 *
 * A Lit template is two things: static strings, which Lit parses as markup,
 * and values, which it puts in a text node or an attribute value without
 * parsing. The document is safe to render exactly when none of it reaches the
 * first, so the tests here read both halves apart and say which one each piece
 * of a document landed in. That is a stronger statement than any list of
 * payloads, and it needs no DOM: a template is inert data until something
 * renders it, which `cf-markdown.browser.test.ts` does.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { nothing } from "lit";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { markdownTemplate } from "./markdown-template.ts";

/** A Lit template, as the tag function returns it. */
interface Template {
  strings: readonly string[];
  values: readonly unknown[];
}

/** A directive, which stands in for a value until Lit commits it. */
interface Directive {
  values: readonly unknown[];
}

function isTemplate(value: unknown): value is Template {
  return isObjectOrArray(value) && "_$litType$" in value;
}

function isDirective(value: unknown): value is Directive {
  return isObjectOrArray(value) &&
    "_$litDirective$" in value;
}

/** Renders a document, discarding what its checkboxes report. */
function templateFor(source: string): unknown {
  return markdownTemplate(source, { checkboxToggled: () => {} });
}

/** Everything Lit parses as markup when it renders `value`. */
function markupOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(markupOf).join("");
  if (isTemplate(value)) {
    return value.strings.join("") + value.values.map(markupOf).join("");
  }
  return "";
}

/** Everything Lit binds without parsing when it renders `value`. */
function boundValues(value: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) boundValues(item, into);
  } else if (isTemplate(value)) {
    for (const item of value.values) boundValues(item, into);
  } else if (isDirective(value)) {
    for (const item of value.values) boundValues(item, into);
  } else {
    into.push(value);
  }
  return into;
}

/** The bound values that are text, which is what a reader ends up seeing. */
function boundText(source: string): string[] {
  return boundValues(templateFor(source)).filter((value) =>
    typeof value === "string"
  ) as string[];
}

/**
 * A document that reaches every kind of token, used where a test needs the
 * builder to have been down each branch rather than any one result.
 */
const KITCHEN_SINK = [
  "# One",
  "## Two",
  "### Three",
  "#### Four",
  "##### Five",
  "###### Six",
  "",
  "A paragraph with **bold**, *italic*, ~~struck~~ and `code`.",
  "",
  "> A quote.",
  "",
  "- a",
  "- b",
  "",
  "1. first",
  "",
  "- [ ] undone",
  "- [x] done",
  "",
  "| A | B |",
  "| :-- | --: |",
  "| 1 | 2 |",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "---",
  "",
  "[label](https://example.test/a) and ![alt](https://example.test/a.png)",
  "",
  "[Name](/of:bafyabc/field)",
].join("\n");

describe("markdown-template", () => {
  describe("markdownTemplate()", () => {
    // Each of these is a way a markdown document can carry markup, a URL that
    // runs script, or an event handler.
    const HOSTILE = [
      "<script>steal()</script>",
      '<img src="x" onerror="steal()">',
      '<div onmouseover="steal()">hover me</div>',
      '<iframe src="javascript:steal()"></iframe>',
      '<a href="javascript:steal()">an anchor</a>',
      "[a link](javascript:steal())",
      "[a link](JaVaScRiPt:steal())",
      "![an image](javascript:steal())",
      "[a link](data:text/html;base64,c3RlYWwoKQ==)",
      "[a link](vbscript:steal())",
      "<style>@import url(https://example.invalid/x.css);</style>",
      "# <script>steal()</script>",
      "| <script>steal()</script> |\n| --- |\n| `<script>` |",
    ].join("\n\n");

    it("puts no part of a hostile document in the markup it builds", () => {
      const markup = markupOf(templateFor(HOSTILE)).toLowerCase();

      for (
        const fragment of [
          "script",
          "onerror",
          "onmouseover",
          "iframe",
          "javascript:",
          "vbscript:",
          "data:text/html",
          "steal",
        ]
      ) {
        expect(markup).not.toContain(fragment);
      }
    });

    it("builds its markup out of tags this module names", () => {
      // Every `<` in the markup opens a tag this module wrote. A document that
      // reached the markup would put one here that is not on this list.
      const allowed = new Set([
        "a",
        "blockquote",
        "br",
        "cf-cell-link",
        "cf-copy-button",
        "code",
        "del",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "img",
        "input",
        "li",
        "ol",
        "p",
        "pre",
        "strong",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "ul",
      ]);
      const markup = markupOf(templateFor(`${HOSTILE}\n\n${KITCHEN_SINK}`));
      const tags = [...markup.matchAll(/<\/?([a-zA-Z][^\s/>]*)/g)].map((
        match,
      ) => match[1].toLowerCase());

      expect(tags.length).toBeGreaterThan(0);
      expect([...new Set(tags)].filter((tag) => !allowed.has(tag))).toEqual([]);
    });

    it("keeps a hostile document's text, as text", () => {
      // Dropping the markup does not drop what a person wrote around it.
      expect(boundText("A <b>bold</b> word").join("")).toContain("A bold word");
    });

    it("renders emphasis, strong text, strikethrough and a code span", () => {
      const markup = markupOf(templateFor("**a** *b* ~~c~~ `d`"));

      expect(markup).toContain("<strong>");
      expect(markup).toContain("<em>");
      expect(markup).toContain("<del>");
      expect(markup).toContain("<code>");
      // The spaces between them are text of their own.
      expect(boundText("**a** *b* ~~c~~ `d`")).toEqual([
        "a",
        " ",
        "b",
        " ",
        "c",
        " ",
        "d",
      ]);
    });

    it("gives each heading level its own tag, and an id", () => {
      for (let depth = 1; depth <= 6; depth++) {
        const source = `${"#".repeat(depth)} A Heading`;

        expect(markupOf(templateFor(source))).toContain(`<h${depth} id=`);
        expect(boundText(source)).toEqual(["a-heading", "A Heading"]);
      }
    });

    it("renders a code block with its language and a copy button", () => {
      const source = "```js\nconst a = 1;\n```";

      expect(markupOf(templateFor(source))).toContain("cf-copy-button");
      // The language, then the code, then the same code for the copy button.
      expect(boundText(source)).toEqual([
        "language-js",
        "const a = 1;\n",
        "const a = 1;\n",
      ]);
    });

    it("renders a code block with no language", () => {
      expect(boundText("```\nplain\n```")).toEqual(["plain\n", "plain\n"]);
    });

    it("renders a list, and numbers an ordered one from its start", () => {
      expect(markupOf(templateFor("- a\n- b"))).toContain("<ul>");
      expect(markupOf(templateFor("1. a\n2. b"))).toContain("<ol start=");
      // A list starting at 1 needs no `start`, so the binding removes it.
      expect(boundValues(templateFor("1. a"))[0]).toBe(nothing);
      expect(boundValues(templateFor("3. a"))[0]).toBe(3);
    });

    it("renders a task list checkbox per item", () => {
      const markup = markupOf(templateFor("- [ ] one\n- [x] two"));

      expect([...markup.matchAll(/<input/g)].length).toBe(2);
      expect(boundValues(templateFor("- [ ] one\n- [x] two"))).toContain(false);
      expect(boundValues(templateFor("- [ ] one\n- [x] two"))).toContain(true);
    });

    it("renders a table, its header, and each cell's alignment", () => {
      const source = "| A | B |\n| :-- | --: |\n| 1 | 2 |";
      const markup = markupOf(templateFor(source));

      expect(markup).toContain('<div class="table-scroll">');
      expect(markup).toContain("<thead>");
      expect(markup).toContain("<tbody>");
      expect(markup).toContain("<th align=");
      expect(markup).toContain("<td align=");
      // Every cell binds its own alignment, header and body alike.
      expect(boundText(source)).toEqual([
        "left",
        "A",
        "right",
        "B",
        "left",
        "1",
        "right",
        "2",
      ]);
    });

    it("renders a table with a header and no rows", () => {
      const markup = markupOf(templateFor("| A |\n| --- |"));

      expect(markup).toContain("<thead>");
      expect(markup).not.toContain("<tbody>");
    });

    it("renders a blockquote, a rule and a line break", () => {
      expect(markupOf(templateFor("> quoted"))).toContain("<blockquote>");
      expect(markupOf(templateFor("---"))).toContain("<hr>");
      expect(markupOf(templateFor("a\nb"))).toContain("<br>");
    });

    it("renders a link the browser may follow, with its title", () => {
      const source = '[label](https://example.test/a "the title")';

      expect(markupOf(templateFor(source))).toContain("<a href=");
      expect(boundText(source)).toEqual([
        "https://example.test/a",
        "the title",
        "label",
      ]);
    });

    it("renders a link with no title", () => {
      expect(boundText("[label](https://example.test/a)")).toEqual([
        "https://example.test/a",
        "label",
      ]);
    });

    it("renders a link the browser must not follow as its text alone", () => {
      const source = "[label](javascript:steal())";

      expect(markupOf(templateFor(source))).not.toContain("<a href=");
      expect(boundText(source)).toEqual(["label"]);
    });

    it("renders a cell link as a cf-cell-link", () => {
      const source = "[Name](/of:bafyabc/field)";

      expect(markupOf(templateFor(source))).toContain("<cf-cell-link");
      expect(boundText(source)).toEqual(["/of:bafyabc/field", "Name"]);
    });

    it("renders a cell link that names its space as a cf-cell-link", () => {
      // The cross-space form opens with the space rather than the piece. The
      // runner's own matcher decides what a cell link looks like, so both
      // forms reach the pill.
      const target = "/@did:key:z6MkABC/of:bafyabc/field";
      const source = `[Name](${target})`;

      expect(markupOf(templateFor(source))).toContain("<cf-cell-link");
      expect(boundText(source)).toEqual([target, "Name"]);
    });

    it("renders an image the browser may load, with its title", () => {
      const source = '![alt](https://example.test/a.png "the title")';

      expect(markupOf(templateFor(source))).toContain("<img src=");
      expect(boundText(source)).toEqual([
        "https://example.test/a.png",
        "alt",
        "the title",
      ]);
    });

    it("renders an image carrying its own bytes", () => {
      const source = "![alt](data:image/png;base64,AAAA)";

      expect(markupOf(templateFor(source))).toContain("<img src=");
      expect(boundText(source)).toEqual(["data:image/png;base64,AAAA", "alt"]);
    });

    it("renders an image the browser must not load as its alt text alone", () => {
      const source = "![alt](javascript:steal())";

      expect(markupOf(templateFor(source))).not.toContain("<img src=");
      expect(boundText(source)).toEqual(["alt"]);
    });

    it("resolves a backslash escape to the character it escaped", () => {
      expect(boundText("a \\* b")).toEqual(["a ", "*", " b"]);
    });

    it("renders nothing for an empty document", () => {
      expect(markupOf(templateFor(""))).toBe("");
    });

    it("renders nothing for a link reference definition", () => {
      // The definition draws nothing; the link that uses it draws an anchor.
      expect(markupOf(templateFor("[ref]: https://example.test/a")))
        .toBe("");
    });

    it("numbers checkboxes across the whole document, in order", () => {
      const reported: Array<[number, boolean]> = [];
      const template = markdownTemplate("- [ ] one\n- [ ] two\n\n- [ ] three", {
        checkboxToggled: (index, checked) => reported.push([index, checked]),
      });
      const handlers = boundValues(template).filter((value) =>
        typeof value === "function"
      ) as Array<(event: Event) => void>;

      expect(handlers.length).toBe(3);
      for (const handler of handlers) {
        handler({ target: { checked: true } } as unknown as Event);
      }

      expect(reported).toEqual([[0, true], [1, true], [2, true]]);
    });
  });
});
