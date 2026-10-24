import { assert, assertEquals } from "@std/assert";
import {
  bgCode,
  cellOf,
  fgCode,
  parseDocument,
  SAMPLE,
} from "./view-helpers.ts";
import { ui } from "../lib/view/theme.ts";
import {
  _internal,
  cursorScreenPos,
  dialogBox,
  dialogButtonAt,
  type DialogState,
  type Match,
  overlayBox,
  type OverlayState,
  renderFrame,
  type ViewState,
} from "../lib/view/render.ts";
import { stripAnsi } from "../lib/view/ansi.ts";
import type { StructureKind, StructureNode } from "../lib/view/model.ts";

function baseView(over: Partial<ViewState> = {}): ViewState {
  return {
    top: 0,
    left: 0,
    width: 50,
    height: 10,
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
    ...over,
  };
}

/** A minimal structure node with an arbitrary kind, for status-line rendering
 * (the renderer only reads kind/label and the line/col extent). */
function node(
  kind: StructureKind,
  over: Partial<StructureNode> = {},
): StructureNode {
  return {
    kind,
    label: `${kind} thing`,
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 0,
    startOffset: 0,
    endOffset: 0,
    depth: 0,
    children: [],
    ...over,
  };
}

//
// cursorScreenPos / layout
//

Deno.test("cursorScreenPos: null when there is no cursor", () => {
  const doc = parseDocument(SAMPLE);
  assertEquals(cursorScreenPos(doc, baseView()), null);
});

Deno.test("cursorScreenPos: null when an overlay covers the content", () => {
  const doc = parseDocument(SAMPLE);
  const overlay: OverlayState = {
    title: "x",
    lines: [],
    scroll: 0,
    footer: "f",
  };
  const view = baseView({ cursor: { line: 1, col: 2 }, overlay });
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: maps document coords to 1-based screen coords", () => {
  const doc = parseDocument(SAMPLE);
  // cursor on line 2 (index 2), column 4; no gutter, no guide.
  const view = baseView({ cursor: { line: 2, col: 4 }, top: 0 });
  const pos = cursorScreenPos(doc, view);
  // r = line - top = 2; row = r + 1 = 3. col = gutter(0)+guide(0)+contentCol(4)+1
  assertEquals(pos, { row: 3, col: 5 });
});

Deno.test("cursorScreenPos: maps a wrapped continuation to its screen row", () => {
  const doc = parseDocument("abcdefghij");
  const view = baseView({
    cursor: { line: 0, col: 7 },
    width: 5,
    height: 4,
    wrapMode: "hard",
  });
  assertEquals(cursorScreenPos(doc, view), { row: 2, col: 4 });
});

Deno.test("cursorScreenPos: rejects a cursor outside the document", () => {
  const doc = parseDocument("one line");
  assertEquals(
    cursorScreenPos(doc, baseView({ cursor: { line: 4, col: 0 } })),
    null,
  );
});

Deno.test("cursorScreenPos: accounts for the line-number gutter and guide bar", () => {
  const doc = parseDocument(SAMPLE);
  const sel = node("pattern", { startLine: 0, endLine: 5 });
  const view = baseView({
    cursor: { line: 1, col: 0 },
    showLineNumbers: true,
    selected: sel,
  });
  const pos = cursorScreenPos(doc, view);
  assert(pos !== null, "cursor visible");
  // gutter width is max(4, len(String(lines.length))+1) and guide width is 1.
  const gutterWidth = Math.max(4, String(doc.lines.length).length + 1);
  const guideWidth = 1;
  assertEquals(pos, { row: 2, col: gutterWidth + guideWidth + 0 + 1 });
});

Deno.test("cursorScreenPos: null when the cursor row is scrolled above the top", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({ cursor: { line: 0, col: 0 }, top: 3 });
  // r = 0 - 3 = -3 < 0
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when the cursor row is below the content area", () => {
  const doc = parseDocument(SAMPLE);
  // contentHeight = height - 1 = 4; r must be < 4. line - top = 5 -> off screen.
  const view = baseView({ cursor: { line: 5, col: 0 }, top: 0, height: 5 });
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when the cursor column is scrolled off to the left", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({ cursor: { line: 1, col: 2 }, left: 5 });
  // contentCol = 2 - 5 = -3 < 0
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when the cursor column is past the content width", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({ cursor: { line: 1, col: 100 }, width: 20 });
  // contentCol = 100 >= contentWidth
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when a dialog covers the content", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({
    cursor: { line: 1, col: 2 },
    dialog: { title: "Save", body: ["Save?"], buttons: [] },
  });
  assertEquals(cursorScreenPos(doc, view), null);
});

