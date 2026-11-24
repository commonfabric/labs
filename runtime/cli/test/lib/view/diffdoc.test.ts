import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseDiff } from "../../../lib/view/diff.ts";
import {
  _internal,
  buildDiffDocument,
  type DiffFileLanguages,
  type DiffWorkspace,
  WorkspaceCache,
} from "../../../lib/view/diffdoc.ts";
import {
  type Language,
  languageForFile,
} from "../../../lib/view/languages/language.ts";
import type { Span, ViewMode } from "../../../lib/view/model.ts";

const FILES = new Map([
  ["/ws/a.ts", "export function alpha() {\n  return 2;\n}\n"],
  ["/ws/b.ts", "export const beta = 2;\n"],
]);

const A_SECTION = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,3 @@",
  " export function alpha() {",
  "-  return 1;",
  "+  return 2;",
  " }",
];

const B_SECTION = [
  "diff --git a/b.ts b/b.ts",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1 @@",
  "-export const beta = 1;",
  "+export const beta = 2;",
];

const COMMIT = [
  "commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "Author: A <a@example.com>",
  "",
  "    Change both",
  "",
];

const LOG = [...COMMIT, ...A_SECTION, ...B_SECTION, ""].join("\n");

/** Builds of a diff over {@link FILES}, recording what they read and parse. */
function harness() {
  const reads: string[] = [];
  const parses: string[] = [];
  const ws: DiffWorkspace = {
    resolve: (path) => `/ws/${path}`,
    read: (absPath) => {
      reads.push(absPath);
      return FILES.get(absPath) ?? null;
    },
  };
  const language = languageForFile("/ws/a.ts");
  const counted: Language = {
    ...language,
    parseDocument: (text, fileName) => {
      // Fragments are parsed under the diff's relative paths; complete
      // workspace files under their absolute paths.
      if (fileName?.startsWith("/ws/")) parses.push(fileName);
      return language.parseDocument(text, fileName);
    },
  };
  const build = (
    text: string,
    cache?: WorkspaceCache,
    viewMode: ViewMode = "source",
  ) => {
    const model = parseDiff(text)!;
    const languages: DiffFileLanguages[] = model.files.map(() => ({
      oldLanguage: counted,
      newLanguage: counted,
    }));
    return buildDiffDocument(text, model, ws, cache, viewMode, languages);
  };
  return { reads, parses, build };
}

