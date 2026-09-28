import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  buildFoldPlan,
  diffFiles,
  identityFold,
  isMarkdownPath,
  isTestPath,
} from "../lib/view/fold.ts";
import type { Document, Line } from "../lib/view/model.ts";
import { Session } from "../lib/view/session.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { parseDocument } from "../lib/view/languages/typescript/parse.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { renderFrame, type ViewState } from "../lib/view/render.ts";
import { stripAnsi } from "../lib/view/ansi.ts";
import { frameTop } from "../lib/view/actions.ts";
import { languageForFile } from "../lib/view/languages/language.ts";

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

Deno.test("diffFiles: ranges, counts, test flag, and summary text", () => {
  const files = diffFiles(TWO_FILES);
  assertEquals(files.length, 2);
  assertEquals(files[0].path, "src/app.ts");
  assertEquals(files[0].headerLine, 0);
  assertEquals(files[0].endLine, 7);
  assertEquals(files[0].isTest, false);
  assertEquals(files[0].isMarkdown, false);
  assertEquals(files[0].summary.text, "▸ src/app.ts  +1 −1");
  assertEquals(files[1].path, "src/app.test.ts");
  assertEquals(files[1].isTest, true, "a .test.ts file is a test file");
  assertEquals(files[1].isMarkdown, false);
  assertEquals(files[1].summary.text, "▸ src/app.test.ts  +1 −0");
});

