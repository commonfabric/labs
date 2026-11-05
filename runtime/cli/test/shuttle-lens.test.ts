/**
 * Unit tests for the value view: the frame it draws, the keys it takes, and
 * what closing it cancels.
 *
 * The frame comes back as lines and the keys arrive decoded, so every case
 * drives the whole of it with no terminal. What a case can therefore assert is
 * the thing a terminal would have hidden: that every row of a frame is the
 * same width, that a repaint happens once per settle rather than once per
 * value on the way there, and that `q` cancels this lens's own subscription
 * and nothing else.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { unicodeWidth } from "@std/cli/unicode-width";

import { type FrameCursor, ValueLens } from "../lib/shuttle/lens.ts";
import type { Key } from "../lib/view/keys.ts";

/** How tall and wide a frame is where a case is not asking about the size. */
const ROWS = 8;
const COLUMNS = 40;

/** The cell a lens the cases below drive is a lens onto. */
const REFERENCE = "/of:fid1:abcdefghijklmnop/settings/depth";

/** Helper for the cases below, which is the key named `name`. */
function key(name: string): Key {
  return { name };
}

/** Helper for the cases below, which types `text` at `lens`, a key each. */
function types(lens: ValueLens, text: string): void {
  for (const char of text) lens.reads({ name: char, char });
}

/**
 * Helper for the cases below, which is a value long enough that the frame
 * shows a part of it: twenty entries, which renders as twenty-two lines.
 */
function long(): string[] {
  return ["alpha", "beta", "gamma", ...Array(17).fill("filler")];
}

/** What driving a lens produced: the lens, its repaints, and its cancels. */
interface Driven {
  /** The lens itself. */
  readonly lens: ValueLens;

  /** The frames it drew, in order. */
  readonly drawn: (readonly string[])[];

  /** Where it put the cursor on each of those frames, in the same order. */
  readonly cursors: (FrameCursor | undefined)[];

  /** How many times the subscription it holds has been cancelled. */
  cancels: () => number;
}

/**
 * Helper for the cases below, which is a lens already drawing and already
 * holding a subscription, recording both.
 */
function driving(
  label = "cell @space",
  rows = ROWS,
  columns = COLUMNS,
): Driven {
  const drawn: (readonly string[])[] = [];
  const cursors: (FrameCursor | undefined)[] = [];
  let cancelled = 0;
  const lens = new ValueLens(label, REFERENCE);
  lens.holding(() => cancelled++);
  lens.drawnThrough(() => {
    drawn.push(lens.frame(rows, columns));
    cursors.push(lens.cursor(rows, columns));
  });
  return { lens, drawn, cursors, cancels: () => cancelled };
}

/** Helper for the cases below, which is the frame a lens last drew. */
function last(driven: Driven): readonly string[] {
  return driven.drawn[driven.drawn.length - 1] ?? [];
}

/** Helper for the cases below, which is the body rows of `frame`. */
function body(frame: readonly string[]): string[] {
  return frame.slice(1, -1).map((row) => row.slice(2, -2).trimEnd());
}

/**
 * Helper for the cases below, which is the modeline of `frame`: the row above
 * the bottom edge, where a frame that has one draws it.
 */
function modeline(frame: readonly string[]): string {
  return (frame[frame.length - 2] ?? "").slice(2, -2).trimEnd();
}

/** Helper for the cases below, which is the bottom edge of `frame`. */
function keys(frame: readonly string[]): string {
  return frame[frame.length - 1] ?? "";
}

