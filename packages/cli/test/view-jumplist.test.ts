/**
 * The jump list (`i`): a dialog over a diff view listing the files it touches
 * and any commit messages it carries, with Enter jumping the viewport to the
 * chosen one. A read-only diff (its files do not resolve on disk) is enough —
 * the list is derived from the diff text itself.
 */

import { assert, assertEquals } from "@std/assert";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { parseDocument } from "../lib/view/languages/typescript/parse.ts";
import type { Line } from "../lib/view/model.ts";
import { Session } from "../lib/view/session.ts";

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

/** A diff session over `diffText` whose files do not resolve on disk (read-only,
 * but still a diff, so the jump list is offered). */
function diffSession(diffText: string, height = 20): Session {
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const model = parseDiff(diffText)!;
  const { doc, edit } = buildDiffDocument(diffText, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit),
  );
}

function diffSessionWithFile(
  diffText: string,
  path: string,
  fileText: string,
): Session {
  const ws: DiffWorkspace = {
    resolve: (candidate) => candidate === path ? path : null,
    read: (candidate) => candidate === path ? fileText : null,
  };
  const model = parseDiff(diffText)!;
  const { doc, edit } = buildDiffDocument(diffText, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    diffSource(ws, edit),
  );
}

/** Selectable rows before the jump list's summary. */
function entryLines(s: Session): readonly Line[] {
  const lines = s.view().overlay?.lines ?? [];
  const summary = lines.findIndex((line) => line.text === "");
  return summary < 0 ? lines : lines.slice(0, summary);
}

/** Plain text of the selectable jump-list rows. */
function entryText(s: Session): string[] {
  return entryLines(s).map((line) => line.text);
}

/** Plain text of the count-policy and count-total rows. */
function summaryText(s: Session): string[] {
  const lines = s.view().overlay?.lines.map((l) => l.text) ?? [];
  const summary = lines.indexOf("");
  return summary < 0 ? [] : lines.slice(summary + 1);
}

const TWO_FILES = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/src/app.test.ts b/src/app.test.ts",
  "index 3333333..4444444 100644",
  "--- a/src/app.test.ts",
  "+++ b/src/app.test.ts",
  "@@ -1 +1,2 @@",
  " x",
  "+added",
  "",
].join("\n");

// A `git show` of a single commit: the header, its indented message, then the
// diff. app.ts's header is line 6, its test file's line 14.
const SHOW = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: Someone <someone@example.com>",
  "Date:   Mon Jul 21 12:00:00 2026 +0000",
  "",
  "    Fix the widget alignment",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/src/app.test.ts b/src/app.test.ts",
  "index 3333333..4444444 100644",
  "--- a/src/app.test.ts",
  "+++ b/src/app.test.ts",
  "@@ -1 +1,2 @@",
  " x",
  "+added",
  "",
].join("\n");

Deno.test("jumplist: i lists the diff's files, dirs summarized", () => {
  const s = diffSession(TWO_FILES);
  press(s, "i");
  assertEquals(entryText(s), [
    "   ▸ src/app.ts  +1 −1",
    " T ▸ src/app.test.ts  +1 −0",
  ]);
  assertEquals(s.view().inputLine, null);
  assertEquals(s.view().overlay?.title, "Jump to file or commit");
  assertEquals(s.view().overlay?.selectedLine, 0);
});

Deno.test("jumplist: new and deleted files color their applicable counts", () => {
  const s = diffSession(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "",
    ].join("\n"),
  );
  press(s, "i");

  const lines = s.view().overlay!.lines.slice(0, 2);
  assertEquals(lines.map((line) => line.text), [
    "   ▸ new.ts  +2 (new)",
    "   ▸ gone.ts  −2 (deleted)",
  ]);
  assertEquals(lines[0].spans.at(-1), {
    col: 13,
    text: "+2 (new)",
    cls: "diffAdd",
  });
  assertEquals(lines[1].spans.at(-1), {
    col: 14,
    text: "−2 (deleted)",
    cls: "diffDel",
  });
});

Deno.test("jumplist: a git show lists the commit message before its files", () => {
  const s = diffSession(SHOW);
  press(s, "i");
  assertEquals(entryText(s), [
    "● commit 012345678  +2 −1  Fix the widget alignment",
    "   ▸ src/app.ts  +1 −1",
    " T ▸ src/app.test.ts  +1 −0",
  ]);
});

