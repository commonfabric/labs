import { assert, assertEquals } from "@std/assert";

import { stripAnsi, visibleWidth } from "../lib/view/ansi.ts";
import { renderLineColored } from "../lib/view/highlight.ts";
import {
  _internal,
  labeledDiffMetadataLine,
  overlayBox,
  renderFrame,
  type ViewState,
} from "../lib/view/render.ts";
import { lineBg, styleFor, ui } from "../lib/view/theme.ts";
import { bgCode, fgCode, parseDocument, SAMPLE } from "./view-helpers.ts";

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

function diffView(over: Partial<ViewState> = {}): ViewState {
  return baseView({ isDiff: true, ...over });
}

/** The editor background sits behind every cell, so a "highlighted" cell is one
 * whose background is some OTHER color (a selection tint, a search match, a
 * diff row). */
const EDITOR_BG = bgCode(ui.editorBg);

/** Per-visible-column flag: does each cell carry a background other than the
 * editor blue? (The renderer emits a self-contained SGR after each RESET, so a
 * run's params carry its bg; RESET clears it.) */
function bgColumns(row: string): boolean[] {
  const out: boolean[] = [];
  let bg = false;
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\x1b") {
      // deno-lint-ignore no-control-regex
      const m = row.slice(i).match(/^\x1b\[([0-9;]*)m/);
      if (m) {
        bg = m[1] === "0" || m[1] === ""
          ? false
          : /48;2;/.test(m[1]) && !m[1].includes(EDITOR_BG);
        i += m[0].length;
        continue;
      }
    }
    out.push(bg);
    i += 1;
  }
  return out;
}

/** Background color active at one visible column, as an RGB tuple string. */
function bgAtColumn(row: string, target: number): string | null {
  let bg: string | null = null;
  let col = 0;
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\x1b") {
      // deno-lint-ignore no-control-regex
      const sgr = row.slice(i).match(/^\x1b\[([0-9;]*)m/);
      if (sgr) {
        if (sgr[1] === "0" || sgr[1] === "") bg = null;
        const rgb = sgr[1].match(/(?:^|;)48;2;(\d+);(\d+);(\d+)(?:;|$)/);
        if (rgb) bg = `${rgb[1]},${rgb[2]},${rgb[3]}`;
        i += sgr[0].length;
        continue;
      }
    }
    if (col === target) return bg;
    col += 1;
    i += 1;
  }
  return null;
}

/** Foreground color active at one visible column, as an RGB tuple string. */
function fgAtColumn(row: string, target: number): string | null {
  let fg: string | null = null;
  let col = 0;
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\x1b") {
      // deno-lint-ignore no-control-regex
      const sgr = row.slice(i).match(/^\x1b\[([0-9;]*)m/);
      if (sgr) {
        if (sgr[1] === "0" || sgr[1] === "") fg = null;
        const rgb = sgr[1].match(/(?:^|;)38;2;(\d+);(\d+);(\d+)(?:;|$)/);
        if (rgb) fg = `${rgb[1]},${rgb[2]},${rgb[3]}`;
        i += sgr[0].length;
        continue;
      }
    }
    if (col === target) return fg;
    col += 1;
    i += 1;
  }
  return null;
}

Deno.test("renderFrame: node highlight covers the whole statement, not the padding", () => {
  const doc = parseDocument("const x = 1;\nconst y = 2;\n");
  // A structure node now spans the whole statement `const x = 1;` (12 columns),
  // including the `const` keyword and the `;` — but not the trailing padding,
  // and not the left guide column the renderer reserves while a node is
  // selected.
  const node = doc.flatStructure.find((n) => n.name === "x")!;
  const rows = renderFrame(doc, baseView({ selected: node, width: 40 }));
  const cols = bgColumns(rows[0]);
  const highlighted = cols.filter((c) => c).length;
  assertEquals(highlighted, 12, "the entire statement is highlighted");
  // The highlighted region is one contiguous run (no gap over `const `).
  const first = cols.indexOf(true);
  const last = cols.lastIndexOf(true);
  assertEquals(last - first + 1, highlighted, "highlight is contiguous");
  assertEquals(
    cols[cols.length - 1],
    false,
    "trailing padding not highlighted",
  );
  assertEquals(cols[0], false, "the left guide column is not highlighted");
  // a line outside the (single-line) node has no highlight at all
  const cols1 = bgColumns(rows[1]);
  assertEquals(cols1.some((c) => c), false, "other lines are not highlighted");
});

Deno.test("renderFrame: node highlight includes leading indentation", () => {
  const doc = parseDocument("  const x = 1;");
  const node = doc.flatStructure.find((n) => n.name === "x")!;
  const rows = renderFrame(doc, baseView({ selected: node, width: 24 }));
  const cols = bgColumns(rows[0]);
  assertEquals(cols.slice(0, 3), [false, true, true]);
});

Deno.test("renderFrame: emits exactly `height` rows", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ height: 12 }));
  assertEquals(rows.length, 12);
});

Deno.test("renderFrame: draws a centered gray cul-de-lampe after the document", () => {
  const doc = parseDocument("last");
  const rows = renderFrame(doc, diffView({ width: 15, height: 5 }));
  assertEquals(stripAnsi(rows[0]), "last           ");
  assertEquals(stripAnsi(rows[1]), "   ☙   ❦   ❧   ");
  assertEquals(stripAnsi(rows[2]), "     ☙   ❧     ");
  assertEquals(stripAnsi(rows[3]), "       ❦       ");
  const endMarkColor = ui.endMark.fg!.join(",");
  assertEquals(fgAtColumn(rows[1], 3), endMarkColor);
  assertEquals(fgAtColumn(rows[2], 5), endMarkColor);
  assertEquals(fgAtColumn(rows[3], 7), endMarkColor);
});

