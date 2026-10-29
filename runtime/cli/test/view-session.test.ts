import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { renderFrame } from "../lib/view/render.ts";
import { Session } from "../lib/view/session.ts";
import { frameTop, maxTop } from "../lib/view/actions.ts";
import { buildPeekCard } from "../lib/view/card.ts";
import type { CardTarget } from "../lib/view/card.ts";
import type { EditableSource } from "../lib/view/editsource.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Semantics } from "../lib/view/languages/language.ts";
import { wrappedRowAt } from "../lib/view/wrap.ts";

function makeSession() {
  const doc = parseDocument(SAMPLE);
  return new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 80, height: 10 },
  );
}

function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    const key: Key = name.length === 1 && name >= " "
      ? { name, char: name }
      : { name };
    session.handleKey(key);
  }
}

function expandableSession(
  text: string,
  width: number,
  editable = false,
): Session {
  const source: EditableSource = {
    label: null,
    isDiff: true,
    editable,
    parse: (next) => parseDocument(next),
    save: () => "",
    expandContext: () => null,
  };
  return new Session(
    parseDocument(text),
    { color: false, showLineNumbers: false },
    { width, height: 4 },
    undefined,
    source,
  );
}

Deno.test("session: vertical scrolling and clamping", () => {
  // j/k scroll the pager (bare arrows scroll too; edit mode is entered with e).
  const s = makeSession();
  assertEquals(s.view().top, 0);
  press(s, "j", "j", "j");
  assertEquals(s.view().top, 3);
  press(s, "k");
  assertEquals(s.view().top, 2);
  press(s, "g");
  assertEquals(s.view().top, 0);
  press(s, "G");
  assert(s.view().top > 0, "G goes to the bottom");
  press(s, "k", "k");
  // never below zero
  press(s, "g", "k", "k");
  assertEquals(s.view().top, 0);
});

Deno.test("session: the mouse wheel scrolls without moving the edit cursor", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const source: EditableSource = {
    label: null,
    editable: true,
    parse: (next) => parseDocument(next),
    save: () => "",
  };
  const session = new Session(
    parseDocument(text),
    { color: false, showLineNumbers: false },
    { width: 30, height: 6 },
    undefined,
    source,
  );
  press(session, "e");
  const cursor = session.view().cursor;
  press(session, "wheel-down");
  assertEquals(session.view().top, 3);
  assertEquals(session.view().cursor, cursor);
  press(session, "wheel-up", "wheel-up");
  assertEquals(session.view().top, 0);
  press(session, "ctrl-x", "wheel-down", "z");
  assertEquals(session.view().message, "", "the wheel cancelled the C-x chord");
});

Deno.test("session: the mouse wheel scrolls an overlay", () => {
  const session = makeSession();
  press(session, "?");
  assertEquals(session.view().overlay?.scroll, 0);
  press(session, "wheel-down");
  assertEquals(session.view().overlay?.scroll, 3);
});

Deno.test("session: an ordinary file ends at the bottom of the viewport", () => {
  const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const s = new Session(
    parseDocument(text),
    { color: false, showLineNumbers: false },
    { width: 30, height: 9 },
  );
  press(s, "G");
  assertEquals(s.view().top, maxTop(s.doc.lines.length, s.view().height));
  const rows = renderFrame(s.displayDoc(), s.view());
  assertEquals(rows[7].trim(), "line 11");
  assert(
    !rows.some((row) => /[☙❦❧]/u.test(row)),
    "ordinary files omit the end mark",
  );
  press(s, "j");
  assertEquals(s.view().top, 4, "down stops with the last line at the bottom");
});

Deno.test("session: a diff leaves three quarters below the final line", () => {
  const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const source: EditableSource = {
    label: null,
    isDiff: true,
    editable: false,
    parse: (next) => parseDocument(next),
    save: () => "",
  };
  const s = new Session(
    parseDocument(text),
    { color: false, showLineNumbers: false },
    { width: 30, height: 9 },
    undefined,
    source,
  );
  press(s, "G");
  assertEquals(s.view().top, 10);
  const rows = renderFrame(s.displayDoc(), s.view());
  assertEquals(rows[1].trim(), "line 11");
  assertEquals(rows[2].trim(), "☙   ❦   ❧");
  assertEquals(rows[3].trim(), "☙   ❧");
  assertEquals(rows[4].trim(), "❦");
  press(s, "j");
  assertEquals(s.view().top, 10, "down stops at the padded diff end");
});