Deno.test("jumplist: enter on a file jumps the viewport to its header line", () => {
  // A short viewport, so the last file's header can reach the very top.
  const s = diffSession(SHOW, 6);
  press(s, "i");
  press(s, "down", "down"); // commit -> app.ts -> app.test.ts
  assertEquals(s.view().overlay?.selectedLine, 2);
  press(s, "enter");
  assertEquals(s.view().overlay, null, "list closed");
  assertEquals(s.view().top, 14, "app.test.ts header is line 14");
  assert(s.view().message.includes("src/app.test.ts"));
});

Deno.test("jumplist: enter on the commit entry jumps to the commit header", () => {
  const s = diffSession(SHOW, 8);
  press(s, "G"); // scroll to the bottom, away from the commit
  assert(s.view().top > 0);
  press(s, "i");
  press(s, "up", "up", "up", "up"); // climb back to the commit entry (index 0)
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "enter");
  assertEquals(s.view().top, 0, "the commit header is line 0");
  assert(s.view().message.includes("commit 012345678"));
});

Deno.test("jumplist: pagedown and pageup jump the selection to the ends", () => {
  const s = diffSession(LOG);
  press(s, "i");
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "pagedown");
  assertEquals(s.view().overlay?.selectedLine, 3, "clamped to the last entry");
  press(s, "pageup");
  assertEquals(s.view().overlay?.selectedLine, 0, "clamped to the first entry");
});

Deno.test("jumplist: the mouse wheel moves three entries", () => {
  const s = diffSession(LOG);
  press(s, "i");
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "wheel-down");
  assertEquals(s.view().overlay?.selectedLine, 3);
  press(s, "wheel-up");
  assertEquals(s.view().overlay?.selectedLine, 0);
});

Deno.test("jumplist: space pages the selection down", () => {
  const s = diffSession(LOG);
  press(s, "i");
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "space");
  assertEquals(s.view().overlay?.selectedLine, 3, "clamped to the last entry");
});

Deno.test("jumplist: selecting the last entry reveals the summary", () => {
  const s = diffSession(CATEGORY_FILES, 12);
  press(s, "i", "pagedown");
  const overlay = s.view().overlay!;
  assertEquals(overlay.selectedLine, 3);
  assertEquals(overlay.scroll, 1);
  assertEquals(overlay.lines.slice(-2).map((line) => line.text), [
    "Counts: normal",
    "All files +4 −4 · Shown files +4 −4",
  ]);
});

Deno.test("jumplist: a one-row overlay can reveal the summary total", () => {
  const s = diffSession(TWO_FILES, 7);
  press(s, "i", "pagedown");
  const overlay = s.view().overlay!;
  assertEquals(overlay.selectedLine, 1);
  assertEquals(overlay.scroll, 4);
  assertEquals(
    overlay.lines[overlay.scroll].text,
    "All files +2 −1 · Shown files +2 −1",
  );
});

Deno.test("jumplist: tab jumps the same as enter", () => {
  const s = diffSession(SHOW, 6);
  press(s, "i", "down"); // preselected commit -> src/app.ts
  press(s, "tab");
  assertEquals(s.view().overlay, null, "list closed");
  assertEquals(s.view().message, "Jumped to src/app.ts");
});

Deno.test("jumplist: typing filters the list", () => {
  const s = diffSession(SHOW);
  press(s, "i", "/");
  type(s, "test");
  assertEquals(entryText(s), [" T ▸ src/app.test.ts  +1 −0"]);
  assertEquals(s.view().inputLine, "jump to: test");
  // Backspacing widens it again.
  press(s, "backspace", "backspace", "backspace", "backspace");
  assertEquals(entryText(s).length, 3);
});

Deno.test("jumplist: a filter matching the commit subject keeps the commit", () => {
  const s = diffSession(SHOW);
  press(s, "i", "/");
  type(s, "widget");
  assertEquals(entryText(s), [
    "● commit 012345678  +2 −1  Fix the widget alignment",
  ]);
});

Deno.test("jumplist: spaces are entered in a filter", () => {
  const s = diffSession(SHOW);
  press(s, "i", "/");
  type(s, "widget");
  s.handleKey({ name: "space", char: " " });
  type(s, "alignment");
  assertEquals(entryText(s), [
    "● commit 012345678  +2 −1  Fix the widget alignment",
  ]);
  assertEquals(s.view().inputLine, "jump to: widget alignment");
});