Deno.test("renderFrame: the end mark is centered across the line-number gutter", () => {
  const doc = parseDocument("last");
  const rows = renderFrame(
    doc,
    diffView({
      width: 15,
      height: 5,
      color: false,
      showLineNumbers: true,
    }),
  );
  assertEquals(rows.slice(1, 4), [
    "   ☙   ❦   ❧   ",
    "     ☙   ❧     ",
    "       ❦       ",
  ]);
});

Deno.test("renderFrame: the end mark follows the final wrapped row", () => {
  const doc = parseDocument("abcdefghijklmnopqrst");
  const rows = renderFrame(
    doc,
    diffView({
      width: 15,
      height: 6,
      color: false,
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 5), [
    "abcdefghijklmn\\",
    "opqrst         ",
    "   ☙   ❦   ❧   ",
    "     ☙   ❧     ",
    "       ❦       ",
  ]);
});

Deno.test("renderFrame: a compact cul-de-lampe retains its triangle", () => {
  const rows = renderFrame(
    parseDocument("last"),
    diffView({ width: 7, height: 5, color: false }),
  );
  assertEquals(rows.slice(1, 4), [
    " ☙ ❦ ❧ ",
    "  ☙ ❧  ",
    "   ❦   ",
  ]);
});

Deno.test("renderFrame: a two-row cul-de-lampe retains its point", () => {
  const cases = [
    {
      width: 15,
      expected: ["     ☙   ❧     ", "       ❦       "],
    },
    {
      width: 7,
      expected: ["  ☙ ❧  ", "   ❦   "],
    },
  ];
  for (const { width, expected } of cases) {
    const rows = renderFrame(
      parseDocument("last"),
      diffView({ width, height: 4, color: false }),
    );
    assertEquals(rows.slice(1, 3), expected);
  }
});

Deno.test("renderFrame: narrow end-mark rows retain a centered fleuron", () => {
  const doc = parseDocument("last");
  for (const width of [1, 2, 3, 4]) {
    const rows = renderFrame(
      doc,
      diffView({ width, height: 5, color: false }),
    );
    assertEquals(rows[1].length, width);
    assertEquals(
      rows[1].indexOf("❦"),
      Math.floor((width - 1) / 2),
      `width ${width} rendered ${JSON.stringify(rows[1])}`,
    );
    assertEquals(rows[2], " ".repeat(width));
    assertEquals(rows[3], " ".repeat(width));
  }
});

Deno.test("renderFrame: ordinary documents leave rows after the document blank", () => {
  const doc = parseDocument("last");
  const rows = renderFrame(
    doc,
    baseView({
      width: 15,
      height: 3,
      color: false,
    }),
  );
  assertEquals(rows[1], " ".repeat(15));
});

Deno.test("renderFrame: edit mode leaves rows after the document blank", () => {
  const doc = parseDocument("last");
  const rows = renderFrame(
    doc,
    diffView({
      width: 15,
      height: 3,
      color: false,
      cursor: { line: 0, col: 0 },
    }),
  );
  assertEquals(rows[1], " ".repeat(15));
});

Deno.test("renderFrame: content rows are verbatim under the color", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView());
  // line 0 is the section header, line 1 is `const define = undefined;`
  assertEquals(stripAnsi(rows[0]).trimEnd(), doc.lines[0].text);
  assertEquals(stripAnsi(rows[1]).trimEnd(), doc.lines[1].text);
});

Deno.test("renderFrame: horizontal scroll slices from the left offset", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ left: 3 }));
  assertEquals(stripAnsi(rows[1]).trimEnd(), doc.lines[1].text.slice(3));
});

Deno.test("renderFrame: wraps long lines onto later screen rows", () => {
  const doc = parseDocument("abcdefgh\nnext");
  const rows = renderFrame(
    doc,
    baseView({ width: 4, height: 5, color: false, wrapMode: "hard" }),
  ).map(stripAnsi);
  assertEquals(rows.slice(0, 4).map((row) => row.trimEnd()), [
    "abc\\",
    "def\\",
    "gh",
    "next",
  ]);
});

Deno.test("renderFrame: word wrapping preserves spaces and control pictures", () => {
  const spaces = renderFrame(
    parseDocument("foo     bar"),
    baseView({ width: 4, height: 5, color: false, wrapMode: "word" }),
  );
  assertEquals(spaces.slice(0, 4), [
    "foo\\",
    "   \\",
    "   \\",
    "bar ",
  ]);

  const tab = renderFrame(
    parseDocument("foo\tbar"),
    baseView({ width: 4, height: 3, color: false, wrapMode: "word" }),
  );
  assertEquals(tab.slice(0, 2), ["foo\\", "␉bar"]);
});

Deno.test("renderFrame: word-wrapped separators retain search highlighting", () => {
  const rows = renderFrame(
    parseDocument("foo     bar"),
    baseView({
      width: 4,
      height: 5,
      wrapMode: "word",
      matches: [{ line: 0, start: 3, end: 8 }],
      currentMatch: 0,
    }),
  );

  assertEquals(bgColumns(rows[1]), [true, true, true, false]);
  assertEquals(bgColumns(rows[2]), [true, true, false, false]);
});

Deno.test("renderFrame: repeated prefixes retain search highlighting", () => {
  const rows = renderFrame(
    parseDocument("// foo bar baz"),
    baseView({
      width: 7,
      height: 5,
      wrapMode: "word",
      matches: [{ line: 0, start: 0, end: 2 }],
      currentMatch: 0,
    }),
  );

  assertEquals(bgColumns(rows[1]).slice(0, 3), [true, true, false]);
});

Deno.test("renderFrame: repeated prefixes retain selection highlighting", () => {
  const doc = parseDocument("// foo bar baz");
  const rows = renderFrame(
    doc,
    baseView({
      width: 8,
      height: 5,
      wrapMode: "word",
      selected: doc.flatStructure[0],
    }),
  );

  assertEquals(bgColumns(rows[1]).slice(0, 4), [false, true, true, true]);
});

