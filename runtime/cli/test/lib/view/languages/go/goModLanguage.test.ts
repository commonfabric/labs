import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { goModLanguage } from "../../../../../lib/view/languages/go/language.ts";
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

const MODULE = [
  "// The sandbox's module.",
  "module gvisor.dev/gvisor",
  "",
  "go 1.26.10",
  "toolchain go1.26.10",
  "",
  "require (",
  "\tgithub.com/creack/pty v1.1.24",
  "\tgithub.com/google/subcommands v1.0.2-0.20190508160503-636abe8753b8 // indirect",
  ")",
  "",
  "require golang.org/x/sys v0.42.0",
  "",
  "replace example.com/old v1.0.0 => ../old",
  'replace "example.com/quoted" => example.com/new v2.0.0+incompatible',
  "retract [v1.0.0, v1.0.5]",
  "godebug default=go1.21",
].join("\n");

describe("goModLanguage", () => {
  it("selects module and workspace files by their exact names", () => {
    expect(languageForFile("tools/cfc-vm/agent/go.mod").id).toBe("go-mod");
    expect(languageForFile("go.work").id).toBe("go-mod");
    for (const path of ["GO.MOD", "go.mod.orig", "notgo.mod"]) {
      expect(languageForFile(path).id).not.toBe("go-mod");
    }
  });

  it("colors directives, the declared module, versions, and paths", () => {
    const lines = goModLanguage.highlightLines(MODULE);

    expect(classesOf(lines, "// The sandbox's module.")).toEqual(["comment"]);
    expect(classesOf(lines, "// indirect")).toEqual(["comment"]);
    for (
      const directive of [
        "module",
        "go",
        "toolchain",
        "require",
        "replace",
        "retract",
        "godebug",
      ]
    ) {
      expect(classesOf(lines, directive)).toEqual(["keyword"]);
    }
    expect(classesOf(lines, "gvisor.dev/gvisor")).toEqual(["interfaceName"]);
    for (
      const version of [
        "1.26.10",
        "go1.26.10",
        "v1.1.24",
        "v1.0.2-0.20190508160503-636abe8753b8",
        "v2.0.0+incompatible",
        "v1.0.0",
      ]
    ) {
      expect(classesOf(lines, version)).toEqual(["number"]);
    }
    for (
      const path of [
        "github.com/creack/pty",
        "golang.org/x/sys",
        "../old",
        "default=go1.21",
      ]
    ) {
      expect(classesOf(lines, path)).toEqual(["identifier"]);
    }
    expect(classesOf(lines, '"example.com/quoted"')).toEqual(["string"]);
    expect(classesOf(lines, "=>")).toEqual(["operator"]);
    expect(classesOf(lines, "(")).toEqual(["bracket"]);
    expect(classesOf(lines, "[")).toEqual(["bracket"]);
    expect(classesOf(lines, ",")).toEqual(["punctuation"]);
    expect(verbatim(lines)).toBe(MODULE);
  });

  it("colors a word that names no directive as an identifier", () => {
    const lines = goModLanguage.highlightLines(
      "foo bar\nmodule a b\nrequire (\n\tgo v1.0.0\n)",
    );

    expect(classesOf(lines, "foo")).toEqual(["identifier"]);
    expect(classesOf(lines, "a")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "b")).toEqual(["identifier"]);
    expect(classesOf(lines, "go")).toEqual(["identifier"]);
  });

  it("declares the module path of a block and of a quoted path", () => {
    for (
      const [source, offset] of [
        ["module (\n\texample.com/m // the module\n)", 10],
        ['module "example.com/m"', 8],
      ] as const
    ) {
      const document = goModLanguage.parseDocument(source);

      expect(
        document.definitions.get("example.com/m")?.map((definition) =>
          definition.startOffset
        ),
      ).toHaveLength(1);
      expect(
        document.flatStructure.find((node) => node.name === "example.com/m")
          ?.nameOffset,
      ).toBe(offset);
    }
  });

  it("lists each directive, and each line of a block under it", () => {
    const document = goModLanguage.parseDocument(MODULE);

    expect(
      document.flatStructure.map((node) => [
        node.kind,
        node.label,
        node.depth,
        node.startLine,
        node.endLine,
      ]),
    ).toEqual([
      ["object", "module gvisor.dev/gvisor", 0, 1, 1],
      ["object", "go 1.26.10", 0, 3, 3],
      ["object", "toolchain go1.26.10", 0, 4, 4],
      ["object", "require", 0, 6, 9],
      ["variable", "github.com/creack/pty v1.1.24", 1, 7, 7],
      [
        "variable",
        "github.com/google/subcommands v1.0.2-0.20190508160503-636abe8753b8",
        1,
        8,
        8,
      ],
      ["object", "require golang.org/x/sys v0.42.0", 0, 11, 11],
      ["object", "replace example.com/old v1.0.0 => ../old", 0, 13, 13],
      [
        "object",
        'replace "example.com/quoted" => example.com/new v2.0.0+incompatible',
        0,
        14,
        14,
      ],
      ["object", "retract [v1.0.0, v1.0.5]", 0, 15, 15],
      ["object", "godebug default=go1.21", 0, 16, 16],
    ]);
    expect([...document.definitions.keys()]).toEqual(["gvisor.dev/gvisor"]);
  });

  it("colors a Go prerelease as a version, and a word holding a quote as one word", () => {
    const lines = goModLanguage.highlightLines(
      'go 1.21rc1\ntoolchain go1.22beta2\nrequire a"b v1.0.0\nreplace a =>b v1',
    );

    expect(classesOf(lines, "1.21rc1")).toEqual(["number"]);
    expect(classesOf(lines, "go1.22beta2")).toEqual(["number"]);
    expect(classesOf(lines, 'a"b')).toEqual(["identifier"]);
    // An arrow is a word of its own only where white space ends it.
    expect(classesOf(lines, "=>b")).toEqual(["identifier"]);
  });

  it("reads a directive's words up to a comment, even inside a word", () => {
    const lines = goModLanguage.highlightLines(
      "require a//b v1\nrequire module v1",
    );

    expect(classesOf(lines, "a")).toEqual(["identifier"]);
    expect(classesOf(lines, "//b v1")).toEqual(["comment"]);
    expect(classesOf(lines, "module")).toEqual(["identifier"]);
  });

  it("opens a block only after a directive, and closes it only at a line's start", () => {
    const document = goModLanguage.parseDocument(
      "go 1.22\n(\n\tmodule m\n)\nrequire (\n\ta )\n\tb v1\n)",
    );

    expect(
      document.flatStructure.map((node) => [node.label, node.depth]),
    ).toEqual([
      ["go 1.22", 0],
      ["(", 0],
      ["module m", 0],
      [")", 0],
      ["require", 0],
      ["a )", 1],
      ["b v1", 1],
    ]);
    expect([...document.definitions.keys()]).toEqual(["m"]);
  });

  it("ends a comment only at a line feed", () => {
    const lines = goModLanguage.highlightLines(
      "// see\u2028go (\n// x\rmodule m\nmodule n",
    );

    expect(classesOf(lines, "// see\u2028go (")).toEqual(["comment"]);
    expect(classesOf(lines, "// x\rmodule m")).toEqual(["comment"]);
    expect(
      goModLanguage.parseDocument("// x\rmodule m\nmodule n")
        .flatStructure.map((node) => node.label),
    ).toEqual(["module n"]);
  });

  it("ends a string at the end of its line", () => {
    const document = goModLanguage.parseDocument(
      "require (\n\t`foo\n\tbar v1\n)\ngo 1.22",
    );

    expect(
      document.flatStructure.map((node) => [node.label, node.depth]),
    ).toEqual([
      ["require", 0],
      ["`foo", 1],
      ["bar v1", 1],
      ["go 1.22", 0],
    ]);
    expect(classesOf(document.lines, "bar")).toEqual(["identifier"]);
  });

  it("opens a block only at the end of a directive's line", () => {
    const document = goModLanguage.parseDocument(
      "require (a v1.0.0)\nmodule m\nrequire ( // deps\n\ta v1\n)\nexclude ()",
    );

    expect(
      document.flatStructure.map((node) => [
        node.label,
        node.depth,
        node.startLine,
        node.endLine,
      ]),
    ).toEqual([
      ["require (a v1.0.0)", 0, 0, 0],
      ["module m", 0, 1, 1],
      ["require", 0, 2, 4],
      ["a v1", 1, 3, 3],
      ["exclude", 0, 5, 5],
    ]);
  });

  it("extends a block that is never closed to its last line", () => {
    const document = goModLanguage.parseDocument(
      "require (\n\tgithub.com/a/b v1.0.0\n\n\tgithub.com/c/d v2.0.0",
    );

    expect(
      document.flatStructure.map((node) => [
        node.label,
        node.startLine,
        node.endLine,
      ]),
    ).toEqual([
      ["require", 0, 3],
      ["github.com/a/b v1.0.0", 1, 1],
      ["github.com/c/d v2.0.0", 3, 3],
    ]);
  });

  it("reconstructs malformed and incomplete input exactly", () => {
    for (
      const source of [
        'module "open',
        "module `raw\nstring`",
        ")\n)",
        "require (\n)",
        "replace a =>",
        "module x\r\n\r\ngo 1.22\r\n",
        "a//b /c",
        "\ud800",
        "",
        " \t",
        "module café/☕ // 😀",
      ]
    ) {
      expect(verbatim(goModLanguage.parseDocument(source).lines)).toBe(
        source,
      );
    }
  });

  it("matches a complete re-highlight after each update", () => {
    const highlighter = goModLanguage.createHighlighter(MODULE);
    let current = MODULE;
    for (
      const [from, to] of [
        ["require (", "require"],
        ["v1.1.24", "v1.1.25"],
        ["module", "modul"],
      ]
    ) {
      current = current.replace(from, to);
      expect(highlighter.update(current)).toEqual(
        goModLanguage.highlightLines(current),
      );
    }
  });
});
