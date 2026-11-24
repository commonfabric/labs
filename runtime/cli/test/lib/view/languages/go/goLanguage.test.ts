import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { goLanguage } from "../../../../../lib/view/languages/go/language.ts";
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
  return goLanguage.highlightLines(source);
}

describe("goLanguage", () => {
  beforeAll(() => goLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries the representative filenames and
    // aliases; these cases are the ones it does not.

    it("selects source files in any case", () => {
      for (const path of ["MAIN.GO", "Handler_test.Go"]) {
        expect(languageForFile(path).id).toBe("go");
      }
    });

    it("leaves module and checksum files to their own languages", () => {
      expect(languageForFile("go.mod").id).toBe("go-mod");
      expect(languageForFile("go.sum").id).toBe("go-sum");
      expect(languageForFile("main.go.orig").id).not.toBe("go");
    });
  });

  describe("highlighting", () => {
    it("colors declarations, calls, literals, and keywords", () => {
      const lines = highlight([
        "// Package render draws items.",
        "package render",
        "",
        "import (",
        '\t"fmt"',
        '\tstr "strings"',
        ")",
        "",
        "/* A block",
        "   comment */",
        "const Limit, Floor = 10, 0x1p-2",
        "",
        "type Item struct {",
        '\tName  string `json:"name"`',
        "\tCount int",
        "}",
        "",
        "type Lister[T any] interface{ List() []T }",
        "",
        "func (it *Item) Render(prefix string, rest ...int) (string, error) {",
        "\tout := str.ToUpper(prefix)",
        "\tfor i, n := range rest {",
        "\t\tif i >= Limit || n == 0 {",
        "\t\t\tbreak",
        "\t\t}",
        "\t}",
        "\tch := make(chan map[string]bool)",
        "\tgo func() { ch <- nil }()",
        "\treturn fmt.Sprintf(\"%s\\n\", out) + string('x'), nil",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "// Package render draws items.")).toEqual([
        "comment",
      ]);
      expect(classesOf(lines, "   comment */")).toEqual(["comment"]);
      expect(classesOf(lines, "package")).toEqual(["keyword"]);
      expect(classesOf(lines, "import")).toEqual(["keyword"]);
      expect(classesOf(lines, "render")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "Item")).toEqual(["interfaceName", "typeName"]);
      expect(classesOf(lines, "Lister")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "T")).toEqual(["typeName"]);
      expect(classesOf(lines, "str")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "Limit")).toEqual(["binding", "identifier"]);
      // The grammar gives the comma between two names the name field as well.
      expect(classesOf(lines, "Floor")).toEqual(["binding"]);
      expect(classesOf(lines, "Name")).toEqual(["propertyName"]);
      expect(classesOf(lines, "Render")).toEqual(["functionName"]);
      expect(classesOf(lines, "List")).toEqual(["functionName"]);
      expect(classesOf(lines, "ToUpper")).toEqual(["callName"]);
      expect(classesOf(lines, "make")).toEqual(["callName"]);
      expect(classesOf(lines, "it")).toEqual(["parameter"]);
      expect(classesOf(lines, "prefix")).toEqual(["parameter", "identifier"]);
      expect(classesOf(lines, "rest")).toEqual(["parameter", "identifier"]);
      for (const name of ["out", "i", "n", "ch"]) {
        expect(classesOf(lines, name)).toContain("binding");
      }
      for (const type of ["string", "int", "error", "any", "bool"]) {
        expect(classesOf(lines, type)).toContain("typeName");
      }
      for (const keyword of ["const", "type", "struct", "func", "interface"]) {
        expect(classesOf(lines, keyword)).toEqual(["storageKeyword"]);
      }
      for (const keyword of ["chan", "map"]) {
        expect(classesOf(lines, keyword)).toEqual(["typeKeyword"]);
      }
      for (const keyword of ["for", "range", "if", "break", "go", "return"]) {
        expect(classesOf(lines, keyword)).toEqual(["controlKeyword"]);
      }
      expect(classesOf(lines, '"fmt"')).toEqual(["string"]);
      expect(classesOf(lines, '`json:"name"`')).toEqual(["string"]);
      expect(classesOf(lines, "'x'")).toEqual(["string"]);
      expect(classesOf(lines, '"%s\\n"')).toEqual(["string"]);
      expect(classesOf(lines, "10")).toEqual(["number"]);
      expect(classesOf(lines, "0x1p-2")).toEqual(["number"]);
      expect(classesOf(lines, "nil")).toEqual(["keyword"]);
      for (const operator of [":=", ">=", "||", "==", "<-", "...", "*", "+"]) {
        expect(classesOf(lines, operator)).toEqual(["operator"]);
      }
      expect(classesOf(lines, "{")).toEqual(["bracket"]);
      expect(classesOf(lines, ".")).toEqual(["punctuation"]);
      expect(classesOf(lines, "fmt")).toEqual(["identifier"]);
    });

    it("colors a type switch's binding, its type keyword, and a nil case", () => {
      const lines = highlight(
        "package p\n\nfunc f(v any) {\n\tswitch t := v.(type) {\n\tcase nil:\n\t}\n}\n",
      );

      expect(classesOf(lines, "t")).toEqual(["binding"]);
      expect(classesOf(lines, "type")).toEqual(["keyword"]);
      expect(classesOf(lines, "nil")).toEqual(["keyword"]);
    });

    it("colors an alias's name, and no binding where a range assigns", () => {
      const lines = highlight(
        "package p\n\ntype A = int\n\nfunc f(m map[int]int) {\n\tfor k, v = range m {\n\t}\n}\n",
      );

      expect(classesOf(lines, "A")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "k")).toEqual(["identifier"]);
      expect(classesOf(lines, "v")).toEqual(["identifier"]);
    });

    it("colors the names a select case and an import declare", () => {
      const lines = highlight([
        "package p",
        "",
        'import (\n\t_ "embed"\n\t. "fmt"\n)',
        "",
        "func f(r chan int) {",
        "\tselect {",
        "\tcase x := <-r:",
        "\t\tPrintln(x)",
        "\t}",
        "}",
      ].join("\n"));

      expect(classesOf(lines, "x")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "_")).toEqual(["binding"]);
      expect(classesOf(lines, ".")).toEqual(["binding"]);
    });

    it("colors a directive to the Go command apart from comments", () => {
      const lines = highlight([
        "//go:build linux",
        "",
        "// Package p. Go:",
        "package p",
        "",
        "//go:embed x.txt",
        "var x string",
        "",
        "//export Run",
        "//line gen.go:10",
        "func Run() {}",
      ].join("\n"));

      for (
        const word of [
          "//go:build",
          "linux",
          "//go:embed",
          "//export",
          "//line",
          "gen.go:10",
        ]
      ) {
        expect(classesOf(lines, word)).toEqual(["keyword"]);
      }
      expect(classesOf(lines, "// Package p. Go:")).toEqual(["comment"]);
    });

    it("colors a cgo preamble as code, and the comments beyond the declaration before it as comments", () => {
      const lines = highlight([
        "// Package p.",
        "package p",
        "",
        "// #include <math.h>",
        "// #cgo LDFLAGS: -lm",
        'import "C"',
        "",
        "/*",
        "#include <stdio.h>",
        "*/",
        'import "C"',
        "",
        "// Doc for fmt.",
        'import "fmt"',
      ].join("\n"));

      for (const word of ["//", "#include", "<math.h>", "#cgo", "<stdio.h>"]) {
        expect(classesOf(lines, word)).toEqual(["keyword"]);
      }
      expect(classesOf(lines, "// Package p.")).toEqual(["comment"]);
      expect(classesOf(lines, "// Doc for fmt.")).toEqual(["comment"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'package p\n\nvar s = "open',
          "package p\n\nvar s = `open\nraw",
          "func f(",
          "type T struct {",
          "/* open comment",
          "}}}",
          "package p\r\n\r\nvar x = 1\r\n",
          "\ud800",
          "",
          " \t",
          'package p\n\nvar k = "café ☕ 😀"',
        ]
      ) {
        expect(verbatim(goLanguage.parseDocument(source).lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    it("lists the package, types, functions, methods, and package-level names", () => {
      const source = [
        "package render",
        "",
        'import "io"',
        "",
        "const Limit = 10",
        "",
        "var (",
        "\tcache   = map[string]int{}",
        "\tfirst, second int",
        ")",
        "",
        "type (",
        "\tItem struct {",
        "\t\tio.Reader",
        "\t\tName, Label string",
        "\t}",
        "\tLister interface {",
        "\t\tList() []Item",
        "\t}",
        "\tID     = string",
        "\tCounts []int",
        ")",
        "",
        "func New() *Item {",
        "\tvar local Item",
        "\ttype inner struct{}",
        "\treturn &local",
        "}",
        "",
        "func (it *Item) Render() string { return it.Name }",
        "",
        "func (Counts) Len() int { return 0 }",
      ].join("\n");
      const document = goLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
        ]),
      ).toEqual([
        ["object", "package render", 0, 0],
        ["variable", "const Limit", 0, 4],
        ["variable", "var cache", 0, 7],
        ["variable", "var first, second", 0, 8],
        ["class", "type Item", 0, 12],
        ["variable", "io.Reader", 1, 13],
        ["variable", "Name, Label", 1, 14],
        ["interface", "type Lister", 0, 16],
        ["method", "func List", 1, 17],
        ["typeAlias", "type ID", 0, 19],
        ["typeAlias", "type Counts", 0, 20],
        ["function", "func New", 0, 23],
        ["method", "func (*Item) Render", 0, 29],
        ["method", "func (Counts) Len", 0, 31],
      ]);
      expect([...document.definitions.keys()]).toEqual([
        "render",
        "Limit",
        "cache",
        "first",
        "Item",
        "Name",
        "Lister",
        "List",
        "ID",
        "Counts",
        "New",
        "Render",
        "Len",
      ]);
      expect(document.flatStructure[12].nameOffset).toBe(
        source.indexOf("Render"),
      );
    });

    it("names entries past comments, blank names, and struct tags", () => {
      const source = [
        "package /* doc */ main",
        "",
        "var _ = check()",
        "",
        "type Alias = struct {",
        '\t*Base `json:"base"`',
        "\tX int",
        "}",
        "",
        "func (/* recv */ a *Alias) Run() {}",
      ].join("\n");
      const document = goLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [node.label, node.depth]),
      ).toEqual([
        ["package main", 0],
        ["var _", 0],
        ["type Alias", 0],
        ["*Base", 1],
        ["X", 1],
        ["func (*Alias) Run", 0],
      ]);
      expect([...document.definitions.keys()]).toEqual([
        "main",
        "Alias",
        "X",
        "Run",
      ]);
    });

    it("lists the declarations error recovery keeps inside an error", () => {
      // An unclosed group puts the declaration it holds inside an error.
      const document = goLanguage.parseDocument(
        ["package p", "var (", "\tx = 1", "func F() {}"].join("\n"),
      );

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["package p", 0], ["var x", 0], ["func F", 0]]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "// café ☕ and an astral 😀",
        "package render",
        "",
        "func Render(items []string) string {",
        '\treturn items[0] + "-a"',
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ['"-a"', '"-b" + suffix()'],
        ["func Render", "func (r *R) Render"],
        ["items[0]", "items[0"],
        ["// café", "café"],
        ["package render", "package render\n\ntype R struct{}"],
      ];
      const highlighter = goLanguage.createHighlighter(source);
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
        "diff --git a/main.go b/main.go",
        "--- a/main.go",
        "+++ b/main.go",
        "@@ -1,3 +1,3 @@",
        " func run(ctx context.Context) error {",
        '-\treturn errors.New("stopped")',
        "+\treturn ctx.Err()",
        " }",
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, "run")).toEqual(["functionName"]);
      expect(classesOf(doc.lines, '"stopped"')).toEqual(["string"]);
      expect(classesOf(doc.lines, "Err")).toEqual(["callName"]);
      expect(classesOf(doc.lines, "return")).toEqual(["controlKeyword"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
