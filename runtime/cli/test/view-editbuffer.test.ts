import { assert, assertEquals } from "@std/assert";
import { EditBuffer } from "../lib/view/editbuffer.ts";
import { decodeKeys } from "../lib/view/keys.ts";

function at(b: EditBuffer): [number, number] {
  return [b.row, b.col];
}

//
// motion
//

Deno.test("editbuffer: left/right cross line boundaries", () => {
  const b = new EditBuffer("ab\ncd");
  b.row = 0;
  b.col = 2; // end of "ab"
  b.moveRight();
  assertEquals(at(b), [1, 0], "right at line end goes to next line start");
  b.moveLeft();
  assertEquals(at(b), [0, 2], "left at line start goes to prev line end");
});

Deno.test("editbuffer: up/down keep a goal column over short lines", () => {
  const b = new EditBuffer("longline\nx\nanother");
  b.row = 0;
  b.col = 6;
  b.moveDown(); // onto "x" (length 1) → clamps to 1
  assertEquals(at(b), [1, 1]);
  b.moveDown(); // back to a long line → goal column 6 restored
  assertEquals(at(b), [2, 6]);
});

Deno.test("editbuffer: line and word motion", () => {
  const b = new EditBuffer("  foo.bar baz");
  b.moveLineEnd();
  assertEquals(b.col, 13);
  b.moveLineStart();
  assertEquals(b.col, 0);
  b.moveWordForward();
  assertEquals(b.col, 5, "past `foo`");
  b.moveWordForward();
  assertEquals(b.col, 9, "past `bar`");
  b.moveWordBackward();
  assertEquals(b.col, 6, "back to start of `bar`");
});

//
// insertion / deletion
//

Deno.test("editbuffer: insert characters and a newline", () => {
  const b = new EditBuffer("ac");
  b.col = 1;
  b.insert("b");
  assertEquals(b.text(), "abc");
  assertEquals(at(b), [0, 2]);
  b.insertNewline();
  assertEquals(b.text(), "ab\nc");
  assertEquals(at(b), [1, 0]);
});

Deno.test("editbuffer: backspace joins lines, delete-forward too", () => {
  const b = new EditBuffer("ab\ncd");
  b.row = 1;
  b.col = 0;
  b.deleteBackward(); // join
  assertEquals(b.text(), "abcd");
  assertEquals(at(b), [0, 2]);
  b.col = 4;
  b.deleteForward(); // at very end: no-op
  assertEquals(b.text(), "abcd");
  b.col = 1;
  b.deleteForward();
  assertEquals(b.text(), "acd");
});

Deno.test("editbuffer: structural edits preserve source-owned CRLF transport", () => {
  const split = new EditBuffer("ab\r\ncd\r\n");
  split.col = 2;
  split.insertNewline(2);
  assertEquals(split.text(), "ab\r\n\r\ncd\r\n");

  const backward = new EditBuffer("ab\r\ncd\r\n");
  backward.row = 1;
  backward.deleteBackward(2);
  assertEquals(backward.text(), "abcd\r\n");
  assertEquals(at(backward), [0, 2]);

  const forward = new EditBuffer("ab\r\ncd\r\n");
  forward.col = 2;
  forward.deleteForward(2);
  assertEquals(forward.text(), "abcd\r\n");

  const killed = new EditBuffer("ab\r\ncd\r\n");
  killed.col = 2;
  killed.killLine(2);
  assertEquals(killed.text(), "abcd\r\n");
  assertEquals(killed.killRing[0], "\r\n");
  killed.yank();
  assertEquals(killed.text(), "ab\r\ncd\r\n");

  const terminal = new EditBuffer("ab\r\n");
  terminal.moveBufferEnd();
  terminal.insertNewline(0, "\r");
  assertEquals(terminal.text(), "ab\r\n\r\n");
});

