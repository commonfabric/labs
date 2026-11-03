/**
 * A text field of a terminal view: one line, or many soft-wrapped to the
 * field's width, edited with the keys a terminal user expects, with undo, and
 * with the cursor placed by a click. The text and the cursor are `cf view`'s
 * edit buffer; this lays them out and binds keys to them.
 */

import { EditBuffer } from "@commonfabric/cli/view/editbuffer";
import type { Key } from "@commonfabric/cli/view/keys";
import type { Style } from "@commonfabric/cli/view/ansi";

import {
  charColumns,
  graphemes,
  printable,
  type Row,
  type Span,
} from "./text.ts";

/** One row of the field as laid out: a run of a line's code points. */
interface Segment {
  line: number;

  /** The code points of the line the row starts and ends at. */
  start: number;
  end: number;
}

/** Text and a cursor, as an undo step restores them. */
interface Snapshot {
  text: string;
  row: number;
  col: number;
}

/** The most undo steps a field keeps. */
const UNDO_DEPTH = 200;

/** A field holding text the person edits. */
export class Field {
  readonly #buffer: EditBuffer;
  readonly #multiline: boolean;
  readonly #undo: Snapshot[] = [];
  readonly #redo: Snapshot[] = [];

  /** Whether the last edit was typing a character, which an undo groups. */
  #typing = false;

  /** The first row shown, and the width the field was last drawn at. */
  #top = 0;
  #width = 80;

  /** For one line, the first column shown. */
  #left = 0;

  /** `text` in a field of one line, or of many when `multiline` is set. */
  constructor(text: string, multiline = false) {
    this.#multiline = multiline;
    this.#buffer = new EditBuffer(multiline ? text : text.replace(/\n/g, " "));
    this.#buffer.moveBufferEnd();
  }

  get text(): string {
    return this.#buffer.text();
  }

