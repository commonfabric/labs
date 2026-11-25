import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { htmlLanguage } from "../../../../../lib/view/languages/html/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

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

function highlight(source: string): Line[] {
  return htmlLanguage.highlightLines(source);
}

/** The colored lines of a `script` element whose start tag is `tag`. */
function script(tag: string, body: string): Line[] {
  return highlight(`${tag}${body}</script>`);
}

describe("htmlLanguage", () => {
  beforeAll(() => htmlLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries the representative filenames and
    // aliases; these cases are the ones it does not.

    it("selects pages in any case, and leaves templates and XHTML alone", () => {
      for (const path of ["index.HTML", "Page.Htm"]) {
        expect(languageForFile(path).id).toBe("html");
      }
      for (const path of ["page.xhtml", "page.html.j2", "page.shtml"]) {
        expect(languageForFile(path).id).not.toBe("html");
      }
    });
  });

  describe("highlighting", () => {
    it("colors markup", () => {
      const lines = highlight([
        "<!DOCTYPE html>",
        '<html lang=en data-x="1">',
        "<!-- a comment -->",
        "<p class='lead'>Fish &amp; chips&#33;<br/> </p>",
        "</div>",
      ].join("\n"));

      expect(classesOf(lines, "DOCTYPE")).toEqual(["keyword"]);
      expect(classesOf(lines, "<!")).toEqual(["punctuation"]);
      for (const name of ["html", "p", "br", "div"]) {
        expect(classesOf(lines, name)).toContain("typeName");
      }
      for (const name of ["lang", "data-x", "class"]) {
        expect(classesOf(lines, name)).toEqual(["propertyName"]);
      }
      expect(classesOf(lines, "en")).toEqual(["string"]);
      expect(classesOf(lines, '"1"')).toEqual(["string"]);
      expect(classesOf(lines, "'lead'")).toEqual(["string"]);
      expect(classesOf(lines, "=")).toEqual(["operator"]);
      expect(classesOf(lines, "<!-- a comment -->")).toEqual(["comment"]);
      expect(classesOf(lines, "&amp;")).toEqual(["keyword"]);
      expect(classesOf(lines, "&#33;")).toEqual(["keyword"]);
      expect(classesOf(lines, "Fish")).toEqual(["plain"]);
      for (const token of ["<", ">", "</", "/>"]) {
        expect(classesOf(lines, token)).toEqual(["punctuation"]);
      }
    });

    it("colors a script's text as JavaScript", () => {
      for (
        const tag of [
          "<script>",
          '<script type="">',
          '<script type="module">',
          "<script type=text/javascript>",
          '<script type=" Text/JavaScript\n">',
          '<script type="application/ecmascript">',
          '<SCRIPT TYPE="MODULE">',
          '<script language="JavaScript">',
          '<script language="">',
          '<script type="" language="vbscript">',
        ]
      ) {
        const lines = script(tag, "const n = f(1); // done");

        expect(classesOf(lines, "const")).toEqual(["storageKeyword"]);
        expect(classesOf(lines, "n")).toEqual(["binding"]);
        expect(classesOf(lines, "1")).toEqual(["number"]);
        expect(classesOf(lines, "// done")).toEqual(["comment"]);
      }
    });

    it("colors an import map, speculation rules, and JSON data as JSON", () => {
      for (
        const tag of [
          '<script type="importmap">',
          '<script type="speculationrules">',
          '<script type="application/ld+json">',
          '<script type="application/json; charset=utf-8">',
          '<script type="text/json">',
        ]
      ) {
        const lines = script(tag, '{"imports": {"a": 1}}');

        expect(classesOf(lines, '"imports"')).toEqual(["propertyName"]);
        expect(classesOf(lines, "1")).toEqual(["number"]);
      }
    });

    it("leaves any other data block uncolored", () => {
      for (
        const tag of [
          '<script type="text/template">',
          '<script type="text/javascript; charset=utf-8">',
          '<script type="text/plain">',
          '<script type=" ">',
          '<script type="\u00a0text/javascript">',
          '<script language="vbscript">',
        ]
      ) {
        const lines = script(tag, "const n = 1;");

        for (const token of ["const", "n", "1;"]) {
          expect(classesOf(lines, token)).toEqual(["plain"]);
        }
      }
    });

    it("colors an event handler's value as JavaScript and other values as strings", () => {
      const lines = highlight(
        '<button onclick="go(1)" ONLOAD=start() onpointerdown="tap()" ' +
          'title="go(2)" only="f(3)" one-other="f(4)" on="tap:f(5)">Go</button>',
      );

      expect(classesOf(lines, "go")).toEqual(["callName"]);
      expect(classesOf(lines, "1")).toEqual(["number"]);
      expect(classesOf(lines, "start")).toEqual(["callName"]);
      expect(classesOf(lines, "tap")).toEqual(["callName"]);
      for (const value of ['"go(2)"', '"f(3)"', '"f(4)"', '"tap:f(5)"']) {
        expect(classesOf(lines, value)).toEqual(["string"]);
      }
      // The quotes around a handler's value stay part of the markup.
      expect(classesOf(lines, '"')).toEqual(["string"]);
    });

    it("reads character references in an attribute's value as the characters they stand for", () => {
      const lines = highlight(
        '<a onclick="say(&quot;hi&quot;) &amp;&amp; go(&#49;)" ' +
          'style="content: &apos;x&apos;">x</a>' +
          '<script type="text&#47;javascript">let n;</script>',
      );

      expect(classesOf(lines, "say")).toEqual(["callName"]);
      expect(classesOf(lines, "&quot;hi&quot;")).toEqual(["string"]);
      expect(classesOf(lines, "&amp;&amp;")).toEqual(["operator"]);
      expect(classesOf(lines, "&#49;")).toEqual(["number"]);
      // The value's closing quote is a string as well.
      expect(classesOf(lines, '&apos;x&apos;"')).toEqual(["string"]);
      expect(classesOf(lines, "let")).toEqual(["storageKeyword"]);
    });

    it("reads an ampersand that starts no character reference as written", () => {
      // A named reference with no semicolon before a letter, digit, or `=` is
      // text in an attribute, and a reference inside a name is part of it.
      const lines = highlight(
        '<a onclick="x&&go(a&b, b&ltr=1, c&copy2=3, f&#111;o())">x</a>' +
          '<a onclick="if (x&ltimeout) go()">y</a>',
      );

      expect(classesOf(lines, "&&")).toEqual(["operator"]);
      expect(classesOf(lines, "go")).toEqual(["callName"]);
      for (const name of ["a", "b", "ltr", "c", "copy2"]) {
        expect(classesOf(lines, name)).toContain("identifier");
      }
      expect(classesOf(lines, "f&#111;o")).toEqual(["callName"]);
      expect(classesOf(lines, "ltimeout")).toEqual(["identifier"]);
    });

    it("compares attribute names without regard to ASCII case alone", () => {
      // The Kelvin sign lowercases to "k" outside ASCII.
      const lines = highlight(
        '<a ONCLICK="go()" on\u212Aeydown="stop()" onkeydown="run()">x</a>',
      );

      expect(classesOf(lines, "go")).toEqual(["callName"]);
      expect(classesOf(lines, "run")).toEqual(["callName"]);
      expect(classesOf(lines, '"stop()"')).toEqual(["string"]);
    });

    it("colors a style element's text as CSS", () => {
      for (
        const tag of ["<style>", '<style type="TEXT/CSS">', "<style type>"]
      ) {
        const lines = highlight(`${tag}p.lead { color: red; }</style>`);

        expect(classesOf(lines, "style")).toEqual(["typeName"]);
        expect(classesOf(lines, ".lead")).toEqual(["interfaceName"]);
        expect(classesOf(lines, "color")).toEqual(["propertyName"]);
        expect(classesOf(lines, "{")).toEqual(["bracket"]);
      }
    });

    it("leaves a style element of another type uncolored", () => {
      // The standard compares the type without removing white space.
      for (
        const tag of ['<style type="text/less">', '<style type=" text/css">']
      ) {
        const lines = highlight(`${tag}p { color: red; }</style>`);

        for (const token of ["p", "{", "color:", "red;", "}"]) {
          expect(classesOf(lines, token)).toEqual(["plain"]);
        }
      }
    });

    it("colors a style attribute's value as CSS declarations", () => {
      const lines = highlight(
        '<p style="color: var(--ink); margin: 0" STYLE=width:4px>x</p>',
      );

      for (const name of ["color", "margin", "width"]) {
        expect(classesOf(lines, name)).toEqual(["propertyName"]);
      }
      expect(classesOf(lines, "var")).toEqual(["callName"]);
      expect(classesOf(lines, "--ink")).toEqual(["identifier"]);
      expect(classesOf(lines, "0")).toEqual(["number"]);
      expect(classesOf(lines, "4px")).toEqual(["number"]);
      expect(classesOf(lines, '"')).toEqual(["string"]);
    });

    it("colors a script that is never closed", () => {
      const lines = highlight("<body>\n<script>\nlet open = [1, 2");

      expect(classesOf(lines, "let")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "[")).toEqual(["bracket"]);
    });

    it("colors a script at its offsets after non-ASCII text and line breaks", () => {
      const lines = highlight(
        "<p>café ☕ 😀</p>\r\n<script>\r\nconst a = 1;\r\nlet b = 2;\r\n</script>",
      );

      expect(classesOf(lines, "const")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "let")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "2")).toEqual(["number"]);
      expect(classesOf(lines, "script")).toEqual(["typeName"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          "<p class='open",
          "<div><span>unclosed",
          "</p>",
          "<!-- open comment",
          "<script>if (",
          "<script type=",
          "<a href=x onclick=>",
          "<p>\r\n</p>\r\n",
          "\ud800",
          "",
          " \t",
          "<p>café ☕ 😀</p>",
          "<<>>",
        ]
      ) {
        expect(verbatim(htmlLanguage.parseDocument(source).lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    it("lists elements by tag name and their id or name", () => {
      const document = htmlLanguage.parseDocument([
        "<!doctype html>",
        "<html>",
        "<head><title>T</title><style></style></head>",
        '<body id="main">',
        '  <form name="login"><input name=user id="u&amp;v"></form>',
        '  <p id=""></p><p id="two&#10;lines\n  here"></p>',
        '  <input id="" name="user"><p id="&varphiZ x&notin y&ltimeout"></p>',
        "  <script></script>",
        "</body>",
        "</html>",
      ].join("\n"));

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
        ]),
      ).toEqual([
        ["object", "html", 0, 1],
        ["object", "head", 1, 2],
        ["object", "title", 2, 2],
        ["object", "style", 2, 2],
        ["object", "body main", 1, 3],
        ["object", "form login", 2, 4],
        ["object", "input u&v", 3, 4],
        ["object", "p", 2, 5],
        ["object", "p two lines here", 2, 5],
        ["object", "input user", 2, 7],
        ["object", "p &varphiZ x&notin y&ltimeout", 2, 7],
        ["object", "script", 2, 8],
      ]);
      expect(document.definitions.size).toBe(0);
    });

    it("lists the elements error recovery keeps inside an error", () => {
      // A script that is never closed leaves the elements around it unclosed,
      // and recovery keeps the ones that closed inside an error.
      const document = htmlLanguage.parseDocument(
        "<html><head><title>T</title></head><body>\n<div id=x>two</div>\n" +
          "<script>let a = 1;",
      );

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["head", 0], ["title", 1], ["div x", 0]]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "<!-- café ☕ and an astral 😀 -->",
        '<div id="a">',
        "<script>",
        "const total = sum(1, 2);",
        "</script>",
        "<style>p { color: red; }</style>",
        "</div>",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ['id="a"', 'id="b" onclick="go()" style="margin: 0"'],
        ["color: red;", "color: red; --gap: 2px"],
        ["sum(1, 2)", "sum(1, 2"],
        ["</script>", "</scrip>"],
        ["<script>", '<script type="importmap">'],
        // A stretch put before the others moves each of them to another slot.
        ['<div id="b"', '<i style="color: blue" onclick="f()"></i><div id="b"'],
        ["<!-- café", "café"],
      ];
      const highlighter = htmlLanguage.createHighlighter(source);
      let current = source;
      for (const [from, to] of edits) {
        expect(current).toContain(from);
        current = current.replace(from, to);
        const updated = highlighter.update(current);
        expect(verbatim(updated)).toBe(current);
        expect(updated.map((line) => line.spans)).toEqual(
          highlight(current).map((line) => line.spans),
        );
      }
    });

    it("colors a diff of an unavailable file", () => {
      const diff = [
        "diff --git a/index.html b/index.html",
        "--- a/index.html",
        "+++ b/index.html",
        "@@ -1,3 +1,3 @@",
        " <script>",
        "-let theme = 'light';",
        "+const theme = 'dark';",
        " </script>",
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, "script")).toEqual(["typeName"]);
      expect(classesOf(doc.lines, "let")).toEqual(["storageKeyword"]);
      expect(classesOf(doc.lines, "const")).toEqual(["storageKeyword"]);
      expect(classesOf(doc.lines, "'dark'")).toEqual(["string"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