Deno.test("session: a trailing diff newline is not a padded content row", () => {
  const source: EditableSource = {
    label: null,
    isDiff: true,
    editable: false,
    parse: (next) => parseDocument(next),
    save: () => "",
  };
  const s = new Session(
    parseDocument("done\n"),
    { color: false, showLineNumbers: false },
    { width: 30, height: 5 },
    undefined,
    source,
  );
  press(s, "G");
  assertEquals(s.view().top, 0);
  const rows = renderFrame(s.displayDoc(), s.view());
  assertEquals(rows[0].trim(), "done");
  assertEquals(rows[1].trim(), "☙   ❦   ❧");
  assert(
    rows.at(-1)!.includes("1-1/1  END"),
    "the hidden terminator is absent from the status",
  );
});

Deno.test("session: edit-mode scrolling keeps the ordinary document limit", () => {
  const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const source: EditableSource = {
    label: null,
    editable: true,
    parse: (next) => parseDocument(next),
    save: () => "",
  };
  const s = new Session(
    parseDocument(text),
    { color: false, showLineNumbers: false },
    { width: 30, height: 9 },
    undefined,
    source,
  );
  press(s, "e");
  for (let i = 0; i < 20; i++) {
    s.handleKey({ name: "down", alt: true });
  }
  assertEquals(s.view().top, maxTop(s.doc.lines.length, s.view().height));
});

Deno.test("session: horizontal scrolling", () => {
  const s = makeSession();
  press(s, "l");
  assertEquals(s.view().left, 8);
  press(s, "h");
  assertEquals(s.view().left, 0);
  press(s, "h");
  assertEquals(s.view().left, 0, "left clamps at 0");
});

Deno.test("session: lines without diff annotations use the full width", () => {
  const s = expandableSession("abcde", 7);
  assertEquals(renderFrame(s.displayDoc(), s.view())[0], "abcde  ");
  press(s, "l");
  assertEquals(s.view().left, 0);
  assertEquals(renderFrame(s.displayDoc(), s.view())[0], "abcde  ");
});

Deno.test("session: full-width lines count displayed cells", () => {
  const cases = [
    { text: "😀😀😀😀😀", displayModeKeys: 0, expected: "😀😀😀😀😀  " },
    {
      text: "\x1b[31mabcde\x1b[0m",
      displayModeKeys: 1,
      expected: "abcde  ",
    },
  ];
  for (const { text, displayModeKeys, expected } of cases) {
    const s = expandableSession(text, 7);
    for (let i = 0; i < displayModeKeys; i++) press(s, "c");
    press(s, "l", "l");
    assertEquals(s.view().left, 0);
    assertEquals(renderFrame(s.displayDoc(), s.view())[0], expected);
  }
});

Deno.test("session: search keeps a fitting unannotated match in place", () => {
  const s = expandableSession("abcdX", 7);
  press(s, "/", "X", "enter");
  assertEquals(s.view().left, 0);
  assertEquals(renderFrame(s.displayDoc(), s.view())[0], "abcdX  ");
});

Deno.test("session: a card jump uses the full unannotated width", () => {
  const s = expandableSession("abcdX", 7);
  const target: CardTarget = {
    cardLine: 0,
    destLine: 0,
    destCol: 4,
  };
  s.accessForTestingOnly.jumpToTarget(target);
  assertEquals(s.view().left, 0);
  assertEquals(renderFrame(s.displayDoc(), s.view())[0], "▶abcdX ");
});

Deno.test("session: clearing a selection clamps expansion-margin panning", () => {
  const s = expandableSession("const x = 123456789;", 5);
  press(s, "tab");
  assert(s.view().selected, "a guide is present");
  press(s, ...Array(25).fill("l"));
  const withGuide = s.view().left;
  press(s, "escape");
  assertEquals(s.view().left, withGuide - 1);
  const atRightEdge = s.view().left;
  press(s, "l");
  assertEquals(s.view().left, atRightEdge, "right does not move left");
});

const TOTALS_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/b.ts b/b.ts",
  "index 3333333..4444444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1,2 @@",
  " x",
  "+added",
  "",
].join("\n");

function totalsSource(editable = false): EditableSource {
  return {
    label: null,
    isDiff: true,
    editable,
    parse: (next) => parseDocument(next),
    save: () => "",
  };
}

Deno.test("session: a diff source carries whole-diff totals to the view", () => {
  const s = new Session(
    parseDocument(TOTALS_DIFF),
    { color: false, showLineNumbers: false },
    { width: 40, height: 6 },
    undefined,
    totalsSource(),
  );
  assertEquals(s.view().diffTotals, { adds: 2, dels: 1 });
  const rows = renderFrame(s.displayDoc(), s.view());
  assert(rows[0].endsWith("+2 −1"), "the first line's corner sums both files");

  const plain = new Session(
    parseDocument(TOTALS_DIFF),
    { color: false, showLineNumbers: false },
    { width: 40, height: 6 },
  );
  assertEquals(
    plain.view().diffTotals,
    null,
    "no totals without a diff source",
  );

  const noFiles = new Session(
    parseDocument(SAMPLE),
    { color: false, showLineNumbers: false },
    { width: 40, height: 6 },
    undefined,
    totalsSource(),
  );
  assertEquals(noFiles.view().diffTotals, null, "no totals without diff files");
});

