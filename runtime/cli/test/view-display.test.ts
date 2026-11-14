import { assertEquals } from "@std/assert";
import {
  _internal,
  DISPLAY_MODES,
  displayColumnOf,
  displayLine,
  type DisplayMode,
  displayModeLabel,
  displayWidth,
  drawsAsPictures,
  glyphFor,
  sourceColumnOf,
  visitDisplayCellSources,
} from "../lib/view/display.ts";
import type { Line } from "../lib/view/model.ts";

/** A single-span line carrying `text` verbatim (control codes and all). */
function ln(text: string): Line {
  return { text, spans: [{ col: 0, text, cls: "plain" }] };
}

/** The glyphs a mode draws for `text`, joined. */
function glyphs(text: string, mode: DisplayMode): string {
  return displayLine(ln(text), mode).map((c) => c.ch).join("");
}

Deno.test("displayWidth: matches the rendered cell count", () => {
  const samples = [
    "",
    "plain ASCII",
    "😀x",
    "a\x1b[31mb",
    "a\x1b[2Jb",
    "a\x01\x02b",
    "a\x01\x1b[2J\x02b",
    "a\x1b[",
    "\x1b[0 qx",
    "a\tb\t\tc",
    "\x1b[31mab\tc",
    "\udc7baB",
    "a\ud835",
    "N\bNA\bAM\bME\bE",
    "_\bf_\bd\t\x1b[31mx\by",
    "😀\b😀\b",
  ];
  for (const mode of DISPLAY_MODES) {
    for (const text of samples) {
      assertEquals(
        displayWidth(ln(text), mode),
        displayLine(ln(text), mode).length,
        `${mode}: ${JSON.stringify(text)}`,
      );
    }
  }
});

//
// mode cycle & labels
//

Deno.test("DISPLAY_MODES: ansi is first, and every mode has a label", () => {
  assertEquals(DISPLAY_MODES[0], "ansi");
  assertEquals(DISPLAY_MODES.length, 3);
  assertEquals(displayModeLabel("pictures"), "control pictures");
  assertEquals(displayModeLabel("ansi"), "ANSI color");
  assertEquals(displayModeLabel("hidden"), "hidden");
});

//
// pictures mode
//

Deno.test("pictures: control codes become Control Pictures glyphs, one column each", () => {
  // U+000B (vertical tab) → ␋ (U+240B), tab → ␉, CR → ␍, ESC → ␛.
  assertEquals(glyphs("a\x0bb", "pictures"), "a␋b");
  assertEquals(glyphs("a\tb", "pictures"), "a␉b");
  assertEquals(glyphs("a\rb", "pictures"), "a␍b");
  assertEquals(glyphs("a\x1bb", "pictures"), "a␛b");
});

Deno.test("pictures: printable text is untouched and maps 1:1 to columns", () => {
  const cells = displayLine(ln("héllo"), "pictures");
  assertEquals(cells.map((c) => c.ch).join(""), "héllo");
  // Every source column maps to exactly one display column at the same index.
  cells.forEach((c, i) => assertEquals(c.col, i));
});

Deno.test("pictures: does not interpret ANSI — the escape shows as ␛", () => {
  // A color sequence is shown literally: ␛ then its printable bytes.
  assertEquals(glyphs("\x1b[31mx", "pictures"), "␛[31mx");
});

//
// ansi mode
//

Deno.test("ansi: an SGR color sequence is hidden and colors the text after it", () => {
  const cells = displayLine(ln("a\x1b[31mb"), "ansi");
  // The 5-code-point sequence (ESC [ 3 1 m) is consumed; two cells remain.
  assertEquals(cells.map((c) => c.ch).join(""), "ab");
  assertEquals(
    cells[0].ansi,
    undefined,
    "text before the sequence is uncolored",
  );
  assertEquals(cells[1].ansi?.fg, [205, 49, 49], "text after is ANSI red");
  // The surviving cells keep their original source columns.
  assertEquals(cells[0].col, 0);
  assertEquals(cells[1].col, 6);
});

Deno.test("ansi: a reset (and a bare ESC[m) clears the color override", () => {
  for (const reset of ["\x1b[0m", "\x1b[m"]) {
    const cells = displayLine(ln(`\x1b[31ma${reset}b`), "ansi");
    assertEquals(cells.map((c) => c.ch).join(""), "ab");
    assertEquals(cells[0].ansi?.fg, [205, 49, 49], "a is red");
    assertEquals(cells[1].ansi, undefined, `b is uncolored after ${reset}`);
  }
});

