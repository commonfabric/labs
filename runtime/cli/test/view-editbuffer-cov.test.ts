import { assert, assertEquals } from "@std/assert";
import { EditBuffer } from "../lib/view/editbuffer.ts";

function at(b: EditBuffer): [number, number] {
  return [b.row, b.col];
}

//
// construction / setText / spliceLines
//

Deno.test("editbuffer: constructor splits on newlines, single line otherwise", () => {
  const b = new EditBuffer("a\nb\nc");
  assertEquals(b.lines, ["a", "b", "c"]);
  const empty = new EditBuffer("");
  assertEquals(empty.lines, [""], "empty text is one empty line");
});

Deno.test("editbuffer: setText replaces content, clamps cursor, keeps baseline", () => {
  const b = new EditBuffer("original");
  assert(!b.dirty());
  // Place cursor out of range; setText must clamp into the new content.
  b.setText("one\ntwo", 99, 99);
  assertEquals(b.text(), "one\ntwo");
  assertEquals(at(b), [1, 3], "row clamps to last line, col clamps to its end");
  // Baseline is still "original", so the new text reads as dirty.
  assert(b.dirty(), "setText keeps the clean baseline so it measures dirty");
  assertEquals(b.baseline(), "original");
});

Deno.test("editbuffer: setText clears mark and resets goal/kill/yank", () => {
  const b = new EditBuffer("abcdef");
  b.setMark();
  assertEquals(b.mark, { row: 0, col: 0 });
  b.setText("xyz");
  assertEquals(b.mark, null, "setText clears the mark");
  assertEquals(b.text(), "xyz");
});

Deno.test("editbuffer: spliceLines replaces a range and positions the cursor", () => {
  const b = new EditBuffer("a\nb\nc");
  // Replace the single line at row 1 with a removed/added pair.
  b.spliceLines(1, 1, ["-b", "+B"], 1, 2);
  assertEquals(b.text(), "a\n-b\n+B\nc");
  assertEquals(at(b), [2, 2], "cursor at row+cursorRow, cursorCol");
});

Deno.test("editbuffer: spliceLines that empties the buffer falls back to one empty line", () => {
  const b = new EditBuffer("only");
  // Remove the only line with an empty replacement: lines becomes [].
  b.spliceLines(0, 1, [], 0, 0);
  assertEquals(b.lines, [""], "empty buffer is normalized to one empty line");
  assertEquals(b.text(), "");
  assertEquals(at(b), [0, 0]);
});

Deno.test("editbuffer: spliceLines clamps cursor into the replacement", () => {
  const b = new EditBuffer("a\nb\nc");
  b.spliceLines(0, 3, ["short"], 5, 99);
  assertEquals(b.text(), "short");
  assertEquals(
    at(b),
    [0, 5],
    "row and col clamp into the single replacement line",
  );
});

//
// vertical motion (moveUp)
//

Deno.test("editbuffer: moveUp keeps a goal column across short lines", () => {
  const b = new EditBuffer("first line\nx\nlast line");
  b.row = 2;
  b.col = 7;
  b.moveUp(); // onto "x" (length 1) → clamps to 1, goal column 7 retained
  assertEquals(at(b), [1, 1]);
  b.moveUp(); // back to a long line → goal column 7 restored
  assertEquals(at(b), [0, 7]);
});

Deno.test("editbuffer: moveUp at the top row is a no-op", () => {
  const b = new EditBuffer("top\nbottom");
  b.row = 0;
  b.col = 2;
  b.moveUp();
  assertEquals(at(b), [0, 2], "cannot move above the first line");
});

//
// buffer-edge motion
//

Deno.test("editbuffer: moveBufferStart goes to row 0 col 0", () => {
  const b = new EditBuffer("aaa\nbbb\nccc");
  b.row = 2;
  b.col = 3;
  b.moveBufferStart();
  assertEquals(at(b), [0, 0]);
});

Deno.test("editbuffer: moveBufferEnd goes to the last line's end", () => {
  const b = new EditBuffer("aaa\nbbb\ncccc");
  b.row = 0;
  b.col = 0;
  b.moveBufferEnd();
  assertEquals(at(b), [2, 4], "last row, col at its length");
});

//
// insertion edge
//

Deno.test("editbuffer: insert of an empty string is a no-op", () => {
  const b = new EditBuffer("abc");
  b.col = 1;
  b.insert("");
  assertEquals(b.text(), "abc");
  assertEquals(at(b), [0, 1], "cursor unchanged");
});

Deno.test("editbuffer: insert of a multi-line string splits and inserts", () => {
  const b = new EditBuffer("XY");
  b.col = 1;
  b.insert("a\nb");
  assertEquals(b.text(), "Xa\nbY");
  assertEquals(at(b), [1, 1]);
});

//
// deletion (line joins)
//

Deno.test("editbuffer: deleteForward deletes a character mid-line", () => {
  const b = new EditBuffer("abc");
  b.col = 1; // before "b", col < line length
  b.deleteForward();
  assertEquals(b.text(), "ac", "removes the character at the cursor");
  assertEquals(at(b), [0, 1], "cursor stays put");
});