describe("diffdoc", () => {
  describe("buildDiffDocument()", () => {
    it("parses no complete file when it builds an unchanged diff again", () => {
      const { parses, build } = harness();
      const cache = new WorkspaceCache();
      const first = build(LOG, cache);
      expect(parses).toEqual(["/ws/a.ts", "/ws/b.ts"]);

      parses.length = 0;
      const second = build(LOG, cache);
      expect(parses).toEqual([]);
      expect(second.doc).toEqual(first.doc);
    });

    it("moves reused sections to where a changed diff puts them", () => {
      const { parses, build } = harness();
      const cache = new WorkspaceCache();
      const original = build(LOG, cache);
      const moved = LOG.replace("    Change both", "    Change\n    both");

      parses.length = 0;
      const reused = build(moved, cache);
      expect(parses).toEqual([]);
      const fresh = build(moved);
      expect(reused.doc).toEqual(fresh.doc);
      expect(reused.edit.lines).toEqual(fresh.edit.lines);
      const alphaLine = (doc: typeof fresh.doc) =>
        doc.definitions.get("alpha")?.[0]?.startLine;
      expect(alphaLine(reused.doc)).toBe(alphaLine(original.doc)! + 1);
      const offsets = Array.from({ length: moved.length }, (_, i) => i);
      expect(offsets.map((offset) => reused.maps.toFile(offset))).toEqual(
        offsets.map((offset) => fresh.maps.toFile(offset)),
      );
      expect(offsets.map((offset) => reused.maps.fromFile("/ws/a.ts", offset)))
        .toEqual(
          offsets.map((offset) => fresh.maps.fromFile("/ws/a.ts", offset)),
        );
    });

    it("parses again only the file whose section changed", () => {
      const { parses, build } = harness();
      const cache = new WorkspaceCache();
      build(LOG, cache);

      parses.length = 0;
      build(LOG.replace("-  return 1;", "-  return 0;"), cache);
      expect(parses).toEqual(["/ws/a.ts"]);
    });

    it("matches a fresh build after an edit to a removed line", () => {
      const { build } = harness();
      const cache = new WorkspaceCache();
      build(LOG, cache);
      const edited = LOG.replace("-  return 1;", "-  return 0;");

      const reused = build(edited, cache);
      const fresh = build(edited);
      expect(reused.doc).toEqual(fresh.doc);
      expect(reused.edit.oldFileLines(0)).toEqual(fresh.edit.oldFileLines(0));
      expect(reused.edit.oldFileLines(0)?.[1]?.text).toBe("  return 0;");
    });

    it("keeps the parses of the section it built last", () => {
      const { parses, build } = harness();
      const cache = new WorkspaceCache();
      build(LOG, cache);
      build(LOG.replace("-  return 1;", "-  return 0;"), cache);

      parses.length = 0;
      build(LOG.replace("-  return 1;", "-  return -1;"), cache);
      expect(parses).toEqual([]);
      build(
        LOG.replace("-export const beta = 1;", "-export const beta = 0;"),
        cache,
      );
      expect(parses).toEqual(["/ws/b.ts"]);
    });

    it("keeps only the sections its latest build used", () => {
      const { build } = harness();
      const cache = new WorkspaceCache();
      for (let edit = 0; edit < 5; edit++) {
        build(LOG.replace("-  return 1;", `-  return ${edit};`), cache);
      }
      expect(cache.sections("source").size).toBe(2);
    });

    it("reuses a section that neither side renders in either view mode", () => {
      const { parses, build } = harness();
      const cache = new WorkspaceCache();
      build(LOG, cache);

      parses.length = 0;
      build(LOG, cache, "rendered");
      build(LOG, cache);
      expect(parses).toEqual([]);
    });

    it("builds a section that renders separately for each view mode", () => {
      const diff = [
        "diff --git a/notes.md b/notes.md",
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1 +1 @@",
        "-old",
        "+new **value**",
        "",
      ].join("\n");
      const ws: DiffWorkspace = {
        resolve: (path) => `/ws/${path}`,
        read: (path) => path === "/ws/notes.md" ? "new **value**\n" : null,
      };
      const model = parseDiff(diff)!;
      const cache = new WorkspaceCache();
      const added = diff.split("\n").indexOf("+new **value**");
      const textIn = (viewMode: ViewMode) =>
        buildDiffDocument(diff, model, ws, cache, viewMode).doc.lines[added]
          .text;
      expect(textIn("source")).toBe("+new **value**");
      expect(textIn("rendered")).toBe("+new value");
      expect(textIn("source")).toBe("+new **value**");
    });

    it("colors a verified line from its own text when the complete file's colors do not match it", () => {
      const language = languageForFile("/ws/a.ts");
      const mismatched: Language = {
        ...language,
        parseDocument: (text, fileName) =>
          language.parseDocument(
            fileName?.startsWith("/ws/") ? text.replaceAll("2", "3") : text,
            fileName,
          ),
      };
      const model = parseDiff(LOG)!;
      const { doc, edit } = buildDiffDocument(
        LOG,
        model,
        {
          resolve: (path) => `/ws/${path}`,
          read: (path) => FILES.get(path) ?? null,
        },
        new WorkspaceCache(),
        "source",
        model.files.map(() => ({
          oldLanguage: mismatched,
          newLanguage: mismatched,
        })),
      );
      const added = LOG.split("\n").indexOf("+  return 2;");
      expect(doc.lines[added].spans.map((span) => span.text).join("")).toBe(
        "+  return 2;",
      );
      expect(doc.lines[added].spans.some((span) => span.text === "2")).toBe(
        true,
      );
      expect(edit.lines.has(added)).toBe(true);
    });

    it("parses a file that several sections show once per build", () => {
      const { parses, build } = harness();
      const older = A_SECTION.map((line) =>
        line.replace("return 1", "return 0").replace("return 2", "return 1")
      );
      const log = [...COMMIT, ...A_SECTION, ...COMMIT, ...older, ""].join("\n");
      const { doc } = build(log, new WorkspaceCache());
      expect(parses).toEqual(["/ws/a.ts"]);
      expect(doc.structure.map((node) => node.label)).toEqual([
        "▸ a.ts",
        "▸ a.ts",
      ]);
    });
  });

  describe("DiffEdit", () => {
    describe("oldFileLines()", () => {
      it("returns the complete old side of the file at an index", () => {
        const { build } = harness();
        const { edit } = build(LOG);
        const a = edit.oldFileLines(0);
        expect(a?.map((line) => line.text)).toEqual([
          "export function alpha() {",
          "  return 1;",
          "}",
          "",
        ]);
        expect(edit.oldFileLines(1)?.map((line) => line.text)).toEqual([
          "export const beta = 1;",
          "",
        ]);
        expect(edit.oldFileLines(2)).toBe(null);
      });
    });
  });

  describe("completeFileLine()", () => {
    const plain = { text: "+a = 1", spans: [], bg: "add" as const };
    const fileSpans: Span[] = [
      { col: 0, text: "a", cls: "identifier" },
      { col: 1, text: " = ", cls: "whitespace" },
      { col: 4, text: "1", cls: "number" },
    ];

    it("shows the complete file's spans one column past the marker", () => {
      const line = _internal.completeFileLine(plain, "+a = 1", fileSpans);

      expect(line?.text).toBe("+a = 1");
      expect(line?.bg).toBe("add");
      expect(line?.spans).toEqual([
        { col: 0, text: "+", cls: "diffAdd" },
        { col: 1, text: "a", cls: "identifier" },
        { col: 2, text: " = ", cls: "whitespace" },
        { col: 5, text: "1", cls: "number" },
      ]);
    });

    it("keeps a carriage return the diff added as whitespace", () => {
      const line = _internal.completeFileLine(plain, "+a = 1\r", fileSpans);

      expect(line?.spans.at(-1)).toEqual({
        col: 6,
        text: "\r",
        cls: "whitespace",
      });
    });

    it("shows a byte order mark the decoding removed as whitespace", () => {
      const line = _internal.completeFileLine(
        plain,
        "+\uFEFFa = 1",
        fileSpans,
      );

      expect(line?.spans.slice(0, 3)).toEqual([
        { col: 0, text: "+", cls: "diffAdd" },
        { col: 1, text: "\uFEFF", cls: "whitespace" },
        { col: 2, text: "a", cls: "identifier" },
      ]);
    });

    it("returns null for spans that leave more of the line than a carriage return", () => {
      expect(_internal.completeFileLine(plain, "+a = 12", fileSpans)).toBe(
        null,
      );
      expect(_internal.completeFileLine(plain, "+a = 1\r\r", fileSpans))
        .toBe(null);
    });

    it("keeps spans set on it in place of its own", () => {
      const line = _internal.completeFileLine(plain, "+a = 1", fileSpans)!;
      const replacement: Span[] = [{ col: 0, text: "+a = 1", cls: "plain" }];

      line.spans = replacement;

      expect(line.spans).toBe(replacement);
    });
  });

  describe("sharedParse()", () => {
    it("throws when asked for a key it did not count", () => {
      const parse = _internal.sharedParse(["/ws/a.ts"], new Map());
      const file = { fileText: "", fileDoc: null, fileLineStarts: [] };
      expect(parse("/ws/a.ts", () => file)).toBe(file);
      expect(() => parse("/ws/b.ts", () => file)).toThrow(
        "A diff build parsed /ws/b.ts, which it did not count.",
      );
    });
  });

  describe("WorkspaceCache", () => {
    describe("instance members", () => {
      describe("file()", () => {
        it("returns the workspace copy a build read", () => {
          const { build } = harness();
          const cache = new WorkspaceCache();
          expect(cache.file("/ws/a.ts")).toBe(undefined);
          build(LOG, cache);
          expect(cache.file("/ws/a.ts")?.fileText).toBe(FILES.get("/ws/a.ts"));
        });
      });

      describe("forget()", () => {
        it("makes the next build read the file and parse it again", () => {
          const { reads, parses, build } = harness();
          const cache = new WorkspaceCache();
          build(LOG, cache);
          cache.forget("/ws/b.ts");

          reads.length = 0;
          parses.length = 0;
          build(LOG, cache);
          expect(reads).toEqual(["/ws/b.ts"]);
          expect(parses).toEqual(["/ws/b.ts"]);
        });
      });

      describe("without()", () => {
        it("returns a copy that has forgotten the paths, leaving the original whole", () => {
          const { parses, build } = harness();
          const cache = new WorkspaceCache();
          build(LOG, cache);
          const copy = cache.without(["/ws/a.ts"]);
          expect(copy.file("/ws/a.ts")).toBe(undefined);
          expect(copy.file("/ws/b.ts")?.fileText).toBe(FILES.get("/ws/b.ts"));

          parses.length = 0;
          build(LOG, copy);
          expect(parses).toEqual(["/ws/a.ts"]);
          parses.length = 0;
          build(LOG, cache);
          expect(parses).toEqual([]);
        });
      });
    });
  });
});
