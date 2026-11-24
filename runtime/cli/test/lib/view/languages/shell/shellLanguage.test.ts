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
import { shellLanguage } from "../../../../../lib/view/languages/shell/language.ts";
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

function highlight(source: string): Line[] {
  return shellLanguage.highlightLines(source);
}

describe("shellLanguage", () => {
  beforeAll(() => shellLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries shell's representative filenames,
    // hooks, and shebangs; these cases are the ones it does not.

    it("selects shell scripts in any case", () => {
      for (const path of ["/tmp/RUN.SH", "lib/Completion.Bash", "Go.command"]) {
        expect(languageForFile(path).id).toBe("shell");
      }
    });

    it("leaves other shells and similar names to other languages", () => {
      for (const path of ["init.zsh", "config.fish", "page.shtml", "run.ksh"]) {
        expect(languageForFile(path).id).not.toBe("shell");
      }
      for (const interpreter of ["zsh", "fish", "ksh", "shellcheck"]) {
        expect(
          languageForSource("run", `#!/usr/bin/env ${interpreter}\necho 1\n`)
            .id,
        ).not.toBe("shell");
      }
    });
  });

  describe("highlighting", () => {
    it("colors commands, declarations, keywords, and variables", () => {
      const lines = highlight([
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'readonly ROOT="$(git rev-parse --show-toplevel)" # the checkout',
        "local -a names=(one 2)",
        "deploy() {",
        '  if [[ -n "${1:-}" && $2 =~ ^v[0-9]+$ ]]; then return 1; fi',
        "  for ((i = 0; i < 3; i++)); do continue; done",
        "  unset names",
        "}",
        "export PATH",
      ].join("\n"));

      expect(classesOf(lines, "#!/usr/bin/env bash")).toEqual(["comment"]);
      expect(classesOf(lines, "# the checkout")).toEqual(["comment"]);
      expect(classesOf(lines, "set")).toEqual(["callName"]);
      expect(classesOf(lines, "git")).toEqual(["callName"]);
      expect(classesOf(lines, "deploy")).toEqual(["functionName"]);
      expect(classesOf(lines, "readonly")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "local")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "export")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "unset")).toEqual(["keyword"]);
      for (const keyword of ["if", "then", "fi", "for", "do", "done"]) {
        expect(classesOf(lines, keyword)).toEqual(["controlKeyword"]);
      }
      expect(classesOf(lines, "return")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "continue")).toEqual(["controlKeyword"]);
      for (const name of ["ROOT", "names", "1", "2", "PATH"]) {
        expect(classesOf(lines, name)).toContain("propertyName");
      }
      expect(classesOf(lines, "-n")).toEqual(["operator"]);
      expect(classesOf(lines, "=~")).toEqual(["operator"]);
      expect(classesOf(lines, "^v[0-9]+$")).toEqual(["regex"]);
      expect(classesOf(lines, "3")).toEqual(["number"]);
      expect(classesOf(lines, "$(")).toEqual(["punctuation"]);
      expect(classesOf(lines, "${")).toEqual(["punctuation"]);
      expect(classesOf(lines, ":-")).toEqual(["operator"]);
    });

    it("colors the expansions inside a string as code", () => {
      const lines = highlight('echo "at ${HOME} on $(hostname) as $USER"');

      expect(classesOf(lines, '"at ')).toEqual(["string"]);
      expect(classesOf(lines, " on ")).toEqual(["string"]);
      expect(classesOf(lines, "HOME")).toEqual(["propertyName"]);
      expect(classesOf(lines, "USER")).toEqual(["propertyName"]);
      expect(classesOf(lines, "hostname")).toEqual(["callName"]);
    });

    it("colors a heredoc body as a string, expanding only when its delimiter is unquoted", () => {
      const lines = highlight([
        "cat <<EOF",
        "Hello $USER",
        "EOF",
        "python3 - <<'PY'",
        'print("$USER")',
        "PY",
      ].join("\n"));

      expect(classesOf(lines, "Hello ")).toEqual(["string"]);
      expect(classesOf(lines, "USER")).toEqual(["propertyName"]);
      expect(classesOf(lines, "EOF")).toEqual(["string"]);
      expect(classesOf(lines, 'print("$USER")')).toEqual(["string"]);
      expect(classesOf(lines, "'PY'")).toEqual(["string"]);
      expect(classesOf(lines, "PY")).toEqual(["string"]);
    });

    describe("comments in command substitutions", () => {
      function spansOf(source: string): [string, TokenClass][] {
        return highlight(source)[0].spans.map((span) => [span.text, span.cls]);
      }

      it("ends a comment inside backticks at the closing backtick", () => {
        expect(spansOf("echo `echo a # b`; run 1")).toEqual([
          ["echo", "callName"],
          [" ", "whitespace"],
          ["`", "punctuation"],
          ["echo", "callName"],
          [" ", "whitespace"],
          ["a", "plain"],
          [" ", "whitespace"],
          ["# b", "comment"],
          ["`;", "punctuation"],
          [" ", "whitespace"],
          ["run", "callName"],
          [" ", "whitespace"],
          ["1", "number"],
        ]);
      });

      it("ends a comment inside backticks inside `$(…)` at the closing backtick", () => {
        const lines = highlight("echo $(echo `echo a # b` c); run 1");

        expect(classesOf(lines, "# b")).toEqual(["comment"]);
        expect(classesOf(lines, "c")).toEqual(["plain"]);
        expect(classesOf(lines, "run")).toEqual(["callName"]);
      });

      it("keeps an escaped backtick inside the comment", () => {
        const lines = highlight("echo `echo a # b \\` c` d; run 1");

        expect(classesOf(lines, "# b \\` c")).toEqual(["comment"]);
        expect(classesOf(lines, "d")).toEqual(["plain"]);
        expect(classesOf(lines, "run")).toEqual(["callName"]);
      });

      it("ends a comment on a later line of a backtick substitution at its backtick", () => {
        const lines = highlight("x=`a\n# b` c");

        expect(classesOf(lines, "# b")).toEqual(["comment"]);
        expect(classesOf(lines, "c")).toEqual(["callName"]);
      });

      it("ends the comment in each of a run of backtick substitutions", () => {
        const lines = highlight("x=`echo # a`\ny=`echo # b`\nz");

        expect(classesOf(lines, "# a")).toEqual(["comment"]);
        expect(classesOf(lines, "# b")).toEqual(["comment"]);
        expect(classesOf(lines, "y")).toEqual(["propertyName"]);
        expect(classesOf(lines, "z")).toEqual(["callName"]);
      });

      it("ends comments on other lines when the parse cannot show where one ends", () => {
        // The grammar reads the two substitutions on the first line as one,
        // so the comment in the first of them cannot be shown to end.
        const lines = highlight(
          "echo `x # a` `y`\necho `echo c # d`; run 1\necho `x # e` `y`",
        );

        expect(classesOf(lines, "# d")).toEqual(["comment"]);
        expect(classesOf(lines, "run")).toEqual(["callName"]);
      });

      it("ends the comment on each of a run of lines that each depend on the line before", () => {
        // The grammar reads the two substitutions on each line as one, and
        // the line after a comment it misreads only parses once that comment
        // is read as blank space.
        const source = "echo `x # a` `y`\n".repeat(5);
        const lines = highlight(source);

        expect(verbatim(lines)).toBe(source);
        expect(
          lines.flatMap((line) =>
            line.spans.filter((span) => span.cls === "comment").map((span) =>
              span.text
            )
          ),
        ).toEqual(new Array(5).fill("# a"));
      });

      it("ends a comment that is all a backtick substitution holds at its backtick", () => {
        const lines = highlight("echo `# x` y");

        expect(classesOf(lines, "# x")).toEqual(["comment"]);
        expect(classesOf(lines, "y")).not.toContain("comment");
      });

      it("runs a comment inside `$(…)` to the end of its line", () => {
        expect(spansOf("echo $(echo a # b); run 1")).toEqual([
          ["echo", "callName"],
          [" ", "whitespace"],
          ["$(", "punctuation"],
          ["echo", "callName"],
          [" ", "whitespace"],
          ["a", "plain"],
          [" ", "whitespace"],
          ["# b); run 1", "comment"],
        ]);
      });

      it("runs a comment outside any substitution to the end of its line, backticks and all", () => {
        expect(spansOf("echo a # it is `x`; run 1")).toEqual([
          ["echo", "callName"],
          [" ", "whitespace"],
          ["a", "plain"],
          [" ", "whitespace"],
          ["# it is `x`; run 1", "comment"],
        ]);
        expect(spansOf("echo `x` # it is `y`; run 1").at(-1)).toEqual(
          ["# it is `y`; run 1", "comment"],
        );
      });

      it("ends a comment after escaped backticks inside backticks at the closing backtick", () => {
        const lines = highlight("echo `echo \\`echo d\\` # x`; run 1");

        expect(classesOf(lines, "# x")).toEqual(["comment"]);
        expect(classesOf(lines, "run")).toEqual(["callName"]);
      });

      it("runs comments to the end of their lines where the grammar misreads the backticks before them", () => {
        // The grammar reads the backtick closing `date` as opening a
        // substitution, and the one in `echo \`a\`` as closing one.
        const lines = highlight(
          "x=`date`\necho \\` # `tick`\necho `echo \\`a\\``\necho \\` # `tock`",
        );

        expect(classesOf(lines, "# `tick`")).toEqual(["comment"]);
        expect(classesOf(lines, "# `tock`")).toEqual(["comment"]);
        expect(
          classesOf(
            highlight("echo `|` # see `foo` here; run 1"),
            "# see `foo` here; run 1",
          ),
        ).toEqual(["comment"]);
        expect(
          classesOf(
            highlight(
              "echo `echo \\`a\\``\necho \\` # `tick`\necho `echo \\`a\\``\necho '`'",
            ),
            "# `tick`",
          ),
        ).toEqual(["comment"]);
      });

      it("runs comments quoting commands to the end of their lines after an empty substitution", () => {
        const lines = highlight(
          "x=``\n# Run `make` first.\n# Then `make test`.",
        );

        expect(classesOf(lines, "# Run `make` first.")).toEqual(["comment"]);
        expect(classesOf(lines, "# Then `make test`.")).toEqual(["comment"]);
      });

      it("runs a comment quoting a command to the end of its line in a script with an error", () => {
        const lines = highlight(
          "echo a # run `make` first; run 1\necho $(b `c` # see `d`\n;;",
        );

        expect(classesOf(lines, "# run `make` first; run 1")).toEqual([
          "comment",
        ]);
        expect(classesOf(lines, "# see `d`")).toEqual(["comment"]);
      });
    });

    it("nests brackets and leaves unpaired delimiters out of bracket depth", () => {
      const lines = highlight(
        'case "$1" in a) f=$( (cd x; [ -d y ]) ) ;; esac',
      );
      const brackets = lines[0].spans.filter((span) => span.cls === "bracket");

      expect(brackets.map((span) => [span.text, span.bracketDepth])).toEqual([
        ["(", 0],
        ["[", 1],
        ["]", 1],
        [")", 0],
      ]);
      expect(classesOf(lines, ")")).toEqual(["punctuation", "bracket"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'echo "unterminated\necho after',
          "cat <<EOF\nnever closed",
          "echo ${unclosed",
          "f() {",
          "if true; then\n  for x in",
          "case $x in\r\n  a) ;;\r\nesac",
          "$(( 1 + ",
          "\ud800",
          "",
          " \t",
          'echo "café ☕ 😀"',
        ]
      ) {
        const document = shellLanguage.parseDocument(source);
        expect(verbatim(document.lines)).toBe(source);
      }
    });
  });

  describe("structure", () => {
    const source = [
      "#!/bin/sh",
      'log() { echo "$*" >&2; }',
      "",
      "function main {",
      "  helper() { :; }",
      "  helper",
      "}",
      "",
      'main "$@"',
    ].join("\n");

    it("lists function definitions in both forms, nested where they are declared", () => {
      const document = shellLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
        ]),
      ).toEqual([
        ["function", "log()", 0, 1],
        ["function", "function main", 0, 3],
        ["function", "helper()", 1, 4],
      ]);
      expect([...document.definitions.keys()]).toEqual([
        "log",
        "main",
        "helper",
      ]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "# café ☕ and an astral 😀",
        "set -eu",
        "greet() {",
        '  echo "hello $1"',
        "}",
        "cat <<EOF",
        "body $HOME",
        "EOF",
        "greet world",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ['"hello $1"', '"hello ${1:-you}"'],
        ["greet() {", "function greet {"],
        ["cat <<EOF", "cat <<'EOF'"],
        ["EOF\ngreet", "EOX\ngreet"],
        ['"hello ${1:-you}"', '"hello ${1'],
        ["# café", "echo café"],
      ];
      const highlighter = shellLanguage.createHighlighter(source);
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

    it("matches a complete re-highlight as edits move a comment in and out of backticks", () => {
      const source = "echo `echo a # b`; run 1\necho done\n";
      const edits: [string, string][] = [
        ["run 1", "run 2"],
        ["# b`", "# b \\` c`"],
        ["echo `echo", "echo $(echo"],
        ["c`; run", "c); run"],
        ["echo $(echo", "echo `echo"],
        ["c); run", "c`; run"],
        ["echo done", "echo `done # x`"],
        ["echo `echo a # b", "echo `echo a x# b"],
        ["echo `echo a x# b", "echo `echo a # b"],
        ["done # x", "done x# x"],
      ];
      const highlighter = shellLanguage.createHighlighter(source);
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
      expect(classesOf(highlighter.lines, "# b \\` c")).toEqual(["comment"]);
      expect(classesOf(highlighter.lines, "x#")).toEqual(["plain"]);
    });

    it("matches a complete re-highlight after an edit to malformed source with a comment that may end at a backtick", () => {
      // A parse reused across this edit recovers from the errors differently
      // from a fresh parse.
      const before = "``\\`)\\``\\``echo\n)`#\\);`$ # c# c`";
      const after = "``\\`)\\``\\``echo\n)`#\\)`$($ # c# c`";

      const updated = shellLanguage.createHighlighter(before).update(after);

      expect(verbatim(updated)).toBe(after);
      expect(updated).toEqual(highlight(after));
    });

    it("colors a diff of an unavailable file from its heredoc context", () => {
      const diff = [
        "diff --git a/deploy.sh b/deploy.sh",
        "--- a/deploy.sh",
        "+++ b/deploy.sh",
        "@@ -1,3 +1,3 @@",
        " cat <<'EOF'",
        "-old text",
        "+new text",
        " EOF",
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