Deno.test("editbuffer: deleteForward at line end joins with the next line", () => {
  const b = new EditBuffer("ab\ncd");
  b.row = 0;
  b.col = 2; // end of "ab"
  b.deleteForward();
  assertEquals(b.text(), "abcd", "joins the next line");
  assertEquals(at(b), [0, 2]);
  // At the very end of the buffer, deleteForward is a no-op.
  b.row = 0;
  b.col = 4;
  b.deleteForward();
  assertEquals(b.text(), "abcd");
});

//
// killLine / killWholeLine
//

Deno.test("editbuffer: killLine mid-line kills to the end of the line", () => {
  const b = new EditBuffer("hello world");
  b.col = 6; // col < line length, so it kills "world"
  b.killLine();
  assertEquals(b.text(), "hello ");
  assertEquals(b.killRing[0], "world", "the killed tail is on the ring");
  b.yank();
  assertEquals(b.text(), "hello world");
});

Deno.test("editbuffer: killLine at end of line kills the newline (joins next)", () => {
  const b = new EditBuffer("ab\ncd");
  b.row = 0;
  b.col = 2; // at end of "ab"
  b.killLine(); // kills the newline only
  assertEquals(b.text(), "abcd");
  b.yank();
  assertEquals(
    b.text(),
    "ab\ncd",
    "yanking the killed newline restores the split",
  );
});

Deno.test("editbuffer: killLine at the very end of the buffer is a no-op", () => {
  const b = new EditBuffer("solo");
  b.moveLineEnd();
  b.killLine();
  assertEquals(b.text(), "solo");
  assertEquals(b.killRing.length, 0, "nothing killed at buffer end");
});

Deno.test("editbuffer: killWholeLine on a multi-line buffer removes the line", () => {
  const b = new EditBuffer("a\nb\nc");
  b.row = 1;
  b.killWholeLine();
  assertEquals(b.text(), "a\nc");
  assertEquals(at(b), [1, 0]);
});

Deno.test("editbuffer: killWholeLine on the last line clamps the row back", () => {
  const b = new EditBuffer("a\nb");
  b.row = 1; // last line
  b.killWholeLine();
  assertEquals(b.text(), "a");
  assertEquals(b.row, 0, "row clamps back into range after removal");
});

Deno.test("editbuffer: killWholeLine on the only line empties it in place", () => {
  const b = new EditBuffer("solo");
  b.killWholeLine();
  assertEquals(b.text(), "", "the single line is emptied, not removed");
  assertEquals(b.lines.length, 1);
  b.yank();
  assertEquals(
    b.text(),
    "solo",
    "the line had no terminating newline, so the yank adds none",
  );
});

//
// killRegion / yank / yankPop early returns
//

Deno.test("editbuffer: killRegion with no mark is a no-op", () => {
  const b = new EditBuffer("hello");
  b.mark = null;
  b.col = 3;
  b.killRegion();
  assertEquals(b.text(), "hello");
  assertEquals(b.killRing.length, 0);
  assertEquals(b.col, 3, "cursor unchanged");
});

Deno.test("editbuffer: yank with an empty ring does nothing", () => {
  const b = new EditBuffer("abc");
  assertEquals(b.killRing.length, 0);
  b.yank();
  assertEquals(b.text(), "abc", "nothing to yank");
});

Deno.test("editbuffer: yankPop without a preceding yank is a no-op", () => {
  const b = new EditBuffer("abc");
  b.killRing = ["X", "Y"];
  // No yank happened, so yankIndex is -1 and lastYank is null.
  b.yankPop();
  assertEquals(b.text(), "abc", "yank-pop requires a preceding yank");
});

Deno.test("editbuffer: yankPop after a yank replaces with the next ring entry", () => {
  const b = new EditBuffer("");
  b.killRing = ["A", "B", "C"];
  b.yank();
  assertEquals(b.text(), "A");
  b.yankPop();
  assertEquals(b.text(), "B");
  b.yankPop();
  assertEquals(b.text(), "C");
  b.yankPop();
  assertEquals(b.text(), "A", "wraps around the ring");
});

//
// pushKill empty-text guard
//

Deno.test("editbuffer: killLine on an empty last line kills nothing", () => {
  // killLine at end of a non-final empty line joins; on the final empty line
  // it falls through to neither branch, so the ring stays empty.
  const b = new EditBuffer("");
  b.killLine();
  assertEquals(
    b.killRing.length,
    0,
    "empty kill text is not pushed onto the ring",
  );
  assertEquals(b.text(), "");
});

Deno.test("editbuffer: killWordForward with no word ahead pushes nothing", () => {
  // nextWordEnd finds no word, so cut returns "" and pushKill's empty-text
  // guard short-circuits without touching the ring.
  const b = new EditBuffer("foo   ");
  b.col = 6; // at the end, only trailing spaces remain ahead
  b.killWordForward();
  assertEquals(b.text(), "foo   ", "nothing removed");
  assertEquals(b.killRing.length, 0, "empty kill is not pushed");
});

