import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { tomlLanguage } from "../../../../../lib/view/languages/toml/language.ts";
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

const CATALOG = [
  "# Gradle version catalog",
  "[versions]",
  'agp = "8.7.0"',
  "",
  "[libraries]",
  'core = { group = "androidx.core", version.ref = "agp" }',
  "numbers = [1, 2.5, true, 1979-05-27T07:32:00Z]",
  "",
  "[[plugins.android]]",
  'id = "com.android.application"',
].join("\n");

describe("tomlLanguage", () => {
  beforeAll(() => tomlLanguage.prepare!());

  it("selects TOML files and Cargo lock files", () => {
    for (const path of ["gradle/libs.versions.toml", "Cargo.lock", "A.TOML"]) {
      expect(languageForFile(path).id).toBe("toml");
    }
    expect(languageForFile("uv.lock").id).not.toBe("toml");
  });

  it("colors tables, keys, and values", () => {
    const lines = tomlLanguage.highlightLines(CATALOG);

    expect(classesOf(lines, "# Gradle version catalog")).toEqual(["comment"]);
    expect(classesOf(lines, "versions")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "android")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "agp")).toEqual(["propertyName"]);
    expect(classesOf(lines, "ref")).toEqual(["propertyName"]);
    expect(classesOf(lines, '"8.7.0"')).toEqual(["string"]);
    expect(classesOf(lines, "2.5")).toEqual(["number"]);
    expect(classesOf(lines, "true")).toEqual(["boolean"]);
    expect(classesOf(lines, "1979-05-27T07:32:00Z")).toEqual(["number"]);
    expect(classesOf(lines, "[")).toEqual(["bracket"]);
    expect(verbatim(lines)).toBe(CATALOG);
  });

  it("lists tables and the keys they set, but not inline table keys", () => {
    const document = tomlLanguage.parseDocument(CATALOG);

    expect(
      document.flatStructure.map((node) => [node.kind, node.label, node.depth]),
    ).toEqual([
      ["object", "[versions]", 0],
      ["variable", "agp", 1],
      ["object", "[libraries]", 0],
      ["variable", "core", 1],
      ["variable", "numbers", 1],
      ["object", "[[plugins.android]]", 0],
      ["variable", "id", 1],
    ]);
    expect(document.definitions.get("plugins.android")!.map((d) => d.startLine))
      .toEqual([8]);
  });

  it("reconstructs malformed and incomplete input exactly", () => {
    for (const source of ['a = "open', "[table", "= 3", "", 'k = "☕ 😀"']) {
      expect(verbatim(tomlLanguage.parseDocument(source).lines)).toBe(source);
    }
  });
});
