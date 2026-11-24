import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import {
  bazelignoreLanguage,
  dockerignoreLanguage,
  gitignoreLanguage,
} from "../../../../../lib/view/languages/ignore/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Each span of one colored line, as its text and class. */
function spansOf(lines: readonly Line[], line = 0): [string, TokenClass][] {
  return lines[line].spans.map((span) => [span.text, span.cls]);
}

describe("ignoreLanguage", () => {
  it("selects each tool's ignore files by name", () => {
    expect(languageForFile(".gitignore").id).toBe("gitignore");
    expect(languageForFile("src/staff/reviewer/.gitignore").id).toBe(
      "gitignore",
    );
    expect(languageForFile(".denoignore").id).toBe("gitignore");
    expect(languageForFile(".worktreeinclude").id).toBe("gitignore");
    expect(languageForFile(".dockerignore").id).toBe("dockerignore");
    expect(languageForFile("scripts/Dockerfile.systemd.dockerignore").id)
      .toBe("dockerignore");
    expect(languageForFile(".containerignore").id).toBe("dockerignore");
    expect(languageForFile("Containerfile.build.containerignore").id).toBe(
      "dockerignore",
    );
    expect(languageForFile(".bazelignore").id).toBe("bazelignore");
    expect(languageForFile("gitignore").id).toBe("plain-text");
    expect(languageForFile("templates/Node.gitignore").id).toBe("plain-text");
    expect(languageForFile(".gitignore.bak").id).toBe("plain-text");
  });

  it("colors comments, negations, wildcards, separators, and literal names", () => {
    const source = [
      "# OpenTofu / Terraform",
      "*.tfstate.*",
      "!tofu/iam/.terraform.lock.hcl",
      "**/node_modules",
      "/memory-router/dist/",
      "crash.?.log",
    ].join("\n");
    const lines = gitignoreLanguage.highlightLines(source);

    expect(spansOf(lines, 0)).toEqual([["# OpenTofu / Terraform", "comment"]]);
    expect(spansOf(lines, 1)).toEqual([
      ["*", "regex"],
      [".tfstate.", "string"],
      ["*", "regex"],
    ]);
    expect(spansOf(lines, 2)).toEqual([
      ["!", "operator"],
      ["tofu", "string"],
      ["/", "punctuation"],
      ["iam", "string"],
      ["/", "punctuation"],
      [".terraform.lock.hcl", "string"],
    ]);
    expect(spansOf(lines, 3)).toEqual([
      ["**", "regex"],
      ["/", "punctuation"],
      ["node_modules", "string"],
    ]);
    expect(spansOf(lines, 4)[0]).toEqual(["/", "punctuation"]);
    expect(spansOf(lines, 5)).toEqual([
      ["crash.", "string"],
      ["?", "regex"],
      [".log", "string"],
    ]);
    expect(verbatim(lines)).toBe(source);
  });

  it("colors a bracket expression through the first `]` after its first member", () => {
    const lines = gitignoreLanguage.highlightLines(
      "*.py[co]\n[!]x]y\n[^a-z]\n[]]\nopen[ab",
    );

    expect(spansOf(lines, 0)).toEqual([
      ["*", "regex"],
      [".py", "string"],
      ["[co]", "regex"],
    ]);
    expect(spansOf(lines, 1)).toEqual([["[!]x]", "regex"], ["y", "string"]]);
    expect(spansOf(lines, 2)).toEqual([["[^a-z]", "regex"]]);
    expect(spansOf(lines, 3)).toEqual([["[]]", "regex"]]);
    expect(spansOf(lines, 4)).toEqual([["open[ab", "string"]]);
  });

  it("closes a bracket expression past an escaped `]` and a `[:name:]` class", () => {
    const lines = gitignoreLanguage.highlightLines(
      "a[\\]]b\n[[:space:]]x\n[[:a]x\n[[:]x",
    );

    expect(spansOf(lines, 0)).toEqual([
      ["a", "string"],
      ["[\\]]", "regex"],
      ["b", "string"],
    ]);
    expect(spansOf(lines, 1)).toEqual([["[[:space:]]", "regex"], [
      "x",
      "string",
    ]]);
    // A `[:` whose first `]` does not follow a `:` opens no class, so that
    // `]` closes the expression.
    expect(spansOf(lines, 2)).toEqual([["[[:a]", "regex"], ["x", "string"]]);
    expect(spansOf(lines, 3)).toEqual([["[[:]", "regex"], ["x", "string"]]);

    // A class name the tool does not know makes the expression invalid.
    expect(spansOf(gitignoreLanguage.highlightLines("*[[:foo:]]x"))).toEqual([
      ["*", "regex"],
      ["[[:foo:]]x", "string"],
    ]);
    expect(spansOf(gitignoreLanguage.highlightLines("[[:word:]]"))).toEqual([
      ["[[:word:]]", "string"],
    ]);
    expect(spansOf(dockerignoreLanguage.highlightLines("[[:word:]]"))).toEqual(
      [["[[:word:]]", "regex"]],
    );

    // A `[` or an escaped `]` that ends a range is a character, not the
    // start of a class or the end of the expression.
    const ranges = gitignoreLanguage.highlightLines("[a-[:x:]]\n[a-\\]]");
    expect(spansOf(ranges, 0)).toEqual([["[a-[:x:]", "regex"], [
      "]",
      "string",
    ]]);
    expect(spansOf(ranges, 1)).toEqual([["[a-\\]]", "regex"]]);
  });

  it("colors as literal every `[` from one that no `]` closes, which makes Git match nothing", () => {
    // The class name `[:a:]` uses the line's only `]`, so the first `[` is
    // unclosed, and the second is literal although a `]` follows it.
    const lines = gitignoreLanguage.highlightLines("*[[:a:]\n[[:x");

    expect(spansOf(lines, 0)).toEqual([["*", "regex"], ["[[:a:]", "string"]]);
    expect(spansOf(lines, 1)).toEqual([["[[:x", "string"]]);
  });

  it("colors a megabyte of unclosed brackets, each on its own line", () => {
    // Searching past each line for a `]` would take time proportional to the
    // square of the input's size, which no test run could wait for.
    const source = "[\n".repeat(500_000) + "]";
    const lines = gitignoreLanguage.highlightLines(source);

    expect(lines.length).toBe(500_001);
    expect(new Set(lines.slice(0, -1).map((line) => line.spans[0].cls)))
      .toEqual(new Set(["string"]));
    expect(spansOf(lines, 500_000)).toEqual([["]", "string"]]);
  });

  it("reads `#` and `!` as literal after a backslash or anywhere but the first column", () => {
    const lines = gitignoreLanguage.highlightLines(
      "\\#notes\n\\!keep\na\\*b\n  # indented\nwhy!",
    );

    expect(spansOf(lines, 0)).toEqual([
      ["\\", "punctuation"],
      ["#notes", "string"],
    ]);
    expect(spansOf(lines, 1)).toEqual([
      ["\\", "punctuation"],
      ["!keep", "string"],
    ]);
    expect(spansOf(lines, 2)).toEqual([
      ["a", "string"],
      ["\\", "punctuation"],
      ["*b", "string"],
    ]);
    expect(spansOf(lines, 3)).toEqual([
      ["  # indented", "string"],
    ]);
    expect(spansOf(lines, 4)).toEqual([["why!", "string"]]);
  });

  it("leaves Git's unescaped trailing spaces out of a pattern", () => {
    const lines = gitignoreLanguage.highlightLines("a  \nb\\  \nc\t\nd\\\\ ");

    expect(spansOf(lines, 0)).toEqual([["a", "string"], ["  ", "whitespace"]]);
    expect(spansOf(lines, 1)).toEqual([
      ["b", "string"],
      ["\\", "punctuation"],
      [" ", "string"],
      [" ", "whitespace"],
    ]);
    expect(spansOf(lines, 2)).toEqual([["c\t", "string"]]);
    expect(spansOf(lines, 3)).toEqual([
      ["d", "string"],
      ["\\", "punctuation"],
      ["\\", "string"],
      [" ", "whitespace"],
    ]);
  });

  it("trims white space around a Docker pattern and after its `!`", () => {
    const source = "  ! src/*.rs  \n  # not a comment\n# a comment\nb\\  ";
    const lines = dockerignoreLanguage.highlightLines(source);

    expect(spansOf(lines, 0)).toEqual([
      ["  ", "whitespace"],
      ["!", "operator"],
      [" ", "whitespace"],
      ["src", "string"],
      ["/", "punctuation"],
      ["*", "regex"],
      [".rs", "string"],
      ["  ", "whitespace"],
    ]);
    expect(spansOf(lines, 1)).toEqual([
      ["  ", "whitespace"],
      ["# not a comment", "string"],
    ]);
    expect(spansOf(lines, 2)).toEqual([["# a comment", "comment"]]);
    // Docker's trimming leaves a backslash with nothing to escape, which Go
    // rejects, so it is literal.
    expect(spansOf(lines, 3)).toEqual([
      ["b\\", "string"],
      ["  ", "whitespace"],
    ]);
    expect(verbatim(lines)).toBe(source);

    // Docker trims the white space Go does, which includes U+0085 and not
    // U+FEFF.
    expect(spansOf(dockerignoreLanguage.highlightLines("\u0085a\u0085")))
      .toEqual([
        ["\u0085", "whitespace"],
        ["a", "string"],
        ["\u0085", "whitespace"],
      ]);
    expect(spansOf(dockerignoreLanguage.highlightLines("a\ufeff"))).toEqual([
      ["a\ufeff", "string"],
    ]);

    // Git keeps the white space before a pattern, and reads `!` as negation
    // only in the first column.
    expect(spansOf(gitignoreLanguage.highlightLines("  ! src"))).toEqual([
      ["  ! src", "string"],
    ]);
  });

  it("reads a Docker bracket expression as Go's `filepath.Match` does", () => {
    const lines = dockerignoreLanguage.highlightLines(
      "[!]x]\n[^a-c]\n[^]x]\n[-a]\n[a-]\n[a-b-c]\n[\\]]",
    );

    // Only `^` negates, and a `]` or `-` where a member starts is invalid.
    expect(spansOf(lines, 0)).toEqual([["[!]", "regex"], ["x]", "string"]]);
    expect(spansOf(lines, 1)).toEqual([["[^a-c]", "regex"]]);
    expect(spansOf(lines, 2)).toEqual([["[^]x]", "string"]]);
    expect(spansOf(lines, 3)).toEqual([["[-a]", "string"]]);
    expect(spansOf(lines, 4)).toEqual([["[a-]", "string"]]);
    expect(spansOf(lines, 5)).toEqual([["[a-b-c]", "string"]]);
    expect(spansOf(lines, 6)).toEqual([["[\\]]", "regex"]]);

    // Git reads each of those as one expression.
    const git = gitignoreLanguage.highlightLines("[^]x]\n[-a]\n[a-]\n[a-b-c]");
    for (let line = 0; line < 4; line++) {
      expect(spansOf(git, line).map(([, cls]) => cls)).toEqual(["regex"]);
    }
  });

  it("reads each Bazel line other than a comment as a literal path", () => {
    const source = "# Symlinks\nbazel-*\n!bazel-out/\n  # spaced\n";
    const lines = bazelignoreLanguage.highlightLines(source);

    expect(spansOf(lines, 0)).toEqual([["# Symlinks", "comment"]]);
    expect(spansOf(lines, 1)).toEqual([["bazel-*", "string"]]);
    expect(spansOf(lines, 2)).toEqual([
      ["!bazel-out", "string"],
      ["/", "punctuation"],
    ]);
    expect(spansOf(lines, 3)).toEqual([["  # spaced", "string"]]);
    expect(lines[4].spans).toEqual([]);
    expect(verbatim(lines)).toBe(source);
  });

  it("ends a Bazel line at a carriage return that no line feed follows", () => {
    const source = "out\r# note\rkeep";

    expect(spansOf(bazelignoreLanguage.highlightLines(source))).toEqual([
      ["out", "string"],
      ["\r", "whitespace"],
      ["# note", "comment"],
      ["\r", "whitespace"],
      ["keep", "string"],
    ]);
    expect(spansOf(gitignoreLanguage.highlightLines(source))).toEqual([
      ["out\r# note\rkeep", "string"],
    ]);
  });

  it("leaves a carriage return before a line feed out of every pattern", () => {
    for (
      const language of [
        gitignoreLanguage,
        dockerignoreLanguage,
        bazelignoreLanguage,
      ]
    ) {
      const source = "# note\r\nbuild/\r\n";
      const lines = language.highlightLines(source);

      expect(spansOf(lines, 0)).toEqual([
        ["# note", "comment"],
        ["\r", "whitespace"],
      ]);
      expect(spansOf(lines, 1)).toEqual([
        ["build", "string"],
        ["/", "punctuation"],
        ["\r", "whitespace"],
      ]);
      expect(verbatim(lines)).toBe(source);
    }
  });

  it("gives a document no structure or definitions", () => {
    const source = "# Build output\ndist/\n!dist/keep";
    const document = gitignoreLanguage.parseDocument(source);

    expect(document.text).toBe(source);
    expect(verbatim(document.lines)).toBe(source);
    expect(document.structure).toEqual([]);
    expect(document.flatStructure).toEqual([]);
    expect(document.definitions.size).toBe(0);
    expect(dockerignoreLanguage.parseDocument("**").lines[0].spans).toEqual([
      { col: 0, text: "**", cls: "regex" },
    ]);
    expect(bazelignoreLanguage.parseDocument("out").lines[0].spans).toEqual([
      { col: 0, text: "out", cls: "string" },
    ]);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of ["!", "\\", "[", "[!", "a[]", "*\\", "#", "", "☕ 😀/"]
    ) {
      for (
        const language of [
          gitignoreLanguage,
          dockerignoreLanguage,
          bazelignoreLanguage,
        ]
      ) {
        expect(verbatim(language.parseDocument(source).lines)).toBe(source);
      }
    }
  });

  it("recolors each edit", () => {
    const highlighter = gitignoreLanguage.createHighlighter("dist");
    expect(highlighter.update("dist")).toBe(highlighter.lines);
    expect(spansOf(highlighter.update("#dist"))).toEqual([[
      "#dist",
      "comment",
    ]]);
  });
});
