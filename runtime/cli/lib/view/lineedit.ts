/**
 * The text of a dialog's input line while it is edited: the characters, the
 * cursor between them, whether the whole text is selected, and the first
 * character the field shows, which moves only as far as keeps the cursor in
 * view, as a Turbo Vision input line's does.
 */

import type { Key } from "./keys.ts";

/** A character of a word, as Alt-Backspace deletes one. */
const WORD = /\w/;

/**
 * Returns the first character that a field `width` characters wide shows of
 * text `length` characters long, once it has moved from `scroll` only as far
 * as it takes to show the character at `cursor`, or the end of the text when
 * that is where the cursor is, and to leave no column empty past the end.
 */
export function firstShown(
  scroll: number,
  cursor: number,
  width: number,
  length: number,
): number {
  const columns = Math.max(1, width);
  const latest = Math.min(cursor, Math.max(0, length + 1 - columns));
  return Math.max(cursor - columns + 1, Math.min(scroll, latest));
}

/** A line of text being edited. */
export class LineEdit {
  #chars: string[];
  #cursor: number;
  #scroll = 0;
  #selected = false;

  /** Constructs an instance holding `value`, with the cursor at its end. */
  constructor(value: string) {
    this.#chars = [...value];
    this.#cursor = this.#chars.length;
  }

  /** The text. */
  get value(): string {
    return this.#chars.join("");
  }

  /** How many characters precede the cursor. */
  get cursor(): number {
    return this.#cursor;
  }

  /** The index of the first character shown. */
  get scroll(): number {
    return this.#scroll;
  }

  /** Whether the whole text is selected, so that typing replaces it. */
  get selected(): boolean {
    return this.#selected;
  }

  /** Select the whole text, with the cursor after it, as moving the focus to
   * an input line does. */
  selectAll(width: number): void {
    this.#selected = true;
    this.#moveTo(this.#chars.length, width);
  }

  /** Drop the selection, as moving the focus away from the input line does. */
  deselect(): void {
    this.#selected = false;
  }

  /** Put the cursor before the character at `index`, or after the last when
   * `index` is past it, dropping any selection, as a click does. */
  moveTo(index: number, width: number): void {
    this.#selected = false;
    this.#moveTo(Math.max(0, Math.min(index, this.#chars.length)), width);
  }

  /**
   * Applies `key` when it types, deletes, or moves the cursor, keeping the
   * cursor inside a field that shows `width` characters, and returns whether
   * it was such a key. Typing inserts, and replaces the text while it is
   * selected. Backspace and Delete (or Ctrl-D) remove the character before
   * and after the cursor, or the selected text. Alt-Backspace removes the word
   * before the cursor and whatever separates it from the cursor. Left and
   * Right (or Ctrl-B and Ctrl-F), Home (or Ctrl-A), and End (or Ctrl-E) move
   * the cursor, and drop the selection.
   */
  handleKey(key: Key, width: number): boolean {
    const text = key.name === "paste"
      ? key.text?.replace(/[\r\n]+/g, "")
      : key.char !== undefined && key.char >= " " && !key.ctrl && !key.alt
      ? key.char
      : undefined;
    const deletes = key.name === "backspace" || key.name === "delete" ||
      key.name === "ctrl-d";
    if (this.#selected && (text !== undefined || deletes)) {
      this.#chars = [];
      this.#cursor = 0;
      this.#selected = false;
      if (text === undefined) {
        this.#moveTo(0, width);
        return true;
      }
    }
    const at = this.#cursor;
    let to = at;
    if (text !== undefined) {
      const typed = [...text];
      this.#chars = [
        ...this.#chars.slice(0, at),
        ...typed,
        ...this.#chars.slice(at),
      ];
      to = at + typed.length;
    } else if (key.name === "backspace" && key.alt) {
      while (to > 0 && !WORD.test(this.#chars[to - 1])) to--;
      while (to > 0 && WORD.test(this.#chars[to - 1])) to--;
      this.#chars.splice(to, at - to);
    } else if (key.name === "backspace") {
      if (at > 0) this.#chars.splice(at - 1, 1);
      to = at - 1;
    } else if (deletes) {
      this.#chars.splice(at, 1);
    } else if (key.name === "left" || key.name === "ctrl-b") {
      to = at - 1;
    } else if (key.name === "right" || key.name === "ctrl-f") {
      to = at + 1;
    } else if (key.name === "home" || key.name === "ctrl-a") {
      to = 0;
    } else if (key.name === "end" || key.name === "ctrl-e") {
      to = this.#chars.length;
    } else {
      return false;
    }
    this.moveTo(to, width);
    return true;
  }

  /** Helper for the methods that move the cursor, which puts it at `index`
   * and keeps it in view. */
  #moveTo(index: number, width: number): void {
    this.#cursor = index;
    this.#scroll = firstShown(this.#scroll, index, width, this.#chars.length);
  }
}
