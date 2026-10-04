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
