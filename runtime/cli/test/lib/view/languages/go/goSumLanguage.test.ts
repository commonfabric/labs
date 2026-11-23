import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { goSumLanguage } from "../../../../../lib/view/languages/go/language.ts";
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

const SUMS = [
  "github.com/creack/pty v1.1.24 h1:bJrF4RRfyJnbTJqzRLHzcGaZK1NeM5kTC9jGgovnR1s=",
  "github.com/creack/pty v1.1.24/go.mod h1:08sCNb52WyoAwi2QDyzUCTgcvVFhUzewun7wtTfvcwE=",
  "github.com/cyphar/filepath-securejoin v0.2.2/go.mod h1:FpkQEhXnPnOthhzymB7CGsFk2G9VLXONKD9G7QGMM+4=",
  "",
].join("\n");

describe("goSumLanguage", () => {
  it("selects checksum files by their exact names", () => {
    expect(languageForFile("gmessages-client/go.sum").id).toBe("go-sum");
    expect(languageForFile("go.work.sum").id).toBe("go-sum");
    expect(languageForFile("GO.SUM").id).not.toBe("go-sum");
  });

  it("colors each line's module path, version, and hash", () => {
    const lines = goSumLanguage.highlightLines(SUMS);

    expect(classesOf(lines, "github.com/creack/pty")).toEqual(["identifier"]);
    expect(classesOf(lines, "v1.1.24")).toEqual(["number"]);
    expect(classesOf(lines, "/go.mod")).toEqual(["keyword"]);
    expect(
      classesOf(lines, "h1:bJrF4RRfyJnbTJqzRLHzcGaZK1NeM5kTC9jGgovnR1s="),
    ).toEqual(["string"]);
    expect(verbatim(lines)).toBe(SUMS);
  });

  it("leaves words after the hash plain", () => {
    const lines = goSumLanguage.highlightLines("a v1 h1:x= extra words");

    expect(classesOf(lines, "extra")).toEqual(["plain"]);
  });

  it("lists each module once, over the lines that name it", () => {
    const document = goSumLanguage.parseDocument(SUMS);

    expect(
      document.flatStructure.map((node) => [
        node.kind,
        node.label,
        node.startLine,
        node.endLine,
      ]),
    ).toEqual([
      ["variable", "github.com/creack/pty", 0, 1],
      ["variable", "github.com/cyphar/filepath-securejoin", 2, 2],
    ]);
    expect([...document.definitions.keys()]).toEqual([
      "github.com/creack/pty",
      "github.com/cyphar/filepath-securejoin",
    ]);
  });

  it("ends a module's range at its last word", () => {
    const source = "a v1 h1:x=  \r\na v2 h1:y=\r\n";
    const [module] = goSumLanguage.parseDocument(source).flatStructure;

    expect([module.startLine, module.endLine]).toEqual([0, 1]);
    expect(module.endCol).toBe("a v2 h1:y=".length);
  });

  it("reconstructs malformed input exactly", () => {
    for (
      const source of [
        "github.com/a/b",
        "  indented v1.0.0\t\th1:x=  ",
        "a v1 h1:x=\r\nb v2 h1:y=\r\n",
        "\ud800",
        "",
        "café v1 h1:☕😀",
      ]
    ) {
      expect(verbatim(goSumLanguage.parseDocument(source).lines)).toBe(
        source,
      );
    }
  });
});