Deno.test("ansi: attributes and background codes accumulate", () => {
  const cells = displayLine(ln("\x1b[1;4;42mx"), "ansi");
  assertEquals(cells[0].ansi?.bold, true);
  assertEquals(cells[0].ansi?.underline, true);
  assertEquals(cells[0].ansi?.bg, [13, 188, 121], "green background");
});

Deno.test("ansi: a non-color CSI sequence is not hidden", () => {
  // ESC [ 2 J (clear screen) does not end in `m`, so it is shown, not consumed.
  assertEquals(glyphs("\x1b[2Jx", "ansi"), "␛[2Jx");
});

Deno.test("ansi: 256-color and truecolor foregrounds", () => {
  const c256 = displayLine(ln("\x1b[38;5;196mx"), "ansi")[0];
  assertEquals(c256.ansi?.fg, [255, 0, 0], "palette index 196 is red");
  const truecolor = displayLine(ln("\x1b[38;2;10;20;30mx"), "ansi")[0];
  assertEquals(truecolor.ansi?.fg, [10, 20, 30]);
});

Deno.test("ansi: a tab advances to the next multiple-of-4 column", () => {
  assertEquals(glyphs("\tx", "ansi"), "    x");
  assertEquals(glyphs("a\tx", "ansi"), "a   x");
  assertEquals(glyphs("abc\tx", "ansi"), "abc x");
  assertEquals(
    glyphs("abcd\tx", "ansi"),
    "abcd    x",
    "a tab on a stop is 4 wide",
  );
  assertEquals(glyphs("a\t\tx", "ansi"), "a       x");
});

Deno.test("ansi: tab stops count drawn cells, not hidden color sequences", () => {
  assertEquals(glyphs("\x1b[31mab\tx", "ansi"), "ab  x");
});

Deno.test("ansi: every cell a tab draws stands for the tab's source column", () => {
  const cells = displayLine(ln("a\tb"), "ansi");
  assertEquals(
    cells.map((c) => [c.ch, c.col, c.sourceEnd]),
    [["a", 0, 1], [" ", 1, 2], [" ", 1, 2], [" ", 1, 2], ["b", 2, 3]],
  );
});

Deno.test("ansi: a cell visitor sees each cell a tab draws", () => {
  const ranges: [number, number][] = [];
  visitDisplayCellSources("ab\tc", "ansi", (start, end) => {
    ranges.push([start, end]);
    return true;
  });

  assertEquals(ranges, [[0, 1], [1, 2], [2, 3], [2, 3], [3, 4]]);
});

Deno.test("ansi: a character struck over itself is one bold cell", () => {
  const cells = displayLine(ln("aN\bNA\bAb"), "ansi");
  assertEquals(
    cells.map((c) => [c.ch, c.col, c.sourceEnd, c.ansi?.bold]),
    [
      ["a", 0, 1, undefined],
      ["N", 1, 4, true],
      ["A", 4, 7, true],
      ["b", 7, 8, undefined],
    ],
  );
  assertEquals(cells[1].ansi?.underline, undefined, "bold is not underlined");
});

Deno.test("ansi: a character struck over an underscore is one underlined cell", () => {
  for (const text of ["_\bf", "f\b_"]) {
    const [cell, ...rest] = displayLine(ln(text), "ansi");
    assertEquals(rest, [], JSON.stringify(text));
    assertEquals(cell.ch, "f");
    assertEquals(cell.ansi?.underline, true);
    assertEquals(cell.ansi?.bold, undefined, "underlined is not bold");
  }
});

Deno.test("ansi: repeated overstrikes combine into one cell", () => {
  const cells = displayLine(ln("_\bX\bX\bXy"), "ansi");
  assertEquals(cells.map((c) => c.ch).join(""), "Xy");
  assertEquals(cells[0].ansi?.bold, true);
  assertEquals(cells[0].ansi?.underline, true);
  assertEquals([cells[0].col, cells[0].sourceEnd], [0, 7]);
  const [interrupted] = displayLine(ln("X\b_\bX"), "ansi");
  assertEquals(
    [interrupted.ansi?.bold, interrupted.ansi?.underline],
    [true, true],
    "an underscore between two strikes",
  );
  const [restruck] = displayLine(ln("X\bY\bX"), "ansi");
  assertEquals(
    [restruck.ch, restruck.ansi?.bold],
    ["X", true],
    "another character between two strikes",
  );
  const [underscore] = displayLine(ln("_\b_"), "ansi");
  assertEquals(
    [underscore.ch, underscore.ansi?.bold, underscore.ansi?.underline],
    ["_", true, undefined],
    "an underscore struck over itself is bold, not underlined",
  );
  assertEquals(
    displayLine(ln("😀\b😀"), "ansi").map((c) => [c.ch, c.ansi?.bold]),
    [["😀", true]],
    "a character outside the Basic Multilingual Plane",
  );
});

