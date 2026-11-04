/**
 * Coverage-focused tests for the diff editable source (`lib/view/diffedit.ts`).
 *
 * These drive the source's callbacks (revert, expandContext, dirtyLabels, save)
 * and the incremental highlighter directly, reaching the error and edge branches
 * the session-level tests don't normally exercise: a diff that no longer parses,
 * a cursor outside any file or hunk, a path mismatch between the edited and the
 * original diff, a missing workspace file, a hunk with no room to expand, the
 * read-only (no-disk) source, and the defensive guards in `save`.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffEdit,
  diffLanguages,
  type DiffWorkspace,
  realWorkspace,
} from "../lib/view/diffdoc.ts";
import {
  _internal as _de,
  createDiffHighlighter,
  diffSource,
} from "../lib/view/diffedit.ts";
import { typeScriptLanguage } from "../lib/view/languages/typescript/language.ts";
import { Session } from "../lib/view/session.ts";

/** A workspace backed by a real temp dir. */
function tempWs(
  files: Record<string, string>,
): { root: string; ws: DiffWorkspace; done: () => void } {
  const root = Deno.makeTempDirSync();
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(join(root, name), content);
  }
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

/** Build the editable source for a diff against a workspace. */
function sourceFor(diff: string, ws: DiffWorkspace) {
  const model = parseDiff(diff)!;
  const { edit } = buildDiffDocument(diff, model, ws);
  return { src: diffSource(ws, edit), edit };
}

function saveSource(
  source: ReturnType<typeof diffSource>,
  text: string,
  baseline?: string,
  options?: Parameters<ReturnType<typeof diffSource>["save"]>[3],
): string {
  const lineEndings = source.lineEndingProvenance?.(text) ??
    text.split("\n").map(() => undefined);
  return source.save(text, lineEndings, baseline, options);
}

