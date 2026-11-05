import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Key } from "../lib/view/keys.ts";
import { firstShown, LineEdit } from "../lib/view/lineedit.ts";

/** The key that types `char`. */
function typed(char: string): Key {
  return { name: char === " " ? "space" : char, char };
}

/** A line holding `value`, after `keys` in a field `width` wide. */
function edited(value: string, keys: readonly Key[], width = 10): LineEdit {
  const line = new LineEdit(value);
  for (const key of keys) line.handleKey(key, width);
  return line;
}

describe("lineedit", () => {
  describe("LineEdit", () => {
    it("starts with the cursor after the text", () => {
      const line = new LineEdit("relay:8081");

      expect([line.value, line.cursor, line.scroll]).toEqual([
        "relay:8081",
        10,
        0,
      ]);
    });

    it("inserts what is typed at the cursor, including spaces", () => {
      const line = edited("ac", [{ name: "left" }, typed("b"), typed(" ")]);

      expect([line.value, line.cursor]).toEqual(["ab c", 3]);
    });

    it("inserts pasted text without its line breaks", () => {
      const line = edited("", [{ name: "paste", text: "relay\r\n:8081\n" }]);

      expect([line.value, line.cursor]).toEqual(["relay:8081", 10]);
    });

    it("deletes the character before the cursor with Backspace, and after it with Delete", () => {
      expect(edited("abc", [{ name: "left" }, { name: "backspace" }]).value)
        .toBe("ac");
      expect(edited("abc", [{ name: "home" }, { name: "delete" }]).value)
        .toBe("bc");
      expect(edited("abc", [{ name: "home" }, { name: "backspace" }]).value)
        .toBe("abc");
      expect(edited("abc", [{ name: "delete" }]).value).toBe("abc");
    });

    it("deletes the word before the cursor, and what separates it from the cursor, with Alt-Backspace", () => {
      const keys = [{ name: "backspace", alt: true }];

      expect(edited("relay.example:8081", keys).value).toBe("relay.example:");
      expect(edited("relay.example: ", keys).value).toBe("relay.");
      expect(edited("relay", [{ name: "home" }, ...keys]).value).toBe("relay");
    });

    it("deletes the character after the cursor with Ctrl-D", () => {
      expect(edited("abc", [{ name: "ctrl-a" }, { name: "ctrl-d" }]).value)
        .toBe("bc");
    });

    it("moves the cursor with Left, Right, Home, End, and Ctrl-B, -F, -A, and -E, stopping at the ends", () => {
      const cursors = [
        [{ name: "left" }, { name: "left" }],
        [{ name: "home" }, { name: "left" }],
        [{ name: "ctrl-a" }, { name: "right" }],
        [{ name: "home" }, { name: "end" }, { name: "right" }],
        [{ name: "home" }, { name: "ctrl-e" }],
        [{ name: "ctrl-b" }, { name: "ctrl-b" }, { name: "ctrl-f" }],
      ].map((keys) => edited("abc", keys).cursor);

      expect(cursors).toEqual([1, 0, 1, 3, 3, 2]);
    });

    it("replaces the whole text with what is typed while all of it is selected", () => {
      const line = new LineEdit("old:1");

      line.selectAll(10);
      expect([line.selected, line.cursor]).toEqual([true, 5]);
      line.handleKey(typed("n"), 10);

      expect([line.value, line.cursor, line.selected]).toEqual(["n", 1, false]);
    });

    it("deletes the whole text with Backspace, Delete, or Ctrl-D while all of it is selected", () => {
      for (const name of ["backspace", "delete", "ctrl-d"]) {
        const line = new LineEdit("old:1");
        line.selectAll(10);

        line.handleKey({ name }, 10);

        expect([line.value, line.cursor, line.selected]).toEqual([
          "",
          0,
          false,
        ]);
      }
    });

    it("drops the selection when the cursor moves, keeping the text", () => {
      const line = new LineEdit("old:1");
      line.selectAll(10);

      line.handleKey({ name: "left" }, 10);

      expect([line.value, line.cursor, line.selected]).toEqual([
        "old:1",
        4,
        false,
      ]);
    });

    it("moves the cursor to where it is put, no further than the ends, dropping the selection", () => {
      const line = new LineEdit("abcdef");
      line.selectAll(4);

      line.moveTo(2, 4);
      expect([line.cursor, line.selected, line.scroll]).toEqual([2, false, 2]);
      line.moveTo(-1, 4);
      expect(line.cursor).toBe(0);
      line.moveTo(10, 4);
      expect([line.cursor, line.scroll]).toEqual([6, 3]);
    });

    it("returns false for, and ignores, a key that neither types nor edits", () => {
      const line = new LineEdit("abc");

      for (
        const key of [
          { name: "tab" },
          { name: "enter" },
          { name: "o", alt: true },
          { name: "ctrl-x", char: "x", ctrl: true },
          { name: "up" },
        ]
      ) {
        expect(line.handleKey(key, 10)).toBe(false);
      }
      expect([line.value, line.cursor]).toEqual(["abc", 3]);
      expect(line.handleKey(typed("d"), 10)).toBe(true);
    });

    it("keeps the field full as Backspace deletes at the end of text wider than it", () => {
      const line = new LineEdit("abcdefgh");
      line.handleKey({ name: "end" }, 4);
      expect(line.scroll).toBe(5);

      line.handleKey({ name: "backspace" }, 4);
      line.handleKey({ name: "backspace" }, 4);

      expect([line.value, line.cursor, line.scroll]).toEqual(["abcdef", 6, 3]);
    });

    it("drops the selection when told to, keeping the text and cursor", () => {
      const line = new LineEdit("abc");
      line.selectAll(10);

      line.deselect();

      expect([line.value, line.cursor, line.selected]).toEqual([
        "abc",
        3,
        false,
      ]);
    });

    it("moves the first character shown only as far as keeps the cursor in view", () => {
      const line = new LineEdit("");
      for (const char of "abcdefgh") line.handleKey(typed(char), 4);
      expect([line.cursor, line.scroll]).toEqual([8, 5]);

      line.handleKey({ name: "left" }, 4);
      line.handleKey({ name: "left" }, 4);
      expect([line.cursor, line.scroll]).toEqual([6, 5]);

      line.handleKey({ name: "home" }, 4);
      expect([line.cursor, line.scroll]).toEqual([0, 0]);
    });
  });

  describe("firstShown()", () => {
    it("returns the first character shown, moved only as far as it takes to show the cursor", () => {
      expect(firstShown(0, 3, 4, 9)).toBe(0);
      expect(firstShown(0, 9, 4, 9)).toBe(6);
      expect(firstShown(5, 7, 4, 9)).toBe(5);
      expect(firstShown(5, 2, 4, 9)).toBe(2);
      expect(firstShown(0, 3, 0, 3)).toBe(3);
    });

    it("moves back as far as it takes to leave no column empty past the end", () => {
      expect(firstShown(6, 5, 4, 5)).toBe(2);
      expect(firstShown(3, 2, 10, 2)).toBe(0);
    });
  });
});