Deno.test("diffFiles: new / deleted / renamed / binary summaries", () => {
  const created = diffFiles(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "",
    ].join("\n"),
  );
  assertEquals(created[0].summary.text, "▸ new.ts  +2 (new)");
  assertEquals(created[0].summary.spans.at(-1), {
    col: 10,
    text: "+2 (new)",
    cls: "diffAdd",
  });

  const deleted = diffFiles(
    [
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
  assertEquals(deleted[0].summary.text, "▸ gone.ts  −2 (deleted)");
  assertEquals(deleted[0].summary.spans.at(-1), {
    col: 11,
    text: "−2 (deleted)",
    cls: "diffDel",
  });

  const renamed = diffFiles(
    [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n"),
  );
  assertEquals(renamed[0].summary.text, "▸ old.ts → new.ts  +1 −1");

  const binary = diffFiles(
    [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n"),
  );
  assertEquals(binary[0].summary.text, "▸ img.png  (binary)");
});

Deno.test("diffFiles: a non-diff yields no files", () => {
  assertEquals(diffFiles("just some text\nnot a diff\n"), []);
});

//
// fold plan
//

const ln = (text: string): Line => ({
  text,
  spans: [{ col: 0, text, cls: "plain" }],
});

Deno.test("identityFold: display equals the document", () => {
  const lines = [ln("a"), ln("b"), ln("c")];
  const plan = identityFold(lines);
  assertEquals(plan.displayLines, lines);
  assertEquals(plan.docToDisplay(2), 2);
  assertEquals(plan.displayToDoc(1), 1);
});

Deno.test("buildFoldPlan: a collapsed file becomes one summary row", () => {
  const files = diffFiles(TWO_FILES);
  const docLines = TWO_FILES.split("\n").map(ln);
  // Collapse the first file (lines 0..7) only.
  const plan = buildFoldPlan(docLines, files, new Set([0]));
  // Row 0 is the summary; the second file's lines follow, unchanged.
  assertEquals(plan.displayLines[0].text, files[0].summary.text);
  assertEquals(
    plan.displayLines[1].text,
    "diff --git a/src/app.test.ts b/src/app.test.ts",
  );
  assertEquals(
    plan.displayLines.length,
    docLines.length - 7,
    "seven lines hidden",
  );
  // Every hidden line maps to the summary row (0); the file-2 header maps past it.
  assertEquals(plan.docToDisplay(0), 0, "the file-1 header is the summary row");
  assertEquals(
    plan.docToDisplay(5),
    0,
    "a hidden inner line maps to the summary",
  );
  assertEquals(
    plan.docToDisplay(8),
    1,
    "file-2 header is the row after the summary",
  );
  assertEquals(
    plan.displayToDoc(0),
    0,
    "the summary row stands for the header line",
  );
  assertEquals(plan.displayToDoc(1), 8, "row 1 is the file-2 header");
});

Deno.test("buildFoldPlan: nothing collapsed is the identity", () => {
  const files = diffFiles(TWO_FILES);
  const docLines = TWO_FILES.split("\n").map(ln);
  const plan = buildFoldPlan(docLines, files, new Set());
  assertEquals(plan.displayLines.length, docLines.length);
});

//
// test-path detection
//

Deno.test("isMarkdownPath: matches the pager's filename classification", () => {
  for (
    const path of [
      "README.md",
      "docs/guide.MARKDOWN",
      "notes.mdown",
      "notes.mkd",
      "components/example.MDX",
      "src/app.ts",
      "notes.md.ts",
      "docs/markdown",
    ]
  ) {
    assertEquals(
      isMarkdownPath(path),
      languageForFile(path).id === "markdown",
      path,
    );
  }
});

Deno.test("isTestPath: directories and basenames", () => {
  for (
    const p of [
      "src/app.test.ts",
      "pkg/foo.spec.js",
      "pkg/foo_test.go",
      "a/b/test-helpers.ts",
      "a/b/test_utils.py",
      "test/view-fold.test.ts",
      "packages/x/tests/helper.ts",
      "app/__tests__/x.ts",
      "fixtures/data.json",
      "testdata/sample.bin",
      "components/Button.stories.tsx",
      "conftest.py",
      "goldens/output.golden",
      "packages/x/integration/helper.ts",
      "packages/x/integration/pattern/board.tsx",
      "packages/x/e2e/login.ts",
      "src/__snapshots__/app.test.ts.snap",
      "packages/x/baselines/main.tsx/contract.json",
      "packages/x/browser-tests/repro.tsx",
      "packages/test-support/src/mod.ts",
      "src/test-utils/mock-document.ts",
      "src/test_helpers.rb",
      "patterns/render-test.tsx",
      "types/api.test.d.ts",
      "spec/models/user_spec.rb",
      "packages/x/tile-layout-fixtures.ts",
      "packages/x/login-fixture.ts",
      "pkg/test_parse.py",
      "goldens/OUTPUT.GOLDEN",
      "packages\\x\\integration\\helper.ts",
    ]
  ) {
    assert(isTestPath(p), `expected ${p} to be a test file`);
  }
  for (
    const p of [
      "src/app.ts",
      "lib/latest.ts", // contains "test" only as a substring, not a segment/base pattern
      "docs/README.md",
      "attestation.ts",
      "tasks/test-records-gather.ts",
      "packages/cli/lib/test-runner.ts",
      ".github/workflows/test-selection.yml",
      "docs/specs/test-records.md",
      "docs/specs/SES_SANDBOXING_SPEC.md",
      "scripts/cell-spec.ts",
      "tasks/aliases/Browser.test.ts.jsonl",
      "packages/toolshed/routes/integrations/oauth.ts",
      "src/latest/app.ts",
      "src/mock-doc.ts",
      "pkg/test_parse.ts",
      "tasks/aliases/x-test.ts.jsonl",
      "bin/test",
    ]
  ) {
    assert(!isTestPath(p), `expected ${p} not to be a test file`);
  }
});

//
// folding through the session
//

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

/** A diff session over `diffText` whose files do not resolve on disk (read-only,
 * but still a diff, so folding is offered). */
function foldSession(diffText: string, height = 30, width = 80): Session {
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const model = parseDiff(diffText)!;
  const { doc, edit } = buildDiffDocument(diffText, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width, height },
    undefined,
    diffSource(ws, edit),
  );
}

Deno.test("fold: f hides the file the viewport is on, f again shows it", () => {
  const s = foldSession(TWO_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "f"); // collapse file 0 (the viewport is at its top)
  const folded = s.displayDoc();
  assertEquals(folded.lines[0].text, "▸ src/app.ts  +1 −1", "summary shown");
  assertEquals(
    folded.lines.length,
    full - 7,
    "the file's seven lines are hidden",
  );
  assertEquals(
    folded.lines[1].text,
    "diff --git a/src/app.test.ts b/src/app.test.ts",
  );
  press(s, "f"); // toggle back
  assertEquals(s.displayDoc().lines.length, full, "showing again restores it");
});

Deno.test("fold: a summary omits markers for a hidden expansion edge", () => {
  const ws: DiffWorkspace = {
    resolve: (path) => path,
    read: (path) =>
      path.endsWith("app.test.ts") ? "x\nadded\nafter" : "keep\nnew\nafter",
  };
  const model = parseDiff(TWO_FILES)!;
  const { doc, edit } = buildDiffDocument(TWO_FILES, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 30 },
    undefined,
    diffSource(ws, edit),
  );
  press(s, "f");
  const view = s.view();
  assertEquals(view.canExpand, true);
  assertEquals(view.expandRow, 7);
  assertEquals(view.expandUp, false);
  assertEquals(view.diffAnnotations, [{ line: 7, kind: "expandDown" }]);
  const rendered = renderFrame(s.displayDoc(), view);
  assert(
    rendered[0].startsWith("▸ src/app.ts  +1 −1 "),
    "the summary line is shown",
  );
  assert(
    rendered[0].endsWith("+2 −1"),
    "the corner carries the whole-diff totals",
  );
  assertEquals(rendered[7].at(-1), "◢");

  const internals = s.accessForTestingOnly;
  const hiddenEdge = {
    row: 5,
    markerLine: 5,
    line: 4,
    up: true,
  };
  assertEquals(internals.displayDiffAnnotations(hiddenEdge), []);
  assertEquals(internals.displayAdjacentDiffMetadataRows(hiddenEdge), []);
});

Deno.test("fold: a smaller file-number gutter clamps horizontal panning", () => {
  const root = Deno.makeTempDirSync();
  try {
    const longLine = "x".repeat(40);
    const diff = [
      "diff --git a/large.ts b/large.ts",
      "--- a/large.ts",
      "+++ b/large.ts",
      "@@ -1000,3 +1000,3 @@",
      ` ${longLine}`,
      "-old",
      "+new",
      " tail",
      "diff --git a/small.ts b/small.ts",
      "--- a/small.ts",
      "+++ b/small.ts",
      "@@ -1,2 +1,2 @@",
      ` ${longLine}`,
      "-before",
      "+after",
      "",
    ].join("\n");
    const largeFile = [
      ...Array.from({ length: 999 }, (_, i) => `line ${i + 1}`),
      longLine,
      "new",
      "tail",
      "",
    ].join("\n");
    Deno.writeTextFileSync(join(root, "large.ts"), largeFile);
    Deno.writeTextFileSync(join(root, "small.ts"), `${longLine}\nafter\n`);
    const ws: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => Deno.readTextFileSync(path),
    };
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 20, height: 20 },
      undefined,
      diffSource(ws, edit),
    );
    assert(s.view().expandMargin, "the diff reserves its expansion margin");
    press(s, "#", "#");
    for (let i = 0; i < 20; i++) press(s, "l");
    const withLargeFileNumbers = s.view().left;

    press(s, "f");
    assert(
      s.view().left < withLargeFileNumbers,
      "the smaller gutter clamps the right edge",
    );
    const atRightEdge = s.view().left;
    press(s, "l");
    assertEquals(s.view().left, atRightEdge, "right does not move left");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("fold: F hides all files, E shows all files", () => {
  const s = foldSession(TWO_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "F");
  const lines = s.displayDoc().lines.map((l) => l.text);
  assert(lines.includes("▸ src/app.ts  +1 −1"), lines.join("|"));
  assert(lines.includes("▸ src/app.test.ts  +1 −0"), lines.join("|"));
  // Only the two summaries and the trailing blank remain.
  assertEquals(s.displayDoc().lines.length, 3);
  press(s, "E");
  assertEquals(s.displayDoc().lines.length, full, "E restores every file");
});

Deno.test("fold: T hides shown test files and shows them when all are hidden", () => {
  const s = foldSession(TWO_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "T");
  const lines = s.displayDoc().lines.map((l) => l.text);
  // The test file is a summary; the source file is shown in full.
  assert(lines.includes("▸ src/app.test.ts  +1 −0"), "test file collapsed");
  assert(lines.includes(" keep"), "the source file is still shown in full");
  assert(
    !lines.includes("▸ src/app.ts  +1 −1"),
    "the source file is not collapsed",
  );
  assert(s.view().message.includes("Hid 1 test file"), s.view().message);

  press(s, "T");
  assertEquals(s.displayDoc().lines.length, full, "T shows the hidden test");
  assertEquals(s.view().message, "Showing 1 test file.");
});

const CATEGORY_FILES = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/docs/README.md b/docs/README.md",
  "--- a/docs/README.md",
  "+++ b/docs/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/app.test.ts b/src/app.test.ts",
  "--- a/src/app.test.ts",
  "+++ b/src/app.test.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/docs/guide.test.md b/docs/guide.test.md",
  "--- a/docs/guide.test.md",
  "+++ b/docs/guide.test.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

Deno.test("fold: M toggles every Markdown file", () => {
  const s = foldSession(CATEGORY_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "M");
  const hidden = s.displayDoc().lines.map((line) => line.text);
  assert(hidden.includes("▸ docs/README.md  +1 −1"));
  assert(hidden.includes("▸ docs/guide.test.md  +1 −1"));
  assert(!hidden.includes("▸ src/app.ts  +1 −1"));
  assert(!hidden.includes("▸ src/app.test.ts  +1 −1"));
  assertEquals(s.view().message, "Hid 2 Markdown files.");

  press(s, "M");
  assertEquals(s.displayDoc().lines.length, full, "M shows all Markdown files");
  assertEquals(s.view().message, "Showing 2 Markdown files.");
});

Deno.test("fold: a category key reports when the diff has no matching files", () => {
  const s = foldSession(TWO_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "M");
  assertEquals(s.displayDoc().lines.length, full);
  assertEquals(s.view().message, "No Markdown files.");
});

Deno.test("fold: a partly hidden category is made fully hidden", () => {
  const s = foldSession(CATEGORY_FILES);
  press(s, "M");
  press(s, "T");
  const lines = s.displayDoc().lines.map((line) => line.text);
  assert(lines.includes("▸ src/app.test.ts  +1 −1"));
  assert(lines.includes("▸ docs/guide.test.md  +1 −1"));
  assertEquals(s.view().message, "Hid 1 test file.");
});

Deno.test("fold: bulk commands preserve a wrapped viewport column", () => {
  const show = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A",
    "Date:   now",
    "",
    `    ${"x".repeat(96)}needle`,
    "",
    TWO_FILES,
  ].join("\n");
  const s = foldSession(show, 4, 16);
  press(s, "\\", "/");
  for (const ch of "needle") press(s, ch);
  press(s, "enter");
  const match = s.view().matches?.[s.view().currentMatch];
  assert(match, "the long commit-message line matched");
  const firstRow = s.view().wrapPlan?.firstRow[match.line] ?? 0;
  const anchor = s.view().top;
  assert(anchor > firstRow, "the viewport starts on a continuation row");

  for (const key of ["T", "T", "M", "M", "F", "F", "E", "E"]) {
    press(s, key);
    assertEquals(s.view().top, anchor, `${key} preserves the continuation`);
  }
});