function bomDiffSession(
  firstLine: "added" | "context" = "added",
  firstContent = "const value = 2;",
  addedTail?: string,
): {
  path: string;
  bom: string;
  row: number;
  session: Session;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(join(root, ".git"));
  const path = join(root, "value.ts");
  const encoder = new TextEncoder();
  Deno.writeFileSync(
    path,
    new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode(
        firstLine === "context"
          ? `${firstContent}\nconst tail = 2;\n`
          : `${firstContent}\n${
            addedTail === undefined ? "" : `${addedTail}\n`
          }`,
      ),
    ]),
  );
  const bom = "\uFEFF";
  const diff = firstLine === "context"
    ? `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
 ${bom}${firstContent}
-const tail = 1;
+const tail = 2;
`
    : addedTail === undefined
    ? `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-${bom}const value = 1;
+${bom}${firstContent}
`
    : `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1,2 @@
-${bom}const value = 1;
+${bom}${firstContent}
+${addedTail}
`;
  const ws = realWorkspace(root);
  const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
  const session = new Session(
    built.doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 10 },
    undefined,
    diffSource(ws, built.edit),
  );
  const row = firstLine === "context" ? 4 : 5;
  session.top = row;
  session.handleKey({ name: "e" });
  session.handleKey({ name: "home" });
  return {
    path,
    bom,
    row,
    session,
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

const FILE_TEXT = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 0;
+const y = 2;
 const z = 3;
`;

//
// revert error branches
//

Deno.test("diffedit cov: revert returns null when the edited text no longer parses as a diff", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    // `current` is not a diff at all, so parseDiff(current) is null. The text
    // differs from the original, so the early `original === current` guard does
    // not fire — execution reaches the `!cur || !base` guard.
    const out = src.revert!(DIFF, "this is just some plain text\n", 0, "chunk");
    assertEquals(out, null, "an unparseable edited diff reverts to nothing");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: revert returns null when the cursor is outside every file", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const edited = DIFF.replace("+const y = 2;", "+const y = 2;X");
    // A cursor line far past the diff sits in no file.
    const out = src.revert!(DIFF, edited, 9999, "chunk");
    assertEquals(out, null, "no file under the cursor: nothing to revert");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: revert returns null when the file at the cursor's index has a different path", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "a.ts"), "a1\na2\n");
    Deno.writeTextFileSync(join(root, "b.ts"), "b1\nb2\n");
    Deno.writeTextFileSync(join(root, "c.ts"), "c1\nc2\n");
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
    // The original's second file is b.ts; the "current" second file is c.ts, so
    // at file index 1 the paths disagree and revert bails out.
    const original = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 a1
-a0
+a2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
 b1
-b0
+b2
`;
    const current = original
      .replace("a/b.ts b/b.ts", "a/c.ts b/c.ts")
      .replace("--- a/b.ts", "--- a/c.ts")
      .replace("+++ b/b.ts", "+++ b/c.ts")
      .replace(" b1", " c1")
      .replace("-b0", "-c0")
      .replace("+b2", "+c2");
    const { src } = sourceFor(original, ws);
    // Cursor on the second file's hunk (its line index in the current text).
    const curFileLine = current.split("\n").indexOf(" c1");
    const out = src.revert!(original, current, curFileLine, "chunk");
    assertEquals(
      out,
      null,
      "a path mismatch at the cursor's file index is a no-op",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit cov: revert with the 'file' scope restores the whole file's slice", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const edited = DIFF.replace("+const y = 2;", "+const y = 2;EDIT");
    // The cursor sits inside the hunk, but the "file" scope reverts the file as
    // a whole regardless.
    const cursor = edited.split("\n").indexOf("+const y = 2;EDIT");
    const out = src.revert!(DIFF, edited, cursor, "file")!;
    assert(out !== null, "file revert produced a result");
    assert(!out.text.includes("const y = 2;EDIT"), "the file edit is undone");
    assertEquals(out.text, DIFF, "the file slice is restored to the original");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: revert chunk returns null when the original has no matching hunk", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "l1\nl2\nl3\nl4\nl5\nl6\n");
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
    // The original has one hunk; the "current" has gained a second hunk in the
    // same file. A chunk revert of the second hunk finds it in `current` but not
    // in `base`, so `baseHunk` is undefined and revert returns null.
    const original = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 l1
-l0
+l2
`;
    const current = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 l1
-l0
+l2
@@ -5,2 +5,2 @@
 l5
-x6
+l6
`;
    const { src } = sourceFor(original, ws);
    const cursor = current.split("\n").lastIndexOf("+l6");
    const out = src.revert!(original, current, cursor, "chunk");
    assertEquals(
      out,
      null,
      "no original hunk at that index: nothing to revert",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// expandContext error branches
//

const EXPAND_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
const EXPAND_DIFF = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;

Deno.test("diffedit cov: expandContext returns null when the text no longer parses", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    const out = src.expandContext!("not a diff\n", "not a diff\n", 0);
    assertEquals(out, null, "an unparseable diff cannot be expanded");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the cursor is in no hunk", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // The file/header lines (line 0) are in no hunk body.
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, 0);
    assertEquals(
      out,
      null,
      "with no hunk under the cursor there is nothing to expand",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the file cannot be resolved", () => {
  const { root, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    // The workspace resolves and reads at build time (so the source is editable
    // and exposes expandContext), then `resolve` is flipped off so the later
    // expand finds no path for the hunk's file.
    let resolveOk = true;
    const ws: DiffWorkspace = {
      resolve: (p) => (resolveOk ? join(root, p) : null),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const { src } = sourceFor(EXPAND_DIFF, ws);
    resolveOk = false;
    const cursor = EXPAND_DIFF.split("\n").indexOf(" gamma");
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, cursor);
    assertEquals(out, null, "no resolvable path: cannot read more context");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the file content cannot be read", () => {
  const { root, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    // Resolves fine throughout, but `read` is flipped off after build, so the
    // expand cannot fetch the file's lines.
    let readOk = true;
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        if (!readOk) return null;
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const { src } = sourceFor(EXPAND_DIFF, ws);
    readOk = false;
    const cursor = EXPAND_DIFF.split("\n").indexOf(" gamma");
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, cursor);
    assertEquals(out, null, "unreadable file: cannot reveal more context");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the hunk already covers the whole file", () => {
  // The hunk spans the entire two-line file, so there is no context above or
  // below it to reveal.
  const { ws, done } = tempWs({ "m.ts": "one\ntwo\n" });
  try {
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 one
-t...
+two
`;
    const { src } = sourceFor(diff, ws);
    const cursor = diff.split("\n").indexOf(" one");
    const out = src.expandContext!(diff, diff, cursor);
    assertEquals(out, null, "a whole-file hunk has nothing left to expand");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the baseline has fewer hunks", () => {
  const { ws, done } = tempWs({
    "m.ts": "a\nb\nc\nd\ne\nf\ng\nh\n",
  });
  try {
    // `current` carries a second hunk; `baseline` carries only the first. The
    // cursor sits in the second hunk, so the global hunk index is 1, which the
    // baseline's flattened hunk list does not have.
    const current = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
@@ -6,3 +6,3 @@
 f
-y
+g
 h
`;
    const baseline = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
`;
    const { src } = sourceFor(current, ws);
    const cursor = current.split("\n").indexOf(" f");
    const out = src.expandContext!(current, baseline, cursor);
    assertEquals(
      out,
      null,
      "the baseline lacks the cursor's hunk: no expansion",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext ignores orphan hunk-like text", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    // A bare "@@ -3 noise" line sits before the file header. It is not a parsed
    // hunk and must not displace the real hunk that expansion updates.
    const diff = `@@ -3 noise
diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;
    const { src } = sourceFor(diff, ws);
    const cursor = diff.split("\n").indexOf(" epsilon");
    const out = src.expandContext!(diff, diff, cursor)!;
    assert(out.text.startsWith("@@ -3 noise\n"));
    assert(out.text.includes(" zeta"), "the real hunk expands downward");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext reveals context below the hunk and grows its counts", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // The cursor on the hunk's bottom context line expands downward.
    const cursor = EXPAND_DIFF.split("\n").indexOf(" epsilon");
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, cursor)!;
    assert(out !== null, "a backing file with room below expands");
    assert(out.text.includes(" zeta"), "the line below the hunk is revealed");
    assert(out.inserted > 0, "at least one line was inserted");
    // The grown header reflects the larger hunk (3 lines of context become 4).
    const header = out.text.split("\n").find((l) => l.startsWith("@@"))!;
    assertEquals(header, "@@ -3,4 +3,4 @@");
    // Revealing context is not an edit: the baseline grows the same way.
    assert(out.baseline.includes(" zeta"), "the baseline grew identically");
  } finally {
    done();
  }
});

//
// dirtyLabels branches
//

Deno.test("diffedit cov: dirtyLabels returns empty when a side fails to parse", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    // The edited text is not a diff, so parseDiff(current) is null. The original
    // and current differ, so the early equality guard does not fire.
    assertEquals(src.dirtyLabels!(DIFF, "plain text, not a diff\n"), []);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: dirtyLabels names a single file when a change is inside its slice", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
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
    const original = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
`;
    // The edit is inside x.ts's header..endLine slice, so the per-file body
    // comparison attributes it to x.ts directly (the non-fallback branch).
    const current = original.replace("+const y = 3;", "+const y = 30;");
    const { src } = sourceFor(original, ws);
    assertEquals(src.dirtyLabels!(original, current), ["x.ts"]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit cov: dirtyLabels names no file when the change pins to none (e.g. a message)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
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
    // A leading noise line precedes the first file. Both diffs carry it; the
    // edit only changes that leading line, which sits outside every file's
    // header..endLine slice, so no per-file body differs — a save writes no
    // file, and dirtyLabels names none.
    const original = `preamble note
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
`;
    const current = original.replace("preamble note", "preamble note EDITED");
    const { src } = sourceFor(original, ws);
    assertEquals(
      src.dirtyLabels!(original, current),
      [],
      "a change outside every file slice names no file",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// createDiffHighlighter: getter, no-op update, markdown line scan
//

Deno.test("diffedit cov: the highlighter's lines getter returns the seeded lines and a no-op update is a no-op", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const model = parseDiff(DIFF)!;
    const { doc } = buildDiffDocument(DIFF, model, ws);
    const hl = createDiffHighlighter(DIFF, doc.lines);
    // The getter exposes the seed.
    assertEquals(
      hl.lines.length,
      doc.lines.length,
      "lines getter returns the seed",
    );
    assertEquals(hl.lines[0].text, doc.lines[0].text);
    // Updating with the identical text short-circuits and returns the same set.
    const same = hl.update(DIFF);
    assertEquals(same, hl.lines, "a no-op update returns the existing lines");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: a partial seed falls back to rendering the edited line", () => {
  const bodyLine = DIFF.split("\n").indexOf("+const y = 2;");
  const partialSeed = createDiffHighlighter(DIFF).lines.slice(0, bodyLine);
  const highlighter = createDiffHighlighter(
    DIFF,
    partialSeed,
  );
  const edited = DIFF.replace("+const y = 2;", "+const y = 20;");
  const changed = highlighter.update(edited)[bodyLine];
  assertEquals(changed.text, "+const y = 20;");
  assertEquals(changed.spans[0].cls, "diffAdd");
  assertEquals(
    changed.spans.find((span) => span.text === "20")?.cls,
    "number",
  );
});

Deno.test("diffedit cov: deferred parsing selects only changed stateful files", () => {
  const baselines = new Map([
    ["/workspace/changed.ts", "const changed = 1;\n"],
    ["/workspace/untouched.ts", "const untouched = 1;\n"],
    ["/workspace/plain.txt", "plain\n"],
  ]);
  const edited = new Map([
    ["/workspace/changed.ts", "const changed = 2;\n"],
    ["/workspace/untouched.ts", "const untouched = 1;\n"],
    ["/workspace/plain.txt", "changed plain\n"],
  ]);
  assertEquals(
    [..._de.changedStatefulFileOutputs(
      edited,
      baselines,
      new Set([
        "/workspace/changed.ts",
        "/workspace/untouched.ts",
      ]),
    )],
    [["/workspace/changed.ts", "const changed = 2;\n"]],
  );
});

Deno.test("diffedit cov: repeated non-overlapping file sections are highlighted once", () => {
  const file = [
    "const value = `",
    "first",
    "middle",
    "second",
    "`;",
    "",
  ].join("\n");
  const firstSection = [
    "diff --git a/template.ts b/template.ts",
    "--- a/template.ts",
    "+++ b/template.ts",
    "@@ -2 +2 @@",
    "-old first",
    "+first",
  ].join("\n");
  const secondSection = [
    "diff --git a/template.ts b/template.ts",
    "--- a/template.ts",
    "+++ b/template.ts",
    "@@ -4 +4 @@",
    "-old second",
    "+second",
  ].join("\n");
  const diff = `${firstSection}\n${secondSection}\n`;
  const { ws, done } = tempWs({ "template.ts": file });
  const language = typeScriptLanguage as {
    createHighlighter: typeof typeScriptLanguage.createHighlighter;
  };
  const createHighlighter = language.createHighlighter;
  let completeCreates = 0;
  let completeUpdates = 0;
  language.createHighlighter = (text, fileName) => {
    completeCreates++;
    const highlighter = createHighlighter(text, fileName);
    return {
      get lines() {
        return highlighter.lines;
      },
      update: (next) => {
        completeUpdates++;
        return highlighter.update(next);
      },
    };
  };
  try {
    const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
    const highlighter = diffSource(ws, built.edit).createHighlighter!(
      diff,
      built.doc.lines,
    );
    const editedText = diff
      .replace("+first", "+first changed")
      .replace("+second", "+second changed");
    const highlighted = highlighter.update(editedText);
    for (const text of ["first changed", "second changed"]) {
      const changed = highlighted.find((line) => line.text === `+${text}`);
      assertEquals(
        changed?.spans.find((span) => span.text === text)?.cls,
        "template",
      );
    }
    assertEquals(completeCreates, 1);
    assertEquals(completeUpdates, 0);
  } finally {
    language.createHighlighter = createHighlighter;
    done();
  }
});

