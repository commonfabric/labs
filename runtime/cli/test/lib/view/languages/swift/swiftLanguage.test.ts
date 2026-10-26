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
import { swiftLanguage } from "../../../../../lib/view/languages/swift/language.ts";
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
  return swiftLanguage.highlightLines(source);
}

describe("swiftLanguage", () => {
  beforeAll(() => swiftLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries Swift's representative filenames and
    // shebangs; these cases are the ones it does not.

    it("selects module interfaces and extensions in any case", () => {
      for (const path of ["Module.swiftinterface", "/tmp/UPPER.SWIFT"]) {
        expect(languageForFile(path).id).toBe("swift");
      }
    });

    it("leaves compiled modules and package resolutions to other languages", () => {
      expect(languageForFile("Module.swiftmodule").id).toBe("plain-text");
      expect(languageForFile("Package.resolved").id).toBe("json");
    });

    it("leaves other compilers and other launcher tools unclaimed", () => {
      for (
        const shebang of [
          "#!/usr/bin/env swiftc",
          "#!/usr/bin/xcrun clang",
          "#!/usr/bin/env xcrun",
        ]
      ) {
        expect(languageForSource("extract", `${shebang}\nprint(1)\n`).id)
          .not.toBe("swift");
      }
    });
  });

  describe("highlighting", () => {
    it("colors declarations, keywords, calls, and members", () => {
      const source = [
        "#!/usr/bin/swift",
        "import Foundation",
        "",
        "@MainActor",
        "final class Store: ObservableObject {",
        "  @Published private(set) var items: [String] = []",
        "  func load(from url: URL) async throws -> Data? {",
        "    guard let data = try? await fetch(url) else { return nil }",
        "    defer { items.removeAll() }",
        "    return data as? Data",
        "  }",
        "}",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "#!/usr/bin/swift")).toEqual(["comment"]);
      expect(classesOf(lines, "import")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "@")).toEqual(["operator"]);
      expect(classesOf(lines, "MainActor")).toEqual(["callName"]);
      expect(classesOf(lines, "Published")).toEqual(["callName"]);
      expect(classesOf(lines, "final")).toEqual(["keyword"]);
      expect(classesOf(lines, "class")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "Store")).toEqual(["interfaceName"]);
      expect(classesOf(lines, "ObservableObject")).toEqual(["typeName"]);
      expect(classesOf(lines, "private")).toEqual(["keyword"]);
      expect(classesOf(lines, "var")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "items")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "func")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "load")).toEqual(["functionName"]);
      expect(classesOf(lines, "from")).toEqual(["propertyName"]);
      expect(classesOf(lines, "url")).toEqual(["parameter", "identifier"]);
      expect(classesOf(lines, "async")).toEqual(["keyword"]);
      expect(classesOf(lines, "throws")).toEqual(["keyword"]);
      expect(classesOf(lines, "guard")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "data")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "try")).toEqual(["keyword"]);
      expect(classesOf(lines, "fetch")).toEqual(["callName"]);
      expect(classesOf(lines, "else")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "nil")).toEqual(["keyword"]);
      expect(classesOf(lines, "defer")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "removeAll")).toEqual(["callName"]);
      expect(classesOf(lines, "as?")).toEqual(["keyword"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors literals, comments, and compile-time conditions", () => {
      const source = [
        "/// Documents the value below.",
        "// An ordinary comment.",
        "//// A banner.",
        "/** A block doc comment. */",
        "let values = (0x1F, 0b101, 0o17, 1.5e3, true, nil)",
        "let pattern = /a+b/",
        "#if os(iOS) && canImport(UIKit)",
        "if #available(iOS 17, *) { print(#file, #selector(tap)) }",
        "#endif",
        "#Preview { ContentView() }",
        "switch value { case _: fallthrough; default: break }",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "/// Documents the value below."))
        .toEqual(["docComment"]);
      expect(classesOf(lines, "// An ordinary comment.")).toEqual(["comment"]);
      expect(classesOf(lines, "//// A banner.")).toEqual(["comment"]);
      expect(classesOf(lines, "/** A block doc comment. */"))
        .toEqual(["docComment"]);
      for (const number of ["0x1F", "0b101", "0o17", "1.5e3"]) {
        expect(classesOf(lines, number)).toEqual(["number"]);
      }
      expect(classesOf(lines, "true")).toEqual(["boolean"]);
      expect(classesOf(lines, "/a+b/")).toEqual(["regex"]);
      expect(classesOf(lines, "#if")).toEqual(["keyword"]);
      expect(classesOf(lines, "os")).toEqual(["callName"]);
      expect(classesOf(lines, "canImport")).toEqual(["callName"]);
      expect(classesOf(lines, "available")).toEqual(["callName"]);
      expect(classesOf(lines, "file")).toEqual(["keyword"]);
      expect(classesOf(lines, "selector")).toEqual(["callName"]);
      expect(classesOf(lines, "#endif")).toEqual(["keyword"]);
      expect(classOnLine(lines, "#Preview { ContentView() }", "#"))
        .toBe("operator");
      expect(classesOf(lines, "Preview")).toEqual(["callName"]);
      expect(classesOf(lines, "case")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "_")).toEqual(["keyword"]);
      expect(classesOf(lines, "fallthrough")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "default")).toEqual(["controlKeyword"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors interpolated fields as code inside every string form", () => {
      const source = [
        'let line = "count: \\(items.count)\\n"',
        'let raw = #"raw \\n \\#(value)"#',
        'let multi = """',
        "  total \\(1 + 2)",
        '  """',
      ].join("\n");
      const lines = highlight(source);

      expect(classOnLine(lines, source.split("\n")[0], '"count: '))
        .toBe("string");
      expect(classesOf(lines, "\\(")).toEqual(["punctuation"]);
      expect(classesOf(lines, "count")).toEqual(["propertyName"]);
      expect(classesOf(lines, '\\n"')).toEqual(["string"]);
      expect(classesOf(lines, "value")).toEqual(["identifier"]);
      expect(classesOf(lines, "1")).toEqual(["number"]);
      expect(classesOf(lines, '"""')).toEqual(["string"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("keeps escapes, extended regexes, pattern cases, and labels in their own classes", () => {
      const source = [
        'let letter = "\\u{41}"',
        "let digits = #/\\d+/#",
        "enum Shape { case circle }",
        "if case .circle = shape {}",
        "outer: for item in items { break outer }",
        "indirect enum Tree {}",
        "infix operator <*>",
        "let every = each",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, '"\\u{41}"')).toEqual(["string"]);
      expect(classesOf(lines, "#/\\d+/#")).toEqual(["regex"]);
      expect(classOnLine(lines, "enum Shape { case circle }", "case"))
        .toBe("storageKeyword");
      expect(classOnLine(lines, "if case .circle = shape {}", "case"))
        .toBe("controlKeyword");
      expect(classesOf(lines, "outer:")).toEqual(["propertyName"]);
      expect(classesOf(lines, "indirect")).toEqual(["keyword"]);
      expect(classesOf(lines, "infix")).toEqual(["keyword"]);
      expect(classesOf(lines, "each")).toEqual(["identifier"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("keeps generic angle brackets and interpolation delimiters out of bracket depth", () => {
      const source = 'let map: Dictionary<String, [Int]> = ["\\(a)": [1]]';
      const [line] = highlight(source);
      const brackets = line.spans.filter((span) => span.cls === "bracket");

      expect(classesOf([line], "<")).toEqual(["punctuation"]);
      expect(classesOf([line], ">")).toEqual(["punctuation"]);
      expect(brackets.map((span) => [span.text, span.bracketDepth])).toEqual([
        ["[", 0],
        ["]", 0],
        ["[", 0],
        ["[", 1],
        ["]", 1],
        ["]", 0],
      ]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'let s = "unterminated\nlet after = 1',
          'let s = """\nnever closed',
          'let s = "\\(unclosed',
          "func broken(",
          "struct Half {\n  func inner(",
          "0x 1e+ @@@ #",
          "\ud800",
          "",
          " \t",
          'let café = "☕ 😀"',
        ]
      ) {
        const document = swiftLanguage.parseDocument(source);
        expect(verbatim(document.lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    const source = [
      "import Foundation",
      "",
      'let package = Package(name: "demo")',
      "",
      "protocol Loader {",
      "  var name: String { get }",
      "  func load() throws -> Data",
      "}",
      "",
      "struct Store: Loader {",
      '  let (name, alias) = ("store", "s")',
      "  init() {}",
      "  func load() throws -> Data {",
      "    let local = Data()",
      "    func helper() {}",
      "    return local",
      "  }",
      "  subscript(index: Int) -> Int { index }",
      "}",
      "",
      "extension Store {",
      "  static func == (lhs: Store, rhs: Store) -> Bool { true }",
      "}",
      "",
      "enum Kind { case a }",
      "actor Counter { deinit {} }",
      "typealias Handler = (Int) -> Void",
      "",
      "func main() {}",
    ].join("\n");

    it("lists types, members, and file-level declarations", () => {
      const document = swiftLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
          node.endLine,
        ]),
      ).toEqual([
        ["variable", "let package", 0, 2, 2],
        ["interface", "protocol Loader", 0, 4, 7],
        ["variable", "var name", 1, 5, 5],
        ["method", "func load", 1, 6, 6],
        ["class", "struct Store", 0, 9, 18],
        ["variable", "let name", 1, 10, 10],
        ["method", "init", 1, 11, 11],
        ["method", "func load", 1, 12, 16],
        ["function", "func helper", 2, 14, 14],
        ["method", "subscript", 1, 17, 17],
        ["class", "extension Store", 0, 20, 22],
        ["method", "func ==", 1, 21, 21],
        ["class", "enum Kind", 0, 24, 24],
        ["class", "actor Counter", 0, 25, 25],
        ["method", "deinit", 1, 25, 25],
        ["typeAlias", "typealias Handler", 0, 26, 26],
        ["function", "func main", 0, 28, 28],
      ]);
    });

    it("indexes declared names for definition peeks", () => {
      const document = swiftLanguage.parseDocument(source);
      const store = document.structure.find((node) =>
        node.label === "struct Store"
      )!;

      expect([...document.definitions.keys()]).toEqual([
        "package",
        "Loader",
        "name",
        "load",
        "Store",
        "helper",
        "==",
        "Kind",
        "Counter",
        "Handler",
        "main",
      ]);
      expect(document.definitions.get("Store")!.map((d) => d.startLine))
        .toEqual([9, 20]);
      expect(source.slice(store.nameOffset!, store.nameOffset! + 5))
        .toBe("Store");
      expect(store.astKinds).toEqual(["class_declaration"]);
    });

    it("indexes an extension of a dotted or generic path under the type's own name", () => {
      const document = swiftLanguage.parseDocument(
        "extension Outer.Inner<Int> {}",
      );

      expect(document.structure.map((node) => node.label)).toEqual([
        "extension Outer.Inner<Int>",
      ]);
      expect([...document.definitions.keys()]).toEqual(["Inner"]);
    });

    it("lists no entry for a declaration whose name is not typed yet", () => {
      const document = swiftLanguage.parseDocument(
        ["struct {", "func () {}", "let = 3", "func named() {}"].join("\n"),
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "func named",
      ]);
      expect([...document.definitions.keys()]).toEqual(["named"]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "// café ☕ and an astral 😀",
        "import Foundation",
        "",
        "struct Store {",
        "  var items: [String] = []",
        "  mutating func add(_ item: String) {",
        "    items.append(item)",
        "  }",
        '  var summary: String { "\\(items.count) items" }',
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ["items.append(item)", "items.append(item.lowercased())"],
        ["func add(", "func adding("],
        ["import Foundation", "import Foundation\nimport OSLog"],
        ['"\\(items.count) items"', '"\\(items.count'],
        ["  var items: [String] = []", "  var items: [String"],
        ["// café ☕ and an astral 😀", "/* café ☕ and an astral 😀"],
      ];
      const highlighter = swiftLanguage.createHighlighter(source);
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
        "diff --git a/Sources/Banner.swift b/Sources/Banner.swift",
        "--- a/Sources/Banner.swift",
        "+++ b/Sources/Banner.swift",
        "@@ -1,3 +1,3 @@",
        ' let banner = """',
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
