/**
 * Contract tests for the shared Tree-sitter adapter, written against the
 * Python grammar. They pin the conventions a grammar upgrade could move
 * silently: which offsets Tree-sitter reports and accepts, that a query covers
 * the range it is given, and what a grammar shows before it has loaded.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createHighlighter,
  highlightLines,
  onGrammarLoad,
  parseDocument,
  prepareGrammar,
  type TreeSitterGrammar,
} from "../../../../../lib/view/languages/treesitter/adapter.ts";
import { pythonGrammar } from "../../../../../lib/view/languages/python/python.ts";
import type { Line } from "../../../../../lib/view/model.ts";

await prepareGrammar(pythonGrammar);

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Every class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): string[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

describe("adapter", () => {
  describe("prepareGrammar()", () => {
    it("shares one load between concurrent callers and repeats", async () => {
      // A grammar nothing has loaded yet, so the two calls race the load
      // itself rather than finding it already done.
      let reads = 0;
      const counted: TreeSitterGrammar = {
        ...pythonGrammar,
        id: "python-counted-load",
        wasmUrl: () => {
          reads++;
          return pythonGrammar.wasmUrl();
        },
      };

      await Promise.all([prepareGrammar(counted), prepareGrammar(counted)]);
      await prepareGrammar(counted);

      expect(reads).toBe(1);
      expect(verbatim(highlightLines(counted, "x = 1"))).toBe("x = 1");
    });

    it("names the grammar when its parser cannot be read", async () => {
      // The compiled grammar ships beside the code, so a read failure is about
      // the installation rather than about the file being viewed.
      const missing: TreeSitterGrammar = {
        ...pythonGrammar,
        id: "python-absent-parser",
        wasmUrl: () => new URL("./no-such-grammar.wasm", import.meta.url).href,
      };

      await expect(prepareGrammar(missing)).rejects.toThrow(
        /the python-absent-parser grammar could not be read from/,
      );
    });

    it("refuses a highlight query that names something other than a token class", async () => {
      const mistyped: TreeSitterGrammar = {
        ...pythonGrammar,
        id: "python-mistyped-capture",
        highlightQuery: "(comment) @commnet",
      };

      await expect(prepareGrammar(mistyped)).rejects.toThrow(
        /captures "commnet", which is not a token class/,
      );
    });

    it("says why a parser would not load when the grammar is used", async () => {
      // A grammar that will not load leaves the rest working and reports
      // itself when a file in its language is opened.
      const missing: TreeSitterGrammar = {
        ...pythonGrammar,
        id: "python-unreadable-parser",
        wasmUrl: () => new URL("./no-such-grammar.wasm", import.meta.url).href,
      };

      const failures: (string | undefined)[] = [];
      const stop = onGrammarLoad((failure) => failures.push(failure));
      try {
        await expect(prepareGrammar(missing)).rejects.toThrow(
          /could not be read from/,
        );
      } finally {
        stop();
      }

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(
        /the python-unreadable-parser grammar could not be read from/,
      );
      expect(classesOf(highlightLines(missing, "x = 1"), "x = 1"))
        .toEqual(["plain"]);
    });

    it("shows plain text until a grammar loads, and starts the load on first use", async () => {
      let reads = 0;
      const pending: TreeSitterGrammar = {
        ...pythonGrammar,
        id: "python-loaded-on-use",
        wasmUrl: () => {
          reads++;
          return pythonGrammar.wasmUrl();
        },
      };
      const outcomes: (string | undefined)[] = [];
      const stop = onGrammarLoad((failure) => outcomes.push(failure));
      try {
        expect(classesOf(highlightLines(pending, "x = 1"), "x = 1"))
          .toEqual(["plain"]);
        expect(parseDocument(pending, "def f():\n    pass").structure)
          .toEqual([]);
        expect(verbatim(createHighlighter(pending, "x = 1").lines))
          .toBe("x = 1");

        // The first use started the load, which this shares.
        expect(reads).toBe(1);
        await prepareGrammar(pending);
        expect(reads).toBe(1);

        expect(outcomes).toEqual([undefined]);
        expect(classesOf(highlightLines(pending, "x = 1"), "1"))
          .toEqual(["number"]);
      } finally {
        stop();
      }
    });
  });

  describe("offsets", () => {
    // Tree-sitter reports node offsets as JavaScript string offsets. Source
    // that is not all ASCII tells that apart from a UTF-8 byte count, which
    // would put every class after the first non-ASCII character adrift.
    it("colors the whole of a source that is not all ASCII", () => {
      const source = [
        "# café ☕ 😀",
        'name = "sløyd"',
        "total = 42",
        "def trailing():",
        "    return total",
      ].join("\n");

      const lines = highlightLines(pythonGrammar, source);

      expect(verbatim(lines)).toBe(source);
      expect(classesOf(lines, "42")).toEqual(["number"]);
      expect(classesOf(lines, "trailing")).toEqual(["functionName"]);
      expect(classesOf(lines, "return")).toEqual(["controlKeyword"]);
    });

    it("reports structure offsets and columns in code points", () => {
      const source = "# café 😀\nclass Ünicode:\n    pass\n";

      const [node] = parseDocument(pythonGrammar, source).structure;

      expect(source.slice(node.startOffset, node.endOffset)).toBe(
        "class Ünicode:\n    pass",
      );
      expect(source.slice(node.nameOffset!, node.nameOffset! + 7)).toBe(
        "Ünicode",
      );
      expect(node.startLine).toBe(1);
      expect(node.startCol).toBe(0);
    });

    it("keeps an edit past non-ASCII text aligned with a complete parse", () => {
      const before = "# café 😀 marker\nvalue = 1\nother = 2\n";
      const after = before.replace("other = 2", "other = 22");
      const highlighter = createHighlighter(pythonGrammar, before);

      const updated = highlighter.update(after);

      expect(verbatim(updated)).toBe(after);
      expect(updated.map((line) => line.spans)).toEqual(
        highlightLines(pythonGrammar, after).map((line) => line.spans),
      );
    });
  });

  describe("incremental coloring", () => {
    it("re-colors the lines below an edit that moves bracket nesting", () => {
      const before = [
        "value = call(",
        "    first,",
        "    second,",
        ")",
        "after = [1, 2]",
      ].join("\n");
      const after = before.replace("    first,", "    first(");
      const highlighter = createHighlighter(pythonGrammar, before);

      const updated = highlighter.update(after);

      expect(verbatim(updated)).toBe(after);
      expect(updated.map((line) => line.spans)).toEqual(
        highlightLines(pythonGrammar, after).map((line) => line.spans),
      );
    });

    it("colors the line a bare newline creates", () => {
      // Pressing Enter mid-line is the edit whose reach ends on a line the
      // document did not have until that keystroke.
      const before = [
        "import os",
        "",
        "class Store:",
        "    def add(self, item: str) -> None:",
        "        self.items.append(item)",
        "",
      ].join("\n");
      const highlighter = createHighlighter(pythonGrammar, before);

      for (const at of [19, 22, 40, 60]) {
        const after = before.slice(0, at) + "\n" + before.slice(at);
        const updated = createHighlighter(pythonGrammar, before).update(after);

        expect(verbatim(updated)).toBe(after);
        expect(updated).toEqual(highlightLines(pythonGrammar, after));
      }
      expect(verbatim(highlighter.lines)).toBe(before);
    });

    it("colors a line break put inside a type annotation", () => {
      const before = "def main(argv: list[str]) -> int:\n    return 0\n";
      const after = before.replace("list[str]", "list[str\n]");

      const updated = createHighlighter(pythonGrammar, before).update(after);

      expect(verbatim(updated)).toBe(after);
      expect(updated).toEqual(highlightLines(pythonGrammar, after));
    });

    it("returns the same lines when the text does not change", () => {
      const highlighter = createHighlighter(pythonGrammar, "x = 1\n");

      expect(highlighter.update("x = 1\n")).toBe(highlighter.lines);
    });
  });
});