Deno.test("jumplist: q is entered in a filter", () => {
  const s = diffSession(SHOW);
  press(s, "i", "/", "q");
  assertEquals(s.view().inputLine, "jump to: q");
  assert(s.view().overlay !== null, "list remains open");
});

Deno.test("jumplist: enter with no match leaves the list open", () => {
  const s = diffSession(SHOW);
  press(s, "down", "down"); // scroll off the top so "unmoved" is meaningful
  const top = s.view().top;
  assert(top > 0);
  press(s, "i", "/");
  type(s, "zzz");
  assertEquals(entryText(s), ["(no matches)"]);
  press(s, "enter");
  assert(s.view().overlay !== null, "still open");
  assertEquals(s.view().top, top, "viewport unmoved");
});

Deno.test("jumplist: escape leaves filtering before it closes the list", () => {
  const s = diffSession(SHOW);
  press(s, "i", "/");
  type(s, "test");
  press(s, "escape");
  assertEquals(s.view().inputLine, null);
  assertEquals(entryText(s).length, 3);
  assert(s.view().overlay !== null, "list remains open");
  press(s, "escape");
  assertEquals(s.view().overlay, null);
});

Deno.test("jumplist: file visibility keys remain active while browsing", () => {
  const s = diffSession(TWO_FILES);
  press(s, "i", "T");
  assert(entryText(s)[1].startsWith(" T ▸ src/app.test.ts"));
  assert(
    s.view().overlay!.lines[1].spans.every((span) => span.cls === "comment"),
  );

  press(s, "down", "f");
  assert(
    s.view().overlay!.lines[1].spans.some((span) => span.cls !== "comment"),
  );
  press(s, "F");
  assert(
    s.view().overlay!.lines.slice(0, 2).every((line) =>
      line.spans.every((span) => span.cls === "comment")
    ),
  );
  press(s, "E");
  assert(
    s.view().overlay!.lines.slice(0, 2).every((line) =>
      line.spans.some((span) => span.cls !== "comment")
    ),
  );
});

Deno.test("jumplist: the summary reports all and shown file counts", () => {
  const s = diffSession(TWO_FILES);
  press(s, "i");
  assertEquals(summaryText(s), [
    "Counts: normal",
    "All files +2 −1 · Shown files +2 −1",
  ]);
  press(s, "T");
  assertEquals(summaryText(s), [
    "Counts: normal",
    "All files +2 −1 · Shown files +1 −1",
  ]);
});

Deno.test("jumplist: D cycles the diff-count policy", () => {
  const s = diffSession(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-run(); // before",
      "+ run ( ) ; // after",
      "",
    ].join("\n"),
  );
  press(s, "i");
  assert(entryText(s)[0].endsWith("+1 −1"));
  press(s, "D");
  assertEquals(summaryText(s)[0], "Counts: ignore whitespace-only changes");
  assert(entryText(s)[0].endsWith("+1 −1"));
  press(s, "D");
  assertEquals(summaryText(s), [
    "Counts: ignore comments and whitespace",
    "All files +0 −0 · Shown files +0 −0",
  ]);
  assert(entryText(s)[0].endsWith("+0 −0"));
  press(s, "D");
  assertEquals(summaryText(s)[0], "Counts: normal");
});

Deno.test("jumplist: counts use syntax before the first hunk", () => {
  const diff = [
    "diff --git a/main.rs b/main.rs",
    "--- a/main.rs",
    "+++ b/main.rs",
    "@@ -3 +3 @@",
    "- * old note",
    "+ * new note",
    "",
  ].join("\n");
  const s = diffSessionWithFile(
    diff,
    "main.rs",
    ["/*", " * hidden note", " * new note", " */", ""].join("\n"),
  );
  press(s, "i", "D", "D");

  assertEquals(summaryText(s), [
    "Counts: ignore comments and whitespace",
    "All files +0 −0 · Shown files +0 −0",
  ]);
});