Deno.test("diffedit cov: deferred parsing preserves optional blob readers", () => {
  const file = ["const value = `", "before", "`;", ""].join("\n");
  const diff = [
    "diff --git a/template.ts b/template.ts",
    "index 1111111..2222222 100644",
    "--- a/template.ts",
    "+++ b/template.ts",
    "@@ -2 +2 @@",
    "-old",
    "+before",
    "",
  ].join("\n");
  const { root, done } = tempWs({ "template.ts": file });
  try {
    for (const reader of ["readBlob", "readBlobs"] as const) {
      let calls = 0;
      const optionalReader: Pick<DiffWorkspace, typeof reader> =
        reader === "readBlob"
          ? {
            readBlob: () => {
              calls++;
              return null;
            },
          }
          : {
            readBlobs: () => {
              calls++;
              return new Map();
            },
          };
      const ws: DiffWorkspace = {
        resolve: (path) => join(root, path),
        read: (path) => Deno.readTextFileSync(path),
        ...optionalReader,
      };
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      calls = 0;
      const editedText = diff.replace("+before", "+after");
      const reparsed = source.parse(editedText);
      assert(calls > 0, `${reader} was forwarded to the deferred parse`);
      const changed = reparsed.lines.find((line) => line.text === "+after");
      assertEquals(
        changed?.spans.find((span) => span.text === "after")?.cls,
        "template",
      );
    }
  } finally {
    done();
  }
});

describe("deferred diff parsing", () => {
  it("forwards blob BOM validation", () => {
    const file = [
      "const header = 2;",
      "const value = 0;",
      "hidden;",
      "next;",
      "",
    ].join("\n");
    const oldFile = [
      "const header = 1;",
      "const value = `",
      "hidden",
      "old",
      "`;",
      "",
    ].join("\n");
    const diff = [
      "diff --git a/template.ts b/template.ts",
      "index 1111111..2222222 100644",
      "--- a/template.ts",
      "+++ b/template.ts",
      "@@ -1 +1 @@",
      "-const header = 1;",
      "+const header = 2;",
      "@@ -4 +4 @@",
      "-old",
      "+next;",
      "",
    ].join("\n");
    const { root, done } = tempWs({ "template.ts": file });
    try {
      const ws: DiffWorkspace = {
        resolve: (path) => join(root, path),
        read: (path) => Deno.readTextFileSync(path),
        hasUtf8Bom: () => false,
        readBlob: () => oldFile,
        blobHasUtf8Bom: () => true,
      };
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);

      const reparsed = source.parse(diff.replace("+next;", "+after;"));
      const removed = reparsed.lines.find((line) => line.text === "-old");

      expect(removed?.spans.find((span) => span.text === "old")?.cls).toBe(
        "identifier",
      );
    } finally {
      done();
    }
  });
});

