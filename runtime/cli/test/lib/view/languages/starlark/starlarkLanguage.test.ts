import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../../../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../../../lib/view/diffdoc.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { starlarkLanguage } from "../../../../../lib/view/languages/starlark/language.ts";
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
  return starlarkLanguage.highlightLines(source);
}

describe("starlarkLanguage", () => {
  beforeAll(() => starlarkLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries the representative filenames and
    // aliases; these cases are the ones it does not.

    it("selects extensions in any case and exact names only in their own case", () => {
      for (const path of ["defs.BZL", "BUILD.Bazel", "main.STAR"]) {
        expect(languageForFile(path).id).toBe("starlark");
      }
      for (const path of ["build", "Build", "workspace", "zlib.build"]) {
        expect(languageForFile(path).id).not.toBe("starlark");
      }
    });

    it("leaves Meson build files, Dockerfiles, and Bazel's other files to other languages", () => {
      for (
        const path of [
          "meson.build",
          "Dockerfile.build",
          "build.sh",
          ".bazelrc",
          ".bazelversion",
        ]
      ) {
        expect(languageForFile(path).id).not.toBe("starlark");
      }
    });
  });

  describe("highlighting", () => {
    it("colors load as a keyword and rule calls as calls", () => {
      const lines = highlight([
        'load("//tools:defs.bzl", "go_library", lib = "go_test")',
        "",
        "go_library(",
        '    name = "sync",  # the package',
        '    srcs = glob(["*.go"]) + select({":race": ["race.go"]}),',
        "    marshal = False,",
        "    shards = 4,",
        ")",
      ].join("\n"));

      expect(classesOf(lines, "load")).toEqual(["keyword"]);
      expect(classesOf(lines, '"//tools:defs.bzl"')).toEqual(["string"]);
      expect(classesOf(lines, "lib")).toEqual(["propertyName"]);
      for (const callee of ["go_library", "glob", "select"]) {
        expect(classesOf(lines, callee)).toEqual(["callName"]);
      }
      for (const argument of ["name", "srcs", "marshal", "shards"]) {
        expect(classesOf(lines, argument)).toEqual(["propertyName"]);
      }
      expect(classesOf(lines, "# the package")).toEqual(["comment"]);
      expect(classesOf(lines, "False")).toEqual(["boolean"]);
      expect(classesOf(lines, "4")).toEqual(["number"]);
      expect(classesOf(lines, "+")).toEqual(["operator"]);
    });

    it("colors a name called load that is not a call as an identifier", () => {
      const lines = highlight("load = 1\nx = native.load");

      expect(classesOf(lines, "load")).toEqual(["identifier", "propertyName"]);
    });

    it("colors definitions, parameters, and control flow", () => {
      const lines = highlight([
        "def _impl(ctx, *srcs, **kwargs):",
        "    for f in ctx.files.srcs:",
        "        if not f.is_source:",
        '            fail("generated: %s" % f.path)',
        "    return [DefaultInfo(files = depset(srcs))]",
      ].join("\n"));

      expect(classesOf(lines, "def")).toEqual(["storageKeyword"]);
      expect(classesOf(lines, "_impl")).toEqual(["functionName"]);
      for (const parameter of ["ctx", "srcs", "kwargs"]) {
        expect(classesOf(lines, parameter)).toContain("parameter");
      }
      for (const keyword of ["for", "if", "return"]) {
        expect(classesOf(lines, keyword)).toEqual(["controlKeyword"]);
      }
      expect(classesOf(lines, "not")).toEqual(["operator"]);
      expect(classesOf(lines, "files")).toContain("propertyName");
      expect(classesOf(lines, "fail")).toEqual(["callName"]);
    });

    it("reconstructs malformed and incomplete input exactly", () => {
      for (
        const source of [
          'go_library(\n    name = "open',
          'load("//tools:defs.bzl"',
          "def f(:",
          '"""never closed',
          "a = [1,\r\nb = 2\r\n",
          "\ud800",
          "",
          " \t",
          'name = "café ☕ 😀"',
        ]
      ) {
        expect(verbatim(starlarkLanguage.parseDocument(source).lines)).toBe(
          source,
        );
      }
    });
  });

  describe("structure", () => {
    it("lists targets, assigned names, and functions outside functions", () => {
      const source = [
        'load("//tools:defs.bzl", "go_library")',
        'package(licenses = ["notice"])',
        'VISIBILITY = ["//:sandbox"]',
        "a, b = 1, 2",
        "go_library(",
        '    name = "sync",',
        ")",
        'native.cc_library(name = "libc")',
        "[go_test(name = n) for n in NAMES]",
        "if DEBUG:",
        '    sh_binary(name = "debug")',
        "def declare(name):",
        '    go_library(name = "inner")',
        "    helper = name",
        "    def nested():",
        "        pass",
        "my_rule = rule(implementation = _impl)",
      ].join("\n");
      const document = starlarkLanguage.parseDocument(source);

      expect(
        document.flatStructure.map((node) => [
          node.kind,
          node.label,
          node.depth,
          node.startLine,
        ]),
      ).toEqual([
        ["variable", "VISIBILITY", 0, 2],
        ["object", "go_library sync", 0, 4],
        ["object", "native.cc_library libc", 0, 7],
        ["object", "sh_binary debug", 0, 10],
        ["function", "def declare", 0, 11],
        ["function", "def nested", 1, 14],
        ["variable", "my_rule", 0, 16],
      ]);
      expect([...document.definitions.keys()]).toEqual([
        "VISIBILITY",
        "sync",
        "libc",
        "debug",
        "declare",
        "nested",
        "my_rule",
      ]);
      expect(document.flatStructure[1].nameOffset).toBe(
        source.indexOf('"sync"') + 1,
      );
    });

    it("declares no target for an empty or computed name", () => {
      const document = starlarkLanguage.parseDocument(
        'go_library(name = "")\ngo_test(name = PREFIX + "_test")',
      );

      expect(document.flatStructure).toEqual([]);
    });

    it("keeps the targets before a call left open while it is typed", () => {
      const document = starlarkLanguage.parseDocument(
        'go_library(name = "sync")\ngo_test(\n    name = "sync_test",\n',
      );

      expect(document.flatStructure.map((node) => node.label)).toEqual([
        "go_library sync",
      ]);
    });
  });

  describe("editing", () => {
    it("matches a complete re-highlight after each incremental update", () => {
      const source = [
        "# café ☕ and an astral 😀",
        'load("//tools:defs.bzl", "go_library")',
        "go_library(",
        '    name = "sync",',
        '    srcs = ["sync.go"],',
        ")",
        "",
      ].join("\n");
      const edits: [string, string][] = [
        ['"sync.go"', '"sync.go", "race.go"'],
        ["load(", "loader("],
        ["loader(", "load("],
        ['name = "sync"', 'name = "sync'],
        ["# café", "café"],
      ];
      const highlighter = starlarkLanguage.createHighlighter(source);
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

    it("colors a diff of an unavailable file", () => {
      const diff = [
        "diff --git a/runsc/container/BUILD b/runsc/container/BUILD",
        "--- a/runsc/container/BUILD",
        "+++ b/runsc/container/BUILD",
        "@@ -1,4 +1,3 @@",
        ' load("//tools:defs.bzl", "go_test")',
        " deps = [",
        '-    "//runsc/sandbox",',
        " ]",
        "",
      ].join("\n");
      const workspace: DiffWorkspace = {
        resolve: () => null,
        read: () => null,
      };
      const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

      expect(classesOf(doc.lines, "load")).toEqual(["keyword"]);
      expect(classesOf(doc.lines, '"//runsc/sandbox"')).toEqual(["string"]);
      expect(verbatim(doc.lines)).toBe(diff);
    });
  });
});
