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
import { rustLanguage } from "../../../../../lib/view/languages/rust/language.ts";
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
  return rustLanguage.highlightLines(source);
}

describe("rustLanguage", () => {
  beforeAll(() => rustLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries Rust's representative filenames and
    // aliases; these cases are the ones it does not.

    it("selects source files in any case", () => {
      expect(languageForFile("/tmp/MAIN.RS").id).toBe("rust");
    });

    it("leaves Cargo manifests, lock files, and other suffixes to other languages", () => {
      expect(languageForFile("Cargo.toml").id).toBe("toml");
      expect(languageForFile("Cargo.lock").id).toBe("toml");
      expect(languageForFile("build.rs.in").id).not.toBe("rust");
      expect(languageForFile("notes.rst").id).not.toBe("rust");
    });

    it("selects nothing from source without a name", () => {
      expect(languageForSource("extract", "fn main() {}\n").id)
        .not.toBe("rust");
    });
  });

  describe("highlighting", () => {
    it("colors declarations, keywords, calls, and members", () => {
      const source = [
        "use std::{fmt, io::Write as _};",
        "",
        "#[derive(Debug)]",
        "pub struct Point<'a, T: Clone> { pub x: i32, label: &'a T }",
        "impl<T> fmt::Display for Point<'_, T> where T: Clone {",
        "    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {",
        "        let Self { x, .. } = self;",
        "        let mut total = Vec::<u8>::new();",
        "        for item in self.parts.iter() { total.push(*item); }",
        '        write!(f, "{x}")',
        "    }",
        "}",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "use")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "as")).toEqual(["keyword"]);
      expect(classesOf(lines, "#")).toEqual(["operator"]);
      expect(classesOf(lines, "derive")).toEqual(["callName"]);
      expect(classesOf(lines, "pub")).toEqual(["keyword"]);
      expect(classesOf(lines, "struct")).toEqual(["storageKeyword"]);
      expect(classOnLine(lines, source.split("\n")[3], "Point"))
        .toBe("interfaceName");
      expect(classOnLine(lines, source.split("\n")[4], "Point"))
        .toBe("typeName");
      expect(classesOf(lines, "'a")).toEqual(["typeName"]);
      expect(classesOf(lines, "'_")).toEqual(["typeName"]);
      expect(classesOf(lines, "i32")).toEqual(["typeKeyword"]);
      expect(classesOf(lines, "label")).toEqual(["propertyName"]);
      expect(classesOf(lines, "impl")).toEqual(["storageKeyword"]);
      expect(classOnLine(lines, source.split("\n")[4], "for")).toBe("keyword");
      expect(classesOf(lines, "where")).toEqual(["keyword"]);
      expect(classesOf(lines, "fn")).toEqual(["storageKeyword"]);
      expect(classOnLine(lines, source.split("\n")[5], "fmt"))
        .toBe("functionName");
      expect(classesOf(lines, "self")).toEqual(["keyword"]);
      expect(classesOf(lines, "f")).toEqual(["parameter", "identifier"]);
      expect(classesOf(lines, "mut")).toEqual(["keyword"]);
      expect(classesOf(lines, "Formatter")).toEqual(["typeName"]);
      expect(classesOf(lines, "let")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "x")).toEqual(["propertyName", "binding"]);
      expect(classesOf(lines, "total")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "new")).toEqual(["callName"]);
      expect(classOnLine(lines, source.split("\n")[8], "for"))
        .toBe("controlKeyword");
      expect(classesOf(lines, "item")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "parts")).toEqual(["propertyName"]);
      expect(classesOf(lines, "push")).toEqual(["callName"]);
      expect(classesOf(lines, "write!")).toEqual(["callName"]);
      expect(classesOf(lines, '"{x}"')).toEqual(["string"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors literals, comments, and macro definitions", () => {
      const source = [
        "#!/usr/bin/env run-cargo-script",
        "//! Documents the crate.",
        "/// Documents the item below.",
        "// An ordinary comment.",
        "/** A block doc comment. */",
        "/* A block /* nested */ comment. */",
        "const LIMITS: (u8, f64, i64, bool) = (0xff, 1.5e3, -7, true);",
        'static NAME: &str = r#"raw "quoted""#;',
        "macro_rules! square { ($e:expr) => { $e * $e }; }",
        "fn bytes() -> ! { let c = (b'a', '\\n', \"\\u{41}\"); loop {} }",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "#!/usr/bin/env run-cargo-script"))
        .toEqual(["comment"]);
      expect(classesOf(lines, "//! Documents the crate."))
        .toEqual(["docComment"]);
      expect(classesOf(lines, "/// Documents the item below."))
        .toEqual(["docComment"]);
      expect(classesOf(lines, "// An ordinary comment.")).toEqual(["comment"]);
      expect(classesOf(lines, "/** A block doc comment. */"))
        .toEqual(["docComment"]);
      expect(classesOf(lines, "/* A block /* nested */ comment. */"))
        .toEqual(["comment"]);
      expect(classesOf(lines, "const")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "LIMITS")).toEqual(["binding"]);
      for (const number of ["0xff", "1.5e3", "7"]) {
        expect(classesOf(lines, number)).toEqual(["number"]);
      }
      expect(classesOf(lines, "true")).toEqual(["boolean"]);
      expect(classesOf(lines, 'r#"raw "quoted""#')).toEqual(["string"]);
      expect(classesOf(lines, "macro_rules!")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "square")).toEqual(["functionName"]);
      expect(classesOf(lines, "$e")).toEqual(["parameter"]);
      expect(classesOf(lines, "expr")).toEqual(["typeKeyword"]);
      expect(classesOf(lines, "!")).toEqual(["typeKeyword"]);
      expect(classesOf(lines, "b'a'")).toEqual(["string"]);
      expect(classesOf(lines, "'\\n'")).toEqual(["string"]);
      expect(classesOf(lines, '"\\u{41}"')).toEqual(["string"]);
      expect(classesOf(lines, "loop")).toEqual(["controlKeyword"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors patterns, labels, closures, and trait objects", () => {
      const source = [
        "fn run<F>(mut items: Vec<Box<dyn Fn(u8)>>) -> impl Iterator where for<'a> F: Fn(&'a u8) {",
        "    'outer: while let Some(first) = items.pop() {",
        "        match first { Kind::A(inner) | Kind::B(inner) => break 'outer, ref other @ _ => {} }",
        "        let (left, [head, ..]) = split(&items);",
        "        let add = |a, b: u8| a + b;",
        "        if let Some(value) = cache.get::<u8>(&key) { return value; }",
        "    }",
        "}",
      ].join("\n");
      const lines = highlight(source);

      expect(classesOf(lines, "items")).toEqual(["parameter", "identifier"]);
      expect(classesOf(lines, "dyn")).toEqual(["typeKeyword"]);
      expect(classOnLine(lines, source.split("\n")[0], "impl"))
        .toBe("typeKeyword");
      expect(classOnLine(lines, source.split("\n")[0], "for")).toBe("keyword");
      expect(classesOf(lines, "'outer")).toEqual(["propertyName"]);
      expect(classesOf(lines, "while")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "Some")).toEqual(["callName"]);
      expect(classesOf(lines, "first")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "A")).toEqual(["callName"]);
      expect(classesOf(lines, "inner")).toEqual(["binding"]);
      expect(classesOf(lines, "break")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "ref")).toEqual(["keyword"]);
      expect(classesOf(lines, "other")).toEqual(["binding"]);
      expect(classesOf(lines, "@")).toEqual(["operator"]);
      expect(classesOf(lines, "left")).toEqual(["binding"]);
      expect(classesOf(lines, "head")).toEqual(["binding"]);
      expect(classesOf(lines, "a")).toEqual(["parameter", "identifier"]);
      expect(classOnLine(lines, source.split("\n")[4], "|"))
        .toBe("punctuation");
      expect(classesOf(lines, "value")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "get")).toEqual(["callName"]);
      expect(classesOf(lines, "return")).toEqual(["controlKeyword"]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors parameter patterns' names as parameters, capitalized names in patterns as references, and capitalized paths as types", () => {
      const source = [
        "fn pick(&c: &u8, (p, q): (u8, u8), o: Option<u8>) -> Self::Item {",
        "    let f = |&x, mut y| x + y + p + q;",
        "    match o { None => 0, MAX => 1, Some(v) if ready => v + c, _ => io::Error::A.into() }",
        "}",
      ].join("\n");
      const lines = highlight(source);

      for (const name of ["c", "p", "q", "x", "y"]) {
        expect(classesOf(lines, name)).toEqual(["parameter", "identifier"]);
      }
      expect(classesOf(lines, "None")).toEqual(["identifier"]);
      expect(classesOf(lines, "ready")).toEqual(["identifier"]);
      expect(classesOf(lines, "Self")).toEqual(["typeName"]);
      expect(classesOf(lines, "MAX")).toEqual(["identifier"]);
      expect(classesOf(lines, "v")).toEqual(["binding", "identifier"]);
      expect(classesOf(lines, "io")).toEqual(["identifier"]);
      expect(classesOf(lines, "Error")).toEqual(["typeName"]);
      expect(classesOf(lines, "A")).toEqual(["identifier"]);
    });

    it("keeps generic angle brackets out of bracket depth", () => {
      const source = "let map: HashMap<String, [u8; 4]> = HashMap::new();";
      const [line] = highlight(source);
      const brackets = line.spans.filter((span) => span.cls === "bracket");

      expect(classesOf([line], "<")).toEqual(["punctuation"]);
      expect(classesOf([line], ">")).toEqual(["punctuation"]);
      expect(brackets.map((span) => [span.text, span.bracketDepth])).toEqual([
        ["[", 0],
        ["]", 0],
        ["(", 0],
        [")", 0],
      ]);
    });

    it("colors the name of an item the parser could not finish", () => {
      const lines = highlight(
        [
          "impl Limits {",
          "    pub fn usage(&self) -> bool {",
          "        self.ids() ||",
        ].join("\n"),
      );

      expect(classesOf(lines, "usage")).toEqual(["functionName"]);
      for (
        const [source, name] of [
          ["struct Draft {\n    a: u8,\n    b: (", "Draft"],
          ["mod draft {\n    fn inner(", "draft"],
          ["trait Draft {\n    fn inner(", "Draft"],
        ]
      ) {
        expect(classesOf(highlight(source), name)).toContain("interfaceName");
      }
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'let s = "unterminated\nlet after = 1;',
          'let s = r#"never closed',
          "/* never closed",
          "fn broken(",
          "struct Half {\n  fn inner(",
          "0x 1e+ @@@ #[",
          "\ud800",
          "",
          " \t",
          'let café = "☕ 😀";',
        ]
      ) {
        const document = rustLanguage.parseDocument(source);
        expect(verbatim(document.lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    const source = [
      "use std::fmt;",
      "",
      "pub const LIMIT: usize = 64;",
      'static NAME: &str = "router";',
      "",
      "pub struct Store<T> {",
      "    items: Vec<T>,",
      "    pub count: usize,",
      "}",
      "",
      "pub union Bits { word: u32, bytes: [u8; 4] }",
      "",
      "pub enum Kind { A { inner_field: u8 }, B(u8) }",
      "",
      "pub trait Loader {",
      "    type Item;",
      "    const SIZE: usize;",
      "    fn load(&self) -> Self::Item;",
      "}",
      "",
      "impl<T> Store<T> {",
      "    const EMPTY: usize = 0;",
      "    pub fn new() -> Self {",
      "        const LOCAL: u8 = 1;",
      "        fn helper() {}",
      "        Store { items: Vec::new(), count: 0 }",
      "    }",
      "}",
      "",
      "impl fmt::Display for crate::store::Store<u8> {}",
      "impl Loader for (u8, u8) {}",
      "impl<T: Loader> Loader for &T {}",
      "impl !Send for Bits {}",
      "const _: () = ();",
      "",
      "type Handler = fn(u8);",
      "",
      'extern "C" { fn abs(input: i32) -> i32; }',
      "",
      "macro_rules! square { ($e:expr) => { $e * $e }; }",
      "",
      "mod tests;",
      "mod nested { fn inner() {} }",
    ].join("\n");

    it("lists items, members, and fields", () => {
      const document = rustLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
          node.endLine,
        ]),
      ).toEqual([
        ["variable", "const LIMIT", 0, 2, 2],
        ["variable", "static NAME", 0, 3, 3],
        ["class", "struct Store", 0, 5, 8],
        ["variable", "items", 1, 6, 6],
        ["variable", "count", 1, 7, 7],
        ["class", "union Bits", 0, 10, 10],
        ["variable", "word", 1, 10, 10],
        ["variable", "bytes", 1, 10, 10],
        ["class", "enum Kind", 0, 12, 12],
        ["variable", "A", 1, 12, 12],
        ["variable", "inner_field", 2, 12, 12],
        ["variable", "B", 1, 12, 12],
        ["interface", "trait Loader", 0, 14, 18],
        ["typeAlias", "type Item", 1, 15, 15],
        ["variable", "const SIZE", 1, 16, 16],
        ["method", "fn load", 1, 17, 17],
        ["class", "impl Store<T>", 0, 20, 27],
        ["variable", "const EMPTY", 1, 21, 21],
        ["method", "fn new", 1, 22, 26],
        ["variable", "const LOCAL", 2, 23, 23],
        ["function", "fn helper", 2, 24, 24],
        ["class", "impl fmt::Display for crate::store::Store<u8>", 0, 29, 29],
        ["class", "impl Loader for (u8, u8)", 0, 30, 30],
        ["class", "impl Loader for &T", 0, 31, 31],
        ["class", "impl !Send for Bits", 0, 32, 32],
        ["typeAlias", "type Handler", 0, 35, 35],
        ["function", "fn abs", 0, 37, 37],
        ["function", "macro_rules! square", 0, 39, 39],
        ["object", "mod tests", 0, 41, 41],
        ["object", "mod nested", 0, 42, 42],
        ["function", "fn inner", 1, 42, 42],
      ]);
    });

    it("indexes declared names, and an implementation under its type's own name", () => {
      const document = rustLanguage.parseDocument(source);
      const store = document.structure.find((node) =>
        node.label === "struct Store"
      )!;

      expect(document.definitions.get("Store")!.map((d) => d.startLine))
        .toEqual([5, 20, 29]);
      expect(document.definitions.has("u8")).toBe(false);
      expect(document.definitions.has("T")).toBe(false);
      expect(document.definitions.get("Bits")!.map((d) => d.startLine))
        .toEqual([10, 32]);
      expect(document.definitions.has("_")).toBe(false);
      expect(document.definitions.has("LOCAL")).toBe(true);
      expect(document.definitions.has("inner_field")).toBe(true);
      expect(document.definitions.has("inner")).toBe(true);
      expect(source.slice(store.nameOffset!, store.nameOffset! + 5))
        .toBe("Store");
      expect(store.astKinds).toEqual(["struct_item"]);
    });

    it("lists items declared in a function's statement blocks, and no expression's items", () => {
      const document = rustLanguage.parseDocument(
        [
          "fn serve() {",
          '    #[cfg(target_os = "linux")]',
          "    {",
          '        extern "C" fn terminate(_: i32) {}',
          "    }",
          "    unsafe { fn raw() {} }",
          "    let run = || { fn hidden() {} };",
          "}",
        ].join("\n"),
      );

      expect(document.flatStructure.map((node) => [node.label, node.depth]))
        .toEqual([["fn serve", 0], ["fn terminate", 1], ["fn raw", 1]]);
    });

    it("labels an implementation written over several lines on one line", () => {
      const document = rustLanguage.parseDocument(
        "impl<K, V> Trait for HashMap<\n    K,\n    V,\n> {}",
      );

      expect(document.structure.map((node) => node.label)).toEqual([
        "impl Trait for HashMap< K, V, >",
      ]);
    });

    it("lists no entry for an item whose name is not typed yet", () => {
      const document = rustLanguage.parseDocument(
        ["struct {}", "fn () {}", "fn named() {}"].join("\n"),
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "fn named",
      ]);
      expect([...document.definitions.keys()]).toEqual(["named"]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "// café ☕ and an astral 😀",
        "use std::fmt;",
        "",
        "struct Store {",
        "    items: Vec<String>,",
        "}",
        "impl Store {",
        "    fn add(&mut self, item: String) {",
        "        self.items.push(item);",
        "    }",
        '    fn summary(&self) -> String { format!("{} items", self.items.len()) }',
        "}",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ["self.items.push(item);", "self.items.push(item.to_lowercase());"],
        ["fn add(", "fn adding("],
        ["use std::fmt;", "use std::fmt;\nuse std::io;"],
        ['"{} items"', '"{} items'],
        ["    items: Vec<String>,", "    items: Vec<String"],
        ["// café ☕ and an astral 😀", "/* café ☕ and an astral 😀"],
      ];
      const highlighter = rustLanguage.createHighlighter(source);
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

    it("colors a diff of an unavailable file from its raw string context", () => {
      const diff = [
        "diff --git a/src/banner.rs b/src/banner.rs",
        "--- a/src/banner.rs",
        "+++ b/src/banner.rs",
        "@@ -1,3 +1,3 @@",
        ' const BANNER: &str = r#"',
        "-old text",
        "+new text",
        ' "#;',
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