Deno.test("fold: another fold preserves a wrapped summary continuation", () => {
  const first = `src/${"first/".repeat(12)}app.ts`;
  const second = `src/${"second/".repeat(12)}app.ts`;
  const diff = [
    `diff --git a/${first} b/${first}`,
    `--- a/${first}`,
    `+++ b/${first}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    `diff --git a/${second} b/${second}`,
    `--- a/${second}`,
    `+++ b/${second}`,
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  for (const selected of [false, true]) {
    const s = foldSession(diff, 4, 10);
    press(s, "f", "\\");
    if (selected) {
      press(s, "tab");
      assert(s.view().selected, "the collapsed file is selected");
    }
    press(s, "j", "j");
    const top = s.view().top;
    assert(top > 0, "the viewport is on a summary continuation");

    press(s, "F");
    assertEquals(s.view().top, top, `selected: ${selected}`);
  }
});

Deno.test("fold: the collapsed summary renders on screen", () => {
  const s = foldSession(TWO_FILES);
  press(s, "F");
  const view: ViewState = s.view();
  const rows = renderFrame(s.displayDoc(), view);
  const text = rows.map(stripAnsi).join("\n");
  assert(text.includes("▸ src/app.ts  +1 −1"), text);
  assert(text.includes("▸ src/app.test.ts  +1 −0"), text);
});

Deno.test("fold: a selected file spans every wrapped summary row", () => {
  const longPath = `src/${"nested/".repeat(10)}app.ts`;
  const diff = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A",
    "Date:   now",
    "",
    "    Subject",
    "",
    `diff --git a/${longPath} b/${longPath}`,
    `--- a/${longPath}`,
    `+++ b/${longPath}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/z.ts b/z.ts",
    "--- a/z.ts",
    "+++ b/z.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  const height = 7;
  const s = foldSession(diff, height, 20);
  press(s, "\\", "F");
  const summaryLine = s.displayDoc().lines.findIndex((line) =>
    line.text.startsWith(`▸ ${longPath}`)
  );
  assert(summaryLine >= 0, "the long file is collapsed to a summary");
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label.includes(longPath)) break;
    press(s, "tab");
  }
  assert(s.view().selected?.label.includes(longPath), "the file is selected");
  press(s, "enter", "z");
  const plan = s.view().wrapPlan!;
  const first = plan.firstRow[summaryLine];
  const last = plan.lastRow[summaryLine];
  assert(last > first, "the revealed summary occupies continuation rows");
  assertEquals(
    s.view().top,
    frameTop(first, last, height, plan.rowCount),
    "the reveal frames the whole wrapped summary",
  );
});