Deno.test("diffedit cov: the highlighter recolors a Markdown body line via the +++ header scan", () => {
  // Seed-less so the highlighter renders every line itself, then edit a body
  // line whose nearest preceding header is `+++ b/doc.md` — exercising the
  // Markdown-aware path in the recolor.
  const diff = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,2 +1,2 @@
 # Title
-old body
+new body text
`;
  const hl = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  const bodyIdx = raw.indexOf("+new body text");
  raw[bodyIdx] = "+new body text changed";
  const out = hl.update(raw.join("\n"));
  assertEquals(out[bodyIdx].text, "+new body text changed");
  // The marker keeps its added-line color.
  assertEquals(out[bodyIdx].spans[0].cls, "diffAdd");
});

Deno.test("diffedit cov: a CRLF .ts header selects TypeScript for edited lines", () => {
  const diff = [
    "diff --git a/generic.ts b/generic.ts\r",
    "--- a/generic.ts\r",
    "+++ b/generic.ts\r",
    "@@ -0,0 +1 @@\r",
    "+const identity = <T>(value: T): T => value;\r",
    "",
  ].join("\n");
  const highlighter = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  raw[4] = raw[4].replace("value;", "value ;");
  const line = highlighter.update(raw.join("\n"))[4];
  assertEquals(
    line.spans.find((span) => span.text === "value" && span.cls === "parameter")
      ?.cls,
    "parameter",
  );
});

Deno.test("diffedit cov: renamed removed lines use the old extension", () => {
  const diff = `diff --git a/generic.ts b/generic.tsx
--- a/generic.ts
+++ b/generic.tsx
@@ -1 +1 @@
-const identity = <T>(value: T): T => value;
+const view = <div>ready</div>;
`;
  const highlighter = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  raw[4] = raw[4].replace("value;", "value ;");
  const line = highlighter.update(raw.join("\n"))[4];
  assertEquals(
    line.spans.find((span) => span.text === "value" && span.cls === "parameter")
      ?.cls,
    "parameter",
  );
});

Deno.test("diffedit cov: source lines resembling file headers keep the diff path", () => {
  const diff = `diff --git a/generic.ts b/generic.ts
--- a/generic.ts
+++ b/generic.ts
@@ -1 +1 @@
--- oldValue; const before = <T>(input: T): T => input;
+++ newValue; const after = <T>(input: T): T => input;
`;
  const highlighter = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  raw[4] = raw[4].replace("oldValue", "previousValue");
  raw[5] = raw[5].replace("newValue", "nextValue");
  const lines = highlighter.update(raw.join("\n"));
  for (const index of [4, 5]) {
    assertEquals(
      lines[index].spans.find((span) =>
        span.text === "input" && span.cls === "parameter"
      )?.cls,
      "parameter",
      `line ${index + 1} uses the .ts parser`,
    );
  }
});

Deno.test("diffedit cov: the highlighter scans past a missing +++ to the diff --git Markdown header", () => {
  // No `+++ ` line at all (a truncated header), so the backward scan from the
  // edited body line reaches the `diff --git ...md` header instead.
  const text = [
    "diff --git a/notes.md b/notes.md",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+text",
  ].join("\n");
  const hl = createDiffHighlighter(text);
  const raw = text.split("\n");
  const idx = raw.indexOf("+text");
  raw[idx] = "+text more";
  const out = hl.update(raw.join("\n"));
  assertEquals(out[idx].text, "+text more");
  assertEquals(out[idx].spans[0].cls, "diffAdd");
});

Deno.test("diffedit cov: the highlighter returns plain (non-Markdown) coloring when no header precedes a line", () => {
  // A body-only fragment with no preceding header: the backward scan finds
  // nothing and reports not-Markdown.
  const text = [" context", "-old", "+changed"].join("\n");
  const hl = createDiffHighlighter(text);
  const raw = text.split("\n");
  raw[2] = "+changed more";
  const out = hl.update(raw.join("\n"));
  assertEquals(out[2].text, "+changed more");
  assertEquals(out[2].spans[0].cls, "diffAdd");
});

//
// read-only source and save's defensive guards
//

Deno.test("diffedit cov: a diff matching no file on disk yields a read-only source whose save is a no-op", () => {
  // An empty `lines` map means nothing on disk backs the diff: the source is
  // read-only and its save reports there is nothing to write.
  const emptyEdit: DiffEdit = {
    lines: new Map(),
    fileText: new Map(),
    oldFileLines: [],
    languages: diffLanguages(DIFF, parseDiff(DIFF)!),
    hunks: [],
  };
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const src = diffSource(ws, emptyEdit);
  assertEquals(src.editable, false, "no backing file: not editable");
  assertEquals(src.label, null);
  assert(
    (src.reason ?? "").includes("doesn't match"),
    "the reason explains the diff matches nothing",
  );
  assertEquals(
    saveSource(src, "any text"),
    "Nothing to save — this diff matches no file on disk.",
  );
  const parsed = src.parse(DIFF);
  assertEquals(parsed.text, DIFF);
  assert(
    parsed.lines.some((line) =>
      line.spans.some((span) => span.cls === "diffHunk")
    ),
  );
});

Deno.test("diffedit cov: save skips a verified hunk whose file was not captured and reports nothing written", () => {
  // A hand-built edit: one verified hunk pointing at a path that is NOT present
  // in `fileText`. save() collects it into `byFile` but then finds no base
  // content for the path, skips it, and (nothing written) returns the empty
  // message. `lines` is non-empty so the source is the editable one, not the
  // read-only branch.
  const edit: DiffEdit = {
    lines: new Map([[5, { absPath: "/ghost/m.ts", newLine: 0, markerLen: 1 }]]),
    fileText: new Map(), // deliberately missing /ghost/m.ts
    oldFileLines: [],
    languages: [],
    hunks: [
      { absPath: "/ghost/m.ts", newStart: 1, newCount: 1, verified: true },
    ],
  };
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const src = diffSource(ws, edit);
  assertEquals(src.editable, true, "a non-empty lines map is editable");
  // One hunk body, so save matches it to the (verified) recorded hunk.
  const text = "@@ -1,1 +1,1 @@\n+only line\n";
  assertEquals(
    saveSource(src, text),
    "Saved 0 files",
    "an uncaptured file is skipped, leaving nothing written",
  );
});

Deno.test("diffedit cov: save writes the verified hunk's new side back to the captured file", () => {
  const { root, ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    // Edit the added line's content, then save: the new side replaces the file
    // line range the hunk recorded.
    const edited = DIFF.replace("+const y = 2;", "+const y = 2; // saved");
    const msg = saveSource(src, edited);
    assert(msg.startsWith("Saved"), `save reports success: ${msg}`);
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[1], "const y = 2; // saved");
    assertEquals(onDisk[0], "const x = 1;");
    assertEquals(onDisk[2], "const z = 3;");
  } finally {
    done();
  }
});

describe("binary and BOM diff edits", () => {
  it("keeps known and detected binary files read-only", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const cases = [
        {
          path: "asset.png",
          bytes: new TextEncoder().encode("new image bytes\n"),
          body: "new image bytes",
        },
        {
          path: "payload.data",
          bytes: new Uint8Array([0x61, 0xff, 0x62, 0x0a]),
          body: "a�b",
        },
      ];
      for (const testCase of cases) {
        const absPath = join(root, testCase.path);
        Deno.writeFileSync(absPath, testCase.bytes);
        const diff = `diff --git a/${testCase.path} b/${testCase.path}
--- a/${testCase.path}
+++ b/${testCase.path}
@@ -1 +1 @@
-old
+${testCase.body}
`;
        const ws = realWorkspace(root);
        const { edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const source = diffSource(ws, edit);

        expect(edit.lines.size).toBe(0);
        expect(source.editable).toBe(false);
        expect(
          saveSource(
            source,
            diff.replace(testCase.body, `${testCase.body} changed`),
          ),
        ).toBe(
          "Nothing to save — this diff matches no file on disk.",
        );
        expect(Deno.readFileSync(absPath)).toEqual(testCase.bytes);
      }
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("preserves one UTF-8 BOM when saving a diff", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("const value = 2;\n"),
        ]),
      );
      const bom = "\uFEFF";
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-${bom}const value = 1;
+${bom}const value = 2;
`;
      const ws = realWorkspace(root);
      const { edit, maps } = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, edit);
      expect(source.editable).toBe(true);
      const firstContent = diff.indexOf("const value = 2;");
      expect(maps.toFile(firstContent)).toEqual({ path, offset: 0 });
      expect(maps.fromFile(path, 0)).toBe(firstContent);

      const edited = diff.replace(
        `+${bom}const value = 2;`,
        `+${bom}const value = 3;`,
      );
      expect(saveSource(source, edited, diff)).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("const value = 3;\n"),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps edits after a decoded BOM and writes it once", () => {
    const { path, bom, row, session, done } = bomDiffSession();
    try {
      session.handleKey({ name: "X", char: "X" });

      expect(session.doc.lines[row].text).toBe(`+${bom}Xconst value = 2;`);
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("Xconst value = 2;\n"),
        ]),
      );
    } finally {
      done();
    }
  });

  it("keeps a BOM first when Enter inserts before a context line", () => {
    const { path, bom, row, session, done } = bomDiffSession("context");
    try {
      session.handleKey({ name: "enter" });

      expect(session.doc.lines[row].text).toBe(`-${bom}const value = 2;`);
      expect(session.doc.lines[row + 1].text).toBe(`+${bom}`);
      expect(session.doc.lines[row + 2].text).toBe("+const value = 2;");
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode(
            "\nconst value = 2;\nconst tail = 2;\n",
          ),
        ]),
      );
    } finally {
      done();
    }
  });

  it("moves the BOM when resurrecting the first removed line", () => {
    const { path, bom, row, session, done } = bomDiffSession();
    try {
      session.handleKey({ name: "up" });
      session.handleKey({ name: "r", char: "r" });

      expect(session.doc.lines[row - 1].text).toBe(
        ` ${bom}const value = 1;`,
      );
      expect(session.doc.lines[row].text).toBe("+const value = 2;");
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode(
            "const value = 1;\nconst value = 2;\n",
          ),
        ]),
      );
    } finally {
      done();
    }
  });

  it("does not add a BOM when resurrecting a later file line", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode("first\nreplacement\nthird\n"),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -2 +2 @@
-second
+replacement
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "r", char: "r" });

      expect(session.doc.lines[4].text).toBe(" second");
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode("first\nsecond\nreplacement\nthird\n"),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps literal BOM provenance after deleting earlier context", () => {
    const bom = "\uFEFF";
    const encoder = new TextEncoder();
    const cases = [
      {
        separator: "\n",
        fileText: "\nnew\n",
        diffLines: [
          "@@ -1,2 +1,2 @@",
          " ",
          `-${bom}second`,
          "+new",
        ],
        expected: `${bom}second\nnew\n`,
      },
      {
        separator: "\r\n",
        fileText: "\r\nnew\r\n",
        diffLines: [
          "@@ -1,2 +1,2 @@",
          " ",
          `-${bom}second`,
          "+new",
        ],
        expected: `${bom}second\r\nnew\r\n`,
      },
    ];
    for (const testCase of cases) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(path, encoder.encode(testCase.fileText));
        const diff = [
          "diff --git a/value.ts b/value.ts",
          "--- a/value.ts",
          "+++ b/value.ts",
          ...testCase.diffLines,
          "",
        ].join(testCase.separator);
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 4;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "home" });
        session.handleKey({ name: "backspace" });

        expect(session.doc.lines[4].text).toBe(
          `-${testCase.separator === "\r\n" ? "\r" : ""}`,
        );
        session.handleKey({ name: "down" });
        session.handleKey({ name: "r", char: "r" });
        session.handleKey({ name: "f3" });
        expect(session.view().message).toBe("Saved 1 file");
        expect(Deno.readFileSync(path)).toEqual(
          encoder.encode(testCase.expected),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("keeps both BOM markers after deleting encoded empty context", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`\n${bom}second\nnew\n`),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,3 +1,3 @@
 ${bom}
 ${bom}second
-old
+new
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "backspace" });

      expect(session.doc.lines[4].text).toBe(`-${bom}`);
      expect(session.doc.lines[5].text).toBe(`-${bom}second`);
      expect(session.doc.lines[6].text).toBe(`+${bom}${bom}second`);
      session.handleKey({ name: "down" });
      session.handleKey({ name: "r", char: "r" });
      session.handleKey({ name: "f3" });
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`${bom}second\n${bom}second\nnew\n`),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("splits a shared BOM carrier when resurrecting the first line", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("current\n"),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1 @@
-${bom}old
 ${bom}current
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "r", char: "r" });

      expect(session.doc.lines[4].text).toBe(` ${bom}old`);
      expect(session.doc.lines[5].text).toBe(`-${bom}current`);
      expect(session.doc.lines[6].text).toBe("+current");
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("old\ncurrent\n"),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("resurrects across BOM changes and an earlier carrier", () => {
    const bom = "\uFEFF";
    const encoder = new TextEncoder();
    const cases = [
      {
        oldBom: "",
        newBom: bom,
        additionFirst: false,
        expectedText: "old\nnew\n",
      },
      {
        oldBom: bom,
        newBom: "",
        additionFirst: false,
        expectedText: "old\nnew\n",
      },
      {
        oldBom: bom,
        newBom: bom,
        additionFirst: true,
        expectedText: "new\nold\n",
      },
    ];
    for (const testCase of cases) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(
          path,
          new Uint8Array([
            ...(testCase.newBom ? [0xef, 0xbb, 0xbf] : []),
            ...encoder.encode("new\n"),
          ]),
        );
        const body = testCase.additionFirst
          ? `+${testCase.newBom}new\n-${testCase.oldBom}old`
          : `-${testCase.oldBom}old\n+${testCase.newBom}new`;
        const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
${body}
`;
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = testCase.additionFirst ? 5 : 4;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "r", char: "r" });
        session.handleKey({ name: "f3" });

        expect(session.view().message).toBe("Saved 1 file");
        expect(Deno.readFileSync(path)).toEqual(
          new Uint8Array([
            ...(testCase.newBom ? [0xef, 0xbb, 0xbf] : []),
            ...encoder.encode(testCase.expectedText),
          ]),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("keeps CRLF transport on Enter-created diff lines", () => {
    const bom = "\uFEFF";
    const encoder = new TextEncoder();
    const cases = [
      {
        fileText: "first\r\ntail-new\r\n",
        row: 4,
        diffLines: [
          "@@ -1,2 +1,2 @@",
          ` ${bom}first`,
          "-tail-old",
          "+tail-new",
        ],
        expected: "\r\nfirst\r\ntail-new\r\n",
      },
      {
        fileText: "new\r\n",
        row: 5,
        diffLines: [
          "@@ -1 +1 @@",
          `-${bom}old`,
          `+${bom}new`,
        ],
        expected: "\r\nnew\r\n",
      },
    ];
    for (const testCase of cases) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(
          path,
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...encoder.encode(testCase.fileText),
          ]),
        );
        const diff = [
          "diff --git a/value.ts b/value.ts",
          "--- a/value.ts",
          "+++ b/value.ts",
          ...testCase.diffLines,
          "",
        ].join("\r\n");
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = testCase.row;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "home" });
        session.handleKey({ name: "enter" });
        session.handleKey({ name: "f3" });

        expect(session.view().message).toBe("Saved 1 file");
        expect(Deno.readFileSync(path)).toEqual(
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...encoder.encode(testCase.expected),
          ]),
        );

        session.handleKey({ name: "up" });
        session.handleKey({ name: "home" });
        session.handleKey({ name: "backspace" });
        session.handleKey({ name: "f3" });
        expect(Deno.readFileSync(path)).toEqual(
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...encoder.encode(testCase.fileText),
          ]),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("keeps CRLF transport outside line editing operations", () => {
    const encoder = new TextEncoder();
    const cases: Array<{
      keys: Array<{ name: string }>;
      expected: string;
    }> = [
      { keys: [{ name: "end" }, { name: "backspace" }], expected: "ne\r\n" },
      {
        keys: [{ name: "end" }, { name: "left" }, { name: "delete" }],
        expected: "ne\r\n",
      },
      { keys: [{ name: "home" }, { name: "ctrl-k" }], expected: "\r\n" },
      {
        keys: [
          { name: "home" },
          { name: "right" },
          { name: "ctrl-space" },
          { name: "end" },
          { name: "ctrl-w" },
        ],
        expected: "\r\n",
      },
    ];
    for (const testCase of cases) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(path, encoder.encode("new\r\n"));
        const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-old\r
+new\r
`;
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 5;
        session.handleKey({ name: "e" });
        for (const key of testCase.keys) session.handleKey(key);
        session.handleKey({ name: "f3" });

        expect(Deno.readFileSync(path)).toEqual(
          encoder.encode(testCase.expected),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("uses workspace newlines instead of CRLF diff transport", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("new\n"));
      const diff = [
        "diff --git a/value.ts b/value.ts",
        "--- a/value.ts",
        "+++ b/value.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\r\n");
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "left" });
      session.handleKey({ name: "delete" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(encoder.encode("ne\n"));
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("inherits CRLF when Enter terminates a standard Git EOF row", () => {
    const encoder = new TextEncoder();
    const cases = [
      { fileText: "first\r\nnew", row: "+new", expected: "first\r\nnew\r\n" },
      {
        fileText: "first\r\nlast\r",
        row: "+last\r",
        expected: "first\r\nlast\r\r\n",
      },
    ];
    for (const testCase of cases) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(path, encoder.encode(testCase.fileText));
        const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -2 +2 @@
-old
\\ No newline at end of file
${testCase.row}
\\ No newline at end of file
`;
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 6;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "end" });
        session.handleKey({ name: "enter" });
        session.handleKey({ name: "f3" });

        expect(Deno.readFileSync(path)).toEqual(
          encoder.encode(testCase.expected),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("preserves an unterminated EOF when its diff omits metadata", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      Deno.writeTextFileSync(path, "new");
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-old
+new
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(Deno.readTextFileSync(path)).toBe("ne");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps mixed workspace endings attached to surviving rows", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("alpha\r\nbeta\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
 alpha\r
-old
+beta
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "enter" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("alpha\r\n\r\nbeta\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps duplicate rows attached to their own ending provenance", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("x\r\nx\r"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
 x\r
-old
+x\r
\\ No newline at end of file
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(encoder.encode("x\r"));
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps the preceding ending when a later added row is deleted", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("A\r\nA\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
-old1
-old2
+A\r
+A
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 7;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(encoder.encode("A\r\n"));
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps a surviving newline after deleting an unterminated EOF row", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      Deno.writeTextFileSync(path, "first\nlast");
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
 first
-old
+last
\\ No newline at end of file
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 6;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(Deno.readTextFileSync(path)).toBe("first\n");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("retains a removed row's ending across repeated saves", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("A\r\nB\nC\r\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,3 +1,3 @@
 A\r
 B
-oldC\r
+C\r
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      for (
        const name of [
          "e",
          "home",
          "ctrl-k",
          "backspace",
          "f3",
          "r",
          "f3",
        ]
      ) {
        session.handleKey({ name });
      }

      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("A\r\nB\nC\r\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("retains a saved removed row's ending through every revert scope", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("A\r\nC\r\n"));
      const baseline = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,3 +1,2 @@
 A\r
-B
-oldC\r
+C\r
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(baseline, parseDiff(baseline)!, ws);
      const source = diffSource(ws, built.edit);
      const current = baseline.replace("+C\r", "+CX\r");
      const lineEndings = [...source.lineEndingProvenance!(baseline)];
      const lf = { ending: "\n", bodyCarriesCrlfEnding: false } as const;
      lineEndings[5] = lf;

      for (const scope of ["chunk", "file", "all"] as const) {
        const reverted = source.revert!(
          baseline,
          current,
          7,
          scope,
          lineEndings,
        )!;
        expect(reverted.lineEndings?.[5]).toEqual(lf);
      }
      const reverted = source.revert!(
        baseline,
        current,
        7,
        "all",
        lineEndings,
      )!;
      const resurrected = baseline
        .replace("@@ -1,3 +1,2 @@", "@@ -1,3 +1,3 @@")
        .replace("-B\n", " B\n");
      expect(source.save(resurrected, reverted.lineEndings!, baseline)).toBe(
        "Saved 1 file",
      );
      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("A\r\nB\nC\r\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("rebuilds mixed endings after context expansion joins hunks", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("a\r\nB\r\nc\nD\nE\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
 a\r
-oldB\r
+B\r
@@ -4,2 +4,2 @@
 D
-oldE
+E
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      const expanded = source.expandContext!(diff, diff, 6, false)!;

      expect(parseDiff(expanded.text)!.files[0].hunks).toHaveLength(1);
      expect(saveSource(source, expanded.text.replace("+E", "+EE"))).toBe(
        "Saved 1 file",
      );
      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("a\r\nB\r\nc\nD\nEE\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps mixed-transport hunks separate when expansion makes them touch", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("a\nB\nc\nD\r\nE\r\n"));
      const diff = [
        "diff --git a/value.ts b/value.ts",
        "--- a/value.ts",
        "+++ b/value.ts",
        "@@ -1,2 +1,2 @@",
        " a",
        "-oldB",
        "+B",
      ].join("\n") + "\n" + [
        "@@ -4,2 +4,2 @@",
        " D",
        "-oldE",
        "+E",
        "",
      ].join("\r\n");
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 12 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 10;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "Z", char: "Z" });
      session.handleKey({ name: "ctrl-l" });
      session.handleKey({ name: "f3" });

      expect(parseDiff(session.doc.text)!.files[0].hunks).toHaveLength(2);
      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("a\nB\nc\nD\r\nEZ\r\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps revealed endings after an unsaved insertion", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("A\r\nB\r\nC\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
 A\r
-oldB\r
+B\r
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "enter" });
      session.handleKey({ name: "ctrl-l" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("\r\nA\r\nB\r\nC\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps a literal CR in expanded CRLF-transport context", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("A\r\nX\r\r\n"));
      const diff = [
        "diff --git a/value.ts b/value.ts",
        "--- a/value.ts",
        "+++ b/value.ts",
        "@@ -1 +1 @@",
        "-oldA",
        "+A",
        "",
      ].join("\r\n");
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "Z", char: "Z" });
      session.handleKey({ name: "ctrl-l" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(
        encoder.encode("AZ\r\nX\r\r\n"),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps literal CR provenance on resurrected expansion pairs", () => {
    const encoder = new TextEncoder();
    for (
      const testCase of [
        {
          workspace: "A\r\nX\r\r\n",
          expected: "AZ\r\nX\r\r\nX\r\r\n",
        },
        {
          workspace: "A\r\nX\r",
          expected: "AZ\r\nX\r\r\nX\r",
        },
      ]
    ) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(
          path,
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...encoder.encode(testCase.workspace),
          ]),
        );
        const diff = [
          "diff --git a/value.ts b/value.ts",
          "--- a/value.ts",
          "+++ b/value.ts",
          "@@ -0,0 +1 @@",
          "+\uFEFFA",
          "",
        ].join("\r\n");
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 4;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "end" });
        session.handleKey({ name: "Z", char: "Z" });
        session.handleKey({ name: "ctrl-l" });
        session.handleKey({ name: "down" });
        session.handleKey({ name: "R" });
        session.handleKey({ name: "f3" });

        expect(Deno.readFileSync(path)).toEqual(
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...encoder.encode(testCase.expected),
          ]),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("requires row provenance when saving a diff directly", () => {
    const { root, ws, done } = tempWs({ "m.ts": FILE_TEXT });
    try {
      const { src } = sourceFor(DIFF, ws);
      const saveWithoutProvenance = src.save as unknown as (
        text: string,
      ) => string;

      expect(() => saveWithoutProvenance(DIFF)).toThrow(
        "Edited diff row provenance is incomplete.",
      );
      expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe(FILE_TEXT);
    } finally {
      done();
    }
  });

  it("uses carried CRLF transport after a direct character edit", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("new\r\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-old\r
+new\r
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      const edited = diff.replace("+new\r", "+ne\r");

      expect(
        source.save(edited, source.lineEndingProvenance!(diff), diff),
      ).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(encoder.encode("ne\r\n"));
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps an edited CRLF hunk verified after reparse", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      Deno.writeFileSync(path, new TextEncoder().encode("new\r\n"));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-old\r
+new\r
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "escape" });

      expect(JSON.stringify(session.doc.structure)).not.toContain(
        "workspace differs",
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("separates literal CR content from CRLF diff transport", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const encoder = new TextEncoder();
      Deno.writeFileSync(path, encoder.encode("new\r\r\n"));
      const diff = [
        "diff --git a/value.ts b/value.ts",
        "--- a/value.ts",
        "+++ b/value.ts",
        "@@ -1 +1 @@",
        "-old\r",
        "+new\r",
        "",
      ].join("\r\n");
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "right" });
      session.handleKey({ name: "right" });
      session.handleKey({ name: "delete" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(encoder.encode("nw\r\r\n"));
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("preserves represented empty EOF rows across repeated saves", () => {
    const encoder = new TextEncoder();
    for (const edit of ["newline", "empty"] as const) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(path, encoder.encode("new"));
        const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`;
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 5;
        session.handleKey({ name: "e" });
        if (edit === "newline") {
          session.handleKey({ name: "end" });
          session.handleKey({ name: "enter" });
          session.handleKey({ name: "f3" });
          session.handleKey({ name: "up" });
          session.handleKey({ name: "end" });
          session.handleKey({ name: "backspace" });
          session.handleKey({ name: "f3" });
          expect(Deno.readFileSync(path)).toEqual(encoder.encode("ne\n"));
        } else {
          session.handleKey({ name: "home" });
          session.handleKey({ name: "ctrl-k" });
          session.handleKey({ name: "f3" });
          session.handleKey({ name: "y", char: "y" });
          session.handleKey({ name: "f3" });
          expect(Deno.readFileSync(path)).toEqual(encoder.encode("y"));
        }
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("keeps a literal final carriage return editable", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      Deno.writeFileSync(path, new Uint8Array([0x0d]));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-old
+\r
\\ No newline at end of file
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "end" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(Deno.readFileSync(path)).toEqual(new Uint8Array());
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("marks unterminated file context revealed at the bottom of a hunk", () => {
    const encoder = new TextEncoder();
    const cases = [
      {
        diffEnding: "\n",
        fileText: "first\nnew\nlast\r",
        expected: "first\nnew\nlast",
      },
      {
        diffEnding: "\r\n",
        fileText: "first\r\nnew\r\nlast\r",
        expected: "first\r\nnew\r\nlast",
      },
    ];
    for (const testCase of cases) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(path, encoder.encode(testCase.fileText));
        const diff = [
          "diff --git a/value.ts b/value.ts",
          "--- a/value.ts",
          "+++ b/value.ts",
          "@@ -2 +2 @@",
          "-old",
          "+new",
          "",
        ].join(testCase.diffEnding);
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 5;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "ctrl-l" });

        const expandedLines = session.doc.text.split("\n");
        const marker = expandedLines.findIndex((line) =>
          line.replace(/\r$/, "") === "\\ No newline at end of file"
        );
        expect(marker).toBeGreaterThan(0);
        expect(parseDiff(session.doc.text)!.lines[marker]?.kind).toBe("meta");

        session.handleKey({ name: "down" });
        session.handleKey({ name: "end" });
        session.handleKey({ name: "backspace" });
        session.handleKey({ name: "f3" });

        expect(session.view().message).toBe("Saved 1 file");
        expect(Deno.readFileSync(path)).toEqual(
          encoder.encode(testCase.expected),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("keeps an inserted empty line at an unterminated file end", () => {
    const encoder = new TextEncoder();
    for (
      const testCase of [
        { diffEnding: "\n", expected: "new\n" },
        { diffEnding: "\r\n", expected: "new\r\n" },
      ]
    ) {
      const root = Deno.makeTempDirSync();
      try {
        Deno.mkdirSync(join(root, ".git"));
        const path = join(root, "value.ts");
        Deno.writeFileSync(path, encoder.encode("new"));
        const diff = [
          "diff --git a/value.ts b/value.ts",
          "--- a/value.ts",
          "+++ b/value.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "\\ No newline at end of file",
          "",
        ].join(testCase.diffEnding);
        const ws = realWorkspace(root);
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          built.doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 10 },
          undefined,
          diffSource(ws, built.edit),
        );
        session.top = 5;
        session.handleKey({ name: "e" });
        session.handleKey({ name: "end" });
        session.handleKey({ name: "enter" });
        session.handleKey({ name: "f3" });

        expect(session.view().message).toBe("Saved 1 file");
        expect(Deno.readFileSync(path)).toEqual(
          encoder.encode(testCase.expected),
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    }
  });

  it("refuses a backward word kill across the BOM marker", () => {
    const { path, session, done } = bomDiffSession(
      "added",
      "  const value = 2;",
    );
    try {
      const before = session.doc.text;
      for (let i = 0; i < 4; i++) session.handleKey({ name: "right" });
      session.handleKey({ name: "backspace", alt: true });

      expect(session.doc.text).toBe(before);
      session.handleKey({ name: "f3" });
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("  const value = 2;\n"),
        ]),
      );
    } finally {
      done();
    }
  });

  it("refuses a forward word kill across a diff line", () => {
    const { path, session, done } = bomDiffSession("context", "   ");
    try {
      const before = session.doc.text;
      session.handleKey({ name: "right" });
      session.handleKey({ name: "right" });
      session.handleKey({ name: "d", char: "d", alt: true });

      expect(session.doc.text).toBe(before);
      session.handleKey({ name: "f3" });
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("   \nconst tail = 2;\n"),
        ]),
      );
    } finally {
      done();
    }
  });

  it("preserves a literal BOM character shifted onto line zero", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const literalBom = "\uFEFF";
      const original = `first\n${literalBom}second\nnew\n`;
      Deno.writeFileSync(path, new TextEncoder().encode(original));
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,3 +1,3 @@
 first
 ${literalBom}second
-old
+new
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new TextEncoder().encode(`${literalBom}second\nnew\n`),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("preserves a literal BOM after an encoding BOM", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`first\n${bom}second\nnew\n`),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,3 +1,3 @@
 ${bom}first
 ${bom}second
-old
+new
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 4;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });

      expect(session.doc.lines[5].text).toBe(`-${bom}second`);
      expect(session.doc.lines[6].text).toBe(`+${bom}${bom}second`);
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`${bom}second\nnew\n`),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("moves a deleted first-line BOM to the next addition", () => {
    const { path, bom, row, session, done } = bomDiffSession(
      "added",
      "first",
      "second",
    );
    try {
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });

      expect(session.doc.lines[row].text).toBe(`+${bom}second`);
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("second\n"),
        ]),
      );
    } finally {
      done();
    }
  });

  it("keeps the encoding BOM when deleting the only file line", () => {
    const { path, session, done } = bomDiffSession();
    try {
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "f3" });

      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([0xef, 0xbb, 0xbf]),
      );
    } finally {
      done();
    }
  });

  it("restores a BOM when upward expansion reveals file line zero", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`${bom}first\nsecond\nthird-new\n`),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -3 +3 @@