Deno.test("session: edit mode hides the whole-diff totals", () => {
  const s = new Session(
    parseDocument(TOTALS_DIFF),
    { color: false, showLineNumbers: false },
    { width: 40, height: 8 },
    undefined,
    totalsSource(true),
  );
  press(s, "e");
  assert(s.view().cursor, "the text cursor is active");
  assertEquals(s.view().diffTotals, null);
  assert(!renderFrame(s.displayDoc(), s.view())[0].includes("+2 −1"));
  press(s, "escape");
  assertEquals(s.view().diffTotals, { adds: 2, dels: 1 });
});

Deno.test("session: a wrapped first line flows around the totals label", () => {
  const s = new Session(
    parseDocument(TOTALS_DIFF),
    { color: false, showLineNumbers: false },
    { width: 20, height: 6 },
    undefined,
    totalsSource(),
  );
  press(s, "\\");
  const rows = renderFrame(s.displayDoc(), s.view());
  assertEquals(rows[0], "diff --git a/a\\+2 −1");
  assertEquals(rows[1], ".ts b/a.ts          ");
});

Deno.test("session: panning reaches content hidden under the totals label", () => {
  const PAN_DIFF = [
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
  const s = expandableSession(PAN_DIFF, 20);
  press(s, ...Array(4).fill("l"));
  // The first line is 36 columns; the clamp leaves room to pan its tail out
  // from under the five-column label: 36 − (20 − 5).
  assertEquals(s.view().left, 21);
  assertEquals(
    renderFrame(s.displayDoc(), s.view())[0],
    "ts b/src/app.ts+1 −1",
    "the end of the first line is visible beside the label",
  );
});

Deno.test("session: removing the gutter clamps expansion-margin panning", () => {
  const s = expandableSession("abcdefghijklmnopqrst", 10);
  press(s, "#");
  for (let i = 0; i < 10; i++) press(s, "l");
  const withGutter = s.view().left;
  press(s, "#", "#");
  assertEquals(s.view().left, withGutter - 4);
  const atRightEdge = s.view().left;
  press(s, "l");
  assertEquals(s.view().left, atRightEdge, "right does not move left");
});

Deno.test("session: leaving edit mode clamps expansion-margin panning", () => {
  const s = expandableSession("abcdefghijklmnopqrst", 10, true);
  press(s, "e", "end", "left");
  for (let i = 0; i < 10; i++) {
    s.handleKey({ name: "right", alt: true });
  }
  assertEquals(s.view().left, 20, "edit mode retains ordinary panning");
  press(s, "escape");
  assertEquals(s.view().left, 10);
  press(s, "l");
  assertEquals(s.view().left, 10, "right does not move left");
});

Deno.test("session: leaving edit mode keeps the former cursor column visible", () => {
  const s = expandableSession("abcde", 7, true);
  press(s, "e", "right", "right", "right", "right", "escape");
  assertEquals(s.view().left, 0);
  assertEquals(renderFrame(s.displayDoc(), s.view())[0], "abcde  ");
});

Deno.test("session: backslash cycles wrapping and keeps its content anchor", () => {
  const doc = parseDocument("abcdefghijkl\nsecond");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 4, height: 3 },
  );
  press(s, "l", "\\");
  assertEquals(s.view().wrapMode, "hard");
  assertEquals(s.view().left, 0, "wrapping resets horizontal panning");
  assertEquals(s.view().top, 2, "wrapping keeps the panned content in view");
  assertEquals(s.view().message, "Line wrapping: hard");

  press(s, "k");
  assertEquals(s.view().top, 1, "k moves to the previous wrapped row");
  press(s, "l", "right");
  assertEquals(s.view().left, 0, "wrapped content does not pan");

  press(s, "\\");
  assertEquals(s.view().wrapMode, "word");
  assertEquals(s.view().top, 1, "word wrapping keeps the same source content");
  assertEquals(s.view().message, "Line wrapping: word");

  press(s, "\\");
  assertEquals(s.view().wrapMode, "off");
  assertEquals(s.view().top, 0, "the same logical line remains at the top");
  assertEquals(s.view().left, 3, "unwrapping keeps the continuation visible");
  assertEquals(s.view().message, "Line wrapping: off");
});

Deno.test("session: word wrapping repeats punctuation and whitespace prefixes", () => {
  const s = new Session(
    parseDocument("  #  foo bar"),
    { color: false, showLineNumbers: false },
    { width: 11, height: 4 },
  );

  press(s, "\\", "\\");

  assertEquals(s.view().wrapMode, "word");
  const rows = renderFrame(s.displayDoc(), s.view());
  assertEquals(rows[0], "  #  foo  \\");
  assertEquals(rows[1], "  #  bar   ");
});