Deno.test("fold: folding is refused on a non-diff view", () => {
  const doc = {
    text: "const x = 1;\n",
    lines: [{ text: "const x = 1;", spans: [] }],
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
  const s = new Session(doc, { color: false, showLineNumbers: false }, {
    width: 80,
    height: 10,
  });
  press(s, "f");
  assert(s.view().message.includes("diff view"), s.view().message);
});

Deno.test("fold: revealing the cursor to edit expands every fold", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "app.ts"), "keep\nnew\n");
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
    const diff = [
      "diff --git a/app.ts b/app.ts",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    press(s, "F"); // collapse the file
    assert(s.displayDoc().lines.length < doc.lines.length, "collapsed");
    press(s, "e"); // reveal the cursor to edit
    assert(s.view().cursor !== null, "cursor revealed");
    assertEquals(
      s.displayDoc().lines.length,
      doc.lines.length,
      "editing expanded every fold",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("fold: a selected node and a search match map onto the summary row", () => {
  const s = foldSession(TWO_FILES);
  press(s, "f"); // collapse file 0 (lines 0..7 → display row 0)
  // Select the collapsed file's node (the first structure node).
  press(s, "tab");
  const sel = s.view().selected;
  assert(sel, "a node is selected");
  assertEquals(sel!.startLine, 0, "the collapsed node sits on the summary row");
  assertEquals(sel!.endLine, 0, "its whole range maps onto that one row");
  // A search for text hidden inside the collapsed file maps to the summary row.
  press(s, "/");
  for (const ch of "keep") press(s, ch);
  press(s, "enter");
  const m = s.view().matches?.[s.view().currentMatch];
  assert(m, "a match was found");
  assertEquals(m!.line, 0, "the hidden match maps to the summary row");
  assertEquals(m!.start, 0, "the hidden match starts at the summary's edge");
  assertEquals(
    m!.end,
    [...s.displayDoc().lines[0].text].length,
    "the hidden match covers the summary",
  );
  press(s, "/");
  for (const ch of "added") press(s, ch);
  press(s, "enter");
  const visible = s.view().matches?.[s.view().currentMatch];
  assert(visible, "a match in the shown file was found");
  const shownText = s.displayDoc().lines[visible!.line].text;
  assertEquals(
    shownText.slice(visible!.start, visible!.end),
    "added",
    "a shown match keeps its source columns",
  );
});

Deno.test("fold: a collapsed file contributes one searchable match", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old needle",
    "+new needle",
    " keep needle",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1,2 @@",
    " keep",
    "+needle",
    "",
  ].join("\n");
  const s = foldSession(diff);
  press(s, "f");
  press(s, "/");
  for (const ch of "needle") press(s, ch);
  press(s, "enter");

  expect(s.view().matches?.length).toBe(2);
  expect(s.view().currentMatch).toBe(0);

  press(s, "n");
  const shown = s.view().matches?.[s.view().currentMatch];
  assert(shown, "the shown file's match is focused");
  expect(
    s.displayDoc().lines[shown.line].text.slice(shown.start, shown.end),
  ).toBe("needle");

  press(s, "N");
  expect(s.view().currentMatch).toBe(0);
});

