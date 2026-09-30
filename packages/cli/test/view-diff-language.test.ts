/**
 * Tests how a diff view decides the language of each side of each file: from
 * the side's path, and for a path no language claims, from the side's content
 * in the workspace, in Git, or in a hunk that starts at its first line. Also
 * tests that the semantic service answers only for the files a diff reads as
 * TypeScript.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { parseDiff } from "../lib/view/diff.ts";
import { diffCounts } from "../lib/view/diffcounts.ts";
import {
  buildDiffDocument,
  diffLanguages,
  type DiffWorkspace,
} from "../lib/view/diffdoc.ts";
import { createDiffHighlighter, diffSource } from "../lib/view/diffedit.ts";
import {
  diffSemanticsFor,
  prepareLanguages,
} from "../lib/view/languages/language.ts";
import { plainTextLanguage } from "../lib/view/languages/plain-text/language.ts";
import { pythonLanguage } from "../lib/view/languages/python/language.ts";
import { shellLanguage } from "../lib/view/languages/shell/language.ts";
import { typeScriptLanguage } from "../lib/view/languages/typescript/language.ts";
import type { Line, TokenClass } from "../lib/view/model.ts";

// Shell and Python color through their synchronous entry points, which show
// plain text until their parsers have loaded.
await prepareLanguages([shellLanguage, pythonLanguage]);

const SCRIPT_PATH = "bin/greet";

const SCRIPT = [
  "#!/usr/bin/env bash",
  "set -eu",
  "",
  "",
  "greet() {",
  '  echo "hello" "$1"',
  "}",
  "",
].join("\n");

/** A change to the script that leaves its shebang outside every hunk. */
const BODY_DIFF = [
  `diff --git a/${SCRIPT_PATH} b/${SCRIPT_PATH}`,
  "index 1111111..2222222 100755",
  `--- a/${SCRIPT_PATH}`,
  `+++ b/${SCRIPT_PATH}`,
  "@@ -5,2 +5,2 @@",
  " greet() {",
  '-  echo "hi" "$1"',
  '+  echo "hello" "$1"',
  "",
].join("\n");

/** A change to the script whose hunk shows its shebang. */
const TOP_DIFF = [
  `diff --git a/${SCRIPT_PATH} b/${SCRIPT_PATH}`,
  `--- a/${SCRIPT_PATH}`,
  `+++ b/${SCRIPT_PATH}`,
  "@@ -1,2 +1,2 @@",
  " #!/usr/bin/env bash",
  '-echo "hi"',
  '+echo "hello"',
  "",
].join("\n");

const UNAVAILABLE_WORKSPACE: DiffWorkspace = {
  resolve: () => null,
  read: () => null,
};

/** A workspace holding the script at a path no real file occupies. */
function scriptWorkspace(text = SCRIPT): DiffWorkspace {
  return {
    resolve: (path) => path === SCRIPT_PATH ? `/workspace/${path}` : null,
    read: (absPath) => absPath === `/workspace/${SCRIPT_PATH}` ? text : null,
  };
}

/** The token classes of every span with exactly this text. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

/** The document lines one side of a diff tints. */
function tinted(lines: readonly Line[], bg: "add" | "del"): Line[] {
  return lines.filter((line) => line.bg === bg);
}

