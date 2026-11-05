import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { propertiesLanguage } from "../../../../../lib/view/languages/properties/language.ts";
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

const SOURCE = [
  "# Gradle settings \\",
  "! An older comment form",
  "org.gradle.jvmargs=-Xmx4096m \\",
  "    -Dfile.encoding=UTF-8",
  "distributionUrl = https\\://services.gradle.org",
  "  kotlin.code.style: official",
  "escaped\\ key\\=part value",
  "",
  "flag",
].join("\n");

describe("propertiesLanguage", () => {
  it("selects properties files", () => {
    expect(languageForFile("android/gradle.properties").id).toBe("properties");
    expect(languageForFile("Strings.PROPERTIES").id).toBe("properties");
  });

  it("colors comments, keys, separators, values, and continuations", () => {
    const lines = propertiesLanguage.highlightLines(SOURCE);

    expect(classesOf(lines, "# Gradle settings \\")).toEqual(["comment"]);
    expect(classesOf(lines, "! An older comment form")).toEqual(["comment"]);
    expect(classesOf(lines, "org.gradle.jvmargs")).toEqual(["propertyName"]);
    expect(classesOf(lines, "=")).toEqual(["operator"]);
    expect(classesOf(lines, ":")).toEqual(["operator"]);
    expect(classesOf(lines, "-Xmx4096m ")).toEqual(["string"]);
    expect(classesOf(lines, "\\")).toEqual(["punctuation"]);
    expect(classesOf(lines, "    ")).toEqual(["whitespace"]);
    expect(classesOf(lines, "-Dfile.encoding=UTF-8")).toEqual(["string"]);
    expect(classesOf(lines, "https\\://services.gradle.org")).toEqual([
      "string",
    ]);
    expect(classesOf(lines, "escaped\\")).toEqual(["propertyName"]);
    expect(classesOf(lines, "key\\=part")).toEqual(["propertyName"]);
    expect(classesOf(lines, "value")).toEqual(["string"]);
    expect(classesOf(lines, "flag")).toEqual(["propertyName"]);
    expect(verbatim(lines)).toBe(SOURCE);
  });

  it("lists each key the file sets over the lines that set it", () => {
    const document = propertiesLanguage.parseDocument(SOURCE);

    expect(
      document.flatStructure.map((node) => [
        node.label,
        node.startLine,
        node.endLine,
      ]),
    ).toEqual([
      ["org.gradle.jvmargs", 2, 3],
      ["distributionUrl", 4, 4],
      ["kotlin.code.style", 5, 5],
      ["escaped\\ key\\=part", 6, 6],
      ["flag", 8, 8],
    ]);
    expect(document.definitions.get("kotlin.code.style")![0].startOffset)
      .toBe(SOURCE.indexOf("kotlin.code.style"));
  });

  it("names a key continued onto the next line without the continuation", () => {
    const document = propertiesLanguage.parseDocument("ke\\\n   y = v");

    expect(document.flatStructure.map((node) => node.label)).toEqual(["key"]);
    expect([...document.definitions.keys()]).toEqual(["key"]);
  });

  it("continues a logical line across Windows line endings", () => {
    const source = "key=a \\\r\n  b\r\nnext=c";
    const document = propertiesLanguage.parseDocument(source);

    expect(document.flatStructure.map((node) => node.label)).toEqual([
      "key",
      "next",
    ]);
    expect(verbatim(document.lines)).toBe(source);
  });

  it("ends lines only where the pager does, at a line feed", () => {
    const document = propertiesLanguage.parseDocument("a=1\rb=2\nc=3");

    expect(
      document.flatStructure.map((node) => [node.label, node.startLine]),
    ).toEqual([["a", 0], ["c", 1]]);
  });

  it("reconstructs incomplete input exactly", () => {
    for (const source of ["key=\\", "=value", "a\\", "\\", "", "k=☕ 😀"]) {
      expect(verbatim(propertiesLanguage.parseDocument(source).lines))
        .toBe(source);
    }
  });

  it("recolors each edit", () => {
    const highlighter = propertiesLanguage.createHighlighter("a=1");
    expect(highlighter.update("a=1")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("b=1"), "b")).toEqual(["propertyName"]);
  });
});