Deno.test("fold: F / E / T / M are refused on a non-diff view", () => {
  const doc = {
    text: "const x = 1;\n",
    lines: [{ text: "const x = 1;", spans: [] }],
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
  const s = new Session(doc, { color: false, showLineNumbers: false }, {
    width: 80,
    height: 10,
  });
  for (const k of ["F", "E", "T", "M"]) {
    press(s, k);
    assert(s.view().message.includes("diff view"), `${k}: ${s.view().message}`);
  }
});

Deno.test("fold: WASD with no selection picks a node visible on screen while folded", () => {
  const s = foldSession(TWO_FILES);
  press(s, "F"); // collapse everything → summary rows only
  press(s, "tab"); // start navigation with nothing selected
  const sel = s.view().selected;
  assert(sel, "a node was selected");
  // The selected node's (display) start row is on screen.
  assert(
    sel!.startLine >= 0 && sel!.startLine < s.displayDoc().lines.length,
    `selected row ${sel!.startLine} is on screen`,
  );
});

Deno.test("nav: starting navigation with the viewport past every node start selects a node", () => {
  // Two statements far apart; scrolling into the blank gap leaves no node start
  // on screen, so navigation falls back rather than selecting nothing.
  const doc = parseDocument(
    "const a = 1;\n" + "\n".repeat(20) + "const b = 2;\n",
  );
  const s = new Session(doc, { color: false, showLineNumbers: false }, {
    width: 80,
    height: 4,
  });
  for (let i = 0; i < 10; i++) press(s, "j"); // into the gap
  press(s, "tab");
  assert(s.view().selected !== null, "the fallback selected a node");
});

Deno.test("fold: a collapsed file's interior is not navigable", () => {
  const navDiff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " function f() {}",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,2 +1,2 @@",
    " function g() {}",
    "-x",
    "+y",
    "",
  ].join("\n");
  const s = foldSession(navDiff);
  press(s, "f"); // collapse file 0 (a.ts, at the top)
  const labels = new Set<string>();
  for (let i = 0; i < 16; i++) {
    press(s, "tab");
    const l = s.view().selected?.label;
    if (l) labels.add(l);
  }
  const joined = [...labels].join(" | ");
  assert(
    [...labels].some((l) => l.includes("g")),
    `b.ts's function stays navigable: ${joined}`,
  );
  assert(
    ![...labels].some((l) => l.includes("ƒ f")),
    `a.ts's interior (collapsed) is not navigable: ${joined}`,
  );
  assert(
    [...labels].some((l) => l.includes("a.ts")),
    `the collapsed file itself is still selectable: ${joined}`,
  );
});

