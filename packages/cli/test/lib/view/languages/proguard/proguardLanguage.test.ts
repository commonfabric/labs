import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { proguardLanguage } from "../../../../../lib/view/languages/proguard/language.ts";
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

describe("proguardLanguage", () => {
  describe("selection", () => {
    it("selects the rules files an Android module creates by name", () => {
      for (const path of ["app/proguard-rules.pro", "lib/consumer-rules.pro"]) {
        expect(languageForFile(path).id).toBe("proguard");
      }
    });

    it("claims another .pro file only when a line starts with an option", () => {
      expect(languageForSource("keep.pro", "# rules\n-dontwarn a.**\n").id)
        .toBe("proguard");
      expect(languageForSource("app.pro", "QT += core\nTARGET = app\n").id)
        .toBe("plain-text");
      const qtFlags =
        "QMAKE_CXXFLAGS += \\\n    -include forced.h \\\n    -target arm64 \\\n" +
        "    -dumpversion\nLIBS += \\\n    -L/usr/lib \\\n    -lfoo -framework Cocoa\n";
      expect(languageForSource("app.pro", qtFlags).id).toBe("plain-text");
      expect(languageForSource("rules.pl.pro", "p(X) :-\n    -X > 1.\n").id)
        .toBe("plain-text");
      expect(languageForFile("keep.pro").id).toBe("plain-text");
    });
  });

  it("colors options, class specifications, and members", () => {
    const source = [
      "# Keep the JNI entry points.",
      "-keep class com.example.** { *; }",
      "-keepclassmembers,allowobfuscation class * extends android.app.Activity {",
      "    public void *(android.view.View);",
      "    <init>(...);",
      "    native <methods>;",
      "    int[] counts;",
      "    java.lang.String name;",
      "}",
      "-keep @androidx.annotation.Keep class *",
      "-dontwarn kotlinx.**, !com.example.internal.**",
      "-injars 'build/libs/app-lib.jar'",
      "-assumenosideeffects class android.util.Log { *** d(...); }",
    ].join("\n");
    const lines = proguardLanguage.highlightLines(source);

    expect(classesOf(lines, "# Keep the JNI entry points.")).toEqual([
      "comment",
    ]);
    for (
      const keyword of [
        "-keep",
        "-keepclassmembers",
        "allowobfuscation",
        "class",
        "extends",
        "public",
        "<init>",
        "native",
        "<methods>",
        "-dontwarn",
        "-injars",
      ]
    ) {
      expect(classesOf(lines, keyword)).toEqual(["keyword"]);
    }
    expect(classesOf(lines, "com.example.**")).toEqual(["typeName"]);
    expect(classesOf(lines, "android.app.Activity")).toEqual(["typeName"]);
    expect(classesOf(lines, "androidx.annotation.Keep")).toEqual(["typeName"]);
    for (const wildcard of ["*", "***", "...", "!", "@"]) {
      expect(classesOf(lines, wildcard)).toEqual(["operator"]);
    }
    expect(classesOf(lines, "void")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "int[]")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "counts")).toEqual(["identifier"]);
    expect(classesOf(lines, "d")).toEqual(["callName"]);
    expect(classesOf(lines, "'build/libs/app-lib.jar'")).toEqual(["string"]);
    expect(classesOf(lines, "{")).toEqual(["bracket"]);
    expect(classesOf(lines, ";")).toEqual(["punctuation"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("builds a document with no structure and recolors each edit", () => {
    const document = proguardLanguage.parseDocument("-keep class A");
    expect(document.structure).toEqual([]);
    expect(document.definitions.size).toBe(0);

    const highlighter = proguardLanguage.createHighlighter("-keep class A");
    expect(highlighter.update("-keep class A")).toBe(highlighter.lines);
    const updated = highlighter.update("-dontwarn A");
    expect(classesOf(updated, "-dontwarn")).toEqual(["keyword"]);
    expect(highlighter.lines).toBe(updated);
  });

  it("reconstructs incomplete input exactly", () => {
    for (const source of ["-keep class A {", "'unclosed", "-", "", "# ☕ 😀"]) {
      expect(verbatim(proguardLanguage.highlightLines(source))).toBe(source);
    }
  });
});