//
// notice rows
//

Deno.test("renderFrame: notice overwrites the bottom content rows", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({
    height: 6,
    notice: ["save to a.ts", "save to b.ts"],
  });
  const rows = renderFrame(doc, view);
  const text = rows.map(stripAnsi);
  // contentHeight = 5; notice has 2 lines -> rows 3 and 4 carry it.
  assert(text[3].includes("save to a.ts"), `row 3: "${text[3]}"`);
  assert(text[4].includes("save to b.ts"), `row 4: "${text[4]}"`);
  // status line (last row) is untouched by the notice band.
  assert(text[5].includes("/"), "status row preserved");
});

Deno.test("renderFrame: a notice taller than the content clamps to the top row", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({
    height: 4,
    color: false,
    notice: ["one", "two", "three", "four", "five"],
  });
  const rows = renderFrame(doc, view);
  const text = rows.map(stripAnsi);
  // contentHeight = 3; start = max(0, 3 - 5) = 0. The first three notice
  // entries fill the three content rows, the rest are dropped.
  assertEquals(text[0].trimEnd(), "one");
  assertEquals(text[1].trimEnd(), "two");
  assertEquals(text[2].trimEnd(), "three");
});

Deno.test("renderFrame: an empty notice array leaves content untouched", () => {
  const doc = parseDocument(SAMPLE);
  const withNotice = renderFrame(doc, baseView({ notice: [] }));
  const without = renderFrame(doc, baseView({ notice: null }));
  assertEquals(withNotice, without);
});

//
// selectionSpan: schema / closure / selection backgrounds
//

Deno.test("renderFrame: a schema node tints its line", () => {
  const doc = parseDocument("const x = 1;\n");
  const sel = node("schema", {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 11,
  });
  const rows = renderFrame(doc, baseView({ selected: sel, width: 40 }));
  // schemaRegionBg is applied; some cell carries a 48;2; background.
  assert(/48;2;/.test(rows[0]), "schema region tinted");
});

Deno.test("renderFrame: a closure node tints its line", () => {
  const doc = parseDocument("const x = 1;\n");
  const sel = node("closure", {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 11,
  });
  const rows = renderFrame(doc, baseView({ selected: sel, width: 40 }));
  assert(/48;2;/.test(rows[0]), "closure region tinted");
});

Deno.test("renderFrame: a plain node uses the selection background", () => {
  const doc = parseDocument("const x = 1;\n");
  const sel = node("variable", {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 11,
  });
  const rows = renderFrame(doc, baseView({ selected: sel, width: 40 }));
  assert(/48;2;/.test(rows[0]), "selection region tinted");
});

//
// search-match column clamping
//

Deno.test("renderFrame: search matches off the left edge are clipped", () => {
  const doc = parseDocument("hello world\n");
  // Match spans columns 0..5 but the view is scrolled right by 3, so the first
  // three match columns fall before the visible area (idx < 0 -> continue).
  const matches: Match[] = [{ line: 0, start: 0, end: 5 }];
  const rows = renderFrame(doc, baseView({ matches, left: 3, width: 20 }));
  // The remaining match columns (3,4) still highlight: a search bg is present.
  assert(/48;2;/.test(rows[0]), "visible part of the match still highlighted");
});

Deno.test("renderFrame: search matches off the right edge are clipped", () => {
  const doc = parseDocument("hello world\n");
  const matches: Match[] = [{ line: 0, start: 0, end: 11 }];
  // width 4 -> contentWidth small; match columns past it (idx >= width) skip.
  const rows = renderFrame(doc, baseView({ matches, width: 4 }));
  assert(/48;2;/.test(rows[0]), "in-bounds match columns highlighted");
});

//
// renderStatus branches
//

Deno.test("renderStatus: the input line replaces the status bar", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ inputLine: "/token", color: false }),
  );
  const status = rows[rows.length - 1];
  assertEquals(status.trimEnd(), "/token");
  // no status content (no slash position string) leaks through.
  assert(!status.includes("help"), "navigation help suppressed in input mode");
});

Deno.test("renderStatus: a message takes priority on the status bar", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ message: "Pattern not found", color: false }),
  );
  assert(stripAnsi(rows[rows.length - 1]).includes("Pattern not found"));
});

