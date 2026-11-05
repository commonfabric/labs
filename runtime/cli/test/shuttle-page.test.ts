/**
 * Unit tests for how much of a rendering one page shows and what it says about
 * the rest.
 *
 * Nothing here reads a terminal: the screen arrives as two numbers, so every
 * size a case wants is one it states, including the sizes a real terminal
 * rarely has. What the arithmetic is for is that a line's output leaves the
 * prompt on the screen, so the cases that matter most are the ones at the
 * boundary — a rendering exactly as tall as the page, and one row taller.
 *
 * Rows and lines are the distinction the file exists to hold. A page is
 * bounded in rows and handed lines, and a line wider than the terminal is more
 * than one row: every case that would pass either way is written at a width
 * that makes the two disagree.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  ASSUMED_COLUMNS,
  ASSUMED_ROWS,
  heightFit,
  marker,
  pageOf,
  statusLine,
  wrapped,
} from "../lib/shuttle/page.ts";

/** Helper for the cases below, which is `count` lines called `1`, `2`, … */
function lines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${index + 1}`);
}

/**
 * Helper for the cases below, which is the real status line under the
 * signature a page calls one by — the shape `paged` (`verbs.ts`) hands over,
 * so a case reading its words reads the words a verb writes.
 */
const written = (left: number, overran: boolean) =>
  statusLine(left, undefined, overran);

/**
 * Helper for the cases below, which is a status line one row wide at the
 * narrow widths the wrapping cases state, so that what those cases turn on is
 * the entry's own row count and not the status line's.
 */
function terse(left: number): string {
  return `#${left}`;
}

/** Helper for the cases below, which is the status line a case can spot. */
function status(left: number): string {
  return `[${left} left]`;
}

/**
 * Helper for the cases below, which is a status line two rows wide at the
 * width the cases using it state.
 */
function wideStatus(left: number): string {
  return `${"s".repeat(25)}${left}`;
}

