import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { looksLikeDiff, parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
  realWorkspace,
} from "../lib/view/diffdoc.ts";
import { createDiffSemantics } from "../lib/view/languages/typescript/semantics.ts";
import type { Semantics } from "../lib/view/languages/language.ts";
import { buildPeekCard } from "../lib/view/card.ts";
import { renderLineColored } from "../lib/view/highlight.ts";
import { renderFrame, type ViewState } from "../lib/view/render.ts";
import { buildView } from "../lib/view/mod.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";
import { bgCode, SAMPLE } from "./view-helpers.ts";
import { lineBg } from "../lib/view/theme.ts";

function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    const key: Key = name.length === 1 && name >= " "
      ? { name, char: name }
      : { name };
    session.handleKey(key);
  }
}

/** A stub workspace over a prepared root directory. */
function stubWs(root: string): DiffWorkspace {
  return {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
}

function runGit(root: string, args: string[]): string {
  const output = new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  assert(output.success, stderr || `git ${args[0]} failed`);
  return new TextDecoder().decode(output.stdout);
}

//
// fixtures
//

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
const extra = answer + 1;
`;

const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,5 @@ export function double
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = 42;
+export const answer = double(21);
+const extra = answer + 1;
`;

const OLD_COMMENT_FILE = `/*
first
second
third
fourth
const hidden = 1;
sixth
*/
export const shown = 2;
`;

const NEW_COMMENT_FILE = `/*
first
second
third
fourth
sixth
*/
export const shown = 2;
`;

const PARTIAL_COMMENT_DIFF = `diff --git a/comment.ts b/comment.ts
index 0000000..1111111 100644
--- a/comment.ts
+++ b/comment.ts
@@ -3,7 +3,6 @@
 second
 third
 fourth
-const hidden = 1;
 sixth
 */
 export const shown = 2;
`;

/** A workspace rooted in a temp dir holding `m.ts` with FILE_TEXT. */
function tempWorkspace(): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "deno.json"), "{}");
  Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
  const ws: DiffWorkspace = {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
  return { root, ws, done: () => Deno.removeSync(root, { recursive: true }) };
}

const NO_WS: DiffWorkspace = { resolve: () => null, read: () => null };

//
// detection
//

Deno.test("diff: detection accepts git and plain unified diffs, rejects code", () => {
  assert(looksLikeDiff(DIFF), "git diff detected");
  const plain = `--- m.ts\t2026-01-01
+++ m.ts\t2026-01-02
@@ -1,2 +1,2 @@
 a
-b
+c
`;
  assert(looksLikeDiff(plain), "plain diff -u detected");
  assert(looksLikeDiff(`\n \t\n${plain}`), "leading blank lines are ignored");
  assert(!looksLikeDiff(SAMPLE), "transformed blob is not a diff");
  assert(!looksLikeDiff("const x = 1;\nconst y = 2;\n"), "code is not a diff");
  assert(
    !looksLikeDiff("--- header ---\nsome prose\nmore prose\n"),
    "a lone --- line is not a diff",
  );
  assert(
    !looksLikeDiff("diff --git a/x.ts b/x.ts\n"),
    "a lone git header is not a diff",
  );
  assert(
    !looksLikeDiff(
      "diff --git a/x.ts b/x.ts\n" +
        "const value = 1;\n" +
        "export { value };\n",
    ),
    "a git header followed by source is not a diff",
  );
  const malformedGit = "diff --git malformed\n" +
    "index 0000000..1111111 100644\n";
  assert(
    !looksLikeDiff(malformedGit),
    "a malformed git header does not make a container",
  );
  assert(
    !looksLikeDiff(`${malformedGit}${DIFF}`),
    "a later valid diff does not rescue a malformed first container",
  );
  const embedded = `const patch = \`
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
\`;
`;
  assert(!looksLikeDiff(embedded), "a diff inside source is not a container");
  const rename = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
  assert(looksLikeDiff(rename), "a metadata-only git diff is detected");
});

//
// parsing
//

Deno.test("diff: parses files, hunks and per-line old/new numbering", () => {
  const model = parseDiff(DIFF)!;
  assertEquals(model.files.length, 1);
  const f = model.files[0];
  assertEquals(f.oldPath, "m.ts");
  assertEquals(f.newPath, "m.ts");
  assertEquals(f.oldObject, "0000000");
  assertEquals(f.hunks.length, 1);
  const h = f.hunks[0];
  assertEquals(
    [h.oldStart, h.oldCount, h.newStart, h.newCount],
    [1, 4, 1, 5],
  );
  assertEquals(h.context, "export function double");
  // line classification: header lines meta, body ctx/del/add with numbering
  assertEquals(model.lines[0].kind, "meta"); // diff --git
  assertEquals(model.lines[4].kind, "hunk"); // @@
  assertEquals(model.lines[5], { kind: "ctx", newLine: 0, oldLine: 0 });
  assertEquals(model.lines[8], { kind: "del", oldLine: 3 });
  assertEquals(model.lines[9], { kind: "add", newLine: 3 });
  assertEquals(model.lines[10], { kind: "add", newLine: 4 });
});

Deno.test("diff: hunk counts are the authority, not +/- sniffing", () => {
  // The second file's `--- a/n.ts` begins with '-': the first hunk must end
  // exactly when its counts are consumed, not swallow the next file header.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/n.ts b/n.ts
--- a/n.ts
+++ b/n.ts
@@ -1,1 +1,1 @@
-x
+y
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 2);
  assertEquals(model.files[0].hunks[0].endLine, 5);
  assertEquals(model.files[1].newPath, "n.ts");
});