Deno.test("renderStatus: an edit hint shows when there is no message", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      editHint: [{ key: "Esc", label: "Done" }, { key: "^Y", label: "Yank" }],
      color: false,
    }),
  );
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("Esc Done"), `edit hint shown: "${status}"`);
});

Deno.test("renderStatus: key hints are highlighted in color", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ editHint: [{ key: "Esc", label: "Done" }], color: true }),
  );
  const status = rows[rows.length - 1];
  // The key is painted in the status-key color on the status-bar background.
  assert(status.includes(fgCode(ui.statusKey.fg!)), "the key color");
  assert(status.includes(bgCode(ui.statusBar.bg!)), "on the status bar");
});

Deno.test("renderStatus: a selected node shows its glyph and label", () => {
  const doc = parseDocument(SAMPLE);
  const sel = node("pattern", { label: "pattern myPattern" });
  const rows = renderFrame(doc, baseView({ selected: sel, color: false }));
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("◆"), `pattern glyph present: "${status}"`);
  assert(status.includes("pattern myPattern"), "label present");
});

Deno.test("renderStatus: the default help line advertises expand when allowed", () => {
  const doc = parseDocument(SAMPLE);
  // Wide enough that every hint fits (the bar drops trailing hints when narrow).
  const rows = renderFrame(
    doc,
    baseView({ canExpand: true, color: false, width: 80 }),
  );
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("? Help"), "default help shown");
  assert(status.includes("^L Expand"), "expand hint advertised");
});

Deno.test("renderStatus: the default help line omits expand when not allowed", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ canExpand: false, color: false, width: 80 }),
  );
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("? Help"), "default help shown");
  assert(!status.includes("^L Expand"), "expand hint absent");
});

Deno.test("renderStatus: the view hint names the alternate representation", () => {
  const doc = parseDocument(SAMPLE);
  const line = (viewMode: "source" | "rendered") =>
    stripAnsi(
      renderFrame(
        doc,
        baseView({
          canRender: true,
          color: false,
          viewMode,
          width: 100,
        }),
      ).at(-1)!,
    );
  const source = line("source");
  const rendered = line("rendered");
  assert(source.includes("V Rendered"), source);
  assert(rendered.includes("V Source"), rendered);
});

Deno.test("renderStatus: e / C / # hints appear only where they apply", () => {
  const doc = parseDocument(SAMPLE);
  const line = (over: Partial<ViewState>) =>
    stripAnsi(
      renderFrame(doc, baseView({ color: false, width: 100, ...over }))
        .at(-1)!,
    );
  // Editable + non-printables present: e and C both show. # always shows.
  const both = line({ canEdit: true, hasNonPrintables: true });
  assert(both.includes("e Edit"), both);
  assert(both.includes("C Chars"), both);
  assert(both.includes("# Lines"), both);
  // Read-only with only printable content: e and C are dropped, # stays.
  const neither = line({ canEdit: false, hasNonPrintables: false });
  assert(!neither.includes("e Edit"), neither);
  assert(!neither.includes("C Chars"), neither);
  assert(neither.includes("\\ Hard wrap"), neither);
  assert(neither.includes("# Lines"), neither);
  const hardWrapped = line({ wrapMode: "hard" });
  assert(hardWrapped.includes("\\ Word wrap"), hardWrapped);
  const wordWrapped = line({ wrapMode: "word" });
  assert(wordWrapped.includes("\\ Unwrap"), wordWrapped);
});

Deno.test("renderStatus: a narrow bar drops the lowest-priority hints first", () => {
  const doc = parseDocument(SAMPLE);
  const all = { canExpand: true, canEdit: true, hasNonPrintables: true };
  const line = (width: number) =>
    stripAnsi(
      renderFrame(doc, baseView({ color: false, width, ...all })).at(-1)!,
    );
  // At a middling width the top priorities survive and the tail (#, then C, e,
  // ^L) is dropped; ? always outlives WASD.
  const mid = line(46);
  assert(mid.includes("? Help") && mid.includes("/ Search"), mid);
  assert(!mid.includes("# Lines"), "the lowest-priority # drops first");
  // Very narrow: only the highest priorities remain.
  const tight = line(28);
  assert(tight.includes("? Help") && tight.includes("Q Quit"), tight);
  assert(!tight.includes("WASD Tree"), "WASD drops before Q");
});

//
// kindGlyph: every branch
//

