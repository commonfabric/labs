import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { decodeKeys } from "@commonfabric/cli/view/keys";

import { breaks, Field } from "./field.ts";

/** Types `text`, as the bytes a terminal sends, into `field`. */
function type(field: Field, text: string): void {
  for (const key of decodeKeys(new TextEncoder().encode(text)).keys) {
    field.key(key);
  }
}

/** `field` drawn `width` by `height`, as text, the cursor shown as `|`. */
function shown(field: Field, width: number, height = 1): string[] {
  return field.draw(width, height, {}, { underline: true }).map((row) =>
    row.map((s) =>
      s.style.underline ? `|${s.text === " " ? "" : s.text}` : s.text
    )
      .join("").trimEnd()
  );
}

describe("field", () => {
  describe("breaks()", () => {
    it("breaks a line after the last space that fits, and where the row is full when none does", () => {
      expect(breaks("one two three", 8)).toEqual([[0, 8], [8, 13]]);
      expect(breaks("abcdefghij", 4)).toEqual([[0, 4], [4, 8], [8, 10]]);
      expect(breaks("", 4)).toEqual([[0, 0]]);
    });

    it("measures a wide character as two columns, in code points", () => {
      expect(breaks("日本語", 4)).toEqual([[0, 2], [2, 3]]);
      expect(breaks("👍🏽👍🏽", 2)).toEqual([[0, 2], [2, 4]]);
    });
  });

  describe("Field", () => {
    it("inserts what is typed at the cursor, and moves and deletes as a shell does", () => {
      const field = new Field("");
      type(field, "hello world");
      type(field, "\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D"); // five lefts
      type(field, "big ");

      expect(field.text).toBe("hello big world");

      type(field, "\x01"); // Control-A
      type(field, "\x0b"); // Control-K

      expect(field.text).toBe("");

      type(field, "\x19"); // Control-Y yanks what was killed

      expect(field.text).toBe("hello big world");
    });

    it("undoes a run of typing as one step, and redoes it", () => {
      const field = new Field("a");
      type(field, "bcd");
      type(field, "\x7f"); // Backspace

      expect(field.text).toBe("abc");

      type(field, "\x1a"); // Control-Z
      expect(field.text).toBe("abcd");
      type(field, "\x1a");
      expect(field.text).toBe("a");
      type(field, "\x12"); // Control-R
      expect(field.text).toBe("abcd");
    });

    it("takes a paste whole: lines in a field of many, spaces in a field of one", () => {
      const many = new Field("", true);
      type(many, "\x1b[200~one\r\ntwo\x1b[201~");
      const one = new Field("");
      type(one, "\x1b[200~one\ntwo\x1b[201~");

      expect(many.text).toBe("one\ntwo");
      expect(one.text).toBe("one two");
    });

    it("keeps a paste an undo step of its own, without characters a terminal would act on", () => {
      const field = new Field("", true);
      type(field, "ab");
      type(field, "\x1b[200~P\x07A\x1b]0;x\tS\x1b[201~");
      type(field, "cd");

      expect(field.text).toBe("abPA]0;x\tScd");

      type(field, "\x1a");
      expect(field.text).toBe("abPA]0;x\tS");
      type(field, "\x1a");
      expect(field.text).toBe("ab");
    });

    it("starts a new line on Enter in a field of many lines, and leaves Enter alone in one", () => {
      const many = new Field("a", true);
      const one = new Field("a");
      const enter = decodeKeys(new Uint8Array([13])).keys[0];

      expect(many.key(enter)).toBe(true);
      expect(many.text).toBe("a\n");
      expect(one.key(enter)).toBe(false);
      expect(one.text).toBe("a");
    });

    it("wraps a field of many lines to its width, moving up and down by rows as shown", () => {
      const field = new Field("one two three four", true);

      expect(shown(field, 9, 3)).toEqual(["one two", "three", "four|"]);

      type(field, "\x1b[A"); // up
      type(field, "X");

      expect(field.text).toBe("one two threXe four");
    });

    it("keeps a cell for the cursor at the end of a full row, and measures a tab as it is drawn", () => {
      expect(shown(new Field("abcd", true), 4, 2)).toEqual(["abc", "d|"]);
      expect(shown(new Field("ab\tcd\tef", true), 4, 3)).toEqual([
        "ab",
        "cd",
        "ef|",
      ]);
    });

    it("scrolls a field of one line to keep the cursor in view", () => {
      const field = new Field("abcdefghij");

      expect(shown(field, 5)).toEqual(["ghij|"]);

      type(field, "\x01");

      expect(shown(field, 5)).toEqual(["|abcde"]);
    });

    it("moves over and deletes a character of several code points as one", () => {
      const field = new Field("a👍🏽b");
      type(field, "\x1b[D\x1b[D"); // two lefts, to before the thumb
      type(field, "_");

      expect(field.text).toBe("a_👍🏽b");

      type(field, "\x1b[C\x1b[3~"); // right, then Delete

      expect(field.text).toBe("a_👍🏽");

      type(field, "\x7f"); // Backspace

      expect(field.text).toBe("a_");
    });

    it("moves by words without stopping inside a character", () => {
      const field = new Field("cafe\u0301 x");
      type(field, "\x01\x1b[1;5C\x7f"); // Home, Control-Right, Backspace

      expect(field.text).toBe("caf x");
    });

    it("moves across a line break one step at a time", () => {
      const field = new Field("ab\ncd", true);
      type(field, "\x1b[D\x1b[D\x1b[D"); // to the end of the first line
      type(field, "_");

      expect(field.text).toBe("ab_\ncd");

      type(field, "\x1b[3~"); // Delete joins the lines

      expect(field.text).toBe("ab_cd");
    });

    it("scrolls a field of one line to show a wide character under the cursor whole", () => {
      const field = new Field("abcd日");
      type(field, "\x1b[D"); // onto 日

      expect(shown(field, 4)).toEqual(["cd|日"]);
    });

    it("places the cursor where a click falls", () => {
      const field = new Field("one two three", true);
      shown(field, 9, 2);
      field.place(2, 1);
      type(field, "_");

      expect(field.text).toBe("one two th_ree");
    });

    it("draws a character a terminal would act on as a glyph", () => {
      const field = new Field("a\u0007b");

      expect(shown(field, 10)[0]).not.toContain("\u0007");
    });
  });
});