Deno.test("line numbers: file mode shows new-file lines and blanks for structure", () => {
  const diff = [
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -40,3 +40,4 @@",
    " keep40",
    "-old",
    "+new41",
    "+new42",
    " keep43",
    "",
  ].join("\n");
  const s = foldSession(diff);
  press(s, "#"); // input position
  const input = s.view().lineNumbers!;
  assertEquals(input[4], 5, "input: the ' keep40' line is input line 5");
  press(s, "#"); // file / message line
  const file = s.view().lineNumbers!;
  // Context/added lines carry their new-file line; the diff structure is blank.
  assertEquals(file[0], null, "the diff --git header has no file line");
  assertEquals(file[3], null, "the hunk header has no file line");
  assertEquals(file[4], 40, "' keep40' is new-file line 40");
  assertEquals(file[5], null, "the removed line has no new-file line");
  assertEquals(file[6], 41, "'+new41' is new-file line 41");
  assertEquals(file[8], 43, "' keep43' is new-file line 43");
});

Deno.test("line numbers: file mode parses the diff once per document", () => {
  const diff = [
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -40,3 +40,4 @@",
    " keep40",
    "-old",
    "+new41",
    "+new42",
    " keep43",
    "",
  ].join("\n");
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  // A document that counts the reads of its text, which is what the file-line
  // map parses.
  let reads = 0;
  const counting: Document = { ...doc };
  Object.defineProperty(counting, "text", {
    get() {
      reads++;
      return doc.text;
    },
  });
  const s = new Session(
    counting,
    { color: false, showLineNumbers: false },
    { width: 80, height: 30 },
    undefined,
    diffSource(ws, edit),
  );
  press(s, "#", "#"); // → file / message line
  assertEquals(s.view().lineNumbers![4], 40);
  const settled = reads;
  for (let i = 0; i < 5; i++) assertEquals(s.view().lineNumbers![6], 41);
  assertEquals(reads, settled, "redrawing does not re-parse the diff");
});