Deno.test("session: word wrapping restores the visible source at a word", () => {
  const s = new Session(
    parseDocument("alpha beta gamma delta\nnext"),
    { color: false, showLineNumbers: false },
    { width: 10, height: 3 },
  );

  press(s, "\\", "j", "\\");

  const view = s.view();
  assertEquals(view.wrapMode, "word");
  assertEquals(
    wrappedRowAt(view.wrapPlan!, view.top)?.offset,
    6,
    "the hard-wrap anchor remains on the row that starts with beta",
  );
  assert(renderFrame(s.displayDoc(), view)[0].startsWith("beta "));
});

Deno.test("session: resizing a wrapped view keeps its top content in view", () => {
  const doc = parseDocument("abcdefghijkl\nnext");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 4, height: 3 },
  );
  press(s, "\\", "j", "j");
  assertEquals(s.view().top, 2);
  s.resize(6, 3);
  assertEquals(s.view().top, 1, "the old column offset maps into the new rows");
  s.resize(20, 3);
  assertEquals(s.view().top, 0, "the line fits after a wide resize");
});

Deno.test("session: an empty wrapped document remains stable across resize", () => {
  const parsed = parseDocument("");
  const s = new Session(
    { ...parsed, lines: [] },
    { color: false, showLineNumbers: false },
    { width: 4, height: 3 },
  );
  press(s, "\\");
  s.resize(8, 4);
  assertEquals(s.view().top, 0);
  assertEquals(s.view().wrapPlan?.rowCount, 0);
});

Deno.test("session: a gutter-width change reflows wrapped rows around the anchor", () => {
  const doc = parseDocument("abcdefghijkl\nnext");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 8, height: 3 },
  );
  press(s, "\\", "j", "#");
  assertEquals(s.view().top, 2, "the same display offset stays at the top");
  assert(s.view().showLineNumbers, "line numbers are on");
});

Deno.test("session: removing a gutter reclamps a wrapped ordinary end", () => {
  const doc = parseDocument("abcdefghijklmnopqrst");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 8, height: 4 },
  );
  press(s, "\\", "#", "G");
  assertEquals(
    s.view().top,
    maxTop(s.view().wrapPlan!.rowCount, s.view().height),
  );
  press(s, "#", "#");
  assertEquals(
    s.view().top,
    maxTop(s.view().wrapPlan!.rowCount, s.view().height),
  );
});

Deno.test("session: search reveals the wrapped row containing the match", () => {
  const doc = parseDocument("prefix----needle\nnext");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 5, height: 3 },
  );
  press(s, "\\", "/", "n", "e", "e", "d", "l", "e", "enter");
  assert(s.view().top > 0, "the continuation containing the match is visible");
  assertEquals(s.view().left, 0, "search does not pan wrapped content");
});

Deno.test("session: clearing a selection reflows a wrapped logical line", () => {
  const doc = parseDocument("const value = 123456789;");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 8, height: 3 },
  );
  press(s, "s", "\\", "j", "j", "escape");
  assertEquals(s.view().selected, null);
  assertEquals(s.view().top, 1, "the selected continuation stays in view");
});

Deno.test("session: changing display mode reflows a wrapped logical line", () => {
  const doc = parseDocument("abcdefgh\x1b[31mijklmnop");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 4, height: 3 },
  );
  press(s, "\\", "j", "j", "c");
  assertEquals(s.view().displayMode, "ansi");
  assertEquals(s.view().top, 2, "the same source column stays in view");
});

Deno.test("session: selecting a node preserves the wrapped viewport anchor", () => {
  const doc = parseDocument(Array(20).fill("abcdefghij").join("\n"));
  const node = {
    ...doc.flatStructure[0]!,
    startLine: 5,
    endLine: 5,
    startCol: 0,
    endCol: 10,
    children: [],
  };
  const s = new Session(
    { ...doc, structure: [node], flatStructure: [node] },
    { color: false, showLineNumbers: false },
    { width: 10, height: 4 },
  );
  press(s, "\\", "j", "j", "j", "j", "j", "s");
  assertEquals(
    s.view().top,
    10,
    "line 5 remains at the top after guide reflow",
  );
});

