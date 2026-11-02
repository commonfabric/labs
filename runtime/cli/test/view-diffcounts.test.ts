/** Tests the three line-count policies used by the diff jump list. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  commentOnlyFiles,
  type DiffCountFileContext,
  diffCounts,
} from "../lib/view/diffcounts.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { gitBlobName } from "./view-helpers.ts";
import {
  buildDiffDocument,
  type DiffFileLanguages,
} from "../lib/view/diffdoc.ts";
import {
  languageForFile,
  prepareLanguages,
} from "../lib/view/languages/language.ts";

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

interface Side {
  readonly path: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly header?: readonly string[];
}

/**
 * Decides each file of a diff that replaces every line of `before` with
 * `after`, judged with both complete sides in view.
 */
async function commentOnly(...files: Side[]): Promise<boolean[]> {
  const languages = files.map((file) => languageForFile(file.path));
  await prepareLanguages(languages);
  const diff = files.flatMap(({ path, before, after, header }) => [
    `diff --git a/${path} b/${path}`,
    ...(header ?? []),
    `index ${gitBlobName([...before, ""].join("\n"))}..${
      gitBlobName([...after, ""].join("\n"))
    }`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ]);
  return commentOnlyFiles(
    [...diff, ""].join("\n"),
    files.map(({ path, before, after }) => ({
      languages: sideLanguages(path),
      oldLines: contextLines(path, [...before, ""]),
      newLines: contextLines(path, [...after, ""]),
    })),
  );
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

  describe("commentOnlyFiles", () => {
    it("returns true for files whose changes touch only comments", async () => {
      expect(
        await commentOnly(
          {
            path: "comments.ts",
            before: ["// old explanation", "run();", "check(); // before"],
            after: [
              "// new explanation",
              "  /* added */  ",
              "run();",
              "check(); // after",
            ],
          },
          {
            path: "trailing.ts",
            before: ["go(); // x"],
            after: ["go(); // longer"],
          },
          {
            path: "inline.ts",
            before: ["call(/* a */ b);"],
            after: ["call(/* longer */ b);"],
          },
          {
            path: "script.sh",
            before: ["# old note", "run  # why"],
            after: ["# new note", "run  # because"],
          },
          {
            path: "config.toml",
            before: ["# a", "key = 1"],
            after: ["# b", "# c", "key = 1"],
          },
          {
            path: "tool.py",
            before: ["# a", "x = 1"],
            after: ["# b", "x = 1"],
          },
          {
            path: "layout.xml",
            before: ["<!-- a -->", "<a>x<!-- b -->y</a>"],
            after: ["<!-- c -->", "<a>x<!-- d -->y</a>"],
          },
        ),
      ).toEqual([true, true, true, true, true, true, true]);
    });

    it("returns false for files whose changes alter code or whitespace", async () => {
      expect(
        await commentOnly(
          {
            path: "edited.ts",
            before: ["run(1); // same"],
            after: ["run(2); // same"],
          },
          {
            path: "swapped.ts",
            before: ["first();", "second();"],
            after: ["second();", "first();"],
          },
          { path: "glued.ts", before: ["return/**/x;"], after: ["returnx;"] },
          { path: "spaced.ts", before: ["f(/**/x);"], after: ["f( x);"] },
          { path: "added.ts", before: ["go();"], after: ["go(); // why"] },
          { path: "nul.ts", before: ["a(/**/);"], after: ["a(\0);"] },
          { path: "crlf.ts", before: ["x(); // a\r"], after: ["x(); // a"] },
          { path: "value.mk", before: ["X = a # c"], after: ["X = a"] },
          {
            path: "text.plist",
            before: ["<string>a", "<!-- note -->", "b</string>"],
            after: ["<string>a", "b</string>"],
          },
          {
            path: "text.xml",
            before: ["<a>x<!-- c -->y</a>"],
            after: ["<a>x y</a>"],
          },
          {
            path: "blank.ts",
            before: ["a();", "b();"],
            after: ["a();", "", "b();"],
          },
          { path: "trailing.ts", before: ["go();"], after: ["go();  "] },
          { path: "line-end.sh", before: ["run"], after: ["run\r"] },
          {
            path: "indent.py",
            before: ["if ready:", "    go()"],
            after: ["if ready:", "go()"],
          },
        ),
      ).toEqual(Array(14).fill(false));
    });

    it("returns false when whitespace changes inside a multiline literal", async () => {
      expect(
        await commentOnly(
          {
            path: "blank.ts",
            before: ["const s = `", "a", "b", "`;"],
            after: ["const s = `", "a", "", "b", "`;"],
          },
          {
            path: "spaces.ts",
            before: ["const s = `", "a", "`;"],
            after: ["const s = `", "a  ", "`;"],
          },
          {
            path: "block.yaml",
            before: ["k: |", "  a", "  b"],
            after: ["k: |", "", "  a", "  b"],
          },
          {
            path: "heredoc.sh",
            before: ["cat <<EOF", "a", "$HOME", "EOF"],
            after: ["cat <<EOF", "a", "", "$HOME", "EOF"],
          },
        ),
      ).toEqual([false, false, false, false]);
    });

    it("returns false when a comment follows a line continuation", async () => {
      expect(
        await commentOnly(
          {
            path: "continued.sh",
            before: ["echo a \\", "  b"],
            after: ["echo a \\", "# note", "  b"],
          },
          {
            path: "continued.py",
            before: ["x = 1 + \\", "  2"],
            after: ["x = 1 + \\", "# note", "  2"],
          },
          {
            path: "crlf.py",
            before: ["x = 1 + \\\r", "  2\r"],
            after: ["x = 1 + \\\r", "# note\r", "  2\r"],
          },
          {
            path: "argument.sh",
            before: ["cmd --a=\\", "#b"],
            after: ["cmd --a=\\", "#c"],
          },
        ),
      ).toEqual([false, false, false, false]);
    });

    it("returns false when comment markers change what unchanged lines are", async () => {
      expect(
        await commentOnly(
          {
            path: "commented.ts",
            before: ["foo();"],
            after: ["/*", "foo();", "*/"],
          },
          {
            path: "uncommented.ts",
            before: ["/*", "foo();", "*/"],
            after: ["foo();"],
          },
          {
            path: "template.ts",
            before: ["const glob = `", "src/*.ts", "`;", "run(1);"],
            after: ["const glob = `", "src/*.ts", "`;", "run(2);"],
          },
        ),
      ).toEqual([false, false, false]);
    });

    it("returns false when a comment line is content in the language", async () => {
      expect(
        await commentOnly(
          {
            path: "scalar.yaml",
            before: ["k: a", "  b"],
            after: ["k: a", "  # c", "  b"],
          },
          {
            path: "strict.json",
            before: ["{", '  "a": 1', "}"],
            after: ["{", "  // note", '  "a": 1', "}"],
          },
          {
            path: "edited.yaml",
            before: ["# a", "k: 1"],
            after: ["# b", "k: 1"],
          },
        ),
      ).toEqual([false, false, true]);
    });

    it("returns false for languages whose highlighting marks no comments", async () => {
      expect(
        await commentOnly(
          { path: "README.md", before: ["<!-- a -->"], after: ["<!-- b -->"] },
          { path: "main.go", before: ["// a"], after: ["// b"] },
        ),
      ).toEqual([false, false]);
    });

    it("returns false for files whose headers record more than a content change", async () => {
      expect(
        await commentOnly(
          {
            path: "run.sh",
            header: ["old mode 100644", "new mode 100755"],
            before: ["# a"],
            after: ["# b"],
          },
          {
            path: "created.ts",
            header: ["new file mode 100644"],
            before: ["// a"],
            after: ["// b"],
          },
          { path: "note.ts", before: ["// a"], after: ["// b"] },
        ),
      ).toEqual([false, false, true]);
    });

    it("returns false for renamed files and files without the diff's complete sides", () => {
      const index = `index ${gitBlobName("// a\n")}..${gitBlobName("// b\n")}`;
      const comment = ["@@ -1 +1 @@", "-// a", "+// b"];
      const renamed = [
        "diff --git a/before.ts b/after.ts",
        "similarity index 90%",
        "rename from before.ts",
        "rename to after.ts",
        index,
        "--- a/before.ts",
        "+++ b/after.ts",
        ...comment,
        "",
      ].join("\n");
      const plain = (header: string) =>
        [
          "diff --git a/a.ts b/a.ts",
          header,
          "--- a/a.ts",
          "+++ b/a.ts",
          ...comment,
          "",
        ].join("\n");
      const sides = {
        languages: sideLanguages("a.ts"),
        oldLines: contextLines("a.ts", ["// a", ""]),
        newLines: contextLines("a.ts", ["// b", ""]),
      };

      expect(commentOnlyFiles(renamed, [sides])).toEqual([false]);
      expect(commentOnlyFiles(plain(index), [])).toEqual([false]);
      expect(commentOnlyFiles(plain(index), [{ languages: sides.languages }]))
        .toEqual([false]);
      expect(commentOnlyFiles(plain("index 1234567..89abcde"), [sides]))
        .toEqual([false]);
      expect(commentOnlyFiles(plain(index), [sides])).toEqual([true]);
      // Highlighting whose spans leave part of a line out.
      expect(commentOnlyFiles(plain(index), [{
        ...sides,
        oldLines: [{ text: "// a", spans: [] }, { text: "", spans: [] }],
      }])).toEqual([false]);
    });

    it("returns false when the hunks leave out part of the change", () => {
      // As `git diff -w` writes it: the reindented line is not in the hunk.
      const before = ["# c1", "if x:", "    a()", "b()", ""];
      const after = ["# c2", "if x:", "    a()", "    b()", ""];
      const diff = [
        "diff --git a/w.py b/w.py",
        `index ${gitBlobName(before.join("\n"))}..${
          gitBlobName(after.join("\n"))
        } 100644`,
        "--- a/w.py",
        "+++ b/w.py",
        "@@ -1,2 +1,2 @@",
        "-# c1",
        "+# c2",
        " if x:",
        "",
      ].join("\n");
      const rebuilt = ["# c2", "if x:", "    a()", "b()", ""];

      expect(commentOnlyFiles(diff, [{
        languages: sideLanguages("w.py"),
        oldLines: contextLines("w.py", before),
        newLines: contextLines("w.py", rebuilt),
      }])).toEqual([false]);
    });

    it("compares the byte order marks of the two sides", () => {
      // The complete sides hold their text without the mark.
      const diff = (before: string, after: string) =>
        [
          "diff --git a/a.ts b/a.ts",
          `index ${gitBlobName(`${before}\n`)}..${gitBlobName(`${after}\n`)}`,
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          `-${before}`,
          `+${after}`,
          "",
        ].join("\n");
      const context = (before: string, after: string) => [{
        languages: sideLanguages("a.ts"),
        oldLines: contextLines("a.ts", [before.replace("\uFEFF", ""), ""]),
        newLines: contextLines("a.ts", [after.replace("\uFEFF", ""), ""]),
      }];
      const both = ["\uFEFFrun(); // a", "\uFEFFrun(); // b"] as const;
      const removed = ["\uFEFFrun(); // a", "run(); // a"] as const;

      expect(commentOnlyFiles(diff(...both), context(...both))).toEqual([true]);
      expect(commentOnlyFiles(diff(...removed), context(...removed)))
        .toEqual([false]);
    });
  });
});
