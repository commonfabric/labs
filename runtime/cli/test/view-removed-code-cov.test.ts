import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseDiff } from "../lib/view/diff.ts";
import {
  _internal as _dd,
  buildDiffDocument,
  type DiffWorkspace,
  type WorkspaceCache,
} from "../lib/view/diffdoc.ts";
import {
  _internal as _de,
  createDiffHighlighter,
} from "../lib/view/diffedit.ts";
import { computeLineStarts } from "../lib/view/lines.ts";
import { languageForFile } from "../lib/view/languages/language.ts";
import type { Document, Line } from "../lib/view/model.ts";

const NO_WS: DiffWorkspace = { resolve: () => null, read: () => null };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

Deno.test("diffdoc cov: Git batch output accepts blobs and rejects malformed records", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const parsed = _dd.parseGitBatchOutput(
    ["aaaa", "bbbb"],
    encode(`aaaa missing\n${b} blob 4\ntext\n`),
  );
  assertEquals([...parsed], [["bbbb", "text"]]);

  assertEquals(
    _dd.parseGitBatchOutput(["aaaa"], encode(`${a} blob 4\ntext`)).size,
    0,
    "a payload without its delimiter is incomplete",
  );
  assertEquals(
    _dd.parseGitBatchOutput(["aaaa"], encode(`${a} blob 4\ntex`)).size,
    0,
    "a truncated payload is incomplete",
  );
  assertEquals(
    _dd.parseGitBatchOutput(
      ["aaaa"],
      encode(`${a} blob 9007199254740992\n`),
    ).size,
    0,
    "an unsafe payload size is rejected",
  );
  assertEquals(
    _dd.parseGitBatchOutput(["aaaa"], encode("header without newline")).size,
    0,
    "an incomplete header is ignored",
  );
});

Deno.test("diffdoc cov: Git blob reads stay local and return empty results after command failures", () => {
  type GitBatchRunner = NonNullable<
    Parameters<typeof _dd.readGitBlobs>[2]
  >;
  const invocations: Parameters<GitBatchRunner>[] = [];
  const failed = _dd.readGitBlobs(
    "/repo",
    ["aaaa"],
    (command, args, options) => {
      invocations.push([command, args, options]);
      return {
        stdout: new Uint8Array(),
        status: 1,
      };
    },
  );
  assertEquals(failed.size, 0, "a nonzero Git result returns no blobs");
  assertEquals(invocations.length, 1);
  const [command, args, options] = invocations[0];
  assertEquals(command, "git");
  assertEquals(args, ["cat-file", "--batch"]);
  assertEquals(options.cwd, "/repo");
  assertEquals(options.env.GIT_NO_LAZY_FETCH, "1");
  assertEquals(options.input, "aaaa\n");
  assertEquals(options.maxBuffer, Number.MAX_SAFE_INTEGER);

  assertEquals(
    _dd.readGitBlobs("\0", ["aaaa"]).size,
    0,
    "invalid command working directories return no blobs",
  );

  assertEquals(
    _dd.readGitBlobs("/repo", ["aaaa"], () => {
      throw new Error("spawn failed");
    }).size,
    0,
    "command launch failures return no blobs",
  );
});

Deno.test("diffdoc cov: old-file reconstruction rejects inconsistent hunk metadata", () => {
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -2 +2 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  const file = model.files[0];
  const hunk = file.hunks[0];
  const rawLines = diff.split("\n");
  const newText = "first\nnew\nlast\n";
  const reconstruct = (changes: Partial<typeof hunk>) =>
    _dd.reconstructOldFile(
      { ...file, hunks: [{ ...hunk, ...changes }] },
      newText,
      rawLines,
      model.lines,
    );

  assertEquals(
    reconstruct({ oldCount: 2 }),
    null,
    "counts must match the body",
  );
  assertEquals(reconstruct({ newStart: 99 }), null, "ranges must fit the file");
  assertEquals(
    reconstruct({ newStart: 1 }),
    null,
    "the selected new-file range must match the hunk",
  );
});

Deno.test("diffdoc cov: a file section without hunks has no old-file lines", () => {
  const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;
  const { doc, edit } = buildDiffDocument(diff, parseDiff(diff)!, NO_WS);
  assertEquals(edit.oldFileLines, [null]);
  assertEquals(doc.text, diff);
});

Deno.test("diffdoc cov: mismatched cached spans fall back to fragment highlighting", () => {
  const root = Deno.makeTempDirSync();
  try {
    const path = join(root, "m.ts");
    const fileText = "export const value = 2;\n";
    Deno.writeTextFileSync(path, fileText);
    const wrongDoc = languageForFile(path).parseDocument(
      "export const value = 3;\n",
      path,
    );
    const entries = new Map<string, {
      fileText: string;
      fileDoc: Document;
      fileLineStarts: number[];
    }>([[
      path,
      {
        fileText,
        fileDoc: wrongDoc,
        fileLineStarts: computeLineStarts(fileText),
      },
    ]]);
    const cache = entries as unknown as WorkspaceCache;
    const ws: DiffWorkspace = {
      resolve: () => path,
      read: () => fileText,
    };
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws, cache);
    const added = diff.split("\n").indexOf("+export const value = 2;");
    assertEquals(
      doc.lines[added].spans.map((span) => span.text).join(""),
      "+export const value = 2;",
    );
    assert(
      doc.lines[added].spans.some((span) => span.text === "2"),
      "the fragment parse supplies the new line's spans",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffdoc cov: complete-line spans reject different source text", () => {
  assertEquals(
    _dd.shiftCompleteLineSpans("-actual", [{
      col: 0,
      text: "different",
      cls: "identifier",
    }]),
    null,
  );
});

Deno.test("diffedit cov: live removed lines retain CRLF transport after old-file highlighting", () => {
  const diff = [
    "diff --git a/m.ts b/m.ts\r",
    "--- a/m.ts\r",
    "+++ /dev/null\r",
    "@@ -1 +0,0 @@\r",
    "-removed\r",
    "",
  ].join("\n");
  const oldLines: readonly Line[] = [{
    text: "removed",
    spans: [{ col: 0, text: "removed", cls: "comment" }],
  }];
  const highlighter = createDiffHighlighter(diff, undefined, [oldLines]);
  const removed = diff.split("\n").indexOf("-removed\r");
  assertEquals(
    highlighter.lines[removed].spans.find((span) => span.text === "removed")
      ?.cls,
    "comment",
  );
  assertEquals(highlighter.lines[removed].spans.at(-1), {
    col: 8,
    text: "\r",
    cls: "whitespace",
  });

  const model = parseDiff(diff)!;
  const outside = {
    ...model,
    files: model.files.map((file) => ({
      ...file,
      endLine: file.headerLine,
    })),
  };
  assertEquals(_de.oldLineSpansAt(outside, removed, [oldLines]), undefined);
});