Deno.test("session: structure navigation reveals a node on a continuation", () => {
  const text = `${"x".repeat(235)}TARGET${"x".repeat(10)}`;
  const doc = parseDocument(text);
  const node = {
    ...doc.flatStructure[0]!,
    label: "target",
    startCol: 235,
    endCol: 241,
    startOffset: 235,
    endOffset: 241,
    children: [],
  };
  const s = new Session(
    { ...doc, structure: [node], flatStructure: [node] },
    { color: false, showLineNumbers: false },
    { width: 20, height: 4 },
  );
  press(s, "\\", "j", "j", "j", "j", "j", "j", "j", "s");
  const nodeRow = 12;
  assert(
    s.view().top <= nodeRow && nodeRow < s.view().top + 3,
    "the continuation containing the node is visible",
  );
});

Deno.test("session: a wrapped use jump reveals its exact continuation", () => {
  const text = `const base = 1;${" ".repeat(70)}const use = base;${
    " ".repeat(70)
  }const tail = 2;`;
  const parsed = parseDocument(text);
  const base = parsed.flatStructure.find((node) => node.name === "base")!;
  const fallback = {
    ...base,
    label: "fallback",
    startCol: text.length - 15,
    endCol: text.length,
    startOffset: text.length - 15,
    endOffset: text.length,
    children: [],
  };
  const doc = {
    ...parsed,
    structure: [...parsed.structure, fallback],
    flatStructure: [...parsed.flatStructure, fallback],
  };
  const target = buildPeekCard(doc, base).targets.find((candidate) =>
    candidate.defOffset === undefined && candidate.destCol > base.endCol
  );
  assert(target, "the base card contains its distant use");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 20, height: 5 },
  );
  press(s, "\\");
  selectByLabel(s, base.label);
  press(s, "enter");
  for (let i = 0; i < 50; i++) {
    if (s.view().overlay?.selectedLine === target.cardLine) break;
    press(s, "down");
  }
  assertEquals(s.view().overlay?.selectedLine, target.cardLine);
  press(s, "z");

  const view = s.view();
  const plan = view.wrapPlan!;
  const targetRow = Math.min(
    plan.firstRow[target.destLine] +
      Math.floor(target.destCol / plan.rowStride),
    plan.lastRow[target.destLine],
  );
  assert(
    targetRow >= view.top && targetRow < view.top + view.height - 1,
    "the destination column is visible after the jump",
  );
});

Deno.test("session: navigation selects the node spanning the viewport top", () => {
  const text = "x".repeat(220);
  const doc = parseDocument(text);
  const template = doc.flatStructure[0]!;
  const before = {
    ...template,
    label: "before",
    startCol: 0,
    endCol: 70,
    startOffset: 0,
    endOffset: 70,
    children: [],
  };
  const visible = {
    ...template,
    label: "visible",
    startCol: 80,
    endCol: 200,
    startOffset: 80,
    endOffset: 200,
    children: [],
  };
  const s = new Session(
    { ...doc, structure: [before, visible], flatStructure: [before, visible] },
    { color: false, showLineNumbers: false },
    { width: 20, height: 4 },
  );
  press(s, "\\", "j", "j", "j", "j", "j", "s");
  assertEquals(s.view().selected?.label, "visible");
});

Deno.test("session: bare arrows scroll and pan the view", () => {
  const s = makeSession();
  press(s, "down", "down");
  assertEquals(s.view().top, 2, "down arrows scroll the view");
  press(s, "up");
  assertEquals(s.view().top, 1);
  press(s, "right");
  assertEquals(s.view().left, 8, "right pans the view");
  press(s, "left");
  assertEquals(s.view().left, 0);
});

Deno.test("session: alt+arrows scroll and pan the view", () => {
  const s = makeSession();
  const alt = (name: string): Key => ({ name, alt: true });
  s.handleKey(alt("down"));
  s.handleKey(alt("down"));
  assertEquals(s.view().top, 2, "alt+down scrolls");
  s.handleKey(alt("right"));
  assertEquals(s.view().left, 8, "alt+right pans");
  s.handleKey(alt("up"));
  assertEquals(s.view().top, 1);
  s.handleKey(alt("left"));
  assertEquals(s.view().left, 0);
});

Deno.test("session: incremental search then commit", () => {
  const s = makeSession();
  press(s, "/");
  assertEquals(s.view().inputLine, "/");
  press(s, "t", "o", "k", "e", "n");
  assertEquals(s.view().inputLine, "/token");
  // incremental matches available while typing
  assert((s.view().matches?.length ?? 0) > 0, "matches found incrementally");
  press(s, "enter");
  assertEquals(s.view().inputLine, null, "input committed");
  const count = s.view().matches!.length;
  assert(count > 0);
  // n advances the current match
  const before = s.view().currentMatch;
  press(s, "n");
  assert(s.view().currentMatch !== before || count === 1);
});

Deno.test("session: search miss reports a message", () => {
  const s = makeSession();
  press(s, "/");
  press(s, "z", "z", "z", "q", "q", "x");
  press(s, "enter");
  assert(
    s.view().message.toLowerCase().includes("not found"),
    `expected not-found message, got "${s.view().message}"`,
  );
});

