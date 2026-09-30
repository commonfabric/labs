/**
 * Editing a diff: the new side of a verified hunk is editable in place, the
 * diff marker and removed-line text are protected, removed lines can be
 * resurrected, and saving splices the edited lines back into the underlying
 * files. A diff matching no file on disk is read-only.
 */

import { assert, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { stripAnsi } from "../lib/view/ansi.ts";
import { type GitRunner, realGit } from "../lib/view/commitmsg.ts";
import { parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
  type WorkspaceCache,
} from "../lib/view/diffdoc.ts";
import { createDiffHighlighter, diffSource } from "../lib/view/diffedit.ts";
import { renderFrame } from "../lib/view/render.ts";
import { Session } from "../lib/view/session.ts";
import { promptText } from "./view-helpers.ts";

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

function type(s: Session, text: string): void {
  for (const ch of text) s.handleKey({ name: ch, char: ch });
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

/** Enter edit mode if needed and move the cursor to the given diff line. */
function toLine(s: Session, line: number): void {
  if (!s.view().cursor) press(s, "e"); // enter edit mode at the top
  let guard = 0;
  while ((s.view().cursor?.line ?? -1) < line && guard++ < 1000) {
    press(s, "down");
  }
  while ((s.view().cursor?.line ?? -1) > line && guard++ < 1000) {
    press(s, "up");
  }
}

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
// Diff line indices: 5,6,7 = context (new lines 0,1,2); 8 = removed;
// 9,10 = additions (new lines 3,4).

function tempWorkspace(): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
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

function diffSession(ws: DiffWorkspace, height = 20): Session {
  return diffSessionFrom(ws, DIFF, height);
}

function diffSessionFrom(
  ws: DiffWorkspace,
  diffText: string,
  height = 20,
  git?: GitRunner,
): Session {
  const model = parseDiff(diffText)!;
  const { doc, edit } = buildDiffDocument(diffText, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit, undefined, git),
  );
}

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

function sessionFor(
  diff: string,
  ws: DiffWorkspace,
  git?: GitRunner,
): Session {
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 40 },
    undefined,
    diffSource(ws, edit, undefined, git),
  );
}

const SHOW_SHA = "0123456789abcdef0123456789abcdef01234567";

// `git show` output: a commit header and message precede the diff. The message
// lines are indented four spaces (git indents blank message lines to four
// spaces too), so they read like context lines, but they belong to no hunk.
const GIT_SHOW = [
  `commit ${SHOW_SHA}`,
  "Author: A B <a@b.example>",
  "Date:   Wed Jul 1 12:00:00 2026 -0700",
  "",
  "    Subject line of the commit",
  "    ",
  "    A body paragraph of the message.",
  "",
  "diff --git a/m.ts b/m.ts",
  "index 0000000..1111111 100644",
  "--- a/m.ts",
  "+++ b/m.ts",
  "@@ -1,4 +1,5 @@ export function double",
  " export function double(n: number): number {",
  "     return n * 2;",
  " }",
  "-export const answer = 42;",
  "+export const answer = double(21);",
  "+const extra = answer + 1;",
  "",
].join("\n");
// Line indices: 4 = subject, 5 = blank message line, 6 = body; 13 = a hunk
// context line (editable); 16 = removed; 17,18 = additions.

/**
 * A fake git runner recording the replacement message, or null when
 * preserved.
 */
function fakeGit(head: string | null): {
  git: GitRunner;
  amended: () => string | null;
  amendedPaths: () => readonly string[] | null;
} {
  let amended: string | null = null;
  let amendedPaths: readonly string[] | null = null;
  return {
    git: {
      headSha: () => head,
      fileAtCommit: (_commit, path) => Deno.readTextFileSync(path),
      applyFileChanges: (_committed, _before, after) => after,
      amendCommit: (m, files, expectedHead) => {
        amended = m;
        amendedPaths = [...files.keys()];
        return { status: "Amended the commit", head: expectedHead };
      },
    },
    amended: () => amended,
    amendedPaths: () => amendedPaths,
  };
}

/** A fake git whose HEAD "moves": the first `headSha()` (the source caches it
 * for editability) returns `first`; the fresh re-check at amend returns
 * `later`. */