Deno.test("line numbers: file mode follows an edit that adds a line", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      "x\n".repeat(39) + "keep40\nnew41\nnew42\nkeep43\n",
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
    const diff = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -40,3 +40,4 @@",
      " keep40",
      "-old",
      "+new41",
      "+new42",
      " keep43",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    press(s, "#", "#"); // → file / message line
    assertEquals(s.view().lineNumbers![7], 42, "'+new42' is new-file line 42");
    press(s, "e"); // reveal the cursor
    for (let i = 0; i < 6; i++) press(s, "down"); // onto '+new41'
    press(s, "end", "enter"); // split it, adding a line after it
    const nums = s.view().lineNumbers!;
    assertEquals(nums[7], 42, "the added blank line is new-file line 42");
    assertEquals(nums[8], 43, "'+new42' moved to new-file line 43");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("line numbers: file mode numbers a commit message from one", () => {
  const show = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A",
    "Date:   now",
    "",
    "    Subject",
    "    ",
    "    Body.",
    "",
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const s = foldSession(show);
  press(s, "#", "#"); // → file / message line
  const nums = s.view().lineNumbers!;
  assertEquals(nums[0], null, "the commit header line is blank");
  assertEquals(nums[4], 1, "the subject is message line 1");
  assertEquals(nums[6], 3, "the body is message line 3");
});

Deno.test("fold: navigating after the selected file collapses resumes at that file", () => {
  const navDiff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " function f() {}",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,2 +1,2 @@",
    " function g() {}",
    "-x",
    "+y",
    "",
  ].join("\n");
  const s = foldSession(navDiff);
  for (let i = 0; i < 16; i++) {
    press(s, "tab");
    if (s.view().selected?.label.includes("ƒ f")) break;
  }
  const inside = s.view().selected!;
  assert(inside.label.includes("ƒ f"), "the first file's function is selected");
  press(s, "f"); // collapse the file the selection is in
  const collapsed = s.view().selected!;
  const summary = s.displayDoc().lines[collapsed.startLine];
  assertEquals(collapsed.startLine, collapsed.endLine);
  assertEquals(collapsed.startCol, 0);
  assertEquals(collapsed.endCol, [...summary.text].length);
  press(s, "s"); // navigate: the folded-away selection resumes at the file
  const sel = s.view().selected!;
  assert(sel, "a node is selected after collapsing the selected file");
  assert(sel.label.includes("a.ts") || sel.label.includes("b.ts"), sel.label);
});
