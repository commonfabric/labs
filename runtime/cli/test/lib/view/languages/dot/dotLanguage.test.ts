import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  decodeLanguageInput,
  languageForFile,
  languageForName,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { dotLanguage } from "../../../../../lib/view/languages/dot/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { parseDiff } from "../../../../../lib/view/diff.ts";
import { buildDiffDocument } from "../../../../../lib/view/diffdoc.ts";

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

/** Each structure entry's label, depth, and first and last lines. */
function outline(source: string): [string, number, number, number][] {
  return dotLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

const SPACE_MAP = [
  "digraph space {",
  "  rankdir=LR;",
  '  node [shape=box,style="filled,rounded",fontsize=9];',
  '  "of:abc" [label="counter\\nabc",fillcolor="#f3f4f6"];',
  '  "of:abc" -> "of:def" [label="reads"];',
  "}",
].join("\n");

describe("dotLanguage", () => {
  it("selects `.dot` and `.gv` files and the names DOT is known by", () => {
    expect(languageForFile("pkg/sentry/kernel/g3doc/run_states.dot").id)
      .toBe("dot");
    expect(languageForFile("SPACE.GV").id).toBe("dot");
    expect(languageForFile("dot").id).toBe("plain-text");
    expect(languageForFile("graph.txt").id).toBe("plain-text");
    expect(languageForSource("graph.txt", SPACE_MAP).id).toBe("plain-text");
    expect(languageForName("graphviz")).toBe(dotLanguage);
    expect(languageForName("gv")).toBe(dotLanguage);
  });

  it("selects binary for a `.dot` Word template, which holds NUL bytes", () => {
    const template = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
    const graph = new TextEncoder().encode(SPACE_MAP);

    expect(decodeLanguageInput("letter.dot", template).language.id)
      .toBe("binary");
    expect(decodeLanguageInput("space.dot", graph).language.id).toBe("dot");
  });

  it("colors each ID by what it names", () => {
    const lines = dotLanguage.highlightLines(SPACE_MAP);

    expect(classesOf(lines, "digraph")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "space")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "node")).toEqual(["keyword"]);
    expect(classesOf(lines, "rankdir")).toEqual(["propertyName"]);
    expect(classesOf(lines, "LR")).toEqual(["string"]);
    expect(classesOf(lines, "shape")).toEqual(["propertyName"]);
    expect(classesOf(lines, '"filled,rounded"')).toEqual(["string"]);
    expect(classesOf(lines, "9")).toEqual(["number"]);
    expect(classesOf(lines, '"of:abc"')).toEqual(["identifier"]);
    expect(classesOf(lines, '"of:def"')).toEqual(["identifier"]);
    expect(classesOf(lines, '"counter\\nabc"')).toEqual(["string"]);
    expect(classesOf(lines, "->")).toEqual(["operator"]);
    expect(classesOf(lines, "=")).toEqual(["operator"]);
    expect(classesOf(lines, ";")).toEqual(["punctuation"]);
    expect(classesOf(lines, ",")).toEqual(["punctuation"]);
    expect(classesOf(lines, "[")).toEqual(["bracket"]);
    expect(classesOf(lines, "{")).toEqual(["bracket"]);
    expect(verbatim(lines)).toBe(SPACE_MAP);
  });

  it("colors ports, numerals, edge operators, and concatenated strings", () => {
    const source = [
      "graph {",
      "  a:p1:n -- b:sw -- 1 -- -2",
      '  t [label=<<b>bold</b> &amp;>, width=-.5, tooltip="a" + "b"]',
      "  u [label=x] -- v",
      "}",
    ].join("\n");
    const lines = dotLanguage.highlightLines(source);

    expect(classesOf(lines, "graph")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "a")).toEqual(["identifier"]);
    expect(classesOf(lines, "p1")).toEqual(["propertyName"]);
    expect(classesOf(lines, "n")).toEqual(["propertyName"]);
    expect(classesOf(lines, "sw")).toEqual(["propertyName"]);
    expect(classesOf(lines, ":")).toEqual(["punctuation"]);
    expect(classesOf(lines, "--")).toEqual(["operator"]);
    expect(classesOf(lines, "1")).toEqual(["identifier"]);
    expect(classesOf(lines, "-2")).toEqual(["identifier"]);
    expect(classesOf(lines, "<<b>bold</b> &amp;>")).toEqual(["string"]);
    expect(classesOf(lines, "-.5")).toEqual(["number"]);
    expect(classesOf(lines, '"a"')).toEqual(["string"]);
    expect(classesOf(lines, "+")).toEqual(["operator"]);
    expect(classesOf(lines, '"b"')).toEqual(["string"]);
    expect(classesOf(lines, "x")).toEqual(["string"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("reads keywords in any case, and `graph` before an attribute list as an attribute statement", () => {
    const source =
      "Strict DiGraph G {\n  GRAPH [rankdir=LR]\n  Edge [color=red]\n}";
    const lines = dotLanguage.highlightLines(source);

    expect(classesOf(lines, "Strict")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "DiGraph")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "G")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "GRAPH")).toEqual(["keyword"]);
    expect(classesOf(lines, "Edge")).toEqual(["keyword"]);
    expect(outline(source)).toEqual([["Strict DiGraph G", 0, 0, 3]]);
    expect(
      classesOf(dotLanguage.highlightLines("  graph [color=red]"), "graph"),
    )
      .toEqual(["keyword"]);
  });

  it("colors comments, and a `#` outside a string to the end of its line", () => {
    const source = [
      '# 1 "graph.dot"',
      "digraph { // trailing",
      '  a # b [label="x"]',
      "  /* spans",
      "     lines */ f",
      '  c [color=#ff0000, label="d # e"]',
      "}",
    ].join("\n");
    const lines = dotLanguage.highlightLines(source);

    expect(classesOf(lines, '# 1 "graph.dot"')).toEqual(["comment"]);
    expect(classesOf(lines, "// trailing")).toEqual(["comment"]);
    expect(classesOf(lines, '# b [label="x"]')).toEqual(["comment"]);
    expect(classesOf(lines, '#ff0000, label="d # e"]')).toEqual(["comment"]);
    expect(classesOf(lines, "/* spans")).toEqual(["comment"]);
    expect(classesOf(lines, "     lines */")).toEqual(["comment"]);
    expect(classesOf(lines, "f")).toEqual(["identifier"]);
    expect(
      classesOf(dotLanguage.highlightLines('a [label="d # e"]'), '"d # e"'),
    )
      .toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "digraph",
      "a",
      "f",
      "c",
    ]);
  });

  it("ends an unclosed attribute list at the next block boundary", () => {
    const source = "digraph { a [label=x\n}\ndigraph B { c }";
    const lines = dotLanguage.highlightLines(source);

    expect(classesOf(lines, "c")).toEqual(["identifier"]);
    expect(
      classesOf(dotLanguage.highlightLines("a [b=c subgraph s { d }"), "d"),
    ).toEqual(["identifier"]);
    expect(outline(source)).toEqual([
      ["digraph", 0, 0, 1],
      ["a", 1, 0, 0],
      ["digraph B", 0, 2, 2],
      ["c", 1, 2, 2],
    ]);
  });

  it("reads strings that `+` joins as one ID wherever an ID goes", () => {
    const source = [
      'digraph "run" + "states" {',
      '  "lab" + "el" = "joined";',
      '  subgraph "cluster_" + "exec" { "long" + "name":p [shape=box] }',
      '  "x" + "y" -> z',
      "}",
    ].join("\n");
    const document = dotLanguage.parseDocument(source);

    expect(document.flatStructure.map((node) => node.label)).toEqual([
      'digraph "run" + "states"',
      'subgraph "cluster_" + "exec"',
      '"long" + "name"',
    ]);
    expect(document.flatStructure[2].endOffset).toBe(source.indexOf(" }"));
    expect(document.definitions.get('"run" + "states"')?.length).toBe(1);
    expect(classesOf(document.lines, '"states"')).toEqual(["interfaceName"]);
    expect(classesOf(document.lines, '"exec"')).toEqual(["interfaceName"]);
    expect(classesOf(document.lines, '"lab"')).toEqual(["propertyName"]);
    expect(classesOf(document.lines, '"el"')).toEqual(["propertyName"]);
    expect(classesOf(document.lines, '"joined"')).toEqual(["string"]);
    expect(classesOf(document.lines, '"name"')).toEqual(["identifier"]);
    expect(classesOf(document.lines, '"y"')).toEqual(["identifier"]);
  });

  it("continues a quoted string past escaped quotes and line breaks", () => {
    const source = 'digraph {\n  a [label="say \\"hi\\"\nthere"]\n  b\n}';
    const lines = dotLanguage.highlightLines(source);

    expect(classesOf(lines, '"say \\"hi\\"')).toEqual(["string"]);
    expect(classesOf(lines, 'there"')).toEqual(["string"]);
    expect(classesOf(lines, "b")).toEqual(["identifier"]);
    expect(outline(source)).toEqual([
      ["digraph", 0, 0, 4],
      ["a", 1, 1, 2],
      ["b", 1, 3, 3],
    ]);
  });

  it("lists graphs, subgraphs, and the nodes that node statements declare", () => {
    const source = [
      "digraph run_states {",
      "  subgraph {",
      "    App;",
      "  }",
      "  subgraph cluster_exec {",
      "    style = dotted;",
      "    Exec [shape=box]",
      "      [color=red];",
      "    Done:port",
      "  }",
      "  { rank = same; Left Right }",
      "  App -> Exec -> Done",
      "  Exec -> { Fork } Join",
      "}",
      'graph "second" { solo }',
      "graph { a, b -- c; d -- e, f; g, h [color=red]; i + j; k:p, l:q -- m }",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["digraph run_states", 0, 0, 13],
      ["subgraph", 1, 1, 3],
      ["App", 2, 2, 2],
      ["subgraph cluster_exec", 1, 4, 9],
      ["Exec", 2, 6, 7],
      ["Done", 2, 8, 8],
      ["Left", 1, 10, 10],
      ["Right", 1, 10, 10],
      ["Fork", 1, 12, 12],
      ["Join", 1, 12, 12],
      ['graph "second"', 0, 14, 14],
      ["solo", 1, 14, 14],
      ["graph", 0, 15, 15],
      ["g", 1, 15, 15],
      ["h", 1, 15, 15],
      ["i", 1, 15, 15],
      ["j", 1, 15, 15],
    ]);
    const document = dotLanguage.parseDocument(source);
    expect(document.definitions.get("Exec")?.map((d) => d.startOffset))
      .toEqual([source.indexOf("Exec [")]);
    expect(document.definitions.get("run_states")?.map((d) => d.startLine))
      .toEqual([0]);
    expect(document.definitions.get('"second"')?.map((d) => d.startLine))
      .toEqual([14]);
  });

  it("lists a diff hunk's subgraphs and nodes at the diff lines that show them", () => {
    const diff = [
      "diff --git a/run_states.dot b/run_states.dot",
      "--- a/run_states.dot",
      "+++ b/run_states.dot",
      "@@ -1,4 +1,5 @@",
      " subgraph cluster_exec {",
      "   Exec;",
      "+  Fork [shape=box];",
      " }",
      "-Exec -> Done",
      "+Exec -> Fork",
      "",
    ].join("\n");
    const workspace = { resolve: () => null, read: () => null };
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);
    const entries = doc.flatStructure.filter((node) =>
      node.kind === "object" || node.kind === "variable"
    );

    expect(entries.map((node) => [node.label, node.startLine, node.endLine]))
      .toEqual([
        ["subgraph cluster_exec", 4, 7],
        ["Exec", 5, 5],
        ["Fork", 6, 6],
      ]);
    expect(classesOf(doc.lines, "Fork")).toEqual(["identifier"]);
  });

  it("colors every ID in an attribute list that no `=` follows as an attribute", () => {
    const lines = dotLanguage.highlightLines("a [bold, color=red]");

    expect(classesOf(lines, "bold")).toEqual(["propertyName"]);
    expect(classesOf(lines, "color")).toEqual(["propertyName"]);
    expect(classesOf(lines, "red")).toEqual(["string"]);
  });

  it("labels an entry whose quoted name spans lines on one line", () => {
    const source = 'digraph "two\nlines" {\n  "first\n  second" [shape=box]\n}';
    const document = dotLanguage.parseDocument(source);

    expect(document.flatStructure.map((node) => node.label)).toEqual([
      'digraph "two lines"',
      '"first second"',
    ]);
  });

  it("extends an unclosed graph, comment, string, or HTML string to the end", () => {
    const source = "digraph G {\n  subgraph s {\n    a [label=<x<y>";
    const lines = dotLanguage.highlightLines(source);

    expect(classesOf(lines, "<x<y>")).toEqual(["string"]);
    expect(outline(source)).toEqual([
      ["digraph G", 0, 0, 2],
      ["subgraph s", 1, 1, 2],
      ["a", 2, 2, 2],
    ]);
    expect(classesOf(dotLanguage.highlightLines('a /* b\nc "d'), 'c "d'))
      .toEqual(["comment"]);
    expect(classesOf(dotLanguage.highlightLines('a [label="b\nc'), "c"))
      .toEqual(["string"]);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of [
        "digraph",
        "digraph {",
        "}",
        "]",
        "a ->",
        "a [",
        "a [b=",
        "a:",
        '"open',
        "<open",
        "/* open",
        "-",
        "☕ -> 😀",
        "",
        "\n\n",
      ]
    ) {
      expect(verbatim(dotLanguage.parseDocument(source).lines)).toBe(source);
    }
    expect(outline("digraph")).toEqual([]);
    expect(outline("}")).toEqual([]);
    expect(classesOf(dotLanguage.highlightLines("☕ -> 😀"), "😀"))
      .toEqual(["identifier"]);
  });

  it("recolors each edit", () => {
    const highlighter = dotLanguage.createHighlighter("a");
    expect(highlighter.update("a")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("a=b"), "a")).toEqual([
      "propertyName",
    ]);
  });
});