Deno.test("session: escape cancels search input", () => {
  const s = makeSession();
  press(s, "/", "a", "b");
  assertEquals(s.view().inputLine, "/ab");
  press(s, "escape");
  assertEquals(s.view().inputLine, null);
});

Deno.test("session: WASD does four distinct moves (sibling/sibling/parent/child)", () => {
  const s = makeSession();
  assertEquals(s.view().selected, null);
  press(s, "s"); // first press just establishes a selection
  const start = s.view().selected!;
  assert(start, "a node is selected");

  // s -> next sibling: a different node at the same depth
  press(s, "s");
  const sib = s.view().selected!;
  assert(sib !== start, "s advanced the selection");
  assertEquals(sib.depth, start.depth, "s moves among same-depth siblings");

  // w -> previous sibling: returns to the start
  press(s, "w");
  assertEquals(s.view().selected, start, "w returns to the previous sibling");

  // d -> first child: one level deeper
  press(s, "d");
  const child = s.view().selected!;
  assertEquals(child.depth, start.depth + 1, "d descends to a first child");

  // a -> parent: back to the start
  press(s, "a");
  assertEquals(s.view().selected, start, "a ascends to the parent");
});

Deno.test("session: Enter peeks the selected node, Esc closes", () => {
  const s = makeSession();
  press(s, "s", "s");
  const node = s.view().selected!;
  press(s, "enter");
  const ov = s.view().overlay;
  assert(ov, "overlay opened");
  assert(ov!.title.includes(node.label) || ov!.title.includes(node.kind));
  press(s, "escape");
  assertEquals(s.view().overlay, null, "overlay closed");
});

Deno.test("session: Enter opens an info card; Tab toggles info ⇄ source", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
  );
  press(s, "s", "s"); // select a section (has both an outline and source)
  press(s, "enter");
  const card = s.view().overlay!;
  assert(card, "card opened");
  const infoText = card.lines.map((l) => l.text).join("\n");
  assert(card.footer.includes("tab"), "footer advertises the toggle");

  press(s, "tab");
  const sourceText = s.view().overlay!.lines.map((l) => l.text).join("\n");
  assert(sourceText !== infoText, "tab switched to the source view");

  press(s, "tab");
  const backText = s.view().overlay!.lines.map((l) => l.text).join("\n");
  assertEquals(backText, infoText, "tab toggled back to the info card");
});

Deno.test("session: definition lookup overlay", () => {
  const s = makeSession();
  press(s, "t"); // enter deflookup
  assert(s.view().inputLine?.startsWith("definition:"));
  for (const ch of "myPattern") press(s, ch);
  press(s, "enter");
  const ov = s.view().overlay;
  assert(ov, "definition overlay opened");
  assert(ov!.title.includes("myPattern"));
});

Deno.test("session: line-number toggle cycles off → input → file → off", () => {
  const s = makeSession();
  assertEquals(s.view().showLineNumbers, false, "off to start");
  press(s, "#"); // → input position
  assertEquals(s.view().showLineNumbers, true);
  assert(s.view().message.includes("input"), s.view().message);
  // Input numbers are the document line (1-based) on each row.
  assertEquals(s.view().lineNumbers?.[0], 1);
  assertEquals(s.view().lineNumbers?.[2], 3);
  press(s, "#"); // → file / message line
  assert(s.view().message.includes("file"), s.view().message);
  assertEquals(s.view().showLineNumbers, true);
  press(s, "#"); // → off
  assertEquals(s.view().showLineNumbers, false);
  assertEquals(s.view().lineNumbers, null);
});

Deno.test("session: help overlay opens with ?", () => {
  const s = makeSession();
  press(s, "?");
  const ov = s.view().overlay;
  assert(ov, "help overlay open");
  assert(ov!.title.toLowerCase().includes("keys"));
});

Deno.test("session: c cycles the non-printable display mode and reports it", () => {
  const s = makeSession();
  assertEquals(s.view().displayMode, "pictures", "starts on the first mode");
  press(s, "c");
  assertEquals(s.view().displayMode, "ansi");
  assert(s.view().message.includes("ANSI color"), "reports the new mode");
  press(s, "c");
  assertEquals(s.view().displayMode, "hidden");
  press(s, "c");
  assertEquals(
    s.view().displayMode,
    "pictures",
    "wraps back to the first mode",
  );
});

