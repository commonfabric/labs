import { expect } from "@std/expect";

import { languageForSource } from "../../../../../lib/view/languages/language.ts";
import { dotenvLanguage } from "../../../../../lib/view/languages/dotenv/language.ts";
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

/** Each span of one line, as its text and class. */
function spansOf(line: Line): [string, TokenClass][] {
  return line.spans.map((span) => [span.text, span.cls]);
}

const SOURCE = [
  "# Copy to .env and fill in.",
  "PORT=8000",
  "export API_HOST = 127.0.0.1   # loopback only",
  "SITE_URL=https://example.com/#top",
  'GREETING="hello \\"$USER\\""',
  "RAW='no $EXPANSION here'",
  'KEY_ID="${KEY_ID:-${DEFAULT_ID}}"',
  'PEM="-----BEGIN-----',
  "# still the value",
  '-----END-----"',
  "EMPTY=",
  "COST=$5 and $$",
].join("\n");

describe("dotenvLanguage", () => {
  describe("selection", () => {
    it("selects `.env` and its variants by name", () => {
      for (
        const name of [
          ".env",
          "app/.env.local",
          "runtime/toolshed/.env.example",
          ".env.production.local",
          "plaid/config.env.example",
          "deploy/toolshed-env.example",
          "env.sample",
          "deploy/app_env.template",
          ".ENV.Local",
          "CONFIG.ENV.EXAMPLE",
        ]
      ) {
        expect(languageForSource(name, "").id).toBe("dotenv");
      }
    });

    it("selects another `.env` file when its first setting is an assignment", () => {
      const source = "# Release pin.\n\nexport CHART_URL=https://x\n";

      expect(languageForSource("k8s/release.env", source).id).toBe("dotenv");
      expect(languageForSource("brew.env", "  HOMEBREW_X=1").id).toBe(
        "dotenv",
      );
    });

    it("leaves other `.env` syntaxes and unrelated names to plain text", () => {
      const xcconfig = "// The configuration file for your app.\n" +
        "PRODUCT_NAME = Weaver\n";
      const vault = "$ANSIBLE_VAULT;1.1;AES256\n6162636465\n";

      expect(languageForSource("android/fuse/Skip.env", xcconfig).id).toBe(
        "plain-text",
      );
      expect(languageForSource("secrets/toolshed.env", vault).id).toBe(
        "plain-text",
      );
      expect(languageForSource("only-comments.env", "# none\n").id).toBe(
        "plain-text",
      );
      expect(languageForSource("release.env", "").id).toBe("plain-text");
      expect(languageForSource(".envrc", "export A=1\n").id).toBe(
        "plain-text",
      );
      expect(languageForSource("environment", "A=1\n").id).toBe("plain-text");
    });

    it("leaves a variant with another language's extension to that language", () => {
      expect(languageForSource(".env.json", "{}").id).toBe("json");
      expect(languageForSource(".env.sh", "A=1").id).toBe("shell");
      expect(languageForSource(".env.xml", "<a/>").id).toBe("xml");
      expect(languageForSource(".env.txt", "A=1").id).toBe("plain-text");
      expect(languageForSource(".env.plist", "<a/>").id).toBe("xml");
      expect(languageForSource(".env.png", "").id).toBe("binary");
    });
  });

  describe("highlighting", () => {
    it("colors comments, keywords, names, operators, and values", () => {
      const lines = dotenvLanguage.highlightLines(SOURCE);

      expect(classesOf(lines, "# Copy to .env and fill in.")).toEqual([
        "comment",
      ]);
      expect(classesOf(lines, "PORT")).toEqual(["propertyName"]);
      expect(classesOf(lines, "=")).toEqual(["operator"]);
      expect(classesOf(lines, "8000")).toEqual(["string"]);
      expect(spansOf(lines[2])).toEqual([
        ["export", "storageKeyword"],
        [" ", "whitespace"],
        ["API_HOST", "propertyName"],
        [" ", "whitespace"],
        ["=", "operator"],
        [" ", "whitespace"],
        ["127.0.0.1", "string"],
        ["   ", "whitespace"],
        ["# loopback only", "comment"],
      ]);
      expect(verbatim(lines)).toBe(SOURCE);
    });

    it("keeps a `#` that does not follow white space in an unquoted value", () => {
      const lines = dotenvLanguage.highlightLines(SOURCE);

      expect(spansOf(lines[3])).toEqual([
        ["SITE_URL", "propertyName"],
        ["=", "operator"],
        ["https://example.com/#top", "string"],
      ]);
    });

    it("colors references in double-quoted values but not in single-quoted ones", () => {
      const lines = dotenvLanguage.highlightLines(SOURCE);

      expect(spansOf(lines[4])).toEqual([
        ["GREETING", "propertyName"],
        ["=", "operator"],
        ['"hello \\"', "string"],
        ["$", "punctuation"],
        ["USER", "propertyName"],
        ['\\""', "string"],
      ]);
      expect(spansOf(lines[5])).toEqual([
        ["RAW", "propertyName"],
        ["=", "operator"],
        ["'no $EXPANSION here'", "string"],
      ]);
    });

    it("colors a reference's operator, its default, and a reference nested in it", () => {
      const lines = dotenvLanguage.highlightLines(SOURCE);

      expect(spansOf(lines[6])).toEqual([
        ["KEY_ID", "propertyName"],
        ["=", "operator"],
        ['"', "string"],
        ["${", "punctuation"],
        ["KEY_ID", "propertyName"],
        [":-", "operator"],
        ["${", "punctuation"],
        ["DEFAULT_ID", "propertyName"],
        ["}}", "punctuation"],
        ['"', "string"],
      ]);
    });

    it("continues a quoted value across lines, through a line that starts with `#`", () => {
      const lines = dotenvLanguage.highlightLines(SOURCE);

      expect(classesOf(lines, "# still the value")).toEqual(["string"]);
      expect(classesOf(lines, '-----END-----"')).toEqual(["string"]);
      expect(classesOf(lines, "EMPTY")).toEqual(["propertyName"]);
    });

    it("leaves a dollar sign that names no variable in the value", () => {
      const lines = dotenvLanguage.highlightLines(SOURCE);

      expect(spansOf(lines[11])).toEqual([
        ["COST", "propertyName"],
        ["=", "operator"],
        ["$5 and $$", "string"],
      ]);
    });

    it("ends an unclosed reference before the quote that closes its value", () => {
      const lines = dotenvLanguage.highlightLines('A="${B:-x"\nC=1');

      expect(spansOf(lines[0])).toEqual([
        ["A", "propertyName"],
        ["=", "operator"],
        ['"', "string"],
        ["${", "punctuation"],
        ["B", "propertyName"],
        [":-", "operator"],
        ['x"', "string"],
      ]);
      expect(spansOf(lines[1])[0]).toEqual(["C", "propertyName"]);
    });

    it("reads a value that no quote closes as an unquoted value", () => {
      const document = dotenvLanguage.parseDocument(
        "A=\"x $B # c\nC='y\nD=1 # note\nE=z",
      );

      expect(spansOf(document.lines[0]).slice(2)).toEqual([
        ['"x ', "string"],
        ["$", "punctuation"],
        ["B", "propertyName"],
        [" ", "whitespace"],
        ["# c", "comment"],
      ]);
      expect(spansOf(document.lines[1])).toEqual([
        ["C", "propertyName"],
        ["=", "operator"],
        ["'y", "string"],
      ]);
      expect(classesOf(document.lines, "# note")).toEqual(["comment"]);
      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "A",
        "C",
        "D",
        "E",
      ]);
    });

    it("keeps an escaped quote inside a reference's default in the value", () => {
      const lines = dotenvLanguage.highlightLines('A="${B:-\\"x # y\\"}"\nC=1');

      expect(spansOf(lines[0])).toEqual([
        ["A", "propertyName"],
        ["=", "operator"],
        ['"', "string"],
        ["${", "punctuation"],
        ["B", "propertyName"],
        [":-", "operator"],
        ['\\"x # y\\"', "string"],
        ["}", "punctuation"],
        ['"', "string"],
      ]);
      expect(spansOf(lines[1])[0]).toEqual(["C", "propertyName"]);
    });

    it("reads `$$` as a dollar sign rather than the start of a reference", () => {
      const lines = dotenvLanguage.highlightLines('A=$$HOME\nB="$$${C}"');

      expect(spansOf(lines[0])).toEqual([
        ["A", "propertyName"],
        ["=", "operator"],
        ["$$HOME", "string"],
      ]);
      expect(spansOf(lines[1]).slice(2)).toEqual([
        ['"$$', "string"],
        ["${", "punctuation"],
        ["C", "propertyName"],
        ["}", "punctuation"],
        ['"', "string"],
      ]);
    });

    it("ends a reference in an unquoted value at a comment", () => {
      const lines = dotenvLanguage.highlightLines("A=${X:-a #b}\nB=${C  # d");

      expect(spansOf(lines[0]).slice(-3)).toEqual([
        ["a", "string"],
        [" ", "whitespace"],
        ["#b}", "comment"],
      ]);
      expect(spansOf(lines[1]).slice(-3)).toEqual([
        ["C", "propertyName"],
        ["  ", "whitespace"],
        ["# d", "comment"],
      ]);
    });

    it("colors text after a closing quote as part of the value", () => {
      const lines = dotenvLanguage.highlightLines("A='x' y # note");

      expect(spansOf(lines[0])).toEqual([
        ["A", "propertyName"],
        ["=", "operator"],
        ["'x'", "string"],
        [" ", "whitespace"],
        ["y", "string"],
        [" ", "whitespace"],
        ["# note", "comment"],
      ]);
    });

    it("starts a comment after a closing quote only where white space precedes it", () => {
      const lines = dotenvLanguage.highlightLines("A=\"x\"#c\nB='y' #d");

      expect(spansOf(lines[0]).at(-1)).toEqual(['"x"#c', "string"]);
      expect(classesOf(lines, "#d")).toEqual(["comment"]);
    });

    it("reconstructs incomplete input exactly", () => {
      for (
        const source of [
          "",
          "=",
          "export ",
          'A="unclosed',
          "A='x\\",
          'A="\\',
          "A=${",
          "A=${B",
          "A=$",
          "\r\nA=1\r\n",
          "k=☕ 😀",
        ]
      ) {
        expect(verbatim(dotenvLanguage.parseDocument(source).lines)).toBe(
          source,
        );
      }
    });

    it("recolors each edit", () => {
      const highlighter = dotenvLanguage.createHighlighter("A=1");

      expect(highlighter.update("A=1")).toBe(highlighter.lines);
      expect(classesOf(highlighter.update("B=1"), "B")).toEqual([
        "propertyName",
      ]);
    });
  });

  describe("structure", () => {
    it("lists each variable the file sets over the lines that set it", () => {
      const document = dotenvLanguage.parseDocument(SOURCE);

      expect(
        document.flatStructure.map((node) => [
          node.label,
          node.startLine,
          node.endLine,
        ]),
      ).toEqual([
        ["PORT", 1, 1],
        ["API_HOST", 2, 2],
        ["SITE_URL", 3, 3],
        ["GREETING", 4, 4],
        ["RAW", 5, 5],
        ["KEY_ID", 6, 6],
        ["PEM", 7, 9],
        ["EMPTY", 10, 10],
        ["COST", 11, 11],
      ]);
      expect(document.definitions.get("API_HOST")?.[0].startOffset).toBe(
        SOURCE.indexOf("export API_HOST"),
      );
      expect(document.flatStructure[1].nameOffset).toBe(
        SOURCE.indexOf("API_HOST"),
      );
    });

    it("lists only the lines that assign a value to a name", () => {
      const document = dotenvLanguage.parseDocument(
        '=orphan\nNAME\n$ANSIBLE_VAULT;1.1;AES256\nQUOTED "no value\nSET=1\n',
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "SET",
      ]);
      expect(classesOf(document.lines, '"no')).toEqual(["string"]);
    });
  });
});