Deno.test("editbuffer: structural edits carry exact line-ending provenance", () => {
  const crlf = { ending: "\r\n", bodyCarriesCrlfEnding: true } as const;
  const lf = { ending: "\n", bodyCarriesCrlfEnding: false } as const;
  const split = new EditBuffer("a\nb", [crlf, lf]);
  split.col = 1;
  split.insertNewline();
  assertEquals(split.lineEndingProvenance(), [crlf, crlf, lf]);
  split.deleteBackward();
  assertEquals(split.lineEndingProvenance(), [crlf, lf]);

  const replaced = new EditBuffer("a\nb", [crlf, lf]);
  replaced.spliceLines(0, 1, ["head", "tail"], 0, 0);
  assertEquals(replaced.lineEndingProvenance(), [crlf, crlf, lf]);
  replaced.spliceLines(0, 2, ["joined"], 0, 0);
  assertEquals(replaced.lineEndingProvenance(), [crlf, lf]);
  replaced.spliceLines(1, 0, ["inserted"], 0, 0);
  assertEquals(replaced.lineEndingProvenance(), [crlf, undefined, lf]);
  replaced.setLineEndingProvenance([lf]);
  assertEquals(replaced.lineEndingProvenance(), [lf, undefined, undefined]);
});

Deno.test("editbuffer: dirty tracks against the original", () => {
  const b = new EditBuffer("x");
  assert(!b.dirty());
  b.insert("y");
  assert(b.dirty());
  b.deleteBackward();
  assert(!b.dirty(), "back to original content is clean again");
});

Deno.test("editbuffer: commitSaved makes the current text clean", () => {
  const b = new EditBuffer("before");
  b.moveLineEnd();
  b.insert(" after");
  assert(b.dirty(), "the edit starts dirty");

  b.commitSaved();
  assertEquals(b.baseline(), "before after");
  assert(!b.dirty(), "the saved text is the new clean baseline");

  b.insert(" again");
  assert(b.dirty(), "a later edit is measured against the saved text");
});

//
// kill / yank
//

Deno.test("editbuffer: kill-line then yank round-trips", () => {
  const b = new EditBuffer("hello world");
  b.col = 6;
  b.killLine(); // kills "world"
  assertEquals(b.text(), "hello ");
  b.yank();
  assertEquals(b.text(), "hello world");
});

Deno.test("editbuffer: kill-whole-line removes the line", () => {
  const b = new EditBuffer("a\nb\nc");
  b.row = 1;
  b.killWholeLine();
  assertEquals(b.text(), "a\nc");
  assertEquals(b.row, 1);
  b.yank();
  assertEquals(b.text(), "a\nb\nc");
});

Deno.test("editbuffer: kill-whole-line of the last line keeps no trailing newline", () => {
  // A single line with no terminating newline: kill it, then yank it back. The
  // round-trip must reproduce the original exactly, leaving the buffer clean.
  const b = new EditBuffer("only");
  b.killWholeLine();
  assertEquals(b.killRing[0], "only", "no spurious newline on the ring entry");
  b.yank();
  assertEquals(b.text(), "only");
  assert(!b.dirty(), "yank of the killed last line does not dirty content");

  // The last line of a multi-line buffer also has no terminating newline.
  const c = new EditBuffer("a\nb");
  c.row = 1; // on "b", the last line
  c.killWholeLine();
  assertEquals(c.killRing[0], "b", "last line carries no trailing newline");

  // A non-last line does have a terminating newline, which must be preserved.
  const d = new EditBuffer("x\ny");
  d.row = 0; // on "x", followed by "y"
  d.killWholeLine();
  assertEquals(d.killRing[0], "x\n", "a non-last line keeps its newline");
  d.yank();
  assertEquals(d.text(), "x\ny");
  assert(!d.dirty());

  const crlf = { ending: "\r\n", bodyCarriesCrlfEnding: true } as const;
  const eof = { ending: "", bodyCarriesCrlfEnding: false } as const;
  const endings = new EditBuffer("a\nb", [crlf, eof]);
  endings.row = 1;
  endings.killWholeLine();
  assertEquals(endings.lineEndingProvenance(), [eof]);
});

Deno.test("editbuffer: consecutive kills accrete into one ring entry", () => {
  const b = new EditBuffer("abcdef");
  b.col = 0;
  b.killWordForward(); // "abcdef" is one word → kills all
  const b2 = new EditBuffer("foo bar");
  b2.col = 0;
  b2.killWordForward(); // "foo"
  b2.killWordForward(); // " bar" — accretes
  assertEquals(b2.killRing.length, 1, "one accreted entry");
  b2.yank();
  assertEquals(b2.text(), "foo bar");
  assert(b.text() === "", "single word fully killed");
});

Deno.test("editbuffer: backward kill word prepends and moves point", () => {
  const b = new EditBuffer("alpha beta");
  b.moveLineEnd();
  b.killWordBackward(); // kills "beta"
  assertEquals(b.text(), "alpha ");
  assertEquals(b.col, 6);
});