Deno.test("renderFrame: word wrapping does not break at a non-breaking space", () => {
  const rows = renderFrame(
    parseDocument("foo\u00a0bar"),
    baseView({ width: 4, height: 3, color: false, wrapMode: "word" }),
  );

  assertEquals(rows.slice(0, 2), ["foo\\", "\u00a0bar"]);
});

Deno.test("renderFrame: styles wrapped continuation markers", () => {
  const doc = parseDocument("abcdefgh");
  const rows = renderFrame(
    doc,
    baseView({ width: 4, height: 4, wrapMode: "hard" }),
  );
  assertEquals(stripAnsi(rows[0]), "abc\\");
  assertEquals(stripAnsi(rows[1]), "def\\");
  assert(rows[0].includes(fgCode(ui.wrapMarker.fg!)));
  assert(rows[1].includes(fgCode(ui.wrapMarker.fg!)));
  assertEquals(bgAtColumn(rows[0], 3), ui.editorBg.join(","));
  assertEquals(stripAnsi(rows[2]), "gh  ");
  assert(!rows[2].includes(fgCode(ui.wrapMarker.fg!)));
});

Deno.test("renderFrame: annotates only the lines that carry diff markers", () => {
  const doc = parseDocument("1234567\nabcdefghij");
  const rows = renderFrame(
    doc,
    diffView({
      width: 7,
      height: 5,
      expandMargin: true,
      diffAnnotations: [{ line: 1, kind: "expandDown" }],
      wrapMode: "hard",
    }),
  );
  assertEquals(stripAnsi(rows[0]), "1234567");
  assertEquals(stripAnsi(rows[1]), "abcde\\◢");
  assertEquals(stripAnsi(rows[2]), "fgh\\^L█");
  assertEquals(stripAnsi(rows[3]), "ij    █");
  assert(rows[1].includes(fgCode(ui.wrapMarker.fg!)));
  assert(rows[2].includes(fgCode(ui.wrapMarker.fg!)));
  assert(rows[3].includes(fgCode(ui.wrapMarker.fg!)));
  assertEquals(bgAtColumn(rows[1], 6), ui.editorBg.join(","));
});