Deno.test("session: a search reveal in a compacting mode scrolls to the display column", () => {
  // A wide line whose match sits far to the right of a control-code run, in a
  // narrow viewport so revealing it must scroll horizontally. Hidden mode
  // collapses the run, so the reveal counts display columns, not source columns.
  const tail = "x".repeat(40) + "NEEDLE";
  const doc = parseDocument(`a${"\x01".repeat(10)}${tail}\n`);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 20, height: 6 },
  );
  press(s, "c", "c"); // pictures → ansi → hidden
  assertEquals(s.view().displayMode, "hidden");
  press(s, "/");
  for (const ch of "NEEDLE") press(s, ch);
  press(s, "enter");
  // The 10-code run collapses to one ellipsis, so "NEEDLE" starts at display
  // column ~42, not its source column ~51. The viewport frames the display one.
  const left = s.view().left;
  assert(left > 0 && left <= 42, `reveal used a display column, left=${left}`);
});

Deno.test("session: resize reclamps scroll to the ordinary end", () => {
  const s = makeSession();
  press(s, "G");
  const bottomTop = s.view().top;
  s.resize(80, 100); // taller than the doc
  assertEquals(
    s.view().top,
    maxTop(s.displayDoc().lines.length, 100),
  );
  assert(bottomTop >= 0);
});

Deno.test("session: WASD never scrolls when the whole document fits", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 80, height: doc.lines.length + 5 }, // everything visible
  );
  press(s, "s");
  assertEquals(s.view().top, 0);
  for (let i = 0; i < doc.flatStructure.length + 2; i++) {
    press(s, "s");
    assertEquals(s.view().top, 0, "no scroll while everything is on screen");
  }
  // moving back up and across should also not scroll
  press(s, "w", "a", "d");
  assertEquals(s.view().top, 0);
});

Deno.test("session: WASD scrolls only when the selection anchor leaves the screen", () => {
  const doc = parseDocument(SAMPLE);
  const height = 8;
  const rows = height - 1;
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 80, height },
  );
  // Descend into a section whose children (depth 1) span the whole document, so
  // walking the siblings with `s` forces some moves off-screen and others not.
  press(s, "s"); // first section
  press(s, "s"); // its sibling section (the larger block)
  press(s, "d"); // first child (depth 1)
  assertEquals(s.view().top, 0, "anchors near the top so far — no scroll yet");

  let scrolled = false;
  for (let i = 0; i < doc.flatStructure.length; i++) {
    const beforeTop = s.view().top;
    const beforeSel = s.view().selected;
    press(s, "s"); // walk the depth-1 siblings down the file
    const sel = s.view().selected!;
    if (sel === beforeSel) break; // reached the last sibling (no-op)
    const afterTop = s.view().top;
    // The selection anchor is always on screen after a move.
    assert(
      sel.startLine >= afterTop && sel.startLine <= afterTop + rows - 1,
      `anchor ${sel.startLine} visible in [${afterTop}, ${
        afterTop + rows - 1
      }]`,
    );
    // No scroll when the anchor was already visible; scroll only otherwise.
    if (sel.startLine >= beforeTop && sel.startLine <= beforeTop + rows - 1) {
      assertEquals(
        afterTop,
        beforeTop,
        "no scroll when anchor already visible",
      );
    } else {
      scrolled = true;
    }
  }
  assert(scrolled, "walking across the document scrolled at least once");
});

Deno.test("session: Tab / Shift-Tab navigate depth-first", () => {
  const s = makeSession();
  press(s, "tab"); // first press establishes a selection
  const a = s.view().selected!;
  assert(a, "a node is selected");
  press(s, "tab"); // pre-order successor (descends into children)
  const b = s.view().selected!;
  assert(b !== a, "tab advanced");
  press(s, "shift-tab"); // pre-order predecessor
  assertEquals(s.view().selected, a, "shift-tab returns to the previous node");
});

/** Tab through the tree (depth-first) until a node with `label` is selected. */
function selectByLabel(s: Session, label: string): void {
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label === label) return;
    press(s, "tab");
  }
  throw new Error(`node not reached: ${label}`);
}

Deno.test("session: Enter in the card opens the selected reference's card", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter"); // open the info card
  const card = s.view().overlay!;
  assert(card, "card opened");
  assert(card.footer.includes("open"), "footer advertises 'open'");
  const before = card.title;

  press(s, "down"); // select the first reference
  assert(s.view().overlay!.selectedLine !== undefined, "a reference selected");

  press(s, "enter"); // open that reference's card (stay in the overlay)
  const ov = s.view().overlay!;
  assert(ov, "overlay stays open (navigated, not closed)");
  assert(ov.title !== before, "card now describes a different node");
  assertEquals(ov.selectedLine, undefined, "selection reset after navigating");
});

Deno.test("session: z closes the card and centers the main view on the target", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // select a reference
  press(s, "z"); // reveal it in the main view
  assertEquals(s.view().overlay, null, "card closed");
  assert(s.view().message.startsWith("→"), "reports the reveal");
  assert(s.view().selected, "a node is selected at the destination");
});