Deno.test("renderStatus: kindGlyph maps every node kind to a glyph", () => {
  const doc = parseDocument("x\n");
  const cases: Array<[StructureKind, string]> = [
    ["section", "▸"],
    ["pattern", "◆"],
    ["builder", "◇"],
    ["closure", "λ"],
    ["schema", "▦"],
    ["function", "ƒ"],
    ["method", "ƒ"],
    ["interface", "𝑻"],
    ["typeAlias", "𝑻"],
    ["class", "𝑻"],
    ["return", "⏎"],
    ["control", "⎇"],
    ["hunk", "±"],
    ["comment", "#"],
    // a kind with no dedicated glyph falls through to the default bullet.
    ["statement", "·"],
  ];
  for (const [kind, glyph] of cases) {
    const sel = node(kind, { label: `${kind} x` });
    const rows = renderFrame(doc, baseView({ selected: sel, color: false }));
    const status = stripAnsi(rows[rows.length - 1]);
    assert(
      status.includes(glyph),
      `kind ${kind} -> glyph ${glyph}, got "${status}"`,
    );
  }
});

//
// display modes: tabs and control characters
//

Deno.test("renderFrame: a tab renders as its Control Pictures glyph", () => {
  const doc = parseDocument("a\tb\n");
  const rows = renderFrame(doc, baseView({ color: false }));
  // The default "pictures" mode shows the tab as ␉ (U+2409), one column wide.
  assertEquals(stripAnsi(rows[0]).slice(0, 3), "a␉b");
  assert(!rows[0].includes("\t"), "no raw tab in output");
});

Deno.test("renderFrame: a control character renders as its Control Pictures glyph", () => {
  // The line text carries a control char (\x01) between "a" and "b".
  const doc = parseDocument("a\x01b\n");
  const rows = renderFrame(doc, baseView({ color: false }));
  const text = stripAnsi(rows[0]);
  // U+0001 → U+2401 (␁), one column wide, and the raw byte is gone.
  assertEquals(text.slice(0, 3), "a␁b");
  assert(!text.includes("\x01"), "control char scrubbed");
});

//
// overlay: span past the inner width / truncCenter truncation
//