  /** Replaces the text, with the cursor at its end, as an undoable edit. */
  set text(text: string) {
    this.#typing = false;
    this.#edit(() => {
      this.#buffer.setText(this.#multiline ? text : text.replace(/\n/g, " "));
      this.#buffer.moveBufferEnd();
    });
  }

  /**
   * Applies `key` to the field, returning whether the field took it. Enter
   * starts a new line in a field of many lines and is left to the caller in
   * one of one line, as are Tab, Escape, and keys the field has no use for.
   */
  key(key: Key): boolean {
    const b = this.#buffer;
    const char = key.char;
    if (key.name === "paste" && key.text !== undefined) {
      // A paste is an undo step of its own, and keeps no character a
      // terminal would act on but a line break, and a tab in a field of
      // many lines.
      this.#typing = false;
      const text = key.text.replace(/\r\n?/g, "\n").replace(
        /[^\P{Cc}\t\n]/gu,
        "",
      );
      this.#insert(
        this.#multiline ? text : text.replace(/[\t\n]+/g, " "),
      );
      return true;
    }
    if (char !== undefined && !key.ctrl && !key.alt) {
      if (this.#typing) b.insert(char);
      else this.#edit(() => b.insert(char));
      this.#typing = true;
      return true;
    }
    this.#typing = false;
    const edit = (act: () => void) => {
      this.#edit(act);
      return true;
    };
    const move = (act: () => void) => {
      act();
      return true;
    };
    switch (key.alt ? `alt-${key.name}` : key.name) {
      case "left":
        return move(() => key.ctrl ? b.moveWordBackward() : this.#across(-1));
      case "right":
        return move(() => key.ctrl ? b.moveWordForward() : this.#across(1));
      case "alt-b":
      case "alt-left":
        return move(() => b.moveWordBackward());
      case "alt-f":
      case "alt-right":
        return move(() => b.moveWordForward());
      case "ctrl-b":
        return move(() => this.#across(-1));
      case "ctrl-f":
        return move(() => this.#across(1));
      case "up":
      case "ctrl-p":
        return this.#multiline && move(() => this.#vertical(-1));
      case "down":
      case "ctrl-n":
        return this.#multiline && move(() => this.#vertical(1));
      case "pageup":
        return this.#multiline && move(() => this.#vertical(-10));
      case "pagedown":
        return this.#multiline && move(() => this.#vertical(10));
      case "home":
      case "ctrl-a":
        return move(() =>
          key.ctrl && key.name === "home"
            ? b.moveBufferStart()
            : b.moveLineStart()
        );
      case "end":
      case "ctrl-e":
        return move(() =>
          key.ctrl && key.name === "end" ? b.moveBufferEnd() : b.moveLineEnd()
        );
      case "enter":
        return this.#multiline && edit(() => b.insertNewline());
      case "backspace":
        return edit(() => {
          for (let n = this.#across(-1, false); n > 0; n--) b.deleteBackward();
        });
      case "delete":
      case "ctrl-d":
        return edit(() => {
          for (let n = this.#across(1, false); n > 0; n--) b.deleteForward();
        });
      case "alt-backspace":
      case "ctrl-w":
        return edit(() => b.killWordBackward());
      case "alt-d":
        return edit(() => b.killWordForward());
      case "ctrl-k":
        return edit(() => b.killLine());
      case "ctrl-u":
        return edit(() => {
          b.setMark();
          b.moveLineStart();
          b.killRegion();
        });
      case "ctrl-y":
        return edit(() => b.yank());
      case "ctrl-z":
      case "ctrl-_":
        return move(() => this.#step(this.#undo, this.#redo));
      case "ctrl-r":
        return move(() => this.#step(this.#redo, this.#undo));
      default:
        return false;
    }
  }

  /**
   * The field drawn `width` columns by `height` rows in `style`, with the
   * cursor shown in `cursor` when it has one: the rows, and where each is
   * clicked to place the cursor.
   */
  draw(width: number, height: number, style: Style, cursor?: Style): Row[] {
    this.#width = width;
    const b = this.#buffer;
    if (!this.#multiline) {
      const chars = graphemes(b.lines[0]);
      const at = graphemeIndex(chars, b.col);
      const before = columnsOf(chars.slice(0, at));
      const wide = at < chars.length ? charColumns(printable(chars[at])) : 1;
      if (before < this.#left) this.#left = before;
      if (before + wide - this.#left > width) {
        // Scrolled to where a character begins, so that none is cut.
        let left = 0;
        for (const char of chars) {
          if (left >= before + wide - width) break;
          left += charColumns(printable(char));
        }
        this.#left = left;
      }
      return [
        this.#row(chars, 0, chars.length, at, style, cursor, this.#left, width),
      ];
    }
    const segments = this.#layout(width);
    // Each line's characters, split once however many rows it takes.
    const split = new Map<number, string[]>();
    const charsOf = (line: number) => {
      let chars = split.get(line);
      if (chars === undefined) {
        chars = graphemes(b.lines[line]);
        split.set(line, chars);
      }
      return chars;
    };
    const here = this.#cursorSegment(segments);
    if (here < this.#top) this.#top = here;
    if (here >= this.#top + height) this.#top = here - height + 1;
    this.#top = Math.max(0, Math.min(this.#top, segments.length - 1));
    const rows: Row[] = [];
    for (let index = this.#top; index < this.#top + height; index++) {
      const segment = segments[index];
      if (segment === undefined) {
        rows.push([{ text: " ".repeat(width), style }]);
        continue;
      }
      const chars = charsOf(segment.line);
      const startAt = graphemeIndex(chars, segment.start);
      const endAt = graphemeIndex(chars, segment.end);
      const cursorAt = index === here ? graphemeIndex(chars, b.col) : -1;
      rows.push(
        this.#row(chars, startAt, endAt, cursorAt, style, cursor, 0, width),
      );
    }
    return rows;
  }

  /**
   * Places the cursor where the cell `column`, `row` of the field as last
   * drawn shows.
   */
  place(column: number, row: number): void {
    this.#typing = false;
    const b = this.#buffer;
    if (!this.#multiline) {
      const chars = graphemes(b.lines[0]);
      b.place(0, codePointAt(chars, 0, chars.length, column + this.#left));
      return;
    }
    const segments = this.#layout(this.#width);
    const segment = segments[Math.min(this.#top + row, segments.length - 1)];
    const chars = graphemes(b.lines[segment.line]);
    b.place(
      segment.line,
      codePointAt(
        chars,
        graphemeIndex(chars, segment.start),
        graphemeIndex(chars, segment.end),
        column,
      ),
    );
  }

  /** One row: the characters `from` to `to` of `chars`, `left` columns in. */
  #row(
    chars: readonly string[],
    from: number,
    to: number,
    cursorAt: number,
    style: Style,
    cursor: Style | undefined,
    left: number,
    width: number,
  ): Row {
    const spans: Span[] = [];
    let used = 0;
    let skipped = 0;
    let text = "";
    const flush = () => {
      if (text !== "") spans.push({ text, style });
      text = "";
    };
    for (let index = from; index <= to; index++) {
      const char = index < to ? printable(chars[index]) : " ";
      const wide = charColumns(char);
      if (skipped < left) {
        skipped += wide;
        continue;
      }
      if (used + wide > width) break;
      if (index === cursorAt && cursor !== undefined) {
        flush();
        spans.push({ text: char, style: cursor });
      } else if (index < to) {
        text += char;
      } else {
        break;
      }
      used += wide;
    }
    flush();
    if (used < width) spans.push({ text: " ".repeat(width - used), style });
    return spans;
  }

  /**
   * Moves the cursor one character as a reader sees it in direction `by`,
   * however many code points it holds, onto the next line at a line's end;
   * or, when `moving` is unset, leaves the cursor and returns how many code
   * points that character holds, which an edit deletes.
   */
  #across(by: 1 | -1, moving = true): number {
    const b = this.#buffer;
    const chars = graphemes(b.lines[b.row]);
    const index = graphemeIndex(chars, b.col);
    const char = by < 0 ? chars[index - 1] : chars[index];
    // At a line's end the step crosses the line break, one code point.
    const size = char === undefined ? 1 : [...char].length;
    if (moving) {
      if (char === undefined) {
        if (by < 0) b.moveLeft();
        else b.moveRight();
      } else {
        b.place(b.row, b.col + by * size);
      }
    }
    return size;
  }

  /**
   * The rows the text lays out in, in a field `width` columns wide: one
   * column narrower, so that the cursor at the end of a full row still has
   * a cell to show in.
   */
  #layout(width: number): Segment[] {
    const segments: Segment[] = [];
    this.#buffer.lines.forEach((line, index) => {
      for (const [start, end] of breaks(line, Math.max(1, width - 1))) {
        segments.push({ line: index, start, end });
      }
    });
    return segments;
  }

  /** The row of `segments` the cursor is in. */
  #cursorSegment(segments: readonly Segment[]): number {
    const { row, col } = this.#buffer;
    let found = 0;
    segments.forEach((segment, index) => {
      if (segment.line === row && segment.start <= col) found = index;
    });
    return found;
  }

  /** Moves the cursor `by` rows as laid out, keeping its column. */
  #vertical(by: number): void {
    const b = this.#buffer;
    const segments = this.#layout(this.#width);
    const here = this.#cursorSegment(segments);
    const segment = segments[here];
    const chars = graphemes(b.lines[segment.line]);
    const column = columnsOf(
      chars.slice(
        graphemeIndex(chars, segment.start),
        graphemeIndex(chars, b.col),
      ),
    );
    const target =
      segments[Math.max(0, Math.min(segments.length - 1, here + by))];
    const into = graphemes(b.lines[target.line]);
    b.place(
      target.line,
      codePointAt(
        into,
        graphemeIndex(into, target.start),
        graphemeIndex(into, target.end),
        column,
      ),
    );
  }

  /** Inserts `text` at the cursor as one undoable edit. */
  #insert(text: string): void {
    this.#edit(() => this.#splice(text));
  }

  /** Helper for {@link #insert}, which puts `text` at the cursor. */
  #splice(text: string): void {
    const b = this.#buffer;
    const lines = b.lines;
    const before = [
      ...lines.slice(0, b.row),
      [...lines[b.row]].slice(0, b.col).join(""),
    ].join("\n");
    const after = [
      [...lines[b.row]].slice(b.col).join(""),
      ...lines.slice(b.row + 1),
    ].join("\n");
    const inserted = before + text;
    const insertedLines = inserted.split("\n");
    b.setText(inserted + after);
    b.place(insertedLines.length - 1, [...insertedLines.at(-1) ?? ""].length);
  }

  /**
   * Runs `act`, recording the text as it stood for an undo to restore, if
   * `act` changed it.
   */
  #edit(act: () => void): void {
    const b = this.#buffer;
    const before = { text: b.text(), row: b.row, col: b.col };
    act();
    if (b.text() === before.text) return;
    this.#undo.push(before);
    if (this.#undo.length > UNDO_DEPTH) this.#undo.shift();
    this.#redo.length = 0;
  }

  /** Restores the last snapshot of `from`, recording the present on `to`. */
  #step(from: Snapshot[], to: Snapshot[]): void {
    const b = this.#buffer;
    const snapshot = from.pop();
    if (snapshot === undefined) return;
    to.push({ text: b.text(), row: b.row, col: b.col });
    b.setText(snapshot.text, snapshot.row, snapshot.col);
  }
}

/**
 * Where `line` breaks into rows `width` columns wide, as runs of code
 * points: after the last space that fits, or where the row is full when no
 * space does. An empty line is one empty row.
 */
export function breaks(line: string, width: number): [number, number][] {
  const chars = graphemes(line);
  const rows: [number, number][] = [];
  let start = 0;
  let startIndex = 0;
  let used = 0;
  // The code point after the last space on the row, and its grapheme index.
  let space = -1;
  let spaceIndex = -1;
  let at = 0;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    const wide = charColumns(printable(char));
    if (used + wide > width && index > startIndex) {
      if (space > start) {
        rows.push([start, space]);
        used = columnsOf(chars.slice(spaceIndex, index));
        start = space;
        startIndex = spaceIndex;
      } else {
        rows.push([start, at]);
        used = 0;
        start = at;
        startIndex = index;
      }
      space = -1;
    }
    used += wide;
    at += [...char].length;
    if (char === " ") {
      space = at;
      spaceIndex = index + 1;
    }
  }
  rows.push([start, at]);
  return rows;
}

function columnsOf(chars: readonly string[]): number {
  return chars.reduce((n, char) => n + charColumns(printable(char)), 0);
}

/** The grapheme of `chars` that the code point `cp` begins. */
function graphemeIndex(chars: readonly string[], cp: number): number {
  let at = 0;
  for (let index = 0; index < chars.length; index++) {
    if (at >= cp) return index;
    at += [...chars[index]].length;
  }
  return chars.length;
}

/**
 * The code point the grapheme of `chars` between `from` and `to` that the
 * column `column` falls on begins at.
 */
function codePointAt(
  chars: readonly string[],
  from: number,
  to: number,
  column: number,
): number {
  let cp = chars.slice(0, from).reduce((n, char) => n + [...char].length, 0);
  let used = 0;
  for (let index = from; index < to; index++) {
    const wide = charColumns(printable(chars[index]));
    if (used + wide > column) return cp;
    used += wide;
    cp += [...chars[index]].length;
  }
  return cp;
}