function movingGit(first: string, later: string): {
  git: GitRunner;
  amended: () => string | null;
  amendedPaths: () => readonly string[] | null;
} {
  let calls = 0;
  let amended: string | null = null;
  let amendedPaths: readonly string[] | null = null;
  return {
    git: {
      headSha: () => (++calls === 1 ? first : later),
      fileAtCommit: (_commit, path) => Deno.readTextFileSync(path),
      applyFileChanges: (_committed, _before, after) => after,
      amendCommit: (m, files, expectedHead) => {
        amended = m;
        amendedPaths = [...files.keys()];
        return { status: "Amended the commit", head: expectedHead };
      },
    },
    amended: () => amended,
    amendedPaths: () => amendedPaths,
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

describe("diffedit", () => {
  it("edits an added line in place and saves it to the file", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9); // the "+export const answer = double(21);" line
      press(s, "end");
      type(s, " // ok");
      // Live re-highlight: the document reflects the edit immediately.
      assert(
        s.doc.lines[9].text.endsWith("double(21); // ok"),
        `live text: ${s.doc.lines[9].text}`,
      );
      press(s, "f3");
      assert(s.view().message.startsWith("Saved"), s.view().message);
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[3]).toBe("export const answer = double(21); // ok");
      // Untouched lines are preserved, including the trailing newline.
      expect(onDisk[0]).toBe("export function double(n: number): number {");
      expect(onDisk[4]).toBe("const extra = answer + 1;");
      expect(onDisk[5]).toBe("");
    } finally {
      done();
    }
  });

  it("accepts an edit on a context line and writes it to the file line", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 6); // the "     return n * 2;" context line (new line 1)
      press(s, "end");
      type(s, " // c");
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[1]).toBe("    return n * 2; // c");
    } finally {
      done();
    }
  });

  it("recolors only the edited line on an incremental update", () => {
    const { ws, done } = tempWorkspace();
    try {
      const model = parseDiff(DIFF)!;
      const { doc } = buildDiffDocument(DIFF, model, ws);
      const hl = createDiffHighlighter(DIFF, doc.lines);
      // Edit the first context line's content (diff line 5), past its marker.
      const raw = DIFF.split("\n");
      raw[5] = raw[5].slice(0, 1) + "X" + raw[5].slice(1);
      const out = hl.update(raw.join("\n"));
      expect(out[5].text, "edited line reflects the new text").toBe(raw[5]);
      // Every other line — the file/hunk headers especially — is byte-identical
      // to the seed, so nothing reflows or flickers color between keystrokes.
      for (let i = 0; i < doc.lines.length; i++) {
        if (i === 5) continue;
        expect(JSON.stringify(out[i]), `line ${i} should be untouched`).toBe(
          JSON.stringify(doc.lines[i]),
        );
      }
    } finally {
      done();
    }
  });

  it("colors a newly removed line from the complete old file", () => {
    const newText = `/*
first
second
third
fourth
sixth
*/
export const shown = 2;
`;
    const diff = `diff --git a/comment.ts b/comment.ts
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
    const root = Deno.makeTempDirSync();
    try {
      const path = join(root, "comment.ts");
      Deno.writeTextFileSync(path, newText);
      const ws: DiffWorkspace = {
        resolve: () => path,
        read: () => newText,
      };
      const model = parseDiff(diff)!;
      const cache: WorkspaceCache = new Map();
      const { doc, edit } = buildDiffDocument(diff, model, ws, cache);
      const source = diffSource(ws, edit, cache);
      const highlighter = source.createHighlighter!(diff, doc.lines);
      const edited = diff.split("\n");
      const context = edited.indexOf(" third");
      edited.splice(context, 1, "-third", "+third changed");
      const lines = highlighter.update(edited.join("\n"));
      const removed = edited.indexOf("-third");
      expect(
        lines[removed].spans.find((span) => span.text === "third")?.cls,
        "the block comment opener outside the hunk controls the live removed line",
      ).toBe("comment");
      const reparsed = source.parse(edited.join("\n"));
      expect(
        reparsed.lines[removed].spans.find((span) => span.text === "third")
          ?.cls,
        "the deferred parse keeps the complete old file",
      ).toBe("comment");
      const originalRemoval = edited.indexOf("-const hidden = 1;");
      expect(
        reparsed.lines[originalRemoval].spans.find((span) =>
          span.text.includes("hidden")
        )?.cls,
        "the deferred parse keeps original removed lines in context",
      ).toBe("comment");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps complete-file colors after an edit in a stateful language", () => {
    const root = Deno.makeTempDirSync();
    try {
      const cases = [
        {
          path: "notes.md",
          file: ["```python", "before", "```", ""].join("\n"),
          cls: "string",
        },
        {
          path: "config.jsonc",
          file: ["/* opening", "before", "*/", ""].join("\n"),
          cls: "comment",
        },
        {
          path: "template.ts",
          file: ["const value = `", "before", "`;", ""].join("\n"),
          cls: "template",
        },
      ] as const;
      const ws: DiffWorkspace = {
        resolve: (path) => join(root, path),
        read: (path) => {
          try {
            return Deno.readTextFileSync(path);
          } catch {
            return null;
          }
        },
      };

      for (const testCase of cases) {
        Deno.writeTextFileSync(join(root, testCase.path), testCase.file);
        const diff = [
          `diff --git a/${testCase.path} b/${testCase.path}`,
          `--- a/${testCase.path}`,
          `+++ b/${testCase.path}`,
          "@@ -2 +2 @@",
          "-old",
          "+before",
          "",
        ].join("\n");
        const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const source = diffSource(ws, built.edit);
        const highlighter = source.createHighlighter!(diff, built.doc.lines);
        const editedText = diff.replace("+before", "+after");
        const edited = highlighter.update(editedText);
        const editedLine = edited[editedText.split("\n").indexOf("+after")];
        expect(
          editedLine.spans.find((span) => span.text === "after")?.cls,
          `${testCase.path} live color`,
        ).toBe(testCase.cls);

        const editedAgainText = editedText.replace("+after", "+again");
        const editedAgain = highlighter.update(editedAgainText);
        const editedAgainLine = editedAgain[
          editedAgainText.split("\n").indexOf("+again")
        ];
        expect(
          editedAgainLine.spans.find((span) => span.text === "again")?.cls,
          `${testCase.path} repeated live color`,
        ).toBe(testCase.cls);

        const reparsed = source.parse(editedAgainText);
        const parsedLine = reparsed.lines[
          editedAgainText.split("\n").indexOf("+again")
        ];
        expect(
          parsedLine.spans.find((span) => span.text === "again")?.cls,
          `${testCase.path} deferred color`,
        ).toBe(testCase.cls);
      }
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("leaves the surrounding template state intact after a local string edit", () => {
    const root = Deno.makeTempDirSync();
    try {
      const file = [
        "const value = `head ${",
        '  "AAHED"',
        "} tail`;",
        "",
      ].join("\n");
      const path = join(root, "template.ts");
      Deno.writeTextFileSync(path, file);
      const diff = [
        "diff --git a/template.ts b/template.ts",
        "--- a/template.ts",
        "+++ b/template.ts",
        "@@ -2,2 +2,2 @@",
        '-  "AAHE"',
        '+  "AAHED"',
        " } tail`;",
        "",
      ].join("\n");
      const ws: DiffWorkspace = {
        resolve: () => path,
        read: () => file,
      };
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const highlighter = diffSource(ws, built.edit).createHighlighter!(
        diff,
        built.doc.lines,
      );
      const editedText = diff.replace('"AAHED"', '"AAHEDS"');
      const edited = highlighter.update(editedText);
      const raw = editedText.split("\n");
      const stringLine = edited[raw.indexOf('+  "AAHEDS"')];
      expect(stringLine.spans.find((span) => span.text === '"AAHEDS"')?.cls)
        .toBe("string");
      const tailLine = edited[raw.indexOf(" } tail`;")];
      expect(tailLine.spans.find((span) => span.text.includes(" tail`"))?.cls)
        .toBe("template");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps same-line contextual colors after a local string edit", () => {
    const root = Deno.makeTempDirSync();
    try {
      const file = [
        "const obj = {",
        '  label: "AAHED",',
        "};",
        "",
      ].join("\n");
      const path = join(root, "object.ts");
      Deno.writeTextFileSync(path, file);
      const diff = [
        "diff --git a/object.ts b/object.ts",
        "--- a/object.ts",
        "+++ b/object.ts",
        "@@ -2 +2 @@",
        '-  label: "AAHE",',
        '+  label: "AAHED",',
        "",
      ].join("\n");
      const ws: DiffWorkspace = {
        resolve: () => path,
        read: () => file,
      };
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const highlighter = diffSource(ws, built.edit).createHighlighter!(
        diff,
        built.doc.lines,
      );
      const editedText = diff.replace('"AAHED"', '"AAHEDS"');
      const highlighted = highlighter.update(editedText);
      const line = highlighted[
        editedText.split("\n").indexOf('+  label: "AAHEDS",')
      ];
      expect(line.spans.find((span) => span.text === "label")?.cls).toBe(
        "propertyName",
      );
      expect(line.spans.find((span) => span.text === '"AAHEDS"')?.cls).toBe(
        "string",
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("recolors later hunks after an edit beside a string escape", () => {
    const root = Deno.makeTempDirSync();
    try {
      const first = 'const v = "a\\"b"; // \\';
      const editedFirst = 'const v = "a\\x"b"; // \\';
      const file = `${first}\nNEXT token\n`;
      const path = join(root, "state.ts");
      Deno.writeTextFileSync(path, file);
      const diff = [
        "diff --git a/state.ts b/state.ts",
        "--- a/state.ts",
        "+++ b/state.ts",
        "@@ -1 +1 @@",
        "-old first",
        `+${first}`,
        "@@ -2 +2 @@",
        "-old next",
        "+NEXT token",
        "",
      ].join("\n");
      const ws: DiffWorkspace = {
        resolve: () => path,
        read: () => file,
      };
      const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
      const highlighter = diffSource(ws, built.edit).createHighlighter!(
        diff,
        built.doc.lines,
      );
      const editedText = diff.replace(`+${first}`, `+${editedFirst}`);
      const highlighted = highlighter.update(editedText);
      const nextLine =
        highlighted[editedText.split("\n").indexOf("+NEXT token")];
      expect(nextLine.spans.find((span) => span.text === "NEXT token")?.cls)
        .toBe("string");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("shows an edited context line as a removed/added pair", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 6); // the "     return n * 2;" context line
      press(s, "end");
      type(s, "X");
      const lines = s.doc.text.split("\n");
      expect(lines[6], "original shown as removed").toBe("-    return n * 2;");
      expect(lines[7], "the edit shown as added").toBe("+    return n * 2;X");
      expect(s.view().cursor?.line, "cursor on the added line").toBe(7);
      // A context line and a -/+ pair are both one old + one new line, so the
      // hunk header's counts are unchanged and the diff stays well-formed.
      expect(lines[4]).toBe("@@ -1,4 +1,5 @@ export function double");
      press(s, "f3"); // and saving writes the edited new side
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[1]).toBe("    return n * 2;X");
    } finally {
      done();
    }
  });

  it("collapses the pair back to a context line when its edit is undone", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      const before = s.doc.text;
      toLine(s, 6);
      press(s, "end");
      type(s, "X");
      expect(s.doc.text.split("\n").length, "the edit added the removed line")
        .toBe(before.split("\n").length + 1);
      press(s, "backspace"); // remove X: the added line matches the removed one
      expect(s.doc.text, "the diff is back to its original form").toBe(before);
    } finally {
      done();
    }
  });

  it("inserts a blank added line above a context line on Enter at its start", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      // The "     return n * 2;" context line, with the cursor at line start.
      toLine(s, 6);
      const contextLine = s.doc.text.split("\n")[6];
      s.handleKey({ name: "enter" });
      const lines = s.doc.text.split("\n");
      // Splitting at the start leaves an empty head, so a blank added line goes
      // above and the original stays an unchanged context line below it — the
      // line's text is never dragged onto the new added line.
      expect(lines[6], "a blank added line is inserted above").toBe("+");
      expect(lines[7], "the context line is unchanged, below").toBe(
        contextLine,
      );
      // The cursor keeps its relative position — still at the start of the
      // original line, which the inserted newline pushed down by one.
      expect(s.view().cursor, "cursor follows the content onto the line below")
        .toEqual({ line: 7, col: 1 });
      // The hunk header's new-side count grew by the one inserted line.
      expect(lines[4]).toBe("@@ -1,4 +1,6 @@ export function double");
      // Saving writes the blank inserted line before the original.
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[0]).toBe("export function double(n: number): number {");
      expect(onDisk[1], "a blank line is inserted").toBe("");
      expect(onDisk[2], "the original line follows it").toBe(
        "    return n * 2;",
      );
    } finally {
      done();
    }
  });

  it("splits a context line into a removed/added pair on Enter in its middle", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 6); // the "     return n * 2;" context line
      const orig = s.doc.text.split("\n")[6].slice(1); // content, past the marker
      // Put the cursor in the middle of the content (a few chars before the
      // end).
      press(s, "end", "left", "left", "left");
      s.handleKey({ name: "enter" });
      const lines = s.doc.text.split("\n");
      // The pre-existing line changes, so it becomes a removed line plus the
      // two halves as added lines — not a context line silently emptied.
      expect(lines[6], "the original becomes a removed line").toBe(`-${orig}`);
      const head = lines[7].slice(1);
      const tail = lines[8].slice(1);
      expect(lines[7][0], "the head is an added line").toBe("+");
      expect(lines[8][0], "the tail is an added line").toBe("+");
      assert(head.length > 0 && tail.length > 0, "both halves are non-empty");
      expect(head + tail, "the halves rejoin to the original content").toBe(
        orig,
      );
      expect(s.view().cursor?.line, "cursor on the tail line").toBe(8);
      // The new side gained one line; the old side is unchanged.
      expect(lines[4]).toBe("@@ -1,4 +1,6 @@ export function double");
      // Saving writes the two halves in place of the original file line.
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[1], "the head replaces the original line").toBe(head);
      expect(onDisk[2], "the tail follows on its own line").toBe(tail);
      expect(onDisk[3], "the rest of the file is preserved").toBe("}");
    } finally {
      done();
    }
  });

  it("refuses a deletion of the diff marker column", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9);
      press(s, "right"); // step onto the marker boundary (col 1)
      const before = s.doc.text;
      press(s, "backspace");
      expect(s.view().message.toLowerCase()).toContain("marker");
      expect(s.doc.text, "the marker was not deleted").toBe(before);
    } finally {
      done();
    }
  });

  it("refuses an edit on a removed line", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 8); // the "-export const answer = 42;" line
      const before = s.doc.text;
      type(s, "X");
      expect(s.view().message).toContain("isn't editable");
      expect(s.view().message).toContain("R");
      expect(s.doc.text).toBe(before);
    } finally {
      done();
    }
  });

  it("resurrects a removed line on `R` and saves it back to the file", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      for (const key of ["r", "R"]) {
        const s = diffSession(ws);
        toLine(s, 8); // the "-export const answer = 42;" line
        assert(
          s.view().editHint?.some((hint) =>
            hint.key === "R" && hint.label === "Resurrect"
          ),
          "the edit status advertises resurrection on a removed line",
        );
        press(s, key);
        const lines = s.doc.text.split("\n");
        expect(
          lines[8],
          `${key} carried the removed line onto the new side as context`,
        ).toBe(" export const answer = 42;");
        expect(lines[4], "the new-side hunk count grew by one").toBe(
          "@@ -1,4 +1,6 @@ export function double",
        );
        expect(s.view().cursor, "the cursor moved past the protected marker")
          .toEqual({ line: 8, col: 1 });
        expect(s.view().message).toContain("Resurrected");
        assert(
          !s.view().editHint?.some((hint) => hint.key === "R"),
          "the context line no longer offers resurrection",
        );

        if (key === "R") {
          press(s, "f3");
          assert(s.view().message.startsWith("Saved"), s.view().message);
        }
      }

      expect(
        Deno.readTextFileSync(join(root, "m.ts")),
        "saving writes the resurrected line before the existing additions",
      ).toBe(`export function double(n: number): number {
    return n * 2;
}
export const answer = 42;
export const answer = double(21);
const extra = answer + 1;
`);
    } finally {
      done();
    }
  });

  it("types `R` as a character on an editable diff line", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9); // the "+export const answer = double(21);" line
      press(s, "end");
      type(s, "R");
      assert(
        s.doc.lines[9].text.endsWith("double(21);R"),
        s.doc.lines[9].text,
      );
    } finally {
      done();
    }
  });

  it("resurrects one of several consecutive removed lines", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(join(root, "m.ts"), "alpha\ndelta\n");
      const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,2 @@
 alpha
-beta
-gamma
 delta
`;
      const s = sessionFor(diff, stubWs(root));
      toLine(s, 6); // the "-gamma" line
      press(s, "R");
      const lines = s.doc.text.split("\n");
      expect(lines[5], "the preceding deletion remains").toBe("-beta");
      expect(lines[6], "the chosen line becomes context").toBe(" gamma");
      expect(lines[3], "the new count grows once").toBe("@@ -1,4 +1,3 @@");
      press(s, "f3");
      expect(
        Deno.readTextFileSync(join(root, "m.ts")),
        "the chosen line returns at its original position",
      ).toBe("alpha\ngamma\ndelta\n");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("refuses an edit on a header line", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 4); // the @@ hunk header
      const before = s.doc.text;
      type(s, "X");
      expect(s.view().message).toContain("isn't editable");
      expect(s.doc.text).toBe(before);
    } finally {
      done();
    }
  });

  it("adds a line on Enter and writes it into the file on save", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9); // "+export const answer = double(21);" (new line 3)
      press(s, "end");
      press(s, "enter"); // a new added line, marked "+"
      type(s, "const inserted = 7;");
      // The new diff line carries the added marker.
      assert(s.doc.lines[10].text.startsWith("+const inserted = 7;"));
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[3]).toBe("export const answer = double(21);");
      expect(onDisk[4]).toBe("const inserted = 7;");
      expect(onDisk[5]).toBe("const extra = answer + 1;");
      expect(onDisk[6]).toBe(""); // trailing newline preserved, not doubled
      expect(onDisk.length).toBe(7);
    } finally {
      done();
    }
  });

  it("removes a line on Backspace at its start and drops it from the file on save", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 10); // "+const extra = answer + 1;" (new line 4)
      press(s, "end");
      // Clear the content (19 chars), then one more Backspace removes the line.
      for (let i = 0; i < "const extra = answer + 1;".length + 1; i++) {
        press(s, "backspace");
      }
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[3]).toBe("export const answer = double(21);");
      expect(onDisk[4]).toBe(""); // the last content line was removed
      expect(onDisk.length).toBe(5);
    } finally {
      done();
    }
  });

  it("refuses a forward delete that would join lines", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9);
      press(s, "end"); // end of the line
      const before = s.doc.text;
      press(s, "delete");
      expect(s.view().message).toContain("Backspace");
      expect(s.doc.text, "no join happened").toBe(before);
    } finally {
      done();
    }
  });

  it("leaves a diff matching no file on disk read-only", () => {
    const noWs: DiffWorkspace = { resolve: () => null, read: () => null };
    const s = diffSession(noWs);
    press(s, "e");
    expect(s.view().cursor, "no cursor on an unmatched diff").toBeNull();
    expect(s.view().message).toContain("match");
  });

  it("prompts on quitting a dirty diff and saves the file on `s`", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9);
      press(s, "end");
      type(s, "!");
      press(s, "escape", "q"); // hide cursor, quit from pager mode
      expect(promptText(s.view()), "prompts").toContain("Save changes");
      press(s, "s");
      assert(s.quit);
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[3]).toBe("export const answer = double(21);!");
    } finally {
      done();
    }
  });

  const TWO_FILE_DIFF = `diff --git a/x.ts b/x.ts
index 0000000..1111111 100644
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
diff --git a/z.ts b/z.ts
index 0000000..1111111 100644
--- a/z.ts
+++ b/z.ts
@@ -1,2 +1,2 @@
 const z = 1;
-const w = 2;
+const w = 3;
`;

  it("writes and reports only the files whose contents changed on save", () => {
    const root = Deno.makeTempDirSync();
    try {
      const xPath = join(root, "x.ts");
      const zPath = join(root, "z.ts");
      Deno.writeTextFileSync(xPath, "const x = 1;\nconst y = 3;\n");
      Deno.writeTextFileSync(zPath, "const z = 1;\nconst w = 3;\n");
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      Deno.utimeSync(zPath, oldTime, oldTime);
      const zMtime = Deno.statSync(zPath).mtime?.getTime();
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
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const src = diffSource(ws, edit);
      // Edit only x.ts's added line.
      const edited = TWO_FILE_DIFF.replace("+const y = 3;", "+const y = 30;");
      expect(src.dirtyLabels!(TWO_FILE_DIFF, edited)).toEqual(["x.ts"]);
      expect(src.dirtyLabels!(TWO_FILE_DIFF, TWO_FILE_DIFF)).toEqual([]);
      expect(saveSource(src, edited)).toBe("Saved 1 file");
      expect(Deno.readTextFileSync(xPath)).toBe(
        "const x = 1;\nconst y = 30;\n",
      );
      expect(Deno.readTextFileSync(zPath)).toBe("const z = 1;\nconst w = 3;\n");
      expect(
        Deno.statSync(zPath).mtime?.getTime(),
        "the untouched file was not opened for writing",
      ).toBe(zMtime);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("reports exact zero- and two-file counts on save", () => {
    const { ws, done } = twoFileWs();
    try {
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const src = diffSource(ws, edit);
      expect(saveSource(src, TWO_FILE_DIFF)).toBe("Saved 0 files");
      const edited = TWO_FILE_DIFF
        .replace("+const y = 3;", "+const y = 30;")
        .replace("+const w = 3;", "+const w = 30;");
      expect(saveSource(src, edited)).toBe("Saved 2 files");
    } finally {
      done();
    }
  });

  it("reports zero files saved when the edited contents are already on disk", () => {
    const { ws, done } = twoFileWs();
    try {
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const src = diffSource(ws, edit);
      const edited = TWO_FILE_DIFF.replace(
        "+const y = 3;",
        "+const y = 30;",
      );
      const xPath = [...edit.fileText.keys()].find((path) =>
        path.endsWith("x.ts")
      )!;
      Deno.writeTextFileSync(xPath, "const x = 1;\nconst y = 30;\n");
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      Deno.utimeSync(xPath, oldTime, oldTime);
      const mtime = Deno.statSync(xPath).mtime?.getTime();

      expect(saveSource(src, edited, TWO_FILE_DIFF)).toBe("Saved 0 files");
      expect(
        Deno.statSync(xPath).mtime?.getTime(),
        "a file already holding the saved contents was not rewritten",
      ).toBe(mtime);
    } finally {
      done();
    }
  });

  it("restores the contents captured at open on a later save", () => {
    const { ws, done } = twoFileWs();
    try {
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const src = diffSource(ws, edit);
      const first = TWO_FILE_DIFF.replace(
        "+const y = 3;",
        "+const y = 30;",
      );
      expect(saveSource(src, first, TWO_FILE_DIFF)).toBe("Saved 1 file");
      expect(saveSource(src, TWO_FILE_DIFF, first)).toBe("Saved 1 file");
      expect(ws.read([...edit.fileText.keys()][0])).toBe(
        "const x = 1;\nconst y = 3;\n",
      );
    } finally {
      done();
    }
  });

  it("uses the hunk size produced by an insertion on a later save", () => {
    const { root, ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9); // the added answer line
      press(s, "end", "enter");
      type(s, "// inserted");
      press(s, "f3");

      press(s, "up", "end");
      type(s, " // second save");
      press(s, "f3");

      expect(
        Deno.readTextFileSync(join(root, "m.ts")),
        "the second save does not duplicate the hunk's final line",
      ).toBe(FILE_TEXT.replace(
        "export const answer = double(21);\n",
        "export const answer = double(21); // second save\n// inserted\n",
      ));
    } finally {
      done();
    }
  });

  it("refuses to overwrite a file changed after opening", () => {
    const { ws, done } = twoFileWs();
    try {
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const src = diffSource(ws, edit);
      const edited = TWO_FILE_DIFF.replace(
        "+const y = 3;",
        "+const y = 30;",
      );
      const xPath = [...edit.fileText.keys()].find((path) =>
        path.endsWith("x.ts")
      )!;
      const external = "const x = 1;\nconst y = 300; // external\n";
      Deno.writeTextFileSync(xPath, external);

      expect(() => saveSource(src, edited, TWO_FILE_DIFF)).toThrow(
        "changed after this view opened",
      );
      expect(
        Deno.readTextFileSync(xPath),
        "the external edit remains untouched",
      ).toBe(external);
    } finally {
      done();
    }
  });

  it("lists the edited files above the prompt when quitting a multi-file diff", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(
        join(root, "x.ts"),
        "const x = 1;\nconst y = 3;\n",
      );
      Deno.writeTextFileSync(
        join(root, "z.ts"),
        "const z = 1;\nconst w = 3;\n",
      );
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
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { doc, edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 20 },
        undefined,
        diffSource(ws, edit),
      );
      toLine(s, 7); // x.ts added line
      press(s, "end");
      type(s, "0");
      toLine(s, 13); // z.ts context line
      press(s, "end");
      type(s, "0");
      press(s, "escape", "q");
      const prompt = promptText(s.view());
      expect(prompt, `prompt: ${prompt}`).toContain("2 files");
      // The dialog body lists the files a save would write.
      expect(prompt).toContain("x.ts");
      expect(prompt).toContain("z.ts");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  function twoFileWs(): { ws: DiffWorkspace; done: () => void } {
    const root = Deno.makeTempDirSync();
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
    Deno.writeTextFileSync(join(root, "z.ts"), "const z = 1;\nconst w = 3;\n");
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
    return { ws, done: () => Deno.removeSync(root, { recursive: true }) };
  }

  it("reverts a single hunk, or everything", () => {
    const { ws, done } = twoFileWs();
    try {
      const model = parseDiff(TWO_FILE_DIFF)!;
      const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
      const src = diffSource(ws, edit);
      const edited = TWO_FILE_DIFF
        .replace("+const y = 3;", "+const y = 3;A")
        .replace("+const w = 3;", "+const w = 3;B");
      // Cursor on line 7 sits in x.ts's hunk; reverting the chunk leaves z.ts.
      const chunk = src.revert!(TWO_FILE_DIFF, edited, 7, "chunk")!;
      expect(chunk.text, "x.ts hunk reverted").not.toContain("const y = 3;A");
      expect(chunk.text, "z.ts edit preserved").toContain("const w = 3;B");
      // Reverting all restores the original diff exactly.
      const all = src.revert!(TWO_FILE_DIFF, edited, 7, "all")!;
      expect(all.text).toBe(TWO_FILE_DIFF);
      // Nothing to revert when unchanged.
      expect(src.revert!(TWO_FILE_DIFF, TWO_FILE_DIFF, 7, "all")).toBeNull();
    } finally {
      done();
    }
  });

  it("reverts all edits on Ctrl-R then `a`", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      const before = s.doc.text;
      toLine(s, 6);
      press(s, "end");
      type(s, "X");
      expect(s.doc.text, "edited").not.toBe(before);
      s.handleKey({ name: "ctrl-r" });
      expect(promptText(s.view()), "the revert prompt shows").toContain(
        "Revert",
      );
      press(s, "a");
      expect(s.doc.text, "all edits reverted").toBe(before);
      expect(s.view().message).toContain("Reverted");
    } finally {
      done();
    }
  });

  const EXPAND_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";
  const EXPAND_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;

  function expandSession(): { root: string; s: Session; done: () => void } {
    const root = Deno.makeTempDirSync();
    Deno.writeTextFileSync(join(root, "m.ts"), EXPAND_FILE);
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
    const model = parseDiff(EXPAND_DIFF)!;
    const cache = new Map();
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws, cache);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit, cache),
    );
    return { root, s, done: () => Deno.removeSync(root, { recursive: true }) };
  }

  it("reveals more of the file below the hunk on Ctrl-L", () => {
    const { s, done } = expandSession();
    try {
      toLine(s, 8); // epsilon, the bottom of the hunk
      s.handleKey({ name: "ctrl-l" });
      const lines = s.doc.text.split("\n");
      expect(lines[4], "the header counts grew").toBe("@@ -3,6 +3,6 @@");
      expect(s.doc.text).toContain("\n zeta\n eta\n theta");
      // Revealing context is not an edit: a clean quit needs no save prompt.
      press(s, "escape", "q");
      assert(s.quit, "quit without a save prompt");
    } finally {
      done();
    }
  });

  it("reveals more of the file above the hunk on Ctrl-L", () => {
    const { s, done } = expandSession();
    try {
      toLine(s, 5); // gamma, the top of the hunk
      s.handleKey({ name: "ctrl-l" });
      const lines = s.doc.text.split("\n");
      expect(lines[4], "header start and counts grew").toBe("@@ -1,5 +1,5 @@");
      expect(lines[5]).toBe(" alpha");
      expect(lines[6]).toBe(" beta");
    } finally {
      done();
    }
  });

  it("expands context on Ctrl-L in pager mode, with no text cursor", () => {
    const { s, done } = expandSession();
    try {
      // A twelve-row content area puts its quarter-screen target above the
      // hunk.
      s.resize(80, 13);
      // No arrow press, so the text cursor is never revealed: we are in the
      // pager.
      const view = s.view();
      expect(view.cursor, "no text cursor").toBeNull();
      assert(view.canExpand, "the status line advertises expand");
      expect(view.expandRow, "the first hunk body line is marked").toBe(5);
      expect(view.diffMetadataRows, "only the adjacent header is marked")
        .toEqual([4]);
      expect(view.diffAnnotations).toEqual([
        { line: 5, kind: "expandUp" },
        { line: 4, kind: "diffMetadata" },
      ]);
      const rows = renderFrame(s.displayDoc(), view).map(stripAnsi);
      assert(
        rows[0].endsWith("+1 −1"),
        "the first line carries the whole-diff totals, not a marker",
      );
      for (let row = 1; row < 4; row++) {
        expect(rows[row].at(-1), "earlier metadata is not marked").toBe(" ");
      }
      assert(
        rows[4].endsWith("^L█"),
        "the hunk header labels the available expansion",
      );
      expect(rows[5].at(-1), "the marker points upward").toBe("◥");
      s.handleKey({ name: "ctrl-l" });
      const lines = s.doc.text.split("\n");
      // The hunk on screen expanded; with nothing selected it grows upward
      // first.
      expect(lines[4]).toBe("@@ -1,5 +1,5 @@");
      expect(lines[5]).toBe(" alpha");
      expect(lines[6]).toBe(" beta");
      expect(s.view().cursor, "still no text cursor after expanding")
        .toBeNull();
      // Revealing context is not an edit: a clean quit needs no save prompt.
      press(s, "q");
      assert(s.quit, "quit without a save prompt");
    } finally {
      done();
    }
  });

  it("shows the expansion marker only in pager navigation", () => {
    const { s, done } = expandSession();
    try {
      // A twelve-row content area puts its quarter-screen target above the
      // hunk.
      s.resize(80, 13);
      expect(s.view().expandRow, "navigation marks the chosen edge").toBe(5);
      expect(s.view().diffMetadataRows).toEqual([4]);
      press(s, "/");
      expect(s.view().expandRow, "search owns the next key").toBeNull();
      expect(s.view().diffMetadataRows, "search hides its neighboring block")
        .toEqual([]);
      press(s, "escape", "?");
      expect(s.view().overlay, "help is open").not.toBeNull();
      expect(s.view().expandRow, "an overlay owns the next key").toBeNull();
      expect(s.view().diffMetadataRows, "an overlay hides the block").toEqual(
        [],
      );
      press(s, "escape");
      expect(s.view().expandRow, "leaving help restores the marker").toBe(5);
      press(s, "ctrl-x");
      expect(s.view().expandRow, "a chord owns the next key").toBeNull();
    } finally {
      done();
    }
  });

  it("keeps the expansion triangle on the body under a wrapped hunk header", () => {
    const { s, done } = expandSession();
    try {
      s.resize(9, 30);
      press(s, "\\");
      const view = s.view();
      const headerFirstRow = view.wrapPlan!.firstRow[4];
      const headerLastRow = view.wrapPlan!.lastRow[4];
      const firstBodyFirstRow = view.wrapPlan!.firstRow[5];
      expect(view.expandRow).toBe(firstBodyFirstRow);
      const rows = renderFrame(s.displayDoc(), view).map(stripAnsi);
      for (let row = headerFirstRow; row <= headerLastRow; row++) {
        const rendered = rows[row - view.top];
        expect(
          rendered.at(-1),
          "every wrapped hunk-header row is marked as metadata",
        ).toBe("█");
        expect(
          rendered.endsWith("^L█"),
          "the first wrapped row carries the line's Ctrl-L label",
        ).toBe(row === headerFirstRow);
      }
      expect(
        rows[firstBodyFirstRow - view.top].at(-1),
        "the marker sits on the first body line",
      ).toBe("◥");
      s.handleKey({ name: "ctrl-l" });
      expect(s.doc.text.split("\n")[4], "Ctrl-L expands the marked top edge")
        .toBe("@@ -1,5 +1,5 @@");
    } finally {
      done();
    }
  });

  it("marks adjacent metadata only once its triangle is visible", () => {
    const { s, done } = expandSession();
    try {
      s.resize(80, 6);
      const view = s.view();
      expect(view.top).toBe(0);
      expect(view.expandRow, "the body marker sits below the viewport").toBe(5);
      expect(view.diffMetadataRows, "the neighboring header is known").toEqual([
        4,
      ]);
      expect(view.diffAnnotations).toEqual([]);
      const rows = renderFrame(s.displayDoc(), view).map(stripAnsi);
      expect(
        rows[4].at(-1),
        "the visible header has no block without its triangle",
      ).toBe(" ");
    } finally {
      done();
    }
  });

  it("hides wrapped metadata rather than reflowing its triangle off-screen", () => {
    const { s, done } = expandSession();
    try {
      s.resize(15, 9);
      press(s, "\\");
      const first = s.view();
      const firstRows = renderFrame(s.displayDoc(), first).map(stripAnsi);
      expect(first.top).toBe(0);
      expect(first.diffAnnotations).toEqual([{ line: 5, kind: "expandUp" }]);
      assert(
        firstRows.some((row) => row.endsWith("◥")),
        "the expansion triangle remains visible",
      );
      assert(
        firstRows.every((row) => !row.includes("^L") && !row.endsWith("█")),
        "metadata is hidden when its extra wrapping would hide the triangle",
      );

      const second = s.view();
      expect(second.top).toBe(first.top);
      expect(second.diffAnnotations).toEqual(first.diffAnnotations);
      expect(renderFrame(s.displayDoc(), second).map(stripAnsi)).toEqual(
        firstRows,
      );
    } finally {
      done();
    }
  });

  it("expands the selected hunk on Ctrl-L in pager mode", () => {
    const root = Deno.makeTempDirSync();
    try {
      // Long enough to back FAR_DIFF's second hunk, which sits at line 30.
      const file = Array.from({ length: 40 }, (_, i) =>
        `line${i + 1}`).join("\n") +
        "\n";
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
      const model = parseDiff(FAR_DIFF)!;
      const { doc, edit } = buildDiffDocument(FAR_DIFF, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 40 },
        undefined,
        diffSource(ws, edit),
      );
      // Select the second hunk via the structure tree (no text cursor), then
      // expand: the choice of hunk must follow the selection, not a stale
      // buffer. The quarter-screen target reaches up from the first hunk.
      // Selecting the second hunk makes the selection govern the expansion
      // instead.
      let guard = 0;
      while ((s.view().selected?.startLine ?? -1) !== 9 && guard++ < 200) {
        s.handleKey({ name: "tab" });
      }
      expect(s.view().selected?.startLine, "the second hunk is selected").toBe(
        9,
      );
      expect(s.view().cursor, "no text cursor").toBeNull();
      s.handleKey({ name: "ctrl-l" });
      expect(
        s.doc.text,
        `the selected (second) hunk expanded up: ${s.doc.text}`,
      ).toContain("@@ -20,13 +20,13 @@");
      expect(s.doc.text, "the first hunk is untouched").toContain(
        "@@ -4,3 +4,3 @@",
      );
      // The hunk stays selected across the reparse even though its @@-count
      // label grew, so a second Ctrl-L keeps expanding the same hunk.
      expect(s.view().selected?.kind, "still a hunk selected").toBe("hunk");
      expect(s.view().selected?.startLine, "still the second hunk").toBe(9);
      assert(
        s.view().selected?.label.startsWith("@@ -20,13 +20,13"),
        `selected hunk label: ${s.view().selected?.label}`,
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps the hunk header in view when a pager Ctrl-L expands up from the top", () => {
    const { s, done } = expandSession();
    try {
      // A twelve-row content area puts its quarter-screen target above the
      // hunk.
      s.resize(80, 13);
      expect(s.view().top, "starts at the top, pager mode").toBe(0);
      s.handleKey({ name: "ctrl-l" }); // expands up (reveals alpha/beta)
      // The header and preamble sit above the insertion point, so they do not
      // move and the viewport must stay anchored on them.
      expect(s.view().top, "the hunk header stays in view").toBe(0);
      const lines = s.doc.text.split("\n");
      expect(lines[4]).toBe("@@ -1,5 +1,5 @@");
      expect(lines[5], "revealed context sits below the header").toBe(" alpha");
    } finally {
      done();
    }
  });

  it("fills a short screen from the held edge on a pager Ctrl-L", () => {
    const root = Deno.makeTempDirSync();
    try {
      const file = Array.from({ length: 40 }, (_, i) =>
        `line${i + 1}`).join("\n") +
        "\n";
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
@@ -20,3 +20,3 @@
 line20
-OLD21
+line21
 line22
`;
      const model = parseDiff(diff)!;
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 6 },
        undefined,
        diffSource(ws, edit),
      );
      // Scroll down so the hunk body is at the top and the header is off
      // screen.
      for (let i = 0; i < 6; i++) s.handleKey({ name: "j" });
      const view = s.view();
      expect(view.expandRow, "the last hunk body line is marked").toBe(7);
      expect(s.displayDoc().lines[view.expandRow!].text).toBe(" line22");
      expect(
        renderFrame(s.displayDoc(), view).map(
          stripAnsi,
        )[view.expandRow! - view.top]
          .at(-1),
        "the marker points down from the last body line",
      ).toBe("◢");
      s.handleKey({ name: "ctrl-l" });
      // The quarter-screen target is in the hunk's lower half, so the lines
      // come from below it and what follows the hunk is held still. Ten lines
      // land on a five-row screen, so they fill it from that held edge: the
      // last of them is on screen and the hunk has been pushed off the top.
      assert(s.view().message.startsWith("Showing line"), s.view().message);
      const rows = s.doc.text.split("\n").slice(s.view().top, s.view().top + 5);
      expect(rows, rows.join("|")).toContain(" line32");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("uses the quarter-screen expansion target for a whole-file selection", () => {
    const root = Deno.makeTempDirSync();
    try {
      // Long enough to back FAR_DIFF's second hunk, which sits at line 30.
      const file = Array.from({ length: 40 }, (_, i) =>
        `line${i + 1}`).join("\n") +
        "\n";
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
      const model = parseDiff(FAR_DIFF)!;
      const { doc, edit } = buildDiffDocument(FAR_DIFF, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 40 },
        undefined,
        diffSource(ws, edit),
      );
      // Selects the whole-file node, whose start line is the "diff --git"
      // header — in no hunk.
      s.handleKey({ name: "tab" });
      expect(s.view().selected?.label).toBe("▸ m.ts");
      expect(
        s.view().expandUp,
        "the quarter-screen target chooses an upward edge",
      ).toBe(true);
      expect(
        s.view().expandRow,
        "the second hunk's top edge wins the equal-distance choice",
      ).toBe(10);
      s.handleKey({ name: "ctrl-l" });
      // The target is equally far from the first hunk's bottom and the second
      // hunk's top. The second edge has more context available.
      assert(s.view().message.startsWith("Showing line"), s.view().message);
      expect(s.doc.text, "the first hunk is untouched").toContain(
        "@@ -4,3 +4,3 @@",
      );
      expect(s.doc.text, "the second hunk expanded upward").toContain(
        "@@ -20,13 +20,13 @@",
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps the selected node selected across the reparse of a pager expand", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(
        join(root, "README.md"),
        "# Title\n\nintro\n\n## Section A\n\nbody a\n\n## Section B\n\nbody b NEW\n",
      );
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
      const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -9,3 +9,3 @@
 ## Section B

-body b OLD
+body b NEW
`;
      const model = parseDiff(diff)!;
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 40 },
        undefined,
        diffSource(ws, edit),
      );
      let guard = 0;
      while (s.view().selected?.label !== "## Section B" && guard++ < 50) {
        s.handleKey({ name: "tab" });
      }
      expect(s.view().selected?.label).toBe("## Section B");
      // Expands up — reveals # Title and ## Section A.
      s.handleKey({ name: "ctrl-l" });
      expect(s.doc.text, "context revealed above the hunk").toContain(
        " # Title",
      );
      // The revealed headings become new nodes ahead of the selection in the
      // tree; the selection must follow its node, not the now-stale flat index.
      expect(
        s.view().selected?.label,
        "the selection stayed on the same heading",
      ).toBe("## Section B");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("saves an edit made after expanding context without duplicating lines", () => {
    const { root, s, done } = expandSession();
    try {
      toLine(s, 8);
      // Expand downward (reveals zeta/eta/theta).
      s.handleKey({ name: "ctrl-l" });
      press(s, "escape");
      toLine(s, 7); // the "+delta" line
      press(s, "end");
      type(s, "!");
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(
        onDisk,
        "the edit is written and the revealed context is not duplicated",
      ).toEqual([
        "alpha",
        "beta",
        "gamma",
        "delta!",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "",
      ]);
    } finally {
      done();
    }
  });

  const MULTI_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -11,3 +11,3 @@
 line11
-OLD12
+line12
 line13
`;

  const FAR_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -30,3 +30,3 @@
 line30
-OLD31
+line31
 line32
`;

  it("joins two hunks when context expands into the next one, and saves correctly", () => {
    const root = Deno.makeTempDirSync();
    try {
      const file = Array.from({ length: 20 }, (_, i) =>
        `line${i + 1}`).join("\n") +
        "\n";
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
      const model = parseDiff(MULTI_DIFF)!;
      const { doc, edit } = buildDiffDocument(MULTI_DIFF, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 40 },
        undefined,
        diffSource(ws, edit),
      );
      toLine(s, 8); // " line6", the bottom of the first hunk
      s.handleKey({ name: "ctrl-l" }); // expand down — the four lines to hunk 2
      // The reveal closes the gap, so the two hunks meet and become one: the
      // header that sat between line10 and line11 described nothing.
      expect(
        s.doc.text.split("\n")[4],
        "the two hunks joined into one covering both ranges",
      ).toBe("@@ -4,10 +4,10 @@");
      expect(
        parseDiff(s.doc.text)!.files.flatMap((f) => f.hunks).length,
        "one hunk where there were two",
      ).toBe(1);
      // Now edit the SECOND hunk and save: the edit must survive and no line
      // may be dropped or duplicated.
      press(s, "escape");
      const target = s.doc.text.split("\n").indexOf("+line12");
      toLine(s, target);
      press(s, "end");
      type(s, "_EDIT");
      press(s, "f3");
      const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
      expect(onDisk[11], "the second-hunk edit was saved").toBe("line12_EDIT");
      expect(onDisk.length, "20 lines + trailing — nothing dropped/dup'd").toBe(
        21,
      );
      expect(onDisk[4]).toBe("line5");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("reverts the right commit's section when a path repeats", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(join(root, "f.ts"), "a\nb\nold3\n");
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
      const logp = `commit AAAAAAA
diff --git a/f.ts b/f.ts
index 0000000..1111111 100644
--- a/f.ts
+++ b/f.ts
@@ -3,1 +3,1 @@
-NOPE3
+NEW3
commit BBBBBBB
diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -3,1 +3,1 @@
-older3
+old3
`;
      const model = parseDiff(logp)!;
      const { edit } = buildDiffDocument(logp, model, ws);
      const src = diffSource(ws, edit);
      // Edit the SECOND commit's "+old3" line.
      const edited = logp.replace("+old3", "+old3Z");
      const bbbLine = edited.split("\n").indexOf("+old3Z");
      const r = src.revert!(logp, edited, bbbLine, "chunk")!;
      expect(
        r.text,
        "the second commit's hunk is restored, not overwritten by the first",
      ).toBe(logp);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("keeps the pair when an author's `+` line is edited to match its `-` line", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(join(root, "m.ts"), "foo\nbarX\n");
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
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 foo
-bar
+barX
`;
      const model = parseDiff(diff)!;
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 20 },
        undefined,
        diffSource(ws, edit),
      );
      toLine(s, 7); // the "+barX" added line (author-written, not a split)
      press(s, "end");
      press(s, "backspace"); // -> "+bar", which now matches "-bar" above
      const lines = s.doc.text.split("\n");
      expect(lines[6], "the author's removed line is preserved").toBe("-bar");
      expect(lines[7], "the pair is NOT collapsed to context").toBe("+bar");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("adds a line on Enter at the end of a context line without forging a `-`/`+` pair", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 5); // " export function double..." context line
      press(s, "end");
      press(s, "enter");
      type(s, "added");
      const lines = s.doc.text.split("\n");
      expect(
        lines[5],
        "the context line is unchanged, not split into a -/+ pair",
      ).toBe(" export function double(n: number): number {");
      expect(lines[6], "the new line is added below it").toBe("+added");
    } finally {
      done();
    }
  });

  it("keeps a trailing blank separator outside a hunk expanded downward", () => {
    const root = Deno.makeTempDirSync();
    try {
      const file = Array.from({ length: 8 }, (_, i) => `x${i + 1}`).join("\n") +
        "\n";
      Deno.writeTextFileSync(join(root, "x.ts"), file);
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
      const diff = `diff --git a/x.ts b/x.ts
index 0000000..1111111 100644
--- a/x.ts
+++ b/x.ts
@@ -3,3 +3,3 @@
 x3
-OLD4
+x4
 x5

trailing note line
`;
      const model = parseDiff(diff)!;
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 40 },
        undefined,
        diffSource(ws, edit),
      );
      toLine(s, 8); // " x5", the bottom of the hunk
      s.handleKey({ name: "ctrl-l" }); // expand down
      const text = s.doc.text;
      expect(
        text,
        `revealed context stays inside the hunk, blank separator kept:\n${text}`,
      ).toContain(" x5\n x6\n x7\n x8\n\ntrailing note line");
      expect(text.split("\n")[4]).toBe("@@ -3,6 +3,6 @@");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("lands the cursor on an editable line, not a header, after a revert", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      toLine(s, 9); // edit an added line
      press(s, "end");
      type(s, "Z");
      s.handleKey({ name: "ctrl-r" });
      press(s, "h"); // revert the chunk
      const cl = s.view().cursor!.line;
      // The landed line is editable (not the @@ header it was spliced at).
      const text = s.doc.lines[cl].text;
      assert(
        text[0] === " " || text[0] === "+",
        `cursor on an editable line after revert: ${text}`,
      );
    } finally {
      done();
    }
  });

  it("collapses an undone context edit even after the cursor moved away and back", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      const before = s.doc.text;
      toLine(s, 6); // a context line
      press(s, "end");
      type(s, "X"); // splits into "-ctx" / "+ctxX"
      press(s, "left", "right"); // move off the split line and back
      press(s, "backspace"); // delete X: "+ctx" matches "-ctx" again
      expect(s.doc.text, "the pair collapsed back to a context line").toBe(
        before,
      );
    } finally {
      done();
    }
  });

  it("leaves the full match set for normal-mode `n`/`N` after an edit-mode search", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      press(s, "e"); // reveal the edit cursor
      s.handleKey({ name: "ctrl-s" });
      type(s, "answer"); // matches the removed line 8 and added line 9
      press(s, "enter");
      press(s, "escape"); // leave edit mode; the query stays active
      const matchLines = (s.view().matches ?? []).map((m) => m.line);
      expect(
        matchLines,
        `normal-mode matches still include the removed line: ${matchLines}`,
      ).toContain(8);
    } finally {
      done();
    }
  });

  it("skips removed lines in a Ctrl-S search", () => {
    const { ws, done } = tempWorkspace();
    try {
      const s = diffSession(ws);
      press(s, "e"); // reveal at line 0
      s.handleKey({ name: "ctrl-s" });
      // "answer" first occurs on the removed line 8, then the added line 9.
      type(s, "answer");
      press(s, "enter");
      const cl = s.view().cursor!.line;
      assert(
        s.doc.lines[cl].text.startsWith("+"),
        `cursor landed on an editable line, not a removed one: ${
          s.doc.lines[cl].text
        }`,
      );
    } finally {
      done();
    }
  });

  it("grows the hunk count on an inserted line so no body line is dropped", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(join(root, "m.ts"), "a\nb\nc\nd\n");
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
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,4 @@
 a
-OLD
+b
 c
 d
`;
      const model = parseDiff(diff)!;
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 20 },
        undefined,
        diffSource(ws, edit),
      );
      toLine(s, 7); // the "+b" added line
      press(s, "end");
      press(s, "enter");
      type(s, "NEW");
      expect(s.doc.text.split("\n")[4], "the new-side count grew by one").toBe(
        "@@ -1,4 +1,5 @@",
      );
      s.reparse(); // the deferred full parse must keep every line in the hunk
      const d = s.doc.lines.find((l) => l.text === " d")!;
      expect(
        d.spans[0].cls,
        "the trailing context line is not dropped to plain text",
      ).toBe("whitespace");
      // Removing the added line again restores the original count: delete its
      // content, then backspace at the now-empty line's start to drop the line.
      press(s, "backspace", "backspace", "backspace"); // delete W, E, N -> "+"
      press(s, "backspace"); // empty added line: remove it
      expect(s.doc.text.split("\n")[4]).toBe("@@ -1,4 +1,4 @@");
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("reveals the right file lines when expanding after an insert", () => {
    const { s, done } = expandSession();
    try {
      toLine(s, 7); // "+delta"
      press(s, "end");
      press(s, "enter");
      type(s, "INS"); // insert a line inside the hunk
      press(s, "escape");
      const il = s.doc.text.split("\n").indexOf("+INS");
      toLine(s, il);
      s.handleKey({ name: "ctrl-l" }); // expand down
      // The revealed context starts just below the original hunk footprint
      // (zeta), not shifted past it by the inserted line.
      expect(s.doc.text).toContain(" zeta\n eta\n theta");
    } finally {
      done();
    }
  });

  it("reads the saved file when expanding after saving an insert", () => {
    const { s, done } = expandSession();
    try {
      toLine(s, 7); // "+delta"
      press(s, "end", "enter");
      type(s, "INS");
      press(s, "f3");

      const epsilon = s.doc.text.split("\n").indexOf(" epsilon");
      toLine(s, epsilon);
      s.handleKey({ name: "ctrl-l" });
      expect(s.doc.text).toContain(" epsilon\n zeta\n eta\n theta");
    } finally {
      done();
    }
  });

  it("writes the file correctly after an insert, an expand, and an edit", () => {
    const { root, s, done } = expandSession();
    try {
      toLine(s, 7); // "+delta"
      press(s, "end");
      press(s, "enter");
      type(s, "INS"); // insert a line
      press(s, "escape");
      toLine(s, s.doc.text.split("\n").indexOf("+INS"));
      s.handleKey({ name: "ctrl-l" }); // expand context
      press(s, "escape");
      toLine(s, s.doc.text.split("\n").indexOf("+delta"));
      press(s, "end");
      type(s, "!"); // edit the original change
      press(s, "f3");
      expect(
        Deno.readTextFileSync(join(root, "m.ts")),
        "the edit and insert land; revealed context is not duplicated",
      ).toBe("alpha\nbeta\ngamma\ndelta!\nINS\nepsilon\nzeta\neta\ntheta\n");
    } finally {
      done();
    }
  });

  describe("mapping hunks onto file lines", () => {
    it("saves a `git log -p` diff without absorbing commit text or writing a stale hunk", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "x.ts"), "realLine1\nrest2\nrest3\n");
        // Two commits both touch x.ts at the same range. Only the newest
        // (first) verifies against disk; the older one is stale, and commit
        // metadata sits between the two file sections.
        const log = [
          "commit bbbbbbbbbbbbbbbb",
          "Author: Dev <dev@example.com>",
          "Date:   Mon Jan 1 00:00:00 2024 +0000",
          "",
          "    Second commit subject line",
          "",
          "diff --git a/x.ts b/x.ts",
          "index 2222222..3333333 100644",
          "--- a/x.ts",
          "+++ b/x.ts",
          "@@ -1,1 +1,1 @@",
          "-realLine0",
          "+realLine1",
          "commit aaaaaaaaaaaaaaaa",
          "Author: Dev <dev@example.com>",
          "Date:   Sun Jan 1 00:00:00 2023 +0000",
          "",
          "    First commit subject line",
          "",
          "diff --git a/x.ts b/x.ts",
          "index 1111111..2222222 100644",
          "--- a/x.ts",
          "+++ b/x.ts",
          "@@ -1,1 +1,1 @@",
          "-original",
          "+realLine0",
          "",
        ].join("\n");
        const s = sessionFor(
          log,
          stubWs(root),
          fakeGit("bbbbbbbbbbbbbbbb").git,
        );
        const before = s.doc.text;
        toLine(s, 24); // the stale hunk's "-original" line
        assert(
          !s.view().editHint?.some((hint) => hint.key === "R"),
          "a removed line in a stale hunk does not offer resurrection",
        );
        press(s, "R");
        expect(s.doc.text, "the stale removed line stayed protected").toBe(
          before,
        );
        expect(s.view().message).toBe(
          "This line belongs to a commit other than HEAD and cannot be edited.",
        );
        press(s, "f3"); // save with no edits at all
        expect(
          Deno.readTextFileSync(join(root, "x.ts")),
          "the file is untouched: no absorbed metadata, no stale hunk written",
        ).toBe("realLine1\nrest2\nrest3\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("refuses to resurrect a line in a hunk with no new-side anchor", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "alpha\nbeta\n");
        Deno.writeTextFileSync(join(root, "b.ts"), "new\n");
        const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -2 +1,0 @@
-old
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-old
+new
    `;
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 4); // a.ts's removed line; b.ts makes the diff editable
        press(s, "ctrl-l");
        expect(
          s.doc.text.split("\n").slice(3, 6),
          "zero-count context expansion uses the insertion coordinate",
        ).toEqual(["@@ -1,2 +1,1 @@", " alpha", "-old"]);
        const before = s.doc.text;
        assert(
          !s.view().editHint?.some((hint) => hint.key === "R"),
          "an unanchored removal does not offer resurrection",
        );
        press(s, "R");
        expect(s.doc.text, "the unanchored insertion was refused").toBe(before);
        expect(s.view().message).toContain("isn't editable");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("expands a zero-count hunk down from its insertion point", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "alpha\nbeta\n");
        Deno.writeTextFileSync(join(root, "b.ts"), "new\n");
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -2 +1,0 @@",
          "-old",
          "diff --git a/b.ts b/b.ts",
          "--- a/b.ts",
          "+++ b/b.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n");
        const ws = stubWs(root);
        const model = parseDiff(diff)!;
        const { edit } = buildDiffDocument(diff, model, ws);
        const source = diffSource(ws, edit);
        const expanded = source.expandContext?.(diff, diff, 4, false);
        assert(
          expanded,
          "the workspace line below the insertion point is shown",
        );
        expect(
          expanded.text.split("\n")[3],
          "a downward reveal advances a zero-count new-side coordinate",
        ).toBe("@@ -2,2 +2,1 @@");
        expect(
          expanded.text.split("\n")[5],
          "the workspace line after the insertion point was revealed",
        ).toBe(" beta");
        expect(expanded.revealed).toEqual({ from: 2, to: 2 });
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("blocks a repeated blank range at an empty-file insertion point", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "");
        const log = [
          "commit bbbbbbbbbbbbbbbb",
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1 +0,0 @@",
          "-current",
          "commit aaaaaaaaaaaaaaaa",
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1 +1 @@",
          "-historical",
          "+",
          "\\ No newline at end of file",
          "",
        ].join("\n");
        const s = sessionFor(log, stubWs(root));
        toLine(s, log.split("\n").indexOf("-current"));
        assert(
          s.view().editHint?.some((hint) => hint.key === "R"),
          "the first empty-file deletion owns the insertion point",
        );
        press(s, "R");
        toLine(s, s.doc.text.split("\n").indexOf("-historical"));
        assert(
          !s.view().editHint?.some((hint) => hint.key === "R"),
          "the repeated blank range cannot write through the insertion point",
        );
        press(s, "f3");
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe("current\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps a zero-count range from overlapping a claimed blank file line", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "");
        const log = [
          "commit bbbbbbbbbbbbbbbb",
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1 +1 @@",
          "-old",
          "+",
          "\\ No newline at end of file",
          "commit aaaaaaaaaaaaaaaa",
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1 +0,0 @@",
          "-historical",
          "",
        ].join("\n");
        const s = sessionFor(log, stubWs(root));
        toLine(s, log.split("\n").indexOf("-old"));
        assert(
          s.view().editHint?.some((hint) => hint.key === "R"),
          "the verified blank new-side line claims the current range",
        );
        toLine(s, log.split("\n").indexOf("-historical"));
        assert(
          !s.view().editHint?.some((hint) => hint.key === "R"),
          "the later zero-count range cannot overlap that claimed line",
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("restores a zero-count coordinate when the only addition is removed", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "only\n");
        const diff = [
          "diff --git a/m.ts b/m.ts",
          "--- /dev/null",
          "+++ b/m.ts",
          "@@ -0,0 +1 @@",
          "+only",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 4);
        press(s, "end");
        for (const _ of "only") press(s, "backspace");
        press(s, "backspace");
        expect(
          s.doc.text.split("\n")[3],
          "crossing to zero moves the insertion coordinate before the first line",
        ).toBe("@@ -0,0 +0,0 @@");
        press(s, "f3");
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe("");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("resurrects the only line of an empty file without adding a final newline", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "");
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +0,0 @@",
          "-only",
          "\\ No newline at end of file",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 4);
        assert(
          s.view().editHint?.some((hint) => hint.key === "R"),
          "the empty workspace file anchors the insertion point",
        );
        const beforeExpand = s.doc.text;
        press(s, "ctrl-l");
        expect(s.doc.text, "the empty file has no context to reveal").toBe(
          beforeExpand,
        );
        press(s, "R");
        expect(
          s.doc.text.split("\n")[3],
          "growing a zero-count range advances its start",
        ).toBe("@@ -1,1 +1,1 @@");
        press(s, "f3");
        expect(
          Deno.readTextFileSync(join(root, "a.ts")),
          "the resurrected EOF line keeps its missing final newline",
        ).toBe("only");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("adds no carriage return to a no-newline line from a CRLF diff", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "");
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +0,0 @@",
          "-only",
          "\\ No newline at end of file",
          "",
        ].join("\r\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 4);
        press(s, "R", "f3");
        expect(
          Deno.readTextFileSync(join(root, "a.ts")),
          "the CRLF transport ending is not part of the restored file line",
        ).toBe("only");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps the final newline on a resurrection before a later addition", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "new\n");
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 4);
        press(s, "R", "f3");
        expect(
          Deno.readTextFileSync(join(root, "a.ts")),
          "old-side metadata does not change the later new-side ending",
        ).toBe("old\nnew\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("leaves later workspace lines untrimmed by old-side no-newline metadata", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "new\nlater\n");
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 4);
        press(s, "R", "f3");
        expect(
          Deno.readTextFileSync(join(root, "a.ts")),
          "metadata outside the workspace EOF does not change its ending",
        ).toBe("old\nnew\nlater\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("leaves a hunk read-only when its new-side no-newline metadata differs from the workspace", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "a.ts"), "new\n");
        const diff = [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "\\ No newline at end of file",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        press(s, "e");
        expect(
          s.view().cursor,
          "newline metadata that differs from disk leaves the hunk read-only",
        ).toBeNull();
        press(s, "f3");
        expect(Deno.readTextFileSync(join(root, "a.ts"))).toBe("new\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("resurrects a removed line in a CRLF diff", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "a\r\nc\r\n");
        const diff = [
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1,3 +1,2 @@",
          " a",
          "-b",
          " c",
          "",
        ].join("\r\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 5);
        press(s, "R");
        expect(
          s.doc.text.split("\n")[3],
          "the count changes without dropping the carriage return",
        ).toBe("@@ -1,3 +1,3 @@\r");
        press(s, "f3");
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe(
          "a\r\nb\r\nc\r\n",
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("resurrects within a CRLF file that has no final newline", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "a\r\nc");
        const diff = [
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1,3 +1,2 @@",
          " a",
          "-b",
          " c",
          "\\ No newline at end of file",
          "",
        ].join("\r\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 5);
        press(s, "R", "f3");
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe("a\r\nb\r\nc");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("preserves a missing final newline across joined CRLF hunks", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "a\r\nB\r\nc\r\nd\r\nE");
        const diff = [
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1,2 +1,2 @@",
          " a",
          "-oldB",
          "+B",
          "@@ -4,2 +4,2 @@",
          " d",
          "-oldE",
          "+E",
          "\\ No newline at end of file",
          "",
        ].join("\r\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 6); // "+B", the bottom of the first hunk
        press(s, "ctrl-l");
        expect(
          s.doc.text.split("\n")[3],
          "joining hunks preserves the CRLF transport ending",
        ).toBe("@@ -1,5 +1,5 @@\r");
        toLine(s, s.doc.text.split("\n").indexOf("-oldE\r"));
        press(s, "R", "f3");
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the final line does not gain a transport carriage return",
        ).toBe("a\r\nB\r\nc\r\nd\r\noldE\r\nE");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps a hunk whose body text resembles file headers", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "++ sentinel\nD\n");
        const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
--- prior
+++ sentinel
-old
+D
`;
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 6);
        press(s, "R");
        expect(s.doc.text.split("\n")[3]).toBe("@@ -1,2 +1,3 @@");
        press(s, "f3");
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe(
          "++ sentinel\nold\nD\n",
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps a repeated historical range from overwriting a resurrection", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "A\n");
        const log = [
          "commit bbbbbbbbbbbbbbbb",
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1 +1 @@",
          "-X",
          "+A",
          "commit aaaaaaaaaaaaaaaa",
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1 +1 @@",
          "-B",
          "+A",
          "",
        ].join("\n");
        const s = sessionFor(log, stubWs(root));
        toLine(s, log.split("\n").indexOf("-X"));
        press(s, "R");
        toLine(s, log.split("\n").indexOf("-B"));
        assert(
          !s.view().editHint?.some((hint) => hint.key === "R"),
          "the older overlapping hunk is read-only",
        );
        press(s, "f3");
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the older hunk does not replace the edited current range",
        ).toBe("X\nA\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("stops context expansion before a repeated writable range", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "x.ts"), "A\nB\nC\nD\nE\n");
        Deno.writeTextFileSync(join(root, "y.ts"), "Y\n");
        const log = [
          "commit cccccccccccccccc",
          "diff --git a/x.ts b/x.ts",
          "--- a/x.ts",
          "+++ b/x.ts",
          "@@ -1 +1 @@",
          "-oldA",
          "+A",
          "diff --git a/y.ts b/y.ts",
          "--- a/y.ts",
          "+++ b/y.ts",
          "@@ -1 +1 @@",
          "-oldY",
          "+Y",
          "commit bbbbbbbbbbbbbbbb",
          "diff --git a/x.ts b/x.ts",
          "--- a/x.ts",
          "+++ b/x.ts",
          "@@ -5 +5 @@",
          "-Z",
          "+E",
          "",
        ].join("\n");
        const s = sessionFor(log, stubWs(root));
        toLine(s, log.split("\n").indexOf("+A"));
        press(s, "ctrl-l");
        const removed = s.doc.text.split("\n").indexOf("-Z");
        toLine(s, removed);
        assert(
          s.view().editHint?.some((hint) => hint.key === "R"),
          "the later non-overlapping range remains writable",
        );
        press(s, "R", "f3");
        expect(
          Deno.readTextFileSync(join(root, "x.ts")),
          "expanded context does not overwrite the later resurrection",
        ).toBe("A\nB\nC\nD\nZ\nE\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("refuses an edit on a blank diff line", () => {
      const root = Deno.makeTempDirSync();
      try {
        Deno.writeTextFileSync(join(root, "m.ts"), "alpha\n\nbeta\n");
        // The middle context line is emitted empty (a tool that trims the
        // space).
        const diff = [
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1,3 +1,3 @@",
          " alpha",
          "",
          " beta",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 5); // the empty context line
        const before = s.doc.text;
        type(s, "x");
        expect(s.view().message).toContain("isn't editable");
        expect(s.doc.text, "the blank line was not forged into '-'/'x'").toBe(
          before,
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("saves a hunk with a blank context line without truncating the file", () => {
      const root = Deno.makeTempDirSync();
      try {
        // The new side on disk has a blank line between alpha and BETA. The
        // diff's body therefore carries an empty (unprefixed) context line; the
        // parser counts it toward the hunk while save must carry its file line,
        // not stop.
        Deno.writeTextFileSync(join(root, "m.ts"), "alpha\n\nBETA\ngamma\n");
        const diff = [
          "diff --git a/m.ts b/m.ts",
          "--- a/m.ts",
          "+++ b/m.ts",
          "@@ -1,4 +1,4 @@",
          " alpha",
          "", // blank context line inside the counted body
          "-beta",
          "+BETA",
          " gamma",
          "",
        ].join("\n");
        const s = sessionFor(diff, stubWs(root));
        toLine(s, 7); // the "+BETA" added line, below the blank context line
        press(s, "end");
        type(s, "!");
        press(s, "f3");
        assert(s.view().message.startsWith("Saved"), s.view().message);
        // The whole new side round-trips: the blank line, the edit, and every
        // line after it survive — no early stop that splices away the file's
        // tail.
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the blank context line did not truncate the saved file",
        ).toBe("alpha\n\nBETA!\ngamma\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  });

  describe("a commit-message preamble", () => {
    it("refuses an edit on the subject line before the diff", () => {
      const { ws, done } = tempWorkspace();
      try {
        const s = diffSessionFrom(ws, GIT_SHOW);
        toLine(s, 4); // the indented subject line — reads like context, is not
        expect(s.view().cursor?.line, "cursor on the subject line").toBe(4);
        const before = s.doc.text;
        type(s, "X");
        expect(s.doc.text, "the edit was refused").toBe(before);
        expect(s.view().message.length, "and it says why").toBeGreaterThan(0);
      } finally {
        done();
      }
    });

    it("refuses an edit on a message body line and accepts one on a hunk line", () => {
      const { ws, done } = tempWorkspace();
      try {
        const s = diffSessionFrom(ws, GIT_SHOW);
        // A body line of the commit message is not part of any hunk: refused.
        toLine(s, 6);
        const before = s.doc.text;
        type(s, "Z");
        expect(s.doc.text, "message body edit refused").toBe(before);
        // An added line inside the verified hunk is still editable.
        toLine(s, 17); // "+export const answer = double(21);"
        press(s, "end");
        type(s, " // note");
        expect(s.doc.text, "the hunk line accepted the edit").not.toBe(before);
        expect(s.doc.lines[17].text).toContain("// note");
      } finally {
        done();
      }
    });

    it("skips the preamble to a savable line in an edit-mode search", () => {
      const { ws, done } = tempWorkspace();
      try {
        const s = diffSessionFrom(ws, GIT_SHOW);
        press(s, "e"); // reveal the cursor
        // Search for text that appears on an added line inside the hunk. An
        // edit-mode search lands the cursor only on editable matches, so it
        // skips the commit-message preamble entirely.
        s.handleKey({ name: "ctrl-s" });
        for (const ch of "double(21)") s.handleKey({ name: ch, char: ch });
        s.handleKey({ name: "enter" });
        const line = s.view().cursor?.line ?? -1;
        expect(line, `cursor landed in the hunk body, at ${line}`)
          .toBeGreaterThanOrEqual(12);
        type(s, "!");
        expect(s.doc.lines[line].text, "the landed line is editable").toContain(
          "!",
        );
      } finally {
        done();
      }
    });
  });

  describe("amending the HEAD commit", () => {
    it("accepts an edit to the HEAD commit's message, then prompts and amends on save", () => {
      const { root, ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA); // the shown commit IS HEAD
      try {
        const path = join(root, "m.ts");
        const oldTime = new Date("2000-01-01T00:00:00.000Z");
        Deno.utimeSync(path, oldTime, oldTime);
        const mtime = Deno.statSync(path).mtime?.getTime();
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4); // the subject line — an editable message line
        press(s, "end");
        type(s, " EDIT");
        // A message line is edited as plain indented text (no removed/added
        // pair).
        expect(s.doc.lines[4].text).toBe("    Subject line of the commit EDIT");
        // Saving a changed message asks to confirm the amend first.
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit 012345678");
        expect(fg.amended(), "nothing amended before confirming").toBeNull();
        // Confirm: the amend runs with the edited message (indent stripped).
        press(s, "a");
        expect(fg.amended()).toBe(
          "Subject line of the commit EDIT\n\nA body paragraph of the message.",
        );
        expect(fg.amendedPaths()).toEqual([]);
        expect(s.view().message).toBe("Saved 0 files; Amended the commit");
        expect(
          Deno.statSync(path).mtime?.getTime(),
          "a message-only amend did not write the unchanged file",
        ).toBe(mtime);
      } finally {
        done();
      }
    });

    it("amends the message of a commit with no file diff", () => {
      const commitOnly = [
        `commit ${SHOW_SHA}`,
        "Author: A B <a@b.example>",
        "Date:   Wed Jul 1 12:00:00 2026 -0700",
        "",
        "    Empty commit subject",
        "",
      ].join("\n");
      const ws: DiffWorkspace = { resolve: () => null, read: () => null };
      const model = {
        files: [],
        lines: commitOnly.split("\n").map(() => ({ kind: "other" as const })),
      };
      const { doc, edit } = buildDiffDocument(commitOnly, model, ws);
      const fg = fakeGit(SHOW_SHA);
      const src = diffSource(ws, edit, undefined, fg.git);
      expect(src.editable).toBe(true);
      expect(src.label).toBeNull();
      const s = new Session(
        doc,
        { color: false, showLineNumbers: false },
        { width: 80, height: 12 },
        undefined,
        src,
      );

      toLine(s, 4);
      press(s, "end");
      type(s, " EDIT");
      press(s, "f3");
      expect(promptText(s.view())).toContain("Amend commit");
      press(s, "s");
      expect(fg.amended()).toBeNull();
      expect(s.view().message).toBe(
        "Saved 0 files; commit message remains unsaved",
      );
      press(s, "f3");
      press(s, "a");
      expect(fg.amended()).toBe("Empty commit subject EDIT");
      expect(fg.amendedPaths()).toEqual([]);
      expect(s.view().message).toBe("Saved 0 files; Amended the commit");
    });

    it("offers explicit save actions in the amend prompt", () => {
      const { root, ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const path = join(root, "m.ts");
        const before = Deno.readTextFileSync(path);
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 6); // the body line
        press(s, "end");
        type(s, " more");
        toLine(s, 17);
        press(s, "end");
        type(s, " // pending");
        press(s, "f3");
        expect(
          s.view().dialog?.buttons.map(({ label, hotkey }) => ({
            label,
            hotkey,
          })),
        ).toEqual([
          { label: "Amend commit", hotkey: "a" },
          { label: "Save files only", hotkey: "s" },
          { label: "Cancel", hotkey: "c" },
        ]);
        press(s, "y", "n");
        assert(s.view().dialog, "the former yes/no keys do nothing");
        press(s, "c");
        expect(fg.amended(), "the commit was not amended").toBeNull();
        expect(Deno.readTextFileSync(path), "no file was saved").toBe(before);
        expect(s.view().message).toBe("Save cancelled.");
      } finally {
        done();
      }
    });

    it("leaves a message edit unsaved when saving files only", () => {
      const { root, ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4);
        press(s, "end");
        type(s, " EDIT");
        toLine(s, 17);
        press(s, "end");
        type(s, " // workspace");

        press(s, "f3");
        press(s, "s");

        expect(fg.amended(), "files-only save did not amend HEAD").toBeNull();
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the hunk edit was written to its workspace file",
        ).toContain("// workspace");
        expect(s.view().message).toBe(
          "Saved 1 file; commit message remains unsaved",
        );

        // Only the message remains dirty. Saving again offers the same explicit
        // choice, and amending now does not absorb the earlier workspace-only
        // edit.
        press(s, "f3");
        assert(s.view().dialog, "the unsaved message prompts again");
        press(s, "a");
        expect(fg.amended()).toBe(
          "Subject line of the commit EDIT\n\nA body paragraph of the message.",
        );
        expect(fg.amendedPaths()).toEqual([]);
        expect(s.view().message).toBe("Saved 0 files; Amended the commit");
      } finally {
        done();
      }
    });

    it("completes a pending quit when saving files only", () => {
      const { root, ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 17);
        press(s, "end");
        type(s, " // workspace");
        press(s, "escape", "q");
        press(s, "s"); // Save in the ordinary quit prompt.
        assert(!s.quit, "the commit choice is still pending");
        press(s, "s"); // Save files only in the commit prompt.

        assert(s.quit, "the clean buffer can quit after its files are saved");
        expect(fg.amended()).toBeNull();
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the workspace file contains the edit",
        ).toContain("// workspace");
      } finally {
        done();
      }
    });

    it("restores the files written by the save when the amend fails", () => {
      const { root, ws, done } = tempWorkspace();
      try {
        const path = join(root, "m.ts");
        const git: GitRunner = {
          headSha: () => SHOW_SHA,
          fileAtCommit: (_commit, file) => Deno.readTextFileSync(file),
          applyFileChanges: (_committed, _before, after) => after,
          amendCommit: () => {
            throw new Error("commit hook rejected the amend");
          },
        };
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const src = diffSource(ws, edit, undefined, git);
        const edited = GIT_SHOW.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager edit",
        );
        let error = "";
        try {
          saveSource(src, edited, GIT_SHOW);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        expect(error, error || "save did not fail").toContain(
          "commit hook rejected",
        );
        expect(
          Deno.readTextFileSync(path),
          "the failed amend left the workspace file as it was before save",
        ).toBe(FILE_TEXT);
      } finally {
        done();
      }
    });

    it("refuses to save when a selected workspace file disappeared", () => {
      const { root, ws, done } = tempWorkspace();
      try {
        const model = parseDiff(DIFF)!;
        const { edit } = buildDiffDocument(DIFF, model, ws);
        const source = diffSource(ws, edit);
        Deno.removeSync(join(root, "m.ts"));
        const edited = DIFF.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager",
        );

        expect(() => saveSource(source, edited, DIFF)).toThrow(
          "Could not read",
        );
      } finally {
        done();
      }
    });

    it("accepts a file the Git runner already restored when the amend fails", () => {
      const { root, ws, done } = tempWorkspace();
      try {
        const path = join(root, "m.ts");
        const git: GitRunner = {
          headSha: () => SHOW_SHA,
          fileAtCommit: (_commit, file) => Deno.readTextFileSync(file),
          applyFileChanges: (_committed, _before, after) => after,
          amendCommit: () => {
            Deno.writeTextFileSync(path, FILE_TEXT);
            throw new Error("commit hook rejected the amend");
          },
        };
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const source = diffSource(ws, edit, undefined, git);
        const edited = GIT_SHOW.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager",
        );

        // `assertThrows()` returns the error, and this case reads two facts off
        // its message; `toThrow()` returns nothing.
        const error = assertThrows(
          () => saveSource(source, edited, GIT_SHOW),
          Error,
          "commit hook rejected",
        );
        expect(error.message).not.toContain("restoring files failed");
        expect(Deno.readTextFileSync(path)).toBe(FILE_TEXT);
      } finally {
        done();
      }
    });

    it("reports an error while reading a file for rollback", () => {
      const root = Deno.makeTempDirSync();
      const path = join(root, "m.ts");
      Deno.writeTextFileSync(path, FILE_TEXT);
      let rollback = false;
      const ws: DiffWorkspace = {
        resolve: (relative) => join(root, relative),
        read: (absolute) => {
          if (rollback) throw new Error("rollback read failed");
          return Deno.readTextFileSync(absolute);
        },
      };
      const git: GitRunner = {
        headSha: () => SHOW_SHA,
        fileAtCommit: (_commit, file) => Deno.readTextFileSync(file),
        applyFileChanges: (_committed, _before, after) => after,
        amendCommit: () => {
          rollback = true;
          throw new Error("commit hook rejected the amend");
        },
      };
      try {
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const source = diffSource(ws, edit, undefined, git);
        const edited = GIT_SHOW.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager",
        );

        // `assertThrows()` returns the error, and this case reads two facts off
        // its message; `toThrow()` returns nothing.
        const error = assertThrows(
          () => saveSource(source, edited, GIT_SHOW),
          Error,
          "restoring files failed",
        );
        expect(error.message).toContain("rollback read failed");
        expect(Deno.readTextFileSync(path)).toContain("// pager");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("preserves a file changed during a failed amend", () => {
      const { root, ws, done } = tempWorkspace();
      try {
        const path = join(root, "m.ts");
        const git: GitRunner = {
          headSha: () => SHOW_SHA,
          fileAtCommit: (_commit, file) => Deno.readTextFileSync(file),
          applyFileChanges: (_committed, _before, after) => after,
          amendCommit: (_message, _files, _head, _ref, expectedWorkspace) => {
            assert(
              expectedWorkspace?.get(path)?.includes("// pager edit"),
              "the amend validates the workspace contents written by the save",
            );
            Deno.writeTextFileSync(path, "changed during amend\n");
            throw new Error("commit hook rejected the amend");
          },
        };
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const src = diffSource(ws, edit, undefined, git);
        const edited = GIT_SHOW.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager edit",
        );

        expect(() => saveSource(src, edited, GIT_SHOW)).toThrow(
          "changed again and was not restored",
        );
        expect(
          Deno.readTextFileSync(path),
          "the later file contents remain untouched",
        ).toBe("changed during amend\n");
      } finally {
        done();
      }
    });

    it("adds another indented message line on Enter", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4);
        press(s, "end");
        press(s, "enter");
        type(s, "second subject line");
        // The new line carries git's four-space indent and stays a message
        // line.
        expect(s.doc.lines[5].text).toBe("    second subject line");
        press(s, "f3");
        press(s, "a");
        expect(fg.amended()).toBe(
          "Subject line of the commit\nsecond subject line\n\n" +
            "A body paragraph of the message.",
        );
      } finally {
        done();
      }
    });

    it("refuses an edit to a non-HEAD commit's message", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit("ffffffffffffffffffffffffffffffffffffffff"); // not the shown sha
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4);
        const before = s.doc.text;
        type(s, "X");
        expect(s.doc.text, "a non-HEAD message is read-only").toBe(before);
        expect(s.view().message).toBe(
          "This line belongs to a commit other than HEAD and cannot be edited.",
        );
        // Saving does not offer to amend a commit that is not HEAD.
        press(s, "f3");
        expect(fg.amended(), "a non-HEAD commit is never amended").toBeNull();
      } finally {
        done();
      }
    });

    it("returns `null` from `notEditableMessage()` for a blank line before the first commit", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const text = `\n${GIT_SHOW}`;
        const model = parseDiff(text)!;
        const { edit } = buildDiffDocument(text, model, ws);
        const source = diffSource(ws, edit, undefined, fg.git);

        expect(source.policy?.notEditableMessage?.(text.split("\n"), 0))
          .toBeNull();
      } finally {
        done();
      }
    });

    it("refuses to amend after the represented commit header is removed", () => {
      const { root, ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const source = diffSource(ws, edit, undefined, fg.git);
        const edited = GIT_SHOW.replace(`commit ${SHOW_SHA}\n`, "").replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager",
        );

        expect(() => saveSource(source, edited, GIT_SHOW)).toThrow(
          "No commit to amend",
        );
        expect(fg.amended()).toBeNull();
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe(FILE_TEXT);
      } finally {
        done();
      }
    });

    it("refuses to amend after HEAD switches branches", () => {
      const { root, ws, done } = tempWorkspace();
      let currentRef = "refs/heads/main";
      const git: GitRunner = {
        headSha: () => SHOW_SHA,
        headRef: () => currentRef,
        fileAtCommit: (_commit, path) => Deno.readTextFileSync(path),
        applyFileChanges: (_committed, _before, after) => after,
        amendCommit: () => {
          throw new Error("amend must not run");
        },
      };
      try {
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const source = diffSource(ws, edit, undefined, git);
        const edited = GIT_SHOW.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager",
        );
        currentRef = "refs/heads/topic";

        expect(() => saveSource(source, edited, GIT_SHOW)).toThrow(
          "different branch",
        );
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe(FILE_TEXT);
      } finally {
        done();
      }
    });

    it("refuses to amend a selected path missing from the shown commit", () => {
      const { root, ws, done } = tempWorkspace();
      const git: GitRunner = {
        headSha: () => SHOW_SHA,
        fileAtCommit: () => null,
        applyFileChanges: (_committed, _before, after) => after,
        amendCommit: () => {
          throw new Error("amend must not run");
        },
      };
      try {
        const model = parseDiff(GIT_SHOW)!;
        const { edit } = buildDiffDocument(GIT_SHOW, model, ws);
        const source = diffSource(ws, edit, undefined, git);
        const edited = GIT_SHOW.replace(
          "+export const answer = double(21);",
          "+export const answer = double(21); // pager",
        );

        expect(() => saveSource(source, edited, GIT_SHOW)).toThrow(
          "shown commit does not contain",
        );
        expect(Deno.readTextFileSync(join(root, "m.ts"))).toBe(FILE_TEXT);
      } finally {
        done();
      }
    });

    it("prompts and amends the file into the commit when only a hunk is edited", () => {
      const { root, ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 17); // an added hunk line
        press(s, "end");
        type(s, " // x");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        expect(fg.amended(), "nothing amended before confirmation").toBeNull();
        press(s, "a");
        expect(fg.amended(), "the unchanged message is preserved").toBeNull();
        expect(fg.amendedPaths()).toEqual([join(root, "m.ts")]);
        expect(s.view().message).toBe("Saved 1 file; Amended the commit");
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the hunk edit was written before the commit was amended",
        ).toContain("// x");
      } finally {
        done();
      }
    });

    it("amends the real HEAD tree when edited `git show` output is saved", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        Deno.writeTextFileSync(
          path,
          FILE_TEXT.replace(
            "export const answer = double(21);\nconst extra = answer + 1;",
            "export const answer = 42;",
          ),
        );
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        Deno.writeTextFileSync(path, FILE_TEXT);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "Subject line of the commit"]);

        const shown = runGit(root, [
          "show",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);
        const ws: DiffWorkspace = {
          resolve: (relative) => join(root, relative),
          read: (absolute) => {
            try {
              return Deno.readTextFileSync(absolute);
            } catch {
              return null;
            }
          },
        };
        const model = parseDiff(shown)!;
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 30 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        const line = s.doc.lines.findIndex((entry) =>
          entry.text === "+export const answer = double(21);"
        );
        expect(line, "git show contains the added line").toBeGreaterThanOrEqual(
          0,
        );
        toLine(s, line);
        press(s, "end");
        type(s, " // amended");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        press(s, "a");

        expect(s.view().message).toBe("Saved 1 file; Amended the commit");
        expect(
          runGit(root, ["show", "HEAD:m.ts"]),
          "the amended commit contains the pager edit",
        ).toContain("double(21); // amended");
        expect(runGit(root, ["status", "--porcelain"])).toBe("");

        press(s, "end");
        type(s, " twice");
        press(s, "f3");
        press(s, "a");
        expect(s.view().message).toBe("Saved 1 file; Amended the commit");
        expect(
          runGit(root, ["show", "HEAD:m.ts"]),
          "a later save amends the commit from the previous pager result",
        ).toContain("double(21); // amended twice");
        expect(runGit(root, ["status", "--porcelain"])).toBe("");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("preserves the raw commit message on a hunk-only amend", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "f.txt");
        Deno.writeTextFileSync(path, "before\n");
        runGit(root, ["add", "f.txt"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        Deno.writeTextFileSync(path, "after\n");
        runGit(root, ["add", "f.txt"]);
        runGit(root, [
          "commit",
          "-q",
          "--cleanup=verbatim",
          "-m",
          "\nsubject\n\n\n",
        ]);
        const rawBefore = runGit(root, ["cat-file", "commit", "HEAD"]);
        const messageBefore = rawBefore.slice(rawBefore.indexOf("\n\n") + 2);
        const shown = runGit(root, [
          "show",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { edit } = buildDiffDocument(shown, model, ws);
        const source = diffSource(ws, edit, undefined, realGit(root));
        const edited = shown.replace("+after\n", "+after edited\n");

        expect(saveSource(source, edited, shown)).toBe(
          "Saved 1 file; Amended the commit",
        );

        const rawAfter = runGit(root, ["cat-file", "commit", "HEAD"]);
        expect(rawAfter.slice(rawAfter.indexOf("\n\n") + 2)).toBe(
          messageBefore,
        );
        expect(runGit(root, ["show", "HEAD:f.txt"])).toBe("after edited\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("amends hunk edits shown in abbreviated, compact, and email formats", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "f.txt");
        Deno.writeTextFileSync(path, "before\n");
        runGit(root, ["add", "f.txt"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        Deno.writeTextFileSync(path, "value 0\n");
        runGit(root, [
          "commit",
          "-qa",
          "-m",
          "subject",
          "-m",
          `ffff ordinary body line
commit deadbeef
From ${"f".repeat(40)} Mon Sep 17 00:00:00 2001
From: Fake Author <fake@example.test>
Date: Wed, 1 Jul 2026 12:00:00 -0700
Subject: [PATCH] Embedded envelope`,
        ]);
        const message = runGit(root, ["cat-file", "commit", "HEAD"]).split(
          "\n\n",
        ).slice(1).join("\n\n");

        const formats: Array<{ name: string; args: string[] }> = [
          {
            name: "four-character medium",
            args: ["--pretty=medium", "--abbrev-commit", "--abbrev=4"],
          },
          { name: "oneline", args: ["--pretty=oneline"] },
          { name: "reference", args: ["--pretty=reference"] },
          { name: "email", args: ["--pretty=email"] },
        ];
        for (const [index, format] of formats.entries()) {
          const shown = runGit(root, [
            "show",
            ...format.args,
            "--no-ext-diff",
            "--no-color",
            "HEAD",
          ]);
          const current = `value ${index}`;
          const next = `value ${index + 1}`;
          expect(shown, `${format.name} output has the hunk`).toContain(
            `+${current}\n`,
          );
          if (format.name === "four-character medium") {
            // Git treats --abbrev as a minimum and lengthens the prefix
            // until it is unambiguous, so the printed hash is a prefix of
            // the full one that is at least four digits long.
            const head = runGit(root, ["rev-parse", "HEAD"]).trim();
            const [, abbreviated = ""] = /^commit ([0-9a-f]+)\n/.exec(shown) ??
              [];
            assert(
              abbreviated.length >= 4 && abbreviated.length < head.length &&
                head.startsWith(abbreviated),
              shown.split("\n")[0],
            );
          }
          const ws = stubWs(root);
          const model = parseDiff(shown)!;
          const { edit } = buildDiffDocument(shown, model, ws);
          const source = diffSource(ws, edit, undefined, realGit(root));
          const edited = shown.replace(`+${current}\n`, `+${next}\n`);

          expect(saveSource(source, edited, shown), format.name).toBe(
            "Saved 1 file; Amended the commit",
          );
          expect(runGit(root, ["show", "HEAD:f.txt"])).toBe(`${next}\n`);
          const raw = runGit(root, ["cat-file", "commit", "HEAD"]);
          expect(raw.split("\n\n").slice(1).join("\n\n")).toBe(message);
        }
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("skips email ownership checks for standard and compact views", () => {
      const { ws, done } = tempWorkspace();
      try {
        let ownershipChecks = 0;
        const git: GitRunner = {
          ...fakeGit(SHOW_SHA).git,
          commitMatchesDiff: () => {
            ownershipChecks++;
            return true;
          },
        };
        const diff = GIT_SHOW.slice(GIT_SHOW.indexOf("diff --git "));
        const views = [
          GIT_SHOW,
          `${SHOW_SHA} Subject\n${diff}`,
          `${SHOW_SHA.slice(0, 8)} (Subject, 2026-07-20)\n${diff}`,
        ];

        for (const shown of views) {
          const model = parseDiff(shown)!;
          const { edit } = buildDiffDocument(shown, model, ws);
          diffSource(ws, edit, undefined, git);
        }

        expect(ownershipChecks).toBe(0);
      } finally {
        done();
      }
    });

    it("keeps historical hunk ownership across consecutive compact commits", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "f.txt");
        Deno.writeTextFileSync(path, "before\n");
        runGit(root, ["add", "f.txt"]);
        runGit(root, ["commit", "-q", "-m", "base"]);
        Deno.writeTextFileSync(path, "after\n");
        runGit(root, ["commit", "-qam", "parent with patch"]);
        runGit(root, ["commit", "-q", "--allow-empty", "-m", "empty HEAD"]);
        const head = runGit(root, ["rev-parse", "HEAD"]);
        const shown = runGit(root, [
          "log",
          "-2",
          "--pretty=oneline",
          "-p",
          "--no-ext-diff",
          "--no-color",
        ]);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { edit } = buildDiffDocument(shown, model, ws);
        const source = diffSource(ws, edit, undefined, realGit(root));

        expect(saveSource(
          source,
          shown.replace("+after\n", "+workspace edit\n"),
          shown,
        )).toBe("Saved 1 file");
        expect(runGit(root, ["rev-parse", "HEAD"])).toBe(head);
        expect(Deno.readTextFileSync(path)).toBe("workspace edit\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps historical hunk ownership across consecutive email commits", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "f.txt");
        Deno.writeTextFileSync(path, "before\n");
        runGit(root, ["add", "f.txt"]);
        runGit(root, ["commit", "-q", "-m", "base"]);
        Deno.writeTextFileSync(path, "after\n");
        runGit(root, ["commit", "-qam", "parent with patch"]);
        runGit(root, ["commit", "-q", "--allow-empty", "-m", "empty HEAD"]);
        const head = runGit(root, ["rev-parse", "HEAD"]);
        const shown = runGit(root, [
          "log",
          "-2",
          "--pretty=email",
          "-p",
          "--no-ext-diff",
          "--no-color",
        ]);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { edit } = buildDiffDocument(shown, model, ws);
        const source = diffSource(ws, edit, undefined, realGit(root));

        expect(saveSource(
          source,
          shown.replace("+after\n", "+workspace edit\n"),
          shown,
        )).toBe("Saved 1 file");
        expect(runGit(root, ["rev-parse", "HEAD"])).toBe(head);
        expect(Deno.readTextFileSync(path)).toBe("workspace edit\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps an LF-normalized message from a CRLF commit preamble", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "f.txt");
        Deno.writeTextFileSync(path, "before\n");
        runGit(root, ["add", "f.txt"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        Deno.writeTextFileSync(path, "after\n");
        runGit(root, ["commit", "-qam", "subject", "-m", "body"]);

        const shownLf = runGit(root, [
          "show",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);
        const diffStart = shownLf.indexOf("diff --git ");
        expect(diffStart, "git show contains a file diff")
          .toBeGreaterThanOrEqual(0);
        const shown = shownLf.slice(0, diffStart).replaceAll("\n", "\r\n") +
          shownLf.slice(diffStart);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { edit } = buildDiffDocument(shown, model, ws);
        const source = diffSource(ws, edit, undefined, realGit(root));
        const edited = shown.replace("+after\n", "+after edited\n");

        expect(saveSource(source, edited, shown)).toBe(
          "Saved 1 file; Amended the commit",
        );
        const rawCommit = runGit(root, ["cat-file", "commit", "HEAD"]);
        expect(rawCommit.slice(rawCommit.indexOf("\n\n") + 2)).toBe(
          "subject\n\nbody\n",
        );
        expect(Deno.readTextFileSync(path)).toBe("after edited\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it({
      name: "saves a commit view through clean and textconv filters",
      ignore: Deno.build.os === "windows",
      fn() {
        const root = Deno.makeTempDirSync();
        try {
          runGit(root, ["init", "-q"]);
          runGit(root, ["config", "user.email", "t@t.test"]);
          runGit(root, ["config", "user.name", "Test"]);
          runGit(root, [
            "config",
            "filter.caps.clean",
            "tr '[:lower:]' '[:upper:]'",
          ]);
          runGit(root, [
            "config",
            "filter.caps.smudge",
            "tr '[:upper:]' '[:lower:]'",
          ]);
          const textconv = join(root, ".git", "lower-textconv.sh");
          Deno.writeTextFileSync(
            textconv,
            "#!/bin/sh\ntr '[:upper:]' '[:lower:]' < \"$1\"\n",
          );
          Deno.chmodSync(textconv, 0o755);
          runGit(root, ["config", "diff.lower.textconv", textconv]);
          Deno.writeTextFileSync(
            join(root, ".gitattributes"),
            "*.dat filter=caps diff=lower\n",
          );
          const path = join(root, "f.dat");
          Deno.writeTextFileSync(path, "old\n");
          runGit(root, ["add", ".gitattributes", "f.dat"]);
          runGit(root, ["commit", "-q", "-m", "parent"]);
          Deno.writeTextFileSync(path, "new\n");
          runGit(root, ["commit", "-qam", "head"]);

          const shown = runGit(root, [
            "show",
            "--no-ext-diff",
            "--no-color",
            "HEAD",
          ]);
          const ws = stubWs(root);
          const model = parseDiff(shown)!;
          const { doc, edit } = buildDiffDocument(shown, model, ws);
          const s = new Session(
            doc,
            { color: false, showLineNumbers: false },
            { width: 80, height: 20 },
            undefined,
            diffSource(ws, edit, undefined, realGit(root)),
          );
          const line = s.doc.lines.findIndex((entry) => entry.text === "+new");
          expect(line, "textconv exposes the filtered added line")
            .toBeGreaterThanOrEqual(0);
          toLine(s, line);
          press(s, "end");
          press(s, "backspace", "backspace", "backspace");
          type(s, "pager");
          press(s, "f3");
          press(s, "a");

          expect(s.view().message).toBe("Saved 1 file; Amended the commit");
          expect(runGit(root, ["show", "HEAD:f.dat"])).toBe("PAGER\n");
          expect(runGit(root, ["show", ":f.dat"])).toBe("PAGER\n");
          expect(Deno.readTextFileSync(path)).toBe("pager\n");
          expect(runGit(root, ["status", "--porcelain"])).toBe("");
        } finally {
          Deno.removeSync(root, { recursive: true });
        }
      },
    });

    it("amends an empty-message commit when its hunk changes", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        Deno.writeTextFileSync(path, "before\n");
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        Deno.writeTextFileSync(path, "after\n");
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "--allow-empty-message", "-m", ""]);

        const shown = runGit(root, [
          "show",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 20 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        const line = s.doc.lines.findIndex((entry) => entry.text === "+after");
        expect(line, "git show contains the added line").toBeGreaterThanOrEqual(
          0,
        );
        toLine(s, line);
        press(s, "end");
        type(s, " amended");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        press(s, "a");

        expect(s.view().message).toBe("Saved 1 file; Amended the commit");
        expect(runGit(root, ["show", "HEAD:m.ts"])).toBe("after amended\n");
        expect(runGit(root, ["log", "-1", "--format=%B"])).toBe("\n");
        expect(runGit(root, ["status", "--porcelain"])).toBe("");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("retains earlier amendments in the same file across later hunk saves", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        const parent = Array.from(
          { length: 16 },
          (_, index) => `line ${index + 1}`,
        );
        Deno.writeTextFileSync(path, `${parent.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        const head = [...parent];
        head[1] = "line 2 committed";
        head[14] = "line 15 committed";
        Deno.writeTextFileSync(path, `${head.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "two hunks"]);

        const shown = runGit(root, [
          "show",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        expect(model.files[0].hunks.length, "git show has two hunks").toBe(2);
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 30 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        const first = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 2 committed"
        );
        expect(first, "git show contains the first hunk")
          .toBeGreaterThanOrEqual(0);
        toLine(s, first);
        press(s, "end", "enter");
        type(s, "inserted after first hunk line");
        press(s, "f3");
        press(s, "a");

        const second = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 15 committed"
        );
        expect(second, "git show contains the second hunk")
          .toBeGreaterThanOrEqual(0);
        toLine(s, second);
        press(s, "end");
        type(s, " second save");
        press(s, "f3");
        press(s, "a");

        const committed = runGit(root, ["show", "HEAD:m.ts"]);
        expect(committed).toContain(
          "line 2 committed\ninserted after first hunk line\nline 3\n",
        );
        expect(committed).toContain("line 15 committed second save\n");
        expect(runGit(root, ["status", "--porcelain"])).toBe("");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("leaves a matching historical hunk alone when a HEAD hunk is edited", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        const parent = Array.from(
          { length: 12 },
          (_, index) => `line ${index + 1}`,
        );
        Deno.writeTextFileSync(path, `${parent.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);

        const historical = [...parent];
        historical[9] = "line 10 historical";
        Deno.writeTextFileSync(path, `${historical.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "historical line"]);

        const current = [...historical];
        current[9] = "line 10 current";
        Deno.writeTextFileSync(path, `${current.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "current line"]);

        const head = [...current];
        head[2] = "line 3 head";
        Deno.writeTextFileSync(path, `${head.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "head line"]);
        const shown = runGit(root, [
          "log",
          "-p",
          "-3",
          "--no-ext-diff",
          "--no-color",
        ]);

        const workspace = [...head];
        workspace[9] = "line 10 historical";
        Deno.writeTextFileSync(path, `${workspace.join("\n")}\n`);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 40 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        const line = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 3 head"
        );
        expect(line, "git log contains the HEAD hunk").toBeGreaterThanOrEqual(
          0,
        );
        toLine(s, line);
        press(s, "end");
        type(s, " amended");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        press(s, "a");
        expect(s.view().message).toBe("Saved 1 file; Amended the commit");

        const amendedHead = [...head];
        amendedHead[2] = "line 3 head amended";
        const amendedWorkspace = [...workspace];
        amendedWorkspace[2] = "line 3 head amended";
        expect(
          runGit(root, ["show", "HEAD:m.ts"]),
          "the amended commit keeps the current version of the historical line",
        ).toBe(`${amendedHead.join("\n")}\n`);
        expect(
          Deno.readTextFileSync(path),
          "the unrelated worktree version of the historical line remains",
        ).toBe(`${amendedWorkspace.join("\n")}\n`);
        expect(runGit(root, ["status", "--porcelain"])).toBe(" M m.ts\n");

        const amendedSha = runGit(root, ["rev-parse", "HEAD"]);
        const historicalLine = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 10 historical"
        );
        expect(historicalLine, "git log contains the older writable hunk")
          .toBeGreaterThan(line);
        toLine(s, historicalLine);
        press(s, "end");
        type(s, " workspace edit");
        press(s, "f3");

        amendedWorkspace[9] = "line 10 historical workspace edit";
        expect(s.view().dialog, "an older commit does not prompt amend")
          .toBeNull();
        expect(s.view().message).toBe("Saved 1 file");
        expect(
          runGit(root, ["rev-parse", "HEAD"]),
          "editing an older commit's hunk does not move HEAD",
        ).toBe(amendedSha);
        expect(Deno.readTextFileSync(path)).toBe(
          `${amendedWorkspace.join("\n")}\n`,
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps a later HEAD amend in place after a historical insertion", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        const base = Array.from(
          { length: 14 },
          (_, index) => `line ${index + 1}`,
        );
        Deno.writeTextFileSync(path, `${base.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "base"]);

        const historical = [...base];
        historical[1] = "line 2 historical";
        Deno.writeTextFileSync(path, `${historical.join("\n")}\n`);
        runGit(root, ["commit", "-qam", "historical"]);

        const head = [...historical];
        head[11] = "line 12 head";
        Deno.writeTextFileSync(path, `${head.join("\n")}\n`);
        runGit(root, ["commit", "-qam", "head"]);
        const shown = runGit(root, [
          "log",
          "-p",
          "-2",
          "-U0",
          "--no-ext-diff",
          "--no-color",
        ]);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 30 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );

        const older = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 2 historical"
        );
        expect(older, "git log contains the historical hunk")
          .toBeGreaterThanOrEqual(0);
        toLine(s, older);
        press(s, "end", "enter");
        type(s, "historical workspace insertion");
        press(s, "f3");
        expect(s.view().dialog, "the historical edit does not amend")
          .toBeNull();
        expect(s.view().message).toBe("Saved 1 file");

        const headLine = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 12 head"
        );
        expect(headLine, "git log contains the HEAD hunk")
          .toBeGreaterThanOrEqual(0);
        toLine(s, headLine);
        press(s, "end");
        type(s, " amended");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        press(s, "a");
        expect(s.view().message).toBe("Saved 1 file; Amended the commit");

        const amendedHead = [...head];
        amendedHead[11] = "line 12 head amended";
        expect(runGit(root, ["show", "HEAD:m.ts"])).toBe(
          `${amendedHead.join("\n")}\n`,
        );
        const workspace = [...amendedHead];
        workspace.splice(2, 0, "historical workspace insertion");
        expect(Deno.readTextFileSync(path)).toBe(`${workspace.join("\n")}\n`);
        expect(runGit(root, ["status", "--porcelain"])).toBe(" M m.ts\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("keeps expanded workspace context outside the amended commit", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        const base = Array.from(
          { length: 12 },
          (_, index) => `line ${index + 1}`,
        );
        Deno.writeTextFileSync(path, `${base.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "base"]);

        const head = [...base];
        head[9] = "line 10 head";
        Deno.writeTextFileSync(path, `${head.join("\n")}\n`);
        runGit(root, ["commit", "-qam", "head"]);
        const shown = runGit(root, [
          "show",
          "-U0",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);

        const workspace = [...head];
        workspace[8] = "line 9 unstaged";
        Deno.writeTextFileSync(path, `${workspace.join("\n")}\n`);
        const ws = stubWs(root);
        const model = parseDiff(shown)!;
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 30 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        const line = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 10 head"
        );
        expect(line, "git show contains the HEAD hunk").toBeGreaterThanOrEqual(
          0,
        );
        const header = s.doc.lines.findLastIndex((entry, index) =>
          index < line && entry.text.startsWith("@@ ")
        );
        expect(header, "git show contains the HEAD hunk header")
          .toBeGreaterThanOrEqual(0);
        toLine(s, header);
        press(s, "ctrl-l");
        assert(
          s.doc.lines.some((entry) => entry.text === " line 9 unstaged"),
          `expansion reveals the unstaged workspace line:\n${s.doc.text}`,
        );
        const expandedLine = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 10 head"
        );
        toLine(s, expandedLine);
        press(s, "end");
        type(s, " amended");
        expect(s.doc.text).toContain("+line 10 head amended");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        press(s, "a");
        expect(s.view().message).toBe("Saved 1 file; Amended the commit");

        const amendedHead = [...head];
        amendedHead[9] = "line 10 head amended";
        expect(
          runGit(root, ["show", "HEAD:m.ts"]),
          "the expanded unstaged line is absent from the commit",
        ).toBe(`${amendedHead.join("\n")}\n`);
        workspace[9] = "line 10 head amended";
        expect(Deno.readTextFileSync(path)).toBe(`${workspace.join("\n")}\n`);
        expect(runGit(root, ["status", "--porcelain"])).toBe(" M m.ts\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("excludes unrelated same-file edits from an amend and preserves their staged state", () => {
      const root = Deno.makeTempDirSync();
      try {
        runGit(root, ["init", "-q"]);
        runGit(root, ["config", "user.email", "t@t.test"]);
        runGit(root, ["config", "user.name", "Test"]);
        const path = join(root, "m.ts");
        const parentLines = Array.from(
          { length: 12 },
          (_, i) => `line ${i + 1}`,
        );
        const commitLines = [...parentLines];
        commitLines[5] = "line 6 committed";
        Deno.writeTextFileSync(path, `${parentLines.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "parent"]);
        Deno.writeTextFileSync(path, `${commitLines.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        runGit(root, ["commit", "-q", "-m", "commit view"]);
        const shown = runGit(root, [
          "show",
          "--no-ext-diff",
          "--no-color",
          "HEAD",
        ]);

        const indexLines = [...commitLines];
        indexLines[3] = "line 4 staged";
        Deno.writeTextFileSync(path, `${indexLines.join("\n")}\n`);
        runGit(root, ["add", "m.ts"]);
        const workspaceLines = [...commitLines];
        workspaceLines[11] = "line 12 unstaged";
        Deno.writeTextFileSync(path, `${workspaceLines.join("\n")}\n`);

        const ws: DiffWorkspace = {
          resolve: (relative) => join(root, relative),
          read: (absolute) => {
            try {
              return Deno.readTextFileSync(absolute);
            } catch {
              return null;
            }
          },
        };
        const model = parseDiff(shown)!;
        const { doc, edit } = buildDiffDocument(shown, model, ws);
        const s = new Session(
          doc,
          { color: false, showLineNumbers: false },
          { width: 80, height: 30 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        const line = s.doc.lines.findIndex((entry) =>
          entry.text === "+line 6 committed"
        );
        expect(line, "git show contains the committed line")
          .toBeGreaterThanOrEqual(0);
        toLine(s, line);
        press(s, "end");
        type(s, " EDIT");
        press(s, "f3");
        press(s, "a");

        const amendedCommit = [...commitLines];
        amendedCommit[5] = "line 6 committed EDIT";
        const amendedIndex = [...indexLines];
        amendedIndex[5] = "line 6 committed EDIT";
        const amendedWorkspace = [...workspaceLines];
        amendedWorkspace[5] = "line 6 committed EDIT";
        expect(runGit(root, ["show", "HEAD:m.ts"])).toBe(
          `${amendedCommit.join("\n")}\n`,
        );
        expect(runGit(root, ["show", ":m.ts"])).toBe(
          `${amendedIndex.join("\n")}\n`,
        );
        expect(Deno.readTextFileSync(path)).toBe(
          `${amendedWorkspace.join("\n")}\n`,
        );
        expect(runGit(root, ["status", "--porcelain"])).toBe("MM m.ts\n");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("confirms the save, then the amend, then quits when quitting with an edited message", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4);
        press(s, "end");
        type(s, " Q");
        press(s, "escape"); // hide the cursor, back to pager mode
        press(s, "q"); // quit → the dirty save prompt
        expect(promptText(s.view())).toContain("Save changes");
        // → the amend prompt (the save-prompt handler stands aside).
        press(s, "s");
        expect(promptText(s.view())).toContain("Amend commit");
        assert(!s.quit, "not quit until the amend is confirmed");
        press(s, "a"); // confirm the amend → save, amend, and quit
        assert(s.quit, "quits after the amend");
        assert(
          fg.amended()?.startsWith("Subject line of the commit Q"),
          fg.amended() ?? "(none)",
        );
      } finally {
        done();
      }
    });

    it("refuses a message edit with no git runner", () => {
      const { ws, done } = tempWorkspace();
      try {
        const s = diffSessionFrom(ws, GIT_SHOW); // no git
        toLine(s, 4);
        const before = s.doc.text;
        type(s, "X");
        expect(s.doc.text, "no git means no message editing").toBe(before);
      } finally {
        done();
      }
    });

    it("refuses to amend an all-blank commit message", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        // Blank both content lines of the message (leaving the four-space
        // indents).
        for (const row of [4, 6]) {
          toLine(s, row);
          press(s, "ctrl-a"); // line start
          press(s, "ctrl-k"); // kill to end (nudged past the indent)
        }
        press(s, "f3");
        assert(s.view().dialog, "the files-only alternative remains available");
        press(s, "a");
        expect(s.view().message).toContain("would be empty");
        expect(fg.amended(), "an empty message is never amended").toBeNull();
        assert(s.view().dialog == null, "no prompt is left open");
      } finally {
        done();
      }
    });

    it("refuses to amend when every commit-message line is deleted", () => {
      const { root, ws, done } = tempWorkspace();
      const before = Deno.readTextFileSync(join(root, "m.ts"));
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        // Remove the three message lines: blank each one, then Backspace at its
        // start takes the line away. Each removal leaves the cursor on the line
        // above, so the next message line is again at row 4.
        for (let i = 0; i < 3; i++) {
          toLine(s, 4);
          press(s, "ctrl-a");
          press(s, "ctrl-k");
          press(s, "backspace");
        }
        expect(s.doc.lines[4].text, "no message lines are left").toBe("");
        press(s, "f3");
        assert(s.view().dialog, "the files-only alternative remains available");
        press(s, "a");
        expect(s.view().message).toContain("would be empty");
        expect(fg.amended(), "the commit was not amended").toBeNull();
        expect(s.view().dialog, "no prompt is left open").toBeNull();
        expect(
          Deno.readTextFileSync(join(root, "m.ts")),
          "the refused save wrote no file",
        ).toBe(before);
      } finally {
        done();
      }
    });

    it("accepts and amends an edit to a SHA-256 repository's commit message", () => {
      const { ws, done } = tempWorkspace();
      const sha256 = "0".repeat(24) + SHOW_SHA; // a 64-character object id
      const fg = fakeGit(sha256);
      try {
        const s = diffSessionFrom(
          ws,
          GIT_SHOW.replace(SHOW_SHA, sha256),
          20,
          fg.git,
        );
        toLine(s, 4);
        press(s, "end");
        type(s, " EDIT");
        expect(s.doc.lines[4].text).toBe("    Subject line of the commit EDIT");
        press(s, "f3");
        expect(promptText(s.view())).toContain("Amend commit");
        press(s, "a");
        expect(fg.amended()).toBe(
          "Subject line of the commit EDIT\n\nA body paragraph of the message.",
        );
      } finally {
        done();
      }
    });

    it("amends nothing and writes no file when HEAD moved since the diff was shown", () => {
      const { root, ws, done } = tempWorkspace();
      const before = Deno.readTextFileSync(join(root, "m.ts"));
      const fg = movingGit(
        SHOW_SHA,
        "ffffffffffffffffffffffffffffffffffffffff",
      );
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4);
        press(s, "end");
        type(s, " X");
        press(s, "f3"); // editability used the cached (original) HEAD
        press(s, "a"); // the amend re-reads HEAD, sees it moved, and refuses
        expect(fg.amended(), "no amend when HEAD moved").toBeNull();
        expect(s.view().message).toContain("HEAD has moved");
        // The amend runs before the file write, so a refusal leaves files
        // untouched.
        expect(Deno.readTextFileSync(join(root, "m.ts")), "no file written")
          .toBe(before);
      } finally {
        done();
      }
    });

    it("names the message, not files, when quitting after a message-only edit", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
        toLine(s, 4);
        press(s, "end");
        type(s, " Z");
        press(s, "escape"); // back to pager mode
        press(s, "q"); // quit → the dirty save prompt
        const prompt = promptText(s.view());
        expect(prompt).toContain("the commit message");
        assert(!/\bfiles?\b/.test(prompt), `should not name files: ${prompt}`);
      } finally {
        done();
      }
    });
  });

  describe("the revert prompt", () => {
    /** Move the text cursor to `line` (up or down), in edit mode. */
    function moveCursorTo(s: Session, line: number): void {
      let guard = 0;
      while ((s.view().cursor?.line ?? line) < line && guard++ < 2000) {
        press(s, "down");
      }
      while ((s.view().cursor?.line ?? line) > line && guard++ < 2000) {
        press(s, "up");
      }
    }

    it("offers hunk and file, not message, in a hunk", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
        toLine(s, 17); // an added hunk line
        press(s, "end");
        type(s, " X");
        press(s, "ctrl-r");
        const p = promptText(s.view());
        expect(p).toContain("Hunk");
        expect(p).toContain("File");
        expect(p).not.toContain("Message");
        expect(p).toContain("All");
      } finally {
        done();
      }
    });

    it("does nothing on Enter, having no default button", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
        toLine(s, 17);
        press(s, "end");
        type(s, " X");
        const dirty = s.doc.text;
        press(s, "ctrl-r");
        press(s, "enter"); // no default -> a no-op, the dialog stays up
        expect(promptText(s.view()), "dialog still open").toContain("Hunk");
        expect(s.view().message, "not cancelled").toBe("");
        expect(s.doc.text, "nothing reverted").toBe(dirty);
        // A scope key still works afterwards.
        press(s, "a");
        expect(s.doc.text, "all reverted after Enter no-op").not.toContain(
          " X",
        );
      } finally {
        done();
      }
    });

    it("focuses the first scope on Tab and the last button on Shift-Tab, with no default button", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
        toLine(s, 17);
        press(s, "end");
        type(s, " X");

        press(s, "ctrl-r");
        expect(s.view().dialog?.focus, "no button is focused without a default")
          .toBe(-1);
        const n = s.view().dialog!.buttons.length;

        // From no focus, Tab lands on the first button (a scope).
        press(s, "tab");
        expect(s.view().dialog?.focus, "Tab focused the first scope").toBe(0);
        press(s, "escape"); // close it via Cancel

        // Reopen and go the other way: Shift-Tab from no focus lands on the
        // last, which is Cancel; Enter then activates it.
        press(s, "ctrl-r");
        press(s, "shift-tab");
        expect(s.view().dialog?.focus, "Shift-Tab focused the last button")
          .toBe(n - 1);
        press(s, "enter");
        expect(s.view().message).toBe("Cancelled");
      } finally {
        done();
      }
    });

    it("offers file but not hunk on a file header", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
        toLine(s, 17);
        press(s, "end");
        type(s, " X"); // make the buffer dirty
        // The "diff --git" header line — in the file, in no hunk.
        moveCursorTo(s, 8);
        press(s, "ctrl-r");
        const p = promptText(s.view());
        expect(p).toContain("File");
        expect(p).not.toContain("Hunk");
        expect(p).not.toContain("Message");
      } finally {
        done();
      }
    });

    it("offers only all in the commit preamble", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
        toLine(s, 17);
        press(s, "end");
        type(s, " X");
        // The "commit …" line — no file, no hunk, no message.
        moveCursorTo(s, 0);
        press(s, "ctrl-r");
        const p = promptText(s.view());
        expect(p).toContain("All");
        expect(p).not.toContain("Hunk");
        expect(p).not.toContain("File");
        expect(p).not.toContain("Message");
      } finally {
        done();
      }
    });

    it("offers message in the commit message, and restores it on `m`", () => {
      const { ws, done } = tempWorkspace();
      const fg = fakeGit(SHOW_SHA);
      try {
        const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
        // Edit both a hunk line and the message subject.
        toLine(s, 17);
        press(s, "end");
        type(s, " HUNK");
        moveCursorTo(s, 4);
        press(s, "end");
        type(s, " EDIT");
        expect(s.doc.lines[4].text).toBe("    Subject line of the commit EDIT");
        press(s, "ctrl-r");
        const p = promptText(s.view());
        expect(p).toContain("Message");
        expect(p).not.toContain("Hunk");
        expect(p).not.toContain("File");
        press(s, "m"); // revert only the message
        expect(s.doc.lines[4].text, "the message is restored").toBe(
          "    Subject line of the commit",
        );
        expect(
          s.doc.lines[17].text,
          "the hunk edit is kept: " + s.doc.lines[17].text,
        ).toContain("HUNK");
        expect(s.view().message).toContain("Reverted the message");
      } finally {
        done();
      }
    });
  });
});