Deno.test("overlay: a span wider than the box is clipped at the inner edge", () => {
  const doc = parseDocument(SAMPLE);
  const wide = "X".repeat(200);
  const rows = renderFrame(
    doc,
    baseView({
      width: 50,
      height: 16,
      overlay: {
        title: "PEEK",
        lines: [{ text: wide, spans: [{ col: 0, text: wide, cls: "plain" }] }],
        scroll: 0,
        footer: "esc",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  // The body shows some X's but the span is clipped at the inner box edge
  // rather than spilling over.
  assert(joined.includes("X"), "overlay body rendered");
  const bodyRow = rows.map(stripAnsi).find((r) => r.includes("X"))!;
  assertEquals(
    bodyRow.length,
    50,
    "the body row is exactly the terminal width",
  );
  // The clipped run of X's is bounded by the inner box width, far short of 200.
  const runLen = bodyRow.match(/X+/)![0].length;
  assert(runLen < 50, `wide span clipped to the box, run length ${runLen}`);
});

Deno.test("overlay: a title longer than the box is truncated to fit", () => {
  const doc = parseDocument(SAMPLE);
  const box = overlayBox(50, 16);
  // A title far wider than the inner box width forces truncCenter's truncation
  // path (len >= width).
  const longTitle = "T".repeat(box.boxW + 40);
  const rows = renderFrame(
    doc,
    baseView({
      width: 50,
      height: 16,
      overlay: {
        title: longTitle,
        lines: [],
        scroll: 0,
        footer: "esc",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  // The truncated title appears but the top border row is no wider than the box.
  assert(joined.includes("TTT"), "truncated title still visible");
  const topRow = rows.find((r) => stripAnsi(r).includes("╔"))!;
  assert(stripAnsi(topRow).includes("TTT"), "title sits on the top border");
});

Deno.test("overlay: a selected reference line is tinted differently", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 50,
      height: 16,
      color: true,
      overlay: {
        title: "REFS",
        lines: [
          { text: "one", spans: [{ col: 0, text: "one", cls: "plain" }] },
          { text: "two", spans: [{ col: 0, text: "two", cls: "plain" }] },
        ],
        scroll: 0,
        footer: "esc",
        selectedLine: 1,
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(joined.includes("two"), "selected ref line rendered");
});

Deno.test("overlay: content sits one column inside each border", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 40,
      height: 12,
      color: false,
      overlay: {
        title: "PEEK",
        lines: [{ text: "hi", spans: [{ col: 0, text: "hi", cls: "plain" }] }],
        scroll: 0,
        footer: "esc",
      },
    }),
  );
  const bodyRow = rows.map(stripAnsi).find((r) => r.includes("hi"))!;
  const left = bodyRow.indexOf("║");
  const right = bodyRow.indexOf("║", left + 1);
  // A blank margin column separates the left border from the content, and the
  // content ends before the right margin column.
  assertEquals(bodyRow[left + 1], " ", "left margin column is blank");
  assertEquals(bodyRow.slice(left + 2, left + 4), "hi", "content after margin");
  assertEquals(bodyRow[right - 1], " ", "right margin column is blank");
});

const SAVE_DIALOG: DialogState = {
  title: "Save Changes",
  body: ["Save changes to schemas.tsx?"],
  buttons: [
    { label: "Save", hotkey: "s", kind: "default" },
    { label: "Discard", hotkey: "d" },
    { label: "Cancel", hotkey: "c", kind: "cancel" },
  ],
};

Deno.test("dialog: frames a centered title, body and button row", () => {
  const rows = renderFrame(
    parseDocument(SAMPLE),
    baseView({ width: 60, height: 18, color: false, dialog: SAVE_DIALOG }),
  );
  const text = rows.map(stripAnsi);
  const joined = text.join("\n");
  assert(joined.includes("Save Changes"), "title shown");
  assert(joined.includes("Save changes to schemas.tsx?"), "body shown");
  const btnRow = text.find((r) => r.includes("Save") && r.includes("Cancel"))!;
  assert(btnRow.includes("Discard"), btnRow);
  assert(joined.includes("╔") && joined.includes("╝"), "double-line frame");
  // The status bar shows the dialog's buttons in place of the browse hints.
  const status = text[text.length - 1];
  assert(status.includes("Save") && status.includes("Cancel"), status);
  assert(!status.includes("WASD"), "no navigation hints while a dialog is up");
});

Deno.test("dialog: the default button is brighter and the shortcuts are yellow", () => {
  const rows = renderFrame(
    parseDocument("x\n"),
    baseView({ width: 60, height: 18, color: true, dialog: SAVE_DIALOG }),
  );
  const raw = rows.join("");
  const face = bgCode(ui.button.bg!);
  assert(raw.includes(face), "button face color");
  assert(
    raw.includes(fgCode(ui.buttonDefault.fg!) + ";" + face),
    "default-button label color on the face",
  );
  assert(
    raw.includes(fgCode(ui.buttonKey.fg!) + ";" + face),
    "shortcut-letter color on the face",
  );
  // The button shadows are half-block glyphs, not solid cells.
  const plain = stripAnsi(raw);
  assert(plain.includes("▄") && plain.includes("▀"), "half-block shadows");
});

Deno.test("dialog: a button-less dialog still frames its body", () => {
  const rows = renderFrame(
    parseDocument("x\n"),
    baseView({
      width: 40,
      height: 12,
      color: false,
      dialog: { title: "Note", body: ["Nothing to do."], buttons: [] },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(joined.includes("Note"), "title");
  assert(joined.includes("Nothing to do."), "body");
});

Deno.test("dialog: a button is hit exactly where it is drawn, at rest or pushed", () => {
  const view = baseView({ width: 60, height: 18, color: false });
  const drawn = (pushed: number) =>
    renderFrame(parseDocument("x\n"), {
      ...view,
      dialog: { ...SAVE_DIALOG, pushed },
    }).map(stripAnsi);
  const box = dialogBox(view, SAVE_DIALOG);
  const atRest = drawn(-1);
  const buttonRow = atRest.findIndex((row, y) =>
    y > box.y && y < box.y + box.boxH && row.includes(" Discard ")
  );
  // The columns each button's face covers, at rest and pushed.
  const faces = SAVE_DIALOG.buttons.map((b, i) =>
    [atRest, drawn(i)].map((rows) => {
      const from = rows[buttonRow].indexOf(` ${b.label} `);
      return { from, to: from + b.label.length + 2 };
    })
  );
  for (let y = 0; y < view.height; y++) {
    for (let x = 0; x < view.width; x++) {
      const expected = y !== buttonRow
        ? -1
        : faces.findIndex((spans) =>
          spans.some((f) => x >= f.from && x < f.to)
        );
      assertEquals(
        dialogButtonAt(view, SAVE_DIALOG, x, y),
        expected,
        `cell ${x}, ${y}`,
      );
    }
  }
});

Deno.test("dialog: no button is hit where the box has no room to draw it", () => {
  // Too short for the body and the buttons both: the body is drawn instead.
  const short = baseView({ width: 60, height: 8, color: false });
  const dialog = { ...SAVE_DIALOG, body: ["one", "two", "three"] };
  const rows = renderFrame(parseDocument("x\n"), { ...short, dialog });
  const { y: top, boxH } = dialogBox(short, dialog);
  assert(
    !rows.slice(top, top + boxH).some((row) =>
      stripAnsi(row).includes("Discard")
    ),
    "the box shows no buttons",
  );
  for (let y = 0; y < short.height; y++) {
    for (let x = 0; x < short.width; x++) {
      assertEquals(dialogButtonAt(short, dialog, x, y), -1, `cell ${x}, ${y}`);
    }
  }

  // Too narrow for the button row: Cancel is cut off at the border.
  const narrow = baseView({ width: 30, height: 18, color: false });
  const box = dialogBox(narrow, SAVE_DIALOG);
  const { y } = cellOf(
    renderFrame(parseDocument("x\n"), { ...narrow, dialog: SAVE_DIALOG }),
    " Discard ",
  );
  const border = box.x + box.boxW - 1;
  assertEquals(dialogButtonAt(narrow, SAVE_DIALOG, border - 1, y), 2);
  assertEquals(dialogButtonAt(narrow, SAVE_DIALOG, border, y), -1);
});

Deno.test("dialog: collapses on a terminal too narrow to frame", () => {
  const dlg: DialogState = {
    title: "T",
    body: ["hi"],
    buttons: [{ label: "Ok", hotkey: "o", kind: "default" }],
  };
  // At each width the box shrinks; below the border chrome it draws nothing
  // rather than indexing out of range, but always returns a full frame.
  for (const width of [3, 4, 6]) {
    const rows = renderFrame(
      parseDocument("x\n"),
      baseView({ width, height: 12, color: false, dialog: dlg }),
    );
    assertEquals(rows.length, 12, `full frame at width ${width}`);
  }
  assert(
    dialogBox(baseView({ width: 3, height: 12 }), dlg).boxW < 2,
    "collapses",
  );
});

Deno.test("dialog: body sits two columns inside each border", () => {
  const rows = renderFrame(
    parseDocument("x\n"),
    baseView({
      width: 40,
      height: 12,
      color: false,
      dialog: { title: "T", body: ["hello world"], buttons: [] },
    }),
  );
  const bodyRow = rows.map(stripAnsi).find((r) => r.includes("hello world"))!;
  const left = bodyRow.indexOf("║");
  const right = bodyRow.indexOf("║", left + 1);
  // Two blank margin columns separate the border from the content on each side.
  assertEquals(
    bodyRow.slice(left + 1, left + 3),
    "  ",
    "two blank columns after the left border",
  );
  assertEquals(
    bodyRow.slice(left + 3, left + 3 + "hello world".length),
    "hello world",
    "content begins after the margin",
  );
  assertEquals(
    bodyRow.slice(right - 2, right),
    "  ",
    "two blank columns before the right border",
  );
});

Deno.test("dialog: program output starts two columns inside a box as wide as its stated width", () => {
  const widest = "x".repeat(20);
  const rows = renderFrame(
    parseDocument("x\n"),
    baseView({
      width: 120,
      height: 12,
      color: false,
      dialog: {
        title: "Push",
        body: ["To origin", widest],
        output: true,
        width: 20,
        buttons: [],
      },
    }),
  ).map(stripAnsi);
  const shortRow = rows.find((r) => r.includes("To origin"))!;
  const left = shortRow.indexOf("║");
  assertEquals(
    shortRow.slice(left, left + 3 + "To origin".length),
    "║  To origin",
  );
  const widestRow = rows.find((r) => r.includes(widest))!;
  assertEquals(widestRow.slice(left, left + 26), `║  ${widest}  ║`);
});

Deno.test("dialog: the focused button — not just the default — is highlighted", () => {
  const dlg: DialogState = {
    title: "Pick",
    body: ["Which one?"],
    buttons: [
      { label: "One", hotkey: "o" },
      { label: "Two", hotkey: "t" },
    ],
  };
  const render = (focus?: number) =>
    renderFrame(
      parseDocument("x\n"),
      baseView({
        width: 40,
        height: 12,
        color: true,
        dialog: { ...dlg, focus },
      }),
    );
  // The bright face is the default-button color on the button-face background;
  // it only appears where a button is highlighted.
  const brightFace = fgCode(ui.buttonDefault.fg!) + ";" + bgCode(ui.button.bg!);

  // No focus and no default kind: no button is brightened.
  assert(
    !render(-1).join("").includes(brightFace),
    "nothing highlighted without focus",
  );

  // Focusing a button brightens that button, and moving focus moves the bright
  // face to the newly focused label.
  for (const [focus, label] of [[0, "One"], [1, "Two"]] as const) {
    const btnRow = render(focus).find((r) => stripAnsi(r).includes("One"))!;
    assert(btnRow.includes(brightFace), `button ${focus} is highlighted`);
    // Read past the rest of the bright face's escape (its closing `m`) to the
    // label text that follows it.
    const sgrEnd = btnRow.indexOf("m", btnRow.indexOf(brightFace)) + 1;
    const after = stripAnsi(btnRow.slice(sgrEnd)).trimStart();
    assert(
      after.startsWith(label),
      `the highlight sits on ${label}: ${after}`,
    );
  }
});

Deno.test("dialog: a pushed button loses its shadow and shifts one column right", () => {
  const dlg: DialogState = {
    title: "T",
    body: ["Go?"],
    buttons: [{ label: "Ok", hotkey: "o", kind: "default" }],
  };
  const render = (over: Partial<DialogState>) =>
    renderFrame(
      parseDocument("x\n"),
      baseView({
        width: 40,
        height: 12,
        color: true,
        dialog: { ...dlg, ...over },
      }),
    ).map(stripAnsi);

  const normal = render({});
  const pushed = render({ pushed: 0 });
  // The half-block shadow glyphs come only from the button; a press drops them.
  assert(
    normal.join("\n").includes("▀"),
    "a resting button casts a shadow band",
  );
  assert(
    normal.join("\n").includes("▄"),
    "a resting button casts a right edge",
  );
  assert(
    !pushed.join("\n").includes("▀"),
    "a pushed button casts no shadow band",
  );
  assert(
    !pushed.join("\n").includes("▄"),
    "a pushed button casts no right edge",
  );
  // The face slides one column into the space its shadow held.
  const normalRow = normal.find((r) => r.includes("Ok"))!;
  const pushedRow = pushed.find((r) => r.includes("Ok"))!;
  assertEquals(
    pushedRow.indexOf("Ok"),
    normalRow.indexOf("Ok") + 1,
    "the pressed face shifts right by one column",
  );
});

Deno.test("renderFrame: the guide rail is blank on lines outside the selected node", () => {
  const ln = (text: string) => ({
    text,
    spans: [{ col: 0, text, cls: "plain" as const }],
  });
  // A node confined to line 1 of a three-line document: lines 0 and 2 sit
  // outside its range, so their guide column is blank.
  const sel: StructureNode = {
    kind: "node",
    label: "mid",
    startLine: 1,
    endLine: 1,
    startCol: 0,
    endCol: 1,
    startOffset: 0,
    endOffset: 1,
    depth: 0,
    children: [],
  };
  const doc = {
    text: "a\nb\nc\n",
    lines: [ln("a"), ln("b"), ln("c")],
    structure: [sel],
    flatStructure: [sel],
    definitions: new Map(),
  };
  const rows = renderFrame(doc, baseView({ top: 0, selected: sel, height: 6 }));
  // No gutter, so the guide glyph is at column 0.
  assertEquals(stripAnsi(rows[0])[0], " ", "blank guide above the node");
  assertEquals(stripAnsi(rows[2])[0], " ", "blank guide below the node");
  assertEquals(stripAnsi(rows[1])[0], "▶", "single-line node carries a glyph");
});

//
// SGR encoding helpers (rich modifiers and background merge)
//

Deno.test("cellsToAnsi: encodes rich text attributes", () => {
  const cells = [
    { ch: "a", style: { dim: true } },
    { ch: "b", style: { italic: true } },
    { ch: "c", style: { underline: true } },
    { ch: "d", style: { strikethrough: true } },
  ];
  const out = _internal.cellsToAnsi(cells, true);
  assert(out.includes("\x1b[2m"), "dim → SGR 2");
  assert(out.includes("\x1b[3m"), "italic → SGR 3");
  assert(out.includes("\x1b[4m"), "underline → SGR 4");
  assert(out.includes("\x1b[9m"), "strikethrough → SGR 9");
});

Deno.test("mergeBg: overlays a background, or leaves the style when there is none", () => {
  const style = { fg: [1, 2, 3] as const, bold: true };
  // No background on the second argument: the style is returned unchanged.
  assertEquals(_internal.mergeBg(style, {}), style);
  // A background is merged over the style's own.
  assertEquals(
    _internal.mergeBg(style, { bg: [9, 9, 9] }),
    { fg: [1, 2, 3], bold: true, bg: [9, 9, 9] },
  );
});

Deno.test("darkenSpan: repaints a shadow span and clips out-of-bounds cells", () => {
  const view = baseView({ width: 11 });
  const rows = ["hello world"];
  const before = [...rows];
  // A row outside the frame, or a start at/past the right edge, changes nothing.
  _internal.darkenSpan(rows, view, -1, 0, 2);
  _internal.darkenSpan(rows, view, 0, 11, 2);
  assertEquals(rows, before, "out-of-bounds shadow cells are left alone");
  // A valid span repaints those cells (keeping their characters) in shadow.
  _internal.darkenSpan(rows, view, 0, 2, 3);
  assert(rows[0] !== before[0], "a valid span is repainted");
  assertEquals(stripAnsi(rows[0]), "hello world", "the characters are kept");
});

//
// status-bar fitting (file, and left truncation)
//

Deno.test("renderStatus: a long current file is tail-truncated with a leading ellipsis", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 44,
      color: false,
      currentFile: "packages/cli/lib/view/render.ts",
    }),
  );
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("…"), `truncated with an ellipsis: "${status}"`);
  assert(status.includes("render.ts"), "the file name (tail) is kept");
});

Deno.test("renderStatus: a long left label is head-truncated to fit", () => {
  const doc = parseDocument(SAMPLE);
  const sel = node("pattern", {
    label: "pattern " + "aVeryLongIdentifierName".repeat(4),
  });
  const rows = renderFrame(
    doc,
    baseView({ width: 40, color: false, selected: sel, currentFile: "x.ts" }),
  );
  const status = stripAnsi(rows[rows.length - 1]);
  assertEquals(status.length, 40, "the bar is exactly the terminal width");
  assert(status.includes("…"), `the label is truncated: "${status}"`);
});

Deno.test("renderStatus: control characters in the current file are shown as glyphs", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ width: 60, color: false, currentFile: "a\x1b[31mb\x07.ts" }),
  );
  const status = rows[rows.length - 1];
  assert(!status.includes("\x1b"), `no escape reaches the terminal: ${status}`);
  assert(!status.includes("\x07"), "no bell reaches the terminal");
  assert(status.includes("␛[31mb␇.ts"), `control pictures shown: ${status}`);
  assertEquals(status.length, 60, "the bar is exactly the terminal width");
});