Deno.test("diff: created/deleted files, no-newline and binary metadata", () => {
  const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
\\ No newline at end of file
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+hello
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 3);
  assertEquals(model.files[0].newPath, undefined, "deleted file: no new path");
  assertEquals(model.files[2].oldPath, undefined, "created file: no old path");
  // `\ No newline…` is metadata, not content
  const noNl = diff.split("\n").findIndex((l) => l.startsWith("\\"));
  assertEquals(model.lines[noNl].kind, "meta");
  // binary file has no hunks
  assertEquals(model.files[1].hunks.length, 0);
});

//
// document
//

Deno.test("diff doc: verbatim text, tints, markers and syntax color", () => {
  const { ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc } = buildDiffDocument(DIFF, model, ws);
    // Verbatim: spans concatenate back to the exact diff text.
    assertEquals(
      doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"),
      DIFF,
    );
    // Backgrounds on the changed lines only.
    assertEquals(doc.lines[8].bg, "del");
    assertEquals(doc.lines[9].bg, "add");
    assertEquals(doc.lines[5].bg, undefined, "context line has no tint");
    // Markers classified.
    assertEquals(doc.lines[9].spans[0].cls, "diffAdd");
    assertEquals(doc.lines[8].spans[0].cls, "diffDel");
    // Syntax color under the diff: both complete file parses classify the
    // `export` keyword as a storage keyword.
    const cls = (line: number, text: string) =>
      doc.lines[line].spans.find((s) => s.text === text)?.cls;
    assertEquals(cls(9, "export"), "storageKeyword", "added line is code");
    assertEquals(cls(8, "export"), "storageKeyword", "removed line is code");
    // Headers.
    assertEquals(doc.lines[0].spans[0].cls, "sectionHeader");
    assertEquals(doc.lines[4].spans[0].cls, "diffHunk");
  } finally {
    done();
  }
});

Deno.test("diff doc: removed lines use the reconstructed complete old file", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "comment.ts"), NEW_COMMENT_FILE);
    const model = parseDiff(PARTIAL_COMMENT_DIFF)!;
    const { doc } = buildDiffDocument(
      PARTIAL_COMMENT_DIFF,
      model,
      stubWs(root),
    );
    const removed = PARTIAL_COMMENT_DIFF.split("\n").indexOf(
      "-const hidden = 1;",
    );
    assertEquals(
      doc.lines[removed].spans.find((span) => span.text.includes("hidden"))
        ?.cls,
      "comment",
      "the block comment opener outside the hunk controls the removed line",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff doc: CRLF transport matches complete LF files", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "comment.ts"), NEW_COMMENT_FILE);
    const diff = PARTIAL_COMMENT_DIFF.replaceAll("\n", "\r\n");
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, stubWs(root));
    assertEquals(
      doc.lines.map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n"),
      diff,
      "highlighting preserves the CRLF transport",
    );
    const removed = diff.split("\n").findIndex((line) =>
      line.startsWith("-const hidden = 1;")
    );
    assertEquals(
      doc.lines[removed].spans.find((span) => span.text.includes("hidden"))
        ?.cls,
      "comment",
      "the LF old file remains available to the CRLF diff",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff doc: old-file cache separates reconstruction sources", () => {
  const visibleNewSide = `sharedOne;
sharedTwo;
sharedThree;
sharedFour;
sharedFive;
sharedSix;
`;
  const diff = `--- common.ts
+++ first.ts
@@ -3,7 +3,6 @@
 sharedOne;
 sharedTwo;
 sharedThree;
-export const removed = 1;
 sharedFour;
 sharedFive;
 sharedSix;
--- common.ts
+++ second.ts
@@ -3,7 +3,6 @@
 sharedOne;
 sharedTwo;
 sharedThree;
-export const removed = 1;
 sharedFour;
 sharedFive;
 sharedSix;
`;
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "first.ts"),
      `/*
prefix
${visibleNewSide}`,
    );
    Deno.writeTextFileSync(
      join(root, "second.ts"),
      `const first = 1;
const second = 2;
${visibleNewSide}`,
    );
    const { doc } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      stubWs(root),
      new Map(),
    );
    const removed = diff.split("\n").flatMap((line, index) =>
      line === "-export const removed = 1;" ? [index] : []
    );
    assertEquals(removed.length, 2);
    const classAt = (line: number) =>
      doc.lines[line].spans.find((span) => span.text.includes("export"))?.cls;
    assertEquals(classAt(removed[0]), "comment");
    assertEquals(classAt(removed[1]), "storageKeyword");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff doc: old-file cache separates repeated file versions", () => {
  const diff = [
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -2,1 +2,1 @@",
    "-value",
    "+new1",
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -2,1 +2,1 @@",
    "-value",
    "+new2",
    "",
  ].join("\n");
  const ws: DiffWorkspace = {
    resolve: () => "/m.ts",
    read: () => "/*\nnew1\n*/\n",
  };
  const { doc } = buildDiffDocument(
    diff,
    parseDiff(diff)!,
    ws,
    new Map(),
  );
  const removed = diff.split("\n").flatMap((line, index) =>
    line === "-value" ? [index] : []
  );
  const classAt = (line: number) =>
    doc.lines[line].spans.find((span) => span.text === "value")?.cls;
  assertEquals(classAt(removed[0]), "comment");
  assertEquals(
    classAt(removed[1]),
    "identifier",
    "the nonmatching version uses its own fragment highlighting",
  );
});