Deno.test("session: z frames the revealed node (centered when it fits)", () => {
  const doc = parseDocument(SAMPLE);
  const height = 14;
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height },
  );
  selectByLabel(s, "pattern myPattern");
  const node = s.view().selected!;
  press(s, "enter"); // open the card
  press(s, "z"); // reveal its own node, framed
  assertEquals(s.view().overlay, null, "card closed");
  assertEquals(
    s.view().top,
    frameTop(node.startLine, node.endLine, height, doc.lines.length),
    "viewport framed per frameTop",
  );
});

Deno.test("session: z with no reference selected reveals the card's own node", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  const subject = s.view().selected!; // the lift node
  press(s, "enter"); // open its card (no reference selected)
  press(s, "z"); // reveal the card's own subject
  assertEquals(s.view().overlay, null, "card closed");
  assertEquals(
    s.view().selected?.startOffset,
    subject.startOffset,
    "the card's own node is selected in the main view",
  );
});

Deno.test("session: card up at the first reference returns to scrolling the top", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // select first target
  assert(s.view().overlay!.selectedLine !== undefined);
  press(s, "up"); // deselect, back to top
  assertEquals(s.view().overlay!.selectedLine, undefined, "deselected");
});

Deno.test("session: opening an external definition shows that file", () => {
  const fileText = "export function ext(): boolean {\n  return true;\n}\n";
  const filePath = "/workspace/ext.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: (p) => p === filePath ? parseDocument(fileText).lines : null,
    definitionOf: () => [
      {
        name: "ext",
        filePath,
        fileOffset: 0,
        line: 1,
        preview: "return true;",
      },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts
const flag = ext();`);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter"); // open the card (it has the external `ext` reference)
  press(s, "down"); // select that reference
  assert(
    s.view().overlay!.selectedLine !== undefined,
    "a reference is selected",
  );
  press(s, "enter"); // open the external file
  const ov = s.view().overlay!;
  assert(ov, "overlay open");
  assert(ov.title.includes("ext.ts"), `title names the file: ${ov.title}`);
  const text = ov.lines.map((l) => l.text).join("\n");
  assert(
    text.includes("export function ext"),
    "shows the external file's source",
  );
});

Deno.test("session: an external definition opens framed at its line", () => {
  const fileText = Array.from({ length: 21 }, (_, i) => `line ${i}`).join("\n");
  const filePath = "/workspace/ext.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: (p) => p === filePath ? parseDocument(fileText).lines : null,
    definitionOf: () => [
      { name: "ext", filePath, fileOffset: 0, line: 10, preview: "" },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts
const flag = ext();`);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter"); // open the card
  press(s, "down"); // select the external reference
  press(s, "enter"); // open the file
  const ov = s.view().overlay!;
  assert(ov.title.includes("ext.ts"), `title names the file: ${ov.title}`);
  assertEquals(ov.scroll, 8, "framed two lines above the definition (line 10)");
});

Deno.test("session: WASD preserves horizontal scroll", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 24, height: doc.lines.length + 5 },
  );
  press(s, "l", "l"); // pan right
  const leftBefore = s.view().left;
  assert(leftBefore > 0, "panned right");
  press(s, "s", "s", "w");
  assertEquals(
    s.view().left,
    leftBefore,
    "horizontal scroll preserved by WASD",
  );
});

Deno.test("session: the help overlay documents file folding and scrolling", () => {
  const s = makeSession();
  press(s, "?");
  const ov = s.view().overlay!;
  const text = ov.lines.map((l) => l.text).join("\n");
  assert(text.includes("Diff files"), "has a Diff files section");
  assert(/hide\s*\/\s*show/.test(text), "documents hide/show");
  assert(text.includes("hide all files"), "documents hide all");
  assert(text.includes("show test"), "documents toggling test files");
  assert(text.includes("Markdown files"), "documents toggling Markdown files");
  assert(
    text.includes("line wrapping: off / hard / word"),
    "documents line wrapping",
  );
  assert(
    ov.lines.some((line) =>
      line.text.includes("^L") &&
      line.text.includes("reveal more context at the marked edge")
    ),
    "documents the pager's Ctrl-L marker and its key",
  );
  assert(
    ov.footer.includes("scroll"),
    `footer advertises scrolling: ${ov.footer}`,
  );
});

Deno.test("session: an info card is a dialog; its source view is a blue window", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
  );
  press(s, "s", "s"); // select a section (has both a card and a source view)
  press(s, "enter");
  assert(!s.view().overlay?.sourceView, "the info card is a dialog");
  press(s, "tab"); // toggle to source
  assert(s.view().overlay?.sourceView, "its source view is a source window");
  press(s, "tab"); // back to the card
  assert(!s.view().overlay?.sourceView, "toggled back to the dialog");
});