//
// case operations
//

Deno.test("editbuffer: capitalizeWord with no letter/number leaves the word as-is", () => {
  const b = new EditBuffer("--- rest");
  b.col = 0;
  // nextWordEnd skips "--- " then lands on "rest"; but to exercise the no-match
  // branch, capitalize a segment with no letters or digits.
  const only = new EditBuffer("____");
  only.col = 0;
  only.capitalizeWord();
  assertEquals(
    only.text(),
    "____",
    "underscores are word chars but not letters/digits",
  );
  // And the normal path still capitalizes.
  b.capitalizeWord();
  assertEquals(b.text(), "--- Rest");
});

Deno.test("editbuffer: a word op whose word ends on the next line just moves to line end", () => {
  // Cursor is on a line of only non-word chars; nextWordEnd crosses to the next
  // line, so transformWord bails and moves the cursor to the current line end.
  const b = new EditBuffer("...\nword");
  b.row = 0;
  b.col = 0;
  b.uppercaseWord();
  assertEquals(
    b.text(),
    "...\nword",
    "text unchanged when the word is on the next line",
  );
  assertEquals(at(b), [0, 3], "cursor moves to the end of the current line");
});

//
// multi-line cut (via killRegion across lines)
//

Deno.test("editbuffer: killRegion across multiple lines cuts and rejoins", () => {
  const b = new EditBuffer("one\ntwo\nthree\nfour");
  b.row = 0;
  b.col = 1; // after "o" on line 0
  b.setMark();
  b.row = 3;
  b.col = 2; // after "fo" on line 3
  b.killRegion();
  assertEquals(b.text(), "our", "head of line0 + tail of line3");
  assertEquals(at(b), [0, 1]);
  b.yank();
  assertEquals(
    b.text(),
    "one\ntwo\nthree\nfour",
    "yank restores the full multi-line cut",
  );
});

Deno.test("editbuffer: killRegion handles a mark after point (orderPoints swaps)", () => {
  const b = new EditBuffer("0123456789");
  b.col = 7;
  b.setMark(); // mark is after where the cursor ends up
  b.col = 2; // point now before the mark
  b.killRegion(); // orderPoints must order point-before-mark
  assertEquals(
    b.text(),
    "01789",
    "removed 23456 regardless of mark/point order",
  );
  assertEquals(b.col, 2);
});

Deno.test("editbuffer: killWordForward across a line boundary cuts multiple lines", () => {
  // Cursor at the end of a line of separators forces nextWordEnd to cross to the
  // next line, so the kill spans two lines and exercises the multi-line cut.
  const b = new EditBuffer("ab \ncd");
  b.row = 0;
  b.col = 2; // on the space before the line end
  b.killWordForward(); // cuts from the space across the newline through "cd"
  assertEquals(
    b.text(),
    "ab",
    "the space, the newline, and the next word are removed",
  );
  b.yank();
  assertEquals(b.text(), "ab \ncd");
});

//
// word scanning across lines
//

Deno.test("editbuffer: moveWordForward crosses blank/short lines to the next word", () => {
  const b = new EditBuffer("ab\n\ncd");
  b.row = 0;
  b.col = 2; // end of "ab"
  b.moveWordForward(); // crosses the empty line to find "cd"
  assertEquals(
    at(b),
    [2, 2],
    "lands at the end of cd on the next non-empty line",
  );
});

Deno.test("editbuffer: moveWordForward at the very end of the buffer stays put", () => {
  const b = new EditBuffer("ab\n   ");
  b.row = 1;
  b.col = 3; // end of the all-space final line
  b.moveWordForward(); // no word anywhere ahead; returns the buffer end
  assertEquals(
    at(b),
    [1, 3],
    "no further word; cursor unchanged at buffer end",
  );
});

Deno.test("editbuffer: moveWordBackward crosses an earlier line to the previous word", () => {
  const b = new EditBuffer("cd\n\nab");
  b.row = 2;
  b.col = 0; // start of "ab"
  b.moveWordBackward(); // crosses the blank line back to "cd"
  assertEquals(at(b), [0, 0], "lands at the start of cd on the earlier line");
});

Deno.test("editbuffer: moveWordBackward skips trailing separators back to the word", () => {
  // The cursor sits after non-word characters on the same line, so prevWordStart
  // first skips those separators backward, then the word, all on one line.
  const b = new EditBuffer("bar...");
  b.col = 6; // after the trailing dots
  b.moveWordBackward();
  assertEquals(at(b), [0, 0], "skips the dots and the word back to its start");
});

Deno.test("editbuffer: moveWordBackward at the very start of the buffer stays put", () => {
  const b = new EditBuffer("   \nab");
  b.row = 0;
  b.col = 0; // already at the start; nothing before
  b.moveWordBackward();
  assertEquals(
    at(b),
    [0, 0],
    "no previous word; cursor unchanged at buffer start",
  );
});