describe("lens", () => {
  describe("ValueLens", () => {
    describe("instance members", () => {
      describe("frame()", () => {
        it("returns as many rows as the terminal is tall", () => {
          expect(last(driving()).length).toBe(ROWS);
        });

        it("returns every row at the terminal's width", () => {
          // A row narrower or wider than the rest puts the frame's right edge
          // in two columns, which is what the padding and the fitting are for.

          const driven = driving();
          driven.lens.showing({ title: "verb contracts", replies: 14 });
          expect(last(driven).map((row) => unicodeWidth(row)))
            .toEqual(Array(ROWS).fill(COLUMNS));
        });

        it("fills a two-row terminal exactly", () => {
          // The frame is drawn onto the whole screen, so its height is the
          // screen's: one row taller scrolls its own top row away — and that
          // row is the one naming the cell — while one row shorter leaves
          // whatever the frame replaced still on screen under it. Two rows is
          // the size at which the two edges are the whole of it and the value
          // gets none.
          //
          // Exactly rather than at most, because at most is the assertion that
          // cannot fail in the direction a frame drawn short would fail.
          //
          // Kills: giving the value a row the edges have already taken, which
          // returns three rows for a screen with two; and dropping a row the
          // screen has room for, which returns one.

          const driven = driving("cell @space", 2, COLUMNS);
          driven.lens.showing({ replies: 14 });
          driven.lens.showing({ replies: 15 });
          expect(last(driven).length).toBe(2);
        });

        it("returns every row at one width on a five-column terminal", () => {
          // The narrowest a frame is drawn at. Both edges carry text that is
          // fitted to the room left after their own framing, and a row that
          // came back wider than the rest would put the right edge in two
          // columns at exactly the width where there is no room to spare.
          //
          // Kills: fitting either edge's text against the full width rather
          // than the width less its framing.

          const driven = driving("cell @space", ROWS, 5);
          driven.lens.showing({ a: 1, b: 2, c: 3 });
          expect(last(driven).map((row) => unicodeWidth(row)))
            .toEqual(Array(ROWS).fill(5));
        });

        it("holds that width against a character too wide for the column", () => {
          // The three texts a frame fits rather than wraps — the title, the
          // keys, and the line being typed — all reach `wrapped`, which takes a
          // single character wider than the whole width on its own and
          // overflows by a column, there being nowhere narrower to put it. That
          // is right for a page, which must show something or `more` could be
          // asked forever, and wrong on a frame, where the overflow puts the
          // right edge in two columns.
          //
          // All three at once, because the fit is one helper: the title here is
          // double-width, and the line being typed is opened and given a
          // double-width character at a frame whose inner width is one column.
          //
          // Kills: taking what `wrapped` gives back without asking whether it
          // fits, which draws `┌ 中 ┐` a column over on the top edge and the
          // same on the modeline.

          const driven = driving("中", ROWS, 5);
          driven.lens.showing({ a: 1 });
          expect(last(driven).map((row) => unicodeWidth(row)))
            .toEqual(Array(ROWS).fill(5));
          driven.lens.reads(key(":"));
          driven.lens.reads({ name: "中", char: "中" });
          expect(last(driven).map((row) => unicodeWidth(row)))
            .toEqual(Array(ROWS).fill(5));
        });

        it("counts no rows as none rather than as a backwards range", () => {
          // A screen with no room between the edges shows none of the value,
          // and a range counted from the first row to the one before it reads
          // as a span that runs backwards. What a reader is owed there is how
          // much they cannot see.
          //
          // Kills: composing the range from `top` and the row count without
          // asking whether any row was shown, which writes `1-0 of 3`.

          const driven = driving("cell @space", 2, COLUMNS);
          driven.lens.showing({ a: 1, b: 2, c: 3 });
          expect(last(driven)[1]).toContain("0 of ");
          expect(last(driven)[1]).not.toContain("1-0");
        });

        it("names the cell on the top edge", () => {
          expect(last(driving("first/label @space"))[0])
            .toBe("┌ first/label @space ──────────────────┐");
        });

        it("offers every key it takes on the bottom edge", () => {
          // The frame offers what it answers to, so this is the whole of the
          // key table read off the drawing rather than off the source. A key
          // added without its phrase, or a phrase left after the key it names
          // went, is a frame telling a reader something untrue about itself.

          expect(keys(last(driving("c", 4, 100)))).toBe(
            "└ q back · j/k scroll · g/G ends · / search · : command · " +
              "e edit · (q leaves the watch armed) ─────┘",
          );
        });

        it("drops whole phrases from the edge rather than cutting one", () => {
          // Half a phrase offers nothing, and the separator left hanging after
          // it promises a phrase that is not there — which reads as a frame
          // that failed to draw rather than as one too narrow to say more.
          //
          // Kills: fitting the joined phrases to the room, which ends this
          // edge in a dangling separator.

          const edge = keys(last(driving("c", 4, 60)));
          expect(edge).toBe(
            "└ q back · j/k scroll · g/G ends · / search · : command ───┘",
          );
          expect(edge).not.toContain("· ─");
        });

        it("says the cell has not settled before it has", () => {
          // The subscription fires with what the cell already holds, but not
          // before the frame is first drawn, so a frame with nothing in it is
          // a state a reader reaches and one the frame says out loud.

          expect(body(last(driving())))
            .toEqual(["<nothing has settled yet>", "", "", "", "", ""]);
        });

        it("returns the value as the rendering `get` writes", () => {
          const driven = driving();
          driven.lens.showing({ replies: 14 });
          expect(body(last(driven)).slice(0, 3))
            .toEqual(["{", '  "replies": 14', "}"]);
        });

        it("says which rows are on screen where the value does not fit", () => {
          const driven = driving("c", 4, 80);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          expect(keys(last(driven))).toBe(
            "└ q back · j/k scroll · g/G ends · / search · : command · " +
              "e edit ──── 1-2 of 8 ┘",
          );
        });

        it("cuts the keys rather than the count where both will not fit", () => {
          // The right of an edge carries what the frame is doing now and the
          // left a reminder of the keys, which is the half a reader can do
          // without.

          const driven = driving("c", 4, 40);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          expect(keys(last(driven)))
            .toBe("└ q back · j/k scroll ─────── 1-2 of 8 ┘");
        });

        it("says nothing about rows where the whole value is on screen", () => {
          const driven = driving("c", 8, 60);
          driven.lens.showing(1);
          expect(keys(last(driven))).toBe(
            "└ q back · j/k scroll · g/G ends · / search · : command ───┘",
          );
        });

        it("returns the two edges alone where nothing else fits", () => {
          // A terminal too short for a value is one a reader can still read
          // the title and the keys off.

          expect(driving("c", 2, 20).drawn[0]?.length).toBe(2);
        });

        it("breaks a line at the frame's inner width rather than the screen's", () => {
          // A line broken at the screen's width would run past the frame's
          // right edge by the four columns the edges take.

          const driven = driving("c", 8, 20);
          driven.lens.showing("x".repeat(30));
          expect(body(last(driven)).slice(0, 2))
            .toEqual([`"${"x".repeat(15)}`, `${"x".repeat(15)}"`]);
        });
      });

      describe("showing()", () => {
        it("draws once for one settled value", () => {
          // One call costs one repaint. That several intermediate values do
          // not reach here at all is the subscription's promise
          // (`sinkCellValue`, `lib/piece.ts`), and this is the half of it this
          // module owes.

          const driven = driving();
          driven.lens.showing(1);
          driven.lens.showing(2);
          // The first drawing is `drawnThrough`'s own.
          expect(driven.drawn.length).toBe(3);
        });

        it("keeps where the reader had scrolled to", () => {
          // A value that grew while a reader was partway down it leaves them
          // where they were reading rather than at the top.

          const driven = driving("c", 5, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("j"));
          driven.lens.showing(["a", "b", "c", "d", "e", "g"]);
          expect(body(last(driven))).toEqual(['  "a",', '  "b",', '  "c",']);
        });

        it("draws nothing once the lens is closed", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.showing(1);
          expect(driven.drawn.length).toBe(1);
        });
      });

      describe("reads()", () => {
        it("closes the lens on `q`", () => {
          const driven = driving();
          driven.lens.reads(key("q"));
          expect(driven.lens.open).toBe(false);
        });

        it("closes the lens on `ctrl-c`", () => {
          // A full screen a person cannot get out of by the key every terminal
          // program answers is worse than one key too many.

          const driven = driving();
          driven.lens.reads(key("ctrl-c"));
          expect(driven.lens.open).toBe(false);
        });

        it("cancels this lens's own subscription when it closes", () => {
          const driven = driving();
          driven.lens.reads(key("q"));
          expect(driven.cancels()).toBe(1);
        });

        it("scrolls one row down on `j` and back up on `k`", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("j"));
          const down = body(last(driven));
          driven.lens.reads(key("k"));
          expect({ down, up: body(last(driven)) })
            .toEqual({ down: ['  "a",', '  "b",'], up: ["[", '  "a",'] });
        });

        it("scrolls on the arrows as it does on `j` and `k`", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("down"));
          const down = body(last(driven));
          driven.lens.reads(key("up"));
          expect({ down, up: body(last(driven)) })
            .toEqual({ down: ['  "a",', '  "b",'], up: ["[", '  "a",'] });
        });

        it("goes to the two ends on `g` and `G`", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          driven.lens.reads(key("G"));
          const end = body(last(driven));
          driven.lens.reads(key("g"));
          expect({ end, start: body(last(driven)) })
            .toEqual({ end: ['  "f"', "]"], start: ["[", '  "a",'] });
        });

        it("stops at the last row rather than scrolling past it", () => {
          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          for (let press = 0; press < 20; press++) {
            driven.lens.reads(key("j"));
          }
          expect(body(last(driven))).toEqual(['  "f"', "]"]);
        });

        it("moves one row back from the last after scrolling past it", () => {
          // The clamp is recorded rather than merely applied, so a `k` after a
          // run of `j`s moves from where the reader is looking rather than
          // from where they had scrolled to.

          const driven = driving("c", 4, 60);
          driven.lens.showing(["a", "b", "c", "d", "e", "f"]);
          for (let press = 0; press < 20; press++) {
            driven.lens.reads(key("j"));
          }
          driven.lens.reads(key("k"));
          expect(body(last(driven))).toEqual(['  "e",', '  "f"']);
        });

        it("draws nothing for a key it does not take", () => {
          const driven = driving();
          driven.lens.reads(key("x"));
          expect(driven.drawn.length).toBe(1);
        });

        it("does nothing once the lens is closed", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.reads(key("j"));
          expect(driven.drawn.length).toBe(1);
        });

        it("opens a command line on `:`, offering the two keys that end it", () => {
          const driven = driving("c", ROWS, 60);
          driven.lens.reads(key(":"));
          // Read untrimmed, because the space after the mark is the form
          // `views.md` draws a command line in and the trim would hide it.
          expect(last(driven).at(-2)?.slice(2, 4)).toBe(": ");
          expect(keys(last(driven)))
            .toBe(
              "└ enter run · ctrl-c/esc cancel ───────────────────────────┘",
            );
        });

        it("takes the command line's row from the value while it is open", () => {
          // The modeline is not drawn empty, so what it costs is a row of the
          // value and it costs it only while there is something in it. A frame
          // that reserved the row would be one row short for the whole of a
          // session that never typed at it.
          //
          // Read as the rows of the value rather than as a count of the rows
          // between the edges, because that count is the same either way: the
          // modeline stands in one of them, so a frame that took the row from
          // the wrong place would still have `ROWS - 2` of them.
          //
          // Kills: drawing the modeline into the rows the edges already left,
          // which returns a frame a row taller than the terminal; and taking
          // the row from neither, which leaves the last row of the value on
          // screen under a modeline the frame grew for.

          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(long());
          const whole = body(last(driven));
          expect(whole.length).toBe(ROWS - 2);
          expect(whole).toEqual([
            "[",
            '  "alpha",',
            '  "beta",',
            '  "gamma",',
            '  "filler",',
            '  "filler",',
          ]);
          driven.lens.reads(key(":"));
          expect(last(driven).length).toBe(ROWS);
          expect(body(last(driven))).toEqual([...whole.slice(0, -1), ":"]);
        });

        it("draws what is typed at the command line", () => {
          const driven = driving();
          driven.lens.reads(key(":"));
          types(driven.lens, "get depth");
          expect(modeline(last(driven))).toBe(": get depth");
        });

        it("binds the line editor's table on the command line", () => {
          // The same table the prompt binds, which is what makes the line one
          // a person types the way they type every other line here.
          //
          // Kills: a second table beside the prompt's, which would have to
          // grow a binding each time that one does.

          const driven = driving();
          driven.lens.reads(key(":"));
          types(driven.lens, "depth");
          driven.lens.reads({ name: "ctrl-a", ctrl: true });
          types(driven.lens, "get ");
          expect(modeline(last(driven))).toBe(": get depth");
        });

        it("asks for the line the command line took on `enter`", () => {
          const driven = driving();
          driven.lens.reads(key(":"));
          types(driven.lens, "get depth");
          driven.lens.reads(key("enter"));
          expect(driven.lens.asked()).toBe("get depth");
        });

        it("asks for nothing where the command line was left empty", () => {
          // `enter` at an empty prompt runs nothing, and this is that line in
          // the one place it is typed on a frame.

          const driven = driving();
          driven.lens.reads(key(":"));
          driven.lens.reads(key("enter"));
          expect(driven.lens.asked()).toBeUndefined();
          expect(driven.lens.typing).toBe(false);
        });

        it("abandons the command line on `ctrl-c` and keeps the frame", () => {
          // `ctrl-c` means what the prompt means by it: what is being typed
          // where something is, and the way out where nothing is. A frame that
          // closed here would take the view away from somebody who meant to
          // take back a line.
          //
          // Kills: reading `ctrl-c` as the way out before asking whether a
          // line is open, which closes the lens on the first of the two.

          const driven = driving();
          driven.lens.reads(key(":"));
          types(driven.lens, "get depth");
          driven.lens.reads(key("ctrl-c"));
          expect(driven.lens.open).toBe(true);
          expect(driven.lens.typing).toBe(false);
          expect(driven.lens.asked()).toBeUndefined();
        });

        it("abandons the command line on `escape` as it does on `ctrl-c`", () => {
          // And the edge says so: what the frame offers is what it answers to,
          // so a second key that cancels is a second key the edge names.
          //
          // Kills: taking `escape` in the key table and leaving the edge
          // offering `ctrl-c` alone, which is a frame answering to a key it
          // does not mention.

          const driven = driving("c", ROWS, 60);
          driven.lens.reads(key(":"));
          types(driven.lens, "get depth");
          expect(keys(last(driven))).toContain("ctrl-c/esc cancel");
          driven.lens.reads(key("escape"));
          expect(driven.lens.typing).toBe(false);
          expect(driven.lens.asked()).toBeUndefined();
        });

        it("takes no key as a view key while a command line is open", () => {
          // Every key goes to the line while one is open, `q` among them: a
          // person typing a line is typing text, and a view that read a
          // character of it as a motion would scroll under what they typed.

          const driven = driving();
          driven.lens.showing(long());
          driven.lens.reads(key(":"));
          types(driven.lens, "q");
          expect(driven.lens.open).toBe(true);
          expect(modeline(last(driven))).toBe(": q");
        });

        it("asks for `edit` on the cell it is a lens onto on `e`", () => {
          // The editor trip, the refusals and the write are the `edit` verb's,
          // reached through the same mechanism `:` reaches a typed line
          // through. A second copy of any of them here would be a second
          // answer to a question the verb already answers.

          const driven = driving();
          driven.lens.reads(key("e"));
          expect(driven.lens.asked()).toBe(`edit ${REFERENCE}`);
        });

        it("asks for nothing while a line it asked for is in flight", () => {
          // One line at a time, which is the loop's own discipline: a second
          // would be a second cancel to hold and a second answer to place in
          // one modeline.

          const driven = driving();
          driven.lens.reads(key("e"));
          expect(driven.lens.asked()).toBe(`edit ${REFERENCE}`);
          driven.lens.reads(key("e"));
          expect(driven.lens.asked()).toBeUndefined();
          driven.lens.reads(key(":"));
          expect(driven.lens.typing).toBe(false);
        });

        it("offers the key that stops the line while one is in flight", () => {
          const driven = driving("c", ROWS, 60);
          driven.lens.reads(key("e"));
          expect(keys(last(driven))).toContain("ctrl-c stop");
          expect(keys(last(driven))).not.toContain(": command");
          expect(modeline(last(driven))).toBe(`: edit ${REFERENCE}`);
        });

        it("moves the view to the first line holding what `/` took", () => {
          // Kills: taking the match as a row of the screen rather than a line
          // of the rendering, which lands somewhere else on every width.

          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(long());
          driven.lens.reads(key("/"));
          types(driven.lens, "gamma");
          driven.lens.reads(key("enter"));
          expect(body(last(driven))[0]).toBe('  "gamma",');
          expect(modeline(last(driven))).toBe("/ gamma  1 of 1");
        });

        it("says how many matches there are and which one it is on", () => {
          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(long());
          driven.lens.reads(key("/"));
          types(driven.lens, "filler");
          driven.lens.reads(key("enter"));
          expect(modeline(last(driven))).toBe("/ filler  1 of 17");
          driven.lens.reads(key("n"));
          expect(modeline(last(driven))).toBe("/ filler  2 of 17");
          driven.lens.reads(key("N"));
          expect(modeline(last(driven))).toBe("/ filler  1 of 17");
        });

        it("wraps from the last match back to the first on `n`", () => {
          // A search that stopped at the last match leaves a reader at the
          // bottom of a value with no way back to the first but a retype.

          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(["one", "two"]);
          driven.lens.reads(key("/"));
          types(driven.lens, "o");
          driven.lens.reads(key("enter"));
          expect(modeline(last(driven))).toBe("/ o  1 of 2");
          driven.lens.reads(key("n"));
          expect(modeline(last(driven))).toBe("/ o  2 of 2");
          driven.lens.reads(key("n"));
          expect(modeline(last(driven))).toBe("/ o  1 of 2");
        });

        it("says so where a search found nothing", () => {
          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(long());
          driven.lens.reads(key("/"));
          types(driven.lens, "nowhere");
          driven.lens.reads(key("enter"));
          expect(modeline(last(driven))).toBe("/ nowhere  no match");
        });

        it("offers `n` and `N` only once a pattern is set", () => {
          const driven = driving("c", ROWS, 100);
          expect(keys(last(driven))).not.toContain("n/N next");
          driven.lens.showing(long());
          driven.lens.reads(key("/"));
          types(driven.lens, "gamma");
          driven.lens.reads(key("enter"));
          expect(keys(last(driven))).toContain("n/N next");
        });

        it("puts a search away on an empty one", () => {
          // The value is short enough that the rows the modeline would take
          // are blank, so a modeline that stayed would be the one row of the
          // frame with anything on it.

          const driven = driving("c", ROWS, 100);
          driven.lens.showing(["one", "two"]);
          driven.lens.reads(key("/"));
          types(driven.lens, "one");
          driven.lens.reads(key("enter"));
          expect(modeline(last(driven))).toBe("/ one  1 of 1");
          driven.lens.reads(key("/"));
          driven.lens.reads(key("enter"));
          expect(keys(last(driven))).not.toContain("n/N next");
          expect(modeline(last(driven))).toBe("");
        });

        it("draws nothing for `n` with no pattern set", () => {
          const driven = driving();
          driven.lens.reads(key("n"));
          driven.lens.reads(key("N"));
          expect(driven.drawn.length).toBe(1);
        });

        it("counts a search against what the cell holds now", () => {
          // A value that changed under a search is the one case where a total
          // remembered from when the search was made would be a lie on screen.
          //
          // Kills: holding the match count beside the pattern, which goes on
          // saying `1 of 17` after sixteen of them went.

          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(long());
          driven.lens.reads(key("/"));
          types(driven.lens, "filler");
          driven.lens.reads(key("enter"));
          expect(modeline(last(driven))).toBe("/ filler  1 of 17");
          driven.lens.showing(["filler", "filler"]);
          expect(modeline(last(driven))).toBe("/ filler  2 matches");
        });

        it("searches while a line it asked for is in flight", () => {
          // A search costs a traversal of what is already on screen, so there
          // is nothing for it to wait on: what one line at a time bounds is
          // the work the loop runs, not the work this module does.

          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.showing(long());
          driven.lens.reads(key("e"));
          driven.lens.reads(key("/"));
          types(driven.lens, "gamma");
          driven.lens.reads(key("enter"));
          expect(body(last(driven))[0]).toBe('  "gamma",');
        });
      });

      describe("asked()", () => {
        it("hands the line over once", () => {
          // The caller that takes it is the one that runs it, so a second
          // caller finds nothing to run twice.

          const driven = driving();
          driven.lens.reads(key("e"));
          expect(driven.lens.asked()).toBe(`edit ${REFERENCE}`);
          expect(driven.lens.asked()).toBeUndefined();
        });
      });

      describe("answered()", () => {
        it("says what came back and offers the keys that start a line again", () => {
          const driven = driving("c", ROWS, 60);
          driven.lens.reads(key("e"));
          driven.lens.answered("Wrote `depth`.");
          expect(modeline(last(driven))).toBe("Wrote `depth`.");
          expect(keys(last(driven))).toContain(": command");
          expect(keys(last(driven))).not.toContain("ctrl-c stop");
        });

        it("says the first line of what came back and no more of it", () => {
          // The whole of it reaches the transcript, which the frame is holding
          // back: what the modeline owes a reader is the acknowledgement, and
          // a frame that grew with a listing would be a page rather than a
          // view.

          const driven = driving();
          driven.lens.reads(key("e"));
          driven.lens.answered("first\nsecond\nthird");
          expect(modeline(last(driven))).toBe("first");
        });

        it("lets the next line be asked for", () => {
          const driven = driving();
          driven.lens.reads(key("e"));
          driven.lens.asked();
          driven.lens.answered("");
          driven.lens.reads(key("e"));
          expect(driven.lens.asked()).toBe(`edit ${REFERENCE}`);
        });

        it("draws nothing once the lens is closed", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.answered("something");
          expect(driven.drawn.length).toBe(1);
        });
      });

      describe("cursor()", () => {
        it("is nothing where nothing is being typed at the frame", () => {
          // A frame with no line open is read rather than typed at, and a
          // cursor on one sits wherever the last row's drawing ended and reads
          // as a place a person could type.

          expect(driving().cursors[0]).toBeUndefined();
        });

        it("stands on the command line, after what is typed", () => {
          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.reads(key(":"));
          types(driven.lens, "get");
          // The row above the bottom edge, and eight columns in: past the
          // frame's left edge, the space after it, and `: get`.
          expect(driven.cursors[driven.cursors.length - 1])
            .toEqual({ row: ROWS - 1, column: 8 });
        });

        it("follows the cursor within the line rather than its end", () => {
          const driven = driving("c", ROWS, COLUMNS);
          driven.lens.reads(key(":"));
          types(driven.lens, "get");
          driven.lens.reads({ name: "ctrl-a", ctrl: true });
          // `ctrl-a` moves to the start of what was typed, which is after the
          // mark: the mark is the frame's and not part of the line.
          expect(driven.cursors[driven.cursors.length - 1])
            .toEqual({ row: ROWS - 1, column: 5 });
        });

        it("scrolls a line longer than the row under the cursor", () => {
          // Every other text on a frame is cut at the right edge, and cutting
          // is wrong here for one reason: a cut line is still readable, and a
          // line being typed past the cut is one a person is typing where they
          // cannot see.
          //
          // Kills: fitting the typed line as a title is fitted, which leaves
          // the cursor off the row and the characters last typed invisible.

          const driven = driving("c", ROWS, 20);
          driven.lens.reads(key(":"));
          types(driven.lens, "set settings/depth 3");
          const row = modeline(last(driven));
          expect(row.endsWith("depth 3")).toBe(true);
          expect(unicodeWidth(row)).toBeLessThanOrEqual(16);
          expect(driven.cursors[driven.cursors.length - 1]?.column)
            .toBe(3 + unicodeWidth(row));
        });

        it("shows a line that exactly fills the row whole", () => {
          // A line as wide as the row is a line that fits: the cursor after
          // its last character stands in the column the padding holds, which
          // is inside the frame and beside its right edge rather than on it.
          //
          // Kills: scrolling a line that fits, which drops its first character
          // to make room for a column the row already has.

          const driven = driving("c", ROWS, 20);
          types(driven.lens, ":");
          types(driven.lens, "set depth 4321");
          const row = modeline(last(driven));
          expect(unicodeWidth(row)).toBe(16);
          expect(row).toBe(": set depth 4321");
          expect(driven.cursors[driven.cursors.length - 1])
            .toEqual({ row: ROWS - 1, column: 19 });
        });

        it("is nothing on a terminal with no room for a command line", () => {
          const driven = driving("c", 2, COLUMNS);
          driven.lens.reads(key(":"));
          expect(driven.cursors[driven.cursors.length - 1]).toBeUndefined();
          expect(last(driven).length).toBe(2);
        });
      });

      describe("typing", () => {
        it("is whether a line is being typed at the frame", () => {
          const driven = driving();
          expect(driven.lens.typing).toBe(false);
          driven.lens.reads(key(":"));
          expect(driven.lens.typing).toBe(true);
          driven.lens.reads(key("enter"));
          expect(driven.lens.typing).toBe(false);
        });
      });

      describe("holding()", () => {
        it("cancels at once where the lens closed while it was subscribing", () => {
          const lens = new ValueLens("c", REFERENCE);
          let cancelled = 0;
          lens.close();
          lens.holding(() => cancelled++);
          expect(cancelled).toBe(1);
        });
      });

      describe("close()", () => {
        it("cancels once however many times it is called", () => {
          const driven = driving();
          driven.lens.close();
          driven.lens.close();
          expect(driven.cancels()).toBe(1);
        });
      });

      describe("label", () => {
        it("returns the cell the lens was opened onto", () => {
          expect(driving("first/label @space").lens.label)
            .toBe("first/label @space");
        });
      });
    });
  });
});
