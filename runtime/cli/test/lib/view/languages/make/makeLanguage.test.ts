import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { makeLanguage } from "../../../../../lib/view/languages/make/language.ts";
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
  const lines = makeLanguage.highlightLines(source);
  expect(verbatim(lines)).toBe(source);
  return lines;
}

describe("makeLanguage", () => {
  beforeAll(() => makeLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries make's representative filenames,
    // aliases, and shebangs; these cases are the ones it does not.

    it("selects `.mk` files in any case", () => {
      for (const path of ["tools/images.mk", "rules/Common.MK"]) {
        expect(languageForFile(path).id).toBe("make");
      }
    });

    it("leaves other build files and similar names to other languages", () => {
      for (
        const path of ["CMakeLists.txt", "Makefile.toml", "MAKEFILE", "x.make"]
      ) {
        expect(languageForFile(path).id).not.toBe("make");
      }
      expect(languageForSource("run", "#!/usr/bin/env cmake -P\nx\n").id)
        .not.toBe("make");
    });
  });

  describe("highlighting", () => {
    it("colors every assignment operator and the name it assigns", () => {
      for (const op of ["=", ":=", "::=", ":::=", "?=", "+=", "!="]) {
        const lines = highlight(`NAME ${op} value\n`);
        expect(classesOf(lines, "NAME")).toEqual(["propertyName"]);
        expect(classesOf(lines, op)).toEqual(["operator"]);
        expect(classesOf(lines, "value")).toEqual(
          op === "!=" ? ["callName"] : ["plain"],
        );
      }
    });

    it("colors a rule's targets, its separators, and its prerequisites", () => {
      const lines = highlight(
        "all test: build | dist\n" +
          "%.o: %.c\n" +
          "objs: %.x: %.c\n" +
          "a b &: c\n" +
          "twice:: once\n",
      );

      for (const target of ["all", "test", "%.o", "objs", "a", "twice"]) {
        expect(classesOf(lines, target)).toEqual(["functionName"]);
      }
      for (const prerequisite of ["build", "dist", "once"]) {
        expect(classesOf(lines, prerequisite)).toEqual(["plain"]);
      }
      expect(classesOf(lines, "|")).toEqual(["operator"]);
      expect(classesOf(lines, "&:")).toEqual(["operator"]);
      expect(classesOf(lines, "::")).toEqual(["operator"]);
    });

    it("colors recipe lines as shell, with make's references over them", () => {
      const lines = highlight(
        'build:\n\t@echo "$(OUT)" $$HOME\n\t-rm -f $< # tidy\n',
      );

      expect(classesOf(lines, "@")).toEqual(["operator"]);
      expect(classesOf(lines, "-")).toEqual(["operator"]);
      expect(classesOf(lines, "echo")).toEqual(["callName"]);
      expect(classesOf(lines, "rm")).toEqual(["callName"]);
      expect(classesOf(lines, "OUT")).toEqual(["propertyName"]);
      expect(classesOf(lines, "HOME")).toEqual(["propertyName"]);
      expect(classesOf(lines, "# tidy")).toEqual(["comment"]);
      expect(classesOf(lines, "<")).toEqual(["propertyName"]);
    });

    it("reads a recipe line's continuation as the same shell command", () => {
      const lines = highlight(
        "run:\n\tfor f in a b; do \\\n\t  echo $$f; \\\n\tdone\n",
      );

      expect(classesOf(lines, "for")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "done")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "echo")).toEqual(["callName"]);
    });

    it("colors the recipe after a rule's semicolon as shell", () => {
      const lines = highlight("clean: ; rm -rf out\n");

      expect(classesOf(lines, "clean")).toEqual(["functionName"]);
      expect(classesOf(lines, ";")).toEqual(["punctuation"]);
      expect(classesOf(lines, "rm")).toEqual(["callName"]);
    });

    it("colors the argument of the `shell` function as shell", () => {
      const lines = highlight("FILES := $(shell ls -1 | sort)\n");

      expect(classesOf(lines, "shell")).toEqual(["callName"]);
      expect(classesOf(lines, "ls")).toEqual(["callName"]);
      expect(classesOf(lines, "|")).toEqual(["operator"]);
    });

    it("reads a tabbed line as make syntax once a line other than a rule ends the rule", () => {
      const lines = highlight("all:\n\techo a\nX = 1\n\tY = 2\n");

      expect(classesOf(lines, "echo")).toEqual(["callName"]);
      expect(classesOf(lines, "Y")).toEqual(["propertyName"]);
    });

    it("reads leading tabbed lines as recipe lines, as a diff hunk inside a rule shows them", () => {
      const lines = highlight("\tgo test ./...\n\tGOOS=linux go build\n");

      expect(classesOf(lines, "go")).toEqual(["callName"]);
      expect(classesOf(lines, "GOOS")).toEqual(["propertyName"]);
    });

    it("keeps a rule open across comments, blank lines, and conditionals", () => {
      const lines = highlight(
        "all:\n# note\n\nifeq ($(OS),Linux)\n\techo linux\nelse ifdef X\n" +
          "\techo other\nendif\n",
      );

      for (const word of ["ifeq", "else", "ifdef", "endif"]) {
        expect(classesOf(lines, word)).toEqual(["controlKeyword"]);
      }
      expect(classesOf(lines, "echo")).toEqual(["callName"]);
      expect(classesOf(lines, "OS")).toEqual(["propertyName"]);
      expect(classesOf(lines, ",")).toEqual(["punctuation"]);
    });

    it("colors the quoted arguments of a conditional as strings", () => {
      const lines = highlight('ifneq "$(X)" "yes"\nendif\n');

      expect(classesOf(lines, '"yes"')).toEqual(["string"]);
      expect(classesOf(lines, "X")).toEqual(["propertyName"]);
    });

    it("uses the recipe prefix that `.RECIPEPREFIX` names", () => {
      const lines = highlight(".RECIPEPREFIX = >\nall:\n>echo hi\n");

      expect(classesOf(lines, "echo")).toEqual(["callName"]);
    });

    it("colors functions, their arguments, and substitution references", () => {
      const lines = highlight(
        "OBJS = $(patsubst %.c,%.o,$(SRCS)) ${SRCS:.c=.o}\n",
      );

      expect(classesOf(lines, "patsubst")).toEqual(["callName"]);
      expect(classesOf(lines, ",")).toEqual(["punctuation"]);
      expect(classesOf(lines, "SRCS")).toEqual(["propertyName"]);
      expect(classesOf(lines, ":")).toEqual(["operator"]);
      expect(classesOf(lines, "=")).toEqual(["operator"]);
      expect(classesOf(lines, "{")).toEqual(["bracket"]);
    });

    it("colors directives by kind", () => {
      const lines = highlight(
        "-include local.mk\noverride export CFLAGS += -O2\nunexport X\n" +
          "vpath %.c src\n",
      );

      expect(classesOf(lines, "-include")).toEqual(["keyword"]);
      expect(classesOf(lines, "vpath")).toEqual(["keyword"]);
      for (const word of ["override", "export", "unexport"]) {
        expect(classesOf(lines, word)).toEqual(["storageKeyword"]);
      }
      expect(classesOf(lines, "CFLAGS")).toEqual(["propertyName"]);
      expect(classesOf(lines, "X")).toEqual(["propertyName"]);
    });

    it("colors comments, and not an escaped `#` or one inside a reference", () => {
      const lines = highlight("A = b \\# c $(d #) # e\n");

      expect(classesOf(lines, "# e")).toEqual(["comment"]);
      expect(lines[0].spans.filter((span) => span.cls === "comment"))
        .toHaveLength(1);
    });

    it("continues a line after an odd number of backslashes only", () => {
      const lines = highlight("# a \\\nB = 1\nC = 2 \\\\\nD = 3\n");

      expect(classesOf(lines, "B = 1")).toEqual(["comment"]);
      expect(classesOf(lines, "D")).toEqual(["propertyName"]);
    });

    it("colors a `define` block's keywords and the references in its body", () => {
      const lines = highlight(
        "define RULE =\n$(1): ; echo $$@\nendef\nX = y\n",
      );

      expect(classesOf(lines, "define")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "endef")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "RULE")).toEqual(["propertyName"]);
      expect(classesOf(lines, "1")).toEqual(["propertyName"]);
      expect(classesOf(lines, "echo")).toEqual(["plain"]);
      expect(classesOf(lines, "X")).toEqual(["propertyName"]);
    });

    it("reads a `#` after an even number of backslashes as a comment", () => {
      const lines = highlight("A = x\\\\# c\n");

      expect(classesOf(lines, "# c")).toEqual(["comment"]);
    });

    it("leaves a `define` block open at an `endef` after the recipe prefix", () => {
      const lines = highlight("define X\n\tendef\nendef\nY = 1\n");

      expect(classesOf(lines, "endef")).toEqual(["plain", "storageKeyword"]);
      expect(classesOf(lines, "Y")).toEqual(["propertyName"]);
    });

    it("colors the modifiers of a target-specific assignment", () => {
      const lines = highlight("t: export CFLAGS += -g\n");

      expect(classesOf(lines, "export")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "CFLAGS")).toEqual(["propertyName"]);
    });

    it("keeps the recipe prefix when `.RECIPEPREFIX` is set from a reference", () => {
      const lines = highlight(".RECIPEPREFIX := $(P)\nall:\n\techo hi\n");

      expect(classesOf(lines, "echo")).toEqual(["callName"]);
    });

    it("colors references nested many thousands deep", () => {
      const depth = 20000;
      const lines = highlight(
        `X = ${"$(a ".repeat(depth)}${")".repeat(depth)}\n`,
      );

      expect(lines[0].spans.filter((span) => span.cls === "callName"))
        .toHaveLength(0);
      expect(lines[0].spans.filter((span) => span.text === ")"))
        .toHaveLength(depth);
    });

    it("colors `$$` before a variable as part of the shell word it starts", () => {
      const lines = highlight("test:\n\tGOFLAGS=$$GOFLAGS go test ./...\n");

      expect(classesOf(lines, "go")).toEqual(["callName"]);
      expect(classesOf(lines, "GOFLAGS")).toEqual(["propertyName"]);
    });

    it("colors all of a rule's recipe lines as one script under `.ONESHELL`", () => {
      const lines = highlight(
        ".ONESHELL:\nall:\n\tif true; then\n# note\n\t  echo hi\n\tfi\n",
      );

      expect(classesOf(lines, "fi")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "# note")).toEqual(["comment"]);
    });

    it("recognizes a directive with a comment straight after it", () => {
      const lines = highlight(
        "all:\nifdef X\n\techo a\nendif# done\n\techo b\n",
      );

      expect(classesOf(lines, "endif")).toEqual(["controlKeyword"]);
      expect(classesOf(lines, "echo")).toEqual(["callName"]);
    });

    it("reads a variable named like a directive as a variable", () => {
      const document = makeLanguage.parseDocument("ifdef = 1\nexport = 2\n");

      expect(classesOf(document.lines, "ifdef")).toEqual(["propertyName"]);
      expect(document.structure.map((node) => node.label)).toEqual([
        "ifdef",
        "export",
      ]);
    });

    it("keeps escaped characters inside a target's name", () => {
      const document = makeLanguage.parseDocument("a\\#b a\\:c a\\;d: e\n");

      expect(document.structure.map((node) => node.label)).toEqual([
        "a\\#b",
        "a\\:c",
        "a\\;d",
      ]);
    });

    it("ends a target's name where a backslash continues the line", () => {
      const document = makeLanguage.parseDocument("a\\\nb: c\n");

      expect(document.structure.map((node) => node.label)).toEqual(["a", "b"]);
    });

    it("colors a stray `endef` as a keyword", () => {
      const lines = highlight("endef # orphan\nX = 1\n");

      expect(classesOf(lines, "endef")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "# orphan")).toEqual(["comment"]);
    });

    it("colors references in a long run of unclosed references in a recipe", () => {
      const depth = 20000;
      const lines = highlight(`all:\n\techo ${"$(a ".repeat(depth)}\n`);

      expect(lines[1].spans.filter((span) => span.text === "(")).toHaveLength(
        depth,
      );
    });

    it("tolerates an unclosed reference and an unclosed `define`", () => {
      const lines = highlight("all:\n\techo $(if $(X),\nY = 1\ndefine Z\nbody");

      expect(classesOf(lines, "if")).toEqual(["callName"]);
      expect(classesOf(lines, "Y")).toEqual(["propertyName"]);
      expect(classesOf(lines, "body")).toEqual(["plain"]);
    });
  });

  describe("structure", () => {
    it("lists targets other than special ones, and the variables assigned", () => {
      const document = makeLanguage.parseDocument(
        "CC ?= cc\n.PHONY: all\nall build: main.o\n\t$(CC) -o $@ $^\n\n" +
          "debug: CFLAGS += -g\n$(OUT): x\ndefine BODY\nx\nendef\n" +
          "define $(NAME)\nendef\n",
      );

      expect(document.structure.map((node) => [
        node.kind,
        node.label,
        node.startLine,
        node.endLine,
      ])).toEqual([
        ["variable", "CC", 0, 0],
        ["function", "all", 2, 3],
        ["function", "build", 2, 3],
        ["variable", "define BODY", 7, 9],
      ]);
      expect(document.definitions.get("build")?.[0].startLine).toBe(2);
      expect(document.definitions.get("CC")?.[0].startLine).toBe(0);
    });

    it("names a `define` block without its line ending or comment", () => {
      const document = makeLanguage.parseDocument(
        "define A\r\nx\r\nendef\r\ndefine B # note\nendef\n",
      );

      expect(document.structure.map((node) => node.label)).toEqual([
        "define A",
        "define B",
      ]);
      expect(document.definitions.has("A")).toBe(true);
    });

    it("places a `define` block's name after its keyword", () => {
      const document = makeLanguage.parseDocument("define def\nendef\n");

      expect(document.structure[0].nameOffset).toBe("define ".length);
    });
  });
});
