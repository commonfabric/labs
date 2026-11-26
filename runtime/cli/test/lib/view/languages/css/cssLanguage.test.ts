import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { cssLanguage } from "../../../../../lib/view/languages/css/language.ts";
import { findReferences } from "../../../../../lib/view/references.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { beforeAll, describe, it } from "@commonfabric/test-support/test";

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
  return cssLanguage.highlightLines(source);
}

describe("cssLanguage", () => {
  beforeAll(() => cssLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries the representative filenames and
    // alias; these cases are the ones it does not.

    it("selects style sheets in any case", () => {
      for (const path of ["APP.CSS", "Theme.Css"]) {
        expect(languageForFile(path).id).toBe("css");
      }
    });

    it("leaves preprocessor style sheets to other languages", () => {
      for (const path of ["site.scss", "site.sass", "site.less"]) {
        expect(languageForFile(path).id).not.toBe("css");
      }
    });
  });

  describe("highlighting", () => {
    it("colors selectors by what each part matches", () => {
      const lines = highlight(
        'nav > a.link:hover::before, #main [data-state="open"] * { }',
      );

      expect(classesOf(lines, "nav")).toEqual(["typeName"]);
      expect(classesOf(lines, "a")).toEqual(["typeName"]);
      expect(classesOf(lines, ".link")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "#main")).toEqual(["interfaceName"]);
      expect(classesOf(lines, ":hover::before")).toEqual(["keyword"]);
      expect(classesOf(lines, "data-state")).toEqual(["propertyName"]);
      expect(classesOf(lines, '"open"')).toEqual(["string"]);
      expect(classesOf(lines, ">")).toEqual(["operator"]);
      expect(classesOf(lines, "=")).toEqual(["operator"]);
      expect(classesOf(lines, "*")).toEqual(["operator"]);
      expect(classesOf(lines, ",")).toEqual(["punctuation"]);
      expect(classesOf(lines, "[")).toEqual(["bracket"]);
    });

    it("colors the selector arguments of pseudo-classes", () => {
      const lines = highlight("li:nth-child(2n of .done), p:not(.x) { }");

      expect(classesOf(lines, ":nth-child")).toEqual(["keyword"]);
      expect(classesOf(lines, "of")).toEqual(["keyword"]);
      expect(classesOf(lines, ".done")).toEqual(["interfaceName"]);
      expect(classesOf(lines, ":not")).toEqual(["keyword"]);
      expect(classesOf(lines, ".x")).toEqual(["interfaceName"]);
    });

    it("colors declarations and the values they set", () => {
      const lines = highlight([
        "/* Comment */",
        ".card {",
        "  --gap: 4px;",
        "  margin: 0 auto;",
        "  padding: var(--gap) calc(1em + 2px) !important;",
        "  color: #3a7bd5;",
        "  background: url(icons/item.svg) no-repeat;",
        '  font-family: "SF Pro", system-ui;',
        "  .inner & { opacity: .5 }",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "/* Comment */")).toEqual(["comment"]);
      for (const name of ["--gap", "margin", "padding", "color", "opacity"]) {
        expect(classesOf(lines, name)).toContain("propertyName");
      }
      // A custom property's name where a value refers to it is an identifier.
      expect(classesOf(lines, "--gap")).toEqual(["propertyName", "identifier"]);
      for (const value of ["auto", "no-repeat", "system-ui"]) {
        expect(classesOf(lines, value)).toEqual(["boolean"]);
      }
      for (const number of ["4px", "0", "1em", "2px", "#3a7bd5", ".5"]) {
        expect(classesOf(lines, number)).toEqual(["number"]);
      }
      expect(classesOf(lines, "icons/item.svg")).toEqual(["string"]);
      expect(classesOf(lines, '"SF Pro"')).toEqual(["string"]);
      for (const name of ["var", "calc", "url"]) {
        expect(classesOf(lines, name)).toEqual(["callName"]);
      }
      expect(classesOf(lines, "+")).toEqual(["operator"]);
      expect(classesOf(lines, "&")).toEqual(["operator"]);
      expect(classesOf(lines, "!important")).toEqual(["keyword"]);
      expect(classesOf(lines, ":")).toEqual(["punctuation"]);
      expect(classesOf(lines, ";")).toEqual(["punctuation"]);
      expect(classesOf(lines, "{")).toEqual(["bracket"]);
    });

    it("colors at-rules, their conditions, and keyframes", () => {
      const lines = highlight([
        '@import url("base.css") screen;',
        "@media (max-width: 600px) and not print {",
        "  .c { display: none }",
        "}",
        "@keyframes spin { from { opacity: 0 } 50% { opacity: 1 } to { } }",
        '@font-face { font-family: "X"; src: url(x.woff2) format("woff2"); }',
        "@scope (.card) to (.content) { }",
      ].join("\n"));

      for (
        const keyword of [
          "@import",
          "@media",
          "and",
          "not",
          "@keyframes",
          "from",
          "to",
          "@font-face",
        ]
      ) {
        expect(classesOf(lines, keyword)).toEqual(["keyword"]);
      }
      expect(classesOf(lines, "max-width")).toEqual(["propertyName"]);
      expect(classesOf(lines, "screen")).toEqual(["boolean"]);
      expect(classesOf(lines, "print")).toEqual(["boolean"]);
      expect(classesOf(lines, "spin")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "50%")).toEqual(["number"]);
      expect(classesOf(lines, '"base.css"')).toEqual(["string"]);
      expect(classesOf(lines, "x.woff2")).toEqual(["string"]);
      expect(classesOf(lines, "format")).toEqual(["callName"]);
    });

    it("colors the size and line height of a font shorthand as numbers", () => {
      const lines = highlight(
        ".a { font: 14px/1.5 sans-serif; } .b { font: 12px/normal serif; }",
      );

      expect(classesOf(lines, "14px/1.5")).toEqual(["number"]);
      expect(classesOf(lines, "12px/normal")).toEqual(["number"]);
      expect(classesOf(lines, "sans-serif")).toEqual(["boolean"]);
    });

    it("leaves keyword values around a slash as keyword values", () => {
      const lines = highlight(
        ".a { background: no-repeat center/cover; grid-area: header/main; }",
      );

      expect(classesOf(lines, "center/cover")).toEqual(["boolean"]);
      expect(classesOf(lines, "header/main")).toEqual(["boolean"]);
    });

    it("colors URL functions in any case, and leaves other functions' values as values", () => {
      const lines = highlight(
        ".a { background: URL(a.png); filter: blur(x); }",
      );

      expect(classesOf(lines, "a.png")).toEqual(["string"]);
      expect(classesOf(lines, "x")).toEqual(["boolean"]);
    });

    it("leaves keywords uncolored inside longer words the grammar cannot parse", () => {
      const lines = highlight(".b { color: red ! important }");

      expect(classesOf(lines, "important")).toEqual(["plain"]);
      expect(classesOf(lines, "or")).toEqual([]);
    });

    it("leaves text after a double slash uncolored, as CSS has no line comments", () => {
      const lines = highlight("a { color: red; } // note\nb { }");

      expect(classesOf(lines, "//")).toEqual(["plain"]);
      expect(classesOf(lines, "note")).toEqual(["plain"]);
      expect(classesOf(lines, "b")).toEqual(["typeName"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          ".a { color: red",
          '.a { content: "open',
          "/* open comment",
          "@media (max-width: ",
          ".a { color: : ; }",
          "}}}",
          "@container style(--x: y) { .a { } }",
          ".a { b: c }\r\n.d { e: f }\r\n",
          "\ud800",
          "",
          " \t",
          '.a::after { content: "café ☕ 😀" }',
        ]
      ) {
        expect(verbatim(cssLanguage.parseDocument(source).lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    it("lists rule sets, at-rules, and custom properties", () => {
      const source = [
        '@import url("base.css");',
        ":root {",
        "  --gap: 4px;",
        "  color: black;",
        "}",
        "h1,",
        "h2 > .title {",
        "  margin: 0;",
        "  &:hover { color: red; }",
        "}",
        "@media (max-width: 600px) {",
        "  .c { display: none }",
        "}",
        "@keyframes spin {",
        "  to { opacity: 1 }",
        "}",
        "@font-face { font-family: X; }",
        "@supports (display: grid) { .g { display: grid } }",
        "@container card (min-width: 40em) { .h { } }",
        "@layer base { .i { } }",
      ].join("\n");
      const document = cssLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
        ]),
      ).toEqual([
        ["import", '@import url("base.css")', 0, 0],
        ["object", ":root", 0, 1],
        ["variable", "--gap", 1, 2],
        ["object", "h1, h2 > .title", 0, 5],
        ["object", "&:hover", 1, 8],
        ["control", "@media (max-width: 600px)", 0, 10],
        ["object", ".c", 1, 11],
        ["object", "@keyframes spin", 0, 13],
        ["object", "@font-face", 0, 16],
        ["control", "@supports (display: grid)", 0, 17],
        ["object", ".g", 1, 17],
        ["control", "@container card (min-width: 40em)", 0, 18],
        ["object", ".h", 1, 18],
        ["object", "@layer base", 0, 19],
        ["object", ".i", 1, 19],
      ]);
      // A keyframes rule's name is used in values that hold keyword values
      // too, as in `animation: spin 1s linear`, so no use of it is an
      // identifier that could reach a definition.
      expect([...document.definitions.keys()]).toEqual(["--gap"]);
    });

    it("indexes a custom property that @property registers, and colors at-rule names", () => {
      const source = [
        "@property --angle { syntax: '<angle>'; inherits: false; }",
        "@layer base { }",
        ".a { rotate: var(--angle); }",
      ].join("\n");
      const document = cssLanguage.parseDocument(source);

      expect(document.flatStructure.map((node) => [node.kind, node.label]))
        .toEqual([
          ["variable", "@property --angle"],
          ["object", "@layer base"],
          ["object", ".a"],
        ]);
      expect(document.definitions.has("--angle")).toBe(true);
      expect(document.flatStructure[0].nameOffset).toBe(
        source.indexOf("--angle"),
      );
      expect(classesOf(document.lines, "--angle")).toEqual(["identifier"]);
      expect(classesOf(document.lines, "base")).toEqual(["interfaceName"]);
      expect(findReferences(document, "--angle").map((use) => use.line))
        .toEqual([0, 2]);
    });

    it("finds the uses of a custom property through the values that refer to it", () => {
      const document = cssLanguage.parseDocument([
        ":root { --accent: #c33; }",
        ".a { color: var(--accent); }",
        ".b { border: 1px solid var(--accent, red); }",
        ".c { --accent-deep: black; }",
      ].join("\n"));

      // The declaration is the definition, and a longer name that starts the
      // same way is another property.
      expect(document.definitions.has("--accent")).toBe(true);
      expect(findReferences(document, "--accent").map((use) => use.line))
        .toEqual([1, 2]);
    });

    it("lists the custom properties a keyframe sets", () => {
      const document = cssLanguage.parseDocument(
        "@keyframes pulse { from { --glow: 0; } to { --glow: 1; } }",
      );

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["@keyframes pulse", 0], ["--glow", 1], ["--glow", 1]]);
    });

    it("gives each name its offset in source that is not all ASCII", () => {
      const source = "/* é😀 */ :root { --gäp: 1px; }\n.a { padding: 0 }";
      const document = cssLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [node.label, node.nameOffset]),
      )
        .toEqual([
          [":root", undefined],
          ["--gäp", source.indexOf("--gäp")],
          [".a", undefined],
        ]);
    });

    it("leaves comments out of the labels of rule sets and at-rules", () => {
      const document = cssLanguage.parseDocument(
        ".f /* first */ , .g { }\n@media /* wide */ (min-width: 9em) { /* inside */ }",
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        ".f , .g",
        "@media (min-width: 9em)",
      ]);
    });

    it("lists no entry for a rule set whose selector error recovery supplied", () => {
      const document = cssLanguage.parseDocument("{ --gap: 1px; }\n.a { }");

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["--gap", 0], [".a", 0]]);
    });

    it("lists the rule sets error recovery keeps inside an error", () => {
      // A brace typed where a value belongs puts the rule sets after it inside
      // an error, where the grammar reads them from the brace on.
      const document = cssLanguage.parseDocument(
        "* { box-sizing:{ border-box; }\n:root { --x: 1px; }",
      );

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["border-box; } :root", 0], ["--x", 1]]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "/* café ☕ and an astral 😀 */",
        ":root { --gap: 4px; }",
        ".card > a:hover {",
        "  padding: var(--gap);",
        '  content: "x";',
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ["var(--gap)", "calc(var(--gap) * 2)"],
        [".card > a", ".card a"],
        ['"x";', '"x'],
        ['"x', '"x";\n  color: #fff;'],
        ["/* café", "café"],
        [":root {", ":root"],
      ];
      const highlighter = cssLanguage.createHighlighter(source);
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
        "diff --git a/app.css b/app.css",
        "--- a/app.css",
        "+++ b/app.css",
        "@@ -1,3 +1,3 @@",
        " .toast {",
        "-  color: red;",
        "+  color: var(--ink);",
        " }",
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, ".toast")).toEqual(["interfaceName"]);
      expect(classesOf(doc.lines, "color")).toEqual(["propertyName"]);
      expect(classesOf(doc.lines, "red")).toEqual(["boolean"]);
      expect(classesOf(doc.lines, "--ink")).toEqual(["identifier"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