Deno.test("jumplist: complete count context rebuilds after an edit", () => {
  const diff = [
    "diff --git a/main.rs b/main.rs",
    "--- a/main.rs",
    "+++ b/main.rs",
    "@@ -3 +3 @@",
    "- * old note",
    "+ * new note",
    "",
  ].join("\n");
  const ws: DiffWorkspace = {
    resolve: (path) => path === "main.rs" ? path : null,
    read: (path) =>
      path === "main.rs"
        ? ["/*", " * hidden note", " * new note", " */", ""].join("\n")
        : null,
  };
  const model = parseDiff(diff)!;
  const { edit } = buildDiffDocument(diff, model, ws);
  const source = diffSource(ws, edit);

  const initial = source.diffCountContexts?.(diff);
  assert(initial !== undefined);
  assert(source.diffCountContexts?.(diff) === initial);
  const edited = diff.replace("+ * new note", "+ * newer note");
  const context = source.diffCountContexts?.(edited);
  assert(context !== undefined);
  assertEquals(context[0].newLines?.[2].text, " * newer note");
});

Deno.test("jumplist: complete count context retains final-newline changes", () => {
  const source = (diff: string, fileText: string) => {
    const ws: DiffWorkspace = {
      resolve: (path) => path === "main.rs" ? path : null,
      read: (path) => path === "main.rs" ? fileText : null,
    };
    const model = parseDiff(diff)!;
    const { edit } = buildDiffDocument(diff, model, ws);
    return diffSource(ws, edit);
  };
  const contexts = (diff: string, fileText: string) =>
    source(diff, fileText).diffCountContexts?.(diff)?.[0];
  const addsNewline = [
    "diff --git a/main.rs b/main.rs",
    "--- a/main.rs",
    "+++ b/main.rs",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "",
  ].join("\n");
  const removesNewline = [
    "diff --git a/main.rs b/main.rs",
    "--- a/main.rs",
    "+++ b/main.rs",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const createsWithNewline = [
    "diff --git a/main.rs b/main.rs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/main.rs",
    "@@ -0,0 +1 @@",
    "+value",
    "",
  ].join("\n");
  const deletesToEmpty = [
    "diff --git a/main.rs b/main.rs",
    "--- a/main.rs",
    "+++ b/main.rs",
    "@@ -1 +0,0 @@",
    "-old",
    "",
  ].join("\n");
  const crlfChange = [
    "diff --git a/main.rs b/main.rs\r",
    "--- a/main.rs\r",
    "+++ b/main.rs\r",
    "@@ -1 +1 @@\r",
    "-old\r",
    "+new\r",
    "",
  ].join("\n");

  assertEquals(
    contexts(addsNewline, "new\n")?.newLines?.map((line) => line.text),
    ["new", ""],
  );
  assertEquals(
    contexts(removesNewline, "new")?.newLines?.map((line) => line.text),
    ["new"],
  );
  assertEquals(
    contexts(createsWithNewline, "value\n")?.newLines?.map((line) => line.text),
    ["value", ""],
  );
  assertEquals(
    contexts(deletesToEmpty, "")?.newLines?.map((line) => line.text),
    [""],
  );
  assertEquals(
    contexts(crlfChange, "new\r\n")?.newLines?.map((line) => line.text),
    ["new", ""],
  );
  assertEquals(
    source(addsNewline, "new\n").diffCountContexts?.("not a diff"),
    [],
  );
});

Deno.test("jumplist: escape cancels and leaves the viewport put", () => {
  const s = diffSession(SHOW);
  press(s, "down"); // move the viewport off line 0
  const top = s.view().top;
  press(s, "i", "down", "down"); // open and move the selection
  press(s, "escape");
  assertEquals(s.view().overlay, null);
  assertEquals(s.view().message, "Cancelled");
  assertEquals(s.view().top, top, "the view did not move");
});

Deno.test("jumplist: q cancels and leaves the viewport put", () => {
  const s = diffSession(SHOW);
  press(s, "down");
  const top = s.view().top;
  press(s, "i", "down", "down", "q");
  assertEquals(s.view().overlay, null);
  assertEquals(s.view().message, "Cancelled");
  assertEquals(s.view().top, top, "the view did not move");
});

Deno.test("jumplist: opening preselects the file the viewport is on", () => {
  const s = diffSession(SHOW, 6);
  // Put app.test.ts's header (line 14) at the top of the viewport.
  press(s, "i", "down", "down", "enter");
  assertEquals(s.view().top, 14);
  press(s, "i");
  assertEquals(
    s.view().overlay?.selectedLine,
    2,
    "reopening lands on app.test.ts",
  );
});

// A `git log -p` of two commits, newest first, each with its own file.
const LOG = [
  "commit a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "Author: A <a@example.com>",
  "Date:   Mon Jul 21 13:00:00 2026 +0000",
  "",
  "    Second change",
  "",
  "diff --git a/b.ts b/b.ts",
  "index 3333333..4444444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1 @@",
  "-p",
  "+q",
  "commit b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "Author: B <b@example.com>",
  "Date:   Mon Jul 21 12:00:00 2026 +0000",
  "",
  "    First change",
  "",
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "",
].join("\n");

Deno.test("jumplist: git log -p interleaves each commit with its own files", () => {
  const s = diffSession(LOG);
  press(s, "i");
  assertEquals(entryText(s), [
    "● commit a1a1a1a1a  +1 −1  Second change",
    "   ▸ b.ts  +1 −1",
    "● commit b2b2b2b2b  +1 −1  First change",
    "   ▸ a.ts  +1 −1",
  ]);
});

Deno.test("jumplist: files stay listed and jumpable while collapsed", () => {
  const s = diffSession(SHOW, 6);
  press(s, "F"); // collapse every file to a summary line
  press(s, "i");
  assertEquals(entryText(s).length, 3, "commit and both files still listed");
  const fileLines = entryLines(s).slice(1);
  assert(
    fileLines.every((line) =>
      line.spans.every((span) => span.cls === "comment")
    ),
    "collapsed file rows are muted",
  );
  press(s, "down", "down", "enter"); // commit -> app.ts -> app.test.ts
  assert(s.view().message.includes("src/app.test.ts"));
  // The jump scrolls the collapsed file's summary row into the viewport.
  const rows = s.displayDoc().lines.map((l) => l.text);
  const summaryRow = rows.findIndex((t) => t.startsWith("▸ src/app.test.ts"));
  const top = s.view().top;
  assert(
    summaryRow >= top && summaryRow < top + 5,
    `summary row ${summaryRow} visible in [${top}, ${top + 5})`,
  );
});

const CATEGORY_FILES = [
  "src/app.ts",
  "docs/README.md",
  "src/app.test.ts",
  "docs/guide.test.md",
].flatMap((path) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1 +1 @@",
  "-old",
  "+new",
]).concat("").join("\n");

