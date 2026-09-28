import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { kotlinLanguage } from "../../../../../lib/view/languages/kotlin/language.ts";
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

/** The class of a fragment on the first line with exactly this text. */
function classOnLine(
  lines: readonly Line[],
  lineText: string,
  token: string,
): TokenClass | undefined {
  return lines.find((line) => line.text === lineText)?.spans.find((span) =>
    span.text === token
  )?.cls;
}

function highlight(source: string): Line[] {
  return kotlinLanguage.highlightLines(source);
}

describe("kotlinLanguage", () => {
  beforeAll(() => kotlinLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries Kotlin's representative filenames and
    // shebang; these cases are the ones it does not.

    it("selects Kotlin and Kotlin scripts in any case", () => {
      for (const path of ["/tmp/UPPER.KT", "init.gradle.kts", "Main.KTS"]) {
        expect(languageForFile(path).id).toBe("kotlin");
      }
    });

    it("leaves compiled classes, archives, and other compilers to other languages", () => {
      expect(languageForFile("MainActivity.class").id).not.toBe("kotlin");
      expect(languageForFile("gradle-wrapper.jar").id).not.toBe("kotlin");
      expect(
        languageForSource("run", "#!/usr/bin/env kotlinc\nprintln(1)\n").id,
      )
        .not.toBe("kotlin");
    });
  });

  describe("highlighting", () => {
    it("colors declarations, keywords, calls, and members", () => {
      const source = [
        "#!/usr/bin/env kotlin",
        "package com.example.app",
        "",
        "import kotlinx.coroutines.flow.*",
        "",
        '@Suppress("unused")',
        "internal data class Store<T : Any>(val name: String) : Base(), Loader {",
        "    override suspend fun load(url: String): T? = fetch<T>(url)?.let { it }",
        "    private var count: Int = 0",
        "        private set",
        "    init { require(name.isNotEmpty()) }",
        "}",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "#!/usr/bin/env kotlin")).toEqual(["comment"]);
      expect(classesOf(lines, "package")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "import")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "example")).toEqual(["identifier"]);
      expect(classesOf(lines, "@")).toEqual(["operator"]);
      expect(classesOf(lines, "Suppress")).toEqual(["callName"]);
      expect(classesOf(lines, "internal")).toEqual(["keyword"]);
      expect(classesOf(lines, "data")).toEqual(["keyword"]);
      expect(classesOf(lines, "class")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "Store")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "T")).toEqual(["typeName"]);
      expect(classesOf(lines, "name")).toEqual(["parameter", "identifier"]);
      expect(classesOf(lines, "Base")).toEqual(["callName"]);
      expect(classesOf(lines, "Loader")).toEqual(["typeName"]);
      expect(classesOf(lines, "override")).toEqual(["keyword"]);
      expect(classesOf(lines, "suspend")).toEqual(["keyword"]);
      expect(classesOf(lines, "fun")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "load")).toEqual(["functionName"]);
      expect(classesOf(lines, "url")).toEqual(["parameter", "identifier"]);
      expect(classesOf(lines, "fetch")).toEqual(["callName"]);
      expect(classesOf(lines, "?.")).toEqual(["punctuation"]);
      expect(classesOf(lines, "let")).toEqual(["callName"]);
      expect(classesOf(lines, "var")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "count")).toEqual(["binding"]);
      expect(classesOf(lines, "set")).toEqual(["keyword"]);
      expect(classesOf(lines, "init")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "isNotEmpty")).toEqual(["callName"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors literals, comments, and the names the grammar reads as bare words", () => {
      const source = [
        "/** A doc comment. */",
        "/* A block comment. */",
        "// A line comment.",
        "val values = listOf(0x1F, 1L, 2u, 1.5f, 'c', true, null)",
        "val kind = String::class",
        "val ref = ::load",
        "loop@ for (x in xs) { if (x !is Int) break@loop else continue }",
        "val fn: suspend () -> Unit = {}",
        "val label = run inner@{ return@inner 1 }",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "/** A doc comment. */")).toEqual(["docComment"]);
      expect(classesOf(lines, "/* A block comment. */")).toEqual(["comment"]);
      expect(classesOf(lines, "// A line comment.")).toEqual(["comment"]);
      for (const number of ["0x1F", "1L", "2u", "1.5f"]) {
        expect(classesOf(lines, number)).toEqual(["number"]);
      }
      expect(classesOf(lines, "'c'")).toEqual(["string"]);
      expect(classesOf(lines, "true")).toEqual(["keyword"]);
      expect(classesOf(lines, "null")).toEqual(["keyword"]);
      expect(classOnLine(lines, "val kind = String::class", "class"))
        .toBe("keyword");
      expect(classOnLine(lines, "val ref = ::load", "load"))
        .toBe("propertyName");
      expect(classesOf(lines, "loop@")).toEqual(["propertyName"]);
      expect(classesOf(lines, "for")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "!is")).toEqual(["keyword"]);
      expect(classesOf(lines, "break@")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "continue")).toEqual(["keyword"]);
      expect(classesOf(lines, "inner@")).toEqual(["propertyName"]);
      expect(classesOf(lines, "return@")).toEqual(["controlKeyword"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors interpolated fields as code inside every string form", () => {
      const source = [
        'val line = "count: ${items.size}\\n"',
        'val raw = """total $total ${1 + 2}"""',
      ].join("\n");
      const lines = highlight(source);

      expect(classOnLine(lines, source.split("\n")[0], '"count: '))
        .toBe("string");
      expect(classesOf(lines, "${")).toEqual(["punctuation"]);
      expect(classesOf(lines, "$")).toEqual(["punctuation"]);
      expect(classesOf(lines, "size")).toEqual(["propertyName"]);
      expect(classesOf(lines, '\\n"')).toEqual(["string"]);
      expect(classesOf(lines, "total")).toEqual(["identifier"]);
      expect(classesOf(lines, "1")).toEqual(["number"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("keeps generic angle brackets out of bracket depth", () => {
      const source = "val map: Map<String, List<Int>> = mapOf(1 to listOf(2))";
      const [line] = highlight(source);
      const brackets = line.spans.filter((span) => span.cls === "bracket");

      expect(classesOf([line], "<")).toEqual(["punctuation"]);
      expect(classesOf([line], ">>")).toEqual(["punctuation"]);
      expect(classesOf([line], "Map")).toEqual(["typeName"]);
      expect(brackets.map((span) => [span.text, span.bracketDepth])).toEqual([
        ["(", 0],
        ["(", 1],
        [")", 1],
        [")", 0],
      ]);
    });

    it("parses a catch clause that starts on the line after another catch block", () => {
      const source = [
        "suspend fun read(): Int {",
        "    return try { load() }",
        "    catch (cancel: CancellationException) { throw cancel }",
        "    catch (_: Exception) { 0 }",
        "}",
      ].join("\n");
      const document = kotlinLanguage.parseDocument(source);

      expect(classesOf(document.lines, "catch")).toEqual(["controlKeyword"]);
      expect(classesOf(document.lines, "read")).toEqual(["functionName"]);
      expect(classesOf(document.lines, "Exception")).toEqual(["typeName"]);
      expect(document.structure.map((node) => node.label)).toEqual([
        "fun read",
      ]);
      expect(verbatim(document.lines)).toBe(source);
    });

    it("parses a finally clause that starts on the line after a catch block", () => {
      const source = [
        "fun close() {",
        "    try {",
        "        release()",
        "    } catch (e: IOException) {",
        "        log(e)",
        "    }",
        "    finally {",
        "        done()",
        "    }",
        "}",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "finally")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "done")).toEqual(["callName"]);
    });

    it("parses a second catch clause after a block holding a URL string", () => {
      const source = [
        "fun fetch() {",
        "    try { load() }",
        '    catch (e: IOException) { val url = "https://example.com" }',
        "    catch (e: Exception) { fail(e) }",
        "}",
      ].join("\n");
      const document = kotlinLanguage.parseDocument(source);

      expect(classesOf(document.lines, "catch")).toEqual(["controlKeyword"]);
      expect(classesOf(document.lines, "fail")).toEqual(["callName"]);
    });

    it("keeps a catch clause out of a line comment that ends in a brace", () => {
      const source = [
        "fun read() {",
        "    try { load() } // {}",
        "    catch (e: Exception) { fail(e) }",
        "}",
        "fun after() = 1",
      ].join("\n");
      const document = kotlinLanguage.parseDocument(source);

      expect(classesOf(document.lines, "// {}")).toEqual(["comment"]);
      expect(classesOf(document.lines, "catch")).toEqual(["controlKeyword"]);
      expect(document.structure.map((node) => node.label)).toEqual([
        "fun read",
        "fun after",
      ]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'val s = "unterminated\nval after = 1',
          'val s = """\nnever closed',
          'val s = "${unclosed',
          "fun broken(",
          "class Half {\n  fun inner(",
          "try {}\r\ncatch (a: A) {}\r\ncatch (b: B) {}",
          "0x 1e+ @@@ $",
          "\ud800",
          "",
          " \t",
          'val café = "☕ 😀"',
        ]
      ) {
        const document = kotlinLanguage.parseDocument(source);
        expect(verbatim(document.lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    const source = [
      "package com.example",
      "",
      'val greeting = "hello"',
      "",
      "interface Loader {",
      "    val name: String",
      "    fun load(): Data",
      "}",
      "",
      "data class Store(val id: Int, label: String) : Loader {",
      '    override val (name, alias) = "store" to "s"',
      "    init {}",
      '    constructor() : this(0, "")',
      "    override fun load(): Data {",
      "        val local = Data()",
      "        fun helper() {}",
      "        return local",
      "    }",
      "    companion object { const val MAX = 3 }",
      "}",
      "",
      "enum class Kind { A, B }",
      "object Registry",
      "sealed interface Event",
      "typealias Handler = (Int) -> Unit",
      "fun Store.describe(): String = label",
    ].join("\n");

    it("lists types, members, and file-level declarations", () => {
      const document = kotlinLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
          node.endLine,
        ]),
      ).toEqual([
        ["variable", "val greeting", 0, 2, 2],
        ["interface", "interface Loader", 0, 4, 7],
        ["variable", "val name", 1, 5, 5],
        ["method", "fun load", 1, 6, 6],
        ["class", "data class Store", 0, 9, 19],
        ["variable", "val id", 1, 9, 9],
        ["variable", "val name", 1, 10, 10],
        ["method", "init", 1, 11, 11],
        ["method", "constructor", 1, 12, 12],
        ["method", "fun load", 1, 13, 17],
        ["function", "fun helper", 2, 15, 15],
        ["class", "companion object", 1, 18, 18],
        ["variable", "val MAX", 2, 18, 18],
        ["class", "enum class Kind", 0, 21, 21],
        ["class", "object Registry", 0, 22, 22],
        ["interface", "sealed interface Event", 0, 23, 23],
        ["typeAlias", "typealias Handler", 0, 24, 24],
        ["function", "fun describe", 0, 25, 25],
      ]);
    });

    it("indexes declared names for definition peeks", () => {
      const document = kotlinLanguage.parseDocument(source);
      const store = document.structure.find((node) =>
        node.label === "data class Store"
      )!;

      expect([...document.definitions.keys()]).toEqual([
        "greeting",
        "Loader",
        "name",
        "load",
        "Store",
        "id",
        "helper",
        "MAX",
        "Kind",
        "Registry",
        "Event",
        "Handler",
        "describe",
      ]);
      expect(document.definitions.get("name")!.map((d) => d.startLine))
        .toEqual([5, 10]);
      expect(source.slice(store.nameOffset!, store.nameOffset! + 5))
        .toBe("Store");
      expect(store.astKinds).toEqual(["class_declaration"]);
    });

    it("indexes a named companion object under its name", () => {
      const document = kotlinLanguage.parseDocument(
        "class Outer { companion object Factory {} }",
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "class Outer",
        "companion object Factory",
      ]);
      expect([...document.definitions.keys()]).toEqual(["Outer", "Factory"]);
    });

    it("lists no entry for a declaration whose name is not typed yet", () => {
      const document = kotlinLanguage.parseDocument(
        ["fun named() {}", "interface"].join("\n"),
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "fun named",
      ]);
      expect([...document.definitions.keys()]).toEqual(["named"]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "// café ☕ and an astral 😀",
        "import kotlinx.coroutines.CancellationException",
        "",
        "class Store {",
        "    private val items = mutableListOf<String>()",
        "    fun add(item: String) {",
        "        try { items.add(item) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {}",
        "    }",
        '    val summary: String get() = "${items.size} items"',
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ["items.add(item)", "items.add(item.lowercase())"],
        ["fun add(", "fun adding("],
        ["{ throw cancel } catch", "{ throw cancel }\n        catch"],
        ["} catch (cancel", "}\r\n        catch (cancel"],
        [
          "{ throw cancel }\n        catch",
          "{ throw cancel } // kept\n        catch",
        ],
        ['"${items.size} items"', '"${items.size'],
        ["// café ☕ and an astral 😀", "/* café ☕ and an astral 😀"],
      ];
      const highlighter = kotlinLanguage.createHighlighter(source);
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

    it("colors a diff of an unavailable file from its multiline string context", () => {
      const diff = [
        "diff --git a/src/Banner.kt b/src/Banner.kt",
        "--- a/src/Banner.kt",
        "+++ b/src/Banner.kt",
        "@@ -1,3 +1,3 @@",
        ' val banner = """',
        "-old text",
        "+new text",
        ' """',
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, "old text")).toEqual(["string"]);
      expect(classesOf(doc.lines, "new text")).toEqual(["string"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
