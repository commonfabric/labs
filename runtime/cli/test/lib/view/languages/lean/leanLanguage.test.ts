import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForName,
} from "../../../../../lib/view/languages/language.ts";
import { parseDiff } from "../../../../../lib/view/diff.ts";
import { buildDiffDocument } from "../../../../../lib/view/diffdoc.ts";
import { leanLanguage } from "../../../../../lib/view/languages/lean/language.ts";
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

/** The classes `leanLanguage` gives to an exact fragment of `source`. */
function classesIn(source: string, text: string): TokenClass[] {
  return classesOf(leanLanguage.highlightLines(source), text);
}

/** Each structure entry's label, depth, and first and last lines. */
function outline(source: string): [string, number, number, number][] {
  return leanLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

describe("leanLanguage", () => {
  it("selects Lean source by its extension and name", () => {
    expect(languageForFile("cfc/formal/Cfc/Atom.lean").id).toBe("lean");
    expect(languageForFile("lakefile.lean").id).toBe("lean");
    expect(languageForFile("notes.lean.txt").id).toBe("plain-text");
    expect(languageForName("lean4")).toBe(leanLanguage);
  });

  it("colors line, block, nested, and documentation comments", () => {
    const source = [
      "-- a line comment",
      "/- outer /- inner -/ still outer -/ def f := 1",
      "/-- A declaration's documentation. -/",
      "/-! A module's documentation. -/",
    ].join("\n");
    const lines = leanLanguage.highlightLines(source);

    expect(classesOf(lines, "-- a line comment")).toEqual(["comment"]);
    expect(classesOf(lines, "/- outer /- inner -/ still outer -/"))
      .toEqual(["comment"]);
    expect(classesOf(lines, "def")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "/-- A declaration's documentation. -/"))
      .toEqual(["docComment"]);
    expect(classesOf(lines, "/-! A module's documentation. -/"))
      .toEqual(["docComment"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("colors strings, their escapes, and the code in an interpolated string", () => {
    const source = 'def s := s!"a \\"{x}\\" {({ y := 1 } : P).y}" ++ "{z}"';
    const lines = leanLanguage.highlightLines(source);

    expect(classesOf(lines, 's!"a \\"')).toEqual(["string"]);
    expect(classesOf(lines, "x")).toEqual(["identifier"]);
    expect(classesOf(lines, "y")).toEqual(["identifier"]);
    expect(classesOf(lines, '\\" ')).toEqual(["string"]);
    expect(classesOf(lines, "P")).toEqual(["identifier"]);
    expect(classesOf(lines, '"')).toEqual(["string"]);
    expect(classesOf(lines, '"{z}"')).toEqual(["string"]);
    expect(classesOf(lines, "++")).toEqual(["operator"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("colors raw strings, characters, names, and numbers as literals", () => {
    const source =
      "#eval (r#\"a \"quoted\" b\"#, 'x', '\\n', `Nat.succ, ``List, 42, 0x1F, 2.5e3)";
    const lines = leanLanguage.highlightLines(source);

    expect(classesOf(lines, "#eval")).toEqual(["keyword"]);
    expect(classesOf(lines, 'r#"a "quoted" b"#')).toEqual(["string"]);
    expect(classesOf(lines, "'x'")).toEqual(["string"]);
    expect(classesOf(lines, "'\\n'")).toEqual(["string"]);
    expect(classesOf(lines, "`Nat.succ")).toEqual(["string"]);
    expect(classesOf(lines, "``List")).toEqual(["string"]);
    expect(classesOf(lines, "42")).toEqual(["number"]);
    expect(classesOf(lines, "0x1F")).toEqual(["number"]);
    expect(classesOf(lines, "2.5e3")).toEqual(["number"]);
    expect(classesIn("#eval! h.1.2", "#eval!")).toEqual(["keyword"]);
    expect(classesIn("#eval! h.1.2", "1")).toEqual(["number"]);
    expect(classesIn("#eval! h.1.2", "2")).toEqual(["number"]);
  });

  it("reads identifiers with Lean's letters, subscripts, and escapes", () => {
    const source =
      "theorem t (α : Type) (h₁ h' : x ∈ ℝ) : «x.y».get! = Π := λ a => a";
    const lines = leanLanguage.highlightLines(source);

    expect(classesOf(lines, "α")).toEqual(["identifier"]);
    expect(classesOf(lines, "h₁")).toEqual(["identifier"]);
    expect(classesOf(lines, "h'")).toEqual(["identifier"]);
    expect(classesOf(lines, "ℝ")).toEqual(["identifier"]);
    expect(classesOf(lines, "«x.y».get!")).toEqual(["identifier"]);
    expect(classesOf(lines, "∈")).toEqual(["operator"]);
    expect(classesOf(lines, "Π")).toEqual(["operator"]);
    expect(classesOf(lines, "λ")).toEqual(["controlKeyword"]);
    expect(classesOf(lines, "Type")).toEqual(["typeKeyword"]);
  });

  it("colors keywords, declared names, and attribute names", () => {
    const source = [
      "@[simp, reducible] private theorem two : 1 + 1 = 2 := by decide",
      "structure Point where",
      "  x : Nat := 0",
      "  deriving Repr",
      "deriving instance BEq for Point",
      "attribute [local simp] two",
      "namespace Geometry.Plane",
      "def flag : Bool := if true then false else sorry",
      "end Geometry.Plane",
    ].join("\n");
    const lines = leanLanguage.highlightLines(source);

    expect(classesOf(lines, "simp")).toEqual(["callName"]);
    expect(classesOf(lines, "reducible")).toEqual(["callName"]);
    expect(classesOf(lines, "private")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "two")).toEqual(["functionName", "identifier"]);
    expect(classesOf(lines, "by")).toEqual(["controlKeyword"]);
    expect(classesOf(lines, "decide")).toEqual(["identifier"]);
    expect(classesOf(lines, "Point")).toEqual(["interfaceName", "identifier"]);
    expect(classesOf(lines, "BEq")).toEqual(["identifier"]);
    expect(classesOf(lines, "deriving")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "Geometry.Plane")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "flag")).toEqual(["functionName"]);
    expect(classesOf(lines, "true")).toEqual(["boolean"]);
    expect(classesOf(lines, "sorry")).toEqual(["keyword"]);
  });

  it("gives Lean's angle, white, and double brackets their nesting depth", () => {
    const [line] = leanLanguage.highlightLines("⟨⟨a, ⦃b⦄⟩, ⟦c⟧⟩");

    expect(
      line.spans.filter((span) => span.cls === "bracket").map((span) =>
        `${span.text}${span.bracketDepth}`
      ),
    ).toEqual(["⟨0", "⟨1", "⦃2", "⦄2", "⟩1", "⟦1", "⟧1", "⟩0"]);
  });

  it("lists namespaces, sections, and the declarations inside them", () => {
    const source = [
      "import Std", //                             0
      "namespace Cfc", //                          1
      "/-- Labels. -/", //                         2
      "inductive Label where", //                  3
      "  | low | high", //                         4
      "", //                                       5
      "@[simp] theorem low_le (l : Label) :", //   6
      "    l = l := rfl", //                       7
      "section", //                                8
      "noncomputable def pick := Label.low", //    9
      "instance : Repr Label where", //            10
      '  reprPrec _ _ := "label"', //            11
      "end", //                                    12
      "example : 1 + 1 = 2 := by decide", //       13
      "class inductive Small where | one", //      14
      "open Label in", //                          15
      "abbrev L := Label", //                      16
      "end Cfc", //                                17
    ].join("\n");

    expect(outline(source)).toEqual([
      ["namespace Cfc", 0, 1, 17],
      ["inductive Label", 1, 3, 4],
      ["theorem low_le", 1, 6, 7],
      ["section", 1, 8, 12],
      ["def pick", 2, 9, 9],
      ["instance : Repr Label", 2, 10, 11],
      ["example : 1 + 1 = 2", 1, 13, 13],
      ["class inductive Small", 1, 14, 14],
      ["abbrev L", 1, 16, 16],
    ]);
    const document = leanLanguage.parseDocument(source);
    expect(document.definitions.get("low_le")?.map((d) => d.startOffset))
      .toEqual([source.indexOf("@[simp]")]);
    expect(document.flatStructure[1].kind).toBe("class");
    expect(document.flatStructure[2].kind).toBe("function");
    expect(document.flatStructure[0].kind).toBe("object");
  });

  it("closes a dotted namespace by the components each `end` names", () => {
    const source = [
      "namespace A.B",
      "def f := 1",
      "end B",
      "def g := 2",
      "end A",
      "namespace C",
      "namespace D",
      "end C.D",
      "def h := 3",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["namespace A.B", 0, 0, 4],
      ["def f", 1, 1, 1],
      ["def g", 1, 3, 3],
      ["namespace C", 0, 5, 7],
      ["namespace D", 1, 6, 7],
      ["def h", 0, 8, 8],
    ]);
  });

  it("reads indented declarations in a `mutual` block, and leaves an unclosed scope open to the end", () => {
    const source = [
      "namespace Open",
      "mutual",
      "  def even : Nat → Bool",
      "    | 0 => true",
      "    | n + 1 => odd n",
      "  def odd : Nat → Bool",
      "    | 0 => false",
      "    | n + 1 => even n",
      "end",
      "theorem t : even 0 := rfl",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["namespace Open", 0, 0, 9],
      ["mutual", 1, 1, 8],
      ["def even", 2, 2, 4],
      ["def odd", 2, 5, 7],
      ["theorem t", 1, 9, 9],
    ]);
  });

  it("continues a declaration over lines indented further than its own, and over a string's lines", () => {
    const source = [
      "theorem t : P := by", //                   0
      "  set_option maxHeartbeats 400000 in", //  1
      "  open Classical in", //                   2
      "  exact h", //                             3
      "structure Foo where", //                   4
      "  protected x : Nat", //                   5
      "  private y : Nat", //                     6
      'def usage := "first', //                   7
      "second", //                                8
      'third"', //                                9
      "", //                                      10
      "instance (priority := 100) : Foo Nat := ⟨1⟩", // 11
      "set_option autoImplicit false", //         12
    ].join("\n");

    expect(outline(source)).toEqual([
      ["theorem t", 0, 0, 3],
      ["structure Foo", 0, 4, 6],
      ["def usage", 0, 7, 9],
      ["instance (priority := 100) : Foo Nat", 0, 11, 11],
    ]);
  });

  it("gives an attribute list's brackets their nesting depth", () => {
    const [line] = leanLanguage.highlightLines("(@[simp] x)");

    expect(classesOf([line], "@")).toEqual(["punctuation"]);
    expect(
      line.spans.filter((span) => span.cls === "bracket").map((span) =>
        `${span.text}${span.bracketDepth}`
      ),
    ).toEqual(["(0", "[1", "]1", ")0"]);
  });

  it("ends an unclosed attribute list at the end of its line", () => {
    const source = "@[simp\ndef a := 1\ndef b := 2";

    expect(outline(source)).toEqual([
      ["def a", 0, 0, 1],
      ["def b", 0, 2, 2],
    ]);
    expect(classesIn("@[simp\nf a, b", "b")).toEqual(["identifier"]);
  });

  it("takes only a `#` command, and not the `#` of an array literal, as a command", () => {
    expect(outline("def xs : Array Nat :=\n#[1, 2]\n#eval xs")).toEqual([
      ["def xs", 0, 0, 1],
    ]);
  });

  it("colors a keyword that names an attribute as an attribute name", () => {
    expect(classesIn("attribute [instance] foo", "instance")).toEqual([
      "callName",
    ]);
    expect(classesIn("@[foo [bar], baz] def x := 1", "baz")).toEqual([
      "callName",
    ]);
    expect(classesIn("open Nat in #eval 1", "#eval")).toEqual(["keyword"]);
  });

  it("opens a documentation comment with `/--` even when `/` follows it", () => {
    const source = "/--/ still documentation -/ def f := 1";

    expect(classesIn(source, "/--/ still documentation -/")).toEqual([
      "docComment",
    ]);
    expect(classesIn(source, "def")).toEqual(["storageKeyword"]);
  });

  it("starts a declaration after a comment that begins its line", () => {
    const source = [
      "def a := 1",
      "/-- doc b -/ def b := 2",
      "/- spanning",
      " lines -/ theorem c : True := trivial",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["def a", 0, 0, 0],
      ["def b", 0, 1, 1],
      ["theorem c", 0, 3, 3],
    ]);
  });

  it("keeps an attribute list that continues on an indented line", () => {
    const source = "@[simp,\n  norm_cast]\ntheorem foo := rfl";

    expect(outline(source)).toEqual([["theorem foo", 0, 0, 2]]);
    expect(classesIn(source, "norm_cast")).toEqual(["callName"]);
  });

  it("ends a declaration at a command, and not at a proof line at its indent", () => {
    const source = [
      "def a := 1", //            0
      "alias b := a", //          1
      "example :", //             2
      "    P := by", //           3
      "exact h", //               4
      "  (by simp)", //           5
      "run_cmd pure ()", //       6
      "def c := 2", //            7
    ].join("\n");

    expect(outline(source)).toEqual([
      ["def a", 0, 0, 0],
      ["example", 0, 2, 5],
      ["def c", 0, 7, 7],
    ]);
  });

  it("ends a declaration at a word that starts a line after a finished one", () => {
    const source = [
      "theorem a : True := trivial", //            0
      'notation3 "x" => tsum', //                1
      "irreducible_def two : Nat := 2", //        2
      "structure S where", //                      3
      "x : Nat", //                                4
      "def z := 0", //                             5
      '@[foo s!"{x}"] def b := 1', //              6
    ].join("\n");

    expect(outline(source)).toEqual([
      ["theorem a", 0, 0, 0],
      ["irreducible_def two", 0, 2, 2],
      ["structure S", 0, 3, 4],
      ["def z", 0, 5, 5],
      ["def b", 0, 6, 6],
    ]);
  });

  it("keeps a declaration's continuation lines at its own indent", () => {
    const source = [
      "inductive T where", //                     0
      "| leaf", //                                1
      "| node (l r : T)", //                      2
      "deriving Repr", //                         3
      "def size : T → Nat", //                    4
      "  | .leaf => 1", //                        5
      "  | .node l r => size l + size r", //      6
      "termination_by t => t", //                 7
      "decreasing_by all_goals simp", //          8
    ].join("\n");

    expect(outline(source)).toEqual([
      ["inductive T", 0, 0, 3],
      ["def size", 0, 4, 8],
    ]);
  });

  it("colors `#` and a word as a command only where a command can start", () => {
    const source = "#check Nat\ntheorem t :\n    #s = 3 := by simp";

    expect(classesIn(source, "#check")).toEqual(["keyword"]);
    expect(classesIn(source, "s")).toEqual(["identifier"]);
    expect(classesIn(source, "#")).toEqual(["operator"]);
  });

  it("ends a declaration at a command keyword after a line that ends in an operator", () => {
    const source = [
      "theorem foo (h : P) : Q := by", //            0
      "  simp at h ⊢", //                            1
      "assert_not_exists Field", //                  2
      'def greet (n : String) := s!"Hello {n}"', //  3
      'notation3 "x" => greet', //                   4
      "deriving instance Repr for T", //             5
      "attribute [local instance] greet", //         6
    ].join("\n");

    expect(outline(source)).toEqual([
      ["theorem foo", 0, 0, 1],
      ["def greet", 0, 3, 3],
    ]);
  });

  it("closes a namespace whose name is a `«…»` escape holding a dot", () => {
    expect(outline("namespace «A.B»\ndef f := 1\nend «A.B»\ndef g := 2"))
      .toEqual([
        ["namespace «A.B»", 0, 0, 2],
        ["def f", 1, 1, 1],
        ["def g", 0, 3, 3],
      ]);
  });

  it("starts a declaration after `open … in` on the same line", () => {
    expect(outline("def a := 1\nopen Nat in theorem t : True := trivial"))
      .toEqual([
        ["def a", 0, 0, 0],
        ["theorem t", 0, 1, 1],
      ]);
  });

  it("labels a declaration from its keywords, name, and signature", () => {
    const source = [
      'instance : Foo "(" := ⟨1⟩',
      'example : "a := b".length = 6 := rfl',
      "instance : Nowhere := x",
      "instance (priority := low) instFoo : Foo Nat := ⟨⟩",
      "instance {α : Type} [Foo α] :",
      "    Bar α := ⟨⟩",
      "class abbrev Both := A, B",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      'instance : Foo "("',
      'example : "a := b".length = 6',
      "instance : Nowhere",
      "instance instFoo",
      "instance {α : Type} [Foo α]",
      "class abbrev Both",
    ]);
  });

  it("colors interpolations in `s!`, `m!`, and `f!` strings and after `throwError`", () => {
    expect(classesIn('#eval panic!"bad {x}"', '"bad {x}"')).toEqual(["string"]);
    expect(classesIn('#eval m!"bad {x}"', "x")).toEqual(["identifier"]);
    expect(classesIn('def f := throwError "bad {e}"', "e")).toEqual([
      "identifier",
    ]);
    expect(classesIn('def f := dbg_trace "at {e}"; e', "dbg_trace")).toEqual([
      "identifier",
    ]);
    expect(classesIn('def f := throwError"bad {e}"', "throwError")).toEqual([
      "identifier",
    ]);
  });

  it("lists scopes nested deeper than the call stack, in a file and in a diff", () => {
    const depth = 20_000;
    const source = "namespace A\n".repeat(depth) + "def f := 1\n";
    const document = leanLanguage.parseDocument(source);

    expect(document.flatStructure.length).toBe(depth + 1);
    expect(document.flatStructure.at(-1)).toMatchObject({
      label: "def f",
      depth,
    });

    const lines = source.split("\n").slice(0, -1);
    const diff = [
      "--- a/Deep.lean",
      "+++ b/Deep.lean",
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      "",
    ].join("\n");
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, {
      resolve: () => null,
      read: () => null,
    });
    expect(doc.flatStructure.filter((node) => node.label === "def f").length)
      .toBe(1);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of [
        "/-",
        "/- /- -/",
        '"open',
        's!"{',
        's!"{x',
        'r#"open',
        "'",
        "«open",
        "@[simp",
        "⟨a, ⟨b",
        "`",
        "namespace",
        "end",
        "theorem",
        "def x := '☕' ++ \"😀\"",
        "",
        "\n\n",
      ]
    ) {
      expect(verbatim(leanLanguage.parseDocument(source).lines)).toBe(source);
    }
    expect(classesIn("/- open\ndef f := 1", "def f := 1")).toEqual(["comment"]);
    expect(classesIn('"open\ndef', "def")).toEqual(["string"]);
    expect(outline("namespace\ntheorem\nend")).toEqual([
      ["namespace", 0, 0, 2],
      ["theorem", 1, 1, 1],
    ]);
  });

  it("recolors each edit", () => {
    const highlighter = leanLanguage.createHighlighter("def f := 1");
    expect(highlighter.update("def f := 1")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("-- def f := 1"), "-- def f := 1"))
      .toEqual(["comment"]);
  });
});