Deno.test("renderFrame: a wrapped edge labels only its closest connector", () => {
  const doc = parseDocument("abcdefghij\nmeta");
  const rows = renderFrame(
    doc,
    diffView({
      width: 7,
      height: 6,
      color: false,
      expandMargin: true,
      diffAnnotations: [
        { line: 0, kind: "expandDown" },
        { line: 1, kind: "diffMetadata" },
      ],
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 5), [
    "abcde\\◢",
    "fgh\\^L█",
    "ij    █",
    "meta  █",
    " ☙ ❦ ❧ ",
  ]);

  const fittingRows = renderFrame(
    parseDocument("abc\nmeta"),
    diffView({
      width: 7,
      height: 4,
      color: false,
      expandMargin: true,
      diffAnnotations: [
        { line: 0, kind: "expandDown" },
        { line: 1, kind: "diffMetadata" },
      ],
      wrapMode: "hard",
    }),
  );
  assertEquals(fittingRows.slice(0, 2), [
    "abc   ◢",
    "meta^L█",
  ]);
});

Deno.test("labeledDiffMetadataLine tolerates a missing expansion line", () => {
  const doc = parseDocument("metadata");
  assertEquals(
    labeledDiffMetadataLine(doc.lines, "pictures", 7, [
      { line: 1, kind: "expandDown" },
      { line: 2, kind: "diffMetadata" },
    ]),
    2,
  );
});

Deno.test("renderFrame: the expansion margin preserves an exact-width line", () => {
  const doc = parseDocument("abcd");
  const rows = renderFrame(
    doc,
    diffView({
      width: 7,
      height: 2,
      color: false,
      expandMargin: true,
      diffAnnotations: [{ line: 0, kind: "expandUp" }],
    }),
  );
  assertEquals(rows[0], "abcd  ◥");
});

Deno.test("renderFrame: the closest metadata row labels Ctrl-L before the block", () => {
  const doc = parseDocument("abc\ndef\nghi");
  const rows = renderFrame(
    doc,
    diffView({
      width: 6,
      height: 4,
      expandMargin: true,
      diffAnnotations: [
        { line: 0, kind: "expandDown" },
        { line: 1, kind: "diffMetadata" },
      ],
    }),
  );
  assertEquals(stripAnsi(rows[0]), "abc  ◢");
  assertEquals(stripAnsi(rows[1]), "def^L█");
  assertEquals(stripAnsi(rows[2]), "ghi   ");
  const markerColor = ui.wrapMarker.fg!.join(",");
  assertEquals(fgAtColumn(rows[1], 3), markerColor);
  assertEquals(fgAtColumn(rows[1], 4), markerColor);
  assertEquals(fgAtColumn(rows[1], 5), markerColor);
  assertEquals(bgAtColumn(rows[1], 5), ui.editorBg.join(","));
});

Deno.test("renderFrame: a narrow expansion annotation preserves the block", () => {
  const doc = parseDocument("a\nb");
  const rows = renderFrame(
    doc,
    diffView({
      width: 2,
      height: 3,
      color: false,
      expandMargin: true,
      diffAnnotations: [
        { line: 0, kind: "expandDown" },
        { line: 1, kind: "diffMetadata" },
      ],
    }),
  );
  assertEquals(rows.slice(0, 2), ["a◢", "b█"]);
});

Deno.test("renderFrame: wrapped metadata keeps its label beside the backslash", () => {
  const doc = parseDocument("edge\nabcdefghij");
  const rows = renderFrame(
    doc,
    diffView({
      width: 7,
      height: 6,
      color: false,
      expandMargin: true,
      diffAnnotations: [
        { line: 0, kind: "expandDown" },
        { line: 1, kind: "diffMetadata" },
      ],
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 5), [
    "edge  ◢",
    "abc\\^L█",
    "defgh\\█",
    "ij    █",
    " ☙ ❦ ❧ ",
  ]);
});

Deno.test("renderFrame: draws the whole-diff totals in the first line's corner", () => {
  const doc = parseDocument("meta\nbody");
  const view = diffView({
    width: 16,
    height: 4,
    color: false,
    diffTotals: { adds: 456, dels: 123 },
  });
  const rows = renderFrame(doc, view);
  assertEquals(rows[0], "meta   +456 −123");
  assertEquals(rows[1], "body            ");
  // The label belongs to the first line: scrolling down takes it off screen.
  const scrolled = renderFrame(doc, { ...view, top: 1 });
  assertEquals(scrolled[0], "body            ");
  assert(!scrolled.some((row) => row.includes("+456")));
});

Deno.test("renderFrame: colors the totals as removals and additions", () => {
  const doc = parseDocument("meta");
  const rows = renderFrame(
    doc,
    diffView({ width: 12, height: 3, diffTotals: { adds: 2, dels: 1 } }),
  );
  assertEquals(stripAnsi(rows[0]), "meta   +2 −1");
  const del = styleFor("diffDel").fg!.join(",");
  const add = styleFor("diffAdd").fg!.join(",");
  assertEquals(fgAtColumn(rows[0], 7), add, "the + sign");
  assertEquals(fgAtColumn(rows[0], 8), add, "the added count");
  assertEquals(fgAtColumn(rows[0], 10), del, "the − sign");
  assertEquals(fgAtColumn(rows[0], 11), del, "the removed count");
  assertEquals(bgAtColumn(rows[0], 8), ui.editorBg.join(","));
});

Deno.test("renderFrame: the totals reserve wrapped width on the first line", () => {
  const doc = parseDocument("abcdefghijklmnop");
  const rows = renderFrame(
    doc,
    diffView({
      width: 12,
      height: 4,
      color: false,
      wrapMode: "hard",
      diffTotals: { adds: 2, dels: 1 },
    }),
  );
  assertEquals(rows[0], "abcdef\\+2 −1");
  assertEquals(rows[1], "ghijklmnop  ");
});

Deno.test("renderFrame: the totals sit before a first-line Ctrl-L label", () => {
  const doc = parseDocument("meta\nbody");
  const rows = renderFrame(
    doc,
    diffView({
      width: 16,
      height: 4,
      color: false,
      expandMargin: true,
      diffAnnotations: [
        { line: 1, kind: "expandUp" },
        { line: 0, kind: "diffMetadata" },
      ],
      diffTotals: { adds: 2, dels: 1 },
    }),
  );
  assertEquals(rows[0], "meta    +2 −1^L█");
  assertEquals(rows[1], "body           ◥");
});

Deno.test("renderFrame: wrapped totals layer over a first-line annotation", () => {
  const doc = parseDocument("metadatax\nabc");
  const rows = renderFrame(
    doc,
    diffView({
      width: 12,
      height: 4,
      color: false,
      expandMargin: true,
      wrapMode: "hard",
      diffAnnotations: [
        { line: 1, kind: "expandUp" },
        { line: 0, kind: "diffMetadata" },
      ],
      diffTotals: { adds: 2, dels: 1 },
    }),
  );
  assertEquals(rows[0], "met\\+2 −1^L█");
  assertEquals(rows[1], "adatax     █");
  assertEquals(rows[2], "abc        ◥");
});

Deno.test("renderFrame: totals reflow moves the Ctrl-L label, not copies it", () => {
  // Without the totals, the 16-column first line fits beside its expansion
  // triangle, so the metadata line below would carry the ^L label. The totals
  // reservation wraps the first line, and the label must follow it onto the
  // wrapped row rather than appear in both places.
  const doc = parseDocument("abcdefghijklmnop\nmeta");
  const rows = renderFrame(
    doc,
    diffView({
      width: 20,
      height: 5,
      color: false,
      expandMargin: true,
      wrapMode: "hard",
      diffAnnotations: [
        { line: 0, kind: "expandDown" },
        { line: 1, kind: "diffMetadata" },
      ],
      diffTotals: { adds: 2, dels: 1 },
    }),
  );
  assertEquals(rows.slice(0, 3), [
    "abcdefghijklm\\+2 −1◢",
    "nop              ^L█",
    "meta               █",
  ]);
  assertEquals(
    rows.filter((row) => row.includes("^L")).length,
    1,
    "exactly one Ctrl-L label",
  );
});

Deno.test("renderFrame: narrow totals keep at least one source cell", () => {
  const doc = parseDocument("abcdef");
  const rows = renderFrame(
    doc,
    diffView({
      width: 4,
      height: 3,
      color: false,
      diffTotals: { adds: 345, dels: 12 },
    }),
  );
  assertEquals(rows[0], "a−12");
});

Deno.test("renderFrame: a diff without a final triangle omits the end connector", () => {
  const doc = parseDocument("done");
  const rows = renderFrame(
    doc,
    diffView({
      width: 9,
      height: 5,
      color: false,
      expandMargin: true,
    }),
  );
  assertEquals(rows.slice(0, 4), [
    "done     ",
    "☙   ❦   ❧",
    "  ☙   ❧  ",
    "    ❦    ",
  ]);
});

Deno.test("renderFrame: a trailing diff newline omits an orphan end connector", () => {
  const doc = parseDocument("done\n");
  const rows = renderFrame(
    doc,
    diffView({
      width: 9,
      height: 5,
      color: false,
      expandMargin: true,
    }),
  );
  assertEquals(rows.slice(0, 4), [
    "done     ",
    "☙   ❦   ❧",
    "  ☙   ❧  ",
    "    ❦    ",
  ]);
});

Deno.test("renderFrame: a read-only trailing diff newline precedes its end mark", () => {
  const rows = renderFrame(
    parseDocument("done\n"),
    diffView({ width: 9, height: 5, color: false }),
  );
  assertEquals(rows.slice(0, 4), [
    "done     ",
    "☙   ❦   ❧",
    "  ☙   ❧  ",
    "    ❦    ",
  ]);
});

Deno.test("renderFrame: a final downward triangle labels the diff connector", () => {
  for (const text of ["done", "done\n"]) {
    const doc = parseDocument(text);
    const rows = renderFrame(
      doc,
      diffView({
        width: 9,
        height: 5,
        color: false,
        expandMargin: true,
        diffAnnotations: [{ line: 0, kind: "expandDown" }],
      }),
    );
    assertEquals(rows[0], "done    ◢");
    assertEquals(rows[1], "      ^L█");
  }

  const shortRows = renderFrame(
    parseDocument("done"),
    diffView({
      width: 9,
      height: 3,
      color: false,
      expandMargin: true,
      diffAnnotations: [{ line: 0, kind: "expandDown" }],
    }),
  );
  assertEquals(shortRows.slice(0, 2), [
    "done    ◢",
    "    ❦ ^L█",
  ]);
});

Deno.test("renderFrame: a wrapped final triangle connects below the diff", () => {
  const rows = renderFrame(
    parseDocument("abcdefghij"),
    diffView({
      width: 7,
      height: 6,
      color: false,
      expandMargin: true,
      diffAnnotations: [{ line: 0, kind: "expandDown" }],
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 5), [
    "abcde\\◢",
    "fgh\\^L█",
    "ij    █",
    "      █",
    " ☙ ❦ ❧ ",
  ]);
});

Deno.test("renderFrame: a narrow final connector keeps its functional glyphs", () => {
  const cases: readonly { width: number; expected: string[] }[] = [
    { width: 1, expected: ["a", "█"] },
    { width: 2, expected: ["a◢", "L█"] },
    { width: 3, expected: ["a ◢", "^L█"] },
    { width: 4, expected: ["a  ◢", "❦^L█"] },
    { width: 5, expected: ["a   ◢", "❦ ^L█"] },
  ];
  for (const { width, expected } of cases) {
    const rows = renderFrame(
      parseDocument("a"),
      diffView({
        width,
        height: 3,
        color: false,
        expandMargin: true,
        diffAnnotations: [{ line: 0, kind: "expandDown" }],
      }),
    );
    assertEquals(rows.slice(0, 2), expected);
  }
});

Deno.test("renderFrame: a short diff uses the available row for its end mark", () => {
  const doc = parseDocument("done");
  const rows = renderFrame(
    doc,
    diffView({
      width: 9,
      height: 3,
      color: false,
      expandMargin: true,
    }),
  );
  assertEquals(rows.slice(0, 2), [
    "done     ",
    "☙   ❦   ❧",
  ]);
});

Deno.test("renderFrame: a narrow expansion margin reclaims the gutter", () => {
  const doc = parseDocument("a");
  const rows = renderFrame(
    doc,
    diffView({
      width: 5,
      height: 2,
      color: false,
      showLineNumbers: true,
      expandMargin: true,
      diffAnnotations: [{ line: 0, kind: "expandDown" }],
    }),
  );
  assertEquals(rows[0], "a   ◢");
  assertEquals(visibleWidth(rows[0]), 5);
});

Deno.test("renderFrame: a narrow expansion margin reclaims the guide", () => {
  const doc = parseDocument("const x = 1;");
  const node = doc.flatStructure.find((n) => n.name === "x")!;
  const rows = renderFrame(
    doc,
    diffView({
      width: 2,
      height: 2,
      color: false,
      selected: node,
      expandMargin: true,
      diffAnnotations: [{ line: 0, kind: "expandUp" }],
    }),
  );
  assertEquals(rows[0], "c◥");
  assertEquals(visibleWidth(rows[0]), 2);
});

Deno.test("renderFrame: a wrapped marker keeps each diff-row background", () => {
  const parsed = parseDocument("abcdefgh");
  for (const bg of ["add", "del"] as const) {
    const doc = {
      ...parsed,
      lines: parsed.lines.map((line) => ({ ...line, bg })),
    };
    const rows = renderFrame(
      doc,
      baseView({ width: 4, height: 4, wrapMode: "hard" }),
    );
    assertEquals(stripAnsi(rows[0]), "abc\\");
    assertEquals(bgAtColumn(rows[0], 3), lineBg(bg).join(","));
  }
});

Deno.test("renderFrame: the final wrapped row keeps the full content width", () => {
  const doc = parseDocument("abcdefg");
  const rows = renderFrame(
    doc,
    baseView({ width: 4, height: 3, color: false, wrapMode: "hard" }),
  );
  assertEquals(rows.slice(0, 2), ["abc\\", "defg"]);
});

Deno.test("renderFrame: a physically one-column view preserves source text", () => {
  const doc = parseDocument("ab");
  const rows = renderFrame(
    doc,
    diffView({
      width: 1,
      height: 3,
      color: false,
      expandMargin: true,
      diffAnnotations: [{ line: 0, kind: "diffMetadata" }],
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 2), ["a", "b"]);
});

Deno.test("renderFrame: wrapping reclaims a gutter that leaves one content column", () => {
  const doc = parseDocument("abcdef");
  const rows = renderFrame(
    doc,
    baseView({
      width: 5,
      height: 3,
      color: false,
      showLineNumbers: true,
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 2), ["abcd\\", "ef   "]);
});

Deno.test("renderFrame: wrapping reclaims a guide that leaves one content column", () => {
  const doc = parseDocument("abc");
  const selected = {
    kind: "section" as const,
    label: "all",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 3,
    startOffset: 0,
    endOffset: 3,
    depth: 0,
    children: [],
  };
  const rows = renderFrame(
    doc,
    baseView({
      width: 2,
      height: 3,
      color: false,
      selected,
      wrapMode: "hard",
    }),
  );
  assertEquals(rows.slice(0, 2), ["a\\", "bc"]);
});

Deno.test("renderFrame: wrapped top offsets address continuation rows", () => {
  const doc = parseDocument("abcdefgh\nnext");
  const rows = renderFrame(
    doc,
    baseView({
      top: 1,
      width: 4,
      height: 3,
      color: false,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows.slice(0, 2).map((row) => row.trimEnd()), [
    "def\\",
    "gh",
  ]);
});

Deno.test("renderFrame: only the first wrapped row repeats its line number", () => {
  const doc = parseDocument("abcdefgh\nnext");
  const rows = renderFrame(
    doc,
    baseView({
      width: 8,
      height: 5,
      color: false,
      showLineNumbers: true,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows[0], "  1 abc\\");
  assertEquals(rows[1], "    def\\");
  assertEquals(rows[2], "    gh  ");
  assertEquals(rows[3], "  2 next");
});

Deno.test("renderFrame: a selected line's guide spans its wrapped rows", () => {
  const doc = parseDocument("const x = 123456;");
  const selected = doc.flatStructure.find((node) => node.name === "x")!;
  const rows = renderFrame(
    doc,
    baseView({
      width: 8,
      height: 4,
      color: false,
      selected,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows.slice(0, 3).map((row) => row[0]), ["╭", "│", "╰"]);
});

Deno.test("renderFrame: a selected node guides only its wrapped column range", () => {
  const doc = parseDocument("abcdefghijklmnopqrstuvwxyz");
  const selected = {
    ...doc.flatStructure[0]!,
    startCol: 10,
    endCol: 15,
  };
  const rows = renderFrame(
    doc,
    baseView({
      width: 10,
      height: 5,
      color: false,
      selected,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows.slice(0, 3).map((row) => row[0]), [" ", "▶", " "]);
});

Deno.test("renderFrame: wrapped selection columns count Unicode code points", () => {
  const doc = parseDocument(`/*😀*/ const x = 1;${" ".repeat(12)}`);
  const selected = doc.flatStructure.find((node) => node.name === "x")!;
  const rows = renderFrame(
    doc,
    baseView({
      width: 8,
      height: 6,
      color: false,
      selected,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows.slice(0, 5).map((row) => row[0]), [
    " ",
    "╭",
    "│",
    "│",
    "╰",
  ]);
});

Deno.test("renderFrame: a selected empty line keeps its wrapped guide", () => {
  const doc = parseDocument("a\n\nb");
  const selected = {
    ...doc.flatStructure[0]!,
    startLine: 0,
    endLine: 2,
    startCol: 0,
    endCol: 1,
  };
  const rows = renderFrame(
    doc,
    baseView({
      width: 6,
      height: 4,
      color: false,
      selected,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows[1][0], "│");
});

Deno.test("renderFrame: a wrapped guide is blank outside the selected node", () => {
  const doc = parseDocument("before\nconst x = 123456789;\nafter");
  const selected = doc.flatStructure.find((node) => node.name === "x")!;
  const rows = renderFrame(
    doc,
    baseView({
      width: 8,
      height: 7,
      color: false,
      selected,
      wrapMode: "hard",
    }),
  ).map(stripAnsi);
  assertEquals(rows[0][0], " ");
  assertEquals(rows[5][0], " ");
});

Deno.test("renderFrame: wrapped status reports logical source lines", () => {
  const doc = parseDocument("abcdefghijkl\nnext");
  const status = stripAnsi(
    renderFrame(
      doc,
      baseView({ width: 6, height: 3, color: false, wrapMode: "hard" }),
    ).at(-1)!,
  );
  assert(status.includes("1-1/2"), status);
});

Deno.test("renderFrame: wrapped status reports an empty document", () => {
  const parsed = parseDocument("");
  const doc = { ...parsed, lines: [] };
  const status = stripAnsi(
    renderFrame(
      doc,
      baseView({ width: 12, height: 3, color: false, wrapMode: "hard" }),
    ).at(-1)!,
  );
  assert(status.includes("0-0/0"), status);
});

Deno.test("renderFrame: monochrome output equals verbatim text", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ color: false }));
  assertEquals(rows[1].trimEnd(), doc.lines[1].text);
  // no escape sequences at all
  assert(!rows[1].includes("\x1b"));
});

Deno.test("renderFrame: line-number gutter shows numbers", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ showLineNumbers: true }));
  const text = stripAnsi(rows[1]);
  assert(/^\s*2\s/.test(text), `expected line number 2, got "${text}"`);
  assert(text.includes("const define"), "still shows the source");
});

Deno.test("renderFrame: selecting a node draws a guide bar", () => {
  const doc = parseDocument(SAMPLE);
  const node = doc.flatStructure.find((n) => n.endLine > n.startLine)!;
  const rows = renderFrame(
    doc,
    baseView({ top: node.startLine, selected: node, height: 20 }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(/[╭│╰▶]/.test(joined), "guide glyphs present when a node is selected");
});

//
// display modes at the frame level
//

/** A one-line document whose text is `text` verbatim, in a single plain span. */
function docOf(text: string) {
  return {
    text: text + "\n",
    lines: [{ text, spans: [{ col: 0, text, cls: "plain" as const }] }],
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

Deno.test("renderFrame: hidden mode collapses a control run and shifts text left", () => {
  const doc = docOf("a\x01\x02\x03b");
  const pictures = stripAnsi(renderFrame(doc, baseView({ color: false }))[0]);
  assertEquals(pictures.slice(0, 5), "a␁␂␃b", "pictures shows every code");
  const hidden = stripAnsi(
    renderFrame(doc, baseView({ color: false, displayMode: "hidden" }))[0],
  );
  assertEquals(
    hidden.slice(0, 3),
    "a…b",
    "hidden collapses the run to one cell",
  );
});

Deno.test("renderFrame: ansi mode paints the sequence's color onto later text", () => {
  const doc = docOf("a\x1b[31mb");
  const rows = renderFrame(doc, baseView({ displayMode: "ansi" }));
  // The escape is consumed; "b" is painted ANSI red (205;49;49) while "a" is not.
  assertEquals(stripAnsi(rows[0]).slice(0, 2), "ab");
  assert(rows[0].includes("38;2;205;49;49"), "ANSI red applied to later text");
});

Deno.test("renderFrame: a search match after a hidden sequence still aligns", () => {
  const doc = docOf("a\x1b[31mbcd");
  // "bcd" occupies source columns 6..8 (after the 5-column escape). A match on
  // those columns must highlight the compacted cells, mapped by source column.
  const rows = renderFrame(
    doc,
    baseView({
      displayMode: "ansi",
      matches: [{ line: 0, start: 6, end: 9 }],
      currentMatch: 0,
    }),
  );
  const cols = bgColumns(rows[0]);
  // Display columns: a(0), b(1), c(2), d(3). The match covers b, c, d.
  assertEquals(cols.slice(0, 4), [false, true, true, true]);
});

Deno.test("renderFrame: search matches are highlighted", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      matches: [{ line: 1, start: 0, end: 5 }, { line: 1, start: 6, end: 9 }],
      currentMatch: 0,
    }),
  );
  // the current match uses the searchCurrent highlight background
  assert(
    rows[1].includes(bgCode(ui.searchCurrent.bg!)),
    "current match highlighted",
  );
  // the other match uses the searchMatch highlight background
  assert(
    rows[1].includes(bgCode(ui.searchMatch.bg!)),
    "non-current match highlighted",
  );
});

Deno.test("renderFrame: dense wrapped matches keep the focused overlap", () => {
  const doc = parseDocument("x".repeat(220));
  const focused = { line: 0, start: 175, end: 176 };
  const matches = Array.from({ length: 220 }, (_, start) => ({
    line: 0,
    start,
    end: start + 1,
  }));
  matches.splice(176, 0, focused);
  const rows = renderFrame(
    doc,
    baseView({
      top: 19,
      width: 10,
      height: 4,
      wrapMode: "hard",
      matches,
      currentMatch: 176,
    }),
  );
  assert(
    rows[0].includes(bgCode(ui.searchCurrent.bg!)),
    "the focused match wins its overlapping cell",
  );
  assert(
    rows[0].includes(bgCode(ui.searchMatch.bg!)),
    "the other visible matches keep their ordinary style",
  );
});

Deno.test("renderFrame: off-screen matches do not affect visible lookup", () => {
  const doc = docOf("x");
  const matches = Array.from({ length: 10_000 }, (_, line) => ({
    line,
    start: 0,
    end: 1,
  }));
  const rows = renderFrame(
    doc,
    baseView({ matches, currentMatch: 0, width: 10, height: 3 }),
  );
  assert(
    rows[0].includes(bgCode(ui.searchCurrent.bg!)),
    "the focused visible match is highlighted",
  );
});

Deno.test("renderFrame: an earlier ordinary overlap stays highlighted", () => {
  const doc = parseDocument(`${"x".repeat(100)}\nz`);
  const matches = [
    { line: 0, start: 0, end: 100 },
    ...Array.from({ length: 69 }, (_, offset) => ({
      line: 0,
      start: offset + 1,
      end: offset + 2,
    })),
    { line: 1, start: 0, end: 1 },
  ];
  const rows = renderFrame(
    doc,
    baseView({ width: 100, height: 3, matches, currentMatch: 70 }),
  );
  assertEquals(
    bgColumns(rows[0]).slice(0, 100),
    Array(100).fill(true),
  );
});

Deno.test("renderFrame: status line reports position", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ height: 8 }));
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("/"), `status shows position: "${status}"`);
});

Deno.test("renderFrame: END means the mode-specific scroll limit", () => {
  const doc = parseDocument(
    Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
  );
  const statusAt = (
    top: number,
    isDiff = false,
    cursor: ViewState["cursor"] = null,
  ) =>
    stripAnsi(
      renderFrame(
        doc,
        baseView({
          width: 30,
          height: 9,
          color: false,
          top,
          isDiff,
          cursor,
        }),
      ).at(-1)!,
    );

  assert(statusAt(4).includes("END"), "ordinary pager reached the file end");
  assert(
    !statusAt(4, true).includes("END"),
    "diff padding remains below the view",
  );
  assert(statusAt(10, true).includes("END"), "diff reached its padded limit");
  assert(
    statusAt(4, true, { line: 11, col: 0 }).includes("END"),
    "editor reached its ordinary document limit",
  );
});

Deno.test("renderFrame: diff status excludes only its terminal parser row", () => {
  const status = (text: string, view: Partial<ViewState> = {}) =>
    stripAnsi(
      renderFrame(
        parseDocument(text),
        baseView({
          width: 30,
          height: 9,
          color: false,
          ...view,
        }),
      ).at(-1)!,
    );

  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const intermediate = status(`${lines.join("\n")}\n`, {
    top: 5,
    isDiff: true,
  });
  assert(intermediate.includes("6-12/12  45%"), intermediate);

  const wrapped = status(`${"a".repeat(25)}\nz\n`, {
    width: 20,
    height: 4,
    top: 1,
    isDiff: true,
    wrapMode: "hard",
  });
  assert(wrapped.includes("1-2/2  50%"), wrapped);

  const emptyDiff = status("", { isDiff: true });
  assert(emptyDiff.includes("0-0/0  END"), emptyDiff);

  const editableDiff = status("done\n", {
    height: 3,
    isDiff: true,
    cursor: { line: 0, col: 0 },
  });
  assert(editableDiff.includes("1-2/2  END"), editableDiff);

  const ordinary = status("done\n", { height: 3 });
  assert(ordinary.includes("1-2/2  END"), ordinary);
});

Deno.test("renderFrame: overlay paints its title over the content", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 60,
      height: 16,
      overlay: {
        title: "DEFINITION-PEEK",
        lines: [{
          text: "hello",
          spans: [{ col: 0, text: "hello", cls: "plain" }],
        }],
        scroll: 0,
        footer: "esc close",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(joined.includes("DEFINITION-PEEK"), "overlay title shown");
  assert(joined.includes("hello"), "overlay body shown");
});

Deno.test("renderFrame: a non-BMP glyph keeps the overlay borders flush", () => {
  // `𝑻` is a surrogate pair (two UTF-16 units, one column). If width maths
  // counted code units the right border would drift; assert every row is
  // exactly `view.width` columns wide, both in the title and the body.
  const doc = parseDocument(SAMPLE);
  const width = 72;
  const rows = renderFrame(
    doc,
    baseView({
      width,
      height: 16,
      overlay: {
        title: "𝑻 lift __cfLift_1",
        lines: [{
          text: "𝑻 input",
          spans: [{ col: 0, text: "𝑻 input", cls: "plain" }],
        }],
        scroll: 0,
        footer: "esc close",
      },
    }),
  );
  for (const row of rows) {
    assertEquals(visibleWidth(row), width, `row width: "${stripAnsi(row)}"`);
  }
  // The right border sits at the same display column on every boxed row.
  const rightBorderCols = rows
    .map((r) => [...stripAnsi(r)])
    .filter((chars) => /[╗║╝]/.test(chars.join("")))
    .map((chars) => chars.findLastIndex((c) => "╗║╝".includes(c)));
  assert(rightBorderCols.length >= 3, "the box has multiple bordered rows");
  assertEquals(
    new Set(rightBorderCols).size,
    1,
    `right border aligned at one column, got ${rightBorderCols}`,
  );
  assert(rows.map(stripAnsi).join("\n").includes("𝑻 lift"), "title survives");
});

Deno.test("renderFrame: overlay on a tiny terminal does not throw", () => {
  const doc = parseDocument(SAMPLE);
  const overlay = {
    title: "DEFINITION-PEEK",
    lines: [{
      text: "hello",
      spans: [{ col: 0, text: "hello", cls: "plain" as const }],
    }],
    scroll: 0,
    footer: "esc close",
  };
  // Sizes smaller than the overlay's border chrome must not crash the renderer
  // (a negative inner width/height would feed a negative repeat/slice). The
  // box collapses and the overlay is simply skipped.
  for (const [width, height] of [[2, 1], [3, 2], [1, 1], [6, 3]]) {
    // The call itself throwing is the regression under test; reaching the
    // assertion means it did not.
    const rows = renderFrame(doc, baseView({ width, height, overlay }));
    assertEquals(
      rows.length,
      height,
      `emits ${height} rows at ${width}x${height}`,
    );
  }
});

Deno.test("overlayBox: inner dimensions never go negative", () => {
  for (let width = 0; width <= 50; width++) {
    for (let height = 0; height <= 24; height++) {
      const box = overlayBox(width, height);
      assert(box.innerW >= 0, `innerW >= 0 at ${width}x${height}`);
      assert(box.innerH >= 0, `innerH >= 0 at ${width}x${height}`);
      assert(box.x >= 0, `x >= 0 at ${width}x${height}`);
      assert(box.y >= 0, `y >= 0 at ${width}x${height}`);
      // The box never extends past the terminal it is centered in.
      assert(box.boxW <= Math.max(0, width), `boxW fits at ${width}x${height}`);
      assert(
        box.boxH <= Math.max(0, height),
        `boxH fits at ${width}x${height}`,
      );
    }
  }
});

Deno.test("render _internal: sliceVisible keeps ANSI and counts visible cols", () => {
  const colored = renderLineColored(
    { text: "abcdef", spans: [{ col: 0, text: "abcdef", cls: "plain" }] },
    true,
  );
  const sliced = _internal.sliceVisible(colored, 2, 4);
  assertEquals(stripAnsi(sliced), "cd");
});

Deno.test("render _internal: padTo pads to visible width", () => {
  assertEquals(visibleWidth(_internal.padTo("hi", 5)), 5);
});

Deno.test("renderFrame: the overlay uses a double-line (Turbo Pascal) frame", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 60,
      height: 16,
      overlay: {
        title: "INFO",
        lines: [{ text: "x", spans: [{ col: 0, text: "x", cls: "plain" }] }],
        scroll: 0,
        footer: "esc close",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  for (const glyph of ["╔", "╗", "╚", "╝", "║", "═"]) {
    assert(joined.includes(glyph), `overlay frame uses ${glyph}`);
  }
  // No rounded corners survive.
  for (const glyph of ["╭", "╮", "╰", "╯"]) {
    assert(!joined.includes(glyph), `no rounded corner ${glyph}`);
  }
});

Deno.test("renderFrame: the info panel uses the dialog panel and text colors", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 60,
      height: 16,
      overlay: {
        title: "INFO",
        lines: [{
          text: "hello",
          spans: [{ col: 0, text: "hello", cls: "plain" }],
        }],
        scroll: 0,
        footer: "esc",
      },
    }),
  );
  const body = rows.find((r) => stripAnsi(r).includes("hello"))!;
  assert(body.includes(bgCode(ui.overlayBg)), "the dialog panel color");
  assert(body.includes(fgCode(ui.dialogText.fg!)), "the dialog text color");
});

Deno.test("renderFrame: a source overlay uses the editor colors, not the dialog panel", () => {
  const doc = parseDocument(SAMPLE);
  const overlay = (sourceView: boolean) => ({
    title: "SRC",
    lines: [{
      text: "code",
      spans: [{ col: 0, text: "code", cls: "plain" as const }],
    }],
    scroll: 0,
    footer: "esc",
    sourceView,
  });
  const rowsDialog = renderFrame(
    doc,
    baseView({ width: 60, height: 16, overlay: overlay(false) }),
  );
  const rowsSource = renderFrame(
    doc,
    baseView({ width: 60, height: 16, overlay: overlay(true) }),
  );
  const dialogBody = rowsDialog.find((r) => stripAnsi(r).includes("code"))!;
  const sourceBody = rowsSource.find((r) => stripAnsi(r).includes("code"))!;
  assert(dialogBody.includes(bgCode(ui.overlayBg)), "the dialog panel color");
  assert(
    sourceBody.includes(bgCode(ui.editorBg)),
    "the source panel is the editor color",
  );
});