Deno.test("ansi: an overstrike keeps the color around it", () => {
  const [cell] = displayLine(ln("\x1b[31mx\bx"), "ansi");
  assertEquals(cell.ansi?.fg, [205, 49, 49]);
  assertEquals(cell.ansi?.bold, true);
});

Deno.test("ansi: two different characters struck together draw the second", () => {
  const cells = displayLine(ln("+\box\byz"), "ansi");
  assertEquals(
    cells.map((c) => [c.ch, c.col, c.sourceEnd, c.ansi]),
    [["o", 0, 3, undefined], ["y", 3, 6, undefined], ["z", 6, 7, undefined]],
  );
  assertEquals(
    displayLine(ln("x\bx\by"), "ansi").map((c) => [c.ch, c.ansi]),
    [["y", undefined]],
    "a bold character struck by another is plain",
  );
  for (const text of ["_\bX\bY", "X\b_\bY", "_\b_\bY"]) {
    const [cell, ...rest] = displayLine(ln(text), "ansi");
    const label = `an underscore underlines what is drawn: ${
      JSON.stringify(text)
    }`;
    assertEquals(rest, [], label);
    assertEquals(
      [cell.ch, cell.ansi?.underline, cell.ansi?.bold],
      ["Y", true, undefined],
      label,
    );
  }
});

Deno.test("ansi: overstrike emphasis adds to the syntax colors", () => {
  const keyword = { fg: [1, 2, 3] as const, italic: true };
  const [bold, plain] = displayLine(ln("x\bx+\bo"), "ansi", () => keyword);
  assertEquals(bold.ansi, { ...keyword, bold: true });
  assertEquals(plain.ansi, undefined, "no emphasis leaves the syntax colors");
  assertEquals(plain.syntax, keyword);
});

Deno.test("ansi: an overstrike takes the syntax colors of the character drawn", () => {
  const line: Line = {
    text: "_\bf",
    spans: [{ col: 0, text: "_\b", cls: "punctuation" }, {
      col: 2,
      text: "f",
      cls: "keyword",
    }],
  };
  const keyword = { fg: [1, 2, 3] as const };
  const [cell] = displayLine(
    line,
    "ansi",
    (span) => span.cls === "keyword" ? keyword : {},
  );
  assertEquals(cell.syntax, keyword);
  assertEquals(cell.ansi, { ...keyword, underline: true });
});

Deno.test("ansi: a backspace that does not overstrike shows as its glyph", () => {
  assertEquals(glyphs("x\b", "ansi"), "x␈", "nothing after it");
  assertEquals(glyphs("\bx", "ansi"), "␈x", "nothing before it");
  assertEquals(glyphs("\b\bx", "ansi"), "␈␈x", "a backspace before it");
  assertEquals(glyphs("\t\bx", "ansi"), "    ␈x", "a tab before it");
  assertEquals(glyphs("x\b\tx", "ansi"), "x␈  x", "a tab after it");
  assertEquals(
    glyphs("_\b\x1b[1mx", "ansi"),
    "_␈x",
    "a color sequence after it",
  );
});

Deno.test("displayColumnOf and sourceColumnOf: an overstrike is one column", () => {
  const line = ln("aN\bNb");
  for (const col of [1, 2, 3]) {
    assertEquals(displayColumnOf(line, "ansi", col), 1, `column ${col}`);
  }
  assertEquals(displayColumnOf(line, "ansi", 4), 2);
  assertEquals(sourceColumnOf(line, "ansi", 1), 1);
  assertEquals(sourceColumnOf(line, "ansi", 2), 4);
  assertEquals(displayColumnOf(line, "pictures", 4), 4, "pictures maps 1:1");
});