Deno.test("editbuffer: kill region between mark and point", () => {
  const b = new EditBuffer("0123456789");
  b.col = 2;
  b.setMark();
  b.col = 7;
  b.killRegion(); // removes "23456"
  assertEquals(b.text(), "01789");
  assertEquals(b.col, 2);
  b.yank();
  assertEquals(b.text(), "0123456789", "yank restores at point");
});

Deno.test("editbuffer: yank-pop cycles through the ring", () => {
  const b = new EditBuffer("");
  // Seed three independent kills (non-consecutive so they are separate).
  for (const word of ["one", "two", "three"]) {
    const k = new EditBuffer(word);
    k.moveLineEnd();
    k.col = 0;
    k.killLine();
    b.killRing.unshift(k.killRing[0]); // newest first: three, two, one... build manually
  }
  // Ring is ["one","two","three"] after the unshifts above reverse order; just
  // assert yank then yank-pop changes what is inserted.
  b.killRing = ["A", "B", "C"];
  b.yank();
  assertEquals(b.text(), "A");
  b.yankPop();
  assertEquals(b.text(), "B", "yank-pop replaces with the next entry");
  b.yankPop();
  assertEquals(b.text(), "C");
  b.yankPop();
  assertEquals(b.text(), "A", "wraps around the ring");
});

//
// case ops
//

Deno.test("editbuffer: case operations transform the next word, advancing", () => {
  const b = new EditBuffer("foo BAR baz");
  b.col = 0;
  b.uppercaseWord();
  assertEquals(b.text(), "FOO BAR baz");
  assertEquals(b.col, 3);
  b.moveWordForward(); // onto end of BAR
  b.col = 8; // start of baz
  b.capitalizeWord();
  assertEquals(b.text(), "FOO BAR Baz");
  b.moveLineStart();
  b.lowercaseWord();
  assertEquals(b.text(), "foo BAR Baz");
});

//
// non-BMP
//

Deno.test("editbuffer: cursor steps whole code points past an emoji", () => {
  const b = new EditBuffer("a😀b");
  b.col = 0;
  b.moveRight();
  b.moveRight(); // over the emoji as one column
  assertEquals(b.col, 2);
  b.insertChar("X");
  assertEquals(b.text(), "a😀Xb");
  b.deleteBackward();
  assertEquals(b.text(), "a😀b");
  b.moveLeft();
  b.deleteForward(); // deletes the emoji as one unit
  assertEquals(b.text(), "ab");
});

//
// key decoding
//

function decode1(bytes: number[]) {
  const { keys } = decodeKeys(new Uint8Array(bytes));
  return keys;
}

Deno.test("keys: Alt+arrow carries the alt modifier", () => {
  // ESC [ 1 ; 3 A  == Alt+Up
  const [k] = decode1([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41]);
  assertEquals(k.name, "up");
  assertEquals(k.alt, true);
});

Deno.test("keys: Alt+letter and Alt+backspace", () => {
  assertEquals(decode1([0x1b, 0x66])[0], { name: "f", alt: true } as never);
  const back = decode1([0x1b, 0x7f])[0];
  assertEquals(back.name, "backspace");
  assertEquals(back.alt, true);
});

Deno.test("keys: F3 from SS3 and from the tilde form", () => {
  assertEquals(decode1([0x1b, 0x4f, 0x52])[0].name, "f3"); // ESC O R
  assertEquals(decode1([0x1b, 0x5b, 0x31, 0x33, 0x7e])[0].name, "f3"); // ESC [ 13 ~
});

Deno.test("keys: plain ESC is Escape, ESC ESC is Escape", () => {
  assertEquals(decode1([0x1b])[0].name, "escape");
  assertEquals(decode1([0x1b, 0x1b])[0].name, "escape");
});

Deno.test("keys: ctrl chords decode for the editor bindings", () => {
  assertEquals(decode1([0x18])[0].name, "ctrl-x");
  assertEquals(decode1([0x13])[0].name, "ctrl-s");
  assertEquals(decode1([0x19])[0].name, "ctrl-y");
  assertEquals(decode1([0x17])[0].name, "ctrl-w");
  assertEquals(decode1([0x0b])[0].name, "ctrl-k");
});
