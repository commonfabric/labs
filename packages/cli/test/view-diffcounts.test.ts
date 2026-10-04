/** Tests the three line-count policies used by the diff jump list. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type DiffCountFileContext,
  diffCounts,
} from "../lib/view/diffcounts.ts";
import { parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffFileLanguages,
} from "../lib/view/diffdoc.ts";
import { languageForFile } from "../lib/view/languages/language.ts";

function contextLines(path: string, lines: readonly string[]) {
  return languageForFile(path).highlightLines(lines.join("\n"), path);
}

/** Both sides of a file read in the language its path selects. */
function sideLanguages(path: string): DiffFileLanguages {
  return {
    oldLanguage: languageForFile(path),
    newLanguage: languageForFile(path),
  };
}

/** Computes every count policy over one highlighted diff. */
function countsFor(
  text: string,
  contexts?: readonly DiffCountFileContext[],
) {
  const model = parseDiff(text)!;
  const { doc } = buildDiffDocument(text, model, {
    resolve: () => null,
    read: () => null,
  });
  return {
    normal: diffCounts(text, doc.lines, "normal", contexts),
    whitespace: diffCounts(text, doc.lines, "whitespace", contexts),
    comments: diffCounts(text, doc.lines, "comments", contexts),
  };
}

describe("diffcounts", () => {
  it("discounts whitespace-only pairs within each file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const value = 1; // same",
      "+const   value = 1; // same",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.normal.totals).toEqual({ adds: 1, dels: 1 });
    expect(counts.whitespace.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("discounts comment-only lines and comment-only edits", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-run(); // before",
      "-// removed explanation",
      "+run(); // after",
      "+  // replacement explanation",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.whitespace.totals).toEqual({ adds: 2, dels: 2 });
    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("ignores documentation comments without treating strings as comments", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-/** old documentation */",
      '-const url = "https://old.example";',
      "+/** new documentation */",
      '+const url = "https://new.example";',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("counts Markdown headings even though they share a display style", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-# Old heading",
      "+# New heading",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("recognizes comments in files that use plain-text highlighting", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1 +1 @@",
      "-fn main() {} // old comment",
      "+fn main() {} // new comment",
      "diff --git a/page.html b/page.html",
      "--- a/page.html",
      "+++ b/page.html",
      "@@ -1 +1 @@",
      "-<!-- old note -->",
      "+<!-- new note -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("recognizes fallback comment syntax across supported file families", () => {
    const cases = [
      ["style.css", "/* old */", "/* new */"],
      ["query.sql", "-- old", "-- new"],
      ["query-block.sql", "/* old */", "/* new */"],
      ["script.lua", "-- old", "-- new"],
      ["module-line.hs", "-- old", "-- new"],
      [
        "module-nested.hs",
        "{- outer {- inner -} old -}",
        "{- outer {- inner -} new -}",
      ],
      ["code.lisp", "; old", "; new"],
    ];
    const diff = cases.flatMap(([path, oldLine, newLine]) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      `-${oldLine}`,
      `+${newLine}`,
    ]).concat("").join("\n");

    expect(countsFor(diff).comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("does not treat an unquoted URL as a comment", () => {
    const diff = [
      "diff --git a/style.scss b/style.scss",
      "--- a/style.scss",
      "+++ b/style.scss",
      "@@ -1 +1 @@",
      "-background: url(https://old.example/image.png);",
      "+background: url(https://new.example/image.png);",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("uses highlighter decisions for languages it understands", () => {
    const diff = [
      "diff --git a/config.yaml b/config.yaml",
      "--- a/config.yaml",
      "+++ b/config.yaml",
      "@@ -1 +1 @@",
      "-value: foo#old",
      "+value: foo#new",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("tracks multiline fallback comments on each side of a hunk", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,3 +1,3 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "  */",
      "diff --git a/page.html b/page.html",
      "--- a/page.html",
      "+++ b/page.html",
      "@@ -1,3 +1,3 @@",
      " <!--",
      "-old note",
      "+new note",
      " -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("uses complete files when a comment opener precedes the first hunk", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -3 +3 @@",
      "- * old note",
      "+ * new note",
      "",
    ].join("\n");
    const counts = countsFor(diff, [{
      languages: sideLanguages("main.rs"),
      oldLines: contextLines("main.rs", [
        "/*",
        " * hidden note",
        " * old note",
        " */",
      ]),
      newLines: contextLines("main.rs", [
        "/*",
        " * hidden note",
        " * new note",
        " */",
      ]),
    }]);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("uses omitted file lines to resolve a multiline close", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "@@ -4 +4 @@",
      "-run_old();",
      "+run_new();",
      "",
    ].join("\n");
    const counts = countsFor(diff, [{
      languages: sideLanguages("main.rs"),
      oldLines: contextLines("main.rs", [
        "/*",
        " * old note",
        " */",
        "run_old();",
      ]),
      newLines: contextLines("main.rs", [
        "/*",
        " * new note",
        " */",
        "run_new();",
      ]),
    }]);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("uses omitted lines before interpreting later comment syntax", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "@@ -4,2 +4,2 @@",
      "-run_old();",
      "+run_new();",
      ' // say "hello */',
      "",
    ].join("\n");
    const counts = countsFor(diff, [{
      languages: sideLanguages("main.rs"),
      oldLines: contextLines("main.rs", [
        "/*",
        " * old note",
        " */",
        "run_old();",
        '// say "hello */',
      ]),
      newLines: contextLines("main.rs", [
        "/*",
        " * new note",
        " */",
        "run_new();",
        '// say "hello */',
      ]),
    }]);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("does not treat comments inside omitted Markdown code as syntax", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -4 +4 @@",
      "-old prose",
      "+new prose",
      "",
    ].join("\n");
    const counts = countsFor(diff, [{
      languages: sideLanguages("readme.md"),
      oldLines: contextLines("readme.md", [
        "```html",
        "<!-- literal example",
        "```",
        "old prose",
      ]),
      newLines: contextLines("readme.md", [
        "```html",
        "<!-- literal example",
        "```",
        "new prose",
      ]),
    }]);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("does not treat comments inside omitted indented Markdown as syntax", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -2 +2 @@",
      "-old prose",
      "+new prose",
      "",
    ].join("\n");
    const counts = countsFor(diff, [{
      languages: sideLanguages("readme.md"),
      oldLines: contextLines("readme.md", [
        "    <!-- literal example",
        "old prose",
      ]),
      newLines: contextLines("readme.md", [
        "    <!-- literal example",
        "new prose",
      ]),
    }]);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("tracks multiline fallback comments across diff hunks", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,3 +1,3 @@",
      " /*",
      "- * old nearby note",
      "+ * new nearby note",
      "  * unchanged note",
      "@@ -20,2 +20,2 @@",
      "- * old distant note",
      "+ * new distant note",
      "  */",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("does not carry fallback comments past an omitted close", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "@@ -20 +20 @@",
      "-run_old();",
      "+run_new();",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("carries fallback comments through contiguous hunks", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old first note",
      "+ * new first note",
      "@@ -3,2 +3,2 @@",
      "- * old second note",
      "+ * new second note",
      "  */",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("carries fallback comments through several diff gaps", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old first note",
      "+ * new first note",
      "@@ -20 +20 @@",
      "- * old second note",
      "+ * new second note",
      "@@ -40,2 +40,2 @@",
      "- * old third note",
      "+ * new third note",
      "  */",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("ignores quoted block closers after an omitted close", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "@@ -20,2 +20,2 @@",
      "-run_old();",
      "+run_new();",
      ' let marker = "*/";',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("recognizes a block close after an unmatched quote", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old first note",
      "+ * new first note",
      "@@ -20,2 +20,2 @@",
      "- * old second note",
      "+ * new second note",
      ' * say "hello */',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("ignores a block closer in a later line comment", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "@@ -20,2 +20,2 @@",
      "-run_old();",
      "+run_new();",
      ' // say "hello */',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("preserves comment markers inside Rust raw strings", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1 +1 @@",
      '-const TEXT: &str = r#"a " // old"#;',
      '+const TEXT: &str = r#"a " // new"#;',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("preserves hash operators in shell parameter expansions", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1 +1 @@",
      "-echo ${value#old}",
      "+echo ${value#new}",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("uses each side's comment syntax when a rename changes extensions", () => {
    const diff = [
      "diff --git a/main.rs b/main.ts",
      "--- a/main.rs",
      "+++ b/main.ts",
      "@@ -1 +1 @@",
      "-run(); // old Rust note",
      "+run(); // new TypeScript note",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("preserves HTML comment syntax inside Markdown code fences", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1,3 +1,3 @@",
      " ```text",
      "-<!-- old literal -->",
      "+<!-- new literal -->",
      " ```",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("ignores HTML comments after Markdown inline code", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-`same code` <!-- old note -->",
      "+`same code` <!-- new note -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("preserves HTML comment syntax inside indented Markdown code", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-    <!-- old literal -->",
      "+    <!-- new literal -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("preserves hash-prefixed data inside shell heredocs", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,3 +1,3 @@",
      " cat <<EOF",
      "-# old data",
      "+# new data",
      " EOF",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("tracks multiple shell heredocs in declaration order", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,5 +1,5 @@",
      " cat <<A <<B",
      " first body",
      " A",
      "-# old second body",
      "+# new second body",
      " B",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("carries shell heredocs through several diff gaps", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,2 +1,2 @@",
      " cat <<EOF",
      "-# old first body",
      "+# new first body",
      "@@ -20 +20 @@",
      "-# old second body",
      "+# new second body",
      "@@ -40,2 +40,2 @@",
      "-# old third body",
      "+# new third body",
      " EOF",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 3, dels: 3 });
  });

  it("does not carry shell heredocs past an omitted terminator", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,2 +1,2 @@",
      " cat <<EOF",
      "-old data",
      "+new data",
      "@@ -20 +20 @@",
      "-# old comment",
      "+# new comment",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("carries Rust raw strings through several diff gaps", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      ' let text = r#"',
      "-// old first data",
      "+// new first data",
      "@@ -20 +20 @@",
      "-// old second data",
      "+// new second data",
      "@@ -40,2 +40,2 @@",
      "-// old third data",
      "+// new third data",
      ' "#;',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 3, dels: 3 });
  });

  it("recognizes a raw-string close after a backslash", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      ' let text = r#"',
      "-// old first data",
      "+// new first data",
      "@@ -20,2 +20,2 @@",
      "-// old second data",
      "+// new second data",
      ' \\"#;',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 2, dels: 2 });
  });

  it("ignores raw-string closer text in a later ordinary string", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      ' let text = r#"',
      "-old raw data",
      "+new raw data",
      "@@ -20,2 +20,2 @@",
      "-// old comment",
      "+// new comment",
      ' let marker = "not a raw close: \\"#";',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("does not start shell heredocs from arithmetic shifts", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,2 +1,2 @@",
      " x=$((1 << count))",
      "-# old comment",
      "+# new comment",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("does not start shell heredocs from here-strings", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,2 +1,2 @@",
      " tr a b <<< word",
      "-# old comment",
      "+# new comment",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("starts shell heredocs from escaped delimiters", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,3 +1,3 @@",
      " cat <<\\EOF",
      "-# old data",
      "+# new data",
      " EOF",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("does not start shell heredocs from quoted operators", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,2 +1,2 @@",
      ' echo "example: <<EOF"',
      "-# old comment",
      "+# new comment",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("tracks nested block comments in Rust", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /* outer /* inner */",
      "-old outer */",
      "+new outer */",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("discounts moved code across files when comments are ignored", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +0,0 @@",
      "-moved();",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      "+ moved ( ) ; // relocated",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.whitespace.totals).toEqual({ adds: 1, dels: 1 });
    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
    expect(counts.comments.files).toEqual([
      { adds: 0, dels: 0 },
      { adds: 0, dels: 0 },
    ]);
  });
});