-third-old
+third-new
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      const expanded = source.expandContext!(diff, diff, 4, true)!;

      expect(expanded.text).toContain(` ${bom}${bom}first\n second\n`);
      const rebuilt = buildDiffDocument(
        expanded.text,
        parseDiff(expanded.text)!,
        ws,
      );
      expect(rebuilt.edit.lines.size).toBeGreaterThan(0);
      expect(
        saveSource(
          source,
          expanded.text.replace("+third-new", "+third-edited"),
          expanded.baseline,
        ),
      ).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`${bom}first\nsecond\nthird-edited\n`),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("marks both sides of an unterminated BOM replacement", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode("inserted\r\nexisting"),
        ]),
      );
      const diff = [
        "diff --git a/value.ts b/value.ts",
        "--- a/value.ts",
        "+++ b/value.ts",
        "@@ -0,0 +1 @@",
        `+${bom}inserted`,
        "",
      ].join("\r\n");
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      const expanded = source.expandContext!(diff, diff, 4, false)!;
      const lines = expanded.text.split("\n");
      const markers = lines.flatMap((line, index) =>
        line.replace(/\r$/, "") === "\\ No newline at end of file"
          ? [index]
          : []
      );

      expect(markers).toHaveLength(2);
      expect(lines[markers[0] - 1]).toBe(`-${bom}existing\r`);
      expect(lines[markers[1] - 1]).toBe("+existing\r");
      expect(lines[markers[0]].endsWith("\r")).toBe(true);
      expect(lines[markers[1]].endsWith("\r")).toBe(true);
      const rebuilt = buildDiffDocument(
        expanded.text,
        parseDiff(expanded.text)!,
        ws,
      );
      expect(rebuilt.edit.hunks[0]?.oldNoTrailingNewline).toBe(true);
      expect(rebuilt.edit.hunks[0]?.newNoTrailingNewline).toBe(true);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("infers an old blob's BOM when its reader omits byte metadata", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode("first\nsecond\nnew\n"),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
index 1111111..2222222 100644
--- a/value.ts
+++ b/value.ts
@@ -3 +3 @@
-old
+new
`;
      const baseWorkspace = realWorkspace(root);
      const ws: DiffWorkspace = {
        ...baseWorkspace,
        readBlob: () => "first\nsecond\nold\n",
        readBlobs: undefined,
        blobHasUtf8Bom: undefined,
      };
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      const expanded = source.expandContext!(diff, diff, 6, true)!;

      expect(expanded.text).toContain(` ${bom}first\n second\n`);
      expect(expanded.text).not.toContain("-first\n");
      expect(
        saveSource(
          source,
          expanded.text.replace("+new", "+edited"),
          expanded.baseline,
        ),
      ).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode("first\nsecond\nedited\n"),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps inferred old BOM state when another hunk is stale", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode("first\ncurrent\nthird\ndifferent\n"),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -2 +2 @@
-old
+current
@@ -4 +4 @@
-old-fourth
+expected-fourth
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const source = diffSource(ws, built.edit);
      const expanded = source.expandContext!(diff, diff, 4, true)!;

      expect(expanded.text).toContain(` ${bom}first\n-old\n+current`);
      expect(expanded.baseline).toContain(` ${bom}first\n-old\n+current`);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps a literal BOM when expansion moves it to file line zero", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`first\n${bom}second\n`),
        ]),
      );
      const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-${bom}old
+${bom}first
`;
      const ws = realWorkspace(root);
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(ws, built.edit),
      );
      session.top = 5;
      session.handleKey({ name: "e" });
      session.handleKey({ name: "home" });
      session.handleKey({ name: "ctrl-k" });
      session.handleKey({ name: "backspace" });
      session.handleKey({ name: "ctrl-l" });

      expect(session.doc.text).toContain(`-${bom}second\n+${bom}${bom}second`);
      session.handleKey({ name: "f3" });
      expect(session.view().message).toBe("Saved 1 file");
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...encoder.encode(`${bom}second\n`),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("requires matching BOM state before making a hunk editable", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.ts");
      const bom = "\uFEFF";
      const encoder = new TextEncoder();
      const cases = [
        {
          diskBytes: encoder.encode("const value = 2;\n"),
          oldDiffBom: "",
          newDiffBom: bom,
        },
        {
          diskBytes: new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...encoder.encode("const value = 2;\n"),
          ]),
          oldDiffBom: bom,
          newDiffBom: "",
        },
      ];

      for (const testCase of cases) {
        Deno.writeFileSync(path, testCase.diskBytes);
        const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +1 @@
-${testCase.oldDiffBom}const value = 1;
+${testCase.newDiffBom}const value = 2;
`;
        const ws = realWorkspace(root);
        const { edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const source = diffSource(ws, edit);

        expect(edit.lines.size).toBe(0);
        expect(source.editable).toBe(false);
        expect(
          saveSource(source, diff.replace("value = 2", "value = 3")),
        ).toBe(
          "Nothing to save — this diff matches no file on disk.",
        );
        expect(Deno.readFileSync(path)).toEqual(testCase.diskBytes);
      }

      Deno.writeFileSync(path, new Uint8Array([0xef, 0xbb, 0xbf]));
      const emptyDiff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1 +0,0 @@
-old
`;
      const ws = realWorkspace(root);
      const { edit } = buildDiffDocument(
        emptyDiff,
        parseDiff(emptyDiff)!,
        ws,
      );
      const source = diffSource(ws, edit);
      expect(edit.lines.size).toBe(0);
      expect(source.editable).toBe(false);
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([0xef, 0xbb, 0xbf]),
      );

      const matchingBomOnlyDiff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -0,0 +1 @@
