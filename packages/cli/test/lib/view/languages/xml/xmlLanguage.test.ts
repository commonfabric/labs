import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { xmlLanguage } from "../../../../../lib/view/languages/xml/language.ts";
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

/** The labels and depths of a document's elements, in order. */
function outline(source: string): [string, number, number, number][] {
  return xmlLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

describe("xmlLanguage", () => {
  it("selects XML and the formats built on it", () => {
    for (
      const path of [
        "app/src/main/AndroidManifest.xml",
        "logo.svg",
        "Info.plist",
        "App.entitlements",
        "PrivacyInfo.xcprivacy",
        "contents.xcworkspacedata",
      ]
    ) {
      expect(languageForFile(path).id).toBe("xml");
    }
  });

  it("colors tags, attributes, and the markup around them", () => {
    const source = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<!DOCTYPE note [ <!ENTITY brand "Fabric"> %shared; ]>',
      "<!-- A comment",
      "     over two lines -->",
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <string name="title">Tom &amp; Jerry &#169;</string>',
      "    <activity android:name=\".Main\" android:label='Main &lt;' />",
      "    <![CDATA[ <raw> & ]]>",
      "</manifest>",
    ].join("\n");
    const lines = xmlLanguage.highlightLines(source);

    expect(classesOf(lines, "<?")).toEqual(["punctuation"]);
    expect(classesOf(lines, "xml")).toEqual(["keyword"]);
    expect(classesOf(lines, "version")).toEqual(["propertyName"]);
    expect(classesOf(lines, '"1.0"')).toEqual(["string"]);
    expect(classesOf(lines, "?>")).toEqual(["punctuation"]);
    expect(classesOf(lines, "DOCTYPE")).toEqual(["keyword"]);
    expect(classesOf(lines, "note")).toEqual(["identifier"]);
    expect(classesOf(lines, "ENTITY")).toEqual(["keyword"]);
    expect(classesOf(lines, '"Fabric"')).toEqual(["string"]);
    expect(classesOf(lines, "%shared;")).toEqual(["keyword"]);
    expect(classesOf(lines, "[")).toEqual(["bracket"]);
    expect(classesOf(lines, "<!-- A comment")).toEqual(["comment"]);
    expect(classesOf(lines, "     over two lines -->")).toEqual(["comment"]);
    expect(classesOf(lines, "manifest")).toEqual(["typeName"]);
    expect(classesOf(lines, "xmlns:android")).toEqual(["propertyName"]);
    expect(classesOf(lines, "=")).toEqual(["operator"]);
    expect(classesOf(lines, "Tom")).toEqual(["plain"]);
    expect(classesOf(lines, "&amp;")).toEqual(["keyword"]);
    expect(classesOf(lines, "&#169;")).toEqual(["keyword"]);
    expect(classesOf(lines, "&lt;")).toEqual(["keyword"]);
    expect(classesOf(lines, "</")).toEqual(["punctuation"]);
    expect(classesOf(lines, "/>")).toEqual(["punctuation"]);
    expect(classesOf(lines, "<![CDATA[")).toEqual(["punctuation"]);
    expect(classesOf(lines, " <raw> & ")).toEqual(["string"]);
    expect(classesOf(lines, "]]>")).toEqual(["punctuation"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("runs a processing instruction to its end, whatever its data holds", () => {
    const source =
      '<?php if ($a > 1) echo "<b>"; ?>\n<?xml-stylesheet href="s.css" ?>\n<a/>';
    const lines = xmlLanguage.highlightLines(source);

    expect(classesOf(lines, "php")).toEqual(["keyword"]);
    expect(classesOf(lines, "b")).toEqual([]);
    expect(classesOf(lines, "xml-stylesheet")).toEqual(["keyword"]);
    expect(classesOf(lines, "href")).toEqual(["propertyName"]);
    expect(classesOf(lines, '"s.css"')).toEqual(["string"]);
    expect(outline(source)).toEqual([["a", 0, 2, 2]]);
    expect(verbatim(lines)).toBe(source);
  });

  it("ends an unclosed tag or value where the next tag begins", () => {
    const source = "<a href=\"open\n<b name='x'>text</b>";
    const lines = xmlLanguage.highlightLines(source);

    expect(classesOf(lines, '"open')).toEqual(["string"]);
    expect(classesOf(lines, "b")).toEqual(["typeName"]);
    expect(classesOf(lines, "text")).toEqual(["plain"]);
    expect(outline(source)).toEqual([["a", 0, 0, 1], ["b x", 1, 1, 1]]);
  });

  it("outlines elements under their name or id", () => {
    const source = [
      "<resources>",
      '  <style name="Theme.Weaver" parent="Base">',
      '    <item name="android:windowBackground">@null</item>',
      "  </style>",
      '  <Button android:id="@+id/go"/>',
      "</resources>",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["resources", 0, 0, 5],
      ["style Theme.Weaver", 1, 1, 3],
      ["item android:windowBackground", 2, 2, 2],
      ["Button @+id/go", 1, 4, 4],
    ]);
    const [root] = xmlLanguage.parseDocument(source).structure;
    expect([root.startCol, root.endCol, root.astKinds]).toEqual([
      0,
      12,
      ["element"],
    ]);
  });

  it("closes the elements inside one whose end tag skips theirs", () => {
    expect(outline("<a>\n<b>\n<c>\n</a>\n</z>\n<d>")).toEqual([
      ["a", 0, 0, 3],
      ["b", 1, 1, 3],
      ["c", 2, 2, 3],
      ["d", 0, 5, 5],
    ]);
  });

  it("reconstructs malformed and incomplete input exactly", () => {
    for (
      const source of [
        "<",
        "< a",
        "<a",
        "<a b",
        '<a b="',
        "<!--",
        "<![CDATA[",
        "<?xml",
        "<!DOCTYPE",
        "<!DOCTYPE x [ ] ] &broken <a>",
        "<!DOCTYPE x = y>",
        "</",
        "a & b; &",
        "<a ? / =>",
        "",
        "<a>☕ 😀</a>",
      ]
    ) {
      expect(verbatim(xmlLanguage.parseDocument(source).lines)).toBe(source);
    }
  });

  it("recolors each edit", () => {
    const highlighter = xmlLanguage.createHighlighter("<a/>");
    expect(highlighter.update("<a/>")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("<b/>"), "b")).toEqual(["typeName"]);
  });
});
