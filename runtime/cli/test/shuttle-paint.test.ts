/**
 * Unit tests for what a terminal is sent to show the line being typed, to end
 * it, to put a line above it, and to take the screen for a frame.
 *
 * The expectations are the escape sequences themselves, written out. That is
 * the whole point of the module being separate from the writing: what a
 * terminal does with them is untestable here, and what is sent to it is
 * exactly a string.
 *
 * A narrow width stands in for a real terminal throughout, so a case about
 * wrapping fits on a line of its own.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  above,
  finish,
  givingScreen,
  NOTHING_PAINTED,
  type PaintedLine,
  repaint,
  screenOf,
  takingScreen,
} from "../lib/shuttle/paint.ts";
import { glyphFor } from "../lib/view/display.ts";

/** The width every case below draws at, unless it says otherwise. */
const WIDTH = 10;

/** Helper for the cases below, which is a line drawn `columns` wide. */
function line(text: string, column: number, columns = WIDTH): PaintedLine {
  return { text, column, columns };
}

describe("paint", () => {
  describe("repaint()", () => {
    it("returns the line, between a saved cursor and the restore of it", () => {
      expect(repaint(NOTHING_PAINTED, line("abc", 3)))
        .toBe("\r\x1b7\x1b[0Jabc\x1b8\x1b[3C");
    });

    it("clears to the end of the screen rather than to the end of the row", () => {
      expect(repaint(NOTHING_PAINTED, line("a", 1))).toContain("\x1b[0J");
    });

    it("moves the cursor up to the row the last drawing started on", () => {
      expect(repaint(line("a".repeat(25), 25), line("b", 1)))
        .toBe("\x1b[2A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
    });

    it("moves the cursor down to the row of the column it is drawn at", () => {
      expect(repaint(NOTHING_PAINTED, line("a".repeat(25), 23)))
        .toBe(`\r\x1b7\x1b[0J${"a".repeat(25)}\x1b8\x1b[2B\x1b[3C`);
    });

    it("moves the cursor nowhere for a line drawn with the cursor at its start", () => {
      expect(repaint(NOTHING_PAINTED, line("abc", 0)))
        .toBe("\r\x1b7\x1b[0Jabc\x1b8");
    });

    it("counts back over the old line at the width it was drawn at", () => {
      // A window resized between two drawings leaves the old line occupying
      // the rows the old width gave it, so counting back over it at the new
      // width lands on some other row. Twenty-five columns wrapped to three
      // rows at ten and to two at twenty, and it is the three that have to be
      // climbed.

      expect(repaint(line("a".repeat(25), 25), line("b", 1, 20)))
        .toBe("\x1b[2A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
    });

    it("counts down over the new line at the width it is drawn at", () => {
      expect(repaint(NOTHING_PAINTED, line("a".repeat(25), 25, 20)))
        .toBe(`\r\x1b7\x1b[0J${"a".repeat(25)}\x1b8\x1b[1B\x1b[5C`);
    });

    describe("a double-width character", () => {
      // The cursor arrives as an index into the line and leaves as a place on
      // the screen, and a character a terminal draws double-wide is one of the
      // first and two of the second. Every fixture here is written where
      // counting the index and counting the columns give different answers.

      it("moves the cursor across the columns the characters are drawn in", () => {
        // Two wide characters are two code points and four columns.

        expect(repaint(NOTHING_PAINTED, line("界界", 2)))
          .toBe("\r\x1b7\x1b[0J界界\x1b8\x1b[4C");
      });

      it("moves the cursor onto the row a character orphaned by one column starts", () => {
        // Three wide characters are six columns, which a width of five divides
        // into one row and one column across it. The terminal puts the cursor
        // a column further along: two characters fill four columns, the third
        // wants two and one is left, so it starts the row below and leaves
        // that column blank.

        expect(repaint(NOTHING_PAINTED, line("界界界", 3, 5)))
          .toBe("\r\x1b7\x1b[0J界界界\x1b8\x1b[1B\x1b[2C");
      });

      it("counts a blank column per row that a wrap left one on", () => {
        // The case above at a width the columns divide evenly, which is where
        // a measure that divides looks right and so is where the fixture has
        // to be. Five wide characters are ten columns, and a width of five
        // divides them into two rows and no columns across. The terminal
        // agrees on the row and not on the column: each row fits two
        // characters and leaves its fifth column blank, so the cursor sits two
        // columns into the third row rather than at its start.

        expect(repaint(NOTHING_PAINTED, line("界界界界界", 5, 5)))
          .toBe("\r\x1b7\x1b[0J界界界界界\x1b8\x1b[2B\x1b[2C");
      });

      it("climbs back over the rows the old line's columns filled", () => {
        expect(repaint(line("界界界", 3, 5), line("b", 1)))
          .toBe("\x1b[1A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
      });

      it("counts a character outside the basic plane as one code point of the index", () => {
        // The index the cursor arrives as counts code points, and one outside
        // the basic plane is stored as two of the units a string is held in.
        // A cursor two code points along here has passed a character drawn in
        // two columns and one drawn in one.

        expect(repaint(NOTHING_PAINTED, line("\u{1F9F5}a", 2)))
          .toBe("\r\x1b7\x1b[0J\u{1F9F5}a\x1b8\x1b[3C");
      });

      it("moves the cursor onto the next row where the characters fill one exactly", () => {
        // The other side of that boundary, and what stops the measure
        // over-charging: two wide characters fill a width of four with nothing
        // orphaned, which is the one row a division gives too. A row filled
        // exactly leaves the cursor at the start of the next one and nowhere
        // across it.

        expect(repaint(NOTHING_PAINTED, line("界界", 2, 4)))
          .toBe("\r\x1b7\x1b[0J界界\x1b8\x1b[1B");
      });
    });
  });

  describe("finish()", () => {
    it("returns the line ending alone, whatever the line said", () => {
      expect(finish(line("abc", 3))).toBe("\r\n");
    });

    it("moves down to the last row of a wrapped line before ending it", () => {
      expect(finish(line("a".repeat(25), 3))).toBe("\x1b[2B\r\n");
    });

    it("moves up where the cursor sits past the last row a wrap filled", () => {
      // A line whose length is a whole number of rows leaves its cursor, at
      // the end, on a row holding none of it. Ending there would leave that
      // row blank above whatever is written next.

      expect(finish(line("a".repeat(20), 20))).toBe("\x1b[1A\r\n");
    });

    it("ends a wrapped line at the width it was drawn at", () => {
      expect(finish(line("a".repeat(25), 3, 20))).toBe("\x1b[1B\r\n");
    });

    describe("a double-width character", () => {
      // Ending a line means reaching the last row it occupies, and that row is
      // the terminal's own layout of it: neither a count of the characters nor
      // a division of the columns they take lands on it.

      it("moves down to the last row the drawn columns reach", () => {
        // Four wide characters are eight columns. At a width of three each one
        // starts a row of its own, since two columns do not fit in the one a
        // character before it leaves, so the line is four rows. Counting the
        // characters says two rows and dividing the columns says three.

        expect(finish(line("界界界界", 0, 3))).toBe("\x1b[3B\r\n");
      });

      it("charges no extra row where the characters divide the width evenly", () => {
        // Two wide characters fill a width of four with nothing orphaned, so
        // the line is the one row it stands on and the ending goes where it is.

        expect(finish(line("界界", 0, 4))).toBe("\r\n");
      });
    });
  });

  describe("above()", () => {
    it("clears the drawn line, writes the text, and draws the line again", () => {
      expect(above(line("abc", 3), "gone"))
        .toBe("\r\x1b[0Jgone\r\n\r\x1b7\x1b[0Jabc\x1b8\x1b[3C");
    });

    it("climbs to the row the drawn line started on before it clears", () => {
      // The text goes above the whole of the drawn line, so a line that
      // wrapped is climbed to its first row: written from where the cursor
      // sits, the text would land in the middle of it.

      expect(above(line("a".repeat(25), 25), "gone"))
        .toContain("\x1b[2A\r\x1b[0Jgone");
    });

    it("writes each break in the text with the return raw mode needs", () => {
      expect(above(NOTHING_PAINTED, "one\ntwo"))
        .toBe("\r\x1b[0Jone\r\ntwo\r\n\r\x1b7\x1b[0J\x1b8");
    });

    it("shows every character a terminal acts on as the glyph naming it", () => {
      // The contract names a class and exempts one character of it, which is
      // a claim about all sixty-five: C0, `DEL`, and C1. So the case drives
      // all sixty-five rather than the handful a person thinks of — a raw tab
      // let through would break the contract and fail no sampled case, and a
      // tab is the one of these a value plausibly holds.
      //
      // Two assertions per character and the first is the load-bearing one.
      // That the raw character is gone is the property a terminal cares about
      // and it names no glyph, so it holds whatever `glyphFor` draws; that
      // the glyph is there is what makes the character still readable, and it
      // asks `glyphFor` for the answer rather than restating it, the glyph
      // being that function's to decide (`view-display.test.ts` pins which).

      const acted = [
        ...Array.from({ length: 0x20 }, (_, code) => code),
        0x7f,
        ...Array.from({ length: 0x20 }, (_, code) => 0x80 + code),
      ];
      expect(acted.length).toBe(65);

      for (const code of acted) {
        const character = String.fromCodePoint(code);
        const sent = above(NOTHING_PAINTED, `a${character}b`);
        if (character === "\n") continue;
        expect({ code, raw: sent.includes(`a${character}b`) })
          .toEqual({ code, raw: false });
        expect({ code, shown: sent.includes(`a${glyphFor(character)}b`) })
          .toEqual({ code, shown: true });
      }
    });

    it("passes the line feed, which is the one of that class that is layout", () => {
      // The exemption the case above steps over, asserted where it can be
      // read: a break in the text arrived as a row from whoever composed the
      // line, and it is sent as the row it is rather than as a picture of a
      // character.

      const sent = above(NOTHING_PAINTED, "a\nb");
      expect(sent).toContain("a\r\nb");
      expect(sent).not.toContain(glyphFor("\n"));
    });

    it("leaves a text holding nothing of that class alone", () => {
      expect(above(NOTHING_PAINTED, "a b")).toContain("\r\x1b[0Ja b\r\n");
    });

    it("climbs the rows a line's drawn columns filled before it clears", () => {
      // The climb is by the same measure the drawing came down by, so a line
      // holding characters a terminal draws double-wide is climbed by the rows
      // those columns filled rather than by the code points behind them.

      expect(above(line("界界界", 3, 5), "gone"))
        .toBe(
          "\x1b[1A\r\x1b[0Jgone\r\n\r\x1b7\x1b[0J界界界\x1b8\x1b[1B\x1b[2C",
        );
    });

    it("draws the line again at the width it was drawn at", () => {
      expect(above(line("a".repeat(25), 25, 20), "gone"))
        .toBe(
          `\x1b[1A\r\x1b[0Jgone\r\n\r\x1b7\x1b[0J${
            "a".repeat(25)
          }\x1b8\x1b[1B\x1b[5C`,
        );
    });
  });
  describe("takingScreen()", () => {
    it("enters the alternate screen, which is what keeps the transcript whole", () => {
      // A frame drawn on the screen the transcript is on would scroll it, and
      // what scrolls off is what history is.

      expect(takingScreen()).toBe("\x1b[?1049h\x1b[?25l");
    });
  });

  describe("screenOf()", () => {
    it("positions and clears each row before writing it", () => {
      // A redraw replaces what is there rather than blanking the screen and
      // drawing again, which is what a reader sees as a flicker.

      expect(screenOf(["a", "b"])).toBe(
        "\x1b[?7l" +
          "\x1b[1;1H\x1b[2Ka" +
          "\x1b[2;1H\x1b[2Kb" +
          "\x1b[?7h",
      );
    });

    it("writes a row a terminal would act on as the picture of itself", () => {
      // A frame row is composed from what a cell holds, which is data a user
      // program authored and no door of shuttle's has held. Written through,
      // an escape sequence in one reaches the terminal as an instruction: it
      // can clear the screen, move the cursor off the row it was given, or
      // draw a frame of its own over this one. The line written above the
      // prompt passes the same class through `escapeControlCharacters`
      // (`above`), and a frame is the same terminal.
      //
      // Kills: concatenating rows verbatim, which sends `\x1b[2J` on as a
      // clear-screen rather than as the glyph naming the escape.

      const drawn = screenOf(["\x1b[2Jgone"]);
      expect(drawn).not.toContain("\x1b[2J");
      expect(drawn).toContain("\u241b[2Jgone");
    });

    it("leaves a row already held to that class alone", () => {
      // The escape is idempotent, a glyph being no longer a character a
      // terminal acts on, so a row composed through a renderer that already
      // held it reaches the screen unchanged rather than doubly escaped.
      //
      // Kills: an escape that rewrites its own output.

      expect(screenOf(["plain \u241b[2J text"]))
        .toContain("plain \u241b[2J text");
    });

    it("turns line wrapping off around the drawing", () => {
      // A row filling the last column carries the cursor onto the next line,
      // and on the last row of the screen that scrolls the frame up by one.

      const drawn = screenOf(["a"]);
      expect(drawn.startsWith("\x1b[?7l")).toBe(true);
      expect(drawn.endsWith("\x1b[?7h")).toBe(true);
    });

    it("sends nothing but the wrapping for a frame with no rows", () => {
      expect(screenOf([])).toBe("\x1b[?7l\x1b[?7h");
    });
  });

  describe("givingScreen()", () => {
    it("leaves the alternate screen and shows the cursor again", () => {
      expect(givingScreen()).toBe("\x1b[?25h\x1b[?1049l");
    });
  });
});
