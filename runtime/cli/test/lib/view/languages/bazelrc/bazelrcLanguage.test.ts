import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import { buildDiffDocument } from "../../../../../lib/view/diffdoc.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { bazelrcLanguage } from "../../../../../lib/view/languages/bazelrc/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

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
  return bazelrcLanguage.highlightLines(source);
}

describe("bazelrcLanguage", () => {
  it("selects rc files by their extension in any case", () => {
    for (const path of [".bazelrc", "ci.bazelrc", "/etc/bazel.BAZELRC"]) {
      expect(languageForFile(path).id).toBe("bazelrc");
    }
    expect(languageForFile("bazelrc").id).toBe("plain-text");
  });

  describe("highlighting", () => {
    it("colors commands, configurations, options, and values", () => {
      const lines = highlight([
        "# Strong hashes.",
        "startup --host_jvm_args=-Dbazel.DigestFunction=SHA256",
        "build:race --@io_bazel_rules_go//go/config:race --cpu k8",
        "test --test_env='A B' --nocache_test_results",
      ].join("\n"));

      expect(classesOf(lines, "# Strong hashes.")).toEqual(["comment"]);
      for (const command of ["startup", "build", "test"]) {
        expect(classesOf(lines, command)).toEqual(["keyword"]);
      }
      expect(classesOf(lines, "race")).toEqual(["interfaceName"]);
      expect(classesOf(lines, ":")).toEqual(["punctuation"]);
      for (
        const option of [
          "--host_jvm_args",
          "--@io_bazel_rules_go//go/config:race",
          "--cpu",
          "--test_env",
          "--nocache_test_results",
        ]
      ) {
        expect(classesOf(lines, option)).toEqual(["propertyName"]);
      }
      expect(classesOf(lines, "=")).toEqual(["operator"]);
      for (const value of ["-Dbazel.DigestFunction=SHA256", "k8", "'A B'"]) {
        expect(classesOf(lines, value)).toEqual(["string"]);
      }
    });

    it("colors imports and the paths they name", () => {
      const lines = highlight(
        [
          "import %workspace%/tools/ci.bazelrc",
          "try-import user.bazelrc",
          "try-import-if-bazel-version >=8.0.0 bzlmod.bazelrc",
        ].join("\n"),
      );

      expect(classesOf(lines, "import")).toEqual(["keyword"]);
      expect(classesOf(lines, "try-import")).toEqual(["keyword"]);
      expect(classesOf(lines, "%workspace%/tools/ci.bazelrc")).toEqual([
        "string",
      ]);
      expect(classesOf(lines, "user.bazelrc")).toEqual(["string"]);
      expect(classesOf(lines, "try-import-if-bazel-version")).toEqual([
        "keyword",
      ]);
      expect(classesOf(lines, ">=8.0.0")).toEqual(["string"]);
      expect(classesOf(lines, "bzlmod.bazelrc")).toEqual(["string"]);
    });

    it("leaves an import that Bazel refuses for its number of words plain", () => {
      const document = bazelrcLanguage.parseDocument(
        "import a.bazelrc b.bazelrc\ntry-import\ntry-import-if-bazel-version c",
      );

      for (const word of ["import", "try-import", "a.bazelrc", "c"]) {
        expect(classesOf(document.lines, word)).toEqual(["plain"]);
      }
      expect(document.flatStructure).toEqual([]);
    });

    it("ends a word at a comment outside quotes and not inside them", () => {
      const lines = highlight(
        'build --define=a#b\nbuild --copt="-DX=#y" # trailing',
      );

      expect(classesOf(lines, "a")).toEqual(["string"]);
      expect(classesOf(lines, "#b")).toEqual(["comment"]);
      expect(classesOf(lines, '"-DX=#y"')).toEqual(["string"]);
      expect(classesOf(lines, "# trailing")).toEqual(["comment"]);
    });

    it("continues a line, or a comment, after a backslash at its end", () => {
      const lines = highlight(
        "build \\\n  --stamp\r\n# a \\\nb\n--next",
      );

      expect(classesOf(lines, "\\")).toEqual(["punctuation"]);
      expect(classesOf(lines, "--stamp")).toEqual(["propertyName"]);
      expect(classesOf(lines, "# a \\")).toEqual(["comment"]);
      expect(classesOf(lines, "b")).toEqual(["comment"]);
      // The comment's continuation ends with its line, so the next line names
      // a command, and one Bazel does not have.
      expect(classesOf(lines, "--next")).toEqual(["plain"]);
    });

    it("leaves a line for a command Bazel does not have plain", () => {
      const lines = highlight("suspend --x=1\n-keep:all class Foo\nbuild:all");

      for (const word of ["suspend", "--x=1", "-keep:all", "class", "Foo"]) {
        expect(classesOf(lines, word)).toEqual(["plain"]);
      }
      expect(classesOf(lines, "all")).toEqual(["interfaceName"]);
    });

    it("keeps an escaped character in its word", () => {
      const lines = highlight("build --copt=a\\ b\\#c");

      expect(classesOf(lines, "a\\ b\\#c")).toEqual(["string"]);
    });

    it("joins a line that ends in a backslash after an escaping one", () => {
      // Bazel removes each line join before it reads the words, so the
      // second backslash joins the lines and the first escapes the next
      // line's first character.
      const lines = highlight("build --copt=a\\\\\n#x=b\n--y");

      expect(classesOf(lines, "--copt")).toEqual(["propertyName"]);
      expect(classesOf(lines, "#x=b")).toEqual(["string"]);
      expect(classesOf(lines, "--y")).toEqual(["plain"]);
    });

    it("reads names that a line join or quotes split as Bazel reads them", () => {
      const document = bazelrcLanguage.parseDocument(
        "bui\\\nld:ra\\\nce --x\nimport 'tools/ci'.bazelrc",
      );

      expect(classesOf(document.lines, "bui")).toEqual(["keyword"]);
      expect(classesOf(document.lines, "ce")).toEqual(["interfaceName"]);
      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "race",
        "import tools/ci.bazelrc",
      ]);
      expect([...document.definitions.keys()]).toEqual(["race"]);
    });

    it("joins lines that removing a carriage-return join brings together", () => {
      // Bazel removes the joins before a carriage return and line feed first,
      // which leaves the first backslash before the empty line's line feed.
      const lines = highlight("build --copt=a\\\\\r\n\nb\nc");

      expect(classesOf(lines, "b")).toEqual(["string"]);
      expect(classesOf(lines, "c")).toEqual(["plain"]);
    });

    it("strips form feeds and vertical tabs from a line's ends", () => {
      const lines = highlight("\fbuild --x\v\nbuild --y=\v");

      expect(classesOf(lines, "build")).toEqual(["keyword"]);
      expect(classesOf(lines, "--x")).toEqual(["propertyName"]);
      expect(classesOf(lines, "=")).toEqual(["operator"]);
    });

    it("separates words at a carriage return inside a line", () => {
      const lines = highlight("build\r--x\r--y=1");

      expect(classesOf(lines, "build")).toEqual(["keyword"]);
      expect(classesOf(lines, "--x")).toEqual(["propertyName"]);
      expect(classesOf(lines, "--y")).toEqual(["propertyName"]);
    });

    it("drops a word that reads as nothing", () => {
      const lines = highlight("'' build --x");

      expect(classesOf(lines, "build")).toEqual(["keyword"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          "build --copt='open",
          'build --copt="open\nbuild --next',
          "build:",
          ":race --x",
          "import",
          "build \\",
          "trailing\\",
          "a\r\nb\r\n",
          "\ud800",
          "",
          " \t",
          "build --x=café☕😀",
        ]
      ) {
        expect(verbatim(bazelrcLanguage.parseDocument(source).lines)).toBe(
          source,
        );
      }
    });
  });

  describe("structure", () => {
    it("lists imports, and each configuration where a line first defines it", () => {
      const source = [
        "import %workspace%/common.bazelrc",
        "build --stamp",
        "build:race --x",
        "test:race --x",
        "build:arm64 --cpu=aarch64",
        "try-import user.bazelrc",
        "build: --x",
      ].join("\n");
      const document = bazelrcLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.startLine,
        ]),
      ).toEqual([
        ["import", "import %workspace%/common.bazelrc", 0],
        ["object", "race", 2],
        ["object", "arm64", 4],
        ["import", "try-import user.bazelrc", 5],
      ]);
      expect([...document.definitions.keys()]).toEqual(["race", "arm64"]);
      expect(document.flatStructure[1].nameOffset).toBe(
        source.indexOf("race"),
      );
    });

    it("lists the configurations a diff's hunk shows", () => {
      const diff = [
        "diff --git a/.bazelrc b/.bazelrc",
        "--- a/.bazelrc",
        "+++ b/.bazelrc",
        "@@ -1,2 +1,2 @@",
        " build --stamp",
        "-build:race --x",
        "+build:tsan --x",
        "",
      ].join("\n");
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, {
        resolve: () => null,
        read: () => null,
      });

      const labels = doc.flatStructure.map((node) => node.label);
      expect(labels).toContain("tsan");
      expect(labels).not.toContain("build");
      expect(classesOf(doc.lines, "tsan")).toEqual(["interfaceName"]);
    });
  });

  it("matches a complete re-highlight after each update", () => {
    const source = "build --stamp\nbuild:race --x\n";
    const highlighter = bazelrcLanguage.createHighlighter(source);
    for (const next of ["build --stamp \\\nbuild:race --x\n", "# all\n"]) {
      expect(highlighter.update(next).map((line) => line.spans)).toEqual(
        highlight(next).map((line) => line.spans),
      );
    }
  });
});