Deno.test("diff doc: structure is file → hunk → the workspace file's nodes", () => {
  const { ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc } = buildDiffDocument(DIFF, model, ws);
    const kinds = doc.flatStructure.map((n) => `${n.kind}:${n.label}`);
    assert(kinds[0].startsWith("section:▸ m.ts"), `file section: ${kinds[0]}`);
    assert(kinds[1].startsWith("hunk:@@"), `hunk node: ${kinds[1]}`);
    // The real file's nodes appear, remapped into diff lines.
    const fn = doc.flatStructure.find((n) => n.name === "double")!;
    assertEquals(fn.kind, "function");
    assertEquals([fn.startLine, fn.endLine], [5, 7], "remapped to diff lines");
    const answer = doc.flatStructure.find((n) => n.name === "answer")!;
    assertEquals(answer.startLine, 9, "the added line");
    // nameOffset points at the name within the DIFF text.
    assert(
      DIFF.slice(answer.nameOffset!).startsWith("answer"),
      "nameOffset remapped into diff coordinates",
    );
    // Definitions are registered in diff coordinates.
    assert(doc.definitions.has("double"), "definition index populated");
    // The coincidence invariant holds for the remapped tree.
    const seen = new Set<string>();
    for (const n of doc.flatStructure) {
      const k = `${n.startOffset}:${n.endOffset}`;
      assert(!seen.has(k), `coincident: ${n.kind} ${n.label}`);
      seen.add(k);
    }
  } finally {
    done();
  }
});

describe("decoded diff input", () => {
  it("keeps a decoded BOM outside TypeScript structure ranges", () => {
    const bom = "\uFEFF";
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1 +1 @@
-${bom}const alpha = 0;
+${bom}const alpha = 1;
`;
    const ws: DiffWorkspace = {
      resolve: () => "/m.ts",
      read: () => "const alpha = 1;\n",
      hasUtf8Bom: () => true,
    };
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
    const alpha = doc.flatStructure.find((node) => node.name === "alpha");

    assert(alpha);
    expect(alpha.startCol).toBe(2);
    expect(alpha.startOffset).toBe(diff.indexOf("const alpha = 1;"));
    assert(diff.slice(alpha.nameOffset!).startsWith("alpha"));

    const fragment = buildDiffDocument(diff, parseDiff(diff)!, NO_WS).doc;
    const fragmentAlpha = fragment.flatStructure.find((node) =>
      node.name === "alpha"
    );
    assert(fragmentAlpha);
    expect(fragmentAlpha.startOffset).toBe(diff.indexOf("const alpha = 1;"));
    assert(diff.slice(fragmentAlpha.nameOffset!).startsWith("alpha"));
  });

  it("preserves textual hunk bodies for known binary filenames", () => {
    const diff = `diff --git a/asset.png b/asset.png
--- a/asset.png
+++ b/asset.png
@@ -1 +1 @@
-old bytes
+new bytes
`;
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, NO_WS);

    expect(doc.lines[4].spans.map((span) => span.text).join("")).toBe(
      "-old bytes",
    );
    expect(doc.lines[5].spans.map((span) => span.text).join("")).toBe(
      "+new bytes",
    );
  });

  it("strips a BOM before parsing a Markdown fragment", () => {
    const bom = "\uFEFF";
    const diff = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -0,0 +1,2 @@
+${bom}# Heading
+body
`;
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, NO_WS);
    const heading = doc.flatStructure.find((node) =>
      node.label === "# Heading"
    );

    assert(heading);
    expect(heading.startCol).toBe(2);
    expect(heading.startOffset).toBe(diff.indexOf("# Heading"));
    expect(doc.lines[4].spans.map((span) => span.text).join("")).toBe(
      `+${bom}# Heading`,
    );
  });
});

Deno.test("diff doc: missing workspace file still highlights and structures via fragments", () => {
  const model = parseDiff(DIFF)!;
  const { doc, maps } = buildDiffDocument(DIFF, model, NO_WS);
  // Verbatim still holds; code still classifies.
  assertEquals(
    doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"),
    DIFF,
  );
  const exp = doc.lines[9].spans.find((s) => s.text === "export");
  assertEquals(exp?.cls, "storageKeyword", "fragment fallback classifies code");
  // Structure comes from the fragment parse of the hunk's new side, so the
  // nodes stay navigable even with no workspace file at all…
  const dbl = doc.flatStructure.find((n) => n.name === "double");
  assert(dbl, "fragment structure is navigable");
  assert(
    DIFF.slice(dbl!.nameOffset!).startsWith("double"),
    "fragment nameOffset lands in the diff text",
  );
  assert(doc.definitions.has("double"), "fragment names are indexed for 't'");
  // …while semantics stays silent (no workspace to vouch for anything), and
  // the hunk label says why.
  assertEquals(maps.rootFiles.size, 0);
  const hunk = doc.flatStructure.find((n) => n.kind === "hunk")!;
  assert(hunk.label.includes("(no workspace file)"), `label: ${hunk.label}`);
});

Deno.test("diff doc: fragment parsing follows the file extension", () => {
  const diff = `diff --git a/generic.ts b/generic.ts
--- a/generic.ts
+++ b/generic.ts
@@ -0,0 +1 @@
+const identity = <T>(value: T): T => value;
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const parameter = doc.lines[4].spans.find((span) => span.text === "value");
  assertEquals(
    parameter?.cls,
    "parameter",
    "a .ts fragment uses TypeScript rather than TSX",
  );
});

Deno.test("diff doc: renamed fragments use each side's extension", () => {
  const diff = `diff --git a/generic.ts b/generic.tsx
--- a/generic.ts
+++ b/generic.tsx
@@ -1 +1 @@
-const identity = <T>(value: T): T => value;
+const view = <div>ready</div>;
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const oldParameter = doc.lines[4].spans.find((span) => span.text === "value");
  assertEquals(
    oldParameter?.cls,
    "parameter",
    "the removed .ts line uses the old TypeScript path",
  );
});