Deno.test("ansi: a cell visitor sees one cell for each overstrike", () => {
  const ranges: [number, number][] = [];
  visitDisplayCellSources("a😀\b😀b\bc", "ansi", (start, end) => {
    ranges.push([start, end]);
    return true;
  });

  assertEquals(ranges, [[0, 1], [1, 6], [6, 9]]);
});

Deno.test("pictures and hidden: an overstrike is not interpreted", () => {
  assertEquals(glyphs("N\bN", "pictures"), "N␈N");
  assertEquals(glyphs("N\bN", "hidden"), "N…N");
});

Deno.test("pictures and hidden: a tab is one cell", () => {
  assertEquals(glyphs("a\tb", "pictures"), "a␉b");
  assertEquals(glyphs("a\tb", "hidden"), "a…b");
});

//
// hidden mode
//

Deno.test("hidden: ANSI sequences are dropped whatever their final byte", () => {
  assertEquals(glyphs("a\x1b[31mb", "hidden"), "ab");
  assertEquals(glyphs("a\x1b[2Jb", "hidden"), "ab");
});

Deno.test("hidden: a run of control codes collapses to one ellipsis at its start", () => {
  const cells = displayLine(ln("a\x01\x02\x03b"), "hidden");
  assertEquals(cells.map((c) => c.ch).join(""), "a…b");
  assertEquals(cells[1].ch, "…");
  assertEquals(
    cells[1].col,
    1,
    "the ellipsis stands at the run's first column",
  );
  assertEquals(cells[1].sourceEnd, 4, "the ellipsis covers the complete run");
  assertEquals(cells[2].col, 4, "text after keeps its source column");
});

Deno.test("hidden: a lone ESC that opens no sequence joins the ellipsis run", () => {
  // ESC not followed by `[` is just another non-printable → part of the run.
  assertEquals(glyphs("a\x1bb", "hidden"), "a…b");
});

Deno.test("hidden: a cell visitor can stop on a collapsed control run", () => {
  const ranges: [number, number][] = [];
  const completed = visitDisplayCellSources(
    "\x01\x02x",
    "hidden",
    (start, end) => {
      ranges.push([start, end]);
      return false;
    },
  );

  assertEquals(completed, false);
  assertEquals(ranges, [[0, 2]]);
});

//
// source → display column mapping (horizontal scrolling)
//

Deno.test("displayColumnOf: pictures maps 1:1", () => {
  assertEquals(displayColumnOf(ln("a\x01b"), "pictures", 2), 2);
});

Deno.test("displayColumnOf: hidden maps a source column to the compacted column", () => {
  const line = ln("a\x01\x02\x03b"); // display cells stand at source cols 0, 1, 4
  assertEquals(displayColumnOf(line, "hidden", 0), 0, "a");
  assertEquals(displayColumnOf(line, "hidden", 1), 1, "the ellipsis");
  assertEquals(
    displayColumnOf(line, "hidden", 2),
    1,
    "inside the run → the ellipsis that draws it",
  );
  assertEquals(displayColumnOf(line, "hidden", 4), 2, "b");
  assertEquals(
    displayColumnOf(line, "hidden", 9),
    3,
    "past the end → display width",
  );
});

Deno.test("displayColumnOf: ansi skips a hidden color sequence", () => {
  const line = ln("a\x1b[31mb"); // display cells stand at source cols 0 and 6
  assertEquals(displayColumnOf(line, "ansi", 0), 0);
  assertEquals(
    displayColumnOf(line, "ansi", 3),
    1,
    "inside the escape → the next cell",
  );
  assertEquals(displayColumnOf(line, "ansi", 6), 1, "b");
});

Deno.test("displayColumnOf and sourceColumnOf: a tab spans its expanded cells", () => {
  const line = ln("a\tb"); // display cells stand at source cols 0, 1, 1, 1, 2
  assertEquals(displayColumnOf(line, "ansi", 1), 1, "the tab's first cell");
  assertEquals(displayColumnOf(line, "ansi", 2), 4, "b");
  assertEquals(sourceColumnOf(line, "ansi", 3), 1, "inside the tab");
  assertEquals(sourceColumnOf(line, "ansi", 4), 2, "b");
});

Deno.test("sourceColumnOf: maps compact display offsets back to source", () => {
  const line = ln("a\x1b[31mb");
  assertEquals(sourceColumnOf(line, "pictures", 3), 3);
  assertEquals(sourceColumnOf(line, "ansi", 1), 6);
  assertEquals(sourceColumnOf(line, "ansi", 9), 7);
  assertEquals(sourceColumnOf(ln("\x1b[31m"), "ansi", 0), 0);
});