Deno.test("jumplist: file rows use an aligned category-toggle column", () => {
  const s = diffSession(CATEGORY_FILES);
  press(s, "i");
  assertEquals(entryText(s), [
    "   ▸ src/app.ts  +1 −1",
    "M  ▸ docs/README.md  +1 −1",
    " T ▸ src/app.test.ts  +1 −1",
    "MT ▸ docs/guide.test.md  +1 −1",
  ]);
});

Deno.test("jumplist: only currently collapsed file rows are muted", () => {
  const s = diffSession(CATEGORY_FILES);
  press(s, "i", "M");
  const lines = entryLines(s);
  for (const line of lines) {
    const markdown = line.text.startsWith("M");
    assertEquals(
      line.spans.every((span) => span.cls === "comment"),
      markdown,
      line.text,
    );
  }
});

Deno.test("jumplist: i on a non-diff view says it is diff-only", () => {
  const doc = parseDocument("const a = 1;\n", "a.ts");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
  );
  press(s, "i");
  assertEquals(s.view().overlay, null);
  assert(s.view().message.includes("only available in a diff view"));
});

// `git format-patch` output: an email envelope whose subject sits on the
// `Subject:` header rather than an indented body.
const EMAIL = [
  "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
  "From: Someone <someone@example.com>",
  "Date: Mon, 21 Jul 2026 12:00:00 +0000",
  "Subject: [PATCH] Fix the widget alignment",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "",
].join("\n");

Deno.test("jumplist: an email patch shows and filters by its Subject", () => {
  const s = diffSession(EMAIL);
  press(s, "i");
  assertEquals(entryText(s), [
    "● commit 012345678  +1 −1  Fix the widget alignment",
    "   ▸ src/app.ts  +1 −1",
  ]);
  // The subject (with its [PATCH] prefix stripped) is filterable.
  press(s, "/");
  type(s, "widget");
  assertEquals(entryText(s), [
    "● commit 012345678  +1 −1  Fix the widget alignment",
  ]);
});

Deno.test("jumplist: a plain diff with no commit lists only files", () => {
  const s = diffSession(TWO_FILES);
  press(s, "i");
  assert(
    entryText(s).every((text) => text.includes("▸")),
    "no commit entry without a commit header",
  );
});