describe("page", () => {
  describe("marker()", () => {
    it("returns the text between angle brackets", () => {
      expect(marker("412 items")).toBe("<412 items>");
    });

    it("returns a payload's own brackets as they stand", () => {
      expect(marker("<gone>")).toBe("<<gone>>");
    });
  });

  describe("statusLine()", () => {
    it("returns how many lines were held back, and the verb that writes them", () => {
      expect(statusLine(389)).toBe("<389 lines not shown — more continues>");
    });

    it("returns the singular for one line held back", () => {
      expect(statusLine(1)).toBe("<1 line not shown — more continues>");
    });

    it("returns the hint after the verb, where the caller has one", () => {
      expect(statusLine(3, "--select narrows the read")).toBe(
        "<3 lines not shown — more continues, or --select narrows the read>",
      );
    });
  });

  describe("heightFit()", () => {
    it("returns a page one row short of the terminal, leaving the prompt its own", () => {
      expect(heightFit(24, 80).rows).toBe(23);
    });

    it("returns the width it was given, which is what turns a line into rows", () => {
      expect(heightFit(24, 80).columns).toBe(80);
    });

    it("returns no entry bound, the screen counting rows rather than entries", () => {
      expect(heightFit(24, 80).entries).toBeUndefined();
    });
  });

  describe("pageOf()", () => {
    it("returns every line and nothing left over where they all fit", () => {
      expect(pageOf([], lines(3), { rows: 5, columns: 80 }, status))
        .toEqual({ text: "1\n2\n3", rest: [] });
    });

    it("returns every line and nothing left over where they exactly fill the page", () => {
      // The boundary from below. A page that cut here would write a status
      // line saying nothing was left, and cost a row to say it.

      expect(pageOf([], lines(5), { rows: 5, columns: 80 }, status))
        .toEqual({ text: "1\n2\n3\n4\n5", rest: [] });
    });

    it("returns the cut page and the rest where one row more than fits was given", () => {
      // The boundary from above: six entries into a five-row page writes four
      // of them and spends the fifth row saying two are left.

      expect(pageOf([], lines(6), { rows: 5, columns: 80 }, status)).toEqual({
        text: "1\n2\n3\n4\n[2 left]",
        rest: ["5", "6"],
      });
    });

    it("returns a status line counting the lines it held back, not the lines it wrote", () => {
      expect(pageOf([], lines(100), { rows: 5, columns: 80 }, status).text)
        .toContain("[96 left]");
    });

    it("returns the rest in the order they were composed, continuing where the page stopped", () => {
      expect(pageOf([], lines(6), { rows: 3, columns: 80 }, status).rest)
        .toEqual(["3", "4", "5", "6"]);
    });

    it("returns one entry however small the bound, so a continuation always advances", () => {
      // A page that showed nothing would hand back everything it was given,
      // and `more` over it could be asked forever. The clamp is what makes
      // the rest strictly shorter than what came in.

      const page = pageOf([], lines(4), { rows: 1, columns: 80 }, status);
      expect(page.text).toBe("1\n[3 left]");
      expect(page.rest.length).toBeLessThan(4);
    });

    describe("an entry taller than the whole page", () => {
      // What the clamp above may not buy: silence. Something has to be shown
      // or `more` could be asked forever, so an oversized entry is shown
      // oversized — and the page says so, which is the property this slice
      // exists for. The fixtures straddle the budget by one row each way.

      it("is shown, and the page says it ran over", () => {
        // Three rows of entry into a two-row page: one over.
        const tall = "t".repeat(25);
        const page = pageOf([], [tall], { rows: 2, columns: 10 }, written);
        expect(page.text.split("\n").at(-1))
          .toBe("<what is above fills more than the screen>");
        expect(page.rest).toEqual([]);
      });

      it("says nothing of the sort where it fits by a row", () => {
        // The other side of the same boundary: two rows of entry into a
        // two-row page needs no status line at all.
        const fits = "f".repeat(20);
        expect(pageOf([], [fits], { rows: 2, columns: 10 }, written))
          .toEqual({ text: fits, rest: [] });
      });

      it("says both where it ran over and left something behind", () => {
        const tall = "t".repeat(25);
        expect(
          pageOf([], [tall, "a"], { rows: 2, columns: 10 }, written)
            .text.split("\n").at(-1),
        )
          .toBe(
            "<what is above fills more than the screen; 1 line not shown — " +
              "more continues>",
          );
      });
    });

    describe("a double-width character", () => {
      // A page measured in characters undercounts these, which is the
      // direction that overflows: the terminal wraps where the page thought
      // there was room. Each fixture is one row either side of the budget.

      it("costs the columns the terminal gives it", () => {
        // Six wide characters is twelve columns, so two rows at a width of
        // ten — and two of those is four rows, one over a three-row page.
        const wide = "界".repeat(6);
        const page = pageOf([], [wide, wide], { rows: 3, columns: 10 }, status);
        expect(page.rest).toEqual([wide]);
      });

      it("leaves a page that fits alone", () => {
        // Five wide characters is ten columns and exactly one row.
        const wide = "界".repeat(5);
        expect(pageOf([], [wide, wide], { rows: 3, columns: 10 }, status))
          .toEqual({ text: `${wide}\n${wide}`, rest: [] });
      });

      it("costs the row a character orphaned by one column moves onto", () => {
        // The pair the count and the wrapping disagreed about, and the reason
        // they must be one traversal. Five wide characters is ten columns and
        // a width of five divides it evenly, so dividing says two rows. The
        // terminal needs three: two characters fill four columns, the third
        // wants two and one is left, so it moves down and leaves that column
        // blank. Dividing undercounts exactly there — and the fixture sits at
        // a width that divides evenly on purpose, since the orphaning is
        // about the character boundary rather than about the width.
        //
        // At a three-row page the difference decides the outcome: counted by
        // the traversal the entry and its neighbour do not both fit, and
        // counted by the division they do.

        const orphaning = "界".repeat(5);
        expect(pageOf([], [orphaning, "a"], { rows: 3, columns: 5 }, terse))
          .toEqual({ text: `${orphaning}\n#1`, rest: ["a"] });
      });

      it("charges no extra row where the characters divide the width evenly", () => {
        // The other side of that boundary, and what stops the fix from
        // over-charging: four wide characters into four columns is two rows
        // by either reading, so the page has room for the entry beside it and
        // holds nothing back.

        const dividing = "界".repeat(4);
        expect(pageOf([], [dividing, "a"], { rows: 3, columns: 4 }, terse))
          .toEqual({ text: `${dividing}\na`, rest: [] });
      });
    });

    describe("a line wider than the terminal", () => {
      // The distinction the bound is for. A page bounded in rows and handed
      // lines has to convert, and every case here is written where counting
      // lines and counting rows give different answers.

      it("costs the rows it wraps onto", () => {
        // Twenty-five columns of content at a width of ten is three rows, so
        // one entry and a status line already fill a four-row page. Counting
        // lines would have fitted all three entries into it.

        const wide = "w".repeat(25);
        expect(pageOf([], [wide, "a", "b"], { rows: 4, columns: 10 }, status))
          .toEqual({ text: `${wide}\n[2 left]`, rest: ["a", "b"] });
      });

      it("is one entry, not several, against a limit that counts entries", () => {
        // The other unit in play: `--limit 2` asks for two rows of a listing
        // whatever each of them costs on screen.

        const wide = "w".repeat(25);
        expect(
          pageOf([], [wide, "a", "b"], { columns: 10, entries: 2 }, status),
        )
          .toEqual({ text: `${wide}\na\n[1 left]`, rest: ["b"] });
      });

      it("fills a page on its own where it is taller than the whole of it", () => {
        const wide = "w".repeat(100);
        const page = pageOf([], [wide, "a"], { rows: 3, columns: 10 }, status);
        expect(page.rest).toEqual(["a"]);
      });
    });

    it("counts an empty line as a row, since the terminal spends one on it", () => {
      // A rendering laid out with blank lines — indented JSON is full of
      // them — would otherwise be measured as costing nothing at all.

      expect(pageOf([], ["", "", ""], { rows: 2, columns: 10 }, status))
        .toEqual({ text: "\n[2 left]", rest: ["", ""] });
    });

    it("counts the status line's own wrapping against the page", () => {
      // The status line is on the screen too. Measured at one row it would
      // let one entry too many through and write five rows into four.

      const page = pageOf([], lines(5), { rows: 4, columns: 20 }, wideStatus);
      expect(page.text.split("\n").slice(0, -1)).toEqual(["1", "2"]);
      expect(page.rest).toEqual(["3", "4", "5"]);
    });

    describe("the header", () => {
      it("is shown before the entries", () => {
        expect(pageOf(["<bound>"], lines(2), { rows: 9, columns: 80 }, status))
          .toEqual({ text: "<bound>\n1\n2", rest: [] });
      });

      it("is shown on a page that had to cut", () => {
        // What a listing's account of itself is for: a reader of a partial
        // listing is the one who most needs to know the rows are not all of
        // them, so it is the one line a page may not drop.

        expect(pageOf(["<bound>"], lines(9), { rows: 4, columns: 80 }, status))
          .toEqual({
            text: "<bound>\n1\n2\n[7 left]",
            rest: lines(9).slice(2),
          });
      });

      it("costs the rows it takes, leaving fewer for the entries", () => {
        const page = pageOf(["h".repeat(25)], lines(9), {
          rows: 5,
          columns: 10,
        }, status);
        expect(page.rest).toEqual(lines(9).slice(1));
      });

      it("is never counted against an entry limit", () => {
        // `ls --limit 1` at a facet that carries a bound prints that bound and
        // one numbered row. Counting the bound among the entries printed the
        // bound and no row at all.

        expect(
          pageOf(["<bound>"], lines(2), { columns: 80, entries: 1 }, status),
        )
          .toEqual({ text: "<bound>\n1\n[1 left]", rest: ["2"] });
      });
    });

    describe("an entry limit", () => {
      it("returns that many entries and holds the rest", () => {
        expect(pageOf([], lines(4), { columns: 80, entries: 2 }, status))
          .toEqual({ text: "1\n2\n[2 left]", rest: ["3", "4"] });
      });

      it("returns everything where it asks for more than there is", () => {
        expect(pageOf([], lines(2), { columns: 80, entries: 9 }, status))
          .toEqual({ text: "1\n2", rest: [] });
      });

      it("overrides the height rather than capping it", () => {
        // A person who asked for four rows on a screen showing two asked for
        // four. The bound a limit builds carries no row count at all, which
        // is what leaves the screen out of it.

        expect(pageOf([], lines(4), { columns: 80, entries: 4 }, status).rest)
          .toEqual([]);
      });
    });

    it("returns the rows a page of a terminal's size holds", () => {
      // The two callers compose `heightFit` with this, and the composition is
      // what a person sees: a listing one row too long for the screen leaves
      // the prompt and the status line on it.

      const page = pageOf([], lines(24), heightFit(24, 80), status);
      expect(page.text.split("\n").length).toBe(23);
      expect(page.rest).toEqual(["23", "24"]);
    });
  });

  describe("wrapped()", () => {
    it("breaks a line at the width, so no piece is more than one row", () => {
      expect(wrapped(["abcdefghij"], 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    it("breaks by the columns a character takes, not by how many there are", () => {
      // Two double-width characters fill a four-column terminal, so the
      // break falls after two rather than after four.
      expect(wrapped(["界界界界"], 4)).toEqual(["界界", "界界"]);
    });

    it("leaves a line that fits whole", () => {
      expect(wrapped(["abc"], 4)).toEqual(["abc"]);
    });

    it("keeps an empty line, which is already one row", () => {
      expect(wrapped(["", "a"], 4)).toEqual(["", "a"]);
    });

    it("takes a character wider than the whole width on its own", () => {
      // There is nowhere narrower to put it, so it goes on a row of its own
      // and overflows by a column rather than being dropped or split.
      expect(wrapped(["界a"], 1)).toEqual(["界", "a"]);
    });
  });

  describe("the assumed screen", () => {
    it("is a height a page fits more than one line into", () => {
      // What the constant is for is that a page bounded by it is still a
      // page: a value below three would leave every rendering writing a line
      // at a time.

      expect(
        pageOf([], lines(100), heightFit(ASSUMED_ROWS, ASSUMED_COLUMNS), status)
          .text.split("\n").length,
      ).toBe(ASSUMED_ROWS - 1);
      expect(ASSUMED_ROWS).toBeGreaterThan(2);
    });

    it("is a width an ordinary line does not wrap at", () => {
      expect(ASSUMED_COLUMNS).toBeGreaterThan(40);
    });
  });
});