Deno.test("dialog: control characters in the body are shown as glyphs", () => {
  const rows = renderFrame(
    parseDocument("x\n"),
    baseView({
      width: 60,
      height: 18,
      color: false,
      dialog: {
        title: "Save Changes",
        body: ["Save a\x1b[31mb\x07.ts?"],
        buttons: [],
      },
    }),
  );
  // The frame carries its own resets even without color, so the check is that
  // the body's own escape and bell are not among what reaches the terminal.
  const joined = rows.join("\n");
  assert(!joined.includes("\x1b[31m"), "the body's escape is not passed on");
  assert(!joined.includes("\x07"), "no bell reaches the terminal");
  assert(joined.includes("Save a␛[31mb␇.ts?"), `control pictures: ${joined}`);
});

Deno.test("renderStatus: an over-wide input line is returned as-is", () => {
  const doc = parseDocument(SAMPLE);
  const long = "/" + "x".repeat(60);
  const rows = renderFrame(doc, baseView({ width: 20, inputLine: long }));
  assertEquals(stripAnsi(rows[rows.length - 1]), long);
});

Deno.test("renderStatus: on a tiny terminal the left collapses to an ellipsis", () => {
  const doc = parseDocument(SAMPLE);
  const sel = node("pattern", { label: "pattern longName" });
  const rows = renderFrame(
    doc,
    baseView({
      width: 14,
      color: false,
      selected: sel,
      currentFile: "a/b/c.ts",
    }),
  );
  assert(stripAnsi(rows[rows.length - 1]).includes("…"), "left collapses");
});