Deno.test("diff doc: a drifted workspace line unmaps the whole hunk", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    // Workspace file drifts from the diff's new side on the `answer` line.
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      FILE_TEXT.replace("double(21)", "double(99)"),
    );
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    assertEquals(
      doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"),
      DIFF,
      "verbatim regardless of drift",
    );
    // Hunk verification is all-or-nothing (like `git apply`): one drifted line
    // means the whole hunk maps to nothing, so semantics never answers about a
    // coincidentally-matching wrong occurrence.
    assertEquals(maps.toFile(DIFF.indexOf("double(21)")), null);
    assertEquals(
      maps.toFile(DIFF.indexOf("return n * 2")),
      null,
      "even matching context lines unmap when the hunk fails verification",
    );
    // Structure still exists — from the diff text itself, not the workspace —
    // and the hunk label reports the drift.
    assert(
      doc.flatStructure.some((n) => n.name === "double"),
      "fragment structure keeps the hunk navigable",
    );
    const hunk = doc.flatStructure.find((n) => n.kind === "hunk")!;
    assert(hunk.label.includes("(workspace differs)"), `label: ${hunk.label}`);
  } finally {
    done();
  }
});

Deno.test("diff doc: a stale diff shifted against the workspace maps nothing", () => {
  // Lines were inserted ABOVE the hunk after the diff was taken: every
  // new-side line number now points at a different workspace line. Even if a
  // low-entropy line coincided at the shifted position, the hunk-level check
  // rejects the whole hunk.
  const { root, ws, done } = tempWorkspace();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), `// header\n${FILE_TEXT}`);
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    assertEquals(maps.toFile(DIFF.indexOf("return n * 2")), null);
    // Navigable fragment structure remains; only the semantic maps go silent.
    assert(
      doc.flatStructure.some((n) => n.name === "double"),
      "fragment structure keeps the hunk navigable",
    );
    const sem = createDiffSemantics(DIFF, maps, { cwd: root });
    if (sem) {
      assertEquals(sem.typeAt(DIFF.indexOf("answer")), null, "no type lies");
    }
  } finally {
    done();
  }
});

Deno.test("diff doc: a shifted coincidental match cannot answer about the wrong occurrence", () => {
  // The reviewer's repro: function b was inserted above function a after the
  // diff was taken; the added `log(x)` coincides textually with b's body at
  // the diff's stated line numbers, but neighboring lines do not match, so
  // the hunk fails verification and maps nothing (instead of answering with
  // function b's types).
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `function b() {
  const x = 1;
  log(x);
  return x;
}
function a() {
  const x = "s";
  log(x);
  return x;
}
`,
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,5 @@
 function a() {
   const x = "s";
+  log(x);
   return x;
 }
`;
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const model = parseDiff(diff)!;
    const { maps } = buildDiffDocument(diff, model, ws);
    // The added log(x) coincides with workspace line 2 (function b's log) at
    // the stated position — but the hunk's other lines mismatch, so nothing
    // maps and no wrong-scope type can be answered.
    assertEquals(maps.toFile(diff.indexOf("log(x)")), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// semantics
//

Deno.test("diff semantics: types and definitions answer against the workspace", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    assert(sem, "service builds");
    // Type of the added binding, through the diff→file mapping.
    const answer = doc.flatStructure.find((n) => n.name === "answer")!;
    assertEquals(sem.typeAt(answer.nameOffset!), "number");
    // The marker column belongs to the diff, not the code.
    const markerOffset = DIFF.split("\n").slice(0, 9).join("\n").length + 1;
    assertEquals(sem.typeAt(markerOffset), null);
    // Definition of `double` at its use: the declaration is visible in the
    // diff, so it resolves in-diff (a blobOffset into the diff text).
    const use = DIFF.indexOf("double(21)");
    const defs = sem.definitionOf(use);
    const inDiff = defs.find((d) => d.blobOffset !== undefined);
    assert(inDiff, `resolved in-diff: ${JSON.stringify(defs)}`);
    assert(
      DIFF.slice(inDiff!.blobOffset!).startsWith("double"),
      "lands on the visible declaration",
    );
  } finally {
    done();
  }
});

Deno.test("diff semantics: a definition outside the diff opens as a file", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    // helper.ts defines ext(); the diff only adds a use of it in m.ts.
    Deno.writeTextFileSync(
      join(root, "helper.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `import { ext } from "./helper.ts";\nconst flag = ext();\n`,
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 import { ext } from "./helper.ts";
+const flag = ext();
`;
    const model = parseDiff(diff)!;
    const { doc, maps } = buildDiffDocument(diff, model, ws);
    const sem = createDiffSemantics(diff, maps, { cwd: root })!;
    const use = diff.indexOf("ext();");
    const ext = sem.definitionOf(use).find((d) => d.filePath);
    assert(ext, "external definition resolved");
    assert(ext!.filePath!.endsWith("helper.ts"));
    assert(ext!.preview.includes("export function ext"));
    // And the card surfaces it with a type line for the binding.
    const flag = doc.flatStructure.find((n) => n.name === "flag")!;
    const card = buildPeekCard(doc, flag, sem);
    const text = card.info.map((l) => l.text).join("\n");
    assert(text.includes("type") && text.includes("boolean"), `card: ${text}`);
  } finally {
    done();
  }
});

//
// rendering
//

Deno.test("diff render: added lines carry the add tint under the syntax color", () => {
  const { ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc } = buildDiffDocument(DIFF, model, ws);
    // Non-interactive path: renderLineColored merges the line bg.
    const colored = renderLineColored(doc.lines[9], true);
    assert(colored.includes(bgCode(lineBg("add"))), "add bg in plain print");
    // Interactive path: the frame row for the added line carries the bg too.
    const view: ViewState = {
      top: 9,
      left: 0,
      width: 60,
      height: 4,
      color: true,
      showLineNumbers: false,
      wrapMode: "off",
      displayMode: "pictures",
      selected: null,
      matches: null,
      currentMatch: 0,
      message: "",
      inputLine: null,
      overlay: null,
    };
    const rows = renderFrame(doc, view);
    assert(rows[0].includes(bgCode(lineBg("add"))), "add bg in the frame");
    // Monochrome stays verbatim.
    assertEquals(
      renderLineColored(doc.lines[9], false),
      doc.lines[9].text,
    );
  } finally {
    done();
  }
});