+${bom}
\\ No newline at end of file
`;
      const matchingWs = realWorkspace(root);
      const matchingModel = parseDiff(matchingBomOnlyDiff)!;
      expect(matchingModel.lines[5]?.kind).toBe("meta");
      const matching = buildDiffDocument(
        matchingBomOnlyDiff,
        matchingModel,
        matchingWs,
      );
      expect(matching.edit.hunks[0]?.newNoTrailingNewline).toBe(true);
      expect(matching.edit.lines.size).toBe(1);
      expect(diffSource(matchingWs, matching.edit).editable).toBe(true);

      const matchingBomOnlyCrlfDiff = [
        "diff --git a/value.ts b/value.ts",
        "--- a/value.ts",
        "+++ b/value.ts",
        "@@ -0,0 +1 @@",
        `+${bom}`,
        "\\ No newline at end of file",
        "",
      ].join("\r\n");
      const matchingCrlfWs = realWorkspace(root);
      const matchingCrlf = buildDiffDocument(
        matchingBomOnlyCrlfDiff,
        parseDiff(matchingBomOnlyCrlfDiff)!,
        matchingCrlfWs,
      );
      const matchingCrlfSession = new Session(
        matchingCrlf.doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 10 },
        undefined,
        diffSource(matchingCrlfWs, matchingCrlf.edit),
      );
      matchingCrlfSession.top = 4;
      matchingCrlfSession.handleKey({ name: "e" });
      matchingCrlfSession.handleKey({ name: "end" });
      matchingCrlfSession.handleKey({ name: "x", char: "x" });
      matchingCrlfSession.handleKey({ name: "f3" });
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([0xef, 0xbb, 0xbf, 0x78]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

//
// editableStart: position/verified-aware line editability
//

Deno.test("editableStart: a null model (buffer is not a diff) refuses every line", () => {
  assertEquals(_de.editableStart(null, [], " some text", 0), null);
});

Deno.test("editableStart: editable only inside a verified hunk", () => {
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,3 @@
 keep
-old
+new
+added
`;
  const model = parseDiff(diff)!;
  const lines = diff.split("\n");
  // One hunk, marked verified and backed by a file.
  const verified = [{
    absPath: "/x",
    newStart: 1,
    newCount: 3,
    verified: true,
  }];
  // Line 4 = " keep" (ctx) → editable past the marker; 5 = "-old" (removed) →
  // refused; 6/7 = "+new"/"+added" (add) → editable; 0 = the file header → not
  // in any hunk, refused.
  assertEquals(_de.editableStart(model, verified, lines[4], 4), 1, "context");
  assertEquals(
    _de.editableStart(model, verified, lines[5], 5),
    null,
    "removed",
  );
  assertEquals(_de.editableStart(model, verified, lines[6], 6), 1, "added");
  assertEquals(_de.editableStart(model, verified, lines[0], 0), null, "header");
  // The same hunk, unverified: even its context/added lines are refused.
  const unver = [{ absPath: null, newStart: 1, newCount: 3, verified: false }];
  assertEquals(
    _de.editableStart(model, unver, lines[4], 4),
    null,
    "unverified",
  );
});