describe("diff file languages", () => {
  describe("diffLanguages()", () => {
    it("returns shell for both sides when the workspace file has a `bash` shebang", () => {
      expect(
        diffLanguages(BODY_DIFF, parseDiff(BODY_DIFF)!, scriptWorkspace()),
      ).toEqual([{ oldLanguage: shellLanguage, newLanguage: shellLanguage }]);
    });

    it("returns plain text when neither side's path or content selects a language", () => {
      expect(diffLanguages(BODY_DIFF, parseDiff(BODY_DIFF)!)).toEqual([
        { oldLanguage: plainTextLanguage, newLanguage: plainTextLanguage },
      ]);
      expect(
        diffLanguages(
          BODY_DIFF,
          parseDiff(BODY_DIFF)!,
          scriptWorkspace("echo no shebang\n"),
        ),
      ).toEqual([
        { oldLanguage: plainTextLanguage, newLanguage: plainTextLanguage },
      ]);
    });

    it("returns shell from a hunk that starts at the first line with no workspace", () => {
      expect(diffLanguages(TOP_DIFF, parseDiff(TOP_DIFF)!)).toEqual([
        { oldLanguage: shellLanguage, newLanguage: shellLanguage },
      ]);
    });

    it("returns shell from the old Git blob when the workspace has no file", () => {
      const requested: string[][] = [];
      const ws: DiffWorkspace = {
        ...UNAVAILABLE_WORKSPACE,
        readBlobs: (objects) => {
          requested.push([...objects]);
          return new Map(
            objects.filter((object) => object === "1111111").map((
              object,
            ) => [object, SCRIPT]),
          );
        },
      };

      expect(diffLanguages(BODY_DIFF, parseDiff(BODY_DIFF)!, ws)).toEqual([
        { oldLanguage: shellLanguage, newLanguage: shellLanguage },
      ]);
      expect(requested).toEqual([["1111111"]]);
    });

    it("reads neither the workspace nor Git for a path a language claims", () => {
      const renamed = BODY_DIFF.replaceAll(SCRIPT_PATH, "bin/greet.sh");
      const ws: DiffWorkspace = {
        resolve: () => {
          throw new Error("resolved a claimed path");
        },
        read: () => {
          throw new Error("read a claimed path");
        },
        readBlobs: (objects) => {
          expect(objects).toEqual([]);
          return new Map();
        },
      };

      expect(diffLanguages(renamed, parseDiff(renamed)!, ws)).toEqual([
        { oldLanguage: shellLanguage, newLanguage: shellLanguage },
      ]);
    });

    it("returns each side's own language when the two sides' shebangs differ", () => {
      const diff = TOP_DIFF.replace(
        " #!/usr/bin/env bash",
        "-#!/usr/bin/env node\n+#!/usr/bin/env bash",
      );

      expect(diffLanguages(diff, parseDiff(diff)!)).toEqual([
        { oldLanguage: typeScriptLanguage, newLanguage: shellLanguage },
      ]);
    });

    it("returns a first-line hunk's language over a workspace file that no longer matches it", () => {
      const diff = TOP_DIFF.replace(
        " #!/usr/bin/env bash",
        "-#!/usr/bin/env bash\n+#!/usr/bin/env node",
      );

      expect(diffLanguages(diff, parseDiff(diff)!, scriptWorkspace())).toEqual(
        [{ oldLanguage: shellLanguage, newLanguage: typeScriptLanguage }],
      );
    });
  });

  describe("buildDiffDocument()", () => {
    it("colors both sides of an extensionless file by its workspace shebang", () => {
      const { doc } = buildDiffDocument(
        BODY_DIFF,
        parseDiff(BODY_DIFF)!,
        scriptWorkspace(),
      );

      expect(classesOf(doc.lines, "greet")).toEqual(["functionName"]);
      expect(classesOf(tinted(doc.lines, "add"), '"hello"')).toEqual([
        "string",
      ]);
      expect(classesOf(tinted(doc.lines, "del"), '"hi"')).toEqual(["string"]);
    });

    it("leaves an extensionless file plain when nothing shows its shebang", () => {
      const { doc } = buildDiffDocument(
        BODY_DIFF,
        parseDiff(BODY_DIFF)!,
        UNAVAILABLE_WORKSPACE,
      );

      expect(classesOf(doc.lines, "greet")).toEqual([]);
      expect(classesOf(tinted(doc.lines, "add"), '"hello"')).toEqual([]);
    });

    it("colors an extensionless file by a shebang in a hunk at its first line", () => {
      const { doc } = buildDiffDocument(
        TOP_DIFF,
        parseDiff(TOP_DIFF)!,
        UNAVAILABLE_WORKSPACE,
      );

      expect(classesOf(tinted(doc.lines, "add"), '"hello"')).toEqual([
        "string",
      ]);
      expect(classesOf(tinted(doc.lines, "del"), '"hi"')).toEqual(["string"]);
    });

    it("colors each side of a file in that side's own language", () => {
      const diff = [
        `diff --git a/${SCRIPT_PATH} b/${SCRIPT_PATH}`,
        `--- a/${SCRIPT_PATH}`,
        `+++ b/${SCRIPT_PATH}`,
        "@@ -1,2 +1,2 @@",
        "-#!/usr/bin/env node",
        "-function greet() {}",
        "+#!/usr/bin/env python3",
        "+def greet(): pass",
        "",
      ].join("\n");

      const { doc } = buildDiffDocument(
        diff,
        parseDiff(diff)!,
        UNAVAILABLE_WORKSPACE,
      );

      // Python would read the removed `function` as a call.
      expect(classesOf(tinted(doc.lines, "del"), "function")).toEqual([
        "storageKeyword",
      ]);
      expect(classesOf(tinted(doc.lines, "add"), "def")).toEqual([
        "storageKeyword",
      ]);
    });

    it("reads one workspace file in each language its sections decide", () => {
      // The first section's hunk shows a Python shebang that the workspace
      // file no longer has, so only that section reads the file as Python.

      const ws = scriptWorkspace("#!/usr/bin/perl\nx = 'a'\ny = 'c'\n");
      const diff = [
        `diff --git a/${SCRIPT_PATH} b/${SCRIPT_PATH}`,
        `--- a/${SCRIPT_PATH}`,
        `+++ b/${SCRIPT_PATH}`,
        "@@ -1,2 +1,2 @@",
        " #!/usr/bin/env python3",
        "-x = 1",
        "+x = 'b'",
        `diff --git a/${SCRIPT_PATH} b/${SCRIPT_PATH}`,
        `--- a/${SCRIPT_PATH}`,
        `+++ b/${SCRIPT_PATH}`,
        "@@ -2,2 +2,2 @@",
        " x = 'a'",
        "-y = 2",
        "+y = 'c'",
        "",
      ].join("\n");
      const model = parseDiff(diff)!;

      expect(diffLanguages(diff, model, ws)).toEqual([
        { oldLanguage: pythonLanguage, newLanguage: pythonLanguage },
        { oldLanguage: plainTextLanguage, newLanguage: plainTextLanguage },
      ]);
      const { doc } = buildDiffDocument(diff, model, ws, new Map());
      const classesOn = (text: string) =>
        doc.lines.find((line) => line.text === text)?.spans.map((span) =>
          span.cls
        );
      expect(classesOn("+x = 'b'")).toContain("string");
      expect(classesOn(" x = 'a'")).not.toContain("string");
      expect(classesOn("+y = 'c'")).not.toContain("string");
      expect(classesOn("+y = 'c'")).toContain("plain");
    });

    it("throws when the languages do not match the diff's files", () => {
      expect(() =>
        buildDiffDocument(
          BODY_DIFF,
          parseDiff(BODY_DIFF)!,
          UNAVAILABLE_WORKSPACE,
          undefined,
          "source",
          [],
        )
      ).toThrow("A diff of 1 files was given languages for 0.");
    });
  });

  describe("diffCounts()", () => {
    it("discounts a comment written in the language decided for an extensionless file", () => {
      const diff = BODY_DIFF.replace("@@ -5,2 +5,2 @@", "@@ -5,2 +5,3 @@")
        .replace(
          '+  echo "hello" "$1"',
          '+  echo "hello" "$1"\n+  # greets by name',
        );
      const countAdds = (ws: DiffWorkspace) => {
        const { doc, edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
        return diffCounts(
          diff,
          doc.lines,
          "comments",
          diffSource(ws, edit).diffCountContexts!(diff),
        ).totals.adds;
      };

      expect(countAdds(scriptWorkspace())).toBe(1);
      expect(countAdds(UNAVAILABLE_WORKSPACE)).toBe(2);
    });

    it("counts heredoc lines across diff gaps in an extensionless script its shebang selects", () => {
      // Each hunk colors its `#` lines as comments on its own, so only the
      // heredoc carried from the first hunk shows they are data.

      const diff = [
        "diff --git a/hooks/post-merge b/hooks/post-merge",
        "--- a/hooks/post-merge",
        "+++ b/hooks/post-merge",
        "@@ -1,3 +1,3 @@",
        " #!/bin/sh",
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
      const { doc } = buildDiffDocument(
        diff,
        parseDiff(diff)!,
        UNAVAILABLE_WORKSPACE,
      );

      expect(diffCounts(diff, doc.lines, "comments").totals).toEqual({
        adds: 3,
        dels: 3,
      });
    });
  });

  describe("live diff edits", () => {
    it("recolor an edited line in the language decided for its file", () => {
      const ws = scriptWorkspace();
      const { doc, edit } = buildDiffDocument(
        BODY_DIFF,
        parseDiff(BODY_DIFF)!,
        ws,
      );
      const edited = BODY_DIFF.replace(
        '+  echo "hello" "$1"',
        '+  echo "howdy" "$1"',
      );

      const lines = diffSource(ws, edit).createHighlighter!(
        BODY_DIFF,
        doc.lines,
      )
        .update(edited);

      expect(classesOf(lines, '"howdy"')).toEqual(["string"]);
    });

    it("recolor an edited line as plain text when no language was decided", () => {
      const edited = BODY_DIFF.replace(
        '+  echo "hello" "$1"',
        '+  echo "howdy" "$1"',
      );

      const lines = createDiffHighlighter(BODY_DIFF).update(edited);

      expect(classesOf(lines, '"howdy"')).toEqual([]);
    });

    it("keep the decided language when an edit reparses the diff", () => {
      // The reparse reaches a workspace that no longer shows the shebang, so
      // only the language decided when the diff opened can color the edit.

      const { edit } = buildDiffDocument(
        BODY_DIFF,
        parseDiff(BODY_DIFF)!,
        scriptWorkspace(),
      );
      const edited = BODY_DIFF.replace(
        '+  echo "hello" "$1"',
        '+  echo "howdy" "$1"',
      );

      const reparsed = diffSource(UNAVAILABLE_WORKSPACE, edit).parse(edited);

      expect(classesOf(reparsed.lines, '"howdy"')).toEqual(["string"]);
    });

    it("recolor each section of one file in the language that section decides", () => {
      // The workspace file's shebang names no language, so each section's new
      // side takes the language of its own old blob: Python, then shell.

      const ws: DiffWorkspace = {
        resolve: (path) => `/workspace/${path}`,
        read: () => '#!/usr/bin/perl\nx\necho "one"\ny\necho "two"\n',
        readBlobs: (objects) =>
          new Map(
            objects.map((object) => [
              object,
              object === "1111111"
                ? "#!/usr/bin/env python3\n"
                : "#!/usr/bin/env bash\n",
            ]),
          ),
      };
      const section = (
        index: string,
        line: number,
        from: string,
        to: string,
      ) => [
        `diff --git a/${SCRIPT_PATH} b/${SCRIPT_PATH}`,
        `index ${index} 100755`,
        `--- a/${SCRIPT_PATH}`,
        `+++ b/${SCRIPT_PATH}`,
        `@@ -${line} +${line} @@`,
        `-echo "${from}"`,
        `+echo "${to}"`,
      ];
      const diff = [
        ...section("1111111..2222222", 3, "zero", "one"),
        ...section("3333333..4444444", 5, "old", "two"),
        "",
      ].join("\n");
      const model = parseDiff(diff)!;
      expect(
        diffLanguages(diff, model, ws).map(({ newLanguage }) => newLanguage),
      )
        .toEqual([pythonLanguage, shellLanguage]);
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const highlighter = diffSource(ws, edit).createHighlighter!(
        diff,
        doc.lines,
      );

      highlighter.update(diff.replace('+echo "one"', '+echo "uno"'));
      const lines = highlighter.update(
        diff.replace('+echo "one"', '+echo "uno"').replace(
          '+echo "two"',
          '+echo "dos"',
        ),
      );

      const edited = lines.find((line) => line.text === '+echo "dos"')!;
      expect(edited.spans.find((span) => span.text === "echo")?.cls).toBe(
        "callName",
      );
    });

    it("recolor and count a diff whose files changed in the languages the edited diff and workspace decide", () => {
      // Only the workspace shows the added section's shebang, since its hunk
      // does not start at the file's first line.

      const ws: DiffWorkspace = {
        resolve: (path) => `/workspace/${path}`,
        read: () => SCRIPT,
      };
      const { doc, edit } = buildDiffDocument(
        BODY_DIFF,
        parseDiff(BODY_DIFF)!,
        ws,
      );
      const source = diffSource(ws, edit);
      const edited = BODY_DIFF + BODY_DIFF.replaceAll(SCRIPT_PATH, "bin/other")
        .replace('+  echo "hello" "$1"', '+  echo "welcome" "$1"');

      const lines = source.createHighlighter!(BODY_DIFF, doc.lines).update(
        edited,
      );

      expect(classesOf(lines, '"welcome"')).toEqual(["string"]);
      expect(
        source.diffCountContexts!(edited)?.map(({ languages }) => languages),
      ).toEqual([
        { oldLanguage: shellLanguage, newLanguage: shellLanguage },
        { oldLanguage: shellLanguage, newLanguage: shellLanguage },
      ]);
    });
  });

  describe("semantic service", () => {
    /** Two scripts whose bodies are the same TypeScript and whose shebangs
     * select TypeScript and shell. */
    const SCRIPTS = new Map([
      ["tool", "#!/usr/bin/env -S deno run"],
      ["hook", "#!/usr/bin/env bash"],
    ]);
    const BODY = ["const answer = 42;", "console.log(answer);", ""];
    const SCRIPTS_DIFF = [...SCRIPTS].flatMap(([path, shebang]) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,3 +1,3 @@",
      ` ${shebang}`,
      "-const answer = 41;",
      "+const answer = 42;",
      " console.log(answer);",
    ]).concat("").join("\n");

    /** The diff offsets of `answer` in the binding and the use in `path`. */
    function answerOffsets(path: string): { binding: number; use: number } {
      const header = SCRIPTS_DIFF.indexOf(`diff --git a/${path} `);
      const answerAfter = (text: string) =>
        SCRIPTS_DIFF.indexOf("answer", SCRIPTS_DIFF.indexOf(text, header));
      return {
        binding: answerAfter("+const answer"),
        use: answerAfter("console.log("),
      };
    }

    it("serves the extensionless files it reads as TypeScript, and no others", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "deno.json"), "{}");
        for (const [path, shebang] of SCRIPTS) {
          Deno.writeTextFileSync(
            join(root, path),
            [shebang, ...BODY].join("\n"),
          );
        }
        const { maps } = buildDiffDocument(
          SCRIPTS_DIFF,
          parseDiff(SCRIPTS_DIFF)!,
          {
            resolve: (path) => join(root, path),
            read: (absPath) => Deno.readTextFileSync(absPath),
          },
        );
        expect([...maps.rootFiles.values()]).toEqual([
          typeScriptLanguage,
          shellLanguage,
        ]);
        const semantics = diffSemanticsFor(SCRIPTS_DIFF, maps, { cwd: root })!;

        const tool = answerOffsets("tool");
        expect(semantics.typeAt(tool.binding)).toBe("42");
        expect(semantics.definitionOf(tool.use).map((d) => d.blobOffset))
          .toEqual([tool.binding]);

        const hook = answerOffsets("hook");
        expect(semantics.typeAt(hook.binding)).toBeNull();
        expect(semantics.definitionOf(hook.use)).toEqual([]);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  });
});
