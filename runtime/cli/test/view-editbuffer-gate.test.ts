import { assert, assertEquals } from "@std/assert";
import { EditBuffer } from "../lib/view/editbuffer.ts";

function at(b: EditBuffer): [number, number] {
  return [b.row, b.col];
}

//
// constructor / setText: the line-splitting paths
//
// `String.split("\n")` always yields an array of length >= 1 (even for the
// empty string it yields `[""]`), so the constructor and setText need no
// empty-buffer guard after the split. These tests pin that: the split supplies
// at least one line, and the cursor placement that follows stays in range.
//

Deno.test("editbuffer: constructor splits every input into at least one line", () => {
  // The empty string still produces a single empty line — the split, not the
  // guard, is what supplies it.
  assertEquals(new EditBuffer("").lines, [""]);
  assertEquals(new EditBuffer("\n").lines, ["", ""]);
  assertEquals(new EditBuffer("\n\n").lines, ["", "", ""]);
  assertEquals(new EditBuffer("a\nb\nc").lines, ["a", "b", "c"]);
  // A trailing newline keeps a trailing empty line.
  assertEquals(new EditBuffer("a\n").lines, ["a", ""]);
});

Deno.test("editbuffer: setText on the empty string still leaves one empty line", () => {
  const b = new EditBuffer("seed text");
  b.setText("");
  assertEquals(b.lines, [""], "empty replacement is one empty line");
  assertEquals(b.text(), "");
  assertEquals(at(b), [0, 0], "cursor clamps into the single empty line");
  // The baseline is untouched, so an empty replacement reads as dirty.
  assert(b.dirty(), "setText keeps the clean baseline");
  assertEquals(b.baseline(), "seed text");
});

Deno.test("editbuffer: setText splits multi-line text and clamps the cursor", () => {
  const b = new EditBuffer("x");
  b.setText("one\ntwo\nthree", 99, 99);
  assertEquals(b.lines, ["one", "two", "three"]);
  assertEquals(at(b), [2, 5], "row clamps to last line, col to its end");
});
