import { expect } from "@std/expect";

import { parseDiff } from "../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
  WorkspaceCache,
} from "../../../lib/view/diffdoc.ts";
import { diffSource } from "../../../lib/view/diffedit.ts";
import type { Document } from "../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A diff of a Markdown file, which is colored from the whole file. */
const OPENED = [
  "diff --git a/notes.md b/notes.md",
  "--- a/notes.md",
  "+++ b/notes.md",
  "@@ -1,3 +1,3 @@",
  " # Notes",
  "-old",
  "+text",
  " const a = 1;",
  "",
].join("\n");

/**
 * {@link OPENED} with its added line edited to open a code block, which colors
 * the line after it as code.
 */
const EDITED = OPENED.replace("+text", "+```ts");

const FILE = "# Notes\ntext\nconst a = 1;\n";

/**
 * Returns the class of the span reading the code line in `doc`, which is
 * `plain` outside a code block and `string` inside one.
 */
function codeClass(doc: Document): string | undefined {
  return doc.lines.flatMap((line) => line.spans).find((span) =>
    span.text === "const a = 1;"
  )?.cls;
}

/**
 * Returns the diff source of {@link OPENED} over a workspace holding {@link
 * FILE}, which saves to `files`.
 */
function opened() {
  const files = new Map([["/ws/notes.md", FILE]]);
  const ws: DiffWorkspace = {
    resolve: (path) => `/ws/${path}`,
    read: (path) => files.get(path) ?? null,
    write: (path, text) => files.set(path, text),
  };
  const cache = new WorkspaceCache();
  const { doc, edit } = buildDiffDocument(
    OPENED,
    parseDiff(OPENED)!,
    ws,
    cache,
  );
  return { doc, files, ws, source: diffSource(ws, edit, cache) };
}

describe("diffedit", () => {
  describe("diffSource()", () => {
    describe("parse()", () => {
      it("parses the diff as opened as its first build did", () => {
        const { doc, source } = opened();

        expect(source.parse(OPENED)).toEqual(doc);
        expect(codeClass(doc)).toBe("plain");
      });

      it("colors a file read whole from its edited text, however often it parses that text", () => {
        const { source } = opened();

        const first = source.parse(EDITED);
        const second = source.parse(EDITED);

        expect(codeClass(first)).toBe("string");
        expect(second).toEqual(first);
        expect(codeClass(source.parse(OPENED))).toBe("plain");
      });

      it("colors an edited line of a file no language reads whole from its own text", () => {
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-const a = 1;",
          "+const a = 2;",
          "",
        ].join("\n");
        const files = new Map([["/ws/a.ts", "const a = 2;\n"]]);
        const ws: DiffWorkspace = {
          resolve: (path) => `/ws/${path}`,
          read: (path) => files.get(path) ?? null,
        };
        const cache = new WorkspaceCache();
        const { edit } = buildDiffDocument(diff, parseDiff(diff)!, ws, cache);
        const source = diffSource(ws, edit, cache);

        const edited = source.parse(
          diff.replace("+const a = 2;", "+const a = 3;"),
        );

        const added = edited.lines[5];
        expect(added.text).toBe("+const a = 3;");
        expect(added.spans.find((span) => span.text === "3")?.cls).toBe(
          "number",
        );
      });

      it("colors the diff from the saved file after a save", () => {
        const { files, ws, source } = opened();
        source.parse(EDITED);

        source.save(EDITED, source.lineEndingProvenance?.(EDITED) ?? []);
        const parsed = source.parse(EDITED);

        expect(files.get("/ws/notes.md")).toBe(
          "# Notes\n```ts\nconst a = 1;\n",
        );
        expect(parsed).toEqual(
          buildDiffDocument(EDITED, parseDiff(EDITED)!, ws).doc,
        );
        expect(codeClass(parsed)).toBe("string");
        expect(codeClass(source.parse(OPENED))).toBe("plain");
      });
    });
  });
});