//
// review fixes
//

Deno.test("diff doc: a hunk interior to nested code hoists the inner nodes", () => {
  // Both `outer` and `middle` clamp to the same visible range; the fold must
  // hoist middle's children instead of dropping the subtree, so the nodes the
  // hunk actually touches stay reachable.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `export function outer() {
  const middle = () => {
    const pad1 = 1;
    const g = () => {
      const a = 1;
      return a;
    };
    return g;
  };
  return middle;
}
`,
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -3,6 +3,6 @@ export function outer
     const pad1 = 1;
     const g = () => {
       const a = 1;
       return a;
     };
     return g;
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, stubWs(root));
    const names = doc.flatStructure.map((n) => n.name).filter(Boolean);
    assert(names.includes("pad1"), `pad1 reachable: ${names}`);
    assert(names.includes("g"), `g reachable: ${names}`);
    assert(doc.definitions.has("g"), "folded ancestors still index names");
    assert(
      doc.definitions.has("middle"),
      "the folded node's own name resolves",
    );
    // The coincidence invariant still holds.
    const seen = new Set<string>();
    for (const n of doc.flatStructure) {
      const k = `${n.startOffset}:${n.endOffset}`;
      assert(!seen.has(k), `coincident: ${n.kind} ${n.label}`);
      seen.add(k);
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff: multi-file plain diff -u splits files and strips timestamps", () => {
  const diff = `--- d1/one.ts\t2026-06-11 15:08:19
+++ d2/one.ts\t2026-06-11 15:08:25
@@ -1,1 +1,1 @@
-old one
+new one
--- d1/two.ts\t2026-06-11 15:08:19
+++ d2/two.ts\t2026-06-11 15:08:25
@@ -1,1 +1,1 @@
-old two
+new two
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 2, "one DiffFile per plain-diff section");
  assertEquals(model.files[0].newPath, "d2/one.ts", "timestamp stripped");
  assertEquals(model.files[1].newPath, "d2/two.ts");
  assertEquals(model.files[0].hunks.length, 1);
  assertEquals(model.files[1].hunks.length, 1);
});

Deno.test("diff: a combined (merge) section is skipped without corrupting files", () => {
  const diff = `diff --git a/normal.ts b/normal.ts
--- a/normal.ts
+++ b/normal.ts
@@ -1,1 +1,1 @@
-old
+new
diff --cc merged.ts
index 1111111,2222222..3333333
--- a/merged.ts
+++ b/merged.ts
@@@ -1,2 -1,2 +1,2 @@@
  shared
++merged line
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1, "the combined section is not emitted");
  assertEquals(model.files[0].newPath, "normal.ts", "paths not clobbered");
  assertEquals(model.files[0].hunks.length, 1);
  assertEquals(
    model.files[0].endLine,
    5,
    "the normal file's range stops before the merge section",
  );
});

Deno.test("diff: CRLF input still parses files, hunks and body lines", () => {
  const crlf = DIFF.replace(/\n/g, "\r\n");
  assert(looksLikeDiff(crlf), "detected despite CR line endings");
  const model = parseDiff(crlf)!;
  assertEquals(model.files.length, 1);
  assertEquals(model.files[0].hunks.length, 1);
  assertEquals(model.files[0].newPath, "m.ts", "path free of the CR");
  assertEquals(model.lines[9].kind, "add", "body classified despite CR");
});

Deno.test("diff doc: CRLF content matches a CRLF workspace and stays semantic", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      "export const n: number = 1;\r\nexport const used = n;\r\n",
    );
    const diff = "diff --git a/m.ts b/m.ts\n--- a/m.ts\n+++ b/m.ts\n" +
      "@@ -1,1 +1,2 @@\n export const n: number = 1;\r\n+export const used = n;\r\n";
    const model = parseDiff(diff)!;
    const { doc, maps } = buildDiffDocument(diff, model, stubWs(root));
    assertEquals(
      doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"),
      diff,
      "verbatim with the CRs",
    );
    assert(maps.toFile(diff.indexOf("used")) !== null, "CRLF lines map");
    const sem = createDiffSemantics(diff, maps, { cwd: root })!;
    assertEquals(sem.typeAt(diff.indexOf("used")), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff: git C-style-quoted paths are decoded for special bytes", () => {
  // git wraps a path with special bytes in double quotes with C-style escapes:
  // `\t` for tab, `\"` for quote, `\\` for backslash, octal `\NNN` for
  // non-ASCII bytes (UTF-8). Without decoding, the resolved path is the literal
  // backslash sequence, so the workspace lookup and in-place save miss the
  // file.
  const diff = `diff --git "a/with\\ttab.ts" "b/with\\ttab.ts"
--- "a/with\\ttab.ts"
+++ "b/with\\ttab.ts"
@@ -1,1 +1,1 @@
-old
+new
diff --git "a/na\\303\\257ve.ts" "b/na\\303\\257ve.ts"
--- "a/na\\303\\257ve.ts"
+++ "b/na\\303\\257ve.ts"
@@ -1,1 +1,1 @@
-old
+new
diff --git "a/q\\".ts" "b/q\\".ts"
--- "a/q\\".ts"
+++ "b/q\\".ts"
@@ -1,1 +1,1 @@
-old
+new
diff --git "a/back\\\\slash.ts" "b/back\\\\slash.ts"
--- "a/back\\\\slash.ts"
+++ "b/back\\\\slash.ts"
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 4);
  // Tab escape becomes a real tab, not a literal backslash-t.
  assertEquals(model.files[0].oldPath, "with\ttab.ts");
  assertEquals(model.files[0].newPath, "with\ttab.ts");
  // Octal \303\257 is the UTF-8 encoding of "ï".
  assertEquals(model.files[1].newPath, "naïve.ts");
  // Escaped quote unescapes to a literal double-quote in the path.
  assertEquals(model.files[2].newPath, 'q".ts');
  // Escaped backslash unescapes to a single backslash.
  assertEquals(model.files[3].newPath, "back\\slash.ts");
});

Deno.test("diff: an unquoted plain diff path keeps a literal backslash", () => {
  // No surrounding quotes means no C-style decoding: a literal backslash in an
  // unquoted plain `diff -u` header survives verbatim.
  const diff = `--- d1/lit\\tname.ts\t2026-06-11 15:08:19
+++ d2/lit\\tname.ts\t2026-06-11 15:08:25
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files[0].newPath, "d2/lit\\tname.ts");
});

