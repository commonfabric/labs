import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import {
  csvLanguage,
  datLanguage,
  tsvLanguage,
} from "../../../../../lib/view/languages/table/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Each colored line as its spans' text and class, without white space. */
function tokens(lines: readonly Line[]): [string, TokenClass][][] {
  return lines.map((line) =>
    line.spans.filter((span) => span.cls !== "whitespace").map((
      span,
    ) => [span.text, span.cls])
  );
}

describe("tableLanguage", () => {
  describe("selection", () => {
    it("selects comma- and tab-separated values by extension", () => {
      expect(languageForFile("website/performance/redis.csv").id).toBe("csv");
      expect(languageForFile("EXPORT.CSV").id).toBe("csv");
      expect(languageForFile("docs-reorg/map.tsv").id).toBe("tsv");
      expect(languageForFile("names.tab").id).toBe("plain-text");
    });

    it("selects a `.dat` file only when its source is a numeric table", () => {
      expect(languageForSource("paper/pool.dat", "budget breadth\n0 3.37\n").id)
        .toBe("dat");
      expect(languageForSource("paper/pool.dat", "0.25 4.44\n").id).toBe("dat");
      expect(
        languageForSource(
          "paper/pool.dat",
          "# sweep\n\n% from the model\nk survival\n1 -1.5e-3\r\n2 .5",
        ).id,
      ).toBe("dat");
      expect(languageForSource("paper/pool.dat", "  \r\n# c\r\n1 2\r\n").id)
        .toBe("dat");
      expect(
        languageForSource("paper/pool.dat", "# c\r\nk n\r\n\r\n# c\r\n1 2").id,
      ).toBe("dat");

      expect(languageForFile("paper/pool.dat").id).toBe("plain-text");
      expect(languageForSource("game/save.dat", "level one\nscore high\n").id)
        .toBe("plain-text");
      expect(languageForSource("game/save.dat", "a\nb\n1 2\n").id).toBe(
        "plain-text",
      );
      expect(languageForSource("game/save.dat", "1 2 three\n").id).toBe(
        "plain-text",
      );
      expect(languageForSource("run/daemon.dat", "4127\n").id).toBe(
        "plain-text",
      );
      expect(languageForSource("game/save.dat", "Title\n2024\n").id).toBe(
        "plain-text",
      );
    });

    it("selects from megabytes of blank lines, comments, and numbers", () => {
      const blank = "\n".repeat(4_000_000);
      const comments = "# note\n".repeat(1_000_000);
      expect(languageForSource("a.dat", `${blank}x y\n${comments}z\n`).id)
        .toBe("plain-text");
      expect(languageForSource("a.dat", `${comments}x y\n${blank}1 2\n`).id)
        .toBe("dat");
      expect(languageForSource("a.dat", "1 ".repeat(2_500_000) + "\n").id)
        .toBe("dat");
    });

    it("reads the evidence as the `.dat` dialect reads its lines", () => {
      expect(languageForSource("a.dat", "\u00a0\n1 2\n").id).toBe("dat");
      expect(languageForSource("a.dat", "\u00a0\nk v\n1 2\n").id).toBe(
        "plain-text",
      );
      expect(languageForSource("a.dat", "1 2 # note\n").id).toBe("plain-text");
      expect(languageForSource("a.dat", "1 2\nk v\n").id).toBe("dat");
    });
  });

  describe("csvLanguage", () => {
    it("colors separators, numbers, and other fields", () => {
      const lines = csvLanguage.highlightLines(
        "runtime,metric,result\nrunc,latency, -11.0e2 \n,,\nb/339,1.2.3,4x\n" +
          ".,-,1e,1e+,+.5",
      );

      expect(tokens(lines)).toEqual([
        [
          ["runtime", "string"],
          [",", "punctuation"],
          ["metric", "string"],
          [",", "punctuation"],
          ["result", "string"],
        ],
        [
          ["runc", "string"],
          [",", "punctuation"],
          ["latency", "string"],
          [",", "punctuation"],
          ["-11.0e2", "number"],
        ],
        [[",,", "punctuation"]],
        [
          ["b/339", "string"],
          [",", "punctuation"],
          ["1.2.3", "string"],
          [",", "punctuation"],
          ["4x", "string"],
        ],
        [
          [".", "string"],
          [",", "punctuation"],
          ["-", "string"],
          [",", "punctuation"],
          ["1e", "string"],
          [",", "punctuation"],
          ["1e+", "string"],
          [",", "punctuation"],
          ["+.5", "number"],
        ],
      ]);
    });

    it("reads a quoted field across separators, doubled quotes, and line breaks", () => {
      const source = 'a,"up 2:44, 13 users","say ""hi""",7\n' +
        '"one\ntwo",3\n"12",x"y",""';
      const lines = csvLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [
          ["a", "string"],
          [",", "punctuation"],
          ['"up 2:44, 13 users"', "string"],
          [",", "punctuation"],
          ['"say ""hi"""', "string"],
          [",", "punctuation"],
          ["7", "number"],
        ],
        [['"one', "string"]],
        [['two"', "string"], [",", "punctuation"], ["3", "number"]],
        [
          ['"12"', "string"],
          [",", "punctuation"],
          ['x"y"', "string"],
          [",", "punctuation"],
          ['""', "string"],
        ],
      ]);
      expect(verbatim(lines)).toBe(source);
    });

    it("reads a Windows line ending inside a quoted field as part of it", () => {
      const source = '"a\r\nb",1\r\n"c"\r\n2';
      const lines = csvLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [['"a\r', "string"]],
        [['b"', "string"], [",", "punctuation"], ["1", "number"]],
        [['"c"', "string"]],
        [["2", "number"]],
      ]);
      expect(verbatim(lines)).toBe(source);
    });

    it("keeps text after a closing quote in its field", () => {
      expect(tokens(csvLanguage.highlightLines('"a"b,c'))).toEqual([[
        ['"a"b', "string"],
        [",", "punctuation"],
        ["c", "string"],
      ]]);
    });

    it("colors the rest of the source as one field after an unclosed quote", () => {
      const source = 'a,"open\nb,1';
      const lines = csvLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [["a", "string"], [",", "punctuation"], ['"open', "string"]],
        [["b,1", "string"]],
      ]);
      expect(verbatim(lines)).toBe(source);
    });

    it("ends a field before the carriage return of a Windows line ending", () => {
      const source = "x,1\r\n\r\ny,2\r\n3\r";
      const lines = csvLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [["x", "string"], [",", "punctuation"], ["1", "number"]],
        [],
        [["y", "string"], [",", "punctuation"], ["2", "number"]],
        [["3", "number"]],
      ]);
      expect(verbatim(lines)).toBe(source);
    });

    it("reads `#` as data rather than a comment", () => {
      expect(tokens(csvLanguage.highlightLines("# a,1"))).toEqual([[
        ["# a", "string"],
        [",", "punctuation"],
        ["1", "number"],
      ]]);
    });

    it("re-colors the whole file on a diff edit, since quotes span lines", () => {
      expect(csvLanguage.highlightFullFileOnDiffEdit).toBe(true);
      expect(csvLanguage.commentLinesAreInert).toBe(false);
    });
  });

  describe("tsvLanguage", () => {
    it("colors comment lines, numbers, and other fields", () => {
      // A tab is white space however it is classed, so it is not shown here.

      const source =
        '# name<TAB>percent\nMARY ANN\t2.629\n\t# second\n"q"\t1,5';
      const lines = tsvLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [["# name<TAB>percent", "comment"]],
        [["MARY ANN", "string"], ["2.629", "number"]],
        [["# second", "string"]],
        [['"q"', "string"], ["1,5", "string"]],
      ]);
      expect(verbatim(lines)).toBe(source);
    });

    it("colors empty fields and fields of spaces as no number", () => {
      const source = "a\t\t5\t  \t" + "\t ".repeat(50_000) + "\t7";
      const lines = tsvLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([[
        ["a", "string"],
        ["5", "number"],
        ["7", "number"],
      ]]);
    });

    it("re-colors only edited lines on a diff edit, and counts lines that start with `#` in diffs", () => {
      expect(tsvLanguage.highlightFullFileOnDiffEdit).toBe(false);
      expect(tsvLanguage.commentLinesAreInert).toBe(false);
    });
  });

  describe("datLanguage", () => {
    it("treats comment lines as inert in diffs", () => {
      expect(datLanguage.commentLinesAreInert).toBe(true);
    });

    it("colors comment lines, numbers, and other fields separated by spaces and tabs", () => {
      const source =
        "  # sweep\n% model\nmarkup\tbreadth  sd\n  0.0500 4.4451\t-1e-3 \nn/a\n\n";
      const lines = datLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [["# sweep", "comment"]],
        [["% model", "comment"]],
        [["markup", "string"], ["breadth", "string"], ["sd", "string"]],
        [["0.0500", "number"], ["4.4451", "number"], ["-1e-3", "number"]],
        [["n/a", "string"]],
        [],
        [],
      ]);
      expect(verbatim(lines)).toBe(source);
    });

    it("reads a quote as part of a field", () => {
      expect(tokens(datLanguage.highlightLines('"a b" 1'))).toEqual([[
        ['"a', "string"],
        ['b"', "string"],
        ["1", "number"],
      ]]);
    });

    it("ends the last field before trailing space and a carriage return", () => {
      const source = "1 2 \r\n3 x\t ";
      const lines = datLanguage.highlightLines(source);

      expect(tokens(lines)).toEqual([
        [["1", "number"], ["2", "number"]],
        [["3", "number"], ["x", "string"]],
      ]);
      expect(verbatim(lines)).toBe(source);
    });
  });

  it("gives a table no structure tree or definitions", () => {
    for (const language of [csvLanguage, tsvLanguage, datLanguage]) {
      const document = language.parseDocument("a,b\tc d\n1,2\t3 4");

      expect(document.structure).toEqual([]);
      expect(document.flatStructure).toEqual([]);
      expect(document.definitions.size).toBe(0);
      expect(verbatim(document.lines)).toBe(document.text);
    }
  });

  it("reconstructs incomplete input exactly", () => {
    for (const language of [csvLanguage, tsvLanguage, datLanguage]) {
      for (const source of ['"', 'a,"', ",", "\t", " ", "#", "%", "\n", ""]) {
        expect(verbatim(language.parseDocument(source).lines)).toBe(source);
      }
    }
  });

  it("re-colors each edit", () => {
    const highlighter = csvLanguage.createHighlighter("a,1");
    expect(highlighter.update("a,1")).toBe(highlighter.lines);
    expect(tokens(highlighter.update("a,b"))).toEqual([[
      ["a", "string"],
      [",", "punctuation"],
      ["b", "string"],
    ]]);
  });
});