//
// internals
//

Deno.test("drawsAsPictures: compares the glyphs and colors a mode draws", () => {
  const draws = (text: string, mode: DisplayMode) =>
    drawsAsPictures(text, mode);

  assertEquals(draws("plain", "ansi"), true);
  assertEquals(draws("bell\x07", "ansi"), true, "a bell draws as ␇ in both");
  assertEquals(draws("bell\x07", "hidden"), false, "hidden draws an ellipsis");
  assertEquals(draws("abc\td", "ansi"), false, "a tab draws blank");
  assertEquals(draws("\x1b[mx", "ansi"), false, "a color sequence is hidden");
  assertEquals(draws("\x1b[2Jx", "ansi"), true, "other sequences are drawn");
  assertEquals(draws("N\bN", "ansi"), false, "an overstrike is one cell");
  assertEquals(draws("N\bN\t\x1b[m", "pictures"), true);
});

Deno.test("glyphFor: DEL and C1 codes have block glyphs", () => {
  assertEquals(glyphFor("\x7f"), "␡");
  assertEquals(glyphFor("\x85"), "␦", "a C1 code uses the substitute glyph");
  assertEquals(glyphFor("x"), "x", "printable is itself");
});

Deno.test("internal applySgr: the full code range folds into a style", () => {
  const { applySgr } = _internal;
  assertEquals(applySgr({}, "1").bold, true);
  assertEquals(applySgr({}, "2").dim, true);
  assertEquals(applySgr({}, "3").italic, true);
  assertEquals(applySgr({}, "4").underline, true);
  assertEquals(applySgr({ bold: true, dim: true }, "22").bold, undefined);
  assertEquals(applySgr({ italic: true }, "23").italic, undefined);
  assertEquals(applySgr({ underline: true }, "24").underline, undefined);
  assertEquals(applySgr({}, "33").fg, [229, 229, 16], "yellow fg");
  assertEquals(applySgr({ fg: [1, 2, 3] }, "39").fg, undefined, "default fg");
  assertEquals(applySgr({}, "45").bg, [188, 63, 188], "magenta bg");
  assertEquals(applySgr({ bg: [1, 2, 3] }, "49").bg, undefined, "default bg");
  assertEquals(applySgr({}, "92").fg, [35, 209, 139], "bright green fg");
  assertEquals(applySgr({}, "105").bg, [214, 112, 214], "bright magenta bg");
  // A malformed extended-color code (missing its arguments) is ignored.
  assertEquals(applySgr({}, "38").fg, undefined);
  // A `48` extended-color code sets the background.
  assertEquals(applySgr({}, "48;5;21").bg, [0, 0, 255], "256-index background");
  assertEquals(
    applySgr({}, "48;2;9;8;7").bg,
    [9, 8, 7],
    "truecolor background",
  );
  // Anything unrecognized leaves the style unchanged.
  assertEquals(applySgr({ bold: true }, "73").bold, true);
});

Deno.test("internal xterm256: standard, cube and grayscale ranges", () => {
  const { xterm256 } = _internal;
  assertEquals(xterm256(1), [205, 49, 49], "0–15 use the standard palette");
  assertEquals(xterm256(16), [0, 0, 0], "cube corner is black");
  assertEquals(xterm256(231), [255, 255, 255], "cube corner is white");
  assertEquals(xterm256(232), [8, 8, 8], "grayscale ramp start");
  assertEquals(xterm256(255), [238, 238, 238], "grayscale ramp end");
});

Deno.test("internal matchCsi: parameter and intermediate bytes are part of the sequence", () => {
  // ESC [ ? 2 5 h — a private-mode set with a `?` parameter byte.
  assertEquals(glyphs("\x1b[?25hx", "hidden"), "x", "parameter byte consumed");
  // ESC [ 0 <space> q — a cursor-style set with a 0x20 intermediate byte.
  assertEquals(
    glyphs("\x1b[0 qx", "hidden"),
    "x",
    "intermediate byte consumed",
  );
});

Deno.test("internal matchCsi: an incomplete ESC[ is not a sequence", () => {
  // A trailing `ESC [` with no final byte does not form a CSI: the ESC is a lone
  // non-printable (→ ellipsis) and the `[` is printable.
  assertEquals(glyphs("a\x1b[", "hidden"), "a…[");
});