Deno.test("diff workspace: realWorkspace resolves via the repo root and blocks escapes", () => {
  const root = Deno.makeTempDirSync();
  const outside = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.mkdirSync(join(root, "sub"));
    Deno.writeTextFileSync(join(root, "inside.ts"), "export const a = 1;\n");
    Deno.writeTextFileSync(
      join(root, "sub", "deep.ts"),
      "export const b = 1;\n",
    );
    Deno.writeTextFileSync(join(outside, "secret.ts"), "export const s = 1;\n");
    const ws = realWorkspace(join(root, "sub")); // launched from a subdir
    // Repo-root-relative paths resolve (git emits them); cwd is the fallback.
    assert(ws.resolve("inside.ts")?.endsWith("inside.ts"), "repo-root path");
    assert(ws.resolve("deep.ts")?.endsWith("deep.ts"), "cwd fallback");
    // Escapes are blocked: traversal, absolute paths, and reads outside.
    assertEquals(ws.resolve(`../${outside.split("/").pop()}/secret.ts`), null);
    assertEquals(ws.resolve(join(outside, "secret.ts")), null, "absolute");
    assertEquals(ws.read(join(outside, "secret.ts")), null, "read bounded");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("diff workspace: removed lines use the complete old Git blob", () => {
  const root = Deno.makeTempDirSync();
  try {
    runGit(root, ["init", "-q"]);
    const source = join(root, "source.ts");
    Deno.writeTextFileSync(source, OLD_COMMENT_FILE);
    const oldObject = runGit(root, ["hash-object", "-w", "source.ts"]).trim();
    const otherText = "export const other = 3;\n";
    Deno.writeTextFileSync(source, otherText);
    const otherObject = runGit(root, ["hash-object", "-w", "source.ts"]).trim();
    Deno.removeSync(source);

    const diff = PARTIAL_COMMENT_DIFF.replace("0000000", oldObject);
    const ws = realWorkspace(root);
    const blobs = ws.readBlobs?.([oldObject, otherObject]);
    assertEquals(blobs?.get(oldObject), OLD_COMMENT_FILE);
    assertEquals(blobs?.get(otherObject), otherText);
    assertEquals(ws.readBlob?.(oldObject), OLD_COMMENT_FILE);
    assertEquals(ws.readBlob?.("not-an-object"), null);
    assertEquals(ws.readBlob?.("0000000"), null);
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
    const removed = diff.split("\n").indexOf("-const hidden = 1;");
    assertEquals(
      doc.lines[removed].spans.find((span) => span.text.includes("hidden"))
        ?.cls,
      "comment",
      "the old blob highlights a file that is absent from the workspace",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff doc: old-file spans preserve CRLF diff transport", () => {
  const diff = [
    "diff --git a/comment.ts b/comment.ts\r",
    "index 1234..5678 100644\r",
    "--- a/comment.ts\r",
    "+++ /dev/null\r",
    "@@ -1 +0,0 @@\r",
    "-/* open\r",
    "\\ No newline at end of file\r",
    "",
  ].join("\n");
  const ws: DiffWorkspace = {
    resolve: () => null,
    read: () => null,
    readBlob: (object) => object === "1234" ? "/* open" : null,
  };
  const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
  assertEquals(
    doc.lines.map((line) => line.spans.map((span) => span.text).join(""))
      .join("\n"),
    diff,
    "complete-file spans retain the transport carriage return",
  );
  const removed = diff.split("\n").indexOf("-/* open\r");
  assertEquals(
    doc.lines[removed].spans.find((span) => span.text === "/* open")?.cls,
    "comment",
  );
  assertEquals(doc.lines[removed].spans.at(-1)?.text, "\r");
});

Deno.test("diff workspace: an in-repo symlink pointing outside is rejected", () => {
  const root = Deno.makeTempDirSync();
  const outside = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.writeTextFileSync(join(outside, "secret.ts"), "export const s = 1;\n");
    Deno.symlinkSync(join(outside, "secret.ts"), join(root, "leak.ts"));
    const ws = realWorkspace(root);
    // The bound is physical: the lexically-inside symlink resolves outside.
    assertEquals(ws.resolve("leak.ts"), null, "symlinked path rejected");
    assertEquals(
      ws.read(join(root, "leak.ts")),
      null,
      "symlinked read rejected",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("diff semantics: root files outside the config root are dropped", () => {
  const configRoot = Deno.makeTempDirSync(); // holds deno.json; the cwd
  const elsewhere = Deno.makeTempDirSync(); // workspace stub resolves here
  try {
    Deno.writeTextFileSync(join(configRoot, "deno.json"), "{}");
    Deno.writeTextFileSync(join(elsewhere, "m.ts"), FILE_TEXT);
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, stubWs(elsewhere));
    assert(maps.rootFiles.size > 0, "the stub resolved the file");
    assertEquals(
      createDiffSemantics(DIFF, maps, { cwd: configRoot }),
      undefined,
      "out-of-root roots leave no service",
    );
  } finally {
    Deno.removeSync(configRoot, { recursive: true });
    Deno.removeSync(elsewhere, { recursive: true });
  }
});

Deno.test("diff doc: multi-file, multi-hunk diff builds per-file structure and maps", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    const mLines = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`);
    Deno.writeTextFileSync(join(root, "m.ts"), mLines.join("\n") + "\n");
    Deno.writeTextFileSync(join(root, "n.ts"), "export const z = 9;\n");
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 const v0 = 0;
 const v1 = 1;
@@ -27,2 +27,2 @@
 const v26 = 26;
 const v27 = 27;
diff --git a/n.ts b/n.ts
--- a/n.ts
+++ b/n.ts
@@ -1,1 +1,1 @@
 export const z = 9;
`;
    const model = parseDiff(diff)!;
    const { doc, maps } = buildDiffDocument(diff, model, stubWs(root));
    const shape = doc.flatStructure.map((n) => `${n.depth}:${n.kind}`);
    assertEquals(shape, [
      "0:section",
      "1:hunk",
      "2:variable",
      "2:variable",
      "1:hunk",
      "2:variable",
      "2:variable",
      "0:section",
      "1:hunk",
      "2:variable",
    ]);
    assertEquals(maps.rootFiles.size, 2);
    const sem = createDiffSemantics(diff, maps, { cwd: root })!;
    assertEquals(sem.typeAt(diff.indexOf("v27")), "27", "second hunk maps");
    assertEquals(
      sem.typeAt(diff.indexOf("z = 9;\n", diff.indexOf("@@ -1,1"))),
      "9",
      "second file maps",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("mod: buildView routes diffs to diff mode, sources to source mode", () => {
  // A real diff routes to diff mode.
  const diffView = buildView(DIFF);
  assert(diffView.doc.flatStructure.some((n) => n.kind === "hunk"));
  // Source code routes to source mode.
  const srcView = buildView("const x = 1;\nconst y = 2;\n");
  assert(!srcView.doc.flatStructure.some((n) => n.kind === "hunk"));
  // A source file that embeds a short diff stays in source mode.
  const embedded =
    "const patch = `\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n`;\n" +
    Array.from({ length: 40 }, (_, i) => `const filler${i} = ${i};`).join("\n");
  assert(!looksLikeDiff(embedded), "the embedded patch is not a raw diff");
  assert(!buildView(embedded).doc.flatStructure.some((n) => n.kind === "hunk"));
  // Forced diff mode accepts the embedded patch. No-diff mode suppresses a
  // raw diff.
  assert(
    buildView(embedded, undefined, true).doc.flatStructure.some((n) =>
      n.kind === "hunk"
    ),
  );
  assert(
    !buildView(DIFF, undefined, false).doc.flatStructure.some((n) =>
      n.kind === "hunk"
    ),
  );
});

Deno.test("session: navigates, cards and reveals over a diff document", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    const s = new Session(
      doc,
      { color: true, showLineNumbers: false },
      { width: 100, height: 30 },
      sem,
    );
    press(s, "tab"); // section
    assertEquals(s.view().selected?.kind, "section");
    press(s, "d"); // descend to the hunk
    assertEquals(s.view().selected?.kind, "hunk");
    press(s, "d"); // descend to ƒ double
    assertEquals(s.view().selected?.name, "double");
    press(s, "s"); // sibling: answer
    assertEquals(s.view().selected?.name, "answer");
    press(s, "enter"); // card with the inferred type
    const text = s.view().overlay!.lines.map((l) => l.text).join("\n");
    assert(text.includes("number"), `card shows the type: ${text}`);
    press(s, "z"); // reveal: closes, keeps the node selected
    assertEquals(s.view().overlay, null);
    assertEquals(s.view().selected?.name, "answer");
  } finally {
    done();
  }
});

Deno.test("session: clamped nodes sharing a start offset select the right child", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `export function outer() {
  const inner = () => {
    const a = 1;
    return a;
  };
  return inner;
}
`,
    );
    // The hunk opens inside the closure: outer and inner clamp to the same
    // start offset; only the end offsets differ.
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -3,4 +3,4 @@ export function outer
     const a = 1;
     return a;
   };
   return inner;
`;
    const model = parseDiff(diff)!;
    const { doc, maps } = buildDiffDocument(diff, model, stubWs(root));
    const sem = createDiffSemantics(diff, maps, { cwd: root }) ?? undefined;
    const outer = doc.flatStructure.find((n) => n.name === "outer");
    const inner = doc.flatStructure.find((n) => n.name === "inner");
    if (!outer || !inner) return; // fold may hoist; only test the shared case
    assertEquals(outer.startOffset, inner.startOffset, "the premise holds");
    const s = new Session(
      doc,
      { color: true, showLineNumbers: false },
      { width: 100, height: 30 },
      sem,
    );
    for (let i = 0; i < 50 && s.view().selected?.name !== "inner"; i++) {
      press(s, "tab");
    }
    assertEquals(s.view().selected?.name, "inner");
    press(s, "enter"); // inner's card
    press(s, "z"); // reveal must select inner, not the same-start parent
    assertEquals(s.view().selected?.name, "inner");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("session: structures inside an unverified hunk are still navigable", () => {
  // The user-reported case: a hunk whose workspace cannot vouch for it (here:
  // no workspace at all) must still let WASD descend into the code structures.
  const model = parseDiff(DIFF)!;
  const { doc } = buildDiffDocument(DIFF, model, NO_WS);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  press(s, "tab"); // section
  press(s, "d"); // hunk
  assertEquals(s.view().selected?.kind, "hunk");
  press(s, "d"); // first structure inside the hunk
  const inside = s.view().selected!;
  assert(inside.kind !== "hunk", `descended into the hunk: ${inside.kind}`);
  assertEquals(inside.name, "double", "the fragment node is selectable");
});

Deno.test("diff doc: git log -p keeps the newest commit's hunk mapped", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      "export const keep = 1;\nexport const v = 3;\n",
    );
    // git log -p emits newest first; the older commit's hunk no longer matches
    // the workspace (v was 2 then), so only the newest hunk verifies.
    const log = `commit aaaa
Author: A
Date: now

    newest

diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 export const keep = 1;
+export const v = 3;
-export const v = 2;
commit bbbb

    older

diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 export const keep = 1;
+export const v = 2;
-export const v = 1;
`;
    const model = parseDiff(log)!;
    assertEquals(model.files.length, 2, "both commits' entries parse");
    const { maps } = buildDiffDocument(log, model, stubWs(root));
    const firstKeep = log.indexOf("keep");
    const secondKeep = log.indexOf("keep", firstKeep + 1);
    assert(maps.toFile(firstKeep) !== null, "newest hunk stays mapped");
    assertEquals(maps.toFile(secondKeep), null, "stale older hunk unmapped");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff doc: offsets stay correct past non-BMP characters", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    const line0 =
      'const pad = "🙂🙂"; export function fn(): number { return 1; }';
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `${line0}\nexport const used = fn();\n`,
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 ${line0}
+export const used = fn();
`;
    const model = parseDiff(diff)!;
    const { doc, maps } = buildDiffDocument(diff, model, stubWs(root));
    const fn = doc.flatStructure.find((n) => n.name === "fn")!;
    assert(
      diff.slice(fn.startOffset).startsWith("export function fn"),
      "startOffset exact past the emoji",
    );
    assert(diff.slice(fn.nameOffset!).startsWith("fn"), "nameOffset exact");
    const used = doc.flatStructure.find((n) => n.name === "used")!;
    const sem = createDiffSemantics(diff, maps, { cwd: root })!;
    assertEquals(sem.typeAt(used.nameOffset!), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff maps: fromFile lands inside a trimmed empty context line", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      "const a = 1;\n\nconst b = 2;\n",
    );
    // The empty context line is emitted with its trailing space trimmed.
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,3 @@
 const a = 1;

+const b = 2;
`;
    const model = parseDiff(diff)!;
    const { maps } = buildDiffDocument(diff, model, stubWs(root));
    const abs = join(root, "m.ts");
    // File offset 13 is the start of the empty workspace line.
    const mapped = maps.fromFile(abs, 13);
    assert(mapped !== null, "the empty line is visible");
    const lineStart = diff.split("\n").slice(0, 5).join("\n").length + 1;
    assertEquals(mapped, lineStart, "no phantom marker column added");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: uses over a diff exclude the removed side", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,6 +1,5 @@
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = double(7);
-const gone = double(5);
+export const answer = double(21);
 const extra = answer + 1;
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, stubWs(root));
    const dbl = doc.flatStructure.find((n) => n.name === "double")!;
    const text = buildPeekCard(doc, dbl).info.map((l) => l.text).join("\n");
    assert(text.includes("USES · 1"), `only the new side counts: ${text}`);
    assert(!text.includes("double(7)"), "removed-side uses not listed");
    assert(!text.includes("double(5)"), "deleted-only uses not listed");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: removed calls do not consume the definition lookup budget", () => {
  const removed = Array.from(
    { length: 40 },
    () => "-  oldWorker.run(),",
  ).join("\n");
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,42 +1,3 @@
 [
${removed}
+  liveWorker.stop(),
 ];
`;
  const model = parseDiff(diff)!;
  const current = "[\n  liveWorker.stop(),\n];\n";
  const { doc } = buildDiffDocument(diff, model, {
    resolve: (path) => `/repo/${path}`,
    read: () => current,
  });
  const statement = doc.flatStructure.find((node) =>
    node.kind === "statement" && node.label === "["
  )!;
  const lookedUp: number[] = [];
  const sem: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: () => null,
    definitionOf: (offset) => {
      lookedUp.push(offset);
      return diff.slice(offset).startsWith("stop")
        ? [{
          name: "stop",
          filePath: "/repo/ext.ts",
          fileOffset: 0,
          line: 0,
          col: 0,
          preview: "stop(): void",
        }]
        : [];
    },
  };
  const card = buildPeekCard(doc, statement, sem);
  const text = card.info.map((line) => line.text).join("\n");
  assertEquals(
    lookedUp.map((offset) => diff.slice(offset).match(/^\w+/)?.[0]).sort(),
    ["liveWorker", "stop"],
  );
  assert(text.includes("  stop  ext.ts:1"), `live call is listed: ${text}`);
  assert(!text.includes("remaining uses"), `nothing live is deferred: ${text}`);
});

//
// object-literal properties are navigable in a diff hunk
//

Deno.test("diff structure: an object literal's properties are each navigable", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = `export function make() {
  return {
    label: pick(a, b),
    isDiff: true,
    editable: true,
    policy,
    parse: (text) => reparse(text),
  };
}
`;
    Deno.writeTextFileSync(join(root, "m.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,10 +1,10 @@
 export function make() {
   return {
-    label: OLD,
+    label: pick(a, b),
     isDiff: true,
     editable: true,
     policy,
     parse: (text) => reparse(text),
   };
 }
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, ws);
    const labels = doc.flatStructure.map((n) => n.label);
    // Every property — not just the closure-valued one — is a node in the tree.
    for (const p of ["label:", "isDiff:", "editable:", "policy", "parse:"]) {
      assert(labels.includes(p), `missing "${p}" in: ${labels.join(" | ")}`);
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