//
// commit amend helpers
//

Deno.test("pendingAmend: null when there is no editable message", () => {
  assertEquals(
    _de.pendingAmend(() => null, () => null, false, "a", "b"),
    null,
  );
});

Deno.test("pendingAmend: null when the full buffer is unchanged", () => {
  const msg = { sha: "abcdef1", start: 0, end: 0 };
  const both = () => msg;
  assertEquals(_de.pendingAmend(both, both, false, "    hi", "    hi"), null);
});

Deno.test("pendingAmend: an unchanged message still amends changed commit contents", () => {
  const msg = { sha: "abcdef1", start: 0, end: 0 };
  const both = () => msg;
  assertEquals(
    _de.pendingAmend(both, both, true, "    hi\n-old", "    hi\n+new"),
    { sha: "abcdef1", subject: "hi" },
  );
});

Deno.test("baselineAfterSave: keeps the baseline for a changed hunk layout", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const moved = DIFF.replace("b/m.ts", "b/other.ts");
    assertEquals(
      src.baselineAfterSave!(DIFF, moved, { amendCommit: false }),
      DIFF,
    );

    const extra = `${DIFF}@@ -5,0 +6,1 @@\n+extra\n`;
    assertEquals(
      src.baselineAfterSave!(DIFF, extra, { amendCommit: false }),
      DIFF,
    );
  } finally {
    done();
  }
});

