import { assert, assertEquals } from "@std/assert";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";

const NO_WS: DiffWorkspace = { resolve: () => null, read: () => null };

//
// a deleted Markdown file keeps Markdown highlighting
//

Deno.test("buildDiffDocument: a deleted Markdown file (new path /dev/null) highlights as Markdown", () => {
  // A plain `diff -u doc.md /dev/null` has no `diff --git` line, so the new
  // path is /dev/null (absent) while the old path is the .md file. The markdown
  // flag must fall back to the old path; otherwise the removed heading reads as
  // TypeScript and loses its heading structure.
  const diff = `--- doc.md\t2026-06-30 14:00:10
+++ /dev/null\t2026-06-30 14:00:10
@@ -1,6 +0,0 @@
-# Title
-
-Some prose here.
-
-- item one
-- item two
`;
  const model = parseDiff(diff)!;
  // Precondition for the bug: the new path is absent, the old path is the .md.
  assertEquals(
    model.files[0].newPath,
    undefined,
    "deleted file has no new path",
  );
  assertEquals(model.files[0].oldPath, "doc.md", "old path is the .md file");

  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const rawLines = diff.split("\n");
  const headIdx = rawLines.indexOf("-# Title");

  // The heading content past the diff marker is one Markdown heading span, not
  // a soup of TypeScript identifiers.
  const codeSpans = doc.lines[headIdx].spans.filter((s) => s.col >= 1);
  assertEquals(
    codeSpans.map((s) => s.cls),
    ["sectionHeader"],
    `the removed heading is a Markdown section header, got ${
      JSON.stringify(doc.lines[headIdx].spans)
    }`,
  );
  // The marker keeps its removal color.
  assertEquals(doc.lines[headIdx].spans[0].cls, "diffDel", "marker is diffDel");

  // No TypeScript identifier classification leaked onto the removed prose.
  assert(
    !doc.lines.some((l) => l.spans.some((s) => s.cls === "identifier")),
    "no TypeScript identifier spans on a deleted Markdown file",
  );
});

//
// a deleted non-Markdown file is unaffected by the fallback
//

Deno.test("buildDiffDocument: a deleted .ts file (new path /dev/null) stays TypeScript", () => {
  // The old-path fallback must not turn a deleted TypeScript file into
  // Markdown: isMarkdownPath of the .ts old path is false.
  const diff = `--- m.ts\t2026-06-30 14:00:10
+++ /dev/null\t2026-06-30 14:00:10
@@ -1,1 +0,0 @@
-const a = 1;
`;
  const model = parseDiff(diff)!;
  assertEquals(
    model.files[0].newPath,
    undefined,
    "deleted file has no new path",
  );
  assertEquals(model.files[0].oldPath, "m.ts", "old path is the .ts file");

  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const rawLines = diff.split("\n");
  const codeIdx = rawLines.indexOf("-const a = 1;");
  // A TypeScript keyword classification survives, confirming the .ts side is
  // still parsed as TypeScript rather than flattened to Markdown prose.
  const codeSpans = doc.lines[codeIdx].spans.filter((s) => s.col >= 1);
  assert(
    codeSpans.some((s) => s.cls === "storageKeyword"),
    `the removed .ts line keeps a TypeScript keyword span, got ${
      JSON.stringify(doc.lines[codeIdx].spans)
    }`,
  );
});

//
// only files with hunks are read from the workspace
//

Deno.test("buildDiffDocument: a file section without hunks is not read from the workspace", () => {
  // A pure rename is a file section with headers and no hunks. None of the
  // renamed file's content is displayed, edited, or expanded. A file whose
  // name does not settle its language would otherwise be read to detect one.
  const diff = `diff --git a/old.ts b/moved.ts
similarity index 100%
rename from old.ts
rename to moved.ts
diff --git a/old-script b/moved-script
similarity index 100%
rename from old-script
rename to moved-script
diff --git a/edited.ts b/edited.ts
index 1111111..2222222 100644
--- a/edited.ts
+++ b/edited.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;
  const files: Record<string, string> = {
    "/ws/moved.ts": "export const moved = true;\n",
    "/ws/moved-script": "#!/usr/bin/env python3\nprint('moved')\n",
    "/ws/edited.ts": "const a = 1;\nconst b = 3;\n",
  };
  const reads: string[] = [];
  const ws: DiffWorkspace = {
    resolve: (path) => `/ws/${path}` in files ? `/ws/${path}` : null,
    read: (absPath) => {
      reads.push(absPath);
      return files[absPath] ?? null;
    },
  };
  const model = parseDiff(diff)!;
  assertEquals(model.files.map((f) => f.hunks.length), [0, 0, 1]);

  const { maps, edit } = buildDiffDocument(diff, model, ws);

  assertEquals([...new Set(reads)], ["/ws/edited.ts"]);
  assertEquals([...edit.fileText.keys()], ["/ws/edited.ts"]);
  assertEquals([...maps.rootFiles.keys()], ["/ws/edited.ts"]);
  assertEquals(diffSource(ws, edit).label, "edited.ts");
  const added = diff.split("\n").indexOf("+const b = 3;");
  const offset = diff.split("\n").slice(0, added).join("\n").length + 2;
  assertEquals(maps.toFile(offset), {
    path: "/ws/edited.ts",
    offset: files["/ws/edited.ts"].indexOf("const b"),
  });
});