Deno.test("diffSource: ignores commit-shaped text inside a file diff", () => {
  const head = "1".repeat(40);
  const embedded = "2".repeat(40);
  const text = [
    `From ${head} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Subject",
    "",
    "diff --git a/m.ts b/m.ts",
    "index 1111..2222 100644",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    `From ${embedded} Mon Sep 17 00:00:00 2001`,
    "From: C D <c@d.example>",
    "Date: Thu, 2 Jul 2026 12:00:00 -0700",
    "Subject: embedded text",
    "",
  ].join("\n");
  const { ws, done } = tempWs({ "m.ts": "new\n" });
  const matched: string[] = [];
  try {
    const model = parseDiff(text)!;
    const { edit } = buildDiffDocument(text, model, ws);
    const src = diffSource(ws, edit, undefined, {
      headSha: () => head,
      fileAtCommit: () => null,
      applyFileChanges: (committed) => committed,
      amendCommit: () => ({ status: "unused", head }),
      commitMatchesDiff: (commit) => {
        matched.push(commit);
        return commit === head;
      },
    });
    const edited = text.replace("+new", "+newer");

    assertEquals(src.pendingAmend!(text, edited), {
      sha: head,
      subject: "(empty commit message)",
    });
    assertEquals(matched, [head]);
  } finally {
    done();
  }
});

Deno.test("save: rejects a diff with a different hunk count", () => {
  const { root, ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const edited = `${DIFF.replace("+const y = 2;", "+const y = 20;")}` +
      `@@ -3,0 +4,1 @@\n+const added = true;\n`;

    assertThrows(
      () => saveSource(src, edited, DIFF, { amendCommit: false }),
      Error,
      "The edited diff no longer matches its saved hunk map.",
    );
    assertEquals(Deno.readTextFileSync(join(root, "m.ts")), FILE_TEXT);
  } finally {
    done();
  }
});

//
// message-scope revert
//

const SHOW_DIFF = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: A B <a@b>",
  "Date:   now",
  "",
  "    Subject",
  "",
  "diff --git a/m.ts b/m.ts",
  "--- a/m.ts",
  "+++ b/m.ts",
  "@@ -1,2 +1,2 @@",
  " const x = 1;",
  "-const y = 0;",
  "+const y = 2;",
  " const z = 3;",
  "",
].join("\n");

Deno.test("diffedit cov: message revert restores the message region", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(SHOW_DIFF, ws);
    const edited = SHOW_DIFF.replace("    Subject", "    Subject CHANGED");
    const out = src.revert!(SHOW_DIFF, edited, 4, "message")!;
    assert(out, "reverted");
    assertEquals(out.text.split("\n")[4], "    Subject", "message restored");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: message revert is null when the cursor is in no message", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(SHOW_DIFF, ws);
    const edited = SHOW_DIFF.replace("    Subject", "    Subject CHANGED");
    // Cursor on the "commit" line, outside the indented message region.
    assertEquals(src.revert!(SHOW_DIFF, edited, 0, "message"), null);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: message revert is null when the baseline has no such region", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    // Original has no commit header; current gains one. The baseline lacks the
    // message region the cursor is in, so the revert declines.
    const original = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -1,2 +1,2 @@",
      " const x = 1;",
      "-const y = 0;",
      "+const y = 2;",
      " const z = 3;",
      "",
    ].join("\n");
    const { src } = sourceFor(original, ws);
    assertEquals(src.revert!(original, SHOW_DIFF, 4, "message"), null);
  } finally {
    done();
  }
});

//
// expandRoom and the join helpers
//

Deno.test("diffedit cov: expandRoom is empty when the text no longer parses", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // A non-diff has no hunks to report room for.
    assertEquals(src.expandRoom!("not a diff\n").size, 0);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandRoom skips a hunk whose file has no new side", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // A deleted file's new path is /dev/null, i.e. absent, so its hunk backs no
    // workspace file and offers no room — hunkFooting returns null for it.
    const del = `diff --git a/m.ts b/m.ts
deleted file mode 100644
--- a/m.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-alpha
-beta
`;
    assertEquals(src.expandRoom!(del).size, 0);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext declines when the save map lacks the cursor's hunk", () => {
  const { ws, done } = tempWs({ "m.ts": "a\nb\nc\nd\ne\nf\ng\nh\n" });
  try {
    // The source is built from a one-hunk diff, so its save map has one entry.
    // A later `current` grows a second hunk; a cursor in it resolves to global
    // index 1, which the save map does not have — hunkFooting finds no range.
    const oneHunk = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
`;
    const { src } = sourceFor(oneHunk, ws);
    const current = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
@@ -6,3 +6,3 @@
 f
-y
+g
 h
`;
    const cursor = current.split("\n").indexOf(" f");
    assertEquals(src.expandContext!(current, current, cursor), null);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: dropHeaderBetween declines a non-diff and a lone hunk", () => {
  // A non-diff has no hunks to join.
  assertEquals(_de.dropHeaderBetween("not a diff", 0), null);
  // A single hunk has no second one to take the header off.
  const oneHunk = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-a
+A
`;
  assertEquals(_de.dropHeaderBetween(oneHunk, 0), null);
});

Deno.test("diffedit cov: joinAdjacent declines when the text will not drop a header", () => {
  // The save map claims two adjacent, verified, same-file hunks, but the text
  // holds only one, so dropHeaderBetween finds no pair and the join backs out.
  const oneHunk = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-a
+A
`;
  const hunks = [
    { absPath: "/x", newStart: 1, newCount: 1, verified: true },
    { absPath: "/x", newStart: 2, newCount: 1, verified: true },
  ];
  assertEquals(_de.joinAdjacent(oneHunk, oneHunk, hunks, 0), null);
});

Deno.test("diffedit cov: joinAdjacent keeps hunks from different commits separate", () => {
  const twoHunks = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-a
+A
@@ -2,1 +2,1 @@
-b
+B
`;
  const hunks = [
    {
      absPath: "/x",
      newStart: 1,
      newCount: 1,
      verified: true,
      writable: true,
      commitSha: "1111",
    },
    {
      absPath: "/x",
      newStart: 2,
      newCount: 1,
      verified: true,
      writable: true,
      commitSha: "2222",
    },
  ];

  assertEquals(_de.joinAdjacent(twoHunks, twoHunks, hunks, 0), null);
  assertEquals(hunks.length, 2);
});
